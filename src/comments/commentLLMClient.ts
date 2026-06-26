import { chatCompletionsUrl } from "../completion-model-client"
import type { RemoteSettings } from "../types"
import { shortHash, textByteLength, type CommentGenerationTerminalReason } from "./commentDiagnostics"

const COMMENT_LLM_TIMEOUT_MS = 45_000
const COMMENT_STREAM_DELTA_MIN_INTERVAL_MS = 120
const COMMENT_STREAM_PREVIEW_MAX_BYTES = 4096
const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"
const COMMENT_FINAL_ONLY_SYSTEM_PROMPT = [
  "You are the final JSON emitter for ChipMate AI Comment Review.",
  "Your first visible output character must be {.",
  "Return exactly one JSON object matching the requested schema.",
  "Do not output thinking, analysis, self-checks, verification steps, explanations, markdown, code fences, or lists.",
  "Do not describe whether the output is valid.",
  "If there are no useful comments, return exactly {\"proposals\":[]}.",
].join("\n")
const COMMENT_NO_THINK_PREFIX = "/no_think\n"

export type CommentLLMClientInput = {
  getSettings: () => RemoteSettings
  getApiKey: () => Promise<string | undefined>
}

export type CommentLLMResponse = {
  text: string
  elapsedMs: number
  tokenUsage?: CommentLLMTokenUsage
}

export type CommentLLMTokenUsage = {
  usageAvailable: boolean
  usagePromptTokens?: number
  usageCompletionTokens?: number
  usageTotalTokens?: number
  usageReasoningTokens?: number
  usageTextTokens?: number
}

export type CommentLLMDiagnosticEvent = {
  stage: string
  fields?: Record<string, unknown>
}

export type CommentLLMDiagnosticLogger = (event: CommentLLMDiagnosticEvent) => void

export class CommentLLMGenerationError extends Error {
  constructor(
    message: string,
    readonly terminalReason: CommentGenerationTerminalReason,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "CommentLLMGenerationError"
  }
}

export class CommentLLMClient {
  constructor(private readonly deps: CommentLLMClientInput) {}

  async generate(
    prompt: string,
    signal?: AbortSignal,
    timeoutMs = COMMENT_LLM_TIMEOUT_MS,
    diagnostics?: CommentLLMDiagnosticLogger,
  ): Promise<CommentLLMResponse> {
    const settings = this.deps.getSettings()
    if (!settings.provider.apiBaseUrl) throw new Error("尚未配置 ChipMate provider API base URL。")
    if (!settings.provider.chatModel) throw new Error("尚未配置 ChipMate provider chat model。")
    const url = chatCompletionsUrl(settings.provider.apiBaseUrl)
    const temperature = Math.min(settings.provider.temperature, 0.2)
    const messages = [
      { role: "system", content: COMMENT_FINAL_ONLY_SYSTEM_PROMPT },
      { role: "user", content: `${COMMENT_NO_THINK_PREFIX}${prompt}` },
    ]
    const commonRequestBody = {
      model: settings.provider.chatModel,
      messages,
      stream: true,
      temperature,
      top_p: settings.provider.topP,
    }
    const runAttempt = async (responseFormat: "json_object" | "fallback-disabled", responseFormatFallback: boolean) => {
      const requestBody = JSON.stringify({
        ...commonRequestBody,
        ...(responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
      })
      const safeRequestFields = requestDiagnostics({
        url,
        model: settings.provider.chatModel,
        providerMaxTokensConfigured: settings.provider.maxTokens,
        temperature,
        topP: settings.provider.topP,
        prompt,
        requestBody,
        timeoutMs,
        responseFormat,
        responseFormatFallback,
      })
      diagnostics?.({
        stage: "model.http.prepare",
        fields: safeRequestFields,
      })

      const requestStarted = Date.now()
      const result = await this.fetchStreamingWithTimeout({
        url,
        headers: await this.headers(),
        requestBody,
        signal,
        timeoutMs,
        diagnostics,
        requestStarted,
        safeRequestFields,
      })
      return { ...result, requestStarted, safeRequestFields }
    }

    let attempt = await runAttempt("json_object", false)
    if (!attempt.response.ok && isResponseFormatFallbackStatus(attempt.response.status)) {
      diagnostics?.({
        stage: "model.http.response_format.fallback",
        fields: {
          ...attempt.safeRequestFields,
          elapsedMs: Date.now() - attempt.requestStarted,
          responseStatus: attempt.response.status,
          responseBytes: textByteLength(attempt.text),
          responseFormatFallback: true,
        },
      })
      attempt = await runAttempt("fallback-disabled", true)
    }
    if (!attempt.response.ok) {
      throw new Error(`注释生成失败: ${attempt.response.status} ${attempt.response.statusText}${attempt.text ? `: ${trimErrorBody(attempt.text)}` : ""}`)
    }
    const { text, requestStarted, tokenUsage } = attempt
    if (!text.trim()) throw new Error("注释生成返回了空响应体。")
    return {
      text,
      elapsedMs: Date.now() - requestStarted,
      tokenUsage,
    }
  }

  private async headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    const apiKey = await this.deps.getApiKey()
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    return headers
  }

  private async fetchStreamingWithTimeout(input: {
    url: string
    headers: Record<string, string>
    requestBody: string
    signal?: AbortSignal
    timeoutMs: number
    diagnostics?: CommentLLMDiagnosticLogger
    requestStarted: number
    safeRequestFields: Record<string, unknown>
  }) {
    const controller = new AbortController()
    let timedOut = false
    let lastStage = "model.http.prepare"
    let responseHeadersReceived = false
    let firstChunkReceived = false
    let responseStatus: number | undefined
    let responseContentType = "unknown"
    let timer: ReturnType<typeof setTimeout> | undefined
    const armTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        input.diagnostics?.({
          stage: "model.http.timeout",
          fields: {
            ...input.safeRequestFields,
            elapsedMs: Date.now() - input.requestStarted,
            lastStage,
            responseHeadersReceived,
            firstChunkReceived,
          },
        })
        controller.abort()
      }, input.timeoutMs)
    }
    armTimeout()
    const onAbort = () => controller.abort()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      lastStage = "model.http.fetch.start"
      input.diagnostics?.({
        stage: lastStage,
        fields: input.safeRequestFields,
      })
      const response = await fetch(input.url, {
        method: "POST",
        signal: controller.signal,
        headers: input.headers,
        body: input.requestBody,
      })
      responseHeadersReceived = true
      responseStatus = response.status
      armTimeout()
      lastStage = "model.http.response.headers"
      responseContentType = response.headers.get("content-type") ?? "unknown"
      input.diagnostics?.({
        stage: lastStage,
        fields: {
          ...input.safeRequestFields,
          elapsedMs: Date.now() - input.requestStarted,
          responseStatus: response.status,
          responseContentType,
          responseContentLength: response.headers.get("content-length") ?? "unknown",
        },
      })
      if (!response.ok) {
        lastStage = "model.http.response.body"
        const text = await response.text()
        input.diagnostics?.({
          stage: lastStage,
          fields: {
            ...input.safeRequestFields,
            elapsedMs: Date.now() - input.requestStarted,
            responseStatus: response.status,
            responseContentType,
            responseBytes: textByteLength(text),
          },
        })
        return { response, text, tokenUsage: emptyTokenUsage() }
      }
      if (!response.body) throw new Error("注释生成 streaming 响应体为空。")

      let rawContentText = ""
      let buffer = ""
      let rawBytes = 0
      let firstChunkMs: number | undefined
      let deltaCount = 0
      let reasoningDeltaCount = 0
      let reasoningBytes = 0
      let structuredReasoningText = ""
      let sseDataCount = 0
      let doneMarker = false
      let finishReason = ""
      let jsonPrefixGuard = jsonPrefixGuardPending()
      let tokenUsage = emptyTokenUsage()
      let lastStreamDeltaMs = 0
      let lastStreamPhase = "waiting"
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const emitStreamDelta = (phase?: CommentStreamPhase, force = false) => {
        const snapshot = buildStreamPreviewSnapshot({
          rawContentText,
          structuredReasoningText,
          rawBytes,
          deltaCount,
          reasoningBytes,
          reasoningDeltaCount,
          jsonPrefixGuard,
          tokenUsage,
          finishReason,
          elapsedMs: Date.now() - input.requestStarted,
          phase,
        })
        const now = Date.now()
        const phaseChanged = snapshot.streamPhase !== lastStreamPhase
        if (!force && !phaseChanged && now - lastStreamDeltaMs < COMMENT_STREAM_DELTA_MIN_INTERVAL_MS) return
        lastStreamDeltaMs = now
        lastStreamPhase = snapshot.streamPhase
        input.diagnostics?.({
          stage: "model.stream.delta",
          fields: snapshot,
        })
      }
      const processSseBlock = (raw: string) => {
        const dataItems = parseSseData(raw)
        for (const data of dataItems) {
          sseDataCount += 1
          if (data === "[DONE]") {
            doneMarker = true
            continue
          }
          const delta = parseStreamDelta(data)
          deltaCount += 1
          if (delta.error) throw new Error(`注释生成流返回错误: ${delta.error}`)
          if (delta.usage?.usageAvailable) tokenUsage = delta.usage
          if (delta.reasoning) {
            reasoningDeltaCount += 1
            reasoningBytes += textByteLength(delta.reasoning)
            structuredReasoningText += delta.reasoning
          }
          if (delta.content) {
            rawContentText += delta.content
            if (jsonPrefixGuard.status === "pending") {
              jsonPrefixGuard = evaluateJsonPrefixGuard(rawContentText)
              if (jsonPrefixGuard.status === "failed") {
                throw new CommentLLMGenerationError("模型输出不是 JSON 起始内容。", "model-non-json-prefix", {
                  ...input.safeRequestFields,
                  elapsedMs: Date.now() - input.requestStarted,
                  jsonPrefixGuard: "failed",
                  nonJsonPrefixBytes: jsonPrefixGuard.nonJsonPrefixBytes,
                  rawContentBytes: textByteLength(rawContentText),
                  deltaCount,
                  sseDataCount,
                  finishReason: finishReason || "none",
                })
              }
            }
          }
          if (delta.finishReason) finishReason = delta.finishReason
          if (delta.reasoning || delta.content || delta.usage?.usageAvailable || delta.finishReason) {
            emitStreamDelta(undefined, deltaCount <= 2 || Boolean(delta.usage?.usageAvailable) || Boolean(delta.finishReason))
          }
        }
      }

      while (true) {
        input.signal?.throwIfAborted()
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (error) {
          if (responseHeadersReceived && isPrematureStreamCloseError(error) && !input.signal?.aborted) {
            if (!firstChunkReceived) {
              firstChunkReceived = true
              firstChunkMs = Date.now() - input.requestStarted
            }
            break
          }
          throw error
        }
        if (chunk.done) break
        if (!firstChunkReceived) {
          firstChunkReceived = true
          firstChunkMs = Date.now() - input.requestStarted
          lastStage = "model.http.stream.firstChunk"
          input.diagnostics?.({
            stage: lastStage,
            fields: {
              ...input.safeRequestFields,
              elapsedMs: firstChunkMs,
              responseStatus: response.status,
              responseContentType,
            },
          })
        }
        armTimeout()
        lastStage = "model.http.stream.read"
        const decoded = decoder.decode(chunk.value, { stream: true })
        rawBytes += chunk.value.byteLength
        buffer += decoded
        let boundary = findSseBoundary(buffer)
        while (boundary) {
          const raw = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          processSseBlock(raw)
          boundary = findSseBoundary(buffer)
        }
      }
      const tail = decoder.decode()
      if (tail) {
        rawBytes += textByteLength(tail)
        buffer += tail
      }
      if (buffer.trim()) processSseBlock(buffer)
      const normalized = normalizeThinkingContent(rawContentText)
      const jsonFence = normalizeJsonFence(normalized.text)
      const normalizedText = jsonFence.text
      const normalizedTextBytes = textByteLength(normalizedText)
      const strippedThinkingBytes = textByteLength(normalized.thinking)
      emitStreamDelta("normalizing", true)
      const normalizeFields = {
        ...input.safeRequestFields,
        elapsedMs: Date.now() - input.requestStarted,
        reasoningDeltaCount,
        reasoningBytes: reasoningBytes + strippedThinkingBytes,
        structuredReasoningBytes: reasoningBytes,
        strippedThinkBlockCount: normalized.strippedThinkBlockCount,
        strippedThinkBytes: strippedThinkingBytes,
        openThinking: normalized.openThinking,
        rawContentBytes: textByteLength(rawContentText),
        ...tokenUsage,
        jsonPrefixGuard: jsonPrefixGuard.status,
        jsonPrefixGuardMode: jsonPrefixGuard.mode,
        nonJsonPrefixBytes: jsonPrefixGuard.nonJsonPrefixBytes,
        jsonFenceStripped: jsonFence.stripped,
        jsonFenceLanguage: jsonFence.language,
        normalizedTextBytes,
        finishReason: finishReason || "none",
      }
      input.diagnostics?.({
        stage: "model.response.normalize",
        fields: normalizeFields,
      })
      lastStage = "model.http.stream.done"
      input.diagnostics?.({
        stage: lastStage,
        fields: {
          ...input.safeRequestFields,
          elapsedMs: Date.now() - input.requestStarted,
          responseStatus: response.status,
          responseContentType,
          firstChunkMs,
          deltaCount,
          reasoningDeltaCount,
          sseDataCount,
          rawBytes,
          textBytes: normalizedTextBytes,
          rawContentBytes: textByteLength(rawContentText),
          ...tokenUsage,
          jsonPrefixGuard: jsonPrefixGuard.status,
          jsonPrefixGuardMode: jsonPrefixGuard.mode,
          nonJsonPrefixBytes: jsonPrefixGuard.nonJsonPrefixBytes,
          strippedThinkBlockCount: normalized.strippedThinkBlockCount,
          openThinking: normalized.openThinking,
          jsonFenceStripped: jsonFence.stripped,
          jsonFenceLanguage: jsonFence.language,
          doneMarker,
          finishReason: finishReason || "none",
        },
      })
      emitStreamDelta("done", true)
      if (!doneMarker && !finishReason) throw new Error("注释生成流结束前未收到完成标记。")
      if (normalized.openThinking) {
        const reason: CommentGenerationTerminalReason = finishReason === "length" ? "model-output-truncated" : "model-returned-only-thinking"
        throw new CommentLLMGenerationError("模型输出停留在 thinking 内容中，未返回完整 JSON。", reason, normalizeFields)
      }
      if (!normalizedText.trim()) {
        throw new CommentLLMGenerationError("模型只返回了 thinking 内容，没有返回 JSON。", "model-returned-only-thinking", normalizeFields)
      }
      return { response, text: normalizedText, tokenUsage }
    } catch (error) {
      if (error instanceof CommentLLMGenerationError) throw error
      if (timedOut && !input.signal?.aborted && isAbortError(error)) {
        throw new Error(`注释生成在 ${input.timeoutMs}ms 后超时。`)
      }
      if (responseHeadersReceived && !input.signal?.aborted && isPrematureStreamCloseError(error)) {
        firstChunkReceived = true
        lastStage = "model.http.stream.done"
        const normalizedError = new Error("注释生成流结束前未收到完成标记。")
        input.diagnostics?.({
          stage: lastStage,
          fields: {
            ...input.safeRequestFields,
            elapsedMs: Date.now() - input.requestStarted,
            responseStatus,
            responseContentType,
            firstChunkMs: undefined,
            deltaCount: 0,
            reasoningDeltaCount: 0,
            sseDataCount: 0,
            rawBytes: 0,
            textBytes: 0,
            rawContentBytes: 0,
            doneMarker: false,
            finishReason: "none",
          },
        })
        input.diagnostics?.({
          stage: "model.http.error",
          fields: {
            ...input.safeRequestFields,
            elapsedMs: Date.now() - input.requestStarted,
            lastStage,
            responseHeadersReceived,
            firstChunkReceived,
            ...errorDiagnostics(normalizedError),
          },
        })
        throw new Error(`注释生成请求失败: ${formatError(normalizedError)}`)
      }
      input.diagnostics?.({
        stage: "model.http.error",
        fields: {
          ...input.safeRequestFields,
          elapsedMs: Date.now() - input.requestStarted,
          lastStage,
          responseHeadersReceived,
          firstChunkReceived,
          ...errorDiagnostics(error),
        },
      })
      throw new Error(`注释生成请求失败: ${formatError(error)}`)
    } finally {
      if (timer) clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
  }
}

type CommentStreamPhase = "waiting" | "thinking" | "receiving-json" | "normalizing" | "done" | "failed"

function buildStreamPreviewSnapshot(input: {
  rawContentText: string
  structuredReasoningText: string
  rawBytes: number
  deltaCount: number
  reasoningBytes: number
  reasoningDeltaCount: number
  jsonPrefixGuard: JsonPrefixGuardState
  tokenUsage: CommentLLMTokenUsage
  finishReason: string
  elapsedMs: number
  phase?: CommentStreamPhase
}) {
  const normalized = normalizeThinkingContent(input.rawContentText)
  const visiblePreview = sanitizeStreamPreview(normalized.text, "visible")
  const reasoningText = [input.structuredReasoningText, normalized.thinking].filter((value) => value.trim()).join("\n")
  const reasoningPreview = sanitizeStreamPreview(reasoningText, "reasoning")
  const visibleBytes = textByteLength(normalized.text)
  const reasoningBytes = input.reasoningBytes + textByteLength(normalized.thinking)
  return {
    streamPhase: input.phase ?? inferStreamPhase(normalized, reasoningText),
    elapsedMs: input.elapsedMs,
    deltaCount: input.deltaCount,
    rawBytes: input.rawBytes,
    visibleBytes,
    reasoningBytes,
    reasoningDeltaCount: input.reasoningDeltaCount,
    reasoningPreview,
    visiblePreview,
    jsonPrefixGuard: input.jsonPrefixGuard.status,
    jsonPrefixGuardMode: input.jsonPrefixGuard.mode,
    finishReason: input.finishReason || "none",
    updatedAt: Date.now(),
    ...input.tokenUsage,
  }
}

function inferStreamPhase(normalized: ReturnType<typeof normalizeThinkingContent>, reasoningText: string): CommentStreamPhase {
  if (normalized.text.trim()) return "receiving-json"
  if (normalized.openThinking || reasoningText.trim()) return "thinking"
  return "waiting"
}

function sanitizeStreamPreview(input: string, mode: "visible" | "reasoning") {
  let value = redactJsonSourceFields(input)
  if (mode === "reasoning") {
    value = value
      .split(/\r?\n/)
      .map((line) => isLikelyCodeLine(line) ? "‹已隐藏可能的代码片段›" : line)
      .join("\n")
  }
  return tailByByteLength(value.trim(), COMMENT_STREAM_PREVIEW_MAX_BYTES)
}

function redactJsonSourceFields(input: string) {
  return input
    .replace(/("targetLineText"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)("?)/g, (_match, prefix: string, _value: string, suffix: string) => `${prefix}<redacted>${suffix || ""}`)
    .replace(/("(?:selectedCode|contextBefore|contextAfter)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)("?)/g, (_match, prefix: string, _value: string, suffix: string) => `${prefix}<redacted>${suffix || ""}`)
}

function isLikelyCodeLine(input: string) {
  const line = input.trim()
  if (!line) return false
  if (line.length > 180 && /[;{}=]|->|#/.test(line)) return true
  return /\b(if|for|while|switch)\s*\(|->|#define|;\s*$|{\s*$|}\s*$/.test(line)
}

function tailByByteLength(input: string, maxBytes: number) {
  if (textByteLength(input) <= maxBytes) return input
  let start = Math.max(0, input.length - maxBytes)
  let tail = input.slice(start)
  while (textByteLength(tail) > maxBytes && start < input.length) {
    start += Math.max(1, Math.ceil((textByteLength(tail) - maxBytes) / 3))
    tail = input.slice(start)
  }
  return `...${tail}`
}

function parseSseData(raw: string) {
  const values: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    values.push(line.slice(5).trimStart())
  }
  if (!values.length) return []
  return [values.join("\n").trim()]
}

function findSseBoundary(input: string) {
  const crlf = input.indexOf("\r\n\r\n")
  const lf = input.indexOf("\n\n")
  if (crlf === -1 && lf === -1) return undefined
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseStreamDelta(input: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error("注释生成流包含非法 JSON chunk。")
  }
  const root = objectRecord(parsed)
  const error = root.error
  if (typeof error === "string") return { error }
  if (error && typeof error === "object") {
    const message = stringValue((error as Record<string, unknown>).message)
    return { error: message || "unknown stream error" }
  }
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = objectRecord(choices[0])
  const delta = objectRecord(choice.delta)
  return {
    content: stringValue(delta.content),
    reasoning: stringValue(delta.reasoning_content) || stringValue(delta.reasoning),
    finishReason: stringValue(choice.finish_reason),
    usage: parseTokenUsage(root.usage),
    error: "",
  }
}

function parseTokenUsage(input: unknown): CommentLLMTokenUsage {
  const usage = objectRecord(input)
  if (!Object.keys(usage).length) return emptyTokenUsage()
  const completionDetails = objectRecord(usage.completion_tokens_details)
  return {
    usageAvailable: true,
    usagePromptTokens: numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens),
    usageCompletionTokens: numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens),
    usageTotalTokens: numberValue(usage.total_tokens),
    usageReasoningTokens: numberValue(completionDetails.reasoning_tokens),
    usageTextTokens: numberValue(completionDetails.text_tokens) ?? numberValue(usage.output_tokens),
  }
}

function emptyTokenUsage(): CommentLLMTokenUsage {
  return { usageAvailable: false }
}

type JsonPrefixGuardState = {
  status: "pending" | "accepted" | "failed"
  mode?: "json-object" | "thinking" | "json-fence"
  nonJsonPrefixBytes?: number
}

function jsonPrefixGuardPending(): JsonPrefixGuardState {
  return { status: "pending" }
}

function evaluateJsonPrefixGuard(input: string): JsonPrefixGuardState {
  const trimmed = input.trimStart()
  if (!trimmed) return jsonPrefixGuardPending()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith("{")) return { status: "accepted", mode: "json-object" }
  if (THINK_OPEN_TAG.startsWith(lower)) return jsonPrefixGuardPending()
  if (lower.startsWith(THINK_OPEN_TAG)) return { status: "accepted", mode: "thinking" }
  if ("```".startsWith(trimmed)) return jsonPrefixGuardPending()
  if (trimmed.startsWith("```")) return { status: "accepted", mode: "json-fence" }
  return {
    status: "failed",
    nonJsonPrefixBytes: textByteLength(trimmed),
  }
}

function normalizeThinkingContent(input: string) {
  const text: string[] = []
  const thinking: string[] = []
  const lower = input.toLowerCase()
  let offset = 0
  let openThinking = false
  let strippedThinkBlockCount = 0

  while (offset < input.length) {
    if (openThinking) {
      const closeIndex = lower.indexOf(THINK_CLOSE_TAG, offset)
      if (closeIndex === -1) {
        appendThinking(thinking, stripTrailingTagPrefix(input.slice(offset), THINK_CLOSE_TAG))
        return {
          text: text.join(""),
          thinking: thinking.join("\n"),
          openThinking: true,
          strippedThinkBlockCount,
        }
      }
      appendThinking(thinking, input.slice(offset, closeIndex))
      offset = closeIndex + THINK_CLOSE_TAG.length
      openThinking = false
      continue
    }

    const openIndex = lower.indexOf(THINK_OPEN_TAG, offset)
    if (openIndex === -1) {
      const remaining = input.slice(offset)
      const partialOpenLength = trailingTagPrefixLength(remaining, THINK_OPEN_TAG)
      if (partialOpenLength > 0) {
        text.push(remaining.slice(0, -partialOpenLength))
        return {
          text: text.join(""),
          thinking: thinking.join("\n"),
          openThinking: true,
          strippedThinkBlockCount,
        }
      }
      text.push(remaining)
      return {
        text: text.join(""),
        thinking: thinking.join("\n"),
        openThinking: false,
        strippedThinkBlockCount,
      }
    }

    text.push(input.slice(offset, openIndex))
    offset = openIndex + THINK_OPEN_TAG.length
    openThinking = true
    strippedThinkBlockCount += 1
  }

  return {
    text: text.join(""),
    thinking: thinking.join("\n"),
    openThinking,
    strippedThinkBlockCount,
  }
}

function normalizeJsonFence(input: string) {
  const trimmed = input.trim()
  if (!trimmed.startsWith("```")) {
    return { text: input, stripped: false, language: "none" }
  }

  const match = /^```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed)
  if (!match) return { text: input, stripped: false, language: "invalid" }

  const language = match[1]?.trim().toLowerCase() || "none"
  if (language !== "none" && language !== "json") {
    return { text: input, stripped: false, language }
  }

  const inner = match[2]!.trim()
  if (inner.includes("```") || !isJsonObjectText(inner)) {
    return { text: input, stripped: false, language }
  }

  return { text: inner, stripped: true, language }
}

function isJsonObjectText(input: string) {
  try {
    const parsed: unknown = JSON.parse(input)
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed))
  } catch {
    return false
  }
}

function appendThinking(target: string[], value: string) {
  const trimmed = value.trim()
  if (trimmed) target.push(trimmed)
}

function stripTrailingTagPrefix(value: string, tag: string) {
  const prefixLength = trailingTagPrefixLength(value, tag)
  return prefixLength > 0 ? value.slice(0, -prefixLength) : value
}

function trailingTagPrefixLength(value: string, tag: string) {
  const lower = value.toLowerCase()
  const lowerTag = tag.toLowerCase()
  const maxLength = Math.min(lower.length, lowerTag.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (lower.endsWith(lowerTag.slice(0, length))) return length
  }
  return 0
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function trimErrorBody(input: string) {
  return input.replace(/\s+/g, " ").slice(0, 500)
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function isPrematureStreamCloseError(error: unknown) {
  const message = formatError(error)
  return /(?:socket connection was closed unexpectedly|stream.*closed|terminated|premature close)/i.test(message)
}

function isResponseFormatFallbackStatus(status: number) {
  return status === 400 || status === 422
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function requestDiagnostics(input: {
  url: string
  model: string
  providerMaxTokensConfigured: number
  temperature: number
  topP: number
  prompt: string
  requestBody: string
  timeoutMs: number
  responseFormat: "json_object" | "fallback-disabled"
  responseFormatFallback: boolean
}) {
  const parsed = safeUrl(input.url)
  return {
    client: "comment-stream",
    stream: true,
    thinkingBudget: "disabled",
    responseFormat: input.responseFormat,
    responseFormatFallback: input.responseFormatFallback,
    noThinkHint: true,
    messageShape: "system-user",
    jsonPrefixGuard: "enabled",
    maxTokensSent: false,
    maxTokens: "omitted",
    providerMaxTokensConfigured: input.providerMaxTokensConfigured,
    timeoutMs: input.timeoutMs,
    providerScheme: parsed?.protocol.replace(/:$/, "") ?? "unknown",
    providerHostHash: parsed ? shortHash(parsed.host) : "unknown",
    modelHash: shortHash(input.model),
    temperature: input.temperature,
    topP: input.topP,
    promptBytes: textByteLength(input.prompt),
    requestBodyBytes: textByteLength(input.requestBody),
  }
}

function safeUrl(input: string) {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}

function errorDiagnostics(error: unknown) {
  const root = error instanceof Error ? error : undefined
  const cause = root?.cause instanceof Error ? root.cause : undefined
  return {
    errorName: root?.name ?? typeof error,
    errorMessage: root ? trimErrorBody(root.message) : trimErrorBody(String(error)),
    errorCauseName: cause?.name,
    errorCauseMessage: cause ? trimErrorBody(cause.message) : undefined,
  }
}
