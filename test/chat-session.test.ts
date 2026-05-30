import { describe, expect, test } from "bun:test"
import { CHAT_SESSION_TITLE, isPluginChatMessage, isPluginChatSession } from "../src/chat-session"
import type { OpenCodeMessage, OpenCodePart, OpenCodeSession } from "../src/types"

describe("plugin chat session detection", () => {
  test("recognizes plugin chat sessions by title", () => {
    expect(isPluginChatSession(session(CHAT_SESSION_TITLE))).toBe(true)
  })

  test("does not treat ordinary OpenCode sessions as plugin chat sessions", () => {
    expect(isPluginChatSession(session("Test Remote OpenCode Session"))).toBe(false)
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
})

function session(title: string): OpenCodeSession {
  return {
    id: `session-${title}`,
    title,
  }
}

function message(role: "user" | "assistant", parts: OpenCodePart[]): OpenCodeMessage {
  return {
    info: { id: "message", role },
    parts,
  }
}
