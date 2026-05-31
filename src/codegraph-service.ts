import * as crypto from "node:crypto"
import * as vscode from "vscode"
import { detectCodeGraphAnalyzer, type CodeGraphAnalyzerStatus } from "./codegraph-analyzer"
import { parseCFileWithAst } from "./codegraph-ast"
import { parseCFile } from "./codegraph-c-parser"
import {
  buildIndexStats,
  CURRENT_CODE_GRAPH_INDEX_VERSION,
  groupFilesByShard,
  hydrateCodeGraphIndexAsync,
  shardInfo,
} from "./codegraph-index"
import { buildCodeGraphContext } from "./codegraph-query"
import type {
  CodeGraphFile,
  CodeGraphIndex,
  CodeGraphPromptContext,
  CodeGraphQueryMetrics,
  CodeGraphShardData,
  CodeGraphShardManifest,
} from "./codegraph-types"
import type { CodeGraphStatus, RemoteSettings } from "./types"

const INDEX_VERSION = CURRENT_CODE_GRAPH_INDEX_VERSION
const INDEX_TIME_SLICE_MS = 35
const SOURCE_GLOB = "**/*.{c,h,cc,cpp,cxx,hpp,hxx}"
const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/.vscode-test/**",
  "**/.opencode/**",
]

export class LocalCodeGraphService implements vscode.Disposable {
  private index?: CodeGraphIndex
  private analyzer?: CodeGraphAnalyzerStatus
  private statusValue: CodeGraphStatus = disabledStatus()
  private watcher?: vscode.FileSystemWatcher
  private indexing?: Promise<void>
  private loadingIndex?: Promise<void>
  private pendingChanges = new Map<string, { uri: vscode.Uri; deleted: boolean }>()
  private changeTimer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly getSettings: () => RemoteSettings,
    private readonly onStatusChanged: () => void,
  ) {}

  dispose() {
    this.disposed = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.watcher?.dispose()
  }

  status() {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) return disabledStatus()
    return this.statusValue
  }

  async maybePromptAndIndex() {
    const settings = this.getSettings()
    if (!vscode.workspace.workspaceFolders?.length) {
      this.setStatus(disabledStatus("No workspace folder is open."))
      return
    }
    if (!settings.codeGraph.enabled) {
      this.setStatus(disabledStatus())
      return
    }

    this.startWatcher()
    this.setStatus({
      state: "indexing",
      enabled: true,
      detail: "Queued local C/C++ code graph indexing.",
      indexedFiles: this.statusValue.indexedFiles,
      indexedFunctions: this.statusValue.indexedFunctions,
      indexedMacros: this.statusValue.indexedMacros,
      truncated: this.statusValue.truncated,
      updatedAt: this.statusValue.updatedAt,
      progress: this.statusValue.progress,
    })
    void this.indexWorkspace(false).catch((error) => this.reportIndexingFailure(error))
  }

  async indexWorkspace(force: boolean) {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) {
      await this.setEnabled(true)
    }
    if (this.indexing) return this.indexing
    this.indexing = this.runIndexTask(force).finally(() => {
      this.indexing = undefined
    })
    return this.indexing
  }

  async waitForReady() {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) return
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error("No workspace folder is open for local code graph indexing.")
    }

    let status = this.status()
    if (this.indexing && status.state !== "error") {
      await this.indexing
      status = this.status()
    }
    if (status.state === "ready") return
    if (status.state === "error") throw new Error(status.detail || "Local code graph indexing failed.")

    await this.indexWorkspace(false)
    const next = this.status()
    if (next.state === "ready") return
    if (next.state === "error") throw new Error(next.detail || "Local code graph indexing failed.")
    throw new Error(next.detail || `Local code graph is ${next.state}.`)
  }

  async showStatus() {
    const status = this.status()
    const updated = status.updatedAt ? ` Updated ${new Date(status.updatedAt).toLocaleString()}.` : ""
    const truncated = status.truncated ? " File limit reached; index is truncated." : ""
    const storage = status.storageMode ? ` Storage: ${status.storageMode}${status.shards ? `, ${status.shards} shard(s)` : ""}.` : ""
    const size = status.indexBytes ? ` Indexed source size: ${formatBytes(status.indexBytes)}.` : ""
    const skipped = status.skippedFiles ? ` Skipped ${status.skippedFiles} file(s).` : ""
    const analyzer = status.analysisMode
      ? ` Analyzer: ${status.analysisMode} on ${status.analyzerHost ?? "unknown"}${status.analyzerPlatform ? ` (${status.analyzerPlatform})` : ""}.`
      : ""
    const degraded = status.analyzerDegradedReason ? ` ${status.analyzerDegradedReason}` : ""
    await vscode.window.showInformationMessage(
      `Local code graph: ${status.state}. ${status.indexedFiles} file(s), ${status.indexedFunctions} function(s), ${status.indexedMacros} macro(s). ${status.detail}${updated}${truncated}${storage}${size}${skipped}${analyzer}${degraded}`.trim(),
    )
  }

  async buildContext(input: {
    question: string
    relatedPaths: string[]
    maxBytes: number
    maxDepth: number
    maxFanout: number
  }): Promise<CodeGraphPromptContext | undefined> {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) return undefined
    if (!this.index) await this.ensureIndexLoaded()
    if (!this.index) return undefined
    const context = buildCodeGraphContext({
      index: this.index,
      question: input.question,
      relatedPaths: input.relatedPaths,
      maxBytes: input.maxBytes,
      maxDepth: input.maxDepth,
      maxFanout: input.maxFanout,
    })
    if (context) this.output.appendLine(formatCodeGraphQueryMetrics(context.metrics))
    return context
  }

  private async runIndexTask(force: boolean) {
    await delay(0)
    await this.ensureIndexLoaded()
    await this.runIndex(force)
  }

  private async runIndex(force: boolean) {
    const root = workspaceRoot()
    if (!root) {
      this.setStatus(disabledStatus("No workspace folder is open."))
      return
    }

    const settings = this.getSettings()
    const budget = new WorkBudget()
    const started = Date.now()
    this.startWatcher()
    this.index ??= emptyIndex(root)
    this.analyzer = await detectCodeGraphAnalyzer(this.context, root, settings)
    this.setStatus({
      ...this.statusValue,
      state: "indexing",
      enabled: true,
      detail: force ? "Rebuilding local C/C++ code graph." : "Indexing local C/C++ code graph.",
      ...this.analyzerStatusFields(),
    })

    try {
      const ignoreGlobs = await workspaceIgnoreGlobs(root.uri)
      this.setStatus({
        ...this.statusValue,
        state: "indexing",
        enabled: true,
        detail: "Scanning local C/C++ files.",
        progress: { completed: 0, total: 0 },
      })
      const files = await vscode.workspace.findFiles(
        SOURCE_GLOB,
        excludeGlob([...settings.codeGraph.excludeGlobs, ...ignoreGlobs]),
        settings.codeGraph.maxFiles + 1,
      )
      await budget.yieldNow()
      this.output.appendLine(`[codegraph] scan ${Date.now() - started}ms, found ${Math.min(files.length, settings.codeGraph.maxFiles)} file(s)`)
      const truncated = files.length > settings.codeGraph.maxFiles
      const selected = files.slice(0, settings.codeGraph.maxFiles)
      const nextFiles: Record<string, CodeGraphFile> = {}
      let skippedFiles = 0
      this.setStatus({
        ...this.statusValue,
        state: "indexing",
        enabled: true,
        detail: `Indexed 0/${selected.length} C/C++ file(s).`,
        progress: { completed: 0, total: selected.length },
      })

      for (let index = 0; index < selected.length; index++) {
        if (this.disposed) return
        const uri = selected[index]
        const relative = workspaceRelativePath(uri)
        const bytes = await vscode.workspace.fs.readFile(uri)
        if (looksBinary(bytes)) {
          skippedFiles++
          continue
        }
        const hash = hashBytes(bytes)
        const existing = this.index?.files[relative]
        if (!force && existing?.hash === hash) {
          nextFiles[relative] = existing
        } else {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
          nextFiles[relative] = await this.parseCodeGraphFile({
            path: relative,
            text,
            hash,
            size: bytes.length,
          })
        }

        if (budget.shouldYield()) {
          this.setStatus({
            ...this.statusValue,
            state: "indexing",
            enabled: true,
            detail: `Indexed ${index + 1}/${selected.length} C/C++ file(s).`,
            progress: { completed: index + 1, total: selected.length },
          })
          await budget.yieldNow()
        }
      }

      this.setStatus({
        ...this.statusValue,
        state: "indexing",
        enabled: true,
        detail: `Building local code graph derived index for ${selected.length} C/C++ file(s).`,
        progress: { completed: selected.length, total: selected.length },
      })
      this.index = await hydrateCodeGraphIndexAsync({
        ...emptyIndex(root),
        files: nextFiles,
        truncated,
        updatedAt: Date.now(),
        storageMode: "sharded",
      }, skippedFiles, () => budget.yieldIfNeeded())
      await this.saveIndex(budget)
      this.output.appendLine(
        `[codegraph] indexed ${Object.keys(nextFiles).length} file(s), ${countFunctions(this.index)} function(s)${
          truncated ? " (truncated)" : ""
        } into ${this.index.stats?.shards ?? 0} shard(s) in ${Date.now() - started}ms`,
      )
      this.setReadyStatus("Local C/C++ code graph is ready.")
    } catch (error) {
      this.reportIndexingFailure(error)
    }
  }

  private startWatcher() {
    if (this.watcher || !vscode.workspace.workspaceFolders?.length) return
    this.watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB)
    this.context.subscriptions.push(this.watcher)
    const queueChange = (uri: vscode.Uri, deleted: boolean) => {
      if (!this.getSettings().codeGraph.enabled) return
      const path = workspaceRelativePath(uri)
      this.pendingChanges.set(path, { uri, deleted })
      this.setStatus({
        ...this.statusValue,
        state: "stale",
        enabled: true,
        detail: deleted ? "Workspace file deleted; incremental code graph update queued." : "Workspace changed; incremental code graph update queued.",
      })
      if (this.changeTimer) clearTimeout(this.changeTimer)
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined
        void this.applyPendingChanges()
      }, 800)
    }
    this.watcher.onDidChange((uri) => queueChange(uri, false))
    this.watcher.onDidCreate((uri) => queueChange(uri, false))
    this.watcher.onDidDelete((uri) => queueChange(uri, true))
  }

  private async applyPendingChanges() {
    if (this.disposed || this.pendingChanges.size === 0) return
    if (this.indexing) {
      if (!this.changeTimer) {
        this.changeTimer = setTimeout(() => {
          this.changeTimer = undefined
          void this.applyPendingChanges()
        }, 800)
      }
      return
    }
    const changes = [...this.pendingChanges.values()]
    this.pendingChanges.clear()
    this.indexing = this.runIncrementalIndex(changes).finally(() => {
      this.indexing = undefined
      if (this.pendingChanges.size > 0 && !this.changeTimer) {
        this.changeTimer = setTimeout(() => {
          this.changeTimer = undefined
          void this.applyPendingChanges()
        }, 800)
      }
    })
    await this.indexing
  }

  private async runIncrementalIndex(changes: { uri: vscode.Uri; deleted: boolean }[]) {
    const root = workspaceRoot()
    if (!root) {
      this.setStatus(disabledStatus("No workspace folder is open."))
      return
    }
    if (!this.index) await this.ensureIndexLoaded()
    if (!this.index) this.index = emptyIndex(root)

    const settings = this.getSettings()
    const budget = new WorkBudget()
    this.analyzer ??= await detectCodeGraphAnalyzer(this.context, root, settings)
    let skippedFiles = this.index.stats?.skippedFiles ?? 0
    this.setStatus({
      ...this.statusValue,
      state: "indexing",
      enabled: true,
      detail: `Updating ${changes.length} changed C/C++ file(s).`,
      progress: { completed: 0, total: changes.length },
      ...this.analyzerStatusFields(),
    })

    for (let index = 0; index < changes.length; index++) {
      if (this.disposed) return
      const change = changes[index]
      const relative = workspaceRelativePath(change.uri)
      if (change.deleted) {
        delete this.index.files[relative]
      } else {
        const fileCount = Object.keys(this.index.files).length
        if (!this.index.files[relative] && fileCount >= settings.codeGraph.maxFiles) {
          this.index.truncated = true
        } else {
          try {
            const bytes = await vscode.workspace.fs.readFile(change.uri)
            if (looksBinary(bytes)) {
              skippedFiles++
              delete this.index.files[relative]
            } else {
              const hash = hashBytes(bytes)
              if (this.index.files[relative]?.hash !== hash) {
                this.index.files[relative] = await this.parseCodeGraphFile({
                  path: relative,
                  text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
                  hash,
                  size: bytes.length,
                })
              }
            }
          } catch {
            delete this.index.files[relative]
          }
        }
      }

      this.setStatus({
        ...this.statusValue,
        state: "indexing",
        enabled: true,
        detail: `Updated ${index + 1}/${changes.length} changed C/C++ file(s).`,
        progress: { completed: index + 1, total: changes.length },
      })
      if (budget.shouldYield()) await budget.yieldNow()
    }

    this.index = await hydrateCodeGraphIndexAsync({
      ...this.index,
      version: INDEX_VERSION,
      updatedAt: Date.now(),
      storageMode: "sharded",
    }, skippedFiles, () => budget.yieldIfNeeded())
    await this.saveIndex(budget)
    this.output.appendLine(`[codegraph] incrementally updated ${changes.length} file change(s)`)
    this.setReadyStatus("Local C/C++ code graph is ready after incremental update.")
  }

  private async setEnabled(enabled: boolean) {
    await vscode.workspace
      .getConfiguration("opencode.remote")
      .update("codeGraph.enabled", enabled, vscode.ConfigurationTarget.Workspace)
    if (!enabled) this.setStatus(disabledStatus())
  }

  private async loadIndex() {
    const root = workspaceRoot()
    if (!root) return
    const budget = new WorkBudget()
    const started = Date.now()
    this.setStatus({
      ...this.statusValue,
      state: "indexing",
      enabled: this.getSettings().codeGraph.enabled,
      detail: "Loading stored local C/C++ code graph index.",
    })
    try {
      this.index = await this.loadShardedIndex(root, budget)
      this.output.appendLine(`[codegraph] loaded sharded index in ${Date.now() - started}ms`)
      this.setReadyStatus("Loaded local C/C++ code graph.")
    } catch {
      try {
        const bytes = await vscode.workspace.fs.readFile(this.legacyIndexUri(root))
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CodeGraphIndex
        if (parsed.rootPath !== root.uri.fsPath) return
        this.index = await hydrateCodeGraphIndexAsync({ ...parsed, storageMode: "sharded" }, parsed.stats?.skippedFiles ?? 0, () =>
          budget.yieldIfNeeded(),
        )
        await this.saveIndex(budget)
        this.output.appendLine(`[codegraph] migrated legacy index in ${Date.now() - started}ms`)
        this.setReadyStatus("Migrated local C/C++ code graph to sharded storage.")
      } catch {
        this.index = emptyIndex(root)
        this.setStatus({
          state: "stale",
          enabled: this.getSettings().codeGraph.enabled,
          detail: "No local code graph index exists yet.",
          indexedFiles: 0,
          indexedFunctions: 0,
          indexedMacros: 0,
          truncated: false,
        })
      }
    }
  }

  private async ensureIndexLoaded() {
    if (this.index) return
    this.loadingIndex ??= this.loadIndex().finally(() => {
      this.loadingIndex = undefined
    })
    await this.loadingIndex
  }

  private async saveIndex(budget = new WorkBudget()) {
    const root = workspaceRoot()
    if (!root || !this.index) return
    this.setStatus({
      ...this.statusValue,
      state: "indexing",
      enabled: true,
      detail: "Saving local C/C++ code graph index.",
    })
    this.index =
      this.index.derived && this.index.stats
        ? { ...this.index, storageMode: "sharded" }
        : await hydrateCodeGraphIndexAsync({ ...this.index, storageMode: "sharded" }, this.index.stats?.skippedFiles ?? 0, () =>
            budget.yieldIfNeeded(),
          )
    const dir = this.indexDir(root)
    const shardsDir = vscode.Uri.joinPath(dir, "shards")
    await vscode.workspace.fs.createDirectory(shardsDir)

    const groups = groupFilesByShard(this.index.files)
    const manifestShards = [...groups.entries()].map(([key, files]) => shardInfo(key, files))
    const nextShardNames = new Set(manifestShards.map((shard) => shard.path.replace(/^shards\//, "")))
    await this.cleanupOldShards(shardsDir, nextShardNames)

    for (const shard of manifestShards) {
      const files = groups.get(shard.key) ?? {}
      const payload: CodeGraphShardData = { version: INDEX_VERSION, key: shard.key, files }
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, ...shard.path.split("/")), encodeJson(payload))
      await budget.yieldIfNeeded()
    }

    const manifest: CodeGraphShardManifest = {
      version: INDEX_VERSION,
      rootPath: this.index.rootPath,
      rootName: this.index.rootName,
      updatedAt: this.index.updatedAt,
      truncated: this.index.truncated,
      derived: this.index.derived ?? {
        functionIdsByName: {},
        callerIdsByCallee: {},
        includeTargetsByFile: {},
        filePathsByInclude: {},
        directoryStats: {},
        symbolsByName: {},
        symbolsByPath: {},
        postingsByTerm: {},
        moduleStats: {},
      },
      stats: this.index.stats ?? buildIndexStats(this.index.files),
      shards: manifestShards,
    }
    await vscode.workspace.fs.writeFile(this.manifestUri(root), encodeJson(manifest))
  }

  private async loadShardedIndex(root: vscode.WorkspaceFolder, budget = new WorkBudget()): Promise<CodeGraphIndex> {
    const manifestBytes = await vscode.workspace.fs.readFile(this.manifestUri(root))
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as CodeGraphShardManifest
    if (!isSupportedStoredIndexVersion(manifest.version) || manifest.rootPath !== root.uri.fsPath) {
      throw new Error("Code graph manifest does not match this workspace.")
    }

    const files: Record<string, CodeGraphFile> = {}
    const dir = this.indexDir(root)
    for (let index = 0; index < manifest.shards.length; index++) {
      const shard = manifest.shards[index]
      const shardBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, ...shard.path.split("/")))
      const payload = JSON.parse(new TextDecoder().decode(shardBytes)) as CodeGraphShardData
      if (!isSupportedStoredIndexVersion(payload.version) || payload.key !== shard.key) continue
      Object.assign(files, payload.files)
      if (budget.shouldYield()) {
        this.setStatus({
          ...this.statusValue,
          state: "indexing",
          enabled: true,
          detail: `Loaded ${index + 1}/${manifest.shards.length} code graph shard(s).`,
          progress: { completed: index + 1, total: manifest.shards.length },
        })
        await budget.yieldNow()
      }
    }

    return {
      version: INDEX_VERSION,
      rootPath: manifest.rootPath,
      rootName: manifest.rootName,
      updatedAt: manifest.updatedAt,
      truncated: manifest.truncated,
      files,
      derived: manifest.derived,
      stats: manifest.stats,
      storageMode: "sharded",
    }
  }

  private async cleanupOldShards(shardsDir: vscode.Uri, nextShardNames: Set<string>) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(shardsDir)
      await Promise.all(
        entries
          .filter(([name, type]) => type === vscode.FileType.File && !nextShardNames.has(name))
          .map(([name]) => vscode.workspace.fs.delete(vscode.Uri.joinPath(shardsDir, name))),
      )
    } catch {
      // Directory may not exist on first save.
    }
  }

  private indexDir(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "codegraph", workspaceRootKey(root))
  }

  private manifestUri(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.indexDir(root), "manifest.json")
  }

  private legacyIndexUri(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "codegraph", `${workspaceRootKey(root)}.json`)
  }

  private setReadyStatus(detail: string) {
    const stats = this.index?.stats ?? (this.index ? buildIndexStats(this.index.files, this.index.stats?.skippedFiles ?? 0) : undefined)
    this.setStatus({
      state: "ready",
      enabled: true,
      detail,
      indexedFiles: stats?.files ?? (this.index ? Object.keys(this.index.files).length : 0),
      indexedFunctions: stats?.functions ?? (this.index ? countFunctions(this.index) : 0),
      indexedMacros: stats?.macros ?? (this.index ? countMacros(this.index) : 0),
      truncated: this.index?.truncated ?? false,
      updatedAt: this.index?.updatedAt,
      storageMode: this.index?.storageMode,
      shards: stats?.shards,
      indexBytes: stats?.bytes,
      skippedFiles: stats?.skippedFiles,
      largeRepoMode: Boolean(stats && (stats.files >= 10000 || stats.bytes >= 50 * 1024 * 1024)),
      ...this.analyzerStatusFields(),
    })
  }

  private reportIndexingFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const stats = this.index?.stats
    this.output.appendLine(`[codegraph] indexing failed: ${message}`)
    this.setStatus({
      state: "error",
      enabled: true,
      detail: message,
      indexedFiles: stats?.files ?? (this.index ? Object.keys(this.index.files).length : 0),
      indexedFunctions: stats?.functions ?? (this.index ? countFunctions(this.index) : 0),
      indexedMacros: stats?.macros ?? (this.index ? countMacros(this.index) : 0),
      truncated: this.index?.truncated ?? false,
      updatedAt: this.index?.updatedAt,
      storageMode: this.index?.storageMode,
      shards: stats?.shards,
      indexBytes: stats?.bytes,
      skippedFiles: stats?.skippedFiles,
    })
  }

  private setStatus(status: CodeGraphStatus) {
    this.statusValue = status
    this.onStatusChanged()
  }

  private async parseCodeGraphFile(input: {
    path: string
    text: string
    hash: string
    size: number
  }) {
    if (this.analyzer?.effectiveMode === "ast") {
      return parseCFileWithAst({
        ...input,
        extensionPath: this.context.extensionUri.fsPath,
      })
    }
    return parseCFile(input)
  }

  private analyzerStatusFields(): Partial<CodeGraphStatus> {
    const analyzer = this.analyzer
    if (!analyzer) return {}
    return {
      analysisMode: analyzer.effectiveMode,
      requestedAnalysisMode: analyzer.requestedMode,
      analyzerHost: analyzer.host,
      analyzerPlatform: analyzer.platform,
      analyzerDetail: analyzer.detail,
      analyzerDegradedReason: analyzer.degradedReason,
      compileCommandsPath: analyzer.compileCommandsPath,
    }
  }
}

function emptyIndex(root: vscode.WorkspaceFolder): CodeGraphIndex {
  return {
    version: INDEX_VERSION,
    rootPath: root.uri.fsPath,
    rootName: root.name,
    updatedAt: Date.now(),
    truncated: false,
    files: {},
    derived: {
      functionIdsByName: {},
      callerIdsByCallee: {},
      includeTargetsByFile: {},
      filePathsByInclude: {},
      directoryStats: {},
      symbolsByName: {},
      symbolsByPath: {},
      postingsByTerm: {},
      moduleStats: {},
    },
    stats: {
      files: 0,
      functions: 0,
      macros: 0,
      types: 0,
      globals: 0,
      bytes: 0,
      shards: 0,
      skippedFiles: 0,
    },
    storageMode: "sharded",
  }
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]
}

function workspaceRootKey(root = workspaceRoot()) {
  return crypto.createHash("sha1").update(root?.uri.fsPath ?? "no-workspace").digest("hex")
}

function workspaceRelativePath(uri: vscode.Uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")
}

function hashBytes(bytes: Uint8Array) {
  return crypto.createHash("sha1").update(bytes).digest("hex")
}

function excludeGlob(extra: string[]) {
  const patterns = [...DEFAULT_EXCLUDES, ...extra.filter(Boolean)]
  return `{${patterns.join(",")}}`
}

async function workspaceIgnoreGlobs(root: vscode.Uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".gitignore"))
    return new TextDecoder()
      .decode(bytes)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
      .slice(0, 200)
      .map((line) => {
        const clean = line.replace(/^\//, "")
        if (clean.endsWith("/")) return `**/${clean}**`
        if (clean.includes("*")) return `**/${clean}`
        return `**/${clean}`
      })
  } catch {
    return []
  }
}

function countFunctions(index: CodeGraphIndex) {
  return Object.values(index.files).reduce((count, file) => count + file.functions.length, 0)
}

function countMacros(index: CodeGraphIndex) {
  return Object.values(index.files).reduce((count, file) => count + file.macros.length, 0)
}

function disabledStatus(detail = "Local code graph is disabled."): CodeGraphStatus {
  return {
    state: "disabled",
    enabled: false,
    detail,
    indexedFiles: 0,
    indexedFunctions: 0,
    indexedMacros: 0,
    truncated: false,
  }
}

function formatCodeGraphQueryMetrics(metrics: CodeGraphQueryMetrics) {
  return [
    "[codegraph-query]",
    `mode=${metrics.mode}`,
    `tokens=${formatMetricList(metrics.tokens)}`,
    `seeds=${formatMetricList(metrics.symbols)}`,
    `candidates=${metrics.candidateCount}`,
    `evidence=${metrics.evidenceCount}`,
    `omitted=${metrics.omittedCandidates}`,
    `bytes=${metrics.packedBytes}`,
    `truncated=${metrics.truncated ? "true" : "false"}`,
    `elapsed=${metrics.elapsedMs}ms`,
  ].join(" ")
}

function formatMetricList(values: string[]) {
  if (values.length === 0) return "-"
  const visible = values.slice(0, 8).join(",")
  return values.length > 8 ? `${visible},+${values.length - 8}` : visible
}

function isSupportedStoredIndexVersion(version: number) {
  return version === 2 || version === INDEX_VERSION
}

function encodeJson(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function looksBinary(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  const sample = bytes.slice(0, Math.min(bytes.length, 4096))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length > 0.3
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class WorkBudget {
  private lastYield = Date.now()

  shouldYield() {
    return Date.now() - this.lastYield >= INDEX_TIME_SLICE_MS
  }

  async yieldIfNeeded() {
    if (this.shouldYield()) await this.yieldNow()
  }

  async yieldNow() {
    await delay(0)
    this.lastYield = Date.now()
  }
}
