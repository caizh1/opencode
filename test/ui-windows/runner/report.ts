import { existsSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TestConfig } from "./config.js"
import type { RunContext } from "./environment.js"

export type TestStatus = "passed" | "failed" | "skipped"

export type TestResult = {
  suite: string
  name: string
  status: TestStatus
  durationMs: number
  detail?: string
  error?: string
}

export class Reporter {
  private readonly results: TestResult[] = []

  constructor(private readonly ctx: RunContext) {}

  async step(suite: string, name: string, fn: () => Promise<string | void> | string | void) {
    const started = Date.now()
    try {
      const detail = await fn()
      const result: TestResult = { suite, name, status: "passed", durationMs: Date.now() - started, detail: detail || undefined }
      this.results.push(result)
      return result
    } catch (error) {
      const result: TestResult = {
        suite,
        name,
        status: "failed",
        durationMs: Date.now() - started,
        error: redact(error instanceof Error ? error.stack || error.message : String(error), this.ctx.config),
      }
      this.results.push(result)
      return result
    }
  }

  skip(suite: string, name: string, detail: string) {
    const result: TestResult = { suite, name, status: "skipped", durationMs: 0, detail }
    this.results.push(result)
    return result
  }

  hasFailures() {
    return this.results.some((result) => result.status === "failed")
  }

  all() {
    return [...this.results]
  }

  async write() {
    await mkdir(this.ctx.reportDir, { recursive: true })
    const results = this.results.map((result) => ({
      ...result,
      detail: result.detail ? redact(result.detail, this.ctx.config) : undefined,
      error: result.error ? redact(result.error, this.ctx.config) : undefined,
    }))
    await writeFile(join(this.ctx.reportDir, "test-results.json"), `${JSON.stringify(results, null, 2)}\n`)
    await writeFile(join(this.ctx.reportDir, "functional-checks.json"), redact(`${JSON.stringify(this.ctx.functionalChecks, null, 2)}\n`, this.ctx.config))
    const counts = {
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
    }
    const functionalCounts = {
      passed: this.ctx.functionalChecks.filter((check) => check.status === "passed").length,
      failed: this.ctx.functionalChecks.filter((check) => check.status === "failed").length,
      skipped: this.ctx.functionalChecks.filter((check) => check.status === "skipped").length,
    }
    const summary = {
      runId: this.ctx.runId,
      mode: this.ctx.mode,
      generatedAt: new Date().toISOString(),
      counts,
      workspace: this.ctx.workspace,
      extensionId: this.ctx.config.extensionId,
      installedExtensionVersion: this.ctx.installedExtensionVersion ?? null,
      installMode: this.ctx.config.installMode,
      profileMode: this.ctx.config.profileMode,
      providerMode: this.ctx.config.provider.apiBaseUrl ? "intranet-or-configured" : "offline-or-unconfigured",
      vscodeCli: {
        status: this.ctx.vscodeDiscovery?.status ?? "not-found",
        configuredCodeCmd: this.ctx.configuredCodeCmd,
        effectiveCodeCmd: this.ctx.effectiveCodeCmd ?? null,
        effectiveCodeCmdStrategy: this.ctx.effectiveCodeCmdStrategy ?? null,
        reason: this.ctx.vscodeDiscovery?.reason ?? "VS Code CLI discovery not started",
      },
      targetWindow: this.ctx.targetWindow ? {
        hwnd: this.ctx.targetWindow.hwnd,
        pid: this.ctx.targetWindow.pid,
        processName: this.ctx.targetWindow.processName,
        windowTitle: this.ctx.targetWindow.windowTitle,
        score: this.ctx.targetWindow.score,
        reasons: this.ctx.targetWindow.reasons,
      } : null,
      uiAutomation: summarizeUiAutomation(this.ctx.uiSteps),
      functionalChecks: this.ctx.functionalChecks,
      functionalCounts,
      failed: results.filter((result) => result.status === "failed"),
    }
    await writeFile(join(this.ctx.reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    await writeFile(join(this.ctx.reportDir, "summary.md"), renderSummary(summary, results))
    await writeRedactionReport(this.ctx)
  }
}

export function redact(input: string, config?: TestConfig) {
  let output = input
  const sensitiveValues: Array<[string | undefined, string]> = [
    [config?.provider.apiKey, "[REDACTED_API_KEY]"],
    [process.env.CHIPMATE_UI_PROVIDER_API_KEY, "[REDACTED_API_KEY]"],
    [process.env.USERPROFILE, "[REDACTED_USERPROFILE]"],
    [process.env.HOME, "[REDACTED_USERPROFILE]"],
    [process.env.USERNAME, "[REDACTED_USER]"],
    [process.env.USER, "[REDACTED_USER]"],
    [process.env.COMPUTERNAME, "[REDACTED_HOST]"],
  ]
  for (const [value, replacement] of sensitiveValues) {
    if (value && value.length > 2) output = output.split(value).join(replacement)
  }
  output = output.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]")
  output = output.replace(/"apiKey"\s*:\s*"[^"]*"/gi, '"apiKey": "[REDACTED]"')
  output = output.replace(/(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}/g, "$1[REDACTED_TOKEN]")
  return output
}

async function writeRedactionReport(ctx: RunContext) {
  const changed: string[] = []
  for (const file of await textFiles(ctx.reportDir)) {
    const before = await readFile(file, "utf8")
    const after = redact(before, ctx.config)
    if (after !== before) {
      await writeFile(file, after)
      changed.push(file)
    }
  }
  writeFileSync(join(ctx.reportDir, "redaction-report.json"), `${JSON.stringify({
    redactedAt: new Date().toISOString(),
    files: changed,
  }, null, 2)}\n`)
}

async function textFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await textFiles(path))
    } else if (/\.(?:json|md|txt|log)$/i.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function renderSummary(summary: {
  runId: string
  mode: string
  generatedAt: string
  counts: { passed: number; failed: number; skipped: number }
  workspace: string
  extensionId: string
  installedExtensionVersion: string | null
  installMode: string
  profileMode: string
  providerMode: string
  vscodeCli?: {
    status: string
    configuredCodeCmd: string
    effectiveCodeCmd: string | null
    effectiveCodeCmdStrategy: string | null
    reason: string
  }
  targetWindow: {
    hwnd: string
    pid: number
    processName: string
    windowTitle: string
    score?: number
    reasons?: string[]
  } | null
  uiAutomation?: {
    total: number
    failed: number
    lastFailure?: string
    fallbackUsed?: boolean
    classification: string
  }
  functionalChecks: RunContext["functionalChecks"]
  functionalCounts: { passed: number; failed: number; skipped: number }
}, results: TestResult[]) {
  const lines = [
    `# ChipMate Windows UI Test Report`,
    "",
    `- Run ID: ${summary.runId}`,
    `- Generated: ${summary.generatedAt}`,
    `- Mode: ${summary.mode}`,
    `- Install mode: ${summary.installMode}`,
    `- Profile: ${summary.profileMode}`,
    `- Provider mode: ${summary.providerMode}`,
    `- Workspace: ${summary.workspace}`,
    `- VS Code CLI: ${summary.vscodeCli ? vscodeCliSummary(summary.vscodeCli) : "not discovered"}`,
    `- Extension: ${summary.extensionId}${summary.installedExtensionVersion ? `@${summary.installedExtensionVersion}` : " (not found)"}`,
    `- Target window: ${summary.targetWindow ? `${summary.targetWindow.processName}[${summary.targetWindow.pid}] ${summary.targetWindow.windowTitle}` : "not selected"}`,
    `- UI automation: ${uiAutomationSummary(summary.uiAutomation)}`,
    `- Functional checks: ${summary.functionalCounts.passed} passed, ${summary.functionalCounts.failed} failed, ${summary.functionalCounts.skipped} skipped`,
    `- Passed: ${summary.counts.passed}`,
    `- Failed: ${summary.counts.failed}`,
    `- Skipped: ${summary.counts.skipped}`,
    "",
    "## Results",
    "",
    "| Suite | Test | Status | Detail |",
    "|---|---|---|---|",
  ]
  for (const result of results) {
    lines.push(`| ${escapeMd(result.suite)} | ${escapeMd(result.name)} | ${result.status} | ${escapeMd(result.error ?? result.detail ?? "")} |`)
  }
  lines.push("")
  lines.push("## Validated Functional Checks")
  lines.push("")
  lines.push("| Area | Intent | Status | Expected | Observed | Evidence |")
  lines.push("|---|---|---|---|---|---|")
  for (const check of summary.functionalChecks) {
    lines.push(`| ${escapeMd(check.area)} | ${escapeMd(check.intent)} | ${check.status} | ${escapeMd(check.expected)} | ${escapeMd(check.observed)} | ${escapeMd(check.evidence.join("; "))} |`)
  }
  lines.push("")
  lines.push("## Evidence")
  lines.push("")
  lines.push("- See `vscode-discovery.json` for VS Code CLI discovery candidates and validation errors.")
  lines.push("- See `logs/` for VS Code Output and Extension Host evidence.")
  lines.push("- See `window-candidates.json` for UI window discovery and activation evidence.")
  lines.push("- See `ui-steps.json` and `screenshots/` for command palette focus, UIAutomation, and target-window evidence.")
  lines.push("- See `functional-checks.json` for feature-level expected/observed assertions.")
  lines.push("- See `globalStorage-summary.json` for real profile storage summary.")
  lines.push("- See `environment.json`, `vscode-version.txt`, and `installed-extensions.txt` for target machine state.")
  return `${lines.join("\n")}\n`
}

function summarizeUiAutomation(steps: RunContext["uiSteps"]) {
  if (steps.length === 0) {
    return {
      total: 0,
      failed: 0,
      classification: "not started",
    }
  }
  const failures = steps.filter((step) => step.status === "failed")
  const lastFailure = failures.at(-1)?.error
  const fallbackUsed = steps.some((step) => step.automation?.fallbackUsed === true)
  return {
    total: steps.length,
    failed: failures.length,
    lastFailure,
    fallbackUsed,
    classification: failures.length === 0 && fallbackUsed ? "guarded keyboard fallback used" : classifyUiAutomationFailure(lastFailure),
  }
}

function vscodeCliSummary(cli: { status: string; effectiveCodeCmd: string | null; effectiveCodeCmdStrategy?: string | null; reason: string }) {
  if (cli.status === "selected" && cli.effectiveCodeCmd) return `${cli.effectiveCodeCmd}${cli.effectiveCodeCmdStrategy ? ` (${cli.effectiveCodeCmdStrategy})` : ""}`
  return `not found (${cli.reason})`
}

function uiAutomationSummary(summary: { total: number; failed: number; classification: string } | undefined) {
  if (!summary || summary.total === 0) return "not started"
  return `${summary.classification} (${summary.failed}/${summary.total} failed)`
}

function classifyUiAutomationFailure(error: string | undefined) {
  if (!error) return "ok"
  if (/Could not uniquely identify|window discovery|target window/i.test(error)) return "VS Code window discovery failed"
  if (/UI automation focus failure|foreground/i.test(error)) return "VS Code activation/focus failed"
  if (/Command palette did not open|UIAutomation Edit control|command palette/i.test(error)) return "command palette did not open"
  if (/ChipMate|command/i.test(error)) return "plugin command response failed"
  return "UI automation failed"
}

function escapeMd(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")
}
