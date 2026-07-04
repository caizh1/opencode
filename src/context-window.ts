export const DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS = 262_144
export const CHAT_CONTEXT_WINDOW_SAFETY_MARGIN_TOKENS = 4096

export type ChatContextWindowSource =
  | "configured"
  | "provider_metadata"
  | "builtin_table"
  | "fallback_default"

export type ChatContextWindowResolution = {
  modelContextWindow: number
  source: ChatContextWindowSource
  model?: string
  safetyMarginTokens: number
  effectiveContextWindow: number
  fallbackNotice?: string
}

export type ResolveChatContextWindowInput = {
  configuredContextLength?: number
  model?: string
  providerModels?: unknown
  safetyMarginTokens?: number
}

const BUILTIN_MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; contextWindow: number }> = [
  { pattern: /\bgpt-4\.1\b/i, contextWindow: 1_047_576 },
  { pattern: /\bgpt-4o\b/i, contextWindow: 128_000 },
  { pattern: /\bgpt-4\b/i, contextWindow: 128_000 },
  { pattern: /\bclaude-3\.5\b/i, contextWindow: 200_000 },
  { pattern: /\bclaude-3-5\b/i, contextWindow: 200_000 },
  { pattern: /\bqwen3\b/i, contextWindow: 262_144 },
  { pattern: /\bqwen2\.5\b/i, contextWindow: 128_000 },
  { pattern: /\bdeepseek\b/i, contextWindow: 128_000 },
]

export function resolveChatContextWindow(input: ResolveChatContextWindowInput): ChatContextWindowResolution {
  const safetyMarginTokens = nonNegativeInteger(input.safetyMarginTokens) ?? CHAT_CONTEXT_WINDOW_SAFETY_MARGIN_TOKENS
  const configured = positiveInteger(input.configuredContextLength)
  if (configured) return resolution(configured, "configured", input.model, safetyMarginTokens)

  const metadata = contextWindowFromProviderMetadata(input.providerModels, input.model)
  if (metadata) return resolution(metadata, "provider_metadata", input.model, safetyMarginTokens)

  const builtin = contextWindowFromBuiltinTable(input.model)
  if (builtin) return resolution(builtin, "builtin_table", input.model, safetyMarginTokens)

  return {
    ...resolution(DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS, "fallback_default", input.model, safetyMarginTokens),
    fallbackNotice: `未能从模型元数据获取上下文长度，当前使用默认 ${DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS} tokens。可在设置中手动调整 chipmate.provider.contextLength。`,
  }
}

export function contextWindowFromProviderMetadata(providerModels: unknown, model: string | undefined): number | undefined {
  const records = providerModelRecords(providerModels)
  if (!records.length) return undefined
  const selected = model?.trim()
  const candidates = selected
    ? records.filter((record) => stringValue(record.id) === selected || stringValue(record.name) === selected || stringValue(record.model) === selected)
    : records
  for (const record of candidates.length ? candidates : records) {
    const value = contextWindowValue(record)
    if (value) return value
  }
  return undefined
}

export function contextWindowFromBuiltinTable(model: string | undefined): number | undefined {
  const value = model?.trim()
  if (!value) return undefined
  return BUILTIN_MODEL_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(value))?.contextWindow
}

function resolution(modelContextWindow: number, source: ChatContextWindowSource, model: string | undefined, safetyMarginTokens: number): ChatContextWindowResolution {
  return {
    modelContextWindow,
    source,
    model: model?.trim() || undefined,
    safetyMarginTokens,
    effectiveContextWindow: Math.max(1, modelContextWindow - safetyMarginTokens),
  }
}

function providerModelRecords(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input.filter(isRecord)
  if (isRecord(input) && Array.isArray(input.data)) return input.data.filter(isRecord)
  return []
}

function contextWindowValue(record: Record<string, unknown>): number | undefined {
  const nested = isRecord(record.limits) ? record.limits : isRecord(record.limit) ? record.limit : undefined
  return positiveInteger(record.context_length)
    ?? positiveInteger(record.contextLength)
    ?? positiveInteger(record.context_window)
    ?? positiveInteger(record.contextWindow)
    ?? positiveInteger(record.max_context_length)
    ?? positiveInteger(record.maxContextLength)
    ?? positiveInteger(record.max_model_len)
    ?? positiveInteger(record.maxModelLen)
    ?? positiveInteger(record.contextLimit)
    ?? positiveInteger(nested?.context)
}

function positiveInteger(value: unknown): number | undefined {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
