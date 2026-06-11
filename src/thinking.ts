import type { ChipMatePart } from "./types"

export function splitThinkingFromParts(parts: ChipMatePart[]) {
  const text: string[] = []
  const reasoning: string[] = []

  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (!("text" in part) || typeof part.text !== "string") continue

    if (part.type === "reasoning") {
      const trimmed = part.text.trim()
      if (trimmed) reasoning.push(trimmed)
      continue
    }

    const split = extractThinkBlocks(part.text)
    if (split.text) text.push(split.text)
    reasoning.push(...split.thinking)
  }

  return {
    text: text.join(""),
    reasoning: reasoning.join("\n\n").trim(),
  }
}

export function extractThinkBlocks(input: string) {
  const thinking: string[] = []
  const text = input.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, content: string) => {
    const trimmed = content.trim()
    if (trimmed) thinking.push(trimmed)
    return ""
  })

  return {
    text,
    thinking,
  }
}
