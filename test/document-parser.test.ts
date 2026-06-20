import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSupportedDocument } from "../src/document-parser"
import { docxFixture, pdfFixture, pdfWithoutTextFixture, xlsxFixture, xlsxRowsFixture } from "./document-fixtures"

describe("document parser", () => {
  test("keeps Office parser dependencies off the activation import path", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "document-parser.ts"), "utf8")

    expect(source).not.toMatch(/^import .*["']exceljs["']/m)
    expect(source).not.toMatch(/^import .*["']mammoth["']/m)
    expect(source).not.toMatch(/^import .*["']node-html-parser["']/m)
    expect(source).toContain('nodeRequire("exceljs")')
    expect(source).toContain('nodeRequire("mammoth")')
    expect(source).toContain('nodeRequire("node-html-parser")')
  })

  test("extracts DOCX body text from a bundled OOXML archive", async () => {
    const parsed = await parseSupportedDocument({
      path: "docs/notes.docx",
      bytes: docxFixture("Hello Word\nSecond paragraph"),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "docx", language: "docx", truncated: false })
    expect(parsed?.text).toContain("DOCX text:")
    expect(parsed?.text).toContain("Hello Word")
    expect(parsed?.text).toContain("Second paragraph")
    expect(parsed?.blocks.some((block) => block.kind === "paragraph")).toBe(true)
  })

  test("formats XLSX worksheets with shared strings, rows, formulas, and values", async () => {
    const parsed = await parseSupportedDocument({
      path: "reports/summary.xlsx",
      bytes: xlsxFixture(),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "xlsx", language: "xlsx" })
    expect(parsed?.text).toContain('sheet "Summary" range=A1:C2')
    expect(parsed?.text).toContain("header row 1: A1=Metric | B1=Count | C1=Formula")
    expect(parsed?.text).toContain("row 2: A2=Boards | B2=3 | C2={formula:B2*2, value:6}")
    expect(parsed?.blocks).toContainEqual(expect.objectContaining({
      kind: "worksheet-summary",
      sheetName: "Summary",
      cellRange: "A1:C2",
    }))
    expect(parsed?.blocks).toContainEqual(expect.objectContaining({
      kind: "worksheet-rows",
      sheetName: "Summary",
      rowStart: 1,
      rowEnd: 2,
    }))
  })

  test("keeps up to 300 non-empty Excel rows per worksheet", async () => {
    const parsed = await parseSupportedDocument({
      path: "reports/rows.xlsx",
      bytes: xlsxRowsFixture(305),
      maxBytes: 256_000,
    })

    expect(parsed?.text).toContain('sheet "Rows" range=A1:B305')
    expect(parsed?.text).toContain("row 300: A300=Item 300 | B300=300")
    expect(parsed?.text).not.toContain("row 301: A301=Item 301 | B301=301")
    expect(parsed?.text).toContain("[5 row(s) omitted after first 300 non-empty rows]")
    expect(parsed?.blocks).toContainEqual(expect.objectContaining({
      kind: "worksheet-rows",
      sheetName: "Rows",
      rowStart: 271,
      rowEnd: 300,
    }))
  })

  test("reads XLSM workbook cells without executing macros", async () => {
    const parsed = await parseSupportedDocument({
      path: "reports/macro-book.xlsm",
      bytes: xlsxFixture(),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "xlsm", language: "xlsm" })
    expect(parsed?.text).toContain("Macro streams are not executed")
    expect(parsed?.text).toContain("A2=Boards")
  })

  test("extracts text-layer PDF content without external binaries", async () => {
    const parsed = await parseSupportedDocument({
      path: "manual.pdf",
      bytes: pdfFixture("Hello PDF text layer"),
      maxBytes: 16_000,
    })

    expect(parsed).toMatchObject({ kind: "pdf", language: "pdf" })
    expect(parsed?.text).toContain("PDF text:")
    expect(parsed?.text).toContain("Hello PDF text layer")
    expect(parsed?.blocks).toContainEqual(expect.objectContaining({
      kind: "pdf-page",
      pageStart: 1,
      pageEnd: 1,
    }))
  })

  test("reports image-only or empty PDFs without pretending OCR support", async () => {
    const parsed = await parseSupportedDocument({
      path: "scan.pdf",
      bytes: pdfWithoutTextFixture(),
      maxBytes: 16_000,
    })

    expect(parsed?.text).toContain("No extractable PDF text layer found")
    expect(parsed?.text).toContain("Image-only PDFs and scanned pages are not supported")
  })

  test("keeps max byte limits for large documents", async () => {
    const parsed = await parseSupportedDocument({
      path: "docs/large.docx",
      bytes: docxFixture("A".repeat(2048)),
      maxBytes: 128,
    })

    expect(parsed?.truncated).toBe(true)
    expect(Buffer.byteLength(parsed?.text ?? "", "utf8")).toBeLessThanOrEqual(128)
  })
})
