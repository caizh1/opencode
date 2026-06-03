import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("code graph query observability", () => {
  const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "codegraph-service.ts"), "utf8")
  const querySource = readFileSync(join(import.meta.dir, "..", "src", "codegraph-query.ts"), "utf8")

  test("logs query metrics to the output channel", () => {
    expect(serviceSource).toContain("[codegraph-query]")
    expect(serviceSource).toContain("formatCodeGraphQueryMetrics(context.metrics)")
    expect(serviceSource).toContain("candidates=")
    expect(serviceSource).toContain("elapsed=")
  })

  test("auto-starts background indexing and exposes a send readiness gate", () => {
    expect(serviceSource).toContain("async maybePromptAndIndex()")
    expect(serviceSource).toContain("void this.indexWorkspace(false)")
    expect(serviceSource).toContain("async waitForReady()")
    expect(serviceSource).toContain("private async runQueuedIndexJobs")
    expect(serviceSource).toContain("class WorkBudget")
  })

  test("keeps large indexes lazy-loadable and durable across job recovery", () => {
    expect(serviceSource).toContain("LARGE_INDEX_LAZY_FILE_THRESHOLD")
    expect(serviceSource).toContain("private async activeIndexForQuestion")
    expect(serviceSource).toContain("private async loadShardFiles")
    expect(serviceSource).toContain("private async saveJobCheckpoint")
    expect(serviceSource).toContain("checkpoint.json")
  })

  test("returns retrieval metrics with prompt context", () => {
    expect(querySource).toContain("metricsForResult(result")
    expect(querySource).toContain("candidateCount")
    expect(querySource).toContain("packedBytes")
    expect(querySource).toContain("elapsedMs")
  })

  test("separates lightweight RAG probes from vector index rebuilds", () => {
    expect(serviceSource).toContain("async testRagConfiguration()")
    expect(serviceSource).toContain("private async probeRagConfiguration()")
    expect(serviceSource).toContain("private async rebuildRagIndex")
    expect(serviceSource).toContain("ragProbeInFlight")
    expect(serviceSource).toContain("ragIndexInFlight")
    expect(serviceSource).toContain("availability: \"not-indexed\"")
    expect(serviceSource).toContain("[rag-index] embedding")
  })

  test("schedules automatic RAG index resume after recoverable pauses", () => {
    expect(serviceSource).toContain("private ragResumeTimer")
    expect(serviceSource).toContain("private ragResumeInFlight")
    expect(serviceSource).toContain("private async scheduleRagIndexResumeFromStatus")
    expect(serviceSource).toContain("private async runRagIndexResume")
    expect(serviceSource).toContain("reason !== \"request-budget\" && reason !== \"rate-limit\"")
    expect(serviceSource).toContain("[rag-index] resume scheduled")
    expect(serviceSource).toContain("[rag-index] auto resume starting")
    expect(serviceSource).toContain("resumeScheduledAt")
  })
})
