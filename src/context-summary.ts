import type { CompactionState, ContextCompactionEventRecord } from "./context-compaction"
import type { ContextPackBudgetReport } from "./context-pack"
import type { ChatContextWindowResolution } from "./context-window"
import type { ConversationContextState } from "./conversation-context"

export type ContextSummarySeverity = "ok" | "info" | "warning" | "error"

export type ContextSummarySection = {
  id: string
  label: string
  severity: ContextSummarySeverity
  value: string
  detail?: string
  included?: number
  truncated?: number
  omitted?: number
}

export type ContextSummarySnapshot = {
  version: number
  generatedAt: number
  sections: ContextSummarySection[]
  fallbackNotice?: string
  compactWarning?: string
  rollbackWarning?: string
}

export function buildContextSummarySnapshot(input: {
  state?: ConversationContextState
  budgetReport?: ContextPackBudgetReport
  contextWindow?: ChatContextWindowResolution
  compaction?: CompactionState | ContextCompactionEventRecord
  now?: number
}): ContextSummarySnapshot {
  const sections: ContextSummarySection[] = []
  const now = input.now ?? Date.now()
  const contextWindow = input.contextWindow ?? input.budgetReport?.contextWindow
  if (input.state) sections.push(...conversationStateSections(input.state))
  if (input.budgetReport) sections.push(budgetSection(input.budgetReport))
  if (contextWindow) sections.push(contextWindowSection(contextWindow))
  if (input.compaction) sections.push(compactionSection(input.compaction, now))
  return {
    version: 1,
    generatedAt: now,
    sections,
    fallbackNotice: contextWindow?.fallbackNotice,
    compactWarning: input.compaction ? compactWarning(input.compaction) : undefined,
    rollbackWarning: input.state?.rollback.fullReinjectRequired
      ? "Rollback requires full initial context reinjection before continuing."
      : undefined,
  }
}

function conversationStateSections(state: ConversationContextState): ContextSummarySection[] {
  return [
    {
      id: "task",
      label: "Task",
      severity: state.failure.latest ? "warning" : "ok",
      value: state.task.currentObjective || "No active task objective",
      detail: state.failure.latest?.reason,
      included: state.task.turnRecaps.length,
    },
    {
      id: "plan",
      label: "Plan",
      severity: state.plan.steps.some((step) => step.status === "blocked") ? "warning" : "info",
      value: state.plan.activeStepID ? `Active step: ${state.plan.activeStepID}` : "No active plan step",
      detail: state.plan.steps.map((step) => `${step.id}:${step.status}`).join(", "),
      included: state.plan.steps.length,
    },
    {
      id: "files",
      label: "Files",
      severity: state.file.entries.some((entry) => entry.status === "stale") ? "warning" : "info",
      value: `${state.file.entries.length} tracked`,
      detail: state.file.entries.slice(-5).map((entry) => `${entry.path} [${entry.status}]`).join(", "),
      included: state.file.entries.length,
    },
    {
      id: "verification",
      label: "Verification",
      severity: state.verification.entries.some((entry) => entry.status === "failed" || entry.status === "aborted") ? "warning" : "info",
      value: `${state.verification.entries.length} checks`,
      detail: state.verification.entries.slice(-3).map((entry) => `${entry.status}: ${entry.command ?? entry.summary ?? entry.id}`).join(", "),
      included: state.verification.entries.length,
    },
    {
      id: "evidence",
      label: "Evidence",
      severity: state.evidence.staleCount ? "warning" : state.evidence.unknownCount ? "info" : "ok",
      value: `current=${state.evidence.currentCount} stale=${state.evidence.staleCount} unknown=${state.evidence.unknownCount}`,
      detail: state.evidence.entries.slice(-5).map((entry) => `${entry.freshness}: ${entry.path ?? entry.kind}`).join(", "),
      included: state.evidence.entries.length,
    },
    {
      id: "visual",
      label: "Visual",
      severity: state.visualEvidence.entries.some((entry) => entry.staleness === "stale") ? "warning" : "info",
      value: `${state.visualEvidence.entries.length} artifacts`,
      detail: state.visualEvidence.entries.slice(-3).map((entry) => `${entry.staleness}: ${entry.fallbackText}`).join(", "),
      included: state.visualEvidence.entries.length,
    },
    {
      id: "world",
      label: "World",
      severity: state.world.fullReinjectRequired || state.world.diffRequired ? "warning" : "ok",
      value: state.world.fullReinjectRequired ? "Full reinject required" : state.world.diffRequired ? "Diff inject required" : "Baseline current",
      detail: state.world.reason ?? state.world.latest?.workspaceRoot,
    },
  ]
}

function budgetSection(report: ContextPackBudgetReport): ContextSummarySection {
  const truncatedSections = report.sections.filter((section) => section.truncated).length
  return {
    id: "budget",
    label: "Budget",
    severity: report.truncated ? "warning" : "ok",
    value: `${report.totalEstimatedTokens}/${report.contextWindow.effectiveContextWindow} tokens`,
    detail: report.reason,
    included: report.sections.length,
    truncated: truncatedSections,
    omitted: report.omittedMessages,
  }
}

function contextWindowSection(contextWindow: ChatContextWindowResolution): ContextSummarySection {
  return {
    id: "window",
    label: "Window",
    severity: contextWindow.source === "fallback_default" ? "warning" : "ok",
    value: `${contextWindow.modelContextWindow} tokens`,
    detail: contextWindow.fallbackNotice ?? `source=${contextWindow.source}; safety=${contextWindow.safetyMarginTokens}`,
  }
}

function compactionSection(compaction: CompactionState | ContextCompactionEventRecord, now: number): ContextSummarySection {
  const persistent = persistentCompactionFields(compaction, now)
  const duration = persistent.durationMs !== undefined ? `duration=${persistent.durationMs}ms` : ""
  const age = persistent.summaryAgeMs !== undefined ? `summaryAge=${formatDuration(persistent.summaryAgeMs)}` : ""
  const implementation = persistent.implementation ? `implementation=${persistent.implementation}` : ""
  const strategy = persistent.strategy ? `strategy=${persistent.strategy}` : ""
  const phase = persistent.phase ? `phase=${persistent.phase}` : ""
  const reason = persistent.reason ? `reason=${persistent.reason}` : ""
  const historyVersion = persistent.historyVersion ? `historyVersion=${persistent.historyVersion}` : ""
  const sourceWindow = persistent.sourceWindow ? `sourceWindow=${persistent.sourceWindow}` : ""
  const failure = compaction.failureReason ? `failure=${compaction.failureReason}` : ""
  const fallback = compaction.fallbackReason ? `fallback=${compaction.fallbackReason}` : ""
  const tokenDelta = `tokens=${compaction.beforeTokens}->${compaction.afterTokens}`
  const retained = `retained=${compaction.retainedMessageIds.length}`
  const omitted = `omitted=${compaction.omittedMessageCount}`
  const reinject = `reinject=${compaction.initialContextReinjection}`
  const window = `window=${compaction.window.modelContextWindow}/${compaction.window.effectiveContextWindow}`
  return {
    id: "compact",
    label: "Compact",
    severity: compaction.status === "fallback_pruned" || compaction.status === "failed" || compaction.status === "interrupted" ? "warning" : "info",
    value: `${compaction.trigger} ${compaction.status}`,
    detail: [
      strategy,
      implementation,
      phase,
      reason,
      historyVersion,
      age,
      duration,
      retained,
      omitted,
      tokenDelta,
      window,
      sourceWindow,
      reinject,
      failure,
      fallback,
    ].filter(Boolean).join("; "),
    included: compaction.retainedMessageIds.length,
    omitted: compaction.omittedMessageCount,
  }
}

function compactWarning(compaction: CompactionState | ContextCompactionEventRecord) {
  if (compaction.status === "failed") return `Compact failed; using existing request context without replacement history.${compaction.failureReason ? ` ${compaction.failureReason}` : ""}`
  if (compaction.status === "fallback_pruned") return "Context was pruned before a compact replacement history could be applied."
  if (compaction.status === "interrupted") return "Context compact was interrupted; continuing with the previous context state."
  if (compaction.status === "completed") return "Context has been compacted. Long sessions and repeated compactions can reduce accuracy; continue carefully or start a new session for a clean context."
  return compaction.trigger === "soft_threshold" ? "Context is approaching compact threshold." : undefined
}

function persistentCompactionFields(compaction: CompactionState | ContextCompactionEventRecord, now: number) {
  if (!("historyVersion" in compaction)) return {}
  const completedAt = typeof compaction.completedAt === "number" ? compaction.completedAt : undefined
  const durationMs = completedAt !== undefined ? Math.max(0, completedAt - compaction.createdAt) : undefined
  return {
    implementation: compaction.implementation,
    strategy: compaction.strategy,
    phase: compaction.phase,
    reason: compaction.reason,
    historyVersion: compaction.historyVersion,
    sourceWindow: compaction.sourceWindow,
    durationMs,
    summaryAgeMs: completedAt !== undefined ? Math.max(0, now - completedAt) : undefined,
  }
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
