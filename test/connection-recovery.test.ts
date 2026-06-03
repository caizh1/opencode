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

  test("debounces RAG configuration refresh events", () => {
    expect(extensionSource).toContain("RAG_CONFIG_REFRESH_DEBOUNCE_MS")
    expect(extensionSource).toContain("const scheduleRagConfigurationRefresh")
    expect(extensionSource).toContain("if (ragConfigurationRefreshTimer) clearTimeout(ragConfigurationRefreshTimer)")
    expect(extensionSource).toContain("scheduleRagConfigurationRefresh()")
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
