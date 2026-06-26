import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Windows UI runner safety gates", () => {
  const environmentSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "runner", "environment.ts"), "utf8")
  const reportSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "runner", "report.ts"), "utf8")
  const smokeSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "runner", "suites", "smoke.test.ts"), "utf8")
  const functionalSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "runner", "functional.ts"), "utf8")
  const readmeSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "windows", "README-WINDOWS-OFFLINE-UI-TEST.md"), "utf8")
  const configExampleSource = readFileSync(join(import.meta.dir, "..", "test", "ui-windows", "windows", "test-config.example.json"), "utf8")

  test("does not select a target window only because it appeared after launch", () => {
    expect(environmentSource).toContain("let requiredMatch = false")
    expect(environmentSource).toContain("score += 20")
    expect(environmentSource).toContain("reasons.push(\"new visible window after launch\")")
    expect(environmentSource).toContain("candidate.requiredMatch === true")
    expect(environmentSource).not.toContain("scored.filter((candidate) => (candidate.score ?? 0) > 0)")
  })

  test("guards the VS Code command palette before text entry", () => {
    expect(environmentSource).toContain("Add-Type -AssemblyName UIAutomationClient")
    expect(environmentSource).toContain("Find-CommandPaletteInput")
    expect(environmentSource).toContain("commandPaletteMatch")
    expect(environmentSource).toContain("UI automation focus failure")
    expect(environmentSource).toContain("Assert-ForegroundTarget")
    expect(environmentSource).toContain("Send-PaletteShortcut 'F1' '{F1}'")
    expect(environmentSource).toContain("Send-PaletteShortcut 'CtrlShiftP' '^+p'")
    expect(environmentSource).toContain("GuardedKeyboardFallbackClipboardPaste")
    expect(environmentSource).toContain("uia-palette-not-found")
    expect(environmentSource).toContain("foregroundBeforePaste")
    expect(environmentSource).toContain("foregroundBeforeEnter")
    expect(environmentSource).toContain("ClipboardPasteIntoVerifiedCommandPaletteInput")
    expect(environmentSource).toContain("\"-Sta\", \"-File\", scriptPath")
    expect(environmentSource).not.toContain("Set-Clipboard -Value \" + powershellString(`>${commandLabel}`)")
  })

  test("writes actionable UI automation evidence to reports", () => {
    expect(environmentSource).toContain("ui-steps.json")
    expect(environmentSource).toContain("captureWindowScreenshot")
    expect(environmentSource).toContain("afterShortcut")
    expect(environmentSource).toContain("afterPaste")
    expect(environmentSource).toContain("afterEnter")
    expect(reportSource).toContain("VS Code activation/focus failed")
    expect(reportSource).toContain("command palette did not open")
    expect(reportSource).toContain("guarded keyboard fallback used")
    expect(readmeSource).toContain("chipmate-ui-runner-windows-caizh")
    expect(readmeSource).toContain("Windows UIAutomation")
  })

  test("writes feature-level functional assertions", () => {
    expect(environmentSource).toContain("functionalChecks")
    expect(environmentSource).toContain("functional-checks.json")
    expect(functionalSource).toContain("recordFunctionalAssertion")
    expect(reportSource).toContain("Validated Functional Checks")
    expect(reportSource).toContain("functionalCounts")
    expect(readmeSource).toContain("functional-checks.json")
  })

  test("smoke suite validates observable feature outcomes", () => {
    expect(smokeSource).toContain("ChipMate UI smoke ${ctx.runId}")
    expect(smokeSource).toContain("writeCompletionProbe")
    expect(smokeSource).toContain("qwen-autocomplete requestId")
    expect(smokeSource).toContain("[view] ChipMate using chipmate.sidebar")
    expect(smokeSource).toContain("Ask ChipMate About Current File")
    expect(smokeSource).toContain("runtimeFailureMarker")
    expect(smokeSource).not.toContain("uiAutomation=command-palette-input-confirmed")
  })

  test("discovers VS Code CLI before UI automation starts", () => {
    expect(configExampleSource).toContain('"codeCmd": "auto"')
    expect(environmentSource).toContain("discoverVsCodeCli")
    expect(environmentSource).toContain("vscode-discovery.json")
    expect(environmentSource).toContain('runCommand("where.exe", [name]')
    expect(environmentSource).toContain("%LOCALAPPDATA%")
    expect(environmentSource).toContain("%ProgramFiles%")
    expect(environmentSource).toContain("%ProgramFiles(x86)%")
    expect(environmentSource).toContain("effectiveCodeCmd")
    expect(environmentSource).toContain("effectiveCodeCmdStrategy")
    expect(environmentSource).toContain("candidate.strategy = result.strategy")
    expect(reportSource).toContain("VS Code CLI:")
    expect(reportSource).toContain('classification: "not started"')
  })

  test("invokes Windows cmd and bat scripts through verbatim cmd.exe call with PowerShell fallback", () => {
    expect(environmentSource).toContain("const cmdBody = `call ${inner}`")
    expect(environmentSource).toContain('args: ["/d", "/c", cmdBody]')
    expect(environmentSource).toContain("commandLine: `${shell} /d /c ${cmdBody}`")
    expect(environmentSource).toContain('strategy: "cmd-call-verbatim"')
    expect(environmentSource).toContain("windowsVerbatimArguments: true")
    expect(environmentSource).toContain('strategy === "powershell-call"')
    expect(environmentSource).toContain('strategy: "powershell-call"')
    expect(environmentSource).not.toContain('args: ["/d", "/s", "/c", inner]')
    expect(environmentSource).not.toContain("commandLine: `${shell} /d /s /c ${inner}`")
    expect(environmentSource).not.toContain('args: ["/d", "/s", "/c", cmdBody]')
  })
})
