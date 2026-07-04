import { describe, expect, test } from "bun:test"
import {
  UNDERSTANDING_PLAN_TEMPLATES,
  UnderstandingPlanner,
  aggregateUnderstandingEvidence,
  evaluateUnderstandingRoutingFixtures,
  executeEvidencePlan,
  understandingFastPathReason,
  validateEvidencePlan,
} from "../src/understanding-planner"

describe("UnderstandingPlanner", () => {
  test("uses fast path only for explicit graph-style questions", async () => {
    expect(understandingFastPathReason("谁调用了 nand_read_page")).toBe("callers")
    expect(understandingFastPathReason("nand_read_page 调用了谁")).toBe("callees")
    expect(understandingFastPathReason("show call chain from submit_io to nand_read_page")).toBe("call-chain")
    expect(understandingFastPathReason("找 nand_read_page 的引用")).toBe("references")
    expect(understandingFastPathReason("解释 nand_read_page")).toBe("inspect-symbol")
    expect(understandingFastPathReason("提升 GC 速度的因素有哪些")).toBeUndefined()
    expect(understandingFastPathReason("谁调用 gc_collect，会不会影响性能")).toBeUndefined()

    const planner = new UnderstandingPlanner({
      provider: async () => {
        throw new Error("provider should not run for fast path")
      },
    })
    const result = await planner.plan({
      question: "谁调用了 nand_read_page",
      relatedPaths: [],
    })

    expect(result.kind).toBe("fast-path")
    expect(result.trace.planner_used).toBe(false)
    expect(result.trace.fast_path_reason).toBe("callers")
  })

  test("audits fast-path routing for narrow, broad, mixed, follow-up, and multilingual questions", () => {
    const results = evaluateUnderstandingRoutingFixtures([
      { id: "narrow-callers", question: "谁调用了 nand_read_page", expected: "fast-path", reason: "callers" },
      { id: "broad-performance", question: "提升 GC 速度的因素有哪些", expected: "planner" },
      { id: "mixed-callers-performance", question: "谁调用 gc_collect，会不会影响性能", expected: "planner" },
      { id: "follow-up-ellipsis", question: "那配置阈值呢", expected: "planner" },
      { id: "english-architecture", question: "What are the architecture boundaries of this module", expected: "planner" },
    ])

    expect(results.every((result) => result.pass)).toBe(true)
    expect(results.find((result) => result.id === "mixed-callers-performance")?.actual).toBe("planner")
  })

  test("validates broad-question evidence plans from JSON", () => {
    const plan = validateEvidencePlan(JSON.stringify(gcSpeedPlan()))

    expect(plan.questionSummary).toContain("GC")
    expect(plan.tasks.map((task) => task.type)).toEqual([
      "semantic_search",
      "symbol_discovery",
      "module_map",
      "config_search",
      "test_search",
      "call_expansion",
    ])
  })

  test("rejects unknown planner task types", () => {
    expect(() =>
      validateEvidencePlan({
        ...gcSpeedPlan(),
        tasks: [{ type: "magic_answer", query: "gc" }],
      }),
    ).toThrow("planner-unknown-task")
  })

  test("validates supported templates and rejects unknown template ids", () => {
    for (const templateId of Object.keys(UNDERSTANDING_PLAN_TEMPLATES)) {
      expect(validateEvidencePlan({ ...gcSpeedPlan(), templateId }).templateId).toBe(templateId)
    }

    expect(() =>
      validateEvidencePlan({
        ...gcSpeedPlan(),
        templateId: "project-specific-template",
      }),
    ).toThrow("planner-unknown-template")
  })

  test("falls back when planner output is invalid", async () => {
    const planner = new UnderstandingPlanner({
      provider: async () => ({ tasks: [{ type: "semantic_search", query: "gc" }] }),
    })

    const result = await planner.plan({
      question: "提升 GC 速度的因素有哪些",
      relatedPaths: ["src/gc.c"],
      codeGraphState: "ready",
    })

    expect(result.kind).toBe("fallback")
    expect(result.trace.planner_used).toBe(true)
    expect(result.trace.fallback_reason).toBe("planner-missing-questionSummary")
  })

  test("falls back when planner exceeds timeout", async () => {
    const planner = new UnderstandingPlanner({
      timeoutMs: 1,
      provider: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return gcSpeedPlan()
      },
    })

    const result = await planner.plan({
      question: "提升 GC 速度的因素有哪些",
      relatedPaths: [],
    })

    expect(result.kind).toBe("fallback")
    expect(result.trace.fallback_reason).toBe("planner-timeout")
  })

  test("plans non-fast-path questions through the provider", async () => {
    const planner = new UnderstandingPlanner({
      provider: async (input) => ({
        ...gcSpeedPlan(),
        questionSummary: input.question,
      }),
    })

    const result = await planner.plan({
      question: "提升 GC 速度的因素有哪些",
      relatedPaths: ["src/gc.c"],
      rag: {
        enabled: true,
        availability: "ready",
        indexAvailability: "ready",
        embeddingEnabled: true,
      },
    })

    expect(result.kind).toBe("planned")
    if (result.kind !== "planned") return
    expect(result.plan.tasks.length).toBeGreaterThan(1)
    expect(result.trace.planner_used).toBe(true)
    expect(result.trace.task_count).toBe(result.plan.tasks.length)
  })

  test("maps planner tasks onto existing CodeGraph evidence APIs", async () => {
    const calls: string[] = []
    const result = await executeEvidencePlan({
      plan: gcSpeedPlan(),
      relatedPaths: ["src/gc.c"],
      queryOptions: { retrievalMode: "graph-only" },
      codeGraph: {
        queryEvidence: async (question, options) => {
          calls.push(`query:${question}:${options?.retrievalMode}:${options?.relatedPaths?.join(",")}`)
          return queryEvidenceResult()
        },
        findSymbols: async (input) => {
          calls.push(`symbols:${input.query}:${input.relatedPath}`)
          return [
            {
              name: input.query,
              kind: "function",
              path: "src/gc.c",
              startLine: 10,
              endLine: 20,
              signature: "void gc_collect(void)",
              snippet: "void gc_collect(void) {}",
              score: 1,
              reason: "test",
            },
          ]
        },
        runAnalysisTool: async (input) => {
          calls.push(`tool:${input.tool}:${input.args?.query ?? input.args?.symbol}`)
          return analysisToolResult(input.tool)
        },
      },
    })

    expect(calls).toContain("query:gc speed latency performance:graph-only:src/gc.c")
    expect(calls).toContain("symbols:gc:src/gc.c")
    expect(calls).toContain("tool:getModuleMap:gc")
    expect(calls).toContain("query:gc threshold batch interval:graph-only:src/gc.c")
    expect(calls).toContain("query:gc performance benchmark:graph-only:src/gc.c")
    expect(calls).toContain("tool:getCallers:gc_collect")
    expect(calls).toContain("tool:getCallees:gc_collect")
    expect(calls).toContain("tool:getStateMachines:GC speed latency")
    expect(result.results.length).toBeGreaterThanOrEqual(gcSpeedPlan().tasks.length)
    expect(result.evidenceCount).toBe(8)
    expect(result.trace.evidence_count).toBe(8)
    expect(result.phaseTrace.map((phase) => phase.phase)).toEqual(["discovery", "expansion", "gap_follow_up", "aggregation"])
  })

  test("uses first-hop seed symbols for bounded second-hop expansion", async () => {
    const calls: string[] = []
    const plan = {
      ...gcSpeedPlan(),
      tasks: [
        { type: "symbol_discovery", query: "collector" },
      ],
    }
    const result = await executeEvidencePlan({
      plan,
      maxTasks: 4,
      maxFanout: 1,
      codeGraph: {
        queryEvidence: async (question) => {
          calls.push(`query:${question}`)
          return queryEvidenceResult()
        },
        findSymbols: async () => [
          {
            name: "collector_tick",
            kind: "function",
            path: "src/gc.c",
            startLine: 10,
            endLine: 20,
            signature: "void collector_tick(void)",
            snippet: "void collector_tick(void) {}",
            score: 1,
            reason: "test",
          },
          {
            name: "collector_sweep",
            kind: "function",
            path: "src/gc.c",
            startLine: 30,
            endLine: 40,
            signature: "void collector_sweep(void)",
            snippet: "void collector_sweep(void) {}",
            score: 0.9,
            reason: "test",
          },
        ],
        runAnalysisTool: async (input) => {
          calls.push(`tool:${input.tool}:${input.args?.symbol ?? input.args?.query}`)
          return analysisToolResult(input.tool)
        },
      },
    })

    expect(calls).toContain("tool:getCallers:collector_tick")
    expect(calls).toContain("tool:getCallees:collector_tick")
    expect(calls).not.toContain("tool:getCallers:collector_sweep")
    expect(result.results.length).toBeLessThanOrEqual(4)
    expect(result.phaseTrace.find((phase) => phase.phase === "expansion")?.seedSymbols).toEqual(["collector_tick"])
  })

  test("maps call-chain planner tasks to the bounded call-chain tool", async () => {
    const calls: string[] = []
    await executeEvidencePlan({
      plan: {
        ...gcSpeedPlan(),
        tasks: [
          { type: "call_chain", query: "source to target", symbol: "source_symbol", target: "target_symbol" },
        ],
      },
      maxTasks: 1,
      codeGraph: {
        queryEvidence: async () => queryEvidenceResult(),
        findSymbols: async () => [],
        runAnalysisTool: async (input) => {
          calls.push(`${input.tool}:${input.args?.symbol}:${input.args?.target}`)
          return analysisToolResult(input.tool)
        },
      },
    })

    expect(calls).toEqual(["getCallChain:source_symbol:target_symbol"])
  })

  test("aggregates broad-question evidence into factor groups and gaps", async () => {
    const execution = await executeEvidencePlan({
      plan: gcSpeedPlan(),
      relatedPaths: ["src/gc.c"],
      queryOptions: { retrievalMode: "graph-only" },
      codeGraph: {
        queryEvidence: async (question) => queryEvidenceResult(question),
        findSymbols: async () => [
          {
            name: "gc_collect",
            kind: "function",
            path: "src/gc.c",
            startLine: 10,
            endLine: 20,
            signature: "void gc_collect(void)",
            snippet: "void gc_collect(void) {}",
            score: 1,
            reason: "test",
          },
        ],
        runAnalysisTool: async (input) => analysisToolResult(input.tool),
      },
    })

    const aggregation = aggregateUnderstandingEvidence(gcSpeedPlan(), execution)
    const byCategory = new Map(aggregation.factors.map((factor) => [factor.category, factor]))

    expect(byCategory.get("call_frequency")?.supportingEvidence.length).toBeGreaterThan(0)
    expect(byCategory.get("configuration_thresholds")?.supportingEvidence.length).toBeGreaterThan(0)
    expect(byCategory.get("tests_benchmarks")?.supportingEvidence.length).toBeGreaterThan(0)
    expect(byCategory.get("algorithm_complexity")).toMatchObject({
      strength: "missing",
      confidence: "none",
      hypothesis: true,
    })
    expect(aggregation.gaps.some((gap) => gap.includes("Algorithm complexity"))).toBe(true)
  })

  test("deduplicates equivalent evidence inside the same factor", () => {
    const plan = {
      ...gcSpeedPlan(),
      tasks: [
        { type: "config_search", query: "threshold" },
        { type: "config_search", query: "batch" },
      ],
    }
    const duplicate = evidenceRef("config")
    const aggregation = aggregateUnderstandingEvidence(plan, {
      evidenceCount: 2,
      trace: {
        planner_used: true,
        task_count: 2,
        evidence_count: 2,
        latency_ms: 1,
      },
      phaseTrace: [],
      results: [
        {
          task: plan.tasks[0],
          kind: "queryEvidence",
          result: queryEvidenceResultWithEvidence([duplicate]),
          evidenceCount: 1,
        },
        {
          task: plan.tasks[1],
          kind: "queryEvidence",
          result: queryEvidenceResultWithEvidence([{ ...duplicate }]),
          evidenceCount: 1,
        },
      ],
    })

    const factor = aggregation.factors.find((item) => item.category === "configuration_thresholds")
    expect(factor?.supportingEvidence).toHaveLength(1)
    expect(aggregation.omittedDuplicateEvidence).toBe(1)
  })

  test("classifies call expansion evidence by snippet semantics instead of only task type", () => {
    const plan = {
      ...gcSpeedPlan(),
      tasks: [
        { type: "call_expansion", query: "gc_collect", symbol: "gc_collect", direction: "both" },
      ],
    }
    const aggregation = aggregateUnderstandingEvidence(plan, {
      evidenceCount: 3,
      trace: {
        planner_used: true,
        task_count: 1,
        evidence_count: 3,
        latency_ms: 1,
      },
      phaseTrace: [],
      results: [
        {
          task: plan.tasks[0],
          kind: "analysisTool",
          result: analysisToolResultWithEvidence("getCallers", [
            evidenceRefWithSnippet("src/gc.c", "mutex lock protects gc_collect hot path"),
            evidenceRefWithSnippet("src/gc_io.c", "flush write persists gc page data"),
            evidenceRefWithSnippet("src/gc_retry.c", "retry fallback on gc error"),
          ]),
          evidenceCount: 3,
        },
      ],
    })
    const byCategory = new Map(aggregation.factors.map((factor) => [factor.category, factor]))

    expect(byCategory.get("concurrency")?.supportingEvidence[0]?.snippet).toContain("mutex")
    expect(byCategory.get("io")?.supportingEvidence[0]?.snippet).toContain("flush")
    expect(byCategory.get("error_retry")?.supportingEvidence[0]?.snippet).toContain("retry")
    expect(aggregation.claims.map((claim) => claim.factorCategory)).toEqual(expect.arrayContaining(["concurrency", "io", "error_retry"]))
  })

  test("counter evidence lowers claim confidence instead of becoming a firm conclusion", () => {
    const plan = {
      ...gcSpeedPlan(),
      tasks: [{ type: "test_search", query: "gc benchmark" }],
    }
    const aggregation = aggregateUnderstandingEvidence(plan, {
      evidenceCount: 1,
      trace: {
        planner_used: true,
        task_count: 1,
        evidence_count: 1,
        latency_ms: 1,
      },
      phaseTrace: [],
      results: [
        {
          task: plan.tasks[0],
          kind: "queryEvidence",
          result: queryEvidenceResultWithEvidence([
            evidenceRefWithSnippet("test/gc_perf.test.c", "TODO missing no benchmark coverage for gc_collect"),
          ]),
          evidenceCount: 1,
        },
      ],
    })
    const claim = aggregation.claims.find((item) => item.factorCategory === "tests_benchmarks")

    expect(claim?.supportLevel).toBe("counter")
    expect(claim?.confidence).toBe("low")
    expect(claim?.counterEvidence.length).toBe(1)
  })

  test("marks callback, function-pointer, and generated-code gaps when expansion evidence is empty", () => {
    const plan = {
      ...gcSpeedPlan(),
      tasks: [
        { type: "call_expansion", query: "dispatch path", symbol: "dispatch_entry", direction: "both" },
      ],
    }
    const aggregation = aggregateUnderstandingEvidence(plan, {
      evidenceCount: 0,
      trace: {
        planner_used: true,
        task_count: 1,
        evidence_count: 0,
        latency_ms: 1,
      },
      phaseTrace: [],
      results: [
        {
          task: plan.tasks[0],
          kind: "analysisTool",
          result: analysisToolResultWithEvidence("getCallers", []),
          evidenceCount: 0,
        },
      ],
    })

    expect(aggregation.gaps.join("\n")).toContain("callback")
    expect(aggregation.gaps.join("\n")).toContain("function-pointer")
    expect(aggregation.gaps.join("\n")).toContain("generated-code")
  })

  test("wide-question regression fixtures declare expected evidence categories instead of fixed answers", () => {
    const fixtures = [
      {
        question: "提升 GC 速度的因素有哪些",
        plan: { ...gcSpeedPlan(), templateId: "performance-factor-analysis" },
        expectedEvidenceTypes: ["semantic_search", "module_map", "call_expansion", "config_search", "test_search"],
      },
      {
        question: "模块初始化失败的根因可能在哪里",
        plan: { ...gcSpeedPlan(), templateId: "root-cause-analysis", tasks: rootCauseTasks() },
        expectedEvidenceTypes: ["semantic_search", "reference_search", "call_chain", "state_machine_search", "test_search"],
      },
      {
        question: "这个模块的职责边界是什么",
        plan: { ...gcSpeedPlan(), templateId: "module-responsibility-map", tasks: responsibilityTasks() },
        expectedEvidenceTypes: ["module_map", "symbol_discovery", "semantic_search"],
      },
      {
        question: "状态迁移路径有哪些",
        plan: { ...gcSpeedPlan(), templateId: "state-flow-understanding", tasks: stateFlowTasks() },
        expectedEvidenceTypes: ["state_machine_search", "call_chain", "reference_search"],
      },
      {
        question: "配置阈值变化会影响哪些测试",
        plan: { ...gcSpeedPlan(), templateId: "test-impact-analysis", tasks: testImpactTasks() },
        expectedEvidenceTypes: ["test_search", "reference_search", "call_expansion", "semantic_search"],
      },
    ]

    for (const fixture of fixtures) {
      const plan = validateEvidencePlan(fixture.plan)
      expect(plan.templateId).toBe(fixture.plan.templateId)
      expect(plan.tasks.map((task) => task.type)).toEqual(expect.arrayContaining(fixture.expectedEvidenceTypes))
      expect(fixture.question.length).toBeGreaterThan(0)
    }
  })
})

function gcSpeedPlan() {
  return {
    templateId: "performance-factor-analysis",
    questionSummary: "分析影响 GC 速度的代码因素",
    concepts: ["GC", "speed", "latency"],
    hypotheses: ["scan scope", "lock contention", "batch size"],
    tasks: [
      { type: "semantic_search", query: "gc speed latency performance" },
      { type: "symbol_discovery", query: "gc" },
      { type: "module_map", query: "gc" },
      { type: "config_search", query: "gc threshold batch interval" },
      { type: "test_search", query: "gc performance benchmark" },
      { type: "call_expansion", query: "gc", symbol: "gc_collect", direction: "both" },
    ],
    answerShape: "factor_grouped",
    riskNotes: ["Evidence can suggest factors but cannot prove runtime impact without measurement."],
  }
}

function rootCauseTasks() {
  return [
    { type: "semantic_search", query: "initialization failure error path" },
    { type: "reference_search", query: "initialization error" },
    { type: "call_chain", query: "init to error", symbol: "init_entry", target: "error_exit" },
    { type: "state_machine_search", query: "initialization state failure" },
    { type: "test_search", query: "initialization failure test" },
  ]
}

function responsibilityTasks() {
  return [
    { type: "module_map", query: "module responsibility boundary" },
    { type: "symbol_discovery", query: "module entry symbols" },
    { type: "semantic_search", query: "module responsibility" },
  ]
}

function stateFlowTasks() {
  return [
    { type: "state_machine_search", query: "state transition guard event" },
    { type: "call_chain", query: "state entry to transition", symbol: "state_entry", target: "state_transition" },
    { type: "reference_search", query: "state transition" },
  ]
}

function testImpactTasks() {
  return [
    { type: "test_search", query: "configuration threshold tests" },
    { type: "reference_search", query: "configuration threshold" },
    { type: "call_expansion", query: "configuration threshold", symbol: "apply_config", direction: "both" },
    { type: "semantic_search", query: "configuration threshold behavior" },
  ]
}

function queryEvidenceResult() {
  return queryEvidenceResultWithEvidence([evidenceRef("query")])
}

function queryEvidenceResultWithEvidence(evidence: ReturnType<typeof evidenceRef>[]) {
  return {
    stateMachines: [],
    summaries: { functions: [], files: [], modules: [], subsystems: [] },
    evidencePack: {
      evidence,
      text: "",
      packedBytes: 1,
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: "trace-query",
      question: "query",
      intent: "explain",
      steps: [],
      evidence: [evidenceRef("query")],
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: "medium",
      reason: "ok",
      requiredCitation: "required",
    },
    suggestedAnswer: "answer",
  } as const
}

function analysisToolResult(tool: string) {
  return analysisToolResultWithEvidence(tool, [evidenceRef(tool)])
}

function analysisToolResultWithEvidence(tool: string, evidence: ReturnType<typeof evidenceRef>[]) {
  return {
    ok: true,
    traceId: `trace-${tool}`,
    tool,
    elapsedMs: 1,
    evidence,
    audit: {
      traceId: `trace-${tool}`,
      tool,
      argsSummary: "",
      evidenceCount: 1,
      elapsedMs: 1,
      blocked: false,
    },
  } as never
}

function evidenceRef(label: string) {
  return {
    file: `src/${label}.c`,
    startLine: 1,
    endLine: 1,
    snippetHash: label,
    parserKind: "test",
    snippet: label,
  }
}

function evidenceRefWithSnippet(file: string, snippet: string) {
  return {
    file,
    startLine: 1,
    endLine: 3,
    snippetHash: snippet,
    parserKind: "test",
    snippet,
  }
}
