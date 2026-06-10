import { describe, expect, test } from "bun:test"
import { ChatSessionStore } from "../src/chat-session-store"
import type { ChatSessionStoreSnapshot, ChatSessionStorage } from "../src/chat-session-store"

describe("ChatSessionStore", () => {
  test("creates sessions, appends messages, and persists snapshots", async () => {
    const storage = memoryStorage()
    const store = new ChatSessionStore(storage)

    const session = await store.createSession({ title: "Bring-up", now: 10 })
    const userMessage = await store.appendMessage(session.id, { role: "user", content: "hi", createdAt: 11 })
    const assistantMessage = await store.appendMessage(session.id, { role: "assistant", content: "hello", createdAt: 12 })

    expect(userMessage.id).toBeTruthy()
    expect(assistantMessage.id).toBeTruthy()
    const loaded = await store.getSession(session.id)
    expect(loaded?.messages.map((message) => message.content)).toEqual(["hi", "hello"])
    expect(loaded?.updatedAt).toBe(12)

    const restored = new ChatSessionStore(storage)
    expect(await restored.listSessions()).toMatchObject([
      { id: session.id, title: "Bring-up" },
    ])
  })

  test("replaces messages and deletes sessions", async () => {
    const store = new ChatSessionStore(memoryStorage())
    const session = await store.createSession({ title: "Chat", now: 1 })

    await store.replaceMessages(session.id, [
      { role: "user", content: "new" },
      { role: "assistant", content: "reply" },
    ], 20)

    expect((await store.getSession(session.id))?.messages.map((message) => message.content)).toEqual(["new", "reply"])
    await store.deleteSession(session.id)
    expect(await store.listSessions()).toHaveLength(0)
  })

  test("throws when appending to a missing session", async () => {
    const store = new ChatSessionStore(memoryStorage())
    await expect(store.appendMessage("missing", { role: "user", content: "hi" })).rejects.toThrow("Chat session not found")
  })
})

function memoryStorage(): ChatSessionStorage {
  let snapshot: ChatSessionStoreSnapshot | undefined
  return {
    async read() {
      return snapshot
    },
    async write(next) {
      snapshot = JSON.parse(JSON.stringify(next)) as ChatSessionStoreSnapshot
    },
  }
}
