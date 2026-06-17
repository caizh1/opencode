import { inflateRawSync, inflateSync } from "node:zlib"

export type ParsedDocumentContent = {
  kind: "docx" | "xlsx" | "xlsm" | "pdf"
  language: string
  text: string
  lineCount: number
  truncated: boolean
}

type ZipEntry = {
  path: string
  data: Buffer
}

type CellValue = {
  ref: string
  value: string
  formula?: string
}

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_STORED = 0
const ZIP_DEFLATED = 8
const MAX_WORKSHEETS = 8
const MAX_ROWS_PER_SHEET = 80
const MAX_CELLS_PER_ROW = 24
const MAX_PDF_STREAM_BYTES = 12 * 1024 * 1024

export function isSupportedDocumentPath(path: string) {
  return supportedDocumentKind(path) !== undefined
}

export function parseSupportedDocument(input: {
  path: string
  bytes: Uint8Array
  maxBytes: number
}): ParsedDocumentContent | undefined {
  const kind = supportedDocumentKind(input.path)
  if (!kind) return undefined
  const rawText = kind === "docx"
    ? parseDocx(input.bytes)
    : kind === "xlsx" || kind === "xlsm"
      ? parseWorkbook(input.bytes, kind)
      : parsePdf(input.bytes)
  const limited = limitText(rawText.trim() || emptyDocumentMessage(kind), input.maxBytes)
  return {
    kind,
    language: kind,
    text: limited.text,
    lineCount: Math.max(1, limited.text.split(/\r?\n/).length),
    truncated: limited.truncated,
  }
}

function supportedDocumentKind(path: string): ParsedDocumentContent["kind"] | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".xlsx")) return "xlsx"
  if (lower.endsWith(".xlsm")) return "xlsm"
  if (lower.endsWith(".pdf")) return "pdf"
  return undefined
}

function parseDocx(bytes: Uint8Array) {
  const entries = readZipEntries(bytes)
  const documentXml = zipText(entries, "word/document.xml")
  if (!documentXml) return "DOCX document has no word/document.xml text body."
  const text = extractDocxDocumentText(documentXml)
  return [
    "DOCX text:",
    text || "No extractable DOCX text found.",
  ].join("\n")
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

function parseWorkbook(bytes: Uint8Array, kind: "xlsx" | "xlsm") {
  const entries = readZipEntries(bytes)
  const workbookXml = zipText(entries, "xl/workbook.xml")
  if (!workbookXml) return `${kind.toUpperCase()} workbook has no xl/workbook.xml metadata.`
  const relationships = workbookRelationships(entries)
  const sharedStrings = workbookSharedStrings(entries)
  const sheets = workbookSheets(workbookXml, relationships)
  const rows: string[] = [`${kind.toUpperCase()} workbook:`]
  if (sheets.length === 0) rows.push("No worksheets found.")
  for (const sheet of sheets.slice(0, MAX_WORKSHEETS)) {
    const xml = zipText(entries, sheet.path)
    if (!xml) {
      rows.push(`sheet "${sheet.name}": missing worksheet data (${sheet.path})`)
      continue
    }
    rows.push(...formatWorksheet(sheet.name, xml, sharedStrings))
  }
  if (sheets.length > MAX_WORKSHEETS) rows.push(`[${sheets.length - MAX_WORKSHEETS} worksheet(s) omitted]`)
  if (kind === "xlsm") rows.push("Macro streams are not executed or inspected; only workbook cell data is extracted.")
  return rows.join("\n")
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

function formatWorksheet(name: string, xml: string, sharedStrings: string[]) {
  const rows: string[] = []
  const dimension = xml.match(/<dimension\b[^>]*\bref="([^"]+)"/)?.[1]
  rows.push(`sheet "${name}"${dimension ? ` range=${decodeXml(dimension)}` : ""}`)
  const parsedRows = worksheetRows(xml, sharedStrings)
  if (parsedRows.length === 0) {
    rows.push("  [empty worksheet]")
    return rows
  }
  const header = parsedRows.find((row) => row.cells.length > 0)
  if (header) rows.push(`  header row ${header.number}: ${formatCells(header.cells)}`)
  let emitted = 0
  for (const row of parsedRows) {
    if (emitted >= MAX_ROWS_PER_SHEET) break
    rows.push(`  row ${row.number}: ${formatCells(row.cells)}`)
    emitted++
  }
  if (parsedRows.length > MAX_ROWS_PER_SHEET) rows.push(`  [${parsedRows.length - MAX_ROWS_PER_SHEET} row(s) omitted]`)
  return rows
}

function worksheetRows(xml: string, sharedStrings: string[]) {
  const rows: Array<{ number: string; cells: CellValue[] }> = []
  for (const row of matchAllXmlElements(xml, "row")) {
    const cells: CellValue[] = []
    for (const cell of matchAllXmlElements(row.body, "c")) {
      const value = worksheetCellValue(cell.attrs, cell.body, sharedStrings)
      if (value) cells.push(value)
      if (cells.length >= MAX_CELLS_PER_ROW) break
    }
    if (cells.length > 0) rows.push({ number: xmlAttr(row.attrs, "r") || String(rows.length + 1), cells })
  }
  return rows
}

function worksheetCellValue(attrs: string, body: string, sharedStrings: string[]): CellValue | undefined {
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

function formatCells(cells: CellValue[]) {
  return cells.map((cell) => {
    const display = cell.formula
      ? `{formula:${cell.formula}${cell.value ? `, value:${cell.value}` : ""}}`
      : cell.value
    return `${cell.ref}=${display}`
  }).join(" | ")
}

function parsePdf(bytes: Uint8Array) {
  const streamTexts = extractPdfStreams(Buffer.from(bytes))
    .map(extractPdfContentText)
    .filter(Boolean)
  const text = normalizeTextLines(streamTexts.join("\n"))
  return [
    "PDF text:",
    text || "No extractable PDF text layer found. Image-only PDFs and scanned pages are not supported.",
  ].join("\n")
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

function emptyDocumentMessage(kind: ParsedDocumentContent["kind"]) {
  if (kind === "pdf") return "PDF text:\nNo extractable PDF text layer found. Image-only PDFs and scanned pages are not supported."
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
