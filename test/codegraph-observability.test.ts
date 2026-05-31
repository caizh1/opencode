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
    expect(serviceSource).toContain("private async runIndexTask")
    expect(serviceSource).toContain("class WorkBudget")
  })

  test("returns retrieval metrics with prompt context", () => {
    expect(querySource).toContain("metricsForResult(result")
    expect(querySource).toContain("candidateCount")
    expect(querySource).toContain("packedBytes")
    expect(querySource).toContain("elapsedMs")
  })
})
