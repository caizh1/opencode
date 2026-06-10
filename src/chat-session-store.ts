import { randomUUID } from "node:crypto"
import type { OpenAIChatMessage } from "./openai-chat-client"

export type ChatSessionMessage = OpenAIChatMessage & {
  id: string
  createdAt: number
}

export type ChatSessionRecord = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatSessionMessage[]
  metadata?: Record<string, unknown>
}

export type ChatSessionStoreSnapshot = {
  schemaVersion: 1
  sessions: ChatSessionRecord[]
}

export type ChatSessionStorage = {
  read(): Promise<ChatSessionStoreSnapshot | undefined>
  write(snapshot: ChatSessionStoreSnapshot): Promise<void>
}

export class ChatSessionStore {
  constructor(private readonly storage: ChatSessionStorage) {}

  async listSessions() {
    const snapshot = await this.snapshot()
    return [...snapshot.sessions].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async getSession(id: string) {
    const snapshot = await this.snapshot()
    return snapshot.sessions.find((session) => session.id === id)
  }

  async createSession(input: {
    title?: string
    metadata?: Record<string, unknown>
    now?: number
  } = {}) {
    const snapshot = await this.snapshot()
    const now = input.now ?? Date.now()
    const session: ChatSessionRecord = {
      id: randomUUID(),
      title: input.title?.trim() || "ChipMate chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
      metadata: input.metadata,
    }
    await this.storage.write({
      ...snapshot,
      sessions: [session, ...snapshot.sessions],
    })
    return session
  }

  async appendMessage(sessionID: string, message: OpenAIChatMessage & {
    id?: string
    createdAt?: number
  }) {
    const snapshot = await this.snapshot()
    const now = message.createdAt ?? Date.now()
    const nextMessage: ChatSessionMessage = {
      ...message,
      id: message.id ?? randomUUID(),
      createdAt: now,
    }
    let found = false
    const sessions = snapshot.sessions.map((session) => {
      if (session.id !== sessionID) return session
      found = true
      return {
        ...session,
        updatedAt: now,
        messages: [...session.messages, nextMessage],
      }
    })
    if (!found) throw new Error(`Chat session not found: ${sessionID}`)
    await this.storage.write({ ...snapshot, sessions })
    return nextMessage
  }

  async replaceMessages(sessionID: string, messages: OpenAIChatMessage[], now = Date.now()) {
    const snapshot = await this.snapshot()
    let found = false
    const sessions = snapshot.sessions.map((session) => {
      if (session.id !== sessionID) return session
      found = true
      return {
        ...session,
        updatedAt: now,
        messages: messages.map((message) => ({
          ...message,
          id: randomUUID(),
          createdAt: now,
        })),
      }
    })
    if (!found) throw new Error(`Chat session not found: ${sessionID}`)
    await this.storage.write({ ...snapshot, sessions })
  }

  async deleteSession(sessionID: string) {
    const snapshot = await this.snapshot()
    await this.storage.write({
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.id !== sessionID),
    })
  }

  private async snapshot(): Promise<ChatSessionStoreSnapshot> {
    const snapshot = await this.storage.read()
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.sessions)) {
      return { schemaVersion: 1, sessions: [] }
    }
    return snapshot
  }
}
