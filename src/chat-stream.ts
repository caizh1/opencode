import type {
  OpenCodeEvent,
  OpenCodeGlobalEvent,
  OpenCodeMessage,
  OpenCodeMessageInfo,
  OpenCodeMessagePart,
  OpenCodeSessionStatus,
} from "./types"

export type ChatStreamApplyResult = {
  messages: OpenCodeMessage[]
  changed: boolean
  idle: boolean
  completed: boolean
  refreshSessions: boolean
  error?: string
  retry?: OpenCodeSessionStatus
}

export function normalizeOpenCodeEvent(input: unknown): OpenCodeEvent | undefined {
  const root = objectRecord(input)
  const payload = objectRecord((root as OpenCodeGlobalEvent).payload)
  const candidate = payload.type ? payload : root
  const type = stringValue(candidate.type)
  if (!type) return
  return {
    type,
    properties: objectRecord(candidate.properties),
  } as OpenCodeEvent
}

export function openCodeEventSessionID(event: OpenCodeEvent) {
  const properties = objectRecord(event.properties)
  if (event.type === "message.updated") return stringValue(objectRecord(properties.info).sessionID)
  if (event.type === "message.part.updated") return stringValue(objectRecord(properties.part).sessionID)
  if (event.type === "message.part.removed" || event.type === "message.removed" || event.type === "session.status") {
    return stringValue(properties.sessionID)
  }
  if (event.type === "session.error") return stringValue(properties.sessionID)
  if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
    return stringValue(objectRecord(properties.info).id)
  }
  return ""
}

export function applyOpenCodeEventToMessages(
  messages: OpenCodeMessage[],
  event: OpenCodeEvent,
  currentSessionID: string | undefined,
): ChatStreamApplyResult {
  const relevantSessionID = openCodeEventSessionID(event)
  const result = unchanged(messages)
  if (currentSessionID && relevantSessionID && relevantSessionID !== currentSessionID) return result

  switch (event.type) {
    case "message.updated": {
      const info = messageInfoFromEvent(event)
      if (!info) return result
      return {
        ...result,
        messages: upsertMessageInfo(messages, info),
        changed: true,
        completed: Boolean(info.time?.completed),
      }
    }
    case "message.removed": {
      const messageID = stringValue(objectRecord(event.properties).messageID)
      if (!messageID) return result
      return {
        ...result,
        messages: messages.filter((message) => message.info.id !== messageID),
        changed: messages.some((message) => message.info.id === messageID),
      }
    }
    case "message.part.updated": {
      const properties = objectRecord(event.properties)
      const part = messagePartFromEvent(properties.part)
      if (!part?.messageID) return result
      return {
        ...result,
        messages: upsertMessagePart(messages, part, stringValue(properties.delta)),
        changed: true,
      }
    }
    case "message.part.removed": {
      const properties = objectRecord(event.properties)
      const messageID = stringValue(properties.messageID)
      const partID = stringValue(properties.partID)
      if (!messageID || !partID) return result
      const next = messages.map((message) =>
        message.info.id === messageID
          ? { ...message, parts: message.parts.filter((part) => partID !== stringValue(objectRecord(part).id)) }
          : message,
      )
      return {
        ...result,
        messages: next,
        changed: next !== messages,
      }
    }
    case "session.status": {
      const status = objectRecord(objectRecord(event.properties).status)
      const type = stringValue(status.type)
      const normalizedStatus = {
        ...status,
        type,
      } as OpenCodeSessionStatus
      return {
        ...result,
        idle: type === "idle",
        retry: type === "retry" ? normalizedStatus : undefined,
      }
    }
    case "session.error":
      return {
        ...result,
        error: sessionErrorMessage(objectRecord(event.properties).error),
      }
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return {
        ...result,
        refreshSessions: true,
      }
    default:
      return result
  }
}

function unchanged(messages: OpenCodeMessage[]): ChatStreamApplyResult {
  return {
    messages,
    changed: false,
    idle: false,
    completed: false,
    refreshSessions: false,
  }
}

function messageInfoFromEvent(event: OpenCodeEvent): OpenCodeMessageInfo | undefined {
  const info = objectRecord(objectRecord(event.properties).info)
  const id = stringValue(info.id)
  if (!id) return
  return {
    ...info,
    id,
    sessionID: stringValue(info.sessionID) || undefined,
    role: info.role === "user" || info.role === "assistant" ? info.role : undefined,
    time: objectRecord(info.time),
    error: normalizeMessageError(info.error),
  } as OpenCodeMessageInfo
}

function messagePartFromEvent(input: unknown): OpenCodeMessagePart | undefined {
  const part = objectRecord(input)
  const type = stringValue(part.type)
  if (!type) return
  return {
    ...part,
    type,
    id: stringValue(part.id) || undefined,
    sessionID: stringValue(part.sessionID) || undefined,
    messageID: stringValue(part.messageID) || undefined,
  } as OpenCodeMessagePart
}

function upsertMessageInfo(messages: OpenCodeMessage[], info: OpenCodeMessageInfo) {
  const index = messages.findIndex((message) => message.info.id === info.id)
  if (index === -1) return [...messages, { info, parts: [] }]
  return messages.map((message, messageIndex) =>
    messageIndex === index ? { ...message, info: { ...message.info, ...info } } : message,
  )
}

function upsertMessagePart(messages: OpenCodeMessage[], part: OpenCodeMessagePart, delta: string) {
  const messageID = part.messageID
  if (!messageID) return messages
  const index = messages.findIndex((message) => message.info.id === messageID)
  if (index === -1) {
    return [
      ...messages,
      {
        info: {
          id: messageID,
          sessionID: part.sessionID,
          role: "assistant" as const,
        },
        parts: [mergePart(undefined, part, delta)],
      },
    ]
  }

  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) return message
    const partID = stringValue(objectRecord(part).id)
    const existingPartIndex = partID
      ? message.parts.findIndex((existing) => stringValue(objectRecord(existing).id) === partID)
      : -1
    if (existingPartIndex === -1) {
      return {
        ...message,
        parts: [...message.parts, mergePart(undefined, part, delta)],
      }
    }
    return {
      ...message,
      parts: message.parts.map((existing, partIndex) =>
        partIndex === existingPartIndex ? mergePart(existing as OpenCodeMessagePart, part, delta) : existing,
      ),
    }
  })
}

function mergePart(existing: OpenCodeMessagePart | undefined, part: OpenCodeMessagePart, delta: string): OpenCodeMessagePart {
  const merged = {
    ...(existing ?? {}),
    ...part,
  } as Record<string, unknown>

  if (delta && (part.type === "text" || part.type === "reasoning")) {
    const incomingText = stringValue(objectRecord(part).text)
    const existingText = stringValue(objectRecord(existing).text)
    merged.text = incomingText && incomingText.length >= existingText.length ? incomingText : `${existingText}${delta}`
  }

  return merged as OpenCodeMessagePart
}

function normalizeMessageError(input: unknown) {
  const error = objectRecord(input)
  const message = stringValue(error.message) || stringValue(objectRecord(error.data).message)
  if (!message && Object.keys(error).length === 0) return undefined
  return {
    ...error,
    message,
  } as OpenCodeMessageInfo["error"]
}

function sessionErrorMessage(input: unknown) {
  const error = objectRecord(input)
  return stringValue(error.message) || stringValue(objectRecord(error.data).message) || stringValue(error.name) || "Remote session error"
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}
