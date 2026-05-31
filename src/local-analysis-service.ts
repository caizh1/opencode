import type { CodeGraphQueueStatus, CodeGraphServiceMetrics, CodeGraphState, CodeGraphStateTransition } from "./types"

export type LocalAnalysisJobKind = NonNullable<CodeGraphQueueStatus["activeJobKind"]>

export type LocalAnalysisJob = {
  id: string
  kind: LocalAnalysisJobKind
  force?: boolean
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  detail: string
  payload?: Record<string, unknown>
}

export type LocalAnalysisServiceProtocol = {
  status(): { state: CodeGraphState; detail: string }
  indexWorkspace(force: boolean): Promise<void>
  cancelIndexing(reason?: string): void
  pauseIndexing(reason?: string): void
  resumeIndexing(): void
  metrics(): CodeGraphServiceMetrics
}

export class LocalAnalysisJobQueue {
  private readonly pending: LocalAnalysisJob[] = []
  private active?: LocalAnalysisJob
  private pausedValue = false
  private cancelRequestedValue = false
  private sequence = 0
  private watcherStormCount = 0
  private queryCacheHitCount = 0
  private queryCacheMissCount = 0
  private jobsStartedCount = 0
  private jobsCompletedCount = 0
  private jobsCancelledCount = 0
  private jobsFailedCount = 0
  private lastJobElapsedMsValue: number | undefined
  private lastRecoveryElapsedMsValue: number | undefined

  enqueue(input: {
    kind: LocalAnalysisJobKind
    detail: string
    force?: boolean
    payload?: Record<string, unknown>
    replacePendingKind?: LocalAnalysisJobKind
  }) {
    if (input.replacePendingKind) {
      for (let index = this.pending.length - 1; index >= 0; index--) {
        if (this.pending[index].kind === input.replacePendingKind) this.pending.splice(index, 1)
      }
    }
    const job: LocalAnalysisJob = {
      id: `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`,
      kind: input.kind,
      detail: input.detail,
      force: input.force,
      queuedAt: Date.now(),
      payload: input.payload,
    }
    this.pending.push(job)
    return job
  }

  startNext() {
    if (this.pausedValue || this.active) return undefined
    const job = this.pending.shift()
    if (!job) return undefined
    job.startedAt = Date.now()
    this.active = job
    this.cancelRequestedValue = false
    this.jobsStartedCount++
    return job
  }

  completeActive() {
    const job = this.finishActive()
    if (!job) return undefined
    this.jobsCompletedCount++
    return job
  }

  failActive() {
    const job = this.finishActive()
    if (!job) return undefined
    this.jobsFailedCount++
    return job
  }

  cancelActive(reason = "cancelled") {
    this.cancelRequestedValue = true
    if (this.active) this.active.detail = reason
  }

  finishCancelled() {
    const job = this.finishActive()
    if (!job) return undefined
    this.jobsCancelledCount++
    this.cancelRequestedValue = false
    return job
  }

  clearPending(kind?: LocalAnalysisJobKind) {
    const before = this.pending.length
    if (!kind) {
      this.pending.splice(0)
    } else {
      for (let index = this.pending.length - 1; index >= 0; index--) {
        if (this.pending[index].kind === kind) this.pending.splice(index, 1)
      }
    }
    return before - this.pending.length
  }

  pause() {
    this.pausedValue = true
  }

  resume() {
    this.pausedValue = false
  }

  recordWatcherStorm() {
    this.watcherStormCount++
  }

  recordQueryCacheHit() {
    this.queryCacheHitCount++
  }

  recordQueryCacheMiss() {
    this.queryCacheMissCount++
  }

  recordRecovery(elapsedMs: number) {
    this.lastRecoveryElapsedMsValue = Math.max(0, elapsedMs)
  }

  hasPending() {
    return this.pending.length > 0
  }

  isPaused() {
    return this.pausedValue
  }

  isCancelRequested() {
    return this.cancelRequestedValue
  }

  snapshot(): CodeGraphQueueStatus {
    return {
      activeJobId: this.active?.id,
      activeJobKind: this.active?.kind,
      pendingJobs: this.pending.length,
      paused: this.pausedValue,
      cancelRequested: this.cancelRequestedValue,
    }
  }

  metrics(input: {
    schemaVersion: number
    serviceMode?: CodeGraphServiceMetrics["serviceMode"]
    workerThreads?: number
    workerHealthy?: boolean
    memoryDegraded?: boolean
    memoryLimitBytes?: number
    heapUsedBytes?: number
  }): CodeGraphServiceMetrics {
    return {
      serviceMode: input.serviceMode ?? "extension-host-worker",
      schemaVersion: input.schemaVersion,
      storageBackend: "json-sharded-sqlite-compatible",
      workerThreads: input.workerThreads ?? 0,
      workerHealthy: input.workerHealthy ?? false,
      jobsStarted: this.jobsStartedCount,
      jobsCompleted: this.jobsCompletedCount,
      jobsCancelled: this.jobsCancelledCount,
      jobsFailed: this.jobsFailedCount,
      watcherStorms: this.watcherStormCount,
      queryCacheHits: this.queryCacheHitCount,
      queryCacheMisses: this.queryCacheMissCount,
      memoryDegraded: input.memoryDegraded ?? false,
      memoryLimitBytes: input.memoryLimitBytes,
      heapUsedBytes: input.heapUsedBytes,
      lastJobElapsedMs: this.lastJobElapsedMsValue,
      lastRecoveryElapsedMs: this.lastRecoveryElapsedMsValue,
    }
  }

  private finishActive() {
    const job = this.active
    if (!job) return undefined
    job.finishedAt = Date.now()
    this.lastJobElapsedMsValue = Math.max(0, job.finishedAt - (job.startedAt ?? job.queuedAt))
    if (job.kind === "recovery") this.lastRecoveryElapsedMsValue = this.lastJobElapsedMsValue
    this.active = undefined
    return job
  }
}

export function recordStateTransition(
  transitions: CodeGraphStateTransition[],
  next: CodeGraphState,
  detail: string,
  limit = 25,
) {
  const previous = transitions[transitions.length - 1]
  if (previous?.state === next && previous.detail === detail) return transitions
  transitions.push({ state: next, detail, at: Date.now() })
  if (transitions.length > limit) transitions.splice(0, transitions.length - limit)
  return transitions
}
