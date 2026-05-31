import { describe, expect, test } from "bun:test"
import { formatCodeGraphBenchmarkReport, generateSyntheticCodeGraphFiles, runCodeGraphSyntheticBenchmark } from "../src/codegraph-benchmark"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { retrieveEvidence } from "../src/codegraph-query"

describe("code graph synthetic benchmark", () => {
  test("indexes and queries a 1k-file synthetic C repository", () => {
    const startedParse = Date.now()
    const files = generateSyntheticCodeGraphFiles(1000)
    const parseMs = Date.now() - startedParse

    const startedIndex = Date.now()
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/synthetic",
      rootName: "synthetic",
      updatedAt: 1,
      truncated: false,
      files,
    })
    const indexMs = Date.now() - startedIndex

    const result = retrieveEvidence({
      index,
      question: "改 synthetic_target_777 会影响哪里",
      maxBytes: 60000,
      maxDepth: 2,
      maxFanout: 40,
    })

    expect(Object.keys(index.files)).toHaveLength(1000)
    expect(index.stats?.functions).toBeGreaterThanOrEqual(3000)
    expect(index.derived?.postingsByTerm.synthetic.length).toBeGreaterThan(0)
    expect(result?.mode).toBe("impact")
    expect(result?.evidence.some((item) => item.snippet.includes("synthetic_target_777"))).toBe(true)
    expect(result?.candidateCount).toBeGreaterThan(0)
    expect(result?.elapsedMs).toBeLessThan(1000)
    expect(parseMs + indexMs).toBeLessThan(5000)
  })

  test("emits a scale report with throughput, memory, query, incremental, and recovery metrics", () => {
    const report = runCodeGraphSyntheticBenchmark({ files: 250, queryTargets: [1, 125, 249] })
    const text = formatCodeGraphBenchmarkReport(report)

    expect(report.spec.files).toBe(250)
    expect(report.spec.mode).toBe("full-index")
    expect(report.metrics.filesPerSecond).toBeGreaterThan(0)
    expect(report.spec.loc).toBeGreaterThan(0)
    expect(report.spec.callEdges).toBeGreaterThan(0)
    expect(report.spec.symbols).toBeGreaterThan(0)
    expect(report.metrics.indexBytes).toBeGreaterThan(0)
    expect(report.metrics.queryP95Ms).toBeGreaterThanOrEqual(report.metrics.queryP50Ms)
    expect(report.metrics.recoveryMs).toBeGreaterThanOrEqual(0)
    expect(text).toContain("queryP99Ms=")
    expect(text).toContain("callEdges=")
    expect(text).toContain("incrementalMs=")
  })

  test("uses streaming sharded benchmark mode above the full-index threshold", () => {
    const report = runCodeGraphSyntheticBenchmark({ files: 1000, queryTargets: [1, 500, 999], streamingThreshold: 1 })

    expect(report.spec.mode).toBe("streaming-sharded")
    expect(report.spec.files).toBe(1000)
    expect(report.metrics.shards).toBeGreaterThan(1)
    expect(report.metrics.queryP95Ms).toBeGreaterThanOrEqual(report.metrics.queryP50Ms)
  })
})
