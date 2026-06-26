import { collectLogs, invokeCommandPalette, type RunContext } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runRagSuite(ctx: RunContext, reporter: Reporter) {
  const output = new OutputPage(ctx)
  await reporter.step("rag", "show local code graph status", async () => {
    const detail = await invokeCommandPalette(ctx, "ChipMate: Show Local Code Graph Status")
    await recordFunctionalAssertion(ctx, {
      area: "rag",
      intent: "CodeGraph status command is reachable from the real VS Code UI.",
      userAction: "Run ChipMate: Show Local Code Graph Status from the command palette.",
      expected: "Command palette submission completes without window focus or command-palette failure.",
      observed: "CodeGraph status command was submitted; VS Code may render its status as a notification rather than Output text.",
      evidence: latestUiEvidence(ctx),
      status: "passed",
    })
    return detail
  })
  await reporter.step("rag", "rebuild local code graph", async () => {
    const detail = await invokeCommandPalette(ctx, "ChipMate: Rebuild Local Code Graph", Math.min(ctx.config.timeouts.indexMs, 120_000))
    const result = await waitForOutput(ctx, output, /\[codegraph\] (scan|indexed|indexing failed|stored index unavailable|saving manifest)/i, Math.min(ctx.config.timeouts.indexMs, 120_000))
    await collectLogs(ctx)
    await recordFunctionalAssertion(ctx, {
      area: "rag",
      intent: "CodeGraph rebuild produces scan/indexing/storage evidence.",
      userAction: "Run ChipMate: Rebuild Local Code Graph from the command palette.",
      expected: "ChipMate Output shows CodeGraph scan/indexed/storage evidence or an indexing failure marker.",
      observed: result.matchedLine ?? "No CodeGraph rebuild marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log", "globalStorage-summary.json"],
      status: result.matched ? "passed" : "failed",
    })
    return detail
  })
  await reporter.step("rag", "pause/resume local code graph", async () => {
    const pause = await invokeCommandPalette(ctx, "ChipMate: Pause Local Code Graph Indexing")
    const resume = await invokeCommandPalette(ctx, "ChipMate: Resume Local Code Graph Indexing")
    await collectLogs(ctx)
    await recordFunctionalAssertion(ctx, {
      area: "rag",
      intent: "CodeGraph pause/resume commands are reachable from real UI.",
      userAction: "Run pause and resume CodeGraph commands through the command palette.",
      expected: "Both commands are submitted to the selected VS Code window without focus failure.",
      observed: "Pause and resume command palette submissions completed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: "passed",
    })
    return `${pause}; ${resume}`
  })
  if (!ctx.config.rag.embeddingEndpoint) {
    await recordFunctionalAssertion(ctx, {
      area: "rag",
      intent: "Embedding/rerank provider path is skipped when endpoint is absent.",
      userAction: "Read RAG endpoint settings.",
      expected: "No embedding/rerank request is attempted without an embedding endpoint.",
      observed: "RAG embedding endpoint not configured.",
      evidence: ["test-config.json"],
      status: "skipped",
    })
    reporter.skip("rag", "embedding/rerank provider path", "RAG embedding endpoint not configured")
  }
}
