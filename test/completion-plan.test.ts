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
      kind: "comment-to-code",
      insertMode: "insert-after-line",
      replaceCurrentWord: false,
      useFim: false,
      useInstruction: true,
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
