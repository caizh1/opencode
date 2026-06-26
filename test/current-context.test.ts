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

  test("warns the model about evidence tools and exact local file edits", () => {
    expect(contextSource).toContain("local VS Code context supplied by the extension")
    expect(contextSource).toContain("ChipMate workspace evidence tools may be available")
    expect(contextSource).toContain("chipmate_create_directory may create new workspace folders")
    expect(contextSource).toContain("chipmate_create_file may create new workspace text/code files")
    expect(contextSource).toContain("chipmate_edit_file may modify existing workspace text/code files only by exact oldString/newString replacement")
    expect(contextSource).toContain("read enough exact surrounding text first")
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
    expect(chatViewSource).toContain("contextItems: this.deps.contextStore.viewItems()")
    expect(chatViewSource).toContain('type: "removeContextItem"')
    expect(chatViewSource).toContain('type: "toggleContextPin"')
    expect(chatViewSource).toContain('this.deps.contextStore.addFile(uri, "persistent")')
    expect(chatViewSource).toContain('type: "openContextItem"')
    expect(chatViewSource).toContain("workspaceDiagnosticsSummary")
    expect(chatViewSource).toContain("diagnosticCount: diagnostics.total")
    expect(chatViewSource).toContain("vscode.workspace.getWorkspaceFolder(uri)")
  })

  test("stores explicit file and selection context separately", () => {
    expect(contextSource).toContain('kind: "file"')
    expect(contextSource).toContain('kind: "selection"')
    expect(contextSource).toContain("addTrackedSelectionToContext")
    expect(contextSource).toContain('lifetime: "one-shot"')
    expect(contextSource).toContain('store.addFile(active.document.uri, "persistent")')
    expect(contextSource).toContain("consumeOneShot")
    expect(contextSource).toContain('"attached selection"')
    expect(contextSource).toContain("contextForStoredItem")
    expect(contextSource.indexOf("for (const item of contextItems)")).toBeLessThan(
      contextSource.indexOf("if (options.includeSelection"),
    )
  })

  test("queues send-specific context snapshots", () => {
    expect(chatViewSource).toContain("contextItems: LocalContextItem[]")
    expect(chatViewSource).toContain("contextItems: contextItems.map")
    expect(chatViewSource).toContain("next.contextItems")
    expect(chatViewSource).toContain("this.deps.contextStore.consumeOneShot(contextItems)")
    expect(chatViewSource).toContain("this.deps.contextStore.restore(queued.contextItems)")
  })
})
