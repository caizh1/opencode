import type { ChipMateMessage, ChipMateSession } from "./types"

export const CHAT_SESSION_TITLE = "VS Code chat"

const PLUGIN_CHAT_PROMPT_PREFIX = "User question:\n"
const PLUGIN_CHAT_PROMPT_CONTEXT_MARKERS = [
  "\n\nLocal Context Contract:",
  "\n\nImportant local-context rule:",
  "\n\nLocal workspace context:",
  "\n\nLocal code graph evidence:",
  "\n\nLocal analysis evidence pack:",
  "\n\nEnabled ChipMate skills:",
]

export function isPluginChatSession(session: Pick<ChipMateSession, "title"> | undefined): boolean {
  return session?.title?.trim() === CHAT_SESSION_TITLE
}

export function isPluginChatMessage(message: ChipMateMessage | undefined): boolean {
  if (!message) return false
  if (message.info.role !== "user") return false

  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text]
      return []
    })
    .join("")

  return text.startsWith(PLUGIN_CHAT_PROMPT_PREFIX)
}

export function extractPluginChatQuestionText(text: string) {
  if (!text.startsWith(PLUGIN_CHAT_PROMPT_PREFIX)) return text.trim()
  const body = text.slice(PLUGIN_CHAT_PROMPT_PREFIX.length)
  const markerIndex = PLUGIN_CHAT_PROMPT_CONTEXT_MARKERS
    .map((marker) => body.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0]
  const question = markerIndex === undefined ? body : body.slice(0, markerIndex)
  return question.trim()
}
