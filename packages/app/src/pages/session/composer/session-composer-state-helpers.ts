import type { Part, QuestionRequest } from "@opencode-ai/sdk/v2"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
  stale?: boolean
}): "hide" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live || input.stale) return "hide"
  if (!input.done) return "open"
  return "close"
}

export function planExitQuestionRequest(
  request: QuestionRequest | undefined,
  parts: Record<string, Part[] | undefined>,
) {
  const tool = request?.tool
  if (!tool) return
  const match = parts[tool.messageID]?.find((part) => part.type === "tool" && part.callID === tool.callID)
  if (match?.type !== "tool") return
  if (match.tool !== "plan_exit") return
  return request
}
