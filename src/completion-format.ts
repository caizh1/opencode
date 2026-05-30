export type CompletionFormatInput = {
  text: string
  linePrefix: string
  lineSuffix?: string
  targetIndent: string
  indentUnit: string
  languageId?: string
}

export function formatCompletionInsertText(input: CompletionFormatInput): string {
  if (!input.text) return ""
  if (input.lineSuffix?.trim()) return input.text
  if (isIndentedBlankLine(input.linePrefix) && hasLineBreak(input.text)) {
    return formatCompletionReplacementText(input.text, input.linePrefix, input.indentUnit, input.languageId)
  }
  if (!startsIndentedBlock(input.linePrefix)) return input.text

  return formatCompletionBlock(input.text, input.targetIndent, input.indentUnit, input.languageId)
}

export function formatCompletionBlock(text: string, targetIndent: string, indentUnit: string, languageId?: string) {
  const profile = languageProfile(languageId)
  const lines = normalizeLines(text)
  const structured = profile.braceBlocks ? braceSingleLineControls(lines) : lines
  const normalized = reindentLines(structured, targetIndent, targetIndent, indentUnit, profile)

  return `\n${normalized.join("\n")}`
}

export function formatCompletionReplacementText(text: string, currentLineIndent: string, indentUnit: string, languageId?: string) {
  const profile = languageProfile(languageId)
  const lines = normalizeLines(text)
  const structured = profile.braceBlocks ? braceSingleLineControls(lines) : lines
  return reindentLines(structured, "", currentLineIndent, indentUnit, profile).join("\n")
}

function startsIndentedBlock(linePrefix: string) {
  const trimmed = linePrefix.trimEnd()
  if (!trimmed) return false
  return /(?:[:{]|=>)$/.test(trimmed)
}

function isIndentedBlankLine(linePrefix: string) {
  return linePrefix.length > 0 && !linePrefix.trim()
}

function hasLineBreak(text: string) {
  return /\r?\n/.test(text)
}

function normalizeLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").replace(/^\n+/, "").split("\n")
  const commonIndent = commonLeadingWhitespace(lines.filter((line) => line.trim()).map(lineIndent))
  return lines.map((line) => stripPrefix(line, commonIndent))
}

function reindentLines(
  lines: string[],
  firstLineIndent: string,
  continuationIndent: string,
  indentUnit: string,
  profile: LanguageProfile,
) {
  let level = 0
  let preprocessorLevel = 0
  const formatted: string[] = []

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed) {
      formatted.push("")
      continue
    }

    if (profile.braceBlocks && startsClosingBrace(trimmed)) level = Math.max(0, level - 1)
    const directive = profile.preprocessorDirectives ? preprocessorDirective(trimmed) : undefined
    if (directive?.kind === "close") preprocessorLevel = Math.max(0, preprocessorLevel - 1)

    const baseIndent = index === 0 ? firstLineIndent : continuationIndent
    const directiveAdjustment = directive?.kind === "branch" ? -1 : 0
    const directiveLevel = Math.max(0, preprocessorLevel + directiveAdjustment)
    const lineLevel = level + (directive ? directiveLevel : preprocessorLevel)
    formatted.push(`${baseIndent}${indentUnit.repeat(lineLevel)}${trimmed}`)

    if (directive?.kind === "open") preprocessorLevel++
    if (opensBlock(trimmed, profile)) level++
  }

  return formatted
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function commonLeadingWhitespace(indents: string[]) {
  if (indents.length === 0) return ""
  let common = indents[0]
  for (const indent of indents.slice(1)) {
    while (common && !indent.startsWith(common)) common = common.slice(0, -1)
  }
  return common
}

function stripPrefix(input: string, prefix: string) {
  if (!prefix) return input
  return input.startsWith(prefix) ? input.slice(prefix.length) : input
}

type LanguageProfile = {
  braceBlocks: boolean
  colonBlocks: boolean
  preprocessorDirectives: boolean
}

function languageProfile(languageId: string | undefined): LanguageProfile {
  switch (languageId) {
    case "python":
      return { braceBlocks: false, colonBlocks: true, preprocessorDirectives: false }
    case "c":
    case "cpp":
      return { braceBlocks: true, colonBlocks: false, preprocessorDirectives: true }
    case "csharp":
    case "go":
    case "java":
    case "javascript":
    case "javascriptreact":
    case "rust":
    case "typescript":
    case "typescriptreact":
      return { braceBlocks: true, colonBlocks: false, preprocessorDirectives: false }
    default:
      return { braceBlocks: true, colonBlocks: true, preprocessorDirectives: false }
  }
}

function braceSingleLineControls(lines: string[]) {
  const result: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    const next = lines[index + 1]
    if (isBraceControlWithoutBody(trimmed) && next !== undefined && next.trim()) {
      result.push(`${trimmed} {`)
      result.push(next)
      result.push("}")
      index++
      continue
    }
    result.push(line)
  }
  return result
}

function isBraceControlWithoutBody(trimmed: string) {
  if (/[{;]$/.test(trimmed)) return false
  return /^(if|else\s+if|for|while)\b.*\)?$/.test(trimmed)
}

function opensBlock(trimmed: string, profile: LanguageProfile) {
  if (profile.braceBlocks && /[{([]\s*$/.test(trimmed)) return true
  if (profile.colonBlocks && /:\s*$/.test(trimmed)) return true
  return false
}

function startsClosingBrace(trimmed: string) {
  return /^[}\])]/.test(trimmed)
}

function preprocessorDirective(trimmed: string): { kind: "open" | "branch" | "close" } | undefined {
  const match = /^#\s*(if|ifdef|ifndef|elif|else|endif)\b/.exec(trimmed)
  if (!match) return

  switch (match[1]) {
    case "if":
    case "ifdef":
    case "ifndef":
      return { kind: "open" }
    case "elif":
    case "else":
      return { kind: "branch" }
    case "endif":
      return { kind: "close" }
  }
}
