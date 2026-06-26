import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { collectEnvironment, collectLogs, delay, installedExtensionVersion, launchVsCode, listInstalledExtensions, locateTargetVsCodeWindow, openFile, runCode, writeWorkspaceSettings, type RunContext } from "../environment.js"
import { escapeRegExp, latestUiEvidence, recordFunctionalAssertion, runtimeFailureMarker, waitForOutput } from "../functional.js"
import { ChatPage } from "../pages/chat.page.js"
import { EditorPage } from "../pages/editor.page.js"
import { OutputPage } from "../pages/output.page.js"
import type { Reporter } from "../report.js"

export async function runSmokeSuite(ctx: RunContext, reporter: Reporter) {
  const chat = new ChatPage(ctx)
  const editor = new EditorPage(ctx)
  const output = new OutputPage(ctx)

  const cliStep = await reporter.step("smoke", "VS Code CLI responds", () => {
    const result = runCode(ctx, ["--version"], 30_000)
    if (result.status !== 0) throw new Error(commandFailure(result))
    return result.stdout.trim()
  })
  if (cliStep.status === "failed") {
    skipBlockedSmokeSteps(reporter, "VS Code CLI did not respond; UI automation cannot continue")
    return
  }

  await reporter.step("smoke", "real VS Code profile is available", () => {
    if (!existsSync(ctx.config.realUserDataDir)) throw new Error(`realUserDataDir does not exist: ${ctx.config.realUserDataDir}`)
    return ctx.config.realUserDataDir
  })

  await reporter.step("smoke", "write workspace test settings", async () => {
    await writeWorkspaceSettings(ctx)
  })

  const installedStep = await reporter.step("smoke", "installed ChipMate extension is visible", () => {
    const result = listInstalledExtensions(ctx)
    if (result.status !== 0) throw new Error(commandFailure(result))
    const version = installedExtensionVersion(result.stdout, ctx.config.extensionId)
    if (!version) {
      throw new Error(`${ctx.config.extensionId} was not visible in extension list from:\n${result.commandLine}\n\n${result.stdout}`)
    }
    ctx.installedExtensionVersion = version
    return `${ctx.config.extensionId}@${version}`
  })
  if (installedStep.status === "failed") {
    skipUiSmokeSteps(reporter, "Installed ChipMate extension was not visible; UI automation cannot continue")
    return
  }

  await reporter.step("smoke", "collect real VS Code state", async () => {
    await collectEnvironment(ctx)
  })

  const launchStep = await reporter.step("smoke", "launch real VS Code window", async () => {
    await launchVsCode(ctx)
    const target = await locateTargetVsCodeWindow(ctx)
    await delay(ctx.config.timeouts.startupMs)
    return `${target}; waited ${ctx.config.timeouts.startupMs}ms before UI automation`
  })
  if (launchStep.status === "failed") {
    reporter.skip("smoke", "open ChipMate chat from command palette", "blocked: VS Code window launch or discovery failed")
    reporter.skip("smoke", "open ChipMate Output", "blocked: VS Code window launch or discovery failed")
    reporter.skip("smoke", "trigger inline completion from real editor", "blocked: VS Code window launch or discovery failed")
    reporter.skip("smoke", "collect logs and check runtime dependency health", "blocked: VS Code window launch or discovery failed")
    return
  }

  await reporter.step("smoke", "chat view resolves from real UI", async () => {
    const detail = await chat.open()
    const result = await waitForOutput(ctx, output, /\[view\] ChipMate using chipmate\.sidebar/, 15_000)
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "Chat webview can be opened from the real VS Code command palette.",
      userAction: "Run ChipMate: Open ChipMate Chat through the command palette.",
      expected: "ChipMate Output contains the chat webview resolve marker.",
      observed: result.matchedLine ?? "No [view] ChipMate using chipmate.sidebar marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return `${detail}; observed=${result.matchedLine ?? "missing chat view marker"}`
  })

  await reporter.step("smoke", "ask current file enters chat send path", async () => {
    const opened = editor.openSmokeFile()
    if (opened.status !== 0) throw new Error(opened.stderr || opened.stdout)
    await delay(1000)
    const question = `ChipMate UI smoke ${ctx.runId}: summarize the current C file in one sentence.`
    const detail = await chat.askCurrentFile(question)
    const result = await waitForOutput(
      ctx,
      output,
      /\[context\] sent .*src[\\/]+main\.c|\[agent\]|\[model\]|\[guard\] blocked send:|\[codegraph\] blocked send:|\[history\] Failed to send message|Failed to send message to ChipMate|Configure a ChipMate provider before sending/i,
      Math.min(ctx.config.timeouts.chatMs, 60_000),
    )
    await recordFunctionalAssertion(ctx, {
      area: "chat",
      intent: "Ask Current File reaches the Chat send pipeline with current-file context or a clear provider/readiness error.",
      userAction: `Run ChipMate: Ask ChipMate About Current File and submit a run-scoped prompt (${ctx.runId}).`,
      expected: "ChipMate Output shows context/send/agent/model activity, or a clear guard/provider error.",
      observed: result.matchedLine ?? "No chat send, context, agent/model, or provider error marker was observed.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return `${detail}; observed=${result.matchedLine ?? "missing chat send marker"}`
  })

  await reporter.step("smoke", "ChipMate Output is readable and healthy", async () => {
    const detail = await output.openChipMateOutput()
    await collectLogs(ctx)
    const text = await output.text()
    const runtimeFailure = runtimeFailureMarker(text)
    await recordFunctionalAssertion(ctx, {
      area: "output",
      intent: "ChipMate Output can be opened and contains readable plugin evidence.",
      userAction: "Run ChipMate: Open ChipMate Output through the command palette.",
      expected: "Collected ChipMate logs are non-empty and contain no runtime dependency failure marker.",
      observed: runtimeFailure
        ? `Runtime dependency failure marker found: ${runtimeFailure[0]}`
        : text.trim()
          ? `Collected ${text.length} log character(s).`
          : "No ChipMate Output or Extension Host log text was collected.",
      evidence: [...latestUiEvidence(ctx), "logs/chipmate-output.log", "logs/extension-host.log"],
      status: text.trim() && !runtimeFailure ? "passed" : "failed",
    })
    if (runtimeFailure) throw new Error(`runtime dependency failure detected: ${runtimeFailure[0]}`)
    if (!text.trim()) throw new Error("no ChipMate log text found after opening Output")
    return `${detail}; collected ${text.length} log character(s)`
  })

  await reporter.step("smoke", "inline completion provider is triggered from a real editor", async () => {
    const probe = await writeCompletionProbe(ctx)
    const opened = openFile(ctx, probe.path, probe.line, probe.column)
    if (opened.status !== 0) throw new Error(opened.stderr || opened.stdout)
    await delay(1000)
    const detail = await editor.triggerInlineCompletion()
    const probeName = basename(probe.path)
    const result = await waitForOutput(
      ctx,
      output,
      new RegExp(`qwen-autocomplete requestId=.*${escapeRegExp(probeName)}|ChipMate qwen inline completion is unavailable|Qwen .*response|/completions|completion.*error`, "i"),
      Math.min(ctx.config.timeouts.completionMs, 60_000),
    )
    await recordFunctionalAssertion(ctx, {
      area: "completion",
      intent: "Inline completion provider is invoked for a run-scoped C probe file.",
      userAction: `Open ${probeName} at the probe cursor and run Trigger Inline Suggestion through the command palette.`,
      expected: "ChipMate Output shows a qwen-autocomplete request for the probe file, or a clear completion provider error.",
      observed: result.matchedLine ?? `No qwen-autocomplete/provider marker was observed for ${probeName}.`,
      evidence: [...latestUiEvidence(ctx), `workspace/${probe.relative}`, "logs/chipmate-output.log"],
      status: result.matched ? "passed" : "failed",
    })
    return `${detail}; probe=${probeName}; observed=${result.matchedLine ?? "missing completion provider marker"}`
  })

  await reporter.step("smoke", "collect logs and check runtime dependency health", async () => {
    await collectLogs(ctx)
    const text = await output.text()
    const runtimeFailure = runtimeFailureMarker(text)
    await recordFunctionalAssertion(ctx, {
      area: "runtime",
      intent: "Offline packaged runtime dependencies are available during real VS Code execution.",
      userAction: "Collect ChipMate Output and Extension Host logs after UI smoke actions.",
      expected: "No MODULE_NOT_FOUND, dynamic import, tree-sitter, parser, or runtime missing marker appears.",
      observed: runtimeFailure ? `Runtime dependency failure marker found: ${runtimeFailure[0]}` : "No runtime dependency failure marker found.",
      evidence: ["logs/chipmate-output.log", "logs/extension-host.log", "logs/shared-process.log"],
      status: runtimeFailure ? "failed" : "passed",
    })
    if (runtimeFailure) throw new Error(`runtime dependency failure detected: ${runtimeFailure[0]}`)
    return text ? "logs collected" : "no ChipMate log text found yet"
  })
}

function commandFailure(result: { commandLine: string; stdout: string; stderr: string }) {
  return [
    `command=${result.commandLine}`,
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ].filter(Boolean).join("\n")
}

function skipBlockedSmokeSteps(reporter: Reporter, reason: string) {
  reporter.skip("smoke", "real VS Code profile is available", `blocked: ${reason}`)
  reporter.skip("smoke", "write workspace test settings", `blocked: ${reason}`)
  reporter.skip("smoke", "installed ChipMate extension is visible", `blocked: ${reason}`)
  reporter.skip("smoke", "collect real VS Code state", `blocked: ${reason}`)
  reporter.skip("smoke", "launch real VS Code window", `blocked: ${reason}`)
  reporter.skip("smoke", "open ChipMate chat from command palette", `blocked: ${reason}`)
  reporter.skip("smoke", "open ChipMate Output", `blocked: ${reason}`)
  reporter.skip("smoke", "trigger inline completion from real editor", `blocked: ${reason}`)
  reporter.skip("smoke", "collect logs and check runtime dependency health", `blocked: ${reason}`)
}

function skipUiSmokeSteps(reporter: Reporter, reason: string) {
  reporter.skip("smoke", "collect real VS Code state", `blocked: ${reason}`)
  reporter.skip("smoke", "launch real VS Code window", `blocked: ${reason}`)
  reporter.skip("smoke", "open ChipMate chat from command palette", `blocked: ${reason}`)
  reporter.skip("smoke", "open ChipMate Output", `blocked: ${reason}`)
  reporter.skip("smoke", "trigger inline completion from real editor", `blocked: ${reason}`)
  reporter.skip("smoke", "collect logs and check runtime dependency health", `blocked: ${reason}`)
}

async function writeCompletionProbe(ctx: RunContext) {
  const srcDir = join(ctx.workspace, "src")
  await mkdir(srcDir, { recursive: true })
  const stem = `chipmate_ui_probe_${safeIdentifier(ctx.runId)}`
  const relative = join("src", `${stem}.c`)
  const path = join(ctx.workspace, relative)
  const line = 3
  const source = [
    `int ${stem}(int input) {`,
    "    int base = input + 1;",
    "    int computed = base + ",
    "    return computed;",
    "}",
    "",
  ].join("\n")
  await writeFile(path, source)
  return {
    path,
    relative: relative.replace(/\\/g, "/"),
    line,
    column: "    int computed = base + ".length + 1,
  }
}

function safeIdentifier(value: string) {
  return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1").slice(0, 80)
}
