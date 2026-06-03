import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("accepted completion formatting command wiring", () => {
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const contextSource = readFileSync(join(import.meta.dir, "..", "src", "context.ts"), "utf8")
  const commandSource = readFileSync(join(import.meta.dir, "..", "src", "completion-format-command.ts"), "utf8")
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")

  test("inline completion items use range and post-accept command", () => {
    expect(completionSource).toContain("new vscode.InlineCompletionItem(edit.insertText, range, command)")
    expect(completionSource).toContain("completionFormatCommand(document.uri, edit.formatRange)")
    expect(completionSource).toContain("item.filterText = edit.filterText")
  })

  test("completion provider logs empty reasons and edit debug details", () => {
    expect(completionSource).toContain("reason=filtered-or-no-visible-text")
    expect(completionSource).toContain("edit-rejected reason=${result.reason}")
    expect(completionSource).toContain("edit-ready ${editDetails(edit)}")
    expect(completionSource).toContain("returned source=${source}")
    expect(completionSource).toContain("edit ${editDetails(edit)}")
    expect(completionSource).toContain("rangeLogValue(edit.replaceRange)")
    expect(completionSource).toContain("firstLine=")
    expect(completionSource).toContain("currentWordBeforeCursor")
    expect(completionSource).toContain("waitForOutcome")
    expect(completionSource).toContain("editor.action.inlineSuggest.trigger")
  })

  test("completion provider retries once after misaligned leading-newline edits", () => {
    expect(completionSource).toContain('initial.reason !== "misaligned-leading-newline"')
    expect(completionSource).toContain("completionRetryPrompt(input.prompt, input.editInput)")
    expect(completionSource).toContain("retry-sent reason=${initial.reason}")
    expect(completionSource).toContain("retry-received reason=${initial.reason}")
    expect(completionSource).toContain("retry-edit-ready ${editDetails(edit)}")
    expect(completionSource).toContain("retry-edit-rejected reason=${result.reason}")
  })

  test("completion provider can route inline completions to a direct model API", () => {
    expect(completionSource).toContain('settings.completion.provider === "openai-compatible"')
    expect(completionSource).toContain('input.settings.completion.profile === "qwen-coder-fim"')
    expect(completionSource).toContain("buildQwenCoderFimPrompt")
    expect(completionSource).toContain("new CompletionModelClient(input.settings, apiKey)")
    expect(completionSource).toContain('transport: "openai-compatible"')
    expect(completionSource).toContain("document.version")
    expect(completionSource).toContain("planCompletion")
    expect(completionSource).toContain("completionMaxTokensForPlan")
    expect(completionSource).toContain("client.complete({ prompt: promptText, signal: input.signal, maxTokens })")
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
