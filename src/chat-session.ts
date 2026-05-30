import type { OpenCodeMessage, OpenCodeSession } from "./types"

export const CHAT_SESSION_TITLE = "VS Code chat"

const PLUGIN_CHAT_PROMPT_PREFIX = "User question:\n"

export function isPluginChatSession(session: Pick<OpenCodeSession, "title"> | undefined): boolean {
  return session?.title?.trim() === CHAT_SESSION_TITLE
}

export function isPluginChatMessage(message: OpenCodeMessage | undefined): boolean {
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
