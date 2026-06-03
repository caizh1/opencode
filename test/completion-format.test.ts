import { describe, expect, test } from "bun:test"
import { formatCompletionInsertText } from "../src/completion-format"

describe("completion insert formatting", () => {
  test("moves statement completions after colon blocks onto an indented next line", () => {
    expect(formatCompletionInsertText({
      text: "return 1 - 1;",
      linePrefix: "int minus():",
      targetIndent: "    ",
      indentUnit: "    ",
    })).toBe("\n    return 1 - 1;")
  })

  test("moves statement completions after brace blocks onto an indented next line", () => {
    expect(formatCompletionInsertText({
      text: "return x;",
      linePrefix: "if (x) {",
      targetIndent: "    ",
      indentUnit: "    ",
    })).toBe("\n    return x;")
  })

  test("normalizes already newline-prefixed completions to the target indent", () => {
    expect(formatCompletionInsertText({
      text: "\n        return 1 - 1;",
      linePrefix: "int minus():",
      targetIndent: "    ",
      indentUnit: "    ",
    })).toBe("\n    return 1 - 1;")
  })

  test("keeps relative indentation inside multiline completions", () => {
    expect(formatCompletionInsertText({
      text: "\n        if (ok) {\n            return ok;\n        }",
      linePrefix: "int check():",
      targetIndent: "    ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe("\n    if (ok) {\n        return ok;\n    }")
  })

  test("keeps ordinary inline completions on the same line", () => {
    expect(formatCompletionInsertText({
      text: "me = 1",
      linePrefix: "const na",
      targetIndent: "    ",
      indentUnit: "    ",
    })).toBe("me = 1")
  })

  test("moves code completions after comment prompts onto the next line", () => {
    expect(formatCompletionInsertText({
      text: "function add(a: number, b: number) {\nreturn a + b;\n}",
      linePrefix: "// test func for add two numb",
      targetIndent: "",
      indentUnit: "    ",
      languageId: "typescript",
    })).toBe("\nfunction add(a: number, b: number) {\n    return a + b;\n}")
  })

  test("keeps non-code comment continuations on the same line", () => {
    expect(formatCompletionInsertText({
      text: "ers",
      linePrefix: "// add two numb",
      targetIndent: "",
      indentUnit: "    ",
      languageId: "typescript",
    })).toBe("ers")
  })

  test("uses comment indentation as the generated code indentation", () => {
    expect(formatCompletionInsertText({
      text: "def add(a, b):\nreturn a + b",
      linePrefix: "    # add two numbers",
      targetIndent: "        ",
      indentUnit: "    ",
      languageId: "python",
    })).toBe("\n    def add(a, b):\n        return a + b")
  })

  test("does not force block formatting when the cursor has a non-empty suffix", () => {
    expect(formatCompletionInsertText({
      text: "return x;",
      linePrefix: "if (x) {",
      lineSuffix: " }",
      targetIndent: "    ",
      indentUnit: "    ",
    })).toBe("return x;")
  })

  test("uses tab target indentation when inferred from the file", () => {
    expect(formatCompletionInsertText({
      text: "return x;",
      linePrefix: "if (x) {",
      targetIndent: "\t",
      indentUnit: "\t",
    })).toBe("\n\treturn x;")
  })

  test("normalizes multiline completions on indented blank lines", () => {
    expect(formatCompletionInsertText({
      text: "if (ok) {\nreturn ok;\n}",
      linePrefix: "        ",
      targetIndent: "            ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe("if (ok) {\n            return ok;\n        }")
  })

  test("aligns C preprocessor branches on indented blank lines", () => {
    expect(formatCompletionInsertText({
      text: [
        "#if defined(__arm__) || defined(__aarch64__)",
        '__asm__ volatile("yield" ::: "memory");',
        "#else",
        "_mm_pause();",
        "#endif",
      ].join("\n"),
      linePrefix: "            ",
      targetIndent: "                ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe([
      "#if defined(__arm__) || defined(__aarch64__)",
      '                __asm__ volatile("yield" ::: "memory");',
      "            #else",
      "                _mm_pause();",
      "            #endif",
    ].join("\n"))
  })

  test("normalizes wrongly indented C preprocessor output", () => {
    expect(formatCompletionInsertText({
      text: [
        "            #if defined(__arm__) || defined(__aarch64__)",
        '                __asm__ volatile("yield" ::: "memory");',
        "#else",
        "                _mm_pause();",
        "#endif",
      ].join("\n"),
      linePrefix: "            ",
      targetIndent: "                ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe([
      "#if defined(__arm__) || defined(__aarch64__)",
      '                __asm__ volatile("yield" ::: "memory");',
      "            #else",
      "                _mm_pause();",
      "            #endif",
    ].join("\n"))
  })

  test("keeps nested C preprocessor directives aligned", () => {
    expect(formatCompletionInsertText({
      text: "#if OUTER\n#if INNER\nwork();\n#else\nfallback();\n#endif\n#endif",
      linePrefix: "    ",
      targetIndent: "        ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe([
      "#if OUTER",
      "        #if INNER",
      "            work();",
      "        #else",
      "            fallback();",
      "        #endif",
      "    #endif",
    ].join("\n"))
  })

  test("keeps brace blocks inside C preprocessor branches indented", () => {
    expect(formatCompletionInsertText({
      text: "#if ENABLE\nfor (int i = 0; i < 3; i++) {\nwork(i);\n}\n#endif",
      linePrefix: "        ",
      targetIndent: "            ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe([
      "#if ENABLE",
      "            for (int i = 0; i < 3; i++) {",
      "                work(i);",
      "            }",
      "        #endif",
    ].join("\n"))
  })

  test("does not force preprocessor formatting when the cursor has a non-empty suffix", () => {
    const text = "#if ENABLE\nwork();\n#endif"
    expect(formatCompletionInsertText({
      text,
      linePrefix: "        ",
      lineSuffix: "tail",
      targetIndent: "            ",
      indentUnit: "    ",
      languageId: "c",
    })).toBe(text)
  })
})
