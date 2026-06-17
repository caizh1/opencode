type Entry = {
  value: string
  timestamp: number
}

export type QwenAutocompleteCache = {
  get(prefix: string): string | undefined
  put(prefix: string, completion: string): void
  setMaxEntries(max: number): void
  size(): number
}

export type QwenAutocompleteLruCacheOptions = {
  maxEntries?: number
  now?: () => number
}

export const QWEN_AUTOCOMPLETE_CACHE_DEFAULT_MAX_ENTRIES = 1000

const SQLITE_MAX_LIKE_PATTERN_LENGTH = 50_000
const SQLITE_LIKE_PATTERN_SAFETY = 100

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/util/AutocompleteLruCache.ts
// - core/indexing/refreshIndex.ts truncateSqliteLikePattern
// qwen-direct keeps this in memory and qwen-owned so it does not import
// indexing, SQLite, or the old autocomplete runtime.
export class QwenAutocompleteLruCache implements QwenAutocompleteCache {
  private readonly cache = new Map<string, Entry>()
  private max: number
  private readonly now: () => number

  constructor(opts: QwenAutocompleteLruCacheOptions = {}) {
    this.max = clampMaxEntries(opts.maxEntries)
    this.now = opts.now ?? (() => Date.now())
  }

  get(prefix: string): string | undefined {
    const key = truncateSqliteLikePattern(prefix)
    const hit = this.longest(key)
    if (!hit) return undefined
    const typed = key.slice(hit.key.length)
    if (!hit.entry.value.startsWith(typed)) return undefined
    hit.entry.timestamp = this.now()
    return hit.entry.value.slice(key.length - hit.key.length)
  }

  put(prefix: string, completion: string): void {
    const key = truncateSqliteLikePattern(prefix)
    this.cache.set(key, { value: completion, timestamp: this.now() })
    this.evict()
  }

  setMaxEntries(max: number): void {
    this.max = clampMaxEntries(max)
    this.evict()
  }

  size(): number {
    return this.cache.size
  }

  private longest(prefix: string): { key: string; entry: Entry } | undefined {
    let best: { key: string; entry: Entry } | undefined
    for (const [key, entry] of this.cache.entries()) {
      if (!prefix.startsWith(key)) continue
      if (best && key.length <= best.key.length) continue
      best = { key, entry }
    }
    return best
  }

  private evict(): void {
    while (this.cache.size > this.max) {
      const key = this.oldest()
      if (!key) return
      this.cache.delete(key)
    }
  }

  private oldest(): string | undefined {
    let key: string | undefined
    let time = Infinity
    for (const [item, entry] of this.cache.entries()) {
      if (entry.timestamp >= time) continue
      key = item
      time = entry.timestamp
    }
    return key
  }
}

export function truncateSqliteLikePattern(input: string, safety = SQLITE_LIKE_PATTERN_SAFETY): string {
  return truncateToLastNBytes(input, SQLITE_MAX_LIKE_PATTERN_LENGTH - safety)
}

export function truncateToLastNBytes(input: string, max: number): string {
  if (max <= 0) return ""
  const encoder = new TextEncoder()
  let bytes = 0
  let start = 0
  for (let index = input.length - 1; index >= 0; index--) {
    bytes += encoder.encode(input[index]).length
    if (bytes <= max) continue
    start = index + 1
    break
  }
  return input.substring(start, input.length)
}

export function clampMaxEntries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return QWEN_AUTOCOMPLETE_CACHE_DEFAULT_MAX_ENTRIES
  return Math.max(1, Math.min(10_000, Math.floor(value)))
}
