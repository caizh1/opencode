import { describe, expect, test } from "bun:test"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "../src/completion-request-coordinator"

const editOutcome: CompletionRequestOutcome = {
  edit: {
    insertText: "return 1;",
  },
  source: "remote",
}

describe("completion request coordinator", () => {
  test("reuses pending work for repeated requests with the same key", async () => {
    let requests = 0
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const first = coordinator.request({
      key: "same",
      details: "line=1",
      debounceMs: 850,
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })
    const second = coordinator.request({
      key: "same",
      details: "line=1",
      debounceMs: 850,
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })

    expect(await first.pending).toEqual(editOutcome)
    expect(await second.pending).toEqual(editOutcome)
    expect(requests).toBe(1)
    expect(logs).toContain("reuse-pending line=1")
  })

  test("cancels scheduled work when a new key arrives", async () => {
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: (_ms, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
      logInfo: (message) => logs.push(message),
    })

    const stale = coordinator.request({
      key: "old",
      details: "line=1",
      debounceMs: 850,
      runRemote: async () => editOutcome,
    })
    coordinator.request({
      key: "new",
      details: "line=2",
      debounceMs: 850,
      runRemote: async () => editOutcome,
    })

    expect(await stale.pending).toEqual({ reason: "stale-key", source: "remote" })
    expect(logs).toContain("cancelled reason=stale-key phase=scheduled line=1")
  })

  test("aborts in-flight remote work when a new key arrives", async () => {
    let firstSignal: AbortSignal | undefined
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const stale = coordinator.request({
      key: "old",
      details: "line=1",
      debounceMs: 0,
      runRemote: (signal) => {
        firstSignal = signal
        return new Promise<CompletionRequestOutcome>((resolve) => {
          signal.addEventListener("abort", () => resolve({ reason: "aborted", source: "remote" }), { once: true })
        })
      },
    })

    await Promise.resolve()
    coordinator.request({
      key: "new",
      details: "line=2",
      debounceMs: 0,
      runRemote: async () => editOutcome,
    })

    expect(firstSignal?.aborted).toBe(true)
    expect(await stale.pending).toEqual({ reason: "aborted", source: "remote" })
    expect(logs).toContain("cancelled reason=stale-key phase=request line=1")
  })

  test("returns cached remote edits immediately after a request completes", async () => {
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
    })

    const first = coordinator.request({
      key: "cached",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => editOutcome,
    })
    await first.pending

    const second = coordinator.request({
      key: "cached",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => {
        throw new Error("should not run")
      },
    })

    expect(second.immediate).toEqual({
      edit: editOutcome.edit,
      source: "cache",
    })
  })

  test("invalidates cached edits that no longer satisfy inline display invariants", async () => {
    let requests = 0
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const first = coordinator.request({
      key: "cached",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })
    await first.pending

    const second = coordinator.request({
      key: "cached",
      details: "line=1",
      debounceMs: 0,
      validateEdit: () => ({
        valid: false,
        reason: "filterText-not-prefix-of-insertText",
      }),
      runRemote: async () => {
        requests += 1
        return {
          edit: {
            insertText: "return 2;",
          },
          source: "remote",
        }
      },
    })

    expect(second.immediate).toBeUndefined()
    expect(await second.pending).toEqual({
      edit: {
        insertText: "return 2;",
      },
      source: "remote",
    })
    expect(requests).toBe(2)
    expect(logs).toContain("cache-invalid reason=filterText-not-prefix-of-insertText line=1")
  })

  test("does not save invalid remote edits into the cache", async () => {
    let requests = 0
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const first = coordinator.request({
      key: "bad-edit",
      details: "line=1",
      debounceMs: 0,
      validateEdit: () => ({
        valid: false,
        reason: "selectedCompletionInfo-range-mismatch",
      }),
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })
    await first.pending

    const second = coordinator.request({
      key: "bad-edit",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })
    await second.pending

    expect(second.immediate).toBeUndefined()
    expect(requests).toBe(2)
    expect(logs).toContain("cache-skip-invalid reason=selectedCompletionInfo-range-mismatch line=1")
  })
})
