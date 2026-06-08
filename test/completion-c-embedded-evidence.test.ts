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

  test("defaults comment-guided retrieval to QA-exact shape without inline timeout budget", async () => {
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
    expect(semanticCall?.options?.maxEvidenceItems).toBeUndefined()
    expect(semanticCall?.options?.maxEvidenceBytes).toBeUndefined()
    expect(graphCall?.question).toContain("completion-intent: comment-guided-c-code")
    expect(graphCall?.question).toContain("source-comment: wait clock ready")
    expect(result.trace.retrievalShape).toBe("qa-exact")
    expect(result.trace.retrievalBudgetMs).toBeUndefined()
    expect(result.trace.retrievalTimedOut).toBe(false)
    expect(result.trace.semanticQueryText).toContain("wait clock ready")
    expect(result.trace.graphQuestionTextHash).toMatch(/^sha256:/)
    expect(result.trace.qaExactTopK).toContain("wait_clock_ready")
    expect(result.trace.qaExactSubmittedEvidence).toContain("wait_clock_ready")
    expect(result.trace.selectedPromptEvidenceNames).toContain("wait_clock_ready")
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
