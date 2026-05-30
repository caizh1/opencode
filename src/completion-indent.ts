export type CompletionIndentInput = {
  lines: string[]
  line: number
  linePrefix: string
  fallbackIndentUnit: string
}

export type CompletionIndentContext = {
  indentUnit: string
  targetIndent: string
}

export function inferCompletionIndent(input: CompletionIndentInput): CompletionIndentContext {
  const currentIndent = lineIndent(input.linePrefix)
  const siblingIndent = siblingBlockBodyIndent(input.lines, input.line, currentIndent)
  if (siblingIndent !== undefined) {
    return {
      indentUnit: indentUnitFromBody(currentIndent, siblingIndent) || input.fallbackIndentUnit,
      targetIndent: siblingIndent,
    }
  }

  const indentUnit = inferIndentUnitFromLines(input.lines, input.fallbackIndentUnit)
  return {
    indentUnit,
    targetIndent: `${currentIndent}${indentUnit}`,
  }
}

function siblingBlockBodyIndent(lines: string[], activeLine: number, currentIndent: string) {
  let best: { distance: number; indent: string } | undefined

  for (let line = 0; line < lines.length; line++) {
    if (line === activeLine) continue
    const text = lines[line]
    if (lineIndent(text) !== currentIndent) continue
    if (!startsIndentedBlock(text)) continue

    const bodyIndent = nextBodyIndent(lines, line, currentIndent)
    if (bodyIndent === undefined) continue

    const distance = Math.abs(activeLine - line)
    if (!best || distance < best.distance) best = { distance, indent: bodyIndent }
  }

  return best?.indent
}

function nextBodyIndent(lines: string[], openerLine: number, openerIndent: string) {
  for (let line = openerLine + 1; line < lines.length; line++) {
    const text = lines[line]
    if (!text.trim()) continue

    const indent = lineIndent(text)
    if (!indent.startsWith(openerIndent)) return undefined
    if (indent.length <= openerIndent.length) return undefined
    return indent
  }

  return undefined
}

function inferIndentUnitFromLines(lines: string[], fallback: string) {
  let tabIndents = 0
  const spaceLengths: number[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    const indent = lineIndent(line)
    if (!indent) continue
    if (/^\t+$/.test(indent)) {
      tabIndents++
    } else if (/^ +$/.test(indent)) {
      spaceLengths.push(indent.length)
    }
  }

  if (tabIndents > 0 && tabIndents >= spaceLengths.length) return "\t"

  const width = inferredSpaceWidth(spaceLengths)
  if (width !== undefined) return " ".repeat(width)
  return fallback
}

function inferredSpaceWidth(lengths: number[]) {
  const unique = [...new Set(lengths)].sort((left, right) => left - right)
  if (unique.length === 0) return undefined

  const candidates = [...unique]
  for (let index = 1; index < unique.length; index++) {
    const diff = unique[index] - unique[index - 1]
    if (diff > 0) candidates.push(diff)
  }

  const width = candidates.reduce((value, next) => gcd(value, next))
  if (width >= 2 && width <= 8) return width

  const common = mostCommon(lengths.filter((value) => value >= 2 && value <= 8))
  return common
}

function indentUnitFromBody(baseIndent: string, bodyIndent: string) {
  if (!bodyIndent.startsWith(baseIndent)) return ""
  return bodyIndent.slice(baseIndent.length)
}

function startsIndentedBlock(linePrefix: string) {
  const trimmed = linePrefix.trimEnd()
  if (!trimmed) return false
  return /(?:[:{]|=>)$/.test(trimmed)
}

function lineIndent(line: string) {
  return line.match(/^\s*/)?.[0] ?? ""
}

function mostCommon(values: number[]) {
  let best: { value: number; count: number } | undefined
  for (const value of values) {
    const count = values.filter((item) => item === value).length
    if (!best || count > best.count) best = { value, count }
  }
  return best?.value
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b !== 0) {
    const next = a % b
    a = b
    b = next
  }
  return a
}
