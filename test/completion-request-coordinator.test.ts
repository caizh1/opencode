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
})
