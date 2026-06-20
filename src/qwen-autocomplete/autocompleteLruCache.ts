import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

type Entry = {
  value: string
  timestamp: number
}

type SqlResult = {
  values?: unknown[][]
}

type SqlDatabase = {
  close(): void
  exec(sql: string, params?: unknown[]): SqlResult[]
  export(): Uint8Array
  run(sql: string, params?: unknown[]): void
}

type SqlModule = {
  Database: new (data?: Uint8Array | ArrayLike<number>) => SqlDatabase
}

export type QwenAutocompleteCache = {
  dispose?(): Promise<void> | void
  flush?(): Promise<void>
  get(prefix: string): Promise<string | undefined>
  put(prefix: string, completion: string): Promise<void>
  setMaxEntries(max: number): Promise<void> | void
  size(): number
}

export type QwenAutocompleteLruCacheOptions = {
  maxEntries?: number
  now?: () => number
  storagePath?: string
}

export const QWEN_AUTOCOMPLETE_CACHE_DEFAULT_MAX_ENTRIES = 1000

const FLUSH_DELAY_MS = 750
const SQLITE_MAX_LIKE_PATTERN_LENGTH = 50_000
const SQLITE_LIKE_PATTERN_SAFETY = 100

let sqlModulePromise: Promise<SqlModule | null> | null = null

// Continue parity source:
// continuedev/continue@main core/autocomplete/util/AutocompleteLruCache.ts
// qwen-direct keeps a qwen-owned SQLite LRU with in-memory fallback so it can
// persist autocomplete prefixes without importing the old runtime.
export class QwenAutocompleteLruCache implements QwenAutocompleteCache {
  private readonly cache = new Map<string, Entry>()
  private readonly now: () => number
  private readonly storagePath?: string
  private readonly ready: Promise<void>
  private db: SqlDatabase | null = null
  private dirty = new Set<string>()
  private closed = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private max: number
  private queue = Promise.resolve()

  constructor(opts: QwenAutocompleteLruCacheOptions = {}) {
    this.max = clampMaxEntries(opts.maxEntries)
    this.now = opts.now ?? (() => Date.now())
    this.storagePath = opts.storagePath?.trim() || undefined
    this.ready = this.initialize()
  }

  async get(prefix: string): Promise<string | undefined> {
    return this.serial(async () => {
      await this.ready
      const key = truncateSqliteLikePattern(prefix)
      const hit = this.longest(key)
      if (!hit) return undefined
      const typed = key.slice(hit.key.length)
      if (!hit.entry.value.startsWith(typed)) return undefined
      hit.entry.timestamp = this.now()
      this.dirty.add(hit.key)
      this.scheduleFlush()
      return hit.entry.value.slice(typed.length)
    })
  }

  async put(prefix: string, completion: string): Promise<void> {
    await this.serial(async () => {
      await this.ready
      const key = truncateSqliteLikePattern(prefix)
      this.cache.set(key, { value: completion, timestamp: this.now() })
      this.dirty.add(key)
      this.evict()
      this.scheduleFlush()
    })
  }

  async setMaxEntries(max: number): Promise<void> {
    await this.serial(async () => {
      await this.ready
      this.max = clampMaxEntries(max)
      this.evict()
      this.scheduleFlush()
    })
  }

  size(): number {
    return this.cache.size
  }

  async flush(): Promise<void> {
    await this.serial(async () => {
      await this.ready
      this.cancelFlush()
      if (!this.db || !this.storagePath || this.dirty.size === 0) return
      const dirty = [...this.dirty]
      this.dirty = new Set()
      try {
        this.db.run("BEGIN TRANSACTION")
        for (const key of dirty) {
          const entry = this.cache.get(key)
          if (entry) {
            this.db.run(
              `INSERT INTO cache (key, value, timestamp) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, timestamp = excluded.timestamp`,
              [key, entry.value, entry.timestamp],
            )
            continue
          }
          this.db.run("DELETE FROM cache WHERE key = ?", [key])
        }
        this.db.run("COMMIT")
      } catch (err) {
        try {
          this.db.run("ROLLBACK")
        } catch (rollbackErr) {
          void rollbackErr
        }
        this.dirty = new Set([...dirty, ...this.dirty])
        return
      }
      await mkdir(path.dirname(this.storagePath), { recursive: true })
      await writeFile(this.storagePath, Buffer.from(this.db.export()))
    })
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelFlush()
    await this.flush()
    this.db?.close()
    this.db = null
  }

  private async initialize(): Promise<void> {
    if (!this.storagePath) return
    const sql = await loadSqlJs()
    if (!sql) return
    const bytes = await safeRead(this.storagePath)
    this.db = bytes ? new sql.Database(bytes) : new sql.Database()
    this.db.run(
      "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, timestamp INTEGER NOT NULL)",
    )
    const rows = this.db.exec("SELECT key, value, timestamp FROM cache ORDER BY timestamp DESC")
    for (const row of rows.flatMap((result) => result.values ?? [])) {
      const [key, value, timestamp] = row
      if (typeof key !== "string" || typeof value !== "string" || typeof timestamp !== "number") continue
      this.cache.set(key, { value, timestamp })
    }
    this.evict()
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
      this.dirty.add(key)
    }
  }

  private oldest(): string | undefined {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp >= oldestTime) continue
      oldestKey = key
      oldestTime = entry.timestamp
    }
    return oldestKey
  }

  private scheduleFlush(): void {
    if (!this.db || !this.storagePath || this.flushTimer || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_DELAY_MS)
  }

  private cancelFlush(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn, fn)
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
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

async function loadSqlJs(): Promise<SqlModule | null> {
  if (!sqlModulePromise) {
    sqlModulePromise = (async () => {
      try {
        const mod = (await import("sql.js")) as {
          default?: (input?: { locateFile?: (file: string) => string }) => Promise<SqlModule>
        }
        const init = mod.default
        if (!init) return null
        const base = path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm"))
        return await init({
          locateFile: (file) => path.join(base, file),
        })
      } catch (err) {
        void err
        return null
      }
    })()
  }
  return sqlModulePromise
}

async function safeRead(file: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(file)
  } catch (err) {
    void err
    return undefined
  }
}
