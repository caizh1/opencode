import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("code graph query observability", () => {
  const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "codegraph-service.ts"), "utf8")
  const querySource = readFileSync(join(import.meta.dir, "..", "src", "codegraph-query.ts"), "utf8")
  const typesSource = readFileSync(join(import.meta.dir, "..", "src", "types.ts"), "utf8")

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
    expect(serviceSource).toContain("async refreshRagConfiguration()")
    expect(serviceSource).toContain("await this.testRagConfiguration()")
    expect(serviceSource).toContain("private async probeRagConfiguration()")
    expect(serviceSource).toContain("private async rebuildRagIndex")
    expect(serviceSource).toContain("async applyRagConfiguration()")
    expect(serviceSource).toContain("ragProbeInFlight")
    expect(serviceSource).toContain("ragIndexInFlight")
    expect(serviceSource).toContain("pendingRagRefresh")
    expect(serviceSource).toContain("pendingRagResumeTrigger")
    expect(serviceSource).toContain("private isCodeGraphReadyForRag()")
    expect(serviceSource).toContain("private suspendRagWorkForCodeGraphIndexing")
    expect(serviceSource).toContain("this.abortRagIndex(\"RAG configuration changed\")")
    expect(serviceSource).toContain("this.ragIndex.sourceIndexUpdatedAt === this.index?.updatedAt")
    expect(serviceSource).toContain("runPendingRagRefreshWhenReady(\"RAG configuration changed\"")
    expect(serviceSource).toContain("Waiting for local code graph indexing before RAG rebuild.")
    expect(serviceSource).toContain("availability: \"not-indexed\"")
    expect(serviceSource).toContain("availability: \"indexing\"")
    expect(serviceSource).toContain("private setAbortedRagIndexStatus")
    expect(serviceSource).toContain("this.setAbortedRagIndexStatus(policy.kind, rerankProbe, message)")
    expect(serviceSource).toContain("RAG vector index build was interrupted before vectors were saved")
    expect(serviceSource).toContain("[rag-index] embedding")
    expect(serviceSource).toContain("chunks=${event.embeddedChunks}/${event.chunks}")
    expect(serviceSource).toContain("requestSec=${formatSeconds(event.elapsedMs)}")
    expect(serviceSource).toContain("embeddingRequestSec=${formatSeconds(event.embeddingElapsedMs)}")
    expect(typesSource).toContain('"checking" | "indexing"')
    expect(typesSource).toContain("export type RagIndexProgress")
  })

  test("marks code graph ready before scheduling dependent RAG rebuilds", () => {
    const fullStart = serviceSource.indexOf("private async runIndex")
    const fullEnd = serviceSource.indexOf("private startWatcher", fullStart)
    const fullBody = serviceSource.slice(fullStart, fullEnd)
    expect(fullBody.indexOf("this.setReadyStatus(\"Local C/C++ code graph is ready.\")")).toBeGreaterThan(-1)
    expect(fullBody.indexOf("this.suspendRagWorkForCodeGraphIndexing(\"full code graph indexing started\")")).toBeGreaterThan(-1)
    expect(fullBody.indexOf("this.scheduleRagRefreshAfterCodeGraphReady()")).toBeGreaterThan(-1)
    expect(fullBody.indexOf("this.setReadyStatus(\"Local C/C++ code graph is ready.\")")).toBeLessThan(fullBody.indexOf("this.scheduleRagRefreshAfterCodeGraphReady()"))

    const incrementalStart = serviceSource.indexOf("private async runIncrementalIndex")
    const incrementalEnd = serviceSource.indexOf("private async setEnabled", incrementalStart)
    const incrementalBody = serviceSource.slice(incrementalStart, incrementalEnd)
    expect(incrementalBody.indexOf("this.setReadyStatus(\"Local C/C++ code graph is ready after incremental update.\")")).toBeGreaterThan(-1)
    expect(incrementalBody.indexOf("this.suspendRagWorkForCodeGraphIndexing(\"incremental code graph indexing started\")")).toBeGreaterThan(-1)
    expect(incrementalBody.indexOf("this.scheduleRagRefreshAfterCodeGraphReady(changes.map")).toBeGreaterThan(-1)
    expect(incrementalBody.indexOf("this.setReadyStatus(\"Local C/C++ code graph is ready after incremental update.\")")).toBeLessThan(incrementalBody.indexOf("this.scheduleRagRefreshAfterCodeGraphReady(changes.map"))
  })

  test("schedules automatic RAG index resume after recoverable pauses", () => {
    expect(serviceSource).toContain("private ragResumeTimer")
    expect(serviceSource).toContain("private ragResumeInFlight")
    expect(serviceSource).toContain("private schedulePendingRagWorkAfterCodeGraphReady")
    expect(serviceSource).toContain("private async scheduleRagIndexResumeFromStatus")
    expect(serviceSource).toContain("private async runRagIndexResume")
    expect(serviceSource).toContain("this.schedulePendingRagWorkAfterCodeGraphReady(\"code graph loaded\")")
    expect(serviceSource).toContain("this.pendingRagResumeTrigger = trigger")
    expect(serviceSource).toContain("auto resume deferred until code graph is ready")
    expect(serviceSource).toContain("reason !== \"request-budget\" && reason !== \"rate-limit\"")
    expect(serviceSource).toContain("[rag-index] resume scheduled")
    expect(serviceSource).toContain("[rag-index] auto resume starting")
    expect(serviceSource).toContain("resumeScheduledAt")
  })
})
