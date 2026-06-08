export type CommentGuidedStatementHoleKind =
  | "empty-function-body"
  | "blank-statement"
  | "call-statement"
  | "assignment-rhs"
  | "condition"
  | "member-access"
  | "unknown"

export type CommentGuidedCursorContextFeatures = {
  previousStatementCalls: string[]
  nextStatementCalls: string[]
  scopedPreviousStatementCalls?: string[]
  scopedNextStatementCalls?: string[]
  nearbyLogOrMessageText: string[]
  currentFunctionName?: string
  statementHoleKind: CommentGuidedStatementHoleKind
  flowOrdinalTokens: string[]
  visibleLocals: string[]
  visibleIdentifiers: string[]
  cursorContextScope?: "current-function" | "file-window-fallback"
  currentFunctionBodyIsEmpty?: boolean
  cursorContextFallbackReason?: string
}

const CONTROL_CALL_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "typeof",
  "alignof",
])

const C_KEYWORDS = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
])

export function extractCommentGuidedCursorContext(input: {
  prefix?: string
  suffix?: string
  currentFunctionName?: string
  sourceComment?: string
  cursorContextScope?: "current-function" | "file-window-fallback"
  currentFunctionBodyIsEmpty?: boolean
  cursorContextFallbackReason?: string
}): CommentGuidedCursorContextFeatures {
  const prefix = input.prefix ?? ""
  const suffix = input.suffix ?? ""
  const currentFunctionName = input.currentFunctionName ?? functionNameFromPrefix(prefix)
  const nearbyText = `${tailLines(prefix, 24)}\n${headLines(suffix, 18)}`
  const previousStatementCalls = input.currentFunctionBodyIsEmpty
    ? []
    : callNames(tailLines(prefix, 20)).filter((name) => name !== currentFunctionName).slice(-8)
  const nextStatementCalls = input.currentFunctionBodyIsEmpty
    ? []
    : callNames(headLines(suffix, 16)).filter((name) => name !== currentFunctionName).slice(0, 8)
  const nearbyLogOrMessageText = input.currentFunctionBodyIsEmpty ? [] : stringLiterals(nearbyText).slice(0, 8)
  return {
    previousStatementCalls,
    nextStatementCalls,
    scopedPreviousStatementCalls: previousStatementCalls,
    scopedNextStatementCalls: nextStatementCalls,
    nearbyLogOrMessageText,
    currentFunctionName,
    statementHoleKind: input.currentFunctionBodyIsEmpty ? "empty-function-body" : statementHoleKind(prefix, suffix),
    flowOrdinalTokens: flowOrdinalTokens(`${input.sourceComment ?? ""}\n${nearbyText}`),
    visibleLocals: visibleLocalNames(prefix).slice(-24),
    visibleIdentifiers: visibleIdentifiers(prefix).slice(-64),
    cursorContextScope: input.cursorContextScope,
    currentFunctionBodyIsEmpty: input.currentFunctionBodyIsEmpty,
    cursorContextFallbackReason: input.cursorContextFallbackReason,
  }
}

export function statementHoleKind(prefix: string, suffix = ""): CommentGuidedStatementHoleKind {
  const linePrefix = lastLine(prefix)
  const lineSuffix = firstLine(suffix)
  if (/(?:->|\.)\s*$/.test(linePrefix)) return "member-access"
  if (/\b(?:if|while|for|switch)\s*\([^)]*$/.test(linePrefix)) return "condition"
  if (/(^|[^=!<>])=\s*$/.test(linePrefix)) return "assignment-rhs"
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*$/.test(linePrefix) && !/^\s*[);]/.test(lineSuffix)) return "call-statement"
  if (linePrefix.trim() === "" || /^\s*$/.test(linePrefix)) return "blank-statement"
  return "unknown"
}

function functionNameFromPrefix(prefix: string) {
  const lines = tailLines(prefix, 120).split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const window = lines.slice(Math.max(0, index - 3), index + 1).join(" ")
    const match = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*\{\s*$/.exec(window)
    if (match && !CONTROL_CALL_NAMES.has(match[1]!)) return match[1]
  }
  return undefined
}

function callNames(text: string) {
  const names: string[] = []
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ?? ""
    if (!name || CONTROL_CALL_NAMES.has(name)) continue
    names.push(name)
  }
  return uniqueStrings(names)
}

function stringLiterals(text: string) {
  const values: string[] = []
  for (const match of text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    const value = (match[1] ?? "").replace(/\\[rn"]/g, " ").replace(/\s+/g, " ").trim()
    if (value.length >= 3) values.push(value)
  }
  return uniqueStrings(values)
}

function flowOrdinalTokens(text: string) {
  return uniqueStrings([...text.matchAll(/\b(?:step|stage|phase)\s*[-_:.\s]*([0-9]+|[ivx]+)\b/gi)]
    .map((match) => `${match[0]}`.toLowerCase().replace(/\s+/g, "")))
}

function visibleLocalNames(prefix: string) {
  const names: string[] = []
  const text = tailLines(prefix, 120)
  const declaration = /\b(?:const\s+|volatile\s+|static\s+|struct\s+[A-Za-z_][A-Za-z0-9_]*\s+|enum\s+[A-Za-z_][A-Za-z0-9_]*\s+|union\s+[A-Za-z_][A-Za-z0-9_]*\s+|[A-Za-z_][A-Za-z0-9_]*_t\s+|[A-Za-z_][A-Za-z0-9_]*\s+)+(?:\*+\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|,|\))/g
  for (const match of text.matchAll(declaration)) {
    const name = match[1] ?? ""
    if (name && !C_KEYWORDS.has(name)) names.push(name)
  }
  const params = /\b[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)\s*\{?\s*$/m.exec(text)?.[1]
  for (const param of params?.split(",") ?? []) {
    const name = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(param.trim())?.[1]
    if (name && !C_KEYWORDS.has(name)) names.push(name)
  }
  return uniqueStrings(names)
}

function visibleIdentifiers(prefix: string) {
  return uniqueStrings(tailLines(prefix, 80)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !C_KEYWORDS.has(token) && !CONTROL_CALL_NAMES.has(token)))
}

function headLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(0, count).join("\n")
}

function tailLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(-count).join("\n")
}

function lastLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n").at(-1) ?? ""
}

function firstLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
}

function uniqueStrings<T extends string>(values: T[]) {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
