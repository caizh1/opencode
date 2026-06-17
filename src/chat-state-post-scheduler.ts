export type StatePostTimerHandle = ReturnType<typeof setTimeout>

export type StatePostTimerApi = {
  setTimeout(callback: () => void, delayMs: number): StatePostTimerHandle
  clearTimeout(handle: StatePostTimerHandle): void
}

const defaultTimerApi: StatePostTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

export class StreamingStatePostScheduler {
  private timer?: StatePostTimerHandle

  constructor(
    private readonly post: () => void,
    private readonly delayMs: number,
    private readonly timers: StatePostTimerApi = defaultTimerApi,
  ) {}

  get pending() {
    return Boolean(this.timer)
  }

  schedule() {
    if (this.timer) return false
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      this.post()
    }, this.delayMs)
    return true
  }

  flush() {
    if (!this.timer) return false
    const timer = this.timer
    this.timer = undefined
    this.timers.clearTimeout(timer)
    this.post()
    return true
  }

  clear() {
    if (!this.timer) return false
    const timer = this.timer
    this.timer = undefined
    this.timers.clearTimeout(timer)
    return true
  }
}
