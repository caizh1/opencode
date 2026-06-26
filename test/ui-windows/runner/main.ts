import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { parseCli, readConfig, resolveWorkspace } from "./config.js"
import { collectEnvironment, collectLogs, createRunContext } from "./environment.js"
import { Reporter } from "./report.js"
import { runChatSuite } from "./suites/chat.test.js"
import { runCommentsSuite } from "./suites/comments.test.js"
import { runCompletionSuite } from "./suites/completion.test.js"
import { runDocumentRagSuite } from "./suites/document-rag.test.js"
import { runOfflineErrorsSuite } from "./suites/offline-errors.test.js"
import { runRagSuite } from "./suites/rag.test.js"
import { runSmokeSuite } from "./suites/smoke.test.js"
import { runTerminalSuite } from "./suites/terminal.test.js"

async function main() {
  const cli = parseCli(process.argv.slice(2))
  const config = readConfig(cli)
  const workspace = resolveWorkspace(cli.bundleRoot, cli.configPath, config.workspace)
  const ctx = await createRunContext({
    bundleRoot: cli.bundleRoot,
    config,
    workspace,
    reportRoot: cli.reportRoot,
    mode: cli.mode,
  })
  const reporter = new Reporter(ctx)
  await mkdir(ctx.reportDir, { recursive: true })
  await copyBundleMetadata(ctx.reportDir, cli.bundleRoot)

  try {
    await collectEnvironment(ctx)
    await runSmokeSuite(ctx, reporter)
    if (cli.mode === "full") {
      await runChatSuite(ctx, reporter)
      await runCompletionSuite(ctx, reporter)
      await runRagSuite(ctx, reporter)
      await runDocumentRagSuite(ctx, reporter)
      await runCommentsSuite(ctx, reporter)
      await runTerminalSuite(ctx, reporter)
    }
    await runOfflineErrorsSuite(ctx, reporter)
  } finally {
    await collectLogs(ctx).catch(() => undefined)
    await reporter.write()
  }

  console.log(`reportDir=${ctx.reportDir}`)
  process.exit(reporter.hasFailures() ? 1 : 0)
}

async function copyBundleMetadata(reportDir: string, bundleRoot: string) {
  const latestPath = join(bundleRoot, "latest.json")
  if (existsSync(latestPath)) {
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as Record<string, unknown>
    await copyFile(latestPath, join(reportDir, "runner-bundle.json"))
    await copyFile(latestPath, join(reportDir, "latest.json"))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
