import { describe, expect, test } from "bun:test"
import { CHAT_SESSION_TITLE, extractPluginChatQuestionText, isPluginChatMessage, isPluginChatSession } from "../src/chat-session"
import type { ChipMateMessage, ChipMatePart, ChipMateSession } from "../src/types"

describe("plugin chat session detection", () => {
  test("recognizes plugin chat sessions by title", () => {
    expect(isPluginChatSession(session(CHAT_SESSION_TITLE))).toBe(true)
  })

  test("does not treat ordinary ChipMate sessions as plugin chat sessions", () => {
    expect(isPluginChatSession(session("Test Remote ChipMate Session"))).toBe(false)
    expect(isPluginChatSession(session("Untitled chat"))).toBe(false)
  })

  test("recognizes plugin chat prompts", () => {
    expect(isPluginChatMessage(message("user", [{ type: "text", text: "User question:\nExplain this file" }]))).toBe(true)
  })

  test("does not treat bare external prompts as plugin chat prompts", () => {
    expect(
      isPluginChatMessage(message("user", [{ type: "text", text: "Very thorough exploration of the test files." }])),
    ).toBe(false)
  })

  test("does not treat assistant messages as plugin chat prompts", () => {
    expect(isPluginChatMessage(message("assistant", [{ type: "text", text: "User question:\nExplain this file" }]))).toBe(false)
  })

  test("extracts the original question from a packed plugin prompt", () => {
    expect(
      extractPluginChatQuestionText([
        "User question:",
        "继续讲上一个问题",
        "",
        "Local workspace context:",
        "old file context",
        "",
        "Local code graph evidence:",
        "old graph evidence",
      ].join("\n")),
    ).toBe("继续讲上一个问题")
  })
})

function session(title: string): ChipMateSession {
  return {
    id: `session-${title}`,
    title,
  }
}

function message(role: "user" | "assistant", parts: ChipMatePart[]): ChipMateMessage {
  return {
    info: { id: "message", role },
    parts,
  }
}
