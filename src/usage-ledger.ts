import * as vscode from "vscode"
import type {
  ChipMateMessage,
  ChipMateModelLimit,
  ChipMateTokenUsage,
  ChipMateUsageBucket,
  ChipMateUsageKind,
  ChipMateUsageRecord,
  ChipMateUsageStatsOptions,
  ChipMateUsageStatsSnapshot,
} from "./types"
import { effectiveTokenUsage, isLikelyAccumulatedReportedUsage, normalizeTokenUsage } from "./usage"

const USAGE_RANGE_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

export class UsageLedgerService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async append(record: ChipMateUsageRecord | undefined) {
    const sanitized = sanitizeUsageRecord(record)
    if (!sanitized) return false
    return this.appendMany([sanitized])
  }

  async backfill(records: Array<ChipMateUsageRecord | undefined>) {
    const sanitized = records.map(sanitizeUsageRecord).filter((record): record is ChipMateUsageRecord => Boolean(record))
    if (sanitized.length === 0) return 0
    const changed = await this.appendMany(sanitized)
    return changed ? sanitized.length : 0
  }

  async stats(rangeDays = USAGE_RANGE_DAYS, options: ChipMateUsageStatsOptions = {}): Promise<ChipMateUsageStatsSnapshot> {
    const records = await this.readRecords()
    return buildUsageStatsSnapshot(records, { rangeDays, ...options })
  }

  private async appendMany(records: ChipMateUsageRecord[]) {
    const existing = await this.readRecords()
    const seen = new Set(existing.map(usageRecordKey))
    const fresh = records.filter((record) => {
      const key = usageRecordKey(record)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (fresh.length === 0) return false
    const uri = await this.usageUri()
    const previous = await readText(uri)
    const text = `${previous}${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
    return true
  }

  private async readRecords() {
    const text = await readText(await this.usageUri())
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseUsageRecordLine)
      .filter((record): record is ChipMateUsageRecord => Boolean(record))
  }

  private async usageDir() {
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, "usage")
    await vscode.workspace.fs.createDirectory(dir)
    return dir
  }

  private async usageUri() {
    return vscode.Uri.joinPath(await this.usageDir(), "chat-usage.jsonl")
  }
}

export function usageRecordFromMessage(message: ChipMateMessage): ChipMateUsageRecord | undefined {
  if (message.info.role !== "assistant") return
  const sessionID = message.info.sessionID?.trim()
  const messageID = message.info.id?.trim()
  if (!sessionID || !messageID) return
  const tokens = normalizeTokenUsage(message.info.tokens)
  if (!tokens || !hasPositiveUsage(tokens)) return
  const createdAt = positiveNumber(message.info.time?.created) ?? positiveNumber(message.info.time?.completed) ?? Date.now()
  const completedAt = positiveNumber(message.info.time?.completed)
  const durationMs = completedAt && completedAt >= createdAt ? completedAt - createdAt : undefined
  return {
    id: `chat:${sessionID}:${messageID}`,
    source: "chat",
    usageKind: message.info.usageKind ?? "reported",
    sessionID,
    messageID,
    createdAt,
    completedAt,
    providerID: optionalString(message.info.providerID),
    modelID: optionalString(message.info.modelID),
    mode: optionalString(message.info.mode),
    tokens,
    durationMs,
  }
}

export function buildUsageStatsSnapshot(
  records: ChipMateUsageRecord[],
  options: { rangeDays?: number; now?: number } & ChipMateUsageStatsOptions = {},
): ChipMateUsageStatsSnapshot {
  const now = options.now ?? Date.now()
  const rangeDays = Math.max(1, Math.floor(options.rangeDays ?? USAGE_RANGE_DAYS))
  const endDay = startOfLocalDay(now)
  const startDay = endDay - (rangeDays - 1) * DAY_MS
  const days = Array.from({ length: rangeDays }, (_, index) => emptyBucket(dayKey(startDay + index * DAY_MS), startDay + index * DAY_MS, startDay + (index + 1) * DAY_MS))
  const byDay = new Map(days.map((bucket) => [bucket.key, bucket]))
  const inRange = records
    .map(sanitizeUsageRecord)
    .filter((record): record is ChipMateUsageRecord => Boolean(record))
    .filter((record) => !isLikelyAccumulatedReportedUsage({
      tokens: record.tokens,
      usageKind: record.usageKind,
      modelLimit: contextLimitForRecord(record, options),
    }))
    .filter((record) => record.createdAt >= startDay && record.createdAt < endDay + DAY_MS)

  for (const record of inRange) {
    const key = dayKey(record.createdAt)
    const bucket = byDay.get(key)
    if (bucket) addRecordToBucket(bucket, record)
  }

  const weekly = weeklyBuckets(days)
  const cumulative = cumulativeBuckets(days)
  const activeDayKeys = new Set(days.filter((bucket) => bucket.total > 0).map((bucket) => bucket.key))
  const peakDay = days.reduce((peak, bucket) => bucket.total > peak.total ? bucket : peak, days[0])
  const totals = inRange.reduce(
    (sum, record) => {
      const tokens = usageTotal(record.tokens)
      sum.totalTokens += tokens
      if (record.usageKind === "estimated") {
        sum.estimatedTokens += tokens
        sum.estimatedResponses += 1
      } else {
        sum.reportedTokens += tokens
        sum.reportedResponses += 1
      }
      sum.recordedResponses += 1
      if (record.durationMs !== undefined) sum.longestTaskMs = Math.max(sum.longestTaskMs ?? 0, record.durationMs)
      return sum
    },
    {
      totalTokens: 0,
      reportedTokens: 0,
      estimatedTokens: 0,
      recordedResponses: 0,
      reportedResponses: 0,
      estimatedResponses: 0,
      longestTaskMs: undefined as number | undefined,
    },
  )

  return {
    generatedAt: now,
    rangeDays,
    hasData: totals.recordedResponses > 0,
    summary: {
      ...totals,
      peakDayTokens: peakDay.total,
      peakDay: peakDay.total > 0 ? peakDay.key : undefined,
      currentStreakDays: currentStreak(activeDayKeys, endDay),
      longestStreakDays: longestStreak(days),
      activeDays: activeDayKeys.size,
    },
    daily: days,
    weekly,
    cumulative,
  }
}

function sanitizeUsageRecord(input: ChipMateUsageRecord | undefined): ChipMateUsageRecord | undefined {
  if (!input || input.source !== "chat") return
  const sessionID = optionalString(input.sessionID)
  const messageID = optionalString(input.messageID)
  const tokens = normalizeTokenUsage(input.tokens)
  const createdAt = positiveNumber(input.createdAt)
  if (!sessionID || !messageID || !tokens || !createdAt || !hasPositiveUsage(tokens)) return
  return {
    id: optionalString(input.id) || `chat:${sessionID}:${messageID}`,
    source: "chat",
    usageKind: usageKind(input.usageKind),
    sessionID,
    messageID,
    createdAt,
    completedAt: positiveNumber(input.completedAt),
    providerID: optionalString(input.providerID),
    modelID: optionalString(input.modelID),
    mode: optionalString(input.mode),
    tokens,
    durationMs: positiveNumber(input.durationMs),
  }
}

function parseUsageRecordLine(line: string) {
  try {
    return sanitizeUsageRecord(JSON.parse(line) as ChipMateUsageRecord)
  } catch {
    return undefined
  }
}

function usageRecordKey(record: ChipMateUsageRecord) {
  return `${record.source}:${record.sessionID}:${record.messageID}`
}

function emptyBucket(key: string, startAt: number, endAt: number): ChipMateUsageBucket {
  return {
    key,
    label: key,
    startAt,
    endAt,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reportedTotal: 0,
    estimatedTotal: 0,
    count: 0,
    reportedCount: 0,
    estimatedCount: 0,
  }
}

function addRecordToBucket(bucket: ChipMateUsageBucket, record: ChipMateUsageRecord) {
  const { input, output, reasoning, cacheRead, cacheWrite, total } = effectiveTokenUsage(record.tokens)
  bucket.total += total
  bucket.input += input
  bucket.output += output
  bucket.reasoning += reasoning
  bucket.cacheRead += cacheRead
  bucket.cacheWrite += cacheWrite
  bucket.count += 1
  if (record.usageKind === "estimated") {
    bucket.estimatedTotal += total
    bucket.estimatedCount += 1
  } else {
    bucket.reportedTotal += total
    bucket.reportedCount += 1
  }
}

function weeklyBuckets(days: ChipMateUsageBucket[]) {
  const buckets: ChipMateUsageBucket[] = []
  for (let index = 0; index < days.length; index += 7) {
    const group = days.slice(index, index + 7)
    const bucket = emptyBucket(group[0].key, group[0].startAt, group[group.length - 1].endAt)
    bucket.label = group.length > 1 ? `${group[0].key} - ${group[group.length - 1].key}` : group[0].key
    for (const day of group) addBucket(bucket, day)
    buckets.push(bucket)
  }
  return buckets
}

function cumulativeBuckets(days: ChipMateUsageBucket[]) {
  const buckets: ChipMateUsageBucket[] = []
  const running = emptyBucket(days[0]?.key ?? dayKey(Date.now()), days[0]?.startAt ?? startOfLocalDay(Date.now()), days[0]?.endAt ?? startOfLocalDay(Date.now()) + DAY_MS)
  for (const day of days) {
    addBucket(running, day)
    buckets.push({ ...running, key: day.key, label: day.label, startAt: day.startAt, endAt: day.endAt })
  }
  return buckets
}

function addBucket(target: ChipMateUsageBucket, source: ChipMateUsageBucket) {
  target.total += source.total
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reportedTotal += source.reportedTotal
  target.estimatedTotal += source.estimatedTotal
  target.count += source.count
  target.reportedCount += source.reportedCount
  target.estimatedCount += source.estimatedCount
}

function currentStreak(activeDayKeys: Set<string>, endDay: number) {
  let streak = 0
  for (let time = endDay; activeDayKeys.has(dayKey(time)); time -= DAY_MS) streak += 1
  return streak
}

function longestStreak(days: ChipMateUsageBucket[]) {
  let current = 0
  let longest = 0
  for (const day of days) {
    current = day.total > 0 ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}

function usageTotal(tokens: ChipMateTokenUsage) {
  return effectiveTokenUsage(tokens).total
}

function contextLimitForRecord(record: ChipMateUsageRecord, options: ChipMateUsageStatsOptions): ChipMateModelLimit | undefined {
  const limits = options.contextLimitsByModelID
  if (!limits) return
  const qualifiedID = record.providerID && record.modelID ? `${record.providerID}/${record.modelID}` : undefined
  const context = positiveNumber(
    (qualifiedID ? limits[qualifiedID] : undefined) ??
      (record.modelID ? limits[record.modelID] : undefined),
  )
  return context ? { context } : undefined
}

function startOfLocalDay(input: number) {
  const date = new Date(input)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayKey(input: number) {
  const date = new Date(input)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function usageKind(input: unknown): ChipMateUsageKind {
  return input === "estimated" ? "estimated" : "reported"
}

function optionalString(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function positiveNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : undefined
}

function hasPositiveUsage(tokens: ChipMateTokenUsage) {
  return [
    tokens.total,
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
}

async function readText(uri: vscode.Uri) {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
  } catch {
    return ""
  }
}
