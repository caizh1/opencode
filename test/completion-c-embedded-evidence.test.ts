import { describe, expect, test } from "bun:test"
import { queryEvidenceAsync } from "../src/codegraph-analysis"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { buildCEmbeddedCompletionEvidence } from "../src/completion-c-embedded-evidence"
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
    expect(result.text).toContain("ctx-&gt;status")
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
    expect(result.trace.graphEvidenceCount).toBe(0)
    expect(result.trace.finalSelectedEvidenceCount).toBe(0)
    expect(result.text).toBe("")
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
