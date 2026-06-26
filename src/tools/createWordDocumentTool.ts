import { DocxRenderQualityGate } from "../docAgent/DocxRenderQualityGate"
import { DocxFileStore } from "../docAgent/DocxFileStore"
import { WordDocBuilder } from "../docAgent/WordDocBuilder"
import type { GeneratedDocumentResult, WordDocSpec } from "../docAgent/types"

export async function createWordDocument(input: {
  spec: WordDocSpec
  filename?: string
}): Promise<GeneratedDocumentResult> {
  const builder = new WordDocBuilder()
  const bytes = await builder.build(input.spec)
  const renderIssues = await new DocxRenderQualityGate().check(bytes)
  const errors = renderIssues.filter((issue) => issue.severity === "error").map((issue) => issue.message)
  const warnings = renderIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message)
  if (errors.length > 0) {
    throw new Error(`Generated DOCX failed render quality gate: ${errors.join("; ")}`)
  }
  const stored = await new DocxFileStore().write({
    filename: input.filename || input.spec.metadata.title || "team-c-guideline",
    bytes,
  })
  return {
    ...stored,
    title: input.spec.metadata.title,
    sourceCount: input.spec.sources.length,
    warningCount: warnings.length,
    warnings,
    errors: [],
  }
}
