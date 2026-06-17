import path from "node:path"
import * as vscode from "vscode"
import { qwenAutocompleteEnabled, readQwenAutocompleteConfig } from "./config"
import { isQwenSecurityConcern, shouldGuardQwenContextDocument, type QwenSafetyGuard } from "./guard"
import { isQwenSupportedDocument } from "./prefilter"
import { QwenAutocompleteSnippetType, type QwenAutocompleteCodeSnippet } from "./snippets"
import type { QwenAutocompleteConfig } from "./types"

type Deps = {
  guard?: QwenSafetyGuard
  read?: () => QwenAutocompleteConfig
  readFile?: (uri: vscode.Uri) => Promise<Uint8Array>
}

type Entry = {
  filepath: string
  languageId: string
  uri: vscode.Uri
}

type Outcome = {
  skipped: boolean
  snippet?: QwenAutocompleteCodeSnippet
}

export type QwenRecentlyOpenedResult = {
  skippedCount: number
  snippets: QwenAutocompleteCodeSnippet[]
}

export type QwenRecentlyOpenedSource = vscode.Disposable & {
  count(): number
  flush?(): Promise<void>
  snippets(cfg: QwenAutocompleteConfig, current: vscode.TextDocument): Promise<QwenRecentlyOpenedResult>
}

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/util/openedFilesLruCache.ts
// - core/autocomplete/snippets/getAllSnippets.ts getSnippetsFromRecentlyOpenedFiles
// qwen adapter differences: metadata tracking is VS Code-owned, guard/prefilter
// checks run before qwen reads file content, and all storage stays in memory.
export class QwenRecentlyOpenedTracker implements QwenRecentlyOpenedSource {
  private readonly guard: QwenSafetyGuard
  private readonly read: () => QwenAutocompleteConfig
  private readonly reader: (uri: vscode.Uri) => Promise<Uint8Array>
  private readonly disposables: vscode.Disposable[] = []
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Set<Promise<void>>()
  private closed = false

  constructor(deps: Deps = {}) {
    this.guard = deps.guard ?? shouldGuardQwenContextDocument
    this.read = deps.read ?? readQwenAutocompleteConfig
    this.reader = deps.readFile ?? ((uri) => Promise.resolve(vscode.workspace.fs.readFile(uri)))
    if (!active(this.read())) return
    this.register()
    this.seed()
  }

  dispose(): void {
    this.closed = true
    for (const item of this.disposables.splice(0)) item.dispose()
    this.entries.clear()
    this.pending.clear()
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending])
  }

  count(): number {
    return active(this.read()) ? this.entries.size : 0
  }

  async snippets(cfg: QwenAutocompleteConfig, current: vscode.TextDocument): Promise<QwenRecentlyOpenedResult> {
    if (!active(cfg)) return { skippedCount: 0, snippets: [] }
    const currentFile = current.uri.fsPath || String(current.uri)
    const entries = [...this.entries.values()].reverse()
    const results = await Promise.all(entries.map((entry) => this.readSnippet(entry, currentFile, cfg)))
    return {
      skippedCount: results.filter((item) => item.skipped).length,
      snippets: results.flatMap((item) => (item.snippet ? [item.snippet] : [])),
    }
  }

  private register(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.remove(document)),
    )
    const activeEditor = (
      vscode.window as unknown as {
        onDidChangeActiveTextEditor?: (
          listener: (editor: vscode.TextEditor | undefined) => unknown,
        ) => vscode.Disposable
      }
    ).onDidChangeActiveTextEditor
    if (activeEditor) {
      this.disposables.push(
        activeEditor((editor) => {
          if (editor?.document) this.schedule(editor.document)
        }),
      )
    }
  }

  private seed(): void {
    const docs = [
      ...new Set([
        ...vscode.window.visibleTextEditors.map((editor) => editor.document),
        ...vscode.workspace.textDocuments,
      ]),
    ]
    for (const document of docs) this.schedule(document as vscode.TextDocument)
  }

  private schedule(document: vscode.TextDocument): void {
    const task = this.track(document)
    this.pending.add(task)
    task.finally(() => this.pending.delete(task)).catch((err) => void err)
  }

  private async track(document: vscode.TextDocument): Promise<void> {
    const cfg = this.read()
    if (!active(cfg)) {
      this.dispose()
      return
    }
    if (!trackable(document)) return
    if (sensitive(document.uri.fsPath) || hidden(document.uri.fsPath)) return
    if (await this.blocked(document)) return
    if (this.closed) return
    this.touch(
      {
        filepath: document.uri.fsPath || String(document.uri),
        languageId: document.languageId,
        uri: document.uri,
      },
      cfg,
    )
  }

  private async readSnippet(entry: Entry, current: string, cfg: QwenAutocompleteConfig): Promise<Outcome> {
    if (entry.filepath === current) return { skipped: true }
    if (!trackable(documentFor(entry))) return { skipped: true }
    if (sensitive(entry.filepath) || hidden(entry.filepath)) return { skipped: true }
    if (await this.blocked(documentFor(entry))) return { skipped: true }
    const content = await readWithTimeout(this.reader(entry.uri), cfg.recentlyOpenedFileReadTimeoutMs)
    if (content === null) return { skipped: true }
    if (content.trim() === "") return { skipped: true }
    return {
      skipped: false,
      snippet: {
        filepath: entry.filepath,
        content,
        type: QwenAutocompleteSnippetType.Code,
      },
    }
  }

  private async blocked(document: vscode.TextDocument): Promise<boolean> {
    try {
      return await this.guard(document)
    } catch (err) {
      void err
      return true
    }
  }

  private remove(document: vscode.TextDocument): void {
    this.entries.delete(document.uri.fsPath || String(document.uri))
  }

  private touch(entry: Entry, cfg: QwenAutocompleteConfig): void {
    this.entries.delete(entry.filepath)
    this.entries.set(entry.filepath, entry)
    while (this.entries.size > cfg.recentlyOpenedMaxFiles) {
      const stale = this.entries.keys().next().value
      if (!stale) return
      this.entries.delete(stale)
    }
  }
}

export function recentlyOpenedFilesToQwenSnippets(
  files: Array<{ content: string; filepath: string }>,
  opts: { useRecentlyOpened?: boolean } = {},
): QwenAutocompleteCodeSnippet[] {
  if (opts.useRecentlyOpened === false) return []
  return files
    .filter((file) => file.content.trim() !== "")
    .map((file) => ({
      filepath: file.filepath,
      content: file.content,
      type: QwenAutocompleteSnippetType.Code,
    }))
}

function active(cfg: QwenAutocompleteConfig): boolean {
  return qwenAutocompleteEnabled(cfg) && cfg.recentlyOpenedEnabled
}

function trackable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && isQwenSupportedDocument(document)
}

async function readWithTimeout(promise: Promise<Uint8Array>, timeout: number): Promise<string | null> {
  try {
    const bytes = await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ])
    if (bytes === null) return null
    return new TextDecoder().decode(bytes)
  } catch (err) {
    void err
    return null
  }
}

function documentFor(entry: Entry): vscode.TextDocument {
  return {
    uri: entry.uri,
    languageId: entry.languageId,
    version: 0,
    lineCount: 0,
    getText: () => "",
    lineAt: () => ({ text: "", range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) }),
  } as unknown as vscode.TextDocument
}

function sensitive(file: string): boolean {
  return isQwenSecurityConcern(file)
}

function hidden(file: string): boolean {
  return file.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")
}
