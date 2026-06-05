import { describe, expect, test } from "bun:test"
import { buildCompletionEdit, buildCompletionEditResult, buildInlineCompletionEditResult } from "../src/completion-edit"
import type { CompletionInsertMode, CompletionPlanKind } from "../src/completion-types"

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
      filterText: prefix,
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

  test("InlineEditBuilder uses range text as filter text for overtyped whole-line replacements", () => {
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
      filterText: "stats",
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
