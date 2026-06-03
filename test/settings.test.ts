import { beforeEach, describe, expect, mock, test } from "bun:test"

type ConfigUpdate = {
  key: string
  value: unknown
}

let configValues = new Map<string, unknown>()
let configUpdates: ConfigUpdate[] = []

mock.module("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => configValues.has(key) ? configValues.get(key) as T : fallback,
      update: async (key: string, value: unknown) => {
        configUpdates.push({ key, value })
      },
    }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}))

const {
  RAG_EMBEDDING_BATCH_SIZE_DEFAULT,
  RAG_EMBEDDING_BATCH_SIZE_ERROR,
  RAG_EMBEDDING_BATCH_SIZE_MAX,
  RAG_EMBEDDING_BATCH_SIZE_OPTIONS,
  RAG_EMBEDDING_TIMEOUT_DEFAULT_MS,
  RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS,
  ragEmbeddingTimeoutMsForBatchSize,
  ragSettingsUpdates,
  readRemoteSettings,
  saveRagSettings,
  validateRagEmbeddingBatchSize,
} = await import("../src/settings")

beforeEach(() => {
  configValues = new Map<string, unknown>()
  configUpdates = []
})

describe("RAG settings validation", () => {
  test("uses 128 as the default embedding batch size", () => {
    const settings = readRemoteSettings()

    expect(settings.rag.embedding.batchSize).toBe(RAG_EMBEDDING_BATCH_SIZE_DEFAULT)
    expect(settings.rag.embedding.batchSize).toBe(128)
    expect(settings.rag.embedding.timeoutMs).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
    expect(settings.rag.embedding.configError).toBeUndefined()
  })

  test("derives embedding timeout from the configured batch size", () => {
    for (const batchSize of [32, 64, 128, 256]) {
      configValues = new Map<string, unknown>([
        ["rag.embedding.batchSize", batchSize],
        ["rag.embedding.timeoutMs", 120000],
      ])
      const settings = readRemoteSettings()

      expect(settings.rag.embedding.batchSize).toBe(batchSize)
      expect(settings.rag.embedding.timeoutMs).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
      expect(ragEmbeddingTimeoutMsForBatchSize(batchSize)).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
    }

    configValues = new Map<string, unknown>([
      ["rag.embedding.batchSize", 512],
      ["rag.embedding.timeoutMs", 30000],
    ])
    const settings = readRemoteSettings()

    expect(settings.rag.embedding.batchSize).toBe(512)
    expect(settings.rag.embedding.timeoutMs).toBe(RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS)
    expect(ragEmbeddingTimeoutMsForBatchSize(512)).toBe(RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS)
  })

  test("preserves handwritten non-option batch size and marks RAG embedding invalid", () => {
    configValues.set("rag.embedding.endpoint", "http://127.0.0.1:8000/v1/embeddings")
    configValues.set("rag.embedding.batchSize", 200)

    const settings = readRemoteSettings()

    expect(settings.rag.embedding.enabled).toBe(false)
    expect(settings.rag.embedding.batchSize).toBe(200)
    expect(settings.rag.embedding.configError).toBe(RAG_EMBEDDING_BATCH_SIZE_ERROR)
  })

  test("rejects saved batch sizes outside the fixed options", async () => {
    expect(RAG_EMBEDDING_BATCH_SIZE_OPTIONS).toEqual([32, 64, 128, 256, 512])
    await expect(saveRagSettings(ragInput({ embeddingBatchSize: RAG_EMBEDDING_BATCH_SIZE_MAX + 1 }))).rejects.toThrow(RAG_EMBEDDING_BATCH_SIZE_ERROR)
    await expect(() => ragSettingsUpdates(ragInput({ embeddingBatchSize: 16 }))).toThrow(RAG_EMBEDDING_BATCH_SIZE_ERROR)
    await expect(() => ragSettingsUpdates(ragInput({ embeddingBatchSize: 200 }))).toThrow(RAG_EMBEDDING_BATCH_SIZE_ERROR)

    expect(configUpdates).toEqual([])
  })

  test("falls back to 128 for non-finite saved batch size values and saves the derived timeout", async () => {
    await saveRagSettings(ragInput({ embeddingBatchSize: Number.NaN, embeddingTimeoutMs: 90000 }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.batchSize")?.value).toBe(128)
    expect(configUpdates.find((update) => update.key === "rag.embedding.timeoutMs")?.value).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
    expect(validateRagEmbeddingBatchSize(Number.NaN)).toBe(128)
  })

  test("saves 512 batch size with a ninety second embedding timeout", async () => {
    await saveRagSettings(ragInput({ embeddingBatchSize: 512, embeddingTimeoutMs: 30000 }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.batchSize")?.value).toBe(512)
    expect(configUpdates.find((update) => update.key === "rag.embedding.timeoutMs")?.value).toBe(RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS)
  })
})

function ragInput(overrides: Partial<Parameters<typeof saveRagSettings>[0]> = {}): Parameters<typeof saveRagSettings>[0] {
  return {
    embeddingEndpoint: "http://127.0.0.1:8000/v1/embeddings",
    embeddingModel: "local-embedding",
    embeddingBatchSize: RAG_EMBEDDING_BATCH_SIZE_DEFAULT,
    embeddingTimeoutMs: 30000,
    embeddingRequestDelayMs: 500,
    embeddingMaxRequestsPerRun: 100,
    embeddingMaxRetries: 3,
    embeddingRetryBackoffMs: 2000,
    embeddingResumeAutomatically: true,
    embeddingResumeDelayMs: 60000,
    rerankEndpoint: "http://127.0.0.1:8000/rerank",
    rerankModel: "local-rerank",
    allowedHosts: [],
    vectorTopK: 24,
    rerankTopK: 16,
    ...overrides,
  }
}
