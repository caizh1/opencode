import { buildContextWindowState, type ContextPackBudgetReport, type ContextWindowState } from "./context-pack"
import type { ConversationContextState, HistoryTranscriptItem } from "./conversation-context"
import { estimateChatTokenUsage } from "./usage"

export const CONTEXT_COMPACTION_EVENT_VERSION = 1
export const DEFAULT_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000
export const DEFAULT_RETAINED_USER_MESSAGE_MAX_COUNT = 20
export const DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_TRANSCRIPT_MESSAGES = 24
export const DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_MESSAGE_CHARS = 1_200
export const DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_STATE_CHARS = 8_000
export const DEFAULT_COMPACT_SUMMARY_MAX_BYTES = 16 * 1024

export type CompactionTrigger =
  | "pre_turn_hard_limit"
  | "manual"
  | "mid_turn_pressure"
  | "request_stage_truncated"
  | "soft_threshold"

export type CompactionStatus = "candidate" | "completed" | "failed" | "interrupted" | "fallback_pruned"
export type PersistentCompactionStatus = Exclude<CompactionStatus, "candidate">
export type CompactionReason = "soft_threshold" | "hard_limit" | "user_requested" | "request_stage_truncated" | "mid_turn_pressure" | "unknown"
export type CompactionImplementation = "local_summary" | "token_budget" | "remote" | "fallback_pruned"
export type CompactionStrategy = "local_summary" | "token_budget" | "remote" | "fallback_pruned"
export type CompactionPhase = "pre_turn" | "mid_turn" | "manual" | "request_stage"
export type CompactPromptSource = "default" | "override" | "not_used"

export type CompactionStrategyDecision = {
  implementation: CompactionImplementation
  strategy: CompactionStrategy
  status: PersistentCompactionStatus
  reason: CompactionReason
  phase: CompactionPhase
  compactPromptSource: CompactPromptSource
  requiresModelSummary: boolean
  lifecycleStartMessage: string
  lifecycleCompletedMessage: string
}

export type ReplacementHistoryItem = {
  id: string
  kind: "retained_user_message" | "compaction_summary" | "initial_context"
  role: "user" | "assistant" | "system"
  content: string
  sourceMessageId?: string
  source: "history_transcript" | "compaction_summary" | "initial_context"
}

export type CompactionState = {
  id: string
  version: number
  trigger: CompactionTrigger
  status: CompactionStatus
  createdAt: number
  beforeTokens: number
  afterTokens: number
  retainedMessageIds: string[]
  omittedMessageCount: number
  summary: string
  replacementHistory: ReplacementHistoryItem[]
  window: {
    source: string
    modelContextWindow: number
    effectiveContextWindow: number
    autoCompactScope?: ContextWindowState["autoCompactScope"]
    activeTokens?: number
    prefillTokens?: number
    bodyTokens?: number
    scopeTokens?: number
    compactionThresholdTokens?: number
    tokensUntilCompaction?: number
    tokenLimitReached?: boolean
  }
  failureReason?: string
  fallbackReason?: string
  initialContextReinjection: "next_turn_full" | "mid_turn_insert" | "not_required"
}

export type ContextCompactionInitialContextReinjection = CompactionState["initialContextReinjection"]

export type ContextCompactionBaselineMetadata = {
  source: "world_baseline" | "missing"
  workspaceRoot?: string
  gitHead?: string
  gitDirty?: boolean
  settingsHash?: string
  ragIndexVersion?: string
  ragUpdatedAt?: number
  toolVersionHash?: string
  model?: string
  sourceModel?: string
  sourceWindow?: string
  fullReinjectRequired: boolean
  diffRequired: boolean
  reason?: string
}

export type ContextCompactionEventRecord = {
  version: number
  id: string
  trigger: CompactionTrigger
  reason: CompactionReason
  implementation: CompactionImplementation
  strategy: CompactionStrategy
  phase: CompactionPhase
  status: PersistentCompactionStatus
  createdAt: number
  completedAt?: number
  beforeTokens: number
  afterTokens: number
  window: CompactionState["window"]
  summary?: string
  replacementHistory: ReplacementHistoryItem[]
  retainedMessageIds: string[]
  omittedMessageIds: string[]
  omittedMessageCount: number
  historyVersion: number
  baseEventId?: string
  sourceModel?: string
  sourceWindow?: string
  compactPromptSource: CompactPromptSource
  lifecycleItemId?: string
  failureReason?: string
  fallbackReason?: string
  initialContextReinjection?: ContextCompactionInitialContextReinjection
  baselineMetadata?: ContextCompactionBaselineMetadata
}

export type ContextCompactionSessionEvent = {
  type: "context_compaction"
  contextCompaction: ContextCompactionEventRecord
}

export type ContextCompactionLifecycleStatus = "started" | "completed" | "failed" | "interrupted"

export type ContextCompactionLifecycleItem = {
  version: number
  id: string
  compactionId: string
  status: ContextCompactionLifecycleStatus
  trigger: CompactionTrigger
  phase: CompactionPhase
  createdAt: number
  completedAt?: number
  message?: string
  failureReason?: string
}

export type ContextCompactionLifecycleSessionEvent = {
  type: "context_compaction_lifecycle"
  contextCompactionLifecycle: ContextCompactionLifecycleItem
}

export type CompactHookContext = {
  compactionId: string
  trigger: CompactionTrigger
  phase: CompactionPhase
  status?: PersistentCompactionStatus
  compaction?: CompactionState
  event?: ContextCompactionEventRecord
}

export type CompactHookOutcome = { status: "continue" } | { status: "stopped"; reason?: string } | { status: "error"; reason: string }
export type CompactHook = (context: CompactHookContext) => void | CompactHookOutcome | Promise<void | CompactHookOutcome>

export type CompactedHistoryMessage = {
  role: "user" | "assistant"
  content: string
  sourceItemId: string
  sourceMessageId?: string
  kind: ReplacementHistoryItem["kind"]
}

export type CompactedHistoryAdapterDiagnosticCode =
  | "non_completed_compaction"
  | "invalid_replacement_item"
  | "empty_replacement_item"
  | "duplicate_replacement_item"
  | "duplicate_compaction_summary"
  | "system_role_normalized"
  | "unsupported_role_normalized"
  | "unsupported_modality_normalized"
  | "orphan_tool_output_removed"

export type CompactedHistoryAdapterDiagnostic = {
  severity: "info" | "warning"
  code: CompactedHistoryAdapterDiagnosticCode
  message: string
  sourceItemId?: string
}

export type CompactedHistoryAdapterSnapshot = {
  compactionId?: string
  historyVersion?: number
  messages: CompactedHistoryMessage[]
  diagnostics: CompactedHistoryAdapterDiagnostic[]
}

export type CompactSummaryPromptMessage = {
  role: "system" | "user"
  content: string
}

export type CompactSummaryPrompt = {
  messages: CompactSummaryPromptMessage[]
  promptSource: Extract<CompactPromptSource, "default" | "override">
  transcriptMessageCount: number
  omittedTranscriptMessageCount: number
  truncatedMessageCount: number
  stateSummaryTruncated: boolean
}

export type BuildCompactSummaryPromptInput = {
  state: ConversationContextState
  compaction?: CompactionState
  promptOverride?: string
  maxTranscriptMessages?: number
  maxMessageChars?: number
  maxStateChars?: number
}

export type CompactSummaryModelResult = {
  summary: string
  retainedUserMessageIds: string[]
  nextActions: string[]
  risks: string[]
  stateCoverage: string[]
  omissions: string[]
  parsedJson: boolean
  rawText: string
}

export type CompactSummaryQualityIssueCode =
  | "summary_empty"
  | "summary_too_large"
  | "summary_gibberish"
  | "missing_current_objective"
  | "missing_next_actions"
  | "missing_risks"

export type CompactSummaryQualityIssue = {
  code: CompactSummaryQualityIssueCode
  message: string
}

export type CompactSummaryQualityGateResult = {
  ok: boolean
  summaryBytes: number
  maxBytes: number
  issues: CompactSummaryQualityIssue[]
}

export type RedundantCompactionSkipDecision = {
  skip: boolean
  reason?: string
  coveredById?: string
}

export type CompactSummaryOverflowRetryPlan = {
  canRetry: boolean
  nextMaxTranscriptMessages?: number
  trimmedOldestMessageCount: number
  reason?: string
}

export type BuildCompactionCandidateInput = {
  state: ConversationContextState
  budgetReport: ContextPackBudgetReport
  windowState?: ContextWindowState
  trigger?: CompactionTrigger
  now?: number
  retainedUserMaxTokens?: number
  retainedUserMaxMessages?: number
  deferRequestStageFallback?: boolean
}

export function shouldCreateCompactionCandidate(report: ContextPackBudgetReport, windowState?: ContextWindowState) {
  return (windowState ?? buildContextWindowState({ report })).shouldCompact
}

export function buildCompactionCandidate(input: BuildCompactionCandidateInput): CompactionState | undefined {
  const windowState = input.windowState ?? buildContextWindowState({ report: input.budgetReport })
  if (input.trigger !== "manual" && !shouldCreateCompactionCandidate(input.budgetReport, windowState)) return undefined
  const now = input.now ?? Date.now()
  const trigger = input.trigger ?? triggerFromWindowState(windowState)
  const visibleTranscriptItems = input.state.transcript.items.filter((item) => item.visibility === "model-visible")
  const retainedUsers = latestVisibleUserItems(input.state.transcript.items, {
    maxTokens: input.retainedUserMaxTokens ?? DEFAULT_RETAINED_USER_MESSAGE_MAX_TOKENS,
    maxMessages: input.retainedUserMaxMessages ?? DEFAULT_RETAINED_USER_MESSAGE_MAX_COUNT,
    model: input.budgetReport.model,
  })
  const summary = compactSummary(input.state)
  const stateSnapshot = highPriorityStateSnapshot(input.state, now)
  const replacementHistory: ReplacementHistoryItem[] = [
    ...retainedUsers.map((item) => ({
      id: `retained:${item.sourceMessageId}`,
      kind: "retained_user_message" as const,
      role: "user" as const,
      content: item.content,
      sourceMessageId: item.sourceMessageId,
      source: "history_transcript" as const,
    })),
    ...(stateSnapshot
      ? [{
          id: `state:${now.toString(36)}`,
          kind: "initial_context" as const,
          role: "user" as const,
          content: stateSnapshot,
          source: "initial_context" as const,
        }]
      : []),
    {
      id: `summary:${now}`,
      kind: "compaction_summary",
      role: "assistant",
      content: summary,
      source: "compaction_summary",
    },
  ]
  const requestStageFallback = input.budgetReport.truncated && !input.deferRequestStageFallback
  return {
    id: `compact-${now.toString(36)}`,
    version: 1,
    trigger,
    status: requestStageFallback ? "fallback_pruned" : "candidate",
    createdAt: now,
    beforeTokens: input.budgetReport.totalEstimatedTokens + input.budgetReport.omittedEstimatedTokens,
    afterTokens: input.budgetReport.totalEstimatedTokens,
    retainedMessageIds: retainedUsers.map((item) => item.sourceMessageId),
    omittedMessageCount: Math.max(input.budgetReport.omittedMessages, visibleTranscriptItems.length - retainedUsers.length),
    summary,
    replacementHistory,
    window: {
      source: input.budgetReport.contextWindow.source,
      modelContextWindow: input.budgetReport.contextWindow.modelContextWindow,
      effectiveContextWindow: input.budgetReport.contextWindow.effectiveContextWindow,
      autoCompactScope: windowState.autoCompactScope,
      activeTokens: windowState.activeTokens,
      prefillTokens: windowState.prefillTokens,
      bodyTokens: windowState.bodyTokens,
      scopeTokens: windowState.scopeTokens,
      compactionThresholdTokens: windowState.compactionThresholdTokens,
      tokensUntilCompaction: windowState.tokensUntilCompaction,
      tokenLimitReached: windowState.tokenLimitReached,
    },
    fallbackReason: input.budgetReport.truncated ? input.budgetReport.reason : undefined,
    initialContextReinjection: trigger === "mid_turn_pressure" ? "mid_turn_insert" : "next_turn_full",
  }
}

export function compactStateWithRequestStageFallbackPrune(
  compaction: CompactionState,
  budgetReport: ContextPackBudgetReport,
): CompactionState {
  return {
    ...compaction,
    status: "fallback_pruned",
    beforeTokens: budgetReport.totalEstimatedTokens + budgetReport.omittedEstimatedTokens,
    afterTokens: budgetReport.totalEstimatedTokens,
    omittedMessageCount: budgetReport.omittedMessages,
    fallbackReason: budgetReport.reason ?? compaction.fallbackReason ?? "request-stage token gate pruned lower-priority context sections",
  }
}

export function shouldSkipRedundantCompaction(input: {
  compaction: CompactionState
  latestCompleted?: ContextCompactionEventRecord
  currentHistoryVersion: number
}): RedundantCompactionSkipDecision {
  const latest = input.latestCompleted
  if (!latest || latest.status !== "completed") return { skip: false }
  const currentHistoryVersion = Math.max(1, Math.floor(input.currentHistoryVersion))
  if (latest.historyVersion < currentHistoryVersion + 1) return { skip: false }
  if (input.compaction.trigger !== "soft_threshold") return { skip: false }
  if (latest.window.effectiveContextWindow !== input.compaction.window.effectiveContextWindow) return { skip: false }
  const latestScope = latest.window.scopeTokens ?? latest.beforeTokens
  const currentScope = input.compaction.window.scopeTokens ?? input.compaction.beforeTokens
  const latestActive = latest.window.activeTokens ?? latest.beforeTokens
  const currentActive = input.compaction.window.activeTokens ?? input.compaction.beforeTokens
  if (currentScope > latestScope || currentActive > latestActive) return { skip: false }
  return {
    skip: true,
    coveredById: latest.id,
    reason: `latest completed compact ${latest.id} already covers historyVersion=${currentHistoryVersion + 1} pressure active=${currentActive}/${latestActive} scope=${currentScope}/${latestScope}`,
  }
}

export function compactSummaryOverflowRetryPlan(prompt: CompactSummaryPrompt): CompactSummaryOverflowRetryPlan {
  const current = Math.max(0, Math.floor(prompt.transcriptMessageCount))
  if (current <= 1) {
    return {
      canRetry: false,
      trimmedOldestMessageCount: 0,
      reason: "compact summary prompt has no older transcript messages left to trim",
    }
  }
  const next = Math.max(1, Math.floor(current / 2))
  if (next >= current) {
    return {
      canRetry: false,
      trimmedOldestMessageCount: 0,
      reason: "compact summary prompt cannot be reduced further",
    }
  }
  return {
    canRetry: true,
    nextMaxTranscriptMessages: next,
    trimmedOldestMessageCount: current - next,
    reason: `trim ${current - next} oldest compact transcript message(s), retry with ${next}`,
  }
}

export function contextCompactionBaselineMetadata(input: {
  state: ConversationContextState
  sourceModel?: string
  sourceWindow?: string
}): ContextCompactionBaselineMetadata {
  const latest = input.state.world.latest
  return {
    source: latest ? "world_baseline" : "missing",
    workspaceRoot: latest?.workspaceRoot,
    gitHead: latest?.gitHead,
    gitDirty: latest?.gitDirty,
    settingsHash: latest?.settingsHash,
    ragIndexVersion: latest?.ragIndexVersion,
    ragUpdatedAt: latest?.ragUpdatedAt,
    toolVersionHash: latest?.toolVersionHash,
    model: latest?.model,
    sourceModel: input.sourceModel,
    sourceWindow: input.sourceWindow,
    fullReinjectRequired: input.state.world.fullReinjectRequired,
    diffRequired: input.state.world.diffRequired,
    reason: input.state.world.reason,
  }
}

export function chooseCompactionStrategy(input: {
  compaction: CompactionState
  modelSummaryAvailable?: boolean
  preferTokenBudget?: boolean
  remoteSummaryAvailable?: boolean
}): CompactionStrategyDecision {
  const phase = phaseFromTrigger(input.compaction.trigger)
  const reason = reasonFromTrigger(input.compaction.trigger)
  if (input.compaction.status === "fallback_pruned") {
    return {
      implementation: "fallback_pruned",
      strategy: "fallback_pruned",
      status: "fallback_pruned",
      reason,
      phase: "request_stage",
      compactPromptSource: "not_used",
      requiresModelSummary: false,
      lifecycleStartMessage: "Request-stage fallback pruning started.",
      lifecycleCompletedMessage: "Request-stage fallback pruning persisted.",
    }
  }
  if (input.remoteSummaryAvailable) {
    return {
      implementation: "remote",
      strategy: "remote",
      status: "completed",
      reason,
      phase,
      compactPromptSource: "not_used",
      requiresModelSummary: false,
      lifecycleStartMessage: "Remote compact strategy started.",
      lifecycleCompletedMessage: "Remote compact strategy persisted.",
    }
  }
  if (input.preferTokenBudget || input.modelSummaryAvailable === false) {
    return {
      implementation: "token_budget",
      strategy: "token_budget",
      status: "completed",
      reason,
      phase,
      compactPromptSource: "not_used",
      requiresModelSummary: false,
      lifecycleStartMessage: "Token-budget compact strategy started.",
      lifecycleCompletedMessage: "Token-budget compact strategy persisted without model summary.",
    }
  }
  return {
    implementation: "local_summary",
    strategy: "local_summary",
    status: "completed",
    reason,
    phase,
    compactPromptSource: "default",
    requiresModelSummary: true,
    lifecycleStartMessage: "Model-generated compact summary started.",
    lifecycleCompletedMessage: "Model-generated compact summary persisted.",
  }
}

export function compactStateWithTokenBudgetFreshWindow(compaction: CompactionState): CompactionState {
  return {
    ...compaction,
    status: "completed",
    summary: "Token-budget compaction installed a fresh context window without a model-generated summary.",
    replacementHistory: compaction.replacementHistory.filter((item) => item.kind === "retained_user_message" || item.kind === "initial_context"),
    fallbackReason: undefined,
  }
}

export function buildCompactSummaryPrompt(input: BuildCompactSummaryPromptInput): CompactSummaryPrompt {
  const maxTranscriptMessages = positiveLimit(input.maxTranscriptMessages, DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_TRANSCRIPT_MESSAGES)
  const maxMessageChars = positiveLimit(input.maxMessageChars, DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_MESSAGE_CHARS)
  const maxStateChars = positiveLimit(input.maxStateChars, DEFAULT_COMPACT_SUMMARY_PROMPT_MAX_STATE_CHARS)
  const visibleTranscript = input.state.transcript.items.filter((item) => item.visibility === "model-visible")
  const transcriptSlice = visibleTranscript.slice(-maxTranscriptMessages)
  const transcript = transcriptSlice.map((item) => compactTranscriptLine(item, maxMessageChars))
  const truncatedMessageCount = transcript.filter((item) => item.truncated).length
  const stateSummary = boundedText(compactStateSummary(input.state, input.compaction), maxStateChars)
  const promptOverride = input.promptOverride?.trim()
  const system = promptOverride || DEFAULT_COMPACT_SUMMARY_SYSTEM_PROMPT
  const user = [
    "<chipmate-compact-summary-input>",
    `historyVersion: ${input.state.transcript.historyVersion}`,
    `transcriptVisibleMessages: ${visibleTranscript.length}`,
    `transcriptIncludedMessages: ${transcriptSlice.length}`,
    `transcriptOmittedBeforeSlice: ${Math.max(0, visibleTranscript.length - transcriptSlice.length)}`,
    input.compaction ? `candidateId: ${input.compaction.id}` : "",
    input.compaction ? `candidateTrigger: ${input.compaction.trigger}` : "",
    input.compaction ? `candidateBeforeTokens: ${input.compaction.beforeTokens}` : "",
    input.compaction ? `candidateAfterTokens: ${input.compaction.afterTokens}` : "",
    "<state-summary>",
    stateSummary.text,
    "</state-summary>",
    "<transcript-slice>",
    ...transcript.map((item) => item.text),
    "</transcript-slice>",
    "</chipmate-compact-summary-input>",
  ].filter(Boolean).join("\n")
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    promptSource: promptOverride ? "override" : "default",
    transcriptMessageCount: transcriptSlice.length,
    omittedTranscriptMessageCount: Math.max(0, visibleTranscript.length - transcriptSlice.length),
    truncatedMessageCount,
    stateSummaryTruncated: stateSummary.truncated,
  }
}

export function parseCompactSummaryModelOutput(text: string): CompactSummaryModelResult {
  const rawText = text.trim()
  if (!rawText) throw new Error("Compact summary model returned empty output.")
  const jsonText = stripJsonFence(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return {
      summary: rawText,
      retainedUserMessageIds: [],
      nextActions: [],
      risks: [],
      stateCoverage: [],
      omissions: [],
      parsedJson: false,
      rawText,
    }
  }
  if (!isRecord(parsed)) {
    return {
      summary: rawText,
      retainedUserMessageIds: [],
      nextActions: [],
      risks: [],
      stateCoverage: [],
      omissions: [],
      parsedJson: true,
      rawText,
    }
  }
  const summary = stringField(parsed, "summary") || stringField(parsed, "compactSummary") || rawText
  return {
    summary,
    retainedUserMessageIds: stringArrayField(parsed, "retainedUserMessageIds"),
    nextActions: stringArrayField(parsed, "nextActions"),
    risks: stringArrayField(parsed, "risks"),
    stateCoverage: stringArrayField(parsed, "stateCoverage"),
    omissions: stringArrayField(parsed, "omissions"),
    parsedJson: true,
    rawText,
  }
}

export function compactStateWithModelSummary(
  compaction: CompactionState,
  result: CompactSummaryModelResult,
  now = Date.now(),
): CompactionState {
  const summaryContent = renderCompactSummaryModelResult(result)
  const existing = compaction.replacementHistory.filter((item) => item.kind !== "compaction_summary")
  return {
    ...compaction,
    status: "completed",
    summary: result.summary,
    replacementHistory: [
      ...existing,
      {
        id: `summary:${compaction.id}:model:${now.toString(36)}`,
        kind: "compaction_summary",
        role: "assistant",
        content: summaryContent,
        source: "compaction_summary",
      },
    ],
    fallbackReason: undefined,
  }
}

export function validateCompactSummaryQuality(input: {
  result: CompactSummaryModelResult
  state?: ConversationContextState
  maxBytes?: number
}): CompactSummaryQualityGateResult {
  const maxBytes = positiveLimit(input.maxBytes, DEFAULT_COMPACT_SUMMARY_MAX_BYTES)
  const summary = input.result.summary.trim()
  const rendered = renderCompactSummaryModelResult(input.result)
  const summaryBytes = textByteLength(rendered)
  const searchable = normalizeForQuality([
    input.result.summary,
    input.result.rawText,
    input.result.nextActions.join("\n"),
    input.result.risks.join("\n"),
    input.result.stateCoverage.join("\n"),
    input.result.omissions.join("\n"),
  ].join("\n"))
  const issues: CompactSummaryQualityIssue[] = []
  if (!summary) {
    issues.push({ code: "summary_empty", message: "Compact summary is empty." })
  }
  if (summaryBytes > maxBytes) {
    issues.push({ code: "summary_too_large", message: `Compact summary is ${summaryBytes} bytes, exceeding limit ${maxBytes}.` })
  }
  if (looksLikeGibberish(summary)) {
    issues.push({ code: "summary_gibberish", message: "Compact summary appears malformed or unreadable." })
  }
  const objective = input.state?.task.currentObjective?.trim()
  if (objective && !searchable.includes(normalizeForQuality(objective))) {
    issues.push({ code: "missing_current_objective", message: "Compact summary does not preserve the current objective." })
  }
  if (!hasNextActions(input.result, searchable)) {
    issues.push({ code: "missing_next_actions", message: "Compact summary does not include next actions." })
  }
  if (!hasRisks(input.result, searchable)) {
    issues.push({ code: "missing_risks", message: "Compact summary does not include risks." })
  }
  return {
    ok: issues.length === 0,
    summaryBytes,
    maxBytes,
    issues,
  }
}

export function formatCompactionRecord(state: CompactionState) {
  return `[context-compact] id=${state.id} status=${state.status} trigger=${state.trigger} beforeTokens=${state.beforeTokens} afterTokens=${state.afterTokens} retained=${state.retainedMessageIds.length} omitted=${state.omittedMessageCount} reinject=${state.initialContextReinjection}`
}

export function formatContextCompactionEventRecord(record: ContextCompactionEventRecord) {
  const duration = typeof record.completedAt === "number" ? ` durationMs=${Math.max(0, record.completedAt - record.createdAt)}` : ""
  const failure = record.failureReason ? ` failure=${oneLine(record.failureReason)}` : ""
  const fallback = record.fallbackReason ? ` fallback=${oneLine(record.fallbackReason)}` : ""
  const reinject = record.initialContextReinjection ? ` reinject=${record.initialContextReinjection}` : ""
  const baseline = record.baselineMetadata ? ` baseline=${record.baselineMetadata.source}` : ""
  return `[context-compact-event] id=${record.id} status=${record.status} trigger=${record.trigger} reason=${record.reason} implementation=${record.implementation} strategy=${record.strategy} phase=${record.phase} beforeTokens=${record.beforeTokens} afterTokens=${record.afterTokens} retained=${record.retainedMessageIds.length} omitted=${record.omittedMessageCount} historyVersion=${record.historyVersion} window=${record.window.modelContextWindow} windowSource=${record.window.source} prompt=${record.compactPromptSource}${reinject}${baseline}${duration}${failure}${fallback}`
}

export function formatCompactionStrategyDecision(compaction: CompactionState, decision: CompactionStrategyDecision) {
  return `[context-compact-strategy] id=${compaction.id} implementation=${decision.implementation} strategy=${decision.strategy} phase=${decision.phase} reason=${decision.reason} requiresModelSummary=${decision.requiresModelSummary ? "true" : "false"} prompt=${decision.compactPromptSource}`
}

export function buildContextCompactionEvent(input: {
  compaction: CompactionState
  status?: PersistentCompactionStatus
  historyVersion: number
  baseEventId?: string
  omittedMessageIds?: string[]
  reason?: CompactionReason
  implementation?: CompactionImplementation
  strategy?: CompactionStrategy
  phase?: CompactionPhase
  sourceModel?: string
  sourceWindow?: string
  compactPromptSource?: CompactPromptSource
  lifecycleItemId?: string
  failureReason?: string
  fallbackReason?: string
  initialContextReinjection?: ContextCompactionInitialContextReinjection
  baselineMetadata?: ContextCompactionBaselineMetadata
  now?: number
}): ContextCompactionSessionEvent {
  const status = input.status ?? persistentStatusFromCompaction(input.compaction.status)
  return {
    type: "context_compaction",
    contextCompaction: {
      version: CONTEXT_COMPACTION_EVENT_VERSION,
      id: input.compaction.id,
      trigger: input.compaction.trigger,
      reason: input.reason ?? reasonFromTrigger(input.compaction.trigger),
      implementation: input.implementation ?? implementationFromStatus(status),
      strategy: input.strategy ?? strategyFromStatus(status),
      phase: input.phase ?? phaseFromTrigger(input.compaction.trigger),
      status,
      createdAt: input.compaction.createdAt,
      completedAt: input.now ?? Date.now(),
      beforeTokens: input.compaction.beforeTokens,
      afterTokens: input.compaction.afterTokens,
      window: input.compaction.window,
      summary: input.compaction.summary,
      replacementHistory: input.compaction.replacementHistory,
      retainedMessageIds: input.compaction.retainedMessageIds,
      omittedMessageIds: input.omittedMessageIds ?? [],
      omittedMessageCount: input.compaction.omittedMessageCount,
      historyVersion: Math.max(1, Math.floor(input.historyVersion)),
      baseEventId: input.baseEventId,
      sourceModel: input.sourceModel,
      sourceWindow: input.sourceWindow,
      compactPromptSource: input.compactPromptSource ?? "default",
      lifecycleItemId: input.lifecycleItemId,
      failureReason: input.failureReason,
      fallbackReason: input.fallbackReason ?? input.compaction.fallbackReason,
      initialContextReinjection: input.initialContextReinjection ?? input.compaction.initialContextReinjection,
      baselineMetadata: input.baselineMetadata,
    },
  }
}

export function buildContextCompactionLifecycleEvent(input: {
  compactionId: string
  status: ContextCompactionLifecycleStatus
  trigger: CompactionTrigger
  phase?: CompactionPhase
  now?: number
  completedAt?: number
  message?: string
  failureReason?: string
}): ContextCompactionLifecycleSessionEvent {
  const now = input.now ?? Date.now()
  return {
    type: "context_compaction_lifecycle",
    contextCompactionLifecycle: {
      version: CONTEXT_COMPACTION_EVENT_VERSION,
      id: `compact-lifecycle:${input.compactionId}:${input.status}:${now.toString(36)}`,
      compactionId: input.compactionId,
      status: input.status,
      trigger: input.trigger,
      phase: input.phase ?? phaseFromTrigger(input.trigger),
      createdAt: now,
      completedAt: input.completedAt,
      message: input.message,
      failureReason: input.failureReason,
    },
  }
}

export function appendContextCompactionEvent<T>(
  events: readonly T[],
  event: ContextCompactionSessionEvent | ContextCompactionLifecycleSessionEvent,
): Array<T | ContextCompactionSessionEvent | ContextCompactionLifecycleSessionEvent> {
  return [...events, event]
}

export function contextCompactionEventsFromSessionEvents(events: readonly unknown[]): ContextCompactionEventRecord[] {
  return events.flatMap((event) => {
    if (!isRecord(event) || event.type !== "context_compaction") return []
    const record = event.contextCompaction
    return isContextCompactionEventRecord(record) ? [record] : []
  })
}

export function latestContextCompactionEvent(
  events: readonly unknown[],
  statuses: readonly PersistentCompactionStatus[] = ["completed"],
): ContextCompactionEventRecord | undefined {
  const allowed = new Set(statuses)
  const records = contextCompactionEventsFromSessionEvents(events)
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record && allowed.has(record.status)) return record
  }
  return undefined
}

export function latestCompletedContextCompactionEvent(events: readonly unknown[]): ContextCompactionEventRecord | undefined {
  return latestContextCompactionEvent(events, ["completed"])
}

export function compactedHistoryMessagesFromEvent(record: ContextCompactionEventRecord | undefined): CompactedHistoryMessage[] {
  return buildCompactedHistoryAdapterSnapshot(record).messages
}

export function buildCompactedHistoryAdapterSnapshot(record: ContextCompactionEventRecord | undefined): CompactedHistoryAdapterSnapshot {
  if (!record) return { messages: [], diagnostics: [] }
  const diagnostics: CompactedHistoryAdapterDiagnostic[] = []
  if (record.status !== "completed") {
    diagnostics.push({
      severity: "info",
      code: "non_completed_compaction",
      message: `Ignoring ${record.status} compact event; only completed events can rewrite model-visible history.`,
    })
    return {
      compactionId: record.id,
      historyVersion: record.historyVersion,
      messages: [],
      diagnostics,
    }
  }

  const seen = new Set<string>()
  const messages: CompactedHistoryMessage[] = []
  let hasCompactionSummary = false
  for (const rawItem of record.replacementHistory as unknown[]) {
    const item = normalizeReplacementHistoryItem(rawItem, diagnostics)
    if (!item) continue
    if (seen.has(item.id)) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate_replacement_item",
        message: `Skipped duplicate compact replacement item ${item.id}.`,
        sourceItemId: item.id,
      })
      continue
    }
    seen.add(item.id)
    if (item.role === "system") {
      diagnostics.push({
        severity: "warning",
        code: "system_role_normalized",
        message: `Normalized system-role compact replacement item ${item.id} to provider-safe history.`,
        sourceItemId: item.id,
      })
    }
    if (item.kind === "compaction_summary") {
      if (hasCompactionSummary) {
        diagnostics.push({
          severity: "warning",
          code: "duplicate_compaction_summary",
          message: `Skipped duplicate compaction summary item ${item.id}; a compacted transcript may contain only one summary.`,
          sourceItemId: item.id,
        })
        continue
      }
      hasCompactionSummary = true
    }
    const content = compactedHistoryContent(record, item).trim()
    if (!content) {
      diagnostics.push({
        severity: "warning",
        code: "empty_replacement_item",
        message: `Skipped empty compact replacement item ${item.id}.`,
        sourceItemId: item.id,
      })
      continue
    }
    messages.push({
      role: compactedHistoryRole(item),
      content,
      sourceItemId: item.id,
      sourceMessageId: item.sourceMessageId,
      kind: item.kind,
    })
  }
  return {
    compactionId: record.id,
    historyVersion: record.historyVersion,
    messages,
    diagnostics,
  }
}

export async function runCompactHooks(hooks: readonly CompactHook[], context: CompactHookContext): Promise<CompactHookOutcome> {
  for (const hook of hooks) {
    let outcome: void | CompactHookOutcome
    try {
      outcome = await hook(context)
    } catch (error) {
      return { status: "error", reason: oneLine(errorMessage(error)) }
    }
    if (outcome?.status === "stopped") return outcome
    if (outcome?.status === "error") return outcome
  }
  return { status: "continue" }
}

const DEFAULT_COMPACT_SUMMARY_SYSTEM_PROMPT = [
  "You are ChipMate's compact summary writer.",
  "Create a concise continuity summary for future turns. Preserve current objective, user corrections, active plan steps, file and verification state, failures, evidence freshness, and visual fallback references.",
  "Do not introduce new user requests. Do not invent verified status. Prefer short structured JSON with keys summary, retainedUserMessageIds, nextActions, risks, stateCoverage, and omissions.",
].join("\n")

function renderCompactSummaryModelResult(result: CompactSummaryModelResult) {
  return [
    result.summary,
    result.retainedUserMessageIds.length ? `Retained user message ids: ${result.retainedUserMessageIds.join(", ")}` : "",
    result.nextActions.length ? `Next actions:\n${result.nextActions.map((item) => `- ${item}`).join("\n")}` : "",
    result.risks.length ? `Risks:\n${result.risks.map((item) => `- ${item}`).join("\n")}` : "",
    result.stateCoverage.length ? `State coverage:\n${result.stateCoverage.map((item) => `- ${item}`).join("\n")}` : "",
    result.omissions.length ? `Omissions:\n${result.omissions.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")
}

function hasNextActions(result: CompactSummaryModelResult, searchable: string) {
  return result.nextActions.length > 0 || /\bnext actions?\b|下一步|后续/.test(searchable)
}

function hasRisks(result: CompactSummaryModelResult, searchable: string) {
  return result.risks.length > 0 || /\brisks?\b|\bremaining risk\b|风险/.test(searchable)
}

function looksLikeGibberish(value: string) {
  const compact = value.replace(/\s+/g, "")
  if (!compact) return false
  if (/�{2,}/.test(compact)) return true
  if (compact.length < 24) return false
  const meaningful = compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g)?.length ?? 0
  return meaningful / compact.length < 0.3
}

function normalizeForQuality(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function compactTranscriptLine(item: HistoryTranscriptItem, maxChars: number) {
  const content = boundedText(item.content, maxChars)
  const created = typeof item.createdAt === "number" ? ` createdAt=${item.createdAt}` : ""
  const mode = item.mode ? ` mode=${oneLine(item.mode)}` : ""
  return {
    text: [
      `<message id="${xmlAttribute(item.id)}" sourceMessageId="${xmlAttribute(item.sourceMessageId)}" role="${item.role}"${created}${mode}>`,
      content.text,
      "</message>",
    ].join("\n"),
    truncated: content.truncated,
  }
}

function compactStateSummary(state: ConversationContextState, compaction: CompactionState | undefined) {
  const lines = [
    "TaskState:",
    state.task.currentObjective ? `- currentObjective: ${oneLine(state.task.currentObjective)}` : "- currentObjective: none",
    state.task.goal?.status ? `- goalStatus: ${oneLine(state.task.goal.status)}` : "",
    state.task.corrections.length ? `- userCorrections: ${state.task.corrections.slice(-5).map(oneLine).join(" | ")}` : "- userCorrections: none",
    state.task.nextActions.length ? `- nextActions: ${state.task.nextActions.slice(-5).map(oneLine).join(" | ")}` : "- nextActions: none",
    state.task.latestFailure ? `- latestTaskFailure: ${oneLine(state.task.latestFailure.reason)}` : "",
    "PlanState:",
    state.plan.steps.length ? state.plan.steps.slice(0, 8).map((step) => `- ${step.id} [${step.status}] ${oneLine(step.title)}`).join("\n") : "- none",
    "FileState:",
    state.file.entries.length ? state.file.entries.slice(-10).map((entry) => `- ${entry.path} [${entry.status}] ${entry.summary ? oneLine(entry.summary) : ""}`.trim()).join("\n") : "- none",
    "VerificationState:",
    state.verification.entries.length ? state.verification.entries.slice(-8).map((entry) => `- ${entry.status}${typeof entry.exitCode === "number" ? ` exit=${entry.exitCode}` : ""}${entry.command ? ` ${oneLine(entry.command)}` : ""}${entry.summary ? ` - ${oneLine(entry.summary)}` : ""}`).join("\n") : "- none",
    "FailureState:",
    state.failure.latest ? `- latest: ${oneLine(state.failure.latest.reason)}${state.failure.latest.remainingRisk ? ` remainingRisk=${oneLine(state.failure.latest.remainingRisk)}` : ""}` : "- none",
    "EvidenceState:",
    state.evidence.entries.length ? [
      `- counts: current=${state.evidence.currentCount} stale=${state.evidence.staleCount} unknown=${state.evidence.unknownCount}`,
      ...state.evidence.entries.slice(-8).map((entry) => `- ${entry.freshness}${entry.path ? ` ${entry.path}` : ""} - ${oneLine(entry.summary)}`),
    ].join("\n") : "- none",
    "VisualEvidenceFallback:",
    state.visualEvidence.entries.length ? state.visualEvidence.entries.slice(-5).map((entry) => `- ${entry.staleness}${entry.artifactPath ? ` ${entry.artifactPath}` : ""}${typeof entry.page === "number" ? ` page=${entry.page}` : ""}${entry.sourceHash ? ` sourceHash=${entry.sourceHash}` : ""} - ${oneLine(entry.fallbackText)}`).join("\n") : "- none",
    "WorldStateBaseline:",
    state.world.latest ? `- root=${state.world.latest.workspaceRoot ?? "unknown"} git=${state.world.latest.gitHead ?? "unknown"} fullReinjectRequired=${state.world.fullReinjectRequired ? "true" : "false"}${state.world.reason ? ` reason=${oneLine(state.world.reason)}` : ""}` : "- missing",
    compaction ? "CompactionCandidate:" : "",
    compaction ? `- id=${compaction.id} trigger=${compaction.trigger} status=${compaction.status} retained=${compaction.retainedMessageIds.length} omitted=${compaction.omittedMessageCount}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}

function latestVisibleUserItems(
  items: HistoryTranscriptItem[],
  input: { maxTokens: number; maxMessages: number; model?: string },
) {
  const maxTokens = Math.max(1, Math.floor(input.maxTokens))
  const maxMessages = Math.max(1, Math.floor(input.maxMessages))
  const users = items.filter((item) => item.visibility === "model-visible" && item.role === "user")
  const selected: HistoryTranscriptItem[] = []
  let tokens = 0
  for (let index = users.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxMessages) break
    const item = users[index]
    if (!item) continue
    const itemTokens = estimateChatTokenUsage({
      messages: [{ role: "user", content: item.content }],
      outputText: "",
      model: input.model,
    }).input ?? 0
    if (selected.length > 0 && tokens + itemTokens > maxTokens) break
    selected.unshift(item)
    tokens += itemTokens
  }
  return selected
}

function compactSummary(state: ConversationContextState) {
  const lines = [
    "Compacted ChipMate conversation context.",
    state.task.currentObjective ? `Current objective: ${state.task.currentObjective}` : "",
    state.task.corrections.length ? `User corrections: ${state.task.corrections.join(" | ")}` : "",
    state.task.latestFailure ? `Latest failure: ${state.task.latestFailure.reason}` : "",
    state.task.nextActions.length ? `Next actions: ${state.task.nextActions.join(" | ")}` : "",
    state.memory.latestSummary ? `Prior memory: ${state.memory.latestSummary}` : "",
    state.evidence.entries.length ? `Evidence records: ${state.evidence.entries.length}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}

function highPriorityStateSnapshot(state: ConversationContextState, now: number) {
  const lines = [
    `<chipmate-high-priority-state id="state:${now.toString(36)}">`,
    "TaskState:",
    state.task.currentObjective ? `- currentObjective: ${oneLine(state.task.currentObjective)}` : "",
    state.task.goal?.status ? `- goalStatus: ${oneLine(state.task.goal.status)}` : "",
    state.task.corrections.length ? `- userCorrections: ${state.task.corrections.slice(-5).map(oneLine).join(" | ")}` : "",
    state.task.nextActions.length ? `- nextActions: ${state.task.nextActions.slice(-5).map(oneLine).join(" | ")}` : "",
    state.task.latestFailure ? `- latestTaskFailure: ${oneLine(state.task.latestFailure.reason)}` : "",
    "PlanState:",
    state.plan.steps.length ? state.plan.steps.slice(0, 8).map((step) => `- ${step.id} [${step.status}] ${oneLine(step.title)}${state.plan.activeStepID === step.id ? " active=true" : ""}`).join("\n") : "- none",
    "FailureState:",
    state.failure.latest ? `- latest: ${oneLine(state.failure.latest.reason)}${state.failure.latest.remainingRisk ? ` remainingRisk=${oneLine(state.failure.latest.remainingRisk)}` : ""}${state.failure.latest.retryRule ? ` retryRule=${oneLine(state.failure.latest.retryRule)}` : ""}` : "- none",
    state.failure.entries.length > 1 ? state.failure.entries.slice(-3, -1).map((entry) => `- prior: ${oneLine(entry.reason)}`).join("\n") : "",
    "VerificationState:",
    state.verification.entries.length ? state.verification.entries.slice(-6).map(renderVerificationSnapshotLine).join("\n") : "- none",
    "FileState:",
    state.file.entries.length ? state.file.entries.slice(-10).map(renderFileSnapshotLine).join("\n") : "- none",
    "</chipmate-high-priority-state>",
  ].filter(Boolean)
  const content = lines.join("\n")
  return content.includes("currentObjective:")
    || content.includes("userCorrections:")
    || content.includes("PlanState:\n- ")
    || content.includes("latest:")
    || content.includes("VerificationState:\n- ")
    || content.includes("FileState:\n- ")
    ? content
    : undefined
}

function renderVerificationSnapshotLine(entry: ConversationContextState["verification"]["entries"][number]) {
  const command = entry.command ? ` command=${oneLine(entry.command)}` : ""
  const cwd = entry.cwd ? ` cwd=${oneLine(entry.cwd)}` : ""
  const exit = typeof entry.exitCode === "number" ? ` exit=${entry.exitCode}` : ""
  const summary = entry.summary ? ` summary=${oneLine(entry.summary)}` : ""
  return `- ${entry.id} [${entry.status}]${exit}${command}${cwd}${summary}`
}

function renderFileSnapshotLine(entry: ConversationContextState["file"]["entries"][number]) {
  const summary = entry.summary ? ` summary=${oneLine(entry.summary)}` : ""
  return `- ${entry.path} [${entry.status}] source=${entry.source}${summary}`
}

function compactedHistoryRole(item: ReplacementHistoryItem): CompactedHistoryMessage["role"] {
  if (item.kind === "compaction_summary") return "assistant"
  return item.role === "assistant" ? "assistant" : "user"
}

function compactedHistoryContent(record: ContextCompactionEventRecord, item: ReplacementHistoryItem) {
  if (item.kind === "compaction_summary") {
    return [
      "ChipMate compacted conversation continuity context. Use this as prior context, not as a new user request.",
      `<chipmate-compaction-summary id="${record.id}" historyVersion="${record.historyVersion}" omittedMessages="${record.omittedMessageCount}">`,
      item.content,
      "</chipmate-compaction-summary>",
    ].join("\n")
  }
  if (item.kind === "initial_context") {
    return [
      "ChipMate restored initial context after compaction. Use this as continuity context, not as a new user request.",
      item.content,
    ].join("\n\n")
  }
  return item.content
}

function normalizeReplacementHistoryItem(value: unknown, diagnostics: CompactedHistoryAdapterDiagnostic[]): ReplacementHistoryItem | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
    diagnostics.push({
      severity: "warning",
      code: "invalid_replacement_item",
      message: "Skipped invalid compact replacement item.",
    })
    return undefined
  }
  const id = value.id
  const rawRole = value.role
  const rawKind = value.kind
  if (rawRole === "tool" || rawKind === "tool_output") {
    diagnostics.push({
      severity: "warning",
      code: "orphan_tool_output_removed",
      message: `Skipped orphan tool output compact replacement item ${id}.`,
      sourceItemId: id,
    })
    return undefined
  }
  if (!isReplacementHistoryKind(rawKind)) {
    diagnostics.push({
      severity: "warning",
      code: "invalid_replacement_item",
      message: `Skipped unsupported compact replacement item ${id}.`,
      sourceItemId: id,
    })
    return undefined
  }
  if (typeof value.content !== "string") {
    diagnostics.push({
      severity: "warning",
      code: "unsupported_modality_normalized",
      message: `Skipped non-text compact replacement item ${id}; provider history currently accepts text-only compact output.`,
      sourceItemId: id,
    })
    return undefined
  }
  let role: ReplacementHistoryItem["role"]
  if (rawRole === "user" || rawRole === "assistant" || rawRole === "system") {
    role = rawRole
  } else {
    role = rawKind === "compaction_summary" ? "assistant" : "user"
    diagnostics.push({
      severity: "warning",
      code: "unsupported_role_normalized",
      message: `Normalized unsupported compact replacement role on item ${id}.`,
      sourceItemId: id,
    })
  }
  const source = value.source === "history_transcript" || value.source === "compaction_summary" || value.source === "initial_context"
    ? value.source
    : rawKind === "compaction_summary"
      ? "compaction_summary"
      : rawKind === "initial_context"
        ? "initial_context"
        : "history_transcript"
  return {
    id,
    kind: rawKind,
    role,
    content: value.content,
    sourceMessageId: typeof value.sourceMessageId === "string" ? value.sourceMessageId : undefined,
    source,
  }
}

function isReplacementHistoryKind(value: string): value is ReplacementHistoryItem["kind"] {
  return value === "retained_user_message" || value === "compaction_summary" || value === "initial_context"
}

function stripJsonFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value.trim() : ""
}

function stringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
}

function persistentStatusFromCompaction(status: CompactionStatus): PersistentCompactionStatus {
  return status === "candidate" ? "completed" : status
}

function reasonFromTrigger(trigger: CompactionTrigger): CompactionReason {
  if (trigger === "manual") return "user_requested"
  if (trigger === "pre_turn_hard_limit") return "hard_limit"
  if (trigger === "request_stage_truncated") return "request_stage_truncated"
  if (trigger === "mid_turn_pressure") return "mid_turn_pressure"
  if (trigger === "soft_threshold") return "soft_threshold"
  return "unknown"
}

function triggerFromWindowState(state: ContextWindowState): CompactionTrigger {
  if (state.reason === "request_stage_truncated") return "request_stage_truncated"
  if (state.reason === "hard_limit") return "pre_turn_hard_limit"
  return "soft_threshold"
}

function implementationFromStatus(status: PersistentCompactionStatus): CompactionImplementation {
  return status === "fallback_pruned" ? "fallback_pruned" : "local_summary"
}

function strategyFromStatus(status: PersistentCompactionStatus): CompactionStrategy {
  return status === "fallback_pruned" ? "fallback_pruned" : "local_summary"
}

function phaseFromTrigger(trigger: CompactionTrigger): CompactionPhase {
  if (trigger === "manual") return "manual"
  if (trigger === "mid_turn_pressure") return "mid_turn"
  if (trigger === "request_stage_truncated") return "request_stage"
  return "pre_turn"
}

function isContextCompactionEventRecord(value: unknown): value is ContextCompactionEventRecord {
  if (!isRecord(value)) return false
  return value.version === CONTEXT_COMPACTION_EVENT_VERSION
    && typeof value.id === "string"
    && isPersistentCompactionStatus(value.status)
    && isCompactionTrigger(value.trigger)
    && Array.isArray(value.replacementHistory)
    && Array.isArray(value.retainedMessageIds)
    && Array.isArray(value.omittedMessageIds)
    && typeof value.historyVersion === "number"
    && isRecord(value.window)
}

function isPersistentCompactionStatus(value: unknown): value is PersistentCompactionStatus {
  return value === "completed" || value === "failed" || value === "interrupted" || value === "fallback_pruned"
}

function isCompactionTrigger(value: unknown): value is CompactionTrigger {
  return value === "pre_turn_hard_limit"
    || value === "manual"
    || value === "mid_turn_pressure"
    || value === "request_stage_truncated"
    || value === "soft_threshold"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 300)
}

function boundedText(value: string, maxChars: number) {
  const normalized = value.replace(/\r\n/g, "\n").trim()
  if (normalized.length <= maxChars) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, Math.max(0, maxChars))}\n[truncated ${normalized.length - maxChars} chars]`, truncated: true }
}

function positiveLimit(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function xmlAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function textByteLength(input: string) {
  return new TextEncoder().encode(input).length
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
