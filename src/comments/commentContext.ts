import { createHash } from "node:crypto"
import * as vscode from "vscode"
import { collectCommentInsertionAnchors } from "./commentAnchors"
import { commentSyntaxForLanguage, isHashCommentLanguage, SUPPORTED_COMMENT_LANGUAGE_IDS } from "./commentLanguage"
import type { CommentGenerationContext, CommentGroundingConfidence, CommentInsertionAnchor, CommentLineSpan, CommentPrimaryAnchorPolicy, CommentProposal, CommentReviewSource, CommentSelectionIntent, CommentWorkspaceReviewUnitKind } from "./commentTypes"

const CONTEXT_LINE_LIMIT = 20
const COMMENT_STYLE_LOOKBACK_LINES = 100
const COMMENT_STYLE_EXAMPLE_LIMIT = 8
const FUNCTION_OR_BLOCK_SELECTION_LINE_THRESHOLD = 8
const LOCAL_BLOCK_PROPOSAL_BUDGET = 3
const FUNCTION_OR_BLOCK_PROPOSAL_BUDGET_LIMIT = 8

export function isSupportedCommentLanguage(languageId: string) {
  return SUPPORTED_COMMENT_LANGUAGE_IDS.has(languageId)
}

export function buildCommentGenerationContext(
  editor: vscode.TextEditor,
  options: {
    selection?: vscode.Selection
    source?: CommentReviewSource
    workspaceReviewUnitId?: string
    workspaceReviewUnitKind?: CommentWorkspaceReviewUnitKind
    workspaceChangeDiffHash?: string
    changedLineSpans?: CommentLineSpan[]
  } = {},
): CommentGenerationContext {
  const document = editor.document
  const selection = options.selection ?? editor.selection
  const source = options.source ?? "selection"
  const selectionRange = normalizedSelectionLineRange(selection)
  const selectedCode = document.getText(selection)
  const contextBefore = lineSliceText(document, Math.max(0, selectionRange.startLine - CONTEXT_LINE_LIMIT), selectionRange.startLine)
  const contextAfter = lineSliceText(
    document,
    selectionRange.endLine + 1,
    Math.min(document.lineCount, selectionRange.endLine + 1 + CONTEXT_LINE_LIMIT),
  )
  const existingCommentExamples = extractExistingCommentExamples(document, selectionRange.startLine, document.languageId)
  const allowedInsertionAnchors = collectCommentInsertionAnchors(document, selectionRange.startLine, selectionRange.endLine, document.languageId)
  const selectionPolicy = commentSelectionPolicy(selectionRange.startLine, selectionRange.endLine, allowedInsertionAnchors, source)
  const hashInput = {
    source,
    workspaceReviewUnitId: options.workspaceReviewUnitId,
    workspaceReviewUnitKind: options.workspaceReviewUnitKind,
    workspaceChangeDiffHash: options.workspaceChangeDiffHash,
    changedLineSpans: options.changedLineSpans,
    languageId: document.languageId,
    selectionStartLine: selectionRange.startLine,
    selectionEndLine: selectionRange.endLine,
    selectionStartCharacter: selection.start.character,
    selectionEndCharacter: selection.end.character,
    selectionTextEndLine: selection.end.line,
    selectionTextEndCharacter: selection.end.character,
    selectedCode,
    contextBefore,
    contextAfter,
  }

  return {
    uri: document.uri.toString(),
    source,
    workspaceReviewUnitId: options.workspaceReviewUnitId,
    workspaceReviewUnitKind: options.workspaceReviewUnitKind,
    workspaceChangeDiffHash: options.workspaceChangeDiffHash,
    changedLineSpans: options.changedLineSpans,
    filePath: document.uri.fsPath || document.uri.toString(),
    workspacePath: document.uri.scheme === "file" ? vscode.workspace.asRelativePath(document.uri, false) : document.uri.toString(),
    languageId: document.languageId,
    commentSyntax: commentSyntaxForLanguage(document.languageId),
    documentVersion: document.version,
    selectionStartLine: selectionRange.startLine,
    selectionEndLine: selectionRange.endLine,
    selectionStartCharacter: selection.start.character,
    selectionEndCharacter: selection.end.character,
    selectionTextEndLine: selection.end.line,
    selectionTextEndCharacter: selection.end.character,
    selectedCode,
    contextBefore,
    contextAfter,
    existingCommentExamples,
    retrievalMode: "graph-only",
    outputDirective: "allow-empty",
    groundingConfidence: "none",
    groundingSummary: "",
    evidenceCompacted: false,
    evidenceSections: {
      selectionAnchors: "",
      graphRepoSummary: "",
      graphDirectRefs: "",
      ragSummary: "",
      toolEvidence: "",
      groundingSummary: "",
    },
    evidenceSummary: "",
    evidenceItemCount: 0,
    allowedInsertionAnchors,
    ...selectionPolicy,
    contextHash: commentContextHash(hashInput),
  }
}

export function commentSelectionPolicy(
  selectionStartLine: number,
  selectionEndLine: number,
  allowedInsertionAnchors: CommentInsertionAnchor[],
  source: CommentReviewSource = "selection",
): Pick<CommentGenerationContext, "selectionIntent" | "proposalBudget" | "primaryAnchorPolicy" | "primaryAnchorLine" | "primaryAnchorKind" | "internalAnchorLines"> {
  const lineSpan = Math.max(0, selectionEndLine - selectionStartLine + 1)
  const primaryAnchor = allowedInsertionAnchors[0]
  if ((lineSpan >= FUNCTION_OR_BLOCK_SELECTION_LINE_THRESHOLD || source === "currentFunction") && primaryAnchor) {
    return {
      selectionIntent: "functionOrBlockSummary",
      proposalBudget: Math.min(FUNCTION_OR_BLOCK_PROPOSAL_BUDGET_LIMIT, allowedInsertionAnchors.length),
      primaryAnchorPolicy: "allow-when-useful",
      primaryAnchorLine: primaryAnchor.line,
      primaryAnchorKind: primaryAnchor.kind,
      internalAnchorLines: allowedInsertionAnchors.slice(1).map((anchor) => anchor.line),
    }
  }
  return {
    selectionIntent: "localBlock",
    proposalBudget: Math.min(LOCAL_BLOCK_PROPOSAL_BUDGET, allowedInsertionAnchors.length || LOCAL_BLOCK_PROPOSAL_BUDGET),
    primaryAnchorPolicy: "allow-when-useful",
    internalAnchorLines: allowedInsertionAnchors.map((anchor) => anchor.line),
  }
}

export function commentPrimaryAnchorPolicy(
  selectionIntent: CommentSelectionIntent,
  groundingConfidence: CommentGroundingConfidence,
): CommentPrimaryAnchorPolicy {
  if (selectionIntent !== "functionOrBlockSummary") return "allow-when-useful"
  return groundingConfidence === "high" || groundingConfidence === "medium"
    ? "required-when-supported"
    : "allow-when-useful"
}

export function currentContextHashForProposal(document: vscode.TextDocument, proposal: CommentProposal) {
  const selection = new vscode.Range(
    proposal.selectionStartLine,
    proposal.selectionStartCharacter,
    proposal.selectionTextEndLine,
    proposal.selectionTextEndCharacter,
  )
  const contextBefore = lineSliceText(document, Math.max(0, proposal.selectionStartLine - CONTEXT_LINE_LIMIT), proposal.selectionStartLine)
  const contextAfter = lineSliceText(
    document,
    proposal.selectionEndLine + 1,
    Math.min(document.lineCount, proposal.selectionEndLine + 1 + CONTEXT_LINE_LIMIT),
  )
  return commentContextHash({
    source: proposal.source,
    workspaceReviewUnitId: proposal.workspaceReviewUnitId,
    workspaceReviewUnitKind: proposal.workspaceReviewUnitKind,
    workspaceChangeDiffHash: proposal.workspaceChangeDiffHash,
    changedLineSpans: proposal.changedLineSpans,
    languageId: document.languageId,
    selectionStartLine: proposal.selectionStartLine,
    selectionEndLine: proposal.selectionEndLine,
    selectionStartCharacter: proposal.selectionStartCharacter,
    selectionEndCharacter: proposal.selectionEndCharacter,
    selectedCode: document.getText(selection),
    contextBefore,
    contextAfter,
  })
}

export function normalizedSelectionLineRange(selection: vscode.Selection) {
  const startLine = selection.start.line
  let endLine = selection.end.line
  if (selection.end.character === 0 && endLine > startLine) endLine -= 1
  return { startLine, endLine }
}

export function commentContextHash(input: {
  source?: CommentReviewSource
  workspaceReviewUnitId?: string
  workspaceReviewUnitKind?: CommentWorkspaceReviewUnitKind
  workspaceChangeDiffHash?: string
  changedLineSpans?: CommentLineSpan[]
  languageId: string
  selectionStartLine: number
  selectionEndLine: number
  selectionStartCharacter: number
  selectionEndCharacter: number
  selectedCode: string
  contextBefore: string
  contextAfter: string
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      languageId: input.languageId,
      source: input.source ?? "selection",
      workspaceReviewUnitId: input.workspaceReviewUnitId,
      workspaceReviewUnitKind: input.workspaceReviewUnitKind,
      workspaceChangeDiffHash: input.workspaceChangeDiffHash,
      changedLineSpans: input.changedLineSpans,
      selectionStartLine: input.selectionStartLine,
      selectionEndLine: input.selectionEndLine,
      selectionStartCharacter: input.selectionStartCharacter,
      selectionEndCharacter: input.selectionEndCharacter,
      selectedCode: input.selectedCode,
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
    }))
    .digest("hex")
}

function lineSliceText(document: vscode.TextDocument, startLine: number, endLineExclusive: number) {
  const lines: string[] = []
  const start = Math.max(0, startLine)
  const end = Math.max(start, Math.min(document.lineCount, endLineExclusive))
  for (let line = start; line < end; line += 1) {
    lines.push(document.lineAt(line).text)
  }
  return lines.join("\n")
}

function extractExistingCommentExamples(document: vscode.TextDocument, selectionStartLine: number, languageId: string) {
  const examples: string[] = []
  const startLine = Math.max(0, selectionStartLine - COMMENT_STYLE_LOOKBACK_LINES)
  if (isHashCommentLanguage(languageId)) {
    for (let line = startLine; line < selectionStartLine && examples.length < COMMENT_STYLE_EXAMPLE_LIMIT; line += 1) {
      const trimmed = document.lineAt(line).text.trim()
      if (trimmed.startsWith("#")) examples.push(trimmed)
    }
    return examples.join("\n")
  }
  let inBlock = false
  for (let line = startLine; line < selectionStartLine && examples.length < COMMENT_STYLE_EXAMPLE_LIMIT; line += 1) {
    const trimmed = document.lineAt(line).text.trim()
    if (!trimmed) continue
    if (inBlock) {
      examples.push(trimmed)
      if (trimmed.includes("*/")) inBlock = false
      continue
    }
    if (trimmed.startsWith("//")) {
      examples.push(trimmed)
      continue
    }
    if (trimmed.startsWith("/*")) {
      examples.push(trimmed)
      if (!trimmed.includes("*/")) inBlock = true
    }
  }
  return examples.join("\n")
}
