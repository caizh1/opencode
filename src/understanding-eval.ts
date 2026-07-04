import type { AnalysisToolResult, EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import {
  UNDERSTANDING_PLAN_TEMPLATES,
  UnderstandingPlanner,
  aggregateUnderstandingEvidence,
  executeEvidencePlan,
  type EvidencePlan,
  type UnderstandingEvidenceAggregation,
  type UnderstandingFactor,
  type UnderstandingPlanExecutionResult,
  type UnderstandingPlanTemplateId,
  type UnderstandingPlannerResult,
  type UnderstandingPlannerTaskType,
} from "./understanding-planner"
import {
  draftAnswerFromUnderstandingClaims,
  repairUnderstandingAnswerGrounding,
  verifyUnderstandingAnswerGrounding,
  type UnderstandingAnswerDraft,
} from "./understanding-grounding"

export type UnderstandingWideQuestionEvalFixture = {
  id: string
  question: string
  templateId: UnderstandingPlanTemplateId
  expectedEvidenceCategories: UnderstandingPlannerTaskType[]
  keySymbols?: string[]
  keyPaths?: string[]
  keyConfigTerms?: string[]
  keyTests?: string[]
  answerClaims?: UnderstandingAnswerClaim[]
}

export type UnderstandingGoldEvidence = {
  path: string
  symbol?: string
  term?: string
  category?: UnderstandingPlannerTaskType
}

export type UnderstandingRealWorldEvalFixture = UnderstandingWideQuestionEvalFixture & {
  plan: EvidencePlan
  goldEvidence: UnderstandingGoldEvidence[]
  forbiddenEvidence: UnderstandingGoldEvidence[]
  evidenceByTask: Partial<Record<UnderstandingPlannerTaskType, EvidenceRef[]>>
  oldEvidence?: EvidenceRef[]
  deterministicAnswer?: UnderstandingAnswerDraft
}

export type UnderstandingAnswerClaim = {
  id: string
  text: string
  evidenceRefs: Array<{ path: string; startLine: number; endLine: number }>
}

export type UnderstandingEvalMetrics = {
  fixtureId: string
  evidenceRecall: UnderstandingEvidenceRecallMetrics
  answerGrounding: UnderstandingAnswerGroundingMetrics
  latencyBudget: UnderstandingLatencyBudgetMetrics
  fallback: UnderstandingFallbackMetrics
  comparison: UnderstandingComparisonReport
  realWorld?: UnderstandingRealWorldMetrics
  pass: boolean
}

export type UnderstandingRealWorldMetrics = {
  goldHit: UnderstandingGoldEvidence[]
  goldMissing: UnderstandingGoldEvidence[]
  forbiddenHit: UnderstandingGoldEvidence[]
  recallGain: number
  noiseIncrease: number
  verifierPass: boolean
  verifierFindings: string[]
}

export type UnderstandingEvidenceRecallMetrics = {
  expectedCategoriesHit: UnderstandingPlannerTaskType[]
  expectedCategoriesMissing: UnderstandingPlannerTaskType[]
  keySymbolsHit: string[]
  keySymbolsMissing: string[]
  keyPathsHit: string[]
  keyPathsMissing: string[]
  keyConfigHit: string[]
  keyConfigMissing: string[]
  keyTestsHit: string[]
  keyTestsMissing: string[]
  pass: boolean
}

export type UnderstandingAnswerGroundingMetrics = {
  claimCount: number
  groundedClaims: string[]
  ungroundedClaims: string[]
  pass: boolean
}

export type UnderstandingLatencyBudgetMetrics = {
  totalMs: number
  plannerMs: number
  retrievalMs: number
  aggregationMs: number
  withinBudget: boolean
  phaseCount: number
}

export type UnderstandingFallbackMetrics = {
  plannerInvalid: number
  timeout: number
  insufficientEvidence: number
  budgetExceeded: number
  fallbackReasons: string[]
}

export type UnderstandingComparisonReport = {
  oldTopK: string[]
  plannerTopK: string[]
  sharedTopK: string[]
  plannerOnlyTopK: string[]
  answerShape: string
  oldAnswerShape: string
  answerShapeChanged: boolean
}

export const UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES: UnderstandingWideQuestionEvalFixture[] = [
  {
    id: "performance-factors",
    question: "哪些因素会影响这个模块的处理速度",
    templateId: "performance-factor-analysis",
    expectedEvidenceCategories: ["semantic_search", "module_map", "call_expansion", "config_search", "test_search"],
    keySymbols: ["collect_work"],
    keyPaths: ["src/perf.c"],
    keyConfigTerms: ["threshold"],
    keyTests: ["test/perf.test.c"],
  },
  {
    id: "root-cause",
    question: "初始化失败的根因可能在哪里",
    templateId: "root-cause-analysis",
    expectedEvidenceCategories: ["semantic_search", "reference_search", "call_chain", "state_machine_search", "test_search"],
    keySymbols: ["init_entry"],
    keyPaths: ["src/init.c"],
  },
  {
    id: "architecture",
    question: "这几个目录的架构边界和依赖是什么",
    templateId: "architecture-understanding",
    expectedEvidenceCategories: ["module_map", "semantic_search", "reference_search"],
    keyPaths: ["src/core/mod.c"],
  },
  {
    id: "impact-surface",
    question: "改这个接口会影响哪些调用路径和模块",
    templateId: "architecture-understanding",
    expectedEvidenceCategories: ["module_map", "reference_search", "semantic_search"],
    keySymbols: ["public_api"],
  },
  {
    id: "state-flow",
    question: "状态迁移路径和异常回退有哪些",
    templateId: "state-flow-understanding",
    expectedEvidenceCategories: ["state_machine_search", "call_chain", "reference_search"],
    keySymbols: ["state_entry"],
  },
  {
    id: "test-impact",
    question: "这次行为变化需要补哪些测试",
    templateId: "test-impact-analysis",
    expectedEvidenceCategories: ["test_search", "reference_search", "call_expansion", "semantic_search"],
    keyTests: ["test/behavior.test.c"],
  },
  {
    id: "configuration-threshold",
    question: "配置阈值变化会影响哪些运行路径",
    templateId: "performance-factor-analysis",
    expectedEvidenceCategories: ["config_search", "semantic_search", "call_expansion", "test_search"],
    keyConfigTerms: ["watermark"],
  },
]

export const UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES: UnderstandingRealWorldEvalFixture[] = [
  realFixture({
    id: "real-gc-speed-factors",
    question: "提升 GC 速度的因素有哪些",
    templateId: "performance-factor-analysis",
    categories: ["semantic_search", "symbol_discovery", "module_map", "call_expansion", "config_search", "test_search"],
    concepts: ["gc_collect", "gc_lock", "GC_WATERMARK", "gc_benchmark"],
    goldEvidence: [
      { path: "src/gc.c", symbol: "gc_collect", term: "scan all blocks", category: "semantic_search" },
      { path: "src/gc.c", symbol: "gc_lock", term: "mutex", category: "call_expansion" },
      { path: "src/gc_config.h", term: "GC_WATERMARK", category: "config_search" },
      { path: "test/gc_perf.test.c", term: "benchmark", category: "test_search" },
    ],
    forbiddenEvidence: [
      { path: "src/gpio.c", term: "unrelated" },
      { path: "test/ui.test.c", term: "render" },
    ],
    evidenceByTask: {
      semantic_search: [
        evidenceRef("src/gc.c", 10, "gc_collect loops over scan all blocks before reclaim"),
        evidenceRef("src/gc.c", 18, "callback dispatch may hide generated-code edges"),
      ],
      symbol_discovery: [evidenceRef("src/gc.c", 4, "void gc_collect(void)")],
      module_map: [evidenceRef("src/gc.c", 1, "module gc owns reclaim boundary and worker queue")],
      call_expansion: [evidenceRef("src/gc.c", 42, "gc_lock mutex protects hot path around gc_collect")],
      config_search: [evidenceRef("src/gc_config.h", 7, "#define GC_WATERMARK 80 threshold limit")],
      test_search: [evidenceRef("test/gc_perf.test.c", 12, "benchmark gc_collect under high watermark")],
    },
    oldEvidence: [evidenceRef("src/gc.c", 10, "gc_collect loops over scan all blocks before reclaim")],
  }),
  realFixture({
    id: "real-root-cause-chain",
    question: "初始化失败的根因可能在哪里",
    templateId: "root-cause-analysis",
    categories: ["semantic_search", "reference_search", "call_chain", "state_machine_search", "test_search"],
    concepts: ["init_entry", "recover_path"],
    goldEvidence: [
      { path: "src/init.c", symbol: "init_entry", term: "fail" },
      { path: "src/init_state.c", term: "rollback" },
      { path: "test/init_failure.test.c", term: "failure" },
    ],
    forbiddenEvidence: [{ path: "src/demo_init.c", term: "sample" }],
    evidenceByTask: {
      semantic_search: [evidenceRef("src/init.c", 20, "init_entry returns error when config missing")],
      reference_search: [evidenceRef("src/init.c", 35, "recover_path handles fail and retry")],
      call_chain: [evidenceRef("src/init.c", 40, "call chain init_entry to recover_path")],
      state_machine_search: [evidenceRef("src/init_state.c", 9, "state transition INIT to ROLLBACK on failure")],
      test_search: [evidenceRef("test/init_failure.test.c", 6, "test init failure rollback")],
    },
  }),
  realFixture({
    id: "real-module-boundaries",
    question: "这几个目录的架构边界和依赖是什么",
    templateId: "architecture-understanding",
    categories: ["module_map", "semantic_search", "reference_search"],
    concepts: ["core_api", "storage_adapter"],
    goldEvidence: [
      { path: "src/core/api.c", symbol: "core_api" },
      { path: "src/storage/adapter.c", symbol: "storage_adapter" },
    ],
    forbiddenEvidence: [{ path: "docs/marketing.md", term: "architecture" }],
    evidenceByTask: {
      module_map: [evidenceRef("src/core/api.c", 1, "module boundary core owns public api and dependency direction")],
      semantic_search: [evidenceRef("src/storage/adapter.c", 11, "storage_adapter implements lower layer interface")],
      reference_search: [evidenceRef("src/core/api.c", 24, "core_api calls storage_adapter through interface")],
    },
  }),
  realFixture({
    id: "real-state-flow",
    question: "状态迁移路径和异常回退有哪些",
    templateId: "state-flow-understanding",
    categories: ["state_machine_search", "call_chain", "reference_search"],
    concepts: ["state_entry", "ERROR_RECOVER"],
    goldEvidence: [
      { path: "src/state.c", symbol: "state_entry" },
      { path: "src/state.c", term: "ERROR_RECOVER" },
    ],
    forbiddenEvidence: [{ path: "src/state_doc_sample.c", term: "example" }],
    evidenceByTask: {
      state_machine_search: [evidenceRef("src/state.c", 14, "state transition READY to ERROR_RECOVER guard timeout")],
      call_chain: [evidenceRef("src/state.c", 33, "state_entry dispatches rollback event")],
      reference_search: [evidenceRef("src/state.c", 49, "ERROR_RECOVER references recovery action")],
    },
  }),
  realFixture({
    id: "real-test-impact",
    question: "这次行为变化需要补哪些测试",
    templateId: "test-impact-analysis",
    categories: ["test_search", "reference_search", "call_expansion", "semantic_search"],
    concepts: ["public_api", "edge_case"],
    goldEvidence: [
      { path: "test/behavior.test.c", term: "edge_case" },
      { path: "src/api.c", symbol: "public_api" },
    ],
    forbiddenEvidence: [{ path: "test/snapshot.test.c", term: "ui" }],
    evidenceByTask: {
      test_search: [evidenceRef("test/behavior.test.c", 8, "test edge_case missing negative path coverage")],
      reference_search: [evidenceRef("src/api.c", 17, "public_api reference from behavior change")],
      call_expansion: [evidenceRef("src/api.c", 22, "caller hot path uses public_api")],
      semantic_search: [evidenceRef("src/api.c", 31, "behavior change requires validation")],
    },
  }),
  realFixture({
    id: "real-config-threshold",
    question: "配置阈值变化会影响哪些运行路径",
    templateId: "performance-factor-analysis",
    categories: ["config_search", "semantic_search", "call_expansion", "test_search"],
    concepts: ["QUEUE_WATERMARK", "schedule_work"],
    goldEvidence: [
      { path: "src/config.h", term: "QUEUE_WATERMARK" },
      { path: "src/scheduler.c", symbol: "schedule_work" },
    ],
    forbiddenEvidence: [{ path: "src/theme.css", term: "watermark" }],
    evidenceByTask: {
      config_search: [evidenceRef("src/config.h", 3, "#define QUEUE_WATERMARK 64 configuration threshold")],
      semantic_search: [evidenceRef("src/scheduler.c", 18, "schedule_work reads QUEUE_WATERMARK limit")],
      call_expansion: [evidenceRef("src/scheduler.c", 25, "queue scheduling path calls schedule_work frequently")],
      test_search: [evidenceRef("test/scheduler.test.c", 4, "test QUEUE_WATERMARK boundary")],
    },
  }),
]

export function evaluateUnderstandingFixture(input: {
  fixture: UnderstandingWideQuestionEvalFixture
  plan: EvidencePlan
  execution: UnderstandingPlanExecutionResult
  aggregation: UnderstandingEvidenceAggregation
  oldEvidence?: EvidenceRef[]
  plannerResult?: UnderstandingPlannerResult
  maxTotalLatencyMs?: number
  oldAnswerShape?: string
}): UnderstandingEvalMetrics {
  const evidenceRecall = evaluateEvidenceRecall(input.fixture, input.plan, input.aggregation)
  const answerGrounding = evaluateAnswerGrounding(input.fixture.answerClaims ?? claimsFromFactors(input.aggregation.factors))
  const latencyBudget = evaluateLatencyBudget(input.execution, input.plannerResult, input.maxTotalLatencyMs ?? 3000)
  const fallback = evaluateFallback(input.plannerResult, input.execution)
  const comparison = compareOldVsPlannerEvidence({
    oldEvidence: input.oldEvidence ?? [],
    aggregation: input.aggregation,
    answerShape: input.plan.answerShape,
    oldAnswerShape: input.oldAnswerShape ?? "legacy_query_evidence",
  })
  return {
    fixtureId: input.fixture.id,
    evidenceRecall,
    answerGrounding,
    latencyBudget,
    fallback,
    comparison,
    pass: evidenceRecall.pass && answerGrounding.pass && latencyBudget.withinBudget,
  }
}

export async function runUnderstandingRealWorldEvalFixture(
  fixture: UnderstandingRealWorldEvalFixture,
): Promise<UnderstandingEvalMetrics> {
  const planner = new UnderstandingPlanner({
    provider: async () => fixture.plan,
  })
  const plannerResult = await planner.plan({
    question: fixture.question,
    relatedPaths: [...new Set(fixture.goldEvidence.map((item) => item.path))],
    codeGraphState: "ready",
  })
  if (plannerResult.kind !== "planned") {
    const emptyExecution: UnderstandingPlanExecutionResult = {
      results: [],
      evidenceCount: 0,
      trace: plannerResult.trace,
      phaseTrace: [],
    }
    const emptyAggregation: UnderstandingEvidenceAggregation = {
      factors: [],
      claims: [],
      evidenceCount: 0,
      omittedDuplicateEvidence: 0,
      gaps: ["planner did not produce a plan"],
    }
    return {
      ...evaluateUnderstandingFixture({
        fixture,
        plan: fixture.plan,
        execution: emptyExecution,
        aggregation: emptyAggregation,
        plannerResult,
        oldEvidence: fixture.oldEvidence,
      }),
      realWorld: {
        goldHit: [],
        goldMissing: fixture.goldEvidence,
        forbiddenHit: [],
        recallGain: 0,
        noiseIncrease: 0,
        verifierPass: false,
        verifierFindings: ["planner did not produce a plan"],
      },
      pass: false,
    }
  }
  const execution = await executeEvidencePlan({
    plan: plannerResult.plan,
    relatedPaths: [...new Set(fixture.goldEvidence.map((item) => item.path))],
    maxTasks: 20,
    maxFanout: 4,
    codeGraph: evalCodeGraphProvider(fixture),
  })
  const aggregation = aggregateUnderstandingEvidence(plannerResult.plan, execution)
  const answer = fixture.deterministicAnswer ?? draftAnswerFromUnderstandingClaims(aggregation.claims)
  const repaired = repairUnderstandingAnswerGrounding({
    answer,
    aggregation,
    coverage: { codeGraphState: "ready", retrievalMode: "hybrid" },
  })
  const verification = verifyUnderstandingAnswerGrounding({
    answer: repaired.answer,
    aggregation,
    coverage: { codeGraphState: "ready", retrievalMode: "hybrid" },
  })
  const realWorld = evaluateRealWorldMetrics(fixture, aggregation, verification.pass, verification.findings.map((finding) => `${finding.severity}:${finding.code}`))
  const base = evaluateUnderstandingFixture({
    fixture,
    plan: plannerResult.plan,
    execution,
    aggregation,
    plannerResult,
    oldEvidence: fixture.oldEvidence,
    maxTotalLatencyMs: 3000,
  })
  return {
    ...base,
    realWorld,
    pass: base.pass && realWorld.goldMissing.length === 0 && realWorld.forbiddenHit.length === 0 && realWorld.verifierPass,
  }
}

export async function runUnderstandingRealWorldEval(fixtures = UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES) {
  const results = []
  for (const fixture of fixtures) results.push(await runUnderstandingRealWorldEvalFixture(fixture))
  return {
    results,
    pass: results.every((result) => result.pass),
  }
}

export function validateUnderstandingEvalFixtures(fixtures = UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES) {
  const supportedTemplates = new Set(Object.keys(UNDERSTANDING_PLAN_TEMPLATES))
  return fixtures.map((fixture) => {
    const template = UNDERSTANDING_PLAN_TEMPLATES[fixture.templateId]
    const missingTemplate = supportedTemplates.has(fixture.templateId) ? [] : [fixture.templateId]
    const expectedMissingFromTemplate = fixture.expectedEvidenceCategories.filter((category) => !template.evidenceTypes.includes(category as never))
    return {
      fixtureId: fixture.id,
      missingTemplate,
      expectedMissingFromTemplate,
      pass: missingTemplate.length === 0 && expectedMissingFromTemplate.length === 0,
    }
  })
}

export function validateUnderstandingRealWorldEvalFixtures(fixtures = UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES) {
  return fixtures.map((fixture) => {
    const missingGold = fixture.goldEvidence.length === 0 ? ["goldEvidence"] : []
    const missingForbidden = fixture.forbiddenEvidence.length === 0 ? ["forbiddenEvidence"] : []
    const missingTasks = fixture.expectedEvidenceCategories.filter((category) => !fixture.plan.tasks.some((task) => task.type === category))
    return {
      fixtureId: fixture.id,
      missingGold,
      missingForbidden,
      missingTasks,
      pass: missingGold.length === 0 && missingForbidden.length === 0 && missingTasks.length === 0,
    }
  })
}

export function compareOldVsPlannerEvidence(input: {
  oldEvidence: EvidenceRef[]
  aggregation: UnderstandingEvidenceAggregation
  answerShape: string
  oldAnswerShape: string
}): UnderstandingComparisonReport {
  const oldTopK = input.oldEvidence.slice(0, 8).map((item) => evidenceKey(item.file, item.startLine, item.endLine))
  const plannerTopK = input.aggregation.factors
    .flatMap((factor) => factor.supportingEvidence.map((item) => evidenceKey(item.path, item.startLine, item.endLine)))
    .slice(0, 8)
  const oldSet = new Set(oldTopK)
  return {
    oldTopK,
    plannerTopK,
    sharedTopK: plannerTopK.filter((item) => oldSet.has(item)),
    plannerOnlyTopK: plannerTopK.filter((item) => !oldSet.has(item)),
    answerShape: input.answerShape,
    oldAnswerShape: input.oldAnswerShape,
    answerShapeChanged: input.answerShape !== input.oldAnswerShape,
  }
}

function evaluateEvidenceRecall(
  fixture: UnderstandingWideQuestionEvalFixture,
  plan: EvidencePlan,
  aggregation: UnderstandingEvidenceAggregation,
): UnderstandingEvidenceRecallMetrics {
  const taskTypes = new Set(plan.tasks.map((task) => task.type))
  const expectedCategoriesHit = fixture.expectedEvidenceCategories.filter((category) => taskTypes.has(category))
  const expectedCategoriesMissing = fixture.expectedEvidenceCategories.filter((category) => !taskTypes.has(category))
  const text = searchableEvidenceText(aggregation)
  const keySymbolsHit = hits(fixture.keySymbols ?? [], text)
  const keyPathsHit = hits(fixture.keyPaths ?? [], text)
  const keyConfigHit = hits(fixture.keyConfigTerms ?? [], text)
  const keyTestsHit = hits(fixture.keyTests ?? [], text)
  return {
    expectedCategoriesHit,
    expectedCategoriesMissing,
    keySymbolsHit,
    keySymbolsMissing: misses(fixture.keySymbols ?? [], keySymbolsHit),
    keyPathsHit,
    keyPathsMissing: misses(fixture.keyPaths ?? [], keyPathsHit),
    keyConfigHit,
    keyConfigMissing: misses(fixture.keyConfigTerms ?? [], keyConfigHit),
    keyTestsHit,
    keyTestsMissing: misses(fixture.keyTests ?? [], keyTestsHit),
    pass: expectedCategoriesMissing.length === 0 &&
      misses(fixture.keySymbols ?? [], keySymbolsHit).length === 0 &&
      misses(fixture.keyPaths ?? [], keyPathsHit).length === 0 &&
      misses(fixture.keyConfigTerms ?? [], keyConfigHit).length === 0 &&
      misses(fixture.keyTests ?? [], keyTestsHit).length === 0,
  }
}

function evaluateAnswerGrounding(claims: UnderstandingAnswerClaim[]): UnderstandingAnswerGroundingMetrics {
  const groundedClaims = claims.filter((claim) => claim.evidenceRefs.length > 0).map((claim) => claim.id)
  const ungroundedClaims = claims.filter((claim) => claim.evidenceRefs.length === 0).map((claim) => claim.id)
  return {
    claimCount: claims.length,
    groundedClaims,
    ungroundedClaims,
    pass: ungroundedClaims.length === 0,
  }
}

function evaluateLatencyBudget(
  execution: UnderstandingPlanExecutionResult,
  plannerResult: UnderstandingPlannerResult | undefined,
  maxTotalLatencyMs: number,
): UnderstandingLatencyBudgetMetrics {
  const plannerMs = plannerResult?.trace.latency_ms ?? 0
  const retrievalMs = execution.trace.latency_ms
  const aggregationPhase = execution.phaseTrace.find((phase) => phase.phase === "aggregation")
  const aggregationMs = aggregationPhase ? 0 : 0
  const totalMs = plannerMs + retrievalMs + aggregationMs
  return {
    totalMs,
    plannerMs,
    retrievalMs,
    aggregationMs,
    withinBudget: totalMs <= maxTotalLatencyMs,
    phaseCount: execution.phaseTrace.length,
  }
}

function evaluateFallback(
  plannerResult: UnderstandingPlannerResult | undefined,
  execution: UnderstandingPlanExecutionResult,
): UnderstandingFallbackMetrics {
  const fallbackReason = plannerResult?.trace.fallback_reason
  const fallbackReasons = fallbackReason ? [fallbackReason] : []
  return {
    plannerInvalid: fallbackReasons.filter((reason) => reason.includes("invalid") || reason.includes("missing") || reason.includes("unknown")).length,
    timeout: fallbackReasons.filter((reason) => reason.includes("timeout")).length,
    insufficientEvidence: execution.evidenceCount === 0 ? 1 : 0,
    budgetExceeded: fallbackReasons.filter((reason) => reason.includes("budget")).length,
    fallbackReasons,
  }
}

function claimsFromFactors(factors: UnderstandingFactor[]): UnderstandingAnswerClaim[] {
  return factors
    .filter((factor) => !factor.hypothesis)
    .map((factor) => ({
      id: factor.category,
      text: factor.label,
      evidenceRefs: factor.supportingEvidence.map((evidence) => ({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
      })),
    }))
}

function searchableEvidenceText(aggregation: UnderstandingEvidenceAggregation) {
  return aggregation.factors
    .flatMap((factor) => [
      factor.label,
      factor.category,
      ...factor.supportingEvidence.flatMap((evidence) => [evidence.path, evidence.snippet ?? "", evidence.snippetHash]),
    ])
    .join("\n")
    .toLowerCase()
}

function hits(items: string[], text: string) {
  return items.filter((item) => text.includes(item.toLowerCase()))
}

function misses(items: string[], hitItems: string[]) {
  const hitSet = new Set(hitItems)
  return items.filter((item) => !hitSet.has(item))
}

function evidenceKey(path: string, startLine: number, endLine: number) {
  return `${path}:${startLine}-${endLine}`
}

function realFixture(input: {
  id: string
  question: string
  templateId: UnderstandingPlanTemplateId
  categories: UnderstandingPlannerTaskType[]
  concepts: string[]
  goldEvidence: UnderstandingGoldEvidence[]
  forbiddenEvidence: UnderstandingGoldEvidence[]
  evidenceByTask: Partial<Record<UnderstandingPlannerTaskType, EvidenceRef[]>>
  oldEvidence?: EvidenceRef[]
}): UnderstandingRealWorldEvalFixture {
  return {
    id: input.id,
    question: input.question,
    templateId: input.templateId,
    expectedEvidenceCategories: input.categories,
    keySymbols: input.goldEvidence.map((item) => item.symbol).filter((item): item is string => Boolean(item)),
    keyPaths: input.goldEvidence.map((item) => item.path),
    keyConfigTerms: input.goldEvidence.filter((item) => item.category === "config_search").map((item) => item.term).filter((item): item is string => Boolean(item)),
    keyTests: input.goldEvidence.filter((item) => item.path.includes("test/")).map((item) => item.path),
    plan: {
      templateId: input.templateId,
      questionSummary: input.question,
      concepts: input.concepts,
      hypotheses: input.concepts.map((concept) => `Check evidence around ${concept}`),
      tasks: input.categories.map((category) => ({
        type: category,
        query: queryForRealFixtureTask(input.concepts, category),
        symbol: category === "call_expansion" || category === "call_chain" || category === "reference_search"
          ? input.concepts.find((concept) => /^[A-Za-z_]\w+$/.test(concept))
          : undefined,
        direction: category === "call_expansion" ? "both" : undefined,
        reason: `real-world fixture ${input.id}`,
      })),
      answerShape: UNDERSTANDING_PLAN_TEMPLATES[input.templateId].answerShape,
      riskNotes: ["Fixture requires gold evidence and forbidden evidence checks."],
    },
    goldEvidence: input.goldEvidence,
    forbiddenEvidence: input.forbiddenEvidence,
    evidenceByTask: input.evidenceByTask,
    oldEvidence: input.oldEvidence,
  }
}

function queryForRealFixtureTask(concepts: string[], category: UnderstandingPlannerTaskType) {
  const base = concepts.join(" ")
  if (category === "config_search") return `task:config_search ${base} config threshold watermark limit`
  if (category === "test_search") return `task:test_search ${base} test benchmark coverage`
  if (category === "state_machine_search") return `task:state_machine_search ${base} state transition guard rollback`
  if (category === "module_map") return `task:module_map ${base} module boundary dependency owner`
  return `task:${category} ${base}`
}

function evalCodeGraphProvider(fixture: UnderstandingRealWorldEvalFixture) {
  return {
    queryEvidence: async (query: string) => queryEvidenceResult(queryEvidenceForTask(fixture, query)),
    findSymbols: async () => fixture.goldEvidence
      .filter((item) => item.symbol)
      .map((item) => ({
        id: `${item.path}:${item.symbol!}`,
        name: item.symbol!,
        kind: "function" as const,
        path: item.path,
        startLine: 1,
        endLine: 3,
        signature: `void ${item.symbol!}(void)`,
        snippet: `${item.symbol!} ${item.term ?? ""}`,
        score: 1,
        reason: "real-world fixture symbol",
      })),
    runAnalysisTool: async (input: { tool: string; args?: { query?: string; symbol?: string; target?: string } }) => {
      const taskType = toolTaskType(input.tool)
      return analysisToolResult(input.tool, taskType ? (fixture.evidenceByTask[taskType] ?? []) : [])
    },
  }
}

function queryEvidenceForTask(fixture: UnderstandingRealWorldEvalFixture, query: string) {
  const lower = query.toLowerCase()
  if (lower.includes("task:test_search")) return fixture.evidenceByTask.test_search ?? []
  if (lower.includes("task:config_search")) return fixture.evidenceByTask.config_search ?? []
  if (lower.includes("task:semantic_search")) return fixture.evidenceByTask.semantic_search ?? []
  if (/test|benchmark|coverage|测试|基准/.test(lower)) return fixture.evidenceByTask.test_search ?? []
  if (/config|threshold|watermark|limit|配置|阈值/.test(lower)) return fixture.evidenceByTask.config_search ?? []
  return fixture.evidenceByTask.semantic_search ?? []
}

function toolTaskType(tool: string): UnderstandingPlannerTaskType | undefined {
  if (tool === "getModuleMap") return "module_map"
  if (tool === "getCallers" || tool === "getCallees") return "call_expansion"
  if (tool === "getCallChain") return "call_chain"
  if (tool === "search") return "reference_search"
  if (tool === "getStateMachines" || tool === "getStatePath") return "state_machine_search"
  return undefined
}

function evaluateRealWorldMetrics(
  fixture: UnderstandingRealWorldEvalFixture,
  aggregation: UnderstandingEvidenceAggregation,
  verifierPass: boolean,
  verifierFindings: string[],
): UnderstandingRealWorldMetrics {
  const text = searchableEvidenceText(aggregation)
  const goldHit = fixture.goldEvidence.filter((gold) => goldEvidenceMatches(gold, text))
  const forbiddenHit = fixture.forbiddenEvidence.filter((forbidden) => goldEvidenceMatches(forbidden, text))
  const oldText = (fixture.oldEvidence ?? []).map((item) => `${item.file}\n${item.snippet ?? ""}\n${item.snippetHash}`).join("\n").toLowerCase()
  const oldGoldHit = fixture.goldEvidence.filter((gold) => goldEvidenceMatches(gold, oldText))
  const oldForbiddenHit = fixture.forbiddenEvidence.filter((forbidden) => goldEvidenceMatches(forbidden, oldText))
  return {
    goldHit,
    goldMissing: fixture.goldEvidence.filter((gold) => !goldHit.includes(gold)),
    forbiddenHit,
    recallGain: goldHit.length - oldGoldHit.length,
    noiseIncrease: forbiddenHit.length - oldForbiddenHit.length,
    verifierPass,
    verifierFindings,
  }
}

function goldEvidenceMatches(gold: UnderstandingGoldEvidence, text: string) {
  if (!text.includes(gold.path.toLowerCase())) return false
  if (gold.symbol && !text.includes(gold.symbol.toLowerCase())) return false
  if (gold.term && !text.includes(gold.term.toLowerCase())) return false
  return true
}

function queryEvidenceResult(evidence: EvidenceRef[]): QueryEvidenceResult {
  return {
    stateMachines: [],
    summaries: {
      functions: [],
      files: [],
      modules: [],
      subsystems: [],
    },
    evidencePack: {
      evidence,
      text: evidence.map((item) => `<evidence path="${item.file}" lines="${item.startLine}-${item.endLine}">${item.snippet ?? ""}</evidence>`).join("\n"),
      packedBytes: evidence.reduce((sum, item) => sum + (item.snippet?.length ?? 0), 0),
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: "real-world-eval",
      question: "real-world-eval",
      intent: "unknown",
      steps: [],
      evidence,
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: evidence.length ? "high" : "none",
      reason: "real-world eval fixture",
      requiredCitation: "cite fixture evidence",
    },
    suggestedAnswer: "",
  }
}

function analysisToolResult(tool: string, evidence: EvidenceRef[]): AnalysisToolResult {
  return {
    ok: true,
    traceId: `real-world-${tool}`,
    tool: tool as AnalysisToolResult["tool"],
    elapsedMs: 1,
    evidence,
    data: {},
    audit: {
      traceId: `real-world-${tool}`,
      tool,
      argsSummary: "",
      evidenceCount: evidence.length,
      elapsedMs: 1,
      blocked: false,
    },
    truncated: false,
    omittedEvidence: 0,
  }
}

function evidenceRef(file: string, startLine: number, snippet: string): EvidenceRef {
  return {
    file,
    startLine,
    endLine: startLine + 2,
    snippetHash: snippet,
    parserKind: "real-world-fixture",
    snippet,
  }
}
