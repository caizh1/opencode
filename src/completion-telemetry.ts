import { createHash } from "node:crypto"
import type { CompletionInsertMode, CompletionPlanKind } from "./completion-types"

export type CompletionTelemetryRoute = "fim" | "instruction" | "deterministic-symbol" | "none"

export interface CompletionDebugEvent {
  requestId: string
  languageId: string
  filePathHash?: string
  triggerKind?: string

  planKind: CompletionPlanKind
  insertMode: CompletionInsertMode
  currentWord?: string
  targetSymbol?: string

  symbolCandidates?: Array<{
    name: string
    kind: string
    score: number
    source: string
  }>

  selectedContextBlocks?: Array<{
    kind: string
    title: string
    tokenEstimate: number
    score: number
  }>

  droppedContextBlocks?: Array<{
    kind: string
    title: string
    reason: string
  }>

  modelRoute: CompletionTelemetryRoute
  rawOutputLength?: number
  normalizedOutputLength?: number

  finalRange?: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  }

  filterText?: string
  accepted: boolean
  rejectReason?: string

  latencyMs: {
    planning?: number
    symbol?: number
    context?: number
    model?: number
    postprocess?: number
    edit?: number
    total: number
  }
}

export type CompletionTelemetryDraft = Partial<CompletionDebugEvent> & {
  requestId: string
  languageId: string
  planKind: CompletionPlanKind
  insertMode: CompletionInsertMode
  modelRoute: CompletionTelemetryRoute
  accepted: boolean
  latencyMs: CompletionDebugEvent["latencyMs"]
}

export function createCompletionRequestId() {
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function filePathHash(path: string | undefined) {
  const normalized = (path ?? "").replace(/\\/g, "/")
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`
}

export function completionTelemetryRoute(route: { kind: "none" } | { kind: "deterministic-symbol" } | { kind: "model"; promptKind: "qwen-fim" | "instruction" } | undefined): CompletionTelemetryRoute {
  if (!route) return "none"
  if (route.kind === "none") return "none"
  if (route.kind === "deterministic-symbol") return "deterministic-symbol"
  return route.promptKind === "qwen-fim" ? "fim" : "instruction"
}

export function serializeCompletionDebugEvent(event: CompletionDebugEvent) {
  return `[completion-telemetry] ${JSON.stringify(sanitizeCompletionDebugEvent(event))}`
}

export function sanitizeCompletionDebugEvent(event: CompletionDebugEvent): CompletionDebugEvent {
  return {
    ...event,
    currentWord: event.currentWord ? truncateTelemetryText(event.currentWord, 80) : undefined,
    targetSymbol: event.targetSymbol ? truncateTelemetryText(event.targetSymbol, 120) : undefined,
    symbolCandidates: event.symbolCandidates?.map((candidate) => ({
      name: truncateTelemetryText(candidate.name, 120),
      kind: truncateTelemetryText(candidate.kind, 40),
      score: finiteNumber(candidate.score),
      source: truncateTelemetryText(candidate.source, 40),
    })),
    selectedContextBlocks: event.selectedContextBlocks?.map((block) => ({
      kind: truncateTelemetryText(block.kind, 40),
      title: truncateTelemetryText(block.title, 120),
      tokenEstimate: finiteNumber(block.tokenEstimate),
      score: finiteNumber(block.score),
    })),
    droppedContextBlocks: event.droppedContextBlocks?.map((block) => ({
      kind: truncateTelemetryText(block.kind, 40),
      title: truncateTelemetryText(block.title, 120),
      reason: truncateTelemetryText(block.reason, 80),
    })),
    filterText: event.filterText ? truncateTelemetryText(event.filterText, 160) : undefined,
    rejectReason: event.rejectReason ? truncateTelemetryText(event.rejectReason, 80) : undefined,
    latencyMs: sanitizeLatency(event.latencyMs),
  }
}

export function truncateTelemetryText(input: string, max = 160) {
  const redacted = redactPathLikeText(input).replace(/\r\n/g, "\n")
  const truncated = redacted.length <= max ? redacted : `${redacted.slice(0, max)}...`
  return truncated.replace(/\n/g, "\\n")
}

function redactPathLikeText(input: string) {
  return input
    .replace(/(?:\/[A-Za-z0-9_. -]+){2,}/g, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)+[^\\\r\n]*/g, "[path]")
}

function sanitizeLatency(input: CompletionDebugEvent["latencyMs"]) {
  return {
    ...(input.planning !== undefined ? { planning: finiteNumber(input.planning) } : {}),
    ...(input.symbol !== undefined ? { symbol: finiteNumber(input.symbol) } : {}),
    ...(input.context !== undefined ? { context: finiteNumber(input.context) } : {}),
    ...(input.model !== undefined ? { model: finiteNumber(input.model) } : {}),
    ...(input.postprocess !== undefined ? { postprocess: finiteNumber(input.postprocess) } : {}),
    ...(input.edit !== undefined ? { edit: finiteNumber(input.edit) } : {}),
    total: finiteNumber(input.total),
  }
}

function finiteNumber(input: number) {
  return Number.isFinite(input) ? Math.max(0, Math.round(input)) : 0
}
