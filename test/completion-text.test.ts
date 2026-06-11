import { describe, expect, test } from "bun:test"
import { completionInsertText } from "../src/completion-text"
import type { ChipMateMessage, ChipMatePart } from "../src/types"

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

  test("strips obvious prompt and plan-mode leakage before code", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "Let me re-read the system prompt carefully. The plan mode reminder says I should be read-only.\n\nreturn 1 + 1;",
      },
    ]))

    expect(text).toBe("return 1 + 1;")
  })

  test("suppresses pure prompt and plan-mode leakage", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "Let me re-read the system prompt carefully. The inline code completion engine rule says return only the exact text to insert at the cursor.",
      },
    ]))

    expect(text).toBe("")
  })

  test("extracts chat code from explanatory lead-ins", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "Sure, here is the completion:\nconst value = 1;",
      },
    ]))

    expect(text).toBe("const value = 1;")
  })

  test("uses explicit fenced or final reasoning only when visible text is empty", () => {
    expect(completionInsertText(message([
      { type: "reasoning", text: "I will output this.\n\nCompletion:\nreturn ok;" },
    ]))).toBe("return ok;")

    expect(completionInsertText(message([
      { type: "reasoning", text: "I am thinking about the answer, but there is no final code." },
    ]))).toBe("")
  })

  test("cleans Qwen coder FIM output without removing code indentation", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "<|fim_middle|>\n    return a + b;\n<|endoftext|>",
      },
    ]), "qwen-coder-fim")

    expect(text).toBe("\n    return a + b;")
  })

  test("suppresses pure Qwen coder FIM metadata", () => {
    const text = completionInsertText(message([
      {
        type: "text",
        text: "<|fim_middle|>Here is the completion:",
      },
    ]), "qwen-coder-fim")

    expect(text).toBe("")
  })
})

function message(parts: ChipMatePart[]): ChipMateMessage {
  return {
    info: { id: "completion", role: "assistant" },
    parts,
  }
}
