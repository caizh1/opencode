import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { CEmbeddedCompletionFixture } from "../src/completion-c-embedded-quality"
import type { CompletionProfile } from "../src/types"

type UiScenario = {
  id: string
  category: string
  triggerKind: CEmbeddedCompletionFixture["triggerKind"]
  mainFile: string
  relativePath?: string
  coverageFallback?: boolean
  openTabs?: string[]
  mutation?: {
    text: string
    insertedText: string
  }
  cursor: {
    line: number
    character: number
  }
}

export type UiResult = {
  id: string
  category: string
  path: string
  relativePath?: string
  cursor: {
    line: number
    character: number
  }
  triggerKind: CEmbeddedCompletionFixture["triggerKind"]
  inlineSuggestion: boolean
  inlineReturned: boolean
  commitAttempted: boolean
  textApplied: boolean
  acceptedAndApplied: boolean
  changed: boolean
  planKind?: string
  actualCIntent?: string
  retrievalMode?: string
  evidenceKinds: string[]
  selectedEvidenceCount: number
  contextLevel?: string
  promptKind?: string
  cEmbeddedEvidenceTrace?: Record<string, unknown>
  modelRoute?: string
  insertMode?: string
  inlineFirstLines: string[]
  qualityRejected: boolean
  flags: Record<string, boolean>
  notes: string[]
}

export type UiMatrixOptions = {
  all: boolean
  drive: boolean
  workspace: string
  codeApp: string
  apiBaseUrl?: string
  model?: string
  profile?: CompletionProfile
  waitMs: number
  fixtureFilter?: string
  qemuDirect: boolean
  qemuP2Matrix: boolean
  qemuCodeGraph: "off" | "on"
  qemuIndexWaitMs: number
  qemuIndexMaxFiles: number
  sourceWorkspace: string
  scenarioLimit: number
  restoreAfterEach: boolean
}

const CURSOR = "<|cursor|>"
const DEFAULT_WORKSPACE = "/tmp/opencode-c-embedded-ui-matrix"
const DEFAULT_QEMU_WORKSPACE = "/tmp/opencode-qemu-completion-ui-138"
const DEFAULT_QEMU_P2_WORKSPACE = join(process.cwd(), ".completion-quality", "qemu-p2-ui")
const DEFAULT_QEMU_SOURCE_WORKSPACE = "/Users/archer/Work/qemu"
const DEFAULT_CODE_APP = "/Applications/Visual Studio Code.app"
const BEFORE_TEXT = new WeakMap<UiResult, string>()
const AFTER_TEXT = new WeakMap<UiResult, string>()
type OutputLogSnapshot = Map<string, number>

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.qemuP2Matrix) {
    await runQemuP2Matrix(options)
    return
  }
  const run = await runUiMatrix(options)
  printRunPaths(run)
}

type UiMatrixRun = {
  options: UiMatrixOptions
  manifestPath: string
  paths: ReturnType<typeof reportPaths>
  results: UiResult[]
  outputText: string
}

async function runUiMatrix(options: UiMatrixOptions): Promise<UiMatrixRun> {
  const scenarios = options.qemuDirect
    ? await prepareQemuScenarios(options)
    : await prepareWorkspace(selectFixtures(await loadFixtures(), options), options)
  const manifestPath = join(options.workspace, "manifest.json")
  await writeFile(manifestPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    workspace: options.workspace,
    sourceWorkspace: options.qemuDirect ? options.sourceWorkspace : undefined,
    codeWorkspace: options.qemuDirect ? qemuCodeWorkspacePath(options) : undefined,
    mode: options.qemuDirect ? "qemu-direct" : options.all ? "all" : "sample",
    qemuP2Matrix: options.qemuP2Matrix || undefined,
    qemuCodeGraph: options.qemuDirect ? options.qemuCodeGraph : undefined,
    restoreAfterEach: options.qemuDirect ? options.restoreAfterEach : undefined,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      category: scenario.category,
      path: scenario.mainFile,
      relativePath: scenario.relativePath,
      cursor: scenario.cursor,
      triggerKind: scenario.triggerKind,
      coverageFallback: scenario.coverageFallback,
    })),
  }, null, 2)}\n`)

  let outputText = ""
  const results: UiResult[] = scenarios.map((scenario) => emptyResult(scenario))
  if (options.drive) {
    outputText = await driveVsCode(scenarios, options, results)
  } else {
    for (const result of results) result.notes.push("prepared only: --no-drive was set")
  }

  if (outputText) {
    applyOutputTelemetry(results, outputText)
    reconcileAcceptance(results)
  }
  const paths = reportPaths(options)
  const outputPath = paths.output
  const resultsPath = paths.results
  const reportPath = paths.report
  await writeFile(outputPath, outputText)
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`)
  await writeFile(reportPath, renderReport(results, options, outputText))
  if (options.qemuDirect) {
    await writeFile(paths.fixPlan, renderQemuFixPlan(results, options, outputText))
  }

  return { options, manifestPath, paths, results, outputText }
}

async function runQemuP2Matrix(options: UiMatrixOptions) {
  await rm(options.workspace, { recursive: true, force: true })
  await mkdir(options.workspace, { recursive: true })
  const variants: Array<{ name: string; codeGraph: UiMatrixOptions["qemuCodeGraph"] }> = [
    { name: "baseline-codegraph-off", codeGraph: "off" },
    { name: "p2-codegraph-on", codeGraph: "on" },
  ]
  const runs: UiMatrixRun[] = []
  for (const variant of variants) {
    const run = await runUiMatrix({
      ...options,
      qemuP2Matrix: true,
      qemuDirect: true,
      qemuCodeGraph: variant.codeGraph,
      workspace: join(options.workspace, variant.name),
    })
    runs.push(run)
    printRunPaths(run)
  }

  const reportPath = join(options.workspace, "qemu-p2-ui-comparison-report.md")
  const summaryPath = join(options.workspace, "qemu-p2-ui-summary.json")
  await writeFile(reportPath, renderQemuP2ComparisonReport(runs))
  await writeFile(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    workspace: options.workspace,
    sourceWorkspace: options.sourceWorkspace,
    variants: runs.map((run) => ({
      name: p2VariantName(run.options),
      codeGraph: run.options.qemuCodeGraph,
      report: run.paths.report,
      results: run.paths.results,
      summary: p2EvidenceSummary(run.results, run.outputText),
    })),
  }, null, 2)}\n`)

  console.log(`p2ComparisonReport=${reportPath}`)
  console.log(`p2Summary=${summaryPath}`)
}

function printRunPaths(run: UiMatrixRun) {
  console.log(`workspace=${run.options.workspace}`)
  console.log(`manifest=${run.manifestPath}`)
  console.log(`results=${run.paths.results}`)
  console.log(`report=${run.paths.report}`)
  if (run.options.qemuDirect) console.log(`fixPlan=${run.paths.fixPlan}`)
}

async function loadFixtures() {
  const dir = resolve(import.meta.dir, "..", "test", "completion-quality", "c-embedded", "fixtures")
  const files = [
    "a-basics.ts",
    "b-pointers.ts",
    "c-macros.ts",
    "d-mmio.ts",
    "e-interrupts.ts",
    "f-rtos.ts",
    "g-peripherals.ts",
    "h-protocol.ts",
    "i-memory.ts",
    "j-errors.ts",
    "k-cross-file.ts",
    "l-comments-tests.ts",
  ]
  const fixtures: CEmbeddedCompletionFixture[] = []
  for (const file of files) {
    const module = await import(`${pathToFileURL(join(dir, file)).href}?t=${Date.now()}`)
    fixtures.push(...(module.default as CEmbeddedCompletionFixture[]))
  }
  return fixtures
}

function selectFixtures(fixtures: CEmbeddedCompletionFixture[], options: UiMatrixOptions) {
  const filtered = options.fixtureFilter
    ? fixtures.filter((fixture) => fixture.id.includes(options.fixtureFilter!) || fixture.category.includes(options.fixtureFilter!))
    : fixtures
  if (options.all || options.fixtureFilter) return filtered

  const byCategory = new Map<string, CEmbeddedCompletionFixture[]>()
  for (const fixture of filtered) {
    const key = fixture.category.slice(0, 1)
    const list = byCategory.get(key) ?? []
    list.push(fixture)
    byCategory.set(key, list)
  }
  return [...byCategory.values()].flatMap((items) => items.slice(0, 3))
}

async function prepareWorkspace(fixtures: CEmbeddedCompletionFixture[], options: UiMatrixOptions): Promise<UiScenario[]> {
  await rm(options.workspace, { recursive: true, force: true })
  await mkdir(join(options.workspace, ".vscode"), { recursive: true })
  await writeFile(join(options.workspace, ".vscode", "settings.json"), `${JSON.stringify(completionUiWorkspaceSettings(options), null, 2)}\n`)

  const scenarios: UiScenario[] = []
  for (const fixture of fixtures) {
    const scenarioRoot = join(options.workspace, "scenarios", safePathSegment(fixture.id))
    for (const tab of fixture.openTabs ?? []) {
      await writeScenarioFile(join(scenarioRoot, safeRelativePath(tab.path)), tab.text)
    }
    const parsed = materializeDocument(fixture.document)
    const mainFile = join(scenarioRoot, safeRelativePath(fixture.path))
    await writeScenarioFile(mainFile, parsed.text)
    scenarios.push({
      id: fixture.id,
      category: fixture.category,
      triggerKind: fixture.triggerKind,
      mainFile,
      relativePath: safeRelativePath(fixture.path),
      openTabs: (fixture.openTabs ?? []).map((tab) => join(scenarioRoot, safeRelativePath(tab.path))),
      cursor: parsed.cursor,
    })
  }
  return scenarios
}

async function driveVsCode(scenarios: UiScenario[], options: UiMatrixOptions, results: UiResult[]) {
  const codeCli = codeCliPath(options.codeApp)
  execFileSync(codeCli, ["--new-window", options.qemuDirect ? qemuCodeWorkspacePath(options) : options.workspace], { stdio: "ignore" })
  await delay(2500)
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
  ])
  await delay(1000)
  vscodeCommand("Developer: Reload Window")
  await delay(4500)
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
  ])
  await delay(1000)
  const codeGraphIndexOutput = await ensureQemuCodeGraphIndexed(options)
  await clearChipMateOutput()
  const outputLogSnapshot = await snapshotChipMateOutputLogs()

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    const result = results[index]
    const original = await readFile(scenario.mainFile, "utf8")
    const before = scenario.mutation?.text ?? original
    if (scenario.mutation) await writeFile(scenario.mainFile, before)
    try {
      vscodeCommand("Close All Editors")
      await delay(500)
      for (const tab of scenario.openTabs ?? []) {
        execFileSync(codeCli, ["-r", tab], { stdio: "ignore" })
      }
      execFileSync(codeCli, ["-r", "--goto", `${scenario.mainFile}:${scenario.cursor.line + 1}:${scenario.cursor.character + 1}`], { stdio: "ignore" })
      await delay(500)
      await focusEditorGroup()
      await goToLineColumn(scenario.cursor, smartLineStartColumn(before, scenario.cursor.line))
      if (scenario.triggerKind === "automatic") {
        runAppleScript([
          "tell application \"Visual Studio Code\" to activate",
          "tell application \"System Events\"",
          "keystroke \" \"",
          "key code 51",
          "end tell",
        ])
      } else {
        vscodeCommand("Trigger Inline Suggestion")
      }
      await delay(options.waitMs)
      result.commitAttempted = true
      await commitInlineSuggestion()
      await delay(400)
      await saveActiveEditor()
      let after = await readFile(scenario.mainFile, "utf8")
      if (after === before) {
        await pressTabAcceptFallback()
        await delay(250)
        await saveActiveEditor()
        after = await readFile(scenario.mainFile, "utf8")
        if (after !== before) result.notes.push("commit command produced no file change; Tab fallback applied")
      }
      BEFORE_TEXT.set(result, before)
      AFTER_TEXT.set(result, after)
      result.changed = before !== after
      if (!result.changed) result.notes.push("no accepted edit observed after commit")
    } finally {
      if (scenario.mutation && options.restoreAfterEach) {
        await writeFile(scenario.mainFile, original)
        await delay(150)
        await revertActiveEditor()
      }
    }
  }

  const completionOutput = outputWithLogFallback(await copyChipMateOutput(), await readChipMateOutputLogDelta(outputLogSnapshot))
  return [codeGraphIndexOutput, completionOutput].filter(Boolean).join("\n")
}

async function ensureQemuCodeGraphIndexed(options: UiMatrixOptions) {
  if (!options.qemuDirect || options.qemuCodeGraph !== "on") return ""
  const snapshot = await snapshotChipMateOutputLogs()
  vscodeCommand("ChipMate: Rebuild Local Code Graph")
  const started = Date.now()
  let latest = ""
  while (Date.now() - started < options.qemuIndexWaitMs) {
    await delay(2000)
    latest = await readChipMateOutputLogDelta(snapshot)
    if (/\[codegraph\] indexed \d+ file\(s\), \d+ function\(s\)/.test(latest)) {
      return completionMatrixLogBlock("codegraph-index", latest)
    }
    if (/\[codegraph\] indexing failed:/.test(latest)) {
      return completionMatrixLogBlock("codegraph-index", latest)
    }
  }
  return completionMatrixLogBlock("codegraph-index", `${latest}\n[ui-matrix] codegraph index wait timed out after ${options.qemuIndexWaitMs}ms`)
}

async function clearChipMateOutput() {
  await openChipMateOutput()
  vscodeCommand("View: Clear Output")
  await delay(800)
}

async function openChipMateOutput() {
  vscodeCommand("ChipMate: Open ChipMate Output")
  await delay(500)
}

async function commitInlineSuggestion() {
  vscodeCommand("ChipMate: Commit Inline Suggestion", { dismissFirst: false })
  await delay(450)
}

async function pressTabAcceptFallback() {
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
    "tell application \"System Events\"",
    "key code 48",
    "end tell",
  ])
}

async function revertActiveEditor() {
  const menuReverted = tryAppleScript([
    "tell application \"Visual Studio Code\" to activate",
    "delay 0.2",
    "tell application \"System Events\"",
    "tell process \"Code\"",
    "click menu item \"Revert File\" of menu \"File\" of menu bar 1",
    "end tell",
    "delay 0.4",
    "key code 36",
    "end tell",
  ])
  if (!menuReverted) vscodeCommand("File: Revert File")
  await delay(900)
}

async function focusEditorGroup() {
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
    "tell application \"System Events\"",
    "key code 53",
    "delay 0.2",
    "key code 18 using command down",
    "delay 0.4",
    "end tell",
  ])
}

async function goToLineColumn(cursor: UiScenario["cursor"], startColumn: number) {
  const rightMoves = Math.max(0, Math.min(500, cursor.character - startColumn))
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
    "tell application \"System Events\"",
    "key code 123 using command down",
    ...(rightMoves > 0 ? [`repeat ${rightMoves} times`, "key code 124", "delay 0.02", "end repeat"] : []),
    "delay 0.4",
    "end tell",
  ])
}

function smartLineStartColumn(text: string, line: number) {
  const value = text.replace(/\r\n/g, "\n").split("\n")[line] ?? ""
  return /^\s*/.exec(value)?.[0]?.length ?? 0
}

async function saveActiveEditor() {
  runAppleScript([
    "tell application \"Visual Studio Code\" to activate",
    "tell application \"System Events\"",
    "keystroke \"s\" using command down",
    "end tell",
  ])
  await delay(250)
}

function vscodeCommand(command: string, options: { dismissFirst?: boolean } = {}) {
  runAppleScript([
    `set the clipboard to ${appleString(`>${command}`)}`,
    "tell application \"Visual Studio Code\" to activate",
    "delay 0.3",
    "tell application \"System Events\"",
    ...(options.dismissFirst === false ? [] : ["key code 53", "delay 0.2"]),
    "keystroke \"p\" using command down",
    "delay 0.8",
    "keystroke \"a\" using command down",
    "keystroke \"v\" using command down",
    "delay 0.5",
    "key code 36",
    "delay 0.8",
    "end tell",
  ])
}

async function copyChipMateOutput() {
  try {
    await openChipMateOutput()
    vscodeCommand("Output: Focus on Output View")
    runAppleScript([
      "tell application \"Visual Studio Code\" to activate",
      "tell application \"System Events\"",
      "delay 0.5",
      "keystroke \"a\" using command down",
      "keystroke \"c\" using command down",
      "delay 0.8",
      "end tell",
    ])
    await delay(500)
    return spawnSync("pbpaste", { encoding: "utf8" }).stdout
  } catch (error) {
    return `output-copy-failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function snapshotChipMateOutputLogs(): Promise<OutputLogSnapshot> {
  const snapshot: OutputLogSnapshot = new Map()
  for (const path of chipMateOutputLogPaths()) {
    try {
      snapshot.set(path, (await stat(path)).size)
    } catch {
      // Logs can rotate while the extension host starts; missing files are ignored.
    }
  }
  return snapshot
}

async function readChipMateOutputLogDelta(snapshot: OutputLogSnapshot) {
  const chunks: string[] = []
  for (const path of chipMateOutputLogPaths()) {
    try {
      const size = (await stat(path)).size
      const start = snapshot.get(path) ?? 0
      if (size <= start) continue
      chunks.push((await readFile(path)).subarray(start).toString("utf8"))
    } catch {
      // Best-effort fallback only; UI copy still remains available.
    }
  }
  return chunks.join("\n")
}

function chipMateOutputLogPaths() {
  const root = join(Bun.env.HOME ?? "", "Library", "Application Support", "Code", "logs")
  if (!existsSync(root)) return []
  return spawnSync("find", [root, "-name", "*ChipMate.log"], { encoding: "utf8" }).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
}

function outputWithLogFallback(copied: string, logDelta: string) {
  const hasTelemetry = (text: string) => /\[completion(?:-telemetry)?\]|\breturned source=/.test(text)
  const logCompletion = completionOutputLines(logDelta)
  const copiedCompletion = completionOutputLines(copied)
  if (hasTelemetry(logCompletion)) return logCompletion
  if (hasTelemetry(copiedCompletion)) return copiedCompletion
  return copied || logDelta
}

function completionOutputLines(output: string) {
  return output.split(/\r?\n/)
    .filter((line) => /\[completion(?:-telemetry)?\]|\breturned source=|direct completion/.test(line))
    .join("\n")
}

function completionMatrixLogBlock(label: string, text: string) {
  const trimmed = text.trim()
  return trimmed ? `[ui-matrix:${label}]\n${trimmed}\n[/ui-matrix:${label}]` : ""
}

export function applyOutputTelemetry(results: UiResult[], output: string) {
  const byRequest = new Map<string, UiResult>()
  for (const line of output.split(/\r?\n/)) {
    const requestId = /requestId=(cc-[A-Za-z0-9-]+)/.exec(line)?.[1]
    const path = /path="([^"]+)"/.exec(line)?.[1]
    if (requestId && path) {
      const normalizedPath = path.replace(/\\/g, "/")
      const result = results.find((item) =>
        normalizedPath.includes(`scenarios/${item.id}/`) ||
        normalizedPath.includes(`scenarios${sep}${item.id}${sep}`) ||
        Boolean(item.relativePath && normalizedPath.endsWith(item.relativePath.replace(/\\/g, "/"))))
      if (result) byRequest.set(requestId, result)
    }
    if (requestId && /\breturned source=/.test(line)) {
      const result = byRequest.get(requestId)
      if (result) {
        result.inlineSuggestion = true
        result.inlineReturned = true
        rememberInlineFirstLine(result, line)
      }
    }
    const telemetryMatch = /\[completion-telemetry\]\s+(\{.*\})/.exec(line)
    if (telemetryMatch) {
      try {
        const event = JSON.parse(telemetryMatch[1]) as Record<string, unknown>
        const result = byRequest.get(String(event.requestId))
        if (!result) continue
        const rejectReason = stringValue(event.rejectReason)
        if (rejectReason) addFlags(result, rejectReason)
        const accepted = event.accepted === true
        if (accepted) {
          result.inlineSuggestion = true
          rememberInlineFirstLine(result, stringValue(event.filterText))
        }
        if (accepted || shouldUseTelemetryAsPrimary(result, event)) {
          assignPrimaryTelemetry(result, event)
        }
      } catch {
        // Ignore malformed copied output lines.
      }
    }
  }
}

function assignPrimaryTelemetry(result: UiResult, event: Record<string, unknown>) {
  const planKind = stringValue(event.planKind)
  const cIntent = stringValue(event.cIntent)
  const retrievalMode = stringValue(event.retrievalMode)
  const contextLevel = stringValue(event.contextLevel)
  const promptKind = stringValue(event.promptKind)
  const modelRoute = stringValue(event.modelRoute)
  const insertMode = stringValue(event.insertMode)
  if (planKind) result.planKind = planKind
  if (cIntent) result.actualCIntent = cIntent
  if (retrievalMode) result.retrievalMode = retrievalMode
  const evidenceKinds = stringArrayValue(event.evidenceKinds)
  if (evidenceKinds.length) result.evidenceKinds = uniqueStrings([...result.evidenceKinds, ...evidenceKinds])
  const selectedEvidenceCount = selectedEvidenceCountValue(event)
  if (selectedEvidenceCount !== undefined) result.selectedEvidenceCount = Math.max(result.selectedEvidenceCount, selectedEvidenceCount)
  if (contextLevel) result.contextLevel = contextLevel
  if (promptKind) result.promptKind = promptKind
  if (event.cEmbeddedEvidenceTrace && typeof event.cEmbeddedEvidenceTrace === "object") {
    result.cEmbeddedEvidenceTrace = event.cEmbeddedEvidenceTrace as Record<string, unknown>
  }
  if (modelRoute) result.modelRoute = modelRoute
  if (insertMode) result.insertMode = insertMode
}

function shouldUseTelemetryAsPrimary(result: UiResult, event: Record<string, unknown>) {
  if (!result.planKind) return true
  const rejectReason = stringValue(event.rejectReason)
  if (rejectReason === "cancelled" || rejectReason === "remote-error") return false
  if (stringArrayValue(event.evidenceKinds).some((kind) => kind.startsWith("c-"))) return true
  if (event.cEmbeddedEvidenceTrace) return true
  return false
}

export function reconcileAcceptance(results: UiResult[]) {
  for (const result of results) {
    const appliedInlineText = inlineTextWasApplied(result)
    result.textApplied = appliedInlineText
    result.acceptedAndApplied = result.commitAttempted && result.inlineSuggestion && appliedInlineText
    if (result.changed && !result.inlineSuggestion) {
      result.notes.push("file changed without accepted inline telemetry")
    }
    if (result.inlineSuggestion && result.commitAttempted && !appliedInlineText) {
      result.notes.push("inline returned and commit attempted but returned text was not applied")
    }
  }
}

function rememberInlineFirstLine(result: UiResult, input: string | undefined) {
  if (!input) return
  const text = /firstLine="([^"]*)"/.exec(input)?.[1] ?? input
  const firstLine = text.replace(/\\"/g, "\"").replace(/\\n/g, "\n").split(/\r?\n/)[0]?.trim()
  if (!firstLine || result.inlineFirstLines.includes(firstLine)) return
  result.inlineFirstLines.push(firstLine)
}

function inlineTextWasApplied(result: UiResult) {
  const before = BEFORE_TEXT.get(result)
  const after = AFTER_TEXT.get(result)
  if (before === undefined || after === undefined) return result.changed && result.inlineSuggestion
  return result.inlineFirstLines.some((line) =>
    line.length > 0 && occurrenceCount(after, line) > occurrenceCount(before, line))
}

function occurrenceCount(text: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

function addFlags(result: UiResult, rejectReason: string) {
  result.qualityRejected ||= rejectReason.startsWith("quality:")
  result.flags.disabledPlan ||= rejectReason.includes("disabled-plan")
  result.flags.badEditContract ||= /selectedCompletionInfo|range|contract|bad edit contract/.test(rejectReason)
  result.flags.parseError ||= rejectReason.includes("C parse/compile")
  result.flags.unsafeC ||= /dangerous C|unsafe buffer|ISR blocking|busy loop|missing volatile|unaligned/.test(rejectReason)
  result.flags.hallucinatedAPI ||= rejectReason.includes("hallucinated API")
  result.flags.placeholder ||= rejectReason.includes("placeholder")
}

function renderReport(results: UiResult[], options: UiMatrixOptions, output = "") {
  const total = results.length
  const p2Summary = p2EvidenceSummary(results, output)
  const changed = results.filter((result) => result.changed).length
  const accepted = results.filter((result) => result.acceptedAndApplied).length
  const inlineReturned = results.filter((result) => result.inlineReturned).length
  const commitAttempted = results.filter((result) => result.commitAttempted).length
  const textApplied = results.filter((result) => result.textApplied).length
  const qualityRejected = results.filter((result) => result.qualityRejected).length
  const categoryLines = [...categoryStats(results).entries()].map(([category, items]) => {
    const returned = items.filter((result) => result.inlineReturned).length
    const applied = items.filter((result) => result.acceptedAndApplied).length
    return `| ${category.replace(/\|/g, "/")} | ${items.length} | ${returned} | ${applied} | ${items.filter((result) => result.qualityRejected).length} |`
  })
  const failureRows = results.filter((result) => !result.acceptedAndApplied || result.qualityRejected).map((result) => [
    result.id,
    result.category.replace(/\|/g, "/"),
    result.relativePath ?? result.path,
    `${result.cursor.line + 1}:${result.cursor.character + 1}`,
    result.triggerKind,
    String(result.inlineReturned),
    result.planKind ?? "",
    result.actualCIntent ?? "",
    result.retrievalMode ?? "",
    result.evidenceKinds.join(", "),
    result.modelRoute ?? "",
    result.notes.join("; ").replace(/\|/g, "/"),
  ].join(" | "))
  const lines = [
    options.qemuDirect ? "# QEMU C/Embedded UI Matrix Report" : "# C/Embedded UI Matrix Report",
    "",
    `workspace: ${options.workspace}`,
    options.qemuDirect ? `source workspace: ${options.sourceWorkspace}` : "",
    options.qemuDirect ? `transient code-workspace: ${qemuCodeWorkspacePath(options)}` : "",
    options.qemuDirect ? `transient qemu settings: codeGraph.enabled=${options.qemuCodeGraph === "on"}, rag.embedding.resumeAutomatically=false; completion endpoint/model/profile inherited` : "",
    `mode: ${options.qemuDirect ? "qemu-direct" : options.all ? "all" : "sample"}`,
    options.qemuDirect ? `qemuCodeGraph: ${options.qemuCodeGraph}` : "",
    options.qemuDirect && options.qemuCodeGraph === "on" ? `qemuCodeGraphIndex: maxFiles=${options.qemuIndexMaxFiles}, waitMs=${options.qemuIndexWaitMs}, indexed=${countPattern(output, "[codegraph] indexed ")}` : "",
    `provider: openai-compatible`,
    `direct config source: ${directConfigSource(options)}`,
    `workspace overrides: ${workspaceOverrideLabels(options).join(", ") || "none"}`,
    "",
    "## Summary",
    "",
    `- scenarios: ${total}`,
    `- inline returned: ${inlineReturned}`,
    `- commit attempted: ${commitAttempted}`,
    `- text applied: ${textApplied}`,
    `- accepted/applied: ${accepted}`,
    `- file changed: ${changed}`,
    `- quality-rejected: ${qualityRejected}`,
    `- disabled-plan: ${results.filter((result) => result.flags.disabledPlan).length}`,
    `- direct config missing: ${countPattern(output, "direct completion API base URL") + countPattern(output, "direct completion model is not configured")}`,
    `- cache revalidated: ${countPattern(output, "returned source=cache revalidated=true")}`,
    `- output bytes: ${output.length}`,
    `- p2 c-* evidence scenarios: ${p2Summary.p2EvidenceScenarios}`,
    `- p2 c-* evidence rows: ${p2Summary.p2EvidenceRows}`,
    `- p2 selected evidence avg: ${p2Summary.selectedEvidenceCountAvg.toFixed(2)}`,
    `- p2 minimum useful met: ${p2Summary.minimumUsefulEvidenceMet}`,
    `- p2 evidence kinds: ${p2Summary.p2EvidenceKinds.join(", ") || "none"}`,
    "",
    "## Category Summary",
    "",
    "| category | scenarios | inline returned | accepted/applied | quality-rejected |",
    "|---|---:|---:|---:|---:|",
    ...categoryLines,
    "",
    "## Failure Scenarios",
    "",
    "| fixture | category | path | cursor | trigger | inline returned | planKind | cIntent | retrieval | evidenceKinds | modelRoute | notes |",
    "|---|---|---|---:|---|---:|---|---|---|---|---|---|",
    ...(failureRows.length ? failureRows.map((row) => `| ${row} |`) : ["| none |  |  |  |  |  |  |  |  |  |  |  |"]),
    "",
    "## Scenarios",
    "",
    "| fixture | category | path | trigger | inline | commit | applied | accepted | changed | planKind | cIntent | retrieval | evidenceCount | evidenceKinds | context | prompt | modelRoute | insertMode | notes |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---|---|---|---|---|---|",
    ...results.map((result) => [
      result.id,
      result.category.replace(/\|/g, "/"),
      result.relativePath ?? result.path,
      result.triggerKind,
      String(result.inlineReturned || result.inlineSuggestion),
      String(result.commitAttempted),
      String(result.textApplied),
      String(result.acceptedAndApplied),
      String(result.changed),
      result.planKind ?? "",
      result.actualCIntent ?? "",
      result.retrievalMode ?? "",
      String(result.selectedEvidenceCount),
      result.evidenceKinds.join(", "),
      result.contextLevel ?? "",
      result.promptKind ?? "",
      result.modelRoute ?? "",
      result.insertMode ?? "",
      result.notes.join("; ").replace(/\|/g, "/"),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Representative Logs",
    "",
    ...representativeLogs(output),
    "",
  ].filter((line) => line !== "")
  return `${lines.join("\n")}\n`
}

function renderQemuFixPlan(results: UiResult[], options: UiMatrixOptions, output: string) {
  const triggered = countPattern(output, "[completion] triggered")
  const returned = countPattern(output, "returned source=remote") + countPattern(output, "returned source=cache revalidated=true")
  const directMissing = countPattern(output, "direct completion API base URL") + countPattern(output, "direct completion model is not configured")
  const fallbackAccepted = results.filter((result) => result.notes.some((note) => note.includes("Tab fallback applied")))
  const returnedNotApplied = results.filter((result) => result.inlineReturned && !result.acceptedAndApplied)
  const noInlineByCategory = [...categoryStats(results).entries()]
    .map(([category, items]) => ({ category, count: items.filter((result) => !result.inlineReturned).length, total: items.length }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
  const quality = results.filter((result) => result.qualityRejected || Object.values(result.flags).some(Boolean))
  const lines = [
    "# QEMU Completion Fix Plan",
    "",
    `source workspace: ${options.sourceWorkspace}`,
    `report workspace: ${options.workspace}`,
    "",
    "## Observed Metrics",
    "",
    `- scenarios: ${results.length}`,
    `- triggered: ${triggered}`,
    `- returned: ${returned}`,
    `- accepted/applied: ${results.filter((result) => result.acceptedAndApplied).length}`,
    `- direct config missing: ${directMissing}`,
    `- quality-rejected: ${results.filter((result) => result.qualityRejected).length}`,
    "",
    "## Prioritized Fixes",
    "",
    ...(triggered === 0 || returned === 0 || output.length < 200
      ? [
        "### P0 - UI trigger or Output copy is invalid",
        "",
        `Evidence: triggered=${triggered}, returned=${returned}, outputBytes=${output.length}.`,
        "Fix direction: stabilize command-palette invocation, Output channel selection, and clipboard copy before trusting any quality result.",
        "Regression: run a 1-scenario qemu smoke and assert non-empty completion lifecycle logs.",
        "",
      ]
      : []),
    ...(directMissing > 0
      ? [
        "### P0 - Direct completion configuration missing",
        "",
        `Evidence: direct config missing markers=${directMissing}.`,
        "Fix direction: verify VS Code User settings inheritance for qemu direct workspaces and fail before running matrix when direct model settings are absent.",
        "Regression: qemu smoke must show provider/model in [completion] triggered logs and zero config-missing markers.",
        "",
      ]
      : []),
    ...(fallbackAccepted.length
      ? [
        "### P1 - Commit command does not accept inline suggestions reliably",
        "",
        `Evidence: ${fallbackAccepted.length} scenario(s) needed Tab fallback. Examples: ${sampleIds(fallbackAccepted)}.`,
        "Fix direction: inspect ChipMate: Commit Inline Suggestion command focus handling and VS Code inline suggestion acceptance API use; prefer direct editor command execution over keyboard focus assumptions.",
        "Regression: UI script should record accepted edits without Tab fallback for A/QEMU smoke scenarios.",
        "",
      ]
      : []),
    ...(returnedNotApplied.length
      ? [
        "### P1 - Inline returned but returned text was not applied",
        "",
        `Evidence: ${returnedNotApplied.length} scenario(s). Examples: ${sampleIds(returnedNotApplied)}.`,
        "Fix direction: compare returned firstLine/filterText with final file diff, then tighten range/selectedCompletionInfo adaptation for qemu multiline, macro, and partial-token contexts.",
        "Regression: add focused fixtures from the listed qemu files and assert inlineTextWasApplied.",
        "",
      ]
      : []),
    ...(noInlineByCategory.length
      ? [
        "### P1 - High-frequency no-inline categories",
        "",
        ...noInlineByCategory.slice(0, 6).map((item) => `- ${item.category}: ${item.count}/${item.total} without inline return`),
        "Fix direction: inspect planning skip reasons and context packing for the top categories; add category-specific qemu fixtures for repeatable local tests.",
        "Regression: qemu direct sample should reduce no-inline count in these categories.",
        "",
      ]
      : []),
    ...(quality.length
      ? [
        "### P2 - QEMU-specific quality gates and context issues",
        "",
        `Evidence: ${quality.length} flagged scenario(s). Examples: ${sampleIds(quality)}.`,
        "Fix direction: split failures by flags (parseError, placeholder, disabledPlan, unsafeC, hallucinatedAPI) and add targeted C/QEMU fixture cases before tuning postprocess or context selection.",
        "Regression: unit fixtures should cover the flagged qemu path patterns.",
        "",
      ]
      : []),
    "## Representative Failure Rows",
    "",
    "| fixture | category | path | notes |",
    "|---|---|---|---|",
    ...results
      .filter((result) => !result.acceptedAndApplied || result.qualityRejected)
      .slice(0, 24)
      .map((result) => `| ${result.id} | ${result.category.replace(/\|/g, "/")} | ${result.relativePath ?? result.path} | ${result.notes.join("; ").replace(/\|/g, "/")} |`),
    "",
  ]
  return `${lines.join("\n")}\n`
}

function renderQemuP2ComparisonReport(runs: UiMatrixRun[]) {
  const p2Run = runs.find((run) => run.options.qemuCodeGraph === "on")
  const p2Summary = p2Run ? p2EvidenceSummary(p2Run.results, p2Run.outputText) : undefined
  const p2Indexed = p2Run ? countPattern(p2Run.outputText, "[codegraph] indexed ") : 0
  const lines = [
    "# QEMU P2 UI Evidence Matrix Report",
    "",
    `generatedAt: ${new Date().toISOString()}`,
    `source workspace: ${runs[0]?.options.sourceWorkspace ?? ""}`,
    `matrix workspace: ${runs[0] ? dirname(runs[0].options.workspace) : ""}`,
    "",
    "## Variant Summary",
    "",
    "| variant | codeGraph | scenarios | inline returned | accepted/applied | c-* evidence scenarios | c-* evidence rows | selected evidence avg | minimum useful met | evidence kinds | report |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ...runs.map((run) => {
      const summary = p2EvidenceSummary(run.results, run.outputText)
      return [
        p2VariantName(run.options),
        run.options.qemuCodeGraph,
        String(run.results.length),
        String(run.results.filter((result) => result.inlineReturned).length),
        String(run.results.filter((result) => result.acceptedAndApplied).length),
        String(summary.p2EvidenceScenarios),
        String(summary.p2EvidenceRows),
        summary.selectedEvidenceCountAvg.toFixed(2),
        String(summary.minimumUsefulEvidenceMet),
        summary.p2EvidenceKinds.join(", ") || "none",
        run.paths.report,
      ].join(" | ")
    }).map((row) => `| ${row} |`),
    "",
    "## P2 UI Effect Interpretation",
    "",
    ...p2EffectInterpretation(p2Summary, p2Indexed),
    "",
    "## P2 Evidence By Scenario",
    "",
    "| variant | fixture | category | path | planKind | cIntent | retrieval | evidenceCount | evidenceKinds | minimumUseful |",
    "|---|---|---|---|---|---|---|---:|---|---:|",
    ...runs.flatMap((run) => run.results.map((result) => [
      p2VariantName(run.options),
      result.id,
      result.category.replace(/\|/g, "/"),
      result.relativePath ?? result.path,
      result.planKind ?? "",
      result.actualCIntent ?? "",
      result.retrievalMode ?? "",
      String(result.selectedEvidenceCount),
      result.evidenceKinds.join(", ") || "none",
      String(Boolean(result.cEmbeddedEvidenceTrace?.minimumUsefulEvidenceMet)),
    ].join(" | "))).map((row) => `| ${row} |`),
    "",
    "## Acceptance Notes",
    "",
    "- This matrix is valid for P2 only when the `p2-codegraph-on` variant shows one or more `c-*` evidence kinds.",
    "- `baseline-codegraph-off` is expected to show prefix/suffix/open-tab evidence only.",
    "- Qwen output quality should be interpreted separately from acceptance-command stability; the P2 signal here is whether intent evidence reaches the final UI completion path.",
    "",
  ]
  return `${lines.join("\n")}\n`
}

function p2EffectInterpretation(summary: ReturnType<typeof p2EvidenceSummary> | undefined, indexedCount: number) {
  if (!summary) {
    return ["- No `p2-codegraph-on` variant was found, so this run cannot verify the P2 UI path."]
  }
  if (indexedCount > 0 && summary.p2EvidenceRows === 0) {
    return [
      "- Code graph indexing completed, but no `c-*` P2 evidence reached completion telemetry or the final UI prompt path.",
      "- Treat this as a failed P2 UI-effect observation, not as a model-quality result. Next debugging target: verify intent evidence builder invocation and whether selected analysis evidence is packed into the Qwen FIM prompt.",
    ]
  }
  if (summary.p2EvidenceRows > 0) {
    return [
      "- `c-*` P2 evidence reached the UI completion path. Inspect per-scenario rows below to confirm whether the evidence is intent-appropriate and useful.",
    ]
  }
  return [
    "- No codegraph indexing marker was observed and no `c-*` P2 evidence reached the UI path. Re-run with codegraph enabled/indexed before judging P2 evidence quality.",
  ]
}

function p2EvidenceSummary(results: UiResult[], output: string) {
  const telemetry = completionTelemetryEvents(output)
  const evidenceKinds = uniqueStrings([
    ...results.flatMap((result) => result.evidenceKinds),
    ...telemetry.flatMap((event) => stringArrayValue(event.evidenceKinds)),
  ])
  const p2EvidenceKinds = evidenceKinds.filter((kind) => kind.startsWith("c-")).sort()
  const selectedCounts = results.map((result) => result.selectedEvidenceCount).filter((count) => count > 0)
  const traceRows = telemetry.filter((event) => event.cEmbeddedEvidenceTrace)
  return {
    p2EvidenceKinds,
    p2EvidenceScenarios: results.filter((result) => result.evidenceKinds.some((kind) => kind.startsWith("c-"))).length,
    p2EvidenceRows: telemetry.filter((event) => stringArrayValue(event.evidenceKinds).some((kind) => kind.startsWith("c-"))).length,
    selectedEvidenceCountAvg: selectedCounts.length ? selectedCounts.reduce((sum, count) => sum + count, 0) / selectedCounts.length : 0,
    minimumUsefulEvidenceMet: traceRows.filter((event) => Boolean((event.cEmbeddedEvidenceTrace as Record<string, unknown> | undefined)?.minimumUsefulEvidenceMet)).length,
  }
}

function completionTelemetryEvents(output: string) {
  const events: Array<Record<string, unknown>> = []
  for (const line of output.split(/\r?\n/)) {
    const telemetryMatch = /\[completion-telemetry\]\s+(\{.*\})/.exec(line)
    if (!telemetryMatch) continue
    try {
      events.push(JSON.parse(telemetryMatch[1]) as Record<string, unknown>)
    } catch {
      // Ignore malformed telemetry in copied output.
    }
  }
  return events
}

function p2VariantName(options: UiMatrixOptions) {
  return basename(options.workspace)
}

function categoryStats(results: UiResult[]) {
  return results.reduce((stats, result) => {
    stats.set(result.category, [...(stats.get(result.category) ?? []), result])
    return stats
  }, new Map<string, UiResult[]>())
}

function countPattern(input: string, pattern: string) {
  if (!input || !pattern) return 0
  return input.split(pattern).length - 1
}

function representativeLogs(output: string) {
  const lines = output.split(/\r?\n/)
  const interesting = [
    ...lines.filter((line) => /\[completion\] triggered/.test(line)).slice(0, 2),
    ...lines.filter((line) => /returned source=/.test(line)).slice(0, 3),
    ...lines.filter((line) => /rejectReason|quality:|disabled-plan|direct completion/.test(line)).slice(0, 4),
  ]
  if (!interesting.length) return ["No representative completion logs were copied."]
  return interesting.map((line) => `- \`${line.replace(/`/g, "'").slice(0, 260)}\``)
}

function sampleIds(results: UiResult[]) {
  return results.slice(0, 6).map((result) => `${result.id} (${result.relativePath ?? result.path})`).join(", ")
}

function emptyResult(scenario: UiScenario): UiResult {
  return {
    id: scenario.id,
    category: scenario.category,
    path: scenario.mainFile,
    relativePath: scenario.relativePath,
    cursor: scenario.cursor,
    triggerKind: scenario.triggerKind,
    inlineSuggestion: false,
    inlineReturned: false,
    commitAttempted: false,
    textApplied: false,
    acceptedAndApplied: false,
    changed: false,
    evidenceKinds: [],
    selectedEvidenceCount: 0,
    inlineFirstLines: [],
    qualityRejected: false,
    flags: {
      disabledPlan: false,
      badEditContract: false,
      parseError: false,
      unsafeC: false,
      hallucinatedAPI: false,
      placeholder: false,
    },
    notes: [],
  }
}

function materializeDocument(document: string) {
  const offset = document.indexOf(CURSOR)
  if (offset < 0) throw new Error("Fixture is missing cursor marker.")
  const before = document.slice(0, offset)
  const lines = before.replace(/\r\n/g, "\n").split("\n")
  return {
    text: document.replace(CURSOR, ""),
    cursor: {
      line: lines.length - 1,
      character: lines.at(-1)?.length ?? 0,
    },
  }
}

async function writeScenarioFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

type QemuFileEntry = {
  path: string
  absolutePath: string
  text: string
}

type QemuCategory = {
  key: string
  category: string
  triggerKind: CEmbeddedCompletionFixture["triggerKind"]
  pathPattern?: RegExp
  match: RegExp
  fallback?: RegExp
  prompt: (indent: string, file: QemuFileEntry) => string
}

const QEMU_CATEGORIES: QemuCategory[] = [
  {
    key: "local-control-flow",
    category: "QEMU local/control-flow",
    triggerKind: "automatic",
    match: /^\s*return\s+[^;]+;/m,
    fallback: /\b(if|for|while|switch)\s*\(/,
    prompt: (indent) => `${indent}return ${CURSOR}`,
  },
  {
    key: "pointer-struct",
    category: "QEMU pointer/struct",
    triggerKind: "automatic",
    match: /->|typedef struct|struct [A-Za-z_][A-Za-z0-9_]*\s*\{/,
    prompt: (indent) => `${indent}if (${CURSOR} == NULL) {`,
  },
  {
    key: "macro-preprocessor",
    category: "QEMU macro/preprocessor",
    triggerKind: "automatic",
    match: /^#\s*(define|if|ifdef|ifndef|elif)\b/m,
    prompt: () => `#if defined(${CURSOR})`,
  },
  {
    key: "qom-device-model",
    category: "QEMU QOM/device model",
    triggerKind: "automatic",
    pathPattern: /^(hw|qom|include\/hw)\//,
    match: /OBJECT_DEFINE|TYPE_|DeviceState|ObjectClass|DEVICE_CLASS|object_class/,
    fallback: /Object|Device/,
    prompt: (indent) => `${indent}object_class_property_add(${CURSOR}`,
  },
  {
    key: "memoryregion-mmio",
    category: "QEMU MemoryRegion/MMIO",
    triggerKind: "automatic",
    pathPattern: /^(hw|system|include)\//,
    match: /MemoryRegion|memory_region_|MemoryRegionOps|hwaddr/,
    fallback: /address_space|mmio|readl|writel/i,
    prompt: (indent) => `${indent}memory_region_init_io(${CURSOR}`,
  },
  {
    key: "block-aio-job",
    category: "QEMU block/aio/job",
    triggerKind: "manual",
    pathPattern: /^(block|include\/block|migration)\//,
    match: /BlockDriver|BlockDriverState|Aio|Coroutine|Job|aio_|coroutine/,
    fallback: /blk_|bdrv_|job_/,
    prompt: (indent) => `${indent}return ${CURSOR};`,
  },
  {
    key: "error-goto-cleanup",
    category: "QEMU Error/goto cleanup",
    triggerKind: "automatic",
    match: /Error \*\*errp|error_setg|goto |return -[A-Z0-9_]+/,
    prompt: (indent) => `${indent}goto ${CURSOR};`,
  },
  {
    key: "qapi-protocol",
    category: "QEMU QAPI/protocol parsing",
    triggerKind: "manual",
    pathPattern: /^(qapi|qobject|monitor|migration|net|block)\//,
    match: /qapi_|Visitor|QDict|QList|QemuOpts|QEMUOptionParameter|json|qobject/i,
    fallback: /QAPI|QMP|Visitor|QDict/,
    prompt: (indent) => `${indent}qapi_free_${CURSOR}`,
  },
  {
    key: "memory-safety",
    category: "QEMU memory safety",
    triggerKind: "automatic",
    match: /memcpy|memset|snprintf|ARRAY_SIZE|sizeof|g_autofree|g_malloc|g_new/,
    prompt: (indent) => `${indent}memcpy(${CURSOR}`,
  },
  {
    key: "qtest-unit-tests",
    category: "QEMU qtest/unit tests",
    triggerKind: "manual",
    pathPattern: /^tests\//,
    match: /g_assert|qtest_|qtest|g_test|qmp/,
    fallback: /assert|test/i,
    prompt: (indent) => `${indent}g_assert_cmpint(${CURSOR}`,
  },
  {
    key: "cross-file-source-header",
    category: "QEMU cross-file source/header",
    triggerKind: "automatic",
    match: /^#include\s+"[^"]+"/m,
    prompt: (indent) => `${indent}return ${CURSOR};`,
  },
  {
    key: "comment-natural-command",
    category: "QEMU comment/natural command",
    triggerKind: "manual",
    match: /\b(static\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{/,
    fallback: /^\s*\{\s*$/,
    prompt: (indent, file) => `${indent}/* Add QEMU-style error cleanup for ${basename(file.path)}. */\n${indent}${CURSOR}`,
  },
]

async function prepareQemuScenarios(options: UiMatrixOptions) {
  const sourceWorkspace = requireCleanQemuWorkspace(options.sourceWorkspace)
  await rm(options.workspace, { recursive: true, force: true })
  await mkdir(options.workspace, { recursive: true })
  await writeQemuCodeWorkspace(options, sourceWorkspace)
  const files = await qemuFileEntries(sourceWorkspace)
  const selected = filterQemuScenarios(
    options.qemuP2Matrix
      ? selectQemuP2Scenarios(files, Math.max(options.scenarioLimit || 12, 12))
      : selectQemuScenarios(files, Math.max(options.scenarioLimit || 72, 72)),
    options.fixtureFilter,
  ).slice(0, options.scenarioLimit || (options.qemuP2Matrix ? 12 : 72))
  return selected.map((scenario) => ({
    ...scenario,
    openTabs: qemuOpenTabs(sourceWorkspace, scenario.relativePath, files),
  }))
}

async function writeQemuCodeWorkspace(options: UiMatrixOptions, sourceWorkspace: string) {
  const codeGraphEnabled = options.qemuCodeGraph === "on"
  const codeGraphSettings = codeGraphEnabled
    ? {
      "chipmate.codeGraph.maxFiles": options.qemuIndexMaxFiles,
      "chipmate.codeGraph.workerConcurrency": 8,
      "chipmate.codeGraph.queryCacheSize": 200,
    }
    : {}
  await writeFile(qemuCodeWorkspacePath(options), `${JSON.stringify({
    folders: [{ path: sourceWorkspace }],
    settings: {
      "chipmate.completion.enabled": true,
      "chipmate.completion.logLevel": "debug",
      "chipmate.completion.debounceMs": 0,
      "chipmate.codeGraph.enabled": codeGraphEnabled,
      "chipmate.codeGraph.promptOnWorkspaceOpen": false,
      ...codeGraphSettings,
      "chipmate.rag.embedding.resumeAutomatically": false,
      "editor.inlineSuggest.enabled": true,
      "editor.tabCompletion": "off",
      "editor.acceptSuggestionOnEnter": "off",
      "files.autoSave": "off",
      "files.saveConflictResolution": "overwriteFileOnDisk",
    },
  }, null, 2)}\n`)
}

function qemuCodeWorkspacePath(options: Pick<UiMatrixOptions, "workspace">) {
  return join(options.workspace, "qemu-direct.code-workspace")
}

function filterQemuScenarios(scenarios: UiScenario[], filter: string | undefined) {
  if (!filter) return scenarios
  const needle = filter.toLowerCase()
  return scenarios.filter((scenario) =>
    [
      scenario.id,
      scenario.category,
      scenario.relativePath,
      scenario.mainFile,
    ].some((value) => value?.toLowerCase().includes(needle)))
}

export function selectQemuScenarios(files: QemuFileEntry[], limit: number) {
  const perCategory = Math.max(1, Math.floor((limit || 72) / QEMU_CATEGORIES.length))
  const used = new Set<string>()
  return QEMU_CATEGORIES.flatMap((category) => {
    const primary = files.filter((file) => !used.has(file.path) && qemuCategoryMatches(category, file, false))
    const fallback = files.filter((file) => !used.has(file.path) && qemuCategoryMatches(category, file, true))
    return [...primary, ...fallback].slice(0, perCategory).flatMap((file, index) => {
      const mutation = qemuMutation(file, category)
      if (!mutation) return []
      used.add(file.path)
      return [{
        id: `Q${String(QEMU_CATEGORIES.indexOf(category) + 1).padStart(2, "0")}-${category.key}-${index + 1}`,
        category: category.category,
        triggerKind: category.triggerKind,
        mainFile: file.absolutePath,
        relativePath: file.path,
        coverageFallback: !primary.includes(file),
        mutation: {
          text: mutation.text,
          insertedText: mutation.insertedText,
        },
        cursor: mutation.cursor,
      } satisfies UiScenario]
    })
  }).slice(0, limit || 72)
}

type QemuCursorMutation = NonNullable<UiScenario["mutation"]> & {
  cursor: UiScenario["cursor"]
}

type QemuP2Category = {
  key: string
  category: string
  triggerKind: CEmbeddedCompletionFixture["triggerKind"]
  build: (file: QemuFileEntry) => QemuCursorMutation | undefined
}

const QEMU_P2_CATEGORIES: QemuP2Category[] = [
  {
    key: "member-access",
    category: "QEMU P2 member-access",
    triggerKind: "automatic",
    build: qemuP2MemberAccessMutation,
  },
  {
    key: "call-args",
    category: "QEMU P2 call-args",
    triggerKind: "automatic",
    build: qemuP2CallArgsMutation,
  },
  {
    key: "initializer",
    category: "QEMU P2 initializer",
    triggerKind: "automatic",
    build: qemuP2InitializerMutation,
  },
  {
    key: "error-path",
    category: "QEMU P2 error-path",
    triggerKind: "automatic",
    build: qemuP2ErrorPathMutation,
  },
  {
    key: "state-machine",
    category: "QEMU P2 state-machine",
    triggerKind: "automatic",
    build: qemuP2StateMachineMutation,
  },
  {
    key: "mmio-register",
    category: "QEMU P2 mmio-register",
    triggerKind: "automatic",
    build: qemuP2MmioRegisterMutation,
  },
]

export function selectQemuP2Scenarios(files: QemuFileEntry[], limit: number) {
  const perCategory = Math.max(1, Math.ceil((limit || 12) / QEMU_P2_CATEGORIES.length))
  const used = new Set<string>()
  const scenarios: UiScenario[] = []
  for (const category of QEMU_P2_CATEGORIES) {
    let picked = 0
    for (const file of files) {
      if (picked >= perCategory) break
      if (used.has(file.path)) continue
      const mutation = category.build(file)
      if (!mutation) continue
      used.add(file.path)
      picked += 1
      scenarios.push({
        id: `P2-${category.key}-${picked}`,
        category: category.category,
        triggerKind: category.triggerKind,
        mainFile: file.absolutePath,
        relativePath: file.path,
        mutation: {
          text: mutation.text,
          insertedText: mutation.insertedText,
        },
        cursor: mutation.cursor,
      })
    }
  }
  return scenarios.slice(0, limit || 12)
}

function requireCleanQemuWorkspace(sourceWorkspace: string) {
  const root = execFileSync("git", ["-C", sourceWorkspace, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  const dirtyTracked = [
    spawnSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" }).stdout.trim(),
    spawnSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.trim(),
  ].filter(Boolean).join("\n")
  if (dirtyTracked) {
    throw new Error(`QEMU workspace has tracked changes; refusing to run direct UI test:\n${dirtyTracked}`)
  }
  return root
}

async function qemuFileEntries(sourceWorkspace: string) {
  const tracked = execFileSync("git", ["-C", sourceWorkspace, "ls-files", "*.c", "*.h"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => qemuPathAllowed(path))
    .sort()
  const entries: QemuFileEntry[] = []
  for (const path of tracked) {
    const absolutePath = join(sourceWorkspace, path)
    if ((await stat(absolutePath)).size > 256 * 1024) continue
    entries.push({ path, absolutePath, text: await readFile(absolutePath, "utf8") })
  }
  return entries
}

function qemuPathAllowed(path: string) {
  if (/^(subprojects|linux-headers|pc-bios|roms)\//.test(path)) return false
  return /^(hw|include|tests|target|block|migration|net|util|io|qom|monitor|backends|qapi|qobject|chardev|system|tcg)\//.test(path)
}

function qemuCategoryMatches(category: QemuCategory, file: QemuFileEntry, allowFallback: boolean) {
  if (category.pathPattern && !category.pathPattern.test(file.path)) return false
  if (category.match.test(file.text)) return true
  return allowFallback && Boolean(category.fallback?.test(file.text))
}

function qemuMutation(file: QemuFileEntry, category: QemuCategory) {
  const lines = file.text.replace(/\r\n/g, "\n").split("\n")
  if (category.key === "local-control-flow") {
    const anchor = lines.findIndex((line) => /^\s*return\s+[^;]+;/.test(line))
    const match = anchor >= 0 ? /^(\s*return\s+)([^;]+)(;.*)$/.exec(lines[anchor]) : undefined
    if (match) {
      lines[anchor] = `${match[1]}${match[3]}`
      return {
        text: lines.join("\n"),
        insertedText: `${match[1]}${CURSOR}${match[3]}`,
        cursor: {
          line: anchor,
          character: match[1].length,
        },
      }
    }
  }
  const anchor = lines.findIndex((line) => category.match.test(line) || Boolean(category.fallback?.test(line)))
  if (anchor < 0) return
  const indent = /^#/.test(lines[anchor]) ? "" : /^\s*/.exec(lines[anchor])?.[0] ?? ""
  const insertedText = `${category.prompt(indent, file)}\n`
  const before = lines.slice(0, anchor + 1).join("\n")
  const after = lines.slice(anchor + 1).join("\n")
  const text = `${before}\n${insertedText.replace(CURSOR, "")}${after}`
  const cursorPrefix = `${before}\n${insertedText.slice(0, insertedText.indexOf(CURSOR))}`
  const cursorLines = cursorPrefix.split("\n")
  return {
    text,
    insertedText,
    cursor: {
      line: cursorLines.length - 1,
      character: cursorLines.at(-1)?.length ?? 0,
    },
  }
}

function qemuP2MemberAccessMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  if (!file.path.endsWith(".c")) return
  const lines = fileLines(file)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = /^(\s*)(?:const\s+)?(?:struct\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|,)/.exec(line)
    const variable = match?.[2]
    if (!match || !variable || /^(?:const|void|static|return)$/.test(variable)) continue
    return insertCursorLineMutation(lines, index + 1, `${match[1]}if (${variable}->${CURSOR}) {`)
  }
}

function qemuP2CallArgsMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  if (!file.path.endsWith(".c")) return
  const lines = fileLines(file)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = /^(\s*)(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*;/.exec(line)
    const callee = match?.[2]
    if (!match || !callee || /^(?:if|for|while|switch|return|sizeof)$/.test(callee)) continue
    if (/^[A-Z0-9_]+$/.test(callee)) continue
    return insertCursorLineMutation(lines, index + 1, `${match[1]}${callee}(${CURSOR});`)
  }
}

function qemuP2InitializerMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  const lines = fileLines(file)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = /^(\s*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (!match) continue
    return replaceCursorLineMutation(lines, index, `${match[1]}.${match[2]} = ${CURSOR},`)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = /^(\s*)(?:static\s+)?(?:const\s+)?(?:struct\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*\s+[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\s*=\s*\{\s*$/.exec(line)
    if (!match) continue
    return insertCursorLineMutation(lines, index + 1, `${match[1]}    .ops = ${CURSOR},`)
  }
}

function qemuP2ErrorPathMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  if (!file.path.endsWith(".c")) return
  const lines = fileLines(file)
  const labels = new Set(lines.flatMap((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(?:\/\/.*)?$/.exec(line)
    return match?.[1] ? [match[1]] : []
  }))
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = /^(\s*)goto\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(line)
    if (!match || (labels.size && !labels.has(match[2]))) continue
    return replaceCursorLineMutation(lines, index, `${match[1]}goto ${CURSOR};`)
  }
}

function qemuP2StateMachineMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  const lines = fileLines(file)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!/\b(?:state|status|mode|phase)\b|(?:_STATE_|_STATUS_|_MODE_|_PHASE_|RUN_STATE_)/i.test(line)) continue
    const indent = /^\s*/.exec(line)?.[0] ?? ""
    return insertCursorLineMutation(lines, index + 1, `${indent}state = ${CURSOR};`)
  }
}

function qemuP2MmioRegisterMutation(file: QemuFileEntry): QemuCursorMutation | undefined {
  const lines = fileLines(file)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!/\b(?:FIELD_PREP|FIELD_GET|GENMASK|BIT|readl|writel|ioread(?:8|16|32|64)?|iowrite(?:8|16|32|64)?)\b|(?:_REG|_MASK|_SHIFT|_BIT|_STATUS|_CTRL)\b/.test(line)) continue
    const indent = /^#/.test(line) ? "" : /^\s*/.exec(line)?.[0] ?? ""
    return insertCursorLineMutation(lines, index + 1, `${indent}FIELD_PREP(${CURSOR});`)
  }
}

function fileLines(file: QemuFileEntry) {
  return file.text.replace(/\r\n/g, "\n").split("\n")
}

function insertCursorLineMutation(lines: string[], index: number, lineWithCursor: string): QemuCursorMutation {
  return cursorLinesMutation([
    ...lines.slice(0, index),
    lineWithCursor,
    ...lines.slice(index),
  ], lineWithCursor)
}

function replaceCursorLineMutation(lines: string[], index: number, lineWithCursor: string): QemuCursorMutation {
  return cursorLinesMutation([
    ...lines.slice(0, index),
    lineWithCursor,
    ...lines.slice(index + 1),
  ], lineWithCursor)
}

function cursorLinesMutation(linesWithCursor: string[], insertedText: string): QemuCursorMutation {
  const textWithCursor = linesWithCursor.join("\n")
  const offset = textWithCursor.indexOf(CURSOR)
  if (offset < 0) throw new Error("Generated QEMU P2 mutation is missing cursor marker.")
  const prefix = textWithCursor.slice(0, offset)
  const cursorLines = prefix.split("\n")
  return {
    text: textWithCursor.replace(CURSOR, ""),
    insertedText,
    cursor: {
      line: cursorLines.length - 1,
      character: cursorLines.at(-1)?.length ?? 0,
    },
  }
}

function qemuOpenTabs(sourceWorkspace: string, relativePath: string | undefined, files: QemuFileEntry[]) {
  if (!relativePath) return []
  const stem = relativePath.replace(/\.[^.]+$/, "")
  return files
    .filter((file) => file.path !== relativePath && file.path.replace(/\.[^.]+$/, "") === stem)
    .slice(0, 2)
    .map((file) => join(sourceWorkspace, file.path))
}

export function completionUiWorkspaceSettings(options: Pick<UiMatrixOptions, "apiBaseUrl" | "model" | "profile">) {
  const settings: Record<string, unknown> = {
    "chipmate.completion.enabled": true,
    "chipmate.completion.logLevel": "debug",
    "chipmate.completion.debounceMs": 0,
    "chipmate.codeGraph.enabled": true,
    "chipmate.codeGraph.promptOnWorkspaceOpen": false,
    "editor.inlineSuggest.enabled": true,
    "editor.tabCompletion": "off",
    "editor.acceptSuggestionOnEnter": "off",
    "extensions.ignoreRecommendations": true,
    "files.autoSave": "off",
    "files.saveConflictResolution": "overwriteFileOnDisk",
  }
  if (options.profile) settings["chipmate.completion.profile"] = options.profile
  if (options.apiBaseUrl) settings["chipmate.provider.apiBaseUrl"] = options.apiBaseUrl
  if (options.model) settings["chipmate.completion.model"] = options.model
  return settings
}

export function parseArgs(args: string[]): UiMatrixOptions {
  const value = (name: string, fallback = "") => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] ?? fallback : fallback
  }
  const qemuP2Matrix = args.includes("--qemu-p2-matrix") || args.includes("--qemu-p2-ui")
  const qemuDirect = args.includes("--qemu-direct") || qemuP2Matrix
  const profile = readProfile(value("--profile", ""))
  const qemuCodeGraph = readQemuCodeGraphMode(value("--qemu-codegraph", qemuP2Matrix ? "on" : "off"))
  const qemuIndexWaitMs = Number(value("--qemu-index-wait-ms", qemuP2Matrix ? "240000" : "0")) || 0
  const qemuIndexMaxFiles = Number(value("--qemu-index-max-files", qemuP2Matrix ? "5000" : "50000")) || (qemuP2Matrix ? 5000 : 50000)
  return {
    all: args.includes("--all"),
    drive: !args.includes("--no-drive") && !args.includes("--prepare-only"),
    workspace: value("--workspace", qemuP2Matrix ? DEFAULT_QEMU_P2_WORKSPACE : qemuDirect ? DEFAULT_QEMU_WORKSPACE : DEFAULT_WORKSPACE),
    codeApp: value("--code-app", DEFAULT_CODE_APP),
    apiBaseUrl: value("--api-base-url", "") || undefined,
    model: value("--model", "") || undefined,
    profile,
    waitMs: Number(value("--wait-ms", "12000")) || 12000,
    fixtureFilter: value("--fixture-filter", "") || undefined,
    qemuDirect,
    qemuP2Matrix,
    qemuCodeGraph,
    qemuIndexWaitMs,
    qemuIndexMaxFiles,
    sourceWorkspace: resolve(value("--source-workspace", DEFAULT_QEMU_SOURCE_WORKSPACE)),
    scenarioLimit: Number(value("--scenario-limit", qemuP2Matrix ? "12" : qemuDirect ? "72" : "0")) || (qemuDirect ? (qemuP2Matrix ? 12 : 72) : 0),
    restoreAfterEach: args.includes("--restore-after-each"),
  }
}

function reportPaths(options: UiMatrixOptions) {
  if (!options.qemuDirect) {
    return {
      output: join(options.workspace, "output-copy.txt"),
      results: join(options.workspace, "ui-run-results.json"),
      report: join(options.workspace, "ui-report.md"),
      fixPlan: join(options.workspace, "fix-plan.md"),
    }
  }
  return {
    output: join(options.workspace, "qemu-output-copy.txt"),
    results: join(options.workspace, "qemu-ui-results.json"),
    report: join(options.workspace, "qemu-ui-report.md"),
    fixPlan: join(options.workspace, "qemu-fix-plan.md"),
  }
}

function readProfile(input: string): CompletionProfile | undefined {
  if (input === "generic-chat" || input === "qwen-coder-fim") return input
  if (!input) return undefined
  throw new Error(`Unsupported completion profile: ${input}`)
}

function readQemuCodeGraphMode(input: string): UiMatrixOptions["qemuCodeGraph"] {
  if (input === "on" || input === "off") return input
  throw new Error(`Unsupported qemu codegraph mode: ${input}. Expected "on" or "off".`)
}

function directConfigSource(options: UiMatrixOptions) {
  return workspaceOverrideLabels(options).length ? "workspace-override" : "inherited"
}

function workspaceOverrideLabels(options: UiMatrixOptions) {
  return [
    options.apiBaseUrl ? "apiBaseUrl" : "",
    options.model ? "model" : "",
    options.profile ? "profile" : "",
  ].filter(Boolean)
}

function codeCliPath(codeApp: string) {
  const candidate = codeApp.endsWith(".app")
    ? join(codeApp, "Contents", "Resources", "app", "bin", "code")
    : codeApp
  if (!existsSync(candidate)) throw new Error(`VS Code CLI not found: ${candidate}`)
  return candidate
}

function safeRelativePath(path: string) {
  return path.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..").join(sep)
}

function safePathSegment(input: string) {
  return input.replace(/[^A-Za-z0-9._-]/g, "_")
}

function runAppleScript(lines: string[]) {
  const args = lines.flatMap((line) => ["-e", line])
  const result = spawnSync("osascript", args, { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "osascript failed")
  }
}

function tryAppleScript(lines: string[]) {
  try {
    runAppleScript(lines)
    return true
  } catch {
    return false
  }
}

function appleString(input: string) {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function stringArrayValue(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

function selectedEvidenceCountValue(event: Record<string, unknown>) {
  const direct = finiteNumberValue(event.selectedEvidenceCount)
  if (direct !== undefined) return direct
  const trace = event.cEmbeddedEvidenceTrace
  if (!trace || typeof trace !== "object") return undefined
  return finiteNumberValue((trace as Record<string, unknown>).finalSelectedEvidenceCount)
}

function finiteNumberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.filter(Boolean))]
}

if (import.meta.main) {
  await main()
}
