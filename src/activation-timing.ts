export type ActivationSlowRequireTiming = {
  request: string
  parent: string
  inclusiveMs: number
}

type ActivationTimingStore = {
  entryLoadedAt?: number
  activateCalledAt?: number
  moduleLoadStartedAt?: number
  moduleLoadedAt?: number
  delegateActivateStartedAt?: number
  delegateActivateDoneAt?: number
  entryLogs: string[]
  slowRequires: ActivationSlowRequireTiming[]
}

export type ActivationEntryTimingSnapshot = {
  entryWaitMs?: number
  moduleLoadMs?: number
  beforeDelegateMs?: number
  delegateActivateMs?: number
  totalMs?: number
  entryLogs: string[]
  slowRequires: ActivationSlowRequireTiming[]
}

declare global {
  var __chipmateActivationTiming: ActivationTimingStore | undefined
}

export function activationNow() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}

export function activationMs(value: number) {
  return Math.max(0, Math.round(value))
}

export function activationTimingStore() {
  if (!globalThis.__chipmateActivationTiming) {
    globalThis.__chipmateActivationTiming = {
      entryLogs: [],
      slowRequires: [],
    }
  }
  return globalThis.__chipmateActivationTiming
}

export function recordActivationEntryLog(message: string) {
  activationTimingStore().entryLogs.push(message)
  console.info(message)
}

export function readActivationEntryTiming(): ActivationEntryTimingSnapshot | undefined {
  const store = globalThis.__chipmateActivationTiming
  if (!store?.activateCalledAt) return undefined
  const entryWaitMs = store.entryLoadedAt !== undefined
    ? activationMs(store.activateCalledAt - store.entryLoadedAt)
    : undefined
  const moduleLoadMs = store.moduleLoadStartedAt !== undefined && store.moduleLoadedAt !== undefined
    ? activationMs(store.moduleLoadedAt - store.moduleLoadStartedAt)
    : undefined
  const beforeDelegateMs = store.delegateActivateStartedAt !== undefined
    ? activationMs(store.delegateActivateStartedAt - store.activateCalledAt)
    : undefined
  const delegateActivateMs = store.delegateActivateStartedAt !== undefined && store.delegateActivateDoneAt !== undefined
    ? activationMs(store.delegateActivateDoneAt - store.delegateActivateStartedAt)
    : undefined
  const totalMs = store.delegateActivateDoneAt !== undefined
    ? activationMs(store.delegateActivateDoneAt - store.activateCalledAt)
    : undefined
  return {
    entryWaitMs,
    moduleLoadMs,
    beforeDelegateMs,
    delegateActivateMs,
    totalMs,
    entryLogs: [...store.entryLogs],
    slowRequires: [...store.slowRequires],
  }
}

export function formatActivationSlowRequireTiming(prefix: "[activation-entry]" | "[activation-timing]", item: ActivationSlowRequireTiming) {
  return `${prefix} slow-require request=${item.request} parent=${item.parent} inclusiveMs=${item.inclusiveMs}`
}
