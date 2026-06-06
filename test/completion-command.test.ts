import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("accepted completion formatting command wiring", () => {
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const completionCandidateSource = readFileSync(join(import.meta.dir, "..", "src", "completion-candidate-pipeline.ts"), "utf8")
  const contextSource = readFileSync(join(import.meta.dir, "..", "src", "context.ts"), "utf8")
  const commandSource = readFileSync(join(import.meta.dir, "..", "src", "completion-format-command.ts"), "utf8")
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")

  test("inline completion items use range and post-accept command", () => {
    expect(completionSource).toContain("new vscode.InlineCompletionItem(edit.insertText, range, command)")
    expect(completionSource).toContain("completionFormatCommand(document.uri, edit.formatRange)")
    expect(completionSource).toContain("item.filterText = edit.filterText")
  })

  test("completion provider logs empty reasons and edit debug details", () => {
    expect(completionSource).toContain("runCompletionCandidatePipeline")
    expect(completionCandidateSource).toContain("postprocessCompletion")
    expect(completionCandidateSource).toContain("postprocessResult.reason")
    expect(completionCandidateSource).toContain('reason: "empty-output" as const')
    expect(completionCandidateSource).toContain("`edit:${result.reason}`")
    expect(completionSource).toContain("edit-rejected reason=${reason}")
    expect(completionSource).toContain("edit-ready ${editDetails(qualityEdit)}")
    expect(completionSource).toContain("returned source=${source}")
    expect(completionSource).toContain("edit ${editDetails(edit)}")
    expect(completionSource).toContain("rangeLogValue(edit.replaceRange)")
    expect(completionSource).toContain("firstLine=")
    expect(completionSource).toContain("currentWordBeforeCursor")
    expect(completionSource).toContain("waitForOutcome")
    expect(completionSource).toContain("editor.action.inlineSuggest.trigger")
  })

  test("completion provider retries once after retryable rejected instruction edits", () => {
    expect(completionSource).toContain("shouldRetryCompletionRejection")
    expect(completionSource).toContain('case "low-confidence-output"')
    expect(completionSource).toContain('case "quality:C parse/compile"')
    expect(completionSource).toContain("completionRetryPrompt(input.prompt, input.editInput, initial.reason, input.textProfile)")
    expect(completionSource).toContain("completionFimRetryPrompt(prompt, feedback, cursorPrefix)")
    expect(completionSource).toContain("retry-sent reason=${initial.reason}")
    expect(completionSource).toContain("retry-received reason=${initial.reason}")
    expect(completionSource).toContain("retry-edit-ready ${editDetails(qualityEdit)}")
    expect(completionSource).toContain("retry-edit-rejected reason=${reason}")
  })

  test("completion provider can route inline completions to a direct model API", () => {
    expect(completionSource).toContain('settings.completion.provider === "openai-compatible"')
    expect(completionSource).toContain('input.route.promptKind === "qwen-fim"')
    expect(completionSource).toContain("buildQwenCoderFimPrompt")
    expect(completionSource).toContain("new CompletionModelClient(input.settings, apiKey)")
    expect(completionSource).toContain('transport: "openai-compatible"')
    expect(completionSource).toContain("document.version")
    expect(completionSource).toContain("planCompletion")
    expect(completionSource).toContain("routeCompletionModel")
    expect(completionSource).toContain("routeLogValue(route)")
    expect(completionSource).toContain("completionPromptForRoute")
    expect(completionSource).toContain("profile: route.modelProfile")
    expect(completionSource).toContain("maxTokens: route.maxTokens")
  })

  test("inline completion provider does not depend on OpenCode chat agents", () => {
    expect(completionSource).not.toContain("resolveRequestAgent")
    expect(completionSource).not.toContain("agentSelection")
    expect(completionSource).not.toContain("agent: agentSelection.agent")
  })

  test("completion provider emits structured telemetry for routed outcomes", () => {
    expect(completionSource).toContain("createCompletionRequestId")
    expect(completionSource).toContain("requestId=${requestId}")
    expect(completionSource).toContain("serializeCompletionDebugEvent")
    expect(completionSource).toContain("logCompletionTelemetry")
    expect(completionSource).toContain("completionTelemetryRoute(route)")
    expect(completionSource).toContain("completionTelemetrySymbolCandidates")
    expect(completionSource).toContain("selectedContextBlocks")
    expect(completionSource).toContain("droppedContextBlocks")
    expect(completionSource).toContain("rejectReason")
    expect(completionSource).toContain("latencyMs")
  })

  test("completion provider retrieves a wider symbol set for test instruction context", () => {
    expect(completionSource).toContain("plan.needsTestRetrieval ? 30 : 8")
  })

  test("Qwen coder FIM prompt uses the expected token order", () => {
    const repo = contextSource.indexOf("<|repo_name|>")
    const file = contextSource.indexOf("<|file_sep|>")
    const prefix = contextSource.indexOf("<|fim_prefix|>")
    const suffix = contextSource.indexOf("<|fim_suffix|>")
    const middle = contextSource.indexOf("<|fim_middle|>")
    expect(repo).toBeGreaterThanOrEqual(0)
    expect(file).toBeGreaterThan(repo)
    expect(prefix).toBeGreaterThan(file)
    expect(suffix).toBeGreaterThan(prefix)
    expect(middle).toBeGreaterThan(suffix)
  })

  test("accepted formatting command formats only the accepted range", () => {
    expect(commandSource).toContain("FORMAT_ACCEPTED_COMPLETION_COMMAND")
    expect(commandSource).toContain("vscode.executeFormatRangeProvider")
    expect(commandSource).toContain("workspaceEdit.replace(uri, edit.range, edit.newText)")
  })

  test("extension registers the accepted completion formatting command", () => {
    expect(extensionSource).toContain("registerCompletionFormatCommand(context, output)")
  })
})
