import type { CompletionPlan, CompletionPlanKind } from "./completion-types"

export type CompletionPostprocessRejectReason =
  | "empty-output"
  | "echoed-prefix"
  | "repeated-comment"
  | "explanation-only"
  | "low-confidence-output"

export type CompletionPostprocessPlan = Pick<CompletionPlan, "kind" | "replaceCurrentWord" | "confidenceFloor">

export type CompletionPostprocessInput = {
  rawText: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  fullCurrentLine?: string
  plan: CompletionPostprocessPlan
  languageId: string
  indent: {
    currentIndent?: string
    targetIndent: string
    indentUnit: string
  }
}

export type CompletionPostprocessResult =
  | {
      text: string
      rejected?: false
      reason?: never
    }
  | {
      text: ""
      rejected: true
      reason: CompletionPostprocessRejectReason
    }

const QWEN_SPECIAL_TOKEN_PATTERN = /<\|(?:fim_prefix|fim_middle|fim_suffix|fim_pad|repo_name|file_sep|endoftext|im_start|im_end)\|>/g

export function postprocessCompletion(input: CompletionPostprocessInput): CompletionPostprocessResult {
  const currentLine = input.fullCurrentLine ?? `${input.linePrefix}${input.lineSuffix}`
  let text = normalizeRawText(input.rawText)
  text = firstFencedCode(text) ?? text
  text = stripWrappingFence(text)
  text = stripLeadingMetaLines(text)
  text = stripExplanatoryLeadIn(text)

  const echo = stripCurrentLineEchoes(text, currentLine)
  text = echo.text

  if (input.plan.replaceCurrentWord && hasCurrentWordLinePrefixCandidate(text, input.linePrefix, input.currentWord)) {
    return finalizedResult({
      text: stripSuffixOverlap(text.trimEnd(), input.lineSuffix).text,
      fallbackReason: echo.count ? echoReason(input.plan.kind, input.linePrefix) : "empty-output",
      planKind: input.plan.kind,
    })
  }

  if (input.plan.replaceCurrentWord && hasCurrentWordCandidate(text, input.currentWord)) {
    return finalizedResult({
      text: stripSuffixOverlap(text.trimEnd(), input.lineSuffix).text,
      fallbackReason: echo.count ? echoReason(input.plan.kind, input.linePrefix) : "empty-output",
      planKind: input.plan.kind,
    })
  }

  const prefix = stripPrefixEcho(text, input.linePrefix)
  text = prefix.text
  const suffix = stripSuffixOverlap(text, input.lineSuffix)
  text = stripLeadingMetaLines(suffix.text)
  text = stripExplanatoryLeadIn(text)
  text = normalizeCommonIndent(text)

  const fallbackReason = rejectionReason({
    planKind: input.plan.kind,
    linePrefix: input.linePrefix,
    echoCount: echo.count,
    prefixStripped: prefix.stripped,
  })
  return finalizedResult({
    text,
    fallbackReason,
    planKind: input.plan.kind,
  })
}

export function planKindOnlyPostprocessPlan(input: {
  planKind?: CompletionPlanKind
  replaceCurrentWord?: boolean
}): CompletionPostprocessPlan {
  return {
    kind: input.planKind ?? "ordinary-code",
    replaceCurrentWord: input.replaceCurrentWord ?? false,
    confidenceFloor: 0,
  }
}

function normalizeRawText(input: string) {
  return input
    .replace(/\r\n/g, "\n")
    .replace(QWEN_SPECIAL_TOKEN_PATTERN, "")
    .replace(/<\/s>/g, "")
}

function firstFencedCode(input: string) {
  const match = /```[a-zA-Z0-9_-]*[ \t]*\n?([\s\S]*?)(?:\n)?[ \t]*```/.exec(input)
  return match?.[1]
}

function stripWrappingFence(input: string) {
  return input
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*(?:\n)?/, "")
    .replace(/(?:\n)?[ \t]*```[ \t]*$/, "")
}

function stripCurrentLineEchoes(input: string, fullCurrentLine: string) {
  const fullLine = fullCurrentLine.trim()
  if (!fullLine) return { text: input, count: 0 }

  const lines = input.split("\n")
  let count = 0
  while (lines[0]?.trim() === fullLine) {
    lines.shift()
    count += 1
    while (lines[0] !== undefined && !lines[0].trim()) lines.shift()
  }
  return {
    text: lines.join("\n"),
    count,
  }
}

function hasCurrentWordLinePrefixCandidate(text: string, linePrefix: string, currentWord: string | undefined) {
  if (!currentWord) return false
  const wordStart = linePrefix.length - currentWord.length
  if (wordStart < 0) return false
  const beforeWord = linePrefix.slice(0, wordStart)
  if (!text.startsWith(beforeWord)) return false
  const afterPrefix = text.slice(beforeWord.length)
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(afterPrefix)
  return Boolean(match?.[0].startsWith(currentWord) && match[0].length > currentWord.length)
}

function hasCurrentWordCandidate(text: string, currentWord: string | undefined) {
  if (!currentWord) return false
  const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(text)
  return Boolean(match?.[1].startsWith(currentWord) && match[1].length > currentWord.length)
}

function stripPrefixEcho(text: string, linePrefix: string) {
  let remaining = text
  let stripped = false
  const prefixes = uniqueNonEmpty([linePrefix, linePrefix.trimStart(), linePrefix.trim()])
    .sort((left, right) => right.length - left.length)
  while (true) {
    const prefix = prefixes.find((item) => remaining.startsWith(item))
    if (!prefix) break
    remaining = remaining.slice(prefix.length)
    stripped = true
  }
  return {
    text: stripped ? remaining.replace(/^[ \t]+/, "") : text,
    stripped,
  }
}

function stripSuffixOverlap(text: string, lineSuffix: string) {
  if (!lineSuffix.trim()) return { text, stripped: false }
  const suffix = lineSuffix.replace(/\r\n/g, "\n")
  const max = Math.min(text.length, suffix.length, 500)
  for (let length = max; length >= 1; length--) {
    if (text.slice(-length) === suffix.slice(0, length)) {
      return {
        text: text.slice(0, -length),
        stripped: true,
      }
    }
  }
  return { text, stripped: false }
}

function stripLeadingMetaLines(input: string) {
  const lines = input.split("\n")
  let index = 0
  let removed = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (!trimmed && removed) {
      index += 1
      continue
    }
    if (!isMetaLine(trimmed)) break
    removed = true
    index += 1
  }
  return lines.slice(index).join("\n")
}

function stripExplanatoryLeadIn(input: string) {
  const lines = input.split("\n")
  let index = 0
  while (lines[index] !== undefined && !lines[index].trim()) index += 1
  const first = lines[index]?.trim()
  const second = lines[index + 1]?.trim()
  if (!first || !second) return input
  if (!looksLikeExplanationLine(first) || !looksLikeCodeLine(second)) return input
  lines.splice(index, 1)
  return lines.join("\n").replace(/^\n+/, "")
}

function normalizeCommonIndent(input: string) {
  const hasLeadingNewline = /^[ \t]*\n/.test(input)
  const text = input.replace(/\s+$/, "")
  if (!text.includes("\n")) return text

  const lines = text.split("\n")
  const nonEmptyIndents = lines
    .filter((line) => line.trim())
    .map(lineIndent)
  const common = commonLeadingWhitespace(nonEmptyIndents)
  if (!common) return text

  const normalized = lines.map((line) => line.trim() ? stripPrefix(line, common) : line).join("\n")
  return hasLeadingNewline ? normalized : normalized.replace(/^\n+/, "")
}

function finalizedResult(input: {
  text: string
  fallbackReason: CompletionPostprocessRejectReason
  planKind: CompletionPlanKind
}): CompletionPostprocessResult {
  const text = finalizeCompletion(input.text)
  if (!text) {
    return {
      text: "",
      rejected: true,
      reason: input.fallbackReason,
    }
  }
  if (isExplanationOnly(text)) {
    return {
      text: "",
      rejected: true,
      reason: "explanation-only",
    }
  }
  if (isLowConfidenceOutput(text, input.planKind)) {
    return {
      text: "",
      rejected: true,
      reason: "low-confidence-output",
    }
  }
  return { text }
}

function finalizeCompletion(input: string) {
  const text = input.replace(/\s+$/, "")
  if (!text.trim()) return ""
  if (text.split("\n").every((line) => !line.trim() || isMetaLine(line.trim()))) return ""
  return text
}

function rejectionReason(input: {
  planKind: CompletionPlanKind
  linePrefix: string
  echoCount: number
  prefixStripped: boolean
}): CompletionPostprocessRejectReason {
  if (input.echoCount > 0) return echoReason(input.planKind, input.linePrefix)
  if (input.prefixStripped) return "echoed-prefix"
  return "empty-output"
}

function echoReason(planKind: CompletionPlanKind, linePrefix: string): CompletionPostprocessRejectReason {
  if ((planKind === "comment-to-test" || planKind === "comment-to-code") && isSingleLineComment(linePrefix)) {
    return "repeated-comment"
  }
  return "echoed-prefix"
}

function isMetaLine(input: string) {
  if (!input) return false
  if (/^(?:sure|ok(?:ay)?)[,.!]?$/i.test(input)) return true
  if (/^(?:here(?:'s| is)|below is|the completion is|completion|answer|final(?: answer)?)(?:[^\n:]*):?$/i.test(input)) return true
  if (/^```[a-zA-Z0-9_-]*$/.test(input) || input === "```") return true
  return false
}

function isExplanationOnly(input: string) {
  const lines = input.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (lines.some(looksLikeCodeLine)) return false
  return lines.every(looksLikeExplanationLine)
}

function looksLikeExplanationLine(input: string) {
  if (!input) return false
  if (/^(?:this|the|it|we|you|i)\b/i.test(input)) return true
  if (/\b(?:completion|code|function|test|method|returns?|generates?|would|should|will|because)\b/i.test(input) && /[.!:]$/.test(input)) return true
  return false
}

function looksLikeCodeLine(input: string) {
  if (!input) return false
  if (/^(?:#include|#define|#if|#ifdef|#ifndef|#endif)\b/.test(input)) return true
  if (/^(?:static\s+)?(?:void|int|char|bool|float|double|size_t|struct|enum|class|interface|type|const|let|var|function|return|if|else|for|while|switch|case|break|continue|expect|assert|test|describe|it)\b/i.test(input)) return true
  if (/^[A-Za-z_$][\w$]*\s*(?:<[^>]+>\s*)?\([^)]*\)\s*(?:[;{]|=>)?/.test(input)) return true
  if (/^[A-Za-z_$][\w$]*\s*[:=]\s*\S/.test(input)) return true
  if (/[;{}]$/.test(input)) return true
  return false
}

function isLowConfidenceOutput(input: string, planKind: CompletionPlanKind) {
  const text = input.trim()
  if (!text) return false
  if (/^(?:todo|tbd|pass|\.\.\.|your code here|implementation goes here)$/i.test(text)) return true
  if (/^(?:\/\/|#|\/\*)\s*(?:todo|tbd|\.\.\.|your code here)/i.test(text)) return true
  if ((planKind === "comment-to-test" || planKind === "natural-command") && /^return\s+undefined;?$/i.test(text)) return true
  return false
}

function isSingleLineComment(input: string) {
  const trimmed = input.trimStart()
  return trimmed.startsWith("//") || trimmed.startsWith("#")
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function commonLeadingWhitespace(indents: string[]) {
  if (indents.length === 0) return ""
  let common = indents[0]
  for (const indent of indents.slice(1)) {
    while (common && !indent.startsWith(common)) common = common.slice(0, -1)
  }
  return common
}

function stripPrefix(input: string, prefix: string) {
  if (!prefix) return input
  return input.startsWith(prefix) ? input.slice(prefix.length) : input
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0 && value.trim().length > 0))]
}
