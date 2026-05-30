import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("chat history flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
  const chatStreamSource = readFileSync(join(import.meta.dir, "..", "src", "chat-stream.ts"), "utf8")

  test("posts sessions and loading state to the webview", () => {
    expect(chatViewSource).toContain("sessions: this.sessions")
    expect(chatViewSource).toContain("currentSessionID: this.sessionID")
    expect(chatViewSource).toContain("loadingMessages: this.loadingMessages")
  })

  test("loads messages when a session is selected", () => {
    expect(chatViewSource).toContain('{ type: "selectSession"; sessionID: string }')
    expect(chatViewSource).toContain("private async selectSession")
    expect(chatViewSource).toContain("await this.loadSessionMessages(client, sessionID)")
    expect(chatViewSource).toContain("client.getMessages(sessionID)")
  })

  test("refreshes session history after session-changing actions", () => {
    expect(chatViewSource).toContain("private async refreshSessionList")
    expect(chatViewSource).toContain("await this.refreshSessionList(client)")
    expect(chatViewSource).toContain("client.listSessions()")
    expect(chatViewSource).toContain("this.isVisibleChatSession(session)")
    expect(chatViewSource).toContain("isPluginChatSession(session)")
  })

  test("hides inline completion sessions from chat history", () => {
    expect(chatViewSource).toContain("isInlineCompletionSession")
    expect(chatViewSource).toContain("hiddenCompletionSessions")
    expect(chatViewSource).toContain("if (isInlineCompletionSession(session)) return false")
  })

  test("hides persisted inline completion prompts when old sessions are selected", () => {
    expect(chatViewSource).toContain("messages.some(isInlineCompletionMessage)")
    expect(chatViewSource).toContain("private async hideCompletionSession")
    expect(chatViewSource).toContain("this.sessions = this.sessions.filter((session) => session.id !== sessionID)")
    expect(chatViewSource).toContain("this.reconcileSessionSelection()")
  })

  test("hides external OpenCode sessions from plugin chat history", () => {
    expect(chatViewSource).toContain("CHAT_SESSION_TITLE")
    expect(chatViewSource).toContain("hiddenExternalSessions")
    expect(chatViewSource).toContain("messages.some(isExternalChatMessage)")
    expect(chatViewSource).toContain("private async hideExternalSession")
    expect(chatViewSource).toContain("Hidden external OpenCode session")
  })

  test("recovers when the remote server has lost the selected session", () => {
    expect(chatViewSource).toContain("isSessionNotFoundError")
    expect(chatViewSource).toContain("private reconcileSessionSelection")
    expect(chatViewSource).toContain("this.sessions.some((session) => session.id === this.sessionID)")
    expect(chatViewSource).toContain("private async loadSelectedSessionMessages")
    expect(chatViewSource).toContain("private async recoverMissingSession")
  })

  test("retries sends with a new session after stale-session errors", () => {
    expect(chatViewSource).toContain("let preparedMessage")
    expect(chatViewSource).toContain("private async sendPreparedMessage")
    expect(chatViewSource).toContain("Selected remote session was not found; retrying with a new session.")
    expect(chatViewSource).toContain("this.clearMissingSession(this.sessionID)")
  })

  test("streams chat replies through OpenCode events with blocking fallback", () => {
    expect(chatViewSource).toContain("ensureEventSubscription")
    expect(chatViewSource).toContain("subscribeEvents")
    expect(chatViewSource).toContain("sendMessageAsync")
    expect(chatViewSource).toContain("client.sendMessage({")
    expect(chatViewSource).toContain("finishStreamingSession")
    expect(chatStreamSource).toContain('case "message.part.updated"')
    expect(chatStreamSource).toContain('case "session.status"')
  })

  test("renders markdown, code copy, and thinking state in the webview", () => {
    expect(chatHtmlSource).toContain("function renderMarkdownInto")
    expect(chatHtmlSource).toContain("function codeBlock")
    expect(chatHtmlSource).toContain("async function copyCode")
    expect(chatHtmlSource).toContain("function thinkingNode")
    expect(chatHtmlSource).toContain("hasAssistantContentAfterLastUser")
  })

  test("collapses reasoning content into a details card", () => {
    expect(chatViewSource).toContain("splitThinkingFromParts(message.parts)")
    expect(chatViewSource).toContain('type: "reasoning"')
    expect(chatViewSource).toContain('title: "Thinking"')
    expect(chatHtmlSource).toContain('part.type !== "reasoning"')
    expect(chatHtmlSource).toContain('part.type === "reasoning" ? " reasoning" : ""')
  })

  test("marks remote server filesystem tool usage", () => {
    expect(chatViewSource).toContain("SERVER_FILESYSTEM_TOOLS")
    expect(chatViewSource).toContain("serverToolWarning")
    expect(chatViewSource).toContain("flaggedSessions")
    expect(chatHtmlSource).toContain("Server tools used")
  })
})
