import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("file mention flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const contextSource = readFileSync(join(import.meta.dir, "..", "src", "context.ts"), "utf8")

  test("searches workspace files through an indexed mention flow", () => {
    expect(chatViewSource).toContain("searchFilesForMention")
    expect(chatViewSource).toContain("buildMentionIndex")
    expect(chatViewSource).toContain("searchMentionIndex")
    expect(chatViewSource).toContain("vscode.workspace.findFiles")
    expect(chatViewSource).toContain("20000")
    expect(chatViewSource).toContain("mentionResults")
    expect(chatViewSource).toContain("relativePath(uri)")
  })

  test("invalidates cached mention index when workspace files change", () => {
    expect(chatViewSource).toContain("mentionIndexGeneration")
    expect(chatViewSource).toContain("invalidateMentionIndex")
    expect(chatViewSource).toContain('vscode.workspace.createFileSystemWatcher("**/*")')
    expect(chatViewSource).toContain(".onDidCreate")
    expect(chatViewSource).toContain(".onDidDelete")
    expect(chatViewSource).toContain("vscode.workspace.onDidChangeWorkspaceFolders")
    expect(chatViewSource).not.toContain(".onDidChange((uri) => this.handleMentionIndexFileEvent(uri)")
  })

  test("sends mentioned files into local context packing", () => {
    expect(chatViewSource).toContain("resolveExistingMentionedFiles")
    expect(chatViewSource).toContain("mentionedFiles,")
    expect(chatViewSource).toContain("buildChatPrompt({")
    expect(chatViewSource).toContain("await vscode.workspace.fs.stat(uri)")
    expect(chatViewSource).toContain("stat.type !== vscode.FileType.File")
    expect(chatViewSource).toContain("[mention] skipped missing/stale file")
    expect(contextSource).toContain("mentionedFiles?: vscode.Uri[]")
    expect(contextSource).toContain('fileContext(uri, settings, "mentioned file")')
  })

  test("resolves dropped workspace files before adding them as mentioned files", () => {
    expect(chatViewSource).toContain('{ type: "addDroppedFiles"; candidates?: string[] }')
    expect(chatViewSource).toContain('case "addDroppedFiles"')
    expect(chatViewSource).toContain("resolveDroppedFiles")
    expect(chatViewSource).toContain("droppedFileUriCandidates")
    expect(chatViewSource).toContain("vscode.workspace.getWorkspaceFolder(uri)")
    expect(chatViewSource).toContain("vscode.workspace.fs.stat(uri)")
    expect(chatViewSource).toContain("vscode.FileType.File")
    expect(chatViewSource).toContain('type: "droppedFilesResolved"')
    expect(chatViewSource).toContain("settings.context.maxFiles")
    expect(chatViewSource).not.toContain("this.deps.contextStore.addFile(uri)")
  })

  test("renders explicit context attachments in the composer", () => {
    expect(chatViewSource).toContain("contextItems: this.deps.contextStore.viewItems()")
    expect(contextSource).toContain("LocalContextViewItem")
    expect(contextSource).toContain("selectionDetailPreview")
  })
})
