import * as vscode from "vscode"
import { qwenAutocompleteEnabled, readQwenAutocompleteConfig } from "./config"
import { isQwenSecurityConcern, shouldGuardQwenContextDocument, type QwenSafetyGuard } from "./guard"
import { isQwenSupportedDocument } from "./prefilter"
import { QwenAutocompleteSnippetType, type QwenAutocompleteCodeSnippet } from "./snippets"
import type { QwenAutocompleteConfig } from "./types"

type Deps = {
  guard?: QwenSafetyGuard
  now?: () => number
  read?: () => QwenAutocompleteConfig
}

type Entry = {
  content: string
  filepath: string
  range: vscode.Range
  timestamp: number
}

type Event = {
  selections: vscode.Selection[]
  textEditor: { document: vscode.TextDocument }
}

export type QwenRecentlyVisitedSource = vscode.Disposable & {
  count(): number
  flush?(): Promise<void>
  snippets(cfg: QwenAutocompleteConfig): QwenAutocompleteCodeSnippet[]
}

const CURSOR_RADIUS = 2
const MAX_ENTRIES = 10
const STALE_MS = 2 * 60 * 1000

// Continue parity source:
// continuedev/continue@main non-streaming autocomplete recently visited ranges.
// qwen-direct keeps this source isolated in-memory, file-only, and guarded so
// it can feed snippet payload parity without touching chat/QA editor context.
export class QwenRecentlyVisitedTracker implements QwenRecentlyVisitedSource {
  private readonly guard: QwenSafetyGuard
  private readonly now: () => number
  private readonly read: () => QwenAutocompleteConfig
  private readonly pending = new Set<Promise<void>>()
  private readonly listener: vscode.Disposable | null
  private entries: Entry[] = []
  private closed = false

  constructor(deps: Deps = {}) {
    this.guard = deps.guard ?? shouldGuardQwenContextDocument
    this.now = deps.now ?? Date.now
    this.read = deps.read ?? readQwenAutocompleteConfig
    const windowApi = vscode.window
    if (active(this.read()) && windowApi && typeof windowApi.onDidChangeTextEditorSelection === "function") {
      this.listener = windowApi.onDidChangeTextEditorSelection((event) => {
        const task = this.capture(event as unknown as Event)
        this.pending.add(task)
        task.finally(() => this.pending.delete(task)).catch((err) => void err)
      })
      return
    }
    this.listener = null
  }

  dispose(): void {
    this.closed = true
    this.listener?.dispose()
    this.entries = []
    this.pending.clear()
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending])
  }

  count(): number {
    this.prune()
    return this.entries.length
  }

  snippets(cfg: QwenAutocompleteConfig): QwenAutocompleteCodeSnippet[] {
    if (!active(cfg)) return []
    this.prune()
    return this.entries.map((entry) => ({
      filepath: entry.filepath,
      content: entry.content,
      type: QwenAutocompleteSnippetType.Code,
    }))
  }

  private async capture(event: Event): Promise<void> {
    const cfg = this.read()
    if (!active(cfg)) {
      this.dispose()
      return
    }
    const document = event.textEditor?.document
    if (!document || !trackable(document)) return
    const filepath = document.uri.fsPath || String(document.uri)
    if (hidden(filepath) || isQwenSecurityConcern(filepath)) return
    const blocked = await this.blocked(document)
    if (this.closed || blocked) return
    const selection = event.selections[0]
    if (!selection) return
    const range = rangeForSelection(document, selection, cfg.recentlyEditedMaxRangeLines)
    const content = textFor(document, range)
    if (content.trim() === "") return
    this.insert({
      content,
      filepath,
      range,
      timestamp: this.now(),
    })
    this.prune()
  }

  private async blocked(document: vscode.TextDocument): Promise<boolean> {
    try {
      return await this.guard(document)
    } catch (err) {
      void err
      return true
    }
  }

  private insert(entry: Entry): void {
    const hit = this.entries.findIndex(
      (item) =>
        item.filepath === entry.filepath &&
        (sameRange(item.range, entry.range) || overlaps(item.range, entry.range) || item.content === entry.content),
    )
    if (hit >= 0) {
      this.entries.splice(hit, 1)
    }
    this.entries.unshift(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
  }

  private prune(): void {
    const fresh = this.now() - STALE_MS
    this.entries = this.entries.filter((entry) => entry.timestamp >= fresh).slice(0, MAX_ENTRIES)
  }
}

function active(cfg: QwenAutocompleteConfig): boolean {
  return qwenAutocompleteEnabled(cfg)
}

function trackable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && isQwenSupportedDocument(document)
}

function rangeForSelection(document: vscode.TextDocument, selection: vscode.Selection, maxLines: number): vscode.Range {
  if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) {
    const start = clampLine(selection.start.line, document.lineCount)
    const lineSpan = Math.max(1, selection.end.line - selection.start.line + 1)
    const count = Math.min(Math.max(1, maxLines), lineSpan)
    const end = Math.min(document.lineCount, start + count)
    return new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0))
  }
  const center = clampLine(selection.active.line, document.lineCount)
  const start = Math.max(0, center - CURSOR_RADIUS)
  const end = Math.min(document.lineCount, center + CURSOR_RADIUS + 1)
  return new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0))
}

function clampLine(line: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), line))
}

function textFor(document: vscode.TextDocument, range: vscode.Range): string {
  const start = Math.max(0, range.start.line)
  const end = Math.min(document.lineCount, range.end.line)
  const lines: string[] = []
  for (let line = start; line < end; line++) {
    lines.push(document.lineAt(line).text)
  }
  return lines.join("\n")
}

function overlaps(left: vscode.Range, right: vscode.Range): boolean {
  return left.start.line < right.end.line && right.start.line < left.end.line
}

function sameRange(left: vscode.Range, right: vscode.Range): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  )
}

function hidden(file: string): boolean {
  return file.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")
}
