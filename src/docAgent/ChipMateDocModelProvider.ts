import { chatCompletionsUrl } from "../completion-model-client"
import type { RemoteSettings } from "../types"
import type { DocAgentModelProvider, DocAgentModelRequest, DocAgentModelWaitEvent } from "./types"

export const DOCUMENT_MODEL_REQUEST_TIMEOUT_MS = 45_000
export const DOCUMENT_MODEL_RECOVERABLE_TIMEOUT_MS = 120_000
export const DOCUMENT_MODEL_SOFT_WAIT_MS = 60_000
export const DOCUMENT_MODEL_LONG_WAIT_WARNING_MS = 180_000
export const DOCUMENT_MODEL_COMPAT_MAX_TOKENS = 131_072

type FetchLike = typeof fetch

export class ChipMateDocModelProvider implements DocAgentModelProvider {
  constructor(private readonly deps: {
    getSettings: () => RemoteSettings
    getApiKey: () => Promise<string | undefined>
    timeoutMs?: number
    softWaitMs?: number
    longWaitWarningMs?: number
    fetch?: FetchLike
    log?: (message: string) => void
    onStillWaiting?: (event: DocAgentModelWaitEvent) => void
  }) {}

  cacheKey() {
    const settings = this.deps.getSettings()
    return settings.provider.chatModel || "doc-model"
  }

  async completeJson<T>(request: DocAgentModelRequest, signal?: AbortSignal): Promise<T> {
    const settings = this.deps.getSettings()
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      throw new Error("ChipMate provider is not configured for document generation.")
    }
    if (signal?.aborted) throw abortError(request, settings.provider.chatModel)
    const apiKey = await this.deps.getApiKey()
    if (signal?.aborted) throw abortError(request, settings.provider.chatModel)
    const timeoutMs = hardTimeoutMsFor(request, this.deps.timeoutMs)
    const softWaitMs = Math.max(1, Math.floor(this.deps.softWaitMs ?? DOCUMENT_MODEL_SOFT_WAIT_MS))
    const longWaitWarningMs = Math.max(softWaitMs, Math.floor(this.deps.longWaitWarningMs ?? DOCUMENT_MODEL_LONG_WAIT_WARNING_MS))
    const controller = new AbortController()
    let stage = "fetch"
    let timeout: ReturnType<typeof setTimeout> | undefined
    let softWait: ReturnType<typeof setInterval> | undefined
    let rejectAbort: ((error: Error) => void) | undefined
    const timeoutPromise = timeoutMs === undefined ? never<never>() : new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(timeoutError(request, settings.provider.chatModel, timeoutMs, stage))
      }, timeoutMs)
    })
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const onAbort = () => {
      controller.abort()
      rejectAbort?.(abortError(request, settings.provider.chatModel))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const startedAt = Date.now()
    softWait = setInterval(() => {
      const elapsedMs = Date.now() - startedAt
      const warning = elapsedMs >= longWaitWarningMs
        ? `模型处理时间较长，仍在等待自然完成；如需中止请点击停止。`
        : undefined
      const event = { purpose: request.purpose, model: settings.provider.chatModel, stage, elapsedMs, warning }
      this.deps.log?.(`[doc-agent] still waiting: purpose=${request.purpose}; model=${settings.provider.chatModel}; stage=${stage}; elapsedMs=${elapsedMs}`)
      if (warning) this.deps.log?.(`[doc-agent] warning: ${warning} purpose=${request.purpose}; model=${settings.provider.chatModel}; stage=${stage}; elapsedMs=${elapsedMs}`)
      this.deps.onStillWaiting?.(event)
    }, softWaitMs)
    const fetchImpl = this.deps.fetch ?? fetch
    let useJsonMode = shouldRequestJsonMode(request)
    let compatMaxTokens: number | undefined
    let retriedCompatMaxTokens = false
    try {
      for (;;) {
        try {
          return await requestOnce<T>({
            request,
            settings,
            apiKey,
            fetchImpl,
            timeoutPromise,
            abortPromise,
            signal: controller.signal,
            setStage: (value) => { stage = value },
            useJsonMode,
            maxTokens: compatMaxTokens,
            log: this.deps.log,
          })
        } catch (error) {
          if (signal?.aborted) throw abortError(request, settings.provider.chatModel)
          if (useJsonMode && isJsonModeUnsupportedError(error)) {
            this.deps.log?.(`[doc-agent] document model response_format unsupported; retrying without JSON mode (purpose=${request.purpose}, model=${settings.provider.chatModel}).`)
            useJsonMode = false
            continue
          }
          if (!retriedCompatMaxTokens && isMaxTokensRequiredError(error)) {
            retriedCompatMaxTokens = true
            compatMaxTokens = DOCUMENT_MODEL_COMPAT_MAX_TOKENS
            this.deps.log?.(`[doc-agent] provider requires max_tokens; retrying with compatibility max_tokens=${DOCUMENT_MODEL_COMPAT_MAX_TOKENS} (purpose=${request.purpose}, model=${settings.provider.chatModel}).`)
            continue
          }
          throw error
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (softWait) clearInterval(softWait)
      signal?.removeEventListener("abort", onAbort)
    }
  }
}

type RequestOnceInput = {
  request: DocAgentModelRequest
  settings: RemoteSettings
  apiKey?: string
  fetchImpl: FetchLike
  timeoutPromise: Promise<never>
  abortPromise: Promise<never>
  signal: AbortSignal
  setStage: (stage: string) => void
  useJsonMode: boolean
  maxTokens?: number
  log?: (message: string) => void
}

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string }
  }>
}

async function requestOnce<T>(input: RequestOnceInput): Promise<T> {
  const { request, settings, apiKey, fetchImpl, timeoutPromise, abortPromise, signal, setStage, useJsonMode, maxTokens, log } = input
  const startedAt = Date.now()
  setStage(useJsonMode ? "fetch-json-mode" : "fetch")
  const payload = requestPayload(request, settings, useJsonMode, maxTokens)
  const response = await Promise.race([
    fetchImpl(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(payload),
    }),
    timeoutPromise,
    abortPromise,
  ])
  if (!response.ok) {
    setStage("read-error-body")
    const text = await Promise.race([response.text().catch(() => ""), timeoutPromise, abortPromise])
    if (useJsonMode && isResponseFormatUnsupported(response.status, text)) {
      throw jsonModeUnsupportedError(response.status, text)
    }
    if (isMaxTokensRequired(response.status, text)) {
      throw maxTokensRequiredError(response.status, text)
    }
    throw new Error(`Document model request failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`)
  }

  setStage("read-body")
  const bodyText = await Promise.race([response.text(), timeoutPromise, abortPromise])
  setStage("parse-response")
  let body: ChatCompletionResponse
  try {
    body = JSON.parse(bodyText) as ChatCompletionResponse
  } catch (error) {
    log?.(`[doc-agent] document model HTTP JSON parse failed: purpose=${request.purpose}; model=${settings.provider.chatModel}; bodyBytes=${Buffer.byteLength(bodyText, "utf8")}; raw=${summarizeForLog(bodyText)}; error=${error instanceof Error ? error.message : String(error)}`)
    throw new Error(`Document model response was not valid API JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const choice = body.choices?.[0]
  const text = choice?.message?.content ?? ""
  const finishReason = String(choice?.finish_reason ?? "unknown")
  const responseBytes = Buffer.byteLength(text, "utf8")
  log?.(`[doc-agent] document model response: purpose=${request.purpose}; model=${settings.provider.chatModel}; finish_reason=${finishReason}; responseBytes=${responseBytes}; elapsedMs=${Date.now() - startedAt}; jsonMode=${useJsonMode}`)
  setStage("parse-json")
  try {
    return parseJsonObject<T>(text)
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error)
    log?.(`[doc-agent] document model JSON parse failed: purpose=${request.purpose}; model=${settings.provider.chatModel}; finish_reason=${finishReason}; responseBytes=${responseBytes}; raw=${summarizeForLog(text)}; error=${parseMessage}`)
    throw new Error(`Model did not return valid JSON. purpose=${request.purpose}; finish_reason=${finishReason}; responseBytes=${responseBytes}; ${parseMessage}`)
  }
}

function requestPayload(request: DocAgentModelRequest, settings: RemoteSettings, useJsonMode: boolean, maxTokens?: number) {
  return {
    model: settings.provider.chatModel,
    stream: false,
    temperature: Math.min(settings.provider.temperature, 0.2),
    top_p: settings.provider.topP,
    ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
    ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: systemMessageFor(request) },
      { role: "user", content: request.prompt },
    ],
  }
}

function systemMessageFor(request: DocAgentModelRequest) {
  const strict = [
    "Return exactly one syntactically valid JSON object.",
    "Do not wrap the JSON in Markdown fences.",
    "Do not include explanations, comments, or trailing text outside the JSON object.",
    "Escape all string values correctly.",
  ].join(" ")
  const extraction = request.purpose === "extract-rules" || request.purpose === "extract-rules-batch"
    ? "For rule extraction, keep each field concise and do not copy long source text."
    : ""
  return `${request.system}\n${strict}${extraction ? `\n${extraction}` : ""}`
}

function shouldRequestJsonMode(request: DocAgentModelRequest) {
  return request.purpose === "extract-rules"
    || request.purpose === "extract-rules-batch"
    || request.purpose === "plan-source-roles"
    || request.purpose === "plan-source-block-placement"
    || request.purpose === "plan-rule-examples"
    || request.purpose === "compose-guideline-draft"
    || request.purpose === "review-guideline-draft"
}

function hardTimeoutMsFor(request: DocAgentModelRequest, injectedTimeoutMs: number | undefined) {
  if (Number.isFinite(injectedTimeoutMs) && injectedTimeoutMs! > 0) return Math.max(1, Math.floor(injectedTimeoutMs!))
  if (isLongRunningPurpose(request.purpose)) return undefined
  return DOCUMENT_MODEL_RECOVERABLE_TIMEOUT_MS
}

function isLongRunningPurpose(purpose: DocAgentModelRequest["purpose"]) {
  return purpose === "plan-document"
    || purpose === "merge-guidelines"
    || purpose === "normalize-rule-language"
    || purpose === "plan-source-block-placement"
    || purpose === "compose-guideline-draft"
    || purpose === "review-guideline-draft"
    || purpose === "generate-word-spec"
}

function never<T>() {
  return new Promise<T>(() => {})
}

function isResponseFormatUnsupported(status: number, text: string) {
  return (status === 400 || status === 422) && /response_format|json_object|json mode|unsupported|not support/i.test(text)
}

function isMaxTokensRequired(status: number, text: string) {
  return (status === 400 || status === 422) && /max[_\s-]?tokens?/i.test(text) && /required|missing|must|required field|field required/i.test(text)
}

function jsonModeUnsupportedError(status: number, text: string) {
  const error = new Error(`response_format unsupported: ${status}${text ? ` ${text.slice(0, 300)}` : ""}`)
  error.name = "JsonModeUnsupportedError"
  return error
}

function isJsonModeUnsupportedError(error: unknown) {
  return error instanceof Error && error.name === "JsonModeUnsupportedError"
}

function maxTokensRequiredError(status: number, text: string) {
  const error = new Error(`max_tokens required: ${status}${text ? ` ${text.slice(0, 300)}` : ""}`)
  error.name = "MaxTokensRequiredError"
  return error
}

function isMaxTokensRequiredError(error: unknown) {
  return error instanceof Error && error.name === "MaxTokensRequiredError"
}

function timeoutError(request: DocAgentModelRequest, model: string, timeoutMs: number, stage: string) {
  return new Error(`Document model request timed out after ${timeoutMs}ms (purpose=${request.purpose}, model=${model}, stage=${stage}).`)
}

function abortError(request: DocAgentModelRequest, model: string) {
  const error = new Error(`Document model request aborted (purpose=${request.purpose}, model=${model}).`)
  error.name = "AbortError"
  return error
}

function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim()
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  try {
    return JSON.parse(withoutFence) as T
  } catch (firstError) {
    const start = withoutFence.indexOf("{")
    const end = withoutFence.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1)) as T
      } catch (secondError) {
        throw new Error(`JSON.parse failed after object extraction: ${secondError instanceof Error ? secondError.message : String(secondError)}`)
      }
    }
    throw new Error(`JSON.parse failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`)
  }
}

function summarizeForLog(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= 500) return compact
  return `${compact.slice(0, 240)} ... ${compact.slice(-240)}`
}
