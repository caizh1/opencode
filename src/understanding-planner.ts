import type { AnalysisToolResult, QueryEvidenceResult } from "./analysis-types"
import type { EvidenceRef } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidenceQueryOptions, CodeGraphSymbolCandidate } from "./codegraph-types"
import type { RagStatus } from "./types"

export const UNDERSTANDING_PLANNER_TASK_TYPES = [
  "semantic_search",
  "symbol_discovery",
  "module_map",
  "call_expansion",
  "call_chain",
  "reference_search",
  "state_machine_search",
  "config_search",
  "test_search",
] as const

export type UnderstandingPlannerTaskType = (typeof UNDERSTANDING_PLANNER_TASK_TYPES)[number]

export type UnderstandingCallExpansionDirection = "callers" | "callees" | "both"

export type UnderstandingPlannerTask = {
  type: UnderstandingPlannerTaskType
  query: string
  reason?: string
  symbol?: string
  target?: string
  direction?: UnderstandingCallExpansionDirection
  relatedPaths?: string[]
}

export type EvidencePlan = {
  templateId?: UnderstandingPlanTemplateId
  questionSummary: string
  concepts: string[]
  hypotheses: string[]
  tasks: UnderstandingPlannerTask[]
  answerShape: string
  riskNotes: string[]
}

export const UNDERSTANDING_PLAN_TEMPLATES = {
  "performance-factor-analysis": {
    evidenceTypes: ["semantic_search", "module_map", "call_expansion", "config_search", "test_search"],
    answerShape: "factor_grouped",
    missingEvidenceStrategy: "Separate unverified performance hypotheses from evidence-backed factors.",
  },
  "root-cause-analysis": {
    evidenceTypes: ["semantic_search", "reference_search", "call_chain", "state_machine_search", "test_search"],
    answerShape: "cause_chain",
    missingEvidenceStrategy: "Report missing trigger, propagation, and verification evidence as gaps.",
  },
  "architecture-understanding": {
    evidenceTypes: ["module_map", "semantic_search", "reference_search"],
    answerShape: "architecture_map",
    missingEvidenceStrategy: "Separate confirmed module boundaries from inferred responsibilities.",
  },
  "module-responsibility-map": {
    evidenceTypes: ["module_map", "symbol_discovery", "semantic_search"],
    answerShape: "responsibility_map",
    missingEvidenceStrategy: "List modules without direct evidence as coverage gaps.",
  },
  "state-flow-understanding": {
    evidenceTypes: ["state_machine_search", "call_chain", "reference_search"],
    answerShape: "state_flow",
    missingEvidenceStrategy: "Keep missing transitions, guards, and events in a gap section.",
  },
  "test-impact-analysis": {
    evidenceTypes: ["test_search", "reference_search", "call_expansion", "semantic_search"],
    answerShape: "test_impact",
    missingEvidenceStrategy: "Separate existing tests from uncovered behaviors and proposed validation.",
  },
} as const

export type UnderstandingPlanTemplateId = keyof typeof UNDERSTANDING_PLAN_TEMPLATES

export const UNDERSTANDING_FACTOR_CATEGORIES = [
  "algorithm_complexity",
  "call_frequency",
  "scan_scope",
  "concurrency",
  "queue_scheduling",
  "io",
  "cache",
  "batching",
  "configuration_thresholds",
  "error_retry",
  "tests_benchmarks",
  "module_structure",
  "state_flow",
  "general",
] as const

export type UnderstandingFactorCategory = (typeof UNDERSTANDING_FACTOR_CATEGORIES)[number]
export type UnderstandingEvidenceStrength = "direct" | "indirect" | "weak" | "missing"
export type UnderstandingFactorConfidence = "high" | "medium" | "low" | "none"

export type UnderstandingEvidenceCitation = {
  path: string
  startLine: number
  endLine: number
  snippetHash: string
  source: "queryEvidence" | "findSymbols" | "analysisTool"
  taskType: UnderstandingPlannerTaskType
  snippet?: string
}

export type UnderstandingFactor = {
  label: string
  category: UnderstandingFactorCategory
  supportingEvidence: UnderstandingEvidenceCitation[]
  confidence: UnderstandingFactorConfidence
  strength: UnderstandingEvidenceStrength
  hypothesis: boolean
  gaps: string[]
}

export type UnderstandingClaimSupportLevel = "direct" | "indirect" | "weak" | "counter"

export type UnderstandingClaim = {
  id: string
  claim: string
  factorCategory: UnderstandingFactorCategory
  evidenceRefs: UnderstandingEvidenceCitation[]
  supportLevel: UnderstandingClaimSupportLevel
  assumptions: string[]
  counterEvidence: UnderstandingEvidenceCitation[]
  confidence: UnderstandingFactorConfidence
}

export type UnderstandingEvidenceAggregation = {
  factors: UnderstandingFactor[]
  claims: UnderstandingClaim[]
  evidenceCount: number
  omittedDuplicateEvidence: number
  gaps: string[]
}

export type UnderstandingPlannerInput = {
  question: string
  currentFile?: string
  relatedPaths: string[]
  codeGraphState?: string
  rag?: Pick<RagStatus, "availability" | "indexAvailability" | "embeddingEnabled" | "enabled">
  previousPlan?: EvidencePlan
  previousTrace?: UnderstandingPlannerTrace
  confirmedConcepts?: string[]
  previousEvidenceRefs?: UnderstandingEvidenceCitation[]
  previousGaps?: string[]
  previousClaims?: UnderstandingClaim[]
  userCorrections?: string[]
}

export type UnderstandingPlannerTrace = {
  planner_used: boolean
  fast_path_reason?: UnderstandingFastPathReason
  fallback_reason?: string
  task_count: number
  evidence_count: number
  latency_ms: number
}

export type UnderstandingPlannerResult =
  | {
      kind: "planned"
      plan: EvidencePlan
      trace: UnderstandingPlannerTrace
    }
  | {
      kind: "fast-path"
      reason: UnderstandingFastPathReason
      trace: UnderstandingPlannerTrace
    }
  | {
      kind: "fallback"
      reason: string
      trace: UnderstandingPlannerTrace
    }

export type UnderstandingFastPathReason =
  | "callers"
  | "callees"
  | "call-chain"
  | "references"
  | "inspect-symbol"

export type UnderstandingPlannerProvider = (input: UnderstandingPlannerInput) => Promise<unknown>

export type UnderstandingPlannerOptions = {
  timeoutMs?: number
  maxTasks?: number
  provider: UnderstandingPlannerProvider
}

export type UnderstandingPlanExecutionTaskResult =
  | {
      task: UnderstandingPlannerTask
      kind: "queryEvidence"
      result?: QueryEvidenceResult
      evidenceCount: number
      error?: string
    }
  | {
      task: UnderstandingPlannerTask
      kind: "findSymbols"
      result: CodeGraphSymbolCandidate[]
      evidenceCount: number
      error?: string
    }
  | {
      task: UnderstandingPlannerTask
      kind: "analysisTool"
      result?: AnalysisToolResult
      evidenceCount: number
      error?: string
    }

export type UnderstandingPlanExecutionResult = {
  results: UnderstandingPlanExecutionTaskResult[]
  evidenceCount: number
  trace: UnderstandingPlannerTrace
  phaseTrace: UnderstandingPlanPhaseTrace[]
}

export type UnderstandingPlanExecutionInput = {
  plan: EvidencePlan
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence" | "findSymbols" | "runAnalysisTool">
  relatedPaths?: string[]
  queryOptions?: CodeGraphEvidenceQueryOptions
  maxTasks?: number
  maxDepth?: number
  maxFanout?: number
  maxEvidenceBytes?: number
  signal?: AbortSignal
}

export type UnderstandingPlanPhaseName = "discovery" | "expansion" | "gap_follow_up" | "aggregation"

export type UnderstandingPlanPhaseTrace = {
  phase: UnderstandingPlanPhaseName
  reason: string
  inputTasks: number
  outputTasks: number
  evidenceCount: number
  seedSymbols: string[]
  truncated: boolean
}

export type UnderstandingPlannerArtifact = {
  plan: EvidencePlan
  phaseTrace: UnderstandingPlanPhaseTrace[]
  taskResults: Array<{
    type: UnderstandingPlannerTaskType
    query: string
    symbol?: string
    kind: UnderstandingPlanExecutionTaskResult["kind"]
    evidenceCount: number
    error?: string
  }>
  aggregation: UnderstandingEvidenceAggregation
  claims: UnderstandingClaim[]
  verifierFindings?: Array<{ code: string; severity: "warning" | "blocking"; message: string }>
}

export type UnderstandingRoutingAuditFixture = {
  id: string
  question: string
  expected: "fast-path" | "planner"
  reason?: UnderstandingFastPathReason
}

export type UnderstandingRoutingAuditResult = UnderstandingRoutingAuditFixture & {
  actual: "fast-path" | "planner"
  actualReason?: UnderstandingFastPathReason
  pass: boolean
}

const DEFAULT_PLANNER_TIMEOUT_MS = 2500
const DEFAULT_MAX_TASKS = 12
const DEFAULT_EXECUTION_MAX_TASKS = 16
const DEFAULT_EXECUTION_MAX_DEPTH = 2
const DEFAULT_EXECUTION_MAX_FANOUT = 4
const MAX_TEXT_LENGTH = 2000
const MAX_LIST_ITEMS = 24
const MAX_FACTOR_EVIDENCE = 8

const TASK_TYPES = new Set<string>(UNDERSTANDING_PLANNER_TASK_TYPES)
const TEMPLATE_IDS = new Set<string>(Object.keys(UNDERSTANDING_PLAN_TEMPLATES))
const PERFORMANCE_FACTOR_ORDER: UnderstandingFactorCategory[] = [
  "algorithm_complexity",
  "call_frequency",
  "scan_scope",
  "concurrency",
  "queue_scheduling",
  "io",
  "cache",
  "batching",
  "configuration_thresholds",
  "error_retry",
  "tests_benchmarks",
]

const FACTOR_LABELS: Record<UnderstandingFactorCategory, string> = {
  algorithm_complexity: "Algorithm complexity",
  call_frequency: "Call frequency and hot paths",
  scan_scope: "Scan scope and data volume",
  concurrency: "Locks and concurrency",
  queue_scheduling: "Queueing and scheduling",
  io: "I/O and persistence",
  cache: "Caching and locality",
  batching: "Batching and granularity",
  configuration_thresholds: "Configuration thresholds",
  error_retry: "Error and retry paths",
  tests_benchmarks: "Tests and benchmarks",
  module_structure: "Module responsibilities and boundaries",
  state_flow: "State flow and transitions",
  general: "General code evidence",
}

export class UnderstandingPlanner {
  private readonly provider: UnderstandingPlannerProvider
  private readonly timeoutMs: number
  private readonly maxTasks: number

  constructor(options: UnderstandingPlannerOptions) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS
  }

  async plan(input: UnderstandingPlannerInput): Promise<UnderstandingPlannerResult> {
    const started = Date.now()
    const fastPath = understandingFastPathReason(input.question)
    if (fastPath) {
      return {
        kind: "fast-path",
        reason: fastPath,
        trace: plannerTrace({
          plannerUsed: false,
          fastPathReason: fastPath,
          started,
        }),
      }
    }

    try {
      const raw = await withTimeout(this.provider(input), this.timeoutMs, "planner-timeout")
      const plan = validateEvidencePlan(raw, { maxTasks: this.maxTasks })
      return {
        kind: "planned",
        plan,
        trace: plannerTrace({
          plannerUsed: true,
          taskCount: plan.tasks.length,
          started,
        }),
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        kind: "fallback",
        reason,
        trace: plannerTrace({
          plannerUsed: true,
          fallbackReason: reason,
          started,
        }),
      }
    }
  }
}

export function understandingFastPathReason(question: string): UnderstandingFastPathReason | undefined {
  const text = question.trim().toLowerCase()
  if (!text) return undefined
  const hasIdentifier = /[`"'“”‘’]?[A-Za-z_]\w{2,}[`"'“”‘’]?/.test(question)
  if (!hasIdentifier) return undefined
  if (hasBroadUnderstandingIntent(question)) return undefined
  if (/谁(?:会)?调用|哪些.+调用|调用者|who\s+calls?/i.test(question)) return "callers"
  if (/调用了谁|调用哪些|calls?\s+what|callees?|what\s+does.+call/i.test(question)) return "callees"
  if (/调用链|调用路径|call\s*chain|from\s+[A-Za-z_]\w{2,}.*\bto\b/i.test(question)) return "call-chain"
  if (/引用|references?|find\s+refs?|查找引用/i.test(question)) return "references"
  if (/^(?:解释|inspect|查看|定义)\s*[`"'“”‘’]?[A-Za-z_]\w{2,}[`"'“”‘’]?\s*$/i.test(question)) return "inspect-symbol"
  return undefined
}

export function evaluateUnderstandingRoutingFixtures(fixtures: UnderstandingRoutingAuditFixture[]): UnderstandingRoutingAuditResult[] {
  return fixtures.map((fixture) => {
    const actualReason = understandingFastPathReason(fixture.question)
    const actual = actualReason ? "fast-path" : "planner"
    return {
      ...fixture,
      actual,
      actualReason,
      pass: actual === fixture.expected && (!fixture.reason || actualReason === fixture.reason),
    }
  })
}

export function validateEvidencePlan(raw: unknown, options: { maxTasks?: number } = {}): EvidencePlan {
  const value = parsePlanObject(raw)
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS
  const templateId = optionalTemplateId(value)
  const questionSummary = requiredString(value, "questionSummary")
  const concepts = requiredStringArray(value, "concepts")
  const hypotheses = requiredStringArray(value, "hypotheses")
  const tasks = requiredTaskArray(value, maxTasks)
  const answerShape = requiredString(value, "answerShape")
  const riskNotes = requiredStringArray(value, "riskNotes")
  if (tasks.length === 0) throw new Error("planner-empty-tasks")
  return {
    templateId,
    questionSummary,
    concepts,
    hypotheses,
    tasks,
    answerShape,
    riskNotes,
  }
}

export async function executeEvidencePlan(input: UnderstandingPlanExecutionInput): Promise<UnderstandingPlanExecutionResult> {
  const started = Date.now()
  const results: UnderstandingPlanExecutionTaskResult[] = []
  const phaseTrace: UnderstandingPlanPhaseTrace[] = []
  const taskBudget = Math.max(1, input.maxTasks ?? DEFAULT_EXECUTION_MAX_TASKS)
  const maxDepth = Math.max(1, input.maxDepth ?? DEFAULT_EXECUTION_MAX_DEPTH)
  const maxFanout = Math.max(1, input.maxFanout ?? DEFAULT_EXECUTION_MAX_FANOUT)
  const plannedTasks = dedupeTasks(input.plan.tasks).slice(0, taskBudget)
  let remainingTasks = taskBudget

  const discoveryTasks = plannedTasks.filter((task) => !isExpansionTask(task))
  throwIfAborted(input.signal)
  const discoveryResults = await executeTaskBatch(discoveryTasks.slice(0, remainingTasks), input)
  results.push(...discoveryResults)
  remainingTasks -= discoveryResults.length
  const seedSymbols = collectSeedSymbols(discoveryResults).slice(0, maxFanout)
  phaseTrace.push(phaseTraceEntry({
    phase: "discovery",
    reason: "Run planner discovery tasks before graph expansion.",
    inputTasks: discoveryTasks.length,
    outputTasks: discoveryResults.length,
    results: discoveryResults,
    seedSymbols,
    truncated: discoveryTasks.length > discoveryResults.length,
  }))

  if (remainingTasks > 0 && maxDepth > 1) {
    const plannedExpansion = plannedTasks.filter(isExpansionTask)
    const expansionTasks = buildExpansionTasks(plannedExpansion, seedSymbols, maxFanout).slice(0, remainingTasks)
    throwIfAborted(input.signal)
    const expansionResults = await executeTaskBatch(expansionTasks, input)
    results.push(...expansionResults)
    remainingTasks -= expansionResults.length
    phaseTrace.push(phaseTraceEntry({
      phase: "expansion",
      reason: "Expand only from planner tasks or seed symbols discovered in the previous phase.",
      inputTasks: plannedExpansion.length,
      outputTasks: expansionResults.length,
      results: expansionResults,
      seedSymbols,
      truncated: expansionTasks.length > expansionResults.length || buildExpansionTasks(plannedExpansion, seedSymbols, maxFanout).length > expansionTasks.length,
    }))
  }

  if (remainingTasks > 0) {
    const followUpTasks = buildGapFollowUpTasks(input.plan, results).slice(0, remainingTasks)
    throwIfAborted(input.signal)
    const followUpResults = await executeTaskBatch(followUpTasks, input)
    results.push(...followUpResults)
    remainingTasks -= followUpResults.length
    phaseTrace.push(phaseTraceEntry({
      phase: "gap_follow_up",
      reason: "Run one bounded follow-up for missing config, test, or state evidence categories.",
      inputTasks: followUpTasks.length,
      outputTasks: followUpResults.length,
      results: followUpResults,
      seedSymbols,
      truncated: false,
    }))
  }

  const evidenceCount = results.reduce((total, result) => total + result.evidenceCount, 0)
  phaseTrace.push({
    phase: "aggregation",
    reason: "Aggregate collected evidence after bounded retrieval phases.",
    inputTasks: results.length,
    outputTasks: results.length,
    evidenceCount,
    seedSymbols,
    truncated: false,
  })
  return {
    results,
    evidenceCount,
    trace: plannerTrace({
      plannerUsed: true,
      taskCount: results.length,
      evidenceCount,
      started,
    }),
    phaseTrace,
  }
}

export function aggregateUnderstandingEvidence(
  plan: EvidencePlan,
  execution: UnderstandingPlanExecutionResult,
): UnderstandingEvidenceAggregation {
  const factorMap = new Map<UnderstandingFactorCategory, UnderstandingFactor>()
  let omittedDuplicateEvidence = 0

  for (const result of execution.results) {
    const citations = citationsForTaskResult(result)
    for (const citation of citations) {
      for (const category of factorCategoriesForEvidence(citation, result.task.type, plan)) {
        const factor = factorForCategory(factorMap, category)
        if (factor.supportingEvidence.some((item) => sameCitation(item, citation))) {
          omittedDuplicateEvidence += 1
          continue
        }
        if (factor.supportingEvidence.length < MAX_FACTOR_EVIDENCE && hasDiverseEvidenceSlot(factor.supportingEvidence, citation)) {
          factor.supportingEvidence.push(citation)
        }
      }
    }
  }

  for (const category of defaultFactorCategories(plan)) {
    factorForCategory(factorMap, category)
  }

  const factors = [...factorMap.values()].map((factor) => finalizeFactor(factor))
  const claims = extractUnderstandingClaims(plan, execution)
  const gaps = factors
    .filter((factor) => factor.supportingEvidence.length === 0)
    .map((factor) => `${factor.label}: missing supporting evidence`)
  if (hasIndirectDispatchGap(execution.results)) {
    gaps.push("Static graph gap: callback, function-pointer, generated-code, or macro-expanded edges may be missing from expansion evidence.")
  }

  return {
    factors,
    claims,
    evidenceCount: factors.reduce((total, factor) => total + factor.supportingEvidence.length, 0),
    omittedDuplicateEvidence,
    gaps,
  }
}

export function extractUnderstandingClaims(
  plan: EvidencePlan,
  execution: UnderstandingPlanExecutionResult,
): UnderstandingClaim[] {
  const claimMap = new Map<UnderstandingFactorCategory, UnderstandingClaim>()
  for (const result of execution.results) {
    for (const citation of citationsForTaskResult(result)) {
      const categories = factorCategoriesForEvidence(citation, result.task.type, plan)
      for (const category of categories) {
        const existing = claimMap.get(category) ?? newUnderstandingClaim(category)
        if (!existing.evidenceRefs.some((item) => sameCitation(item, citation)) && hasDiverseEvidenceSlot(existing.evidenceRefs, citation)) {
          existing.evidenceRefs.push(citation)
        }
        const signal = evidenceSignal(citation)
        if (signal.counter && !existing.counterEvidence.some((item) => sameCitation(item, citation))) {
          existing.counterEvidence.push(citation)
        }
        for (const assumption of signal.assumptions) {
          if (!existing.assumptions.includes(assumption)) existing.assumptions.push(assumption)
        }
        claimMap.set(category, existing)
      }
    }
  }
  return [...claimMap.values()].map(finalizeClaim)
}

export function createUnderstandingPlannerArtifact(input: {
  plan: EvidencePlan
  execution: UnderstandingPlanExecutionResult
  aggregation: UnderstandingEvidenceAggregation
  verifierFindings?: Array<{ code: string; severity: "warning" | "blocking"; message: string }>
}): UnderstandingPlannerArtifact {
  return {
    plan: input.plan,
    phaseTrace: input.execution.phaseTrace,
    taskResults: input.execution.results.map((result) => ({
      type: result.task.type,
      query: result.task.query,
      symbol: result.task.symbol,
      kind: result.kind,
      evidenceCount: result.evidenceCount,
      error: result.error,
    })),
    aggregation: input.aggregation,
    claims: input.aggregation.claims,
    verifierFindings: input.verifierFindings,
  }
}

function hasIndirectDispatchGap(results: UnderstandingPlanExecutionTaskResult[]) {
  return results.some((result) =>
    (result.task.type === "call_expansion" || result.task.type === "call_chain" || result.task.type === "reference_search") &&
    result.evidenceCount === 0,
  )
}

async function executeTask(
  task: UnderstandingPlannerTask,
  input: UnderstandingPlanExecutionInput,
): Promise<UnderstandingPlanExecutionTaskResult> {
  throwIfAborted(input.signal)
  try {
    switch (task.type) {
      case "semantic_search":
      case "config_search":
      case "test_search": {
        const result = await input.codeGraph.queryEvidence(task.query, queryOptionsForTask(task, input))
        return { task, kind: "queryEvidence", result, evidenceCount: result?.evidencePack.evidence.length ?? 0 }
      }
      case "symbol_discovery": {
        const result = await input.codeGraph.findSymbols({
          query: task.symbol || task.query,
          relatedPath: task.relatedPaths?.[0] ?? input.relatedPaths?.[0],
          limit: 12,
        })
        return { task, kind: "findSymbols", result, evidenceCount: result.length }
      }
      case "module_map": {
        const result = await input.codeGraph.runAnalysisTool({ tool: "getModuleMap", args: { query: task.query } })
        return { task, kind: "analysisTool", result, evidenceCount: result.evidence.length }
      }
      case "call_expansion":
        return executeCallExpansionTask(task, input)
      case "call_chain": {
        const result = await input.codeGraph.runAnalysisTool({
          tool: "getCallChain",
          args: { symbol: task.symbol || task.query, target: task.target },
        })
        return { task, kind: "analysisTool", result, evidenceCount: result.evidence.length }
      }
      case "reference_search": {
        const result = await input.codeGraph.runAnalysisTool({ tool: "search", args: { query: task.symbol || task.query } })
        return { task, kind: "analysisTool", result, evidenceCount: result.evidence.length }
      }
      case "state_machine_search": {
        const result = await input.codeGraph.runAnalysisTool({ tool: "getStateMachines", args: { query: task.query } })
        return { task, kind: "analysisTool", result, evidenceCount: result.evidence.length }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (task.type === "symbol_discovery") return { task, kind: "findSymbols", result: [], evidenceCount: 0, error: message }
    if (task.type === "semantic_search" || task.type === "config_search" || task.type === "test_search") {
      return { task, kind: "queryEvidence", evidenceCount: 0, error: message }
    }
    return { task, kind: "analysisTool", evidenceCount: 0, error: message }
  }
}

async function executeTaskBatch(
  tasks: UnderstandingPlannerTask[],
  input: UnderstandingPlanExecutionInput,
): Promise<UnderstandingPlanExecutionTaskResult[]> {
  throwIfAborted(input.signal)
  return Promise.all(tasks.map((task) => executeTask(task, input)))
}

function dedupeTasks(tasks: UnderstandingPlannerTask[]) {
  const seen = new Set<string>()
  const result: UnderstandingPlannerTask[] = []
  for (const task of tasks) {
    const key = `${task.type}:${task.query}:${task.symbol ?? ""}:${task.direction ?? ""}:${(task.relatedPaths ?? []).join(",")}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(task)
  }
  return result
}

function isExpansionTask(task: UnderstandingPlannerTask) {
  return task.type === "call_expansion" || task.type === "call_chain" || task.type === "reference_search"
}

function collectSeedSymbols(results: UnderstandingPlanExecutionTaskResult[]) {
  const seeds: string[] = []
  for (const result of results) {
    if (result.kind === "findSymbols") {
      for (const symbol of result.result) seeds.push(symbol.name)
    }
    if (result.task.symbol) seeds.push(result.task.symbol)
  }
  return [...new Set(seeds.filter((seed) => /^[A-Za-z_]\w{2,}$/.test(seed)))]
}

function buildExpansionTasks(
  plannedExpansion: UnderstandingPlannerTask[],
  seedSymbols: string[],
  maxFanout: number,
) {
  const tasks: UnderstandingPlannerTask[] = []
  for (const task of plannedExpansion) {
    if (task.symbol) {
      tasks.push(task)
      continue
    }
    for (const seed of seedSymbols.slice(0, maxFanout)) {
      tasks.push({
        ...task,
        query: seed,
        symbol: seed,
        reason: task.reason ?? "expanded from discovered seed symbol",
      })
    }
  }
  if (plannedExpansion.length === 0) {
    for (const seed of seedSymbols.slice(0, maxFanout)) {
      tasks.push({
        type: "call_expansion",
        query: seed,
        symbol: seed,
        direction: "both",
        reason: "bounded seed call expansion",
      })
    }
  }
  return dedupeTasks(tasks)
}

function buildGapFollowUpTasks(plan: EvidencePlan, results: UnderstandingPlanExecutionTaskResult[]) {
  const existingTypes = new Set(results.map((result) => result.task.type))
  const query = plan.concepts.length ? plan.concepts.join(" ") : plan.questionSummary
  const tasks: UnderstandingPlannerTask[] = []
  if (!existingTypes.has("config_search")) {
    tasks.push({
      type: "config_search",
      query,
      reason: "bounded follow-up for missing configuration evidence",
    })
  }
  if (!existingTypes.has("test_search")) {
    tasks.push({
      type: "test_search",
      query,
      reason: "bounded follow-up for missing test or benchmark evidence",
    })
  }
  if (!existingTypes.has("state_machine_search")) {
    tasks.push({
      type: "state_machine_search",
      query,
      reason: "bounded follow-up for missing state-flow evidence",
    })
  }
  return tasks
}

function phaseTraceEntry(input: {
  phase: UnderstandingPlanPhaseName
  reason: string
  inputTasks: number
  outputTasks: number
  results: UnderstandingPlanExecutionTaskResult[]
  seedSymbols: string[]
  truncated: boolean
}): UnderstandingPlanPhaseTrace {
  return {
    phase: input.phase,
    reason: input.reason,
    inputTasks: input.inputTasks,
    outputTasks: input.outputTasks,
    evidenceCount: input.results.reduce((total, result) => total + result.evidenceCount, 0),
    seedSymbols: input.seedSymbols,
    truncated: input.truncated,
  }
}

function factorForCategory(
  factorMap: Map<UnderstandingFactorCategory, UnderstandingFactor>,
  category: UnderstandingFactorCategory,
) {
  const existing = factorMap.get(category)
  if (existing) return existing
  const factor: UnderstandingFactor = {
    label: FACTOR_LABELS[category],
    category,
    supportingEvidence: [],
    confidence: "none",
    strength: "missing",
    hypothesis: true,
    gaps: [],
  }
  factorMap.set(category, factor)
  return factor
}

function finalizeFactor(factor: UnderstandingFactor): UnderstandingFactor {
  const evidenceCount = factor.supportingEvidence.length
  if (evidenceCount === 0) {
    return {
      ...factor,
      confidence: "none",
      strength: "missing",
      hypothesis: true,
      gaps: [`No retrieved evidence for ${factor.label}. Treat as a gap, not a conclusion.`],
    }
  }
  const hasDirect = factor.supportingEvidence.some((item) => item.source === "analysisTool" || item.source === "queryEvidence")
  return {
    ...factor,
    confidence: evidenceCount >= 3 ? "high" : evidenceCount >= 2 ? "medium" : "low",
    strength: hasDirect ? "direct" : "weak",
    hypothesis: false,
    gaps: factor.gaps,
  }
}

function hasBroadUnderstandingIntent(question: string) {
  return /性能|速度|耗时|延迟|优化|因素|影响|根因|原因|为什么|架构|边界|职责|流程|状态|迁移|测试|覆盖|风险|会不会|是否|latency|performance|speed|optimi[sz]e|factor|impact|root\s*cause|architecture|responsibilit|state|test/i.test(question)
}

function factorCategoriesForEvidence(
  citation: UnderstandingEvidenceCitation,
  taskType: UnderstandingPlannerTaskType,
  plan: EvidencePlan,
): UnderstandingFactorCategory[] {
  const categories = new Set<UnderstandingFactorCategory>()
  const text = `${citation.path}\n${citation.snippet ?? ""}\n${citation.snippetHash}`.toLowerCase()
  if (/\b(for|while|loop|iterate|iteration|nested|complexity|o\(|遍历|循环|复杂度)\b/.test(text)) categories.add("algorithm_complexity")
  if (/\b(hot|call|caller|callee|freq|frequent|path|入口|调用|热路径)\b/.test(text)) categories.add("call_frequency")
  if (/\b(scan|sweep|range|all\s+items|table|list|queue\s+depth|扫描|范围|全量)\b/.test(text)) categories.add("scan_scope")
  if (/\b(lock|mutex|spin|semaphore|atomic|race|concurrent|thread|锁|并发|竞争)\b/.test(text)) categories.add("concurrency")
  if (/\b(queue|schedule|scheduler|dispatch|workqueue|队列|调度)\b/.test(text)) categories.add("queue_scheduling")
  if (/\b(io|i\/o|read|write|flush|fsync|disk|nand|persist|page|块|读|写|落盘)\b/.test(text)) categories.add("io")
  if (/\b(cache|locality|hit|miss|reuse|缓存|命中)\b/.test(text)) categories.add("cache")
  if (/\b(batch|chunk|granular|coalesce|批|粒度|合并)\b/.test(text)) categories.add("batching")
  if (/\b(config|threshold|watermark|limit|interval|timeout|配置|阈值|水位|限制)\b/.test(text)) categories.add("configuration_thresholds")
  if (/\b(error|fail|retry|fallback|recover|rollback|exception|错误|失败|重试|回退|恢复)\b/.test(text)) categories.add("error_retry")
  if (/\b(test|benchmark|bench|perf|coverage|assert|测试|基准|覆盖)\b/.test(text)) categories.add("tests_benchmarks")
  if (/\b(module|boundary|owner|layer|dependency|api|interface|目录|模块|边界|职责|依赖|接口)\b/.test(text)) categories.add("module_structure")
  if (/\b(state|transition|guard|event|fsm|状态|迁移|转换|事件)\b/.test(text)) categories.add("state_flow")
  if (categories.size === 0) categories.add(factorCategoryForTask(taskType))
  const template = plan.templateId ? UNDERSTANDING_PLAN_TEMPLATES[plan.templateId] : undefined
  if (template?.answerShape === "architecture_map" && taskType === "module_map") categories.add("module_structure")
  if (template?.answerShape === "cause_chain" && categories.size === 1 && categories.has("call_frequency")) categories.add("error_retry")
  return [...categories]
}

function hasDiverseEvidenceSlot(existing: UnderstandingEvidenceCitation[], next: UnderstandingEvidenceCitation) {
  if (existing.length < 3) return true
  const samePathCount = existing.filter((item) => item.path === next.path).length
  const sameTaskCount = existing.filter((item) => item.taskType === next.taskType).length
  return samePathCount < 3 && sameTaskCount < 5
}

function newUnderstandingClaim(category: UnderstandingFactorCategory): UnderstandingClaim {
  return {
    id: category,
    claim: FACTOR_LABELS[category],
    factorCategory: category,
    evidenceRefs: [],
    supportLevel: "weak",
    assumptions: [],
    counterEvidence: [],
    confidence: "none",
  }
}

function finalizeClaim(claim: UnderstandingClaim): UnderstandingClaim {
  const evidenceCount = claim.evidenceRefs.length
  const counterCount = claim.counterEvidence.length
  const supportLevel: UnderstandingClaimSupportLevel = counterCount > 0
    ? "counter"
    : evidenceCount >= 2
      ? "direct"
      : evidenceCount === 1
        ? "indirect"
        : "weak"
  const confidence: UnderstandingFactorConfidence = counterCount > 0
    ? "low"
    : evidenceCount >= 3
      ? "high"
      : evidenceCount >= 2
        ? "medium"
        : evidenceCount === 1
          ? "low"
          : "none"
  return {
    ...claim,
    claim: claimTextForCategory(claim.factorCategory, supportLevel),
    supportLevel,
    confidence,
  }
}

function claimTextForCategory(category: UnderstandingFactorCategory, supportLevel: UnderstandingClaimSupportLevel) {
  const prefix = supportLevel === "counter" ? "Ambiguous or contradicted evidence for" : "Evidence indicates"
  return `${prefix} ${FACTOR_LABELS[category].toLowerCase()}.`
}

function evidenceSignal(citation: UnderstandingEvidenceCitation) {
  const text = `${citation.snippet ?? ""}\n${citation.snippetHash}`.toLowerCase()
  const assumptions: string[] = []
  const counter = /\b(unused|not\s+used|disabled|no\s+benchmark|no\s+test|missing|todo|unknown|缺少|未使用|未覆盖|禁用)\b/.test(text)
  if (/\b(maybe|possible|likely|unknown|assume|可能|疑似|推测)\b/.test(text)) assumptions.push("Evidence wording is uncertain; keep this as a lower-confidence claim.")
  if (counter) assumptions.push("Counter or missing-evidence wording was found near this evidence.")
  return { counter, assumptions }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("planner-execution-aborted")
}

function defaultFactorCategories(plan: EvidencePlan): UnderstandingFactorCategory[] {
  const categories = new Set<UnderstandingFactorCategory>(["general"])
  for (const task of plan.tasks) categories.add(factorCategoryForTask(task.type))
  const template = plan.templateId ? UNDERSTANDING_PLAN_TEMPLATES[plan.templateId] : undefined
  const answerShape = template?.answerShape ?? plan.answerShape
  if (answerShape.toLowerCase().includes("factor")) {
    for (const category of PERFORMANCE_FACTOR_ORDER) categories.add(category)
  }
  return [...categories]
}

function factorCategoryForTask(type: UnderstandingPlannerTaskType): UnderstandingFactorCategory {
  switch (type) {
    case "call_expansion":
    case "call_chain":
    case "reference_search":
      return "call_frequency"
    case "module_map":
      return "module_structure"
    case "state_machine_search":
      return "state_flow"
    case "config_search":
      return "configuration_thresholds"
    case "test_search":
      return "tests_benchmarks"
    case "symbol_discovery":
      return "general"
    case "semantic_search":
      return "general"
  }
}

function citationsForTaskResult(result: UnderstandingPlanExecutionTaskResult): UnderstandingEvidenceCitation[] {
  if (result.error) return []
  if (result.kind === "queryEvidence") {
    return (result.result?.evidencePack.evidence ?? []).map((evidence) => citationFromEvidence(evidence, result.kind, result.task.type))
  }
  if (result.kind === "analysisTool") {
    return (result.result?.evidence ?? []).map((evidence) => citationFromEvidence(evidence, result.kind, result.task.type))
  }
  return result.result.map((symbol) => ({
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    snippetHash: `${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`,
    source: "findSymbols",
    taskType: result.task.type,
    snippet: limitText(symbol.snippet || symbol.signature || symbol.name),
  }))
}

function citationFromEvidence(
  evidence: EvidenceRef,
  source: UnderstandingEvidenceCitation["source"],
  taskType: UnderstandingPlannerTaskType,
): UnderstandingEvidenceCitation {
  return {
    path: evidence.file,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    snippetHash: evidence.snippetHash,
    source,
    taskType,
    snippet: evidence.snippet ? limitText(evidence.snippet) : undefined,
  }
}

function sameCitation(left: UnderstandingEvidenceCitation, right: UnderstandingEvidenceCitation) {
  if (left.path !== right.path) return false
  if (left.startLine === right.startLine && left.endLine === right.endLine) return true
  if (left.snippetHash && left.snippetHash === right.snippetHash) return true
  return normalizedSnippet(left.snippet) !== "" && normalizedSnippet(left.snippet) === normalizedSnippet(right.snippet)
}

function normalizedSnippet(input?: string) {
  return input?.replace(/\s+/g, " ").trim().slice(0, 240) ?? ""
}

async function executeCallExpansionTask(
  task: UnderstandingPlannerTask,
  input: UnderstandingPlanExecutionInput,
): Promise<UnderstandingPlanExecutionTaskResult> {
  const symbol = task.symbol || task.query
  if (task.direction === "both") {
    const callers = await input.codeGraph.runAnalysisTool({ tool: "getCallers", args: { symbol } })
    const callees = await input.codeGraph.runAnalysisTool({ tool: "getCallees", args: { symbol } })
    return {
      task,
      kind: "analysisTool",
      result: {
        ...callers,
        data: { callers: callers.data, callees: callees.data },
        evidence: [...callers.evidence, ...callees.evidence],
        truncated: Boolean(callers.truncated || callees.truncated),
        omittedEvidence: (callers.omittedEvidence ?? 0) + (callees.omittedEvidence ?? 0),
      },
      evidenceCount: callers.evidence.length + callees.evidence.length,
    }
  }
  const tool = task.direction === "callees" ? "getCallees" : "getCallers"
  const result = await input.codeGraph.runAnalysisTool({ tool, args: { symbol } })
  return { task, kind: "analysisTool", result, evidenceCount: result.evidence.length }
}

function queryOptionsForTask(task: UnderstandingPlannerTask, input: UnderstandingPlanExecutionInput): CodeGraphEvidenceQueryOptions {
  return {
    ...input.queryOptions,
    relatedPaths: [...new Set([...(input.queryOptions?.relatedPaths ?? []), ...(input.relatedPaths ?? []), ...(task.relatedPaths ?? [])])],
  }
}

function parsePlanObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(stripJsonFence(raw))
      return parsePlanObject(parsed)
    } catch {
      throw new Error("planner-invalid-json")
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("planner-invalid-shape")
  return raw as Record<string, unknown>
}

function stripJsonFence(input: string) {
  const trimmed = input.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

function requiredString(value: Record<string, unknown>, key: keyof EvidencePlan) {
  const raw = value[key]
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`planner-missing-${String(key)}`)
  return limitText(raw.trim())
}

function optionalTemplateId(value: Record<string, unknown>): UnderstandingPlanTemplateId | undefined {
  const raw = value.templateId
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || !TEMPLATE_IDS.has(raw)) throw new Error("planner-unknown-template")
  return raw as UnderstandingPlanTemplateId
}

function requiredStringArray(value: Record<string, unknown>, key: keyof EvidencePlan) {
  const raw = value[key]
  if (!Array.isArray(raw)) throw new Error(`planner-missing-${String(key)}`)
  return raw
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => limitText(item.trim()))
}

function requiredTaskArray(value: Record<string, unknown>, maxTasks: number): UnderstandingPlannerTask[] {
  const raw = value.tasks
  if (!Array.isArray(raw)) throw new Error("planner-missing-tasks")
  if (raw.length > maxTasks) throw new Error("planner-task-budget-exceeded")
  return raw.map((item) => validateTask(item))
}

function validateTask(raw: unknown): UnderstandingPlannerTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("planner-invalid-task")
  const value = raw as Record<string, unknown>
  const type = value.type
  if (typeof type !== "string" || !TASK_TYPES.has(type)) throw new Error("planner-unknown-task")
  const query = requiredTaskString(value, "query")
  const task: UnderstandingPlannerTask = {
    type: type as UnderstandingPlannerTaskType,
    query,
  }
  if (typeof value.reason === "string" && value.reason.trim()) task.reason = limitText(value.reason.trim())
  if (typeof value.symbol === "string" && value.symbol.trim()) task.symbol = limitText(value.symbol.trim())
  if (typeof value.target === "string" && value.target.trim()) task.target = limitText(value.target.trim())
  if (value.direction === "callers" || value.direction === "callees" || value.direction === "both") task.direction = value.direction
  if (Array.isArray(value.relatedPaths)) {
    task.relatedPaths = value.relatedPaths
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .slice(0, MAX_LIST_ITEMS)
      .map((item) => limitText(item.trim()))
  }
  return task
}

function requiredTaskString(value: Record<string, unknown>, key: keyof UnderstandingPlannerTask) {
  const raw = value[key]
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`planner-missing-task-${String(key)}`)
  return limitText(raw.trim())
}

function limitText(input: string) {
  return input.length > MAX_TEXT_LENGTH ? input.slice(0, MAX_TEXT_LENGTH) : input
}

function plannerTrace(input: {
  plannerUsed: boolean
  started: number
  fastPathReason?: UnderstandingFastPathReason
  fallbackReason?: string
  taskCount?: number
  evidenceCount?: number
}): UnderstandingPlannerTrace {
  return {
    planner_used: input.plannerUsed,
    fast_path_reason: input.fastPathReason,
    fallback_reason: input.fallbackReason,
    task_count: input.taskCount ?? 0,
    evidence_count: input.evidenceCount ?? 0,
    latency_ms: Date.now() - input.started,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), Math.max(0, timeoutMs))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
