import type { CompletionPlanKind } from "./completion-types"

export type CompletionNormalizeInput = {
  rawText: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  fullCurrentLine?: string
  planKind?: CompletionPlanKind
  preferCurrentWordReplacement?: boolean
}

const QWEN_SPECIAL_TOKEN_PATTERN = /<\|(?:fim_prefix|fim_middle|fim_suffix|fim_pad|repo_name|file_sep|endoftext|im_start|im_end)\|>/g

export function normalizeCompletionText(input: CompletionNormalizeInput) {
  let text = input.rawText
    .replace(/\r\n/g, "\n")
    .replace(QWEN_SPECIAL_TOKEN_PATTERN, "")
    .replace(/<\/s>/g, "")

  text = firstFencedCode(text) ?? text
  text = stripWrappingFence(text)
  text = stripLeadingMetaLines(text)
  text = stripCurrentLineEcho(text, input.fullCurrentLine ?? `${input.linePrefix}${input.lineSuffix}`)

  if (!text) return ""
  if (input.preferCurrentWordReplacement && hasCurrentWordLinePrefixCandidate(text, input.linePrefix, input.currentWord)) {
    return stripSuffixOverlap(text.trimEnd(), input.lineSuffix)
  }

  text = stripPrefixEcho(text, input.linePrefix)
  text = stripSuffixOverlap(text, input.lineSuffix)
  text = stripLeadingMetaLines(text)
  return finalizeCompletion(text)
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

function stripCurrentLineEcho(input: string, fullCurrentLine: string) {
  const fullLine = fullCurrentLine.trim()
  if (!fullLine) return input

  const lines = input.split("\n")
  if (lines[0]?.trim() !== fullLine) return input
  if (lines.length === 1) return ""
  return lines.slice(1).join("\n").replace(/^\n+/, "")
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
  if (!stripped) return text
  return remaining.replace(/^[ \t]+/, "")
}

function stripSuffixOverlap(text: string, lineSuffix: string) {
  if (!lineSuffix.trim()) return text
  const suffix = lineSuffix.replace(/\r\n/g, "\n")
  const max = Math.min(text.length, suffix.length, 500)
  for (let length = max; length >= 1; length--) {
    if (text.slice(-length) === suffix.slice(0, length)) return text.slice(0, -length)
  }
  return text
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

function finalizeCompletion(input: string) {
  const text = input.replace(/\s+$/, "")
  if (!text.trim()) return ""
  if (text.split("\n").every((line) => !line.trim() || isMetaLine(line.trim()))) return ""
  return text
}

function isMetaLine(input: string) {
  if (!input) return false
  if (/^(?:sure|ok(?:ay)?)[,.!]?$/i.test(input)) return true
  if (/^(?:here(?:'s| is)|below is|the completion is|completion|answer|final(?: answer)?)(?:[^\n:]*):?$/i.test(input)) return true
  if (/^```[a-zA-Z0-9_-]*$/.test(input) || input === "```") return true
  return false
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0 && value.trim().length > 0))]
}
