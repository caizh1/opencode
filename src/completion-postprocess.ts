import type { CompletionCIntent, CompletionInsertMode, CompletionPlan, CompletionPlanKind } from "./completion-types"

export type CompletionPostprocessRejectReason =
  | "empty-output"
  | "echoed-prefix"
  | "repeated-comment"
  | "explanation-only"
  | "low-confidence-output"
  | "suffix-duplicated-output"

export type CompletionPostprocessPlan = Pick<CompletionPlan, "kind" | "insertMode" | "replaceCurrentWord" | "confidenceFloor" | "cIntent">

export type CompletionPostprocessPrefixMode = "none" | "stripped" | "preserved" | "exact-echo"

export type CompletionPostprocessDebug = {
  prefixMode: CompletionPostprocessPrefixMode
  stripReason?: "insert-at-cursor-full-candidate-to-delta"
}

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

const POSTPROCESS_DEBUG: unique symbol = Symbol("completionPostprocessDebug")
const QWEN_SPECIAL_TOKEN_PATTERN = /<\|(?:fim_prefix|fim_middle|fim_suffix|fim_pad|repo_name|file_sep|endoftext|im_start|im_end)\|>/g

export function postprocessCompletion(input: CompletionPostprocessInput): CompletionPostprocessResult {
  const currentLine = input.fullCurrentLine ?? `${input.linePrefix}${input.lineSuffix}`
  let text = normalizeRawText(input.rawText)
  text = firstFencedCode(text) ?? text
  text = stripWrappingFence(text)
  text = unwrapCStyleInlineCode(text, input.languageId)
  text = stripLeadingMetaLines(text)
  text = stripExplanatoryLeadIn(text)

  const initialPrefix = normalizePrefixEcho({
    text,
    linePrefix: input.linePrefix,
    insertMode: input.plan.insertMode,
    replaceCurrentWord: input.plan.replaceCurrentWord,
  })
  const echo = stripCurrentLineEchoes(text, currentLine)
  text = echo.text
  const prefix = text
    ? normalizePrefixEcho({
        text,
        linePrefix: input.linePrefix,
        insertMode: input.plan.insertMode,
        replaceCurrentWord: input.plan.replaceCurrentWord,
      })
    : initialPrefix.exactEcho
      ? initialPrefix
      : normalizePrefixEcho({
          text,
          linePrefix: input.linePrefix,
          insertMode: input.plan.insertMode,
          replaceCurrentWord: input.plan.replaceCurrentWord,
        })

  if (prefix.exactEcho) {
    return withPostprocessDebug({
      text: "",
      rejected: true,
      reason: echoReason(input.plan.kind, input.linePrefix),
    }, prefixDebug(prefix))
  }

  if (input.plan.replaceCurrentWord && hasCurrentWordLinePrefixCandidate(text, input.linePrefix, input.currentWord)) {
    return finalizedResult({
      text: stripSuffixOverlap(text.trimEnd(), input.lineSuffix, input.linePrefix).text,
      fallbackReason: echo.count ? echoReason(input.plan.kind, input.linePrefix) : "empty-output",
      planKind: input.plan.kind,
      skipLowConfidence: true,
      debug: prefixDebug(prefix),
    })
  }

  if (input.plan.replaceCurrentWord && hasCurrentWordCandidate(text, input.currentWord)) {
    return finalizedResult({
      text: stripSuffixOverlap(text.trimEnd(), input.lineSuffix, input.linePrefix).text,
      fallbackReason: echo.count ? echoReason(input.plan.kind, input.linePrefix) : "empty-output",
      planKind: input.plan.kind,
      skipLowConfidence: true,
      debug: prefixDebug(prefix),
    })
  }

  text = prefix.text
  const suffix = stripSuffixOverlap(text, input.lineSuffix, input.linePrefix)
  text = stripLeadingMetaLines(suffix.text)
  text = stripExplanatoryLeadIn(text)
  text = normalizeCommonIndent(text)
  text = stripInstructionLeadingComments(text, input.plan.kind)
  const middleOfLine = sanitizeMiddleOfLineCompletion(text, input.lineSuffix, input.linePrefix)
  if (middleOfLine.rejected) {
    return withPostprocessDebug({
      text: "",
      rejected: true,
      reason: middleOfLine.reason,
    }, prefixDebug(prefix))
  }
  text = middleOfLine.text

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
    debug: prefixDebug(prefix),
  })
}

export function completionPostprocessDebug(result: CompletionPostprocessResult): CompletionPostprocessDebug | undefined {
  return (result as { [POSTPROCESS_DEBUG]?: CompletionPostprocessDebug })[POSTPROCESS_DEBUG]
}

export function trimCompletionForCIntent(input: {
  text: string
  cIntent?: CompletionCIntent
  linePrefix: string
  lineSuffix: string
  languageId: string
}) {
  if (!isCStyleLanguage(input.languageId) || !input.cIntent) return input.text
  const text = input.text.trimEnd()
  switch (input.cIntent) {
    case "member-access":
      return trimMemberAccessCompletion(text)
    case "call-args":
      return trimCallArgsCompletion(text)
    case "initializer":
      return trimInitializerCompletion(text)
    case "condition":
      return trimConditionCompletion(text)
    case "error-path":
    case "body-statement":
    case "case-body":
    case "switch-case":
    case "state-machine":
      return trimShortStatementCompletion(text, input.cIntent === "error-path" ? 2 : 4)
    default:
      return text
  }
}

export function planKindOnlyPostprocessPlan(input: {
  planKind?: CompletionPlanKind
  replaceCurrentWord?: boolean
  insertMode?: CompletionInsertMode
  cIntent?: CompletionCIntent
}): CompletionPostprocessPlan {
  const replaceCurrentWord = input.replaceCurrentWord ?? false
  return {
    kind: input.planKind ?? "ordinary-code",
    insertMode: input.insertMode ?? (replaceCurrentWord ? "replace-current-word" : "insert-at-cursor"),
    replaceCurrentWord,
    ...(input.cIntent ? { cIntent: input.cIntent } : {}),
    confidenceFloor: 0,
  }
}

function trimMemberAccessCompletion(input: string) {
  const first = firstCompletionLine(input)
  const clipped = first.split(/[;{}]/)[0] ?? first
  const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*(?:(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)?)/.exec(clipped)
  return (match?.[1] ?? clipped).trim()
}

function trimCallArgsCompletion(input: string) {
  const line = firstCompletionLine(input)
  return stripTrailingCallBoundary(line)
    .replace(/[ \t]*;\s*$/, "")
    .trimEnd()
}

function trimInitializerCompletion(input: string) {
  const beforeClose = input.split(/^[ \t]*};/m)[0] ?? input
  return beforeClose
    .replace(/[ \t]*};[\s\S]*$/, "")
    .trimEnd()
}

function trimConditionCompletion(input: string) {
  const line = firstCompletionLine(input)
  const beforeBlock = line.split("{")[0] ?? line
  return stripTrailingConditionBoundary(beforeBlock).trimEnd()
}

function trimShortStatementCompletion(input: string, maxNonEmptyLines: number) {
  const lines = input.replace(/\r\n/g, "\n").split("\n")
  const kept: string[] = []
  let nonEmpty = 0
  for (const line of lines) {
    if (line.trim()) nonEmpty += 1
    if (nonEmpty > maxNonEmptyLines) break
    kept.push(line)
  }
  return kept.join("\n").trimEnd()
}

function firstCompletionLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
}

function stripTrailingCallBoundary(input: string) {
  return input
    .replace(/\)\s*;\s*$/, "")
    .replace(/\)\s*$/, "")
}

function stripTrailingConditionBoundary(input: string) {
  return input
    .replace(/\)\s*$/, "")
    .replace(/[ \t]*;\s*$/, "")
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

function unwrapCStyleInlineCode(input: string, languageId: string) {
  if (!isCStyleLanguage(languageId)) return input
  const trimmed = input.trim()
  if (!trimmed.startsWith("`") || !trimmed.endsWith("`")) return input
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) return input
  const inner = trimmed.slice(1, -1)
  if (!inner.trim() || inner.includes("`")) return input
  return inner
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

function normalizePrefixEcho(input: {
  text: string
  linePrefix: string
  insertMode: CompletionInsertMode
  replaceCurrentWord: boolean
}): {
  text: string
  stripped: boolean
  preserved: boolean
  exactEcho: boolean
} {
  const prefixes = linePrefixEchoCandidates(input.linePrefix)
  if (!input.text || prefixes.length === 0) {
    return {
      text: input.text,
      stripped: false,
      preserved: false,
      exactEcho: false,
    }
  }

  if (prefixes.some((prefix) => isExactPrefixEcho(input.text, prefix))) {
    return {
      text: "",
      stripped: false,
      preserved: false,
      exactEcho: true,
    }
  }

  const startsWithPrefix = prefixes.some((prefix) => input.text.startsWith(prefix))
  if (!startsWithPrefix) {
    return {
      text: input.text,
      stripped: false,
      preserved: false,
      exactEcho: false,
    }
  }

  if (input.insertMode !== "insert-at-cursor") {
    return {
      text: input.text,
      stripped: false,
      preserved: true,
      exactEcho: false,
    }
  }

  let remaining = input.text
  let stripped = false
  while (true) {
    const prefix = prefixes.find((item) => remaining.startsWith(item))
    if (!prefix) break
    remaining = remaining.slice(prefix.length)
    stripped = true
  }

  return {
    text: remaining,
    stripped,
    preserved: false,
    exactEcho: stripped && !remaining,
  }
}

function linePrefixEchoCandidates(linePrefix: string) {
  return uniqueNonEmpty([linePrefix, linePrefix.trimStart(), linePrefix.trim()])
    .sort((left, right) => right.length - left.length)
}

function isExactPrefixEcho(text: string, prefix: string) {
  const trimmedText = text.trimEnd()
  return trimmedText === prefix || trimmedText === prefix.trimStart() || trimmedText === prefix.trim()
}

function stripSuffixOverlap(text: string, lineSuffix: string, linePrefix = "") {
  if (!lineSuffix.trim()) return { text, stripped: false }
  const suffix = lineSuffix.replace(/\r\n/g, "\n")
  const max = Math.min(text.length, suffix.length, 500)
  for (let length = max; length >= 1; length--) {
    if (text.slice(-length) === suffix.slice(0, length)) {
      if (!shouldStripSuffixOverlap({
        text,
        lineSuffix: suffix,
        linePrefix,
        overlapLength: length,
      })) continue
      return {
        text: text.slice(0, -length),
        stripped: true,
      }
    }
  }
  return { text, stripped: false }
}

function sanitizeMiddleOfLineCompletion(text: string, lineSuffix: string, linePrefix: string): CompletionPostprocessResult {
  if (!lineSuffix.trim()) return { text }

  let candidate = text
  if (candidate.includes("\n")) {
    candidate = candidate.split("\n")[0] ?? ""
  }
  candidate = candidate.trimEnd()

  if (startsWithSuffixEcho(candidate, lineSuffix)) {
    return {
      text: "",
      rejected: true,
      reason: "suffix-duplicated-output",
    }
  }

  if (shouldStripRepeatedSingleCharacterSuffix(lineSuffix)) {
    candidate = stripSuffixOverlap(candidate, lineSuffix, linePrefix).text
  }

  if (!candidate.trim()) {
    return {
      text: "",
      rejected: true,
      reason: "suffix-duplicated-output",
    }
  }

  return { text: candidate }
}

function shouldStripSuffixOverlap(input: {
  text: string
  lineSuffix: string
  linePrefix: string
  overlapLength: number
}) {
  const overlap = input.lineSuffix.slice(0, input.overlapLength)
  if (!isOnlyClosingBracketOverlap(overlap)) return true

  const strippedText = input.text.slice(0, -input.overlapLength)
  const keptLine = `${input.linePrefix}${input.text}${input.lineSuffix}`
  const strippedLine = `${input.linePrefix}${strippedText}${input.lineSuffix}`
  return delimiterImbalance(strippedLine) < delimiterImbalance(keptLine)
}

function isOnlyClosingBracketOverlap(input: string) {
  const trimmed = input.trim()
  return trimmed.length > 0 && /^[)\]}]+$/.test(trimmed)
}

function delimiterImbalance(input: string) {
  const sanitized = stripStringAndCommentContent(input)
  return bracketImbalance(sanitized, "(", ")") +
    bracketImbalance(sanitized, "[", "]") +
    bracketImbalance(sanitized, "{", "}")
}

function bracketImbalance(input: string, open: string, close: string) {
  let depth = 0
  let unmatchedClose = 0
  for (const char of input) {
    if (char === open) {
      depth += 1
    } else if (char === close) {
      if (depth > 0) {
        depth -= 1
      } else {
        unmatchedClose += 1
      }
    }
  }
  return depth + unmatchedClose
}

function stripStringAndCommentContent(input: string) {
  let result = ""
  let quote: "'" | "\"" | "`" | undefined
  let escaped = false
  let inBlockComment = false
  let inLineComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        result += "\n"
      } else {
        result += " "
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        result += "  "
        index += 1
      } else {
        result += char === "\n" ? "\n" : " "
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      result += char === "\n" ? "\n" : " "
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      result += "  "
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      result += "  "
      index += 1
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      result += " "
      continue
    }
    result += char
  }
  return result
}

function startsWithSuffixEcho(text: string, lineSuffix: string) {
  const firstSuffix = firstNonWhitespaceCharacter(lineSuffix)
  if (!firstSuffix || !isClosingPunctuation(firstSuffix)) return false
  const firstText = firstNonWhitespaceCharacter(text)
  return firstText === firstSuffix
}

function firstNonWhitespaceCharacter(input: string) {
  return input.trimStart()[0]
}

function isClosingPunctuation(input: string) {
  return input === ")" || input === "]" || input === "}" || input === ";" || input === ","
}

function shouldStripRepeatedSingleCharacterSuffix(lineSuffix: string) {
  const trimmed = lineSuffix.trimStart()
  return trimmed.startsWith(";") || trimmed.startsWith(",") || trimmed.startsWith("]")
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

function stripInstructionLeadingComments(input: string, planKind: CompletionPlanKind) {
  if (!isInstructionPlanKind(planKind)) return input

  const lines = input.split("\n")
  let index = 0
  let sawComment = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (!trimmed && sawComment) {
      index += 1
      continue
    }
    if (!isGeneratedCommentLine(trimmed)) break
    sawComment = true
    index += 1
  }
  if (!sawComment) return input

  const remaining = lines.slice(index).join("\n").replace(/^\n+/, "")
  if (!hasMeaningfulInstructionCode(remaining)) return input
  return remaining
}

function finalizedResult(input: {
  text: string
  fallbackReason: CompletionPostprocessRejectReason
  planKind: CompletionPlanKind
  skipLowConfidence?: boolean
  debug?: CompletionPostprocessDebug
}): CompletionPostprocessResult {
  const text = finalizeCompletion(input.text)
  const debug = input.debug ?? { prefixMode: "none" as const }
  if (!text) {
    return withPostprocessDebug({
      text: "",
      rejected: true,
      reason: input.fallbackReason,
    }, debug)
  }
  if (isExplanationOnly(text)) {
    return withPostprocessDebug({
      text: "",
      rejected: true,
      reason: "explanation-only",
    }, debug)
  }
  if (!input.skipLowConfidence && isLowConfidenceOutput(text, input.planKind)) {
    return withPostprocessDebug({
      text: "",
      rejected: true,
      reason: "low-confidence-output",
    }, debug)
  }
  return withPostprocessDebug({ text }, debug)
}

function prefixDebug(input: {
  stripped: boolean
  preserved: boolean
  exactEcho: boolean
}): CompletionPostprocessDebug {
  if (input.exactEcho) return { prefixMode: "exact-echo" }
  if (input.stripped) {
    return {
      prefixMode: "stripped",
      stripReason: "insert-at-cursor-full-candidate-to-delta",
    }
  }
  if (input.preserved) return { prefixMode: "preserved" }
  return { prefixMode: "none" }
}

function withPostprocessDebug<T extends CompletionPostprocessResult>(
  result: T,
  debug: CompletionPostprocessDebug,
): T {
  Object.defineProperty(result, POSTPROCESS_DEBUG, {
    value: debug,
    enumerable: false,
  })
  return result
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
  if (isInstructionPlanKind(planKind) && isStructuralOnlyCodeFragment(text)) return true
  if ((planKind === "comment-to-test" || planKind === "natural-command") && /^return\s+undefined;?$/i.test(text)) return true
  return false
}

function isInstructionPlanKind(planKind: CompletionPlanKind) {
  return planKind === "comment-to-code" ||
    planKind === "comment-to-test" ||
    planKind === "natural-command" ||
    planKind === "previous-comment-continuation"
}

function isStructuralOnlyCodeFragment(input: string) {
  const compact = input.replace(/\s+/g, "")
  if (!compact) return false
  if (/^[{}()[\];,.:]+$/.test(compact)) return true

  const lines = input.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (lines.every((line) => /^[{}()[\];,.:]+$/.test(line))) return true
  return !hasMeaningfulInstructionCode(input)
}

function hasMeaningfulInstructionCode(input: string) {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isGeneratedCommentLine(line))
    .filter((line) => !/^[{}()[\];,.:]+$/.test(line))
    .some(looksLikeCodeLine)
}

function isGeneratedCommentLine(input: string) {
  if (!input) return false
  if (input.startsWith("//")) return true
  if (input.startsWith("/*") || input.startsWith("*") || input.endsWith("*/")) return true
  if (input.startsWith("#") && !isPreprocessorCodeLine(input)) return true
  return false
}

function isPreprocessorCodeLine(input: string) {
  return /^#\s*(?:include|define|if|ifdef|ifndef|elif|else|endif|pragma|error|warning)\b/.test(input)
}

function isSingleLineComment(input: string) {
  const trimmed = input.trimStart()
  return trimmed.startsWith("//") || trimmed.startsWith("#")
}

function isCStyleLanguage(languageId: string) {
  return new Set(["c", "cpp", "c++", "objective-c", "objective-cpp"]).has(languageId)
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
