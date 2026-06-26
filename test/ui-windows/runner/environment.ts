import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { hostname, userInfo } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { TestConfig } from "./config.js"
import { redact } from "./report.js"

export type RunContext = {
  bundleRoot: string
  config: TestConfig
  configuredCodeCmd: string
  effectiveCodeCmd?: string
  effectiveCodeCmdStrategy?: CommandInvocationStrategy
  vscodeDiscovery?: VsCodeDiscoveryReport
  workspace: string
  runId: string
  workRoot: string
  userDataDir: string
  extensionsDir: string
  reportDir: string
  logsDir: string
  screenshotsDir: string
  mode: string
  installedExtensionVersion?: string
  preLaunchWindows?: WindowCandidate[]
  targetWindow?: WindowCandidate
  windowSelection?: WindowSelectionReport
  uiSteps: UiStepReport[]
  functionalChecks: FunctionalCheckReport[]
}

export type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
  commandLine: string
  strategy: CommandInvocationStrategy
  windowsVerbatimArguments?: boolean
}

type CommandInvocationStrategy = "direct" | "cmd-call-verbatim" | "powershell-call"

type CommandInvocation = {
  command: string
  args: string[]
  commandLine: string
  strategy: CommandInvocationStrategy
  windowsVerbatimArguments?: boolean
}

export type WindowCandidate = {
  hwnd: string
  pid: number
  processName: string
  processPath: string
  windowTitle: string
  isNew?: boolean
  requiredMatch?: boolean
  score?: number
  reasons?: string[]
}

export type UiStepReport = {
  step: string
  commandLabel?: string
  inputLabel?: string
  status: "started" | "passed" | "failed"
  startedAt: string
  completedAt?: string
  targetWindow?: WindowCandidate
  foreground?: ForegroundWindowInfo
  screenshots?: Record<string, string>
  automation?: Record<string, unknown>
  error?: string
}

export type FunctionalCheckStatus = "passed" | "failed" | "skipped"

export type FunctionalCheckReport = {
  area: string
  intent: string
  userAction: string
  expected: string
  observed: string
  evidence: string[]
  status: FunctionalCheckStatus
  error?: string
  generatedAt: string
}

export type VsCodeDiscoveryReport = {
  configuredCodeCmd: string
  effectiveCodeCmd?: string
  effectiveCodeCmdStrategy?: CommandInvocationStrategy
  status: "selected" | "not-found"
  reason: string
  candidates: VsCodeCliCandidate[]
  whereDiagnostics: Array<{
    name: string
    commandLine: string
    status: number | null
    stdout: string
    stderr: string
  }>
  generatedAt: string
}

type VsCodeCliCandidate = {
  source: string
  path: string
  exists?: boolean
  status?: number | null
  commandLine?: string
  strategy?: CommandInvocationStrategy
  windowsVerbatimArguments?: boolean
  stdout?: string
  stderr?: string
  selected?: boolean
  attempts?: Array<{
    strategy: CommandInvocationStrategy
    windowsVerbatimArguments?: boolean
    status: number | null
    commandLine: string
    stdout: string
    stderr: string
  }>
}

type ForegroundWindowInfo = {
  hwnd: string
  pid: number
  processName: string
  windowTitle: string
}

type WindowSelectionReport = {
  selected?: WindowCandidate
  status: "selected" | "ambiguous" | "not-found"
  reason: string
  beforeLaunch: WindowCandidate[]
  candidates: WindowCandidate[]
  generatedAt: string
  diagnostics?: Record<string, unknown>
}

export async function createRunContext(input: {
  bundleRoot: string
  config: TestConfig
  workspace: string
  reportRoot: string
  mode: string
}): Promise<RunContext> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`
  const reportDir = resolve(input.reportRoot, runId)
  const workRoot = join(reportDir, "work")
  const userDataDir = input.config.realUserDataDir
  const extensionsDir = input.config.realExtensionsDir ?? ""
  const logsDir = join(reportDir, "logs")
  const screenshotsDir = join(reportDir, "screenshots")
  await mkdir(logsDir, { recursive: true })
  await mkdir(screenshotsDir, { recursive: true })
  await mkdir(workRoot, { recursive: true })
  if (!input.config.windowActivation.workspaceTitleHint) {
    input.config.windowActivation.workspaceTitleHint = basename(input.workspace)
  }
  const ctx: RunContext = {
    bundleRoot: input.bundleRoot,
    config: input.config,
    configuredCodeCmd: input.config.codeCmd,
    workspace: input.workspace,
    runId,
    workRoot,
    userDataDir,
    extensionsDir,
    reportDir,
    logsDir,
    screenshotsDir,
    mode: input.mode,
    uiSteps: [],
    functionalChecks: [],
  }
  await writeWindowCandidates(ctx, {
    status: "not-found",
    reason: "window discovery not started",
    beforeLaunch: [],
    candidates: [],
    generatedAt: new Date().toISOString(),
  })
  await writeUiSteps(ctx)
  await writeFunctionalChecks(ctx)
  await discoverVsCodeCli(ctx)
  return ctx
}

export function runCommand(command: string, args: string[], timeoutMs = 60_000, strategy?: CommandInvocationStrategy): CommandResult {
  const invocation = commandInvocation(command, args, strategy)
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    commandLine: invocation.commandLine,
    strategy: invocation.strategy,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }
}

export function runCode(ctx: RunContext, args: string[], timeoutMs = 60_000): CommandResult {
  const command = ctx.effectiveCodeCmd
  if (!command) {
    return {
      status: 1,
      stdout: "",
      stderr: "VS Code CLI discovery failed. See vscode-discovery.json for configured path, candidates, and validation errors.",
      commandLine: "VS Code CLI discovery",
      strategy: "direct",
      windowsVerbatimArguments: undefined,
    }
  }
  return runCommand(command, args, timeoutMs, ctx.effectiveCodeCmdStrategy)
}

async function discoverVsCodeCli(ctx: RunContext) {
  const configuredCodeCmd = ctx.configuredCodeCmd
  const candidates = collectVsCodeCliCandidates(configuredCodeCmd)
  const whereDiagnostics = collectWhereDiagnostics(candidates)
  const selected = candidates.find((candidate) => candidate.selected)
  const report: VsCodeDiscoveryReport = {
    configuredCodeCmd,
    effectiveCodeCmd: selected?.path,
    effectiveCodeCmdStrategy: selected?.strategy,
    status: selected ? "selected" : "not-found",
    reason: selected
      ? `selected ${selected.path} from ${selected.source}`
      : "no VS Code CLI candidate responded successfully to --version",
    candidates,
    whereDiagnostics,
    generatedAt: new Date().toISOString(),
  }
  ctx.effectiveCodeCmd = selected?.path
  ctx.effectiveCodeCmdStrategy = selected?.strategy
  ctx.vscodeDiscovery = report
  await writeVsCodeDiscovery(ctx)
}

function collectVsCodeCliCandidates(configuredCodeCmd: string) {
  const candidates: VsCodeCliCandidate[] = []
  const configured = configuredCodeCmd.trim()
  if (configured && configured.toLowerCase() !== "auto") {
    candidates.push({ source: "configured codeCmd", path: configured })
  }

  candidates.push(...whereVsCodeCliCandidates("code.cmd"))
  candidates.push(...whereVsCodeCliCandidates("code"))
  candidates.push(...standardVsCodeCliCandidates())

  const deduped = dedupeVsCodeCandidates(candidates)
  for (const candidate of deduped) {
    validateVsCodeCandidate(candidate)
    if (candidate.status === 0) {
      candidate.selected = true
      break
    }
  }
  return deduped
}

function collectWhereDiagnostics(candidates: VsCodeCliCandidate[]) {
  return candidates
    .filter((candidate) => candidate.source.startsWith("where.exe "))
    .map((candidate) => ({
      name: candidate.source.slice("where.exe ".length),
      commandLine: `where.exe ${candidate.source.slice("where.exe ".length)}`,
      status: undefined as number | null | undefined,
      stdout: candidate.path,
      stderr: "",
    }))
    .map((item) => ({
      ...item,
      status: item.status ?? 0,
    }))
}

function whereVsCodeCliCandidates(name: "code.cmd" | "code") {
  const result = runCommand("where.exe", [name], 10_000)
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ source: `where.exe ${name}`, path }))
}

function standardVsCodeCliCandidates() {
  const candidates: VsCodeCliCandidate[] = []
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env["ProgramFiles(x86)"]
  if (localAppData) candidates.push({ source: "%LOCALAPPDATA%", path: join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd") })
  if (programFiles) candidates.push({ source: "%ProgramFiles%", path: join(programFiles, "Microsoft VS Code", "bin", "code.cmd") })
  if (programFilesX86) candidates.push({ source: "%ProgramFiles(x86)%", path: join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd") })
  return candidates
}

function dedupeVsCodeCandidates(candidates: VsCodeCliCandidate[]) {
  const seen = new Set<string>()
  const result: VsCodeCliCandidate[] = []
  for (const candidate of candidates) {
    const key = normalizePath(candidate.path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function validateVsCodeCandidate(candidate: VsCodeCliCandidate) {
  const looksLikePath = /[\\/]/.test(candidate.path)
  if (looksLikePath) {
    candidate.exists = existsSync(candidate.path)
    if (!candidate.exists) {
      candidate.status = 1
      candidate.stderr = "candidate path does not exist"
      return
    }
  }
  const strategies = commandInvocationStrategiesFor(candidate.path)
  candidate.attempts = []
  for (const strategy of strategies) {
    const result = runCommand(candidate.path, ["--version"], 30_000, strategy)
    const attempt = {
      strategy: result.strategy,
      windowsVerbatimArguments: result.windowsVerbatimArguments,
      status: result.status,
      commandLine: result.commandLine,
      stdout: result.stdout,
      stderr: result.stderr,
    }
    candidate.attempts.push(attempt)
    candidate.status = result.status
    candidate.commandLine = result.commandLine
    candidate.strategy = result.strategy
    candidate.windowsVerbatimArguments = result.windowsVerbatimArguments
    candidate.stdout = result.stdout
    candidate.stderr = result.stderr
    if (result.status === 0) return
  }
}

export async function writeWorkspaceSettings(ctx: RunContext) {
  const settingsDir = join(ctx.workspace, ".vscode")
  await mkdir(settingsDir, { recursive: true })
  const path = join(settingsDir, "settings.json")
  let current: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    } catch {
      current = {}
    }
  }
  const provider = ctx.config.provider
  const completion = ctx.config.completion
  const rag = ctx.config.rag
  const next = {
    ...current,
    "chipmate.provider.apiBaseUrl": provider.apiBaseUrl,
    "chipmate.provider.chatModel": provider.chatModel,
    "chipmate.completion.enabled": completion.enabled,
    "chipmate.completion.provider": completion.provider,
    "chipmate.completion.profile": completion.profile,
    "chipmate.completion.model": completion.model,
    "chipmate.completion.logLevel": "debug",
    "chipmate.rag.embedding.endpoint": rag.embeddingEndpoint,
    "chipmate.rag.embedding.model": rag.embeddingModel,
    "chipmate.rag.rerank.endpoint": rag.rerankEndpoint,
    "chipmate.rag.rerank.model": rag.rerankModel,
    "chipmate.rag.allowedHosts": rag.allowedHosts,
    "chipmate.codeGraph.promptOnWorkspaceOpen": false,
    "chipmate.rag.embedding.resumeAutomatically": false,
    "editor.inlineSuggest.enabled": true,
    "editor.accessibilitySupport": "on",
    "workbench.startupEditor": "none",
  }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
}

export async function launchVsCode(ctx: RunContext) {
  ctx.preLaunchWindows = await enumerateVisibleWindows(ctx, "before-launch")
  await writeWindowCandidates(ctx, {
    status: "not-found",
    reason: "before launch snapshot",
    beforeLaunch: ctx.preLaunchWindows,
    candidates: [],
    generatedAt: new Date().toISOString(),
  })
  const codeCmd = effectiveCodeCmd(ctx)
  const invocation = commandInvocation(codeCmd, ["--new-window", ctx.workspace], ctx.effectiveCodeCmdStrategy)
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })
  child.unref()
}

export async function locateTargetVsCodeWindow(ctx: RunContext) {
  const timeoutMs = ctx.config.windowActivation.timeoutMs
  const deadline = Date.now() + timeoutMs
  let lastSelection: WindowSelectionReport | undefined
  do {
    const candidates = await enumerateVisibleWindows(ctx, "locate-target")
    lastSelection = selectTargetWindow(ctx, candidates)
    ctx.windowSelection = lastSelection
    await writeWindowCandidates(ctx, lastSelection)
    if (lastSelection.status === "selected" && lastSelection.selected) {
      ctx.targetWindow = lastSelection.selected
      return formatWindowDetail("target-window", lastSelection.selected)
    }
    await delay(500)
  } while (Date.now() < deadline)

  const reason = lastSelection?.reason ?? "no visible top-level windows were discovered"
  throw new Error(`Could not uniquely identify the VS Code window for UI automation: ${reason}. See window-candidates.json.`)
}

export async function invokeCommandPalette(ctx: RunContext, commandLabel: string, delayMs = 1200) {
  const step: UiStepReport = {
    step: "invokeCommandPalette",
    commandLabel,
    status: "started",
    startedAt: new Date().toISOString(),
    screenshots: {},
  }
  ctx.uiSteps.push(step)
  await writeUiSteps(ctx)

  try {
    const target = await ensureTargetWindow(ctx)
    step.targetWindow = target
    const before = await captureWindowScreenshot(ctx, target, `before-command-palette-${safeName(commandLabel)}`)
    if (before) step.screenshots = { ...step.screenshots, before }

    const screenshotPaths = {
      afterShortcut: join(ctx.screenshotsDir, `${safeName(`after-shortcut-${commandLabel}`)}.png`),
      afterShortcutFallback: join(ctx.screenshotsDir, `${safeName(`after-shortcut-ctrl-shift-p-${commandLabel}`)}.png`),
      afterPalette: join(ctx.screenshotsDir, `${safeName(`after-command-palette-${commandLabel}`)}.png`),
      afterPaste: join(ctx.screenshotsDir, `${safeName(`after-paste-${commandLabel}`)}.png`),
      afterEnter: join(ctx.screenshotsDir, `${safeName(`after-enter-${commandLabel}`)}.png`),
    }
    const automation = await runCommandPaletteAutomation(ctx, target, commandLabel, screenshotPaths, delayMs)
    step.automation = automation
    if (automation.foreground && isForegroundWindowInfo(automation.foreground)) step.foreground = automation.foreground
    for (const [name, path] of Object.entries(screenshotPaths)) {
      if (existsSync(path)) {
        step.screenshots = {
          ...step.screenshots,
          [name]: relativeReportPath(ctx, path),
        }
      }
    }
    const afterCommand = await captureWindowScreenshot(ctx, target, `after-command-${safeName(commandLabel)}`)
    if (afterCommand) step.screenshots = { ...step.screenshots, afterCommand }
    step.status = "passed"
    step.completedAt = new Date().toISOString()
    await writeUiSteps(ctx)
    return `${formatWindowDetail("activated", target)}; command=${commandLabel}; uiAction=command-palette-command-submitted`
  } catch (error) {
    step.status = "failed"
    step.completedAt = new Date().toISOString()
    step.error = error instanceof Error ? error.message : String(error)
    await writeUiSteps(ctx)
    throw error
  }
}

export async function submitTextToActiveVsCodeInput(ctx: RunContext, inputLabel: string, text: string, delayMs = 1200) {
  const step: UiStepReport = {
    step: "submitTextToActiveVsCodeInput",
    inputLabel,
    status: "started",
    startedAt: new Date().toISOString(),
    screenshots: {},
  }
  ctx.uiSteps.push(step)
  await writeUiSteps(ctx)

  try {
    const target = await ensureTargetWindow(ctx)
    step.targetWindow = target
    const before = await captureWindowScreenshot(ctx, target, `before-input-${safeName(inputLabel)}`)
    if (before) step.screenshots = { ...step.screenshots, before }

    const screenshotPaths = {
      afterPaste: join(ctx.screenshotsDir, `${safeName(`after-input-paste-${inputLabel}`)}.png`),
      afterEnter: join(ctx.screenshotsDir, `${safeName(`after-input-enter-${inputLabel}`)}.png`),
    }
    const automation = await runInputSubmitAutomation(ctx, target, text, screenshotPaths, delayMs)
    step.automation = automation
    if (automation.foreground && isForegroundWindowInfo(automation.foreground)) step.foreground = automation.foreground
    for (const [name, path] of Object.entries(screenshotPaths)) {
      if (existsSync(path)) {
        step.screenshots = {
          ...step.screenshots,
          [name]: relativeReportPath(ctx, path),
        }
      }
    }
    const afterInput = await captureWindowScreenshot(ctx, target, `after-input-${safeName(inputLabel)}`)
    if (afterInput) step.screenshots = { ...step.screenshots, afterInput }
    step.status = "passed"
    step.completedAt = new Date().toISOString()
    await writeUiSteps(ctx)
    return `${formatWindowDetail("input-target", target)}; input=${inputLabel}; uiAction=input-submitted`
  } catch (error) {
    step.status = "failed"
    step.completedAt = new Date().toISOString()
    step.error = error instanceof Error ? error.message : String(error)
    await writeUiSteps(ctx)
    throw error
  }
}

export async function recordFunctionalCheck(ctx: RunContext, check: Omit<FunctionalCheckReport, "generatedAt">) {
  ctx.functionalChecks.push({
    ...check,
    generatedAt: new Date().toISOString(),
  })
  await writeFunctionalChecks(ctx)
}

export function openFile(ctx: RunContext, filePath: string, line = 1, column = 1) {
  return runCode(ctx, [
    "--reuse-window",
    "--goto",
    `${filePath}:${line}:${column}`,
  ], 30_000)
}

async function ensureTargetWindow(ctx: RunContext) {
  if (!ctx.targetWindow) {
    await locateTargetVsCodeWindow(ctx)
  }
  if (!ctx.targetWindow) throw new Error("VS Code target window was not selected")

  const candidates = await enumerateVisibleWindows(ctx, "pre-ui-step-target-check")
  const existing = candidates.find((candidate) => candidate.hwnd === ctx.targetWindow?.hwnd)
  if (existing) {
    ctx.targetWindow = {
      ...ctx.targetWindow,
      ...existing,
      score: ctx.targetWindow.score,
      reasons: ctx.targetWindow.reasons,
      requiredMatch: ctx.targetWindow.requiredMatch,
    }
    return ctx.targetWindow
  }

  ctx.targetWindow = undefined
  await locateTargetVsCodeWindow(ctx)
  if (!ctx.targetWindow) throw new Error("VS Code target window disappeared before UI automation could continue")
  return ctx.targetWindow
}

async function runCommandPaletteAutomation(
  ctx: RunContext,
  target: WindowCandidate,
  commandLabel: string,
  screenshotPaths: {
    afterShortcut: string
    afterShortcutFallback: string
    afterPalette: string
    afterPaste: string
    afterEnter: string
  },
  delayMs: number,
) {
  const scriptPath = await writePowerShellAutomationScript(ctx, `invoke-command-palette-${safeName(commandLabel)}`, [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    addWindowActivationType(),
    `$targetHwnd = [IntPtr]([Int64]${target.hwnd})`,
    `$targetPid = ${target.pid}`,
    `$commandText = ${powershellString(`>${commandLabel}`)}`,
    `$afterShortcutPath = ${powershellString(screenshotPaths.afterShortcut)}`,
    `$afterShortcutFallbackPath = ${powershellString(screenshotPaths.afterShortcutFallback)}`,
    `$afterPalettePath = ${powershellString(screenshotPaths.afterPalette)}`,
    `$afterPastePath = ${powershellString(screenshotPaths.afterPaste)}`,
    `$afterEnterPath = ${powershellString(screenshotPaths.afterEnter)}`,
    "$activationAttempts = @()",
    "$shortcutAttempts = @()",
    "$paletteCandidates = @()",
    "function Get-ForegroundInfo {",
    "  $foregroundHwnd = [ChipMateWindowActivation]::GetForegroundWindow()",
    "  $foregroundPid = 0",
    "  [void][ChipMateWindowActivation]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundPid)",
    "  $processName = ''",
    "  $title = ''",
    "  try {",
    "    $process = Get-Process -Id $foregroundPid -ErrorAction Stop",
    "    $processName = $process.ProcessName",
    "    $title = $process.MainWindowTitle",
    "  } catch { }",
    "  [pscustomobject]@{ hwnd = $foregroundHwnd.ToInt64().ToString(); pid = $foregroundPid; processName = $processName; windowTitle = $title }",
    "}",
    "function Assert-ForegroundTarget([string]$phase) {",
    "  $current = Get-ForegroundInfo",
    "  if ($current.pid -ne $targetPid) { throw \"UI automation focus failure: foreground pid $($current.pid) '$($current.processName)' during $phase did not match VS Code pid $targetPid\" }",
    "  return $current",
    "}",
    "function Save-WindowScreenshot([IntPtr]$hwnd, [string]$path) {",
    "  try {",
    "    $rect = New-Object ChipMateWindowActivation+RECT",
    "    if (-not [ChipMateWindowActivation]::GetWindowRect($hwnd, [ref]$rect)) { throw 'GetWindowRect failed' }",
    "    $width = $rect.Right - $rect.Left",
    "    $height = $rect.Bottom - $rect.Top",
    "    if ($width -lt 1 -or $height -lt 1) { throw \"Invalid window rectangle ${width}x${height}\" }",
    "    $bitmap = New-Object System.Drawing.Bitmap($width, $height)",
    "    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))",
    "    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    $graphics.Dispose()",
    "    $bitmap.Dispose()",
    "    [pscustomobject]@{ status = 'saved'; path = $path; width = $width; height = $height }",
    "  } catch {",
    "    [pscustomobject]@{ status = 'failed'; path = $path; error = $_.Exception.Message }",
    "  }",
    "}",
    "function Get-EditInfo($element, $rootRect) {",
    "  $rect = $element.Current.BoundingRectangle",
    "  $name = [string]$element.Current.Name",
    "  $score = 0",
    "  $reasons = New-Object System.Collections.Generic.List[string]",
    "  $valuePatternObject = $null",
    "  $supportsValuePattern = $false",
    "  try { $supportsValuePattern = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePatternObject) } catch { $supportsValuePattern = $false }",
    "  $topOffset = $rect.Top - $rootRect.Top",
    "  $nameLooksLikeCommandPalette = $name -match '(?i)(command|palette|type.*command|命令|指令|键入|輸入)'",
    "  $geometryLooksLikeQuickInput = $element.Current.HasKeyboardFocus -and $topOffset -ge 0 -and $topOffset -le 260 -and $rect.Width -ge 240 -and $rect.Height -ge 8 -and $rect.Height -le 140",
    "  if ($nameLooksLikeCommandPalette) { $score += 100; $reasons.Add('name looks like command palette') }",
    "  if ($geometryLooksLikeQuickInput) { $score += 70; $reasons.Add('focused quick-input geometry') }",
    "  if ($element.Current.HasKeyboardFocus) { $score += 30; $reasons.Add('has keyboard focus') }",
    "  if ($element.Current.IsKeyboardFocusable) { $score += 10; $reasons.Add('is keyboard focusable') }",
    "  if ($supportsValuePattern) { $score += 10; $reasons.Add('supports ValuePattern') }",
    "  [pscustomobject]@{",
    "    name = $name",
    "    hasKeyboardFocus = $element.Current.HasKeyboardFocus",
    "    isKeyboardFocusable = $element.Current.IsKeyboardFocusable",
    "    supportsValuePattern = $supportsValuePattern",
    "    topOffset = [int]$topOffset",
    "    boundingRectangle = [pscustomobject]@{ left = [int]$rect.Left; top = [int]$rect.Top; width = [int]$rect.Width; height = [int]$rect.Height }",
    "    commandPaletteMatch = ($nameLooksLikeCommandPalette -or $geometryLooksLikeQuickInput)",
    "    score = $score",
    "    reasons = @($reasons)",
    "  }",
    "}",
    "function Find-CommandPaletteInput([IntPtr]$hwnd) {",
    "  $deadline = [DateTime]::UtcNow.AddSeconds(6)",
    "  do {",
    "    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)",
    "    if ($null -ne $root) {",
    "      $rootRect = $root.Current.BoundingRectangle",
    "      $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)",
    "      $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition)",
    "      $items = @()",
    "      foreach ($edit in $edits) {",
    "        $info = Get-EditInfo $edit $rootRect",
    "        $items += [pscustomobject]@{ element = $edit; info = $info }",
    "      }",
    "      $script:paletteCandidates = @($items | ForEach-Object { $_.info } | Sort-Object -Property score -Descending | Select-Object -First 12)",
    "      $matches = @($items | Where-Object { $_.info.commandPaletteMatch } | Sort-Object -Property @{ Expression = { $_.info.score }; Descending = $true })",
    "      if ($matches.Count -gt 0) { return $matches[0] }",
    "    }",
    "    Start-Sleep -Milliseconds 250",
    "  } while ([DateTime]::UtcNow -lt $deadline)",
    "  return $null",
    "}",
    "function Send-PaletteShortcut([string]$method, [string]$keys, [string]$screenshotPath) {",
    "  $before = Assert-ForegroundTarget \"before shortcut $method\"",
    "  [System.Windows.Forms.SendKeys]::SendWait($keys)",
    "  Start-Sleep -Milliseconds 500",
    "  $after = Get-ForegroundInfo",
    "  $screenshot = Save-WindowScreenshot $targetHwnd $screenshotPath",
    "  $palette = $null",
    "  if ($after.pid -eq $targetPid) { $palette = Find-CommandPaletteInput $targetHwnd }",
    "  $script:shortcutAttempts += [pscustomobject]@{ method = $method; keys = $keys; foregroundBefore = $before; foregroundAfter = $after; screenshot = $screenshot; uiaPaletteFound = ($null -ne $palette) }",
    "  [pscustomobject]@{ method = $method; foreground = $after; palette = $palette; screenshot = $screenshot }",
    "}",
    "try {",
    "  if (-not [ChipMateWindowActivation]::IsWindow($targetHwnd)) { throw 'UI automation focus failure: selected VS Code window handle no longer exists' }",
    "  $activated = $false",
    "  $wshell = New-Object -ComObject WScript.Shell",
    "  for ($i = 0; $i -lt 12; $i++) {",
    "    [void]$wshell.AppActivate($targetPid)",
    "    [void][ChipMateWindowActivation]::ShowWindowAsync($targetHwnd, 9)",
    "    [void][ChipMateWindowActivation]::SetForegroundWindow($targetHwnd)",
    "    Start-Sleep -Milliseconds 200",
    "    $foreground = Get-ForegroundInfo",
    "    $activationAttempts += $foreground",
    "    if ($foreground.pid -eq $targetPid) { $activated = $true; break }",
    "  }",
    "  $foreground = Get-ForegroundInfo",
    "  if (-not $activated) { throw \"UI automation focus failure: foreground pid $($foreground.pid) '$($foreground.processName)' did not match VS Code pid $targetPid\" }",
    "  $shortcut = Send-PaletteShortcut 'F1' '{F1}' $afterShortcutPath",
    "  $foreground = $shortcut.foreground",
    "  $palette = $shortcut.palette",
    "  if ($foreground.pid -ne $targetPid) {",
    "    $shortcut = Send-PaletteShortcut 'CtrlShiftP' '^+p' $afterShortcutFallbackPath",
    "    $foreground = $shortcut.foreground",
    "    $palette = $shortcut.palette",
    "  }",
    "  if ($foreground.pid -ne $targetPid) { throw \"UI automation focus failure: foreground pid $($foreground.pid) '$($foreground.processName)' after command palette shortcut did not match VS Code pid $targetPid\" }",
    "  $uiaPaletteFound = $null -ne $palette",
    "  $fallbackUsed = $false",
    "  $fallbackReason = ''",
    "  $afterPaletteScreenshot = Save-WindowScreenshot $targetHwnd $afterPalettePath",
    "  $entryMethod = 'ValuePattern.SetValue'",
    "  $foregroundBeforePaste = Assert-ForegroundTarget 'before text entry'",
    "  if ($uiaPaletteFound) {",
    "    $palette.element.SetFocus()",
    "    Start-Sleep -Milliseconds 150",
    "    $valuePatternObject = $null",
    "    $supportsValuePattern = $palette.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePatternObject)",
    "    if ($supportsValuePattern -and $null -ne $valuePatternObject) {",
    "      $valuePatternObject.SetValue($commandText)",
    "    } else {",
    "      $fallbackUsed = $true",
    "      $fallbackReason = 'uia-value-pattern-missing'",
    "      $entryMethod = 'ClipboardPasteIntoVerifiedCommandPaletteInput'",
    "      [System.Windows.Forms.Clipboard]::SetText($commandText)",
    "      [System.Windows.Forms.SendKeys]::SendWait('^a')",
    "      Start-Sleep -Milliseconds 100",
    "      [System.Windows.Forms.SendKeys]::SendWait('^v')",
    "    }",
    "  } else {",
    "    $fallbackUsed = $true",
    "    $fallbackReason = 'uia-palette-not-found'",
    "    $entryMethod = 'GuardedKeyboardFallbackClipboardPaste'",
    "    [System.Windows.Forms.Clipboard]::SetText($commandText)",
    "    [System.Windows.Forms.SendKeys]::SendWait('^a')",
    "    Start-Sleep -Milliseconds 100",
    "    [System.Windows.Forms.SendKeys]::SendWait('^v')",
    "  }",
    "  Start-Sleep -Milliseconds 150",
    "  $afterPasteScreenshot = Save-WindowScreenshot $targetHwnd $afterPastePath",
    "  $foregroundBeforeEnter = Assert-ForegroundTarget 'before Enter'",
    "  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "  Start-Sleep -Milliseconds 250",
    "  $afterEnterScreenshot = Save-WindowScreenshot $targetHwnd $afterEnterPath",
    `  Start-Sleep -Milliseconds ${delayMs}`,
    "  $foreground = Get-ForegroundInfo",
    "  [pscustomobject]@{ status = 'passed'; foreground = $foreground; activationAttempts = @($activationAttempts); shortcutAttempts = @($shortcutAttempts); uiaPaletteFound = $uiaPaletteFound; fallbackUsed = $fallbackUsed; fallbackReason = $fallbackReason; foregroundBeforePaste = $foregroundBeforePaste; foregroundBeforeEnter = $foregroundBeforeEnter; commandPalette = $(if ($uiaPaletteFound) { $palette.info } else { $null }); paletteCandidates = @($paletteCandidates); textEntryMethod = $entryMethod; afterPaletteScreenshot = $afterPaletteScreenshot; afterPasteScreenshot = $afterPasteScreenshot; afterEnterScreenshot = $afterEnterScreenshot } | ConvertTo-Json -Depth 12 -Compress",
    "} catch {",
    "  $failureForeground = Get-ForegroundInfo",
    "  [pscustomobject]@{ status = 'failed'; error = $_.Exception.Message; foreground = $failureForeground; activationAttempts = @($activationAttempts); shortcutAttempts = @($shortcutAttempts); paletteCandidates = @($paletteCandidates) } | ConvertTo-Json -Depth 12 -Compress",
    "  exit 1",
    "}",
  ].join("\n"))
  const result = runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-File", scriptPath], Math.max(30_000, delayMs + 20_000))
  const detail = parsePowerShellJson(result.stdout)
  if (result.status !== 0) {
    throw new Error(`Command palette automation failed: ${result.stderr || result.stdout || "no PowerShell output"}`)
  }
  if (detail.status !== "passed") {
    throw new Error(`Command palette automation failed: ${JSON.stringify(detail)}`)
  }
  return detail
}

async function runInputSubmitAutomation(
  ctx: RunContext,
  target: WindowCandidate,
  text: string,
  screenshotPaths: {
    afterPaste: string
    afterEnter: string
  },
  delayMs: number,
) {
  const scriptPath = await writePowerShellAutomationScript(ctx, `submit-input-${safeName(text).slice(0, 60)}`, [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    addWindowActivationType(),
    `$targetHwnd = [IntPtr]([Int64]${target.hwnd})`,
    `$targetPid = ${target.pid}`,
    `$inputText = ${powershellString(text)}`,
    `$afterPastePath = ${powershellString(screenshotPaths.afterPaste)}`,
    `$afterEnterPath = ${powershellString(screenshotPaths.afterEnter)}`,
    "$activationAttempts = @()",
    "function Get-ForegroundInfo {",
    "  $foregroundHwnd = [ChipMateWindowActivation]::GetForegroundWindow()",
    "  $foregroundPid = 0",
    "  [void][ChipMateWindowActivation]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundPid)",
    "  $processName = ''",
    "  $title = ''",
    "  try {",
    "    $process = Get-Process -Id $foregroundPid -ErrorAction Stop",
    "    $processName = $process.ProcessName",
    "    $title = $process.MainWindowTitle",
    "  } catch { }",
    "  [pscustomobject]@{ hwnd = $foregroundHwnd.ToInt64().ToString(); pid = $foregroundPid; processName = $processName; windowTitle = $title }",
    "}",
    "function Assert-ForegroundTarget([string]$phase) {",
    "  $current = Get-ForegroundInfo",
    "  if ($current.pid -ne $targetPid) { throw \"UI automation focus failure: foreground pid $($current.pid) '$($current.processName)' during $phase did not match VS Code pid $targetPid\" }",
    "  return $current",
    "}",
    "function Save-WindowScreenshot([IntPtr]$hwnd, [string]$path) {",
    "  try {",
    "    $rect = New-Object ChipMateWindowActivation+RECT",
    "    if (-not [ChipMateWindowActivation]::GetWindowRect($hwnd, [ref]$rect)) { throw 'GetWindowRect failed' }",
    "    $width = $rect.Right - $rect.Left",
    "    $height = $rect.Bottom - $rect.Top",
    "    if ($width -lt 1 -or $height -lt 1) { throw \"Invalid window rectangle ${width}x${height}\" }",
    "    $bitmap = New-Object System.Drawing.Bitmap($width, $height)",
    "    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))",
    "    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    $graphics.Dispose()",
    "    $bitmap.Dispose()",
    "    [pscustomobject]@{ status = 'saved'; path = $path; width = $width; height = $height }",
    "  } catch {",
    "    [pscustomobject]@{ status = 'failed'; path = $path; error = $_.Exception.Message }",
    "  }",
    "}",
    "try {",
    "  if (-not [ChipMateWindowActivation]::IsWindow($targetHwnd)) { throw 'UI automation focus failure: selected VS Code window handle no longer exists' }",
    "  $activated = $false",
    "  $wshell = New-Object -ComObject WScript.Shell",
    "  for ($i = 0; $i -lt 12; $i++) {",
    "    [void]$wshell.AppActivate($targetPid)",
    "    [void][ChipMateWindowActivation]::ShowWindowAsync($targetHwnd, 9)",
    "    [void][ChipMateWindowActivation]::SetForegroundWindow($targetHwnd)",
    "    Start-Sleep -Milliseconds 200",
    "    $foreground = Get-ForegroundInfo",
    "    $activationAttempts += $foreground",
    "    if ($foreground.pid -eq $targetPid) { $activated = $true; break }",
    "  }",
    "  if (-not $activated) {",
    "    $foreground = Get-ForegroundInfo",
    "    throw \"UI automation focus failure: foreground pid $($foreground.pid) '$($foreground.processName)' did not match VS Code pid $targetPid\"",
    "  }",
    "  $foregroundBeforePaste = Assert-ForegroundTarget 'before input paste'",
    "  [System.Windows.Forms.Clipboard]::SetText($inputText)",
    "  [System.Windows.Forms.SendKeys]::SendWait('^a')",
    "  Start-Sleep -Milliseconds 100",
    "  [System.Windows.Forms.SendKeys]::SendWait('^v')",
    "  Start-Sleep -Milliseconds 150",
    "  $afterPasteScreenshot = Save-WindowScreenshot $targetHwnd $afterPastePath",
    "  $foregroundBeforeEnter = Assert-ForegroundTarget 'before input Enter'",
    "  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "  Start-Sleep -Milliseconds 250",
    "  $afterEnterScreenshot = Save-WindowScreenshot $targetHwnd $afterEnterPath",
    `  Start-Sleep -Milliseconds ${delayMs}`,
    "  $foreground = Get-ForegroundInfo",
    "  [pscustomobject]@{ status = 'passed'; foreground = $foreground; activationAttempts = @($activationAttempts); foregroundBeforePaste = $foregroundBeforePaste; foregroundBeforeEnter = $foregroundBeforeEnter; textEntryMethod = 'GuardedInputBoxClipboardPaste'; afterPasteScreenshot = $afterPasteScreenshot; afterEnterScreenshot = $afterEnterScreenshot } | ConvertTo-Json -Depth 12 -Compress",
    "} catch {",
    "  $failureForeground = Get-ForegroundInfo",
    "  [pscustomobject]@{ status = 'failed'; error = $_.Exception.Message; foreground = $failureForeground; activationAttempts = @($activationAttempts) } | ConvertTo-Json -Depth 12 -Compress",
    "  exit 1",
    "}",
  ].join("\n"))
  const result = runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-File", scriptPath], Math.max(30_000, delayMs + 20_000))
  const detail = parsePowerShellJson(result.stdout)
  if (result.status !== 0) {
    throw new Error(`VS Code input automation failed: ${result.stderr || result.stdout || "no PowerShell output"}`)
  }
  if (detail.status !== "passed") {
    throw new Error(`VS Code input automation failed: ${JSON.stringify(detail)}`)
  }
  return detail
}

async function captureWindowScreenshot(ctx: RunContext, target: WindowCandidate, label: string) {
  const screenshotPath = join(ctx.screenshotsDir, `${safeName(label)}.png`)
  const scriptPath = await writePowerShellAutomationScript(ctx, `capture-${safeName(label)}`, [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    addWindowActivationType(),
    `$targetHwnd = [IntPtr]([Int64]${target.hwnd})`,
    `$path = ${powershellString(screenshotPath)}`,
    "$rect = New-Object ChipMateWindowActivation+RECT",
    "if (-not [ChipMateWindowActivation]::GetWindowRect($targetHwnd, [ref]$rect)) { throw 'GetWindowRect failed' }",
    "$width = $rect.Right - $rect.Left",
    "$height = $rect.Bottom - $rect.Top",
    "if ($width -lt 1 -or $height -lt 1) { throw \"Invalid window rectangle ${width}x${height}\" }",
    "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))",
    "$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$graphics.Dispose()",
    "$bitmap.Dispose()",
  ].join("\n"))
  const result = runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], 30_000)
  if (result.status !== 0 || !existsSync(screenshotPath)) {
    const errorPath = join(ctx.screenshotsDir, `${safeName(label)}.error.txt`)
    await writeFile(errorPath, redact(`command=${result.commandLine}\nstdout=${result.stdout}\nstderr=${result.stderr}\n`, ctx.config))
    return undefined
  }
  return relativeReportPath(ctx, screenshotPath)
}

async function writePowerShellAutomationScript(ctx: RunContext, name: string, script: string) {
  const scriptsDir = join(ctx.workRoot, "automation-scripts")
  await mkdir(scriptsDir, { recursive: true })
  const scriptPath = join(scriptsDir, `${safeName(name)}.ps1`)
  await writeFile(scriptPath, script)
  return scriptPath
}

function parsePowerShellJson(stdout: string) {
  const jsonLine = stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"))
  if (!jsonLine) return { status: "failed", rawStdout: stdout } as Record<string, unknown>
  try {
    return JSON.parse(jsonLine) as Record<string, unknown>
  } catch {
    return { status: "failed", rawStdout: stdout } as Record<string, unknown>
  }
}

function isForegroundWindowInfo(value: unknown): value is ForegroundWindowInfo {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ForegroundWindowInfo>
  return typeof candidate.hwnd === "string"
    && typeof candidate.pid === "number"
    && typeof candidate.processName === "string"
    && typeof candidate.windowTitle === "string"
}

async function writeUiSteps(ctx: RunContext) {
  await writeFile(join(ctx.reportDir, "ui-steps.json"), redact(`${JSON.stringify(ctx.uiSteps, null, 2)}\n`, ctx.config))
}

async function writeFunctionalChecks(ctx: RunContext) {
  await writeFile(join(ctx.reportDir, "functional-checks.json"), redact(`${JSON.stringify(ctx.functionalChecks, null, 2)}\n`, ctx.config))
}

async function writeVsCodeDiscovery(ctx: RunContext) {
  const report = ctx.vscodeDiscovery ?? {
    configuredCodeCmd: ctx.configuredCodeCmd,
    status: "not-found",
    reason: "VS Code CLI discovery not started",
    candidates: [],
    whereDiagnostics: [],
    generatedAt: new Date().toISOString(),
  }
  await writeFile(join(ctx.reportDir, "vscode-discovery.json"), redact(`${JSON.stringify(report, null, 2)}\n`, ctx.config))
}

function relativeReportPath(ctx: RunContext, path: string) {
  return relative(ctx.reportDir, path).replace(/\\/g, "/")
}

function effectiveCodeCmd(ctx: RunContext) {
  if (!ctx.effectiveCodeCmd) throw new Error("VS Code CLI discovery failed. See vscode-discovery.json.")
  return ctx.effectiveCodeCmd
}

function commandInvocation(command: string, args: string[], strategy?: CommandInvocationStrategy): CommandInvocation {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return strategy === "powershell-call"
      ? powershellCommandInvocation(command, args)
      : cmdCallVerbatimInvocation(command, args)
  }
  return {
    command,
    args,
    commandLine: [quoteCommandForDisplay(command), ...args.map(quoteCommandForDisplay)].join(" "),
    strategy: "direct",
  }
}

function commandInvocationStrategiesFor(command: string): CommandInvocationStrategy[] {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) return ["cmd-call-verbatim", "powershell-call"]
  return ["direct"]
}

function cmdCallVerbatimInvocation(command: string, args: string[]): CommandInvocation {
  const inner = [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ")
  const cmdBody = `call ${inner}`
  const shell = process.env.ComSpec || "cmd.exe"
  return {
    command: shell,
    args: ["/d", "/c", cmdBody],
    commandLine: `${shell} /d /c ${cmdBody}`,
    strategy: "cmd-call-verbatim",
    windowsVerbatimArguments: true,
  }
}

function powershellCommandInvocation(command: string, args: string[]): CommandInvocation {
  const script = `& ${powershellString(command)} ${args.map(powershellString).join(" ")}; exit $LASTEXITCODE`
  const shell = "powershell.exe"
  return {
    command: shell,
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    commandLine: `${shell} -NoProfile -ExecutionPolicy Bypass -Command ${quoteCommandForDisplay(script)}`,
    strategy: "powershell-call",
  }
}

function quoteCmdArgument(value: string) {
  if (!value) return "\"\""
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `"${value.replace(/"/g, "\"\"")}"`
}

function quoteCommandForDisplay(value: string) {
  if (!value) return "\"\""
  return /\s/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value
}

async function enumerateVisibleWindows(ctx: RunContext, phase: string): Promise<WindowCandidate[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | ForEach-Object {",
    "  $processPath = ''",
    "  try { $processPath = $_.Path } catch { $processPath = '' }",
    "  [pscustomobject]@{ hwnd = $_.MainWindowHandle.ToInt64().ToString(); pid = $_.Id; processName = $_.ProcessName; processPath = $processPath; windowTitle = $_.MainWindowTitle }",
    "}",
    "@($items) | ConvertTo-Json -Depth 5 -Compress",
  ].join("; ")
  const result = runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], 30_000)
  if (result.status !== 0) {
    await writeWindowCandidates(ctx, {
      status: "not-found",
      reason: `window enumeration failed during ${phase}`,
      beforeLaunch: ctx.preLaunchWindows ?? [],
      candidates: [],
      generatedAt: new Date().toISOString(),
      diagnostics: {
        phase,
        commandLine: result.commandLine,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    })
    throw new Error(`Failed to enumerate visible windows during ${phase}: ${result.stderr || result.stdout}`)
  }
  const text = result.stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as WindowCandidate[] | WindowCandidate
  return Array.isArray(parsed) ? parsed : [parsed]
}

function selectTargetWindow(ctx: RunContext, candidates: WindowCandidate[]): WindowSelectionReport {
  const before = ctx.preLaunchWindows ?? []
  const beforeHandles = new Set(before.map((candidate) => candidate.hwnd))
  const installRoot = codeInstallRoot(ctx.effectiveCodeCmd ?? ctx.config.codeCmd)
  const processNameRegex = new RegExp(ctx.config.windowActivation.processNameRegex, "i")
  const titleRegex = ctx.config.windowActivation.titleRegex ? new RegExp(ctx.config.windowActivation.titleRegex, "i") : undefined
  const workspaceHint = ctx.config.windowActivation.workspaceTitleHint.trim().toLowerCase()
  const scored = candidates.map((candidate) => {
    const reasons: string[] = []
    let score = 0
    let requiredMatch = false
    const processPath = normalizePath(candidate.processPath)
    const title = candidate.windowTitle.toLowerCase()
    const isNew = !beforeHandles.has(candidate.hwnd)
    if (installRoot && processPath.startsWith(installRoot)) {
      score += 100
      requiredMatch = true
      reasons.push("processPath under codeCmd install root")
    }
    if (candidate.processName && processNameRegex.test(candidate.processName)) {
      score += 40
      requiredMatch = true
      reasons.push("processNameRegex matched")
    }
    if (titleRegex && titleRegex.test(candidate.windowTitle)) {
      score += 80
      requiredMatch = true
      reasons.push("titleRegex matched")
    }
    if (workspaceHint && title.includes(workspaceHint)) {
      score += 60
      requiredMatch = true
      reasons.push("workspaceTitleHint matched")
    }
    if (isNew) {
      score += 20
      reasons.push("new visible window after launch")
    }
    return { ...candidate, isNew, requiredMatch, score, reasons }
  })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  const ranked = scored.filter((candidate) => candidate.requiredMatch === true)

  if (!ranked.length) {
    return {
      status: "not-found",
      reason: "no visible window matched codeCmd path, processNameRegex, titleRegex, or workspaceTitleHint",
      beforeLaunch: before,
      candidates: scored,
      generatedAt: new Date().toISOString(),
    }
  }

  const top = ranked[0]
  const tied = ranked.filter((candidate) => candidate.score === top.score)
  if (tied.length > 1) {
    return {
      status: "ambiguous",
      reason: `multiple windows tied with score ${top.score}`,
      beforeLaunch: before,
      candidates: scored,
      generatedAt: new Date().toISOString(),
    }
  }

  return {
    status: "selected",
    reason: `unique best match with score ${top.score}: ${top.reasons?.join(", ")}`,
    selected: top,
    beforeLaunch: before,
    candidates: scored,
    generatedAt: new Date().toISOString(),
  }
}

async function writeWindowCandidates(ctx: RunContext, report: WindowSelectionReport) {
  await writeFile(join(ctx.reportDir, "window-candidates.json"), redact(`${JSON.stringify(report, null, 2)}\n`, ctx.config))
}

function codeInstallRoot(codeCmd: string) {
  const lower = codeCmd.toLowerCase()
  if (!/[\\/]/.test(codeCmd) || !lower.endsWith("code.cmd")) return ""
  const binDir = dirname(codeCmd)
  const root = basename(binDir).toLowerCase() === "bin" ? dirname(binDir) : binDir
  return normalizePath(root)
}

function normalizePath(value: string) {
  return value ? value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : ""
}

function formatWindowDetail(prefix: string, candidate: WindowCandidate) {
  return `${prefix}=hwnd:${candidate.hwnd};pid:${candidate.pid};process:${candidate.processName};title:${candidate.windowTitle};score:${candidate.score ?? "n/a"}`
}

function addWindowActivationType() {
  return `Add-Type -TypeDefinition ${powershellString([
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class ChipMateWindowActivation {",
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
    "}",
  ].join("\n"))}`
}

export async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function collectEnvironment(ctx: RunContext) {
  const version = runCode(ctx, ["--version"], 30_000)
  const extensions = listInstalledExtensions(ctx)
  ctx.installedExtensionVersion = installedExtensionVersion(extensions.stdout, ctx.config.extensionId)
  await writeFile(join(ctx.reportDir, "vscode-version.txt"), redact(version.stdout + version.stderr, ctx.config))
  await writeFile(join(ctx.reportDir, "installed-extensions.txt"), redact(extensions.stdout + extensions.stderr, ctx.config))
  await writeFile(join(ctx.reportDir, "vscode-cli-commands.json"), redact(`${JSON.stringify({
    discovery: {
      status: ctx.vscodeDiscovery?.status ?? "not-found",
      reason: ctx.vscodeDiscovery?.reason ?? "VS Code CLI discovery not started",
      configuredCodeCmd: ctx.configuredCodeCmd,
      effectiveCodeCmd: ctx.effectiveCodeCmd ?? null,
      effectiveCodeCmdStrategy: ctx.effectiveCodeCmdStrategy ?? null,
    },
    version: {
      commandLine: version.commandLine,
      strategy: version.strategy,
      windowsVerbatimArguments: version.windowsVerbatimArguments,
      status: version.status,
      stderr: version.stderr,
    },
    listExtensions: {
      commandLine: extensions.commandLine,
      strategy: extensions.strategy,
      windowsVerbatimArguments: extensions.windowsVerbatimArguments,
      status: extensions.status,
      stderr: extensions.stderr,
    },
  }, null, 2)}\n`, ctx.config))
  await writeFile(join(ctx.reportDir, "installed-chipmate.json"), `${JSON.stringify({
    extensionId: ctx.config.extensionId,
    version: ctx.installedExtensionVersion ?? null,
    found: Boolean(ctx.installedExtensionVersion),
  }, null, 2)}\n`)
  const environmentJson = `${JSON.stringify({
    runId: ctx.runId,
    mode: ctx.mode,
    installMode: ctx.config.installMode,
    profileMode: ctx.config.profileMode,
    hostname: hostname(),
    user: safeUserName(),
    bundleRoot: ctx.bundleRoot,
    workspace: ctx.workspace,
    userDataDir: ctx.userDataDir,
    extensionsDir: ctx.extensionsDir || null,
    configuredCodeCmd: ctx.configuredCodeCmd,
    effectiveCodeCmd: ctx.effectiveCodeCmd ?? null,
    effectiveCodeCmdStrategy: ctx.effectiveCodeCmdStrategy ?? null,
    codeCmd: ctx.effectiveCodeCmd ?? ctx.config.codeCmd,
    extensionId: ctx.config.extensionId,
    installedExtensionVersion: ctx.installedExtensionVersion ?? null,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`
  await writeFile(join(ctx.reportDir, "environment.json"), redact(environmentJson, ctx.config))
}

export function listInstalledExtensions(ctx: RunContext) {
  return runCode(ctx, ["--list-extensions", "--show-versions"], 60_000)
}

export function installedExtensionVersion(extensionList: string, extensionId: string) {
  const lowerId = extensionId.toLowerCase()
  for (const line of extensionList.split(/\r?\n/)) {
    const trimmed = line.trim()
    const at = trimmed.lastIndexOf("@")
    if (at <= 0) continue
    const id = trimmed.slice(0, at).toLowerCase()
    if (id === lowerId) return trimmed.slice(at + 1)
  }
  return undefined
}

function safeUserName() {
  try {
    return userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? ""
  }
}

export async function collectLogs(ctx: RunContext) {
  await copyMatchingLogs(ctx.userDataDir, ctx.logsDir)
  await summarizeGlobalStorage(ctx)
}

async function copyMatchingLogs(userDataDir: string, targetDir: string) {
  const logsRoot = join(userDataDir, "logs")
  if (!existsSync(logsRoot)) return
  const files = await walk(logsRoot)
  for (const file of files) {
    const name = basename(file)
    if (!/chipmate|exthost|extension host|sharedprocess|renderer/i.test(file)) continue
    const target = join(targetDir, safeName(file.slice(logsRoot.length + 1)))
    try {
      const text = await readFile(file, "utf8")
      await writeFile(target, text.slice(-2_000_000))
    } catch {
      // Ignore binary or locked logs.
    }
  }
  await concatenateLogs(targetDir, "chipmate-output.log", /chipmate(?!.*comment)/i)
  await concatenateLogs(targetDir, "chipmate-comment-output.log", /chipmate.*comment/i)
  await concatenateLogs(targetDir, "extension-host.log", /exthost|extension.host/i)
  await concatenateLogs(targetDir, "shared-process.log", /sharedprocess/i)
}

async function concatenateLogs(dir: string, targetName: string, pattern: RegExp) {
  const parts: string[] = []
  for (const entry of await readdir(dir)) {
    if (entry === targetName) continue
    if (!pattern.test(entry)) continue
    parts.push(`\n===== ${entry} =====\n${await readFile(join(dir, entry), "utf8")}`)
  }
  if (parts.length) await writeFile(join(dir, targetName), parts.join("\n").slice(-2_000_000))
}

async function summarizeGlobalStorage(ctx: RunContext) {
  const storageRoot = join(ctx.userDataDir, "User", "globalStorage")
  const summary: Array<{ path: string; bytes: number; files: number }> = []
  if (existsSync(storageRoot)) {
    const roots = await readdir(storageRoot)
    for (const entry of roots) {
      if (!/chipmate|opencode|local/i.test(entry)) continue
      const root = join(storageRoot, entry)
      const files = await walk(root)
      let bytes = 0
      for (const file of files) {
        try {
          bytes += (await stat(file)).size
        } catch {
          // Ignore racing writes.
        }
      }
      summary.push({ path: entry, bytes, files: files.length })
    }
  }
  await writeFile(join(ctx.reportDir, "globalStorage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
}

async function walk(root: string): Promise<string[]> {
  const results: string[] = []
  if (!existsSync(root)) return results
  for (const entry of await readdir(root)) {
    const path = join(root, entry)
    const info = await stat(path)
    if (info.isDirectory()) {
      results.push(...await walk(path))
    } else {
      results.push(path)
    }
  }
  return results
}

function powershellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function safeName(value: string) {
  return value.replace(/[\\/:\s]+/g, "_").replace(/[^A-Za-z0-9._-]/g, "_")
}
