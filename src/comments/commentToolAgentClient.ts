import { chatCompletionsUrl } from "../completion-model-client"
import type { ToolRuntimeInput, ToolRuntimeResult } from "../tool-runtime"
import type { PermissionMode, RemoteSettings } from "../types"
import {
  shortHash,
  textByteLength,
  type CommentGenerationTerminalReason,
  type CommentDiagnosticStageEvent,
} from "./commentDiagnostics"
import { formatAllowedInsertionAnchors } from "./commentAnchors"
import type {
  CommentGenerationContext,
  CommentGroundingConfidence,
  CommentOutputDirective,
} from "./commentTypes"

const COMMENT_TOOL_LOOP_TIMEOUT_MS = 45_000
const COMMENT_TOOL_LOOP_MAX_ROUNDS = 4
const COMMENT_TOOL_CALLS_PER_ROUND = 4
const COMMENT_TOOL_EVIDENCE_SUMMARY_LIMIT = 60_000
const COMMENT_TOOL_RESULT_SUMMARY_LIMIT = 14_000
const COMMENT_TOOL_SNIPPET_LIMIT = 8_000
const COMMENT_TOOL_ARGUMENT_LIMIT = 24_000

const COMMENT_READABLE_TOOL_NAMES = new Set([
  "chipmate_read",
  "chipmate_list_files",
  "chipmate_search_text",
  "chipmate_search_code",
  "chipmate_graph_inspect_symbol",
  "chipmate_graph_find_references",
  "chipmate_graph_callers",
  "chipmate_graph_callees",
  "chipmate_graph_trace_call_chain",
  "chipmate_graph_analyze_impact",
  "chipmate_graph_map_module",
  "chipmate_graph_find_state_machines",
  "chipmate_graph_trace_state_path",
  "chipmate_search_documents",
  "chipmate_read_evidence",
])

const COMMENT_TOOL_LOOP_SYSTEM_PROMPT = [
  "You are ChipMate AI Comment Review's local evidence-gathering agent.",
  "You may call read-only ChipMate tools to understand the selected code before comments are generated.",
  "Do not write final comments in this phase.",
  "Do not modify files.",
  "Do not request write, shell, or HTTP tools.",
  "Gather evidence about why the selected code exists, call flow, state transitions, ownership, concurrency, DMA/cache, hardware ordering, error handling, or protocol behavior.",
  "Prefer precise file reads, symbol graph tools, and evidence expansion over broad guessing.",
  "Stop calling tools once enough grounded evidence is available.",
].join("\n")

export type CommentToolDefinition = {
  type: string
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export type CommentToolRuntime = {
  toolDefinitions(): CommentToolDefinition[]
  execute(input: ToolRuntimeInput): Promise<ToolRuntimeResult>
}

export type CommentToolAgentInput = {
  getSettings: () => RemoteSettings
  getApiKey: () => Promise<string | undefined>
  tools?: CommentToolRuntime
}

export type CommentToolDiagnosticLogger = (event: CommentDiagnosticStageEvent) => void

export type CommentToolEvidenceSuccess = {
  ok: true
  evidenceSummary: string
  evidenceItemCount: number
  evidenceSummaryBytes: number
  elapsedMs: number
  roundCount: number
  toolCallCount: number
  blockedToolCount: number
  failedToolCount: number
  outputDirective: CommentOutputDirective
  groundingConfidence: CommentGroundingConfidence
  groundingSummary: string
  evidenceCompacted: boolean
  exhausted: boolean
}

export type CommentToolEvidenceFailure = {
  ok: false
  reason: Extract<
    CommentGenerationTerminalReason,
    "tools-disabled" | "tool-loop-failed" | "tool-loop-exhausted" | "tool-evidence-empty"
  >
  message: string
  elapsedMs: number
  roundCount: number
  toolCallCount: number
  blockedToolCount: number
  failedToolCount: number
}

export type CommentToolEvidenceResult = CommentToolEvidenceSuccess | CommentToolEvidenceFailure

type ChatToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type ToolRoundResult = {
  responseOk: boolean
  responseStatus?: number
  responseStatusText?: string
  assistantText: string
  toolCalls: ChatToolCall[]
  elapsedMs: number
}

type ToolAccumulator = {
  summaryRows: string[]
  evidenceItemCount: number
  toolCallCount: number
  blockedToolCount: number
  failedToolCount: number
  roundCount: number
  exhausted: boolean
}

export class CommentToolAgentClient {
  constructor(private readonly deps: CommentToolAgentInput) {}

  async collectEvidence(
    context: CommentGenerationContext,
    traceId: string,
    diagnostics?: CommentToolDiagnosticLogger,
    signal?: AbortSignal,
  ): Promise<CommentToolEvidenceResult> {
    const started = Date.now()
    const settings = this.deps.getSettings()
    const permissionMode = settings.permissions.mode
    const toolDefinitions = this.readableToolDefinitions()
    const baseFields = {
      client: "comment-tool-loop",
      toolsEnabled: settings.tools.enabled,
      permissionMode,
      readableToolCount: toolDefinitions.length,
    }
    if (!settings.tools.enabled || !this.deps.tools) {
      diagnostics?.({
        stage: "tool.loop.disabled",
        fields: {
          ...baseFields,
          reason: settings.tools.enabled ? "tool-runtime-unavailable" : "tools-disabled",
        },
      })
      return failure("tools-disabled", "AI 注释需要启用 ChipMate 工具检索。请开启工具后重试。", started)
    }
    if (toolDefinitions.length === 0) {
      diagnostics?.({
        stage: "tool.loop.disabled",
        fields: {
          ...baseFields,
          reason: "no-readable-tools",
        },
      })
      return failure("tools-disabled", "AI 注释没有可用的只读工具。请检查 ChipMate 工具配置。", started)
    }
    if (!settings.provider.apiBaseUrl) {
      return failure("tool-loop-failed", "尚未配置 ChipMate provider API base URL。", started)
    }
    if (!settings.provider.chatModel) {
      return failure("tool-loop-failed", "尚未配置 ChipMate provider chat model。", started)
    }

    diagnostics?.({
      stage: "tool.loop.start",
      fields: {
        ...baseFields,
        maxRounds: COMMENT_TOOL_LOOP_MAX_ROUNDS,
        maxToolCallsPerRound: COMMENT_TOOL_CALLS_PER_ROUND,
      },
    })

    const messages: ChatMessage[] = [
      { role: "system", content: COMMENT_TOOL_LOOP_SYSTEM_PROMPT },
      { role: "user", content: buildToolLoopPrompt(context) },
    ]
    const accumulator: ToolAccumulator = {
      summaryRows: [],
      evidenceItemCount: 0,
      toolCallCount: 0,
      blockedToolCount: 0,
      failedToolCount: 0,
      roundCount: 0,
      exhausted: false,
    }

    try {
      for (let roundIndex = 0; roundIndex < COMMENT_TOOL_LOOP_MAX_ROUNDS; roundIndex += 1) {
        accumulator.roundCount = roundIndex + 1
        const roundResult = await this.requestToolRound({
          settings,
          messages,
          toolDefinitions,
          diagnostics,
          started,
          roundIndex,
          signal,
          permissionMode,
        })
        if (!roundResult.responseOk) {
          return failure(
            "tool-loop-failed",
            `AI 注释工具检索请求失败: ${roundResult.responseStatus ?? "unknown"} ${roundResult.responseStatusText ?? ""}`.trim(),
            started,
            accumulator,
          )
        }
        const toolCalls = roundResult.toolCalls.slice(0, COMMENT_TOOL_CALLS_PER_ROUND)
        messages.push({
          role: "assistant",
          content: roundResult.assistantText || "",
          ...(roundResult.toolCalls.length ? { tool_calls: roundResult.toolCalls } : {}),
        })
        if (roundResult.toolCalls.length === 0) {
          break
        }
        if (roundResult.toolCalls.length > COMMENT_TOOL_CALLS_PER_ROUND) {
          const skipped = roundResult.toolCalls.slice(COMMENT_TOOL_CALLS_PER_ROUND)
          accumulator.blockedToolCount += skipped.length
          for (const call of skipped) {
            diagnostics?.({
              stage: "tool.call.blocked",
              fields: {
                ...baseFields,
                roundIndex,
                toolName: call.function.name || "unknown",
                reason: "max-tool-calls-per-round",
              },
            })
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                answerSummary: "This tool call was skipped because the comments tool loop reached the per-round limit.",
                evidence: [],
                gaps: ["Too many tool calls in one round."],
                truncated: false,
                coverage: "unknown",
              }),
            })
          }
        }
        for (const call of toolCalls) {
          const result = await this.executeToolCall({
            call,
            traceId,
            roundIndex,
            permissionMode,
            diagnostics,
            baseFields,
            signal,
          })
          accumulator.toolCallCount += 1
          if (!result.approved || result.status === "blocked" || result.status === "approval-required") {
            accumulator.blockedToolCount += 1
          }
          if (result.status === "failed") {
            accumulator.failedToolCount += 1
          }
          const evidenceSummary = summarizeToolResult(call.function.name, result)
          accumulator.summaryRows.push(evidenceSummary.text)
          accumulator.evidenceItemCount += evidenceSummary.evidenceItemCount
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.output || result.error || result.title,
          })
        }
        if (roundIndex === COMMENT_TOOL_LOOP_MAX_ROUNDS - 1) {
          accumulator.exhausted = true
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return failure("tool-loop-failed", error instanceof Error ? error.message : String(error), started, accumulator)
    }

    const elapsedMs = Date.now() - started
    if (accumulator.evidenceItemCount === 0 && accumulator.exhausted) {
      diagnostics?.({
        stage: "tool.loop.done",
        fields: {
          ...baseFields,
          success: false,
          elapsedMs,
          roundCount: accumulator.roundCount,
          toolCallCount: accumulator.toolCallCount,
          blockedToolCount: accumulator.blockedToolCount,
          failedToolCount: accumulator.failedToolCount,
          evidenceItemCount: accumulator.evidenceItemCount,
          exhausted: accumulator.exhausted,
        },
      })
      return failure("tool-loop-exhausted", "AI 注释工具检索已达到轮次上限，但没有得到可用证据。", started, accumulator)
    }
    if (accumulator.evidenceItemCount === 0) {
      diagnostics?.({
        stage: "tool.loop.done",
        fields: {
          ...baseFields,
          success: false,
          elapsedMs,
          roundCount: accumulator.roundCount,
          toolCallCount: accumulator.toolCallCount,
          blockedToolCount: accumulator.blockedToolCount,
          failedToolCount: accumulator.failedToolCount,
          evidenceItemCount: accumulator.evidenceItemCount,
          exhausted: accumulator.exhausted,
        },
      })
      return failure("tool-evidence-empty", "模型工具检索没有返回可支撑注释的本地证据。", started, accumulator)
    }

    const evidenceSummary = limitBytes(accumulator.summaryRows.filter(Boolean).join("\n\n"), COMMENT_TOOL_EVIDENCE_SUMMARY_LIMIT)
    const evidenceCompacted = textByteLength(evidenceSummary) < textByteLength(accumulator.summaryRows.join("\n\n"))
    const groundingConfidence: CommentGroundingConfidence = accumulator.failedToolCount > 0 || accumulator.blockedToolCount > 0
      ? "medium"
      : "high"
    const outputDirective: CommentOutputDirective = groundingConfidence === "high" || groundingConfidence === "medium"
      ? "encourage-1-3"
      : "allow-empty"
    diagnostics?.({
      stage: "tool.loop.done",
      fields: {
        ...baseFields,
        success: true,
        elapsedMs,
        roundCount: accumulator.roundCount,
        toolCallCount: accumulator.toolCallCount,
        blockedToolCount: accumulator.blockedToolCount,
        failedToolCount: accumulator.failedToolCount,
        evidenceItemCount: accumulator.evidenceItemCount,
        evidenceSummaryBytes: textByteLength(evidenceSummary),
        outputDirective,
        groundingConfidence,
        evidenceCompacted,
        exhausted: accumulator.exhausted,
      },
    })
    return {
      ok: true,
      evidenceSummary,
      evidenceItemCount: accumulator.evidenceItemCount,
      evidenceSummaryBytes: textByteLength(evidenceSummary),
      elapsedMs,
      roundCount: accumulator.roundCount,
      toolCallCount: accumulator.toolCallCount,
      blockedToolCount: accumulator.blockedToolCount,
      failedToolCount: accumulator.failedToolCount,
      outputDirective,
      groundingConfidence,
      groundingSummary: [
        `工具检索证据置信度: ${groundingConfidence}。`,
        `模型主动调用 ${accumulator.toolCallCount} 次只读工具，得到 ${accumulator.evidenceItemCount} 条证据。`,
        accumulator.blockedToolCount ? `有 ${accumulator.blockedToolCount} 次工具调用被权限或安全规则阻止。` : "",
        accumulator.failedToolCount ? `有 ${accumulator.failedToolCount} 次工具调用失败，相关缺口已保留。` : "",
        accumulator.exhausted ? "工具循环达到轮次上限；请仅使用已获得的证据，不要补猜。" : "",
      ].filter(Boolean).join("\n"),
      evidenceCompacted,
      exhausted: accumulator.exhausted,
    }

    function failure(
      reason: CommentToolEvidenceFailure["reason"],
      message: string,
      failureStarted: number,
      partial: Partial<ToolAccumulator> = {},
    ): CommentToolEvidenceFailure {
      return {
        ok: false,
        reason,
        message,
        elapsedMs: Date.now() - failureStarted,
        roundCount: partial.roundCount ?? 0,
        toolCallCount: partial.toolCallCount ?? 0,
        blockedToolCount: partial.blockedToolCount ?? 0,
        failedToolCount: partial.failedToolCount ?? 0,
      }
    }
  }

  readableToolDefinitions() {
    const definitions = this.deps.tools?.toolDefinitions() ?? []
    return definitions.filter((definition) => COMMENT_READABLE_TOOL_NAMES.has(definition.function.name))
  }

  private async headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    const apiKey = await this.deps.getApiKey()
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    return headers
  }

  private async requestToolRound(input: {
    settings: RemoteSettings
    messages: ChatMessage[]
    toolDefinitions: CommentToolDefinition[]
    diagnostics?: CommentToolDiagnosticLogger
    started: number
    roundIndex: number
    signal?: AbortSignal
    permissionMode: PermissionMode
  }): Promise<ToolRoundResult> {
    const url = chatCompletionsUrl(input.settings.provider.apiBaseUrl)
    const temperature = Math.min(input.settings.provider.temperature, 0.2)
    const requestBody = JSON.stringify({
      model: input.settings.provider.chatModel,
      messages: input.messages,
      stream: true,
      temperature,
      top_p: input.settings.provider.topP,
      tools: input.toolDefinitions,
      tool_choice: "auto",
    })
    const safeFields = requestDiagnostics({
      url,
      model: input.settings.provider.chatModel,
      requestBody,
      temperature,
      topP: input.settings.provider.topP,
      providerMaxTokensConfigured: input.settings.provider.maxTokens,
      permissionMode: input.permissionMode,
      readableToolCount: input.toolDefinitions.length,
      roundIndex: input.roundIndex,
    })
    input.diagnostics?.({
      stage: "tool.loop.round.start",
      fields: safeFields,
    })

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let responseHeadersReceived = false
    const requestStarted = Date.now()
    const armTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        input.diagnostics?.({
          stage: "tool.loop.timeout",
          fields: {
            ...safeFields,
            elapsedMs: Date.now() - requestStarted,
            responseHeadersReceived,
          },
        })
        controller.abort()
      }, COMMENT_TOOL_LOOP_TIMEOUT_MS)
    }
    armTimeout()
    const onAbort = () => controller.abort()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      input.diagnostics?.({
        stage: "tool.loop.http.start",
        fields: safeFields,
      })
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: await this.headers(),
        body: requestBody,
      })
      responseHeadersReceived = true
      armTimeout()
      input.diagnostics?.({
        stage: "tool.loop.http.headers",
        fields: {
          ...safeFields,
          elapsedMs: Date.now() - requestStarted,
          responseStatus: response.status,
          responseContentType: response.headers.get("content-type") ?? "unknown",
        },
      })
      if (!response.ok) {
        const text = await response.text()
        return {
          responseOk: false,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          assistantText: limitBytes(text, 320),
          toolCalls: [],
          elapsedMs: Date.now() - requestStarted,
        }
      }
      if (!response.body) throw new Error("comments 工具循环 streaming 响应体为空。")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let assistantText = ""
      let rawBytes = 0
      const toolCalls = new Map<number, ChatToolCall>()
      let done = false
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        armTimeout()
        rawBytes += chunk.value.byteLength
        buffer += decoder.decode(chunk.value, { stream: true })
        const parsed = parseSseBuffer(buffer)
        buffer = parsed.remainder
        for (const data of parsed.events) {
          if (data.trim() === "[DONE]") {
            done = true
            break
          }
          const delta = parseToolStreamDelta(data)
          assistantText += delta.content
          for (const call of delta.toolCalls) {
            const existing = toolCalls.get(call.index) ?? {
              id: call.id || `comment-tool-${input.roundIndex}-${call.index}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            }
            if (call.id) existing.id = call.id
            if (call.name) existing.function.name += call.name
            if (call.arguments) {
              existing.function.arguments = limitBytes(existing.function.arguments + call.arguments, COMMENT_TOOL_ARGUMENT_LIMIT)
            }
            toolCalls.set(call.index, existing)
          }
        }
      }
      const elapsedMs = Date.now() - requestStarted
      const calls = Array.from(toolCalls.entries())
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call)
      input.diagnostics?.({
        stage: "tool.loop.round.done",
        fields: {
          ...safeFields,
          elapsedMs,
          assistantBytes: textByteLength(assistantText),
          toolCallCount: calls.length,
          rawBytes,
        },
      })
      return {
        responseOk: true,
        assistantText,
        toolCalls: calls,
        elapsedMs,
      }
    } catch (error) {
      if (timedOut) {
        return {
          responseOk: false,
          responseStatusText: `tool loop timeout after ${COMMENT_TOOL_LOOP_TIMEOUT_MS}ms`,
          assistantText: "",
          toolCalls: [],
          elapsedMs: Date.now() - requestStarted,
        }
      }
      if (input.signal?.aborted) throw error
      return {
        responseOk: false,
        responseStatusText: error instanceof Error ? error.message : String(error),
        assistantText: "",
        toolCalls: [],
        elapsedMs: Date.now() - requestStarted,
      }
    } finally {
      if (timer) clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  private async executeToolCall(input: {
    call: ChatToolCall
    traceId: string
    roundIndex: number
    permissionMode: PermissionMode
    diagnostics?: CommentToolDiagnosticLogger
    baseFields: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<ToolRuntimeResult> {
    const toolName = input.call.function.name
    const started = Date.now()
    const baseFields = {
      ...input.baseFields,
      roundIndex: input.roundIndex,
      toolCallId: shortHash(input.call.id),
      toolName,
      argumentsBytes: textByteLength(input.call.function.arguments),
    }
    if (!COMMENT_READABLE_TOOL_NAMES.has(toolName)) {
      input.diagnostics?.({
        stage: "tool.call.blocked",
        fields: {
          ...baseFields,
          reason: "tool-not-allowed",
        },
      })
      return {
        title: toolName || "unknown",
        output: JSON.stringify({ answerSummary: "Tool was not exposed to comments.", evidence: [], gaps: ["Tool not allowed."] }),
        approved: false,
        status: "blocked",
        error: "tool-not-allowed",
      }
    }
    const parsedArguments = parseToolArguments(input.call.function.arguments)
    if (!parsedArguments.ok) {
      input.diagnostics?.({
        stage: "tool.call.failed",
        fields: {
          ...baseFields,
          elapsedMs: Date.now() - started,
          reason: "invalid-tool-arguments",
        },
      })
      return {
        title: toolName,
        output: JSON.stringify({ answerSummary: "Tool arguments were invalid JSON.", evidence: [], gaps: ["Invalid tool arguments."] }),
        approved: false,
        status: "failed",
        error: "invalid-tool-arguments",
      }
    }
    input.diagnostics?.({
      stage: "tool.call.start",
      fields: baseFields,
    })
    const result = await this.deps.tools!.execute({
      sessionID: input.traceId,
      mode: input.permissionMode,
      name: toolName,
      arguments: parsedArguments.value,
      signal: input.signal,
    })
    const elapsedMs = Date.now() - started
    const summary = summarizeToolResult(toolName, result)
    const stage = result.status === "blocked" || result.status === "approval-required" || !result.approved
      ? "tool.call.blocked"
      : result.status === "failed"
        ? "tool.call.failed"
        : "tool.call.done"
    input.diagnostics?.({
      stage,
      fields: {
        ...baseFields,
        elapsedMs,
        status: result.status ?? "completed",
        approved: result.approved,
        risk: result.risk ?? "unknown",
        outputBytes: textByteLength(result.output ?? ""),
        evidenceItemCount: summary.evidenceItemCount,
        evidenceSummaryBytes: textByteLength(summary.text),
        errorHash: result.error ? shortHash(result.error) : undefined,
      },
    })
    return result
  }
}

function buildToolLoopPrompt(context: CommentGenerationContext) {
  return [
    "请为 AI 注释生成阶段主动检索本地证据。",
    "你可以调用所有已暴露的只读 ChipMate 工具，包括 chipmate_read、搜索、CodeGraph 和 Document RAG 工具。",
    "如果当前选区的含义需要完整文件、相关调用方/被调方、状态机或文档证据，请主动调用工具。",
    "不要生成最终注释 JSON；最终注释会在单独阶段生成。",
    "",
    "当前文件：",
    context.filePath,
    "",
    "语言：",
    context.languageId,
    "",
    "选区行范围：",
    `${context.selectionStartLine}-${context.selectionEndLine}`,
    "",
    "选区注释策略：",
    `selectionIntent=${context.selectionIntent}`,
    `proposalBudget=${context.proposalBudget}`,
    `primaryAnchorLine=${context.primaryAnchorLine ?? "none"}`,
    `internalAnchorLines=${JSON.stringify(context.internalAnchorLines)}`,
    "",
    "Allowed insertion anchors：",
    formatAllowedInsertionAnchors(context.allowedInsertionAnchors),
    "",
    "选区前代码：",
    context.contextBefore,
    "",
    "选中代码：",
    context.selectedCode,
    "",
    "选区后代码：",
    context.contextAfter,
    "",
    "取证目标：",
    "- 找出选区代码为什么存在。",
    "- 查明与选区相关的调用流、状态迁移、ownership、并发、DMA/cache、硬件顺序、错误恢复或协议语义。",
    "- 如果证据不足，继续调用只读工具；如果没有可用证据，停止并说明缺口。",
  ].join("\n")
}

function summarizeToolResult(toolName: string, result: ToolRuntimeResult) {
  const parsed = parseToolPayload(result.output)
  if (!parsed) {
    return {
      evidenceItemCount: result.approved ? 1 : 0,
      text: limitBytes([
        `工具: ${toolName}`,
        `状态: ${result.status ?? "completed"} approved=${result.approved}`,
        result.error ? `错误摘要: ${limitOneLine(result.error, 240)}` : "",
        `输出摘要: ${limitOneLine(result.output ?? "", COMMENT_TOOL_RESULT_SUMMARY_LIMIT)}`,
      ].filter(Boolean).join("\n"), COMMENT_TOOL_RESULT_SUMMARY_LIMIT),
    }
  }
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : []
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : []
  const dataSummary = summarizeToolData(parsed.data)
  const evidenceRows = evidence.slice(0, 12).map((item, index) => {
    const record = asRecord(item)
    const path = stringValue(record.path) || "unknown"
    const lines = stringValue(record.lines) || "?"
    const sourceKind = stringValue(record.sourceKind) || toolName
    const snippet = limitBytes(stringValue(record.snippet) || "", COMMENT_TOOL_SNIPPET_LIMIT)
    return [
      `  ${index + 1}. ${path}:${lines} (${sourceKind})`,
      snippet ? `     snippet:\n${indent(snippet, "     ")}` : "",
    ].filter(Boolean).join("\n")
  })
  const text = [
    `工具: ${toolName}`,
    `状态: ${result.status ?? "completed"} approved=${result.approved} risk=${result.risk ?? "unknown"}`,
    `摘要: ${limitOneLine(stringValue(parsed.answerSummary) || result.title, 500)}`,
    `覆盖: ${stringValue(parsed.coverage) || "unknown"} truncated=${Boolean(parsed.truncated)}`,
    evidenceRows.length ? `证据:\n${evidenceRows.join("\n")}` : "证据: 无结构化 evidence。",
    dataSummary ? `数据摘要:\n${dataSummary}` : "",
    gaps.length ? `缺口:\n${gaps.slice(0, 6).map((gap) => `- ${limitOneLine(String(gap), 300)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")
  return {
    evidenceItemCount: evidence.length,
    text: limitBytes(text, COMMENT_TOOL_RESULT_SUMMARY_LIMIT),
  }
}

function summarizeToolData(data: unknown) {
  if (!data) return ""
  const record = asRecord(data)
  const text = stringValue(record.text)
  if (text) {
    return [
      `textBytes=${textByteLength(text)}`,
      "textPreview:",
      indent(limitBytes(text, COMMENT_TOOL_SNIPPET_LIMIT), "  "),
    ].join("\n")
  }
  const json = limitBytes(JSON.stringify(data, null, 2), 2400)
  return json === "{}" ? "" : json
}

function parseToolPayload(output: string | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

function parseToolArguments(input: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = input.trim() ? JSON.parse(input) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

function parseSseBuffer(buffer: string) {
  const events: string[] = []
  let remainder = buffer
  while (true) {
    const boundary = findSseBoundary(remainder)
    if (boundary === -1) break
    const rawEvent = remainder.slice(0, boundary.index)
    remainder = remainder.slice(boundary.index + boundary.length)
    const data = rawEvent
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
    if (data) events.push(data)
  }
  return { events, remainder }
}

function findSseBoundary(input: string): { index: number; length: number } | -1 {
  const crlf = input.indexOf("\r\n\r\n")
  const lf = input.indexOf("\n\n")
  if (crlf === -1 && lf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseToolStreamDelta(data: string): {
  content: string
  toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }>
} {
  try {
    const parsed = JSON.parse(data)
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
    const delta = choice?.delta
    const content = typeof delta?.content === "string" ? delta.content : ""
    const toolCalls = Array.isArray(delta?.tool_calls)
      ? delta.tool_calls.map((call: any) => ({
        index: typeof call?.index === "number" ? call.index : 0,
        id: typeof call?.id === "string" ? call.id : undefined,
        name: typeof call?.function?.name === "string" ? call.function.name : undefined,
        arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : undefined,
      }))
      : []
    return { content, toolCalls }
  } catch {
    return { content: "", toolCalls: [] }
  }
}

function requestDiagnostics(input: {
  url: string
  model: string
  requestBody: string
  temperature: number
  topP: number
  providerMaxTokensConfigured: number
  permissionMode: PermissionMode
  readableToolCount: number
  roundIndex: number
}) {
  const parsedUrl = safeUrl(input.url)
  return {
    client: "comment-tool-loop",
    stream: true,
    timeoutMs: COMMENT_TOOL_LOOP_TIMEOUT_MS,
    providerScheme: parsedUrl?.protocol.replace(":", "") ?? "unknown",
    providerHostHash: parsedUrl ? shortHash(parsedUrl.host) : "unknown",
    modelHash: shortHash(input.model),
    maxTokensSent: false,
    maxTokens: "omitted",
    providerMaxTokensConfigured: input.providerMaxTokensConfigured,
    temperature: input.temperature,
    topP: input.topP,
    requestBodyBytes: textByteLength(input.requestBody),
    toolsEnabled: true,
    readableToolCount: input.readableToolCount,
    permissionMode: input.permissionMode,
    roundIndex: input.roundIndex,
  }
}

function safeUrl(input: string) {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function limitOneLine(input: string, maxBytes: number) {
  return limitBytes(input.replace(/\s+/g, " ").trim(), maxBytes)
}

function limitBytes(input: string, maxBytes: number) {
  const encoder = new TextEncoder()
  if (encoder.encode(input).byteLength <= maxBytes) return input
  let output = ""
  for (const char of input) {
    const next = output + char
    if (encoder.encode(next).byteLength > maxBytes) break
    output = next
  }
  return `${output}...[truncated]`
}

function indent(input: string, prefix: string) {
  return input.split(/\r?\n/g).map((line) => `${prefix}${line}`).join("\n")
}
