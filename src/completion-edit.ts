import { formatCompletionBlock, formatCompletionInsertText, formatCompletionReplacementText } from "./completion-format"
import type { CompletionIndentContext } from "./completion-indent"

export type CompletionPosition = {
  line: number
  character: number
}

export type CompletionRange = {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export type CompletionEditInput = {
  text: string
  languageId: string
  linePrefix: string
  lineSuffix: string
  position: CompletionPosition
  indent: CompletionIndentContext
  currentWord?: string
  currentWordRange?: CompletionRange
}

export type CompletionEdit = {
  insertText: string
  replaceRange?: CompletionRange
  filterText?: string
  formatRange?: CompletionRange
  normalized?: "prefix-overlap"
}

export type CompletionEditRejectReason =
  | "empty-model-text"
  | "unsafe-colon-context"
  | "no-insert-text"
  | "misaligned-leading-newline"

export type CompletionEditResult =
  | { edit: CompletionEdit; reason?: never }
  | { edit?: undefined; reason: CompletionEditRejectReason }

export function buildCompletionEdit(input: CompletionEditInput): CompletionEdit | undefined {
  return buildCompletionEditResult(input).edit
}

export function buildCompletionEditResult(input: CompletionEditInput): CompletionEditResult {
  if (input.lineSuffix.trim() && !input.text) {
    return { reason: "empty-model-text" }
  }
  if (!input.text) {
    const fallback = controlFlowFallback(input)
    if (fallback) return { edit: fallback }
    return { reason: "empty-model-text" }
  }
  if (input.lineSuffix.trim()) {
    const insertText = input.text
    return {
      edit: zeroWidthInsertion(input, insertText),
    }
  }

  const wordReplacement = currentWordReplacement(input)
  if (wordReplacement) return { edit: wordReplacement }

  const prefixOverlap = linePrefixOverlapInsertion(input)
  if (prefixOverlap) return { edit: prefixOverlap }

  if (isBraceLanguage(input.languageId) && looksLikeColonFunctionSignature(input.linePrefix)) {
    const edit = braceFunctionReplacement(input)
    return edit ? { edit } : { reason: "no-insert-text" }
  }

  if (isBraceLanguage(input.languageId) && input.linePrefix.trimEnd().endsWith(":")) {
    return { reason: "unsafe-colon-context" }
  }

  if (isMisalignedLeadingNewline(input)) {
    return { reason: "misaligned-leading-newline" }
  }

  const insertText = formatCompletionInsertText({
    text: input.text,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix,
    targetIndent: input.indent.targetIndent,
    indentUnit: input.indent.indentUnit,
    languageId: input.languageId,
  })
  if (!insertText) return { reason: "no-insert-text" }
  if (insertText === input.text) {
    return {
      edit: zeroWidthInsertion(input, insertText),
    }
  }

  return {
    edit: zeroWidthInsertion(input, insertText),
  }
}

function linePrefixOverlapInsertion(input: CompletionEditInput): CompletionEdit | undefined {
  const overlap = linePrefixOverlapLength(input.text, input.linePrefix)
  if (overlap <= 0) return

  const currentIndent = lineIndent(input.linePrefix)
  const insertText = formatCompletionReplacementText(
    input.text.slice(overlap),
    currentIndent,
    input.indent.indentUnit,
    input.languageId,
  )
  if (!insertText) return
  return zeroWidthInsertion(input, insertText, "prefix-overlap")
}

function currentWordReplacement(input: CompletionEditInput): CompletionEdit | undefined {
  if (!input.currentWord || !input.currentWordRange) return
  if (!startsWithCurrentWord(input.text, input.currentWord)) {
    const fallback = controlFlowFallback(input)
    if (fallback) return fallback
    return
  }

  const currentIndent = lineIndent(input.linePrefix)
  const insertText = formatCompletionReplacementText(
    input.text,
    currentIndent,
    input.indent.indentUnit,
    input.languageId,
  )
  if (!insertText) return

  return {
    insertText,
    replaceRange: input.currentWordRange,
    filterText: insertText,
    formatRange: formatRangeAfterInsert(input.position.line, input.currentWordRange.startCharacter, insertText),
  }
}

function controlFlowFallback(input: CompletionEditInput): CompletionEdit | undefined {
  if (!input.currentWord || !input.currentWordRange) return
  if (input.lineSuffix.trim()) return
  if (!isBraceLanguage(input.languageId)) return
  const template = controlFlowTemplate(input.currentWord)
  if (!template) return

  const currentIndent = lineIndent(input.linePrefix)
  const insertText = formatCompletionReplacementText(template, currentIndent, input.indent.indentUnit, input.languageId)
  return {
    insertText,
    replaceRange: input.currentWordRange,
    filterText: insertText,
    formatRange: formatRangeAfterInsert(input.position.line, input.currentWordRange.startCharacter, insertText),
  }
}

function isMisalignedLeadingNewline(input: CompletionEditInput) {
  if (!hasLeadingLineBreak(input.text)) return false
  if (!input.linePrefix.trim()) return false
  if (startsBlockCompletionContext(input.linePrefix)) return false
  return true
}

function hasLeadingLineBreak(text: string) {
  return /^[ \t]*\r?\n/.test(text)
}

function startsBlockCompletionContext(linePrefix: string) {
  const trimmed = linePrefix.trimEnd()
  if (!trimmed) return false
  return /(?:[:{]|=>)$/.test(trimmed)
}

function zeroWidthInsertion(input: CompletionEditInput, insertText: string, normalized?: "prefix-overlap"): CompletionEdit {
  const replaceRange = zeroWidthRange(input.position)
  return {
    insertText,
    replaceRange,
    filterText: insertText,
    formatRange: formatRangeAfterInsert(input.position.line, input.position.character, insertText),
    ...(normalized ? { normalized } : {}),
  }
}

function zeroWidthRange(position: CompletionPosition): CompletionRange {
  return {
    startLine: position.line,
    startCharacter: position.character,
    endLine: position.line,
    endCharacter: position.character,
  }
}

function braceFunctionReplacement(input: CompletionEditInput): CompletionEdit | undefined {
  const colon = input.linePrefix.lastIndexOf(":")
  if (colon === -1) return

  const baseIndent = lineIndent(input.linePrefix)
  const body = formatCompletionBlock(input.text, input.indent.targetIndent, input.indent.indentUnit, input.languageId)
  const insertText = ` {${body}\n${baseIndent}}`
  const replaceRange = {
    startLine: input.position.line,
    startCharacter: colon,
    endLine: input.position.line,
    endCharacter: input.position.character,
  }

  return {
    insertText,
    replaceRange,
    filterText: input.linePrefix.slice(colon),
    formatRange: formatRangeAfterInsert(input.position.line, 0, input.linePrefix.slice(0, colon) + insertText),
  }
}

function formatRangeAfterInsert(startLine: number, startCharacter: number, insertText: string): CompletionRange {
  const parts = insertText.replace(/\r\n/g, "\n").split("\n")
  const endLine = startLine + parts.length - 1
  const endCharacter = parts.length === 1 ? startCharacter + parts[0].length : parts[parts.length - 1].length
  return {
    startLine,
    startCharacter,
    endLine,
    endCharacter,
  }
}

function isBraceLanguage(languageId: string) {
  return new Set([
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "javascript",
    "javascriptreact",
    "rust",
    "typescript",
    "typescriptreact",
  ]).has(languageId)
}

function startsWithCurrentWord(text: string, currentWord: string) {
  if (!currentWord) return false
  return text.trimStart().startsWith(currentWord)
}

function linePrefixOverlapLength(text: string, linePrefix: string) {
  const prefixes = uniqueNonEmpty([linePrefix, linePrefix.trimStart()]).sort((left, right) => right.length - left.length)
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return prefix.length

    const trimmedText = text.trimStart()
    const leadingWhitespace = text.length - trimmedText.length
    if (leadingWhitespace > 0 && trimmedText.startsWith(prefix)) return leadingWhitespace + prefix.length
  }
  return 0
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0 && value.trim().length > 0))]
}

function controlFlowTemplate(currentWord: string) {
  if (currentWord.length < 2) return
  if ("while".startsWith(currentWord)) return "while (condition) {\n\n}"
  if ("for".startsWith(currentWord)) return "for (;;) {\n\n}"
  if ("if".startsWith(currentWord)) return "if (condition) {\n\n}"
  if ("else".startsWith(currentWord)) return "else {\n\n}"
  return
}

function looksLikeColonFunctionSignature(linePrefix: string) {
  return /^\s*[\w\s*]+[A-Za-z_]\w*\s*\([^;{}]*\)\s*:\s*$/.test(linePrefix)
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}
