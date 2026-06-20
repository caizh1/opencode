import * as vscode from "vscode"

const FUNCTION_HEADER_LOOKBACK_LINES = 24
const FUNCTION_BRACE_LOOKAHEAD_LINES = 16

type BraceFrame = {
  line: number
  character: number
}

export function resolveCurrentFunctionSelection(editor: vscode.TextEditor): vscode.Selection | undefined {
  const document = editor.document
  if (document.lineCount === 0) return undefined
  const cursorLine = clamp(editor.selection.active.line, 0, document.lineCount - 1)
  const cursorCharacter = Math.max(0, editor.selection.active.character)
  const stack = openBraceStackBeforeCursor(document, cursorLine, cursorCharacter)
  const candidateOpenBraces = [
    ...stack.map((frame) => frame.line),
    ...forwardFunctionBraceCandidates(document, cursorLine),
  ]

  for (const braceLine of uniqueNumbers(candidateOpenBraces).sort((left, right) => left - right)) {
    const headerStartLine = functionHeaderStartLine(document, braceLine)
    if (headerStartLine === undefined) continue
    const header = linesBetween(document, headerStartLine, braceLine).join(" ")
    if (!isFunctionHeader(header)) continue
    const endLine = matchingBraceEndLine(document, braceLine)
    if (endLine === undefined) continue
    if (cursorLine < headerStartLine || cursorLine > endLine) continue
    return new vscode.Selection(
      headerStartLine,
      0,
      endLine,
      document.lineAt(endLine).text.length,
    )
  }

  return undefined
}

function openBraceStackBeforeCursor(document: vscode.TextDocument, cursorLine: number, cursorCharacter: number) {
  const stack: BraceFrame[] = []
  for (let line = 0; line <= cursorLine; line += 1) {
    const text = document.lineAt(line).text
    const limit = line === cursorLine ? scanLimitForCursorLine(text, cursorCharacter) : text.length
    const stripped = stripLineComments(text.slice(0, limit))
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

function forwardFunctionBraceCandidates(document: vscode.TextDocument, cursorLine: number) {
  const lines: number[] = []
  const endLine = Math.min(document.lineCount - 1, cursorLine + FUNCTION_BRACE_LOOKAHEAD_LINES)
  for (let line = cursorLine; line <= endLine; line += 1) {
    const text = stripLineComments(document.lineAt(line).text)
    if (text.includes(";")) break
    if (text.includes("{")) {
      lines.push(line)
      break
    }
  }
  return lines
}

function functionHeaderStartLine(document: vscode.TextDocument, braceLine: number) {
  let startLine = braceLine
  for (let line = braceLine; line >= Math.max(0, braceLine - FUNCTION_HEADER_LOOKBACK_LINES); line -= 1) {
    const trimmed = stripLineComments(document.lineAt(line).text).trim()
    if (!trimmed) {
      if (line !== braceLine) break
      continue
    }
    if (line !== braceLine && isHeaderBoundary(trimmed)) break
    startLine = line
    if (trimmed.includes("(") || trimmed.startsWith("#")) {
      continue
    }
  }
  return startLine <= braceLine ? startLine : undefined
}

function isFunctionHeader(headerInput: string) {
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

function matchingBraceEndLine(document: vscode.TextDocument, braceLine: number) {
  let depth = 0
  for (let line = braceLine; line < document.lineCount; line += 1) {
    const stripped = stripLineComments(document.lineAt(line).text)
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

function linesBetween(document: vscode.TextDocument, startLine: number, endLine: number) {
  const lines: string[] = []
  for (let line = startLine; line <= endLine; line += 1) {
    const cleaned = stripLineComments(document.lineAt(line).text).trim()
    if (cleaned) lines.push(cleaned)
  }
  return lines
}

function isHeaderBoundary(trimmed: string) {
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) return true
  if (trimmed.endsWith(";")) return true
  if (trimmed.endsWith("}")) return true
  if (/^(if|for|while|switch|case\b|default\b|else|do)\b/.test(trimmed)) return true
  return false
}

function stripLineComments(input: string) {
  return input.replace(/\/\/.*$/, "")
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
