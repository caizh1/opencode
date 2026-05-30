import { ensureDerivedIndex } from "./codegraph-index"
import type { CodeGraphDerivedIndex, CodeGraphFile, CodeGraphFunction, CodeGraphIndex, CodeGraphPromptContext } from "./codegraph-types"

type QueryMode = "overview" | "callers" | "callees" | "call-chain" | "impact" | "explain"

type GraphMaps = {
  files: CodeGraphFile[]
  functions: CodeGraphFunction[]
  byId: Map<string, CodeGraphFunction>
  byName: Map<string, CodeGraphFunction[]>
  byLowerName: Map<string, CodeGraphFunction[]>
  byPath: Map<string, CodeGraphFile>
  derived: CodeGraphDerivedIndex
}

const COMMON_WORDS = new Set([
  "about",
  "after",
  "analyse",
  "analyze",
  "call",
  "called",
  "caller",
  "callers",
  "calls",
  "chain",
  "code",
  "current",
  "explain",
  "file",
  "find",
  "from",
  "function",
  "impact",
  "include",
  "into",
  "module",
  "overview",
  "path",
  "please",
  "review",
  "show",
  "this",
  "what",
  "where",
  "which",
  "who",
  "why",
])

export function buildCodeGraphContext(input: {
  index: CodeGraphIndex
  question: string
  relatedPaths?: string[]
  maxBytes: number
}): CodeGraphPromptContext | undefined {
  const maps = buildMaps(input.index)
  if (maps.functions.length === 0 && maps.files.length === 0) return undefined

  const mode = classifyQuestion(input.question)
  const related = new Set((input.relatedPaths ?? []).map(normalizePath))
  const tokens = extractSymbols(input.question)
  const seeds = selectSeedFunctions(maps, tokens, related, mode)
  const sections: string[] = []
  const evidence = new Map<string, CodeGraphFunction>()

  sections.push(
    `<local-code-graph mode="${xmlAttr(mode)}" indexedFiles="${maps.files.length}" indexedFunctions="${maps.functions.length}" truncated="${input.index.truncated ? "true" : "false"}">`,
  )
  sections.push(`<query>${xmlText(input.question.trim())}</query>`)
  sections.push(formatQueryPlan(mode, tokens, seeds))

  if (mode === "overview" || seeds.length === 0) {
    sections.push(formatOverview(maps))
    if (seeds.length === 0 && tokens.length > 0) sections.push(`<no-symbol-match>${xmlText(tokens.join(", "))}</no-symbol-match>`)
  } else {
    sections.push(formatMatchedSymbols(seeds))
    for (const seed of seeds) evidence.set(seed.id, seed)

    if (mode === "call-chain" && tokens.length >= 2) {
      const chain = findCallChain(maps, tokens[0], tokens[tokens.length - 1], 5)
      if (chain.length > 0) {
        sections.push(formatCallChain(chain))
        for (const fn of chain) evidence.set(fn.id, fn)
      }
    }

    if (mode === "callers" || mode === "impact" || mode === "explain") {
      const callers =
        mode === "impact"
          ? transitiveCallersOf(maps, seeds, 3, 32)
          : uniqueFunctions(seeds.flatMap((seed) => callersOf(maps, seed.name))).slice(0, 14)
      if (callers.length > 0) {
        sections.push(formatRelation(mode === "impact" ? "impact-callers" : "callers", callers))
        for (const fn of callers.slice(0, 8)) evidence.set(fn.id, fn)
      }
    }

    if (mode === "callees" || mode === "impact" || mode === "explain") {
      const callees = uniqueFunctions(seeds.flatMap((seed) => calleesOf(maps, seed))).slice(0, 18)
      if (callees.length > 0) {
        sections.push(formatRelation("callees", callees))
        for (const fn of callees.slice(0, 8)) evidence.set(fn.id, fn)
      }
    }

    const includeContext = includeContextForSeeds(maps, seeds)
    if (includeContext) sections.push(includeContext)
  }

  sections.push(formatEvidence([...evidence.values()].slice(0, 14)))
  sections.push("</local-code-graph>")

  const text = limitText(sections.filter(Boolean).join("\n"), input.maxBytes)
  return {
    text: text.text,
    mode,
    symbols: seeds.map((seed) => seed.name),
    truncated: text.truncated,
  }
}

export function classifyQuestion(question: string): QueryMode {
  const text = question.toLowerCase()
  if (/调用链|调用路径|路径.*调用|call\s*chain|from\s+\w+.*\bto\b|从.+到/.test(text)) return "call-chain"
  if (/谁.*调用|哪些.*调用|调用者|被.*调用|who\s+calls|callers?/.test(text)) return "callers"
  if (/调用.*哪些|调用了谁|依赖哪些函数|依赖.*函数|calls?\s+what|callees?/.test(text)) return "callees"
  if (/影响|风险|改.*影响|impact|blast/.test(text)) return "impact"
  if (/架构|概览|模块|目录|overview|architecture|module/.test(text)) return "overview"
  return "explain"
}

export function extractSymbols(question: string) {
  const explicit = [...question.matchAll(/[`"'“”‘’]([A-Za-z_]\w{2,})[`"'“”‘’]/g)].map((match) => match[1])
  const identifiers = [...question.matchAll(/\b[A-Za-z_]\w{2,}\b/g)].map((match) => match[0])
  return uniqueStrings([...explicit, ...identifiers].filter((word) => !COMMON_WORDS.has(word.toLowerCase())))
}

function buildMaps(index: CodeGraphIndex): GraphMaps {
  const derived = ensureDerivedIndex(index)
  const files = Object.values(index.files)
  const functions = files.flatMap((file) => file.functions)
  const byId = new Map<string, CodeGraphFunction>()
  const byName = new Map<string, CodeGraphFunction[]>()
  const byLowerName = new Map<string, CodeGraphFunction[]>()
  const byPath = new Map<string, CodeGraphFile>()
  for (const file of files) byPath.set(file.path, file)
  for (const fn of functions) {
    byId.set(fn.id, fn)
    pushMap(byName, fn.name, fn)
    pushMap(byLowerName, fn.name.toLowerCase(), fn)
  }
  return { files, functions, byId, byName, byLowerName, byPath, derived }
}

function selectSeedFunctions(maps: GraphMaps, tokens: string[], relatedPaths: Set<string>, mode: QueryMode) {
  const scored = new Map<string, { fn: CodeGraphFunction; score: number }>()
  for (const token of tokens) {
    const exact = maps.byName.get(token) ?? maps.byLowerName.get(token.toLowerCase()) ?? []
    for (const fn of exact) {
      const relatedBoost = relatedPaths.has(normalizePath(fn.path)) ? 60 : 0
      scored.set(fn.id, { fn, score: 160 + relatedBoost })
    }
  }

  for (const fn of maps.functions) {
    let score = scored.get(fn.id)?.score ?? 0
    const lowerName = fn.name.toLowerCase()
    const lowerPath = fn.path.toLowerCase()
    for (const token of tokens) {
      const lower = token.toLowerCase()
      if (lowerName === lower) score += 120
      else if (lowerName.includes(lower)) score += 45
      else if (lowerPath.includes(lower)) score += 15
    }
    if (relatedPaths.has(normalizePath(fn.path))) score += 60
    if (mode === "overview" && relatedPaths.has(normalizePath(fn.path))) score += 20
    if (score > 0) scored.set(fn.id, { fn, score })
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score || left.fn.path.localeCompare(right.fn.path))
    .map((item) => item.fn)
    .slice(0, 6)
}

function callersOf(maps: GraphMaps, target: string) {
  return (maps.derived.callerIdsByCallee[target] ?? []).flatMap((id) => maps.byId.get(id) ?? [])
}

function transitiveCallersOf(maps: GraphMaps, seeds: CodeGraphFunction[], maxDepth: number, limit: number) {
  const result: CodeGraphFunction[] = []
  const visited = new Set(seeds.map((seed) => seed.id))
  const queue = seeds.map((seed) => ({ name: seed.name, depth: 0 }))
  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift()
    if (!current || current.depth >= maxDepth) continue
    for (const caller of callersOf(maps, current.name)) {
      if (visited.has(caller.id)) continue
      visited.add(caller.id)
      result.push(caller)
      queue.push({ name: caller.name, depth: current.depth + 1 })
      if (result.length >= limit) break
    }
  }
  return result
}

function calleesOf(maps: GraphMaps, fn: CodeGraphFunction) {
  return uniqueFunctions(fn.calls.flatMap((call) => maps.byName.get(call.name) ?? []))
}

function findCallChain(maps: GraphMaps, sourceToken: string, targetToken: string, maxDepth: number) {
  const sources = selectSeedFunctions(maps, [sourceToken], new Set(), "call-chain")
  const targetNames = new Set(selectSeedFunctions(maps, [targetToken], new Set(), "call-chain").map((fn) => fn.name))
  if (sources.length === 0 || targetNames.size === 0) return []

  const queue = sources.map((fn) => [fn])
  const visited = new Set(sources.map((fn) => fn.id))
  while (queue.length > 0) {
    const path = queue.shift() ?? []
    const last = path[path.length - 1]
    if (targetNames.has(last.name) && path.length > 1) return path
    if (path.length > maxDepth) continue
    for (const next of calleesOf(maps, last).slice(0, 24)) {
      if (visited.has(next.id)) continue
      visited.add(next.id)
      queue.push([...path, next])
    }
  }
  return []
}

function includeContextForSeeds(maps: GraphMaps, seeds: CodeGraphFunction[]) {
  const seedPaths = new Set(seeds.map((seed) => seed.path))
  const rows: string[] = []
  for (const path of seedPaths) {
    const file = maps.byPath.get(path)
    if (!file) continue
    for (const include of file.includes.slice(0, 12)) {
      rows.push(`<include from="${xmlAttr(file.path)}" target="${xmlAttr(include.target)}" system="${include.system ? "true" : "false"}" line="${include.line}" />`)
    }
  }
  if (rows.length === 0) return ""
  return `<include-context>\n${rows.join("\n")}\n</include-context>`
}

function formatQueryPlan(mode: QueryMode, tokens: string[], seeds: CodeGraphFunction[]) {
  return `<query-plan mode="${xmlAttr(mode)}" tokens="${xmlAttr(tokens.join(", "))}" seedCount="${seeds.length}" />`
}

function formatOverview(maps: GraphMaps) {
  const modules = Object.entries(maps.derived.directoryStats)
    .sort((left, right) => right[1].functions - left[1].functions)
    .slice(0, 12)
    .map(([name, stats]) => `<module path="${xmlAttr(name)}" files="${stats.files}" functions="${stats.functions}" bytes="${stats.bytes}" />`)
  const hot = Object.entries(maps.derived.callerIdsByCallee)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 12)
    .map(([name, callers]) => `<hot-symbol name="${xmlAttr(name)}" callers="${callers.length}" />`)
  return `<overview files="${maps.files.length}" functions="${maps.functions.length}">\n${modules.join("\n")}\n${hot.join("\n")}\n</overview>`
}

function formatMatchedSymbols(functions: CodeGraphFunction[]) {
  return `<matched-symbols>\n${functions
    .map((fn) => `<symbol name="${xmlAttr(fn.name)}" path="${xmlAttr(fn.path)}" lines="${fn.startLine}-${fn.endLine}" static="${fn.isStatic ? "true" : "false"}" />`)
    .join("\n")}\n</matched-symbols>`
}

function formatRelation(name: string, functions: CodeGraphFunction[]) {
  return `<${name}>\n${functions
    .map((fn) => `<function name="${xmlAttr(fn.name)}" path="${xmlAttr(fn.path)}" lines="${fn.startLine}-${fn.endLine}" />`)
    .join("\n")}\n</${name}>`
}

function formatCallChain(functions: CodeGraphFunction[]) {
  return `<call-chain>\n${functions
    .map((fn, index) => `<step index="${index + 1}" name="${xmlAttr(fn.name)}" path="${xmlAttr(fn.path)}" lines="${fn.startLine}-${fn.endLine}" />`)
    .join("\n")}\n</call-chain>`
}

function formatEvidence(functions: CodeGraphFunction[]) {
  if (functions.length === 0) return ""
  return `<evidence>\n${functions
    .map((fn) => `<function name="${xmlAttr(fn.name)}" path="${xmlAttr(fn.path)}" lines="${fn.startLine}-${fn.endLine}">\n${xmlText(fn.snippet)}\n</function>`)
    .join("\n")}\n</evidence>`
}

function uniqueFunctions(functions: CodeGraphFunction[]) {
  const seen = new Set<string>()
  const result: CodeGraphFunction[] = []
  for (const fn of functions) {
    if (seen.has(fn.id)) continue
    seen.add(fn.id)
    result.push(fn)
  }
  return result
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

function pushMap(map: Map<string, CodeGraphFunction[]>, key: string, value: CodeGraphFunction) {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/")
}

function limitText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false }
  let result = ""
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return { text: `${result}\n<truncated>true</truncated>`, truncated: true }
}

function xmlAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
