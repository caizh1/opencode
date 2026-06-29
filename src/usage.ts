import type {
  ChipMateMessage,
  ChipMateMessageInfo,
  ChipMateModelInfo,
  ChipMateModelLimit,
  ChipMateTokenUsage,
  RenderedSessionUsage,
  RenderedUsage,
  UsageLevel,
} from "./types"
import { countTokens } from "./qwen-autocomplete/tokenPruning"

const USAGE_SEPARATOR = " | "

export function usageFromMessageInfo(info: ChipMateMessageInfo | undefined, modelLimit?: ChipMateModelLimit): RenderedUsage | undefined {
  if (info?.role !== "assistant") return
  const tokens = normalizeTokenUsage(info.tokens)
  if (!tokens || !hasPositiveUsage(tokens)) return
  if (isLikelyAccumulatedReportedUsage({ tokens, usageKind: info.usageKind, modelLimit })) return
  return renderUsage(tokens, nonNegativeNumber(info.cost))
}

export function summarizeSessionUsage(input: {
  messages: ChipMateMessage[]
  models: ChipMateModelInfo[]
  selectedModel: string
  loadedMessageLimit?: number
}): RenderedSessionUsage {
  const assistantMessages = input.messages.filter((message) => message.info.role === "assistant")
  const usages = assistantMessages.flatMap((message) => {
    const usage = usageFromMessageInfo(message.info, resolveContextLimitForMessage({
      info: message.info,
      models: input.models,
      selectedModel: input.selectedModel,
    }))
    return usage ? [usage] : []
  })

  if (usages.length === 0) {
    const hasAssistantMessages = assistantMessages.length > 0
    const pending = !hasAssistantMessages || assistantMessages.some((message) => isPendingZeroUsage(message.info))
    return {
      status: pending ? "pending" : "unavailable",
      summary: pending ? "Usage pending" : "Usage unavailable",
      detail: pending
        ? "Token usage will appear after ChipMate returns an assistant response."
        : "The configured provider did not return token usage for loaded assistant messages.",
      level: "normal",
    }
  }

  const latest = usages[usages.length - 1]
  const maybeCapped = input.loadedMessageLimit !== undefined && input.messages.length >= input.loadedMessageLimit
  const total = totalUsage(usages, maybeCapped)
  const modelLimit = resolveContextLimit({
    messages: input.messages,
    models: input.models,
    selectedModel: input.selectedModel,
  })
  const latestInput = positiveNumber(latest.input)
  const context = latestInput === undefined ? undefined : contextSummary(latestInput, modelLimit)
  const level = contextLevel(context?.ratio)

  return {
    status: "available",
    summary: context?.summary ?? "Context unavailable",
    detail: [context?.detail, total.detail].filter(Boolean).join(" "),
    level,
    latest,
    total,
    context,
  }
}

export function normalizeTokenUsage(input: ChipMateTokenUsage | unknown): ChipMateTokenUsage | undefined {
  const root = objectRecord(input)
  const cache = objectRecord(root.cache)
  const usage: ChipMateTokenUsage = {
    total: nonNegativeNumber(root.total),
    input: nonNegativeNumber(root.input),
    output: nonNegativeNumber(root.output),
    reasoning: nonNegativeNumber(root.reasoning),
    cache: {
      read: nonNegativeNumber(cache.read),
      write: nonNegativeNumber(cache.write),
    },
  }
  if (!hasNumber(usage.total) && !hasNumber(usage.input) && !hasNumber(usage.output) && !hasNumber(usage.reasoning) && !hasNumber(usage.cache?.read) && !hasNumber(usage.cache?.write)) return
  return usage
}

export function normalizeProviderTokenUsage(input: unknown): ChipMateTokenUsage | undefined {
  const root = objectRecord(input)
  const completionDetails = objectRecord(root.completion_tokens_details)
  const promptDetails = objectRecord(root.prompt_tokens_details)
  const cache = objectRecord(root.cache)
  return normalizeTokenUsage({
    total: root.total ?? root.total_tokens,
    input: root.input ?? root.input_tokens ?? root.prompt_tokens,
    output: root.output ?? root.output_tokens ?? root.completion_tokens,
    reasoning: root.reasoning ?? root.reasoning_tokens ?? completionDetails.reasoning_tokens,
    cache: {
      read: cache.read ?? root.cache_read ?? root.cached_tokens ?? promptDetails.cached_tokens,
      write: cache.write ?? root.cache_write,
    },
  })
}

export function estimateChatTokenUsage(input: {
  messages: unknown[]
  outputText: string
  model?: string
}): ChipMateTokenUsage {
  const model = input.model?.trim() || "gpt-4"
  const messageText = input.messages.map(chatMessageTokenText).filter(Boolean).join("\n")
  const inputTokens = countTokens(messageText, model) + input.messages.length * 4
  const outputTokens = countTokens(input.outputText || "", model)
  return {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
    cache: { read: 0, write: 0 },
  }
}

export function effectiveTokenUsage(tokens: ChipMateTokenUsage) {
  const rawInput = tokens.input ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  const input = effectiveInputTokens(rawInput, cacheRead)
  const total = effectiveTotalTokens(tokens, input, output, reasoning, cacheRead, cacheWrite)
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
  }
}

export function isLikelyAccumulatedReportedUsage(input: {
  tokens: ChipMateTokenUsage
  usageKind?: string
  modelLimit?: ChipMateModelLimit
}) {
  if (input.usageKind === "estimated") return false
  const contextLimit = positiveNumber(input.modelLimit?.context)
  if (!contextLimit) return false
  const effective = effectiveTokenUsage(input.tokens)
  const rawInput = input.tokens.input ?? 0
  const rawTotal = input.tokens.total ?? 0
  const promptCeiling = contextLimit * 1.25
  const totalCeiling = (contextLimit + effective.output + effective.reasoning + effective.cacheWrite) * 1.25
  return rawInput > promptCeiling || effective.input > promptCeiling || rawTotal > totalCeiling
}

export function normalizeModelLimit(input: unknown): ChipMateModelLimit {
  const limit = objectRecord(input)
  return {
    context: positiveNumber(limit.context),
    output: positiveNumber(limit.output),
  }
}

export function formatTokenCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  const absolute = Math.abs(value)
  if (absolute < 1000) return String(Math.round(value))
  if (absolute < 1_000_000) return `${trimDecimal(value / 1000)}k`
  return `${trimDecimal(value / 1_000_000)}m`
}

export function formatCost(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  if (value < 0.01) return `$${value.toFixed(3)}`
  if (value < 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(2)}`
}

function renderUsage(tokens: ChipMateTokenUsage, cost: number | undefined): RenderedUsage {
  const { input, output, reasoning, cacheRead, cacheWrite, total } = effectiveTokenUsage(tokens)
  const summary = usageSummary({ input, output, reasoning, cost })
  const detailParts = [
    input > 0 ? `${formatTokenCount(input)} input` : "",
    output > 0 ? `${formatTokenCount(output)} output` : "",
    reasoning > 0 ? `${formatTokenCount(reasoning)} reasoning` : "",
    cacheRead > 0 ? `${formatTokenCount(cacheRead)} cache read` : "",
    cacheWrite > 0 ? `${formatTokenCount(cacheWrite)} cache write` : "",
    cost !== undefined ? formatCost(cost) : "",
  ].filter(Boolean)

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
    cost,
    summary,
    detail: detailParts.join(USAGE_SEPARATOR),
  }
}

function effectiveInputTokens(input: number, cacheRead: number) {
  return Math.max(0, input - cacheRead)
}

function effectiveTotalTokens(
  tokens: ChipMateTokenUsage,
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
) {
  const total = positiveNumber(tokens.total)
  if (total !== undefined) return Math.max(0, total - cacheRead)
  return input + output + reasoning + cacheWrite
}

function totalUsage(usages: RenderedUsage[], maybeCapped: boolean): RenderedUsage {
  const totals = usages.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      reasoning: sum.reasoning + usage.reasoning,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
      total: sum.total + usage.total,
      cost: sum.cost + (usage.cost ?? 0),
      hasCost: sum.hasCost || usage.cost !== undefined,
    }),
    {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      hasCost: false,
    },
  )
  const cost = totals.hasCost ? totals.cost : undefined
  const session = `${maybeCapped ? "Loaded session" : "Session"} ${formatTokenCount(totals.total)} tokens`
  return {
    input: totals.input,
    output: totals.output,
    reasoning: totals.reasoning,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    total: totals.total,
    cost,
    summary: cost === undefined ? session : `${session}${USAGE_SEPARATOR}${formatCost(cost)}`,
    detail: cost === undefined ? session : `${session}${USAGE_SEPARATOR}${formatCost(cost)}`,
  }
}

function resolveContextLimit(input: {
  messages: ChipMateMessage[]
  models: ChipMateModelInfo[]
  selectedModel: string
}): ChipMateModelLimit {
  const latestAssistant = [...input.messages]
    .reverse()
    .map((message) => message.info)
    .find((info) => info.role === "assistant" && info.providerID && info.modelID)
  const latestID =
    latestAssistant?.providerID && latestAssistant.modelID
      ? `${latestAssistant.providerID}/${latestAssistant.modelID}`
      : ""
  const selectedID = input.selectedModel.trim()
  const model = input.models.find((item) => item.id === latestID) ?? input.models.find((item) => item.id === selectedID)
  return {
    context: model?.contextLimit,
    output: model?.outputLimit,
  }
}

function resolveContextLimitForMessage(input: {
  info: ChipMateMessageInfo
  models: ChipMateModelInfo[]
  selectedModel: string
}): ChipMateModelLimit {
  const modelKey =
    input.info.providerID && input.info.modelID
      ? `${input.info.providerID}/${input.info.modelID}`
      : ""
  const selectedID = input.selectedModel.trim()
  const model = input.models.find((item) => item.id === modelKey) ?? input.models.find((item) => item.id === selectedID)
  return {
    context: model?.contextLimit,
    output: model?.outputLimit,
  }
}

function contextSummary(used: number, limit: ChipMateModelLimit) {
  if (used <= 0) return
  if (!limit.context) {
    return {
      used,
      summary: `Context ${formatTokenCount(used)}${USAGE_SEPARATOR}limit unknown`,
      detail: `Context ${formatTokenCount(used)} tokens used by the latest assistant turn input. Model context limit is unknown.`,
    }
  }
  const remaining = Math.max(0, limit.context - used)
  const ratio = used / limit.context
  return {
    used,
    limit: limit.context,
    remaining,
    ratio,
    summary: `Context ${formatTokenCount(used)} / ${formatTokenCount(limit.context)}${USAGE_SEPARATOR}${formatTokenCount(remaining)} left est.`,
    detail: `Estimated context remaining: ${formatTokenCount(remaining)} tokens of ${formatTokenCount(limit.context)}.`,
  }
}

function contextLevel(ratio: number | undefined): UsageLevel {
  if (ratio === undefined) return "normal"
  if (ratio >= 1) return "error"
  if (ratio >= 0.8) return "warning"
  return "normal"
}

function usageSummary(input: { input: number; output: number; reasoning: number; cost?: number }) {
  const parts = []
  if (input.input > 0) parts.push(`${formatTokenCount(input.input)} in`)
  if (input.output > 0) parts.push(`${formatTokenCount(input.output)} out`)
  if (input.reasoning > 0) parts.push(`${formatTokenCount(input.reasoning)} reason`)
  if (input.cost !== undefined) parts.push(formatCost(input.cost))
  return parts.join(USAGE_SEPARATOR)
}

function isPendingZeroUsage(info: ChipMateMessageInfo) {
  if (info.time?.completed) return false
  const tokens = normalizeTokenUsage(info.tokens)
  return Boolean(tokens && !hasPositiveUsage(tokens))
}

function hasPositiveUsage(tokens: ChipMateTokenUsage) {
  return [
    tokens.total,
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
}

function positiveNumber(input: unknown) {
  const value = numberValue(input)
  return value !== undefined && value > 0 ? value : undefined
}

function nonNegativeNumber(input: unknown) {
  const value = numberValue(input)
  return value !== undefined && value >= 0 ? value : undefined
}

function numberValue(input: unknown) {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  return input
}

function hasNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input)
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function chatMessageTokenText(input: unknown): string {
  const message = objectRecord(input)
  const role = typeof message.role === "string" ? message.role : ""
  const content = chatContentTokenText(message.content)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((item) => JSON.stringify(item)).join("\n") : ""
  const toolCallID = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
  return [role, content, toolCalls, toolCallID].filter(Boolean).join("\n")
}

function chatContentTokenText(input: unknown): string {
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  return input.map((part) => {
    const record = objectRecord(part)
    if (typeof record.text === "string") return record.text
    const image = objectRecord(record.image_url)
    if (typeof image.url === "string") return `[image:${image.detail ?? "auto"}]`
    return ""
  }).filter(Boolean).join("\n")
}

function trimDecimal(value: number) {
  return value.toFixed(1).replace(/\.0$/, "")
}
