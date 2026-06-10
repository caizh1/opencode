import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("ChipMate runtime wiring", () => {
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chipmate-chat-view.ts"), "utf8")
  const htmlSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-html.ts"), "utf8")
  const scriptSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-script.ts"), "utf8")
  const styleSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-styles.ts"), "utf8")
  const iconSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-icons.ts"), "utf8")
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const coordinatorSource = readFileSync(join(import.meta.dir, "..", "src", "completion-request-coordinator.ts"), "utf8")

  test("does not wire remote server connection probes or restored sessions", () => {
    expect(extensionSource).not.toContain("probeClient")
    expect(extensionSource).not.toContain("restoreSavedConnection")
    expect(extensionSource).not.toContain("RemoteOpenCodeClient")
    expect(extensionSource).not.toContain("opencode")
    expect(chatViewSource).not.toContain("RemoteOpenCodeClient")
    expect(chatViewSource).not.toContain("connectWithSettings")
  })

  test("prompts for a full window reload after extension upgrades", () => {
    const start = extensionSource.indexOf("function registerExtensionUpdateReloadPrompt")
    const end = extensionSource.indexOf("function shouldPromptReloadForInstalledVersion", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("vscode.extensions.onDidChange")
    expect(body).toContain("void checkForInstalledUpdate().catch")
    expect(body).toContain("EXTENSION_UPDATE_RELOAD_PROMPT_KEY")
    expect(body).toContain("EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY")
    expect(body).toContain("EXTENSION_UPDATE_LAST_ACTIVATED_KEY")
    expect(body).toContain("previousActivatedVersion")
    expect(body).toContain("reloadPromptTargetVersion")
    expect(body).toContain("acceptedVersion !== runningVersion")
    expect(body).toContain("promptedVersionsThisActivation")
    expect(body).toContain("showInformationMessage")
    expect(body).toContain("RELOAD_WINDOW_ACTION")
    expect(body).toContain('executeCommand("workbench.action.reloadWindow")')
    expect(body).not.toContain("restartExtension")
  })

  test("debounces RAG configuration apply events", () => {
    expect(extensionSource).toContain("RAG_CONFIG_REFRESH_DEBOUNCE_MS")
    expect(extensionSource).toContain("INTERNAL_RAG_CONFIG_CHANGE_SUPPRESSION_MS")
    expect(extensionSource).toContain("const scheduleRagConfigurationApply")
    expect(extensionSource).toContain("if (ragConfigurationApplyTimer) clearTimeout(ragConfigurationApplyTimer)")
    expect(extensionSource).toContain("suppressNextRagConfigurationApply")
    expect(extensionSource).toContain("Date.now() < ignoreRagConfigurationChangesUntil")
    expect(extensionSource).toContain("void codeGraph.applyRagConfiguration().catch")
    expect(extensionSource).toContain("scheduleRagConfigurationApply()")
    expect(extensionSource).not.toContain("codeGraph.refreshRagConfiguration()")
  })

  test("RAG API key command applies the active configuration", () => {
    const start = extensionSource.indexOf('vscode.commands.registerCommand("chipmate.rag.setApiKey"')
    const end = extensionSource.indexOf('vscode.commands.registerCommand("chipmate.codeGraph.index"', start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("promptAndSaveRagApiKey(context)")
    expect(body).toContain("await codeGraph.applyRagConfiguration()")
    expect(body).not.toContain("refreshRagConfiguration")
  })

  test("chat view uses direct model agent runtime, skills, and workspace tools", () => {
    for (const marker of [
      "new OpenAIChatClient",
      "new AgentRuntime",
      "new ToolRegistry",
      "new SkillsRuntime",
      "new McpStdioRuntime",
      "new WorkspaceTools",
      "fetchChipMateCatalog",
      "downloadChipMateCatalogPackage",
      "this.installer.installZip",
      "this.installer.rollback",
    ]) {
      expect(chatViewSource).toContain(marker)
    }
  })

  test("chat view asks the user before executing approval-gated tools", () => {
    expect(chatViewSource).toContain("requestToolApproval")
    expect(chatViewSource).toContain("vscode.window.showWarningMessage")
    expect(chatViewSource).toContain("Allow Once")
    expect(chatViewSource).toContain("Always Allow")
    expect(chatViewSource).toContain("runSkillScript")
    expect(chatViewSource).toContain("runMcpTool")
    expect(chatViewSource).toContain("runShell")
    expect(chatViewSource).toContain("writeWorkspace")
  })

  test("chat view serializes all icons used by dynamic webview controls", () => {
    for (const iconName of ["add", "attach", "chat", "discard"]) {
      expect(iconSource).toContain(`"${iconName}"`)
    }
    expect(scriptSource).toContain('icon("add")')
    expect(scriptSource).toContain('icon("attach")')
    expect(scriptSource).toContain('icon("chat")')
    expect(scriptSource).toContain('icon("discard")')
  })

  test("chat view uses compact glass chrome and a single session selector", () => {
    expect(htmlSource).toContain('class="glassFrame"')
    expect(scriptSource).toContain('class="sessionBar"')
    expect(scriptSource).toContain('id="sessionSelect"')
    expect(scriptSource).toContain('id="newSession"')
    expect(scriptSource).toContain("displaySessionTitle")
    expect(scriptSource).toContain("normalizedSessionTitle")
    expect(scriptSource).not.toContain('id="sessions"')
    expect(scriptSource).not.toContain('byId("sessions")')
    expect(styleSource).not.toContain("position: absolute")
    expect(styleSource.match(/\\.brandBar\\s*\\{[^}]*border-bottom/s)).toBeNull()
  })

  test("completion is direct-model only and keeps request lifecycle logging", () => {
    expect(completionSource).toContain("new CompletionModelClient(input.settings, apiKey)")
    expect(completionSource).not.toContain("RemoteOpenCodeClient")
    expect(completionSource).not.toContain("isSessionNotFoundError")
    expect(completionSource).not.toContain("sendCompletionWithSession")
    for (const marker of [
      "triggered",
      "scheduled",
      "reuse-pending",
      "sent",
      "received",
      "empty",
      "edit-rejected",
      "returned",
      "cancelled",
      "Completion failed",
    ]) {
      expect(`${completionSource}\n${coordinatorSource}`).toContain(marker)
    }
    for (const marker of [
      "skip: completion disabled",
      "skip: non-file document",
      "skip: direct completion API base URL is not configured",
      "skip: empty line at column 0",
      "reason=vscode-token",
      "returned source=${source}",
      "triggerInlineSuggestRefresh",
    ]) {
      expect(completionSource).toContain(marker)
    }
  })
})
