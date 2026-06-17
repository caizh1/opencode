import * as vscode from "vscode"
import { processSingleLineCompletion } from "./processSingleLineCompletion"

export function zeroWidthRange(position: vscode.Position): vscode.Range {
  return new vscode.Range(position, position)
}

export function renderQwenInlineCompletionItem(
  document: vscode.TextDocument,
  position: vscode.Position,
  context: vscode.InlineCompletionContext,
  completion: string,
): vscode.InlineCompletionItem | undefined {
  const selected = context.selectedCompletionInfo
  const start = selected?.range.start ?? position
  const lines = completion.split("\n")
  const single = lines.length <= 1
  let range = zeroWidthRange(start)
  let text = completion

  if (single) {
    const line = lines.pop() || ""
    const current = document.lineAt(start).text.substring(start.character)
    const result = processSingleLineCompletion(line, current, start.character)
    if (result === undefined) return undefined
    text = result.completionText
    if (result.range) {
      range = new vscode.Range(
        new vscode.Position(start.line, result.range.start),
        new vscode.Position(start.line, result.range.end),
      )
    }
  } else {
    range = new vscode.Range(start, document.lineAt(start).range.end)
  }

  const item = new vscode.InlineCompletionItem(text, range)
  ;(item as unknown as { completeBracketPairs?: boolean }).completeBracketPairs = true
  return item
}
