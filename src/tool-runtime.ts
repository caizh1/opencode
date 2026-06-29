import { spawn } from "node:child_process"
import * as nodePath from "node:path"
import * as vscode from "vscode"
import type { AnalysisToolName, AnalysisToolResult, EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import { AuditLog } from "./audit-log"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { DocumentRagContextProvider } from "./document-rag"
import { validateDiagramIr } from "./diagram-ir"
import { parseSupportedDocument } from "./document-parser"
import { generateDrawioDiagram, type DrawioGeneratedDiagram } from "./drawio-diagram-generator"
import { MermaidPngRenderError, renderMermaidToPngRemoteFirst, type MermaidPngRenderDiagnostic } from "./mermaid-png-renderer"
import { normalizeDocumentEditPlan, validateDocumentEditPlan } from "./docAgent/DocumentEditPlan"
import { compareWordDocuments } from "./docAgent/WordDocumentDiff"
import { WordDocumentEditor } from "./docAgent/WordDocumentEditor"
import { auditWordDocumentFields, WordNativeFieldRefresher, WordRefFieldFlattener, WordSeqFieldMaterializer } from "./docAgent/WordDocumentFields"
import { WordDocumentInspector } from "./docAgent/WordDocumentInspector"
import { WordDocumentMerger } from "./docAgent/WordDocumentMerger"
import { renderWordDocument } from "./docAgent/WordRenderQualityGate"
import { WordDocSpecValidator } from "./docAgent/WordDocSpecValidator"
import { auditWordDocumentStyles, WordDocumentStyleNormalizer, type WordRunFormattingKind } from "./docAgent/WordDocumentStyleTools"
import { exportWordTableToCsv, extractXlsxTable } from "./docAgent/WordTableSpreadsheetTools"
import { WordTemplateStyleApplier } from "./docAgent/WordTemplateStyleApplier"
import { createWordDocument } from "./tools/createWordDocumentTool"
import { readDocx } from "./tools/readDocxTool"
import { decidePermission, type PermissionDecision, type ToolRequest } from "./permissions"
import type { ActiveSkillPolicy } from "./skills"
import type { PermissionMode, RemoteSettings, ThreadGoalStatus } from "./types"
import type { GoalToolResponse } from "./goal-runtime"
import type { QualityIssue, WordDocSpec, WordDocumentInspection, WordEditRenderCheckResult } from "./docAgent/types"

export type ToolApprovalRequest = {
  id: string
  sessionID?: string
  mode: PermissionMode
  tool: string
  title: string
  summary: string
  risk: string
  reason: string
  request: ToolRequest
  arguments: Record<string, unknown>
  detail: unknown
}

export type ToolApprovalDecision = {
  approved: boolean
  reason?: string
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>

export type GoalToolHandler = {
  getGoal: (sessionID: string) => Promise<GoalToolResponse>
  createGoal: (sessionID: string, input: { objective: string; tokenBudget?: number }) => Promise<GoalToolResponse>
  updateGoal: (sessionID: string, input: { status: ThreadGoalStatus }) => Promise<GoalToolResponse>
}

export type ToolRuntimeProgressStatus = "running" | "completed" | "warning" | "failed" | "skipped"

export type ToolRuntimeProgressEvent = {
  id?: string
  phase: string
  title: string
  detail?: string
  status?: ToolRuntimeProgressStatus
  tool?: string
  path?: string
  artifactPath?: string
  provider?: string
  fallbackUsed?: boolean
}

export type ToolRuntimeInput = {
  sessionID?: string
  mode: PermissionMode
  name: string
  arguments: Record<string, unknown>
  activeSkills?: ActiveSkillPolicy[]
  signal?: AbortSignal
  approve?: ToolApprovalHandler
  goals?: GoalToolHandler
  progress?: (event: ToolRuntimeProgressEvent) => void
}

export type ToolRuntimeResult = {
  title: string
  output: string
  approved: boolean
  status?: "completed" | "failed" | "blocked" | "approval-required" | "user-input-required"
  error?: string
  requiresApproval?: boolean
  risk?: string
  artifacts?: ToolRuntimeArtifact[]
}

export type ClarificationChoice = {
  id: string
  label: string
  description?: string
}

export type ClarificationQuestion = {
  id: string
  question: string
  choices: ClarificationChoice[]
  allowFreeText?: boolean
}

export type ClarificationRequest = {
  kind: "clarification"
  clarificationId: string
  title: string
  reason: string
  questions: ClarificationQuestion[]
  blocking: boolean
}

export type ToolRuntimeArtifact =
	  | {
	      kind: "drawio"
	      payload: DrawioGeneratedDiagram
	    }
	  | {
	      kind: "mermaid"
	      payload: MermaidDiagramArtifactPayload
	    }
	  | {
	      kind: "word-render"
	      payload: WordRenderArtifactPayload
	    }
  | {
      kind: "skill-script"
      payload: SkillScriptArtifactPayload
    }
  | {
      kind: "clarification"
      payload: ClarificationRequest
    }

export type WordRenderArtifactPayload = {
  kind: "word-render"
  path: string
  absolutePath: string
  renderCheckResult: WordEditRenderCheckResult
  renderArtifactDir?: string
  pdfArtifactPath?: string
  pagePngPaths: string[]
  pageVisualSummaries?: unknown[]
  issues: QualityIssue[]
}

export type MermaidDiagramArtifactPayload = {
  kind: "mermaid"
  title: string
  diagramId: string
  sourceText: string
  mmdPath: string
  absoluteMmdPath: string
  pngPath: string
  absolutePngPath: string
  width: number
  height: number
  renderProvider?: "remote-opencode" | "local-chrome"
  fallbackUsed?: boolean
  remoteFailure?: MermaidPngRenderDiagnostic
  localFailure?: MermaidPngRenderDiagnostic
  warnings: string[]
}

export type SkillScriptArtifactPayload = {
  kind: "skill-script"
  skill: string
  script: string
  manifestVersion?: string
  entrypoint: string
  artifactRoot?: string
  artifacts: SkillScriptRegisteredArtifact[]
  warnings: string[]
}

export type SkillScriptRegisteredArtifact = {
  name?: string
  kind?: string
  contentType?: string
  description?: string
  path: string
  absolutePath: string
  bytes: number
}

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TEXT_SEARCH_FILES = 800
const MAX_TEXT_SEARCH_RESULTS = 80
const MAX_LIST_FILES = 200
const MAX_EVIDENCE_SNIPPET_BYTES = 8 * 1024
const MAX_READ_TEXT_BYTES = 48 * 1024
const MAX_CREATE_FILE_BYTES = 256 * 1024
const MAX_EDIT_FILE_BYTES = 512 * 1024
const MAX_EDIT_TEXT_BYTES = 64 * 1024
const MAX_SKILL_SCRIPT_OUTPUT_BYTES = 64 * 1024
const MAX_SKILL_SCRIPT_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_WORD_DOC_SPEC_STRING_BYTES = 2 * 1024 * 1024
const MAX_WORD_DOC_SPEC_DIAGNOSTIC_BYTES = 900
const DEFAULT_SESSION_ID = "__default__"
const SENSITIVE_CREATE_FILE_NAMES = new Set([".env", ".env.local", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"])

type ToolRuntimeProviders = {
  codeGraph?: Pick<CodeGraphContextProvider, "runAnalysisTool" | "queryEvidence" | "findSymbols" | "status">
  documentRag?: DocumentRagContextProvider
  getSettings?: () => RemoteSettings
}

type Coverage = "complete" | "bounded-complete" | "partial" | "unknown"

type ToolEvidence = {
  refId: string
  path: string
  lines: string
  sourceKind: string
  snippet?: string
}

type ToolNextAction = {
  tool: string
  reason: string
  args: Record<string, string>
}

type ToolPayload = {
  answerSummary: string
  evidence: ToolEvidence[]
  gaps: string[]
  nextActions: ToolNextAction[]
  truncated: boolean
  coverage: Coverage
  data?: unknown
}

type StoredEvidence = {
  refId: string
  path: string
  startLine: number
  endLine: number
  sourceKind: string
  snippet?: string
  sourceTool: string
}

export class ToolRuntime {
  private providers: ToolRuntimeProviders = {}
  private readonly evidenceStores = new Map<string, Map<string, StoredEvidence>>()
  private evidenceCounter = 0

  constructor(
    private readonly audit: AuditLog,
    private readonly output?: vscode.OutputChannel,
  ) {}

  setContextProviders(providers: ToolRuntimeProviders) {
    this.providers = providers
  }

  async execute(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    switch (input.name) {
      case "get_goal":
        return this.getGoalTool(input)
      case "create_goal":
        return this.createGoalTool(input)
      case "update_goal":
        return this.updateGoalTool(input)
      case "chipmate_read":
        return this.readFile(input)
      case "chipmate_read_skill_resource":
        return this.readSkillResource(input)
      case "chipmate_run_skill_script":
        return this.runSkillScript(input)
      case "chipmate_list_files":
        return this.executeReadOnly(input, "List files", () => this.listFiles(input))
      case "chipmate_search_text":
        return this.executeReadOnly(input, "Search text", () => this.searchText(input))
      case "chipmate_search_code":
        return this.executeReadOnly(input, "Search code evidence", () => this.searchCode(input))
      case "chipmate_graph_inspect_symbol":
        return this.executeReadOnly(input, "Inspect code graph symbol", () => this.graphInspectSymbol(input))
      case "chipmate_graph_find_references":
        return this.executeReadOnly(input, "Find code graph references", () => this.graphFindReferences(input))
      case "chipmate_graph_callers":
        return this.executeReadOnly(input, "Find code graph callers", () => this.graphCallers(input))
      case "chipmate_graph_callees":
        return this.executeReadOnly(input, "Find code graph callees", () => this.graphCallees(input))
      case "chipmate_graph_trace_call_chain":
        return this.executeReadOnly(input, "Trace code graph call chain", () => this.graphTraceCallChain(input))
      case "chipmate_graph_analyze_impact":
        return this.executeReadOnly(input, "Analyze code graph impact", () => this.graphAnalyzeImpact(input))
      case "chipmate_graph_map_module":
        return this.executeReadOnly(input, "Map code graph module", () => this.graphMapModule(input))
      case "chipmate_graph_find_state_machines":
        return this.executeReadOnly(input, "Find code graph state machines", () => this.graphFindStateMachines(input))
      case "chipmate_graph_trace_state_path":
        return this.executeReadOnly(input, "Trace code graph state path", () => this.graphTraceStatePath(input))
      case "chipmate_graph_function_cfg":
        return this.executeReadOnly(input, "Build function CFG evidence", () => this.graphFunctionCfg(input))
      case "chipmate_graph_expand_flow_slice":
        return this.executeReadOnly(input, "Expand code flow slice", () => this.graphExpandFlowSlice(input))
      case "chipmate_graph_state_flow_detail":
        return this.executeReadOnly(input, "Expand state flow detail", () => this.graphStateFlowDetail(input))
      case "chipmate_search_documents":
        return this.executeReadOnly(input, "Search Document RAG", () => this.searchDocuments(input))
      case "chipmate_read_evidence":
        return this.executeReadOnly(input, "Read evidence", () => this.readEvidence(input))
      case "read_docx":
        return this.readDocxTool(input)
      case "inspect_word_document":
        return this.inspectWordDocumentTool(input)
      case "apply_word_document_edits":
        return this.applyWordDocumentEditsTool(input)
      case "render_word_document":
        return this.renderWordDocumentTool(input)
      case "compare_word_documents":
        return this.compareWordDocumentsTool(input)
      case "merge_word_documents":
        return this.mergeWordDocumentsTool(input)
      case "extract_xlsx_table":
        return this.extractXlsxTableTool(input)
      case "export_word_table_to_csv":
        return this.exportWordTableToCsvTool(input)
      case "audit_word_document_styles":
        return this.auditWordDocumentStylesTool(input)
      case "normalize_word_document_styles":
        return this.normalizeWordDocumentStylesTool(input)
      case "apply_word_template_styles":
        return this.applyWordTemplateStylesTool(input)
      case "audit_word_document_fields":
        return this.auditWordDocumentFieldsTool(input)
      case "flatten_word_ref_fields":
        return this.flattenWordRefFieldsTool(input)
      case "materialize_word_seq_fields":
        return this.materializeWordSeqFieldsTool(input)
      case "refresh_word_native_fields":
        return this.refreshWordNativeFieldsTool(input)
      case "chipmate_ask_user_clarification":
        return this.askUserClarification(input)
	      case "chipmate_validate_diagram_ir":
	        return this.validateDiagramIrTool(input)
	      case "chipmate_render_mermaid_diagram":
	        return this.renderMermaidDiagramTool(input)
	      case "chipmate_create_drawio_diagram":
	        return this.createDrawioDiagram(input)
      case "create_word_document":
        return this.createWordDocument(input)
      case "chipmate_create_file":
        return this.createFile(input)
      case "chipmate_create_directory":
        return this.createDirectory(input)
      case "chipmate_edit_file":
        return this.editFile(input)
      case "chipmate_write_file":
        return this.writeFile(input)
      case "chipmate_run_command":
        return this.runCommand(input)
      case "chipmate_http_request":
        return this.httpRequest(input)
      default:
        return {
          title: input.name,
          output: `Unknown ChipMate tool: ${input.name}`,
          approved: false,
          status: "blocked",
        }
    }
  }

  toolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "get_goal",
          description: "Use when you need the current persistent goal for this ChipMate session, including status, budgets, token and elapsed-time usage, and remaining token budget. Do not use for ordinary chat memory or task planning when no goal has been requested. Returns a JSON goal snapshot or null.",
          parameters: objectSchema({}, []),
        },
      },
      {
        type: "function",
        function: {
          name: "create_goal",
	          description: "Use when the user or system/developer instructions explicitly ask ChipMate to start a persistent goal; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Do not use this to change the status of an existing unfinished goal. Returns the created active goal and remaining token budget; fails if an unfinished goal exists.",
          parameters: objectSchema({
            objective: { type: "string", description: "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete. It must be non-empty and at most 4000 characters." },
            token_budget: { type: "integer", description: "Optional positive token budget. Omit unless explicitly requested." },
          }, ["objective"]),
        },
      },
      {
        type: "function",
        function: {
          name: "update_goal",
          description: "Use when the existing persistent goal is actually achieved or genuinely blocked; this tool is only for marking that terminal goal outcome. Set status to `complete` only when the objective has actually been achieved and no required work remains. Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change. If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`. Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. Do not use this tool to pause, resume, clear, budget-limit, or usage-limit goals; those status changes are controlled by the user or system. Returns the updated goal and a final budget report when completed.",
          parameters: objectSchema({
            status: {
              type: "string",
              enum: ["complete", "blocked"],
              description: "Required. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
            },
          }, ["status"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_search_text",
          description: "Use when you need exact text, macro, register, error code, or log-message matches in the workspace. Do not use when you need semantic code meaning or a call chain. Returns line-based matches with refId values for follow-up reading.",
          parameters: objectSchema({
            query: { type: "string", description: "Literal text to find; wrap in /.../ only when a regex search is truly needed." },
            path: { type: "string", description: "Optional workspace-relative directory or file scope." },
            filePattern: { type: "string", description: "Optional glob such as *.ts, *.c, or docs/**/*.md." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_search_code",
          description: "Use when the evidence pack is missing related implementation evidence and you only have a natural-language code question. Do not use when you already know an exact symbol; use graph inspect or reference tools instead. Returns grounded code evidence with source labels, gaps, and refId values.",
          parameters: objectSchema({
            query: { type: "string", description: "Natural-language code evidence request." },
            path: { type: "string", description: "Optional workspace-relative file or directory to bias the search." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_inspect_symbol",
          description: "Use when you know a function, macro, type, global, or field name and need its definition or declaration. Do not use for broad module questions. Returns symbol candidates, definition evidence, ambiguity notes, and refId values.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Exact or prefix-like symbol name to inspect." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_find_references",
          description: "Use when you need references to a known function, macro, type, field, or global variable. Do not use when you only need direct callers of a function; use chipmate_graph_callers. Returns reference-like graph/text evidence with refId values.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Symbol name whose references are needed." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_callers",
          description: "Use when you need to know which functions directly call a known function. Do not use for full impact analysis or source-to-target paths. Returns direct caller evidence and callsite refs.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Function name whose direct callers are needed." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_callees",
          description: "Use when you need to know which functions a known function directly calls. Do not use for source-to-target path tracing. Returns direct callee evidence and callsite refs.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Function name whose direct callees are needed." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_trace_call_chain",
          description: "Use when you need to confirm a call path from one known function to another. Do not use for single-point caller/callee questions. Returns bounded graph paths, callsite evidence, coverage, gaps, and refId values.",
          parameters: objectSchema({
            source: { type: "string", description: "Starting function name." },
            target: { type: "string", description: "Target function name." },
          }, ["source", "target"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_analyze_impact",
          description: "Use when you need likely upstream impact from changing a known symbol. Do not use for ordinary code explanation. Returns transitive caller/module evidence, bounded coverage, gaps, and refId values.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Function or symbol whose impact should be analyzed." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_map_module",
          description: "Use when you need a module, directory, or subsystem overview with entry points and core files. Do not use to read a specific code snippet. Returns module summaries, entry points, risks, and evidence refs.",
          parameters: objectSchema({
            query: { type: "string", description: "Module, directory, subsystem, or topic to map." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_find_state_machines",
          description: "Use when the question mentions state, status, phase, mode, transition, guard, or event. Do not use for ordinary function call chains. Returns state machines, transitions, and evidence refs.",
          parameters: objectSchema({
            query: { type: "string", description: "State-machine topic, module, state variable, or symbol." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_trace_state_path",
          description: "Use when you need how one state reaches another state. Do not use before identifying likely state names; call chipmate_graph_find_state_machines first if unsure. Returns bounded state paths, guard/action evidence, coverage, and gaps.",
          parameters: objectSchema({
            query: { type: "string", description: "Optional state-machine topic or module." },
            source: { type: "string", description: "Start state name." },
            target: { type: "string", description: "Target state name." },
          }, ["source", "target"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_function_cfg",
          description: "Use when an evidence-backed code-flow diagram needs function-level branch, call, return, or error-path evidence for a known entry function. Do not use for pure visual style choices or simple non-code diagrams. Returns bounded CFG-oriented evidence refs, coverage, gaps, and follow-up read actions.",
          parameters: objectSchema({
            symbol: { type: "string", description: "Entry function or method name to analyze." },
            path: { type: "string", description: "Optional workspace-relative path to bias evidence retrieval." },
          }, ["symbol"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_expand_flow_slice",
          description: "Use when a detailed code-flow diagram needs entry-to-exit or entry-to-target evidence across functions, branches, states, or error paths. Do not use as the final renderer; validate DiagramIR and call chipmate_create_drawio_diagram after evidence is organized. Returns bounded flow-slice evidence, gaps, and next actions.",
          parameters: objectSchema({
            entry: { type: "string", description: "Entry symbol, handler, command, API, or module flow start." },
            target: { type: "string", description: "Optional target/end symbol, state, file, or behavior." },
            scope: { type: "string", description: "Optional module, directory, subsystem, or document scope." },
          }, ["entry"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_graph_state_flow_detail",
          description: "Use when a diagram must show detailed state-machine branches, guards, actions, or state-to-state paths. Do not use for ordinary architecture diagrams without state behavior. Returns state-machine transition evidence, path coverage, gaps, and follow-up read actions.",
          parameters: objectSchema({
            query: { type: "string", description: "State-machine topic, module, state variable, or subsystem." },
            source: { type: "string", description: "Optional start state for path tracing." },
            target: { type: "string", description: "Optional target state for path tracing." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_search_documents",
          description: "Use when the evidence pack lacks Word, Excel, or PDF document evidence. Do not use for code symbols or call chains. Returns Document RAG evidence, lexical candidates, gaps, and refId values for follow-up reading.",
          parameters: objectSchema({
            query: { type: "string", description: "Natural-language document question or exact document phrase." },
            path: { type: "string", description: "Optional workspace-relative document file or directory scope." },
          }, ["query"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_read_evidence",
          description: "Use when you need to expand a refId returned by another ChipMate search or graph tool. Do not use for a user-provided path; use chipmate_read instead. Returns the stored evidence snippet and available surrounding context.",
          parameters: objectSchema({
            refId: { type: "string", description: "Evidence refId returned earlier in this chat turn or session." },
          }, ["refId"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_read",
          description: "Use when the user gave a specific workspace file path to read. Do not use for searching, graph traversal, or evidence refIds. Returns UTF-8 text or supported Office/PDF document text.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to read." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_read_skill_resource",
          description: "Use when an active ChipMate skill lists a references/, assets/, scripts/, or tasks/ resource that you need to read. Do not use for ordinary workspace files, and do not execute scripts. Returns bounded UTF-8 resource text from the active skill directory.",
          parameters: objectSchema({
            skill: { type: "string", description: "Active skill name or id." },
            path: { type: "string", description: "Skill-root relative resource path, such as references/guide.md." },
          }, ["skill", "path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_run_skill_script",
          description: "Use when an active ChipMate skill explicitly allows a bundled helper script and its scripts/manifest.json marks that helper as directly executable. Do not use for ordinary shell commands, non-active skills, scripts missing from the manifest, or documents helpers mapped to native tools/backlog items. Returns bounded stdout/stderr, exit status, manifest execution metadata, and audit details.",
          parameters: objectSchema({
            skill: { type: "string", description: "Active skill name or id." },
            script: { type: "string", description: "Manifest helper name, codexScript name, or scripts/ entrypoint to run." },
            arguments: { type: "object", description: "Optional JSON object passed to the helper script on stdin.", additionalProperties: true },
            timeoutMs: { type: "number", description: "Optional execution timeout in milliseconds. Capped by the manifest and the tool safety limit." },
          }, ["skill", "script"]),
        },
      },
      {
        type: "function",
        function: {
          name: "read_docx",
          description: "Use when a local DOCX file must be read as semantic document structure. Do not use for PDF, legacy DOC, web pages, or style/template inheritance. Returns headings, paragraphs, lists, tables, heading paths, source locations, and bounded previews.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to a .docx file." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "inspect_word_document",
          description: "Use when controlled Word edits require inspecting a local .docx before planning changes. Do not use for non-DOCX files, freeform rewriting, or edits that already have verified locators. Returns paragraph/table/comment/content-control/watermark/note/image/caption/section/field/style locators and bounded document previews; comment inspection includes commentsExtended/commentsIds thread metadata when present, and image inspection includes inline/floating placement, embedded/external/missing relationship mode, media path/content type/existence, and replaceSupported/replaceUnsupportedReason. Later apply_word_document_edits must use these exact locators; do not invent blockId/tableIndex/sourceLocation values.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to the target .docx file." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "apply_word_document_edits",
          description: "Use when inspect_word_document has already returned locators and a validated DocumentEditPlan is ready. Do not use without verified locators, for unsupported edit operations, or to overwrite the source document. Returns a new .docx artifact path, edit summary, structural checks, and render-quality status. Supports insertSection with ordered blocks for paragraphs, rich paragraphs, true Word lists, PNG figures with captions/bookmarks, fixed-layout tables including merged cells, callouts, code blocks, REF/PAGEREF cross-reference fields or {{ref:bookmark|text}}/{{pageref:bookmark|page}} authoring markers, and true footnote/endnote note runs; replaceParagraph, replaceParagraphWithRichParagraph, replaceText, replaceParagraphWithTrackedChange, replaceParagraphWithRichTrackedChange, replaceTextWithTrackedChange, updateHeadingLevel, updateTable, updateTableWithTrackedChange, replaceTable, updateTableHeaderRows, updateList, updateSectionPageSetup, updateImageAltText, replaceImage, updateCaptionText, updateHyperlinkText, updateHyperlinkTarget, updateNoteText, paragraph addComment, multi-paragraph updateCommentText, setCommentResolved, fillContentControl, addTextWatermark across existing header parts, removeWatermark by inspected document/header/footer VML locator with part audit detail, removeAllComments, acceptAllTrackedChanges, rejectAllTrackedChanges, scrubDocumentMetadata, redactText, and patchOoxmlPart. setCommentResolved updates legacy comments.xml state and existing commentsExtended.xml state; removeAllComments strips comments/commentsExtended/commentsIds package parts, relationships, and content types. Use replaceImage only for inspected images whose replaceSupported is true; external linked images, missing relationships, unresolved media targets, and non-PNG media must be reported rather than forced through replaceImage. redactText supports exact items plus bounded email/phone/custom patterns, optional comment redaction, and package-level match-count audit details without exposing sensitive values. patchOoxmlPart is a last-resort controlled OOXML repair path: use only with documentEnd locator, safe XML package parts, exact oldText/anchor/closeTag preconditions, and when no native operation covers the requested repair.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative source .docx file that was inspected." },
            plan: { type: "object", description: "DocumentEditPlan using only locators returned by inspect_word_document.", additionalProperties: true },
          }, ["path", "plan"]),
        },
      },
      {
        type: "function",
        function: {
          name: "render_word_document",
          description: "Use when the user asks to render, visually inspect, QA, preview, export page PNGs, or check pagination/layout of a local .docx file. The tool does not modify the source document, but it writes PDF and page PNG artifacts under .chipmate/docs/rendered when the configured remote Word render server is available. It does not fall back to local LibreOffice, Poppler, or PDF.js; if the remote server is unconfigured or unavailable, page-level visual QA is skipped and reported as a warning. Do not use for non-DOCX files, semantic document reading, text diffing, or editing. Returns pageCount, pagePngPaths, pdfArtifactPath, pageVisualSummaries, render warnings, renderer metadata, and a structured word-render artifact for chat preview.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to the .docx file to render." },
            artifactNameBase: { type: "string", description: "Optional stable short name for the render evidence bundle." },
            timeoutMs: { type: "number", description: "Optional render timeout in milliseconds. Defaults to 60000 and is capped for safety." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "compare_word_documents",
          description: "Use when the user asks to compare, diff, review changes between, or verify visual/text differences for two local .docx files. The model chooses the two files and interprets the result; the tool extracts document text, renders both DOCX files to page PNGs when possible, computes per-page pixel diff PNGs for changed rendered pages, and writes a .chipmate/docs/diff evidence bundle. Do not use for non-DOCX files, as a generic reader, or to infer business meaning from pixels. Returns text diff status, changed page numbers, render status, changedRatio, visual severity, changed bounding boxes, 3x3 changed-region summaries, reflow/noise risk flags, and evidence artifact paths.",
          parameters: objectSchema({
            beforePath: { type: "string", description: "Absolute or workspace-relative path to the baseline/before .docx file." },
            afterPath: { type: "string", description: "Absolute or workspace-relative path to the revised/after .docx file." },
            artifactNameBase: { type: "string", description: "Optional stable short name for the diff evidence bundle." },
            pixelThreshold: { type: "number", description: "Optional 0-255 per-channel pixel threshold for visual diff. Defaults to 12; increase to ignore antialias/render noise, decrease for stricter pixel checks." },
          }, ["beforePath", "afterPath"]),
        },
      },
      {
        type: "function",
        function: {
          name: "merge_word_documents",
          description: "Use when the user asks to append or merge the body content of one local .docx into another local .docx while preserving base document package structure. The model chooses base and append order; the tool splices Word body OOXML, keeps the base section settings, refuses append drawings/images by default, writes a new .docx, and runs structural/render checks. When allowDrawings is true, local image relationships and word/media parts from the append body are merged deterministically; hyperlink relationships are remapped, style/numbering conflicts are reported with a base-wins strategy, and unsupported embedded object relationships fail closed. Do not use for non-DOCX files, template inheritance, or object-heavy merges unless allowDrawings is explicitly justified. Returns the merged .docx path, appended body child count, merged image count, mergeAudit, warnings, structural checks, and render-quality status.",
          parameters: objectSchema({
            basePath: { type: "string", description: "Absolute or workspace-relative path to the base .docx whose package, styles, relationships, headers, footers, and final section settings are kept." },
            appendPath: { type: "string", description: "Absolute or workspace-relative path to the .docx whose body content should be appended." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the merged DOCX artifact under .chipmate/docs." },
            allowDrawings: { type: "boolean", description: "Optional override. Defaults to false; set true for append documents with local PNG/JPEG/etc. figures after warning that unsupported embedded objects are still out of scope. Local image media and relationships are merged." },
          }, ["basePath", "appendPath"]),
        },
      },
      {
        type: "function",
        function: {
          name: "extract_xlsx_table",
          description: "Use when the user wants to bring a simple local .xlsx/.xlsm worksheet range into a Word document as a real fixed-layout TableSpec. The model chooses the sheet/range and then passes the returned TableSpec into create_word_document or apply_word_document_edits replaceTable/insertSection. Do not use for non-workbook files, formula recalculation, spreadsheet styling migration, merged-cell migration, or writing a DOCX directly. Returns headers, rows, width ratios, source range, and warnings for truncated ranges or formulas without cached results.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to a local .xlsx or .xlsm workbook." },
            sheetName: { type: "string", description: "Optional worksheet name. If omitted, sheetIndex is used." },
            sheetIndex: { type: "number", description: "Optional 1-based worksheet index. Defaults to 1." },
            range: { type: "string", description: "Optional A1 range such as A1:D20. Defaults to the non-empty worksheet bounds." },
            hasHeaderRow: { type: "boolean", description: "Whether the first selected row contains headers. Defaults to true. If false, headers are generated as Column A, Column B, etc." },
            maxRows: { type: "number", description: "Optional maximum selected row count. Defaults to 200 and is capped for model safety." },
            maxColumns: { type: "number", description: "Optional maximum selected column count. Defaults to 24 and is capped for model safety." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "export_word_table_to_csv",
          description: "Use when the user asks to export a table from an inspected local .docx to CSV. Prefer tableIndex from inspect_word_document. Do not use for non-DOCX files, prose extraction, style preservation, formula preservation, or merged-cell semantic preservation, and do not guess the table from prose when multiple tables exist. Returns the CSV artifact path, row/column counts, preview rows, and warnings.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to the source .docx file." },
            tableIndex: { type: "number", description: "1-based Word table index from inspect_word_document. Defaults to 1 for single-table documents." },
            locator: { type: "object", description: "Optional inspect_word_document table locator; tableIndex is read from this when tableIndex is omitted.", additionalProperties: true },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the CSV artifact under .chipmate/docs/tables." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "audit_word_document_styles",
          description: "Use when the user asks why a local .docx looks inconsistent, asks to inspect formatting/style drift, or before normalizing styles. The tool reports direct run formatting, direct paragraph spacing/indent overrides, font usage, and heading-like paragraphs that are not real Heading styles. Do not use for non-DOCX files or to mutate a document. Returns a style lint report with counts, examples, font summary, and notes.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to the .docx file to audit." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "normalize_word_document_styles",
          description: "Use when the user explicitly asks to make a local .docx formatting consistent, remove direct formatting drift, or apply style-driven cleanup. The model chooses whether paragraph-format cleanup, intentional emphasis preservation, or heading spacing enforcement is appropriate; the tool writes a new .docx, clears run-level direct formatting by default, can preserve selected run formatting kinds such as bold/italic/color, optionally clears paragraph spacing/indent overrides, optionally enforces heading spacing, and runs structural/render checks. Do not use for non-DOCX files, template import, or when the user wants exact original styling preserved. Returns the normalized .docx path, before/after style reports, change counts, preserved-format counts, warnings, structural checks, and render-quality status.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative source .docx file." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the normalized DOCX artifact under .chipmate/docs." },
            clearParagraphFormatting: { type: "boolean", description: "Also clear paragraph-level direct spacing/indent overrides. Defaults to false because this can change layout." },
            preserveRunFormatting: { type: "array", items: { type: "string", enum: ["font", "bold", "italic", "underline", "color", "size"] }, description: "Optional allowlist for intentional run-level emphasis to keep while clearing other direct formatting. Use when the user asks to preserve manual emphasis, highlighted terms, or brand colors. Examples: ['bold','italic'] preserves emphasis while clearing direct font/color/size drift; ['color'] preserves direct text colors while clearing font/size/bold/italic drift." },
            enforceHeadingSpacing: { type: "boolean", description: "Set simple heading space-after on Heading styles after cleanup. Defaults to false." },
            headingSpaceAfterTwips: { type: "number", description: "Optional heading space-after value in twips when enforceHeadingSpacing is true. Defaults to 120 twips (6pt)." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "apply_word_template_styles",
          description: "Use when the user asks to apply a Word template, DOTX, template DOCX, or style pack to an existing local .docx while preserving the target document body. The model chooses the target and template and warns that pagination may change; the tool copies template styles/theme/fontTable/numbering parts, or selectively imports style ids when styleAllowlist is provided, writes a new .docx, and runs structural/render checks. It reports templateAudit for style/numbering conflicts and template relationship/media handling; referenced local image media from copied style parts is copied, while unsupported referenced relationships fail closed. Do not use for non-DOCX targets, content merges, arbitrary OOXML edits, or when the user wants to preserve exact original styling. Returns the styled .docx path, copied/skipped template parts, templateAudit, warnings, structural checks, and render-quality status.",
          parameters: objectSchema({
            targetPath: { type: "string", description: "Absolute or workspace-relative path to the target .docx whose content/body should be preserved." },
            templatePath: { type: "string", description: "Absolute or workspace-relative path to a .dotx or .docx template/style pack." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the styled DOCX artifact under .chipmate/docs." },
            styleAllowlist: { type: "array", items: { type: "string" }, description: "Optional style id allowlist. When provided, only these template style ids and their basedOn/next/link dependencies are imported into target styles.xml; theme/fontTable/numbering still follow the template." },
          }, ["targetPath", "templatePath"]),
        },
      },
      {
        type: "function",
        function: {
          name: "audit_word_document_fields",
          description: "Use when the user asks why Word fields, page numbers, TOC, captions, or cross-references look stale or before rendering field-heavy .docx documents. The tool scans document/header/footer/note parts for Word field instructions such as TOC, PAGE, NUMPAGES, SEQ, REF, and PAGEREF. Do not use for non-DOCX files or document mutation. For TOC/PAGE/NUMPAGES refresh, follow with refresh_word_native_fields when needed. Returns field type counts, examples, per-part field inventory, stale-field hints, and field workflow notes.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to the .docx file to audit for Word fields." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "flatten_word_ref_fields",
          description: "Use when deterministic headless rendering needs REF/PAGEREF cross-reference fields replaced by their currently cached visible text in a new .docx copy. The tool preserves the source file, flattens only complex REF/PAGEREF fields with cached display text, and runs structural/render checks. Do not use for PAGE, NUMPAGES, SEQ, TOC refresh, semantic cross-reference updates, non-DOCX files, or when the user expects fields to remain live. Returns the flattened .docx path, before/after field reports, touched parts, warnings, structural checks, and render-quality status.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative source .docx file." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the flattened DOCX artifact under .chipmate/docs." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "materialize_word_seq_fields",
          description: "Use when deterministic headless rendering needs live Word SEQ caption/table/figure fields to have recalculated cached visible numbers in a new .docx copy. The tool preserves the source file and the live SEQ fields, updates only complex SEQ fields with cached display text, and runs structural/render checks. Do not use for TOC, PAGE, NUMPAGES, REF, PAGEREF refresh, semantic caption rewrites, non-DOCX files, or when Word-native layout field updates are required. Returns the materialized .docx path, before/after field reports, touched parts, warnings, structural checks, and render-quality status.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative source .docx file." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the SEQ-materialized DOCX artifact under .chipmate/docs." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "refresh_word_native_fields",
          description: "Use when a local DOCX needs Word-native TOC, PAGE, or NUMPAGES fields refreshed and render-verified. The tool preserves live fields, enables updateFields, uses local LibreOffice/soffice to save a refreshed DOCX copy, and renders PDF/page PNG evidence. Do not use for non-DOCX files, REF/PAGEREF flattening, SEQ numbering, semantic TOC rewriting, or when local LibreOffice is unavailable. Returns the refreshed .docx path, before/prepared/after field reports, refreshed field types, warnings, and render-quality status.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative source .docx file." },
            outputFilenameBase: { type: "string", description: "Optional safe filename base for the refreshed DOCX artifact under .chipmate/docs." },
            timeoutMs: { type: "number", description: "Optional LibreOffice refresh/render timeout in milliseconds. Defaults to 90000 and is capped for safety." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_ask_user_clarification",
          description: "Use when the current user request is blocked by missing goal, scope, format, or diagram detail and a bounded user choice is necessary before continuing the same turn. Do not use when the user already clearly specified draw.io/Mermaid, the target, or a safe default can be inferred. Returns a pending structured clarification request that the host resolves with user answers as this tool call's result.",
          parameters: objectSchema({
            reason: { type: "string", description: "Short reason why the answer is needed before continuing." },
            questions: {
              type: "array",
              description: "One to three concise questions. Each question may include up to five choices.",
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", description: "Stable short id such as diagram_type or scope." },
                  question: { type: "string", description: "User-facing question." },
                  choices: {
                    type: "array",
                    maxItems: 5,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        id: { type: "string", description: "Stable choice id." },
                        label: { type: "string", description: "Short button label." },
                        description: { type: "string", description: "Optional one-sentence explanation." },
                      },
                      required: ["label"],
                    },
                  },
                  allowFreeText: { type: "boolean", description: "Whether the user may type a free-form answer for this question." },
                },
                required: ["question"],
              },
            },
            choices: {
              type: "array",
              description: "Optional shorthand choices for a single implicit question when questions is omitted.",
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
            allowFreeText: { type: "boolean", description: "Optional shorthand free-text flag for a single implicit question." },
            blocking: { type: "boolean", description: "Whether the turn should wait for the user's answer. Defaults to true." },
          }, ["reason"]),
        },
      },
	      {
	        type: "function",
	        function: {
	          name: "chipmate_validate_diagram_ir",
          description: "Use when evidence, skill instructions, or user requirements have been organized into DiagramIR and you need coverage/gap/style-hint validation before rendering. Do not use as a renderer, file writer, XML passthrough, or evidence extractor. Returns normalized DiagramIR, draw.io-ready spec, coverageReport, visualProfileSuggestion, warnings, gaps, and next evidence suggestions.",
          parameters: objectSchema({
            diagramIr: { type: "object", description: "DiagramIR v1 with title, diagramType, composition, nodes, edges, regions, containers, lanes, buses, ports, arrays, evidenceRefs, layoutHints, styleHints, semanticHints, sourceArtifacts, referenceDiagrams, and optional visualPlan. The model/skill chooses diagramType and all semantic presentation decisions from user intent and evidence. For complex diagrams, provide visualPlan.mainBackbone and visualPlan.edgePresentation so the renderer knows which edges are line, rail, or legend; the renderer will not infer the main path, exception path, or business meaning from labels/function names/domain words. In dense engineering diagrams, keep the mainBackbone and only a small number of essential cross-module edges visible; use legend for low-priority, repetitive, evidence-only, explanatory, retry, cleanup, telemetry, or secondary exception details. Treat regions/containers/lanes/groups as ownership/background areas, not execution steps. Use composition.mode=single by default; only use multi when the user or active skill explicitly asks for or allows multiple diagrams.", additionalProperties: true },
          }, ["diagramIr"]),
	        },
	      },
	      {
	        type: "function",
	        function: {
	          name: "chipmate_render_mermaid_diagram",
	          description: "Use when a Mermaid diagram source must become local artifacts or a PNG figure for a Word document. Do not use for draw.io/diagrams.net XML or before the model/active skill has authored valid Mermaid source. The tool uses the configured remote render server first when available, then local Chrome/Edge fallback; Word figures must use the returned PNG artifact, never raw Mermaid source. Returns .mmd and .png artifact paths, PNG dimensions, render provider/fallback diagnostics, a FigureSpec-compatible image path for create_word_document/apply_word_document_edits, and a Mermaid chat preview artifact.",
	          parameters: objectSchema({
	            source: { type: "string", description: "Complete Mermaid source, such as flowchart TD, sequenceDiagram, or stateDiagram-v2." },
	            title: { type: "string", description: "Short human-readable diagram title." },
	            diagramId: { type: "string", description: "Optional stable diagram id for chat preview and artifact naming." },
	            artifactNameBase: { type: "string", description: "Optional safe filename base for .chipmate/docs/diagrams artifacts." },
	          }, ["source", "title"]),
	        },
	      },
	      {
	        type: "function",
	        function: {
	          name: "chipmate_create_drawio_diagram",
          description: "Use when a validated DiagramIR or a simple structured draw.io spec is ready for final Design Compiler + ELKJS layout and draw.io rendering in chat. Do not use to extract code evidence, write files, call remote draw.io services, embed external images/fonts/URLs, bypass the Design Compiler/ELK layout, or hand-author arbitrary XML. Returns deterministic draw.io mxGraphModel XML, a diagramId, normalized spec, visualPlan metadata, coverage metadata, layoutEngine='elk', and bounded warnings for the chat renderer.",
          parameters: objectSchema({
            title: { type: "string", description: "Short diagram title used for the chat diagram block and export filename." },
            diagramType: { type: "string", description: "User-visible diagram family. Use business-flow for business/process perspective, code-flow for entry/function/branch/return execution paths, state-machine for pure state transitions, architecture for module boundaries, soc-block for chip/module/bus/port diagrams, plus flowchart/swimlane/sequence/freeform when appropriate. Code evidence alone does not require code-flow." },
            composition: { type: "object", description: "Optional DiagramIR composition decision. Defaults to {mode:'single'}; set mode:'multi' only when the model/skill has explicitly decided the user asked for or allowed multiple diagrams.", additionalProperties: true },
            visualPlan: { type: "object", description: "Optional model/skill-authored visual plan. Use layoutProfile, mainBackbone.nodes/edges, edgePresentation edge-id map with mode line/rail/legend and optional rail side, plus legend items. This is the semantic presentation contract; renderer validates references and executes it without guessing business meaning. For dense engineering diagrams, use rail sparingly for must-see non-main paths; move repetitive, evidence-only, cleanup, telemetry, retry, and secondary exception details into legend items so the PNG remains line-clear.", additionalProperties: true },
            diagramIr: { type: "object", description: "Optional DiagramIR v1. Use this for evidence-backed or skill-orchestrated diagrams. The model/skill should include visualPlan for complex diagrams: layoutProfile, mainBackbone, edgePresentation, and legend. edgePresentation decides line/rail/legend explicitly; the renderer only executes that plan and does not infer semantic roles from labels, function names, state names, or domain words. Keep the mainBackbone and a small number of essential cross-module edges visible; put low-priority/repetitive/evidence-only details in legend when they would clutter the graph. Containers/regions/lanes/groups are ownership areas; assign owned nodes with parent/container/lane/region/group. In embedded FSM business/code flows they render as weak background bands by default; set containerMode='strong' only for true compound structural nesting, and mark intentional empty regions allowEmpty/placeholder.", additionalProperties: true },
            ir: { type: "object", description: "Alias for diagramIr.", additionalProperties: true },
            nodes: { type: "array", description: "Core nodes. Each item may include id, label/text, shape/type, parent/group/container/lane/layer, visualRole such as module/phase/state/action/decision/event/evidence-note, importance, textParts, geometry, style, and drawioStyle. Use parent/container/lane/region/group to declare ownership; embedded FSM flows render that ownership as weak background bands unless the container is explicitly strong.", items: { type: "object", additionalProperties: true } },
            edges: { type: "array", description: "Core edges. Each item may include id, label/text, source/from, target/to, edgeKind, pathRole, labelPriority, parent/layer, points, style, and drawioStyle. For complex diagrams, also provide visualPlan.edgePresentation to decide whether each important edge is drawn as a line, rail, or legend item.", items: { type: "object", additionalProperties: true } },
            groups: { type: "array", description: "Optional grouping boxes with id, label/title, parent, geometry, style, and drawioStyle.", items: { type: "object", additionalProperties: true } },
            containers: { type: "array", description: "Optional architecture/container boxes with id, label/title, parent, geometry, style, drawioStyle, optional containerMode/layoutMode, and optional allowEmpty/placeholder. Containers are ownership/background areas, not flow steps. In embedded-FSM business/code flows, assigned containers render as weak background bands by default; architecture/soc-block and explicit containerMode='strong' use compound containers. Empty embedded-FSM containers are not rendered unless connected or explicitly allowed.", items: { type: "object", additionalProperties: true } },
            regions: { type: "array", description: "Optional DiagramIR region boxes for SoC/architecture diagrams.", items: { type: "object", additionalProperties: true } },
            swimlanes: { type: "array", description: "Optional swimlanes with id, label/title, parent, geometry, style, and drawioStyle.", items: { type: "object", additionalProperties: true } },
            buses: { type: "array", description: "Optional DiagramIR bus edges for SoC/architecture diagrams.", items: { type: "object", additionalProperties: true } },
            ports: { type: "array", description: "Optional DiagramIR port nodes for SoC/architecture diagrams.", items: { type: "object", additionalProperties: true } },
            arrays: { type: "array", description: "Optional DiagramIR repeated module arrays with rows, columns, itemLabel, cellWidth, and cellHeight.", items: { type: "object", additionalProperties: true } },
            sequence: { type: "object", description: "Optional sequence diagram data with participants and messages arrays. Messages use from/to or source/target.", additionalProperties: true },
            layout: { description: "Layout strategy: layered, flow, grid, swimlane, architecture, soc-block, sequence, or freeform. May also be an object with kind/type.", anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
            theme: { description: "Theme name such as default, light, dark, or colorful, or a future theme object.", anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
            style: { description: "Optional safe global draw.io style string or object applied to generated cells.", anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
          }, ["title"]),
        },
      },
      {
        type: "function",
        function: {
          name: "create_word_document",
          description: "Use when a complete generic WordDocSpec is ready and a .docx document should be generated. Do not use as a generic file writer, for non-docx output, or before the model/active documents skill has chosen content structure, design preset, heading ladder, section form factors, list/table/figure intent, link/reference/note intent, navigation/TOC intent, and form/protection intent. Supports fixed-layout Word tables including real merged cells via TableSpec colSpan/rowSpan, rich paragraph REF/PAGEREF cross-reference fields, {{ref:bookmark|text}}/{{pageref:bookmark|page}} authoring markers, Word-native field TOC intent, and PAGE/NUMPAGES footer fields for field-toc documents. Returns the generated .docx path, design preset, source count, structural/a11y warnings, and render-quality status.",
          parameters: objectSchema({
            filename: { type: "string", description: "Suggested output filename; it will be sanitized and written under .chipmate/docs." },
            spec: { type: "object", description: "Generic WordDocSpec. Minimum required shape: metadata.title, metadata.documentType, metadata.language, metadata.generatedAt, sources: [], and sections: [{ id, level, title, paragraphs/bullets/lists/tables/figures/etc. }]. Optional fields include layout preset/page/navigation/form-factor guidance, references, figures, structured lists, tables, and rule cards." },
          }, ["spec"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_create_file",
          description: "Use when the user explicitly asks you to create a new local workspace text/code file from scratch. Do not use to edit, overwrite, delete, rename, patch, or append to existing files, and do not use outside the current workspace. Returns the created workspace path and byte count or a blocked/failed reason.",
          parameters: objectSchema({
            path: { type: "string", description: "Workspace-relative path for a new file that must not already exist." },
            content: { type: "string", description: "Complete UTF-8 text content for the new file." },
            reason: { type: "string", description: "Optional short user-facing reason for creating this file." },
          }, ["path", "content"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_create_directory",
          description: "Use when the user explicitly asks you to create a new local workspace folder, especially before creating multiple new files inside it. Do not use to edit, overwrite, delete, rename, move, or create outside the current workspace. Returns the created workspace folder path or a blocked/failed reason.",
          parameters: objectSchema({
            path: { type: "string", description: "Workspace-relative path for a new directory that must not already exist; a trailing slash is allowed." },
            reason: { type: "string", description: "Optional short user-facing reason for creating this folder." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_edit_file",
          description: "Use when the user explicitly asks you to modify an existing local workspace text/code file by exact string replacement. Do not use to create, overwrite, delete, rename, move, patch fuzzily, edit binary files, or edit outside the current workspace. Returns the edited workspace path, exact replacement count, byte counts, and a blocked/failed reason when the oldString is missing or ambiguous.",
          parameters: objectSchema({
            path: { type: "string", description: "Workspace-relative path for an existing text/code file." },
            oldString: { type: "string", description: "Exact existing text to replace; must be non-empty and match file content exactly." },
            newString: { type: "string", description: "Replacement text, which must differ from oldString." },
            replaceAll: { type: "boolean", description: "Replace all exact occurrences of oldString. Defaults to false; when false, oldString must match exactly once." },
            reason: { type: "string", description: "Optional short user-facing reason for editing this file." },
          }, ["path", "oldString", "newString"]),
        },
      },
    ]
  }

  private async getGoalTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const goals = requireGoalTools(input)
    if (!goals.ok) return goals.result
    try {
      const response = await goals.handler.getGoal(requireGoalSessionID(input))
      return completedJson("Get goal", response)
    } catch (error) {
      return failed("Get goal", `Failed to get goal: ${formatErrorMessage(error)}`, formatErrorMessage(error))
    }
  }

  private async createGoalTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const goals = requireGoalTools(input)
    if (!goals.ok) return goals.result
    try {
      const objective = stringArg(input.arguments.objective).trim()
      const tokenBudget = optionalPositiveInteger(input.arguments.token_budget ?? input.arguments.tokenBudget)
      const response = await goals.handler.createGoal(requireGoalSessionID(input), { objective, tokenBudget })
      return completedJson("Create goal", response)
    } catch (error) {
      return failed("Create goal", `Failed to create goal: ${formatErrorMessage(error)}`, formatErrorMessage(error))
    }
  }

  private async updateGoalTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const goals = requireGoalTools(input)
    if (!goals.ok) return goals.result
    try {
      const status = stringArg(input.arguments.status) as ThreadGoalStatus
      const response = await goals.handler.updateGoal(requireGoalSessionID(input), { status })
      return completedJson("Update goal", response)
    } catch (error) {
      return failed("Update goal", `Failed to update goal: ${formatErrorMessage(error)}`, formatErrorMessage(error))
    }
  }

  private async executeReadOnly(input: ToolRuntimeInput, title: string, run: () => Promise<ToolPayload>): Promise<ToolRuntimeResult> {
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title,
      summary: toolSummary(input.name, input.arguments),
      target: workspaceRoot(),
    }
    const decision = await this.resolvePermission(input, request, { tool: input.name, arguments: input.arguments })
    if (!decision.approved) return blocked(title, decision)
    try {
      input.signal?.throwIfAborted()
      const payload = await run()
      return {
        title,
        output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(title, `Tool failed: ${input.name}: ${message}`, message, decision.risk)
    }
  }

  private async listFiles(input: ToolRuntimeInput): Promise<ToolPayload> {
    const path = stringArg(input.arguments.path) || "."
    const recursive = booleanArg(input.arguments.recursive)
    const target = resolveWorkspacePath(path)
    const rows = await listWorkspaceFiles({ root: target, recursive, maxFiles: MAX_LIST_FILES + 1 })
    const truncated = rows.length > MAX_LIST_FILES
    return {
      answerSummary: `Listed ${Math.min(rows.length, MAX_LIST_FILES)} workspace item(s) under ${workspaceRelativePath(target) || "."}.`,
      evidence: [],
      gaps: truncated ? [`File listing was truncated at ${MAX_LIST_FILES} item(s); list a narrower subdirectory.`] : [],
      nextActions: rows.length ? [{ tool: "chipmate_read", reason: "Read a specific file from the listing if needed.", args: { path: rows[0]?.path ?? path } }] : [],
      truncated,
      coverage: truncated ? "partial" : "bounded-complete",
      data: rows.slice(0, MAX_LIST_FILES),
    }
  }

  private async searchText(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    const path = stringArg(input.arguments.path) || "."
    const filePattern = stringArg(input.arguments.filePattern)
    const matcher = textMatcher(query)
    const root = resolveWorkspacePath(path)
    const files = await listWorkspaceFiles({ root, recursive: true, maxFiles: MAX_TEXT_SEARCH_FILES + 1 })
    const matches: EvidenceRef[] = []
    for (const file of files) {
      if (file.kind !== "file") continue
      if (filePattern && !matchesGlob(file.path, filePattern)) continue
      if (matches.length >= MAX_TEXT_SEARCH_RESULTS) break
      const text = await readTextFileIfSmall(resolveWorkspacePath(file.path), MAX_OUTPUT_BYTES).catch(() => "")
      if (!text) continue
      const lines = text.replace(/\r\n/g, "\n").split("\n")
      for (let index = 0; index < lines.length && matches.length < MAX_TEXT_SEARCH_RESULTS; index += 1) {
        if (!matcher(lines[index] ?? "")) continue
        const startLine = index + 1
        const endLine = Math.min(lines.length, startLine + 1)
        const snippet = lines.slice(startLine - 1, endLine).join("\n")
        matches.push(evidenceRef(file.path, startLine, endLine, snippet, "text-search"))
      }
    }
    const evidence = this.registerEvidence(input.sessionID, input.name, matches, "text-search")
    const truncated = files.length > MAX_TEXT_SEARCH_FILES || matches.length >= MAX_TEXT_SEARCH_RESULTS
    return {
      answerSummary: matches.length ? `Found ${matches.length} text match(es) for ${query}.` : `No text matches found for ${query}.`,
      evidence,
      gaps: matches.length ? [] : ["No exact text match was found in the searched workspace scope."],
      nextActions: evidence.slice(0, 3).map((item) => ({ tool: "chipmate_read_evidence", reason: "Read surrounding text for this match.", args: { refId: item.refId } })),
      truncated,
      coverage: truncated ? "partial" : "bounded-complete",
    }
  }

  private async searchCode(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    const path = stringArg(input.arguments.path)
    const codeGraph = this.providers.codeGraph
    if (!codeGraph) return unavailablePayload("Local code graph is not available for chipmate_search_code.")
    const settings = this.providers.getSettings?.()
    const result = await codeGraph.queryEvidence(query, {
      relatedPaths: path ? [path] : undefined,
      maxEvidenceItems: settings?.analysis.maxEvidenceItems,
      maxEvidenceBytes: settings?.analysis.maxEvidenceBytes,
      retrievalMode: isCodeRagReady(codeGraph) ? "hybrid" : "graph-only",
      latencyBudgetMs: isCodeRagReady(codeGraph) ? 2000 : undefined,
    })
    return this.payloadFromQueryEvidence(input, result, {
      emptySummary: `No local code evidence matched ${query}.`,
      summary: result?.suggestedAnswer || `Retrieved code evidence for ${query}.`,
      coverage: result?.evidencePack.truncated ? "partial" : "bounded-complete",
      nextTool: "chipmate_read_evidence",
    })
  }

  private async graphInspectSymbol(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    const codeGraph = this.providers.codeGraph
    if (!codeGraph) return unavailablePayload("Local code graph is not available for chipmate_graph_inspect_symbol.")
    const candidates = await codeGraph.findSymbols({ query: symbol, limit: 12 })
    const result = await codeGraph.runAnalysisTool({ tool: "getSymbol", args: { name: symbol } })
    const payload = this.payloadFromAnalysisTool(input, result, {
      summary: candidates.length ? `Found ${candidates.length} symbol candidate(s) for ${symbol}.` : `No symbol candidate found for ${symbol}.`,
      coverage: candidates.length > 1 ? "partial" : result.truncated ? "partial" : "bounded-complete",
    })
    payload.data = { candidates, result: result.data }
    if (candidates.length > 1) payload.gaps.push(`Symbol ${symbol} is ambiguous; inspect the path that matches the question before answering.`)
    return payload
  }

  private async graphFindReferences(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    return this.analysisToolPayload(input, "search", { query: symbol }, {
      summary: `Retrieved reference-like graph and text evidence for ${symbol}.`,
      coverage: "bounded-complete",
      gap: "Reference search is bounded by the local code graph and text postings; unresolved macro/function-pointer uses may be missing.",
    })
  }

  private async graphCallers(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    return this.analysisToolPayload(input, "getCallers", { symbol }, {
      summary: `Retrieved direct callers for ${symbol}.`,
      coverage: "bounded-complete",
    })
  }

  private async graphCallees(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    return this.analysisToolPayload(input, "getCallees", { symbol }, {
      summary: `Retrieved direct callees for ${symbol}.`,
      coverage: "bounded-complete",
    })
  }

  private async graphTraceCallChain(input: ToolRuntimeInput): Promise<ToolPayload> {
    const source = requiredString(input.arguments, "source")
    const target = requiredString(input.arguments, "target")
    const payload = await this.analysisToolPayload(input, "getCallChain", { symbol: source, target }, {
      summary: `Traced bounded call-chain evidence from ${source} to ${target}.`,
      coverage: "bounded-complete",
      gap: "Call-chain coverage is bounded by the local code graph depth/fanout and may miss indirect function-pointer, callback-table, generated, or conditional-compile edges.",
    })
    payload.data = callChainView(source, target, payload.data)
    if (payload.evidence.length === 0) {
      payload.coverage = "unknown"
      payload.gaps.push(`No call path from ${source} to ${target} was found in the bounded local code graph.`)
    }
    return payload
  }

  private async graphAnalyzeImpact(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    return this.analysisToolPayload(input, "search", { query: `impact ${symbol}` }, {
      summary: `Retrieved bounded impact evidence for ${symbol}.`,
      coverage: "bounded-complete",
      gap: "Impact analysis is bounded by indexed callers and may miss dynamic dispatch, function pointers, generated code, or unindexed files.",
    })
  }

  private async graphMapModule(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    return this.analysisToolPayload(input, "getModuleMap", { query }, {
      summary: `Retrieved module map evidence for ${query}.`,
      coverage: "bounded-complete",
    })
  }

  private async graphFindStateMachines(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    return this.analysisToolPayload(input, "getStateMachines", { query }, {
      summary: `Retrieved state-machine evidence for ${query}.`,
      coverage: "bounded-complete",
    })
  }

  private async graphTraceStatePath(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = stringArg(input.arguments.query)
    const source = requiredString(input.arguments, "source")
    const target = requiredString(input.arguments, "target")
    const payload = await this.analysisToolPayload(input, "getStatePath", { query, source, target }, {
      summary: `Traced bounded state path from ${source} to ${target}.`,
      coverage: "bounded-complete",
      gap: "State path coverage is bounded by extracted state-machine evidence and may miss implicit transitions or low-confidence candidates.",
    })
    if (payload.evidence.length === 0) {
      payload.coverage = "unknown"
      payload.gaps.push(`No state path from ${source} to ${target} was found in extracted state-machine evidence.`)
    }
    return payload
  }

  private async graphFunctionCfg(input: ToolRuntimeInput): Promise<ToolPayload> {
    const symbol = requiredString(input.arguments, "symbol")
    const payload = await this.analysisToolPayload(input, "getFunctionCfg", { symbol }, {
      summary: `Retrieved bounded function-CFG structure for ${symbol}.`,
      coverage: "partial",
    })
    payload.gaps.push("Function CFG is reconstructed from indexed snippets and call summaries; inspect refs and expand flow slices for callbacks, dynamic dispatch, generated code, and macro-expanded branches.")
    return payload
  }

  private async graphExpandFlowSlice(input: ToolRuntimeInput): Promise<ToolPayload> {
    const entry = requiredString(input.arguments, "entry")
    const target = stringArg(input.arguments.target)
    const scope = stringArg(input.arguments.scope)
    const payload = await this.searchCode({
      ...input,
      arguments: {
        query: `entry to exit detailed flow slice from ${entry}${target ? ` to ${target}` : ""}${scope ? ` in ${scope}` : ""} branches state changes error paths cross function calls`,
        path: scope,
      },
    })
    payload.answerSummary = `Retrieved bounded flow-slice evidence from ${entry}${target ? ` to ${target}` : ""}.`
    payload.coverage = payload.truncated ? "partial" : "partial"
    payload.gaps.push("Flow-slice evidence may be incomplete for dynamic dispatch, callbacks, generated code, function pointers, or unindexed files; continue with callers/callees/state tools when gaps remain.")
    payload.data = {
      mode: "bounded-flow-slice-evidence",
      entry,
      target,
      scope,
      result: payload.data,
    }
    return payload
  }

  private async graphStateFlowDetail(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    const source = stringArg(input.arguments.source)
    const target = stringArg(input.arguments.target)
    if (source && target) {
      const payload = await this.graphTraceStatePath({ ...input, arguments: { query, source, target } })
      payload.answerSummary = `Retrieved detailed state-flow path evidence for ${query}: ${source} -> ${target}.`
      return payload
    }
    const payload = await this.graphFindStateMachines({ ...input, arguments: { query } })
    payload.answerSummary = `Retrieved detailed state-machine evidence for ${query}.`
    payload.gaps.push("For a complete state-flow diagram, call chipmate_graph_trace_state_path or chipmate_graph_state_flow_detail with source and target states for critical paths.")
    return payload
  }

  private async searchDocuments(input: ToolRuntimeInput): Promise<ToolPayload> {
    const query = requiredString(input.arguments, "query")
    const path = stringArg(input.arguments.path)
    const settings = this.providers.getSettings?.()
    const documentRag = this.providers.documentRag
    const evidenceRefs: EvidenceRef[] = []
    const gaps: string[] = []
    let ragResult: Awaited<ReturnType<DocumentRagContextProvider["query"]>> | undefined
    if (documentRag && settings?.documentRag.enabled) {
      ragResult = await documentRag.query(path ? `${query}\npath: ${path}` : query, {
        topK: settings.documentRag.queryTopK,
        maxEvidenceBytes: settings.documentRag.maxEvidenceBytes,
        latencyBudgetMs: 1000,
      })
      evidenceRefs.push(...documentEvidenceFromText(ragResult?.text ?? ""))
    } else {
      gaps.push("Document RAG is not available or disabled.")
    }
    const lexicalRefs = await this.documentLexicalEvidence(query, path)
    evidenceRefs.push(...lexicalRefs)
    const evidence = this.registerEvidence(input.sessionID, input.name, dedupeEvidenceRefs(evidenceRefs), "document-rag")
    return {
      answerSummary: evidence.length ? `Retrieved ${evidence.length} document evidence item(s) for ${query}.` : `No document evidence found for ${query}.`,
      evidence,
      gaps: evidence.length ? gaps : [...gaps, "No matching Document RAG or lexical document evidence was found."],
      nextActions: evidence.slice(0, 3).map((item) => ({ tool: "chipmate_read_evidence", reason: "Read more of this document evidence.", args: { refId: item.refId } })),
      truncated: Boolean(ragResult?.text.includes("omitted") || lexicalRefs.length >= MAX_TEXT_SEARCH_RESULTS),
      coverage: evidence.length ? "partial" : "unknown",
      data: {
        ragHits: ragResult?.hits ?? [],
        elapsedMs: ragResult?.elapsedMs,
        lexicalCandidates: lexicalRefs.length,
      },
    }
  }

  private async readEvidence(input: ToolRuntimeInput): Promise<ToolPayload> {
    const refId = requiredString(input.arguments, "refId")
    const evidence = this.evidenceStore(input.sessionID).get(refId)
    if (!evidence) {
      return {
        answerSummary: `Evidence refId ${refId} was not found in this chat session.`,
        evidence: [],
        gaps: ["Evidence refIds are session-scoped and may expire after the search result that created them."],
        nextActions: [],
        truncated: false,
        coverage: "unknown",
      }
    }
    const expanded = evidence.path
      ? await readWorkspaceFileSlice({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        maxBytes: MAX_OUTPUT_BYTES,
      }).catch(() => "")
      : ""
    const snippet = expanded || evidence.snippet || ""
    const ref = evidenceRef(evidence.path, evidence.startLine, evidence.endLine, snippet, evidence.sourceKind)
    const outputEvidence = this.registerEvidence(input.sessionID, input.name, [ref], evidence.sourceKind)
    return {
      answerSummary: `Read evidence ${refId} from ${evidence.path}:${evidence.startLine}-${evidence.endLine}.`,
      evidence: outputEvidence,
      gaps: snippet ? [] : ["The stored evidence did not include readable text and the source slice could not be loaded."],
      nextActions: [],
      truncated: Buffer.byteLength(snippet, "utf8") > MAX_OUTPUT_BYTES,
      coverage: snippet ? "complete" : "unknown",
      data: {
        sourceRefId: refId,
        sourceTool: evidence.sourceTool,
      },
    }
  }

  private async readFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Read file",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Read file", decision)
    let text: string
    let document: Awaited<ReturnType<typeof parseSupportedDocument>> | undefined
    try {
      input.signal?.throwIfAborted()
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      document = await parseSupportedDocument({ path: target, bytes, maxBytes: MAX_OUTPUT_BYTES })
      text = document?.text ?? new TextDecoder().decode(bytes)
    } catch (error) {
      if (input.signal?.aborted) throw error
      if (isFileNotFoundError(error)) {
        const output = `File not found: ${target}`
        return failed(`Read file: ${target}`, output, output, decision.risk)
      }
      const message = formatErrorMessage(error)
      return failed(`Read file: ${target}`, `Read file failed: ${target}\n${message}`, message, decision.risk)
    }
    const path = workspaceRelativePath(target)
    const lineCount = Math.max(1, text.replace(/\r\n/g, "\n").split("\n").length)
    const outputText = truncateBytes(text, MAX_READ_TEXT_BYTES)
    const sourceKind = document ? `document:${document.kind}` : "file"
    const evidence = this.registerEvidence(input.sessionID, input.name, [evidenceRef(path, 1, lineCount, outputText, sourceKind)], sourceKind)
    const payload: ToolPayload = {
      answerSummary: `Read ${path} (${lineCount} line${lineCount === 1 ? "" : "s"}).`,
      evidence,
      gaps: document?.truncated ? ["The parsed document text was truncated by the document parser byte budget."] : [],
      nextActions: [],
      truncated: document?.truncated || Buffer.byteLength(text, "utf8") > MAX_READ_TEXT_BYTES,
      coverage: document?.truncated ? "partial" : "complete",
      data: {
        path,
        bytes: Buffer.byteLength(text, "utf8"),
        text: outputText,
      },
    }
    return {
      title: `Read file: ${target}`,
      output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
      approved: true,
      status: "completed",
      risk: decision.risk,
    }
  }

  private async readSkillResource(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const skillName = requiredString(input.arguments, "skill")
    const resourcePath = normalizeSkillResourcePath(requiredString(input.arguments, "path"))
    const skill = (input.activeSkills ?? []).find((candidate) =>
      candidate.id === skillName || candidate.name === skillName || candidate.name.toLowerCase() === skillName.toLowerCase()
    )
    if (!skill) {
      return failed("Read skill resource", `Skill resource read blocked: active skill not found for ${skillName}`, `Active skill not found: ${skillName}`)
    }
    if (!isAllowedSkillResourcePath(resourcePath)) {
      return failed("Read skill resource", `Skill resource read blocked: unsupported resource path ${resourcePath}`, `Unsupported skill resource path: ${resourcePath}`)
    }
    const target = nodePath.join(skill.skillRoot, ...resourcePath.split("/"))
    if (!isSubpath(skill.skillRoot, target)) {
      return failed("Read skill resource", `Skill resource read blocked: path escapes skill root ${resourcePath}`, `Skill resource path escapes root: ${resourcePath}`)
    }
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Read skill resource",
      summary: `${skill.name}:${resourcePath}`,
      target,
    }
    const decision = await this.resolvePermission(input, request, {
      skillResourcePath: resourcePath,
      path: target,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Read skill resource", decision)
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const text = new TextDecoder().decode(bytes)
      const outputText = truncateBytes(text, MAX_READ_TEXT_BYTES)
      const payload: ToolPayload = {
        answerSummary: `Read skill resource ${skill.name}:${resourcePath}.`,
        evidence: [{
          refId: `${skill.name}:${resourcePath}`,
          path: `${skill.name}/${resourcePath}`,
          lines: "1-1",
          sourceKind: "skill-resource",
          snippet: outputText,
        }],
        gaps: [],
        nextActions: [],
        truncated: Buffer.byteLength(text, "utf8") > MAX_READ_TEXT_BYTES,
        coverage: "complete",
        data: {
          skill: skill.name,
          path: resourcePath,
          bytes: Buffer.byteLength(text, "utf8"),
          text: outputText,
        },
      }
      return {
        title: `Read skill resource: ${skill.name}:${resourcePath}`,
        output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = isFileNotFoundError(error) ? `Skill resource not found: ${resourcePath}` : formatErrorMessage(error)
      return failed("Read skill resource", `Read skill resource failed: ${message}`, message, decision.risk)
    }
  }

  private async runSkillScript(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const skillName = requiredString(input.arguments, "skill")
    const scriptName = requiredString(input.arguments, "script")
    const args = jsonObjectArg(input.arguments.arguments)
    const skill = (input.activeSkills ?? []).find((candidate) =>
      candidate.id === skillName || candidate.name === skillName || candidate.name.toLowerCase() === skillName.toLowerCase()
    )
    if (!skill) {
      return failed("Run skill script", `Skill script execution blocked: active skill not found for ${skillName}`, `Active skill not found: ${skillName}`)
    }
    if (!skill.allowedTools.includes("chipmate_run_skill_script")) {
      return failed("Run skill script", `Skill script execution blocked: active skill ${skill.name} does not allow chipmate_run_skill_script.`, `Skill does not allow chipmate_run_skill_script`)
    }
    let manifest: SkillScriptManifest
    try {
      manifest = await readSkillScriptManifest(skill.skillRoot)
    } catch (error) {
      return failed("Run skill script", `Skill script execution blocked: ${formatErrorMessage(error)}`, formatErrorMessage(error))
    }
    const helper = findManifestHelper(manifest, scriptName)
    if (!helper) {
      return failed("Run skill script", `Skill script execution blocked: helper not found in manifest: ${scriptName}`, `Skill script not found in manifest: ${scriptName}`)
    }
    const execution = helper.execution
    if (!execution?.entrypoint || !execution.runtime) {
      return failed("Run skill script", `Skill script execution blocked: helper ${scriptName} has no executable entrypoint.`, `Skill script helper is not executable: ${scriptName}`)
    }
    const helperDirectExecution = helper.directExecution === true || execution.directExecution === true
    if (manifest.executionPolicy?.directExecution !== true && !helperDirectExecution) {
      return failed("Run skill script", `Skill script execution blocked: ${skill.name}:${scriptName} is not opted in for direct execution.`, "Skill script directExecution is not true")
    }
    if (helper.status && !["executable", "native-script"].includes(helper.status)) {
      return failed("Run skill script", `Skill script execution blocked: helper ${scriptName} status is ${helper.status}, not executable.`, `Skill script helper status is not executable: ${helper.status}`)
    }
    const entrypoint = normalizeSkillResourcePath(execution.entrypoint)
    if (!entrypoint.startsWith("scripts/") || !isAllowedSkillResourcePath(entrypoint)) {
      return failed("Run skill script", `Skill script execution blocked: unsupported entrypoint ${execution.entrypoint}`, `Unsupported skill script entrypoint: ${execution.entrypoint}`)
    }
    const scriptPath = nodePath.join(skill.skillRoot, ...entrypoint.split("/"))
    if (!isSubpath(nodePath.join(skill.skillRoot, "scripts"), scriptPath)) {
      return failed("Run skill script", `Skill script execution blocked: entrypoint escapes scripts directory ${entrypoint}`, `Skill script entrypoint escapes scripts directory: ${entrypoint}`)
    }
    const runtime = execution.runtime
    const command = skillScriptCommand(runtime)
    if (!command) {
      return failed("Run skill script", `Skill script execution blocked: unsupported runtime ${runtime}`, `Unsupported skill script runtime: ${runtime}`)
    }
    if (!skillScriptEntrypointMatchesRuntime(entrypoint, runtime)) {
      return failed("Run skill script", `Skill script execution blocked: entrypoint extension does not match runtime ${runtime}.`, `Skill script entrypoint extension does not match runtime ${runtime}`)
    }
    const networkPolicy = execution.networkPolicy ?? manifest.executionPolicy?.networkPolicy ?? "none"
    if (!isOfflineSkillScriptNetworkPolicy(networkPolicy)) {
      return failed("Run skill script", `Skill script execution blocked: unsupported networkPolicy ${networkPolicy}.`, `Skill script networkPolicy must be none/offline/disabled`)
    }
    const inputValidation = validateSkillScriptInput(args, {
      schema: execution.inputSchema,
      allowedExtensions: execution.allowedExtensions,
      skillRoot: skill.skillRoot,
    })
    if (inputValidation.errors.length > 0) {
      return failed("Run skill script", `Skill script execution blocked: ${inputValidation.errors.join("; ")}`, inputValidation.errors.join("; "))
    }
    const stdin = JSON.stringify(args)
    if (Buffer.byteLength(stdin, "utf8") > 16 * 1024) {
      return failed("Run skill script", "Skill script execution blocked: arguments exceed 16KB JSON safety limit.", "Skill script arguments exceed safety limit")
    }
    const timeoutMs = boundedSkillScriptTimeout(numberFromArg(input.arguments.timeoutMs), execution.timeoutMs)
    const maxOutputBytes = boundedSkillScriptOutputBytes(execution.maxOutputBytes)
    const outputArtifacts = execution.outputArtifacts ?? []
    const artifactRoot = outputArtifacts.length ? await prepareSkillScriptArtifactRoot(skill.name, scriptName) : undefined
    const request: ToolRequest = {
      id: randomId(),
      kind: "command",
      title: "Run skill script",
      summary: `${skill.name}:${scriptName}`,
      command: `${command.display} ${entrypoint}`,
      cwd: skill.skillRoot,
    }
    const decision = await this.resolvePermission(input, request, skillAuditDetail(input, {
      skillScript: scriptName,
      entrypoint,
      runtime,
      timeoutMs,
      maxOutputBytes,
      argumentKeys: Object.keys(args).sort(),
      directExecutionScope: helperDirectExecution ? "helper" : "manifest",
      networkPolicy,
      outputArtifactCount: outputArtifacts.length,
      tool: input.name,
    }))
    if (!decision.approved) return blocked("Run skill script", decision)
    try {
      const run = await runProcess({
        command: command.command,
        args: [...command.args, scriptPath],
        cwd: skill.skillRoot,
        stdin,
        timeoutMs,
        maxOutputBytes,
        env: skillScriptExecutionEnv({
          skillRoot: skill.skillRoot,
          artifactRoot,
          networkPolicy,
        }),
        signal: input.signal,
      })
      const collectedArtifacts = await collectSkillScriptArtifacts(outputArtifacts, artifactRoot)
      const evidence = this.registerEvidence(input.sessionID, input.name, collectedArtifacts.evidenceRefs, "skill-script-artifact")
      const warnings = [...inputValidation.warnings, ...collectedArtifacts.warnings]
      const requiredArtifactGaps = collectedArtifacts.missingRequired.map((artifact) => `Required script artifact was not produced: ${artifact}`)
      const ok = run.exitCode === 0 && requiredArtifactGaps.length === 0
      const artifactItems = JSON.parse(JSON.stringify(collectedArtifacts.artifacts.map((scriptArtifact) => ({
        name: scriptArtifact.name ?? "",
        kind: scriptArtifact.kind ?? "",
        contentType: scriptArtifact.contentType ?? "",
        description: scriptArtifact.description ?? "",
        path: scriptArtifact.path,
        absolutePath: scriptArtifact.absolutePath,
        bytes: Number(scriptArtifact.bytes) || 0,
      })))) as SkillScriptRegisteredArtifact[]
      const payloadArtifactItems = artifactItems.map((artifact) => ({
        name: artifact.name,
        kind: artifact.kind,
        contentType: artifact.contentType,
        path: artifact.path,
        bytes: artifact.bytes,
      }))
      const payload: ToolPayload = {
        answerSummary: run.exitCode === 0
          ? `Ran skill script ${skill.name}:${scriptName}.`
          : `Skill script ${skill.name}:${scriptName} exited with code ${run.exitCode}.`,
        evidence,
        gaps: [
          ...(run.exitCode === 0 ? [] : [`Script exited with code ${run.exitCode}.`]),
          ...requiredArtifactGaps,
        ],
        nextActions: [],
        truncated: run.truncated,
        coverage: ok ? "complete" : "partial",
        data: {
          skill: skill.name,
          script: scriptName,
          manifestVersion: manifest.version,
          manifestSchemaVersion: manifest.schemaVersion,
          entrypoint,
          runtime,
          networkPolicy,
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
          timedOut: run.timedOut,
          artifacts: payloadArtifactItems,
          warnings,
        },
      }
      const output = truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES)
      const artifactPayload: SkillScriptArtifactPayload = {
        kind: "skill-script",
        skill: skill.name,
        script: scriptName,
        manifestVersion: manifest.version,
        entrypoint,
        artifactRoot: artifactRoot ? workspaceRelativePath(artifactRoot) : undefined,
        artifacts: [],
        warnings,
      }
      return {
        title: `Run skill script: ${skill.name}:${scriptName}`,
        output,
        approved: true,
        status: ok ? "completed" : "failed",
        error: ok ? undefined : `Skill script failed or did not produce required artifacts.`,
        risk: decision.risk,
        artifacts: collectedArtifacts.artifacts.length ? [{ kind: "skill-script", payload: artifactPayload }] : undefined,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Run skill script: ${skill.name}:${scriptName}`, `Run skill script failed: ${message}`, message, decision.risk)
    }
  }

  private async readDocxTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Read DOCX",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Read DOCX", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Read DOCX", `read_docx only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await readDocx({
        path: workspaceRelativePath(target),
        bytes,
      })
      return {
        title: `Read DOCX: ${target}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Read DOCX ${result.metadata.path}: ${result.blocks.length} semantic block(s).`,
          evidence: [],
          gaps: result.metadata.readWarnings,
          nextActions: [],
          truncated: result.metadata.truncated,
          coverage: result.metadata.truncated ? "partial" : "complete",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Read DOCX: ${target}`, `Read DOCX failed: ${target}\n${message}`, message, decision.risk)
    }
  }

  private async inspectWordDocumentTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Inspect Word document",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Inspect Word document", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Inspect Word document", `inspect_word_document only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await new WordDocumentInspector().inspect({
        path: workspaceRelativePath(target),
        bytes,
      })
      const bounded = boundedWordDocumentInspection(result)
      return {
        title: `Inspected Word document: ${target}`,
        output: JSON.stringify({
          answerSummary: `Inspected ${result.metadata.path}: ${result.summary.paragraphCount} paragraph(s), ${result.summary.tableCount} table(s), ${result.summary.contentControlCount} content control(s), ${result.summary.watermarkCount} watermark(s), ${result.summary.noteCount} note(s), ${result.summary.imageCount} image(s), ${result.summary.captionCount} caption(s), ${result.summary.sectionCount} section(s), ${result.summary.fieldCount} field(s), ${result.summary.styleCount} style(s), ${result.summary.hyperlinkCount} hyperlink(s). Use returned locators exactly in apply_word_document_edits.`,
          evidence: [],
          gaps: [...result.warnings, ...bounded.truncatedCollections.map((item) => `inspect_word_document ${item.name} truncated from ${item.total} to ${item.included} item(s); use a narrower document or targeted follow-up if more locators are needed.`)],
          nextActions: [{ tool: "apply_word_document_edits", reason: "Apply a validated DocumentEditPlan using exact locators.", args: { path: workspaceRelativePath(target) } }],
          truncated: bounded.truncatedCollections.length > 0,
          coverage: "complete",
          data: bounded,
        }, null, 2),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Inspect Word document: ${target}`, `Inspect Word document failed: ${target}\n${message}`, message, decision.risk)
    }
  }

  private async applyWordDocumentEditsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Apply Word document edits",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Apply Word document edits", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Apply Word document edits", `apply_word_document_edits only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const sourcePath = workspaceRelativePath(target)
      const inspection = await new WordDocumentInspector().inspect({ path: sourcePath, bytes })
      const plan = normalizeDocumentEditPlan(input.arguments.plan as never, sourcePath)
      const validation = validateDocumentEditPlan(plan, inspection)
      if (!validation.ok || !validation.plan) {
        return failed("Apply Word document edits", `DocumentEditPlan validation failed: ${validation.errors.join("; ")}`, validation.errors.join("; "), decision.risk)
      }
      const result = await new WordDocumentEditor().apply({
        sourcePath,
        bytes,
        inspection,
        plan: validation.plan,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Applied Word edits: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created edited Word document: ${result.path}`,
          evidence: [],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: "complete",
          data: {
            path: result.path,
            absolutePath: result.absolutePath,
            appliedOperations: result.appliedOperations,
            structureCheckResult: result.structureCheckResult,
            renderCheckResult: result.renderCheckResult,
            repairAttempted: result.repairAttempted,
            warnings: result.warnings,
          },
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Apply Word document edits: ${target}`, `Apply Word document edits failed: ${target}\n${message}`, message, decision.risk)
    }
  }

  private async renderWordDocumentTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const artifactNameBase = stringArg(input.arguments.artifactNameBase) || nodePath.basename(target, ".docx")
    const requestedTimeoutMs = numberFromArg(input.arguments.timeoutMs)
    const timeoutMs = Math.min(180_000, Math.max(5_000, requestedTimeoutMs ?? 60_000))
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Render Word document",
      summary: `${target} -> .chipmate/docs/rendered`,
      target: resolveWorkspacePath(".chipmate/docs/rendered"),
    }
    const decision = await this.resolvePermission(input, request, {
      path: target,
      artifactRoot: request.target,
      timeoutMs,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Render Word document", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Render Word document", `render_word_document only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      input.progress?.({
        id: "word-render",
        phase: "word-render",
        title: "页面级视觉 QA",
        detail: `${workspaceRelativePath(target)} -> .chipmate/docs/rendered`,
        status: "running",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await renderWordDocument({
        docxPath: target,
        bytes,
        timeoutMs,
        workspaceRoot: workspaceRoot(),
        artifactNameBase,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      const issueMessages = wordRenderIssueMessages(result.issues)
      const payload = wordRenderArtifactPayload({
        path: workspaceRelativePath(target),
        absolutePath: target,
        renderCheckResult: result,
      })
      const renderSkipped = result.visualQaStatus === "skipped" || !result.attempted
      input.progress?.({
        id: "word-render",
        phase: "word-render",
        title: "页面级视觉 QA",
        detail: renderSkipped
          ? `已跳过：${wordRenderSkipReasonLabel(result.skipReason)}`
          : `已生成 ${result.pagePngPaths?.length ?? 0} 张页面 PNG`,
        status: renderSkipped ? "skipped" : "completed",
        tool: input.name,
        path: workspaceRelativePath(target),
        artifactPath: result.pdfArtifactPath || result.pagePngPaths?.[0],
        provider: result.renderProvider,
      })
      return {
        title: renderSkipped ? `Word render QA skipped: ${workspaceRelativePath(target)}` : `Rendered Word document: ${workspaceRelativePath(target)}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: !renderSkipped
            ? `Rendered Word document: ${workspaceRelativePath(target)}; pages: ${result.pageCount ?? 0}; PNG artifacts: ${result.pagePngPaths?.length ?? 0}; PDF: ${result.pdfArtifactPath || "unavailable"}.`
            : `Page-level visual QA skipped because remote render server was ${wordRenderSkipReasonLabel(result.skipReason)}; Word document remains available at ${workspaceRelativePath(target)}; no page PNG artifacts were produced.`,
          evidence: [
            ...(result.pdfArtifactPath ? [{ path: result.pdfArtifactPath, kind: "word-render-pdf" }] : []),
            ...(result.pagePngPaths ?? []).map((path, index) => ({ path, kind: "word-render-page-png", page: index + 1 })),
          ],
          gaps: issueMessages,
          nextActions: renderSkipped ? [] : issueMessages.length ? [{ tool: "inspect_word_document", reason: "Inspect structure before planning layout or content fixes.", args: { path: workspaceRelativePath(target) } }] : [],
          truncated: false,
          coverage: !renderSkipped && (result.pagePngPaths?.length ?? 0) > 0 ? "complete" : "partial",
          data: {
            path: workspaceRelativePath(target),
            absolutePath: target,
            renderCheckResult: result,
          },
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
        artifacts: [{ kind: "word-render", payload }],
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      input.progress?.({
        id: "word-render",
        phase: "word-render",
        title: "页面级视觉 QA",
        detail: message,
        status: "failed",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      return failed(`Render Word document: ${target}`, `Render Word document failed: ${message}`, message, decision.risk)
    }
  }

  private async compareWordDocumentsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const beforeTarget = resolveWorkspacePath(stringArg(input.arguments.beforePath))
    const afterTarget = resolveWorkspacePath(stringArg(input.arguments.afterPath))
    const artifactNameBase = stringArg(input.arguments.artifactNameBase)
    const pixelThreshold = typeof input.arguments.pixelThreshold === "number" ? input.arguments.pixelThreshold : undefined
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Compare Word documents",
      summary: `${beforeTarget} ↔ ${afterTarget}`,
      target: resolveWorkspacePath(".chipmate/docs/diff"),
    }
    const decision = await this.resolvePermission(input, request, {
      beforePath: beforeTarget,
      afterPath: afterTarget,
      artifactRoot: request.target,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Compare Word documents", decision)
    try {
      if (!beforeTarget.toLowerCase().endsWith(".docx")) {
        return failed("Compare Word documents", `compare_word_documents only supports .docx files: ${beforeTarget}`, `Unsupported file extension: ${beforeTarget}`, decision.risk)
      }
      if (!afterTarget.toLowerCase().endsWith(".docx")) {
        return failed("Compare Word documents", `compare_word_documents only supports .docx files: ${afterTarget}`, `Unsupported file extension: ${afterTarget}`, decision.risk)
      }
      const beforeBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(beforeTarget))
      const afterBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(afterTarget))
      const result = await compareWordDocuments({
        before: { path: workspaceRelativePath(beforeTarget), bytes: beforeBytes },
        after: { path: workspaceRelativePath(afterTarget), bytes: afterBytes },
        workspaceRoot: workspaceRoot(),
        artifactNameBase: artifactNameBase || undefined,
        pixelThreshold,
        timeoutMs: 60_000,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      const warningMessages = result.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message)
      return {
        title: `Compared Word documents: ${workspaceRelativePath(beforeTarget)} ↔ ${workspaceRelativePath(afterTarget)}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: result.changedPages.length > 0 || result.textChanged
            ? `Compared Word documents. Text changed: ${result.textChanged}; changed rendered pages: ${result.changedPages.map((page) => page.page).join(", ") || "none"}; pixel diff complete: ${result.pixelDiffComplete}.`
            : "Compared Word documents. No text changes or rendered page byte changes were detected.",
          evidence: [
            ...(result.textDiffPath ? [{ path: result.textDiffPath, kind: "text-diff" }] : []),
            ...result.changedPages.flatMap((page) => [
              ...(page.beforePngPath ? [{ path: page.beforePngPath, kind: "before-page-png", page: page.page }] : []),
              ...(page.afterPngPath ? [{ path: page.afterPngPath, kind: "after-page-png", page: page.page }] : []),
              ...(page.diffPngPath ? [{ path: page.diffPngPath, kind: "pixel-diff-png", page: page.page, changedRatio: page.changedRatio }] : []),
            ]),
          ],
          gaps: warningMessages,
          nextActions: [],
          truncated: false,
          coverage: result.visualDiffComplete ? "complete" : "partial",
          data: {
            ok: result.ok,
            textChanged: result.textChanged,
            textDiffPath: result.textDiffPath,
            textDiffPreview: result.textDiff.slice(0, 12_000),
            visualDiffComplete: result.visualDiffComplete,
            pixelDiffComplete: result.pixelDiffComplete,
            pageCountBefore: result.pageCountBefore,
            pageCountAfter: result.pageCountAfter,
            changedPages: result.changedPages,
            diffArtifactDir: result.diffArtifactDir,
            beforeRender: summarizeRenderCheck(result.beforeRender),
            afterRender: summarizeRenderCheck(result.afterRender),
            issues: result.issues,
          },
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Compare Word documents: ${beforeTarget} ↔ ${afterTarget}`, `Compare Word documents failed: ${message}`, message, decision.risk)
    }
  }

  private async mergeWordDocumentsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const baseTarget = resolveWorkspacePath(stringArg(input.arguments.basePath))
    const appendTarget = resolveWorkspacePath(stringArg(input.arguments.appendPath))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const allowDrawings = input.arguments.allowDrawings === true
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Merge Word documents",
      summary: `${baseTarget} + ${appendTarget}`,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      basePath: baseTarget,
      appendPath: appendTarget,
      outputRoot: request.target,
      allowDrawings,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Merge Word documents", decision)
    try {
      if (!baseTarget.toLowerCase().endsWith(".docx")) {
        return failed("Merge Word documents", `merge_word_documents only supports .docx files: ${baseTarget}`, `Unsupported file extension: ${baseTarget}`, decision.risk)
      }
      if (!appendTarget.toLowerCase().endsWith(".docx")) {
        return failed("Merge Word documents", `merge_word_documents only supports .docx files: ${appendTarget}`, `Unsupported file extension: ${appendTarget}`, decision.risk)
      }
      const baseBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(baseTarget))
      const appendBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(appendTarget))
      const result = await new WordDocumentMerger(workspaceRoot()).merge({
        base: { path: workspaceRelativePath(baseTarget), bytes: baseBytes },
        append: { path: workspaceRelativePath(appendTarget), bytes: appendBytes },
        outputFilenameBase: outputFilenameBase || undefined,
        allowDrawings,
        workspaceRoot: workspaceRoot(),
        timeoutMs: 60_000,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Merged Word documents: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Merged Word documents into ${result.path}; appended ${result.bodyChildrenAppended} body child element(s).`,
          evidence: [{ path: result.path, kind: "merged-docx" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: result.renderCheckResult.attempted ? "complete" : "partial",
          data: {
            path: result.path,
            absolutePath: result.absolutePath,
            bodyChildrenAppended: result.bodyChildrenAppended,
            drawingsAllowed: result.drawingsAllowed,
            mergedImageCount: result.mergedImageCount,
            mergeAudit: result.mergeAudit,
            structureCheckResult: result.structureCheckResult,
            renderCheckResult: result.renderCheckResult,
            warnings: result.warnings,
            errors: result.errors,
          },
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Merge Word documents: ${baseTarget} + ${appendTarget}`, `Merge Word documents failed: ${message}`, message, decision.risk)
    }
  }

  private async extractXlsxTableTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Extract XLSX table",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Extract XLSX table", decision)
    try {
      if (!/\.(?:xlsx|xlsm)$/i.test(target)) {
        return failed("Extract XLSX table", `extract_xlsx_table only supports .xlsx/.xlsm files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const result = await extractXlsxTable({
        path: target,
        sheetName: stringArg(input.arguments.sheetName) || undefined,
        sheetIndex: numberFromArg(input.arguments.sheetIndex),
        range: stringArg(input.arguments.range) || undefined,
        hasHeaderRow: input.arguments.hasHeaderRow === undefined ? undefined : booleanArg(input.arguments.hasHeaderRow),
        maxRows: numberFromArg(input.arguments.maxRows),
        maxColumns: numberFromArg(input.arguments.maxColumns),
      })
      return {
        title: `Extracted XLSX table: ${workspaceRelativePath(target)}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Extracted ${result.rowCount} row(s) and ${result.columnCount} column(s) from ${result.sheetName}!${result.sourceRange}. Pass data.table into create_word_document or apply_word_document_edits as a real Word TableSpec.`,
          evidence: [],
          gaps: result.warnings,
          nextActions: [
            { tool: "create_word_document", reason: "Create a new DOCX with this TableSpec in a chosen section.", args: { path: workspaceRelativePath(target) } },
            { tool: "apply_word_document_edits", reason: "Insert or replace a table in an inspected DOCX using this TableSpec.", args: { path: workspaceRelativePath(target) } },
          ],
          truncated: result.warnings.some((warning) => warning.includes("truncated")),
          coverage: result.warnings.length ? "partial" : "bounded-complete",
          data: {
            sourcePath: workspaceRelativePath(target),
            sheetName: result.sheetName,
            sheetIndex: result.sheetIndex,
            sourceRange: result.sourceRange,
            rowCount: result.rowCount,
            columnCount: result.columnCount,
            table: result.table,
            warnings: result.warnings,
          },
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Extract XLSX table: ${target}`, `Extract XLSX table failed: ${message}`, message, decision.risk)
    }
  }

  private async exportWordTableToCsvTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const tableIndex = numberFromArg(input.arguments.tableIndex) ?? tableIndexFromLocator(input.arguments.locator)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Export Word table to CSV",
      summary: `${target} table ${tableIndex ?? 1}`,
      target: resolveWorkspacePath(".chipmate/docs/tables"),
    }
    const decision = await this.resolvePermission(input, request, { path: target, outputRoot: request.target, tableIndex: tableIndex ?? 1, tool: input.name })
    if (!decision.approved) return blocked("Export Word table to CSV", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Export Word table to CSV", `export_word_table_to_csv only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await exportWordTableToCsv({
        documentPath: workspaceRelativePath(target),
        bytes,
        workspaceRoot: workspaceRoot(),
        tableIndex,
        outputFilenameBase: outputFilenameBase || undefined,
      })
      return {
        title: `Exported Word table CSV: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Exported Word table ${result.tableIndex} from ${workspaceRelativePath(target)} to ${result.path}.`,
          evidence: [{ path: result.path, kind: "csv-table" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: "complete",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Export Word table to CSV: ${target}`, `Export Word table to CSV failed: ${message}`, message, decision.risk)
    }
  }

  private async auditWordDocumentStylesTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Audit Word document styles",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Audit Word document styles", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Audit Word document styles", `audit_word_document_styles only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const report = await auditWordDocumentStyles({ path: workspaceRelativePath(target), bytes })
      return {
        title: `Audited Word styles: ${workspaceRelativePath(target)}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Audited Word styles: ${report.directRunFormattingRuns} run(s) with direct formatting, ${report.directParagraphFormattingParagraphs} paragraph(s) with direct spacing/indent overrides, ${report.headingLikeParagraphsNotHeadingStyle.length} heading-like paragraph(s) not using Heading styles.`,
          evidence: [],
          gaps: [],
          nextActions: report.directRunFormattingRuns || report.directParagraphFormattingParagraphs || report.headingLikeParagraphsNotHeadingStyle.length
            ? [{ tool: "normalize_word_document_styles", reason: "Create a style-normalized copy if the user wants deterministic cleanup.", args: { path: workspaceRelativePath(target) } }]
            : [],
          truncated: false,
          coverage: "complete",
          data: report,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Audit Word document styles: ${target}`, `Audit Word document styles failed: ${message}`, message, decision.risk)
    }
  }

  private async normalizeWordDocumentStylesTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const preserveRunFormatting = wordRunFormattingKindsArg(input.arguments.preserveRunFormatting)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Normalize Word document styles",
      summary: target,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      path: target,
      outputRoot: request.target,
      clearParagraphFormatting: input.arguments.clearParagraphFormatting === true,
      preserveRunFormatting,
      enforceHeadingSpacing: input.arguments.enforceHeadingSpacing === true,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Normalize Word document styles", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Normalize Word document styles", `normalize_word_document_styles only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await new WordDocumentStyleNormalizer(workspaceRoot()).normalize({
        path: workspaceRelativePath(target),
        bytes,
        outputFilenameBase: outputFilenameBase || undefined,
        options: {
          clearRunFormatting: true,
          clearParagraphFormatting: input.arguments.clearParagraphFormatting === true,
          preserveRunFormatting,
          enforceHeadingSpacing: input.arguments.enforceHeadingSpacing === true,
          headingSpaceAfterTwips: numberFromArg(input.arguments.headingSpaceAfterTwips),
        },
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Normalized Word styles: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created style-normalized Word document: ${result.path}; cleared ${result.runOverridesCleared} run override(s), preserved ${result.runOverridesPreserved} run override(s), cleared ${result.paragraphOverridesCleared} paragraph override(s), and updated ${result.headingSpacingUpdates} heading spacing item(s).`,
          evidence: [{ path: result.path, kind: "style-normalized-docx" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: result.renderCheckResult.attempted ? "complete" : "partial",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Normalize Word document styles: ${target}`, `Normalize Word document styles failed: ${message}`, message, decision.risk)
    }
  }

  private async applyWordTemplateStylesTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.targetPath))
    const template = resolveWorkspacePath(stringArg(input.arguments.templatePath))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const styleAllowlist = stringListArg(input.arguments.styleAllowlist)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Apply Word template styles",
      summary: `${template} -> ${target}`,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      targetPath: target,
      templatePath: template,
      outputRoot: request.target,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Apply Word template styles", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Apply Word template styles", `apply_word_template_styles only supports .docx target files: ${target}`, `Unsupported target file extension: ${target}`, decision.risk)
      }
      if (!/\.(?:docx|dotx)$/i.test(template)) {
        return failed("Apply Word template styles", `apply_word_template_styles only supports .docx or .dotx template files: ${template}`, `Unsupported template file extension: ${template}`, decision.risk)
      }
      const targetBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const templateBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(template))
      const result = await new WordTemplateStyleApplier(workspaceRoot()).apply({
        target: { path: workspaceRelativePath(target), bytes: targetBytes },
        template: { path: workspaceRelativePath(template), bytes: templateBytes },
        outputFilenameBase: outputFilenameBase || undefined,
        styleAllowlist,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Applied Word template styles: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created template-styled Word document: ${result.path}; copied ${result.copiedParts.length} template style part(s).`,
          evidence: [{ path: result.path, kind: "template-styled-docx" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: result.renderCheckResult.attempted ? "complete" : "partial",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Apply Word template styles: ${template} -> ${target}`, `Apply Word template styles failed: ${message}`, message, decision.risk)
    }
  }

  private async auditWordDocumentFieldsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Audit Word document fields",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Audit Word document fields", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Audit Word document fields", `audit_word_document_fields only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const report = await auditWordDocumentFields({ path: workspaceRelativePath(target), bytes })
      const refCount = (report.fieldTypeCounts.REF ?? 0) + (report.fieldTypeCounts.PAGEREF ?? 0)
      const seqCount = report.fieldTypeCounts.SEQ ?? 0
      const nativeRefreshCount = (report.fieldTypeCounts.TOC ?? 0) + (report.fieldTypeCounts.PAGE ?? 0) + (report.fieldTypeCounts.NUMPAGES ?? 0)
      return {
        title: `Audited Word fields: ${workspaceRelativePath(target)}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Audited Word fields: ${report.fieldCount} field(s) found; types: ${Object.entries(report.fieldTypeCounts).map(([type, count]) => `${type}=${count}`).join(", ") || "none"}.`,
          evidence: [],
          gaps: [...report.staleFieldHints, ...report.unsupportedMaterialization],
          nextActions: [
            ...(refCount > 0
              ? [{ tool: "flatten_word_ref_fields", reason: "Create a deterministic-rendering copy by flattening cached REF/PAGEREF display text.", args: { path: workspaceRelativePath(target) } }]
              : []),
            ...(seqCount > 0
              ? [{ tool: "materialize_word_seq_fields", reason: "Create a deterministic-rendering copy by recalculating cached SEQ caption/table/figure numbers while preserving live SEQ fields.", args: { path: workspaceRelativePath(target) } }]
              : []),
            ...(nativeRefreshCount > 0
              ? [{ tool: "refresh_word_native_fields", reason: "Create a Word-native-field-refreshed copy for TOC/PAGE/NUMPAGES and render-verify it with local LibreOffice.", args: { path: workspaceRelativePath(target) } }]
              : []),
          ],
          truncated: false,
          coverage: "complete",
          data: report,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Audit Word document fields: ${target}`, `Audit Word document fields failed: ${message}`, message, decision.risk)
    }
  }

  private async flattenWordRefFieldsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Flatten Word REF fields",
      summary: target,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      path: target,
      outputRoot: request.target,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Flatten Word REF fields", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Flatten Word REF fields", `flatten_word_ref_fields only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await new WordRefFieldFlattener(workspaceRoot()).flatten({
        path: workspaceRelativePath(target),
        bytes,
        outputFilenameBase: outputFilenameBase || undefined,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Flattened Word REF fields: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created REF/PAGEREF-flattened Word document: ${result.path}; flattened ${result.flattenedFields} field(s).`,
          evidence: [{ path: result.path, kind: "ref-fields-flattened-docx" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: result.renderCheckResult.attempted ? "complete" : "partial",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Flatten Word REF fields: ${target}`, `Flatten Word REF fields failed: ${message}`, message, decision.risk)
    }
  }

  private async materializeWordSeqFieldsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Materialize Word SEQ fields",
      summary: target,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      path: target,
      outputRoot: request.target,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Materialize Word SEQ fields", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Materialize Word SEQ fields", `materialize_word_seq_fields only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await new WordSeqFieldMaterializer(workspaceRoot()).materialize({
        path: workspaceRelativePath(target),
        bytes,
        outputFilenameBase: outputFilenameBase || undefined,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      return {
        title: `Materialized Word SEQ fields: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created SEQ-materialized Word document: ${result.path}; materialized ${result.materializedFields} field(s), updated ${result.updatedFields} cached value(s).`,
          evidence: [{ path: result.path, kind: "seq-fields-materialized-docx" }],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: result.renderCheckResult.attempted ? "complete" : "partial",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Materialize Word SEQ fields: ${target}`, `Materialize Word SEQ fields failed: ${message}`, message, decision.risk)
    }
  }

  private async refreshWordNativeFieldsTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const outputFilenameBase = stringArg(input.arguments.outputFilenameBase)
    const requestedTimeoutMs = numberFromArg(input.arguments.timeoutMs)
    const timeoutMs = Math.min(180_000, Math.max(10_000, requestedTimeoutMs ?? 90_000))
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Refresh Word native fields",
      summary: target,
      target: resolveWorkspacePath(".chipmate/docs"),
    }
    const decision = await this.resolvePermission(input, request, {
      path: target,
      outputRoot: request.target,
      timeoutMs,
      tool: input.name,
    })
    if (!decision.approved) return blocked("Refresh Word native fields", decision)
    try {
      if (!target.toLowerCase().endsWith(".docx")) {
        return failed("Refresh Word native fields", `refresh_word_native_fields only supports .docx files: ${target}`, `Unsupported file extension: ${target}`, decision.risk)
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const result = await new WordNativeFieldRefresher(workspaceRoot()).refresh({
        path: workspaceRelativePath(target),
        bytes,
        outputFilenameBase: outputFilenameBase || undefined,
        timeoutMs,
        signal: input.signal,
        log: (message) => this.output?.appendLine(message),
      })
      const payload = wordRenderArtifactPayload({
        path: result.path,
        absolutePath: result.absolutePath,
        renderCheckResult: result.renderCheckResult,
      })
      return {
        title: `Refreshed Word native fields: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created Word-native-field-refreshed document: ${result.path}; refreshed field types: ${result.refreshedFieldTypes.join(", ") || "none"}; mode: ${result.refreshMode}.`,
          evidence: [
            { path: result.path, kind: "word-native-fields-refreshed-docx" },
            ...(result.renderCheckResult.pdfArtifactPath ? [{ path: result.renderCheckResult.pdfArtifactPath, kind: "word-render-pdf" }] : []),
            ...(result.renderCheckResult.pagePngPaths ?? []).map((path, index) => ({ path, kind: "word-render-page-png", page: index + 1 })),
          ],
          gaps: result.warnings,
          nextActions: result.renderCheckResult.attempted ? [] : [{ tool: "render_word_document", reason: "Render verification did not complete during native field refresh.", args: { path: result.path } }],
          truncated: false,
          coverage: result.renderCheckResult.attempted && (result.renderCheckResult.pagePngPaths?.length ?? 0) > 0 ? "complete" : "partial",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
        artifacts: [{ kind: "word-render", payload }],
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed(`Refresh Word native fields: ${target}`, `Refresh Word native fields failed: ${message}`, message, decision.risk)
    }
  }

  private async askUserClarification(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    input.signal?.throwIfAborted()
    const request = normalizedClarificationRequest(input.arguments)
    if (!request) {
      return failed(
        "Ask user clarification",
        "Clarification request must include at least one valid question or shorthand choice.",
        "Clarification request must include at least one valid question or shorthand choice.",
        "low",
      )
    }
    return {
      title: request.title,
      output: JSON.stringify({
        kind: "clarification",
        status: "waiting_for_user",
        clarificationId: request.clarificationId,
        questionCount: request.questions.length,
        blocking: request.blocking,
        assistantInstruction: "Wait for the user's structured answer. The host will return it as this tool call's result; do not continue this turn until then.",
      }),
      approved: true,
      status: "user-input-required",
      risk: "low",
      artifacts: [{ kind: "clarification", payload: request }],
    }
  }

	  private async validateDiagramIrTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
	    try {
      input.signal?.throwIfAborted()
      const result = validateDiagramIr(input.arguments)
      return {
        title: `Validated DiagramIR: ${result.diagramIr.title || "Diagram"}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: result.ok
            ? `DiagramIR "${result.diagramIr.title || "Diagram"}" is ready for draw.io rendering.`
            : `DiagramIR "${result.diagramIr.title || "Diagram"}" needs additional evidence or fixes before claiming completeness.`,
          assistantInstruction: result.ok
            ? "If the user asked for a diagram, call chipmate_create_drawio_diagram with this normalized DiagramIR or drawioSpec next."
            : "Address gaps by collecting evidence or revising DiagramIR before rendering, unless the user explicitly accepts a partial diagram.",
          ...result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: "low",
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed("Validate DiagramIR", `Validate DiagramIR failed: ${message}`, message, "low")
	    }
	  }

	  private async renderMermaidDiagramTool(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
	    const source = requiredString(input.arguments, "source")
	    const title = requiredString(input.arguments, "title")
	    const diagramId = stringArg(input.arguments.diagramId).trim() || `mermaid-${randomId()}`
	    const artifactNameBase = sanitizeArtifactName(stringArg(input.arguments.artifactNameBase) || diagramId || title)
	    const artifactDir = resolveWorkspacePath(".chipmate/docs/diagrams")
	    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
	    const base = `${artifactNameBase}-${stamp}-${Math.random().toString(36).slice(2, 6)}`
	    const mmdPath = nodePath.join(artifactDir, `${base}.mmd`)
	    const pngPath = nodePath.join(artifactDir, `${base}.png`)
	    let mmdWritten = false
	    const request: ToolRequest = {
	      id: randomId(),
	      kind: "write",
	      title: "Render Mermaid diagram",
	      summary: `${title} -> .chipmate/docs/diagrams`,
	      target: artifactDir,
	    }
	    const decision = await this.resolvePermission(input, request, {
	      tool: input.name,
	      title,
	      diagramId,
	      artifactRoot: artifactDir,
	    })
	    if (!decision.approved) return blocked("Render Mermaid diagram", decision)
	    try {
	      input.signal?.throwIfAborted()
	      this.output?.appendLine(`[mermaid-render] start title=${title} diagramId=${diagramId} mmd=${workspaceRelativePath(mmdPath)} png=${workspaceRelativePath(pngPath)}`)
	      input.progress?.({
	        id: "mermaid-source",
	        phase: "mermaid-source",
	        title: "写出 Mermaid 源文件",
	        detail: workspaceRelativePath(mmdPath),
	        status: "running",
	        tool: input.name,
	        artifactPath: workspaceRelativePath(mmdPath),
	      })
	      await vscode.workspace.fs.createDirectory(vscode.Uri.file(artifactDir))
	      await vscode.workspace.fs.writeFile(vscode.Uri.file(mmdPath), new TextEncoder().encode(source))
	      mmdWritten = true
	      input.progress?.({
	        id: "mermaid-source",
	        phase: "mermaid-source",
	        title: "写出 Mermaid 源文件",
	        detail: workspaceRelativePath(mmdPath),
	        status: "completed",
	        tool: input.name,
	        artifactPath: workspaceRelativePath(mmdPath),
	      })
	      const remoteEndpoint = configuredMermaidRemoteEndpoint()
	      input.progress?.({
	        id: "mermaid-render",
	        phase: "mermaid-render",
	        title: "渲染 Mermaid PNG",
	        detail: remoteEndpoint ? "优先远端 render server，失败后本地 fallback" : "使用本地 Chrome/Edge renderer",
	        status: "running",
	        tool: input.name,
	        artifactPath: workspaceRelativePath(pngPath),
	      })
	      const rendered = await renderMermaidToPngRemoteFirst({
	        source,
	        outputPath: pngPath,
	        filename: `${base}.mmd`,
	        remoteEndpoint,
	        timeoutMs: 60000,
	        signal: input.signal,
	        log: (message) => this.output?.appendLine(message),
	      })
	      const payload: MermaidDiagramArtifactPayload = {
	        kind: "mermaid",
	        title,
	        diagramId,
	        sourceText: source,
	        mmdPath: workspaceRelativePath(mmdPath),
	        absoluteMmdPath: mmdPath,
	        pngPath: workspaceRelativePath(pngPath),
	        absolutePngPath: pngPath,
	        width: rendered.width,
	        height: rendered.height,
	        renderProvider: rendered.renderProvider ?? "local-chrome",
	        fallbackUsed: rendered.fallbackUsed === true,
	        remoteFailure: rendered.remoteFailure,
	        localFailure: rendered.localFailure,
	        warnings: [],
	      }
	      input.progress?.({
	        id: "mermaid-render",
	        phase: "mermaid-render",
	        title: "渲染 Mermaid PNG",
	        detail: payload.fallbackUsed
	          ? `远端失败，已用本地 fallback 生成 ${payload.pngPath}`
	          : `已生成 ${payload.pngPath}`,
	        status: payload.fallbackUsed ? "warning" : "completed",
	        tool: input.name,
	        artifactPath: payload.pngPath,
	        provider: payload.renderProvider,
	        fallbackUsed: payload.fallbackUsed,
	      })
	      this.output?.appendLine(`[mermaid-render] completed title=${title} diagramId=${diagramId} provider=${payload.renderProvider} fallback=${payload.fallbackUsed ? "true" : "false"} mmd=${payload.mmdPath} png=${payload.pngPath} size=${payload.width}x${payload.height}`)
	      return {
	        title: `Rendered Mermaid diagram: ${title}`,
	        output: truncateBytes(JSON.stringify({
	          answerSummary: payload.fallbackUsed
	            ? `Rendered Mermaid diagram "${title}" to ${payload.pngPath} using local fallback after remote render failed.`
	            : `Rendered Mermaid diagram "${title}" to ${payload.pngPath}.`,
	          evidence: [],
	          gaps: payload.fallbackUsed && payload.remoteFailure ? [`Remote Mermaid render failed before local fallback succeeded: ${payload.remoteFailure.message}`] : [],
	          nextActions: [{ tool: "create_word_document", reason: "Insert the returned PNG artifact path into the matching WordDocSpec section as a FigureSpec.", args: {} }],
	          truncated: false,
	          coverage: "complete",
	          data: {
	            ...payload,
	            figure: {
	              title,
	              caption: title,
	              altText: title,
	              image: {
	                contentType: "image/png",
	                path: payload.pngPath,
	                artifactPath: payload.pngPath,
	                width: payload.width,
	                height: payload.height,
	              },
	            },
	          },
	        }, null, 2), MAX_OUTPUT_BYTES),
	        approved: true,
	        status: "completed",
	        risk: decision.risk,
	        artifacts: [{ kind: "mermaid", payload }],
	      }
	    } catch (error) {
	      if (input.signal?.aborted) throw error
	      const diagnostic = mermaidRenderDiagnosticFromError(error)
	      const message = diagnostic.message || formatErrorMessage(error)
	      this.output?.appendLine(`[mermaid-render] failed code=${diagnostic.errorCode} mmd=${mmdWritten ? workspaceRelativePath(mmdPath) : "(not-written)"} png=${workspaceRelativePath(pngPath)} message=${message}`)
	      if (diagnostic.checkedChromeCandidates?.length) {
	        this.output?.appendLine(`[mermaid-render] chrome candidates: ${diagnostic.checkedChromeCandidates.join("; ")}`)
	      }
	      if (diagnostic.stderrSnippet) this.output?.appendLine(`[mermaid-render] stderr: ${diagnostic.stderrSnippet}`)
	      if (diagnostic.stdoutSnippet) this.output?.appendLine(`[mermaid-render] stdout: ${diagnostic.stdoutSnippet}`)
	      input.progress?.({
	        id: "mermaid-render",
	        phase: "mermaid-render",
	        title: "渲染 Mermaid PNG",
	        detail: `${diagnostic.errorCode}: ${message}`,
	        status: "failed",
	        tool: input.name,
	        artifactPath: mmdWritten ? workspaceRelativePath(mmdPath) : undefined,
	      })
	      return mermaidRenderFailureResult({
	        title,
	        diagramId,
	        sourceText: source,
	        diagnostic,
	        risk: decision.risk,
	        mmdPath: mmdWritten ? workspaceRelativePath(mmdPath) : undefined,
	        absoluteMmdPath: mmdWritten ? mmdPath : undefined,
	        expectedPngPath: workspaceRelativePath(pngPath),
	        absoluteExpectedPngPath: pngPath,
	      })
	    }
	  }

	  private async createDrawioDiagram(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    try {
      input.signal?.throwIfAborted()
      const result = await generateDrawioDiagram(input.arguments)
      return {
        title: `Created draw.io diagram: ${result.title}`,
        output: JSON.stringify(drawioToolOutputSummary(result), null, 2),
        approved: true,
        status: "completed",
        risk: "low",
        artifacts: [{ kind: "drawio", payload: result }],
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed("Create draw.io diagram", `Create draw.io diagram failed: ${message}`, message, "low")
    }
  }

  private wordDocSpecArgumentDiagnostic(args: Record<string, unknown>, parsedSpec?: WordDocSpec) {
    const fragments = [`argumentKeys=${Object.keys(args).sort().join(",") || "none"}`]
    if (!Object.prototype.hasOwnProperty.call(args, "spec")) return fragments.join(" ")
    const raw = args.spec
    if (typeof raw === "string") {
      fragments.push(`specType=string`, `specStringBytes=${Buffer.byteLength(raw, "utf8")}`)
      fragments.push(`specHead="${this.quoteLogValue(this.textHeadByBytesForLog(raw, MAX_WORD_DOC_SPEC_DIAGNOSTIC_BYTES))}"`)
      fragments.push(`specTail="${this.quoteLogValue(this.textTailByBytesForLog(raw, MAX_WORD_DOC_SPEC_DIAGNOSTIC_BYTES))}"`)
      if (parsedSpec) fragments.push(this.wordDocSpecObjectDiagnostic(parsedSpec as unknown as Record<string, unknown>))
      return fragments.join(" ")
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fragments.push(`specType=${Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw}`)
      return fragments.join(" ")
    }
    fragments.push(`specType=object`, this.wordDocSpecObjectDiagnostic(raw as Record<string, unknown>))
    return fragments.join(" ")
  }

  private wordDocSpecObjectDiagnostic(spec: Record<string, unknown>) {
    const metadata = spec.metadata && typeof spec.metadata === "object" && !Array.isArray(spec.metadata)
      ? spec.metadata as Record<string, unknown>
      : {}
    const title = typeof metadata.title === "string" ? metadata.title : ""
    return [
      `specKeys=${Object.keys(spec).sort().join(",") || "none"}`,
      title ? `title="${this.quoteLogValue(title)}"` : "",
      `sections=${Array.isArray(spec.sections) ? spec.sections.length : "non-array"}`,
      `appendices=${Array.isArray(spec.appendices) ? spec.appendices.length : 0}`,
      `sources=${Array.isArray(spec.sources) ? spec.sources.length : 0}`,
    ].filter(Boolean).join(" ")
  }

  private quoteLogValue(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 500)
  }

  private textHeadByBytesForLog(input: string, maxBytes: number) {
    if (maxBytes <= 0) return ""
    const bytes = Buffer.from(input, "utf8")
    if (bytes.length <= maxBytes) return input
    return bytes.subarray(0, maxBytes).toString("utf8")
  }

  private textTailByBytesForLog(input: string, maxBytes: number) {
    if (maxBytes <= 0) return ""
    const bytes = Buffer.from(input, "utf8")
    if (bytes.length <= maxBytes) return input
    return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8")
  }

  private async createWordDocument(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const filename = stringArg(input.arguments.filename) || "generated-document"
    const target = resolveWorkspacePath(`.chipmate/docs/${filename.replace(/\.docx$/i, "")}.docx`)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Create Word document",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Create Word document", decision)
    input.progress?.({
      id: "word-spec",
      phase: "word-spec",
      title: "校验 WordDocSpec",
      detail: filename,
      status: "running",
      tool: input.name,
      path: workspaceRelativePath(target),
    })
    const normalizedSpec = normalizeWordDocSpecArgument(input.arguments)
    if (!normalizedSpec.ok) {
      this.output?.appendLine(`[word-doc-spec] rejected errorCode=${normalizedSpec.errorCode} error="${this.quoteLogValue(normalizedSpec.errorMessage)}" ${this.wordDocSpecArgumentDiagnostic(input.arguments)}`)
      input.progress?.({
        id: "word-spec",
        phase: "word-spec",
        title: "校验 WordDocSpec",
        detail: normalizedSpec.errorMessage,
        status: "failed",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      return wordDocSpecFailureResult({
        errorCode: normalizedSpec.errorCode,
        errorMessage: normalizedSpec.errorMessage,
        risk: decision.risk,
        receivedArgumentKeys: Object.keys(input.arguments).sort(),
      })
    }
    const validationIssues = new WordDocSpecValidator().validate(normalizedSpec.spec)
    const validationErrors = validationIssues.filter((issue) => issue.severity === "error").map((issue) => issue.message)
    if (validationErrors.length > 0) {
      this.output?.appendLine(`[word-doc-spec] validation failed errors=${validationErrors.length} firstError="${this.quoteLogValue(validationErrors[0] ?? "")}" ${this.wordDocSpecArgumentDiagnostic(input.arguments, normalizedSpec.spec)}`)
      input.progress?.({
        id: "word-spec",
        phase: "word-spec",
        title: "校验 WordDocSpec",
        detail: validationErrors.slice(0, 3).join("; "),
        status: "failed",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      return wordDocSpecFailureResult({
        errorCode: "word-doc-spec-validation-failed",
        errorMessage: `WordDocSpec validation failed: ${validationErrors.join("; ")}`,
        risk: decision.risk,
        receivedArgumentKeys: Object.keys(input.arguments).sort(),
        validationErrors,
      })
    }
    try {
      input.progress?.({
        id: "word-spec",
        phase: "word-spec",
        title: "校验 WordDocSpec",
        detail: "规格校验通过",
        status: "completed",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      input.progress?.({
        id: "word-build",
        phase: "word-build",
        title: "生成 Word 文档",
        detail: workspaceRelativePath(target),
        status: "running",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      const result = await createWordDocument({
        spec: normalizedSpec.spec,
        filename,
      })
      input.progress?.({
        id: "word-build",
        phase: "word-build",
        title: "生成 Word 文档",
        detail: result.path,
        status: "completed",
        tool: input.name,
        path: result.path,
        artifactPath: result.path,
      })
      return {
        title: `Created Word document: ${result.path}`,
        output: truncateBytes(JSON.stringify({
          answerSummary: `Created Word document: ${result.path}`,
          evidence: [],
          gaps: result.warnings,
          nextActions: [],
          truncated: false,
          coverage: "complete",
          data: result,
        }, null, 2), MAX_OUTPUT_BYTES),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      input.progress?.({
        id: "word-build",
        phase: "word-build",
        title: "生成 Word 文档",
        detail: message,
        status: "failed",
        tool: input.name,
        path: workspaceRelativePath(target),
      })
      const validationErrors = wordDocSpecValidationErrorsFromMessage(message)
      if (validationErrors.length > 0) {
        this.output?.appendLine(`[word-doc-spec] builder validation failed errors=${validationErrors.length} firstError="${this.quoteLogValue(validationErrors[0] ?? "")}" ${this.wordDocSpecArgumentDiagnostic(input.arguments, normalizedSpec.spec)}`)
        return wordDocSpecFailureResult({
          errorCode: "word-doc-spec-validation-failed",
          errorMessage: message,
          risk: decision.risk,
          receivedArgumentKeys: Object.keys(input.arguments).sort(),
          validationErrors,
        })
      }
      return failed("Create Word document", `Create Word document failed: ${message}`, message, decision.risk)
    }
  }

  private async writeFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const content = stringArg(input.arguments.content)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Write file",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, bytes: Buffer.byteLength(content, "utf8"), tool: input.name })
    if (!decision.approved) return blocked("Write file", decision)
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new TextEncoder().encode(content))
    return {
      title: `Wrote file: ${target}`,
      output: `Wrote ${Buffer.byteLength(content, "utf8")} byte(s).`,
      approved: true,
      status: "completed",
      risk: decision.risk,
    }
  }

  private async editFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const pathInput = requiredString(input.arguments, "path")
    const target = resolveWorkspacePath(pathInput)
    const oldInput = requiredStringValue(input.arguments, "oldString")
    const newInput = requiredStringValue(input.arguments, "newString")
    const replaceAll = booleanArg(input.arguments.replaceAll)
    const reason = stringArg(input.arguments.reason).trim()
    try {
      validateEditFileTarget(target, pathInput)
      validateEditStrings(oldInput, newInput)
      const relativePath = workspaceRelativePath(target)
      const kind = await workspacePathKind(target)
      if (kind === "missing") return failed("Edit file", `File does not exist: ${relativePath}`, `File does not exist: ${relativePath}`)
      if (kind === "directory") return failed("Edit file", `Edit file target is a directory: ${relativePath}`, `Edit file target is a directory: ${relativePath}`)

      const initial = await readEditableTextFile(target)
      const preview = exactReplacementPreview(initial.text, oldInput, newInput, replaceAll)
      if (!preview.ok) return failed("Edit file", preview.message, preview.message)
      const detail = {
        path: relativePath,
        absolutePath: target,
        bytes: Buffer.byteLength(preview.newString, "utf8"),
        beforeBytes: initial.bytes.length,
        oldBytes: Buffer.byteLength(preview.oldString, "utf8"),
        newBytes: Buffer.byteLength(preview.newString, "utf8"),
        replacements: preview.replacements,
        replaceAll,
        oldHash: hashText(preview.oldString),
        newHash: hashText(preview.newString),
        reason: reason ? truncateString(reason, 500) : undefined,
        tool: input.name,
      }
      const request: ToolRequest = {
        id: randomId(),
        kind: "write",
        title: "Edit file",
        summary: `${relativePath}\nReplacements: ${preview.replacements}${reason ? `\nReason: ${truncateString(reason, 240)}` : ""}`,
        target,
      }
      const decision = await this.resolvePermission(input, request, detail)
      if (!decision.approved) return blocked("Edit file", decision)

      const current = await readEditableTextFile(target)
      const currentPreview = exactReplacementPreview(current.text, oldInput, newInput, replaceAll)
      if (!currentPreview.ok) return failed("Edit file", currentPreview.message, currentPreview.message, decision.risk)
      const nextText = replaceAll
        ? current.text.split(currentPreview.oldString).join(currentPreview.newString)
        : replaceFirstExact(current.text, currentPreview.oldString, currentPreview.newString)
      const afterBytes = Buffer.byteLength(nextText, "utf8")
      if (afterBytes > MAX_EDIT_FILE_BYTES) {
        return failed("Edit file", `Edited file content is too large: ${afterBytes} byte(s), maximum ${MAX_EDIT_FILE_BYTES}.`, `Edited file content is too large: ${afterBytes} byte(s), maximum ${MAX_EDIT_FILE_BYTES}.`, decision.risk)
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new TextEncoder().encode(nextText))
      return {
        title: `Edited file: ${relativePath}`,
        output: JSON.stringify({
          answerSummary: `Edited file: ${relativePath}`,
          path: relativePath,
          absolutePath: target,
          replacements: currentPreview.replacements,
          replaceAll,
          beforeBytes: current.bytes.length,
          afterBytes,
          oldBytes: Buffer.byteLength(currentPreview.oldString, "utf8"),
          newBytes: Buffer.byteLength(currentPreview.newString, "utf8"),
          oldHash: hashText(currentPreview.oldString),
          newHash: hashText(currentPreview.newString),
          reason: reason || undefined,
        }, null, 2),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed("Edit file", `Edit file failed: ${message}`, message)
    }
  }

  private async createFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const pathInput = requiredString(input.arguments, "path")
    const target = resolveWorkspacePath(pathInput)
    const content = requiredStringValue(input.arguments, "content")
    const reason = stringArg(input.arguments.reason).trim()
    try {
      validateCreateFileTarget(target, pathInput)
      const bytes = validateCreateFileContent(content)
      const relativePath = workspaceRelativePath(target)
      if (await workspacePathExists(target)) {
        return failed("Create file", `File already exists: ${relativePath}`, `File already exists: ${relativePath}`)
      }
      const request: ToolRequest = {
        id: randomId(),
        kind: "write",
        title: "Create file",
        summary: `${relativePath}${reason ? `\nReason: ${truncateString(reason, 240)}` : ""}`,
        target,
      }
      const decision = await this.resolvePermission(input, request, {
        path: relativePath,
        absolutePath: target,
        bytes,
        reason: reason ? truncateString(reason, 500) : undefined,
        tool: input.name,
      })
      if (!decision.approved) return blocked("Create file", decision)
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(nodePath.dirname(target)))
      if (await workspacePathExists(target)) {
        return failed("Create file", `File already exists: ${relativePath}`, `File already exists: ${relativePath}`, decision.risk)
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new TextEncoder().encode(content))
      return {
        title: `Created file: ${relativePath}`,
        output: JSON.stringify({
          answerSummary: `Created file: ${relativePath}`,
          path: relativePath,
          absolutePath: target,
          bytes,
          reason: reason || undefined,
        }, null, 2),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed("Create file", `Create file failed: ${message}`, message)
    }
  }

  private async createDirectory(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    try {
      const pathInput = normalizeCreateDirectoryPathInput(requiredString(input.arguments, "path"))
      const target = resolveWorkspacePath(pathInput)
      const reason = stringArg(input.arguments.reason).trim()
      validateCreateDirectoryTarget(target, pathInput)
      const relativePath = workspaceRelativePath(target)
      if (await workspacePathExists(target)) {
        return failed("Create folder", `Folder path already exists: ${relativePath}`, `Folder path already exists: ${relativePath}`)
      }
      const request: ToolRequest = {
        id: randomId(),
        kind: "write",
        title: "Create folder",
        summary: `${relativePath}${reason ? `\nReason: ${truncateString(reason, 240)}` : ""}`,
        target,
      }
      const decision = await this.resolvePermission(input, request, {
        path: relativePath,
        absolutePath: target,
        reason: reason ? truncateString(reason, 500) : undefined,
        tool: input.name,
      })
      if (!decision.approved) return blocked("Create folder", decision)
      if (await workspacePathExists(target)) {
        return failed("Create folder", `Folder path already exists: ${relativePath}`, `Folder path already exists: ${relativePath}`, decision.risk)
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(target))
      return {
        title: `Created folder: ${relativePath}`,
        output: JSON.stringify({
          answerSummary: `Created folder: ${relativePath}`,
          path: relativePath,
          absolutePath: target,
          reason: reason || undefined,
        }, null, 2),
        approved: true,
        status: "completed",
        risk: decision.risk,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = formatErrorMessage(error)
      return failed("Create folder", `Create folder failed: ${message}`, message)
    }
  }

  private async runCommand(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const command = stringArg(input.arguments.command)
    const cwd = resolveWorkspacePath(stringArg(input.arguments.cwd) || workspaceRoot())
    const request: ToolRequest = {
      id: randomId(),
      kind: "command",
      title: "Run command",
      summary: command,
      command,
      cwd,
    }
    const decision = await this.resolvePermission(input, request, { command, cwd, tool: input.name })
    if (!decision.approved) return blocked("Run command", decision)
    const output = await runShell(command, cwd, input.signal)
    return {
      title: `Command: ${command}`,
      output: truncateBytes(output, MAX_OUTPUT_BYTES),
      approved: true,
      status: "completed",
      risk: decision.risk,
    }
  }

  private async httpRequest(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    const url = stringArg(input.arguments.url)
    const method = stringArg(input.arguments.method) || "GET"
    const body = stringArg(input.arguments.body)
    const request: ToolRequest = {
      id: randomId(),
      kind: "network",
      title: "HTTP request",
      summary: `${method.toUpperCase()} ${url}`,
      url,
      method,
    }
    const decision = await this.resolvePermission(input, request, { url, method, hasBody: Boolean(body), tool: input.name })
    if (!decision.approved) return blocked("HTTP request", decision)
    const response = await fetch(url, {
      method,
      body: body || undefined,
      signal: input.signal,
    })
    const text = await response.text()
    return {
      title: `${method.toUpperCase()} ${url}`,
      output: truncateBytes(`HTTP ${response.status} ${response.statusText}\n${text}`, MAX_OUTPUT_BYTES),
      approved: true,
      status: "completed",
      risk: decision.risk,
    }
  }

  private async analysisToolPayload(
    input: ToolRuntimeInput,
    tool: AnalysisToolName,
    args: Record<string, unknown>,
    options: { summary: string; coverage: Coverage; gap?: string },
  ): Promise<ToolPayload> {
    const codeGraph = this.providers.codeGraph
    if (!codeGraph) return unavailablePayload(`Local code graph is not available for ${input.name}.`)
    const result = await codeGraph.runAnalysisTool({ tool, args })
    const payload = this.payloadFromAnalysisTool(input, result, options)
    if (options.gap) payload.gaps.push(options.gap)
    return payload
  }

  private payloadFromAnalysisTool(
    input: ToolRuntimeInput,
    result: AnalysisToolResult,
    options: { summary: string; coverage: Coverage },
  ): ToolPayload {
    const evidence = this.registerEvidence(input.sessionID, input.name, result.evidence, result.tool)
    return {
      answerSummary: result.error ? `${options.summary} ${result.error}` : options.summary,
      evidence,
      gaps: result.error ? [result.error] : [],
      nextActions: evidence.slice(0, 3).map((item) => ({ tool: "chipmate_read_evidence", reason: "Read the full evidence item.", args: { refId: item.refId } })),
      truncated: Boolean(result.truncated),
      coverage: result.truncated ? "partial" : options.coverage,
      data: result.data,
    }
  }

  private payloadFromQueryEvidence(
    input: ToolRuntimeInput,
    result: QueryEvidenceResult | undefined,
    options: { summary: string; emptySummary: string; coverage: Coverage; nextTool: string },
  ): ToolPayload {
    if (!result) {
      return {
        answerSummary: options.emptySummary,
        evidence: [],
        gaps: ["No local code evidence was returned by the code graph query."],
        nextActions: [],
        truncated: false,
        coverage: "unknown",
      }
    }
    const evidence = this.registerEvidence(input.sessionID, input.name, result.evidencePack.evidence, "queryEvidence")
    return {
      answerSummary: evidence.length ? options.summary : options.emptySummary,
      evidence,
      gaps: [...result.evidencePack.missingEvidence, ...(result.answerPolicy.allowed ? [] : [result.answerPolicy.reason])],
      nextActions: evidence.slice(0, 3).map((item) => ({ tool: options.nextTool, reason: "Read the full evidence item.", args: { refId: item.refId } })),
      truncated: result.evidencePack.truncated,
      coverage: result.evidencePack.truncated ? "partial" : options.coverage,
      data: {
        intent: result.trace.intent,
        trace: result.trace.steps,
        answerPolicy: result.answerPolicy,
        suggestedAnswer: result.suggestedAnswer,
      },
    }
  }

  private registerEvidence(sessionID: string | undefined, sourceTool: string, refs: EvidenceRef[], defaultSourceKind: string): ToolEvidence[] {
    const store = this.evidenceStore(sessionID)
    return refs.slice(0, MAX_TEXT_SEARCH_RESULTS).map((ref) => {
      const refId = `ev_${(++this.evidenceCounter).toString(36)}`
      const sourceKind = ref.parserKind || defaultSourceKind
      const stored: StoredEvidence = {
        refId,
        path: ref.file,
        startLine: Math.max(1, Math.floor(ref.startLine || 1)),
        endLine: Math.max(Math.floor(ref.startLine || 1), Math.floor(ref.endLine || ref.startLine || 1)),
        sourceKind,
        snippet: ref.snippet ? truncateBytes(ref.snippet, MAX_EVIDENCE_SNIPPET_BYTES) : undefined,
        sourceTool,
      }
      store.set(refId, stored)
      return {
        refId,
        path: stored.path,
        lines: `${stored.startLine}-${stored.endLine}`,
        sourceKind,
        snippet: stored.snippet,
      }
    })
  }

  private evidenceStore(sessionID: string | undefined) {
    const key = sessionID || DEFAULT_SESSION_ID
    let store = this.evidenceStores.get(key)
    if (!store) {
      store = new Map()
      this.evidenceStores.set(key, store)
    }
    if (store.size > 300) {
      for (const refId of [...store.keys()].slice(0, store.size - 300)) store.delete(refId)
    }
    return store
  }

  private async documentLexicalEvidence(query: string, path: string): Promise<EvidenceRef[]> {
    const root = resolveWorkspacePath(path || ".")
    const files = (await listWorkspaceFiles({ root, recursive: true, maxFiles: MAX_TEXT_SEARCH_FILES + 1 }))
      .filter((item) => item.kind === "file" && /\.(?:doc|docx|xlsx|xlsm|pdf)$/i.test(item.path))
    const lowerQuery = query.toLowerCase()
    const refs: EvidenceRef[] = []
    for (const file of files) {
      if (refs.length >= MAX_TEXT_SEARCH_RESULTS) break
      let bytes: Uint8Array | undefined
      try {
        bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolveWorkspacePath(file.path)))
      } catch {
        bytes = undefined
      }
      if (!bytes) continue
      const parsed = await parseSupportedDocument({ path: file.path, bytes, maxBytes: MAX_OUTPUT_BYTES }).catch(() => undefined)
      const text = parsed?.text ?? ""
      if (!text.toLowerCase().includes(lowerQuery)) continue
      const lines = text.replace(/\r\n/g, "\n").split("\n")
      const index = Math.max(0, lines.findIndex((line) => line.toLowerCase().includes(lowerQuery)))
      const startLine = index + 1
      const endLine = Math.min(lines.length, startLine + 3)
      refs.push(evidenceRef(file.path, startLine, endLine, lines.slice(startLine - 1, endLine).join("\n"), `document-lexical:${parsed?.kind ?? "document"}`))
    }
    return refs
  }

  private async resolvePermission(input: ToolRuntimeInput, request: ToolRequest, detail: unknown): Promise<PermissionDecision> {
    let decision = decidePermission({ mode: input.mode, request })
    if (!decision.approved && decision.requiresApproval) {
      if (!input.approve) {
        decision = {
          ...decision,
          approved: false,
          reason: `QA inline approval unavailable; ${decision.reason}`,
        }
      } else {
        const approval = await input.approve({
          id: request.id,
          sessionID: input.sessionID,
          mode: input.mode,
          tool: input.name,
          title: request.title,
          summary: request.summary,
          risk: decision.risk,
          reason: decision.reason,
          request,
          arguments: input.arguments,
          detail,
        })
        decision = approval.approved
          ? { ...decision, approved: true, requiresApproval: false, reason: approval.reason ? `user approved once: ${approval.reason}; ${decision.reason}` : `user approved once; ${decision.reason}` }
          : { ...decision, approved: false, reason: approval.reason ? `user denied approval: ${approval.reason}; ${decision.reason}` : `user denied approval; ${decision.reason}` }
      }
    }
    const auditDetail = skillAuditDetail(input, detail)
    if (input.activeSkills?.length) {
      this.output?.appendLine(`[skills] tool name=${input.name} active=${input.activeSkills.map((skill) => skill.name).join(",")} allowedBySkill=${auditDetail.toolAllowedBySkill === true}`)
    }
    await this.auditDecision(input, decision, auditDetail)
    return decision
  }

  private async auditDecision(input: ToolRuntimeInput, decision: { approved: boolean; risk: string; reason: string }, detail: unknown) {
    this.output?.appendLine(`[tool] ${input.name} approved=${decision.approved} risk=${decision.risk} reason=${decision.reason}`)
    await this.audit.append({
      id: randomId(),
      at: Date.now(),
      sessionID: input.sessionID,
      kind: input.name,
      title: input.name,
      approved: decision.approved,
      risk: decision.risk,
      reason: decision.reason,
      detail,
    })
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function completedJson(title: string, payload: unknown): ToolRuntimeResult {
  return {
    title,
    output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
    approved: true,
    status: "completed",
  }
}

function summarizeRenderCheck(result: {
  attempted: boolean
  ok: boolean
  renderArtifactDir?: string
  pdfArtifactPath?: string
  pagePngPaths?: string[]
  pageCount?: number
  pdfToPngPath?: string
  pdfToPngRenderer?: string
  renderProvider?: string
  remoteEndpoint?: string
  visualQaStatus?: string
  skipReason?: string
  issues?: unknown[]
} | undefined) {
  if (!result) return undefined
  return {
    attempted: result.attempted,
    ok: result.ok,
    renderArtifactDir: result.renderArtifactDir,
    pdfArtifactPath: result.pdfArtifactPath,
    pagePngPaths: result.pagePngPaths,
    pageCount: result.pageCount,
    pdfToPngPath: result.pdfToPngPath,
    pdfToPngRenderer: result.pdfToPngRenderer,
    renderProvider: result.renderProvider,
    remoteEndpoint: result.remoteEndpoint,
    visualQaStatus: result.visualQaStatus,
    skipReason: result.skipReason,
    issues: result.issues,
  }
}

function wordRenderArtifactPayload(input: {
  path: string
  absolutePath: string
  renderCheckResult: WordEditRenderCheckResult
}): WordRenderArtifactPayload {
  return {
    kind: "word-render",
    path: input.path,
    absolutePath: input.absolutePath,
    renderCheckResult: input.renderCheckResult,
    renderArtifactDir: input.renderCheckResult.renderArtifactDir,
    pdfArtifactPath: input.renderCheckResult.pdfArtifactPath,
    pagePngPaths: input.renderCheckResult.pagePngPaths ?? [],
    pageVisualSummaries: input.renderCheckResult.pageVisualSummaries,
    issues: input.renderCheckResult.issues ?? [],
  }
}

function wordRenderIssueMessages(issues: QualityIssue[] | undefined) {
  return (issues ?? []).map((issue) => {
    const code = issue.code ? `${issue.code}: ` : ""
    return `${code}${issue.message}`
  })
}

function wordRenderSkipReasonLabel(reason: string | undefined) {
  switch (reason) {
    case "remote-unconfigured":
      return "unconfigured"
    case "remote-unavailable":
      return "unavailable"
    case "remote-invalid-response":
      return "returning an invalid response"
    case "artifact-persist-failed":
      return "unable to persist returned artifacts"
    default:
      return "unavailable or unconfigured"
  }
}

function boundedWordDocumentInspection(result: WordDocumentInspection) {
  const truncatedCollections: Array<{ name: string; included: number; total: number }> = []
  const cap = <T>(name: string, items: T[], max: number, mapItem: (item: T) => unknown = (item) => item) => {
    if (items.length > max) truncatedCollections.push({ name, included: max, total: items.length })
    return items.slice(0, max).map(mapItem)
  }
  const text = (value: string | undefined, max = 600) => truncateString(value ?? "", max)
  const tableRows = (rows: string[][]) => rows.slice(0, 40).map((row) => row.slice(0, 12).map((cell) => text(cell, 400)))

  return {
    metadata: result.metadata,
    summary: result.summary,
    warnings: result.warnings,
    documentEndLocator: result.documentEndLocator,
    protection: result.protection,
    paragraphs: cap("paragraphs", result.paragraphs, 160, (item) => ({
      ...item,
      text: text(item.text),
    })),
    tables: cap("tables", result.tables, 60, (item) => ({
      ...item,
      rows: tableRows(item.rows),
      truncatedRows: item.rows.length > 40 || item.rows.some((row) => row.length > 12),
    })),
    lists: cap("lists", result.lists, 80, (item) => ({
      ...item,
      items: item.items.slice(0, 80).map((listItem) => ({ ...listItem, text: text(listItem.text, 400) })),
      truncatedItems: item.items.length > 80,
    })),
    comments: cap("comments", result.comments, 120, (item) => ({
      ...item,
      text: text(item.text),
      anchorText: text(item.anchorText, 240),
      anchors: item.anchors.slice(0, 20).map((anchor) => ({ ...anchor, text: text(anchor.text, 240) })),
      truncatedAnchors: item.anchors.length > 20,
    })),
    contentControls: cap("contentControls", result.contentControls, 120, (item) => ({
      ...item,
      text: text(item.text),
      options: item.options?.slice(0, 40),
      truncatedOptions: (item.options?.length ?? 0) > 40,
    })),
    watermarks: cap("watermarks", result.watermarks, 80, (item) => ({ ...item, text: text(item.text) })),
    notes: cap("notes", result.notes, 120, (item) => ({ ...item, text: text(item.text) })),
    images: cap("images", result.images, 120),
    captions: cap("captions", result.captions, 120, (item) => ({
      ...item,
      text: text(item.text),
      fullText: text(item.fullText),
      fieldInstruction: text(item.fieldInstruction, 240),
    })),
    sections: cap("sections", result.sections, 80),
    fields: cap("fields", result.fields, 160, (item) => ({
      ...item,
      instruction: text(item.instruction, 240),
      cachedText: text(item.cachedText, 240),
    })),
    styles: cap("styles", result.styles, 80, (item) => ({
      id: item.id,
      blockId: item.blockId,
      styleIndex: item.styleIndex,
      part: item.part,
      styleId: item.styleId,
      type: item.type,
      name: item.name,
      basedOn: item.basedOn,
      isDefault: item.isDefault,
      paragraphUseCount: item.paragraphUseCount,
      runUseCount: item.runUseCount,
      sourceLocation: item.sourceLocation,
      normalizedHash: item.normalizedHash,
      locator: item.locator,
    })),
    hyperlinks: cap("hyperlinks", result.hyperlinks, 160, (item) => ({
      ...item,
      text: text(item.text),
      target: text(item.target, 500),
      anchor: text(item.anchor, 240),
      tooltip: text(item.tooltip, 240),
    })),
    locators: cap("locators", result.locators, 360),
    truncatedCollections,
  }
}

function requireGoalTools(input: ToolRuntimeInput): { ok: true; handler: GoalToolHandler } | { ok: false; result: ToolRuntimeResult } {
  if (!input.goals) {
    return {
      ok: false,
      result: failed(input.name, "Goal tools are unavailable in this ChipMate session.", "goal tools unavailable"),
    }
  }
  if (!input.sessionID) {
    return {
      ok: false,
      result: failed(input.name, "Goal tools require a persisted ChipMate session.", "missing sessionID"),
    }
  }
  return { ok: true, handler: input.goals }
}

function requireGoalSessionID(input: ToolRuntimeInput) {
  if (!input.sessionID) throw new Error("Goal tools require a sessionID.")
  return input.sessionID
}

function optionalPositiveInteger(input: unknown) {
  if (input === undefined || input === null || input === "") return undefined
  const value = Math.floor(Number(input))
  if (!Number.isFinite(value) || value <= 0) throw new Error("goal budgets must be positive when provided")
  return value
}

function blocked(title: string, decision: { reason: string; risk: string; requiresApproval: boolean }): ToolRuntimeResult {
  return {
    title,
    output: `Blocked by ChipMate permissions: ${decision.reason}`,
    approved: false,
    status: decision.requiresApproval ? "approval-required" : "blocked",
    requiresApproval: decision.requiresApproval,
    risk: decision.risk,
  }
}

function normalizeWordDocSpecArgument(args: Record<string, unknown>): { ok: true; spec: WordDocSpec } | { ok: false; errorCode: string; errorMessage: string } {
  if (!Object.prototype.hasOwnProperty.call(args, "spec")) {
    return {
      ok: false,
      errorCode: "word-doc-spec-missing",
      errorMessage: "Missing required argument: spec. Pass arguments as { filename?: string, spec: WordDocSpec }.",
    }
  }
  const raw = args.spec
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text) {
      return {
        ok: false,
        errorCode: "word-doc-spec-empty-string",
        errorMessage: "WordDocSpec argument spec was an empty string. Pass a JSON object, not prose.",
      }
    }
    const byteLength = Buffer.byteLength(text, "utf8")
    if (byteLength > MAX_WORD_DOC_SPEC_STRING_BYTES) {
      return {
        ok: false,
        errorCode: "word-doc-spec-string-too-large",
        errorMessage: `WordDocSpec string is too large: ${byteLength} byte(s), maximum ${MAX_WORD_DOC_SPEC_STRING_BYTES}.`,
      }
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          errorCode: "word-doc-spec-json-not-object",
          errorMessage: "WordDocSpec string parsed successfully but did not contain a JSON object.",
        }
      }
      return { ok: true, spec: parsed as WordDocSpec }
    } catch (error) {
      return {
        ok: false,
        errorCode: "word-doc-spec-json-parse-failed",
        errorMessage: `WordDocSpec string could not be parsed as JSON: ${formatErrorMessage(error)}`,
      }
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errorCode: "word-doc-spec-invalid-type",
      errorMessage: `WordDocSpec argument spec must be a JSON object. Received ${Array.isArray(raw) ? "array" : typeof raw}.`,
    }
  }
  return { ok: true, spec: raw as WordDocSpec }
}

function wordDocSpecFailureResult(input: {
  errorCode: string
  errorMessage: string
  risk?: string
  receivedArgumentKeys: string[]
  validationErrors?: string[]
}): ToolRuntimeResult {
  const gaps = input.validationErrors?.length ? input.validationErrors : [input.errorMessage]
  const payload = {
    answerSummary: `Create Word document failed: ${input.errorMessage}`,
    evidence: [],
    gaps,
    nextActions: [{
      tool: "create_word_document",
      reason: "Repair the WordDocSpec and retry with arguments shaped as { filename?: string, spec: WordDocSpec }.",
      args: {},
    }],
    truncated: false,
    coverage: "partial",
    data: {
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      validationErrors: input.validationErrors ?? [],
      receivedArgumentKeys: input.receivedArgumentKeys,
      expectedShape: minimalWordDocSpecShape(),
    },
  }
  return {
    title: "Create Word document",
    output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
    approved: false,
    status: "failed",
    error: input.errorMessage,
    risk: input.risk,
  }
}

function minimalWordDocSpecShape() {
  return {
    metadata: {
      title: "Document title",
      documentType: "technical-report",
      language: "zh-CN or en-US",
      generatedAt: "ISO-8601 timestamp",
    },
    sources: [],
    sections: [{
      id: "overview",
      level: 1,
      title: "Overview",
      paragraphs: ["Write document body here."],
    }],
  }
}

function wordDocSpecValidationErrorsFromMessage(message: string) {
  const prefix = "WordDocSpec validation failed:"
  if (!message.startsWith(prefix)) return []
  return message.slice(prefix.length).split(";").map((item) => item.trim()).filter(Boolean)
}

function failed(title: string, output: string, error: string, risk?: string): ToolRuntimeResult {
  return {
    title,
    output,
    approved: false,
    status: "failed",
    error,
    risk,
  }
}

function mermaidRenderDiagnosticFromError(error: unknown): MermaidPngRenderDiagnostic {
  if (error instanceof MermaidPngRenderError) return error.diagnostic
  return {
    errorCode: "mermaid-render-failed",
    message: truncateString(formatErrorMessage(error), 2000),
    platform: process.platform,
    cwd: process.cwd(),
    nodeVersion: process.version,
  }
}

function configuredMermaidRemoteEndpoint() {
  const fromEnv = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT?.trim()
  if (fromEnv) return fromEnv
  try {
    return vscode.workspace.getConfiguration("chipmate").get<string>("wordRender.remoteEndpoint", "").trim()
  } catch {
    return ""
  }
}

function mermaidRenderFailureResult(input: {
  title: string
  diagramId: string
  sourceText: string
  diagnostic: MermaidPngRenderDiagnostic
  risk?: string
  mmdPath?: string
  absoluteMmdPath?: string
  expectedPngPath: string
  absoluteExpectedPngPath: string
}): ToolRuntimeResult {
  const payload = {
    answerSummary: `Mermaid diagram "${input.title}" was not rendered to PNG. ${mermaidRenderUserMessage(input.diagnostic)}`,
    errorCode: input.diagnostic.errorCode,
    evidence: input.mmdPath ? [{ kind: "artifact", path: input.mmdPath, description: "Mermaid source was written before PNG rendering failed." }] : [],
    gaps: [
      "PNG artifact was not generated.",
      mermaidRenderUserMessage(input.diagnostic),
    ],
    nextActions: mermaidRenderNextActions(input.diagnostic),
    truncated: false,
    coverage: "partial",
    data: {
      kind: "mermaid",
      title: input.title,
      diagramId: input.diagramId,
      mmdPath: input.mmdPath,
      absoluteMmdPath: input.absoluteMmdPath,
      expectedPngPath: input.expectedPngPath,
      absoluteExpectedPngPath: input.absoluteExpectedPngPath,
      pngGenerated: false,
      wordFigureUsable: false,
      mustNotEmbedSourceAsFigure: true,
      diagnostic: input.diagnostic,
      remoteFailure: input.diagnostic.remoteFailure,
      localFailure: input.diagnostic.localFailure,
      sourceTextPreview: truncateString(input.sourceText, 1200),
    },
  }
  return {
    title: `Render Mermaid diagram failed: ${input.title}`,
    output: truncateBytes(JSON.stringify(payload, null, 2), MAX_OUTPUT_BYTES),
    approved: false,
    status: "failed",
    error: input.diagnostic.message,
    risk: input.risk,
  }
}

function mermaidRenderUserMessage(diagnostic: MermaidPngRenderDiagnostic) {
  switch (diagnostic.errorCode) {
    case "chrome-not-found":
      return "No local Chrome/Edge executable was found for headless Mermaid PNG rendering; install Chrome/Edge or set CHROME_PATH."
    case "chrome-startup-failed":
    case "chrome-devtools-failed":
      return "Chrome/Edge was found but could not be started or controlled through DevTools for headless rendering."
    case "mermaid-runtime-missing":
      return "The packaged Mermaid runtime file is missing from the extension."
    case "mermaid-render-timeout":
      return "Mermaid rendering timed out before a PNG could be captured."
    case "mermaid-render-failed":
      return "Mermaid failed to parse or render the provided source."
    case "png-invalid":
      return "The renderer did not return a valid PNG image."
    case "artifact-write-failed":
      return "The PNG was rendered but could not be written to the workspace artifact path."
    case "remote-unavailable":
    case "remote-timeout":
      return "Remote Mermaid render server was unavailable or timed out; local fallback was attempted when possible."
    case "remote-invalid-response":
      return "Remote Mermaid render server returned an invalid response; local fallback was attempted when possible."
    case "remote-render-failed":
      return "Remote Mermaid render server could not render the diagram; local fallback was attempted when possible."
    default:
      return "Mermaid PNG rendering failed."
  }
}

function mermaidRenderNextActions(diagnostic: MermaidPngRenderDiagnostic) {
  switch (diagnostic.errorCode) {
    case "chrome-not-found":
      return [
        { action: "Install Chrome or Edge on this machine, or set CHROME_PATH to the browser executable path.", reason: "Mermaid PNG rendering currently uses local headless Chrome/Edge." },
        { action: "Check the ChipMate Output channel for the full Chrome discovery candidates.", reason: "It records every checked browser location." },
      ]
    case "chrome-startup-failed":
    case "chrome-devtools-failed":
      return [
        { action: "Verify the configured Chrome/Edge executable can run in headless mode from the VS Code extension host environment.", reason: "The browser was found but did not expose a usable DevTools endpoint." },
        { action: "Check the ChipMate Output channel stderr/stdout snippets.", reason: "They usually include policy, sandbox, or permission failures." },
      ]
    case "mermaid-render-failed":
    case "mermaid-render-timeout":
      return [
        { action: "Validate or simplify the Mermaid source and retry rendering.", reason: "The Mermaid runtime failed before PNG capture." },
        { action: "Use the returned .mmd artifact path to reproduce the render failure.", reason: "The source artifact is preserved when it was written successfully." },
      ]
    case "mermaid-runtime-missing":
      return [
        { action: "Repackage the VSIX and confirm node_modules/mermaid/dist/mermaid.esm.min.mjs is included.", reason: "The renderer requires the local Mermaid ESM runtime." },
      ]
    case "remote-unavailable":
    case "remote-timeout":
    case "remote-invalid-response":
    case "remote-render-failed":
      return [
        { action: "Check the remote render server /health and /render/mermaid endpoint.", reason: "Remote Mermaid PNG rendering is the first-priority provider." },
        { action: "If local fallback also failed, fix either the remote render server or the local Chrome/Edge renderer before creating a Word figure.", reason: "Word figures require PNG artifacts; Mermaid source text must not be used as a substitute." },
      ]
    default:
      return [
        { action: "Inspect the structured diagnostic and ChipMate Output channel, then retry after fixing the reported environment or artifact issue.", reason: "PNG generation did not complete." },
      ]
  }
}

function normalizedClarificationRequest(input: Record<string, unknown>): ClarificationRequest | undefined {
  const reason = truncateString(compactText(stringArg(input.reason) || "Need user clarification before continuing."), 360)
  const explicitQuestions = Array.isArray(input.questions) ? input.questions : []
  let questions = explicitQuestions
    .slice(0, 3)
    .map((item, index) => normalizedClarificationQuestion(item, index, input.allowFreeText === true))
    .filter((item): item is ClarificationQuestion => Boolean(item))
  if (questions.length === 0) {
    const shorthandChoices = normalizedClarificationChoices(input.choices, 0)
    const fallbackQuestion = truncateString(compactText(reason || "Which option should ChipMate use?"), 240)
    if (shorthandChoices.length > 0 || input.allowFreeText === true) {
      questions = [{
        id: "q1",
        question: fallbackQuestion,
        choices: shorthandChoices,
        allowFreeText: input.allowFreeText === true,
      }]
    }
  }
  if (questions.length === 0) return undefined
  const clarificationId = `clarification-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    kind: "clarification",
    clarificationId,
    title: `Clarification needed: ${truncateString(questions[0]?.question || "Question", 80)}`,
    reason,
    questions,
    blocking: input.blocking !== false,
  }
}

function normalizedClarificationQuestion(input: unknown, index: number, fallbackAllowFreeText: boolean): ClarificationQuestion | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  const question = truncateString(compactText(stringArg(record.question)), 240)
  if (!question) return undefined
  const choices = normalizedClarificationChoices(record.choices, index)
  return {
    id: safeClarificationId(stringArg(record.id), `q${index + 1}`),
    question,
    choices,
    allowFreeText: typeof record.allowFreeText === "boolean" ? record.allowFreeText : fallbackAllowFreeText || choices.length === 0,
  }
}

function normalizedClarificationChoices(input: unknown, questionIndex: number): ClarificationChoice[] {
  if (!Array.isArray(input)) return []
  return input
    .slice(0, 5)
    .map((item, index) => {
      if (typeof item === "string") {
        const label = truncateString(compactText(item), 80)
        return label ? { id: `c${index + 1}`, label } : undefined
      }
      if (!item || typeof item !== "object") return undefined
      const record = item as Record<string, unknown>
      const label = truncateString(compactText(stringArg(record.label)), 80)
      if (!label) return undefined
      const description = truncateString(compactText(stringArg(record.description)), 160)
      return {
        id: safeClarificationId(stringArg(record.id), `q${questionIndex + 1}c${index + 1}`),
        label,
        ...(description ? { description } : {}),
      }
    })
    .filter((item): item is ClarificationChoice => Boolean(item))
}

function safeClarificationId(input: string, fallback: string) {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return truncateString(normalized || fallback, 40)
}

function compactText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function drawioToolOutputSummary(result: DrawioGeneratedDiagram) {
  const warnings = boundedStringList(result.warnings, 20, 360)
  const gaps = boundedStringList(result.gaps, 12, 360)
  return {
    kind: "drawio",
    answerSummary: `Created draw.io diagram "${result.title}" for direct chat rendering.`,
    assistantInstruction: result.gaps?.length
      ? "The partial diagram has been inserted as a rendered chat diagram part. Briefly describe it, mention remaining evidence gaps, and do not repeat the XML unless the user explicitly asks for source."
      : "The diagram has been inserted as a rendered chat diagram part. In the final answer, briefly describe it; do not repeat the XML unless the user explicitly asks for source.",
    diagramId: result.diagramId,
    title: result.title,
    layoutEngine: result.normalizedSpec.layoutEngine,
    visualCompiler: {
      version: result.normalizedSpec.visualPlan?.compilerVersion,
      profile: result.normalizedSpec.visualPlan?.profile,
      textOverflowRepairs: result.normalizedSpec.visualPlan?.qualityGate.textOverflowRepairs ?? 0,
      edgeLabelRepairs: result.normalizedSpec.visualPlan?.qualityGate.edgeLabelRepairs ?? 0,
      labelSanitizationRepairs: result.normalizedSpec.visualPlan?.qualityGate.labelSanitizationRepairs ?? 0,
      edgeVisibilityRepairs: result.normalizedSpec.visualPlan?.qualityGate.edgeVisibilityRepairs ?? 0,
      visibleEdges: result.normalizedSpec.visualPlan?.qualityGate.visibleEdges ?? result.normalizedSpec.edges.length,
      calloutEdges: result.normalizedSpec.visualPlan?.qualityGate.calloutEdges ?? 0,
      legendEdges: result.normalizedSpec.visualPlan?.qualityGate.legendEdges ?? 0,
      edgeOverlapRepairs: result.normalizedSpec.visualPlan?.qualityGate.edgeOverlapRepairs ?? 0,
      edgePassThroughRepairs: result.normalizedSpec.visualPlan?.qualityGate.edgePassThroughRepairs ?? 0,
      repairPasses: result.normalizedSpec.visualPlan?.qualityGate.repairPasses ?? 0,
      legendItems: result.normalizedSpec.visualPlan?.qualityGate.legendItems ?? 0,
    },
    diagramType: result.normalizedSpec.diagramType,
    counts: {
      nodes: result.normalizedSpec.nodes.length,
      edges: result.normalizedSpec.edges.length,
      containers: result.normalizedSpec.containers.length,
      additionalDiagrams: result.additionalDiagrams?.length ?? 0,
      xmlBytes: Buffer.byteLength(result.mxGraphModelXml, "utf8"),
    },
    warnings,
    gaps,
    truncatedWarnings: result.warnings.length > warnings.length,
    truncatedGaps: (result.gaps?.length ?? 0) > gaps.length,
    coverage: result.coverageReport?.coverage ?? result.normalizedSpec.coverageReport?.coverage,
    hasChatDiagramArtifact: true,
  }
}

function boundedStringList(input: string[] | undefined, maxItems: number, maxChars: number) {
  return (input ?? [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxItems)
    .map((item) => truncateString(item.replace(/\s+/g, " ").trim(), maxChars))
}

function unavailablePayload(message: string): ToolPayload {
  return {
    answerSummary: message,
    evidence: [],
    gaps: [message],
    nextActions: [],
    truncated: false,
    coverage: "unknown",
  }
}

function toolSummary(tool: string, args: Record<string, unknown>) {
  const rows = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value.slice(0, 160) : JSON.stringify(value).slice(0, 160)}`)
    .join(" ")
  return `${tool}${rows ? ` ${rows}` : ""}`
}

async function listWorkspaceFiles(input: { root: string; recursive: boolean; maxFiles: number }): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
  const root = input.root
  if (!isWithinWorkspace(root)) throw new Error(`Path is outside the current workspace: ${root}`)
  const rows: Array<{ path: string; kind: "file" | "directory" }> = []
  const visit = async (dir: string) => {
    if (rows.length >= input.maxFiles) return
    let entries: [string, number][]
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))
    } catch {
      const text = await readTextFileIfSmall(dir, MAX_OUTPUT_BYTES).catch(() => "")
      if (text !== "") rows.push({ path: workspaceRelativePath(dir), kind: "file" })
      return
    }
    entries.sort(([leftName, leftType], [rightName, rightType]) => rightType - leftType || leftName.localeCompare(rightName))
    for (const [name, type] of entries) {
      if (rows.length >= input.maxFiles) break
      if (shouldSkipPath(name)) continue
      const child = vscode.Uri.joinPath(vscode.Uri.file(dir), name).fsPath
      const kind = type === vscode.FileType.Directory ? "directory" : "file"
      rows.push({ path: workspaceRelativePath(child) + (kind === "directory" ? "/" : ""), kind })
      if (kind === "directory" && input.recursive) await visit(child)
    }
  }
  await visit(root)
  return rows
}

function shouldSkipPath(name: string) {
  return name === ".git" || name === "node_modules" || name === "dist" || name === "out" || name === "build" || name === ".vscode-test"
}

function isWithinWorkspace(target: string) {
  const root = workspaceRoot()
  return isSubpath(root, target)
}

function isSubpath(root: string, candidate: string) {
  const normalizedRoot = normalizePath(root).replace(/\/+$/, "")
  const normalizedCandidate = normalizePath(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

type SkillScriptManifest = {
  schemaVersion?: number
  version?: string
  executionPolicy?: {
    directExecution?: boolean
    networkPolicy?: string
  }
  helpers?: SkillScriptManifestHelper[]
}

type SkillScriptManifestHelper = {
  name?: string
  codexScript?: string
  script?: string
  status?: string
  directExecution?: boolean
  execution?: {
    directExecution?: boolean
    runtime?: string
    entrypoint?: string
    timeoutMs?: number
    maxOutputBytes?: number
    allowedExtensions?: string[]
    networkPolicy?: string
    inputSchema?: SkillScriptInputSchema
    outputArtifacts?: SkillScriptOutputArtifactSpec[]
  }
}

type SkillScriptInputSchema = {
  type?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, SkillScriptInputPropertySchema>
}

type SkillScriptInputPropertySchema = {
  type?: string
  enum?: unknown[]
  maxLength?: number
  pathKind?: "workspace" | "skill-resource"
  allowedExtensions?: string[]
  items?: SkillScriptInputPropertySchema
}

type SkillScriptOutputArtifactSpec = {
  name?: string
  kind?: string
  contentType?: string
  description?: string
  path?: string
  required?: boolean
}

async function readSkillScriptManifest(skillRoot: string): Promise<SkillScriptManifest> {
  const manifestPath = nodePath.join(skillRoot, "scripts", "manifest.json")
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(manifestPath))
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scripts/manifest.json must be a JSON object")
  return parsed as SkillScriptManifest
}

function findManifestHelper(manifest: SkillScriptManifest, scriptName: string) {
  const wanted = normalizePath(scriptName.trim())
  return (manifest.helpers ?? []).find((helper) => {
    const candidates = [
      helper.name,
      helper.codexScript,
      helper.script,
      helper.execution?.entrypoint,
      helper.execution?.entrypoint ? nodePath.posix.basename(normalizePath(helper.execution.entrypoint)) : undefined,
    ].filter((item): item is string => Boolean(item))
    return candidates.some((candidate) => normalizePath(candidate) === wanted)
  })
}

function skillScriptCommand(runtime: string) {
  if (runtime === "node" || runtime === "nodejs") {
    return { command: process.execPath, args: [] as string[], display: "node" }
  }
  if (runtime === "python" || runtime === "python3") {
    return { command: "python3", args: [] as string[], display: "python3" }
  }
  return undefined
}

function skillScriptEntrypointMatchesRuntime(entrypoint: string, runtime: string) {
  const extension = nodePath.posix.extname(entrypoint).toLowerCase()
  if (runtime === "node" || runtime === "nodejs") return extension === ".js" || extension === ".mjs" || extension === ".cjs"
  if (runtime === "python" || runtime === "python3") return extension === ".py"
  return false
}

function boundedSkillScriptTimeout(requested?: number, manifestTimeout?: number) {
  const fallback = 30_000
  const hardMax = 120_000
  const values = [requested, manifestTimeout].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
  return Math.min(...(values.length ? values : [fallback]), hardMax)
}

function boundedSkillScriptOutputBytes(manifestOutputBytes?: number) {
  if (typeof manifestOutputBytes !== "number" || !Number.isFinite(manifestOutputBytes) || manifestOutputBytes <= 0) return MAX_READ_TEXT_BYTES
  return Math.min(Math.floor(manifestOutputBytes), MAX_SKILL_SCRIPT_OUTPUT_BYTES)
}

function isOfflineSkillScriptNetworkPolicy(input: string) {
  return input === "none" || input === "offline" || input === "disabled"
}

function skillScriptExecutionEnv(input: { skillRoot: string; artifactRoot?: string; networkPolicy: string }) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    CHIPMATE_SKILL_ROOT: input.skillRoot,
    CHIPMATE_WORKSPACE_ROOT: workspaceRoot(),
    CHIPMATE_NETWORK_POLICY: input.networkPolicy,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*",
  }
  if (input.artifactRoot) env.CHIPMATE_SKILL_ARTIFACT_DIR = input.artifactRoot
  return env
}

function validateSkillScriptInput(args: Record<string, unknown>, input: {
  schema?: SkillScriptInputSchema
  allowedExtensions?: string[]
  skillRoot: string
}) {
  const errors: string[] = []
  const warnings: string[] = []
  const schema = input.schema
  if (!schema) return { errors, warnings }
  if (schema.type && schema.type !== "object") {
    errors.push("inputSchema.type must be object")
    return { errors, warnings }
  }
  const properties = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    if (!(key in args)) errors.push(`Missing required argument: ${key}`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) errors.push(`Unexpected argument: ${key}`)
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]
    if (!property) continue
    validateSkillScriptInputValue({
      key,
      value,
      schema: property,
      allowedExtensions: property.allowedExtensions ?? input.allowedExtensions ?? [],
      skillRoot: input.skillRoot,
      errors,
    })
  }
  return { errors, warnings }
}

function validateSkillScriptInputValue(input: {
  key: string
  value: unknown
  schema: SkillScriptInputPropertySchema
  allowedExtensions: string[]
  skillRoot: string
  errors: string[]
}) {
  const { key, value, schema, errors } = input
  if (schema.type && !jsonValueMatchesType(value, schema.type)) {
    errors.push(`Argument ${key} must be ${schema.type}`)
    return
  }
  if (schema.enum && !schema.enum.some((item) => item === value)) errors.push(`Argument ${key} is not one of the allowed values`)
  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`Argument ${key} exceeds maxLength ${schema.maxLength}`)
  }
  if (schema.pathKind && typeof value === "string") {
    validateSkillScriptPathArgument({
      key,
      value,
      pathKind: schema.pathKind,
      allowedExtensions: input.allowedExtensions,
      skillRoot: input.skillRoot,
      errors,
    })
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateSkillScriptInputValue({
      key: `${key}[${index}]`,
      value: item,
      schema: schema.items!,
      allowedExtensions: schema.items!.allowedExtensions ?? input.allowedExtensions,
      skillRoot: input.skillRoot,
      errors,
    }))
  }
}

function jsonValueMatchesType(value: unknown, type: string) {
  if (type === "string") return typeof value === "string"
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value))
  if (type === "boolean") return typeof value === "boolean"
  if (type === "array") return Array.isArray(value)
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value)
  return true
}

function validateSkillScriptPathArgument(input: {
  key: string
  value: string
  pathKind: "workspace" | "skill-resource"
  allowedExtensions: string[]
  skillRoot: string
  errors: string[]
}) {
  if (input.pathKind === "workspace") {
    const target = resolveWorkspacePath(input.value)
    if (!isWithinWorkspace(target)) input.errors.push(`Argument ${input.key} must stay inside the workspace`)
    if (!pathMatchesAllowedExtensions(target, input.allowedExtensions)) input.errors.push(`Argument ${input.key} has an extension that is not allowed`)
    return
  }
  const resourcePath = normalizeSkillResourcePath(input.value)
  if (!isAllowedSkillResourcePath(resourcePath)) {
    input.errors.push(`Argument ${input.key} must be a safe skill resource path`)
    return
  }
  const target = nodePath.join(input.skillRoot, ...resourcePath.split("/"))
  if (!isSubpath(input.skillRoot, target)) input.errors.push(`Argument ${input.key} escapes the active skill directory`)
  if (!pathMatchesAllowedExtensions(target, input.allowedExtensions)) input.errors.push(`Argument ${input.key} has an extension that is not allowed`)
}

function pathMatchesAllowedExtensions(path: string, allowedExtensions: string[]) {
  if (allowedExtensions.length === 0) return true
  const normalized = new Set(allowedExtensions.map((extension) => extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`))
  return normalized.has(nodePath.extname(path).toLowerCase())
}

async function prepareSkillScriptArtifactRoot(skillName: string, scriptName: string) {
  const root = resolveWorkspacePath(".chipmate/docs/skill-script-artifacts")
  const runDir = [
    safePathSegment(skillName),
    safePathSegment(scriptName.replace(/\.[^.]+$/, "")),
    Date.now().toString(36),
  ].filter(Boolean).join("-")
  const target = nodePath.join(root, runDir)
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(target))
  return target
}

async function collectSkillScriptArtifacts(specs: SkillScriptOutputArtifactSpec[], artifactRoot: string | undefined) {
  const artifacts: SkillScriptRegisteredArtifact[] = []
  const evidenceRefs: EvidenceRef[] = []
  const warnings: string[] = []
  const missingRequired: string[] = []
  if (specs.length === 0) return { artifacts, evidenceRefs, warnings, missingRequired }
  if (!artifactRoot) {
    return {
      artifacts,
      evidenceRefs,
      warnings,
      missingRequired: specs.filter((spec) => spec.required !== false).map((spec) => spec.name ?? spec.path ?? "unnamed-artifact"),
    }
  }
  for (const spec of specs) {
    const artifactPath = normalizeSkillArtifactPath(spec.path ?? "")
    const label = spec.name ?? artifactPath
    if (!artifactPath) {
      if (spec.required !== false) missingRequired.push(label || "unnamed-artifact")
      warnings.push(`Ignored script artifact with unsafe path: ${label || "unnamed-artifact"}`)
      continue
    }
    const absolutePath = nodePath.join(artifactRoot, ...artifactPath.split("/"))
    if (!isSubpath(artifactRoot, absolutePath)) {
      if (spec.required !== false) missingRequired.push(label)
      warnings.push(`Ignored script artifact outside artifact root: ${label}`)
      continue
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath))
      if (bytes.length > MAX_SKILL_SCRIPT_ARTIFACT_BYTES) {
        if (spec.required !== false) missingRequired.push(label)
        warnings.push(`Ignored script artifact larger than ${MAX_SKILL_SCRIPT_ARTIFACT_BYTES} bytes: ${label}`)
        continue
      }
      const registered: SkillScriptRegisteredArtifact = {
        name: spec.name,
        kind: spec.kind,
        contentType: spec.contentType,
        description: spec.description,
        path: workspaceRelativePath(absolutePath),
        absolutePath,
        bytes: bytes.length,
      }
      artifacts.push(registered)
      const evidenceText = await skillScriptArtifactEvidenceText(absolutePath, spec.contentType)
      if (evidenceText) {
        const lines = evidenceText.replace(/\r\n/g, "\n").split("\n")
        evidenceRefs.push(evidenceRef(registered.path, 1, Math.max(1, lines.length), truncateBytes(evidenceText, MAX_EVIDENCE_SNIPPET_BYTES), "skill-script-artifact"))
      }
    } catch (error) {
      if (spec.required !== false) missingRequired.push(label)
      warnings.push(`Script artifact was not available: ${label}: ${formatErrorMessage(error)}`)
    }
  }
  return { artifacts, evidenceRefs, warnings, missingRequired }
}

function normalizeSkillArtifactPath(input: string) {
  const normalized = normalizeSkillResourcePath(input)
  if (!normalized || /^(?:[A-Za-z]:|\/)/.test(input)) return ""
  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return ""
  return normalized
}

async function skillScriptArtifactEvidenceText(path: string, contentType: string | undefined) {
  const extension = nodePath.extname(path).toLowerCase()
  const isText = Boolean(contentType?.startsWith("text/")) || contentType === "application/json" || [".json", ".txt", ".md", ".csv"].includes(extension)
  if (!isText) return ""
  return readTextFileIfSmall(path, MAX_EVIDENCE_SNIPPET_BYTES).catch(() => "")
}

function safePathSegment(input: string) {
  return input
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "script"
}

function jsonObjectArg(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function normalizeSkillResourcePath(input: string) {
  return input.trim().replace(/\\/g, "/").replace(/^\/+/g, "").replace(/\/+/g, "/")
}

function isAllowedSkillResourcePath(input: string) {
  if (!input || /^(?:[A-Za-z]:|\/)/.test(input)) return false
  const segments = input.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false
  return segments[0] === "references" || segments[0] === "assets" || segments[0] === "scripts" || segments[0] === "tasks"
}

function skillAuditDetail(input: ToolRuntimeInput, detail: unknown): Record<string, unknown> {
  const base = detail && typeof detail === "object" && !Array.isArray(detail)
    ? { ...(detail as Record<string, unknown>) }
    : { detail }
  const activeSkills = input.activeSkills ?? []
  if (activeSkills.length === 0) return base
  const allowed = activeSkills.find((skill) => skill.allowedTools.includes(input.name))
  const skill = allowed ?? activeSkills[0]
  return {
    ...base,
    skillId: skill.id,
    skillName: skill.name,
    invocationMode: skill.invocationMode,
    toolAllowedBySkill: Boolean(allowed),
  }
}

function workspaceRelativePath(input: string) {
  const normalized = normalizePath(input)
  const root = normalizePath(workspaceRoot()).replace(/\/+$/, "")
  if (normalized === root) return "."
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return normalized
}

async function workspacePathExists(target: string) {
  const uri = vscode.Uri.file(target)
  try {
    await vscode.workspace.fs.readFile(uri)
    return true
  } catch {
    // Fall through: the target may be a directory or may not exist.
  }
  try {
    await vscode.workspace.fs.readDirectory(uri)
    return true
  } catch {
    return false
  }
}

async function workspacePathKind(target: string): Promise<"file" | "directory" | "missing"> {
  const uri = vscode.Uri.file(target)
  try {
    await vscode.workspace.fs.readFile(uri)
    return "file"
  } catch {
    // Fall through: the target may be a directory or may not exist.
  }
  try {
    await vscode.workspace.fs.readDirectory(uri)
    return "directory"
  } catch {
    return "missing"
  }
}

function validateCreateFileTarget(target: string, originalPath: string) {
  if (!isWithinWorkspace(target)) throw new Error(`Create file path is outside the current workspace: ${originalPath}`)
  const relativePath = workspaceRelativePath(target)
  if (/[\\/]$/.test(originalPath.trim())) throw new Error("Create file path must include a filename, not end with a directory separator.")
  if (relativePath === "." || !nodePath.basename(target)) throw new Error("Create file path must point to a new file, not the workspace root.")
  const normalized = normalizePath(target)
  const basename = normalized.split("/").pop()?.toLowerCase() ?? ""
  if (SENSITIVE_CREATE_FILE_NAMES.has(basename) || /(?:^|\/)\.(?:git|ssh)(?:\/|$)/.test(normalized)) {
    throw new Error(`Create file path is blocked because it targets a sensitive path: ${relativePath}`)
  }
}

function validateEditFileTarget(target: string, originalPath: string) {
  if (originalPath.includes("\0")) throw new Error("Edit file path contains a NUL byte.")
  if (!isWithinWorkspace(target)) throw new Error(`Edit file path is outside the current workspace: ${originalPath}`)
  const relativePath = workspaceRelativePath(target)
  if (/[\\/]$/.test(originalPath.trim())) throw new Error("Edit file path must include a filename, not end with a directory separator.")
  if (relativePath === "." || !nodePath.basename(target)) throw new Error("Edit file path must point to an existing file, not the workspace root.")
  const normalized = normalizePath(target)
  const basename = normalized.split("/").pop()?.toLowerCase() ?? ""
  if (SENSITIVE_CREATE_FILE_NAMES.has(basename) || /(?:^|\/)\.(?:git|ssh)(?:\/|$)/.test(normalized)) {
    throw new Error(`Edit file path is blocked because it targets a sensitive path: ${relativePath}`)
  }
}

function normalizeCreateDirectoryPathInput(input: string) {
  return normalizePath(input).replace(/\/+$/g, "")
}

function validateCreateDirectoryTarget(target: string, originalPath: string) {
  if (originalPath.includes("\0")) throw new Error("Create folder path contains a NUL byte.")
  if (!isWithinWorkspace(target)) throw new Error(`Create folder path is outside the current workspace: ${originalPath}`)
  const relativePath = workspaceRelativePath(target)
  if (relativePath === "." || !nodePath.basename(target)) throw new Error("Create folder path must point to a new directory, not the workspace root.")
  const originalSegments = normalizePath(originalPath).split("/").filter(Boolean)
  if (originalSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Create folder path contains an unsupported path segment: ${relativePath}`)
  }
  const normalized = normalizePath(target)
  const segments = normalized.split("/").filter(Boolean).map((segment) => segment.toLowerCase())
  if (segments.some((segment) => SENSITIVE_CREATE_FILE_NAMES.has(segment)) || /(?:^|\/)\.(?:git|ssh)(?:\/|$)/.test(normalized)) {
    throw new Error(`Create folder path is blocked because it targets a sensitive path: ${relativePath}`)
  }
}

function validateCreateFileContent(content: string) {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > MAX_CREATE_FILE_BYTES) {
    throw new Error(`Create file content is too large: ${bytes} byte(s), maximum ${MAX_CREATE_FILE_BYTES}.`)
  }
  if (content.includes("\0")) throw new Error("Create file content appears to be binary: NUL byte detected.")
  const sample = content.slice(0, 4096)
  let controlCount = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount += 1
  }
  if (controlCount >= 16 || (sample.length > 0 && controlCount / sample.length > 0.02)) {
    throw new Error("Create file content appears to be binary or non-text.")
  }
  return bytes
}

function validateEditStrings(oldString: string, newString: string) {
  if (oldString.length === 0) throw new Error("oldString must not be empty.")
  if (oldString === newString) throw new Error("No changes to apply: oldString and newString are identical.")
  validateTextContent(oldString, "oldString", MAX_EDIT_TEXT_BYTES)
  validateTextContent(newString, "newString", MAX_EDIT_TEXT_BYTES)
}

function validateTextContent(content: string, label: string, maxBytes: number) {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > maxBytes) throw new Error(`${label} is too large: ${bytes} byte(s), maximum ${maxBytes}.`)
  if (content.includes("\0")) throw new Error(`${label} appears to be binary: NUL byte detected.`)
  const sample = content.slice(0, 4096)
  let controlCount = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount += 1
  }
  if (controlCount >= 16 || (sample.length > 0 && controlCount / sample.length > 0.02)) {
    throw new Error(`${label} appears to be binary or non-text.`)
  }
  return bytes
}

async function readEditableTextFile(target: string) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
  if (bytes.length > MAX_EDIT_FILE_BYTES) {
    throw new Error(`Edit file target is too large: ${bytes.length} byte(s), maximum ${MAX_EDIT_FILE_BYTES}.`)
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("Edit file target is not valid UTF-8 text.")
  }
  validateTextContent(text, "Edit file target content", MAX_EDIT_FILE_BYTES)
  return { bytes, text }
}

function exactReplacementPreview(source: string, oldInput: string, newInput: string, replaceAll: boolean):
  | { ok: true; oldString: string; newString: string; replacements: number }
  | { ok: false; message: string } {
  const ending = detectLineEnding(source)
  const oldString = convertToLineEnding(oldInput, ending)
  const newString = convertToLineEnding(newInput, ending)
  if (oldString === newString) {
    return { ok: false, message: "No changes to apply: oldString and newString are identical." }
  }
  const replacements = countOccurrences(source, oldString)
  if (replacements === 0) {
    return { ok: false, message: "Could not find oldString in the file. It must match exactly, including whitespace and indentation." }
  }
  if (replacements > 1 && !replaceAll) {
    return { ok: false, message: "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true." }
  }
  return { ok: true, oldString, newString, replacements }
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  const normalized = text.replace(/\r\n/g, "\n")
  return ending === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized
}

function countOccurrences(content: string, search: string) {
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1
    offset += search.length
  }
  return count
}

function replaceFirstExact(content: string, search: string, replacement: string) {
  const index = content.indexOf(search)
  if (index === -1) return content
  return `${content.slice(0, index)}${replacement}${content.slice(index + search.length)}`
}

async function readTextFileIfSmall(path: string, maxBytes: number) {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path))
  if (bytes.length > maxBytes) return ""
  const text = new TextDecoder().decode(bytes)
  if (text.includes("\0")) return ""
  return text
}

async function readWorkspaceFileSlice(input: { path: string; startLine: number; endLine: number; maxBytes: number }) {
  const target = resolveWorkspacePath(input.path)
  if (!isWithinWorkspace(target)) throw new Error(`Evidence path is outside the current workspace: ${input.path}`)
  const text = await readTextFileIfSmall(target, Math.max(input.maxBytes * 2, input.maxBytes))
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const before = Math.max(1, input.startLine - 8)
  const after = Math.min(lines.length, input.endLine + 8)
  return truncateBytes(lines.slice(before - 1, after).join("\n"), input.maxBytes)
}

function textMatcher(query: string) {
  if (query.startsWith("/") && query.endsWith("/") && query.length > 2) {
    try {
      const pattern = new RegExp(query.slice(1, -1), "i")
      return (line: string) => pattern.test(line)
    } catch {
      // Fall through to literal matching if the user supplied an invalid regex.
    }
  }
  const lower = query.toLowerCase()
  return (line: string) => line.toLowerCase().includes(lower)
}

function matchesGlob(path: string, pattern: string) {
  const normalizedPath = normalizePath(path)
  const normalizedPattern = normalizePath(pattern)
  if (!normalizedPattern || normalizedPattern === "*") return true
  if (!/[?*]/.test(normalizedPattern)) return normalizedPath.endsWith(normalizedPattern)
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*")
  return new RegExp(`(^|/)${escaped}$`).test(normalizedPath)
}

function evidenceRef(file: string, startLine: number, endLine: number, snippet: string, parserKind: string): EvidenceRef {
  return {
    file,
    startLine,
    endLine,
    snippet,
    parserKind,
    snippetHash: hashText(snippet),
  }
}

function documentEvidenceFromText(text: string): EvidenceRef[] {
  const refs: EvidenceRef[] = []
  const regex = /<evidence\s+([^>]*)>([\s\S]*?)<\/evidence>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text))) {
    const attrs = xmlAttributes(match[1] ?? "")
    const path = attrs.path
    if (!path) continue
    const [start, end] = (attrs.lines ?? "1-1").split("-").map((value) => Math.max(1, Number.parseInt(value, 10) || 1))
    refs.push(evidenceRef(path, start, end || start, xmlUnescape(match[2] ?? "").trim(), `document-rag:${attrs.kind ?? "document"}`))
  }
  return refs
}

function dedupeEvidenceRefs(refs: EvidenceRef[]) {
  const seen = new Set<string>()
  const result: EvidenceRef[] = []
  for (const ref of refs) {
    const key = `${ref.file}:${ref.startLine}:${ref.endLine}:${ref.parserKind}:${ref.snippetHash}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(ref)
  }
  return result
}

function xmlAttributes(input: string) {
  const attrs: Record<string, string> = {}
  const regex = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input))) attrs[match[1]!] = xmlUnescape(match[2] ?? "")
  return attrs
}

function xmlUnescape(input: string) {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function callChainView(source: string, target: string, data: unknown) {
  const record = data && typeof data === "object" ? data as { evidence?: unknown; mode?: unknown; symbols?: unknown; truncated?: unknown; omittedCandidates?: unknown } : {}
  const evidence = Array.isArray(record.evidence) ? record.evidence : []
  return {
    source,
    target,
    mode: record.mode,
    symbols: record.symbols,
    paths: evidence.length ? [{ confidence: "bounded", steps: evidence }] : [],
    ambiguousSymbols: [],
    unresolvedCalls: [],
    omittedCandidates: record.omittedCandidates,
    truncated: Boolean(record.truncated),
  }
}

function isCodeRagReady(codeGraph: Pick<CodeGraphContextProvider, "status">) {
  const rag = codeGraph.status().rag
  const pending = rag?.pendingChunkCount ?? Math.max(0, (rag?.chunks ?? 0) - (rag?.embeddedChunks ?? 0))
  return Boolean(rag?.enabled && rag.embeddingEnabled && rag.availability === "ready" && rag.indexAvailability === "ready" && (rag.chunks ?? 0) > 0 && pending === 0)
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = stringArg(args[key])
  if (!value.trim()) throw new Error(`Missing required argument: ${key}`)
  return value.trim()
}

function requiredStringValue(args: Record<string, unknown>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(args, key) || typeof args[key] !== "string") {
    throw new Error(`Missing required argument: ${key}`)
  }
  return args[key] as string
}

function booleanArg(input: unknown) {
  return input === true || input === "true"
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/")
}

function hashText(input = "") {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function runShell(command: string, cwd: string, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh"
    const args = process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["-lc", command]
    const child = spawn(shell, args, { cwd, shell: false })
    let output = ""
    const onAbort = () => {
      child.kill()
      reject(new Error("Command aborted."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort)
      resolve(`${output}${code === 0 ? "" : `\n[exit code ${code ?? "unknown"}]`}`)
    })
  })
}

function runProcess(input: {
  command: string
  args: string[]
  cwd: string
  stdin: string
  timeoutMs: number
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env,
    })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString()
      const maxOutputBytes = input.maxOutputBytes ?? MAX_READ_TEXT_BYTES
      if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) return next
      truncated = true
      return truncateBytes(next, maxOutputBytes)
    }
    const cleanup = () => {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      child.kill()
      cleanup()
      reject(new Error("Command aborted."))
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, input.timeoutMs)
    input.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on("error", (error) => {
      cleanup()
      reject(error)
    })
    child.on("close", (code) => {
      cleanup()
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : code ?? 0,
        timedOut,
        truncated,
      })
    })
    child.stdin.end(input.stdin)
  })
}

function resolveWorkspacePath(input: string) {
  if (!input) return workspaceRoot()
  const uri = vscode.Uri.file(input)
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(input)) return uri.fsPath
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), ...input.split(/[\\/]/)).fsPath
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function stringArg(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberFromArg(input: unknown) {
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (typeof input === "string" && input.trim()) {
    const value = Number(input)
    if (Number.isFinite(value)) return value
  }
  return undefined
}

function tableIndexFromLocator(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  return numberFromArg((input as Record<string, unknown>).tableIndex)
}

function wordRunFormattingKindsArg(input: unknown): WordRunFormattingKind[] {
  if (!Array.isArray(input)) return []
  const allowed = new Set<WordRunFormattingKind>(["font", "bold", "italic", "underline", "color", "size"])
  return [...new Set(input.filter((item): item is WordRunFormattingKind => typeof item === "string" && allowed.has(item as WordRunFormattingKind)))]
}

function stringListArg(input: unknown) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
}

function truncateString(input: string, maxLength: number) {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}...`
}

function sanitizeArtifactName(input: string) {
  return input
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "artifact"
}

function truncateBytes(input: string, maxBytes: number) {
  const bytes = Buffer.from(input, "utf8")
  if (bytes.length <= maxBytes) return input
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`
}

function isFileNotFoundError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  if (code === "ENOENT" || code === "FileNotFound") return true
  return /(?:ENOENT|FileNotFound|EntryNotFound|does not exist|no such file|nonexistent file)/i.test(formatErrorMessage(error))
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
