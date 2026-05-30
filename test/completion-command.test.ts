import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("accepted completion formatting command wiring", () => {
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
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

  test("accepted formatting command formats only the accepted range", () => {
    expect(commandSource).toContain("FORMAT_ACCEPTED_COMPLETION_COMMAND")
    expect(commandSource).toContain("vscode.executeFormatRangeProvider")
    expect(commandSource).toContain("workspaceEdit.replace(uri, edit.range, edit.newText)")
  })

  test("extension registers the accepted completion formatting command", () => {
    expect(extensionSource).toContain("registerCompletionFormatCommand(context, output)")
  })
})
