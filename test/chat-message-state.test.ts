import { describe, expect, test } from "bun:test"
import {
  chatSendFingerprint,
  mergeRenderedChatMessages,
  sendStatusForStage,
  type PendingChatUserMessage,
  type RenderedChatMessageForMerge,
} from "../src/chat-message-state"

describe("chat message pending state", () => {
  test("keeps a pending user message when refresh has not returned it yet", () => {
    const pending = pendingUser("local-1", "inspect this", 2000)
    const result = mergeRenderedChatMessages({
      remoteMessages: [assistant("assistant-1", "previous", 1000)],
      pendingMessages: [pending],
    })

    expect(result.messages.map((message) => message.id)).toEqual(["assistant-1", "local-1"])
    expect(result.matchedPendingIDs.size).toBe(0)
  })

  test("removes pending once the remote user message catches up", () => {
    const pending = pendingUser("local-1", "inspect this", 2000)
    const remote = user("remote-1", "inspect this", 2100)
    const result = mergeRenderedChatMessages({
      remoteMessages: [remote],
      pendingMessages: [pending],
    })

    expect(result.messages.map((message) => message.id)).toEqual(["remote-1"])
    expect(result.matchedPendingIDs.has("local-1")).toBe(true)
  })

  test("does not treat an older same-text history message as the active pending send", () => {
    const pending = pendingUser("local-1", "same question", 5000)
    const result = mergeRenderedChatMessages({
      remoteMessages: [user("remote-old", "same question", 1000)],
      pendingMessages: [pending],
    })

    expect(result.messages.map((message) => message.id)).toEqual(["remote-old", "local-1"])
    expect(result.matchedPendingIDs.size).toBe(0)
  })

  test("uses context and attachment shape in duplicate fingerprints", () => {
    const base = {
      text: "inspect",
      options: {
        includeSelection: true,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: true,
        includeGitDiff: false,
      },
      mentionedFiles: [{ uri: "file:///a.ts", label: "a.ts", type: "file" }],
      contextItems: [{ id: "file:a", kind: "file", uri: "file:///a.ts", lifetime: "one-shot" }],
    }

    expect(chatSendFingerprint(base)).toBe(chatSendFingerprint({ ...base }))
    expect(chatSendFingerprint(base)).not.toBe(chatSendFingerprint({
      ...base,
      mentionedFiles: [{ uri: "file:///b.ts", label: "b.ts", type: "file" }],
    }))
    expect(chatSendFingerprint(base)).not.toBe(chatSendFingerprint({
      ...base,
      options: { ...base.options, includeGitDiff: true },
    }))
  })

  test("maps send stages to user-facing labels", () => {
    expect(sendStatusForStage("preparing").label).toBe("Preparing context")
    expect(sendStatusForStage("summarizing").label).toBe("Summarizing conversation history")
    expect(sendStatusForStage("sending").label).toBe("Sent to model")
    expect(sendStatusForStage("thinking").label).toBe("Thinking")
  })
})

function pendingUser(id: string, text: string, createdAt: number): PendingChatUserMessage {
  return {
    sessionID: "s1",
    fingerprint: `fp-${id}`,
    text,
    createdAt,
    message: {
      id,
      role: "user",
      text,
      timeCreated: createdAt,
      parts: [{ type: "text", text }],
      sendStatus: sendStatusForStage("preparing"),
    },
  }
}

function user(id: string, text: string, timeCreated: number): RenderedChatMessageForMerge {
  return {
    id,
    role: "user",
    text,
    timeCreated,
    parts: [{ type: "text", text }],
  }
}

function assistant(id: string, text: string, timeCreated: number): RenderedChatMessageForMerge {
  return {
    id,
    role: "assistant",
    text,
    timeCreated,
    parts: [{ type: "text", text }],
  }
}
