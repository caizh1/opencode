import type { CompletionCandidatePipelineResult } from "./completion-candidate-pipeline"
import type { CompletionEdit, CompletionRange, CompletionSelectedCompletionInfo } from "./completion-edit"
import type { RetrievedCompletionSnippet } from "./completion-types"

export type CompletionQualityTriggerKind = "automatic" | "manual"

export type CompletionQualityCheck =
  | "edit-contract"
  | "syntax-format"
  | "intent-match"
  | "project-context"
  | "auto-show"
  | "stability"
  | "latency"
  | "selected-completion-info"
  | "cache-hit"
  | "stale-key"
  | "retry"
  | "manual-trigger"
  | "fast-typing"
  | "no-duplicate-prefix"
  | "no-hallucinated-api"

export type CompletionQualityFixture = {
  id: string
  category?: string
  languageId: string
  filePath: string
  document: string
  openTabs?: CompletionQualityOpenTab[]
  selectedCompletionInfo?: CompletionSelectedCompletionInfo
  triggerKind: CompletionQualityTriggerKind
  expectedIntent: string
  mustContain: string[]
  mustNotContain: string[]
  contextMustContain?: string[]
  maxLines: number
  checks: CompletionQualityCheck[]
  retrievedSnippets?: RetrievedCompletionSnippet[]
  modelOutputs?: string[]
  retryModelOutputs?: string[]
  simulatedLatencyMs?: number[]
}

export type CompletionQualityOpenTab = {
  path: string
  languageId: string
  text: string
}

export type CompletionQualityGate = "auto show" | "manual only" | "reject"

export type CompletionQualityIssueKind =
  | "intent mismatch"
  | "project context miss"
  | "bad edit contract"
  | "too long"
  | "hallucinated API"
  | "duplicate prefix"
  | "unstable output"
  | "syntax/format risk"
  | "latency risk"
  | "auto-show risk"

export type CompletionQualityIssue = {
  kind: CompletionQualityIssueKind
  message: string
}

export type CompletionQualityScoreBreakdown = {
  editContract: number
  syntaxFormat: number
  intentMatch: number
  projectContext: number
  autoShowSuitability: number
  stability: number
  latency: number
}

export type CompletionQualityScore = {
  qualityScore: number
  gate: CompletionQualityGate
  breakdown: CompletionQualityScoreBreakdown
  issues: CompletionQualityIssue[]
}

export type CompletionQualityScoreInput = {
  fixture: CompletionQualityFixture
  outcome: CompletionCandidatePipelineResult
  acceptedText: string
  appliedText: string
  linePrefix: string
  lineSuffix: string
  edit?: CompletionEdit
  repeatAcceptedTexts: string[]
  repeatDecisions: string[]
  latencyMs: number
  selectedContextText: string
  interactionReasons?: string[]
}

const SCORE_WEIGHTS = {
  editContract: 15,
  syntaxFormat: 15,
  intentMatch: 20,
  projectContext: 20,
  autoShowSuitability: 15,
  stability: 10,
  latency: 5,
} as const

export function scoreCompletionQuality(input: CompletionQualityScoreInput): CompletionQualityScore {
  const issues: CompletionQualityIssue[] = []
  const editContract = scoreEditContract(input, issues)
  const syntaxFormat = scoreSyntaxFormat(input, issues)
  const intentMatch = scoreIntentMatch(input, issues)
  const projectContext = scoreProjectContext(input, issues)
  const autoShowSuitability = scoreAutoShowSuitability(input, issues)
  const stability = scoreStability(input, issues)
  const latency = scoreLatency(input, issues)
  const breakdown = {
    editContract,
    syntaxFormat,
    intentMatch,
    projectContext,
    autoShowSuitability,
    stability,
    latency,
  }
  const qualityScore = Math.max(0, Math.min(100, Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0))))
  return {
    qualityScore,
    gate: gateForScore(qualityScore),
    breakdown,
    issues: uniqueIssues(issues),
  }
}

export function gateForScore(score: number): CompletionQualityGate {
  if (score >= 85) return "auto show"
  if (score >= 70) return "manual only"
  return "reject"
}

function scoreEditContract(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  let score = SCORE_WEIGHTS.editContract
  if (input.outcome.decision !== "accepted" || !input.edit) {
    issues.push({
      kind: "bad edit contract",
      message: input.outcome.rejectionReason ?? "completion did not produce a VS Code inline edit",
    })
    return 0
  }

  if (input.edit.replaceRange && input.edit.replaceRange.startLine !== input.edit.replaceRange.endLine) {
    score -= 5
    issues.push({ kind: "bad edit contract", message: "replaceRange crosses lines" })
  }
  const rangeText = input.edit.replaceRange ? currentLineRangeText(input, input.edit.replaceRange) : ""
  const filterText = input.edit.filterText ?? input.edit.insertText
  if (!filterText.startsWith(rangeText)) {
    score -= 4
    issues.push({ kind: "bad edit contract", message: "filterText does not preserve replaced range text" })
  }
  if (input.fixture.selectedCompletionInfo) {
    if (!input.edit.replaceRange || !sameRange(input.edit.replaceRange, input.fixture.selectedCompletionInfo.range)) {
      score -= 4
      issues.push({ kind: "bad edit contract", message: "selectedCompletionInfo range was not honored" })
    }
    if (!input.edit.insertText.startsWith(input.fixture.selectedCompletionInfo.text)) {
      score -= 3
      issues.push({ kind: "bad edit contract", message: "selectedCompletionInfo text is not a prefix of insertText" })
    }
  }
  if (hasDuplicatePrefixRisk(input)) {
    score -= 3
    issues.push({ kind: "duplicate prefix", message: "accepted text appears to repeat the current line prefix" })
  }
  return clampScore(score, SCORE_WEIGHTS.editContract)
}

function scoreSyntaxFormat(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  let score = SCORE_WEIGHTS.syntaxFormat
  const lines = completionLineCount(input.acceptedText)
  if (lines > input.fixture.maxLines) {
    score -= 5
    issues.push({ kind: "too long", message: `insertText has ${lines} lines, max is ${input.fixture.maxLines}` })
  }
  if (/```|^Here(?:'s| is)\b|^The completion\b|^Explanation\b/im.test(input.acceptedText)) {
    score -= 4
    issues.push({ kind: "syntax/format risk", message: "completion contains markdown or explanatory prose" })
  }
  if (startsWithMisalignedBlankLine(input)) {
    score -= 3
    issues.push({ kind: "syntax/format risk", message: "completion starts with a blank line outside a block context" })
  }
  if (!hasReasonableDelimiterBalance(input.acceptedText)) {
    score -= 3
    issues.push({ kind: "syntax/format risk", message: "completion has suspicious delimiter balance" })
  }
  return clampScore(score, SCORE_WEIGHTS.syntaxFormat)
}

function scoreIntentMatch(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  let score = SCORE_WEIGHTS.intentMatch
  const missing = input.fixture.mustContain.filter((value) => !contains(input.appliedText, value))
  if (missing.length > 0) {
    score -= Math.min(14, missing.length * 7)
    issues.push({ kind: "intent mismatch", message: `missing required text: ${missing.join(", ")}` })
  }
  const forbidden = input.fixture.mustNotContain.filter((value) => contains(input.appliedText, value) || contains(input.acceptedText, value))
  if (forbidden.length > 0) {
    score -= Math.min(8, forbidden.length * 4)
    for (const value of forbidden) {
      issues.push({ kind: "hallucinated API", message: `forbidden text appeared: ${value}` })
    }
  }
  if (input.outcome.decision !== "accepted") {
    score -= 6
    issues.push({ kind: "intent mismatch", message: "completion was rejected before intent could be satisfied" })
  }
  return clampScore(score, SCORE_WEIGHTS.intentMatch)
}

function scoreProjectContext(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  const needsContext = input.fixture.checks.includes("project-context") ||
    Boolean(input.fixture.retrievedSnippets?.length) ||
    Boolean(input.fixture.openTabs?.length) ||
    Boolean(input.fixture.contextMustContain?.length)
  if (!needsContext) return SCORE_WEIGHTS.projectContext

  let score = SCORE_WEIGHTS.projectContext
  const contextNeedles = input.fixture.contextMustContain ?? []
  const missingApplied = contextNeedles.filter((value) => !contains(input.appliedText, value))
  if (missingApplied.length > 0) {
    score -= Math.min(12, missingApplied.length * 6)
    issues.push({ kind: "project context miss", message: `accepted text missed project context: ${missingApplied.join(", ")}` })
  }
  const missingPacked = contextNeedles.filter((value) => !contains(input.selectedContextText, value))
  if (missingPacked.length > 0 && input.fixture.openTabs?.length) {
    score -= Math.min(4, missingPacked.length * 2)
    issues.push({ kind: "project context miss", message: `context pack did not select: ${missingPacked.join(", ")}` })
  }
  if (!input.selectedContextText.trim() && (input.fixture.retrievedSnippets?.length || input.fixture.openTabs?.length)) {
    score -= 4
    issues.push({ kind: "project context miss", message: "no project context was selected" })
  }
  return clampScore(score, SCORE_WEIGHTS.projectContext)
}

function scoreAutoShowSuitability(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  let score = SCORE_WEIGHTS.autoShowSuitability
  if (input.outcome.decision !== "accepted") {
    issues.push({ kind: "auto-show risk", message: "rejected completions should not auto-show" })
    return 0
  }
  const lines = completionLineCount(input.acceptedText)
  if (input.fixture.triggerKind === "automatic" && lines > Math.max(6, input.fixture.maxLines)) {
    score -= 5
    issues.push({ kind: "auto-show risk", message: "automatic trigger produced a large block" })
  }
  if (input.fixture.triggerKind === "automatic" && input.outcome.reasons.some((reason) => reason.startsWith("fallback:"))) {
    score -= 3
    issues.push({ kind: "auto-show risk", message: "automatic trigger needed fallback text" })
  }
  if (input.fixture.triggerKind === "manual" && lines > input.fixture.maxLines) {
    score -= 3
  }
  return clampScore(score, SCORE_WEIGHTS.autoShowSuitability)
}

function scoreStability(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  const distinctText = new Set(input.repeatAcceptedTexts.map(normalizeStableText))
  const distinctDecisions = new Set(input.repeatDecisions)
  if (distinctText.size <= 1 && distinctDecisions.size <= 1) return SCORE_WEIGHTS.stability

  issues.push({
    kind: "unstable output",
    message: `repeat run produced ${distinctText.size} text variants and ${distinctDecisions.size} decisions`,
  })
  if (distinctDecisions.size > 1) return 0
  return Math.floor(SCORE_WEIGHTS.stability / 2)
}

function scoreLatency(input: CompletionQualityScoreInput, issues: CompletionQualityIssue[]) {
  if (input.latencyMs <= 120) return SCORE_WEIGHTS.latency
  if (input.latencyMs <= 350) return 3
  issues.push({ kind: "latency risk", message: `latency ${input.latencyMs}ms exceeds interactive budget` })
  return input.latencyMs <= 700 ? 1 : 0
}

function currentLineRangeText(input: CompletionQualityScoreInput, range: CompletionRange) {
  if (range.startLine !== range.endLine) return ""
  return `${input.linePrefix}${input.lineSuffix}`.slice(range.startCharacter, range.endCharacter)
}

function sameRange(left: CompletionRange, right: CompletionRange) {
  return left.startLine === right.startLine &&
    left.startCharacter === right.startCharacter &&
    left.endLine === right.endLine &&
    left.endCharacter === right.endCharacter
}

function hasDuplicatePrefixRisk(input: CompletionQualityScoreInput) {
  const prefix = input.linePrefix.trim()
  if (prefix.length < 3) return false
  const firstLine = firstLineOf(input.acceptedText).trim()
  if (firstLine === prefix) return true
  return firstLine.startsWith(`${prefix} ${prefix}`) || firstLine.startsWith(`${prefix}${prefix}`)
}

function startsWithMisalignedBlankLine(input: CompletionQualityScoreInput) {
  if (!/^[ \t]*\r?\n/.test(input.acceptedText)) return false
  const trimmedPrefix = input.linePrefix.trimEnd()
  if (!trimmedPrefix) return false
  return !/(?:[:{]|=>)$/.test(trimmedPrefix)
}

function hasReasonableDelimiterBalance(input: string) {
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]]
  return pairs.every(([open, close]) => {
    const delta = charCount(input, open) - charCount(input, close)
    return delta >= -2 && delta <= 3
  })
}

function charCount(input: string, char: string) {
  return [...input].filter((item) => item === char).length
}

function completionLineCount(input: string) {
  if (!input) return 0
  return input.replace(/\r\n/g, "\n").split("\n").length
}

function firstLineOf(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
}

function contains(input: string, value: string) {
  return input.includes(value)
}

function normalizeStableText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function clampScore(value: number, max: number) {
  return Math.max(0, Math.min(max, value))
}

function uniqueIssues(issues: CompletionQualityIssue[]) {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.kind}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
