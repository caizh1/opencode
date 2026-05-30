import type { CodeGraphCall, CodeGraphFile, CodeGraphFunction, CodeGraphInclude, CodeGraphMacro } from "./codegraph-types"

const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "alignof",
  "defined",
  "case",
  "do",
  "else",
])

const CALL_EXCLUDES = new Set([
  ...CONTROL_WORDS,
  "typedef",
  "struct",
  "union",
  "enum",
  "static_assert",
  "__attribute__",
  "__declspec",
])

export function parseCFile(input: {
  path: string
  text: string
  hash: string
  size: number
  indexedAt?: number
}): CodeGraphFile {
  const masked = maskCommentsAndStrings(input.text)
  const lineStarts = computeLineStarts(input.text)
  const functions = parseFunctions(input.path, input.text, masked, lineStarts)

  return {
    path: input.path,
    language: languageFromPath(input.path),
    hash: input.hash,
    size: input.size,
    indexedAt: input.indexedAt ?? Date.now(),
    includes: parseIncludes(input.text, lineStarts),
    macros: parseMacros(input.text, lineStarts),
    functions,
  }
}

export function maskCommentsAndStrings(text: string) {
  let result = ""
  let index = 0
  let state: "code" | "lineComment" | "blockComment" | "string" | "char" = "code"

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (state === "code") {
      if (char === "/" && next === "/") {
        result += "  "
        index += 2
        state = "lineComment"
        continue
      }
      if (char === "/" && next === "*") {
        result += "  "
        index += 2
        state = "blockComment"
        continue
      }
      if (char === '"') {
        result += " "
        index++
        state = "string"
        continue
      }
      if (char === "'") {
        result += " "
        index++
        state = "char"
        continue
      }
      result += char
      index++
      continue
    }

    if (state === "lineComment") {
      result += char === "\n" || char === "\r" ? char : " "
      index++
      if (char === "\n") state = "code"
      continue
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        result += "  "
        index += 2
        state = "code"
        continue
      }
      result += char === "\n" || char === "\r" ? char : " "
      index++
      continue
    }

    if (state === "string" || state === "char") {
      if (char === "\\" && next !== undefined) {
        result += " "
        result += next === "\n" || next === "\r" ? next : " "
        index += 2
        continue
      }
      const closing = state === "string" ? '"' : "'"
      result += char === "\n" || char === "\r" ? char : " "
      index++
      if (char === closing) state = "code"
    }
  }

  return result
}

function parseIncludes(text: string, lineStarts: number[]): CodeGraphInclude[] {
  const result: CodeGraphInclude[] = []
  const pattern = /^\s*#\s*include\s+([<"])([^>"]+)[>"]/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    result.push({
      target: match[2].trim(),
      system: match[1] === "<",
      line: lineForIndex(lineStarts, match.index),
    })
  }
  return result
}

function parseMacros(text: string, lineStarts: number[]): CodeGraphMacro[] {
  const result: CodeGraphMacro[] = []
  const pattern = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    result.push({
      name: match[1],
      line: lineForIndex(lineStarts, match.index),
    })
  }
  return result
}

function parseFunctions(path: string, original: string, masked: string, lineStarts: number[]): CodeGraphFunction[] {
  const result: CodeGraphFunction[] = []
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] !== "{") continue
    const candidate = functionCandidateBeforeBrace(masked, index)
    if (!candidate) continue
    const endIndex = matchingBrace(masked, index)
    if (endIndex === -1) continue
    const body = masked.slice(index + 1, endIndex)
    const startLine = lineForIndex(lineStarts, candidate.nameIndex)
    const endLine = lineForIndex(lineStarts, endIndex)
    const signature = compactWhitespace(masked.slice(candidate.signatureStart, index))
    const id = `${path}:${candidate.name}:${startLine}`
    result.push({
      id,
      path,
      name: candidate.name,
      signature,
      startLine,
      endLine,
      isStatic: /\bstatic\b/.test(signature),
      calls: parseCalls(body, index + 1, lineStarts, candidate.name),
      snippet: limitSnippet(original.slice(candidate.signatureStart, endIndex + 1)),
    })
    index = endIndex
  }
  return result
}

function functionCandidateBeforeBrace(masked: string, braceIndex: number) {
  let cursor = braceIndex - 1
  while (cursor >= 0 && /\s/.test(masked[cursor])) cursor--
  if (masked[cursor] !== ")") return undefined
  const openParen = matchingOpenParen(masked, cursor)
  if (openParen === -1) return undefined

  let nameEnd = openParen - 1
  while (nameEnd >= 0 && /\s/.test(masked[nameEnd])) nameEnd--
  let nameStart = nameEnd
  while (nameStart >= 0 && /[A-Za-z0-9_]/.test(masked[nameStart])) nameStart--
  nameStart++
  const name = masked.slice(nameStart, nameEnd + 1)
  if (!/^[A-Za-z_]\w*$/.test(name) || CONTROL_WORDS.has(name)) return undefined

  let signatureStart = nameStart
  while (signatureStart > 0) {
    const previous = masked[signatureStart - 1]
    if (previous === ";" || previous === "}" || previous === "{") break
    if (previous === "\n") {
      const lineStart = masked.lastIndexOf("\n", signatureStart - 2) + 1
      if (/^\s*#/.test(masked.slice(lineStart, signatureStart - 1))) break
    }
    signatureStart--
  }
  const prefix = masked.slice(signatureStart, nameStart)
  if (!prefix.trim()) return undefined
  if (/[=,]$/.test(prefix.trim())) return undefined
  if (/\btypedef\b/.test(prefix)) return undefined

  return { name, nameIndex: nameStart, signatureStart }
}

function parseCalls(body: string, bodyOffset: number, lineStarts: number[], currentName: string): CodeGraphCall[] {
  const calls = new Map<string, CodeGraphCall>()
  const pattern = /\b([A-Za-z_]\w*)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    const name = match[1]
    if (CALL_EXCLUDES.has(name)) continue
    const before = body.slice(Math.max(0, match.index - 24), match.index)
    if (/\b(struct|union|enum|typedef)\s+$/.test(before)) continue
    const key = `${name}:${lineForIndex(lineStarts, bodyOffset + match.index)}`
    if (!calls.has(key)) {
      calls.set(key, {
        name,
        line: lineForIndex(lineStarts, bodyOffset + match.index),
      })
    }
  }
  if (!calls.size && currentName) return []
  return [...calls.values()]
}

function matchingOpenParen(text: string, closeIndex: number) {
  let depth = 0
  for (let index = closeIndex; index >= 0; index--) {
    const char = text[index]
    if (char === ")") depth++
    else if (char === "(") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function matchingBrace(text: string, openIndex: number) {
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function computeLineStarts(text: string) {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1)
  }
  return starts
}

function lineForIndex(lineStarts: number[], index: number) {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle] <= index) low = middle + 1
    else high = middle - 1
  }
  return Math.max(1, high + 1)
}

function compactWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function limitSnippet(input: string) {
  const text = input.trim()
  if (Buffer.byteLength(text, "utf8") <= 1400) return text
  let result = ""
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (used + size > 1400) break
    result += char
    used += size
  }
  return `${result}\n/* snippet truncated */`
}

function languageFromPath(path: string) {
  const ext = path.toLowerCase().split(".").pop()
  if (ext === "c" || ext === "h") return "c"
  return "cpp"
}
