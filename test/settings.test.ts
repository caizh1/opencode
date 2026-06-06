import { beforeEach, describe, expect, mock, test } from "bun:test"

type ConfigUpdate = {
  key: string
  value: unknown
}

let configValues = new Map<string, unknown>()
let configUpdates: ConfigUpdate[] = []
let updateFailures = new Map<string, Error>()
let secretStores: ConfigUpdate[] = []
let secretDeletes: string[] = []

mock.module("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => configValues.has(key) ? configValues.get(key) as T : fallback,
      update: async (key: string, value: unknown) => {
        const failure = updateFailures.get(key)
        if (failure) throw failure
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
  RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT,
  RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS,
  RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT,
  RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT,
  RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT,
  RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT,
  RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS,
  RAG_EMBEDDING_TIMEOUT_DEFAULT_MS,
  RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS,
  PASSWORD_SECRET_KEY,
  connectionInputHasPassword,
  ragEmbeddingTimeoutMsForBatchSize,
  ragSettingsInputChangesEmbeddingIdentity,
  ragSettingsInputMatchesCurrent,
  ragSettingsUpdates,
  readRemoteSettings,
  saveConnectionSettings,
  saveRagSettings,
  validateRagEmbeddingBatchSize,
} = await import("../src/settings")

beforeEach(() => {
  configValues = new Map<string, unknown>()
  configUpdates = []
  updateFailures = new Map<string, Error>()
  secretStores = []
  secretDeletes = []
})

describe("connection settings", () => {
  test("does not update the saved password when password is omitted", async () => {
    const input = { serverUrl: "http://localhost:4096/", username: "opencode" }

    expect(connectionInputHasPassword(input)).toBe(false)
    await saveConnectionSettings(secretContext(), input)

    expect(configUpdates).toEqual([
      { key: "serverUrl", value: "http://localhost:4096" },
      { key: "username", value: "opencode" },
    ])
    expect(secretStores).toEqual([])
    expect(secretDeletes).toEqual([])
  })

  test("stores new passwords and treats explicit blanks as clearing the password", async () => {
    await saveConnectionSettings(secretContext(), { serverUrl: "http://localhost:4096", username: "opencode", password: " secret " })

    expect(connectionInputHasPassword({ serverUrl: "http://localhost:4096", username: "opencode", password: undefined })).toBe(true)
    expect(secretStores).toEqual([{ key: PASSWORD_SECRET_KEY, value: "secret" }])
    expect(secretDeletes).toEqual([])

    secretStores = []
    configUpdates = []

    await saveConnectionSettings(secretContext(), { serverUrl: "http://localhost:4096", username: "opencode", password: "" })

    expect(secretStores).toEqual([])
    expect(secretDeletes).toEqual([PASSWORD_SECRET_KEY])
  })
})

describe("completion settings", () => {
  test("defaults inline completion to the direct model provider", () => {
    const settings = readRemoteSettings()

    expect(settings.completion.provider).toBe("openai-compatible")
  })
})

describe("RAG settings validation", () => {
  test("uses 128 as the default embedding batch size", () => {
    const settings = readRemoteSettings()

    expect(settings.rag.embedding.batchSize).toBe(RAG_EMBEDDING_BATCH_SIZE_DEFAULT)
    expect(settings.rag.embedding.batchSize).toBe(128)
    expect(settings.rag.embedding.maxTokensPerRequest).toBe(65536)
    expect(settings.rag.embedding.concurrentRequests).toBe(RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT)
    expect(settings.rag.embedding.maxInFlightTokens).toBe(RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT)
    expect(settings.rag.embedding.encodingFormat).toBe(RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT)
    expect(settings.rag.embedding.encodingFormat).toBe("auto")
    expect(settings.rag.embedding.checkpointMode).toBe(RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT)
    expect(settings.rag.embedding.checkpointChunkInterval).toBe(RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT)
    expect(settings.rag.embedding.checkpointIntervalMs).toBe(RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS)
    expect(settings.rag.embedding.timeoutMs).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
    expect(settings.rag.embedding.requestDelayMs).toBe(RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS)
    expect(settings.rag.embedding.configError).toBeUndefined()
  })

  test("derives embedding timeout from the configured batch size", () => {
    for (const batchSize of [1, 5, 10, 32, 64, 128, 256]) {
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
    expect(RAG_EMBEDDING_BATCH_SIZE_OPTIONS).toEqual([1, 5, 10, 32, 64, 128, 256, 512])
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

  test("saves small embedding batch sizes for provider input limits", async () => {
    for (const batchSize of [1, 5, 10]) {
      configUpdates = []
      await saveRagSettings(ragInput({ embeddingBatchSize: batchSize, embeddingTimeoutMs: 90000 }))

      expect(configUpdates.find((update) => update.key === "rag.embedding.batchSize")?.value).toBe(batchSize)
      expect(configUpdates.find((update) => update.key === "rag.embedding.timeoutMs")?.value).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
      expect(validateRagEmbeddingBatchSize(batchSize)).toBe(batchSize)
    }
  })

  test("saves 512 batch size with a ninety second embedding timeout", async () => {
    await saveRagSettings(ragInput({ embeddingBatchSize: 512, embeddingTimeoutMs: 30000 }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.batchSize")?.value).toBe(512)
    expect(configUpdates.find((update) => update.key === "rag.embedding.timeoutMs")?.value).toBe(RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS)
  })

  test("saves max token request caps without writing embedding dimensions", async () => {
    await saveRagSettings(ragInput({ embeddingMaxTokensPerRequest: 32768 }))

    expect(configUpdates.some((update) => update.key === "rag.embedding.dimensions")).toBe(false)
    expect(configUpdates.find((update) => update.key === "rag.embedding.maxTokensPerRequest")?.value).toBe(32768)
  })

  test("compares RAG settings after normalizing effective values", () => {
    for (const update of ragSettingsUpdates(ragInput())) {
      configValues.set(update.key, update.value)
    }

    expect(ragSettingsInputMatchesCurrent(ragInput({
      embeddingEndpoint: "http://127.0.0.1:8000/v1/embeddings/",
      embeddingTimeoutMs: 90000,
    }))).toBe(true)
    expect(ragSettingsInputMatchesCurrent(ragInput({ embeddingModel: "different-embedding" }))).toBe(false)
  })

  test("detects only embedding endpoint and model changes as RAG identity changes", () => {
    for (const update of ragSettingsUpdates(ragInput())) {
      configValues.set(update.key, update.value)
    }

    expect(ragSettingsInputChangesEmbeddingIdentity(ragInput({
      embeddingEndpoint: "http://127.0.0.1:9000/v1/embeddings",
    }))).toBe(true)
    expect(ragSettingsInputChangesEmbeddingIdentity(ragInput({
      embeddingModel: "different-embedding",
    }))).toBe(true)
    expect(ragSettingsInputChangesEmbeddingIdentity(ragInput({
      embeddingEndpoint: "http://127.0.0.1:8000/v1/embeddings/",
      embeddingBatchSize: 512,
      embeddingConcurrentRequests: 4,
      embeddingCheckpointMode: "safe",
      embeddingRequestDelayMs: 1000,
      rerankEndpoint: "http://127.0.0.1:8000/other-rerank",
      rerankModel: "different-rerank",
      vectorTopK: 48,
      rerankTopK: 8,
      allowedHosts: ["rag.internal"],
    }))).toBe(false)
  })

  test("saves adaptive embedding concurrency settings", async () => {
    await saveRagSettings(ragInput({
      embeddingConcurrentRequests: 9,
      embeddingMaxInFlightTokens: 12000,
      embeddingEncodingFormat: "auto",
      embeddingRequestDelayMs: Number.NaN,
    }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.concurrentRequests")?.value).toBe(8)
    expect(configUpdates.find((update) => update.key === "rag.embedding.maxInFlightTokens")?.value).toBe(32768)
    expect(configUpdates.find((update) => update.key === "rag.embedding.encodingFormat")?.value).toBe("auto")
    expect(configUpdates.find((update) => update.key === "rag.embedding.requestDelayMs")?.value).toBe(RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS)
  })

  test("saves checkpoint settings as optional RAG embedding updates", async () => {
    await saveRagSettings(ragInput({
      embeddingCheckpointMode: "safe",
      embeddingCheckpointChunkInterval: 4096,
      embeddingCheckpointIntervalMs: 45000,
    }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.checkpointMode")?.value).toBe("safe")
    expect(configUpdates.find((update) => update.key === "rag.embedding.checkpointChunkInterval")?.value).toBe(4096)
    expect(configUpdates.find((update) => update.key === "rag.embedding.checkpointIntervalMs")?.value).toBe(45000)
  })

  test("skips optional embedding optimization saves when the active manifest has not registered them", async () => {
    configUpdates = []
    updateFailures.set("rag.embedding.maxTokensPerRequest", new Error("opencode.remote.rag.embedding.maxTokensPerRequest is not a registered configuration"))
    updateFailures.set("rag.embedding.concurrentRequests", new Error("opencode.remote.rag.embedding.concurrentRequests is not a registered configuration"))
    updateFailures.set("rag.embedding.maxInFlightTokens", new Error("opencode.remote.rag.embedding.maxInFlightTokens is not a registered configuration"))
    updateFailures.set("rag.embedding.encodingFormat", new Error("opencode.remote.rag.embedding.encodingFormat is not a registered configuration"))
    updateFailures.set("rag.embedding.checkpointMode", new Error("opencode.remote.rag.embedding.checkpointMode is not a registered configuration"))
    updateFailures.set("rag.embedding.checkpointChunkInterval", new Error("opencode.remote.rag.embedding.checkpointChunkInterval is not a registered configuration"))
    updateFailures.set("rag.embedding.checkpointIntervalMs", new Error("opencode.remote.rag.embedding.checkpointIntervalMs is not a registered configuration"))

    await saveRagSettings(ragInput({
      embeddingMaxTokensPerRequest: 32768,
      embeddingConcurrentRequests: 4,
      embeddingMaxInFlightTokens: 180000,
      embeddingEncodingFormat: "base64",
      embeddingCheckpointMode: "safe",
      embeddingCheckpointChunkInterval: 4096,
      embeddingCheckpointIntervalMs: 45000,
    }))

    expect(configUpdates.some((update) => update.key === "rag.embedding.endpoint")).toBe(true)
    expect(configUpdates.some((update) => update.key === "rag.embedding.maxTokensPerRequest")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.concurrentRequests")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.maxInFlightTokens")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.encodingFormat")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.checkpointMode")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.checkpointChunkInterval")).toBe(false)
    expect(configUpdates.some((update) => update.key === "rag.embedding.checkpointIntervalMs")).toBe(false)
  })
})

function ragInput(overrides: Partial<Parameters<typeof saveRagSettings>[0]> = {}): Parameters<typeof saveRagSettings>[0] {
  return {
    embeddingEndpoint: "http://127.0.0.1:8000/v1/embeddings",
    embeddingModel: "local-embedding",
    embeddingBatchSize: RAG_EMBEDDING_BATCH_SIZE_DEFAULT,
    embeddingMaxTokensPerRequest: 65536,
    embeddingConcurrentRequests: RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT,
    embeddingMaxInFlightTokens: RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT,
    embeddingEncodingFormat: RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT,
    embeddingCheckpointMode: RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT,
    embeddingCheckpointChunkInterval: RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT,
    embeddingCheckpointIntervalMs: RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS,
    embeddingTimeoutMs: 30000,
    embeddingRequestDelayMs: RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS,
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

function secretContext() {
  return {
    secrets: {
      store: async (key: string, value: string) => {
        secretStores.push({ key, value })
      },
      delete: async (key: string) => {
        secretDeletes.push(key)
      },
    },
  } as Parameters<typeof saveConnectionSettings>[0]
}
