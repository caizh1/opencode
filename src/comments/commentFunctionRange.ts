import * as vscode from "vscode"
import { isSupportedCurrentFunctionCommentLanguage } from "./commentLanguage"
import type { CommentWorkspaceReviewUnitKind } from "./commentTypes"

const FUNCTION_HEADER_LOOKBACK_LINES = 24
const FUNCTION_BRACE_LOOKAHEAD_LINES = 16

type BraceFrame = {
  line: number
  character: number
}

type ReviewUnitSelection = {
  selection: vscode.Selection
  unitKind: CommentWorkspaceReviewUnitKind
}

type TextDocumentLike = {
  lineCount: number
  languageId?: string
  lineAt(line: number): { text: string }
}

export function resolveCurrentFunctionSelection(editor: vscode.TextEditor): vscode.Selection | undefined {
  const languageId = editor.document.languageId
  if (!isSupportedCurrentFunctionCommentLanguage(languageId)) return undefined
  const document = editor.document
  if (document.lineCount === 0) return undefined
  const cursorLine = clamp(editor.selection.active.line, 0, document.lineCount - 1)
  const cursorCharacter = Math.max(0, editor.selection.active.character)

  switch (languageId) {
    case "shellscript":
      return resolveShellFunctionSelectionAtPosition(document, cursorLine)
    case "makefile":
      return resolveMakefileRuleSelectionAtLine(document, cursorLine)
    default:
      return resolveCFunctionSelectionAtPosition(document, cursorLine, cursorCharacter)
  }
}

export function resolveFunctionSelectionAtLine(
  document: vscode.TextDocument | TextDocumentLike,
  line: number,
  languageId = document.languageId ?? "c",
): vscode.Selection | undefined {
  if (document.lineCount === 0) return undefined
  const targetLine = clamp(line, 0, document.lineCount - 1)
  switch (languageId) {
    case "shellscript":
      return resolveShellFunctionSelectionAtPosition(document, targetLine)
    case "makefile":
      return resolveMakefileRuleSelectionAtLine(document, targetLine)
    case "yaml":
      return undefined
    default:
      return resolveCFunctionSelectionAtPosition(document, targetLine, document.lineAt(targetLine).text.length)
  }
}

export function resolveWorkspaceReviewUnitSelectionAtLine(
  document: vscode.TextDocument | TextDocumentLike,
  line: number,
  languageId = document.languageId ?? "c",
): ReviewUnitSelection | undefined {
  const functionSelection = resolveFunctionSelectionAtLine(document, line, languageId)
  if (functionSelection) {
    return {
      selection: functionSelection,
      unitKind: languageId === "makefile" ? "block" : "function",
    }
  }

  switch (languageId) {
    case "shellscript": {
      const selection = resolveShellControlBlockSelectionAtLine(document, line)
      return selection ? { selection, unitKind: "block" } : undefined
    }
    case "makefile": {
      const selection = resolveMakefileConditionalSelectionAtLine(document, line)
      return selection ? { selection, unitKind: "block" } : undefined
    }
    case "yaml": {
      const selection = resolveYamlBlockSelectionAtLine(document, line)
      return selection ? { selection, unitKind: "block" } : undefined
    }
    default:
      return undefined
  }
}

function resolveCFunctionSelectionAtPosition(
  document: TextDocumentLike,
  cursorLine: number,
  cursorCharacter: number,
): vscode.Selection | undefined {
  const stack = openBraceStackBeforeCursor(document, cursorLine, cursorCharacter, stripCLineComments)
  const candidateOpenBraces = [
    ...stack.map((frame) => frame.line),
    ...forwardFunctionBraceCandidates(document, cursorLine, stripCLineComments),
  ]

  for (const braceLine of uniqueNumbers(candidateOpenBraces).sort((left, right) => left - right)) {
    const headerStartLine = cFunctionHeaderStartLine(document, braceLine)
    if (headerStartLine === undefined) continue
    const header = linesBetween(document, headerStartLine, braceLine, stripCLineComments).join(" ")
    if (!isCFunctionHeader(header)) continue
    const endLine = matchingBraceEndLine(document, braceLine, stripCLineComments)
    if (endLine === undefined) continue
    if (cursorLine < headerStartLine || cursorLine > endLine) continue
    return selectionForRange(document, headerStartLine, endLine)
  }

  return undefined
}

function openBraceStackBeforeCursor(
  document: TextDocumentLike,
  cursorLine: number,
  cursorCharacter: number,
  stripComments: (input: string) => string,
) {
  const stack: BraceFrame[] = []
  for (let line = 0; line <= cursorLine; line += 1) {
    const text = document.lineAt(line).text
    const limit = line === cursorLine ? scanLimitForCursorLine(text, cursorCharacter) : text.length
    const stripped = stripComments(text.slice(0, limit))
    for (let character = 0; character < stripped.length; character += 1) {
      const value = stripped[character]
      if (value === "{") {
        stack.push({ line, character })
      } else if (value === "}") {
        stack.pop()
      }
    }
  }
  return stack
}

function scanLimitForCursorLine(text: string, cursorCharacter: number) {
  const trimmed = text.trim()
  if (trimmed === "}" || trimmed.startsWith("} ")) return 0
  return Math.min(text.length, Math.max(0, cursorCharacter))
}

function forwardFunctionBraceCandidates(
  document: TextDocumentLike,
  cursorLine: number,
  stripComments: (input: string) => string,
) {
  const lines: number[] = []
  const endLine = Math.min(document.lineCount - 1, cursorLine + FUNCTION_BRACE_LOOKAHEAD_LINES)
  for (let line = cursorLine; line <= endLine; line += 1) {
    const text = stripComments(document.lineAt(line).text)
    if (text.includes(";")) break
    if (text.includes("{")) {
      lines.push(line)
      break
    }
  }
  return lines
}

function cFunctionHeaderStartLine(document: TextDocumentLike, braceLine: number) {
  let startLine = braceLine
  for (let line = braceLine; line >= Math.max(0, braceLine - FUNCTION_HEADER_LOOKBACK_LINES); line -= 1) {
    const trimmed = stripCLineComments(document.lineAt(line).text).trim()
    if (!trimmed) {
      if (line !== braceLine) break
      continue
    }
    if (line !== braceLine && isCHeaderBoundary(trimmed)) break
    startLine = line
    if (trimmed.includes("(") || trimmed.startsWith("#")) {
      continue
    }
  }
  return startLine <= braceLine ? startLine : undefined
}

function isCFunctionHeader(headerInput: string) {
  const header = headerInput
    .replace(/\s+/g, " ")
    .replace(/\{\s*$/, "")
    .trim()
  if (!header) return false
  if (!header.includes("(") || !header.includes(")")) return false
  if (header.includes(";")) return false
  if (/^#/.test(header)) return false
  if (/^(if|for|while|switch|catch|else|do)\b/.test(header)) return false
  if (/\b(if|for|while|switch|catch)\s*\([^)]*\)\s*$/.test(header)) return false
  if (/[=]/.test(header)) return false
  if (/->|\.[A-Za-z_]/.test(header)) return false
  if (/^[+-]\s*\([^)]*\)\s*[A-Za-z_]\w*(?::|\s|\{|$)/.test(header)) return true
  if (!/[A-Za-z_~][\w:~]*\s*\([^;{}]*\)\s*(const\b|noexcept\b|override\b|final\b|[A-Za-z_]\w*\s*)*$/.test(header)) {
    return false
  }
  return true
}

function matchingBraceEndLine(
  document: TextDocumentLike,
  braceLine: number,
  stripComments: (input: string) => string,
) {
  let depth = 0
  for (let line = braceLine; line < document.lineCount; line += 1) {
    const stripped = stripComments(document.lineAt(line).text)
    for (const value of stripped) {
      if (value === "{") depth += 1
      if (value === "}") {
        depth -= 1
        if (depth === 0) return line
      }
    }
  }
  return undefined
}

function resolveShellFunctionSelectionAtPosition(document: TextDocumentLike, cursorLine: number) {
  for (let line = cursorLine; line >= 0; line -= 1) {
    const braceLine = shellFunctionBraceLine(document, line)
    if (braceLine === undefined) continue
    const endLine = matchingBraceEndLine(document, braceLine, stripShellLineComments)
    if (endLine === undefined) continue
    if (cursorLine < line || cursorLine > endLine) continue
    return selectionForRange(document, line, endLine)
  }
  return undefined
}

function shellFunctionBraceLine(document: TextDocumentLike, line: number) {
  const trimmed = document.lineAt(line).text.trim()
  if (!trimmed || trimmed.startsWith("#")) return undefined
  if (!/^(?:function\s+)?[A-Za-z_][\w]*\s*(?:\(\s*\))?\s*(?:\{\s*)?$/.test(trimmed)) return undefined
  if (/^(if|elif|for|while|until|case|select|else|do)\b/.test(trimmed)) return undefined
  if (trimmed.includes("{")) return line
  const nextLine = nextNonEmptyLineIndex(document, line + 1)
  if (nextLine !== undefined && document.lineAt(nextLine).text.trim() === "{") return nextLine
  return undefined
}

function resolveShellControlBlockSelectionAtLine(document: TextDocumentLike, cursorLine: number) {
  for (let line = cursorLine; line >= 0; line -= 1) {
    const startKind = shellBlockStartKind(document.lineAt(line).text.trim())
    if (!startKind) continue
    const endLine = matchingShellBlockEndLine(document, line, startKind)
    if (endLine === undefined) continue
    if (cursorLine < line || cursorLine > endLine) continue
    return selectionForRange(document, line, endLine)
  }
  return undefined
}

function shellBlockStartKind(trimmed: string): "if" | "loop" | "case" | undefined {
  const text = trimmed.replace(/^}\s*/, "")
  if (/^if\b.*\bthen\b/.test(text)) return "if"
  if (/^(for|while|until|select)\b.*\bdo\b/.test(text) || /^do\b/.test(text)) return "loop"
  if (/^case\b.*\bin\b/.test(text)) return "case"
  return undefined
}

function matchingShellBlockEndLine(document: TextDocumentLike, startLine: number, kind: "if" | "loop" | "case") {
  let depth = 0
  for (let line = startLine; line < document.lineCount; line += 1) {
    const trimmed = stripShellLineComments(document.lineAt(line).text).trim()
    if (!trimmed) continue
    if (shellBlockStartKind(trimmed) === kind) depth += 1
    if ((kind === "if" && /^fi\b/.test(trimmed)) || (kind === "loop" && /^done\b/.test(trimmed)) || (kind === "case" && /^esac\b/.test(trimmed))) {
      depth -= 1
      if (depth === 0) return line
    }
  }
  return undefined
}

function resolveMakefileRuleSelectionAtLine(document: TextDocumentLike, cursorLine: number) {
  for (let line = cursorLine; line >= 0; line -= 1) {
    if (!isMakefileRuleLine(document.lineAt(line).text)) continue
    const endLine = makefileRuleEndLine(document, line)
    if (cursorLine < line || cursorLine > endLine) continue
    return selectionForRange(document, line, endLine)
  }
  return undefined
}

function makefileRuleEndLine(document: TextDocumentLike, startLine: number) {
  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text
    const trimmed = text.trim()
    if (!trimmed) continue
    if (isMakefileRuleLine(text)) return line - 1
  }
  return document.lineCount - 1
}

function resolveMakefileConditionalSelectionAtLine(document: TextDocumentLike, cursorLine: number) {
  for (let line = cursorLine; line >= 0; line -= 1) {
    const startKind = makefileConditionalStart(document.lineAt(line).text.trim())
    if (!startKind) continue
    const endLine = matchingMakefileConditionalEndLine(document, line)
    if (endLine === undefined) continue
    if (cursorLine < line || cursorLine > endLine) continue
    return selectionForRange(document, line, endLine)
  }
  return undefined
}

function makefileConditionalStart(trimmed: string) {
  return /^(ifeq|ifneq|ifdef|ifndef)\b/.test(trimmed)
}

function matchingMakefileConditionalEndLine(document: TextDocumentLike, startLine: number) {
  let depth = 0
  for (let line = startLine; line < document.lineCount; line += 1) {
    const trimmed = document.lineAt(line).text.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (makefileConditionalStart(trimmed)) depth += 1
    if (/^endif\b/.test(trimmed)) {
      depth -= 1
      if (depth === 0) return line
    }
  }
  return undefined
}

function resolveYamlBlockSelectionAtLine(document: TextDocumentLike, cursorLine: number) {
  const targetLine = clamp(cursorLine, 0, document.lineCount - 1)
  for (let line = targetLine; line >= 0; line -= 1) {
    const text = document.lineAt(line).text
    const trimmed = text.trim()
    if (!isYamlStructuralStart(trimmed)) continue
    const endLine = yamlBlockEndLine(document, line)
    if (targetLine < line || targetLine > endLine) continue
    return selectionForRange(document, line, endLine)
  }
  return undefined
}

function yamlBlockEndLine(document: TextDocumentLike, startLine: number) {
  const startIndent = indentOf(document.lineAt(startLine).text)
  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text
    const trimmed = text.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#")) continue
    const indent = indentOf(text)
    if (indent < startIndent) return line - 1
    if (indent === startIndent && isYamlStructuralStart(trimmed)) return line - 1
  }
  return document.lineCount - 1
}

function isMakefileRuleLine(text: string) {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith("#")) return false
  if (/^\s/.test(text)) return false
  if (/^[^:=\s][^=]*::?(?![=])/.test(trimmed)) return true
  return /^\.[A-Za-z0-9_.-]+::?(?![=])/.test(trimmed)
}

function isYamlStructuralStart(trimmed: string) {
  if (!trimmed || trimmed.startsWith("#")) return false
  if (trimmed.startsWith("- ")) return true
  return /:\s*(#.*)?$/.test(trimmed)
}

function nextNonEmptyLineIndex(document: TextDocumentLike, startLine: number) {
  for (let line = startLine; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text.trim()) return line
  }
  return undefined
}

function linesBetween(
  document: TextDocumentLike,
  startLine: number,
  endLine: number,
  stripComments: (input: string) => string,
) {
  const lines: string[] = []
  for (let line = startLine; line <= endLine; line += 1) {
    const cleaned = stripComments(document.lineAt(line).text).trim()
    if (cleaned) lines.push(cleaned)
  }
  return lines
}

function isCHeaderBoundary(trimmed: string) {
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) return true
  if (trimmed.endsWith(";")) return true
  if (trimmed.endsWith("}")) return true
  if (/^(if|for|while|switch|case\b|default\b|else|do)\b/.test(trimmed)) return true
  return false
}

function stripCLineComments(input: string) {
  return input.replace(/\/\/.*$/, "")
}

function stripShellLineComments(input: string) {
  return input.replace(/\s+#.*$/, "").replace(/^#.*$/, "")
}

function indentOf(input: string) {
  return input.match(/^\s*/)?.[0].length ?? 0
}

function selectionForRange(document: TextDocumentLike, startLine: number, endLine: number) {
  return new vscode.Selection(startLine, 0, endLine, document.lineAt(endLine).text.length)
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
