import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChipMateMessage, ChipMateUsageRecord } from "../src/types"

const tempRoots: string[] = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }
}

mock.module("vscode", () => ({
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: UriShim,
  workspace: {
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
    },
  },
}))

const {
  UsageLedgerService,
  buildUsageStatsSnapshot,
  usageRecordFromMessage,
} = await import("../src/usage-ledger")

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("UsageLedgerService", () => {
  test("appends chat usage JSONL records once per assistant message", async () => {
    const root = await tempDir("chipmate-usage-ledger-")
    const service = new UsageLedgerService({ globalStorageUri: UriShim.file(root) } as never)
    const record = usageRecord("session-a", "message-a", Date.now(), 100, "reported")

    expect(await service.append(record)).toBe(true)
    expect(await service.append(record)).toBe(false)

    const text = new TextDecoder().decode(await readFile(join(root, "usage", "chat-usage.jsonl")))
    expect(text.trim().split(/\r?\n/)).toHaveLength(1)

    const stats = await service.stats(7)
    expect(stats.summary.recordedResponses).toBe(1)
    expect(stats.summary.totalTokens).toBe(100)
    expect(stats.summary.reportedResponses).toBe(1)
  })
})

describe("usage ledger aggregation", () => {
  test("builds daily, weekly, cumulative, peak, and streak metrics", () => {
    const now = Date.parse("2026-06-26T12:00:00")
    const stats = buildUsageStatsSnapshot([
      usageRecord("s1", "today", Date.parse("2026-06-26T09:00:00"), 100, "reported", 9000),
      usageRecord("s1", "yesterday", Date.parse("2026-06-25T09:00:00"), 50, "estimated"),
      usageRecord("s2", "earlier", Date.parse("2026-06-22T09:00:00"), 25, "reported"),
    ], { now, rangeDays: 7 })

    expect(stats.hasData).toBe(true)
    expect(stats.summary.totalTokens).toBe(175)
    expect(stats.summary.reportedTokens).toBe(125)
    expect(stats.summary.estimatedTokens).toBe(50)
    expect(stats.summary.peakDay).toBe("2026-06-26")
    expect(stats.summary.peakDayTokens).toBe(100)
    expect(stats.summary.currentStreakDays).toBe(2)
    expect(stats.summary.longestStreakDays).toBe(2)
    expect(stats.summary.longestTaskMs).toBe(9000)
    expect(stats.daily).toHaveLength(7)
    expect(stats.weekly).toHaveLength(1)
    expect(stats.weekly[0]?.total).toBe(175)
    expect(stats.cumulative.at(-1)?.total).toBe(175)
  })

  test("aggregates effective input and totals without cache-read inflation", () => {
    const now = Date.parse("2026-06-26T12:00:00")
    const record = usageRecord("s1", "cached", Date.parse("2026-06-26T09:00:00"), 1_200, "reported")
    record.tokens.input = 1_000
    record.tokens.output = 200
    record.tokens.total = 1_200
    record.tokens.cache = { read: 800, write: 0 }

    const stats = buildUsageStatsSnapshot([record], { now, rangeDays: 1 })

    expect(stats.summary.totalTokens).toBe(400)
    expect(stats.daily[0]?.input).toBe(200)
    expect(stats.daily[0]?.cacheRead).toBe(800)
    expect(stats.daily[0]?.total).toBe(400)
  })

  test("filters legacy accumulated reported usage beyond the model context", () => {
    const now = Date.parse("2026-06-26T12:00:00")
    const record = usageRecord("s1", "legacy", Date.parse("2026-06-26T09:00:00"), 385_899, "reported")
    record.providerID = "deepseek"
    record.modelID = "deepseek-v4-pro"
    record.tokens.input = 384_200
    record.tokens.output = 1_300
    record.tokens.reasoning = 399
    record.tokens.total = 385_899

    const stats = buildUsageStatsSnapshot([record], {
      now,
      rangeDays: 1,
      contextLimitsByModelID: { "deepseek/deepseek-v4-pro": 128_000 },
    })

    expect(stats.hasData).toBe(false)
    expect(stats.summary.totalTokens).toBe(0)
    expect(stats.daily[0]?.total).toBe(0)
  })

  test("backfills assistant messages with token info without prompt or answer text", () => {
    const record = usageRecordFromMessage({
      info: {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        usageKind: "estimated",
        providerID: "provider-a",
        modelID: "model-a",
        mode: "plugin-chat",
        time: { created: 1000, completed: 4500 },
        tokens: { input: 20, output: 7, total: 27, cache: { read: 3, write: 0 } },
      },
      parts: [{ type: "text", text: "This text must not be copied into the usage record." }],
    } as ChipMateMessage)

    expect(record).toMatchObject({
      id: "chat:session-1:assistant-1",
      source: "chat",
      usageKind: "estimated",
      sessionID: "session-1",
      messageID: "assistant-1",
      providerID: "provider-a",
      modelID: "model-a",
      mode: "plugin-chat",
      durationMs: 3500,
      tokens: { total: 27, input: 20, output: 7, cache: { read: 3, write: 0 } },
    })
    expect(JSON.stringify(record)).not.toContain("This text must not be copied")
  })
})

function usageRecord(
  sessionID: string,
  messageID: string,
  createdAt: number,
  total: number,
  usageKind: "reported" | "estimated",
  durationMs?: number,
): ChipMateUsageRecord {
  return {
    id: `chat:${sessionID}:${messageID}`,
    source: "chat",
    usageKind,
    sessionID,
    messageID,
    createdAt,
    tokens: {
      input: Math.floor(total * 0.6),
      output: Math.ceil(total * 0.4),
      total,
      cache: { read: 0, write: 0 },
    },
    durationMs,
  }
}

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  tempRoots.push(root)
  await mkdir(root, { recursive: true })
  return root
}
