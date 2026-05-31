import * as vscode from "vscode"
import { agentListSummary } from "./agent-name"
import { createChatViewHtml } from "./chat-html"
import { CHAT_SESSION_TITLE, isPluginChatMessage, isPluginChatSession } from "./chat-session"
import { applyOpenCodeEventToMessages, normalizeOpenCodeEvent } from "./chat-stream"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { CodeIntelligenceSnapshot } from "./analysis-types"
import { isInlineCompletionMessage, isInlineCompletionSession } from "./completion-session"
import {
  addPickedFilesToContext,
  buildChatPrompt,
  type ContextSummaryItem,
  LocalContextStore,
  MissingLocalContextError,
  relativePath,
} from "./context"
import type { TrackedEditorContext } from "./editor-context"
import { MissingLocalOnlyAgentError, selectRequestAgent } from "./local-agent"
import { buildMentionIndex, searchMentionIndex, type MentionIndexEntry } from "./mention-index"
import {
  isSessionNotFoundError,
  parseModel,
  RemoteOpenCodeAuthError,
  RemoteOpenCodeClient,
  RemoteOpenCodeConnectionError,
} from "./remote-client"
import { splitThinkingFromParts } from "./thinking"
import { summarizeSessionUsage, usageFromMessageInfo } from "./usage"
import type {
  ChatContextOptions,
  ConnectionState,
  OpenCodeAgentInfo,
  OpenCodeMessage,
  OpenCodeModelInfo,
  OpenCodePart,
  OpenCodeSession,
  PromptModel,
  CodeGraphStatus,
  RenderedUsage,
  RemoteSettings,
} from "./types"
import type { ConnectionSettingsInput } from "./settings"

const SESSION_MESSAGE_LIMIT = 100
const MODEL_REFRESH_TIMEOUT_MS = 8000
const AGENT_REFRESH_TIMEOUT_MS = 8000
const SESSION_REFRESH_TIMEOUT_MS = 8000
const MESSAGE_REFRESH_TIMEOUT_MS = 5000

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
  | { type: "indexCodeGraph" }
  | { type: "rebuildCodeGraph" }
  | { type: "pauseCodeGraph" }
  | { type: "resumeCodeGraph" }
  | { type: "cancelCodeGraph" }
  | { type: "showCodeGraphStatus" }
  | { type: "refreshCodeIntelligence" }
  | { type: "openEvidence"; path: string; line?: number }
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
  usage?: RenderedUsage
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
  codeGraph?: CodeGraphContextProvider
  getClient: () => RemoteOpenCodeClient | undefined
  getSettings: () => RemoteSettings
  getEditorContext: () => TrackedEditorContext | undefined
  connectWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  testWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  setConnectionState: (state: ConnectionState, detail?: string) => void
  clearClient: (client: RemoteOpenCodeClient) => void
  openOutput: () => void
}

export class RemoteChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "opencodeRemote.sidebar"

  private view?: vscode.WebviewView
  private sessionID?: string
  private sessions: RenderedSession[] = []
  private messages: RenderedMessage[] = []
  private remoteMessages: OpenCodeMessage[] = []
  private connectionState: ConnectionState = "disconnected"
  private connectionDetail = "Ready. Enter a server URL and click Connect."
  private sending = false
  private loadingMessages = false
  private loadingModels = false
  private loadingAgents = false
  private models: OpenCodeModelInfo[] = []
  private agents: OpenCodeAgentInfo[] = []
  private modelError = ""
  private agentError = ""
  private historyError = ""
  private codeGraphWaitDetail = ""
  private codeIntelligence?: CodeIntelligenceSnapshot
  private loadingCodeIntelligence = false
  private codeIntelligenceError = ""
  private lastContextSummary: ContextSummaryItem[] = []
  private readonly flaggedSessions = new Set<string>()
  private readonly hiddenCompletionSessions = new Set<string>()
  private readonly hiddenExternalSessions = new Set<string>()
  private mentionIndex?: MentionIndexState
  private mentionIndexBuild?: Promise<MentionIndexState>
  private eventSubscription?: {
    client: RemoteOpenCodeClient
    controller: AbortController
    ready: Promise<boolean>
  }
  private eventStreamReady = false
  private eventStreamFailed = false
  private readonly finalizingSessions = new Set<string>()
  private readonly pendingLocalUserMessageIDs = new Set<string>()
  private readonly pendingLocalUserTexts = new Set<string>()

  constructor(private readonly deps: RemoteChatViewProviderDeps) {}

  dispose() {
    this.stopEventSubscription()
  }

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
    if (state !== "connected") this.stopEventSubscription()
    this.postState()
  }

  async refresh() {
    const client = this.deps.getClient()
    if (!client || this.connectionState !== "connected") {
      this.stopEventSubscription()
      this.postState()
      return
    }

    this.loadingMessages = true
    this.historyError = ""
    this.postState()
    try {
      void this.ensureEventSubscription(client)
      const [, , sessionResult] = await Promise.allSettled([
        this.refreshModelList(client),
        this.refreshAgentList(client),
        this.refreshSessionList(client),
      ])
      if (sessionResult.status === "rejected") {
        this.reportRemoteConnectionFailure(client, "Failed to load sessions", sessionResult.reason)
        return
      }
      this.reconcileSessionSelection()
      try {
        await this.loadSelectedSessionMessages(client)
      } catch (error) {
        this.reportRemoteConnectionFailure(client, "Failed to load selected session", error)
      }
    } catch (error) {
      this.reportRemoteConnectionFailure(client, "Failed to refresh remote chat", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  refreshCodeGraphStatus() {
    if (this.codeGraphWaitDetail) {
      const status = this.deps.codeGraph?.status()
      if (status) this.codeGraphWaitDetail = codeGraphWaitDetail(status)
    }
    this.postState()
  }

  private ensureEventSubscription(client: RemoteOpenCodeClient) {
    const current = this.eventSubscription
    if (current?.client === client && !current.controller.signal.aborted) {
      if (this.eventStreamReady) return Promise.resolve(true)
      if (this.eventStreamFailed) return Promise.resolve(false)
      return current.ready
    }

    this.stopEventSubscription()
    this.eventStreamReady = false
    this.eventStreamFailed = false

    const controller = new AbortController()
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    let resolveReady: (ready: boolean) => void = () => undefined
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve
    })
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveReady(value)
    }
    timer = setTimeout(() => {
      this.eventStreamFailed = true
      if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
      controller.abort()
      settle(false)
    }, 1500)

    this.eventSubscription = { client, controller, ready }
    void client
      .subscribeEvents(
        (event) => this.handleRemoteEvent(client, event),
        controller.signal,
        () => {
          this.eventStreamReady = true
          this.eventStreamFailed = false
          this.deps.output.appendLine(`[event] connected ${client.baseUrl}`)
          settle(true)
        },
      )
      .then(() => {
        if (controller.signal.aborted) return
        this.eventStreamReady = false
        this.eventStreamFailed = true
        if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
        settle(false)
        this.deps.output.appendLine("[event] stream closed")
        this.finishActiveStreamAfterEventLoss(client)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        this.eventStreamReady = false
        this.eventStreamFailed = true
        if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
        settle(false)
        const message = error instanceof Error ? error.message : String(error)
        this.deps.output.appendLine(`[event] stream failed: ${message}`)
        this.finishActiveStreamAfterEventLoss(client)
      })

    return ready
  }

  private stopEventSubscription() {
    this.eventSubscription?.controller.abort()
    this.eventSubscription = undefined
    this.eventStreamReady = false
    this.eventStreamFailed = false
  }

  private handleRemoteEvent(client: RemoteOpenCodeClient, rawEvent: unknown) {
    if (this.deps.getClient() !== client) return
    const event = normalizeOpenCodeEvent(rawEvent)
    if (!event || event.type === "server.connected") return

    const result = applyOpenCodeEventToMessages(this.remoteMessages, event, this.sessionID)
    if (result.refreshSessions) {
      void this.refreshSessionList(client)
        .then(() => this.postState())
        .catch((error) => this.logEventError("session refresh failed", error))
    }
    if (result.changed) {
      this.remoteMessages = result.messages
      this.syncRenderedMessages()
      this.postState()
    }
    if (result.error) {
      this.messages = [...this.messages, localMessage("error", `Remote session error: ${result.error}`)]
      this.sending = false
      this.postState()
    }

    const sessionID = this.sessionID
    if (sessionID && (result.idle || result.completed)) {
      void this.finishStreamingSession(client, sessionID)
    }
  }

  private finishActiveStreamAfterEventLoss(client: RemoteOpenCodeClient) {
    if (!this.sending || !this.sessionID) return
    void this.finishStreamingSession(client, this.sessionID)
  }

  private async finishStreamingSession(client: RemoteOpenCodeClient, sessionID: string) {
    if (this.finalizingSessions.has(sessionID)) return
    this.finalizingSessions.add(sessionID)
    try {
      if (this.deps.getClient() !== client) return
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("final message refresh failed", error)
    } finally {
      this.finalizingSessions.delete(sessionID)
      if (this.sessionID === sessionID) {
        this.sending = false
        this.postState()
      }
    }
  }

  private syncRenderedMessages() {
    const renderedRemote = this.remoteMessages.map(renderMessage).filter((message) => message.text || message.parts.length > 0)
    if (renderedRemote.some((message) => message.role === "user" && this.pendingLocalUserTexts.has(message.text))) {
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
    }
    const pendingLocal = this.messages.filter((message) => this.pendingLocalUserMessageIDs.has(message.id))
    this.messages = [...renderedRemote, ...pendingLocal].sort((left, right) => (left.timeCreated ?? 0) - (right.timeCreated ?? 0))
    if (this.sessionID) this.applyServerToolWarnings(this.sessionID)
  }

  private applyServerToolWarnings(sessionID: string) {
    const serverToolWarnings = this.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "serverToolWarning").map((part) => part.title || "tool"),
    )
    if (serverToolWarnings.length === 0) return

    const alreadyFlagged = this.flaggedSessions.has(sessionID)
    this.flaggedSessions.add(sessionID)
    this.sessions = this.sessions.map((session) =>
      session.id === sessionID ? { ...session, serverToolsUsed: true } : session,
    )
    if (!alreadyFlagged) {
      this.deps.output.appendLine(`[guard] remote server tools used in ${sessionID}: ${serverToolWarnings.join(", ")}`)
    }
  }

  private logEventError(action: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.output.appendLine(`[event] ${action}: ${message}`)
  }

  async newSession() {
    const client = this.connectedClient("Connect before creating a session.")
    if (!client) return

    this.loadingMessages = true
    this.postState()
    try {
      const session = await client.createSession(CHAT_SESSION_TITLE)
      this.sessionID = session.id
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
      await this.refreshSessionList(client)
    } catch (error) {
      this.reportRemoteConnectionFailure(client, "Failed to create remote session", error)
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
        case "indexCodeGraph":
          await this.indexCodeGraph(false)
          break
        case "rebuildCodeGraph":
          await this.indexCodeGraph(true)
          break
        case "pauseCodeGraph":
          this.deps.codeGraph?.pauseIndexing("requested from Code Intelligence UI")
          this.postState()
          break
        case "resumeCodeGraph":
          this.deps.codeGraph?.resumeIndexing()
          this.postState()
          break
        case "cancelCodeGraph":
          this.deps.codeGraph?.cancelIndexing("requested from Code Intelligence UI")
          this.postState()
          break
        case "showCodeGraphStatus":
          await this.showCodeGraphStatus()
          break
        case "refreshCodeIntelligence":
          await this.refreshCodeIntelligence()
          break
        case "openEvidence":
          await this.openEvidence(message.path, message.line)
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

  private async indexCodeGraph(force: boolean) {
    if (!this.deps.codeGraph) {
      vscode.window.showWarningMessage("Local code graph is not available in this OpenCode Remote view.")
      return
    }
    await this.deps.codeGraph.indexWorkspace(force)
    this.postState()
  }

  private async showCodeGraphStatus() {
    if (!this.deps.codeGraph) {
      vscode.window.showWarningMessage("Local code graph is not available in this OpenCode Remote view.")
      return
    }
    await this.deps.codeGraph.showStatus()
    this.postState()
  }

  private async refreshCodeIntelligence() {
    if (this.loadingCodeIntelligence) {
      this.postState()
      return
    }
    if (!this.deps.codeGraph) {
      this.codeIntelligenceError = "Local code intelligence is not available in this OpenCode Remote view."
      vscode.window.showWarningMessage("Local code intelligence is not available in this OpenCode Remote view.")
      this.postState()
      return
    }
    this.loadingCodeIntelligence = true
    this.codeIntelligenceError = ""
    this.postState()
    try {
      this.codeIntelligence = await this.deps.codeGraph.intelligenceSnapshot()
      this.codeIntelligenceError = ""
      this.deps.output.appendLine(
        `[analysis] snapshot modules=${this.codeIntelligence?.modules.length ?? 0} stateMachines=${this.codeIntelligence?.stateMachines.length ?? 0}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.codeIntelligenceError = message
      this.deps.output.appendLine(`[analysis] snapshot failed: ${message}`)
      vscode.window.showErrorMessage(`Local code intelligence failed: ${message}`)
    } finally {
      this.loadingCodeIntelligence = false
      this.postState()
    }
  }

  private async openEvidence(path: string, line = 1) {
    const root = vscode.workspace.workspaceFolders?.[0]
    if (!root) return
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!normalized || normalized.split("/").includes("..")) {
      vscode.window.showWarningMessage("Evidence path is outside the workspace.")
      return
    }
    const uri = vscode.Uri.joinPath(root.uri, ...normalized.split("/"))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(Math.max(0, line - 1), 0)
    editor.selection = new vscode.Selection(position, position)
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
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
        try {
          await this.recoverMissingSession(client, sessionID)
        } catch (recoverError) {
          this.reportRemoteConnectionFailure(client, "Failed to recover remote session", recoverError)
        }
        return
      }
      this.reportRemoteConnectionFailure(client, "Failed to load remote session", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  private async refreshModels() {
    const client = this.connectedClient("Connect before refreshing models.")
    if (!client) return
    await Promise.allSettled([this.refreshModelList(client), this.refreshAgentList(client)])
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
    this.pendingLocalUserMessageIDs.add(optimistic.id)
    this.pendingLocalUserTexts.add(optimistic.text)
    this.sending = true
    this.postState()
    let strictAgentHint = ""
    let preparedMessage: { text: string; model?: PromptModel; agent?: string } | undefined
    let sentStreaming = false
    try {
      const settings = this.deps.getSettings()
      await this.ensureAgentList(client, settings)
      const agentSelection = this.agentForSettings(settings)
      if (!agentSelection.ready) {
        throw new MissingLocalOnlyAgentError(agentSelection.warning ?? "Required VS Code local agent is not available.")
      }
      const modelSelection = this.modelForSettings(settings)
      strictAgentHint = agentSelection.strict
        ? " Confirm the remote OpenCode server has the required VS Code local agent configured."
        : ""
      await this.waitForCodeGraphReady(settings)
      let contextSummary: ContextSummaryItem[] = []
      const prompt = await buildChatPrompt({
        question: trimmed || "Please review the referenced files.",
        options,
        settings,
        contextStore: this.deps.contextStore,
        mentionedFiles,
        editorContext: this.deps.getEditorContext(),
        codeGraph: this.deps.codeGraph,
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
      sentStreaming = await this.sendPreparedMessage(client, preparedMessage)
    } catch (error) {
      let finalError = error
      if (preparedMessage && isSessionNotFoundError(error)) {
        try {
          this.clearMissingSession(this.sessionID)
          this.deps.output.appendLine("[session] Selected remote session was not found; retrying with a new session.")
          sentStreaming = await this.sendPreparedMessage(client, preparedMessage)
          return
        } catch (retryError) {
          finalError = retryError
        }
      }

      const rawMessage = finalError instanceof Error ? finalError.message : String(finalError)
      const message = strictAgentHint && looksLikeServerAgentError(rawMessage) ? `${rawMessage}${strictAgentHint}` : rawMessage
      if (
        error instanceof MissingLocalContextError ||
        finalError instanceof MissingLocalContextError ||
        error instanceof MissingLocalOnlyAgentError ||
        finalError instanceof MissingLocalOnlyAgentError
      ) {
        this.messages = this.messages.filter((messageItem) => messageItem.id !== optimistic.id)
        this.pendingLocalUserMessageIDs.delete(optimistic.id)
        this.pendingLocalUserTexts.delete(optimistic.text)
        this.messages = [...this.messages, localMessage("error", message)]
        this.deps.output.appendLine(`[guard] blocked send: ${message}`)
        return
      }
      if (error instanceof CodeGraphReadinessError || finalError instanceof CodeGraphReadinessError) {
        this.messages = this.messages.filter((messageItem) => messageItem.id !== optimistic.id)
        this.pendingLocalUserMessageIDs.delete(optimistic.id)
        this.pendingLocalUserTexts.delete(optimistic.text)
        this.messages = [...this.messages, localMessage("error", message)]
        this.deps.output.appendLine(`[codegraph] blocked send: ${message}`)
        return
      }
      this.pendingLocalUserMessageIDs.delete(optimistic.id)
      this.pendingLocalUserTexts.delete(optimistic.text)
      this.messages = [...this.messages, localMessage("error", `Failed to send message: ${message}`)]
      this.reportRemoteConnectionFailure(client, "Failed to send message to remote OpenCode", finalError, message)
    } finally {
      this.codeGraphWaitDetail = ""
      if (!sentStreaming) this.sending = false
      this.postState()
    }
  }

  private async waitForCodeGraphReady(settings: RemoteSettings) {
    if (!settings.codeGraph.enabled || !this.deps.codeGraph) return

    const status = this.deps.codeGraph.status()
    if (status.state === "ready") return
    if (status.state === "error") throw new CodeGraphReadinessError(codeGraphErrorMessage(status))
    if (status.state !== "indexing" && status.state !== "stale" && status.state !== "disabled") return

    this.codeGraphWaitDetail = codeGraphWaitDetail(status)
    this.deps.output.appendLine(`[codegraph] ${this.codeGraphWaitDetail}`)
    this.postState()
    try {
      await this.deps.codeGraph.waitForReady()
    } catch (error) {
      throw new CodeGraphReadinessError(codeGraphErrorMessage(this.deps.codeGraph.status(), error))
    }

    const next = this.deps.codeGraph.status()
    if (next.state === "ready") return
    throw new CodeGraphReadinessError(codeGraphErrorMessage(next))
  }

  private async getOrCreateSession(client: RemoteOpenCodeClient) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession(CHAT_SESSION_TITLE)
    this.sessionID = session.id
    await this.refreshSessionList(client)
    return session.id
  }

  private async sendPreparedMessage(
    client: RemoteOpenCodeClient,
    input: { text: string; model?: PromptModel; agent?: string },
  ) {
    const sessionID = await this.getOrCreateSession(client)
    const canStream = await this.ensureEventSubscription(client)
    if (canStream) {
      await client.sendMessageAsync({
        sessionID,
        text: input.text,
        model: input.model,
        agent: input.agent,
      })
      await this.refreshSessionList(client)
      return true
    }

    this.deps.output.appendLine("[event] live stream unavailable; falling back to blocking message request")
    await client.sendMessage({
      sessionID,
      text: input.text,
      model: input.model,
      agent: input.agent,
    })
    await this.refreshSessionList(client)
    await this.loadSessionMessages(client, sessionID)
    return false
  }

  private async refreshSessionList(client: RemoteOpenCodeClient) {
    const started = Date.now()
    const sessions = await withRequestTimeout("session list", SESSION_REFRESH_TIMEOUT_MS, (signal) => client.listSessions(signal))
    this.sessions = sessions
      .filter((session) => this.isVisibleChatSession(session))
      .map((session) => renderSession(session, this.flaggedSessions.has(session.id)))
    this.historyError = ""
    this.deps.output.appendLine(`[refresh] sessions ${Date.now() - started}ms`)
  }

  private reconcileSessionSelection() {
    if (this.sessionID && this.sessions.some((session) => session.id === this.sessionID)) return
    if (this.sessionID) {
      this.deps.output.appendLine(`[session] Remote session ${this.sessionID} is no longer available; clearing selection.`)
    }
    this.sessionID = this.sessions[0]?.id
    if (!this.sessionID) {
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
    }
  }

  private async loadSelectedSessionMessages(client: RemoteOpenCodeClient) {
    if (!this.sessionID) {
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
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
    this.remoteMessages = []
    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    this.messages = []
  }

  private async loadSessionMessages(client: RemoteOpenCodeClient, sessionID: string) {
    const started = Date.now()
    const messages = await withRequestTimeout("session messages", MESSAGE_REFRESH_TIMEOUT_MS, (signal) =>
      client.getMessages(sessionID, SESSION_MESSAGE_LIMIT, signal),
    )
    this.deps.output.appendLine(`[refresh] messages ${Date.now() - started}ms`)
    if (messages.some(isInlineCompletionMessage)) {
      await this.hideCompletionSession(client, sessionID)
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID)
      return
    }
    if (messages.some(isExternalChatMessage)) {
      await this.hideExternalSession(client, sessionID)
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID)
      return
    }

    this.remoteMessages = messages
    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    this.messages = messages.map(renderMessage).filter((message) => message.text || message.parts.length > 0)
    this.applyServerToolWarnings(sessionID)
  }

  private async hideCompletionSession(client: RemoteOpenCodeClient, sessionID: string) {
    this.hiddenCompletionSessions.add(sessionID)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
    }
    this.deps.output.appendLine(`[history] Hidden inline completion session ${sessionID}.`)
    await this.refreshSessionList(client)
    this.reconcileSessionSelection()
  }

  private async hideExternalSession(client: RemoteOpenCodeClient, sessionID: string) {
    this.hiddenExternalSessions.add(sessionID)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
    }
    this.deps.output.appendLine(`[history] Hidden external OpenCode session ${sessionID}.`)
    await this.refreshSessionList(client)
    this.reconcileSessionSelection()
  }

  private isVisibleChatSession(session: OpenCodeSession) {
    if (this.hiddenCompletionSessions.has(session.id)) return false
    if (this.hiddenExternalSessions.has(session.id)) return false
    if (isInlineCompletionSession(session)) return false
    return isPluginChatSession(session)
  }

  private async refreshModelList(client: RemoteOpenCodeClient) {
    this.loadingModels = true
    this.modelError = ""
    this.postState()
    const started = Date.now()
    try {
      this.models = await withRequestTimeout("model list", MODEL_REFRESH_TIMEOUT_MS, (signal) => client.listModels(signal))
      this.deps.output.appendLine(`[model] loaded ${this.models.length} model(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modelError = `Failed to load models: ${message}`
      this.deps.output.appendLine(`[model] ${this.modelError}`)
    } finally {
      this.loadingModels = false
      this.deps.output.appendLine(`[refresh] models ${Date.now() - started}ms`)
    }
  }

  private async refreshAgentList(client: RemoteOpenCodeClient) {
    this.loadingAgents = true
    this.agentError = ""
    this.postState()
    const started = Date.now()
    try {
      this.agents = await withRequestTimeout("agent list", AGENT_REFRESH_TIMEOUT_MS, (signal) => client.listAgents(signal))
      this.deps.output.appendLine(`[agent] loaded: ${agentListSummary(this.agents)}`)
      const selection = this.agentForSettings(this.deps.getSettings())
      if (!selection.ready && selection.warning) this.deps.output.appendLine(`[agent] ${selection.warning}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.agents = []
      this.agentError = `Failed to load agents: ${message}`
      this.deps.output.appendLine(`[agent] ${this.agentError}`)
    } finally {
      this.loadingAgents = false
      this.deps.output.appendLine(`[refresh] agents ${Date.now() - started}ms`)
    }
  }

  private async ensureAgentList(client: RemoteOpenCodeClient, settings: RemoteSettings) {
    if (!settings.context.localOnlyMode) return
    if (this.agents.length > 0 && !this.agentError) return
    await this.refreshAgentList(client)
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
    return selectRequestAgent({
      settings,
      agents: this.agents,
      agentError: this.agentError,
    })
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
    const agentSelection = this.agentForSettings(settings)
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
        selectedAgent: agentSelection.agent,
        agentReady: agentSelection.ready,
        agents: this.agents,
        loadingAgents: this.loadingAgents,
        agentError: this.agentError,
        selectedModel: settings.defaultModel,
        models: this.models,
        loadingModels: this.loadingModels,
        modelError: this.modelError,
        historyError: this.historyError,
        localOnlyWarning: settings.context.localOnlyMode ? agentSelection.warning ?? "" : "",
        contextFiles: this.deps.contextStore.labels(),
        codeGraph: this.deps.codeGraph?.status(),
        codeGraphWaitDetail: this.codeGraphWaitDetail,
        codeIntelligence: this.codeIntelligence,
        loadingCodeIntelligence: this.loadingCodeIntelligence,
        codeIntelligenceError: this.codeIntelligenceError,
        lastContextSummary: this.lastContextSummary,
        autoContext: this.autoContextState(),
        usage: summarizeSessionUsage({
          messages: this.remoteMessages,
          models: this.models,
          selectedModel: settings.defaultModel,
          loadedMessageLimit: SESSION_MESSAGE_LIMIT,
        }),
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

  private reportRemoteConnectionFailure(
    client: RemoteOpenCodeClient,
    prefix: string,
    error: unknown,
    detailMessage = formatErrorMessage(error),
  ) {
    const detail = `${prefix}: ${detailMessage}`
    const state = connectionFailureState(error)
    this.historyError = detail
    this.deps.output.appendLine(`[history] ${detail}`)
    this.deps.clearClient(client)
    this.deps.setConnectionState(state, detail)
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

async function withRequestTimeout<T>(
  label: string,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await task(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function connectionFailureState(error: unknown): ConnectionState {
  if (error instanceof RemoteOpenCodeAuthError) return "authFailed"
  if (error instanceof RemoteOpenCodeConnectionError || isRequestTimeoutError(error)) return "error"
  return "error"
}

function isRequestTimeoutError(error: unknown) {
  return error instanceof Error && /\btimed out after \d+ms\b/i.test(error.message)
}

class CodeGraphReadinessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodeGraphReadinessError"
  }
}

function codeGraphWaitDetail(status: CodeGraphStatus) {
  const progress = status.progress?.total
    ? ` ${status.progress.completed}/${status.progress.total} file(s)`
    : ""
  const detail = status.detail ? ` ${status.detail}` : ""
  return `Waiting for code graph indexing${progress}.${detail}`.trim()
}

function codeGraphErrorMessage(status: CodeGraphStatus, cause?: unknown) {
  const causeMessage = cause ? formatErrorMessage(cause) : ""
  const detail = status.detail || causeMessage || "Local code graph indexing failed."
  return `Local code graph is not ready: ${detail} Rebuild the local code graph or disable opencode.remote.codeGraph.enabled before sending.`
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
  const usage = usageFromMessageInfo(message.info)
  return {
    id: message.info.id,
    role,
    text: displayText(role, rawText),
    timeCreated: message.info.time?.created,
    timeCompleted: message.info.time?.completed,
    parts,
    usage,
    serverToolsUsed: serverToolWarnings.length > 0,
  }
}

function isExternalChatMessage(message: OpenCodeMessage) {
  return message.info.role === "user" && !isPluginChatMessage(message)
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
