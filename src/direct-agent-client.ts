import * as vscode from "vscode"
import { CHIPMATE_LOCAL_AGENT_ID, CHIPMATE_SESSION_TITLE } from "./chipmate-constants"
import { chatCompletionsUrl } from "./completion-model-client"
import { renderSkillsForPrompt, skillSystemCatalog, SkillRegistry } from "./skills"
import { ToolRuntime } from "./tool-runtime"
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
      .catch((error) => this.recordSessionError(input.sessionID, error))
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

    const settings = this.deps.getSettings()
    const enabledSkillMetadata = await this.deps.skills.enabledSkills()
    const loadedSkills = (await Promise.all(enabledSkillMetadata.map((skill) => this.deps.skills.loadSkill(skill.id))))
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt(settings, skillSystemCatalog(enabledSkillMetadata), renderSkillsForPrompt(loadedSkills)),
      },
      { role: "user", content: userText },
    ]

    let assistant = createMessage(sessionID, "assistant", "")
    let assistantText = ""
    let toolCalls: ChatToolCall[] = []

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      signal?.throwIfAborted()
      const result = await this.streamChatCompletion({
        messages,
        sessionID,
        assistant,
        signal,
      })
      assistant = result.assistant
      assistantText = result.text
      toolCalls = result.toolCalls
      if (toolCalls.length === 0) break

      messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls,
      })
      for (const call of toolCalls) {
        const args = parseToolArguments(call.function.arguments)
        const toolResult = await this.deps.tools.execute({
          sessionID,
          mode: settings.permissions.mode,
          name: call.function.name,
          arguments: args,
          signal,
        })
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

    assistant.info.time = { ...assistant.info.time, completed: Date.now() }
    await this.appendMessage(sessionID, assistant)
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("message.updated", { info: assistant.info })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
    await this.touchSession(sessionID)
    return { user: userMessage, assistant }
  }

  private async streamChatCompletion(input: {
    messages: ChatMessage[]
    sessionID: string
    assistant: ChipMateMessage
    signal?: AbortSignal
  }) {
    const settings = this.deps.getSettings()
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal: input.signal,
      body: JSON.stringify({
        model: settings.provider.chatModel,
        messages: input.messages,
        tools: this.deps.tools.toolDefinitions(),
        tool_choice: "auto",
        stream: true,
        max_tokens: settings.provider.maxTokens,
        temperature: settings.provider.temperature,
        top_p: settings.provider.topP,
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Chat completion failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`)
    }
    if (!response.body) throw new Error("Chat completion stream is empty.")

    let text = ""
    const toolCalls = new Map<number, ChatToolCall>()
    const messageID = input.assistant.info.id
    this.emit("message.updated", { info: input.assistant.info })
    const partID = `${messageID}-text`
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      input.signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const data of parseSseData(raw)) {
          if (data === "[DONE]") continue
          const delta = parseDelta(data)
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
        boundary = buffer.indexOf("\n\n")
      }
    }

    return {
      assistant: input.assistant,
      text,
      toolCalls: [...toolCalls.values()].filter((call) => call.function.name),
    }
  }

  private async recordSessionError(sessionID: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
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
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("session.error", { sessionID, error: { message } })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
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

function systemPrompt(settings: RemoteSettings, skillCatalog: string, loadedSkills: string) {
  return [
    "You are ChipMate, a direct model coding agent running inside the VS Code workspace extension host.",
    "Use only the context and tools provided by ChipMate for workspace operations.",
    "Tool calls execute on the current workspace host, which may be a local machine or a Remote SSH Linux host.",
    `Permission mode: ${settings.permissions.mode}. Obey blocked tool results and summarize what approval is needed.`,
    skillCatalog,
    loadedSkills,
  ].filter(Boolean).join("\n\n")
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

function parseDelta(data: string) {
  const result: { content: string; toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }> } = {
    content: "",
    toolCalls: [],
  }
  try {
    const body = JSON.parse(data) as { choices?: Array<{ delta?: Record<string, unknown> }> }
    const delta = body.choices?.[0]?.delta ?? {}
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
  } catch {
    return result
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
