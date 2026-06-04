export type ConnectionState = "disconnected" | "connecting" | "connected" | "authFailed" | "error"
export type CompletionLogLevel = "off" | "info" | "debug"
export type CompletionProfile = "generic-chat" | "qwen-coder-fim"
export type CompletionProvider = "opencode" | "openai-compatible"
export type CodeGraphAnalysisMode = "auto" | "fast" | "ast" | "semantic"

export type RagEndpointKind = "disabled" | "localhost" | "private-lan" | "approved-host" | "blocked" | "error"
export type RagAvailability = "not-configured" | "not-indexed" | "checking" | "indexing" | "ready" | "partial" | "paused" | "unavailable"
export type RagIndexAvailability = "none" | "partial" | "ready" | "paused"
export type RagIndexPausedReason = "request-budget" | "rate-limit" | "provider-error"
export type RagResumeReason = "request-budget" | "rate-limit"
export type RagEmbeddingCheckpointMode = "off" | "interval" | "safe"
export type RagEmbeddingEncodingFormat = "float" | "base64" | "auto"

export type RagWorkerStatus = {
  configuredWorkers: number
  activeWorkers: number
  maxWorkers: number
  inFlightRequests: number
  queuePending: number
  lastChange?: {
    direction: "upgrade" | "degrade"
    fromWorkers: number
    toWorkers: number
    reason: string
    at: number
  }
}

export type RagIndexProgress = {
  phase: "batch" | "delay" | "rate-limit" | "paused"
  batchIndex?: number
  batchCount?: number
  requestNumber?: number
  requestLimit?: number
  inputCount?: number
  estimatedTokens?: number
  delayMs?: number
  status?: number
  retryAfterMs?: number
  retry?: number
  maxRetries?: number
  reason?: RagIndexPausedReason
  requestsUsed?: number
  message?: string
  embeddedChunks: number
  chunks: number
  pendingChunkCount: number
  elapsedMs?: number
  workerStatus?: RagWorkerStatus
  updatedAt: number
}

export type RagSettings = {
  embedding: {
    enabled: boolean
    endpoint: string
    model: string
    batchSize: number
    maxTokensPerRequest: number
    concurrentRequests: number
    maxInFlightTokens: number
    encodingFormat: RagEmbeddingEncodingFormat
    checkpointMode: RagEmbeddingCheckpointMode
    checkpointChunkInterval: number
    checkpointIntervalMs: number
    configError?: string
    timeoutMs: number
    requestDelayMs: number
    maxRequestsPerRun: number
    maxRetries: number
    retryBackoffMs: number
    resumeAutomatically: boolean
    resumeDelayMs: number
  }
  rerank: {
    enabled: boolean
    endpoint: string
    model: string
  }
  allowedHosts: string[]
  vectorTopK: number
  rerankTopK: number
}

export type RagStatus = {
  enabled: boolean
  availability?: RagAvailability
  indexAvailability?: RagIndexAvailability
  embeddingEnabled: boolean
  rerankEnabled: boolean
  endpointKind: RagEndpointKind
  chunks: number
  embeddedChunks: number
  indexedChunkCount?: number
  pendingChunkCount?: number
  indexProgress?: RagIndexProgress
  indexElapsedMs?: number
  workerStatus?: RagWorkerStatus
  indexPausedReason?: RagIndexPausedReason
  resumeScheduledAt?: number
  resumeDelayMs?: number
  resumeReason?: RagResumeReason
  vectorShards: number
  embeddingProvider?: string
  rerankProvider?: string
  dimension?: number
  updatedAt?: number
  lastError?: string
  rerankLastError?: string
  fallbackReason?: string
}

export type RagConfigurationApplyAction =
  | "status-refreshed"
  | "build-started"
  | "build-queued"
  | "disabled"
  | "unavailable"

export type RagConfigurationApplyOptions = {
  forceRebuild?: boolean
  preserveExistingIndex?: boolean
}

export type RagConfigurationApplyResult = {
  action: RagConfigurationApplyAction
  status: RagStatus
  hasReusableIndex: boolean
}

export type RemoteSettings = {
  serverUrl: string
  username: string
  defaultModel: string
  defaultAgent: string
  localOnlyAgent: string
  context: {
    maxFileBytes: number
    maxFiles: number
    includeDiagnostics: boolean
    includeGitDiff: boolean
    localOnlyMode: boolean
    strictLocalOnlyAgent: boolean
  }
  completion: {
    enabled: boolean
    provider: CompletionProvider
    profile: CompletionProfile
    apiBaseUrl: string
    model: string
    maxTokens: number
    temperature: number
    topP: number
    debounceMs: number
    logLevel: CompletionLogLevel
  }
  codeGraph: {
    enabled: boolean
    promptOnWorkspaceOpen: boolean
    analysisMode: CodeGraphAnalysisMode
    maxFiles: number
    maxContextBytes: number
    maxEvidenceBytes: number
    maxGraphDepth: number
    maxFanout: number
    maxDeepFiles: number
    maxStateTransitions: number
    watcherRescanThreshold: number
    workerConcurrency: number
    queryCacheSize: number
    memoryLimitMb: number
    compileCommandsPath: string
    clangdPath: string
    scipClangPath: string
    excludeGlobs: string[]
  }
  analysis: {
    bridgeEnabled: boolean
    maxEvidenceItems: number
    maxEvidenceBytes: number
    maxFileSliceBytes: number
    maxGraphEdges: number
    maxPaths: number
  }
  rag: RagSettings
}

export type HealthResponse = {
  healthy: boolean
  version?: string
}

export type OpenCodeSession = {
  id: string
  title?: string
  directory?: string
  time?: {
    created?: number
    updated?: number
  }
}

export type OpenCodeTokenUsage = {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type OpenCodeModelLimit = {
  context?: number
  output?: number
}

export type UsageLevel = "normal" | "warning" | "error"

export type RenderedUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost?: number
  summary: string
  detail: string
}

export type RenderedSessionUsage = {
  status: "pending" | "unavailable" | "available"
  summary: string
  detail: string
  level: UsageLevel
  latest?: RenderedUsage
  total?: RenderedUsage
  context?: {
    used: number
    limit?: number
    remaining?: number
    ratio?: number
    summary: string
    detail: string
  }
}

export type OpenCodeMessageInfo = {
  id: string
  sessionID?: string
  role?: "user" | "assistant"
  providerID?: string
  modelID?: string
  agent?: string
  mode?: string
  cost?: number
  tokens?: OpenCodeTokenUsage
  finish?: string
  summary?: unknown
  time?: {
    created?: number
    completed?: number
  }
  error?: {
    name?: string
    message?: string
  }
}

export type OpenCodePart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "reasoning"
      text: string
    }
  | {
      type: "file"
      filename?: string
      url?: string
      mime?: string
    }
  | {
      type: "tool"
      tool?: string
      callID?: string
      state?: {
        status?: string
        input?: unknown
        output?: unknown
        error?: unknown
        metadata?: unknown
      }
    }
  | {
      type: string
      [key: string]: unknown
    }

export type OpenCodeMessage = {
  info: OpenCodeMessageInfo
  parts: OpenCodePart[]
}

export type OpenCodeMessagePart = OpenCodePart & {
  id?: string
  sessionID?: string
  messageID?: string
}

export type OpenCodeSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: string; [key: string]: unknown }

export type OpenCodeEvent =
  | { type: "server.connected"; properties?: Record<string, unknown> }
  | { type: "message.updated"; properties: { info?: OpenCodeMessageInfo } }
  | { type: "message.removed"; properties: { sessionID?: string; messageID?: string } }
  | { type: "message.part.updated"; properties: { part?: OpenCodeMessagePart; delta?: string } }
  | {
      type: "message.part.delta"
      properties: {
        sessionID?: string
        messageID?: string
        partID?: string
        delta?: string
        text?: string
        type?: string
        part?: OpenCodeMessagePart
      }
    }
  | { type: "message.part.removed"; properties: { sessionID?: string; messageID?: string; partID?: string } }
  | { type: "session.status"; properties: { sessionID?: string; status?: OpenCodeSessionStatus } }
  | { type: "session.error"; properties: { sessionID?: string; error?: OpenCodeMessageInfo["error"] | { data?: { message?: string }; message?: string } } }
  | { type: "session.created" | "session.updated" | "session.deleted"; properties: { info?: OpenCodeSession } }
  | { type: string; properties?: Record<string, unknown> }

export type OpenCodeGlobalEvent = {
  directory?: string
  payload?: OpenCodeEvent
}

export type ChatContextOptions = {
  includeSelection: boolean
  includeCurrentFile: boolean
  includeOpenFiles: boolean
  includeDiagnostics: boolean
  includeGitDiff: boolean
}

export type PromptModel = {
  providerID: string
  modelID: string
}

export type OpenCodeModelInfo = {
  id: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  isDefault: boolean
  contextLimit?: number
  outputLimit?: number
}

export type OpenCodeAgentInfo = {
  id: string
  name: string
  description?: string
  mode?: string
  color?: string
  disabled?: boolean
  isLocalOnly?: boolean
}

export type CodeGraphState =
  | "disabled"
  | "indexing"
  | "indexingFull"
  | "indexingIncremental"
  | "ready"
  | "stale"
  | "rescanScheduled"
  | "degraded"
  | "paused"
  | "recovering"
  | "error"

export type CodeGraphStateTransition = {
  state: CodeGraphState
  detail: string
  at: number
}

export type CodeGraphQueueStatus = {
  activeJobId?: string
  activeJobKind?: "full-index" | "incremental-index" | "recovery" | "query" | "benchmark" | "embedding-index"
  pendingJobs: number
  paused: boolean
  cancelRequested: boolean
}

export type CodeGraphServiceMetrics = {
  serviceMode: "extension-host-worker" | "worker-thread-pool"
  schemaVersion: number
  storageBackend: "json-sharded-sqlite-compatible"
  workerThreads: number
  workerHealthy: boolean
  jobsStarted: number
  jobsCompleted: number
  jobsCancelled: number
  jobsFailed: number
  watcherStorms: number
  queryCacheHits: number
  queryCacheMisses: number
  memoryDegraded: boolean
  memoryLimitBytes?: number
  heapUsedBytes?: number
  lastJobElapsedMs?: number
  lastRecoveryElapsedMs?: number
  ragChunks?: number
  ragEmbeddedChunks?: number
  ragVectorShards?: number
  lastRagElapsedMs?: number
}

export type CodeGraphStatus = {
  state: CodeGraphState
  detail: string
  enabled: boolean
  analysisMode?: CodeGraphAnalysisMode | "ast-lite"
  requestedAnalysisMode?: CodeGraphAnalysisMode
  analyzerHost?: string
  analyzerPlatform?: string
  analyzerDetail?: string
  analyzerDegradedReason?: string
  compileCommandsPath?: string
  indexedFiles: number
  indexedFunctions: number
  indexedMacros: number
  truncated: boolean
  updatedAt?: number
  storageMode?: "legacy-json" | "sharded"
  storageBackend?: "json-sharded-sqlite-compatible"
  schemaVersion?: number
  shards?: number
  indexBytes?: number
  skippedFiles?: number
  largeRepoMode?: boolean
  currentShard?: string
  queue?: CodeGraphQueueStatus
  queueLength?: number
  errorCount?: number
  lastTransitionAt?: number
  transitions?: CodeGraphStateTransition[]
  metrics?: CodeGraphServiceMetrics
  rag?: RagStatus
  progress?: {
    completed: number
    total: number
  }
}
