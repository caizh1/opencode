import { describe, expect, test } from "bun:test"
import { inferCompletionIndent } from "../src/completion-indent"

describe("completion indentation inference", () => {
  test("uses nearby sibling block body indentation first", () => {
    const indent = inferCompletionIndent({
      lines: [
        "",
        "// a function to implement 1 + 1",
        "int add():",
        "    return 1 + 1;",
        "",
        "int minus():",
      ],
      line: 5,
      linePrefix: "int minus():",
      fallbackIndentUnit: "  ",
    })

    expect(indent).toEqual({
      indentUnit: "    ",
      targetIndent: "    ",
    })
  })

  test("uses tab indentation from sibling blocks", () => {
    const indent = inferCompletionIndent({
      lines: [
        "if (x) {",
        "\treturn x;",
        "}",
        "if (y) {",
      ],
      line: 3,
      linePrefix: "if (y) {",
      fallbackIndentUnit: "    ",
    })

    expect(indent).toEqual({
      indentUnit: "\t",
      targetIndent: "\t",
    })
  })

  test("falls back to indentation width inferred from the file", () => {
    const indent = inferCompletionIndent({
      lines: [
        "  const a = 1",
        "    const b = 2",
        "const c = 3",
      ],
      line: 2,
      linePrefix: "if (c) {",
      fallbackIndentUnit: "    ",
    })

    expect(indent).toEqual({
      indentUnit: "  ",
      targetIndent: "  ",
    })
  })

  test("falls back to the editor indentation unit when the file has no signal", () => {
    const indent = inferCompletionIndent({
      lines: ["const c = 3"],
      line: 0,
      linePrefix: "if (c) {",
      fallbackIndentUnit: "\t",
    })

    expect(indent).toEqual({
      indentUnit: "\t",
      targetIndent: "\t",
    })
  })
})
