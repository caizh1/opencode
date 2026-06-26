import { describe, expect, test } from "bun:test"
import {
  CHAT_SESSION_TITLE,
  classifyChatSessionSource,
  extractPluginChatQuestionText,
  isPluginChatMessage,
  isPluginChatSession,
  pluginHistoryUserText,
} from "../src/chat-session"
import type { ChipMateMessage, ChipMatePart, ChipMateSession } from "../src/types"

describe("plugin chat session detection", () => {
  test("recognizes plugin chat sessions by title", () => {
    expect(isPluginChatSession(session(CHAT_SESSION_TITLE))).toBe(true)
  })

  test("keeps display titles separate from plugin chat session identity", () => {
    expect(isPluginChatSession({
      ...session(CHAT_SESSION_TITLE),
      displayTitle: "历史标题与批量删除",
      displayTitleSource: "model",
    })).toBe(true)
  })

  test("does not treat ordinary ChipMate sessions as plugin chat sessions", () => {
    expect(isPluginChatSession(session("Test Remote ChipMate Session"))).toBe(false)
    expect(isPluginChatSession(session("Untitled chat"))).toBe(false)
  })

  test("recognizes plugin chat prompts", () => {
    expect(isPluginChatMessage(message("user", [{ type: "text", text: "User question:\nExplain this file" }]))).toBe(true)
  })

  test("recognizes explicit plugin chat mode without depending on the text prefix", () => {
    expect(isPluginChatMessage(message("user", [{ type: "text", text: "Explain this file" }], "plugin-chat"))).toBe(true)
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
        "",
        "Local document RAG evidence:",
        "old document evidence",
      ].join("\n")),
    ).toBe("继续讲上一个问题")
  })

  test("wraps direct chat history text with the plugin prompt prefix once", () => {
    expect(pluginHistoryUserText("继续讲上一个问题")).toBe("User question:\n继续讲上一个问题")
    expect(pluginHistoryUserText("User question:\n继续讲上一个问题")).toBe("User question:\n继续讲上一个问题")
  })

  test("classifies plugin, legacy-plugin, and external sessions conservatively", () => {
    expect(classifyChatSessionSource(session(CHAT_SESSION_TITLE), [
      message("user", [{ type: "text", text: "Explain this file" }], "plugin-chat"),
    ])).toBe("plugin")
    expect(classifyChatSessionSource(session(CHAT_SESSION_TITLE), [
      message("user", [{ type: "text", text: "Explain this file" }]),
    ])).toBe("legacy-plugin")
    expect(classifyChatSessionSource(session("External Session"), [
      message("user", [{ type: "text", text: "Explain this file" }]),
    ])).toBe("external")
  })
})

function session(title: string): ChipMateSession {
  return {
    id: `session-${title}`,
    title,
  }
}

function message(role: "user" | "assistant", parts: ChipMatePart[], mode?: string): ChipMateMessage {
  return {
    info: { id: "message", role, mode },
    parts,
  }
}
