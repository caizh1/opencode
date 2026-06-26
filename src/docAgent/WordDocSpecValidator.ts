import type { QualityIssue, WordDocSpec } from "./types"

export class WordDocSpecValidator {
  validate(spec: WordDocSpec): QualityIssue[] {
    const issues: QualityIssue[] = []
    if (!spec.metadata?.title?.trim()) issues.push(error("missing-title", "WordDocSpec metadata.title is required."))
    if (!spec.metadata?.documentType?.trim()) issues.push(error("missing-document-type", "WordDocSpec metadata.documentType is required."))
    if (!Array.isArray(spec.sources) || spec.sources.length === 0) issues.push(error("missing-sources", "WordDocSpec must include at least one source."))
    if (!Array.isArray(spec.sections) || spec.sections.length === 0) issues.push(error("missing-sections", "WordDocSpec must include sections."))
    if (!spec.sections?.some((section) => section.title === "References")) issues.push(warning("missing-references-section", "Document should include a References section."))
    if (!spec.sections?.some((section) => section.ruleCards?.length)) issues.push(warning("missing-rule-cards", "Document has no rule cards."))
    return issues
  }
}

function error(code: string, message: string): QualityIssue {
  return { severity: "error", code, message }
}

function warning(code: string, message: string): QualityIssue {
  return { severity: "warning", code, message }
}
