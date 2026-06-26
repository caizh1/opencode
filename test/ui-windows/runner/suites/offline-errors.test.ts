import { collectLogs, type RunContext } from "../environment.js"
import { recordFunctionalAssertion, runtimeFailureMarker } from "../functional.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runOfflineErrorsSuite(ctx: RunContext, reporter: Reporter) {
  const output = new OutputPage(ctx)
  await reporter.step("offline", "runtime does not attempt missing packaged dependency loads", async () => {
    await collectLogs(ctx)
    const text = await output.text()
    const missingRuntime = runtimeFailureMarker(text) ?? /(download.*ripgrep|npm install)/i.exec(text)
    await recordFunctionalAssertion(ctx, {
      area: "offline-runtime",
      intent: "Offline runner detects missing runtime dependency or dynamic download attempts.",
      userAction: "Scan ChipMate Output and Extension Host logs after the UI suite.",
      expected: "No packaged dependency is missing and no npm/ripgrep download attempt appears.",
      observed: missingRuntime ? `Offline runtime failure marker found: ${missingRuntime[0]}` : "No offline runtime failure marker found.",
      evidence: ["logs/chipmate-output.log", "logs/extension-host.log", "logs/shared-process.log"],
      status: missingRuntime ? "failed" : "passed",
    })
    if (missingRuntime) throw new Error(`offline runtime failure marker found: ${missingRuntime[0]}`)
    return text ? "offline log scan completed" : "no relevant logs found"
  })
}
