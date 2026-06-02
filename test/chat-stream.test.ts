import { describe, expect, test } from "bun:test"
import { applyOpenCodeEventToMessages, normalizeOpenCodeEvent } from "../src/chat-stream"
import type { OpenCodeEvent, OpenCodeMessage } from "../src/types"

describe("chat stream events", () => {
  test("normalizes wrapped and raw OpenCode events", () => {
    expect(
      normalizeOpenCodeEvent({
        payload: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1" } } },
      }),
    ).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "m1", sessionID: "s1" } },
    })

    expect(normalizeOpenCodeEvent({ type: "server.connected", properties: {} })).toMatchObject({
      type: "server.connected",
    })
    expect(normalizeOpenCodeEvent({ payload: { properties: {} } })).toBeUndefined()
  })

  test("updates messages and appends text deltas", () => {
    let messages: OpenCodeMessage[] = []
    let result = applyOpenCodeEventToMessages(messages, messageUpdated("s1", "m1"), "s1")

    expect(result.changed).toBe(true)
    expect(result.messages[0]?.info).toMatchObject({ id: "m1", role: "assistant" })

    result = applyOpenCodeEventToMessages(
      result.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Hel" }, "Hel"),
      "s1",
    )
    messages = result.messages
    expect(textOf(messages[0]?.parts[0])).toBe("Hel")

    result = applyOpenCodeEventToMessages(
      messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "" }, "lo"),
      "s1",
    )
    expect(textOf(result.messages[0]?.parts[0])).toBe("Hello")
  })

  test("keeps tool and reasoning parts structured", () => {
    let result = applyOpenCodeEventToMessages([], messageUpdated("s1", "m1"), "s1")
    result = applyOpenCodeEventToMessages(
      result.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning", text: "thinking" }, "thinking"),
      "s1",
    )
    result = applyOpenCodeEventToMessages(
      result.messages,
      partUpdated({
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "read",
        state: { status: "running", input: { file: "a.ts" } },
      }),
      "s1",
    )

    expect(result.messages[0]?.parts).toMatchObject([
      { type: "reasoning", text: "thinking" },
      { type: "tool", tool: "read", state: { status: "running" } },
    ])
  })

  test("preserves assistant usage fields from message updates", () => {
    const result = applyOpenCodeEventToMessages(
      [],
      {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "s1",
            role: "assistant",
            providerID: "deepseek",
            modelID: "deepseek-v4-pro",
            cost: 0.002,
            tokens: {
              input: 12_400,
              output: 1100,
              reasoning: 300,
              cache: { read: 2000, write: 100 },
            },
          },
        },
      },
      "s1",
    )

    expect(result.messages[0]?.info).toMatchObject({
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      cost: 0.002,
      tokens: {
        input: 12_400,
        output: 1100,
        reasoning: 300,
        cache: { read: 2000, write: 100 },
      },
    })
  })

  test("removes message parts and ignores other sessions", () => {
    const started = applyOpenCodeEventToMessages([], messageUpdated("s1", "m1"), "s1")
    const withPart = applyOpenCodeEventToMessages(
      started.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hello" }),
      "s1",
    )

    const ignored = applyOpenCodeEventToMessages(
      withPart.messages,
      partUpdated({ id: "p2", sessionID: "s2", messageID: "m2", type: "text", text: "nope" }),
      "s1",
    )
    expect(ignored.changed).toBe(false)
    expect(ignored.messages).toBe(withPart.messages)

    const removed = applyOpenCodeEventToMessages(
      withPart.messages,
      { type: "message.part.removed", properties: { sessionID: "s1", messageID: "m1", partID: "p1" } },
      "s1",
    )
    expect(removed.messages[0]?.parts).toHaveLength(0)
  })

  test("reports idle, completed, and session errors", () => {
    expect(
      applyOpenCodeEventToMessages([], { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }, "s1").idle,
    ).toBe(true)

    expect(
      applyOpenCodeEventToMessages([], {
        type: "session.error",
        properties: { sessionID: "s1", error: { data: { message: "boom" } } },
      }, "s1").error,
    ).toBe("boom")

    expect(
      applyOpenCodeEventToMessages([], {
        type: "message.updated",
        properties: { info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1, completed: 2 } } },
      }, "s1").completed,
    ).toBe(true)
  })

  test("reports remote session retry statuses", () => {
    const result = applyOpenCodeEventToMessages(
      [],
      {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: { type: "retry", attempt: 16, message: "Gateway Time-out", next: 1780364586400 },
        },
      },
      "s1",
    )

    expect(result.retry).toMatchObject({
      type: "retry",
      attempt: 16,
      message: "Gateway Time-out",
      next: 1780364586400,
    })
  })
})

function messageUpdated(sessionID: string, messageID: string): OpenCodeEvent {
  return {
    type: "message.updated",
    properties: { info: { id: messageID, sessionID, role: "assistant", time: { created: 1 } } },
  }
}

function partUpdated(part: Record<string, unknown>, delta?: string): OpenCodeEvent {
  return {
    type: "message.part.updated",
    properties: { part, delta },
  }
}

function textOf(part: unknown) {
  return part && typeof part === "object" && "text" in part ? part.text : undefined
}
