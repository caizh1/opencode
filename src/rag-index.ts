import * as crypto from "node:crypto"
import { moduleKey, shardKeyForPath } from "./codegraph-index"
import type { CodeGraphFile, CodeGraphIndex } from "./codegraph-types"
import type { StateMachine } from "./analysis-types"
import type { EmbeddingProvider, RagChunk, RagVectorIndex, RagVectorSearchHit, RagVectorShard } from "./rag-types"

export type RagSerializedManifest = {
  version: 1
  rootPath: string
  updatedAt: number
  provider: string
  model: string
  dimension: number
  chunks: number
  shards: { key: string; chunks: number; metadataPath: string; vectorsPath: string }[]
}

export type RagSerializedShardMetadata = {
  version: 1
  key: string
  dimension: number
  chunks: RagChunk[]
}

export async function buildRagVectorIndex(input: {
  index: CodeGraphIndex
  provider: EmbeddingProvider
  stateMachines?: StateMachine[]
  previous?: RagVectorIndex
  changedPaths?: string[]
  signal?: AbortSignal
}): Promise<RagVectorIndex> {
  const chunks = buildRagChunks(input.index, input.stateMachines ?? [])
  const changed = input.changedPaths ? new Set(input.changedPaths.map(normalizePath)) : undefined
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
      pending.push(chunk)
    }
  }

  if (pending.length > 0) {
    const embedded = await input.provider.embed(pending.map((chunk) => chunk.text), input.signal)
    if (embedded.length !== pending.length) throw new Error(`embedding provider returned ${embedded.length} vector(s), expected ${pending.length}`)
    for (let index = 0; index < pending.length; index++) {
      nextChunks.push(pending[index])
      vectors.push(normalizeVector(embedded[index]))
    }
  }

  const dimension = vectors[0]?.length ?? 0
  if (dimension > 0 && vectors.some((vector) => vector.length !== dimension)) throw new Error("RAG vectors have inconsistent dimensions")
  return {
    version: 1,
    rootPath: input.index.rootPath,
    updatedAt: Date.now(),
    provider: input.provider.id,
    model: input.provider.model,
    dimension,
    chunks: nextChunks,
    vectors,
  }
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
  return {
    version: 1,
    rootPath: index.rootPath,
    updatedAt: index.updatedAt,
    provider: index.provider,
    model: index.model,
    dimension: index.dimension,
    chunks: index.chunks.length,
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
