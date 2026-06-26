import type { RunContext } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { OutputPage } from "../pages/output.page.js"
import { TerminalPage } from "../pages/terminal.page.js"
import type { Reporter } from "../report.js"

export async function runTerminalSuite(ctx: RunContext, reporter: Reporter) {
  const terminal = new TerminalPage(ctx)
  const output = new OutputPage(ctx)
  await reporter.step("terminal", "open ChipMate Agent Terminal profile", async () => {
    const detail = await terminal.openAgentTerminal()
    const result = await waitForOutput(ctx, output, /\[agent-terminal\] (created|focused) existing? ChipMate Agent Terminal|\[agent-terminal\] created ChipMate Agent Terminal/i, 15_000)
    await recordFunctionalAssertion(ctx, {
      area: "terminal",
      intent: "Agent Terminal command creates or focuses the ChipMate terminal profile.",
      userAction: "Run ChipMate: Open ChipMate Agent Terminal from the command palette.",
      expected: "ChipMate Output logs terminal creation or focus evidence.",
      observed: result.matchedLine ?? "No agent-terminal creation/focus marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return detail
  })
  await recordFunctionalAssertion(ctx, {
    area: "terminal",
    intent: "Interactive terminal command/history matrix remains out of scope for the no-WebDriver runner.",
    userAction: "Read runner dependency mode.",
    expected: "Shell command assertions are not attempted without terminal text driver support.",
    observed: "Skipped until optional WebDriver/UIA terminal text assertions are added.",
    evidence: ["runner/latest.json"],
    status: "skipped",
  })
  reporter.skip("terminal", "interactive command/history/Ctrl+C matrix", "requires optional WebDriver dependency or Windows accessibility driver for terminal text assertions")
}
