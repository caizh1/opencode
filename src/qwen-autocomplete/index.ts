import * as vscode from "vscode"
import { initializeBundledTreeSitterAssets } from "../autocomplete/continuedev/core/util/treeSitter"
import { CHIPMATE_COMMANDS } from "../chipmate-constants"
import { QwenAutocompleteLruCache } from "./autocompleteLruCache"
import { readQwenAutocompleteConfig, qwenAutocompleteEnabled } from "./config"
import { exportQwenAutocompleteDiagnostics, showQwenAutocompleteLogs } from "./diagnostics"
import { KiloQwenInlineCompletionProvider, QWEN_DOCUMENT_SELECTOR } from "./KiloQwenInlineCompletionProvider"
import { QwenImportDefinitionsTracker } from "./importDefinitions"
import { QwenRecentlyEditedTracker } from "./recentlyEdited"
import { QwenRecentlyVisitedTracker } from "./recentlyVisited"
import { QwenRecentlyOpenedTracker } from "./recentlyOpened"
import { QwenRootPathTracker, type QwenRootPathGraphProvider } from "./rootPathContext"

type RegisterDeps = {
  apiKey?: () => Promise<string | undefined>
  log?: (message: string) => void
  rootPathGraph?: QwenRootPathGraphProvider
}

export function registerQwenAutocompleteProvider(context: vscode.ExtensionContext, deps: RegisterDeps = {}): vscode.Disposable {
  const extensionRoot = context.extensionUri?.fsPath || context.extensionPath
  if (extensionRoot) initializeBundledTreeSitterAssets(extensionRoot)
  const reg = new QwenAutocompleteRegistration(context, deps)
  context.subscriptions.push(reg)
  context.subscriptions.push(
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.qwenAutocompleteRegenerate, () => reg.regenerateActiveEditor()),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.qwenAutocompleteShowLogs, showQwenAutocompleteLogs),
    vscode.commands.registerCommand(
      CHIPMATE_COMMANDS.qwenAutocompleteExportDiagnostics,
      exportQwenAutocompleteDiagnostics,
    ),
  )
  return reg
}

class QwenAutocompleteRegistration implements vscode.Disposable {
  private provider: KiloQwenInlineCompletionProvider | null = null
  private registration: vscode.Disposable | null = null
  private readonly watcher: vscode.Disposable
  private edited = false
  private visited = false
  private opened = false
  private imports = false
  private root = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: RegisterDeps = {},
  ) {
    this.watcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("chipmate.completion") || event.affectsConfiguration("chipmate.provider")) this.sync()
    })
    this.sync()
  }

  dispose(): void {
    this.disposeProvider()
    this.watcher.dispose()
  }

  async regenerateActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      this.status("ChipMate inline completion regenerate needs an active editor.")
      return
    }

    if (!qwenAutocompleteEnabled(readQwenAutocompleteConfig()) || !this.provider) {
      this.status("ChipMate qwen inline completion is unavailable for this editor.")
      return
    }

    this.provider.forceFreshOnce(editor.document, editor.selection.active)
    await this.tryExecuteCommand("editor.action.inlineSuggest.hide")
    await this.tryExecuteCommand("editor.action.inlineSuggest.trigger")
  }

  private sync(): void {
    const cfg = readQwenAutocompleteConfig()
    const enabled = qwenAutocompleteEnabled(cfg)
    const edited = enabled && cfg.recentlyEditedEnabled
    const visited = enabled
    const opened = enabled && cfg.recentlyOpenedEnabled
    const imports = enabled && cfg.importDefinitionsEnabled
    const root = enabled && cfg.rootPathEnabled
    if (
      enabled &&
      this.provider &&
      this.edited === edited &&
      this.visited === visited &&
      this.opened === opened &&
      this.imports === imports &&
      this.root === root
    ) {
      return
    }
    this.disposeProvider()
    if (enabled) {
      const cacheUri = contextCacheUri(this.context)
      const recent = edited ? new QwenRecentlyEditedTracker() : undefined
      const visitedRanges = visited ? new QwenRecentlyVisitedTracker() : undefined
      const files = opened ? new QwenRecentlyOpenedTracker() : undefined
      const defs = imports ? new QwenImportDefinitionsTracker() : undefined
      const path = root ? new QwenRootPathTracker({ graph: this.deps.rootPathGraph }) : undefined
      this.provider = new KiloQwenInlineCompletionProvider({
        apiKey: this.deps.apiKey,
        cache: new QwenAutocompleteLruCache({ storagePath: cacheUri?.fsPath }),
        edited: recent,
        imports: defs,
        log: this.deps.log,
        opened: files,
        root: path,
        visited: visitedRanges,
      })
      this.registration = vscode.languages.registerInlineCompletionItemProvider(QWEN_DOCUMENT_SELECTOR, this.provider)
      this.edited = edited
      this.visited = visited
      this.opened = opened
      this.imports = imports
      this.root = root
      return
    }
  }

  private disposeProvider(): void {
    this.registration?.dispose()
    this.registration = null
    this.provider?.dispose()
    this.provider = null
    this.edited = false
    this.visited = false
    this.opened = false
    this.imports = false
    this.root = false
  }

  private status(message: string) {
    vscode.window.setStatusBarMessage(message, 2500)
  }

  private async tryExecuteCommand(command: string) {
    try {
      await vscode.commands.executeCommand(command)
    } catch {
      // Keep manual regenerate lightweight even when inline suggest commands are unavailable.
    }
  }
}

function contextCacheUri(context: vscode.ExtensionContext | undefined): vscode.Uri | undefined {
  if (!context?.globalStorageUri) return undefined
  return vscode.Uri.joinPath(context.globalStorageUri, "qwen-autocomplete", "autocomplete-cache.sqlite")
}
