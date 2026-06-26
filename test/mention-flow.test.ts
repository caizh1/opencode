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
    expect(chatViewSource).toContain("mentionedContext: this.mentionedContextFromRefs(mentionedFileRefs)")
    expect(chatViewSource).toContain("buildChatPromptWithEvidence({")
    expect(chatViewSource).toContain("evidenceLedger: promptResult.evidenceLedgerInput")
    expect(chatViewSource).toContain("historyText: pluginHistoryUserText(trimmed || \"Please review the referenced files.\")")
    expect(chatViewSource).toContain('messageMode: "plugin-chat"')
    expect(chatViewSource).toContain("await vscode.workspace.fs.stat(uri)")
    expect(chatViewSource).toContain("stat.type & vscode.FileType.Directory")
    expect(chatViewSource).toContain("[mention] skipped missing/stale file")
    expect(contextSource).toContain("mentionedContext?: MentionedContextRef[]")
    expect(contextSource).toContain('fileContext(uri, settings, "mentioned file")')
    expect(contextSource).toContain('fileContext(uri, settings, "mentioned folder")')
  })

  test("resolves dropped workspace files before adding them as mentioned files", () => {
    expect(chatViewSource).toContain('{ type: "addDroppedFiles"; candidates?: string[] }')
    expect(chatViewSource).toContain('{ type: "importSkillCandidates"; candidates?: string[] }')
    expect(chatViewSource).toContain('case "addDroppedFiles"')
    expect(chatViewSource).toContain('case "importSkillCandidates"')
    expect(chatViewSource).toContain("resolveDroppedFiles")
    expect(chatViewSource).toContain("droppedFileUriCandidates")
    expect(chatViewSource).toContain("vscode.workspace.getWorkspaceFolder(uri)")
    expect(chatViewSource).toContain("vscode.workspace.fs.stat(uri)")
    expect(chatViewSource).toContain("vscode.FileType.File")
    expect(chatViewSource).toContain("vscode.FileType.Directory")
    expect(chatViewSource).toContain('type: "droppedFilesResolved"')
    expect(chatViewSource).toContain("importSkills")
    expect(chatViewSource).not.toContain("this.importSkillCandidates(message.candidates ?? [])\n          break\n        case \"addDroppedFiles\"")
    expect(chatViewSource).toContain("settings.context.maxFiles")
    expect(chatViewSource).not.toContain("this.deps.contextStore.addFile(uri)")
  })

  test("keeps folder attachments as current-message context", () => {
    expect(chatViewSource).toContain('type?: "file" | "folder"')
    expect(chatViewSource).toContain('= stat.type & vscode.FileType.Directory ? "folder" : "file"')
    expect(chatViewSource).toContain("mentionedFileRefs.map((file) => ({ ...file }))")
    expect(contextSource).toContain("expandMentionedFolderContext")
    expect(contextSource).toContain("isMentionIndexExcludedPath(relativePath(uri))")
  })

  test("picks workspace files for the current message without persistent context", () => {
    expect(chatViewSource).toContain('{ type: "pickWorkspaceFilesForMessage" }')
    expect(chatViewSource).toContain('case "pickWorkspaceFilesForMessage"')
    expect(chatViewSource).toContain("pickWorkspaceFilesForMessage")
    expect(chatViewSource).toContain("vscode.window.showQuickPick")
    expect(chatViewSource).toContain("canPickMany: true")
    expect(chatViewSource).toContain('entry.type === "file"')
    expect(chatViewSource).toContain("mentionFileRefFromEntry")
    expect(chatViewSource).toContain('type: "workspaceFilesPicked"')
    expect(chatViewSource).toContain("settings.context.maxFiles")
    expect(chatViewSource).toContain("addPickedFilesToContext(this.deps.contextStore)")
  })

  test("renders explicit context attachments in the composer", () => {
    expect(chatViewSource).toContain("contextItems: this.deps.contextStore.viewItems()")
    expect(contextSource).toContain("LocalContextViewItem")
    expect(contextSource).toContain("selectionDetailPreview")
  })
})
