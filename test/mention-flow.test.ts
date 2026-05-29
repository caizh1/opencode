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

  test("sends mentioned files into local context packing", () => {
    expect(chatViewSource).toContain("mentionedFileUris")
    expect(chatViewSource).toContain("mentionedFiles,")
    expect(chatViewSource).toContain("buildChatPrompt({")
    expect(contextSource).toContain("mentionedFiles?: vscode.Uri[]")
    expect(contextSource).toContain('fileContext(uri, settings, "mentioned file")')
  })
})
