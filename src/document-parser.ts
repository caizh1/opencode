import { createRequire } from "node:module"
import { inflateRawSync, inflateSync } from "node:zlib"

export type ParsedDocumentKind = "doc" | "docx" | "xlsx" | "xlsm" | "pdf"

export type ParsedDocumentBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "worksheet-summary"
  | "worksheet-rows"
  | "pdf-page"
  | "note"
  | "text"

export type ParsedDocumentBlock = {
  kind: ParsedDocumentBlockKind
  text: string
  label?: string
  lineStart?: number
  lineEnd?: number
  headingPath?: string[]
  sheetName?: string
  rowStart?: number
  rowEnd?: number
  cellRange?: string
  pageStart?: number
  pageEnd?: number
}

export type ParsedDocumentContent = {
  kind: ParsedDocumentKind
  language: string
  text: string
  lineCount: number
  truncated: boolean
  blocks: ParsedDocumentBlock[]
}

type ZipEntry = {
  path: string
  data: Buffer
}

type FormattedCell = {
  ref: string
  value: string
  formula?: string
}

type WorksheetRow = {
  number: string
  cells: FormattedCell[]
}

type WorksheetSnapshot = {
  name: string
  range?: string
  rows: WorksheetRow[]
  omittedRows?: number
}

type ExcelJsModule = typeof import("exceljs")
type ExcelJsWorksheet = import("exceljs").Worksheet
type ExcelJsCell = import("exceljs").Cell
type ExcelJsCellValue = import("exceljs").CellValue
type MammothModule = typeof import("mammoth")
type HtmlParserModule = typeof import("node-html-parser")
type WordExtractorModule = typeof import("word-extractor")

type HtmlNode = {
  rawTagName?: string
  tagName?: string
  childNodes?: HtmlNode[]
  structuredText?: string
  textContent?: string
  innerText?: string
  querySelectorAll?: (selector: string) => HtmlNode[]
}

type PdfJsModule = {
  getDocument: (input: unknown) => {
    promise: Promise<PdfDocumentProxy>
    destroy?: () => Promise<void> | void
  }
}

type PdfDocumentProxy = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPageProxy>
  destroy?: () => Promise<void> | void
}

type PdfPageProxy = {
  getTextContent: (options?: unknown) => Promise<{ items: PdfTextItem[] }>
}

type PdfTextItem = {
  str?: string
  hasEOL?: boolean
}

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_STORED = 0
const ZIP_DEFLATED = 8
const MAX_WORKSHEETS = 8
const MAX_ROWS_PER_SHEET = 300
const MAX_CELLS_PER_ROW = 64
const EXCEL_ROWS_PER_BLOCK = 30
const MAX_PDF_STREAM_BYTES = 12 * 1024 * 1024
const nodeRequire = createRequire(__filename)

let excelJsModule: ExcelJsModule | undefined
let mammothModule: MammothModule | undefined
let htmlParserModule: HtmlParserModule | undefined
let wordExtractorModule: WordExtractorModule | undefined

function loadExcelJs() {
  if (!excelJsModule) excelJsModule = nodeRequire("exceljs") as ExcelJsModule
  return excelJsModule
}

function loadMammoth() {
  if (!mammothModule) mammothModule = nodeRequire("mammoth") as MammothModule
  return mammothModule
}

function loadHtmlParser() {
  if (!htmlParserModule) htmlParserModule = nodeRequire("node-html-parser") as HtmlParserModule
  return htmlParserModule
}

function loadWordExtractor() {
  if (!wordExtractorModule) wordExtractorModule = nodeRequire("word-extractor") as WordExtractorModule
  return wordExtractorModule
}

export function isSupportedDocumentPath(path: string) {
  return supportedDocumentKind(path) !== undefined
}

export async function parseSupportedDocument(input: {
  path: string
  bytes: Uint8Array
  maxBytes: number
}): Promise<ParsedDocumentContent | undefined> {
  const kind = supportedDocumentKind(input.path)
  if (!kind) return undefined
  const blocks = kind === "doc"
    ? await parseDoc(input.bytes)
    : kind === "docx"
      ? await parseDocx(input.bytes)
      : kind === "xlsx" || kind === "xlsm"
        ? await parseWorkbook(input.bytes, kind)
        : await parsePdf(input.bytes)
  const rendered = renderParsedDocument(kind, blocks.length > 0 ? blocks : [noteBlock(emptyDocumentMessage(kind))])
  const limited = limitParsedDocument(rendered.text, rendered.blocks, input.maxBytes)
  return {
    kind,
    language: kind,
    text: limited.text,
    lineCount: Math.max(1, limited.text.split(/\r?\n/).length),
    truncated: limited.truncated,
    blocks: limited.blocks,
  }
}

function supportedDocumentKind(path: string): ParsedDocumentKind | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith(".doc")) return "doc"
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".xlsx")) return "xlsx"
  if (lower.endsWith(".xlsm")) return "xlsm"
  if (lower.endsWith(".pdf")) return "pdf"
  return undefined
}

async function parseDoc(bytes: Uint8Array): Promise<ParsedDocumentBlock[]> {
  try {
    const WordExtractor = loadWordExtractor()
    const extractor = new WordExtractor()
    const document = await extractor.extract(Buffer.from(bytes))
    const blocks: ParsedDocumentBlock[] = []
    addDocTextBlock(blocks, "Document body", "paragraph", document.getBody())
    addDocTextBlock(blocks, "Headers", "text", document.getHeaders({ includeFooters: false }))
    addDocTextBlock(blocks, "Footers", "text", document.getFooters())
    addDocTextBlock(blocks, "Footnotes", "text", document.getFootnotes())
    addDocTextBlock(blocks, "Endnotes", "text", document.getEndnotes())
    addDocTextBlock(blocks, "Annotations", "text", document.getAnnotations())
    addDocTextBlock(blocks, "Textboxes", "text", document.getTextboxes({ includeHeadersAndFooters: false }))
    return blocks.length > 0 ? blocks : [noteBlock("No extractable DOC text found.")]
  } catch (error) {
    return [noteBlock(error instanceof Error ? error.message : String(error))]
  }
}

function addDocTextBlock(blocks: ParsedDocumentBlock[], label: string, kind: ParsedDocumentBlockKind, text: string) {
  const normalized = normalizeTextLines(text)
  if (normalized) blocks.push({ kind, label, text: normalized })
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocumentBlock[]> {
  try {
    const mammoth = loadMammoth()
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { ignoreEmptyParagraphs: true })
    const blocks = htmlDocumentBlocks(result.value)
    if (blocks.length > 0) return blocks
  } catch {
    // Fall back to the small OOXML extractor below for minimal or unusual archives.
  }

  try {
    const text = extractDocxTextFromZip(bytes)
    return text
      ? [{ kind: "paragraph", label: "Document text", text }]
      : [noteBlock("No extractable DOCX text found.")]
  } catch (error) {
    return [noteBlock(error instanceof Error ? error.message : String(error))]
  }
}

function htmlDocumentBlocks(html: string) {
  const root = loadHtmlParser().parse(html) as unknown as HtmlNode
  const blocks: ParsedDocumentBlock[] = []
  const headingPath: string[] = []
  for (const child of root.childNodes ?? []) visitHtmlNode(child, blocks, headingPath)
  if (blocks.length === 0) {
    const text = htmlNodeText(root)
    if (text) blocks.push({ kind: "paragraph", label: "Document text", text })
  }
  return blocks
}

function visitHtmlNode(node: HtmlNode, blocks: ParsedDocumentBlock[], headingPath: string[]) {
  const tag = htmlTagName(node)
  if (!tag) return
  if (/^h[1-6]$/.test(tag)) {
    const text = htmlNodeText(node)
    if (!text) return
    const level = Number(tag.slice(1))
    headingPath[level - 1] = text
    headingPath.length = level
    blocks.push({ kind: "heading", label: `Heading ${level}: ${text}`, text, headingPath: [...headingPath] })
    return
  }
  if (tag === "p" || tag === "blockquote") {
    const text = htmlNodeText(node)
    if (text) blocks.push({ kind: "paragraph", label: headingPath.at(-1) || "Paragraph", text, headingPath: [...headingPath] })
    return
  }
  if (tag === "ul" || tag === "ol") {
    const items = directListItems(node)
      .map((item, index) => `${tag === "ol" ? `${index + 1}.` : "-"} ${htmlNodeText(item)}`)
      .filter((item) => item.trim().length > 2)
    if (items.length > 0) {
      blocks.push({ kind: "list", label: headingPath.at(-1) || "List", text: items.join("\n"), headingPath: [...headingPath] })
    }
    return
  }
  if (tag === "table") {
    const rows = tableRows(node)
    if (rows.length > 0) {
      blocks.push({
        kind: "table",
        label: headingPath.at(-1) ? `Table under ${headingPath.at(-1)}` : "Table",
        text: rows.map((cells, index) => `${index === 0 ? "header" : `row ${index + 1}`}: ${cells.join(" | ")}`).join("\n"),
        headingPath: [...headingPath],
      })
    }
    return
  }
  for (const child of node.childNodes ?? []) visitHtmlNode(child, blocks, headingPath)
}

function directListItems(node: HtmlNode) {
  return (node.childNodes ?? []).filter((child) => htmlTagName(child) === "li")
}

function tableRows(node: HtmlNode) {
  const rows = node.querySelectorAll?.("tr") ?? []
  return rows
    .map((row) => collectTableCells(row).map(htmlNodeText).filter(Boolean))
    .filter((cells) => cells.length > 0)
}

function collectTableCells(row: HtmlNode) {
  const cells: HtmlNode[] = []
  const visit = (node: HtmlNode) => {
    const tag = htmlTagName(node)
    if (tag === "td" || tag === "th") {
      cells.push(node)
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  for (const child of row.childNodes ?? []) visit(child)
  return cells
}

function htmlTagName(node: HtmlNode) {
  return (node.rawTagName || node.tagName || "").toLowerCase()
}

function htmlNodeText(node: HtmlNode) {
  return normalizeTextLines(String(node.structuredText ?? node.textContent ?? node.innerText ?? ""))
}

async function parseWorkbook(bytes: Uint8Array, kind: "xlsx" | "xlsm"): Promise<ParsedDocumentBlock[]> {
  const excelBlocks = await parseWorkbookWithExcelJs(bytes, kind)
  if (excelBlocks.length > 0) return excelBlocks
  return parseWorkbookWithZipFallback(bytes, kind)
}

async function parseWorkbookWithExcelJs(bytes: Uint8Array, kind: "xlsx" | "xlsm") {
  try {
    const ExcelJS = loadExcelJs()
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as never)
    const sheets = workbook.worksheets.slice(0, MAX_WORKSHEETS).map((worksheet) => worksheetSnapshotFromExcelJs(worksheet))
    return workbookBlocks(kind, sheets, workbook.worksheets.length)
  } catch {
    return []
  }
}

function worksheetSnapshotFromExcelJs(worksheet: ExcelJsWorksheet): WorksheetSnapshot {
  const rows: WorksheetRow[] = []
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= MAX_ROWS_PER_SHEET) return
    const cells: FormattedCell[] = []
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cells.length >= MAX_CELLS_PER_ROW) return
      const value = excelJsCellValue(cell)
      if (value) cells.push(value)
    })
    if (cells.length > 0) rows.push({ number: String(row.number), cells })
  })
  return {
    name: worksheet.name || "Sheet",
    range: worksheet.dimensions?.range,
    rows,
    omittedRows: Math.max(0, worksheet.actualRowCount - rows.length),
  }
}

function excelJsCellValue(cell: ExcelJsCell): FormattedCell | undefined {
  const formula = normalizeWhitespace(String(cell.formula ?? ""))
  const value = normalizeWhitespace(cell.text || excelJsValueText(cell.value))
  if (!value && !formula) return undefined
  return { ref: cell.address, value, formula: formula || undefined }
}

function excelJsValueText(value: ExcelJsCellValue): string {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== "object") return String(value)
  if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("")
  if ("text" in value && typeof value.text === "string") return value.text
  if ("result" in value && value.result !== undefined) return String(value.result)
  if ("error" in value && typeof value.error === "string") return value.error
  return JSON.stringify(value)
}

function parseWorkbookWithZipFallback(bytes: Uint8Array, kind: "xlsx" | "xlsm") {
  try {
    const entries = readZipEntries(bytes)
    const workbookXml = zipText(entries, "xl/workbook.xml")
    if (!workbookXml) return [noteBlock(`${kind.toUpperCase()} workbook has no xl/workbook.xml metadata.`)]
    const relationships = workbookRelationships(entries)
    const sharedStrings = workbookSharedStrings(entries)
    const sheets = workbookSheets(workbookXml, relationships)
      .slice(0, MAX_WORKSHEETS)
      .map((sheet) => {
        const xml = zipText(entries, sheet.path)
        if (!xml) return { name: sheet.name, rows: [], omittedRows: 0 } satisfies WorksheetSnapshot
        return worksheetSnapshotFromXml(sheet.name, xml, sharedStrings)
      })
    return workbookBlocks(kind, sheets, workbookSheets(workbookXml, relationships).length)
  } catch (error) {
    return [noteBlock(error instanceof Error ? error.message : String(error))]
  }
}

function worksheetSnapshotFromXml(name: string, xml: string, sharedStrings: string[]): WorksheetSnapshot {
  const range = xml.match(/<dimension\b[^>]*\bref="([^"]+)"/)?.[1]
  const rows = worksheetRows(xml, sharedStrings)
  const emitted = rows.slice(0, MAX_ROWS_PER_SHEET)
  return {
    name,
    range: range ? decodeXml(range) : undefined,
    rows: emitted,
    omittedRows: Math.max(0, rows.length - emitted.length),
  }
}

function workbookBlocks(kind: "xlsx" | "xlsm", sheets: WorksheetSnapshot[], totalSheets: number) {
  const blocks: ParsedDocumentBlock[] = []
  if (sheets.length === 0) blocks.push(noteBlock("No worksheets found."))
  for (const sheet of sheets) {
    blocks.push(...worksheetBlocks(sheet))
  }
  if (totalSheets > MAX_WORKSHEETS) blocks.push(noteBlock(`[${totalSheets - MAX_WORKSHEETS} worksheet(s) omitted]`))
  if (kind === "xlsm") blocks.push(noteBlock("Macro streams are not executed or inspected; only workbook cell data is extracted."))
  return blocks
}

function worksheetBlocks(sheet: WorksheetSnapshot) {
  const blocks: ParsedDocumentBlock[] = []
  const summary = [`sheet "${sheet.name}"${sheet.range ? ` range=${sheet.range}` : ""}`]
  const header = sheet.rows.find((row) => row.cells.length > 0)
  if (!header) {
    summary.push("[empty worksheet]")
    blocks.push({ kind: "worksheet-summary", label: `Sheet "${sheet.name}"`, sheetName: sheet.name, cellRange: sheet.range, text: summary.join("\n") })
    return blocks
  }
  summary.push(`header row ${header.number}: ${formatCells(header.cells)}`)
  blocks.push({ kind: "worksheet-summary", label: `Sheet "${sheet.name}"`, sheetName: sheet.name, cellRange: sheet.range, text: summary.join("\n") })

  for (let index = 0; index < sheet.rows.length; index += EXCEL_ROWS_PER_BLOCK) {
    const group = sheet.rows.slice(index, index + EXCEL_ROWS_PER_BLOCK)
    const start = numericRow(group[0]?.number)
    const end = numericRow(group[group.length - 1]?.number)
    const text = [
      `sheet "${sheet.name}" rows ${group[0]?.number ?? "?"}-${group[group.length - 1]?.number ?? "?"}`,
      `header row ${header.number}: ${formatCells(header.cells)}`,
      ...group.map((row) => `row ${row.number}: ${formatCells(row.cells)}`),
    ].join("\n")
    blocks.push({
      kind: "worksheet-rows",
      label: `Sheet "${sheet.name}" rows ${group[0]?.number ?? "?"}-${group[group.length - 1]?.number ?? "?"}`,
      sheetName: sheet.name,
      rowStart: start,
      rowEnd: end,
      cellRange: sheet.range,
      text,
    })
  }

  if (sheet.omittedRows && sheet.omittedRows > 0) {
    blocks.push({
      kind: "note",
      label: `Sheet "${sheet.name}" omitted rows`,
      sheetName: sheet.name,
      text: `[${sheet.omittedRows} row(s) omitted after first ${MAX_ROWS_PER_SHEET} non-empty rows]`,
    })
  }
  return blocks
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedDocumentBlock[]> {
  const pdfJsBlocks = await parsePdfWithPdfJs(bytes)
  if (pdfJsBlocks.length > 0) return pdfJsBlocks
  return parsePdfWithStreamFallback(bytes)
}

async function parsePdfWithPdfJs(bytes: Uint8Array) {
  let pdf: PdfDocumentProxy | undefined
  try {
    if (!looksLikePageBasedPdf(bytes)) return []
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as PdfJsModule
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    pdf = await loading.promise
    const blocks: ParsedDocumentBlock[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      const text = normalizeTextLines(pdfTextItems(content.items))
      if (!text) continue
      blocks.push({
        kind: "pdf-page",
        label: `Page ${pageNumber}`,
        pageStart: pageNumber,
        pageEnd: pageNumber,
        text: `page ${pageNumber}:\n${text}`,
      })
    }
    if (blocks.length > 0) return blocks
  } catch {
    // Fall back to the lightweight stream extractor for minimal PDFs and malformed files.
  } finally {
    try {
      await pdf?.destroy?.()
    } catch {
      // Best-effort cleanup only.
    }
  }
  return []
}

function looksLikePageBasedPdf(bytes: Uint8Array) {
  const preview = Buffer.from(bytes).subarray(0, 1024 * 1024).toString("latin1")
  return /\/Type\s*\/Page\b/.test(preview)
}

function pdfTextItems(items: PdfTextItem[]) {
  const pieces: string[] = []
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue
    pieces.push(item.str)
    pieces.push(item.hasEOL ? "\n" : " ")
  }
  return pieces.join("")
}

function parsePdfWithStreamFallback(bytes: Uint8Array) {
  const streamTexts = extractPdfStreams(Buffer.from(bytes))
    .map(extractPdfContentText)
    .filter(Boolean)
  const text = normalizeTextLines(streamTexts.join("\n"))
  if (!text) return [noteBlock("No extractable PDF text layer found. Image-only PDFs and scanned pages are not supported.")]
  return [{
    kind: "pdf-page" as const,
    label: "Page 1",
    pageStart: 1,
    pageEnd: 1,
    text: `page 1:\n${text}`,
  }]
}

function renderParsedDocument(kind: ParsedDocumentKind, blocks: ParsedDocumentBlock[]) {
  const lines = [`${documentFormatLabel(kind)}:`]
  const renderedBlocks: ParsedDocumentBlock[] = []
  for (const block of blocks) {
    const text = normalizeTextLines(block.text)
    if (!text) continue
    if (lines.length > 1 && lines[lines.length - 1] !== "") lines.push("")
    const start = lines.length + 1
    const blockLines = text.split("\n")
    lines.push(...blockLines)
    const end = start + blockLines.length - 1
    renderedBlocks.push({ ...block, text, lineStart: start, lineEnd: end })
  }
  const text = lines.join("\n").replace(/[ \t]+$/gm, "").trim()
  return { text, blocks: renderedBlocks }
}

function documentFormatLabel(kind: ParsedDocumentKind) {
  if (kind === "doc") return "DOC text"
  if (kind === "docx") return "DOCX text"
  if (kind === "pdf") return "PDF text"
  return `${kind.toUpperCase()} workbook`
}

function limitParsedDocument(text: string, blocks: ParsedDocumentBlock[], maxBytes: number) {
  const limited = limitText(text, maxBytes)
  if (!limited.truncated) return { ...limited, blocks }
  const lineCount = Math.max(1, limited.text.split(/\r?\n/).length)
  return {
    ...limited,
    blocks: blocks
      .filter((block) => (block.lineStart ?? 1) <= lineCount)
      .map((block) => ({
        ...block,
        lineEnd: Math.min(block.lineEnd ?? lineCount, lineCount),
        text: block.text.split(/\r?\n/).slice(0, Math.max(1, lineCount - (block.lineStart ?? 1) + 1)).join("\n"),
      })),
  }
}

function noteBlock(text: string): ParsedDocumentBlock {
  return { kind: "note", label: "Note", text }
}

function numericRow(value: string | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function extractDocxTextFromZip(bytes: Uint8Array) {
  const entries = readZipEntries(bytes)
  const documentXml = zipText(entries, "word/document.xml")
  if (!documentXml) return "DOCX document has no word/document.xml text body."
  const text = extractDocxDocumentText(documentXml)
  return text || "No extractable DOCX text found."
}

function extractDocxDocumentText(xml: string) {
  const pieces: string[] = []
  const token = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/g
  let match: RegExpExecArray | null
  while ((match = token.exec(xml))) {
    if (match[1] !== undefined) {
      pieces.push(decodeXml(match[1]))
    } else if (match[0].startsWith("<w:tab")) {
      pieces.push("\t")
    } else if (match[0].startsWith("<w:br")) {
      pieces.push("\n")
    } else if (!pieces[pieces.length - 1]?.endsWith("\n")) {
      pieces.push("\n")
    }
  }
  return normalizeTextLines(pieces.join(""))
}

function workbookRelationships(entries: Map<string, ZipEntry>) {
  const relsXml = zipText(entries, "xl/_rels/workbook.xml.rels") ?? ""
  const relationships = new Map<string, string>()
  for (const rel of matchAllXmlElements(relsXml, "Relationship")) {
    const id = xmlAttr(rel.attrs, "Id")
    const target = xmlAttr(rel.attrs, "Target")
    if (id && target) relationships.set(id, normalizeZipPath(`xl/${target}`))
  }
  return relationships
}

function workbookSheets(xml: string, relationships: Map<string, string>) {
  const sheets: Array<{ name: string; path: string }> = []
  for (const sheet of matchAllXmlElements(xml, "sheet")) {
    const name = xmlAttr(sheet.attrs, "name") || `Sheet ${sheets.length + 1}`
    const relId = xmlAttr(sheet.attrs, "r:id")
    const path = (relId && relationships.get(relId)) || `xl/worksheets/sheet${sheets.length + 1}.xml`
    sheets.push({ name: decodeXml(name), path })
  }
  return sheets
}

function workbookSharedStrings(entries: Map<string, ZipEntry>) {
  const sharedXml = zipText(entries, "xl/sharedStrings.xml")
  if (!sharedXml) return []
  return matchAllXmlElements(sharedXml, "si").map((item) => extractXmlText(item.body))
}

function worksheetRows(xml: string, sharedStrings: string[]) {
  const rows: WorksheetRow[] = []
  for (const row of matchAllXmlElements(xml, "row")) {
    const cells: FormattedCell[] = []
    for (const cell of matchAllXmlElements(row.body, "c")) {
      const value = worksheetCellValue(cell.attrs, cell.body, sharedStrings)
      if (value) cells.push(value)
      if (cells.length >= MAX_CELLS_PER_ROW) break
    }
    if (cells.length > 0) rows.push({ number: xmlAttr(row.attrs, "r") || String(rows.length + 1), cells })
  }
  return rows
}

function worksheetCellValue(attrs: string, body: string, sharedStrings: string[]): FormattedCell | undefined {
  const ref = xmlAttr(attrs, "r") || "?"
  const type = xmlAttr(attrs, "t")
  const formula = firstXmlElementText(body, "f")
  const rawValue = firstXmlElementText(body, "v")
  const inlineValue = firstXmlElementBody(body, "is")
  let value = ""
  if (type === "s" && rawValue !== undefined) value = sharedStrings[Number(rawValue)] ?? rawValue
  else if (type === "inlineStr" && inlineValue !== undefined) value = extractXmlText(inlineValue)
  else if (rawValue !== undefined) value = rawValue
  else if (formula !== undefined) value = ""
  value = normalizeWhitespace(decodeXml(value))
  const decodedFormula = formula === undefined ? undefined : normalizeWhitespace(decodeXml(formula))
  if (!value && !decodedFormula) return undefined
  return { ref, value, formula: decodedFormula }
}

function formatCells(cells: FormattedCell[]) {
  return cells.map((cell) => {
    const display = cell.formula
      ? `{formula:${cell.formula}${cell.value ? `, value:${cell.value}` : ""}}`
      : cell.value
    return `${cell.ref}=${display}`
  }).join(" | ")
}

function extractPdfStreams(buffer: Buffer) {
  const marker = Buffer.from("stream", "latin1")
  const endMarker = Buffer.from("endstream", "latin1")
  const streams: string[] = []
  let offset = 0
  while (offset < buffer.length) {
    const streamIndex = buffer.indexOf(marker, offset)
    if (streamIndex < 0) break
    const dictStart = buffer.lastIndexOf(Buffer.from("<<", "latin1"), streamIndex)
    const dict = dictStart >= 0 ? buffer.subarray(dictStart, streamIndex).toString("latin1") : ""
    let dataStart = streamIndex + marker.length
    if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) dataStart += 2
    else if (buffer[dataStart] === 0x0a || buffer[dataStart] === 0x0d) dataStart += 1
    const endIndex = buffer.indexOf(endMarker, dataStart)
    if (endIndex < 0) break
    let dataEnd = endIndex
    if (buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) dataEnd -= 2
    else if (buffer[dataEnd - 1] === 0x0a || buffer[dataEnd - 1] === 0x0d) dataEnd -= 1
    const data = buffer.subarray(dataStart, Math.max(dataStart, dataEnd))
    streams.push(pdfStreamText(dict, data))
    offset = endIndex + endMarker.length
  }
  if (streams.length === 0) streams.push(buffer.toString("latin1"))
  return streams
}

function pdfStreamText(dict: string, data: Buffer) {
  if (data.length > MAX_PDF_STREAM_BYTES) return ""
  if (!/\/FlateDecode\b/.test(dict)) return data.toString("latin1")
  try {
    return inflateSync(data).toString("latin1")
  } catch {
    return ""
  }
}

function extractPdfContentText(content: string) {
  const pieces: string[] = []
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (char === "[") {
      const array = readPdfArray(content, index)
      if (array && nextPdfOperator(content, array.end) === "TJ") {
        pieces.push(array.values.join(""))
        index = array.end
      }
      continue
    }
    if (char === "(") {
      const literal = readPdfLiteralString(content, index)
      if (literal && textShowingOperators().has(nextPdfOperator(content, literal.end))) {
        pieces.push(literal.value)
        index = literal.end
      }
      continue
    }
    if (char === "<" && content[index + 1] !== "<") {
      const hex = readPdfHexString(content, index)
      if (hex && textShowingOperators().has(nextPdfOperator(content, hex.end))) {
        pieces.push(hex.value)
        index = hex.end
      }
    }
  }
  return pieces.join("\n")
}

function readPdfArray(content: string, start: number) {
  const values: string[] = []
  let index = start + 1
  while (index < content.length) {
    const char = content[index]
    if (char === "]") return { values, end: index + 1 }
    if (char === "(") {
      const literal = readPdfLiteralString(content, index)
      if (!literal) return undefined
      values.push(literal.value)
      index = literal.end
      continue
    }
    if (char === "<" && content[index + 1] !== "<") {
      const hex = readPdfHexString(content, index)
      if (!hex) return undefined
      values.push(hex.value)
      index = hex.end
      continue
    }
    index++
  }
  return undefined
}

function readPdfLiteralString(content: string, start: number) {
  let index = start + 1
  let depth = 1
  let value = ""
  while (index < content.length) {
    const char = content[index]
    if (char === "\\") {
      const escaped = readPdfEscape(content, index)
      value += escaped.value
      index = escaped.end
      continue
    }
    if (char === "(") depth++
    if (char === ")") {
      depth--
      if (depth === 0) return { value, end: index + 1 }
    }
    value += char
    index++
  }
  return undefined
}

function readPdfEscape(content: string, start: number) {
  const next = content[start + 1]
  if (next === "n") return { value: "\n", end: start + 2 }
  if (next === "r") return { value: "\r", end: start + 2 }
  if (next === "t") return { value: "\t", end: start + 2 }
  if (next === "b") return { value: "\b", end: start + 2 }
  if (next === "f") return { value: "\f", end: start + 2 }
  if (next === "\r" && content[start + 2] === "\n") return { value: "", end: start + 3 }
  if (next === "\n" || next === "\r") return { value: "", end: start + 2 }
  const octal = content.slice(start + 1).match(/^[0-7]{1,3}/)?.[0]
  if (octal) return { value: String.fromCharCode(parseInt(octal, 8)), end: start + 1 + octal.length }
  return { value: next ?? "", end: start + 2 }
}

function readPdfHexString(content: string, start: number) {
  const end = content.indexOf(">", start + 1)
  if (end < 0) return undefined
  let hex = content.slice(start + 1, end).replace(/\s+/g, "")
  if (hex.length % 2 === 1) hex += "0"
  const bytes: number[] = []
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16)
    if (Number.isFinite(byte)) bytes.push(byte)
  }
  return { value: Buffer.from(bytes).toString("latin1"), end: end + 1 }
}

function nextPdfOperator(content: string, start: number) {
  const match = content.slice(start).match(/^\s*(?:[-+]?\d+(?:\.\d+)?\s+)*([A-Za-z"']+)/)
  return match?.[1] ?? ""
}

function textShowingOperators() {
  return new Set(["Tj", "TJ", "'", "\""])
}

function readZipEntries(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes)
  const eocd = findZipEocd(buffer)
  if (eocd < 0) throw new Error("Unsupported document archive: ZIP end-of-central-directory not found.")
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, ZipEntry>()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) break
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const path = decodeZipName(buffer.subarray(offset + 46, offset + 46 + nameLength), flags)
    const data = readZipEntryData(buffer, localOffset, compressedSize, method)
    entries.set(normalizeZipPath(path), { path: normalizeZipPath(path), data })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findZipEocd(buffer: Buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let index = buffer.length - 22; index >= min; index--) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) return index
  }
  return -1
}

function decodeZipName(bytes: Buffer, _flags: number) {
  return bytes.toString("utf8")
}

function readZipEntryData(buffer: Buffer, localOffset: number, compressedSize: number, method: number) {
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error("Unsupported document archive: ZIP local file header not found.")
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
  if (method === ZIP_STORED) return Buffer.from(compressed)
  if (method === ZIP_DEFLATED) return inflateRawSync(compressed)
  throw new Error(`Unsupported document archive: ZIP compression method ${method}.`)
}

function zipText(entries: Map<string, ZipEntry>, path: string) {
  const entry = entries.get(normalizeZipPath(path))
  return entry?.data.toString("utf8")
}

function normalizeZipPath(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

function matchAllXmlElements(xml: string, tag: string) {
  const items: Array<{ attrs: string; body: string }> = []
  const paired = new RegExp(`<[^:>]*:?${tag}\\b([^>]*)>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, "g")
  let match: RegExpExecArray | null
  while ((match = paired.exec(xml))) items.push({ attrs: match[1] ?? "", body: match[2] ?? "" })
  const selfClosing = new RegExp(`<[^:>]*:?${tag}\\b([^>]*)\\/>`, "g")
  while ((match = selfClosing.exec(xml))) items.push({ attrs: match[1] ?? "", body: "" })
  return items
}

function firstXmlElementText(xml: string, tag: string) {
  const body = firstXmlElementBody(xml, tag)
  return body === undefined ? undefined : decodeXml(body)
}

function firstXmlElementBody(xml: string, tag: string) {
  const match = new RegExp(`<[^:>]*:?${tag}\\b[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`).exec(xml)
  return match?.[1]
}

function extractXmlText(xml: string) {
  const pieces = matchAllXmlElements(xml, "t").map((item) => decodeXml(item.body))
  return normalizeWhitespace(pieces.join(""))
}

function xmlAttr(attrs: string, name: string) {
  const escaped = name.replace(":", ":?")
  const match = new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(attrs)
  return match ? decodeXml(match[1]) : undefined
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function normalizeTextLines(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function emptyDocumentMessage(kind: ParsedDocumentKind) {
  if (kind === "pdf") return "No extractable PDF text layer found. Image-only PDFs and scanned pages are not supported."
  return `${kind.toUpperCase()} document has no extractable text.`
}

function limitText(text: string, maxBytes: number) {
  if (byteLength(text) <= maxBytes) return { text, truncated: false }
  let result = ""
  let used = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return { text: result, truncated: true }
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8")
}
