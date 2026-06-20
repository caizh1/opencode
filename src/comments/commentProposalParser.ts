import type { CommentResponsePreview } from "./commentDiagnostics"
import type { RawCommentProposal } from "./commentTypes"

export type CommentProposalParseResult =
  | { ok: true; proposals: RawCommentProposal[] }
  | { ok: false; reason: string }

export function parseCommentProposalResponse(input: string): CommentProposalParseResult {
  const text = input.trim()
  if (!text) return { ok: false, reason: "模型返回为空" }
  if (/^```/.test(text) || /```$/.test(text)) return { ok: false, reason: "不允许 markdown code fence" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `JSON 无效: ${message}` }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "顶层 JSON 必须是对象" }
  }
  const proposals = (parsed as { proposals?: unknown }).proposals
  if (!Array.isArray(proposals)) return { ok: false, reason: "proposals 必须是数组" }
  return { ok: true, proposals: proposals as RawCommentProposal[] }
}

export function summarizeCommentProposalResponse(input: string): CommentResponsePreview {
  const text = input.trim()
  if (!text) return { kind: "raw", preview: "空响应" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "raw", preview: safePreview(text) }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "raw", preview: safePreview(text) }
  }
  const proposals = (parsed as { proposals?: unknown }).proposals
  if (!Array.isArray(proposals)) {
    return { kind: "raw", preview: safePreview(text) }
  }

  return {
    kind: "structured",
    proposalCount: proposals.length,
    proposals: proposals.slice(0, 8).map((proposal, index) => {
      const value = proposal && typeof proposal === "object" && !Array.isArray(proposal)
        ? proposal as Record<string, unknown>
        : {}
      const anchor = value.anchor && typeof value.anchor === "object" && !Array.isArray(value.anchor)
        ? value.anchor as Record<string, unknown>
        : {}
      const codeEvidence = Array.isArray(value.codeEvidence) ? value.codeEvidence : []
      const evidenceRanges = codeEvidence.slice(0, 3).map((item) => {
        const evidence = item && typeof item === "object" && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {}
        return {
          source: typeof evidence.source === "string" ? evidence.source : undefined,
          startLine: Number.isInteger(evidence.startLine) ? evidence.startLine as number : undefined,
          endLine: Number.isInteger(evidence.endLine) ? evidence.endLine as number : undefined,
        }
      })
      return {
        index,
        kind: typeof value.kind === "string" ? value.kind : undefined,
        confidence: typeof value.confidence === "string" ? value.confidence : undefined,
        insertBeforeLine: Number.isInteger(value.insertBeforeLine) ? value.insertBeforeLine as number : undefined,
        commentBytes: byteLength(typeof value.commentText === "string" ? value.commentText : ""),
        reasonBytes: byteLength(typeof value.reason === "string" ? value.reason : ""),
        anchorBytes: byteLength(typeof anchor.targetLineText === "string" ? anchor.targetLineText : ""),
        evidenceSpanCount: codeEvidence.length,
        selectionEvidenceCount: codeEvidence.filter((item) => evidenceSource(item) === "selection").length,
        repositoryEvidenceCount: codeEvidence.filter((item) => evidenceSource(item) === "repository").length,
        evidenceRanges,
      }
    }),
  }
}

function safePreview(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}

function evidenceSource(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const source = (input as Record<string, unknown>).source
  return typeof source === "string" ? source : undefined
}
