import { beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type ConfigUpdate = {
  key: string
  value: unknown
}

let configValues = new Map<string, unknown>()
let configUpdates: ConfigUpdate[] = []
let updateFailures = new Map<string, Error>()
let secretValues = new Map<string, string>()
let secretStores: ConfigUpdate[] = []
let secretDeletes: string[] = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: { fsPath: string }, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  InlineCompletionTriggerKind: {
    Invoke: 0,
    Automatic: 1,
  },
  InlineCompletionItem: class InlineCompletionItem {
    insertText: string
    range?: unknown
    command?: unknown
    filterText?: string

    constructor(insertText: string, range?: unknown, command?: unknown) {
      this.insertText = insertText
      this.range = range
      this.command = command
    }
  },
  Range: class Range {
    start: { line: number; character: number }
    end: { line: number; character: number }

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: UriShim,
  WorkspaceEdit: class WorkspaceEdit {
    readonly inserts: unknown[] = []
    readonly replaces: unknown[] = []
    readonly deletes: unknown[] = []
    insert(...args: unknown[]) {
      this.inserts.push(args)
    }
    replace(...args: unknown[]) {
      this.replaces.push(args)
    }
    delete(...args: unknown[]) {
      this.deletes.push(args)
    }
  },
  commands: {
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    workspaceFolders: [],
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? "",
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => configValues.has(key) ? configValues.get(key) as T : fallback,
      update: async (key: string, value: unknown) => {
        const failure = updateFailures.get(key)
        if (failure) throw failure
        configUpdates.push({ key, value })
      },
    }),
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      readDirectory: async (uri: UriShim) => {
        const entries = await readdir(uri.fsPath, { withFileTypes: true })
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number])
      },
    },
  },
  window: {
    get activeTextEditor() {
      return undefined
    },
    get visibleTextEditors() {
      return []
    },
  },
  ConfigurationTarget: {
    Global: "global",
  },
  Position: class Position {},
  Selection: class Selection {},
}))

const {
  DEFAULT_COMPLETION_MODEL,
  DEFAULT_COMPLETION_CONTEXT_LENGTH,
  DEFAULT_RAG_EMBEDDING_MODEL,
  DEFAULT_RAG_RERANK_MODEL,
  DEFAULT_TOOLS_MAX_AGENT_STEPS,
  LEGACY_RAG_API_KEY_SECRET_KEY,
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
  connectionInputHasPassword,
  migrateLegacyRagApiKey,
  ragEmbeddingTimeoutMsForBatchSize,
  ragSettingsInputChangesEmbeddingIdentity,
  ragSettingsInputMatchesCurrent,
  ragSettingsUpdates,
  readRemoteSettings,
  saveConnectionSettings,
  saveCompletionSettings,
  saveToolsEnabled,
  saveRagSettings,
  validateRagEmbeddingBatchSize,
} = await import("../src/settings")
const { PROVIDER_API_KEY_SECRET_KEY } = await import("../src/chipmate-constants")

beforeEach(() => {
  configValues = new Map<string, unknown>()
  configUpdates = []
  updateFailures = new Map<string, Error>()
  secretValues = new Map<string, string>()
  secretStores = []
  secretDeletes = []
})

describe("connection settings", () => {
  test("does not update the saved password when password is omitted", async () => {
    const input = { serverUrl: "http://localhost:4096/", username: "opencode" }

    expect(connectionInputHasPassword(input)).toBe(false)
    await saveConnectionSettings(secretContext(), input)

    expect(configUpdates).toEqual([
      { key: "provider.apiBaseUrl", value: "http://localhost:4096" },
      { key: "provider.chatModel", value: "opencode" },
    ])
    expect(secretStores).toEqual([])
    expect(secretDeletes).toEqual([])
  })

  test("stores new passwords and treats explicit blanks as clearing the password", async () => {
    await saveConnectionSettings(secretContext(), { serverUrl: "http://localhost:4096", username: "opencode", password: " secret " })

    expect(connectionInputHasPassword({ serverUrl: "http://localhost:4096", username: "opencode", password: undefined })).toBe(true)
    expect(secretStores).toEqual([{ key: PROVIDER_API_KEY_SECRET_KEY, value: "secret" }])
    expect(secretDeletes).toEqual([])

    secretStores = []
    configUpdates = []

    await saveConnectionSettings(secretContext(), { serverUrl: "http://localhost:4096", username: "opencode", password: "" })

    expect(secretStores).toEqual([])
    expect(secretDeletes).toEqual([PROVIDER_API_KEY_SECRET_KEY])
  })

  test("migrates the legacy RAG credential into the provider API key once", async () => {
    secretValues.set(LEGACY_RAG_API_KEY_SECRET_KEY, " rag-secret ")

    await expect(migrateLegacyRagApiKey(secretContext())).resolves.toBe(true)

    expect(secretStores).toEqual([{ key: PROVIDER_API_KEY_SECRET_KEY, value: "rag-secret" }])
    expect(secretDeletes).toEqual([LEGACY_RAG_API_KEY_SECRET_KEY])
  })

  test("deletes the legacy RAG credential without overwriting an existing provider key", async () => {
    secretValues.set(PROVIDER_API_KEY_SECRET_KEY, "provider-secret")
    secretValues.set(LEGACY_RAG_API_KEY_SECRET_KEY, "rag-secret")

    await expect(migrateLegacyRagApiKey(secretContext())).resolves.toBe(false)

    expect(secretStores).toEqual([])
    expect(secretDeletes).toEqual([LEGACY_RAG_API_KEY_SECRET_KEY])
  })
})

describe("completion settings", () => {
  test("defaults inline completion to enabled qwen-direct and supports disabling it", () => {
    const settings = readRemoteSettings()

    expect(settings.completion.enabled).toBe(true)
    expect(settings.completion.provider).toBe("qwen-direct")
    expect(settings.completion.profile).toBe("qwen-coder-fim")
    expect(settings.completion.apiBaseUrl).toBe("")
    expect(settings.completion.model).toBe(DEFAULT_COMPLETION_MODEL)
    expect(settings.completion.contextLength).toBe(DEFAULT_COMPLETION_CONTEXT_LENGTH)

    configValues = new Map<string, unknown>([
      ["completion.enabled", false],
      ["completion.provider", "none"],
      ["completion.contextLength", 0],
    ])
    expect(readRemoteSettings().completion.enabled).toBe(false)
    expect(readRemoteSettings().completion.provider).toBe("none")
    expect(readRemoteSettings().completion.contextLength).toBe(0)
  })

  test("saves inline completion context length and normalizes invalid values to the 200k default", async () => {
    await saveCompletionSettings({
      enabled: true,
      provider: "qwen-direct",
      profile: "qwen-coder-fim",
      apiBaseUrl: "http://localhost:4096/",
      model: "qwen-coder-30b0",
      maxTokens: 256,
      contextLength: Number.NaN,
      temperature: 0.1,
      topP: 1,
    })

    expect(configUpdates).toContainEqual({ key: "completion.contextLength", value: DEFAULT_COMPLETION_CONTEXT_LENGTH })
    expect(configUpdates).toContainEqual({ key: "completion.apiBaseUrl", value: "http://localhost:4096" })
  })

  test("reads and saves fim-direct DeepSeek completion settings without changing provider defaults", async () => {
    configValues = new Map<string, unknown>([
      ["completion.provider", "fim-direct"],
      ["completion.profile", "deepseek-fim"],
      ["completion.apiBaseUrl", "https://api.deepseek.com/"],
      ["completion.model", "deepseek-v4-flash"],
    ])

    const settings = readRemoteSettings()

    expect(settings.provider.apiBaseUrl).toBe("")
    expect(settings.completion.provider).toBe("fim-direct")
    expect(settings.completion.profile).toBe("deepseek-fim")
    expect(settings.completion.apiBaseUrl).toBe("https://api.deepseek.com")
    expect(settings.completion.model).toBe("deepseek-v4-flash")

    await saveCompletionSettings({
      enabled: true,
      provider: "fim-direct",
      profile: "deepseek-fim",
      apiBaseUrl: "https://api.deepseek.com/beta",
      model: "deepseek-v4-flash",
      maxTokens: 512,
      contextLength: 200000,
      temperature: 0.1,
      topP: 0.9,
    })

    expect(configUpdates).toContainEqual({ key: "completion.provider", value: "fim-direct" })
    expect(configUpdates).toContainEqual({ key: "completion.profile", value: "deepseek-fim" })
    expect(configUpdates).toContainEqual({ key: "completion.apiBaseUrl", value: "https://api.deepseek.com/beta" })
    expect(configUpdates).not.toContainEqual({ key: "provider.apiBaseUrl", value: "https://api.deepseek.com/beta" })
  })
})

describe("tool settings", () => {
  test("disables model tool calling by default and reads explicit enablement", () => {
    expect(readRemoteSettings().tools.enabled).toBe(false)
    expect(readRemoteSettings().tools.maxAgentSteps).toBe(DEFAULT_TOOLS_MAX_AGENT_STEPS)

    configValues = new Map<string, unknown>([
      ["tools.enabled", true],
      ["tools.maxAgentSteps", 60],
    ])

    expect(readRemoteSettings().tools.enabled).toBe(true)
    expect(readRemoteSettings().tools.maxAgentSteps).toBe(60)
  })

  test("clamps tool max agent steps and falls back for invalid values", () => {
    configValues = new Map<string, unknown>([
      ["tools.maxAgentSteps", 999],
    ])
    expect(readRemoteSettings().tools.maxAgentSteps).toBe(100)

    configValues = new Map<string, unknown>([
      ["tools.maxAgentSteps", 0],
    ])
    expect(readRemoteSettings().tools.maxAgentSteps).toBe(1)

    configValues = new Map<string, unknown>([
      ["tools.maxAgentSteps", "not-a-number"],
    ])
    expect(readRemoteSettings().tools.maxAgentSteps).toBe(DEFAULT_TOOLS_MAX_AGENT_STEPS)
  })

  test("saves the model tool calling switch", async () => {
    await saveToolsEnabled(true)

    expect(configUpdates).toEqual([{ key: "tools.enabled", value: true }])
  })
})

describe("skill settings", () => {
  test("scans user skills by default and keeps explicit disablement", () => {
    expect(readRemoteSettings().skills.scanUserSkills).toBe(true)
    expect(readRemoteSettings().skills.scanClaudeSkills).toBe(true)

    configValues = new Map<string, unknown>([
      ["skills.scanUserSkills", false],
    ])

    expect(readRemoteSettings().skills.scanUserSkills).toBe(false)
  })
})

describe("context settings", () => {
  test("defaults and clamps chat history memory summary settings", () => {
    let settings = readRemoteSettings()

    expect(settings.context.maxHistoryTurns).toBe(10)
    expect(settings.context.maxHistoryBytes).toBe(40000)
    expect(settings.context.memorySummary).toEqual({
      enabled: true,
      maxBytes: 12000,
      triggerOverflowTurns: 2,
    })

    configValues = new Map<string, unknown>([
      ["context.maxHistoryTurns", 99],
      ["context.maxHistoryBytes", 999999],
      ["context.memorySummary.enabled", false],
      ["context.memorySummary.maxBytes", 999999],
      ["context.memorySummary.triggerOverflowTurns", 99],
    ])
    settings = readRemoteSettings()

    expect(settings.context.maxHistoryTurns).toBe(20)
    expect(settings.context.maxHistoryBytes).toBe(200000)
    expect(settings.context.memorySummary).toEqual({
      enabled: false,
      maxBytes: 80000,
      triggerOverflowTurns: 20,
    })

    configValues = new Map<string, unknown>([
      ["context.maxHistoryTurns", -1],
      ["context.maxHistoryBytes", -1],
      ["context.memorySummary.maxBytes", -1],
      ["context.memorySummary.triggerOverflowTurns", -1],
    ])
    settings = readRemoteSettings()

    expect(settings.context.maxHistoryTurns).toBe(0)
    expect(settings.context.maxHistoryBytes).toBe(0)
    expect(settings.context.memorySummary.maxBytes).toBe(0)
    expect(settings.context.memorySummary.triggerOverflowTurns).toBe(0)
  })
})

describe("RAG settings validation", () => {
  test("uses 64 as the default embedding batch size", () => {
    const settings = readRemoteSettings()

    expect(settings.rag.embedding.batchSize).toBe(RAG_EMBEDDING_BATCH_SIZE_DEFAULT)
    expect(settings.rag.embedding.batchSize).toBe(64)
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
    expect(settings.rag.embedding.model).toBe(DEFAULT_RAG_EMBEDDING_MODEL)
    expect(settings.rag.rerank.model).toBe(DEFAULT_RAG_RERANK_MODEL)
    expect(settings.rag.indexTests).toBe(false)
    expect(settings.codeGraph.indexTests).toBe(false)
  })

  test("derives embedding timeout from the configured batch size", () => {
    expect(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS).toBe(60000)
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

  test("falls back to 64 for non-finite saved batch size values and saves the derived timeout", async () => {
    await saveRagSettings(ragInput({ embeddingBatchSize: Number.NaN, embeddingTimeoutMs: 90000 }))

    expect(configUpdates.find((update) => update.key === "rag.embedding.batchSize")?.value).toBe(64)
    expect(configUpdates.find((update) => update.key === "rag.embedding.timeoutMs")?.value).toBe(RAG_EMBEDDING_TIMEOUT_DEFAULT_MS)
    expect(validateRagEmbeddingBatchSize(Number.NaN)).toBe(64)
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
      indexTests: true,
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

  test("saves the RAG test-directory indexing policy", async () => {
    await saveRagSettings(ragInput({ indexTests: true }))

    expect(configUpdates.find((update) => update.key === "rag.indexTests")?.value).toBe(true)
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
    indexTests: false,
    vectorTopK: 24,
    rerankTopK: 16,
    ...overrides,
  }
}

function secretContext() {
  return {
    secrets: {
      get: async (key: string) => secretValues.get(key),
      store: async (key: string, value: string) => {
        secretValues.set(key, value)
        secretStores.push({ key, value })
      },
      delete: async (key: string) => {
        secretValues.delete(key)
        secretDeletes.push(key)
      },
    },
  } as Parameters<typeof saveConnectionSettings>[0]
}
