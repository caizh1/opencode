import { formatCompletionBlock, formatCompletionInsertText, formatCompletionReplacementText, isCommentPromptCodeCompletion } from "./completion-format"
import type { CompletionIndentContext } from "./completion-indent"
import type { CompletionInsertMode, CompletionPlanKind } from "./completion-types"

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
  preferCurrentWordReplacement?: boolean
}

export type InlineCompletionEditInput = CompletionEditInput & {
  plan: {
    kind?: CompletionPlanKind
    insertMode: CompletionInsertMode
    replaceCurrentWord: boolean
  }
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
  | "echoed-prefix"
  | "unsafe-colon-context"
  | "no-insert-text"
  | "misaligned-leading-newline"

export type CompletionEditResult =
  | { edit: CompletionEdit; reason?: never }
  | { edit?: undefined; reason: CompletionEditRejectReason }

export type CompletionSelectedCompletionInfo = {
  range: CompletionRange
  text: string
}

export type InlineCompletionEditValidationReason =
  | "rangeText-not-prefix-of-filterText"
  | "insertText-does-not-preserve-rangeText"
  | "replaceRange-cross-line"
  | "selectedCompletionInfo-range-mismatch"
  | "selectedCompletionInfo-text-not-prefix"

export type InlineCompletionEditValidationResult =
  | { valid: true; reason?: never }
  | { valid: false; reason: InlineCompletionEditValidationReason }

export type InlineCompletionEditAdaptResult =
  | { status: "ok"; edit: CompletionEdit; reason?: never }
  | { status: "rejected"; reason: InlineCompletionEditValidationReason; edit?: undefined }

export type InlineCompletionEditValidationInput = {
  edit: CompletionEdit
  editInput: Omit<CompletionEditInput, "text">
  plan: {
    kind?: CompletionPlanKind
    insertMode: CompletionInsertMode
    replaceCurrentWord: boolean
  }
  selectedCompletionInfo?: CompletionSelectedCompletionInfo
}

export function adaptAndValidateInlineCompletionEdit(input: InlineCompletionEditValidationInput): InlineCompletionEditAdaptResult {
  const selectedAdapted = input.selectedCompletionInfo
    ? adaptForSelectedCompletion(input)
    : undefined
  if (selectedAdapted?.reason) {
    return {
      status: "rejected",
      reason: selectedAdapted.reason,
    }
  }

  let edit = selectedAdapted?.edit ?? input.edit
  if (!input.selectedCompletionInfo) {
    edit = adaptForCurrentWordReplacement({ ...input, edit }) ?? edit
    edit = adaptForWholeLineReplacement({ ...input, edit })
  }

  const validation = validateInlineCompletionEdit({
    ...input,
    edit,
  })
  if (!validation.valid) {
    return {
      status: "rejected",
      reason: validation.reason,
    }
  }

  return {
    status: "ok",
    edit,
  }
}

export function buildCompletionEdit(input: CompletionEditInput): CompletionEdit | undefined {
  return buildCompletionEditResult(input).edit
}

export function validateInlineCompletionEdit(input: InlineCompletionEditValidationInput): InlineCompletionEditValidationResult {
  const replaceRange = input.edit.replaceRange ?? zeroWidthRange(input.editInput.position)
  if (!isSingleLineRange(replaceRange)) {
    return {
      valid: false,
      reason: "replaceRange-cross-line",
    }
  }

  const rangeText = currentLineRangeText(input.editInput, replaceRange)
  const filterText = input.edit.filterText ?? input.edit.insertText
  if (input.selectedCompletionInfo) {
    if (!input.edit.replaceRange || !sameCompletionRange(input.edit.replaceRange, input.selectedCompletionInfo.range)) {
      return {
        valid: false,
        reason: "selectedCompletionInfo-range-mismatch",
      }
    }

    if (!input.edit.insertText.startsWith(input.selectedCompletionInfo.text)) {
      return {
        valid: false,
        reason: "selectedCompletionInfo-text-not-prefix",
      }
    }

    if (!filterText.startsWith(rangeText)) {
      return {
        valid: false,
        reason: "rangeText-not-prefix-of-filterText",
      }
    }

    return { valid: true }
  }

  if (!filterText.startsWith(rangeText)) {
    return {
      valid: false,
      reason: "rangeText-not-prefix-of-filterText",
    }
  }

  if (!hasSafeReplacementSemantics({
    edit: input.edit,
    editInput: input.editInput,
    plan: input.plan,
    replaceRange,
    rangeText,
  })) {
    return {
      valid: false,
      reason: "insertText-does-not-preserve-rangeText",
    }
  }

  return { valid: true }
}

export function buildInlineCompletionEditResult(input: InlineCompletionEditInput): CompletionEditResult {
  if (!input.text) return { reason: "empty-model-text" }

  switch (input.plan.insertMode) {
    case "replace-current-word":
      return inlineCurrentWordReplacement(input)
    case "insert-at-cursor":
      return inlineCursorInsertion(input)
    case "insert-after-line":
      return inlineAfterLineInsertion(input)
    case "replace-whole-line":
      return inlineWholeLineReplacement(input)
  }
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

  const wordReplacement = input.preferCurrentWordReplacement
    ? currentWordLinePrefixReplacement(input) ?? currentWordReplacement(input)
    : currentWordReplacement(input)
  if (wordReplacement) return { edit: wordReplacement }

  const prefixOverlap = linePrefixOverlapResult(input)
  if (prefixOverlap) return prefixOverlap

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

function inlineCurrentWordReplacement(input: InlineCompletionEditInput): CompletionEditResult {
  const wordReplacement = currentWordLinePrefixReplacement(input) ?? currentWordReplacement(input)
  if (wordReplacement) {
    if (!isSingleLineRange(wordReplacement.replaceRange)) return { reason: "no-insert-text" }
    return { edit: wordReplacement }
  }
  return { reason: "no-insert-text" }
}

function inlineCursorInsertion(input: InlineCompletionEditInput): CompletionEditResult {
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
  if (!insertText.trim()) return { reason: "no-insert-text" }
  return { edit: zeroWidthInsertion(input, insertText) }
}

function inlineAfterLineInsertion(input: InlineCompletionEditInput): CompletionEditResult {
  const insertText = formatAfterLineInsertText(input)
  if (!insertText.trim()) return { reason: "no-insert-text" }
  const position = {
    line: input.position.line,
    character: input.linePrefix.length + input.lineSuffix.length,
  }
  return { edit: zeroWidthInsertionAt(input, position, insertText) }
}

function inlineWholeLineReplacement(input: InlineCompletionEditInput): CompletionEditResult {
  const insertText = formatWholeLineReplacementText(input)
  if (!insertText.trim()) return { reason: "no-insert-text" }
  const replaceRange = {
    startLine: input.position.line,
    startCharacter: firstNonWhitespaceOrZero(input.linePrefix),
    endLine: input.position.line,
    endCharacter: input.linePrefix.length + input.lineSuffix.length,
  }
  return {
    edit: {
      insertText,
      replaceRange,
      filterText: wholeLineReplacementFilterText(insertText),
      formatRange: formatRangeAfterInsert(input.position.line, replaceRange.startCharacter, insertText),
    },
  }
}

function wholeLineReplacementFilterText(insertText: string) {
  return insertText
}

function linePrefixOverlapResult(input: CompletionEditInput): CompletionEditResult | undefined {
  const overlapText = linePrefixOverlapText(input.text, input.linePrefix)
  if (overlapText === undefined) return
  if (!overlapText.trim()) return { reason: "echoed-prefix" }

  const currentIndent = lineIndent(input.linePrefix)
  const insertText = isCommentPromptCodeCompletion({ ...input, text: overlapText })
    ? formatCompletionInsertText({
        text: overlapText,
        linePrefix: input.linePrefix,
        lineSuffix: input.lineSuffix,
        targetIndent: input.indent.targetIndent,
        indentUnit: input.indent.indentUnit,
        languageId: input.languageId,
      })
    : formatCompletionReplacementText(
        overlapText,
        currentIndent,
        input.indent.indentUnit,
        input.languageId,
      )
  if (!insertText.trim()) return { reason: "echoed-prefix" }
  return { edit: zeroWidthInsertion(input, insertText, "prefix-overlap") }
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

function currentWordLinePrefixReplacement(input: CompletionEditInput): CompletionEdit | undefined {
  if (!input.currentWord || !input.currentWordRange) return

  const beforeWord = input.linePrefix.slice(0, input.currentWordRange.startCharacter)
  if (!beforeWord || !input.text.startsWith(beforeWord)) return

  const replacementText = input.text.slice(beforeWord.length)
  if (!startsWithCurrentWord(replacementText, input.currentWord)) return

  const currentIndent = lineIndent(input.linePrefix)
  const insertText = formatCompletionReplacementText(
    replacementText,
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
  if (isCommentPromptCodeCompletion(input)) return false
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
  return zeroWidthInsertionAt(input, input.position, insertText, normalized)
}

function zeroWidthInsertionAt(
  input: CompletionEditInput,
  position: CompletionPosition,
  insertText: string,
  normalized?: "prefix-overlap",
): CompletionEdit {
  const replaceRange = zeroWidthRange(position)
  return {
    insertText,
    replaceRange,
    filterText: insertText,
    formatRange: formatRangeAfterInsert(position.line, position.character, insertText),
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

function adaptForSelectedCompletion(input: InlineCompletionEditValidationInput): InlineCompletionEditAdaptResult {
  const selected = input.selectedCompletionInfo
  if (!selected) {
    return {
      status: "ok",
      edit: input.edit,
    }
  }

  if (input.edit.replaceRange && sameCompletionRange(input.edit.replaceRange, selected.range)) {
    if (!input.edit.insertText.startsWith(selected.text)) {
      return {
        status: "rejected",
        reason: "selectedCompletionInfo-text-not-prefix",
      }
    }
    return {
      status: "ok",
      edit: withFilterText(input.edit, selected.text),
    }
  }

  if (input.plan.insertMode === "replace-whole-line" && input.edit.replaceRange && containsCompletionRange(input.edit.replaceRange, selected.range)) {
    const selectedEdit = replacementForNestedRange({
      edit: input.edit,
      editInput: input.editInput,
      targetRange: selected.range,
    })
    if (!selectedEdit) {
      return {
        status: "rejected",
        reason: "selectedCompletionInfo-range-mismatch",
      }
    }
    if (!selectedEdit.insertText.startsWith(selected.text)) {
      return {
        status: "rejected",
        reason: "selectedCompletionInfo-text-not-prefix",
      }
    }
    return {
      status: "ok",
      edit: withFilterText(selectedEdit, selected.text),
    }
  }

  return {
    status: "rejected",
    reason: "selectedCompletionInfo-range-mismatch",
  }
}

function adaptForCurrentWordReplacement(input: InlineCompletionEditValidationInput): CompletionEdit | undefined {
  const currentWord = input.editInput.currentWord
  const currentWordRange = input.editInput.currentWordRange
  if (!currentWord || !currentWordRange) return
  if (input.edit.replaceRange && sameCompletionRange(input.edit.replaceRange, currentWordRange)) {
    return startsWithCurrentWord(input.edit.insertText, currentWord)
      ? withFilterText(input.edit, input.edit.filterText ?? input.edit.insertText)
      : undefined
  }
  if (!input.edit.replaceRange || !containsCompletionRange(input.edit.replaceRange, currentWordRange)) return

  const nested = replacementForNestedRange({
    edit: input.edit,
    editInput: input.editInput,
    targetRange: currentWordRange,
  })
  if (nested && startsWithCurrentWord(nested.insertText, currentWord)) {
    return nested
  }

  if (startsWithCurrentWord(input.edit.insertText, currentWord)) {
    return {
      ...input.edit,
      replaceRange: currentWordRange,
      filterText: input.edit.filterText?.startsWith(currentWord) ? input.edit.filterText : input.edit.insertText,
      formatRange: formatRangeAfterInsert(currentWordRange.startLine, currentWordRange.startCharacter, input.edit.insertText),
    }
  }

  return
}

function adaptForWholeLineReplacement(input: InlineCompletionEditValidationInput): CompletionEdit {
  if (input.plan.insertMode !== "replace-whole-line") return input.edit
  const replaceRange = input.edit.replaceRange
  if (!replaceRange || !isExpectedWholeLineRange(input.editInput, replaceRange)) return input.edit

  const rangeText = currentLineRangeText(input.editInput, replaceRange)
  const filterText = input.edit.filterText ?? input.edit.insertText
  if (filterText.startsWith(rangeText)) return input.edit

  if (!isSafeWholeLineReplacement(input.edit, input.editInput, input.plan, replaceRange, rangeText)) {
    return input.edit
  }

  return withFilterText(input.edit, rangeText)
}

function replacementForNestedRange(input: {
  edit: CompletionEdit
  editInput: Omit<CompletionEditInput, "text">
  targetRange: CompletionRange
}): CompletionEdit | undefined {
  const sourceRange = input.edit.replaceRange
  if (!sourceRange) return
  if (!containsCompletionRange(sourceRange, input.targetRange)) return
  if (input.editInput.lineSuffix.trim()) return

  const lineText = `${input.editInput.linePrefix}${input.editInput.lineSuffix}`
  const textBeforeTarget = lineText.slice(sourceRange.startCharacter, input.targetRange.startCharacter)
  if (textBeforeTarget && input.edit.insertText.startsWith(textBeforeTarget)) {
    const insertText = input.edit.insertText.slice(textBeforeTarget.length)
    return {
      ...input.edit,
      insertText,
      replaceRange: input.targetRange,
      filterText: insertText,
      formatRange: formatRangeAfterInsert(input.targetRange.startLine, input.targetRange.startCharacter, insertText),
    }
  }

  const targetText = currentLineRangeText(input.editInput, input.targetRange)
  if (targetText && input.edit.insertText.startsWith(targetText)) {
    return {
      ...input.edit,
      replaceRange: input.targetRange,
      filterText: input.edit.insertText,
      formatRange: formatRangeAfterInsert(input.targetRange.startLine, input.targetRange.startCharacter, input.edit.insertText),
    }
  }

  return
}

function hasSafeReplacementSemantics(input: {
  edit: CompletionEdit
  editInput: Omit<CompletionEditInput, "text">
  plan: InlineCompletionEditValidationInput["plan"]
  replaceRange: CompletionRange
  rangeText: string
}) {
  if (!input.rangeText) return true
  if (input.editInput.currentWord && input.editInput.currentWordRange && sameCompletionRange(input.replaceRange, input.editInput.currentWordRange)) {
    return startsWithCurrentWord(input.edit.insertText, input.editInput.currentWord)
  }
  if (input.plan.insertMode === "replace-whole-line" && isExpectedWholeLineRange(input.editInput, input.replaceRange)) {
    return isSafeWholeLineReplacement(input.edit, input.editInput, input.plan, input.replaceRange, input.rangeText)
  }
  return input.edit.insertText.startsWith(input.rangeText)
}

function isSafeWholeLineReplacement(
  edit: CompletionEdit,
  editInput: Omit<CompletionEditInput, "text">,
  plan: InlineCompletionEditValidationInput["plan"],
  replaceRange: CompletionRange,
  rangeText: string,
) {
  if (!isExpectedWholeLineRange(editInput, replaceRange)) return false
  if (!rangeText) return true
  if (plan.kind === "natural-command") return true
  return firstCompletionLine(edit.insertText).startsWith(rangeText)
}

function isExpectedWholeLineRange(input: Omit<CompletionEditInput, "text">, range: CompletionRange) {
  if (range.startLine !== input.position.line || range.endLine !== input.position.line) return false
  return range.startCharacter === firstNonWhitespaceOrZero(input.linePrefix) &&
    range.endCharacter === input.linePrefix.length + input.lineSuffix.length
}

function containsCompletionRange(outer: CompletionRange, inner: CompletionRange) {
  if (outer.startLine !== inner.startLine || outer.endLine !== inner.endLine) return false
  return outer.startCharacter <= inner.startCharacter && outer.endCharacter >= inner.endCharacter
}

function currentLineRangeText(input: Omit<CompletionEditInput, "text">, range: CompletionRange) {
  if (range.startLine !== input.position.line || range.endLine !== input.position.line) return ""
  const lineText = `${input.linePrefix}${input.lineSuffix}`
  return lineText.slice(range.startCharacter, range.endCharacter)
}

function withFilterText(edit: CompletionEdit, filterText: string): CompletionEdit {
  return {
    ...edit,
    filterText,
  }
}

function firstCompletionLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
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

function formatAfterLineInsertText(input: CompletionEditInput) {
  const fullLine = `${input.linePrefix}${input.lineSuffix}`
  return formatCompletionBlock(input.text, lineIndent(fullLine), input.indent.indentUnit, input.languageId)
}

function formatWholeLineReplacementText(input: CompletionEditInput) {
  return formatCompletionReplacementText(
    input.text,
    lineIndent(input.linePrefix),
    input.indent.indentUnit,
    input.languageId,
  )
}

function firstNonWhitespaceOrZero(input: string) {
  const match = /\S/.exec(input)
  return match?.index ?? 0
}

function isSingleLineRange(range: CompletionRange | undefined) {
  return !range || range.startLine === range.endLine
}

function sameCompletionRange(left: CompletionRange, right: CompletionRange) {
  return left.startLine === right.startLine &&
    left.startCharacter === right.startCharacter &&
    left.endLine === right.endLine &&
    left.endCharacter === right.endCharacter
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

function linePrefixOverlapText(text: string, linePrefix: string) {
  let remaining = text
  let stripped = false
  while (true) {
    const overlap = linePrefixOverlapLength(remaining, linePrefix)
    if (overlap <= 0) break
    remaining = remaining.slice(overlap)
    stripped = true
  }
  return stripped ? remaining : undefined
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
