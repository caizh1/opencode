import { describe, expect, test } from "bun:test"
import type { EvidenceRef } from "../src/analysis-types"
import {
  UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES,
  UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES,
  compareOldVsPlannerEvidence,
  evaluateUnderstandingFixture,
  runUnderstandingRealWorldEval,
  runUnderstandingRealWorldEvalFixture,
  validateUnderstandingEvalFixtures,
  validateUnderstandingRealWorldEvalFixtures,
} from "../src/understanding-eval"
import type {
  EvidencePlan,
  UnderstandingEvidenceAggregation,
  UnderstandingPlanExecutionResult,
  UnderstandingPlannerTaskType,
} from "../src/understanding-planner"

describe("understanding eval fixtures and metrics", () => {
  test("covers wide question categories with expected evidence categories instead of fixed answers", () => {
    const ids = UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES.map((fixture) => fixture.id)
    expect(ids).toEqual(expect.arrayContaining([
      "performance-factors",
      "architecture",
      "root-cause",
      "impact-surface",
      "state-flow",
      "test-impact",
      "configuration-threshold",
    ]))

    for (const fixture of UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES) {
      expect(fixture.question).toBeTruthy()
      expect(fixture.expectedEvidenceCategories.length).toBeGreaterThan(0)
      expect(JSON.stringify(fixture)).not.toContain("expectedAnswer")
    }
  })

  test("validates template-declared evidence categories", () => {
    const results = validateUnderstandingEvalFixtures()

    expect(results.every((result) => result.pass)).toBe(true)
    expect(results.flatMap((result) => result.expectedMissingFromTemplate)).toEqual([])
  })

  test("validates real-world fixtures with gold and forbidden evidence contracts", () => {
    const ids = UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES.map((fixture) => fixture.id)
    expect(ids).toEqual(expect.arrayContaining([
      "real-gc-speed-factors",
      "real-root-cause-chain",
      "real-module-boundaries",
      "real-state-flow",
      "real-test-impact",
      "real-config-threshold",
    ]))
    const results = validateUnderstandingRealWorldEvalFixtures()

    expect(results.every((result) => result.pass)).toBe(true)
    expect(results.flatMap((result) => result.missingGold)).toEqual([])
    expect(results.flatMap((result) => result.missingForbidden)).toEqual([])
    expect(results.flatMap((result) => result.missingTasks)).toEqual([])
  })

  test("runs the real-world understanding eval through planner execution and aggregation", async () => {
    const fixture = UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES.find((item) => item.id === "real-gc-speed-factors")
    if (!fixture) throw new Error("missing real-world fixture")
    const metrics = await runUnderstandingRealWorldEvalFixture(fixture)

    expect(metrics.pass).toBe(true)
    expect(metrics.realWorld?.goldMissing).toEqual([])
    expect(metrics.realWorld?.forbiddenHit).toEqual([])
    expect(metrics.realWorld?.recallGain).toBeGreaterThan(0)
    expect(metrics.realWorld?.verifierPass).toBe(true)
    expect(metrics.comparison.plannerOnlyTopK.length).toBeGreaterThan(0)
  })

  test("real-world eval gate fails closed when a gold evidence item is missing", async () => {
    const fixture = {
      ...UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES[0],
      goldEvidence: [
        ...UNDERSTANDING_REAL_WORLD_EVAL_FIXTURES[0].goldEvidence,
        { path: "src/gc_missing.c", term: "must-hit" },
      ],
    }
    const gate = await runUnderstandingRealWorldEval([fixture])

    expect(gate.pass).toBe(false)
    expect(gate.results[0]?.realWorld?.goldMissing).toEqual([{ path: "src/gc_missing.c", term: "must-hit" }])
  })

  test("computes evidence recall, answer grounding, latency, fallback, and comparison metrics", () => {
    const fixture = UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES.find((item) => item.id === "performance-factors")
    if (!fixture) throw new Error("missing fixture")
    const plan = planForFixture(fixture.expectedEvidenceCategories)
    const aggregation = aggregationForFixture()
    const execution = executionResult(plan)
    const metrics = evaluateUnderstandingFixture({
      fixture,
      plan,
      aggregation,
      execution,
      oldEvidence: [evidenceRef("src/legacy.c", 1, "legacy_path")],
      plannerResult: {
        kind: "planned",
        plan,
        trace: {
          planner_used: true,
          task_count: plan.tasks.length,
          evidence_count: execution.evidenceCount,
          latency_ms: 12,
        },
      },
      maxTotalLatencyMs: 3000,
      oldAnswerShape: "legacy_query_evidence",
    })

    expect(metrics.pass).toBe(true)
    expect(metrics.evidenceRecall.expectedCategoriesMissing).toEqual([])
    expect(metrics.evidenceRecall.keySymbolsMissing).toEqual([])
    expect(metrics.evidenceRecall.keyPathsMissing).toEqual([])
    expect(metrics.evidenceRecall.keyConfigMissing).toEqual([])
    expect(metrics.evidenceRecall.keyTestsMissing).toEqual([])
    expect(metrics.answerGrounding.ungroundedClaims).toEqual([])
    expect(metrics.latencyBudget).toMatchObject({ withinBudget: true, plannerMs: 12 })
    expect(metrics.fallback).toMatchObject({ plannerInvalid: 0, timeout: 0, insufficientEvidence: 0, budgetExceeded: 0 })
    expect(metrics.comparison.answerShapeChanged).toBe(true)
    expect(metrics.comparison.plannerOnlyTopK.length).toBeGreaterThan(0)
  })

  test("flags ungrounded answer claims and fallback reasons", () => {
    const fixture = {
      ...UNDERSTANDING_WIDE_QUESTION_EVAL_FIXTURES[0],
      answerClaims: [
        { id: "grounded", text: "grounded", evidenceRefs: [{ path: "src/perf.c", startLine: 10, endLine: 12 }] },
        { id: "ungrounded", text: "ungrounded", evidenceRefs: [] },
      ],
    }
    const plan = planForFixture(fixture.expectedEvidenceCategories)
    const execution = executionResult(plan, 0)
    const metrics = evaluateUnderstandingFixture({
      fixture,
      plan,
      aggregation: { ...aggregationForFixture(), factors: [], evidenceCount: 0 },
      execution,
      plannerResult: {
        kind: "fallback",
        reason: "planner-timeout",
        trace: {
          planner_used: true,
          fallback_reason: "planner-timeout",
          task_count: 0,
          evidence_count: 0,
          latency_ms: 3001,
        },
      },
      maxTotalLatencyMs: 10,
    })

    expect(metrics.pass).toBe(false)
    expect(metrics.answerGrounding.ungroundedClaims).toEqual(["ungrounded"])
    expect(metrics.fallback.timeout).toBe(1)
    expect(metrics.fallback.insufficientEvidence).toBe(1)
    expect(metrics.latencyBudget.withinBudget).toBe(false)
  })

  test("compares old-path and planner top-k evidence", () => {
    const report = compareOldVsPlannerEvidence({
      oldEvidence: [
        evidenceRef("src/shared.c", 1, "shared"),
        evidenceRef("src/old.c", 2, "old"),
      ],
      aggregation: {
        ...aggregationForFixture(),
        factors: [{
          label: "Factor",
          category: "general",
          confidence: "medium",
          strength: "direct",
          hypothesis: false,
          gaps: [],
          supportingEvidence: [
            { path: "src/shared.c", startLine: 1, endLine: 3, snippetHash: "shared", source: "queryEvidence", taskType: "semantic_search" },
            { path: "src/new.c", startLine: 4, endLine: 6, snippetHash: "new", source: "analysisTool", taskType: "module_map" },
          ],
        }],
      },
      answerShape: "factor_grouped",
      oldAnswerShape: "legacy_query_evidence",
    })

    expect(report.sharedTopK).toEqual(["src/shared.c:1-3"])
    expect(report.plannerOnlyTopK).toEqual(["src/new.c:4-6"])
    expect(report.answerShapeChanged).toBe(true)
  })
})

function planForFixture(categories: UnderstandingPlannerTaskType[]): EvidencePlan {
  return {
    templateId: "performance-factor-analysis",
    questionSummary: "wide question",
    concepts: ["collect_work", "threshold"],
    hypotheses: [],
    tasks: categories.map((category) => ({
      type: category,
      query: category,
      symbol: category === "call_expansion" ? "collect_work" : undefined,
      direction: category === "call_expansion" ? "both" : undefined,
    })),
    answerShape: "factor_grouped",
    riskNotes: [],
  }
}

function executionResult(plan: EvidencePlan, evidenceCount = 4): UnderstandingPlanExecutionResult {
  return {
    results: [],
    evidenceCount,
    trace: {
      planner_used: true,
      task_count: plan.tasks.length,
      evidence_count: evidenceCount,
      latency_ms: 20,
    },
    phaseTrace: [
      {
        phase: "discovery",
        reason: "test",
        inputTasks: 1,
        outputTasks: 1,
        evidenceCount,
        seedSymbols: ["collect_work"],
        truncated: false,
      },
      {
        phase: "aggregation",
        reason: "test",
        inputTasks: 1,
        outputTasks: 1,
        evidenceCount,
        seedSymbols: ["collect_work"],
        truncated: false,
      },
    ],
  }
}

function aggregationForFixture(): UnderstandingEvidenceAggregation {
  return {
    evidenceCount: 4,
    omittedDuplicateEvidence: 0,
    gaps: [],
    factors: [
      {
        label: "Call frequency and hot paths",
        category: "call_frequency",
        confidence: "high",
        strength: "direct",
        hypothesis: false,
        gaps: [],
        supportingEvidence: [
          {
            path: "src/perf.c",
            startLine: 10,
            endLine: 12,
            snippetHash: "collect_work",
            source: "analysisTool",
            taskType: "call_expansion",
            snippet: "collect_work threshold test/perf.test.c",
          },
        ],
      },
      {
        label: "Tests and benchmarks",
        category: "tests_benchmarks",
        confidence: "medium",
        strength: "direct",
        hypothesis: false,
        gaps: [],
        supportingEvidence: [
          {
            path: "test/perf.test.c",
            startLine: 3,
            endLine: 4,
            snippetHash: "perf-test",
            source: "queryEvidence",
            taskType: "test_search",
            snippet: "collect_work threshold benchmark",
          },
        ],
      },
    ],
  }
}

function evidenceRef(file: string, startLine: number, hash: string): EvidenceRef {
  return {
    file,
    startLine,
    endLine: startLine + 2,
    snippetHash: hash,
    parserKind: "test",
    snippet: hash,
  }
}
