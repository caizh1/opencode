import type { ChatContextOptions } from "./types"

export type ChatSendStage = "pending" | "preparing" | "summarizing" | "sending" | "thinking" | "done" | "error"

export type SendStatusView = {
  stage: ChatSendStage
  label: string
  detail?: string
}

export type RenderedChatMessageForMerge = {
  id: string
  role: string
  text: string
  timeCreated?: number
  parts: unknown[]
  sendStatus?: SendStatusView
}

export type PendingChatUserMessage<TMessage extends RenderedChatMessageForMerge = RenderedChatMessageForMerge> = {
  sessionID: string
  fingerprint: string
  text: string
  createdAt: number
  message: TMessage
}

export type ChatSendFingerprintInput = {
  text: string
  options: ChatContextOptions
  mentionedFiles?: Array<{
    uri?: string
    label?: string
    type?: string
    mentionIndex?: number
  }>
  contextItems?: Array<Record<string, unknown>>
}

export function chatSendFingerprint(input: ChatSendFingerprintInput) {
  return stableStringify({
    text: input.text.trim(),
    options: {
      includeSelection: Boolean(input.options.includeSelection),
      includeCurrentFile: Boolean(input.options.includeCurrentFile),
      includeOpenFiles: Boolean(input.options.includeOpenFiles),
      includeDiagnostics: Boolean(input.options.includeDiagnostics),
      includeGitDiff: Boolean(input.options.includeGitDiff),
    },
    mentionedFiles: (input.mentionedFiles ?? [])
      .map((file) => ({
        uri: normalizeUnknownString(file.uri),
        label: normalizeUnknownString(file.label),
        type: normalizeUnknownString(file.type),
        mentionIndex: Number.isFinite(file.mentionIndex) ? file.mentionIndex : undefined,
      }))
      .sort((left, right) => `${left.mentionIndex ?? 0}:${left.uri}:${left.label}`.localeCompare(`${right.mentionIndex ?? 0}:${right.uri}:${right.label}`)),
    contextItems: (input.contextItems ?? [])
      .map((item) => contextFingerprintItem(item))
      .sort((left, right) => left.key.localeCompare(right.key)),
  })
}

export function mergeRenderedChatMessages<TMessage extends RenderedChatMessageForMerge>(input: {
  remoteMessages: TMessage[]
  pendingMessages: Array<PendingChatUserMessage<TMessage>>
}) {
  const matchedPendingIDs = new Set<string>()
  const unmatchedPending = input.pendingMessages.filter((pending) => {
    const matched = input.remoteMessages.some((remote) => remoteMatchesPendingUserMessage(remote, pending))
    if (matched) matchedPendingIDs.add(pending.message.id)
    return !matched
  })

  const messages = [...input.remoteMessages, ...unmatchedPending.map((pending) => pending.message)]
    .sort((left, right) => (left.timeCreated ?? 0) - (right.timeCreated ?? 0))

  return { messages, matchedPendingIDs }
}

export function sendStatusForStage(stage: ChatSendStage, detail = ""): SendStatusView {
  switch (stage) {
    case "preparing":
      return { stage, label: "Preparing context", detail }
    case "summarizing":
      return { stage, label: "Summarizing conversation history", detail }
    case "sending":
      return { stage, label: "Sent to model", detail }
    case "thinking":
      return { stage, label: "Thinking", detail }
    case "done":
      return { stage, label: "Sent", detail }
    case "error":
      return { stage, label: "Send failed", detail }
    case "pending":
    default:
      return { stage: "pending", label: "Pending send", detail }
  }
}

function remoteMatchesPendingUserMessage<TMessage extends RenderedChatMessageForMerge>(
  remote: TMessage,
  pending: PendingChatUserMessage<TMessage>,
) {
  if (remote.role !== "user") return false
  if (remote.text !== pending.text) return false
  const remoteCreated = remote.timeCreated ?? 0
  const pendingCreated = pending.createdAt ?? 0
  return remoteCreated >= pendingCreated - 1000
}

function contextFingerprintItem(item: Record<string, unknown>) {
  const uri = item.uri && typeof item.uri === "object" && "toString" in item.uri && typeof item.uri.toString === "function"
    ? item.uri.toString()
    : normalizeUnknownString(item.uri)
  const text = normalizeUnknownString(item.text)
  return {
    key: [
      normalizeUnknownString(item.id),
      normalizeUnknownString(item.kind),
      uri,
      normalizeUnknownString(item.lifetime),
      numberOrEmpty(item.startLine),
      numberOrEmpty(item.endLine),
      text ? stableTextHash(text) : "",
    ].join(":"),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function normalizeUnknownString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function numberOrEmpty(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : ""
}

function stableTextHash(text: string) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
