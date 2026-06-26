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
import { createChatViewHtml, createNonce, type HistoryToolbarIconName, type HistoryToolbarIconUris } from "./chat-html"
import { CHAT_SESSION_TITLE, classifyChatSessionSource, extractPluginChatQuestionText, isPluginChatSession, pluginHistoryUserText } from "./chat-session"
import { StreamingStatePostScheduler } from "./chat-state-post-scheduler"
import { loadDrawioRuntimeHtml } from "./drawio-runtime-html"
import { decodeDrawioPngDataUri, drawioPngFilename, decodePngDataUri, pngExportFilename } from "./drawio-export"
import { applyChipMateEventToMessages, normalizeChipMateEvent, chipMateEventSessionID } from "./chat-stream"
import {
  chatSendFingerprint,
  mergeRenderedChatMessages,
  sendStatusForStage,
  type ChatSendStage,
  type PendingChatUserMessage,
  type SendStatusView,
} from "./chat-message-state"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { CodeIntelligenceSnapshot } from "./analysis-types"
import { CompletionModelClient, completionApiBaseUrl, completionModel } from "./completion-model-client"
import { isInlineCompletionMessage, isInlineCompletionSession } from "./completion-session"
import { CHIPMATE_CHAT_VIEW_ID, CHIPMATE_COMMANDS, CHIPMATE_VIEW_CONTAINER_ID } from "./chipmate-constants"
import {
  addPickedFilesToContext,
  buildChatPromptWithEvidence,
  type ContextSummaryItem,
  type LocalContextItem,
  type MentionedContextRef,
  LocalContextStore,
  MissingLocalContextError,
  relativePath,
} from "./context"
import type { DocumentRagContextProvider } from "./document-rag"
import { ChipMateDocModelProvider } from "./docAgent/ChipMateDocModelProvider"
import { GuidelineReferencePackFlow } from "./docAgent/DocumentAgentFlow"
import { DocxIntentDetector } from "./docAgent/DocxIntentDetector"
import type {
  ConflictResolutionChoice,
  ConflictResolutionDecision,
  ConflictRule,
  DocAgentTimelineEvent,
  DocAgentModelWaitEvent,
  GeneratedDocumentResult,
} from "./docAgent/types"
import type { TrackedEditorContext } from "./editor-context"
import { MissingLocalOnlyAgentError, selectRequestAgent } from "./local-agent"
import { buildMentionIndex, isMentionIndexExcludedPath, searchMentionIndex, type MentionIndexEntry } from "./mention-index"
import { DirectAgentClient } from "./direct-agent-client"
import type { SkillMetadata } from "./skills"
import { importSkills, type SkillImportResult } from "./skill-importer"
import { splitThinkingFromParts } from "./thinking"
import { summarizeSessionUsage, usageFromMessageInfo } from "./usage"
import type {
  ChatContextOptions,
  ConnectionState,
  EvidenceLedgerEntry,
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

const HISTORY_TOOLBAR_ICON_FILES: Record<HistoryToolbarIconName, string> = {
  enterSelection: "history-enter-selection.svg",
  selectAll: "history-select-all.svg",
  deselectAll: "history-deselect-all.svg",
  delete: "history-delete.svg",
  refresh: "history-refresh.svg",
  close: "history-close.svg",
}

const SESSION_MESSAGE_LIMIT = 100
const MODEL_REFRESH_TIMEOUT_MS = 8000
const AGENT_REFRESH_TIMEOUT_MS = 8000
const SESSION_REFRESH_TIMEOUT_MS = 8000
const MESSAGE_REFRESH_TIMEOUT_MS = 5000
const SESSION_STATUS_TIMEOUT_MS = 5000
const SESSION_ABORT_TIMEOUT_MS = 5000
const SESSION_TITLE_TIMEOUT_MS = 4000
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
const MENTION_INDEX_EXCLUDE_GLOB = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode-test/**}"

type EventStreamPath = "/event" | "/global/event"
type RagRebuildConfirmationReason = "ready" | "incomplete" | "embedding-change"

type MentionedFileRef = {
  uri: string
  label: string
  type?: "file" | "folder"
  insertText?: string
  mentionIndex?: number
}

type QueuedMentionedFileRef = MentionedFileRef & {
  uri: string
  type: "file" | "folder"
}

type WorkspaceFileQuickPickItem = vscode.QuickPickItem & {
  entry: MentionIndexEntry
}

type ChatViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "refreshSessions" }
  | { type: "openAgentTerminal" }
  | { type: "openOutput" }
  | { type: "newSession" }
  | { type: "cancelSend" }
  | { type: "addFile" }
  | { type: "pickWorkspaceFilesForMessage" }
  | { type: "addDroppedFiles"; candidates?: string[] }
  | { type: "pickSkillImport" }
  | { type: "importSkillCandidates"; candidates?: string[] }
  | { type: "clearContext" }
  | { type: "removeContextItem"; id?: string }
  | { type: "toggleContextPin"; id?: string; pinned?: boolean; file?: MentionedFileRef }
  | { type: "openContextItem"; id?: string }
  | { type: "exportMarkdown"; scope?: ExportScope; filenameHint?: string }
  | {
      type: "registerDiagramVisualEvidence"
      sessionID?: string
      messageId?: string
      diagramId?: string
      kind?: "drawio" | "mermaid"
      title?: string
      sourceHash?: string
      dataUri?: string
      width?: number
      height?: number
    }
  | { type: "exportDrawioImage"; diagramId?: string; filenameHint?: string; dataUri?: string }
  | {
      type: "drawioRenderTelemetry"
      phase?: string
      code?: string
      message?: string
      mode?: string
      requestId?: string
      runtime?: string
      frameSrc?: string
      usesCdn?: boolean
    }
  | { type: "exportMermaidImage"; format?: "png"; filenameHint?: string; dataUrl?: string }
  | { type: "deleteQueuedSend"; id?: string }
  | { type: "editQueuedSend"; id?: string }
  | { type: "selectSession"; sessionID: string }
  | { type: "deleteSession"; sessionID: string }
  | { type: "deleteSessions"; sessionIDs: string[] }
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
  | { type: "openGeneratedDocument"; path?: string; mode?: "external" | "reveal" }
  | { type: "resolveDocAgentConflict"; requestId?: string; choices?: Array<{ conflictId?: string; choice?: ConflictResolutionChoice }> }
  | { type: "resolveToolApproval"; requestId?: string; approved?: boolean }
  | { type: "answerClarification"; requestId?: string; answers?: Array<{ questionId?: string; choiceId?: string; text?: string }> }
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
  kind?: string
  title?: string
  text?: string
  xml?: string
  status?: string
  detail?: string
  preview?: string
  source?: string
  diagramId?: string
  toolCallID?: string
  path?: string
  absolutePath?: string
  sourceCount?: number
  warningCount?: number
  warnings?: string[]
  approvalRequestId?: string
  approvalTitle?: string
  approvalSummary?: string
  approvalRisk?: string
  approvalReason?: string
  approvalPath?: string
  approvalBytes?: number
  approvalActions?: string[]
  clarificationId?: string
  questions?: Array<{
    id: string
    question: string
    choices?: Array<{ id: string; label: string; description?: string }>
    allowFreeText?: boolean
  }>
  answers?: Array<{ questionId: string; choiceId?: string; text?: string }>
  events?: DocAgentTimelineEvent[]
  startedAt?: number
  current?: number
  total?: number
  fallbackCount?: number
  conflictCount?: number
  requestId?: string
  conflicts?: RenderedDocAgentConflict[]
}

type RenderedDocAgentConflict = {
  id: string
  title: string
  internalSource: string
  externalSource: string
  internalSummary: string
  externalSummary: string
  recommendation: string
  choice?: ConflictResolutionChoice
}

type PendingDocAgentConflictResolution = {
  requestId: string
  messageId: string
  resolve: (decisions: ConflictResolutionDecision[]) => void
  reject: (error: Error) => void
  dispose: () => void
}

type RenderedMessage = {
  id: string
  role: string
  text: string
  timeCreated?: number
  timeCompleted?: number
  parts: RenderedPart[]
  sendStatus?: SendStatusView
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
  startedAt: number
  fingerprint?: string
}

type ActiveSendActivity = {
  stage: ChatSendStage
  detail: string
  startedAt?: number
  currentToolName?: string
  toolCallCount: number
}

type QueuedChatSend = {
  id: string
  fingerprint: string
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
  openAgentTerminal: () => void | Promise<void>
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
  private readonly remoteMessagesBySession = new Map<string, ChipMateMessage[]>()
  private connectionState: ConnectionState = "disconnected"
  private connectionDetail = "Ready. Configure an OpenAI-compatible provider to start."
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
  private readonly acceptedLegacyPluginSessions = new Set<string>()
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
  private readonly pendingLocalUserMessages = new Map<string, PendingChatUserMessage<RenderedMessage>>()
  private readonly activeSends = new Map<string, ActiveSend>()
  private readonly activeSendControllers = new Map<string, AbortController>()
  private readonly activeSendStartedAt = new Map<string, number>()
  private readonly sessionStatuses = new Map<string, ChipMateSessionStatus>()
  private readonly pendingSessionTitleIDs = new Set<string>()
  private localSendSessionID?: string
  private sessionTitleQueue = Promise.resolve()
  private activeSendGeneration = 0
  private sessionLoadGeneration = 0
  private newSessionInFlight = false
  private queuedSends: QueuedChatSend[] = []
  private drainingQueuedSends = false
  private pendingDocAgentConflictResolution?: PendingDocAgentConflictResolution
  private readonly sendStatusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly messagePollTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
    this.rejectPendingDocAgentConflictResolution("Document agent conflict review was disposed.")
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
      localResourceRoots: [
        vscode.Uri.joinPath(this.deps.extensionUri, "media"),
        vscode.Uri.joinPath(this.deps.extensionUri, "assets"),
      ],
    }
    const brandIconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "chipmate-icon.png")).toString()
    const mermaidScriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "vendor", "mermaid", "mermaid.min.js")).toString()
    const codiconFontUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "vendor", "codicon", "codicon.ttf")).toString()
    const drawioRuntimeUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", "vendor", "drawio", "adapter.html")).toString()
    const historyToolbarIconUris = Object.fromEntries(
      Object.entries(HISTORY_TOOLBAR_ICON_FILES).map(([name, fileName]) => [
        name,
        webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "assets", "icons", "history-toolbar", fileName)).toString(),
      ]),
    ) as HistoryToolbarIconUris
    const nonce = createNonce()
    const drawioRuntime = loadDrawioRuntimeHtml(this.deps.extensionUri.fsPath, nonce)
    if (drawioRuntime.error) {
      this.deps.output.appendLine(`[drawio] failed to inline offline runtime: ${drawioRuntime.error}`)
    } else {
      this.deps.output.appendLine(`[drawio] using inline srcdoc runtime bytes=${drawioRuntime.html.length}`)
    }
    webviewView.webview.html = createChatViewHtml(
      webviewView.webview.cspSource,
      nonce,
      brandIconUri,
      mermaidScriptUri,
      codiconFontUri,
      drawioRuntimeUri,
      drawioRuntime.html,
      historyToolbarIconUris,
    )
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
      await this.refreshSessionStatuses(client)
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

  private async refreshHistorySessions() {
    const client = this.deps.getClient()
    if (!client || this.connectionState !== "connected") {
      this.historyError = "Connect before refreshing history list."
      this.postState()
      return
    }

    this.historyError = ""
    try {
      await this.refreshSessionList(client)
      await this.refreshSessionStatuses(client)
    } catch (error) {
      const detail = `Failed to refresh history list: ${formatErrorMessage(error)}`
      this.historyError = detail
      this.deps.output.appendLine(`[history] ${detail}`)
    } finally {
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

  private markSessionBusy(sessionID: string, status: ChipMateSessionStatus = { type: "busy" }) {
    if (!this.activeSendStartedAt.has(sessionID)) this.activeSendStartedAt.set(sessionID, Date.now())
    this.sessionStatuses.set(sessionID, status)
  }

  private markSessionInactive(sessionID: string) {
    this.activeSendStartedAt.delete(sessionID)
  }

  private beginActiveSend(client: DirectAgentClient, sessionID: string, fingerprint?: string) {
    const generation = ++this.activeSendGeneration
    const startedAt = this.activeSendStartedAt.get(sessionID) ?? Date.now()
    this.activeSendStartedAt.set(sessionID, startedAt)
    const activeSend = { client, sessionID, generation, startedAt, fingerprint }
    this.activeSends.set(sessionID, activeSend)
    this.markSessionBusy(sessionID, this.sessionStatuses.get(sessionID) ?? { type: "busy" })
    return generation
  }

  private startSendStatusWatchdog(client: DirectAgentClient, sessionID: string, generation?: number) {
    const activeGeneration = generation ?? ++this.activeSendGeneration
    const existing = this.activeSends.get(sessionID)
    const startedAt = existing?.startedAt ?? this.activeSendStartedAt.get(sessionID) ?? Date.now()
    this.activeSendStartedAt.set(sessionID, startedAt)
    const activeSend = { client, sessionID, generation: activeGeneration, startedAt, fingerprint: existing?.fingerprint }
    this.activeSends.set(sessionID, activeSend)
    this.markSessionBusy(sessionID, this.sessionStatuses.get(sessionID) ?? { type: "busy" })
    this.scheduleSendStatusWatchdog(client, sessionID, activeGeneration)
  }

  private scheduleSendStatusWatchdog(client: DirectAgentClient, sessionID: string, generation: number) {
    this.stopSendStatusWatchdog(sessionID)
    const timer = setTimeout(() => {
      this.sendStatusTimers.delete(sessionID)
      void this.pollActiveSendStatus(client, sessionID, generation)
    }, SEND_STATUS_POLL_INTERVAL_MS)
    this.sendStatusTimers.set(sessionID, timer)
  }

  private stopSendStatusWatchdog(sessionID?: string) {
    if (sessionID) {
      const timer = this.sendStatusTimers.get(sessionID)
      if (!timer) return
      clearTimeout(timer)
      this.sendStatusTimers.delete(sessionID)
      return
    }
    for (const timer of this.sendStatusTimers.values()) clearTimeout(timer)
    this.sendStatusTimers.clear()
  }

  private startMessagePollingFallback(client: DirectAgentClient, sessionID: string, generation = this.activeSends.get(sessionID)?.generation) {
    if (generation === undefined) return
    this.stopMessagePollingFallback(sessionID)
    this.scheduleMessagePollingFallback(client, sessionID, generation, 0)
  }

  private scheduleMessagePollingFallback(
    client: DirectAgentClient,
    sessionID: string,
    generation: number,
    delayMs = MESSAGE_POLL_INTERVAL_MS,
  ) {
    this.stopMessagePollingFallback(sessionID)
    const timer = setTimeout(() => {
      this.messagePollTimers.delete(sessionID)
      void this.pollActiveSendMessages(client, sessionID, generation)
    }, delayMs)
    this.messagePollTimers.set(sessionID, timer)
  }

  private stopMessagePollingFallback(sessionID?: string) {
    if (sessionID) {
      const timer = this.messagePollTimers.get(sessionID)
      if (!timer) return
      clearTimeout(timer)
      this.messagePollTimers.delete(sessionID)
      return
    }
    for (const timer of this.messagePollTimers.values()) clearTimeout(timer)
    this.messagePollTimers.clear()
  }

  private clearActiveSendState(sessionID?: string) {
    this.activeSendGeneration += 1
    if (sessionID) {
      this.activeSends.delete(sessionID)
      this.activeSendControllers.delete(sessionID)
      this.sessionStatuses.set(sessionID, { type: "idle" })
      this.markSessionInactive(sessionID)
      if (this.localSendSessionID === sessionID) this.localSendSessionID = undefined
      this.stopSendStatusWatchdog(sessionID)
      this.stopMessagePollingFallback(sessionID)
      if (this.sessionID === sessionID) this.clearPendingLocalUserMessages(sessionID)
      return
    }
    this.activeSends.clear()
    this.activeSendControllers.clear()
    this.sessionStatuses.clear()
    this.activeSendStartedAt.clear()
    this.localSendSessionID = undefined
    this.stopSendStatusWatchdog()
    this.stopMessagePollingFallback()
    this.clearPendingLocalUserMessages()
  }

  private clearPendingLocalUserMessages(sessionID?: string) {
    if (!sessionID) {
      this.pendingLocalUserMessages.clear()
      return
    }
    for (const [id, pending] of this.pendingLocalUserMessages) {
      if (pending.sessionID === sessionID) this.pendingLocalUserMessages.delete(id)
    }
  }

  private remoteMessagesForSession(sessionID: string | undefined) {
    if (!sessionID) return []
    return this.remoteMessagesBySession.get(sessionID) ?? (this.sessionID === sessionID ? this.remoteMessages : [])
  }

  private setRemoteMessagesForSession(sessionID: string, messages: ChipMateMessage[], loadGeneration?: number) {
    this.remoteMessagesBySession.set(sessionID, messages)
    if (this.sessionID !== sessionID) return
    if (loadGeneration !== undefined && this.sessionLoadGeneration !== loadGeneration) return
    this.remoteMessages = messages
    this.syncRenderedMessages()
  }

  private clearRemoteMessagesForSession(sessionID?: string) {
    if (!sessionID) {
      this.remoteMessagesBySession.clear()
      this.remoteMessages = []
      return
    }
    this.remoteMessagesBySession.delete(sessionID)
    if (this.sessionID === sessionID) this.remoteMessages = []
  }

  private syncCurrentRemoteMessages() {
    this.remoteMessages = this.remoteMessagesForSession(this.sessionID)
    this.syncRenderedMessages()
  }

  private deletePendingLocalUserMessage(id: string) {
    this.pendingLocalUserMessages.delete(id)
  }

  private addPendingLocalUserMessage(sessionID: string, fingerprint: string, message: RenderedMessage) {
    this.pendingLocalUserMessages.set(message.id, {
      sessionID,
      fingerprint,
      text: message.text,
      createdAt: message.timeCreated ?? Date.now(),
      message,
    })
  }

  private updatePendingLocalUserStage(sessionID: string | undefined, stage: ChatSendStage, detail = "") {
    if (!sessionID) return
    for (const pending of this.pendingLocalUserMessages.values()) {
      if (pending.sessionID !== sessionID) continue
      const sendStatus = sendStatusForStage(stage, detail)
      pending.message = { ...pending.message, sendStatus }
      pending.message.parts = updateSendStatusPart(pending.message.parts, sendStatus)
      this.pendingLocalUserMessages.set(pending.message.id, pending)
    }
    if (this.sessionID === sessionID) this.syncRenderedMessages()
  }

  private pendingLocalUserMessagesForSession(sessionID: string | undefined) {
    if (!sessionID) return []
    return [...this.pendingLocalUserMessages.values()].filter((pending) => pending.sessionID === sessionID)
  }

  private sendFingerprint(
    text: string,
    options: ChatContextOptions,
    mentionedFileRefs: QueuedMentionedFileRef[] | MentionedFileRef[],
    contextItems: LocalContextItem[],
  ) {
    return chatSendFingerprint({
      text,
      options,
      mentionedFiles: mentionedFileRefs.map((ref) => ({
        uri: ref.uri,
        label: ref.label,
        type: ref.type,
        mentionIndex: ref.mentionIndex,
      })),
      contextItems: contextItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        uri: item.uri.toString(),
        lifetime: item.lifetime,
        startLine: item.kind === "selection" ? item.startLine : undefined,
        endLine: item.kind === "selection" ? item.endLine : undefined,
        text: item.kind === "selection" ? item.text : undefined,
      })),
    })
  }

  private duplicateSendMessage(sessionID: string | undefined, fingerprint: string) {
    if (sessionID && this.pendingLocalUserMessagesForSession(sessionID).some((pending) => pending.fingerprint === fingerprint)) {
      return "This message is already being sent."
    }
    if (sessionID && this.activeSends.get(sessionID)?.fingerprint === fingerprint) {
      return "This message is already being sent."
    }
    if (this.queuedSends.some((item) => item.fingerprint === fingerprint)) {
      return "This message is already queued."
    }
    return ""
  }

  private currentSessionSending() {
    const sessionID = this.sessionID
    if (!sessionID) return false
    if (this.activeSends.has(sessionID) || this.activeSendControllers.has(sessionID)) return true
    if (this.localSendSessionID === sessionID) return true
    return this.sessionStatuses.get(sessionID)?.type === "busy"
  }

  private currentSessionCancellable() {
    const sessionID = this.sessionID
    if (!sessionID || !this.currentSessionSending()) return false
    return Boolean(this.activeSendControllers.has(sessionID) || this.activeSends.has(sessionID) || this.sessionStatuses.get(sessionID)?.type === "busy")
  }

  private currentActiveSendActivity(): ActiveSendActivity | undefined {
    const sessionID = this.sessionID
    if (!sessionID || !this.currentSessionSending()) return undefined

    const status = this.sessionStatuses.get(sessionID)
    const stage = status ? chatSendStageFromSessionStatus(status) ?? "thinking" : "thinking"
    const detail = status ? chatSendStatusDetail(status) : ""
    const activeSend = this.activeSends.get(sessionID)
    const toolActivity = this.currentTurnToolActivity()
    return {
      stage,
      detail,
      startedAt: activeSend?.startedAt ?? this.activeSendStartedAt.get(sessionID),
      currentToolName: toolActivity.currentToolName,
      toolCallCount: toolActivity.toolCallCount,
    }
  }

  private currentTurnToolActivity() {
    const lastUserIndex = this.messages.reduce((last, message, index) => message.role === "user" ? index : last, -1)
    const currentTurn = this.messages.slice(lastUserIndex + 1)
    const toolParts = currentTurn.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.title)
    const prioritized =
      [...toolParts].reverse().find((part) => isActiveToolStatus(part.status)) ??
      [...toolParts].reverse().find((part) => part.title)
    return {
      currentToolName: prioritized?.title,
      toolCallCount: toolParts.length,
    }
  }

  private updateSessionStatus(sessionID: string | undefined, status: ChipMateSessionStatus | undefined) {
    if (!sessionID || !status?.type) return
    if (status.type === "busy") this.markSessionBusy(sessionID, status)
    else {
      this.sessionStatuses.set(sessionID, status)
      this.markSessionInactive(sessionID)
    }
    const stage = chatSendStageFromSessionStatus(status)
    if (stage && this.sessionID === sessionID) {
      this.updatePendingLocalUserStage(sessionID, stage, chatSendStatusDetail(status))
    }
    if ((status.type === "idle" || status.type === "error" || status.type === "retry") && !this.activeSends.has(sessionID)) {
      this.activeSendControllers.delete(sessionID)
      if (this.localSendSessionID === sessionID) this.localSendSessionID = undefined
      this.stopSendStatusWatchdog(sessionID)
      this.stopMessagePollingFallback(sessionID)
    }
  }

  private async refreshSessionStatuses(client: DirectAgentClient) {
    const statuses = await withRequestTimeout("session status", SESSION_STATUS_TIMEOUT_MS, (signal) =>
      client.getSessionStatuses(signal),
    )
    for (const [sessionID, status] of Object.entries(statuses)) {
      this.updateSessionStatus(sessionID, status)
    }
  }

  private sessionStatusFromEvent(event: ChipMateEvent): ChipMateSessionStatus | undefined {
    if (event.type !== "session.status") return undefined
    const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : {}
    const raw = properties.status && typeof properties.status === "object" ? properties.status as Record<string, unknown> : {}
    const type = typeof raw.type === "string" ? raw.type.trim() : ""
    if (!type) return undefined
    return { ...raw, type } as ChipMateSessionStatus
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
    if (!trimmed && mentionedFileRefs.length === 0 && contextItems.length === 0) {
      this.postQueueRejected(clientQueueID, "Type a message or attach context.")
      return false
    }
    const fingerprint = this.sendFingerprint(text, options, mentionedFileRefs, contextItems)
    const duplicate = this.duplicateSendMessage(this.sessionID, fingerprint)
    if (duplicate) {
      this.deps.output.appendLine(`[send-queue] rejected duplicate: ${duplicate}`)
      this.postQueueRejected(clientQueueID, duplicate, "duplicate")
      this.postQueueUpdated(duplicate, "warning")
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
        fingerprint,
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
    if (this.drainingQueuedSends || this.currentSessionSending() || this.queuedSends.length === 0) return
    if (this.connectionState !== "connected" || !this.deps.getClient()) return

    this.drainingQueuedSends = true
    try {
      while (!this.currentSessionSending() && this.queuedSends.length > 0 && this.connectionState === "connected" && this.deps.getClient()) {
        const next = this.queuedSends.shift()
        if (!next) continue
        this.postQueueUpdated(this.queuedSends.length > 0 ? `Queued ${this.queuedSends.length}/${MAX_QUEUED_CHAT_SENDS}.` : "")
        const mentioned = await this.resolveExistingMentionedFiles(next.mentionedFileRefs)
        await this.processSendMessage(next.text, next.options, mentioned.uris, next.contextItems, mentioned.refs)
      }
    } finally {
      this.drainingQueuedSends = false
      this.postState()
    }
  }

  private async cancelActiveSend() {
    const sessionID = this.sessionID
    const activeSend = sessionID ? this.activeSends.get(sessionID) : undefined
    const client = activeSend?.client ?? this.deps.getClient()
    const controller = sessionID ? this.activeSendControllers.get(sessionID) : undefined
    if (!sessionID || !this.currentSessionSending()) return
    this.deps.output.appendLine(`[send] canceled from webview${sessionID ? ` for ${sessionID}` : ""}`)
    controller?.abort()
    this.suppressStreamingEventsForSession(sessionID)
    this.clearActiveSendState(sessionID)
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
    const activeSend = this.activeSends.get(sessionID)
    return (
      activeSend?.client === client &&
      activeSend.sessionID === sessionID &&
      activeSend.generation === generation
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
      if (status) this.updateSessionStatus(sessionID, status)
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
        const session = this.sessions.find((item) => item.id === sessionID)
        const sessionSource = classifyChatSessionSource(session, messages)
        if (sessionSource === "external") {
          await this.hideExternalSession(client, sessionID, {
            title: session?.title,
            classification: sessionSource,
            firstUserMode: firstUserMessageMode(messages),
            preview: firstUserMessagePreview(messages),
          })
          return
        }
        if (sessionSource === "legacy-plugin") this.logAcceptedLegacyPluginSession(sessionID, session, messages)
        this.setRemoteMessagesForSession(sessionID, messages)
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
    generation = this.activeSends.get(sessionID)?.generation,
  ) {
    if (generation === undefined || !this.isActiveSend(client, sessionID, generation)) return

    this.stopSendStatusWatchdog(sessionID)
    this.stopMessagePollingFallback(sessionID)
    const message = remoteRetryMessage(status)
    this.deps.output.appendLine(`[event] ${message}`)
    try {
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("retry message refresh failed", error)
    }
    if (!this.isActiveSend(client, sessionID, generation)) return

    this.updateSessionStatus(sessionID, status)
    this.activeSends.delete(sessionID)
    this.activeSendControllers.delete(sessionID)
    if (this.localSendSessionID === sessionID) this.localSendSessionID = undefined
    if (this.sessionID === sessionID) {
      this.clearPendingLocalUserMessages(sessionID)
      this.messages = [...this.messages, localMessage("error", message)]
    }
    this.postState()
    if (this.sessionID === sessionID) void this.drainQueuedSends()
  }

  private async failActiveSendWithInterruption(
    client: DirectAgentClient,
    sessionID: string,
    reason: string,
    generation = this.activeSends.get(sessionID)?.generation,
  ) {
    if (generation === undefined || !this.isActiveSend(client, sessionID, generation)) return

    this.stopSendStatusWatchdog(sessionID)
    this.stopMessagePollingFallback(sessionID)
    const message = chatInterruptedMessage(reason)
    this.deps.output.appendLine(`[send] interrupted ${sessionID}: ${reason}`)
    try {
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("interrupted message refresh failed", error)
    }
    if (!this.isActiveSend(client, sessionID, generation)) return

    this.updateSessionStatus(sessionID, { type: "error", interrupted: true, message: reason })
    this.activeSends.delete(sessionID)
    this.activeSendControllers.delete(sessionID)
    if (this.localSendSessionID === sessionID) this.localSendSessionID = undefined
    if (this.sessionID === sessionID) {
      this.clearPendingLocalUserMessages(sessionID)
      if (!this.messages.some((item) => item.role === "error" && item.text === message)) {
        this.messages = [...this.messages, localMessage("error", message)]
      }
    }
    this.postState()
    if (this.sessionID === sessionID) void this.drainQueuedSends()
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

    const eventStatus = this.sessionStatusFromEvent(event)
    if (eventSessionID && eventStatus) {
      this.updateSessionStatus(eventSessionID, eventStatus)
      if (eventStatus.type === "idle") {
        this.flushStreamingStatePost()
        void this.finishStreamingSession(client, eventSessionID)
        return
      }
      if (eventStatus.type === "retry") {
        this.flushStreamingStatePost()
        void this.failActiveSendWithRetry(client, eventSessionID, eventStatus)
        return
      }
      if (eventStatus.type === "error" && eventStatus.interrupted === true) {
        this.flushStreamingStatePost()
        void this.failActiveSendWithInterruption(client, eventSessionID, sessionInterruptionReason(eventStatus))
        return
      }
      if (eventSessionID === this.sessionID) this.postState()
    }

    const targetSessionID = this.sessionIDForRemoteEvent(event, eventSessionID)
    const targetMessages = targetSessionID ? this.remoteMessagesForSession(targetSessionID) : []
    const result = applyChipMateEventToMessages(targetMessages, event, targetSessionID)
    const resultSessionID = result.sessionID || targetSessionID
    if (result.refreshSessions) {
      void this.refreshSessionList(client)
        .then(() => this.postState())
        .catch((error) => this.logEventError("session refresh failed", error))
    }
    if (result.changed && resultSessionID) {
      this.setRemoteMessagesForSession(resultSessionID, result.messages)
      if (resultSessionID === this.sessionID) {
        if (isHighFrequencyStreamingMessageEvent(event.type)) this.scheduleStreamingStatePost()
        else this.postState()
      }
    }
    const sessionID = resultSessionID
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

  private sessionIDForRemoteEvent(event: ChipMateEvent, eventSessionID: string | undefined) {
    if (eventSessionID) return eventSessionID
    const messageID = messageIDFromRemoteEvent(event)
    if (!messageID) return undefined
    const partID = partIDFromRemoteEvent(event)
    for (const [sessionID, messages] of this.remoteMessagesBySession) {
      if (messagesContainMessagePart(messages, messageID, partID)) return sessionID
    }
    if (messagesContainMessagePart(this.remoteMessages, messageID, partID)) return this.sessionID
    return undefined
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
    const activeSends = [...this.activeSends.values()].filter((send) => send.client === client)
    if (activeSends.length === 0) return
    this.deps.output.appendLine("[event] stream unavailable during active send; using message polling fallback")
    for (const send of activeSends) {
      this.startMessagePollingFallback(client, send.sessionID, send.generation)
    }
  }

  private async finishStreamingSession(client: DirectAgentClient, sessionID: string) {
    if (this.finalizingSessions.has(sessionID)) return
    this.finalizingSessions.add(sessionID)
    let shouldDrainQueuedSends = false
    const activeSend = this.activeSends.get(sessionID)
    const activeGeneration = activeSend?.client === client ? activeSend.generation : undefined
    if (activeGeneration !== undefined) {
      this.stopSendStatusWatchdog(sessionID)
      this.stopMessagePollingFallback(sessionID)
    }
    try {
      if (this.deps.getClient() !== client) return
      await this.refreshSessionList(client)
      if (this.sessionID === sessionID) await this.loadSessionMessages(client, sessionID)
    } catch (error) {
      this.logEventError("final message refresh failed", error)
    } finally {
      this.finalizingSessions.delete(sessionID)
      if (activeGeneration !== undefined && this.activeSends.get(sessionID)?.generation === activeGeneration) {
        this.activeSends.delete(sessionID)
      }
      this.activeSendControllers.delete(sessionID)
      this.updateSessionStatus(sessionID, { type: "idle" })
      if (this.sessionID === sessionID) {
        this.clearPendingLocalUserMessages(sessionID)
        shouldDrainQueuedSends = this.queuedSends.length > 0
      }
      this.postState()
      if (shouldDrainQueuedSends) void this.drainQueuedSends()
    }
  }

  private syncRenderedMessages() {
    const renderedRemote = this.remoteMessages.map(renderMessage).filter((message) => message.text || message.parts.length > 0)
    const result = mergeRenderedChatMessages({
      remoteMessages: renderedRemote,
      pendingMessages: this.pendingLocalUserMessagesForSession(this.sessionID),
    })
    for (const id of result.matchedPendingIDs) {
      this.pendingLocalUserMessages.delete(id)
    }
    this.messages = result.messages
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
    if (this.newSessionInFlight) {
      this.deps.output.appendLine("[session] ignored duplicate newSession while creation is in flight")
      this.postState()
      return
    }

    const loadGeneration = ++this.sessionLoadGeneration
    this.newSessionInFlight = true
    this.clearQueuedSends()
    this.loadingMessages = true
    this.postState()
    try {
      const session = await client.createSession(CHAT_SESSION_TITLE)
      if (this.sessionLoadGeneration !== loadGeneration) return
      this.sessionID = session.id
      this.setRemoteMessagesForSession(session.id, [])
      this.remoteMessages = []
      this.messages = []
      await this.refreshSessionList(client)
      await this.refreshSessionStatuses(client)
    } catch (error) {
      this.reportRemoteConnectionFailure(client, "Failed to create ChipMate session", error)
    } finally {
      this.newSessionInFlight = false
      if (this.sessionLoadGeneration === loadGeneration) this.loadingMessages = false
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
          await this.refresh()
          break
        case "refreshSessions":
          await this.refreshHistorySessions()
          break
        case "openAgentTerminal":
          await this.deps.openAgentTerminal()
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
        case "pickSkillImport":
          await this.pickSkillImport()
          break
        case "importSkillCandidates":
          await this.importSkillCandidates(message.candidates ?? [])
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
        case "registerDiagramVisualEvidence":
          await this.registerDiagramVisualEvidence(message)
          break
        case "exportDrawioImage":
          await this.exportDrawioImage(message)
          break
        case "drawioRenderTelemetry":
          this.logDrawioRenderTelemetry(message)
          break
        case "exportMermaidImage":
          await this.exportMermaidImage(message)
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
        case "deleteSessions":
          await this.deleteSessions(message.sessionIDs)
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
        case "openGeneratedDocument":
          await this.openGeneratedDocument(message.path, message.mode)
          break
        case "resolveDocAgentConflict":
          this.resolveDocAgentConflict(message.requestId, message.choices ?? [])
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
        case "resolveToolApproval":
          this.resolveToolApproval(message.requestId, message.approved === true)
          break
        case "answerClarification":
          void this.answerClarification(message.requestId, message.answers)
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

  private async openGeneratedDocument(relative: string | undefined, mode: "external" | "reveal" = "external") {
    const root = vscode.workspace.workspaceFolders?.[0]
    if (!root || !relative) return
    const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!normalized.startsWith(".chipmate/docs/") || normalized.split("/").includes("..") || !normalized.toLowerCase().endsWith(".docx")) {
      vscode.window.showWarningMessage("Generated document path is outside .chipmate/docs.")
      return
    }
    const uri = vscode.Uri.joinPath(root.uri, ...normalized.split("/"))
    if (mode === "reveal") {
      await vscode.commands.executeCommand("revealFileInOS", uri)
      return
    }
    await vscode.env.openExternal(uri)
  }

  private requestDocAgentConflictDecisions(message: RenderedMessage, conflicts: ConflictRule[], signal?: AbortSignal): Promise<ConflictResolutionDecision[]> {
    this.pendingDocAgentConflictResolution?.reject(abortError("A newer document conflict review started."))
    this.pendingDocAgentConflictResolution?.dispose()
    const requestId = `doc-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const part: RenderedPart = {
      type: "docAgentConflictReview",
      title: "规则冲突需要确认",
      status: "waiting",
      requestId,
      conflictCount: conflicts.length,
      conflicts: conflicts.map(renderedConflict),
    }
    upsertPart(message, part)
    updateTextPart(message, `检测到 ${conflicts.length} 条规则冲突，请先选择处理方式。`)
    this.postState()

    return new Promise<ConflictResolutionDecision[]>((resolve, reject) => {
      const onAbort = () => {
        this.pendingDocAgentConflictResolution = undefined
        updatePart(message, "docAgentConflictReview", { status: "error", detail: "已取消冲突处理。" })
        this.postState()
        reject(abortError("Document agent conflict review aborted."))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pendingDocAgentConflictResolution = {
        requestId,
        messageId: message.id,
        resolve,
        reject,
        dispose: () => signal?.removeEventListener("abort", onAbort),
      }
    })
  }

  private resolveDocAgentConflict(requestId: string | undefined, choices: Array<{ conflictId?: string; choice?: ConflictResolutionChoice }>) {
    const pending = this.pendingDocAgentConflictResolution
    if (!pending || !requestId || pending.requestId !== requestId) {
      vscode.window.showWarningMessage("当前没有等待处理的 Word 规则冲突。")
      return
    }
    const message = this.messages.find((item) => item.id === pending.messageId)
    const part = message?.parts.find((item) => item.type === "docAgentConflictReview")
    const conflicts = part?.conflicts ?? []
    const byId = new Map(choices.map((choice) => [String(choice.conflictId ?? ""), normalizeConflictChoice(choice.choice)]))
    const decisions = conflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: byId.get(conflict.id) ?? ("review" as const),
    }))
    if (message && part) {
      part.status = "completed"
      part.detail = conflictDecisionSummary(decisions)
      part.conflicts = conflicts.map((conflict) => ({
        ...conflict,
        choice: decisions.find((decision) => decision.conflictId === conflict.id)?.choice ?? "review",
      }))
      updateTextPart(message, `冲突处理已确认：${part.detail}`)
    }
    pending.dispose()
    this.pendingDocAgentConflictResolution = undefined
    pending.resolve(decisions)
    this.postState()
  }

  private rejectPendingDocAgentConflictResolution(message: string) {
    const pending = this.pendingDocAgentConflictResolution
    if (!pending) return
    pending.dispose()
    this.pendingDocAgentConflictResolution = undefined
    pending.reject(abortError(message))
  }

  private resolveToolApproval(requestId: string | undefined, approved: boolean) {
    const id = typeof requestId === "string" ? requestId.trim() : ""
    if (!id) return
    const accepted = this.deps.getClient()?.resolveToolApproval(id, approved) ?? false
    if (!accepted) this.deps.output.appendLine(`[tool-approval] ignored stale approval request ${id}`)
  }

  private async answerClarification(requestId: string | undefined, rawAnswers: Array<{ questionId?: string; choiceId?: string; text?: string }> | undefined) {
    const id = typeof requestId === "string" ? requestId.trim() : ""
    if (!id) return
    const answers = (Array.isArray(rawAnswers) ? rawAnswers : [])
      .slice(0, 3)
      .map((answer, index) => ({
        questionId: (answer.questionId || `q${index + 1}`).trim(),
        choiceId: answer.choiceId?.trim() || undefined,
        text: answer.text?.trim() || undefined,
      }))
      .filter((answer) => answer.questionId && (answer.choiceId || answer.text))
    if (answers.length === 0) return
    const client = this.deps.getClient()
    const accepted = client?.resolveClarification(id, answers) ?? false
    if (accepted) return
    this.deps.output.appendLine(`[clarification] pending request not found; falling back to follow-up message ${id}`)
    const fallbackText = [
      "澄清回答：",
      ...answers.map((answer) => `- ${answer.questionId}: ${answer.text || answer.choiceId || ""}`),
      "",
      "请基于以上澄清继续刚才的请求。",
    ].join("\n")
    await this.sendMessage(fallbackText, this.contextOptions({}), [], this.deps.contextStore.snapshot(), [])
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
    if (!completionApiBaseUrl(settings) || !model) {
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
        : settings.completion.profile === "deepseek-fim"
          ? "const value = "
        : [
            "You are testing an inline completion endpoint.",
            "Return only this exact text:",
            "ok",
          ].join("\n")
      await client.complete({
        prompt,
        suffix: settings.completion.profile === "deepseek-fim" ? ";\n" : undefined,
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

  private async pickSkillImport() {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Import Skill",
      title: "Import ChipMate Skill",
    })
    if (!selected || selected.length === 0) return
    await this.importSkillUris(selected)
  }

  private async importSkillCandidates(candidates: string[]) {
    const uris = droppedFileUriCandidates(candidates)
    if (uris.length === 0) {
      this.postSkillsImportStatus("No skill path was found in the drop. Use Import Skill... to choose a directory or SKILL.md.", "error")
      return
    }
    await this.importSkillUris(uris)
  }

  private async importSkillUris(sources: vscode.Uri[]) {
    const settings = this.deps.getSettings()
    this.postSkillsImportStatus(`Validating ${sources.length} skill import candidate${sources.length === 1 ? "" : "s"}...`, "info")
    try {
      const result = await importSkills({
        sources,
        settings: settings.skills,
        existingSkills: this.skills,
        output: this.deps.output,
        confirmOverwrite: async (candidate) => {
          const choice = await vscode.window.showWarningMessage(
            `ChipMate skill "${candidate.name}" already exists at ${candidate.targetPath}. Overwrite it?`,
            { modal: true },
            "Overwrite",
          )
          return choice === "Overwrite"
        },
        saveEnabledSkills: async (enabled) => saveSkillsSettings(enabled),
      })
      if (result.imported.length > 0) this.deps.invalidateSkills?.()
      await this.refreshSkills()
      this.postSkillsImportStatus(skillImportResultMessage(result), skillImportResultStatus(result), result)
    } catch (error) {
      const message = formatErrorMessage(error)
      this.deps.output.appendLine(`[skills-import] failed: ${message}`)
      this.postSkillsImportStatus(`Skill import failed: ${message}`, "error")
    } finally {
      this.postState()
    }
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

    const loadGeneration = ++this.sessionLoadGeneration
    this.clearQueuedSends()
    this.sessionID = sessionID
    this.syncCurrentRemoteMessages()
    this.loadingMessages = true
    this.postState()
    try {
      await this.loadSessionMessages(client, sessionID, loadGeneration)
      await this.refreshSessionStatuses(client)
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
      if (this.sessionLoadGeneration === loadGeneration) this.loadingMessages = false
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

    await this.deleteConfirmedSessions(client, [sessionID])
  }

  private async deleteSessions(sessionIDs: string[]) {
    const client = this.connectedClient("Connect before deleting sessions.")
    if (!client || sessionIDs.length === 0) return

    const visibleIDs = new Set(this.sessions.map((session) => session.id))
    const targetIDs = uniqueStrings(sessionIDs).filter((sessionID) => visibleIDs.has(sessionID))
    if (targetIDs.length === 0) return

    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${targetIDs.length} selected chat history session${targetIDs.length === 1 ? "" : "s"}? This removes the locally saved sessions.`,
      { modal: true },
      "Delete",
    )
    if (confirmed !== "Delete") return

    await this.deleteConfirmedSessions(client, targetIDs)
  }

  private async deleteConfirmedSessions(client: DirectAgentClient, sessionIDs: string[]) {
    const targetIDs = uniqueStrings(sessionIDs).filter((sessionID) =>
      this.sessions.some((session) => session.id === sessionID),
    )
    if (targetIDs.length === 0) return

    const wasCurrent = Boolean(this.sessionID && targetIDs.includes(this.sessionID))
    if (wasCurrent && this.currentSessionSending()) await this.cancelActiveSend()
    for (const sessionID of targetIDs) {
      if (!wasCurrent || sessionID !== this.sessionID) this.clearActiveSendState(sessionID)
    }
    if (wasCurrent) this.clearQueuedSends()

    if (wasCurrent) {
      this.loadingMessages = true
      this.postState()
    }

    const deletedIDs: string[] = []
    const failures: string[] = []
    try {
      for (const sessionID of targetIDs) {
        try {
          await withRequestTimeout("delete session", SESSION_REFRESH_TIMEOUT_MS, (signal) =>
            client.deleteSession(sessionID, signal),
          )
          deletedIDs.push(sessionID)
        } catch (error) {
          const message = formatErrorMessage(error)
          failures.push(`${sessionID}: ${message}`)
          this.deps.output.appendLine(`[history] Failed to delete session ${sessionID}: ${message}`)
        }
      }
      this.sessions = this.sessions.filter((item) => !deletedIDs.includes(item.id))
      if (wasCurrent && this.sessionID && deletedIDs.includes(this.sessionID)) this.clearMissingSession(this.sessionID)
      await this.refreshSessionList(client)
      if (wasCurrent) {
        this.reconcileSessionSelection()
        await this.loadSelectedSessionMessages(client)
      }
      if (failures.length > 0) {
        void vscode.window.showWarningMessage(`Failed to delete ${failures.length} ChipMate session${failures.length === 1 ? "" : "s"}. See ChipMate Output for details.`)
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
    mentionedFileRefs = this.mentionedFileRefsFromUris(mentionedFiles),
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed && mentionedFileRefs.length === 0 && contextItems.length === 0) return false
    if (this.currentSessionSending()) {
      const enqueued = this.enqueueChatSend(text, options, mentionedFiles, mentionedFileRefs, undefined, contextItems)
      if (enqueued && !this.shouldPreserveOneShotContext(text)) this.deps.contextStore.consumeOneShot(contextItems)
      return enqueued
    }

    const documentAgentResult = await this.tryRunDocumentAgentFlow(trimmed || "Please review the referenced files.", mentionedFiles, mentionedFileRefs, contextItems)
    if (documentAgentResult !== undefined) return documentAgentResult

    const client = this.connectedClient("Configure a ChipMate provider before sending.")
    if (!client) return false

    this.clearStreamingEventSuppression()
    const controller = new AbortController()
    const optimistic = localMessage("user", trimmed || "Please review the referenced files.", {
      sendStatus: sendStatusForStage("pending"),
    })
    let sendSessionID: string | undefined
    let sendFingerprint = ""
    let strictAgentHint = ""
    let preparedMessage: { text: string; historyText?: string; messageMode?: string; evidenceLedger?: EvidenceLedgerEntry[]; model?: PromptModel; agent?: string; fingerprint?: string } | undefined
    let sentStreaming = false
    try {
      sendSessionID = await this.getOrCreateSession(client, controller.signal)
      sendFingerprint = this.sendFingerprint(text, options, mentionedFileRefs, contextItems)
      const duplicate = this.duplicateSendMessage(sendSessionID, sendFingerprint)
      if (duplicate) {
        this.deps.output.appendLine(`[send] rejected duplicate: ${duplicate}`)
        this.postQueueRejected(undefined, duplicate, "duplicate")
        return false
      }
      this.activeSendControllers.set(sendSessionID, controller)
      this.updateSessionStatus(sendSessionID, { type: "busy", stage: "preparing", message: "Preparing context" })
      this.addPendingLocalUserMessage(sendSessionID, sendFingerprint, optimistic)
      if (this.sessionID === sendSessionID) this.syncRenderedMessages()
      this.postState()
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
      this.updatePendingLocalUserStage(sendSessionID, "preparing", "Checking local index readiness.")
      await this.waitForCodeGraphReady(settings)
      let contextSummary: ContextSummaryItem[] = []
      this.updatePendingLocalUserStage(sendSessionID, "preparing", "Collecting local context and evidence.")
      const promptResult = await buildChatPromptWithEvidence({
        question: trimmed || "Please review the referenced files.",
        options,
        settings,
        contextStore: this.deps.contextStore,
        contextItems,
        mentionedFiles,
        mentionedContext: this.mentionedContextFromRefs(mentionedFileRefs),
        editorContext: this.deps.getEditorContext(),
        codeGraph: this.deps.codeGraph,
        documentRag: this.deps.documentRag,
        onContextSummary: (items) => {
          contextSummary = items
          this.lastContextSummary = items
        },
      })
      if (controller.signal.aborted) return false
      const prompt = promptResult.prompt
      contextSummary = promptResult.contextSummary
      this.lastContextSummary = contextSummary
      this.logContextSummary(contextSummary)
      this.deps.output.appendLine(`[agent] ${agentSelection.label}`)
      this.deps.output.appendLine(`[model] ${modelSelection.label}`)
      preparedMessage = {
        text: prompt,
        historyText: pluginHistoryUserText(trimmed || "Please review the referenced files."),
        messageMode: "plugin-chat",
        evidenceLedger: promptResult.evidenceLedgerInput,
        model: modelSelection.model,
        agent: agentSelection.agent,
        fingerprint: sendFingerprint,
      }
      this.updatePendingLocalUserStage(sendSessionID, "sending", "Starting model request.")
      sentStreaming = await this.sendPreparedMessage(client, preparedMessage, controller.signal, sendSessionID)
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
        this.deletePendingLocalUserMessage(optimistic.id)
        if (this.sessionID === sendSessionID) {
          this.syncRenderedMessages()
          this.messages = [...this.messages, localMessage("error", message)]
        }
        this.deps.output.appendLine(`[guard] blocked send: ${message}`)
        return false
      }
      if (error instanceof CodeGraphReadinessError || finalError instanceof CodeGraphReadinessError) {
        this.deletePendingLocalUserMessage(optimistic.id)
        if (this.sessionID === sendSessionID) {
          this.syncRenderedMessages()
          this.messages = [...this.messages, localMessage("error", message)]
        }
        this.deps.output.appendLine(`[codegraph] blocked send: ${message}`)
        return false
      }
      this.deletePendingLocalUserMessage(optimistic.id)
      if (this.sessionID === sendSessionID) {
        this.syncRenderedMessages()
        this.messages = [...this.messages, localMessage("error", `Failed to send message: ${message}`)]
      }
      this.reportRemoteConnectionFailure(client, "Failed to send message to ChipMate", finalError, message)
      return false
    } finally {
      this.codeGraphWaitDetail = ""
      if (sendSessionID && this.activeSendControllers.get(sendSessionID) === controller) this.activeSendControllers.delete(sendSessionID)
      if (sendSessionID && !sentStreaming && !controller.signal.aborted) {
        this.clearActiveSendState(sendSessionID)
      }
      this.postState()
      if (!sentStreaming && !controller.signal.aborted) void this.drainQueuedSends()
    }
  }

  private async tryRunDocumentAgentFlow(
    text: string,
    mentionedFiles: vscode.Uri[],
    mentionedFileRefs: QueuedMentionedFileRef[],
    contextItems: LocalContextItem[],
  ): Promise<boolean | undefined> {
    const refByUri = new Map(mentionedFileRefs.map((ref, index) => [ref.uri, { ref, index }]))
    const docxFiles = mentionedFiles
      .filter((uri) => uri.fsPath.toLowerCase().endsWith(".docx"))
      .map((uri, index) => ({ uri, order: refByUri.get(uri.toString())?.ref.mentionIndex ?? refByUri.get(uri.toString())?.index ?? index }))
      .sort((left, right) => left.order - right.order)
    const detection = new DocxIntentDetector().detect({ text, docxCount: docxFiles.length })
    if (!detection.matched) return undefined

    const controller = new AbortController()
    const historyClient = this.deps.getClient()
    const historySessionID = historyClient && this.connectionState === "connected"
      ? await this.documentAgentHistorySession(historyClient, controller.signal)
      : undefined
    const localSessionID = historySessionID ?? this.sessionID
    if (localSessionID) {
      this.localSendSessionID = localSessionID
      this.activeSendControllers.set(localSessionID, controller)
      this.updateSessionStatus(localSessionID, { type: "busy", stage: "preparing", message: "Preparing local Word flow" })
    }
    const user = localMessage("user", text, { sendStatus: sendStatusForStage("preparing", "Preparing local Word flow.") })
    const userFingerprint = localSessionID ? this.sendFingerprint(text, this.contextOptions({}), mentionedFileRefs, contextItems) : ""
    this.messages = [...this.messages, user]
    if (localSessionID) this.addPendingLocalUserMessage(localSessionID, userFingerprint, user)
    this.postState()

    try {
      if (detection.reason) {
        const assistant = localMessage("assistant", detection.reason)
        this.messages = [...this.messages, assistant]
        await this.persistDocumentAgentHistory({
          client: historyClient,
          sessionID: historySessionID,
          userText: text,
          assistantText: detection.reason,
          assistantParts: assistant.parts,
        })
        return true
      }
      const progress = localMessage("assistant", "正在准备本地 Word 资料包生成流程...", {
        parts: [
          { type: "text", text: "正在准备本地 Word 资料包生成流程..." },
          createDocAgentTimelinePart(),
        ],
      })
      this.messages = [...this.messages, progress]
      this.postState()
      const files: Array<{ path: string; bytes: Uint8Array; mentionIndex?: number }> = []
      for (const item of docxFiles) {
        controller.signal.throwIfAborted()
        const uri = item.uri
        files.push({
          path: relativePath(uri),
          bytes: await vscode.workspace.fs.readFile(uri),
          mentionIndex: item.order,
        })
      }
      const flow = new GuidelineReferencePackFlow()
      const result = await flow.run({
        question: text,
        files,
        model: new ChipMateDocModelProvider({
          getSettings: this.deps.getSettings,
          getApiKey: this.deps.getProviderApiKey,
          log: (message) => this.deps.output.appendLine(message),
          onStillWaiting: (event) => {
            appendDocAgentTimelineEvent(progress, docAgentModelWaitingEvent(event))
            this.postState()
          },
        }),
        signal: controller.signal,
        log: (message) => this.deps.output.appendLine(message),
        onProgress: (item) => {
          progress.text = item.message
          updateTextPart(progress, item.message)
          updatePart(progress, "docAgentTimeline", {
            title: item.message,
            current: "current" in item ? item.current : undefined,
            total: "total" in item ? item.total : undefined,
          })
          this.postState()
        },
        onTimeline: (event) => {
          appendDocAgentTimelineEvent(progress, event)
          this.postState()
        },
        resolveConflictDecisions: (conflicts, signal) => this.requestDocAgentConflictDecisions(progress, conflicts, signal),
      })
      const warningLine = result.warningCount > 0 ? `\n\nWarning：${result.warningCount} 条。打开 Word 后请更新目录域。` : "\n\n打开 Word 后请更新目录域。"
      progress.text = `已生成${result.title ?? "Word 文档"}：${result.path}${warningLine}`
      updateTextPart(progress, progress.text)
      upsertPart(progress, generatedDocumentPart(result))
      await this.persistDocumentAgentHistory({
        client: historyClient,
        sessionID: historySessionID,
        userText: text,
        assistantText: progress.text,
        assistantParts: [
          { type: "text", text: progress.text },
          persistedDocAgentTimelinePart(progress, result),
          generatedDocumentPart(result),
        ],
      })
      this.deps.contextStore.consumeOneShot(contextItems)
      return true
    } catch (error) {
      if (controller.signal.aborted) return false
      const message = error instanceof Error ? error.message : String(error)
      const errorText = `Word 文档生成失败：${message}`
      this.messages = [...this.messages, localMessage("error", errorText)]
      this.deps.output.appendLine(`[doc-agent] failed: ${message}`)
      await this.persistDocumentAgentHistory({
        client: historyClient,
        sessionID: historySessionID,
        userText: text,
        assistantText: errorText,
        assistantParts: [{ type: "text", text: errorText }],
        error: errorText,
      })
      return false
    } finally {
      if (localSessionID && this.activeSendControllers.get(localSessionID) === controller) this.activeSendControllers.delete(localSessionID)
      if (localSessionID && this.localSendSessionID === localSessionID) this.localSendSessionID = undefined
      if (localSessionID) this.updateSessionStatus(localSessionID, { type: "idle" })
      this.deletePendingLocalUserMessage(user.id)
      this.postState()
    }
  }

  private async documentAgentHistorySession(client: DirectAgentClient, signal?: AbortSignal) {
    try {
      return await this.getOrCreateSession(client, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[doc-agent] history session unavailable: ${message}`)
      return undefined
    }
  }

  private async persistDocumentAgentHistory(input: {
    client: DirectAgentClient | undefined
    sessionID: string | undefined
    userText: string
    assistantText: string
    assistantParts: RenderedPart[]
    error?: string
  }) {
    if (!input.client || !input.sessionID) return
    try {
      await input.client.appendLocalMessages({
        sessionID: input.sessionID,
        messages: [
          {
            role: "user",
            text: pluginHistoryUserText(input.userText),
            parts: [{ type: "text", text: pluginHistoryUserText(input.userText) }],
            mode: "doc-agent-local",
          },
          {
            role: "assistant",
            text: input.assistantText,
            parts: renderedPartsForHistory(input.assistantParts),
            error: input.error,
            mode: "doc-agent-local",
          },
        ],
      })
      await this.refreshSessionList(input.client)
      this.postState()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[doc-agent] failed to persist history: ${message}`)
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
    input: { text: string; historyText?: string; messageMode?: string; evidenceLedger?: EvidenceLedgerEntry[]; model?: PromptModel; agent?: string; fingerprint?: string },
    signal?: AbortSignal,
    targetSessionID?: string,
  ) {
    const sessionID = targetSessionID ?? (await this.getOrCreateSession(client, signal))
    const generation = this.beginActiveSend(client, sessionID, input.fingerprint)
    const canStream = await this.ensureEventSubscription(client)
    await client.sendMessageAsync({
      sessionID,
      text: input.text,
      historyText: input.historyText,
      messageMode: input.messageMode,
      evidenceLedger: input.evidenceLedger,
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
    const visibleSessions = sessions.filter((session) => this.isVisibleChatSession(session))
    this.sessions = sessions
      .filter((session) => visibleSessions.some((visible) => visible.id === session.id))
      .map((session) => renderSession(session, this.flaggedSessions.has(session.id)))
    this.historyError = ""
    this.deps.output.appendLine(`[refresh] sessions ${Date.now() - started}ms`)
    this.queueMissingSessionDisplayTitles(client, visibleSessions)
  }

  private queueMissingSessionDisplayTitles(client: DirectAgentClient, sessions: ChipMateSession[]) {
    for (const session of sessions) {
      if (session.displayTitle?.trim()) continue
      if (!sessionHasLikelyMessages(session)) continue
      this.queueSessionDisplayTitle(client, session.id)
    }
  }

  private queueSessionDisplayTitle(client: DirectAgentClient, sessionID: string) {
    if (this.pendingSessionTitleIDs.has(sessionID)) return
    this.pendingSessionTitleIDs.add(sessionID)
    this.sessionTitleQueue = this.sessionTitleQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          if (this.deps.getClient() !== client) return
          if (!this.sessions.some((session) => session.id === sessionID)) return
          const updated = await withRequestTimeout("session title", SESSION_TITLE_TIMEOUT_MS, (signal) =>
            client.ensureSessionDisplayTitle(sessionID, signal),
          )
          if (!updated || !this.isVisibleChatSession(updated)) return
          this.sessions = this.sessions.map((session) =>
            session.id === sessionID
              ? { ...renderSession(updated, session.serverToolsUsed || this.flaggedSessions.has(sessionID)) }
              : session,
          )
          this.postState()
        } catch (error) {
          this.deps.output.appendLine(`[session-title] failed for ${sessionID}: ${formatErrorMessage(error)}`)
        } finally {
          this.pendingSessionTitleIDs.delete(sessionID)
        }
      })
  }

  private reconcileSessionSelection() {
    if (this.sessionID && this.sessions.some((session) => session.id === this.sessionID)) return
    if (this.sessionID) {
      this.deps.output.appendLine(`[session] ChipMate session ${this.sessionID} is no longer available; clearing selection.`)
    }
    this.sessionID = this.sessions[0]?.id
    if (!this.sessionID) {
      this.clearRemoteMessagesForSession()
      this.clearPendingLocalUserMessages()
      this.messages = []
      return
    }
    this.syncCurrentRemoteMessages()
  }

  private async loadSelectedSessionMessages(client: DirectAgentClient) {
    if (!this.sessionID) {
      this.clearRemoteMessagesForSession()
      this.clearPendingLocalUserMessages()
      this.messages = []
      return
    }

    const sessionID = this.sessionID
    const loadGeneration = ++this.sessionLoadGeneration
    try {
      await this.loadSessionMessages(client, sessionID, loadGeneration)
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      await this.recoverMissingSession(client, sessionID)
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID, this.sessionLoadGeneration)
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
    if (sessionID) this.clearActiveSendState(sessionID)
    this.sessionID = undefined
    this.clearRemoteMessagesForSession(sessionID)
    this.clearPendingLocalUserMessages()
    this.messages = []
  }

  private async loadSessionMessages(client: DirectAgentClient, sessionID: string, loadGeneration?: number) {
    this.clearStreamingEventSuppression(sessionID)
    const started = Date.now()
    const messages = await withRequestTimeout("session messages", MESSAGE_REFRESH_TIMEOUT_MS, (signal) =>
      client.getMessages(sessionID, SESSION_MESSAGE_LIMIT, signal),
    )
    this.deps.output.appendLine(`[refresh] messages ${Date.now() - started}ms`)
    const session = this.sessions.find((item) => item.id === sessionID)
    if (messages.some(isInlineCompletionMessage)) {
      await this.hideCompletionSession(client, sessionID)
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID, this.sessionLoadGeneration)
      return
    }
    const sessionSource = classifyChatSessionSource(session, messages)
    if (sessionSource === "external") {
      await this.hideExternalSession(client, sessionID, {
        title: session?.title,
        classification: sessionSource,
        firstUserMode: firstUserMessageMode(messages),
        preview: firstUserMessagePreview(messages),
      })
      if (this.sessionID) await this.loadSessionMessages(client, this.sessionID, this.sessionLoadGeneration)
      return
    }
    if (sessionSource === "legacy-plugin") this.logAcceptedLegacyPluginSession(sessionID, session, messages)

    this.setRemoteMessagesForSession(sessionID, messages, loadGeneration)
  }

  private async hideCompletionSession(client: DirectAgentClient, sessionID: string) {
    this.hiddenCompletionSessions.add(sessionID)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    this.clearRemoteMessagesForSession(sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.clearPendingLocalUserMessages(sessionID)
      this.messages = []
    }
    this.deps.output.appendLine(`[history] Hidden inline completion session ${sessionID}.`)
    await this.refreshSessionList(client)
    this.reconcileSessionSelection()
  }

  private async hideExternalSession(client: DirectAgentClient, sessionID: string, detail?: {
    title?: string
    classification?: string
    firstUserMode?: string
    preview?: string
  }) {
    if (detail) {
      this.deps.output.appendLine([
        `[history] external-session-check session=${sessionID}`,
        `title=${JSON.stringify(detail.title || "")}`,
        `classification=${detail.classification || "external"}`,
        `firstUserMode=${JSON.stringify(detail.firstUserMode || "")}`,
        `preview=${JSON.stringify(detail.preview || "")}`,
      ].join(" "))
    }
    this.hiddenExternalSessions.add(sessionID)
    this.sessions = this.sessions.filter((session) => session.id !== sessionID)
    this.clearRemoteMessagesForSession(sessionID)
    if (this.sessionID === sessionID) {
      this.sessionID = undefined
      this.clearPendingLocalUserMessages(sessionID)
      this.messages = []
    }
    this.deps.output.appendLine(`[history] Hidden external ChipMate session ${sessionID}.`)
    await this.refreshSessionList(client)
    this.reconcileSessionSelection()
  }

  private logAcceptedLegacyPluginSession(sessionID: string, session: Pick<ChipMateSession, "title"> | undefined, messages: readonly ChipMateMessage[]) {
    if (this.acceptedLegacyPluginSessions.has(sessionID)) return
    this.acceptedLegacyPluginSessions.add(sessionID)
    this.deps.output.appendLine([
      `[history] Keeping legacy VS Code chat session ${sessionID}.`,
      `title=${JSON.stringify(session?.title || "")}`,
      "classification=legacy-plugin",
      `firstUserMode=${JSON.stringify(firstUserMessageMode(messages) || "")}`,
      `preview=${JSON.stringify(firstUserMessagePreview(messages) || "")}`,
    ].join(" "))
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
    const orderedFiles = orderMentionedFileRefs(files)
    for (const file of orderedFiles) {
      try {
        const uri = vscode.Uri.parse(file.uri)
        if (uri.scheme !== "file") continue
        if (!vscode.workspace.getWorkspaceFolder(uri)) continue
        const key = uri.toString()
        if (seen.has(key)) continue
        seen.add(key)
        const stat = await vscode.workspace.fs.stat(uri)
        const isDirectory = Boolean(stat.type & vscode.FileType.Directory)
        const isFile = Boolean(stat.type & vscode.FileType.File)
        if (file.type === "folder" ? !isDirectory : !isFile) {
          this.deps.output.appendLine(`[mention] skipped missing/stale file: ${relativePath(uri)}`)
          continue
        }
        const type: "file" | "folder" = stat.type & vscode.FileType.Directory ? "folder" : "file"
        if (type === "file") uris.push(uri)
        refs.push({
          uri: key,
          label: file.label || relativePath(uri),
          type,
          insertText: file.insertText,
          mentionIndex: file.mentionIndex,
        })
      } catch {
        this.deps.output.appendLine(`[mention] skipped missing/stale file: ${file.uri}`)
      }
    }
    return { uris, refs }
  }

  private mentionedFileRefsFromUris(uris: vscode.Uri[]): QueuedMentionedFileRef[] {
    return uris.map((uri, index) => ({
      uri: uri.toString(),
      label: relativePath(uri),
      type: "file" as const,
      mentionIndex: index,
    }))
  }

  private mentionFileRefFromEntry(entry: MentionIndexEntry): QueuedMentionedFileRef | undefined {
    if (!entry.uri) return undefined
    try {
      const uri = vscode.Uri.parse(entry.uri)
      if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) return undefined
      const label = entry.label || relativePath(uri)
      return {
        uri: uri.toString(),
        label,
        type: entry.type,
        insertText: entry.insertText || label,
      }
    } catch {
      return undefined
    }
  }

  private mentionedContextFromRefs(refs: QueuedMentionedFileRef[]): MentionedContextRef[] {
    const context: MentionedContextRef[] = []
    for (const ref of refs) {
      try {
        context.push({
          uri: vscode.Uri.parse(ref.uri),
          type: ref.type,
          label: ref.label,
          insertText: ref.insertText,
        })
      } catch {
        this.deps.output.appendLine(`[mention] skipped invalid context ref: ${ref.uri}`)
      }
    }
    return context
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
    if (this.currentSessionSending()) {
      const enqueued = this.enqueueChatSend(text, options, mentioned.uris, mentioned.refs, clientQueueID, contextItems)
      if (enqueued && !this.shouldPreserveOneShotContext(text)) {
        this.deps.contextStore.consumeOneShot(contextItems)
        this.postState()
      }
      return
    }

    await this.processSendMessage(text, options, mentioned.uris, contextItems, mentioned.refs)
  }

  private shouldPreserveOneShotContext(text: string) {
    return Boolean(parseExplicitExportCommand(text) || isExportIntentCandidate(text))
  }

  private async processSendMessage(
    text: string,
    options: ChatContextOptions,
    mentionedFiles: vscode.Uri[],
    contextItems: LocalContextItem[] = this.deps.contextStore.snapshot(),
    mentionedFileRefs = this.mentionedFileRefsFromUris(mentionedFiles),
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

    return this.sendMessage(text, options, mentionedFiles, contextItems, mentionedFileRefs)
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

  private async registerDiagramVisualEvidence(message: Extract<ChatViewMessage, { type: "registerDiagramVisualEvidence" }>) {
    const client = this.deps.getClient()
    if (!client || !this.sessionID || message.sessionID !== this.sessionID) return
    if (!message.messageId || !message.dataUri || (message.kind !== "drawio" && message.kind !== "mermaid")) return
    try {
      await client.appendVisualEvidence({
        sessionID: this.sessionID,
        messageID: message.messageId,
        kind: message.kind,
        diagramId: message.diagramId,
        title: message.title,
        sourceHash: message.sourceHash,
        dataUri: message.dataUri,
        width: message.width,
        height: message.height,
      })
    } catch (error) {
      this.deps.output.appendLine(`[visual-context] failed to store rendered diagram: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async exportDrawioImage(message: Extract<ChatViewMessage, { type: "exportDrawioImage" }>) {
    let bytes: Uint8Array
    try {
      bytes = decodeDrawioPngDataUri(message.dataUri || "")
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error)
      this.postExportStatus(warning)
      vscode.window.showWarningMessage(warning)
      return
    }

    const uri = await vscode.window.showSaveDialog({
      title: "Export draw.io diagram as PNG",
      saveLabel: "Export",
      defaultUri: this.defaultExportUri(drawioPngFilename(message.filenameHint || message.diagramId)),
      filters: {
        PNG: ["png"],
      },
    })
    if (!uri) {
      this.postExportStatus("Draw.io PNG export canceled.")
      return
    }

    await vscode.workspace.fs.writeFile(uri, bytes)
    const exported = `Exported draw.io PNG to ${uri.fsPath}.`
    this.deps.output.appendLine(`[export] ${exported}`)
    this.postExportStatus(exported)
    vscode.window.showInformationMessage(exported)
  }

  private logDrawioRenderTelemetry(message: Extract<ChatViewMessage, { type: "drawioRenderTelemetry" }>) {
    const fields = [
      `phase=${truncate(message.phase || "unknown", 80)}`,
      message.code ? `code=${truncate(message.code, 120)}` : undefined,
      message.message ? `message=${truncate(message.message, 300)}` : undefined,
      message.mode ? `mode=${truncate(message.mode, 80)}` : undefined,
      message.runtime ? `runtime=${truncate(message.runtime, 80)}` : undefined,
      message.requestId ? `requestId=${truncate(message.requestId, 120)}` : undefined,
      message.frameSrc ? `frameSrc=${truncate(message.frameSrc, 240)}` : undefined,
      message.usesCdn === undefined ? undefined : `usesCdn=${message.usesCdn ? "true" : "false"}`,
    ].filter(Boolean)
    this.deps.output.appendLine(`[drawio-render] ${fields.join(" ")}`)
  }

  private async exportMermaidImage(message: Extract<ChatViewMessage, { type: "exportMermaidImage" }>) {
    let bytes: Uint8Array
    try {
      bytes = decodePngDataUri(message.dataUrl || "", "Mermaid PNG export")
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error)
      this.postExportStatus(warning)
      vscode.window.showWarningMessage(warning)
      return
    }

    const uri = await vscode.window.showSaveDialog({
      title: "Export Mermaid diagram as PNG",
      saveLabel: "Export",
      defaultUri: this.defaultExportUri(pngExportFilename(message.filenameHint, mermaidPngFilenameBase())),
      filters: {
        PNG: ["png"],
      },
    })
    if (!uri) {
      this.postExportStatus("Mermaid PNG export canceled.")
      return
    }

    await vscode.workspace.fs.writeFile(uri, bytes)
    const exported = `Exported Mermaid PNG to ${uri.fsPath}.`
    this.deps.output.appendLine(`[export] ${exported}`)
    this.postExportStatus(exported)
    vscode.window.showInformationMessage(exported)
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

  private postSkillsImportStatus(message: string, status = "info", result?: SkillImportResult) {
    this.view?.webview.postMessage({
      type: "skillsImportStatus",
      message,
      status,
      result,
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

  private postQueueRejected(clientQueueID: string | undefined, message: string, reason?: string) {
    if (!clientQueueID) {
      this.view?.webview.postMessage({
        type: "queueStatus",
        ...this.queuedSendSnapshot(),
        message,
        status: "warning",
        reason,
      })
      return
    }
    this.view?.webview.postMessage({
      type: "queueRejected",
      clientQueueID,
      message,
      status: "warning",
      reason,
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
    const sending = this.currentSessionSending()
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
        sending,
        sendCancellable: sending && this.currentSessionCancellable(),
        activeSendActivity: this.currentActiveSendActivity(),
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
    title: sessionListTitle(session),
    created: session.time?.created,
    updated: session.time?.updated ?? session.time?.created,
    serverToolsUsed,
  }
}

function sessionListTitle(session: ChipMateSession) {
  const displayTitle = session.displayTitle?.trim()
  if (displayTitle) return displayTitle
  const canonical = session.title?.trim()
  if (canonical && canonical !== CHAT_SESSION_TITLE) return canonical
  return "Untitled chat"
}

function sessionHasLikelyMessages(session: ChipMateSession) {
  const created = session.time?.created ?? 0
  const updated = session.time?.updated ?? 0
  return updated > created
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

function chatSendStageFromSessionStatus(status: ChipMateSessionStatus): ChatSendStage | undefined {
  if (status.type !== "busy") return undefined
  const stage = "stage" in status && typeof status.stage === "string" ? status.stage : ""
  if (stage === "preparing" || stage === "summarizing" || stage === "sending" || stage === "thinking") return stage
  return undefined
}

function chatSendStatusDetail(status: ChipMateSessionStatus) {
  if ("message" in status && typeof status.message === "string") return status.message
  return ""
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
    .filter(isRenderablePart)
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

function firstUserMessage(messages: readonly ChipMateMessage[]) {
  return messages.find((message) => message.info.role === "user")
}

function firstUserMessageMode(messages: readonly ChipMateMessage[]) {
  return firstUserMessage(messages)?.info.mode
}

function firstUserMessagePreview(messages: readonly ChipMateMessage[]) {
  const firstUser = firstUserMessage(messages)
  const text = firstUser ? messageText(firstUser).trim() : ""
  if (!text) return ""
  const singleLine = text.replace(/\s+/g, " ")
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine
}

function renderPart(part: ChipMatePart): RenderedPart {
  if (part.type === "text" && "text" in part && typeof part.text === "string") {
    return {
      type: part.type,
      text: part.text,
    }
  }
  if (part.type === "generatedDocument") {
    const record = part as Record<string, unknown>
    return {
      type: "generatedDocument",
      title: stringFromPart(record.title) || "Generated Word Document",
      path: stringFromPart(record.path),
      absolutePath: stringFromPart(record.absolutePath),
      sourceCount: numberFromPart(record.sourceCount),
      warningCount: numberFromPart(record.warningCount),
      warnings: stringArrayFromPart(record.warnings),
    }
  }
  if (part.type === "diagram") {
    const record = part as Record<string, unknown>
    return {
      type: "diagram",
      kind: stringFromPart(record.kind) || "drawio",
      title: stringFromPart(record.title) || "draw.io diagram",
      xml: stringFromPart(record.xml),
      warnings: stringArrayFromPart(record.warnings),
      source: stringFromPart(record.source),
      diagramId: stringFromPart(record.diagramId),
      toolCallID: stringFromPart(record.toolCallID),
    }
  }
  if (part.type === "clarification") {
    const record = part as Record<string, unknown>
    return {
      type: "clarification",
      title: stringFromPart(record.title) || "需要确认",
      status: stringFromPart(record.status) || "pending",
      detail: stringFromPart(record.reason),
      clarificationId: stringFromPart(record.clarificationId),
      toolCallID: stringFromPart(record.toolCallID),
      questions: clarificationQuestionsFromPart(record.questions),
      answers: clarificationAnswersFromPart(record.answers),
    }
  }
  if (part.type === "docAgentTimeline") {
    const record = part as Record<string, unknown>
    return {
      type: "docAgentTimeline",
      title: stringFromPart(record.title) || "本地 Word 生成过程",
      status: stringFromPart(record.status),
      events: timelineEventsFromPart(record.events),
      startedAt: numberFromPart(record.startedAt),
      current: numberFromPart(record.current),
      total: numberFromPart(record.total),
      warningCount: numberFromPart(record.warningCount),
      fallbackCount: numberFromPart(record.fallbackCount),
      conflictCount: numberFromPart(record.conflictCount),
      path: stringFromPart(record.path),
    }
  }
  if (part.type === "tool") {
    const state = toolState(part)
    const metadata = recordFromPart(state?.metadata)
    return {
      type: "tool",
      title: displayToolName("tool" in part && typeof part.tool === "string" ? part.tool : "tool"),
      status: toolStatus(part),
      detail: toolDetail(part),
      approvalRequestId: stringFromPart(metadata.approvalRequestId),
      approvalTitle: stringFromPart(metadata.approvalTitle),
      approvalSummary: stringFromPart(metadata.approvalSummary),
      approvalRisk: stringFromPart(metadata.approvalRisk),
      approvalReason: stringFromPart(metadata.approvalReason),
      approvalPath: stringFromPart(metadata.approvalPath),
      approvalBytes: numberFromPart(metadata.approvalBytes),
      approvalActions: stringArrayFromPart(metadata.approvalActions),
    }
  }
  return {
    type: part.type,
    text: "",
  }
}

function isRenderablePart(part: RenderedPart) {
  return Boolean(
    part.text
    || part.detail
    || part.status
    || part.xml
    || part.path
    || part.absolutePath
    || part.events?.length
    || part.type === "generatedDocument"
    || part.type === "diagram"
    || part.type === "clarification"
    || part.type === "docAgentTimeline",
  )
}

function stringFromPart(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberFromPart(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordFromPart(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function messageIDFromRemoteEvent(event: ChipMateEvent) {
  const properties = recordFromPart(event.properties)
  if (event.type === "message.updated") return stringFromPart(recordFromPart(properties.info).id)
  if (event.type === "message.part.updated") return stringFromPart(recordFromPart(properties.part).messageID)
  if (event.type === "message.part.delta") {
    const part = recordFromPart(properties.part)
    return stringFromPart(part.messageID) || stringFromPart(properties.messageID)
  }
  if (event.type === "message.part.removed" || event.type === "message.removed") return stringFromPart(properties.messageID)
  return undefined
}

function partIDFromRemoteEvent(event: ChipMateEvent) {
  const properties = recordFromPart(event.properties)
  if (event.type === "message.part.updated") return stringFromPart(recordFromPart(properties.part).id)
  if (event.type === "message.part.delta") {
    const part = recordFromPart(properties.part)
    return stringFromPart(part.id) || stringFromPart(properties.partID)
  }
  if (event.type === "message.part.removed") return stringFromPart(properties.partID)
  return undefined
}

function messagesContainMessagePart(messages: readonly ChipMateMessage[], messageID: string, partID?: string) {
  const message = messages.find((item) => item.info.id === messageID)
  if (!message) return false
  if (!partID) return true
  return message.parts.some((part) => stringFromPart(recordFromPart(part).id) === partID)
}

function stringArrayFromPart(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

function clarificationQuestionsFromPart(value: unknown): NonNullable<RenderedPart["questions"]> {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).map((item, index) => {
    const record = recordFromPart(item)
    const choicesValue = record.choices
    const choices = Array.isArray(choicesValue)
      ? choicesValue.slice(0, 5).map((choice, choiceIndex) => {
          const choiceRecord = recordFromPart(choice)
          return {
            id: stringFromPart(choiceRecord.id) || `c${choiceIndex + 1}`,
            label: stringFromPart(choiceRecord.label) || "",
            description: stringFromPart(choiceRecord.description),
          }
        }).filter((choice) => choice.label)
      : []
    return {
      id: stringFromPart(record.id) || `q${index + 1}`,
      question: stringFromPart(record.question) || "",
      choices,
      allowFreeText: record.allowFreeText === true,
    }
  }).filter((question) => question.question)
}

function clarificationAnswersFromPart(value: unknown): NonNullable<RenderedPart["answers"]> {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).map((item, index) => {
    const record = recordFromPart(item)
    return {
      questionId: stringFromPart(record.questionId) || `q${index + 1}`,
      choiceId: stringFromPart(record.choiceId),
      text: stringFromPart(record.text),
    }
  }).filter((answer) => answer.questionId && (answer.choiceId || answer.text))
}

function timelineEventsFromPart(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is Partial<DocAgentTimelineEvent> => Boolean(item && typeof item === "object" && "type" in item && "title" in item && "status" in item))
    .map((item, index) => ({
      ...item,
      id: typeof item.id === "string" ? item.id : `doc-agent-history-${index + 1}`,
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
      timelineKey: typeof item.timelineKey === "string" ? item.timelineKey : undefined,
      stateLabel: typeof item.stateLabel === "string" ? item.stateLabel : undefined,
    } as DocAgentTimelineEvent))
    .slice(-160)
}

function displayText(role: string, text: string) {
  if (role !== "user") return text
  return extractPluginChatQuestionText(text)
}

function localMessage(role: string, text: string, overrides: Partial<RenderedMessage> = {}): RenderedMessage {
  const parts: RenderedPart[] = [{ type: "text", text }]
  if (overrides.sendStatus) parts.push({ type: "sendStatus", status: overrides.sendStatus.stage, text: overrides.sendStatus.label, detail: overrides.sendStatus.detail })
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    timeCreated: Date.now(),
    parts,
    ...overrides,
  }
}

function generatedDocumentMessage(result: GeneratedDocumentResult): RenderedMessage {
  const warningLine = result.warningCount > 0 ? `\n\nWarning：${result.warningCount} 条。打开 Word 后请更新目录域。` : "\n\n打开 Word 后请更新目录域。"
  const title = result.title ?? "Word 文档"
  return localMessage("assistant", `已生成${title}：${result.path}${warningLine}`, {
    parts: [
      { type: "text", text: `已生成${title}：${result.path}${warningLine}` },
      generatedDocumentPart(result),
    ],
  })
}

function generatedDocumentPart(result: GeneratedDocumentResult): RenderedPart {
  return {
    type: "generatedDocument",
    title: "Generated Word Document",
    path: result.path,
    absolutePath: result.absolutePath,
    sourceCount: result.sourceCount,
    warningCount: result.warningCount,
    warnings: result.warnings,
  }
}

function persistedDocAgentTimelinePart(message: RenderedMessage, result: GeneratedDocumentResult): RenderedPart {
  const timeline = message.parts.find((part) => part.type === "docAgentTimeline")
  const events = summarizePersistedDocAgentTimelineEvents((timeline?.events ?? []).filter((event) =>
    event.type === "read_docx"
    || event.type === "plan"
    || event.type === "source_classify"
    || event.type === "chunking"
    || event.type === "model.extract"
    || event.type === "evidence"
    || event.type === "conflict.review"
    || event.type === "merge"
    || event.type === "word_spec"
    || event.type === "quality_gate"
    || event.type === "create_word_document"
    || event.type === "done"
    || event.type === "error",
  )).slice(-24)
  const doneEvent: DocAgentTimelineEvent = {
    id: `doc-agent-history-done-${Date.now()}`,
    type: "done",
    title: "本地 Word 生成完成",
    detail: result.path,
    status: "completed",
    timestamp: Date.now(),
    path: result.path,
  }
  const summarizedEvents = events.some((event) => event.type === "done")
    ? events
    : [...events, doneEvent]
  return {
    type: "docAgentTimeline",
    title: "本地 Word 生成完成",
    status: "completed",
    events: summarizedEvents,
    startedAt: timeline?.startedAt,
    current: timeline?.total ?? timeline?.current,
    total: timeline?.total,
    warningCount: result.warningCount,
    fallbackCount: timeline?.fallbackCount ?? 0,
    conflictCount: timeline?.conflictCount ?? 0,
    path: result.path,
  }
}

function summarizePersistedDocAgentTimelineEvents(events: DocAgentTimelineEvent[]) {
  return events.reduce<DocAgentTimelineEvent[]>((summary, event) => mergeDocAgentTimelineEvent(summary, event), [])
}

function renderedPartsForHistory(parts: RenderedPart[]): ChipMatePart[] {
  return parts.map((part) => JSON.parse(JSON.stringify(part)) as ChipMatePart)
}

function orderMentionedFileRefs(files: MentionedFileRef[]) {
  return files
    .map((file, index) => ({
      file,
      index,
      mentionIndex: Number.isFinite(file.mentionIndex) ? Number(file.mentionIndex) : index,
    }))
    .sort((left, right) => {
      if (left.mentionIndex !== right.mentionIndex) return left.mentionIndex - right.mentionIndex
      return left.index - right.index
    })
    .map((item, index) => ({
      ...item.file,
      mentionIndex: item.file.mentionIndex ?? index,
    }))
}

function createDocAgentTimelinePart(): RenderedPart {
  return {
    type: "docAgentTimeline",
    title: "本地 Word 生成过程",
    status: "running",
    events: [],
    startedAt: Date.now(),
    current: 0,
    total: 0,
    warningCount: 0,
    fallbackCount: 0,
  }
}

function appendDocAgentTimelineEvent(message: RenderedMessage, event: DocAgentTimelineEvent) {
  const existing = message.parts.find((part) => part.type === "docAgentTimeline") ?? createDocAgentTimelinePart()
  if (!message.parts.includes(existing)) message.parts.push(existing)
  const events = mergeDocAgentTimelineEvent(existing.events ?? [], event).slice(-160)
  existing.events = events
  existing.title = event.title
  existing.status = event.status === "error" ? "error" : event.status === "waiting" ? "waiting" : event.status === "warning" ? "warning" : event.type === "done" ? "completed" : "running"
  existing.current = event.current ?? existing.current
  existing.total = event.total ?? existing.total
  existing.warningCount = events.filter((item) => item.status === "warning" || item.status === "error").length
  existing.fallbackCount = events.filter((item) => item.type === "fallback" || item.stateLabel === "本地回退").length
  existing.conflictCount = events.filter((item) => item.type === "conflict.review").at(-1)?.total ?? existing.conflictCount
  if (event.path) existing.path = event.path
  updateTextPart(message, event.stateLabel ? `${event.title} · ${event.stateLabel}` : event.title)
}

function docAgentModelWaitingEvent(event: DocAgentModelWaitEvent): DocAgentTimelineEvent {
  const stage = docAgentModelTimelineStage(event.purpose)
  const elapsedSeconds = Math.max(1, Math.round(event.elapsedMs / 1000))
  return {
    id: `doc-agent-model-wait-${event.purpose}-${Date.now()}`,
    type: stage.type,
    title: stage.title,
    detail: event.warning
      ? `模型 ${event.model} 正在处理 ${event.purpose}，阶段 ${event.stage}，已等待 ${elapsedSeconds}s。${event.warning}`
      : `模型 ${event.model} 正在处理 ${event.purpose}，阶段 ${event.stage}，已等待 ${elapsedSeconds}s。`,
    status: event.warning ? "warning" : "waiting",
    timelineKey: stage.timelineKey,
    stateLabel: `等待模型 ${elapsedSeconds}s`,
    timestamp: Date.now(),
    current: stage.current,
    total: stage.total,
  }
}

function docAgentModelTimelineStage(purpose: DocAgentModelWaitEvent["purpose"]): { type: DocAgentTimelineEvent["type"]; title: string; timelineKey: string; current: number; total: number } {
  if (purpose === "plan-document") return { type: "plan", title: "生成 DocumentPlan", timelineKey: "plan", current: 2, total: 8 }
  if (purpose === "plan-source-roles") return { type: "source_classify", title: "识别来源角色", timelineKey: "source_classify", current: 2, total: 8 }
  if (purpose === "extract-rules" || purpose === "extract-rules-batch") return { type: "model.extract", title: "模型抽取候选规则", timelineKey: "model.extract", current: 4, total: 8 }
  if (purpose === "generate-word-spec") return { type: "word_spec", title: "生成 WordDocSpec", timelineKey: "word_spec", current: 6, total: 8 }
  return { type: "merge", title: purpose === "plan-source-block-placement" ? "来源块语义归位" : "合并内部规范与外部参考规则", timelineKey: "merge", current: 5, total: 8 }
}

function mergeDocAgentTimelineEvent(events: DocAgentTimelineEvent[], event: DocAgentTimelineEvent) {
  if (!event.timelineKey) return [...events, event]
  const existingIndex = events.findIndex((item) => item.timelineKey === event.timelineKey)
  if (existingIndex < 0) return [...events, event]
  const next = [...events]
  next[existingIndex] = event
  return next
}

function updateTextPart(message: RenderedMessage, text: string) {
  const textPart = message.parts.find((part) => part.type === "text")
  if (textPart) textPart.text = text
  else message.parts.unshift({ type: "text", text })
}

function updateSendStatusPart(parts: RenderedPart[], sendStatus: SendStatusView) {
  const next = parts.filter((part) => part.type !== "sendStatus")
  next.push({
    type: "sendStatus",
    status: sendStatus.stage,
    text: sendStatus.label,
    detail: sendStatus.detail,
  })
  return next
}

function upsertPart(message: RenderedMessage, part: RenderedPart) {
  const existing = message.parts.find((item) => item.type === part.type)
  if (!existing) {
    message.parts.push(part)
    return
  }
  Object.assign(existing, part)
}

function updatePart(message: RenderedMessage, type: string, patch: Partial<RenderedPart>) {
  const existing = message.parts.find((part) => part.type === type)
  if (existing) Object.assign(existing, patch)
}

function renderedConflict(conflict: ConflictRule): RenderedDocAgentConflict {
  return {
    id: conflict.id,
    title: conflict.title,
    internalSource: conflict.internal ? `${conflict.internal.sourceDocument} / ${conflict.internal.sourceSection}` : "未识别到第一份依据",
    externalSource: conflict.external ? `${conflict.external.sourceDocument} / ${conflict.external.sourceSection}` : "未识别到第二份依据",
    internalSummary: conflict.internal?.description ?? "",
    externalSummary: conflict.external?.description ?? "",
    recommendation: conflict.recommendation,
    choice: conflict.decision?.choice ?? "review",
  }
}

function normalizeConflictChoice(choice: ConflictResolutionChoice | undefined): ConflictResolutionChoice {
  if (choice === "internal" || choice === "external" || choice === "review") return choice
  return "review"
}

function conflictDecisionSummary(decisions: ConflictResolutionDecision[]) {
  const internal = decisions.filter((item) => item.choice === "internal").length
  const external = decisions.filter((item) => item.choice === "external").length
  const review = decisions.filter((item) => item.choice === "review").length
  return `采用第一份 ${internal} 条 · 采用第二份 ${external} 条 · 保留待评审 ${review} 条`
}

function abortError(message: string) {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function displayToolName(tool: string) {
  if (tool === "chipmate_read" || tool === "chipmate_read_file") return "Read file"
  if (tool === "chipmate_read_evidence") return "Read evidence"
  if (tool === "chipmate_read_skill_resource") return "Read skill resource"
  if (tool === "chipmate_create_file") return "Create file"
  if (tool === "chipmate_create_directory") return "Create folder"
  if (tool === "chipmate_edit_file") return "Edit file"
  return tool
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

function isActiveToolStatus(status: string | undefined) {
  return status === "running" || status === "approval-required" || status === "pending" || status === "waiting"
}

const WORKSPACE_FILESYSTEM_TOOLS = new Set(["read", "glob", "grep", "list", "bash", "edit", "write", "patch", "multiedit", "external_directory", "lsp", "chipmate_edit_file"])

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

function skillImportResultStatus(result: SkillImportResult) {
  if (result.imported.length > 0 && (result.invalid.length > 0 || result.skipped.length > 0 || result.warnings.length > 0)) return "warning"
  if (result.imported.length > 0) return "success"
  return "error"
}

function skillImportResultMessage(result: SkillImportResult) {
  const parts = [
    result.imported.length > 0 ? `Imported ${result.imported.length} skill${result.imported.length === 1 ? "" : "s"}` : "",
    result.invalid.length > 0 ? `${result.invalid.length} invalid` : "",
    result.skipped.length > 0 ? `${result.skipped.length} skipped` : "",
    result.enabledSkillIdsAdded.length > 0 ? `enabled ${result.enabledSkillIdsAdded.length} legacy skill id${result.enabledSkillIdsAdded.length === 1 ? "" : "s"}` : "",
    result.warnings.length > 0 ? result.warnings[0] : "",
  ].filter(Boolean)
  return parts.length > 0 ? `${parts.join(". ")}.` : "No skills imported."
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
      if (!isDroppedWorkspaceContext(stat)) {
        skippedCount += 1
        continue
      }

      const type: "file" | "folder" = stat.type & vscode.FileType.Directory ? "folder" : "file"
      const label = relativePath(uri)
      files.push({
        uri: key,
        label,
        type,
        insertText: type === "folder" ? `${label.replace(/\/+$/, "")}/` : label,
      })
    } catch {
      skippedCount += 1
      continue
    }
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

  const added = `Added ${files.length} dropped context item${files.length === 1 ? "" : "s"} to this message.`
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

function isDroppedWorkspaceContext(stat: vscode.FileStat) {
  return Boolean(stat.type & (vscode.FileType.File | vscode.FileType.Directory))
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function mermaidPngFilenameBase(exportedAt = new Date()) {
  const stamp = exportedAt.toISOString().slice(0, 19).replace(/[T:]/g, "-")
  return `chipmate-mermaid-${stamp}`
}
