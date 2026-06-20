import {
  COMMENT_CONFIDENCES,
  COMMENT_PROPOSAL_KINDS,
  type CommentConfidence,
  type CommentInsertionAnchor,
  type CommentLineSpan,
  type CommentProposalKind,
  type RawCommentEvidence,
  type RawCommentProposal,
} from "./commentTypes"

export type CommentProposalValidationContext = {
  selectionStartLine: number
  selectionEndLine: number
  allowedInsertBeforeLines: number[]
  allowedAnchors?: Pick<CommentInsertionAnchor, "line" | "targetLineText">[]
  maxProposals?: number
  changedLineSpans?: CommentLineSpan[]
}

export type CommentProposalDiscard = {
  index: number
  reason: string
}

export type CommentProposalRepair = {
  index: number
  anchorLineRepaired: true
  originalInsertBeforeLine: number
  repairedInsertBeforeLine: number
  repairReason: string
}

export type CommentProposalValidationResult = {
  proposals: RawCommentProposal[]
  discarded: CommentProposalDiscard[]
  repairs: CommentProposalRepair[]
}

const DEFAULT_MAX_PROPOSALS = 3
const HARD_MAX_PROPOSALS = 8
const MAX_CODE_EVIDENCE = 3
const MAX_COMMENT_TEXT_LENGTH = 1000
const KINDS = new Set<string>(COMMENT_PROPOSAL_KINDS)
const CONFIDENCES = new Set<string>(COMMENT_CONFIDENCES)
const CODE_LIKE_PATTERNS = [
  /^return\b/,
  /^#define\b/,
  /^(if|for|while|switch)\s*\([^)]*\)\s*(\{|;)?\s*$/,
  /^else\s*(\{|if\b.*)?\s*$/,
  /^(case\b.+|default)\s*:\s*$/,
]

export function validateRawCommentProposals(
  input: RawCommentProposal[],
  context: CommentProposalValidationContext,
): CommentProposalValidationResult {
  const proposals: RawCommentProposal[] = []
  const discarded: CommentProposalDiscard[] = []
  const repairs: CommentProposalRepair[] = []
  const maxProposals = boundedMaxProposals(context.maxProposals)

  input.forEach((candidate, index) => {
    if (proposals.length >= maxProposals) {
      discarded.push({ index, reason: "注释候选数量超过动态上限" })
      return
    }
    const repaired = repairProposalAnchorLine(candidate, index, context)
    const reason = validateRawCommentProposal(repaired.proposal, context)
    if (reason) {
      discarded.push({ index, reason })
      return
    }
    proposals.push(repaired.proposal)
    if (repaired.repair) repairs.push(repaired.repair)
  })

  return { proposals, discarded, repairs }
}

function boundedMaxProposals(input: number | undefined) {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_MAX_PROPOSALS
  return Math.max(0, Math.min(HARD_MAX_PROPOSALS, Math.floor(input)))
}

export function discardReasonHistogram(discarded: Array<{ reason: string }>) {
  const histogram: Record<string, number> = {}
  for (const item of discarded) {
    histogram[item.reason] = (histogram[item.reason] ?? 0) + 1
  }
  return histogram
}

export function validateRawCommentProposal(
  proposal: RawCommentProposal,
  context: CommentProposalValidationContext,
) {
  if (!proposal || typeof proposal !== "object") return "proposal 必须是对象"
  if (!Number.isInteger(proposal.insertBeforeLine)) return "insertBeforeLine 必须是整数"
  if (proposal.insertBeforeLine < context.selectionStartLine || proposal.insertBeforeLine > context.selectionEndLine) {
    return "insertBeforeLine 超出选区范围"
  }
  if (!context.allowedInsertBeforeLines.includes(proposal.insertBeforeLine)) {
    return "insertBeforeLine 不是允许的结构锚点"
  }
  if (!isCommentProposalKind(proposal.kind)) return "kind 不受支持"
  if (!isCommentConfidence(proposal.confidence)) return "confidence 不受支持"
  if (proposal.confidence === "low") return "低置信度注释候选已忽略"
  if (typeof proposal.indent !== "string") return "indent 必须是字符串"
  if (typeof proposal.reason !== "string") return "reason 必须是字符串"
  const codeEvidenceReason = validateCodeEvidence(proposal.codeEvidence, context)
  if (codeEvidenceReason) return codeEvidenceReason
  if (!proposal.anchor || typeof proposal.anchor !== "object") return "anchor 必填"
  if (typeof proposal.anchor.targetLineText !== "string" || !proposal.anchor.targetLineText.trim()) {
    return "anchor.targetLineText 不能为空"
  }
  if (typeof proposal.commentText !== "string" || !proposal.commentText.trim()) return "commentText 不能为空"
  if (proposal.commentText.length > MAX_COMMENT_TEXT_LENGTH) return "commentText 过长"
  if (!isCommentOnlyText(proposal.commentText)) return "commentText 只能包含注释"
  if (looksLikeCodeStatement(proposal.commentText)) return "commentText 看起来像代码"
  return undefined
}

export function validateCodeEvidence(input: unknown, context: CommentProposalValidationContext) {
  if (!Array.isArray(input)) return "codeEvidence 必须是非空数组"
  if (input.length === 0) return "codeEvidence 必须是非空数组"
  if (input.length > MAX_CODE_EVIDENCE) return "codeEvidence 数量超过上限"
  let hasSelectionEvidence = false
  let hasChangedLineEvidence = false
  for (const item of input) {
    const reason = validateCodeEvidenceItem(item, context)
    if (reason) return reason
    const evidence = item as RawCommentEvidence
    if (evidence.source === "selection") {
      hasSelectionEvidence = true
      if (lineRangeOverlapsAny({ startLine: evidence.startLine, endLine: evidence.endLine }, context.changedLineSpans ?? [])) {
        hasChangedLineEvidence = true
      }
    }
  }
  if (!hasSelectionEvidence) return "codeEvidence 必须包含选区代码证据"
  if ((context.changedLineSpans?.length ?? 0) > 0 && !hasChangedLineEvidence) {
    return "codeEvidence 必须绑定本次改动行"
  }
  return undefined
}

function validateCodeEvidenceItem(input: unknown, context: CommentProposalValidationContext) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "codeEvidence 条目必须是对象"
  const evidence = input as RawCommentEvidence
  if (evidence.source !== "selection" && evidence.source !== "repository") return "codeEvidence.source 不受支持"
  if (!Number.isInteger(evidence.startLine) || !Number.isInteger(evidence.endLine)) {
    return "codeEvidence 行号必须是整数"
  }
  if (evidence.startLine > evidence.endLine) return "codeEvidence 行号范围无效"
  if (evidence.source === "selection" && (evidence.startLine < context.selectionStartLine || evidence.endLine > context.selectionEndLine)) {
    return "codeEvidence 选区行号超出选区范围"
  }
  if (evidence.source === "repository" && (evidence.startLine < 0 || evidence.endLine < 0)) {
    return "codeEvidence 仓库行号不能为负数"
  }
  if (!nonEmptyString(evidence.anchorLabel)) return "codeEvidence.anchorLabel 不能为空"
  if (!nonEmptyString(evidence.codeSummary)) return "codeEvidence.codeSummary 不能为空"
  if (!nonEmptyString(evidence.meaning)) return "codeEvidence.meaning 不能为空"
  if (evidence.filePath !== undefined && typeof evidence.filePath !== "string") return "codeEvidence.filePath 必须是字符串"
  return undefined
}

export function isCommentOnlyText(input: string) {
  const text = input.trim()
  if (!text) return false
  const lines = text.split(/\r?\n/)
  if (lines.every((line) => !line.trim() || line.trimStart().startsWith("//"))) return true
  if (text.startsWith("/*") && text.endsWith("*/")) return true
  return false
}

function looksLikeCodeStatement(input: string) {
  return commentBodyLines(input).some((line) => looksLikeAssignmentOrBraceCode(line))
}

function nonEmptyString(input: unknown) {
  return typeof input === "string" && input.trim().length > 0
}

function lineRangeOverlapsAny(range: { startLine: number; endLine: number }, spans: CommentLineSpan[]) {
  return spans.some((span) => range.startLine <= span.endLine && range.endLine >= span.startLine)
}

function repairProposalAnchorLine(
  proposal: RawCommentProposal,
  index: number,
  context: CommentProposalValidationContext,
): { proposal: RawCommentProposal; repair?: CommentProposalRepair } {
  if (!proposal || typeof proposal !== "object") return { proposal }
  if (!Number.isInteger(proposal.insertBeforeLine)) return { proposal }
  if (context.allowedInsertBeforeLines.includes(proposal.insertBeforeLine)) return { proposal }
  const targetLineText = proposal.anchor?.targetLineText
  if (typeof targetLineText !== "string" || !targetLineText.trim()) return { proposal }
  const matches = (context.allowedAnchors ?? [])
    .filter((anchor) => normalizeLine(anchor.targetLineText) === normalizeLine(targetLineText))
  if (matches.length !== 1) return { proposal }
  const repairedLine = matches[0]!.line
  return {
    proposal: {
      ...proposal,
      insertBeforeLine: repairedLine,
    },
    repair: {
      index,
      anchorLineRepaired: true,
      originalInsertBeforeLine: proposal.insertBeforeLine,
      repairedInsertBeforeLine: repairedLine,
      repairReason: Math.abs(proposal.insertBeforeLine - repairedLine) === 1
        ? "anchor.targetLineText 唯一匹配允许锚点，修正相邻行号"
        : "anchor.targetLineText 唯一匹配允许锚点，修正行号",
    },
  }
}

function normalizeLine(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function commentBodyLines(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*\/\//, "")
      .replace(/^\s*\/\*+/, "")
      .replace(/\*\/\s*$/, "")
      .replace(/^\s*\*/, "")
      .trim())
    .filter(Boolean)
}

function looksLikeAssignmentOrBraceCode(line: string) {
  if (CODE_LIKE_PATTERNS.some((pattern) => pattern.test(line))) return true
  if (/^[{}]\s*$/.test(line)) return true
  if (/^[A-Za-z_][\w\s*()[\].>\-]*\s*=\s*[^=].*;\s*$/.test(line)) return true
  if (/^[A-Za-z_][\w\s*()[\].>\-]*\s*=\s*[^=]*\w+\s*\([^)]*\)/.test(line)) return true
  if (/^[A-Za-z_][\w.>\-]*\s*\([^)]*\)\s*;\s*$/.test(line)) return true
  return /[{}]/.test(line) && (
    /^(if|for|while|switch)\s*\(/.test(line) ||
    /;\s*$/.test(line) ||
    /^[A-Za-z_][\w\s*()[\].>\-]*[{}]/.test(line)
  )
}

function isCommentProposalKind(input: unknown): input is CommentProposalKind {
  return typeof input === "string" && KINDS.has(input)
}

function isCommentConfidence(input: unknown): input is CommentConfidence {
  return typeof input === "string" && CONFIDENCES.has(input)
}
