import { describe, expect, test } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence, CodeGraphEvidenceQueryOptions } from "../src/codegraph-types"
import { retrieveRepositoryEvidenceForIntent } from "../src/repository-evidence"

describe("repository evidence orchestrator", () => {
  test("shares QA-style retrieval candidates while projecting shorter completion evidence", async () => {
    const provider = providerWithEvidence([
      functionEvidence("src/driver/clock.c", 12, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    while (!clock_ready()) {\n        cpu_relax();\n    }\n}"),
      functionEvidence("src/driver/domain.c", 30, "domain_only_helper", "int domain_only_helper(void)\n{\n    return 0;\n}"),
      summaryEvidence("src/driver/current.c", "file src/driver/current.c: 2 function(s), 0 macro(s), 0 type(s)."),
    ])

    const qa = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "qa",
      task: "comment-guided-code",
      sourceComment: "// wait for clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 6,
      latencyBudgetMs: 1000,
    })
    const completion = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait for clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(qa.trace.topCandidateNames).toContain("wait_clock_ready")
    expect(completion.trace.topCandidateNames).toContain("wait_clock_ready")
    expect(completion.trace.selectedCandidateNames).toContain("wait_clock_ready")
    expect(completion.completionPack.evidence.length).toBeLessThanOrEqual(2)
    expect(completion.completionPack.text).toContain("wait_clock_ready")
    expect(completion.completionPack.text).not.toContain("Grounded answer plan")
  })

  test("falls back to graph-only retrieval when the hybrid call times out", async () => {
    const calls: string[] = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (_question: string, options?: CodeGraphEvidenceQueryOptions) => {
        calls.push(options?.retrievalMode ?? "hybrid")
        if (options?.retrievalMode === "hybrid") {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return undefined
        }
        return queryEvidenceResult([functionEvidence("src/driver/clock.c", 4, "poll_clock", "void poll_clock(void)\n{\n    while (!clock_ready()) {}\n}")], {
          steps: [{ label: "graph", detail: "graph fallback", elapsedMs: 1 }],
        })
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// poll clock",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      maxEvidence: 2,
      latencyBudgetMs: 5,
    })

    expect(calls).toEqual(["hybrid", "graph-only"])
    expect(result.trace.timedOut).toBe(true)
    expect(result.trace.timeoutStage).toBe("hybrid")
    expect(result.trace.retrievalMode).toBe("graph-only-fallback")
    expect(result.completionPack.text).toContain("poll_clock")
  })

  test("records rerank and RAG availability from the shared retrieval trace", async () => {
    const provider = providerWithEvidence([
      {
        ...functionEvidence("src/driver/clock.c", 12, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        reason: "rerank: top match",
      },
    ], {
      steps: [
        { label: "vector", detail: "vector candidates", elapsedMs: 2 },
        { label: "rerank", detail: "reranked candidates", elapsedMs: 3 },
      ],
    })

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.retrievalMode).toBe("hybrid")
    expect(result.trace.rerankEnabled).toBe(true)
    expect(result.trace.ragAvailable).toBe(true)
    expect(result.trace.selectedCandidateNames).toContain("wait_clock_ready")
  })

  test("keeps the legacy completion-shaped query when explicitly requested by retrieval shape", async () => {
    let capturedQuestion = ""
    let capturedOptions: CodeGraphEvidenceQueryOptions | undefined
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedQuestion = question
        capturedOptions = options
        return queryEvidenceResult([
          functionEvidence("src/driver/clock.c", 12, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        ])
      },
    }

    await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait for clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 3,
      maxBytes: 4000,
      latencyBudgetMs: 2500,
      retrievalShape: "default",
    })

    expect(capturedQuestion).toContain("cursor-task: choose existing local helper/function calls")
    expect(capturedQuestion).toContain("expected-evidence: function definitions")
    expect(capturedQuestion).toContain("avoid-evidence: current function body summaries")
    expect(capturedQuestion).not.toContain("nfdrv_wait_nfc_clk_reset")
    expect(capturedQuestion).not.toContain("//step2. wait nfc clock rest")
    expect(capturedOptions?.maxEvidenceItems).toBeGreaterThanOrEqual(24)
    expect(capturedOptions?.maxEvidenceBytes).toBeGreaterThanOrEqual(18000)
  })

  test("debug full retrieval does not expand prompt retrieval budget or disable timeout", async () => {
    const calls: Array<{ mode?: string; maxEvidenceItems?: number; maxEvidenceBytes?: number }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (_question: string, options?: CodeGraphEvidenceQueryOptions) => {
        calls.push({
          mode: options?.retrievalMode,
          maxEvidenceItems: options?.maxEvidenceItems,
          maxEvidenceBytes: options?.maxEvidenceBytes,
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        return queryEvidenceResult([
          functionEvidence("src/driver/clock.c", 4, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        ])
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
        maxEvidence: 2,
        latencyBudgetMs: 50,
        debugFullRetrievalProbe: true,
      })

    expect(calls).toEqual([{
      mode: "hybrid",
      maxEvidenceItems: 24,
      maxEvidenceBytes: 18000,
    }])
    expect(result.trace.timedOut).toBe(false)
    expect(result.trace.latencyBudgetMs).toBe(50)
    expect(result.trace.selectedCandidateNames).toContain("wait_clock_ready")
  })

  test("qa-exact comment-guided retrieval splits short semantic query from structured graph question", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        await new Promise((resolve) => setTimeout(resolve, 5))
        return queryEvidenceResult([
          functionEvidence("src/driver/current.c", 10, "init_controller", "int init_controller(void)\n{\n    return 0;\n}"),
          {
            path: "src/driver/current.c",
            startLine: 1,
            endLine: 1,
            kind: "text",
            score: 490,
            reason: "file summary",
            snippet: "file src/driver/current.c: 8 function(s), 0 macro(s), 0 type(s). types: none. macros: none.",
          },
          {
            path: "src/driver/current.c",
            startLine: 16,
            endLine: 16,
            kind: "function",
            score: 700,
            reason: "state-token",
            snippet: "LOG_INFO(\"wait nfc clock ready\");",
          },
          functionEvidence("src/driver/nfc.c", 20, "nfc_trace_dump", "void nfc_trace_dump(void)\n{\n    nfc_trace();\n}"),
          functionEvidence("src/driver/clock.c", 30, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        ])
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait nfc clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n    ",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 3,
      maxBytes: 4000,
      latencyBudgetMs: 50,
      retrievalShape: "qa-exact",
    })

    const semanticCall = capturedCalls.find((call) => call.options?.retrievalMode === "hybrid")
    const graphCall = capturedCalls.find((call) => call.options?.retrievalMode === "graph-only")
    expect(semanticCall?.question).toContain("User question:")
    expect(semanticCall?.question).toContain("what exact code or existing helper/function call should be inserted")
    expect(semanticCall?.question).toContain("source comment immediately before the cursor")
    expect(semanticCall?.question).toContain("// wait nfc clock ready")
    expect(semanticCall?.question).toContain("Current file/function: src/driver/current.c / init_controller")
    expect(semanticCall?.question).not.toContain("completion-intent: comment-guided-c-code")
    expect(semanticCall?.question).not.toContain("prefix-context:")
    expect(semanticCall?.question).not.toContain("suffix-context:")
    expect(semanticCall?.question).not.toContain("cursor-task: choose existing local helper/function calls")
    expect(semanticCall?.options?.maxEvidenceItems).toBeGreaterThanOrEqual(32)
    expect(semanticCall?.options?.maxEvidenceBytes).toBeGreaterThanOrEqual(24000)
    expect(semanticCall?.options?.latencyBudgetMs).toBe(50)
    expect(graphCall?.question).toContain("completion-intent: comment-guided-c-code")
    expect(graphCall?.question).toContain("current-path: src/driver/current.c")
    expect(graphCall?.question).toContain("function: init_controller")
    expect(graphCall?.question).toContain("source-comment: // wait nfc clock ready")
    expect(graphCall?.question).not.toContain("prefix-context:")
    expect(graphCall?.question).not.toContain("suffix-context:")
    expect(result.trace.retrievalShape).toBe("qa-exact")
    expect(result.trace.latencyBudgetMs).toBe(50)
    expect(result.trace.timedOut).toBe(false)
    expect(result.trace.semanticQueryText).toContain("// wait nfc clock ready")
    expect(result.trace.graphQuestionTextHash).toMatch(/^sha256:/)
    expect(result.trace.qaExactTopK).toContain("wait_clock_ready")
    expect(result.trace.rawSemanticTopK).toContain("wait_clock_ready")
    expect(result.trace.rawGraphTopK).toContain("wait_clock_ready")
    expect(result.trace.projectionTopK).toContain("wait_clock_ready")
    expect(result.trace.projectedEvidenceNames).toContain("wait_clock_ready")
    expect(result.trace.probeAffectsPrompt).toBe(false)
    expect(result.trace.selectedCandidateNames[0]).toBe("wait_clock_ready")
    expect(result.completionPack.evidence[0]?.name).toBe("wait_clock_ready")
    expect(result.trace.selectedCandidateNames).not.toContain("init_controller")
    expect(result.trace.selectedCandidateNames).not.toContain("nfc_trace_dump")
  })

  test("qa-exact production completion does not call QA buildContext", async () => {
    let buildContextCalls = 0
    const provider: Pick<CodeGraphContextProvider, "queryEvidence" | "buildContext"> = {
      queryEvidence: async () => queryEvidenceResult([
        functionEvidence("src/driver/clock.c", 30, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
      ]),
      buildContext: async () => {
        buildContextCalls += 1
        return {
        mode: "overview",
        symbols: ["wait_clock_ready"],
        truncated: false,
        metrics: {
          mode: "overview",
          tokens: ["wait", "clock", "ready"],
          symbols: ["wait_clock_ready"],
          candidateCount: 1,
          evidenceCount: 1,
          omittedCandidates: 0,
          packedBytes: 120,
          truncated: false,
          elapsedMs: 1,
        },
        text: [
          '<local-code-graph mode="overview">',
          "<evidence-list>",
          '<evidence kind="function" path="src/driver/clock.c" lines="30-34" score="240" reason="seed function">',
          "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}",
          "</evidence>",
          "</evidence-list>",
          "</local-code-graph>",
        ].join("\n"),
        }
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n    ",
      suffix: "\n}\n",
      maxEvidence: 3,
      retrievalShape: "qa-exact",
    })

    expect(buildContextCalls).toBe(0)
    expect(result.trace.qaExactContextTopK).toEqual([])
    expect(result.trace.topCandidateNames).toContain("wait_clock_ready")
    expect(result.trace.selectedCandidateNames).toContain("wait_clock_ready")
    expect(result.completionPack.text).toContain("wait_clock_ready")
  })

  test("ranks action and object matches above domain-only matches for comment-guided completion", async () => {
    const provider = providerWithEvidence([
      functionEvidence("src/driver/domain.c", 10, "nfc_domain_helper", "void nfc_domain_helper(void)\n{\n    nfc_trace();\n}"),
      {
        ...functionEvidence("src/driver/clock.c", 20, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        score: 120,
      },
    ])

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait nfc clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.selectedCandidateNames[0]).toBe("wait_clock_ready")
    expect(result.completionPack.evidence[0]?.name).toBe("wait_clock_ready")
  })

  test("qa-exact projection preserves helper whose function name matches action and object tokens", async () => {
    const provider = providerWithEvidence([
      {
        ...functionEvidence("src/driver/init.c", 10, "nfc_api_init", "void nfc_api_init(void)\n{\n    LOG_INFO(\"wait nfc clock reset\");\n}"),
        score: 1200,
      },
      {
        ...functionEvidence("src/driver/power.c", 20, "_wfi_enter_psxidle", "void _wfi_enter_psxidle(void)\n{\n    wait_until(clock_reset_done());\n}"),
        score: 900,
      },
      {
        ...functionEvidence("src/driver/clock.c", 30, "wait_nfc_clock_reset", "void wait_nfc_clock_reset(void)\n{\n    wait_until(clock_reset_done());\n}"),
        score: 120,
      },
    ])

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait nfc clock reset",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n    ",
      suffix: "\n}\n",
      maxEvidence: 3,
      retrievalShape: "qa-exact",
    })

    expect(result.trace.semanticTopK).toContain("wait_nfc_clock_reset")
    expect(result.trace.graphTopK).toContain("wait_nfc_clock_reset")
    expect(result.trace.selectedCandidateNames[0]).toBe("wait_nfc_clock_reset")
    expect(result.completionPack.evidence[0]?.name).toBe("wait_nfc_clock_reset")
  })

  test("qa-semantic symbol-prefix retrieval uses a short QA-style semantic query and structured graph question", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        return queryEvidenceResult([
          functionEvidence("drivers/ctrl/base.c", 20, "base_controller_init_common", "void base_controller_init_common(void)\n{\n    clock_enable();\n    reset_release();\n}"),
          functionEvidence("drivers/ctrl/init.c", 40, "ct_controller_init_common", "void ct_controller_init_common(void)\n{\n    clock_enable();\n}"),
        ], {
          steps: [
            { label: "vector", detail: "vector candidates", elapsedMs: 2 },
            { label: "rerank", detail: "reranked candidates", elapsedMs: 3 },
          ],
        })
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "symbol-prefix",
      retrievalShape: "qa-semantic",
      currentWord: "ct",
      currentFile: "drivers/ctrl/controller.c",
      currentFunction: "ct_controller_init_variant",
      prefix: "int ct_controller_init_variant(void)\n{\n    ct",
      suffix: "\n}\n",
      nearbyIdentifiers: ["ctx"],
      cursorContext: {
        previousStatementCalls: [],
        nextStatementCalls: [],
        nearbyLogOrMessageText: [],
        currentFunctionName: "ct_controller_init_variant",
        statementHoleKind: "blank-statement",
        flowOrdinalTokens: [],
        visibleLocals: ["ctx"],
        visibleIdentifiers: ["ct", "ctx"],
        scopedPreviousStatementCalls: [],
        scopedNextStatementCalls: [],
        cursorContextScope: "current-function",
        currentFunctionBodyIsEmpty: true,
      },
      maxEvidence: 3,
      maxBytes: 4000,
      latencyBudgetMs: 1000,
    })

    const semanticCall = capturedCalls.find((call) => call.options?.retrievalMode === "hybrid")
    const graphCall = capturedCalls.find((call) => call.options?.retrievalMode === "graph-only")
    expect(semanticCall?.question).toContain("User question:")
    expect(semanticCall?.question).toContain("which existing helper, similar function, base implementation, or concise code block best fits the cursor")
    expect(semanticCall?.question).toContain("Current file/function: drivers/ctrl/controller.c / ct_controller_init_variant")
    expect(semanticCall?.question).toContain("already typed identifier prefix: ct")
    expect(semanticCall?.question).toContain("not as the whole retrieval query")
    expect(semanticCall?.question).not.toContain("prefix-context:")
    expect(semanticCall?.question).not.toContain("suffix-context:")
    expect(semanticCall?.question).not.toContain("rank evidence for a C/C++ typed symbol prefix")
    expect(graphCall?.question).toContain("completion-intent: symbol-prefix")
    expect(graphCall?.question).toContain("current-path: drivers/ctrl/controller.c")
    expect(graphCall?.question).toContain("typed-prefix: ct")
    expect(result.trace.retrievalShape).toBe("qa-semantic")
    expect(result.trace.symbolPrefixSemanticQueryText).toContain("already typed identifier prefix: ct")
    expect(result.trace.symbolPrefixSemanticTopK).toContain("base_controller_init_common")
    expect(result.trace.symbolPrefixGraphTopK).toContain("base_controller_init_common")
    expect(result.trace.symbolPrefixPrefixCompatibleNames).toContain("ct_controller_init_common")
    expect(result.trace.symbolPrefixSemanticVsPrefixDiverged).toBe(true)
  })

  test("qa-semantic symbol-prefix projection keeps semantic evidence ahead of prefix-only broad candidates", async () => {
    const provider = providerWithEvidence([
      {
        ...functionEvidence(
          "drivers/ctrl/base.c",
          20,
          "base_controller_init_common",
          "void base_controller_init_common(void)\n{\n    clock_enable();\n    reset_release();\n}",
        ),
        score: 260,
        reason: "rerank: sibling implementation",
      },
      {
        ...functionEvidence(
          "drivers/ctrl/init.c",
          40,
          "ct_controller_init_common",
          "void ct_controller_init_common(void)\n{\n    clock_enable();\n}",
        ),
        score: 180,
      },
      {
        ...functionEvidence(
          "drivers/ctrl/dump.c",
          60,
          "ct_controller_dump_state",
          "void ct_controller_dump_state(void)\n{\n    trace_state();\n}",
        ),
        score: 2400,
        reason: "global prefix debug dump",
      },
      {
        path: "drivers/common/registers.h",
        startLine: 4,
        endLine: 5,
        kind: "macro",
        score: 2300,
        reason: "raw high score macro",
        snippet: "name: REG_ACCESS\n#define REG_ACCESS(addr) (*(volatile uint32_t *)(addr))",
      },
    ], {
      steps: [
        { label: "vector", detail: "vector candidates", elapsedMs: 2 },
        { label: "rerank", detail: "reranked candidates", elapsedMs: 3 },
      ],
    })

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "symbol-prefix",
      retrievalShape: "qa-semantic",
      currentWord: "ct",
      currentFile: "drivers/ctrl/controller.c",
      currentFunction: "ct_controller_init_variant",
      prefix: "int ct_controller_init_variant(void)\n{\n    ct",
      suffix: "\n}\n",
      nearbyIdentifiers: ["ctx"],
      maxEvidence: 3,
      maxBytes: 4000,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.symbolPrefixSemanticTopK).toContain("base_controller_init_common")
    expect(result.trace.symbolPrefixPrefixCompatibleNames).toEqual(expect.arrayContaining(["ct_controller_init_common", "ct_controller_dump_state"]))
    expect(result.trace.selectedCandidateNames).toContain("base_controller_init_common")
    expect(result.trace.selectedCandidateNames).toContain("ct_controller_init_common")
    expect(result.trace.selectedCandidateNames).not.toContain("ct_controller_dump_state")
    expect(result.trace.selectedCandidateNames).not.toContain("REG_ACCESS")
    expect(result.trace.symbolPrefixSemanticSelectedNames).toContain("base_controller_init_common")
    expect(result.trace.symbolPrefixSelectionReason).toContain("semantic evidence")
    expect(result.completionPack.text).toContain("base_controller_init_common")
    expect(result.completionPack.text).toContain("ct_controller_init_common")
    expect(result.completionPack.text).not.toContain("ct_controller_dump_state")
  })

  test("does not expose C control keywords as repository candidate names", async () => {
    const provider = providerWithEvidence([
      functionEvidence("src/driver/current.c", 8, "", "if (clock_ready()) {\n    return 0;\n}"),
      functionEvidence("src/driver/clock.c", 20, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
    ])

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.topCandidateNames).not.toContain("if")
    expect(result.trace.selectedCandidateNames).not.toContain("if")
  })

  test("projects typed-prefix compatible current-function helpers above unrelated high-score macros", async () => {
    const provider = providerWithEvidence([
      {
        path: "drivers/common/registers.h",
        startLine: 4,
        endLine: 5,
        kind: "macro",
        score: 2400,
        reason: "raw high score macro",
        snippet: "name: REG_ACCESS\n#define REG_ACCESS(addr) (*(volatile uint32_t *)(addr))",
      },
      {
        path: "drivers/common/temperature.h",
        startLine: 8,
        endLine: 9,
        kind: "macro",
        score: 2300,
        reason: "raw high score constant helper",
        snippet: "name: TEMP_TO_ABS\n#define TEMP_TO_ABS(celsius) ((celsius) + 273)",
      },
      {
        ...functionEvidence(
          "drivers/ctrl/init.c",
          20,
          "ct_controller_init_common",
          "void ct_controller_init_common(void)\n{\n    ct_clock_enable();\n    ct_reset_release();\n}",
        ),
        score: 180,
      },
      {
        ...functionEvidence(
          "drivers/ctrl/dump.c",
          40,
          "ct_controller_dump_state",
          "void ct_controller_dump_state(void)\n{\n    trace_state();\n}",
        ),
        score: 900,
        reason: "debug dump helper",
      },
    ])

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "symbol-prefix",
      currentWord: "ct",
      currentFile: "drivers/ctrl/controller.c",
      currentFunction: "ct_controller_init",
      prefix: "int ct_controller_init(void)\n{\n    ct",
      suffix: "\n}\n",
      nearbyIdentifiers: [],
      cursorContext: {
        previousStatementCalls: [],
        nextStatementCalls: [],
        nearbyLogOrMessageText: [],
        currentFunctionName: "ct_controller_init",
        statementHoleKind: "blank-statement",
        flowOrdinalTokens: [],
        visibleLocals: [],
        visibleIdentifiers: ["ct"],
        scopedPreviousStatementCalls: [],
        scopedNextStatementCalls: [],
        cursorContextScope: "current-function",
        currentFunctionBodyIsEmpty: false,
      },
      maxEvidence: 3,
      maxBytes: 4000,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.topCandidateNames).toEqual(expect.arrayContaining(["ct_controller_init_common"]))
    expect(result.trace.projectionTopK?.[0]).toBe("ct_controller_init_common")
    expect(result.trace.selectedCandidateNames).toContain("ct_controller_init_common")
    expect(result.trace.selectedCandidateNames).not.toContain("REG_ACCESS")
    expect(result.trace.selectedCandidateNames).not.toContain("TEMP_TO_ABS")
    expect(result.trace.typedPrefixCompatibleCandidates).toEqual(expect.arrayContaining(["ct_controller_init_common"]))
    expect(result.trace.typedPrefixCompatiblePromptNames).toContain("ct_controller_init_common")
    expect(result.trace.symbolPrefixCurrentFunctionTokens).toEqual(expect.arrayContaining(["controller", "init"]))
    expect(result.trace.symbolPrefixNonPrefixDroppedNames).toEqual(expect.arrayContaining(["REG_ACCESS", "TEMP_TO_ABS"]))
    expect(result.trace.symbolPrefixProjectionReasons?.find((item) => item.name === "REG_ACCESS")?.reason).toContain("non-prefix-demoted")
    expect(result.completionPack.text).toContain("ct_controller_init_common")
    expect(result.completionPack.text).not.toContain("REG_ACCESS")
  })
})

function providerWithEvidence(evidence: CodeGraphEvidence[], trace?: { steps?: Array<{ label: string; detail: string; elapsedMs: number }> }): Pick<CodeGraphContextProvider, "queryEvidence"> {
  return {
    queryEvidence: async () => queryEvidenceResult(evidence, trace),
  }
}

function queryEvidenceResult(evidence: CodeGraphEvidence[], trace?: { steps?: Array<{ label: string; detail: string; elapsedMs: number }> }): QueryEvidenceResult {
  return {
    retrieval: {
      mode: "overview",
      tokens: [],
      symbols: evidence.map((item) => symbolName(item.snippet)).filter(Boolean),
      evidence,
      candidateCount: evidence.length,
      packedBytes: evidence.reduce((sum, item) => sum + item.snippet.length, 0),
      omittedCandidates: 0,
      truncated: false,
      elapsedMs: 1,
      trace: trace?.steps,
    },
    stateMachines: [],
    summaries: {
      functions: [],
      files: [],
      modules: [],
      subsystems: [],
    },
    evidencePack: {
      evidence: [],
      text: "Grounded answer plan: use the local helper.",
      packedBytes: 0,
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: "test-trace",
      question: "test question",
      intent: "overview",
      steps: trace?.steps ?? [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
      evidence: [],
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: "high",
      reason: "test",
      requiredCitation: "",
    },
    suggestedAnswer: "Grounded answer plan: call wait_clock_ready().",
  }
}

function functionEvidence(path: string, line: number, name: string, snippet: string): CodeGraphEvidence {
  return {
    path,
    startLine: line,
    endLine: line + snippet.split(/\r?\n/).length - 1,
    kind: "function",
    score: 240,
    reason: "seed function",
    snippet,
  }
}

function summaryEvidence(path: string, snippet: string): CodeGraphEvidence {
  return {
    path,
    startLine: 1,
    endLine: 1,
    kind: "text",
    score: 400,
    reason: "file summary",
    snippet,
  }
}

function symbolName(snippet: string) {
  return /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(snippet)?.[1] ?? ""
}
