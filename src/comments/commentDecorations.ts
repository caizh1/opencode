import * as vscode from "vscode"
import { commentCodeblockLanguage } from "./commentLanguage"
import { commentEvidenceDetail } from "./commentPreview"
import type { CommentProposalStore } from "./commentProposalStore"
import type { CommentProposal } from "./commentTypes"

export class CommentDecorations implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
  })
  private readonly storeSubscription: { dispose(): void }
  private readonly visibleEditorSubscription: vscode.Disposable

  constructor(private readonly store: CommentProposalStore) {
    this.storeSubscription = this.store.onDidChange(() => this.refreshAll())
    this.visibleEditorSubscription = vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll())
    this.refreshAll()
  }

  refreshAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  }

  dispose() {
    this.storeSubscription.dispose()
    this.visibleEditorSubscription.dispose()
    this.decorationType.dispose()
  }

  private refreshEditor(editor: vscode.TextEditor) {
    const proposals = this.store.pendingForDocument(editor.document.uri.toString())
    const decorations = proposals.map((proposal) => ({
      range: new vscode.Range(proposal.insertBeforeLine, 0, proposal.insertBeforeLine, 0),
      hoverMessage: hoverMessage(proposal, editor.document.languageId),
    }))
    editor.setDecorations(this.decorationType, decorations)
  }
}

function hoverMessage(proposal: CommentProposal, languageId: string) {
  const markdown = new vscode.MarkdownString(undefined, true)
  markdown.isTrusted = false
  markdown.appendMarkdown("**AI 注释候选**\n\n")
  markdown.appendCodeblock(proposal.commentText, commentCodeblockLanguage(languageId))
  markdown.appendMarkdown(`\n\n置信度: ${proposal.confidence}`)
  const evidence = commentEvidenceDetail(proposal.codeEvidence)
  if (evidence) markdown.appendMarkdown(`\n\n**代码证据**\n\n${escapeMarkdown(evidence)}`)
  if (proposal.reason.trim()) markdown.appendMarkdown(`\n\n综合原因: ${proposal.reason.trim()}`)
  markdown.appendMarkdown("\n\n点击 CodeLens 的 **预览完整注释** 查看完整候选；点击 **接受** 后才会插入文件。")
  return markdown
}

function escapeMarkdown(input: string) {
  return input.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&")
}
