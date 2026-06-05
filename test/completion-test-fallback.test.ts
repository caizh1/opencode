import { describe, expect, test } from "bun:test"
import { fallbackCompletionText } from "../src/completion-test-fallback"
import { planCompletion } from "../src/completion-plan"
import type { RetrievedCompletionSnippet } from "../src/completion-types"

describe("completion test fallback", () => {
  test("generates a deterministic C test body for natural unit-test commands after echo rejection", () => {
    const text = fallbackCompletionText({
      languageId: "c",
      plan: planCompletion({
        languageId: "c",
        linePrefix: "unit test for epr_ppn_raw_wr",
        lineSuffix: "",
        currentWord: "epr_ppn_raw_wr",
      }),
      retrievedSnippets: [snippet("epr_ppn_raw_write_with_cb_dfx")],
      rejectReason: "echoed-prefix",
    })

    expect(text).toContain("static void test_epr_ppn_raw_write_with_cb_dfx(void)")
    expect(text).toContain("epr_ppn_raw_write_with_cb_dfx();")
    expect(text).not.toContain("unit test for epr_ppn_raw_wr")
  })

  test("generates a deterministic C test body for duplicated comment prompts", () => {
    const text = fallbackCompletionText({
      languageId: "c",
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
        lineSuffix: "",
      }),
      retrievedSnippets: [snippet("epr_ppn_raw_write_cb_dfx")],
      rejectReason: "repeated-comment",
    })

    expect(text).toContain("static void test_epr_ppn_raw_write_cb_dfx(void)")
    expect(text).not.toContain("// unit test")
  })

  test("does not create fallback text for ordinary echoed code", () => {
    expect(fallbackCompletionText({
      languageId: "typescript",
      plan: planCompletion({
        languageId: "typescript",
        linePrefix: "const value = compute",
        lineSuffix: "",
        currentWord: "compute",
      }),
      retrievedSnippets: [snippet("computeValue")],
      rejectReason: "echoed-prefix",
    })).toBe("")
  })

  test("generates deterministic test fallback for low-confidence test output", () => {
    const text = fallbackCompletionText({
      languageId: "c",
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// test for epr_ppn_raw_write_cb_dfx",
        lineSuffix: "",
      }),
      retrievedSnippets: [snippet("epr_ppn_raw_write_cb_dfx")],
      rejectReason: "low-confidence-output",
    })

    expect(text).toContain("static void test_epr_ppn_raw_write_cb_dfx(void)")
    expect(text).toContain("epr_ppn_raw_write_cb_dfx();")
  })

  test("does not create fallback text for low-confidence non-test comment output", () => {
    expect(fallbackCompletionText({
      languageId: "c",
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// implement alpha_feature_finalize",
        lineSuffix: "",
      }),
      retrievedSnippets: [snippet("alpha_feature_finalize")],
      rejectReason: "low-confidence-output",
    })).toBe("")
  })
})

function snippet(name: string): RetrievedCompletionSnippet {
  return {
    kind: "function",
    path: "src/epr/epr_ppn_raw.c",
    line: 1,
    text: `int ${name}(void)`,
    name,
    score: 9000,
  }
}
