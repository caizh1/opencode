import type {
  HealthResponse,
  OpenCodeMessage,
  OpenCodeModelInfo,
  OpenCodeSession,
  PromptModel,
  RemoteSettings,
} from "./types"

export class RemoteOpenCodeAuthError extends Error {
  constructor(message = "Remote OpenCode authentication failed") {
    super(message)
    this.name = "RemoteOpenCodeAuthError"
  }
}

export class RemoteOpenCodeRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "RemoteOpenCodeRequestError"
    this.status = status
  }
}

export class RemoteOpenCodeConnectionError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    super(`Cannot connect to ${baseUrl}: ${formatError(cause)}`)
    this.name = "RemoteOpenCodeConnectionError"
  }
}

export function isSessionNotFoundError(error: unknown) {
  if (!(error instanceof RemoteOpenCodeRequestError)) return false
  if (error.status !== 404) return false
  return /\bsession\b/i.test(error.message) && /\bnot\s+found\b/i.test(error.message)
}

export class RemoteOpenCodeClient {
  readonly baseUrl: string
  private readonly username: string
  private readonly password?: string

  constructor(settings: RemoteSettings, password?: string) {
    this.baseUrl = settings.serverUrl
    this.username = settings.username || "opencode"
    this.password = password
  }

  async health(signal?: AbortSignal) {
    return this.request<HealthResponse>("/global/health", { method: "GET", signal })
  }

  async listConfigProviders(signal?: AbortSignal) {
    return this.request<unknown>("/config/providers", { method: "GET", signal })
  }

  async listProviders(signal?: AbortSignal) {
    return this.request<unknown>("/provider", { method: "GET", signal })
  }

  async listModels(signal?: AbortSignal) {
    try {
      return normalizeModels(await this.listConfigProviders(signal))
    } catch (error) {
      if (error instanceof RemoteOpenCodeAuthError || error instanceof RemoteOpenCodeConnectionError) throw error
      return normalizeModels(await this.listProviders(signal))
    }
  }

  async listSessions(signal?: AbortSignal) {
    return this.request<OpenCodeSession[]>("/session", { method: "GET", signal })
  }

  async createSession(title?: string, signal?: AbortSignal) {
    return this.request<OpenCodeSession>("/session", {
      method: "POST",
      signal,
      body: title ? JSON.stringify({ title }) : JSON.stringify({}),
    })
  }

  async getMessages(sessionID: string, limit = 100, signal?: AbortSignal) {
    return this.request<OpenCodeMessage[]>(`/session/${encodeURIComponent(sessionID)}/message`, {
      method: "GET",
      query: { limit: String(limit) },
      signal,
    })
  }

  async sendMessage(input: {
    sessionID: string
    text: string
    model?: PromptModel
    agent?: string
    signal?: AbortSignal
  }) {
    return this.request<OpenCodeMessage>(`/session/${encodeURIComponent(input.sessionID)}/message`, {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        parts: [{ type: "text", text: input.text }],
      }),
    })
  }

  async sendMessageAsync(input: {
    sessionID: string
    text: string
    model?: PromptModel
    agent?: string
    signal?: AbortSignal
  }) {
    await this.request<void>(`/session/${encodeURIComponent(input.sessionID)}/prompt_async`, {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        parts: [{ type: "text", text: input.text }],
      }),
    })
  }

  async subscribeEvents(onEvent: (event: unknown) => void, signal: AbortSignal, onOpen?: () => void) {
    const response = await this.safeFetch("/event", {
      method: "GET",
      headers: this.headers(),
      signal,
    })
    if (response.status === 401) throw new RemoteOpenCodeAuthError()
    if (!response.ok) {
      throw await this.requestError(response, "SSE failed")
    }
    if (!response.body) throw new RemoteOpenCodeRequestError(response.status, "SSE response has no body")

    onOpen?.()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!signal.aborted) {
      const result = await reader.read()
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let boundary = findEventBoundary(buffer)
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        const data = parseSseData(raw)
        if (data) {
          try {
            onEvent(JSON.parse(data))
          } catch {
            onEvent(data)
          }
        }
        boundary = findEventBoundary(buffer)
      }
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> },
  ): Promise<T> {
    const response = await this.safeFetch(path, {
      ...init,
      headers: {
        ...this.headers(Boolean(init.body)),
        ...init.headers,
      },
    }, init.query)
    if (response.status === 401) throw new RemoteOpenCodeAuthError()
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!response.ok) {
      throw new RemoteOpenCodeRequestError(response.status, responseErrorMessage(response, text))
    }
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  private async safeFetch(
    path: string,
    init: RequestInit,
    query?: Record<string, string | undefined>,
  ) {
    try {
      return await fetch(this.makeUrl(path, query), init)
    } catch (error) {
      throw new RemoteOpenCodeConnectionError(this.baseUrl, error)
    }
  }

  private async requestError(response: Response, prefix: string) {
    const text = await response.text().catch(() => "")
    return new RemoteOpenCodeRequestError(response.status, `${prefix}: ${responseErrorMessage(response, text)}`)
  }

  private makeUrl(path: string, query?: Record<string, string | undefined>) {
    const url = new URL(path, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  private headers(hasBody = false) {
    const headers: Record<string, string> = {}
    if (hasBody) headers["Content-Type"] = "application/json"
    if (this.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`
    }
    return headers
  }
}

function responseErrorMessage(response: Response, text: string) {
  const detail = text.trim()
  const summary = `${response.status} ${response.statusText}`.trim()
  if (!detail) return summary
  return `${summary}: ${truncate(detail, 600)}`
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}

export function parseModel(input: string): PromptModel | undefined {
  const value = input.trim()
  if (!value) return
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  }
}

export function normalizeModels(input: unknown): OpenCodeModelInfo[] {
  const root = objectRecord(input)
  const providersValue = Array.isArray(input)
    ? input
    : Array.isArray(root.providers)
      ? root.providers
      : Array.isArray(root.all)
        ? root.all
        : []
  const defaults = objectRecord(root.default)
  const seen = new Set<string>()
  const result: OpenCodeModelInfo[] = []

  for (const providerValue of providersValue) {
    const provider = objectRecord(providerValue)
    const providerID = stringValue(provider.id) || stringValue(provider.providerID) || stringValue(provider.key)
    if (!providerID) continue
    const providerName = stringValue(provider.name) || providerID
    const models = modelsFromProvider(provider)

    for (const model of models) {
      const modelID = model.id
      if (!modelID) continue
      const id = `${providerID}/${modelID}`
      if (seen.has(id)) continue
      seen.add(id)
      result.push({
        id,
        providerID,
        modelID,
        name: model.name || modelID,
        providerName,
        isDefault: isDefaultModel(defaults, providerID, modelID, id),
      })
    }
  }

  return result.sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
    const provider = left.providerName.localeCompare(right.providerName)
    if (provider !== 0) return provider
    return left.name.localeCompare(right.name)
  })
}

function modelsFromProvider(provider: Record<string, unknown>) {
  const models = provider.models ?? provider.model
  if (Array.isArray(models)) {
    return models
      .map((model) => {
        const row = objectRecord(model)
        const id = stringValue(row.id) || stringValue(row.modelID) || stringValue(row.name)
        const name = stringValue(row.name) || stringValue(row.label) || id
        return { id, name }
      })
      .filter((model) => model.id)
  }

  const modelMap = objectRecord(models)
  return Object.entries(modelMap).map(([id, value]) => {
    const row = objectRecord(value)
    return {
      id,
      name: stringValue(row.name) || stringValue(row.label) || id,
    }
  })
}

function isDefaultModel(defaults: Record<string, unknown>, providerID: string, modelID: string, fullID: string) {
  const candidates = [
    stringValue(defaults[providerID]),
    stringValue(defaults.model),
    stringValue(defaults.default),
    stringValue(defaults.large),
  ].filter(Boolean)
  return candidates.some((value) => value === modelID || value === fullID)
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}

export function messageText(message: OpenCodeMessage | undefined) {
  if (!message) return ""
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") return [part.text]
      return []
    })
    .join("")
}

function findEventBoundary(buffer: string) {
  const lf = buffer.indexOf("\n\n")
  const crlf = buffer.indexOf("\r\n\r\n")
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function parseSseData(raw: string) {
  const lines = raw.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  return data || undefined
}
