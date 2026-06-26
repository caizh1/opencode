import { collectLogs, delay, type RunContext } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { EditorPage } from "../pages/editor.page.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runCompletionSuite(ctx: RunContext, reporter: Reporter) {
  const editor = new EditorPage(ctx)
  const output = new OutputPage(ctx)
  await reporter.step("completion", "trigger qwen inline completion", async () => {
    const opened = editor.openFullDriverFile()
    if (opened.status !== 0) throw new Error(opened.stderr || opened.stdout)
    await delay(1000)
    await editor.triggerInlineCompletion()
    const result = await waitForOutput(ctx, output, /qwen-autocomplete requestId=.*driver\.c|ChipMate qwen inline completion is unavailable|Qwen .*response|completion.*error/i, Math.min(ctx.config.timeouts.completionMs, 60_000))
    await recordFunctionalAssertion(ctx, {
      area: "completion",
      intent: "Full suite triggers the qwen inline completion provider from a real C editor.",
      userAction: "Open full fixture driver.c and run Trigger Inline Suggestion from the command palette.",
      expected: "ChipMate Output shows a qwen-autocomplete request for driver.c or a clear provider error.",
      observed: result.matchedLine ?? "No qwen-autocomplete/provider marker was observed for driver.c.",
      evidence: [...latestUiEvidence(ctx), "fixtures/workspaces/full/src/driver.c", "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
  })
  await reporter.step("completion", "regenerate inline completion command", async () => {
    await editor.regenerateInlineCompletion()
    const result = await waitForOutput(ctx, output, /qwen-autocomplete requestId=.*driver\.c|ChipMate qwen inline completion is unavailable|completion.*error/i, Math.min(ctx.config.timeouts.completionMs, 60_000))
    await recordFunctionalAssertion(ctx, {
      area: "completion",
      intent: "Regenerate command reaches the inline completion provider or reports a clear unavailable state.",
      userAction: "Run ChipMate: Regenerate ChipMate Inline Completion from the command palette.",
      expected: "ChipMate Output shows a fresh qwen-autocomplete/provider marker.",
      observed: result.matchedLine ?? "No regenerate completion marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
  })
  await reporter.step("completion", "completion logs have no safety regressions", async () => {
    await collectLogs(ctx)
    const text = await output.text()
    const unsafe = /(suffix-duplicated|echoed prefix|duplicate comment|range.*multi-line)/i.exec(text)
    await recordFunctionalAssertion(ctx, {
      area: "completion",
      intent: "Inline completion logs do not show known safety-regression markers.",
      userAction: "Collect ChipMate completion logs after trigger/regenerate commands.",
      expected: "No echoed prefix, duplicate comment, suffix duplication, or multi-line range marker appears.",
      observed: unsafe ? `Safety regression marker found: ${unsafe[0]}` : "No completion safety regression marker found.",
      evidence: ["logs/chipmate-output.log"],
      status: unsafe ? "failed" : "passed",
    })
    if (unsafe) throw new Error(`completion safety regression marker found: ${unsafe[0]}`)
    return text ? "completion log scan completed" : "no completion log text found yet"
  })
}
