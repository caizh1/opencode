import { describe, expect, test } from "bun:test"
import { planCompletion } from "../src/completion-plan"

describe("completion planner", () => {
  test("routes bare unit-test prompts as natural commands that replace the whole line", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "unit test for epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "natural-command",
      insertMode: "replace-whole-line",
      targetSymbol: "epr_ppn_raw_wr",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useFim: false,
      useInstruction: true,
      maxTokens: 768,
    })
  })

  test("keeps comment unit-test prompts as insertions after the comment", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
      lineSuffix: "",
    })).toMatchObject({
      kind: "comment-to-test",
      insertMode: "insert-after-line",
      targetSymbol: "epr_ppn_raw_write_cb_dfx",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useFim: false,
      useInstruction: true,
    })
  })

  test("recognizes common test-for comment prompts as test generation", () => {
    for (const linePrefix of [
      "// test for confidential_guest_support_finalize",
      "// write test for confidential_guest_support_finalize",
      "// tests for confidential_guest_support_finalize",
    ]) {
      expect(planCompletion({
        languageId: "c",
        linePrefix,
        lineSuffix: "",
      })).toMatchObject({
        kind: "comment-to-test",
        insertMode: "insert-after-line",
        targetSymbol: "confidential_guest_support_finalize",
        needsSymbolRetrieval: true,
        needsTestRetrieval: true,
        useInstruction: true,
      })
    }
  })

  test("recognizes common natural test-for prompts as line replacements", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "write test for confidential_guest_support_finalize",
      lineSuffix: "",
    })).toMatchObject({
      kind: "natural-command",
      insertMode: "replace-whole-line",
      targetSymbol: "confidential_guest_support_finalize",
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useInstruction: true,
    })
  })

  test("routes identifier continuations through symbol completion", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: "epr_ppn_raw_wr",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
      maxTokens: 48,
    })
  })

  test("keeps ordinary code on the Qwen FIM path", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "const value = ",
      lineSuffix: "",
    })).toMatchObject({
      kind: "ordinary-code",
      insertMode: "insert-at-cursor",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsTestRetrieval: false,
      useFim: true,
      useInstruction: false,
    })
  })

  test("keeps short identifiers when there is clear expression context", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "  const message = na",
      lineSuffix: "",
      currentWord: "na",
    })).toMatchObject({
      kind: "ordinary-code",
      useFim: true,
      useInstruction: false,
    })
  })

  test("disables bare low-signal identifiers instead of calling FIM", () => {
    for (const linePrefix of ["t", "re"]) {
      expect(planCompletion({
        languageId: "typescript",
        linePrefix,
        lineSuffix: "",
        currentWord: linePrefix,
      })).toMatchObject({
        kind: "disabled",
        useFim: false,
        useInstruction: false,
      })
    }
  })

  test("disables punctuation-only requests instead of calling FIM", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: ";",
      lineSuffix: "",
    })).toMatchObject({
      kind: "disabled",
      useFim: false,
      useInstruction: false,
    })
  })

  test("disables requests inside an active string literal", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "const title = \"hello ",
      lineSuffix: "\";",
    })).toMatchObject({
      kind: "disabled",
      useFim: false,
      useInstruction: false,
    })
  })

  test("routes non-test comment prompts as comment-to-code instructions", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "// implement add two numbers",
      lineSuffix: "",
      currentWord: "numbers",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "numbers",
      symbolFallbackKind: "comment-to-code",
      replaceCurrentWord: true,
      useFim: false,
      useInstruction: false,
    })
  })

  test("tries plain identifier prefixes inside unit-test comments before generating code", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// give me a unit test code for confident",
      lineSuffix: "",
      currentWord: "confident",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "confident",
      symbolFallbackKind: "comment-to-test",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
    })
  })

  test("tries plain identifier prefixes inside common test-for comments before generating code", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// test for confident",
      lineSuffix: "",
      currentWord: "confident",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "confident",
      symbolFallbackKind: "comment-to-test",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useInstruction: false,
    })
  })

  test("routes identifier prefixes inside comments as deterministic symbol references", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// arbitrary words alpha_feature_",
      lineSuffix: "",
      currentWord: "alpha_feature_",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "alpha_feature_",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
    })
  })

  test("routes the line after a comment intent to instruction continuation", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "// 任意描述 alpha_feature_finalize",
      linePrefix: "",
      lineSuffix: "",
    })).toMatchObject({
      kind: "previous-comment-continuation",
      insertMode: "replace-whole-line",
      targetSymbol: "alpha_feature_finalize",
      sourceComment: "// 任意描述 alpha_feature_finalize",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      useFim: false,
      useInstruction: true,
    })
  })

  test("keeps previous comment continuation ahead of current-word symbol completion", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "// in order to test alpha_feature_finalize",
      linePrefix: "stat",
      lineSuffix: "",
      currentWord: "stat",
    })).toMatchObject({
      kind: "previous-comment-continuation",
      insertMode: "replace-whole-line",
      targetSymbol: "alpha_feature_finalize",
      needsTestRetrieval: true,
      useInstruction: true,
    })
  })

  test("does not treat ordinary identifier prefixes as previous comment continuations", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "static void unrelated(void)",
      linePrefix: "stat",
      lineSuffix: "",
      currentWord: "stat",
    })).toMatchObject({
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: "stat",
      useInstruction: false,
    })
  })

  test("disables empty column-zero requests", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "",
      lineSuffix: "",
    })).toMatchObject({
      kind: "disabled",
      insertMode: "insert-at-cursor",
      useFim: false,
      useInstruction: false,
    })
  })
})
