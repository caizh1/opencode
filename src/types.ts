export type ConnectionState = "disconnected" | "connecting" | "connected" | "authFailed" | "error"
export type CompletionLogLevel = "off" | "info" | "debug"
export type CompletionProfile = "generic-chat" | "qwen-coder-fim" | "deepseek-fim"
export type CompletionProvider = "openai-compatible" | "qwen-direct" | "fim-direct" | "none"
export type CompletionCommentGuidedRetrievalMode = "qa-exact" | "completion"
export type CodeGraphAnalysisMode = "auto" | "fast" | "ast" | "semantic"
export type PermissionMode = "ask" | "auto" | "full-access"

export type RagEndpointKind = "disabled" | "localhost" | "private-lan" | "approved-host" | "blocked" | "error"
export type RagAvailability = "not-configured" | "not-indexed" | "checking" | "indexing" | "ready" | "partial" | "paused" | "unavailable"
export type RagIndexAvailability = "none" | "partial" | "ready" | "paused"
export type RagIndexPausedReason = "request-budget" | "rate-limit" | "provider-error" | "manual"
export type RagResumeReason = "request-budget" | "rate-limit" | "probe"
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
  indexTests: boolean
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

export type DocumentRagAvailability =
  | "disabled"
  | "not-configured"
  | "no-documents"
  | "scanning"
  | "indexing"
  | "ready"
  | "partial"
  | "paused"
  | "large-workspace-paused"
  | "error"

export type DocumentRagSettings = {
  enabled: boolean
  maxFiles: number
  maxFileBytes: number
  maxExtractedBytesPerFile: number
  maxChunks: number
  excludeGlobs: string[]
  queryTopK: number
  maxEvidenceBytes: number
}

export type DocumentRagProgress = {
  phase: "scanning" | "indexing" | "backoff"
  documents: number
  indexedDocuments: number
  pendingDocuments: number
  chunks: number
  embeddedChunks: number
  elapsedMs?: number
  updatedAt: number
}

export type DocumentRagStatus = {
  enabled: boolean
  availability: DocumentRagAvailability
  documentCount: number
  indexedDocuments: number
  skippedDocuments: number
  pendingDocuments: number
  chunks: number
  embeddedChunks: number
  pendingChunkCount?: number
  dimension?: number
  provider?: string
  model?: string
  updatedAt?: number
  lastScanAt?: number
  lastError?: string
  fallbackReason?: string
  progress?: DocumentRagProgress
}

export type EvidenceLedgerStaleness = "current" | "unknown" | "stale"

export type EvidenceLedgerEntry = {
  source: string
  kind: string
  path?: string
  symbol?: string
  range?: string
  query?: string
  summary: string
  truncated: boolean
  staleness: EvidenceLedgerStaleness
}

export type RemoteSettings = {
  provider: {
    apiBaseUrl: string
    chatModel: string
    maxTokens: number
    temperature: number
    topP: number
  }
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
    maxHistoryTurns: number
    maxHistoryBytes: number
    memorySummary: {
      enabled: boolean
      maxBytes: number
      triggerOverflowTurns: number
    }
  }
  permissions: {
    mode: PermissionMode
  }
  tools: {
    enabled: boolean
    maxAgentSteps: number
  }
  skills: {
    enabled: string[]
    overrides: Record<string, "on" | "name-only" | "user-invocable-only" | "off">
    scanUserSkills: boolean
    scanOpenCodeSkills: boolean
    scanClaudeSkills: boolean
    scanCodexSkills: boolean
    maxCatalogBytes: number
  }
  mcp: {
    enabled: boolean
  }
  completion: {
    enabled: boolean
    provider: CompletionProvider
    profile: CompletionProfile
    apiBaseUrl: string
    model: string
    maxTokens: number
    contextLength: number
    temperature: number
    topP: number
    debounceMs: number
    logLevel: CompletionLogLevel
    debugFullRetrievalProbe: boolean
    debugExpectedSymbol: string
    commentGuidedRetrievalMode: CompletionCommentGuidedRetrievalMode
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
    indexTests: boolean
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
  documentRag: DocumentRagSettings
}

export type HealthResponse = {
  healthy: boolean
  state: ConnectionState
  detail?: string
  version?: string
}

export type ChipMateSession = {
  id: string
  title?: string
  displayTitle?: string
  displayTitleSource?: "model" | "fallback"
  directory?: string
  time?: {
    created?: number
    updated?: number
  }
}

export type ChipMateTokenUsage = {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type ChipMateUsageKind = "reported" | "estimated"

export type ChipMateUsageRecord = {
  id: string
  source: "chat"
  usageKind: ChipMateUsageKind
  sessionID: string
  messageID: string
  createdAt: number
  completedAt?: number
  providerID?: string
  modelID?: string
  mode?: string
  tokens: ChipMateTokenUsage
  durationMs?: number
}

export type ChipMateUsageStatsOptions = {
  contextLimitsByModelID?: Record<string, number>
}

export type ChipMateUsageBucket = {
  key: string
  label: string
  startAt: number
  endAt: number
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  reportedTotal: number
  estimatedTotal: number
  count: number
  reportedCount: number
  estimatedCount: number
}

export type ChipMateUsageStatsSnapshot = {
  generatedAt: number
  rangeDays: number
  hasData: boolean
  summary: {
    totalTokens: number
    reportedTokens: number
    estimatedTokens: number
    peakDayTokens: number
    peakDay?: string
    longestTaskMs?: number
    currentStreakDays: number
    longestStreakDays: number
    activeDays: number
    recordedResponses: number
    reportedResponses: number
    estimatedResponses: number
  }
  daily: ChipMateUsageBucket[]
  weekly: ChipMateUsageBucket[]
  cumulative: ChipMateUsageBucket[]
}

export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"

export type ThreadGoal = {
  threadID: string
  goalID: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export type ThreadGoalOperation = {
  sessionID: string
  active: boolean
  startedAt: number
  updatedAt: number
  turnCount: number
  currentTurnID?: string
  status?: ThreadGoalStatus
  objective?: string
}

export type RunProgressStatus = "running" | "completed" | "warning" | "failed" | "skipped"

export type RunProgressItem = {
  id: string
  title: string
  status: RunProgressStatus
  detail?: string
  tool?: string
  phase?: string
  path?: string
  artifactPath?: string
  requestedPath?: string
  targetPath?: string
  provider?: string
  fallbackUsed?: boolean
  startedAt?: number
  updatedAt?: number
}

export type ChipMateModelLimit = {
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

export type ChipMateMessageInfo = {
  id: string
  sessionID?: string
  role?: "user" | "assistant"
  providerID?: string
  modelID?: string
  agent?: string
  mode?: string
  cost?: number
  tokens?: ChipMateTokenUsage
  usageKind?: ChipMateUsageKind
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

export type ChipMatePart =
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
	      type: "diagram"
	      kind: "drawio"
	      title?: string
	      xml: string
	      warnings?: string[]
	      source?: "tool" | "fence"
	      diagramId?: string
	      toolCallID?: string
	    }
	  | {
	      type: "diagram"
	      kind: "mermaid"
	      title?: string
	      sourceText: string
	      warnings?: string[]
	      source?: "tool" | "fence"
	      displayMode?: "expanded" | "artifact"
	      diagramId?: string
	      toolCallID?: string
	      mmdPath?: string
	      absoluteMmdPath?: string
	      pngPath?: string
	      absolutePngPath?: string
	      width?: number
	      height?: number
	      pixelWidth?: number
	      pixelHeight?: number
	      scale?: number
	      contentBounds?: { x: number; y: number; width: number; height: number }
	      cropBounds?: { x: number; y: number; width: number; height: number }
	      padding?: number
	      contentCropRatio?: number
	      renderProvider?: string
	      fallbackUsed?: boolean
	    }
  | {
      type: "runProgress"
      title?: string
      status?: RunProgressStatus
      startedAt?: number
      updatedAt?: number
      current?: number
      total?: number
      warningCount?: number
      fallbackCount?: number
      items?: RunProgressItem[]
    }
  | {
      type: "wordRender"
      title?: string
      path?: string
      absolutePath?: string
      renderArtifactDir?: string
      pdfArtifactPath?: string
      pagePngPaths?: string[]
      pageCount?: number
      attempted?: boolean
      ok?: boolean
      visualQaStatus?: "completed" | "skipped"
      skipReason?: "remote-unconfigured" | "remote-unavailable" | "remote-invalid-response" | "artifact-persist-failed"
      remoteEndpoint?: string
      warnings?: string[]
      pageVisualSummaries?: unknown[]
      visualQaCoverage?: {
        totalPages?: number
        queuedPages?: number
        batchSize?: number
        batchCount?: number
        mode?: string
      }
      toolCallID?: string
    }
  | {
      type: "generatedDocument"
      title?: string
      path?: string
      absolutePath?: string
      sourceCount?: number
      warningCount?: number
      warnings?: string[]
      runSummaryPath?: string
      toolCallID?: string
    }
  | {
      type: "clarification"
      clarificationId: string
      status?: "pending" | "answered" | "cancelled"
      title?: string
      reason?: string
      questions: Array<{
        id: string
        question: string
        choices?: Array<{
          id: string
          label: string
          description?: string
        }>
        allowFreeText?: boolean
      }>
      answers?: Array<{
        questionId: string
        choiceId?: string
        text?: string
      }>
      toolCallID?: string
    }
  | {
      type: string
      [key: string]: unknown
    }

export type ChipMateMessage = {
  info: ChipMateMessageInfo
  parts: ChipMatePart[]
}

export type ChipMateMessagePart = ChipMatePart & {
  id?: string
  sessionID?: string
  messageID?: string
}

export type ChipMateSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }
  | { type: "error"; message?: string; interrupted?: boolean }
  | { type: string; [key: string]: unknown }

export type ChipMateEvent =
  | { type: "server.connected"; properties?: Record<string, unknown> }
  | { type: "message.updated"; properties: { info?: ChipMateMessageInfo } }
  | { type: "message.removed"; properties: { sessionID?: string; messageID?: string } }
  | { type: "message.part.updated"; properties: { part?: ChipMateMessagePart; delta?: string } }
  | {
      type: "message.part.delta"
      properties: {
        sessionID?: string
        messageID?: string
        partID?: string
        delta?: string
        text?: string
        type?: string
        part?: ChipMateMessagePart
      }
    }
  | { type: "message.part.removed"; properties: { sessionID?: string; messageID?: string; partID?: string } }
  | { type: "usage.updated"; properties: { sessionID?: string; messageID?: string } }
  | { type: "goal.updated"; properties: { sessionID?: string; goal?: ThreadGoal } }
  | { type: "goal.cleared"; properties: { sessionID?: string } }
  | { type: "goal.operation.started" | "goal.operation.finished"; properties: { sessionID?: string; operation?: ThreadGoalOperation } }
  | { type: "session.status"; properties: { sessionID?: string; status?: ChipMateSessionStatus } }
  | { type: "session.error"; properties: { sessionID?: string; error?: ChipMateMessageInfo["error"] | { data?: { message?: string }; message?: string } } }
  | { type: "session.created" | "session.updated" | "session.deleted"; properties: { info?: ChipMateSession } }
  | { type: string; properties?: Record<string, unknown> }

export type ChipMateGlobalEvent = {
  directory?: string
  payload?: ChipMateEvent
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

export type ChipMateModelInfo = {
  id: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  isDefault: boolean
  source?: "configured" | "provider"
  providerIndex?: number
  contextLimit?: number
  outputLimit?: number
}

export type ChipMateAgentInfo = {
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
