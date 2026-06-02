import { ensureDerivedIndex, moduleKey } from "./codegraph-index"
import { evidenceFromRagHit, searchRagVectorIndex } from "./rag-index"
import type {
  CodeGraphDerivedIndex,
  CodeGraphEvidence,
  CodeGraphFile,
  CodeGraphFunction,
  CodeGraphIndex,
  CodeGraphPosting,
  CodeGraphPromptContext,
  CodeGraphQueryMetrics,
  CodeGraphQueryMode,
  CodeGraphRetrievalResult,
  CodeGraphSymbol,
} from "./codegraph-types"
import type { HybridRetrievalOptions, HybridRetrievalTrace, RerankProvider } from "./rag-types"

type GraphMaps = {
  files: CodeGraphFile[]
  functions: CodeGraphFunction[]
  symbols: CodeGraphSymbol[]
  byId: Map<string, CodeGraphFunction>
  bySymbolId: Map<string, CodeGraphSymbol>
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
  maxDepth?: number
  maxFanout?: number
}): CodeGraphPromptContext | undefined {
  const result = retrieveEvidence(input)
  if (!result) return undefined
  const text = formatRetrievalResult(result, input.index, input.maxBytes)
  return {
    text: text.text,
    mode: result.mode,
    symbols: result.symbols,
    truncated: result.truncated || text.truncated,
    metrics: metricsForResult(result, text.truncated),
  }
}

export async function buildHybridCodeGraphContext(input: {
  index: CodeGraphIndex
  question: string
  relatedPaths?: string[]
  maxBytes: number
  maxDepth?: number
  maxFanout?: number
  hybrid?: HybridRetrievalOptions
}): Promise<CodeGraphPromptContext | undefined> {
  const result = await retrieveHybridEvidence(input)
  if (!result) return undefined
  const text = formatRetrievalResult(result, input.index, input.maxBytes)
  return {
    text: text.text,
    mode: result.mode,
    symbols: result.symbols,
    truncated: result.truncated || text.truncated,
    metrics: metricsForResult(result, text.truncated),
  }
}

export function retrieveEvidence(input: {
  index: CodeGraphIndex
  question: string
  relatedPaths?: string[]
  maxBytes?: number
  maxDepth?: number
  maxFanout?: number
}): CodeGraphRetrievalResult | undefined {
  const startedAt = Date.now()
  const maps = buildMaps(input.index)
  if (maps.functions.length === 0 && maps.files.length === 0) return undefined

  const mode = classifyQuestion(input.question)
  const maxDepth = input.maxDepth ?? 2
  const maxFanout = input.maxFanout ?? 40
  const relatedPaths = new Set((input.relatedPaths ?? []).map(normalizePath))
  const symbols = extractSymbols(input.question)
  const terms = extractSearchTerms(input.question, symbols)
  const candidates = new EvidenceCollector()

  addRelatedPathEvidence(candidates, maps, relatedPaths)
  addSymbolEvidence(candidates, maps, symbols, relatedPaths)
  addPostingEvidence(candidates, maps, terms, relatedPaths, maxFanout)
  addModuleEvidence(candidates, maps, mode, terms, relatedPaths, maxFanout)

  const seeds = selectSeedFunctions(maps, symbols, terms, relatedPaths, mode, maxFanout)
  for (const seed of seeds) {
    candidates.add(functionEvidence(seed, 240, "seed function"))
  }

  if (mode === "call-chain" && symbols.length >= 2) {
    const chain = findCallChain(maps, symbols[0], symbols[symbols.length - 1], Math.max(3, maxDepth + 2), maxFanout)
    chain.forEach((fn, index) => {
      candidates.add(functionEvidence(fn, 220 - index * 8, `call-chain step ${index + 1}`))
    })
  }

  if (mode === "callers" || mode === "impact" || mode === "explain") {
    const callers =
      mode === "impact"
        ? transitiveCallersOf(maps, seeds, maxDepth, maxFanout * Math.max(1, maxDepth))
        : uniqueFunctions(seeds.flatMap((seed) => callersOf(maps, seed.name)).slice(0, maxFanout))
    callers.forEach((fn, index) => candidates.add(functionEvidence(fn, 190 - Math.min(index, 30), mode === "impact" ? "transitive caller" : "caller")))
  }

  if (mode === "callees" || mode === "impact" || mode === "explain") {
    const callees = uniqueFunctions(seeds.flatMap((seed) => calleesOf(maps, seed)).slice(0, maxFanout))
    callees.forEach((fn, index) => candidates.add(functionEvidence(fn, 170 - Math.min(index, 30), "callee")))
  }

  addIncludeEvidence(candidates, maps, seeds, maxFanout)

  const ranked = candidates.ranked()
  const packed = packEvidence(ranked, input.maxBytes ?? 60_000)
  const truncated = input.index.truncated || packed.truncated
  return {
    mode,
    tokens: terms,
    symbols: uniqueStrings(seeds.map((seed) => seed.name)),
    evidence: packed.evidence,
    candidateCount: ranked.length,
    packedBytes: packed.bytes,
    omittedCandidates: ranked.length - packed.evidence.length,
    truncated,
    elapsedMs: Date.now() - startedAt,
  }
}

export async function retrieveHybridEvidence(input: {
  index: CodeGraphIndex
  question: string
  relatedPaths?: string[]
  maxBytes?: number
  maxDepth?: number
  maxFanout?: number
  hybrid?: HybridRetrievalOptions
}): Promise<CodeGraphRetrievalResult | undefined> {
  const startedAt = Date.now()
  const baseStarted = Date.now()
  const base = retrieveEvidence(input)
  if (!base) return undefined

  const trace: HybridRetrievalTrace = {
    enabled: Boolean(input.hybrid?.settings.embedding.enabled || input.hybrid?.settings.rerank.enabled),
    provider: input.hybrid?.embeddingProvider?.id,
    rerankProvider: input.hybrid?.rerankProvider?.id,
    vectorCandidates: 0,
    rerankedCandidates: 0,
    steps: [{ label: "bm25", detail: `${base.evidence.length} fallback evidence item(s)`, elapsedMs: Date.now() - baseStarted }],
  }

  const evidence = new EvidenceCollector()
  for (const item of base.evidence) evidence.add(item)

  const hybrid = input.hybrid
  if (hybrid?.settings.embedding.enabled && hybrid.settings.vectorTopK > 0) {
    const vectorStarted = Date.now()
    try {
      if (!hybrid.embeddingProvider) throw new Error("embedding provider is not configured")
      if (!hybrid.vectorIndex || hybrid.vectorIndex.chunks.length === 0) throw new Error("local vector index is empty")
      const queryVector = (await hybrid.embeddingProvider.embed([input.question], hybrid.signal))[0]
      if (!queryVector) throw new Error("embedding provider returned no query vector")
      const hits = searchRagVectorIndex(hybrid.vectorIndex, queryVector, hybrid.settings.vectorTopK)
      trace.vectorCandidates = hits.length
      for (const hit of hits) evidence.add(evidenceFromRagHit(hit))
      trace.steps.push({ label: "vector", detail: `${hits.length} vector candidate(s)`, elapsedMs: Date.now() - vectorStarted })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      trace.fallbackReason = reason
      trace.steps.push({ label: "fallback", detail: `vector disabled: ${reason}`, elapsedMs: Date.now() - vectorStarted })
    }
  } else {
    trace.steps.push({ label: "fallback", detail: "vector disabled by settings or topK=0", elapsedMs: 0 })
  }

  let ranked = evidence.ranked()
  if (hybrid?.settings.rerank.enabled && hybrid.rerankProvider && hybrid.settings.rerankTopK > 0) {
    const rerankStarted = Date.now()
    try {
      ranked = await rerankEvidence({
        question: input.question,
        evidence: ranked,
        provider: hybrid.rerankProvider,
        topK: hybrid.settings.rerankTopK,
        signal: hybrid.signal,
      })
      trace.rerankedCandidates = Math.min(hybrid.settings.rerankTopK, ranked.length)
      trace.steps.push({ label: "rerank", detail: `${trace.rerankedCandidates} candidate(s) reranked`, elapsedMs: Date.now() - rerankStarted })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      trace.fallbackReason = trace.fallbackReason ?? reason
      trace.steps.push({ label: "fallback", detail: `rerank disabled: ${reason}`, elapsedMs: Date.now() - rerankStarted })
    }
  } else if (hybrid?.settings.rerank.enabled) {
    trace.steps.push({ label: "fallback", detail: "rerank provider is not configured", elapsedMs: 0 })
  }

  const packed = packEvidence(ranked, input.maxBytes ?? 60_000)
  return {
    ...base,
    evidence: packed.evidence,
    candidateCount: ranked.length,
    packedBytes: packed.bytes,
    omittedCandidates: ranked.length - packed.evidence.length,
    truncated: input.index.truncated || packed.truncated,
    elapsedMs: Date.now() - startedAt,
    trace: trace.steps.map((step) => ({ label: step.label, detail: step.detail, elapsedMs: step.elapsedMs })),
  }
}

export function classifyQuestion(question: string): CodeGraphQueryMode {
  const text = question.toLowerCase()
  if (/调用链|调用路径|路径.*调用|从.+到.+|call\s*chain|from\s+\w+.*\bto\b/.test(text)) return "call-chain"
  if (/调用了谁|调用哪些|调用.*哪些|依赖哪些函数|依赖.*函数|calls?\s+what|callees?|what\s+does.+call/.test(text)) return "callees"
  if (/谁调用|谁会调用|哪些.+调用|调用者|被.+调用|who\s+calls|callers?/.test(text)) return "callers"
  if (/影响|风险|改.+影响|波及|impact|blast|affected|risk/.test(text)) return "impact"
  if (/架构|概览|模块|目录|组件|overview|architecture|module|component/.test(text)) return "overview"
  if (/调用链|调用路径|路径.*调用|从.+到.+|call\s*chain|from\s+\w+.*\bto\b/.test(text)) return "call-chain"
  if (/调用了谁|调用哪些|调用.*哪些|依赖哪些函数|依赖.*函数|calls?\s+what|callees?|what\s+does.+call/.test(text)) return "callees"
  if (/谁调用|谁会调用|哪些.+调用|调用者|被.+调用|who\s+calls|callers?/.test(text)) return "callers"
  if (/影响|风险|改.+影响|波及|impact|blast|affected|risk/.test(text)) return "impact"
  if (/架构|概览|模块|目录|组件|overview|architecture|module|component/.test(text)) return "overview"
  return "explain"
}

export function extractSymbols(question: string) {
  const unicodeExplicit = [...question.matchAll(/[`"'“”‘’]([A-Za-z_]\w{2,})[`"'“”‘’]/g)].map((match) => match[1])
  const explicit = [...question.matchAll(/[`"'“”‘’]([A-Za-z_]\w{2,})[`"'“”‘’]/g)].map((match) => match[1])
  const identifiers = [...question.matchAll(/\b[A-Za-z_]\w{2,}\b/g)].map((match) => match[0])
  return uniqueStrings([...unicodeExplicit, ...explicit, ...identifiers].filter((word) => !COMMON_WORDS.has(word.toLowerCase())))
}

function buildMaps(index: CodeGraphIndex): GraphMaps {
  const derived = ensureDerivedIndex(index)
  const files = Object.values(index.files)
  const functions = files.flatMap((file) => file.functions)
  const symbols = Object.values(derived.symbolsByName).flatMap((values) => (Array.isArray(values) ? values : []))
  const byId = new Map<string, CodeGraphFunction>()
  const bySymbolId = new Map<string, CodeGraphSymbol>()
  const byName = new Map<string, CodeGraphFunction[]>()
  const byLowerName = new Map<string, CodeGraphFunction[]>()
  const byPath = new Map<string, CodeGraphFile>()
  for (const file of files) byPath.set(file.path, file)
  for (const symbol of symbols) bySymbolId.set(symbol.id, symbol)
  for (const fn of functions) {
    byId.set(fn.id, fn)
    pushMap(byName, fn.name, fn)
    pushMap(byLowerName, fn.name.toLowerCase(), fn)
  }
  return { files, functions, symbols, byId, bySymbolId, byName, byLowerName, byPath, derived }
}

function addRelatedPathEvidence(collector: EvidenceCollector, maps: GraphMaps, relatedPaths: Set<string>) {
  for (const path of relatedPaths) {
    const file = maps.byPath.get(path)
    if (!file) continue
    collector.add(fileEvidence(file, 150, "related file context"))
    for (const symbol of ownArray(maps.derived.symbolsByPath, path).slice(0, 12)) {
      if (symbol.kind === "file") continue
      collector.add(symbolEvidence(symbol, 130, "symbol in related file"))
    }
  }
}

function addSymbolEvidence(
  collector: EvidenceCollector,
  maps: GraphMaps,
  symbols: string[],
  relatedPaths: Set<string>,
) {
  for (const token of symbols) {
    const matches = ownArray(maps.derived.symbolsByName, token.toLowerCase())
    for (const symbol of matches.slice(0, 50)) {
      collector.add(symbolEvidence(symbol, 260 + relatedBoost(symbol.path, relatedPaths), "exact symbol match"))
    }
  }
}

function addPostingEvidence(
  collector: EvidenceCollector,
  maps: GraphMaps,
  terms: string[],
  relatedPaths: Set<string>,
  maxFanout: number,
) {
  const fileScores = new Map<string, { file: CodeGraphFile; score: number; reasons: string[]; lines: number[] }>()
  const totalFiles = Math.max(1, maps.files.length)
  for (const term of terms) {
    const postings = ownArray(maps.derived.postingsByTerm, term)
    const idf = Math.log((totalFiles + 1) / (postings.length + 1)) + 1
    for (const posting of postings.slice(0, maxFanout)) {
      const file = maps.byPath.get(posting.path)
      if (!file) continue
      const current = fileScores.get(file.path) ?? { file, score: 0, reasons: [], lines: [] }
      current.score += posting.weight * idf * 12 + relatedBoost(file.path, relatedPaths)
      current.reasons.push(`${posting.kind}:${term}`)
      current.lines.push(posting.line)
      fileScores.set(file.path, current)
      const symbol = posting.symbolId ? maps.bySymbolId.get(posting.symbolId) : nearestSymbolForPosting(maps, posting)
      if (symbol) {
        collector.add(symbolEvidence(symbol, posting.weight * idf * 26 + relatedBoost(symbol.path, relatedPaths), `posting ${posting.kind}:${term}`))
      }
    }
  }

  for (const item of [...fileScores.values()].sort((left, right) => right.score - left.score).slice(0, Math.max(8, Math.floor(maxFanout / 2)))) {
    collector.add(fileEvidence(item.file, item.score, uniqueStrings(item.reasons).slice(0, 5).join(", "), medianLine(item.lines)))
  }
}

function addModuleEvidence(
  collector: EvidenceCollector,
  maps: GraphMaps,
  mode: CodeGraphQueryMode,
  terms: string[],
  relatedPaths: Set<string>,
  maxFanout: number,
) {
  if (mode !== "overview" && relatedPaths.size === 0) return
  const scored = Object.entries(maps.derived.moduleStats).map(([module, stats]) => {
    let score = mode === "overview" ? 60 : 20
    for (const term of terms) {
      if (module.toLowerCase().includes(term)) score += 90
      for (const hot of stats.hotSymbols) if (hot.toLowerCase().includes(term)) score += 20
    }
    for (const path of relatedPaths) {
      if (moduleKey(path) === module) score += 120
      else if (path.startsWith(`${module}/`)) score += 80
    }
    return { module, stats, score }
  })

  for (const item of scored.filter((item) => item.score > 40).sort((left, right) => right.score - left.score).slice(0, 8)) {
    collector.add({
      path: item.module,
      startLine: 1,
      endLine: 1,
      kind: "module",
      score: item.score,
      reason: "module match",
      snippet: `module ${item.module}: ${item.stats.files} file(s), ${item.stats.functions} function(s), ${item.stats.macros} macro(s), ${item.stats.types} type(s), hot symbols: ${item.stats.hotSymbols.join(", ") || "none"}`,
    })
    const moduleFiles = maps.files.filter((file) => moduleKey(file.path) === item.module)
    for (const file of moduleFiles.slice(0, Math.min(10, maxFanout))) {
      collector.add(fileEvidence(file, item.score - 10, "file in matched module"))
      for (const fn of file.functions.slice(0, 5)) collector.add(functionEvidence(fn, item.score - 15, "entry candidate in matched module"))
    }
  }
}

function addIncludeEvidence(collector: EvidenceCollector, maps: GraphMaps, seeds: CodeGraphFunction[], maxFanout: number) {
  const seedPaths = new Set(seeds.map((seed) => seed.path))
  for (const path of seedPaths) {
    const file = maps.byPath.get(path)
    if (!file) continue
    for (const include of file.includes.slice(0, maxFanout)) {
      collector.add({
        path: file.path,
        startLine: include.line,
        endLine: include.line,
        kind: "include",
        score: 95,
        reason: "include from seed file",
        snippet: `#include ${include.system ? "<" : '"'}${include.target}${include.system ? ">" : '"'}`,
      })
      for (const includer of ownArray(maps.derived.filePathsByInclude, include.target).slice(0, Math.min(8, maxFanout))) {
        const includeFile = maps.byPath.get(includer)
        if (includeFile) collector.add(fileEvidence(includeFile, 75, `also includes ${include.target}`))
      }
    }
  }
}

function selectSeedFunctions(
  maps: GraphMaps,
  symbols: string[],
  terms: string[],
  relatedPaths: Set<string>,
  mode: CodeGraphQueryMode,
  maxFanout: number,
) {
  const scored = new Map<string, { fn: CodeGraphFunction; score: number }>()
  for (const token of symbols) {
    const exact = maps.byName.get(token) ?? maps.byLowerName.get(token.toLowerCase()) ?? []
    for (const fn of exact) {
      scored.set(fn.id, { fn, score: 220 + relatedBoost(fn.path, relatedPaths) })
    }
  }

  for (const fn of maps.functions) {
    let score = scored.get(fn.id)?.score ?? 0
    const lowerName = fn.name.toLowerCase()
    const lowerPath = fn.path.toLowerCase()
    for (const term of terms) {
      if (lowerName === term) score += 180
      else if (lowerName.includes(term)) score += 55
      else if (mode === "overview" && lowerPath.includes(term)) score += 20
    }
    if (relatedPaths.has(normalizePath(fn.path))) score += 70
    if (mode === "overview" && relatedPaths.has(normalizePath(fn.path))) score += 30
    if (score > 0) scored.set(fn.id, { fn, score })
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score || left.fn.path.localeCompare(right.fn.path))
    .map((item) => item.fn)
    .slice(0, Math.min(12, maxFanout))
}

function callersOf(maps: GraphMaps, target: string) {
  return ownArray(maps.derived.callerIdsByCallee, target).flatMap((id) => maps.byId.get(id) ?? [])
}

function transitiveCallersOf(maps: GraphMaps, seeds: CodeGraphFunction[], maxDepth: number, limit: number) {
  const result: CodeGraphFunction[] = []
  const visited = new Set(seeds.map((seed) => seed.id))
  const queue = seeds.map((seed) => ({ name: seed.name, depth: 0 }))
  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift()
    if (!current || current.depth >= maxDepth) continue
    for (const caller of callersOf(maps, current.name).slice(0, limit)) {
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

function findCallChain(maps: GraphMaps, sourceToken: string, targetToken: string, maxDepth: number, maxFanout: number) {
  const sources = selectSeedFunctions(maps, [sourceToken], [sourceToken.toLowerCase()], new Set(), "call-chain", maxFanout)
  const targetNames = new Set(selectSeedFunctions(maps, [targetToken], [targetToken.toLowerCase()], new Set(), "call-chain", maxFanout).map((fn) => fn.name))
  if (sources.length === 0 || targetNames.size === 0) return []

  const queue = sources.map((fn) => [fn])
  const visited = new Set(sources.map((fn) => fn.id))
  while (queue.length > 0) {
    const path = queue.shift() ?? []
    const last = path[path.length - 1]
    if (targetNames.has(last.name) && path.length > 1) return path
    if (path.length > maxDepth) continue
    for (const next of calleesOf(maps, last).slice(0, maxFanout)) {
      if (visited.has(next.id)) continue
      visited.add(next.id)
      queue.push([...path, next])
    }
  }
  return []
}

function nearestSymbolForPosting(maps: GraphMaps, posting: CodeGraphPosting) {
  const symbols = ownArray(maps.derived.symbolsByPath, posting.path)
  return symbols
    .filter((symbol) => symbol.kind !== "file")
    .sort((left, right) => Math.abs(left.startLine - posting.line) - Math.abs(right.startLine - posting.line))[0]
}

function functionEvidence(fn: CodeGraphFunction, score: number, reason: string): CodeGraphEvidence {
  return {
    path: fn.path,
    startLine: fn.startLine,
    endLine: fn.endLine,
    kind: reason.includes("caller") ? "caller" : reason.includes("callee") ? "callee" : "function",
    score,
    reason,
    snippet: fn.snippet,
  }
}

function symbolEvidence(symbol: CodeGraphSymbol, score: number, reason: string): CodeGraphEvidence {
  return {
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    kind: symbol.kind,
    score,
    reason,
    snippet: symbol.snippet,
  }
}

function fileEvidence(file: CodeGraphFile, score: number, reason: string, line = 1): CodeGraphEvidence {
  const topTypes = file.types.slice(0, 6).map((type) => `${type.name}:${type.startLine}`).join(", ")
  const topMacros = file.macros.slice(0, 8).map((macro) => `${macro.name}:${macro.line}`).join(", ")
  const ast = file.astSummary
    ? ` AST: ${file.astSummary.switchStatements} switch(es), ${file.astSummary.ifStatements} if(s), ${file.astSummary.assignments} assignment(s).`
    : ""
  return {
    path: file.path,
    startLine: line,
    endLine: line,
    kind: "file",
    score,
    reason,
    snippet: `file ${file.path}: ${file.functions.length} function(s), ${file.macros.length} macro(s), ${file.types.length} type(s).${ast} types: ${topTypes || "none"}. macros: ${topMacros || "none"}.`,
  }
}

function packEvidence(evidence: CodeGraphEvidence[], maxBytes: number) {
  const packed: CodeGraphEvidence[] = []
  let used = 0
  for (const item of evidence) {
    const size = Buffer.byteLength(formatEvidenceItem(item), "utf8")
    if (used + size > maxBytes) return { evidence: packed, bytes: used, truncated: true }
    packed.push(item)
    used += size
  }
  return { evidence: packed, bytes: used, truncated: false }
}

function formatRetrievalResult(result: CodeGraphRetrievalResult, index: CodeGraphIndex, maxBytes: number) {
  const sections = [
    `<local-code-graph mode="${xmlAttr(result.mode)}" indexedFiles="${Object.keys(index.files).length}" indexedFunctions="${countFunctions(index)}" truncated="${index.truncated ? "true" : "false"}" candidates="${result.candidateCount}" evidenceCount="${result.evidence.length}" omittedCandidates="${result.omittedCandidates}" packedBytes="${result.packedBytes}" elapsedMs="${result.elapsedMs}">`,
    `<query-plan mode="${xmlAttr(result.mode)}" tokens="${xmlAttr(result.tokens.join(", "))}" seedSymbols="${xmlAttr(result.symbols.join(", "))}" />`,
    result.trace?.length ? `<hybrid-trace>\n${xmlText(result.trace.map((step) => `- ${step.label}: ${step.detail} (${step.elapsedMs}ms)`).join("\n"))}\n</hybrid-trace>` : "",
    "<answer-rules>Answer only from the evidence below for local code questions. Cite file paths and line ranges. If the evidence is insufficient, state the missing evidence instead of guessing.</answer-rules>",
    "<evidence-list>",
    ...result.evidence.map(formatEvidenceItem),
    "</evidence-list>",
    result.omittedCandidates > 0 ? `<omitted-candidates>${result.omittedCandidates}</omitted-candidates>` : "",
    result.truncated ? "<truncated>true</truncated>" : "",
    "</local-code-graph>",
  ]
  return limitText(sections.filter(Boolean).join("\n"), maxBytes)
}

function metricsForResult(result: CodeGraphRetrievalResult, contextTruncated: boolean): CodeGraphQueryMetrics {
  return {
    mode: result.mode,
    tokens: result.tokens,
    symbols: result.symbols,
    candidateCount: result.candidateCount,
    evidenceCount: result.evidence.length,
    omittedCandidates: result.omittedCandidates,
    packedBytes: result.packedBytes,
    truncated: result.truncated || contextTruncated,
    elapsedMs: result.elapsedMs,
  }
}

function formatEvidenceItem(item: CodeGraphEvidence) {
  return `<evidence kind="${xmlAttr(item.kind)}" path="${xmlAttr(item.path)}" lines="${item.startLine}-${item.endLine}" score="${Math.round(item.score)}" reason="${xmlAttr(item.reason)}">\n${xmlText(item.snippet)}\n</evidence>`
}

async function rerankEvidence(input: {
  question: string
  evidence: CodeGraphEvidence[]
  provider: RerankProvider
  topK: number
  signal?: AbortSignal
}) {
  const strong = input.evidence.filter(isStrongEvidence)
  const ordinary = input.evidence.filter((item) => !isStrongEvidence(item))
  const selected = ordinary.slice(0, input.topK)
  if (selected.length === 0) return input.evidence
  const scores = await input.provider.rerank({
    query: input.question,
    documents: selected.map((item) => item.snippet),
    topN: selected.length,
    signal: input.signal,
  })
  const byIndex = new Map(scores.map((item) => [item.index, item.score]))
  const reranked = selected
    .map((item, index) => {
      const score = byIndex.get(index)
      return score === undefined
        ? item
        : { ...item, score: item.score + score * 100, reason: `${item.reason}, rerank:${score.toFixed(3)}` }
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine)
  const unselected = ordinary.slice(input.topK)
  return [...strong.sort((left, right) => right.score - left.score), ...reranked, ...unselected]
}

function isStrongEvidence(item: CodeGraphEvidence) {
  return /exact symbol match|related file context|symbol in related file|state-machine|call-chain step/.test(item.reason)
}

function extractSearchTerms(question: string, symbols: string[]) {
  const identifierTerms = symbols.flatMap(tokenizeIdentifier)
  const words = question
    .split(/[^A-Za-z0-9_./-]+/)
    .flatMap((word) => word.split(/[./-]+/))
    .flatMap(tokenizeIdentifier)
  return uniqueStrings([...identifierTerms, ...words].filter((word) => !COMMON_WORDS.has(word)))
}

function tokenizeIdentifier(input: string) {
  return uniqueStrings(
    input
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9_]+|_+/)
      .filter(Boolean)
      .concat(input)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 2),
  )
}

function medianLine(lines: number[]) {
  if (lines.length === 0) return 1
  const sorted = [...lines].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function relatedBoost(path: string, relatedPaths: Set<string>) {
  return relatedPaths.has(normalizePath(path)) ? 60 : 0
}

function countFunctions(index: CodeGraphIndex) {
  return Object.values(index.files).reduce((count, file) => count + file.functions.length, 0)
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

function ownArray<T>(record: Record<string, T[]>, key: string): T[] {
  const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
  return Array.isArray(value) ? value : []
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

class EvidenceCollector {
  private readonly items = new Map<string, CodeGraphEvidence>()

  add(item: CodeGraphEvidence) {
    const key = `${item.path}:${item.startLine}:${item.endLine}:${item.kind}:${item.reason}`
    const existing = this.items.get(key)
    if (!existing || item.score > existing.score) this.items.set(key, item)
  }

  ranked() {
    return [...this.items.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine)
  }
}
