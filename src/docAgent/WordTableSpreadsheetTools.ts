import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import ExcelJS = require("exceljs")
import type { TableSpec, WordDocumentInspection } from "./types"
import { WordDocumentInspector } from "./WordDocumentInspector"

export type XlsxTableExtractionInput = {
  path: string
  sheetName?: string
  sheetIndex?: number
  range?: string
  hasHeaderRow?: boolean
  maxRows?: number
  maxColumns?: number
}

export type XlsxTableExtractionResult = {
  table: TableSpec
  sheetName: string
  sheetIndex: number
  sourceRange: string
  rowCount: number
  columnCount: number
  warnings: string[]
}

export type WordTableCsvExportInput = {
  documentPath: string
  bytes: Uint8Array
  workspaceRoot: string
  tableIndex?: number
  outputFilenameBase?: string
  inspection?: WordDocumentInspection
}

export type WordTableCsvExportResult = {
  path: string
  absolutePath: string
  documentPath: string
  tableIndex: number
  rowCount: number
  columnCount: number
  preview: string[][]
  warnings: string[]
}

const DEFAULT_MAX_ROWS = 200
const DEFAULT_MAX_COLUMNS = 24
const HARD_MAX_ROWS = 1_000
const HARD_MAX_COLUMNS = 64

export async function extractXlsxTable(input: XlsxTableExtractionInput): Promise<XlsxTableExtractionResult> {
  const warnings: string[] = []
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(input.path)
  const worksheet = selectWorksheet(workbook, input)
  const rawBounds = input.range ? parseA1Range(input.range) : worksheetBounds(worksheet)
  const maxRows = boundedLimit(input.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS)
  const maxColumns = boundedLimit(input.maxColumns, DEFAULT_MAX_COLUMNS, HARD_MAX_COLUMNS)
  const bounds = {
    startRow: rawBounds.startRow,
    startCol: rawBounds.startCol,
    endRow: Math.min(rawBounds.endRow, rawBounds.startRow + maxRows - 1),
    endCol: Math.min(rawBounds.endCol, rawBounds.startCol + maxColumns - 1),
  }
  if (bounds.endRow < rawBounds.endRow) warnings.push(`XLSX range truncated from ${rawBounds.endRow - rawBounds.startRow + 1} to ${bounds.endRow - bounds.startRow + 1} row(s).`)
  if (bounds.endCol < rawBounds.endCol) warnings.push(`XLSX range truncated from ${rawBounds.endCol - rawBounds.startCol + 1} to ${bounds.endCol - bounds.startCol + 1} column(s).`)

  const matrix = trimEmptyEdges(readWorksheetMatrix(worksheet, bounds, warnings))
  if (matrix.length === 0 || matrix.every((row) => row.every((cell) => !cell))) {
    throw new Error("Selected XLSX range does not contain table data.")
  }
  const hasHeaderRow = input.hasHeaderRow !== false
  const columnCount = Math.max(...matrix.map((row) => row.length))
  const normalizedRows = matrix.map((row) => padRow(row, columnCount))
  const headers = hasHeaderRow
    ? uniqueHeaders(normalizedRows[0] ?? [], columnCount)
    : generatedHeaders(columnCount)
  const rows = hasHeaderRow ? normalizedRows.slice(1) : normalizedRows
  const table: TableSpec = {
    id: safeId(`${worksheet.name}-table`),
    headers,
    rows,
    columnWidthRatios: columnWidthRatios(headers, rows),
    repeatHeader: true,
  }
  return {
    table,
    sheetName: worksheet.name,
    sheetIndex: worksheet.id,
    sourceRange: `${cellAddress(bounds.startRow, bounds.startCol)}:${cellAddress(bounds.startRow + normalizedRows.length - 1, bounds.startCol + columnCount - 1)}`,
    rowCount: rows.length,
    columnCount,
    warnings,
  }
}

export async function exportWordTableToCsv(input: WordTableCsvExportInput): Promise<WordTableCsvExportResult> {
  const inspection = input.inspection ?? await new WordDocumentInspector().inspect({
    path: input.documentPath,
    bytes: input.bytes,
  })
  const tableIndex = normalizeTableIndex(input.tableIndex)
  const table = inspection.tables.find((item) => item.tableIndex === tableIndex)
  if (!table) throw new Error(`Word table ${tableIndex} was not found in ${input.documentPath}.`)
  const rows = table.rows
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const csv = rows.map(csvRow).join("\n") + "\n"
  const artifactDir = path.join(input.workspaceRoot, ".chipmate", "docs", "tables")
  await mkdir(artifactDir, { recursive: true })
  const base = safeFilenameBase(input.outputFilenameBase || `${path.basename(input.documentPath, path.extname(input.documentPath))}-table-${tableIndex}`)
  const absolutePath = path.join(artifactDir, `${base}.csv`)
  await writeFile(absolutePath, csv, "utf8")
  return {
    path: normalizePath(path.relative(input.workspaceRoot, absolutePath)),
    absolutePath,
    documentPath: input.documentPath,
    tableIndex,
    rowCount: rows.length,
    columnCount,
    preview: rows.slice(0, 12).map((row) => row.slice(0, 12)),
    warnings: rows.length === 0 ? [`Word table ${tableIndex} has no rows.`] : [],
  }
}

function selectWorksheet(workbook: ExcelJS.Workbook, input: XlsxTableExtractionInput) {
  if (input.sheetName) {
    const worksheet = workbook.getWorksheet(input.sheetName)
    if (!worksheet) throw new Error(`Worksheet not found: ${input.sheetName}`)
    return worksheet
  }
  const worksheet = workbook.getWorksheet(input.sheetIndex ?? 1)
  if (!worksheet) throw new Error(`Worksheet index not found: ${input.sheetIndex ?? 1}`)
  return worksheet
}

function worksheetBounds(worksheet: ExcelJS.Worksheet) {
  let startRow = Number.POSITIVE_INFINITY
  let startCol = Number.POSITIVE_INFINITY
  let endRow = 0
  let endCol = 0
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (!cellText(cell.value, [], cell.address)) return
      startRow = Math.min(startRow, rowNumber)
      startCol = Math.min(startCol, colNumber)
      endRow = Math.max(endRow, rowNumber)
      endCol = Math.max(endCol, colNumber)
    })
  })
  if (!Number.isFinite(startRow) || !Number.isFinite(startCol)) {
    return { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }
  }
  return { startRow, startCol, endRow, endCol }
}

function readWorksheetMatrix(worksheet: ExcelJS.Worksheet, bounds: ReturnType<typeof parseA1Range>, warnings: string[]) {
  const rows: string[][] = []
  for (let rowNumber = bounds.startRow; rowNumber <= bounds.endRow; rowNumber += 1) {
    const row: string[] = []
    for (let colNumber = bounds.startCol; colNumber <= bounds.endCol; colNumber += 1) {
      const cell = worksheet.getCell(rowNumber, colNumber)
      row.push(cellText(cell.value, warnings, cell.address))
    }
    rows.push(row)
  }
  return rows
}

function trimEmptyEdges(rows: string[][]) {
  let top = 0
  let bottom = rows.length - 1
  while (top <= bottom && rows[top]!.every((cell) => !cell.trim())) top += 1
  while (bottom >= top && rows[bottom]!.every((cell) => !cell.trim())) bottom -= 1
  const trimmedRows = rows.slice(top, bottom + 1)
  if (!trimmedRows.length) return []
  let right = trimmedRows.reduce((max, row) => Math.max(max, lastNonEmptyIndex(row)), -1)
  if (right < 0) return []
  return trimmedRows.map((row) => row.slice(0, right + 1))
}

function lastNonEmptyIndex(row: string[]) {
  for (let index = row.length - 1; index >= 0; index -= 1) {
    if (row[index]!.trim()) return index
  }
  return -1
}

function cellText(value: ExcelJS.CellValue, warnings: string[], address: string): string {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanCellText(String(value))
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) {
      const formula = "formula" in value ? value.formula : value.sharedFormula
      if ("result" in value && value.result !== undefined && value.result !== null) return cellText(value.result as ExcelJS.CellValue, warnings, address)
      warnings.push(`Formula cell ${address} has no cached result; exported formula text instead.`)
      return cleanCellText(`=${formula ?? ""}`)
    }
    if ("richText" in value && Array.isArray(value.richText)) return cleanCellText(value.richText.map((part) => part.text).join(""))
    if ("text" in value && typeof value.text === "string") return cleanCellText(value.text)
    if ("error" in value && typeof value.error === "string") return cleanCellText(value.error)
  }
  return cleanCellText(String(value))
}

function cleanCellText(input: string) {
  return input.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim()
}

function parseA1Range(input: string) {
  const trimmed = input.trim()
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(trimmed)
  if (!match) throw new Error(`Invalid XLSX A1 range: ${input}`)
  const startCol = columnNameToNumber(match[1]!)
  const startRow = Number(match[2])
  const endCol = match[3] ? columnNameToNumber(match[3]) : startCol
  const endRow = match[4] ? Number(match[4]) : startRow
  if (endRow < startRow || endCol < startCol) throw new Error(`Invalid XLSX A1 range order: ${input}`)
  return { startRow, startCol, endRow, endCol }
}

function columnNameToNumber(input: string) {
  let value = 0
  for (const char of input.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

function columnNumberToName(input: number) {
  let value = input
  let name = ""
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name || "A"
}

function cellAddress(row: number, col: number) {
  return `${columnNumberToName(col)}${row}`
}

function boundedLimit(input: number | undefined, fallback: number, hardMax: number) {
  if (!Number.isFinite(input)) return fallback
  return Math.max(1, Math.min(Math.floor(input!), hardMax))
}

function padRow(row: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "")
}

function uniqueHeaders(row: string[], columnCount: number) {
  const seen = new Map<string, number>()
  return Array.from({ length: columnCount }, (_, index) => {
    const fallback = `Column ${columnNumberToName(index + 1)}`
    const base = cleanCellText(row[index] || fallback) || fallback
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} ${count + 1}`
  })
}

function generatedHeaders(columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => `Column ${columnNumberToName(index + 1)}`)
}

function columnWidthRatios(headers: string[], rows: string[][]) {
  return headers.map((header, columnIndex) => {
    const maxLength = [header, ...rows.map((row) => row[columnIndex] ?? "")].reduce((max, value) => Math.max(max, value.length), 0)
    return Math.max(1, Math.min(4, Math.ceil(maxLength / 12)))
  })
}

function normalizeTableIndex(input: number | undefined) {
  if (input === undefined || input === null) return 1
  const value = Math.floor(Number(input))
  if (!Number.isFinite(value) || value < 1) throw new Error("tableIndex must be a positive integer.")
  return value
}

function csvRow(row: string[]) {
  return row.map(csvCell).join(",")
}

function csvCell(input: string) {
  const value = input ?? ""
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value
}

function safeId(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "xlsx-table"
}

function safeFilenameBase(input: string) {
  return input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "word-table"
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/")
}
