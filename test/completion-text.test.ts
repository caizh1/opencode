import { describe, expect, test } from "bun:test"
import { completionInsertText } from "../src/completion-text"
import type { OpenCodeMessage, OpenCodePart } from "../src/types"

describe("completion insert text", () => {
  test("uses text parts and drops structured reasoning", () => {
    const text = completionInsertText(message([
      { type: "reasoning", text: "Let me think through the prompt." },
      { type: "text", text: "return 1 + 1;" },
    ]))

    expect(text).toBe("return 1 + 1;")
  })

  test("strips think blocks from text parts", () => {
    const text = completionInsertText(message([
      { type: "text", text: "<think>hidden reasoning</think>return 1 + 1;" },
    ]))

    expect(text).toBe("return 1 + 1;")
  })

  test("unwraps fenced code output", () => {
    const text = completionInsertText(message([
      { type: "text", text: "```c\nreturn 1 + 1;\n```" },
    ]))

    expect(text).toBe("return 1 + 1;")
  })

  test("preserves meaningful leading newlines and indentation", () => {
    const text = completionInsertText(message([
      { type: "text", text: "\n    return 1 + 1;\n" },
    ]))

    expect(text).toBe("\n    return 1 + 1;")
  })

  test("suppresses obvious prompt and plan-mode leakage", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "Let me re-read the system prompt carefully. The plan mode reminder says I should be read-only.\n\nreturn 1 + 1;",
      },
    ]))

    expect(text).toBe("")
  })
})

function message(parts: OpenCodePart[]): OpenCodeMessage {
  return {
    info: { id: "completion", role: "assistant" },
    parts,
  }
}
