import type {
  ChipMateEvent,
  ChipMateGlobalEvent,
  ChipMateMessage,
  ChipMateMessageInfo,
  ChipMateMessagePart,
  ChipMateSessionStatus,
} from "./types"

export type ChatStreamApplyResult = {
  messages: ChipMateMessage[]
  changed: boolean
  idle: boolean
  completed: boolean
  refreshSessions: boolean
  sessionID?: string
  error?: string
  retry?: ChipMateSessionStatus
  interruption?: ChipMateSessionStatus
}

export function normalizeChipMateEvent(input: unknown): ChipMateEvent | undefined {
  const root = objectRecord(input)
  const payload = objectRecord((root as ChipMateGlobalEvent).payload)
  const candidate = payload.type ? payload : root
  const type = stringValue(candidate.type)
  if (!type) return
  return {
    type,
    properties: objectRecord(candidate.properties),
  } as ChipMateEvent
}

export function chipMateEventSessionID(event: ChipMateEvent) {
  const properties = objectRecord(event.properties)
  if (event.type === "message.updated") return stringValue(objectRecord(properties.info).sessionID)
  if (event.type === "message.part.updated") return stringValue(objectRecord(properties.part).sessionID)
  if (event.type === "message.part.delta") {
    return stringValue(properties.sessionID) || stringValue(objectRecord(properties.part).sessionID)
  }
  if (event.type === "message.part.removed" || event.type === "message.removed" || event.type === "session.status") {
    return stringValue(properties.sessionID)
  }
  if (event.type === "usage.updated") return stringValue(properties.sessionID)
  if (event.type === "goal.updated" || event.type === "goal.cleared" || event.type === "goal.operation.started" || event.type === "goal.operation.finished") {
    return stringValue(properties.sessionID)
  }
  if (event.type === "session.error") return stringValue(properties.sessionID)
  if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
    return stringValue(objectRecord(properties.info).id)
  }
  return ""
}

export function applyChipMateEventToMessages(
  messages: ChipMateMessage[],
  event: ChipMateEvent,
  targetSessionID: string | undefined,
): ChatStreamApplyResult {
  const relevantSessionID = chipMateEventSessionIDForMessages(event, messages)
  const result = unchanged(messages)
  if (targetSessionID && relevantSessionID && relevantSessionID !== targetSessionID) return result
  if (targetSessionID && isMessageMutationEvent(event.type) && !relevantSessionID) return result

  switch (event.type) {
    case "message.updated": {
      const info = messageInfoFromEvent(event)
      if (!info) return result
      return {
        ...result,
        sessionID: relevantSessionID,
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
        sessionID: relevantSessionID,
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
        sessionID: relevantSessionID,
        messages: upsertMessagePart(messages, part, textValue(properties.delta)),
        changed: true,
      }
    }
    case "message.part.delta": {
      const properties = objectRecord(event.properties)
      const part = messagePartFromDeltaEvent(properties, relevantSessionID)
      const delta = textValue(properties.delta) || textValue(properties.text)
      if (!part?.messageID || !part.id || !delta) return result
      return {
        ...result,
        sessionID: relevantSessionID,
        messages: upsertMessagePart(messages, part, delta),
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
        sessionID: relevantSessionID,
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
      } as ChipMateSessionStatus
      return {
        ...result,
        sessionID: relevantSessionID,
        idle: type === "idle",
        retry: type === "retry" ? normalizedStatus : undefined,
        interruption: type === "error" && status.interrupted === true ? normalizedStatus : undefined,
      }
    }
    case "session.error":
      return {
        ...result,
        sessionID: relevantSessionID,
        error: sessionErrorMessage(objectRecord(event.properties).error),
      }
    case "goal.updated":
    case "goal.cleared":
    case "goal.operation.started":
    case "goal.operation.finished":
      return {
        ...result,
        sessionID: relevantSessionID,
        changed: true,
      }
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return {
        ...result,
        sessionID: relevantSessionID,
        refreshSessions: true,
      }
    default:
      return result
  }
}

function unchanged(messages: ChipMateMessage[]): ChatStreamApplyResult {
  return {
    messages,
    changed: false,
    idle: false,
    completed: false,
    refreshSessions: false,
  }
}

function chipMateEventSessionIDForMessages(event: ChipMateEvent, messages: ChipMateMessage[]) {
  const direct = chipMateEventSessionID(event)
  if (direct) return direct
  const properties = objectRecord(event.properties)
  if (event.type === "message.updated") {
    const messageID = stringValue(objectRecord(properties.info).id)
    return sessionIDForBufferedMessage(messages, messageID)
  }
  if (event.type === "message.part.updated") {
    const part = objectRecord(properties.part)
    return sessionIDForBufferedMessage(messages, stringValue(part.messageID), stringValue(part.id))
  }
  if (event.type === "message.part.delta") {
    const part = objectRecord(properties.part)
    return sessionIDForBufferedMessage(
      messages,
      stringValue(part.messageID) || stringValue(properties.messageID),
      stringValue(part.id) || stringValue(properties.partID),
    )
  }
  if (event.type === "message.part.removed") {
    return sessionIDForBufferedMessage(messages, stringValue(properties.messageID), stringValue(properties.partID))
  }
  if (event.type === "message.removed") {
    return sessionIDForBufferedMessage(messages, stringValue(properties.messageID))
  }
  return ""
}

function sessionIDForBufferedMessage(messages: ChipMateMessage[], messageID: string, partID = "") {
  if (!messageID) return ""
  const message = messages.find((item) => item.info.id === messageID)
  if (!message) return ""
  const messageSessionID = stringValue(message.info.sessionID)
  if (messageSessionID) return messageSessionID
  if (!partID) return ""
  const part = message.parts.find((item) => stringValue(objectRecord(item).id) === partID)
  return stringValue(objectRecord(part).sessionID)
}

function isMessageMutationEvent(type: string) {
  return type === "message.updated" ||
    type === "message.removed" ||
    type === "message.part.updated" ||
    type === "message.part.delta" ||
    type === "message.part.removed"
}

function messageInfoFromEvent(event: ChipMateEvent): ChipMateMessageInfo | undefined {
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
  } as ChipMateMessageInfo
}

function messagePartFromEvent(input: unknown): ChipMateMessagePart | undefined {
  const part = objectRecord(input)
  const type = stringValue(part.type)
  if (!type) return
  return {
    ...part,
    type,
    id: stringValue(part.id) || undefined,
    sessionID: stringValue(part.sessionID) || undefined,
    messageID: stringValue(part.messageID) || undefined,
  } as ChipMateMessagePart
}

function messagePartFromDeltaEvent(
  properties: Record<string, unknown>,
  sessionID: string | undefined,
): ChipMateMessagePart | undefined {
  const partPayload = objectRecord(properties.part)
  const type = stringValue(partPayload.type) || stringValue(properties.type) || "text"
  const id = stringValue(partPayload.id) || stringValue(properties.partID)
  const messageID = stringValue(partPayload.messageID) || stringValue(properties.messageID)
  if (!id || !messageID) return
  return {
    ...partPayload,
    type,
    id,
    messageID,
    sessionID: stringValue(partPayload.sessionID) || stringValue(properties.sessionID) || sessionID,
  } as ChipMateMessagePart
}

function upsertMessageInfo(messages: ChipMateMessage[], info: ChipMateMessageInfo) {
  const index = messages.findIndex((message) => message.info.id === info.id)
  if (index === -1) return [...messages, { info, parts: [] }]
  return messages.map((message, messageIndex) =>
    messageIndex === index ? { ...message, info: { ...message.info, ...info } } : message,
  )
}

function upsertMessagePart(messages: ChipMateMessage[], part: ChipMateMessagePart, delta: string) {
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
        partIndex === existingPartIndex ? mergePart(existing as ChipMateMessagePart, part, delta) : existing,
      ),
    }
  })
}

function mergePart(existing: ChipMateMessagePart | undefined, part: ChipMateMessagePart, delta: string): ChipMateMessagePart {
  const merged = {
    ...(existing ?? {}),
    ...part,
  } as Record<string, unknown>

  if (delta && (part.type === "text" || part.type === "reasoning")) {
    const incomingText = textValue(objectRecord(part).text)
    const existingText = textValue(objectRecord(existing).text)
    merged.text = incomingText && incomingText.length >= existingText.length ? incomingText : `${existingText}${delta}`
  }

  return merged as ChipMateMessagePart
}

function normalizeMessageError(input: unknown) {
  const error = objectRecord(input)
  const message = stringValue(error.message) || stringValue(objectRecord(error.data).message)
  if (!message && Object.keys(error).length === 0) return undefined
  return {
    ...error,
    message,
  } as ChipMateMessageInfo["error"]
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

function textValue(input: unknown) {
  return typeof input === "string" ? input : ""
}
