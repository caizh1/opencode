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

  test("warns the model not to read remote server paths", () => {
    expect(contextSource).toContain("local VS Code context supplied by the extension")
    expect(contextSource).toContain("Do not read, glob, grep, list, edit, or run shell commands")
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
  })
})
