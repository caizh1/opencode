import * as vscode from "vscode"
import { CHIPMATE_CONFIG_SECTION, CHIPMATE_LOCAL_AGENT_ID, PROVIDER_API_KEY_SECRET_KEY, RAG_API_KEY_SECRET_KEY } from "./chipmate-constants"
import { RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT } from "./rag-token"
import type { CodeGraphAnalysisMode, CompletionCommentGuidedRetrievalMode, CompletionLogLevel, CompletionProfile, CompletionProvider, PermissionMode, RagEmbeddingCheckpointMode, RagEmbeddingEncodingFormat, RemoteSettings } from "./types"

export const PASSWORD_SECRET_KEY = "chipmate.provider.legacyPassword"
export const COMPLETION_API_KEY_SECRET_KEY = PROVIDER_API_KEY_SECRET_KEY
export const RAG_EMBEDDING_BATCH_SIZE_DEFAULT = 128
export const RAG_EMBEDDING_BATCH_SIZE_OPTIONS = [1, 5, 10, 32, 64, 128, 256, 512] as const
export const RAG_EMBEDDING_BATCH_SIZE_MIN = 1
export const RAG_EMBEDDING_BATCH_SIZE_MAX = 512
export const RAG_EMBEDDING_BATCH_SIZE_ERROR = "Embedding batch size must be one of 1, 5, 10, 32, 64, 128, 256, or 512."
export const RAG_EMBEDDING_TIMEOUT_DEFAULT_MS = 60000
export const RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS = 90000
export const RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT = 3
export const RAG_EMBEDDING_CONCURRENT_REQUESTS_MIN = 1
export const RAG_EMBEDDING_CONCURRENT_REQUESTS_MAX = 8
export const RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT = 360000
export const RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MIN = 32768
export const RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MAX = 1_000_000
export const RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT: RagEmbeddingEncodingFormat = "auto"
export const RAG_EMBEDDING_ENCODING_FORMATS = ["float", "base64", "auto"] as const
export const RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS = 0
export const RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT: RagEmbeddingCheckpointMode = "interval"
export const RAG_EMBEDDING_CHECKPOINT_MODES = ["off", "interval", "safe"] as const
export const RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT = 8192
export const RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS = 120000

export type ConnectionSettingsInput = {
  serverUrl: string
  username: string
  password?: string
}

export type CompletionSettingsInput = {
  enabled: boolean
  provider: CompletionProvider
  profile: CompletionProfile
  apiBaseUrl: string
  model: string
  maxTokens: number
  temperature: number
  topP: number
}

export type ProviderSettingsInput = {
  apiBaseUrl: string
  chatModel: string
  maxTokens: number
  temperature: number
  topP: number
}

export type RagSettingsInput = {
  embeddingEndpoint: string
  embeddingModel: string
  embeddingBatchSize: number
  embeddingMaxTokensPerRequest: number
  embeddingConcurrentRequests: number
  embeddingMaxInFlightTokens: number
  embeddingEncodingFormat: RagEmbeddingEncodingFormat | string
  embeddingCheckpointMode: RagEmbeddingCheckpointMode | string
  embeddingCheckpointChunkInterval: number
  embeddingCheckpointIntervalMs: number
  embeddingTimeoutMs?: number
  embeddingRequestDelayMs: number
  embeddingMaxRequestsPerRun: number
  embeddingMaxRetries: number
  embeddingRetryBackoffMs: number
  embeddingResumeAutomatically: boolean
  embeddingResumeDelayMs: number
  rerankEndpoint: string
  rerankModel: string
  allowedHosts: string[]
  indexTests: boolean
  vectorTopK: number
  rerankTopK: number
}

export type SettingsUpdate = {
  key: string
  value: unknown
  optional?: boolean
}

export type NormalizedRagSettingsInput = {
  embeddingEndpoint: string
  embeddingModel: string
  embeddingBatchSize: number
  embeddingMaxTokensPerRequest: number
  embeddingConcurrentRequests: number
  embeddingMaxInFlightTokens: number
  embeddingEncodingFormat: RagEmbeddingEncodingFormat
  embeddingCheckpointMode: RagEmbeddingCheckpointMode
  embeddingCheckpointChunkInterval: number
  embeddingCheckpointIntervalMs: number
  embeddingTimeoutMs: number
  embeddingRequestDelayMs: number
  embeddingMaxRequestsPerRun: number
  embeddingMaxRetries: number
  embeddingRetryBackoffMs: number
  embeddingResumeAutomatically: boolean
  embeddingResumeDelayMs: number
  rerankEndpoint: string
  rerankModel: string
  allowedHosts: string[]
  indexTests: boolean
  vectorTopK: number
  rerankTopK: number
}

export function readRemoteSettings(): RemoteSettings {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  const providerApiBaseUrl = normalizeServerUrl(config.get<string>("provider.apiBaseUrl", ""))
  const providerChatModel = config.get<string>("provider.chatModel", "").trim()
  const ragEmbeddingEndpoint = normalizeServerUrl(config.get<string>("rag.embedding.endpoint", ""))
  const ragRerankEndpoint = normalizeServerUrl(config.get<string>("rag.rerank.endpoint", ""))
  const ragEmbeddingBatchSize = readRagEmbeddingBatchSize(config.get<unknown>("rag.embedding.batchSize", RAG_EMBEDDING_BATCH_SIZE_DEFAULT))
  return {
    provider: {
      apiBaseUrl: providerApiBaseUrl,
      chatModel: providerChatModel,
      maxTokens: Math.max(1, Math.min(131072, config.get<number>("provider.maxTokens", 4096))),
      temperature: Math.max(0, Math.min(2, config.get<number>("provider.temperature", 0.2))),
      topP: Math.max(0, Math.min(1, config.get<number>("provider.topP", 1))),
    },
    serverUrl: providerApiBaseUrl,
    username: "chipmate",
    defaultModel: providerChatModel,
    defaultAgent: config.get<string>("defaultAgent", ""),
    localOnlyAgent: CHIPMATE_LOCAL_AGENT_ID,
    context: {
      maxFileBytes: Math.max(1000, config.get<number>("context.maxFileBytes", 16000)),
      maxFiles: Math.max(1, Math.min(50, config.get<number>("context.maxFiles", 8))),
      includeDiagnostics: config.get<boolean>("context.includeDiagnostics", true),
      includeGitDiff: config.get<boolean>("context.includeGitDiff", false),
      localOnlyMode: config.get<boolean>("context.localOnlyMode", true),
      strictLocalOnlyAgent: config.get<boolean>("context.strictLocalOnlyAgent", true),
      maxHistoryTurns: Math.max(0, Math.min(20, config.get<number>("context.maxHistoryTurns", 3))),
      maxHistoryBytes: Math.max(0, Math.min(200000, config.get<number>("context.maxHistoryBytes", 12000))),
    },
    permissions: {
      mode: readPermissionMode(config.get<string>("permissions.mode", "ask")),
    },
    tools: {
      enabled: config.get<boolean>("tools.enabled", false),
    },
    skills: {
      enabled: readStringArray(config.get<unknown>("skills.enabled", [])),
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: config.get<boolean>("completion.enabled", false),
      provider: readCompletionProvider(config.get<string>("completion.provider", "openai-compatible")),
      profile: readCompletionProfile(config.get<string>("completion.profile", "qwen-coder-fim")),
      apiBaseUrl: providerApiBaseUrl,
      model: config.get<string>("completion.model", "").trim(),
      maxTokens: Math.max(1, Math.min(4096, config.get<number>("completion.maxTokens", 128))),
      temperature: Math.max(0, Math.min(2, config.get<number>("completion.temperature", 0))),
      topP: Math.max(0, Math.min(1, config.get<number>("completion.topP", 1))),
      debounceMs: Math.max(0, config.get<number>("completion.debounceMs", 350)),
      logLevel: readCompletionLogLevel(config.get<string>("completion.logLevel", "info")),
      debugFullRetrievalProbe: readBooleanEnv("COMPLETION_DEBUG_FULL_RETRIEVAL") ?? config.get<boolean>("completion.debugFullRetrievalProbe", false),
      debugExpectedSymbol: (process.env.COMPLETION_DEBUG_EXPECTED_SYMBOL ?? config.get<string>("completion.debugExpectedSymbol", "")).trim(),
      commentGuidedRetrievalMode: readCompletionCommentGuidedRetrievalMode(
        process.env.COMPLETION_COMMENT_GUIDED_RETRIEVAL_MODE ?? config.get<string>("completion.commentGuidedRetrievalMode", "qa-exact"),
      ),
    },
    codeGraph: {
      enabled: config.get<boolean>("codeGraph.enabled", true),
      promptOnWorkspaceOpen: config.get<boolean>("codeGraph.promptOnWorkspaceOpen", true),
      analysisMode: readCodeGraphAnalysisMode(config.get<string>("codeGraph.analysisMode", "auto")),
      maxFiles: Math.max(100, Math.min(250000, config.get<number>("codeGraph.maxFiles", 50000))),
      maxContextBytes: Math.max(2000, Math.min(100000, config.get<number>("codeGraph.maxContextBytes", 24000))),
      maxEvidenceBytes: Math.max(4000, Math.min(200000, config.get<number>("codeGraph.maxEvidenceBytes", 60000))),
      maxGraphDepth: Math.max(1, Math.min(5, config.get<number>("codeGraph.maxGraphDepth", 2))),
      maxFanout: Math.max(5, Math.min(200, config.get<number>("codeGraph.maxFanout", 40))),
      maxDeepFiles: Math.max(1, Math.min(200, config.get<number>("codeGraph.maxDeepFiles", 24))),
      maxStateTransitions: Math.max(10, Math.min(1000, config.get<number>("codeGraph.maxStateTransitions", 120))),
      watcherRescanThreshold: Math.max(25, Math.min(10000, config.get<number>("codeGraph.watcherRescanThreshold", 750))),
      workerConcurrency: Math.max(1, Math.min(16, config.get<number>("codeGraph.workerConcurrency", 4))),
      queryCacheSize: Math.max(0, Math.min(500, config.get<number>("codeGraph.queryCacheSize", 80))),
      memoryLimitMb: Math.max(128, Math.min(32768, config.get<number>("codeGraph.memoryLimitMb", 4096))),
      compileCommandsPath: config.get<string>("codeGraph.compileCommandsPath", "").trim(),
      clangdPath: config.get<string>("codeGraph.clangdPath", "").trim(),
      scipClangPath: config.get<string>("codeGraph.scipClangPath", "").trim(),
      excludeGlobs: readStringArray(config.get<unknown>("codeGraph.excludeGlobs", [])),
      indexTests: config.get<boolean>("codeGraph.indexTests", false),
    },
    analysis: {
      bridgeEnabled: config.get<boolean>("analysis.bridge.enabled", true),
      maxEvidenceItems: Math.max(1, Math.min(200, config.get<number>("analysis.maxEvidenceItems", 40))),
      maxEvidenceBytes: Math.max(4000, Math.min(200000, config.get<number>("analysis.maxEvidenceBytes", 60000))),
      maxFileSliceBytes: Math.max(1000, Math.min(100000, config.get<number>("analysis.maxFileSliceBytes", 16000))),
      maxGraphEdges: Math.max(10, Math.min(1000, config.get<number>("analysis.maxGraphEdges", 120))),
      maxPaths: Math.max(1, Math.min(50, config.get<number>("analysis.maxPaths", 10))),
    },
    rag: {
      embedding: {
        enabled: Boolean(ragEmbeddingEndpoint) && !ragEmbeddingBatchSize.configError,
        endpoint: ragEmbeddingEndpoint,
        model: config.get<string>("rag.embedding.model", "").trim(),
        batchSize: ragEmbeddingBatchSize.batchSize,
        maxTokensPerRequest: clampInteger(config.get<number>("rag.embedding.maxTokensPerRequest", RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT), 1, 1_000_000, RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT),
        concurrentRequests: clampInteger(config.get<number>("rag.embedding.concurrentRequests", RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT), RAG_EMBEDDING_CONCURRENT_REQUESTS_MIN, RAG_EMBEDDING_CONCURRENT_REQUESTS_MAX, RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT),
        maxInFlightTokens: clampInteger(config.get<number>("rag.embedding.maxInFlightTokens", RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT), RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MIN, RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MAX, RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT),
        encodingFormat: readRagEmbeddingEncodingFormat(config.get<unknown>("rag.embedding.encodingFormat", RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT)),
        checkpointMode: readRagEmbeddingCheckpointMode(config.get<unknown>("rag.embedding.checkpointMode", RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT)),
        checkpointChunkInterval: clampInteger(config.get<number>("rag.embedding.checkpointChunkInterval", RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT), 0, 1_000_000, RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT),
        checkpointIntervalMs: clampInteger(config.get<number>("rag.embedding.checkpointIntervalMs", RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS), 0, 3_600_000, RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS),
        configError: ragEmbeddingBatchSize.configError,
        timeoutMs: ragEmbeddingTimeoutMsForBatchSize(ragEmbeddingBatchSize.batchSize),
        requestDelayMs: Math.max(0, Math.min(60000, config.get<number>("rag.embedding.requestDelayMs", RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS))),
        maxRequestsPerRun: Math.max(0, Math.min(100000, config.get<number>("rag.embedding.maxRequestsPerRun", 100))),
        maxRetries: Math.max(0, Math.min(10, config.get<number>("rag.embedding.maxRetries", 3))),
        retryBackoffMs: Math.max(0, Math.min(120000, config.get<number>("rag.embedding.retryBackoffMs", 2000))),
        resumeAutomatically: config.get<boolean>("rag.embedding.resumeAutomatically", true),
        resumeDelayMs: Math.max(0, Math.min(3600000, config.get<number>("rag.embedding.resumeDelayMs", 60000))),
      },
      rerank: {
        enabled: Boolean(ragRerankEndpoint),
        endpoint: ragRerankEndpoint,
        model: config.get<string>("rag.rerank.model", "").trim(),
      },
      allowedHosts: readStringArray(config.get<unknown>("rag.allowedHosts", [])),
      indexTests: config.get<boolean>("rag.indexTests", false),
      vectorTopK: Math.max(0, Math.min(200, config.get<number>("rag.vectorTopK", 24))),
      rerankTopK: Math.max(0, Math.min(200, config.get<number>("rag.rerankTopK", 16))),
    },
  }
}

function readBooleanEnv(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  return /^(?:1|true|yes|on)$/i.test(value)
}

export async function readRemotePassword(context: vscode.ExtensionContext) {
  return context.secrets.get(PASSWORD_SECRET_KEY)
}

export async function writeRemotePassword(context: vscode.ExtensionContext, password: string | undefined) {
  if (password) {
    await context.secrets.store(PASSWORD_SECRET_KEY, password)
    return
  }
  await context.secrets.delete(PASSWORD_SECRET_KEY)
}

export async function readCompletionApiKey(context: vscode.ExtensionContext) {
  return context.secrets.get(COMPLETION_API_KEY_SECRET_KEY)
}

export async function readRagApiKey(context: vscode.ExtensionContext) {
  return context.secrets.get(RAG_API_KEY_SECRET_KEY)
}

export async function writeCompletionApiKey(context: vscode.ExtensionContext, apiKey: string | undefined) {
  const value = apiKey?.trim()
  if (value) {
    await context.secrets.store(COMPLETION_API_KEY_SECRET_KEY, value)
    return
  }
  await context.secrets.delete(COMPLETION_API_KEY_SECRET_KEY)
}

export async function writeRagApiKey(context: vscode.ExtensionContext, apiKey: string | undefined) {
  const value = apiKey?.trim()
  if (value) {
    await context.secrets.store(RAG_API_KEY_SECRET_KEY, value)
    return
  }
  await context.secrets.delete(RAG_API_KEY_SECRET_KEY)
}

export async function promptAndSaveCompletionApiKey(context: vscode.ExtensionContext) {
  const apiKey = await vscode.window.showInputBox({
    title: "ChipMate provider API key",
    prompt: "Bearer token for the OpenAI-compatible provider. Leave empty to clear it.",
    password: true,
    ignoreFocusOut: true,
  })
  if (apiKey === undefined) return false
  await writeCompletionApiKey(context, apiKey || undefined)
  return true
}

export async function promptAndSaveRagApiKey(context: vscode.ExtensionContext) {
  const apiKey = await vscode.window.showInputBox({
    title: "RAG API key",
    prompt: "Bearer token for the embedding and rerank HTTP services. Leave empty to clear it.",
    password: true,
    ignoreFocusOut: true,
  })
  if (apiKey === undefined) return false
  await writeRagApiKey(context, apiKey || undefined)
  return true
}

export async function promptAndSaveConnectionSettings(context: vscode.ExtensionContext) {
  const input = await promptConnectionSettings()
  if (!input) return false
  await saveConnectionSettings(context, input)
  return true
}

export async function promptConnectionSettings(): Promise<ConnectionSettingsInput | undefined> {
  const current = readRemoteSettings()
  const serverUrl = await vscode.window.showInputBox({
    title: "ChipMate provider API base URL",
    prompt: "Enter the OpenAI-compatible base URL, for example http://localhost:8000/v1.",
    value: current.provider.apiBaseUrl,
    ignoreFocusOut: true,
  })
  if (!serverUrl) return undefined

  const username = await vscode.window.showInputBox({
    title: "ChipMate chat model",
    prompt: "Model name for /chat/completions.",
    value: current.provider.chatModel,
    ignoreFocusOut: true,
  })
  if (username === undefined) return undefined

  const password = await vscode.window.showInputBox({
    title: "ChipMate provider API key",
    prompt: "Bearer token for the provider. Leave empty if the service is unsecured.",
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return undefined

  return { serverUrl, username, password }
}

export async function saveConnectionSettings(context: vscode.ExtensionContext, input: ConnectionSettingsInput) {
  const settings = settingsFromConnectionInput(input)

  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("provider.apiBaseUrl", settings.serverUrl, vscode.ConfigurationTarget.Global)
  await config.update("provider.chatModel", settings.defaultModel, vscode.ConfigurationTarget.Global)
  if (connectionInputHasPassword(input)) await writeCompletionApiKey(context, input.password?.trim() || undefined)
}

export function connectionInputHasPassword(input: ConnectionSettingsInput) {
  return Object.prototype.hasOwnProperty.call(input, "password")
}

export async function saveCompletionSettings(input: CompletionSettingsInput) {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("completion.enabled", input.enabled, vscode.ConfigurationTarget.Global)
  await config.update("completion.profile", readCompletionProfile(input.profile), vscode.ConfigurationTarget.Global)
  if (input.apiBaseUrl !== undefined) await config.update("provider.apiBaseUrl", normalizeServerUrl(input.apiBaseUrl), vscode.ConfigurationTarget.Global)
  await config.update("completion.model", input.model.trim(), vscode.ConfigurationTarget.Global)
  await config.update("completion.maxTokens", Math.max(1, Math.min(4096, Math.floor(input.maxTokens))), vscode.ConfigurationTarget.Global)
  await config.update("completion.temperature", Math.max(0, Math.min(2, input.temperature)), vscode.ConfigurationTarget.Global)
  await config.update("completion.topP", Math.max(0, Math.min(1, input.topP)), vscode.ConfigurationTarget.Global)
}

export async function saveProviderSettings(input: ProviderSettingsInput) {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("provider.apiBaseUrl", normalizeServerUrl(input.apiBaseUrl), vscode.ConfigurationTarget.Global)
  await config.update("provider.chatModel", input.chatModel.trim(), vscode.ConfigurationTarget.Global)
  await config.update("provider.maxTokens", Math.max(1, Math.min(131072, Math.floor(input.maxTokens))), vscode.ConfigurationTarget.Global)
  await config.update("provider.temperature", Math.max(0, Math.min(2, input.temperature)), vscode.ConfigurationTarget.Global)
  await config.update("provider.topP", Math.max(0, Math.min(1, input.topP)), vscode.ConfigurationTarget.Global)
}

export async function savePermissionMode(mode: PermissionMode) {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("permissions.mode", readPermissionMode(mode), vscode.ConfigurationTarget.Global)
}

export async function saveToolsEnabled(enabled: boolean) {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("tools.enabled", Boolean(enabled), vscode.ConfigurationTarget.Global)
}

export async function saveSkillsSettings(enabled: string[]) {
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  await config.update("skills.enabled", cleanStringArray(enabled), vscode.ConfigurationTarget.Global)
}

export async function saveRagSettings(input: RagSettingsInput) {
  const updates = ragSettingsUpdates(input)
  const config = vscode.workspace.getConfiguration(CHIPMATE_CONFIG_SECTION)
  for (const update of updates) {
    try {
      await config.update(update.key, update.value, vscode.ConfigurationTarget.Global)
    } catch (error) {
      if (update.optional && isUnregisteredConfigurationError(error)) continue
      throw error
    }
  }
}

export function ragSettingsUpdates(input: RagSettingsInput): SettingsUpdate[] {
  const normalized = normalizeRagSettingsInput(input)
  return [
    { key: "rag.embedding.endpoint", value: normalized.embeddingEndpoint },
    { key: "rag.embedding.model", value: normalized.embeddingModel },
    { key: "rag.embedding.batchSize", value: normalized.embeddingBatchSize },
    { key: "rag.embedding.maxTokensPerRequest", value: normalized.embeddingMaxTokensPerRequest, optional: true },
    { key: "rag.embedding.concurrentRequests", value: normalized.embeddingConcurrentRequests, optional: true },
    { key: "rag.embedding.maxInFlightTokens", value: normalized.embeddingMaxInFlightTokens, optional: true },
    { key: "rag.embedding.encodingFormat", value: normalized.embeddingEncodingFormat, optional: true },
    { key: "rag.embedding.checkpointMode", value: normalized.embeddingCheckpointMode, optional: true },
    { key: "rag.embedding.checkpointChunkInterval", value: normalized.embeddingCheckpointChunkInterval, optional: true },
    { key: "rag.embedding.checkpointIntervalMs", value: normalized.embeddingCheckpointIntervalMs, optional: true },
    { key: "rag.embedding.timeoutMs", value: normalized.embeddingTimeoutMs },
    { key: "rag.embedding.requestDelayMs", value: normalized.embeddingRequestDelayMs },
    { key: "rag.embedding.maxRequestsPerRun", value: normalized.embeddingMaxRequestsPerRun },
    { key: "rag.embedding.maxRetries", value: normalized.embeddingMaxRetries },
    { key: "rag.embedding.retryBackoffMs", value: normalized.embeddingRetryBackoffMs },
    { key: "rag.embedding.resumeAutomatically", value: normalized.embeddingResumeAutomatically },
    { key: "rag.embedding.resumeDelayMs", value: normalized.embeddingResumeDelayMs },
    { key: "rag.rerank.endpoint", value: normalized.rerankEndpoint },
    { key: "rag.rerank.model", value: normalized.rerankModel },
    { key: "rag.allowedHosts", value: normalized.allowedHosts },
    { key: "rag.indexTests", value: normalized.indexTests },
    { key: "rag.vectorTopK", value: normalized.vectorTopK },
    { key: "rag.rerankTopK", value: normalized.rerankTopK },
  ]
}

export function normalizeRagSettingsInput(input: RagSettingsInput): NormalizedRagSettingsInput {
  const embeddingBatchSize = validateRagEmbeddingBatchSize(input.embeddingBatchSize)
  return {
    embeddingEndpoint: normalizeServerUrl(input.embeddingEndpoint),
    embeddingModel: input.embeddingModel.trim(),
    embeddingBatchSize,
    embeddingMaxTokensPerRequest: clampInteger(input.embeddingMaxTokensPerRequest, 1, 1_000_000, RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT),
    embeddingConcurrentRequests: clampInteger(input.embeddingConcurrentRequests, RAG_EMBEDDING_CONCURRENT_REQUESTS_MIN, RAG_EMBEDDING_CONCURRENT_REQUESTS_MAX, RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT),
    embeddingMaxInFlightTokens: clampInteger(input.embeddingMaxInFlightTokens, RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MIN, RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_MAX, RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT),
    embeddingEncodingFormat: readRagEmbeddingEncodingFormat(input.embeddingEncodingFormat),
    embeddingCheckpointMode: readRagEmbeddingCheckpointMode(input.embeddingCheckpointMode),
    embeddingCheckpointChunkInterval: clampInteger(input.embeddingCheckpointChunkInterval, 0, 1_000_000, RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT),
    embeddingCheckpointIntervalMs: clampInteger(input.embeddingCheckpointIntervalMs, 0, 3_600_000, RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS),
    embeddingTimeoutMs: ragEmbeddingTimeoutMsForBatchSize(embeddingBatchSize),
    embeddingRequestDelayMs: clampInteger(input.embeddingRequestDelayMs, 0, 60000, RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS),
    embeddingMaxRequestsPerRun: clampInteger(input.embeddingMaxRequestsPerRun, 0, 100000, 100),
    embeddingMaxRetries: clampInteger(input.embeddingMaxRetries, 0, 10, 3),
    embeddingRetryBackoffMs: clampInteger(input.embeddingRetryBackoffMs, 0, 120000, 2000),
    embeddingResumeAutomatically: Boolean(input.embeddingResumeAutomatically),
    embeddingResumeDelayMs: clampInteger(input.embeddingResumeDelayMs, 0, 3600000, 60000),
    rerankEndpoint: normalizeServerUrl(input.rerankEndpoint),
    rerankModel: input.rerankModel.trim(),
    allowedHosts: cleanStringArray(input.allowedHosts),
    indexTests: Boolean(input.indexTests),
    vectorTopK: clampInteger(input.vectorTopK, 0, 200, 24),
    rerankTopK: clampInteger(input.rerankTopK, 0, 200, 16),
  }
}

export function normalizeCurrentRagSettings(settings = readRemoteSettings().rag): NormalizedRagSettingsInput {
  return {
    embeddingEndpoint: settings.embedding.endpoint,
    embeddingModel: settings.embedding.model,
    embeddingBatchSize: settings.embedding.batchSize,
    embeddingMaxTokensPerRequest: settings.embedding.maxTokensPerRequest,
    embeddingConcurrentRequests: settings.embedding.concurrentRequests,
    embeddingMaxInFlightTokens: settings.embedding.maxInFlightTokens,
    embeddingEncodingFormat: settings.embedding.encodingFormat,
    embeddingCheckpointMode: settings.embedding.checkpointMode,
    embeddingCheckpointChunkInterval: settings.embedding.checkpointChunkInterval,
    embeddingCheckpointIntervalMs: settings.embedding.checkpointIntervalMs,
    embeddingTimeoutMs: settings.embedding.timeoutMs,
    embeddingRequestDelayMs: settings.embedding.requestDelayMs,
    embeddingMaxRequestsPerRun: settings.embedding.maxRequestsPerRun,
    embeddingMaxRetries: settings.embedding.maxRetries,
    embeddingRetryBackoffMs: settings.embedding.retryBackoffMs,
    embeddingResumeAutomatically: settings.embedding.resumeAutomatically,
    embeddingResumeDelayMs: settings.embedding.resumeDelayMs,
    rerankEndpoint: settings.rerank.endpoint,
    rerankModel: settings.rerank.model,
    allowedHosts: cleanStringArray(settings.allowedHosts),
    indexTests: settings.indexTests,
    vectorTopK: settings.vectorTopK,
    rerankTopK: settings.rerankTopK,
  }
}

export function ragSettingsInputMatchesCurrent(input: RagSettingsInput, current = readRemoteSettings().rag) {
  return normalizedRagSettingsEqual(normalizeRagSettingsInput(input), normalizeCurrentRagSettings(current))
}

export function ragSettingsInputChangesEmbeddingIdentity(input: RagSettingsInput, current = readRemoteSettings().rag) {
  const next = normalizeRagSettingsInput(input)
  const previous = normalizeCurrentRagSettings(current)
  return next.embeddingEndpoint !== previous.embeddingEndpoint || next.embeddingModel !== previous.embeddingModel
}

function normalizedRagSettingsEqual(left: NormalizedRagSettingsInput, right: NormalizedRagSettingsInput) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function settingsFromConnectionInput(input: ConnectionSettingsInput): RemoteSettings {
  const serverUrl = normalizeServerUrl(input.serverUrl)
  if (!serverUrl) throw new Error("ChipMate provider API base URL is required.")
  return {
    ...readRemoteSettings(),
    provider: {
      ...readRemoteSettings().provider,
      apiBaseUrl: serverUrl,
      chatModel: input.username.trim(),
    },
    serverUrl,
    username: "chipmate",
    defaultModel: input.username.trim(),
  }
}

export function normalizeServerUrl(input: string) {
  const value = input.trim()
  if (!value) return ""
  return value.replace(/\/+$/, "")
}

function readCompletionLogLevel(input: string): CompletionLogLevel {
  if (input === "off" || input === "info" || input === "debug") return input
  return "info"
}

function readCompletionCommentGuidedRetrievalMode(input: string | undefined): CompletionCommentGuidedRetrievalMode {
  return input === "completion" ? "completion" : "qa-exact"
}

function readCompletionProvider(input: string): CompletionProvider {
  if (input === "openai-compatible") return input
  return "openai-compatible"
}

function readPermissionMode(input: string): PermissionMode {
  if (input === "auto" || input === "full-access") return input
  return "ask"
}

function readCompletionProfile(input: string): CompletionProfile {
  if (input === "generic-chat" || input === "qwen-coder-fim") return input
  return "generic-chat"
}

function readCodeGraphAnalysisMode(input: string): CodeGraphAnalysisMode {
  if (input === "auto" || input === "fast" || input === "ast" || input === "semantic") return input
  return "auto"
}

function readStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return cleanStringArray(input)
}

function cleanStringArray(input: unknown[]) {
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function readRagEmbeddingBatchSize(input: unknown) {
  const value = Number(input)
  if (!Number.isFinite(value)) {
    return {
      batchSize: RAG_EMBEDDING_BATCH_SIZE_DEFAULT,
      configError: RAG_EMBEDDING_BATCH_SIZE_ERROR,
    }
  }
  if (!Number.isInteger(value) || !isAllowedRagEmbeddingBatchSize(value)) {
    return {
      batchSize: Math.floor(value),
      configError: RAG_EMBEDDING_BATCH_SIZE_ERROR,
    }
  }
  return { batchSize: value }
}

export function validateRagEmbeddingBatchSize(input: unknown) {
  const value = Number(input)
  if (!Number.isFinite(value)) return RAG_EMBEDDING_BATCH_SIZE_DEFAULT
  if (!Number.isInteger(value) || !isAllowedRagEmbeddingBatchSize(value)) {
    throw new Error(RAG_EMBEDDING_BATCH_SIZE_ERROR)
  }
  return value
}

export function ragEmbeddingTimeoutMsForBatchSize(input: unknown) {
  return Number(input) === RAG_EMBEDDING_BATCH_SIZE_MAX ? RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS : RAG_EMBEDDING_TIMEOUT_DEFAULT_MS
}

export function readRagEmbeddingCheckpointMode(input: unknown): RagEmbeddingCheckpointMode {
  return input === "off" || input === "safe" ? input : RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT
}

export function readRagEmbeddingEncodingFormat(input: unknown): RagEmbeddingEncodingFormat {
  return input === "base64" || input === "auto" ? input : RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT
}

function isUnregisteredConfigurationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /not a registered configuration/i.test(message)
}

function isAllowedRagEmbeddingBatchSize(value: number) {
  return RAG_EMBEDDING_BATCH_SIZE_OPTIONS.includes(value as typeof RAG_EMBEDDING_BATCH_SIZE_OPTIONS[number])
}

function clampInteger(input: number, min: number, max: number, fallback: number) {
  const value = Math.floor(Number(input))
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}
