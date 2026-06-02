import { ensureDerivedIndex, moduleKey } from "./codegraph-index"
import { classifyQuestion, retrieveEvidence, retrieveHybridEvidence } from "./codegraph-query"
import type {
  CodeGraphEvidence,
  CodeGraphFile,
  CodeGraphFunction,
  CodeGraphIndex,
  CodeGraphQueryMode,
  CodeGraphSymbol,
} from "./codegraph-types"
import {
  evidenceFromCodeGraph,
  hashSnippet,
  type AnalysisBudget,
  type AnalysisQueryTrace,
  type AnalysisQueryTraceStep,
  type AnalysisSummaries,
  type AnalysisToolAuditEntry,
  type AnalysisToolName,
  type AnalysisToolPolicy,
  type AnalysisToolResult,
  type AnswerPolicyResult,
  type CodeIntelligenceSnapshot,
  type EvidencePack,
  type EvidenceRef,
  type FileSummary,
  type FunctionSummary,
  type ModuleSummary,
  type QueryEvidenceResult,
  type StateMachine,
  type SubsystemSummary,
} from "./analysis-types"
import { extractStateMachines, findStatePath, stateMachineToTransitionTable } from "./state-machine-extractor"
import type { HybridRetrievalOptions } from "./rag-types"
import type { RagStatus } from "./types"

export const DEFAULT_ANALYSIS_BUDGET: AnalysisBudget = {
  maxEvidenceItems: 40,
  maxEvidenceBytes: 60000,
  maxFileSliceBytes: 16000,
  maxGraphEdges: 120,
  maxPaths: 10,
}

export const DEFAULT_ANALYSIS_TOOL_POLICY: AnalysisToolPolicy = {
  allowedTools: [
    "search",
    "getFileSlice",
    "getSymbol",
    "getCallers",
    "getCallees",
    "getCallChain",
    "getModuleMap",
    "getStateMachines",
    "getStatePath",
    "queryEvidence",
  ],
  blockedTools: ["webfetch", "websearch"],
  edit: "deny",
  bash: "deny",
  read: "deny",
  mode: "context-only",
}

export type RunAnalysisToolInput = {
  index: CodeGraphIndex
  tool: AnalysisToolName
  args?: Record<string, unknown>
  budget?: Partial<AnalysisBudget>
  policy?: Partial<AnalysisToolPolicy>
  readFileSlice?: (input: { path: string; startLine?: number; endLine?: number; maxBytes: number }) => Promise<string>
  hybrid?: HybridRetrievalOptions
}

type GraphMaps = {
  files: CodeGraphFile[]
  functions: CodeGraphFunction[]
  symbols: CodeGraphSymbol[]
  functionById: Map<string, CodeGraphFunction>
  functionsByName: Map<string, CodeGraphFunction[]>
  fileByPath: Map<string, CodeGraphFile>
}

export function buildCodeIntelligenceSnapshot(index: CodeGraphIndex, lastTrace?: AnalysisQueryTrace, lastAudit: AnalysisToolAuditEntry[] = [], rag?: RagStatus): CodeIntelligenceSnapshot {
  const stateMachines = extractStateMachines(index)
  const summaries = buildAnalysisSummaries(index, stateMachines)
  const ragStatus = rag?.embeddingEnabled
    ? `, RAG ${rag.embeddedChunks}/${rag.chunks} chunk(s), ${rag.vectorShards} vector shard(s)${rag.fallbackReason ? `, fallback ${rag.fallbackReason}` : ""}`
    : ", RAG fallback BM25/graph/state-machine"
  return {
    status: `ready: ${Object.keys(index.files).length} file(s), ${summaries.functions.length} function(s), ${stateMachines.length} state machine(s)${ragStatus}`,
    modules: summaries.modules,
    files: summaries.files,
    functions: summaries.functions,
    stateMachines,
    lastTrace,
    lastAudit,
  }
}

export async function runAnalysisTool(input: RunAnalysisToolInput): Promise<AnalysisToolResult> {
  const started = Date.now()
  const budget = { ...DEFAULT_ANALYSIS_BUDGET, ...input.budget }
  const policy = { ...DEFAULT_ANALYSIS_TOOL_POLICY, ...input.policy }
  const traceId = createTraceId()
  const args = input.args ?? {}
  const blockedReason = guardTool(input.tool, policy)
  if (blockedReason) {
    return toolResult({
      ok: false,
      traceId,
      tool: input.tool,
      elapsedMs: Date.now() - started,
      error: blockedReason,
      evidence: [],
      audit: audit(traceId, input.tool, args, 0, Date.now() - started, true, blockedReason),
    })
  }

  try {
    switch (input.tool) {
      case "search": {
        const question = stringArg(args, "query") || stringArg(args, "question") || ""
        const result = retrieveEvidence({
          index: input.index,
          question,
          maxBytes: budget.maxEvidenceBytes,
          maxDepth: numberArg(args, "maxDepth") ?? 3,
          maxFanout: numberArg(args, "maxFanout") ?? 40,
        })
        const evidence = packEvidenceRefs(result?.evidence.map(evidenceFromCodeGraph) ?? [], budget)
        return toolResult({
          ok: true,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: result,
          evidence: evidence.evidence,
          audit: audit(traceId, input.tool, args, evidence.evidence.length, Date.now() - started, false),
          truncated: evidence.truncated,
          omittedEvidence: evidence.omittedEvidence,
        })
      }
      case "getFileSlice": {
        const path = requiredString(args, "path")
        const text = input.readFileSlice
          ? await input.readFileSlice({
              path,
              startLine: numberArg(args, "startLine"),
              endLine: numberArg(args, "endLine"),
              maxBytes: budget.maxFileSliceBytes,
            })
          : fallbackFileSlice(input.index, path, numberArg(args, "startLine"), numberArg(args, "endLine"), budget.maxFileSliceBytes)
        const evidence = text
          ? [evidenceRef(path, numberArg(args, "startLine") ?? 1, numberArg(args, "endLine") ?? Math.max(1, text.split(/\r?\n/).length), text, "file-slice")]
          : []
        return toolResult({
          ok: Boolean(text),
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: { path, text },
          evidence,
          error: text ? undefined : `No file slice available for ${path}.`,
          audit: audit(traceId, input.tool, args, evidence.length, Date.now() - started, false),
        })
      }
      case "getSymbol": {
        const name = requiredString(args, "name")
        const symbols = getSymbols(input.index, name).slice(0, budget.maxEvidenceItems)
        const evidence = symbols.map((symbol) => evidenceRef(symbol.path, symbol.startLine, symbol.endLine, symbol.snippet, `symbol:${symbol.kind}`))
        return toolResult({
          ok: symbols.length > 0,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: symbols,
          evidence,
          error: symbols.length ? undefined : `Symbol ${name} was not found.`,
          audit: audit(traceId, input.tool, args, evidence.length, Date.now() - started, false),
        })
      }
      case "getCallers":
      case "getCallees":
      case "getCallChain": {
        const symbol = requiredString(args, "symbol")
        const target = stringArg(args, "target")
        const question = input.tool === "getCallers"
          ? `who calls ${symbol}`
          : input.tool === "getCallees"
            ? `what does ${symbol} call`
            : `show call chain from ${symbol} to ${target ?? ""}`
        const result = retrieveEvidence({
          index: input.index,
          question,
          maxBytes: budget.maxEvidenceBytes,
          maxDepth: numberArg(args, "maxDepth") ?? 5,
          maxFanout: Math.min(budget.maxGraphEdges, numberArg(args, "maxFanout") ?? 80),
        })
        const packed = packEvidenceRefs(result?.evidence.map(evidenceFromCodeGraph) ?? [], budget)
        return toolResult({
          ok: Boolean(result?.evidence.length),
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: result,
          evidence: packed.evidence,
          audit: audit(traceId, input.tool, args, packed.evidence.length, Date.now() - started, false),
          truncated: packed.truncated,
          omittedEvidence: packed.omittedEvidence,
        })
      }
      case "getModuleMap": {
        const stateMachines = extractStateMachines(input.index)
        const summaries = buildAnalysisSummaries(input.index, stateMachines)
        const modules = summaries.modules.slice(0, budget.maxEvidenceItems)
        return toolResult({
          ok: true,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: modules,
          evidence: modules.flatMap((item) => item.evidence).slice(0, budget.maxEvidenceItems),
          audit: audit(traceId, input.tool, args, modules.length, Date.now() - started, false),
        })
      }
      case "getStateMachines": {
        const machines = extractStateMachines(input.index, { maxTransitions: budget.maxGraphEdges })
        const filter = stringArg(args, "query")?.toLowerCase()
        const selected = filter
          ? machines.filter((machine) => `${machine.name} ${machine.module} ${machine.stateVar}`.toLowerCase().includes(filter))
          : machines
        return toolResult({
          ok: selected.length > 0,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: selected.map((machine) => ({
            ...machine,
            transitionTable: stateMachineToTransitionTable(machine),
          })),
          evidence: selected.flatMap((machine) => machine.evidence).slice(0, budget.maxEvidenceItems),
          audit: audit(traceId, input.tool, args, selected.length, Date.now() - started, false),
        })
      }
      case "getStatePath": {
        const machines = extractStateMachines(input.index, { maxTransitions: budget.maxGraphEdges })
        const machineId = stringArg(args, "machineId")
        const source = requiredString(args, "source")
        const target = requiredString(args, "target")
        const machine = machineId ? machines.find((item) => item.id === machineId) : machines[0]
        const paths = machine ? findStatePath(machine, source, target, budget.maxPaths) : []
        return toolResult({
          ok: paths.length > 0,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: { machineId: machine?.id, paths },
          evidence: paths.flatMap((path) => path.transitions.map((transition) => transition.evidence)).slice(0, budget.maxEvidenceItems),
          error: paths.length ? undefined : `No state path found from ${source} to ${target}.`,
          audit: audit(traceId, input.tool, args, paths.length, Date.now() - started, false),
        })
      }
      case "queryEvidence": {
        const question = requiredString(args, "question")
        const result = input.hybrid
          ? await queryEvidenceAsync(input.index, question, budget, input.hybrid)
          : queryEvidence(input.index, question, budget)
        return toolResult({
          ok: result.answerPolicy.allowed,
          traceId,
          tool: input.tool,
          elapsedMs: Date.now() - started,
          data: result,
          evidence: result.evidencePack.evidence,
          error: result.answerPolicy.allowed ? undefined : result.answerPolicy.reason,
          audit: audit(traceId, input.tool, args, result.evidencePack.evidence.length, Date.now() - started, false),
          truncated: result.evidencePack.truncated,
          omittedEvidence: result.evidencePack.omittedEvidence,
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolResult({
      ok: false,
      traceId,
      tool: input.tool,
      elapsedMs: Date.now() - started,
      error: message,
      evidence: [],
      audit: audit(traceId, input.tool, args, 0, Date.now() - started, false, message),
    })
  }
}

export function queryEvidence(index: CodeGraphIndex, question: string, budget: AnalysisBudget = DEFAULT_ANALYSIS_BUDGET): QueryEvidenceResult {
  const traceId = createTraceId()
  const steps: AnalysisQueryTraceStep[] = []
  const started = Date.now()
  const mode = queryIntent(question)
  steps.push({ label: "intent", detail: mode, elapsedMs: 0 })

  const retrievalStarted = Date.now()
  const retrieval = retrieveEvidence({
    index,
    question,
    maxBytes: budget.maxEvidenceBytes,
    maxDepth: 4,
    maxFanout: Math.min(80, budget.maxGraphEdges),
  })
  steps.push({ label: "retrieval", detail: `${retrieval?.evidence.length ?? 0} evidence item(s)`, elapsedMs: Date.now() - retrievalStarted })

  const smStarted = Date.now()
  const stateMachines = selectRelevantStateMachines(extractStateMachines(index, { maxTransitions: budget.maxGraphEdges }), question)
  steps.push({ label: "state-machine", detail: `${stateMachines.length} machine(s)`, elapsedMs: Date.now() - smStarted })

  const summaryStarted = Date.now()
  const summaries = buildAnalysisSummaries(index, stateMachines)
  steps.push({ label: "summaries", detail: `${summaries.modules.length} module summary item(s)`, elapsedMs: Date.now() - summaryStarted })

  const evidence = [
    ...(retrieval?.evidence.map(evidenceFromCodeGraph) ?? []),
    ...stateMachines.flatMap((machine) => machine.evidence),
    ...selectedSummaryEvidence(summaries, question),
  ]
  const evidencePack = packEvidenceRefs(evidence, budget, evidence.length === 0 ? ["No local code evidence matched the question."] : [])
  const answerPolicy = evaluateAnswerPolicy(question, evidencePack)
  const trace: AnalysisQueryTrace = {
    traceId,
    question,
    intent: mode,
    steps: [...steps, { label: "evidence-pack", detail: `${evidencePack.evidence.length} packed item(s)`, elapsedMs: Date.now() - started }],
    evidence: evidencePack.evidence,
    missingEvidence: evidencePack.missingEvidence,
  }
  return {
    retrieval,
    stateMachines,
    summaries,
    evidencePack,
    trace,
    answerPolicy,
    suggestedAnswer: buildSuggestedAnswer(question, retrieval?.mode, summaries, stateMachines, evidencePack, answerPolicy),
  }
}

export async function queryEvidenceAsync(
  index: CodeGraphIndex,
  question: string,
  budget: AnalysisBudget = DEFAULT_ANALYSIS_BUDGET,
  hybrid?: HybridRetrievalOptions,
): Promise<QueryEvidenceResult> {
  if (!hybrid) return queryEvidence(index, question, budget)
  const traceId = createTraceId()
  const steps: AnalysisQueryTraceStep[] = []
  const started = Date.now()
  const mode = queryIntent(question)
  steps.push({ label: "intent", detail: mode, elapsedMs: 0 })

  const retrievalStarted = Date.now()
  const retrieval = await retrieveHybridEvidence({
    index,
    question,
    maxBytes: budget.maxEvidenceBytes,
    maxDepth: 4,
    maxFanout: Math.min(80, budget.maxGraphEdges),
    hybrid,
  })
  steps.push({ label: "hybrid-retrieval", detail: `${retrieval?.evidence.length ?? 0} evidence item(s)`, elapsedMs: Date.now() - retrievalStarted })
  for (const step of retrieval?.trace ?? []) {
    steps.push({ label: step.label, detail: step.detail, elapsedMs: step.elapsedMs })
  }

  const smStarted = Date.now()
  const stateMachines = selectRelevantStateMachines(extractStateMachines(index, { maxTransitions: budget.maxGraphEdges }), question)
  steps.push({ label: "state-machine", detail: `${stateMachines.length} machine(s)`, elapsedMs: Date.now() - smStarted })

  const summaryStarted = Date.now()
  const summaries = buildAnalysisSummaries(index, stateMachines)
  steps.push({ label: "summaries", detail: `${summaries.modules.length} module summary item(s)`, elapsedMs: Date.now() - summaryStarted })

  const evidence = [
    ...(retrieval?.evidence.map(evidenceFromCodeGraph) ?? []),
    ...stateMachines.flatMap((machine) => machine.evidence),
    ...selectedSummaryEvidence(summaries, question),
  ]
  const evidencePack = packEvidenceRefs(evidence, budget, evidence.length === 0 ? ["No local code evidence matched the question."] : [])
  const answerPolicy = evaluateAnswerPolicy(question, evidencePack)
  const trace: AnalysisQueryTrace = {
    traceId,
    question,
    intent: mode,
    steps: [...steps, { label: "evidence-pack", detail: `${evidencePack.evidence.length} packed item(s)`, elapsedMs: Date.now() - started }],
    evidence: evidencePack.evidence,
    missingEvidence: evidencePack.missingEvidence,
  }
  return {
    retrieval,
    stateMachines,
    summaries,
    evidencePack,
    trace,
    answerPolicy,
    suggestedAnswer: buildSuggestedAnswer(question, retrieval?.mode, summaries, stateMachines, evidencePack, answerPolicy),
  }
}

export function buildAnalysisSummaries(index: CodeGraphIndex, stateMachines = extractStateMachines(index)): AnalysisSummaries {
  const maps = buildMaps(index)
  const functions = maps.functions.map((fn) => functionSummary(fn, stateMachines))
  const files = maps.files.map((file) => fileSummary(file, functions, stateMachines))
  const modules = moduleSummaries(files, functions, stateMachines)
  const subsystems = subsystemSummaries(modules, stateMachines)
  return { functions, files, modules, subsystems }
}

export function packEvidenceRefs(values: EvidenceRef[], budget: AnalysisBudget = DEFAULT_ANALYSIS_BUDGET, missingEvidence: string[] = []): EvidencePack {
  const result: EvidenceRef[] = []
  const seen = new Set<string>()
  let bytes = 0
  let omitted = 0
  for (const value of values) {
    const key = `${value.file}:${value.startLine}:${value.endLine}:${value.snippetHash}`
    if (seen.has(key)) continue
    seen.add(key)
    const formatted = formatEvidence(value)
    const size = Buffer.byteLength(formatted, "utf8")
    if (result.length >= budget.maxEvidenceItems || bytes + size > budget.maxEvidenceBytes) {
      omitted++
      continue
    }
    result.push(value)
    bytes += size
  }
  return {
    evidence: result,
    text: result.map(formatEvidence).join("\n"),
    packedBytes: bytes,
    omittedEvidence: omitted,
    truncated: omitted > 0,
    missingEvidence,
  }
}

export function evaluateAnswerPolicy(question: string, pack: EvidencePack): AnswerPolicyResult {
  if (pack.evidence.length === 0) {
    return {
      allowed: false,
      confidence: "none",
      reason: "No local evidence was found. Refuse or ask for the missing file/symbol/module evidence.",
      requiredCitation: "Every local-code claim must cite file:start-end.",
    }
  }
  const localQuestion = /文件|模块|函数|调用|状态|流程|代码|谁调用|路径|file|module|function|call|state|transition|flow|code/i.test(question)
  const confidence = pack.truncated ? "medium" : pack.evidence.length >= 4 ? "high" : "low"
  return {
    allowed: true,
    confidence: localQuestion ? confidence : "medium",
    reason: pack.truncated ? "Evidence was packed under budget and some candidates were omitted." : "Evidence is available for a grounded answer.",
    requiredCitation: "Cite file:start-end for each concrete claim and state missing evidence instead of guessing.",
  }
}

function buildSuggestedAnswer(
  question: string,
  mode: CodeGraphQueryMode | undefined,
  summaries: AnalysisSummaries,
  stateMachines: StateMachine[],
  pack: EvidencePack,
  policy: AnswerPolicyResult,
) {
  if (!policy.allowed) return `I do not have enough local evidence to answer. Missing: ${pack.missingEvidence.join("; ") || policy.reason}`
  const moduleRows = summaries.modules.slice(0, 3).map((module) => `- Module ${module.module}: ${module.summary}`).join("\n")
  const stateRows = stateMachines.slice(0, 2).map((machine) => `- State machine ${machine.name}: ${machine.transitions.length} transition(s).`).join("\n")
  const citations = pack.evidence.slice(0, 8).map((item) => `${item.file}:${item.startLine}-${item.endLine}`).join(", ")
  return [
    `Grounded answer plan for: ${question}`,
    `Intent: ${mode ?? "module-flow"}. Confidence: ${policy.confidence}.`,
    moduleRows ? `Module flow:\n${moduleRows}` : "",
    stateRows ? `State machines:\n${stateRows}` : "",
    `Evidence: ${citations}`,
    "Use only the cited evidence; call out gaps when a flow, call chain, or state path is not represented.",
  ].filter(Boolean).join("\n")
}

function functionSummary(fn: CodeGraphFunction, machines: StateMachine[]): FunctionSummary {
  const stateMachines = machines.filter((machine) => machine.rootSymbols.includes(fn.id) || machine.transitions.some((transition) => transition.functionId === fn.id))
  const calls = fn.calls.map((call) => call.name)
  const inputs = parametersFromSignature(fn.signature)
  const outputs = returnFromSignature(fn.signature)
  return {
    id: fn.id,
    name: fn.name,
    path: fn.path,
    module: moduleKey(fn.path),
    signature: fn.signature,
    summary: `${fn.name} ${calls.length ? `calls ${calls.slice(0, 5).join(", ")}` : "has no indexed callees"}${stateMachines.length ? " and participates in state transitions" : ""}.`,
    inputs,
    outputs: outputs ? [outputs] : [],
    calls: unique(calls).slice(0, 20),
    stateMachines: stateMachines.map((machine) => machine.id),
    risks: functionRisks(fn),
    evidence: [evidenceRef(fn.path, fn.startLine, fn.endLine, fn.snippet, "function-summary")],
    confidence: 0.78,
  }
}

function fileSummary(file: CodeGraphFile, functionSummaries: FunctionSummary[], machines: StateMachine[]): FileSummary {
  const functions = functionSummaries.filter((item) => item.path === file.path)
  const stateMachines = machines.filter((machine) => machine.evidence.some((item) => item.file === file.path))
  const deps = unique([...file.includes.map((item) => item.target), ...functions.flatMap((item) => item.calls)]).slice(0, 30)
  const coreSymbols = unique([
    ...file.functions.map((item) => item.name),
    ...file.types.map((item) => item.name),
    ...file.macros.map((item) => item.name),
    ...file.globals.map((item) => item.name),
  ]).slice(0, 30)
  return {
    path: file.path,
    module: moduleKey(file.path),
    language: file.language,
    summary: `${file.path} defines ${file.functions.length} function(s), ${file.types.length} type(s), ${file.macros.length} macro(s), and ${file.globals.length} global(s).`,
    coreSymbols,
    inputs: unique(functions.flatMap((item) => item.inputs)).slice(0, 20),
    outputs: unique(functions.flatMap((item) => item.outputs)).slice(0, 20),
    dependencies: deps,
    stateMachines: stateMachines.map((machine) => machine.id),
    risks: fileRisks(file),
    evidence: [evidenceRef(file.path, 1, 1, `${file.path} ${coreSymbols.join(" ")}`, "file-summary")],
    confidence: 0.72,
  }
}

function moduleSummaries(files: FileSummary[], functions: FunctionSummary[], machines: StateMachine[]): ModuleSummary[] {
  const modules = unique(files.map((file) => file.module)).sort()
  return modules.map((module) => {
    const moduleFiles = files.filter((file) => file.module === module)
    const moduleFunctions = functions.filter((fn) => fn.module === module)
    const moduleMachines = machines.filter((machine) => machine.module === module)
    const entrypoints = moduleFunctions.filter((fn) => !fn.name.startsWith("_")).slice(0, 12).map((fn) => fn.name)
    const dependencies = unique(moduleFiles.flatMap((file) => file.dependencies)).slice(0, 24)
    return {
      module,
      summary: `${module} contains ${moduleFiles.length} file(s), ${moduleFunctions.length} function(s), and ${moduleMachines.length} state machine(s).`,
      responsibilities: inferResponsibilities(module, moduleFiles, moduleFunctions),
      submodules: unique(moduleFiles.map((file) => file.path.split("/").slice(0, 3).join("/"))).filter((value) => value !== module).slice(0, 20),
      keyFlows: inferKeyFlows(moduleFunctions, moduleMachines),
      entrypoints,
      dependencies,
      stateMachines: moduleMachines.map((machine) => machine.id),
      risks: unique(moduleFiles.flatMap((file) => file.risks)).slice(0, 12),
      evidence: moduleFiles.flatMap((file) => file.evidence).slice(0, 20),
      confidence: 0.7,
    }
  })
}

function subsystemSummaries(modules: ModuleSummary[], machines: StateMachine[]): SubsystemSummary[] {
  const groups = new Map<string, ModuleSummary[]>()
  for (const module of modules) {
    const key = module.module.split("/")[0] || "."
    const rows = groups.get(key) ?? []
    rows.push(module)
    groups.set(key, rows)
  }
  return [...groups.entries()].map(([name, rows]) => {
    const subsystemMachines = machines.filter((machine) => rows.some((row) => row.module === machine.module))
    return {
      id: `subsystem:${name}`,
      name,
      modules: rows.map((row) => row.module),
      summary: `${name} spans ${rows.length} module(s) with ${subsystemMachines.length} indexed state machine(s).`,
      crossModuleFlows: inferCrossModuleFlows(rows),
      entrypoints: unique(rows.flatMap((row) => row.entrypoints)).slice(0, 20),
      dependencies: unique(rows.flatMap((row) => row.dependencies)).slice(0, 30),
      stateMachines: subsystemMachines.map((machine) => machine.id),
      evidence: rows.flatMap((row) => row.evidence).slice(0, 30),
      confidence: 0.66,
    }
  })
}

function selectedSummaryEvidence(summaries: AnalysisSummaries, question: string) {
  const terms = question.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 1)
  const selected = [
    ...summaries.functions.filter((item) => matchesTerms(`${item.name} ${item.path}`, terms)).flatMap((item) => item.evidence),
    ...summaries.files.filter((item) => matchesTerms(`${item.path} ${item.coreSymbols.join(" ")}`, terms)).flatMap((item) => item.evidence),
    ...summaries.modules.filter((item) => matchesTerms(`${item.module} ${item.entrypoints.join(" ")}`, terms)).flatMap((item) => item.evidence),
    ...summaries.subsystems.filter((item) => matchesTerms(`${item.name} ${item.modules.join(" ")}`, terms)).flatMap((item) => item.evidence),
  ]
  return selected.length > 0 ? selected : summaries.modules.slice(0, 3).flatMap((item) => item.evidence)
}

function selectRelevantStateMachines(machines: StateMachine[], question: string) {
  const lower = question.toLowerCase()
  const stateLike = /状态|切换|路径|state|transition|guard|event|mode|status|phase|stage/i.test(question)
  const matched = machines.filter((machine) =>
    `${machine.name} ${machine.module} ${machine.stateVar} ${machine.states.map((state) => state.name).join(" ")}`.toLowerCase().split(/\s+/).some((part) => part && lower.includes(part)),
  )
  if (matched.length > 0) return matched
  return stateLike ? machines.slice(0, 5) : []
}

function queryIntent(question: string): AnalysisQueryTrace["intent"] {
  if (/状态|切换|state|transition|guard/.test(question)) return "state-machine"
  if (/流程|业务|模块|子模块|workflow|flow|module/.test(question)) return "module-flow"
  return classifyQuestion(question)
}

function buildMaps(index: CodeGraphIndex): GraphMaps {
  const derived = ensureDerivedIndex(index)
  const files = Object.values(index.files)
  const functions = files.flatMap((file) => file.functions)
  const symbols = Object.values(derived.symbolsByName).flat()
  const functionById = new Map<string, CodeGraphFunction>()
  const functionsByName = new Map<string, CodeGraphFunction[]>()
  const fileByPath = new Map<string, CodeGraphFile>()
  for (const file of files) fileByPath.set(file.path, file)
  for (const fn of functions) {
    functionById.set(fn.id, fn)
    const rows = functionsByName.get(fn.name) ?? []
    rows.push(fn)
    functionsByName.set(fn.name, rows)
  }
  return { files, functions, symbols, functionById, functionsByName, fileByPath }
}

function getSymbols(index: CodeGraphIndex, name: string) {
  const derived = ensureDerivedIndex(index)
  return [
    ...(derived.symbolsByName[name.toLowerCase()] ?? []),
    ...Object.values(derived.symbolsByName).flat().filter((symbol) => symbol.name.toLowerCase().includes(name.toLowerCase())),
  ].filter((symbol, index, all) => all.findIndex((candidate) => candidate.id === symbol.id) === index)
}

function fallbackFileSlice(index: CodeGraphIndex, path: string, startLine = 1, endLine?: number, maxBytes = DEFAULT_ANALYSIS_BUDGET.maxFileSliceBytes) {
  const file = index.files[path]
  if (!file) return ""
  const snippets = [
    ...file.functions.filter((fn) => rangesOverlap(fn.startLine, fn.endLine, startLine, endLine ?? startLine)).map((fn) => fn.snippet),
    ...file.types.filter((type) => rangesOverlap(type.startLine, type.endLine, startLine, endLine ?? startLine)).map((type) => type.snippet),
    ...file.macros.filter((macro) => rangesOverlap(macro.line, macro.line, startLine, endLine ?? startLine)).map((macro) => macro.snippet ?? macro.name),
    ...file.globals.filter((global) => rangesOverlap(global.line, global.line, startLine, endLine ?? startLine)).map((global) => global.snippet),
  ]
  return limitText(snippets.join("\n\n") || `${file.path}: no indexed snippet overlaps ${startLine}-${endLine ?? startLine}`, maxBytes).text
}

function inferResponsibilities(module: string, files: FileSummary[], functions: FunctionSummary[]) {
  const words = unique([
    ...module.split(/[\\/._-]+/),
    ...files.flatMap((file) => file.coreSymbols.flatMap(splitIdentifier)),
    ...functions.flatMap((fn) => splitIdentifier(fn.name)),
  ]).filter((word) => word.length > 2)
  return words.slice(0, 8).map((word) => `${word} related code`)
}

function inferKeyFlows(functions: FunctionSummary[], machines: StateMachine[]) {
  const flows = functions
    .filter((fn) => fn.calls.length > 0)
    .slice(0, 8)
    .map((fn) => `${fn.name} -> ${fn.calls.slice(0, 4).join(" -> ")}`)
  flows.push(...machines.slice(0, 4).map((machine) => `${machine.stateVar}: ${machine.transitions.slice(0, 3).map((transition) => `${transition.fromState}->${transition.toState}`).join(", ")}`))
  return flows
}

function inferCrossModuleFlows(modules: ModuleSummary[]) {
  return modules.slice(0, 8).map((module) => `${module.module}: ${module.entrypoints.slice(0, 4).join(", ") || "no public entrypoints indexed"}`)
}

function functionRisks(fn: CodeGraphFunction) {
  const risks: string[] = []
  if (fn.calls.some((call) => /malloc|free|lock|unlock|memcpy|strcpy|sprintf/i.test(call.name))) risks.push("resource or memory-sensitive calls")
  if (fn.endLine - fn.startLine > 120) risks.push("large function")
  if (/error|fail|panic|abort/i.test(fn.snippet)) risks.push("error-handling path")
  return risks
}

function fileRisks(file: CodeGraphFile) {
  const risks: string[] = []
  if (file.astSummary?.errors) risks.push("parser errors")
  if (file.functions.some((fn) => /error|fail|panic|abort/i.test(fn.snippet))) risks.push("error-handling code")
  if (file.functions.length > 80) risks.push("high function density")
  return risks
}

function parametersFromSignature(signature: string) {
  const body = signature.match(/\((.*)\)/)?.[1] ?? ""
  return body.split(",").map((part) => part.trim()).filter((part) => part && part !== "void").slice(0, 12)
}

function returnFromSignature(signature: string) {
  const before = signature.split("(")[0]?.trim() ?? ""
  return before.replace(/\b[A-Za-z_]\w*$/, "").trim()
}

function evidenceRef(file: string, startLine: number, endLine: number, snippet: string, parserKind: string): EvidenceRef {
  return {
    file,
    startLine,
    endLine,
    snippetHash: hashSnippet(snippet),
    parserKind,
    snippet,
  }
}

function formatEvidence(item: EvidenceRef) {
  return `<evidence path="${xmlAttr(item.file)}" lines="${item.startLine}-${item.endLine}" parser="${xmlAttr(item.parserKind)}" hash="${item.snippetHash}">\n${xmlText(item.snippet ?? "")}\n</evidence>`
}

function guardTool(tool: AnalysisToolName, policy: AnalysisToolPolicy) {
  if (!policy.allowedTools.includes(tool)) return `Analysis tool ${tool} is not allowed by policy.`
  if (policy.blockedTools.includes(tool)) return `Analysis tool ${tool} is blocked by policy.`
  return ""
}

function audit(
  traceId: string,
  tool: string,
  args: Record<string, unknown>,
  evidenceCount: number,
  elapsedMs: number,
  blocked: boolean,
  reason?: string,
): AnalysisToolAuditEntry {
  return {
    traceId,
    tool,
    argsSummary: summarizeArgs(args),
    evidenceCount,
    elapsedMs,
    blocked,
    reason,
  }
}

function toolResult<T>(input: AnalysisToolResult<T>): AnalysisToolResult<T> {
  return input
}

function summarizeArgs(args: Record<string, unknown>) {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? truncate(value, 80) : JSON.stringify(value)}`)
    .join(", ")
    .slice(0, 400)
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = stringArg(args, key)
  if (!value) throw new Error(`${key} is required.`)
  return value
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return leftStart <= rightEnd && rightStart <= leftEnd
}

function matchesTerms(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  return terms.length === 0 || terms.some((term) => lower.includes(term))
}

function splitIdentifier(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+|_+/).map((part) => part.toLowerCase()).filter(Boolean)
}

function limitText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false }
  let result = ""
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return { text: result, truncated: true }
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}

function createTraceId() {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function xmlAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
}
