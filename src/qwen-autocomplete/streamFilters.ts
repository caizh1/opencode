import * as vscode from "vscode"
import { distance } from "fastest-levenshtein"
import type { QwenAutocompleteHelperVars } from "./helperVars"

export type QwenNonStreamingFilterReason =
  | "stop-token"
  | "stop-at-suffix-start"
  | "stop-at-line-below"
  | "stop-at-similar-line"
  | "stop-at-lines"
  | "stop-at-lines-exact"
  | "repeating-lines"
  | "path-line"
  | "empty-comment"
  | "skip-prefix"
  | "skip-line"
  | "english-explanation-start"
  | "english-explanation-end"
  | "markdown-fence"
  | "blank"
  | "whitespace-only"
  | "rewrites-line-above"
  | "extreme-repetition"
  | "fim-marker"
  | "qwen-model-cleanup"

export type QwenNonStreamingFilterResult = {
  text: string
  rejected: boolean
  trimmed: boolean
  reasons: QwenNonStreamingFilterReason[]
  inputChars: number
  outputChars: number
}

export type QwenStreamFilterInput = {
  completion: string
  suffix: string
  stopTokens: string[]
  helper: QwenAutocompleteHelperVars
  position: vscode.Position
  multiline: boolean
}

export const PREFIXES_TO_SKIP = ["<COMPLETION>"]

const STOP_AT_PATTERNS = ["diff --git"]
const LINES_TO_STOP_AT = ["# End of file.", "<STOP EDITING HERE", "<|/updated_code|>", "```"]
const LINES_TO_SKIP = ["</START EDITING HERE>", "<|updated_code|>"]
const BRACKET_ENDING_CHARS = [")", "]", "}", ";"]
const SEQUENCE_LENGTH = 20
const ENGLISH_START_PHRASES = [
  "here is",
  "here's",
  "sure, here",
  "sure thing",
  "sure!",
  "to fill",
  "certainly",
  "of course",
  "the code should",
]
const ENGLISH_POST_PHRASES = ["explanation:", "here is", "here's how", "the above"]

// qwen/Kilo non-streaming adapter for Continue stream transforms.
// Source: continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/filtering/streamTransforms/charStream.ts
// - core/autocomplete/filtering/streamTransforms/lineStream.ts
// - core/autocomplete/filtering/streamTransforms/StreamTransformPipeline.ts
// Continue `fullStop()` cancels a streaming generator; here it is represented
// as post-response truncation/rejection only.
export function filterQwenCompletionDetailed(input: QwenStreamFilterInput): QwenNonStreamingFilterResult {
  const ctx: FilterCtx = { reasons: [] }
  const stopped = stopAtStartOfText(
    stopAtStopTokensText(input.completion, [...input.stopTokens, ...STOP_AT_PATTERNS], ctx),
    input.suffix,
    ctx,
  )
  const below = lineBelowCursor(input.helper, input.position)
  const comment = input.helper.lang.singleLineComment
  const lines = stopped.split(/\r?\n/)
  const filtered = stopAtSimilarLine(
    filterEnglishLinesAtEnd(
      filterEnglishLinesAtStart(
        filterLeadingNewline(
          noDoubleNewLine(
            skipPrefixes(
              skipLines(
                avoidPathLine(
                  avoidEmptyComments(
                    removeTrailingWhitespace(
                      stopAtRepeatingLines(
                        stopAtLinesExact(stopAtLines(lines, ctx), below.trim() === "" ? [] : [below], ctx),
                        ctx,
                      ),
                      ctx,
                    ),
                    comment,
                    ctx,
                  ),
                  comment,
                  ctx,
                ),
                ctx,
              ),
              ctx,
            ),
            ctx,
          ),
          ctx,
        ),
        ctx,
      ),
      ctx,
    ),
    below,
    ctx,
  )
  const text = input.multiline ? filtered.join("\n") : (filtered.join("\n").split("\n", 1)[0] ?? "")
  const rejected = text.trim().length === 0 && input.completion.trim().length > 0 && ctx.reasons.length > 0
  return {
    text,
    rejected,
    trimmed: text !== input.completion,
    reasons: unique(rejected ? [...ctx.reasons, text.length === 0 ? "blank" : "whitespace-only"] : ctx.reasons),
    inputChars: input.completion.length,
    outputChars: text.length,
  }
}

export function filterQwenCompletion(input: QwenStreamFilterInput): string {
  return filterQwenCompletionDetailed(input).text
}

export function lineIsRepeated(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) {
    return false
  }

  const left = a.trim()
  const right = b.trim()
  return distance(left, right) / right.length < 0.1
}

type FilterCtx = {
  reasons: QwenNonStreamingFilterReason[]
}

function add(ctx: FilterCtx, reason: QwenNonStreamingFilterReason): void {
  ctx.reasons.push(reason)
}

function unique(reasons: QwenNonStreamingFilterReason[]): QwenNonStreamingFilterReason[] {
  return [...new Set(reasons)]
}

function stopAtStopTokensText(text: string, tokens: string[], ctx: FilterCtx): string {
  const hits = tokens.map((token) => ({ token, index: text.indexOf(token) })).filter((item) => item.index >= 0)
  if (hits.length === 0) return text
  const hit = hits.sort((a, b) => a.index - b.index)[0]!
  add(ctx, hit.token.startsWith("<|fim_") ? "fim-marker" : "stop-token")
  return text.slice(0, hit.index)
}

function stopAtStartOfText(text: string, suffix: string, ctx: FilterCtx): string {
  if (suffix.length < SEQUENCE_LENGTH) return text

  const target = suffix.trimStart().slice(0, Math.floor(SEQUENCE_LENGTH * 1.5))
  let buffer = ""
  let output = ""

  for (const char of text) {
    buffer += char

    if (buffer.length >= SEQUENCE_LENGTH && target.includes(buffer)) {
      add(ctx, "stop-at-suffix-start")
      return output
    }

    while (buffer.length > SEQUENCE_LENGTH) {
      output += buffer[0]
      buffer = buffer.slice(1)
    }
  }

  return output + buffer
}

function stopAtLines(lines: string[], ctx: FilterCtx): string[] {
  const output: string[] = []
  for (const [index, line] of lines.entries()) {
    const stop = shouldStopAtLine(line, index)
    if (stop) {
      add(ctx, stop)
      break
    }
    output.push(line)
  }
  return output
}

function shouldStopAtLine(line: string, index: number): QwenNonStreamingFilterReason | null {
  for (const stop of LINES_TO_STOP_AT) {
    if (!line.includes(stop)) continue

    const valid = validatePatternInLine(line, stop)
    if (!valid.isValid) continue

    const trimmed = line.trimStart()
    if (stop === "```" && index === 0 && trimmed.startsWith("```")) return null
    const reason = stop === "```" ? "markdown-fence" : "stop-at-lines"
    if (trimmed.startsWith(stop)) return reason

    const before = valid.beforePattern.trimEnd()
    if (before.length < valid.beforePattern.length) return reason
  }

  return null
}

function validatePatternInLine(line: string, pattern: string): { isValid: boolean; beforePattern: string } {
  const index = line.indexOf(pattern)
  if (index === -1) return { isValid: false, beforePattern: "" }

  if (index > 0) {
    const char = line[index - 1]
    if (char && !char.match(/\s/)) return { isValid: false, beforePattern: "" }
  }

  const before = line.substring(0, index)
  const single = (before.match(/'/g) || []).length
  const double = (before.match(/"/g) || []).length
  if (single % 2 !== 0 || double % 2 !== 0) return { isValid: false, beforePattern: before }

  return { isValid: true, beforePattern: before }
}

function stopAtLinesExact(lines: string[], stops: string[], ctx: FilterCtx): string[] {
  if (stops.length === 0) return lines
  const output: string[] = []
  for (const line of lines) {
    if (stops.some((stop) => line === stop)) {
      add(ctx, "stop-at-line-below")
      add(ctx, "stop-at-lines-exact")
      break
    }
    output.push(line)
  }
  return output
}

function stopAtRepeatingLines(lines: string[], ctx: FilterCtx): string[] {
  let previous: string | undefined
  let repeats = 0
  const output: string[] = []

  for (const line of lines) {
    if (line === previous) {
      repeats++
      if (repeats === 3) {
        add(ctx, "repeating-lines")
        return output
      }
    } else {
      output.push(line)
      repeats = 1
    }
    previous = line
  }

  return output
}

function removeTrailingWhitespace(lines: string[], ctx: FilterCtx): string[] {
  return lines.map((line) => {
    const trimmed = line.trimEnd()
    if (trimmed.length !== line.length) add(ctx, "skip-line")
    return trimmed
  })
}

function avoidEmptyComments(lines: string[], comment: string | undefined, ctx: FilterCtx): string[] {
  if (!comment) return lines
  return lines.filter((line) => {
    const keep = line.trim() !== comment
    if (!keep) add(ctx, "empty-comment")
    return keep
  })
}

function avoidPathLine(lines: string[], comment: string | undefined, ctx: FilterCtx): string[] {
  if (!comment) return lines
  return lines.filter((line) => {
    const keep = !line.startsWith(`${comment} Path: `)
    if (!keep) add(ctx, "path-line")
    return keep
  })
}

function skipLines(lines: string[], ctx: FilterCtx): string[] {
  return lines.filter((line) => {
    const keep = !LINES_TO_SKIP.some((skip) => line.startsWith(skip))
    if (!keep) add(ctx, "skip-line")
    return keep
  })
}

function skipPrefixes(lines: string[], ctx: FilterCtx): string[] {
  const output: string[] = []
  let first = true

  for (const line of lines) {
    if (first) {
      const match = PREFIXES_TO_SKIP.find((prefix) => line.startsWith(prefix))
      if (match) {
        add(ctx, "skip-prefix")
        output.push(line.slice(match.length))
        continue
      }
      first = false
    }
    output.push(line)
  }

  return output
}

function noDoubleNewLine(lines: string[], ctx: FilterCtx): string[] {
  const output: string[] = []
  let first = true

  for (const line of lines) {
    if (line.trim() === "" && !first) {
      add(ctx, "stop-at-lines")
      return output
    }
    first = false
    output.push(line)
  }

  return output
}

function filterLeadingNewline(lines: string[], ctx: FilterCtx): string[] {
  if (lines.length === 0) return lines
  if (lines[0]!.trim() !== "") return lines
  add(ctx, "skip-line")
  return lines.slice(1)
}

function filterEnglishLinesAtStart(lines: string[], ctx: FilterCtx): string[] {
  const output: string[] = []
  let index = 0
  let english = false
  for (const line of lines) {
    if (index === 0 && line.trim() === "") {
      index++
      continue
    }
    if (index === 0 && isEnglishFirstLine(line)) {
      english = true
      index++
      add(ctx, "english-explanation-start")
      continue
    }
    if (index === 1 && english && line.trim() === "") {
      index++
      continue
    }
    index++
    output.push(line)
  }
  return output
}

function filterEnglishLinesAtEnd(lines: string[], ctx: FilterCtx): string[] {
  const output: string[] = []
  let done = false
  for (const line of lines) {
    if (line.trim() === "```") done = true
    if (done && isEnglishPostExplanation(line)) {
      add(ctx, "english-explanation-end")
      break
    }
    output.push(line)
  }
  return output
}

function isEnglishFirstLine(line: string): boolean {
  const text = line.trim().toLowerCase()
  return ENGLISH_START_PHRASES.some((phrase) => text.startsWith(phrase))
}

function isEnglishPostExplanation(line: string): boolean {
  const text = line.trim().toLowerCase()
  return ENGLISH_POST_PHRASES.some((phrase) => text.startsWith(phrase))
}

function stopAtSimilarLine(lines: string[], line: string, ctx: FilterCtx): string[] {
  const trimmed = line.trim()
  const bracket = isBracketEnding(trimmed)
  const output: string[] = []

  for (const next of lines) {
    if (trimmed === "") {
      output.push(next)
      continue
    }

    if (bracket && trimmed.trim() === next.trim()) {
      output.push(next)
      continue
    }

    if (next === line) {
      add(ctx, "stop-at-similar-line")
      break
    }
    if (lineIsRepeated(next, trimmed)) {
      add(ctx, "stop-at-similar-line")
      break
    }

    output.push(next)
  }

  return output
}

function isBracketEnding(line: string): boolean {
  return line
    .trim()
    .split("")
    .some((char) => BRACKET_ENDING_CHARS.includes(char))
}

function lineBelowCursor(helper: QwenAutocompleteHelperVars, position: vscode.Position): string {
  let line = ""
  let offset = 1
  while (line.trim() === "" && position.line + offset <= helper.fileLines.length - 1) {
    line = helper.fileLines[Math.min(position.line + offset, helper.fileLines.length - 1)] ?? ""
    offset++
  }
  return line
}
