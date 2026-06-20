export const COMMENT_PROPOSAL_KINDS = [
  "functionHeader",
  "logicBlock",
  "hardware",
  "stateMachine",
  "errorHandling",
  "concurrency",
  "dmaCache",
  "other",
] as const

export const COMMENT_CONFIDENCES = ["high", "medium", "low"] as const

export type CommentProposalKind = typeof COMMENT_PROPOSAL_KINDS[number]
export type CommentConfidence = typeof COMMENT_CONFIDENCES[number]
export type CommentProposalStatus = "pending" | "accepted" | "rejected" | "stale"
export type CommentGroundingConfidence = "high" | "medium" | "low" | "none"
export type CommentOutputDirective = "encourage-1-3" | "allow-empty"
export type CommentSelectionIntent = "functionOrBlockSummary" | "localBlock"
export type CommentPrimaryAnchorPolicy = "required-when-supported" | "allow-when-useful"
export type CommentReviewSource = "selection" | "currentFunction"

export type CommentInsertionAnchorKind = "function" | "functionLikeStart" | "selectionStart" | "controlBlock"

export type CommentInsertionAnchor = {
  line: number
  kind: CommentInsertionAnchorKind
  targetLineText: string
  summary: string
}

export type RawCommentEvidence = {
  source: "selection" | "repository"
  filePath?: string
  startLine: number
  endLine: number
  anchorLabel: string
  codeSummary: string
  meaning: string
}

export interface RawCommentProposal {
  kind: CommentProposalKind;
  insertBeforeLine: number;
  indent: string;
  commentText: string;
  anchor: {
    targetLineText: string;
  };
  confidence: CommentConfidence;
  reason: string;
  codeEvidence: RawCommentEvidence[];
}

export interface CommentProposal extends RawCommentProposal {
  id: string;
  uri: string;
  source: CommentReviewSource;
  documentVersion: number;
  selectionStartLine: number;
  selectionEndLine: number;
  selectionStartCharacter: number;
  selectionEndCharacter: number;
  selectionTextEndLine: number;
  selectionTextEndCharacter: number;
  contextHash: string;
  status: CommentProposalStatus;
}

export type CommentEvidenceSections = {
  selectionAnchors: string
  graphRepoSummary: string
  graphDirectRefs: string
  ragSummary: string
  toolEvidence: string
  groundingSummary: string
}

export type CommentGenerationContext = {
  uri: string
  source: CommentReviewSource
  filePath: string
  workspacePath: string
  languageId: string
  documentVersion: number
  selectionStartLine: number
  selectionEndLine: number
  selectionStartCharacter: number
  selectionEndCharacter: number
  selectionTextEndLine: number
  selectionTextEndCharacter: number
  selectedCode: string
  contextBefore: string
  contextAfter: string
  existingCommentExamples: string
  retrievalMode: "graph-only" | "hybrid" | "tool-driven"
  outputDirective: CommentOutputDirective
  groundingConfidence: CommentGroundingConfidence
  groundingSummary: string
  evidenceCompacted: boolean
  evidenceSections: CommentEvidenceSections
  evidenceSummary: string
  evidenceItemCount: number
  allowedInsertionAnchors: CommentInsertionAnchor[]
  selectionIntent: CommentSelectionIntent
  proposalBudget: number
  primaryAnchorPolicy: CommentPrimaryAnchorPolicy
  primaryAnchorLine?: number
  primaryAnchorKind?: CommentInsertionAnchorKind
  internalAnchorLines: number[]
  contextHash: string
}
