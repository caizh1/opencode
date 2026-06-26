import * as vscode from "vscode"
import { collectCommentInsertionAnchors } from "./commentAnchors"
import { currentContextHashForProposal } from "./commentContext"
import type { CommentProposal } from "./commentTypes"

export type CommentApplyResult =
  | { status: "applied" }
  | { status: "stale"; reason: string }
  | { status: "failed"; reason: string }

export type CommentApplyAllResult = {
  accepted: CommentProposal[]
  skipped: Array<{ proposal: CommentProposal; status: "stale" | "failed"; reason: string }>
}

export async function applyCommentProposal(proposal: CommentProposal, document: vscode.TextDocument): Promise<CommentApplyResult> {
  const staleReason = validateApplyTarget(proposal, document)
  if (staleReason) return { status: "stale", reason: staleReason }

  const workspaceEdit = new vscode.WorkspaceEdit()
  workspaceEdit.insert(
    document.uri,
    new vscode.Position(proposal.insertBeforeLine, 0),
    commentInsertText(proposal, commentInsertIndent(proposal, document)),
  )
  const applied = await vscode.workspace.applyEdit(workspaceEdit)
  if (!applied) return { status: "failed", reason: "VS Code 拒绝了编辑操作" }
  return { status: "applied" }
}

export async function applyCommentProposals(proposals: CommentProposal[], document: vscode.TextDocument): Promise<CommentApplyAllResult> {
  const accepted: CommentProposal[] = []
  const skipped: CommentApplyAllResult["skipped"] = []
  let workspaceEdit: vscode.WorkspaceEdit | undefined
  const sorted = [...proposals].sort((left, right) =>
    right.insertBeforeLine - left.insertBeforeLine || left.id.localeCompare(right.id)
  )

  for (const proposal of sorted) {
    const staleReason = validateApplyTarget(proposal, document)
    if (staleReason) {
      skipped.push({ proposal, status: "stale", reason: staleReason })
      continue
    }
    workspaceEdit ??= new vscode.WorkspaceEdit()
    workspaceEdit.insert(
      document.uri,
      new vscode.Position(proposal.insertBeforeLine, 0),
      commentInsertText(proposal, commentInsertIndent(proposal, document)),
    )
    accepted.push(proposal)
  }

  if (!accepted.length) return { accepted, skipped }

  const applied = await vscode.workspace.applyEdit(workspaceEdit!)
  if (!applied) {
    return {
      accepted: [],
      skipped: [
        ...skipped,
        ...accepted.map((proposal) => ({ proposal, status: "failed" as const, reason: "VS Code 拒绝了编辑操作" })),
      ],
    }
  }
  return { accepted, skipped }
}

export function validateApplyTarget(proposal: CommentProposal, document: vscode.TextDocument) {
  if (document.uri.toString() !== proposal.uri) return "活动文档与注释候选不匹配"
  if (document.version !== proposal.documentVersion) return "文档版本已变化"
  if (proposal.status !== "pending") return "注释候选不是 pending 状态"
  if (proposal.insertBeforeLine < 0 || proposal.insertBeforeLine >= document.lineCount) return "insertBeforeLine 超出文档范围"
  if (currentContextHashForProposal(document, proposal) !== proposal.contextHash) return "选区上下文已变化"
  const currentLineText = document.lineAt(proposal.insertBeforeLine).text.trim()
  if (currentLineText !== proposal.anchor.targetLineText.trim()) return "锚点行已变化"
  if (isMacroContinuationBoundary(document, proposal.insertBeforeLine)) return "插入位置位于宏续行中"
  if (isInsideBlockComment(document, proposal.insertBeforeLine)) return "插入位置位于块注释中"
  const allowedAnchors = collectCommentInsertionAnchors(document, proposal.selectionStartLine, proposal.selectionEndLine, document.languageId)
  if (!allowedAnchors.some((anchor) => anchor.line === proposal.insertBeforeLine)) {
    return "插入位置不再是允许的结构锚点"
  }
  return undefined
}

export function commentInsertText(proposal: Pick<CommentProposal, "indent" | "commentText">, indentOverride?: string) {
  const comment = proposal.commentText.replace(/\r\n/g, "\n").trim()
  const indent = indentOverride ?? proposal.indent
  const lines = comment.split("\n").map((line) => `${indent}${line.trimStart().trimEnd()}`)
  return `${lines.join("\n")}\n`
}

export function commentInsertIndent(proposal: Pick<CommentProposal, "insertBeforeLine" | "indent">, document: vscode.TextDocument) {
  const targetLineIndent = leadingWhitespace(document.lineAt(proposal.insertBeforeLine).text)
  return targetLineIndent || proposal.indent
}

function leadingWhitespace(input: string) {
  return input.match(/^\s*/)?.[0] ?? ""
}

function isMacroContinuationBoundary(document: vscode.TextDocument, insertBeforeLine: number) {
  const current = document.lineAt(insertBeforeLine).text.trimEnd()
  if (current.endsWith("\\")) return true
  if (insertBeforeLine === 0) return false
  return document.lineAt(insertBeforeLine - 1).text.trimEnd().endsWith("\\")
}

function isInsideBlockComment(document: vscode.TextDocument, insertBeforeLine: number) {
  let inBlock = false
  for (let line = 0; line < insertBeforeLine; line += 1) {
    inBlock = scanBlockCommentState(document.lineAt(line).text, inBlock)
  }
  return inBlock
}

function scanBlockCommentState(line: string, initialState: boolean) {
  let inBlock = initialState
  let index = 0
  while (index < line.length) {
    if (inBlock) {
      const close = line.indexOf("*/", index)
      if (close === -1) return true
      inBlock = false
      index = close + 2
      continue
    }
    const open = line.indexOf("/*", index)
    if (open === -1) return false
    const close = line.indexOf("*/", open + 2)
    if (close === -1) return true
    index = close + 2
  }
  return inBlock
}
