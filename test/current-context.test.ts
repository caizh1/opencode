import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("default current file context", () => {
  const contextSource = readFileSync(join(import.meta.dir, "..", "src", "context.ts"), "utf8")
  const trackerSource = readFileSync(join(import.meta.dir, "..", "src", "editor-context.ts"), "utf8")
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")

  test("tracks the last local VS Code editor even after webview focus", () => {
    expect(trackerSource).toContain("class EditorContextTracker")
    expect(trackerSource).toContain("onDidChangeActiveTextEditor")
    expect(trackerSource).toContain("onDidChangeTextEditorSelection")
    expect(trackerSource).toContain("visibleTextEditors")
    expect(extensionSource).toContain("new EditorContextTracker()")
  })

  test("passes tracked editor context into prompt packing", () => {
    expect(contextSource).toContain("editorContext?: TrackedEditorContext")
    expect(contextSource).toContain("resolveEditorContext")
    expect(contextSource).toContain("vscode.window.visibleTextEditors")
    expect(chatViewSource).toContain("editorContext: this.deps.getEditorContext()")
  })

  test("warns the model to use only read-only workspace evidence tools", () => {
    expect(contextSource).toContain("local VS Code context supplied by the extension")
    expect(contextSource).toContain("Only the read-only chipmate_read tool is available for workspace evidence")
    expect(contextSource).toContain("ChipMate workspace-host tools are disabled for this chat turn")
    expect(contextSource).toContain("ask the user to open, attach, or @mention the file")
    expect(contextSource).toContain("No local file content was captured")
  })

  test("blocks file questions when local-only context is missing", () => {
    expect(contextSource).toContain("class MissingLocalContextError")
    expect(contextSource).toContain("looksLikeLocalFileQuestion")
    expect(chatViewSource).toContain("error instanceof MissingLocalContextError")
  })

  test("reports actual sent context paths to output and UI state", () => {
    expect(chatViewSource).toContain("onContextSummary")
    expect(chatViewSource).toContain("[context] sent")
    expect(chatViewSource).toContain("autoContext: this.autoContextState()")
    expect(chatViewSource).toContain("workspaceDiagnosticsSummary")
    expect(chatViewSource).toContain("diagnosticCount: diagnostics.total")
    expect(chatViewSource).toContain("vscode.workspace.getWorkspaceFolder(uri)")
  })
})
