import type { FilePart } from "@opencode-ai/sdk/v2"

const DOCX_METADATA_KEY = "opencodeDocx"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hidden(part: FilePart) {
  const metadata = part.metadata?.[DOCX_METADATA_KEY]
  return record(metadata) && metadata.hidden === true
}

export function attached(part: FilePart) {
  if (hidden(part)) return false
  return part.url.startsWith("data:")
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
