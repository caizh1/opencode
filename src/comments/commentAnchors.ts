import { commentSyntaxForLanguage } from "./commentLanguage"
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
  languageId = "c",
): CommentInsertionAnchor[] {
  const anchors = new Map<number, CommentInsertionAnchor>()
  let firstSafeCodeLine: number | undefined

  const start = Math.max(0, selectionStartLine)
  const end = Math.min(document.lineCount - 1, selectionEndLine)
  for (let line = start; line <= end; line += 1) {
    if (!isSafeAnchorLine(document, line, languageId)) continue
    const text = document.lineAt(line).text
    const trimmed = text.trim()
    if (!trimmed) continue
    if (firstSafeCodeLine === undefined) firstSafeCodeLine = line

    const kind = anchorKindForLine(document, line, languageId)
    if (kind) {
      anchors.set(line, anchorForLine(document, line, kind))
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

function anchorKindForLine(document: AnchorDocument, line: number, languageId: string): CommentInsertionAnchorKind | undefined {
  switch (languageId) {
    case "shellscript":
      if (isShellFunctionStartLine(document, line)) return "function"
      if (isShellControlBlockStart(document.lineAt(line).text.trim())) return "controlBlock"
      return undefined
    case "makefile":
      if (isMakefileRuleLine(document.lineAt(line).text)) return "function"
      if (isMakefileConditionalStart(document.lineAt(line).text.trim())) return "controlBlock"
      return undefined
    case "yaml":
      return isYamlStructuralStart(document.lineAt(line).text.trim()) ? "controlBlock" : undefined
    default:
      if (isCFunctionStartLine(document, line)) return "function"
      if (isCFunctionLikeStartLine(document, line)) return "functionLikeStart"
      if (isCControlBlockStart(document.lineAt(line).text.trim())) return "controlBlock"
      return undefined
  }
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

function isSafeAnchorLine(document: AnchorDocument, line: number, languageId: string) {
  if (line < 0 || line >= document.lineCount) return false
  const text = document.lineAt(line).text
  const trimmed = text.trim()
  if (!trimmed) return false
  const syntax = commentSyntaxForLanguage(languageId)
  if (syntax === "hash-line") {
    if (trimmed.startsWith("#")) return false
  } else {
    if (trimmed.startsWith("//")) return false
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) return false
    if (isInsideBlockComment(document, line)) return false
  }
  if (isLineContinuationBoundary(document, line)) return false
  return true
}

function isCFunctionStartLine(document: AnchorDocument, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed.includes("(") || !trimmed.includes(")")) return false
  if (isCControlBlockStart(trimmed)) return false
  if (/^#/.test(trimmed)) return false
  if (/[=]/.test(trimmed)) return false
  if (/->|\./.test(trimmed)) return false
  if (/;\s*$/.test(trimmed)) return false
  const next = nextNonEmptyLine(document, line + 1)
  return /{\s*$/.test(trimmed) || next?.trim() === "{"
}

function isCFunctionLikeStartLine(document: AnchorDocument, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed.includes("(")) return false
  if (isCControlBlockStart(trimmed)) return false
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

function isCControlBlockStart(trimmed: string) {
  const withoutLeadingBrace = trimmed.replace(/^}\s*/, "")
  return /^(if|switch|for|while)\s*\(/.test(withoutLeadingBrace) ||
    /^do\b/.test(withoutLeadingBrace) ||
    /^else\b/.test(withoutLeadingBrace) ||
    /^(case\b.*:|default\s*:)/.test(withoutLeadingBrace)
}

function isShellFunctionStartLine(document: AnchorDocument, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed || trimmed.startsWith("#")) return false
  if (isShellControlBlockStart(trimmed)) return false
  const next = nextNonEmptyLine(document, line + 1)?.trim()
  if (!/^(?:function\s+)?[A-Za-z_][\w]*\s*(?:\(\s*\))?\s*(?:\{\s*)?$/.test(trimmed)) return false
  return trimmed.endsWith("{") || next === "{"
}

function isShellControlBlockStart(trimmed: string) {
  const withoutLeadingBrace = trimmed.replace(/^}\s*/, "")
  return /^(if|elif)\b.*\bthen\b/.test(withoutLeadingBrace) ||
    /^(for|while|until|select)\b.*\bdo\b/.test(withoutLeadingBrace) ||
    /^case\b.*\bin\b/.test(withoutLeadingBrace) ||
    /^do\b/.test(withoutLeadingBrace) ||
    /^else\b/.test(withoutLeadingBrace)
}

function isMakefileRuleLine(text: string) {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith("#")) return false
  if (/^\s/.test(text)) return false
  if (/^[^:=\s][^=]*::?(?![=])/.test(trimmed)) return true
  return /^\.[A-Za-z0-9_.-]+::?(?![=])/.test(trimmed)
}

function isMakefileConditionalStart(trimmed: string) {
  return /^(ifeq|ifneq|ifdef|ifndef|else)\b/.test(trimmed)
}

function isYamlStructuralStart(trimmed: string) {
  if (!trimmed || trimmed.startsWith("#")) return false
  if (trimmed.startsWith("- ")) return true
  return /:\s*(#.*)?$/.test(trimmed)
}

function nextNonEmptyLine(document: AnchorDocument, startLine: number) {
  for (let line = startLine; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text
    if (text.trim()) return text
  }
  return undefined
}

function isLineContinuationBoundary(document: AnchorDocument, insertBeforeLine: number) {
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
