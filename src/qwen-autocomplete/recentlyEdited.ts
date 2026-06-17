import path from "node:path"
import * as vscode from "vscode"
import { qwenAutocompleteEnabled, readQwenAutocompleteConfig } from "./config"
import { shouldGuardQwenDocument, type QwenSafetyGuard } from "./guard"
import { isQwenSupportedDocument } from "./prefilter"
import {
  recentlyEditedRangesToQwenSnippets,
  type QwenAutocompleteCodeSnippet,
  type QwenRecentlyEditedRange,
} from "./snippets"
import type { QwenAutocompleteConfig } from "./types"

type Deps = {
  guard?: QwenSafetyGuard
  now?: () => number
  read?: () => QwenAutocompleteConfig
}

type Change = {
  range: vscode.Range
  text: string
}

type Event = {
  contentChanges: Change[]
  document: vscode.TextDocument
}

const STALE_MS = 2 * 60 * 1000
const MAX_FILES = 10
const SENSITIVE_EXTS = new Set([".key", ".pem", ".p12", ".pfx", ".crt", ".cert"])
const SENSITIVE_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"])

export type QwenRecentlyEditedSource = vscode.Disposable & {
  count(): number
  snippets(cfg: QwenAutocompleteConfig): QwenAutocompleteCodeSnippet[]
}

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/snippets/getAllSnippets.ts getSnippetsFromRecentlyEditedRanges
// - core/vscode-test-harness/src/autocomplete/recentlyEdited.ts RecentlyEditedTracker
// qwen adapter differences: event document text is used after guard passes; no
// old runtime imports, no IDE readFile, no symbol extraction, no disk storage.
export class QwenRecentlyEditedTracker implements QwenRecentlyEditedSource {
  private readonly guard: QwenSafetyGuard
  private readonly now: () => number
  private readonly read: () => QwenAutocompleteConfig
  private readonly files = new Map<string, number>()
  private readonly pending = new Set<Promise<void>>()
  private listener: vscode.Disposable | null = null
  private ranges: QwenRecentlyEditedRange[] = []
  private closed = false

  constructor(deps: Deps = {}) {
    this.guard = deps.guard ?? shouldGuardQwenDocument
    this.now = deps.now ?? Date.now
    this.read = deps.read ?? readQwenAutocompleteConfig
    if (active(this.read())) {
      this.listener = vscode.workspace.onDidChangeTextDocument((event) => {
        const task = this.capture(event as unknown as Event)
        this.pending.add(task)
        task.finally(() => this.pending.delete(task)).catch((err) => void err)
      })
    }
  }

  dispose(): void {
    this.closed = true
    this.listener?.dispose()
    this.listener = null
    this.ranges = []
    this.files.clear()
    this.pending.clear()
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending])
  }

  count(): number {
    this.prune(this.read())
    return this.ranges.length
  }

  snippets(cfg: QwenAutocompleteConfig): QwenAutocompleteCodeSnippet[] {
    if (!active(cfg)) return []
    this.prune(cfg)
    return recentlyEditedRangesToQwenSnippets(this.ranges, { useRecentlyEdited: cfg.recentlyEditedEnabled })
  }

  private async capture(event: Event): Promise<void> {
    const cfg = this.read()
    if (!active(cfg)) {
      this.dispose()
      return
    }
    const document = event.document
    if (!trackable(document)) return
    if (sensitive(document.uri.fsPath)) return
    const blocked = await this.blocked(document)
    if (this.closed) return
    if (blocked) return
    for (const change of event.contentChanges) {
      this.insert(document, change, cfg)
    }
    this.touch(document.uri.fsPath)
    this.prune(cfg)
  }

  private async blocked(document: vscode.TextDocument): Promise<boolean> {
    try {
      return await this.guard(document)
    } catch (err) {
      void err
      return true
    }
  }

  private insert(document: vscode.TextDocument, change: Change, cfg: QwenAutocompleteConfig): void {
    const range = changedRange(document, change, cfg.recentlyEditedMaxRangeLines)
    const lines = linesFor(document, range)
    if (lines.length === 0) return
    const file = document.uri.fsPath || String(document.uri)
    const hit = this.ranges.findIndex((item) => item.filepath === file && overlaps(item.range, range))
    if (hit >= 0) {
      const merged = merge(this.ranges[hit]!.range, range)
      this.ranges[hit] = {
        filepath: file,
        lines: linesFor(document, merged),
        range: merged,
        symbols: new Set(),
        timestamp: this.now(),
      }
      this.promote(hit)
      return
    }
    this.ranges.unshift({
      filepath: file,
      lines,
      range,
      symbols: new Set(),
      timestamp: this.now(),
    })
  }

  private promote(index: number): void {
    const item = this.ranges.splice(index, 1)[0]
    if (item) this.ranges.unshift(item)
  }

  private touch(file: string): void {
    this.files.delete(file)
    this.files.set(file, this.now())
    while (this.files.size > MAX_FILES) {
      const stale = this.files.keys().next().value
      if (!stale) return
      this.files.delete(stale)
      this.ranges = this.ranges.filter((item) => item.filepath !== stale)
    }
  }

  private prune(cfg: QwenAutocompleteConfig): void {
    const fresh = this.now() - STALE_MS
    this.ranges = this.ranges.filter((item) => item.timestamp >= fresh).slice(0, cfg.recentlyEditedMaxRanges)
  }
}

function active(cfg: QwenAutocompleteConfig): boolean {
  return qwenAutocompleteEnabled(cfg) && cfg.recentlyEditedEnabled
}

function trackable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && isQwenSupportedDocument(document)
}

function changedRange(document: vscode.TextDocument, change: Change, max: number): vscode.Range {
  const start = Math.max(0, Math.min(change.range.start.line, Math.max(0, document.lineCount - 1)))
  const changed = change.text.split(/\r?\n/).length
  const replaced = Math.max(1, change.range.end.line - change.range.start.line + 1)
  const count = Math.max(1, Math.min(max, Math.max(changed, replaced)))
  const end = Math.max(start + 1, Math.min(document.lineCount, start + count))
  return new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0))
}

function linesFor(document: vscode.TextDocument, range: unknown): string[] {
  if (!rangeInfo(range)) return []
  const start = Math.max(0, range.start.line)
  const end = Math.min(document.lineCount, range.end.line)
  const out: string[] = []
  for (const index of Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset)) {
    out.push(document.lineAt(index).text)
  }
  return out
}

function overlaps(left: unknown, right: unknown): boolean {
  if (!rangeInfo(left) || !rangeInfo(right)) return false
  return left.start.line < right.end.line && right.start.line < left.end.line
}

function merge(left: unknown, right: unknown): vscode.Range {
  if (!rangeInfo(left) || !rangeInfo(right)) return right as vscode.Range
  const start = Math.min(left.start.line, right.start.line)
  const end = Math.max(left.end.line, right.end.line)
  return new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0))
}

function sensitive(file: string): boolean {
  const base = path.basename(file).toLowerCase()
  if (base === ".env" || base.startsWith(".env.")) return true
  if (SENSITIVE_NAMES.has(base)) return true
  return SENSITIVE_EXTS.has(path.extname(base))
}

function rangeInfo(value: unknown): value is {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  if (!value || typeof value !== "object") return false
  const current = value as { start?: unknown; end?: unknown }
  return point(current.start) && point(current.end)
}

function point(value: unknown): value is { line: number; character: number } {
  if (!value || typeof value !== "object") return false
  const current = value as { line?: unknown; character?: unknown }
  return typeof current.line === "number" && typeof current.character === "number"
}
