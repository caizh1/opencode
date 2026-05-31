import { parseCFile } from "./codegraph-c-parser"
import { hydrateCodeGraphIndex } from "./codegraph-index"
import { retrieveEvidence } from "./codegraph-query"
import type { CodeGraphFile } from "./codegraph-types"

export type CodeGraphBenchmarkSpec = {
  files: number
  loc: number
  language: "c/c++"
  languageMix: Record<string, number>
  mode: "full-index" | "streaming-sharded"
  moduleCount: number
  averageFileBytes: number
  callEdges: number
  symbols: number
}

export type CodeGraphBenchmarkReport = {
  spec: CodeGraphBenchmarkSpec
  metrics: {
    parseMs: number
    indexMs: number
    totalMs: number
    filesPerSecond: number
    mbPerSecond: number
    peakHeapBytes: number
    indexBytes: number
    shards: number
    queryP50Ms: number
    queryP95Ms: number
    queryP99Ms: number
    incrementalMs: number
    recoveryMs: number
  }
  queries: {
    question: string
    elapsedMs: number
    evidenceCount: number
    candidateCount: number
  }[]
}

export function generateSyntheticCodeGraphFiles(count: number): Record<string, CodeGraphFile> {
  const files: CodeGraphFile[] = []
  for (let index = 0; index < count; index++) {
    const module = syntheticModule(index)
    const text = syntheticFileText(index)
    files.push(
      parseCFile({
        path: `${module}/synthetic_${index}.c`,
        hash: String(index),
        size: Buffer.byteLength(text, "utf8"),
        text,
      }),
    )
  }
  return Object.fromEntries(files.map((file) => [file.path, file]))
}

export function runCodeGraphSyntheticBenchmark(input: { files: number; queryTargets?: number[]; streamingThreshold?: number }): CodeGraphBenchmarkReport {
  if (input.files > (input.streamingThreshold ?? 100000)) return runStreamingShardedBenchmark(input)
  const started = Date.now()
  const heapSamples: number[] = [heapUsed()]
  const startedParse = Date.now()
  const files = generateSyntheticCodeGraphFiles(input.files)
  const parseMs = Date.now() - startedParse
  heapSamples.push(heapUsed())

  const startedIndex = Date.now()
  const index = hydrateCodeGraphIndex({
    version: 1,
    rootPath: "/synthetic",
    rootName: "synthetic",
    updatedAt: Date.now(),
    truncated: false,
    files,
  })
  const indexMs = Date.now() - startedIndex
  heapSamples.push(heapUsed())
  const loc = Object.values(files).reduce((sum, file) => sum + file.functions.reduce((inner, fn) => inner + Math.max(1, fn.endLine - fn.startLine + 1), 0), 0)
  const callEdges = Object.values(files).reduce((sum, file) => sum + file.functions.reduce((inner, fn) => inner + fn.calls.length, 0), 0)
  const symbols = Object.values(index.derived?.symbolsByPath ?? {}).reduce((sum, values) => sum + values.length, 0)

  const targets = input.queryTargets ?? defaultQueryTargets(input.files)
  const queries = targets.map((target) => {
    const question = `impact of synthetic_target_${target}`
    const result = retrieveEvidence({
      index,
      question,
      maxBytes: 60000,
      maxDepth: 2,
      maxFanout: 40,
    })
    return {
      question,
      elapsedMs: result?.elapsedMs ?? 0,
      evidenceCount: result?.evidence.length ?? 0,
      candidateCount: result?.candidateCount ?? 0,
    }
  })

  const queryTimes = queries.map((query) => query.elapsedMs).sort((left, right) => left - right)
  const indexBytes = index.stats?.bytes ?? Object.values(files).reduce((sum, file) => sum + file.size, 0)
  const totalMs = Date.now() - started
  const incrementalStarted = Date.now()
  hydrateCodeGraphIndex({ ...index, files: { ...index.files, ...Object.fromEntries(Object.entries(files).slice(0, 1)) } })
  const incrementalMs = Date.now() - incrementalStarted
  const recoveryStarted = Date.now()
  hydrateCodeGraphIndex({ ...index, files: index.files })
  const recoveryMs = Date.now() - recoveryStarted

  return {
    spec: {
      files: input.files,
      loc,
      language: "c/c++",
      languageMix: { "c/c++": input.files },
      mode: "full-index",
      moduleCount: new Set(Object.keys(files).map((path) => path.split("/").slice(0, 2).join("/"))).size,
      averageFileBytes: Math.round(indexBytes / Math.max(1, input.files)),
      callEdges,
      symbols,
    },
    metrics: {
      parseMs,
      indexMs,
      totalMs,
      filesPerSecond: roundRate(input.files, Math.max(1, parseMs + indexMs)),
      mbPerSecond: roundRate(indexBytes / 1024 / 1024, Math.max(1, parseMs + indexMs)),
      peakHeapBytes: Math.max(...heapSamples),
      indexBytes,
      shards: index.stats?.shards ?? 0,
      queryP50Ms: percentile(queryTimes, 0.5),
      queryP95Ms: percentile(queryTimes, 0.95),
      queryP99Ms: percentile(queryTimes, 0.99),
      incrementalMs,
      recoveryMs,
    },
    queries,
  }
}

export function formatCodeGraphBenchmarkReport(report: CodeGraphBenchmarkReport) {
  return [
    `files=${report.spec.files}`,
    `loc=${report.spec.loc}`,
    `language=${report.spec.language}`,
    `languageMix=${Object.entries(report.spec.languageMix).map(([language, count]) => `${language}:${count}`).join(",")}`,
    `mode=${report.spec.mode}`,
    `modules=${report.spec.moduleCount}`,
    `avgFileBytes=${report.spec.averageFileBytes}`,
    `callEdges=${report.spec.callEdges}`,
    `symbols=${report.spec.symbols}`,
    `parseMs=${report.metrics.parseMs}`,
    `indexMs=${report.metrics.indexMs}`,
    `filesPerSec=${report.metrics.filesPerSecond}`,
    `mbPerSec=${report.metrics.mbPerSecond}`,
    `peakHeapBytes=${report.metrics.peakHeapBytes}`,
    `indexBytes=${report.metrics.indexBytes}`,
    `shards=${report.metrics.shards}`,
    `queryP50Ms=${report.metrics.queryP50Ms}`,
    `queryP95Ms=${report.metrics.queryP95Ms}`,
    `queryP99Ms=${report.metrics.queryP99Ms}`,
    `incrementalMs=${report.metrics.incrementalMs}`,
    `recoveryMs=${report.metrics.recoveryMs}`,
  ].join("\n")
}

function syntheticModule(index: number) {
  const families = ["drivers", "kernel", "fs", "net"]
  const bucket = Math.floor(index / 1000).toString().padStart(5, "0")
  return `${families[index % families.length]}/${bucket}`
}

function syntheticFileText(index: number) {
  const next = Math.max(0, index - 1)
  return `
#include "synthetic_${next}.h"
#define SYNTHETIC_FEATURE_${index} ${index}
typedef unsigned int synthetic_type_${index};
struct synthetic_state_${index} { int ready; };
// synthetic benchmark module ${index} carries retrieval keyword synthetic_target_${index}
int synthetic_leaf_${index}(void) { return ${index}; }
int synthetic_target_${index}(void) { return synthetic_leaf_${index}(); }
int synthetic_entry_${index}(void) { return synthetic_target_${index}() + synthetic_target_${next}(); }
`
}

function defaultQueryTargets(files: number) {
  const last = Math.max(0, files - 1)
  return [Math.floor(last * 0.1), Math.floor(last * 0.5), Math.floor(last * 0.9), last]
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}

function roundRate(value: number, elapsedMs: number) {
  return Math.round((value / elapsedMs) * 1000 * 10) / 10
}

function heapUsed() {
  return typeof process !== "undefined" && typeof process.memoryUsage === "function" ? process.memoryUsage().heapUsed : 0
}

function runStreamingShardedBenchmark(input: { files: number; queryTargets?: number[] }): CodeGraphBenchmarkReport {
  const started = Date.now()
  const targets = input.queryTargets ?? defaultQueryTargets(input.files)
  const targetShards = new Set(targets.map((target) => syntheticModule(target)))
  const targetFiles = new Map<string, Record<string, CodeGraphFile>>()
  const heapSamples: number[] = [heapUsed()]
  const modules = new Set<string>()
  let loc = 0
  let callEdges = 0
  let symbols = 0
  let indexBytes = 0

  const parseStarted = Date.now()
  for (let index = 0; index < input.files; index++) {
    const module = syntheticModule(index)
    modules.add(module)
    const text = syntheticFileText(index)
    const file = parseCFile({
      path: `${module}/synthetic_${index}.c`,
      hash: String(index),
      size: Buffer.byteLength(text, "utf8"),
      text,
    })
    indexBytes += file.size
    loc += file.functions.reduce((sum, fn) => sum + Math.max(1, fn.endLine - fn.startLine + 1), 0)
    callEdges += file.functions.reduce((sum, fn) => sum + fn.calls.length, 0)
    symbols += 1 + file.functions.length + file.macros.length + file.types.length + file.globals.length
    if (targetShards.has(module)) {
      const shard = targetFiles.get(module) ?? Object.create(null) as Record<string, CodeGraphFile>
      shard[file.path] = file
      targetFiles.set(module, shard)
    }
    if (index % 10000 === 0) heapSamples.push(heapUsed())
  }
  const parseMs = Date.now() - parseStarted

  const indexStarted = Date.now()
  const shardIndexes = new Map<string, ReturnType<typeof hydrateCodeGraphIndex>>()
  for (const [module, files] of targetFiles) {
    shardIndexes.set(module, hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/synthetic",
      rootName: "synthetic",
      updatedAt: Date.now(),
      truncated: false,
      files,
    }))
    heapSamples.push(heapUsed())
  }
  const indexMs = Date.now() - indexStarted

  const queries = targets.map((target) => {
    const question = `impact of synthetic_target_${target}`
    const result = retrieveEvidence({
      index: shardIndexes.get(syntheticModule(target))!,
      question,
      maxBytes: 60000,
      maxDepth: 2,
      maxFanout: 40,
    })
    return {
      question,
      elapsedMs: result?.elapsedMs ?? 0,
      evidenceCount: result?.evidence.length ?? 0,
      candidateCount: result?.candidateCount ?? 0,
    }
  })
  const queryTimes = queries.map((query) => query.elapsedMs).sort((left, right) => left - right)
  const totalMs = Date.now() - started

  return {
    spec: {
      files: input.files,
      loc,
      language: "c/c++",
      languageMix: { "c/c++": input.files },
      mode: "streaming-sharded",
      moduleCount: modules.size,
      averageFileBytes: Math.round(indexBytes / Math.max(1, input.files)),
      callEdges,
      symbols,
    },
    metrics: {
      parseMs,
      indexMs,
      totalMs,
      filesPerSecond: roundRate(input.files, Math.max(1, parseMs + indexMs)),
      mbPerSecond: roundRate(indexBytes / 1024 / 1024, Math.max(1, parseMs + indexMs)),
      peakHeapBytes: Math.max(...heapSamples),
      indexBytes,
      shards: modules.size,
      queryP50Ms: percentile(queryTimes, 0.5),
      queryP95Ms: percentile(queryTimes, 0.95),
      queryP99Ms: percentile(queryTimes, 0.99),
      incrementalMs: indexMs,
      recoveryMs: indexMs,
    },
    queries,
  }
}
