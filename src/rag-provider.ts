import * as crypto from "node:crypto"
import * as net from "node:net"
import { estimateEmbeddingTokens } from "./rag-token"
import type { EmbeddingProvider, RagEndpointPolicyResult, RerankProvider, RerankResult } from "./rag-types"
import type { RagSettings } from "./types"

const RAG_RERANK_PROBE_QUERY = "opencode RAG rerank connectivity probe"
const RAG_RERANK_PROBE_DOCUMENTS = [
  "opencode RAG rerank probe document",
  "unrelated fallback document",
]

export type RagHttpDiagnosticEvent = {
  phase: "request" | "response" | "normalize"
  kind: "embedding" | "rerank"
  method: "POST"
  endpoint: string
  model?: string
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
  return { ok: false, kind: "blocked", url, reason: `${url.hostname} is not localhost, private LAN, or in opencode.remote.rag.allowedHosts` }
}

export function createHttpEmbeddingProvider(settings: RagSettings, apiKey?: string, diagnostics?: RagHttpDiagnostics): EmbeddingProvider | undefined {
  if (!settings.embedding.endpoint) return undefined
  if (settings.embedding.configError) throw new Error(settings.embedding.configError)
  const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
  if (!policy.ok || !policy.url) throw new Error(policy.reason ?? "embedding endpoint is not allowed")
  return {
    id: `http:${policy.kind}:${policy.url.host}`,
    model: settings.embedding.model,
    async embed(input, signal) {
      if (input.length === 0) return []
      const batchSize = Math.max(1, settings.embedding.batchSize)
      const estimatedTokens = input.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0)
      const requestBody = {
        model: settings.embedding.model || undefined,
        input,
      }
      const diagnosticBase = {
        kind: "embedding" as const,
        model: settings.embedding.model || undefined,
        inputCount: input.length,
        batchSize,
        estimatedTokens,
      }
      const response = await fetchJsonWithTimeout(policy.url!, requestBody, settings.embedding.timeoutMs, diagnosticBase, signal, apiKey, diagnostics)
      const normalizeStarted = Date.now()
      const embeddings = normalizeEmbeddingResponse(response, input.length)
      emitRagHttpDiagnostic(diagnostics, {
        method: "POST",
        endpoint: policy.url!.toString(),
        timeoutMs: settings.embedding.timeoutMs,
        authorizationPresent: Boolean(apiKey?.trim()),
        apiKeyFingerprint: apiKeyFingerprint(apiKey),
        ...diagnosticBase,
        phase: "normalize",
        normalizeElapsedMs: Date.now() - normalizeStarted,
      })
      return embeddings
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
      return normalizeRerankResponse(response, input.documents.length)
    },
  }
}

export function normalizeEmbeddingResponse(input: unknown, expected: number): number[][] {
  const root = objectRecord(input)
  const data = Array.isArray(root.data) ? root.data : Array.isArray(input) ? input : []
  const rows = data
    .map((item) => {
      if (Array.isArray(item)) return item
      const record = objectRecord(item)
      return Array.isArray(record.embedding) ? record.embedding : undefined
    })
    .filter((item): item is unknown[] => Array.isArray(item))
    .map((item) => item.map((value) => Number(value)))
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

async function fetchJsonWithTimeout(
  url: URL,
  body: unknown,
  timeoutMs: number,
  detail: Pick<RagHttpDiagnosticEvent, "kind" | "model" | "estimatedTokens" | "inputCount" | "batchSize" | "documentCount" | "topN">,
  signal?: AbortSignal,
  apiKey?: string,
  diagnostics?: RagHttpDiagnostics,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
    return parsed
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
