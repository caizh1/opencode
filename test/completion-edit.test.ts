import { describe, expect, test } from "bun:test"
import { buildCompletionEdit, buildCompletionEditResult } from "../src/completion-edit"

describe("language-aware completion edits", () => {
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
}) {
  const currentWord = input.currentWord
  const startCharacter = currentWord ? input.character - currentWord.length : input.character
  return buildCompletionEdit({
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
  })
}
