import * as crypto from "node:crypto"
import { moduleKey, shardKeyForPath } from "./codegraph-index"
import { RagHttpError } from "./rag-provider"
import { estimateEmbeddingTokens } from "./rag-token"
import type { CodeGraphFile, CodeGraphIndex } from "./codegraph-types"
import type { StateMachine } from "./analysis-types"
import type { EmbeddingProvider, RagChunk, RagIndexLifecycleState, RagVectorIndex, RagVectorSearchHit, RagVectorShard } from "./rag-types"
import type { RagIndexPausedReason, RagResumeReason, RagWorkerStatus } from "./types"

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
  buildElapsedMs?: number
  workerStatus?: RagWorkerStatus
  indexAvailability?: "partial" | "ready" | "paused"
  indexPausedReason?: RagIndexPausedReason
  lastError?: string
  nextResumeAt?: number
  resumeDelayMs?: number
  resumeReason?: RagResumeReason
  extensionVersion?: string
  buildId?: string
  state?: RagIndexLifecycleState
  completed?: boolean
  staleReason?: string
  buildStartedAt?: number
  buildFinishedAt?: number
  shards: { key: string; chunks: number; metadataPath: string; vectorsPath: string }[]
}

export type RagManifestLifecycleMetadata = Pick<
  RagVectorIndex,
  "extensionVersion" | "buildId" | "state" | "completed" | "staleReason" | "buildStartedAt" | "buildFinishedAt"
>

export type RagSerializedShardMetadata = {
  version: 1
  key: string
  dimension: number
  chunks: RagChunk[]
}

type RagIndexBuildProgressCounts = {
  embeddedChunks: number
  chunks: number
  pendingChunkCount: number
}

type RagIndexBuildProgressTelemetry = {
  elapsedMs: number
  workerStatus: RagWorkerStatus
}

type RagRateLimitProgressInput = Omit<Extract<RagIndexBuildProgress, { phase: "rate-limit" }>, keyof RagIndexBuildProgressCounts | keyof RagIndexBuildProgressTelemetry>

type RagChunkEmbeddingItem = {
  chunk: RagChunk
  chunkIndex: number
}

type PlannedEmbeddingBatch = {
  batchIndex: number
  items: RagChunkEmbeddingItem[]
  chunks: RagChunk[]
  estimatedTokens: number
}

type RunningEmbeddingJob = {
  job: PlannedEmbeddingBatch
  promise: Promise<EmbeddingJobOutcome>
}

type EmbeddingJobOutcome = {
  running: RunningEmbeddingJob
  job: PlannedEmbeddingBatch
  requestNumber: number
  embedded: EmbeddingBatchWithRetryResult
}

type EmbeddingBatchWithRetryResult = {
  vectors: number[][]
  embeddingElapsedMs: number
  retries: number
  rateLimits: number
  timeouts: number
  responseBytes?: number
  effectiveEncodingFormat?: "float" | "base64"
  pausedReason?: RagIndexPausedReason
  lastError?: string
  resumeDelayMs?: number
}

export type RagIndexBatchProfile = RagIndexBuildProgressCounts & {
  batchIndex: number
  batchCount: number
  requestNumber: number
  inputCount: number
  estimatedTokens: number
  embeddingElapsedMs: number
  vectorNormalizeElapsedMs: number
  checkpointElapsedMs?: number
  batchStatus: "success" | "retry" | "paused" | "failed"
  configuredConcurrency: number
  activeConcurrency: number
  adaptiveCeiling: number
  inFlightRequests: number
  inFlightEstimatedTokens: number
  queuePending: number
  retries: number
  rateLimits: number
  timeouts: number
  elapsedMs: number
  workerStatus: RagWorkerStatus
  responseBytes?: number
  effectiveEncodingFormat?: "float" | "base64"
}

export type RagIndexBuildSummary = {
  wallElapsedMs: number
  requestElapsedMsTotal: number
  requestElapsedMsP50: number
  requestElapsedMsP95: number
  responseBytesTotal: number
  retries: number
  rateLimits: number
  timeouts: number
  effectiveConcurrency: number
  chunksPerMinute: number
  tokensPerMinute: number
  configuredConcurrency: number
  adaptiveCeiling: number
  buildElapsedMs: number
  workerStatus: RagWorkerStatus
}

export type RagIndexBuildProgress = (
  | {
    phase: "batch"
    batchIndex: number
    batchCount: number
    requestNumber: number
    requestLimit: number
    inputCount: number
    estimatedTokens: number
    activeConcurrency?: number
    adaptiveCeiling?: number
    inFlightRequests?: number
    inFlightEstimatedTokens?: number
    queuePending?: number
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
) & RagIndexBuildProgressCounts
  & RagIndexBuildProgressTelemetry

export async function buildRagVectorIndex(input: {
  index: CodeGraphIndex
  provider: EmbeddingProvider
  stateMachines?: StateMachine[]
  previous?: RagVectorIndex
  changedPaths?: string[]
  sourceIndexUpdatedAt?: number
  signal?: AbortSignal
  batchSize?: number
  maxTokensPerRequest?: number
  concurrentRequests?: number
  maxInFlightTokens?: number
  requestDelayMs?: number
  maxRequestsPerRun?: number
  maxRetries?: number
  retryBackoffMs?: number
  initialElapsedMs?: number
  resumeMissing?: boolean
  sleep?: (ms: number) => Promise<void>
  onProgress?: (event: RagIndexBuildProgress) => void
  onBatchProfile?: (event: RagIndexBatchProfile) => void
  onBuildSummary?: (event: RagIndexBuildSummary) => void
  onIndexUpdate?: (index: RagVectorIndex) => Promise<void>
  checkpointChunkInterval?: number
  checkpointIntervalMs?: number
}): Promise<RagVectorIndex> {
  const buildStarted = Date.now()
  throwIfAborted(input.signal)
  const chunks = buildRagChunks(input.index, input.stateMachines ?? [])
  const changed = input.changedPaths ? new Set(input.changedPaths.map(normalizePath)) : undefined
  const resumeMissing = input.resumeMissing ?? true
  const previousById = new Map<string, { chunk: RagChunk; vector: number[] }>()
  const providerDimension = input.provider.dimension && input.provider.dimension > 0 ? input.provider.dimension : undefined
  if (
    input.previous
    && input.previous.dimension > 0
    && input.previous.provider === input.provider.id
    && input.previous.model === input.provider.model
    && (!providerDimension || input.previous.dimension === providerDimension)
  ) {
    for (let index = 0; index < input.previous.chunks.length; index++) {
      const chunk = input.previous.chunks[index]
      if (!changed || !changed.has(normalizePath(chunk.path))) previousById.set(chunk.id, { chunk, vector: input.previous.vectors[index] })
    }
  }

  const chunkSlots = new Array<RagChunk | undefined>(chunks.length)
  const vectorSlots = new Array<number[] | undefined>(chunks.length)
  const pending: RagChunkEmbeddingItem[] = []
  let completedChunks = 0
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]
    const existing = previousById.get(chunk.id)
    if (existing) {
      chunkSlots[chunkIndex] = existing.chunk
      vectorSlots[chunkIndex] = existing.vector
      completedChunks += 1
    } else {
      const isChanged = !changed || changed.has(normalizePath(chunk.path))
      if (isChanged || resumeMissing) pending.push({ chunk, chunkIndex })
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
  const maxTokensPerRequest = Math.max(0, Math.floor(input.maxTokensPerRequest ?? 0))
  const configuredConcurrency = clampInteger(input.concurrentRequests ?? 3, 1, 4)
  const adaptiveCeiling = Math.min(4, configuredConcurrency + 1)
  let activeConcurrency = configuredConcurrency
  const maxInFlightTokens = Math.max(0, Math.floor(input.maxInFlightTokens ?? 0))
  const checkpointChunkInterval = Math.max(0, Math.floor(input.checkpointChunkInterval ?? 0))
  const checkpointIntervalMs = Math.max(0, Math.floor(input.checkpointIntervalMs ?? 0))
  const sleep = input.sleep ?? delay
  const batches = planEmbeddingBatches(pending, batchSize, maxTokensPerRequest)
  const batchCount = batches.length
  let lastCheckpointChunks = completedChunks
  let lastCheckpointAt = Date.now()
  let nextJobOffset = 0
  let inFlightEstimatedTokens = 0
  let cleanSuccesses = 0
  const active = new Set<RunningEmbeddingJob>()
  const requestElapsedSamples: number[] = []
  let responseBytesTotal = 0
  let retries = 0
  let rateLimits = 0
  let timeouts = 0
  let embeddedTokens = 0
  let lastWorkerChange: RagWorkerStatus["lastChange"]
  const initialElapsedMs = Math.max(0, Math.floor(input.initialElapsedMs ?? 0))
  const currentElapsedMs = () => initialElapsedMs + Math.max(0, Date.now() - buildStarted)
  const currentWorkerStatus = (state: { inFlightRequests?: number; queuePending?: number } = {}): RagWorkerStatus => ({
    configuredWorkers: configuredConcurrency,
    activeWorkers: activeConcurrency,
    maxWorkers: adaptiveCeiling,
    inFlightRequests: state.inFlightRequests ?? active.size,
    queuePending: state.queuePending ?? Math.max(0, batches.length - nextJobOffset),
    lastChange: lastWorkerChange ? { ...lastWorkerChange } : undefined,
  })
  const progressTelemetry = (state?: { inFlightRequests?: number; queuePending?: number }): RagIndexBuildProgressTelemetry => ({
    elapsedMs: currentElapsedMs(),
    workerStatus: currentWorkerStatus(state),
  })
  const recordWorkerChange = (direction: "upgrade" | "degrade", fromWorkers: number, toWorkers: number, reason: string) => {
    if (fromWorkers === toWorkers) return
    lastWorkerChange = {
      direction,
      fromWorkers,
      toWorkers,
      reason,
      at: Date.now(),
    }
  }

  const compact = () => compactVectorSlots(chunkSlots, vectorSlots)
  const buildPartialIndex = (cloneVectorValues: boolean) => {
    const compacted = compact()
    return createVectorIndex({
      rootPath: input.index.rootPath,
      provider: input.provider,
      sourceIndexUpdatedAt: input.sourceIndexUpdatedAt ?? input.index.updatedAt,
      chunks,
      nextChunks: compacted.nextChunks,
      vectors: compacted.vectors,
      pausedReason,
      lastError,
      resumeDelayMs,
      requestsUsed,
      buildElapsedMs: currentElapsedMs(),
      workerStatus: currentWorkerStatus(),
      cloneVectorValues,
    })
  }
  const setPaused = (reason: RagIndexPausedReason, message?: string, delayMs?: number) => {
    if (pausedReason) return
    pausedReason = reason
    lastError = message
    resumeDelayMs = delayMs
    input.onProgress?.({
      phase: "paused",
      reason,
      requestsUsed,
      requestLimit,
      message,
      ...progressCounts(chunks.length, completedChunks),
      ...progressTelemetry(),
    })
  }
  const canStartNextJob = () => {
    if (pausedReason || nextJobOffset >= batches.length) return false
    if (requestLimit > 0 && requestsUsed >= requestLimit) return false
    if (active.size >= activeConcurrency) return false
    const next = batches[nextJobOffset]
    if (maxInFlightTokens > 0 && active.size > 0 && inFlightEstimatedTokens + next.estimatedTokens > maxInFlightTokens) return false
    return true
  }
  const startJob = () => {
    const job = batches[nextJobOffset]
    nextJobOffset += 1
    inFlightEstimatedTokens += job.estimatedTokens
    const running: RunningEmbeddingJob = {
      job,
      promise: undefined as unknown as Promise<EmbeddingJobOutcome>,
    }
    running.promise = runEmbeddingJob({
      provider: input.provider,
      job,
      signal: input.signal,
      requestLimit,
      maxRetries,
      retryBackoffMs,
      sleep,
      onBeforeRequest: () => {
        if (requestLimit > 0 && requestsUsed >= requestLimit) return undefined
        requestsUsed += 1
        input.onProgress?.({
          phase: "batch",
          batchIndex: job.batchIndex,
          batchCount,
          requestNumber: requestsUsed,
          requestLimit,
          inputCount: job.chunks.length,
          estimatedTokens: job.estimatedTokens,
          activeConcurrency,
          adaptiveCeiling,
          inFlightRequests: active.size + 1,
          inFlightEstimatedTokens,
          queuePending: batches.length - nextJobOffset,
          ...progressCounts(chunks.length, completedChunks),
          ...progressTelemetry({
            inFlightRequests: active.size + 1,
            queuePending: batches.length - nextJobOffset,
          }),
        })
        return requestsUsed
      },
      onRateLimit: (event) => input.onProgress?.({
        ...event,
        ...progressCounts(chunks.length, completedChunks),
        ...progressTelemetry(),
      }),
      running,
    })
    active.add(running)
  }

  while (nextJobOffset < batches.length || active.size > 0) {
    throwIfAborted(input.signal)
    while (canStartNextJob()) {
      if (requestDelayMs > 0 && requestsUsed > 0) {
        input.onProgress?.({
          phase: "delay",
          delayMs: requestDelayMs,
          ...progressCounts(chunks.length, completedChunks),
          ...progressTelemetry(),
        })
        await sleepWithAbort(requestDelayMs, input.signal, sleep)
        throwIfAborted(input.signal)
        if (!canStartNextJob()) break
      }
      startJob()
    }

    if (!pausedReason && nextJobOffset < batches.length && active.size === 0 && requestLimit > 0 && requestsUsed >= requestLimit) {
      setPaused("request-budget", "request budget reached")
      break
    }
    if (active.size === 0) break

    const outcome = await Promise.race([...active].map((item) => item.promise))
    active.delete(outcome.running)
    inFlightEstimatedTokens = Math.max(0, inFlightEstimatedTokens - outcome.running.job.estimatedTokens)
    throwIfAborted(input.signal)

    const embedded = outcome.embedded
    retries += embedded.retries
    rateLimits += embedded.rateLimits
    timeouts += embedded.timeouts
    if (embedded.responseBytes !== undefined) responseBytesTotal += embedded.responseBytes
    requestElapsedSamples.push(embedded.embeddingElapsedMs)
    if (embedded.retries > 0 || embedded.rateLimits > 0 || embedded.timeouts > 0) {
      cleanSuccesses = 0
      const previousConcurrency = activeConcurrency
      activeConcurrency = Math.max(1, activeConcurrency - 1)
      recordWorkerChange("degrade", previousConcurrency, activeConcurrency, workerPressureReason(embedded))
    }

    const profileBase = {
      batchIndex: outcome.job.batchIndex,
      batchCount,
      requestNumber: outcome.requestNumber,
      inputCount: outcome.job.chunks.length,
      estimatedTokens: outcome.job.estimatedTokens,
      embeddingElapsedMs: embedded.embeddingElapsedMs,
      configuredConcurrency,
      activeConcurrency,
      adaptiveCeiling,
      inFlightRequests: active.size,
      inFlightEstimatedTokens,
      queuePending: batches.length - nextJobOffset,
      retries: embedded.retries,
      rateLimits: embedded.rateLimits,
      timeouts: embedded.timeouts,
      elapsedMs: currentElapsedMs(),
      workerStatus: currentWorkerStatus({
        inFlightRequests: active.size,
        queuePending: batches.length - nextJobOffset,
      }),
      responseBytes: embedded.responseBytes,
      effectiveEncodingFormat: embedded.effectiveEncodingFormat,
    }

    if (embedded.pausedReason) {
      setPaused(embedded.pausedReason, embedded.lastError, embedded.resumeDelayMs)
      input.onBatchProfile?.({
        ...profileBase,
        batchStatus: "paused",
        vectorNormalizeElapsedMs: 0,
        ...progressCounts(chunks.length, completedChunks),
      })
      continue
    }

    if (embedded.vectors.length !== outcome.job.chunks.length) {
      setPaused("provider-error", `embedding provider returned ${embedded.vectors.length} vector(s), expected ${outcome.job.chunks.length}`)
      input.onBatchProfile?.({
        ...profileBase,
        batchStatus: "failed",
        vectorNormalizeElapsedMs: 0,
        ...progressCounts(chunks.length, completedChunks),
      })
      continue
    }

    const normalizeStarted = Date.now()
    let normalized: number[][]
    try {
      normalized = embedded.vectors.map((vector) => normalizeVector(vector))
    } catch (error) {
      setPaused("provider-error", error instanceof Error ? error.message : String(error))
      input.onBatchProfile?.({
        ...profileBase,
        batchStatus: "failed",
        vectorNormalizeElapsedMs: Date.now() - normalizeStarted,
        ...progressCounts(chunks.length, completedChunks),
      })
      continue
    }

    for (let index = 0; index < outcome.job.items.length; index++) {
      const item = outcome.job.items[index]
      chunkSlots[item.chunkIndex] = item.chunk
      vectorSlots[item.chunkIndex] = normalized[index]
    }
    completedChunks += outcome.job.items.length
    embeddedTokens += outcome.job.estimatedTokens
    const vectorNormalizeElapsedMs = Date.now() - normalizeStarted
    if (embedded.retries === 0 && embedded.rateLimits === 0 && embedded.timeouts === 0) {
      cleanSuccesses += 1
      if (cleanSuccesses >= 8 && activeConcurrency < adaptiveCeiling) {
        const previousConcurrency = activeConcurrency
        activeConcurrency += 1
        cleanSuccesses = 0
        recordWorkerChange("upgrade", previousConcurrency, activeConcurrency, "stable batches")
      }
    }

    const hasMore = nextJobOffset < batches.length || active.size > 0
    const checkpoint = shouldCheckpoint({
      hasMore,
      embeddedChunks: completedChunks,
      lastCheckpointChunks,
      lastCheckpointAt,
      checkpointChunkInterval,
      checkpointIntervalMs,
    })
    let checkpointElapsedMs: number | undefined
    if (checkpoint && input.onIndexUpdate) {
      const checkpointStarted = Date.now()
      await input.onIndexUpdate(buildPartialIndex(false))
      checkpointElapsedMs = Date.now() - checkpointStarted
      lastCheckpointChunks = completedChunks
      lastCheckpointAt = Date.now()
    }
    input.onBatchProfile?.({
      ...profileBase,
      activeConcurrency,
      elapsedMs: currentElapsedMs(),
      workerStatus: currentWorkerStatus({
        inFlightRequests: active.size,
        queuePending: batches.length - nextJobOffset,
      }),
      batchStatus: embedded.retries > 0 ? "retry" : "success",
      vectorNormalizeElapsedMs,
      checkpointElapsedMs,
      ...progressCounts(chunks.length, completedChunks),
    })
  }

  throwIfAborted(input.signal)
  const compacted = compact()
  const vectors = compacted.vectors
  const dimension = vectors[0]?.length ?? 0
  if (dimension > 0 && vectors.some((vector) => vector.length !== dimension)) throw new Error("RAG vectors have inconsistent dimensions")
  const wallElapsedMs = Date.now() - buildStarted
  const requestElapsedMsTotal = requestElapsedSamples.reduce((sum, value) => sum + value, 0)
  input.onBuildSummary?.({
    wallElapsedMs,
    requestElapsedMsTotal,
    requestElapsedMsP50: percentile(requestElapsedSamples, 0.5),
    requestElapsedMsP95: percentile(requestElapsedSamples, 0.95),
    responseBytesTotal,
    retries,
    rateLimits,
    timeouts,
    effectiveConcurrency: wallElapsedMs > 0 ? requestElapsedMsTotal / wallElapsedMs : 0,
    chunksPerMinute: wallElapsedMs > 0 ? (Math.max(0, completedChunks - previousById.size) / wallElapsedMs) * 60000 : 0,
    tokensPerMinute: wallElapsedMs > 0 ? (embeddedTokens / wallElapsedMs) * 60000 : 0,
    configuredConcurrency,
    adaptiveCeiling,
    buildElapsedMs: currentElapsedMs(),
    workerStatus: currentWorkerStatus(),
  })
  const finalIndex = buildPartialIndex(false)
  if (
    input.onIndexUpdate
    && batchCount > 0
    && !pausedReason
    && (finalIndex.pendingChunkCount ?? 0) === 0
    && finalIndex.dimension > 0
    && finalIndex.vectors.length > 0
  ) {
    await input.onIndexUpdate(finalIndex)
  }
  return finalIndex
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

export function createRagSerializedManifest(index: RagVectorIndex, metadata: Partial<RagManifestLifecycleMetadata> = {}): RagSerializedManifest {
  const totalChunks = index.totalChunks ?? index.chunks.length
  const pendingChunks = Math.max(0, index.pendingChunkCount ?? totalChunks - index.chunks.length)
  const state = metadata.state ?? index.state ?? (pendingChunks > 0 ? index.indexPausedReason ? "paused" : "building" : "ready")
  const completed = metadata.completed ?? index.completed ?? pendingChunks === 0
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
    buildElapsedMs: index.buildElapsedMs,
    workerStatus: index.workerStatus,
    indexAvailability: pendingChunks > 0 ? index.indexPausedReason ? "paused" : "partial" : "ready",
    indexPausedReason: index.indexPausedReason,
    lastError: index.lastError,
    nextResumeAt: index.nextResumeAt,
    resumeDelayMs: index.resumeDelayMs,
    resumeReason: index.resumeReason,
    extensionVersion: metadata.extensionVersion ?? index.extensionVersion,
    buildId: metadata.buildId ?? index.buildId,
    state,
    completed,
    staleReason: metadata.staleReason ?? index.staleReason,
    buildStartedAt: metadata.buildStartedAt ?? index.buildStartedAt,
    buildFinishedAt: metadata.buildFinishedAt ?? index.buildFinishedAt,
    shards: splitRagVectorIndex(index).map((shard) => ({
      key: shard.key,
      chunks: shard.chunks.length,
      metadataPath: `shards/${shard.key}.json`,
      vectorsPath: `shards/${shard.key}.f32`,
    })),
  }
}

export function ragManifestStaleReason(manifest: RagSerializedManifest, currentExtensionVersion: string): string | undefined {
  const manifestVersion = manifest.extensionVersion
  if (!manifestVersion || manifestVersion === currentExtensionVersion) return undefined
  if (ragManifestIsCompleted(manifest)) return undefined
  return `RAG partial index was created by extension ${manifestVersion}; current extension is ${currentExtensionVersion}. Rebuild RAG to avoid resuming an interrupted build across plugin versions.`
}

export function ragManifestIsCompleted(manifest: RagSerializedManifest) {
  if (manifest.completed === true || manifest.state === "ready" || manifest.indexAvailability === "ready") return true
  const totalChunks = manifest.totalChunks ?? manifest.chunks
  const pendingChunks = Math.max(0, manifest.pendingChunks ?? totalChunks - manifest.chunks)
  return pendingChunks === 0
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
  buildElapsedMs: number
  workerStatus: RagWorkerStatus
  cloneVectorValues: boolean
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
    vectors: input.cloneVectorValues ? input.vectors.map((vector) => [...vector]) : [...input.vectors],
    totalChunks: input.chunks.length,
    pendingChunkCount: Math.max(0, input.chunks.length - input.nextChunks.length),
    buildElapsedMs: input.buildElapsedMs,
    workerStatus: input.workerStatus,
    indexPausedReason: input.pausedReason,
    lastError: input.lastError,
    requestsUsed: input.requestsUsed,
    resumeDelayMs: input.resumeDelayMs,
    resumeReason: input.pausedReason === "request-budget" || input.pausedReason === "rate-limit" ? input.pausedReason : undefined,
  }
}

function planEmbeddingBatches(items: RagChunkEmbeddingItem[], maxInputs: number, maxTokensPerRequest: number): PlannedEmbeddingBatch[] {
  const batches: PlannedEmbeddingBatch[] = []
  let current: RagChunkEmbeddingItem[] = []
  let currentTokens = 0
  for (const item of items) {
    const itemTokens = estimateEmbeddingTokens(item.chunk.text)
    const wouldOverflowInputs = current.length + 1 > maxInputs
    const wouldOverflowTokens = maxTokensPerRequest > 0 && currentTokens + itemTokens > maxTokensPerRequest
    if (current.length > 0 && (wouldOverflowInputs || wouldOverflowTokens)) {
      batches.push({
        batchIndex: batches.length + 1,
        items: current,
        chunks: current.map((entry) => entry.chunk),
        estimatedTokens: currentTokens,
      })
      current = []
      currentTokens = 0
    }
    current.push(item)
    currentTokens += itemTokens
  }
  if (current.length > 0) {
    batches.push({
      batchIndex: batches.length + 1,
      items: current,
      chunks: current.map((entry) => entry.chunk),
      estimatedTokens: currentTokens,
    })
  }
  return batches
}

function shouldCheckpoint(input: {
  hasMore: boolean
  embeddedChunks: number
  lastCheckpointChunks: number
  lastCheckpointAt: number
  checkpointChunkInterval: number
  checkpointIntervalMs: number
}) {
  if (!input.hasMore) return false
  if (input.checkpointChunkInterval > 0 && input.embeddedChunks - input.lastCheckpointChunks >= input.checkpointChunkInterval) return true
  if (input.checkpointIntervalMs > 0 && Date.now() - input.lastCheckpointAt >= input.checkpointIntervalMs) return true
  return false
}

function progressCounts(totalChunks: number, embeddedChunks: number): RagIndexBuildProgressCounts {
  return {
    embeddedChunks,
    chunks: totalChunks,
    pendingChunkCount: Math.max(0, totalChunks - embeddedChunks),
  }
}

async function runEmbeddingJob(input: {
  provider: EmbeddingProvider
  job: PlannedEmbeddingBatch
  signal?: AbortSignal
  requestLimit: number
  maxRetries: number
  retryBackoffMs: number
  sleep: (ms: number) => Promise<void>
  onBeforeRequest: () => number | undefined
  onRateLimit: (event: RagRateLimitProgressInput) => void
  running: RunningEmbeddingJob
}): Promise<EmbeddingJobOutcome> {
  let requestNumber = 0
  const embedded = await embedBatchWithRetry({
    provider: input.provider,
    batch: input.job.chunks,
    signal: input.signal,
    requestLimit: input.requestLimit,
    maxRetries: input.maxRetries,
    retryBackoffMs: input.retryBackoffMs,
    sleep: input.sleep,
    onBeforeRequest: () => {
      const next = input.onBeforeRequest()
      requestNumber = next ?? requestNumber
      return next !== undefined
    },
    onRateLimit: input.onRateLimit,
  })
  return {
    running: input.running,
    job: input.job,
    requestNumber,
    embedded,
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
  onRateLimit: (event: RagRateLimitProgressInput) => void
}): Promise<EmbeddingBatchWithRetryResult> {
  let embeddingElapsedMs = 0
  let retries = 0
  let rateLimits = 0
  let timeouts = 0
  for (let retry = 0; retry <= input.maxRetries; retry++) {
    throwIfAborted(input.signal)
    if (!input.onBeforeRequest()) {
      return { vectors: [], embeddingElapsedMs, retries, rateLimits, timeouts, pausedReason: "request-budget", lastError: "request budget reached" }
    }
    const embeddingStarted = Date.now()
    try {
      const texts = input.batch.map((chunk) => chunk.text)
      const detailed = input.provider.embedDetailed
        ? await input.provider.embedDetailed(texts, input.signal)
        : { vectors: await input.provider.embed(texts, input.signal) }
      embeddingElapsedMs += Date.now() - embeddingStarted
      throwIfAborted(input.signal)
      return {
        vectors: detailed.vectors,
        embeddingElapsedMs,
        retries,
        rateLimits,
        timeouts,
        responseBytes: detailed.responseBytes,
        effectiveEncodingFormat: detailed.effectiveEncodingFormat,
      }
    } catch (error) {
      embeddingElapsedMs += Date.now() - embeddingStarted
      if (isAbortError(error, input.signal)) throw new RagIndexAbortError()
      const message = error instanceof Error ? error.message : String(error)
      const retryable = retryableRagError(error)
      if (!retryable) return { vectors: [], embeddingElapsedMs, retries, rateLimits, timeouts, pausedReason: "provider-error", lastError: message }
      retries += 1
      if (retryable.kind === "rate-limit") rateLimits += 1
      if (retryable.kind === "timeout") timeouts += 1
      if (retry >= input.maxRetries) return { vectors: [], embeddingElapsedMs, retries, rateLimits, timeouts, pausedReason: "rate-limit", lastError: message, resumeDelayMs: retryable.retryAfterMs }
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
  return { vectors: [], embeddingElapsedMs, retries, rateLimits, timeouts, pausedReason: "provider-error", lastError: "embedding provider did not return vectors" }
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
  if (error instanceof RagHttpError) {
    if (error.status === 429) return { status: error.status, retryAfterMs: error.retryAfterMs, kind: "rate-limit" as const }
    if (error.status === 408) return { status: error.status, retryAfterMs: error.retryAfterMs, kind: "timeout" as const }
    if (error.status >= 500 && error.status <= 599) return { status: error.status, retryAfterMs: error.retryAfterMs, kind: "server-error" as const }
  }
  return undefined
}

function workerPressureReason(result: Pick<EmbeddingBatchWithRetryResult, "retries" | "rateLimits" | "timeouts">) {
  const reasons = [
    result.retries > 0 ? "retry" : undefined,
    result.rateLimits > 0 ? "rate-limit" : undefined,
    result.timeouts > 0 ? "timeout" : undefined,
  ].filter(Boolean)
  return reasons.length > 0 ? reasons.join("/") : "provider pressure"
}

function compactVectorSlots(chunkSlots: Array<RagChunk | undefined>, vectorSlots: Array<number[] | undefined>) {
  const nextChunks: RagChunk[] = []
  const vectors: number[][] = []
  for (let index = 0; index < chunkSlots.length; index++) {
    const chunk = chunkSlots[index]
    const vector = vectorSlots[index]
    if (!chunk || !vector) continue
    nextChunks.push(chunk)
    vectors.push(vector)
  }
  return { nextChunks, vectors }
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function clampInteger(input: number, min: number, max: number) {
  const value = Math.floor(Number(input))
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
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
