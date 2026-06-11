import type { CompletionProfile, ChipMateMessage, ChipMatePart, RemoteSettings } from "./types"

export type CompletionTransport = "raw-completions" | "chat-completions"

const QWEN_CODER_FIM_STOP = [
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|file_sep|>",
  "<|repo_name|>",
  "<|endoftext|>",
  "<|im_end|>",
]

export class CompletionModelRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "CompletionModelRequestError"
  }
}

export class CompletionModelConnectionError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    super(`Cannot connect to completion model API ${baseUrl}: ${formatError(cause)}`)
    this.name = "CompletionModelConnectionError"
  }
}

export class CompletionModelClient {
  constructor(
    private readonly settings: RemoteSettings,
    private readonly apiKey?: string,
  ) {}

  async complete(input: {
    prompt: string
    signal?: AbortSignal
    maxTokens?: number
    temperature?: number
    topP?: number
    profile?: CompletionProfile
    transport?: CompletionTransport
    seed?: number
  }): Promise<ChipMateMessage> {
    const baseUrl = completionApiBaseUrl(this.settings)
    const model = completionModel(this.settings)
    if (!baseUrl) throw new CompletionModelRequestError(0, "Completion API base URL is required.")
    if (!model) throw new CompletionModelRequestError(0, "Completion model is required.")

    const profile = input.profile ?? this.settings.completion.profile
    const transport = input.transport ?? (profile === "qwen-coder-fim" ? "raw-completions" : "chat-completions")
    if (transport === "raw-completions") {
      return this.completeRawFim({
        prompt: input.prompt,
        signal: input.signal,
        baseUrl,
        model,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        topP: input.topP,
        seed: input.seed,
      })
    }

    const body: Record<string, unknown> = {
      model,
      messages: completionMessages(input.prompt),
      max_tokens: input.maxTokens ?? this.settings.completion.maxTokens,
      temperature: input.temperature ?? this.settings.completion.temperature,
      top_p: input.topP ?? this.settings.completion.topP,
    }
    if (Number.isFinite(input.seed)) body.seed = input.seed

    const response = await this.postJson(chatCompletionsUrl(baseUrl), {
      method: "POST",
      signal: input.signal,
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    return normalizeChatCompletionMessage(response)
  }

  private async completeRawFim(input: {
    prompt: string
    signal?: AbortSignal
    baseUrl: string
    model: string
    maxTokens?: number
    temperature?: number
    topP?: number
    seed?: number
  }) {
    const requestBody: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      max_tokens: input.maxTokens ?? this.settings.completion.maxTokens,
      temperature: input.temperature ?? this.settings.completion.temperature,
      top_p: input.topP ?? this.settings.completion.topP,
      stop: QWEN_CODER_FIM_STOP,
    }
    if (Number.isFinite(input.seed)) requestBody.seed = input.seed

    const body = await this.postJson(completionsUrl(input.baseUrl), {
      method: "POST",
      signal: input.signal,
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    })
    return normalizeRawCompletionMessage(body)
  }

  private async postJson(url: string, init: RequestInit) {
    const response = await this.safeFetch(url, init)
    const text = await response.text()
    if (!response.ok) {
      throw new CompletionModelRequestError(response.status, responseErrorMessage(response, text))
    }
    if (!text) throw new CompletionModelRequestError(response.status, "Completion model response body is empty.")

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new CompletionModelRequestError(response.status, "Completion model response is not valid JSON.")
    }
  }

  private async safeFetch(url: string, init: RequestInit) {
    try {
      return await fetch(url, init)
    } catch (error) {
      throw new CompletionModelConnectionError(url, error)
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

export function completionModel(settings: RemoteSettings) {
  return settings.completion.model.trim() || settings.provider?.chatModel?.trim() || settings.defaultModel.trim()
}

function completionApiBaseUrl(settings: RemoteSettings) {
  return settings.provider?.apiBaseUrl?.trim() || settings.completion.apiBaseUrl.trim()
}

export function completionMessages(prompt: string) {
  return [
    {
      role: "system",
      content: [
        "You are an inline code completion engine.",
        "You may think internally, but final visible output must be only the exact code text to insert at the cursor.",
        "Do not use Markdown, explanations, labels, or code fences in the final visible output.",
      ].join("\n"),
    },
    {
      role: "user",
      content: prompt,
    },
  ]
}

export function chatCompletionsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return "/chat/completions"
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

export function completionsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return "/completions"
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/completions")
  if (/\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/completions`
}

export function directCompletionRequestDiagnostic(error: unknown, profile: CompletionProfile) {
  if (!(error instanceof CompletionModelRequestError)) return ""
  if (profile !== "qwen-coder-fim") return ""
  if (error.status !== 404 && error.status !== 405) return ""
  return "Direct completion profile qwen-coder-fim requires an OpenAI-compatible raw /completions endpoint with Qwen FIM token support; this server appears to reject /completions. Use a FIM-compatible endpoint/profile for ordinary code, or use generic-chat only for instruction/comment-to-code completions."
}

function normalizeChatCompletionMessage(input: unknown): ChipMateMessage {
  const root = objectRecord(input)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = objectRecord(choices[0])
  const message = objectRecord(choice.message)
  const content = stringValue(message.content)
  const reasoning = stringValue(message.reasoning_content)
  if (!content && !reasoning) {
    throw new CompletionModelRequestError(0, "Completion model response has no message content.")
  }

  const parts: ChipMatePart[] = []
  if (reasoning) parts.push({ type: "reasoning", text: reasoning })
  if (content) parts.push({ type: "text", text: content })
  return {
    info: {
      id: stringValue(root.id) || "direct-completion",
      role: "assistant",
      providerID: "openai-compatible",
      modelID: stringValue(root.model),
    },
    parts,
  }
}

function normalizeRawCompletionMessage(input: unknown): ChipMateMessage {
  const root = objectRecord(input)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = objectRecord(choices[0])
  const message = objectRecord(choice.message)
  const content = stringValue(choice.text) || stringValue(message.content)
  const reasoning = stringValue(message.reasoning_content)
  if (!content && !reasoning) {
    throw new CompletionModelRequestError(0, "Completion model response has no completion text.")
  }

  const parts: ChipMatePart[] = []
  if (reasoning) parts.push({ type: "reasoning", text: reasoning })
  if (content) parts.push({ type: "text", text: content })
  return {
    info: {
      id: stringValue(root.id) || "direct-completion",
      role: "assistant",
      providerID: "openai-compatible",
      modelID: stringValue(root.model),
    },
    parts,
  }
}

function responseErrorMessage(response: Response, text: string) {
  const detail = text.trim()
  const summary = `${response.status} ${response.statusText}`.trim()
  if (!detail) return summary
  return `${summary}: ${truncate(detail, 600)}`
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}
