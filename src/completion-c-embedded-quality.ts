import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CompletionCandidateDecision } from "./completion-candidate-pipeline"
import type { CompletionEdit, CompletionRange, CompletionSelectedCompletionInfo } from "./completion-edit"
import type { RetrievedCompletionSnippet } from "./completion-types"

export const C_EMBEDDED_CHECKERS = [
  "checkVscodeContract",
  "checkApplyEditResult",
  "checkCParseOrCompile",
  "checkNoMarkdownOrExplanation",
  "checkNoPlaceholder",
  "checkNoDangerousC",
  "checkNoHallucinatedSymbol",
  "checkIntentMatch",
  "checkEmbeddedSafety",
  "checkProjectStyle",
  "checkStability",
  "checkLatency",
] as const

export type CEmbeddedQualityCheck = typeof C_EMBEDDED_CHECKERS[number]
export type CEmbeddedTriggerKind = "automatic" | "manual"
export type CEmbeddedQualityGate = "auto show" | "manual only" | "reject"

export type CEmbeddedOpenTab = {
  path: string
  languageId: string
  text: string
}

export type CEmbeddedCompletionFixture = {
  id: string
  category: string
  languageId: string
  path: string
  document: string
  openTabs?: CEmbeddedOpenTab[]
  selectedCompletionInfo?: CompletionSelectedCompletionInfo
  triggerKind: CEmbeddedTriggerKind
  expectedIntent: string
  mustContain: string[]
  mustContainAny?: string[][]
  mustNotContain: string[]
  maxLines: number
  checks: CEmbeddedQualityCheck[]
  contextMustContain?: string[]
  allowedSymbols?: string[]
  retrievedSnippets?: RetrievedCompletionSnippet[]
  modelOutputs?: string[]
  retryModelOutputs?: string[]
  simulatedLatencyMs?: number[]
}

export type CEmbeddedQualityDimension =
  | "vscodeEditContract"
  | "cSyntaxFormat"
  | "embeddedSemantics"
  | "projectContext"
  | "safety"
  | "autoShowSuitability"
  | "stability"
  | "latency"

export type CEmbeddedQualityIssueKind =
  | "planner disabled"
  | "bad edit contract"
  | "apply edit failure"
  | "C parse/compile"
  | "syntax/format risk"
  | "too long"
  | "markdown/explanation"
  | "placeholder"
  | "dangerous C"
  | "unsafe buffer"
  | "ISR blocking"
  | "busy loop"
  | "missing volatile"
  | "unaligned packet cast"
  | "hallucinated API"
  | "intent mismatch"
  | "embedded safety"
  | "project context miss"
  | "project style"
  | "auto-show risk"
  | "unstable output"
  | "latency risk"

export type CEmbeddedQualitySeverity = "minor" | "major" | "critical"

export type CEmbeddedQualityIssue = {
  kind: CEmbeddedQualityIssueKind
  message: string
  checker: CEmbeddedQualityCheck
  dimension: CEmbeddedQualityDimension
  severity: CEmbeddedQualitySeverity
  hardReject?: boolean
}

export type CEmbeddedQualityScoreBreakdown = Record<CEmbeddedQualityDimension, number>

export type CEmbeddedQualityScore = {
  qualityScore: number
  gate: CEmbeddedQualityGate
  breakdown: CEmbeddedQualityScoreBreakdown
  issues: CEmbeddedQualityIssue[]
}

export type CEmbeddedQualityScoreInput = {
  fixture: CEmbeddedCompletionFixture
  decision: CompletionCandidateDecision
  rejectionReason?: string
  acceptedText: string
  appliedText: string
  originalText: string
  linePrefix: string
  lineSuffix: string
  edit?: CompletionEdit
  repeatAcceptedTexts: string[]
  repeatDecisions: CompletionCandidateDecision[]
  latencyMs: number
  selectedContextText: string
}

type CheckerInput = CEmbeddedQualityScoreInput

const SCORE_WEIGHTS: CEmbeddedQualityScoreBreakdown = {
  vscodeEditContract: 10,
  cSyntaxFormat: 15,
  embeddedSemantics: 20,
  projectContext: 15,
  safety: 15,
  autoShowSuitability: 10,
  stability: 10,
  latency: 5,
}

const ISSUE_DEDUCTIONS: Record<CEmbeddedQualitySeverity, number> = {
  minor: 2,
  major: 6,
  critical: 15,
}

const C_KEYWORDS = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "bool",
  "true",
  "false",
])

const SAFE_KNOWN_CALLS = new Set([
  "memcpy",
  "memmove",
  "memset",
  "memcmp",
  "snprintf",
  "sizeof",
  "MIN",
  "MAX",
  "ARRAY_SIZE",
  "container_of",
  "offsetof",
])

const SAFE_KNOWN_SYMBOLS = new Set([
  "NULL",
  "BIT",
  "ARRAY_SIZE",
  "MIN",
  "MAX",
  "HAL_OK",
  "HAL_ERR",
  "HAL_TIMEOUT",
  "pdPASS",
  "pdTRUE",
  "pdFALSE",
])

let clangAvailability: boolean | undefined

export function scoreCEmbeddedCompletionQuality(input: CEmbeddedQualityScoreInput): CEmbeddedQualityScore {
  const issues = uniqueIssues(runSelectedChecks(input))
  const breakdown = { ...SCORE_WEIGHTS }
  for (const issue of issues) {
    breakdown[issue.dimension] = Math.max(
      0,
      breakdown[issue.dimension] - Math.min(SCORE_WEIGHTS[issue.dimension], ISSUE_DEDUCTIONS[issue.severity]),
    )
  }

  const qualityScore = Math.max(0, Math.min(100, Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0))))
  return {
    qualityScore,
    gate: gateForCEmbeddedScore(qualityScore, issues),
    breakdown,
    issues,
  }
}

export function gateForCEmbeddedScore(score: number, issues: CEmbeddedQualityIssue[] = []): CEmbeddedQualityGate {
  if (issues.some((issue) => issue.hardReject)) return "reject"
  if (score >= 85) return "auto show"
  if (score >= 70) return "manual only"
  return "reject"
}

export function checkVscodeContract(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  if (input.decision !== "accepted" || !input.edit) {
    const reason = input.rejectionReason ?? "completion did not produce a VS Code inline edit"
    if (isPlannerDisabledReason(reason)) {
      issues.push(issue("planner disabled", "planner disabled / coverage miss", "checkVscodeContract", "embeddedSemantics", "critical", true))
    } else {
      issues.push(issue("bad edit contract", reason, "checkVscodeContract", "vscodeEditContract", "critical", true))
    }
    return issues
  }

  const range = input.edit.replaceRange
  if (range && range.startLine !== range.endLine) {
    issues.push(issue("bad edit contract", "replaceRange crosses lines", "checkVscodeContract", "vscodeEditContract", "major", true))
  }

  const replaced = range ? currentLineRangeText(input, range) : ""
  const filterText = input.edit.filterText ?? input.edit.insertText
  if (replaced && !filterText.startsWith(replaced)) {
    issues.push(issue("bad edit contract", "filterText does not preserve replaced range text", "checkVscodeContract", "vscodeEditContract", "major"))
  }

  if (input.fixture.selectedCompletionInfo) {
    const selected = input.fixture.selectedCompletionInfo
    if (!range || !sameRange(range, selected.range)) {
      issues.push(issue("bad edit contract", "selectedCompletionInfo range was not honored", "checkVscodeContract", "vscodeEditContract", "major", true))
    }
    if (!input.edit.insertText.startsWith(selected.text)) {
      issues.push(issue("bad edit contract", "selectedCompletionInfo text is not a prefix of insertText", "checkVscodeContract", "vscodeEditContract", "major", true))
    }
  }

  if (hasDuplicatePrefixRisk(input)) {
    issues.push(issue("bad edit contract", "accepted text appears to repeat the current line prefix", "checkVscodeContract", "vscodeEditContract", "major"))
  }

  return issues
}

export function checkApplyEditResult(input: CheckerInput): CEmbeddedQualityIssue[] {
  if (input.decision !== "accepted" || !input.edit) return []
  const issues: CEmbeddedQualityIssue[] = []
  if (input.appliedText.includes("<|cursor|>")) {
    issues.push(issue("apply edit failure", "applied document still contains the cursor marker", "checkApplyEditResult", "vscodeEditContract", "critical", true))
  }
  if (input.acceptedText && input.appliedText === input.originalText) {
    issues.push(issue("apply edit failure", "accepted edit did not change the document", "checkApplyEditResult", "vscodeEditContract", "major", true))
  }
  if (input.acceptedText && !input.appliedText.includes(firstNonEmptyLine(input.acceptedText))) {
    issues.push(issue("apply edit failure", "applied document does not contain accepted edit text", "checkApplyEditResult", "vscodeEditContract", "major"))
  }
  return issues
}

export function checkCParseOrCompile(input: CheckerInput): CEmbeddedQualityIssue[] {
  if (input.decision !== "accepted" || !input.appliedText.trim()) return []
  const hardReject = input.fixture.triggerKind === "automatic"
  const staticIssue = cStaticSyntaxIssue(input.appliedText)
  if (staticIssue) {
    return [issue("C parse/compile", staticIssue, "checkCParseOrCompile", "cSyntaxFormat", "major", hardReject)]
  }
  if (!clangAvailable()) return []

  const dir = mkdtempSync(join(tmpdir(), "opencode-c-eval-"))
  const file = join(dir, "fixture.c")
  try {
    writeFileSync(file, sanitizeCompileUnit(compileUnitText(input)))
    execFileSync("clang", [
      "-fsyntax-only",
      "-x",
      "c",
      "-std=c11",
      "-Wno-implicit-function-declaration",
      "-Wno-unused-value",
      file,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    })
    return []
  } catch (error) {
    const message = clangErrorMessage(error)
    if (/file not found|No such file or directory/.test(message)) return []
    return [issue("C parse/compile", message || "clang rejected the applied C document", "checkCParseOrCompile", "cSyntaxFormat", "major", hardReject)]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function checkNoMarkdownOrExplanation(input: CheckerInput): CEmbeddedQualityIssue[] {
  if (!/```|^\s*(?:Here(?:'s| is)|Explanation|The completion|Below is|Sure\b|Answer:)/im.test(input.acceptedText)) return []
  return [issue("markdown/explanation", "completion contains markdown or explanatory prose", "checkNoMarkdownOrExplanation", "cSyntaxFormat", "critical", true)]
}

export function checkNoPlaceholder(input: CheckerInput): CEmbeddedQualityIssue[] {
  const matches = ["TODO", "Add your implementation", "your implementation", "placeholder", "your code here"]
    .filter((value) => value && containsFold(input.acceptedText, value))
  if (!matches.length) return []
  return matches.map((value) =>
    issue("placeholder", `placeholder text appeared: ${value}`, "checkNoPlaceholder", "safety", "critical", true))
}

export function checkNoDangerousC(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  if (/\b(?:sprintf|strcpy|strcat|gets)\s*\(/.test(input.acceptedText)) {
    issues.push(issue("unsafe buffer", "unsafe C library call appeared: sprintf/strcpy/strcat/gets", "checkNoDangerousC", "safety", "critical", true))
  }
  if (isDriverOrIsrContext(input) && /\bprintf\s*\(/.test(input.acceptedText)) {
    issues.push(issue("dangerous C", "printf appeared in driver/ISR layer", "checkNoDangerousC", "safety", "critical", true))
  }
  if (hasUnboundedBufferWrite(input.acceptedText)) {
    issues.push(issue("unsafe buffer", "buffer write or copy lacks a visible bounds check", "checkNoDangerousC", "safety", "critical", true))
  }
  return issues
}

export function checkNoHallucinatedSymbol(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  const known = knownProjectSymbols(input)
  const forbidden = input.fixture.mustNotContain.filter((value) => containsForbiddenText(input, value))
  for (const value of forbidden) {
    if (isProjectForbiddenPattern(value) && knownProjectSymbolsContainPattern(known, value)) continue
    issues.push(issue("hallucinated API", `forbidden text appeared: ${value}`, "checkNoHallucinatedSymbol", "projectContext", "critical", true))
  }

  if (input.fixture.checks.includes("checkNoHallucinatedSymbol")) {
    const hardRejectUnknown = input.fixture.triggerKind === "automatic"
    for (const symbol of unknownProjectSymbols(input.acceptedText, known)) {
      issues.push(issue("hallucinated API", `unknown project symbol is not present in context: ${symbol}`, "checkNoHallucinatedSymbol", "projectContext", "critical", hardRejectUnknown))
    }

    for (const call of callNames(input.acceptedText)) {
      if (known.has(call) || SAFE_KNOWN_CALLS.has(call) || SAFE_KNOWN_SYMBOLS.has(call) || C_KEYWORDS.has(call)) continue
      if (/^(?:test_|mock_|stub_)/.test(call)) continue
      if (/^(?:vTask|xQueue|xSemaphore|xTimer|xEventGroup|port|task|os)/.test(call)) continue
      if (/^(?:[a-z]+_)?(?:init|deinit|read|write|start|stop|enable|disable|reset|handle|parse|poll|lock|unlock)$/.test(call)) continue
      if (looksLikeProjectApiSymbol(call) || /[A-Z]{2,}\d{2,}|(?:fake|unknown|nonexistent|invented)/i.test(call)) {
        issues.push(issue("hallucinated API", `unknown call is not present in project context: ${call}`, "checkNoHallucinatedSymbol", "projectContext", "critical", hardRejectUnknown))
      }
    }
  }

  return issues
}

function containsForbiddenText(input: CheckerInput, value: string) {
  if (isProjectForbiddenPattern(value)) {
    return input.acceptedText.includes(value) || input.appliedText.includes(value)
  }
  return containsFold(input.acceptedText, value) || containsFold(input.appliedText, value)
}

function isProjectForbiddenPattern(value: string) {
  return /^(?:NONEXISTENT_|FAKE_|UNKNOWN_|HAL_UARTX|GPIOZ|USART99|I2C99|SPI99|invented_)/.test(value)
}

function knownProjectSymbolsContainPattern(known: Set<string>, value: string) {
  for (const symbol of known) {
    if (symbol === value || symbol.startsWith(value)) return true
  }
  return false
}

export function checkIntentMatch(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  const missing = input.fixture.mustContain.filter((value) => !containsFold(input.appliedText, value))
  for (const value of missing) {
    issues.push(issue("intent mismatch", `missing required text: ${value}`, "checkIntentMatch", "embeddedSemantics", "major"))
  }

  for (const group of input.fixture.mustContainAny ?? []) {
    if (group.some((value) => containsFold(input.appliedText, value))) continue
    issues.push(issue("intent mismatch", `missing any required alternative: ${group.join(" | ")}`, "checkIntentMatch", "embeddedSemantics", "major"))
  }

  if (input.decision !== "accepted") {
    issues.push(issue("intent mismatch", "completion was rejected before intent could be satisfied", "checkIntentMatch", "embeddedSemantics", "major"))
  }
  return issues
}

export function checkEmbeddedSafety(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  if (isIsrContext(input) && hasBlockingCall(input.acceptedText)) {
    issues.push(issue("ISR blocking", "ISR completion contains a blocking API", "checkEmbeddedSafety", "embeddedSemantics", "critical", true))
  }
  if (/\bwhile\s*\(\s*1\s*\)/.test(input.acceptedText) && !/\b(?:timeout|deadline|yield|vTaskDelay|osDelay|xQueueReceive|ulTaskNotifyTake|break|return)\b/.test(input.acceptedText)) {
    issues.push(issue("busy loop", "while(1) loop has no timeout, yield, blocking wait, break, or return", "checkEmbeddedSafety", "embeddedSemantics", "critical", true))
  }
  if (needsVolatile(input) && losesVolatile(input.acceptedText)) {
    issues.push(issue("missing volatile", "MMIO/register access is missing volatile qualification", "checkEmbeddedSafety", "embeddedSemantics", "critical", true))
  }
  if (hasUnalignedPacketCast(input.acceptedText)) {
    issues.push(issue("unaligned packet cast", "packet buffer is directly cast to a structured pointer", "checkEmbeddedSafety", "embeddedSemantics", "critical", true))
  }
  return issues
}

export function checkProjectStyle(input: CheckerInput): CEmbeddedQualityIssue[] {
  const issues: CEmbeddedQualityIssue[] = []
  const contextNeedles = input.fixture.contextMustContain ?? []
  const missingApplied = contextNeedles.filter((value) => !containsFold(input.appliedText, value))
  for (const value of missingApplied) {
    issues.push(issue("project context miss", `accepted text missed project context: ${value}`, "checkProjectStyle", "projectContext", "major"))
  }
  const missingPacked = contextNeedles.filter((value) => !containsFold(input.selectedContextText, value))
  for (const value of missingPacked) {
    issues.push(issue("project context miss", `context pack did not select: ${value}`, "checkProjectStyle", "projectContext", "minor"))
  }
  if (/\t/.test(input.acceptedText)) {
    issues.push(issue("project style", "completion uses tabs instead of the four-space style used by fixtures", "checkProjectStyle", "projectContext", "minor"))
  }
  return issues
}

export function checkStability(input: CheckerInput): CEmbeddedQualityIssue[] {
  const distinctText = new Set(input.repeatAcceptedTexts.map(normalizeStableText))
  const distinctDecisions = new Set(input.repeatDecisions)
  if (distinctText.size <= 1 && distinctDecisions.size <= 1) return []
  return [
    issue(
      "unstable output",
      `repeat run produced ${distinctText.size} text variants and ${distinctDecisions.size} decisions`,
      "checkStability",
      "stability",
      distinctDecisions.size > 1 ? "critical" : "major",
      distinctDecisions.size > 1,
    ),
  ]
}

export function checkLatency(input: CheckerInput): CEmbeddedQualityIssue[] {
  if (input.latencyMs <= 350) return []
  return [
    issue(
      "latency risk",
      `latency ${input.latencyMs}ms exceeds interactive budget`,
      "checkLatency",
      "latency",
      input.latencyMs > 700 ? "major" : "minor",
    ),
  ]
}

function runSelectedChecks(input: CEmbeddedQualityScoreInput) {
  const selected = new Set<CEmbeddedQualityCheck>(input.fixture.checks)
  const checks: Array<[CEmbeddedQualityCheck, (input: CheckerInput) => CEmbeddedQualityIssue[]]> = [
    ["checkVscodeContract", checkVscodeContract],
    ["checkApplyEditResult", checkApplyEditResult],
    ["checkCParseOrCompile", checkCParseOrCompile],
    ["checkNoMarkdownOrExplanation", checkNoMarkdownOrExplanation],
    ["checkNoPlaceholder", checkNoPlaceholder],
    ["checkNoDangerousC", checkNoDangerousC],
    ["checkNoHallucinatedSymbol", checkNoHallucinatedSymbol],
    ["checkIntentMatch", checkIntentMatch],
    ["checkEmbeddedSafety", checkEmbeddedSafety],
    ["checkProjectStyle", checkProjectStyle],
    ["checkStability", checkStability],
    ["checkLatency", checkLatency],
  ]
  const issues = checks.flatMap(([name, checker]) => selected.has(name) ? checker(input) : [])

  const lineCount = completionLineCount(input.acceptedText)
  if (lineCount > input.fixture.maxLines) {
    issues.push(issue("too long", `insertText has ${lineCount} lines, max is ${input.fixture.maxLines}`, "checkCParseOrCompile", "cSyntaxFormat", "major"))
  }
  if (input.decision === "accepted" && input.fixture.triggerKind === "automatic" && lineCount > Math.max(4, input.fixture.maxLines)) {
    issues.push(issue("auto-show risk", "automatic trigger produced a large block", "checkVscodeContract", "autoShowSuitability", "major"))
  } else if (input.fixture.triggerKind === "manual" && lineCount > input.fixture.maxLines) {
    issues.push(issue("auto-show risk", "manual trigger exceeded fixture maxLines", "checkVscodeContract", "autoShowSuitability", "minor"))
  }

  return issues
}

function isPlannerDisabledReason(reason: string) {
  return reason === "disabled-plan" || reason === "plan:disabled-plan" || reason.includes("plan:disabled-plan")
}

function issue(
  kind: CEmbeddedQualityIssueKind,
  message: string,
  checker: CEmbeddedQualityCheck,
  dimension: CEmbeddedQualityDimension,
  severity: CEmbeddedQualitySeverity,
  hardReject = false,
): CEmbeddedQualityIssue {
  return { kind, message, checker, dimension, severity, hardReject }
}

function uniqueIssues(issues: CEmbeddedQualityIssue[]) {
  const seen = new Set<string>()
  return issues.filter((item) => {
    const key = `${item.kind}:${item.message}:${item.checker}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function currentLineRangeText(input: CheckerInput, range: CompletionRange) {
  if (range.startLine !== range.endLine) return ""
  return `${input.linePrefix}${input.lineSuffix}`.slice(range.startCharacter, range.endCharacter)
}

function sameRange(left: CompletionRange, right: CompletionRange) {
  return left.startLine === right.startLine &&
    left.startCharacter === right.startCharacter &&
    left.endLine === right.endLine &&
    left.endCharacter === right.endCharacter
}

function hasDuplicatePrefixRisk(input: CheckerInput) {
  const prefix = input.linePrefix.trim()
  if (prefix.length < 3) return false
  const firstLine = firstNonEmptyLine(input.acceptedText).trim()
  return firstLine === prefix || firstLine.startsWith(`${prefix}${prefix}`) || firstLine.startsWith(`${prefix} ${prefix}`)
}

function firstNonEmptyLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n").find((line) => line.trim()) ?? ""
}

function completionLineCount(input: string) {
  if (!input) return 0
  return input.replace(/\r\n/g, "\n").split("\n").length
}

function containsFold(input: string, value: string) {
  return input.toLowerCase().includes(value.toLowerCase())
}

function normalizeStableText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function cStaticSyntaxIssue(input: string) {
  if (!hasReasonableDelimiterBalance(input)) return "completion has suspicious delimiter balance"
  if (/^\s*(?:else|case|default)\b/.test(input) && !/[{}]/.test(input)) return "control-flow fragment is not attached to a surrounding block"
  return ""
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

function clangAvailable() {
  if (clangAvailability !== undefined) return clangAvailability
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore", timeout: 1000 })
    clangAvailability = true
  } catch {
    clangAvailability = false
  }
  return clangAvailability
}

function sanitizeCompileUnit(input: string) {
  return input
    .replace(/^\s*#\s*include\s+"[^"]+"\s*$/gm, "")
    .replace(/^\s*#\s*include\s+<[^>]+>\s*$/gm, (line) => /<(?:stdint|stdbool|stddef|string|stdio)\.h>/.test(line) ? line : "")
}

function compileUnitText(input: CheckerInput) {
  return [
    "#include <stdint.h>",
    "#include <stdbool.h>",
    "#include <stddef.h>",
    "#include <string.h>",
    "#include <stdio.h>",
    "#define BIT(n) (1u << (n))",
    "#define ARRAY_SIZE(x) (sizeof(x) / sizeof((x)[0]))",
    "#define MIN(a, b) ((a) < (b) ? (a) : (b))",
    "#define HAL_OK 0",
    "#define HAL_ERR -1",
    "#define HAL_TIMEOUT -2",
    "#define LOG_ERR(tag, code) ((void)(tag), (void)(code))",
    "#define pdMS_TO_TICKS(ms) (ms)",
    "#define pdPASS 1",
    "#define pdTRUE 1",
    "typedef int hal_status_t;",
    ...(input.fixture.openTabs ?? []).map((tab) => tab.text),
    input.appliedText,
  ].join("\n")
}

function clangErrorMessage(error: unknown) {
  const record = error && typeof error === "object" ? error as { stderr?: Buffer | string; message?: string } : undefined
  const stderr = record?.stderr
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : record?.message ?? String(error)
  return text.replace(/\s+/g, " ").trim().slice(0, 400)
}

function hasUnboundedBufferWrite(input: string) {
  if (/\b(?:sprintf|strcpy|strcat|gets)\s*\(/.test(input)) return true
  if (/\bmem(?:cpy|move)\s*\(/.test(input) && !/\b(?:sizeof|MIN|ARRAY_SIZE|capacity|buf_len|buffer_len|dst_len|len\s*[<>]=|if\s*\()/i.test(input)) return true
  if (/\b(?:buf|buffer|dst|packet|payload|rx|tx)\s*\[[^\]]+\]\s*=/.test(input) && !/\b(?:if|for)\s*\([^)]*(?:sizeof|capacity|len|count|index|i)\b/i.test(input)) return true
  return false
}

function isDriverOrIsrContext(input: CheckerInput) {
  return isIsrContext(input) || /(?:driver|drv|hal|bsp|irq|isr)/i.test(input.fixture.path)
}

function isIsrContext(input: CheckerInput) {
  const haystack = `${input.fixture.path}\n${input.fixture.category}\n${input.fixture.document}\n${input.selectedContextText}`
  return /\b(?:ISR|IRQHandler|IRQ|interrupt)\b/i.test(haystack)
}

function hasBlockingCall(input: string) {
  return /\b(?:vTaskDelay|osDelay|sleep|usleep|HAL_Delay|xSemaphoreTake|xQueueReceive|ulTaskNotifyTake)\s*\(/.test(input) &&
    !/\bFromISR\s*\(/.test(input)
}

function needsVolatile(input: CheckerInput) {
  const haystack = `${input.fixture.category}\n${input.fixture.document}\n${input.selectedContextText}\n${input.fixture.retrievedSnippets?.map((snippet) => snippet.text).join("\n") ?? ""}`
  return /\b(?:MMIO|register|REG_|_REG|volatile|IRQ|ISR)\b/i.test(haystack)
}

function losesVolatile(input: string) {
  if (/\bvolatile\b/.test(input)) return false
  if (/\*\s*\(\s*(?:uint(?:8|16|32)_t|unsigned\s+int|uint32_t)\s*\*\s*\)\s*(?:0x[0-9a-f]+|[A-Z0-9_]+(?:_BASE|_REG|_ADDR))\b/i.test(input)) return true
  if (/\*\s*\(\s*(?:uint(?:8|16|32)_t|unsigned\s+int|uint32_t)\s*\*\s*\)\s*\(\s*(?:0x[0-9a-f]+|[A-Z0-9_]+(?:_BASE|_REG|_ADDR))\b/i.test(input)) return true
  if (/#\s*define\s+[A-Z0-9_]*(?:REG|DR|SR|CR)[A-Z0-9_]*\s+\(\s*\*\s*\(\s*(?:uint(?:8|16|32)_t|unsigned\s+int)\s*\*/.test(input)) return true
  return false
}

function hasUnalignedPacketCast(input: string) {
  if (/\bmemcpy\s*\(/.test(input) || /\balign(?:ed|of)?\b/i.test(input) || /\buintptr_t\b/.test(input)) return false
  return /\(\s*(?:const\s+)?[A-Za-z_][A-Za-z0-9_]*_t\s*\*\s*\)\s*(?:buf|buffer|data|payload|packet|rx|frame)\b/.test(input)
}

function knownProjectSymbols(input: CheckerInput) {
  const text = [
    input.fixture.document,
    input.originalText,
    input.selectedContextText,
    ...(input.fixture.openTabs ?? []).map((tab) => tab.text),
    ...(input.fixture.retrievedSnippets ?? []).map((snippet) => `${snippet.name ?? ""}\n${snippet.text}`),
    ...(input.fixture.allowedSymbols ?? []),
  ].join("\n")
  const symbols = new Set<string>()
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    if (!C_KEYWORDS.has(match[0])) symbols.add(match[0])
  }
  return symbols
}

function unknownProjectSymbols(input: string, known: Set<string>) {
  const result = new Set<string>()
  for (const symbol of projectSymbolCandidates(input)) {
    if (known.has(symbol) || SAFE_KNOWN_SYMBOLS.has(symbol) || SAFE_KNOWN_CALLS.has(symbol) || C_KEYWORDS.has(symbol)) continue
    result.add(symbol)
  }
  return [...result]
}

function projectSymbolCandidates(input: string) {
  const result = new Set<string>()
  for (const match of input.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const symbol = match[0]
    const before = input.slice(Math.max(0, (match.index ?? 0) - 2), match.index)
    if (before.endsWith(".") || before.endsWith("->")) continue
    if (isProjectMacroSymbol(symbol) || looksLikeProjectApiSymbol(symbol) || isAlwaysSuspiciousProjectSymbol(symbol)) {
      result.add(symbol)
    }
  }
  return [...result]
}

function isProjectMacroSymbol(symbol: string) {
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(symbol)) return false
  if (SAFE_KNOWN_SYMBOLS.has(symbol)) return false
  return symbol.includes("_") || /(?:REG|CTRL|STATUS|MASK|FLAG|ENABLE|DISABLE|TIMEOUT|ERR|OK|IRQ|DMA|UART|GPIO|I2C|SPI|ADC|PWM|TIMER)/.test(symbol)
}

function looksLikeProjectApiSymbol(symbol: string) {
  return /^(?:HAL_|LL_|UART|GPIO|I2C|SPI|ADC|PWM|TIMER)[A-Za-z0-9_]*$/.test(symbol) ||
    /^(?:uart|gpio|i2c|spi|adc|pwm|timer)_[A-Za-z0-9_]+$/.test(symbol)
}

function isAlwaysSuspiciousProjectSymbol(symbol: string) {
  return /^(?:NONEXISTENT_[A-Z0-9_]*|HAL_UARTX[A-Za-z0-9_]*|FAKE_[A-Z0-9_]+|UNKNOWN_[A-Z0-9_]+)$/.test(symbol) ||
    /(?:invented|nonexistent)/i.test(symbol)
}

function callNames(input: string) {
  const result = new Set<string>()
  for (const match of input.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1]
    const before = input.slice(Math.max(0, match.index - 32), match.index)
    if (/\b(?:if|for|while|switch|return|sizeof|typedef|struct|enum)\s*$/.test(before)) continue
    if (/\b(?:void|int|char|bool|uint(?:8|16|32)_t|static|extern|inline)\s+$/.test(before)) continue
    result.add(name)
  }
  return [...result]
}
