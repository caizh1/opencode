import type { FileContent } from "@opencode-ai/sdk/v2"

export type MediaKind = "image" | "audio" | "svg" | "mermaid" | "document"
type DataUrlMediaKind = Exclude<MediaKind, "mermaid" | "document">

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic"])
const audioExtensions = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"])
const mermaidExtensions = new Set(["mmd", "mermaid"])
const documentExtensions = new Set(["docx"])
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

type MediaValue = unknown

function mediaRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Partial<FileContent> & {
    content?: unknown
    encoding?: unknown
    mimeType?: unknown
    type?: unknown
  }
}

export function normalizeMimeType(type: string | undefined) {
  if (!type) return
  const mime = type.split(";", 1)[0]?.trim().toLowerCase()
  if (!mime) return
  if (mime === "audio/x-aac") return "audio/aac"
  if (mime === "audio/x-m4a") return "audio/mp4"
  return mime
}

export function fileExtension(path: string | undefined) {
  if (!path) return ""
  const idx = path.lastIndexOf(".")
  if (idx === -1) return ""
  return path.slice(idx + 1).toLowerCase()
}

export function mediaKindFromPath(path: string | undefined): MediaKind | undefined {
  const ext = fileExtension(path)
  if (mermaidExtensions.has(ext)) return "mermaid"
  if (documentExtensions.has(ext)) return "document"
  if (ext === "svg") return "svg"
  if (imageExtensions.has(ext)) return "image"
  if (audioExtensions.has(ext)) return "audio"
}

export function isBinaryContent(value: MediaValue) {
  return mediaRecord(value)?.type === "binary"
}

function validDataUrl(value: string, kind: DataUrlMediaKind) {
  if (kind === "svg") return value.startsWith("data:image/svg+xml") ? value : undefined
  if (kind === "image") return value.startsWith("data:image/") ? value : undefined
  if (value.startsWith("data:audio/x-aac;")) return value.replace("data:audio/x-aac;", "data:audio/aac;")
  if (value.startsWith("data:audio/x-m4a;")) return value.replace("data:audio/x-m4a;", "data:audio/mp4;")
  if (value.startsWith("data:audio/")) return value
}

function looksLikeSvgText(value: string) {
  const source = value.trimStart()
  if (/^<svg(?:\s|>)/i.test(source)) return true
  return /^<\?xml\b/i.test(source) && /<svg(?:\s|>)/i.test(source)
}

export function dataUrlFromMediaValue(value: MediaValue, kind: DataUrlMediaKind) {
  if (!value) return

  if (typeof value === "string") {
    return validDataUrl(value, kind) ?? (kind === "svg" && looksLikeSvgText(value)
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
      : undefined)
  }

  const record = mediaRecord(value)
  if (!record) return

  if (typeof record.content !== "string") return

  const mime = normalizeMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined)
  if (!mime) return

  if (kind === "svg") {
    if (mime !== "image/svg+xml") return
    if (record.encoding === "base64") return `data:image/svg+xml;base64,${record.content}`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(record.content)}`
  }

  if (kind === "image" && !mime.startsWith("image/")) return
  if (kind === "audio" && !mime.startsWith("audio/")) return
  if (record.encoding !== "base64") return

  return `data:${mime};base64,${record.content}`
}

function decodeBase64Utf8(value: string) {
  if (typeof atob !== "function") return

  try {
    const bytes = decodeBase64Bytes(value)
    if (!bytes) return
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes)
    return String.fromCharCode(...bytes)
  } catch {}
}

function decodeBase64Bytes(value: string) {
  if (typeof atob !== "function") return

  try {
    const raw = atob(value)
    return Uint8Array.from(raw, (x) => x.charCodeAt(0))
  } catch {}
}

export function svgTextFromValue(value: MediaValue) {
  if (typeof value === "string") return looksLikeSvgText(value) ? value : undefined

  const record = mediaRecord(value)
  if (!record) return
  if (typeof record.content !== "string") return

  const mime = normalizeMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined)
  if (mime !== "image/svg+xml") return
  if (record.encoding === "base64") return decodeBase64Utf8(record.content)
  return record.content
}

function svgAttribute(source: string, name: string) {
  return source.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]
}

function svgDimension(value: string | undefined) {
  if (!value) return
  if (value.trim().endsWith("%")) return
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return
  return parsed
}

export function svgNaturalSizeFromValue(value: MediaValue) {
  const source = svgTextFromValue(value)
  if (!source) return

  const viewBox = svgAttribute(source, "viewBox")
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number.parseFloat)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! }
    }
  }

  const width = svgDimension(svgAttribute(source, "width"))
  const height = svgDimension(svgAttribute(source, "height"))
  if (!width || !height) return
  return { width, height }
}

export function textFromMediaValue(value: MediaValue) {
  if (typeof value === "string") return value
  const record = mediaRecord(value)
  if (!record) return
  if (record.encoding === "base64") return
  if (typeof record.content !== "string") return
  return record.content
}

export function documentBytesFromMediaValue(value: MediaValue) {
  const record = mediaRecord(value)
  if (!record) return
  if (record.encoding !== "base64") return
  if (typeof record.content !== "string") return

  const mime = normalizeMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined)
  if (mime !== docxMime) return

  return decodeBase64Bytes(record.content)
}

export function hasMediaValue(value: MediaValue) {
  if (typeof value === "string") return value.length > 0
  const record = mediaRecord(value)
  if (!record) return false
  return typeof record.content === "string" && record.content.length > 0
}
