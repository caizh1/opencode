import * as crypto from "node:crypto"
import * as childProcess from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { detectCodeGraphAnalyzer, type CodeGraphAnalyzerStatus } from "./codegraph-analyzer"
import { parseCFileWithAst } from "./codegraph-ast"
import { parseCFile } from "./codegraph-c-parser"
import {
  buildIndexStats,
  CURRENT_CODE_GRAPH_INDEX_VERSION,
  groupFilesByShard,
  hydrateCodeGraphIndexAsync,
  moduleKey,
  shardInfo,
  shardKeyForPath,
} from "./codegraph-index"
import { buildHybridCodeGraphContext } from "./codegraph-query"
import { CodeGraphHotCache, planShardKeysForQuery } from "./codegraph-shard-planner"
import { buildCodeIntelligenceSnapshot, queryEvidenceAsync, runAnalysisTool } from "./codegraph-analysis"
import { formatCodeGraphBenchmarkReport, runCodeGraphSyntheticBenchmark } from "./codegraph-benchmark"
import { CodeGraphWorkerPool } from "./codegraph-worker-host"
import {
  CODEGRAPH_STORAGE_BACKEND,
  CODEGRAPH_STORAGE_SCHEMA_VERSION,
  createCodeGraphStorageManifest,
} from "./codegraph-storage-schema"
import { LocalAnalysisJobQueue, recordStateTransition, type LocalAnalysisJob } from "./local-analysis-service"
import type { AnalysisToolName, AnalysisToolResult, CodeIntelligenceSnapshot, QueryEvidenceResult } from "./analysis-types"
import { extractStateMachines } from "./state-machine-extractor"
import { checkRagEndpoint, createHttpEmbeddingProvider, createHttpRerankProvider } from "./rag-provider"
import {
  buildRagVectorIndex,
  createRagSerializedManifest,
  decodeRagShardVectors,
  encodeRagShardVectors,
  splitRagVectorIndex,
  type RagSerializedManifest,
  type RagSerializedShardMetadata,
} from "./rag-index"
import type { EmbeddingProvider, HybridRetrievalOptions, RagVectorIndex, RerankProvider } from "./rag-types"
import type {
  CodeGraphFile,
  CodeGraphIndex,
  CodeGraphPromptContext,
  CodeGraphQueryMetrics,
  CodeGraphShardData,
  CodeGraphShardManifest,
} from "./codegraph-types"
import type { CodeGraphStatus, RagStatus, RemoteSettings } from "./types"

const INDEX_VERSION = CURRENT_CODE_GRAPH_INDEX_VERSION
const INDEX_TIME_SLICE_MS = 35
const STATE_TRANSITION_LIMIT = 25
const SOURCE_GLOB = "**/*.{c,h,cc,cpp,cxx,hpp,hxx}"
const SOURCE_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"])
const LARGE_INDEX_LAZY_FILE_THRESHOLD = 100000
const JOB_CHECKPOINT_VERSION = 1
const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/.vscode-test/**",
  "**/.opencode/**",
]
const execFile = promisify(childProcess.execFile)

type CodeGraphJobCheckpoint = {
  version: typeof JOB_CHECKPOINT_VERSION
  rootPath: string
  jobId: string
  kind: LocalAnalysisJob["kind"]
  detail: string
  queuedAt: number
  startedAt?: number
  updatedAt: number
  progress?: CodeGraphStatus["progress"]
  currentShard?: string
}

export class LocalCodeGraphService implements vscode.Disposable {
  private index?: CodeGraphIndex
  private analyzer?: CodeGraphAnalyzerStatus
  private statusValue: CodeGraphStatus = disabledStatus()
  private watcher?: vscode.FileSystemWatcher
  private indexing?: Promise<void>
  private loadingIndex?: Promise<void>
  private shardedManifest?: CodeGraphShardManifest
  private pendingChanges = new Map<string, { uri: vscode.Uri; deleted: boolean }>()
  private readonly jobs = new LocalAnalysisJobQueue()
  private readonly workerPool = new CodeGraphWorkerPool()
  private readonly transitions: NonNullable<CodeGraphStatus["transitions"]> = []
  private queryCache = new CodeGraphHotCache<string, CodeGraphPromptContext>(80)
  private shardCache = new CodeGraphHotCache<string, Record<string, CodeGraphFile>>(64)
  private ragIndex?: RagVectorIndex
  private ragEmbeddingProvider?: EmbeddingProvider
  private ragRerankProvider?: RerankProvider
  private lastRagElapsedMs: number | undefined
  private ragStatusValue = disabledRagStatus()
  private changeTimer?: ReturnType<typeof setTimeout>
  private rescanScheduled = false
  private cancelRequested = false
  private paused = false
  private errorCount = 0
  private disposed = false
  private lastAnalysisTrace: CodeIntelligenceSnapshot["lastTrace"]
  private readonly analysisAudit: NonNullable<CodeIntelligenceSnapshot["lastAudit"]> = []

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
    this.workerPool.dispose()
  }

  status() {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) return disabledStatus()
    return this.statusValue
  }

  metrics() {
    const settings = this.getSettings()
    const heapUsed = currentHeapUsed()
    const memoryLimitBytes = settings.codeGraph.memoryLimitMb * 1024 * 1024
    return this.jobs.metrics({
      schemaVersion: CODEGRAPH_STORAGE_SCHEMA_VERSION,
      serviceMode: this.workerPool.size() > 0 ? "worker-thread-pool" : "extension-host-worker",
      workerThreads: this.workerPool.size(),
      workerHealthy: this.workerPool.isHealthy(),
      memoryDegraded: heapUsed > memoryLimitBytes,
      memoryLimitBytes,
      heapUsedBytes: heapUsed,
      ragChunks: this.ragStatusValue.chunks,
      ragEmbeddedChunks: this.ragStatusValue.embeddedChunks,
      ragVectorShards: this.ragStatusValue.vectorShards,
      lastRagElapsedMs: this.lastRagElapsedMs,
    })
  }

  cancelIndexing(reason = "cancelled by user") {
    this.cancelRequested = true
    this.jobs.cancelActive(reason)
    this.jobs.clearPending()
    this.pendingChanges.clear()
    this.rescanScheduled = false
    this.setStatus({
      ...this.statusValue,
      state: "degraded",
      enabled: this.getSettings().codeGraph.enabled,
      detail: `Local code graph indexing cancelled: ${reason}.`,
    })
  }

  pauseIndexing(reason = "paused by user") {
    this.paused = true
    this.jobs.pause()
    this.setStatus({
      ...this.statusValue,
      state: "paused",
      enabled: this.getSettings().codeGraph.enabled,
      detail: `Local code graph indexing paused: ${reason}.`,
    })
  }

  resumeIndexing() {
    this.paused = false
    this.jobs.resume()
    this.setStatus({
      ...this.statusValue,
      state: this.pendingChanges.size > 0 || this.rescanScheduled ? "rescanScheduled" : "degraded",
      enabled: this.getSettings().codeGraph.enabled,
      detail: this.pendingChanges.size > 0 || this.rescanScheduled
        ? "Local code graph indexing resumed; queued changes will be processed."
        : "Local code graph indexing resumed.",
    })
    if (this.pendingChanges.size > 0 || this.rescanScheduled) void this.applyPendingChanges()
    else if (this.jobs.hasPending() && !this.indexing) {
      this.indexing = this.runQueuedIndexJobs().finally(() => {
        this.indexing = undefined
      })
    }
  }

  async benchmarkSyntheticRepository(files = 1000) {
    const report = runCodeGraphSyntheticBenchmark({ files })
    this.output.appendLine(`[codegraph-benchmark]\n${formatCodeGraphBenchmarkReport(report)}`)
    return report
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
      state: "indexingFull",
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
    this.jobs.enqueue({
      kind: "full-index",
      detail: force ? "Queued full code graph rebuild." : "Queued full code graph index refresh.",
      force,
      replacePendingKind: "full-index",
    })
    if (this.indexing) {
      this.setStatus({
        ...this.statusValue,
        state: this.paused ? "paused" : "rescanScheduled",
        enabled: true,
        detail: "Full code graph index refresh queued behind the active job.",
      })
      return this.indexing
    }
    this.indexing = this.runQueuedIndexJobs().finally(() => {
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
    const schema = status.schemaVersion ? ` Schema v${status.schemaVersion} (${status.storageBackend ?? "unknown"}).` : ""
    const queue = status.queue ? ` Queue: ${status.queue.pendingJobs} pending${status.queue.activeJobKind ? `, active ${status.queue.activeJobKind}` : ""}.` : ""
    const errors = status.errorCount ? ` Errors: ${status.errorCount}.` : ""
    const size = status.indexBytes ? ` Indexed source size: ${formatBytes(status.indexBytes)}.` : ""
    const skipped = status.skippedFiles ? ` Skipped ${status.skippedFiles} file(s).` : ""
    const analyzer = status.analysisMode
      ? ` Analyzer: ${status.analysisMode} on ${status.analyzerHost ?? "unknown"}${status.analyzerPlatform ? ` (${status.analyzerPlatform})` : ""}.`
      : ""
    const degraded = status.analyzerDegradedReason ? ` ${status.analyzerDegradedReason}` : ""
    const rag = status.rag?.embeddingEnabled
      ? ` RAG: ${status.rag.embeddedChunks}/${status.rag.chunks} chunk(s), ${status.rag.vectorShards} shard(s), ${status.rag.endpointKind}${status.rag.fallbackReason ? `, fallback ${status.rag.fallbackReason}` : ""}.`
      : " RAG: embedding disabled; BM25/graph/state-machine fallback active."
    await vscode.window.showInformationMessage(
      `Local code graph: ${status.state}. ${status.indexedFiles} file(s), ${status.indexedFunctions} function(s), ${status.indexedMacros} macro(s). ${status.detail}${updated}${truncated}${storage}${schema}${queue}${errors}${size}${skipped}${analyzer}${degraded}${rag}`.trim(),
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
    const activeIndex = await this.activeIndexForQuestion(input.question, input.relatedPaths)
    if (!activeIndex) return undefined
    this.resizeQueryCache(settings.codeGraph.queryCacheSize)
    const cacheKey = `${codeGraphQueryCacheKey(input)}:${this.ragIndex?.updatedAt ?? 0}:${settings.rag.embedding.enabled ? "rag" : "fallback"}`
    const cached = this.queryCache.get(cacheKey)
    if (cached) {
      this.jobs.recordQueryCacheHit()
      return cached
    }
    this.jobs.recordQueryCacheMiss()
    const shardPlan = planShardKeysForQuery({
      index: activeIndex,
      question: input.question,
      relatedPaths: input.relatedPaths,
      maxShards: Math.max(1, settings.codeGraph.maxDeepFiles),
    })
    const context = await buildHybridCodeGraphContext({
      index: activeIndex,
      question: input.question,
      relatedPaths: input.relatedPaths,
      maxBytes: input.maxBytes,
      maxDepth: input.maxDepth,
      maxFanout: input.maxFanout,
      hybrid: this.hybridOptions(),
    })
    if (context) {
      this.cacheQueryContext(cacheKey, context)
      this.output.appendLine(`${formatCodeGraphQueryMetrics(context.metrics)} shards=${shardPlan.shardKeys.join(",") || "-"} lazy=${shardPlan.lazy ? "true" : "false"}`)
    }
    return context
  }

  async intelligenceSnapshot(): Promise<CodeIntelligenceSnapshot | undefined> {
    if (!this.getSettings().codeGraph.enabled) return undefined
    if (!this.index) await this.ensureIndexLoaded()
    const activeIndex = await this.activeIndexForQuestion("", [])
    if (!activeIndex) return undefined
    return buildCodeIntelligenceSnapshot(activeIndex, this.lastAnalysisTrace, this.analysisAudit.slice(-50).reverse(), this.ragStatusValue)
  }

  async queryEvidence(question: string): Promise<QueryEvidenceResult | undefined> {
    if (!this.getSettings().codeGraph.enabled) return undefined
    if (!this.index) await this.ensureIndexLoaded()
    const activeIndex = await this.activeIndexForQuestion(question, [])
    if (!activeIndex) return undefined
    const settings = this.getSettings()
    const result = await queryEvidenceAsync(activeIndex, question, {
      maxEvidenceItems: settings.analysis.maxEvidenceItems,
      maxEvidenceBytes: settings.analysis.maxEvidenceBytes,
      maxFileSliceBytes: settings.analysis.maxFileSliceBytes,
      maxGraphEdges: settings.analysis.maxGraphEdges,
      maxPaths: settings.analysis.maxPaths,
    }, this.hybridOptions())
    this.lastAnalysisTrace = result.trace
    return result
  }

  async runAnalysisTool(input: {
    tool: AnalysisToolName
    args?: Record<string, unknown>
  }): Promise<AnalysisToolResult> {
    if (!this.index) await this.ensureIndexLoaded()
    const activeIndex = await this.activeIndexForQuestion(toolQuestion(input.tool, input.args ?? {}), [])
    if (!activeIndex) throw new Error("Local code graph index is not loaded.")
    const settings = this.getSettings()
    const result = await runAnalysisTool({
      index: activeIndex,
      tool: input.tool,
      args: input.args,
      budget: {
        maxEvidenceItems: settings.analysis.maxEvidenceItems,
        maxEvidenceBytes: settings.analysis.maxEvidenceBytes,
        maxFileSliceBytes: settings.analysis.maxFileSliceBytes,
        maxGraphEdges: settings.analysis.maxGraphEdges,
        maxPaths: settings.analysis.maxPaths,
      },
      readFileSlice: (slice) => this.readWorkspaceFileSlice(slice),
      hybrid: this.hybridOptions(),
    })
    this.analysisAudit.push(result.audit)
    if (this.analysisAudit.length > 200) this.analysisAudit.splice(0, this.analysisAudit.length - 200)
    if (input.tool === "queryEvidence" && result.data && typeof result.data === "object" && "trace" in result.data) {
      this.lastAnalysisTrace = (result.data as QueryEvidenceResult).trace
    }
    this.output.appendLine(
      `[analysis-tool] trace=${result.traceId} tool=${input.tool} ok=${result.ok ? "true" : "false"} evidence=${result.evidence.length} elapsed=${result.elapsedMs}ms${result.error ? ` error=${result.error}` : ""}`,
    )
    return result
  }

  private async runQueuedIndexJobs() {
    while (!this.disposed && this.jobs.hasPending()) {
      await this.waitWhilePaused()
      const job = this.jobs.startNext()
      if (!job) break
      try {
        this.cancelRequested = false
        await delay(0)
        await this.saveJobCheckpoint(job)
        await this.ensureIndexLoaded()
        if (job.kind === "full-index") await this.runIndex(Boolean(job.force), job)
        else if (job.kind === "incremental-index") await this.runIncrementalIndex(job.payload?.changes as { uri: vscode.Uri; deleted: boolean }[] ?? [], job)
        this.jobs.completeActive()
        await this.clearJobCheckpoint()
      } catch (error) {
        if (this.cancelRequested) {
          this.jobs.finishCancelled()
          await this.clearJobCheckpoint()
          this.cancelRequested = false
          this.setStatus({
            ...this.statusValue,
            state: "degraded",
            enabled: true,
            detail: error instanceof Error ? error.message : String(error),
          })
        } else {
          this.jobs.failActive()
          await this.clearJobCheckpoint()
          this.reportIndexingFailure(error)
        }
      }
    }
  }

  private async runIndex(force: boolean, job?: LocalAnalysisJob) {
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
    const workerStatus = await this.workerPool.health(settings.codeGraph.workerConcurrency)
    this.output.appendLine(
      `[codegraph-worker] healthy=${workerStatus.healthy ? "true" : "false"} workers=${workerStatus.workers}${workerStatus.error ? ` error=${workerStatus.error}` : ""}`,
    )
    this.setStatus({
      ...this.statusValue,
      state: "indexingFull",
      enabled: true,
      detail: force ? "Rebuilding local C/C++ code graph." : "Indexing local C/C++ code graph.",
      ...this.analyzerStatusFields(),
    })

    try {
      const ignoreGlobs = await workspaceIgnoreGlobs(root.uri)
      this.setStatus({
        ...this.statusValue,
        state: "indexingFull",
        enabled: true,
        detail: "Scanning local C/C++ files.",
        progress: { completed: 0, total: 0 },
      })
      const files = await discoverWorkspaceSourceFiles(root, settings, ignoreGlobs)
      await budget.yieldNow()
      this.output.appendLine(`[codegraph] scan ${Date.now() - started}ms, found ${Math.min(files.length, settings.codeGraph.maxFiles)} file(s)`)
      const truncated = files.length > settings.codeGraph.maxFiles
      const selected = files.slice(0, settings.codeGraph.maxFiles)
      const nextFiles: Record<string, CodeGraphFile> = {}
      let skippedFiles = 0
      this.setStatus({
        ...this.statusValue,
        state: "indexingFull",
        enabled: true,
        detail: `Indexed 0/${selected.length} C/C++ file(s).`,
        progress: { completed: 0, total: selected.length },
      })

      let completed = 0
      let cursor = 0
      const concurrency = Math.max(1, Math.min(settings.codeGraph.workerConcurrency, selected.length || 1))
      const parseNextFile = async () => {
        while (!this.disposed) {
          const index = cursor++
          if (index >= selected.length) return
          this.throwIfCancelled(job)
          await this.waitWhilePaused()
          this.throwIfCancelled(job)
          const uri = selected[index]
          const relative = workspaceRelativePath(uri)
          const bytes = await vscode.workspace.fs.readFile(uri)
          const stat = await workspaceFileStat(uri)
          if (looksBinary(bytes)) {
            skippedFiles++
            completed++
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
              mtime: stat?.mtime,
            })
          }

          completed++
          if (budget.shouldYield()) {
            this.setStatus({
              ...this.statusValue,
              state: "indexingFull",
              enabled: true,
              detail: `Indexed ${completed}/${selected.length} C/C++ file(s).`,
              progress: { completed, total: selected.length },
            })
            await budget.yieldNow()
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => parseNextFile()))
      if (this.disposed) return
      this.throwIfCancelled(job)
      this.setStatus({
        ...this.statusValue,
        state: "indexingFull",
        enabled: true,
        detail: `Indexed ${completed}/${selected.length} C/C++ file(s).`,
        progress: { completed, total: selected.length },
      })

      this.setStatus({
        ...this.statusValue,
        state: "indexingFull",
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
      this.index.schema = createCodeGraphStorageManifest(this.index)
      const savedStats = this.index.stats
      await this.saveIndex(budget)
      await this.refreshRagIndex()
      this.unloadColdShardsIfLarge()
      this.output.appendLine(
        `[codegraph] indexed ${savedStats?.files ?? Object.keys(nextFiles).length} file(s), ${savedStats?.functions ?? countFunctions(this.index)} function(s)${
          truncated ? " (truncated)" : ""
        } into ${savedStats?.shards ?? this.index.stats?.shards ?? 0} shard(s) in ${Date.now() - started}ms`,
      )
      this.setReadyStatus("Local C/C++ code graph is ready.")
    } catch (error) {
      throw error
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
      const threshold = this.getSettings().codeGraph.watcherRescanThreshold
      if (this.pendingChanges.size >= threshold) {
        this.rescanScheduled = true
        this.jobs.recordWatcherStorm()
      }
      this.setStatus({
        ...this.statusValue,
        state: this.rescanScheduled ? "rescanScheduled" : "degraded",
        enabled: true,
        detail: this.rescanScheduled
          ? `Watcher change storm detected (${this.pendingChanges.size} events); scheduled one bounded rescan.`
          : deleted
            ? "Workspace file deleted; incremental code graph update queued."
            : "Workspace changed; incremental code graph update queued.",
        queueLength: this.pendingChanges.size,
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
    if (this.paused) {
      this.setStatus({
        ...this.statusValue,
        state: "paused",
        enabled: true,
        detail: "Local code graph changes are queued while indexing is paused.",
      })
      return
    }
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
    if (this.rescanScheduled) {
      this.rescanScheduled = false
      this.jobs.enqueue({
        kind: "full-index",
        detail: `Queued full rescan for ${changes.length} watcher event(s).`,
        replacePendingKind: "full-index",
      })
    } else {
      this.jobs.enqueue({
        kind: "incremental-index",
        detail: `Queued incremental index for ${changes.length} file change(s).`,
        payload: { changes },
        replacePendingKind: "incremental-index",
      })
    }
    this.indexing = this.runQueuedIndexJobs().finally(() => {
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

  private async runIncrementalIndex(changes: { uri: vscode.Uri; deleted: boolean }[], job?: LocalAnalysisJob) {
    const root = workspaceRoot()
    if (!root) {
      this.setStatus(disabledStatus("No workspace folder is open."))
      return
    }
    if (!this.index) await this.ensureIndexLoaded()
    if (!this.index) this.index = emptyIndex(root)
    if (this.isLazyManifestIndex()) {
      this.jobs.enqueue({
        kind: "full-index",
        detail: "Queued full rescan because the large repository index is loaded in lazy shard mode.",
        replacePendingKind: "full-index",
      })
      this.setStatus({
        ...this.statusValue,
        state: "rescanScheduled",
        enabled: true,
        detail: "Large lazy code graph index received incremental changes; scheduled a bounded full rescan.",
        queueLength: this.jobs.snapshot().pendingJobs,
      })
      return
    }

    const settings = this.getSettings()
    const budget = new WorkBudget()
    this.analyzer ??= await detectCodeGraphAnalyzer(this.context, root, settings)
    let skippedFiles = this.index.stats?.skippedFiles ?? 0
    this.setStatus({
      ...this.statusValue,
      state: "indexingIncremental",
      enabled: true,
      detail: `Updating ${changes.length} changed C/C++ file(s).`,
      progress: { completed: 0, total: changes.length },
      ...this.analyzerStatusFields(),
    })

    for (let index = 0; index < changes.length; index++) {
      if (this.disposed) return
      this.throwIfCancelled(job)
      await this.waitWhilePaused()
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
            const stat = await workspaceFileStat(change.uri)
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
                  mtime: stat?.mtime,
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
        state: "indexingIncremental",
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
    this.index.schema = createCodeGraphStorageManifest(this.index)
    await this.saveIndex(budget)
    await this.refreshRagIndex(changes.map((change) => workspaceRelativePath(change.uri)))
    this.unloadColdShardsIfLarge()
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
      state: "recovering",
      enabled: this.getSettings().codeGraph.enabled,
      detail: "Loading stored local C/C++ code graph index.",
    })
    try {
      const checkpoint = await this.readJobCheckpoint(root)
      this.index = await this.loadShardedIndex(root, budget)
      await this.loadRagIndex(root)
      this.jobs.recordRecovery(Date.now() - started)
      this.output.appendLine(`[codegraph] loaded sharded index in ${Date.now() - started}ms`)
      await this.clearJobCheckpoint(root)
      this.setReadyStatus(
        checkpoint
          ? `Loaded local C/C++ code graph after recovering ${checkpoint.kind} checkpoint.`
          : "Loaded local C/C++ code graph.",
      )
    } catch {
      try {
        const checkpoint = await this.readJobCheckpoint(root)
        const bytes = await vscode.workspace.fs.readFile(this.legacyIndexUri(root))
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CodeGraphIndex
        if (parsed.rootPath !== root.uri.fsPath) return
        this.index = await hydrateCodeGraphIndexAsync({ ...parsed, storageMode: "sharded" }, parsed.stats?.skippedFiles ?? 0, () =>
          budget.yieldIfNeeded(),
        )
        this.index.schema = createCodeGraphStorageManifest(this.index)
        await this.saveIndex(budget)
        await this.loadRagIndex(root)
        this.jobs.recordRecovery(Date.now() - started)
        this.output.appendLine(`[codegraph] migrated legacy index in ${Date.now() - started}ms`)
        await this.clearJobCheckpoint(root)
        this.setReadyStatus(
          checkpoint
            ? `Migrated local C/C++ code graph after recovering ${checkpoint.kind} checkpoint.`
            : "Migrated local C/C++ code graph to sharded storage.",
        )
      } catch {
        this.index = emptyIndex(root)
        await this.clearJobCheckpoint(root)
        this.setStatus({
          state: "degraded",
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
      state: this.statusValue.state === "indexingIncremental" ? "indexingIncremental" : "indexingFull",
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
      this.setStatus({
        ...this.statusValue,
        detail: `Saving shard ${shard.key}.`,
        currentShard: shard.key,
      })
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
      schema: createCodeGraphStorageManifest(this.index),
      shards: manifestShards,
    }
    await vscode.workspace.fs.writeFile(this.manifestUri(root), encodeJson(manifest))
    this.shardedManifest = manifest
  }

  private async loadShardedIndex(root: vscode.WorkspaceFolder, budget = new WorkBudget()): Promise<CodeGraphIndex> {
    const manifestBytes = await vscode.workspace.fs.readFile(this.manifestUri(root))
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as CodeGraphShardManifest
    if (!isSupportedStoredIndexVersion(manifest.version) || manifest.rootPath !== root.uri.fsPath) {
      throw new Error("Code graph manifest does not match this workspace.")
    }
    this.shardedManifest = manifest

    if (manifest.stats.files >= LARGE_INDEX_LAZY_FILE_THRESHOLD && manifest.schema) {
      return {
        version: INDEX_VERSION,
        rootPath: manifest.rootPath,
        rootName: manifest.rootName,
        updatedAt: manifest.updatedAt,
        truncated: manifest.truncated,
        files: {},
        derived: manifest.derived,
        stats: manifest.stats,
        storageMode: "sharded",
        schema: manifest.schema,
      }
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
          state: "recovering",
          enabled: true,
          detail: `Loaded ${index + 1}/${manifest.shards.length} code graph shard(s).`,
          progress: { completed: index + 1, total: manifest.shards.length },
          currentShard: shard.key,
        })
        await budget.yieldNow()
      }
    }

    const index: CodeGraphIndex = {
      version: INDEX_VERSION,
      rootPath: manifest.rootPath,
      rootName: manifest.rootName,
      updatedAt: manifest.updatedAt,
      truncated: manifest.truncated,
      files,
      derived: manifest.derived,
      stats: manifest.stats,
      storageMode: "sharded",
      schema: manifest.schema,
    }
    index.schema ??= createCodeGraphStorageManifest(index)
    return index
  }

  private async activeIndexForQuestion(question: string, relatedPaths: string[]): Promise<CodeGraphIndex | undefined> {
    if (!this.index) return undefined
    if (!this.shardedManifest || !this.isLazyManifestIndex()) return this.index

    const settings = this.getSettings()
    const maxShards = Math.max(1, settings.codeGraph.maxDeepFiles)
    const plan = planShardKeysForQuery({
      index: this.index,
      question,
      relatedPaths,
      maxShards,
    })
    let shardKeys = plan.shardKeys
    if (shardKeys.length === 0) {
      shardKeys = this.shardedManifest.shards.slice(0, Math.min(4, maxShards)).map((shard) => shard.key)
    }

    const files: Record<string, CodeGraphFile> = Object.create(null) as Record<string, CodeGraphFile>
    for (const key of shardKeys) {
      Object.assign(files, await this.loadShardFiles(key))
    }

    return {
      ...this.index,
      files,
      derived: this.shardedManifest.derived,
      stats: this.shardedManifest.stats,
      storageMode: "sharded",
      schema: this.shardedManifest.schema ?? this.index.schema,
    }
  }

  private async loadShardFiles(key: string) {
    const cached = this.shardCache.get(key)
    if (cached) return cached
    const root = workspaceRoot()
    const manifest = this.shardedManifest
    if (!root || !manifest) return {}
    const shard = manifest.shards.find((item) => item.key === key)
    if (!shard) return {}
    try {
      const dir = this.indexDir(root)
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, ...shard.path.split("/")))
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as CodeGraphShardData
      if (!isSupportedStoredIndexVersion(payload.version) || payload.key !== shard.key) return {}
      this.shardCache.set(key, payload.files)
      return payload.files
    } catch (error) {
      this.output.appendLine(`[codegraph] failed to load shard ${key}: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  private hybridOptions(): HybridRetrievalOptions {
    this.configureRagProviders()
    return {
      settings: this.getSettings().rag,
      vectorIndex: this.ragIndex,
      embeddingProvider: this.ragEmbeddingProvider,
      rerankProvider: this.ragRerankProvider,
    }
  }

  private configureRagProviders() {
    const settings = this.getSettings().rag
    this.ragEmbeddingProvider = undefined
    this.ragRerankProvider = undefined
    if (settings.embedding.enabled && settings.embedding.endpoint) {
      try {
        this.ragEmbeddingProvider = createHttpEmbeddingProvider(settings)
      } catch (error) {
        this.setRagStatus({
          ...this.ragStatusValue,
          enabled: true,
          embeddingEnabled: true,
          endpointKind: checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts).kind,
          fallbackReason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (settings.rerank.enabled && settings.rerank.endpoint) {
      try {
        this.ragRerankProvider = createHttpRerankProvider(settings)
      } catch (error) {
        this.setRagStatus({
          ...this.ragStatusValue,
          enabled: true,
          rerankEnabled: true,
          fallbackReason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async refreshRagIndex(changedPaths?: string[]) {
    const root = workspaceRoot()
    const settings = this.getSettings().rag
    if (!root || !this.index) return
    if (!settings.embedding.enabled) {
      this.ragIndex = undefined
      this.setRagStatus(disabledRagStatus("embedding disabled; BM25/graph/state-machine fallback active"))
      return
    }
    const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
    if (!policy.ok) {
      this.ragIndex = undefined
      this.setRagStatus({
        ...disabledRagStatus(policy.reason),
        enabled: true,
        embeddingEnabled: true,
        rerankEnabled: settings.rerank.enabled,
        endpointKind: policy.kind,
        fallbackReason: policy.reason,
      })
      return
    }
    this.configureRagProviders()
    if (!this.ragEmbeddingProvider) return

    const started = Date.now()
    this.setRagStatus({
      ...this.ragStatusValue,
      enabled: true,
      embeddingEnabled: true,
      rerankEnabled: settings.rerank.enabled,
      endpointKind: policy.kind,
      fallbackReason: undefined,
      lastError: undefined,
      embeddingProvider: this.ragEmbeddingProvider.id,
      rerankProvider: this.ragRerankProvider?.id,
    })
    try {
      const activeIndex = this.isLazyManifestIndex() ? await this.activeIndexForQuestion("", []) : this.index
      if (!activeIndex) return
      const next = await buildRagVectorIndex({
        index: activeIndex,
        provider: this.ragEmbeddingProvider,
        previous: this.ragIndex,
        changedPaths,
        stateMachines: extractStateMachines(activeIndex, { maxTransitions: this.getSettings().codeGraph.maxStateTransitions }),
      })
      this.ragIndex = next
      this.lastRagElapsedMs = Date.now() - started
      await this.saveRagIndex(root, next)
      this.setRagStatus({
        enabled: true,
        embeddingEnabled: true,
        rerankEnabled: settings.rerank.enabled,
        endpointKind: policy.kind,
        chunks: next.chunks.length,
        embeddedChunks: next.vectors.length,
        vectorShards: new Set(next.chunks.map((chunk) => chunk.shard)).size,
        embeddingProvider: next.provider,
        rerankProvider: this.ragRerankProvider?.id,
        dimension: next.dimension,
        updatedAt: next.updatedAt,
      })
      this.output.appendLine(`[rag] embedded ${next.vectors.length}/${next.chunks.length} chunk(s) in ${this.lastRagElapsedMs}ms`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRagElapsedMs = Date.now() - started
      this.setRagStatus({
        ...this.ragStatusValue,
        enabled: true,
        embeddingEnabled: true,
        rerankEnabled: settings.rerank.enabled,
        endpointKind: policy.kind,
        lastError: message,
        fallbackReason: message,
      })
      this.output.appendLine(`[rag] embedding index failed after ${this.lastRagElapsedMs}ms: ${message}`)
    }
  }

  private async saveRagIndex(root: vscode.WorkspaceFolder, index: RagVectorIndex) {
    const dir = this.ragDir(root)
    const shardsDir = vscode.Uri.joinPath(dir, "shards")
    await vscode.workspace.fs.createDirectory(shardsDir)
    const manifest = createRagSerializedManifest(index)
    for (const shard of splitRagVectorIndex(index)) {
      const metadata: RagSerializedShardMetadata = {
        version: 1,
        key: shard.key,
        dimension: index.dimension,
        chunks: shard.chunks,
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.json`), encodeJson(metadata))
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.f32`), encodeRaw(encodeRagShardVectors(shard.vectors, index.dimension)))
    }
    await vscode.workspace.fs.writeFile(this.ragManifestUri(root), encodeJson(manifest))
  }

  private async loadRagIndex(root: vscode.WorkspaceFolder) {
    try {
      const manifestBytes = await vscode.workspace.fs.readFile(this.ragManifestUri(root))
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RagSerializedManifest
      if (manifest.version !== 1 || manifest.rootPath !== root.uri.fsPath) return
      const chunks: RagVectorIndex["chunks"] = []
      const vectors: RagVectorIndex["vectors"] = []
      const shardsDir = vscode.Uri.joinPath(this.ragDir(root), "shards")
      for (const shard of manifest.shards) {
        const metadataBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.json`))
        const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as RagSerializedShardMetadata
        const vectorBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.f32`))
        chunks.push(...metadata.chunks)
        vectors.push(...decodeRagShardVectors(vectorBytes, manifest.dimension))
      }
      this.ragIndex = {
        version: 1,
        rootPath: manifest.rootPath,
        updatedAt: manifest.updatedAt,
        provider: manifest.provider,
        model: manifest.model,
        dimension: manifest.dimension,
        chunks,
        vectors,
      }
      this.setRagStatus({
        enabled: true,
        embeddingEnabled: this.getSettings().rag.embedding.enabled,
        rerankEnabled: this.getSettings().rag.rerank.enabled,
        endpointKind: this.getSettings().rag.embedding.enabled
          ? checkRagEndpoint(this.getSettings().rag.embedding.endpoint, this.getSettings().rag.allowedHosts).kind
          : "disabled",
        chunks: chunks.length,
        embeddedChunks: vectors.length,
        vectorShards: manifest.shards.length,
        embeddingProvider: manifest.provider,
        dimension: manifest.dimension,
        updatedAt: manifest.updatedAt,
      })
    } catch {
      this.ragIndex = undefined
      this.setRagStatus(disabledRagStatus("no stored RAG vector index"))
    }
  }

  private setRagStatus(status: RagStatus) {
    this.ragStatusValue = status
    this.statusValue = { ...this.statusValue, rag: status, metrics: this.metrics() }
    this.onStatusChanged()
  }

  private isLazyManifestIndex() {
    return Boolean(
      this.shardedManifest
        && this.index?.storageMode === "sharded"
        && Object.keys(this.index.files).length === 0
        && (this.index.stats?.files ?? 0) > 0,
    )
  }

  private unloadColdShardsIfLarge() {
    if (!this.index || !this.shardedManifest) return
    if ((this.index.stats?.files ?? 0) < LARGE_INDEX_LAZY_FILE_THRESHOLD) return
    this.index = {
      ...this.index,
      files: {},
      derived: this.shardedManifest.derived,
      stats: this.shardedManifest.stats,
      storageMode: "sharded",
      schema: this.shardedManifest.schema ?? this.index.schema,
    }
    this.shardCache.clear()
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

  private checkpointUri(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.indexDir(root), "checkpoint.json")
  }

  private ragDir(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.indexDir(root), "rag")
  }

  private ragManifestUri(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.ragDir(root), "manifest.json")
  }

  private async saveJobCheckpoint(job: LocalAnalysisJob) {
    const root = workspaceRoot()
    if (!root) return
    const checkpoint: CodeGraphJobCheckpoint = {
      version: JOB_CHECKPOINT_VERSION,
      rootPath: root.uri.fsPath,
      jobId: job.id,
      kind: job.kind,
      detail: job.detail,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      updatedAt: Date.now(),
      progress: this.statusValue.progress,
      currentShard: this.statusValue.currentShard,
    }
    try {
      await vscode.workspace.fs.createDirectory(this.indexDir(root))
      await vscode.workspace.fs.writeFile(this.checkpointUri(root), encodeJson(checkpoint))
    } catch {
      // Checkpointing should never fail the active index job.
    }
  }

  private async readJobCheckpoint(root: vscode.WorkspaceFolder) {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.checkpointUri(root))
      const checkpoint = JSON.parse(new TextDecoder().decode(bytes)) as CodeGraphJobCheckpoint
      if (checkpoint.version !== JOB_CHECKPOINT_VERSION || checkpoint.rootPath !== root.uri.fsPath) return undefined
      return checkpoint
    } catch {
      return undefined
    }
  }

  private async clearJobCheckpoint(root = workspaceRoot()) {
    if (!root) return
    try {
      await vscode.workspace.fs.delete(this.checkpointUri(root))
    } catch {
      // Missing checkpoint is the common path.
    }
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
      storageBackend: CODEGRAPH_STORAGE_BACKEND,
      schemaVersion: this.index?.schema?.version ?? CODEGRAPH_STORAGE_SCHEMA_VERSION,
      shards: stats?.shards,
      indexBytes: stats?.bytes,
      skippedFiles: stats?.skippedFiles,
      largeRepoMode: Boolean(stats && (stats.files >= 10000 || stats.bytes >= 50 * 1024 * 1024)),
      metrics: this.metrics(),
      rag: this.ragStatusValue,
      ...this.analyzerStatusFields(),
    })
  }

  private reportIndexingFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const stats = this.index?.stats
    this.errorCount++
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
      storageBackend: CODEGRAPH_STORAGE_BACKEND,
      schemaVersion: this.index?.schema?.version ?? CODEGRAPH_STORAGE_SCHEMA_VERSION,
      shards: stats?.shards,
      indexBytes: stats?.bytes,
      skippedFiles: stats?.skippedFiles,
      errorCount: this.errorCount,
      metrics: this.metrics(),
      rag: this.ragStatusValue,
    })
  }

  private setStatus(status: CodeGraphStatus) {
    const transitions = recordStateTransition(this.transitions, status.state, status.detail, STATE_TRANSITION_LIMIT)
    const queue = this.jobs.snapshot()
    this.statusValue = {
      ...status,
      storageBackend: status.storageBackend ?? CODEGRAPH_STORAGE_BACKEND,
      schemaVersion: status.schemaVersion ?? this.index?.schema?.version ?? CODEGRAPH_STORAGE_SCHEMA_VERSION,
      queue,
      queueLength: status.queueLength ?? queue.pendingJobs,
      errorCount: status.errorCount ?? this.errorCount,
      lastTransitionAt: transitions[transitions.length - 1]?.at,
      transitions: [...transitions],
      metrics: status.metrics ?? this.metrics(),
      rag: status.rag ?? this.ragStatusValue,
    }
    this.onStatusChanged()
  }

  private async parseCodeGraphFile(input: {
    path: string
    text: string
    hash: string
    size: number
    mtime?: number
  }) {
    const withMetadata = (file: CodeGraphFile): CodeGraphFile => ({
      ...file,
      sha256: input.hash,
      mtime: input.mtime,
      module: moduleKey(input.path),
      shard: shardKeyForPath(input.path),
    })
    if (this.analyzer?.effectiveMode === "ast") {
      return withMetadata(await parseCFileWithAst({
        ...input,
        extensionPath: this.context.extensionUri.fsPath,
      }))
    }
    return withMetadata(await this.workerPool.parseFile(input, this.getSettings().codeGraph.workerConcurrency))
  }

  private async readWorkspaceFileSlice(input: {
    path: string
    startLine?: number
    endLine?: number
    maxBytes: number
  }) {
    const root = workspaceRoot()
    if (!root) return ""
    const normalized = input.path.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!normalized || normalized.split("/").includes("..")) throw new Error("File slice path must stay inside the workspace.")
    const uri = vscode.Uri.joinPath(root.uri, ...normalized.split("/"))
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (looksBinary(bytes)) return ""
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const lines = text.split(/\r?\n/)
    const start = Math.max(1, input.startLine ?? 1)
    const end = Math.max(start, Math.min(lines.length, input.endLine ?? Math.min(lines.length, start + 160)))
    return limitText(lines.slice(start - 1, end).join("\n"), input.maxBytes).text
  }

  private cacheQueryContext(key: string, value: CodeGraphPromptContext) {
    const max = this.getSettings().codeGraph.queryCacheSize
    if (max <= 0) return
    this.queryCache.set(key, value)
    this.enforceMemoryBudget()
  }

  private enforceMemoryBudget() {
    const settings = this.getSettings()
    const limitBytes = settings.codeGraph.memoryLimitMb * 1024 * 1024
    if (currentHeapUsed() <= limitBytes) return
    this.queryCache = new CodeGraphHotCache<string, CodeGraphPromptContext>(Math.max(1, Math.floor(settings.codeGraph.queryCacheSize / 2)))
    this.setStatus({
      ...this.statusValue,
      state: this.statusValue.state === "ready" ? "degraded" : this.statusValue.state,
      enabled: this.getSettings().codeGraph.enabled,
      detail: `Local code graph memory budget exceeded; trimmed hot query cache to ${this.queryCache.size()} item(s).`,
    })
  }

  private resizeQueryCache(maxSize: number) {
    if (this.queryCache.size() <= maxSize) return
    this.queryCache = new CodeGraphHotCache<string, CodeGraphPromptContext>(maxSize)
  }

  private throwIfCancelled(job?: LocalAnalysisJob) {
    if (!this.cancelRequested && !this.jobs.isCancelRequested()) return
    throw new Error(`Local code graph ${job?.kind ?? "index"} job cancelled.`)
  }

  private async waitWhilePaused() {
    while (!this.disposed && this.paused) {
      this.setStatus({
        ...this.statusValue,
        state: "paused",
        enabled: this.getSettings().codeGraph.enabled,
        detail: "Local code graph indexing is paused.",
      })
      await delay(100)
    }
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
  const index: CodeGraphIndex = {
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
  index.schema = createCodeGraphStorageManifest(index)
  return index
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

async function workspaceFileStat(uri: vscode.Uri) {
  try {
    return await vscode.workspace.fs.stat(uri)
  } catch {
    return undefined
  }
}

function hashBytes(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function excludeGlob(extra: string[]) {
  const patterns = [...DEFAULT_EXCLUDES, ...extra.filter(Boolean)]
  return `{${patterns.join(",")}}`
}

async function discoverWorkspaceSourceFiles(root: vscode.WorkspaceFolder, settings: RemoteSettings, ignoreGlobs: string[]) {
  const gitFiles = await gitTrackedSourceFiles(root, settings.codeGraph.maxFiles + 1)
  if (gitFiles.length > 0) return gitFiles
  const files = await vscode.workspace.findFiles(
    SOURCE_GLOB,
    excludeGlob([...settings.codeGraph.excludeGlobs, ...ignoreGlobs]),
    settings.codeGraph.maxFiles + 1,
  )
  return files.filter((uri) => !isSensitivePath(workspaceRelativePath(uri)))
}

async function gitTrackedSourceFiles(root: vscode.WorkspaceFolder, limit: number) {
  try {
    const { stdout } = await execFile("git", ["-C", root.uri.fsPath, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    const paths = stdout
      .split("\0")
      .filter((path) => path && isSourcePath(path) && !isSensitivePath(path))
      .slice(0, limit)
    return paths.map((path) => vscode.Uri.joinPath(root.uri, ...path.replace(/\\/g, "/").split("/")))
  } catch {
    return []
  }
}

function isSourcePath(path: string) {
  const normalized = path.toLowerCase().replace(/\\/g, "/")
  const dot = normalized.lastIndexOf(".")
  return dot >= 0 && SOURCE_EXTENSIONS.has(normalized.slice(dot))
}

function isSensitivePath(path: string) {
  const normalized = path.toLowerCase().replace(/\\/g, "/")
  return /(^|\/)(\.env|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$|\/)/.test(normalized)
    || /\.(pem|key|p12|pfx|crt|cer|der|keystore)$/.test(normalized)
    || /(^|\/)(secret|secrets|credential|credentials|private-key|private_key)(\/|\.|$)/.test(normalized)
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
    rag: disabledRagStatus(),
  }
}

function disabledRagStatus(fallbackReason = "embedding disabled; BM25/graph/state-machine fallback active"): RagStatus {
  return {
    enabled: false,
    embeddingEnabled: false,
    rerankEnabled: false,
    endpointKind: "disabled",
    chunks: 0,
    embeddedChunks: 0,
    vectorShards: 0,
    fallbackReason,
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

function codeGraphQueryCacheKey(input: {
  question: string
  relatedPaths: string[]
  maxBytes: number
  maxDepth: number
  maxFanout: number
}) {
  return JSON.stringify({
    q: input.question,
    p: input.relatedPaths.map((path) => path.replace(/\\/g, "/")).sort(),
    b: input.maxBytes,
    d: input.maxDepth,
    f: input.maxFanout,
  })
}

function toolQuestion(tool: AnalysisToolName, args: Record<string, unknown>) {
  const values = ["query", "question", "name", "symbol", "target", "path", "machineId", "source"]
    .map((key) => args[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  return values.length > 0 ? `${tool} ${values.join(" ")}` : tool
}

function currentHeapUsed() {
  return typeof process !== "undefined" && typeof process.memoryUsage === "function" ? process.memoryUsage().heapUsed : 0
}

function isSupportedStoredIndexVersion(version: number) {
  return version === 2 || version === INDEX_VERSION
}

function encodeJson(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value))
}

function encodeRaw(value: Uint8Array) {
  return value
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function limitText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false }
  let result = ""
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return { text: result, truncated: true }
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
