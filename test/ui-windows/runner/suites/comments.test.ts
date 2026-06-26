import { collectLogs, delay, type RunContext } from "../environment.js"
import { latestUiEvidence, recordFunctionalAssertion, waitForOutput } from "../functional.js"
import { CommentsPage } from "../pages/comments.page.js"
import { EditorPage } from "../pages/editor.page.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runCommentsSuite(ctx: RunContext, reporter: Reporter) {
  const comments = new CommentsPage(ctx)
  const editor = new EditorPage(ctx)
  const output = new OutputPage(ctx)
  await reporter.step("comments", "current-function comment command", async () => {
    const opened = editor.openFullDriverFile()
    if (opened.status !== 0) throw new Error(opened.stderr || opened.stdout)
    await delay(1000)
    const detail = await comments.generateForCurrentFunction()
    const result = await waitForOutput(ctx, output, /\[ChipMate Comment\].*(stage=|reason=|outcome)|Comment action failed|unsupported-language|evidence/i, Math.min(ctx.config.timeouts.chatMs, 60_000))
    await collectLogs(ctx)
    await recordFunctionalAssertion(ctx, {
      area: "comments",
      intent: "Current-function AI comments command reaches the comments generation pipeline.",
      userAction: "Open full fixture driver.c and run ChipMate: 为当前函数生成 AI 注释.",
      expected: "ChipMate Comment Output shows trace stage/outcome evidence or a clear failure reason.",
      observed: result.matchedLine ?? "No comments trace/outcome marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-comment-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return detail
  })
  await reporter.step("comments", "workspace changes comment command", async () => {
    const detail = await comments.generateForWorkspaceChanges()
    const result = await waitForOutput(ctx, output, /\[ChipMate Comment\].*(workspace|stage=|reason=|outcome)|workspace-changes-scan-failed|proposals-stored/i, Math.min(ctx.config.timeouts.chatMs, 60_000))
    await collectLogs(ctx)
    await recordFunctionalAssertion(ctx, {
      area: "comments",
      intent: "Workspace-changes comments command reaches scan/generation pipeline.",
      userAction: "Run ChipMate: 为工作区改动生成 AI 注释.",
      expected: "ChipMate Comment Output shows workspace scan/generation evidence or a clear outcome.",
      observed: result.matchedLine ?? "No workspace comments trace/outcome marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-comment-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return detail
  })
  await recordFunctionalAssertion(ctx, {
    area: "comments",
    intent: "DOM accept/reject matrix remains out of scope for the no-WebDriver runner.",
    userAction: "Read runner dependency mode.",
    expected: "Accept/reject DOM assertions are not attempted without a webview DOM driver.",
    observed: "Skipped until optional WebDriver/UIA DOM support is added.",
    evidence: ["runner/latest.json"],
    status: "skipped",
  })
  reporter.skip("comments", "accept/reject DOM review panel matrix", "requires optional WebDriver dependency in runner/node_modules for webview panel DOM-level interaction")
}
