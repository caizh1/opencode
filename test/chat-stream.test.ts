import { describe, expect, test } from "bun:test"
import { applyChipMateEventToMessages, normalizeChipMateEvent } from "../src/chat-stream"
import type { ChipMateEvent, ChipMateMessage } from "../src/types"

describe("chat stream events", () => {
  test("normalizes wrapped and raw ChipMate events", () => {
    expect(
      normalizeChipMateEvent({
        payload: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1" } } },
      }),
    ).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "m1", sessionID: "s1" } },
    })

    expect(normalizeChipMateEvent({ type: "server.connected", properties: {} })).toMatchObject({
      type: "server.connected",
    })
    expect(normalizeChipMateEvent({ payload: { properties: {} } })).toBeUndefined()
  })

  test("updates messages and appends text deltas", () => {
    let messages: ChipMateMessage[] = []
    let result = applyChipMateEventToMessages(messages, messageUpdated("s1", "m1"), "s1")

    expect(result.changed).toBe(true)
    expect(result.messages[0]?.info).toMatchObject({ id: "m1", role: "assistant" })

    result = applyChipMateEventToMessages(
      result.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Hel" }, "Hel"),
      "s1",
    )
    messages = result.messages
    expect(textOf(messages[0]?.parts[0])).toBe("Hel")

    result = applyChipMateEventToMessages(
      messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "" }, "lo"),
      "s1",
    )
    expect(textOf(result.messages[0]?.parts[0])).toBe("Hello")
  })

  test("applies message.part.delta events from part payloads and flat payloads", () => {
    let result = applyChipMateEventToMessages([], messageUpdated("s1", "m1"), "s1")
    result = applyChipMateEventToMessages(
      result.messages,
      partDelta({ part: { id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, delta: "Hel" }),
      "s1",
    )
    result = applyChipMateEventToMessages(
      result.messages,
      partDelta({ sessionID: "s1", messageID: "m1", partID: "p1", type: "text", text: " lo" }),
      "s1",
    )

    expect(textOf(result.messages[0]?.parts[0])).toBe("Hel lo")

    result = applyChipMateEventToMessages(
      result.messages,
      partDelta({ sessionID: "s1", messageID: "m1", partID: "p2", type: "reasoning", delta: "thinking" }),
      "s1",
    )
    expect(result.messages[0]?.parts[1]).toMatchObject({ type: "reasoning", text: "thinking" })
  })

  test("ignores message.part.delta events for other sessions or missing identifiers", () => {
    const started = applyChipMateEventToMessages([], messageUpdated("s1", "m1"), "s1")
    const ignoredSession = applyChipMateEventToMessages(
      started.messages,
      partDelta({ sessionID: "s2", messageID: "m2", partID: "p2", type: "text", delta: "nope" }),
      "s1",
    )
    expect(ignoredSession.changed).toBe(false)
    expect(ignoredSession.messages).toBe(started.messages)

    const missingPart = applyChipMateEventToMessages(
      started.messages,
      partDelta({ sessionID: "s1", messageID: "m1", type: "text", delta: "nope" }),
      "s1",
    )
    expect(missingPart.changed).toBe(false)
    expect(missingPart.messages).toBe(started.messages)

    const currentSession = applyChipMateEventToMessages([], messageUpdated("s2", "m-current"), "s2")
    const stalePreviousSessionDelta = applyChipMateEventToMessages(
      currentSession.messages,
      partDelta({ sessionID: "s1", messageID: "m1", partID: "p1", type: "text", delta: "old answer" }),
      "s2",
    )
    expect(stalePreviousSessionDelta.changed).toBe(false)
    expect(stalePreviousSessionDelta.messages).toBe(currentSession.messages)

    const unownedDelta = applyChipMateEventToMessages(
      [],
      partDelta({ messageID: "m1", partID: "p1", type: "text", delta: "unowned" }),
      "s1",
    )
    expect(unownedDelta.changed).toBe(false)
    expect(unownedDelta.messages).toHaveLength(0)
  })

  test("infers session ownership for sessionless deltas from existing buffered messages", () => {
    let result = applyChipMateEventToMessages([], messageUpdated("s1", "m1"), "s1")
    result = applyChipMateEventToMessages(
      result.messages,
      partDelta({ messageID: "m1", partID: "p1", type: "text", delta: "owned" }),
      "s1",
    )

    expect(result.changed).toBe(true)
    expect(result.sessionID).toBe("s1")
    expect(result.messages[0]?.info.sessionID).toBe("s1")
    expect(result.messages[0]?.parts[0]).toMatchObject({ id: "p1", sessionID: "s1", text: "owned" })
  })

  test("keeps tool and reasoning parts structured", () => {
    let result = applyChipMateEventToMessages([], messageUpdated("s1", "m1"), "s1")
    result = applyChipMateEventToMessages(
      result.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning", text: "thinking" }, "thinking"),
      "s1",
    )
    result = applyChipMateEventToMessages(
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
    const result = applyChipMateEventToMessages(
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
    const started = applyChipMateEventToMessages([], messageUpdated("s1", "m1"), "s1")
    const withPart = applyChipMateEventToMessages(
      started.messages,
      partUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hello" }),
      "s1",
    )

    const ignored = applyChipMateEventToMessages(
      withPart.messages,
      partUpdated({ id: "p2", sessionID: "s2", messageID: "m2", type: "text", text: "nope" }),
      "s1",
    )
    expect(ignored.changed).toBe(false)
    expect(ignored.messages).toBe(withPart.messages)

    const removed = applyChipMateEventToMessages(
      withPart.messages,
      { type: "message.part.removed", properties: { sessionID: "s1", messageID: "m1", partID: "p1" } },
      "s1",
    )
    expect(removed.messages[0]?.parts).toHaveLength(0)
  })

  test("reports idle, completed, and session errors", () => {
    expect(
      applyChipMateEventToMessages([], { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }, "s1").idle,
    ).toBe(true)

    expect(
      applyChipMateEventToMessages([], {
        type: "session.error",
        properties: { sessionID: "s1", error: { data: { message: "boom" } } },
      }, "s1").error,
    ).toBe("boom")

    expect(
      applyChipMateEventToMessages([], {
        type: "message.updated",
        properties: { info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1, completed: 2 } } },
      }, "s1").completed,
    ).toBe(true)
  })

  test("reports ChipMate session retry statuses", () => {
    const result = applyChipMateEventToMessages(
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

  test("reports interrupted ChipMate session error statuses", () => {
    const result = applyChipMateEventToMessages(
      [],
      {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: { type: "error", interrupted: true, message: "stream closed before completion marker" },
        },
      },
      "s1",
    )

    expect(result.interruption).toMatchObject({
      type: "error",
      interrupted: true,
      message: "stream closed before completion marker",
    })
  })
})

function messageUpdated(sessionID: string, messageID: string): ChipMateEvent {
  return {
    type: "message.updated",
    properties: { info: { id: messageID, sessionID, role: "assistant", time: { created: 1 } } },
  }
}

function partUpdated(part: Record<string, unknown>, delta?: string): ChipMateEvent {
  return {
    type: "message.part.updated",
    properties: { part, delta },
  }
}

function partDelta(properties: Record<string, unknown>): ChipMateEvent {
  return {
    type: "message.part.delta",
    properties,
  }
}

function textOf(part: unknown) {
  return part && typeof part === "object" && "text" in part ? part.text : undefined
}
