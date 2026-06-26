import { collectLogs, invokeCommandPalette, type RunContext } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runDocumentRagSuite(ctx: RunContext, reporter: Reporter) {
  const output = new OutputPage(ctx)
  await reporter.step("document-rag", "show document RAG status", async () => {
    const detail = await invokeCommandPalette(ctx, "ChipMate: Show Document RAG Status")
    await recordFunctionalAssertion(ctx, {
      area: "document-rag",
      intent: "Document RAG status command is reachable from the real VS Code UI.",
      userAction: "Run ChipMate: Show Document RAG Status from the command palette.",
      expected: "Command palette submission completes without window focus or command-palette failure.",
      observed: "Document RAG status command was submitted; VS Code may render its status as a notification rather than Output text.",
      evidence: latestUiEvidence(ctx),
      status: "passed",
    })
    return detail
  })
  await reporter.step("document-rag", "rebuild document RAG", async () => {
    const detail = await invokeCommandPalette(ctx, "ChipMate: Rebuild Document RAG", Math.min(ctx.config.timeouts.indexMs, 120_000))
    const result = await waitForOutput(ctx, output, /\[document-rag\] (reconcile|indexed|skipped|indexing failed|large workspace paused)/i, Math.min(ctx.config.timeouts.indexMs, 120_000))
    await collectLogs(ctx)
    await recordFunctionalAssertion(ctx, {
      area: "document-rag",
      intent: "Document RAG rebuild produces reconcile/indexing/parser evidence.",
      userAction: "Run ChipMate: Rebuild Document RAG from the command palette.",
      expected: "ChipMate Output shows Document RAG reconcile/indexed/skipped/failure evidence.",
      observed: result.matchedLine ?? "No Document RAG rebuild marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log", "globalStorage-summary.json"],
      status: result.matched ? "passed" : "failed",
    })
    return detail
  })
}
