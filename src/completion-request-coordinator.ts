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
  cacheMetadata?: CompletionRequestCacheMetadata
  localFallback?: CompletionEdit
  validateEdit?: (edit: CompletionEdit) => CompletionEditCacheValidation
  runRemote: (signal: AbortSignal) => Promise<CompletionRequestOutcome>
  onRemoteReady?: () => boolean | void
}

export type CompletionRequestCacheMetadata = {
  documentUri: string
  languageId: string
  line: number
  position: {
    line: number
    character: number
  }
  linePrefix: string
  firstSuffixLine: string
  planKind: string
  sourceComment?: string
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

type CachedCompletionEdit = {
  edit: CompletionEdit
  metadata?: CompletionRequestCacheMetadata
}

export class CompletionRequestCoordinator {
  private pending?: PendingRequest
  private readonly cache = new Map<CompletionRequestKey, CachedCompletionEdit>()
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
      const validation = this.validateEdit(input, cached.edit)
      if (validation.status === "rejected") {
        this.cache.delete(input.key)
        this.logInfo(`cache-invalid reason=${validation.reason} ${input.details}`)
      } else {
        this.cache.set(input.key, {
          edit: validation.edit,
          metadata: input.cacheMetadata ?? cached.metadata,
        })
        this.logInfo(`cache-hit-exact ${input.details}`)
        return {
          immediate: {
            status: "ok",
            edit: validation.edit,
            source: "cache",
          },
        }
      }
    }

    const compatible = this.compatibleCachedEdit(input)
    if (compatible) {
      const validation = this.validateEdit(input, compatible.edit)
      if (validation.status === "rejected") {
        this.cache.delete(compatible.key)
        this.logInfo(`cache-compatible-invalid reason=${validation.reason} ${input.details}`)
      } else {
        this.cache.set(input.key, {
          edit: validation.edit,
          metadata: input.cacheMetadata,
        })
        this.logInfo(`cache-hit-compatible ${input.details}`)
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
          this.cache.delete(input.key)
          this.logInfo(`cache-skip-invalid reason=${validation.reason} ${input.details}`)
          return {
            status: "rejected",
            reason: validation.reason,
            source: "remote",
          }
        }
        this.cache.set(input.key, {
          edit: validation.edit,
          metadata: input.cacheMetadata,
        })
        this.trimCache()
        const remoteReady = input.onRemoteReady?.()
        if (remoteReady === true) {
          this.logInfo(`remote-ready-compatible ${input.details}`)
        } else if (remoteReady === false) {
          this.logInfo(`remote-ready-stale ${input.details}`)
        }
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

  private compatibleCachedEdit(input: CompletionRequestCoordinatorInput): { key: CompletionRequestKey; edit: CompletionEdit } | undefined {
    if (!input.cacheMetadata) return
    for (const [key, cached] of this.cache) {
      if (key === input.key) continue
      if (!cached.metadata) continue
      const edit = adaptCompatibleCachedEdit(cached.edit, cached.metadata, input.cacheMetadata)
      if (edit) return { key, edit }
    }
    return undefined
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

function adaptCompatibleCachedEdit(
  edit: CompletionEdit,
  cached: CompletionRequestCacheMetadata,
  current: CompletionRequestCacheMetadata,
): CompletionEdit | undefined {
  if (!isCompatibleCacheMetadata(cached, current)) return
  const typed = current.linePrefix.slice(cached.linePrefix.length)
  if (!typed) return edit

  if (!edit.replaceRange || isZeroWidthRangeAtPosition(edit.replaceRange, cached.position)) {
    if (!edit.insertText.startsWith(typed)) return
    return {
      ...edit,
      insertText: edit.insertText.slice(typed.length),
      replaceRange: zeroWidthRangeAtPosition(current.position),
      ...(edit.filterText?.startsWith(typed) ? { filterText: edit.filterText.slice(typed.length) } : {}),
    }
  }

  if (edit.replaceRange &&
    edit.replaceRange.startLine === cached.position.line &&
    edit.replaceRange.endLine === cached.position.line &&
    edit.replaceRange.endCharacter === cached.position.character) {
    return {
      ...edit,
      replaceRange: {
        ...edit.replaceRange,
        endCharacter: current.position.character,
      },
    }
  }

  return undefined
}

function isCompatibleCacheMetadata(cached: CompletionRequestCacheMetadata, current: CompletionRequestCacheMetadata) {
  if (cached.documentUri !== current.documentUri) return false
  if (cached.languageId !== current.languageId) return false
  if (cached.line !== current.line) return false
  if (cached.position.line !== current.position.line) return false
  if (current.position.character < cached.position.character) return false
  if (!current.linePrefix.startsWith(cached.linePrefix)) return false
  if (cached.firstSuffixLine !== current.firstSuffixLine) return false
  if (cached.planKind !== current.planKind) return false
  if ((cached.sourceComment ?? "") !== (current.sourceComment ?? "")) return false
  return true
}

function isZeroWidthRangeAtPosition(
  range: CompletionEdit["replaceRange"],
  position: CompletionRequestCacheMetadata["position"],
) {
  return Boolean(range) &&
    range?.startLine === position.line &&
    range.endLine === position.line &&
    range.startCharacter === position.character &&
    range.endCharacter === position.character
}

function zeroWidthRangeAtPosition(position: CompletionRequestCacheMetadata["position"]) {
  return {
    startLine: position.line,
    startCharacter: position.character,
    endLine: position.line,
    endCharacter: position.character,
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
