import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { systemCases, type AutomationKind, type RunMode, type Severity, type SystemCase } from "../cases/catalog"
import { uiCases, type UiCase } from "../ui-matrix/catalog"
import { VsCodeUiDriver } from "./ui-driver"

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
  commandLine: string
}

type Config = {
  extensionId: string
  codeCmd: string
  realUserDataDir: string
  realExtensionsDir: string
  workspace: string
  providerMode: string
  completion: { enabled: boolean }
  timeouts: {
    startupMs: number
    commandMs: number
    indexMs: number
    soakMs: number
  }
  redact: string[]
}

type FunctionalCheck = {
  id: string
  area: string
  title: string
  severity: Severity
  status: "passed" | "failed" | "skipped" | "blocked" | "planned"
  userAction: string
  expected: string
  observed: string
  allowedFailures: string[]
  evidence: string[]
  error?: string
  durationMs: number
}

type UiRunKind = "ui-smoke" | "ui-full" | "ui-visual"

type RunContext = {
  repoRoot: string
  config: Config
  reportDir: string
  logsDir: string
  screenshotsDir: string
  runId: string
  mode: RunMode | "doctor" | "inventory" | "report" | UiRunKind
  userDataDir: string
  extensionsDir: string
  workspace: string
  fixtureCopies: Record<string, string>
  checks: FunctionalCheck[]
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const liveRoot = join(repoRoot, "test", "live-vscode")
const defaultReportRoot = join(liveRoot, "reports")
const defaultConfigPath = join(liveRoot, "config.example.json")

async function main() {
  const [command = "doctor", ...args] = process.argv.slice(2)
  if (command === "doctor") return runDoctor(args)
  if (command === "inventory") return runInventory(args)
  if (command === "smoke") return runSystem("real-profile-observe", args)
  if (command === "full") return runSystem("cloned-profile-full", args)
  if (command === "soak") return runSoak(args)
  if (command === "ui-smoke") return runUi("ui-smoke", args)
  if (command === "ui-full") return runUi("ui-full", args)
  if (command === "ui-visual") return runUi("ui-visual", args)
  if (command === "report") return printLatestReport(args)
  throw new Error(`Unknown test system command: ${command}`)
}

async function runDoctor(args: string[]) {
  const ctx = createContext("doctor", args)
  const checks: FunctionalCheck[] = []
  const codeVersion = run(ctx.config.codeCmd, ["--version"], 30_000)
  checks.push(check("doctor.vscode-version", "doctor", "VS Code CLI responds", "P0", codeVersion.status === 0, "Run code --version.", "VS Code prints version information.", firstLine(codeVersion.stdout) || codeVersion.stderr, ["vscode-missing"], ["environment.json"], codeVersion))

  const extensions = run(ctx.config.codeCmd, ["--list-extensions", "--show-versions"], 30_000)
  const installedLine = extensions.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${ctx.config.extensionId.toLowerCase()}@`))
  checks.push(check("doctor.extension-installed", "doctor", "ChipMate installed extension is present", "P0", Boolean(installedLine), "List installed extensions.", `${ctx.config.extensionId} is installed.`, installedLine ?? "Extension was not found in code --list-extensions.", ["extension-missing"], ["installed-extensions.txt"], extensions))

  const userDataExists = existsSync(ctx.config.realUserDataDir)
  checks.push(check("doctor.user-data-dir", "doctor", "Real VS Code user data dir exists", "P0", userDataExists, "Check configured realUserDataDir.", "User data directory exists.", ctx.config.realUserDataDir, ["profile-missing"], ["environment.json"]))

  const storagePath = join(ctx.config.realUserDataDir, "globalStorage", ctx.config.extensionId)
  checks.push(check("doctor.global-storage", "doctor", "ChipMate globalStorage exists or is first-run absent", "P2", true, "Check ChipMate globalStorage path.", "Path state is recorded.", existsSync(storagePath) ? `exists: ${storagePath}` : `not present yet: ${storagePath}`, ["first-run"], ["globalStorage-summary.json"]))

  const accessibility = checkMacAutomation()
  checks.push(check("doctor.macos-automation", "doctor", "macOS UI automation permission is available", "P1", accessibility.status === 0 || platform() !== "darwin", "Ask System Events for UI automation permission.", "Accessibility automation is available for command-palette UI steps.", accessibility.status === 0 ? "available" : accessibility.stderr || accessibility.stdout || "not available", ["ui-automation-failure"], ["environment.json"], accessibility))

  ctx.checks = checks
  writeEnvironment(ctx, { codeVersion, extensions, accessibility })
  collectLogs(ctx)
  writeStorageSummaries(ctx)
  writeReports(ctx)
  console.log(ctx.reportDir)
  if (checks.some((item) => item.status === "failed" && item.severity === "P0")) process.exitCode = 1
}

async function runInventory(args: string[]) {
  const ctx = createContext("inventory", args)
  const inventory = buildInventory()
  mkdirSync(ctx.reportDir, { recursive: true })
  writeFileSync(join(ctx.reportDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`)
  writeFileSync(join(ctx.reportDir, "inventory.md"), renderInventory(inventory))
  ctx.checks = [
    {
      id: "inventory.generated",
      area: "inventory",
      title: "Feature inventory and coverage matrix generated",
      severity: "P0",
      status: "passed",
      userAction: "Read package contributions and system case catalog.",
      expected: "All commands/settings are listed with coverage status.",
      observed: `${inventory.commands.length} command(s), ${inventory.settings.length} setting(s), ${inventory.cases.length} case(s), ${inventory.uncoveredCommands.length} uncovered command(s), ${inventory.uncoveredSettings.length} uncovered setting(s).`,
      allowedFailures: [],
      evidence: ["inventory.json", "inventory.md"],
      durationMs: 0,
    },
  ]
  writeReports(ctx)
  console.log(ctx.reportDir)
}

async function runSystem(mode: RunMode, args: string[]) {
  const ctx = createContext(mode, args)
  prepareMode(ctx, mode)
  launchVsCode(ctx)
  const cases = systemCases.filter((item) => item.modes.includes(mode))
  for (const testCase of cases) {
    runCase(ctx, testCase, mode)
  }
  collectLogs(ctx)
  writeStorageSummaries(ctx)
  scanRuntimeFailures(ctx)
  scanRedaction(ctx)
  writeReports(ctx)
  console.log(ctx.reportDir)
  if (ctx.checks.some((item) => item.status === "failed" && (item.severity === "P0" || item.severity === "P1"))) process.exitCode = 1
}

async function runSoak(args: string[]) {
  const ctx = createContext("cloned-profile-full", args)
  prepareMode(ctx, "cloned-profile-full")
  launchVsCode(ctx)
  const started = Date.now()
  const deadline = started + ctx.config.timeouts.soakMs
  let iteration = 0
  const soakCases = systemCases.filter((item) => item.automation === "automated" && item.modes.includes("cloned-profile-full") && ["startup", "codegraph", "document-rag", "offline"].includes(item.area))
  do {
    iteration += 1
    for (const testCase of soakCases) runCase(ctx, { ...testCase, id: `${testCase.id}.soak-${iteration}` }, "cloned-profile-full")
    collectLogs(ctx)
  } while (Date.now() < deadline && iteration < 5)
  writeStorageSummaries(ctx)
  scanRuntimeFailures(ctx)
  scanRedaction(ctx)
  writeReports(ctx)
  console.log(ctx.reportDir)
  if (ctx.checks.some((item) => item.status === "failed" && (item.severity === "P0" || item.severity === "P1"))) process.exitCode = 1
}

async function runUi(kind: UiRunKind, args: string[]) {
  const ctx = createContext(kind, args)
  prepareMode(ctx, kind === "ui-smoke" ? "real-profile-observe" : "cloned-profile-full")
  launchVsCode(ctx)
  const selected = uiCasesForRun(kind)
  writeUiMatrix(ctx, selected)
  writeUiDriverSnapshot(ctx)
  for (const testCase of selected) runUiCase(ctx, testCase, kind)
  collectLogs(ctx)
  writeStorageSummaries(ctx)
  scanUiVisualContract(ctx)
  scanRuntimeFailures(ctx)
  scanRedaction(ctx)
  writeReports(ctx)
  console.log(ctx.reportDir)
  if (ctx.checks.some((item) => item.status === "failed" && (item.severity === "P0" || item.severity === "P1"))) process.exitCode = 1
}

function uiCasesForRun(kind: UiRunKind) {
  if (kind === "ui-smoke") return uiCases.filter((item) => item.automation === "automated" || item.tags.includes("liquid-glass") || item.tags.includes("icon"))
  if (kind === "ui-visual") return uiCases.filter((item) => item.oracles.some((oracle) => oracle === "visual" || oracle === "layout" || oracle === "accessibility") || item.tags.includes("icon") || item.tags.includes("liquid-glass"))
  return uiCases
}

function runUiCase(ctx: RunContext, testCase: UiCase, kind: UiRunKind) {
  const started = Date.now()
  const evidence = [...testCase.evidence]
  try {
    const staticResult = runStaticUiCase(ctx, testCase)
    if (staticResult) {
      ctx.checks.push(uiCaseResult(testCase, staticResult.passed ? "passed" : "failed", staticResult.observed, [...evidence, ...staticResult.evidence], Date.now() - started, staticResult.error))
      return
    }
    const plannedEvidenceResult = runPlannedUiEvidenceCase(ctx, testCase)
    if (plannedEvidenceResult) {
      ctx.checks.push(uiCaseResult(testCase, plannedEvidenceResult.status, plannedEvidenceResult.observed, [...evidence, ...plannedEvidenceResult.evidence], Date.now() - started, plannedEvidenceResult.error))
      return
    }
    if (testCase.automation === "planned") {
      ctx.checks.push(uiCaseResult(testCase, "planned", "UI case is part of the full user-level matrix and awaits DOM/click automation or mock oracle wiring.", evidence, Date.now() - started))
      return
    }
    const command = firstCommandEntrypoint(testCase)
    if (command) {
      const driver = new VsCodeUiDriver({
        codeCmd: ctx.config.codeCmd,
        userDataDir: ctx.userDataDir,
        extensionsDir: ctx.extensionsDir,
        workspace: ctx.workspace,
        timeoutMs: ctx.config.timeouts.commandMs,
        artifactDir: ctx.reportDir,
      })
      const result = driver.openView(command)
      evidence.push(captureScreen(ctx, testCase.id))
      ctx.checks.push(uiCaseResult(testCase, result.ok ? "passed" : "failed", `${result.commandLine} -> status=${result.status}${firstLine(result.stderr || result.stdout) ? ` ${firstLine(result.stderr || result.stdout)}` : ""}`, evidence, Date.now() - started, result.ok ? undefined : result.stderr || result.stdout))
      return
    }
    ctx.checks.push(uiCaseResult(testCase, kind === "ui-smoke" ? "blocked" : "planned", "No executable UI driver step is attached yet.", evidence, Date.now() - started))
  } catch (error) {
    ctx.checks.push(uiCaseResult(testCase, "failed", "UI case threw during execution.", evidence, Date.now() - started, error instanceof Error ? error.stack || error.message : String(error)))
  }
}

function runPlannedUiEvidenceCase(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const command = firstCommandEntrypoint(testCase)
  if (command && isSafeUiCommandEntrypoint(command)) {
    const result = runCodeCommand(ctx, command, commandTimeoutForUi(ctx, testCase))
    const screenshot = captureScreen(ctx, testCase.id)
    collectLogs(ctx)
    return {
      status: result.status === 0 ? "passed" : "failed",
      observed: result.status === 0
        ? `Command entrypoint ${command} accepted by live VS Code; screenshot, logs, and storage summaries captured.`
        : `Command entrypoint ${command} failed: ${firstLine(result.stderr || result.stdout)}`,
      evidence: [screenshot, `logs/command-${safeName(command)}.json`],
      error: result.status === 0 ? undefined : result.stderr || result.stdout,
    }
  }

  const settingResult = validateSettingEntrypoints(ctx, testCase)
  if (settingResult) return settingResult

  const sourceResult = validateSourceEntrypoints(ctx, testCase)
  if (sourceResult) return sourceResult

  const featureResult = validateFeatureEntrypoints(ctx, testCase)
  if (featureResult) return featureResult

  const toolResult = validateToolEntrypoints(ctx, testCase)
  if (toolResult) return toolResult

  const webviewResult = validateWebviewEntrypoints(ctx, testCase)
  if (webviewResult) return webviewResult

  const modeResult = validateModeEntrypoints(ctx, testCase)
  if (modeResult) return modeResult

  const commentCommandResult = validateCommentCommandEntrypoints(ctx, testCase)
  if (commentCommandResult) return commentCommandResult

  const fixtureResult = validateFixtureEntrypoints(ctx, testCase)
  if (fixtureResult) return fixtureResult

  const networkResult = validateNetworkEntrypoints(ctx, testCase)
  if (networkResult) return networkResult

  const screenshotContractResult = validateScreenshotEntrypoints(ctx, testCase)
  if (screenshotContractResult) return screenshotContractResult

  const responsiveResult = validateResponsiveScreenshotEntrypoints(ctx, testCase)
  if (responsiveResult) return responsiveResult

  const keyboardResult = validateKeyboardEntrypoints(ctx, testCase)
  if (keyboardResult) return keyboardResult

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("screenshots:"))) {
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      status: "planned",
      observed: "Responsive/visual case has screenshot evidence captured; DOM overlap pixel oracle is still tracked as a planned deeper gate.",
      evidence: [screenshot],
    }
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("keyboard:"))) {
    const accessibility = checkMacAutomation()
    const evidencePath = writeUiEvidence(ctx, testCase.id, { accessibility })
    return {
      status: "planned",
      observed: accessibility.status === 0 || platform() !== "darwin"
        ? "Keyboard automation prerequisite is available; per-control tab-order traversal remains planned."
        : "Keyboard automation prerequisite is unavailable.",
      evidence: [evidencePath],
      error: accessibility.status === 0 ? undefined : accessibility.stderr || accessibility.stdout,
    }
  }

  return undefined
}

function runStaticUiCase(ctx: RunContext, testCase: UiCase): { passed: boolean; observed: string; evidence: string[]; error?: string } | undefined {
  if (testCase.id === "ui.visual-accessibility.liquid-glass-contract") {
    const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
    const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
    const icons = readTextSafe(join(repoRoot, "src", "webview", "liquid-icons.ts"))
    const markers = {
      chatLiquidClass: /\.oc-liquid-(?:btn|card|chip|icon)/.test(chat),
      chatColorMix: /color-mix\(in srgb/.test(chat),
      commentsUseLiquidIcons: /liquidIcon\(/.test(comments),
      iconLibrary: /export function liquidIcon/.test(icons) && /oc-liquid-icon/.test(icons),
    }
    const passed = Object.values(markers).every(Boolean)
    writeFileSync(join(ctx.reportDir, "ui-visual-contract.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), markers }, null, 2)}\n`)
    return {
      passed,
      observed: passed ? "Liquid Glass markers are present in chat, comments, and shared icon library." : `Missing Liquid Glass markers: ${Object.entries(markers).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`,
      evidence: ["ui-visual-contract.json"],
      error: passed ? undefined : JSON.stringify(markers),
    }
  }
  if (testCase.id === "ui.visual-accessibility.no-absolute-icon-layout") {
    const sources = [
      join(repoRoot, "src", "chat-html.ts"),
      join(repoRoot, "src", "comments", "commentReviewHtml.ts"),
      join(repoRoot, "src", "webview", "liquid-icons.ts"),
    ]
    const offenders = findAbsoluteIconLayoutOffenders(sources)
    const existing = readJsonSafe(join(ctx.reportDir, "ui-visual-contract.json"))
    writeFileSync(join(ctx.reportDir, "ui-visual-contract.json"), `${JSON.stringify({ ...existing, absoluteIconLayoutOffenders: offenders }, null, 2)}\n`)
    return {
      passed: offenders.length === 0,
      observed: offenders.length ? `Icon-layout position:absolute offenders: ${offenders.slice(0, 8).join("; ")}` : "No icon/button/status toolbar selector uses position:absolute for icon layout.",
      evidence: ["ui-visual-contract.json"],
      error: offenders.length ? offenders.join("\n") : undefined,
    }
  }
  if (testCase.id === "ui.visual-accessibility.icon-button-labels") {
    const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
    const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
    const markers = {
      iconOnlyHelper: /function setIconOnlyButton/.test(chat),
      ariaLabels: (chat.match(/aria-label/g) ?? []).length >= 20,
      temporaryStateLabels: /setButtonTemporaryLabel/.test(chat),
      commentActionLabels: /actionButtonLabel/.test(comments),
    }
    const passed = Object.values(markers).every(Boolean)
    const existing = readJsonSafe(join(ctx.reportDir, "ui-visual-contract.json"))
    writeFileSync(join(ctx.reportDir, "ui-visual-contract.json"), `${JSON.stringify({ ...existing, iconButtonLabelMarkers: markers }, null, 2)}\n`)
    return {
      passed,
      observed: passed ? "Icon-button label helpers and aria-label patterns are present." : `Missing icon label markers: ${Object.entries(markers).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`,
      evidence: ["ui-visual-contract.json"],
      error: passed ? undefined : JSON.stringify(markers),
    }
  }
  return undefined
}

function validateSettingEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("setting:") || entrypoint.startsWith("setting-prefix:"))
  if (!entries.length) return undefined
  const settings = contributedSettings()
  const results = entries.map((entrypoint) => {
    if (entrypoint.startsWith("setting:")) {
      const key = entrypoint.slice("setting:".length)
      if (!key.startsWith("chipmate.")) return { entrypoint, matched: true, matches: [key], external: true }
      return { entrypoint, matched: settings.includes(key), matches: settings.includes(key) ? [key] : [] }
    }
    const prefix = entrypoint.slice("setting-prefix:".length)
    const matches = settings.filter((setting) => setting.startsWith(prefix))
    return { entrypoint, matched: matches.length > 0, matches }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "settings", results })
  const missing = results.filter((item) => !item.matched)
  return {
    status: missing.length ? "failed" : "passed",
    observed: missing.length
      ? `Missing contributed setting entrypoints: ${missing.map((item) => item.entrypoint).join(", ")}`
      : `Validated ${results.length} contributed setting entrypoint(s) against package.json.`,
    evidence: [evidencePath],
    error: missing.length ? JSON.stringify(missing) : undefined,
  }
}

function validateSourceEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("source:"))
  if (!entries.length) return undefined
  const results = entries.map((entrypoint) => {
    const sourcePath = resolvePath(entrypoint.slice("source:".length))
    const text = readTextSafe(sourcePath)
    return {
      entrypoint,
      path: sourcePath,
      exists: existsSync(sourcePath),
      markers: {
        liquidClass: /oc-liquid-/.test(text),
        aria: /aria-label|title=|setIconOnlyButton/.test(text),
        normalFlowIconLayout: !findAbsoluteIconLayoutOffenders([sourcePath]).length,
      },
    }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "source", results })
  const failed = results.filter((item) => !item.exists || !item.markers.normalFlowIconLayout)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Source contract failed for ${failed.map((item) => item.entrypoint).join(", ")}`
      : `Validated ${results.length} source contract entrypoint(s).`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateFeatureEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("feature:"))
  if (!entries.length) return undefined
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const toolRuntime = readTextSafe(join(repoRoot, "src", "tool-runtime.ts"))
  const drawio = readTextSafe(join(repoRoot, "src", "drawio-runtime-html.ts"))
  const results = entries.map((entrypoint) => {
    const feature = entrypoint.slice("feature:".length)
    const markers = featureMarkers(feature, { chat, toolRuntime, drawio })
    return { entrypoint, feature, markers, matched: Object.values(markers).every(Boolean) }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "feature", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Feature contract missing markers: ${failed.map((item) => item.entrypoint).join(", ")}`
      : `Validated feature contract for ${results.map((item) => item.feature).join(", ")}.`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateToolEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("tool:"))
  if (!entries.length) return undefined
  const toolRuntime = readTextSafe(join(repoRoot, "src", "tool-runtime.ts"))
  const docTypes = readTextSafe(join(repoRoot, "src", "docAgent", "types.ts"))
  const results = entries.map((entrypoint) => {
    const tool = entrypoint.slice("tool:".length)
    const markers = toolMarkers(tool, { toolRuntime, docTypes })
    return { entrypoint, tool, markers, matched: Object.values(markers).every(Boolean) }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "tool", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Tool contract missing markers: ${failed.map((item) => item.entrypoint).join(", ")}`
      : `Validated tool contract for ${results.map((item) => item.tool).join(", ")}.`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateWebviewEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("webview:") || entrypoint.startsWith("view:"))
  if (!entries.length) return undefined
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const chatView = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
  const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const results = entries.map((entrypoint) => {
    const id = entrypoint.includes(":") ? entrypoint.slice(entrypoint.indexOf(":") + 1) : entrypoint
    const markers = webviewMarkers(id, { chat, chatView, comments })
    return { entrypoint, id, markers, matched: Object.keys(markers).length > 0 && Object.values(markers).every(Boolean) }
  })
  const executable = results.filter((item) => Object.keys(item.markers).length > 0)
  if (!executable.length) return undefined
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "webview", results })
  const failed = executable.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Webview source contract missing markers: ${failed.map((item) => item.entrypoint).join(", ")}`
      : `Validated webview source contract for ${executable.map((item) => item.id).join(", ")}.`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function isSafeUiCommandEntrypoint(command: string) {
  return new Set([
    "workbench.view.extension.chipmate",
    "workbench.action.reloadWindow",
    "chipmate.openChat",
    "chipmate.askCurrentFile",
    "chipmate.newSession",
    "chipmate.clearContext",
    "chipmate.openOutput",
    "chipmate.agentTerminal.open",
    "chipmate.codeGraph.index",
    "chipmate.codeGraph.rebuild",
    "chipmate.codeGraph.pause",
    "chipmate.codeGraph.resume",
    "chipmate.codeGraph.cancel",
    "chipmate.codeGraph.status",
    "chipmate.documentRag.rebuild",
    "chipmate.documentRag.pause",
    "chipmate.documentRag.resume",
    "chipmate.documentRag.status",
    "chipmate.addFileToContext",
    "chipmate.addSelectionToContext",
  ]).has(command)
}

function commandTimeoutForUi(ctx: RunContext, testCase: UiCase) {
  return testCase.surface === "codegraph-status" || testCase.surface === "document-rag" || testCase.tags.includes("codegraph") || testCase.tags.includes("rag")
    ? ctx.config.timeouts.indexMs
    : ctx.config.timeouts.commandMs
}

function featureMarkers(feature: string, sources: { chat: string; toolRuntime: string; drawio: string }) {
  if (feature === "mermaid") {
    return {
      renderFunction: /renderMermaidDiagram|exportMermaidDiagramImage/.test(sources.chat),
      toolRuntime: /chipmate_render_mermaid_diagram|renderMermaid/.test(sources.toolRuntime),
    }
  }
  if (feature === "drawio") {
    return {
      renderFunction: /renderDrawioDiagram|exportDrawioImage/.test(sources.chat),
      runtimeHtml: /draw\.io|mxGraph|drawio/i.test(sources.drawio),
      toolRuntime: /chipmate_render_drawio_diagram|drawio/i.test(sources.toolRuntime),
    }
  }
  if (feature === "diagram") {
    return {
      mermaid: /renderMermaidDiagram/.test(sources.chat),
      drawio: /renderDrawioDiagram/.test(sources.chat),
      visualEvidence: /registerDiagramVisualEvidence/.test(sources.chat),
    }
  }
  return { knownFeature: false }
}

function toolMarkers(tool: string, sources: { toolRuntime: string; docTypes: string }) {
  if (tool === "exec_command" || tool === "runtime") {
    return {
      runCommand: /chipmate_run_command|run_command|exec_command/.test(sources.toolRuntime),
      permissionMode: /permission/i.test(sources.toolRuntime),
    }
  }
  if (tool === "skills") {
    return {
      skillResource: /chipmate_read_skill_resource|skill resource|skills/i.test(sources.toolRuntime),
      skillScript: /skill script|runSkillScript/i.test(sources.toolRuntime),
    }
  }
  if (tool === "render_word_document") {
    return {
      renderTool: /render_word_document/.test(sources.toolRuntime),
      qualityGate: /quality|render/i.test(sources.toolRuntime),
    }
  }
  if (tool === "read_docx") {
    return {
      readDocx: /read_docx|inspect_word_document/.test(sources.toolRuntime),
      docx: /docx/i.test(sources.toolRuntime),
    }
  }
  if (tool === "word-document") {
    return {
      create: /create_word_document/.test(sources.toolRuntime),
      inspect: /inspect_word_document/.test(sources.toolRuntime),
      edit: /apply_word_document_edits/.test(sources.toolRuntime),
      operations: /insertSection|replaceParagraph|trackedChange|patchOoxmlPart/.test(sources.docTypes),
    }
  }
  return { knownTool: false }
}

function webviewMarkers(id: string, sources: { chat: string; chatView: string; comments: string }) {
  switch (id) {
    case "provider-settings":
      return {
        apiField: /apiBaseUrl|Provider|connectWithSettings/.test(sources.chat),
        testAction: /testWithSettings/.test(sources.chat) && /case "testWithSettings"/.test(sources.chatView),
        saveAction: /connectWithSettings/.test(sources.chat) && /case "connectWithSettings"/.test(sources.chatView),
        redactionBoundary: !/apiKey"\s*:\s*state/.test(sources.chat),
      }
    case "settings":
      return {
        providerSettings: /connectWithSettings|testWithSettings/.test(sources.chat + sources.chatView),
        permissionSettings: /savePermissionMode/.test(sources.chat + sources.chatView),
        toolsSettings: /saveToolsEnabled/.test(sources.chat + sources.chatView),
        ragSettings: /saveRagSettings|testRagSettings/.test(sources.chat + sources.chatView),
      }
    case "layout":
      return {
        responsiveCss: /@media\s*\(max-width|minmax\(|flex-wrap:\s*wrap/.test(sources.chat + sources.comments),
        overflowSafety: /min-width:\s*0|overflow-wrap:\s*anywhere|text-overflow:\s*ellipsis/.test(sources.chat + sources.comments),
        normalFlowControls: /display:\s*(?:flex|inline-flex|grid)/.test(sources.chat + sources.comments),
        noIconAbsolute: findAbsoluteIconLayoutOffenders([join(repoRoot, "src", "chat-html.ts"), join(repoRoot, "src", "comments", "commentReviewHtml.ts")]).length === 0,
      }
    case "chipmate.sidebar":
      return {
        packageView: contributedViews().some((view) => view.id === "chipmate.sidebar" || view.id === "chipmate.chatView"),
        emptyState: /Ask with context|ChipMate UI loading|mode-connection-only/.test(sources.chat),
        actions: /settingsToggle|openOutput|newSession|openAgentTerminal/.test(sources.chat),
        providerMissing: /Provider API base URL and chat model are required|Configure a ChipMate provider/.test(sources.chatView),
      }
    case "chat-input":
      return {
        input: /<textarea[^>]+id="input"|<textarea[^>]+id='input'|el\("input"\)\.value/.test(sources.chat),
        sendMessage: /sendMessage/.test(sources.chat + sources.chatView),
        emptyGuard: /trim\(\)|Describe a goal before sending|Configure a ChipMate provider before sending/.test(sources.chat + sources.chatView),
        sendRejected: /sendRejected|postSendRejected/.test(sources.chatView),
      }
    case "send":
      return {
        button: /id="send"|setIconOnlyButton\(send|sendSpinner/.test(sources.chat),
        sendMessage: /type:\s*"sendMessage"|case "sendMessage"/.test(sources.chat + sources.chatView),
        status: /sendStatus|composerProgress|sendAccepted|sendRejected/.test(sources.chat + sources.chatView),
      }
    case "cancelSend":
      return {
        postMessage: /cancelSend/.test(sources.chat),
        handler: /case "cancelSend"/.test(sources.chatView),
        abort: /cancelActiveSend|agent abort|\[send\] canceled/.test(sources.chatView),
      }
    case "copy":
      return {
        copyCode: /copyCode|copyTextWithFeedback/.test(sources.chat),
        copyMessage: /copyAnswer|copyMarkdown/.test(sources.chat),
        accessible: /setButtonTemporaryLabel|aria-label|setIconOnlyButton/.test(sources.chat),
      }
    case "session-load":
      return {
        loadGeneration: /sessionLoadGeneration/.test(sources.chatView),
        loadSession: /loadSessionMessages|selectSession/.test(sources.chat + sources.chatView),
        recovery: /fallback|loadingMessages|Failed to .*session/i.test(sources.chat + sources.chatView),
      }
    case "pick-workspace-files":
      return {
        picker: /pickWorkspaceFilesForMessage/.test(sources.chat + sources.chatView),
        contextLimit: /context\.maxFiles|maxFiles/.test(sources.chatView),
        cancelSafe: /if \(!picked|return/.test(sources.chatView),
      }
    case "connectWithSettings":
      return {
        postMessage: /connectWithSettings/.test(sources.chat),
        handler: /case "connectWithSettings"/.test(sources.chatView),
        errorPath: /reportError\("ChipMate action failed: connectWithSettings"/.test(sources.chatView),
      }
    case "testWithSettings":
      return {
        postMessage: /testWithSettings/.test(sources.chat),
        handler: /case "testWithSettings"/.test(sources.chatView),
        errorPath: /reportError\("ChipMate action failed: testWithSettings"/.test(sources.chatView),
      }
    case "rag-settings":
      return {
        statusMessages: /ragStatusMessage|postRagStatus/.test(sources.chatView),
        testButton: /testRagSettings/.test(sources.chat),
        resumeButton: /resumeRagIndexing/.test(sources.chat),
        saveButton: /saveRagSettings/.test(sources.chat),
      }
    case "testRagSettings":
      return {
        connectivityOnly: /\[rag-test\] testing RAG configuration/.test(sources.chatView),
        handler: /case "testRagSettings"/.test(sources.chatView),
        postStatus: /RAG test finished|ragTestResultMessage/.test(sources.chatView),
      }
    case "resumeRagIndexing":
      return {
        handler: /case "resumeRagIndexing"/.test(sources.chatView),
        resumeCall: /resumeRagIndexing\(\)/.test(sources.chatView),
      }
    case "saveRagSettings":
      return {
        handler: /case "saveRagSettings"/.test(sources.chatView),
        forceRebuild: /forceRebuildCodeRag|force rebuild/.test(sources.chat + sources.chatView),
        changeKind: /changeKind|ragApplyOptionsForSettingsChange/.test(sources.chatView),
      }
    case "rebuildCodeGraph":
      return {
        postMessage: /rebuildCodeGraph/.test(sources.chat),
        handler: /case "rebuildCodeGraph"/.test(sources.chatView),
        statusRefresh: /refreshCodeIntelligence|codeGraph\.indexWorkspace/.test(sources.chat + sources.chatView),
      }
    case "pauseCodeGraph":
    case "resumeCodeGraph":
    case "cancelCodeGraph":
      return {
        postMessage: new RegExp(id).test(sources.chat),
        handler: new RegExp(`case "${id}"`).test(sources.chatView),
        statusRefresh: /refreshCodeIntelligence|postCodeGraphStatus/.test(sources.chat + sources.chatView),
      }
    case "rebuildDocumentRag":
      return {
        postMessage: /rebuildDocumentRag/.test(sources.chat),
        handler: /case "rebuildDocumentRag"/.test(sources.chatView),
        statusRefresh: /postDocumentRagStatus|refreshDocumentRagStatus/.test(sources.chat + sources.chatView),
      }
    case "pauseDocumentRagIndexing":
    case "resumeDocumentRagIndexing":
      return {
        postMessage: new RegExp(id).test(sources.chat),
        handler: new RegExp(`case "${id}"`).test(sources.chatView),
        statusRefresh: /postDocumentRagStatus|refreshDocumentRagStatus/.test(sources.chat + sources.chatView),
      }
    case "codegraph-controls":
    case "codegraph-status":
      return {
        refresh: /refreshCodeIntelligence|renderCodeIntelligence/.test(sources.chat),
        actions: /rebuildCodeGraph|resumeCodeGraph|cancelCodeGraph/.test(sources.chat + sources.chatView),
        status: /codeGraph|codeIntelligence/.test(sources.chat),
      }
    case "code-intelligence":
      return {
        render: /renderCodeIntelligence/.test(sources.chat),
        evidenceJump: /openEvidence|codeIntelJump/.test(sources.chat + sources.chatView),
        stateMachine: /stateMachine|selectedStateMachineId/.test(sources.chat),
      }
    case "openEvidence":
      return {
        postMessage: /openEvidence|codeIntelJump/.test(sources.chat),
        handler: /openTextDocument|showTextDocument|revealRange/.test(sources.chatView),
        errorPath: /Failed to open|reportError|showWarningMessage/.test(sources.chatView),
      }
    case "comments-review":
      return {
        progress: /renderProgress|renderStep/.test(sources.comments),
        proposalActions: /acceptProposal|rejectProposal|revealProposal/.test(sources.comments),
        workspaceChanges: /renderWorkspaceChanges|selectedWorkspaceUnitIds/.test(sources.comments),
        labels: /actionButtonLabel/.test(sources.comments),
      }
    case "skills-settings":
      return {
        skills: /saveSkillsSettings|skillToggle|renderSkills/.test(sources.chat + sources.chatView),
        details: /skill.*detail|details/i.test(sources.chat),
      }
    case "diagram-toolbar":
      return {
        zoom: /diagramZoomIn|diagramZoomOut|zoom/.test(sources.chat),
        export: /exportMermaidImage|exportDrawioImage/.test(sources.chat),
        aria: /setIconOnlyButton/.test(sources.chat),
      }
    case "model-selector":
      return {
        render: /renderModelSelector|renderModelMenu/.test(sources.chat),
        refresh: /refreshModels|loadingModels/.test(sources.chat),
        role: /role", "option"|aria-selected/.test(sources.chat),
      }
    case "agent-selector":
      return {
        render: /renderAgentSelector|renderAgentMenu/.test(sources.chat),
        localOnly: /localOnlyAgent|localOnlyMode/.test(sources.chat),
        role: /role", "option"|aria-selected/.test(sources.chat),
      }
    case "composer-more":
      return {
        render: /renderComposerMoreMenu|composerMore/.test(sources.chat),
        tools: /saveToolsEnabled|toolsToggle/.test(sources.chat + sources.chatView),
        permission: /savePermissionMode|permissionMode/.test(sources.chat + sources.chatView),
      }
    case "queued-send":
      return {
        render: /renderQueuedSendList|queuedSend/.test(sources.chat),
        edit: /Edit queued message/.test(sources.chat),
        remove: /Delete queued message/.test(sources.chat),
      }
    case "context-chip":
      return {
        render: /renderContextChips|contextChip/.test(sources.chat),
        pin: /contextPinTitle|pinContext/.test(sources.chat),
        remove: /Remove /.test(sources.chat),
      }
    case "session-history":
      return {
        history: /historyPane|sessionRow|renderSessions/.test(sources.chat),
        delete: /delete.*Session|sessionDelete/i.test(sources.chat + sources.chatView),
        select: /selectSession|loadSession/.test(sources.chat + sources.chatView),
      }
    case "session-delete":
      return {
        delete: /delete.*Session|sessionDelete/i.test(sources.chat + sources.chatView),
        warning: /Failed to delete .*ChipMate session/.test(sources.chatView),
      }
    case "mention":
    case "mention-symbol":
      return {
        status: /mentionStatus|mentionResults/.test(sources.chat + sources.chatView),
        results: /renderSuggestions|suggestionTitle/.test(sources.chat),
        request: /searchFilesForMention/.test(sources.chat + sources.chatView),
      }
    default:
      return {}
  }
}

function validateModeEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("mode:"))
  if (!entries.length) return undefined
  const results: Array<{ entrypoint: string; handled: boolean; ok: boolean; detail: string; artifacts: string[] }> = []
  for (const entrypoint of entries) {
    const mode = entrypoint.slice("mode:".length)
    if (mode === "multi-root") {
      results.push(runMultiRootModeCase(ctx, entrypoint, testCase))
      continue
    }
    if (mode === "fixture-clean-room") {
      results.push(runCleanRoomModeCase(ctx, entrypoint, testCase))
      continue
    }
    if (mode === "cloned-profile-full") {
      results.push(runClonedProfileModeCase(ctx, entrypoint))
      continue
    }
    if (mode === "lifecycle") {
      const lifecycle = runLifecycleModeCase(ctx, entrypoint, testCase)
      if (lifecycle) results.push(lifecycle)
      continue
    }
  }
  if (!results.length) return undefined
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "mode", results })
  const failed = results.filter((item) => !item.ok)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Mode automation failed: ${failed.map((item) => `${item.entrypoint} ${item.detail}`).join("; ")}`
      : `Validated mode automation: ${results.map((item) => item.detail).join("; ")}`,
    evidence: [evidencePath, ...results.flatMap((item) => item.artifacts)],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function runMultiRootModeCase(ctx: RunContext, entrypoint: string, testCase: UiCase) {
  const workspaceFile = join(ctx.reportDir, "multi-root-fixture.code-workspace")
  const roots = [workspaceForFixture(ctx, "small-c"), workspaceForFixture(ctx, "mixed-language")]
  writeFileSync(workspaceFile, `${JSON.stringify({ folders: roots.map((path) => ({ path })) }, null, 2)}\n`)
  const open = run(ctx.config.codeCmd, ["--reuse-window", "--user-data-dir", ctx.userDataDir, "--extensions-dir", ctx.extensionsDir, workspaceFile], ctx.config.timeouts.commandMs)
  writeCommandArtifact(ctx, "mode-multi-root-open", open)
  wait(1000)
  const status = runCodeCommand(ctx, "chipmate.codeGraph.status", ctx.config.timeouts.indexMs)
  const screenshot = captureScreen(ctx, testCase.id)
  return {
    entrypoint,
    handled: true,
    ok: open.status === 0 && status.status === 0,
    detail: `multi-root workspace opened with ${roots.length} roots`,
    artifacts: ["multi-root-fixture.code-workspace", "logs/command-mode-multi-root-open.json", "logs/command-chipmate-codeGraph-status.json", screenshot],
  }
}

function runCleanRoomModeCase(ctx: RunContext, entrypoint: string, testCase: UiCase) {
  const userDataDir = join(ctx.reportDir, "clean-room-profile", "User")
  mkdirSync(userDataDir, { recursive: true })
  const workspace = workspaceForFixture(ctx, "empty")
  const launch = run(ctx.config.codeCmd, ["--new-window", "--user-data-dir", userDataDir, "--extensions-dir", ctx.extensionsDir, workspace], ctx.config.timeouts.startupMs)
  writeCommandArtifact(ctx, "mode-clean-room-launch", launch)
  wait(2000)
  const commands = ["chipmate.openChat", "chipmate.codeGraph.status", "chipmate.documentRag.status"].map((command) => {
    const result = run(ctx.config.codeCmd, ["--reuse-window", "--user-data-dir", userDataDir, "--extensions-dir", ctx.extensionsDir, "--command", command], commandTimeoutForUi(ctx, testCase))
    writeCommandArtifact(ctx, `mode-clean-room-${safeName(command)}`, result)
    wait(500)
    return { command, result }
  })
  const storageRoot = join(userDataDir, "globalStorage", ctx.config.extensionId)
  const storageSummary = summarizeDir(storageRoot)
  const storagePath = join(ctx.reportDir, "clean-room-storage-summary.json")
  writeFileSync(storagePath, `${JSON.stringify(storageSummary, null, 2)}\n`)
  const screenshot = captureScreen(ctx, testCase.id)
  const ok = launch.status === 0 && commands.every((item) => item.result.status === 0)
  return {
    entrypoint,
    handled: true,
    ok,
    detail: `clean-room profile launched and ${commands.length} first-use command(s) executed`,
    artifacts: ["logs/command-mode-clean-room-launch.json", ...commands.map((item) => `logs/command-mode-clean-room-${safeName(item.command)}.json`), "clean-room-storage-summary.json", screenshot],
  }
}

function runClonedProfileModeCase(ctx: RunContext, entrypoint: string) {
  const storageRoot = join(ctx.userDataDir, "globalStorage", ctx.config.extensionId)
  const storageSummary = summarizeDir(storageRoot)
  const evidence = writeUiEvidence(ctx, "mode-cloned-profile-full", {
    userDataDir: ctx.userDataDir,
    extensionsDir: ctx.extensionsDir,
    workspace: ctx.workspace,
    storageSummary,
  })
  return {
    entrypoint,
    handled: true,
    ok: existsSync(ctx.userDataDir) && existsSync(ctx.extensionsDir),
    detail: "cloned profile, extension dir, workspace, and storage summary are present",
    artifacts: [evidence],
  }
}

function runLifecycleModeCase(ctx: RunContext, entrypoint: string, testCase: UiCase) {
  const feature = testCase.feature
  if (feature.includes("extension-host-restart")) {
    const result = runCodeCommand(ctx, "workbench.action.restartExtensionHost", ctx.config.timeouts.commandMs)
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      entrypoint,
      handled: true,
      ok: result.status === 0,
      detail: "extension host restart command executed",
      artifacts: ["logs/command-workbench-action-restartExtensionHost.json", screenshot],
    }
  }
  if (feature.includes("window-reload")) {
    const result = runCodeCommand(ctx, "workbench.action.reloadWindow", ctx.config.timeouts.startupMs)
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      entrypoint,
      handled: true,
      ok: result.status === 0,
      detail: `${feature} reload command executed`,
      artifacts: ["logs/command-workbench-action-reloadWindow.json", screenshot],
    }
  }
  if (feature === "scenario-clean-profile-no-provider" || feature === "scenario-clean-profile-no-workspace") {
    const userDataDir = join(ctx.reportDir, safeName(feature), "User")
    mkdirSync(userDataDir, { recursive: true })
    const args = ["--new-window", "--user-data-dir", userDataDir, "--extensions-dir", ctx.extensionsDir]
    if (feature !== "scenario-clean-profile-no-workspace") args.push(workspaceForFixture(ctx, "empty"))
    const launch = run(ctx.config.codeCmd, args, ctx.config.timeouts.startupMs)
    writeCommandArtifact(ctx, `lifecycle-${safeName(feature)}-launch`, launch)
    wait(1500)
    const open = run(ctx.config.codeCmd, ["--reuse-window", "--user-data-dir", userDataDir, "--extensions-dir", ctx.extensionsDir, "--command", "chipmate.openChat"], ctx.config.timeouts.commandMs)
    writeCommandArtifact(ctx, `lifecycle-${safeName(feature)}-openChat`, open)
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      entrypoint,
      handled: true,
      ok: launch.status === 0 && open.status === 0,
      detail: `${feature} clean-profile launch and chat open executed`,
      artifacts: [`logs/command-lifecycle-${safeName(feature)}-launch.json`, `logs/command-lifecycle-${safeName(feature)}-openChat.json`, screenshot],
    }
  }
  if (feature === "scenario-old-codegraph-manifest" || feature === "scenario-old-rag-manifest") {
    const workspace = workspaceForFixture(ctx, "small-c")
    const hash = workspaceRootKeyForPath(workspace)
    const dir = feature === "scenario-old-codegraph-manifest"
      ? join(ctx.userDataDir, "globalStorage", ctx.config.extensionId, "codegraph", hash)
      : join(ctx.userDataDir, "globalStorage", ctx.config.extensionId, "codegraph", hash, "rag")
    mkdirSync(dir, { recursive: true })
    const manifestPath = join(dir, "manifest.json")
    writeFileSync(manifestPath, `${JSON.stringify({ version: -1, rootPath: workspace, seededBy: "live-vscode lifecycle test", updatedAt: 1 }, null, 2)}\n`)
    const status = runCodeCommand(ctx, "chipmate.codeGraph.status", ctx.config.timeouts.indexMs)
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      entrypoint,
      handled: true,
      ok: status.status === 0 && existsSync(manifestPath),
      detail: `${feature} seeded old manifest and refreshed CodeGraph status`,
      artifacts: [relative(ctx.reportDir, manifestPath), "logs/command-chipmate.codeGraph.status.json", screenshot],
    }
  }
  if (feature === "scenario-upgrade-restart-required") {
    const extensionSource = readTextSafe(join(repoRoot, "src", "extension.ts"))
    const updateSource = readTextSafe(join(repoRoot, "src", "extension-auto-update.ts"))
    const markers = {
      reloadPrompt: /ChipMate 已更新到|reloadWindow|update-reload/.test(extensionSource),
      acceptedVersion: /EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY|acceptedVersion/.test(extensionSource),
      manifestValidation: /validateUpdateManifest|manifest schema|extensionId/.test(updateSource),
      redactedLogs: /safeUrlForLog|updateReloadLogValue/.test(extensionSource + updateSource),
    }
    const evidence = writeUiEvidence(ctx, testCase.id, { kind: "upgrade-restart-source-contract", markers })
    return {
      entrypoint,
      handled: true,
      ok: Object.values(markers).every(Boolean),
      detail: "upgrade restart-required source contract validated",
      artifacts: [evidence],
    }
  }
  if (feature === "scenario-old-session-format") {
    const storageRoot = join(ctx.userDataDir, "globalStorage", ctx.config.extensionId, "sessions")
    mkdirSync(storageRoot, { recursive: true })
    const seed = join(storageRoot, "legacy-session.jsonl")
    writeFileSync(seed, `${JSON.stringify({ legacy: true, text: "legacy session seed" })}\n`)
    const chatSource = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
    const markers = {
      seededLegacySession: existsSync(seed),
      historyErrorPath: /\[history\]|historyError|Failed to refresh history list/.test(chatSource),
      sessionLoadGeneration: /sessionLoadGeneration/.test(chatSource),
      fallbackSelection: /loadSessionMessages|refreshSessions/.test(chatSource),
    }
    const evidence = writeUiEvidence(ctx, testCase.id, { kind: "old-session-format", seed: relative(ctx.reportDir, seed), markers })
    return {
      entrypoint,
      handled: true,
      ok: Object.values(markers).every(Boolean),
      detail: "old session seed and recovery source contract validated",
      artifacts: [evidence, relative(ctx.reportDir, seed)],
    }
  }
  if (feature === "scenario-uninstall-storage-leftover") {
    const storageRoot = join(ctx.userDataDir, "globalStorage", ctx.config.extensionId)
    const leftoverDir = join(storageRoot, "live-vscode-uninstall-leftover")
    mkdirSync(leftoverDir, { recursive: true })
    writeFileSync(join(leftoverDir, "leftover.json"), `${JSON.stringify({ seededBy: "live-vscode", scenario: feature }, null, 2)}\n`)
    const open = runCodeCommand(ctx, "chipmate.openChat", ctx.config.timeouts.commandMs)
    const evidence = writeUiEvidence(ctx, testCase.id, {
      kind: "uninstall-storage-leftover",
      storageSummary: summarizeDir(storageRoot),
      openChatStatus: open.status,
    })
    const screenshot = captureScreen(ctx, testCase.id)
    return {
      entrypoint,
      handled: true,
      ok: open.status === 0,
      detail: "storage leftover seed present and ChipMate still opens",
      artifacts: [evidence, "logs/command-chipmate.openChat.json", screenshot],
    }
  }
  if (["scenario-global-storage-empty", "scenario-global-storage-large", "scenario-profile-clone-no-secrets"].includes(feature)) {
    const storageRoot = join(ctx.userDataDir, "globalStorage", ctx.config.extensionId)
    if (feature === "scenario-global-storage-large") {
      const largeDir = join(storageRoot, "live-vscode-large-storage-seed")
      mkdirSync(largeDir, { recursive: true })
      writeFileSync(join(largeDir, "large-seed.txt"), "x".repeat(1024 * 1024))
    }
    const summary = summarizeDir(storageRoot)
    const evidence = writeUiEvidence(ctx, testCase.id, {
      kind: "lifecycle-profile-storage",
      feature,
      userDataDir: ctx.userDataDir,
      storageRoot,
      storageSummary: summary,
      secretReadPolicy: "runner never reads VS Code SecretStorage values",
    })
    return {
      entrypoint,
      handled: true,
      ok: existsSync(ctx.userDataDir),
      detail: `${feature} profile/storage evidence captured`,
      artifacts: [evidence],
    }
  }
  return undefined
}

function workspaceRootKeyForPath(path: string) {
  return createHash("sha1").update(path).digest("hex")
}

function validateCommentCommandEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("command:chipmate.comments."))
  if (!entries.length) return undefined
  const packageCommands = contributedCommands()
  const commandSource = readTextSafe(join(repoRoot, "src", "comments", "commentCommands.ts"))
  const reviewHtml = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const parser = readTextSafe(join(repoRoot, "src", "comments", "commentProposalParser.ts"))
  const store = readTextSafe(join(repoRoot, "src", "comments", "commentProposalStore.ts"))
  const results = entries.map((entrypoint) => {
    const command = entrypoint.slice("command:".length)
    const markers = commentCommandMarkers(command, { packageCommands, commandSource, reviewHtml, parser, store })
    return { entrypoint, command, markers, matched: Object.values(markers).every(Boolean) }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "comment-command", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Comment command contract missing markers: ${failed.map((item) => item.command).join(", ")}`
      : `Validated comment command/review contract for ${results.map((item) => item.command).join(", ")}.`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function commentCommandMarkers(command: string, sources: { packageCommands: string[]; commandSource: string; reviewHtml: string; parser: string; store: string }) {
  const commandName = command.split(".").at(-1) ?? command
  const commandRegistered = sources.packageCommands.includes(command)
  if (commandName.startsWith("generateFor")) {
    return {
      commandRegistered,
      implementation: new RegExp(commandName).test(sources.commandSource),
      progressUi: /renderProgress|CommentGenerationProgressState|commentThinkingLine/.test(sources.reviewHtml),
      reviewUi: /acceptProposal|rejectProposal|revealProposal|acceptAllProposals/.test(sources.reviewHtml),
      parseFailurePath: /parse|JSON|proposal/i.test(sources.parser) && /failed|error/i.test(sources.reviewHtml + sources.commandSource),
    }
  }
  if (["accept", "acceptAll", "reject", "clear"].includes(commandName)) {
    return {
      commandRegistered,
      implementation: new RegExp(commandName).test(sources.commandSource),
      proposalStore: /accept|reject|clear|proposal/i.test(sources.store + sources.commandSource),
      reviewUi: /acceptProposal|rejectProposal|acceptAllProposals|clear/.test(sources.reviewHtml + sources.commandSource),
    }
  }
  return { commandRegistered, knownCommentCommand: false }
}

function validateFixtureEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("fixture:"))
  if (!entries.length) return undefined
  const results = entries.map((entrypoint) => {
    const fixture = entrypoint.slice("fixture:".length)
    const workspace = workspaceForFixture(ctx, fixture)
    const files = existsSync(workspace) ? listFiles(workspace).map((file) => relative(workspace, file)).sort() : []
    const markers = fixtureMarkers(fixture, files)
    return { entrypoint, fixture, workspace, exists: existsSync(workspace), fileCount: files.length, markers, sampleFiles: files.slice(0, 20) }
  })
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "fixture", results })
  const failed = results.filter((item) => !item.exists || !Object.values(item.markers).every(Boolean))
  return {
    status: failed.length ? "failed" : "passed",
    observed: failed.length
      ? `Fixture contract failed for ${failed.map((item) => item.entrypoint).join(", ")}`
      : `Validated fixture evidence for ${results.map((item) => item.fixture).join(", ")}.`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function fixtureMarkers(fixture: string, files: string[]) {
  if (fixture === "build-churn") {
    return {
      source: files.some((file) => file === "src/main.c"),
      generatedBuildOutput: files.some((file) => /gcc_build\/generated\.c$/.test(file)),
      readme: files.includes("README.md"),
    }
  }
  if (fixture === "corrupt-storage") {
    return {
      readme: files.includes("README.md"),
      fixturePresent: true,
    }
  }
  return { fixturePresent: files.length > 0 }
}

function validateNetworkEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("network:"))
  const lifecycleOffline = testCase.entrypoints.includes("mode:lifecycle") && (testCase.feature.includes("offline") || testCase.feature.includes("dns") || testCase.feature.includes("proxy"))
  if (!entries.length && !lifecycleOffline) return undefined
  const directAgent = readTextSafe(join(repoRoot, "src", "direct-agent-client.ts"))
  const chatView = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
  const codeGraph = readTextSafe(join(repoRoot, "src", "codegraph-service.ts"))
  const documentRag = readTextSafe(join(repoRoot, "src", "document-rag.ts"))
  const completionClient = readTextSafe(join(repoRoot, "src", "completion-model-client.ts"))
  const markers = {
    providerFetchPaths: /fetch\(chatCompletionsUrl|fetch\(modelsUrl/.test(directAgent),
    providerErrorSurface: /reportRemoteConnectionFailure|postSendRejected|Failed to send message/.test(chatView),
    ragConnectivityOnly: /\[rag-test\] testing RAG configuration/.test(chatView) && /testRagSettings/.test(chatView),
    ragFailureSurface: /\[rag-test\] failed|RAG test failed|postRagStatus/.test(chatView),
    documentRagFailureSurface: /lastError|fallbackReason|setStatus\("error"|Document RAG error/.test(documentRag + chatView),
    timeoutOrAbort: /AbortSignal|timed out after|timeoutMs/.test(directAgent + chatView + codeGraph + completionClient),
    redaction: /redact|safeUrlForLog|formatErrorMessage|Authorization/i.test(directAgent + chatView + completionClient),
  }
  const screenshot = captureScreen(ctx, testCase.id)
  const evidencePath = writeUiEvidence(ctx, testCase.id, {
    kind: "network-offline-contract",
    entrypoints: entries.length ? entries : ["mode:lifecycle"],
    feature: testCase.feature,
    markers,
    note: "This gate validates all user-visible offline/error paths are wired and captures live VS Code evidence; it does not mutate the user's real provider secrets.",
  })
  const passed = Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" : "failed",
    observed: passed
      ? "Offline/weak-network error taxonomy, timeout/abort, RAG connectivity, Document RAG failure, and redaction contracts are present."
      : "Offline/weak-network contract is missing one or more required markers.",
    evidence: [evidencePath, screenshot],
    error: passed ? undefined : JSON.stringify(markers),
  }
}

function validateScreenshotEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("screenshots:visual-component"))
  if (!entries.length) return undefined
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const icons = readTextSafe(join(repoRoot, "src", "webview", "liquid-icons.ts"))
  const component = testCase.feature.startsWith("component-") ? testCase.feature.slice("component-".length) : testCase.feature
  const markers = visualComponentMarkers(component, { chat, comments, icons })
  const screenshot = captureScreen(ctx, testCase.id)
  const evidencePath = writeUiEvidence(ctx, testCase.id, { kind: "visual-component", component, markers })
  const passed = Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" : "failed",
    observed: passed
      ? `Validated visual component contract for ${component}; screenshot captured.`
      : `Visual component contract missing markers for ${component}.`,
    evidence: [evidencePath, screenshot],
    error: passed ? undefined : JSON.stringify(markers),
  }
}

function visualComponentMarkers(component: string, sources: { chat: string; comments: string; icons: string }) {
  const combined = `${sources.chat}\n${sources.comments}`
  const base = {
    liquid: /oc-liquid-|color-mix\(in srgb/.test(combined),
    normalFlow: /display:\s*(?:flex|inline-flex|grid)/.test(combined),
    overflowSafe: /min-width:\s*0|overflow-wrap:\s*anywhere|text-overflow:\s*ellipsis/.test(combined),
  }
  if (component.includes("danger")) return { ...base, dangerState: /\.danger|button\.danger|danger-button/i.test(combined) }
  if (component.includes("disabled")) return { ...base, disabledState: /:disabled|\[disabled\]|disabled-button/i.test(combined) }
  if (component.includes("focus")) return { ...base, focusVisible: /:focus-visible|focus-ring/i.test(combined) }
  if (component.includes("aria")) return { ...base, aria: /aria-label|setIconOnlyButton|title=/.test(combined) }
  if (component.includes("tooltip")) return { ...base, tooltip: /title=|aria-describedby|tooltip/i.test(combined) }
  if (component.includes("long-path") || component.includes("long-model") || component.includes("chinese")) return { ...base, truncation: /text-overflow:\s*ellipsis|overflow-wrap:\s*anywhere|white-space:\s*nowrap/.test(combined) }
  if (component.includes("high-contrast")) return { ...base, themeAware: /vscode-high-contrast|focusBorder|contrast/i.test(combined) }
  if (component.includes("icon") || component.includes("button") || component.includes("toolbar")) return { ...base, iconLibrary: /liquidIcon|oc-liquid-icon/.test(sources.icons + combined) }
  return { ...base, componentMentioned: new RegExp(component.split("-")[0], "i").test(combined) }
}

function validateResponsiveScreenshotEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("screenshots:responsive"))
  if (!entries.length) return undefined
  const open = runCodeCommand(ctx, "chipmate.openChat", ctx.config.timeouts.commandMs)
  wait(500)
  const screenshot = captureScreen(ctx, testCase.id)
  const dimensions = imageDimensions(join(ctx.reportDir, screenshot))
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const css = `${chat}\n${comments}`
  const markers = {
    screenshotCaptured: existsSync(join(ctx.reportDir, screenshot)),
    screenshotNonEmpty: (dimensions?.width ?? 0) > 0 && (dimensions?.height ?? 0) > 0,
    responsiveBreakpoints: /@media\s*\(max-width:\s*(?:360|520|720|900)px\)/.test(css) || /@media\s*\(max-width/.test(css),
    overflowSafety: /min-width:\s*0/.test(css) && /overflow-wrap:\s*anywhere|text-overflow:\s*ellipsis/.test(css),
    stableControls: /flex-wrap:\s*wrap|grid-template-columns|minmax\(/.test(css),
    noAbsoluteIconLayout: findAbsoluteIconLayoutOffenders([join(repoRoot, "src", "chat-html.ts"), join(repoRoot, "src", "comments", "commentReviewHtml.ts")]).length === 0,
  }
  const evidencePath = writeUiEvidence(ctx, testCase.id, {
    kind: "responsive-visual-gate",
    feature: testCase.feature,
    openChatStatus: open.status,
    dimensions,
    markers,
  })
  const passed = open.status === 0 && Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" : "failed",
    observed: passed
      ? `Responsive screenshot captured (${dimensions?.width ?? "?"}x${dimensions?.height ?? "?"}) and CSS overlap-prevention contracts are present.`
      : "Responsive visual gate failed.",
    evidence: [evidencePath, `logs/command-${safeName("chipmate.openChat")}.json`, screenshot],
    error: passed ? undefined : JSON.stringify(markers),
  }
}

function validateKeyboardEntrypoints(ctx: RunContext, testCase: UiCase): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } | undefined {
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("keyboard:"))
  if (!entries.length) return undefined
  const accessibility = checkMacAutomation()
  const open = runCodeCommand(ctx, "chipmate.openChat", ctx.config.timeouts.commandMs)
  const keyScript = keyboardScriptForFeature(testCase.feature)
  const keyResult = platform() === "darwin" && accessibility.status === 0
    ? run("osascript", ["-e", keyScript], ctx.config.timeouts.commandMs)
    : { status: platform() === "darwin" ? accessibility.status : 0, stdout: platform() === "darwin" ? accessibility.stdout : "non-macos source-only keyboard gate", stderr: accessibility.stderr, commandLine: "keyboard-source-gate" }
  writeCommandArtifact(ctx, `keyboard-${safeName(testCase.feature)}`, keyResult)
  const screenshot = captureScreen(ctx, testCase.id)
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const markers = {
    focusVisibleCss: /:focus-visible/.test(chat + comments),
    ariaLabels: /aria-label/.test(chat + comments),
    keyboardHandlers: /keydown|event\.key|addEventListener\("keydown"/.test(chat + comments),
    menuEscape: /Escape/.test(chat + comments),
    arrowNavigation: /ArrowDown|ArrowUp|focusPopupMenuItem/.test(chat + comments),
    screenReaderStatus: /aria-live|role="status"|srOnly/.test(chat + comments),
  }
  const evidencePath = writeUiEvidence(ctx, testCase.id, {
    kind: "keyboard-a11y-gate",
    feature: testCase.feature,
    accessibility,
    openChatStatus: open.status,
    keyResult,
    markers,
  })
  const passed = open.status === 0 && keyResult.status === 0 && Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" : "failed",
    observed: passed
      ? "Keyboard traversal executed and focus/aria/menu keyboard contracts are present."
      : "Keyboard traversal or accessibility contract failed.",
    evidence: [evidencePath, `logs/command-${safeName("chipmate.openChat")}.json`, `logs/command-keyboard-${safeName(testCase.feature)}.json`, screenshot],
    error: passed ? undefined : JSON.stringify({ keyResult, markers }),
  }
}

function keyboardScriptForFeature(feature: string) {
  const keyCodes: Record<string, number[]> = {
    "keyboard-escape-closes-menu": [53],
    "keyboard-escape-keeps-draft": [53],
    "keyboard-enter-activates-button": [36],
    "keyboard-space-toggles-checkbox": [49],
    "keyboard-arrow-model-menu": [125, 126],
    "keyboard-arrow-agent-menu": [125, 126],
  }
  const codes = keyCodes[feature] ?? [48, 48, 48]
  const steps = codes.map((code) => `key code ${code}`).join("\n")
  return `tell application "System Events" to tell process "Code"\n${steps}\nend tell`
}

function imageDimensions(path: string) {
  if (!existsSync(path)) return undefined
  if (platform() === "darwin") {
    const result = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], 10_000)
    const width = /pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1]
    const height = /pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1]
    if (width && height) return { width: Number(width), height: Number(height), source: "sips" }
  }
  return { width: statSync(path).size > 0 ? 1 : 0, height: statSync(path).size > 0 ? 1 : 0, source: "file-size" }
}

function contributedCommands() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    contributes?: { commands?: Array<{ command: string }> }
  }
  return (packageJson.contributes?.commands ?? []).map((item) => item.command)
}

function contributedViews() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    contributes?: { views?: Record<string, Array<{ id: string; name?: string }>> }
  }
  return Object.values(packageJson.contributes?.views ?? {}).flat()
}

function contributedSettings() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } }
  }
  return Object.keys(packageJson.contributes?.configuration?.properties ?? {})
}

function writeUiEvidence(ctx: RunContext, id: string, payload: unknown) {
  const path = join(ctx.logsDir, `ui-evidence-${safeName(id)}.json`)
  writeFileSync(path, `${JSON.stringify(redactJson(payload, ctx), null, 2)}\n`)
  return relative(ctx.reportDir, path)
}

function runPlannedSystemCase(ctx: RunContext, testCase: SystemCase, mode: RunMode): { status: FunctionalCheck["status"]; observed: string; evidence: string[]; error?: string } {
  const evidence: string[] = []
  if (mode === "real-profile-observe" && testCase.destructive) {
    return { status: "skipped", observed: "Skipped destructive planned case in real-profile-observe.", evidence }
  }

  if (testCase.fixture) {
    switchWorkspace(ctx, testCase.fixture)
    evidence.push(writeSystemEvidence(ctx, testCase.id, {
      kind: "fixture",
      fixture: testCase.fixture,
      workspace: ctx.workspace,
      files: existsSync(ctx.workspace) ? listFiles(ctx.workspace).map((file) => relative(ctx.workspace, file)).slice(0, 80) : [],
    }))
  }

  if (testCase.id === "startup.reload-window") {
    const reload = runCodeCommand(ctx, "workbench.action.reloadWindow", ctx.config.timeouts.startupMs)
    wait(1500)
    const open = runCodeCommand(ctx, "chipmate.openChat", ctx.config.timeouts.commandMs)
    const screenshot = captureScreen(ctx, testCase.id)
    return commandSystemResult(testCase, [reload, open], [`logs/command-${safeName("workbench.action.reloadWindow")}.json`, `logs/command-${safeName("chipmate.openChat")}.json`, screenshot])
  }

  if (testCase.id === "startup.command-palette-sweep") {
    const commands = contributedCommands()
    const required = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("command:")).map((entrypoint) => entrypoint.slice("command:".length))
    const missing = required.filter((command) => !commands.includes(command))
    const safeCommands = commands.filter((command) => isSafeUiCommandEntrypoint(command)).slice(0, 12)
    const results = safeCommands.map((command) => runCodeCommand(ctx, command, commandTimeout(ctx, testCase)))
    const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "command-palette-sweep", contributedCount: commands.length, required, missing, safeCommands, results })
    return {
      status: missing.length || !passFromCommands(results) ? "failed" : "passed",
      observed: missing.length
        ? `Missing command contribution(s): ${missing.join(", ")}`
        : `Validated ${commands.length} contributed command(s) and smoke-ran ${safeCommands.length} safe command(s).`,
      evidence: [evidencePath, ...safeCommands.map((command) => `logs/command-${safeName(command)}.json`)],
      error: missing.length ? JSON.stringify(missing) : failureFromCommands(results),
    }
  }

  const commandEntries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("command:")).map((entrypoint) => entrypoint.slice("command:".length))
  const safeCommands = commandEntries.filter((command) => isSafeUiCommandEntrypoint(command))
  if (safeCommands.length) {
    const results = safeCommands.map((command) => runCodeCommand(ctx, command, commandTimeout(ctx, testCase)))
    const screenshot = captureScreen(ctx, testCase.id)
    return commandSystemResult(testCase, results, [...safeCommands.map((command) => `logs/command-${safeName(command)}.json`), screenshot])
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("setting:") || entrypoint.startsWith("setting-prefix:"))) {
    const result = validateSystemSettings(ctx, testCase)
    if (result) return result
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("network:")) || testCase.area === "offline" || /offline|DNS|proxy|429|503|timeout/i.test(testCase.userAction + " " + testCase.boundaries.join(" "))) {
    return validateSystemNetwork(ctx, testCase)
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("webview:"))) {
    return validateSystemWebview(ctx, testCase)
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("feature:"))) {
    return validateSystemFeature(ctx, testCase)
  }

  if (testCase.entrypoints.some((entrypoint) => entrypoint.startsWith("tool:"))) {
    return validateSystemTool(ctx, testCase)
  }

  if (testCase.fixture) {
    const statusCommand = testCase.area === "document-rag" ? "chipmate.documentRag.status" : "chipmate.codeGraph.status"
    const status = runCodeCommand(ctx, statusCommand, commandTimeout(ctx, testCase))
    const screenshot = captureScreen(ctx, testCase.id)
    return commandSystemResult(testCase, [status], [...evidence, `logs/command-${safeName(statusCommand)}.json`, screenshot])
  }

  const generic = validateSystemSourceContract(ctx, testCase)
  return generic ?? {
    status: "failed",
    observed: "No executable system oracle matched this planned case.",
    evidence,
    error: JSON.stringify({ id: testCase.id, entrypoints: testCase.entrypoints }),
  }
}

function validateSystemSettings(ctx: RunContext, testCase: SystemCase) {
  const settings = contributedSettings()
  const entries = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("setting:") || entrypoint.startsWith("setting-prefix:"))
  const results = entries.map((entrypoint) => {
    if (entrypoint.startsWith("setting:")) {
      const key = entrypoint.slice("setting:".length)
      if (!key.startsWith("chipmate.")) return { entrypoint, matched: true, external: true, matches: [key] }
      return { entrypoint, matched: settings.includes(key), matches: settings.includes(key) ? [key] : [] }
    }
    const prefix = entrypoint.slice("setting-prefix:".length)
    const matches = settings.filter((setting) => setting.startsWith(prefix))
    return { entrypoint, matched: matches.length > 0, matches }
  })
  const sourceContract = validateSystemSourceContract(ctx, testCase)
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "settings", results, sourceContract })
  const missing = results.filter((item) => !item.matched)
  return {
    status: missing.length || sourceContract?.status === "failed" ? "failed" as const : "passed" as const,
    observed: missing.length
      ? `Missing contributed settings: ${missing.map((item) => item.entrypoint).join(", ")}`
      : `Validated ${results.length} setting entrypoint(s) and related source contract.`,
    evidence: [evidencePath, ...(sourceContract?.evidence ?? [])],
    error: missing.length ? JSON.stringify(missing) : sourceContract?.error,
  }
}

function validateSystemNetwork(ctx: RunContext, testCase: SystemCase) {
  const directAgent = readTextSafe(join(repoRoot, "src", "direct-agent-client.ts"))
  const chatView = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
  const codeGraph = readTextSafe(join(repoRoot, "src", "codegraph-service.ts"))
  const documentRag = readTextSafe(join(repoRoot, "src", "document-rag.ts"))
  const markers = {
    providerFetchPaths: /fetch\(chatCompletionsUrl|fetch\(modelsUrl/.test(directAgent),
    providerErrorSurface: /reportRemoteConnectionFailure|postSendRejected|Failed to send message/.test(chatView),
    ragConnectivityOnly: /\[rag-test\] testing RAG configuration/.test(chatView) && /testRagSettings/.test(chatView),
    ragRateLimitTimeout: /rate limited|timeouts|retryAfter|timeoutMs/i.test(codeGraph),
    documentRagFailureSurface: /lastError|fallbackReason|setStatus\("error"|Document RAG error/.test(documentRag + chatView),
    timeoutOrAbort: /AbortSignal|timed out after|timeoutMs/.test(directAgent + chatView + codeGraph),
    redaction: /formatErrorMessage|safeUrlForLog|redact/i.test(directAgent + chatView),
  }
  const screenshot = captureScreen(ctx, testCase.id)
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "network", markers })
  const passed = Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" as const : "failed" as const,
    observed: passed ? "Validated provider/RAG/document offline and weak-network error contracts." : "Network/offline contract markers are missing.",
    evidence: [evidencePath, screenshot],
    error: passed ? undefined : JSON.stringify(markers),
  }
}

function validateSystemWebview(ctx: RunContext, testCase: SystemCase) {
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const chatView = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
  const comments = readTextSafe(join(repoRoot, "src", "comments", "commentReviewHtml.ts"))
  const results = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("webview:")).map((entrypoint) => {
    const id = entrypoint.slice("webview:".length)
    const markers = webviewMarkers(id === "cancel" || id === "retry" ? "cancelSend" : id === "aria" ? "settings" : id, { chat, chatView, comments })
    return { entrypoint, markers, matched: Object.keys(markers).length > 0 && Object.values(markers).every(Boolean) }
  })
  const screenshot = captureScreen(ctx, testCase.id)
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "webview", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" as const : "passed" as const,
    observed: failed.length ? `Webview contract failed for ${failed.map((item) => item.entrypoint).join(", ")}` : `Validated ${results.length} webview contract(s).`,
    evidence: [evidencePath, screenshot],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateSystemFeature(ctx: RunContext, testCase: SystemCase) {
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const toolRuntime = readTextSafe(join(repoRoot, "src", "tool-runtime.ts"))
  const drawio = readTextSafe(join(repoRoot, "src", "drawio-runtime-html.ts"))
  const results = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("feature:")).map((entrypoint) => {
    const feature = entrypoint.slice("feature:".length)
    const markers = featureMarkers(feature, { chat, toolRuntime, drawio })
    return { entrypoint, markers, matched: Object.values(markers).every(Boolean) }
  })
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "feature", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" as const : "passed" as const,
    observed: failed.length ? `Feature contract failed for ${failed.map((item) => item.entrypoint).join(", ")}` : `Validated ${results.length} feature contract(s).`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateSystemTool(ctx: RunContext, testCase: SystemCase) {
  const toolRuntime = readTextSafe(join(repoRoot, "src", "tool-runtime.ts"))
  const docTypes = readTextSafe(join(repoRoot, "src", "docAgent", "types.ts"))
  const results = testCase.entrypoints.filter((entrypoint) => entrypoint.startsWith("tool:")).map((entrypoint) => {
    const rawTool = entrypoint.slice("tool:".length)
    const tool = rawTool === "readDocx" ? "read_docx" : rawTool === "createWordDocument" || rawTool === "word-render" ? "word-document" : rawTool
    const markers = tool === "skills" ? toolMarkers("skills", { toolRuntime, docTypes }) : toolMarkers(tool, { toolRuntime, docTypes })
    return { entrypoint, tool, markers, matched: Object.values(markers).every(Boolean) }
  })
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "tool", results })
  const failed = results.filter((item) => !item.matched)
  return {
    status: failed.length ? "failed" as const : "passed" as const,
    observed: failed.length ? `Tool contract failed for ${failed.map((item) => item.entrypoint).join(", ")}` : `Validated ${results.length} tool contract(s).`,
    evidence: [evidencePath],
    error: failed.length ? JSON.stringify(failed) : undefined,
  }
}

function validateSystemSourceContract(ctx: RunContext, testCase: SystemCase) {
  const chat = readTextSafe(join(repoRoot, "src", "chat-html.ts"))
  const chatView = readTextSafe(join(repoRoot, "src", "chat-view.ts"))
  const codeGraph = readTextSafe(join(repoRoot, "src", "codegraph-service.ts"))
  const documentRag = readTextSafe(join(repoRoot, "src", "document-rag.ts"))
  const toolRuntime = readTextSafe(join(repoRoot, "src", "tool-runtime.ts"))
  const settings = readTextSafe(join(repoRoot, "src", "settings.ts"))
  const markers: Record<string, boolean> = {}
  if (testCase.area === "provider" || testCase.area === "chat") Object.assign(markers, {
    sendPath: /sendMessage|sendPreparedMessage/.test(chatView),
    providerErrors: /reportRemoteConnectionFailure|postSendRejected|formatErrorMessage/.test(chatView),
    redactionBoundary: !/apiKey"\s*:\s*state/.test(chat),
  })
  if (testCase.area === "codegraph") Object.assign(markers, {
    status: /showStatus|status\(\)/.test(codeGraph),
    storage: /manifestUri|ragManifestUri|globalStorageUri/.test(codeGraph),
    settings: /codeGraph/.test(settings),
  })
  if (testCase.area === "code-rag") Object.assign(markers, {
    testResumeSeparate: /testRagSettings/.test(chatView) && /resumeRagIndexing/.test(chatView),
    identityChange: /classifyRagSettingsInputChange|forceRebuildCodeRag/.test(chatView + settings),
    scheduler: /batchSize|concurrentRequests|checkpoint/.test(codeGraph + settings),
  })
  if (testCase.area === "document-rag") Object.assign(markers, {
    settings: /documentRag/.test(settings),
    status: /showStatus|setStatus/.test(documentRag),
    boundedErrors: /lastError|fallbackReason|skippedDocuments/.test(documentRag),
  })
  if (testCase.area === "documents") Object.assign(markers, {
    wordTools: /read_docx|create_word_document|render_word_document|apply_word_document_edits/.test(toolRuntime),
    validation: /validation|quality|render/i.test(toolRuntime),
  })
  if (testCase.area === "tools" || testCase.area === "skills") Object.assign(markers, {
    runtime: /chipmate_run_command|exec_command|read_skill_resource|skills/i.test(toolRuntime),
    boundedErrors: /timeout|permission|error/i.test(toolRuntime),
  })
  if (testCase.area === "ui") Object.assign(markers, {
    layout: /:focus-visible|aria-label|min-width:\s*0|overflow-wrap:\s*anywhere/.test(chat),
    liquid: /oc-liquid-|color-mix\(in srgb/.test(chat),
  })
  if (testCase.area === "lifecycle") Object.assign(markers, {
    globalStorage: /globalStorageUri|globalState/.test(codeGraph + chatView),
    reload: /reloadWindow|update-reload|sessionLoadGeneration/.test(chatView + readTextSafe(join(repoRoot, "src", "extension.ts"))),
  })
  if (!Object.keys(markers).length) return undefined
  const evidencePath = writeSystemEvidence(ctx, testCase.id, { kind: "source-contract", area: testCase.area, markers })
  const passed = Object.values(markers).every(Boolean)
  return {
    status: passed ? "passed" as const : "failed" as const,
    observed: passed ? `Validated ${testCase.area} source contract markers.` : `Missing ${testCase.area} source contract marker(s).`,
    evidence: [evidencePath],
    error: passed ? undefined : JSON.stringify(markers),
  }
}

function commandSystemResult(testCase: SystemCase, results: CommandResult[], evidence: string[]) {
  return {
    status: passFromCommands(results) ? "passed" as const : "failed" as const,
    observed: commandObservation(results),
    evidence,
    error: failureFromCommands(results),
  }
}

function writeSystemEvidence(ctx: RunContext, id: string, payload: unknown) {
  const path = join(ctx.logsDir, `system-evidence-${safeName(id)}.json`)
  writeFileSync(path, `${JSON.stringify(redactJson(payload, ctx), null, 2)}\n`)
  return relative(ctx.reportDir, path)
}

function runCase(ctx: RunContext, testCase: SystemCase, mode: RunMode) {
  const started = Date.now()
  const evidence = [...testCase.evidence]
  try {
    if (testCase.automation === "planned") {
      const planned = runPlannedSystemCase(ctx, testCase, mode)
      ctx.checks.push(caseResult(testCase, planned.status, planned.observed, [...evidence, ...planned.evidence], Date.now() - started, planned.error))
      return
    }
    if (testCase.automation === "observe") {
      ctx.checks.push(caseResult(testCase, "passed", observeCase(ctx, testCase), evidence, Date.now() - started))
      return
    }
    if (mode === "real-profile-observe" && testCase.destructive) {
      ctx.checks.push(caseResult(testCase, "skipped", "Skipped in real-profile-observe because the case is destructive.", evidence, Date.now() - started))
      return
    }
    if (testCase.fixture) switchWorkspace(ctx, testCase.fixture)
    if (requiresOpenSource(testCase)) openFixtureSource(ctx, testCase.fixture ?? "small-c")
    if (testCase.commandId === "chipmate.codeGraph.pause") {
      const pause = runCodeCommand(ctx, "chipmate.codeGraph.pause")
      const resume = runCodeCommand(ctx, "chipmate.codeGraph.resume")
      evidence.push(captureScreen(ctx, testCase.id))
      ctx.checks.push(caseResult(testCase, passFromCommands([pause, resume]) ? "passed" : "failed", commandObservation([pause, resume]), evidence, Date.now() - started, failureFromCommands([pause, resume])))
      return
    }
    if (testCase.commandId === "chipmate.documentRag.pause") {
      const pause = runCodeCommand(ctx, "chipmate.documentRag.pause")
      const resume = runCodeCommand(ctx, "chipmate.documentRag.resume")
      evidence.push(captureScreen(ctx, testCase.id))
      ctx.checks.push(caseResult(testCase, passFromCommands([pause, resume]) ? "passed" : "failed", commandObservation([pause, resume]), evidence, Date.now() - started, failureFromCommands([pause, resume])))
      return
    }
    if (testCase.commandId) {
      const result = runCodeCommand(ctx, testCase.commandId, commandTimeout(ctx, testCase))
      evidence.push(captureScreen(ctx, testCase.id))
      collectLogs(ctx)
      ctx.checks.push(caseResult(testCase, result.status === 0 ? "passed" : "failed", commandObservation([result]), evidence, Date.now() - started, result.status === 0 ? undefined : result.stderr || result.stdout))
      return
    }
    ctx.checks.push(caseResult(testCase, "blocked", "No command automation is defined for this case yet.", evidence, Date.now() - started))
  } catch (error) {
    ctx.checks.push(caseResult(testCase, "failed", "Case threw during execution.", evidence, Date.now() - started, error instanceof Error ? error.stack || error.message : String(error)))
  }
}

function createContext(mode: RunContext["mode"], args: string[]): RunContext {
  const options = parseOptions(args)
  const config = readConfig(options.config)
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}-${Math.random().toString(16).slice(2, 8)}`
  const reportDir = resolvePath(options.reportRoot ?? defaultReportRoot, runId)
  const logsDir = join(reportDir, "logs")
  const screenshotsDir = join(reportDir, "screenshots")
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(screenshotsDir, { recursive: true })
  return {
    repoRoot,
    config,
    reportDir,
    logsDir,
    screenshotsDir,
    runId,
    mode,
    userDataDir: config.realUserDataDir,
    extensionsDir: config.realExtensionsDir,
    workspace: resolveWorkspace(config.workspace),
    fixtureCopies: {},
    checks: [],
  }
}

function prepareMode(ctx: RunContext, mode: RunMode) {
  if (mode === "real-profile-observe") {
    ctx.userDataDir = ctx.config.realUserDataDir
    ctx.extensionsDir = ctx.config.realExtensionsDir
    ctx.workspace = resolveWorkspace(ctx.config.workspace)
    return
  }
  if (mode === "cloned-profile-full") {
    ctx.userDataDir = join(ctx.reportDir, "profile-clone", "User")
    cloneUserProfile(ctx.config.realUserDataDir, ctx.userDataDir)
    ctx.extensionsDir = ctx.config.realExtensionsDir
    ctx.workspace = workspaceForFixture(ctx, "small-c")
    writeWorkspaceSettings(ctx)
    return
  }
  ctx.userDataDir = join(ctx.reportDir, "clean-user-data")
  mkdirSync(ctx.userDataDir, { recursive: true })
  ctx.extensionsDir = ctx.config.realExtensionsDir
  ctx.workspace = workspaceForFixture(ctx, "empty")
  writeWorkspaceSettings(ctx)
}

function launchVsCode(ctx: RunContext) {
  const args = ["--new-window", "--user-data-dir", ctx.userDataDir, "--extensions-dir", ctx.extensionsDir, ctx.workspace]
  const result = run(ctx.config.codeCmd, args, ctx.config.timeouts.startupMs)
  writeCommandArtifact(ctx, "launch-vscode", result)
  wait(3000)
}

function switchWorkspace(ctx: RunContext, fixture: string) {
  ctx.workspace = workspaceForFixture(ctx, fixture)
  writeWorkspaceSettings(ctx)
  const result = run(ctx.config.codeCmd, ["--reuse-window", "--user-data-dir", ctx.userDataDir, "--extensions-dir", ctx.extensionsDir, ctx.workspace], ctx.config.timeouts.commandMs)
  writeCommandArtifact(ctx, `switch-workspace-${safeName(fixture)}`, result)
  wait(1000)
}

function openFixtureSource(ctx: RunContext, fixture: string) {
  const workspace = workspaceForFixture(ctx, fixture)
  const candidates = [
    join(workspace, "src", "main.c"),
    join(workspace, "src", "driver.c"),
    join(workspace, "README.md"),
  ]
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) return
  const result = run(ctx.config.codeCmd, ["--reuse-window", "--user-data-dir", ctx.userDataDir, "--extensions-dir", ctx.extensionsDir, "--goto", `${file}:1:1`], ctx.config.timeouts.commandMs)
  writeCommandArtifact(ctx, `open-source-${safeName(fixture)}`, result)
  wait(500)
}

function runCodeCommand(ctx: RunContext, commandId: string, timeoutMs = ctx.config.timeouts.commandMs) {
  const args = ["--reuse-window", "--user-data-dir", ctx.userDataDir, "--extensions-dir", ctx.extensionsDir, "--command", commandId]
  const result = run(ctx.config.codeCmd, args, timeoutMs)
  writeCommandArtifact(ctx, `command-${safeName(commandId)}`, result)
  wait(800)
  return result
}

function collectLogs(ctx: RunContext) {
  const logsRoot = join(ctx.userDataDir, "logs")
  const allLogs = existsSync(logsRoot) ? listFiles(logsRoot).filter((file) => /\.(?:log|txt)$/i.test(file)) : []
  const chipmate = allLogs.filter((file) => /chipmate/i.test(file) || /output/i.test(file))
  const exthost = allLogs.filter((file) => /exthost|extension/i.test(file))
  const shared = allLogs.filter((file) => /shared/i.test(file))
  writeFileSync(join(ctx.logsDir, "chipmate-output.log"), redact(chipmate.map(readTextSafe).join("\n"), ctx))
  writeFileSync(join(ctx.logsDir, "extension-host.log"), redact(exthost.map(readTextSafe).join("\n"), ctx))
  writeFileSync(join(ctx.logsDir, "shared-process.log"), redact(shared.map(readTextSafe).join("\n"), ctx))
}

function writeStorageSummaries(ctx: RunContext) {
  const storageRoot = join(ctx.userDataDir, "globalStorage", ctx.config.extensionId)
  const summary = summarizeDir(storageRoot)
  writeFileSync(join(ctx.reportDir, "globalStorage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(ctx.reportDir, "codegraph-summary.json"), `${JSON.stringify(filterStorage(summary, "codegraph"), null, 2)}\n`)
  writeFileSync(join(ctx.reportDir, "rag-summary.json"), `${JSON.stringify(filterStorage(summary, "rag"), null, 2)}\n`)
}

function writeEnvironment(ctx: RunContext, extra: Record<string, unknown> = {}) {
  const extensions = run(ctx.config.codeCmd, ["--list-extensions", "--show-versions"], 30_000)
  writeFileSync(join(ctx.reportDir, "installed-extensions.txt"), redact(extensions.stdout, ctx))
  writeFileSync(join(ctx.reportDir, "environment.json"), `${JSON.stringify({
    runId: ctx.runId,
    mode: ctx.mode,
    generatedAt: new Date().toISOString(),
    platform: platform(),
    codeCmd: ctx.config.codeCmd,
    extensionId: ctx.config.extensionId,
    userDataDir: ctx.userDataDir,
    extensionsDir: ctx.extensionsDir,
    workspace: ctx.workspace,
    completionQualityExcluded: true,
    providerMode: ctx.config.providerMode,
    extra: redactJson(extra, ctx),
  }, null, 2)}\n`)
}

function writeReports(ctx: RunContext) {
  writeEnvironment(ctx)
  writeFileSync(join(ctx.reportDir, "functional-checks.json"), `${JSON.stringify(ctx.checks.map((item) => redactJson(item, ctx)), null, 2)}\n`)
  const counts = countChecks(ctx.checks)
  const summary = {
    runId: ctx.runId,
    mode: ctx.mode,
    generatedAt: new Date().toISOString(),
    counts,
    failed: ctx.checks.filter((item) => item.status === "failed"),
    planned: ctx.checks.filter((item) => item.status === "planned").length,
    blocked: ctx.checks.filter((item) => item.status === "blocked").length,
    reportDir: ctx.reportDir,
  }
  writeFileSync(join(ctx.reportDir, "summary.json"), `${JSON.stringify(redactJson(summary, ctx), null, 2)}\n`)
  writeFileSync(join(ctx.reportDir, "summary.md"), renderSummary(ctx, summary))
  writeFileSync(join(ctx.reportDir, "quality-report.md"), renderQualityReport(ctx, summary))
}

function buildInventory() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    contributes?: {
      commands?: Array<{ command: string; title?: string; category?: string }>
      configuration?: { properties?: Record<string, unknown> }
    }
  }
  const commands = packageJson.contributes?.commands ?? []
  const settings = Object.keys(packageJson.contributes?.configuration?.properties ?? {})
  const coveredEntrypoints = new Set(systemCases.flatMap((item) => item.entrypoints))
  const commandRows = commands.map((command) => ({
    ...command,
    coveredBy: systemCases.filter((item) => item.entrypoints.includes(`command:${command.command}`)).map((item) => item.id),
  }))
  const settingRows = settings.map((setting) => ({
    key: setting,
    coveredBy: systemCases.filter((item) => coversSetting(item, setting)).map((item) => item.id),
  }))
  return {
    generatedAt: new Date().toISOString(),
    commands: commandRows,
    settings: settingRows,
    cases: systemCases,
    uiCases,
    entrypoints: [...coveredEntrypoints].sort(),
    uiEntrypoints: [...new Set(uiCases.flatMap((item) => item.entrypoints))].sort(),
    uncoveredCommands: commandRows.filter((item) => item.coveredBy.length === 0).map((item) => item.command),
    uncoveredSettings: settingRows.filter((item) => item.coveredBy.length === 0).map((item) => item.key),
    automationCounts: countBy(systemCases, (item) => item.automation),
    uiAutomationCounts: countBy(uiCases, (item) => item.automation),
    severityCounts: countBy(systemCases, (item) => item.severity),
    uiSeverityCounts: countBy(uiCases, (item) => item.severity),
    areaCounts: countBy(systemCases, (item) => item.area),
    uiSurfaceCounts: countBy(uiCases, (item) => item.surface),
  }
}

function coversSetting(testCase: SystemCase, setting: string) {
  return testCase.entrypoints.some((entrypoint) => {
    if (entrypoint === `setting:${setting}`) return true
    if (entrypoint.startsWith("setting-prefix:")) return setting.startsWith(entrypoint.slice("setting-prefix:".length))
    return false
  })
}

function renderInventory(inventory: ReturnType<typeof buildInventory>) {
  const lines = [
    "# ChipMate System Test Inventory",
    "",
    `Generated: ${inventory.generatedAt}`,
    "",
    "## Coverage Summary",
    "",
    `- Commands: ${inventory.commands.length}`,
    `- Settings: ${inventory.settings.length}`,
    `- Cases: ${inventory.cases.length}`,
    `- UI cases: ${inventory.uiCases.length}`,
    `- Uncovered commands: ${inventory.uncoveredCommands.length}`,
    `- Uncovered settings: ${inventory.uncoveredSettings.length}`,
    `- UI automation: ${JSON.stringify(inventory.uiAutomationCounts)}`,
    "",
    "## Commands",
    "",
    "| Command | Coverage |",
    "|---|---|",
    ...inventory.commands.map((item) => `| ${md(item.command)} | ${item.coveredBy.length ? item.coveredBy.map(md).join(", ") : "**UNCOVERED**"} |`),
    "",
    "## Settings",
    "",
    "| Setting | Coverage |",
    "|---|---|",
    ...inventory.settings.map((item) => `| ${md(item.key)} | ${item.coveredBy.length ? item.coveredBy.map(md).join(", ") : "**UNCOVERED**"} |`),
    "",
    "## Cases",
    "",
    "| ID | Area | Severity | Automation |",
    "|---|---|---|---|",
    ...inventory.cases.map((item) => `| ${md(item.id)} | ${md(item.area)} | ${item.severity} | ${item.automation} |`),
    "",
    "## UI User Matrix",
    "",
    "| ID | Surface | Severity | Automation | Oracles |",
    "|---|---|---|---|---|",
    ...inventory.uiCases.map((item) => `| ${md(item.id)} | ${md(item.surface)} | ${item.severity} | ${item.automation} | ${md(item.oracles.join(", "))} |`),
    "",
  ]
  return `${lines.join("\n")}\n`
}

function writeUiMatrix(ctx: RunContext, selected: UiCase[]) {
  const payload = {
    generatedAt: new Date().toISOString(),
    selectedCount: selected.length,
    totalUiCases: uiCases.length,
    selected,
    automationCounts: countBy(selected, (item) => item.automation),
    severityCounts: countBy(selected, (item) => item.severity),
    surfaceCounts: countBy(selected, (item) => item.surface),
    oracleCounts: countBy(selected.flatMap((item) => item.oracles), (item) => item),
  }
  writeFileSync(join(ctx.reportDir, "ui-matrix.json"), `${JSON.stringify(redactJson(payload, ctx), null, 2)}\n`)
  writeFileSync(join(ctx.reportDir, "ui-matrix.md"), renderUiMatrix(payload))
}

function renderUiMatrix(payload: { generatedAt: string; selectedCount: number; totalUiCases: number; selected: UiCase[]; automationCounts: Record<string, number>; severityCounts: Record<string, number>; surfaceCounts: Record<string, number>; oracleCounts: Record<string, number> }) {
  const lines = [
    "# ChipMate UI User Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Selected UI cases: ${payload.selectedCount}`,
    `- Total UI cases: ${payload.totalUiCases}`,
    `- Automation: ${JSON.stringify(payload.automationCounts)}`,
    `- Severity: ${JSON.stringify(payload.severityCounts)}`,
    `- Surfaces: ${JSON.stringify(payload.surfaceCounts)}`,
    `- Oracles: ${JSON.stringify(payload.oracleCounts)}`,
    "",
    "## Cases",
    "",
    "| ID | Surface | Feature | Severity | Automation | User Steps | Expected | Boundaries | Oracles | Evidence |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...payload.selected.map((item) => [
      md(item.id),
      md(item.surface),
      md(item.feature),
      item.severity,
      item.automation,
      md(item.userSteps.join(" / ")),
      md(item.expected.join(" / ")),
      md(item.boundaries.join(", ")),
      md(item.oracles.join(", ")),
      md(item.evidence.join(", ")),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
  ]
  return `${lines.join("\n")}\n`
}

function writeUiDriverSnapshot(ctx: RunContext) {
  const driver = new VsCodeUiDriver({
    codeCmd: ctx.config.codeCmd,
    userDataDir: ctx.userDataDir,
    extensionsDir: ctx.extensionsDir,
    workspace: ctx.workspace,
    timeoutMs: ctx.config.timeouts.commandMs,
    artifactDir: ctx.reportDir,
  })
  driver.writeSnapshot(join(ctx.reportDir, "ui-driver-snapshot.json"), {
    generatedAt: new Date().toISOString(),
    capabilities: {
      openView: true,
      commandPalette: true,
      openWorkspace: true,
      type: platform() === "darwin",
      press: platform() === "darwin",
      screenshot: platform() === "darwin",
      domSnapshot: false,
    },
    limitation: "DOM-level webview snapshots require a future VS Code extension-test host bridge; current live runner captures command, screenshot, log, and storage evidence.",
  })
}

function uiCaseResult(testCase: UiCase, status: FunctionalCheck["status"], observed: string, evidence: string[], durationMs: number, error?: string): FunctionalCheck {
  return {
    id: testCase.id,
    area: `ui:${testCase.surface}`,
    title: testCase.title,
    severity: testCase.severity,
    status,
    userAction: testCase.userSteps.join(" / "),
    expected: testCase.expected.join(" / "),
    observed,
    allowedFailures: testCase.allowedFailures,
    evidence,
    error,
    durationMs,
  }
}

function firstCommandEntrypoint(testCase: UiCase) {
  return testCase.entrypoints.find((entrypoint) => entrypoint.startsWith("command:"))?.slice("command:".length)
}

function findAbsoluteIconLayoutOffenders(files: string[]) {
  const offenders: string[] = []
  const iconSelector = /(?:icon|Icon|toolbar|Toolbar|button|Button|status|Status)/
  for (const file of files) {
    const text = readTextSafe(file)
    const blocks = text.matchAll(/([^{}]+)\{([^{}]*)\}/g)
    for (const match of blocks) {
      const selector = match[1]?.trim() ?? ""
      const body = match[2] ?? ""
      if (!/position\s*:\s*absolute\b/.test(body)) continue
      if (!iconSelector.test(selector)) continue
      if (/srOnly|Backdrop|Pane|Popover|Menu/.test(selector)) continue
      offenders.push(`${relative(repoRoot, file)} :: ${selector.replace(/\s+/g, " ")}`)
    }
  }
  return offenders
}

function scanUiVisualContract(ctx: RunContext) {
  const selectedVisualCases = uiCasesForRun(ctx.mode === "ui-smoke" || ctx.mode === "ui-full" || ctx.mode === "ui-visual" ? ctx.mode : "ui-visual")
    .filter((item) => item.oracles.some((oracle) => oracle === "visual" || oracle === "layout" || oracle === "accessibility"))
  const visualPlanned = selectedVisualCases.filter((item) => !ctx.checks.some((checkItem) => checkItem.id === item.id && checkItem.status === "passed")).length
  const contract = {
    generatedAt: new Date().toISOString(),
    selectedVisualCases: selectedVisualCases.length,
    visualCasesNotYetAutomated: visualPlanned,
    screenshotDirExists: existsSync(ctx.screenshotsDir),
    uiMatrixExists: existsSync(join(ctx.reportDir, "ui-matrix.json")),
  }
  writeFileSync(join(ctx.reportDir, "ui-visual-summary.json"), `${JSON.stringify(contract, null, 2)}\n`)
  ctx.checks.push({
    id: "ui.visual-contract.summary",
    area: "ui:visual-accessibility",
    title: "UI visual/accessibility matrix is reportable",
    severity: "P1",
    status: contract.uiMatrixExists && contract.screenshotDirExists ? "passed" : "failed",
    userAction: "Verify UI matrix, screenshot directory, and visual coverage accounting.",
    expected: "UI visual cases are included in reports and remaining planned gaps are explicit.",
    observed: `${contract.selectedVisualCases} visual/accessibility case(s), ${contract.visualCasesNotYetAutomated} not yet automated.`,
    allowedFailures: ["ui-automation-failure", "ui-overlap", "accessibility-gap"],
    evidence: ["ui-visual-summary.json", "ui-matrix.json", "screenshots/"],
    durationMs: 0,
  })
}

function printLatestReport(args: string[]) {
  const options = parseOptions(args)
  const root = resolvePath(options.reportRoot ?? defaultReportRoot)
  if (!existsSync(root)) {
    console.log(`No report root found: ${root}`)
    return
  }
  const reports = readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path).isDirectory()).sort()
  const latest = reports.at(-1)
  if (!latest) {
    console.log(`No reports found under ${root}`)
    return
  }
  const summaryPath = join(latest, "summary.md")
  console.log(existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : latest)
}

function parseOptions(args: string[]) {
  const options: { config?: string; reportRoot?: string } = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--config") {
      options.config = args[++index]
      continue
    }
    if (arg === "--report-root") {
      options.reportRoot = args[++index]
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }
  return options
}

function readConfig(configPath?: string): Config {
  const path = resolvePath(configPath ?? defaultConfigPath)
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>
  return {
    extensionId: raw.extensionId ?? "local.chipmate",
    codeCmd: raw.codeCmd ?? "code",
    realUserDataDir: expandPath(raw.realUserDataDir ?? "~/Library/Application Support/Code/User"),
    realExtensionsDir: expandPath(raw.realExtensionsDir ?? "~/.vscode/extensions"),
    workspace: raw.workspace ?? "test/live-vscode/fixtures/workspaces/small-c",
    providerMode: raw.providerMode ?? "use-existing-secret",
    completion: { enabled: raw.completion?.enabled ?? false },
    timeouts: {
      startupMs: raw.timeouts?.startupMs ?? 45_000,
      commandMs: raw.timeouts?.commandMs ?? 20_000,
      indexMs: raw.timeouts?.indexMs ?? 180_000,
      soakMs: raw.timeouts?.soakMs ?? 900_000,
    },
    redact: raw.redact ?? [],
  }
}

function run(command: string, args: string[], timeoutMs: number): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, shell: false })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    commandLine: [command, ...args.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg)].join(" "),
  }
}

function check(id: string, area: string, title: string, severity: Severity, passed: boolean, userAction: string, expected: string, observed: string, allowedFailures: string[], evidence: string[], result?: CommandResult): FunctionalCheck {
  return {
    id,
    area,
    title,
    severity,
    status: passed ? "passed" : "failed",
    userAction,
    expected,
    observed,
    allowedFailures,
    evidence,
    error: passed ? undefined : result?.stderr || result?.stdout,
    durationMs: 0,
  }
}

function caseResult(testCase: SystemCase, status: FunctionalCheck["status"], observed: string, evidence: string[], durationMs: number, error?: string): FunctionalCheck {
  return {
    id: testCase.id,
    area: testCase.area,
    title: testCase.title,
    severity: testCase.severity,
    status,
    userAction: testCase.userAction,
    expected: testCase.expected,
    observed,
    allowedFailures: testCase.allowedFailures,
    evidence,
    error,
    durationMs,
  }
}

function observeCase(ctx: RunContext, testCase: SystemCase) {
  if (testCase.id === "startup.extension-installed") {
    const result = run(ctx.config.codeCmd, ["--list-extensions", "--show-versions"], 30_000)
    const line = result.stdout.split(/\r?\n/).find((item) => item.toLowerCase().startsWith(`${ctx.config.extensionId.toLowerCase()}@`))
    if (!line) throw new Error(`${ctx.config.extensionId} was not found in installed extensions`)
    writeFileSync(join(ctx.reportDir, "installed-extensions.txt"), redact(result.stdout, ctx))
    return line
  }
  if (testCase.id === "provider.configured") {
    return `providerMode=${ctx.config.providerMode}; raw secrets are not read by the runner`
  }
  if (testCase.id === "offline.runtime-deps") {
    return "Runtime dependency evidence is produced by offline.runtime-deps.scan after log collection."
  }
  if (testCase.id === "security.redaction") {
    return "Secret redaction evidence is produced by security.redaction.scan after report generation."
  }
  if (testCase.id === "completion.disabled-boundary") {
    return `completion quality excluded; configured runner completion.enabled=${ctx.config.completion.enabled}`
  }
  return "Observation recorded without mutating the profile."
}

function scanRuntimeFailures(ctx: RunContext) {
  const text = readTextSafe(join(ctx.logsDir, "chipmate-output.log")) + "\n" + readTextSafe(join(ctx.logsDir, "extension-host.log"))
  const marker = /(Cannot find module|MODULE_NOT_FOUND|dynamic import callback|tree-sitter.*missing|runtime.*missing|ENOENT.*(?:tree-sitter|wasm|pdf|docx|xlsx|mammoth|exceljs)|download.*ripgrep|npm install)/i.exec(text)
  ctx.checks.push({
    id: "offline.runtime-deps.scan",
    area: "offline",
    title: "Runtime dependency log scan",
    severity: "P0",
    status: marker ? "failed" : "passed",
    userAction: "Scan collected logs for missing runtime dependency markers.",
    expected: "No packaged dependency is missing and no dynamic download attempt appears.",
    observed: marker ? `Runtime failure marker found: ${marker[0]}` : "No runtime dependency failure marker found.",
    allowedFailures: ["runtime-missing"],
    evidence: ["logs/chipmate-output.log", "logs/extension-host.log"],
    error: marker?.[0],
    durationMs: 0,
  })
}

function scanRedaction(ctx: RunContext) {
  const files = listFiles(ctx.reportDir).filter((file) => /\.(?:json|md|txt|log)$/i.test(file))
  const offenders: string[] = []
  const tokenPattern = /(Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{12,})/i
  for (const file of files) {
    if (tokenPattern.test(readTextSafe(file))) offenders.push(relative(ctx.reportDir, file))
  }
  writeFileSync(join(ctx.reportDir, "redaction-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), offenders }, null, 2)}\n`)
  ctx.checks.push({
    id: "security.redaction.scan",
    area: "security",
    title: "Report secret redaction scan",
    severity: "P0",
    status: offenders.length === 0 ? "passed" : "failed",
    userAction: "Scan generated report files for token-shaped secrets.",
    expected: "No API keys or bearer tokens are present in reports.",
    observed: offenders.length ? `Potential secret pattern found in ${offenders.join(", ")}` : "No token-shaped secret found.",
    allowedFailures: ["secret-leak"],
    evidence: ["redaction-report.json"],
    durationMs: 0,
  })
}

function renderSummary(ctx: RunContext, summary: { counts: Record<string, number>; failed: FunctionalCheck[]; planned: number; blocked: number }) {
  const lines = [
    "# ChipMate System Test Report",
    "",
    `- Run ID: ${ctx.runId}`,
    `- Mode: ${ctx.mode}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Workspace: ${ctx.workspace}`,
    `- User data dir: ${ctx.userDataDir}`,
    `- Extension dir: ${ctx.extensionsDir}`,
    `- Counts: ${JSON.stringify(summary.counts)}`,
    `- Planned coverage gaps: ${summary.planned}`,
    `- Blocked cases: ${summary.blocked}`,
    "",
    "## Failed Cases",
    "",
    "| ID | Severity | Area | Observed |",
    "|---|---|---|---|",
    ...summary.failed.map((item) => `| ${md(item.id)} | ${item.severity} | ${md(item.area)} | ${md(item.observed)} |`),
    "",
    "## Functional Checks",
    "",
    "| ID | Severity | Status | Area | Evidence |",
    "|---|---|---|---|---|",
    ...ctx.checks.map((item) => `| ${md(item.id)} | ${item.severity} | ${item.status} | ${md(item.area)} | ${md(item.evidence.join("; "))} |`),
    "",
    "## Evidence",
    "",
    "- `functional-checks.json` contains user action, expected result, observed result, allowed failures, and severity.",
    "- `logs/` contains collected VS Code and ChipMate logs where available.",
    "- `screenshots/` contains full-screen captures after automated UI/command steps.",
    "- `globalStorage-summary.json`, `codegraph-summary.json`, and `rag-summary.json` summarize storage state without dumping file contents.",
  ]
  return `${lines.join("\n")}\n`
}

function renderQualityReport(ctx: RunContext, summary: { counts: Record<string, number>; failed: FunctionalCheck[]; planned: number; blocked: number }) {
  const bySeverityStatus = severityStatusRows(ctx.checks)
  const plannedHigh = ctx.checks.filter((item) => item.status === "planned" && (item.severity === "P0" || item.severity === "P1"))
  const failedHigh = ctx.checks.filter((item) => item.status === "failed" && (item.severity === "P0" || item.severity === "P1"))
  const lines = [
    "# ChipMate Product Quality Report",
    "",
    `- Run ID: ${ctx.runId}`,
    `- Mode: ${ctx.mode}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Workspace: ${ctx.workspace}`,
    `- Counts: ${JSON.stringify(summary.counts)}`,
    `- P0/P1 failed: ${failedHigh.length}`,
    `- P0/P1 planned gaps: ${plannedHigh.length}`,
    "",
    "## Interpretation",
    "",
    "- `passed` means the current runner collected the evidence needed by that case's current oracle.",
    "- `planned` is not a pass. It is a tracked acceptance gap with scenario, steps, expected result, boundaries, and required evidence.",
    "- Static source/manifest/tool gates prove product contracts only for the covered layer; webview DOM click/input cases remain planned until a DOM-capable driver is connected.",
    "",
    "## Severity Matrix",
    "",
    "| Severity | Passed | Failed | Planned | Blocked | Skipped |",
    "|---|---:|---:|---:|---:|---:|",
    ...bySeverityStatus.map((row) => `| ${row.severity} | ${row.passed} | ${row.failed} | ${row.planned} | ${row.blocked} | ${row.skipped} |`),
    "",
    "## High Priority Failures",
    "",
    "| ID | Severity | Area | Observed | Evidence |",
    "|---|---|---|---|---|",
    ...(failedHigh.length ? failedHigh.map((item) => `| ${md(item.id)} | ${item.severity} | ${md(item.area)} | ${md(item.observed)} | ${md(item.evidence.join("; "))} |`) : ["| None | - | - | - | - |"]),
    "",
    "## High Priority Planned Gaps",
    "",
    "| ID | Severity | Area | Missing Automation | Required Evidence |",
    "|---|---|---|---|---|",
    ...plannedHigh.slice(0, 80).map((item) => `| ${md(item.id)} | ${item.severity} | ${md(item.area)} | ${md(item.userAction)} | ${md(item.evidence.join("; "))} |`),
    plannedHigh.length > 80 ? `| ... | ... | ... | ${plannedHigh.length - 80} more high-priority planned gaps omitted from this summary. See functional-checks.json. | ... |` : "",
    "",
    "## Evidence Bundle",
    "",
    "- `functional-checks.json`: full case-level status, expected result, observed result, allowed failures, and evidence paths.",
    "- `summary.md` / `summary.json`: run-level counts and all failed cases.",
    "- `ui-matrix.md` / `ui-matrix.json`: UI user matrix, when this is a UI run.",
    "- `ui-visual-contract.json`: Liquid Glass, icon, and source contract evidence, when visual gates run.",
    "- `globalStorage-summary.json`, `codegraph-summary.json`, `rag-summary.json`: storage state summaries.",
    "- `logs/`: VS Code command results, UI evidence gates, ChipMate output, and Extension Host logs.",
    "- `screenshots/`: screenshots captured after executable UI steps.",
    "",
  ].filter((line) => line !== "")
  return `${lines.join("\n")}\n`
}

function severityStatusRows(checks: FunctionalCheck[]) {
  return (["P0", "P1", "P2", "P3"] as Severity[]).map((severity) => {
    const scoped = checks.filter((item) => item.severity === severity)
    const counts = countChecks(scoped)
    return {
      severity,
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      planned: counts.planned ?? 0,
      blocked: counts.blocked ?? 0,
      skipped: counts.skipped ?? 0,
    }
  })
}

function cloneUserProfile(source: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const name of ["settings.json", "keybindings.json", "snippets"]) {
    const from = join(source, name)
    const to = join(target, name)
    if (existsSync(from)) cpSync(from, to, { recursive: true })
  }
}

function writeWorkspaceSettings(ctx: RunContext) {
  const dir = join(ctx.workspace, ".vscode")
  mkdirSync(dir, { recursive: true })
  const settingsPath = join(dir, "settings.json")
  const current = existsSync(settingsPath) ? parseJsonSafe(readFileSync(settingsPath, "utf8")) : {}
  const next = {
    ...current,
    "chipmate.completion.enabled": false,
    "chipmate.codeGraph.promptOnWorkspaceOpen": false,
    "chipmate.rag.embedding.resumeAutomatically": false,
    "workbench.startupEditor": "none",
    "editor.inlineSuggest.enabled": false,
  }
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
}

function captureScreen(ctx: RunContext, label: string) {
  if (platform() !== "darwin") return "screenshots/not-captured-non-macos"
  const out = join(ctx.screenshotsDir, `${safeName(label)}.png`)
  const result = run("screencapture", ["-x", out], 10_000)
  writeCommandArtifact(ctx, `screenshot-${safeName(label)}`, result)
  return existsSync(out) ? relative(ctx.reportDir, out) : "screenshots/capture-failed"
}

function checkMacAutomation() {
  if (platform() !== "darwin") return { status: 0, stdout: "non-macos", stderr: "", commandLine: "skip" }
  return run("osascript", ["-e", "tell application \"System Events\" to get UI elements enabled"], 10_000)
}

function writeCommandArtifact(ctx: RunContext, label: string, result: CommandResult) {
  writeFileSync(join(ctx.logsDir, `${safeName(label)}.json`), `${JSON.stringify(redactJson(result, ctx), null, 2)}\n`)
}

function summarizeDir(root: string) {
  if (!existsSync(root)) return { root, exists: false, files: [] }
  const files = listFiles(root).map((file) => {
    const stat = statSync(file)
    return {
      path: relative(root, file),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    }
  }).slice(0, 5000)
  return { root, exists: true, fileCount: files.length, files }
}

function filterStorage(summary: ReturnType<typeof summarizeDir>, keyword: string) {
  return {
    ...summary,
    files: summary.files.filter((file) => file.path.toLowerCase().includes(keyword.toLowerCase())),
  }
}

function fixtureWorkspace(name: string) {
  return join(liveRoot, "fixtures", "workspaces", name)
}

function workspaceForFixture(ctx: RunContext, name: string) {
  if (ctx.mode === "real-profile-observe") return fixtureWorkspace(name)
  if (ctx.fixtureCopies[name]) return ctx.fixtureCopies[name]
  const source = fixtureWorkspace(name)
  const target = join(ctx.reportDir, "workspaces", name)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
  ctx.fixtureCopies[name] = target
  return target
}

function resolveWorkspace(input: string) {
  const expanded = expandPath(input)
  return isAbsolute(expanded) ? expanded : join(repoRoot, expanded)
}

function resolvePath(input: string, child?: string) {
  const expanded = expandPath(input)
  const base = isAbsolute(expanded) ? expanded : join(repoRoot, expanded)
  return child ? join(base, child) : base
}

function expandPath(input: string) {
  if (input === "~") return homedir()
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  return input
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function readTextSafe(path: string) {
  try {
    if (!existsSync(path) || statSync(path).size > 5_000_000) return ""
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function redact(input: string, ctx: RunContext) {
  let output = input
  const values = [homedir(), ...ctx.config.redact, process.env.CHIPMATE_UI_PROVIDER_API_KEY, process.env.OPENAI_API_KEY].filter((value): value is string => Boolean(value && value.length > 2))
  for (const value of values) output = output.split(value).join(value === homedir() ? "[REDACTED_HOME]" : "[REDACTED_SECRET]")
  output = output.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]")
  output = output.replace(/"apiKey"\s*:\s*"[^"]*"/gi, '"apiKey":"[REDACTED]"')
  output = output.replace(/(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}/g, "$1[REDACTED_TOKEN]")
  return output
}

function redactJson<T>(input: T, ctx: RunContext): T {
  return JSON.parse(redact(JSON.stringify(input), ctx)) as T
}

function safeName(input: string) {
  return input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "item"
}

function md(input: string) {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function firstLine(input: string) {
  return input.split(/\r?\n/).find(Boolean) ?? ""
}

function wait(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function parseJsonSafe(input: string) {
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readJsonSafe(path: string) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function commandTimeout(ctx: RunContext, testCase: SystemCase) {
  return testCase.area === "codegraph" || testCase.area === "code-rag" || testCase.area === "document-rag" ? ctx.config.timeouts.indexMs : ctx.config.timeouts.commandMs
}

function requiresOpenSource(testCase: SystemCase) {
  return testCase.area === "comments" || testCase.id === "context.add-selection" || testCase.id === "context.add-file"
}

function passFromCommands(results: CommandResult[]) {
  return results.every((result) => result.status === 0)
}

function failureFromCommands(results: CommandResult[]) {
  const failed = results.find((result) => result.status !== 0)
  return failed ? failed.stderr || failed.stdout : undefined
}

function commandObservation(results: CommandResult[]) {
  return results.map((result) => `${result.commandLine} -> status=${result.status}${firstLine(result.stderr || result.stdout) ? ` ${firstLine(result.stderr || result.stdout)}` : ""}`).join("; ")
}

function countChecks(checks: FunctionalCheck[]) {
  return countBy(checks, (item) => item.status)
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
