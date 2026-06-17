import { getContinueAutocompleteStopTokens } from "./fimTemplates"
import type { QwenFimCompleteInput } from "./types"

export class QwenFimRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "QwenFimRequestError"
  }
}

type Fetcher = typeof fetch

export class QwenFimClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async complete(input: QwenFimCompleteInput): Promise<string> {
    if (!input.endpoint) throw new QwenFimRequestError(0, "Qwen endpoint is required.")
    const res = await this.fetcher(input.endpoint, {
      method: "POST",
      signal: input.signal,
      headers: this.headers(input.apiKey),
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        stream: false,
        stop: getContinueAutocompleteStopTokens(input.model),
      }),
    })
    try {
      input.onResponse?.({ status: res.status })
    } catch (err) {
      void err
    }
    const text = await res.text()
    if (!res.ok) throw new QwenFimRequestError(res.status, responseSummary(res))
    if (!text.trim()) throw new QwenFimRequestError(res.status, "Qwen /v1/completions response body is empty.")
    const data = parseJson(text, res.status)
    const root = record(data)
    const choices = Array.isArray(root.choices) ? root.choices : []
    const choice = record(choices[0])
    const out = typeof choice.text === "string" ? choice.text : ""
    if (!out) {
      throw new QwenFimRequestError(
        res.status,
        "Qwen /v1/completions response is missing choices[0].text; chat/completions fallback is disabled.",
      )
    }
    return out
  }

  private headers(key: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    const value = key.trim()
    if (value) headers.Authorization = `Bearer ${value}`
    return headers
  }
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new QwenFimRequestError(status, "Qwen /v1/completions response is not valid JSON.")
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function responseSummary(res: Response): string {
  const summary = `${res.status} ${res.statusText}`.trim()
  return summary || `HTTP ${res.status}`
}
