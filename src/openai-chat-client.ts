export type OpenAIChatRole = "system" | "user" | "assistant" | "tool"

export type OpenAIChatToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type OpenAIChatMessage = {
  role: OpenAIChatRole
  content?: string | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: OpenAIChatToolCall[]
}

export type OpenAIChatTool = {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type OpenAIChatSettings = {
  apiBaseUrl: string
  model: string
  maxTokens?: number
  temperature?: number
  topP?: number
  streaming?: boolean
}

export type OpenAIChatUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

export type OpenAIChatStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; toolCall: OpenAIChatToolCall }
  | { type: "fallback"; reason: string }

export type OpenAIChatCompletionResult = {
  id?: string
  model?: string
  message: OpenAIChatMessage
  usage?: OpenAIChatUsage
  streamed: boolean
  fallbackReason?: string
}

export class OpenAIChatRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "OpenAIChatRequestError"
  }
}

export class OpenAIChatConnectionError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`Cannot connect to chat model API ${url}: ${formatError(cause)}`)
    this.name = "OpenAIChatConnectionError"
  }
}

export class OpenAIChatClient {
  constructor(
    private readonly settings: OpenAIChatSettings,
    private readonly apiKey?: string,
  ) {}

  async complete(input: {
    messages: OpenAIChatMessage[]
    signal?: AbortSignal
    tools?: OpenAIChatTool[]
    toolChoice?: "auto" | "none" | Record<string, unknown>
    stream?: boolean
    onEvent?: (event: OpenAIChatStreamEvent) => void
  }): Promise<OpenAIChatCompletionResult> {
    this.validateSettings()
    const shouldStream = input.stream ?? this.settings.streaming ?? true
    if (shouldStream) {
      try {
        return await this.streamCompletion(input)
      } catch (error) {
        if (!isStreamingFallbackError(error)) throw error
        const reason = formatError(error)
        input.onEvent?.({ type: "fallback", reason })
        return {
          ...(await this.blockingCompletion({ ...input, stream: false })),
          fallbackReason: reason,
        }
      }
    }
    return this.blockingCompletion({ ...input, stream: false })
  }

  private validateSettings() {
    if (!this.settings.apiBaseUrl.trim()) throw new OpenAIChatRequestError(0, "Chat API base URL is required.")
    if (!this.settings.model.trim()) throw new OpenAIChatRequestError(0, "Chat model is required.")
  }

  private async blockingCompletion(input: {
    messages: OpenAIChatMessage[]
    signal?: AbortSignal
    tools?: OpenAIChatTool[]
    toolChoice?: "auto" | "none" | Record<string, unknown>
    stream?: boolean
  }): Promise<OpenAIChatCompletionResult> {
    const body = await this.postJson(chatCompletionsUrl(this.settings.apiBaseUrl), {
      method: "POST",
      signal: input.signal,
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(input, false)),
    })
    return {
      ...normalizeChatCompletion(body),
      streamed: false,
    }
  }

  private async streamCompletion(input: {
    messages: OpenAIChatMessage[]
    signal?: AbortSignal
    tools?: OpenAIChatTool[]
    toolChoice?: "auto" | "none" | Record<string, unknown>
    onEvent?: (event: OpenAIChatStreamEvent) => void
  }): Promise<OpenAIChatCompletionResult> {
    const url = chatCompletionsUrl(this.settings.apiBaseUrl)
    const response = await this.safeFetch(url, {
      method: "POST",
      signal: input.signal,
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(input, true)),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new OpenAIChatRequestError(response.status, responseErrorMessage(response, text))
    }
    if (!response.body) throw new OpenAIChatRequestError(response.status, "Chat model stream has no body.")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let content = ""
    let reasoning = ""
    let id = ""
    let model = ""
    let usage: OpenAIChatUsage | undefined
    const toolCalls = new Map<number, OpenAIChatToolCall>()

    while (!input.signal?.aborted) {
      const result = await reader.read()
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let boundary = findEventBoundary(buffer)
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        const data = parseSseData(raw)
        if (data === "[DONE]") {
          boundary = -1
          break
        }
        if (data) {
          const chunk = parseJsonChunk(data)
          const root = objectRecord(chunk)
          id = stringValue(root.id) || id
          model = stringValue(root.model) || model
          usage = usage ?? usageValue(root.usage)
          const choice = firstChoice(root)
          const delta = objectRecord(choice.delta)
          const textDelta = stringValue(delta.content)
          const reasoningDelta = stringValue(delta.reasoning_content)
          if (textDelta) {
            content += textDelta
            input.onEvent?.({ type: "text-delta", text: textDelta })
          }
          if (reasoningDelta) {
            reasoning += reasoningDelta
            input.onEvent?.({ type: "reasoning-delta", text: reasoningDelta })
          }
          for (const update of toolCallDeltas(delta.tool_calls)) {
            const merged = mergeToolCallDelta(toolCalls.get(update.index), update)
            toolCalls.set(update.index, merged)
            input.onEvent?.({ type: "tool-call-delta", index: update.index, toolCall: merged })
          }
        }
        boundary = findEventBoundary(buffer)
      }
    }

    const message = assistantMessage(content, reasoning, [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .filter((call) => call.function.name))

    if (!hasModelOutput(message)) {
      throw new OpenAIChatRequestError(0, "Chat model stream produced no assistant content.")
    }

    return {
      id: id || undefined,
      model: model || undefined,
      usage,
      message,
      streamed: true,
    }
  }

  private requestBody(input: {
    messages: OpenAIChatMessage[]
    tools?: OpenAIChatTool[]
    toolChoice?: "auto" | "none" | Record<string, unknown>
  }, stream: boolean) {
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: input.messages,
      stream,
    }
    if (this.settings.maxTokens !== undefined) body.max_tokens = this.settings.maxTokens
    if (this.settings.temperature !== undefined) body.temperature = this.settings.temperature
    if (this.settings.topP !== undefined) body.top_p = this.settings.topP
    if (input.tools?.length) body.tools = input.tools
    if (input.toolChoice !== undefined) body.tool_choice = input.toolChoice
    return body
  }

  private async postJson(url: string, init: RequestInit) {
    const response = await this.safeFetch(url, init)
    const text = await response.text()
    if (!response.ok) throw new OpenAIChatRequestError(response.status, responseErrorMessage(response, text))
    if (!text) throw new OpenAIChatRequestError(response.status, "Chat model response body is empty.")
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new OpenAIChatRequestError(response.status, "Chat model response is not valid JSON.")
    }
  }

  private async safeFetch(url: string, init: RequestInit) {
    try {
      return await fetch(url, init)
    } catch (error) {
      throw new OpenAIChatConnectionError(url, error)
    }
  }

  private headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.apiKey?.trim()) headers.Authorization = `Bearer ${this.apiKey.trim()}`
    return headers
  }
}

export function chatCompletionsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return "/chat/completions"
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

function normalizeChatCompletion(input: unknown): Omit<OpenAIChatCompletionResult, "streamed"> {
  const root = objectRecord(input)
  const choice = firstChoice(root)
  const message = objectRecord(choice.message)
  const normalized = assistantMessage(
    stringValue(message.content),
    stringValue(message.reasoning_content),
    normalizeToolCalls(message.tool_calls),
  )
  if (!hasModelOutput(normalized)) throw new OpenAIChatRequestError(0, "Chat model response has no assistant content.")
  return {
    id: stringValue(root.id) || undefined,
    model: stringValue(root.model) || undefined,
    usage: usageValue(root.usage),
    message: normalized,
  }
}

function assistantMessage(content: string, reasoning: string, toolCalls: OpenAIChatToolCall[]): OpenAIChatMessage {
  return {
    role: "assistant",
    content: content || undefined,
    reasoning_content: reasoning || undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}

function hasModelOutput(message: OpenAIChatMessage) {
  return Boolean(message.content || message.reasoning_content || message.tool_calls?.length)
}

function normalizeToolCalls(input: unknown): OpenAIChatToolCall[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((value, index) => {
    const call = objectRecord(value)
    const fn = objectRecord(call.function)
    const name = stringValue(fn.name)
    if (!name) return []
    return [{
      id: stringValue(call.id) || `call_${index}`,
      type: "function" as const,
      function: {
        name,
        arguments: stringValue(fn.arguments),
      },
    }]
  })
}

type ToolCallDelta = {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

function toolCallDeltas(input: unknown): ToolCallDelta[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((value, fallbackIndex) => {
    const root = objectRecord(value)
    const index = numberValue(root.index) ?? fallbackIndex
    const fn = objectRecord(root.function)
    return [{
      index,
      id: stringValue(root.id) || undefined,
      type: stringValue(root.type) || undefined,
      function: {
        name: stringValue(fn.name) || undefined,
        arguments: stringValue(fn.arguments) || undefined,
      },
    }]
  })
}

function mergeToolCallDelta(existing: OpenAIChatToolCall | undefined, update: ToolCallDelta): OpenAIChatToolCall {
  return {
    id: update.id || existing?.id || `call_${update.index}`,
    type: "function",
    function: {
      name: `${existing?.function.name ?? ""}${update.function?.name ?? ""}`,
      arguments: `${existing?.function.arguments ?? ""}${update.function?.arguments ?? ""}`,
    },
  }
}

function parseJsonChunk(data: string) {
  try {
    return JSON.parse(data) as unknown
  } catch {
    throw new OpenAIChatRequestError(0, "Chat model stream sent invalid JSON.")
  }
}

function firstChoice(root: Record<string, unknown>) {
  const choices = Array.isArray(root.choices) ? root.choices : []
  return objectRecord(choices[0])
}

function usageValue(input: unknown): OpenAIChatUsage | undefined {
  const usage = objectRecord(input)
  return Object.keys(usage).length > 0 ? usage as OpenAIChatUsage : undefined
}

function findEventBoundary(input: string) {
  const lf = input.indexOf("\n\n")
  const crlf = input.indexOf("\r\n\r\n")
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function parseSseData(raw: string) {
  const lines = raw.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim()
  return data || undefined
}

function isStreamingFallbackError(error: unknown) {
  if (!(error instanceof OpenAIChatRequestError)) return false
  if ([400, 404, 405, 406, 415, 422, 501].includes(error.status)) return true
  return /\bstream(?:ing)?\b.*\b(?:unsupported|not supported|invalid|disabled)\b/i.test(error.message)
}

function responseErrorMessage(response: Response, text: string) {
  const detail = text.trim()
  const summary = `${response.status} ${response.statusText}`.trim()
  if (!detail) return summary
  return `${summary}: ${truncate(detail, 600)}`
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}
