import type { CompletionEdit } from "./completion-edit"

export type CompletionRequestKey = string

export type CompletionRequestSource = "cache" | "local-fallback" | "remote"

export type CompletionRequestOutcome =
  | {
      status: "ok"
      edit: CompletionEdit
      source: CompletionRequestSource
    }
  | {
      status: "rejected"
      edit?: undefined
      reason: string
      source: "remote"
    }

export type CompletionRequestStart = {
  immediate?: CompletionRequestOutcome
  pending?: Promise<CompletionRequestOutcome>
}

type CompletionRequestCoordinatorInput = {
  key: CompletionRequestKey
  details: string
  debounceMs: number
  localFallback?: CompletionEdit
  validateEdit?: (edit: CompletionEdit) => CompletionEditCacheValidation
  runRemote: (signal: AbortSignal) => Promise<CompletionRequestOutcome>
  onRemoteReady?: () => void
}

type CompletionEditCacheValidation =
  | { status: "ok"; edit: CompletionEdit; reason?: never }
  | { status: "rejected"; reason: string; edit?: undefined }

type CompletionRequestCoordinatorOptions = {
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  logInfo?: (message: string) => void
  maxCacheSize?: number
}

type PendingRequest = {
  key: CompletionRequestKey
  details: string
  controller: AbortController
  promise: Promise<CompletionRequestOutcome>
  phase: "scheduled" | "request"
  cancelReason?: string
}

export class CompletionRequestCoordinator {
  private pending?: PendingRequest
  private readonly cache = new Map<CompletionRequestKey, CompletionEdit>()
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly logInfo: (message: string) => void
  private readonly maxCacheSize: number

  constructor(options: CompletionRequestCoordinatorOptions = {}) {
    this.delay = options.delay ?? delayWithSignal
    this.logInfo = options.logInfo ?? (() => undefined)
    this.maxCacheSize = options.maxCacheSize ?? 100
  }

  request(input: CompletionRequestCoordinatorInput): CompletionRequestStart {
    const cached = this.cache.get(input.key)
    if (cached) {
      const validation = this.validateEdit(input, cached)
      if (validation.status === "rejected") {
        this.cache.delete(input.key)
        this.logInfo(`cache-invalid reason=${validation.reason} ${input.details}`)
      } else {
        this.cache.set(input.key, validation.edit)
        return {
          immediate: {
            status: "ok",
            edit: validation.edit,
            source: "cache",
          },
        }
      }
    }

    if (this.pending?.key === input.key) {
      this.logInfo(`reuse-pending ${input.details}`)
      return {
        immediate: this.localFallbackOutcome(input),
        pending: this.pending.promise,
      }
    }

    this.cancelPending("stale-key")

    const pending = this.createPendingRequest(input)
    this.pending = pending
    this.logInfo(`scheduled ${input.details}`)

    return {
      immediate: this.localFallbackOutcome(input),
      pending: pending.promise,
    }
  }

  clear() {
    this.cancelPending("clear")
    this.cache.clear()
  }

  private createPendingRequest(input: CompletionRequestCoordinatorInput): PendingRequest {
    const controller = new AbortController()
    const pending: PendingRequest = {
      key: input.key,
      details: input.details,
      controller,
      promise: Promise.resolve({ status: "rejected", reason: "not-started", source: "remote" }),
      phase: "scheduled",
    }
    pending.promise = this.runPending(input, pending)
    return pending
  }

  private async runPending(
    input: CompletionRequestCoordinatorInput,
    pending: PendingRequest,
  ): Promise<CompletionRequestOutcome> {
    try {
      await this.delay(input.debounceMs, pending.controller.signal)
      if (pending.controller.signal.aborted) {
        return { status: "rejected", reason: pending.cancelReason ?? "cancelled", source: "remote" }
      }

      pending.phase = "request"
      const outcome = await input.runRemote(pending.controller.signal)
      if (outcome.status === "ok") {
        const validation = this.validateEdit(input, outcome.edit)
        if (validation.status === "rejected") {
          this.logInfo(`cache-skip-invalid reason=${validation.reason} ${input.details}`)
          return {
            status: "rejected",
            reason: validation.reason,
            source: "remote",
          }
        }
        this.cache.set(input.key, validation.edit)
        this.trimCache()
        if (this.pending === pending) input.onRemoteReady?.()
        return {
          status: "ok",
          edit: validation.edit,
          source: outcome.source,
        }
      }
      return outcome
    } catch (error) {
      if (pending.controller.signal.aborted || error instanceof CompletionRequestAbortError) {
        return { status: "rejected", reason: pending.cancelReason ?? "cancelled", source: "remote" }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.logInfo(`failed reason=coordinator-error message="${quoteLogValue(message)}" ${input.details}`)
      return { status: "rejected", reason: "coordinator-error", source: "remote" }
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  private localFallbackOutcome(input: CompletionRequestCoordinatorInput): CompletionRequestOutcome | undefined {
    if (!input.localFallback) return undefined
    const validation = this.validateEdit(input, input.localFallback)
    if (validation.status === "rejected") {
      this.logInfo(`local-fallback-invalid reason=${validation.reason} ${input.details}`)
      return undefined
    }
    return {
      status: "ok",
      edit: validation.edit,
      source: "local-fallback",
    }
  }

  private validateEdit(input: CompletionRequestCoordinatorInput, edit: CompletionEdit): CompletionEditCacheValidation {
    return input.validateEdit?.(edit) ?? {
      status: "ok",
      edit,
    }
  }

  private cancelPending(reason: string) {
    if (!this.pending) return
    this.pending.cancelReason = reason
    this.pending.controller.abort()
    this.logInfo(`cancelled reason=${reason} phase=${this.pending.phase} ${this.pending.details}`)
  }

  private trimCache() {
    while (this.cache.size > this.maxCacheSize) {
      const first = this.cache.keys().next().value
      if (!first) return
      this.cache.delete(first)
    }
  }
}

class CompletionRequestAbortError extends Error {}

function delayWithSignal(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new CompletionRequestAbortError())
  if (ms <= 0) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CompletionRequestAbortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function quoteLogValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
