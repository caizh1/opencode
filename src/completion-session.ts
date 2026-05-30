import type { OpenCodeMessage, OpenCodeSession } from "./types"

export const INLINE_COMPLETION_SESSION_TITLE = "VS Code inline completion"

const INLINE_COMPLETION_PROMPT_MARKERS = [
  "You are an inline code completion engine.",
  "<prefix>",
  "<suffix>",
  "</file>",
]

export function isInlineCompletionSession(session: Pick<OpenCodeSession, "title"> | undefined): boolean {
  return session?.title?.trim() === INLINE_COMPLETION_SESSION_TITLE
}

export function isInlineCompletionMessage(message: OpenCodeMessage | undefined): boolean {
  if (!message) return false
  if (message.info.role === "assistant") return false

  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text]
      return []
    })
    .join("")

  return INLINE_COMPLETION_PROMPT_MARKERS.every((marker) => text.includes(marker))
}
