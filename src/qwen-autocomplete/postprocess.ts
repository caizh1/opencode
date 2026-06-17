import { distance } from "fastest-levenshtein"

export type QwenPostprocessInput = {
  completion: string
  model: string
  prefix: string
  suffix: string
}

// Continue parity source:
// commit eaa23c5a9de86049dff765f635c18f61d1d043bb
// core/autocomplete/postprocessing/index.ts
// core/autocomplete/filtering/streamTransforms/lineStream.ts
// core/util/lcs.ts
// core/autocomplete/CompletionProvider.ts
const MAX_REPETITION_FREQ_TO_CHECK = 3

export function postprocessQwenCompletion(input: QwenPostprocessInput): string | undefined {
  let completion = input.completion

  if (isBlank(completion)) return undefined
  if (isOnlyWhitespace(completion)) return undefined
  if (rewritesLineAbove(completion, input.prefix)) return undefined
  if (isExtremeRepetition(completion)) return undefined

  if (input.model.includes("codestral")) completion = processCodestral(completion, input)
  if (input.model.includes("qwen3")) completion = processQwen3(completion)
  if (input.model.includes("granite")) completion = processGranite(completion, input.prefix)
  if (input.model.includes("mercury")) completion = processMercury(completion, input)
  if (input.model.includes("gemini") || input.model.includes("gemma")) completion = processGemini(completion)

  if (input.prefix.endsWith(" ") && completion.startsWith(" ")) {
    completion = completion.slice(1)
  }

  return removeBackticks(completion)
}

export function firstLogLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").slice(0, 160)
}

function processCodestral(completion: string, input: QwenPostprocessInput): string {
  let text = completion
  if (text[0] === " " && text[1] !== " ") {
    if (input.prefix.endsWith(" ") && input.suffix.startsWith("\n")) {
      text = text.slice(1)
    }
  }

  if (input.suffix.length === 0 && input.prefix.endsWith("\n\n") && text.startsWith("\n")) {
    text = text.slice(1)
  }

  return text
}

function processQwen3(completion: string): string {
  return completion
    .replace(/<think>.*?<\/think>/s, "")
    .replace(/<\/think>/, "")
    .replace(/^\n+|\n+$/g, "")
}

function processGranite(completion: string, prefix: string): string {
  const end = prefix.split("\n").pop()
  if (!end) return completion
  if (completion.startsWith(end)) return completion.slice(end.length)

  const trim = end.trim()
  const word = trim.split(/\s+/).pop()
  if (word && completion.startsWith(word)) return completion.slice(word.length)
  if (completion.startsWith(trim)) return completion.slice(trim.length)
  return completion
}

function processMercury(completion: string, input: QwenPostprocessInput): string {
  if (
    (completion.startsWith(" ") || completion.startsWith("\t")) &&
    !input.prefix.endsWith("\n") &&
    (input.suffix.startsWith("\n") || input.suffix.trim().length === 0)
  ) {
    return "\n" + completion
  }

  return completion
}

function processGemini(completion: string): string {
  if (completion.endsWith("<|file_separator|>")) return completion.slice(0, -18)
  return completion
}

function rewritesLineAbove(completion: string, prefix: string): boolean {
  const line = prefix
    .split("\n")
    .filter((value) => value.trim().length > 0)
    .slice(-1)[0]
  if (!line) return false

  const first = completion.split("\n").find((value) => value.trim().length > 0)
  if (!first) return false

  return lineIsRepeated(line, first)
}

function isExtremeRepetition(completion: string): boolean {
  const lines = completion.split("\n")
  if (lines.length < 6) return false

  for (let freq = 1; freq < MAX_REPETITION_FREQ_TO_CHECK; freq++) {
    const lcs = longestCommonSubsequence(lines[0]!, lines[freq]!)
    if (lcs.length > 5 || lcs.length > lines[0]!.length * 0.5) {
      let count = 0
      for (let i = 0; i < lines.length; i += freq) {
        if (lines[i]!.includes(lcs)) {
          count++
        }
      }
      if (count * freq > 8 || (count * freq) / lines.length > 0.8) {
        return true
      }
    }
  }

  return false
}

function isOnlyWhitespace(completion: string): boolean {
  return /^[\s]+$/.test(completion)
}

function isBlank(completion: string): boolean {
  return completion.trim().length === 0
}

function removeBackticks(completion: string): string {
  const lines = completion.split("\n")

  if (lines.length === 0) {
    return completion
  }

  let start = 0
  let end = lines.length

  const first = lines[0]!.trim()
  if (first.startsWith("```")) {
    start = 1
  }

  if (lines.length > start) {
    const last = lines[lines.length - 1]!.trim()
    if (last.length > 0 && /^`+$/.test(last)) {
      end = lines.length - 1
    }
  }

  if (start > 0 || end < lines.length) {
    return lines.slice(start, end).join("\n")
  }

  return completion
}

function lineIsRepeated(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) {
    return false
  }

  const left = a.trim()
  const right = b.trim()
  return distance(left, right) / right.length < 0.1
}

function longestCommonSubsequence(a: string, b: string): string {
  const lengths: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    lengths[i] = []
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 || j === 0) {
        lengths[i]![j] = 0
      } else if (a[i - 1] === b[j - 1]) {
        lengths[i]![j] = lengths[i - 1]![j - 1]! + 1
      } else {
        lengths[i]![j] = Math.max(lengths[i - 1]![j]!, lengths[i]![j - 1]!)
      }
    }
  }

  let result = ""
  let x = a.length
  let y = b.length
  while (x !== 0 && y !== 0) {
    if (lengths[x]![y] === lengths[x - 1]![y]) {
      x--
    } else if (lengths[x]![y] === lengths[x]![y - 1]) {
      y--
    } else {
      result = a[x - 1] + result
      x--
      y--
    }
  }

  return result
}
