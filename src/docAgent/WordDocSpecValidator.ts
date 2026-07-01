import type { QualityIssue, TableSpec, WordDocSpec } from "./types"
import { WORD_PRESET_ALIAS_BASE } from "./themes/WordDesignPresets"
import { validateTableGeometry } from "./TableSpecUtils"

const WORD_HEADER_PATTERNS = new Set(["none", "memo_masthead", "proposal_centerpiece", "editorial_cover", "customer_pack", "workshop_agenda", "customer_story"])
const WORD_NAVIGATION_MODES = new Set(["field-toc", "static-toc", "none"])

export class WordDocSpecValidator {
  validate(spec: WordDocSpec): QualityIssue[] {
    const issues: QualityIssue[] = []
    if (!spec.metadata?.title?.trim()) issues.push(error("missing-title", "WordDocSpec metadata.title is required."))
    if (!spec.metadata?.documentType?.trim()) issues.push(error("missing-document-type", "WordDocSpec metadata.documentType is required."))
    if (!Array.isArray(spec.sections) || spec.sections.length === 0) issues.push(error("missing-sections", "WordDocSpec must include sections."))
    if (!Array.isArray(spec.sources)) issues.push(error("invalid-sources", "WordDocSpec sources must be an array, even when empty."))
    if (isSourceBackedDocument(spec) && !spec.sources?.length) issues.push(warning("missing-sources", "Source-backed WordDocSpec should include at least one source."))
    if (isSourceBackedDocument(spec) && !spec.sections?.some((section) => section.title === "References")) issues.push(warning("missing-references-section", "Source-backed document should include a References section."))
    if (isCodingGuideline(spec) && !spec.sections?.some((section) => section.ruleCards?.length)) issues.push(warning("missing-rule-cards", "Coding guideline document has no rule cards."))
    issues.push(...validateLayout(spec))
    for (const [sectionIndex, section] of (spec.sections ?? []).entries()) {
      issues.push(...validateSection(section, `sections[${sectionIndex}]`))
      for (const [tableIndex, table] of (section.tables ?? []).entries()) {
        issues.push(...validateTable(table, `sections[${sectionIndex}].tables[${tableIndex}]`))
      }
    }
    for (const [sectionIndex, section] of (spec.appendices ?? []).entries()) {
      issues.push(...validateSection(section, `appendices[${sectionIndex}]`))
      for (const [tableIndex, table] of (section.tables ?? []).entries()) {
        issues.push(...validateTable(table, `appendices[${sectionIndex}].tables[${tableIndex}]`))
      }
    }
    if (spec.executiveSummary) {
      issues.push(...validateStringArray(spec.executiveSummary.paragraphs, "executiveSummary.paragraphs"))
      issues.push(...validateOptionalStringArray(spec.executiveSummary.highlights, "executiveSummary.highlights"))
    }
    return issues
  }
}

function validateLayout(spec: WordDocSpec): QualityIssue[] {
  const issues: QualityIssue[] = []
  const alias = spec.layout?.presetAlias
  if (alias && !(alias in WORD_PRESET_ALIAS_BASE)) {
    issues.push(error("invalid-word-preset-alias", `Unknown Word preset alias: ${alias}`))
  }
  const headerPattern = spec.layout?.headerPattern
  if (headerPattern && !WORD_HEADER_PATTERNS.has(headerPattern)) {
    issues.push(error("invalid-word-header-pattern", `Unknown Word header pattern: ${headerPattern}`))
  }
  if (spec.layout?.preset === "google_docs_default" && headerPattern && headerPattern !== "none") {
    issues.push(warning("google-docs-header-pattern-ignored", "google_docs_default uses a simple first page and ignores complex header patterns."))
  }
  const navigationMode = spec.layout?.navigation?.mode
  if (navigationMode && !WORD_NAVIGATION_MODES.has(navigationMode)) {
    issues.push(error("invalid-word-navigation-mode", `layout.navigation.mode must be one of field-toc, static-toc, or none. Received ${navigationMode}.`))
  }
  for (const [index, override] of (spec.layout?.overrides ?? []).entries()) {
    if (!override.role?.trim()) issues.push(error("invalid-layout-override", `layout.overrides.${index}.role is required.`))
    if (!override.reason?.trim()) issues.push(error("invalid-layout-override", `layout.overrides.${index}.reason is required.`))
    if (!override.tokenChanges || typeof override.tokenChanges !== "object") issues.push(error("invalid-layout-override", `layout.overrides.${index}.tokenChanges must be an object.`))
  }
  return issues
}

function validateSection(section: unknown, prefix: string): QualityIssue[] {
  const issues: QualityIssue[] = []
  if (!section || typeof section !== "object" || Array.isArray(section)) return [error("invalid-word-section", `${prefix} must be an object.`)]
  const record = section as {
    id?: unknown
    level?: unknown
    title?: unknown
    paragraphs?: unknown
    bullets?: unknown
    numberedItems?: unknown
    figures?: unknown
    tables?: unknown
  }
  if (typeof record.id !== "string" || !record.id.trim()) issues.push(error("invalid-word-section-id", `${prefix}.id must be a non-empty string.`))
  if (record.level !== 1 && record.level !== 2 && record.level !== 3) issues.push(error("invalid-word-section-level", `${prefix}.level must be 1, 2, or 3.`))
  if (typeof record.title !== "string" || !record.title.trim()) issues.push(error("invalid-word-section-title", `${prefix}.title must be a non-empty string.`))
  issues.push(...validateOptionalStringArray(record.paragraphs, `${prefix}.paragraphs`))
  issues.push(...validateOptionalStringArray(record.bullets, `${prefix}.bullets`))
  issues.push(...validateOptionalStringArray(record.numberedItems, `${prefix}.numberedItems`))
  issues.push(...validateOptionalFigures(record.figures, `${prefix}.figures`))
  issues.push(...validateOptionalTables(record.tables, `${prefix}.tables`))
  return issues
}

function validateOptionalStringArray(value: unknown, prefix: string): QualityIssue[] {
  if (value === undefined) return []
  return validateStringArray(value, prefix)
}

function validateStringArray(value: unknown, prefix: string): QualityIssue[] {
  if (!Array.isArray(value)) return [error("invalid-word-string-array", `${prefix}: expected array of strings, got ${describeValueShape(value)}.`)]
  const issues: QualityIssue[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") issues.push(error("invalid-word-string-array-item", `${prefix}[${index}]: expected string, got ${describeValueShape(item)}.`))
  }
  return issues
}

function validateOptionalFigures(value: unknown, prefix: string): QualityIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [error("invalid-word-figures", `${prefix}: expected array of FigureSpec, got ${describeValueShape(value)}.`)]
  return value.flatMap((figure, index) => validateFigure(figure, `${prefix}[${index}]`))
}

function validateFigure(figure: unknown, prefix: string): QualityIssue[] {
  const issues: QualityIssue[] = []
  if (!figure || typeof figure !== "object" || Array.isArray(figure)) return [error("invalid-word-figure", `${prefix}: expected object, got ${describeValueShape(figure)}.`)]
  const record = figure as { title?: unknown; caption?: unknown; altText?: unknown; image?: unknown }
  if (typeof record.title !== "string" || !record.title.trim()) issues.push(error("invalid-word-figure-title", `${prefix}.title: expected non-empty string, got ${describeValueShape(record.title)}.`))
  if (record.caption !== undefined && typeof record.caption !== "string") issues.push(error("invalid-word-figure-caption", `${prefix}.caption: expected string, got ${describeValueShape(record.caption)}.`))
  if (record.altText !== undefined && typeof record.altText !== "string") issues.push(error("invalid-word-figure-alt-text", `${prefix}.altText: expected string, got ${describeValueShape(record.altText)}.`))
  issues.push(...validateFigureImage(record.image, `${prefix}.image`))
  return issues
}

function validateFigureImage(image: unknown, prefix: string): QualityIssue[] {
  const issues: QualityIssue[] = []
  if (!image || typeof image !== "object" || Array.isArray(image)) return [error("invalid-word-figure-image", `${prefix}: expected object, got ${describeValueShape(image)}.`)]
  const record = image as { contentType?: unknown; bytes?: unknown; base64?: unknown; path?: unknown; artifactPath?: unknown; width?: unknown; height?: unknown }
  if (record.contentType !== "image/png") issues.push(error("invalid-word-figure-image-content-type", `${prefix}.contentType: expected image/png, got ${describeValueShape(record.contentType)}.`))
  if (record.base64 !== undefined && typeof record.base64 !== "string") issues.push(error("invalid-word-figure-image-base64", `${prefix}.base64: expected string, got ${describeValueShape(record.base64)}.`))
  if (record.path !== undefined && typeof record.path !== "string") issues.push(error("invalid-word-figure-image-path", `${prefix}.path: expected string, got ${describeValueShape(record.path)}.`))
  if (record.artifactPath !== undefined && typeof record.artifactPath !== "string") issues.push(error("invalid-word-figure-image-artifact-path", `${prefix}.artifactPath: expected string, got ${describeValueShape(record.artifactPath)}.`))
  if (record.bytes !== undefined && !(record.bytes instanceof Uint8Array)) issues.push(error("invalid-word-figure-image-bytes", `${prefix}.bytes: expected Uint8Array when provided, got ${describeValueShape(record.bytes)}.`))
  if (!hasUsableImagePayload(record)) issues.push(error("invalid-word-figure-image-payload", `${prefix}: expected one of bytes, base64, path, or artifactPath for PNG figure image.`))
  if (!isPositiveFiniteNumber(record.width)) issues.push(error("invalid-word-figure-image-width", `${prefix}.width: expected positive number, got ${describeValueShape(record.width)}.`))
  if (!isPositiveFiniteNumber(record.height)) issues.push(error("invalid-word-figure-image-height", `${prefix}.height: expected positive number, got ${describeValueShape(record.height)}.`))
  return issues
}

function hasUsableImagePayload(record: { bytes?: unknown; base64?: unknown; path?: unknown; artifactPath?: unknown }) {
  return (record.bytes instanceof Uint8Array && record.bytes.length > 0)
    || (typeof record.base64 === "string" && record.base64.trim().length > 0)
    || (typeof record.path === "string" && record.path.trim().length > 0)
    || (typeof record.artifactPath === "string" && record.artifactPath.trim().length > 0)
}

function isPositiveFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function validateOptionalTables(value: unknown, prefix: string): QualityIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [error("invalid-word-tables", `${prefix}: expected array of TableSpec, got ${describeValueShape(value)}.`)]
  return value.flatMap((table, index) => validateTable(table, `${prefix}[${index}]`))
}

function validateTable(table: unknown, prefix: string): QualityIssue[] {
  const issues: QualityIssue[] = []
  if (!table || typeof table !== "object" || Array.isArray(table)) return [error("invalid-word-table", `${prefix}: expected object, got ${describeValueShape(table)}.`)]
  const record = table as { headers?: unknown; rows?: unknown; columnWidthRatios?: unknown; columnAlignments?: unknown }
  if (!Array.isArray(record.headers)) {
    issues.push(error("invalid-word-table-headers", `${prefix}.headers: expected array of strings, got ${describeValueShape(record.headers)}.`))
  } else {
    issues.push(...validateStringArray(record.headers, `${prefix}.headers`))
  }
  if (!Array.isArray(record.rows)) {
    issues.push(error("invalid-word-table-rows", `${prefix}.rows: expected array of rows, got ${describeValueShape(record.rows)}.`))
  } else {
    for (const [rowIndex, row] of record.rows.entries()) {
      if (!Array.isArray(row)) {
        issues.push(error("invalid-word-table-row", `${prefix}.rows[${rowIndex}]: expected array of cells, got ${describeValueShape(row)}.`))
        continue
      }
      for (const [cellIndex, cell] of row.entries()) issues.push(...validateTableCell(cell, `${prefix}.rows[${rowIndex}][${cellIndex}]`))
    }
  }
  if (Array.isArray(record.columnWidthRatios)) {
    for (const [index, ratio] of record.columnWidthRatios.entries()) {
      if (!isPositiveFiniteNumber(ratio)) issues.push(error("invalid-word-table-column-width", `${prefix}.columnWidthRatios[${index}]: expected positive number, got ${describeValueShape(ratio)}.`))
    }
  }
  if (Array.isArray(record.columnAlignments)) {
    for (const [index, alignment] of record.columnAlignments.entries()) {
      if (alignment !== "left" && alignment !== "center" && alignment !== "right") issues.push(error("invalid-word-table-column-alignment", `${prefix}.columnAlignments[${index}]: expected left, center, or right, got ${describeValueShape(alignment)}.`))
    }
  }
  if (issues.length) return issues
  return validateTableGeometry(table as TableSpec, prefix).map((issue) => error(issue.code, issue.message))
}

function validateTableCell(cell: unknown, prefix: string): QualityIssue[] {
  if (typeof cell === "string") return []
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return [error("invalid-word-table-cell", `${prefix}: expected string or cell object, got ${describeValueShape(cell)}.`)]
  const record = cell as { text?: unknown; colSpan?: unknown; rowSpan?: unknown; alignment?: unknown }
  const issues: QualityIssue[] = []
  if (typeof record.text !== "string") issues.push(error("invalid-word-table-cell-text", `${prefix}.text: expected string, got ${describeValueShape(record.text)}.`))
  if (record.colSpan !== undefined && !isPositiveInteger(record.colSpan)) issues.push(error("invalid-word-table-cell-colspan", `${prefix}.colSpan: expected positive integer, got ${describeValueShape(record.colSpan)}.`))
  if (record.rowSpan !== undefined && !isPositiveInteger(record.rowSpan)) issues.push(error("invalid-word-table-cell-rowspan", `${prefix}.rowSpan: expected positive integer, got ${describeValueShape(record.rowSpan)}.`))
  if (record.alignment !== undefined && record.alignment !== "left" && record.alignment !== "center" && record.alignment !== "right") issues.push(error("invalid-word-table-cell-alignment", `${prefix}.alignment: expected left, center, or right, got ${describeValueShape(record.alignment)}.`))
  return issues
}

function describeValueShape(value: unknown) {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `array(${value.length})`
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`
  if (typeof value === "object") return `object keys=${Object.keys(value as Record<string, unknown>).slice(0, 8).join(",") || "none"}`
  return typeof value
}

function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function isSourceBackedDocument(spec: WordDocSpec) {
  return Boolean(spec.sources?.length || spec.references?.length || spec.sections?.some((section) => section.sourceBackedBlocks?.length || section.sourceRefs?.length || section.sourceList?.length))
}

function isCodingGuideline(spec: WordDocSpec) {
  return /coding[-_\s]?guideline|编码规范|c-coding/i.test(spec.metadata?.documentType ?? "")
}

function error(code: string, message: string): QualityIssue {
  return { severity: "error", code, message }
}

function warning(code: string, message: string): QualityIssue {
  return { severity: "warning", code, message }
}
