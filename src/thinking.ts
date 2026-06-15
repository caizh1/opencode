import type { ChipMatePart } from "./types"

const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"
const THINKING_PREVIEW_MAX_CHARS = 120

export function splitThinkingFromParts(parts: ChipMatePart[]) {
  const text: string[] = []
  const reasoning: string[] = []
  let openThinking = false

  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (!("text" in part) || typeof part.text !== "string") continue

    if (part.type === "reasoning") {
      const trimmed = part.text.trim()
      if (trimmed) reasoning.push(trimmed)
      continue
    }

    const split = parseThinkBlocks(part.text, openThinking)
    if (split.text) text.push(split.text)
    reasoning.push(...split.thinking)
    openThinking = split.openThinking
  }

  return {
    text: text.join(""),
    reasoning: reasoning.join("\n\n").trim(),
    openThinking,
    preview: thinkingPreview(reasoning),
  }
}

export function extractThinkBlocks(input: string) {
  return parseThinkBlocks(input, false)
}

function parseThinkBlocks(input: string, initialOpenThinking: boolean) {
  const thinking: string[] = []
  const text: string[] = []
  const lower = input.toLowerCase()
  let offset = 0
  let openThinking = initialOpenThinking

  while (offset < input.length) {
    if (openThinking) {
      const closeIndex = lower.indexOf(THINK_CLOSE_TAG, offset)
      if (closeIndex === -1) {
        appendThinking(thinking, stripTrailingTagPrefix(input.slice(offset), THINK_CLOSE_TAG))
        return finishThinkParse(text, thinking, true)
      }
      appendThinking(thinking, input.slice(offset, closeIndex))
      offset = closeIndex + THINK_CLOSE_TAG.length
      openThinking = false
      continue
    }

    const openIndex = lower.indexOf(THINK_OPEN_TAG, offset)
    if (openIndex === -1) {
      const remaining = input.slice(offset)
      const partialOpenLength = trailingTagPrefixLength(remaining, THINK_OPEN_TAG)
      if (partialOpenLength > 0) {
        text.push(remaining.slice(0, -partialOpenLength))
        return finishThinkParse(text, thinking, true)
      }
      text.push(remaining)
      return finishThinkParse(text, thinking, false)
    }

    text.push(input.slice(offset, openIndex))
    offset = openIndex + THINK_OPEN_TAG.length
    openThinking = true
  }

  return finishThinkParse(text, thinking, openThinking)
}

function appendThinking(target: string[], value: string) {
  const trimmed = value.trim()
  if (trimmed) target.push(trimmed)
}

function finishThinkParse(text: string[], thinking: string[], openThinking: boolean) {
  return {
    text: text.join(""),
    thinking,
    openThinking,
    preview: thinkingPreview(thinking),
  }
}

function thinkingPreview(chunks: string[]) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const preview = latestThinkingLine(chunks[index])
    if (preview) return truncatePreview(preview, THINKING_PREVIEW_MAX_CHARS)
  }
  return ""
}

function latestThinkingLine(value: string) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const candidate = lines[lines.length - 1] || value.trim()
  return candidate.replace(/\s+/g, " ").trim()
}

function truncatePreview(value: string, maxChars: number) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function stripTrailingTagPrefix(value: string, tag: string) {
  const prefixLength = trailingTagPrefixLength(value, tag)
  return prefixLength > 0 ? value.slice(0, -prefixLength) : value
}

function trailingTagPrefixLength(value: string, tag: string) {
  const lower = value.toLowerCase()
  const lowerTag = tag.toLowerCase()
  const maxLength = Math.min(lower.length, lowerTag.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (lower.endsWith(lowerTag.slice(0, length))) return length
  }
  return 0
}
