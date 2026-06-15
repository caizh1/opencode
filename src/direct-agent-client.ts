import * as vscode from "vscode"
import { CHIPMATE_LOCAL_AGENT_ID, CHIPMATE_SESSION_TITLE } from "./chipmate-constants"
import { extractPluginChatQuestionText } from "./chat-session"
import { chatCompletionsUrl } from "./completion-model-client"
import { renderSkillsForPrompt, skillSystemCatalog, SkillRegistry } from "./skills"
import type { ToolRuntime, ToolRuntimeResult } from "./tool-runtime"
import type {
  HealthResponse,
  ChipMateAgentInfo,
  ChipMateEvent,
  ChipMateMessage,
  ChipMateModelInfo,
  ChipMateSession,
  ChipMateSessionStatus,
  RemoteSettings,
} from "./types"

type DirectAgentClientInput = {
  context: vscode.ExtensionContext
  output: vscode.OutputChannel
  getSettings: () => RemoteSettings
  getApiKey: () => Promise<string | undefined>
  skills: SkillRegistry
  tools: ToolRuntime
}

type SessionRecord = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

type SessionEvent =
  | { type: "session"; session: SessionRecord }
  | { type: "message"; message: ChipMateMessage }

type ChatToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
}

type ChatToolDefinition = ReturnType<ToolRuntime["toolDefinitions"]>[number]

const MAX_AGENT_STEPS = 8
const MAX_STREAM_TOOL_ARGUMENT_BYTES = 128 * 1024

export class DirectAgentClient {
  readonly baseUrl = "chipmate://workspace"
  private readonly listeners = new Set<(event: ChipMateEvent) => void>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly statuses = new Map<string, ChipMateSessionStatus>()

  constructor(private readonly deps: DirectAgentClientInput) {}

  async health(_signal?: AbortSignal): Promise<HealthResponse> {
    const settings = this.deps.getSettings()
    return {
      healthy: Boolean(settings.provider.apiBaseUrl && settings.provider.chatModel),
      version: "direct-openai-compatible",
    }
  }

  async listModels(signal?: AbortSignal): Promise<ChipMateModelInfo[]> {
    const settings = this.deps.getSettings()
    const configured = configuredModels(settings)
    try {
      const response = await fetch(modelsUrl(settings.provider.apiBaseUrl), {
        headers: await this.headers(false),
        signal,
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const body = await response.json() as { data?: Array<{ id?: string; object?: string }> }
      const discovered = (body.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id))
      return normalizeModelInfos([...configured, ...discovered], settings.provider.chatModel)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[provider] /models unavailable, using configured models: ${message}`)
      return normalizeModelInfos(configured, settings.provider.chatModel)
    }
  }

  async listAgents(_signal?: AbortSignal): Promise<ChipMateAgentInfo[]> {
    return [{
      id: CHIPMATE_LOCAL_AGENT_ID,
      name: "ChipMate Local",
      description: "Direct model runtime with workspace-host tools, skills, RAG, and local context.",
      isLocalOnly: true,
    }]
  }

  async listSessions(_signal?: AbortSignal): Promise<ChipMateSession[]> {
    return (await this.readSessionRecords()).map((session) => ({
      id: session.id,
      title: session.title,
      time: session.time,
    })).sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))
  }

  async getSessionStatuses(_signal?: AbortSignal): Promise<Record<string, ChipMateSessionStatus>> {
    return Object.fromEntries(this.statuses)
  }

  async createSession(title = CHIPMATE_SESSION_TITLE, _signal?: AbortSignal): Promise<ChipMateSession> {
    const now = Date.now()
    const session: SessionRecord = {
      id: `session-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
      title,
      time: {
        created: now,
        updated: now,
      },
    }
    await this.appendSessionEvent(session.id, { type: "session", session })
    this.emit("session.created", { info: session })
    return session
  }

  async getMessages(sessionID: string, limit = 100, _signal?: AbortSignal): Promise<ChipMateMessage[]> {
    const events = await this.readSessionEvents(sessionID)
    return events
      .flatMap((event) => event.type === "message" ? [event.message] : [])
      .slice(-limit)
  }

  async sendMessage(input: {
    sessionID: string
    text: string
    model?: unknown
    agent?: string
    signal?: AbortSignal
  }): Promise<ChipMateMessage> {
    const result = await this.runTurn(input.sessionID, input.text, input.signal)
    return result.assistant
  }

  async sendMessageAsync(input: {
    sessionID: string
    text: string
    model?: unknown
    agent?: string
    signal?: AbortSignal
  }) {
    const controller = new AbortController()
    this.activeControllers.set(input.sessionID, controller)
    const abort = () => controller.abort()
    input.signal?.addEventListener("abort", abort, { once: true })
    void this.runTurn(input.sessionID, input.text, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted || input.signal?.aborted) return
        return this.recordSessionError(input.sessionID, error)
      })
      .finally(() => {
        input.signal?.removeEventListener("abort", abort)
        this.activeControllers.delete(input.sessionID)
      })
  }

  async abortSession(sessionID: string, _signal?: AbortSignal) {
    const controller = this.activeControllers.get(sessionID)
    controller?.abort()
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
    return true
  }

  async deleteSession(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = (await this.readSessionEvents(sessionID))
      .find((event): event is Extract<SessionEvent, { type: "session" }> => event.type === "session")
      ?.session
    const controller = this.activeControllers.get(sessionID)
    controller?.abort()
    this.activeControllers.delete(sessionID)
    this.statuses.delete(sessionID)
    await vscode.workspace.fs.delete(await this.sessionUri(sessionID), { useTrash: false })
    this.emit("session.deleted", { info: session ?? { id: sessionID } })
    return true
  }

  async subscribeEvents(
    onEvent: (event: unknown) => void,
    signal: AbortSignal,
    onOpen?: () => void,
    _path?: "/event" | "/global/event",
  ) {
    this.listeners.add(onEvent as (event: ChipMateEvent) => void)
    onOpen?.()
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
    this.listeners.delete(onEvent as (event: ChipMateEvent) => void)
  }

  private async runTurn(sessionID: string, userText: string, signal?: AbortSignal) {
    const settings = this.deps.getSettings()
    const historyMessages = await this.recentChatHistoryMessages(sessionID, settings)
    const userMessage = createMessage(sessionID, "user", userText)
    await this.appendMessage(sessionID, userMessage)
    this.statuses.set(sessionID, { type: "busy" })
    this.emit("message.updated", { info: userMessage.info })
    this.emit("message.part.updated", {
      part: {
        id: `${userMessage.info.id}-text`,
        sessionID,
        messageID: userMessage.info.id,
        type: "text",
        text: userText,
      },
    })
    this.emit("session.status", { sessionID, status: { type: "busy" } })

    const enabledSkillMetadata = await this.deps.skills.enabledSkills()
    const loadedSkills = (await Promise.all(enabledSkillMetadata.map((skill) => this.deps.skills.loadSkill(skill.id))))
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
    const exposedTools = settings.tools.enabled ? this.deps.tools.toolDefinitions() : []
    const exposedToolNames = toolDefinitionNames(exposedTools)
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt(
          settings,
          skillSystemCatalog(enabledSkillMetadata),
          renderSkillsForPrompt(loadedSkills, { toolsEnabled: settings.tools.enabled, exposedToolNames: [...exposedToolNames] }),
        ),
      },
      ...historyMessages,
      { role: "user", content: userText },
    ]

    let assistant = createMessage(sessionID, "assistant", "")
    let assistantText = ""
    let toolCalls: ChatToolCall[] = []

    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        signal?.throwIfAborted()
        const result = await this.streamChatCompletion({
          messages,
          sessionID,
          assistant,
          exposedTools,
          signal,
        })
        assistant = result.assistant
        assistantText = result.text
        toolCalls = result.toolCalls
        if (toolCalls.length === 0) break
        if (!settings.tools.enabled) {
          this.deps.output.appendLine(`[tool] ignored ${toolCalls.length} tool_call(s) because chipmate.tools.enabled=false`)
          assistantText = appendAssistantText(
            assistant,
            sessionID,
            `${assistantText ? "\n\n" : ""}工具调用已关闭，未执行模型返回的工具请求。`,
          )
          this.emit("message.part.updated", {
            part: {
              id: `${assistant.info.id}-text`,
              sessionID,
              messageID: assistant.info.id,
              type: "text",
              text: assistantText,
            },
          })
          break
        }

        messages.push({
          role: "assistant",
          content: assistantText,
          tool_calls: toolCalls,
        })
        for (const call of toolCalls) {
          const args = parseToolArguments(call.function.arguments)
          const isExposedTool = exposedToolNames.has(call.function.name)
          const toolResult = isExposedTool
            ? await this.deps.tools.execute({
                sessionID,
                mode: settings.permissions.mode,
                name: call.function.name,
                arguments: args,
                signal,
              })
            : blockedUnexposedTool(call.function.name)
          if (!isExposedTool) {
            this.deps.output.appendLine(`[tool] blocked unexposed tool_call name=${call.function.name}`)
          }
          const part = {
            id: call.id,
            sessionID,
            messageID: assistant.info.id,
            type: "tool",
            tool: call.function.name,
            state: {
              status: toolResult.approved ? "completed" : toolResult.requiresApproval ? "approval-required" : "blocked",
              input: args,
              output: toolResult.output,
              metadata: {
                risk: toolResult.risk,
                title: toolResult.title,
              },
            },
          }
          assistant.parts = upsertPart(assistant.parts, part)
          this.emit("message.part.updated", { part })
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult.output,
          })
        }
      }
    } catch (error) {
      if (!signal?.aborted) await this.persistPartialAssistant(sessionID, assistant)
      throw error
    }

    assistant.info.time = { ...assistant.info.time, completed: Date.now() }
    await this.appendMessage(sessionID, assistant)
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("message.updated", { info: assistant.info })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
    await this.touchSession(sessionID)
    return { user: userMessage, assistant }
  }

  private async recentChatHistoryMessages(sessionID: string, settings: RemoteSettings): Promise<ChatMessage[]> {
    const maxTurns = Math.max(0, Math.min(20, Math.floor(settings.context.maxHistoryTurns)))
    const maxBytes = Math.max(0, Math.min(200000, Math.floor(settings.context.maxHistoryBytes)))
    if (maxTurns === 0 || maxBytes === 0) return []

    const events = await this.readSessionEvents(sessionID)
    const messages = events
      .flatMap((event) => event.type === "message" ? [event.message] : [])
      .flatMap(historyMessageFromSessionMessage)
    const recent = recentHistoryTurns(messages, maxTurns)
    return fitHistoryMessagesToBudget(recent, maxBytes)
  }

  private async persistPartialAssistant(sessionID: string, assistant: ChipMateMessage) {
    const text = textParts(assistant).trim()
    if (!text) return
    assistant.info.time = { ...assistant.info.time, completed: Date.now() }
    await this.appendMessage(sessionID, assistant).catch(() => undefined)
    this.emit("message.updated", { info: assistant.info })
  }

  private async streamChatCompletion(input: {
    messages: ChatMessage[]
    sessionID: string
    assistant: ChipMateMessage
    exposedTools: ChatToolDefinition[]
    signal?: AbortSignal
  }) {
    const settings = this.deps.getSettings()
    const body: Record<string, unknown> = {
      model: settings.provider.chatModel,
      messages: input.messages,
      stream: true,
      max_tokens: settings.provider.maxTokens,
      temperature: settings.provider.temperature,
      top_p: settings.provider.topP,
    }
    if (settings.tools.enabled && input.exposedTools.length > 0) {
      body.tools = input.exposedTools
      body.tool_choice = "auto"
    }
    const requestStarted = Date.now()
    const promptBytes = textByteLength(JSON.stringify(input.messages))
    this.deps.output.appendLine(
      `[chat-stream] request start model=${settings.provider.chatModel || "default"} messages=${input.messages.length} promptBytes=${promptBytes} tools=${settings.tools.enabled && input.exposedTools.length > 0 ? "enabled" : "disabled"}`,
    )
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal: input.signal,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Chat completion failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`)
    }
    if (!response.body) throw new Error("Chat completion stream is empty.")
    const responseContentType = response.headers.get("content-type") ?? "unknown"
    this.deps.output.appendLine(`[chat-stream] response status=${response.status} contentType=${responseContentType}`)

    let text = ""
    const toolCalls = new Map<number, ChatToolCall>()
    const messageID = input.assistant.info.id
    this.emit("message.updated", { info: input.assistant.info })
    const partID = `${messageID}-text`
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let completed = false
    let doneMarker = false
    let finishReason = ""
    let deltaCount = 0
    let sseDataCount = 0
    let emptySseBlockCount = 0
    let rawByteCount = 0
    let rawPreview = ""
    let emptySsePreview = ""
    let firstChunkMs: number | undefined
    const processSseBlock = (raw: string) => {
      const dataItems = parseSseData(raw)
      if (dataItems.length === 0 && raw.trim()) {
        emptySseBlockCount += 1
        if (!emptySsePreview) emptySsePreview = streamPreview(raw)
      }
      for (const data of dataItems) {
        sseDataCount += 1
        if (data === "[DONE]") {
          completed = true
          doneMarker = true
          continue
        }
        const delta = parseDelta(data)
        deltaCount += 1
        if (delta.error) throw new Error(`Chat completion stream failed: ${delta.error}`)
        if (delta.finishReason) {
          completed = true
          finishReason = delta.finishReason
        }
        if (delta.content) {
          text += delta.content
          const part = {
            id: partID,
            sessionID: input.sessionID,
            messageID,
            type: "text",
            text,
          }
          input.assistant.parts = upsertPart(input.assistant.parts, part)
          this.emit("message.part.delta", {
            sessionID: input.sessionID,
            messageID,
            partID,
            type: "text",
            delta: delta.content,
          })
        }
        for (const call of delta.toolCalls) {
          const existing = toolCalls.get(call.index) ?? {
            id: call.id || `tool-${messageID}-${call.index}`,
            type: "function" as const,
            function: {
              name: "",
              arguments: "",
            },
          }
          if (call.id) existing.id = call.id
          if (call.name) existing.function.name += call.name
          if (call.arguments) {
            existing.function.arguments = truncateString(existing.function.arguments + call.arguments, MAX_STREAM_TOOL_ARGUMENT_BYTES)
          }
          toolCalls.set(call.index, existing)
        }
      }
    }
    while (true) {
      input.signal?.throwIfAborted()
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (input.signal?.aborted) throw error
        throw new Error(`Chat completion stream read failed: ${formatErrorMessage(error)}`)
      }
      if (chunk.done) break
      if (firstChunkMs === undefined) {
        firstChunkMs = Date.now() - requestStarted
        this.deps.output.appendLine(`[chat-stream] first chunk ${firstChunkMs}ms`)
      }
      const decoded = decoder.decode(chunk.value, { stream: true })
      rawByteCount += chunk.value.byteLength
      if (rawPreview.length < 512) rawPreview = truncateString(rawPreview + decoded, 512)
      buffer += decoded
      let boundary = findSseBoundary(buffer)
      while (boundary) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        processSseBlock(raw)
        boundary = findSseBoundary(buffer)
      }
    }
    const decodedTail = decoder.decode()
    if (decodedTail) {
      rawByteCount += textByteLength(decodedTail)
      if (rawPreview.length < 512) rawPreview = truncateString(rawPreview + decodedTail, 512)
      buffer += decodedTail
    }
    if (buffer.trim()) processSseBlock(buffer)
    const streamElapsedMs = Date.now() - requestStarted
    const streamSummary = `deltaCount=${deltaCount} sseDataCount=${sseDataCount} textBytes=${textByteLength(text)} rawBytes=${rawByteCount} firstChunkMs=${firstChunkMs ?? "none"} streamElapsedMs=${streamElapsedMs} doneMarker=${doneMarker ? "true" : "false"} finishReason=${finishReason || "none"} contentType=${responseContentType} emptySseBlocks=${emptySseBlockCount}${emptySsePreview ? ` emptySsePreview=${emptySsePreview}` : ""}${!completed && rawPreview ? ` rawPreview=${streamPreview(rawPreview)}` : ""}`
    this.deps.output.appendLine(`[chat-stream] closed ${streamSummary}`)
    if (!completed) throw new Error(`Chat completion stream closed before completion marker. ${streamSummary}`)

    return {
      assistant: input.assistant,
      text,
      toolCalls: [...toolCalls.values()].filter((call) => call.function.name),
    }
  }

  private async recordSessionError(sessionID: string, error: unknown) {
    const reason = formatErrorMessage(error)
    const message = chatInterruptedMessage(reason)
    const errorMessage: ChipMateMessage = {
      info: {
        id: `error-${Date.now().toString(36)}`,
        sessionID,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        error: { message },
      },
      parts: [{ type: "text", text: message }],
    }
    await this.appendMessage(sessionID, errorMessage).catch(() => undefined)
    const status: ChipMateSessionStatus = { type: "error", interrupted: true, message: reason }
    this.deps.output.appendLine(`[send] interrupted ${sessionID}: ${reason}`)
    this.statuses.set(sessionID, status)
    this.emit("session.error", { sessionID, error: { message: reason } })
    this.emit("session.status", { sessionID, status })
  }

  private async headers(hasBody: boolean) {
    const headers: Record<string, string> = {}
    if (hasBody) headers["Content-Type"] = "application/json"
    const apiKey = await this.deps.getApiKey()
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    return headers
  }

  private emit(type: string, properties: Record<string, unknown>) {
    const event = { type, properties } as ChipMateEvent
    for (const listener of this.listeners) listener(event)
  }

  private async sessionsDir() {
    const dir = vscode.Uri.joinPath(this.deps.context.globalStorageUri, "sessions")
    await vscode.workspace.fs.createDirectory(dir)
    return dir
  }

  private async sessionUri(sessionID: string) {
    return vscode.Uri.joinPath(await this.sessionsDir(), `${sessionID}.jsonl`)
  }

  private async appendSessionEvent(sessionID: string, event: SessionEvent) {
    const uri = await this.sessionUri(sessionID)
    const previous = await readText(uri)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${previous}${JSON.stringify(event)}\n`))
  }

  private async appendMessage(sessionID: string, message: ChipMateMessage) {
    await this.appendSessionEvent(sessionID, { type: "message", message })
  }

  private async readSessionEvents(sessionID: string): Promise<SessionEvent[]> {
    const text = await readText(await this.sessionUri(sessionID))
    return text.split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionEvent]
        } catch {
          return []
        }
      })
  }

  private async readSessionRecords(): Promise<SessionRecord[]> {
    const dir = await this.sessionsDir()
    let entries: [string, vscode.FileType][]
    try {
      entries = await vscode.workspace.fs.readDirectory(dir)
    } catch {
      return []
    }
    const records: SessionRecord[] = []
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".jsonl")) continue
      const sessionID = name.replace(/\.jsonl$/, "")
      const session = (await this.readSessionEvents(sessionID)).find((event): event is Extract<SessionEvent, { type: "session" }> => event.type === "session")?.session
      if (session) records.push(session)
    }
    return records
  }

  private async touchSession(sessionID: string) {
    const events = await this.readSessionEvents(sessionID)
    const session = events.find((event): event is Extract<SessionEvent, { type: "session" }> => event.type === "session")?.session
    if (!session) return
    session.time.updated = Date.now()
    await this.appendSessionEvent(sessionID, { type: "session", session })
    this.emit("session.updated", { info: session })
  }
}

function toolDefinitionNames(definitions: ChatToolDefinition[]) {
  const names = definitions
    .map((definition) => definition.function.name)
    .filter((name) => typeof name === "string" && name.length > 0)
  return new Set<string>(names)
}

function blockedUnexposedTool(toolName: string): ToolRuntimeResult {
  return {
    title: "Tool blocked",
    output: `Tool is not exposed to the model in this chat mode: ${toolName}`,
    approved: false,
    risk: "blocked",
  }
}

function systemPrompt(settings: RemoteSettings, skillCatalog: string, loadedSkills: string) {
  const toolsEnabled = settings.tools.enabled
  return [
    "You are ChipMate, a direct model coding agent running inside the VS Code workspace extension host.",
    toolsEnabled
      ? "Use only the context and the read-only file tool provided by ChipMate for workspace operations."
      : "Use only the context provided by ChipMate for workspace operations.",
    toolsEnabled
      ? "Only chipmate_read is available; use it only to read workspace files when local evidence is incomplete."
      : "ChipMate tool calling is disabled. Do not request, simulate, or emit tool calls; explain missing local information instead.",
    toolsEnabled
      ? `Permission mode: ${settings.permissions.mode}. Obey blocked tool results; if non-read operations are needed, explain the missing capability instead of calling another tool.`
      : "Permission mode settings are inactive while tool calling is disabled.",
    skillCatalog,
    loadedSkills,
  ].filter(Boolean).join("\n\n")
}

function historyMessageFromSessionMessage(message: ChipMateMessage): ChatMessage[] {
  const role = message.info.role
  if (role !== "user" && role !== "assistant") return []
  if (role === "assistant" && message.info.error) return []
  const text = textParts(message).trim()
  if (!text) return []
  if (role === "user") {
    const question = extractPluginChatQuestionText(text)
    return question ? [{ role: "user", content: question }] : []
  }
  return [{ role: "assistant", content: text }]
}

function recentHistoryTurns(messages: ChatMessage[], maxTurns: number) {
  const selected: ChatMessage[] = []
  let turns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role === "system" || message.role === "tool") continue
    selected.unshift(message)
    if (message.role === "user") {
      turns += 1
      if (turns >= maxTurns) break
    }
  }
  return selected
}

function fitHistoryMessagesToBudget(messages: ChatMessage[], maxBytes: number) {
  const selected: ChatMessage[] = []
  let remaining = maxBytes
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const content = message?.content ?? ""
    if (!message || !content) continue
    const cost = textByteLength(content)
    if (cost <= remaining) {
      selected.unshift(message)
      remaining -= cost
      continue
    }
    if (message.role === "assistant" && remaining > 0) {
      const contentTail = textTailByBytes(content, remaining)
      if (contentTail.trim()) selected.unshift({ role: "assistant", content: contentTail })
    }
    break
  }
  return selected
}

function textParts(message: ChipMateMessage) {
  return message.parts
    .flatMap((part) => part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [])
    .join("")
}

function appendAssistantText(assistant: ChipMateMessage, sessionID: string, text: string) {
  const partID = `${assistant.info.id}-text`
  const existing = assistant.parts.find((part) => "id" in part && part.id === partID && part.type === "text")
  const nextText = `${existing && "text" in existing ? existing.text : ""}${text}`
  assistant.parts = upsertPart(assistant.parts, {
    id: partID,
    sessionID,
    messageID: assistant.info.id,
    type: "text",
    text: nextText,
  })
  return nextText
}

function createMessage(sessionID: string, role: "user" | "assistant", text: string): ChipMateMessage {
  const id = `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return {
    info: {
      id,
      sessionID,
      role,
      providerID: "openai-compatible",
      modelID: undefined,
      time: { created: Date.now() },
    },
    parts: text ? [{ type: "text", text }] : [],
  }
}

function configuredModels(settings: RemoteSettings) {
  return [
    settings.provider.chatModel,
    settings.completion.model,
  ].map((model) => model.trim()).filter(Boolean)
}

function normalizeModelInfos(models: string[], defaultModel: string): ChipMateModelInfo[] {
  const seen = new Set<string>()
  return models
    .filter((model) => {
      if (seen.has(model)) return false
      seen.add(model)
      return true
    })
    .map((model) => ({
      id: model,
      providerID: "openai-compatible",
      modelID: model,
      name: model,
      providerName: "OpenAI Compatible",
      isDefault: model === defaultModel,
    }))
}

function modelsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return "/models"
  if (/\/models$/i.test(trimmed)) return trimmed
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/models")
  return `${trimmed}/models`
}

function parseSseData(raw: string) {
  return raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean)
}

function findSseBoundary(input: string) {
  const lf = input.indexOf("\n\n")
  const crlf = input.indexOf("\r\n\r\n")
  if (lf === -1 && crlf === -1) return undefined
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseDelta(data: string) {
  const result: {
    content: string
    toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }>
    finishReason?: string
    error?: string
  } = {
    content: "",
    toolCalls: [],
  }
  try {
    const body = JSON.parse(data) as {
      error?: { message?: string } | string
      choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }>
    }
    if (typeof body.error === "string") {
      result.error = body.error
      return result
    }
    if (body.error && typeof body.error.message === "string") {
      result.error = body.error.message
      return result
    }
    const choice = body.choices?.[0]
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) result.finishReason = choice.finish_reason
    const delta = choice?.delta ?? {}
    if (typeof delta.content === "string") result.content = delta.content
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue
      const call = rawCall as Record<string, unknown>
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {}
      result.toolCalls.push({
        index: typeof call.index === "number" ? call.index : result.toolCalls.length,
        id: typeof call.id === "string" ? call.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
      })
    }
  } catch (error) {
    throw new Error(`Malformed chat completion stream chunk: ${formatErrorMessage(error)}`)
  }
  return result
}

function parseToolArguments(input: string) {
  try {
    const value = JSON.parse(input) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function upsertPart(parts: ChipMateMessage["parts"], part: ChipMateMessage["parts"][number]) {
  const partID = "id" in part && typeof part.id === "string" ? part.id : ""
  if (!partID) return [...parts, part]
  const index = parts.findIndex((existing) => "id" in existing && existing.id === partID)
  if (index === -1) return [...parts, part]
  return parts.map((existing, existingIndex) => existingIndex === index ? part : existing)
}

async function readText(uri: vscode.Uri) {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
  } catch {
    return ""
  }
}

function truncateString(input: string, max: number) {
  if (input.length <= max) return input
  return input.slice(0, max)
}

function streamPreview(input: string) {
  const normalized = input
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\s+/g, " ")
    .trim()
  return truncateString(normalized || "<empty>", 240)
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function chatInterruptedMessage(reason: string) {
  return `对话已中断：${reason}`
}

function textByteLength(input: string) {
  return new TextEncoder().encode(input).length
}

function textTailByBytes(input: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (textByteLength(input) <= maxBytes) return input
  let tail = input.slice(Math.max(0, input.length - maxBytes))
  while (tail && textByteLength(tail) > maxBytes) tail = tail.slice(1)
  return tail
}
