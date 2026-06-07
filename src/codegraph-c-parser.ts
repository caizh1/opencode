import type {
  CodeGraphCall,
  CodeGraphCallSite,
  CodeGraphErrorLabel,
  CodeGraphFile,
  CodeGraphFileToken,
  CodeGraphFunction,
  CodeGraphGlobalSymbol,
  CodeGraphInclude,
  CodeGraphInitializerExample,
  CodeGraphMacro,
  CodeGraphRegisterMacroFamily,
  CodeGraphTypeField,
  CodeGraphTypeSymbol,
} from "./codegraph-types"

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
  const macros = parseMacros(input.text, lineStarts)
  const types = parseTypes(input.text, masked, lineStarts)
  const globals = parseGlobals(input.text, masked, lineStarts, functions, types)
  const callSites = parseCallSites(functions)
  const initializers = parseInitializerExamples(input.text, masked, lineStarts)
  const errorLabels = parseErrorLabels(input.text, functions)
  const registerMacroFamilies = parseRegisterMacroFamilies(input.path, macros)

  return {
    path: input.path,
    language: languageFromPath(input.path),
    hash: input.hash,
    size: input.size,
    indexedAt: input.indexedAt ?? Date.now(),
    includes: parseIncludes(input.text, lineStarts),
    macros,
    functions,
    types,
    globals,
    callSites,
    initializers,
    errorLabels,
    registerMacroFamilies,
    tokens: parseFileTokens(input.path, input.text, masked, lineStarts, functions, macros, types, globals, initializers, errorLabels, registerMacroFamilies),
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
      snippet: lineSnippet(text, lineStarts, lineForIndex(lineStarts, match.index)),
    })
  }
  return result
}

function parseTypes(original: string, masked: string, lineStarts: number[]): CodeGraphTypeSymbol[] {
  const result = new Map<string, CodeGraphTypeSymbol>()
  const tagPattern = /\b(struct|union|enum)\s+([A-Za-z_]\w*)\b[^;{]*\{/g
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagPattern.exec(masked))) {
    const braceIndex = masked.indexOf("{", tagMatch.index)
    const endIndex = braceIndex === -1 ? -1 : matchingBrace(masked, braceIndex)
    if (endIndex === -1) continue
    const startLine = lineForIndex(lineStarts, tagMatch.index)
    const endLine = lineForIndex(lineStarts, endIndex)
    const symbol: CodeGraphTypeSymbol = {
      name: tagMatch[2],
      kind: tagMatch[1] as "struct" | "union" | "enum",
      startLine,
      endLine,
      snippet: limitSnippet(original.slice(tagMatch.index, endIndex + 1)),
      fields: tagMatch[1] === "enum" ? [] : parseTypeFields(original, masked, braceIndex + 1, endIndex, lineStarts),
    }
    result.set(`${symbol.kind}:${symbol.name}:${startLine}`, symbol)
    tagPattern.lastIndex = endIndex + 1
  }

  const aggregateTypedefPattern = /\btypedef\s+(struct|union)\b[^;{]*\{/g
  let aggregateTypedefMatch: RegExpExecArray | null
  while ((aggregateTypedefMatch = aggregateTypedefPattern.exec(masked))) {
    const braceIndex = masked.indexOf("{", aggregateTypedefMatch.index)
    const endIndex = braceIndex === -1 ? -1 : matchingBrace(masked, braceIndex)
    const semicolon = endIndex === -1 ? -1 : masked.indexOf(";", endIndex)
    if (endIndex === -1 || semicolon === -1) continue
    const alias = masked.slice(endIndex + 1, semicolon).match(/\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/)?.[1]
    if (!alias || CONTROL_WORDS.has(alias)) continue
    const startLine = lineForIndex(lineStarts, aggregateTypedefMatch.index)
    const endLine = lineForIndex(lineStarts, semicolon)
    const symbol: CodeGraphTypeSymbol = {
      name: alias,
      kind: "typedef",
      startLine,
      endLine,
      snippet: limitSnippet(original.slice(aggregateTypedefMatch.index, semicolon + 1)),
      fields: parseTypeFields(original, masked, braceIndex + 1, endIndex, lineStarts),
    }
    result.set(`typedef:${symbol.name}:${startLine}`, symbol)
    aggregateTypedefPattern.lastIndex = semicolon + 1
  }

  const typedefPattern = /\btypedef\b[\s\S]*?;/g
  let typedefMatch: RegExpExecArray | null
  while ((typedefMatch = typedefPattern.exec(masked))) {
    const statement = typedefMatch[0]
    const aggregateTypedef = /\btypedef\s+(?:struct|union|enum)\b[\s\S]*\{/.test(statement)
    if (statement.includes("(") && !aggregateTypedef) continue
    const alias = statement.match(/\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;$/)?.[1]
    if (!alias || CONTROL_WORDS.has(alias)) continue
    const startLine = lineForIndex(lineStarts, typedefMatch.index)
    const endLine = lineForIndex(lineStarts, typedefMatch.index + statement.length)
    const symbol: CodeGraphTypeSymbol = {
      name: alias,
      kind: "typedef",
      startLine,
      endLine,
      snippet: limitSnippet(original.slice(typedefMatch.index, typedefMatch.index + statement.length)),
      fields: parseTypedefFields(original, masked, typedefMatch.index, statement, lineStarts),
    }
    result.set(`typedef:${symbol.name}:${startLine}`, symbol)
  }

  return [...result.values()].sort((left, right) => left.startLine - right.startLine || left.name.localeCompare(right.name))
}

function parseGlobals(
  original: string,
  masked: string,
  lineStarts: number[],
  functions: CodeGraphFunction[],
  types: CodeGraphTypeSymbol[],
): CodeGraphGlobalSymbol[] {
  const functionRanges = functions.map((fn) => ({ start: fn.startLine, end: fn.endLine }))
  const typeRanges = types.map((type) => ({ start: type.startLine, end: type.endLine }))
  const result: CodeGraphGlobalSymbol[] = []
  const lines = masked.split(/\r?\n/)
  let offset = 0
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    const line = lines[index]
    const trimmed = line.trim()
    const lineOffset = offset
    offset += line.length + 1

    if (!trimmed || !trimmed.endsWith(";")) continue
    if (functionRanges.some((range) => lineNumber >= range.start && lineNumber <= range.end)) continue
    if (typeRanges.some((range) => lineNumber >= range.start && lineNumber <= range.end)) continue
    if (/^#/.test(trimmed)) continue
    if (/\b(typedef|struct|union|enum|return|if|for|while|switch)\b/.test(trimmed)) continue
    if (trimmed.includes("(")) continue
    if (!/\b(static|extern|const|volatile|unsigned|signed|long|short|int|char|bool|float|double|size_t|uint\d+_t|int\d+_t|[A-Za-z_]\w*)\b/.test(trimmed)) continue

    const withoutInit = trimmed.replace(/=.*/, "").replace(/;.*/, "").trim()
    const name = withoutInit.match(/\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/)?.[1]
    if (!name || CONTROL_WORDS.has(name)) continue
    result.push({
      name,
      line: lineNumber,
      snippet: lineSnippet(original, lineStarts, lineForIndex(lineStarts, lineOffset)),
    })
  }
  return result
}

function parseTypeFields(
  original: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  lineStarts: number[],
): CodeGraphTypeField[] {
  const fields: CodeGraphTypeField[] = []
  const body = masked.slice(bodyStart, bodyEnd)
  const statements = body.matchAll(/([^;{}]+);/g)
  for (const match of statements) {
    const raw = match[1].trim()
    if (!raw) continue
    const fnPointer = /^(.+?)\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\((.*?)\)\s*$/.exec(raw.replace(/\s+/g, " ").trim())
    if (fnPointer?.[2]) {
      const line = lineForIndex(lineStarts, bodyStart + match.index)
      fields.push({
        name: fnPointer[2],
        type: compactWhitespace(`${fnPointer[1]} (*)(${fnPointer[3]})`),
        line,
        snippet: lineSnippet(original, lineStarts, line),
      })
      continue
    }
    if (raw.includes("(")) continue
    const cleaned = raw
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s*:\s*\d+\s*$/, "")
      .replace(/\s+/g, " ")
      .trim()
    const fieldMatch = /^(.+?)\s+(\**\s*)?([A-Za-z_]\w*)$/.exec(cleaned)
    if (!fieldMatch) continue
    const name = fieldMatch[3]
    if (!name || CONTROL_WORDS.has(name)) continue
    const type = compactWhitespace(`${fieldMatch[1]} ${fieldMatch[2] ?? ""}`)
    const line = lineForIndex(lineStarts, bodyStart + match.index)
    fields.push({
      name,
      type,
      line,
      snippet: lineSnippet(original, lineStarts, line),
    })
  }
  return fields
}

function parseTypedefFields(
  original: string,
  masked: string,
  statementStart: number,
  statement: string,
  lineStarts: number[],
) {
  if (!/\btypedef\s+(?:struct|union)\b/.test(statement)) return []
  const braceIndex = masked.indexOf("{", statementStart)
  const statementEnd = statementStart + statement.length
  if (braceIndex < statementStart || braceIndex >= statementEnd) return []
  const endIndex = matchingBrace(masked, braceIndex)
  if (endIndex === -1 || endIndex > statementEnd) return []
  return parseTypeFields(original, masked, braceIndex + 1, endIndex, lineStarts)
}

function parseFileTokens(
  path: string,
  original: string,
  masked: string,
  lineStarts: number[],
  functions: CodeGraphFunction[],
  macros: CodeGraphMacro[],
  types: CodeGraphTypeSymbol[],
  globals: CodeGraphGlobalSymbol[],
  initializers: CodeGraphInitializerExample[],
  errorLabels: CodeGraphErrorLabel[],
  registerMacroFamilies: CodeGraphRegisterMacroFamily[],
): CodeGraphFileToken[] {
  const collector = new TokenCollector()
  for (const part of path.split(/[\\/._-]+/)) {
    for (const term of tokenizeIdentifier(part)) collector.add(term, "path", 1)
  }
  for (const fn of functions) {
    for (const term of tokenizeIdentifier(fn.name)) collector.add(term, "identifier", fn.startLine)
  }
  for (const macro of macros) {
    for (const term of tokenizeIdentifier(macro.name)) collector.add(term, "macro", macro.line)
  }
  for (const type of types) {
    for (const term of tokenizeIdentifier(type.name)) collector.add(term, "type", type.startLine)
    for (const field of type.fields ?? []) {
      for (const term of tokenizeIdentifier(field.name)) collector.add(term, "type", field.line)
      for (const term of tokenizeIdentifier(field.type)) collector.add(term, "type", field.line)
    }
  }
  for (const global of globals) {
    for (const term of tokenizeIdentifier(global.name)) collector.add(term, "global", global.line)
  }
  for (const initializer of initializers) {
    if (initializer.typeName) {
      for (const term of tokenizeIdentifier(initializer.typeName)) collector.add(term, "type", initializer.line)
    }
    for (const field of initializer.fields) {
      for (const term of tokenizeIdentifier(field)) collector.add(term, "type", initializer.line)
    }
  }
  for (const label of errorLabels) {
    for (const term of tokenizeIdentifier(label.name)) collector.add(term, "identifier", label.line)
    for (const call of label.cleanupCalls) {
      for (const term of tokenizeIdentifier(call)) collector.add(term, "identifier", label.line)
    }
  }
  for (const family of registerMacroFamilies) {
    for (const term of tokenizeIdentifier(family.family)) collector.add(term, "macro", family.line)
    for (const macro of family.macros) {
      for (const term of tokenizeIdentifier(macro.name)) collector.add(term, "macro", macro.line)
      for (const term of tokenizeIdentifier(macro.suffix)) collector.add(term, "macro", macro.line)
    }
  }
  collectCommentTokens(original, lineStarts, collector)
  collectIdentifierTokens(masked, lineStarts, collector)
  return collector.values()
}

function collectCommentTokens(text: string, lineStarts: number[], collector: TokenCollector) {
  const pattern = /\/\/([^\r\n]*)|\/\*([\s\S]*?)\*\//g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const body = match[1] ?? match[2] ?? ""
    const line = lineForIndex(lineStarts, match.index)
    for (const term of tokenizeText(body)) collector.add(term, "comment", line)
  }
}

function collectIdentifierTokens(masked: string, lineStarts: number[], collector: TokenCollector) {
  const pattern = /\b[A-Za-z_]\w{1,}\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(masked))) {
    const word = match[0]
    if (CALL_EXCLUDES.has(word) || CONTROL_WORDS.has(word)) continue
    const line = lineForIndex(lineStarts, match.index)
    for (const term of tokenizeIdentifier(word)) collector.add(term, "identifier", line)
  }
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
      calls: parseCalls(body, original, index + 1, lineStarts, candidate.name),
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

function parseCalls(body: string, original: string, bodyOffset: number, lineStarts: number[], currentName: string): CodeGraphCall[] {
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
      const openIndex = body.indexOf("(", match.index + name.length)
      const closeIndex = openIndex === -1 ? -1 : matchingCloseParen(body, openIndex)
      const line = lineForIndex(lineStarts, bodyOffset + match.index)
      const snippet = lineSnippet(original, lineStarts, line)
      calls.set(key, {
        name,
        line,
        args: closeIndex === -1 ? [] : splitCallArgs(original.slice(bodyOffset + openIndex + 1, bodyOffset + closeIndex)),
        snippet,
        returnHandling: callReturnHandling(snippet, name),
      })
    }
  }
  if (!calls.size && currentName) return []
  return [...calls.values()]
}

function parseCallSites(functions: CodeGraphFunction[]): CodeGraphCallSite[] {
  return functions.flatMap((fn) =>
    fn.calls
      .filter((call) => call.snippet)
      .map((call) => ({
        callee: call.name,
        caller: fn.name,
        callerId: fn.id,
        line: call.line,
        args: call.args ?? [],
        snippet: call.snippet ?? "",
        returnHandling: call.returnHandling,
      })))
}

function parseInitializerExamples(original: string, masked: string, lineStarts: number[]): CodeGraphInitializerExample[] {
  const result: CodeGraphInitializerExample[] = []
  const pattern = /=\s*\{/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(masked))) {
    const braceIndex = masked.indexOf("{", match.index)
    const endIndex = braceIndex === -1 ? -1 : matchingBrace(masked, braceIndex)
    if (endIndex === -1) continue
    const statementStart = initializerStatementStart(masked, match.index)
    const semicolon = masked.indexOf(";", endIndex)
    if (semicolon === -1) continue
    const fields = uniqueStrings([...original.slice(braceIndex, endIndex).matchAll(/\.([A-Za-z_]\w*)\s*=/g)].map((field) => field[1]))
    if (fields.length === 0) continue
    const line = lineForIndex(lineStarts, statementStart)
    result.push({
      typeName: initializerTypeName(masked.slice(statementStart, match.index)),
      line,
      endLine: lineForIndex(lineStarts, semicolon),
      fields,
      snippet: limitSnippet(original.slice(statementStart, semicolon + 1)),
    })
    pattern.lastIndex = endIndex + 1
  }
  return result
}

function parseErrorLabels(original: string, functions: CodeGraphFunction[]): CodeGraphErrorLabel[] {
  const lines = original.replace(/\r\n/g, "\n").split("\n")
  const result: CodeGraphErrorLabel[] = []
  for (const fn of functions) {
    for (let index = fn.startLine - 1; index < Math.min(lines.length, fn.endLine); index++) {
      const match = /^\s*([A-Za-z_]\w*)\s*:\s*(?:\/\/.*)?$/.exec(lines[index] ?? "")
      if (!match || /^(?:case|default)$/.test(match[1])) continue
      const snippetLines = cleanupLabelSnippetLines(lines, index, fn.endLine)
      const snippet = snippetLines.join("\n").trim()
      result.push({
        name: match[1],
        functionName: fn.name,
        functionId: fn.id,
        line: index + 1,
        snippet,
        cleanupCalls: cleanupCallsFromSnippet(snippet),
        returnStyle: snippet.split(/\r?\n/).map((line) => line.trim()).find((line) => /^return\b.*;\s*$/.test(line)),
      })
    }
  }
  return result
}

function parseRegisterMacroFamilies(path: string, macros: CodeGraphMacro[]): CodeGraphRegisterMacroFamily[] {
  const groups = new Map<string, CodeGraphRegisterMacroFamily["macros"]>()
  for (const macro of macros) {
    const parsed = registerMacroFamily(macro.name)
    if (!parsed) continue
    const group = groups.get(parsed.family) ?? []
    group.push({
      name: macro.name,
      line: macro.line,
      suffix: parsed.suffix,
      snippet: macro.snippet ?? "",
    })
    groups.set(parsed.family, group)
  }

  return [...groups.entries()]
    .filter(([, macros]) => macros.length >= 2)
    .map(([family, macros]) => ({
      family,
      path,
      line: Math.min(...macros.map((macro) => macro.line)),
      macros: macros.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name)),
      snippet: limitSnippet(macros.map((macro) => macro.snippet).filter(Boolean).join("\n")),
    }))
    .sort((left, right) => left.line - right.line || left.family.localeCompare(right.family))
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

function matchingCloseParen(text: string, openIndex: number) {
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index]
    if (char === "(") depth++
    else if (char === ")") {
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

function splitCallArgs(input: string) {
  const result: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1)
    else if (char === "," && depth === 0) {
      result.push(compactWhitespace(input.slice(start, index)))
      start = index + 1
    }
  }
  const tail = compactWhitespace(input.slice(start))
  if (tail) result.push(tail)
  return result.filter(Boolean).slice(0, 12)
}

function initializerStatementStart(masked: string, index: number) {
  let cursor = index - 1
  while (cursor > 0) {
    const char = masked[cursor]
    if (char === ";" || char === "{" || char === "}") return cursor + 1
    cursor--
  }
  return 0
}

function initializerTypeName(prefix: string) {
  const compact = prefix
    .replace(/\b(?:static|const|volatile|extern|register|struct|union)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const parts = compact.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return undefined
  return parts[parts.length - 2]?.replace(/^\*+/, "")
}

function cleanupLabelSnippetLines(lines: string[], labelIndex: number, functionEndLine: number) {
  const result: string[] = []
  for (let index = labelIndex; index < Math.min(lines.length, functionEndLine, labelIndex + 10); index++) {
    if (index > labelIndex && /^\s*[A-Za-z_]\w*\s*:\s*(?:\/\/.*)?$/.test(lines[index] ?? "")) break
    result.push(lines[index] ?? "")
    if (index > labelIndex && /^\s*return\b.*;\s*$/.test(lines[index] ?? "")) break
  }
  return result
}

function cleanupCallsFromSnippet(snippet: string) {
  const calls: string[] = []
  const pattern = /\b([A-Za-z_]\w*)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(snippet))) {
    const name = match[1]
    if (CALL_EXCLUDES.has(name)) continue
    calls.push(name)
  }
  return uniqueStrings(calls).slice(0, 12)
}

function registerMacroFamily(name: string) {
  const parts = name.split("_").filter(Boolean)
  if (parts.length < 2) return undefined
  const last = parts.at(-1)
  const previous = parts.at(-2)
  if (!last) return undefined
  if (/^(?:MASK|SHIFT|BIT|BITS)$/.test(last) && previous && parts.length >= 3) {
    return {
      family: parts.slice(0, -2).join("_"),
      suffix: `${previous}_${last}`,
    }
  }
  if (/^(?:BASE|ADDR|REG|CTRL|CFG|STATUS|ENABLE|DISABLE|MASK|SHIFT|BIT|BITS|VALUE|VAL)$/.test(last)) {
    return {
      family: parts.slice(0, -1).join("_"),
      suffix: last,
    }
  }
  return undefined
}

function callReturnHandling(snippet: string, callee: string) {
  const escaped = escapeRegExp(callee)
  if (new RegExp(`\\breturn\\s+${escaped}\\s*\\(`).test(snippet)) return "return"
  const assignment = new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*${escaped}\\s*\\(`).exec(snippet)
  if (assignment?.[1]) return `assignment:${assignment[1]}`
  if (new RegExp(`\\bif\\s*\\(\\s*${escaped}\\s*\\(`).test(snippet)) return "condition"
  return undefined
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

function lineSnippet(text: string, lineStarts: number[], line: number) {
  const start = lineStarts[Math.max(0, line - 1)] ?? 0
  const end = lineStarts[line] ?? text.length
  return text.slice(start, end).trim()
}

function tokenizeText(input: string) {
  return uniqueStrings(input.split(/[^A-Za-z0-9_]+/).flatMap(tokenizeIdentifier))
}

function tokenizeIdentifier(input: string) {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+|_+/)
    .filter(Boolean)
  const terms = [input, ...normalized]
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 2 && !CONTROL_WORDS.has(term))
  return uniqueStrings(terms)
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

class TokenCollector {
  private readonly tokens = new Map<string, CodeGraphFileToken>()
  private readonly limits: Record<CodeGraphFileToken["kind"], number> = {
    path: 120,
    identifier: 2000,
    comment: 600,
    macro: 400,
    type: 400,
    global: 400,
  }
  private readonly counts: Record<CodeGraphFileToken["kind"], number> = {
    path: 0,
    identifier: 0,
    comment: 0,
    macro: 0,
    type: 0,
    global: 0,
  }

  add(term: string, kind: CodeGraphFileToken["kind"], line: number) {
    if (!term) return
    const key = `${kind}:${term}`
    if (this.tokens.has(key)) return
    if (this.counts[kind] >= this.limits[kind]) return
    this.tokens.set(key, { term, kind, line })
    this.counts[kind]++
  }

  values() {
    return [...this.tokens.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.term.localeCompare(right.term))
  }
}

function languageFromPath(path: string) {
  const ext = path.toLowerCase().split(".").pop()
  if (ext === "c" || ext === "h") return "c"
  return "cpp"
}
