import * as vscode from "vscode"

export type QwenPrefixSuffixInput = {
  document: vscode.TextDocument
  position: vscode.Position
  selected?: vscode.SelectedCompletionInfo
}

// Continue parity source:
// commit eaa23c5a9de86049dff765f635c18f61d1d043bb
// core/autocomplete/templating/constructPrefixSuffix.ts
export function constructInitialPrefixSuffix(input: QwenPrefixSuffixInput): { prefix: string; suffix: string } {
  const start = new vscode.Position(0, 0)
  const last = input.document.lineCount - 1
  const end = new vscode.Position(last, input.document.lineAt(last).text.length)
  const head = input.selected?.range.start ?? input.position
  const prefix = input.document.getText(new vscode.Range(start, head)) + (input.selected?.text ?? "")
  const suffix = input.document.getText(new vscode.Range(input.position, end))
  return { prefix, suffix }
}
