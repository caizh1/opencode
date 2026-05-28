import { describe, expect, test } from "bun:test"
import {
  dataUrlFromMediaValue,
  documentBytesFromMediaValue,
  mediaKindFromPath,
  svgNaturalSizeFromValue,
  svgTextFromValue,
  textFromMediaValue,
} from "./media"

describe("media", () => {
  test("detects Mermaid source files as previewable diagrams", () => {
    expect(mediaKindFromPath("docs/flow.mmd")).toBe("mermaid")
    expect(mediaKindFromPath("docs/flow.mermaid")).toBe("mermaid")
    expect(mediaKindFromPath("docs/flow.MMD")).toBe("mermaid")
  })

  test("keeps existing media classifications", () => {
    expect(mediaKindFromPath("image.png")).toBe("image")
    expect(mediaKindFromPath("vector.svg")).toBe("svg")
    expect(mediaKindFromPath("icons/Logo.SVG")).toBe("svg")
    expect(mediaKindFromPath("sound.mp3")).toBe("audio")
    expect(mediaKindFromPath("docs/Brief.DOCX")).toBe("document")
    expect(mediaKindFromPath("docs/legacy.doc")).toBeUndefined()
    expect(mediaKindFromPath("readme.md")).toBeUndefined()
  })

  test("turns raw SVG text into a data URL", () => {
    const raw = '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'
    const url = dataUrlFromMediaValue(raw, "svg")

    expect(url?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent(url!.split(",", 2)[1]!)).toBe(raw)
    expect(svgTextFromValue(raw)).toBe(raw)
  })

  test("turns base64 SVG FileContent into a data URL and text", () => {
    const content = {
      type: "text",
      mimeType: "image/svg+xml",
      encoding: "base64",
      content: "PHN2Zz48L3N2Zz4=",
    }

    expect(dataUrlFromMediaValue(content, "svg")).toBe("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")
    expect(svgTextFromValue(content)).toBe("<svg></svg>")
  })

  test("reads SVG natural size from viewBox", () => {
    expect(svgNaturalSizeFromValue('<svg width="10" height="20" viewBox="0 0 640 480"></svg>')).toEqual({
      width: 640,
      height: 480,
    })
  })

  test("reads SVG natural size from numeric width and height", () => {
    expect(svgNaturalSizeFromValue('<svg width="320px" height="180"></svg>')).toEqual({
      width: 320,
      height: 180,
    })
  })

  test("ignores invalid SVG dimensions", () => {
    expect(svgNaturalSizeFromValue('<svg width="100%" height="40"></svg>')).toBeUndefined()
    expect(svgNaturalSizeFromValue('<svg viewBox="0 0 0 40"></svg>')).toBeUndefined()
  })

  test("does not treat arbitrary text as SVG", () => {
    expect(dataUrlFromMediaValue("not svg", "svg")).toBeUndefined()
    expect(svgTextFromValue("<html></html>")).toBeUndefined()
  })

  test("reads text content for Mermaid previews", () => {
    expect(textFromMediaValue({ type: "text", content: "graph TD\nA-->B" })).toBe("graph TD\nA-->B")
    expect(textFromMediaValue({ type: "text", content: "Z3JhcGg=", encoding: "base64" })).toBeUndefined()
  })

  test("reads base64 DOCX bytes from FileContent", () => {
    const content = {
      type: "text",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      encoding: "base64",
      content: "UEsDBA==",
    }

    expect(Array.from(documentBytesFromMediaValue(content) ?? [])).toEqual([80, 75, 3, 4])
    expect(documentBytesFromMediaValue({ ...content, mimeType: "application/msword" })).toBeUndefined()
  })
})
