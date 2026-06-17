import crypto from "node:crypto"
import path from "node:path"
import type Parser from "web-tree-sitter"
import * as vscode from "vscode"
import { getAst, getTreePathAtCursor } from "../autocomplete/continuedev/core/autocomplete/util/ast"
import { getFullLanguageName, getQueryForFile } from "../autocomplete/continuedev/core/util/treeSitter"
import { qwenAutocompleteEnabled } from "./config"
import { isQwenSecurityConcern, shouldGuardQwenContextDocument, type QwenSafetyGuard } from "./guard"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import { isQwenSupportedDocument } from "./prefilter"
import { QwenAutocompleteSnippetType, type QwenAutocompleteCodeSnippet } from "./snippets"
import type { QwenAutocompleteConfig, QwenRootPathBlockedReason } from "./types"
import { lookupQwenDefinitions, readQwenRange, type QwenDefinition } from "./vscodeDefinitionAdapter"

type Node = Parser.SyntaxNode
type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }

type Deps = {
  definitions?: (filepath: string, position: Pos, timeout: number) => Promise<QwenDefinition[]>
  guard?: QwenSafetyGuard
  path?: (helper: QwenAutocompleteHelperVars) => Promise<Node[] | undefined>
  query?: (filepath: string, node: Node) => Promise<Pos[] | undefined>
  readRange?: (filepath: string, range: Range, timeout: number) => Promise<string | null>
}

type Entry = {
  contents: string
  filepath: string
  range: Range
}

type Result = {
  blockedReason: QwenRootPathBlockedReason
  skippedCount: number
  snippets: QwenAutocompleteCodeSnippet[]
}

export type QwenRootPathSource = vscode.Disposable & {
  count(): number
  snippets(cfg: QwenAutocompleteConfig, helper: QwenAutocompleteHelperVars): Promise<Result>
}

const TYPES = new Set([
  "arrow_function",
  "generator_function_declaration",
  "program",
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
])

// Source mapping:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// root-path autocomplete context. qwen keeps this source default-off and
// computes AST paths only when the root-path context setting is active.
export class QwenRootPathTracker implements QwenRootPathSource {
  private readonly definitions: (filepath: string, position: Pos, timeout: number) => Promise<QwenDefinition[]>
  private readonly guard: QwenSafetyGuard
  private readonly path: (helper: QwenAutocompleteHelperVars) => Promise<Node[] | undefined>
  private readonly query: (filepath: string, node: Node) => Promise<Pos[] | undefined>
  private readonly ranges: (filepath: string, range: Range, timeout: number) => Promise<string | null>
  private readonly cache = new Map<string, Promise<Entry[]>>()

  constructor(deps: Deps = {}) {
    this.definitions = deps.definitions ?? lookupQwenDefinitions
    this.guard = deps.guard ?? shouldGuardQwenContextDocument
    this.path = deps.path ?? treePath
    this.query = deps.query ?? captures
    this.ranges = deps.readRange ?? readQwenRange
  }

  dispose(): void {
    this.cache.clear()
  }

  count(): number {
    return this.cache.size
  }

  async snippets(cfg: QwenAutocompleteConfig, helper: QwenAutocompleteHelperVars): Promise<Result> {
    if (!active(cfg)) return { blockedReason: "disabled", skippedCount: 0, snippets: [] }
    const path = await this.path(helper)
    if (!path) return { blockedReason: "missing-tree-path", skippedCount: 0, snippets: [] }
    const snippets: QwenAutocompleteCodeSnippet[] = []
    let skipped = 0
    let parent = helper.filepath
    for (const node of path.filter((item) => TYPES.has(item.type))) {
      const key = keyFor(parent, node)
      parent = key
      if (node.type === "program") continue
      const cached = this.cache.get(key)
      const task = cached ?? this.forNode(helper.filepath, node, cfg)
      if (!cached) {
        this.cache.set(key, task)
        this.prune(cfg)
      }
      const entries = await task
      for (const item of entries) {
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
    return { blockedReason: "none", skippedCount: skipped, snippets }
  }

  private async forNode(filepath: string, node: Node, cfg: QwenAutocompleteConfig): Promise<Entry[]> {
    const positions = await this.query(filepath, node)
    if (!positions) return []
    const entries = await Promise.all(positions.flatMap((pos) => this.readDefinitions(filepath, pos, cfg)))
    return entries.flat()
  }

  private async readDefinitions(filepath: string, position: Pos, cfg: QwenAutocompleteConfig): Promise<Entry[]> {
    const defs = await safe(() => this.definitions(filepath, position, cfg.rootPathTimeoutMs), [])
    const entries = await Promise.all(defs.map((def) => this.readDefinition(def, cfg)))
    return entries.flatMap((item) => (item ? [item] : []))
  }

  private async readDefinition(def: QwenDefinition, cfg: QwenAutocompleteConfig): Promise<Entry | null> {
    const uri = vscode.Uri.file(def.filepath)
    if (uri.scheme !== "file") return null
    if (sensitive(def.filepath) || hidden(def.filepath)) return null
    const doc = documentFor(uri)
    if (!isQwenSupportedDocument(doc)) return null
    if (await this.blocked(doc)) return null
    const contents = await this.ranges(def.filepath, def.range, cfg.rootPathTimeoutMs)
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
    while (this.cache.size > cfg.rootPathCacheSize) {
      const stale = this.cache.keys().next().value
      if (!stale) return
      this.cache.delete(stale)
    }
  }
}

export function keyFor(parent: string, node: Pick<Node, "startIndex" | "type">): string {
  return crypto.createHash("sha256").update(parent).update(node.type).update(String(node.startIndex)).digest("hex")
}

export function supportedRootPathNodeTypes(): Set<string> {
  return new Set(TYPES)
}

async function treePath(helper: QwenAutocompleteHelperVars): Promise<Node[] | undefined> {
  if (helper.treePath) return helper.treePath
  const ast = await getAst(helper.filepath, helper.fileContents)
  if (!ast) return undefined
  const index = helper.fullPrefix.length
  return getTreePathAtCursor(ast, index)
}

async function captures(filepath: string, node: Node): Promise<Pos[] | undefined> {
  const language = getFullLanguageName(filepath)
  if (!language) return undefined
  const query = await getQueryForFile(filepath, `root-path-context-queries/${language}/${node.type}.scm`)
  if (!query) return undefined
  return query.matches(node).flatMap((match) =>
    match.captures.map((item) => ({
      line: item.node.endPosition.row,
      character: item.node.endPosition.column,
    })),
  )
}

function active(cfg: QwenAutocompleteConfig): boolean {
  return qwenAutocompleteEnabled(cfg) && cfg.rootPathEnabled
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

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    void err
    return fallback
  }
}
