import type { ChatContextWindowResolution } from "./context-window"
import { estimateChatTokenUsage } from "./usage"

export type ContextPackChatMessage = {
  role: string
  content?: unknown
}

export type ContextPackSection = {
  id: string
  label: string
  priority: number
  tokens: number
  bytes: number
  truncated: boolean
  reason?: string
}

export type ContextPackBudgetReport = {
  source: "shadow" | "request-stage-token-gate"
  model?: string
  messageCount: number
  totalEstimatedTokens: number
  totalBytes: number
  contextWindow: ChatContextWindowResolution
  sections: ContextPackSection[]
  omittedMessages: number
  omittedEstimatedTokens: number
  truncated: boolean
  reason?: string
}

export type ContextWindowAutoCompactScope = "total" | "body_after_prefill"

export type ContextWindowPressureReason = "soft_threshold" | "hard_limit" | "request_stage_truncated"

export type ContextWindowState = {
  source: ContextPackBudgetReport["source"]
  model?: string
  windowSource: ChatContextWindowResolution["source"]
  modelContextWindow: number
  effectiveContextWindow: number
  safetyMarginTokens: number
  autoCompactScope: ContextWindowAutoCompactScope
  autoCompactThresholdRatio: number
  compactionThresholdTokens: number
  activeTokens: number
  prefillTokens: number
  bodyTokens: number
  scopeTokens: number
  activeRatio: number
  pressureRatio: number
  tokensUntilCompaction: number
  tokenLimitReached: boolean
  hardLimitReached: boolean
  requestStageTruncated: boolean
  shouldCompact: boolean
  reason?: ContextWindowPressureReason
  fallbackNotice?: string
}

export type RequestStageTokenGateResult<T extends ContextPackChatMessage> = {
  messages: T[]
  report: ContextPackBudgetReport
}

export const DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO = 0.9

export function buildContextPackShadowReport(input: {
  messages: ContextPackChatMessage[]
  model?: string
  contextWindow: ChatContextWindowResolution
}): ContextPackBudgetReport {
  const sections = input.messages.map((message, index) => sectionFromMessage(message, index, input.messages.length, input.model))
  return {
    source: "shadow",
    model: input.model,
    messageCount: input.messages.length,
    totalEstimatedTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
    totalBytes: sections.reduce((sum, section) => sum + section.bytes, 0),
    contextWindow: input.contextWindow,
    sections,
    omittedMessages: 0,
    omittedEstimatedTokens: 0,
    truncated: false,
  }
}

export function applyRequestStageTokenGate<T extends ContextPackChatMessage>(input: {
  messages: T[]
  model?: string
  contextWindow: ChatContextWindowResolution
}): RequestStageTokenGateResult<T> {
  const shadow = buildContextPackShadowReport(input)
  if (shadow.totalEstimatedTokens <= input.contextWindow.effectiveContextWindow) {
    return { messages: input.messages, report: { ...shadow, source: "request-stage-token-gate" } }
  }

  const selected = input.messages.map((message, index) => ({ message, index, section: shadow.sections[index] })).filter((entry) => entry.section)
  const protectedEntries = selected.filter((entry) => isProtectedMessage(entry.message, entry.index, input.messages.length))
  const candidates = selected.filter((entry) => !isProtectedMessage(entry.message, entry.index, input.messages.length)).sort((left, right) => {
    const priority = left.section.priority - right.section.priority
    return priority === 0 ? left.index - right.index : priority
  })
  const omitted = new Set<number>()
  let estimatedTokens = shadow.totalEstimatedTokens
  for (const candidate of candidates) {
    if (estimatedTokens <= input.contextWindow.effectiveContextWindow) break
    omitted.add(candidate.index)
    estimatedTokens -= candidate.section.tokens
  }

  const messages = selected
    .filter((entry) => !omitted.has(entry.index) || protectedEntries.some((protectedEntry) => protectedEntry.index === entry.index))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message)
  const omittedSections = shadow.sections.filter((_, index) => omitted.has(index))
  return {
    messages,
    report: {
      ...shadow,
      source: "request-stage-token-gate",
      messageCount: messages.length,
      omittedMessages: omitted.size,
      omittedEstimatedTokens: omittedSections.reduce((sum, section) => sum + section.tokens, 0),
      totalEstimatedTokens: estimatedTokens,
      truncated: omitted.size > 0,
      reason: omitted.size > 0 ? "request-stage token gate pruned lower-priority context sections" : undefined,
    },
  }
}

export function buildContextWindowState(input: {
  report: ContextPackBudgetReport
  autoCompactScope?: ContextWindowAutoCompactScope
  autoCompactThresholdRatio?: number
}): ContextWindowState {
  const report = input.report
  const autoCompactScope = input.autoCompactScope ?? "body_after_prefill"
  const thresholdRatio = boundedRatio(input.autoCompactThresholdRatio, DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO)
  const effectiveContextWindow = Math.max(1, report.contextWindow.effectiveContextWindow)
  const prefillTokens = report.sections
    .filter((section) => isPrefillSection(section))
    .reduce((sum, section) => sum + section.tokens, 0)
  const activeTokens = Math.max(0, report.totalEstimatedTokens)
  const bodyTokens = Math.max(0, activeTokens - prefillTokens)
  const scopeTokens = autoCompactScope === "body_after_prefill" ? bodyTokens : activeTokens
  const compactionThresholdTokens = Math.max(1, Math.floor(effectiveContextWindow * thresholdRatio))
  const hardLimitReached = activeTokens > effectiveContextWindow
  const requestStageTruncated = report.truncated
  const softThresholdReached = scopeTokens >= compactionThresholdTokens
  const reason: ContextWindowPressureReason | undefined = requestStageTruncated
    ? "request_stage_truncated"
    : hardLimitReached
      ? "hard_limit"
      : softThresholdReached
        ? "soft_threshold"
        : undefined
  return {
    source: report.source,
    model: report.model,
    windowSource: report.contextWindow.source,
    modelContextWindow: report.contextWindow.modelContextWindow,
    effectiveContextWindow,
    safetyMarginTokens: report.contextWindow.safetyMarginTokens,
    autoCompactScope,
    autoCompactThresholdRatio: thresholdRatio,
    compactionThresholdTokens,
    activeTokens,
    prefillTokens,
    bodyTokens,
    scopeTokens,
    activeRatio: activeTokens / effectiveContextWindow,
    pressureRatio: scopeTokens / effectiveContextWindow,
    tokensUntilCompaction: Math.max(0, compactionThresholdTokens - scopeTokens),
    tokenLimitReached: requestStageTruncated || hardLimitReached,
    hardLimitReached,
    requestStageTruncated,
    shouldCompact: Boolean(reason),
    reason,
    fallbackNotice: report.contextWindow.fallbackNotice,
  }
}

export function formatContextWindowState(state: ContextWindowState) {
  const reason = state.reason ? ` reason=${state.reason}` : ""
  const fallback = state.fallbackNotice ? " fallbackDefault=true" : ""
  return `[context-window-state] source=${state.source} scope=${state.autoCompactScope} activeTokens=${state.activeTokens}/${state.effectiveContextWindow} prefillTokens=${state.prefillTokens} bodyTokens=${state.bodyTokens} scopeTokens=${state.scopeTokens} threshold=${state.compactionThresholdTokens} tokensUntilCompaction=${state.tokensUntilCompaction} hardLimitReached=${state.hardLimitReached ? "true" : "false"} truncated=${state.requestStageTruncated ? "true" : "false"} shouldCompact=${state.shouldCompact ? "true" : "false"}${reason}${fallback}`
}

export function formatContextPackBudgetReport(report: ContextPackBudgetReport) {
  const omitted = report.omittedMessages ? ` omittedMessages=${report.omittedMessages} omittedTokens=${report.omittedEstimatedTokens}` : ""
  const fallback = report.contextWindow.fallbackNotice ? " fallbackDefault=true" : ""
  return `[context-pack] source=${report.source} messages=${report.messageCount} tokens=${report.totalEstimatedTokens}/${report.contextWindow.effectiveContextWindow} window=${report.contextWindow.modelContextWindow} windowSource=${report.contextWindow.source}${omitted}${fallback}`
}

function sectionFromMessage(message: ContextPackChatMessage, index: number, total: number, model: string | undefined): ContextPackSection {
  const text = messageText(message)
  return {
    id: sectionID(message, index, total),
    label: message.role,
    priority: priorityForMessage(message, index, total),
    tokens: estimateChatTokenUsage({ messages: [message], outputText: "", model }).input ?? 0,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: false,
  }
}

function sectionID(message: ContextPackChatMessage, index: number, total: number) {
  if (index === 0 && message.role === "system") return "system_prompt"
  if (index === total - 1 && message.role === "user") return "latest_user_request"
  if (containsTaskState(message)) return "task_state"
  if (message.role === "tool") return "tool_output"
  return `${message.role}_${index}`
}

function priorityForMessage(message: ContextPackChatMessage, index: number, total: number) {
  if (index === 0 || index === total - 1) return 100
  if (containsTaskState(message)) return 95
  if (message.role === "tool") return 40
  return 50
}

function isProtectedMessage(message: ContextPackChatMessage, index: number, total: number) {
  return index === 0 || index === total - 1 || containsTaskState(message)
}

function isPrefillSection(section: ContextPackSection) {
  return section.id === "system_prompt" || section.id === "task_state"
}

function containsTaskState(message: ContextPackChatMessage) {
  return messageText(message).includes("<chipmate-task-state>")
}

function boundedRatio(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0.01, value))
}

function messageText(message: ContextPackChatMessage): string {
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part
      if (isRecord(part) && typeof part.text === "string") return part.text
      return ""
    }).join("\n")
  }
  return content === undefined || content === null ? "" : JSON.stringify(content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
