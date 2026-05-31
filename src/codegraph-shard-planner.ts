import { ensureDerivedIndex, moduleKey, shardKeyForPath } from "./codegraph-index"
import { extractSymbols } from "./codegraph-query"
import type { CodeGraphIndex } from "./codegraph-types"

export type CodeGraphShardQueryPlan = {
  shardKeys: string[]
  reasons: string[]
  candidatePaths: string[]
  lazy: boolean
}

const COMMON_TERMS = new Set(["the", "and", "for", "with", "code", "file", "module", "function", "call", "state"])

export function planShardKeysForQuery(input: {
  index: CodeGraphIndex
  question: string
  relatedPaths?: string[]
  maxShards?: number
}): CodeGraphShardQueryPlan {
  const derived = ensureDerivedIndex(input.index)
  const maxShards = Math.max(1, input.maxShards ?? 12)
  const scores = new Map<string, { score: number; reasons: string[]; paths: Set<string> }>()
  const addPath = (path: string, score: number, reason: string) => {
    const key = shardKeyForPath(path)
    const current = scores.get(key) ?? { score: 0, reasons: [], paths: new Set<string>() }
    current.score += score
    current.reasons.push(reason)
    current.paths.add(path)
    scores.set(key, current)
  }

  for (const path of input.relatedPaths ?? []) addPath(path, 1000, "related-path")

  for (const symbol of extractSymbols(input.question)) {
    for (const match of derived.symbolsByName[symbol.toLowerCase()] ?? []) {
      addPath(match.path, 420, `symbol:${symbol}`)
    }
    for (const fnId of derived.functionIdsByName[symbol] ?? derived.functionIdsByName[symbol.toLowerCase()] ?? []) {
      addPath(functionIdPath(fnId), 380, `function:${symbol}`)
      for (const callerId of derived.callerIdsByCallee[symbol] ?? []) addPath(functionIdPath(callerId), 260, `caller:${symbol}`)
    }
  }

  for (const term of queryTerms(input.question).slice(0, 12)) {
    for (const posting of (derived.postingsByTerm[term] ?? []).slice(0, 80)) {
      addPath(posting.path, posting.weight * 20, `posting:${term}`)
    }
    for (const module of Object.keys(derived.moduleStats)) {
      if (module.toLowerCase().includes(term)) addPath(`${module}/__module__`, 100, `module:${term}`)
    }
  }

  const ranked = [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .slice(0, maxShards)
  return {
    shardKeys: ranked.map(([key]) => key),
    reasons: ranked.flatMap(([, item]) => [...new Set(item.reasons)].slice(0, 3)),
    candidatePaths: ranked.flatMap(([, item]) => [...item.paths].filter((path) => !path.endsWith("/__module__")).slice(0, 8)),
    lazy: Boolean(input.index.storageMode === "sharded" && (input.index.stats?.shards ?? 0) > maxShards),
  }
}

export class CodeGraphHotCache<K, V> {
  private readonly values = new Map<K, V>()

  constructor(private readonly maxSize: number) {}

  get(key: K) {
    const value = this.values.get(key)
    if (value === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  set(key: K, value: V) {
    if (this.maxSize <= 0) return
    this.values.set(key, value)
    while (this.values.size > this.maxSize) {
      const first = this.values.keys().next().value
      if (first === undefined) break
      this.values.delete(first)
    }
  }

  clear() {
    this.values.clear()
  }

  size() {
    return this.values.size
  }
}

function queryTerms(question: string) {
  return [...new Set(
    question
      .split(/[^A-Za-z0-9_./-]+/)
      .flatMap((word) => word.split(/[./-]+/))
      .map((word) => word.toLowerCase())
      .filter((word) => word.length >= 2 && !COMMON_TERMS.has(word)),
  )]
}

function functionIdPath(id: string) {
  const last = id.lastIndexOf(":")
  const beforeLine = last >= 0 ? id.slice(0, last) : id
  const beforeName = beforeLine.lastIndexOf(":")
  return beforeName >= 0 ? beforeLine.slice(0, beforeName) : id
}
