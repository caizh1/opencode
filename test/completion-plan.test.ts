import { describe, expect, test } from "bun:test"
import { planCompletion } from "../src/completion-plan"

describe("completion planner", () => {
  test("routes bare unit-test prompts through comment-to-test symbol replacement", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "unit test for epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "comment-to-test",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      maxTokens: 192,
    })
  })

  test("keeps comment unit-test prompts as insertions after the comment", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
      lineSuffix: "",
    })).toMatchObject({
      kind: "comment-to-test",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
    })
  })

  test("routes identifier continuations through symbol completion", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "symbol",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      maxTokens: 48,
    })
  })
})
