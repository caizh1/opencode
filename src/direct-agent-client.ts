import * as vscode from "vscode"
import { CHIPMATE_LOCAL_AGENT_ID, CHIPMATE_SESSION_TITLE } from "./chipmate-constants"
import { extractPluginChatQuestionText, pluginHistoryUserText } from "./chat-session"
import { chatCompletionsUrl } from "./completion-model-client"
import { terminalProjectContextPrompt, type TerminalProjectContext } from "./agent-terminal-project-context"
import { activeSkillPolicies, renderSkillsForPrompt, selectActiveSkills, skillSystemCatalog, SkillRegistry, type ActiveSkillPolicy } from "./skills"
import { retryHeadersForError, sessionRetryableError, sessionRetryDelayMs, sessionRetryLimitFromEnv } from "./session-retry"
import { UsageLedgerService, usageRecordFromMessage } from "./usage-ledger"
import { estimateChatTokenUsage, normalizeProviderTokenUsage } from "./usage"
import { GoalRuntime } from "./goal-runtime"
import type { ClarificationRequest, ToolApprovalDecision, ToolApprovalHandler, ToolApprovalRequest, ToolRuntime, ToolRuntimeProgressEvent, ToolRuntimeResult } from "./tool-runtime"
import type {
  ConnectionState,
  HealthResponse,
  ChipMateAgentInfo,
  ChipMateEvent,
  ChipMateMessage,
  ChipMatePart,
  ChipMateModelInfo,
  ChipMateSession,
  ChipMateSessionStatus,
  ChipMateTokenUsage,
  ChipMateUsageStatsOptions,
  ChipMateUsageStatsSnapshot,
  EvidenceLedgerEntry,
  RemoteSettings,
  ThreadGoal,
  ThreadGoalOperation,
  ThreadGoalStatus,
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
  displayTitle?: string
  displayTitleSource?: "model" | "fallback"
  time: {
    created: number
    updated: number
  }
}

type ConversationMemoryRecord = {
  id: string
  sessionID: string
  createdAt: number
  updatedAt: number
  coveredMessageIDs: string[]
  summary: string
  sourceTurnCount: number
  summaryVersion: number
}

type EvidenceLedgerRecord = {
  id: string
  sessionID: string
  messageID: string
  createdAt: number
  entries: EvidenceLedgerEntry[]
  summaryVersion: number
}

type VisualEvidenceRecord = {
  id: string
  sessionID: string
  messageID: string
  createdAt: number
  kind: "drawio" | "mermaid" | "word-render-page"
  diagramId?: string
  title?: string
  sourceHash?: string
  artifactPath?: string
  page?: number
  mediaType: "image/png"
  width?: number
  height?: number
  byteLength: number
  summaryVersion: number
}

type SessionEvent =
  | { type: "session"; session: SessionRecord }
  | { type: "message"; message: ChipMateMessage }
  | { type: "memory"; memory: ConversationMemoryRecord }
  | { type: "evidence"; evidence: EvidenceLedgerRecord }
  | { type: "visual_evidence"; visualEvidence: VisualEvidenceRecord }

export type LocalHistoryMessageInput = {
  role: "user" | "assistant"
  text: string
  parts?: ChipMatePart[]
  error?: string
  mode?: string
}

type MermaidRepairInput = {
  sessionID: string
  messageID: string
  source: string
  error: string
  sourceHash?: string
  diagramId?: string
  language?: string
  signal?: AbortSignal
}

const TOOL_ARGUMENT_STATE: unique symbol = Symbol("chipmate.toolArgumentState")

type ChatToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
  [TOOL_ARGUMENT_STATE]?: ToolArgumentState
}

type ToolArgumentState = {
  truncated?: boolean
  originalBytes?: number
  maxBytes?: number
}

type ToolArgumentParseResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errorCode: string; errorMessage: string }

type ChatCompletionChoiceMessage = {
  content?: unknown
  tool_calls?: Array<{
    function?: {
      arguments?: unknown
    }
  }>
  reasoning?: unknown
  reasoning_content?: unknown
}

type ChatCompletionChoice = {
  message?: ChatCompletionChoiceMessage
  text?: unknown
  finish_reason?: unknown
}

class ChatCompletionHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodyPreview: string,
    readonly headers: Headers,
  ) {
    super(message)
    this.name = "ChatCompletionHttpError"
  }
}

type ChatMessageTextContent = {
  type: "text"
  text: string
}

type ChatMessageImageContent = {
  type: "image_url"
  image_url: {
    url: string
    detail?: "auto" | "low" | "high"
  }
}

type ChatMessageContent = string | Array<ChatMessageTextContent | ChatMessageImageContent>

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: ChatMessageContent | null
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
}

type ReusableHistoryMessage = ChatMessage & {
  id: string
  role: "user" | "assistant"
  content: string
}

type ConversationMemoryRefreshInput = {
  sessionID: string
  settings: RemoteSettings
  latestMemory?: ConversationMemoryRecord
  historyMessages: ReusableHistoryMessage[]
  newOverflowMessages: ReusableHistoryMessage[]
  signal?: AbortSignal
}

type ChatToolDefinition = ReturnType<ToolRuntime["toolDefinitions"]>[number]

type WordVisualQaArtifact = {
  path?: string
  pdfArtifactPath?: string
  pagePngPaths: string[]
  pageCount: number
  attempted?: boolean
  ok?: boolean
  warnings: string[]
  pageVisualSummaries: unknown[]
  visualEvidenceCount: number
  coverage: WordVisualQaPageCoverage[]
  batchSize: number
  batchCount: number
}

type WordVisualQaPageCoverage = {
  page: number
  path?: string
  status: "pending" | "attached" | "inspected" | "summary-only" | "skipped" | "failed"
  reason?: string
}

type WordVisualQaBatch = {
  artifact: WordVisualQaArtifact
  batchIndex: number
  batchCount: number
  pages: WordVisualQaPageCoverage[]
  images: ChatMessageImageContent[]
}

type WordVisualQaState = {
  pendingBatches: WordVisualQaBatch[]
  renderRoundCount: number
  qaBatchCount: number
  imageInputRejected: boolean
}

type DeliveryExpectationKind = "docx" | "artifact"

type DeliveryExpectation = {
  kind: DeliveryExpectationKind
  label: string
  requiredExtensions: string[]
}

type DeliveryArtifactRecord = {
  kind: string
  path: string
  tool: string
}

type DeliveryNextAction = {
  tool: string
  reason: string
  argsSummary?: string
  sourceTool: string
}

type DeliveryProducerFailure = {
  tool: string
  reason: string
  errorCode?: string
  validationErrors: string[]
  specShapeHash?: string
}

type DeliveryDisciplineState = {
  expectations: DeliveryExpectation[]
  producedArtifacts: DeliveryArtifactRecord[]
  pendingNextActions: DeliveryNextAction[]
  producerFailures: DeliveryProducerFailure[]
  completedTools: string[]
  convergencePromptInserted: boolean
  missingDeliverablePromptInserted: boolean
  producerFailureRepairPromptInserted: boolean
  wordRenderCheckpointInserted: boolean
}

type ToolExecutionSummary = {
  tool: string
  status: string
  title: string
  risk?: string
  approved: boolean
  messageID: string
  toolCallID: string
  at: number
  inputSummary?: string
  resultSummary?: string
  failureReason?: string
}

type PendingToolApproval = {
  sessionID: string
  messageID: string
  toolCallID: string
  requestID: string
  resolve: (decision: ToolApprovalDecision) => void
}

export type ClarificationAnswer = {
  questionId: string
  choiceId?: string
  text?: string
}

type PendingClarification = {
  requestID: string
  sessionID: string
  messageID: string
  toolCallID: string
  resolve: (answers: ClarificationAnswer[]) => void
  reject: (error: Error) => void
}

export type TerminalCommandPlanInput = {
  mode: "initial" | "repair"
  cwd: string
  userText: string
  rawInput?: string
  recentActivity?: string[]
  projectContext?: TerminalProjectContext
  failedCommand?: string
  failureKind?: string
  missingCommand?: string
  repairPreference?: "prefer-no-install-fallback"
  platform?: string
  shell?: string
  shellKind?: string
  exitCode?: number | null
  signalName?: string | null
  outputTail?: string
  attemptedCommands?: string[]
  failureReason?: string
  nonInteractiveReason?: string
  signal?: AbortSignal
}

export type TerminalCommandPlan =
  | {
    kind: "command"
    command: string
    explanation: string
    confidence?: "low" | "medium" | "high"
    title?: string
    purpose?: string
    expectedOutcome?: string
    riskNote?: string
  }
  | { kind: "answer"; message: string }
  | { kind: "clarify"; question: string }

export type TerminalCommandResultSummaryInput = {
  cwd: string
  command: string
  source: "agent" | "direct" | "repair"
  originalRequest?: string
  title?: string
  purpose?: string
  expectedOutcome?: string
  risk?: string
  failureBasis?: string
  exitCode: number | null
  signalName: string | null
  elapsedMs: number
  outputTail: string
  hasUsableResult: boolean
  warnings?: string[]
  signal?: AbortSignal
}

export type TerminalCommandResultSummary = {
  status: "success" | "warning" | "failed" | "aborted"
  headline: string
  resultLines: string[]
  warnings: string[]
  nextStep: string
}

const DEFAULT_MAX_AGENT_STEPS = 25
const MIN_MAX_AGENT_STEPS = 1
const HARD_MAX_AGENT_STEPS = 100
const MAX_STREAM_TOOL_ARGUMENT_BYTES = 128 * 1024
const MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES = 900
const CONVERSATION_MEMORY_SUMMARY_VERSION = 1
const EVIDENCE_LEDGER_SUMMARY_VERSION = 1
const VISUAL_EVIDENCE_SUMMARY_VERSION = 1
const MAX_CONVERSATION_MEMORY_TRANSCRIPT_BYTES = 80 * 1024
const MAX_TOOL_EXECUTION_HISTORY_BYTES = 24 * 1024
const MAX_TOOL_EXECUTION_LINE_BYTES = 700
const MAX_TOOL_EXECUTION_FIELD_CHARS = 240
const MAX_EVIDENCE_LEDGER_HISTORY_BYTES = 12 * 1024
const MAX_EVIDENCE_LEDGER_LINE_BYTES = 700
const MAX_EVIDENCE_LEDGER_FIELD_CHARS = 240
const MAX_VISUAL_EVIDENCE_IMAGES_PER_TURN = 3
const MAX_VISUAL_EVIDENCE_SOFT_IMAGE_BYTES = 1024 * 1024
const MAX_VISUAL_EVIDENCE_HARD_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_WORD_VISUAL_QA_REPAIR_ROUNDS = 2
const WORD_VISUAL_QA_IMAGES_PER_BATCH = 3
const EVIDENCE_CONVERGENCE_CHECKPOINT_REMAINING_STEPS = 5
const MAX_MERMAID_REPAIR_TOKENS = 4096
const DIRECT_PROVIDER_VERSION = "direct-openai-compatible"

export class DirectAgentClient {
  readonly baseUrl = "chipmate://workspace"
  private readonly listeners = new Set<(event: ChipMateEvent) => void>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly statuses = new Map<string, ChipMateSessionStatus>()
  private readonly goalRuntime: GoalRuntime
  private readonly goalContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly goalOperations = new Map<string, ThreadGoalOperation>()
  private readonly goalStateLocks = new Map<string, Promise<void>>()
  private readonly pendingToolApprovals = new Map<string, PendingToolApproval>()
  private readonly pendingClarifications = new Map<string, PendingClarification>()
  private readonly activeMemoryRefreshes = new Set<string>()
  private readonly queuedMemoryRefreshes = new Map<string, ConversationMemoryRefreshInput>()
  private readonly usageLedger: UsageLedgerService
  private usageBackfillPromise?: Promise<void>

  constructor(private readonly deps: DirectAgentClientInput) {
    this.usageLedger = new UsageLedgerService(deps.context)
    this.goalRuntime = new GoalRuntime(deps.context)
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const settings = this.deps.getSettings()
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      return {
        healthy: false,
        state: "disconnected",
        detail: "Ready. Configure an OpenAI-compatible provider to start ChipMate.",
        version: DIRECT_PROVIDER_VERSION,
      }
    }
    const modelsProbe = await this.probeModels(settings, signal)
    if (modelsProbe.state !== "error" || !modelsProbe.fallbackToChat) return modelsProbe
    return this.probeChatCompletion(settings, signal)
  }

  private async probeModels(settings: RemoteSettings, signal?: AbortSignal): Promise<HealthResponse & { fallbackToChat?: boolean }> {
    let response: Response
    try {
      response = await fetch(modelsUrl(settings.provider.apiBaseUrl), {
        headers: await this.headers(false),
        signal,
      })
    } catch (error) {
      return this.probeError("Provider /models probe failed", error)
    }
    const text = await response.text().catch(() => "")
    if (isProviderAuthFailure(response.status, text)) return providerAuthFailed()
    if (response.ok) {
      try {
        const body = text ? JSON.parse(text) as { data?: unknown } : {}
        if (!Array.isArray(body.data)) {
          return providerProbeFailed("Provider /models probe returned an unexpected response.")
        }
      } catch {
        return providerProbeFailed("Provider /models probe returned malformed JSON.")
      }
      return providerConnected("provider /models")
    }
    if (isModelsEndpointUnsupported(response.status)) {
      return {
        ...providerProbeFailed(`Provider /models is unavailable (${response.status}); probing chat completions.`),
        fallbackToChat: true,
      }
    }
    return providerProbeFailed(`Provider /models probe failed: ${response.status} ${response.statusText || "HTTP error"}.`)
  }

  private async probeChatCompletion(settings: RemoteSettings, signal?: AbortSignal): Promise<HealthResponse> {
    const body = {
      model: settings.provider.chatModel,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1,
      temperature: 0,
    }
    let response: Response
    try {
      response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
        method: "POST",
        headers: await this.headers(true),
        signal,
        body: JSON.stringify(body),
      })
    } catch (error) {
      return this.probeError("Provider chat probe failed", error)
    }
    const text = await response.text().catch(() => "")
    if (isProviderAuthFailure(response.status, text)) return providerAuthFailed()
    if (!response.ok) return providerProbeFailed(`Provider chat probe failed: ${response.status} ${response.statusText || "HTTP error"}.`)
    try {
      const body = text ? JSON.parse(text) as { choices?: unknown } : {}
      if (!Array.isArray(body.choices)) return providerProbeFailed("Provider chat probe returned an unexpected response.")
    } catch {
      return providerProbeFailed("Provider chat probe returned malformed JSON.")
    }
    return {
      healthy: true,
      state: "connected",
      detail: `provider ${DIRECT_PROVIDER_VERSION}`,
      version: DIRECT_PROVIDER_VERSION,
    }
  }

  private probeError(prefix: string, error: unknown): HealthResponse {
    return providerProbeFailed(`${prefix}: ${formatErrorMessage(error)}`)
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
        .map((id, providerIndex) => ({ id, providerIndex, source: "provider" as const }))
      return normalizeModelInfos(
        [
          ...configured.map((id) => ({ id, source: "configured" as const })),
          ...discovered,
        ],
        settings.provider.chatModel,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[provider] /models unavailable, using configured models: ${message}`)
      return normalizeModelInfos(
        configured.map((id) => ({ id, source: "configured" as const })),
        settings.provider.chatModel,
      )
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

  async planTerminalCommand(input: TerminalCommandPlanInput): Promise<TerminalCommandPlan> {
    const settings = this.deps.getSettings()
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      throw new Error("ChipMate provider is not configured for terminal command planning.")
    }
    const messages = terminalCommandPlanningMessages(input)
    const responseRaw = await this.requestTerminalCommandPlan(settings, messages, input.signal)
    let responseText = ""
    try {
      responseText = terminalPlanContentFromResponse(responseRaw)
      this.deps.output.appendLine(`[terminal-planner] response contentBytes=${textByteLength(responseText)}`)
      const plan = parseTerminalCommandPlan(responseText)
      this.deps.output.appendLine(`[terminal-planner] mode=${input.mode} result=${plan.kind}`)
      return plan
    } catch (firstError) {
      const firstSummary = summarizeTerminalPlannerResponse(responseRaw)
      this.deps.output.appendLine(
        `[terminal-planner] invalid response, retrying once context=preserved: ${formatErrorMessage(firstError)} rawSummary=${firstSummary}`,
      )
      const repairMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content: [
            "The previous assistant response was invalid for terminal command planning.",
            `Validation error: ${formatErrorMessage(firstError)}`,
            "Keep using the original user request and all repair context above.",
            "Return exactly one valid JSON object matching the schema in your final assistant message content.",
            "Do not use hidden reasoning, Markdown, prose outside JSON, or tool calls.",
            "Sanitized previous response summary:",
            firstSummary,
          ].join("\n\n"),
        },
      ]
      const retryRaw = await this.requestTerminalCommandPlan(settings, repairMessages, input.signal)
      try {
        const retryText = terminalPlanContentFromResponse(retryRaw)
        this.deps.output.appendLine(`[terminal-planner] response contentBytes=${textByteLength(retryText)} retry=true`)
        const plan = parseTerminalCommandPlan(retryText)
        this.deps.output.appendLine(`[terminal-planner] mode=${input.mode} result=${plan.kind} retry=true`)
        return plan
      } catch (secondError) {
        const secondSummary = summarizeTerminalPlannerResponse(retryRaw)
        this.deps.output.appendLine(
          `[terminal-planner] invalid response after retry context=preserved: ${formatErrorMessage(secondError)} rawSummary=${secondSummary}`,
        )
        throw new Error(`Terminal command planner returned invalid response after retry: ${formatErrorMessage(secondError)} summary=${secondSummary}`)
      }
    }
  }

  async summarizeTerminalCommandResult(input: TerminalCommandResultSummaryInput): Promise<TerminalCommandResultSummary> {
    const settings = this.deps.getSettings()
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      throw new Error("ChipMate provider is not configured for terminal command result summaries.")
    }
    const messages = terminalCommandResultSummaryMessages(input)
    const responseRaw = await this.requestTerminalCommandResultSummary(settings, messages, input.signal)
    const responseText = terminalSummaryContentFromResponse(responseRaw)
    this.deps.output.appendLine(`[terminal-summary] response contentBytes=${textByteLength(responseText)}`)
    const summary = parseTerminalCommandResultSummary(responseText)
    this.deps.output.appendLine(`[terminal-summary] status=${summary.status}`)
    return summary
  }

  async listSessions(_signal?: AbortSignal): Promise<ChipMateSession[]> {
    return (await this.readSessionRecords()).map((session) => ({
      id: session.id,
      title: session.title,
      displayTitle: session.displayTitle,
      displayTitleSource: session.displayTitleSource,
      time: session.time,
    })).sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))
  }

  async getSessionStatuses(_signal?: AbortSignal): Promise<Record<string, ChipMateSessionStatus>> {
    return Object.fromEntries(this.statuses)
  }

  async getGoal(sessionID: string, signal?: AbortSignal): Promise<ThreadGoal | undefined> {
    signal?.throwIfAborted()
    const goal = await this.goalRuntime.getGoal(sessionID)
    return goal ? this.goalRuntime.goalForDisplay(goal) : undefined
  }

  getGoalOperation(sessionID: string | undefined): ThreadGoalOperation | undefined {
    return sessionID ? this.goalOperations.get(sessionID) : undefined
  }

  async restoreGoalAfterSessionResume(sessionID: string, signal?: AbortSignal): Promise<ThreadGoal | undefined> {
    signal?.throwIfAborted()
    return this.withGoalStateLock(sessionID, () => this.restoreGoalAfterSessionResumeUnlocked(sessionID))
  }

  private async restoreGoalAfterSessionResumeUnlocked(sessionID: string): Promise<ThreadGoal | undefined> {
    const goal = await this.goalRuntime.restoreAfterSessionResume(sessionID)
    if (!goal) {
      this.clearGoalContinuationTimer(sessionID)
      this.goalOperations.delete(sessionID)
      return undefined
    }

    const displayGoal = await this.emitGoalUpdated(sessionID, goal)
    if (goal.status === "active") {
      this.scheduleGoalContinuation(sessionID)
    } else {
      this.clearGoalContinuationTimer(sessionID)
      this.finishGoalOperation(sessionID, displayGoal)
    }
    return displayGoal
  }

  async createGoal(input: { sessionID: string; objective: string; tokenBudget?: number; signal?: AbortSignal }) {
    input.signal?.throwIfAborted()
    return this.withGoalStateLock(input.sessionID, () => this.createGoalUnlocked(input))
  }

  private async createGoalUnlocked(input: { sessionID: string; objective: string; tokenBudget?: number }) {
    const goal = await this.goalRuntime.setGoal(input.sessionID, {
      objective: input.objective,
      status: "active",
      tokenBudget: input.tokenBudget,
    })
    const displayGoal = await this.emitGoalUpdated(input.sessionID, goal)
    this.scheduleGoalContinuation(input.sessionID)
    return displayGoal
  }

  async setGoal(input: { sessionID: string; objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null; signal?: AbortSignal }) {
    input.signal?.throwIfAborted()
    return this.withGoalStateLock(input.sessionID, () => this.setGoalUnlocked(input))
  }

  private async setGoalUnlocked(input: { sessionID: string; objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null }) {
    const goal = await this.goalRuntime.setGoal(input.sessionID, {
      objective: input.objective,
      status: input.status,
      tokenBudget: input.tokenBudget,
    })
    const displayGoal = await this.emitGoalUpdated(input.sessionID, goal)
    if (goal.status === "active") this.scheduleGoalContinuation(input.sessionID)
    else this.finishGoalOperation(input.sessionID, displayGoal)
    return displayGoal
  }

  async pauseGoal(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.withGoalStateLock(sessionID, () => this.pauseGoalUnlocked(sessionID))
  }

  private async pauseGoalUnlocked(sessionID: string) {
    const goal = await this.goalRuntime.pauseGoal(sessionID)
    if (goal) {
      const displayGoal = await this.emitGoalUpdated(sessionID, goal)
      this.finishGoalOperation(sessionID, displayGoal)
    }
    return goal ? this.goalRuntime.goalForDisplay(goal) : undefined
  }

  async resumeGoal(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.withGoalStateLock(sessionID, () => this.resumeGoalUnlocked(sessionID))
  }

  private async resumeGoalUnlocked(sessionID: string) {
    const goal = await this.goalRuntime.resumeGoal(sessionID)
    if (goal) {
      await this.emitGoalUpdated(sessionID, goal)
      this.scheduleGoalContinuation(sessionID)
    }
    return goal ? this.goalRuntime.goalForDisplay(goal) : undefined
  }

  async clearGoal(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.withGoalStateLock(sessionID, () => this.clearGoalUnlocked(sessionID))
  }

  private async clearGoalUnlocked(sessionID: string) {
    const cleared = await this.goalRuntime.clearGoal(sessionID)
    this.clearGoalContinuationTimer(sessionID)
    this.finishGoalOperation(sessionID)
    if (cleared) this.emit("goal.cleared", { sessionID })
    return cleared
  }

		  async startGoalOperation(input: { sessionID: string; objective: string; tokenBudget?: number; signal?: AbortSignal }) {
		    input.signal?.throwIfAborted()
		    return this.withGoalStateLock(input.sessionID, async () => {
		    await this.goalRuntime.clearGoal(input.sessionID)
		    const goal = await this.createGoalUnlocked(input)
		    const operation = this.beginGoalOperation(input.sessionID, goal)
		    this.emit("goal.operation.started", { sessionID: input.sessionID, operation })
		    this.scheduleGoalContinuation(input.sessionID)
		    return goal
		    })
		  }

  async cancelGoalOperation(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await this.pauseGoal(sessionID, signal)
    return this.abortSession(sessionID, signal)
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
    return latestSessionMessages(events).slice(-limit)
  }

  async getUsageStats(signal?: AbortSignal, options: ChipMateUsageStatsOptions = {}): Promise<ChipMateUsageStatsSnapshot> {
    signal?.throwIfAborted()
    await this.ensureUsageBackfilled(signal)
    signal?.throwIfAborted()
    return this.usageLedger.stats(undefined, options)
  }

  async ensureSessionDisplayTitle(sessionID: string, signal?: AbortSignal): Promise<ChipMateSession | undefined> {
    signal?.throwIfAborted()
    const events = await this.readSessionEvents(sessionID)
    const session = latestSessionRecord(events)
    if (!session) return undefined
    if (session.displayTitle?.trim()) return session

    const question = firstSessionUserQuestion(events)
    if (!question) return session

    let displayTitle = fallbackSessionDisplayTitle(question)
    let displayTitleSource: SessionRecord["displayTitleSource"] = "fallback"
    try {
      const settings = this.deps.getSettings()
      if (!settings.provider.apiBaseUrl.trim() || !settings.provider.chatModel.trim()) {
        throw new Error("provider is not configured for session title generation")
      }
      const responseRaw = await this.requestSessionDisplayTitle(settings, question, signal)
      const modelTitle = parseSessionDisplayTitle(responseRaw)
      if (modelTitle) {
        displayTitle = modelTitle
        displayTitleSource = "model"
      } else {
        this.deps.output.appendLine(`[session-title] empty provider title for ${sessionID}; using fallback`)
      }
    } catch (error) {
      this.deps.output.appendLine(`[session-title] fallback for ${sessionID}: ${formatErrorMessage(error)}`)
    }

    const nextSession: SessionRecord = {
      ...session,
      displayTitle,
      displayTitleSource,
      time: {
        ...session.time,
        updated: session.time.updated,
      },
    }
    await this.appendSessionEvent(sessionID, { type: "session", session: nextSession })
    this.emit("session.updated", { info: nextSession })
    return nextSession
  }

  async appendLocalMessages(input: {
    sessionID: string
    messages: LocalHistoryMessageInput[]
    signal?: AbortSignal
  }): Promise<ChipMateMessage[]> {
    input.signal?.throwIfAborted()
    const persisted: ChipMateMessage[] = []
    for (const item of input.messages) {
      input.signal?.throwIfAborted()
      const message = createMessage(input.sessionID, item.role, item.text)
      message.info.providerID = "chipmate-local"
      message.info.mode = item.mode ?? "local"
      message.info.time = { ...message.info.time, completed: Date.now() }
      if (item.error) message.info.error = { message: item.error }
      if (item.parts?.length) message.parts = item.parts
      await this.appendMessage(input.sessionID, message)
      persisted.push(message)
    }
    await this.touchSession(input.sessionID)
    return persisted
  }

  async appendVisualEvidence(input: {
    sessionID: string
    messageID: string
    kind: "drawio" | "mermaid" | "word-render-page"
    dataUri: string
    diagramId?: string
    title?: string
    sourceHash?: string
    artifactPath?: string
    page?: number
    width?: number
    height?: number
  }) {
    const dataUri = sanitizePngDataUri(input.dataUri)
    const byteLength = pngDataUriByteLength(dataUri)
    if (byteLength > MAX_VISUAL_EVIDENCE_HARD_IMAGE_BYTES) {
      throw new Error(`Rendered diagram image is too large for visual context (${byteLength} bytes).`)
    }
    const now = Date.now()
    const visualEvidence: VisualEvidenceRecord = {
      id: `visual-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      createdAt: now,
      kind: input.kind,
      diagramId: optionalVisualField(input.diagramId),
      title: optionalVisualField(input.title),
      sourceHash: optionalVisualField(input.sourceHash),
      artifactPath: optionalVisualField(input.artifactPath),
      page: positiveInteger(input.page),
      mediaType: "image/png",
      width: positiveInteger(input.width),
      height: positiveInteger(input.height),
      byteLength,
      summaryVersion: VISUAL_EVIDENCE_SUMMARY_VERSION,
    }
    await this.writeVisualEvidenceDataUri(input.sessionID, visualEvidence.id, dataUri)
    await this.appendSessionEvent(input.sessionID, { type: "visual_evidence", visualEvidence })
    const sizeNote = byteLength > MAX_VISUAL_EVIDENCE_SOFT_IMAGE_BYTES ? " large=true" : ""
    this.deps.output.appendLine(`[visual-context] stored kind=${visualEvidence.kind} message=${visualEvidence.messageID} bytes=${byteLength}${sizeNote}`)
    return visualEvidence
  }

  async repairMermaidDiagram(input: MermaidRepairInput): Promise<ChipMateMessage> {
    const settings = this.deps.getSettings()
    this.setBusyStatus(input.sessionID, "thinking", "Repairing Mermaid diagram")
    try {
      const sessionEvents = await this.readSessionEvents(input.sessionID)
      const historyMessages = await this.recentChatHistoryMessages(input.sessionID, settings, input.signal, sessionEvents)
      const messages = mermaidRepairMessages({
        historyMessages,
        messageID: input.messageID,
        diagramId: input.diagramId,
        sourceHash: input.sourceHash,
        source: input.source,
        error: input.error,
        language: input.language,
      })
      const raw = await this.requestMermaidRepair(settings, messages, input.signal)
      const repaired = mermaidRepairContentFromResponse(raw)
      const assistantText = mermaidRepairAssistantText(repaired.text)
      const assistant = createMessage(input.sessionID, "assistant", "", "mermaid-repair")
      assistant.info.modelID = settings.provider.chatModel || undefined
      assistant.info.tokens = repaired.usage ?? estimateChatTokenUsage({
        messages,
        outputText: assistantText,
        model: settings.provider.chatModel,
      })
      assistant.info.usageKind = repaired.usage ? "reported" : "estimated"
      replaceAssistantText(assistant, input.sessionID, assistantText)
      assistant.info.time = { ...assistant.info.time, completed: Date.now() }
      await this.appendMessage(input.sessionID, assistant)
      await this.recordAssistantUsage(assistant)
      this.emit("message.updated", { info: assistant.info })
      const textPart = assistant.parts.find((part) => part.type === "text")
      if (textPart) this.emit("message.part.updated", { part: textPart })
      await this.touchSession(input.sessionID)
      this.flushQueuedConversationMemoryRefresh(input.sessionID)
      this.deps.output.appendLine(`[mermaid-repair] appended assistant message=${assistant.info.id} sourceHash=${input.sourceHash || ""}`)
      return assistant
    } finally {
      const status: ChipMateSessionStatus = { type: "idle" }
      this.statuses.set(input.sessionID, status)
      this.emit("session.status", { sessionID: input.sessionID, status })
    }
  }

  async sendMessage(input: {
    sessionID: string
    text: string
    historyText?: string
    messageMode?: string
    evidenceLedger?: EvidenceLedgerEntry[]
    model?: unknown
    agent?: string
    signal?: AbortSignal
  }): Promise<ChipMateMessage> {
    const result = await this.runTurn(input.sessionID, input.text, {
      historyText: input.historyText,
      messageMode: input.messageMode,
      evidenceLedger: input.evidenceLedger,
      signal: input.signal,
    })
    return result.assistant
  }

  async sendMessageAsync(input: {
    sessionID: string
    text: string
    historyText?: string
    messageMode?: string
    evidenceLedger?: EvidenceLedgerEntry[]
    model?: unknown
    agent?: string
    signal?: AbortSignal
  }) {
    const controller = new AbortController()
    this.activeControllers.set(input.sessionID, controller)
    const abort = () => controller.abort()
    input.signal?.addEventListener("abort", abort, { once: true })
    void this.runTurn(input.sessionID, input.text, {
      historyText: input.historyText,
      messageMode: input.messageMode,
      evidenceLedger: input.evidenceLedger,
      signal: controller.signal,
    })
      .catch((error) => {
        if (controller.signal.aborted || input.signal?.aborted) return
        return this.recordSessionError(input.sessionID, error)
      })
	      .finally(() => {
	        input.signal?.removeEventListener("abort", abort)
	        this.activeControllers.delete(input.sessionID)
	        if (!controller.signal.aborted && !input.signal?.aborted) this.scheduleGoalContinuation(input.sessionID)
	      })
	  }

  async abortSession(sessionID: string, _signal?: AbortSignal) {
    const controller = this.activeControllers.get(sessionID)
    controller?.abort()
    this.clearGoalContinuationTimer(sessionID)
    const accountedGoal = await this.withGoalStateLock(sessionID, () => this.goalRuntime.abortTurn(sessionID)).catch(() => undefined)
    if (accountedGoal) {
      const displayGoal = await this.emitGoalUpdated(sessionID, accountedGoal)
      this.finishGoalOperation(sessionID, displayGoal)
    }
    this.resolvePendingToolApprovalsForSession(sessionID, {
      approved: false,
      reason: "request canceled",
    })
    this.cancelPendingClarificationsForSession(sessionID, "request canceled")
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
    return true
  }

  private goalToolHandler() {
    return {
      getGoal: async (sessionID: string) => this.goalRuntime.goalResponse(await this.goalRuntime.getGoal(sessionID)),
		      createGoal: async (sessionID: string, input: { objective: string; tokenBudget?: number }) => {
		        return this.withGoalStateLock(sessionID, async () => {
		        const response = await this.goalRuntime.createGoalFromTool(sessionID, input.objective, input.tokenBudget)
		        if (response.goal) {
		          const displayGoal = await this.emitGoalUpdated(sessionID, response.goal)
	          const operation = this.beginGoalOperation(sessionID, displayGoal)
	          this.emit("goal.operation.started", { sessionID, operation })
		          this.scheduleGoalContinuation(sessionID)
		        }
		        return response
		        })
	      },
	      updateGoal: async (sessionID: string, input: { status: ThreadGoalStatus }) => {
	        return this.withGoalStateLock(sessionID, async () => {
	        const response = await this.goalRuntime.updateGoalFromTool(sessionID, input.status)
	        if (response.goal) {
	          const displayGoal = await this.emitGoalUpdated(sessionID, response.goal)
	          if (isTerminalGoalStatus(response.goal.status)) this.finishGoalOperation(sessionID, displayGoal)
	        }
	        return response
	        })
	      },
    }
  }

  private setBusyStatus(sessionID: string, stage: string, message: string) {
    const status: ChipMateSessionStatus = { type: "busy", stage, message }
    this.statuses.set(sessionID, status)
    this.emit("session.status", { sessionID, status })
  }

  private scheduleGoalContinuation(sessionID: string) {
    this.clearGoalContinuationTimer(sessionID)
    const status = this.statuses.get(sessionID)
    if (this.activeControllers.has(sessionID) || status?.type === "busy" || status?.type === "retry") return
    const timer = setTimeout(() => {
      this.goalContinuationTimers.delete(sessionID)
      void this.runGoalContinuation(sessionID)
    }, 120)
    this.goalContinuationTimers.set(sessionID, timer)
  }

  private clearGoalContinuationTimer(sessionID: string) {
    const timer = this.goalContinuationTimers.get(sessionID)
    if (timer) clearTimeout(timer)
    this.goalContinuationTimers.delete(sessionID)
  }

  private async withGoalStateLock<T>(sessionID: string, run: () => Promise<T> | T): Promise<T> {
    const previous = this.goalStateLocks.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => undefined).then(() => next)
    this.goalStateLocks.set(sessionID, current)
    await previous.catch(() => undefined)
    try {
      return await run()
    } finally {
      release()
      if (this.goalStateLocks.get(sessionID) === current) this.goalStateLocks.delete(sessionID)
    }
  }

  private async runGoalContinuation(sessionID: string) {
    let controller: AbortController | undefined
    let goal: ThreadGoal | undefined
    const shouldRun = await this.withGoalStateLock(sessionID, async () => {
      if (this.activeControllers.has(sessionID)) return false
      goal = await this.goalRuntime.getGoal(sessionID)
      if (!goal || goal.status !== "active") {
        if (goal && isTerminalGoalStatus(goal.status)) this.finishGoalOperation(sessionID, await this.goalRuntime.goalForDisplay(goal))
        return false
      }
      controller = new AbortController()
      this.activeControllers.set(sessionID, controller)
      const operation = this.beginGoalOperation(sessionID, await this.goalRuntime.goalForDisplay(goal))
      this.emit("goal.operation.started", { sessionID, operation })
      return true
    })
    if (!shouldRun || !controller || !goal) {
      return
    }
    try {
      await this.runTurn(sessionID, goal.objective, {
        signal: controller.signal,
        skipUserMessage: true,
        goalContinuation: true,
        messageMode: "goal-continuation",
        internalGoalPrompt: await this.goalRuntime.continuationPrompt(goal),
      })
    } catch (error) {
      if (!controller.signal.aborted) await this.recordSessionError(sessionID, error)
    } finally {
      this.activeControllers.delete(sessionID)
      if (controller.signal.aborted) return
      const latest = await this.goalRuntime.getGoal(sessionID)
      if (latest?.status === "active") this.scheduleGoalContinuation(sessionID)
      else this.finishGoalOperation(sessionID, latest ? await this.goalRuntime.goalForDisplay(latest) : undefined)
    }
  }

	  private beginGoalOperation(sessionID: string, goal: ThreadGoal) {
	    const now = Date.now()
	    const existing = this.goalOperations.get(sessionID)
	    const operation: ThreadGoalOperation = {
	      sessionID,
	      active: true,
	      startedAt: existing?.startedAt ?? now,
	      updatedAt: now,
	      turnCount: existing?.turnCount ?? 0,
	      currentTurnID: existing?.currentTurnID,
	      status: goal.status,
	      objective: goal.objective,
    }
    this.goalOperations.set(sessionID, operation)
    return operation
  }

	  private updateGoalOperationTurn(sessionID: string, goal: ThreadGoal | undefined, turnID: string) {
	    if (!goal) return
	    const now = Date.now()
	    const existing = this.goalOperations.get(sessionID)
	    const operation: ThreadGoalOperation = {
	      sessionID,
	      active: true,
	      startedAt: existing?.startedAt ?? now,
	      updatedAt: now,
	      turnCount: (existing?.turnCount ?? 0) + 1,
	      currentTurnID: turnID,
	      status: goal.status,
	      objective: goal.objective,
	    }
	    this.goalOperations.set(sessionID, operation)
	    this.emit("goal.operation.started", { sessionID, operation })
	  }

  private finishGoalOperation(sessionID: string, goal?: ThreadGoal) {
    const existing = this.goalOperations.get(sessionID)
    if (!existing) return
    const operation: ThreadGoalOperation = {
      ...existing,
      active: false,
      updatedAt: Date.now(),
      currentTurnID: undefined,
      status: goal?.status ?? existing.status,
      objective: goal?.objective ?? existing.objective,
    }
    this.goalOperations.set(sessionID, operation)
    this.emit("goal.operation.finished", { sessionID, operation })
  }

  private async emitGoalUpdated(sessionID: string, goal: ThreadGoal) {
    const displayGoal = await this.goalRuntime.goalForDisplay(goal)
    this.emit("goal.updated", { sessionID, goal: displayGoal })
    if (isTerminalGoalStatus(displayGoal.status)) this.finishGoalOperation(sessionID, displayGoal)
    return displayGoal
  }

  async deleteSession(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = (await this.readSessionEvents(sessionID))
      .find((event): event is Extract<SessionEvent, { type: "session" }> => event.type === "session")
      ?.session
    const controller = this.activeControllers.get(sessionID)
    controller?.abort()
    this.activeControllers.delete(sessionID)
    this.clearGoalContinuationTimer(sessionID)
    this.goalOperations.delete(sessionID)
    await this.goalRuntime.clearGoal(sessionID).catch(() => false)
    this.statuses.delete(sessionID)
    this.resolvePendingToolApprovalsForSession(sessionID, {
      approved: false,
      reason: "session deleted",
    })
    this.cancelPendingClarificationsForSession(sessionID, "session deleted")
    await vscode.workspace.fs.delete(await this.sessionUri(sessionID), { useTrash: false })
    try {
      await vscode.workspace.fs.delete(await this.visualEvidenceDir(sessionID), { recursive: true, useTrash: false })
    } catch {
      // Visual evidence is best-effort cleanup; session deletion already succeeded.
    }
    this.emit("session.deleted", { info: session ?? { id: sessionID } })
    return true
  }

  resolveToolApproval(requestID: string, approved: boolean) {
    const pending = this.pendingToolApprovals.get(requestID)
    if (!pending) return false
    this.pendingToolApprovals.delete(requestID)
    pending.resolve({
      approved,
      reason: approved ? "approved in QA chat" : "denied in QA chat",
    })
    return true
  }

  resolveClarification(requestID: string, answers: ClarificationAnswer[]) {
    const pending = this.pendingClarifications.get(requestID)
    if (!pending) return false
    this.pendingClarifications.delete(requestID)
    pending.resolve(sanitizeClarificationAnswers(answers))
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

  private async requestTerminalCommandPlan(settings: RemoteSettings, messages: ChatMessage[], signal?: AbortSignal) {
    const maxTokens = Math.max(256, Number.isFinite(settings.provider.maxTokens) ? Math.floor(settings.provider.maxTokens) : 4096)
    const body = {
      model: settings.provider.chatModel,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
    }
    const promptBytes = textByteLength(JSON.stringify(messages))
    this.deps.output.appendLine(`[terminal-planner] request model=${settings.provider.chatModel || "default"} messages=${messages.length} promptBytes=${promptBytes} maxTokens=${maxTokens}`)
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal,
      body: JSON.stringify(body),
    })
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(`Terminal command planning failed: ${response.status} ${response.statusText || "HTTP error"}${text ? `: ${text}` : ""}`)
    }
    this.deps.output.appendLine(`[terminal-planner] response rawBytes=${textByteLength(text)}`)
    return text
  }

  private async requestTerminalCommandResultSummary(settings: RemoteSettings, messages: ChatMessage[], signal?: AbortSignal) {
    const maxTokens = Math.max(256, Number.isFinite(settings.provider.maxTokens) ? Math.floor(settings.provider.maxTokens) : 2048)
    const body = {
      model: settings.provider.chatModel,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
    }
    const promptBytes = textByteLength(JSON.stringify(messages))
    this.deps.output.appendLine(`[terminal-summary] request model=${settings.provider.chatModel || "default"} messages=${messages.length} promptBytes=${promptBytes} maxTokens=${maxTokens}`)
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal,
      body: JSON.stringify(body),
    })
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(`Terminal command result summary failed: ${response.status} ${response.statusText || "HTTP error"}${text ? `: ${text}` : ""}`)
    }
    this.deps.output.appendLine(`[terminal-summary] response rawBytes=${textByteLength(text)}`)
    return text
  }

  private async requestConversationMemorySummary(settings: RemoteSettings, messages: ChatMessage[], signal?: AbortSignal) {
    const configuredMaxTokens = Number.isFinite(settings.provider.maxTokens) ? Math.floor(settings.provider.maxTokens) : 2048
    const maxTokens = Math.max(512, Math.min(4096, configuredMaxTokens))
    const body = {
      model: settings.provider.chatModel,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
    }
    const promptBytes = textByteLength(JSON.stringify(messages))
    this.deps.output.appendLine(`[chat-memory] summarizing request model=${settings.provider.chatModel || "default"} messages=${messages.length} promptBytes=${promptBytes} maxTokens=${maxTokens}`)
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal,
      body: JSON.stringify(body),
    })
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(`Conversation memory summary failed: ${response.status} ${response.statusText || "HTTP error"}${text ? `: ${text}` : ""}`)
    }
    this.deps.output.appendLine(`[chat-memory] response rawBytes=${textByteLength(text)}`)
    return text
  }

  private async requestMermaidRepair(settings: RemoteSettings, messages: ChatMessage[], signal?: AbortSignal) {
    const configuredMaxTokens = Number.isFinite(settings.provider.maxTokens) ? Math.floor(settings.provider.maxTokens) : MAX_MERMAID_REPAIR_TOKENS
    const maxTokens = Math.max(512, Math.min(MAX_MERMAID_REPAIR_TOKENS, configuredMaxTokens))
    const body = {
      model: settings.provider.chatModel,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
    }
    const promptBytes = textByteLength(JSON.stringify(messages))
    this.deps.output.appendLine(`[mermaid-repair] request model=${settings.provider.chatModel || "default"} messages=${messages.length} promptBytes=${promptBytes} maxTokens=${maxTokens} tools=disabled`)
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal,
      body: JSON.stringify(body),
    })
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(`Mermaid repair failed: ${response.status} ${response.statusText || "HTTP error"}${text ? `: ${text}` : ""}`)
    }
    this.deps.output.appendLine(`[mermaid-repair] response rawBytes=${textByteLength(text)}`)
    return text
  }

  private async requestSessionDisplayTitle(settings: RemoteSettings, question: string, signal?: AbortSignal) {
    const body = {
      model: settings.provider.chatModel,
      messages: sessionDisplayTitleMessages(question),
      stream: false,
      max_tokens: 48,
      temperature: 0,
    }
    const promptBytes = textByteLength(JSON.stringify(body.messages))
    this.deps.output.appendLine(`[session-title] request model=${settings.provider.chatModel || "default"} promptBytes=${promptBytes}`)
    const response = await fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal,
      body: JSON.stringify(body),
    })
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(`Session title generation failed: ${response.status} ${response.statusText || "HTTP error"}${text ? `: ${text}` : ""}`)
    }
    this.deps.output.appendLine(`[session-title] response rawBytes=${textByteLength(text)}`)
    return text
  }

  private async runTurn(sessionID: string, userText: string, options: {
    historyText?: string
    messageMode?: string
    evidenceLedger?: EvidenceLedgerEntry[]
    internalGoalPrompt?: string
    goalContinuation?: boolean
    skipUserMessage?: boolean
    signal?: AbortSignal
  } = {}) {
    const signal = options.signal
    const settings = this.deps.getSettings()
    this.setBusyStatus(sessionID, "preparing", "Preparing conversation history")
    const sessionEvents = await this.readSessionEvents(sessionID)
    const historyMessages = await this.recentChatHistoryMessages(sessionID, settings, signal, sessionEvents)
    const visualInputs = await this.previousAssistantVisualInputs(sessionID, sessionEvents)
    const userHistoryText = userHistoryTextForTurn(userText, options.historyText, options.messageMode)
    let userMessage: ChipMateMessage | undefined
    if (!options.skipUserMessage) {
      userMessage = createMessage(sessionID, "user", userHistoryText, options.messageMode)
      await this.appendMessage(sessionID, userMessage)
      await this.appendEvidenceLedger(sessionID, userMessage.info.id, options.evidenceLedger)
      this.setBusyStatus(sessionID, "sending", "Sending user message")
      this.emit("message.updated", { info: userMessage.info })
      this.emit("message.part.updated", {
        part: {
          id: `${userMessage.info.id}-text`,
          sessionID,
          messageID: userMessage.info.id,
          type: "text",
          text: userHistoryText,
        },
      })
    } else {
      this.setBusyStatus(sessionID, "sending", "Continuing active goal")
    }

    const enabledSkillMetadata = await this.deps.skills.enabledSkills()
    const activeSkillSelections = selectActiveSkills(userText, enabledSkillMetadata)
    const loadedSkills = (await Promise.all(activeSkillSelections.map(({ skill, invocationMode }) => this.deps.skills.loadSkill(skill.id, invocationMode))))
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
    if (loadedSkills.length > 0) {
      this.deps.output.appendLine(`[skills] active session=${sessionID} skills=${loadedSkills.map((skill) => `${skill.name}:${skill.invocationMode ?? "implicit"}`).join(",")}`)
    }
    const activeSkills = activeSkillPolicies(loadedSkills)
    const exposedTools = settings.tools.enabled ? this.deps.tools.toolDefinitions() : []
    const exposedToolNames = toolDefinitionNames(exposedTools)
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt(
          settings,
          skillSystemCatalog(enabledSkillMetadata, settings.skills.maxCatalogBytes),
          renderSkillsForPrompt(loadedSkills, { toolsEnabled: settings.tools.enabled, exposedToolNames: [...exposedToolNames] }),
        ),
      },
      ...historyMessages,
      { role: "user", content: options.internalGoalPrompt ?? userContentForRequest(userText, visualInputs) },
    ]
    if (visualInputs.length > 0) {
      this.deps.output.appendLine(`[visual-context] attached previous-turn images=${visualInputs.length}`)
    }

    let assistant = createMessage(sessionID, "assistant", "", options.messageMode)
    const startingGoal = await this.goalRuntime.startTurn(sessionID, assistant.info.id)
    if (startingGoal) this.updateGoalOperationTurn(sessionID, startingGoal, assistant.info.id)
    let assistantText = ""
    let toolCalls: ChatToolCall[] = []
    const maxAgentSteps = maxAgentStepsForSettings(settings)
    let stepCount = 0
    let totalToolCallCount = 0
    let reachedToolLoopLimit = false
    const diagramWorkflow = {
      validateCompleted: false,
      renderCompleted: false,
      diagramPartInserted: false,
    }
    const wordVisualQa: WordVisualQaState = {
      pendingBatches: [],
      renderRoundCount: 0,
      qaBatchCount: 0,
      imageInputRejected: false,
    }
    const deliveryDiscipline = createDeliveryDisciplineState(userText, activeSkills)

    const enqueueWordVisualQaPrompt = () => {
      const wordQaPrompt = consumeWordVisualQaSteering(wordVisualQa)
      if (!wordQaPrompt) return false
      messages.push({
        role: "user",
        content: userContentForRequest(wordQaPrompt.text, wordQaPrompt.images),
      })
      this.deps.output.appendLine(`[word-visual-qa] steering batch=${wordVisualQa.qaBatchCount} renderRound=${wordQaPrompt.renderRound}/${MAX_WORD_VISUAL_QA_REPAIR_ROUNDS} artifact=${wordQaPrompt.artifactCount} pages=${wordQaPrompt.pages.join(",") || "none"} images=${wordQaPrompt.images.length} imageMode=${wordVisualQa.imageInputRejected ? "text-only" : "image-or-text"}`)
      return true
    }

    const enqueueEvidenceConvergencePrompt = () => {
      if (!shouldInsertEvidenceConvergenceCheckpoint(deliveryDiscipline, stepCount, maxAgentSteps)) return false
      deliveryDiscipline.convergencePromptInserted = true
      messages.push({
        role: "user",
        content: evidenceConvergenceCheckpointPrompt({
          state: deliveryDiscipline,
          stepCount,
          maxAgentSteps,
          totalToolCallCount,
        }),
      })
      this.deps.output.appendLine(`[tool-loop] evidence convergence checkpoint inserted step=${stepCount}/${maxAgentSteps} totalToolCalls=${totalToolCallCount} expected=${deliveryDiscipline.expectations.map((item) => item.kind).join(",") || "none"} pendingActions=${pendingDeliveryNextActions(deliveryDiscipline).length}`)
      return true
    }

    const enqueueMissingDeliverablePrompt = () => {
      if (!shouldInsertMissingDeliverablePrompt(deliveryDiscipline)) return false
      deliveryDiscipline.missingDeliverablePromptInserted = true
      messages.push({
        role: "user",
        content: missingDeliverableSteeringPrompt(deliveryDiscipline),
      })
      this.deps.output.appendLine(`[tool-loop] missing deliverable steering inserted expected=${missingDeliveryExpectations(deliveryDiscipline).map((item) => item.kind).join(",")}`)
      return true
    }

    const enqueueProducerFailureRepairPrompt = () => {
      if (!shouldInsertProducerFailureRepairPrompt(deliveryDiscipline)) return false
      deliveryDiscipline.producerFailureRepairPromptInserted = true
      messages.push({
        role: "user",
        content: producerFailureRepairPrompt(deliveryDiscipline),
      })
      const lastFailure = deliveryDiscipline.producerFailures.at(-1)
      const missing = missingDeliveryExpectations(deliveryDiscipline).map((item) => item.kind).join(",") || "none"
      const repeated = Boolean(lastFailure?.specShapeHash && deliveryDiscipline.producerFailures.slice(0, -1).some((item) => item.tool === lastFailure.tool && item.specShapeHash === lastFailure.specShapeHash))
      this.deps.output.appendLine(`[tool-loop] producer failure repair checkpoint inserted tools=${deliveryDiscipline.producerFailures.slice(-3).map((item) => item.tool).join(",")} failureCount=${deliveryDiscipline.producerFailures.length} lastErrorCode=${lastFailure?.errorCode || "none"} missing=${missing} specShapeHash=${lastFailure?.specShapeHash || "none"} repeatedInvalidSpec=${repeated} documentSkillActive=${activeSkills.some((skill) => skill.name === "documents" || skill.name === "chip-design-doc")}`)
      return true
    }

    const enqueueWordRenderCheckpoint = () => {
      if (!settings.tools.enabled || !exposedToolNames.has("render_word_document")) return false
      if (!shouldInsertWordRenderCheckpoint(deliveryDiscipline)) return false
      deliveryDiscipline.wordRenderCheckpointInserted = true
      messages.push({
        role: "user",
        content: wordRenderCheckpointPrompt(deliveryDiscipline),
      })
      this.deps.output.appendLine(`[tool-loop] word-render checkpoint inserted generated=${latestGeneratedDocxPath(deliveryDiscipline) || "none"} renderAttempted=${deliveryDiscipline.completedTools.includes("render_word_document")} documentSkillActive=${activeSkills.some((skill) => skill.name === "documents" || skill.name === "chip-design-doc")}`)
      return true
    }

    const executeToolCallsForStep = async (calls: ChatToolCall[]) => {
      totalToolCallCount += calls.length
      const parsedCalls = calls.map((call) => ({
        call,
        parsedArgs: parseToolArguments(call.function.arguments, call[TOOL_ARGUMENT_STATE]),
      }))
      messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: parsedCalls.map(({ call, parsedArgs }) => toolCallForProviderHistory(call, parsedArgs)),
      })
      for (const { call, parsedArgs } of parsedCalls) {
        if (!parsedArgs.ok || call.function.name === "create_word_document") {
          this.deps.output.appendLine(toolArgumentDiagnosticLogLine(call.function.name, call.function.arguments, call[TOOL_ARGUMENT_STATE], parsedArgs))
          if (!parsedArgs.ok) {
            this.deps.output.appendLine(`[tool-args] ${call.function.name} toolArgumentsSanitized=true errorCode=${parsedArgs.errorCode}`)
          }
        }
        const args = parsedArgs.ok ? parsedArgs.args : {}
        const isExposedTool = exposedToolNames.has(call.function.name)
        assistant = this.emitToolActivityPart({
          assistant,
          sessionID,
          call,
          status: "running",
        })
        assistant = this.emitRunProgressPart({
          assistant,
          sessionID,
          toolCallID: call.id,
          event: {
            id: "tool-execution",
            phase: "tool-execution",
            title: runProgressToolTitle(call.function.name),
            detail: "开始执行工具",
            status: "running",
            tool: call.function.name,
          },
        })
        const toolResult = !parsedArgs.ok
          ? failedToolArgumentParsing(call.function.name, parsedArgs, call.function.arguments, call[TOOL_ARGUMENT_STATE])
          : isExposedTool
          ? await this.executeToolCall({
              sessionID,
              mode: settings.permissions.mode,
              name: call.function.name,
              arguments: args,
              activeSkills,
              signal,
              goals: this.goalToolHandler(),
              progress: (event) => {
                assistant = this.emitRunProgressPart({
                  assistant,
                  sessionID,
                  toolCallID: call.id,
                  event: {
                    ...event,
                    tool: event.tool || call.function.name,
                  },
                })
              },
              approve: this.toolApprovalHandler({
                sessionID,
                assistant,
                call,
                args,
                signal,
              }),
            })
          : blockedUnexposedTool(call.function.name)
        if (!isExposedTool) {
          this.deps.output.appendLine(`[tool] blocked unexposed tool_call name=${call.function.name}`)
        }
        const status = toolStatusFromResult(toolResult)
        assistant = this.emitRunProgressPart({
          assistant,
          sessionID,
          toolCallID: call.id,
          event: {
            id: "tool-execution",
            phase: "tool-execution",
            title: runProgressToolTitle(call.function.name),
            detail: runProgressToolResultDetail(toolResult, status),
            status: runProgressStatusFromToolStatus(status),
            tool: call.function.name,
          },
        })
        this.deps.output.appendLine(toolResultLogLine(call.function.name, toolResult, status))
        recordDeliveryToolResult(deliveryDiscipline, call.function.name, args, toolResult, this.deps.output)
        if (call.function.name !== "update_goal") {
          const accountedGoal = await this.goalRuntime.accountProgress(sessionID)
          if (accountedGoal) await this.emitGoalUpdated(sessionID, accountedGoal)
        }
        if (call.function.name === "chipmate_validate_diagram_ir" && status === "completed" && toolResult.approved) {
          diagramWorkflow.validateCompleted = true
        }
        if (call.function.name === "chipmate_create_drawio_diagram" && status === "completed" && toolResult.approved) {
          diagramWorkflow.renderCompleted = true
        }
        const executionSummary = toolExecutionSummaryFromCall({
          tool: call.function.name,
          args,
          result: toolResult,
          messageID: assistant.info.id,
          toolCallID: call.id,
        })
        let part: ChipMatePart = {
          id: call.id,
          sessionID,
          messageID: assistant.info.id,
          type: "tool",
          tool: call.function.name,
          state: {
            status,
            input: args,
            output: toolResult.output,
            error: toolResult.error,
            metadata: {
              risk: toolResult.risk,
              title: toolResult.title,
              executionSummary,
            },
          },
        }
        assistant.parts = upsertPart(assistant.parts, part)
        this.emit("message.part.updated", { part })
        const clarificationRequest = clarificationRequestFromToolResult(toolResult)
        if (clarificationRequest && status === "user-input-required" && toolResult.approved) {
          const clarificationPart = clarificationPartFromRequest({
            sessionID,
            messageID: assistant.info.id,
            toolCallID: call.id,
            request: clarificationRequest,
            status: "pending",
          })
          assistant.parts = upsertPart(assistant.parts, clarificationPart)
          this.emit("message.part.updated", { part: clarificationPart })
          await this.appendMessage(sessionID, assistant)
          this.setBusyStatus(sessionID, "thinking", "Waiting for user clarification")
          try {
            const answers = await this.waitForClarification({
              requestID: clarificationRequest.clarificationId,
              sessionID,
              messageID: assistant.info.id,
              toolCallID: call.id,
              signal,
            })
            const answerOutput = clarificationAnswerToolOutput(clarificationRequest, answers)
            const answeredPart = {
              ...clarificationPart,
              status: "answered",
              answers,
            }
            assistant.parts = upsertPart(assistant.parts, answeredPart)
            this.emit("message.part.updated", { part: answeredPart })
            const answeredResult: ToolRuntimeResult = {
              title: toolResult.title,
              output: answerOutput,
              approved: true,
              status: "completed",
              risk: toolResult.risk,
            }
            const answeredSummary = toolExecutionSummaryFromCall({
              tool: call.function.name,
              args,
              result: answeredResult,
              messageID: assistant.info.id,
              toolCallID: call.id,
            })
            const priorToolState = recordValue((part as { state?: unknown }).state)
            part = {
              ...part,
              state: {
                ...priorToolState,
                status: "completed",
                output: answerOutput,
                error: undefined,
                metadata: {
                  ...(recordValue(priorToolState.metadata)),
                  executionSummary: answeredSummary,
                },
              },
            }
            assistant.parts = upsertPart(assistant.parts, part)
            this.emit("message.part.updated", { part })
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: answerOutput,
            })
          } catch (error) {
            const cancelledPart = {
              ...clarificationPart,
              status: "cancelled",
            }
            assistant.parts = upsertPart(assistant.parts, cancelledPart)
            this.emit("message.part.updated", { part: cancelledPart })
            await this.appendMessage(sessionID, assistant).catch(() => undefined)
            throw error
          }
          continue
        }
        const diagramExtraction = diagramPartsFromDrawioToolResult({
          sessionID,
          messageID: assistant.info.id,
          toolCallID: call.id,
          result: toolResult,
        })
        if (diagramExtraction.parts.length > 0) {
          diagramWorkflow.diagramPartInserted = true
        }
	        logDrawioDiagramExtraction(this.deps.output, call.function.name, toolResult, diagramExtraction)
	        for (const diagramPart of diagramExtraction.parts) {
	          assistant.parts = upsertPart(assistant.parts, diagramPart)
	          this.emit("message.part.updated", { part: diagramPart })
	        }
	        const mermaidExtraction = diagramPartsFromMermaidToolResult({
	          sessionID,
	          messageID: assistant.info.id,
	          toolCallID: call.id,
	          result: toolResult,
	        })
	        logMermaidDiagramExtraction(this.deps.output, call.function.name, toolResult, mermaidExtraction)
	        for (const diagramPart of mermaidExtraction.parts) {
	          assistant.parts = upsertPart(assistant.parts, diagramPart)
	          this.emit("message.part.updated", { part: diagramPart })
	        }
        const generatedDocumentExtraction = generatedDocumentPartsFromToolResult({
          sessionID,
          messageID: assistant.info.id,
          toolCallID: call.id,
          tool: call.function.name,
          result: toolResult,
        })
        logGeneratedDocumentExtraction(this.deps.output, call.function.name, toolResult, generatedDocumentExtraction)
        for (const generatedDocumentPart of generatedDocumentExtraction.parts) {
          assistant.parts = upsertPart(assistant.parts, generatedDocumentPart)
          this.emit("message.part.updated", { part: generatedDocumentPart })
        }
	        const wordRenderExtraction = wordRenderPartsFromToolResult({
          sessionID,
          messageID: assistant.info.id,
          toolCallID: call.id,
          result: toolResult,
        })
        logWordRenderExtraction(this.deps.output, call.function.name, toolResult, wordRenderExtraction)
        for (const wordRenderPart of wordRenderExtraction.parts) {
          assistant.parts = upsertPart(assistant.parts, wordRenderPart)
          this.emit("message.part.updated", { part: wordRenderPart })
          if (wordVisualQa.renderRoundCount >= MAX_WORD_VISUAL_QA_REPAIR_ROUNDS) {
            this.deps.output.appendLine(`[word-visual-qa] skipped render artifact because repair round limit was reached: ${wordVisualQa.renderRoundCount}/${MAX_WORD_VISUAL_QA_REPAIR_ROUNDS}`)
            continue
          }
          if (wordVisualQa.pendingBatches.length > 0) {
            this.deps.output.appendLine(`[word-visual-qa] discarded ${wordVisualQa.pendingBatches.length} stale batch(es) after a new render artifact`)
            wordVisualQa.pendingBatches.splice(0)
          }
          wordVisualQa.renderRoundCount += 1
          const visualBatches = await this.wordRenderVisualBatchesFromPart({
            sessionID,
            messageID: assistant.info.id,
            part: wordRenderPart,
            disabled: wordVisualQa.imageInputRejected,
          })
          wordVisualQa.pendingBatches.push(...visualBatches.batches)
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResult.output,
        })
      }
    }

    const flushGoalSteering = () => {
      for (const prompt of this.goalRuntime.consumePendingSteering(sessionID)) {
        messages.push({ role: "user", content: prompt })
      }
    }

    try {
      for (let step = 0; step < maxAgentSteps; step += 1) {
        signal?.throwIfAborted()
        flushGoalSteering()
        stepCount = step + 1
        this.setBusyStatus(sessionID, "thinking", stepCount === 1 ? "Waiting for model response" : `Continuing tool step ${stepCount}`)
        const result = await this.streamChatCompletion({
          messages,
          sessionID,
          assistant,
          exposedTools,
          allowTools: true,
          signal,
        })
        if (result.visualInputRejected) wordVisualQa.imageInputRejected = true
        assistant = result.assistant
        assistantText = result.text
        toolCalls = result.toolCalls
        this.deps.output.appendLine(`[tool-loop] step=${stepCount}/${maxAgentSteps} toolCalls=${toolCalls.length} totalToolCalls=${totalToolCallCount + toolCalls.length}`)
        if (toolCalls.length === 0) {
          if (settings.tools.enabled && wordVisualQa.pendingBatches.length > 0) {
            if (assistantText) messages.push({ role: "assistant", content: assistantText })
            assistantText = ""
            if (enqueueWordVisualQaPrompt()) continue
          }
          if (settings.tools.enabled && shouldInsertMissingDeliverablePrompt(deliveryDiscipline)) {
            if (assistantText) {
              messages.push({ role: "assistant", content: assistantText })
              replaceAssistantText(assistant, sessionID, "")
              this.emitAssistantTextPart(sessionID, assistant, "")
            }
            assistantText = ""
            enqueueMissingDeliverablePrompt()
            continue
          }
          if (settings.tools.enabled && shouldInsertWordRenderCheckpoint(deliveryDiscipline) && exposedToolNames.has("render_word_document")) {
            if (assistantText) {
              messages.push({ role: "assistant", content: assistantText })
              replaceAssistantText(assistant, sessionID, "")
              this.emitAssistantTextPart(sessionID, assistant, "")
            }
            assistantText = ""
            enqueueWordRenderCheckpoint()
            continue
          }
          break
        }
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
        await executeToolCallsForStep(toolCalls)
        const queuedWordQa = enqueueWordVisualQaPrompt()
        const queuedProducerRepair = !queuedWordQa && enqueueProducerFailureRepairPrompt()
        const queuedWordRender = !queuedWordQa && !queuedProducerRepair && enqueueWordRenderCheckpoint()
        flushGoalSteering()
        if (!queuedWordQa && !queuedProducerRepair && !queuedWordRender) enqueueEvidenceConvergencePrompt()
        if (step === maxAgentSteps - 1) reachedToolLoopLimit = true
      }
      if (reachedToolLoopLimit && toolCalls.length > 0 && settings.tools.enabled) {
        assistantText = await this.finalizeToolLoopLimit({
          messages,
          sessionID,
          assistant,
          maxAgentSteps,
          stepCount,
          totalToolCallCount,
          deliveryDiscipline,
          signal,
        })
      } else if (exposedToolNames.has("chipmate_create_drawio_diagram") && shouldRepairDrawioWorkflow(diagramWorkflow, settings)) {
        this.deps.output.appendLine(`[drawio-workflow] repair start validateCompleted=${diagramWorkflow.validateCompleted} renderCompleted=${diagramWorkflow.renderCompleted} diagramPartInserted=${diagramWorkflow.diagramPartInserted}`)
        messages.push({ role: "user", content: drawioWorkflowRepairPrompt() })
        const repairResult = await this.streamChatCompletion({
          messages,
          sessionID,
          assistant,
          exposedTools,
          allowTools: true,
          signal,
        })
        assistant = repairResult.assistant
        assistantText = repairResult.text
        toolCalls = repairResult.toolCalls
        this.deps.output.appendLine(`[drawio-workflow] repair response toolCalls=${toolCalls.length} textBytes=${textByteLength(assistantText)}`)
        if (toolCalls.length > 0 && settings.tools.enabled) {
          await executeToolCallsForStep(toolCalls)
          const finalResult = await this.streamChatCompletion({
            messages,
            sessionID,
            assistant,
            exposedTools: [],
            allowTools: false,
            signal,
          })
          assistant = finalResult.assistant
          assistantText = finalResult.text
          this.deps.output.appendLine(`[drawio-workflow] repair final textBytes=${textByteLength(assistantText)} toolCalls=${finalResult.toolCalls.length}`)
        }
      }
      const enforcedMissingDeliverableText = missingDeliverableFinalAnswerText(deliveryDiscipline, assistantText)
      if (enforcedMissingDeliverableText) {
        assistantText = replaceAssistantText(assistant, sessionID, enforcedMissingDeliverableText)
        this.emitAssistantTextPart(sessionID, assistant, assistantText)
        this.deps.output.appendLine(`[tool-loop] enforced missing deliverable final answer expected=${missingDeliveryExpectations(deliveryDiscipline).map((item) => item.kind).join(",")}`)
      }
      const generatedDocumentLocation = generatedDocumentFinalLocationText(deliveryDiscipline, assistantText)
      if (generatedDocumentLocation) {
        assistantText = appendAssistantText(assistant, sessionID, `${assistantText.trim() ? "\n\n" : ""}${generatedDocumentLocation}`)
        this.emitAssistantTextPart(sessionID, assistant, assistantText)
        this.deps.output.appendLine(`[tool-loop] enforced generated document location path=${latestGeneratedDocxPath(deliveryDiscipline) || "none"}`)
      }
      const wordRenderDisclosure = wordRenderQaFinalDisclosureText(deliveryDiscipline, assistantText)
      if (wordRenderDisclosure) {
        assistantText = appendAssistantText(assistant, sessionID, `${assistantText.trim() ? "\n\n" : ""}${wordRenderDisclosure}`)
        this.emitAssistantTextPart(sessionID, assistant, assistantText)
        this.deps.output.appendLine(`[tool-loop] enforced word render QA disclosure generated=${latestGeneratedDocxPath(deliveryDiscipline) || "none"}`)
      }
    } catch (error) {
      if (!signal?.aborted) {
        const goal = await this.goalRuntime.stopTurnWithError(sessionID, goalStatusForTurnError(error)).catch(() => undefined)
        if (goal) await this.emitGoalUpdated(sessionID, goal)
        await this.persistPartialAssistant(sessionID, assistant)
      }
      throw error
    }

    assistant.info.time = { ...assistant.info.time, completed: Date.now() }
    await this.appendMessage(sessionID, assistant)
    await this.recordAssistantUsage(assistant)
    await this.goalRuntime.stopTurn(sessionID)
    this.statuses.set(sessionID, { type: "idle" })
    this.emit("message.updated", { info: assistant.info })
    this.emit("session.status", { sessionID, status: { type: "idle" } })
    await this.touchSession(sessionID)
    this.flushQueuedConversationMemoryRefresh(sessionID)
    this.scheduleGoalContinuation(sessionID)
    return { user: userMessage, assistant }
  }

  private async finalizeToolLoopLimit(input: {
    messages: ChatMessage[]
    sessionID: string
    assistant: ChipMateMessage
    maxAgentSteps: number
    stepCount: number
    totalToolCallCount: number
    deliveryDiscipline: DeliveryDisciplineState
    signal?: AbortSignal
  }) {
    const finalizationPrompt = toolLoopLimitFinalizationPrompt(input.maxAgentSteps, input.totalToolCallCount, input.deliveryDiscipline)
    input.messages.push({ role: "user", content: finalizationPrompt })
    const promptBytes = textByteLength(JSON.stringify(input.messages))
    this.deps.output.appendLine(`[tool-loop] limit reached steps=${input.stepCount}/${input.maxAgentSteps} totalToolCalls=${input.totalToolCallCount} finalizationPromptBytes=${promptBytes}`)
    try {
      const result = await this.streamChatCompletion({
        messages: input.messages,
        sessionID: input.sessionID,
        assistant: input.assistant,
        exposedTools: [],
        allowTools: false,
        signal: input.signal,
      })
      if (result.toolCalls.length > 0 || !result.text.trim()) {
        const reason = result.toolCalls.length > 0 ? `finalization returned ${result.toolCalls.length} tool_call(s)` : "finalization returned empty text"
        const fallback = toolLoopLimitFallbackMessage(input.maxAgentSteps, input.totalToolCallCount, reason)
        this.deps.output.appendLine(`[tool-loop] finalization fallback: ${reason}`)
        const text = replaceAssistantText(input.assistant, input.sessionID, fallback)
        this.emitAssistantTextPart(input.sessionID, input.assistant, text)
        return text
      }
      this.deps.output.appendLine(`[tool-loop] finalization success textBytes=${textByteLength(result.text)} toolCalls=0`)
      return result.text
    } catch (error) {
      if (input.signal?.aborted) throw error
      const reason = formatErrorMessage(error)
      const fallback = toolLoopLimitFallbackMessage(input.maxAgentSteps, input.totalToolCallCount, `finalization failed: ${reason}`)
      this.deps.output.appendLine(`[tool-loop] finalization failed: ${reason}`)
      const text = replaceAssistantText(input.assistant, input.sessionID, fallback)
      this.emitAssistantTextPart(input.sessionID, input.assistant, text)
      return text
    }
  }

  private emitAssistantTextPart(sessionID: string, assistant: ChipMateMessage, text: string) {
    this.emit("message.part.updated", {
      part: {
        id: `${assistant.info.id}-text`,
        sessionID,
        messageID: assistant.info.id,
        type: "text",
        text,
      },
    })
  }

  private async executeToolCall(input: Parameters<ToolRuntime["execute"]>[0]): Promise<ToolRuntimeResult> {
    try {
      return await this.deps.tools.execute(input)
    } catch (error) {
      if (input.signal?.aborted) throw error
      const result = failedToolExecution(input.name, error)
      this.deps.output.appendLine(`[tool] ${input.name} failed: ${result.error ?? result.output}`)
      return result
    }
  }

  private toolApprovalHandler(input: {
    sessionID: string
    assistant: ChipMateMessage
    call: ChatToolCall
    args: Record<string, unknown>
    signal?: AbortSignal
  }): ToolApprovalHandler {
    return async (request) => {
      if (this.listeners.size === 0) {
        return {
          approved: false,
          reason: "QA inline approval unavailable",
        }
      }
      const metadata = toolApprovalMetadata(request)
      const part: ChipMatePart = {
        id: input.call.id,
        sessionID: input.sessionID,
        messageID: input.assistant.info.id,
        type: "tool",
        tool: input.call.function.name,
        state: {
          status: "approval-required",
          input: input.args,
          output: `Waiting for QA approval: ${request.summary}`,
          metadata,
        },
      }
      const approval = this.waitForToolApproval({
        requestID: request.id,
        sessionID: input.sessionID,
        messageID: input.assistant.info.id,
        toolCallID: input.call.id,
        signal: input.signal,
      })
      input.assistant.parts = upsertPart(input.assistant.parts, part)
      this.emit("message.part.updated", { part })
      return approval
    }
  }

  private waitForToolApproval(input: {
    requestID: string
    sessionID: string
    messageID: string
    toolCallID: string
    signal?: AbortSignal
  }): Promise<ToolApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (decision: ToolApprovalDecision) => {
        if (settled) return
        settled = true
        input.signal?.removeEventListener("abort", onAbort)
        this.pendingToolApprovals.delete(input.requestID)
        resolve(decision)
      }
      const onAbort = () => finish({ approved: false, reason: "request canceled" })
      this.pendingToolApprovals.set(input.requestID, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        toolCallID: input.toolCallID,
        requestID: input.requestID,
        resolve: finish,
      })
      if (input.signal?.aborted) {
        onAbort()
        return
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private waitForClarification(input: {
    requestID: string
    sessionID: string
    messageID: string
    toolCallID: string
    signal?: AbortSignal
  }): Promise<ClarificationAnswer[]> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (answers: ClarificationAnswer[]) => {
        if (settled) return
        settled = true
        input.signal?.removeEventListener("abort", onAbort)
        this.pendingClarifications.delete(input.requestID)
        resolve(answers)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        input.signal?.removeEventListener("abort", onAbort)
        this.pendingClarifications.delete(input.requestID)
        reject(error)
      }
      const onAbort = () => fail(new Error("request canceled"))
      this.pendingClarifications.set(input.requestID, {
        requestID: input.requestID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        toolCallID: input.toolCallID,
        resolve: finish,
        reject: fail,
      })
      if (input.signal?.aborted) {
        onAbort()
        return
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private resolvePendingToolApprovalsForSession(sessionID: string, decision: ToolApprovalDecision) {
    for (const pending of [...this.pendingToolApprovals.values()]) {
      if (pending.sessionID !== sessionID) continue
      this.pendingToolApprovals.delete(pending.requestID)
      pending.resolve(decision)
    }
  }

  private cancelPendingClarificationsForSession(sessionID: string, reason: string) {
    for (const pending of [...this.pendingClarifications.values()]) {
      if (pending.sessionID !== sessionID) continue
      this.pendingClarifications.delete(pending.requestID)
      pending.reject(new Error(reason))
    }
  }

  private async recentChatHistoryMessages(sessionID: string, settings: RemoteSettings, signal?: AbortSignal, sessionEvents?: SessionEvent[]): Promise<ChatMessage[]> {
    const maxTurns = Math.max(0, Math.min(20, Math.floor(settings.context.maxHistoryTurns)))
    const maxBytes = Math.max(0, Math.min(200000, Math.floor(settings.context.maxHistoryBytes)))

    const events = sessionEvents ?? await this.readSessionEvents(sessionID)
    const reusableMessages = reusableHistoryMessages(events)
    const recentWindow = maxTurns > 0 ? recentHistoryTurns(reusableMessages, maxTurns) : []
    const recentMessages = maxTurns === 0 || maxBytes === 0
      ? []
      : fitHistoryMessagesToBudget(recentWindow, maxBytes)
    const memoryMessage = await this.conversationMemoryContextMessage({
      sessionID,
      settings,
      events,
      reusableMessages,
      recentWindow,
      signal,
    })
    const evidenceHistoryMessage = evidenceLedgerHistoryMessage(events)
    const toolHistoryMessage = toolExecutionHistoryMessage(events)
    return [memoryMessage, evidenceHistoryMessage, toolHistoryMessage, ...recentMessages].filter((message): message is ChatMessage => Boolean(message))
  }

  private async previousAssistantVisualInputs(sessionID: string, events: SessionEvent[]): Promise<ChatMessageImageContent[]> {
    const messages = latestSessionMessages(events)
    const previousAssistant = messages[messages.length - 1]
    if (previousAssistant?.info.role !== "assistant" || previousAssistant.info.error) return []
    if (!previousAssistant?.info.id) return []
    const records = visualEvidenceForMessage(events, previousAssistant.info.id).slice(-MAX_VISUAL_EVIDENCE_IMAGES_PER_TURN)
    const images: ChatMessageImageContent[] = []
    for (const record of records) {
      try {
        const dataUri = await this.readVisualEvidenceDataUri(sessionID, record.id)
        images.push({
          type: "image_url",
          image_url: {
            url: dataUri,
            detail: "auto",
          },
        })
      } catch (error) {
        this.deps.output.appendLine(`[visual-context] skipped missing image id=${record.id}: ${formatErrorMessage(error)}`)
      }
    }
    return images
  }

  private async wordRenderVisualBatchesFromPart(input: {
    sessionID: string
    messageID: string
    part: ChipMatePart
    disabled: boolean
  }): Promise<{ batches: WordVisualQaBatch[] }> {
    if (input.part.type !== "wordRender") return { batches: [] }
    const baseArtifact = wordVisualQaArtifactFromPart(input.part, 0, [])
    const pagePngPaths = stringArrayValue((input.part as { pagePngPaths?: unknown }).pagePngPaths)
    const coverage: WordVisualQaPageCoverage[] = []
    const pageImages: Array<{ page: number; image: ChatMessageImageContent }> = []
    for (let index = 0; index < pagePngPaths.length; index += 1) {
      const relative = pagePngPaths[index]
      if (!relative) continue
      const page = index + 1
      if (input.disabled) {
        coverage.push({ page, path: relative, status: "summary-only", reason: "provider image input disabled" })
        continue
      }
      try {
        const uri = this.wordRenderPagePngUri(relative)
        if (!uri) {
          coverage.push({ page, path: relative, status: "skipped", reason: "path is outside render artifact PNG boundary" })
          continue
        }
        const bytes = await vscode.workspace.fs.readFile(uri)
        const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
        await this.appendVisualEvidence({
          sessionID: input.sessionID,
          messageID: input.messageID,
          kind: "word-render-page",
          title: `Word render page ${page}`,
          sourceHash: `word-render:${relative}`,
          artifactPath: relative,
          page,
          dataUri,
        })
        const image = {
          type: "image_url",
          image_url: {
            url: dataUri,
            detail: "auto",
          },
        } as ChatMessageImageContent
        pageImages.push({ page, image })
        coverage.push({ page, path: relative, status: "attached" })
      } catch (error) {
        this.deps.output.appendLine(`[word-visual-qa] skipped page PNG visual evidence path=${relative}: ${formatErrorMessage(error)}`)
        coverage.push({ page, path: relative, status: "failed", reason: formatErrorMessage(error) })
      }
    }
    if (!coverage.length && baseArtifact.pageCount > 0) {
      for (let page = 1; page <= baseArtifact.pageCount; page += 1) {
        coverage.push({ page, status: input.disabled ? "summary-only" : "skipped", reason: "page PNG artifact missing" })
      }
    }
    const artifact: WordVisualQaArtifact = {
      ...baseArtifact,
      visualEvidenceCount: pageImages.length,
      coverage,
      batchSize: WORD_VISUAL_QA_IMAGES_PER_BATCH,
      batchCount: Math.max(1, Math.ceil(Math.max(coverage.length, pageImages.length) / WORD_VISUAL_QA_IMAGES_PER_BATCH)),
    }
    const imageByPage = new Map(pageImages.map((item) => [item.page, item.image]))
    const pagesForBatches = coverage.length ? coverage : [{ page: 0, status: "summary-only" as const, reason: "no page PNG artifact available" }]
    const batches: WordVisualQaBatch[] = []
    for (let index = 0; index < pagesForBatches.length; index += WORD_VISUAL_QA_IMAGES_PER_BATCH) {
      const pages = pagesForBatches.slice(index, index + WORD_VISUAL_QA_IMAGES_PER_BATCH)
      batches.push({
        artifact,
        batchIndex: batches.length + 1,
        batchCount: artifact.batchCount,
        pages,
        images: input.disabled ? [] : pages.map((page) => imageByPage.get(page.page)).filter((item): item is ChatMessageImageContent => Boolean(item)),
      })
    }
    return { batches }
  }

  private wordRenderPagePngUri(relative: string | undefined) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!root || !relative) return undefined
    const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!normalized.startsWith(".chipmate/docs/") || normalized.split("/").includes("..") || !/\.png$/i.test(normalized)) {
      return undefined
    }
    return vscode.Uri.joinPath(root, ...normalized.split("/"))
  }

  private async conversationMemoryContextMessage(input: {
    sessionID: string
    settings: RemoteSettings
    events: SessionEvent[]
    reusableMessages: ReusableHistoryMessage[]
    recentWindow: ReusableHistoryMessage[]
    signal?: AbortSignal
  }): Promise<ChatMessage | undefined> {
    const config = input.settings.context.memorySummary
    const maxBytes = Math.max(0, Math.min(80000, Math.floor(config.maxBytes)))
    const triggerOverflowTurns = Math.max(0, Math.min(20, Math.floor(config.triggerOverflowTurns)))
    if (!config.enabled || maxBytes === 0) {
      this.deps.output.appendLine("[chat-memory] disabled")
      return undefined
    }

    let memory = latestConversationMemory(input.events)
    const recentIDs = new Set(input.recentWindow.map((message) => message.id))
    const overflow = input.reusableMessages.filter((message) => !recentIDs.has(message.id))
    const coveredIDs = new Set(memory?.coveredMessageIDs ?? [])
    const uncoveredOverflow = overflow.filter((message) => !coveredIDs.has(message.id))
    const uncoveredOverflowTurns = countHistoryUserTurns(uncoveredOverflow)
    if (uncoveredOverflow.length > 0 && uncoveredOverflowTurns >= triggerOverflowTurns) {
      this.queueConversationMemoryRefresh({
        sessionID: input.sessionID,
        settings: input.settings,
        latestMemory: memory,
        historyMessages: input.reusableMessages,
        newOverflowMessages: uncoveredOverflow,
        signal: input.signal,
      })
    } else {
      this.deps.output.appendLine(`[chat-memory] no overflow uncoveredTurns=${uncoveredOverflowTurns} trigger=${triggerOverflowTurns}`)
    }

    const summary = memory?.summary ? fitConversationMemorySummaryToBudget(memory.summary, maxBytes) : ""
    return summary
      ? {
          role: "assistant",
          content: conversationMemoryContextContent(summary),
        }
      : undefined
  }

  private queueConversationMemoryRefresh(input: ConversationMemoryRefreshInput) {
    if (input.signal?.aborted) return
    if (this.activeMemoryRefreshes.has(input.sessionID) || this.queuedMemoryRefreshes.has(input.sessionID)) {
      this.deps.output.appendLine(`[chat-memory] refresh already running session=${input.sessionID}`)
      return
    }
    const overflowTurns = countHistoryUserTurns(input.newOverflowMessages)
    this.deps.output.appendLine(`[chat-memory] queued background summary overflowTurns=${overflowTurns}`)
    this.queuedMemoryRefreshes.set(input.sessionID, input)
  }

  private flushQueuedConversationMemoryRefresh(sessionID: string) {
    const input = this.queuedMemoryRefreshes.get(sessionID)
    if (!input) return
    this.queuedMemoryRefreshes.delete(sessionID)
    if (input.signal?.aborted) return
    if (this.activeMemoryRefreshes.has(sessionID)) {
      this.queuedMemoryRefreshes.set(sessionID, input)
      return
    }
    this.activeMemoryRefreshes.add(sessionID)
    setTimeout(() => {
      if (input.signal?.aborted) {
        this.activeMemoryRefreshes.delete(sessionID)
        return
      }
      void this.refreshConversationMemory(input)
        .catch((error) => {
          this.deps.output.appendLine(`[chat-memory] summary failed: ${formatErrorMessage(error)}`)
        })
        .finally(() => {
          this.activeMemoryRefreshes.delete(sessionID)
        })
    }, 0)
  }

  private async refreshConversationMemory(input: {
    sessionID: string
    settings: RemoteSettings
    latestMemory?: ConversationMemoryRecord
    historyMessages: ReusableHistoryMessage[]
    newOverflowMessages: ReusableHistoryMessage[]
    signal?: AbortSignal
  }) {
    const maxBytes = Math.max(0, Math.min(80000, Math.floor(input.settings.context.memorySummary.maxBytes)))
    const messages = conversationMemorySummaryMessages(input.latestMemory?.summary ?? "", input.newOverflowMessages)
    const promptBytes = textByteLength(JSON.stringify(messages))
    const overflowTurns = countHistoryUserTurns(input.newOverflowMessages)
    this.deps.output.appendLine(`[chat-memory] summarizing overflowTurns=${overflowTurns} promptBytes=${promptBytes}`)
    const responseRaw = await this.requestConversationMemorySummary(input.settings, messages, input.signal)
    const responseText = conversationMemoryContentFromResponse(responseRaw)
    const summary = fitConversationMemorySummaryToBudget(parseConversationMemorySummary(responseText), maxBytes)
    const now = Date.now()
    const coveredMessageIDs = uniqueStrings([
      ...(input.latestMemory?.coveredMessageIDs ?? []),
      ...input.newOverflowMessages.map((message) => message.id),
    ])
    const coveredIDSet = new Set(coveredMessageIDs)
    const memory: ConversationMemoryRecord = {
      id: `memory-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
      sessionID: input.sessionID,
      createdAt: input.latestMemory?.createdAt ?? now,
      updatedAt: now,
      coveredMessageIDs,
      summary,
      sourceTurnCount: countHistoryUserTurns(input.historyMessages.filter((message) => coveredIDSet.has(message.id))),
      summaryVersion: CONVERSATION_MEMORY_SUMMARY_VERSION,
    }
    await this.appendMemory(input.sessionID, memory)
    this.deps.output.appendLine(`[chat-memory] updated summaryBytes=${textByteLength(summary)} coveredMessages=${coveredMessageIDs.length}`)
    return memory
  }

  private async persistPartialAssistant(sessionID: string, assistant: ChipMateMessage) {
    const text = textParts(assistant).trim()
    if (!text) return
    assistant.info.time = { ...assistant.info.time, completed: Date.now() }
    await this.appendMessage(sessionID, assistant).catch(() => undefined)
    this.emit("message.updated", { info: assistant.info })
  }

  private emitToolActivityPart(input: {
    assistant: ChipMateMessage
    sessionID: string
    call: ChatToolCall
    status: "pending" | "running"
  }) {
    const part = {
      id: input.call.id,
      sessionID: input.sessionID,
      messageID: input.assistant.info.id,
      type: "tool",
      tool: input.call.function.name,
      state: {
        status: input.status,
      },
    } satisfies ChipMatePart & { id: string; sessionID: string; messageID: string }
    input.assistant.parts = upsertPart(input.assistant.parts, part)
    this.emit("message.part.updated", { part })
    return input.assistant
  }

  private emitRunProgressPart(input: {
    assistant: ChipMateMessage
    sessionID: string
    toolCallID: string
    event: ToolRuntimeProgressEvent
  }) {
    const now = Date.now()
    const id = `${input.assistant.info.id}-run-progress`
    const existing = input.assistant.parts.find((part) => (part as { id?: unknown }).id === id && part.type === "runProgress")
    const existingRecord = recordValue(existing)
    const existingItems = Array.isArray(existingRecord.items)
      ? existingRecord.items.map((item) => recordValue(item))
      : []
    const itemID = `${input.toolCallID}:${input.event.id || input.event.phase || input.event.title || "progress"}`
    const priorIndex = existingItems.findIndex((item) => stringValue(item.id) === itemID)
    const prior = priorIndex >= 0 ? existingItems[priorIndex] : {}
    const status = normalizeRunProgressStatus(input.event.status)
    const item = {
      id: itemID,
      title: input.event.title || runProgressToolTitle(input.event.tool || ""),
      status,
      detail: input.event.detail || stringValue(prior.detail),
      tool: input.event.tool || stringValue(prior.tool),
      phase: input.event.phase || stringValue(prior.phase),
      path: input.event.path || stringValue(prior.path),
      artifactPath: input.event.artifactPath || stringValue(prior.artifactPath),
      requestedPath: input.event.requestedPath || stringValue(prior.requestedPath),
      targetPath: input.event.targetPath || stringValue(prior.targetPath),
      provider: input.event.provider || stringValue(prior.provider),
      fallbackUsed: input.event.fallbackUsed ?? booleanValue(prior.fallbackUsed),
      startedAt: numberValue(prior.startedAt) || now,
      updatedAt: now,
    }
    const items = [...existingItems]
    if (priorIndex >= 0) items[priorIndex] = item
    else items.push(item)
    const typedItems = items.map((entry, index) => ({
      id: stringValue(entry.id) || `run-progress-item-${index + 1}`,
      title: stringValue(entry.title) || "Step",
      status: normalizeRunProgressStatus(stringValue(entry.status)),
      detail: stringValue(entry.detail),
      tool: stringValue(entry.tool),
      phase: stringValue(entry.phase),
      path: stringValue(entry.path),
      artifactPath: stringValue(entry.artifactPath),
      requestedPath: stringValue(entry.requestedPath),
      targetPath: stringValue(entry.targetPath),
      provider: stringValue(entry.provider),
      fallbackUsed: booleanValue(entry.fallbackUsed),
      startedAt: numberValue(entry.startedAt),
      updatedAt: numberValue(entry.updatedAt),
    }))
    const warningCount = typedItems.filter((entry) => entry.status === "warning" || entry.status === "failed" || entry.status === "skipped").length
    const fallbackCount = typedItems.filter((entry) => entry.fallbackUsed).length
    const completed = typedItems.filter((entry) => entry.status !== "running").length
    const statusForPart = runProgressAggregateStatus(typedItems)
    const part = {
      id,
      sessionID: input.sessionID,
      messageID: input.assistant.info.id,
      type: "runProgress",
      title: "执行进度",
      status: statusForPart,
      startedAt: numberValue(existingRecord.startedAt) || now,
      updatedAt: now,
      current: completed,
      total: typedItems.length,
      warningCount,
      fallbackCount,
      items: typedItems,
    } satisfies ChipMatePart & { id: string; sessionID: string; messageID: string }
    input.assistant.parts = upsertPart(input.assistant.parts, part)
    this.emit("message.part.updated", { part })
    return input.assistant
  }

  private async streamChatCompletion(input: {
    messages: ChatMessage[]
    sessionID: string
    assistant: ChipMateMessage
    exposedTools: ChatToolDefinition[]
    allowTools?: boolean
    signal?: AbortSignal
  }) {
    let attempt = 0
    for (;;) {
      input.signal?.throwIfAborted()
      try {
        return await this.streamChatCompletionOnce(input)
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error
        const retry = sessionRetryableError(error)
        if (!retry) throw error
        attempt += 1
        const limit = sessionRetryLimitFromEnv()
        if (limit !== undefined && attempt > limit) throw error
        const delayMs = sessionRetryDelayMs(attempt, retryHeadersForError(error))
        const status: ChipMateSessionStatus = {
          type: "retry",
          attempt,
          message: retry.message,
          next: Date.now() + delayMs,
        }
        this.statuses.set(input.sessionID, status)
        this.emit("session.status", { sessionID: input.sessionID, status })
        this.deps.output.appendLine(`[chat-retry] retryable model error session=${input.sessionID} attempt=${attempt}${limit !== undefined ? `/${limit}` : ""} delayMs=${delayMs} message=${quoteLogValue(retry.message)}`)
        await sleepWithAbort(delayMs, input.signal)
      }
    }
  }

  private async streamChatCompletionOnce(input: {
    messages: ChatMessage[]
    sessionID: string
    assistant: ChipMateMessage
    exposedTools: ChatToolDefinition[]
    allowTools?: boolean
    signal?: AbortSignal
  }) {
    const settings = this.deps.getSettings()
    let body: Record<string, unknown> = {
      model: settings.provider.chatModel,
      messages: input.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: settings.provider.temperature,
      top_p: settings.provider.topP,
	    }
	    const toolsAllowed = input.allowTools !== false && settings.tools.enabled && input.exposedTools.length > 0
	    const exposedToolNames = toolDefinitionNames(input.exposedTools)
	    if (toolsAllowed) {
	      body.tools = input.exposedTools
	      body.tool_choice = "auto"
    }
    const requestStarted = Date.now()
    let visualInputRejected = false
    const promptBytes = textByteLength(JSON.stringify(input.messages))
    this.deps.output.appendLine(
      `[chat-stream] request start model=${settings.provider.chatModel || "default"} messages=${input.messages.length} promptBytes=${promptBytes} maxTokens=omitted tools=${toolsAllowed ? "enabled" : "disabled"}`,
    )
    const postChatCompletion = async () => fetch(chatCompletionsUrl(settings.provider.apiBaseUrl), {
      method: "POST",
      headers: await this.headers(true),
      signal: input.signal,
      body: JSON.stringify(body),
    })
    let response = await postChatCompletion()
    if (!response.ok) {
      let text = await response.text().catch(() => "")
      if (isStreamUsageUnsupportedResponse(response.status, text) && body.stream_options) {
        this.deps.output.appendLine(`[chat-stream] provider rejected stream usage; retrying without include_usage status=${response.status}`)
        delete body.stream_options
        response = await postChatCompletion()
        text = response.ok ? "" : await response.text().catch(() => "")
      }
      if (chatMessagesHaveImages(input.messages) && isVisualInputUnsupportedResponse(response.status, text)) {
        this.deps.output.appendLine(`[visual-context] provider rejected image input; retrying text-only status=${response.status}`)
        visualInputRejected = true
        stripChatMessageImages(input.messages)
        body = {
          ...body,
          messages: input.messages,
        }
        response = await postChatCompletion()
        if (response.ok) {
          this.deps.output.appendLine("[visual-context] text-only retry accepted")
        } else {
          const retryText = await response.text().catch(() => "")
          if (isStreamUsageUnsupportedResponse(response.status, retryText) && body.stream_options) {
            this.deps.output.appendLine(`[chat-stream] provider rejected stream usage after text-only retry; retrying without include_usage status=${response.status}`)
            delete body.stream_options
            response = await postChatCompletion()
            if (response.ok) {
              this.deps.output.appendLine("[chat-stream] stream usage disabled retry accepted")
            } else {
              const finalText = await response.text().catch(() => "")
              throw chatCompletionHttpError(response, finalText)
            }
          } else {
          throw chatCompletionHttpError(response, retryText)
          }
        }
      } else {
        if (!response.ok) throw chatCompletionHttpError(response, text)
      }
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
    let reportedUsage: ChipMateTokenUsage | undefined
    let deltaCount = 0
    let sseDataCount = 0
    let emptySseBlockCount = 0
    let rawByteCount = 0
    let rawPreview = ""
    let emptySsePreview = ""
    let firstChunkMs: number | undefined
    const announcedToolCallIDs = new Set<string>()
    const stableToolCallIDsByIndex = new Map<number, string>()
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
        if (delta.usage) {
          reportedUsage = delta.usage
          input.assistant.info.tokens = reportedUsage
          input.assistant.info.usageKind = "reported"
          this.emit("message.updated", { info: input.assistant.info })
        }
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
          if (call.id) {
            existing.id = call.id
            stableToolCallIDsByIndex.set(call.index, call.id)
          }
	          if (call.name) {
	            existing.function.name += call.name
	            enforceStreamToolArgumentLimit(existing, exposedToolNames)
	          }
	          if (call.arguments) appendStreamToolArguments(existing, call.arguments, exposedToolNames)
	          toolCalls.set(call.index, existing)
          const stableToolCallID = stableToolCallIDsByIndex.get(call.index)
          if (toolsAllowed && stableToolCallID && existing.function.name && !announcedToolCallIDs.has(stableToolCallID)) {
            announcedToolCallIDs.add(stableToolCallID)
            input.assistant = this.emitToolActivityPart({
              assistant: input.assistant,
              sessionID: input.sessionID,
              call: existing,
              status: "pending",
            })
          }
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
    if (!reportedUsage) {
      const estimated = estimateChatTokenUsage({
        messages: input.messages,
        outputText: text,
        model: settings.provider.chatModel,
      })
      input.assistant.info.tokens = estimated
      input.assistant.info.usageKind = "estimated"
      this.emit("message.updated", { info: input.assistant.info })
    }
    const accountedGoal = await this.goalRuntime.recordTokenUsage(input.sessionID, input.assistant.info.tokens)
    if (accountedGoal) await this.emitGoalUpdated(input.sessionID, accountedGoal)

    return {
      assistant: input.assistant,
      text,
      toolCalls: [...toolCalls.values()].filter((call) => call.function.name),
      visualInputRejected,
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

  private async visualEvidenceDir(sessionID: string) {
    const dir = vscode.Uri.joinPath(await this.sessionsDir(), `${sessionID}.visual`)
    await vscode.workspace.fs.createDirectory(dir)
    return dir
  }

  private async visualEvidenceUri(sessionID: string, visualEvidenceID: string) {
    return vscode.Uri.joinPath(await this.visualEvidenceDir(sessionID), `${visualEvidenceID}.json`)
  }

  private async appendSessionEvent(sessionID: string, event: SessionEvent) {
    const uri = await this.sessionUri(sessionID)
    const previous = await readText(uri)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${previous}${JSON.stringify(event)}\n`))
  }

  private async appendMessage(sessionID: string, message: ChipMateMessage) {
    await this.appendSessionEvent(sessionID, { type: "message", message })
  }

  private async recordAssistantUsage(message: ChipMateMessage) {
    const recorded = await this.usageLedger.append(usageRecordFromMessage(message))
    if (recorded) this.emit("usage.updated", { sessionID: message.info.sessionID, messageID: message.info.id })
  }

  private async ensureUsageBackfilled(signal?: AbortSignal) {
    if (!this.usageBackfillPromise) {
      this.usageBackfillPromise = this.backfillUsageLedger(signal).catch((error) => {
        this.usageBackfillPromise = undefined
        throw error
      })
    }
    await this.usageBackfillPromise
  }

  private async backfillUsageLedger(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const sessions = await this.readSessionRecords()
    const records = []
    for (const session of sessions) {
      signal?.throwIfAborted()
      const messages = latestSessionMessages(await this.readSessionEvents(session.id))
      records.push(...messages.map(usageRecordFromMessage))
    }
    await this.usageLedger.backfill(records)
  }

  private async appendMemory(sessionID: string, memory: ConversationMemoryRecord) {
    await this.appendSessionEvent(sessionID, { type: "memory", memory })
  }

  private async writeVisualEvidenceDataUri(sessionID: string, visualEvidenceID: string, dataUri: string) {
    const uri = await this.visualEvidenceUri(sessionID, visualEvidenceID)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ dataUri })))
  }

  private async readVisualEvidenceDataUri(sessionID: string, visualEvidenceID: string) {
    const text = await readText(await this.visualEvidenceUri(sessionID, visualEvidenceID))
    const record = recordValue(JSON.parse(text) as unknown)
    return sanitizePngDataUri(stringValue(record.dataUri))
  }

  private async appendEvidenceLedger(sessionID: string, messageID: string, entries: EvidenceLedgerEntry[] | undefined) {
    const sanitized = sanitizeEvidenceLedgerEntries(entries)
    if (sanitized.length === 0) return
    const now = Date.now()
    const evidence: EvidenceLedgerRecord = {
      id: `evidence-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
      sessionID,
      messageID,
      createdAt: now,
      entries: sanitized,
      summaryVersion: EVIDENCE_LEDGER_SUMMARY_VERSION,
    }
    await this.appendSessionEvent(sessionID, { type: "evidence", evidence })
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
      const session = latestSessionRecord(await this.readSessionEvents(sessionID))
      if (session) records.push(session)
    }
    return records
  }

  private async touchSession(sessionID: string) {
    const events = await this.readSessionEvents(sessionID)
    const session = latestSessionRecord(events)
    if (!session) return
    session.time = { ...session.time, updated: Date.now() }
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

function maxAgentStepsForSettings(settings: RemoteSettings) {
  const value = Math.floor(Number(settings.tools.maxAgentSteps))
  if (!Number.isFinite(value)) return DEFAULT_MAX_AGENT_STEPS
  return Math.max(MIN_MAX_AGENT_STEPS, Math.min(HARD_MAX_AGENT_STEPS, value))
}

function shouldRepairDrawioWorkflow(state: { validateCompleted: boolean; renderCompleted: boolean; diagramPartInserted: boolean }, settings: RemoteSettings) {
  return settings.tools.enabled && state.validateCompleted && !state.renderCompleted && !state.diagramPartInserted
}

function drawioWorkflowRepairPrompt() {
  return [
    "ChipMate diagram workflow repair:",
    "This same turn validated or normalized DiagramIR, but no rendered draw.io diagram part was produced.",
    "Do not restart evidence collection unless a required field is missing from the available tool outputs above.",
    "If enough normalized DiagramIR or drawioSpec is present above, call chipmate_create_drawio_diagram now with that structured data.",
    "If evidence is insufficient to render honestly, answer briefly with the exact remaining gap instead of calling unrelated tools.",
    "Do not handwrite draw.io XML, Mermaid, or source fences in this repair step.",
  ].join("\n")
}

function createDeliveryDisciplineState(userText: string, activeSkills: ActiveSkillPolicy[]): DeliveryDisciplineState {
  return {
    expectations: deliveryExpectationsFromTurn(userText, activeSkills),
    producedArtifacts: [],
    pendingNextActions: [],
    producerFailures: [],
    completedTools: [],
    convergencePromptInserted: false,
    missingDeliverablePromptInserted: false,
    producerFailureRepairPromptInserted: false,
    wordRenderCheckpointInserted: false,
  }
}

function deliveryExpectationsFromTurn(userText: string, activeSkills: ActiveSkillPolicy[]): DeliveryExpectation[] {
  const text = compactSummaryText(userText)
  const lower = text.toLowerCase()
  const hasDocumentSkill = activeSkills.some((skill) => skill.name === "documents" || skill.name === "chip-design-doc")
  const asksForCreation = /生成|创建|建立|制作|产出|输出|写入|导出|保存|编辑|修改|审阅|generate|create|write|produce|export|save|edit|revise|review/i.test(text)
  const mentionsWordDocument = /\.docx\b/i.test(lower) ||
    /Word\s*文档/i.test(text) ||
    /Word\s*文件/i.test(text) ||
    /\bword\s+document\b/i.test(lower) ||
    /\bword\s+file\b/i.test(lower) ||
    /(生成|创建|导出|输出)\s*Word\b/i.test(text) ||
    /文档|报告|方案|规范|设计文档|详细设计/.test(text)
  if ((hasDocumentSkill && asksForCreation && mentionsWordDocument) || /\.docx\b/i.test(lower)) {
    return [{
      kind: "docx",
      label: "Word .docx document",
      requiredExtensions: [".docx"],
    }]
  }
  if (asksForCreation && /\.(png|mmd|drawio|csv|pdf)\b/i.test(lower)) {
    return [{
      kind: "artifact",
      label: "local artifact file",
      requiredExtensions: [".png", ".mmd", ".drawio", ".csv", ".pdf"],
    }]
  }
  return []
}

function recordDeliveryToolResult(state: DeliveryDisciplineState, tool: string, args: Record<string, unknown>, result: ToolRuntimeResult, output?: vscode.OutputChannel) {
  state.completedTools.push(tool)
  for (const artifact of deliveryArtifactsFromToolResult(tool, result)) {
    const key = `${artifact.kind}:${artifact.path}`
    if (!state.producedArtifacts.some((existing) => `${existing.kind}:${existing.path}` === key)) {
      state.producedArtifacts.push(artifact)
    }
  }
  for (const action of deliveryNextActionsFromToolResult(tool, result)) {
    if (!action.tool || state.completedTools.includes(action.tool)) continue
    const key = `${action.sourceTool}:${action.tool}:${action.reason}:${action.argsSummary ?? ""}`
    const exists = state.pendingNextActions.some((existing) => `${existing.sourceTool}:${existing.tool}:${existing.reason}:${existing.argsSummary ?? ""}` === key)
    if (!exists) state.pendingNextActions.push(action)
  }
  const producerFailure = deliveryProducerFailureFromToolResult(tool, result)
  if (producerFailure) {
    state.producerFailures.push(producerFailure)
    const missing = missingDeliveryExpectations(state).map((item) => item.kind).join(",") || "none"
    const repeated = Boolean(producerFailure.specShapeHash && state.producerFailures.slice(0, -1).some((item) => item.tool === producerFailure.tool && item.specShapeHash === producerFailure.specShapeHash))
    output?.appendLine(`[tool-loop] producer failure recorded tool=${tool} count=${state.producerFailures.length} errorCode=${producerFailure.errorCode || "none"} missing=${missing} specShapeHash=${producerFailure.specShapeHash || "none"} repeatedInvalidSpec=${repeated}`)
  }
  const requestedOutput = requestedArtifactPathFromArgs(args)
  if (requestedOutput && isDeliverableProducerTool(tool) && toolStatusFromResult(result) === "completed" && result.approved) {
    const kind = artifactKindFromPath(requestedOutput)
    const hasSameKindFromTool = kind && state.producedArtifacts.some((artifact) => artifact.tool === tool && artifact.kind === kind)
    if (kind && !hasSameKindFromTool) state.producedArtifacts.push({ kind, path: requestedOutput, tool })
  }
}

function requestedArtifactPathFromArgs(args: Record<string, unknown>) {
  const filename = stringValue(args.filename)
  if (filename && /\.docx$/i.test(filename)) return `.chipmate/docs/${filename}`
  const path = stringValue(args.path) || stringValue(args.outputPath) || stringValue(args.outputFilename)
  return path
}

function deliveryArtifactsFromToolResult(tool: string, result: ToolRuntimeResult): DeliveryArtifactRecord[] {
  if (toolStatusFromResult(result) !== "completed" || !result.approved) return []
  const artifacts: DeliveryArtifactRecord[] = []
  for (const artifact of result.artifacts ?? []) {
    const payload = recordValue(artifact.payload)
    if (artifact.kind === "mermaid") {
      pushArtifactPath(artifacts, tool, stringValue(payload.mmdPath))
      pushArtifactPath(artifacts, tool, stringValue(payload.pngPath))
    } else if (artifact.kind === "word-render") {
      pushArtifactPath(artifacts, tool, stringValue(payload.path))
      pushArtifactPath(artifacts, tool, stringValue(payload.pdfArtifactPath))
      for (const path of stringArrayValue(payload.pagePngPaths)) pushArtifactPath(artifacts, tool, path)
    } else if (artifact.kind === "skill-script") {
      for (const item of arrayRecords(payload.artifacts)) pushArtifactPath(artifacts, tool, stringValue(item.path))
    }
  }
  const output = parseToolOutputObject(result.output)
  const data = recordValue(output.data)
  for (const value of [
    stringValue(output.path),
    stringValue(output.file),
    stringValue(output.artifactPath),
    stringValue(output.pdfArtifactPath),
    stringValue(data.path),
    stringValue(data.file),
    stringValue(data.artifactPath),
    stringValue(data.pngPath),
    stringValue(data.mmdPath),
    stringValue(data.pdfArtifactPath),
  ]) {
    pushArtifactPath(artifacts, tool, value)
  }
  for (const path of stringArrayValue(output.pagePngPaths)) pushArtifactPath(artifacts, tool, path)
  for (const path of stringArrayValue(data.pagePngPaths)) pushArtifactPath(artifacts, tool, path)
  if (typeof result.output === "string") {
    for (const path of result.output.match(/(?:\.chipmate\/docs|\/[^\s"'`<>)]*\.chipmate\/docs)\/[^\s"'`<>)]*\.(?:docx|png|mmd|pdf|csv|drawio)/gi) ?? []) {
      pushArtifactPath(artifacts, tool, path)
    }
  }
  return artifacts
}

function pushArtifactPath(artifacts: DeliveryArtifactRecord[], tool: string, path: string) {
  const normalized = compactSummaryText(path)
  if (!normalized) return
  const kind = artifactKindFromPath(normalized)
  if (!kind) return
  const key = `${kind}:${normalized}`
  if (!artifacts.some((artifact) => `${artifact.kind}:${artifact.path}` === key)) {
    artifacts.push({ kind, path: normalized, tool })
  }
}

function artifactKindFromPath(path: string) {
  const extension = /\.([A-Za-z0-9]+)(?:$|[?#])/.exec(path)?.[1]?.toLowerCase()
  if (!extension) return ""
  if (extension === "docx") return "docx"
  if (extension === "png") return "png"
  if (extension === "mmd") return "mmd"
  if (extension === "pdf") return "pdf"
  if (extension === "csv") return "csv"
  if (extension === "drawio") return "drawio"
  return ""
}

function deliveryNextActionsFromToolResult(sourceTool: string, result: ToolRuntimeResult): DeliveryNextAction[] {
  const output = parseToolOutputObject(result.output)
  return arrayRecords(output.nextActions)
    .map((action): DeliveryNextAction | undefined => {
      const tool = stringValue(action.tool)
      const reason = truncateString(compactSummaryText(stringValue(action.reason)), MAX_TOOL_EXECUTION_FIELD_CHARS)
      const argsSummary = summarizeToolArguments(recordValue(action.args))
      if (!tool || !reason) return undefined
      return argsSummary ? { tool, reason, argsSummary, sourceTool } : { tool, reason, sourceTool }
    })
    .filter((action): action is DeliveryNextAction => Boolean(action))
    .slice(0, 12)
}

function deliveryProducerFailureFromToolResult(tool: string, result: ToolRuntimeResult): DeliveryProducerFailure | undefined {
  if (toolStatusFromResult(result) === "completed" || !isDeliverableProducerTool(tool)) return undefined
  const output = parseToolOutputObject(result.output)
  const data = recordValue(output.data)
  const validationErrors = [
    ...stringArrayValue(data.validationErrors),
    ...stringArrayValue(output.gaps),
  ].map((item) => truncateString(compactSummaryText(item), MAX_TOOL_EXECUTION_FIELD_CHARS)).filter(Boolean)
  const diagnostic = recordValue(data.diagnostic)
  const reason = truncateString(compactSummaryText(
    stringValue(data.errorMessage) ||
    stringValue(output.answerSummary) ||
    stringValue(result.error) ||
    result.output ||
    "Producer tool failed.",
  ), MAX_TOOL_EXECUTION_LINE_BYTES)
  if (!reason && validationErrors.length === 0) return undefined
  return {
    tool,
    reason: reason || validationErrors[0] || "Producer tool failed.",
    errorCode: stringValue(data.errorCode) || stringValue(output.errorCode) || undefined,
    validationErrors: [...new Set(validationErrors)].slice(0, 8),
    specShapeHash: stringValue(diagnostic.specShapeHash) || undefined,
  }
}

function isDeliverableProducerTool(tool: string) {
  return /create|render|compare|merge|normalize|apply|flatten|materialize|refresh|export/i.test(tool)
}

function pendingDeliveryNextActions(state: DeliveryDisciplineState) {
  return state.pendingNextActions
    .filter((action) => !state.completedTools.includes(action.tool))
    .slice(-8)
}

function missingDeliveryExpectations(state: DeliveryDisciplineState) {
  return state.expectations.filter((expectation) =>
    !state.producedArtifacts.some((artifact) => expectation.requiredExtensions.includes(`.${artifact.kind}`))
  )
}

function shouldInsertEvidenceConvergenceCheckpoint(state: DeliveryDisciplineState, stepCount: number, maxAgentSteps: number) {
  if (state.convergencePromptInserted) return false
  if (maxAgentSteps < 4) return false
  const remainingAfterThisStep = maxAgentSteps - stepCount
  if (remainingAfterThisStep > EVIDENCE_CONVERGENCE_CHECKPOINT_REMAINING_STEPS) return false
  return state.expectations.length > 0 || pendingDeliveryNextActions(state).length > 0
}

function shouldInsertMissingDeliverablePrompt(state: DeliveryDisciplineState) {
  return !state.missingDeliverablePromptInserted && missingDeliveryExpectations(state).length > 0
}

function shouldInsertProducerFailureRepairPrompt(state: DeliveryDisciplineState) {
  const createWordFailedWithoutDocx = state.producerFailures.some((failure) => failure.tool === "create_word_document") &&
    !state.producedArtifacts.some((artifact) => artifact.kind === "docx")
  return !state.producerFailureRepairPromptInserted &&
    (missingDeliveryExpectations(state).length > 0 || createWordFailedWithoutDocx) &&
    state.producerFailures.length > 0
}

function shouldInsertWordRenderCheckpoint(state: DeliveryDisciplineState) {
  if (state.wordRenderCheckpointInserted) return false
  if (!hasDocxDeliveryExpectation(state)) return false
  if (!latestGeneratedDocxPath(state)) return false
  return !state.completedTools.includes("render_word_document")
}

function hasDocxDeliveryExpectation(state: DeliveryDisciplineState) {
  return state.expectations.some((expectation) => expectation.kind === "docx")
}

function latestGeneratedDocxPath(state: DeliveryDisciplineState) {
  return [...state.producedArtifacts].reverse().find((artifact) =>
    artifact.kind === "docx" && isGeneratedDocxProducerTool(artifact.tool)
  )?.path ?? ""
}

function isGeneratedDocxProducerTool(tool: string) {
  return tool === "create_word_document" ||
    tool === "apply_word_document_edits" ||
    tool === "merge_word_documents" ||
    tool === "normalize_word_document_styles" ||
    tool === "apply_word_template_styles" ||
    tool === "flatten_word_ref_fields" ||
    tool === "materialize_word_seq_fields" ||
    tool === "refresh_word_native_fields"
}

function evidenceConvergenceCheckpointPrompt(input: {
  state: DeliveryDisciplineState
  stepCount: number
  maxAgentSteps: number
  totalToolCallCount: number
}) {
  return [
    "ChipMate evidence convergence checkpoint.",
    `The turn is near the configured tool budget: step ${input.stepCount}/${input.maxAgentSteps}, executed tool calls ${input.totalToolCallCount}.`,
    "Stop open-ended search/read loops when the current evidence is enough to answer or produce the requested deliverable.",
    "If the user requested a local file or artifact, prioritize the final producer tool now. Put incomplete coverage into assumptions, limitations, gaps, or owner-review notes instead of spending the remaining budget on broad exploration.",
    deliveryDisciplineSummary(input.state),
  ].filter(Boolean).join("\n\n")
}

function missingDeliverableSteeringPrompt(state: DeliveryDisciplineState) {
  return [
    "ChipMate deliverable discipline checkpoint.",
    "The current assistant draft did not produce the local deliverable requested by the user.",
    "Do not answer with inline Markdown as if the file was created. If enough evidence is present, call the final producer tool now. If evidence is insufficient, state the exact missing input instead of claiming completion.",
    deliveryDisciplineSummary(state),
  ].join("\n\n")
}

function producerFailureRepairPrompt(state: DeliveryDisciplineState) {
  const wordSpecRepair = wordSpecProducerFailureRepairText(state)
  return [
    "ChipMate producer failure repair checkpoint.",
    "A final artifact producer tool failed while the requested local deliverable is still missing.",
    "Do not resume broad search/read loops. Use the tool error below to repair the producer arguments/spec and retry the same final producer tool when the current evidence is sufficient. Put unresolved content coverage into assumptions, limitations, gaps, or owner-review notes.",
    wordSpecRepair,
    "If the producer arguments cannot be repaired, explicitly state that the requested local deliverable was not generated and cite the exact tool failure.",
    deliveryDisciplineSummary(state),
  ].filter(Boolean).join("\n\n")
}

function wordSpecProducerFailureRepairText(state: DeliveryDisciplineState) {
  const latestWordFailure = [...state.producerFailures].reverse().find((failure) =>
    failure.tool === "create_word_document" && (
      failure.errorCode === "word-doc-spec-string-disallowed" ||
      failure.errorCode === "word-doc-spec-json-parse-failed" ||
      failure.errorCode === "tool-arguments-invalid-json"
    )
  )
  if (!latestWordFailure) return ""
  return [
    "create_word_document argument repair rule:",
    "The next create_word_document call MUST use one valid top-level JSON object shaped exactly like {\"filename\":\"target.docx\",\"spec\":{...}}.",
    "Do not pass spec as a quoted string. Do not use JSON.stringify(spec). Do not return a Markdown document as a substitute for the missing .docx.",
    "Use this minimal object shape if the prior spec was long or malformed:",
    "{\"filename\":\"目标文件名.docx\",\"spec\":{\"metadata\":{\"title\":\"文档标题\",\"documentType\":\"technical-design\",\"language\":\"zh-CN\",\"generatedAt\":\"2026-06-30T00:00:00Z\"},\"sources\":[],\"sections\":[{\"id\":\"overview\",\"level\":1,\"title\":\"概述\",\"paragraphs\":[\"正文内容。\"]}],\"qualityChecklist\":{\"assumptions\":[],\"limitations\":[],\"missingInputs\":[],\"risks\":[]}}}",
    "If the same failure repeats, shrink to the smallest useful WordDocSpec and put uncovered details into assumptions/gaps instead of submitting another oversized or stringified spec.",
  ].join("\n")
}

function wordRenderCheckpointPrompt(state: DeliveryDisciplineState) {
  const generated = latestGeneratedDocxPath(state)
  return [
    "ChipMate Word render QA checkpoint.",
    "A Word/DOCX deliverable has been generated or edited in this turn, but render_word_document has not been called yet.",
    generated
      ? `Call render_word_document now with path ${generated} to perform page-level visual QA.`
      : "Call render_word_document now for the latest generated DOCX artifact to perform page-level visual QA.",
    "If the user explicitly asked to skip visual QA or render_word_document cannot be used, finish only after clearly stating that page-level visual QA was not completed.",
    "Do not confuse Mermaid PNG rendering with Word page-level visual QA; Mermaid artifacts are figure inputs, not final DOCX page render evidence.",
    deliveryDisciplineSummary(state),
  ].join("\n\n")
}

function deliveryDisciplineSummary(state: DeliveryDisciplineState) {
  const expectations = state.expectations.length
    ? state.expectations.map((item) => `${item.label} (${item.requiredExtensions.join(", ")})`).join("; ")
    : "none"
  const missing = missingDeliveryExpectations(state).map((item) => item.label).join("; ") || "none"
  const produced = state.producedArtifacts.length
    ? state.producedArtifacts.slice(-8).map((item) => `${item.kind}:${item.path} via ${item.tool}`).join("\n")
    : "none"
  const pending = pendingDeliveryNextActions(state).length
    ? pendingDeliveryNextActions(state).map((item, index) => `${index + 1}. ${item.tool} from ${item.sourceTool}: ${item.reason}${item.argsSummary ? ` (${item.argsSummary})` : ""}`).join("\n")
    : "none"
  const failures = state.producerFailures.length
    ? state.producerFailures.slice(-5).map((item, index) => `${index + 1}. ${item.tool}: ${item.errorCode ? `[${item.errorCode}] ` : ""}${item.reason}${item.validationErrors.length ? `; validationErrors=${item.validationErrors.join(" | ")}` : ""}`).join("\n")
    : "none"
  return [
    `Expected deliverables: ${expectations}`,
    `Missing expected deliverables: ${missing}`,
    `Produced artifacts this turn:\n${produced}`,
    `Tool-declared next actions still pending:\n${pending}`,
    `Producer failures this turn:\n${failures}`,
  ].join("\n")
}

function missingDeliverableFinalAnswerText(state: DeliveryDisciplineState, assistantText: string) {
  const missing = missingDeliveryExpectations(state)
  if (missing.length === 0) return ""
  if (assistantTextDisclosesMissingDeliverable(assistantText) && !assistantTextPresentsInlineDeliverableSubstitute(assistantText)) return ""
  return missingDeliverableFallbackMessage(state)
}

function generatedDocumentFinalLocationText(state: DeliveryDisciplineState, assistantText: string) {
  const docxPath = latestGeneratedDocxPath(state)
  if (!docxPath) return ""
  if (assistantTextIncludesArtifactPath(assistantText, docxPath)) return ""
  return `生成位置：${docxPath}`
}

function wordRenderQaFinalDisclosureText(state: DeliveryDisciplineState, assistantText: string) {
  if (!hasDocxDeliveryExpectation(state)) return ""
  const docxPath = latestGeneratedDocxPath(state)
  if (!docxPath) return ""
  if (state.completedTools.includes("render_word_document")) return ""
  if (assistantTextDisclosesMissingWordRenderQa(assistantText)) return ""
  return `注意：Word 文档已生成（${docxPath}），但本轮未执行 render_word_document，因此页面级视觉 QA 未完成。Mermaid PNG 渲染不等同于最终 Word 页面视觉 QA。`
}

function assistantTextDisclosesMissingDeliverable(text: string) {
  if (!text.trim()) return false
  return /(未生成|没有生成|未创建|没有创建|未产出|没有产出|无法生成|未能生成|not generated|not created|was not generated|could not generate|no .*artifact|no .*file)/i.test(text) &&
    /(\.docx|word|文档|交付物|artifact|file)/i.test(text)
}

function assistantTextPresentsInlineDeliverableSubstitute(text: string) {
  return /完整\s*Word\s*文档如下|完整.*文档.*如下|复制到\s*Word|复制到\s*Markdown|Markdown\s*编辑器|Word\s*或\s*Markdown|直接将以下内容复制|directly copy.*Word|copy.*Markdown/i.test(text)
}

function assistantTextIncludesArtifactPath(text: string, path: string) {
  const normalizedPath = compactSummaryText(path)
  if (!normalizedPath) return false
  return compactSummaryText(text).includes(normalizedPath)
}

function assistantTextDisclosesMissingWordRenderQa(text: string) {
  if (!text.trim()) return false
  return /(视觉\s*QA|visual\s*QA|页面级|page-level|render_word_document|页面渲染|page\s+render)/i.test(text) &&
    /(未完成|未执行|未做|跳过|skipped|not completed|not run|not performed|unavailable|不可用)/i.test(text)
}

function missingDeliverableFallbackMessage(state: DeliveryDisciplineState) {
  const missing = missingDeliveryExpectations(state)
    .map((item) => `${item.label} (${item.requiredExtensions.join(", ")})`)
    .join("、")
  const pending = pendingDeliveryNextActions(state)
    .map((item) => `- ${item.tool}: ${item.reason}`)
    .join("\n")
  const produced = state.producedArtifacts
    .slice(-8)
    .map((item) => `- ${item.kind}: ${item.path}`)
    .join("\n")
  const failures = state.producerFailures
    .slice(-5)
    .map((item) => `- ${item.tool}: ${item.errorCode ? `[${item.errorCode}] ` : ""}${item.reason}${item.validationErrors.length ? `；validationErrors=${item.validationErrors.join(" | ")}` : ""}`)
    .join("\n")
  return [
    `未生成请求的本地交付物：${missing || "未知交付物"}。`,
    "本轮已停止把内联 Markdown 当作完成结果返回，以符合 Codex-style artifact delivery discipline。",
    produced ? `本轮已经产生的相关 artifact：\n${produced}` : "本轮没有产生满足请求的最终 artifact。",
    failures ? `最终产物工具失败原因：\n${failures}` : "",
    pending ? `仍待执行的工具动作：\n${pending}` : "没有可确认的后续工具动作；需要继续时请让 ChipMate 基于当前会话证据调用最终产物工具。",
  ].filter(Boolean).join("\n\n")
}

function toolLoopLimitFinalizationPrompt(maxAgentSteps: number, totalToolCallCount: number, deliveryDiscipline?: DeliveryDisciplineState) {
  const deliverySummary = deliveryDiscipline ? deliveryDisciplineSummary(deliveryDiscipline) : ""
  return [
    `ChipMate reached the configured direct-chat tool loop limit after ${maxAgentSteps} agent step(s) and ${totalToolCallCount} tool call(s).`,
    "Do not call any more tools. The host will not execute additional tool calls in this finalization step.",
    "Use only the bounded raw tool outputs already present above in this same turn, plus the original user request, to produce the best possible final answer.",
    "State concrete file paths, symbols, coverage, and gaps when the bounded tool outputs support them.",
    "If the collected evidence is incomplete, say what remains uncertain and what narrower follow-up would be useful.",
    deliverySummary ? [
      "Deliverable discipline:",
      deliverySummary,
      "If an expected local deliverable is still missing, explicitly state that it was not generated. Do not present inline Markdown, Mermaid source, or prose as the requested file artifact.",
    ].join("\n") : "",
  ].join("\n\n")
}

function toolLoopLimitFallbackMessage(maxAgentSteps: number, totalToolCallCount: number, reason: string) {
  return [
    `已达到本轮工具调用上限（${maxAgentSteps} 个 agent step，已执行 ${totalToolCallCount} 次工具调用）。`,
    "ChipMate 已停止继续执行工具，以避免无限读取或请求过大。",
    "模型未能基于已收集的 bounded 工具结果生成最终总结。",
    `收口原因：${reason}`,
    "可以继续追问，让 ChipMate 基于当前会话的工具执行摘要继续；更推荐把问题缩小到具体文件、符号或子问题后再继续。",
  ].join("\n\n")
}

const TERMINAL_COMMAND_PLANNER_SYSTEM_PROMPT = [
  "You are ChipMate Terminal Command Planner.",
  "Return JSON only. Do not use Markdown, code fences, prose outside JSON, or tool calls.",
  "Choose exactly one schema:",
  "{\"type\":\"command\",\"title\":\"short user-facing action title\",\"purpose\":\"why this command is proposed\",\"command\":\"single shell command\",\"expectedOutcome\":\"what the user will see after it runs\",\"riskNote\":\"short safety note\",\"explanation\":\"short fallback reason\",\"confidence\":\"low|medium|high\"}",
  "{\"type\":\"answer\",\"message\":\"short answer when no command is needed\"}",
  "{\"type\":\"clarify\",\"question\":\"one short clarification question\"}",
  "For command plans, return user-facing title, purpose, expectedOutcome, and riskNote in the user's language when possible.",
  "For command plans, emit one command string only. Combine multi-step operations with && when that is the safest concise form.",
  "Prefer explicit current-directory arguments for commands that otherwise imply cwd; for example, use `cloc .` instead of `cloc`.",
  "Always tailor commands to the provided Platform, Shell, and Shell kind. Do not mix POSIX/GNU flags into PowerShell or cmd unless the command explicitly invokes a POSIX shell.",
  "For extension file searches: use `find . -type f -name '*.d' -print` on POSIX shells, `Get-ChildItem -Path . -Recurse -Filter *.d -File | ForEach-Object { $_.FullName }` on PowerShell, and `cmd /c dir /s /b *.d` on cmd.",
  "On Windows PowerShell, `dir` is a Get-ChildItem alias and does not accept cmd-style `/s /b`; use Get-ChildItem or explicitly prefix cmd commands with `cmd /c`.",
  "For project build/run/install/structure questions, use Project context first. Cite detected files or docs in the answer when available.",
  "If Project context has no build files or useful evidence, explicitly say the advice is generic and that no clear build system was detected in the current directory.",
  "Do not claim you read or verified files that are not present in Project context.",
  "For read-only counting/listing/inspection commands, say that they should not modify files in riskNote. For install/delete/reboot/network-script commands, state the concrete risk.",
  "In repair mode, if failureKind is missing-command and repairPreference is prefer-no-install-fallback, prefer a reliable no-install substitute for read-only counting/listing/inspection tasks. Only suggest installing the missing tool when there is no reasonable substitute.",
  "In repair mode, do not repeat a command that depends on the missingCommand unless the command first installs or otherwise provides that missing command.",
  "Never claim a command has been executed. The VS Code extension will show the command to the user and ask for confirmation.",
  "Prefer noninteractive flags when they are standard and safe, but mention real TTY limits in explanation when sudo/password/TUI/REPL input may be required.",
  "If the request is ambiguous, risky without missing details, or platform-specific in a way you cannot infer, return clarify instead of guessing.",
].join("\n")

const TERMINAL_COMMAND_RESULT_SUMMARY_SYSTEM_PROMPT = [
  "You are ChipMate Terminal Result Summarizer.",
  "Return JSON only. Do not use Markdown, code fences, prose outside JSON, or tool calls.",
  "Summarize what already happened in the terminal for a non-expert user.",
  "Do not propose or execute new commands. Do not claim anything not supported by the visible command output.",
  "Use the user's language when possible.",
  "Return exactly this schema:",
  "{\"status\":\"success|warning|failed|aborted\",\"headline\":\"one short sentence\",\"resultLines\":[\"1-4 concise result lines\"],\"warnings\":[\"0-4 warning lines\"],\"nextStep\":\"one short next-step sentence\"}",
  "If exitCode is non-zero but hasUsableResult is true, use status warning and explain that useful output was still produced.",
].join("\n")

function terminalCommandPlanningMessages(input: TerminalCommandPlanInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: TERMINAL_COMMAND_PLANNER_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: terminalCommandPlanningPrompt(input),
    },
  ]
}

function terminalCommandResultSummaryMessages(input: TerminalCommandResultSummaryInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: TERMINAL_COMMAND_RESULT_SUMMARY_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: terminalCommandResultSummaryPrompt(input),
    },
  ]
}

function terminalCommandResultSummaryPrompt(input: TerminalCommandResultSummaryInput) {
  return [
    `Current working directory: ${input.cwd}`,
    `Command source: ${input.source}`,
    input.originalRequest ? `Original user request: ${input.originalRequest}` : "",
    input.title ? `Command title: ${input.title}` : "",
    input.purpose ? `Command purpose: ${input.purpose}` : "",
    input.expectedOutcome ? `Expected outcome before execution: ${input.expectedOutcome}` : "",
    input.risk ? `Risk shown to user: ${input.risk}` : "",
    input.failureBasis ? `Repair basis: ${input.failureBasis}` : "",
    `Executed command: ${input.command}`,
    `Exit code: ${input.exitCode ?? "unknown"}`,
    `Signal: ${input.signalName ?? "none"}`,
    `Elapsed ms: ${input.elapsedMs}`,
    `Has usable result despite failure: ${input.hasUsableResult ? "yes" : "no"}`,
    input.warnings?.length ? `Local warning hints:\n${input.warnings.join("\n")}` : "Local warning hints: none",
    `Output tail:\n${input.outputTail || "<empty>"}`,
  ].filter(Boolean).join("\n\n")
}

function terminalCommandPlanningPrompt(input: TerminalCommandPlanInput) {
  const recentActivity = input.recentActivity?.length
    ? input.recentActivity.join("\n\n")
    : "No prior terminal activity in this ChipMate Agent Terminal."
  const base = [
    `Mode: ${input.mode}`,
    `Current working directory: ${input.cwd}`,
    `Platform: ${input.platform ?? process.platform}`,
    `Shell: ${input.shell ?? process.env.SHELL ?? "unknown"}`,
    `Shell kind: ${input.shellKind ?? "unknown"}`,
    `User request: ${input.userText}`,
    input.rawInput ? `Raw terminal input: ${input.rawInput}` : "",
    "Project context:",
    input.projectContext ? terminalProjectContextPrompt(input.projectContext) : "No project context was collected.",
    "Recent terminal activity:",
    recentActivity,
  ].filter(Boolean)
  if (input.mode !== "repair") return base.join("\n\n")
  return [
    ...base,
    "Repair context:",
    `Failed command: ${input.failedCommand ?? ""}`,
    `Failure kind: ${input.failureKind ?? "unknown"}`,
    input.missingCommand ? `Missing command: ${input.missingCommand}` : "",
    input.repairPreference ? `Repair preference: ${input.repairPreference}` : "",
    `Failure reason: ${input.failureReason ?? ""}`,
    `Exit code: ${input.exitCode ?? "unknown"}`,
    `Signal: ${input.signalName ?? "none"}`,
    input.nonInteractiveReason ? `Noninteractive limitation: ${input.nonInteractiveReason}` : "",
    `Attempted commands:\n${input.attemptedCommands?.length ? input.attemptedCommands.join("\n") : "none"}`,
    `Output tail:\n${input.outputTail ?? ""}`,
  ].filter(Boolean).join("\n\n")
}

function terminalPlanContentFromResponse(text: string) {
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error("Terminal command planner provider returned malformed JSON.")
  }
  if (!isRecord(value)) {
    throw new Error("Terminal command planner provider returned non-object JSON.")
  }
  const body = value as {
    type?: unknown
    kind?: unknown
    choices?: ChatCompletionChoice[]
  }
  if (isTerminalPlanObject(body)) return JSON.stringify(body)
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  const contentText = terminalPlanTextFromContent(content)
  if (contentText) return contentText

  for (const toolCall of choice?.message?.tool_calls ?? []) {
    const args = toolCall.function?.arguments
    if (typeof args !== "string" || !args.trim()) continue
    if (isTerminalPlanJsonText(args)) return args.trim()
  }

  throw new Error("Terminal command planner response did not include message content.")
}

function terminalSummaryContentFromResponse(text: string) {
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error("Terminal command result summary provider returned malformed JSON.")
  }
  if (!isRecord(value)) {
    throw new Error("Terminal command result summary provider returned non-object JSON.")
  }
  if (isTerminalSummaryObject(value)) return JSON.stringify(value)
  const body = value as { choices?: ChatCompletionChoice[] }
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  const contentText = terminalPlanTextFromContent(content)
  if (contentText) return contentText

  for (const toolCall of choice?.message?.tool_calls ?? []) {
    const args = toolCall.function?.arguments
    if (typeof args !== "string" || !args.trim()) continue
    if (isTerminalSummaryJsonText(args)) return args.trim()
  }

  throw new Error("Terminal command result summary response did not include message content.")
}

function parseSessionDisplayTitle(text: string) {
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    return normalizeSessionDisplayTitle(text)
  }
  if (!isRecord(value)) return normalizeSessionDisplayTitle(text)
  if (typeof value.title === "string") return normalizeSessionDisplayTitle(value.title)
  const choice = (value as { choices?: ChatCompletionChoice[] }).choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  const contentText = terminalPlanTextFromContent(content)
  if (!contentText) return ""
  try {
    const contentValue = JSON.parse(contentText) as unknown
    if (isRecord(contentValue) && typeof contentValue.title === "string") {
      return normalizeSessionDisplayTitle(contentValue.title)
    }
  } catch {
    // Fall through to plain text normalization.
  }
  return normalizeSessionDisplayTitle(contentText)
}

function isTerminalPlanObject(value: Record<string, unknown>) {
  const type = value.type ?? value.kind
  return type === "command" || type === "answer" || type === "clarify"
}

function isTerminalSummaryObject(value: Record<string, unknown>) {
  return typeof value.status === "string" && (typeof value.headline === "string" || typeof value.summary === "string")
}

function summarizeTerminalPlannerResponse(text: string) {
  if (!text.trim()) return "<empty>"
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return `malformed-json bytes=${textByteLength(text)}`
  }
  if (!isRecord(value)) return `non-object-json type=${Array.isArray(value) ? "array" : typeof value} bytes=${textByteLength(text)}`
  const body = value as {
    type?: unknown
    kind?: unknown
    choices?: ChatCompletionChoice[]
  }
  if (isTerminalPlanObject(body)) return `top-level-plan type=${String(body.type ?? body.kind)}`
  const choice = body.choices?.[0]
  const message = choice?.message
  const content = message?.content ?? choice?.text
  const contentShape = describeTerminalPlanContentShape(content)
  const toolCalls = message?.tool_calls?.length ?? 0
  const hasReasoning = message ? hasReasoningFields(message) : false
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "none"
  return `choices=${body.choices?.length ?? 0} finish_reason=${finishReason} content=${contentShape} tool_calls=${toolCalls} reasoning=${hasReasoning ? "present" : "absent"} bytes=${textByteLength(text)}`
}

function terminalPlanTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const joined = content.flatMap((part) => terminalContentPartTexts(part)).join("").trim()
    return joined || undefined
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>
    if (isTerminalPlanObject(record)) return JSON.stringify(record)
    if (typeof record.text === "string" && record.text.trim()) return record.text.trim()
    const textValue = nestedString(record.text, "value")
    if (textValue) return textValue
    if (typeof record.content === "string" && record.content.trim()) return record.content.trim()
    const contentValue = nestedString(record.content, "value")
    if (contentValue) return contentValue
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function terminalContentPartTexts(part: unknown): string[] {
  if (typeof part === "string") return [part]
  if (!part || typeof part !== "object") return []
  const record = part as Record<string, unknown>
  if (typeof record.text === "string") return [record.text]
  const textValue = nestedString(record.text, "value")
  if (textValue) return [textValue]
  if (typeof record.content === "string") return [record.content]
  const contentValue = nestedString(record.content, "value")
  return contentValue ? [contentValue] : []
}

function nestedString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === "string" && nested.trim() ? nested.trim() : ""
}

function isTerminalPlanJsonText(text: string) {
  try {
    parseTerminalCommandPlan(text)
    return true
  } catch {
    return false
  }
}

function isTerminalSummaryJsonText(text: string) {
  try {
    parseTerminalCommandResultSummary(text)
    return true
  } catch {
    return false
  }
}

function describeTerminalPlanContentShape(content: unknown) {
  if (content === undefined) return "missing"
  if (content === null) return "null"
  if (typeof content === "string") return content.trim() ? "string" : "empty-string"
  if (Array.isArray(content)) {
    return `parts:${content.map((part) => {
      if (!part || typeof part !== "object") return typeof part
      const record = part as Record<string, unknown>
      return typeof record.type === "string" ? record.type : "object"
    }).join(",")}`
  }
  if (typeof content === "object") {
    const record = content as Record<string, unknown>
    return `object:${Object.keys(record).filter((key) => !/reasoning/i.test(key)).sort().join(",") || "empty"}`
  }
  return typeof content
}

function hasReasoningFields(record: Record<string, unknown>) {
  return Object.keys(record).some((key) => /reasoning/i.test(key))
}

function parseTerminalCommandPlan(text: string): TerminalCommandPlan {
  const value = parseJsonObject(extractJsonObject(text))
  const type = stringField(value, "type") || stringField(value, "kind")
  if (type === "command") {
    const command = stringField(value, "command").trim()
    if (!command) throw new Error("command plan is missing command")
    if (/[\r\n\0]/.test(command)) throw new Error("command plan must contain a single-line command")
    if (textByteLength(command) > 4000) throw new Error("command plan is too long")
    const confidence = stringField(value, "confidence")
    return {
      kind: "command",
      command,
      explanation: stringField(value, "explanation") || stringField(value, "reason") || "Run the proposed terminal command.",
      confidence: confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : undefined,
      title: optionalStringField(value, "title"),
      purpose: optionalStringField(value, "purpose"),
      expectedOutcome: optionalStringField(value, "expectedOutcome"),
      riskNote: optionalStringField(value, "riskNote"),
    }
  }
  if (type === "answer") {
    const message = stringField(value, "message") || stringField(value, "answer")
    if (!message.trim()) throw new Error("answer plan is missing message")
    return { kind: "answer", message: message.trim() }
  }
  if (type === "clarify") {
    const question = stringField(value, "question") || stringField(value, "message")
    if (!question.trim()) throw new Error("clarify plan is missing question")
    return { kind: "clarify", question: question.trim() }
  }
  throw new Error("terminal plan type must be command, answer, or clarify")
}

function parseTerminalCommandResultSummary(text: string): TerminalCommandResultSummary {
  const value = parseJsonObject(extractJsonObject(text))
  const status = stringField(value, "status")
  if (status !== "success" && status !== "warning" && status !== "failed" && status !== "aborted") {
    throw new Error("terminal command result summary status must be success, warning, failed, or aborted")
  }
  const headline = (stringField(value, "headline") || stringField(value, "summary")).trim()
  if (!headline) throw new Error("terminal command result summary is missing headline")
  const resultLines = stringArrayField(value, "resultLines").slice(0, 6)
  const warnings = stringArrayField(value, "warnings").slice(0, 6)
  const nextStep = (stringField(value, "nextStep") || stringField(value, "next")).trim()
  return {
    status,
    headline,
    resultLines: resultLines.length ? resultLines : [headline],
    warnings,
    nextStep: nextStep || defaultTerminalSummaryNextStep(status),
  }
}

function extractJsonObject(text: string) {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const candidate = fence?.[1]?.trim() ?? trimmed
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start !== -1 && end > start) return candidate.slice(start, end + 1)
  return candidate
}

function parseJsonObject(text: string) {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`malformed JSON: ${formatErrorMessage(error)}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("terminal plan JSON must be an object")
  }
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key).trim()
  return value || undefined
}

function sessionDisplayTitleMessages(question: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You generate short chat history titles for a VS Code coding assistant.",
        "Return exactly one JSON object: {\"title\":\"...\"}.",
        "The title must be specific, concise, and derived only from the user question.",
        "Use the user's language when possible. Do not include quotes, Markdown, or trailing punctuation in the title value.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Create a 3-8 word title for this chat:",
        question,
      ].join("\n\n"),
    },
  ]
}

function stringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
  if (typeof value === "string" && value.trim()) return [value.trim()]
  return []
}

function defaultTerminalSummaryNextStep(status: TerminalCommandResultSummary["status"]) {
  if (status === "failed") return "ChipMate 会根据失败信息继续生成修复建议。"
  if (status === "warning") return "请查看警告；如果结果符合预期，可以继续下一步。"
  if (status === "aborted") return "命令已中断，没有继续执行。"
  return "如果结果符合预期，可以继续下一步。"
}

function isTerminalGoalStatus(status: ThreadGoalStatus) {
  return status === "paused" ||
    status === "blocked" ||
    status === "usage_limited" ||
    status === "budget_limited" ||
    status === "complete"
}

function blockedUnexposedTool(toolName: string): ToolRuntimeResult {
  return {
    title: "Tool blocked",
    output: `Tool is not exposed to the model in this chat mode: ${toolName}`,
    approved: false,
    status: "blocked",
    risk: "blocked",
  }
}

function failedToolExecution(toolName: string, error: unknown): ToolRuntimeResult {
  const message = formatErrorMessage(error)
  return {
    title: `Tool failed: ${toolName}`,
    output: `Tool failed: ${toolName}: ${message}`,
    approved: false,
    status: "failed",
    error: message,
    risk: "failed",
  }
}

function failedToolArgumentParsing(toolName: string, error: Exclude<ToolArgumentParseResult, { ok: true }>, input = "", state?: ToolArgumentState): ToolRuntimeResult {
  const payload = {
    answerSummary: `Tool arguments invalid for ${toolName}: ${error.errorMessage}`,
    evidence: [],
    gaps: [error.errorMessage],
    nextActions: isDeliverableProducerTool(toolName)
      ? [{ tool: toolName, reason: "Retry with a valid top-level JSON object argument. For create_word_document, spec must be an object, not a string.", args: {} }]
      : [],
    truncated: error.errorCode === "tool-arguments-truncated",
    coverage: "partial",
    data: {
      errorCode: error.errorCode,
      errorMessage: error.errorMessage,
      tool: toolName,
      diagnostic: {
        argumentBytes: input ? textByteLength(input) : 0,
        toolArgumentsSanitized: true,
        streamTruncated: Boolean(state?.truncated),
        originalBytes: state?.originalBytes,
        maxBytes: state?.maxBytes,
        head: input ? textHeadByBytes(input, MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES) : "",
        tail: input ? textTailByBytes(input, MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES) : "",
      },
    },
  }
  return {
    title: `Tool arguments invalid: ${toolName}`,
    output: JSON.stringify(payload, null, 2),
    approved: false,
    status: "failed",
    error: error.errorMessage,
    risk: "failed",
  }
}

function toolCallForProviderHistory(call: ChatToolCall, parsed: ToolArgumentParseResult): ChatToolCall {
  if (parsed.ok) return call
  return {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify({
        _chipmateInvalidToolArguments: true,
        errorCode: parsed.errorCode,
        message: parsed.errorMessage,
      }),
    },
  }
}

function toolStatusFromResult(result: ToolRuntimeResult) {
  return result.status ?? (result.approved ? "completed" : result.requiresApproval ? "approval-required" : "blocked")
}

function toolArgumentDiagnosticLogLine(toolName: string, input: string, state: ToolArgumentState | undefined, parsed: ToolArgumentParseResult) {
  const fragments = [
    `[tool-args] ${toolName}`,
    `parse=${parsed.ok ? "ok" : "failed"}`,
    parsed.ok ? "" : `errorCode=${parsed.errorCode}`,
    parsed.ok ? "" : `error="${quoteLogValue(parsed.errorMessage)}"`,
    `argumentBytes=${textByteLength(input)}`,
    state?.truncated ? "streamTruncated=true" : "",
    state?.originalBytes !== undefined ? `originalBytes=${state.originalBytes}` : "",
    state?.maxBytes !== undefined ? `maxBytes=${state.maxBytes}` : "",
    `head="${quoteLogValue(textHeadByBytes(input, MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES), MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES)}"`,
    `tail="${quoteLogValue(textTailByBytes(input, MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES), MAX_TOOL_ARGUMENT_DIAGNOSTIC_BYTES)}"`,
  ].filter(Boolean)
  return fragments.join(" ")
}

function runProgressStatusFromToolStatus(status: string) {
  if (status === "completed") return "completed"
  if (status === "failed" || status === "blocked") return "failed"
  if (status === "approval-required" || status === "user-input-required") return "warning"
  return "running"
}

function normalizeRunProgressStatus(status: unknown) {
  if (status === "completed" || status === "warning" || status === "failed" || status === "skipped") return status
  return "running"
}

function runProgressAggregateStatus(items: Array<{ status: string }>) {
  if (items.some((item) => item.status === "running")) return "running"
  if (items.some((item) => item.status === "failed")) return "failed"
  if (items.some((item) => item.status === "warning" || item.status === "skipped")) return "warning"
  return items.length ? "completed" : "running"
}

function runProgressToolTitle(tool: string) {
  if (tool === "chipmate_render_mermaid_diagram") return "渲染 Mermaid PNG"
  if (tool === "create_word_document") return "生成 Word 文档"
  if (tool === "render_word_document") return "页面级视觉 QA"
  if (tool === "inspect_word_document") return "检查 Word 文档"
  if (tool === "apply_word_document_edits") return "编辑 Word 文档"
  if (tool === "compare_word_documents") return "比较 Word 文档"
  if (tool === "merge_word_documents") return "合并 Word 文档"
  if (tool === "chipmate_run_command") return "运行命令"
  if (tool === "chipmate_read" || tool === "chipmate_read_file" || tool === "chipmate_read_evidence" || tool.startsWith("chipmate_search") || tool.startsWith("chipmate_graph_")) return "收集证据"
  return tool || "执行工具"
}

function runProgressToolResultDetail(result: ToolRuntimeResult, status: string) {
  if (status === "completed") return summarizeToolOutput(result.output, result.error, result.title, status)
  return summarizeToolFailure(result.output, result.error, status) || summarizeToolOutput(result.output, result.error, result.title, status)
}

function toolApprovalMetadata(request: ToolApprovalRequest) {
  const detail = recordValue(request.detail)
  const metadata: Record<string, unknown> = {
    risk: request.risk,
    title: request.title,
    approvalRequestId: request.id,
    approvalTitle: request.title,
    approvalSummary: request.summary,
    approvalRisk: request.risk,
    approvalReason: request.reason,
    approvalActions: ["approve-once", "deny"],
  }
  const path = stringValue(detail.path)
  const bytes = numberValue(detail.bytes)
  if (path) metadata.approvalPath = path
  if (bytes !== undefined) metadata.approvalBytes = bytes
  return metadata
}

function clarificationRequestFromToolResult(result: ToolRuntimeResult): ClarificationRequest | undefined {
  for (const artifact of result.artifacts ?? []) {
    if (artifact.kind !== "clarification") continue
    const payload = artifact.payload
    if (payload && payload.kind === "clarification" && payload.clarificationId && payload.questions?.length) return payload
  }
  return undefined
}

function clarificationPartFromRequest(input: {
  sessionID: string
  messageID: string
  toolCallID: string
  request: ClarificationRequest
  status: "pending" | "answered" | "cancelled"
}): ChipMatePart {
  return {
    id: `${input.toolCallID}-clarification`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "clarification",
    clarificationId: input.request.clarificationId,
    status: input.status,
    title: input.request.title,
    reason: input.request.reason,
    questions: input.request.questions,
    toolCallID: input.toolCallID,
  } as ChipMatePart
}

function clarificationAnswerToolOutput(request: ClarificationRequest, answers: ClarificationAnswer[]) {
  return JSON.stringify({
    kind: "clarification_answer",
    clarificationId: request.clarificationId,
    status: "answered",
    answers,
    assistantInstruction: "Continue the same user request using these clarification answers. Do not ask the same clarification again unless the answer is incomplete.",
  })
}

function sanitizeClarificationAnswers(answers: ClarificationAnswer[]) {
  return (Array.isArray(answers) ? answers : [])
    .slice(0, 3)
    .map((answer, index) => ({
      questionId: truncateString(compactSummaryText(String(answer?.questionId || `q${index + 1}`)), 80),
      choiceId: answer?.choiceId ? truncateString(compactSummaryText(String(answer.choiceId)), 80) : undefined,
      text: answer?.text ? truncateString(compactSummaryText(String(answer.text)), 500) : undefined,
    }))
    .filter((answer) => answer.questionId && (answer.choiceId || answer.text))
}

function mermaidRepairMessages(input: {
  historyMessages: ChatMessage[]
  messageID: string
  source: string
  error: string
  sourceHash?: string
  diagramId?: string
  language?: string
}): ChatMessage[] {
  const language = truncateString(compactSummaryText(input.language || "mermaid"), 80) || "mermaid"
  const system = [
    "You are ChipMate Mermaid Repair.",
    "A Mermaid diagram already shown in VS Code failed in the Mermaid renderer.",
    "Understand the render error and the original diagram intent, then generate a corrected Mermaid diagram.",
    "Return exactly one fenced ```mermaid code block plus at most one short caption.",
    "Do not return draw.io, XML, JSON, tool calls, external URLs, or a long explanation.",
    "Preserve the original graph meaning and labels as much as possible.",
    "Avoid Mermaid syntax that commonly fails in strict webview rendering, including invalid style attributes, unescaped punctuation in labels, HTML labels, and subgraph/container parent cycles.",
  ].join("\n")
  const user = [
    "Repair this Mermaid diagram so it can render successfully.",
    "",
    `Original message id: ${truncateString(input.messageID, 160)}`,
    input.diagramId ? `Diagram id: ${truncateString(input.diagramId, 160)}` : "",
    input.sourceHash ? `Source hash: ${truncateString(input.sourceHash, 160)}` : "",
    `Language fence: ${language}`,
    "",
    "Mermaid render error:",
    "```text",
    input.error,
    "```",
    "",
    "Original Mermaid source:",
    "```mermaid",
    input.source,
    "```",
  ].filter(Boolean).join("\n")
  return [
    { role: "system", content: system },
    ...input.historyMessages,
    { role: "user", content: user },
  ]
}

function mermaidRepairContentFromResponse(text: string) {
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error("Mermaid repair provider returned malformed JSON.")
  }
  if (!isRecord(value)) {
    throw new Error("Mermaid repair provider returned non-object JSON.")
  }
  const body = value as { choices?: ChatCompletionChoice[]; usage?: unknown }
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  const contentText = terminalPlanTextFromContent(content)
  if (!contentText) throw new Error("Mermaid repair response did not include message content.")
  return {
    text: contentText,
    usage: normalizeProviderTokenUsage(body.usage),
  }
}

function mermaidRepairAssistantText(text: string) {
  const repaired = text.trim()
  if (!repaired) throw new Error("Mermaid repair response was empty.")
  if (!/```(?:mermaid|mmd)\b/i.test(repaired)) {
    throw new Error("Mermaid repair response did not include a fenced Mermaid block.")
  }
  return `我根据 Mermaid 渲染错误重画了一版：\n\n${repaired}`
}

function systemPrompt(settings: RemoteSettings, skillCatalog: string, loadedSkills: string) {
  const toolsEnabled = settings.tools.enabled
  return [
    "You are ChipMate, a direct model coding agent running inside the VS Code workspace extension host.",
    toolsEnabled
      ? "Diagram output: default to Mermaid when the user asks to draw a flowchart, process flow, architecture diagram, sequence diagram, state diagram, or simple explanatory diagram and does not explicitly request another format. Choose Mermaid syntax from intent: flowchart TD/LR for flow, process, and architecture diagrams; sequenceDiagram for interaction timelines; stateDiagram-v2 for state transitions; and subgraph blocks for module or layer boundaries. For Mermaid output, return one fenced `mermaid` block with concise labels plus a short caption; do not call draw.io tools for Mermaid output, and collect CodeGraph/RAG/AST/document/skill evidence first only when the diagram content itself needs grounding. Ask for clarification only when the diagram goal, target, or scope is missing; do not ask whether to use Mermaid or draw.io when Mermaid is a safe default. Use draw.io/diagrams.net only when the user explicitly asks for draw.io, drawio, diagrams.net, mxfile, mxGraphModel, or an editable draw.io asset; when repairing/exporting an existing draw.io diagram; or when the user accepts draw.io because Mermaid cannot express the required layout. For complex draw.io requests, use an evidence-backed DiagramIR workflow. The model or active skill decides the user-visible diagramType and all semantic presentation decisions from the user's intent and evidence: business-flow for business/process perspective, code-flow for entry/function/branch/return execution paths, state-machine for pure state transitions, architecture for module boundaries, and soc-block for chip/module/bus/port diagrams. Code evidence does not automatically mean code-flow; if the user asks for a business/process view backed by code, keep diagramType as business-flow. For complex draw.io code-flow, business-flow, architecture, SoC/chip block, state-machine, or reference-style diagrams, first collect enough evidence with CodeGraph/RAG/AST/document/skill tools, organize it into DiagramIR, call chipmate_validate_diagram_ir, then call chipmate_create_drawio_diagram as the final renderer. For complex draw.io diagrams, include visualPlan with layoutProfile, mainBackbone.nodes/edges, edgePresentation edge-id map using mode line/rail/legend, optional rail side, and legend items. For dense engineering draw.io diagrams, keep the mainBackbone and a small number of essential cross-module edges visible; treat rail as a scarce visual channel, and put low-priority, repetitive, evidence-only, explanatory, retry, cleanup, telemetry, or secondary exception details into legend items so the final PNG is at least as clear as a Mermaid baseline. The draw.io renderer does not infer main path, exception path, business meaning, or importance from labels, function names, state names, Chinese words, or domain terms; it only validates and executes the model/skill-authored VisualPlan. Treat containers, regions, lanes, swimlanes, and groups as ownership/background areas, not execution steps: assign owned nodes with parent/container/lane/region/group, and mark an intentionally empty region with allowEmpty or placeholder. For business-flow/code-flow embedded FSM draw.io diagrams, these ownership areas render as weak background bands so flow edges remain on the root layout plane; use explicit containerMode='strong' only when the diagram really needs compound structural nesting. Architecture and SoC/chip draw.io diagrams use strong containers by default. For a simple illustrative draw.io diagram with no evidence requirement, you may call chipmate_create_drawio_diagram directly with a structured spec. Set DiagramIR composition.mode to single by default. Only set composition.mode to multi when the current user request or active skill explicitly asks for or allows multiple diagrams; if one dense diagram would benefit from splitting, mention that as a warning instead of splitting automatically. Do not handwrite mxCell/mxGeometry XML unless the user explicitly asks for raw source. Do not reference external image/font/style URLs or remote draw.io services; after rendering, keep the final explanation brief and do not repeat XML."
      : "Diagram output: tool calling is disabled, so default to one fenced `mermaid` block for unspecified flowchart, process flow, architecture, sequence, state, and simple explanatory diagram requests. When the user explicitly asks for a draw.io or diagrams.net diagram, fall back to one fenced `drawio` code block containing valid <mxfile> or <mxGraphModel> XML; warn that hand-authored XML is less reliable with small local models. Do not reference external image/font/style URLs or remote draw.io services.",
    toolsEnabled
      ? "Use only the context and ChipMate workspace tools provided by this VS Code extension host."
      : "Use only the context provided by ChipMate for workspace operations.",
    toolsEnabled
      ? [
          "Use the initial local evidence pack first. Call read-only ChipMate evidence tools only when evidence is missing, ambiguous, or needs deeper context.",
          "Tool routing: for Mermaid-default diagram requests, use read-only evidence tools only when the content needs grounding, then answer with a fenced `mermaid` block instead of draw.io tools. When Mermaid must be embedded into a Word document or persisted as artifacts, call chipmate_render_mermaid_diagram after authoring valid Mermaid source, use scale 3 for Word figures, then place the returned PNG figure path in the matching WordDocSpec section while keeping the returned width/height as the display size. For explicit complex draw.io requests, use chipmate_graph_map_module, chipmate_graph_function_cfg, chipmate_graph_expand_flow_slice, chipmate_graph_state_flow_detail, chipmate_graph_find_state_machines/trace_state_path, chipmate_search_code, chipmate_search_documents, read_docx, and active skill resources to collect evidence; then use chipmate_validate_diagram_ir and finally chipmate_create_drawio_diagram. For controlled edits to an existing .docx, first call inspect_word_document and then call apply_word_document_edits with a DocumentEditPlan using only returned locators; supported operations are insertSection, replaceParagraph, replaceParagraphWithRichParagraph, replaceParagraphWithBlocks, replaceText, replaceParagraphWithTrackedChange, replaceParagraphWithRichTrackedChange, replaceTextWithTrackedChange, updateHeadingLevel, updateTable, replaceTable, updateTableHeaderRows, updateList, updateSectionPageSetup, updateImageAltText, replaceImage, updateCaptionText, updateHyperlinkText, updateHyperlinkTarget, updateNoteText, paragraph addComment, updateCommentText, setCommentResolved, fillContentControl, addTextWatermark, removeWatermark, removeAllComments, acceptAllTrackedChanges, rejectAllTrackedChanges, scrubDocumentMetadata, redactText, and patchOoxmlPart. Use audit_word_document_styles when the user asks why formatting looks inconsistent or before style cleanup; use normalize_word_document_styles only when the user wants a new style-normalized copy, and pass preserveRunFormatting such as ['bold','italic','underline','color'] when the user wants intentional manual emphasis or brand coloring preserved while other direct formatting drift is removed. Use apply_word_template_styles when the user asks to apply a DOTX/template DOCX/style pack to an existing .docx; warn that pagination and styling may change, pass styleAllowlist when the user asks to import only selected template style ids, and use returned templateAudit to explain style/numbering conflicts plus copied or blocked template relationships/media. Use audit_word_document_fields when the user asks why TOC/page numbers/captions/cross-references look stale or before rendering field-heavy documents; do not use refresh_word_native_fields for TOC/PAGE/NUMPAGES because remote native field refresh is not implemented and the VSIX client does not run local LibreOffice/soffice; use flatten_word_ref_fields only when deterministic headless rendering should replace cached REF/PAGEREF display text in a new copy, and use materialize_word_seq_fields only when deterministic headless rendering should recalculate cached SEQ caption/table/figure numbers while preserving live SEQ fields. Do not use flatten_word_ref_fields or materialize_word_seq_fields to refresh TOC, PAGE, or NUMPAGES. Use compare_word_documents when the user asks to compare/diff/review changes between two local .docx files; the tool handles text diff, DOCX rendering, changed page detection, copied before/after page artifacts, skipped pixel-diff warnings until a remote pixel-diff provider exists, and evidence artifacts. Use merge_word_documents when the user asks to append or merge one local .docx into another; the model must choose base vs append order. Keep allowDrawings false for object-heavy append docs, but it can be true for local image/PNG figure append docs after warning that unsupported embedded objects remain out of scope; local image media and relationships are merged deterministically, hyperlink relationships are remapped, style/numbering conflicts are reported as base-wins, and unsupported embedded object relationships fail closed. Use replaceText for small exact paragraph-local edits when the surrounding paragraph should stay intact; use replaceTextWithTrackedChange instead when that small paragraph-local edit must be visible as Word redline/revision markup; use replaceParagraph only when the whole paragraph should change, and use replaceParagraphWithBlocks when one paragraph should become ordered structural blocks such as lists, figures, tables, cards, quotes, or code. Use updateHeadingLevel only with paragraph locators returned by inspect_word_document when the user asks to fix skipped heading levels or heading hierarchy accessibility warnings. Use updateTableHeaderRows only with table locators returned by inspect_word_document when the user asks to set repeated/header rows for tables or fix table-header accessibility warnings. Use updateHyperlinkText only with hyperlink locators returned by inspect_word_document when the user asks to make link text descriptive; it changes visible text only, not URL or anchor relationships. Use fillContentControl with contentControl locators returned by inspect_word_document when the user asks to fill a Word form/template field. Use addTextWatermark with the documentEnd locator to add a simple VML text watermark; use removeWatermark only with watermark locators returned by inspect_word_document. Use inspection.lists to summarize or audit existing Word numbering/list groups, list levels, and paragraph list membership; use updateList only with a list locator returned by inspect_word_document when the user asks to replace or reorganize list items. Use inspection.notes to summarize or audit existing footnotes/endnotes; use updateNoteText only with a note locator returned by inspect_word_document when the user asks to update footnote or endnote text. Use inspection.images to summarize or audit existing drawings/images, media targets, media paths, sizes, names, and alt text; use updateImageAltText only with an image locator returned by inspect_word_document when the user asks to fix or add image alt text/title, and use replaceImage with an image locator plus PNG-backed FigureSpec when the user asks to replace a local screenshot, diagram, rendered figure, or image binary. Use inspection.captions to summarize or audit existing Figure/Table captions, SEQ fields, cached numbers, and bookmarks; use updateCaptionText only with a caption locator returned by inspect_word_document when the user asks to revise caption text, and preserve SEQ fields/bookmark anchors. Use inspection.sections to summarize or audit existing page size, orientation, margins, section type, and header/footer references; use updateSectionPageSetup only with a section locator returned by inspect_word_document when the user asks to change page size, orientation, or margins. Use inspection.fields to summarize or audit existing Word fields, instructions, cached display text, and field types such as TOC, PAGE, NUMPAGES, SEQ, REF, and PAGEREF; do not call refresh_word_native_fields unless the user explicitly asks to confirm native refresh is unavailable, and only use field materialization tools for the documented REF/PAGEREF flattening or SEQ cached-number workflows. Use inspection.styles to summarize or audit the existing Word style catalog and paragraph/run style usage; do not attempt arbitrary style edits because only audit, normalize, and template-style application tools are exposed. Use replaceParagraphWithTrackedChange for whole-paragraph plain-text redlines, replaceParagraphWithRichTrackedChange for whole-paragraph redlines that must preserve rich runs such as bold, hyperlinks, REF/PAGEREF, or true footnote/endnote note runs, and replaceTextWithTrackedChange for exact paragraph-local redlines; use these only when the user asks for redlines, tracked changes, or revision-mode edits. Use updateCommentText only with a returned comment locator when the user asks to revise existing comment text; use setCommentResolved only with a returned comment locator; use removeAllComments, acceptAllTrackedChanges, rejectAllTrackedChanges, scrubDocumentMetadata, redactText, and patchOoxmlPart only with the returned documentEnd locator for final clean/shareable copies or low-level OOXML repair. For redactText, prefer exact items for known sensitive values; use built-in patterns like {kind:'email'} and {kind:'phone'} for broad PII sweeps, set includeComments only when comment text must be redacted, and disclose that image OCR and cross-run semantic matching remain out of scope. Use patchOoxmlPart only as a last-resort controlled OOXML repair when no native Word operation covers the request; the plan must name a safe XML package part, exact oldText/anchor/closeTag preconditions, expectedOccurrences, and a reason, and it must not create external relationships, macros, OLE, ActiveX, or embedded binary object references. Use chipmate_ask_user_clarification only when a bounded user answer is required before continuing the same turn; it returns as a tool result, so continue after the answer. Use chipmate_create_drawio_diagram directly only for simple illustrative draw.io diagrams or after DiagramIR is validated. Use chipmate_search_text for exact strings/macros/registers/logs; chipmate_graph_inspect_symbol for definitions; chipmate_graph_find_references for references; chipmate_graph_callers/callees for direct function edges; chipmate_graph_trace_call_chain for source-to-target call paths; chipmate_graph_analyze_impact for bounded impact; chipmate_read_evidence for returned refIds; chipmate_read only for an explicit workspace path; chipmate_read_skill_resource only for active skill references/assets/scripts/tasks resources; chipmate_run_command when an active skill or the user asks to run local workspace commands, bundled scripts, builds, tests, scans, compilers, or gate checks such as python3, cmake, gcc, make, or bun test; command execution is controlled by ChipMate permission mode and does not require a skill scripts/manifest.json; chipmate_run_skill_script only for active ChipMate helper scripts that are explicitly opted in through scripts/manifest.json (manifest-level directExecution true or helper execution.directExecution true) with an executable entrypoint, offline networkPolicy, input schema, and bounded output/artifacts; prefer native Word tools whenever the manifest maps the helper to one; create_word_document only for a complete WordDocSpec that should be rendered as .docx, including navigation/TOC intent when appropriate; chipmate_create_directory only when the user explicitly asks to create a new local workspace folder; chipmate_create_file only when the user explicitly asks to create a new local workspace text/code file from scratch; chipmate_edit_file only when the user explicitly asks to modify an existing local workspace text/code file by exact oldString/newString replacement.",
          "Word document workflow: when the user asks to create, edit, review, redline, comment on, compare, diff, merge, append, normalize styles, audit formatting, apply a template/style pack, audit/flatten/materialize Word fields, render, preview, visually QA, export page PNGs, check pagination/layout, or verify a Word/DOCX document, prefer the active `documents` skill when available. The model must plan the document type, audience, design preset, preset alias when useful, header pattern when useful for a new local Word document, heading ladder, section form factors, list/table/figure intent, link/reference/note intent, navigation/TOC/field intent, form/protection intent, compare/merge/style/template/render intent, and edit strategy before calling create_word_document, apply_word_document_edits, render_word_document, compare_word_documents, merge_word_documents, audit_word_document_styles, normalize_word_document_styles, apply_word_template_styles, audit_word_document_fields, flatten_word_ref_fields, or materialize_word_seq_fields. When a Word figure should come from Mermaid, call chipmate_render_mermaid_diagram with scale 3 first and insert the returned PNG path as a FigureSpec image in the intended section; do not put raw Mermaid syntax in the Word body, and keep the returned width/height as the Word display size rather than using pixelWidth/pixelHeight. If pngGenerated=false or wordFigureUsable=false, do not use Mermaid source, source summaries, or fenced code as a Word figure substitute. Do not use refresh_word_native_fields for TOC/PAGE/NUMPAGES in this build; distinguish static TOC/page text from deterministic REF/PAGEREF/SEQ materialization. Use render_word_document directly when the user wants to see or verify existing DOCX layout, page PNGs, visual QA, clipping/overflow checks, or render evidence without modifying the source document. After create_word_document, apply_word_document_edits, or render_word_document returns render evidence, complete the Word visual QA checkpoint before finalizing: inspect attached page PNGs when available, otherwise use render warnings and pageVisualSummaries only and say image-level visual QA was not completed. If the checkpoint finds material risks, use inspect_word_document -> apply_word_document_edits -> render_word_document, or regenerate with create_word_document when locator edits are not appropriate. The Word tools execute the structure, basic a11y, style lint/cleanup, template style-part application, field inventory/REF flattening/SEQ cached numbering, rendering checks through the remote render service, deterministic navigation fields, deterministic diff artifacts, and safe body-level merges; they do not decide the user's document design by themselves.",
          "Diagram skill precedence: obey the current user request first, then any active skill workflow, then ChipMate's default DiagramIR workflow. Active skills may change evidence ordering, reference artifacts, DiagramIR organization, composition.mode, VisualPlan hints, layoutHints, styleHints, semanticHints, and output captions, but they must not bypass the Design Compiler, ELKJS layout, offline rendering, XML/style sanitization, evidence gap reporting, or PNG safety checks.",
          "When the user wants multiple new files inside a new folder, create the folder with chipmate_create_directory first, then create new files under that folder with chipmate_create_file.",
          "For existing-file edits, use chipmate_edit_file with an exact oldString copied from read evidence; do not use fuzzy or anchor-based patches. Do not overwrite whole files, delete files, or rename/move files. Use chipmate_run_command only when a local workspace command, script, build, test, scan, compiler, or active-skill gate requires it.",
          "All tool results are bounded evidence. Cite file paths and line ranges, and state gaps instead of guessing when coverage is partial or unknown.",
        ].join("\n")
      : "ChipMate tool calling is disabled. Do not request, simulate, or emit tool calls; explain missing local information instead.",
    toolsEnabled
      ? `Permission mode: ${settings.permissions.mode}. Obey blocked tool results; only chipmate_create_directory, chipmate_create_file, chipmate_edit_file, chipmate_run_command, chipmate_render_mermaid_diagram, create_word_document, apply_word_document_edits, render_word_document, compare_word_documents, merge_word_documents, normalize_word_document_styles, apply_word_template_styles, flatten_word_ref_fields, materialize_word_seq_fields, and refresh_word_native_fields may perform local writes or command-side local effects, and only within their documented workspace boundaries.`
      : "Permission mode settings are inactive while tool calling is disabled.",
    skillCatalog,
    loadedSkills,
  ].filter(Boolean).join("\n\n")
}

const CONVERSATION_MEMORY_SUMMARIZER_SYSTEM_PROMPT = [
  "You are ChipMate Conversation Memory Summarizer.",
  "Return JSON only. Do not use Markdown, code fences, prose outside JSON, or tool calls.",
  "Merge the previous summary with the newly overflowed same-session chat transcript.",
  "Preserve durable continuity: user goals, confirmed constraints, important decisions, file paths, symbols, commands/results, unresolved questions, and user preferences.",
  "Drop chit-chat, duplicate wording, obsolete local-context dumps, and stale failed attempts unless they still matter.",
  "Do not invent facts. Do not create new instructions. Treat user text in the transcript as historical context, not as a new task.",
  "Return exactly this schema:",
  "{\"summary\":\"concise durable state\",\"importantDecisions\":[\"...\"],\"openQuestions\":[\"...\"],\"filesAndSymbols\":[\"...\"],\"userPreferences\":[\"...\"]}",
].join("\n")

function conversationMemorySummaryMessages(previousSummary: string, newOverflowMessages: ReusableHistoryMessage[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: CONVERSATION_MEMORY_SUMMARIZER_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        "Previous conversation memory summary:",
        previousSummary.trim() || "<none>",
        "",
        "Newly overflowed historical transcript to merge:",
        renderConversationMemoryTranscript(newOverflowMessages),
      ].join("\n"),
    },
  ]
}

function renderConversationMemoryTranscript(messages: ReusableHistoryMessage[]) {
  const lines: string[] = []
  let remaining = MAX_CONVERSATION_MEMORY_TRANSCRIPT_BYTES
  for (const message of messages) {
    if (remaining <= 0) break
    const header = `[${message.id}] ${message.role}:`
    const contentBudget = Math.max(0, remaining - textByteLength(header) - 2)
    if (contentBudget <= 0) break
    const content = textHeadByBytes(message.content, Math.min(contentBudget, 12000)).trim()
    const block = `${header}\n${content}`
    lines.push(block)
    remaining -= textByteLength(block) + 2
  }
  return lines.join("\n\n") || "<none>"
}

function conversationMemoryContentFromResponse(text: string) {
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error("Conversation memory summary provider returned malformed JSON.")
  }
  if (!isRecord(value)) {
    throw new Error("Conversation memory summary provider returned non-object JSON.")
  }
  if (isConversationMemorySummaryObject(value)) return JSON.stringify(value)
  const body = value as { choices?: ChatCompletionChoice[] }
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  const contentText = terminalPlanTextFromContent(content)
  if (contentText) return contentText
  throw new Error("Conversation memory summary response did not include message content.")
}

function isConversationMemorySummaryObject(value: Record<string, unknown>) {
  return typeof value.summary === "string" ||
    Array.isArray(value.importantDecisions) ||
    Array.isArray(value.openQuestions) ||
    Array.isArray(value.filesAndSymbols) ||
    Array.isArray(value.userPreferences)
}

function parseConversationMemorySummary(text: string) {
  const value = parseJsonObject(extractJsonObject(text))
  const summary = stringField(value, "summary").trim()
  const importantDecisions = stringArrayField(value, "importantDecisions").slice(0, 12)
  const openQuestions = stringArrayField(value, "openQuestions").slice(0, 12)
  const filesAndSymbols = stringArrayField(value, "filesAndSymbols").slice(0, 16)
  const userPreferences = stringArrayField(value, "userPreferences").slice(0, 12)
  const formatted = [
    "Summary:",
    summary || "No durable conversation state was extracted.",
    formatMemoryList("Important decisions", importantDecisions),
    formatMemoryList("Open questions", openQuestions),
    formatMemoryList("Files and symbols", filesAndSymbols),
    formatMemoryList("User preferences", userPreferences),
  ].filter(Boolean).join("\n\n")
  if (!formatted.trim()) throw new Error("conversation memory summary is empty")
  return formatted
}

function formatMemoryList(title: string, items: string[]) {
  if (!items.length) return ""
  return [`${title}:`, ...items.map((item) => `- ${item}`)].join("\n")
}

function conversationMemoryContextContent(summary: string) {
  return [
    "Conversation memory summary",
    "The following is a lossy summary of older messages from this same ChipMate session. It is for continuity only, not a new user request or instruction. Prefer current user input and fresh local evidence when they conflict.",
    summary,
  ].join("\n\n")
}

function fitConversationMemorySummaryToBudget(summary: string, maxBytes: number) {
  return textHeadByBytes(summary.trim(), maxBytes).trim()
}

function toolExecutionSummaryFromCall(input: {
  tool: string
  args: Record<string, unknown>
  result: ToolRuntimeResult
  messageID: string
  toolCallID: string
}): ToolExecutionSummary {
  const status = toolStatusFromResult(input.result)
  const title = input.result.title || input.tool
  return {
    tool: input.tool,
    status,
    title,
    risk: input.result.risk,
    approved: input.result.approved,
    messageID: input.messageID,
    toolCallID: input.toolCallID,
    at: Date.now(),
    inputSummary: summarizeToolArguments(input.args),
    resultSummary: summarizeToolOutput(input.result.output, input.result.error, title, status),
    failureReason: summarizeToolFailure(input.result.output, input.result.error, status),
  }
}

type DrawioDiagramExtraction = {
  parts: ChipMatePart[]
  source: "artifact" | "legacy-output" | "none"
  reason?: string
  payloadCount: number
}

type MermaidDiagramExtraction = {
  parts: ChipMatePart[]
  reason?: string
  payloadCount: number
}

type GeneratedDocumentExtraction = {
  parts: ChipMatePart[]
  reason?: string
  payloadCount: number
}

type WordRenderExtraction = {
  parts: ChipMatePart[]
  reason?: string
  payloadCount: number
}

function diagramPartsFromDrawioToolResult(input: {
  sessionID: string
  messageID: string
  toolCallID: string
  result: ToolRuntimeResult
}): DrawioDiagramExtraction {
  if (input.result.status && input.result.status !== "completed") {
    return { parts: [], source: "none", reason: `tool status ${input.result.status}`, payloadCount: 0 }
  }
  if (!input.result.approved) {
    return { parts: [], source: "none", reason: "tool result was not approved", payloadCount: 0 }
  }
  const artifactPayloads = drawioPayloadsFromArtifacts(input.result)
  if (artifactPayloads.length > 0) {
    const parts = artifactPayloads
      .map((item, index) => diagramPartFromDrawioPayload(input, item, index))
      .filter((part): part is ChipMatePart => Boolean(part))
    return {
      parts,
      source: "artifact",
      reason: parts.length ? undefined : "artifact payload did not contain valid mxGraphModel XML",
      payloadCount: artifactPayloads.length,
    }
  }
  const payload = parseToolOutputObject(input.result.output)
  if (stringValue(payload.kind) !== "drawio") {
    return { parts: [], source: "none", reason: "no drawio payload in artifacts or output", payloadCount: 0 }
  }
  const legacyPayloads = [payload, ...arrayRecords(payload.additionalDiagrams)]
  const parts = legacyPayloads
    .map((item, index) => diagramPartFromDrawioPayload(input, item, index))
    .filter((part): part is ChipMatePart => Boolean(part))
  return {
    parts,
    source: "legacy-output",
    reason: parts.length ? undefined : "legacy output did not contain valid mxGraphModel XML",
    payloadCount: legacyPayloads.length,
  }
}

function drawioPayloadsFromArtifacts(result: ToolRuntimeResult) {
  const payloads: Record<string, unknown>[] = []
  for (const artifact of result.artifacts ?? []) {
    if (artifact.kind !== "drawio") continue
    const payload = recordValue(artifact.payload)
    if (stringValue(payload.kind) !== "drawio") continue
    payloads.push(payload, ...arrayRecords(payload.additionalDiagrams))
  }
  return payloads
}

function diagramPartFromDrawioPayload(input: {
  sessionID: string
  messageID: string
  toolCallID: string
}, payload: Record<string, unknown>, index: number): ChipMatePart | undefined {
  const xml = stringValue(payload.mxGraphModelXml).trim()
  if (!/^<mxGraphModel(?:\s|>)/i.test(xml)) return undefined
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((item): item is string => typeof item === "string").slice(0, 20)
    : []
  const gaps = Array.isArray(payload.gaps)
    ? payload.gaps.filter((item): item is string => typeof item === "string").map((item) => `Gap: ${item}`).slice(0, 12)
    : []
  return {
    id: index === 0 ? `${input.toolCallID}-diagram` : `${input.toolCallID}-diagram-${index + 1}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "diagram",
    kind: "drawio",
    source: "tool",
    toolCallID: input.toolCallID,
    diagramId: stringValue(payload.diagramId),
    title: stringValue(payload.title) || "draw.io diagram",
    xml,
    warnings: [...warnings, ...gaps].slice(0, 24),
  } as ChipMatePart
}

function diagramPartsFromMermaidToolResult(input: {
  sessionID: string
  messageID: string
  toolCallID: string
  result: ToolRuntimeResult
}): MermaidDiagramExtraction {
  if (input.result.status && input.result.status !== "completed") {
    return { parts: [], reason: `tool status ${input.result.status}`, payloadCount: 0 }
  }
  if (!input.result.approved) {
    return { parts: [], reason: "tool result was not approved", payloadCount: 0 }
  }
  const payloads = mermaidPayloadsFromArtifacts(input.result)
  if (payloads.length === 0) {
    return { parts: [], reason: "no mermaid payload in artifacts", payloadCount: 0 }
  }
  const parts = payloads
    .map((payload, index) => diagramPartFromMermaidPayload(input, payload, index))
    .filter((part): part is ChipMatePart => Boolean(part))
  return {
    parts,
    reason: parts.length ? undefined : "mermaid artifact payload did not contain sourceText",
    payloadCount: payloads.length,
  }
}

function mermaidPayloadsFromArtifacts(result: ToolRuntimeResult) {
  const payloads: Record<string, unknown>[] = []
  for (const artifact of result.artifacts ?? []) {
    if (artifact.kind !== "mermaid") continue
    const payload = recordValue(artifact.payload)
    if (stringValue(payload.kind) !== "mermaid") continue
    payloads.push(payload)
  }
  return payloads
}

function diagramPartFromMermaidPayload(input: {
  sessionID: string
  messageID: string
  toolCallID: string
}, payload: Record<string, unknown>, index: number): ChipMatePart | undefined {
  const sourceText = stringValue(payload.sourceText).trim()
  if (!sourceText) return undefined
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((item): item is string => typeof item === "string").slice(0, 20)
    : []
  return {
    id: index === 0 ? `${input.toolCallID}-mermaid` : `${input.toolCallID}-mermaid-${index + 1}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "diagram",
    kind: "mermaid",
    source: "tool",
    displayMode: "artifact",
    toolCallID: input.toolCallID,
    diagramId: stringValue(payload.diagramId),
    title: stringValue(payload.title) || "Mermaid diagram",
    sourceText,
    mmdPath: stringValue(payload.mmdPath),
    absoluteMmdPath: stringValue(payload.absoluteMmdPath),
	    pngPath: stringValue(payload.pngPath),
	    absolutePngPath: stringValue(payload.absolutePngPath),
	    width: numberValue(payload.width),
	    height: numberValue(payload.height),
	    pixelWidth: numberValue(payload.pixelWidth),
	    pixelHeight: numberValue(payload.pixelHeight),
	    scale: numberValue(payload.scale),
	    contentBounds: boundsValue(payload.contentBounds),
	    cropBounds: boundsValue(payload.cropBounds),
	    padding: numberValue(payload.padding),
	    contentCropRatio: numberValue(payload.contentCropRatio),
	    renderProvider: stringValue(payload.renderProvider),
	    fallbackUsed: booleanValue(payload.fallbackUsed),
	    warnings,
  } as ChipMatePart
}

function generatedDocumentPartsFromToolResult(input: {
  sessionID: string
  messageID: string
  toolCallID: string
  tool: string
  result: ToolRuntimeResult
}): GeneratedDocumentExtraction {
  if (input.tool !== "create_word_document") {
    return { parts: [], reason: "not a create_word_document result", payloadCount: 0 }
  }
  if (input.result.status && input.result.status !== "completed") {
    return { parts: [], reason: `tool status ${input.result.status}`, payloadCount: 0 }
  }
  if (!input.result.approved) {
    return { parts: [], reason: "tool result was not approved", payloadCount: 0 }
  }
  const payload = parseToolOutputObject(input.result.output)
  const data = recordValue(payload.data)
  const part = generatedDocumentPartFromPayload(input, data)
  return {
    parts: part ? [part] : [],
    reason: part ? undefined : "create_word_document output did not contain structured data.path",
    payloadCount: Object.keys(data).length ? 1 : 0,
  }
}

function generatedDocumentPartFromPayload(input: {
  sessionID: string
  messageID: string
  toolCallID: string
}, payload: Record<string, unknown>): ChipMatePart | undefined {
  const path = stringValue(payload.path)
  if (!path || !/\.docx$/i.test(path)) return undefined
  const warnings = stringArrayValue(payload.warnings).slice(0, 24)
  const warningCount = numberValue(payload.warningCount) ?? warnings.length
  return {
    id: `${input.toolCallID}-generated-document`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "generatedDocument",
    title: "Generated Word Document",
    path,
    absolutePath: stringValue(payload.absolutePath),
    sourceCount: numberValue(payload.sourceCount),
    warningCount,
    warnings,
    runSummaryPath: stringValue(payload.runSummaryPath),
    toolCallID: input.toolCallID,
  } as ChipMatePart
}

function wordRenderPartsFromToolResult(input: {
  sessionID: string
  messageID: string
  toolCallID: string
  result: ToolRuntimeResult
}): WordRenderExtraction {
  if (input.result.status && input.result.status !== "completed") {
    return { parts: [], reason: `tool status ${input.result.status}`, payloadCount: 0 }
  }
  if (!input.result.approved) {
    return { parts: [], reason: "tool result was not approved", payloadCount: 0 }
  }
  const payloads = wordRenderPayloadsFromArtifacts(input.result)
  if (payloads.length === 0) {
    return { parts: [], reason: "no word render payload in artifacts", payloadCount: 0 }
  }
  const parts = payloads
    .map((payload, index) => wordRenderPartFromPayload(input, payload, index))
    .filter((part): part is ChipMatePart => Boolean(part))
  return {
    parts,
    reason: parts.length ? undefined : "word render payload was incomplete",
    payloadCount: payloads.length,
  }
}

function wordRenderPayloadsFromArtifacts(result: ToolRuntimeResult) {
  const payloads: Record<string, unknown>[] = []
  for (const artifact of result.artifacts ?? []) {
    if (artifact.kind !== "word-render") continue
    const payload = recordValue(artifact.payload)
    if (stringValue(payload.kind) !== "word-render") continue
    payloads.push(payload)
  }
  return payloads
}

function wordRenderPartFromPayload(input: {
  sessionID: string
  messageID: string
  toolCallID: string
}, payload: Record<string, unknown>, index: number): ChipMatePart | undefined {
  const renderCheck = recordValue(payload.renderCheckResult)
  const path = stringValue(payload.path)
  if (!path && Object.keys(renderCheck).length === 0) return undefined
  const pagePngPaths = stringArrayValue(payload.pagePngPaths)
  const summaries = Array.isArray(payload.pageVisualSummaries) ? payload.pageVisualSummaries.slice(0, 8) : []
  const visualQaStatus = stringValue(renderCheck.visualQaStatus)
  const skipReason = stringValue(renderCheck.skipReason)
  const issues = Array.isArray(payload.issues) ? payload.issues.slice(0, 12).map((issue) => {
    const record = recordValue(issue)
    const code = stringValue(record.code)
    const message = stringValue(record.message)
    return [code, message].filter(Boolean).join(": ")
  }).filter(Boolean) : []
  return {
    id: index === 0 ? `${input.toolCallID}-word-render` : `${input.toolCallID}-word-render-${index + 1}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "wordRender",
    title: "Word render QA",
    path,
    absolutePath: stringValue(payload.absolutePath),
    renderArtifactDir: stringValue(payload.renderArtifactDir),
    pdfArtifactPath: stringValue(payload.pdfArtifactPath),
    pagePngPaths,
    pageCount: numberValue(renderCheck.pageCount) ?? pagePngPaths.length,
    attempted: booleanValue(renderCheck.attempted),
    ok: booleanValue(renderCheck.ok),
    visualQaStatus: visualQaStatus === "completed" || visualQaStatus === "skipped" ? visualQaStatus : undefined,
    skipReason: isWordRenderSkipReason(skipReason) ? skipReason : undefined,
    remoteEndpoint: stringValue(renderCheck.remoteEndpoint),
    warnings: issues,
    pageVisualSummaries: summaries,
    visualQaCoverage: pagePngPaths.length ? {
      totalPages: numberValue(renderCheck.pageCount) ?? pagePngPaths.length,
      queuedPages: pagePngPaths.length,
      batchSize: WORD_VISUAL_QA_IMAGES_PER_BATCH,
      batchCount: Math.max(1, Math.ceil(pagePngPaths.length / WORD_VISUAL_QA_IMAGES_PER_BATCH)),
      mode: "pending-image-batches",
    } : visualQaStatus === "skipped" ? {
      totalPages: 0,
      queuedPages: 0,
      batchSize: WORD_VISUAL_QA_IMAGES_PER_BATCH,
      batchCount: 0,
      mode: "skipped",
    } : undefined,
    toolCallID: input.toolCallID,
  } as ChipMatePart
}

function isWordRenderSkipReason(value: string | undefined) {
  return value === "remote-unconfigured"
    || value === "remote-unavailable"
    || value === "remote-invalid-response"
    || value === "artifact-persist-failed"
}

function wordVisualQaArtifactFromPart(part: ChipMatePart, visualEvidenceCount: number, coverage: WordVisualQaPageCoverage[]): WordVisualQaArtifact {
  if (part.type !== "wordRender") {
    return {
      pagePngPaths: [],
      pageCount: 0,
      warnings: [],
      pageVisualSummaries: [],
      visualEvidenceCount,
      coverage,
      batchSize: WORD_VISUAL_QA_IMAGES_PER_BATCH,
      batchCount: 1,
    }
  }
  const record = part as {
    path?: unknown
    pdfArtifactPath?: unknown
    pagePngPaths?: unknown
    pageCount?: unknown
    attempted?: unknown
    ok?: unknown
    warnings?: unknown
    pageVisualSummaries?: unknown
  }
  const pagePngPaths = stringArrayValue(record.pagePngPaths)
  return {
    path: stringValue(record.path),
    pdfArtifactPath: stringValue(record.pdfArtifactPath),
    pagePngPaths,
    pageCount: numberValue(record.pageCount) ?? pagePngPaths.length,
    attempted: booleanValue(record.attempted),
    ok: booleanValue(record.ok),
    warnings: stringArrayValue(record.warnings),
    pageVisualSummaries: Array.isArray(record.pageVisualSummaries) ? record.pageVisualSummaries : [],
    visualEvidenceCount,
    coverage,
    batchSize: WORD_VISUAL_QA_IMAGES_PER_BATCH,
    batchCount: Math.max(1, Math.ceil(Math.max(pagePngPaths.length, coverage.length) / WORD_VISUAL_QA_IMAGES_PER_BATCH)),
  }
}

function consumeWordVisualQaSteering(state: WordVisualQaState): { text: string; images: ChatMessageImageContent[]; artifactCount: number; pages: number[]; renderRound: number } | undefined {
  const batch = state.pendingBatches.shift()
  if (!batch) return undefined
  state.qaBatchCount += 1
  const images = state.imageInputRejected ? [] : batch.images
  return {
    text: wordVisualQaSteeringPrompt({
      batch,
      renderRound: state.renderRoundCount,
      imageCount: images.length,
      imageInputRejected: state.imageInputRejected,
    }),
    images,
    artifactCount: 1,
    pages: batch.pages.map((page) => page.page).filter((page) => page > 0),
    renderRound: state.renderRoundCount,
  }
}

function wordVisualQaSteeringPrompt(input: {
  batch: WordVisualQaBatch
  renderRound: number
  imageCount: number
  imageInputRejected: boolean
}) {
  const pageList = input.batch.pages.map((item) => item.page).filter((page) => page > 0).join(", ") || "none"
  const remaining = input.batch.batchCount - input.batch.batchIndex
  const visualMode = input.imageInputRejected
    ? "The provider rejected image input earlier in this turn, so use only render warnings and pageVisualSummaries. Do not claim page-image visual inspection passed."
    : input.imageCount > 0
      ? `${input.imageCount} rendered page PNG image(s) are attached for visual review. Inspect them before claiming visual QA passed.`
      : "No rendered page PNG image is attached in this checkpoint; use render warnings and pageVisualSummaries only, and disclose that image-level visual inspection was not completed if you deliver."
  return [
    `Word visual QA render round ${input.renderRound}/${MAX_WORD_VISUAL_QA_REPAIR_ROUNDS}, page batch ${input.batch.batchIndex}/${input.batch.batchCount}.`,
    `Pages in this batch: ${pageList}. Remaining batches for this render: ${Math.max(0, remaining)}.`,
    visualMode,
    "Produce a concise WordVisualQaVerdict in your reasoning and then either continue with tools or finalize:",
    "- PASS: if the Word document is acceptable. Final answer should mention the final .docx path and only material warnings.",
    "- NEEDS_FIX: if clipping, blank pages, table overflow, missing image alt text, missing repeated headers, stale fields, bad page breaks, or other material layout/a11y risks are visible. Use inspect_word_document -> apply_word_document_edits -> render_word_document, or regenerate with create_word_document when locator edits are not appropriate.",
    "- BLOCKED: if render dependencies failed or evidence is insufficient. State exactly which visual QA was not completed.",
    "If more Word visual QA batches are requested after this response, review those pages before giving the final document-level visual pass.",
    "Do not expose all intermediate PNG/PDF artifacts unless the user explicitly asks; use them as QA evidence.",
    "Latest Word render evidence:",
    wordVisualQaArtifactSummary(input.batch.artifact, 1, input.batch.pages),
  ].join("\n")
}

function wordVisualQaArtifactSummary(artifact: WordVisualQaArtifact, index: number, batchPages?: WordVisualQaPageCoverage[]) {
  const warnings = artifact.warnings.length ? artifact.warnings.slice(0, 8).join(" | ") : "none"
  const summaries = artifact.pageVisualSummaries.length
    ? truncateString(JSON.stringify(artifact.pageVisualSummaries.slice(0, 4)), 1800)
    : "none"
  const coverage = artifact.coverage.length
    ? artifact.coverage.map((item) => `p${item.page}:${item.status}${item.reason ? `(${truncateString(item.reason, 80)})` : ""}`).join(", ")
    : "none"
  const batchCoverage = batchPages?.length
    ? batchPages.map((item) => `p${item.page}:${item.status}${item.reason ? `(${truncateString(item.reason, 80)})` : ""}`).join(", ")
    : "none"
  return [
    `Artifact ${index}:`,
    `- docx: ${artifact.path || "unknown"}`,
    `- pdf: ${artifact.pdfArtifactPath || "unavailable"}`,
    `- render attempted: ${artifact.attempted === false ? "false" : artifact.attempted === true ? "true" : "unknown"}`,
    `- render ok: ${artifact.ok === false ? "false" : artifact.ok === true ? "true" : "unknown"}`,
    `- pages: ${artifact.pageCount}`,
    `- page PNG artifacts: ${artifact.pagePngPaths.slice(0, 6).join(", ") || "none"}`,
    `- attached visual evidence images: ${artifact.visualEvidenceCount}`,
    `- visual QA coverage ledger: ${coverage}`,
    `- current batch coverage: ${batchCoverage}`,
    `- warnings: ${warnings}`,
    `- pageVisualSummaries: ${summaries}`,
  ].join("\n")
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function logDrawioDiagramExtraction(output: vscode.OutputChannel, tool: string, result: ToolRuntimeResult, extraction: DrawioDiagramExtraction) {
  if (!isDrawioRelevantToolResult(tool, result, extraction)) return
  if (extraction.parts.length > 0) {
    const xmlBytes = extraction.parts.reduce((sum, part) => {
      const xml = typeof (part as { xml?: unknown }).xml === "string" ? (part as { xml: string }).xml : ""
      return sum + textByteLength(xml)
    }, 0)
    const titles = extraction.parts
      .map((part) => truncateString(stringValue((part as { title?: unknown }).title), 80))
      .filter(Boolean)
      .join(" | ")
    output.appendLine(`[drawio-artifact] inserted count=${extraction.parts.length} source=${extraction.source} payloads=${extraction.payloadCount} xmlBytes=${xmlBytes}${titles ? ` titles=${titles}` : ""}`)
    return
  }
  output.appendLine(`[drawio-artifact] skipped reason=${extraction.reason ?? "unknown"} source=${extraction.source} payloads=${extraction.payloadCount} outputBytes=${textByteLength(result.output)} artifacts=${toolArtifactSummary(result)}`)
}

function logMermaidDiagramExtraction(output: vscode.OutputChannel, tool: string, result: ToolRuntimeResult, extraction: MermaidDiagramExtraction) {
  if (!isMermaidRelevantToolResult(tool, result, extraction)) return
  if (extraction.parts.length > 0) {
    const sourceBytes = extraction.parts.reduce((sum, part) => {
      const sourceText = typeof (part as { sourceText?: unknown }).sourceText === "string" ? (part as { sourceText: string }).sourceText : ""
      return sum + textByteLength(sourceText)
    }, 0)
    const titles = extraction.parts
      .map((part) => truncateString(stringValue((part as { title?: unknown }).title), 80))
      .filter(Boolean)
      .join(" | ")
    output.appendLine(`[mermaid-artifact] inserted count=${extraction.parts.length} payloads=${extraction.payloadCount} sourceBytes=${sourceBytes}${titles ? ` titles=${titles}` : ""}`)
    return
  }
  output.appendLine(`[mermaid-artifact] skipped reason=${extraction.reason ?? "unknown"} payloads=${extraction.payloadCount} outputBytes=${textByteLength(result.output)} artifacts=${toolArtifactSummary(result)}`)
}

function logGeneratedDocumentExtraction(output: vscode.OutputChannel, tool: string, result: ToolRuntimeResult, extraction: GeneratedDocumentExtraction) {
  if (!isGeneratedDocumentRelevantToolResult(tool, extraction)) return
  if (extraction.parts.length > 0) {
    const paths = extraction.parts
      .map((part) => truncateString(stringValue((part as { path?: unknown }).path), 120))
      .filter(Boolean)
      .join(" | ")
    output.appendLine(`[generated-document-artifact] inserted count=${extraction.parts.length} payloads=${extraction.payloadCount}${paths ? ` paths=${paths}` : ""}`)
    return
  }
  output.appendLine(`[generated-document-artifact] skipped reason=${extraction.reason ?? "unknown"} payloads=${extraction.payloadCount} outputBytes=${textByteLength(result.output)} artifacts=${toolArtifactSummary(result)}`)
}

function logWordRenderExtraction(output: vscode.OutputChannel, tool: string, result: ToolRuntimeResult, extraction: WordRenderExtraction) {
  if (!isWordRenderRelevantToolResult(tool, result, extraction)) return
  if (extraction.parts.length > 0) {
    const pageCount = extraction.parts.reduce((sum, part) => sum + (numberValue((part as { pageCount?: unknown }).pageCount) ?? 0), 0)
    output.appendLine(`[word-render-artifact] inserted count=${extraction.parts.length} payloads=${extraction.payloadCount} pages=${pageCount}`)
    return
  }
  output.appendLine(`[word-render-artifact] skipped reason=${extraction.reason ?? "unknown"} payloads=${extraction.payloadCount} outputBytes=${textByteLength(result.output)} artifacts=${toolArtifactSummary(result)}`)
}

function isDrawioRelevantToolResult(tool: string, result: ToolRuntimeResult, extraction: DrawioDiagramExtraction) {
  return tool === "chipmate_create_drawio_diagram" ||
    extraction.source !== "none" ||
    (result.artifacts ?? []).some((artifact) => artifact.kind === "drawio") ||
    /^\s*\{[\s\S]*"kind"\s*:\s*"drawio"/.test(result.output)
}

function isMermaidRelevantToolResult(tool: string, result: ToolRuntimeResult, extraction: MermaidDiagramExtraction) {
  return tool === "chipmate_render_mermaid_diagram" ||
    extraction.parts.length > 0 ||
    (result.artifacts ?? []).some((artifact) => artifact.kind === "mermaid")
}

function isGeneratedDocumentRelevantToolResult(tool: string, extraction: GeneratedDocumentExtraction) {
  return tool === "create_word_document" || extraction.parts.length > 0
}

function isWordRenderRelevantToolResult(tool: string, result: ToolRuntimeResult, extraction: WordRenderExtraction) {
  return tool === "render_word_document" ||
    extraction.parts.length > 0 ||
    (result.artifacts ?? []).some((artifact) => artifact.kind === "word-render")
}

function toolResultLogLine(tool: string, result: ToolRuntimeResult, status: string) {
  return `[tool] ${tool} status=${status} approved=${result.approved} outputBytes=${textByteLength(result.output)} artifacts=${toolArtifactSummary(result)}`
}

function toolArtifactSummary(result: ToolRuntimeResult) {
  const artifacts = result.artifacts ?? []
  if (artifacts.length === 0) return "none"
  const counts = new Map<string, number>()
  for (const artifact of artifacts) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(",")
}

function parseToolOutputObject(output: string) {
  try {
    const value = JSON.parse(output) as unknown
    return recordValue(value)
  } catch {
    return {}
  }
}

function evidenceLedgerHistoryMessage(events: SessionEvent[]): ChatMessage | undefined {
  const records = events.flatMap((event) => event.type === "evidence" ? [event.evidence] : [])
  if (records.length === 0) return undefined
  const lines = fitEvidenceLedgerLines(records)
  if (lines.length === 0) return undefined
  return {
    role: "assistant",
    content: [
      "Evidence history",
      "The following is a compact factual ledger of local evidence previously consulted in this same session. It is continuity context only, not a new user request. Treat older evidence as potentially stale and refresh from current files/RAG when making concrete claims.",
      ...lines,
    ].join("\n"),
  }
}

function fitEvidenceLedgerLines(records: EvidenceLedgerRecord[]) {
  const entries = records.flatMap((record) =>
    record.entries.map((entry) => ({
      record,
      entry,
      line: evidenceLedgerLine(record, entry),
    }))
  )
  const selected: string[] = []
  let remaining = MAX_EVIDENCE_LEDGER_HISTORY_BYTES
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entries[index]?.line
    if (!line) continue
    const cost = textByteLength(line) + 1
    if (cost > remaining) break
    selected.unshift(line)
    remaining -= cost
  }
  return selected
}

function evidenceLedgerLine(record: EvidenceLedgerRecord, entry: EvidenceLedgerEntry) {
  const historyStaleness = entry.staleness === "current" ? "unknown" : entry.staleness
  const fragments = [
    `${entry.source}/${entry.kind}: ${entry.summary}`,
    entry.path ? `path=${entry.path}` : "",
    entry.range ? `range=${entry.range}` : "",
    entry.symbol ? `symbol=${entry.symbol}` : "",
    entry.query ? `query=${entry.query}` : "",
    `staleness=${historyStaleness}`,
    entry.truncated ? "truncated=true" : "",
    `message=${record.messageID}`,
  ].filter(Boolean)
  return textHeadByBytes(fragments.join(" · "), MAX_EVIDENCE_LEDGER_LINE_BYTES).trim()
}

function toolExecutionHistoryMessage(events: SessionEvent[]): ChatMessage | undefined {
  const summaries = toolExecutionSummariesFromEvents(events)
  if (summaries.length === 0) return undefined
  const lines = fitToolExecutionSummaryLines(summaries)
  if (lines.length === 0) return undefined
  return {
    role: "assistant",
    content: [
      "Tool execution history",
      "The following is a compact factual ledger of ChipMate tools already executed in this same session. It is continuity context only, not a new user request. Do not replay these tool calls only because they appear here, and do not claim they were not executed.",
      ...lines,
    ].join("\n"),
  }
}

function toolExecutionSummariesFromEvents(events: SessionEvent[]) {
  const summaries: ToolExecutionSummary[] = []
  for (const message of latestSessionMessages(events)) {
    for (const part of message.parts) {
      const summary = toolExecutionSummaryFromPart(message, part)
      if (summary) summaries.push(summary)
    }
  }
  return summaries
}

function toolExecutionSummaryFromPart(message: ChipMateMessage, part: ChipMatePart): ToolExecutionSummary | undefined {
  const partRecord = recordValue(part)
  if (partRecord.type !== "tool") return undefined
  const state = recordValue(partRecord.state)
  const metadata = recordValue(state.metadata)
  const persisted = recordValue(metadata.executionSummary)
  const fallbackTool = stringValue(partRecord.tool) || stringValue(partRecord.name)
  const tool = stringValue(persisted.tool) || fallbackTool
  if (!tool) return undefined
  const status = stringValue(persisted.status) || stringValue(state.status) || "completed"
  const title = stringValue(persisted.title) || stringValue(metadata.title) || tool
  const messageID = stringValue(persisted.messageID) || message.info.id
  const toolCallID = stringValue(persisted.toolCallID) || stringValue(partRecord.id) || stringValue(partRecord.callID)
  const approved = booleanValue(persisted.approved) ?? status === "completed"
  return {
    tool,
    status,
    title,
    risk: stringValue(persisted.risk) || stringValue(metadata.risk) || undefined,
    approved,
    messageID,
    toolCallID,
    at: numberValue(persisted.at) ?? message.info.time?.completed ?? message.info.time?.created ?? 0,
    inputSummary: stringValue(persisted.inputSummary) || summarizeToolArguments(recordValue(state.input)),
    resultSummary: stringValue(persisted.resultSummary) || summarizeToolOutput(state.output, state.error, title, status),
    failureReason: stringValue(persisted.failureReason) || summarizeToolFailure(state.output, state.error, status),
  }
}

function toolExecutionSummaryLine(summary: ToolExecutionSummary, index: number) {
  const fragments = [
    `${index}. ${summary.tool} ${summary.status}: ${summary.resultSummary || summary.title}`,
    summary.inputSummary ? `input=${summary.inputSummary}` : "",
    summary.failureReason ? `failure=${summary.failureReason}` : "",
    summary.risk ? `risk=${summary.risk}` : "",
    summary.approved ? "approved=true" : "approved=false",
  ].filter(Boolean)
  return textHeadByBytes(fragments.join(" · "), MAX_TOOL_EXECUTION_LINE_BYTES).trim()
}

function fitToolExecutionSummaryLines(summaries: ToolExecutionSummary[]) {
  const entries = summaries.map((summary, index) => ({
    summary,
    line: toolExecutionSummaryLine(summary, index + 1),
  }))
  const selected = [...entries]
  const folded = new Map<string, number>()
  while (textByteLength(selected.map((entry) => entry.line).join("\n")) > MAX_TOOL_EXECUTION_HISTORY_BYTES) {
    const foldIndex = selected.findIndex((entry) => isFoldableReadOnlyToolSummary(entry.summary))
    if (foldIndex === -1) break
    const [entry] = selected.splice(foldIndex, 1)
    const key = `${entry.summary.tool} ${entry.summary.status}`
    folded.set(key, (folded.get(key) ?? 0) + 1)
  }
  const lines = selected.map((entry) => entry.line)
  if (folded.size > 0) {
    const foldedText = [...folded.entries()]
      .map(([key, count]) => `${count} ${key}`)
      .join(", ")
    lines.unshift(`Older read/search tool execution summaries compacted to fit context budget: ${foldedText}.`)
  }
  return lines
}

function isFoldableReadOnlyToolSummary(summary: ToolExecutionSummary) {
  if (/create|write|document/i.test(summary.tool)) return false
  return /read|search|inspect|find|map|trace|analyze/i.test(summary.tool)
}

function summarizeToolArguments(args: Record<string, unknown>) {
  const fragments: string[] = []
  const preferredKeys = ["path", "query", "refId", "symbol", "target", "cwd", "url", "method", "bytes", "reason"]
  const seen = new Set<string>()
  for (const key of preferredKeys) {
    const fragment = summarizeToolArgumentField(args, key)
    if (!fragment) continue
    fragments.push(fragment)
    seen.add(key)
  }
  for (const key of Object.keys(args).sort()) {
    if (fragments.length >= 6) break
    if (seen.has(key) || isSensitiveToolArgumentKey(key)) continue
    const fragment = summarizeToolArgumentField(args, key)
    if (fragment) fragments.push(fragment)
  }
  return textHeadByBytes(fragments.join(", "), MAX_TOOL_EXECUTION_LINE_BYTES).trim() || undefined
}

function summarizeToolArgumentField(args: Record<string, unknown>, key: string) {
  if (isSensitiveToolArgumentKey(key)) return ""
  const value = args[key]
  if (typeof value === "string") {
    const normalized = compactSummaryText(value)
    return normalized ? `${key}=${truncateString(normalized, MAX_TOOL_EXECUTION_FIELD_CHARS)}` : ""
  }
  if (typeof value === "number" && Number.isFinite(value)) return `${key}=${value}`
  if (typeof value === "boolean") return `${key}=${value}`
  if (Array.isArray(value)) return `${key}=[${value.length} item${value.length === 1 ? "" : "s"}]`
  if (isRecord(value)) return `${key}={${Object.keys(value).slice(0, 4).join(",")}}`
  return ""
}

function isSensitiveToolArgumentKey(key: string) {
  return /content|body|password|passwd|token|secret|api[_-]?key|authorization|credential/i.test(key)
}

function summarizeToolOutput(output: unknown, error: unknown, title: string, status: string) {
  const outputRecord = parseJsonRecord(output)
  if (outputRecord) {
    const fragments: string[] = []
    const answerSummary = compactSummaryText(stringValue(outputRecord.answerSummary) || stringValue(outputRecord.summary))
    if (answerSummary) fragments.push(answerSummary)
    const path = compactSummaryText(stringValue(outputRecord.path) || stringValue(outputRecord.file))
    if (path) fragments.push(`path=${truncateString(path, MAX_TOOL_EXECUTION_FIELD_CHARS)}`)
    const bytes = numberValue(outputRecord.bytes)
    if (bytes !== undefined) fragments.push(`bytes=${bytes}`)
    const coverage = compactSummaryText(stringValue(outputRecord.coverage))
    if (coverage) fragments.push(`coverage=${truncateString(coverage, MAX_TOOL_EXECUTION_FIELD_CHARS)}`)
    const gaps = summarizeToolGaps(outputRecord.gaps)
    if (gaps) fragments.push(`gaps=${gaps}`)
    if (fragments.length) return truncateString(fragments.join("; "), MAX_TOOL_EXECUTION_FIELD_CHARS * 2)
  }
  const errorText = compactSummaryText(typeof error === "string" ? error : "")
  if (errorText) return truncateString(errorText, MAX_TOOL_EXECUTION_FIELD_CHARS)
  if (status !== "completed" && typeof output === "string") {
    const outputText = compactSummaryText(output)
    if (outputText) return truncateString(outputText, MAX_TOOL_EXECUTION_FIELD_CHARS)
  }
  return truncateString(compactSummaryText(title) || "Tool completed.", MAX_TOOL_EXECUTION_FIELD_CHARS)
}

function summarizeToolFailure(output: unknown, error: unknown, status: string) {
  if (status === "completed") return undefined
  const errorText = compactSummaryText(typeof error === "string" ? error : "")
  if (errorText) return truncateString(errorText, MAX_TOOL_EXECUTION_FIELD_CHARS)
  const outputRecord = parseJsonRecord(output)
  const structuredReason = outputRecord
    ? compactSummaryText(stringValue(outputRecord.error) || stringValue(outputRecord.failureReason) || stringValue(outputRecord.reason))
    : ""
  if (structuredReason) return truncateString(structuredReason, MAX_TOOL_EXECUTION_FIELD_CHARS)
  if (typeof output === "string") {
    const outputText = compactSummaryText(output)
    if (outputText) return truncateString(outputText, MAX_TOOL_EXECUTION_FIELD_CHARS)
  }
  return undefined
}

function summarizeToolGaps(value: unknown) {
  if (typeof value === "string") return truncateString(compactSummaryText(value), MAX_TOOL_EXECUTION_FIELD_CHARS)
  if (Array.isArray(value)) {
    const strings = value
      .flatMap((item) => typeof item === "string" ? [compactSummaryText(item)] : [])
      .filter(Boolean)
    if (strings.length === 0) return `${value.length} item${value.length === 1 ? "" : "s"}`
    const preview = strings.slice(0, 3).join("; ")
    return `${value.length} item${value.length === 1 ? "" : "s"}${preview ? `: ${truncateString(preview, MAX_TOOL_EXECUTION_FIELD_CHARS)}` : ""}`
  }
  return ""
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function compactSummaryText(input: string) {
  return input
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function reusableHistoryMessages(events: SessionEvent[]) {
  return latestSessionMessages(events).flatMap(historyMessageFromSessionMessage)
}

function visualEvidenceForMessage(events: SessionEvent[], messageID: string) {
  const byKey = new Map<string, VisualEvidenceRecord>()
  for (const event of events) {
    if (event.type !== "visual_evidence") continue
    const record = event.visualEvidence
    if (record.messageID !== messageID) continue
    const key = record.diagramId || record.sourceHash || (record.artifactPath && record.page ? `${record.artifactPath}:${record.page}` : undefined) || record.id
    byKey.set(`${record.kind}:${key}`, record)
  }
  return [...byKey.values()].sort((left, right) => left.createdAt - right.createdAt)
}

function latestSessionMessages(events: SessionEvent[]) {
  const order: string[] = []
  const byID = new Map<string, ChipMateMessage>()
  for (const event of events) {
    if (event.type !== "message") continue
    const id = event.message.info.id
    if (!id) continue
    if (!byID.has(id)) order.push(id)
    byID.set(id, event.message)
  }
  return order.flatMap((id) => {
    const message = byID.get(id)
    return message ? [message] : []
  })
}

function userContentForRequest(text: string, images: ChatMessageImageContent[]): ChatMessageContent {
  if (images.length === 0) return text
  return [
    {
      type: "text",
      text,
    },
    ...images,
  ]
}

function chatMessagesHaveImages(messages: ChatMessage[]) {
  return messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")
  )
}

function stripChatMessageImages(messages: ChatMessage[]) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    const text = chatMessageTextContent(message.content).trim()
    message.content = text || null
  }
}

function isVisualInputUnsupportedResponse(status: number, body: string) {
  if (status !== 400 && status !== 415 && status !== 422) return false
  return /\b(?:image_url|image input|vision|multimodal|unsupported image|images? (?:are|is) not supported)\b/i.test(body)
}

function isStreamUsageUnsupportedResponse(status: number, body: string) {
  if (status !== 400 && status !== 422) return false
  return /\b(?:stream_options|include_usage)\b/i.test(body) &&
    /\b(?:unsupported|unknown|invalid|not support|extra fields?|unrecognized|forbidden)\b/i.test(body)
}

function chatCompletionHttpError(response: Response, body: string) {
  const preview = truncateString(body.trim(), 600)
  const summary = `${response.status} ${response.statusText || "HTTP error"}`.trim()
  return new ChatCompletionHttpError(
    `Chat completion failed: ${summary}${preview ? `: ${preview}` : ""}`,
    response.status,
    response.statusText || "HTTP error",
    preview,
    response.headers,
  )
}

async function sleepWithAbort(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  signal?.throwIfAborted()
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function userHistoryTextForTurn(userText: string, historyText: string | undefined, messageMode: string | undefined) {
  const explicit = historyText?.trim()
  if (explicit) return explicit
  if (messageMode === "plugin-chat") return pluginHistoryUserText(userText)
  return extractPluginChatQuestionText(userText) || userText.trim()
}

function firstSessionUserQuestion(events: SessionEvent[]) {
  return reusableHistoryMessages(events).find((message) => message.role === "user")?.content.trim() ?? ""
}

function historyMessageFromSessionMessage(message: ChipMateMessage): ReusableHistoryMessage[] {
  if (message.info.mode === "doc-agent-local") return []
  const role = message.info.role
  if (role !== "user" && role !== "assistant") return []
  if (role === "assistant" && message.info.error) return []
  const text = textParts(message).trim()
  if (!text) return []
  const id = message.info.id
  if (!id) return []
  if (role === "user") {
    const question = extractPluginChatQuestionText(text)
    return question ? [{ id, role: "user", content: question }] : []
  }
  return [{ id, role: "assistant", content: text }]
}

function recentHistoryTurns<T extends ReusableHistoryMessage>(messages: T[], maxTurns: number) {
  const selected: T[] = []
  let turns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
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
    const content = chatMessageTextContent(message?.content)
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

function chatMessageTextContent(content: ChatMessage["content"] | undefined) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n")
}

function latestConversationMemory(events: SessionEvent[]) {
  const memories = events.flatMap((event) => event.type === "memory" ? [event.memory] : [])
  return memories[memories.length - 1]
}

function countHistoryUserTurns(messages: ReusableHistoryMessage[]) {
  return messages.filter((message) => message.role === "user").length
}

function sanitizeEvidenceLedgerEntries(entries: EvidenceLedgerEntry[] | undefined) {
  if (!entries?.length) return []
  return entries
    .map((entry) => sanitizeEvidenceLedgerEntry(entry))
    .filter((entry): entry is EvidenceLedgerEntry => Boolean(entry))
    .slice(0, 80)
}

function sanitizeEvidenceLedgerEntry(entry: EvidenceLedgerEntry): EvidenceLedgerEntry | undefined {
  const summary = sanitizeEvidenceLedgerField(entry.summary, MAX_EVIDENCE_LEDGER_LINE_BYTES)
  if (!summary) return undefined
  const source = sanitizeEvidenceLedgerField(entry.source, MAX_EVIDENCE_LEDGER_FIELD_CHARS) || "unknown"
  const kind = sanitizeEvidenceLedgerField(entry.kind, MAX_EVIDENCE_LEDGER_FIELD_CHARS) || "unknown"
  return {
    source,
    kind,
    path: optionalEvidenceLedgerField(entry.path),
    symbol: optionalEvidenceLedgerField(entry.symbol),
    range: optionalEvidenceLedgerField(entry.range),
    query: optionalEvidenceLedgerField(entry.query),
    summary,
    truncated: Boolean(entry.truncated),
    staleness: entry.staleness === "current" || entry.staleness === "stale" ? entry.staleness : "unknown",
  }
}

function optionalEvidenceLedgerField(value: string | undefined) {
  return value ? sanitizeEvidenceLedgerField(value, MAX_EVIDENCE_LEDGER_FIELD_CHARS) || undefined : undefined
}

function optionalVisualField(value: string | undefined) {
  return value ? truncateString(compactSummaryText(value), 240) || undefined : undefined
}

function positiveInteger(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  return integer > 0 ? integer : undefined
}

function sanitizePngDataUri(value: string) {
  const trimmed = value.trim()
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    throw new Error("Visual evidence image must be a PNG data URI.")
  }
  return trimmed.replace(/\s+/g, "")
}

function pngDataUriByteLength(dataUri: string) {
  const base64 = dataUri.replace(/^data:image\/png;base64,/i, "")
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function sanitizeEvidenceLedgerField(value: string, max: number) {
  return truncateString(compactSummaryText(value), max)
}

function textParts(message: ChipMateMessage) {
  return message.parts
    .flatMap((part) => part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [])
    .join("")
}

function latestSessionRecord(events: SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === "session") return event.session
  }
  return undefined
}

function fallbackSessionDisplayTitle(question: string) {
  return truncateString(normalizeSessionDisplayTitle(question) || "Untitled chat", 80)
}

function normalizeSessionDisplayTitle(input: string) {
  const withoutFence = input
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
  const compact = compactSummaryText(withoutFence)
    .replace(/^[\s"'`*_#>-]+/g, "")
    .replace(/[\s"'`*_#>.,.!?;:，。！？；：、-]+$/g, "")
  if (!compact) return ""
  return truncateString(compact, 80)
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

function replaceAssistantText(assistant: ChipMateMessage, sessionID: string, text: string) {
  const partID = `${assistant.info.id}-text`
  assistant.parts = upsertPart(assistant.parts, {
    id: partID,
    sessionID,
    messageID: assistant.info.id,
    type: "text",
    text,
  })
  return text
}

function createMessage(sessionID: string, role: "user" | "assistant", text: string, mode?: string): ChipMateMessage {
  const id = `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return {
    info: {
      id,
      sessionID,
      role,
      mode,
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

type ModelInfoInput = {
  id: string
  providerIndex?: number
  source: NonNullable<ChipMateModelInfo["source"]>
}

function normalizeModelInfos(models: ModelInfoInput[], defaultModel: string): ChipMateModelInfo[] {
  const order: string[] = []
  const byId = new Map<string, ModelInfoInput>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id) continue
    const existing = byId.get(id)
    if (!existing) {
      order.push(id)
      byId.set(id, { id, providerIndex: model.providerIndex, source: model.source })
      continue
    }
    if (model.source === "provider") {
      existing.source = "provider"
      existing.providerIndex = model.providerIndex
    }
  }
  return order
    .map((id) => byId.get(id)!)
    .map((model) => ({
      id: model.id,
      providerID: "openai-compatible",
      modelID: model.id,
      name: model.id,
      providerName: "OpenAI Compatible",
      isDefault: model.id === defaultModel,
      providerIndex: model.providerIndex,
      source: model.source,
    }))
}

function modelsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return "/models"
  if (/\/models$/i.test(trimmed)) return trimmed
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/models")
  return `${trimmed}/models`
}

function providerConnected(detail: string): HealthResponse {
  return {
    healthy: true,
    state: "connected",
    detail,
    version: DIRECT_PROVIDER_VERSION,
  }
}

function providerAuthFailed(): HealthResponse {
  return {
    healthy: false,
    state: "authFailed",
    detail: "Provider authentication failed. Set a valid ChipMate provider API key.",
    version: DIRECT_PROVIDER_VERSION,
  }
}

function providerProbeFailed(detail: string): HealthResponse {
  return {
    healthy: false,
    state: "error",
    detail,
    version: DIRECT_PROVIDER_VERSION,
  }
}

function isModelsEndpointUnsupported(status: number) {
  return status === 404 || status === 405 || status === 501
}

function isProviderAuthFailure(status: number, body = "") {
  if (status === 401 || status === 403) return true
  return /\b(?:invalid[_ -]?token|invalid[_ -]?api[_ -]?key|unauthorized|forbidden|authentication|permission denied|api key|apikey|bearer)\b/i.test(body)
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
    usage?: ChipMateTokenUsage
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
    result.usage = normalizeProviderTokenUsage((body as { usage?: unknown }).usage)
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

function appendStreamToolArguments(call: ChatToolCall, chunk: string, exposedToolNames: Set<string>) {
  const state = call[TOOL_ARGUMENT_STATE]
  if (state?.truncated && shouldApplyStreamToolArgumentLimit(call.function.name, exposedToolNames)) {
    state.originalBytes = (state.originalBytes ?? textByteLength(call.function.arguments)) + textByteLength(chunk)
    return
  }
  call.function.arguments += chunk
  enforceStreamToolArgumentLimit(call, exposedToolNames)
}

function enforceStreamToolArgumentLimit(call: ChatToolCall, exposedToolNames: Set<string>) {
  if (!shouldApplyStreamToolArgumentLimit(call.function.name, exposedToolNames)) return
  const byteLength = textByteLength(call.function.arguments)
  if (byteLength <= MAX_STREAM_TOOL_ARGUMENT_BYTES) return
  call.function.arguments = truncateString(call.function.arguments, MAX_STREAM_TOOL_ARGUMENT_BYTES)
  call[TOOL_ARGUMENT_STATE] = {
    truncated: true,
    originalBytes: byteLength,
    maxBytes: MAX_STREAM_TOOL_ARGUMENT_BYTES,
  }
}

function shouldApplyStreamToolArgumentLimit(toolName: string, exposedToolNames: Set<string>) {
  if (!toolName || !exposedToolNames.has(toolName)) return false
  return toolName !== "create_word_document"
}

function parseToolArguments(input: string, state?: ToolArgumentState): ToolArgumentParseResult {
  if (state?.truncated) {
    return {
      ok: false,
      errorCode: "tool-arguments-truncated",
      errorMessage: `Tool arguments exceeded the streaming limit: ${state.originalBytes ?? "unknown"} byte(s), maximum ${state.maxBytes ?? MAX_STREAM_TOOL_ARGUMENT_BYTES}.`,
    }
  }
  const text = input.trim()
  if (!text) {
    return {
      ok: false,
      errorCode: "tool-arguments-empty",
      errorMessage: "Tool arguments were empty; expected a JSON object.",
    }
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    return {
      ok: false,
      errorCode: "tool-arguments-invalid-json",
      errorMessage: `Tool arguments were not valid JSON: ${formatErrorMessage(error)}`,
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      errorCode: "tool-arguments-not-object",
      errorMessage: `Tool arguments must be a JSON object. Received ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}.`,
    }
  }
  return { ok: true, args: value as Record<string, unknown> }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : []
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function boundsValue(value: unknown) {
  const record = recordValue(value)
  const width = numberValue(record.width)
  const height = numberValue(record.height)
  if (!width || !height) return undefined
  return {
    x: numberValue(record.x) ?? 0,
    y: numberValue(record.y) ?? 0,
    width,
    height,
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

function quoteLogValue(value: string, maxLength = 240) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\s+/g, " ").slice(0, maxLength)
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))]
}

function chatInterruptedMessage(reason: string) {
  return `对话已中断：${reason}`
}

function goalStatusForTurnError(error: unknown): Extract<ThreadGoalStatus, "blocked" | "usage_limited"> {
  const retry = sessionRetryableError(error)
  const message = `${retry?.message ?? ""} ${formatErrorMessage(error)}`.toLowerCase()
  if (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("too_many_requests") ||
    message.includes("rate limit") ||
    message.includes("resource_exhausted") ||
    message.includes("resource exhausted") ||
    message.includes("usage limit") ||
    message.includes("quota")
  ) {
    return "usage_limited"
  }
  return "blocked"
}

function textByteLength(input: string) {
  return new TextEncoder().encode(input).length
}

function textHeadByBytes(input: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (textByteLength(input) <= maxBytes) return input
  let head = input.slice(0, maxBytes)
  while (head && textByteLength(head) > maxBytes) head = head.slice(0, -1)
  return head
}

function textTailByBytes(input: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (textByteLength(input) <= maxBytes) return input
  let tail = input.slice(Math.max(0, input.length - maxBytes))
  while (tail && textByteLength(tail) > maxBytes) tail = tail.slice(1)
  return tail
}
