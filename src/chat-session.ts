import type { ChipMateMessage, ChipMateSession } from "./types"

export const CHAT_SESSION_TITLE = "VS Code chat"
export const PLUGIN_CHAT_MODE = "plugin-chat"
export const DOC_AGENT_LOCAL_MODE = "doc-agent-local"
export type ChatSessionSource = "plugin" | "legacy-plugin" | "external"

const PLUGIN_CHAT_PROMPT_PREFIX = "User question:\n"
const PLUGIN_CHAT_PROMPT_CONTEXT_MARKERS = [
  "\n\nLocal Context Contract:",
  "\n\nImportant local-context rule:",
  "\n\nLocal workspace context:",
  "\n\nLocal code graph evidence:",
  "\n\nLocal analysis evidence pack:",
  "\n\nLocal document RAG evidence:",
  "\n\nEnabled ChipMate skills:",
]

export function isPluginChatSession(session: Pick<ChipMateSession, "title"> | undefined): boolean {
  return session?.title?.trim() === CHAT_SESSION_TITLE
}

export function pluginHistoryUserText(text: string) {
  const trimmed = text.trim()
  return trimmed.startsWith(PLUGIN_CHAT_PROMPT_PREFIX) ? trimmed : `${PLUGIN_CHAT_PROMPT_PREFIX}${trimmed}`
}

export function isPluginChatMessage(message: ChipMateMessage | undefined): boolean {
  if (!message) return false
  if (message.info.role !== "user") return false
  if (message.info.mode === PLUGIN_CHAT_MODE || message.info.mode === DOC_AGENT_LOCAL_MODE) return true

  const text = messageText(message)

  return text.startsWith(PLUGIN_CHAT_PROMPT_PREFIX)
}

export function classifyChatSessionSource(
  session: Pick<ChipMateSession, "title"> | undefined,
  messages: readonly ChipMateMessage[],
): ChatSessionSource {
  const userMessages = messages.filter((message) => message.info.role === "user")
  if (userMessages.some(isPluginChatMessage)) return "plugin"
  if (userMessages.length === 0) return "plugin"
  if (isPluginChatSession(session)) return "legacy-plugin"
  return "external"
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

function messageText(message: ChipMateMessage) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text]
      return []
    })
    .join("")
}
