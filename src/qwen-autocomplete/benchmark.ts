import fs from "node:fs/promises"
import path from "node:path"
import * as vscode from "vscode"
import { AutocompleteDebouncer } from "./AutocompleteDebouncer"
import { KiloQwenInlineCompletionProvider } from "./KiloQwenInlineCompletionProvider"
import { QwenFimClient } from "./QwenFimClient"
import { shouldGuardQwenDocument } from "./guard"
import type { QwenAutocompleteConfig, QwenFimCompleteInput } from "./types"

export type BenchmarkMode = "mock" | "real"

export type BenchmarkFixture = {
  id: string
  title: string
  languageId: string
  fileName: string
  cursorMarker: string
  document: string
  selectedCompletionInfo?: null | {
    text: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
  }
  mockCompletion?: string
  expectation: {
    shouldRequest: boolean
    shouldShowGhostText: boolean
    guardShouldBlock?: boolean
    allowMultiline?: boolean
    mustNotContain?: string[]
    mustContainAny?: string[]
    mustNotEchoPrefix?: boolean
    mustNotOverlapSuffix?: boolean
    notes?: string
  }
}

export type FailureReason =
  | "EXPECTED_REQUEST_BUT_BLOCKED"
  | "EXPECTED_BLOCK_BUT_REQUESTED"
  | "NO_GHOST_TEXT"
  | "UNEXPECTED_GHOST_TEXT"
  | "PREFIX_ECHO"
  | "SUFFIX_OVERLAP"
  | "MARKDOWN_LEAKAGE"
  | "SPECIAL_TOKEN_LEAKAGE"
  | "SYNTAX_BREAK"
  | "WRONG_RANGE"
  | "UNEXPECTED_MULTILINE"
  | "UNEXPECTED_MULTILINE_REJECT"
  | "UNEXPECTED_REJECT"
  | "TIMEOUT"
  | "QWEN_ERROR"
  | "MISSING_CURSOR_MARKER"
  | "INVALID_FIXTURE"

export type BenchmarkRunOptions = {
  mode: BenchmarkMode
  fixturesPath: string
  outputPath?: string
  repeat?: number
  cache?: boolean
  timeoutMs: number
  endpoint?: string
  model?: string
  apiKeyEnv?: string
  redactPrompts: boolean
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  cwd?: string
  now?: () => string
}

export type BenchmarkReport = {
  phase: "2A"
  mode: BenchmarkMode
  timestamp: string
  config: {
    fixturesPath: string
    repeat: number
    timeoutMs: number
    cacheEnabled: boolean
    endpoint?: string
    model?: string
    redactedPrompts: boolean
  }
  summary: {
    total: number
    passed: number
    failed: number
    ghostTextShownRate: number
    noSuggestionRate: number
    manualAcceptEligibleRate: number
    latencyP50Ms: number
    latencyP95Ms: number
  }
  metrics: Record<string, number>
  cases: BenchmarkCaseReport[]
}

export type BenchmarkCaseReport = {
  id: string
  title: string
  pass: boolean
  failureReasons: FailureReason[]
  latencyMs: number
  observed: {
    guardBlocked: boolean
    qwenCalled: boolean
    itemCount: number
    insertTextPreview?: string
    rangePreview?: string
    multilineShown?: boolean
    requestPreview?: Record<string, unknown>
    rawCompletionPreview?: string
  }
}

export type BenchmarkWriteResult = {
  jsonPath: string
  markdownPath: string
}

type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }
type Loaded = {
  fixture: BenchmarkFixture
  file: string
}
type Prepared = {
  fixture: BenchmarkFixture
  text: string
  position: vscode.Position
  document: vscode.TextDocument
  context: vscode.InlineCompletionContext
  linePrefix: string
  lineSuffix: string
}
type Token = vscode.CancellationToken & {
  cancel(): void
}
type Run = {
  fixture: BenchmarkFixture
  reasons: FailureReason[]
  latency: number
  guard: boolean
  called: boolean
  cancelled: boolean
  stale: boolean
  raw?: string
  request?: Record<string, unknown>
  items: vscode.InlineCompletionItem[]
  insert?: string
  range?: string
  multiline: boolean
  error?: string
}
type DetectInput = {
  fixture: BenchmarkFixture
  guard: boolean
  called: boolean
  items: vscode.InlineCompletionItem[]
  insert?: string
  linePrefix: string
  lineSuffix: string
  range?: unknown
}

const DEFAULT_FIXTURES = "tests/fixtures/qwen-autocomplete-benchmark"
const DEFAULT_OUTPUT = "benchmark-results"
const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MODEL = "qwen-coder-30b0"
const MARKER = "/*__CURSOR__*/"
const API_KEY_REDACTION = "[redacted]"
const PROMPT_REDACTION = "[redacted prompt]"
const EMPTY_LATENCIES = { min: 0, max: 0, avg: 0, p50: 0, p95: 0 }

const cfg: QwenAutocompleteConfig = {
  enabled: true,
  provider: "qwen-direct",
  endpoint: "",
  model: DEFAULT_MODEL,
  apiKey: "",
  debounceMs: 0,
  maxTokens: 128,
  maxPromptTokens: 1024,
  modelTimeout: 150,
  maxSuffixPercentage: 0.2,
  prefixPercentage: 0.3,
  temperature: 0.1,
  cacheEnabled: false,
  cacheMaxEntries: 1000,
  prefixChars: 12_000,
  suffixChars: 6_000,
  multifileContextEnabled: false,
  contextLength: 0,
  recentlyEditedEnabled: false,
  recentlyEditedInjectIntoPrompt: false,
  recentlyEditedMaxRanges: 3,
  recentlyEditedMaxRangeLines: 20,
  recentlyOpenedEnabled: false,
  recentlyOpenedInjectIntoPrompt: false,
  recentlyOpenedMaxFiles: 20,
  recentlyOpenedFileReadTimeoutMs: 80,
  importDefinitionsEnabled: false,
  importDefinitionsInjectIntoPrompt: false,
  importDefinitionsTimeoutMs: 100,
  importDefinitionsCacheSize: 10,
  rootPathEnabled: false,
  rootPathInjectIntoPrompt: false,
  rootPathTimeoutMs: 100,
  rootPathCacheSize: 100,
  trace: false,
  logLevel: "off",
  logPromptPreview: false,
  logCompletionPreview: true,
}

export class BenchmarkConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BenchmarkConfigError"
  }
}

export class BenchmarkFixtureError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message)
    this.name = "BenchmarkFixtureError"
  }
}

export function defaultBenchmarkOptions(input: Partial<BenchmarkRunOptions> = {}): BenchmarkRunOptions {
  const mode = input.mode ?? "mock"
  return {
    mode,
    fixturesPath: input.fixturesPath ?? DEFAULT_FIXTURES,
    outputPath: input.outputPath ?? DEFAULT_OUTPUT,
    repeat: input.repeat ?? (mode === "real" ? 3 : 1),
    cache: input.cache ?? false,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT,
    endpoint: input.endpoint,
    model: input.model,
    apiKeyEnv: input.apiKeyEnv,
    redactPrompts: input.redactPrompts ?? true,
    env: input.env,
    fetcher: input.fetcher,
    cwd: input.cwd,
    now: input.now,
  }
}

export async function runBenchmark(input: Partial<BenchmarkRunOptions> = {}): Promise<BenchmarkReport> {
  const opts = defaultBenchmarkOptions(input)
  validateOptions(opts)
  const root = opts.cwd ?? process.cwd()
  setWorkspaceRoot(root)
  const dir = path.resolve(root, opts.fixturesPath)
  const loaded = await loadBenchmarkFixtures(dir)
  const runs: Run[] = []
  for (const item of loaded) {
    const repeated = await repeatCase(item.fixture, opts, root)
    runs.push(...repeated)
  }
  return buildReport(opts, dir, runs)
}

export async function writeBenchmarkReports(
  report: BenchmarkReport,
  outputPath = DEFAULT_OUTPUT,
  cwd = process.cwd(),
): Promise<BenchmarkWriteResult> {
  const dir = path.resolve(cwd, outputPath)
  await fs.mkdir(dir, { recursive: true })
  const stamp = report.timestamp.replace(/[:.]/g, "-")
  const base = `qwen-autocomplete-phase-2A-${report.mode}-${stamp}`
  const jsonPath = path.join(dir, `${base}.json`)
  const markdownPath = path.join(dir, `${base}.md`)
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(markdownPath, markdownReport(report))
  return { jsonPath, markdownPath }
}

export async function loadBenchmarkFixtures(dir: string): Promise<Loaded[]> {
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort((a, b) => a.localeCompare(b))
  const loaded = await Promise.all(files.map((file) => loadFixture(path.join(dir, file))))
  return loaded.flat()
}

export function prepareFixture(fixture: BenchmarkFixture, root = process.cwd()): Prepared {
  validateFixture(fixture)
  const marker = fixture.cursorMarker || MARKER
  const index = fixture.document.indexOf(marker)
  if (index < 0) {
    throw new BenchmarkFixtureError("MISSING_CURSOR_MARKER", `${fixture.id} is missing ${marker}`)
  }
  const text = fixture.document.slice(0, index) + fixture.document.slice(index + marker.length)
  const pos = positionAt(text, index)
  const position = new vscode.Position(pos.line, pos.character)
  const document = createDocument(text, fixture, root)
  const selected = selectedInfo(fixture)
  const context = {
    selectedCompletionInfo: selected,
  } as vscode.InlineCompletionContext
  const line = document.lineAt(position).text
  return {
    fixture,
    text,
    position,
    document,
    context,
    linePrefix: line.slice(0, position.character),
    lineSuffix: line.slice(position.character),
  }
}

export function detectFailureReasons(input: DetectInput): FailureReason[] {
  const reasons = new Set<FailureReason>()
  const expected = input.fixture.expectation
  const shown = input.items.length > 0 && !!input.insert
  addRequestReasons(reasons, input, expected)
  addVisibilityReasons(reasons, shown, expected)
  if (!input.insert) return Array.from(reasons)
  addContentReasons(reasons, { ...input, insert: input.insert }, expected)
  addExpectationReasons(reasons, input.insert, expected)
  return Array.from(reasons)
}

export function latencyStats(values: number[]): { min: number; max: number; avg: number; p50: number; p95: number } {
  if (values.length === 0) return EMPTY_LATENCIES
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((total, item) => total + item, 0)
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  }
}

function addRequestReasons(
  reasons: Set<FailureReason>,
  input: DetectInput,
  expected: BenchmarkFixture["expectation"],
): void {
  if (expected.shouldRequest && !input.called) {
    reasons.add(input.guard ? "EXPECTED_REQUEST_BUT_BLOCKED" : "UNEXPECTED_REJECT")
  }
  if (!expected.shouldRequest && input.called) reasons.add("EXPECTED_BLOCK_BUT_REQUESTED")
  if (expected.guardShouldBlock && !input.guard) reasons.add("EXPECTED_BLOCK_BUT_REQUESTED")
}

function addVisibilityReasons(
  reasons: Set<FailureReason>,
  shown: boolean,
  expected: BenchmarkFixture["expectation"],
): void {
  if (expected.shouldShowGhostText && !shown) reasons.add("NO_GHOST_TEXT")
  if (!expected.shouldShowGhostText && shown) reasons.add("UNEXPECTED_GHOST_TEXT")
}

function addContentReasons(
  reasons: Set<FailureReason>,
  input: DetectInput & { insert: string },
  expected: BenchmarkFixture["expectation"],
): void {
  if (expected.mustNotEchoPrefix && hasPrefixEcho(input.insert, input.linePrefix)) reasons.add("PREFIX_ECHO")
  if (expected.mustNotOverlapSuffix && hasSuffixOverlap(input.insert, input.lineSuffix)) reasons.add("SUFFIX_OVERLAP")
  if (hasMarkdownLeakage(input.insert)) reasons.add("MARKDOWN_LEAKAGE")
  if (hasSpecialTokenLeakage(input.insert)) reasons.add("SPECIAL_TOKEN_LEAKAGE")
  if (hasSyntaxBreak(input.insert)) reasons.add("SYNTAX_BREAK")
  if (!validRange(input.range)) reasons.add("WRONG_RANGE")
  if (expected.allowMultiline === false && input.insert.includes("\n")) reasons.add("UNEXPECTED_MULTILINE")
  if (expected.allowMultiline === true && expected.shouldShowGhostText && !input.insert.includes("\n")) {
    reasons.add("UNEXPECTED_MULTILINE_REJECT")
  }
}

function addExpectationReasons(
  reasons: Set<FailureReason>,
  insert: string,
  expected: BenchmarkFixture["expectation"],
): void {
  if (expected.mustContainAny && !expected.mustContainAny.some((item) => insert.includes(item))) {
    reasons.add("UNEXPECTED_REJECT")
  }
  if (expected.mustNotContain?.some((item) => insert.includes(item))) reasons.add("UNEXPECTED_REJECT")
}

async function loadFixture(file: string): Promise<Loaded[]> {
  const raw = await fs.readFile(file, "utf8")
  const parsed = JSON.parse(raw) as unknown
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((value) => ({ fixture: toFixture(value), file }))
}

function toFixture(value: unknown): BenchmarkFixture {
  if (!record(value)) throw new BenchmarkFixtureError("INVALID_FIXTURE", "Fixture must be an object.")
  return value as BenchmarkFixture
}

function validateFixture(fixture: BenchmarkFixture): void {
  const valid =
    typeof fixture.id === "string" &&
    typeof fixture.title === "string" &&
    typeof fixture.languageId === "string" &&
    typeof fixture.fileName === "string" &&
    typeof fixture.cursorMarker === "string" &&
    typeof fixture.document === "string" &&
    record(fixture.expectation) &&
    typeof fixture.expectation.shouldRequest === "boolean" &&
    typeof fixture.expectation.shouldShowGhostText === "boolean"
  if (!valid) throw new BenchmarkFixtureError("INVALID_FIXTURE", "Fixture has invalid shape.")
}

async function repeatCase(fixture: BenchmarkFixture, opts: BenchmarkRunOptions, root: string): Promise<Run[]> {
  const count = Math.max(1, Math.floor(opts.repeat ?? 1))
  const runs: Run[] = []
  for (const _ of Array.from({ length: count })) {
    runs.push(await runCase(fixture, opts, root))
  }
  return runs
}

async function runCase(fixture: BenchmarkFixture, opts: BenchmarkRunOptions, root: string): Promise<Run> {
  const started = Date.now()
  try {
    return await executeCase(fixture, opts, root, started)
  } catch (err) {
    return failedRun(fixture, err, Date.now() - started)
  }
}

async function executeCase(
  fixture: BenchmarkFixture,
  opts: BenchmarkRunOptions,
  root: string,
  started: number,
): Promise<Run> {
  const prep = prepareFixture(fixture, root)
  const token = cancellationToken()
  const state = {
    guard: false,
    called: false,
    request: undefined as Record<string, unknown> | undefined,
    raw: undefined as string | undefined,
  }
  const provider = new KiloQwenInlineCompletionProvider({
    read: () => configFor(opts),
    debouncer: new AutocompleteDebouncer(),
    guard: async (document) => {
      const blocked = await shouldGuardQwenDocument(document)
      state.guard = blocked
      return blocked
    },
    client: clientFor(fixture, opts, state),
    log: () => {},
  })
  const pending = provider.provideInlineCompletionItems(prep.document, prep.position, prep.context, token)
  const result = await itemsWithTimeout(pending, token, opts.timeoutMs)
  provider.dispose()
  if (result.timeout) {
    return {
      fixture,
      reasons: ["TIMEOUT"],
      latency: Date.now() - started,
      guard: state.guard,
      called: state.called,
      cancelled: true,
      stale: false,
      raw: state.raw,
      request: state.request,
      items: [],
      multiline: false,
    }
  }
  const items = result.items
  const item = items[0]
  const insert = item ? insertText(item) : undefined
  const reasons = detectFailureReasons({
    fixture,
    guard: state.guard,
    called: state.called,
    items,
    insert,
    linePrefix: prep.linePrefix,
    lineSuffix: prep.lineSuffix,
    range: item?.range,
  })
  return {
    fixture,
    reasons,
    latency: Date.now() - started,
    guard: state.guard,
    called: state.called,
    cancelled: token.isCancellationRequested,
    stale: state.called && items.length === 0 && reasons.length === 0,
    raw: state.raw,
    request: state.request,
    items,
    insert,
    range: rangePreview(item?.range),
    multiline: !!insert?.includes("\n"),
  }
}

function clientFor(
  fixture: BenchmarkFixture,
  opts: BenchmarkRunOptions,
  state: {
    guard: boolean
    called: boolean
    request?: Record<string, unknown>
    raw?: string
  },
): QwenFimClient {
  return {
    complete: async (input: QwenFimCompleteInput) => {
      state.called = true
      state.request = requestPreview(input, opts.redactPrompts)
      if (opts.mode === "mock") {
        const raw = fixture.mockCompletion ?? ""
        state.raw = raw
        return raw
      }
      const client = new QwenFimClient(opts.fetcher ?? fetch)
      const raw = await client.complete(input)
      state.raw = raw
      return raw
    },
  } as QwenFimClient
}

function configFor(opts: BenchmarkRunOptions): QwenAutocompleteConfig {
  const env = opts.env ?? process.env
  const key = opts.apiKeyEnv ? (env[opts.apiKeyEnv] ?? "") : ""
  return {
    ...cfg,
    endpoint: opts.endpoint ?? "http://mock-qwen.invalid/v1/completions",
    model: opts.model ?? DEFAULT_MODEL,
    apiKey: key,
    cacheEnabled: opts.cache ?? false,
  }
}

function validateOptions(opts: BenchmarkRunOptions): void {
  if (opts.mode === "mock") return
  const env = opts.env ?? process.env
  const key = opts.apiKeyEnv ? env[opts.apiKeyEnv] : undefined
  if (!opts.endpoint) throw new BenchmarkConfigError("Real mode requires --endpoint.")
  if (!opts.model) throw new BenchmarkConfigError("Real mode requires --model.")
  if (!opts.apiKeyEnv) throw new BenchmarkConfigError("Real mode requires --api-key-env.")
  if (!key) throw new BenchmarkConfigError(`Real mode requires a nonempty ${opts.apiKeyEnv}.`)
}

async function itemsWithTimeout(
  pending: Promise<vscode.InlineCompletionItem[]>,
  token: Token,
  timeout: number,
): Promise<{ timeout: true } | { timeout: false; items: vscode.InlineCompletionItem[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => {
      token.cancel()
      resolve({ timeout: true })
    }, timeout)
  })
  const run = pending.then((items) => ({ timeout: false as const, items }))
  const result = await Promise.race([run, limit])
  if (timer) clearTimeout(timer)
  return result
}

function failedRun(fixture: BenchmarkFixture, err: unknown, latency: number): Run {
  const reason = err instanceof BenchmarkFixtureError ? err.reason : "QWEN_ERROR"
  return {
    fixture,
    reasons: [reason],
    latency,
    guard: false,
    called: false,
    cancelled: false,
    stale: false,
    items: [],
    multiline: false,
    error: err instanceof Error ? err.message : String(err),
  }
}

function buildReport(opts: BenchmarkRunOptions, dir: string, runs: Run[]): BenchmarkReport {
  const groups = groupRuns(runs)
  const cases = groups.map((items) => caseReport(items, opts.redactPrompts))
  const latency = latencyStats(runs.map((run) => run.latency))
  const metrics = buildMetrics(cases, runs, latency)
  const total = cases.length
  const passed = cases.filter((item) => item.pass).length
  const failed = total - passed
  return {
    phase: "2A",
    mode: opts.mode,
    timestamp: opts.now?.() ?? new Date().toISOString(),
    config: {
      fixturesPath: dir,
      repeat: opts.repeat ?? (opts.mode === "real" ? 3 : 1),
      timeoutMs: opts.timeoutMs,
      cacheEnabled: opts.cache ?? false,
      endpoint: opts.mode === "real" ? opts.endpoint : undefined,
      model: opts.mode === "real" ? opts.model : (opts.model ?? DEFAULT_MODEL),
      redactedPrompts: opts.redactPrompts,
    },
    summary: {
      total,
      passed,
      failed,
      ghostTextShownRate: rate(metrics.ghostTextShownCount, total),
      noSuggestionRate: rate(metrics.noSuggestionCount, total),
      manualAcceptEligibleRate: rate(metrics.manualAcceptEligibleCount, total),
      latencyP50Ms: latency.p50,
      latencyP95Ms: latency.p95,
    },
    metrics,
    cases,
  }
}

function buildMetrics(
  cases: BenchmarkCaseReport[],
  runs: Run[],
  latency: { min: number; max: number; avg: number; p50: number; p95: number },
): Record<string, number> {
  const total = cases.length
  const shown = cases.filter((item) => item.observed.itemCount > 0)
  const none = cases.filter((item) => item.observed.itemCount === 0)
  const metric: Record<string, number> = {
    totalFixtures: total,
    passed: cases.filter((item) => item.pass).length,
    failed: cases.filter((item) => !item.pass).length,
    ghostTextShownCount: shown.length,
    ghostTextShownRate: rate(shown.length, total),
    noSuggestionCount: none.length,
    noSuggestionRate: rate(none.length, total),
    wrongApplyCount: cases.filter((item) => hasAny(item, ["PREFIX_ECHO", "SUFFIX_OVERLAP", "WRONG_RANGE"])).length,
    prefixEchoCount: cases.filter((item) => item.failureReasons.includes("PREFIX_ECHO")).length,
    suffixOverlapCount: cases.filter((item) => item.failureReasons.includes("SUFFIX_OVERLAP")).length,
    markdownLeakageCount: cases.filter((item) => item.failureReasons.includes("MARKDOWN_LEAKAGE")).length,
    specialTokenLeakageCount: cases.filter((item) => item.failureReasons.includes("SPECIAL_TOKEN_LEAKAGE")).length,
    hallucinatedApiCount: runs.filter((run) => hasHallucinatedApi(run)).length,
    syntaxBreakCount: cases.filter((item) => item.failureReasons.includes("SYNTAX_BREAK")).length,
    unexpectedRejectCount: cases.filter((item) => item.failureReasons.includes("UNEXPECTED_REJECT")).length,
    requestAttemptedCount: runs.filter((run) => run.called).length,
    requestCancelledCount: runs.filter((run) => run.cancelled).length,
    staleResponseCount: runs.filter((run) => run.stale).length,
    guardBlockedCount: runs.filter((run) => run.guard).length,
    multilineAllowedCount: cases.filter((item) => item.observed.multilineShown && allowMultiline(item, runs)).length,
    multilineDisallowedCount: cases.filter((item) => !allowMultiline(item, runs)).length,
    multilineShownCount: cases.filter((item) => item.observed.multilineShown).length,
    multilineUnexpectedlyShownCount: cases.filter((item) => item.failureReasons.includes("UNEXPECTED_MULTILINE"))
      .length,
    multilineUnexpectedlyRejectedCount: cases.filter((item) =>
      item.failureReasons.includes("UNEXPECTED_MULTILINE_REJECT"),
    ).length,
    manualAcceptEligibleCount: cases.filter((item) => item.pass && item.observed.itemCount > 0).length,
    manualAcceptEligibleRate: rate(cases.filter((item) => item.pass && item.observed.itemCount > 0).length, total),
    latencyMinMs: latency.min,
    latencyMaxMs: latency.max,
    latencyAvgMs: latency.avg,
    latencyP50Ms: latency.p50,
    latencyP95Ms: latency.p95,
  }
  return metric
}

function caseReport(runs: Run[], redact: boolean): BenchmarkCaseReport {
  const first = runs[0]!
  const reasons = unique(runs.flatMap((run) => run.reasons))
  const lat = latencyStats(runs.map((run) => run.latency))
  const shown = runs.find((run) => run.insert) ?? first
  return {
    id: first.fixture.id,
    title: first.fixture.title,
    pass: reasons.length === 0,
    failureReasons: reasons,
    latencyMs: lat.p50,
    observed: {
      guardBlocked: runs.some((run) => run.guard),
      qwenCalled: runs.some((run) => run.called),
      itemCount: Math.max(...runs.map((run) => run.items.length)),
      insertTextPreview: shown.insert ? preview(shown.insert) : undefined,
      rangePreview: shown.range,
      multilineShown: runs.some((run) => run.multiline),
      requestPreview: shown.request,
      rawCompletionPreview: shown.raw ? preview(redact ? API_KEY_REDACTION : shown.raw) : undefined,
    },
  }
}

function groupRuns(runs: Run[]): Run[][] {
  const groups = new Map<string, Run[]>()
  for (const run of runs) {
    const group = groups.get(run.fixture.id) ?? []
    group.push(run)
    groups.set(run.fixture.id, group)
  }
  return Array.from(groups.values())
}

function markdownReport(report: BenchmarkReport): string {
  const failed = report.cases.filter((item) => !item.pass)
  const lines = [
    "# qwen-direct Autocomplete Benchmark",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Mode | ${report.mode} |`,
    `| Total | ${report.summary.total} |`,
    `| Passed | ${report.summary.passed} |`,
    `| Failed | ${report.summary.failed} |`,
    `| Ghost text shown rate | ${percent(report.summary.ghostTextShownRate)} |`,
    `| No suggestion rate | ${percent(report.summary.noSuggestionRate)} |`,
    `| Manual accept eligible rate | ${percent(report.summary.manualAcceptEligibleRate)} |`,
    "",
    "## Failed Cases",
    "",
    "| Case | Reasons | Observed |",
    "|---|---|---|",
    ...failed.map(
      (item) =>
        `| ${item.id} | ${item.failureReasons.join(", ")} | ${item.observed.insertTextPreview ?? "no suggestion"} |`,
    ),
    "",
    "## Latency",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Min | ${round(report.metrics.latencyMinMs)} ms |`,
    `| Max | ${round(report.metrics.latencyMaxMs)} ms |`,
    `| Avg | ${round(report.metrics.latencyAvgMs)} ms |`,
    `| p50 | ${round(report.metrics.latencyP50Ms)} ms |`,
    `| p95 | ${round(report.metrics.latencyP95Ms)} ms |`,
    "",
    "## Per-case Results",
    "",
    "| Case | Result | Latency | Notes |",
    "|---|---|---:|---|",
    ...report.cases.map(
      (item) =>
        `| ${item.id} | ${item.pass ? "PASS" : "FAIL"} | ${round(item.latencyMs)} ms | ${
          item.failureReasons.join(", ") || "ok"
        } |`,
    ),
    "",
  ]
  return `${lines.join("\n")}\n`
}

function requestPreview(input: QwenFimCompleteInput, redact: boolean): Record<string, unknown> {
  return {
    endpoint: input.endpoint,
    model: input.model,
    apiKey: input.apiKey ? API_KEY_REDACTION : "",
    prompt: redact ? PROMPT_REDACTION : input.prompt,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
  }
}

function selectedInfo(fixture: BenchmarkFixture): vscode.SelectedCompletionInfo | undefined {
  const selected = fixture.selectedCompletionInfo
  if (!selected) return undefined
  return {
    text: selected.text,
    range: new vscode.Range(
      new vscode.Position(selected.range.start.line, selected.range.start.character),
      new vscode.Position(selected.range.end.line, selected.range.end.character),
    ),
  } as vscode.SelectedCompletionInfo
}

function createDocument(text: string, fixture: BenchmarkFixture, root: string): vscode.TextDocument {
  const lines = text.split("\n")
  const file = path.resolve(root, fixture.fileName)
  const uri = { scheme: "file", fsPath: file, path: file }
  return {
    uri,
    languageId: fixture.languageId,
    version: 1,
    lineCount: lines.length,
    lineAt: (value: number | Pos) => {
      const line = typeof value === "number" ? value : value.line
      const current = lines[line] ?? ""
      return {
        text: current,
        range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, current.length)),
      }
    },
    getText: (range?: Range) => {
      if (!range) return text
      return text.slice(offsetAt(lines, range.start), offsetAt(lines, range.end))
    },
  } as unknown as vscode.TextDocument
}

function setWorkspaceRoot(root: string): void {
  ;(vscode.workspace as unknown as { workspaceFolders?: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [
    { uri: { fsPath: root } },
  ]
}

function cancellationToken(): Token {
  const callbacks: Array<() => void> = []
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      callbacks.push(cb)
      return { dispose: () => {} }
    },
    cancel: () => {
      token.isCancellationRequested = true
      callbacks.forEach((cb) => cb())
    },
  }
  return token as Token
}

function positionAt(text: string, index: number): Pos {
  const before = text.slice(0, index).split("\n")
  return {
    line: before.length - 1,
    character: before[before.length - 1]?.length ?? 0,
  }
}

function offsetAt(lines: string[], pos: Pos): number {
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character
}

function insertText(item: vscode.InlineCompletionItem): string {
  return typeof item.insertText === "string" ? item.insertText : String(item.insertText)
}

function rangePreview(range: unknown): string | undefined {
  if (!rangeInfo(range)) return undefined
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`
}

function validRange(range: unknown): boolean {
  if (!rangeInfo(range)) return false
  if (range.start.line > range.end.line) return false
  if (range.start.line === range.end.line && range.start.character > range.end.character) return false
  return true
}

function hasPrefixEcho(text: string, prefix: string): boolean {
  const token = prefix.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? ""
  if (token.length < 2) return false
  return text.startsWith(token)
}

function hasSuffixOverlap(text: string, suffix: string): boolean {
  const trimmed = suffix.trimStart()
  if (!trimmed) return false
  const probe = trimmed.slice(0, Math.min(12, trimmed.length))
  return probe.length > 0 && text.trimEnd().endsWith(probe)
}

function hasMarkdownLeakage(text: string): boolean {
  return text.includes("```")
}

function hasSpecialTokenLeakage(text: string): boolean {
  return /<\|(?:fim|im|endoftext|repo_name|file_sep)|<COMPLETION>/.test(text)
}

function hasSyntaxBreak(text: string): boolean {
  const open = (text.match(/[({[]/g) ?? []).length
  const close = (text.match(/[)}\]]/g) ?? []).length
  return close - open > 2
}

function hasHallucinatedApi(run: Run): boolean {
  return !!run.fixture.expectation.mustNotContain?.some((item) => run.insert?.includes(item))
}

function hasAny(item: BenchmarkCaseReport, reasons: FailureReason[]): boolean {
  return reasons.some((reason) => item.failureReasons.includes(reason))
}

function allowMultiline(item: BenchmarkCaseReport, runs: Run[]): boolean {
  return runs.find((run) => run.fixture.id === item.id)?.fixture.expectation.allowMultiline === true
}

function percentile(sorted: number[], percent: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((percent / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function percent(value: number): string {
  return `${round(value * 100)}%`
}

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180)
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function rangeInfo(value: unknown): value is Range {
  if (!record(value)) return false
  if (!record(value.start) || !record(value.end)) return false
  return (
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  )
}
