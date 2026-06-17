import * as vscode from "vscode"
import { readQwenAutocompleteConfig, qwenAutocompleteEnabled } from "./config"
import { exportQwenAutocompleteDiagnostics, showQwenAutocompleteLogs } from "./diagnostics"
import { KiloQwenInlineCompletionProvider, QWEN_DOCUMENT_SELECTOR } from "./KiloQwenInlineCompletionProvider"
import { QwenImportDefinitionsTracker } from "./importDefinitions"
import { QwenRecentlyEditedTracker } from "./recentlyEdited"
import { QwenRecentlyOpenedTracker } from "./recentlyOpened"
import { QwenRootPathTracker } from "./rootPathContext"

type RegisterDeps = {
  apiKey?: () => Promise<string | undefined>
  log?: (message: string) => void
}

export function registerQwenAutocompleteProvider(context: vscode.ExtensionContext, deps: RegisterDeps = {}): vscode.Disposable {
  const reg = new QwenAutocompleteRegistration(deps)
  context.subscriptions.push(reg)
  context.subscriptions.push(
    vscode.commands.registerCommand("chipmate.qwenAutocomplete.showLogs", showQwenAutocompleteLogs),
    vscode.commands.registerCommand(
      "chipmate.qwenAutocomplete.exportDiagnostics",
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
  private opened = false
  private imports = false
  private root = false

  constructor(private readonly deps: RegisterDeps = {}) {
    this.watcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("chipmate.completion") || event.affectsConfiguration("chipmate.provider")) this.sync()
    })
    this.sync()
  }

  dispose(): void {
    this.disposeProvider()
    this.watcher.dispose()
  }

  private sync(): void {
    const cfg = readQwenAutocompleteConfig()
    const enabled = qwenAutocompleteEnabled(cfg)
    const edited = enabled && cfg.recentlyEditedEnabled
    const opened = enabled && cfg.recentlyOpenedEnabled
    const imports = enabled && cfg.importDefinitionsEnabled
    const root = enabled && cfg.rootPathEnabled
    if (
      enabled &&
      this.provider &&
      this.edited === edited &&
      this.opened === opened &&
      this.imports === imports &&
      this.root === root
    ) {
      return
    }
    this.disposeProvider()
    if (enabled) {
      const recent = edited ? new QwenRecentlyEditedTracker() : undefined
      const files = opened ? new QwenRecentlyOpenedTracker() : undefined
      const defs = imports ? new QwenImportDefinitionsTracker() : undefined
      const path = root ? new QwenRootPathTracker() : undefined
      this.provider = new KiloQwenInlineCompletionProvider({
        apiKey: this.deps.apiKey,
        edited: recent,
        imports: defs,
        log: this.deps.log,
        opened: files,
        root: path,
      })
      this.registration = vscode.languages.registerInlineCompletionItemProvider(QWEN_DOCUMENT_SELECTOR, this.provider)
      this.edited = edited
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
    this.opened = false
    this.imports = false
    this.root = false
  }
}
