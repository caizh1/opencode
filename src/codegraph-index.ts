import type {
  CodeGraphDerivedIndex,
  CodeGraphFile,
  CodeGraphIndex,
  CodeGraphIndexStats,
  CodeGraphShardInfo,
} from "./codegraph-types"

export const CURRENT_CODE_GRAPH_INDEX_VERSION = 2 as const

export function hydrateCodeGraphIndex(input: CodeGraphIndex, skippedFiles = input.stats?.skippedFiles ?? 0): CodeGraphIndex {
  const stats = buildIndexStats(input.files, skippedFiles)
  return {
    ...input,
    version: CURRENT_CODE_GRAPH_INDEX_VERSION,
    derived: buildDerivedIndex(input.files),
    stats,
  }
}

export function buildDerivedIndex(files: Record<string, CodeGraphFile>): CodeGraphDerivedIndex {
  const functionIdsByName: Record<string, string[]> = {}
  const callerIdsByCallee: Record<string, string[]> = {}
  const includeTargetsByFile: Record<string, string[]> = {}
  const filePathsByInclude: Record<string, string[]> = {}
  const directoryStats: Record<string, { files: number; functions: number; macros: number; bytes: number }> = {}

  for (const file of Object.values(files)) {
    const directory = moduleKey(file.path)
    const stats = (directoryStats[directory] ??= { files: 0, functions: 0, macros: 0, bytes: 0 })
    stats.files++
    stats.functions += file.functions.length
    stats.macros += file.macros.length
    stats.bytes += file.size

    includeTargetsByFile[file.path] = file.includes.map((include) => include.target)
    for (const include of file.includes) {
      pushUnique(filePathsByInclude, include.target, file.path)
    }

    for (const fn of file.functions) {
      pushUnique(functionIdsByName, fn.name, fn.id)
      for (const call of fn.calls) pushUnique(callerIdsByCallee, call.name, fn.id)
    }
  }

  return {
    functionIdsByName: sortedRecord(functionIdsByName),
    callerIdsByCallee: sortedRecord(callerIdsByCallee),
    includeTargetsByFile: sortedRecord(includeTargetsByFile),
    filePathsByInclude: sortedRecord(filePathsByInclude),
    directoryStats: Object.fromEntries(Object.entries(directoryStats).sort(([left], [right]) => left.localeCompare(right))),
  }
}

export function ensureDerivedIndex(index: CodeGraphIndex) {
  if (!index.derived) index.derived = buildDerivedIndex(index.files)
  if (!index.stats) index.stats = buildIndexStats(index.files)
  return index.derived
}

export function buildIndexStats(files: Record<string, CodeGraphFile>, skippedFiles = 0): CodeGraphIndexStats {
  const stats: CodeGraphIndexStats = {
    files: 0,
    functions: 0,
    macros: 0,
    bytes: 0,
    shards: 0,
    skippedFiles,
  }
  const shards = new Set<string>()
  for (const file of Object.values(files)) {
    stats.files++
    stats.functions += file.functions.length
    stats.macros += file.macros.length
    stats.bytes += file.size
    shards.add(shardKeyForPath(file.path))
  }
  stats.shards = shards.size
  return stats
}

export function groupFilesByShard(files: Record<string, CodeGraphFile>) {
  const groups = new Map<string, Record<string, CodeGraphFile>>()
  for (const [path, file] of Object.entries(files)) {
    const key = shardKeyForPath(path)
    groups.set(key, { ...(groups.get(key) ?? {}), [path]: file })
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

function pushUnique(record: Record<string, string[]>, key: string, value: string) {
  const values = (record[key] ??= [])
  if (!values.includes(value)) values.push(value)
}

function sortedRecord(record: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()]),
  )
}
