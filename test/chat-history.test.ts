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
    expect(chatViewSource).toContain("client.getMessages(sessionID, SESSION_MESSAGE_LIMIT, signal)")
  })

  test("refreshes session history after session-changing actions", () => {
    expect(chatViewSource).toContain("private async refreshSessionList")
    expect(chatViewSource).toContain("await this.refreshSessionList(client)")
    expect(chatViewSource).toContain("client.listSessions(signal)")
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

  test("waits for local code graph readiness before sending", () => {
    expect(chatViewSource).toContain("codeGraph: this.deps.codeGraph")
    expect(chatViewSource).toContain("private async waitForCodeGraphReady")
    expect(chatViewSource).toContain("await this.waitForCodeGraphReady(settings)")
    expect(chatViewSource).toContain("this.deps.codeGraph.waitForReady()")
    expect(chatViewSource).toContain("CodeGraphReadinessError")
    expect(chatViewSource).toContain("codeGraphWaitDetail")
    expect(chatViewSource).toContain("[codegraph] blocked send")
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
    expect(chatHtmlSource).toContain("function renderTextMarkdown")
    expect(chatHtmlSource).toContain("mdQuote")
    expect(chatHtmlSource).toContain("mdDivider")
    expect(chatHtmlSource).toContain('const tag = ordered ? "ol" : "ul"')
    expect(chatHtmlSource).toContain("document.createElement(tag)")
    expect(chatHtmlSource).toContain("function appendInlineMarkdown")
    expect(chatHtmlSource).toContain("mdStrong")
    expect(chatHtmlSource).toContain("mdEm")
    expect(chatHtmlSource).toContain("function codeBlock")
    expect(chatHtmlSource).toContain("codeLanguage")
    expect(chatHtmlSource).toContain("async function copyCode")
    expect(chatHtmlSource).toContain('button.textContent = "Copied"')
    expect(chatHtmlSource).toContain("function thinkingNode")
    expect(chatHtmlSource).toContain("hasAssistantContentAfterLastUser")
  })

  test("collapses the composer and context panel", () => {
    expect(chatHtmlSource).toContain('id="composerCollapseToggle"')
    expect(chatHtmlSource).toContain('aria-controls="composerPanel"')
    expect(chatHtmlSource).toContain("let composerCollapsed = false")
    expect(chatHtmlSource).toContain("function toggleComposerPanel")
    expect(chatHtmlSource).toContain("function closeComposerPopups")
    expect(chatHtmlSource).toContain("function renderComposerCollapse")
    expect(chatHtmlSource).toContain("function composerCollapseSummaryText")
    expect(chatHtmlSource).toContain("panel.hidden = composerCollapsed")
    expect(chatHtmlSource).toContain("composerWrap.collapsed")
    expect(chatHtmlSource).toContain("Context ")
    expect(chatHtmlSource).toContain("Guard warning")
  })

  test("supports markdown export from explicit UI and model-classified prompts", () => {
    expect(chatHtmlSource).toContain('id="exportMarkdown"')
    expect(chatHtmlSource).toContain('type: "exportMarkdown", scope: "session"')
    expect(chatHtmlSource).toContain('event.data.type === "exportStatus"')
    expect(chatHtmlSource).toContain("looksLikeExportRequest")
    expect(chatViewSource).toContain('type: "exportMarkdown"')
    expect(chatViewSource).toContain("private async handleSendMessage")
    expect(chatViewSource).toContain("parseExplicitExportCommand(text)")
    expect(chatViewSource).toContain("isExportIntentCandidate(text)")
    expect(chatViewSource).toContain("buildExportIntentPrompt")
    expect(chatViewSource).toContain("parseExportIntentResponse(messageText(response))")
    expect(chatViewSource).toContain("private async exportMarkdown")
    expect(chatViewSource).toContain("formatChatExportMarkdown")
    expect(chatViewSource).toContain("showSaveDialog")
    expect(chatViewSource).toContain("workspace.fs.writeFile")
    expect(chatViewSource).toContain("EXPORT_INTENT_SESSION_TITLE")
    expect(chatViewSource).toContain("hiddenExportIntentSessions")
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
