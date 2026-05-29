import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createChatViewHtml, createNonce } from "../src/chat-html"

describe("chat webview html", () => {
  test("creates CSP-safe alphanumeric nonces", () => {
    for (let index = 0; index < 20; index++) {
      expect(createNonce()).toMatch(/^[A-Za-z0-9]{32}$/)
    }
  })

  test("uses the same nonce in CSP and script tag", () => {
    const html = createChatViewHtml("vscode-resource:", "AbC123")

    expect(html).toContain("script-src 'nonce-AbC123'")
    expect(html).toContain('<script nonce="AbC123">')
  })

  test("contains the webview script smoke-test markers", () => {
    const html = createChatViewHtml("vscode-resource:", "Smoke123")

    expect(html).toContain("acquireVsCodeApi()")
    expect(html).toContain('class="topbar"')
    expect(html).toContain('id="historyToggle"')
    expect(html).toContain('id="sessionList"')
    expect(html).toContain('id="messages"')
    expect(html).toContain("timelineItem")
    expect(html).toContain('class="composer"')
    expect(html).toContain('id="suggestions"')
    expect(html).toContain('id="send"')
    expect(html).toContain('id="guard"')
    expect(html).toContain('id="modelSelect"')
    expect(html).toContain('id="modelTrigger"')
    expect(html).toContain('id="modelMenu"')
    expect(html).toContain('id="refreshModels"')
    expect(html).toContain('id="manualModel"')
    expect(html).toContain('el("attach").addEventListener("click"')
    expect(html).toContain('el("connect").addEventListener("click"')
    expect(html).toContain('el("test").addEventListener("click"')
    expect(html).toContain('let pendingAction = ""')
    expect(html).toContain('pendingAction = type === "testWithSettings" ? "test" : "connect"')
    expect(html).toContain('type: "selectSession"')
    expect(html).toContain('type: "refreshSessions"')
    expect(html).toContain('type: "searchFilesForMention"')
    expect(html).toContain("renderMarkdownInto")
    expect(html).toContain("copyCode")
    expect(html).toContain("thinking")
    expect(html).toContain("prefers-reduced-motion")
    expect(html).toContain("history-closed history-narrow")
    expect(html).toContain("history-wide")
    expect(html).toContain("flex: 0 0 auto")
    expect(html).toContain("No current file captured")
    expect(html).toContain("autoContext")
    expect(html).toContain("Current: ")
    expect(html).toContain("mentionedFiles")
    expect(html).toContain("Local-only guard active")
    expect(html).toContain("guardSummary")
    expect(html).toContain("guardDetail")
    expect(html).toContain("Server agent not forced")
    expect(html).toContain("Strict agent: ")
    expect(html).toContain("Model: server default")
    expect(html).toContain("requestId")
    expect(html).toContain("Searching workspace files")
    expect(html).toContain("No files found")
    expect(html).toContain("Index truncated")
    expect(html).toContain("server filesystem tool used")
    expect(html).toContain('vscode.postMessage({ type: "ready" })')
    expect(html).toContain("OpenCode Remote UI loading")
  })

  test("does not auto-refresh when the webview resolves", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
    const start = source.indexOf("resolveWebviewView")
    const end = source.indexOf("setConnectionState", start)
    const resolveBody = source.slice(start, end)

    expect(resolveBody).not.toContain("refresh()")
    expect(resolveBody).toContain("postState()")
  })
})
