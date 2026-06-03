import * as crypto from "node:crypto"
import { moduleKey, shardKeyForPath } from "./codegraph-index"
import { RagHttpError } from "./rag-provider"
import type { CodeGraphFile, CodeGraphIndex } from "./codegraph-types"
import type { StateMachine } from "./analysis-types"
import type { EmbeddingProvider, RagChunk, RagVectorIndex, RagVectorSearchHit, RagVectorShard } from "./rag-types"
import type { RagIndexPausedReason, RagResumeReason } from "./types"

export class RagIndexAbortError extends Error {
  constructor(message = "RAG vector index build aborted.") {
    super(message)
    this.name = "RagIndexAbortError"
  }
}

export type RagSerializedManifest = {
  version: 1
  rootPath: string
  updatedAt: number
  sourceIndexUpdatedAt?: number
  provider: string
  model: string
  dimension: number
  chunks: number
  totalChunks?: number
  pendingChunks?: number
  indexAvailability?: "partial" | "ready" | "paused"
  indexPausedReason?: RagIndexPausedReason
  lastError?: string
  nextResumeAt?: number
  resumeDelayMs?: number
  resumeReason?: RagResumeReason
  shards: { key: string; chunks: number; metadataPath: string; vectorsPath: string }[]
}

export type RagSerializedShardMetadata = {
  version: 1
  key: string
  dimension: number
  chunks: RagChunk[]
}

export type RagIndexBuildProgress =
  | {
    phase: "batch"
    batchIndex: number
    batchCount: number
    requestNumber: number
    requestLimit: number
    inputCount: number
  }
  | {
    phase: "delay"
    delayMs: number
  }
  | {
    phase: "rate-limit"
    status: number
    retryAfterMs?: number
    retry: number
    maxRetries: number
    delayMs: number
  }
  | {
    phase: "paused"
    reason: RagIndexPausedReason
    requestsUsed: number
    requestLimit: number
    message?: string
  }

export async function buildRagVectorIndex(input: {
  index: CodeGraphIndex
  provider: EmbeddingProvider
  stateMachines?: StateMachine[]
  previous?: RagVectorIndex
  changedPaths?: string[]
  sourceIndexUpdatedAt?: number
  signal?: AbortSignal
  batchSize?: number
  requestDelayMs?: number
  maxRequestsPerRun?: number
  maxRetries?: number
  retryBackoffMs?: number
  resumeMissing?: boolean
  sleep?: (ms: number) => Promise<void>
  onProgress?: (event: RagIndexBuildProgress) => void
  onIndexUpdate?: (index: RagVectorIndex) => Promise<void>
}): Promise<RagVectorIndex> {
  throwIfAborted(input.signal)
  const chunks = buildRagChunks(input.index, input.stateMachines ?? [])
  const changed = input.changedPaths ? new Set(input.changedPaths.map(normalizePath)) : undefined
  const resumeMissing = input.resumeMissing ?? true
  const previousById = new Map<string, { chunk: RagChunk; vector: number[] }>()
  if (input.previous && input.previous.dimension > 0 && input.previous.provider === input.provider.id && input.previous.model === input.provider.model) {
    for (let index = 0; index < input.previous.chunks.length; index++) {
      const chunk = input.previous.chunks[index]
      if (!changed || !changed.has(normalizePath(chunk.path))) previousById.set(chunk.id, { chunk, vector: input.previous.vectors[index] })
    }
  }

  const nextChunks: RagChunk[] = []
  const vectors: number[][] = []
  const pending: RagChunk[] = []
  for (const chunk of chunks) {
    const existing = previousById.get(chunk.id)
    if (existing) {
      nextChunks.push(existing.chunk)
      vectors.push(existing.vector)
    } else {
      const isChanged = !changed || changed.has(normalizePath(chunk.path))
      if (isChanged || resumeMissing) pending.push(chunk)
    }
  }

  let requestsUsed = 0
  let pausedReason: RagIndexPausedReason | undefined
  let lastError: string | undefined
  let resumeDelayMs: number | undefined
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? Number.MAX_SAFE_INTEGER))
  const requestLimit = Math.max(0, Math.floor(input.maxRequestsPerRun ?? 0))
  const maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 0))
  const retryBackoffMs = Math.max(0, Math.floor(input.retryBackoffMs ?? 0))
  const requestDelayMs = Math.max(0, Math.floor(input.requestDelayMs ?? 0))
  const sleep = input.sleep ?? delay
  const batchCount = Math.ceil(pending.length / batchSize)

  if (pending.length > 0) {
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      throwIfAborted(input.signal)
      if (requestLimit > 0 && requestsUsed >= requestLimit) {
        pausedReason = "request-budget"
        input.onProgress?.({
          phase: "paused",
          reason: pausedReason,
          requestsUsed,
          requestLimit,
          message: "request budget reached",
        })
        break
      }

      const batch = pending.slice(offset, offset + batchSize)
      const batchIndex = Math.floor(offset / batchSize) + 1
      const embedded = await embedBatchWithRetry({
        provider: input.provider,
        batch,
        signal: input.signal,
        requestLimit,
        maxRetries,
        retryBackoffMs,
        sleep,
        onBeforeRequest: () => {
          if (requestLimit > 0 && requestsUsed >= requestLimit) return false
          requestsUsed += 1
          input.onProgress?.({
            phase: "batch",
            batchIndex,
            batchCount,
            requestNumber: requestsUsed,
            requestLimit,
            inputCount: batch.length,
          })
          return true
        },
        onRateLimit: (event) => input.onProgress?.(event),
      })
      throwIfAborted(input.signal)

      if (embedded.pausedReason) {
        pausedReason = embedded.pausedReason
        lastError = embedded.lastError
        resumeDelayMs = embedded.resumeDelayMs
        input.onProgress?.({
          phase: "paused",
          reason: pausedReason,
          requestsUsed,
          requestLimit,
          message: lastError,
        })
        break
      }

      if (embedded.vectors.length !== batch.length) {
        pausedReason = "provider-error"
        lastError = `embedding provider returned ${embedded.vectors.length} vector(s), expected ${batch.length}`
        input.onProgress?.({
          phase: "paused",
          reason: pausedReason,
          requestsUsed,
          requestLimit,
          message: lastError,
        })
        break
      }
      throwIfAborted(input.signal)
      for (let index = 0; index < batch.length; index++) {
        nextChunks.push(batch[index])
        vectors.push(normalizeVector(embedded.vectors[index]))
      }
      throwIfAborted(input.signal)
      await input.onIndexUpdate?.(createVectorIndex({
        rootPath: input.index.rootPath,
        provider: input.provider,
        sourceIndexUpdatedAt: input.sourceIndexUpdatedAt ?? input.index.updatedAt,
        chunks,
        nextChunks,
        vectors,
        pausedReason,
        lastError,
        resumeDelayMs,
        requestsUsed,
      }))

      const hasMore = offset + batchSize < pending.length
      if (hasMore && requestDelayMs > 0 && (requestLimit <= 0 || requestsUsed < requestLimit)) {
        input.onProgress?.({ phase: "delay", delayMs: requestDelayMs })
        await sleepWithAbort(requestDelayMs, input.signal, sleep)
      }
    }
  }

  throwIfAborted(input.signal)
  const dimension = vectors[0]?.length ?? 0
  if (dimension > 0 && vectors.some((vector) => vector.length !== dimension)) throw new Error("RAG vectors have inconsistent dimensions")
  return createVectorIndex({
    rootPath: input.index.rootPath,
    provider: input.provider,
    sourceIndexUpdatedAt: input.sourceIndexUpdatedAt ?? input.index.updatedAt,
    chunks,
    nextChunks,
    vectors,
    pausedReason,
    lastError,
    resumeDelayMs,
    requestsUsed,
  })
}

export function buildRagChunks(index: CodeGraphIndex, stateMachines: StateMachine[] = []): RagChunk[] {
  const chunks: RagChunk[] = []
  for (const file of Object.values(index.files)) {
    chunks.push(...functionChunks(file))
    chunks.push(fileSummaryChunk(file))
    if (file.functions.length === 0) chunks.push(...textWindowChunks(file))
  }
  chunks.push(...moduleSummaryChunks(index))
  chunks.push(...stateMachines.flatMap(stateMachineChunks))
  return dedupeChunks(chunks)
}

export function searchRagVectorIndex(index: RagVectorIndex, queryVector: number[], topK: number): RagVectorSearchHit[] {
  if (topK <= 0 || index.dimension <= 0 || queryVector.length !== index.dimension) return []
  const normalizedQuery = normalizeVector(queryVector)
  return index.chunks
    .map((chunk, row) => ({ chunk, score: cosine(normalizedQuery, index.vectors[row]) }))
    .filter((hit) => Number.isFinite(hit.score))
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path))
    .slice(0, topK)
}

export function evidenceFromRagHit(hit: RagVectorSearchHit) {
  return {
    path: hit.chunk.path,
    startLine: hit.chunk.startLine,
    endLine: hit.chunk.endLine,
    kind: "text" as const,
    score: 120 + hit.score * 90,
    reason: `vector:${hit.chunk.kind}:${hit.score.toFixed(3)}`,
    snippet: hit.chunk.text,
  }
}

export function splitRagVectorIndex(index: RagVectorIndex): RagVectorShard[] {
  const byShard = new Map<string, RagVectorShard>()
  for (let row = 0; row < index.chunks.length; row++) {
    const chunk = index.chunks[row]
    const shard = byShard.get(chunk.shard) ?? { key: chunk.shard, chunks: [], vectors: [] }
    shard.chunks.push(chunk)
    shard.vectors.push(index.vectors[row])
    byShard.set(chunk.shard, shard)
  }
  return [...byShard.values()].sort((left, right) => left.key.localeCompare(right.key))
}

export function createRagSerializedManifest(index: RagVectorIndex): RagSerializedManifest {
  const totalChunks = index.totalChunks ?? index.chunks.length
  const pendingChunks = Math.max(0, index.pendingChunkCount ?? totalChunks - index.chunks.length)
  return {
    version: 1,
    rootPath: index.rootPath,
    updatedAt: index.updatedAt,
    sourceIndexUpdatedAt: index.sourceIndexUpdatedAt,
    provider: index.provider,
    model: index.model,
    dimension: index.dimension,
    chunks: index.chunks.length,
    totalChunks,
    pendingChunks,
    indexAvailability: pendingChunks > 0 ? index.indexPausedReason ? "paused" : "partial" : "ready",
    indexPausedReason: index.indexPausedReason,
    lastError: index.lastError,
    nextResumeAt: index.nextResumeAt,
    resumeDelayMs: index.resumeDelayMs,
    resumeReason: index.resumeReason,
    shards: splitRagVectorIndex(index).map((shard) => ({
      key: shard.key,
      chunks: shard.chunks.length,
      metadataPath: `shards/${shard.key}.json`,
      vectorsPath: `shards/${shard.key}.f32`,
    })),
  }
}

export function encodeRagShardVectors(vectors: number[][], dimension: number): Uint8Array {
  const array = new Float32Array(vectors.length * dimension)
  for (let row = 0; row < vectors.length; row++) {
    const vector = vectors[row]
    if (vector.length !== dimension) throw new Error("Cannot encode RAG shard with inconsistent vector dimensions.")
    array.set(vector, row * dimension)
  }
  return new Uint8Array(array.buffer)
}

export function decodeRagShardVectors(bytes: Uint8Array, dimension: number): number[][] {
  if (dimension <= 0) return []
  const array = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const rows = Math.floor(array.length / dimension)
  const vectors: number[][] = []
  for (let row = 0; row < rows; row++) {
    vectors.push(Array.from(array.slice(row * dimension, row * dimension + dimension)))
  }
  return vectors
}

function createVectorIndex(input: {
  rootPath: string
  provider: EmbeddingProvider
  sourceIndexUpdatedAt?: number
  chunks: RagChunk[]
  nextChunks: RagChunk[]
  vectors: number[][]
  pausedReason?: RagIndexPausedReason
  lastError?: string
  resumeDelayMs?: number
  requestsUsed: number
}): RagVectorIndex {
  const dimension = input.vectors[0]?.length ?? 0
  return {
    version: 1,
    rootPath: input.rootPath,
    updatedAt: Date.now(),
    sourceIndexUpdatedAt: input.sourceIndexUpdatedAt,
    provider: input.provider.id,
    model: input.provider.model,
    dimension,
    chunks: [...input.nextChunks],
    vectors: input.vectors.map((vector) => [...vector]),
    totalChunks: input.chunks.length,
    pendingChunkCount: Math.max(0, input.chunks.length - input.nextChunks.length),
    indexPausedReason: input.pausedReason,
    lastError: input.lastError,
    requestsUsed: input.requestsUsed,
    resumeDelayMs: input.resumeDelayMs,
    resumeReason: input.pausedReason === "request-budget" || input.pausedReason === "rate-limit" ? input.pausedReason : undefined,
  }
}

async function embedBatchWithRetry(input: {
  provider: EmbeddingProvider
  batch: RagChunk[]
  signal?: AbortSignal
  requestLimit: number
  maxRetries: number
  retryBackoffMs: number
  sleep: (ms: number) => Promise<void>
  onBeforeRequest: () => boolean
  onRateLimit: (event: Extract<RagIndexBuildProgress, { phase: "rate-limit" }>) => void
}): Promise<{ vectors: number[][]; pausedReason?: RagIndexPausedReason; lastError?: string; resumeDelayMs?: number }> {
  for (let retry = 0; retry <= input.maxRetries; retry++) {
    throwIfAborted(input.signal)
    if (!input.onBeforeRequest()) {
      return { vectors: [], pausedReason: "request-budget", lastError: "request budget reached" }
    }
    try {
      const vectors = await input.provider.embed(input.batch.map((chunk) => chunk.text), input.signal)
      throwIfAborted(input.signal)
      return { vectors }
    } catch (error) {
      if (isAbortError(error, input.signal)) throw new RagIndexAbortError()
      const message = error instanceof Error ? error.message : String(error)
      const retryable = retryableRagError(error)
      if (!retryable) return { vectors: [], pausedReason: "provider-error", lastError: message }
      if (retry >= input.maxRetries) return { vectors: [], pausedReason: "rate-limit", lastError: message, resumeDelayMs: retryable.retryAfterMs }
      const delayMs = retryable.retryAfterMs ?? input.retryBackoffMs * 2 ** retry
      input.onRateLimit({
        phase: "rate-limit",
        status: retryable.status,
        retryAfterMs: retryable.retryAfterMs,
        retry: retry + 1,
        maxRetries: input.maxRetries,
        delayMs,
      })
      if (delayMs > 0) await sleepWithAbort(delayMs, input.signal, input.sleep)
    }
  }
  return { vectors: [], pausedReason: "provider-error", lastError: "embedding provider did not return vectors" }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RagIndexAbortError()
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(
    signal?.aborted
      || error instanceof RagIndexAbortError
      || (error instanceof Error && error.name === "AbortError"),
  )
}

async function sleepWithAbort(ms: number, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>) {
  throwIfAborted(signal)
  if (ms <= 0) return
  if (!signal) {
    await sleep(ms)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(new RagIndexAbortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
  throwIfAborted(signal)
}

function retryableRagError(error: unknown) {
  if (error instanceof RagHttpError && (error.status === 429 || error.status === 503)) {
    return { status: error.status, retryAfterMs: error.retryAfterMs }
  }
  return undefined
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function functionChunks(file: CodeGraphFile): RagChunk[] {
  return file.functions.map((fn) => chunk({
    kind: "function",
    path: file.path,
    startLine: fn.startLine,
    endLine: fn.endLine,
    sourceHash: file.sha256 ?? file.hash,
    text: [fn.signature, fn.snippet].filter(Boolean).join("\n"),
  }))
}

function fileSummaryChunk(file: CodeGraphFile): RagChunk {
  const symbols = [
    ...file.functions.map((fn) => fn.name),
    ...file.types.map((type) => type.name),
    ...file.macros.map((macro) => macro.name),
    ...file.globals.map((global) => global.name),
  ].slice(0, 80)
  const ast = file.astSummary ? `switches=${file.astSummary.switchStatements} ifs=${file.astSummary.ifStatements} assignments=${file.astSummary.assignments}` : ""
  return chunk({
    kind: "file-summary",
    path: file.path,
    startLine: 1,
    endLine: 1,
    sourceHash: file.sha256 ?? file.hash,
    text: `file ${file.path} language=${file.language} symbols=${symbols.join(", ")} includes=${file.includes.map((item) => item.target).join(", ")} ${ast}`,
  })
}

function textWindowChunks(file: CodeGraphFile): RagChunk[] {
  const snippets = [
    ...file.types.map((type) => type.snippet),
    ...file.macros.map((macro) => macro.snippet ?? macro.name),
    ...file.globals.map((global) => global.snippet),
    ...file.tokens.slice(0, 80).map((token) => `${token.kind}:${token.term}`),
  ].filter(Boolean)
  if (snippets.length === 0) return []
  return [chunk({
    kind: "text-window",
    path: file.path,
    startLine: 1,
    endLine: Math.max(1, Math.max(...file.tokens.map((token) => token.line), 1)),
    sourceHash: file.sha256 ?? file.hash,
    text: snippets.join("\n"),
  })]
}

function moduleSummaryChunks(index: CodeGraphIndex): RagChunk[] {
  const modules = new Map<string, CodeGraphFile[]>()
  for (const file of Object.values(index.files)) {
    const key = moduleKey(file.path)
    const rows = modules.get(key) ?? []
    rows.push(file)
    modules.set(key, rows)
  }
  return [...modules.entries()].map(([module, files]) => chunk({
    kind: "module-summary",
    path: module,
    startLine: 1,
    endLine: 1,
    sourceHash: hashText(files.map((file) => `${file.path}:${file.sha256 ?? file.hash}`).join("|")),
    text: `module ${module}: files=${files.length} functions=${files.reduce((sum, file) => sum + file.functions.length, 0)} symbols=${files.flatMap((file) => file.functions.map((fn) => fn.name)).slice(0, 80).join(", ")}`,
  }))
}

function chunk(input: {
  kind: RagChunk["kind"]
  path: string
  startLine: number
  endLine: number
  sourceHash: string
  text: string
}): RagChunk {
  const path = normalizePath(input.path)
  const id = hashText([input.kind, path, input.startLine, input.endLine, input.sourceHash].join(":"))
  return {
    id,
    kind: input.kind,
    path,
    module: moduleKey(path),
    shard: shardKeyForPath(path),
    startLine: input.startLine,
    endLine: input.endLine,
    sourceHash: input.sourceHash,
    text: limitText(input.text.trim(), 3000),
  }
}

function stateMachineChunks(machine: StateMachine): RagChunk[] {
  return machine.transitions.map((transition) => chunk({
    kind: "state-transition",
    path: transition.evidence.file,
    startLine: transition.evidence.startLine,
    endLine: transition.evidence.endLine,
    sourceHash: transition.evidence.snippetHash,
    text: `state machine ${machine.name} ${transition.fromState} -> ${transition.toState} event=${transition.event ?? ""} guard=${transition.guard ?? ""} action=${transition.action ?? ""}\n${transition.evidence.snippet ?? ""}`,
  }))
}

function dedupeChunks(chunks: RagChunk[]) {
  const seen = new Set<string>()
  const result: RagChunk[] = []
  for (const item of chunks) {
    if (!item.text || seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

function cosine(left: number[], right: number[]) {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY
  let dot = 0
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index]
  return dot
}

function normalizeVector(vector: number[]) {
  const values = vector.map(Number)
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!norm || !Number.isFinite(norm)) throw new Error("Cannot normalize an empty or invalid embedding vector.")
  return values.map((value) => value / norm)
}

function hashText(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex")
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/")
}

function limitText(text: string, maxChars: number) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n<truncated>true</truncated>`
}
