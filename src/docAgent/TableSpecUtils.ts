import type { TableCellSpec, TableCellValue, TableSpec } from "./types"

export type TableGeometryIssue = {
  code: "invalid-table-cell" | "invalid-table-span"
  message: string
}

export function tableCellText(cell: TableCellValue | undefined) {
  return typeof cell === "string" ? cell : cell?.text ?? ""
}

export function plainTableRows(table: TableSpec) {
  return table.rows.map((row) => row.map(tableCellText))
}

export function tableCellColSpan(cell: TableCellValue | undefined) {
  if (!cell || typeof cell === "string") return 1
  return boundedSpan(cell.colSpan)
}

export function tableCellRowSpan(cell: TableCellValue | undefined) {
  if (!cell || typeof cell === "string") return 1
  return boundedSpan(cell.rowSpan)
}

export function tableCellAlignment(cell: TableCellValue | undefined) {
  if (!cell || typeof cell === "string") return undefined
  return cell.alignment === "center" || cell.alignment === "right" || cell.alignment === "left" ? cell.alignment : undefined
}

export function normalizeTableCellValue(input: unknown): TableCellValue | undefined {
  if (typeof input === "string") return input.trim()
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const text = typeof raw.text === "string" ? raw.text.trim() : ""
  if (!text) return undefined
  const cell: TableCellSpec = { text }
  const colSpan = boundedSpan(raw.colSpan)
  const rowSpan = boundedSpan(raw.rowSpan)
  if (colSpan > 1) cell.colSpan = colSpan
  if (rowSpan > 1) cell.rowSpan = rowSpan
  if (raw.alignment === "left" || raw.alignment === "center" || raw.alignment === "right") cell.alignment = raw.alignment
  return cell
}

export function validateTableGeometry(table: TableSpec, prefix: string): TableGeometryIssue[] {
  const issues: TableGeometryIssue[] = []
  const columnCount = table.headers?.length ?? 0
  if (!columnCount) return issues
  const activeRowSpans = new Map<number, { remaining: number; colSpan: number }>()
  for (const [rowIndex, row] of table.rows.entries()) {
    let rowCellIndex = 0
    for (let columnIndex = 0; columnIndex < columnCount;) {
      const active = activeRowSpans.get(columnIndex)
      if (active) {
        active.remaining -= 1
        if (active.remaining <= 0) activeRowSpans.delete(columnIndex)
        columnIndex += active.colSpan
        continue
      }
      const cell = row[rowCellIndex]
      if (!cell) {
        columnIndex += 1
        continue
      }
      if (!tableCellText(cell).trim()) {
        issues.push({
          code: "invalid-table-cell",
          message: `${prefix}.rows.${rowIndex}.${rowCellIndex}.text is required.`,
        })
      }
      const colSpan = tableCellColSpan(cell)
      const availableColumns = columnCount - columnIndex
      if (colSpan > availableColumns) {
        issues.push({
          code: "invalid-table-span",
          message: `${prefix}.rows.${rowIndex}.${rowCellIndex}.colSpan spans ${colSpan} column(s) from column ${columnIndex + 1}, exceeding header count ${columnCount}.`,
        })
      }
      const effectiveColSpan = Math.min(colSpan, availableColumns)
      const rowSpan = tableCellRowSpan(cell)
      const remainingRows = table.rows.length - rowIndex
      if (rowSpan > remainingRows) {
        issues.push({
          code: "invalid-table-span",
          message: `${prefix}.rows.${rowIndex}.${rowCellIndex}.rowSpan spans ${rowSpan} row(s), exceeding remaining row count ${remainingRows}.`,
        })
      }
      if (rowSpan > 1) activeRowSpans.set(columnIndex, { remaining: rowSpan - 1, colSpan: effectiveColSpan })
      rowCellIndex += 1
      columnIndex += effectiveColSpan
    }
    if (rowCellIndex < row.length) {
      issues.push({
        code: "invalid-table-span",
        message: `${prefix}.rows.${rowIndex} contains ${row.length - rowCellIndex} extra cell(s) beyond the ${columnCount}-column table after spans.`,
      })
    }
  }
  return issues
}

function boundedSpan(input: unknown) {
  const value = Number(input)
  return Number.isInteger(value) && value > 1 ? Math.min(value, 24) : 1
}
