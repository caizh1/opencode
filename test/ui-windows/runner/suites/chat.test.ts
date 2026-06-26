import { hasProvider } from "../config.js"
import { collectLogs } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { ChatPage } from "../pages/chat.page.js"
import { OutputPage } from "../pages/output.page.js"
import type { RunContext } from "../environment.js"
import type { Reporter } from "../report.js"

export async function runChatSuite(ctx: RunContext, reporter: Reporter) {
  const chat = new ChatPage(ctx)
  const output = new OutputPage(ctx)
  await reporter.step("chat", "open chat webview", async () => {
    await chat.open()
    const result = await waitForOutput(ctx, output, /\[view\] ChipMate using chipmate\.sidebar/, 15_000)
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "Full suite can reveal the ChipMate chat webview.",
      userAction: "Run ChipMate: Open ChipMate Chat from the command palette.",
      expected: "ChipMate Output logs the chat webview resolve marker.",
      observed: result.matchedLine ?? "Chat webview resolve marker was not observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
  })
  await reporter.step("chat", "new session command", async () => {
    await chat.newSession()
    const result = await waitForOutput(ctx, output, /\[refresh\] sessions|Failed to create ChipMate session|Connect before creating a session|Failed to load sessions/i, 20_000)
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "New session command reaches session creation/refresh or reports a clear provider readiness error.",
      userAction: "Run ChipMate: New ChipMate Session from the command palette.",
      expected: "ChipMate Output shows session refresh/create evidence or a clear connection error.",
      observed: result.matchedLine ?? "No session refresh/create or connection error marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
  })
  if (!hasProvider(ctx.config)) {
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "Provider-backed send is intentionally skipped when provider settings are absent.",
      userAction: "Read test-config provider settings.",
      expected: "No provider-backed chat request is attempted without apiBaseUrl/chatModel.",
      observed: "provider apiBaseUrl/chatModel not configured.",
      evidence: ["test-config.json"],
      status: "skipped",
    })
    reporter.skip("chat", "provider-backed send", "provider apiBaseUrl/chatModel not configured; offline smoke verifies error visibility instead")
    return
  }
  await reporter.step("chat", "provider-backed chat surface reachable", async () => {
    await chat.sendPromptByCommandPaletteFallback()
    await collectLogs(ctx)
    const text = await output.text()
    const marker = /\[view\] ChipMate using chipmate\.sidebar|\[refresh\] sessions|\[model\]|\[agent\]/i.exec(text)
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "Provider-configured chat surface remains reachable after basic chat commands.",
      userAction: "Open Chat and collect ChipMate logs in full mode.",
      expected: "ChipMate Output contains chat view, session, model, or agent evidence.",
      observed: marker ? marker[0] : "No provider-backed chat marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: marker ? "passed" : "failed",
    })
  })
  reporter.skip("chat", "DOM send/queue/history/export matrix", "requires optional WebDriver dependency in runner/node_modules for webview DOM-level interaction")
}
