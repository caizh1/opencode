import { describe, expect, test } from "bun:test"
import { StreamingStatePostScheduler, type StatePostTimerApi, type StatePostTimerHandle } from "../src/chat-state-post-scheduler"

describe("StreamingStatePostScheduler", () => {
  test("coalesces repeated streaming state posts into one scheduled callback", () => {
    const posts: string[] = []
    const timers = fakeTimerApi()
    const scheduler = new StreamingStatePostScheduler(() => posts.push("post"), 50, timers.api)

    expect(scheduler.schedule()).toBe(true)
    expect(scheduler.schedule()).toBe(false)
    expect(scheduler.pending).toBe(true)
    expect(timers.scheduled).toHaveLength(1)
    expect(timers.scheduled[0]?.delayMs).toBe(50)
    expect(posts).toHaveLength(0)

    timers.scheduled[0]?.callback()
    expect(posts).toEqual(["post"])
    expect(scheduler.pending).toBe(false)
  })

  test("flushes pending streaming state immediately for terminal events", () => {
    const posts: string[] = []
    const timers = fakeTimerApi()
    const scheduler = new StreamingStatePostScheduler(() => posts.push("post"), 50, timers.api)

    scheduler.schedule()
    expect(scheduler.flush()).toBe(true)

    expect(posts).toEqual(["post"])
    expect(scheduler.pending).toBe(false)
    expect(timers.scheduled[0]?.cleared).toBe(true)
    expect(scheduler.flush()).toBe(false)
  })

  test("clears pending streaming state without posting on dispose or immediate rerender", () => {
    const posts: string[] = []
    const timers = fakeTimerApi()
    const scheduler = new StreamingStatePostScheduler(() => posts.push("post"), 50, timers.api)

    scheduler.schedule()
    expect(scheduler.clear()).toBe(true)

    expect(posts).toHaveLength(0)
    expect(scheduler.pending).toBe(false)
    expect(timers.scheduled[0]?.cleared).toBe(true)
    expect(scheduler.clear()).toBe(false)
  })
})

type FakeTimer = {
  callback: () => void
  delayMs: number
  cleared: boolean
}

function fakeTimerApi() {
  const scheduled: FakeTimer[] = []
  const api: StatePostTimerApi = {
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false }
      scheduled.push(timer)
      return timer as unknown as StatePostTimerHandle
    },
    clearTimeout(handle) {
      ;(handle as unknown as FakeTimer).cleared = true
    },
  }
  return { api, scheduled }
}
