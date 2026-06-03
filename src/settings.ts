import * as vscode from "vscode"
import { RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT } from "./rag-token"
import type { CodeGraphAnalysisMode, CompletionLogLevel, CompletionProfile, CompletionProvider, RemoteSettings } from "./types"

export const PASSWORD_SECRET_KEY = "opencode.remote.password"
export const COMPLETION_API_KEY_SECRET_KEY = "opencode.remote.completion.apiKey"
export const RAG_API_KEY_SECRET_KEY = "opencode.remote.rag.apiKey"
export const RAG_EMBEDDING_BATCH_SIZE_DEFAULT = 128
export const RAG_EMBEDDING_BATCH_SIZE_OPTIONS = [32, 64, 128, 256, 512] as const
export const RAG_EMBEDDING_BATCH_SIZE_MIN = 32
export const RAG_EMBEDDING_BATCH_SIZE_MAX = 512
export const RAG_EMBEDDING_BATCH_SIZE_ERROR = "Embedding batch size must be one of 32, 64, 128, 256, or 512."
export const RAG_EMBEDDING_TIMEOUT_DEFAULT_MS = 30000
export const RAG_EMBEDDING_TIMEOUT_LARGE_BATCH_MS = 90000

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

export type RagSettingsInput = {
  embeddingEndpoint: string
  embeddingModel: string
  embeddingBatchSize: number
  embeddingMaxTokensPerRequest: number
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
  vectorTopK: number
  rerankTopK: number
}

export type SettingsUpdate = {
  key: string
  value: unknown
  optional?: boolean
}

export function readRemoteSettings(): RemoteSettings {
  const config = vscode.workspace.getConfiguration("opencode.remote")
  const ragEmbeddingEndpoint = normalizeServerUrl(config.get<string>("rag.embedding.endpoint", ""))
  const ragRerankEndpoint = normalizeServerUrl(config.get<string>("rag.rerank.endpoint", ""))
  const ragEmbeddingBatchSize = readRagEmbeddingBatchSize(config.get<unknown>("rag.embedding.batchSize", RAG_EMBEDDING_BATCH_SIZE_DEFAULT))
  return {
    serverUrl: normalizeServerUrl(config.get<string>("serverUrl", "http://localhost:4096")),
    username: config.get<string>("username", "opencode"),
    defaultModel: config.get<string>("defaultModel", ""),
    defaultAgent: config.get<string>("defaultAgent", ""),
    localOnlyAgent: config.get<string>("localOnlyAgent", "vscode-local"),
    context: {
      maxFileBytes: Math.max(1000, config.get<number>("context.maxFileBytes", 16000)),
      maxFiles: Math.max(1, Math.min(50, config.get<number>("context.maxFiles", 8))),
      includeDiagnostics: config.get<boolean>("context.includeDiagnostics", true),
      includeGitDiff: config.get<boolean>("context.includeGitDiff", false),
      localOnlyMode: config.get<boolean>("context.localOnlyMode", true),
      strictLocalOnlyAgent: config.get<boolean>("context.strictLocalOnlyAgent", true),
    },
    completion: {
      enabled: config.get<boolean>("completion.enabled", false),
      provider: readCompletionProvider(config.get<string>("completion.provider", "opencode")),
      profile: readCompletionProfile(config.get<string>("completion.profile", "generic-chat")),
      apiBaseUrl: normalizeServerUrl(config.get<string>("completion.apiBaseUrl", "")),
      model: config.get<string>("completion.model", "").trim(),
      maxTokens: Math.max(1, Math.min(4096, config.get<number>("completion.maxTokens", 128))),
      temperature: Math.max(0, Math.min(2, config.get<number>("completion.temperature", 0))),
      topP: Math.max(0, Math.min(1, config.get<number>("completion.topP", 1))),
      debounceMs: Math.max(0, config.get<number>("completion.debounceMs", 350)),
      logLevel: readCompletionLogLevel(config.get<string>("completion.logLevel", "info")),
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
        configError: ragEmbeddingBatchSize.configError,
        timeoutMs: ragEmbeddingTimeoutMsForBatchSize(ragEmbeddingBatchSize.batchSize),
        requestDelayMs: Math.max(0, Math.min(60000, config.get<number>("rag.embedding.requestDelayMs", 500))),
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
      vectorTopK: Math.max(0, Math.min(200, config.get<number>("rag.vectorTopK", 24))),
      rerankTopK: Math.max(0, Math.min(200, config.get<number>("rag.rerankTopK", 16))),
    },
  }
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
    title: "Inline completion API key",
    prompt: "Bearer token for the direct completion model API. Leave empty to clear it.",
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
    title: "Remote OpenCode server URL",
    prompt: "Enter the base URL for opencode serve.",
    value: current.serverUrl,
    ignoreFocusOut: true,
  })
  if (!serverUrl) return undefined

  const username = await vscode.window.showInputBox({
    title: "Remote OpenCode username",
    prompt: "HTTP Basic Auth username. Leave as opencode unless you changed OPENCODE_SERVER_USERNAME.",
    value: current.username || "opencode",
    ignoreFocusOut: true,
  })
  if (username === undefined) return undefined

  const password = await vscode.window.showInputBox({
    title: "Remote OpenCode password",
    prompt: "HTTP Basic Auth password. Leave empty if the server is unsecured.",
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return undefined

  return { serverUrl, username, password }
}

export async function saveConnectionSettings(context: vscode.ExtensionContext, input: ConnectionSettingsInput) {
  const settings = settingsFromConnectionInput(input)

  const config = vscode.workspace.getConfiguration("opencode.remote")
  await config.update("serverUrl", settings.serverUrl, vscode.ConfigurationTarget.Global)
  await config.update("username", settings.username, vscode.ConfigurationTarget.Global)
  if (connectionInputHasPassword(input)) await writeRemotePassword(context, input.password?.trim() || undefined)
}

export function connectionInputHasPassword(input: ConnectionSettingsInput) {
  return Object.prototype.hasOwnProperty.call(input, "password")
}

export async function saveCompletionSettings(input: CompletionSettingsInput) {
  const config = vscode.workspace.getConfiguration("opencode.remote")
  await config.update("completion.enabled", input.enabled, vscode.ConfigurationTarget.Global)
  await config.update("completion.provider", input.provider, vscode.ConfigurationTarget.Global)
  await config.update("completion.profile", readCompletionProfile(input.profile), vscode.ConfigurationTarget.Global)
  await config.update("completion.apiBaseUrl", normalizeServerUrl(input.apiBaseUrl), vscode.ConfigurationTarget.Global)
  await config.update("completion.model", input.model.trim(), vscode.ConfigurationTarget.Global)
  await config.update("completion.maxTokens", Math.max(1, Math.min(4096, Math.floor(input.maxTokens))), vscode.ConfigurationTarget.Global)
  await config.update("completion.temperature", Math.max(0, Math.min(2, input.temperature)), vscode.ConfigurationTarget.Global)
  await config.update("completion.topP", Math.max(0, Math.min(1, input.topP)), vscode.ConfigurationTarget.Global)
}

export async function saveRagSettings(input: RagSettingsInput) {
  const updates = ragSettingsUpdates(input)
  const config = vscode.workspace.getConfiguration("opencode.remote")
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
  const embeddingBatchSize = validateRagEmbeddingBatchSize(input.embeddingBatchSize)
  return [
    { key: "rag.embedding.endpoint", value: normalizeServerUrl(input.embeddingEndpoint) },
    { key: "rag.embedding.model", value: input.embeddingModel.trim() },
    { key: "rag.embedding.batchSize", value: embeddingBatchSize },
    { key: "rag.embedding.maxTokensPerRequest", value: clampInteger(input.embeddingMaxTokensPerRequest, 1, 1_000_000, RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT), optional: true },
    { key: "rag.embedding.timeoutMs", value: ragEmbeddingTimeoutMsForBatchSize(embeddingBatchSize) },
    { key: "rag.embedding.requestDelayMs", value: clampInteger(input.embeddingRequestDelayMs, 0, 60000, 500) },
    { key: "rag.embedding.maxRequestsPerRun", value: clampInteger(input.embeddingMaxRequestsPerRun, 0, 100000, 100) },
    { key: "rag.embedding.maxRetries", value: clampInteger(input.embeddingMaxRetries, 0, 10, 3) },
    { key: "rag.embedding.retryBackoffMs", value: clampInteger(input.embeddingRetryBackoffMs, 0, 120000, 2000) },
    { key: "rag.embedding.resumeAutomatically", value: Boolean(input.embeddingResumeAutomatically) },
    { key: "rag.embedding.resumeDelayMs", value: clampInteger(input.embeddingResumeDelayMs, 0, 3600000, 60000) },
    { key: "rag.rerank.endpoint", value: normalizeServerUrl(input.rerankEndpoint) },
    { key: "rag.rerank.model", value: input.rerankModel.trim() },
    { key: "rag.allowedHosts", value: cleanStringArray(input.allowedHosts) },
    { key: "rag.vectorTopK", value: clampInteger(input.vectorTopK, 0, 200, 24) },
    { key: "rag.rerankTopK", value: clampInteger(input.rerankTopK, 0, 200, 16) },
  ]
}

export function settingsFromConnectionInput(input: ConnectionSettingsInput): RemoteSettings {
  const serverUrl = normalizeServerUrl(input.serverUrl)
  if (!serverUrl) throw new Error("Remote OpenCode server URL is required.")
  return {
    ...readRemoteSettings(),
    serverUrl,
    username: input.username.trim() || "opencode",
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

function readCompletionProvider(input: string): CompletionProvider {
  if (input === "opencode" || input === "openai-compatible") return input
  return "opencode"
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
