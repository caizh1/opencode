import * as vscode from "vscode"
import { createChatViewHtml } from "./chat-html"
import {
  addPickedFilesToContext,
  buildChatPrompt,
  type ContextSummaryItem,
  LocalContextStore,
  MissingLocalContextError,
  relativePath,
} from "./context"
import type { TrackedEditorContext } from "./editor-context"
import { buildMentionIndex, searchMentionIndex, type MentionIndexEntry } from "./mention-index"
import { isSessionNotFoundError, parseModel, RemoteOpenCodeClient } from "./remote-client"
import { splitThinkingFromParts } from "./thinking"
import type {
  ChatContextOptions,
  ConnectionState,
  OpenCodeMessage,
  OpenCodeModelInfo,
  OpenCodePart,
  OpenCodeSession,
  PromptModel,
  RemoteSettings,
} from "./types"
import type { ConnectionSettingsInput } from "./settings"

type MentionedFileRef = {
  uri: string
  label: string
  type?: "file" | "folder"
  insertText?: string
}

type ChatViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "refreshSessions" }
  | { type: "openOutput" }
  | { type: "newSession" }
  | { type: "addFile" }
  | { type: "clearContext" }
  | { type: "selectSession"; sessionID: string }
  | { type: "refreshModels" }
  | { type: "selectModel"; model: string }
  | { type: "searchFilesForMention"; query?: string; requestId?: number }
  | {
      type: "connectWithSettings" | "testWithSettings"
      serverUrl: string
      username: string
      password?: string
    }
  | {
      type: "sendMessage"
      text: string
      mentionedFiles?: MentionedFileRef[]
      options?: Partial<ChatContextOptions>
    }

type RenderedSession = {
  id: string
  title: string
  created?: number
  updated?: number
  serverToolsUsed?: boolean
}

type RenderedPart = {
  type: string
  title?: string
  text?: string
  status?: string
  detail?: string
}

type RenderedMessage = {
  id: string
  role: string
  text: string
  timeCreated?: number
  timeCompleted?: number
  parts: RenderedPart[]
  error?: string
  serverToolsUsed?: boolean
}

type MentionIndexState = {
  entries: MentionIndexEntry[]
  truncated: boolean
}

type RemoteChatViewProviderDeps = {
  output: vscode.OutputChannel
  contextStore: LocalContextStore
  getClient: () => RemoteOpenCodeClient | undefined
  getSettings: () => RemoteSettings
  getEditorContext: () => TrackedEditorContext | undefined
  connectWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  testWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  setConnectionState: (state: ConnectionState, detail?: string) => void
  openOutput: () => void
}

export class RemoteChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "opencodeRemote.sidebar"

  private view?: vscode.WebviewView
  private sessionID?: string
  private sessions: RenderedSession[] = []
  private messages: RenderedMessage[] = []
  private connectionState: ConnectionState = "disconnected"
  private connectionDetail = "Ready. Enter a server URL and click Connect."
  private sending = false
  private loadingMessages = false
  private loadingModels = false
  private models: OpenCodeModelInfo[] = []
  private modelError = ""
  private lastContextSummary: ContextSummaryItem[] = []
  private readonly flaggedSessions = new Set<string>()
  private mentionIndex?: MentionIndexState
  private mentionIndexBuild?: Promise<MentionIndexState>

  constructor(private readonly deps: RemoteChatViewProviderDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    this.deps.output.appendLine("[view] OpenCode Remote 0.0.14 using opencodeRemote.sidebar")
    webviewView.webview.options = {
      enableScripts: true,
    }
    webviewView.webview.html = createChatViewHtml(webviewView.webview.cspSource)
    webviewView.webview.onDidReceiveMessage((message: ChatViewMessage) => {
      void this.handleMessage(message)
    })
    this.postState()
  }

  async reveal() {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.opencodeRemote")
      await vscode.commands.executeCommand(`${RemoteChatViewProvider.viewType}.focus`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[view] Failed to open workbench.view.extension.opencodeRemote / ${RemoteChatViewProvider.viewType}.focus: ${message}`)
      vscode.window.setStatusBarMessage("Open OpenCode from the Activity Bar.", 3000)
    }
  }

  setConnectionState(state: ConnectionState, detail = "") {
    this.connectionState = state
    this.connectionDetail = detail
    this.postState()
  }

  async refresh() {
    const client = this.deps.getClient()
    if (!client || this.connectionState !== "connected") {
      this.postState()
      return
    }

    this.loadingMessages = true
    this.postState()
    try {
      await this.refreshModelList(client)
      await this.refreshSessionList(client)
      this.reconcileSessionSelection()
      await this.loadSelectedSessionMessages(client)
    } catch (error) {
      this.reportError("Failed to refresh remote chat", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  async newSession() {
    const client = this.connectedClient("Connect before creating a session.")
    if (!client) return

    this.loadingMessages = true
    this.postState()
    try {
      const session = await client.createSession("VS Code chat")
      this.sessionID = session.id
      this.messages = []
      await this.refreshSessionList(client)
    } catch (error) {
      this.reportError("Failed to create remote session", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  async sendQuickQuestion(text: string, options: Partial<ChatContextOptions>) {
    await this.reveal()
    await this.sendMessage(text, this.contextOptions(options), [])
  }

  private async handleMessage(message: ChatViewMessage) {
    try {
      this.deps.output.appendLine(`[webview] ${message.type}`)
      switch (message.type) {
        case "ready":
          this.postState()
          break
        case "refresh":
        case "refreshSessions":
          await this.refresh()
          break
        case "openOutput":
          this.deps.openOutput()
          break
        case "newSession":
          await this.newSession()
          break
        case "addFile":
          await this.addFile()
          break
        case "clearContext":
          this.deps.contextStore.clear()
          this.postState()
          break
        case "selectSession":
          await this.selectSession(message.sessionID)
          break
        case "refreshModels":
          await this.refreshModels()
          break
        case "selectModel":
          await this.selectModel(message.model)
          break
        case "searchFilesForMention":
          await this.searchFilesForMention(message.query ?? "", message.requestId)
          break
        case "connectWithSettings":
          await this.connectWithSettings({
            serverUrl: message.serverUrl,
            username: message.username,
            password: message.password,
          })
          break
        case "testWithSettings":
          await this.testWithSettings({
            serverUrl: message.serverUrl,
            username: message.username,
            password: message.password,
          })
          break
        case "sendMessage":
          await this.sendMessage(
            message.text,
            this.contextOptions(message.options),
            this.mentionedFileUris(message.mentionedFiles ?? []),
          )
          break
      }
    } catch (error) {
      this.reportError(`OpenCode Remote action failed: ${message.type}`, error)
    }
  }

  private async connectWithSettings(input: ConnectionSettingsInput) {
    this.deps.output.appendLine(`[connect] requested URL: ${input.serverUrl}`)
    await this.deps.connectWithSettings({
      serverUrl: input.serverUrl,
      username: input.username,
      password: input.password,
    })
  }

  private async testWithSettings(input: ConnectionSettingsInput) {
    this.deps.output.appendLine(`[test] requested URL: ${input.serverUrl}`)
    await this.deps.testWithSettings({
      serverUrl: input.serverUrl,
      username: input.username,
      password: input.password,
    })
  }

  private async addFile() {
    const count = await addPickedFilesToContext(this.deps.contextStore)
    this.postState()
    if (count > 0) vscode.window.setStatusBarMessage(`Attached ${count} file(s) to OpenCode context`, 2000)
  }

  private async selectSession(sessionID: string) {
    const client = this.connectedClient("Connect before selecting a session.")
    if (!client || !sessionID) return

    this.sessionID = sessionID
    this.loadingMessages = true
    this.postState()
    try {
      await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        await this.recoverMissingSession(client, sessionID)
        return
      }
      this.reportError("Failed to load remote session", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  private async refreshModels() {
    const client = this.connectedClient("Connect before refreshing models.")
    if (!client) return
    await this.refreshModelList(client)
    this.postState()
  }

  private async selectModel(model: string) {
    const normalized = model.trim()
    if (normalized && !parseModel(normalized)) {
      this.modelError = "Model must be in provider/model format."
      this.postState()
      return
    }
    const config = vscode.workspace.getConfiguration("opencode.remote")
    await config.update("defaultModel", normalized, vscode.ConfigurationTarget.Global)
    this.modelError = ""
    this.deps.output.appendLine(`[model] selected ${normalized || "server default"}`)
    this.postState()
  }

  private async searchFilesForMention(query: string, requestId?: number) {
    this.view?.webview.postMessage({ type: "mentionStatus", requestId, query, status: "searching" })
    try {
      const index = await this.ensureMentionIndex()
      const files = searchMentionIndex(index.entries, query, 50)
      this.view?.webview.postMessage({
        type: "mentionResults",
        requestId,
        query,
        files,
        truncated: index.truncated,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[mention] search failed: ${message}`)
      this.view?.webview.postMessage({ type: "mentionResults", requestId, query, files: [], error: message })
    }
  }

  private async ensureMentionIndex() {
    if (this.mentionIndex) return this.mentionIndex
    if (!this.mentionIndexBuild) this.mentionIndexBuild = this.buildMentionIndex()
    this.mentionIndex = await this.mentionIndexBuild
    this.mentionIndexBuild = undefined
    return this.mentionIndex
  }

  private async buildMentionIndex(): Promise<MentionIndexState> {
    if (!vscode.workspace.workspaceFolders?.length) return { entries: [], truncated: false }

    const limit = 20000
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode-test/**}",
      limit + 1,
    )
    const truncated = files.length > limit
    const sourceFiles = files.slice(0, limit).map((uri) => ({
      uri: uri.toString(),
      label: relativePath(uri),
    }))
    const entries = buildMentionIndex(sourceFiles)
    this.deps.output.appendLine(
      `[mention] indexed ${sourceFiles.length} file(s), ${entries.filter((entry) => entry.type === "folder").length} folder(s)${
        truncated ? " (truncated)" : ""
      }`,
    )
    return { entries, truncated }
  }

  private async sendMessage(text: string, options: ChatContextOptions, mentionedFiles: vscode.Uri[]) {
    const trimmed = text.trim()
    if (!trimmed && mentionedFiles.length === 0) return

    const client = this.connectedClient("Connect to a remote OpenCode server before sending.")
    if (!client) return

    const optimistic = localMessage("user", trimmed || "Please review the referenced files.")
    this.messages = [...this.messages, optimistic]
    this.sending = true
    this.postState()
    let strictAgentHint = ""
    let preparedMessage: { text: string; model?: PromptModel; agent?: string } | undefined
    try {
      const settings = this.deps.getSettings()
      const agentSelection = this.agentForSettings(settings)
      const modelSelection = this.modelForSettings(settings)
      strictAgentHint = agentSelection.strict
        ? " If strict local-only agent is enabled, confirm the remote OpenCode server has that agent configured."
        : ""
      let contextSummary: ContextSummaryItem[] = []
      const prompt = await buildChatPrompt({
        question: trimmed || "Please review the referenced files.",
        options,
        settings,
        contextStore: this.deps.contextStore,
        mentionedFiles,
        editorContext: this.deps.getEditorContext(),
        onContextSummary: (items) => {
          contextSummary = items
          this.lastContextSummary = items
        },
      })
      this.lastContextSummary = contextSummary
      this.logContextSummary(contextSummary)
      this.deps.output.appendLine(`[agent] ${agentSelection.label}`)
      this.deps.output.appendLine(`[model] ${modelSelection.label}`)
      preparedMessage = {
        text: prompt,
        model: modelSelection.model,
        agent: agentSelection.agent,
      }
      await this.sendPreparedMessage(client, preparedMessage)
    } catch (error) {
      let finalError = error
      if (preparedMessage && isSessionNotFoundError(error)) {
        try {
          this.clearMissingSession(this.sessionID)
          this.deps.output.appendLine("[session] Selected remote session was not found; retrying with a new session.")
          await this.sendPreparedMessage(client, preparedMessage)
          return
        } catch (retryError) {
          finalError = retryError
        }
      }

      const rawMessage = finalError instanceof Error ? finalError.message : String(finalError)
      const message = strictAgentHint && looksLikeServerAgentError(rawMessage) ? `${rawMessage}${strictAgentHint}` : rawMessage
      if (error instanceof MissingLocalContextError || finalError instanceof MissingLocalContextError) {
        this.messages = this.messages.filter((messageItem) => messageItem.id !== optimistic.id)
        this.messages = [...this.messages, localMessage("error", message)]
        this.deps.output.appendLine(`[guard] blocked send: ${message}`)
        return
      }
      this.messages = [...this.messages, localMessage("error", `Failed to send message: ${message}`)]
      this.reportError("Failed to send message to remote OpenCode", new Error(message))
    } finally {
      this.sending = false
      this.postState()
    }
  }

  private async getOrCreateSession(client: RemoteOpenCodeClient) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession("VS Code chat")
    this.sessionID = session.id
    await this.refreshSessionList(client)
    return session.id
  }

  private async sendPreparedMessage(
    client: RemoteOpenCodeClient,
    input: { text: string; model?: PromptModel; agent?: string },
  ) {
    const sessionID = await this.getOrCreateSession(client)
    await client.sendMessage({
      sessionID,
      text: input.text,
      model: input.model,
      agent: input.agent,
    })
    await this.refreshSessionList(client)
    await this.loadSessionMessages(client, sessionID)
  }

  private async refreshSessionList(client: RemoteOpenCodeClient) {
    const sessions = await client.listSessions()
    this.sessions = sessions.map((session) => renderSession(session, this.flaggedSessions.has(session.id)))
  }

  private reconcileSessionSelection() {
    if (this.sessionID && this.sessions.some((session) => session.id === this.sessionID)) return
    if (this.sessionID) {
      this.deps.output.appendLine(`[session] Remote session ${this.sessionID} is no longer available; clearing selection.`)
    }
    this.sessionID = this.sessions[0]?.id
    if (!this.sessionID) this.messages = []
  }

  private async loadSelectedSessionMessages(client: RemoteOpenCodeClient) {
    if (!this.sessionID) {
      this.messages = []
      return
    }

    try {
      await this.loadSessionMessages(client, this.sessionID)
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      await this.recoverMissingSession(client, this.sessionID)
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID)
    }
  }

  private async recoverMissingSession(client: RemoteOpenCodeClient, sessionID: string) {
    this.clearMissingSession(sessionID)
    this.deps.output.appendLine(`[session] Remote session ${sessionID} was not found; refreshing sessions.`)
    await this.refreshSessionList(client)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    this.reconcileSessionSelection()
  }

  private clearMissingSession(sessionID: string | undefined) {
    if (sessionID && this.sessionID && this.sessionID !== sessionID) return
    this.sessionID = undefined
    this.messages = []
  }

  private async loadSessionMessages(client: RemoteOpenCodeClient, sessionID: string) {
    const messages = await client.getMessages(sessionID)
    this.messages = messages.map(renderMessage).filter((message) => message.text || message.parts.length > 0)
    const serverToolWarnings = this.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "serverToolWarning").map((part) => part.title || "tool"),
    )
    if (serverToolWarnings.length > 0) {
      this.flaggedSessions.add(sessionID)
      this.sessions = this.sessions.map((session) =>
        session.id === sessionID ? { ...session, serverToolsUsed: true } : session,
      )
      this.deps.output.appendLine(`[guard] remote server tools used in ${sessionID}: ${serverToolWarnings.join(", ")}`)
    }
  }

  private async refreshModelList(client: RemoteOpenCodeClient) {
    this.loadingModels = true
    this.modelError = ""
    this.postState()
    try {
      this.models = await client.listModels()
      this.deps.output.appendLine(`[model] loaded ${this.models.length} model(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modelError = `Failed to load models: ${message}`
      this.deps.output.appendLine(`[model] ${this.modelError}`)
    } finally {
      this.loadingModels = false
    }
  }

  private connectedClient(message: string) {
    const client = this.deps.getClient()
    if (client && this.connectionState === "connected") return client
    this.deps.setConnectionState("disconnected", message)
    return undefined
  }

  private contextOptions(input: Partial<ChatContextOptions> = {}): ChatContextOptions {
    const settings = this.deps.getSettings()
    return {
      includeSelection: input.includeSelection ?? true,
      includeCurrentFile: input.includeCurrentFile ?? true,
      includeOpenFiles: input.includeOpenFiles ?? false,
      includeDiagnostics: input.includeDiagnostics ?? settings.context.includeDiagnostics,
      includeGitDiff: input.includeGitDiff ?? settings.context.includeGitDiff,
    }
  }

  private agentForSettings(settings: RemoteSettings) {
    const defaultAgent = settings.defaultAgent.trim()
    const localOnlyAgent = settings.localOnlyAgent.trim()
    if (settings.context.localOnlyMode && settings.context.strictLocalOnlyAgent && localOnlyAgent) {
      return {
        agent: localOnlyAgent,
        strict: true,
        label: `strict local-only agent: ${localOnlyAgent}`,
      }
    }
    if (defaultAgent) {
      return {
        agent: defaultAgent,
        strict: false,
        label: `default agent: ${defaultAgent}`,
      }
    }
    return {
      agent: undefined,
      strict: false,
      label: "no agent override",
    }
  }

  private modelForSettings(settings: RemoteSettings) {
    const selected = settings.defaultModel.trim()
    return {
      model: parseModel(selected),
      label: selected || "server default",
    }
  }

  private mentionedFileUris(files: MentionedFileRef[]) {
    const result: vscode.Uri[] = []
    const seen = new Set<string>()
    for (const file of files) {
      try {
        if (file.type === "folder") continue
        const uri = vscode.Uri.parse(file.uri)
        if (uri.scheme !== "file") continue
        if (!vscode.workspace.getWorkspaceFolder(uri)) continue
        const key = uri.toString()
        if (seen.has(key)) continue
        seen.add(key)
        result.push(uri)
      } catch {
        this.deps.output.appendLine(`[mention] skipped invalid URI: ${file.uri}`)
      }
    }
    return result
  }

  private postState() {
    const settings = this.deps.getSettings()
    this.view?.webview.postMessage({
      type: "state",
      state: {
        connectionState: this.connectionState,
        connectionDetail: this.connectionDetail,
        serverUrl: settings.serverUrl,
        username: settings.username,
        defaults: {
          includeDiagnostics: settings.context.includeDiagnostics,
          includeGitDiff: settings.context.includeGitDiff,
        },
        localOnlyMode: settings.context.localOnlyMode,
        localOnlyAgent: settings.localOnlyAgent,
        strictLocalOnlyAgent: settings.context.strictLocalOnlyAgent,
        selectedModel: settings.defaultModel,
        models: this.models,
        loadingModels: this.loadingModels,
        modelError: this.modelError,
        localOnlyWarning:
          settings.context.localOnlyMode && settings.context.strictLocalOnlyAgent && !settings.localOnlyAgent.trim()
            ? "Strict local-only agent mode is on, but no local-only agent name is configured."
            : "",
        contextFiles: this.deps.contextStore.labels(),
        lastContextSummary: this.lastContextSummary,
        autoContext: this.autoContextState(),
        sessions: this.sessions,
        currentSessionID: this.sessionID,
        messages: this.messages,
        sending: this.sending,
        loadingMessages: this.loadingMessages,
      },
    })
  }

  private reportError(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.output.appendLine(`${prefix}: ${message}`)
    this.deps.setConnectionState("error", `${prefix}: ${message}`)
  }

  private autoContextState() {
    const editorContext = this.deps.getEditorContext()
    return {
      currentFile: editorContext ? relativePath(editorContext.uri) : "",
      hasSelection: Boolean(editorContext && !editorContext.selection.isEmpty),
    }
  }

  private logContextSummary(items: ContextSummaryItem[]) {
    if (items.length === 0) {
      this.deps.output.appendLine("[context] sent no local file content")
      return
    }
    const summary = items
      .map((item) => `${item.source}:${item.path}${item.truncated ? ":truncated" : ""}${item.skipped ? ":skipped" : ""}`)
      .join(", ")
    this.deps.output.appendLine(`[context] sent ${summary}`)
  }
}

function renderSession(session: OpenCodeSession, serverToolsUsed = false): RenderedSession {
  return {
    id: session.id,
    title: session.title?.trim() || "Untitled chat",
    created: session.time?.created,
    updated: session.time?.updated ?? session.time?.created,
    serverToolsUsed,
  }
}

function renderMessage(message: OpenCodeMessage): RenderedMessage {
  const error = message.info.error?.message
  if (error) {
    return {
      id: message.info.id,
      role: "error",
      text: error,
      timeCreated: message.info.time?.created,
      timeCompleted: message.info.time?.completed,
      parts: [{ type: "error", text: error }],
      error,
    }
  }

  const split = splitThinkingFromParts(message.parts)
  const parts = message.parts
    .filter((part) => part.type !== "text" && part.type !== "reasoning")
    .map(renderPart)
    .filter((part) => part.text || part.detail || part.status)
  if (split.reasoning) {
    parts.unshift({
      type: "reasoning",
      title: "Thinking",
      detail: split.reasoning,
    })
  }
  const serverToolWarnings = parts
    .filter((part) => part.type === "tool" && isServerFilesystemTool(part.title))
    .map((part) => ({
      type: "serverToolWarning",
      title: part.title,
      detail: `Remote server filesystem tool used: ${part.title}. This reply may have used code from the OpenCode server instead of VS Code local context.`,
    }))
  parts.push(...serverToolWarnings)
  const rawText = split.text
  const hasTool = parts.some((part) => part.type === "tool")
  const role = rawText ? (message.info.role ?? "message") : hasTool ? "tool" : (message.info.role ?? "message")
  return {
    id: message.info.id,
    role,
    text: displayText(role, rawText),
    timeCreated: message.info.time?.created,
    timeCompleted: message.info.time?.completed,
    parts,
    serverToolsUsed: serverToolWarnings.length > 0,
  }
}

function renderPart(part: OpenCodePart): RenderedPart {
  if (part.type === "text" && "text" in part && typeof part.text === "string") {
    return {
      type: part.type,
      text: part.text,
    }
  }
  if (part.type === "tool") {
    return {
      type: "tool",
      title: "tool" in part && typeof part.tool === "string" ? part.tool : "tool",
      status: toolStatus(part),
      detail: toolDetail(part),
    }
  }
  return {
    type: part.type,
    text: "",
  }
}

function displayText(role: string, text: string) {
  if (role !== "user") return text
  const questionPrefix = "User question:\n"
  if (!text.startsWith(questionPrefix)) return text
  const body = text.slice(questionPrefix.length)
  const markers = ["\n\nLocal Context Contract:", "\n\nImportant local-context rule:", "\n\nLocal workspace context:"]
  const markerIndex = markers
    .map((marker) => body.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0]
  const question = markerIndex === undefined ? body : body.slice(0, markerIndex)
  return question.trim()
}

function localMessage(role: string, text: string): RenderedMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    timeCreated: Date.now(),
    parts: [{ type: "text", text }],
  }
}

function toolStatus(part: OpenCodePart) {
  const state = toolState(part)
  if (typeof state?.status === "string") return state.status
  if (state?.error) return "error"
  return "called"
}

function toolDetail(part: OpenCodePart) {
  const state = toolState(part)
  const detail = {
    input: state?.input,
    output: state?.output,
    error: state?.error,
    metadata: state?.metadata,
  }
  return truncate(JSON.stringify(detail, null, 2), 4000)
}

function toolState(part: OpenCodePart) {
  if (!("state" in part)) return undefined
  if (!part.state || typeof part.state !== "object") return undefined
  return part.state as {
    status?: unknown
    input?: unknown
    output?: unknown
    error?: unknown
    metadata?: unknown
  }
}

const SERVER_FILESYSTEM_TOOLS = new Set(["read", "glob", "grep", "list", "bash", "edit", "write", "patch", "multiedit", "external_directory", "lsp"])

function isServerFilesystemTool(tool: string | undefined) {
  if (!tool) return false
  return SERVER_FILESYSTEM_TOOLS.has(tool.toLowerCase())
}

function looksLikeServerAgentError(message: string) {
  return /UnknownError|unknown agent|agent|4\d\d|5\d\d|request failed|internal server error/i.test(message)
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}
