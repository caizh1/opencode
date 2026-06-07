import { describe, expect, test } from "bun:test"
import { completionRetrievalPlan, completionRetrievalQuery, shouldRetrieveCompletionSnippetsForPlan } from "../src/completion-retrieval"
import { planCompletion } from "../src/completion-plan"
import type { CompletionPlan } from "../src/completion-types"

describe("completion retrieval planning", () => {
  test("derives lightweight C/C++ retrieval queries from inline intent", () => {
    expect(completionRetrievalQuery({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    req->",
        lineSuffix: "",
      }),
      languageId: "c",
      linePrefix: "    req->",
      lineSuffix: "",
    })).toBe("req")

    expect(completionRetrievalQuery({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    req->sta",
        lineSuffix: "",
        currentWord: "sta",
      }),
      languageId: "c",
      linePrefix: "    req->sta",
      lineSuffix: "",
      currentWord: "sta",
    })).toBe("req")

    expect(completionRetrievalQuery({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    driver_start(",
        lineSuffix: ");",
      }),
      languageId: "c",
      linePrefix: "    driver_start(",
      lineSuffix: ");",
    })).toBe("driver_start")

    expect(completionRetrievalQuery({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "        .status = ",
        lineSuffix: ",",
      }),
      languageId: "c",
      linePrefix: "        .status = ",
      lineSuffix: ",",
    })).toBe("status")

    expect(completionRetrievalQuery({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    ret = ",
        lineSuffix: "",
      }),
      languageId: "c",
      linePrefix: "    ret = ",
      lineSuffix: "",
    })).toBe("ret")
  })

  test("builds multi-query retrieval plans for C/C++ inline intents", () => {
    const member = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    req->sta",
        lineSuffix: "",
        currentWord: "sta",
      }),
      languageId: "c",
      linePrefix: "    req->sta",
      lineSuffix: "",
      currentWord: "sta",
    })
    expect(member).toMatchObject({
      policyLabel: "c-member-access",
      preferredKinds: ["field", "type", "global", "function"],
    })
    expect(member.queries).toEqual(["req", "sta"])
    expect(member.evidenceQuestion).toContain("completion-intent: member-access")
    expect(member.evidenceQuestion).toContain("member-base: req")
    expect(member.evidenceQuestion).toContain("member-prefix: sta")
    expect(member.evidenceQuestion).toContain("member-access")
    expect(member.evidenceQuestion).toContain("req")

    const callArgs = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    ret = driver_start(",
        lineSuffix: ");",
      }),
      languageId: "c",
      linePrefix: "    ret = driver_start(",
      lineSuffix: ");",
    })
    expect(callArgs.policyLabel).toBe("c-call-args")
    expect(callArgs.queries).toContain("driver_start")
    expect(callArgs.evidenceQuestion).toContain("completion-intent: call-args")
    expect(callArgs.evidenceQuestion).toContain("callee: driver_start")
    expect(callArgs.evidenceQuestion).toContain("call-site")
    expect(callArgs.evidenceQuestion).toContain("return handling")

    const initializer = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "        .complete = ",
        lineSuffix: ",",
      }),
      languageId: "c",
      linePrefix: "        .complete = ",
      lineSuffix: ",",
    })
    expect(initializer.policyLabel).toBe("c-initializer")
    expect(initializer.queries).toContain("complete")
    expect(initializer.preferredKinds).toEqual(["field", "type", "function", "global"])
    expect(initializer.evidenceQuestion).toContain("completion-intent: initializer")
    expect(initializer.evidenceQuestion).toContain("initializer-field: complete")

    const condition = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    if (",
        lineSuffix: ") {",
      }),
      languageId: "c",
      linePrefix: "    if (",
      lineSuffix: ") {",
    })
    expect(condition.policyLabel).toBe("c-condition")
    expect(condition.evidenceQuestion).toContain("completion-intent: condition")
    expect(condition.evidenceQuestion).toContain("condition")
    expect(condition.evidenceQuestion).toContain("state enum")

    const errorPath = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "        goto out_",
        lineSuffix: ";",
        currentWord: "out_",
      }),
      languageId: "c",
      linePrefix: "        goto out_",
      lineSuffix: ";",
      currentWord: "out_",
    })
    expect(errorPath.policyLabel).toBe("c-error-path")
    expect(errorPath.queries).toContain("out_")
    expect(errorPath.queries).toContain("goto")
    expect(errorPath.evidenceQuestion).toContain("completion-intent: error-path")
    expect(errorPath.evidenceQuestion).toContain("goto-label-prefix: out_")
    expect(errorPath.evidenceQuestion).toContain("cleanup")

    const mmio = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    writel(FIELD_PREP(",
        lineSuffix: "));",
      }),
      languageId: "c",
      linePrefix: "    writel(FIELD_PREP(",
      lineSuffix: "));",
    })
    expect(mmio.policyLabel).toBe("c-mmio-register")
    expect(mmio.queries).toEqual(["FIELD_PREP", "writel"])
    expect(mmio.preferredKinds).toEqual(["macro", "global", "function"])
    expect(mmio.evidenceQuestion).toContain("completion-intent: mmio-register")
    expect(mmio.evidenceQuestion).toContain("register-tokens: FIELD_PREP writel")
    expect(mmio.evidenceQuestion).toContain("register")
  })

  test("deduplicates and limits retrieval plan queries", () => {
    const plan = completionRetrievalPlan({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    FIELD_PREP(FIELD_PREP(",
        lineSuffix: "));",
      }),
      languageId: "c",
      linePrefix: "    FIELD_PREP(FIELD_PREP(",
      lineSuffix: "));",
    })

    expect(new Set(plan.queries).size).toBe(plan.queries.length)
    expect(plan.queries.length).toBeLessThanOrEqual(4)
  })

  test("adds nearby comment tokens to generic C embedded body evidence questions", () => {
    const linePrefix = [
      "int controller_init(struct controller *ctrl)",
      "{",
      "    // wait controller clock stable before enabling transfers",
      "    ",
    ].join("\n")
    const plan = completionRetrievalPlan({
      plan: bodyStatementPlan(),
      languageId: "c",
      linePrefix,
      lineSuffix: "",
    })

    expect(plan.policyLabel).toBe("c-body-statement")
    expect(plan.evidenceQuestion).toContain("completion-intent: body-statement")
    expect(plan.evidenceQuestion).toContain("nearby-comment-tokens:")
    expect(plan.evidenceQuestion).toContain("controller")
    expect(plan.evidenceQuestion).toContain("clock")
    expect(plan.queries.some((query) => ["clock", "controller", "enabling", "transfers"].includes(query))).toBe(true)
  })

  test("builds semantic retrieval for comment-guided C code without target-symbol lookup", () => {
    const completionPlan: CompletionPlan = {
      kind: "comment-guided-c-code",
      insertMode: "insert-at-cursor",
      sourceComment: "// step2: wait nfc clock reset",
      cIntent: "body-statement",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsIntentRetrieval: true,
      needsTestRetrieval: false,
      useFim: true,
      useInstruction: false,
      maxTokens: 128,
      confidenceFloor: 0.35,
    }
    const plan = completionRetrievalPlan({
      plan: completionPlan,
      languageId: "c",
      linePrefix: "int controller_init(void)\n{\n    // step2: wait nfc clock reset\n    ",
      lineSuffix: "\n    return 0;\n}",
    })

    expect(plan.policyLabel).toBe("c-comment-guided-code")
    expect(plan.evidenceQuestion).toContain("completion-intent: comment-guided-c-code")
    expect(plan.evidenceQuestion).toContain("source-comment: step2: wait nfc clock reset")
    expect(plan.evidenceQuestion).toContain("nearby-identifiers:")
    expect(plan.queries).toContain("wait")
    expect(plan.queries).toContain("nfc")
    expect(plan.queries).not.toContain("step2")
  })

  test("enables ordinary C/C++ retrieval for intent-bearing plans only", () => {
    const cPlan = planCompletion({
      languageId: "c",
      linePrefix: "    req->",
      lineSuffix: "",
    })
    const tsPlan = planCompletion({
      languageId: "typescript",
      linePrefix: "const value = ",
      lineSuffix: "",
    })

    expect(shouldRetrieveCompletionSnippetsForPlan(cPlan, "c")).toBe(true)
    expect(shouldRetrieveCompletionSnippetsForPlan(tsPlan, "typescript")).toBe(false)
  })
})

function bodyStatementPlan(): CompletionPlan {
  return {
    kind: "c-embedded-code",
    insertMode: "insert-at-cursor",
    cIntent: "body-statement",
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsIntentRetrieval: true,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: 96,
    confidenceFloor: 0.35,
  }
}
