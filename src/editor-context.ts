import * as vscode from "vscode"

export type TrackedEditorContext = {
  uri: vscode.Uri
  selection: vscode.Selection
  position: vscode.Position
  languageId: string
}

export class EditorContextTracker implements vscode.Disposable {
  private current?: TrackedEditorContext
  private readonly disposables: vscode.Disposable[] = []

  constructor() {
    this.capture(vscode.window.activeTextEditor ?? this.firstVisibleFileEditor())
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.capture(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.capture(event.textEditor)),
    )
  }

  snapshot() {
    if (this.current) return this.current
    const fallback = vscode.window.activeTextEditor ?? this.firstVisibleFileEditor()
    this.capture(fallback)
    return this.current
  }

  dispose() {
    for (const disposable of this.disposables) disposable.dispose()
  }

  private capture(editor: vscode.TextEditor | undefined) {
    if (!editor) return
    if (editor.document.uri.scheme !== "file") return
    this.current = {
      uri: editor.document.uri,
      selection: editor.selection,
      position: editor.selection.active,
      languageId: editor.document.languageId,
    }
  }

  private firstVisibleFileEditor() {
    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "file")
  }
}
