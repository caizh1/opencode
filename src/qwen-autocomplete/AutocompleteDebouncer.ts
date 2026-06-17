type Timer = ReturnType<typeof setTimeout>

export type DebounceTimers = {
  set(callback: () => void, ms: number): Timer
  clear(timer: Timer): void
}

const real: DebounceTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer),
}

type Pending = {
  timer: Timer
  resolve(value: boolean): void
}

export class AutocompleteDebouncer {
  private current: string | undefined
  private pending: Pending | undefined
  private seq = 0

  constructor(private readonly timers: DebounceTimers = real) {}

  delayAndShouldDebounce(ms: number): Promise<boolean> {
    const id = `qwen-debounce-${++this.seq}`
    this.current = id
    this.skipPending()

    if (ms <= 0) {
      this.current = undefined
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      const timer = this.timers.set(() => {
        if (this.pending?.timer === timer) {
          this.pending = undefined
        }

        const skip = this.current !== id
        if (!skip) {
          this.current = undefined
        }

        resolve(skip)
      }, ms)
      this.pending = { timer, resolve }
    })
  }

  dispose(): void {
    this.skipPending()
    this.current = undefined
  }

  private skipPending(): void {
    const item = this.pending
    if (!item) return

    this.timers.clear(item.timer)
    this.pending = undefined
    // qwen-direct lifecycle safety adaptation: Continue clears the replaced
    // timeout but does not resolve that old promise. VS Code provider promises
    // must not hang here, so superseded qwen requests resolve true and return [].
    item.resolve(true)
  }
}
