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
})
