import path from "node:path"
import * as vscode from "vscode"
import { isSecurityConcern } from "../autocomplete/continuedev/core/indexing/ignore"
import { FileIgnoreController } from "../autocomplete/shims/FileIgnoreController"

const guards = new Map<string, Promise<FileIgnoreController>>()

export type QwenSafetyGuard = (document: vscode.TextDocument) => boolean | Promise<boolean>
export type QwenGuardSource = "current-file" | "context-read"
export type QwenGuardReason =
  | "none"
  | "non-file-scheme"
  | "security-concern"
  | "outside-workspace"
  | "ignored"
  | "error"
  | "custom"

export type QwenGuardDecision = {
  blocked: boolean
  errorFailClosed: boolean
  ignored: boolean
  reason: QwenGuardReason
  schemeAllowed: boolean
  sensitive: boolean
  source: QwenGuardSource
  workspaceAllowed: boolean
}

export async function shouldGuardQwenDocument(document: vscode.TextDocument): Promise<boolean> {
  return (await decideQwenGuard(document, "current-file")).blocked
}

export async function shouldGuardQwenContextDocument(document: vscode.TextDocument): Promise<boolean> {
  return (await decideQwenGuard(document, "context-read")).blocked
}

export async function decideQwenGuard(
  document: vscode.TextDocument,
  source: QwenGuardSource = "current-file",
): Promise<QwenGuardDecision> {
  try {
    return await guardUnchecked(document, source)
  } catch (err) {
    void err
    return decision(source, "error", {
      blocked: true,
      errorFailClosed: true,
      ignored: false,
      schemeAllowed: document.uri.scheme === "file",
      sensitive: false,
      workspaceAllowed: false,
    })
  }
}

export function isQwenSecurityConcern(file: string): boolean {
  return isSecurityConcern(file)
}

export function resetQwenSafetyGuardsForTests(): void {
  for (const guard of guards.values()) {
    void guard.then((controller) => controller.dispose())
  }
  guards.clear()
}

async function controllerFor(root: string): Promise<FileIgnoreController> {
  const cached = guards.get(root)
  if (cached) return cached

  const guard = (async () => {
    const controller = new FileIgnoreController(root)
    await controller.initialize()
    return controller
  })()
  guards.set(root, guard)
  return guard
}

function workspaceRootFor(document: vscode.TextDocument): string | undefined {
  const file = path.resolve(document.uri.fsPath)
  const roots = vscode.workspace.workspaceFolders
    ?.map((folder) => path.resolve(folder.uri.fsPath))
    .filter((root) => contains(root, file))
    .sort((a, b) => b.length - a.length)

  return roots?.[0]
}

async function guardUnchecked(document: vscode.TextDocument, source: QwenGuardSource): Promise<QwenGuardDecision> {
  const schemeAllowed = document.uri.scheme === "file"
  if (!schemeAllowed) {
    return decision(source, "non-file-scheme", {
      blocked: true,
      errorFailClosed: false,
      ignored: false,
      schemeAllowed,
      sensitive: false,
      workspaceAllowed: false,
    })
  }

  const file = document.uri.fsPath || document.uri.path
  const sensitive = isQwenSecurityConcern(file)
  if (sensitive) {
    return decision(source, "security-concern", {
      blocked: true,
      errorFailClosed: false,
      ignored: false,
      schemeAllowed,
      sensitive,
      workspaceAllowed: true,
    })
  }

  const root = workspaceRootFor(document)
  if (!root) {
    return decision(source, "outside-workspace", {
      blocked: true,
      errorFailClosed: false,
      ignored: false,
      schemeAllowed,
      sensitive,
      workspaceAllowed: false,
    })
  }

  const controller = await controllerFor(root)
  const ignored = !controller.validateAccess(document.uri.fsPath)
  if (ignored) {
    return decision(source, "ignored", {
      blocked: true,
      errorFailClosed: false,
      ignored,
      schemeAllowed,
      sensitive,
      workspaceAllowed: true,
    })
  }

  return decision(source, "none", {
    blocked: false,
    errorFailClosed: false,
    ignored,
    schemeAllowed,
    sensitive,
    workspaceAllowed: true,
  })
}

function decision(
  source: QwenGuardSource,
  reason: QwenGuardReason,
  input: Omit<QwenGuardDecision, "reason" | "source">,
): QwenGuardDecision {
  return {
    ...input,
    reason,
    source,
  }
}

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
