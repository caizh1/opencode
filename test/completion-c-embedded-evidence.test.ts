import { describe, expect, test } from "bun:test"
import { queryEvidenceAsync } from "../src/codegraph-analysis"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { buildCEmbeddedCompletionEvidence, shouldBuildCEmbeddedCompletionEvidence } from "../src/completion-c-embedded-evidence"
import type { CodeGraphContextProvider, CodeGraphEvidenceQueryOptions } from "../src/codegraph-types"
import type { CompletionCIntent, CompletionPlan } from "../src/completion-types"

describe("generic C embedded completion evidence builder", () => {
  test("builds member-access base type, struct definition, and same usage evidence", async () => {
    const result = await buildEvidence("member-access", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "function: dev_probe",
      "completion-intent: member-access",
      "member-base: ctx",
      "member-prefix: sta",
    ])

    expect(result.trace.ragFallbackTriggered).toBe(false)
    expect(result.evidenceKinds).toContain("c-base-type")
    expect(result.evidenceKinds).toContain("c-struct-definition")
    expect(result.evidenceKinds).toContain("c-same-usage")
    expect(result.text).toContain("base-type: dev_ctx_t")
    expect(result.text).toContain("fields:")
    expect(result.text).toContain("ctx->status")
  })

  test("builds call-args callee signature, call examples, and return handling evidence", async () => {
    const result = await buildEvidence("call-args", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "function: dev_probe",
      "completion-intent: call-args",
      "callee: dev_start",
    ])

    expect(result.evidenceKinds).toContain("c-callee-signature")
    expect(result.evidenceKinds).toContain("c-call-example")
    expect(result.evidenceKinds).toContain("c-return-handling")
    expect(result.text).toContain("signature:")
    expect(result.text).toContain("dev_start(ctx, DEV_FLAG_ENABLE)")
  })

  test("builds initializer struct definition, initializer example, and callback signature evidence", async () => {
    const result = await buildEvidence("initializer", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "completion-intent: initializer",
      "initializer-field: done",
    ])

    expect(result.evidenceKinds).toContain("c-struct-definition")
    expect(result.evidenceKinds).toContain("c-initializer-example")
    expect(result.evidenceKinds).toContain("c-callback-signature")
    expect(result.text).toContain(".done = dev_on_done")
    expect(result.text).toContain("callback-signature")
  })

  test("builds error-path labels, cleanup pattern, and return style evidence", async () => {
    const result = await buildEvidence("error-path", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "function: dev_probe",
      "completion-intent: error-path",
      "goto-label-prefix: err_",
    ])

    expect(result.evidenceKinds).toContain("c-error-labels")
    expect(result.evidenceKinds).toContain("c-cleanup-pattern")
    expect(result.evidenceKinds).toContain("c-return-style")
    expect(result.text).toContain("label: err_unlock")
    expect(result.text).toContain("cleanup-calls: dev_unlock")
  })

  test("builds state-machine enum, case, and transition evidence", async () => {
    const result = await buildEvidence("state-machine", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "function: dev_step",
      "completion-intent: state-machine",
      "symbols: ctx state DEV_STATE",
    ])

    expect(result.evidenceKinds).toContain("c-state-machine")
    expect(result.text).toContain("DEV_STATE_READY")
    expect(result.text).toMatch(/case DEV_STATE_IDLE|transitions:/)
  })

  test("builds mmio register macro family and register access evidence", async () => {
    const result = await buildEvidence("mmio-register", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "completion-intent: mmio-register",
      "register-tokens: FIELD_PREP DEV_CTRL_ENABLE",
    ])

    expect(result.evidenceKinds).toContain("c-register-macro")
    expect(result.evidenceKinds).toContain("c-register-access-example")
    expect(result.text).toContain("DEV_CTRL_ENABLE_MASK")
    expect(result.text).toContain("readl")
    expect(result.text).toContain("writel")
  })

  test("builds generic structured evidence for weak body-statement intent", async () => {
    const result = await buildEvidence("body-statement", [
      "inline completion for c file drivers/dev.c",
      "current-path: drivers/dev.c",
      "function: dev_probe",
      "completion-intent: body-statement",
      "nearby-comment-tokens: enable controller flags",
      "current-word: dev",
    ])

    expect(shouldBuildCEmbeddedCompletionEvidence(plan("body-statement"))).toBe(true)
    expect(result.trace.ragFallbackTriggered).toBe(false)
    expect(result.selectedEvidenceCount).toBeGreaterThan(0)
    expect(result.evidenceKinds.some((kind) => [
      "c-helper-usage",
      "c-type-definition",
      "c-macro-definition",
      "c-local-context",
      "c-symbol-definition",
      "c-call-style",
    ].includes(kind))).toBe(true)
    expect(result.text).toContain("C evidence: c-")
    expect(result.text).toContain("Source:")
    expect(result.text).toContain("Code:")
    expect(result.text).not.toContain("<evidence")
    expect(result.text).toContain("Reason:")
    expect(result.text).toContain("Domain boost:")
  })

  test("uses shared repository local-flow projection for ordinary C body statements", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        return {
          retrieval: {
            mode: "overview",
            tokens: [],
            symbols: ["dev_active_dump", "dev_init_phy"],
            evidence: [
              {
                path: "drivers/debug.c",
                startLine: 10,
                endLine: 12,
                kind: "function",
                score: 9500,
                reason: "global helper candidate",
                snippet: "static void dev_active_dump(void)\n{\n  dump_debug_state();\n}",
              },
              {
                path: "drivers/dev.c",
                startLine: 40,
                endLine: 44,
                kind: "function",
                score: 260,
                reason: "same-module init helper",
                snippet: "static void dev_init_phy(dev_ctx_t *ctx)\n{\n  dev_wait_ready(ctx);\n}",
              },
            ],
            candidateCount: 2,
            packedBytes: 180,
            omittedCandidates: 0,
            truncated: false,
            elapsedMs: 1,
          },
          stateMachines: [],
          summaries: { functions: [], files: [], modules: [], subsystems: [] },
          evidencePack: {
            evidence: [],
            text: "",
            packedBytes: 0,
            omittedEvidence: 0,
            truncated: false,
            missingEvidence: [],
          },
          trace: {
            traceId: "body-statement-shared",
            question: "body-statement-shared",
            intent: "overview",
            steps: [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
            evidence: [],
            missingEvidence: [],
          },
          answerPolicy: { allowed: true, confidence: "high", reason: "test", requiredCitation: "" },
          suggestedAnswer: "",
        }
      },
    }

    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: plan("body-statement"),
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_init",
        "completion-intent: body-statement",
        "nearby-identifiers: ctx ret",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_init(dev_ctx_t *ctx)\n{\n  dev_power_on(ctx);\n  ",
      suffix: "\n  dev_enable(ctx);\n}\n",
    })

    expect(capturedCalls[0]?.question).toContain("cursor-task: rank evidence for a blank or ordinary C/C++ statement hole")
    expect(capturedCalls[0]?.question).toContain("expected-evidence: current-function flow")
    expect(capturedCalls[0]?.question).toContain("avoid-evidence: broad debug, dump, print")
    expect(capturedCalls[0]?.options?.retrievalMode).toBe("hybrid")
    expect(result.trace.retrievalShape).toBe("default")
    expect(result.trace.projectedEvidenceNames?.[0]).toBe("dev_init_phy")
    expect(result.trace.actualPromptEvidenceNames).toContain("dev_init_phy")
    expect(result.trace.evidenceRoles).toContain("local-flow")
    expect(result.text).toContain("dev_init_phy")
    expect(result.text).not.toContain("dev_active_dump")
  })

  test("scopes ordinary body-statement cursor context to an empty current function", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        return {
          retrieval: {
            mode: "overview",
            tokens: [],
            symbols: ["MSG", "dev_empty_init_apply"],
            evidence: [
              {
                path: "drivers/dev.c",
                startLine: 4,
                endLine: 4,
                kind: "function",
                score: 9000,
                reason: "logging helper",
                snippet: "void MSG(int cls, int level, const char *fmt);",
              },
              {
                path: "drivers/dev.c",
                startLine: 30,
                endLine: 35,
                kind: "function",
                score: 260,
                reason: "same-module empty init style",
                snippet: "static void dev_empty_init_apply(struct controller *ctrl)\n{\n  controller_setup(ctrl);\n}",
              },
            ],
            candidateCount: 2,
            packedBytes: 180,
            omittedCandidates: 0,
            truncated: false,
            elapsedMs: 1,
          },
          stateMachines: [],
          summaries: { functions: [], files: [], modules: [], subsystems: [] },
          evidencePack: {
            evidence: [],
            text: "",
            packedBytes: 0,
            omittedEvidence: 0,
            truncated: false,
            missingEvidence: [],
          },
          trace: {
            traceId: "empty-body-scoped",
            question: "empty-body-scoped",
            intent: "overview",
            steps: [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
            evidence: [],
            missingEvidence: [],
          },
          answerPolicy: { allowed: true, confidence: "high", reason: "test", requiredCitation: "" },
          suggestedAnswer: "",
        }
      },
    }

    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: plan("body-statement"),
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_empty_init",
        "completion-intent: body-statement",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: [
        "static void adjacent_init(void)",
        "{",
        "  MSG(DEV_C, 0, \"adjacent init\\n\");",
        "  controller_power_on();",
        "}",
        "",
        "static void dev_empty_init(struct controller *ctrl)",
        "{",
        "  ",
      ].join("\n"),
      suffix: [
        "",
        "}",
        "",
        "static void adjacent_after(void)",
        "{",
        "  controller_enable();",
        "}",
      ].join("\n"),
      cursorPrefix: [
        "static void dev_empty_init(struct controller *ctrl)",
        "{",
        "  ",
      ].join("\n"),
      cursorSuffix: [
        "",
        "}",
      ].join("\n"),
      cursorContextScope: "current-function",
      currentFunctionBodyIsEmpty: true,
    })

    expect(capturedCalls[0]?.question).not.toContain("adjacent_init")
    expect(capturedCalls[0]?.question).not.toContain("controller_power_on")
    expect(capturedCalls[0]?.question).not.toContain("controller_enable")
    expect(result.trace.cursorContextScope).toBe("current-function")
    expect(result.trace.currentFunctionBodyIsEmpty).toBe(true)
    expect(result.trace.scopedPreviousStatementCalls).toEqual([])
    expect(result.trace.scopedNextStatementCalls).toEqual([])
    expect(result.trace.actualPromptEvidenceNames).toContain("dev_empty_init_apply")
    expect(result.text).toContain("dev_empty_init_apply")
    expect(result.text).not.toContain("Symbol: MSG")
  })

  test("uses shared repository projection for broad C symbol prefixes", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        return {
          retrieval: {
            mode: "overview",
            tokens: [],
            symbols: ["dev_active_dump", "dev_enable_controller_flags"],
            evidence: [
              {
                path: "drivers/debug.c",
                startLine: 10,
                endLine: 12,
                kind: "function",
                score: 9500,
                reason: "global prefix candidate",
                snippet: "static void dev_active_dump(void)\n{\n  dump_debug_state();\n}",
              },
              {
                path: "drivers/dev.c",
                startLine: 24,
                endLine: 28,
                kind: "function",
                score: 260,
                reason: "same-module helper",
                snippet: "static void dev_enable_controller_flags(dev_ctx_t *ctx)\n{\n  ctx->status |= DEV_FLAG_ENABLE;\n}",
              },
            ],
            candidateCount: 2,
            packedBytes: 160,
            omittedCandidates: 0,
            truncated: false,
            elapsedMs: 1,
          },
          stateMachines: [],
          summaries: { functions: [], files: [], modules: [], subsystems: [] },
          evidencePack: {
            evidence: [],
            text: "",
            packedBytes: 0,
            omittedEvidence: 0,
            truncated: false,
            missingEvidence: [],
          },
          trace: {
            traceId: "symbol-prefix-shared",
            question: "symbol-prefix-shared",
            intent: "overview",
            steps: [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
            evidence: [],
            missingEvidence: [],
          },
          answerPolicy: { allowed: true, confidence: "high", reason: "test", requiredCitation: "" },
          suggestedAnswer: "",
        }
      },
    }

    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: {
        ...plan("symbol-prefix"),
        targetSymbol: "de",
        replaceCurrentWord: true,
        insertMode: "replace-current-word",
      },
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: symbol-prefix",
        "current-word: de",
        "nearby-identifiers: ctx ret",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_probe(dev_ctx_t *ctx)\n{\n  dev_lock(ctx);\n  de",
      suffix: "\n  dev_unlock(ctx);\n}\n",
    })

    const semanticCall = capturedCalls.find((call) => call.options?.retrievalMode === "hybrid")
    const graphCall = capturedCalls.find((call) => call.options?.retrievalMode === "graph-only")
    expect(semanticCall?.question).toContain("User question:")
    expect(semanticCall?.question).toContain("already typed identifier prefix: de")
    expect(semanticCall?.question).toContain("not as the whole retrieval query")
    expect(semanticCall?.question).not.toContain("typed-prefix-hint: de")
    expect(semanticCall?.question).not.toContain("avoid-evidence: broad debug, dump, print")
    expect(graphCall?.question).toContain("completion-intent: symbol-prefix")
    expect(result.trace.symbolPrefixRetrievalShape).toBe("qa-semantic")
    expect(result.trace.symbolPrefixSemanticQueryText).toContain("already typed identifier prefix: de")
    expect(result.trace.symbolPrefixProjectedEvidenceNames?.[0]).toBe("dev_enable_controller_flags")
    expect(result.trace.symbolPrefixCompatibilityScores?.find((item) => item.name === "dev_active_dump")?.broadUtility).toBe(true)
    expect(result.evidenceKinds).toContain("c-helper-usage")
    expect(result.trace.evidenceRoles).toContain("prefix-compatible-helper")
    expect(result.text).toContain("dev_enable_controller_flags")
    expect(result.text).not.toContain("dev_active_dump")
  })

  test("keeps typed-prefix compatible init helpers in prompt evidence when unrelated macros have higher raw score", async () => {
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async () => ({
        retrieval: {
          mode: "overview",
          tokens: [],
          symbols: ["REG_ACCESS", "TEMP_TO_ABS", "ct_controller_init_common"],
          evidence: [
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
              path: "drivers/ctrl/init.c",
              startLine: 20,
              endLine: 24,
              kind: "function",
              score: 180,
              reason: "lower raw score same-module init helper",
              snippet: "void ct_controller_init_common(void)\n{\n  ct_clock_enable();\n  ct_reset_release();\n}",
            },
          ],
          candidateCount: 3,
          packedBytes: 260,
          omittedCandidates: 0,
          truncated: false,
          elapsedMs: 1,
        },
        stateMachines: [],
        summaries: { functions: [], files: [], modules: [], subsystems: [] },
        evidencePack: {
          evidence: [],
          text: "",
          packedBytes: 0,
          omittedEvidence: 0,
          truncated: false,
          missingEvidence: [],
        },
        trace: {
          traceId: "symbol-prefix-projection",
          question: "symbol-prefix-projection",
          intent: "overview",
          steps: [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
          evidence: [],
          missingEvidence: [],
        },
        answerPolicy: { allowed: true, confidence: "high", reason: "test", requiredCitation: "" },
        suggestedAnswer: "",
      }),
    }

    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: {
        ...plan("symbol-prefix"),
        targetSymbol: "ct",
        replaceCurrentWord: true,
        insertMode: "replace-current-word",
      },
      question: [
        "inline completion for c file drivers/ctrl/controller.c",
        "current-path: drivers/ctrl/controller.c",
        "function: ct_controller_init",
        "completion-intent: symbol-prefix",
        "current-word: ct",
        "nearby-identifiers: ctx",
      ].join("\n"),
      relatedPaths: ["drivers/ctrl/controller.c"],
      prefix: "int ct_controller_init(void)\n{\n  ct",
      suffix: "\n}\n",
    })

    expect(result.trace.symbolPrefixProjectedEvidenceNames?.[0]).toBe("ct_controller_init_common")
    expect(result.trace.actualPromptEvidenceNames).toContain("ct_controller_init_common")
    expect(result.trace.actualPromptEvidenceNames).not.toContain("REG_ACCESS")
    expect(result.trace.actualPromptEvidenceNames).not.toContain("TEMP_TO_ABS")
    expect(result.trace.typedPrefixCompatibleCandidates).toEqual(expect.arrayContaining(["ct_controller_init_common"]))
    expect(result.trace.typedPrefixCompatiblePromptNames).toContain("ct_controller_init_common")
    expect(result.trace.symbolPrefixRetrievalShape).toBe("qa-semantic")
    expect(result.trace.symbolPrefixSemanticTopK).toContain("ct_controller_init_common")
    expect(result.trace.symbolPrefixCurrentFunctionTokens).toEqual(expect.arrayContaining(["controller", "init"]))
    expect(result.trace.symbolPrefixNonPrefixDroppedNames).toEqual(expect.arrayContaining(["REG_ACCESS", "TEMP_TO_ABS"]))
    expect(result.text).toContain("ct_controller_init_common")
    expect(result.text).not.toContain("REG_ACCESS")
  })

  test("builds comment-guided semantic and similar function evidence", async () => {
    const commentPlan: CompletionPlan = {
      ...plan("body-statement"),
      kind: "comment-guided-c-code",
      sourceComment: "// step2: enable controller flags",
      needsSymbolRetrieval: false,
      maxTokens: 128,
    }
    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: miniProvider(),
      plan: commentPlan,
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: comment-guided-c-code",
        "source-comment: step2: enable controller flags",
        "nearby-identifiers: ctx ret",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
    })

    expect(shouldBuildCEmbeddedCompletionEvidence(commentPlan)).toBe(true)
    expect(result.selectedEvidenceCount).toBeGreaterThan(0)
    expect(result.evidenceKinds.some((kind) => kind === "c-comment-semantic-match" || kind === "c-similar-function")).toBe(true)
    expect(result.text).toContain("C evidence:")
    expect(result.text).toMatch(/c-comment-semantic-match|c-similar-function/)
    expect(result.trace.minimumUsefulEvidenceMet).toBe(true)
    expect(result.trace.retrievalShape).toBe("qa-exact")
    expect(result.trace.qaExactTopK?.length ?? 0).toBeGreaterThan(0)
    expect(result.trace.qaExactSubmittedEvidence?.length ?? 0).toBeGreaterThan(0)
    expect(result.trace.evidenceRoles?.length ?? 0).toBeGreaterThan(0)
    expect(result.text).toContain("Generation mode hint:")
    expect(result.text).toContain("Evidence role:")
  })

  test("defaults comment-guided retrieval to QA-exact shape with capped completion budget", async () => {
    const capturedCalls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
        capturedCalls.push({ question, options })
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          retrieval: {
            mode: "overview",
            tokens: [],
            symbols: ["wait_clock_ready"],
            evidence: [{
              path: "drivers/clock.c",
              startLine: 12,
              endLine: 15,
              kind: "function",
              score: 300,
              reason: "seed function",
              snippet: "static void wait_clock_ready(void)\n{\n  wait_until(clock_ready());\n}",
            }],
            candidateCount: 1,
            packedBytes: 80,
            omittedCandidates: 0,
            truncated: false,
            elapsedMs: 1,
          },
          stateMachines: [],
          summaries: { functions: [], files: [], modules: [], subsystems: [] },
          evidencePack: {
            evidence: [],
            text: "",
            packedBytes: 0,
            omittedEvidence: 0,
            truncated: false,
            missingEvidence: [],
          },
          trace: {
            traceId: "qa-exact-builder",
            question: "qa-exact-builder",
            intent: "overview",
            steps: [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
            evidence: [],
            missingEvidence: [],
          },
          answerPolicy: { allowed: true, confidence: "high", reason: "test", requiredCitation: "" },
          suggestedAnswer: "",
        }
      },
    }
    const commentPlan: CompletionPlan = {
      ...plan("body-statement"),
      kind: "comment-guided-c-code",
      sourceComment: "// wait clock ready",
      needsSymbolRetrieval: false,
      maxTokens: 128,
    }

    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: commentPlan,
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: comment-guided-c-code",
        "source-comment: wait clock ready",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_probe(void)\n{\n    ",
      suffix: "\n}\n",
    })

    const semanticCall = capturedCalls.find((call) => call.options?.retrievalMode === "hybrid")
    const graphCall = capturedCalls.find((call) => call.options?.retrievalMode === "graph-only")
    expect(semanticCall?.question).toContain("User question:")
    expect(semanticCall?.question).toContain("what exact code or existing helper/function call should be inserted")
    expect(semanticCall?.question).not.toContain("cursor-task: choose existing local helper/function calls")
    expect(semanticCall?.question).not.toContain("avoid-evidence: current function body summaries")
    expect(semanticCall?.question).not.toContain("prefix-context:")
    expect(semanticCall?.question).not.toContain("suffix-context:")
    expect(semanticCall?.options?.maxEvidenceItems).toBeGreaterThanOrEqual(32)
    expect(semanticCall?.options?.maxEvidenceBytes).toBeGreaterThanOrEqual(24000)
    expect(semanticCall?.options?.latencyBudgetMs).toBe(2500)
    expect(graphCall?.question).toContain("completion-intent: comment-guided-c-code")
    expect(graphCall?.question).toContain("source-comment: wait clock ready")
    expect(result.trace.retrievalShape).toBe("qa-exact")
    expect(result.trace.retrievalBudgetMs).toBe(2500)
    expect(result.trace.retrievalTimedOut).toBe(false)
    expect(result.trace.semanticQueryText).toContain("wait clock ready")
    expect(result.trace.graphQuestionTextHash).toMatch(/^sha256:/)
    expect(result.trace.qaExactTopK).toContain("wait_clock_ready")
    expect(result.trace.qaExactSubmittedEvidence).toContain("wait_clock_ready")
    expect(result.trace.selectedPromptEvidenceNames).toContain("wait_clock_ready")
    expect(result.trace.projectedEvidenceNames).toContain("wait_clock_ready")
    expect(result.trace.actualPromptEvidenceNames).toContain("wait_clock_ready")
    expect(result.trace.probeAffectsPrompt).toBe(false)
    expect(result.text).toContain("wait_clock_ready")
  })

  test("uses style examples instead of forcing helpers when no callable helper is strong", async () => {
    const commentPlan: CompletionPlan = {
      ...plan("body-statement"),
      kind: "comment-guided-c-code",
      sourceComment: "// check len max",
      needsSymbolRetrieval: false,
      maxTokens: 128,
    }
    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: styleOnlyProvider(),
      plan: commentPlan,
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: comment-guided-c-code",
        "source-comment: check len max",
        "nearby-identifiers: len max ret",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_probe(void)\n{\n    ",
      suffix: "\n}\n",
    })

    expect(result.trace.generationModeHint).toBe("synthesize-from-style")
    expect(result.trace.evidenceRoles).toContain("style-example")
    expect(result.trace.callableHelperCandidates ?? []).toEqual([])
    expect(result.text).toContain("Evidence role: style-example")
  })

  test("keeps partial local code in continue-local-code mode", async () => {
    const commentPlan: CompletionPlan = {
      ...plan("assignment-rhs"),
      kind: "comment-guided-c-code",
      sourceComment: "// compute status",
      needsSymbolRetrieval: false,
      maxTokens: 128,
    }
    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: miniProvider(),
      plan: commentPlan,
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: comment-guided-c-code",
        "source-comment: compute status",
        "nearby-identifiers: ctx ret status",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_probe(dev_ctx_t *ctx)\n{\n    ret = ",
      suffix: ";\n}\n",
    })

    expect(result.trace.generationModeHint).toBe("continue-local-code")
    expect(result.text).toContain("Generation mode hint: continue-local-code")
  })

  test("debug full retrieval reports expected symbol presence without changing selection", async () => {
    const commentPlan: CompletionPlan = {
      ...plan("body-statement"),
      kind: "comment-guided-c-code",
      sourceComment: "// step2: enable controller flags",
      needsSymbolRetrieval: false,
      maxTokens: 128,
    }
    const baseInput = {
      codeGraph: miniProvider(),
      plan: commentPlan,
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "function: dev_probe",
        "completion-intent: comment-guided-c-code",
        "source-comment: step2: enable controller flags",
        "nearby-identifiers: ctx ret",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
      prefix: "int dev_probe(dev_ctx_t *ctx)\n{\n    ",
      suffix: "\n}\n",
    }
    const withoutMarker = await buildCEmbeddedCompletionEvidence({
      ...baseInput,
      debugFullRetrievalProbe: true,
    })
    const withMarker = await buildCEmbeddedCompletionEvidence({
      ...baseInput,
      debugFullRetrievalProbe: true,
      debugExpectedSymbol: "dev_enable_controller_flags",
      requestId: "debug-marker-test",
    })

    expect(withMarker.debugDump?.requestId).toBe("debug-marker-test")
    expect(withMarker.debugDump?.expectedSymbolPresence.fullRetrieval).toBe(true)
    expect(withMarker.trace.expectedSymbolInFullRetrieval).toBe(true)
    expect(withMarker.trace.fullRetrievalCandidateCount).toBeGreaterThan(0)
    expect(withMarker.trace.projectionCandidateCount).toBeGreaterThan(0)
    expect(withMarker.trace.cursorContextFeatures?.statementHoleKind).toBe("blank-statement")
    expect(withMarker.items.map((item) => item.name)).toEqual(withoutMarker.items.map((item) => item.name))
  })

  test("uses minimumUsefulEvidence only to trigger hybrid fallback trace", async () => {
    const calls: string[] = []
    const provider = miniProvider((mode) => calls.push(mode))
    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: provider,
      plan: plan("call-args"),
      question: [
        "inline completion for c file drivers/dev.c",
        "current-path: drivers/dev.c",
        "completion-intent: call-args",
        "callee: missing_helper",
      ].join("\n"),
      relatedPaths: ["drivers/dev.c"],
    })

    expect(calls).toEqual(["graph-only", "hybrid"])
    expect(result.trace.ragFallbackTriggered).toBe(true)
    expect(result.trace.graphEvidenceCount).toBeGreaterThan(0)
    expect(result.trace.finalSelectedEvidenceCount).toBeGreaterThan(0)
    expect(result.text).toContain("C evidence: c-")
    expect(result.text).not.toContain("<evidence")
  })
})

async function buildEvidence(intent: CompletionCIntent, questionLines: string[]) {
  return buildCEmbeddedCompletionEvidence({
    codeGraph: miniProvider(),
    plan: plan(intent),
    question: questionLines.join("\n"),
    relatedPaths: ["drivers/dev.c"],
    domainHints: intent === "mmio-register" ? ["dev"] : [],
  })
}

function miniProvider(onQuery?: (mode: string) => void): Pick<CodeGraphContextProvider, "queryEvidence"> {
  const index = hydrateCodeGraphIndex({
    version: 4,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: {
      "drivers/dev.c": parseCFile({
        path: "drivers/dev.c",
        hash: "dev",
        size: source.length,
        text: source,
      }),
    },
  })
  return {
    queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
      onQuery?.(options?.retrievalMode ?? "graph-only")
      return queryEvidenceAsync(index, question, {
        maxEvidenceItems: 24,
        maxEvidenceBytes: 20000,
        maxFileSliceBytes: 6000,
        maxGraphEdges: 120,
        maxPaths: 8,
      }, undefined, options?.relatedPaths ?? ["drivers/dev.c"])
    },
  }
}

function styleOnlyProvider(): Pick<CodeGraphContextProvider, "queryEvidence"> {
  return {
    queryEvidence: async () => ({
      retrieval: {
        mode: "overview",
        tokens: [],
        symbols: [],
        evidence: [{
          path: "drivers/dev.c",
          startLine: 42,
          endLine: 48,
          kind: "text",
          score: 260,
          reason: "similar-block",
          snippet: "if (len > max_len) {\n  ret = -EINVAL;\n  goto err_unlock;\n}",
        }],
        candidateCount: 1,
        packedBytes: 80,
        omittedCandidates: 0,
        truncated: false,
        elapsedMs: 1,
      },
      stateMachines: [],
      summaries: { functions: [], files: [], modules: [], subsystems: [] },
      evidencePack: {
        evidence: [],
        text: "",
        packedBytes: 0,
        omittedEvidence: 0,
        truncated: false,
        missingEvidence: [],
      },
      trace: {
        traceId: "style-only",
        question: "style-only",
        intent: "overview",
        steps: [{ label: "graph", detail: "style block", elapsedMs: 1 }],
        evidence: [],
        missingEvidence: [],
      },
      answerPolicy: { allowed: true, confidence: "medium", reason: "test", requiredCitation: "" },
      suggestedAnswer: "",
    }),
  }
}

function plan(intent: CompletionCIntent): CompletionPlan {
  return {
    kind: "c-embedded-code",
    insertMode: "insert-at-cursor",
    cIntent: intent,
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsIntentRetrieval: true,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: 96,
    confidenceFloor: 0.35,
    retrievalPolicy: {
      label: `c-${intent}`,
      intent,
      queryMode: "c-embedded-intent",
      preferredKinds: ["function", "type", "macro", "global", "field"],
    },
  }
}

const source = `
#define DEV_FLAG_ENABLE BIT(0)
#define DEV_CTRL_REG 0x00u
#define DEV_CTRL_ENABLE_MASK GENMASK(0, 0)
#define DEV_CTRL_ENABLE_SHIFT 0
#define DEV_CTRL_ENABLE_BIT BIT(0)

typedef enum dev_state {
  DEV_STATE_IDLE,
  DEV_STATE_READY,
  DEV_STATE_ERROR,
} dev_state_t;

typedef struct dev_ctx {
  dev_state_t state;
  int status;
  int error;
} dev_ctx_t;

typedef struct dev_ops {
  int (*done)(dev_ctx_t *ctx, int status);
  int flags;
} dev_ops_t;

static int dev_on_done(dev_ctx_t *ctx, int status) { return status + ctx->status; }
static const dev_ops_t default_ops = { .done = dev_on_done, .flags = DEV_FLAG_ENABLE };

static int dev_start(dev_ctx_t *ctx, int flags)
{
  if (flags & DEV_FLAG_ENABLE)
    ctx->state = DEV_STATE_READY;
  return ctx->status;
}

static void dev_enable_controller_flags(void)
{
  uint32_t reg = readl((void *)DEV_CTRL_REG);
  reg |= DEV_FLAG_ENABLE;
  writel(reg, (void *)DEV_CTRL_REG);
}

int dev_probe(dev_ctx_t *ctx)
{
  int ret = dev_lock(ctx);
  if (ret)
    goto err_unlock;
  ret = dev_start(ctx, DEV_FLAG_ENABLE);
  if (ret)
    goto err_unlock;
  return ctx->status;
err_unlock:
  dev_unlock(ctx);
  return ret;
}

void dev_step(dev_ctx_t *ctx)
{
  switch (ctx->state) {
  case DEV_STATE_IDLE:
    ctx->state = DEV_STATE_READY;
    dev_trace_state(ctx, DEV_STATE_READY);
    break;
  case DEV_STATE_ERROR:
    break;
  }
}

void dev_write_ctrl(void __iomem *base)
{
  uint32_t reg = readl(base + DEV_CTRL_REG);
  reg |= FIELD_PREP(DEV_CTRL_ENABLE_MASK, 1);
  writel(reg, base + DEV_CTRL_REG);
}
`
