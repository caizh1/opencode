export type ExportScope = "session" | "lastAssistant"

export type ExportIntentDecision =
  | {
      intent: "export"
      scope: ExportScope
      filenameHint?: string
    }
  | {
      intent: "chat"
    }

export type ChatExportMessage = {
  role: string
  text: string
  timeCreated?: number
  error?: string
}

export function isExportIntentCandidate(text: string) {
  const input = text.trim()
  if (!input) return false
  return /(^\/export\b|导出|保存|另存|存成|下载|markdown|\.md\b|\bmd\b|\bexport\b|\bsave\b|\bdownload\b)/i.test(input)
}

export function parseExplicitExportCommand(text: string): Extract<ExportIntentDecision, { intent: "export" }> | undefined {
  const match = text.trim().match(/^\/export(?:\s+(.+))?$/i)
  if (!match) return undefined

  const rest = (match[1] || "").trim()
  if (!rest) return { intent: "export", scope: "session" }

  const scope = explicitScope(rest)
  if (scope) {
    const filenameHint = sanitizeFilenameHint(stripExplicitScope(rest, scope))
    return {
      intent: "export",
      scope,
      ...(filenameHint ? { filenameHint } : {}),
    }
  }

  const filenameHint = sanitizeFilenameHint(rest)
  return {
    intent: "export",
    scope: "session",
    ...(filenameHint ? { filenameHint } : {}),
  }
}

export function buildExportIntentPrompt(input: {
  userRequest: string
  sessionTitle?: string
  messages: ChatExportMessage[]
}) {
  const summaries = input.messages
    .filter(isExportableMessage)
    .slice(-8)
    .map((message) => `${exportRoleLabel(message.role)}: ${truncateForPrompt(message.text || message.error || "", 700)}`)
    .join("\n\n")

  return [
    "You classify export intent for the VS Code ChipMate chat extension.",
    "Return only a compact JSON object. Do not include markdown fences or explanation.",
    "",
    "JSON schema:",
    '{"intent":"export"|"chat","scope":"session"|"lastAssistant","filenameHint":"optional markdown filename"}',
    "",
    "Rules:",
    '- Use intent "export" only when the user wants this extension to save chat content as a local Markdown file.',
    '- Use intent "chat" when the user asks about export code, export implementation, Markdown syntax, files, or saving in general.',
    '- Use scope "lastAssistant" only for the latest assistant answer/reply/response. Otherwise use "session".',
    "- filenameHint must be a simple file name, never a path. Omit it if unsure.",
    "",
    `Current session title: ${input.sessionTitle?.trim() || "VS Code chat"}`,
    "",
    "Recent visible chat messages:",
    summaries || "(none)",
    "",
    "User request to classify:",
    input.userRequest.trim(),
  ].join("\n")
}

export function parseExportIntentResponse(text: string): ExportIntentDecision | undefined {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined

  const record = parsed as Record<string, unknown>
  const intent = typeof record.intent === "string" ? record.intent.trim().toLowerCase() : ""
  if (intent === "chat") return { intent: "chat" }
  if (intent !== "export") return undefined

  const scope = normalizeScope(record.scope)
  const filenameHint = sanitizeFilenameHint(typeof record.filenameHint === "string" ? record.filenameHint : "")
  return {
    intent: "export",
    scope: scope ?? "session",
    ...(filenameHint ? { filenameHint } : {}),
  }
}

export function formatChatExportMarkdown(input: {
  messages: ChatExportMessage[]
  scope: ExportScope
  sessionTitle?: string
  exportedAt?: Date
}) {
  const messages = exportMessagesForScope(input.messages, input.scope)
  if (messages.length === 0) return ""

  const exportedAt = input.exportedAt ?? new Date()
  const title = input.sessionTitle?.trim() || "ChipMate chat"
  const lines = [
    "# ChipMate Chat Export",
    "",
    `Session: ${title}`,
    `Scope: ${input.scope === "lastAssistant" ? "Last assistant response" : "Current session"}`,
    `Exported: ${exportedAt.toISOString()}`,
    "",
  ]

  for (const message of messages) {
    const timestamp = formatExportTimestamp(message.timeCreated)
    lines.push(`## ${exportRoleLabel(message.role)}${timestamp ? ` - ${timestamp}` : ""}`, "")
    lines.push(normalizeMarkdownText(message.text || message.error || ""), "")
  }

  return `${lines.join("\n").replace(/[ \t]+\n/g, "\n").trimEnd()}\n`
}

export function exportMessagesForScope(messages: ChatExportMessage[], scope: ExportScope) {
  const exportable = messages.filter(isExportableMessage)
  if (scope === "session") return exportable
  const lastAssistant = [...exportable].reverse().find((message) => message.role === "assistant")
  return lastAssistant ? [lastAssistant] : []
}

export function suggestExportFilename(input: {
  filenameHint?: string
  sessionTitle?: string
  exportedAt?: Date
}) {
  const hint = sanitizeFilenameBase(input.filenameHint || "")
  if (hint) return ensureMarkdownExtension(hint)

  const exportedAt = input.exportedAt ?? new Date()
  const stamp = exportedAt.toISOString().slice(0, 19).replace(/[T:]/g, "-")
  const title = sanitizeFilenameBase(input.sessionTitle || "")
  return ensureMarkdownExtension(`${title || "chipmate-chat"}-${stamp}`)
}

function explicitScope(text: string): ExportScope | undefined {
  const normalized = normalizeCommandText(text)
  if (/^(last|last-assistant|last assistant|assistant|reply|answer|latest|latest answer|最后|最后回答|最后一个回答|上一条|刚才|刚才的回答)(\b|\s)/i.test(normalized)) {
    return "lastAssistant"
  }
  if (/^(session|chat|conversation|all|full|current|全部|整段|本次|当前会话|整个会话)(\b|\s)/i.test(normalized)) {
    return "session"
  }
  return undefined
}

function stripExplicitScope(text: string, scope: ExportScope) {
  const patterns =
    scope === "lastAssistant"
      ? /^(last|last-assistant|last assistant|assistant|reply|answer|latest|latest answer|最后|最后回答|最后一个回答|上一条|刚才|刚才的回答)\s*/i
      : /^(session|chat|conversation|all|full|current|全部|整段|本次|当前会话|整个会话)\s*/i
  return text.trim().replace(patterns, "").trim()
}

function normalizeCommandText(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

function normalizeScope(input: unknown): ExportScope | undefined {
  if (typeof input !== "string") return undefined
  const value = input.trim().toLowerCase()
  if (value === "session") return "session"
  if (value === "lastassistant" || value === "last_assistant" || value === "last-assistant" || value === "last assistant") {
    return "lastAssistant"
  }
  return undefined
}

function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{")
  if (start === -1) return ""

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return ""
}

function isExportableMessage(message: ChatExportMessage) {
  if (!["user", "assistant", "error"].includes(message.role)) return false
  return Boolean((message.text || message.error || "").trim())
}

function exportRoleLabel(role: string) {
  if (role === "user") return "User"
  if (role === "assistant") return "Assistant"
  if (role === "error") return "Error"
  return "Message"
}

function truncateForPrompt(text: string, limit: number) {
  const normalized = normalizeMarkdownText(text).replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}...`
}

function normalizeMarkdownText(text: string) {
  return text.replace(/\r\n?/g, "\n").trim()
}

function formatExportTimestamp(value: number | undefined) {
  if (!value) return ""
  const millis = value > 9999999999 ? value : value * 1000
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString()
}

function sanitizeFilenameHint(value: string) {
  return sanitizeFilenameBase(value)
}

function sanitizeFilenameBase(value: string) {
  const withoutExtension = value.trim().replace(/\.md$/i, "")
  const withoutPaths = withoutExtension.split(/[\\/]+/).pop() || ""
  return withoutPaths
    .replace(/[<>:"|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/[.\s-]+$/g, "")
    .slice(0, 80)
}

function ensureMarkdownExtension(value: string) {
  const base = sanitizeFilenameBase(value) || "chipmate-chat"
  return `${base}.md`
}
