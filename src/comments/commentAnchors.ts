import type { CommentInsertionAnchor, CommentInsertionAnchorKind } from "./commentTypes"

export type AnchorDocument = {
  lineCount: number
  lineAt(line: number): { text: string }
}

const ANCHOR_SUMMARY_MAX_LENGTH = 120

export function collectCommentInsertionAnchors(
  document: AnchorDocument,
  selectionStartLine: number,
  selectionEndLine: number,
): CommentInsertionAnchor[] {
  const anchors = new Map<number, CommentInsertionAnchor>()
  let firstSafeCodeLine: number | undefined

  const start = Math.max(0, selectionStartLine)
  const end = Math.min(document.lineCount - 1, selectionEndLine)
  for (let line = start; line <= end; line += 1) {
    if (!isSafeAnchorLine(document, line)) continue
    const text = document.lineAt(line).text
    const trimmed = text.trim()
    if (!trimmed) continue
    if (firstSafeCodeLine === undefined) firstSafeCodeLine = line

    if (isFunctionStartLine(document, line)) {
      anchors.set(line, anchorForLine(document, line, "function"))
      continue
    }
    if (isFunctionLikeStartLine(document, line)) {
      anchors.set(line, anchorForLine(document, line, "functionLikeStart"))
      continue
    }
    if (isControlBlockStart(trimmed)) {
      anchors.set(line, anchorForLine(document, line, "controlBlock"))
    }
  }

  if (firstSafeCodeLine !== undefined && !anchors.has(firstSafeCodeLine)) {
    anchors.set(firstSafeCodeLine, anchorForLine(document, firstSafeCodeLine, "selectionStart"))
  }

  return [...anchors.values()].sort((left, right) => left.line - right.line)
}

export function formatAllowedInsertionAnchors(anchors: CommentInsertionAnchor[]) {
  if (anchors.length === 0) return "无可用结构锚点。"
  return JSON.stringify(anchors.map((anchor) => ({
    insertBeforeLine: anchor.line,
    vscodeDisplayLine: anchor.line + 1,
    kind: anchor.kind,
    targetLineText: anchor.targetLineText.trim(),
    summary: anchor.summary,
  })), null, 2)
}

export function allowedAnchorLines(anchors: CommentInsertionAnchor[]) {
  return anchors.map((anchor) => anchor.line)
}

function anchorForLine(document: AnchorDocument, line: number, kind: CommentInsertionAnchorKind): CommentInsertionAnchor {
  const targetLineText = document.lineAt(line).text
  return {
    line,
    kind,
    targetLineText,
    summary: oneLine(targetLineText, ANCHOR_SUMMARY_MAX_LENGTH),
  }
}

function isSafeAnchorLine(document: AnchorDocument, line: number) {
  if (line < 0 || line >= document.lineCount) return false
  const text = document.lineAt(line).text
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("//")) return false
  if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) return false
  if (isMacroContinuationBoundary(document, line)) return false
  if (isInsideBlockComment(document, line)) return false
  return true
}

function isFunctionStartLine(document: AnchorDocument, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed.includes("(") || !trimmed.includes(")")) return false
  if (isControlBlockStart(trimmed)) return false
  if (/^#/.test(trimmed)) return false
  if (/[=]/.test(trimmed)) return false
  if (/->|\./.test(trimmed)) return false
  if (/;\s*$/.test(trimmed)) return false
  const next = nextNonEmptyLine(document, line + 1)
  return /{\s*$/.test(trimmed) || next?.trim() === "{"
}

function isFunctionLikeStartLine(document: AnchorDocument, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed.includes("(")) return false
  if (isControlBlockStart(trimmed)) return false
  if (/^#/.test(trimmed)) return false
  if (/[=]/.test(trimmed)) return false
  if (/->|\./.test(trimmed)) return false
  if (/;\s*$/.test(trimmed)) return false
  if (!/^[A-Za-z_][\w\s*]*\b[A-Za-z_]\w*\s*\(/.test(trimmed)) return false

  const signature = signaturePrefixUntilBraceOrSemicolon(document, line)
  if (!signature || signature.includes(";")) return false
  return signature.includes("(") && signature.includes(")") && signature.includes("{")
}

function signaturePrefixUntilBraceOrSemicolon(document: AnchorDocument, startLine: number) {
  const lines: string[] = []
  for (let line = startLine; line < Math.min(document.lineCount, startLine + 8); line += 1) {
    const trimmed = document.lineAt(line).text.trim()
    if (!trimmed) continue
    lines.push(trimmed)
    if (trimmed.includes("{") || trimmed.endsWith(";")) break
  }
  return lines.join(" ")
}

function isControlBlockStart(trimmed: string) {
  const withoutLeadingBrace = trimmed.replace(/^}\s*/, "")
  return /^(if|switch|for|while)\s*\(/.test(withoutLeadingBrace) ||
    /^do\b/.test(withoutLeadingBrace) ||
    /^else\b/.test(withoutLeadingBrace) ||
    /^(case\b.*:|default\s*:)/.test(withoutLeadingBrace)
}

function nextNonEmptyLine(document: AnchorDocument, startLine: number) {
  for (let line = startLine; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text
    if (text.trim()) return text
  }
  return undefined
}

function isMacroContinuationBoundary(document: AnchorDocument, insertBeforeLine: number) {
  const current = document.lineAt(insertBeforeLine).text.trimEnd()
  if (current.endsWith("\\")) return true
  if (insertBeforeLine === 0) return false
  return document.lineAt(insertBeforeLine - 1).text.trimEnd().endsWith("\\")
}

function isInsideBlockComment(document: AnchorDocument, insertBeforeLine: number) {
  let inBlock = false
  for (let line = 0; line <= insertBeforeLine; line += 1) {
    const text = document.lineAt(line).text
    if (line === insertBeforeLine && !inBlock) {
      const trimmed = text.trim()
      if (!trimmed.startsWith("/*") && !trimmed.startsWith("*")) return false
    }
    inBlock = scanBlockCommentState(text, inBlock)
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

function oneLine(input: string, maxLength: number) {
  const normalized = input.replace(/\s+/g, " ").trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}
