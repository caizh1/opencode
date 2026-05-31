import { describe, expect, test } from "bun:test"
import { LocalAnalysisJobQueue, recordStateTransition } from "../src/local-analysis-service"

describe("local analysis service queue", () => {
  test("tracks queued, active, paused, cancelled, and completed jobs", () => {
    const queue = new LocalAnalysisJobQueue()
    queue.enqueue({ kind: "full-index", detail: "full" })
    queue.enqueue({ kind: "incremental-index", detail: "incremental" })

    expect(queue.snapshot().pendingJobs).toBe(2)
    const active = queue.startNext()
    expect(active?.kind).toBe("full-index")
    expect(queue.snapshot().activeJobKind).toBe("full-index")
    expect(queue.snapshot().pendingJobs).toBe(1)

    queue.pause()
    expect(queue.snapshot().paused).toBe(true)
    queue.resume()
    queue.cancelActive("test cancel")
    expect(queue.snapshot().cancelRequested).toBe(true)
    queue.finishCancelled()

    const next = queue.startNext()
    expect(next?.kind).toBe("incremental-index")
    queue.completeActive()

    const metrics = queue.metrics({ schemaVersion: 1, serviceMode: "worker-thread-pool", workerThreads: 2, workerHealthy: true })
    expect(metrics.jobsStarted).toBe(2)
    expect(metrics.jobsCompleted).toBe(1)
    expect(metrics.jobsCancelled).toBe(1)
    expect(metrics.storageBackend).toBe("json-sharded-sqlite-compatible")
    expect(metrics.serviceMode).toBe("worker-thread-pool")
    expect(metrics.workerThreads).toBe(2)
    expect(metrics.memoryDegraded).toBe(false)
  })

  test("records bounded state transitions", () => {
    const transitions = recordStateTransition([], "indexingFull", "start", 3)
    recordStateTransition(transitions, "indexingIncremental", "incremental", 3)
    recordStateTransition(transitions, "ready", "done", 3)
    recordStateTransition(transitions, "degraded", "stale", 3)

    expect(transitions.map((item) => item.state)).toEqual(["indexingIncremental", "ready", "degraded"])
    expect(transitions.every((item) => item.at > 0)).toBe(true)
  })
})
