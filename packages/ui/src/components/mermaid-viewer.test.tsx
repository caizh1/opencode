import { describe, expect, test } from "bun:test"
import { clampZoomScale, nextZoomScale, renderMermaidSource } from "./mermaid-viewer"

describe("MermaidPreview", () => {
  test("surfaces Mermaid render failures for preview fallback", async () => {
    await expect(
      renderMermaidSource("graph TD", () => Promise.reject(new Error("invalid mermaid"))),
    ).rejects.toThrow("invalid mermaid")
  })

  test("clamps zoom scale to viewer bounds", () => {
    expect(clampZoomScale(Number.NaN)).toBe(1)
    expect(clampZoomScale(0)).toBe(0.1)
    expect(clampZoomScale(1)).toBe(1)
    expect(clampZoomScale(9)).toBe(5)
  })

  test("steps zoom scale within bounds", () => {
    expect(nextZoomScale(1, 0.2)).toBe(1.2)
    expect(nextZoomScale(0.1, -0.2)).toBe(0.1)
    expect(nextZoomScale(4.9, 0.2)).toBe(5)
  })
})
