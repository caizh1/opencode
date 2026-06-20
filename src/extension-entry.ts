import Module = require("node:module")
import * as path from "node:path"
import type * as vscode from "vscode"
import {
  activationMs,
  activationNow,
  activationTimingStore,
  formatActivationSlowRequireTiming,
  recordActivationEntryLog,
  type ActivationSlowRequireTiming,
} from "./activation-timing"

type ExtensionModule = {
  activate: (context: vscode.ExtensionContext) => Promise<unknown> | unknown
  deactivate?: () => Promise<unknown> | unknown
}

type LoadableModule = typeof Module & {
  _load: (request: string, parent?: NodeModule | null, isMain?: boolean) => unknown
}

const SLOW_REQUIRE_THRESHOLD_MS = 25
const SLOW_REQUIRE_LIMIT = 30

let loadedExtension: ExtensionModule | undefined

activationTimingStore().entryLoadedAt = activationNow()

export async function activate(context: vscode.ExtensionContext) {
  const store = activationTimingStore()
  store.activateCalledAt = activationNow()
  recordActivationEntryLog(`[activation-entry] event=activate-called entryWaitMs=${entryWaitMs()}`)

  const extensionRoot = context.extensionUri?.fsPath || path.resolve(__dirname, "..")
  store.moduleLoadStartedAt = activationNow()
  const restoreSlowRequireProbe = installSlowRequireProbe(extensionRoot)
  try {
    loadedExtension = require("./extension") as ExtensionModule
  } catch (error) {
    store.moduleLoadedAt = activationNow()
    recordActivationEntryLog(`[activation-entry] event=module-load-failed moduleLoadMs=${moduleLoadMs()} error=${formatError(error)}`)
    throw error
  } finally {
    restoreSlowRequireProbe()
  }
  store.moduleLoadedAt = activationNow()
  logSlowRequires()
  recordActivationEntryLog(`[activation-entry] event=module-loaded moduleLoadMs=${moduleLoadMs()} slowRequireCount=${store.slowRequires.length}`)

  store.delegateActivateStartedAt = activationNow()
  const beforeDelegateMs = activationMs(store.delegateActivateStartedAt - store.activateCalledAt)
  recordActivationEntryLog(`[activation-entry] event=delegate-activate-start beforeDelegateMs=${beforeDelegateMs}`)
  try {
    const result = await loadedExtension.activate(context)
    store.delegateActivateDoneAt = activationNow()
    recordActivationEntryLog(
      `[activation-entry] event=delegate-activate-done delegateActivateMs=${delegateActivateMs()} totalMs=${totalEntryMs()}`,
    )
    return result
  } catch (error) {
    store.delegateActivateDoneAt = activationNow()
    recordActivationEntryLog(
      `[activation-entry] event=delegate-activate-failed delegateActivateMs=${delegateActivateMs()} totalMs=${totalEntryMs()} error=${formatError(error)}`,
    )
    throw error
  }
}

export function deactivate() {
  return loadedExtension?.deactivate?.()
}

function installSlowRequireProbe(extensionRoot: string) {
  const loadable = Module as LoadableModule
  const originalLoad = loadable._load
  loadable._load = function patchedLoad(this: unknown, request: string, parent?: NodeModule | null, isMain?: boolean) {
    const startedAt = activationNow()
    try {
      return originalLoad.call(this, request, parent, isMain)
    } finally {
      const inclusiveMs = activationMs(activationNow() - startedAt)
      if (inclusiveMs >= SLOW_REQUIRE_THRESHOLD_MS) recordSlowRequire(extensionRoot, request, parent, inclusiveMs)
    }
  }
  return () => {
    loadable._load = originalLoad
  }
}

function recordSlowRequire(extensionRoot: string, request: string, parent: NodeModule | null | undefined, inclusiveMs: number) {
  const store = activationTimingStore()
  const item: ActivationSlowRequireTiming = {
    request: sanitizeLogToken(request),
    parent: relativeParent(extensionRoot, parent?.filename),
    inclusiveMs,
  }
  store.slowRequires.push(item)
  store.slowRequires.sort((left, right) => right.inclusiveMs - left.inclusiveMs)
  store.slowRequires.length = Math.min(store.slowRequires.length, SLOW_REQUIRE_LIMIT)
}

function logSlowRequires() {
  const store = activationTimingStore()
  for (const item of store.slowRequires) {
    recordActivationEntryLog(formatActivationSlowRequireTiming("[activation-entry]", item))
  }
}

function relativeParent(extensionRoot: string, filename: string | undefined) {
  if (!filename) return "<unknown>"
  const relative = path.relative(extensionRoot, filename)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return sanitizeLogToken(relative)
  return sanitizeLogToken(path.basename(filename))
}

function sanitizeLogToken(value: string) {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 180) || "<empty>"
}

function entryWaitMs() {
  const store = activationTimingStore()
  return store.entryLoadedAt !== undefined && store.activateCalledAt !== undefined
    ? activationMs(store.activateCalledAt - store.entryLoadedAt)
    : "unknown"
}

function moduleLoadMs() {
  const store = activationTimingStore()
  return store.moduleLoadStartedAt !== undefined && store.moduleLoadedAt !== undefined
    ? activationMs(store.moduleLoadedAt - store.moduleLoadStartedAt)
    : "unknown"
}

function delegateActivateMs() {
  const store = activationTimingStore()
  return store.delegateActivateStartedAt !== undefined && store.delegateActivateDoneAt !== undefined
    ? activationMs(store.delegateActivateDoneAt - store.delegateActivateStartedAt)
    : "unknown"
}

function totalEntryMs() {
  const store = activationTimingStore()
  return store.activateCalledAt !== undefined && store.delegateActivateDoneAt !== undefined
    ? activationMs(store.delegateActivateDoneAt - store.activateCalledAt)
    : "unknown"
}

function formatError(error: unknown) {
  return sanitizeLogToken(error instanceof Error ? error.message : String(error))
}
