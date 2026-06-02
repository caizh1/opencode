import type { CodeGraphEvidence } from "./codegraph-types"
import type { RagEndpointKind, RagSettings, RagStatus } from "./types"

export type RagChunkKind = "function" | "file-summary" | "module-summary" | "state-transition" | "text-window"

export type RagChunk = {
  id: string
  kind: RagChunkKind
  path: string
  module: string
  shard: string
  startLine: number
  endLine: number
  text: string
  sourceHash: string
}

export type RagVectorIndex = {
  version: 1
  rootPath: string
  updatedAt: number
  provider: string
  model: string
  dimension: number
  chunks: RagChunk[]
  vectors: number[][]
}

export type RagVectorShard = {
  key: string
  chunks: RagChunk[]
  vectors: number[][]
}

export type RagVectorSearchHit = {
  chunk: RagChunk
  score: number
}

export type RagEndpointPolicyResult = {
  ok: boolean
  kind: RagEndpointKind
  url?: URL
  reason?: string
}

export type EmbeddingProvider = {
  id: string
  model: string
  dimension?: number
  embed(input: string[], signal?: AbortSignal): Promise<number[][]>
}

export type RerankInput = {
  query: string
  documents: string[]
  topN: number
  signal?: AbortSignal
}

export type RerankResult = {
  index: number
  score: number
}

export type RerankProvider = {
  id: string
  model: string
  rerank(input: RerankInput): Promise<RerankResult[]>
}

export type HybridRetrievalOptions = {
  settings: RagSettings
  vectorIndex?: RagVectorIndex
  embeddingProvider?: EmbeddingProvider
  rerankProvider?: RerankProvider
  signal?: AbortSignal
}

export type HybridRetrievalStep = {
  label: "bm25" | "vector" | "graph" | "state-machine" | "rerank" | "fallback"
  detail: string
  elapsedMs: number
}

export type HybridRetrievalTrace = {
  enabled: boolean
  provider?: string
  rerankProvider?: string
  vectorCandidates: number
  rerankedCandidates: number
  fallbackReason?: string
  steps: HybridRetrievalStep[]
}

export type RagIndexBuildResult = {
  index?: RagVectorIndex
  status: RagStatus
}

export type RagCandidate = {
  evidence: CodeGraphEvidence
  strong: boolean
}
