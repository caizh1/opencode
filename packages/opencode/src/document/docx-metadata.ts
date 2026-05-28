export const DOCX_METADATA_KEY = "opencodeDocx"

export type DocxFileMetadata = {
  displayOnly?: boolean
  hidden?: boolean
  modelContext?: boolean
  source?: string
  index?: number
  kind?: "original" | "image"
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function docxMetadata(metadata: Record<string, unknown> | undefined): DocxFileMetadata | undefined {
  const value = metadata?.[DOCX_METADATA_KEY]
  if (!record(value)) return

  return {
    displayOnly: typeof value.displayOnly === "boolean" ? value.displayOnly : undefined,
    hidden: typeof value.hidden === "boolean" ? value.hidden : undefined,
    modelContext: typeof value.modelContext === "boolean" ? value.modelContext : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    index: typeof value.index === "number" ? value.index : undefined,
    kind: value.kind === "original" || value.kind === "image" ? value.kind : undefined,
  }
}

export function withDocxMetadata(
  metadata: Record<string, unknown> | undefined,
  next: DocxFileMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [DOCX_METADATA_KEY]: {
      ...(docxMetadata(metadata) ?? {}),
      ...next,
    },
  }
}

export function isDocxDisplayOnly(part: { metadata?: Record<string, unknown> }) {
  return docxMetadata(part.metadata)?.displayOnly === true
}

export function isDocxHidden(part: { metadata?: Record<string, unknown> }) {
  return docxMetadata(part.metadata)?.hidden === true
}

export function isDocxModelContext(part: { metadata?: Record<string, unknown> }) {
  return docxMetadata(part.metadata)?.modelContext === true
}
