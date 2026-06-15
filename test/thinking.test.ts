import { describe, expect, test } from "bun:test"
import { extractThinkBlocks, splitThinkingFromParts } from "../src/thinking"

describe("thinking content splitting", () => {
  test("removes think blocks from visible text", () => {
    const split = splitThinkingFromParts([{ type: "text", text: "<think>hidden</think>visible" }])

    expect(split.text).toBe("visible")
    expect(split.reasoning).toBe("hidden")
    expect(split.openThinking).toBe(false)
    expect(split.preview).toBe("hidden")
  })

  test("extracts multiline think blocks case-insensitively", () => {
    const split = extractThinkBlocks("before<THINK>\nstep 1\nstep 2\n</think>after")

    expect(split.text).toBe("beforeafter")
    expect(split.thinking).toEqual(["step 1\nstep 2"])
    expect(split.openThinking).toBe(false)
    expect(split.preview).toBe("step 2")
  })

  test("keeps unfinished think blocks out of visible streaming text", () => {
    const split = splitThinkingFromParts([{ type: "text", text: "<think>checking local context" }])

    expect(split.text).toBe("")
    expect(split.reasoning).toBe("checking local context")
    expect(split.openThinking).toBe(true)
    expect(split.preview).toBe("checking local context")
  })

  test("marks empty opening think tags as running thinking", () => {
    const split = extractThinkBlocks("<think>")

    expect(split.text).toBe("")
    expect(split.thinking).toEqual([])
    expect(split.openThinking).toBe(true)
    expect(split.preview).toBe("")
  })

  test("uses a compact latest-line preview for streaming thinking", () => {
    const longLine = "x".repeat(180)
    const split = extractThinkBlocks(`<think>first line\n${longLine}`)

    expect(split.text).toBe("")
    expect(split.openThinking).toBe(true)
    expect(split.preview.startsWith("xxx")).toBe(true)
    expect(split.preview.length).toBeLessThanOrEqual(120)
    expect(split.preview.endsWith("...")).toBe(true)
  })

  test("keeps reasoning parts out of visible text", () => {
    const split = splitThinkingFromParts([
      { type: "reasoning", text: "internal chain" },
      { type: "text", text: "answer" },
    ])

    expect(split.text).toBe("answer")
    expect(split.reasoning).toBe("internal chain")
    expect(split.openThinking).toBe(false)
    expect(split.preview).toBe("internal chain")
  })

  test("combines tag and part reasoning in a collapsed-card-friendly detail", () => {
    const split = splitThinkingFromParts([
      { type: "text", text: "<think>tagged</think>visible" },
      { type: "reasoning", text: "structured" },
    ])

    expect(split.text).toBe("visible")
    expect(split.reasoning).toBe("tagged\n\nstructured")
    expect(split.openThinking).toBe(false)
    expect(split.preview).toBe("structured")
  })
})
