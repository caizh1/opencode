import { describe, expect, test } from "bun:test"
import { normalizeCompletionText } from "../src/completion-normalize"

describe("completion normalizer", () => {
  test("drops pure current-line echo completions", () => {
    const prefix = "// unit test for epr_ppn_raw_write_cb_dfx()"
    expect(normalizeCompletionText({
      rawText: prefix,
      linePrefix: prefix,
      lineSuffix: "",
      fullCurrentLine: prefix,
      planKind: "comment-to-test",
    })).toBe("")
  })

  test("removes echoed comment lines while keeping generated test code", () => {
    const prefix = "// unit test for epr_ppn_raw_write_cb_dfx()"
    expect(normalizeCompletionText({
      rawText: `${prefix}\nTEST_F(EprPpnRawTest, WriteCbDfxNormal) {\n}`,
      linePrefix: prefix,
      lineSuffix: "",
      fullCurrentLine: prefix,
      planKind: "comment-to-test",
    })).toBe("TEST_F(EprPpnRawTest, WriteCbDfxNormal) {\n}")
  })

  test("cleans Qwen FIM tokens, prefix echo, and suffix overlap", () => {
    expect(normalizeCompletionText({
      rawText: "<|fim_middle|>const value = 1;<|fim_suffix|>END",
      linePrefix: "const ",
      lineSuffix: "END",
      fullCurrentLine: "const END",
      planKind: "ordinary-code",
    })).toBe("value = 1;")
  })

  test("preserves extended current-word lines for replace-range edits", () => {
    expect(normalizeCompletionText({
      rawText: "unit test for epr_ppn_raw_write_with_cb_dfx",
      linePrefix: "unit test for epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
      fullCurrentLine: "unit test for epr_ppn_raw_wr",
      planKind: "comment-to-test",
      preferCurrentWordReplacement: true,
    })).toBe("unit test for epr_ppn_raw_write_with_cb_dfx")
  })
})
