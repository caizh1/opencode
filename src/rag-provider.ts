import * as crypto from "node:crypto"
import * as net from "node:net"
import { estimateEmbeddingTokens } from "./rag-token"
import type { EmbeddingProvider, RagEndpointPolicyResult, RerankProvider, RerankResult } from "./rag-types"
import type { RagSettings } from "./types"

const RAG_RERANK_PROBE_QUERY = "ChipMate RAG rerank connectivity probe"
const RAG_RERANK_PROBE_DOCUMENTS = [
  "ChipMate RAG rerank probe document",
  "unrelated fallback document",
]

export type RagHttpDiagnosticEvent = {
  phase: "request" | "response" | "normalize" | "encoding"
  kind: "embedding" | "rerank"
  method: "POST"
  endpoint: string
  model?: string
  encodingFormat?: "float" | "base64" | "auto"
  effectiveEncodingFormat?: "float" | "base64"
  base64Capability?: "unknown" | "supported" | "unsupported"
  estimatedTokens?: number
  timeoutMs: number
  authorizationPresent: boolean
  apiKeyFingerprint?: string
  inputCount?: number
  batchSize?: number
  documentCount?: number
  topN?: number
  status?: number
  statusText?: string
  ok?: boolean
  elapsedMs?: number
  responseBytes?: number
  parseElapsedMs?: number
  normalizeElapsedMs?: number
  errorPreview?: string
  message?: string
}

export type RagHttpDiagnostics = (event: RagHttpDiagnosticEvent) => void

export class RagHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodyPreview: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "RagHttpError"
  }
}

type EmbeddingEndpointCapabilities = {
  base64: "unknown" | "supported" | "unsupported"
}

const embeddingEndpointCapabilities = new Map<string, EmbeddingEndpointCapabilities>()

export function checkRagEndpoint(endpoint: string, allowedHosts: string[] = []): RagEndpointPolicyResult {
  const value = endpoint.trim()
  if (!value) return { ok: false, kind: "disabled", reason: "endpoint is not configured" }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, kind: "error", reason: "endpoint is not a valid URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, kind: "blocked", url, reason: `unsupported protocol ${url.protocol}` }
  }
  const host = normalizeHost(url.hostname)
  if (isLocalhost(host)) return { ok: true, kind: "localhost", url }
  if (isPrivateHost(host)) return { ok: true, kind: "private-lan", url }
  if (allowedHosts.map(normalizeHost).includes(host)) return { ok: true, kind: "approved-host", url }
  return { ok: false, kind: "blocked", url, reason: `${url.hostname} is not localhost, private LAN, or in chipmate.rag.allowedHosts` }
}

export function createHttpEmbeddingProvider(settings: RagSettings, apiKey?: string, diagnostics?: RagHttpDiagnostics): EmbeddingProvider | undefined {
  if (!settings.embedding.endpoint) return undefined
  if (settings.embedding.configError) throw new Error(settings.embedding.configError)
  const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
  if (!policy.ok || !policy.url) throw new Error(policy.reason ?? "embedding endpoint is not allowed")
  const capabilityKey = `${policy.url.toString()}\0${settings.embedding.model}`
  return {
    id: `http:${policy.kind}:${policy.url.host}`,
    model: settings.embedding.model,
    async embed(input, signal) {
      const detailed = await this.embedDetailed?.(input, signal)
      return detailed?.vectors ?? []
    },
    async embedDetailed(input, signal) {
      if (input.length === 0) return { vectors: [] }
      const batchSize = Math.max(1, settings.embedding.batchSize)
      const estimatedTokens = input.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0)
      const requestedEncoding = settings.embedding.encodingFormat
      const capabilities = embeddingEndpointCapabilities.get(capabilityKey) ?? { base64: "unknown" as const }
      const diagnosticBase = {
        kind: "embedding" as const,
        model: settings.embedding.model || undefined,
        encodingFormat: requestedEncoding,
        base64Capability: capabilities.base64,
        inputCount: input.length,
        batchSize,
        estimatedTokens,
      }
      const preferredEncoding = chooseEmbeddingEncoding(requestedEncoding, capabilities)
      try {
        const response = await postEmbeddingWithEncoding(policy.url!, settings.embedding.model, input, preferredEncoding, settings.embedding.timeoutMs, diagnosticBase, signal, apiKey, diagnostics)
        if (preferredEncoding === "base64" && capabilities.base64 !== "supported") {
          embeddingEndpointCapabilities.set(capabilityKey, { base64: "supported" })
          emitRagHttpDiagnostic(diagnostics, {
            method: "POST",
            endpoint: policy.url!.toString(),
            timeoutMs: settings.embedding.timeoutMs,
            authorizationPresent: Boolean(apiKey?.trim()),
            apiKeyFingerprint: apiKeyFingerprint(apiKey),
            ...diagnosticBase,
            phase: "encoding",
            effectiveEncodingFormat: "base64",
            base64Capability: "supported",
            message: "embedding encoding base64 supported",
          })
        }
        const normalizeStarted = Date.now()
        const embeddings = normalizeEmbeddingResponse(response.value, input.length)
        emitRagHttpDiagnostic(diagnostics, {
          method: "POST",
          endpoint: policy.url!.toString(),
          timeoutMs: settings.embedding.timeoutMs,
          authorizationPresent: Boolean(apiKey?.trim()),
          apiKeyFingerprint: apiKeyFingerprint(apiKey),
          ...diagnosticBase,
          phase: "normalize",
          effectiveEncodingFormat: preferredEncoding,
          base64Capability: embeddingEndpointCapabilities.get(capabilityKey)?.base64 ?? capabilities.base64,
          responseBytes: response.responseBytes,
          normalizeElapsedMs: Date.now() - normalizeStarted,
        })
        return { vectors: embeddings, responseBytes: response.responseBytes, effectiveEncodingFormat: preferredEncoding }
      } catch (error) {
        if (preferredEncoding === "base64" && isEncodingFormatUnsupported(error)) {
          embeddingEndpointCapabilities.set(capabilityKey, { base64: "unsupported" })
          emitRagHttpDiagnostic(diagnostics, {
            method: "POST",
            endpoint: policy.url!.toString(),
            timeoutMs: settings.embedding.timeoutMs,
            authorizationPresent: Boolean(apiKey?.trim()),
            apiKeyFingerprint: apiKeyFingerprint(apiKey),
            ...diagnosticBase,
            phase: "encoding",
            effectiveEncodingFormat: "float",
            base64Capability: "unsupported",
            message: "embedding encoding base64 unsupported; retrying float",
          })
          const response = await postEmbeddingWithEncoding(policy.url!, settings.embedding.model, input, "float", settings.embedding.timeoutMs, {
            ...diagnosticBase,
            base64Capability: "unsupported" as const,
          }, signal, apiKey, diagnostics)
          const normalizeStarted = Date.now()
          const embeddings = normalizeEmbeddingResponse(response.value, input.length)
          emitRagHttpDiagnostic(diagnostics, {
            method: "POST",
            endpoint: policy.url!.toString(),
            timeoutMs: settings.embedding.timeoutMs,
            authorizationPresent: Boolean(apiKey?.trim()),
            apiKeyFingerprint: apiKeyFingerprint(apiKey),
            ...diagnosticBase,
            phase: "normalize",
            effectiveEncodingFormat: "float",
            base64Capability: "unsupported",
            responseBytes: response.responseBytes,
            normalizeElapsedMs: Date.now() - normalizeStarted,
          })
          return { vectors: embeddings, responseBytes: response.responseBytes, effectiveEncodingFormat: "float" }
        }
        throw error
      }
    },
  }
}

export function createHttpRerankProvider(settings: RagSettings, apiKey?: string, diagnostics?: RagHttpDiagnostics): RerankProvider | undefined {
  if (!settings.rerank.endpoint) return undefined
  const policy = checkRagEndpoint(settings.rerank.endpoint, settings.allowedHosts)
  if (!policy.ok || !policy.url) throw new Error(policy.reason ?? "rerank endpoint is not allowed")
  return {
    id: `http:${policy.kind}:${policy.url.host}`,
    model: settings.rerank.model,
    async rerank(input) {
      if (input.topN <= 0 || input.documents.length === 0) return []
      const response = await fetchJsonWithTimeout(policy.url!, {
        model: settings.rerank.model || undefined,
        query: input.query,
        documents: input.documents,
        top_n: input.topN,
      }, settings.embedding.timeoutMs, {
        kind: "rerank",
        model: settings.rerank.model || undefined,
        documentCount: input.documents.length,
        topN: input.topN,
      }, input.signal, apiKey, diagnostics)
      return normalizeRerankResponse(response.value, input.documents.length)
    },
  }
}

export function normalizeEmbeddingResponse(input: unknown, expected: number): number[][] {
  const root = objectRecord(input)
  const data = Array.isArray(root.data) ? root.data : Array.isArray(input) ? input : []
  const rows = data
    .map((item): number[] | undefined => {
      if (Array.isArray(item)) return readEmbeddingValue(item)
      const record = objectRecord(item)
      return readEmbeddingValue(record.embedding)
    })
    .filter((item): item is number[] => Array.isArray(item))
    .filter((item) => item.length > 0 && item.every(Number.isFinite))
  if (rows.length !== expected) throw new Error(`embedding response returned ${rows.length} vector(s), expected ${expected}`)
  const dimension = rows[0]?.length ?? 0
  if (!dimension || rows.some((row) => row.length !== dimension)) throw new Error("embedding response vectors have inconsistent dimensions")
  return rows
}

export function normalizeRerankResponse(input: unknown, documentCount: number): RerankResult[] {
  const root = objectRecord(input)
  const values = Array.isArray(root.results) ? root.results : Array.isArray(root.data) ? root.data : Array.isArray(input) ? input : []
  const result: RerankResult[] = []
  for (const item of values) {
    const record = objectRecord(item)
    const index = numberValue(record.index ?? record.document_index ?? record.id)
    const score = numberValue(record.relevance_score ?? record.score ?? record.relevance)
    if (index === undefined || score === undefined) continue
    if (index < 0 || index >= documentCount) continue
    result.push({ index, score })
  }
  return result.sort((left, right) => right.score - left.score)
}

export async function probeRagRerankProvider(provider: RerankProvider, signal?: AbortSignal): Promise<RerankResult> {
  const results = await provider.rerank({
    query: RAG_RERANK_PROBE_QUERY,
    documents: RAG_RERANK_PROBE_DOCUMENTS,
    topN: 1,
    signal,
  })
  const first = results[0]
  if (!first) throw new Error("rerank provider returned no probe result")
  if (first.index < 0 || first.index >= RAG_RERANK_PROBE_DOCUMENTS.length || !Number.isFinite(first.score)) {
    throw new Error("rerank provider returned an invalid probe result")
  }
  return first
}

async function postEmbeddingWithEncoding(
  url: URL,
  model: string,
  input: string[],
  effectiveEncodingFormat: "float" | "base64",
  timeoutMs: number,
  detail: Pick<RagHttpDiagnosticEvent, "kind" | "model" | "encodingFormat" | "base64Capability" | "estimatedTokens" | "inputCount" | "batchSize">,
  signal?: AbortSignal,
  apiKey?: string,
  diagnostics?: RagHttpDiagnostics,
) {
  const requestBody = {
    model: model || undefined,
    input,
    ...(effectiveEncodingFormat === "base64" ? { encoding_format: "base64" } : {}),
  }
  return fetchJsonWithTimeout(url, requestBody, timeoutMs, {
    ...detail,
    effectiveEncodingFormat,
  }, signal, apiKey, diagnostics)
}

async function fetchJsonWithTimeout(
  url: URL,
  body: unknown,
  timeoutMs: number,
  detail: Pick<RagHttpDiagnosticEvent, "kind" | "model" | "encodingFormat" | "effectiveEncodingFormat" | "base64Capability" | "estimatedTokens" | "inputCount" | "batchSize" | "documentCount" | "topN">,
  signal?: AbortSignal,
  apiKey?: string,
  diagnostics?: RagHttpDiagnostics,
) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const started = Date.now()
  try {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    const diagnosticBase = {
      method: "POST" as const,
      endpoint: url.toString(),
      timeoutMs,
      authorizationPresent: Boolean(apiKey?.trim()),
      apiKeyFingerprint: apiKeyFingerprint(apiKey),
      ...detail,
    }
    emitRagHttpDiagnostic(diagnostics, { ...diagnosticBase, phase: "request" })
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    const errorPreview = text.slice(0, 300)
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))
    const parseStarted = Date.now()
    const parsed = response.ok && text ? JSON.parse(text) : undefined
    const parseElapsedMs = response.ok && text ? Date.now() - parseStarted : undefined
    emitRagHttpDiagnostic(diagnostics, {
      ...diagnosticBase,
      phase: "response",
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      responseBytes: Buffer.byteLength(text),
      parseElapsedMs,
      errorPreview: response.ok ? undefined : errorPreview,
    })
    if (!response.ok) throw new RagHttpError(`${response.status} ${response.statusText}: ${errorPreview}`, response.status, response.statusText, errorPreview, retryAfterMs)
    return { value: parsed, responseBytes: Buffer.byteLength(text) }
  } catch (error) {
    if (timedOut && !signal?.aborted && isFetchAbortError(error)) {
      const message = `embedding request timed out after ${timeoutMs}ms`
      emitRagHttpDiagnostic(diagnostics, {
        method: "POST",
        endpoint: url.toString(),
        timeoutMs,
        authorizationPresent: Boolean(apiKey?.trim()),
        apiKeyFingerprint: apiKeyFingerprint(apiKey),
        ...detail,
        phase: "response",
        status: 408,
        statusText: "Request Timeout",
        ok: false,
        elapsedMs: Date.now() - started,
        errorPreview: message,
      })
      throw new RagHttpError(`408 Request Timeout: ${message}`, 408, "Request Timeout", message)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

function chooseEmbeddingEncoding(format: RagSettings["embedding"]["encodingFormat"], capabilities: EmbeddingEndpointCapabilities): "float" | "base64" {
  if (format === "float") return "float"
  if (capabilities.base64 === "unsupported") return "float"
  if (format === "base64") return "base64"
  return capabilities.base64 === "supported" || capabilities.base64 === "unknown" ? "base64" : "float"
}

function isEncodingFormatUnsupported(error: unknown) {
  if (!(error instanceof RagHttpError)) return false
  if (error.status !== 400 && error.status !== 422) return false
  const text = `${error.message} ${error.bodyPreview}`.toLowerCase()
  return (
    (text.includes("encoding_format") || text.includes("base64"))
    && (
      text.includes("unsupported")
      || text.includes("invalid_request")
      || text.includes("invalid request")
      || text.includes("bad request")
      || text.includes("unknown")
      || text.includes("not support")
    )
  )
}

function readEmbeddingValue(value: unknown): number[] | undefined {
  if (typeof value === "string") return Array.from(decodeBase64Float32(value))
  if (Array.isArray(value)) return value.map((item) => Number(item))
  return undefined
}

function decodeBase64Float32(input: string): Float32Array {
  const buffer = Buffer.from(input, "base64")
  if (buffer.byteLength % 4 !== 0) throw new Error("Invalid base64 embedding byte length.")
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
  return new Float32Array(view)
}

function isFetchAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function apiKeyFingerprint(apiKey?: string) {
  const value = apiKey?.trim()
  if (!value) return undefined
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 8)} len=${value.length}`
}

function emitRagHttpDiagnostic(diagnostics: RagHttpDiagnostics | undefined, event: RagHttpDiagnosticEvent) {
  try {
    diagnostics?.(event)
  } catch {
    // Diagnostics must never affect the RAG request path.
  }
}

function normalizeHost(host: string) {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase()
}

function isLocalhost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
}

function isPrivateHost(host: string) {
  const version = net.isIP(host)
  if (version === 4) {
    const parts = host.split(".").map(Number)
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
  }
  if (version === 6) {
    const lower = host.toLowerCase()
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")
  }
  return false
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}
