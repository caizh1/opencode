import path from "node:path"
import * as vscode from "vscode"
import {
  getFullLanguageName,
  getParserForFile,
  getQueryForFile,
} from "../autocomplete/continuedev/core/util/treeSitter"
import { qwenAutocompleteEnabled, readQwenAutocompleteConfig } from "./config"
import { isQwenSecurityConcern, shouldGuardQwenContextDocument, type QwenSafetyGuard } from "./guard"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import { isQwenSupportedDocument } from "./prefilter"
import { QwenAutocompleteSnippetType, type QwenAutocompleteCodeSnippet } from "./snippets"
import type { QwenAutocompleteConfig } from "./types"

type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }

type Def = {
  filepath: string
  range: Range
}

type Read = {
  contents: string
  filepath: string
  range: Range
}

type Import = {
  symbol: string
  position: Pos
}

type Info = {
  imports: Record<string, Read[]>
}

type Deps = {
  definitions?: (filepath: string, position: Pos, timeout: number) => Promise<Def[]>
  guard?: QwenSafetyGuard
  parse?: (filepath: string, content: string) => Promise<Import[]>
  read?: () => QwenAutocompleteConfig
  readRange?: (filepath: string, range: Range, timeout: number) => Promise<string | null>
}

export type QwenImportDefinitionsResult = {
  skippedCount: number
  snippets: QwenAutocompleteCodeSnippet[]
}

export type QwenImportDefinitionsSource = vscode.Disposable & {
  count(): number
  flush?(): Promise<void>
  snippets(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    document: vscode.TextDocument,
  ): Promise<QwenImportDefinitionsResult>
}

const MAX_BYTES = 10_000
const MAX_LINES = 100
const TOKEN = /[\s.,/#!$%^&*;:{}=\-_`~()[\]]/g
// Source mapping:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// core/autocomplete/context import-definition path. qwen keeps this
// memory-only, default-off, and replaces Continue IDE calls with VS Code APIs.
export class QwenImportDefinitionsTracker implements QwenImportDefinitionsSource {
  private readonly definitions: (filepath: string, position: Pos, timeout: number) => Promise<Def[]>
  private readonly guard: QwenSafetyGuard
  private readonly parse: (filepath: string, content: string) => Promise<Import[]>
  private readonly read: () => QwenAutocompleteConfig
  private readonly ranges: (filepath: string, range: Range, timeout: number) => Promise<string | null>
  private readonly cache = new Map<string, Promise<Info | null>>()
  private readonly pending = new Set<Promise<Info | null>>()
  private readonly disposables: vscode.Disposable[] = []
  private closed = false

  constructor(deps: Deps = {}) {
    this.definitions = deps.definitions ?? definitionsFor
    this.guard = deps.guard ?? shouldGuardQwenContextDocument
    this.parse = deps.parse ?? importsFor
    this.read = deps.read ?? readQwenAutocompleteConfig
    this.ranges = deps.readRange ?? readRange
    if (!active(this.read())) return
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) this.schedule(editor.document)
      }),
    )
  }

  dispose(): void {
    this.closed = true
    for (const item of this.disposables.splice(0)) item.dispose()
    this.cache.clear()
    this.pending.clear()
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending])
  }

  count(): number {
    return active(this.read()) ? this.cache.size : 0
  }

  async snippets(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    document: vscode.TextDocument,
  ): Promise<QwenImportDefinitionsResult> {
    if (!active(cfg)) return { skippedCount: 0, snippets: [] }
    const info = await this.info(document, cfg)
    if (!info) return { skippedCount: 0, snippets: [] }
    const snippets: QwenAutocompleteCodeSnippet[] = []
    let skipped = 0
    for (const symbol of symbols(helper)) {
      const reads = info.imports[symbol]
      if (!reads) continue
      for (const item of reads) {
        if (item.contents.trim() === "") {
          skipped++
          continue
        }
        snippets.push({
          filepath: item.filepath,
          content: item.contents,
          type: QwenAutocompleteSnippetType.Code,
        })
      }
    }
    return { skippedCount: skipped, snippets }
  }

  private schedule(document: vscode.TextDocument): void {
    const cfg = this.read()
    if (!active(cfg)) {
      this.dispose()
      return
    }
    const task = this.info(document, cfg)
    this.pending.add(task)
    task.finally(() => this.pending.delete(task)).catch((err) => void err)
  }

  private async info(document: vscode.TextDocument, cfg: QwenAutocompleteConfig): Promise<Info | null> {
    if (!trackable(document) || sensitive(document.uri.fsPath) || hidden(document.uri.fsPath)) return null
    if (await this.blocked(document)) return null
    const file = document.uri.fsPath || String(document.uri)
    const cached = this.cache.get(file)
    if (cached) return cached
    const task = this.scan(document, cfg)
    this.cache.set(file, task)
    this.prune(cfg)
    this.pending.add(task)
    task.finally(() => this.pending.delete(task)).catch((err) => void err)
    return task
  }

  private async scan(document: vscode.TextDocument, cfg: QwenAutocompleteConfig): Promise<Info | null> {
    if (this.closed) return null
    const file = document.uri.fsPath || String(document.uri)
    const content = bounded(document.getText())
    const imports = await this.parse(file, content)
    const info: Info = { imports: {} }
    for (const item of imports) {
      const defs = await safe(() => this.definitions(file, item.position, cfg.importDefinitionsTimeoutMs), [])
      const reads = await Promise.all(defs.map((def) => this.readDefinition(def, cfg)))
      info.imports[item.symbol] = reads.flatMap((read) => (read ? [read] : []))
    }
    return info
  }

  private async readDefinition(def: Def, cfg: QwenAutocompleteConfig): Promise<Read | null> {
    const uri = vscode.Uri.file(def.filepath)
    if (uri.scheme !== "file") return null
    if (sensitive(def.filepath) || hidden(def.filepath)) return null
    const doc = documentFor(uri)
    if (!trackable(doc)) return null
    if (await this.blocked(doc)) return null
    const contents = await this.ranges(def.filepath, def.range, cfg.importDefinitionsTimeoutMs)
    if (!contents || contents.trim() === "") return null
    return { contents, filepath: def.filepath, range: def.range }
  }

  private async blocked(document: vscode.TextDocument): Promise<boolean> {
    try {
      return await this.guard(document)
    } catch (err) {
      void err
      return true
    }
  }

  private prune(cfg: QwenAutocompleteConfig): void {
    while (this.cache.size > cfg.importDefinitionsCacheSize) {
      const stale = this.cache.keys().next().value
      if (!stale) return
      this.cache.delete(stale)
    }
  }
}

export async function importsFor(filepath: string, content: string): Promise<Import[]> {
  const parsed = await treeImports(filepath, content)
  if (parsed) return parsed
  return fallbackImports(content)
}

export function fallbackImports(content: string): Import[] {
  const imports: Import[] = []
  const lines = bounded(content).split(/\r?\n/)
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? ""
    const include = text.match(/^\s*#\s*include\s+[<"]([^>"]+)[>"]/)
    if (include?.[1]) {
      const stem = path.basename(include[1], path.extname(include[1]))
      imports.push({ symbol: stem, position: { line, character: text.indexOf(include[1]) } })
    }
    const use = text.match(/\b(?:using|namespace|import)\s+([A-Za-z_][A-Za-z0-9_:]*)/)
    if (use?.[1]) {
      imports.push({ symbol: use[1].split("::").pop() ?? use[1], position: { line, character: text.indexOf(use[1]) } })
    }
  }
  return imports
}

export function symbols(helper: QwenAutocompleteHelperVars): string[] {
  const text = helper.fullPrefix.split("\n").slice(-5).join("\n") + helper.fullSuffix.split("\n").slice(0, 3).join("\n")
  return [
    ...new Set(
      text
        .split(TOKEN)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].filter((symbol) => !helper.lang.topLevelKeywords.includes(symbol))
}

async function treeImports(filepath: string, content: string): Promise<Import[] | undefined> {
  const parser = await getParserForFile(filepath)
  if (!parser) return undefined
  const ast = parser.parse(content, undefined, {
    includedRanges: [
      {
        startIndex: 0,
        endIndex: MAX_BYTES,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: MAX_LINES, column: 0 },
      },
    ],
  })
  if (!ast) return undefined
  const language = getFullLanguageName(filepath)
  if (!language) return undefined
  const query = await getQueryForFile(filepath, `import-queries/${language}.scm`)
  if (!query) return undefined
  return query.matches(ast.rootNode).flatMap((match) =>
    match.captures.map((item) => ({
      symbol: item.node.text,
      position: { line: item.node.startPosition.row, character: item.node.startPosition.column },
    })),
  )
}

async function definitionsFor(filepath: string, position: Pos, timeout: number): Promise<Def[]> {
  const uri = vscode.Uri.file(filepath)
  const defs = await withTimeout(
    vscode.commands.executeCommand<unknown[]>(
      "vscode.executeDefinitionProvider",
      uri,
      new vscode.Position(position.line, position.character),
    ),
    timeout,
  )
  if (!defs) return []
  return defs.flatMap(normalize)
}

function normalize(def: unknown): Def[] {
  if (!def || typeof def !== "object") return []
  const item = def as {
    uri?: vscode.Uri
    range?: Range
    targetUri?: vscode.Uri
    targetRange?: Range
  }
  const uri = item.targetUri ?? item.uri
  const range = item.targetRange ?? item.range
  if (!uri || uri.scheme !== "file" || !rangeInfo(range)) return []
  return [{ filepath: uri.fsPath || uri.path, range }]
}

async function readRange(filepath: string, range: Range, timeout: number): Promise<string | null> {
  const text = await readFile(vscode.Uri.file(filepath), timeout)
  if (text === null) return null
  const lines = text.split(/\r?\n/)
  return text.slice(offset(lines, range.start), offset(lines, range.end))
}

async function readFile(uri: vscode.Uri, timeout: number): Promise<string | null> {
  const bytes = await withTimeout(vscode.workspace.fs.readFile(uri), timeout)
  if (!bytes) return null
  return new TextDecoder().decode(bytes)
}

async function withTimeout<T>(promise: PromiseLike<T>, timeout: number): Promise<T | null> {
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ])
  } catch (err) {
    void err
    return null
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    void err
    return fallback
  }
}

function bounded(content: string): string {
  return content.split(/\r?\n/).slice(0, MAX_LINES).join("\n").slice(0, MAX_BYTES)
}

function active(cfg: QwenAutocompleteConfig): boolean {
  return qwenAutocompleteEnabled(cfg) && cfg.importDefinitionsEnabled
}

function trackable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && isQwenSupportedDocument(document)
}

function sensitive(file: string): boolean {
  return isQwenSecurityConcern(file)
}

function hidden(file: string): boolean {
  return file.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")
}

function documentFor(uri: vscode.Uri): vscode.TextDocument {
  return {
    uri,
    languageId: languageId(uri.fsPath || uri.path),
    version: 0,
    lineCount: 0,
    getText: () => "",
    lineAt: () => ({ text: "", range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) }),
  } as unknown as vscode.TextDocument
}

function languageId(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return ext === ".c" || ext === ".h" ? "c" : "cpp"
}

function offset(lines: string[], pos: Pos): number {
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character
}

function rangeInfo(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false
  const current = value as { start?: unknown; end?: unknown }
  return point(current.start) && point(current.end)
}

function point(value: unknown): value is Pos {
  if (!value || typeof value !== "object") return false
  const current = value as { line?: unknown; character?: unknown }
  return typeof current.line === "number" && typeof current.character === "number"
}
