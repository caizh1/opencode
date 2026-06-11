import * as vscode from "vscode"
import type { CompletionRange } from "./completion-edit"

export const FORMAT_ACCEPTED_COMPLETION_COMMAND = "chipmate.completion.formatAcceptedCompletion"

type FormatAcceptedCompletionArgs = {
  uri: string
  range: CompletionRange
}

export function completionFormatCommand(uri: vscode.Uri, range: CompletionRange): vscode.Command {
  return {
    command: FORMAT_ACCEPTED_COMPLETION_COMMAND,
    title: "Format accepted ChipMate completion",
    arguments: [{ uri: uri.toString(), range } satisfies FormatAcceptedCompletionArgs],
  }
}

export function registerCompletionFormatCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  context.subscriptions.push(
    vscode.commands.registerCommand(FORMAT_ACCEPTED_COMPLETION_COMMAND, async (input: FormatAcceptedCompletionArgs) => {
      try {
        await formatAcceptedCompletion(input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[completion] Accepted completion formatting failed: ${message}`)
      }
    }),
  )
}

async function formatAcceptedCompletion(input: FormatAcceptedCompletionArgs) {
  if (!input?.uri || !input.range) return

  const uri = vscode.Uri.parse(input.uri)
  const document = await openDocument(uri)
  if (!document) return

  const range = new vscode.Range(
    input.range.startLine,
    input.range.startCharacter,
    input.range.endLine,
    input.range.endCharacter,
  )
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatRangeProvider",
    uri,
    range,
    formattingOptionsForDocument(document),
  )
  if (!edits?.length) return

  const workspaceEdit = new vscode.WorkspaceEdit()
  for (const edit of edits) {
    workspaceEdit.replace(uri, edit.range, edit.newText)
  }
  await vscode.workspace.applyEdit(workspaceEdit)
}

async function openDocument(uri: vscode.Uri) {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open) return open
  try {
    return await vscode.workspace.openTextDocument(uri)
  } catch {
    return undefined
  }
}

function formattingOptionsForDocument(document: vscode.TextDocument): vscode.FormattingOptions {
  const editor = editorForDocument(document)
  const config = vscode.workspace.getConfiguration("editor", document.uri)
  const insertSpaces = editor?.options.insertSpaces ?? config.get<boolean | string>("insertSpaces", true)
  const tabSize = editor?.options.tabSize ?? config.get<number | string>("tabSize", 4)
  return {
    insertSpaces: !(insertSpaces === false || insertSpaces === "false"),
    tabSize: numericTabSize(tabSize),
  }
}

function numericTabSize(input: string | number | undefined) {
  const size = typeof input === "number" ? input : Number(input)
  if (!Number.isFinite(size) || size <= 0) return 4
  return Math.floor(size)
}

function editorForDocument(document: vscode.TextDocument) {
  const active = vscode.window.activeTextEditor
  if (active?.document.uri.toString() === document.uri.toString()) return active
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString())
}
