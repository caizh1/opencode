import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { agentListSummary } from "./agent-name"
import {
  buildExportIntentPrompt,
  formatChatExportMarkdown,
  isExportIntentCandidate,
  parseExplicitExportCommand,
  parseExportIntentResponse,
  suggestExportFilename,
  type ExportScope,
} from "./chat-export"
import { createChatViewHtml } from "./chat-html"
import { CHAT_SESSION_TITLE, isPluginChatMessage, isPluginChatSession } from "./chat-session"
import { applyOpenCodeEventToMessages, normalizeOpenCodeEvent } from "./chat-stream"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { CodeIntelligenceSnapshot } from "./analysis-types"
import { CompletionModelClient, completionModel } from "./completion-model-client"
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
  messageText,
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
  OpenCodeSessionStatus,
  PromptModel,
  CodeGraphStatus,
  RagConfigurationApplyResult,
  RagStatus,
  RenderedUsage,
  RemoteSettings,
} from "./types"
import { connectionInputHasPassword, ragSettingsInputMatchesCurrent, saveCompletionSettings, saveRagSettings, type CompletionSettingsInput, type ConnectionSettingsInput, type RagSettingsInput } from "./settings"

const SESSION_MESSAGE_LIMIT = 100
const MODEL_REFRESH_TIMEOUT_MS = 8000
const AGENT_REFRESH_TIMEOUT_MS = 8000
const SESSION_REFRESH_TIMEOUT_MS = 8000
const MESSAGE_REFRESH_TIMEOUT_MS = 5000
const SESSION_STATUS_TIMEOUT_MS = 5000
const EVENT_READY_TIMEOUT_MS = 8000
const SEND_STATUS_POLL_INTERVAL_MS = 5000
const MESSAGE_POLL_INTERVAL_MS = 1000
const EXPORT_INTENT_TIMEOUT_MS = 15000
const EXPORT_INTENT_SESSION_TITLE = "VS Code export intent"
const DIAGNOSTIC_CONTEXT_LIMIT = 60
const DIAGNOSTIC_PREVIEW_LIMIT = 5

type EventStreamPath = "/event" | "/global/event"

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
  | { type: "cancelSend" }
  | { type: "addFile" }
  | { type: "clearContext" }
  | { type: "exportMarkdown"; scope?: ExportScope; filenameHint?: string }
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
      type: "saveCompletionSettings" | "testCompletionApi"
      settings: CompletionSettingsInput
    }
  | { type: "setCompletionApiKey" }
  | {
      type: "saveRagSettings" | "testRagSettings"
      settings: RagSettingsInput
    }
  | { type: "setRagApiKey" }
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

type ActiveSend = {
  client: RemoteOpenCodeClient
  sessionID: string
  generation: number
}

type RemoteChatViewProviderDeps = {
  output: vscode.OutputChannel
  contextStore: LocalContextStore
  codeGraph?: CodeGraphContextProvider
  getClient: () => RemoteOpenCodeClient | undefined
  getSettings: () => RemoteSettings
  getCompletionApiKey: () => Promise<string | undefined>
  promptCompletionApiKey: () => Promise<boolean>
  promptRagApiKey: () => Promise<boolean>
  getEditorContext: () => TrackedEditorContext | undefined
  connectWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  testWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  setConnectionState: (state: ConnectionState, detail?: string) => void
  clearClient: (client: RemoteOpenCodeClient) => void
  openOutput: () => void
  suppressNextRagConfigurationApply?: () => void
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
  private readonly hiddenExportIntentSessions = new Set<string>()
  private mentionIndex?: MentionIndexState
  private mentionIndexBuild?: Promise<MentionIndexState>
  private eventSubscription?: {
    client: RemoteOpenCodeClient
    controller: AbortController
    ready: Promise<boolean>
    path: EventStreamPath
  }
  private eventStreamReady = false
  private eventStreamFailed = false
  private readonly finalizingSessions = new Set<string>()
  private readonly pendingLocalUserMessageIDs = new Set<string>()
  private readonly pendingLocalUserTexts = new Set<string>()
  private activeSend?: ActiveSend
  private activeSendController?: AbortController
  private activeSendGeneration = 0
  private sendStatusTimer?: ReturnType<typeof setTimeout>
  private messagePollTimer?: ReturnType<typeof setTimeout>
  private readonly eventTypeCounts = new Map<string, number>()

  constructor(private readonly deps: RemoteChatViewProviderDeps) {}

  dispose() {
    this.stopEventSubscription()
    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
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
    if (state !== "connected") {
      this.stopEventSubscription()
      this.clearActiveSendState()
    }
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

    return this.startEventSubscription(client, "/event", true)
  }

  private startEventSubscription(client: RemoteOpenCodeClient, path: EventStreamPath, allowGlobalFallback: boolean) {
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
    const tryGlobalFallback = (reason: string) => {
      if (!allowGlobalFallback || path !== "/event" || settled) return false
      settled = true
      clearTimeout(timer)
      if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
      controller.abort()
      this.eventStreamReady = false
      this.eventStreamFailed = false
      this.deps.output.appendLine(`[event] ${reason}; trying /global/event`)
      void this.startEventSubscription(client, "/global/event", false).then(resolveReady)
      return true
    }
    timer = setTimeout(() => {
      this.eventStreamFailed = true
      if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
      controller.abort()
      settle(false)
    }, EVENT_READY_TIMEOUT_MS)

    this.eventSubscription = { client, controller, ready, path }
    void client
      .subscribeEvents(
        (event) => this.handleRemoteEvent(client, event),
        controller.signal,
        () => {
          this.eventStreamReady = true
          this.eventStreamFailed = false
          this.deps.output.appendLine(`[event] connected ${path} ${client.baseUrl}`)
          settle(true)
        },
        path,
      )
      .then(() => {
        if (controller.signal.aborted) return
        if (tryGlobalFallback(`${path} stream closed before ready`)) return
        this.eventStreamReady = false
        this.eventStreamFailed = true
        if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
        settle(false)
        this.deps.output.appendLine(`[event] ${path} stream closed`)
        this.finishActiveStreamAfterEventLoss(client)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (tryGlobalFallback(`${path} stream failed`)) return
        this.eventStreamReady = false
        this.eventStreamFailed = true
        if (this.eventSubscription?.controller === controller) this.eventSubscription = undefined
        settle(false)
        const message = error instanceof Error ? error.message : String(error)
        this.deps.output.appendLine(`[event] ${path} stream failed: ${message}`)
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

  private startSendStatusWatchdog(client: RemoteOpenCodeClient, sessionID: string) {
    this.stopSendStatusWatchdog()
    const generation = ++this.activeSendGeneration
    this.activeSend = { client, sessionID, generation }
    this.scheduleSendStatusWatchdog(client, sessionID, generation)
  }

  private scheduleSendStatusWatchdog(client: RemoteOpenCodeClient, sessionID: string, generation: number) {
    this.stopSendStatusWatchdog()
    this.sendStatusTimer = setTimeout(() => {
      this.sendStatusTimer = undefined
      void this.pollActiveSendStatus(client, sessionID, generation)
    }, SEND_STATUS_POLL_INTERVAL_MS)
  }

  private stopSendStatusWatchdog() {
    if (!this.sendStatusTimer) return
    clearTimeout(this.sendStatusTimer)
    this.sendStatusTimer = undefined
  }

  private startMessagePollingFallback(client: RemoteOpenCodeClient, sessionID: string, generation = this.activeSend?.generation) {
    if (generation === undefined) return
    this.stopMessagePollingFallback()
    this.scheduleMessagePollingFallback(client, sessionID, generation, 0)
  }

  private scheduleMessagePollingFallback(
    client: RemoteOpenCodeClient,
    sessionID: string,
    generation: number,
    delayMs = MESSAGE_POLL_INTERVAL_MS,
  ) {
    this.stopMessagePollingFallback()
    this.messagePollTimer = setTimeout(() => {
      this.messagePollTimer = undefined
      void this.pollActiveSendMessages(client, sessionID, generation)
    }, delayMs)
  }

  private stopMessagePollingFallback() {
    if (!this.messagePollTimer) return
    clearTimeout(this.messagePollTimer)
    this.messagePollTimer = undefined
  }

  private clearActiveSendState() {
    this.activeSendGeneration += 1
    this.activeSend = undefined
    this.activeSendController = undefined
    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    this.sending = false
  }

  private cancelActiveSend() {
    if (!this.sending && !this.activeSendController) return
    this.deps.output.appendLine("[send] canceled from webview")
    this.activeSendController?.abort()
    this.clearActiveSendState()
    this.messages = [...this.messages, localMessage("error", "Request canceled.")]
    this.postState()
  }

  private isActiveSend(client: RemoteOpenCodeClient, sessionID: string, generation: number) {
    return (
      this.sending &&
      this.sessionID === sessionID &&
      this.activeSend?.client === client &&
      this.activeSend.sessionID === sessionID &&
      this.activeSend.generation === generation
    )
  }

  private async pollActiveSendStatus(client: RemoteOpenCodeClient, sessionID: string, generation: number) {
    if (!this.isActiveSend(client, sessionID, generation)) return

    try {
      const statuses = await withRequestTimeout("session status", SESSION_STATUS_TIMEOUT_MS, (signal) =>
        client.getSessionStatuses(signal),
      )
      if (!this.isActiveSend(client, sessionID, generation)) return

      const status = statuses[sessionID]
      if (status?.type === "idle") {
        void this.finishStreamingSession(client, sessionID)
        return
      }
      if (status?.type === "retry") {
        await this.failActiveSendWithRetry(client, sessionID, status, generation)
        return
      }
    } catch (error) {
      if (this.isActiveSend(client, sessionID, generation)) this.logEventError("session status poll failed", error)
    }

    if (this.isActiveSend(client, sessionID, generation)) this.scheduleSendStatusWatchdog(client, sessionID, generation)
  }

  private async pollActiveSendMessages(client: RemoteOpenCodeClient, sessionID: string, generation: number) {
    if (!this.isActiveSend(client, sessionID, generation)) return

    try {
      if (this.sessionID === sessionID) {
        const started = Date.now()
        const messages = await withRequestTimeout("session messages", MESSAGE_REFRESH_TIMEOUT_MS, (signal) =>
          client.getMessages(sessionID, SESSION_MESSAGE_LIMIT, signal),
        )
        this.deps.output.appendLine(`[refresh] polling messages ${Date.now() - started}ms`)
        if (!this.isActiveSend(client, sessionID, generation) || this.sessionID !== sessionID) return
        if (messages.some(isInlineCompletionMessage)) {
          await this.hideCompletionSession(client, sessionID)
          return
        }
        if (messages.some(isExternalChatMessage)) {
          await this.hideExternalSession(client, sessionID)
          return
        }
        this.remoteMessages = messages
        this.syncRenderedMessages()
        this.applyServerToolWarnings(sessionID)
        this.postState()
      }
    } catch (error) {
      if (this.isActiveSend(client, sessionID, generation)) this.logEventError("message polling fallback failed", error)
    }

    if (this.isActiveSend(client, sessionID, generation)) this.scheduleMessagePollingFallback(client, sessionID, generation)
  }

  private async failActiveSendWithRetry(
    client: RemoteOpenCodeClient,
    sessionID: string,
    status: OpenCodeSessionStatus,
    generation = this.activeSend?.generation,
  ) {
    if (generation === undefined || !this.isActiveSend(client, sessionID, generation)) return

    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
    const message = remoteRetryMessage(status)
    this.deps.output.appendLine(`[event] ${message}`)
    try {
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("retry message refresh failed", error)
    }
    if (!this.isActiveSend(client, sessionID, generation)) return

    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    this.messages = [...this.messages, localMessage("error", message)]
    this.sending = false
    this.activeSend = undefined
    this.postState()
  }

  private handleRemoteEvent(client: RemoteOpenCodeClient, rawEvent: unknown) {
    if (this.deps.getClient() !== client) return
    const event = normalizeOpenCodeEvent(rawEvent)
    if (!event) return
    this.logRemoteEventType(event.type)
    if (event.type === "server.connected") return

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
      this.clearActiveSendState()
      this.messages = [...this.messages, localMessage("error", `Remote session error: ${result.error}`)]
      this.postState()
    }

    const sessionID = this.sessionID
    if (sessionID && result.retry) {
      void this.failActiveSendWithRetry(client, sessionID, result.retry)
      return
    }
    if (sessionID && (result.idle || result.completed)) {
      void this.finishStreamingSession(client, sessionID)
    }
  }

  private logRemoteEventType(type: string) {
    const count = (this.eventTypeCounts.get(type) ?? 0) + 1
    this.eventTypeCounts.set(type, count)
    if (count <= 5 || count % 25 === 0) this.deps.output.appendLine(`[event] ${type} #${count}`)
  }

  private finishActiveStreamAfterEventLoss(client: RemoteOpenCodeClient) {
    if (!this.sending || !this.sessionID) return
    const sessionID = this.sessionID
    const generation =
      this.activeSend?.client === client && this.activeSend.sessionID === sessionID ? this.activeSend.generation : undefined
    if (generation !== undefined) {
      this.deps.output.appendLine("[event] stream unavailable during active send; using message polling fallback")
      this.startMessagePollingFallback(client, sessionID, generation)
      return
    }
    void this.finishStreamingSession(client, sessionID)
  }

  private async finishStreamingSession(client: RemoteOpenCodeClient, sessionID: string) {
    if (this.finalizingSessions.has(sessionID)) return
    this.finalizingSessions.add(sessionID)
    const activeGeneration =
      this.activeSend?.client === client && this.activeSend.sessionID === sessionID ? this.activeSend.generation : undefined
    if (activeGeneration !== undefined) {
      this.stopSendStatusWatchdog()
      this.stopMessagePollingFallback()
    }
    try {
      if (this.deps.getClient() !== client) return
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("final message refresh failed", error)
    } finally {
      this.finalizingSessions.delete(sessionID)
      if (this.sessionID === sessionID) {
        if (activeGeneration !== undefined && this.activeSend?.generation === activeGeneration) this.activeSend = undefined
        this.pendingLocalUserMessageIDs.clear()
        this.pendingLocalUserTexts.clear()
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

    this.clearActiveSendState()
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

  refreshState() {
    this.postState()
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
        case "cancelSend":
          this.cancelActiveSend()
          break
        case "addFile":
          await this.addFile()
          break
        case "clearContext":
          this.deps.contextStore.clear()
          this.postState()
          break
        case "exportMarkdown":
          await this.exportMarkdown(message.scope ?? "session", message.filenameHint)
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
          await this.connectWithSettings(connectionSettingsFromMessage(message))
          break
        case "testWithSettings":
          await this.testWithSettings(connectionSettingsFromMessage(message))
          break
        case "saveCompletionSettings":
          await this.saveCompletionSettings(message.settings)
          break
        case "setCompletionApiKey":
          await this.setCompletionApiKey()
          break
        case "testCompletionApi":
          await this.testCompletionApi(message.settings)
          break
        case "saveRagSettings":
          await this.saveRagSettings(message.settings)
          break
        case "testRagSettings":
          await this.testRagSettings(message.settings)
          break
        case "setRagApiKey":
          await this.setRagApiKey()
          break
        case "sendMessage":
          await this.handleSendMessage(
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
    await this.deps.connectWithSettings(connectionSettingsForDeps(input))
  }

  private async testWithSettings(input: ConnectionSettingsInput) {
    this.deps.output.appendLine(`[test] requested URL: ${input.serverUrl}`)
    await this.deps.testWithSettings(connectionSettingsForDeps(input))
  }

  private async saveCompletionSettings(input: CompletionSettingsInput) {
    try {
      await saveCompletionSettings(input)
      this.postState()
      this.postCompletionStatus("Inline completion settings saved.", "success")
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[completion-settings] save failed: ${message}`)
      this.postState()
      this.postCompletionStatus(`Inline completion settings save failed: ${message}`, "error")
    }
  }

  private async setCompletionApiKey() {
    const saved = await this.deps.promptCompletionApiKey()
    this.postCompletionStatus(saved ? "Inline completion API key saved." : "Inline completion API key unchanged.")
    this.postState()
  }

  private async testCompletionApi(input: CompletionSettingsInput) {
    await saveCompletionSettings(input)
    const settings = this.deps.getSettings()
    const model = completionModel(settings)
    if (!settings.completion.apiBaseUrl || !model) {
      this.postCompletionStatus("Direct completion API URL and model are required.", "error")
      this.postState()
      return
    }

    try {
      const client = new CompletionModelClient(settings, await this.deps.getCompletionApiKey())
      const prompt = settings.completion.profile === "qwen-coder-fim"
        ? [
            "<|repo_name|>opencode-test",
            "<|file_sep|>test.ts\n",
            "<|fim_prefix|>const value = ",
            "<|fim_suffix|>;\n",
            "<|fim_middle|>",
          ].join("")
        : [
            "You are testing an inline completion endpoint.",
            "Return only this exact text:",
            "ok",
          ].join("\n")
      await client.complete({
        prompt,
      })
      this.postCompletionStatus(`Direct completion API test succeeded for ${model}.`)
    } catch (error) {
      this.postCompletionStatus(`Direct completion API test failed: ${formatErrorMessage(error)}`, "error")
    } finally {
      this.postState()
    }
  }

  private async saveRagSettings(input: RagSettingsInput) {
    try {
      const unchanged = ragSettingsInputMatchesCurrent(input, this.deps.getSettings().rag)
      if (!unchanged) {
        this.deps.suppressNextRagConfigurationApply?.()
        await saveRagSettings(input)
      }
      let result = await this.deps.codeGraph?.applyRagConfiguration()
      this.postState()
      if (!result) {
        this.postRagStatus(unchanged ? "RAG settings unchanged." : "RAG settings saved.", "success")
        return
      }
      if (unchanged && result.hasReusableIndex) {
        const forceRebuild = await this.confirmForceRagRebuild()
        if (!forceRebuild) {
          this.postState()
          this.postRagStatus(`RAG settings unchanged. Existing local RAG index kept. ${ragStatusMessage(result.status, "RAG status refreshed.")}`, "success")
          return
        }
        result = await this.deps.codeGraph?.applyRagConfiguration({ forceRebuild: true }) ?? result
        this.postState()
        this.postRagStatus(ragApplyResultMessage(result, "RAG force rebuild requested."), "success")
        return
      }
      this.postRagStatus(ragApplyResultMessage(result, unchanged ? "RAG settings unchanged." : "RAG settings saved."), "success")
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[rag-settings] save failed: ${message}`)
      this.postState()
      this.postRagStatus(`RAG settings save failed: ${message}`, "error")
    }
  }

  private async confirmForceRagRebuild() {
    const keep = { title: "否，保留现有索引", isCloseAffordance: true }
    const force = { title: "是，强制重建" }
    const selected = await vscode.window.showWarningMessage(
      "本地已有 RAG 索引。强制重建会从头开始重新 embedding，可能消耗大量时间。确定要从头重建吗？",
      { modal: true },
      keep,
      force,
    )
    return selected?.title === force.title
  }

  private async testRagSettings(input: RagSettingsInput) {
    await saveRagSettings(input)
    this.deps.output.appendLine("[rag-test] testing RAG configuration")
    this.postRagStatus("Testing RAG configuration...")
    try {
      await this.deps.codeGraph?.testRagConfiguration()
      const rag = this.deps.codeGraph?.status().rag
      this.deps.output.appendLine(`[rag-test] result: ${ragTestResultMessage(rag)}`)
      this.postRagStatus(ragStatusMessage(rag, "RAG test finished."))
    } catch (error) {
      this.deps.output.appendLine(`[rag-test] failed: ${formatErrorMessage(error)}`)
      this.postRagStatus(`RAG test failed: ${formatErrorMessage(error)}`, "error")
    } finally {
      this.postState()
    }
  }

  private async setRagApiKey() {
    const saved = await this.deps.promptRagApiKey()
    this.postRagStatus(saved ? "RAG API key saved." : "RAG API key unchanged.")
    this.postState()
  }

  private async addFile() {
    const count = await addPickedFilesToContext(this.deps.contextStore)
    this.postState()
    if (count > 0) vscode.window.setStatusBarMessage(`Attached ${count} file(s) to OpenCode context`, 2000)
  }

  private async selectSession(sessionID: string) {
    const client = this.connectedClient("Connect before selecting a session.")
    if (!client || !sessionID) return

    this.clearActiveSendState()
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
    if (this.sending) return

    const client = this.connectedClient("Connect to a remote OpenCode server before sending.")
    if (!client) return

    const controller = new AbortController()
    this.activeSendController = controller
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
      if (controller.signal.aborted) return
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
      if (controller.signal.aborted) return
      this.lastContextSummary = contextSummary
      this.logContextSummary(contextSummary)
      this.deps.output.appendLine(`[agent] ${agentSelection.label}`)
      this.deps.output.appendLine(`[model] ${modelSelection.label}`)
      preparedMessage = {
        text: prompt,
        model: modelSelection.model,
        agent: agentSelection.agent,
      }
      sentStreaming = await this.sendPreparedMessage(client, preparedMessage, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      let finalError = error
      if (preparedMessage && isSessionNotFoundError(error)) {
        try {
          this.clearMissingSession(this.sessionID)
          this.deps.output.appendLine("[session] Selected remote session was not found; retrying with a new session.")
          sentStreaming = await this.sendPreparedMessage(client, preparedMessage, controller.signal)
          return
        } catch (retryError) {
          if (controller.signal.aborted) return
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
      if (this.activeSendController === controller) this.activeSendController = undefined
      if (!sentStreaming && !controller.signal.aborted) this.sending = false
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

  private async getOrCreateSession(client: RemoteOpenCodeClient, signal?: AbortSignal) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession(CHAT_SESSION_TITLE, signal)
    this.sessionID = session.id
    await this.refreshSessionList(client)
    return session.id
  }

  private async sendPreparedMessage(
    client: RemoteOpenCodeClient,
    input: { text: string; model?: PromptModel; agent?: string },
    signal?: AbortSignal,
  ) {
    const sessionID = await this.getOrCreateSession(client, signal)
    const canStream = await this.ensureEventSubscription(client)
    await client.sendMessageAsync({
      sessionID,
      text: input.text,
      model: input.model,
      agent: input.agent,
      signal,
    })

    if (this.sending && this.sessionID === sessionID) {
      this.startSendStatusWatchdog(client, sessionID)
      if (!canStream || this.eventStreamFailed || !this.eventStreamReady) {
        this.deps.output.appendLine("[event] live stream unavailable; using async message polling fallback")
        this.startMessagePollingFallback(client, sessionID)
      }
    }

    await this.refreshSessionList(client)
    return true
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
    if (this.hiddenExportIntentSessions.has(session.id)) return false
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

  private async handleSendMessage(text: string, options: ChatContextOptions, mentionedFiles: vscode.Uri[]) {
    const explicitExport = parseExplicitExportCommand(text)
    if (explicitExport) {
      await this.exportMarkdown(explicitExport.scope, explicitExport.filenameHint)
      return
    }

    if (isExportIntentCandidate(text)) {
      const client = this.deps.getClient()
      if (client && this.connectionState === "connected") {
        const decision = await this.classifyExportIntent(client, text)
        if (decision.intent === "export") {
          await this.exportMarkdown(decision.scope, decision.filenameHint)
          return
        }
      }
      this.postExportStatus("")
    }

    await this.sendMessage(text, options, mentionedFiles)
  }

  private async classifyExportIntent(client: RemoteOpenCodeClient, text: string) {
    this.postExportStatus("Checking whether this is an export request...")
    const settings = this.deps.getSettings()
    const prompt = buildExportIntentPrompt({
      userRequest: text,
      sessionTitle: this.currentSessionTitle(),
      messages: this.messages,
    })

    try {
      const response = await withRequestTimeout("export intent classification", EXPORT_INTENT_TIMEOUT_MS, async (signal) => {
        const session = await client.createSession(EXPORT_INTENT_SESSION_TITLE, signal)
        this.hiddenExportIntentSessions.add(session.id)
        return client.sendMessage({
          sessionID: session.id,
          text: prompt,
          model: this.modelForSettings(settings).model,
          signal,
        })
      })
      const decision = parseExportIntentResponse(messageText(response))
      if (!decision) {
        this.deps.output.appendLine("[export] Model returned an invalid export intent response; continuing as chat.")
        return { intent: "chat" } as const
      }
      this.deps.output.appendLine(`[export] Model classified intent as ${decision.intent}.`)
      return decision
    } catch (error) {
      this.deps.output.appendLine(`[export] Failed to classify export intent: ${formatErrorMessage(error)}`)
      return { intent: "chat" } as const
    }
  }

  private async exportMarkdown(scope: ExportScope, filenameHint?: string) {
    const markdown = formatChatExportMarkdown({
      messages: this.messages,
      scope,
      sessionTitle: this.currentSessionTitle(),
    })
    if (!markdown) {
      const message = scope === "lastAssistant" ? "No assistant response is available to export." : "No chat messages are available to export."
      this.postExportStatus(message)
      vscode.window.showWarningMessage(message)
      return
    }

    const suggestedFilename = suggestExportFilename({
      filenameHint,
      sessionTitle: this.currentSessionTitle(),
    })
    const uri = await vscode.window.showSaveDialog({
      title: "Export OpenCode chat as Markdown",
      saveLabel: "Export",
      defaultUri: this.defaultExportUri(suggestedFilename),
      filters: {
        Markdown: ["md"],
      },
    })
    if (!uri) {
      this.postExportStatus("Export canceled.")
      return
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown))
    const message = `Exported Markdown to ${uri.fsPath}.`
    this.deps.output.appendLine(`[export] ${message}`)
    this.postExportStatus(message)
    vscode.window.showInformationMessage(message)
  }

  private defaultExportUri(filename: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (workspaceFolder) return vscode.Uri.joinPath(workspaceFolder.uri, filename)
    return vscode.Uri.file(path.join(os.homedir(), filename))
  }

  private currentSessionTitle() {
    return this.sessions.find((session) => session.id === this.sessionID)?.title || CHAT_SESSION_TITLE
  }

  private postExportStatus(message: string) {
    this.view?.webview.postMessage({
      type: "exportStatus",
      message,
    })
  }

  private postCompletionStatus(message: string, status = "info") {
    this.view?.webview.postMessage({
      type: "completionStatus",
      message,
      status,
    })
  }

  private postRagStatus(message: string, status = "info") {
    this.view?.webview.postMessage({
      type: "ragStatus",
      message,
      status,
    })
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
        completion: settings.completion,
        rag: settings.rag,
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
    const diagnostics = workspaceDiagnosticsSummary(DIAGNOSTIC_PREVIEW_LIMIT)
    return {
      currentFile: editorContext ? relativePath(editorContext.uri) : "",
      hasSelection: Boolean(editorContext && !editorContext.selection.isEmpty),
      diagnosticCount: diagnostics.total,
      diagnostics,
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

function workspaceDiagnosticsSummary(previewLimit: number) {
  const counts = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
    unknown: 0,
  }
  const files = new Map<string, {
    path: string
    total: number
    errors: number
    warnings: number
    information: number
    hints: number
    unknown: number
    examples: Array<{ line: number; severity: string; message: string }>
  }>()

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (!vscode.workspace.getWorkspaceFolder(uri)) continue
    const filePath = relativePath(uri)
    let file = files.get(filePath)
    if (!file) {
      file = {
        path: filePath,
        total: 0,
        errors: 0,
        warnings: 0,
        information: 0,
        hints: 0,
        unknown: 0,
        examples: [],
      }
      files.set(filePath, file)
    }

    for (const diagnostic of diagnostics) {
      const severity = diagnosticSeverityName(diagnostic.severity)
      counts[severity.key] += 1
      file.total += 1
      file[severity.fileKey] += 1
      if (file.examples.length < 2) {
        file.examples.push({
          line: diagnostic.range.start.line + 1,
          severity: severity.label,
          message: diagnostic.message,
        })
      }
    }
  }

  const total = counts.error + counts.warning + counts.information + counts.hint + counts.unknown
  return {
    total,
    limit: DIAGNOSTIC_CONTEXT_LIMIT,
    counts,
    files: [...files.values()]
      .filter((file) => file.total > 0)
      .sort((left, right) => right.total - left.total || left.path.localeCompare(right.path))
      .slice(0, previewLimit),
  }
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return { label: "Error", key: "error" as const, fileKey: "errors" as const }
    case vscode.DiagnosticSeverity.Warning:
      return { label: "Warning", key: "warning" as const, fileKey: "warnings" as const }
    case vscode.DiagnosticSeverity.Information:
      return { label: "Information", key: "information" as const, fileKey: "information" as const }
    case vscode.DiagnosticSeverity.Hint:
      return { label: "Hint", key: "hint" as const, fileKey: "hints" as const }
    default:
      return { label: "Unknown", key: "unknown" as const, fileKey: "unknown" as const }
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

function remoteRetryMessage(status: OpenCodeSessionStatus) {
  const attempt = "attempt" in status && typeof status.attempt === "number" ? `（第 ${status.attempt} 次）` : ""
  const detail =
    "message" in status && typeof status.message === "string" && status.message.trim()
      ? `：${status.message.trim()}`
      : ""
  return `远端 OpenCode 正在重试模型请求${attempt}${detail}。当前会话可能过大，可以新建会话后重试。`
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

function ragStatusMessage(rag: RagStatus | undefined, fallback: string) {
  if (!rag) return fallback
  if (rag.embeddingEnabled) {
    const rerank = rag.rerankEnabled
      ? ", rerank ready"
      : rag.rerankProvider || rag.rerankLastError
        ? `, rerank unavailable: ${rag.rerankLastError || "endpoint test failed"}`
        : ""
    if (rag.availability === "indexing") return `${ragIndexingMessage(rag)}${rerank}.`
	    if (rag.availability === "partial") {
	      return `RAG partial: ${rag.embeddedChunks}/${rag.chunks} chunk(s), ${rag.pendingChunkCount ?? Math.max(0, rag.chunks - rag.embeddedChunks)} pending${ragElapsedMessage(rag)}${ragWorkerMessage(rag)}${ragResumeScheduleMessage(rag)}${rerank}.`
	    }
	    if (rag.availability === "paused") {
	      return `RAG indexing paused: ${rag.fallbackReason ?? ragPausedReasonMessage(rag.indexPausedReason, rag.lastError)}${ragElapsedMessage(rag)}${ragWorkerMessage(rag)}${ragResumeScheduleMessage(rag)}, ${rag.embeddedChunks}/${rag.chunks} chunk(s) indexed${rerank}.`
	    }
	    return `RAG ready: ${rag.embeddedChunks}/${rag.chunks} chunk(s)${ragElapsedMessage(rag, "total")}${ragWorkerMessage(rag)}, ${rag.vectorShards} shard(s)${rerank}.`
	  }
  if (rag.availability === "checking") return "RAG checking embedding endpoint and vector index."
  if (rag.availability === "indexing") return `${ragIndexingMessage(rag)}.`
  if (rag.availability === "partial") return `RAG partial: ${rag.embeddedChunks}/${rag.chunks} chunk(s), ${rag.pendingChunkCount ?? Math.max(0, rag.chunks - rag.embeddedChunks)} pending${ragElapsedMessage(rag)}${ragWorkerMessage(rag)}${ragResumeScheduleMessage(rag)}.`
  if (rag.availability === "paused") return `RAG indexing paused: ${rag.fallbackReason ?? ragPausedReasonMessage(rag.indexPausedReason, rag.lastError)}${ragElapsedMessage(rag)}${ragWorkerMessage(rag)}${ragResumeScheduleMessage(rag)}`
  if (rag.availability === "not-indexed") return `RAG not indexed: ${rag.fallbackReason || "rebuild the local code graph to enable vector retrieval"}`
  if (rag.availability === "unavailable") return `RAG unavailable: ${rag.fallbackReason || rag.lastError || "endpoint test failed"}`
  return "RAG not configured. Add an embedding endpoint to enable vector retrieval."
}

function ragApplyResultMessage(result: RagConfigurationApplyResult, fallback: string) {
  const detail = ragStatusMessage(result.status, fallback)
  if (result.action === "status-refreshed") return `RAG status refreshed. Existing local RAG index kept. ${detail}`
  if (result.action === "build-started") return `RAG indexing started. ${detail}`
  if (result.action === "build-queued") return `RAG indexing queued until the local code graph is ready. ${detail}`
  if (result.action === "disabled") return detail
  if (result.action === "unavailable") return detail
  return fallback
}

function ragIndexingMessage(rag: RagStatus) {
  const progress = rag.indexProgress
  const pending = rag.pendingChunkCount ?? Math.max(0, rag.chunks - rag.embeddedChunks)
  const telemetry = `${ragElapsedMessage(rag)}${ragWorkerMessage(rag)}`
  if (!progress) return `RAG indexing: ${rag.embeddedChunks}/${rag.chunks} chunk(s), ${pending} pending${telemetry}`
  if (progress.phase === "batch") {
    const requestLimit = progress.requestLimit && progress.requestLimit > 0 ? String(progress.requestLimit) : "unlimited"
    return `RAG indexing: ${rag.embeddedChunks}/${rag.chunks} chunk(s), batch ${progress.batchIndex}/${progress.batchCount}, request ${progress.requestNumber}/${requestLimit}, ${pending} pending${telemetry}`
  }
  if (progress.phase === "delay") return `RAG indexing: ${rag.embeddedChunks}/${rag.chunks} chunk(s), waiting ${progress.delayMs}ms, ${pending} pending${telemetry}`
  if (progress.phase === "rate-limit") return `RAG indexing: ${rag.embeddedChunks}/${rag.chunks} chunk(s), rate limited retry ${progress.retry}/${progress.maxRetries}, ${pending} pending${telemetry}`
  return `RAG indexing paused: ${rag.embeddedChunks}/${rag.chunks} chunk(s), ${pending} pending${telemetry}`
}

function ragElapsedMessage(rag: RagStatus, label = "elapsed") {
  const elapsedMs = rag.indexElapsedMs ?? rag.indexProgress?.elapsedMs
  if (elapsedMs === undefined) return ""
  return `, ${label} ${formatDuration(elapsedMs)}`
}

function ragWorkerMessage(rag: RagStatus) {
  const worker = rag.workerStatus ?? rag.indexProgress?.workerStatus
  if (!worker) return ""
  const change = worker.lastChange
    ? `; ${worker.lastChange.direction === "upgrade" ? "upgraded" : "degraded"} ${worker.lastChange.fromWorkers}->${worker.lastChange.toWorkers}: ${worker.lastChange.reason}`
    : ""
  return `, workers ${worker.activeWorkers}/${worker.maxWorkers}, ${worker.inFlightRequests} in flight, ${worker.queuePending} queued${change}`
}

function formatDuration(ms: number) {
  const safeMs = Math.max(0, Math.floor(ms))
  if (safeMs < 1000) return `${safeMs}ms`
  const totalSeconds = Math.floor(safeMs / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${(safeMs / 1000).toFixed(safeMs < 10000 ? 1 : 0)}s`
}

function ragTestResultMessage(rag: RagStatus | undefined) {
  if (!rag) return "unknown"
  const state = rag.embeddingEnabled ? "ready" : rag.availability ?? "unavailable"
  const details = [
    `embeddingEnabled=${rag.embeddingEnabled}`,
    `rerankEnabled=${rag.rerankEnabled}`,
    rag.fallbackReason ? `fallbackReason=${truncate(rag.fallbackReason, 180)}` : undefined,
    rag.lastError ? `lastError=${truncate(rag.lastError, 180)}` : undefined,
    rag.rerankLastError ? `rerankLastError=${truncate(rag.rerankLastError, 180)}` : undefined,
  ].filter(Boolean)
  return `${state} ${details.join(" ")}`
}

function ragPausedReasonMessage(reason?: RagStatus["indexPausedReason"], detail?: string) {
  const suffix = detail ? `: ${detail}` : ""
  if (reason === "request-budget") return `request budget reached${suffix}`
  if (reason === "rate-limit") return `rate limited${suffix}`
  if (reason === "provider-error") return `provider error${suffix}`
  return `indexing paused${suffix}`
}

function ragResumeScheduleMessage(rag: RagStatus) {
  if (!rag.resumeScheduledAt || !rag.resumeReason) return ""
  const remainingMs = Math.max(0, rag.resumeScheduledAt - Date.now())
  const label = rag.resumeReason === "rate-limit" ? "retry scheduled" : "resume scheduled"
  return `; ${label} in ${Math.ceil(remainingMs / 1000)}s`
}

function connectionSettingsFromMessage(message: Extract<ChatViewMessage, { type: "connectWithSettings" | "testWithSettings" }>): ConnectionSettingsInput {
  const input: ConnectionSettingsInput = {
    serverUrl: message.serverUrl,
    username: message.username,
  }
  if (Object.prototype.hasOwnProperty.call(message, "password")) input.password = message.password
  return input
}

function connectionSettingsForDeps(input: ConnectionSettingsInput): ConnectionSettingsInput {
  const next: ConnectionSettingsInput = {
    serverUrl: input.serverUrl,
    username: input.username,
  }
  if (connectionInputHasPassword(input)) next.password = input.password
  return next
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}
