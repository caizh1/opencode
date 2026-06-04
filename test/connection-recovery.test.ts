import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("connection and stale-session recovery wiring", () => {
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const coordinatorSource = readFileSync(join(import.meta.dir, "..", "src", "completion-request-coordinator.ts"), "utf8")

  test("separates connection probes from applying an active client", () => {
    expect(extensionSource).toContain("async function probeClient")
    expect(extensionSource).toContain("const connectClient = async")
    expect(extensionSource).toContain("client = next")
    expect(extensionSource).toContain("void chatProvider.refresh()")
  })

  test("test connection does not replace the active client or refresh sessions", () => {
    const start = extensionSource.indexOf("const testClientOnly = async")
    const end = extensionSource.indexOf("const connect =", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("Test succeeded")
    expect(body).toContain("Click Connect to use this server")
    expect(body).not.toContain("client =")
    expect(body).not.toContain("chatProvider.refresh")
  })

  test("activation silently restores the saved connection", () => {
    const start = extensionSource.indexOf("const restoreSavedConnection = async")
    const end = extensionSource.indexOf("let chatProvider", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("[connect] Restoring saved OpenCode connection")
    expect(body).toContain("const next = await createClient()")
    expect(body).toContain("await connectClient(next)")
    expect(body).not.toContain("promptAndSaveConnectionSettings")
    expect(extensionSource).toContain("void restoreSavedConnection().catch")
  })

  test("webview connection reuses saved passwords when password is omitted", () => {
    const start = extensionSource.indexOf("const connectWithSettings = async")
    const end = extensionSource.indexOf("const restoreSavedConnection = async", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("connectionInputHasPassword(input) ? input.password?.trim() || undefined : await readRemotePassword(context)")
    expect(body).toContain("saveConnectionSettings(context, input)")
    expect(body).toContain("new RemoteOpenCodeClient(settings, password)")
    expect(chatViewSource).toContain("function connectionSettingsFromMessage")
    expect(chatViewSource).toContain('Object.prototype.hasOwnProperty.call(message, "password")')
  })

  test("prompted connect saves connection settings only after a successful probe", () => {
    const start = extensionSource.indexOf("const connect = async")
    const end = extensionSource.indexOf("const connectWithSettings = async", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("const input = await promptConnectionSettings()")
    expect(body).toContain("await connectClient(next, () => saveConnectionSettings(context, input))")
    expect(body).not.toContain("promptAndSaveConnectionSettings")
  })

  test("remote refresh failures leave connected state and clear the active client", () => {
    expect(extensionSource).toContain("const clearClient = (target: RemoteOpenCodeClient)")
    expect(extensionSource).toContain("if (client === target) client = undefined")
    expect(extensionSource).toContain("clearClient,")

    expect(chatViewSource).toContain("clearClient: (client: RemoteOpenCodeClient) => void")
    expect(chatViewSource).toContain('this.reportRemoteConnectionFailure(client, "Failed to load sessions", sessionResult.reason)')
    expect(chatViewSource).toContain('this.reportRemoteConnectionFailure(client, "Failed to load selected session", error)')
    expect(chatViewSource).toContain("this.deps.clearClient(client)")
    expect(chatViewSource).toContain("this.deps.setConnectionState(state, detail)")
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

  test("RAG API key saves apply the active configuration", () => {
    const start = extensionSource.indexOf("promptRagApiKey: async")
    const end = extensionSource.indexOf("connectWithSettings,", start)
    const body = extensionSource.slice(start, end)

    expect(body).toContain("promptAndSaveRagApiKey(context)")
    expect(body).toContain("if (saved) await codeGraph.applyRagConfiguration()")
    expect(body).not.toContain("refreshRagConfiguration")
  })

  test("remote failure state distinguishes auth failures from connection errors", () => {
    expect(chatViewSource).toContain("RemoteOpenCodeAuthError")
    expect(chatViewSource).toContain("RemoteOpenCodeConnectionError")
    expect(chatViewSource).toContain('return "authFailed"')
    expect(chatViewSource).toContain('return "error"')
    expect(chatViewSource).toContain("isRequestTimeoutError")
  })

  test("completion retries once when its remote session vanished", () => {
    expect(completionSource).toContain("isSessionNotFoundError")
    expect(completionSource).toContain("this.sessionID = undefined")
    expect(completionSource).toContain("Completion session was not found; retrying with a new session.")
    expect(completionSource).toContain("return this.sendCompletionWithSession(client, prompt, settings, signal)")
  })

  test("completion logs request lifecycle and debug skip reasons", () => {
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
      "skip: no active remote client",
      "skip: empty line at column 0",
      "reason=vscode-token",
      "returned source=${source}",
      "triggerInlineSuggestRefresh",
    ]) {
      expect(completionSource).toContain(marker)
    }
  })
})
