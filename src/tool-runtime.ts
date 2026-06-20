import { spawn } from "node:child_process"
import * as vscode from "vscode"
import type { AnalysisToolName, AnalysisToolResult, EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import { AuditLog } from "./audit-log"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { DocumentRagContextProvider } from "./document-rag"
import { parseSupportedDocument } from "./document-parser"
import { decidePermission, type PermissionDecision, type ToolRequest } from "./permissions"
import type { PermissionMode, RemoteSettings } from "./types"

export type ToolRuntimeInput = {
  sessionID?: string
  mode: PermissionMode
  name: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}

export type ToolRuntimeResult = {
  title: string
  output: string
  approved: boolean
  status?: "completed" | "failed" | "blocked" | "approval-required"
  error?: string
  requiresApproval?: boolean
  risk?: string
}

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TEXT_SEARCH_FILES = 800
const MAX_TEXT_SEARCH_RESULTS = 80
const MAX_LIST_FILES = 200
const MAX_EVIDENCE_SNIPPET_BYTES = 8 * 1024
const MAX_READ_TEXT_BYTES = 48 * 1024
const DEFAULT_SESSION_ID = "__default__"

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
      case "chipmate_search_documents":
        return this.executeReadOnly(input, "Search Document RAG", () => this.searchDocuments(input))
      case "chipmate_read_evidence":
        return this.executeReadOnly(input, "Read evidence", () => this.readEvidence(input))
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
      .filter((item) => item.kind === "file" && /\.(?:docx|xlsx|xlsm|pdf)$/i.test(item.path))
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
      const approveLabel = "批准一次"
      const picked = await vscode.window.showWarningMessage(
        `ChipMate 请求执行：${request.title}`,
        {
          modal: true,
          detail: `${request.summary}\n\n风险等级：${decision.risk}\n原因：${decision.reason}`,
        },
        approveLabel,
        "拒绝",
      )
      decision = picked === approveLabel
        ? { ...decision, approved: true, requiresApproval: false, reason: `user approved once; ${decision.reason}` }
        : { ...decision, approved: false, reason: `user denied approval; ${decision.reason}` }
    }
    await this.auditDecision(input, decision, detail)
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

function workspaceRelativePath(input: string) {
  const normalized = normalizePath(input)
  const root = normalizePath(workspaceRoot()).replace(/\/+$/, "")
  if (normalized === root) return "."
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return normalized
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
