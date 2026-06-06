import { describe, expect, test } from "bun:test"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "../src/completion-request-coordinator"

const editOutcome: CompletionRequestOutcome = {
  status: "ok",
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

    expect(await stale.pending).toEqual({ status: "rejected", reason: "stale-key", source: "remote" })
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
            signal.addEventListener("abort", () => resolve({ status: "rejected", reason: "aborted", source: "remote" }), { once: true })
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
    expect(await stale.pending).toEqual({ status: "rejected", reason: "aborted", source: "remote" })
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
      status: "ok",
      edit: editOutcome.edit,
      source: "cache",
    })
  })

  test("returns compatible cached edits when the current prefix extends the original request", async () => {
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })
    const first = coordinator.request({
      key: "line:r",
      details: "line=1 character=5",
      debounceMs: 0,
      cacheMetadata: cacheMetadata({
        linePrefix: "    r",
        character: 5,
        firstSuffixLine: "return 0;",
      }),
      runRemote: async () => ({
        status: "ok",
        edit: {
          insertText: "req",
          replaceRange: {
            startLine: 0,
            startCharacter: 4,
            endLine: 0,
            endCharacter: 5,
          },
          filterText: "req",
        },
        source: "remote",
      }),
    })
    await first.pending

    const second = coordinator.request({
      key: "line:re",
      details: "line=1 character=6",
      debounceMs: 0,
      cacheMetadata: cacheMetadata({
        linePrefix: "    re",
        character: 6,
        firstSuffixLine: "return 0;",
      }),
      validateEdit: (edit) => edit.replaceRange?.endCharacter === 6
        ? { status: "ok", edit }
        : { status: "rejected", reason: "rangeText-not-prefix-of-filterText" },
      runRemote: async () => {
        throw new Error("compatible cache should avoid a remote request")
      },
    })

    expect(second.immediate).toEqual({
      status: "ok",
      edit: {
        insertText: "req",
        replaceRange: {
          startLine: 0,
          startCharacter: 4,
          endLine: 0,
          endCharacter: 6,
        },
        filterText: "req",
      },
      source: "cache",
    })
    expect(logs).toContain("cache-hit-compatible line=1 character=6")
  })

  test("does not reuse compatible cache when the suffix line changes", async () => {
    let requests = 0
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
    })
    const first = coordinator.request({
      key: "line:r",
      details: "line=1 character=5",
      debounceMs: 0,
      cacheMetadata: cacheMetadata({
        linePrefix: "    r",
        character: 5,
        firstSuffixLine: "return 0;",
      }),
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
    })
    await first.pending

    const second = coordinator.request({
      key: "line:re-different-suffix",
      details: "line=1 character=6",
      debounceMs: 0,
      cacheMetadata: cacheMetadata({
        linePrefix: "    re",
        character: 6,
        firstSuffixLine: "return ret;",
      }),
      runRemote: async () => {
        requests += 1
        return {
          status: "ok",
          edit: {
            insertText: "return ret;",
          },
          source: "remote",
        }
      },
    })

    expect(second.immediate).toBeUndefined()
    expect(await second.pending).toMatchObject({
      status: "ok",
      source: "remote",
    })
    expect(requests).toBe(2)
  })

  test("logs whether remote ready refreshes are compatible or stale", async () => {
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const compatible = coordinator.request({
      key: "compatible",
      details: "line=1 character=5",
      debounceMs: 0,
      runRemote: async () => editOutcome,
      onRemoteReady: () => true,
    })
    await compatible.pending

    const stale = coordinator.request({
      key: "stale",
      details: "line=1 character=6",
      debounceMs: 0,
      runRemote: async () => editOutcome,
      onRemoteReady: () => false,
    })
    await stale.pending

    expect(logs).toContain("remote-ready-compatible line=1 character=5")
    expect(logs).toContain("remote-ready-stale line=1 character=6")
  })

  test("invalidates cached edits that no longer satisfy inline display invariants", async () => {
    let requests = 0
    let validations = 0
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
      validateEdit: (edit) => {
        validations += 1
        return validations === 1
          ? {
              status: "rejected",
              reason: "rangeText-not-prefix-of-filterText",
            }
          : {
              status: "ok",
              edit,
            }
      },
      runRemote: async () => {
        requests += 1
        return {
          status: "ok",
          edit: {
            insertText: "return 2;",
          },
          source: "remote",
        }
      },
    })

    expect(second.immediate).toBeUndefined()
    expect(await second.pending).toEqual({
      status: "ok",
      edit: {
        insertText: "return 2;",
      },
      source: "remote",
    })
    expect(requests).toBe(2)
    expect(logs).toContain("cache-invalid reason=rangeText-not-prefix-of-filterText line=1")
  })

  test("rejects invalid remote edits without returning, caching, or refreshing them", async () => {
    let requests = 0
    let refreshes = 0
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
        status: "rejected",
        reason: "selectedCompletionInfo-range-mismatch",
      }),
      runRemote: async () => {
        requests += 1
        return editOutcome
      },
      onRemoteReady: () => {
        refreshes += 1
      },
    })
    expect(await first.pending).toEqual({
      status: "rejected",
      reason: "selectedCompletionInfo-range-mismatch",
      source: "remote",
    })

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
    expect(refreshes).toBe(0)
    expect(logs).toContain("cache-skip-invalid reason=selectedCompletionInfo-range-mismatch line=1")
  })

  test("clears same-key cache when a remote edit is rejected during validation", async () => {
    let requests = 0
    let rejectRemote = false
    const logs: string[] = []
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const first = coordinator.request({
      key: "same-key",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => {
        requests += 1
        return {
          status: "ok",
          edit: {
            insertText: "return cached;",
          },
          source: "remote",
        }
      },
    })
    await first.pending

    const second = coordinator.request({
      key: "same-key",
      details: "line=1",
      debounceMs: 0,
      validateEdit: (edit) => {
        if (edit.insertText === "return cached;") {
          return {
            status: "rejected",
            reason: "quality:C parse/compile",
          }
        }
        if (rejectRemote) {
          return {
            status: "rejected",
            reason: "quality:placeholder",
          }
        }
        return {
          status: "ok",
          edit,
        }
      },
      runRemote: async () => {
        requests += 1
        rejectRemote = true
        return {
          status: "ok",
          edit: {
            insertText: "return rejected;",
          },
          source: "remote",
        }
      },
    })

    expect(second.immediate).toBeUndefined()
    expect(await second.pending).toEqual({
      status: "rejected",
      reason: "quality:placeholder",
      source: "remote",
    })

    rejectRemote = false
    const third = coordinator.request({
      key: "same-key",
      details: "line=1",
      debounceMs: 0,
      runRemote: async () => {
        requests += 1
        return {
          status: "ok",
          edit: {
            insertText: "return fresh;",
          },
          source: "remote",
        }
      },
    })

    expect(third.immediate).toBeUndefined()
    expect(await third.pending).toEqual({
      status: "ok",
      edit: {
        insertText: "return fresh;",
      },
      source: "remote",
    })
    expect(requests).toBe(3)
    expect(logs).toContain("cache-invalid reason=quality:C parse/compile line=1")
    expect(logs).toContain("cache-skip-invalid reason=quality:placeholder line=1")
  })

  test("validates local fallback edits before returning them", async () => {
    const logs: string[] = []
    let validations = 0
    const coordinator = new CompletionRequestCoordinator({
      delay: () => Promise.resolve(),
      logInfo: (message) => logs.push(message),
    })

    const start = coordinator.request({
      key: "fallback",
      details: "line=1",
      debounceMs: 0,
      localFallback: {
        insertText: "`bad c`",
      },
      validateEdit: (edit) => {
        validations += 1
        return validations === 1
          ? {
              status: "rejected",
              reason: "quality:markdown/explanation",
            }
          : {
              status: "ok",
              edit,
            }
      },
      runRemote: async () => editOutcome,
    })

    expect(start.immediate).toBeUndefined()
    expect(logs).toContain("local-fallback-invalid reason=quality:markdown/explanation line=1")
    expect(await start.pending).toEqual(editOutcome)
  })
})

function cacheMetadata(input: {
  linePrefix: string
  character: number
  firstSuffixLine: string
}) {
  return {
    documentUri: "file:///workspace/src/driver.c",
    languageId: "c",
    line: 0,
    position: {
      line: 0,
      character: input.character,
    },
    linePrefix: input.linePrefix,
    firstSuffixLine: input.firstSuffixLine,
    planKind: "ordinary-code",
    sourceComment: "",
  }
}
