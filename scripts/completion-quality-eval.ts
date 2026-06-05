import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { adaptAndValidateInlineCompletionEdit, type CompletionEdit, type CompletionRange } from "../src/completion-edit"
import { inferCompletionIndent } from "../src/completion-indent"
import { runCompletionCandidatePipeline, type CompletionCandidatePipelineResult } from "../src/completion-candidate-pipeline"
import { packCompletionContext } from "../src/completion-context"
import { planCompletion } from "../src/completion-plan"
import {
  scoreCompletionQuality,
  type CompletionQualityFixture,
  type CompletionQualityIssueKind,
  type CompletionQualityScore,
} from "../src/completion-quality"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "../src/completion-request-coordinator"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel, shouldRetryCompletionRejection } from "../src/completion-router"
import type { CompletionPlan, RetrievedCompletionSnippet } from "../src/completion-types"
import type { OpenCodeMessage, RemoteSettings } from "../src/types"

const CURSOR_MARKER = "<|cursor|>"
const DEFAULT_REPEAT = 3

type EvalOptions = {
  fixtureDir: string
  repeat: number
  reportPath: string
  summaryPath: string
  fixtureFilter?: string
  failUnder?: number
}

type ParsedDocument = {
  text: string
  line: number
  character: number
  prefix: string
  suffix: string
  lines: string[]
}

type RunSnapshot = {
  repeatIndex: number
  rawText: string
  postprocessText: string
  candidateText: string
  fallbackText: string
  edit?: CompletionEdit
  decision: CompletionCandidatePipelineResult["decision"]
  reasons: string[]
  appliedText: string
  acceptedText: string
  latencyMs: number
  attempts: Array<{
    attempt: "initial" | "retry"
    rawText: string
    postprocessText: string
    candidateText: string
    fallbackText: string
    decision: CompletionCandidatePipelineResult["decision"]
    reasons: string[]
    rejectionReason?: string
  }>
}

type EvalRecord = {
  id: string
  category?: string
  languageId: string
  filePath: string
  triggerKind: CompletionQualityFixture["triggerKind"]
  expectedIntent: string
  planKind: CompletionPlan["kind"]
  insertMode: CompletionPlan["insertMode"]
  route: string
  modelCalled: boolean
  selectedContextKinds: string[]
  selectedContextTitles: string[]
  repeats: RunSnapshot[]
  interactionReasons: string[]
  score: CompletionQualityScore
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fixtures = (await loadFixtures(options.fixtureDir))
    .filter((fixture) => !options.fixtureFilter || fixture.id.includes(options.fixtureFilter))
  if (fixtures.length === 0) throw new Error(`No completion quality fixtures found in ${options.fixtureDir}`)

  const records: EvalRecord[] = []
  for (const fixture of fixtures) {
    records.push(await runFixture(fixture, options.repeat))
  }

  await writeFile(options.reportPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
  await writeFile(options.summaryPath, renderSummary(records, options))

  const average = averageScore(records)
  console.log(`completion-quality fixtures=${records.length} repeat=${options.repeat} average=${average.toFixed(1)}`)
  console.log(`report=${options.reportPath}`)
  console.log(`summary=${options.summaryPath}`)
  if (options.failUnder !== undefined && average < options.failUnder) {
    throw new Error(`Average quality score ${average.toFixed(1)} is below --fail-under ${options.failUnder}`)
  }
}

async function loadFixtures(fixtureDir: string): Promise<CompletionQualityFixture[]> {
  const files = (await readdir(fixtureDir))
    .filter((file) => /\.(?:json|ts)$/.test(file))
    .sort()
  const fixtures: CompletionQualityFixture[] = []
  for (const file of files) {
    const fullPath = resolve(fixtureDir, file)
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(await readFile(fullPath, "utf8")) as unknown
      fixtures.push(...fixtureArray(parsed, fullPath))
    } else {
      const module = await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`)
      fixtures.push(...fixtureArray(module.default ?? module.fixtures, fullPath))
    }
  }
  validateFixtures(fixtures)
  return fixtures
}

function fixtureArray(input: unknown, source: string) {
  if (!Array.isArray(input)) throw new Error(`Fixture file must export an array: ${source}`)
  return input as CompletionQualityFixture[]
}

function validateFixtures(fixtures: CompletionQualityFixture[]) {
  const ids = new Set<string>()
  for (const fixture of fixtures) {
    const missing = [
      fixture.id ? "" : "id",
      fixture.languageId ? "" : "languageId",
      fixture.filePath ? "" : "filePath",
      fixture.document ? "" : "document",
      fixture.triggerKind ? "" : "triggerKind",
      fixture.expectedIntent ? "" : "expectedIntent",
      Array.isArray(fixture.mustContain) ? "" : "mustContain",
      Array.isArray(fixture.mustNotContain) ? "" : "mustNotContain",
      typeof fixture.maxLines === "number" ? "" : "maxLines",
      Array.isArray(fixture.checks) ? "" : "checks",
    ].filter(Boolean)
    if (missing.length > 0) throw new Error(`Fixture ${fixture.id || "<unknown>"} is missing: ${missing.join(", ")}`)
    if (ids.has(fixture.id)) throw new Error(`Duplicate fixture id: ${fixture.id}`)
    ids.add(fixture.id)
    if (!fixture.document.includes(CURSOR_MARKER)) throw new Error(`Fixture ${fixture.id} is missing ${CURSOR_MARKER}`)
  }
}

async function runFixture(fixture: CompletionQualityFixture, repeat: number): Promise<EvalRecord> {
  const parsed = parseDocument(fixture.document)
  const base = buildBasePipelineInput(fixture, parsed)
  const runs: RunSnapshot[] = []
  for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
    runs.push(runOnce(fixture, parsed, base, repeatIndex))
  }

  const interactionReasons = await runInteractionProbes(fixture, parsed, base, runs[0])
  const selectedContextText = base.contextPack.selected.map((block) => block.text).join("\n")
  const score = scoreCompletionQuality({
    fixture,
    outcome: baseLastOutcome(runs[0]),
    acceptedText: runs[0].acceptedText,
    appliedText: runs[0].appliedText,
    linePrefix: base.editInput.linePrefix,
    lineSuffix: base.editInput.lineSuffix,
    edit: runs[0].edit,
    repeatAcceptedTexts: runs.map((run) => run.acceptedText),
    repeatDecisions: runs.map((run) => run.decision),
    latencyMs: Math.max(...runs.map((run) => run.latencyMs)),
    selectedContextText,
    interactionReasons,
  })

  return {
    id: fixture.id,
    category: fixture.category,
    languageId: fixture.languageId,
    filePath: fixture.filePath,
    triggerKind: fixture.triggerKind,
    expectedIntent: fixture.expectedIntent,
    planKind: base.plan.kind,
    insertMode: base.plan.insertMode,
    route: base.plan.kind === "disabled" ? "disabled" : routeName(base.route),
    modelCalled: base.plan.kind !== "disabled" && base.route.kind === "model",
    selectedContextKinds: base.contextPack.selected.map((block) => block.kind),
    selectedContextTitles: base.contextPack.selected.map((block) => block.title),
    repeats: runs,
    interactionReasons,
    score,
  }
}

function buildBasePipelineInput(fixture: CompletionQualityFixture, parsed: ParsedDocument) {
  const lineText = parsed.lines[parsed.line] ?? ""
  const linePrefix = lineText.slice(0, parsed.character)
  const lineSuffix = lineText.slice(parsed.character)
  const currentWord = currentWordBeforeCursor(linePrefix, parsed.line)
  const indent = inferCompletionIndent({
    lines: parsed.lines,
    line: parsed.line,
    linePrefix,
    fallbackIndentUnit: "    ",
  })
  const initialPlan = planCompletion({
    languageId: fixture.languageId,
    linePrefix,
    lineSuffix,
    currentWord: currentWord?.text,
    previousNonEmptyLine: previousNonEmptyLineBefore(parsed.lines, parsed.line),
  })
  const retrievedSnippets = fixture.retrievedSnippets ?? []
  const plan = resolveCompletionPlanAfterSymbolRetrieval(initialPlan, retrievedSnippets)
  const route = routeCompletionModel({
    plan,
    settings: settings(),
    retrievedSnippets,
  })
  const contextPack = packCompletionContext({
    plan,
    languageId: fixture.languageId,
    currentPath: fixture.filePath,
    prefix: parsed.prefix,
    suffix: parsed.suffix,
    retrievedSnippets,
    openTabs: fixture.openTabs,
  })
  return {
    editInput: {
      languageId: fixture.languageId,
      linePrefix,
      lineSuffix,
      position: { line: parsed.line, character: parsed.character },
      indent,
      currentWord: currentWord?.text,
      currentWordRange: currentWord?.range,
    },
    plan,
    route,
    retrievedSnippets,
    contextPack,
  }
}

function runOnce(
  fixture: CompletionQualityFixture,
  parsed: ParsedDocument,
  base: ReturnType<typeof buildBasePipelineInput>,
  repeatIndex: number,
): RunSnapshot {
  const started = Date.now()
  const initial = runPipelineAttempt(fixture, base, repeatIndex, "initial")
  const attempts = [attemptRecord("initial", initial)]
  let final = initial
  if (
    initial.decision === "rejected" &&
    base.route.kind === "model" &&
    shouldRetryCompletionRejection({
      reason: initial.rejectionReason ?? "",
      plan: base.plan,
      textProfile: base.route.textProfile,
    })
  ) {
    const retry = runPipelineAttempt(fixture, base, repeatIndex, "retry")
    attempts.push(attemptRecord("retry", retry))
    final = retry
  }

  const acceptedEdit = final.decision === "accepted" ? final.edit : undefined
  const appliedText = acceptedEdit ? applyEdit(parsed.text, acceptedEdit, base.editInput.position) : parsed.text
  return {
    repeatIndex,
    rawText: final.rawText,
    postprocessText: final.postprocessText,
    candidateText: final.candidateText,
    fallbackText: final.fallbackText,
    edit: acceptedEdit,
    decision: final.decision,
    reasons: final.reasons,
    appliedText,
    acceptedText: acceptedEdit?.insertText ?? "",
    latencyMs: simulatedLatency(fixture, repeatIndex) ?? elapsedMs(started),
    attempts,
  }
}

function runPipelineAttempt(
  fixture: CompletionQualityFixture,
  base: ReturnType<typeof buildBasePipelineInput>,
  repeatIndex: number,
  attempt: "initial" | "retry",
) {
  if (base.plan.kind === "disabled") return disabledPipelineResult()
  const rawText = rawTextForAttempt(fixture, base, repeatIndex, attempt)
  return runCompletionCandidatePipeline({
    response: modelMessage(rawText),
    textProfile: base.route.kind === "model" ? base.route.textProfile : "generic-chat",
    editInput: base.editInput,
    plan: base.plan,
    retrievedSnippets: base.retrievedSnippets,
    selectedCompletionInfo: fixture.selectedCompletionInfo,
  })
}

function disabledPipelineResult(): CompletionCandidatePipelineResult {
  return {
    rawText: "",
    postprocessText: "",
    fallbackText: "",
    candidateText: "",
    editText: "",
    decision: "rejected",
    reasons: ["plan:disabled-plan"],
    rejectionReason: "disabled-plan",
    postprocessDebug: { prefixMode: "none" },
    latencyMs: {
      postprocess: 0,
      edit: 0,
      total: 0,
    },
  }
}

function rawTextForAttempt(
  fixture: CompletionQualityFixture,
  base: ReturnType<typeof buildBasePipelineInput>,
  repeatIndex: number,
  attempt: "initial" | "retry",
) {
  if (base.route.kind === "deterministic-symbol") return base.route.text
  if (base.route.kind === "none") return ""
  const outputs = attempt === "retry"
    ? (fixture.retryModelOutputs?.length ? fixture.retryModelOutputs : fixture.modelOutputs)
    : fixture.modelOutputs
  if (!outputs?.length) return ""
  return outputs[repeatIndex % outputs.length] ?? ""
}

function attemptRecord(attempt: "initial" | "retry", result: CompletionCandidatePipelineResult) {
  return {
    attempt,
    rawText: result.rawText,
    postprocessText: result.postprocessText,
    candidateText: result.candidateText,
    fallbackText: result.fallbackText,
    decision: result.decision,
    reasons: result.reasons,
    rejectionReason: result.rejectionReason,
  }
}

async function runInteractionProbes(
  fixture: CompletionQualityFixture,
  parsed: ParsedDocument,
  base: ReturnType<typeof buildBasePipelineInput>,
  firstRun: RunSnapshot | undefined,
) {
  const reasons: string[] = []
  if (!firstRun) return reasons
  if (fixture.checks.includes("cache-hit")) {
    const cacheHit = await runCacheProbe(fixture, base, firstRun)
    reasons.push(cacheHit ? "cache-hit" : "cache-miss")
  }
  if (fixture.checks.includes("stale-key") || fixture.checks.includes("fast-typing")) {
    const staleKey = await runStaleKeyProbe(base, firstRun, parsed.line)
    reasons.push(staleKey ? "stale-key" : "stale-key-miss")
  }
  if (fixture.checks.includes("retry")) {
    const retried = firstRun.attempts.some((attempt) => attempt.attempt === "retry")
    reasons.push(retried ? "retry-used" : "retry-not-used")
  }
  return reasons
}

async function runCacheProbe(
  fixture: CompletionQualityFixture,
  base: ReturnType<typeof buildBasePipelineInput>,
  firstRun: RunSnapshot,
) {
  const outcome = outcomeFromRun(firstRun)
  const coordinator = new CompletionRequestCoordinator({
    delay: () => Promise.resolve(),
  })
  const input = {
    key: fixture.id,
    details: `fixture=${fixture.id}`,
    debounceMs: 0,
    validateEdit: (edit: CompletionEdit) =>
      adaptAndValidateInlineCompletionEdit({
        edit,
        editInput: base.editInput,
        plan: base.plan,
        selectedCompletionInfo: fixture.selectedCompletionInfo,
      }),
    runRemote: async () => outcome,
  }
  const first = coordinator.request(input)
  await first.pending
  const second = coordinator.request({
    ...input,
    runRemote: async () => {
      throw new Error("cache probe should not call remote")
    },
  })
  return second.immediate?.status === "ok" && second.immediate.source === "cache"
}

async function runStaleKeyProbe(
  base: ReturnType<typeof buildBasePipelineInput>,
  firstRun: RunSnapshot,
  line: number,
) {
  const coordinator = new CompletionRequestCoordinator({
    delay: (ms, signal) => {
      if (ms <= 0) return Promise.resolve()
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    },
  })
  const stale = coordinator.request({
    key: "old",
    details: `line=${line + 1}`,
    debounceMs: 50,
    runRemote: async () => outcomeFromRun(firstRun),
  })
  const next = coordinator.request({
    key: "new",
    details: `line=${line + 1}`,
    debounceMs: 0,
    validateEdit: (edit) =>
      adaptAndValidateInlineCompletionEdit({
        edit,
        editInput: base.editInput,
        plan: base.plan,
      }),
    runRemote: async () => outcomeFromRun(firstRun),
  })
  const staleOutcome = await stale.pending
  await next.pending
  return staleOutcome?.status === "rejected" && staleOutcome.reason === "stale-key"
}

function outcomeFromRun(run: RunSnapshot): CompletionRequestOutcome {
  if (run.edit) {
    return {
      status: "ok",
      edit: run.edit,
      source: "remote",
    }
  }
  return {
    status: "rejected",
    reason: run.reasons.at(-1) ?? "rejected",
    source: "remote",
  }
}

function baseLastOutcome(run: RunSnapshot): CompletionCandidatePipelineResult {
  return {
    rawText: run.rawText,
    postprocessText: run.postprocessText,
    fallbackText: run.fallbackText,
    candidateText: run.candidateText,
    editText: run.acceptedText,
    edit: run.edit,
    decision: run.decision,
    reasons: run.reasons,
    rejectionReason: run.decision === "rejected" ? run.reasons.at(-1) : undefined,
    postprocessDebug: { prefixMode: "none" },
    latencyMs: {
      postprocess: 0,
      edit: 0,
      total: run.latencyMs,
    },
  }
}

function parseDocument(documentText: string): ParsedDocument {
  const first = documentText.indexOf(CURSOR_MARKER)
  const last = documentText.lastIndexOf(CURSOR_MARKER)
  if (first === -1 || first !== last) throw new Error(`Document must contain exactly one ${CURSOR_MARKER}`)
  const prefix = documentText.slice(0, first)
  const suffix = documentText.slice(first + CURSOR_MARKER.length)
  const text = `${prefix}${suffix}`.replace(/\r\n/g, "\n")
  const position = positionFromText(prefix.replace(/\r\n/g, "\n"))
  return {
    text,
    line: position.line,
    character: position.character,
    prefix: prefix.replace(/\r\n/g, "\n"),
    suffix: suffix.replace(/\r\n/g, "\n"),
    lines: text.split("\n"),
  }
}

function positionFromText(text: string) {
  const lines = text.split("\n")
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function currentWordBeforeCursor(linePrefix: string, line: number): { text: string; range: CompletionRange } | undefined {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)
  if (!match) return
  const text = match[0]
  const startCharacter = linePrefix.length - text.length
  return {
    text,
    range: {
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter: linePrefix.length,
    },
  }
}

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index -= 1) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function applyEdit(text: string, edit: CompletionEdit, position: { line: number; character: number }) {
  const range = edit.replaceRange ?? {
    startLine: position.line,
    startCharacter: position.character,
    endLine: position.line,
    endCharacter: position.character,
  }
  const lines = text.split("\n")
  const startLine = lines[range.startLine] ?? ""
  const endLine = lines[range.endLine] ?? ""
  const before = lines.slice(0, range.startLine)
  const after = lines.slice(range.endLine + 1)
  const replacement = `${startLine.slice(0, range.startCharacter)}${edit.insertText}${endLine.slice(range.endCharacter)}`
  return [...before, ...replacement.split("\n"), ...after].join("\n")
}

function routeName(route: ReturnType<typeof routeCompletionModel>) {
  if (route.kind === "model") return route.promptKind
  return route.kind
}

function simulatedLatency(fixture: CompletionQualityFixture, repeatIndex: number) {
  const latencies = fixture.simulatedLatencyMs
  if (!latencies?.length) return undefined
  return latencies[repeatIndex % latencies.length]
}

function modelMessage(text: string): OpenCodeMessage {
  return {
    info: { id: "completion-quality-eval", role: "assistant" },
    parts: [{ type: "text", text }],
  }
}

function settings(): RemoteSettings {
  return {
    serverUrl: "http://localhost:4096",
    username: "opencode",
    defaultModel: "",
    defaultAgent: "",
    localOnlyAgent: "vscode-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible",
      profile: "generic-chat",
      apiBaseUrl: "http://localhost:8000/v1",
      model: "qwen",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      debounceMs: 0,
      logLevel: "off",
    },
    codeGraph: {
      enabled: false,
      promptOnWorkspaceOpen: true,
      analysisMode: "auto",
      maxFiles: 50000,
      maxContextBytes: 24000,
      maxEvidenceBytes: 60000,
      maxGraphDepth: 2,
      maxFanout: 40,
      maxDeepFiles: 24,
      maxStateTransitions: 120,
      watcherRescanThreshold: 750,
      workerConcurrency: 4,
      queryCacheSize: 80,
      memoryLimitMb: 4096,
      compileCommandsPath: "",
      clangdPath: "",
      scipClangPath: "",
      excludeGlobs: [],
    },
    analysis: {
      bridgeEnabled: true,
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      maxFileSliceBytes: 16000,
      maxGraphEdges: 120,
      maxPaths: 20,
    },
    rag: {
      embedding: {
        enabled: false,
        endpoint: "",
        model: "",
        batchSize: 32,
        maxTokensPerRequest: 8000,
        concurrentRequests: 2,
        maxInFlightTokens: 16000,
        encodingFormat: "float",
        checkpointMode: "safe",
        checkpointChunkInterval: 100,
        checkpointIntervalMs: 10000,
        timeoutMs: 30000,
        requestDelayMs: 0,
        maxRequestsPerRun: 0,
        maxRetries: 3,
        retryBackoffMs: 1000,
        resumeAutomatically: true,
        resumeDelayMs: 60000,
      },
      rerank: {
        enabled: false,
        endpoint: "",
        model: "",
      },
      allowedHosts: [],
      vectorTopK: 20,
      rerankTopK: 8,
    },
  }
}

function renderSummary(records: EvalRecord[], options: EvalOptions) {
  const gateCounts = countBy(records, (record) => record.score.gate)
  const issueCounts = countIssues(records)
  const categoryRows = [...groupBy(records, (record) => record.category ?? "uncategorized").entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([category, rows]) => `| ${category} | ${rows.length} | ${averageScore(rows).toFixed(1)} | ${worstIssue(rows)} |`)
  const worstRows = [...records]
    .sort((left, right) => left.score.qualityScore - right.score.qualityScore || left.id.localeCompare(right.id))
    .slice(0, 15)
    .map((record) => `| ${record.id} | ${record.category ?? ""} | ${record.score.qualityScore} | ${record.score.gate} | ${uniqueIssueKinds(record).join(", ") || "none"} |`)
  const issueRows = [...issueCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([issue, count]) => `| ${issue} | ${count} |`)

  return [
    "# Completion Quality Summary",
    "",
    `Generated by \`bun run eval:completion-quality -- --repeat ${options.repeat}\`.`,
    "",
    "## Gate Recommendations",
    "",
    "- score >=85: auto show",
    "- 70-84: manual only",
    "- <70: reject",
    "",
    "## Overview",
    "",
    `- Fixtures: ${records.length}`,
    `- Repeat: ${options.repeat}`,
    `- Average score: ${averageScore(records).toFixed(1)}`,
    `- Auto show: ${gateCounts.get("auto show") ?? 0}`,
    `- Manual only: ${gateCounts.get("manual only") ?? 0}`,
    `- Reject: ${gateCounts.get("reject") ?? 0}`,
    "",
    "## Category Scores",
    "",
    "| Category | Fixtures | Avg Score | Top Issue |",
    "| --- | ---: | ---: | --- |",
    ...categoryRows,
    "",
    "## Issue Counts",
    "",
    "| Issue | Count |",
    "| --- | ---: |",
    ...(issueRows.length ? issueRows : ["| none | 0 |"]),
    "",
    "## Worst Fixtures",
    "",
    "| Fixture | Category | Score | Gate | Issues |",
    "| --- | --- | ---: | --- | --- |",
    ...worstRows,
    "",
  ].join("\n")
}

function parseArgs(args: string[]): EvalOptions {
  const option = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const repeat = Number(option("--repeat") ?? DEFAULT_REPEAT)
  const failUnderValue = option("--fail-under")
  return {
    fixtureDir: resolve(option("--fixture-dir") ?? "test/completion-quality/fixtures"),
    repeat: Number.isFinite(repeat) && repeat > 0 ? Math.floor(repeat) : DEFAULT_REPEAT,
    reportPath: resolve(option("--report") ?? "completion-quality-report.jsonl"),
    summaryPath: resolve(option("--summary") ?? "completion-quality-summary.md"),
    fixtureFilter: option("--fixture"),
    failUnder: failUnderValue === undefined ? undefined : Number(failUnderValue),
  }
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item])
  }
  return groups
}

function countIssues(records: EvalRecord[]) {
  const counts = new Map<CompletionQualityIssueKind, number>()
  for (const record of records) {
    for (const issue of record.score.issues) {
      counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1)
    }
  }
  return counts
}

function worstIssue(records: EvalRecord[]) {
  const counts = countIssues(records)
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]
  return top ? `${top[0]} (${top[1]})` : "none"
}

function uniqueIssueKinds(record: EvalRecord) {
  return [...new Set(record.score.issues.map((issue) => issue.kind))]
}

function averageScore(records: EvalRecord[]) {
  if (records.length === 0) return 0
  return records.reduce((sum, record) => sum + record.score.qualityScore, 0) / records.length
}

function elapsedMs(started: number) {
  return Date.now() - started
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
