import { splitThinkingFromParts } from "./thinking"
import type { CompletionProfile, ChipMateMessage } from "./types"

const PROMPT_LEAK_PATTERNS = [
  /\blet me re-?read\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper prompt\b/i,
  /\bplan mode\b/i,
  /\binline code completion engine\b/i,
  /\breturn only the exact text to insert at the cursor\b/i,
]

const QWEN_SPECIAL_TOKEN_PATTERN = /<\|(?:fim_prefix|fim_middle|fim_suffix|fim_pad|repo_name|file_sep|endoftext|im_start|im_end)\|>/g

export function completionInsertText(message: ChipMateMessage | undefined, profile: CompletionProfile = "generic-chat"): string {
  if (!message) return ""

  const split = splitThinkingFromParts(message.parts)
  const text = isFimProfile(profile)
    ? cleanupFimCompletion(split.text)
    : cleanupChatCompletion(split.text)
  if (text) return text

  return cleanupReasoningCompletion(split.reasoning, profile)
}

function cleanupChatCompletion(input: string) {
  let text = firstFencedCode(input) ?? input
  text = stripQwenSpecialTokens(text)
  text = stripLeadingMetaLines(text)
  text = stripInlineLeadIn(text)
  text = stripWrappingFence(text)
  text = stripLeadingMetaLines(text)
  return finalizeCompletion(text)
}

function cleanupFimCompletion(input: string) {
  let text = firstFencedCode(input) ?? input
  text = stripQwenSpecialTokens(text)
  text = stripWrappingFence(text)
  text = stripLeadingMetaLines(text)
  return finalizeCompletion(text)
}

function cleanupReasoningCompletion(input: string, profile: CompletionProfile) {
  if (!input.trim()) return ""

  const fenced = firstFencedCode(input)
  if (fenced !== undefined) {
    return isFimProfile(profile) ? cleanupFimCompletion(fenced) : cleanupChatCompletion(fenced)
  }

  const finalMatch = /(?:^|\n)\s*(?:final(?: answer)?|answer|completion)\s*:\s*([\s\S]+)$/i.exec(input)
  if (!finalMatch) return ""
  return isFimProfile(profile) ? cleanupFimCompletion(finalMatch[1]) : cleanupChatCompletion(finalMatch[1])
}

function isFimProfile(profile: CompletionProfile): boolean {
  return profile === "qwen-coder-fim" || profile === "deepseek-fim"
}

function firstFencedCode(input: string) {
  const match = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)(?:\r?\n)?[ \t]*```/.exec(input)
  return match?.[1]
}

function stripWrappingFence(input: string) {
  return input
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n)?/, "")
    .replace(/(?:\r?\n)?[ \t]*```[ \t]*$/, "")
}

function stripQwenSpecialTokens(input: string) {
  return input.replace(QWEN_SPECIAL_TOKEN_PATTERN, "")
}

function stripInlineLeadIn(input: string) {
  const text = input.replace(
    /^[ \t]*(?:(?:sure|ok(?:ay)?)[,.!]?[ \t]+)?(?:here(?:'s| is)|below is|the completion is|completion|answer|final(?: answer)?)(?:[^\n:]*):[ \t]*/i,
    "",
  )
  if (text === input) return input
  return text.replace(/^\r?\n/, "")
}

function stripLeadingMetaLines(input: string) {
  const normalized = input.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
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
  if (text.split(/\r?\n/).every((line) => !line.trim() || isMetaLine(line.trim()))) return ""
  return text
}

function isMetaLine(input: string) {
  if (!input) return false
  if (looksLikePromptLeak(input)) return true
  if (/^(?:sure|ok(?:ay)?)[,.!]?$/i.test(input)) return true
  if (/^(?:here(?:'s| is)|below is|the completion is|completion|answer|final(?: answer)?)(?:[^\n:]*):?$/i.test(input)) return true
  if (/^```[a-zA-Z0-9_-]*$/.test(input) || input === "```") return true
  return false
}

function looksLikePromptLeak(input: string) {
  return PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(input))
}
