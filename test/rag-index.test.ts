import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { RagHttpError } from "../src/rag-provider"
import { buildRagChunks, buildRagVectorIndex, createRagSerializedManifest, decodeRagShardVectors, encodeRagShardVectors, RagIndexAbortError, searchRagVectorIndex, splitRagVectorIndex } from "../src/rag-index"
import type { CodeGraphIndex } from "../src/codegraph-types"
import type { EmbeddingProvider } from "../src/rag-types"

describe("local RAG vector index", () => {
  test("builds chunks, embeds vectors, searches, and serializes shard vectors", async () => {
    const index = sampleIndex()
    const chunks = buildRagChunks(index)
    expect(chunks.some((chunk) => chunk.kind === "function" && chunk.text.includes("nand_read_page"))).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === "module-summary")).toBe(true)

    const vectorIndex = await buildRagVectorIndex({ index, provider: fakeEmbeddingProvider() })
    expect(vectorIndex.chunks.length).toBe(chunks.length)
    expect(vectorIndex.dimension).toBe(3)
    expect(vectorIndex.sourceIndexUpdatedAt).toBe(index.updatedAt)

    const hits = searchRagVectorIndex(vectorIndex, embedText("flash page read"), 3)
    expect(hits.some((hit) => hit.chunk.text.includes("nand_read_page"))).toBe(true)

    const shard = splitRagVectorIndex(vectorIndex)[0]
    const encoded = encodeRagShardVectors(shard.vectors, vectorIndex.dimension)
    expect(decodeRagShardVectors(encoded, vectorIndex.dimension)).toHaveLength(shard.vectors.length)
  })

  test("reuses unchanged chunk vectors during incremental rebuilds", async () => {
    const index = sampleIndex()
    const provider = countingEmbeddingProvider()
    const first = await buildRagVectorIndex({ index, provider })
    const second = await buildRagVectorIndex({
      index,
      provider,
      previous: first,
      changedPaths: ["boot/storage.c"],
    })

    expect(second.chunks.length).toBe(first.chunks.length)
    expect(provider.calls).toBeLessThan(first.chunks.length + second.chunks.length)
  })

  test("records the source code graph snapshot timestamp in full and partial indexes", async () => {
    const index = sampleIndex()
    const partialSourceTimestamps: Array<number | undefined> = []
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      sourceIndexUpdatedAt: 99,
      batchSize: 1,
      maxRequestsPerRun: 1,
      requestDelayMs: 0,
      onIndexUpdate: async (partial) => {
        partialSourceTimestamps.push(partial.sourceIndexUpdatedAt)
      },
    })

    expect(partialSourceTimestamps).toEqual([99])
    expect(vectorIndex.sourceIndexUpdatedAt).toBe(99)
    expect(createRagSerializedManifest(vectorIndex).sourceIndexUpdatedAt).toBe(99)
  })

  test("pauses at the embedding request budget and resumes missing chunks", async () => {
    const index = sampleIndex()
    const provider = recordingEmbeddingProvider()
    const first = await buildRagVectorIndex({
      index,
      provider,
      batchSize: 1,
      maxRequestsPerRun: 1,
      requestDelayMs: 0,
    })

    expect(first.indexPausedReason).toBe("request-budget")
    expect(first.chunks).toHaveLength(1)
    expect(first.pendingChunkCount).toBe(buildRagChunks(index).length - 1)
    expect(provider.batches).toHaveLength(1)

    const second = await buildRagVectorIndex({
      index,
      provider,
      previous: first,
      batchSize: 1,
      requestDelayMs: 0,
    })

    expect(second.indexPausedReason).toBeUndefined()
    expect(second.chunks).toHaveLength(buildRagChunks(index).length)
    expect(second.pendingChunkCount).toBe(0)
    expect(provider.batches.length).toBe(buildRagChunks(index).length)
  })

  test("waits between embedding index requests", async () => {
    const sleeps: number[] = []
    const index = sampleIndex()
    await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      maxRequestsPerRun: 2,
      requestDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(sleeps).toContain(25)
  })

  test("reports chunk counts with embedding progress events", async () => {
    const index = sampleIndex()
    const totalChunks = buildRagChunks(index).length
    const events: Array<{ phase: string; embeddedChunks: number; chunks: number; pendingChunkCount: number }> = []
    await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      maxRequestsPerRun: 2,
      requestDelayMs: 25,
      sleep: async () => {},
      onProgress: (event) => {
        events.push(event)
      },
    })

    expect(events.map((event) => event.phase)).toEqual(["batch", "delay", "batch", "paused"])
    expect(events.every((event) => event.chunks === totalChunks)).toBe(true)
    expect(events[0]).toMatchObject({ embeddedChunks: 0, pendingChunkCount: totalChunks })
    expect(events[1]).toMatchObject({ embeddedChunks: 1, pendingChunkCount: totalChunks - 1 })
    expect(events[3]).toMatchObject({ embeddedChunks: 2, pendingChunkCount: totalChunks - 2 })
  })

  test("aborts while waiting between embedding index requests", async () => {
    const controller = new AbortController()
    const provider = recordingEmbeddingProvider()
    const updates: number[] = []
    await expect(buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      requestDelayMs: 25,
      signal: controller.signal,
      sleep: async () => {
        controller.abort()
      },
      onIndexUpdate: async (partial) => {
        updates.push(partial.chunks.length)
      },
    })).rejects.toBeInstanceOf(RagIndexAbortError)

    expect(provider.batches).toHaveLength(1)
    expect(updates).toEqual([1])
  })

  test("does not publish stale partial updates after aborting a batch", async () => {
    const controller = new AbortController()
    const updates: number[] = []
    const provider: EmbeddingProvider = {
      id: "abort-after-embed",
      model: "abort-after-embed",
      async embed(input) {
        controller.abort()
        return input.map(embedText)
      },
    }

    await expect(buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      requestDelayMs: 0,
      signal: controller.signal,
      onIndexUpdate: async (partial) => {
        updates.push(partial.chunks.length)
      },
    })).rejects.toBeInstanceOf(RagIndexAbortError)

    expect(updates).toHaveLength(0)
  })

  test("retries rate-limited embedding batches and preserves a paused partial index", async () => {
    const sleeps: number[] = []
    const events: string[] = []
    const index = sampleIndex()
    const provider: EmbeddingProvider = {
      id: "limited",
      model: "limited",
      async embed() {
        throw new RagHttpError("429 Too Many Requests: slow down", 429, "Too Many Requests", "slow down", 10)
      },
    }

    const vectorIndex = await buildRagVectorIndex({
      index,
      provider,
      batchSize: 1,
      maxRetries: 1,
      retryBackoffMs: 1000,
      requestDelayMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onProgress: (event) => {
        events.push(event.phase)
      },
    })

    expect(vectorIndex.indexPausedReason).toBe("rate-limit")
    expect(vectorIndex.lastError).toContain("429 Too Many Requests")
    expect(vectorIndex.resumeDelayMs).toBe(10)
    expect(vectorIndex.resumeReason).toBe("rate-limit")
    expect(vectorIndex.chunks).toHaveLength(0)
    expect(sleeps).toEqual([10])
    expect(events).toContain("rate-limit")
    expect(events).toContain("paused")
  })

  test("serializes scheduled RAG resume metadata", async () => {
    const index = sampleIndex()
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      batchSize: 1,
      maxRequestsPerRun: 1,
      requestDelayMs: 0,
    })
    const manifest = createRagSerializedManifest({
      ...vectorIndex,
      nextResumeAt: 12345,
      resumeDelayMs: 60000,
      resumeReason: "request-budget",
    })

    expect(manifest.pendingChunks).toBeGreaterThan(0)
    expect(manifest.indexPausedReason).toBe("request-budget")
    expect(manifest.nextResumeAt).toBe(12345)
    expect(manifest.resumeDelayMs).toBe(60000)
    expect(manifest.resumeReason).toBe("request-budget")
    expect(manifest.sourceIndexUpdatedAt).toBe(vectorIndex.sourceIndexUpdatedAt)
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

function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake",
    embed: async (input) => input.map(embedText),
  }
}

function countingEmbeddingProvider(): EmbeddingProvider & { calls: number } {
  return {
    ...fakeEmbeddingProvider(),
    calls: 0,
    async embed(input) {
      this.calls += input.length
      return input.map(embedText)
    },
  }
}

function recordingEmbeddingProvider(): EmbeddingProvider & { batches: string[][] } {
  return {
    ...fakeEmbeddingProvider(),
    batches: [],
    async embed(input) {
      this.batches.push(input)
      return input.map(embedText)
    },
  }
}

function embedText(text: string) {
  const lower = text.toLowerCase()
  return normalize([
    /nand|flash|page|ecc/.test(lower) ? 1 : 0,
    /storage|boot/.test(lower) ? 1 : 0,
    /module|file/.test(lower) ? 1 : 0,
  ])
}

function normalize(values: number[]) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / norm)
}
