import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { decodeDrawioPngDataUri, decodePngDataUri, drawioPngFilename, pngExportFilename } from "../src/drawio-export"

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngDataUri(extra: number[] = []) {
  return `data:image/png;base64,${Buffer.from([...pngSignature, ...extra]).toString("base64")}`
}

describe("draw.io PNG export helpers", () => {
  test("decodes only PNG data URI payloads", () => {
    const bytes = decodeDrawioPngDataUri(pngDataUri([1, 2, 3]))

    expect(Array.from(bytes.slice(0, 8))).toEqual(pngSignature)
    expect(bytes[8]).toBe(1)
  })

  test("rejects non-PNG, malformed, and remote export payloads", () => {
    expect(() => decodeDrawioPngDataUri("https://example.com/diagram.png")).toThrow("PNG data URI")
    expect(() => decodeDrawioPngDataUri("data:image/svg+xml;base64,PHN2Zy8+")).toThrow("PNG data URI")
    expect(() => decodeDrawioPngDataUri("data:text/html;base64,PGh0bWw+")).toThrow("PNG data URI")
    expect(() => decodeDrawioPngDataUri("data:image/png;base64,not base64!!")).toThrow("invalid base64")
    expect(() => decodeDrawioPngDataUri("data:image/png;base64,Zm9vYmFy")).toThrow("not a PNG")
  })

  test("enforces PNG size limits after base64 decoding", () => {
    expect(() => decodeDrawioPngDataUri(pngDataUri([0, 1, 2, 3]), 10)).toThrow("too large")
  })

  test("sanitizes PNG export filenames", () => {
    expect(drawioPngFilename("Architecture Flow.drawio")).toBe("Architecture-Flow.png")
    expect(drawioPngFilename("../bad:name?.svg")).toBe("-bad-name.png")
    expect(drawioPngFilename("diagram.png")).toBe("diagram.png")
    expect(drawioPngFilename("")).toBe("chipmate-drawio-diagram.png")
    expect(pngExportFilename("Mermaid Flow.mmd", "chipmate-mermaid-diagram")).toBe("Mermaid-Flow.png")
    expect(pngExportFilename("", "chipmate-mermaid-diagram")).toBe("chipmate-mermaid-diagram.png")
  })

  test("supports generic PNG data URI validation labels", () => {
    expect(Array.from(decodePngDataUri(pngDataUri(), "Mermaid PNG export").slice(0, 8))).toEqual(pngSignature)
    expect(() => decodePngDataUri("data:text/plain;base64,Zm9v", "Mermaid PNG export")).toThrow("Mermaid PNG export must be a PNG data URI")
  })
})
