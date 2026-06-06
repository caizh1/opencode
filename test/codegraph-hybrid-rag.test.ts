import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { queryEvidenceAsync } from "../src/codegraph-analysis"
import { retrieveHybridEvidence } from "../src/codegraph-query"
import { buildRagVectorIndex } from "../src/rag-index"
import type { CodeGraphIndex } from "../src/codegraph-types"
import type { EmbeddingProvider, RerankProvider } from "../src/rag-types"
import type { RagSettings } from "../src/types"

describe("hybrid offline evidence RAG", () => {
  test("adds vector evidence while preserving exact symbol evidence", async () => {
    const index = sampleIndex()
    const embedding = fakeEmbeddingProvider()
    const vectorIndex = await buildRagVectorIndex({ index, provider: embedding })
    const result = await retrieveHybridEvidence({
      index,
      question: "explain flash page verification",
      maxBytes: 60000,
      hybrid: {
        settings: settings({ embedding: true }),
        embeddingProvider: embedding,
        vectorIndex,
      },
    })

    expect(result?.trace?.some((step) => step.label === "vector")).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("vector:function") && item.snippet.includes("nand_read_page"))).toBe(true)

    const exact = await retrieveHybridEvidence({
      index,
      question: "explain nand_read_page",
      maxBytes: 60000,
      hybrid: {
        settings: settings({ embedding: true, rerank: true }),
        embeddingProvider: embedding,
        rerankProvider: fakeRerankProvider(),
        vectorIndex,
      },
    })
    expect(exact?.evidence[0]?.reason).toContain("exact symbol match")
  })

  test("falls back to BM25 graph state-machine retrieval when embedding is disabled or unavailable", async () => {
    const index = sampleIndex()
    const disabled = await queryEvidenceAsync(index, "who calls nand_read_page", undefined, {
      settings: settings({ embedding: false }),
    })
    expect(disabled.trace.steps.some((step) => step.label === "fallback" && step.detail.includes("vector disabled"))).toBe(true)
    expect(disabled.evidencePack.evidence.some((item) => item.file === "boot/storage.c")).toBe(true)

    const unavailable = await queryEvidenceAsync(index, "explain flash page verification", undefined, {
      settings: settings({ embedding: true }),
    })
    expect(unavailable.trace.steps.some((step) => step.label === "fallback" && step.detail.includes("embedding provider"))).toBe(true)
    expect(unavailable.answerPolicy.allowed).toBe(true)
  })

  test("keeps vector retrieval when rerank is configured but unavailable", async () => {
    const index = sampleIndex()
    const embedding = fakeEmbeddingProvider()
    const vectorIndex = await buildRagVectorIndex({ index, provider: embedding })
    const result = await retrieveHybridEvidence({
      index,
      question: "explain flash page verification",
      maxBytes: 60000,
      hybrid: {
        settings: settings({ embedding: true, rerank: true }),
        embeddingProvider: embedding,
        vectorIndex,
      },
    })

    expect(result?.trace?.some((step) => step.label === "vector")).toBe(true)
    expect(result?.trace?.some((step) => step.label === "rerank")).toBe(false)
    expect(result?.trace?.some((step) => step.label === "fallback" && step.detail.includes("rerank provider"))).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("vector:function"))).toBe(true)
  })

  test("graph-only evidence retrieval avoids configured embedding and rerank providers", async () => {
    const index = sampleIndex()
    const buildEmbedding = fakeEmbeddingProvider()
    const vectorIndex = await buildRagVectorIndex({ index, provider: buildEmbedding })
    const embeddingCalls = { count: 0 }
    const rerankCalls = { count: 0 }
    const configuredHybrid = {
      settings: settings({ embedding: true, rerank: true }),
      embeddingProvider: countingEmbeddingProvider(embeddingCalls),
      rerankProvider: countingRerankProvider(rerankCalls),
      vectorIndex,
    }
    expect(configuredHybrid.vectorIndex.vectors.length).toBeGreaterThan(0)

    const result = await queryEvidenceAsync(index, "who calls nand_read_page")

    expect(result.answerPolicy.allowed).toBe(true)
    expect(result.trace.steps.some((step) => step.label === "vector")).toBe(false)
    expect(result.trace.steps.some((step) => step.label === "rerank")).toBe(false)
    expect(result.evidencePack.evidence.some((item) => item.file === "boot/storage.c")).toBe(true)
    expect(embeddingCalls.count).toBe(0)
    expect(rerankCalls.count).toBe(0)
  })
})

function sampleIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/nand/nand.c",
      hash: "nand",
      size: 1,
      text: `
int ecc_check(void) { return 0; }
int nand_read_page(void) { return ecc_check(); }
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "storage",
      size: 1,
      text: "int storage_boot(void) { return nand_read_page(); }",
    }),
  ]
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  }
}

function settings(input: { embedding: boolean; rerank?: boolean }): RagSettings {
  return {
    embedding: {
      enabled: input.embedding,
      endpoint: input.embedding ? "http://127.0.0.1:8000/v1/embeddings" : "",
      model: "fake",
      batchSize: 16,
      maxTokensPerRequest: 65536,
      concurrentRequests: 3,
      maxInFlightTokens: 180000,
      encodingFormat: "float",
      checkpointMode: "interval",
      checkpointChunkInterval: 8192,
      checkpointIntervalMs: 120000,
      timeoutMs: 1000,
      requestDelayMs: 0,
      maxRequestsPerRun: 100,
      maxRetries: 3,
      retryBackoffMs: 2000,
      resumeAutomatically: true,
      resumeDelayMs: 60000,
    },
    rerank: {
      enabled: input.rerank ?? false,
      endpoint: input.rerank ? "http://127.0.0.1:8000/rerank" : "",
      model: "fake-rerank",
    },
    allowedHosts: [],
    vectorTopK: 8,
    rerankTopK: 8,
  }
}

function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake",
    embed: async (input) => input.map(embedText),
  }
}

function fakeRerankProvider(): RerankProvider {
  return {
    id: "fake-rerank",
    model: "fake",
    rerank: async (input) => input.documents.map((_, index) => ({ index, score: index === 0 ? 0.1 : 0.9 })).reverse(),
  }
}

function countingEmbeddingProvider(calls: { count: number }): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake",
    embed: async (input) => {
      calls.count += 1
      return input.map(embedText)
    },
  }
}

function countingRerankProvider(calls: { count: number }): RerankProvider {
  return {
    id: "fake-rerank",
    model: "fake-rerank",
    rerank: async (input) => {
      calls.count += 1
      return input.documents.map((_, index) => ({ index, score: input.documents.length - index }))
    },
  }
}

function embedText(text: string) {
  const lower = text.toLowerCase()
  return normalize([
    /nand|flash|page|ecc|verification/.test(lower) ? 1 : 0,
    /storage|boot/.test(lower) ? 1 : 0,
    /module|file/.test(lower) ? 1 : 0,
  ])
}

function normalize(values: number[]) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / norm)
}
