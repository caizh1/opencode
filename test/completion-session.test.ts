import { describe, expect, test } from "bun:test"
import {
  INLINE_COMPLETION_SESSION_TITLE,
  isInlineCompletionMessage,
  isInlineCompletionSession,
} from "../src/completion-session"
import type { OpenCodeMessage, OpenCodePart, OpenCodeSession } from "../src/types"

describe("inline completion session detection", () => {
  test("recognizes inline completion sessions by title", () => {
    expect(isInlineCompletionSession(session(INLINE_COMPLETION_SESSION_TITLE))).toBe(true)
  })

  test("does not treat normal chat sessions as completion sessions", () => {
    expect(isInlineCompletionSession(session("VS Code chat"))).toBe(false)
  })

  test("recognizes persisted inline completion prompts", () => {
    expect(
      isInlineCompletionMessage(message("user", [
        {
          type: "text",
          text: [
            "You are an inline code completion engine.",
            '<file path="test.c" language="c">',
            "<prefix>",
            "int add()",
            "</prefix>",
            "<suffix>",
            "</suffix>",
            "</file>",
          ].join("\n"),
        },
      ])),
    ).toBe(true)
  })

  test("does not treat normal chat messages as completion prompts", () => {
    expect(isInlineCompletionMessage(message("user", [{ type: "text", text: "Please explain this file." }]))).toBe(false)
  })

  test("does not treat assistant responses as completion prompts", () => {
    expect(
      isInlineCompletionMessage(message("assistant", [
        {
          type: "text",
          text: "You are an inline code completion engine. <prefix> <suffix> </file>",
        },
      ])),
    ).toBe(false)
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
