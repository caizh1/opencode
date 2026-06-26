import { describe, expect, test } from "bun:test"
import {
  createDocumentRagChunks,
  documentRagExcludeGlob,
  documentRagKindFromPath,
  isDocumentRagExcludedPath,
  isSupportedDocumentRagPath,
  searchDocumentRagVectors,
} from "../src/document-rag-index"

describe("document RAG index helpers", () => {
  test("only accepts Word, Excel, and PDF document paths", () => {
    expect(isSupportedDocumentRagPath("docs/legacy.doc")).toBe(true)
    expect(isSupportedDocumentRagPath("docs/spec.docx")).toBe(true)
    expect(isSupportedDocumentRagPath("docs/table.xlsx")).toBe(true)
    expect(isSupportedDocumentRagPath("docs/macro.xlsm")).toBe(true)
    expect(isSupportedDocumentRagPath("docs/manual.pdf")).toBe(true)
    expect(isSupportedDocumentRagPath("src/index.ts")).toBe(false)
    expect(isSupportedDocumentRagPath("docs/archive.zip")).toBe(false)
    expect(documentRagKindFromPath("A/B/LEGACY.DOC")).toBe("doc")
    expect(documentRagKindFromPath("A/B/REPORT.PDF")).toBe("pdf")
  })

  test("matches the workspace exclusions used by Document RAG", () => {
    expect(isDocumentRagExcludedPath("docs/spec.docx")).toBe(false)
    expect(isDocumentRagExcludedPath("node_modules/pkg/spec.pdf")).toBe(true)
    expect(isDocumentRagExcludedPath("source/.git/secret.docx")).toBe(true)
    expect(isDocumentRagExcludedPath("packages/app/dist/manual.pdf")).toBe(true)
    expect(isDocumentRagExcludedPath("packages/app/out/report.xlsx")).toBe(true)
    expect(isDocumentRagExcludedPath("packages/app/build/report.xlsm")).toBe(true)
    expect(isDocumentRagExcludedPath("tmp\\.vscode-test\\fixture.pdf")).toBe(true)
    expect(isDocumentRagExcludedPath("docs/~$legacy.doc")).toBe(true)
    expect(isDocumentRagExcludedPath("docs/~$guar6030v100.xlsx")).toBe(true)
    expect(isDocumentRagExcludedPath("nested/~$foo.docx")).toBe(true)
    expect(isDocumentRagExcludedPath("private/spec.docx", ["private/**"])).toBe(true)
  })

  test("builds an exclude glob that keeps built-in and user exclusions together", () => {
    const glob = documentRagExcludeGlob(["private/**"])

    expect(glob).toContain("**/node_modules/**")
    expect(glob).toContain("**/.git/**")
    expect(glob).toContain("**/~$*")
    expect(glob).toContain("private/**")
  })

  test("chunks documents with stable metadata and overlap", () => {
    const document = {
      uri: "file:///workspace/docs/spec.docx",
      path: "docs/spec.docx",
      kind: "docx" as const,
      size: 1024,
      mtime: 100,
    }
    const chunks = createDocumentRagChunks({
      document,
      text: ["Title", "", "Alpha ".repeat(80), "Beta ".repeat(80), "Gamma ".repeat(80)].join("\n"),
      sourceHash: "hash-a",
      chunkChars: 220,
      overlapChars: 40,
      now: 123,
    })

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toMatchObject({
      documentUri: document.uri,
      path: document.path,
      kind: "docx",
      sourceHash: "hash-a",
      updatedAt: 123,
    })
    expect(chunks[0].id).not.toBe(chunks[1].id)
    expect(chunks.every((chunk) => chunk.startLine <= chunk.endLine)).toBe(true)
  })

  test("chunks structured parser blocks with source metadata", () => {
    const document = {
      uri: "file:///workspace/docs/table.xlsx",
      path: "docs/table.xlsx",
      kind: "xlsx" as const,
      size: 4096,
      mtime: 100,
    }
    const chunks = createDocumentRagChunks({
      document,
      text: [
        "XLSX workbook:",
        'sheet "Rows" range=A1:B300',
        'sheet "Rows" rows 271-300',
        "row 300: A300=Item 300 | B300=300",
      ].join("\n"),
      blocks: [{
        kind: "worksheet-rows",
        label: 'Sheet "Rows" rows 271-300',
        sheetName: "Rows",
        rowStart: 271,
        rowEnd: 300,
        cellRange: "A1:B300",
        lineStart: 3,
        lineEnd: 4,
        text: ['sheet "Rows" rows 271-300', "row 300: A300=Item 300 | B300=300"].join("\n"),
      }],
      sourceHash: "hash-structured",
      now: 456,
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      section: 'Sheet "Rows" rows 271-300',
      chunkKind: "worksheet-rows",
      label: 'Sheet "Rows" rows 271-300',
      sheetName: "Rows",
      rowStart: 271,
      rowEnd: 300,
      cellRange: "A1:B300",
      startLine: 3,
      endLine: 4,
      updatedAt: 456,
    })
  })

  test("searches normalized vectors by cosine score", () => {
    const document = {
      uri: "file:///workspace/docs/spec.pdf",
      path: "docs/spec.pdf",
      kind: "pdf" as const,
      size: 1024,
      mtime: 100,
    }
    const chunks = createDocumentRagChunks({
      document,
      text: `${"alpha beta gamma ".repeat(80)}\n\n${"zeta eta theta ".repeat(80)}`,
      sourceHash: "hash-b",
      chunkChars: 500,
      overlapChars: 0,
    })
    const hits = searchDocumentRagVectors({
      chunks,
      vectors: [[1, 0], [0, 1]],
      queryVector: [0.9, 0.1],
      topK: 1,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].chunk.id).toBe(chunks[0].id)
  })
})
