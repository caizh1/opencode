import type { QwenAutocompleteConfig } from "./types"

type Fetcher = typeof fetch

type CacheEntry = {
  expiresAt: number
  source: "models" | "fallback-200k"
  value: number
}

type Deps = {
  fetcher?: Fetcher
  now?: () => number
  ttlMs?: number
}

export type QwenResolvedContextLength = {
  source: "configured" | "models" | "fallback-200k"
  value: number
}

const TTL_MS = 5 * 60 * 1000
export const QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK = 200_000

const KEY_SCORES: Record<string, number> = {
  context_length: 100,
  contextlength: 100,
  max_context_length: 98,
  maxcontextlength: 98,
  context_window: 96,
  contextwindow: 96,
  max_context_tokens: 94,
  maxcontexttokens: 94,
  max_input_tokens: 92,
  maxinputtokens: 92,
  input_token_limit: 90,
  inputtokenlimit: 90,
  token_limit: 88,
  tokenlimit: 88,
  num_ctx: 86,
  max_position_embeddings: 84,
  max_tokens: 70,
  maxtokens: 70,
}

// qwen-direct only uses this resolver when completion.contextLength <= 0.
// It is read-only, scoped to autocomplete, and caches results in memory so it
// does not alter chat/QA provider discovery behavior.
export class QwenModelContextResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<CacheEntry>>()
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(deps: Deps = {}) {
    this.fetcher = deps.fetcher ?? fetch
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? TTL_MS
  }

  async resolve(cfg: Pick<QwenAutocompleteConfig, "contextLength" | "endpoint" | "model" | "apiKey">): Promise<QwenResolvedContextLength> {
    if (cfg.contextLength > 0) {
      return { source: "configured", value: cfg.contextLength }
    }
    const endpoint = modelsUrl(cfg.endpoint)
    if (!endpoint) return fallback()
    const key = `${endpoint}::${cfg.model.trim().toLowerCase()}`
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > this.now()) {
      return resolved(hit)
    }
    const pending = this.inflight.get(key)
    if (pending) {
      const value = await pending
      return resolved(value)
    }
    const task = this.fetchLength(endpoint, cfg)
    this.inflight.set(key, task)
    try {
      const value = await task
      this.cache.set(key, value)
      return resolved(value)
    } finally {
      this.inflight.delete(key)
    }
  }

  private async fetchLength(
    endpoint: string,
    cfg: Pick<QwenAutocompleteConfig, "model" | "apiKey">,
  ): Promise<CacheEntry> {
    try {
      const res = await this.fetcher(endpoint, {
        method: "GET",
        headers: headers(cfg.apiKey),
      })
      if (!res.ok) return this.entry("fallback-200k", QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK)
      const body = await res.text()
      if (!body.trim()) return this.entry("fallback-200k", QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK)
      const parsed = JSON.parse(body) as unknown
      const length = modelsContextLength(parsed, cfg.model)
      if (length !== null) return this.entry("models", length)
      return this.entry("fallback-200k", QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK)
    } catch (err) {
      void err
      return this.entry("fallback-200k", QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK)
    }
  }

  private entry(source: CacheEntry["source"], value: number): CacheEntry {
    return {
      expiresAt: this.now() + this.ttlMs,
      source,
      value,
    }
  }
}

function fallback(): QwenResolvedContextLength {
  return {
    source: "fallback-200k",
    value: QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK,
  }
}

function resolved(entry: CacheEntry): QwenResolvedContextLength {
  return {
    source: entry.source,
    value: entry.value,
  }
}

export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/\/models$/i.test(trimmed)) return trimmed
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/models")
  if (/\/completions$/i.test(trimmed)) return trimmed.replace(/\/completions$/i, "/models")
  return `${trimmed}/models`
}

export function modelsContextLength(payload: unknown, model: string): number | null {
  const root = record(payload)
  const data = Array.isArray(root.data) ? root.data : []
  const normalized = model.trim().toLowerCase()
  const candidates = data.filter((item) => {
    const id = record(item).id
    return (typeof id === "string" ? id : String(id ?? "")).trim().toLowerCase() === normalized
  })
  if (candidates.length > 0) return bestContextLength(candidates)
  if (data.length === 1) return bestContextLength(data)
  return bestContextLength(payload)
}

function bestContextLength(input: unknown): number | null {
  const best = candidates(input).sort((left, right) => right.score - left.score)[0]
  return best?.value ?? null
}

function candidates(input: unknown, prefix = "", depth = 0, seen = new Set<unknown>()): Array<{ score: number; value: number }> {
  if (depth > 4 || !input || typeof input !== "object" || seen.has(input)) return []
  seen.add(input)
  const node = input as Record<string, unknown>
  const out: Array<{ score: number; value: number }> = []
  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeKey(key)
    const current = numeric(value)
    if (current !== null) {
      const score = KEY_SCORES[normalized]
      if (score) out.push({ score: score + pathBonus(prefix), value: current })
    }
    if (value && typeof value === "object") {
      const nextPrefix = prefix ? `${prefix}.${key}` : key
      out.push(...candidates(value, nextPrefix, depth + 1, seen))
    }
  }
  return out.filter((item) => item.value > 0 && item.value <= 10_000_000)
}

function pathBonus(prefix: string): number {
  if (!prefix) return 10
  if (/\b(metadata|capabilities|limits|context)\b/i.test(prefix)) return 5
  return 0
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10)
  return null
}

function headers(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim()
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {}
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
