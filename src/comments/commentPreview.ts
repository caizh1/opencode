import type { CommentProposal, RawCommentEvidence } from "./commentTypes"

const PREVIEW_SUMMARY_MAX_LENGTH = 96
const FALLBACK_PREVIEW_TEXT = "可预览 AI 注释候选"

export function commentPreviewText(commentText: string) {
  const trimmed = commentText.trimStart()
  const style = trimmed.startsWith("/*")
    ? "block"
    : trimmed.startsWith("#")
      ? "hash"
      : "line"
  const summary = commentPreviewSummary(commentText)
  if (style === "block") return `+ /** ${summary} */`
  if (style === "hash") return `+ # ${summary}`
  return `+ // ${summary}`
}

export function commentPreviewSummary(commentText: string) {
  const normalizedLines = commentText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(stripCommentMarker)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  const summary = normalizedLines[0] ?? FALLBACK_PREVIEW_TEXT
  const truncated = summary.length > PREVIEW_SUMMARY_MAX_LENGTH
    ? `${summary.slice(0, PREVIEW_SUMMARY_MAX_LENGTH - 3).trimEnd()}...`
    : summary
  if (normalizedLines.length > 1 && !truncated.endsWith("...")) return `${truncated}...`
  return truncated
}

export function commentPreviewDetail(proposal: Pick<CommentProposal, "commentText" | "confidence" | "reason" | "codeEvidence">) {
  const sections = [
    proposal.commentText.trim(),
    `置信度: ${proposal.confidence}`,
  ]
  const evidence = commentEvidenceDetail(proposal.codeEvidence)
  if (evidence) sections.push(`代码证据:\n${evidence}`)
  const reason = proposal.reason.trim()
  if (reason) sections.push(`综合原因: ${reason}`)
  return sections.join("\n\n")
}

export function commentEvidenceDetail(evidence: RawCommentEvidence[]) {
  return evidence
    .map(commentEvidenceLine)
    .filter(Boolean)
    .join("\n")
}

export function commentEvidenceLine(evidence: RawCommentEvidence) {
  const source = evidence.source === "repository" && evidence.filePath?.trim()
    ? `${evidence.filePath.trim()}:`
    : ""
  const range = evidence.startLine === evidence.endLine
    ? `第 ${evidence.startLine + 1} 行`
    : `第 ${evidence.startLine + 1}-${evidence.endLine + 1} 行`
  return `${source}${range} · ${evidence.anchorLabel}: ${evidence.codeSummary} -> ${evidence.meaning}`
}

function stripCommentMarker(line: string) {
  let text = line.trim()
  if (text === "/*" || text === "/**" || text === "*/" || text === "*") return ""
  if (text.startsWith("#")) return text.slice(1).trim()
  if (text.startsWith("//")) return text.slice(2).trim()
  if (text.startsWith("/**")) text = text.slice(3).trim()
  else if (text.startsWith("/*")) text = text.slice(2).trim()
  if (text.startsWith("*")) text = text.slice(1).trim()
  if (text.endsWith("*/")) text = text.slice(0, -2).trim()
  return text
}
