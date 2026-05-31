import type { CodeGraphEvidence, CodeGraphQueryMode, CodeGraphRetrievalResult } from "./codegraph-types"

export type EvidenceRef = {
  file: string
  startLine: number
  endLine: number
  snippetHash: string
  parserKind: string
  snippet?: string
}

export type StateMachinePhase =
  | "scanCandidates"
  | "extractTransitions"
  | "linkCrossFunction"
  | "verifyEvidence"

export type StateMachineMetric = {
  phase: StateMachinePhase
  elapsedMs: number
  candidates: number
}

export type StateMachineState = {
  machineId: string
  stateId: string
  name: string
  value?: string
  definitionRange?: EvidenceRef
  comment?: string
  confidence: number
}

export type StateMachineTransition = {
  id: string
  machineId: string
  fromState: string
  toState: string
  event?: string
  guard?: string
  action?: string
  evidence: EvidenceRef
  functionId?: string
  confidence: number
  lowConfidence: boolean
}

export type StateMachinePath = {
  machineId: string
  startState: string
  endState: string
  transitions: StateMachineTransition[]
  conditions: string[]
  confidence: number
}

export type StateMachineQuery = {
  reachable: StateMachinePath[]
  deadStates: StateMachineState[]
  cycles: StateMachinePath[]
  errorPaths: StateMachinePath[]
}

export type StateMachine = {
  id: string
  name: string
  module: string
  rootSymbols: string[]
  stateVar: string
  language: string
  confidence: number
  states: StateMachineState[]
  transitions: StateMachineTransition[]
  candidateTransitions: StateMachineTransition[]
  paths: StateMachinePath[]
  query: StateMachineQuery
  evidence: EvidenceRef[]
  metrics: StateMachineMetric[]
  mermaid: string
  dot: string
}

export type SummaryEvidence = EvidenceRef

export type FunctionSummary = {
  id: string
  name: string
  path: string
  module: string
  signature: string
  summary: string
  inputs: string[]
  outputs: string[]
  calls: string[]
  stateMachines: string[]
  risks: string[]
  evidence: SummaryEvidence[]
  confidence: number
}

export type FileSummary = {
  path: string
  module: string
  language: string
  summary: string
  coreSymbols: string[]
  inputs: string[]
  outputs: string[]
  dependencies: string[]
  stateMachines: string[]
  risks: string[]
  evidence: SummaryEvidence[]
  confidence: number
}

export type ModuleSummary = {
  module: string
  summary: string
  responsibilities: string[]
  submodules: string[]
  keyFlows: string[]
  entrypoints: string[]
  dependencies: string[]
  stateMachines: string[]
  risks: string[]
  evidence: SummaryEvidence[]
  confidence: number
}

export type SubsystemSummary = {
  id: string
  name: string
  modules: string[]
  summary: string
  crossModuleFlows: string[]
  entrypoints: string[]
  dependencies: string[]
  stateMachines: string[]
  evidence: SummaryEvidence[]
  confidence: number
}

export type AnalysisSummaries = {
  functions: FunctionSummary[]
  files: FileSummary[]
  modules: ModuleSummary[]
  subsystems: SubsystemSummary[]
}

export type AnalysisToolName =
  | "search"
  | "getFileSlice"
  | "getSymbol"
  | "getCallers"
  | "getCallees"
  | "getCallChain"
  | "getModuleMap"
  | "getStateMachines"
  | "getStatePath"
  | "queryEvidence"

export type AnalysisBudget = {
  maxEvidenceItems: number
  maxEvidenceBytes: number
  maxFileSliceBytes: number
  maxGraphEdges: number
  maxPaths: number
}

export type AnalysisToolPolicy = {
  allowedTools: AnalysisToolName[]
  blockedTools: string[]
  edit: "deny" | "ask" | "allow"
  bash: "deny" | "ask" | "allow"
  read: "deny" | "ask" | "allow"
  mode: "context-only" | "shared-workspace"
}

export type AnalysisToolAuditEntry = {
  traceId: string
  tool: string
  argsSummary: string
  evidenceCount: number
  elapsedMs: number
  blocked: boolean
  reason?: string
}

export type AnalysisQueryTraceStep = {
  label: string
  detail: string
  elapsedMs: number
}

export type AnalysisQueryTrace = {
  traceId: string
  question: string
  intent: CodeGraphQueryMode | "state-machine" | "module-flow" | "file-slice" | "symbol" | "unknown"
  steps: AnalysisQueryTraceStep[]
  evidence: EvidenceRef[]
  missingEvidence: string[]
}

export type EvidencePack = {
  evidence: EvidenceRef[]
  text: string
  packedBytes: number
  omittedEvidence: number
  truncated: boolean
  missingEvidence: string[]
}

export type AnswerPolicyResult = {
  allowed: boolean
  confidence: "high" | "medium" | "low" | "none"
  reason: string
  requiredCitation: string
}

export type QueryEvidenceResult = {
  retrieval?: CodeGraphRetrievalResult
  stateMachines: StateMachine[]
  summaries: AnalysisSummaries
  evidencePack: EvidencePack
  trace: AnalysisQueryTrace
  answerPolicy: AnswerPolicyResult
  suggestedAnswer: string
}

export type AnalysisToolResult<T = unknown> = {
  ok: boolean
  traceId: string
  tool: AnalysisToolName
  elapsedMs: number
  data?: T
  evidence: EvidenceRef[]
  audit: AnalysisToolAuditEntry
  error?: string
  truncated?: boolean
  omittedEvidence?: number
}

export type CodeIntelligenceSnapshot = {
  status: string
  modules: ModuleSummary[]
  files: FileSummary[]
  functions: FunctionSummary[]
  stateMachines: StateMachine[]
  lastTrace?: AnalysisQueryTrace
  lastAudit: AnalysisToolAuditEntry[]
}

export function evidenceFromCodeGraph(item: CodeGraphEvidence): EvidenceRef {
  return {
    file: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    snippetHash: hashSnippet(item.snippet),
    parserKind: `codegraph:${item.kind}`,
    snippet: item.snippet,
  }
}

export function hashSnippet(input = "") {
  let hash = 2166136261
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
