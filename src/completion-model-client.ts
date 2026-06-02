import type { OpenCodeMessage, OpenCodePart, RemoteSettings } from "./types"

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

  async complete(input: { prompt: string; signal?: AbortSignal }): Promise<OpenCodeMessage> {
    const baseUrl = this.settings.completion.apiBaseUrl
    const model = completionModel(this.settings)
    if (!baseUrl) throw new CompletionModelRequestError(0, "Completion API base URL is required.")
    if (!model) throw new CompletionModelRequestError(0, "Completion model is required.")

    const response = await this.safeFetch(baseUrl, {
      method: "POST",
      signal: input.signal,
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: completionMessages(input.prompt),
        max_tokens: this.settings.completion.maxTokens,
        temperature: this.settings.completion.temperature,
        top_p: this.settings.completion.topP,
      }),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new CompletionModelRequestError(response.status, responseErrorMessage(response, text))
    }
    if (!text) throw new CompletionModelRequestError(response.status, "Completion model response body is empty.")

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new CompletionModelRequestError(response.status, "Completion model response is not valid JSON.")
    }

    return normalizeChatCompletionMessage(body)
  }

  private async safeFetch(baseUrl: string, init: RequestInit) {
    try {
      return await fetch(chatCompletionsUrl(baseUrl), init)
    } catch (error) {
      throw new CompletionModelConnectionError(baseUrl, error)
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
  return settings.completion.model.trim() || settings.defaultModel.trim()
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

function normalizeChatCompletionMessage(input: unknown): OpenCodeMessage {
  const root = objectRecord(input)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = objectRecord(choices[0])
  const message = objectRecord(choice.message)
  const content = stringValue(message.content)
  const reasoning = stringValue(message.reasoning_content)
  if (!content && !reasoning) {
    throw new CompletionModelRequestError(0, "Completion model response has no message content.")
  }

  const parts: OpenCodePart[] = []
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
