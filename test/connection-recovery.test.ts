import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("ChipMate direct runtime wiring", () => {
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const coordinatorSource = readFileSync(join(import.meta.dir, "..", "src", "completion-request-coordinator.ts"), "utf8")
  const settingsSource = readFileSync(join(import.meta.dir, "..", "src", "settings.ts"), "utf8")

  test("creates one workspace-host direct agent instead of a remote ChipMate client", () => {
    expect(extensionSource).toContain("new DirectAgentClient")
    expect(extensionSource).toContain("new SkillRegistry")
    expect(extensionSource).toContain("new ToolRuntime")
    expect(extensionSource).toContain("new AuditLog")
    expect(extensionSource).toContain("getApiKey: () => readProviderApiKey(context)")
    expect(extensionSource).not.toContain("RemoteChipMateClient")
    expect(extensionSource).not.toContain("LocalAnalysisBridge")
  })

  test("provider state is derived from chipmate provider settings and refreshes the chat view", () => {
    const start = extensionSource.indexOf("const refreshProviderState = async")
    const end = extensionSource.indexOf("const connectWithSettings", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("settings.provider.apiBaseUrl")
    expect(body).toContain("settings.provider.chatModel")
    expect(body).toContain("directClient.health()")
    expect(body).toContain("setConnectionState(health.state, health.detail")
    expect(body).toContain("await chatProvider.refresh()")
  })

  test("webview provider save maps the legacy form shape onto direct provider settings and API key storage", () => {
    expect(settingsSource).toContain('await config.update("provider.apiBaseUrl"')
    expect(settingsSource).toContain('await config.update("provider.chatModel"')
    expect(settingsSource).toContain("if (connectionInputHasPassword(input)) await writeProviderApiKey")
    expect(settingsSource).toContain('export const PASSWORD_SECRET_KEY = "chipmate.provider.legacyPassword"')
    expect(chatViewSource).toContain("function connectionSettingsFromMessage")
    expect(chatViewSource).toContain('Object.prototype.hasOwnProperty.call(message, "password")')
    expect(chatViewSource).toContain("requestId?: number")
    expect(chatViewSource).toContain("this.connectWithSettings(connectionSettingsFromMessage(message), message.requestId)")
    expect(chatViewSource).toContain('type: "connectionStatus"')
    expect(chatViewSource).toContain("connectionState: this.connectionState")
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
    expect(body).toContain("context.globalState.update(EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY, reloadVersion)")
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

  test("provider API key saves apply the active RAG configuration", () => {
    const start = extensionSource.indexOf("vscode.commands.registerCommand(CHIPMATE_COMMANDS.setProviderApiKey")
    const end = extensionSource.indexOf("vscode.commands.registerCommand(CHIPMATE_COMMANDS.completionRunDirectAblation", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("promptAndSaveProviderApiKey(context)")
    expect(body).toContain('await refreshAfterProviderCredentialChange("command")')
    expect(extensionSource).toContain("await codeGraph.applyRagConfiguration()")
    expect(body).not.toContain("chatProvider.refreshState()")
    expect(body).not.toContain("refreshRagConfiguration")
  })

  test("provider API key secret changes refresh RAG and provider state across windows", () => {
    expect(extensionSource).toContain("PROVIDER_API_KEY_SECRET_KEY")
    expect(extensionSource).toContain("context.secrets.onDidChange")
    expect(extensionSource).toContain("if (event.key !== PROVIDER_API_KEY_SECRET_KEY) return")
    expect(extensionSource).toContain('refreshAfterProviderCredentialChange("secret-storage")')
    expect(extensionSource).toContain("let providerCredentialRefreshInFlight")
    expect(extensionSource).toContain("if (providerCredentialRefreshInFlight) return providerCredentialRefreshInFlight")
    expect(extensionSource).toContain('refreshAfterProviderCredentialChange("connect-settings")')
    expect(extensionSource).toContain('refreshAfterProviderCredentialChange("test-settings")')
  })

  test("skills and permission settings refresh lightweight state without rebuilding the webview layout", () => {
    expect(extensionSource).toContain('event.affectsConfiguration("chipmate.skills")')
    expect(extensionSource).toContain("skills.invalidate()")
    expect(extensionSource).toContain('event.affectsConfiguration("chipmate.permissions")')
    expect(extensionSource).toContain('event.affectsConfiguration("chipmate.tools")')
    expect(extensionSource).toContain("chatProvider.refreshState()")
    expect(extensionSource).toContain('event.affectsConfiguration("chipmate.provider")')
    expect(extensionSource).toContain("void refreshProviderState().catch")
    expect(chatViewSource).toContain("savePermissionMode")
    expect(chatViewSource).toContain("saveToolsEnabled")
    expect(chatViewSource).toContain("tools: settings.tools")
    expect(chatViewSource).toContain("saveSkillsSettings")
    expect(chatHtmlSource).toContain("permissionStatusPill")
    expect(chatHtmlSource).toContain("data-tools-enabled")
    expect(chatHtmlSource).toContain("模型工具调用")
    expect(chatHtmlSource).toContain("skillsStatusPill")
  })

  test("completion logs request lifecycle and direct-provider skip reasons", () => {
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
      "skip: direct completion model is not configured",
      "skip: empty line at column 0",
      "reason=vscode-token",
      "returned source=${source}",
      "triggerInlineSuggestRefresh",
    ]) {
      expect(completionSource).toContain(marker)
    }
    expect(completionSource).not.toContain("skip: no active remote client")
  })
})
