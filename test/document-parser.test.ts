import { describe, expect, test } from "bun:test"
import { parseSupportedDocument } from "../src/document-parser"
import { docxFixture, pdfFixture, pdfWithoutTextFixture, xlsxFixture } from "./document-fixtures"

describe("document parser", () => {
  test("extracts DOCX body text from a bundled OOXML archive", () => {
    const parsed = parseSupportedDocument({
      path: "docs/notes.docx",
      bytes: docxFixture("Hello Word\nSecond paragraph"),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "docx", language: "docx", truncated: false })
    expect(parsed?.text).toContain("DOCX text:")
    expect(parsed?.text).toContain("Hello Word")
    expect(parsed?.text).toContain("Second paragraph")
  })

  test("formats XLSX worksheets with shared strings, rows, formulas, and values", () => {
    const parsed = parseSupportedDocument({
      path: "reports/summary.xlsx",
      bytes: xlsxFixture(),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "xlsx", language: "xlsx" })
    expect(parsed?.text).toContain('sheet "Summary" range=A1:C2')
    expect(parsed?.text).toContain("header row 1: A1=Metric | B1=Count | C1=Formula")
    expect(parsed?.text).toContain("row 2: A2=Boards | B2=3 | C2={formula:B2*2, value:6}")
  })

  test("reads XLSM workbook cells without executing macros", () => {
    const parsed = parseSupportedDocument({
      path: "reports/macro-book.xlsm",
      bytes: xlsxFixture(),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "xlsm", language: "xlsm" })
    expect(parsed?.text).toContain("Macro streams are not executed")
    expect(parsed?.text).toContain("A2=Boards")
  })

  test("extracts text-layer PDF content without external binaries", () => {
    const parsed = parseSupportedDocument({
      path: "manual.pdf",
      bytes: pdfFixture("Hello PDF text layer"),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "pdf", language: "pdf" })
    expect(parsed?.text).toContain("PDF text:")
    expect(parsed?.text).toContain("Hello PDF text layer")
  })

  test("reports image-only or empty PDFs without pretending OCR support", () => {
    const parsed = parseSupportedDocument({
      path: "scan.pdf",
      bytes: pdfWithoutTextFixture(),
      maxBytes: 16_000,
    })

    expect(parsed?.text).toContain("No extractable PDF text layer found")
    expect(parsed?.text).toContain("Image-only PDFs and scanned pages are not supported")
  })

  test("keeps max byte limits for large documents", () => {
    const parsed = parseSupportedDocument({
      path: "docs/large.docx",
      bytes: docxFixture("A".repeat(2048)),
      maxBytes: 128,
    })

    expect(parsed?.truncated).toBe(true)
    expect(Buffer.byteLength(parsed?.text ?? "", "utf8")).toBeLessThanOrEqual(128)
  })
})
