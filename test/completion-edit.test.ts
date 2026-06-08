import { describe, expect, test } from "bun:test"
import { adaptAndValidateInlineCompletionEdit, buildCompletionEdit, buildCompletionEditResult, buildInlineCompletionEditResult, validateInlineCompletionEdit } from "../src/completion-edit"
import type { CompletionInsertMode, CompletionPlan, CompletionPlanKind } from "../src/completion-types"

describe("language-aware completion edits", () => {
  test("InlineEditBuilder replace-current-word uses the current word range", () => {
    expect(inlineEdit({
      insertMode: "replace-current-word",
      text: "epr_ppn_raw_write_with_cb_dfx",
      languageId: "c",
      linePrefix: "    epr_ppn_raw_wr",
      character: "    epr_ppn_raw_wr".length,
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      insertText: "epr_ppn_raw_write_with_cb_dfx",
      replaceRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: "    epr_ppn_raw_wr".length,
      },
      filterText: "epr_ppn_raw_write_with_cb_dfx",
    })
  })

  test("InlineEditBuilder completes a typed prefix when FIM returns only the symbol suffix", () => {
    const edit = inlineEdit({
      insertMode: "replace-current-word",
      text: "drv_wait_nfc_clk_reset();",
      languageId: "c",
      linePrefix: "    nf",
      character: "    nf".length,
      currentWord: "nf",
      symbolHints: ["nfdrv_wait_nfc_clk_reset"],
    })

    expect(edit).toMatchObject({
      insertText: "nfdrv_wait_nfc_clk_reset();",
      replaceRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: "    nf".length,
      },
      filterText: "nfdrv_wait_nfc_clk_reset();",
      typedPrefix: {
        reason: "symbol-hint-suffix-match",
        currentWord: "nf",
        matchedSymbol: "nfdrv_wait_nfc_clk_reset",
      },
    })
    expect(validateInlineCompletionEdit({
      edit: edit!,
      editInput: editInput({
        languageId: "c",
        linePrefix: "    nf",
        character: "    nf".length,
        currentWord: "nf",
      }),
      plan: inlinePlan("replace-current-word"),
    })).toEqual({ valid: true })
  })

  test("InlineEditBuilder typed-prefix suffix completion is generic and hint-backed", () => {
    expect(inlineEdit({
      insertMode: "replace-current-word",
      text: "c_do_work(x);",
      languageId: "c",
      linePrefix: "    ab",
      character: "    ab".length,
      currentWord: "ab",
      symbolHints: ["abc_do_work"],
    })).toMatchObject({
      insertText: "abc_do_work(x);",
      filterText: "abc_do_work(x);",
      typedPrefix: {
        matchedSymbol: "abc_do_work",
      },
    })
  })

  test("InlineEditBuilder does not splice typed prefixes without a matching symbol hint", () => {
    expect(inlineEditResult({
      insertMode: "replace-current-word",
      text: "delay_us(10);",
      languageId: "c",
      linePrefix: "    nf",
      character: "    nf".length,
      currentWord: "nf",
      symbolHints: ["nfdrv_wait_nfc_clk_reset"],
    })).toEqual({
      reason: "no-insert-text",
    })
  })

  test("InlineEditBuilder ignores symbol hints that do not extend the current word", () => {
    expect(inlineEditResult({
      insertMode: "replace-current-word",
      text: "drv_wait_nfc_clk_reset();",
      languageId: "c",
      linePrefix: "    nf",
      character: "    nf".length,
      currentWord: "nf",
      symbolHints: ["drv_wait_nfc_clk_reset"],
    })).toEqual({
      reason: "no-insert-text",
    })
  })

  test("InlineEditBuilder insert-at-cursor uses a zero-width cursor range", () => {
    const prefix = "const value = "
    expect(inlineEdit({
      insertMode: "insert-at-cursor",
      text: "computeValue()",
      languageId: "typescript",
      linePrefix: prefix,
      character: prefix.length,
    })).toMatchObject({
      insertText: "computeValue()",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "computeValue()",
    })
  })

  test("InlineEditBuilder insert-after-line inserts after the full current line", () => {
    const prefix = "// unit test for epr_ppn_raw_write_cb_dfx()"
    const edit = inlineEdit({
      insertMode: "insert-after-line",
      text: "TEST(EprPpnRaw, WriteCbDfx) {\nEXPECT_EQ(0, epr_ppn_raw_write_cb_dfx());\n}",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
    })

    expect(edit).toMatchObject({
      insertText: "\nTEST(EprPpnRaw, WriteCbDfx) {\n    EXPECT_EQ(0, epr_ppn_raw_write_cb_dfx());\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
    })
    expect(edit?.replaceRange?.startLine).toBe(edit?.replaceRange?.endLine)
    expect(edit?.filterText).not.toContain(prefix)
  })

  test("InlineEditBuilder inserts previous comment continuations at an indented blank cursor", () => {
    const edit = inlineEdit({
      insertMode: "insert-at-cursor",
      planKind: "previous-comment-continuation",
      text: "if (!ready) {\n    return HAL_ERR;\n}",
      languageId: "c",
      linePrefix: "    ",
      character: 4,
    })

    expect(edit).toMatchObject({
      insertText: "if (!ready) {\n        return HAL_ERR;\n    }",
      replaceRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 4,
      },
      filterText: "if (!ready) {\n        return HAL_ERR;\n    }",
    })
  })

  test("InlineEditBuilder replace-whole-line replaces natural-language commands on one line", () => {
    const prefix = "unit test for epr_ppn_raw_wr"
    const edit = inlineEdit({
      insertMode: "replace-whole-line",
      text: "TEST(EprPpnRaw, WriteWithCbDfx) {\nEXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx());\n}",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_wr",
    })

    expect(edit).toMatchObject({
      insertText: "TEST(EprPpnRaw, WriteWithCbDfx) {\n    EXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx());\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "TEST(EprPpnRaw, WriteWithCbDfx) {\n    EXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx());\n}",
    })
    expect(edit?.replaceRange?.startLine).toBe(edit?.replaceRange?.endLine)
  })

  test("InlineEditBuilder uses full replacement filter text when it extends the replaced text", () => {
    const edit = inlineEdit({
      insertMode: "replace-whole-line",
      planKind: "previous-comment-continuation",
      text: "static void test_alpha_feature_finalize(void)\n{\n}",
      languageId: "c",
      linePrefix: "stat",
      character: "stat".length,
      currentWord: "stat",
    })

    expect(edit).toMatchObject({
      insertText: "static void test_alpha_feature_finalize(void)\n{\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: "stat".length,
      },
      filterText: "static void test_alpha_feature_finalize(void)\n{\n}",
    })
  })

  test("InlineEditBuilder keeps filter text as a prefix of overtyped whole-line replacements", () => {
    const edit = inlineEdit({
      insertMode: "replace-whole-line",
      planKind: "previous-comment-continuation",
      text: "static void test_alpha_feature_finalize(void)\n{\n}",
      languageId: "c",
      linePrefix: "stats",
      character: "stats".length,
      currentWord: "stats",
    })

    expect(edit).toMatchObject({
      insertText: "static void test_alpha_feature_finalize(void)\n{\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: "stats".length,
      },
      filterText: "static void test_alpha_feature_finalize(void)\n{\n}",
    })
  })

  test("InlineEditAdapter shrinks unsafe whole-line replacements to the current word", () => {
    const linePrefix = "static void con"
    const result = adaptAndValidateInlineCompletionEdit({
      edit: {
        insertText: "confidential_guest_support_finalize(void)",
        filterText: "confidential_guest_support_finalize(void)",
        replaceRange: range(0, 0, linePrefix.length),
      },
      editInput: editInput({
        languageId: "c",
        linePrefix,
        character: linePrefix.length,
        currentWord: "con",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
    })

    expect(result).toMatchObject({
      status: "ok",
      edit: {
        insertText: "confidential_guest_support_finalize(void)",
        replaceRange: range(0, "static void ".length, linePrefix.length),
      },
    })
    expect(result.status === "ok" ? applySingleLineEdit(linePrefix, result.edit.replaceRange, result.edit.insertText) : "").toBe(
      "static void confidential_guest_support_finalize(void)",
    )
  })

  test("InlineEditAdapter rejects wide replacements that would drop preserved code prefix", () => {
    const linePrefix = "static void con"
    expect(adaptAndValidateInlineCompletionEdit({
      edit: {
        insertText: "finalize(void)",
        filterText: "static void con",
        replaceRange: range(0, 0, linePrefix.length),
      },
      editInput: editInput({
        languageId: "c",
        linePrefix,
        character: linePrefix.length,
        currentWord: "con",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
    })).toEqual({
      status: "rejected",
      reason: "insertText-does-not-preserve-rangeText",
    })
  })

  test("InlineEditAdapter adapts whole-line candidates to selected completion ranges conservatively", () => {
    const linePrefix = "static void con"
    const result = adaptAndValidateInlineCompletionEdit({
      edit: {
        insertText: "static void confidential_guest_support_finalize(void)",
        filterText: "static void confidential_guest_support_finalize(void)",
        replaceRange: range(0, 0, linePrefix.length),
      },
      editInput: editInput({
        languageId: "c",
        linePrefix,
        character: linePrefix.length,
        currentWord: "con",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
      selectedCompletionInfo: {
        text: "confidential_guest_support_finalize",
        range: range(0, "static void ".length, linePrefix.length),
      },
    })

    expect(result).toMatchObject({
      status: "ok",
      edit: {
        insertText: "confidential_guest_support_finalize(void)",
        filterText: "confidential_guest_support_finalize",
        replaceRange: range(0, "static void ".length, linePrefix.length),
      },
    })
  })

  test("InlineEditAdapter rejects selected completion edits that cannot extend the selected text", () => {
    const linePrefix = "static void con"
    expect(adaptAndValidateInlineCompletionEdit({
      edit: {
        insertText: "static void finalize(void)",
        filterText: "static void finalize(void)",
        replaceRange: range(0, 0, linePrefix.length),
      },
      editInput: editInput({
        languageId: "c",
        linePrefix,
        character: linePrefix.length,
        currentWord: "con",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
      selectedCompletionInfo: {
        text: "confidential_guest_support_finalize",
        range: range(0, "static void ".length, linePrefix.length),
      },
    })).toEqual({
      status: "rejected",
      reason: "selectedCompletionInfo-text-not-prefix",
    })
  })

  test("InlineEditBuilder validates VS Code inline completion display invariants", () => {
    expect(validateInlineCompletionEdit({
      edit: {
        insertText: "static void test_case(void)",
        filterText: "static void",
        replaceRange: {
          startLine: 0,
          startCharacter: 0,
          endLine: 0,
          endCharacter: "static void".length,
        },
      },
      editInput: editInput({
        languageId: "c",
        linePrefix: "static void",
        character: "static void".length,
        currentWord: "void",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
    })).toEqual({ valid: true })

    expect(validateInlineCompletionEdit({
      edit: {
        insertText: "test_case(void)",
        filterText: "static void",
        replaceRange: range(0, 0, "static void".length),
      },
      editInput: editInput({
        languageId: "c",
        linePrefix: "static void",
        character: "static void".length,
        currentWord: "void",
      }),
      plan: inlinePlan("replace-whole-line", "previous-comment-continuation"),
    })).toEqual({
      valid: false,
      reason: "insertText-does-not-preserve-rangeText",
    })

    expect(validateInlineCompletionEdit({
      edit: {
        insertText: "printf(\"ok\");",
        filterText: "printf",
        replaceRange: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 10,
        },
      },
      editInput: editInput({
        languageId: "c",
        linePrefix: "    printf",
        character: "    printf".length,
        currentWord: "printf",
      }),
      plan: inlinePlan("replace-current-word", "symbol-completion"),
      selectedCompletionInfo: {
        text: "printf",
        range: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 10,
        },
      },
    })).toEqual({ valid: true })

    expect(validateInlineCompletionEdit({
      edit: {
        insertText: "puts(\"ok\");",
        filterText: "puts",
        replaceRange: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 8,
        },
      },
      editInput: editInput({
        languageId: "c",
        linePrefix: "    printf",
        character: "    printf".length,
        currentWord: "printf",
      }),
      plan: inlinePlan("replace-current-word", "symbol-completion"),
      selectedCompletionInfo: {
        text: "printf",
        range: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 10,
        },
      },
    })).toEqual({
      valid: false,
      reason: "selectedCompletionInfo-range-mismatch",
    })

    expect(validateInlineCompletionEdit({
      edit: {
        insertText: "puts(\"ok\");",
        filterText: "puts",
        replaceRange: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 10,
        },
      },
      editInput: editInput({
        languageId: "c",
        linePrefix: "    printf",
        character: "    printf".length,
        currentWord: "printf",
      }),
      plan: inlinePlan("replace-current-word", "symbol-completion"),
      selectedCompletionInfo: {
        text: "printf",
        range: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 10,
        },
      },
    })).toEqual({
      valid: false,
      reason: "selectedCompletionInfo-text-not-prefix",
    })
  })

  test("InlineEditBuilder rejects empty insertText for explicit insert modes", () => {
    expect(inlineEditResult({
      insertMode: "insert-after-line",
      text: "",
      languageId: "c",
      linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
      character: "// unit test for epr_ppn_raw_write_cb_dfx()".length,
    })).toEqual({
      reason: "empty-model-text",
    })
  })

  test("replaces C function-signature colons with a brace block", () => {
    expect(edit({
      text: "return 1 - 1;",
      languageId: "c",
      linePrefix: "int minus():",
      character: "int minus():".length,
    })).toMatchObject({
      insertText: " {\n    return 1 - 1;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: "int minus()".length,
        endLine: 0,
        endCharacter: "int minus():".length,
      },
      filterText: ":",
    })
  })

  test("keeps C brace blocks legal and correctly indented", () => {
    expect(edit({
      text: "return 1 - 1;",
      languageId: "c",
      linePrefix: "int minus() {",
      character: "int minus() {".length,
    })?.insertText).toBe("\n    return 1 - 1;")
  })

  test("wraps single-line C control bodies in braces", () => {
    expect(edit({
      text: "if (condition)\nreturn 0;",
      languageId: "c",
      linePrefix: "int minus() {",
      character: "int minus() {".length,
    })?.insertText).toBe("\n    if (condition) {\n        return 0;\n    }")
  })

  test("keeps Python colon blocks and indents the body", () => {
    expect(edit({
      text: "return 1 - 1",
      languageId: "python",
      linePrefix: "def minus():",
      character: "def minus():".length,
    })?.insertText).toBe("\n    return 1 - 1")
  })

  test("keeps JavaScript multiline brace completions aligned", () => {
    expect(edit({
      text: "if (ok) {\nreturn ok;\n}",
      languageId: "javascript",
      linePrefix: "function f() {",
      character: "function f() {".length,
    })?.insertText).toBe("\n    if (ok) {\n        return ok;\n    }")
  })

  test("does not make cross-line edits when the cursor has a non-empty suffix", () => {
    expect(edit({
      text: "return x;",
      languageId: "c",
      linePrefix: "if (x) {",
      lineSuffix: " }",
      character: "if (x) {".length,
    })).toMatchObject({
      insertText: "return x;",
      replaceRange: {
        startLine: 0,
        startCharacter: "if (x) {".length,
        endLine: 0,
        endCharacter: "if (x) {".length,
      },
      filterText: "return x;",
    })
  })

  test("replaces the current C word with a full while block", () => {
    expect(edit({
      text: "while (1) {\nreturn;\n}",
      languageId: "c",
      linePrefix: "    whil",
      character: "    whil".length,
      currentWord: "whil",
    })).toMatchObject({
      insertText: "while (1) {\n        return;\n    }",
      replaceRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 8,
      },
      filterText: "while (1) {\n        return;\n    }",
    })
  })

  test("falls back to a C while template when the model returns no visible text", () => {
    expect(edit({
      text: "",
      languageId: "c",
      linePrefix: "    whil",
      character: "    whil".length,
      currentWord: "whil",
    })).toMatchObject({
      insertText: "while (condition) {\n\n    }",
      replaceRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 8,
      },
    })
  })

  test("falls back to JavaScript control-flow templates", () => {
    expect(edit({
      text: "",
      languageId: "javascript",
      linePrefix: "if",
      character: 2,
      currentWord: "if",
    })).toMatchObject({
      insertText: "if (condition) {\n\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 2,
      },
    })

    expect(edit({
      text: "",
      languageId: "typescript",
      linePrefix: "  for",
      character: 5,
      currentWord: "for",
    })).toMatchObject({
      insertText: "for (;;) {\n\n  }",
      replaceRange: {
        startLine: 0,
        startCharacter: 2,
        endLine: 0,
        endCharacter: 5,
      },
    })
  })

  test("replaces JavaScript current words without duplicating typed text", () => {
    expect(edit({
      text: "const value = 1",
      languageId: "javascript",
      linePrefix: "con",
      character: 3,
      currentWord: "con",
    })).toMatchObject({
      insertText: "const value = 1",
      replaceRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 3,
      },
      filterText: "const value = 1",
    })
  })

  test("strips full current-line prefixes from C function completions", () => {
    const prefix = "void simulate"
    expect(edit({
      text: "void simulate_cpu_worker() {\nreturn;\n}",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "simulate",
    })).toMatchObject({
      insertText: "_cpu_worker() {\n    return;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "_cpu_worker() {\n    return;\n}",
      normalized: "prefix-overlap",
    })
  })

  test("replaces current words when the model starts with the current word", () => {
    const prefix = "void simulate"
    expect(edit({
      text: "simulate_cpu_worker() {\nreturn;\n}",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "simulate",
    })).toMatchObject({
      insertText: "simulate_cpu_worker() {\n    return;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: "void ".length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "simulate_cpu_worker() {\n    return;\n}",
    })
  })

  test("strips partial line prefixes without duplicating typed text", () => {
    const prefix = "int ma"
    expect(edit({
      text: "int main(void) {\nreturn 0;\n}",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "ma",
    })).toMatchObject({
      insertText: "in(void) {\n    return 0;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "in(void) {\n    return 0;\n}",
      normalized: "prefix-overlap",
    })
  })

  test("rejects echoed comment prefixes with no new completion text", () => {
    const prefix = "// a unittest function to test epr_ppn_raw_"
    expect(editResult({
      text: prefix,
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_",
    })).toEqual({
      reason: "echoed-prefix",
    })

    expect(editResult({
      text: `${prefix}${prefix}`,
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_",
    })).toEqual({
      reason: "echoed-prefix",
    })
  })

  test("strips echoed comment prefixes while keeping real suffix text", () => {
    const prefix = "// a unittest function to test epr_ppn_raw_"
    expect(edit({
      text: `${prefix}write_with_cb_dfx`,
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_",
    })).toMatchObject({
      insertText: "write_with_cb_dfx",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "write_with_cb_dfx",
      normalized: "prefix-overlap",
    })

    expect(edit({
      text: `${prefix}${prefix}write_with_cb_dfx`,
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_",
    })?.insertText).toBe("write_with_cb_dfx")
  })

  test("replaces partial symbols from bare unit-test prompt echoes", () => {
    const prefix = "unit test for epr_ppn_raw_wr"
    expect(edit({
      text: "unit test for epr_ppn_raw_write_with_cb_dfx",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_wr",
      preferCurrentWordReplacement: true,
    })).toMatchObject({
      insertText: "epr_ppn_raw_write_with_cb_dfx",
      replaceRange: {
        startLine: 0,
        startCharacter: "unit test for ".length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "epr_ppn_raw_write_with_cb_dfx",
    })
  })

  test("keeps code after echoed comment prefixes on the next line", () => {
    const prefix = "// a unittest function to test epr_ppn_raw_"
    expect(edit({
      text: `${prefix}\nvoid test_epr_ppn_raw_write(void) {\nreturn;\n}`,
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "epr_ppn_raw_",
    })).toMatchObject({
      insertText: "\nvoid test_epr_ppn_raw_write(void) {\n    return;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      normalized: "prefix-overlap",
    })
  })

  test("rejects leading-newline completions that do not continue the current C line", () => {
    const prefix = "void test"
    expect(editResult({
      text: "\n\n_epr_ppn_raw_write_with_cb_dfx(void);",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "test",
    })).toEqual({
      reason: "misaligned-leading-newline",
    })
  })

  test("strips leading-newline full-line overlaps before rejecting them", () => {
    const prefix = "void test"
    expect(edit({
      text: "\nvoid test_case(void);",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "test",
    })).toMatchObject({
      insertText: "_case(void);",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "_case(void);",
      normalized: "prefix-overlap",
    })
  })

  test("allows leading-newline current-word replacements that still match the cursor word", () => {
    const prefix = "void test"
    expect(edit({
      text: "\ntest_case(void);",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "test",
    })).toMatchObject({
      insertText: "test_case(void);",
      replaceRange: {
        startLine: 0,
        startCharacter: "void ".length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "test_case(void);",
    })
  })

  test("allows leading newlines after C block openers", () => {
    const prefix = "int f() {"
    expect(edit({
      text: "\nreturn;",
      languageId: "c",
      linePrefix: prefix,
      character: prefix.length,
    })?.insertText).toBe("\n    return;")
  })

  test("inserts TypeScript code completions after comment prompts on the next line", () => {
    const prefix = "// test func for add two numb"
    expect(edit({
      text: "function add(a: number, b: number) {\nreturn a + b;\n}",
      languageId: "typescript",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "numb",
    })).toMatchObject({
      insertText: "\nfunction add(a: number, b: number) {\n    return a + b;\n}",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
    })
  })

  test("allows leading-newline code completions after comment prompts", () => {
    const prefix = "// test func for add two numb"
    expect(edit({
      text: "\nfunction add(a: number, b: number) {\nreturn a + b;\n}",
      languageId: "typescript",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "numb",
    })?.insertText).toBe("\nfunction add(a: number, b: number) {\n    return a + b;\n}")
  })

  test("keeps non-code completions after comment prompts on the same line", () => {
    const prefix = "// add two numb"
    expect(edit({
      text: "ers",
      languageId: "typescript",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "numb",
    })?.insertText).toBe("ers")
  })

  test("uses explicit zero-width ranges for ordinary suffix insertions", () => {
    const prefix = "const na"
    expect(edit({
      text: "me = 1",
      languageId: "javascript",
      linePrefix: prefix,
      character: prefix.length,
      currentWord: "na",
    })).toMatchObject({
      insertText: "me = 1",
      replaceRange: {
        startLine: 0,
        startCharacter: prefix.length,
        endLine: 0,
        endCharacter: prefix.length,
      },
      filterText: "me = 1",
    })
  })

  test("does not use control-flow fallback when the cursor has a non-empty suffix", () => {
    expect(buildCompletionEditResult({
      text: "",
      languageId: "c",
      linePrefix: "    whil",
      lineSuffix: "e (done)",
      position: { line: 0, character: 8 },
      indent: { indentUnit: "    ", targetIndent: "    " },
      currentWord: "whil",
      currentWordRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 8,
      },
    })).toEqual({
      reason: "empty-model-text",
    })
  })

  test("returns an explicit reason when no completion can be built", () => {
    expect(buildCompletionEditResult({
      text: "",
      languageId: "c",
      linePrefix: "    value",
      lineSuffix: "",
      position: { line: 0, character: 9 },
      indent: { indentUnit: "    ", targetIndent: "    " },
      currentWord: "value",
      currentWordRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 9,
      },
    })).toEqual({
      reason: "empty-model-text",
    })
  })

  test("returns an explicit reason for unsafe C colon contexts", () => {
    expect(buildCompletionEditResult({
      text: "value",
      languageId: "c",
      linePrefix: "label:",
      lineSuffix: "",
      position: { line: 0, character: 6 },
      indent: { indentUnit: "    ", targetIndent: "    " },
    })).toEqual({
      reason: "unsafe-colon-context",
    })
  })
})

function inlinePlan(insertMode: CompletionInsertMode, kind: CompletionPlanKind = "ordinary-code"): CompletionPlan {
  return {
    kind,
    insertMode,
    replaceCurrentWord: insertMode === "replace-current-word" || insertMode === "replace-whole-line",
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    useFim: kind === "ordinary-code" || kind === "body-continuation" || kind === "top-level-declaration",
    useInstruction: kind !== "ordinary-code" &&
      kind !== "body-continuation" &&
      kind !== "top-level-declaration" &&
      kind !== "symbol-completion",
    maxTokens: 128,
    confidenceFloor: 0.5,
  }
}

function editInput(input: {
  languageId: string
  linePrefix: string
  character: number
  lineSuffix?: string
  currentWord?: string
}) {
  const currentWord = input.currentWord
  const startCharacter = currentWord ? input.character - currentWord.length : input.character
  return {
    languageId: input.languageId,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix ?? "",
    position: { line: 0, character: input.character },
    indent: { indentUnit: "    ", targetIndent: "    " },
    currentWord,
    currentWordRange: currentWord ? range(0, startCharacter, input.character) : undefined,
  }
}

function range(line: number, startCharacter: number, endCharacter: number) {
  return {
    startLine: line,
    startCharacter,
    endLine: line,
    endCharacter,
  }
}

function applySingleLineEdit(lineText: string, editRange: ReturnType<typeof range> | undefined, insertText: string) {
  const rangeValue = editRange ?? range(0, lineText.length, lineText.length)
  return `${lineText.slice(0, rangeValue.startCharacter)}${insertText.split("\n")[0] ?? ""}${lineText.slice(rangeValue.endCharacter)}`
}

function edit(input: {
  text: string
  languageId: string
  linePrefix: string
  character: number
  lineSuffix?: string
  currentWord?: string
  preferCurrentWordReplacement?: boolean
}) {
  return editResult(input).edit
}

function inlineEdit(input: {
  insertMode: CompletionInsertMode
  planKind?: CompletionPlanKind
  text: string
  languageId: string
  linePrefix: string
  character: number
  lineSuffix?: string
  currentWord?: string
  symbolHints?: string[]
}) {
  return inlineEditResult(input).edit
}

function inlineEditResult(input: {
  insertMode: CompletionInsertMode
  planKind?: CompletionPlanKind
  text: string
  languageId: string
  linePrefix: string
  character: number
  lineSuffix?: string
  currentWord?: string
  symbolHints?: string[]
}) {
  const currentWord = input.currentWord
  const startCharacter = currentWord ? input.character - currentWord.length : input.character
  return buildInlineCompletionEditResult({
    text: input.text,
    languageId: input.languageId,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix ?? "",
    position: { line: 0, character: input.character },
    indent: { indentUnit: "    ", targetIndent: "    " },
    currentWord,
    currentWordRange: currentWord
      ? {
          startLine: 0,
          startCharacter,
          endLine: 0,
          endCharacter: input.character,
        }
      : undefined,
    symbolHints: input.symbolHints,
    plan: {
      kind: input.planKind,
      insertMode: input.insertMode,
      replaceCurrentWord: input.insertMode === "replace-current-word",
    },
  })
}

function editResult(input: {
  text: string
  languageId: string
  linePrefix: string
  character: number
  lineSuffix?: string
  currentWord?: string
  preferCurrentWordReplacement?: boolean
}) {
  const currentWord = input.currentWord
  const startCharacter = currentWord ? input.character - currentWord.length : input.character
  return buildCompletionEditResult({
    text: input.text,
    languageId: input.languageId,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix ?? "",
    position: { line: 0, character: input.character },
    indent: { indentUnit: "    ", targetIndent: "    " },
    currentWord,
    currentWordRange: currentWord
      ? {
          startLine: 0,
          startCharacter,
          endLine: 0,
          endCharacter: input.character,
        }
      : undefined,
    preferCurrentWordReplacement: input.preferCurrentWordReplacement,
  })
}
