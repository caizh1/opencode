import * as net from "node:net"
import type { EmbeddingProvider, RagEndpointPolicyResult, RerankProvider, RerankResult } from "./rag-types"
import type { RagSettings } from "./types"

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

export function createHttpEmbeddingProvider(settings: RagSettings): EmbeddingProvider | undefined {
  if (!settings.embedding.enabled || !settings.embedding.endpoint) return undefined
  const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
  if (!policy.ok || !policy.url) throw new Error(policy.reason ?? "embedding endpoint is not allowed")
  return {
    id: `http:${policy.kind}:${policy.url.host}`,
    model: settings.embedding.model,
    async embed(input, signal) {
      const vectors: number[][] = []
      const batchSize = Math.max(1, settings.embedding.batchSize)
      for (let offset = 0; offset < input.length; offset += batchSize) {
        const batch = input.slice(offset, offset + batchSize)
        const response = await fetchJsonWithTimeout(policy.url!, {
          model: settings.embedding.model || undefined,
          input: batch,
        }, settings.embedding.timeoutMs, signal)
        const embeddings = normalizeEmbeddingResponse(response, batch.length)
        vectors.push(...embeddings)
      }
      return vectors
    },
  }
}

export function createHttpRerankProvider(settings: RagSettings): RerankProvider | undefined {
  if (!settings.rerank.enabled || !settings.rerank.endpoint) return undefined
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
      }, settings.embedding.timeoutMs, input.signal)
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

async function fetchJsonWithTimeout(url: URL, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
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
