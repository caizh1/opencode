import { splitThinkingFromParts } from "./thinking"
import type { OpenCodeMessage } from "./types"

const PROMPT_LEAK_PATTERNS = [
  /\blet me re-?read\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper prompt\b/i,
  /\bplan mode\b/i,
  /\binline code completion engine\b/i,
  /\breturn only the exact text to insert at the cursor\b/i,
]

export function completionInsertText(message: OpenCodeMessage | undefined): string {
  if (!message) return ""

  const text = cleanupCompletion(splitThinkingFromParts(message.parts).text)
  if (looksLikePromptLeak(text)) return ""
  return text
}

function cleanupCompletion(input: string) {
  let text = input
  text = text.replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n)?/, "").replace(/(?:\r?\n)?[ \t]*```[ \t]*$/, "")
  text = text.replace(/^Here is.*?:\s*/i, "")
  return text.replace(/\s+$/, "")
}

function looksLikePromptLeak(input: string) {
  return PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(input))
}
