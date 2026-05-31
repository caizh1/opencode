import type {
  CodeGraphDerivedIndex,
  CodeGraphDirectoryStats,
  CodeGraphFile,
  CodeGraphIndex,
  CodeGraphIndexStats,
  CodeGraphModuleStats,
  CodeGraphPosting,
  CodeGraphShardInfo,
  CodeGraphSymbol,
} from "./codegraph-types"

export const CURRENT_CODE_GRAPH_INDEX_VERSION = 3 as const
export type CodeGraphYield = () => Promise<void>

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function hasOwnKey(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return hasOwnKey(record, key) ? record[key] : undefined
}

function getOrCreate<T>(record: Record<string, T>, key: string, create: () => T) {
  const existing = ownValue(record, key)
  if (existing !== undefined) return existing
  const value = create()
  record[key] = value
  return value
}

function arrayBucket<T>(record: Record<string, T[]>, key: string) {
  const existing = ownValue(record, key)
  if (Array.isArray(existing)) return existing
  const values: T[] = []
  record[key] = values
  return values
}

export function hydrateCodeGraphIndex(input: CodeGraphIndex, skippedFiles = input.stats?.skippedFiles ?? 0): CodeGraphIndex {
  const files = normalizeFiles(input.files)
  const stats = buildIndexStats(files, skippedFiles)
  return {
    ...input,
    version: CURRENT_CODE_GRAPH_INDEX_VERSION,
    files,
    derived: buildDerivedIndex(files),
    stats,
  }
}

export async function hydrateCodeGraphIndexAsync(
  input: CodeGraphIndex,
  skippedFiles = input.stats?.skippedFiles ?? 0,
  yieldIfNeeded: CodeGraphYield = async () => undefined,
): Promise<CodeGraphIndex> {
  const files = await normalizeFilesAsync(input.files, yieldIfNeeded)
  const stats = await buildIndexStatsAsync(files, skippedFiles, yieldIfNeeded)
  const derived = await buildDerivedIndexAsync(files, yieldIfNeeded)
  return {
    ...input,
    version: CURRENT_CODE_GRAPH_INDEX_VERSION,
    files,
    derived,
    stats,
  }
}

export function buildDerivedIndex(files: Record<string, CodeGraphFile>): CodeGraphDerivedIndex {
  const functionIdsByName = emptyRecord<string[]>()
  const callerIdsByCallee = emptyRecord<string[]>()
  const includeTargetsByFile = emptyRecord<string[]>()
  const filePathsByInclude = emptyRecord<string[]>()
  const directoryStats = emptyRecord<CodeGraphDirectoryStats>()
  const symbolsByName = emptyRecord<CodeGraphSymbol[]>()
  const symbolsByPath = emptyRecord<CodeGraphSymbol[]>()
  const postingsByTerm = emptyRecord<CodeGraphPosting[]>()
  const moduleCalleeNames = new Map<string, Set<string>>()
  const functionModuleByName = new Map<string, Set<string>>()

  const normalizedFiles = Object.values(normalizeFiles(files))

  for (const file of normalizedFiles) {
    const directory = moduleKey(file.path)
    const stats = getOrCreate(directoryStats, directory, () => ({ files: 0, functions: 0, macros: 0, types: 0, globals: 0, bytes: 0 }))
    stats.files++
    stats.functions += file.functions.length
    stats.macros += file.macros.length
    stats.types += file.types.length
    stats.globals += file.globals.length
    stats.bytes += file.size

    addSymbol(symbolsByName, symbolsByPath, fileSymbol(file))
    includeTargetsByFile[file.path] = file.includes.map((include) => include.target)
    for (const include of file.includes) {
      pushUnique(filePathsByInclude, include.target, file.path)
      addPosting(postingsByTerm, include.target, {
        term: include.target.toLowerCase(),
        path: file.path,
        line: include.line,
        kind: "include",
        weight: 2.2,
      })
    }

    for (const fn of file.functions) {
      pushUnique(functionIdsByName, fn.name, fn.id)
      addSymbol(symbolsByName, symbolsByPath, functionSymbol(fn))
      addPosting(postingsByTerm, fn.name, {
        term: fn.name.toLowerCase(),
        path: file.path,
        line: fn.startLine,
        kind: "function",
        weight: 6,
        symbolId: fn.id,
      })
      addFunctionModule(functionModuleByName, fn.name, directory)
      for (const call of fn.calls) pushUnique(callerIdsByCallee, call.name, fn.id)
      const calleeNames = (moduleCalleeNames.get(directory) ?? new Set<string>())
      for (const call of fn.calls) calleeNames.add(call.name)
      moduleCalleeNames.set(directory, calleeNames)
    }

    for (const macro of file.macros) {
      const symbol = macroSymbol(file.path, macro.name, macro.line, macro.snippet ?? "")
      addSymbol(symbolsByName, symbolsByPath, symbol)
    }
    for (const type of file.types) {
      addSymbol(symbolsByName, symbolsByPath, typeSymbol(file.path, type))
    }
    for (const global of file.globals) {
      addSymbol(symbolsByName, symbolsByPath, globalSymbol(file.path, global.name, global.line, global.snippet))
    }
    for (const token of file.tokens) {
      addPosting(postingsByTerm, token.term, {
        term: token.term,
        path: file.path,
        line: token.line,
        kind: token.kind,
        weight: postingWeight(token.kind),
      })
    }
  }

  return {
    functionIdsByName: sortedRecord(functionIdsByName),
    callerIdsByCallee: sortedRecord(callerIdsByCallee),
    includeTargetsByFile: sortedRecord(includeTargetsByFile),
    filePathsByInclude: sortedRecord(filePathsByInclude),
    directoryStats: Object.fromEntries(Object.entries(directoryStats).sort(([left], [right]) => left.localeCompare(right))),
    symbolsByName: sortedSymbolRecord(symbolsByName),
    symbolsByPath: sortedSymbolRecord(symbolsByPath),
    postingsByTerm: sortedPostingRecord(postingsByTerm),
    moduleStats: buildModuleStats(directoryStats, moduleCalleeNames, functionModuleByName),
  }
}

export async function buildDerivedIndexAsync(
  files: Record<string, CodeGraphFile>,
  yieldIfNeeded: CodeGraphYield = async () => undefined,
): Promise<CodeGraphDerivedIndex> {
  const functionIdsByName = emptyRecord<string[]>()
  const callerIdsByCallee = emptyRecord<string[]>()
  const includeTargetsByFile = emptyRecord<string[]>()
  const filePathsByInclude = emptyRecord<string[]>()
  const directoryStats = emptyRecord<CodeGraphDirectoryStats>()
  const symbolsByName = emptyRecord<CodeGraphSymbol[]>()
  const symbolsByPath = emptyRecord<CodeGraphSymbol[]>()
  const postingsByTerm = emptyRecord<CodeGraphPosting[]>()
  const moduleCalleeNames = new Map<string, Set<string>>()
  const functionModuleByName = new Map<string, Set<string>>()
  const normalizedFiles = Object.values(files)

  for (let index = 0; index < normalizedFiles.length; index++) {
    const file = normalizeFile(normalizedFiles[index])
    const directory = moduleKey(file.path)
    const stats = getOrCreate(directoryStats, directory, () => ({ files: 0, functions: 0, macros: 0, types: 0, globals: 0, bytes: 0 }))
    stats.files++
    stats.functions += file.functions.length
    stats.macros += file.macros.length
    stats.types += file.types.length
    stats.globals += file.globals.length
    stats.bytes += file.size

    addSymbol(symbolsByName, symbolsByPath, fileSymbol(file))
    includeTargetsByFile[file.path] = file.includes.map((include) => include.target)
    for (const include of file.includes) {
      pushUnique(filePathsByInclude, include.target, file.path)
      addPosting(postingsByTerm, include.target, {
        term: include.target.toLowerCase(),
        path: file.path,
        line: include.line,
        kind: "include",
        weight: 2.2,
      })
    }

    for (const fn of file.functions) {
      pushUnique(functionIdsByName, fn.name, fn.id)
      addSymbol(symbolsByName, symbolsByPath, functionSymbol(fn))
      addPosting(postingsByTerm, fn.name, {
        term: fn.name.toLowerCase(),
        path: file.path,
        line: fn.startLine,
        kind: "function",
        weight: 6,
        symbolId: fn.id,
      })
      addFunctionModule(functionModuleByName, fn.name, directory)
      for (const call of fn.calls) pushUnique(callerIdsByCallee, call.name, fn.id)
      const calleeNames = moduleCalleeNames.get(directory) ?? new Set<string>()
      for (const call of fn.calls) calleeNames.add(call.name)
      moduleCalleeNames.set(directory, calleeNames)
    }

    for (const macro of file.macros) addSymbol(symbolsByName, symbolsByPath, macroSymbol(file.path, macro.name, macro.line, macro.snippet ?? ""))
    for (const type of file.types) addSymbol(symbolsByName, symbolsByPath, typeSymbol(file.path, type))
    for (const global of file.globals) addSymbol(symbolsByName, symbolsByPath, globalSymbol(file.path, global.name, global.line, global.snippet))
    for (const token of file.tokens) {
      addPosting(postingsByTerm, token.term, {
        term: token.term,
        path: file.path,
        line: token.line,
        kind: token.kind,
        weight: postingWeight(token.kind),
      })
    }

    if (index % 25 === 0) await yieldIfNeeded()
  }

  await yieldIfNeeded()
  return {
    functionIdsByName: sortedRecord(functionIdsByName),
    callerIdsByCallee: sortedRecord(callerIdsByCallee),
    includeTargetsByFile: sortedRecord(includeTargetsByFile),
    filePathsByInclude: sortedRecord(filePathsByInclude),
    directoryStats: Object.fromEntries(Object.entries(directoryStats).sort(([left], [right]) => left.localeCompare(right))),
    symbolsByName: sortedSymbolRecord(symbolsByName),
    symbolsByPath: sortedSymbolRecord(symbolsByPath),
    postingsByTerm: sortedPostingRecord(postingsByTerm),
    moduleStats: buildModuleStats(directoryStats, moduleCalleeNames, functionModuleByName),
  }
}

export function ensureDerivedIndex(index: CodeGraphIndex) {
  if (index.version !== CURRENT_CODE_GRAPH_INDEX_VERSION || !index.stats || index.stats.types === undefined || index.stats.globals === undefined) {
    index.files = normalizeFiles(index.files)
  }
  if (!index.derived || !index.derived.symbolsByName || !index.derived.postingsByTerm || !index.derived.moduleStats) {
    index.derived = buildDerivedIndex(index.files)
  }
  if (!index.stats || index.stats.types === undefined || index.stats.globals === undefined) {
    index.stats = buildIndexStats(index.files, index.stats?.skippedFiles ?? 0)
  }
  return index.derived
}

export function buildIndexStats(files: Record<string, CodeGraphFile>, skippedFiles = 0): CodeGraphIndexStats {
  const stats: CodeGraphIndexStats = {
    files: 0,
    functions: 0,
    macros: 0,
    types: 0,
    globals: 0,
    bytes: 0,
    shards: 0,
    skippedFiles,
  }
  const shards = new Set<string>()
  for (const file of Object.values(normalizeFiles(files))) {
    stats.files++
    stats.functions += file.functions.length
    stats.macros += file.macros.length
    stats.types += file.types.length
    stats.globals += file.globals.length
    stats.bytes += file.size
    shards.add(shardKeyForPath(file.path))
  }
  stats.shards = shards.size
  return stats
}

export async function buildIndexStatsAsync(
  files: Record<string, CodeGraphFile>,
  skippedFiles = 0,
  yieldIfNeeded: CodeGraphYield = async () => undefined,
): Promise<CodeGraphIndexStats> {
  const stats: CodeGraphIndexStats = {
    files: 0,
    functions: 0,
    macros: 0,
    types: 0,
    globals: 0,
    bytes: 0,
    shards: 0,
    skippedFiles,
  }
  const shards = new Set<string>()
  let index = 0
  for (const file of Object.values(files)) {
    const normalized = normalizeFile(file)
    stats.files++
    stats.functions += normalized.functions.length
    stats.macros += normalized.macros.length
    stats.types += normalized.types.length
    stats.globals += normalized.globals.length
    stats.bytes += normalized.size
    shards.add(shardKeyForPath(normalized.path))
    if (++index % 100 === 0) await yieldIfNeeded()
  }
  stats.shards = shards.size
  return stats
}

export function groupFilesByShard(files: Record<string, CodeGraphFile>) {
  const groups = new Map<string, Record<string, CodeGraphFile>>()
  for (const [path, file] of Object.entries(files)) {
    const key = shardKeyForPath(path)
    let group = groups.get(key)
    if (!group) {
      group = Object.create(null) as Record<string, CodeGraphFile>
      groups.set(key, group)
    }
    group[path] = file
  }
  return groups
}

export function shardInfo(key: string, files: Record<string, CodeGraphFile>): CodeGraphShardInfo {
  const stats = buildIndexStats(files)
  return {
    key,
    path: `shards/${shardFileName(key)}`,
    files: stats.files,
    functions: stats.functions,
    macros: stats.macros,
    bytes: stats.bytes,
  }
}

export function shardKeyForPath(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const [first, second] = normalized.split("/")
  if (!first) return "root"
  if (!second || /\.[A-Za-z0-9_+-]+$/.test(first) || /\.[A-Za-z0-9_+-]+$/.test(second)) return first
  return `${first}/${second}`
}

export function shardFileName(key: string) {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "root"
  return `${safe}.json`
}

export function moduleKey(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const parts = normalized.split("/")
  if (parts.length <= 1) return "."
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/")
}

function normalizeFiles(files: Record<string, CodeGraphFile>) {
  return Object.fromEntries(Object.entries(files).map(([path, file]) => [path, normalizeFile(file)]))
}

async function normalizeFilesAsync(files: Record<string, CodeGraphFile>, yieldIfNeeded: CodeGraphYield) {
  const normalized: Record<string, CodeGraphFile> = Object.create(null) as Record<string, CodeGraphFile>
  let index = 0
  for (const [path, file] of Object.entries(files)) {
    normalized[path] = normalizeFile(file)
    if (++index % 100 === 0) await yieldIfNeeded()
  }
  return normalized
}

function normalizeFile(file: CodeGraphFile): CodeGraphFile {
  return {
    ...file,
    types: file.types ?? [],
    globals: file.globals ?? [],
    tokens: file.tokens ?? legacyTokensForFile(file),
  }
}

function legacyTokensForFile(file: CodeGraphFile) {
  const tokens: CodeGraphFile["tokens"] = []
  const seen = new Set<string>()
  const add = (term: string, kind: CodeGraphFile["tokens"][number]["kind"], line: number) => {
    const normalized = term.toLowerCase()
    if (!normalized || normalized.length < 2) return
    const key = `${kind}:${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    tokens.push({ term: normalized, kind, line })
  }
  for (const part of file.path.split(/[\\/._-]+/)) add(part, "path", 1)
  for (const fn of file.functions) add(fn.name, "identifier", fn.startLine)
  for (const macro of file.macros) add(macro.name, "macro", macro.line)
  return tokens
}

function addSymbol(
  symbolsByName: Record<string, CodeGraphSymbol[]>,
  symbolsByPath: Record<string, CodeGraphSymbol[]>,
  symbol: CodeGraphSymbol,
) {
  pushSymbol(symbolsByName, symbol.name.toLowerCase(), symbol)
  pushSymbol(symbolsByPath, symbol.path, symbol)
}

function functionSymbol(fn: CodeGraphFile["functions"][number]): CodeGraphSymbol {
  return {
    id: fn.id,
    kind: "function",
    name: fn.name,
    path: fn.path,
    startLine: fn.startLine,
    endLine: fn.endLine,
    signature: fn.signature,
    snippet: fn.snippet,
  }
}

function fileSymbol(file: CodeGraphFile): CodeGraphSymbol {
  return {
    id: `${file.path}:file`,
    kind: "file",
    name: file.path.split(/[\\/]/).pop() ?? file.path,
    path: file.path,
    startLine: 1,
    endLine: 1,
    snippet: `${file.path} (${file.language}, ${file.size} bytes)`,
  }
}

function macroSymbol(path: string, name: string, line: number, snippet: string): CodeGraphSymbol {
  return {
    id: `${path}:macro:${name}:${line}`,
    kind: "macro",
    name,
    path,
    startLine: line,
    endLine: line,
    snippet,
  }
}

function typeSymbol(path: string, type: CodeGraphFile["types"][number]): CodeGraphSymbol {
  return {
    id: `${path}:type:${type.name}:${type.startLine}`,
    kind: "type",
    name: type.name,
    path,
    startLine: type.startLine,
    endLine: type.endLine,
    signature: type.kind,
    snippet: type.snippet,
  }
}

function globalSymbol(path: string, name: string, line: number, snippet: string): CodeGraphSymbol {
  return {
    id: `${path}:global:${name}:${line}`,
    kind: "global",
    name,
    path,
    startLine: line,
    endLine: line,
    snippet,
  }
}

function addPosting(record: Record<string, CodeGraphPosting[]>, term: string, posting: CodeGraphPosting) {
  const normalized = term.toLowerCase()
  if (!normalized || normalized.length < 2) return
  const values = arrayBucket(record, normalized)
  if (values.some((item) => item.path === posting.path && item.line === posting.line && item.kind === posting.kind && item.symbolId === posting.symbolId)) {
    return
  }
  values.push({ ...posting, term: normalized })
}

function postingWeight(kind: CodeGraphPosting["kind"]) {
  switch (kind) {
    case "function":
      return 6
    case "type":
      return 5
    case "macro":
      return 4.5
    case "global":
      return 3.5
    case "path":
      return 3
    case "include":
      return 2.2
    case "comment":
      return 1.4
    default:
      return 1
  }
}

function addFunctionModule(record: Map<string, Set<string>>, functionName: string, module: string) {
  const modules = record.get(functionName) ?? new Set<string>()
  modules.add(module)
  record.set(functionName, modules)
}

function buildModuleStats(
  directoryStats: Record<string, CodeGraphDirectoryStats>,
  moduleCalleeNames: Map<string, Set<string>>,
  functionModuleByName: Map<string, Set<string>>,
): Record<string, CodeGraphModuleStats> {
  const result = emptyRecord<CodeGraphModuleStats>()
  for (const [module, stats] of Object.entries(directoryStats)) {
    let externalCallers = 0
    const hotSymbols: string[] = []
    for (const callee of moduleCalleeNames.get(module) ?? []) {
      const modules = functionModuleByName.get(callee)
      if (!modules) continue
      hotSymbols.push(callee)
      if ([...modules].some((calleeModule) => calleeModule !== module)) {
        externalCallers++
      }
    }
    result[module] = {
      ...stats,
      externalCallers,
      hotSymbols: [...new Set(hotSymbols)].sort().slice(0, 12),
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

function pushUnique(record: Record<string, string[]>, key: string, value: string) {
  const values = arrayBucket(record, key)
  if (!values.includes(value)) values.push(value)
}

function pushSymbol(record: Record<string, CodeGraphSymbol[]>, key: string, value: CodeGraphSymbol) {
  const values = arrayBucket(record, key)
  if (!values.some((symbol) => symbol.id === value.id)) values.push(value)
}

function sortedRecord(record: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()]),
  )
}

function sortedSymbolRecord(record: Record<string, CodeGraphSymbol[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [
        key,
        [...values].sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.name.localeCompare(right.name)),
      ]),
  )
}

function sortedPostingRecord(record: Record<string, CodeGraphPosting[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [
        key,
        [...values]
          .sort((left, right) => right.weight - left.weight || left.path.localeCompare(right.path) || left.line - right.line)
          .slice(0, 400),
      ]),
  )
}
