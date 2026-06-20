import crypto from "node:crypto"
import path from "node:path"
import type Parser from "web-tree-sitter"
import * as vscode from "vscode"
import { getAst, getTreePathAtCursor } from "../autocomplete/continuedev/core/autocomplete/util/ast"
import { getFullLanguageName, getQueryForFileWithStatus } from "../autocomplete/continuedev/core/util/treeSitter"
import { qwenAutocompleteEnabled } from "./config"
import { isQwenSecurityConcern, shouldGuardQwenContextDocument, type QwenSafetyGuard } from "./guard"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import { isQwenSupportedDocument } from "./prefilter"
import { QwenAutocompleteSnippetType, type QwenAutocompleteCodeSnippet } from "./snippets"
import { countTokens } from "./tokenPruning"
import type { QwenAutocompleteConfig, QwenRootPathBlockedReason } from "./types"
import { lookupQwenDefinitions, readQwenRange, type QwenDefinition } from "./vscodeDefinitionAdapter"

type Node = Parser.SyntaxNode
type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }
type NodeQueryResult = {
  blockedReason: QwenRootPathBlockedReason
  positions: Pos[]
  symbols?: string[]
  nodeTypes?: string[]
}

export type QwenRootPathGraphSymbol = {
  kind: "function" | "macro" | "type" | "global" | "field" | "file"
  name: string
  path: string
  startLine: number
  endLine: number
  signature?: string
  snippet: string
  score?: number
  reason?: string
}

export type QwenRootPathGraphProvider = {
  status(): { state?: string; enabled?: boolean }
  findSymbols(input: { query: string; relatedPath?: string; limit?: number }): Promise<QwenRootPathGraphSymbol[]>
}

export type QwenRootPathTracePhase =
  | "root-path:start"
  | "root-path:tree-path"
  | "root-path:c-query"
  | "root-path:receiver"
  | "root-path:type-chain"
  | "root-path:lsp-definition"
  | "root-path:codegraph"
  | "root-path:evidence-build"
  | "root-path:selected"

export type QwenRootPathTraceEntry = {
  phase: QwenRootPathTracePhase
  fields: Record<string, unknown>
}

export type QwenRootPathTraceSummary = {
  rootPathLanguage: string | null
  rootPathBackend: string
  rootPathCapturedSymbols: string
  rootPathEvidenceTokens: number
  rootPathCodeGraphSkippedReason: string
  rootPathBudgetTrimmed: boolean
  receiverTypeResolved: boolean
  fieldEvidenceSelected: boolean
  typedefChainSelected: boolean
}

type Deps = {
  definitions?: (filepath: string, position: Pos, timeout: number) => Promise<QwenDefinition[]>
  graph?: QwenRootPathGraphProvider
  guard?: QwenSafetyGuard
  path?: (helper: QwenAutocompleteHelperVars) => Promise<Node[] | undefined>
  query?: (filepath: string, node: Node) => Promise<NodeQueryResult>
  readRange?: (filepath: string, range: Range, timeout: number) => Promise<string | null>
}

type Entry = {
  contents: string
  filepath: string
  range: Range
  kind?: string
  name?: string
  reason?: string
  source?: "lsp" | "codegraph"
}

type Result = {
  blockedReason: QwenRootPathBlockedReason
  trace: QwenRootPathTraceEntry[]
  summary: QwenRootPathTraceSummary
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
// root-path autocomplete context. qwen keeps this source isolated from chat/QA
// and uses the same bundled tree-sitter assets as helper treePath resolution.
export class QwenRootPathTracker implements QwenRootPathSource {
  private readonly definitions: (filepath: string, position: Pos, timeout: number) => Promise<QwenDefinition[]>
  private readonly graph?: QwenRootPathGraphProvider
  private readonly guard: QwenSafetyGuard
  private readonly path: (helper: QwenAutocompleteHelperVars) => Promise<Node[] | undefined>
  private readonly query: (filepath: string, node: Node) => Promise<NodeQueryResult>
  private readonly ranges: (filepath: string, range: Range, timeout: number) => Promise<string | null>
  private readonly cache = new Map<string, Promise<{ blockedReason: QwenRootPathBlockedReason; entries: Entry[] }>>()

  constructor(deps: Deps = {}) {
    this.definitions = deps.definitions ?? lookupQwenDefinitions
    this.graph = deps.graph
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
    const language = getFullLanguageName(helper.filepath) ?? null
    const trace: QwenRootPathTraceEntry[] = []
    const summary = emptySummary(language)
    const started = Date.now()
    push(trace, "root-path:start", {
      rootPathLanguage: language,
      maxPromptTokens: cfg.maxPromptTokens,
      rootPathBudgetTokens: rootPathBudget(cfg),
      rootPathCacheSize: cfg.rootPathCacheSize,
    })
    if (!active(cfg)) return { blockedReason: "disabled", trace, summary, skippedCount: 0, snippets: [] }
    const path = await this.path(helper)
    push(trace, "root-path:tree-path", {
      treePathStatus: helper.treePathStatus,
      treePathDepth: path?.length ?? 0,
      nodeTypes: path?.map((node) => node.type).join(">") ?? "",
      elapsedMs: Date.now() - started,
    })
    if (!path) {
      if (!helper.treePath && helper.treePathStatus !== "ready") {
        return {
          blockedReason: helper.treePathStatus === "not-requested" ? "missing-tree-path" : "error",
          trace,
          summary,
          skippedCount: 0,
          snippets: [],
        }
      }
      return { blockedReason: "missing-tree-path", trace, summary, skippedCount: 0, snippets: [] }
    }
    const entries: Entry[] = []
    let skipped = 0
    let parent = helper.filepath
    for (const node of path.filter((item) => TYPES.has(item.type))) {
      const key = keyFor(parent, node)
      parent = key
      if (node.type === "program") continue
      const cached = language === "c" ? undefined : this.cache.get(key)
      const task = cached ?? this.forNode(helper.filepath, node, cfg, trace)
      if (!cached && language !== "c") {
        this.cache.set(key, task)
        this.prune(cfg)
      }
      const result = await task
      if (result.blockedReason !== "none") return { blockedReason: result.blockedReason, trace, summary, skippedCount: skipped, snippets: [] }
      entries.push(...result.entries)
    }
    if (language === "c") {
      entries.push(...await this.cEvidence(cfg, helper, path, trace, summary))
      const compact = compactCEntries(entries, cfg, summary, trace)
      skipped += compact.skipped
      return { blockedReason: "none", trace, summary, skippedCount: skipped, snippets: compact.snippets }
    }
    const snippets: QwenAutocompleteCodeSnippet[] = []
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
    summary.rootPathBackend = entries.length > 0 ? "lsp" : "none"
    summary.rootPathEvidenceTokens = snippets.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0)
    return { blockedReason: "none", trace, summary, skippedCount: skipped, snippets }
  }

  private async forNode(
    filepath: string,
    node: Node,
    cfg: QwenAutocompleteConfig,
    trace?: QwenRootPathTraceEntry[],
  ): Promise<{ blockedReason: QwenRootPathBlockedReason; entries: Entry[] }> {
    const query = await this.query(filepath, node)
    if (query.blockedReason !== "none") return { blockedReason: query.blockedReason, entries: [] }
    if (trace && getFullLanguageName(filepath) === "c") {
      push(trace, "root-path:c-query", {
        nodeType: node.type,
        captureCount: query.positions.length,
        capturedSymbols: unique(query.symbols ?? []).join(","),
        captureNodeTypes: unique(query.nodeTypes ?? []).join(","),
      })
    }
    const entries = await Promise.all(query.positions.flatMap((pos) => this.readDefinitions(filepath, pos, cfg)))
    if (trace && getFullLanguageName(filepath) === "c") {
      push(trace, "root-path:lsp-definition", {
        requestedPositions: query.positions.length,
        definitionEntryCount: entries.flat().length,
        requestedSymbols: unique(query.symbols ?? []).join(","),
      })
    }
    return { blockedReason: "none", entries: entries.flat() }
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
    return { contents, filepath: def.filepath, range: def.range, source: "lsp" }
  }

  private async cEvidence(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    path: Node[],
    trace: QwenRootPathTraceEntry[],
    summary: QwenRootPathTraceSummary,
  ): Promise<Entry[]> {
    const receiver = resolveReceiver(helper, path)
    const receiverTypes = receiver.types.flatMap((type) => normalizeTypeNames(type.raw))
    summary.receiverTypeResolved = receiverTypes.length > 0
    push(trace, "root-path:receiver", {
      memberAccessDetected: receiver.detected,
      memberOperator: receiver.operator ?? "",
      receiverName: receiver.name ?? "",
      fieldPrefix: receiver.fieldPrefix ?? "",
      resolverStatus: receiver.status,
      candidateTypes: unique(receiverTypes).join(","),
      sourceKind: unique(receiver.types.map((type) => type.source)).join(","),
      confidence: receiverTypes.length > 0 ? "high" : "none",
    })
    push(trace, "root-path:type-chain", {
      rawTypes: receiver.types.map((type) => type.raw).join(","),
      selectedTypeNames: unique(receiverTypes).join(","),
      aliasChain: "",
      droppedTypeNames: "",
      dropReasons: "",
    })
    const graph = await this.graphEvidence(cfg, helper, receiver, receiverTypes, trace, summary)
    return graph
  }

  private async graphEvidence(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    receiver: ReceiverResolution,
    receiverTypes: string[],
    trace: QwenRootPathTraceEntry[],
    summary: QwenRootPathTraceSummary,
  ): Promise<Entry[]> {
    const graphStarted = Date.now()
    if (!this.graph) {
      summary.rootPathCodeGraphSkippedReason = "not-configured"
      push(trace, "root-path:codegraph", { enabled: false, skippedReason: "not-configured", elapsedMs: 0 })
      return []
    }
    const status = safeSync(() => this.graph?.status())
    if (status?.state !== "ready") {
      summary.rootPathCodeGraphSkippedReason = status?.state ? `status-${status.state}` : "status-unknown"
      push(trace, "root-path:codegraph", {
        enabled: true,
        statusState: status?.state ?? "unknown",
        skippedReason: summary.rootPathCodeGraphSkippedReason,
        elapsedMs: Date.now() - graphStarted,
      })
      return []
    }
    const queryNames = unique([
      ...receiverTypes,
      ...nearbyExactIdentifiers(helper.fullPrefix),
    ]).slice(0, 8)
    const selected: QwenRootPathGraphSymbol[] = []
    let candidateCount = 0
    try {
      for (const name of queryNames) {
        const symbols = await withTimeout(
          this.graph.findSymbols({ query: name, relatedPath: helper.filepath, limit: 12 }),
          cfg.rootPathTimeoutMs,
        )
        candidateCount += symbols.length
        selected.push(...selectExactGraphSymbols(symbols, {
          fieldPrefix: receiver.fieldPrefix,
          receiverTypes,
          query: name,
        }))
      }
      if (receiver.fieldPrefix) {
        const fields = await withTimeout(
          this.graph.findSymbols({ query: receiver.fieldPrefix, relatedPath: helper.filepath, limit: 20 }),
          cfg.rootPathTimeoutMs,
        )
        candidateCount += fields.length
        selected.push(...selectExactGraphSymbols(fields, {
          fieldPrefix: receiver.fieldPrefix,
          receiverTypes,
          query: receiver.fieldPrefix,
        }))
      }
    } catch (err) {
      summary.rootPathCodeGraphSkippedReason = errorMessage(err).includes("timeout") ? "timeout" : "error"
      push(trace, "root-path:codegraph", {
        enabled: true,
        statusState: "ready",
        skippedReason: summary.rootPathCodeGraphSkippedReason,
        candidateCount,
        elapsedMs: Date.now() - graphStarted,
      })
      return []
    }
    const deduped = uniqueGraphSymbols(selected).slice(0, 8)
    summary.fieldEvidenceSelected = deduped.some((symbol) => symbol.kind === "field")
    summary.typedefChainSelected = deduped.some((symbol) => symbol.kind === "type" && /\btypedef\b/.test(symbol.snippet))
    summary.rootPathCodeGraphSkippedReason = deduped.length > 0 ? "none" : "no-exact-candidates"
    push(trace, "root-path:codegraph", {
      enabled: true,
      statusState: "ready",
      skippedReason: summary.rootPathCodeGraphSkippedReason,
      queryNames: queryNames.join(","),
      candidateCount,
      selectedCount: deduped.length,
      selectedKinds: unique(deduped.map((symbol) => symbol.kind)).join(","),
      selectedSymbols: deduped.map((symbol) => symbol.name).join(","),
      elapsedMs: Date.now() - graphStarted,
    })
    return deduped.map((symbol) => ({
      contents: symbol.snippet,
      filepath: symbol.path,
      kind: symbol.kind,
      name: symbol.name,
      range: {
        start: { line: Math.max(0, symbol.startLine - 1), character: 0 },
        end: { line: Math.max(0, symbol.endLine - 1), character: 0 },
      },
      reason: symbol.reason,
      source: "codegraph" as const,
    }))
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

async function captures(filepath: string, node: Node): Promise<NodeQueryResult> {
  const language = getFullLanguageName(filepath)
  if (!language) return { blockedReason: "error", positions: [] }
  const query = await getQueryForFileWithStatus(filepath, `root-path-context-queries/${language}/${node.type}.scm`)
  if (!query.query) {
    if (query.status === "missing-query-asset") return { blockedReason: "missing-query-asset", positions: [] }
    if (query.status === "query-load-failed") return { blockedReason: "query-load-failed", positions: [] }
    return { blockedReason: "error", positions: [] }
  }
  return {
    blockedReason: "none",
    nodeTypes: query.query.matches(node).flatMap((match) => match.captures.map((item) => item.node.type)),
    positions: query.query.matches(node).flatMap((match) =>
      match.captures.map((item) => ({
        line: item.node.endPosition.row,
        character: item.node.endPosition.column,
      })),
    ),
    symbols: query.query.matches(node).flatMap((match) => match.captures.map((item) => item.node.text.trim()).filter(Boolean)),
  }
}

type ReceiverTypeCandidate = {
  raw: string
  source: "parameter" | "local" | "prefix-window"
}

type ReceiverResolution = {
  detected: boolean
  fieldPrefix?: string
  name?: string
  operator?: "." | "->"
  status: "not-member-access" | "resolved" | "unresolved"
  types: ReceiverTypeCandidate[]
}

function emptySummary(language: string | null): QwenRootPathTraceSummary {
  return {
    rootPathLanguage: language,
    rootPathBackend: "none",
    rootPathCapturedSymbols: "",
    rootPathEvidenceTokens: 0,
    rootPathCodeGraphSkippedReason: "not-run",
    rootPathBudgetTrimmed: false,
    receiverTypeResolved: false,
    fieldEvidenceSelected: false,
    typedefChainSelected: false,
  }
}

function rootPathBudget(cfg: QwenAutocompleteConfig): number {
  return Math.max(0, Math.min(512, Math.floor(cfg.maxPromptTokens * 0.5)))
}

function push(trace: QwenRootPathTraceEntry[], phase: QwenRootPathTracePhase, fields: Record<string, unknown>): void {
  trace.push({ phase, fields })
}

function resolveReceiver(helper: QwenAutocompleteHelperVars, path: Node[]): ReceiverResolution {
  const tail = helper.fullPrefix.slice(-300)
  const match = /([A-Za-z_]\w*)\s*(->|\.)\s*([A-Za-z_]\w*)?$/.exec(tail)
  if (!match) return { detected: false, status: "not-member-access", types: [] }
  const name = match[1]
  const operator = match[2] as "." | "->"
  const fieldPrefix = match[3] ?? ""
  const scope = currentFunctionPrefix(helper, path)
  const types = receiverTypesFromText(scope, name)
  return {
    detected: true,
    fieldPrefix,
    name,
    operator,
    status: types.length > 0 ? "resolved" : "unresolved",
    types,
  }
}

function currentFunctionPrefix(helper: QwenAutocompleteHelperVars, path: Node[]): string {
  const current = [...path].reverse().find((node) => node.type === "function_definition")
  if (!current) return helper.fullPrefix.slice(-4000)
  return helper.fileContents.slice(current.startIndex, Math.min(helper.fullPrefix.length, current.endIndex))
}

export function receiverTypesFromText(text: string, receiver: string): ReceiverTypeCandidate[] {
  const out: ReceiverTypeCandidate[] = []
  const receiverPattern = new RegExp(`\\b${escapeRegExp(receiver)}\\b`)
  const lines = text.split(/\r?\n/)
  let beforeBody = true
  for (const line of lines) {
    if (!receiverPattern.test(line)) {
      if (line.includes("{")) beforeBody = false
      continue
    }
    const index = line.search(receiverPattern)
    const before = line.slice(0, index)
    const raw = declarationPrefix(before)
    if (raw && normalizeTypeNames(raw).length > 0) {
      out.push({ raw, source: beforeBody ? "parameter" : "local" })
    }
    if (line.includes("{")) beforeBody = false
  }
  if (out.length > 0) return dedupeReceiverTypes(out)
  const compact = text.slice(-1200)
  const index = compact.search(receiverPattern)
  if (index === -1) return []
  const raw = declarationPrefix(compact.slice(0, index))
  return raw ? dedupeReceiverTypes([{ raw, source: "prefix-window" }]) : []
}

function declarationPrefix(beforeReceiver: string): string | null {
  const lastBreak = Math.max(
    beforeReceiver.lastIndexOf(";"),
    beforeReceiver.lastIndexOf("{"),
    beforeReceiver.lastIndexOf("}"),
    beforeReceiver.lastIndexOf("\n"),
  )
  let raw = beforeReceiver.slice(lastBreak + 1).trim()
  const lastParam = Math.max(raw.lastIndexOf("("), raw.lastIndexOf(","))
  if (lastParam >= 0) raw = raw.slice(lastParam + 1).trim()
  raw = raw.replace(/[=*]+$/, "").trim()
  if (!raw || /\b(?:return|if|while|for|switch|case|sizeof)\b/.test(raw)) return null
  return raw
}

function dedupeReceiverTypes(types: ReceiverTypeCandidate[]): ReceiverTypeCandidate[] {
  const seen = new Set<string>()
  const out: ReceiverTypeCandidate[] = []
  for (const type of types) {
    const names = normalizeTypeNames(type.raw)
    const key = names.join("|")
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(type)
  }
  return out
}

export function normalizeTypeNames(raw: string): string[] {
  const text = raw
    .replace(/\b(?:const|volatile|restrict|static|register|extern|inline|signed|unsigned|long|short)\b/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const tagged = [...text.matchAll(/\b(?:struct|union|enum)\s+([A-Za-z_]\w*)/g)].map((match) => match[1])
  const words = text
    .replace(/\b(?:struct|union|enum)\s+[A-Za-z_]\w*/g, " ")
    .split(/\s+/)
    .filter((word) => word && !PRIMITIVE_TYPES.has(word) && !CONTROL_WORDS.has(word))
  return unique([...tagged, ...words])
}

function nearbyExactIdentifiers(prefix: string): string[] {
  return unique(
    [...prefix.slice(-500).matchAll(/\b[A-Z_][A-Z0-9_]{2,}\b/g)]
      .map((match) => match[0])
      .filter((name) => !PRIMITIVE_TYPES.has(name.toLowerCase())),
  ).slice(0, 4)
}

function selectExactGraphSymbols(
  symbols: QwenRootPathGraphSymbol[],
  input: { fieldPrefix?: string; query: string; receiverTypes: string[] },
): QwenRootPathGraphSymbol[] {
  const query = input.query.toLowerCase()
  const receiverTypes = input.receiverTypes.map((item) => item.toLowerCase())
  const fieldPrefix = input.fieldPrefix?.toLowerCase() ?? ""
  return symbols.filter((symbol) => {
    const name = symbol.name.toLowerCase()
    if (symbol.kind === "type") return name === query || receiverTypes.includes(name) || typeSnippetMatches(symbol.snippet, receiverTypes)
    if (symbol.kind === "field") {
      const signature = symbol.signature?.toLowerCase() ?? ""
      const ownerMatches = receiverTypes.length === 0 || receiverTypes.some((type) => signature.startsWith(`${type}.`) || signature.startsWith(`${type}:`))
      const fieldMatches = !fieldPrefix || name.startsWith(fieldPrefix) || snakePrefix(name, fieldPrefix)
      return ownerMatches && fieldMatches
    }
    if (symbol.kind === "macro" || symbol.kind === "function" || symbol.kind === "global") return name === query
    return false
  })
}

function typeSnippetMatches(snippet: string, receiverTypes: string[]): boolean {
  const lower = snippet.toLowerCase()
  return receiverTypes.some((type) => new RegExp(`\\b(?:struct|union|enum|typedef)?\\s*${escapeRegExp(type)}\\b`).test(lower))
}

function snakePrefix(name: string, prefix: string): boolean {
  if (!prefix) return true
  const compact = name.split("_").map((part) => part[0] ?? "").join("")
  return compact.startsWith(prefix)
}

function uniqueGraphSymbols(symbols: QwenRootPathGraphSymbol[]): QwenRootPathGraphSymbol[] {
  const seen = new Set<string>()
  const sorted = [...symbols].sort((left, right) => {
    const rank = kindRank(left.kind) - kindRank(right.kind)
    return rank || (right.score ?? 0) - (left.score ?? 0) || left.path.localeCompare(right.path) || left.startLine - right.startLine
  })
  const out: QwenRootPathGraphSymbol[] = []
  for (const symbol of sorted) {
    const key = `${symbol.kind}:${symbol.path}:${symbol.name}:${symbol.startLine}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(symbol)
  }
  return out
}

function kindRank(kind: QwenRootPathGraphSymbol["kind"]): number {
  if (kind === "type") return 0
  if (kind === "field") return 1
  if (kind === "function") return 2
  if (kind === "macro") return 3
  if (kind === "global") return 4
  return 9
}

function compactCEntries(
  entries: Entry[],
  cfg: QwenAutocompleteConfig,
  summary: QwenRootPathTraceSummary,
  trace: QwenRootPathTraceEntry[],
): { skipped: number; snippets: QwenAutocompleteCodeSnippet[] } {
  const budget = rootPathBudget(cfg)
  const perItem = 192
  const byFile = new Map<string, string[]>()
  let rawTokens = 0
  let skipped = 0
  let used = 0
  for (const entry of entries) {
    const compact = compactCContent(entry.contents, perItem, cfg.model)
    const tokens = countTokens(compact, cfg.model)
    rawTokens += countTokens(entry.contents, cfg.model)
    if (!compact.trim() || tokens <= 0) {
      skipped++
      continue
    }
    if (used + tokens > budget) {
      summary.rootPathBudgetTrimmed = true
      skipped++
      continue
    }
    used += tokens
    const current = byFile.get(entry.filepath) ?? []
    current.push(compact)
    byFile.set(entry.filepath, current)
    if (byFile.size >= 4 && used >= budget) break
  }
  const snippets = [...byFile.entries()].slice(0, 4).map(([filepath, contents]) => ({
    filepath,
    content: unique(contents).join("\n"),
    type: QwenAutocompleteSnippetType.Code,
  }))
  summary.rootPathEvidenceTokens = snippets.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0)
  summary.rootPathBackend = backendFor(entries)
  summary.rootPathCapturedSymbols = unique(entries.map((entry) => entry.name ?? "").filter(Boolean)).join(",")
  push(trace, "root-path:evidence-build", {
    rawEvidenceCount: entries.length,
    compactedEvidenceCount: snippets.length,
    rawEvidenceTokens: rawTokens,
    totalTokens: summary.rootPathEvidenceTokens,
    budgetTokens: budget,
    trimmed: summary.rootPathBudgetTrimmed,
    contentHashes: snippets.map((snippet) => contentHash(snippet.content)).join(","),
  })
  return { skipped, snippets }
}

function compactCContent(content: string, maxTokens: number, model: string): string {
  const text = content.trim()
  const struct = compactStruct(text)
  const compact = struct ?? compactPrototypeOrMacro(text)
  if (countTokens(compact, model) <= maxTokens) return compact
  return compact.split(/\r?\n/).slice(0, 8).join("\n")
}

function compactStruct(text: string): string | null {
  const header = /\b(?:typedef\s+)?(struct|union|enum)\s+([A-Za-z_]\w*)?/.exec(text)
  if (!header || !text.includes("{")) return null
  const alias = /\}\s*([A-Za-z_]\w*)\s*;/.exec(text)?.[1]
  const name = alias ?? header[2] ?? header[1]
  const fields = [...text.matchAll(/^\s*([^#;{}][^;{}]*?)\s+(\**\s*[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?::\s*\d+)?;/gm)]
    .map((match) => `${match[2].replace(/\s+/g, "")}: ${match[1].trim().replace(/\s+/g, " ")}`)
    .slice(0, 24)
  if (fields.length === 0) return text.split(/\r?\n/).slice(0, 10).join("\n")
  return [`type: ${name}`, `fields: ${fields.join(", ")}`].join("\n")
}

function compactPrototypeOrMacro(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const macro = lines.find((line) => line.startsWith("#define"))
  if (macro) return macro
  const joined = lines.join(" ").replace(/\s+/g, " ")
  const beforeBody = joined.includes("{") ? joined.slice(0, joined.indexOf("{")).trim() + ";" : joined
  return beforeBody.length > 800 ? beforeBody.slice(0, 800) : beforeBody
}

function backendFor(entries: Entry[]): string {
  const sources = unique(entries.map((entry) => entry.source ?? "lsp"))
  if (sources.length === 0) return "none"
  return sources.sort().join("+")
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function safeSync<T>(fn: () => T | undefined): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const CONTROL_WORDS = new Set(["if", "while", "for", "switch", "return", "sizeof", "case"])
const PRIMITIVE_TYPES = new Set([
  "void",
  "char",
  "short",
  "int",
  "long",
  "float",
  "double",
  "signed",
  "unsigned",
  "bool",
  "_Bool",
  "size_t",
  "ssize_t",
])

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
