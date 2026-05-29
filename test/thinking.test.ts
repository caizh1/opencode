import { describe, expect, test } from "bun:test"
import { extractThinkBlocks, splitThinkingFromParts } from "../src/thinking"

describe("thinking content splitting", () => {
  test("removes think blocks from visible text", () => {
    const split = splitThinkingFromParts([{ type: "text", text: "<think>hidden</think>visible" }])

    expect(split.text).toBe("visible")
    expect(split.reasoning).toBe("hidden")
  })

  test("extracts multiline think blocks case-insensitively", () => {
    const split = extractThinkBlocks("before<THINK>\nstep 1\nstep 2\n</think>after")

    expect(split.text).toBe("beforeafter")
    expect(split.thinking).toEqual(["step 1\nstep 2"])
  })

  test("keeps reasoning parts out of visible text", () => {
    const split = splitThinkingFromParts([
      { type: "reasoning", text: "internal chain" },
      { type: "text", text: "answer" },
    ])

    expect(split.text).toBe("answer")
    expect(split.reasoning).toBe("internal chain")
  })

  test("combines tag and part reasoning in a collapsed-card-friendly detail", () => {
    const split = splitThinkingFromParts([
      { type: "text", text: "<think>tagged</think>visible" },
      { type: "reasoning", text: "structured" },
    ])

    expect(split.text).toBe("visible")
    expect(split.reasoning).toBe("tagged\n\nstructured")
  })
})
