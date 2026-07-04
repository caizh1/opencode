import { extractPluginChatQuestionText } from "./chat-session"
import type { ChipMateMessage, EvidenceLedgerEntry, ThreadGoal } from "./types"

export const CONVERSATION_CONTEXT_STATE_VERSION = 1

export type ConversationContextEvent =
  | { type: "session"; session?: MinimalSessionRecord }
  | { type: "message"; message?: ChipMateMessage }
  | { type: "memory"; memory?: ConversationMemorySnapshot }
  | { type: "evidence"; evidence?: EvidenceLedgerSnapshot }
  | { type: "visual_evidence"; visualEvidence?: VisualEvidenceSnapshot }
  | { type: "plan"; plan?: PlanStateSnapshot }
  | { type: "checkpoint"; checkpoint?: CheckpointSnapshot }
  | { type: "rollback"; rollback?: RollbackSnapshot }
  | { type: "world_baseline"; worldBaseline?: WorldStateBaselineSnapshot }
  | { type: "context_compaction"; contextCompaction?: unknown }
  | { type: "context_compaction_lifecycle"; contextCompactionLifecycle?: unknown }
  | { type: string; [key: string]: unknown }

export type MinimalSessionRecord = {
  id?: string
  title?: string
  displayTitle?: string
  time?: {
    created?: number
    updated?: number
  }
}

export type ConversationMemorySnapshot = {
  id?: string
  sessionID?: string
  summary?: string
  coveredMessageIDs?: string[]
  createdAt?: number
  updatedAt?: number
  summaryVersion?: number
}

export type EvidenceLedgerSnapshot = {
  messageID?: string
  createdAt?: number
  entries?: EvidenceLedgerEntry[]
}

export type VisualEvidenceSnapshot = {
  id?: string
  messageID?: string
  kind?: string
  title?: string
  sourceHash?: string
  coverage?: string
  staleness?: "current" | "unknown" | "stale"
  fallbackText?: string
  artifactPath?: string
  page?: number
  createdAt?: number
  mediaType?: string
  byteLength?: number
}

export type WorldStateBaselineSnapshot = {
  id?: string
  workspaceRoot?: string
  gitHead?: string
  gitDirty?: boolean
  settingsHash?: string
  ragIndexVersion?: string
  ragUpdatedAt?: number
  toolVersionHash?: string
  model?: string
  createdAt?: number
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked"

export type PlanStepSnapshot = {
  id?: string
  title?: string
  status?: PlanStepStatus
  evidenceRefs?: string[]
  updatedAt?: number
}

export type PlanStateSnapshot = {
  id?: string
  goalID?: string
  steps?: PlanStepSnapshot[]
  updatedAt?: number
}

export type CheckpointSnapshot = {
  id?: string
  currentStepID?: string
  nextAction?: string
  resumeInstructions?: string
  createdAt?: number
}

export type RollbackSnapshot = {
  id?: string
  reason?: string
  rolledBackMessageIDs?: string[]
  rolledBackTurnIDs?: string[]
  cleanedStateRefs?: string[]
  createdAt?: number
  fullReinjectRequired?: boolean
}

export type ContextStateProvenance = {
  source: "session_event" | "derived" | "unknown"
  eventIndex?: number
  eventType?: string
  sourceEventId?: string
  turnId?: string
  note?: string
}

export type HistoryTranscriptItem = {
  id: string
  role: "user" | "assistant"
  content: string
  visibility: "model-visible" | "omitted"
  omittedReason?: string
  sourceMessageId: string
  mode?: string
  error?: string
  createdAt?: number
  completedAt?: number
  provenance: ContextStateProvenance
}

export type HistoryTranscriptState = {
  version: number
  historyVersion: number
  items: HistoryTranscriptItem[]
  visibleItemCount: number
  omittedItemCount: number
}

export type TranscriptNormalizationDiagnostic = {
  severity: "info" | "warning"
  message: string
  itemId?: string
  provenance: ContextStateProvenance
}

export type TranscriptNormalizationState = {
  diagnostics: TranscriptNormalizationDiagnostic[]
  orphanOutputCount: number
  invalidItemCount: number
  imageFallbackCount: number
}

export type TurnRecapStatus = "success" | "failed" | "aborted" | "tool_failure"

export type TurnRecap = {
  id: string
  sessionID: string
  status: TurnRecapStatus
  userMessageID?: string
  assistantMessageID?: string
  summary: string
  corrections: string[]
  nextActions: string[]
  failureReason?: string
  createdAt: number
  provenance: ContextStateProvenance
}

export type TaskState = {
  goal?: {
    objective: string
    status?: string
    updatedAt?: number
  }
  currentObjective?: string
  nextActions: string[]
  constraints: string[]
  corrections: string[]
  latestFailure?: {
    status: TurnRecapStatus
    reason: string
    sourceMessageId?: string
  }
  turnRecaps: TurnRecap[]
  provenance: ContextStateProvenance
}

export type MemoryState = {
  latestSummary?: string
  coveredMessageIDs: string[]
  summaryVersion?: number
  updatedAt?: number
  provenance?: ContextStateProvenance
}

export type EvidenceFreshness = "current" | "unknown" | "stale"

export type EvidenceStateEntry = EvidenceLedgerEntry & {
  messageID?: string
  freshness: EvidenceFreshness
  freshnessReason?: string
  provenance: ContextStateProvenance
}

export type EvidenceState = {
  entries: EvidenceStateEntry[]
  currentCount: number
  staleCount: number
  unknownCount: number
}

export type VisualEvidenceState = {
  entries: Array<VisualEvidenceSnapshot & {
    staleness: EvidenceFreshness
    coverage?: string
    fallbackText: string
    provenance: ContextStateProvenance
  }>
}

export type WorldStateBaseline = {
  latest?: WorldStateBaselineSnapshot & { provenance: ContextStateProvenance }
  diffRequired: boolean
  fullReinjectRequired: boolean
  reason?: string
  provenance: ContextStateProvenance
}

export type FileStateEntry = {
  path: string
  status: "read" | "written" | "verified" | "stale"
  source: "tool" | "evidence" | "visual" | "unknown"
  summary?: string
  turnId?: string
  provenance: ContextStateProvenance
}

export type FileState = {
  entries: FileStateEntry[]
}

export type VerificationStateEntry = {
  id: string
  status: "passed" | "failed" | "aborted" | "unknown"
  command?: string
  cwd?: string
  summary?: string
  exitCode?: number
  turnId?: string
  provenance: ContextStateProvenance
}

export type VerificationState = {
  entries: VerificationStateEntry[]
}

export type FailureStateEntry = {
  id: string
  status: TurnRecapStatus | "tool_failure"
  reason: string
  attemptedFixes: string[]
  remainingRisk?: string
  retryRule?: string
  turnId?: string
  provenance: ContextStateProvenance
}

export type FailureState = {
  entries: FailureStateEntry[]
  latest?: FailureStateEntry
}

export type PlanStateStep = {
  id: string
  title: string
  status: PlanStepStatus
  evidenceRefs: string[]
  updatedAt?: number
  provenance: ContextStateProvenance
}

export type PlanState = {
  steps: PlanStateStep[]
  activeStepID?: string
  updatedAt?: number
  provenance: ContextStateProvenance
}

export type CheckpointState = {
  latest?: {
    id: string
    currentStepID?: string
    nextAction?: string
    resumeInstructions?: string
    createdAt?: number
    provenance: ContextStateProvenance
  }
}

export type ResumeState = {
  source: "checkpoint" | "goal" | "task_state" | "none"
  instructions: string[]
  fullReinjectRequired: boolean
  provenance: ContextStateProvenance
}

export type RollbackStateEntry = {
  id: string
  reason?: string
  rolledBackMessageIDs: string[]
  rolledBackTurnIDs: string[]
  cleanedStateRefs: string[]
  createdAt?: number
  fullReinjectRequired: boolean
  provenance: ContextStateProvenance
}

export type RollbackState = {
  entries: RollbackStateEntry[]
  latest?: RollbackStateEntry
  fullReinjectRequired: boolean
  rolledBackMessageIDs: string[]
  rolledBackTurnIDs: string[]
}

export type ContextStateDiagnostic = {
  severity: "info" | "warning"
  message: string
  provenance: ContextStateProvenance
}

export type ConversationContextState = {
  version: number
  sessionID: string
  createdAt: number
  updatedAt: number
  transcript: HistoryTranscriptState
  normalization: TranscriptNormalizationState
  task: TaskState
  memory: MemoryState
  evidence: EvidenceState
  visualEvidence: VisualEvidenceState
  file: FileState
  verification: VerificationState
  failure: FailureState
  plan: PlanState
  checkpoint: CheckpointState
  resume: ResumeState
  rollback: RollbackState
  world: WorldStateBaseline
  diagnostics: ContextStateDiagnostic[]
}

export type LegacyPromptAssemblySectionID =
  | "system_prompt"
  | "conversation_memory"
  | "evidence_ledger"
  | "tool_history"
  | "recent_raw_turns"
  | "current_user_content"

export type LegacyPromptAssemblySection = {
  id: LegacyPromptAssemblySectionID
  label: string
  source: string
  position: number
  required: boolean
}

export type LegacyPromptAssemblyBaseline = {
  version: number
  mode: "read-only-fixture"
  sections: LegacyPromptAssemblySection[]
}

export type BuildConversationContextStateInput = {
  sessionID: string
  events: ConversationContextEvent[]
  goal?: ThreadGoal
  turnRecaps?: TurnRecap[]
  now?: number
}

export class ConversationContextManager {
  build(input: BuildConversationContextStateInput): ConversationContextState {
    return buildConversationContextState(input)
  }
}

export function buildLegacyPromptAssemblyBaseline(): LegacyPromptAssemblyBaseline {
  return {
    version: 1,
    mode: "read-only-fixture",
    sections: [
      { id: "system_prompt", label: "System prompt", source: "DirectAgentClient.runTurn system message", position: 0, required: true },
      { id: "conversation_memory", label: "Rolling conversation memory", source: "conversationMemoryContextMessage", position: 1, required: false },
      { id: "evidence_ledger", label: "Evidence ledger history", source: "evidenceLedgerHistoryMessage", position: 2, required: false },
      { id: "tool_history", label: "Tool execution history", source: "toolExecutionHistoryMessage", position: 3, required: false },
      { id: "recent_raw_turns", label: "Recent raw turns", source: "recentChatHistoryMessages recent window", position: 4, required: false },
      { id: "current_user_content", label: "Current user content", source: "DirectAgentClient.runTurn current user message", position: 5, required: true },
    ],
  }
}

export function buildConversationContextState(input: BuildConversationContextStateInput): ConversationContextState {
  const now = input.now ?? Date.now()
  const diagnostics: ContextStateDiagnostic[] = []
  const rollback = buildRollbackState(input.events)
  const transcript = buildHistoryTranscriptState(input.events, diagnostics, rollback)
  const turnRecaps = input.turnRecaps ?? deriveTurnRecapsFromEvents(input.sessionID, input.events)
  const evidence = buildEvidenceState(input.events)
  const visualEvidence = buildVisualEvidenceState(input.events)
  const world = buildWorldStateBaseline(input.events, rollback)
  const verification = filterVerificationStateForRollback(buildVerificationState(input.events, turnRecaps), rollback)
  const failure = filterFailureStateForRollback(buildFailureState(turnRecaps, verification), rollback)
  const plan = buildPlanState(input.goal, turnRecaps, input.events)
  const checkpoint = buildCheckpointState(input.events, plan, turnRecaps)
  return {
    version: CONVERSATION_CONTEXT_STATE_VERSION,
    sessionID: input.sessionID,
    createdAt: firstSessionCreatedAt(input.events) ?? now,
    updatedAt: latestSessionUpdatedAt(input.events) ?? now,
    transcript,
    normalization: buildTranscriptNormalizationState(input.events, transcript, visualEvidence),
    task: buildTaskState(input.goal, turnRecaps),
    memory: buildMemoryState(input.events),
    evidence,
    visualEvidence,
    file: filterFileStateForRollback(buildFileState(input.events, evidence, visualEvidence, verification), rollback),
    verification,
    failure,
    plan,
    checkpoint,
    resume: buildResumeState(input.goal, plan, checkpoint, failure, rollback),
    rollback,
    world,
    diagnostics,
  }
}

export function buildTurnRecap(input: {
  sessionID: string
  userMessage?: ChipMateMessage
  assistantMessage?: ChipMateMessage
  status?: TurnRecapStatus
  now?: number
}): TurnRecap {
  const now = input.now ?? Date.now()
  const status = input.status ?? inferTurnRecapStatus(input.assistantMessage)
  const userText = input.userMessage ? reusableMessageContent(input.userMessage) : ""
  const assistantText = input.assistantMessage ? messageText(input.assistantMessage).trim() : ""
  const failureReason = failureReasonFromMessage(input.assistantMessage, status)
  const corrections = userText ? extractUserCorrections(userText) : []
  return {
    id: `turn-recap:${input.assistantMessage?.info.id ?? input.userMessage?.info.id ?? now}`,
    sessionID: input.sessionID,
    status,
    userMessageID: input.userMessage?.info.id,
    assistantMessageID: input.assistantMessage?.info.id,
    summary: turnRecapSummary(status, userText, assistantText, failureReason),
    corrections,
    nextActions: nextActionsFromTurn(status, userText, failureReason),
    failureReason,
    createdAt: now,
    provenance: {
      source: "derived",
      sourceEventId: input.assistantMessage?.info.id ?? input.userMessage?.info.id,
      turnId: input.userMessage?.info.id ?? input.assistantMessage?.info.id,
      note: "derived from latest user/assistant turn",
    },
  }
}

export function renderTaskStateContext(state: ConversationContextState): string | undefined {
  const lines = [
    "<chipmate-task-state>",
    state.task.currentObjective ? `Current objective: ${state.task.currentObjective}` : "",
    state.task.goal?.status ? `Goal status: ${state.task.goal.status}` : "",
    state.task.corrections.length ? `High-priority user corrections:\n${state.task.corrections.map((item) => `- ${item}`).join("\n")}` : "",
    state.task.latestFailure ? `Latest failure: ${state.task.latestFailure.reason}` : "",
    state.failure.latest ? `FailureState latest: ${state.failure.latest.reason}` : "",
    state.plan.steps.length ? `PlanState:\n${state.plan.steps.slice(0, 6).map(renderPlanLine).join("\n")}` : "",
    state.resume.instructions.length ? `ResumeState (${state.resume.source}):\n${state.resume.instructions.map((item) => `- ${item}`).join("\n")}` : "",
    state.rollback.fullReinjectRequired ? "RollbackState: full initial context reinjection required before continuing." : "",
    renderEvidenceSummary(state.evidence),
    renderWorldSummary(state.world),
    state.visualEvidence.entries.length ? `VisualEvidenceState:\n${state.visualEvidence.entries.slice(-3).map(renderVisualEvidenceLine).join("\n")}` : "",
    state.verification.entries.length ? `VerificationState:\n${state.verification.entries.slice(-3).map(renderVerificationLine).join("\n")}` : "",
    state.file.entries.length ? `FileState:\n${state.file.entries.slice(-5).map(renderFileLine).join("\n")}` : "",
    state.task.nextActions.length ? `Next actions:\n${state.task.nextActions.map((item) => `- ${item}`).join("\n")}` : "",
    "</chipmate-task-state>",
  ].filter(Boolean)
  return lines.length > 2 ? lines.join("\n") : undefined
}

function renderPlanLine(step: PlanStateStep) {
  return `- ${step.id} [${step.status}] ${step.title}`
}

function renderEvidenceSummary(evidence: EvidenceState) {
  if (!evidence.entries.length) return ""
  const stale = evidence.staleCount ? ` stale=${evidence.staleCount}` : ""
  const unknown = evidence.unknownCount ? ` unknown=${evidence.unknownCount}` : ""
  const latest = evidence.entries.slice(-3).map((entry) => {
    const location = entry.path ? ` ${entry.path}` : ""
    return `- ${entry.freshness}${location} - ${entry.summary}`
  }).join("\n")
  return `EvidenceState: current=${evidence.currentCount}${stale}${unknown}\n${latest}`
}

function renderWorldSummary(world: WorldStateBaseline) {
  if (!world.latest) return ""
  const root = world.latest?.workspaceRoot ? ` root=${world.latest.workspaceRoot}` : ""
  const git = world.latest?.gitHead ? ` git=${world.latest.gitHead}` : ""
  const reinject = world.fullReinjectRequired ? " fullReinjectRequired=true" : ""
  const reason = world.reason ? ` reason=${world.reason}` : ""
  return `WorldStateBaseline:${root}${git}${reinject}${reason}`.trim()
}

function renderVisualEvidenceLine(entry: VisualEvidenceState["entries"][number]) {
  const path = entry.artifactPath ? ` ${entry.artifactPath}` : ""
  const coverage = entry.coverage ? ` coverage=${entry.coverage}` : ""
  return `- ${entry.staleness}${path}${coverage} - ${entry.fallbackText}`
}

function renderVerificationLine(entry: VerificationStateEntry) {
  const command = entry.command ? ` ${entry.command}` : ""
  const exit = typeof entry.exitCode === "number" ? ` exit=${entry.exitCode}` : ""
  const summary = entry.summary ? ` - ${entry.summary}` : ""
  return `- ${entry.status}${exit}${command}${summary}`
}

function renderFileLine(entry: FileStateEntry) {
  const summary = entry.summary ? ` - ${entry.summary}` : ""
  return `- ${entry.path} [${entry.status}]${summary}`
}

function buildHistoryTranscriptState(
  events: ConversationContextEvent[],
  diagnostics: ContextStateDiagnostic[],
  rollback: RollbackState,
): HistoryTranscriptState {
  const latestByID = new Map<string, { message: ChipMateMessage; eventIndex: number }>()
  const order: string[] = []
  const rolledBackMessageIDs = new Set(rollback.rolledBackMessageIDs)
  events.forEach((event, eventIndex) => {
    const message = messageFromEvent(event)
    if (!message) {
      if (event.type === "message") {
        diagnostics.push({
          severity: "warning",
          message: "Ignored malformed message event without message id.",
          provenance: provenance(event, eventIndex, undefined, "malformed message"),
        })
        return
      }
      if (!knownEventType(event.type)) {
        diagnostics.push({
          severity: "info",
          message: `Ignored unknown context event type: ${event.type}`,
          provenance: provenance(event, eventIndex, undefined, "unknown event"),
        })
      }
      return
    }
    const id = message.info.id
    if (!id) {
      diagnostics.push({
        severity: "warning",
        message: "Ignored malformed message event without message id.",
        provenance: provenance(event, eventIndex, undefined, "malformed message"),
      })
      return
    }
    if (!latestByID.has(id)) order.push(id)
    latestByID.set(id, { message, eventIndex })
  })

  const items = order.flatMap((id) => {
    const record = latestByID.get(id)
    return record ? [transcriptItemFromMessage(record.message, record.eventIndex, rolledBackMessageIDs)] : []
  })
  return {
    version: CONVERSATION_CONTEXT_STATE_VERSION,
    historyVersion: 1,
    items,
    visibleItemCount: items.filter((item) => item.visibility === "model-visible").length,
    omittedItemCount: items.filter((item) => item.visibility === "omitted").length,
  }
}

function transcriptItemFromMessage(message: ChipMateMessage, eventIndex: number, rolledBackMessageIDs: Set<string>): HistoryTranscriptItem {
  const role = message.info.role
  const id = message.info.id
  const text = messageText(message)
  const base = {
    id: `message:${id}`,
    sourceMessageId: id,
    mode: message.info.mode,
    createdAt: message.info.time?.created,
    completedAt: message.info.time?.completed,
    provenance: provenance({ type: "message", message }, eventIndex, id),
  }
  if (rolledBackMessageIDs.has(id)) {
    return {
      ...base,
      role: role === "user" || role === "assistant" ? role : "assistant",
      content: text,
      visibility: "omitted",
      omittedReason: "message was removed from model-visible history by rollback marker",
    }
  }
  if (role !== "user" && role !== "assistant") {
    return {
      ...base,
      role: "assistant",
      content: text,
      visibility: "omitted",
      omittedReason: "unsupported message role",
    }
  }
  if (message.info.mode === "doc-agent-local") {
    return {
      ...base,
      role,
      content: text,
      visibility: "omitted",
      omittedReason: "local document agent history is not reusable chat transcript",
    }
  }
  if (role === "assistant" && message.info.error) {
    return {
      ...base,
      role,
      content: text,
      visibility: "omitted",
      omittedReason: "assistant error message is not reusable chat transcript",
      error: message.info.error.message,
    }
  }
  const content = role === "user" ? extractPluginChatQuestionText(text) : text.trim()
  if (!content.trim()) {
    return {
      ...base,
      role,
      content: "",
      visibility: "omitted",
      omittedReason: "empty reusable text",
    }
  }
  return {
    ...base,
    role,
    content,
    visibility: "model-visible",
  }
}

function buildTaskState(goal: ThreadGoal | undefined, turnRecaps: TurnRecap[]): TaskState {
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : ""
  const corrections = uniqueStrings(turnRecaps.flatMap((recap) => recap.corrections)).slice(-5)
  const nextActions = uniqueStrings(turnRecaps.flatMap((recap) => recap.nextActions)).slice(-5)
  const latestFailureRecap = [...turnRecaps].reverse().find((recap) => recap.failureReason)
  return {
    goal: objective
      ? {
          objective,
          status: typeof goal?.status === "string" ? goal.status : undefined,
          updatedAt: typeof goal?.updatedAt === "number" ? goal.updatedAt : undefined,
        }
      : undefined,
    currentObjective: objective || undefined,
    nextActions,
    constraints: [],
    corrections,
    latestFailure: latestFailureRecap?.failureReason
      ? {
          status: latestFailureRecap.status,
          reason: latestFailureRecap.failureReason,
          sourceMessageId: latestFailureRecap.assistantMessageID,
        }
      : undefined,
    turnRecaps,
    provenance: {
      source: objective ? "session_event" : "derived",
      eventType: objective ? "goal" : undefined,
      note: objective ? "goal runtime snapshot" : "no active goal snapshot",
    },
  }
}

function deriveTurnRecapsFromEvents(sessionID: string, events: ConversationContextEvent[]) {
  const messages = latestMessagesFromEvents(events)
  const recaps: TurnRecap[] = []
  let latestUser: ChipMateMessage | undefined
  for (const message of messages) {
    if (message.info.role === "user") {
      latestUser = message
      continue
    }
    if (message.info.role === "assistant") {
      recaps.push(buildTurnRecap({
        sessionID,
        userMessage: latestUser,
        assistantMessage: message,
        now: message.info.time?.completed ?? message.info.time?.created,
      }))
    }
  }
  return recaps
}

function latestMessagesFromEvents(events: ConversationContextEvent[]) {
  const order: string[] = []
  const byID = new Map<string, ChipMateMessage>()
  events.forEach((event) => {
    const message = messageFromEvent(event)
    const id = message?.info.id
    if (!message || !id) return
    if (!byID.has(id)) order.push(id)
    byID.set(id, message)
  })
  return order.flatMap((id) => {
    const message = byID.get(id)
    return message ? [message] : []
  })
}

function inferTurnRecapStatus(message: ChipMateMessage | undefined): TurnRecapStatus {
  if (!message) return "aborted"
  if (message.info.error?.message) return isAbortText(message.info.error.message) ? "aborted" : "failed"
  return hasToolFailure(message) ? "tool_failure" : "success"
}

function failureReasonFromMessage(message: ChipMateMessage | undefined, status: TurnRecapStatus) {
  if (status === "success") return undefined
  if (!message) return "turn aborted before assistant response"
  if (message.info.error?.message) return message.info.error.message
  const toolFailure = message.parts.find((part) => part.type === "tool" && isRecord(part.state) && (part.state.status === "failed" || part.state.error))
  if (toolFailure?.type === "tool") {
    const tool = typeof toolFailure.tool === "string" ? toolFailure.tool : "tool"
    const error = isRecord(toolFailure.state) && toolFailure.state.error ? String(toolFailure.state.error) : "tool execution failed"
    return `${tool}: ${error}`
  }
  return status === "aborted" ? "turn aborted" : "turn failed"
}

function hasToolFailure(message: ChipMateMessage) {
  return message.parts.some((part) => part.type === "tool" && isRecord(part.state) && (part.state.status === "failed" || part.state.error))
}

function isAbortText(value: string) {
  return /abort|aborted|cancel|canceled|cancelled|interrupted|中断|取消/i.test(value)
}

function reusableMessageContent(message: ChipMateMessage) {
  const text = messageText(message).trim()
  return message.info.role === "user" ? extractPluginChatQuestionText(text) : text
}

function turnRecapSummary(status: TurnRecapStatus, userText: string, assistantText: string, failureReason: string | undefined) {
  const subject = userText ? truncateForContext(userText, 180) : "turn"
  if (failureReason) return `${status}: ${subject}; ${truncateForContext(failureReason, 180)}`
  const result = assistantText ? truncateForContext(assistantText, 180) : "assistant completed without reusable text"
  return `${status}: ${subject}; ${result}`
}

function nextActionsFromTurn(status: TurnRecapStatus, userText: string, failureReason: string | undefined) {
  if (failureReason) return [`Resolve previous ${status}: ${failureReason}`]
  return []
}

function extractUserCorrections(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines
    .filter((line) => /^(不对|不是|纠正|更正|注意|记住|以后|不要|必须|actually|correction|instead|note)/i.test(line))
    .map((line) => truncateForContext(line, 240))
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function truncateForContext(value: string, max: number) {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact
}

function buildMemoryState(events: ConversationContextEvent[]): MemoryState {
  let latest: { memory: ConversationMemorySnapshot; eventIndex: number } | undefined
  events.forEach((event, eventIndex) => {
    const memory = memoryFromEvent(event)
    if (!memory) return
    if (!latest || (memory.updatedAt ?? 0) >= (latest.memory.updatedAt ?? 0)) {
      latest = { memory, eventIndex }
    }
  })
  return {
    latestSummary: latest?.memory.summary,
    coveredMessageIDs: latest?.memory.coveredMessageIDs ?? [],
    summaryVersion: latest?.memory.summaryVersion,
    updatedAt: latest?.memory.updatedAt,
    provenance: latest ? provenance({ type: "memory", memory: latest.memory }, latest.eventIndex, latest.memory.id) : undefined,
  }
}

function buildEvidenceState(events: ConversationContextEvent[]): EvidenceState {
  const entries: EvidenceState["entries"] = []
  events.forEach((event, eventIndex) => {
    const evidence = evidenceFromEvent(event)
    if (!evidence?.entries) return
    evidence.entries.forEach((entry, entryIndex) => {
      const freshness = evidenceFreshness(entry)
      entries.push({
        ...entry,
        messageID: evidence.messageID,
        freshness,
        freshnessReason: evidenceFreshnessReason(entry, freshness),
        provenance: provenance(event, eventIndex, `${evidence.messageID ?? "unknown"}:${entryIndex}`),
      })
    })
  })
  return {
    entries,
    currentCount: entries.filter((entry) => entry.freshness === "current").length,
    staleCount: entries.filter((entry) => entry.freshness === "stale").length,
    unknownCount: entries.filter((entry) => entry.freshness === "unknown").length,
  }
}

function buildVisualEvidenceState(events: ConversationContextEvent[]): VisualEvidenceState {
  const entries: VisualEvidenceState["entries"] = []
  events.forEach((event, eventIndex) => {
    const visualEvidence = visualEvidenceFromEvent(event)
    if (!visualEvidence) return
    entries.push({
      ...visualEvidence,
      staleness: visualEvidence.staleness ?? "unknown",
      coverage: visualEvidence.coverage,
      fallbackText: visualEvidenceFallbackText(visualEvidence),
      provenance: provenance(event, eventIndex, visualEvidence.id),
    })
  })
  return { entries }
}

function buildWorldStateBaseline(events: ConversationContextEvent[], rollback: RollbackState): WorldStateBaseline {
  let latest: { baseline: WorldStateBaselineSnapshot; eventIndex: number } | undefined
  events.forEach((event, eventIndex) => {
    const baseline = worldBaselineFromEvent(event)
    if (!baseline) return
    if (!latest || (baseline.createdAt ?? 0) >= (latest.baseline.createdAt ?? 0)) {
      latest = { baseline, eventIndex }
    }
  })
  if (!latest) {
    return {
      diffRequired: true,
      fullReinjectRequired: true,
      reason: "missing world baseline",
      provenance: { source: "unknown", note: "world baseline not found" },
    }
  }
  const fullReinjectRequired = rollback.fullReinjectRequired
  return {
    latest: {
      ...latest.baseline,
      provenance: provenance({ type: "world_baseline", worldBaseline: latest.baseline }, latest.eventIndex, latest.baseline.id, "latest world baseline"),
    },
    diffRequired: rollback.entries.length > 0 || latest.baseline.gitDirty === true,
    fullReinjectRequired,
    reason: fullReinjectRequired
      ? "rollback invalidated baseline"
      : latest.baseline.gitDirty
        ? "workspace has dirty git state"
        : undefined,
    provenance: provenance({ type: "world_baseline", worldBaseline: latest.baseline }, latest.eventIndex, latest.baseline.id, "world baseline state"),
  }
}

function buildPlanState(goal: ThreadGoal | undefined, turnRecaps: TurnRecap[], events: ConversationContextEvent[]): PlanState {
  let latest: { plan: PlanStateSnapshot; eventIndex: number } | undefined
  events.forEach((event, eventIndex) => {
    const plan = planFromEvent(event)
    if (!plan) return
    if (!latest || (plan.updatedAt ?? 0) >= (latest.plan.updatedAt ?? 0)) {
      latest = { plan, eventIndex }
    }
  })
  if (latest?.plan.steps?.length) {
    const latestPlan = latest
    const snapshotSteps = latestPlan.plan.steps ?? []
    const steps = snapshotSteps.flatMap((step, index) => {
      const title = typeof step.title === "string" ? step.title.trim() : ""
      if (!title) return []
      const status = isPlanStepStatus(step.status) ? step.status : "pending"
      return [{
        id: step.id ?? `step-${index + 1}`,
        title,
        status,
        evidenceRefs: Array.isArray(step.evidenceRefs) ? step.evidenceRefs.filter((item): item is string => typeof item === "string") : [],
        updatedAt: step.updatedAt,
        provenance: provenance({ type: "plan", plan: latestPlan.plan }, latestPlan.eventIndex, step.id ?? `step-${index + 1}`, "plan snapshot step"),
      }]
    })
    return {
      steps,
      activeStepID: steps.find((step) => step.status === "in_progress")?.id ?? steps.find((step) => step.status === "pending")?.id,
      updatedAt: latestPlan.plan.updatedAt,
      provenance: provenance({ type: "plan", plan: latestPlan.plan }, latestPlan.eventIndex, latestPlan.plan.id, "latest plan snapshot"),
    }
  }
  const derivedSteps = uniqueStrings(turnRecaps.flatMap((recap) => recap.nextActions)).slice(-5).map((action, index) => ({
    id: `derived-next-${index + 1}`,
    title: action,
    status: "pending" as const,
    evidenceRefs: [],
    provenance: {
      source: "derived" as const,
      sourceEventId: turnRecaps[turnRecaps.length - 1]?.id,
      turnId: turnRecaps[turnRecaps.length - 1]?.assistantMessageID ?? turnRecaps[turnRecaps.length - 1]?.userMessageID,
      note: "derived from turn recap next actions",
    },
  }))
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : ""
  const activeGoal = goal
  const goalStep = objective
    ? [{
        id: "goal-objective",
        title: objective,
        status: activeGoal?.status === "complete" ? "completed" as const : "in_progress" as const,
        evidenceRefs: [],
        updatedAt: typeof activeGoal?.updatedAt === "number" ? activeGoal.updatedAt : undefined,
        provenance: {
          source: "session_event" as const,
          eventType: "goal",
          sourceEventId: activeGoal?.goalID,
          note: "derived from active goal runtime",
        },
      }]
    : []
  const steps = [...goalStep, ...derivedSteps]
  return {
    steps,
    activeStepID: steps.find((step) => step.status === "in_progress")?.id ?? steps.find((step) => step.status === "pending")?.id,
    updatedAt: typeof goal?.updatedAt === "number" ? goal.updatedAt : undefined,
    provenance: {
      source: steps.length ? "derived" : "unknown",
      eventType: steps.length ? "goal" : undefined,
      note: steps.length ? "derived from goal and turn recap" : "no plan state available",
    },
  }
}

function buildCheckpointState(events: ConversationContextEvent[], plan: PlanState, turnRecaps: TurnRecap[]): CheckpointState {
  let latest: { checkpoint: CheckpointSnapshot; eventIndex: number } | undefined
  events.forEach((event, eventIndex) => {
    const checkpoint = checkpointFromEvent(event)
    if (!checkpoint) return
    if (!latest || (checkpoint.createdAt ?? 0) >= (latest.checkpoint.createdAt ?? 0)) {
      latest = { checkpoint, eventIndex }
    }
  })
  if (latest) {
    const checkpoint = latest.checkpoint
    return {
      latest: {
        id: checkpoint.id ?? `checkpoint:${latest.eventIndex}`,
        currentStepID: checkpoint.currentStepID,
        nextAction: checkpoint.nextAction,
        resumeInstructions: checkpoint.resumeInstructions,
        createdAt: checkpoint.createdAt,
        provenance: provenance({ type: "checkpoint", checkpoint }, latest.eventIndex, checkpoint.id, "latest checkpoint snapshot"),
      },
    }
  }
  const latestRecap = turnRecaps[turnRecaps.length - 1]
  const nextAction = latestRecap?.nextActions[0] ?? plan.steps.find((step) => step.id === plan.activeStepID)?.title
  if (!nextAction && !plan.activeStepID) return {}
  return {
    latest: {
      id: `checkpoint:derived:${latestRecap?.id ?? plan.activeStepID ?? "none"}`,
      currentStepID: plan.activeStepID,
      nextAction,
      resumeInstructions: "Resume from the active plan step and preserve current task, file, verification, and failure state.",
      createdAt: latestRecap?.createdAt,
      provenance: {
        source: "derived",
        sourceEventId: latestRecap?.id ?? plan.activeStepID,
        turnId: latestRecap?.assistantMessageID ?? latestRecap?.userMessageID,
        note: "derived checkpoint from latest recap and active plan step",
      },
    },
  }
}

function buildResumeState(
  goal: ThreadGoal | undefined,
  plan: PlanState,
  checkpoint: CheckpointState,
  failure: FailureState,
  rollback: RollbackState,
): ResumeState {
  const instructions = uniqueStrings([
    checkpoint.latest?.resumeInstructions,
    checkpoint.latest?.nextAction ? `Next action: ${checkpoint.latest.nextAction}` : undefined,
    plan.activeStepID ? `Continue active plan step: ${plan.activeStepID}` : undefined,
    failure.latest?.reason ? `Address latest failure before claiming completion: ${failure.latest.reason}` : undefined,
    rollback.fullReinjectRequired ? "Rollback occurred; reinject current world/task/file/verification state before continuing." : undefined,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0))
  const source: ResumeState["source"] = checkpoint.latest ? "checkpoint" : goal ? "goal" : plan.steps.length ? "task_state" : "none"
  return {
    source,
    instructions,
    fullReinjectRequired: rollback.fullReinjectRequired,
    provenance: checkpoint.latest?.provenance ?? plan.provenance,
  }
}

function buildRollbackState(events: ConversationContextEvent[]): RollbackState {
  const entries: RollbackStateEntry[] = []
  events.forEach((event, eventIndex) => {
    const rollback = rollbackFromEvent(event)
    if (!rollback) return
    const rolledBackMessageIDs = Array.isArray(rollback.rolledBackMessageIDs)
      ? rollback.rolledBackMessageIDs.filter((item): item is string => typeof item === "string")
      : []
    const rolledBackTurnIDs = Array.isArray(rollback.rolledBackTurnIDs)
      ? rollback.rolledBackTurnIDs.filter((item): item is string => typeof item === "string")
      : []
    const cleanedStateRefs = Array.isArray(rollback.cleanedStateRefs)
      ? rollback.cleanedStateRefs.filter((item): item is string => typeof item === "string")
      : []
    entries.push({
      id: rollback.id ?? `rollback:${eventIndex}`,
      reason: rollback.reason,
      rolledBackMessageIDs,
      rolledBackTurnIDs,
      cleanedStateRefs,
      createdAt: rollback.createdAt,
      fullReinjectRequired: rollback.fullReinjectRequired !== false,
      provenance: provenance({ type: "rollback", rollback }, eventIndex, rollback.id, "rollback marker"),
    })
  })
  const latest = entries[entries.length - 1]
  return {
    entries,
    latest,
    fullReinjectRequired: entries.some((entry) => entry.fullReinjectRequired),
    rolledBackMessageIDs: uniqueStrings(entries.flatMap((entry) => entry.rolledBackMessageIDs)),
    rolledBackTurnIDs: uniqueStrings(entries.flatMap((entry) => entry.rolledBackTurnIDs)),
  }
}

function filterFileStateForRollback(state: FileState, rollback: RollbackState): FileState {
  if (!rollback.entries.length) return state
  const rolledBack = rollbackIDSet(rollback)
  return {
    entries: state.entries.filter((entry) => !stateEntryRolledBack(entry.turnId, entry.provenance, rolledBack)),
  }
}

function filterVerificationStateForRollback(state: VerificationState, rollback: RollbackState): VerificationState {
  if (!rollback.entries.length) return state
  const rolledBack = rollbackIDSet(rollback)
  return {
    entries: state.entries.filter((entry) => !stateEntryRolledBack(entry.turnId, entry.provenance, rolledBack)),
  }
}

function filterFailureStateForRollback(state: FailureState, rollback: RollbackState): FailureState {
  if (!rollback.entries.length) return state
  const rolledBack = rollbackIDSet(rollback)
  const entries = state.entries.filter((entry) => !stateEntryRolledBack(entry.turnId, entry.provenance, rolledBack))
  return { entries, latest: entries[entries.length - 1] }
}

function rollbackIDSet(rollback: RollbackState) {
  return new Set([...rollback.rolledBackMessageIDs, ...rollback.rolledBackTurnIDs])
}

function stateEntryRolledBack(turnId: string | undefined, provenance: ContextStateProvenance, rolledBack: Set<string>) {
  return !!(
    turnId && rolledBack.has(turnId)
    || provenance.turnId && rolledBack.has(provenance.turnId)
    || provenance.sourceEventId && rolledBack.has(provenance.sourceEventId)
  )
}

function buildTranscriptNormalizationState(
  events: ConversationContextEvent[],
  transcript: HistoryTranscriptState,
  visualEvidence: VisualEvidenceState,
): TranscriptNormalizationState {
  const diagnostics: TranscriptNormalizationDiagnostic[] = []
  let orphanOutputCount = 0
  events.forEach((event, eventIndex) => {
    const message = messageFromEvent(event)
    if (!message) return
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "tool") return
      const state = isRecord(part.state) ? part.state : undefined
      const hasOutput = state && ("output" in state || "error" in state || typeof state.status === "string")
      if (hasOutput && !part.callID) {
        orphanOutputCount += 1
        diagnostics.push({
          severity: "warning",
          message: "Tool output has no call id and is omitted from normalized model-visible transcript.",
          itemId: `message:${message.info.id}:tool:${partIndex}`,
          provenance: provenance(event, eventIndex, message.info.id, "orphan tool output"),
        })
      }
      if (isOversizedToolOutput(state?.output)) {
        diagnostics.push({
          severity: "info",
          message: "Tool output is large and requires summarized carryover before model injection.",
          itemId: `message:${message.info.id}:tool:${partIndex}`,
          provenance: provenance(event, eventIndex, message.info.id, "large tool output"),
        })
      }
    })
  })
  transcript.items
    .filter((item) => item.visibility === "omitted")
    .forEach((item) => {
      diagnostics.push({
        severity: "info",
        message: item.omittedReason ?? "Transcript item omitted from model-visible history.",
        itemId: item.id,
        provenance: item.provenance,
      })
    })
  visualEvidence.entries.forEach((entry) => {
    diagnostics.push({
      severity: "info",
      message: "Visual evidence will use artifact summary fallback unless the active model supports image input.",
      itemId: entry.id,
      provenance: entry.provenance,
    })
  })
  return {
    diagnostics,
    orphanOutputCount,
    invalidItemCount: transcript.omittedItemCount,
    imageFallbackCount: visualEvidence.entries.length,
  }
}

function evidenceFreshness(entry: EvidenceLedgerEntry): EvidenceFreshness {
  if (entry.staleness === "current" || entry.staleness === "stale" || entry.staleness === "unknown") return entry.staleness
  return "unknown"
}

function evidenceFreshnessReason(entry: EvidenceLedgerEntry, freshness: EvidenceFreshness) {
  if (freshness === "current") return "evidence ledger marked current"
  if (freshness === "stale") return entry.path ? `evidence for ${entry.path} is stale` : "evidence ledger marked stale"
  return entry.path ? `freshness for ${entry.path} is unknown` : "freshness is unknown"
}

function visualEvidenceFallbackText(visualEvidence: VisualEvidenceSnapshot) {
  if (visualEvidence.fallbackText?.trim()) return truncateForContext(visualEvidence.fallbackText, 240)
  const title = visualEvidence.title?.trim() || visualEvidence.kind?.trim() || "visual artifact"
  const path = visualEvidence.artifactPath ? ` at ${visualEvidence.artifactPath}` : ""
  const page = typeof visualEvidence.page === "number" ? ` page ${visualEvidence.page}` : ""
  const hash = visualEvidence.sourceHash ? ` hash=${visualEvidence.sourceHash}` : ""
  return truncateForContext(`${title}${page}${path}${hash}`, 240)
}

function buildFileState(
  events: ConversationContextEvent[],
  evidence: EvidenceState,
  visualEvidence: VisualEvidenceState,
  verification: VerificationState,
): FileState {
  const entries: FileStateEntry[] = []
  evidence.entries.forEach((entry) => {
    if (!entry.path) return
    entries.push({
      path: entry.path,
      status: entry.staleness === "stale" ? "stale" : "read",
      source: "evidence",
      summary: entry.summary,
      turnId: entry.messageID,
      provenance: entry.provenance,
    })
  })
  visualEvidence.entries.forEach((entry) => {
    if (!entry.artifactPath) return
    entries.push({
      path: entry.artifactPath,
      status: "read",
      source: "visual",
      summary: entry.title,
      turnId: entry.messageID,
      provenance: entry.provenance,
    })
  })
  events.forEach((event, eventIndex) => {
    const message = messageFromEvent(event)
    if (!message) return
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "tool") return
      const state = isRecord(part.state) ? part.state : undefined
      const tool = typeof part.tool === "string" ? part.tool : undefined
      const callID = typeof part.callID === "string" ? part.callID : undefined
      const status = fileStatusFromTool(tool, state)
      const paths = uniqueStrings([
        ...pathsFromUnknown(state?.input),
        ...pathsFromUnknown(state?.output),
        ...pathsFromUnknown(state?.metadata),
      ])
      paths.forEach((path) => {
        entries.push({
          path,
          status,
          source: "tool",
          summary: toolSummary(tool, state),
          turnId: message.info.id,
          provenance: provenance(event, eventIndex, `${message.info.id}:tool:${callID ?? partIndex}`, "tool file state"),
        })
      })
    })
  })
  const verifiedPaths = new Set(verification.entries.filter((entry) => entry.status === "passed").flatMap((entry) => pathsFromUnknown(entry.summary)))
  if (verifiedPaths.size) {
    entries.forEach((entry) => {
      if (verifiedPaths.has(entry.path) && entry.status !== "stale") entry.status = "verified"
    })
  }
  return { entries: dedupeFileEntries(entries) }
}

function buildVerificationState(events: ConversationContextEvent[], turnRecaps: TurnRecap[]): VerificationState {
  const entries: VerificationStateEntry[] = []
  events.forEach((event, eventIndex) => {
    const message = messageFromEvent(event)
    if (!message) return
    message.parts.forEach((part, partIndex) => {
      if (part.type !== "tool") return
      const state = isRecord(part.state) ? part.state : undefined
      const tool = typeof part.tool === "string" ? part.tool : undefined
      const callID = typeof part.callID === "string" ? part.callID : undefined
      const command = firstString([
        ...stringFields(state?.input, ["command", "cmd", "shellCommand"]),
        ...stringFields(state?.output, ["command", "cmd", "shellCommand"]),
        tool && isVerificationToolName(tool) ? tool : undefined,
      ])
      if (!command && !isVerificationToolName(tool)) return
      const exitCode = numberField(state?.output, "exitCode") ?? numberField(state?.metadata, "exitCode")
      const status = verificationStatusFromToolState(state, exitCode)
      entries.push({
        id: `verification:${message.info.id}:${callID ?? partIndex}`,
        status,
        command,
        cwd: firstString([...stringFields(state?.input, ["cwd"]), ...stringFields(state?.output, ["cwd"])]),
        summary: verificationSummary(state),
        exitCode,
        turnId: message.info.id,
        provenance: provenance(event, eventIndex, `${message.info.id}:tool:${callID ?? partIndex}`, "tool verification state"),
      })
    })
  })
  turnRecaps
    .filter((recap) => recap.failureReason && recap.status !== "success")
    .forEach((recap) => {
      entries.push({
        id: `verification:${recap.id}`,
        status: recap.status === "aborted" ? "aborted" : "failed",
        summary: recap.failureReason,
        turnId: recap.assistantMessageID ?? recap.userMessageID,
        provenance: { ...recap.provenance, note: "derived from failed turn recap" },
      })
    })
  return { entries: entries.slice(-20) }
}

function buildFailureState(turnRecaps: TurnRecap[], verification: VerificationState): FailureState {
  const entries: FailureStateEntry[] = []
  turnRecaps
    .filter((recap) => recap.failureReason)
    .forEach((recap) => {
      entries.push({
        id: `failure:${recap.id}`,
        status: recap.status,
        reason: recap.failureReason ?? "turn failed",
        attemptedFixes: recap.nextActions,
        remainingRisk: "Previous failure has not been proven resolved by a later passing verification.",
        retryRule: "Retry only after preserving current task state and relevant tool/file evidence.",
        turnId: recap.assistantMessageID ?? recap.userMessageID,
        provenance: recap.provenance,
      })
    })
  verification.entries
    .filter((entry) => entry.status === "failed" || entry.status === "aborted")
    .forEach((entry) => {
      entries.push({
        id: `failure:${entry.id}`,
        status: entry.status === "aborted" ? "aborted" : "tool_failure",
        reason: entry.summary ?? entry.command ?? "verification failed",
        attemptedFixes: entry.command ? [`Re-run or fix verification command: ${entry.command}`] : [],
        remainingRisk: "Verification has not passed after this failure.",
        retryRule: "Do not claim the related change is verified until a passing verification is recorded.",
        turnId: entry.turnId,
        provenance: entry.provenance,
      })
    })
  const deduped = dedupeFailureEntries(entries).slice(-20)
  return { entries: deduped, latest: deduped[deduped.length - 1] }
}

function isOversizedToolOutput(value: unknown) {
  if (typeof value === "string") return value.length > 8_000
  try {
    return JSON.stringify(value).length > 8_000
  } catch {
    return false
  }
}

function fileStatusFromTool(tool: string | undefined, state: Record<string, unknown> | undefined): FileStateEntry["status"] {
  const toolName = tool?.toLowerCase() ?? ""
  if (state?.error || state?.status === "failed") return "stale"
  if (/write|edit|patch|save|create|delete|rename|move/.test(toolName)) return "written"
  return "read"
}

function pathsFromUnknown(value: unknown): string[] {
  const paths: string[] = []
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 3 || candidate === undefined || candidate === null) return
    if (typeof candidate === "string") {
      paths.push(...pathLikeStrings(candidate))
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1))
      return
    }
    if (!isRecord(candidate)) return
    for (const [key, nested] of Object.entries(candidate)) {
      if (isPathFieldName(key) && typeof nested === "string") {
        paths.push(nested)
        continue
      }
      if (Array.isArray(nested) || isRecord(nested)) visit(nested, depth + 1)
    }
  }
  visit(value, 0)
  return uniqueStrings(paths).filter((path) => path.length <= 512)
}

function pathLikeStrings(value: string) {
  const compact = value.trim()
  if (!compact) return []
  if (compact.length <= 512 && (compact.startsWith("/") || compact.startsWith("./") || compact.startsWith("../") || compact.includes("/"))) {
    return [compact]
  }
  return compact.match(/(?:\/|\.\/|\.\.\/)?[\w.-]+(?:\/[\w .@()[\]-]+)+/g) ?? []
}

function isPathFieldName(key: string) {
  return /^(path|file|filename|targetPath|sourcePath|absolutePath|relativePath|artifactPath|mmdPath|pngPath)$/i.test(key)
}

function toolSummary(tool: string | undefined, state: Record<string, unknown> | undefined) {
  const status = typeof state?.status === "string" ? state.status : undefined
  const error = state?.error ? truncateForContext(String(state.error), 160) : undefined
  return [tool, status, error].filter(Boolean).join(": ")
}

function isVerificationToolName(tool: string | undefined) {
  return !!tool && /terminal|shell|exec|test|lint|compile|package|verify|check/i.test(tool)
}

function verificationStatusFromToolState(state: Record<string, unknown> | undefined, exitCode: number | undefined): VerificationStateEntry["status"] {
  if (typeof exitCode === "number") return exitCode === 0 ? "passed" : "failed"
  if (!state) return "unknown"
  if (state.error || state.status === "failed" || state.status === "error") return "failed"
  if (state.status === "aborted" || state.status === "cancelled" || state.status === "canceled") return "aborted"
  if (state.status === "completed" || state.status === "success" || state.status === "passed") return "passed"
  return "unknown"
}

function verificationSummary(state: Record<string, unknown> | undefined) {
  if (!state) return undefined
  const output = state.output
  const error = state.error
  if (error) return truncateForContext(String(error), 220)
  if (typeof output === "string") return truncateForContext(output, 220)
  if (isRecord(output)) {
    const summary = firstString(stringFields(output, ["summary", "stderr", "stdout", "message"]))
    if (summary) return truncateForContext(summary, 220)
  }
  return typeof state.status === "string" ? state.status : undefined
}

function stringFields(value: unknown, names: string[]) {
  if (!isRecord(value)) return []
  return names.flatMap((name) => typeof value[name] === "string" ? [value[name] as string] : [])
}

function numberField(value: unknown, name: string) {
  if (!isRecord(value)) return undefined
  return typeof value[name] === "number" ? value[name] as number : undefined
}

function firstString(values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())?.trim()
}

function dedupeFileEntries(entries: FileStateEntry[]) {
  const byKey = new Map<string, FileStateEntry>()
  entries.forEach((entry) => {
    byKey.set(`${entry.path}:${entry.status}:${entry.source}`, entry)
  })
  return [...byKey.values()].slice(-50)
}

function dedupeFailureEntries(entries: FailureStateEntry[]) {
  const byKey = new Map<string, FailureStateEntry>()
  entries.forEach((entry) => {
    byKey.set(`${entry.status}:${entry.reason}:${entry.turnId ?? ""}`, entry)
  })
  return [...byKey.values()]
}

function firstSessionCreatedAt(events: ConversationContextEvent[]) {
  return events.flatMap((event) => {
    const session = sessionFromEvent(event)
    return typeof session?.time?.created === "number" ? [session.time.created] : []
  })[0]
}

function latestSessionUpdatedAt(events: ConversationContextEvent[]) {
  const values = events.flatMap((event) => {
    const session = sessionFromEvent(event)
    return typeof session?.time?.updated === "number" ? [session.time.updated] : []
  })
  return values.length ? values[values.length - 1] : undefined
}

function knownEventType(type: string) {
  return type === "session"
    || type === "message"
    || type === "memory"
    || type === "evidence"
    || type === "visual_evidence"
    || type === "plan"
    || type === "checkpoint"
    || type === "rollback"
    || type === "world_baseline"
    || type === "context_compaction"
    || type === "context_compaction_lifecycle"
}

function provenance(event: ConversationContextEvent, eventIndex: number, sourceEventId?: string, note?: string): ContextStateProvenance {
  return {
    source: "session_event",
    eventIndex,
    eventType: event.type,
    sourceEventId,
    turnId: sourceEventId,
    note,
  }
}

function messageText(message: ChipMateMessage) {
  return message.parts
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("")
}

function sessionFromEvent(event: ConversationContextEvent): MinimalSessionRecord | undefined {
  return event.type === "session" && "session" in event && isRecord(event.session) ? event.session as MinimalSessionRecord : undefined
}

function messageFromEvent(event: ConversationContextEvent): ChipMateMessage | undefined {
  return event.type === "message" && "message" in event && isChipMateMessage(event.message) ? event.message : undefined
}

function memoryFromEvent(event: ConversationContextEvent): ConversationMemorySnapshot | undefined {
  return event.type === "memory" && "memory" in event && isRecord(event.memory) ? event.memory as ConversationMemorySnapshot : undefined
}

function evidenceFromEvent(event: ConversationContextEvent): EvidenceLedgerSnapshot | undefined {
  return event.type === "evidence" && "evidence" in event && isRecord(event.evidence) ? event.evidence as EvidenceLedgerSnapshot : undefined
}

function visualEvidenceFromEvent(event: ConversationContextEvent): VisualEvidenceSnapshot | undefined {
  return event.type === "visual_evidence" && "visualEvidence" in event && isRecord(event.visualEvidence) ? event.visualEvidence as VisualEvidenceSnapshot : undefined
}

function planFromEvent(event: ConversationContextEvent): PlanStateSnapshot | undefined {
  return event.type === "plan" && "plan" in event && isRecord(event.plan) ? event.plan as PlanStateSnapshot : undefined
}

function checkpointFromEvent(event: ConversationContextEvent): CheckpointSnapshot | undefined {
  return event.type === "checkpoint" && "checkpoint" in event && isRecord(event.checkpoint) ? event.checkpoint as CheckpointSnapshot : undefined
}

function rollbackFromEvent(event: ConversationContextEvent): RollbackSnapshot | undefined {
  return event.type === "rollback" && "rollback" in event && isRecord(event.rollback) ? event.rollback as RollbackSnapshot : undefined
}

function worldBaselineFromEvent(event: ConversationContextEvent): WorldStateBaselineSnapshot | undefined {
  return event.type === "world_baseline" && "worldBaseline" in event && isRecord(event.worldBaseline)
    ? event.worldBaseline as WorldStateBaselineSnapshot
    : undefined
}

function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked"
}

function isChipMateMessage(value: unknown): value is ChipMateMessage {
  if (!isRecord(value)) return false
  return isRecord(value.info) && Array.isArray(value.parts)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
