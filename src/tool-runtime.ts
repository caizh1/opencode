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
import { createWordDocument } from "./tools/createWordDocumentTool"
import { readDocx } from "./tools/readDocxTool"
import { decidePermission, type PermissionDecision, type ToolRequest } from "./permissions"
import type { ActiveSkillPolicy } from "./skills"
import type { PermissionMode, RemoteSettings } from "./types"

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

export type ToolRuntimeInput = {
  sessionID?: string
  mode: PermissionMode
  name: string
  arguments: Record<string, unknown>
  activeSkills?: ActiveSkillPolicy[]
  signal?: AbortSignal
  approve?: ToolApprovalHandler
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
      kind: "clarification"
      payload: ClarificationRequest
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
      case "chipmate_read":
        return this.readFile(input)
      case "chipmate_read_skill_resource":
        return this.readSkillResource(input)
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
      case "chipmate_ask_user_clarification":
        return this.askUserClarification(input)
      case "chipmate_validate_diagram_ir":
        return this.validateDiagramIrTool(input)
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
          description: "Use when an active ChipMate skill lists a references/, assets/, or scripts/ resource that you need to read. Do not use for ordinary workspace files, and do not execute scripts. Returns bounded UTF-8 resource text from the active skill directory.",
          parameters: objectSchema({
            skill: { type: "string", description: "Active skill name or id." },
            path: { type: "string", description: "Skill-root relative resource path, such as references/guide.md." },
          }, ["skill", "path"]),
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
            diagramIr: { type: "object", description: "DiagramIR v1 with title, diagramType, composition, nodes, edges, regions, containers, lanes, buses, ports, arrays, evidenceRefs, layoutHints, styleHints, semanticHints, sourceArtifacts, and referenceDiagrams. The model/skill chooses diagramType from user intent; code-backed business process diagrams should remain business-flow, not code-flow, unless the user asks for entry/function/branch execution detail. Treat regions/containers/lanes/groups as ownership areas, not execution steps: assign child nodes with parent/container/lane/region/group, or mark intentional empty areas with allowEmpty/placeholder. For business-flow/code-flow embedded FSM diagrams, ownership areas render as weak background bands by default so edges stay readable; use containerMode='strong' only for true compound structure. Use semanticHints.domain, primaryPerspective, containsStateMachines, stateMachineCount, and processPhases for embedded FSM/process diagrams. Use composition.mode=single by default; only use multi when the user or active skill explicitly asks for or allows multiple diagrams.", additionalProperties: true },
          }, ["diagramIr"]),
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
            diagramIr: { type: "object", description: "Optional DiagramIR v1. Use this for evidence-backed or skill-orchestrated diagrams; the Design Compiler converts semantic nodes/edges/regions/buses/ports plus layoutHints/styleHints/semanticHints into a readable VisualPlan before drawing. For embedded module flows with FSM states/events, keep diagramType at the user intent layer and provide semanticHints plus visualRole/edgeKind/pathRole so the compiler can select its internal embedded-fsm-flow profile. Containers/regions/lanes/groups are ownership areas; assign owned nodes with parent/container/lane/region/group. In embedded FSM business/code flows they render as weak background bands by default; set containerMode='strong' only for true compound structural nesting, and mark intentional empty regions allowEmpty/placeholder.", additionalProperties: true },
            ir: { type: "object", description: "Alias for diagramIr.", additionalProperties: true },
            nodes: { type: "array", description: "Core nodes. Each item may include id, label/text, shape/type, parent/group/container/lane/layer, visualRole such as module/phase/state/action/decision/event/evidence-note, importance, textParts, geometry, style, and drawioStyle. Use parent/container/lane/region/group to declare ownership; embedded FSM flows render that ownership as weak background bands unless the container is explicitly strong.", items: { type: "object", additionalProperties: true } },
            edges: { type: "array", description: "Core edges. Each item may include id, label/text, source/from, target/to, edgeKind such as control/transition/event/data/error/bus, pathRole such as primary/local-transition/cross-module/feedback/exception/secondary, labelPriority, parent/layer, points, style, and drawioStyle.", items: { type: "object", additionalProperties: true } },
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
          description: "Use when a complete generic WordDocSpec is ready and a .docx report should be generated. Do not use as a generic file writer or for non-docx output. Returns the generated .docx path, source count, warnings, and render quality status.",
          parameters: objectSchema({
            filename: { type: "string", description: "Suggested output filename; it will be sanitized and written under .chipmate/docs." },
            spec: { type: "object", description: "Generic WordDocSpec containing metadata, sources, sections, references, and optional rule cards." },
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
    const spec = input.arguments.spec
    if (!spec || typeof spec !== "object") {
      return failed("Create Word document", "Missing or invalid WordDocSpec.", "Missing or invalid WordDocSpec.", decision.risk)
    }
    try {
      const result = await createWordDocument({
        spec: spec as never,
        filename,
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

function normalizeSkillResourcePath(input: string) {
  return input.trim().replace(/\\/g, "/").replace(/^\/+/g, "").replace(/\/+/g, "/")
}

function isAllowedSkillResourcePath(input: string) {
  if (!input || /^(?:[A-Za-z]:|\/)/.test(input)) return false
  const segments = input.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false
  return segments[0] === "references" || segments[0] === "assets" || segments[0] === "scripts"
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

function truncateString(input: string, maxLength: number) {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}...`
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
