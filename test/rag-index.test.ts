import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { RagHttpError } from "../src/rag-provider"
import { buildRagChunks, buildRagVectorIndex, createRagSerializedManifest, decodeRagShardVectors, encodeRagShardVectors, RagIndexAbortError, ragManifestStaleReason, searchRagVectorIndex, splitRagVectorIndex } from "../src/rag-index"
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

  test("filters test directory chunks when RAG test indexing is disabled", async () => {
    const index = sampleIndexWithTests()
    const chunks = buildRagChunks(index, [], { indexTests: false })

    expect(chunks.some((chunk) => chunk.path.startsWith("test/") || chunk.path.includes("/tests/"))).toBe(false)
    expect(chunks.some((chunk) => chunk.path === "contest/keep.c")).toBe(true)

    const withTests = buildRagChunks(index, [], { indexTests: true })
    expect(withTests.some((chunk) => chunk.path === "test/helpers/spec.c")).toBe(true)
    expect(withTests.some((chunk) => chunk.path === "src/tests/helper.c")).toBe(true)

    const vectorIndex = await buildRagVectorIndex({ index, provider: nonZeroCountingEmbeddingProvider(), indexTests: false })
    expect(vectorIndex.indexTests).toBe(false)
    expect(vectorIndex.chunks).toEqual(chunks)
    expect(createRagSerializedManifest(vectorIndex).indexTests).toBe(false)
  })

  test("does not reuse previous vectors when the RAG test indexing policy changes", async () => {
    const index = sampleIndexWithTests()
    const provider = nonZeroCountingEmbeddingProvider()
    const first = await buildRagVectorIndex({ index, provider, indexTests: true })
    provider.calls = 0

    const second = await buildRagVectorIndex({ index, provider, previous: first, indexTests: false })

    expect(second.indexTests).toBe(false)
    expect(provider.calls).toBe(buildRagChunks(index, [], { indexTests: false }).length)
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

  test("embeds all chunks when previous vectors are intentionally ignored", async () => {
    const index = sampleIndex()
    const provider = countingEmbeddingProvider()
    await buildRagVectorIndex({ index, provider })
    provider.calls = 0

    const rebuilt = await buildRagVectorIndex({ index, provider })

    expect(rebuilt.chunks.length).toBe(buildRagChunks(index).length)
    expect(provider.calls).toBe(buildRagChunks(index).length)
  })

  test("does not reuse previous vectors when provider dimensions change", async () => {
    const index = sampleIndex()
    const firstProvider = countingEmbeddingProvider(3)
    const secondProvider = countingEmbeddingProvider(2)
    const first = await buildRagVectorIndex({ index, provider: firstProvider })
    const second = await buildRagVectorIndex({
      index,
      provider: secondProvider,
      previous: first,
    })

    expect(firstProvider.calls).toBe(buildRagChunks(index).length)
    expect(secondProvider.calls).toBe(buildRagChunks(index).length)
    expect(second.chunks.length).toBe(first.chunks.length)
  })

  test("uses token-aware batch planning as a safety cap", async () => {
    const index = sampleIndex()
    const shortProvider = recordingEmbeddingProvider()
    await buildRagVectorIndex({
      index,
      provider: shortProvider,
      batchSize: 512,
      maxTokensPerRequest: 1_000_000,
      requestDelayMs: 0,
    })
    expect(shortProvider.batches).toHaveLength(1)

    const cappedProvider = recordingEmbeddingProvider()
    await buildRagVectorIndex({
      index,
      provider: cappedProvider,
      batchSize: 512,
      maxTokensPerRequest: 10,
      requestDelayMs: 0,
    })
    expect(cappedProvider.batches.length).toBeGreaterThan(1)
  })

  test("throttles intermediate checkpoints and always publishes a final checkpoint", async () => {
    const index = sampleIndex()
    const updates: number[] = []
    await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      requestDelayMs: 0,
      checkpointChunkInterval: 3,
      checkpointIntervalMs: 0,
      onIndexUpdate: async (partial) => {
        updates.push(partial.chunks.length)
      },
    })

    const totalChunks = buildRagChunks(index).length
    expect(updates).toEqual([3, 6, totalChunks])
  })

  test("skips intermediate checkpoints before the interval but still publishes the final batch", async () => {
    const index = sampleIndex()
    const updates: number[] = []
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      requestDelayMs: 0,
      checkpointChunkInterval: 9999,
      checkpointIntervalMs: 0,
      onIndexUpdate: async (partial) => {
        updates.push(partial.chunks.length)
      },
    })

    expect(updates).toEqual([buildRagChunks(index).length])
    expect(vectorIndex.chunks).toHaveLength(buildRagChunks(index).length)
  })

  test("supports turning intermediate checkpoints off while keeping the final checkpoint", async () => {
    const updates: Array<Awaited<ReturnType<typeof buildRagVectorIndex>>> = []
    const vectorIndex = await buildRagVectorIndex({
      index: sampleIndex(),
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      requestDelayMs: 0,
      checkpointChunkInterval: 0,
      checkpointIntervalMs: 0,
      onIndexUpdate: async (partial) => {
        updates.push(partial)
      },
    })

    expect(updates.map((partial) => partial.chunks.length)).toEqual([buildRagChunks(sampleIndex()).length])
    expect(vectorIndex.vectors[0]).toBe(updates[0].vectors[0])
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
      checkpointChunkInterval: 1,
      checkpointIntervalMs: 0,
      onIndexUpdate: async (partial) => {
        partialSourceTimestamps.push(partial.sourceIndexUpdatedAt)
      },
    })

    expect(partialSourceTimestamps).toEqual([99])
    expect(vectorIndex.sourceIndexUpdatedAt).toBe(99)
    expect(createRagSerializedManifest(vectorIndex).sourceIndexUpdatedAt).toBe(99)
  })

  test("records elapsed time and worker status in progress, checkpoints, and manifests", async () => {
    const index = sampleIndex()
    const progressElapsed: number[] = []
    const partials: Array<{ buildElapsedMs?: number; activeWorkers?: number; maxWorkers?: number }> = []
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      initialElapsedMs: 1234,
      batchSize: 1,
      concurrentRequests: 1,
      maxRequestsPerRun: 2,
      requestDelayMs: 0,
      checkpointChunkInterval: 1,
      checkpointIntervalMs: 0,
      onProgress: (event) => {
        progressElapsed.push(event.elapsedMs)
        expect(event.workerStatus.activeWorkers).toBe(1)
        expect(event.workerStatus.maxWorkers).toBe(2)
      },
      onIndexUpdate: async (partial) => {
        partials.push({
          buildElapsedMs: partial.buildElapsedMs,
          activeWorkers: partial.workerStatus?.activeWorkers,
          maxWorkers: partial.workerStatus?.maxWorkers,
        })
      },
    })

    expect(progressElapsed.length).toBeGreaterThan(0)
    expect(progressElapsed.every((elapsedMs) => elapsedMs >= 1234)).toBe(true)
    expect(partials[0]).toMatchObject({ activeWorkers: 1, maxWorkers: 2 })
    expect(partials[0].buildElapsedMs).toBeGreaterThanOrEqual(1234)
    expect(vectorIndex.buildElapsedMs).toBeGreaterThanOrEqual(1234)
    expect(vectorIndex.workerStatus).toMatchObject({ activeWorkers: 1, maxWorkers: 2 })
    const manifest = createRagSerializedManifest(vectorIndex)
    expect(manifest.buildElapsedMs).toBe(vectorIndex.buildElapsedMs)
    expect(manifest.workerStatus).toMatchObject({ activeWorkers: 1, maxWorkers: 2 })
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
      initialElapsedMs: 4567,
      batchSize: 1,
      requestDelayMs: 0,
    })

    expect(second.indexPausedReason).toBeUndefined()
    expect(second.chunks).toHaveLength(buildRagChunks(index).length)
    expect(second.pendingChunkCount).toBe(0)
    expect(second.buildElapsedMs).toBeGreaterThanOrEqual(4567)
    expect(provider.batches.length).toBe(buildRagChunks(index).length)
  })

  test("waits between embedding index requests", async () => {
    const sleeps: number[] = []
    const index = sampleIndex()
    await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      concurrentRequests: 1,
      maxRequestsPerRun: 2,
      requestDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(sleeps).toContain(25)
  })

  test("starts with three concurrent embedding requests by default", async () => {
    const provider = delayedEmbeddingProvider()

    await buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      requestDelayMs: 0,
    })

    expect(provider.maxActive).toBe(3)
  })

  test("allows eight configured embedding workers without adaptive overflow", async () => {
    const provider = delayedEmbeddingProvider()
    const workerCeilings: number[] = []

    const vectorIndex = await buildRagVectorIndex({
      index: generatedIndex(12),
      provider,
      batchSize: 1,
      concurrentRequests: 8,
      requestDelayMs: 0,
      onProgress: (event) => {
        workerCeilings.push(event.workerStatus.maxWorkers)
      },
    })

    expect(provider.maxActive).toBe(8)
    expect(workerCeilings).toContain(8)
    expect(vectorIndex.workerStatus?.configuredWorkers).toBe(8)
    expect(vectorIndex.workerStatus?.maxWorkers).toBe(8)
  })

  test("upgrades adaptive concurrency after stable batches", async () => {
    const provider = delayedEmbeddingProvider()
    const activeConcurrency: number[] = []
    const workerChanges: string[] = []

    const vectorIndex = await buildRagVectorIndex({
      index: generatedIndex(12),
      provider,
      batchSize: 1,
      requestDelayMs: 0,
      onBatchProfile: (event) => {
        activeConcurrency.push(event.activeConcurrency)
        if (event.workerStatus.lastChange) {
          workerChanges.push(`${event.workerStatus.lastChange.direction}:${event.workerStatus.lastChange.fromWorkers}->${event.workerStatus.lastChange.toWorkers}:${event.workerStatus.lastChange.reason}`)
        }
      },
    })

    expect(activeConcurrency).toContain(4)
    expect(provider.maxActive).toBe(4)
    expect(workerChanges).toContain("upgrade:3->4:stable batches")
    expect(vectorIndex.workerStatus?.lastChange).toMatchObject({
      direction: "upgrade",
      fromWorkers: 3,
      toWorkers: 4,
      reason: "stable batches",
    })
  })

  test("falls back from three to two concurrent requests after rate limit pressure", async () => {
    let attempts = 0
    const profiles: Array<{ status: string; activeConcurrency: number; change?: string }> = []
    const provider: EmbeddingProvider = {
      id: "pressure",
      model: "pressure",
      async embed(input) {
        attempts += 1
        if (attempts === 1) throw new RagHttpError("429 Too Many Requests: slow down", 429, "Too Many Requests", "slow down", 0)
        return input.map(embedText)
      },
    }

    await buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      maxRetries: 1,
      requestDelayMs: 0,
      sleep: async () => {},
      onBatchProfile: (event) => {
        const change = event.workerStatus.lastChange
        profiles.push({
          status: event.batchStatus,
          activeConcurrency: event.activeConcurrency,
          change: change ? `${change.direction}:${change.fromWorkers}->${change.toWorkers}:${change.reason}` : undefined,
        })
      },
    })

    expect(profiles.some((event) => event.status === "retry" && event.activeConcurrency === 2)).toBe(true)
    expect(profiles.some((event) => event.change === "degrade:3->2:retry/rate-limit")).toBe(true)
  })

  test("limits concurrent starts by max in-flight estimated tokens", async () => {
    const provider = delayedEmbeddingProvider()

    await buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      requestDelayMs: 0,
      maxInFlightTokens: 1,
    })

    expect(provider.maxActive).toBe(1)
  })

  test("reports embedding scheduler blocks for max in-flight token budget", async () => {
    const provider = delayedEmbeddingProvider()
    const reasons: string[] = []

    await buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      requestDelayMs: 0,
      maxInFlightTokens: 1,
      onSchedulerBlocked: (event) => {
        reasons.push(event.reason)
      },
    })

    expect(reasons).toContain("max-in-flight-tokens")
  })

  test("reports embedding scheduler blocks for active worker concurrency", async () => {
    const provider = delayedEmbeddingProvider()
    const events: Array<{ reason: string; activeSize: number; activeConcurrency: number }> = []

    await buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      concurrentRequests: 1,
      requestDelayMs: 0,
      onSchedulerBlocked: (event) => {
        events.push({
          reason: event.reason,
          activeSize: event.activeSize,
          activeConcurrency: event.activeConcurrency,
        })
      },
    })

    expect(events).toContainEqual({ reason: "concurrency", activeSize: 1, activeConcurrency: 1 })
  })

  test("reports chunk counts with embedding progress events", async () => {
    const index = sampleIndex()
    const totalChunks = buildRagChunks(index).length
    const events: Array<{ phase: string; embeddedChunks: number; chunks: number; pendingChunkCount: number; elapsedMs?: number; workerStatus?: { activeWorkers: number } }> = []
    await buildRagVectorIndex({
      index,
      provider: fakeEmbeddingProvider(),
      batchSize: 1,
      concurrentRequests: 1,
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
    expect(events[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(events[0].workerStatus).toMatchObject({ activeWorkers: 1 })
  })

  test("aborts while waiting between embedding index requests", async () => {
    const controller = new AbortController()
    const provider = recordingEmbeddingProvider()
    const updates: number[] = []
    await expect(buildRagVectorIndex({
      index: sampleIndex(),
      provider,
      batchSize: 1,
      concurrentRequests: 1,
      requestDelayMs: 25,
      checkpointChunkInterval: 1,
      checkpointIntervalMs: 0,
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
      concurrentRequests: 1,
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
    expect(manifest.buildElapsedMs).toBe(vectorIndex.buildElapsedMs)
    expect(manifest.workerStatus).toEqual(vectorIndex.workerStatus)
  })

  test("serializes manual paused RAG indexes without automatic resume metadata", async () => {
    const index = sampleIndex()
    const totalChunks = buildRagChunks(index).length
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      batchSize: 1,
      maxRequestsPerRun: 1,
      requestDelayMs: 0,
    })
    const manifest = createRagSerializedManifest({
      ...vectorIndex,
      chunks: [],
      vectors: [],
      dimension: 0,
      totalChunks,
      pendingChunkCount: totalChunks,
      indexPausedReason: "manual",
      lastError: "requested from test",
      nextResumeAt: 12345,
      resumeDelayMs: 60000,
      resumeReason: "request-budget",
    })

    expect(manifest.chunks).toBe(0)
    expect(manifest.totalChunks).toBe(totalChunks)
    expect(manifest.pendingChunks).toBe(totalChunks)
    expect(manifest.state).toBe("paused")
    expect(manifest.completed).toBe(false)
    expect(manifest.indexAvailability).toBe("paused")
    expect(manifest.indexPausedReason).toBe("manual")
    expect(manifest.lastError).toBe("requested from test")
    expect(manifest.nextResumeAt).toBeUndefined()
    expect(manifest.resumeDelayMs).toBeUndefined()
    expect(manifest.resumeReason).toBeUndefined()
  })

  test("serializes compatible RAG manifest lifecycle metadata", async () => {
    const index = sampleIndex()
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      batchSize: 1,
      requestDelayMs: 0,
    })
    const manifest = createRagSerializedManifest(vectorIndex, {
      extensionVersion: "0.0.106",
      buildId: "build-1",
      state: "ready",
      completed: true,
      buildStartedAt: 100,
      buildFinishedAt: 200,
    })

    expect(manifest.extensionVersion).toBe("0.0.106")
    expect(manifest.buildId).toBe("build-1")
    expect(manifest.state).toBe("ready")
    expect(manifest.completed).toBe(true)
    expect(manifest.buildStartedAt).toBe(100)
    expect(manifest.buildFinishedAt).toBe(200)
  })

  test("marks cross-version partial manifests stale without invalidating ready or legacy manifests", async () => {
    const index = sampleIndex()
    const vectorIndex = await buildRagVectorIndex({
      index,
      provider: recordingEmbeddingProvider(),
      batchSize: 1,
      maxRequestsPerRun: 1,
      requestDelayMs: 0,
    })
    const partialManifest = createRagSerializedManifest(vectorIndex, {
      extensionVersion: "0.0.105",
      state: "paused",
      completed: false,
    })
    const readyManifest = createRagSerializedManifest({
      ...vectorIndex,
      pendingChunkCount: 0,
      indexPausedReason: undefined,
    }, {
      extensionVersion: "0.0.105",
      state: "ready",
      completed: true,
    })
    const legacyManifest = createRagSerializedManifest(vectorIndex)

    expect(ragManifestStaleReason(partialManifest, "0.0.106")).toContain("0.0.105")
    expect(ragManifestStaleReason(readyManifest, "0.0.106")).toBeUndefined()
    expect(ragManifestStaleReason(legacyManifest, "0.0.106")).toBeUndefined()
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

function sampleIndexWithTests(): CodeGraphIndex {
  const files = [
    ...Object.values(sampleIndex().files),
    parseCFile({
      path: "test/helpers/spec.c",
      hash: "test-spec",
      size: 1,
      text: "int spec_helper(void) { return 0; }",
    }),
    parseCFile({
      path: "src/tests/helper.c",
      hash: "nested-test-helper",
      size: 1,
      text: "int nested_test_helper(void) { return 0; }",
    }),
    parseCFile({
      path: "contest/keep.c",
      hash: "contest",
      size: 1,
      text: "int contest_keep(void) { return 0; }",
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

function generatedIndex(functionCount: number): CodeGraphIndex {
  const functions = Array.from({ length: functionCount }, (_, index) => `int generated_${index}(void) { return ${index}; }`).join("\n")
  const file = parseCFile({
    path: "generated/many.c",
    hash: `generated-${functionCount}`,
    size: functions.length,
    text: functions,
  })
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: {
      [file.path]: file,
    },
  }
}

function fakeEmbeddingProvider(dimension?: number): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake",
    dimension,
    embed: async (input) => input.map(embedText),
  }
}

function countingEmbeddingProvider(dimension?: number): EmbeddingProvider & { calls: number } {
  return {
    ...fakeEmbeddingProvider(dimension),
    calls: 0,
    async embed(input) {
      this.calls += input.length
      return input.map(embedText)
    },
  }
}

function nonZeroCountingEmbeddingProvider(): EmbeddingProvider & { calls: number } {
  return {
    ...fakeEmbeddingProvider(3),
    calls: 0,
    async embed(input) {
      this.calls += input.length
      return input.map((_, index) => normalize([1, index % 2, 0]))
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

function delayedEmbeddingProvider(): EmbeddingProvider & { active: number; maxActive: number } {
  return {
    ...fakeEmbeddingProvider(),
    active: 0,
    maxActive: 0,
    async embed(input) {
      this.active += 1
      this.maxActive = Math.max(this.maxActive, this.active)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      this.active -= 1
      return input.map(embedText)
    },
  }
}

function embedText(text: string) {
  const lower = text.toLowerCase()
  return normalize([
    /nand|flash|page|ecc|generated/.test(lower) ? 1 : 0,
    /storage|boot/.test(lower) ? 1 : 0,
    /module|file/.test(lower) ? 1 : 0,
  ])
}

function normalize(values: number[]) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / norm)
}
