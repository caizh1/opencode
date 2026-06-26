import { Buffer } from "node:buffer"

const PNG_DATA_URI_PREFIX = /^data:image\/png;base64,/i
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const DEFAULT_MAX_PNG_BYTES = 25 * 1024 * 1024

export function decodePngDataUri(dataUri: string, label = "PNG export", maxBytes = DEFAULT_MAX_PNG_BYTES): Uint8Array {
  const trimmed = String(dataUri || "").trim()
  if (!PNG_DATA_URI_PREFIX.test(trimmed)) {
    throw new Error(`${label} must be a PNG data URI.`)
  }

  const base64 = trimmed.replace(PNG_DATA_URI_PREFIX, "").replace(/\s+/g, "")
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error(`${label} data URI contains invalid base64.`)
  }

  const bytes = Buffer.from(base64, "base64")
  if (bytes.length > maxBytes) {
    throw new Error(`${label} is too large (${bytes.length} bytes).`)
  }
  if (!isPng(bytes)) {
    throw new Error(`${label} payload is not a PNG image.`)
  }
  return new Uint8Array(bytes)
}

export function decodeDrawioPngDataUri(dataUri: string, maxBytes = DEFAULT_MAX_PNG_BYTES): Uint8Array {
  return decodePngDataUri(dataUri, "Draw.io PNG export", maxBytes)
}

export function pngExportFilename(filenameHint?: string, fallback = "chipmate-diagram") {
  const base = sanitizeFilenameBase(filenameHint || fallback) || fallback
  return base.toLowerCase().endsWith(".png") ? base : `${base}.png`
}

export function drawioPngFilename(filenameHint?: string, fallback = "chipmate-drawio-diagram") {
  return pngExportFilename(filenameHint, fallback)
}

function isPng(bytes: Uint8Array) {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

function sanitizeFilenameBase(value: string) {
  return String(value || "")
    .trim()
    .replace(/\.[A-Za-z0-9]{1,8}$/g, "")
    .replace(/[\\/:\0]/g, "-")
    .replace(/[<>|"?*]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/[.-]+$/g, "")
    .slice(0, 80)
}
