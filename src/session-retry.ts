export const SESSION_RETRY_INITIAL_DELAY_MS = 2000
export const SESSION_RETRY_BACKOFF_FACTOR = 2
export const SESSION_RETRY_MAX_DELAY_NO_HEADERS_MS = 30000
export const SESSION_RETRY_MAX_DELAY_MS = 2_147_483_647

export type SessionRetryInfo = {
  message: string
}

export type SessionRetryHttpErrorLike = {
  status?: number
  statusText?: string
  bodyPreview?: string
  headers?: Headers
  message?: string
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export function sessionRetryLimitFromEnv(env = process.env) {
  const raw = env.KILO_SESSION_RETRY_LIMIT
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0 || String(value) !== raw.trim()) return undefined
  return value
}

export function sessionRetryDelayMs(attempt: number, headers?: Headers) {
  const retryAfter = retryAfterDelayMs(headers)
  if (retryAfter !== undefined) return capDelay(retryAfter)
  return capDelay(Math.min(
    SESSION_RETRY_INITIAL_DELAY_MS * Math.pow(SESSION_RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1)),
    SESSION_RETRY_MAX_DELAY_NO_HEADERS_MS,
  ))
}

export function retryAfterDelayMs(headers?: Headers) {
  if (!headers) return undefined
  const retryAfterMs = headers.get("retry-after-ms")
  if (retryAfterMs) {
    const parsedMs = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsedMs)) return parsedMs
  }

  const retryAfter = headers.get("retry-after")
  if (!retryAfter) return undefined
  const parsedSeconds = Number.parseFloat(retryAfter)
  if (!Number.isNaN(parsedSeconds)) return Math.ceil(parsedSeconds * 1000)
  const parsedDate = Date.parse(retryAfter) - Date.now()
  if (!Number.isNaN(parsedDate) && parsedDate > 0) return Math.ceil(parsedDate)
  return undefined
}

export function sessionRetryableError(error: unknown): SessionRetryInfo | undefined {
  const http = httpErrorLike(error)
  if (http) {
    const bodyMessage = retryMessageFromText(http.bodyPreview)
    if (isRetryableHttpStatus(http.status)) {
      return { message: bodyMessage ?? httpRetryMessage(http) }
    }
    const message = bodyMessage ?? retryMessageFromText(http.message)
    if (message) return { message }
    return undefined
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const parsed = retryMessageFromText(message)
  return parsed ? { message: parsed } : undefined
}

export function retryHeadersForError(error: unknown): Headers | undefined {
  return httpErrorLike(error)?.headers
}

function httpErrorLike(error: unknown): SessionRetryHttpErrorLike | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  const status = typeof record.status === "number" ? record.status : undefined
  const statusText = typeof record.statusText === "string" ? record.statusText : undefined
  const bodyPreview = typeof record.bodyPreview === "string" ? record.bodyPreview : undefined
  const message = typeof record.message === "string" ? record.message : undefined
  const headers = record.headers instanceof Headers ? record.headers : undefined
  if (status === undefined && !bodyPreview && !message) return undefined
  return { status, statusText, bodyPreview, message, headers }
}

function isRetryableHttpStatus(status: number | undefined) {
  if (status === undefined) return false
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500
}

function retryMessageFromText(input: string | undefined): string | undefined {
  const value = input?.trim()
  if (!value) return undefined
  const parsed: string | undefined = retryMessageFromJson(value)
  if (parsed) return parsed
  const lower = value.toLowerCase()
  if (
    lower.includes("rate increased too quickly") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    lower.includes("unavailable")
  ) {
    return value
  }
  return undefined
}

function retryMessageFromJson(input: string): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(input)
  } catch {
    return undefined
  }
  if (!json || typeof json !== "object") return undefined
  const root = json as Record<string, unknown>
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : undefined
  const code = stringValue(root.code) || stringValue(error?.code)
  const message = stringValue(root.message) || stringValue(error?.message)
  const type = stringValue(root.type)
  const errorType = stringValue(error?.type)
  const classifier = `${code} ${type} ${errorType}`.toLowerCase()

  if (type === "error" && errorType === "too_many_requests") return "Too Many Requests"
  if (classifier.includes("too_many_requests")) return "Too Many Requests"
  if (classifier.includes("exhausted") || classifier.includes("unavailable")) return "Provider is overloaded"
  if (classifier.includes("rate_limit")) return "Rate Limited"
  if (message) return retryMessageFromText(message)
  return undefined
}

function httpRetryMessage(error: SessionRetryHttpErrorLike) {
  if (error.message?.includes("Overloaded")) return "Provider is overloaded"
  if (error.status === 429) return "Too Many Requests"
  if (error.status !== undefined && error.status >= 500) return "Provider is overloaded"
  return error.message || `${error.status ?? "HTTP"} ${error.statusText || "provider error"}`.trim()
}

function capDelay(ms: number) {
  return Math.max(0, Math.min(ms, SESSION_RETRY_MAX_DELAY_MS))
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}
