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
import { CHAT_SESSION_TITLE, extractPluginChatQuestionText, isPluginChatMessage, isPluginChatSession } from "./chat-session"
import { StreamingStatePostScheduler } from "./chat-state-post-scheduler"
import { applyChipMateEventToMessages, normalizeChipMateEvent, chipMateEventSessionID } from "./chat-stream"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { CodeIntelligenceSnapshot } from "./analysis-types"
import { CompletionModelClient, completionModel } from "./completion-model-client"
import { isInlineCompletionMessage, isInlineCompletionSession } from "./completion-session"
import { CHIPMATE_CHAT_VIEW_ID, CHIPMATE_COMMANDS, CHIPMATE_VIEW_CONTAINER_ID } from "./chipmate-constants"
import {
  addPickedFilesToContext,
  buildChatPrompt,
  type ContextSummaryItem,
  type LocalContextItem,
  LocalContextStore,
  MissingLocalContextError,
  relativePath,
} from "./context"
import type { DocumentRagContextProvider } from "./document-rag"
import type { TrackedEditorContext } from "./editor-context"
import { MissingLocalOnlyAgentError, selectRequestAgent } from "./local-agent"
import { buildMentionIndex, isMentionIndexExcludedPath, searchMentionIndex, type MentionIndexEntry } from "./mention-index"
import { DirectAgentClient } from "./direct-agent-client"
import type { SkillMetadata } from "./skills"
import { splitThinkingFromParts } from "./thinking"
import { summarizeSessionUsage, usageFromMessageInfo } from "./usage"
import type {
  ChatContextOptions,
  ConnectionState,
  ChipMateAgentInfo as ChipMateAgentInfo,
  ChipMateMessage as ChipMateMessage,
  ChipMateModelInfo as ChipMateModelInfo,
  ChipMatePart as ChipMatePart,
  ChipMateEvent as ChipMateEvent,
  ChipMateSession as ChipMateSession,
  ChipMateSessionStatus as ChipMateSessionStatus,
  PromptModel,
  PermissionMode,
  CodeGraphStatus,
  RagConfigurationApplyResult,
  RagStatus,
  RenderedUsage,
  RemoteSettings,
} from "./types"
import { connectionInputHasPassword, ragSettingsInputChangesEmbeddingIdentity, ragSettingsInputMatchesCurrent, saveCompletionSettings, savePermissionMode, saveRagSettings, saveSkillsSettings, saveToolsEnabled, type CompletionSettingsInput, type ConnectionSettingsInput, type RagSettingsInput } from "./settings"

const SESSION_MESSAGE_LIMIT = 100
const MODEL_REFRESH_TIMEOUT_MS = 8000
const AGENT_REFRESH_TIMEOUT_MS = 8000
const SESSION_REFRESH_TIMEOUT_MS = 8000
const MESSAGE_REFRESH_TIMEOUT_MS = 5000
const SESSION_STATUS_TIMEOUT_MS = 5000
const SESSION_ABORT_TIMEOUT_MS = 5000
const EVENT_READY_TIMEOUT_MS = 8000
const SEND_STATUS_POLL_INTERVAL_MS = 5000
const MESSAGE_POLL_INTERVAL_MS = 1000
const STREAMING_STATE_POST_THROTTLE_MS = 50
const EXPORT_INTENT_TIMEOUT_MS = 15000
const EXPORT_INTENT_SESSION_TITLE = "VS Code export intent"
const MAX_QUEUED_CHAT_SENDS = 10
const DIAGNOSTIC_CONTEXT_LIMIT = 60
const DIAGNOSTIC_PREVIEW_LIMIT = 5
const MENTION_INDEX_LIMIT = 20000
const MENTION_INDEX_EXCLUDE_GLOB = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode-test/**}"

type EventStreamPath = "/event" | "/global/event"
type RagRebuildConfirmationReason = "ready" | "incomplete" | "embedding-change"

type MentionedFileRef = {
  uri: string
  label: string
  type?: "file" | "folder"
  insertText?: string
}

type QueuedMentionedFileRef = MentionedFileRef & {
  type: "file"
}

type WorkspaceFileQuickPickItem = vscode.QuickPickItem & {
  entry: MentionIndexEntry
}

type ChatViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "refreshSessions" }
  | { type: "openOutput" }
  | { type: "newSession" }
  | { type: "cancelSend" }
  | { type: "addFile" }
  | { type: "pickWorkspaceFilesForMessage" }
  | { type: "addDroppedFiles"; candidates?: string[] }
  | { type: "clearContext" }
  | { type: "removeContextItem"; id?: string }
  | { type: "toggleContextPin"; id?: string; pinned?: boolean; file?: MentionedFileRef }
  | { type: "openContextItem"; id?: string }
  | { type: "exportMarkdown"; scope?: ExportScope; filenameHint?: string }
  | { type: "deleteQueuedSend"; id?: string }
  | { type: "editQueuedSend"; id?: string }
  | { type: "selectSession"; sessionID: string }
  | { type: "deleteSession"; sessionID: string }
  | { type: "refreshModels" }
  | { type: "selectModel"; model: string }
  | { type: "searchFilesForMention"; query?: string; requestId?: number }
  | { type: "indexCodeGraph" }
  | { type: "rebuildCodeGraph" }
  | { type: "pauseCodeGraph" }
  | { type: "resumeCodeGraph" }
  | { type: "cancelCodeGraph" }
  | { type: "pauseRagIndexing" }
  | { type: "resumeRagIndexing" }
  | { type: "cancelRagIndexing" }
  | { type: "pauseDocumentRagIndexing" }
  | { type: "resumeDocumentRagIndexing" }
  | { type: "rebuildDocumentRag" }
  | { type: "showDocumentRagStatus" }
  | { type: "showCodeGraphStatus" }
  | { type: "refreshCodeIntelligence" }
  | { type: "openEvidence"; path: string; line?: number }
  | {
      type: "connectWithSettings" | "testWithSettings"
      requestId?: number
      serverUrl: string
      username: string
      password?: string
    }
  | {
      type: "saveCompletionSettings" | "testCompletionApi"
      settings: CompletionSettingsInput
    }
  | {
      type: "saveRagSettings" | "testRagSettings"
      settings: RagSettingsInput
    }
  | { type: "saveSkillsSettings"; enabled: string[] }
  | { type: "savePermissionMode"; mode: PermissionMode }
  | { type: "saveToolsEnabled"; enabled: boolean }
  | {
      type: "sendMessage"
      text: string
      clientQueueID?: string
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
  preview?: string
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
  generation: number
}

type MentionIndexBuildState = {
  generation: number
  promise: Promise<MentionIndexState>
}

type ActiveSend = {
  client: DirectAgentClient
  sessionID: string
  generation: number
}

type QueuedChatSend = {
  id: string
  text: string
  options: ChatContextOptions
  mentionedFiles: vscode.Uri[]
  mentionedFileRefs: QueuedMentionedFileRef[]
  contextItems: LocalContextItem[]
}

type RemoteChatViewProviderDeps = {
  output: vscode.OutputChannel
  extensionUri: vscode.Uri
  contextStore: LocalContextStore
  codeGraph?: CodeGraphContextProvider
  documentRag?: DocumentRagContextProvider & {
    rebuild(): void
    pauseIndexing(reason?: string): void
    resumeIndexing(): void
    showStatus(): Promise<void>
  }
  getClient: () => DirectAgentClient | undefined
  getSettings: () => RemoteSettings
  getProviderApiKey: () => Promise<string | undefined>
  getEditorContext: () => TrackedEditorContext | undefined
  connectWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  testWithSettings: (input: ConnectionSettingsInput) => Promise<void>
  setConnectionState: (state: ConnectionState, detail?: string) => void
  clearClient: (client: DirectAgentClient) => void
  openOutput: () => void
  suppressNextRagConfigurationApply?: () => void
  invalidateSkills?: () => void
  listSkills?: () => Promise<SkillMetadata[]>
}

export class RemoteChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = CHIPMATE_CHAT_VIEW_ID

  private view?: vscode.WebviewView
  private sessionID?: string
  private sessions: RenderedSession[] = []
  private messages: RenderedMessage[] = []
  private remoteMessages: ChipMateMessage[] = []
  private connectionState: ConnectionState = "disconnected"
  private connectionDetail = "Ready. Configure an OpenAI-compatible provider to start."
  private sending = false
  private loadingMessages = false
  private loadingModels = false
  private loadingAgents = false
  private models: ChipMateModelInfo[] = []
  private agents: ChipMateAgentInfo[] = []
  private modelError = ""
  private agentError = ""
  private historyError = ""
  private codeGraphWaitDetail = ""
  private codeIntelligence?: CodeIntelligenceSnapshot
  private loadingCodeIntelligence = false
  private codeIntelligenceError = ""
  private skills: SkillMetadata[] = []
  private skillsError = ""
  private loadingSkills = false
  private lastContextSummary: ContextSummaryItem[] = []
  private readonly flaggedSessions = new Set<string>()
  private readonly hiddenCompletionSessions = new Set<string>()
  private readonly hiddenExternalSessions = new Set<string>()
  private readonly hiddenExportIntentSessions = new Set<string>()
  private mentionIndex?: MentionIndexState
  private mentionIndexBuild?: MentionIndexBuildState
  private mentionIndexGeneration = 0
  private mentionIndexWatcher?: vscode.FileSystemWatcher
  private mentionWorkspaceSubscription?: vscode.Disposable
  private eventSubscription?: {
    client: DirectAgentClient
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
  private queuedSends: QueuedChatSend[] = []
  private drainingQueuedSends = false
  private sendStatusTimer?: ReturnType<typeof setTimeout>
  private messagePollTimer?: ReturnType<typeof setTimeout>
  private suppressedStreamingSessionID?: string
  private readonly eventTypeCounts = new Map<string, number>()
  private readonly streamingStatePostScheduler: StreamingStatePostScheduler

  constructor(private readonly deps: RemoteChatViewProviderDeps) {
    this.streamingStatePostScheduler = new StreamingStatePostScheduler(
      () => this.postStateNow(),
      STREAMING_STATE_POST_THROTTLE_MS,
    )
    this.startMentionIndexWatcher()
    this.mentionWorkspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.invalidateMentionIndex("workspace folders changed")
      this.restartMentionIndexWatcher()
    })
  }

  dispose() {
    this.mentionIndexWatcher?.dispose()
    this.mentionIndexWatcher = undefined
    this.mentionWorkspaceSubscription?.dispose()
    this.mentionWorkspaceSubscription = undefined
    this.stopEventSubscription()
    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
    this.streamingStatePostScheduler.clear()
  }

  private startMentionIndexWatcher() {
    if (this.mentionIndexWatcher || !vscode.workspace.workspaceFolders?.length) return
    const watcher = vscode.workspace.createFileSystemWatcher("**/*")
    this.mentionIndexWatcher = watcher
    watcher.onDidCreate((uri) => this.handleMentionIndexFileEvent(uri, "created"))
    watcher.onDidDelete((uri) => this.handleMentionIndexFileEvent(uri, "deleted"))
  }

  private restartMentionIndexWatcher() {
    this.mentionIndexWatcher?.dispose()
    this.mentionIndexWatcher = undefined
    this.startMentionIndexWatcher()
  }

  private handleMentionIndexFileEvent(uri: vscode.Uri, reason: "created" | "deleted") {
    if (uri.scheme !== "file") return
    if (!vscode.workspace.getWorkspaceFolder(uri)) return
    const label = relativePath(uri)
    if (isMentionIndexExcludedPath(label)) return
    this.invalidateMentionIndex(`file ${reason}`, uri)
  }

  private invalidateMentionIndex(reason: string, uri?: vscode.Uri) {
    this.mentionIndex = undefined
    this.mentionIndexGeneration += 1
    if (this.mentionIndexBuild && this.mentionIndexBuild.generation < this.mentionIndexGeneration) {
      this.mentionIndexBuild = undefined
    }
    const target = uri ? ` ${relativePath(uri)}` : ""
    this.deps.output.appendLine(`[mention] invalidated ${reason}${target} generation=${this.mentionIndexGeneration}`)
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    this.deps.output.appendLine(`[view] ChipMate using ${CHIPMATE_CHAT_VIEW_ID}`)
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "media")],
    }
    const brandIconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "chipmate-icon.png")).toString()
    const mermaidScriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "vendor", "mermaid", "mermaid.min.js")).toString()
    const codiconFontUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "vendor", "codicon", "codicon.ttf")).toString()
    webviewView.webview.html = createChatViewHtml(webviewView.webview.cspSource, undefined, brandIconUri, mermaidScriptUri, codiconFontUri)
    webviewView.webview.onDidReceiveMessage((message: ChatViewMessage) => {
      void this.handleMessage(message)
    })
    this.postState()
    void this.refreshSkills()
  }

  async reveal() {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.${CHIPMATE_VIEW_CONTAINER_ID}`)
      await vscode.commands.executeCommand(`${RemoteChatViewProvider.viewType}.focus`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[view] Failed to open workbench.view.extension.${CHIPMATE_VIEW_CONTAINER_ID} / ${RemoteChatViewProvider.viewType}.focus: ${message}`)
      vscode.window.setStatusBarMessage("Open ChipMate from the Activity Bar.", 3000)
    }
  }

  setConnectionState(state: ConnectionState, detail = "") {
    this.connectionState = state
    this.connectionDetail = detail
    if (state !== "connected") {
      this.stopEventSubscription()
      this.clearActiveSendState()
      this.clearQueuedSends()
    }
    this.postState()
  }

  async refresh() {
    await this.refreshSkills()
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
      this.reportRemoteConnectionFailure(client, "Failed to refresh ChipMate chat", error)
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

  private ensureEventSubscription(client: DirectAgentClient) {
    const current = this.eventSubscription
    if (current?.client === client && !current.controller.signal.aborted) {
      if (this.eventStreamReady) return Promise.resolve(true)
      if (this.eventStreamFailed) return Promise.resolve(false)
      return current.ready
    }

    return this.startEventSubscription(client, "/event", true)
  }

  private startEventSubscription(client: DirectAgentClient, path: EventStreamPath, allowGlobalFallback: boolean) {
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

  private beginActiveSend(client: DirectAgentClient, sessionID: string) {
    const generation = ++this.activeSendGeneration
    this.activeSend = { client, sessionID, generation }
    return generation
  }

  private startSendStatusWatchdog(client: DirectAgentClient, sessionID: string, generation?: number) {
    this.stopSendStatusWatchdog()
    const activeGeneration = generation ?? ++this.activeSendGeneration
    this.activeSend = { client, sessionID, generation: activeGeneration }
    this.scheduleSendStatusWatchdog(client, sessionID, activeGeneration)
  }

  private scheduleSendStatusWatchdog(client: DirectAgentClient, sessionID: string, generation: number) {
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

  private startMessagePollingFallback(client: DirectAgentClient, sessionID: string, generation = this.activeSend?.generation) {
    if (generation === undefined) return
    this.stopMessagePollingFallback()
    this.scheduleMessagePollingFallback(client, sessionID, generation, 0)
  }

  private scheduleMessagePollingFallback(
    client: DirectAgentClient,
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

  private enqueueChatSend(
    text: string,
    options: ChatContextOptions,
    mentionedFiles: vscode.Uri[],
    mentionedFileRefs = this.mentionedFileRefsFromUris(mentionedFiles),
    clientQueueID?: string,
    contextItems: LocalContextItem[] = this.deps.contextStore.snapshot(),
  ) {
    const trimmed = text.trim()
    if (!trimmed && mentionedFiles.length === 0 && contextItems.length === 0) {
      this.postQueueRejected(clientQueueID, "Type a message or attach context.")
      return false
    }
    if (this.queuedSends.length >= MAX_QUEUED_CHAT_SENDS) {
      const message = `Chat send queue is full (${MAX_QUEUED_CHAT_SENDS}/${MAX_QUEUED_CHAT_SENDS}). Wait for the current reply to finish.`
      this.deps.output.appendLine(`[send-queue] ${message}`)
      this.postQueueRejected(clientQueueID, message)
      this.postQueueUpdated(message, "warning")
      return false
    }

    this.queuedSends = [
      ...this.queuedSends,
      {
        id: this.queuedSendID(clientQueueID),
        text,
        options: { ...options },
        mentionedFiles: [...mentionedFiles],
        mentionedFileRefs: mentionedFileRefs.map((file) => ({ ...file })),
        contextItems: contextItems.map((item) => ({ ...item })),
      },
    ]
    const message = `Queued ${this.queuedSends.length}/${MAX_QUEUED_CHAT_SENDS}.`
    this.deps.output.appendLine(`[send-queue] ${message}`)
    this.postQueueUpdated(message)
    return true
  }

  private clearQueuedSends() {
    if (this.queuedSends.length === 0) return
    this.queuedSends = []
    this.postQueueUpdated("")
  }

  private deleteQueuedSend(id: string | undefined) {
    if (!id) return
    const before = this.queuedSends.length
    this.queuedSends = this.queuedSends.filter((item) => item.id !== id)
    if (this.queuedSends.length === before) return
    this.postQueueUpdated(this.queuedSends.length > 0 ? `Queued ${this.queuedSends.length}/${MAX_QUEUED_CHAT_SENDS}.` : "")
  }

  private editQueuedSend(id: string | undefined) {
    if (!id) return
    const queued = this.queuedSends.find((item) => item.id === id)
    if (!queued) return
    this.queuedSends = this.queuedSends.filter((item) => item.id !== id)
    this.postQueueUpdated(this.queuedSends.length > 0 ? `Queued ${this.queuedSends.length}/${MAX_QUEUED_CHAT_SENDS}.` : "")
    this.deps.contextStore.restore(queued.contextItems)
    this.postState()
    this.view?.webview.postMessage({
      type: "restoreQueuedSendDraft",
      text: queued.text,
      mentionedFiles: queued.mentionedFileRefs,
      options: queued.options,
    })
  }

  private async drainQueuedSends() {
    if (this.drainingQueuedSends || this.sending || this.queuedSends.length === 0) return
    if (this.connectionState !== "connected" || !this.deps.getClient()) return

    this.drainingQueuedSends = true
    try {
      while (!this.sending && this.queuedSends.length > 0 && this.connectionState === "connected" && this.deps.getClient()) {
        const next = this.queuedSends.shift()
        if (!next) continue
        this.postQueueUpdated(this.queuedSends.length > 0 ? `Queued ${this.queuedSends.length}/${MAX_QUEUED_CHAT_SENDS}.` : "")
        const mentioned = await this.resolveExistingMentionedFiles(next.mentionedFileRefs)
        await this.processSendMessage(next.text, next.options, mentioned.uris, next.contextItems)
      }
    } finally {
      this.drainingQueuedSends = false
      this.postState()
    }
  }

  private async cancelActiveSend() {
    const activeSend = this.activeSend
    const sessionID = activeSend?.sessionID
    const client = activeSend?.client
    const controller = this.activeSendController
    if (!this.sending && !controller && !activeSend) return
    this.deps.output.appendLine(`[send] canceled from webview${sessionID ? ` for ${sessionID}` : ""}`)
    controller?.abort()
    this.suppressStreamingEventsForSession(sessionID)
    this.clearActiveSendState()
    this.messages = [...this.messages, localMessage("error", "Request canceled.")]
    this.postState()
    if (!client || !sessionID) {
      void this.drainQueuedSends()
      return
    }

    try {
      const accepted = await withRequestTimeout("session abort", SESSION_ABORT_TIMEOUT_MS, (signal) =>
        client.abortSession(sessionID, signal),
      )
      this.deps.output.appendLine(`[send] agent abort ${sessionID}: ${accepted ? "accepted" : "not accepted"}`)
      if (!accepted) {
        this.messages = [
          ...this.messages,
          localMessage("error", "Stop requested, but the ChipMate runtime did not accept the abort request."),
        ]
        this.postState()
      }
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[send] agent abort ${sessionID} failed: ${message}`)
      this.messages = [
        ...this.messages,
        localMessage("error", `Stop requested, but the ChipMate abort request failed: ${message}`),
      ]
      this.postState()
    }
    void this.drainQueuedSends()
  }

  private suppressStreamingEventsForSession(sessionID: string | undefined) {
    if (!sessionID) return
    this.suppressedStreamingSessionID = sessionID
  }

  private clearStreamingEventSuppression(sessionID?: string) {
    if (!sessionID || this.suppressedStreamingSessionID === sessionID) this.suppressedStreamingSessionID = undefined
  }

  private shouldSuppressStreamingEvent(event: ChipMateEvent, sessionID: string | undefined) {
    return Boolean(sessionID && this.suppressedStreamingSessionID === sessionID && isStreamingMessageEvent(event.type))
  }

  private isActiveSend(client: DirectAgentClient, sessionID: string, generation: number) {
    return (
      this.sending &&
      this.sessionID === sessionID &&
      this.activeSend?.client === client &&
      this.activeSend.sessionID === sessionID &&
      this.activeSend.generation === generation
    )
  }

  private async pollActiveSendStatus(client: DirectAgentClient, sessionID: string, generation: number) {
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
      if (status?.type === "error") {
        await this.failActiveSendWithInterruption(client, sessionID, sessionInterruptionReason(status), generation)
        return
      }
    } catch (error) {
      if (this.isActiveSend(client, sessionID, generation)) this.logEventError("session status poll failed", error)
    }

    if (this.isActiveSend(client, sessionID, generation)) this.scheduleSendStatusWatchdog(client, sessionID, generation)
  }

  private async pollActiveSendMessages(client: DirectAgentClient, sessionID: string, generation: number) {
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
    client: DirectAgentClient,
    sessionID: string,
    status: ChipMateSessionStatus,
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
    void this.drainQueuedSends()
  }

  private async failActiveSendWithInterruption(
    client: DirectAgentClient,
    sessionID: string,
    reason: string,
    generation = this.activeSend?.generation,
  ) {
    if (generation === undefined || !this.isActiveSend(client, sessionID, generation)) return

    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
    const message = chatInterruptedMessage(reason)
    this.deps.output.appendLine(`[send] interrupted ${sessionID}: ${reason}`)
    try {
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("interrupted message refresh failed", error)
    }
    if (!this.isActiveSend(client, sessionID, generation)) return

    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    if (!this.messages.some((item) => item.role === "error" && item.text === message)) {
      this.messages = [...this.messages, localMessage("error", message)]
    }
    this.sending = false
    this.activeSend = undefined
    this.postState()
    void this.drainQueuedSends()
    this.showChatInterruptedWarning(reason)
  }

  private handleRemoteEvent(client: DirectAgentClient, rawEvent: unknown) {
    if (this.deps.getClient() !== client) return
    const event = normalizeChipMateEvent(rawEvent)
    if (!event) return
    this.logRemoteEventType(event.type)
    if (event.type === "server.connected") return

    const eventSessionID = chipMateEventSessionID(event)
    if (this.shouldSuppressStreamingEvent(event, eventSessionID)) {
      this.deps.output.appendLine(`[event] suppressed canceled stream event ${event.type} for ${eventSessionID}`)
      return
    }

    const result = applyChipMateEventToMessages(this.remoteMessages, event, this.sessionID)
    if (result.refreshSessions) {
      void this.refreshSessionList(client)
        .then(() => this.postState())
        .catch((error) => this.logEventError("session refresh failed", error))
    }
    if (result.changed) {
      this.remoteMessages = result.messages
      this.syncRenderedMessages()
      if (isHighFrequencyStreamingMessageEvent(event.type)) this.scheduleStreamingStatePost()
      else this.postState()
    }
    const sessionID = this.sessionID
    if (sessionID && result.error) {
      this.flushStreamingStatePost()
      void this.failActiveSendWithInterruption(client, sessionID, result.error)
      return
    }
    if (sessionID && result.retry) {
      this.flushStreamingStatePost()
      void this.failActiveSendWithRetry(client, sessionID, result.retry)
      return
    }
    if (sessionID && result.interruption) {
      this.flushStreamingStatePost()
      void this.failActiveSendWithInterruption(client, sessionID, sessionInterruptionReason(result.interruption))
      return
    }
    if (sessionID && this.suppressedStreamingSessionID === sessionID && (result.idle || result.completed)) {
      this.flushStreamingStatePost()
      this.clearStreamingEventSuppression(sessionID)
      void this.refreshSessionList(client)
        .then(() => this.postState())
        .catch((error) => this.logEventError("session refresh after canceled stream failed", error))
      return
    }
    if (sessionID && (result.idle || result.completed)) {
      this.flushStreamingStatePost()
      void this.finishStreamingSession(client, sessionID)
    }
  }

  private showChatInterruptedWarning(reason: string) {
    const message = `ChipMate 对话已中断：${truncate(reason, 180)}`
    void vscode.window.showWarningMessage(message, "查看 Output").then((picked) => {
      if (picked === "查看 Output") this.deps.openOutput()
    })
  }

  private logRemoteEventType(type: string) {
    const count = (this.eventTypeCounts.get(type) ?? 0) + 1
    this.eventTypeCounts.set(type, count)
    if (count <= 5 || count % 25 === 0) this.deps.output.appendLine(`[event] ${type} #${count}`)
  }

  private finishActiveStreamAfterEventLoss(client: DirectAgentClient) {
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

  private async finishStreamingSession(client: DirectAgentClient, sessionID: string) {
    if (this.finalizingSessions.has(sessionID)) return
    this.finalizingSessions.add(sessionID)
    let shouldDrainQueuedSends = false
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
        shouldDrainQueuedSends = this.queuedSends.length > 0
        this.postState()
      }
      if (shouldDrainQueuedSends) void this.drainQueuedSends()
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
      this.deps.output.appendLine(`[guard] workspace tools used in ${sessionID}: ${serverToolWarnings.join(", ")}`)
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
    this.clearQueuedSends()
    this.clearStreamingEventSuppression()
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
      this.reportRemoteConnectionFailure(client, "Failed to create ChipMate session", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  refreshState() {
    this.postState()
  }

  private async refreshSkills() {
    if (!this.deps.listSkills) return
    this.loadingSkills = true
    this.skillsError = ""
    this.postState()
    try {
      this.skills = await this.deps.listSkills()
    } catch (error) {
      this.skillsError = formatErrorMessage(error)
    } finally {
      this.loadingSkills = false
      this.postState()
    }
  }

  async sendQuickQuestion(text: string, options: Partial<ChatContextOptions>) {
    await this.reveal()
    await this.handleSendMessage(text, this.contextOptions(options), [])
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
          await this.cancelActiveSend()
          break
        case "addFile":
          await this.addFile()
          break
        case "pickWorkspaceFilesForMessage":
          await this.pickWorkspaceFilesForMessage()
          break
        case "addDroppedFiles":
          await this.addDroppedFiles(message.candidates ?? [])
          break
        case "clearContext":
          this.deps.contextStore.clear()
          this.postState()
          break
        case "removeContextItem":
          if (message.id) this.deps.contextStore.remove(message.id)
          this.postState()
          break
        case "toggleContextPin":
          await this.toggleContextPin(message)
          break
        case "openContextItem":
          await this.openContextItem(message.id)
          break
        case "exportMarkdown":
          await this.exportMarkdown(message.scope ?? "session", message.filenameHint)
          break
        case "deleteQueuedSend":
          this.deleteQueuedSend(message.id)
          break
        case "editQueuedSend":
          this.editQueuedSend(message.id)
          break
        case "selectSession":
          await this.selectSession(message.sessionID)
          break
        case "deleteSession":
          await this.deleteSession(message.sessionID)
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
        case "pauseRagIndexing":
          this.deps.codeGraph?.pauseRagIndexing("requested from RAG UI")
          this.postState()
          break
        case "resumeRagIndexing":
          this.deps.codeGraph?.resumeRagIndexing()
          this.postState()
          break
        case "cancelRagIndexing":
          this.deps.codeGraph?.cancelRagIndexing("requested from RAG UI")
          this.postState()
          break
        case "pauseDocumentRagIndexing":
          this.deps.documentRag?.pauseIndexing("requested from Document RAG UI")
          this.postState()
          break
        case "resumeDocumentRagIndexing":
          this.deps.documentRag?.resumeIndexing()
          this.postState()
          break
        case "rebuildDocumentRag":
          this.deps.documentRag?.rebuild()
          this.postState()
          break
        case "showDocumentRagStatus":
          await this.deps.documentRag?.showStatus()
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
          await this.connectWithSettings(connectionSettingsFromMessage(message), message.requestId)
          break
        case "testWithSettings":
          await this.testWithSettings(connectionSettingsFromMessage(message), message.requestId)
          break
        case "saveCompletionSettings":
          await this.saveCompletionSettings(message.settings)
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
        case "saveSkillsSettings":
          await this.saveSkillsSettings(message.enabled)
          break
        case "savePermissionMode":
          await this.savePermissionMode(message.mode)
          break
        case "saveToolsEnabled":
          await this.saveToolsEnabled(message.enabled)
          break
        case "sendMessage":
          {
            const mentionedFileRefs = await this.resolveExistingMentionedFiles(message.mentionedFiles ?? [])
            await this.handleSendMessage(
              message.text,
              this.contextOptions(message.options),
              mentionedFileRefs.uris,
              mentionedFileRefs.refs,
              message.clientQueueID,
            )
          }
          break
      }
    } catch (error) {
      this.reportError(`ChipMate action failed: ${message.type}`, error)
    }
  }

  private async indexCodeGraph(force: boolean) {
    if (!this.deps.codeGraph) {
      vscode.window.showWarningMessage("Local code graph is not available in this ChipMate view.")
      return
    }
    await this.deps.codeGraph.indexWorkspace(force)
    this.postState()
  }

  private async showCodeGraphStatus() {
    if (!this.deps.codeGraph) {
      vscode.window.showWarningMessage("Local code graph is not available in this ChipMate view.")
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
      this.codeIntelligenceError = "Local code intelligence is not available in this ChipMate view."
      vscode.window.showWarningMessage("Local code intelligence is not available in this ChipMate view.")
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

  private async connectWithSettings(input: ConnectionSettingsInput, requestId?: number) {
    this.deps.output.appendLine(`[connect] requested URL: ${input.serverUrl}`)
    this.clearQueuedSends()
    try {
      await this.deps.connectWithSettings(connectionSettingsForDeps(input))
    } catch (error) {
      this.reportError("ChipMate action failed: connectWithSettings", error)
    } finally {
      this.postConnectionStatus(requestId)
    }
  }

  private async testWithSettings(input: ConnectionSettingsInput, requestId?: number) {
    this.deps.output.appendLine(`[test] requested URL: ${input.serverUrl}`)
    try {
      await this.deps.testWithSettings(connectionSettingsForDeps(input))
    } catch (error) {
      this.reportError("ChipMate action failed: testWithSettings", error)
    } finally {
      this.postConnectionStatus(requestId)
    }
  }

  private postConnectionStatus(requestId?: number) {
    if (requestId === undefined) return
    this.view?.webview.postMessage({
      type: "connectionStatus",
      requestId,
      connectionState: this.connectionState,
      connectionDetail: this.connectionDetail,
    })
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
      const client = new CompletionModelClient(settings, await this.deps.getProviderApiKey())
      const prompt = settings.completion.profile === "qwen-coder-fim"
        ? [
            "<|repo_name|>chipmate-test",
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
      const currentRagSettings = this.deps.getSettings().rag
      const unchanged = ragSettingsInputMatchesCurrent(input, currentRagSettings)
      const embeddingIdentityChanged = ragSettingsInputChangesEmbeddingIdentity(input, currentRagSettings)
      const contentPolicyChanged = Boolean(input.indexTests) !== currentRagSettings.indexTests
      const existingIndexReason = ragExistingIndexConfirmationReason(this.deps.codeGraph?.status().rag)
      let forceRebuild = false
      let preserveExistingIndex = false
      if (contentPolicyChanged) {
        forceRebuild = true
      } else if (existingIndexReason) {
        forceRebuild = await this.confirmForceRagRebuild(embeddingIdentityChanged ? "embedding-change" : existingIndexReason)
        if (!forceRebuild && embeddingIdentityChanged) {
          this.postState()
          this.postRagStatus("RAG settings not saved. Existing local RAG index kept.", "success")
          return
        }
        preserveExistingIndex = !forceRebuild
      }
      if (!unchanged) {
        this.deps.suppressNextRagConfigurationApply?.()
        await saveRagSettings(input)
      }
      const result = await this.deps.codeGraph?.applyRagConfiguration(
        forceRebuild
          ? { forceRebuild: true }
          : preserveExistingIndex
            ? { preserveExistingIndex: true }
            : undefined,
      )
      this.postState()
      if (!result) {
        this.postRagStatus(unchanged ? "RAG settings unchanged." : "RAG settings saved.", "success")
        return
      }
      if (forceRebuild) {
        this.postRagStatus(ragApplyResultMessage(result, "RAG force rebuild requested."), "success")
        return
      }
      if (preserveExistingIndex) {
        this.postRagStatus(`${unchanged ? "RAG settings unchanged." : "RAG settings saved."} Existing local RAG index kept. ${ragStatusMessage(result.status, "RAG status refreshed.")}`, "success")
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

  private async confirmForceRagRebuild(reason: RagRebuildConfirmationReason) {
    const keep = { title: "否，保留现有索引" }
    const force = { title: "是，强制重建" }
    const message = reason === "embedding-change"
      ? "Embedding endpoint 或 model 已变化，保存后旧 RAG 索引不能继续使用，需要从 0 重建。是否保存并强制重建？"
      : reason === "ready"
        ? "本地已有完整 RAG 索引。通常不需要重新 embedding。是否强制删除现有索引并从 0 重建？"
        : "本地已有未完成的 RAG 索引。选择否会保留当前进度并继续索引；选择是会删除现有进度并从 0 重建。"
    const selected = await vscode.window.showWarningMessage(
      message,
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

  private async saveSkillsSettings(enabled: string[]) {
    try {
      await saveSkillsSettings(enabled)
      this.deps.invalidateSkills?.()
      await this.refreshSkills()
      this.postSkillsStatus("Skills settings saved.", "success")
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[skills-settings] save failed: ${message}`)
      this.postSkillsStatus(`Skills settings save failed: ${message}`, "error")
    } finally {
      this.postState()
    }
  }

  private async savePermissionMode(mode: PermissionMode) {
    try {
      await savePermissionMode(mode)
      this.postState()
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[permissions] save failed: ${message}`)
      vscode.window.showErrorMessage(`ChipMate permission mode save failed: ${message}`)
    }
  }

  private async saveToolsEnabled(enabled: boolean) {
    try {
      await saveToolsEnabled(enabled)
      this.postState()
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[tools-settings] save failed: ${message}`)
      vscode.window.showErrorMessage(`ChipMate tools setting save failed: ${message}`)
    }
  }

  private async addFile() {
    const count = await addPickedFilesToContext(this.deps.contextStore)
    this.postState()
    if (count > 0) vscode.window.setStatusBarMessage(`Attached ${count} file(s) to ChipMate context`, 2000)
  }

  private async pickWorkspaceFilesForMessage() {
    const settings = this.deps.getSettings()
    try {
      if (!vscode.workspace.workspaceFolders?.length) {
        this.view?.webview.postMessage({
          type: "workspaceFilesPicked",
          files: [],
          notice: "Open a workspace folder before attaching workspace files.",
        })
        return
      }

      const index = await this.ensureMentionIndex()
      const entries = index.entries.filter((entry) => entry.type === "file" && typeof entry.uri === "string")
      if (entries.length === 0) {
        this.view?.webview.postMessage({
          type: "workspaceFilesPicked",
          files: [],
          notice: "No workspace files are available to attach.",
        })
        return
      }

      const picks: WorkspaceFileQuickPickItem[] = entries.map((entry) => {
        const label = path.posix.basename(entry.label) || entry.label
        const parent = path.posix.dirname(entry.label)
        return {
          label,
          description: parent === "." ? undefined : parent,
          detail: entry.label,
          entry,
        }
      })
      const selected = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Select workspace files to attach to this message",
        title: "Attach Workspace Files",
      })
      if (!selected || selected.length === 0) return

      const files: QueuedMentionedFileRef[] = []
      const seen = new Set<string>()
      let skippedCount = 0
      const maxFiles = Math.max(0, settings.context.maxFiles)

      for (const item of selected) {
        const file = this.mentionFileRefFromEntry(item.entry)
        if (!file || seen.has(file.uri)) {
          skippedCount += 1
          continue
        }
        if (files.length >= maxFiles) {
          skippedCount += 1
          continue
        }

        try {
          const uri = vscode.Uri.parse(file.uri)
          const stat = await vscode.workspace.fs.stat(uri)
          if (stat.type !== vscode.FileType.File) {
            skippedCount += 1
            continue
          }
        } catch {
          skippedCount += 1
          continue
        }

        seen.add(file.uri)
        files.push(file)
      }

      this.view?.webview.postMessage({
        type: "workspaceFilesPicked",
        files,
        notice: pickedWorkspaceFilesNotice(files.length, skippedCount),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[mention] workspace file picker failed: ${message}`)
      this.view?.webview.postMessage({ type: "workspaceFilesPicked", files: [], notice: message })
    }
  }

  private async addDroppedFiles(candidates: string[]) {
    const settings = this.deps.getSettings()
    const resolved = await resolveDroppedFiles(candidates, settings.context.maxFiles)
    this.view?.webview.postMessage({
      type: "droppedFilesResolved",
      files: resolved.files,
      skippedCount: resolved.skippedCount,
      notice: resolved.notice,
    })
  }

  private async toggleContextPin(message: Extract<ChatViewMessage, { type: "toggleContextPin" }>) {
    const pinned = message.pinned !== false
    if (message.id) {
      const item = this.deps.contextStore.setLifetime(message.id, pinned ? "persistent" : "one-shot")
      if (!item) this.deps.output.appendLine(`[context] pin skipped missing item id=${message.id}`)
      this.postState()
      return
    }

    if (!message.file || !pinned) return
    const mentioned = await this.resolveExistingMentionedFiles([message.file])
    const uri = mentioned.uris[0]
    if (!uri) {
      this.view?.webview.postMessage({ type: "workspaceFilesPicked", files: [], notice: "Pinned context file is no longer available." })
      return
    }
    this.deps.contextStore.addFile(uri, "persistent")
    this.postState()
  }

  private async openContextItem(id: string | undefined) {
    const item = id ? this.deps.contextStore.item(id) : undefined
    if (!item) {
      vscode.window.showWarningMessage("ChipMate context item is no longer available.")
      this.postState()
      return
    }
    const document = await vscode.workspace.openTextDocument(item.uri)
    const editor = await vscode.window.showTextDocument(document, { preview: true })
    if (item.kind !== "selection") return
    const startLine = Math.max(0, Math.min(item.startLine - 1, document.lineCount - 1))
    const endLine = Math.max(startLine, Math.min(item.endLine - 1, document.lineCount - 1))
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
    editor.selection = new vscode.Selection(range.start, range.end)
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  private async selectSession(sessionID: string) {
    const client = this.connectedClient("Connect before selecting a session.")
    if (!client || !sessionID) return

    this.clearActiveSendState()
    this.clearQueuedSends()
    this.clearStreamingEventSuppression()
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
          this.reportRemoteConnectionFailure(client, "Failed to recover ChipMate session", recoverError)
        }
        return
      }
      this.reportRemoteConnectionFailure(client, "Failed to load ChipMate session", error)
    } finally {
      this.loadingMessages = false
      this.postState()
    }
  }

  private async deleteSession(sessionID: string) {
    const client = this.connectedClient("Connect before deleting a session.")
    if (!client || !sessionID) return

    const session = this.sessions.find((item) => item.id === sessionID)
    const title = session?.title || "Untitled chat"
    const confirmed = await vscode.window.showWarningMessage(
      `Delete chat history "${truncate(title, 80)}"? This removes the locally saved session.`,
      { modal: true },
      "Delete",
    )
    if (confirmed !== "Delete") return

    const wasCurrent = this.sessionID === sessionID
    if (this.activeSend?.sessionID === sessionID) await this.cancelActiveSend()
    if (wasCurrent) this.clearQueuedSends()

    if (wasCurrent) {
      this.loadingMessages = true
      this.postState()
    }

    try {
      await withRequestTimeout("delete session", SESSION_REFRESH_TIMEOUT_MS, (signal) =>
        client.deleteSession(sessionID, signal),
      )
      this.sessions = this.sessions.filter((item) => item.id !== sessionID)
      if (wasCurrent) {
        this.clearMissingSession(sessionID)
      }
      await this.refreshSessionList(client)
      if (wasCurrent) {
        this.reconcileSessionSelection()
        await this.loadSelectedSessionMessages(client)
      }
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
    const config = vscode.workspace.getConfiguration("chipmate")
    await config.update("provider.chatModel", normalized, vscode.ConfigurationTarget.Global)
    this.modelError = ""
    this.deps.output.appendLine(`[model] selected ${normalized || "configured default"}`)
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

  private async ensureMentionIndex(): Promise<MentionIndexState> {
    if (this.mentionIndex && this.mentionIndex.generation === this.mentionIndexGeneration) {
      return this.mentionIndex
    }

    const generation = this.mentionIndexGeneration
    if (!this.mentionIndexBuild || this.mentionIndexBuild.generation !== generation) {
      this.mentionIndexBuild = {
        generation,
        promise: this.buildMentionIndex(generation),
      }
    }

    const build = this.mentionIndexBuild
    const index = await build.promise.finally(() => {
      if (this.mentionIndexBuild === build) this.mentionIndexBuild = undefined
    })
    if (this.mentionIndexGeneration !== build.generation) {
      return this.ensureMentionIndex()
    }
    this.mentionIndex = index
    return index
  }

  private async buildMentionIndex(generation: number): Promise<MentionIndexState> {
    if (!vscode.workspace.workspaceFolders?.length) return { entries: [], truncated: false, generation }

    const files = await vscode.workspace.findFiles(
      "**/*",
      MENTION_INDEX_EXCLUDE_GLOB,
      MENTION_INDEX_LIMIT + 1,
    )
    const visibleFiles = files.filter((uri) => !isMentionIndexExcludedPath(relativePath(uri)))
    const truncated = visibleFiles.length > MENTION_INDEX_LIMIT
    const sourceFiles = visibleFiles.slice(0, MENTION_INDEX_LIMIT).map((uri) => ({
      uri: uri.toString(),
      label: relativePath(uri),
    }))
    const entries = buildMentionIndex(sourceFiles)
    this.deps.output.appendLine(
      `[mention] indexed ${sourceFiles.length} file(s), ${entries.filter((entry) => entry.type === "folder").length} folder(s)${
        truncated ? " (truncated)" : ""
      }`,
    )
    return { entries, truncated, generation }
  }

  private async sendMessage(
    text: string,
    options: ChatContextOptions,
    mentionedFiles: vscode.Uri[],
    contextItems: LocalContextItem[] = this.deps.contextStore.snapshot(),
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed && mentionedFiles.length === 0 && contextItems.length === 0) return false
    if (this.sending) {
      const enqueued = this.enqueueChatSend(text, options, mentionedFiles, undefined, undefined, contextItems)
      if (enqueued && !this.shouldPreserveOneShotContext(text)) this.deps.contextStore.consumeOneShot(contextItems)
      return enqueued
    }

    const client = this.connectedClient("Configure a ChipMate provider before sending.")
    if (!client) return false

    this.clearStreamingEventSuppression()
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
      if (controller.signal.aborted) return false
      const agentSelection = this.agentForSettings(settings)
      if (!agentSelection.ready) {
        throw new MissingLocalOnlyAgentError(agentSelection.warning ?? "Required VS Code local agent is not available.")
      }
      const modelSelection = this.modelForSettings(settings)
      strictAgentHint = agentSelection.strict
        ? " Confirm the ChipMate workspace agent is available."
        : ""
      await this.waitForCodeGraphReady(settings)
      let contextSummary: ContextSummaryItem[] = []
      const prompt = await buildChatPrompt({
        question: trimmed || "Please review the referenced files.",
        options,
        settings,
        contextStore: this.deps.contextStore,
        contextItems,
        mentionedFiles,
        editorContext: this.deps.getEditorContext(),
        codeGraph: this.deps.codeGraph,
        documentRag: this.deps.documentRag,
        onContextSummary: (items) => {
          contextSummary = items
          this.lastContextSummary = items
        },
      })
      if (controller.signal.aborted) return false
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
      if (sentStreaming) this.deps.contextStore.consumeOneShot(contextItems)
      return sentStreaming
    } catch (error) {
      if (controller.signal.aborted) return false
      let finalError = error
      if (preparedMessage && isSessionNotFoundError(error)) {
        try {
          this.clearMissingSession(this.sessionID)
          this.deps.output.appendLine("[session] Selected ChipMate session was not found; retrying with a new session.")
          sentStreaming = await this.sendPreparedMessage(client, preparedMessage, controller.signal)
          if (sentStreaming) this.deps.contextStore.consumeOneShot(contextItems)
          return sentStreaming
        } catch (retryError) {
          if (controller.signal.aborted) return false
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
        return false
      }
      if (error instanceof CodeGraphReadinessError || finalError instanceof CodeGraphReadinessError) {
        this.messages = this.messages.filter((messageItem) => messageItem.id !== optimistic.id)
        this.pendingLocalUserMessageIDs.delete(optimistic.id)
        this.pendingLocalUserTexts.delete(optimistic.text)
        this.messages = [...this.messages, localMessage("error", message)]
        this.deps.output.appendLine(`[codegraph] blocked send: ${message}`)
        return false
      }
      this.pendingLocalUserMessageIDs.delete(optimistic.id)
      this.pendingLocalUserTexts.delete(optimistic.text)
      this.messages = [...this.messages, localMessage("error", `Failed to send message: ${message}`)]
      this.reportRemoteConnectionFailure(client, "Failed to send message to ChipMate", finalError, message)
      return false
    } finally {
      this.codeGraphWaitDetail = ""
      if (this.activeSendController === controller) this.activeSendController = undefined
      if (!sentStreaming && !controller.signal.aborted) {
        this.sending = false
        this.activeSend = undefined
        this.stopSendStatusWatchdog()
        this.stopMessagePollingFallback()
      }
      this.postState()
      if (!sentStreaming && !controller.signal.aborted) void this.drainQueuedSends()
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

  private async getOrCreateSession(client: DirectAgentClient, signal?: AbortSignal) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession(CHAT_SESSION_TITLE, signal)
    this.sessionID = session.id
    await this.refreshSessionList(client)
    return session.id
  }

  private async sendPreparedMessage(
    client: DirectAgentClient,
    input: { text: string; model?: PromptModel; agent?: string },
    signal?: AbortSignal,
  ) {
    const sessionID = await this.getOrCreateSession(client, signal)
    const generation = this.beginActiveSend(client, sessionID)
    const canStream = await this.ensureEventSubscription(client)
    await client.sendMessageAsync({
      sessionID,
      text: input.text,
      model: input.model,
      agent: input.agent,
      signal,
    })

    if (this.isActiveSend(client, sessionID, generation)) {
      this.startSendStatusWatchdog(client, sessionID, generation)
      if (!canStream || this.eventStreamFailed || !this.eventStreamReady) {
        this.deps.output.appendLine("[event] live stream unavailable; using async message polling fallback")
        this.startMessagePollingFallback(client, sessionID, generation)
      }
    }

    await this.refreshSessionList(client)
    return true
  }

  private async refreshSessionList(client: DirectAgentClient) {
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
      this.deps.output.appendLine(`[session] ChipMate session ${this.sessionID} is no longer available; clearing selection.`)
    }
    this.sessionID = this.sessions[0]?.id
    if (!this.sessionID) {
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
    }
  }

  private async loadSelectedSessionMessages(client: DirectAgentClient) {
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

  private async recoverMissingSession(client: DirectAgentClient, sessionID: string) {
    this.clearMissingSession(sessionID)
    this.deps.output.appendLine(`[session] ChipMate session ${sessionID} was not found; refreshing sessions.`)
    await this.refreshSessionList(client)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    this.reconcileSessionSelection()
  }

  private clearMissingSession(sessionID: string | undefined) {
    if (sessionID && this.sessionID && this.sessionID !== sessionID) return
    this.clearStreamingEventSuppression(sessionID)
    this.sessionID = undefined
    this.remoteMessages = []
    this.pendingLocalUserMessageIDs.clear()
    this.pendingLocalUserTexts.clear()
    this.messages = []
  }

  private async loadSessionMessages(client: DirectAgentClient, sessionID: string) {
    this.clearStreamingEventSuppression(sessionID)
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

  private async hideCompletionSession(client: DirectAgentClient, sessionID: string) {
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

  private async hideExternalSession(client: DirectAgentClient, sessionID: string) {
    this.hiddenExternalSessions.add(sessionID)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.remoteMessages = []
      this.pendingLocalUserMessageIDs.clear()
      this.pendingLocalUserTexts.clear()
      this.messages = []
    }
    this.deps.output.appendLine(`[history] Hidden external ChipMate session ${sessionID}.`)
    await this.refreshSessionList(client)
    this.reconcileSessionSelection()
  }

  private isVisibleChatSession(session: ChipMateSession) {
    if (this.hiddenCompletionSessions.has(session.id)) return false
    if (this.hiddenExternalSessions.has(session.id)) return false
    if (this.hiddenExportIntentSessions.has(session.id)) return false
    if (isInlineCompletionSession(session)) return false
    return isPluginChatSession(session)
  }

  private async refreshModelList(client: DirectAgentClient) {
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

  private async refreshAgentList(client: DirectAgentClient) {
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

  private async ensureAgentList(client: DirectAgentClient, settings: RemoteSettings) {
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
    const selected = settings.provider.chatModel.trim()
    return {
      model: undefined,
      label: selected || "provider default",
    }
  }

  private async resolveExistingMentionedFiles(files: MentionedFileRef[]) {
    const uris: vscode.Uri[] = []
    const refs: QueuedMentionedFileRef[] = []
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
        const stat = await vscode.workspace.fs.stat(uri)
        if (stat.type !== vscode.FileType.File) {
          this.deps.output.appendLine(`[mention] skipped missing/stale file: ${relativePath(uri)}`)
          continue
        }
        uris.push(uri)
        refs.push({
          uri: key,
          label: file.label || relativePath(uri),
          type: "file",
          insertText: file.insertText,
        })
      } catch {
        this.deps.output.appendLine(`[mention] skipped missing/stale file: ${file.uri}`)
      }
    }
    return { uris, refs }
  }

  private mentionedFileRefsFromUris(uris: vscode.Uri[]) {
    return uris.map((uri) => ({
      uri: uri.toString(),
      label: relativePath(uri),
      type: "file" as const,
    }))
  }

  private mentionFileRefFromEntry(entry: MentionIndexEntry): QueuedMentionedFileRef | undefined {
    if (entry.type !== "file" || !entry.uri) return undefined
    try {
      const uri = vscode.Uri.parse(entry.uri)
      if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) return undefined
      const label = entry.label || relativePath(uri)
      return {
        uri: uri.toString(),
        label,
        type: "file",
        insertText: entry.insertText || label,
      }
    } catch {
      return undefined
    }
  }

  private async handleSendMessage(
    text: string,
    options: ChatContextOptions,
    mentionedFiles: vscode.Uri[],
    mentionedFileRefs = this.mentionedFileRefsFromUris(mentionedFiles),
    clientQueueID?: string,
  ) {
    const mentioned = await this.resolveExistingMentionedFiles(mentionedFileRefs)
    const contextItems = this.deps.contextStore.snapshot()
    if (this.sending) {
      const enqueued = this.enqueueChatSend(text, options, mentioned.uris, mentioned.refs, clientQueueID, contextItems)
      if (enqueued && !this.shouldPreserveOneShotContext(text)) {
        this.deps.contextStore.consumeOneShot(contextItems)
        this.postState()
      }
      return
    }

    await this.processSendMessage(text, options, mentioned.uris, contextItems)
  }

  private shouldPreserveOneShotContext(text: string) {
    return Boolean(parseExplicitExportCommand(text) || isExportIntentCandidate(text))
  }

  private async processSendMessage(
    text: string,
    options: ChatContextOptions,
    mentionedFiles: vscode.Uri[],
    contextItems: LocalContextItem[] = this.deps.contextStore.snapshot(),
  ): Promise<boolean> {
    const explicitExport = parseExplicitExportCommand(text)
    if (explicitExport) {
      await this.exportMarkdown(explicitExport.scope, explicitExport.filenameHint)
      return false
    }

    if (isExportIntentCandidate(text)) {
      const client = this.deps.getClient()
      if (client && this.connectionState === "connected") {
        const decision = await this.classifyExportIntent(client, text)
        if (decision.intent === "export") {
          await this.exportMarkdown(decision.scope, decision.filenameHint)
          return false
        }
      }
      this.postExportStatus("")
    }

    return this.sendMessage(text, options, mentionedFiles, contextItems)
  }

  private async classifyExportIntent(client: DirectAgentClient, text: string) {
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
      title: "Export ChipMate chat as Markdown",
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

  private postSkillsStatus(message: string, status = "info") {
    this.view?.webview.postMessage({
      type: "skillsStatus",
      message,
      status,
    })
  }

  private queuedSendID(clientQueueID: string | undefined) {
    const candidate = typeof clientQueueID === "string" ? clientQueueID.trim() : ""
    if (candidate && !this.queuedSends.some((item) => item.id === candidate)) return candidate
    return `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  private queuedSendSnapshot() {
    return {
      queuedSends: this.queuedSends.map((item) => ({
        id: item.id,
        text: item.text,
        options: item.options,
        mentionedFiles: item.mentionedFileRefs,
      })),
      queuedSendCount: this.queuedSends.length,
      queuedSendLimit: MAX_QUEUED_CHAT_SENDS,
    }
  }

  private postQueueUpdated(message = "", status = "info") {
    this.view?.webview.postMessage({
      type: "queueUpdated",
      ...this.queuedSendSnapshot(),
      message,
      status,
    })
  }

  private postQueueRejected(clientQueueID: string | undefined, message: string) {
    if (!clientQueueID) return
    this.view?.webview.postMessage({
      type: "queueRejected",
      clientQueueID,
      message,
      status: "warning",
    })
  }

  private postState() {
    this.streamingStatePostScheduler.clear()
    this.postStateNow()
  }

  private scheduleStreamingStatePost() {
    this.streamingStatePostScheduler.schedule()
  }

  private flushStreamingStatePost() {
    this.streamingStatePostScheduler.flush()
  }

  private postStateNow() {
    const settings = this.deps.getSettings()
    const agentSelection = this.agentForSettings(settings)
    this.view?.webview.postMessage({
      type: "state",
      state: {
        connectionState: this.connectionState,
        connectionDetail: this.connectionDetail,
        serverUrl: settings.serverUrl,
        username: settings.provider.chatModel,
        provider: settings.provider,
        permissions: settings.permissions,
        tools: settings.tools,
        defaults: {
          includeDiagnostics: settings.context.includeDiagnostics,
          includeGitDiff: settings.context.includeGitDiff,
        },
        completion: settings.completion,
        skills: {
          enabled: settings.skills.enabled,
          available: this.skills,
          loading: this.loadingSkills,
          error: this.skillsError,
        },
        mcp: settings.mcp,
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
        contextItems: this.deps.contextStore.viewItems(),
        codeGraph: this.deps.codeGraph?.status(),
        documentRag: this.deps.documentRag?.status(),
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
        sendCancellable: this.sending && Boolean(this.activeSendController || this.activeSend),
        queuedSends: this.queuedSends.map((item) => ({
          id: item.id,
          text: item.text,
          options: item.options,
          mentionedFiles: item.mentionedFileRefs,
        })),
        queuedSendCount: this.queuedSends.length,
        queuedSendLimit: MAX_QUEUED_CHAT_SENDS,
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
    client: DirectAgentClient,
    prefix: string,
    error: unknown,
    detailMessage = formatErrorMessage(error),
  ) {
    const detail = `${prefix}: ${detailMessage}`
    const state = connectionFailureState(error)
    this.historyError = detail
    this.deps.output.appendLine(`[history] ${detail}`)
    this.clearQueuedSends()
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

function renderSession(session: ChipMateSession, serverToolsUsed = false): RenderedSession {
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

function isStreamingMessageEvent(type: string) {
  return type === "message.updated" || type === "message.part.updated" || type === "message.part.delta"
}

function isHighFrequencyStreamingMessageEvent(type: string) {
  return type === "message.part.updated" || type === "message.part.delta"
}

function connectionFailureState(error: unknown): ConnectionState {
  if (isRequestTimeoutError(error)) return "error"
  return "error"
}

function isRequestTimeoutError(error: unknown) {
  return error instanceof Error && /\btimed out after \d+ms\b/i.test(error.message)
}

function isSessionNotFoundError(error: unknown) {
  return error instanceof Error && /\bsession\b/i.test(error.message) && /\bnot\s+found\b/i.test(error.message)
}

function messageText(message: ChipMateMessage) {
  return message.parts
    .flatMap((part) => part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [])
    .join("")
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
  return `Local code graph is not ready: ${detail} Rebuild the local code graph or disable chipmate.codeGraph.enabled before sending.`
}

function remoteRetryMessage(status: ChipMateSessionStatus) {
  const attempt = "attempt" in status && typeof status.attempt === "number" ? `（第 ${status.attempt} 次）` : ""
  const detail =
    "message" in status && typeof status.message === "string" && status.message.trim()
      ? `：${status.message.trim()}`
      : ""
  return `远端 ChipMate 正在重试模型请求${attempt}${detail}。当前会话可能过大，可以新建会话后重试。`
}

function sessionInterruptionReason(status: ChipMateSessionStatus) {
  if ("message" in status && typeof status.message === "string" && status.message.trim()) {
    return status.message.trim()
  }
  return "模型流式响应提前中断，未返回可用原因。"
}

function chatInterruptedMessage(reason: string) {
  return `对话已中断：${reason}`
}

function renderMessage(message: ChipMateMessage): RenderedMessage {
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
  if (split.reasoning || split.openThinking) {
    parts.unshift({
      type: "reasoning",
      title: "Thinking",
      status: split.openThinking ? "running" : undefined,
      detail: split.reasoning,
      preview: split.preview,
    })
  }
  const serverToolWarnings = parts
    .filter((part) => part.type === "tool" && isWorkspaceFilesystemTool(part.title))
    .map((part) => ({
      type: "serverToolWarning",
      title: part.title,
      detail: `Workspace filesystem tool used: ${part.title}. This reply may have read code through ChipMate tool permissions.`,
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

function isExternalChatMessage(message: ChipMateMessage) {
  return message.info.role === "user" && !isPluginChatMessage(message)
}

function renderPart(part: ChipMatePart): RenderedPart {
  if (part.type === "text" && "text" in part && typeof part.text === "string") {
    return {
      type: part.type,
      text: part.text,
    }
  }
  if (part.type === "tool") {
    return {
      type: "tool",
      title: displayToolName("tool" in part && typeof part.tool === "string" ? part.tool : "tool"),
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
  return extractPluginChatQuestionText(text)
}

function localMessage(role: string, text: string, overrides: Partial<RenderedMessage> = {}): RenderedMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    timeCreated: Date.now(),
    parts: [{ type: "text", text }],
    ...overrides,
  }
}

function displayToolName(tool: string) {
  return tool === "chipmate_read_file" ? "chipmate_read" : tool
}

function toolStatus(part: ChipMatePart) {
  const state = toolState(part)
  if (typeof state?.status === "string") return state.status
  if (state?.error) return "error"
  return "called"
}

function toolDetail(part: ChipMatePart) {
  const state = toolState(part)
  const detail = {
    input: state?.input,
    output: state?.output,
    error: state?.error,
    metadata: state?.metadata,
  }
  return truncate(JSON.stringify(detail, null, 2), 4000)
}

function toolState(part: ChipMatePart) {
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

const WORKSPACE_FILESYSTEM_TOOLS = new Set(["read", "glob", "grep", "list", "bash", "edit", "write", "patch", "multiedit", "external_directory", "lsp"])

function isWorkspaceFilesystemTool(tool: string | undefined) {
  if (!tool) return false
  return WORKSPACE_FILESYSTEM_TOOLS.has(tool.toLowerCase())
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

function ragExistingIndexConfirmationReason(rag: RagStatus | undefined): Exclude<RagRebuildConfirmationReason, "embedding-change"> | undefined {
  if (!rag) return undefined
  if (rag.availability === "ready" || rag.indexAvailability === "ready") return "ready"
  if (
    rag.availability === "partial"
    || rag.availability === "paused"
    || rag.availability === "indexing"
    || rag.indexAvailability === "partial"
    || rag.indexAvailability === "paused"
    || Boolean(rag.indexProgress)
  ) {
    return "incomplete"
  }
  return undefined
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
  if (reason === "manual") return `paused by user${suffix}`
  return `indexing paused${suffix}`
}

function ragResumeScheduleMessage(rag: RagStatus) {
  if (!rag.resumeScheduledAt || !rag.resumeReason) return ""
  const remainingMs = Math.max(0, rag.resumeScheduledAt - Date.now())
  const label = rag.resumeReason === "rate-limit" ? "retry scheduled" : "resume scheduled"
  return `; ${label} in ${Math.ceil(remainingMs / 1000)}s`
}

function pickedWorkspaceFilesNotice(fileCount: number, skippedCount: number) {
  if (fileCount === 0) return skippedCount > 0 ? "Selected files could not be attached to this message." : ""
  const attached = `Attached ${fileCount} file${fileCount === 1 ? "" : "s"} to this message.`
  const skipped = skippedCount > 0 ? ` Skipped ${skippedCount} item${skippedCount === 1 ? "" : "s"}.` : ""
  return `${attached}${skipped}`
}

async function resolveDroppedFiles(candidates: string[], maxFiles: number): Promise<{ files: MentionedFileRef[]; skippedCount: number; notice: string }> {
  const files: MentionedFileRef[] = []
  const seen = new Set<string>()
  let skippedCount = 0
  const limit = Math.max(1, maxFiles)

  for (const uri of droppedFileUriCandidates(candidates)) {
    if (files.length >= limit) {
      skippedCount += 1
      continue
    }
    if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) {
      skippedCount += 1
      continue
    }
    const key = uri.toString()
    if (seen.has(key)) {
      skippedCount += 1
      continue
    }
    seen.add(key)

    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (!isRegularDroppedFile(stat)) {
        skippedCount += 1
        continue
      }
    } catch {
      skippedCount += 1
      continue
    }

    const label = relativePath(uri)
    files.push({
      uri: key,
      label,
      type: "file",
      insertText: label,
    })
  }

  if (files.length === 0) {
    return {
      files,
      skippedCount,
      notice: skippedCount > 0
        ? "Drop workspace files from VS Code, or use Attach/@mention for other files."
        : "No workspace file path was found in the drop. Use Attach or @mention to add files.",
    }
  }

  const added = `Added ${files.length} dropped file${files.length === 1 ? "" : "s"} to this message.`
  const skipped = skippedCount > 0 ? ` Skipped ${skippedCount} unsupported item${skippedCount === 1 ? "" : "s"}.` : ""
  return { files, skippedCount, notice: `${added}${skipped}` }
}

function droppedFileUriCandidates(candidates: string[]) {
  const result: vscode.Uri[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    for (const candidate of String(raw || "").split(/\r?\n/)) {
      for (const uri of droppedFileUrisForCandidate(candidate)) {
        const key = uri.toString()
        if (seen.has(key)) continue
        seen.add(key)
        result.push(uri)
      }
    }
  }
  return result
}

function droppedFileUrisForCandidate(raw: string) {
  const candidate = normalizeDroppedFileCandidate(raw)
  if (!candidate || candidate.startsWith("#")) return []
  if (/^file:/i.test(candidate)) {
    try {
      const uri = vscode.Uri.parse(candidate)
      return uri.scheme === "file" ? [uri] : []
    } catch {
      return []
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) return []
  if (path.isAbsolute(candidate)) return [vscode.Uri.file(candidate)]

  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => vscode.Uri.file(path.resolve(folder.uri.fsPath, candidate)))
}

function normalizeDroppedFileCandidate(raw: string) {
  const trimmed = raw.trim().replace(/\0/g, "")
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function isRegularDroppedFile(stat: vscode.FileStat) {
  return Boolean(stat.type & vscode.FileType.File) && !Boolean(stat.type & vscode.FileType.Directory)
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
