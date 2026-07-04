import * as path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { QualityIssue, WordEditRenderCheckResult, WordRenderedPageVisualSummary } from "./types"

const DEFAULT_RENDER_PATH = "/render/word"
const MAX_REMOTE_RENDER_PAGES = 80
const MAX_REMOTE_RENDER_PDF_BYTES = 80 * 1024 * 1024
const MAX_REMOTE_RENDER_PAGE_BYTES = 16 * 1024 * 1024
type WordRenderSkipReason = NonNullable<WordEditRenderCheckResult["skipReason"]>

type RemoteWordRenderResponse = {
  ok?: boolean
  pageCount?: number
  pdf?: {
    contentType?: string
    base64?: string
  }
  pages?: Array<{
    page?: number
    contentType?: string
    base64?: string
    width?: number
    height?: number
    visualSummary?: Partial<WordRenderedPageVisualSummary>
  }>
  issues?: unknown[]
  renderer?: {
    kind?: string
    docxToPdf?: string
    pdfToPng?: string
    sofficePath?: string
    pdftoppmPath?: string
  }
}

export async function renderWordDocument(input: {
  docxPath: string
  bytes: Uint8Array
  timeoutMs: number
  workspaceRoot?: string
  artifactNameBase?: string
  structureIssues?: QualityIssue[]
  signal?: AbortSignal
  log?: (message: string) => void
  remoteEndpoint?: string
}): Promise<WordEditRenderCheckResult> {
  const startedAt = Date.now()
  const structureIssues = renderRelevantStructureIssues(input.structureIssues)
  const endpoint = await configuredRemoteEndpoint(input.remoteEndpoint)
  if (!endpoint) {
    return skippedRenderResult({
      startedAt,
      structureIssues,
      reason: "remote-unconfigured",
      code: "remote-word-render-unconfigured",
      message: "Remote Word render server is not configured; page-level visual QA was skipped.",
      log: input.log,
    })
  }

  try {
    input.signal?.throwIfAborted()
    const response = await renderWordDocumentRemote({
      endpoint,
      docxPath: input.docxPath,
      bytes: input.bytes,
      artifactNameBase: input.artifactNameBase,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    let normalized: ReturnType<typeof normalizeRemoteRenderResponse>
    try {
      normalized = normalizeRemoteRenderResponse(response)
    } catch (error) {
      return skippedRenderResult({
        startedAt,
        structureIssues,
        endpoint,
        reason: "remote-invalid-response",
        code: "remote-word-render-invalid-response",
        message: `Remote Word render server returned an invalid render response; page-level visual QA was skipped. endpoint=${redactedEndpoint(endpoint)}; ${formatError(error)}`,
        log: input.log,
      })
    }
    let persisted: Awaited<ReturnType<typeof persistRemoteRenderArtifacts>> | undefined
    try {
      persisted = input.workspaceRoot
        ? await persistRemoteRenderArtifacts({
          workspaceRoot: input.workspaceRoot,
          artifactNameBase: input.artifactNameBase || path.basename(input.docxPath, ".docx"),
          pdfBytes: normalized.pdfBytes,
          pages: normalized.pages,
        })
        : undefined
    } catch (error) {
      return skippedRenderResult({
        startedAt,
        structureIssues,
        endpoint,
        reason: "artifact-persist-failed",
        code: "remote-word-render-artifact-persist-failed",
        message: `Remote Word render server returned page artifacts, but ChipMate could not save them locally; page-level visual QA was skipped. endpoint=${redactedEndpoint(endpoint)}; ${formatError(error)}`,
        log: input.log,
      })
    }
    const pageVisualSummaries = normalized.pages.map((page, index) => ({
      page: page.page,
      path: persisted?.pagePngPaths[index],
      absolutePath: persisted?.absolutePagePngPaths[index],
      width: page.width,
      height: page.height,
      totalPixels: page.visualSummary?.totalPixels ?? page.width * page.height,
      inkPixels: page.visualSummary?.inkPixels ?? 0,
      inkRatio: page.visualSummary?.inkRatio ?? 0,
      contentBounds: page.visualSummary?.contentBounds,
      edgeInk: page.visualSummary?.edgeInk ?? { top: false, right: false, bottom: false, left: false },
      visualRegions: page.visualSummary?.visualRegions,
      inkComponents: page.visualSummary?.inkComponents,
    }))
    const issues = [
      ...structureIssues,
      ...normalized.issues,
      ...(pageVisualSummaries.some((summary) => summary.inkPixels === 0)
        ? [issue("warning", "render-page-summary-missing", "Remote render server did not return ink summaries for one or more page PNGs; image artifacts are still available for model visual QA.")]
        : []),
    ]
    input.log?.(`[word-agent] rendered Word document through remote endpoint ${redactedEndpoint(endpoint)}; pages=${normalized.pages.length}`)
    return {
      attempted: true,
      ok: normalized.ok && normalized.pages.length > 0 && !issues.some((item) => item.severity === "error"),
      visualQaStatus: "completed",
      pdfPath: persisted?.absolutePdfPath,
      pdfArtifactPath: persisted?.pdfPath,
      renderArtifactDir: persisted?.dirPath,
      pagePngPaths: persisted?.pagePngPaths,
      absolutePagePngPaths: persisted?.absolutePagePngPaths,
      pageVisualSummaries,
      pageCount: normalized.pages.length,
      issues,
      sofficePath: normalized.renderer.sofficePath || normalized.renderer.docxToPdf || "remote-opencode",
      pdfToPngPath: normalized.renderer.pdftoppmPath || normalized.renderer.pdfToPng || "remote-opencode",
      pdfToPngRenderer: normalized.renderer.pdfToPng === "pdftoppm" ? "pdftoppm" : undefined,
      renderProvider: "remote-opencode",
      remoteEndpoint: endpoint,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    const invalidResponse = error instanceof RemoteRenderInvalidResponseError
    return skippedRenderResult({
      startedAt,
      structureIssues,
      endpoint,
      reason: invalidResponse ? "remote-invalid-response" : "remote-unavailable",
      code: invalidResponse ? "remote-word-render-invalid-response" : "remote-word-render-unavailable",
      message: invalidResponse
        ? `Remote Word render server returned an invalid render response; page-level visual QA was skipped. endpoint=${redactedEndpoint(endpoint)}; ${formatError(error)}`
        : `Remote Word render server is unavailable; page-level visual QA was skipped. endpoint=${redactedEndpoint(endpoint)}; ${formatError(error)}`,
      log: input.log,
    })
  }
}

async function renderWordDocumentRemote(input: {
  endpoint: string
  docxPath: string
  bytes: Uint8Array
  artifactNameBase?: string
  timeoutMs: number
  signal?: AbortSignal
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: path.basename(input.docxPath),
        artifactNameBase: input.artifactNameBase || path.basename(input.docxPath, ".docx"),
        timeoutMs: input.timeoutMs,
        docxBase64: Buffer.from(input.bytes).toString("base64"),
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000) || response.statusText}`)
    try {
      return JSON.parse(text) as RemoteWordRenderResponse
    } catch (error) {
      throw new RemoteRenderInvalidResponseError(`Remote render response was not valid JSON: ${formatError(error)}`)
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
  }
}

function normalizeRemoteRenderResponse(response: RemoteWordRenderResponse) {
  if (!response.ok) throw invalidResponseError(remoteIssues(response.issues).map((item) => item.message).join("; ") || "remote render returned ok=false")
  const pdfBytes = decodeBase64Bytes(response.pdf?.base64, "pdf.base64", MAX_REMOTE_RENDER_PDF_BYTES)
  if ((response.pdf?.contentType || "application/pdf") !== "application/pdf") {
    throw invalidResponseError(`remote render returned unsupported PDF contentType: ${response.pdf?.contentType}`)
  }
  const pages = (response.pages ?? []).slice(0, MAX_REMOTE_RENDER_PAGES).map((page, index) => {
    const pageNumber = positiveInteger(page.page) ?? index + 1
    if ((page.contentType || "image/png") !== "image/png") {
      throw invalidResponseError(`remote render returned unsupported page ${pageNumber} contentType: ${page.contentType}`)
    }
    const pngBytes = decodeBase64Bytes(page.base64, `pages[${index}].base64`, MAX_REMOTE_RENDER_PAGE_BYTES)
    return {
      page: pageNumber,
      pngBytes,
      width: positiveInteger(page.width) ?? positiveInteger(page.visualSummary?.width) ?? 1,
      height: positiveInteger(page.height) ?? positiveInteger(page.visualSummary?.height) ?? 1,
      visualSummary: page.visualSummary,
    }
  })
  if (pages.length === 0) throw invalidResponseError("remote render returned no page PNGs")
  return {
    ok: response.ok === true,
    pdfBytes,
    pages,
    issues: remoteIssues(response.issues),
    renderer: response.renderer ?? {},
  }
}

function decodeBase64Bytes(value: string | undefined, label: string, maxBytes: number) {
  if (!value || typeof value !== "string") throw invalidResponseError(`remote render response is missing ${label}`)
  const bytes = Buffer.from(value, "base64")
  if (bytes.length <= 0) throw invalidResponseError(`remote render response ${label} is empty`)
  if (bytes.length > maxBytes) throw invalidResponseError(`remote render response ${label} exceeds ${maxBytes} bytes`)
  return bytes
}

class RemoteRenderInvalidResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RemoteRenderInvalidResponseError"
  }
}

function invalidResponseError(message: string): never {
  throw new RemoteRenderInvalidResponseError(message)
}

function skippedRenderResult(input: {
  startedAt: number
  structureIssues: QualityIssue[]
  reason: WordRenderSkipReason
  code: string
  message: string
  endpoint?: string
  log?: (message: string) => void
}): WordEditRenderCheckResult {
  const endpoint = input.endpoint ? redactedEndpoint(input.endpoint) : "unconfigured"
  input.log?.(`[word-agent] remote Word render skipped: ${input.reason}; endpoint=${endpoint}; ${input.message}`)
  return {
    attempted: false,
    ok: !input.structureIssues.some((item) => item.severity === "error"),
    visualQaStatus: "skipped",
    skipReason: input.reason,
    issues: [
      ...input.structureIssues,
      issue("warning", input.code, input.message),
    ],
    renderProvider: "remote-opencode",
    remoteEndpoint: input.endpoint,
    elapsedMs: Date.now() - input.startedAt,
  }
}

function remoteIssues(input: unknown[] | undefined): QualityIssue[] {
  return (input ?? []).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return issue("warning", "remote-render-warning", String(item))
    const record = item as Record<string, unknown>
    const severity = record.severity === "error" ? "error" : "warning"
    return issue(severity, typeof record.code === "string" ? record.code : "remote-render-warning", typeof record.message === "string" ? record.message : JSON.stringify(record))
  })
}

async function persistRemoteRenderArtifacts(input: {
  workspaceRoot: string
  artifactNameBase: string
  pdfBytes: Uint8Array
  pages: Array<{ page: number; pngBytes: Uint8Array }>
}) {
  const docsRoot = path.join(input.workspaceRoot, ".chipmate", "docs")
  const renderRoot = path.join(docsRoot, "rendered")
  const dirName = `${sanitizeArtifactName(input.artifactNameBase)}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${Math.random().toString(36).slice(2, 6)}`
  const outputDir = path.join(renderRoot, dirName)
  await mkdir(outputDir, { recursive: true })
  const absolutePdfPath = path.join(outputDir, "document.pdf")
  await writeFile(absolutePdfPath, input.pdfBytes)
  const absolutePagePngPaths: string[] = []
  for (const page of input.pages) {
    const target = path.join(outputDir, `page-${page.page}.png`)
    await writeFile(target, page.pngBytes)
    absolutePagePngPaths.push(target)
  }
  return {
    dirPath: posixRelative(input.workspaceRoot, outputDir),
    pdfPath: posixRelative(input.workspaceRoot, absolutePdfPath),
    absolutePdfPath,
    pagePngPaths: absolutePagePngPaths.map((item) => posixRelative(input.workspaceRoot, item)),
    absolutePagePngPaths,
  }
}

async function configuredRemoteEndpoint(explicit: string | undefined) {
  const configured = explicit?.trim() || process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT?.trim() || await vscodeWordRenderEndpoint()
  return configured ? normalizeRemoteEndpoint(configured) : undefined
}

async function vscodeWordRenderEndpoint() {
  try {
    const vscode = await import("vscode")
    return vscode.workspace.getConfiguration("chipmate").get<string>("wordRender.remoteEndpoint", "").trim()
  } catch {
    return ""
  }
}

function normalizeRemoteEndpoint(input: string) {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/\/render\/word$/i.test(trimmed)) return trimmed
  return `${trimmed}${DEFAULT_RENDER_PATH}`
}

function renderRelevantStructureIssues(issues: QualityIssue[] | undefined) {
  return (issues ?? []).filter((item) => item.code === "toc-placeholder"
    || item.code === "table-overflow-risk"
    || item.code === "missing-header"
    || item.code === "missing-footer"
    || item.code === "table-header-low-contrast"
    || item.code === "table-header-fill-missing"
    || item.code === "table-header-fill-too-light")
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function sanitizeArtifactName(input: string) {
  return input
    .replace(/\.docx$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "word-render"
}

function posixRelative(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/")
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

function issue(severity: "error" | "warning", code: string, message: string): QualityIssue {
  return { severity, code, message }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
