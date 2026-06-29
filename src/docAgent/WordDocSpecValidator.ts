import type { QualityIssue, TableSpec, WordDocSpec } from "./types"
import { WORD_PRESET_ALIAS_BASE } from "./themes/WordDesignPresets"
import { validateTableGeometry } from "./TableSpecUtils"

const WORD_HEADER_PATTERNS = new Set(["none", "memo_masthead", "proposal_centerpiece", "editorial_cover", "customer_pack", "workshop_agenda", "customer_story"])

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
      for (const [tableIndex, table] of (section.tables ?? []).entries()) {
        issues.push(...validateTable(table, `sections.${sectionIndex}.tables.${tableIndex}`))
      }
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
  for (const [index, override] of (spec.layout?.overrides ?? []).entries()) {
    if (!override.role?.trim()) issues.push(error("invalid-layout-override", `layout.overrides.${index}.role is required.`))
    if (!override.reason?.trim()) issues.push(error("invalid-layout-override", `layout.overrides.${index}.reason is required.`))
    if (!override.tokenChanges || typeof override.tokenChanges !== "object") issues.push(error("invalid-layout-override", `layout.overrides.${index}.tokenChanges must be an object.`))
  }
  return issues
}

function validateTable(table: TableSpec, prefix: string): QualityIssue[] {
  return validateTableGeometry(table, prefix).map((issue) => error(issue.code, issue.message))
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
