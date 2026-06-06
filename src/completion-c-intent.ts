import type { CompletionCIntent } from "./completion-types"

export type CCompletionIntentInput = {
  languageId: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  previousNonEmptyLine?: string
  nextNonEmptyLine?: string
  lines?: string[]
  line?: number
}

export function isCCompletionLanguage(languageId: string) {
  return languageId === "c" || languageId === "cpp"
}

export function classifyCCompletionIntent(input: CCompletionIntentInput): CompletionCIntent | undefined {
  if (!isCCompletionLanguage(input.languageId)) return
  const trimmed = input.linePrefix.trim()
  const currentWord = input.currentWord ?? ""

  if (looksLikeMemberAccess(input.linePrefix, currentWord)) return "member-access"
  if (looksLikeInitializer(input.linePrefix)) return "initializer"
  if (looksLikeMmioRegisterContext(input.linePrefix, currentWord)) return "mmio-register"
  if (looksLikeConditionContext(trimmed)) return "condition"
  if (looksLikeErrorPathContext(input, trimmed)) return "error-path"
  if (looksLikeCallArguments(trimmed)) return "call-args"
  if (looksLikeAssignmentRhs(trimmed)) return "assignment-rhs"
  if (currentWord && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)) return "symbol-prefix"
  if (looksLikeCaseBodyContext(input)) return "case-body"
  if (trimmed) return "body-statement"
  return undefined
}

export function cIntentNeedsSymbolRetrieval(intent: CompletionCIntent | undefined) {
  return Boolean(intent)
}

export function looksLikeCaseBodyContext(input: Pick<CCompletionIntentInput, "previousNonEmptyLine">) {
  const previous = input.previousNonEmptyLine?.trim() ?? ""
  return /^(?:case\b.*:|default\s*:)$/.test(previous)
}

function looksLikeMemberAccess(linePrefix: string, currentWord: string) {
  const beforeWord = currentWord && linePrefix.endsWith(currentWord)
    ? linePrefix.slice(0, -currentWord.length)
    : linePrefix
  return /(?:->|\.)\s*$/.test(beforeWord)
}

function looksLikeInitializer(linePrefix: string) {
  const trimmed = linePrefix.trim()
  return /(?:^|[,{]\s*)\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(trimmed)
}

function looksLikeConditionContext(trimmed: string) {
  return /\b(?:if|while)\s*\([^()]*$/.test(trimmed)
}

function looksLikeCallArguments(trimmed: string) {
  if (/\b(?:if|for|while|switch)\s*\([^()]*$/.test(trimmed)) return false
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^()]*$/.test(trimmed)
}

function looksLikeAssignmentRhs(trimmed: string) {
  if (/[=!<>]=\s*$/.test(trimmed)) return false
  return /(?:[A-Za-z_][A-Za-z0-9_]*|(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.test(trimmed)
}

function looksLikeErrorPathContext(input: CCompletionIntentInput, trimmed: string) {
  if (/^goto(?:\s+[A-Za-z_][A-Za-z0-9_]*)?$/.test(trimmed)) return true
  if (looksLikeRetErrGuard(input.previousNonEmptyLine) && hasVisibleLabel(input)) return true
  if (hasVisibleLabel(input) && /\b(?:goto|ret|retval|err|errno|rc|status)\b/i.test(input.linePrefix)) return true
  return false
}

function looksLikeRetErrGuard(line: string | undefined) {
  const trimmed = line?.trim() ?? ""
  if (!/\bif\s*\([^)]*\)\s*\{\s*$/.test(trimmed)) return false
  return /\b(?:ret|retval|err|errno|rc|status|error|failed|fail)\b/i.test(trimmed)
}

function hasVisibleLabel(input: CCompletionIntentInput) {
  if (!input.lines || input.line === undefined) return false
  const before = input.lines.slice(0, input.line).join("\n")
  const after = input.lines.slice(input.line + 1, Math.min(input.lines.length, input.line + 80)).join("\n")
  return labelPattern().test(before) || labelPattern().test(after)
}

function labelPattern() {
  return /^[ \t]*[A-Za-z_][A-Za-z0-9_]*:\s*(?:\/\/.*)?$/m
}

function looksLikeMmioRegisterContext(linePrefix: string, currentWord: string) {
  const identifiers = linePrefix.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  const last = currentWord || identifiers.at(-1) || ""
  if (last && /(?:_REG|_MASK|_SHIFT|_BIT|_BITS|_CTRL|_CFG|_STATUS|_ENABLE|_DISABLE)$/i.test(last)) return true
  if (identifiers.some(isMmioHelperIdentifier)) return true
  if (/\b(?:BIT|GENMASK|FIELD_PREP|FIELD_GET)\s*\([^()]*$/.test(linePrefix)) return true
  if (/\b[A-Z][A-Z0-9_]*(?:_REG|_MASK|_SHIFT|_BIT|_BITS)\b/.test(linePrefix)) return true
  return false
}

function isMmioHelperIdentifier(identifier: string) {
  return /^(?:readl|writel|readw|writew|readb|writeb|ioread(?:8|16|32|64)?|iowrite(?:8|16|32|64)?|FIELD_PREP|FIELD_GET|GENMASK|BIT)$/.test(identifier)
}
