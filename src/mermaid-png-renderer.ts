import { writeFile } from "node:fs/promises"

export type MermaidPngRenderInput = {
  source: string
  repoRoot?: string
  outputPath?: string
  scale?: number
}

export type MermaidPngRenderResult = {
  bytes: Uint8Array
  width: number
  height: number
  pixelWidth?: number
  pixelHeight?: number
  scale?: number
  scaleMetadataMissing?: boolean
  cropMetadataMissing?: boolean
  contentBounds?: MermaidPngBounds
  cropBounds?: MermaidPngBounds
  padding?: number
  contentCropRatio?: number
  issues?: Array<{ severity?: string; code?: string; message?: string }>
  artifactPath?: string
  renderProvider?: "remote-opencode"
  fallbackUsed?: boolean
  remoteFailure?: MermaidPngRenderDiagnostic
}

export type MermaidPngBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type MermaidPngRenderErrorCode =
  | "mermaid-runtime-missing"
  | "mermaid-render-failed"
  | "mermaid-render-timeout"
  | "png-invalid"
  | "artifact-write-failed"
  | "remote-unconfigured"
  | "remote-unavailable"
  | "remote-invalid-response"
  | "remote-render-failed"
  | "remote-timeout"

export type MermaidPngRenderDiagnostic = {
  errorCode: MermaidPngRenderErrorCode
  message: string
  platform: NodeJS.Platform
  cwd: string
  nodeVersion: string
  stderrSnippet?: string
  stdoutSnippet?: string
  remoteEndpoint?: string
  httpStatus?: number
  issues?: Array<{ severity?: string; code?: string; message?: string }>
  remoteFailure?: MermaidPngRenderDiagnostic
}

export type MermaidPngRemoteFirstInput = MermaidPngRenderInput & {
  remoteEndpoint?: string
  filename?: string
  timeoutMs?: number
  log?: (message: string) => void
  signal?: AbortSignal
}

export class MermaidPngRenderError extends Error {
  readonly diagnostic: MermaidPngRenderDiagnostic

  constructor(diagnostic: MermaidPngRenderDiagnostic) {
    super(diagnostic.message)
    this.name = "MermaidPngRenderError"
    this.diagnostic = diagnostic
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const REMOTE_ERROR_CODES = new Set<MermaidPngRenderErrorCode>([
  "remote-unavailable",
  "remote-invalid-response",
  "remote-render-failed",
  "remote-timeout",
  "mermaid-runtime-missing",
  "mermaid-render-failed",
  "mermaid-render-timeout",
  "png-invalid",
])
let renderMermaidToPngForTest: ((input: MermaidPngRenderInput) => Promise<MermaidPngRenderResult>) | undefined

export function setMermaidPngRendererForTest(renderer: ((input: MermaidPngRenderInput) => Promise<MermaidPngRenderResult>) | undefined) {
  renderMermaidToPngForTest = renderer
}

export async function renderMermaidToPngRemoteFirst(input: MermaidPngRemoteFirstInput): Promise<MermaidPngRenderResult> {
  if (renderMermaidToPngForTest) {
    const mocked = await renderMermaidToPngForTest(input)
    assertPng(mocked.bytes)
    if (input.outputPath) await writeFile(input.outputPath, mocked.bytes)
    const dimensions = pngDimensions(mocked.bytes)
    return {
      ...mocked,
      pixelWidth: mocked.pixelWidth ?? dimensions.width,
      pixelHeight: mocked.pixelHeight ?? dimensions.height,
      scale: mocked.scale ?? input.scale,
      artifactPath: input.outputPath ?? mocked.artifactPath,
      renderProvider: "remote-opencode",
      fallbackUsed: false,
    }
  }
  const endpoint = normalizeRemoteMermaidEndpoint(input.remoteEndpoint)
  if (!endpoint) {
    throw mermaidRenderError("remote-unconfigured", "Remote Mermaid render server is not configured; Mermaid PNG generation was skipped.")
  }
  input.log?.(`[mermaid-render] remote start endpoint=${redactedEndpoint(endpoint)}`)
  try {
    const remote = await renderMermaidToPngRemote({
      source: input.source,
      endpoint,
      filename: input.filename,
      timeoutMs: input.timeoutMs,
      scale: input.scale,
      signal: input.signal,
    })
    try {
      assertPng(remote.bytes)
    } catch (error) {
      throw mermaidRenderError("png-invalid", formatErrorMessage(error), { remoteEndpoint: endpoint })
    }
    try {
      if (input.outputPath) await writeFile(input.outputPath, remote.bytes)
    } catch (error) {
      throw mermaidRenderError("artifact-write-failed", `Failed to write Mermaid PNG artifact: ${formatErrorMessage(error)}`, { remoteEndpoint: endpoint })
    }
    input.log?.(`[mermaid-render] remote completed endpoint=${redactedEndpoint(endpoint)} scale=${remote.scale ?? input.scale ?? "unknown"} cssSize=${remote.width}x${remote.height} pixelSize=${remote.pixelWidth ?? "?"}x${remote.pixelHeight ?? "?"} crop=${remote.cropBounds ? `${remote.cropBounds.width}x${remote.cropBounds.height}@${remote.cropBounds.x},${remote.cropBounds.y}` : "missing"}`)
    return {
      ...remote,
      artifactPath: input.outputPath,
      renderProvider: "remote-opencode",
      fallbackUsed: false,
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    const remoteFailure = diagnosticFromError(error, {
      errorCode: "remote-unavailable",
      message: formatErrorMessage(error),
      remoteEndpoint: endpoint,
    })
    input.log?.(`[mermaid-render] remote failed code=${remoteFailure.errorCode} endpoint=${redactedEndpoint(endpoint)} message=${remoteFailure.message}`)
    throw new MermaidPngRenderError(remoteFailure)
  }
}

async function renderMermaidToPngRemote(input: {
  endpoint: string
  source: string
  filename?: string
  timeoutMs?: number
  scale?: number
  signal?: AbortSignal
}): Promise<MermaidPngRenderResult> {
  if (!input.source.trim()) throw mermaidRenderError("mermaid-render-failed", "Mermaid source is empty.", { remoteEndpoint: input.endpoint })
  const timeoutMs = Math.max(5000, Math.min(Number(input.timeoutMs) || 60000, 120000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: input.source,
        filename: input.filename || "diagram.mmd",
        timeoutMs,
        scale: input.scale,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch (error) {
      throw mermaidRenderError("remote-invalid-response", `Remote Mermaid render response was not valid JSON: ${formatErrorMessage(error)}`, {
        remoteEndpoint: input.endpoint,
        httpStatus: response.status,
        stdoutSnippet: bounded(text),
      })
    }
    if (!response.ok) {
      throw remoteMermaidError(payload, "remote-unavailable", `HTTP ${response.status}: ${text.slice(0, 1000) || response.statusText}`, input.endpoint, response.status)
    }
    if (payload.ok !== true) {
      throw remoteMermaidError(payload, "remote-render-failed", "Remote Mermaid render returned ok=false.", input.endpoint, response.status)
    }
    const png = recordValue(payload.png)
    if (stringValue(png.contentType) !== "image/png") {
      throw remoteMermaidError(payload, "remote-invalid-response", `Remote Mermaid render returned unsupported png.contentType: ${stringValue(png.contentType) || "(missing)"}`, input.endpoint, response.status)
    }
    const bytes = Buffer.from(stringValue(png.base64), "base64")
    if (!bytes.length) {
      throw remoteMermaidError(payload, "remote-invalid-response", "Remote Mermaid render response png.base64 is empty.", input.endpoint, response.status)
    }
    const dimensions = pngDimensions(bytes)
    const cssWidth = positiveInteger(payload.width) ?? dimensions.width
    const cssHeight = positiveInteger(payload.height) ?? dimensions.height
    const pixelWidth = positiveInteger(payload.pixelWidth) ?? dimensions.width
    const pixelHeight = positiveInteger(payload.pixelHeight) ?? dimensions.height
    const responseScale = positiveNumber(payload.scale)
    const contentBounds = boundsValue(payload.contentBounds)
    const cropBounds = boundsValue(payload.cropBounds)
    const padding = positiveNumber(payload.padding)
    const contentCropRatio = positiveNumber(payload.contentCropRatio)
    const issues = arrayRecords(payload.issues).map((item) => ({
      severity: stringValue(item.severity),
      code: stringValue(item.code),
      message: stringValue(item.message),
    }))
    const scaleMetadataMissing = (input.scale ?? 0) > 1 && (
      positiveInteger(payload.pixelWidth) === undefined ||
      positiveInteger(payload.pixelHeight) === undefined ||
      responseScale === undefined
    )
    const cropMetadataMissing = !contentBounds || !cropBounds
    return {
      bytes: Uint8Array.from(bytes),
      width: cssWidth,
      height: cssHeight,
      pixelWidth,
      pixelHeight,
      scale: responseScale ?? input.scale,
      scaleMetadataMissing,
      cropMetadataMissing,
      contentBounds,
      cropBounds,
      padding,
      contentCropRatio,
      issues,
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    if (error instanceof MermaidPngRenderError) throw error
    const code = error instanceof Error && error.name === "AbortError" ? "remote-timeout" : "remote-unavailable"
    throw mermaidRenderError(code, formatErrorMessage(error), { remoteEndpoint: input.endpoint })
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
  }
}

function remoteMermaidError(payload: Record<string, unknown>, fallbackCode: MermaidPngRenderErrorCode, fallbackMessage: string, endpoint: string, httpStatus?: number) {
  const issues = arrayRecords(payload.issues).map((item) => ({
    severity: stringValue(item.severity),
    code: stringValue(item.code),
    message: stringValue(item.message),
  }))
  const firstIssue = issues.find((item) => item.message)
  const issueCode = firstIssue?.code
  const errorCode: MermaidPngRenderErrorCode = issueCode && REMOTE_ERROR_CODES.has(issueCode as MermaidPngRenderErrorCode) ? issueCode as MermaidPngRenderErrorCode : fallbackCode
  return mermaidRenderError(errorCode, firstIssue?.message || fallbackMessage, {
    remoteEndpoint: endpoint,
    httpStatus,
    issues,
  })
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function mermaidRenderError(errorCode: MermaidPngRenderErrorCode, message: string, detail: Partial<MermaidPngRenderDiagnostic> = {}) {
  return new MermaidPngRenderError({
    errorCode,
    message: bounded(message),
    platform: process.platform,
    cwd: process.cwd(),
    nodeVersion: process.version,
    stderrSnippet: detail.stderrSnippet ? bounded(detail.stderrSnippet) : undefined,
    stdoutSnippet: detail.stdoutSnippet ? bounded(detail.stdoutSnippet) : undefined,
    remoteEndpoint: detail.remoteEndpoint,
    httpStatus: detail.httpStatus,
    issues: detail.issues,
    remoteFailure: detail.remoteFailure,
  })
}

function diagnosticFromError(error: unknown, fallback: Partial<MermaidPngRenderDiagnostic> & { errorCode: MermaidPngRenderErrorCode; message: string }) {
  if (error instanceof MermaidPngRenderError) return error.diagnostic
  return mermaidRenderError(fallback.errorCode, fallback.message, fallback).diagnostic
}

function assertPng(bytes: Uint8Array) {
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("Mermaid renderer did not return a valid PNG.")
  }
}

function bounded(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 2000)
}

function normalizeRemoteMermaidEndpoint(input: string | undefined) {
  const trimmed = input?.trim().replace(/\/+$/, "") ?? ""
  if (!trimmed) return ""
  if (/\/render\/mermaid$/i.test(trimmed)) return trimmed
  if (/\/render\/word$/i.test(trimmed)) return trimmed.replace(/\/render\/word$/i, "/render/mermaid")
  return `${trimmed}/render/mermaid`
}

function redactedEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return endpoint
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(recordValue).filter((item) => Object.keys(item).length > 0) : []
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function boundsValue(value: unknown): MermaidPngBounds | undefined {
  const record = recordValue(value)
  const width = positiveInteger(record.width)
  const height = positiveInteger(record.height)
  if (!width || !height) return undefined
  return {
    x: typeof record.x === "number" && Number.isFinite(record.x) ? Math.round(record.x) : 0,
    y: typeof record.y === "number" && Number.isFinite(record.y) ? Math.round(record.y) : 0,
    width,
    height,
  }
}

function pngDimensions(bytes: Uint8Array | Buffer) {
  if (bytes.length >= 24 && bytes[0] === PNG_SIGNATURE[0] && bytes[1] === PNG_SIGNATURE[1] && bytes[2] === PNG_SIGNATURE[2] && bytes[3] === PNG_SIGNATURE[3]) {
    return {
      width: Number(Buffer.from(bytes).readUInt32BE(16)),
      height: Number(Buffer.from(bytes).readUInt32BE(20)),
    }
  }
  return { width: 1, height: 1 }
}
