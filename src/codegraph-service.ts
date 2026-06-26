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
  isCurrentCodeGraphIndexVersion,
  moduleKey,
  shardFileName,
  shardKeyForPath,
} from "./codegraph-index"
import {
  CODEGRAPH_DERIVED_SIDECAR_FIELDS,
  mergeCodeGraphDerivedSidecar,
  splitCodeGraphDerivedIndex,
  type CodeGraphDerivedSidecarData,
  type CodeGraphDerivedSidecarPartData,
} from "./codegraph-derived-storage"
import {
  CODEGRAPH_JSON_HARD_PART_BYTES,
  CODEGRAPH_JSON_TARGET_PART_BYTES,
  encodeBoundedJson,
} from "./codegraph-bounded-json"
import {
  mergeCodeGraphFileStorageParts,
  splitCodeGraphFilesForStorage,
} from "./codegraph-file-storage"
import { buildHybridCodeGraphContext, searchCodeGraphSymbols } from "./codegraph-query"
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
import { shouldIndexPath } from "./indexing-path-policy"
import type { AnalysisToolName, AnalysisToolResult, CodeIntelligenceSnapshot, QueryEvidenceResult } from "./analysis-types"
import { extractStateMachines } from "./state-machine-extractor"
import { checkRagEndpoint, createHttpEmbeddingProvider, createHttpRerankProvider, probeRagRerankProvider, type RagHttpDiagnosticEvent, type RagHttpDiagnostics } from "./rag-provider"
import {
  buildRagChunks,
  buildRagVectorIndex,
  createRagSerializedManifest,
  decodeRagShardVectors,
  encodeRagShardVectors,
  ragManifestStaleReason,
  RagIndexAbortError,
  splitRagVectorIndex,
  validateRagCrossVersionPartialResume,
  type RagEmbeddingSchedulerBlockedEvent,
  type RagIndexBatchProfile,
  type RagIndexBuildProgress,
  type RagIndexBuildSummary,
  type RagLoadedShardForResumeValidation,
  type RagManifestLifecycleMetadata,
  type RagSerializedManifest,
  type RagSerializedShardMetadata,
} from "./rag-index"
import type { EmbeddingProvider, HybridRetrievalOptions, RagVectorIndex, RerankProvider } from "./rag-types"
import type {
  CodeGraphEvidenceRetrievalMode,
  CodeGraphFile,
  CodeGraphEvidenceQueryOptions,
  CodeGraphIndex,
  CodeGraphPromptContext,
  CodeGraphQueryMetrics,
  CodeGraphShardData,
  CodeGraphShardInfo,
  CodeGraphShardManifest,
} from "./codegraph-types"
import type {
  CodeGraphStatus,
  RagConfigurationApplyOptions,
  RagConfigurationApplyResult,
  RagIndexProgress,
  RagResumeReason,
  RagSettings,
  RagStatus,
  RagWorkerStatus,
  RemoteSettings,
} from "./types"

const INDEX_VERSION = CURRENT_CODE_GRAPH_INDEX_VERSION
const INDEX_TIME_SLICE_MS = 35
const STATE_TRANSITION_LIMIT = 25
const SOURCE_GLOB = "**/*.{c,h,cc,cpp,cxx,hpp,hxx}"
const SOURCE_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"])
const LARGE_INDEX_LAZY_FILE_THRESHOLD = 100000
const CODEGRAPH_STORAGE_WRITE_CONCURRENCY = 4
const JOB_CHECKPOINT_VERSION = 1
const RAG_INDEX_SAFE_CHECKPOINT_CHUNK_INTERVAL = 2048
const RAG_INDEX_SAFE_CHECKPOINT_INTERVAL_MS = 30000
const RAG_PENDING_READY_RETRY_MS = 100
const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/.vscode-test/**",
  "**/.chipmate/**",
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

type RerankProbeStatus = {
  enabled: boolean
  provider?: string
  lastError?: string
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
  private ragEmbeddingProviderError?: string
  private ragRerankProviderError?: string
  private providerApiKey?: string
  private ragProbeInFlight?: Promise<RagStatus>
  private ragIndexInFlight?: Promise<void>
  private ragIndexController?: AbortController
  private pendingRagRefresh?: Set<string> | "full"
  private pendingRagRefreshIgnorePrevious = false
  private pendingRagResumeTrigger?: string
  private pendingRagWorkTimer?: ReturnType<typeof setTimeout>
  private ragResumeTimer?: ReturnType<typeof setTimeout>
  private ragResumeInFlight?: Promise<void>
  private ragManualPauseSequence = 0
  private lastRagElapsedMs: number | undefined
  private ragStatusValue = disabledRagStatus()
  private changeTimer?: ReturnType<typeof setTimeout>
  private rescanScheduled = false
  private cancelRequested = false
  private paused = false
  private pendingRagRefreshContinuePreviousElapsed = false
  private errorCount = 0
  private disposed = false
  private lastAnalysisTrace: CodeIntelligenceSnapshot["lastTrace"]
  private readonly analysisAudit: NonNullable<CodeIntelligenceSnapshot["lastAudit"]> = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly getSettings: () => RemoteSettings,
    private readonly getProviderApiKey: () => Promise<string | undefined>,
    private readonly onStatusChanged: () => void,
  ) {}

  dispose() {
    this.disposed = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    if (this.pendingRagWorkTimer) clearTimeout(this.pendingRagWorkTimer)
    this.clearRagIndexResume()
    this.abortRagIndex("service disposed")
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
    this.paused = false
    this.ragManualPauseSequence += 1
    this.clearRagIndexResume()
    this.clearPendingRagWorkTimer()
    this.pendingRagRefresh = undefined
    this.pendingRagRefreshIgnorePrevious = false
    this.pendingRagRefreshContinuePreviousElapsed = false
    this.pendingRagResumeTrigger = undefined
    this.clearManualRagPause(reason)
    this.abortRagIndex(reason)
    this.jobs.cancelActive(reason)
    this.jobs.clearPending()
    this.jobs.resume()
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
    this.clearRagIndexResume()
    this.jobs.pause()
    void this.pauseActiveRagIndex(reason, { requireCodeGraphPause: true }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[rag-index] failed to save manual paused RAG index: ${message}`)
    })
    this.abortRagIndex(reason)
    this.setStatus({
      ...this.statusValue,
      state: "paused",
      enabled: this.getSettings().codeGraph.enabled,
      detail: `Local code graph indexing paused: ${reason}.`,
    })
  }

  resumeIndexing() {
    this.paused = false
    this.ragManualPauseSequence += 1
    this.jobs.resume()
    const hasQueuedWork = this.pendingChanges.size > 0 || this.rescanScheduled || this.jobs.hasPending()
    this.setStatus({
      ...this.statusValue,
      state: hasQueuedWork ? "rescanScheduled" : this.index ? "ready" : "degraded",
      enabled: this.getSettings().codeGraph.enabled,
      detail: hasQueuedWork
        ? "Local code graph indexing resumed; queued changes will be processed."
        : "Local code graph indexing resumed.",
    })
    if (this.pendingChanges.size > 0 || this.rescanScheduled) void this.applyPendingChanges()
    else if (this.jobs.hasPending() && !this.indexing) {
      void this.startQueuedIndexJobs()
    }
    const manualRagResume = this.resumeManualRagIndexing()
    if (!manualRagResume) void this.scheduleRagIndexResumeFromStatus("manual-resume")
    this.schedulePendingRagWorkAfterCodeGraphReady("manual-resume")
  }

  cancelRagIndexing(reason = "cancelled by user") {
    this.ragManualPauseSequence += 1
    this.clearRagIndexResume()
    this.clearPendingRagWorkTimer()
    this.pendingRagRefresh = undefined
    this.pendingRagRefreshIgnorePrevious = false
    this.pendingRagRefreshContinuePreviousElapsed = false
    this.pendingRagResumeTrigger = undefined
    this.clearManualRagPause(reason)
    this.abortRagIndex(reason)
  }

  pauseRagIndexing(reason = "paused by user") {
    this.clearRagIndexResume()
    const pauseSequence = ++this.ragManualPauseSequence
    void this.pauseActiveRagIndex(reason, { pauseSequence }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[rag-index] failed to save manual paused RAG index: ${message}`)
    })
    this.abortRagIndex(reason)
  }

  resumeRagIndexing() {
    this.ragManualPauseSequence += 1
    const manualRagResume = this.resumeManualRagIndexing()
    if (!manualRagResume) void this.scheduleRagIndexResumeFromStatus("manual-resume")
    this.schedulePendingRagWorkAfterCodeGraphReady("manual-resume")
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
    await this.ensureIndexLoaded()
    if (this.status().state === "ready") return
    if (!settings.codeGraph.promptOnWorkspaceOpen) return

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
    return this.startQueuedIndexJobs()
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
    const rag = formatRagStatus(status.rag)
    void vscode.window.showInformationMessage(
      `Local code graph: ${status.state}. ${status.indexedFiles} file(s), ${status.indexedFunctions} function(s), ${status.indexedMacros} macro(s). ${status.detail}${updated}${truncated}${storage}${schema}${queue}${errors}${size}${skipped}${analyzer}${degraded}${rag}`.trim(),
    )
  }

  async refreshRagConfiguration() {
    await this.testRagConfiguration()
  }

  async applyRagConfiguration(options: RagConfigurationApplyOptions = {}): Promise<RagConfigurationApplyResult> {
    await this.refreshProviderApiKey()
    this.queryCache.clear()
    if (!this.getSettings().codeGraph.enabled) {
      this.ragIndex = undefined
      const status = disabledRagStatus()
      this.setRagStatus(status)
      return this.ragApplyResult("disabled")
    }
    const root = workspaceRoot()
    if (!root) {
      this.ragIndex = undefined
      const status = disabledRagStatus("No workspace folder is open.")
      this.setRagStatus(status)
      return this.ragApplyResult("disabled")
    }
    if (!this.index) await this.ensureIndexLoaded()
    if (options.forceRebuild) {
      this.clearRagIndexResume()
      this.pendingRagRefresh = undefined
      this.pendingRagRefreshIgnorePrevious = false
      this.pendingRagRefreshContinuePreviousElapsed = false
      this.pendingRagResumeTrigger = undefined
      this.clearPendingRagWorkTimer()
      this.abortRagIndex("RAG force rebuild requested")
      if (this.ragIndexInFlight) {
        try {
          await this.ragIndexInFlight
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.output.appendLine(`[rag-index] active build stopped before force rebuild: ${message}`)
        }
      }
      const cleared = await this.clearStoredRagIndex(root)
      const ready = this.isCodeGraphReadyForRag()
      if (!cleared) {
        const message = "Failed to clear stored RAG index before force rebuild."
        this.ragIndex = undefined
        const status = {
          ...this.ragStatusValue,
          enabled: false,
          availability: "unavailable" as const,
          embeddingEnabled: false,
          indexProgress: undefined,
          lastError: message,
          fallbackReason: message,
        }
        this.setRagStatus(status)
        return this.ragApplyResult("unavailable", status)
      }
      this.ragIndex = undefined
      this.queuePendingRagRefresh(undefined, { ignorePrevious: true })
      this.runPendingRagRefreshWhenReady("RAG force rebuild requested", { restartInFlight: true, ignorePrevious: true })
      return this.ragApplyResult(ready ? "build-started" : "build-queued")
    }

    if (options.preserveExistingIndex) {
      const status = await this.probeRagConfiguration()
      if (this.currentRagIndexMatchesProvider()) {
        await this.scheduleRagIndexResumeFromStatus("configuration-refresh")
        return this.ragApplyResult("status-refreshed")
      }
      return this.ragApplyResult("status-refreshed", status)
    }

    const status = await this.probeRagConfiguration()
    if (this.currentRagIndexMatchesProvider()) {
      await this.scheduleRagIndexResumeFromStatus("configuration-refresh")
      return this.ragApplyResult("status-refreshed")
    }

    const settings = this.getSettings().rag
    const policy = settings.embedding.endpoint ? checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts) : undefined
    if (settings.embedding.configError || !settings.embedding.endpoint || policy?.ok === false) {
      return this.ragApplyResult(status.availability === "not-configured" ? "disabled" : "unavailable", status)
    }

    this.queuePendingRagRefresh()
    const ready = this.isCodeGraphReadyForRag()
    this.runPendingRagRefreshWhenReady("RAG configuration changed")
    return this.ragApplyResult(ready ? "build-started" : "build-queued")
  }

  async testRagConfiguration(): Promise<RagStatus> {
    if (this.ragProbeInFlight) return this.ragProbeInFlight
    this.ragProbeInFlight = this.probeRagConfiguration().finally(() => {
      this.ragProbeInFlight = undefined
    })
    return this.ragProbeInFlight
  }

  private async probeRagConfiguration(): Promise<RagStatus> {
    await this.refreshProviderApiKey()
    this.queryCache.clear()
    if (!this.getSettings().codeGraph.enabled) {
      this.ragIndex = undefined
      const status = disabledRagStatus()
      this.setRagStatus(status)
      return status
    }
    const status = await this.probeRagProvidersOnly()
    this.setRagStatus(status)
    return status
  }

  private async refreshProviderApiKey() {
    this.providerApiKey = await this.getProviderApiKey()
  }

  async buildContext(input: {
    question: string
    relatedPaths: string[]
    maxBytes: number
    maxDepth: number
    maxFanout: number
    retrievalMode?: CodeGraphEvidenceRetrievalMode
    latencyBudgetMs?: number
  }): Promise<CodeGraphPromptContext | undefined> {
    const settings = this.getSettings()
    if (!settings.codeGraph.enabled) return undefined
    if (!this.index) await this.ensureIndexLoaded()
    const activeIndex = await this.activeIndexForQuestion(input.question, input.relatedPaths)
    if (!activeIndex) return undefined
    const retrievalMode = input.retrievalMode ?? "hybrid"
    this.resizeQueryCache(settings.codeGraph.queryCacheSize)
    const cacheKey = `${codeGraphQueryCacheKey(input)}:${retrievalMode}:${input.latencyBudgetMs ?? "none"}:${retrievalMode === "hybrid" ? this.ragIndex?.updatedAt ?? 0 : 0}:${settings.rag.embedding.enabled ? "rag" : "fallback"}`
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
      hybrid: retrievalMode === "graph-only" ? undefined : this.hybridOptions(input.latencyBudgetMs),
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

  async queryEvidence(question: string, options: CodeGraphEvidenceQueryOptions = {}): Promise<QueryEvidenceResult | undefined> {
    if (!this.getSettings().codeGraph.enabled) return undefined
    if (!this.index) await this.ensureIndexLoaded()
    const activeIndex = await this.activeIndexForQuestion(question, options.relatedPaths ?? [])
    if (!activeIndex) return undefined
    const settings = this.getSettings()
    const hybrid = options.retrievalMode === "graph-only" ? undefined : this.hybridOptions(options.latencyBudgetMs)
    const result = await queryEvidenceAsync(activeIndex, question, {
      maxEvidenceItems: options.maxEvidenceItems ?? settings.analysis.maxEvidenceItems,
      maxEvidenceBytes: options.maxEvidenceBytes ?? settings.analysis.maxEvidenceBytes,
      maxFileSliceBytes: settings.analysis.maxFileSliceBytes,
      maxGraphEdges: settings.analysis.maxGraphEdges,
      maxPaths: settings.analysis.maxPaths,
    }, hybrid, options.relatedPaths ?? [])
    this.lastAnalysisTrace = result.trace
    return result
  }

  async findSymbols(input: {
    query: string
    relatedPath?: string
    limit?: number
  }) {
    if (!this.getSettings().codeGraph.enabled) return []
    if (!input.query.trim()) return []
    if (!this.index) await this.ensureIndexLoaded()
    const relatedPaths = input.relatedPath ? [input.relatedPath] : []
    const activeIndex = await this.activeIndexForQuestion(input.query, relatedPaths)
    if (!activeIndex) return []
    return searchCodeGraphSymbols({
      index: activeIndex,
      query: input.query,
      relatedPath: input.relatedPath,
      limit: input.limit,
    })
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
    this.suspendRagWorkForCodeGraphIndexing("full code graph indexing started")
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
      const scan = await discoverWorkspaceSourceFiles(root, settings, ignoreGlobs)
      const files = scan.files
      await budget.yieldNow()
      this.output.appendLine(`[codegraph] scan ${Date.now() - started}ms, found ${Math.min(files.length, settings.codeGraph.maxFiles)} file(s) skippedTestFiles=${scan.skippedTestFiles}`)
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
      this.unloadColdShardsIfLarge()
      this.output.appendLine(
        `[codegraph] indexed ${savedStats?.files ?? Object.keys(nextFiles).length} file(s), ${savedStats?.functions ?? countFunctions(this.index)} function(s)${
          truncated ? " (truncated)" : ""
        } into ${savedStats?.shards ?? this.index.stats?.shards ?? 0} shard(s) in ${Date.now() - started}ms`,
      )
      this.setReadyStatus("Local C/C++ code graph is ready.")
      this.scheduleRagRefreshAfterCodeGraphReady()
    } catch (error) {
      throw error
    }
  }

  private startWatcher() {
    if (this.watcher || !vscode.workspace.workspaceFolders?.length) return
    this.watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB)
    this.context.subscriptions.push(this.watcher)
    const queueChange = (uri: vscode.Uri, deleted: boolean) => {
      const settings = this.getSettings()
      if (!settings.codeGraph.enabled) return
      const path = workspaceRelativePath(uri)
      if (!shouldIndexPath(path, { indexTests: settings.codeGraph.indexTests })) {
        if (!this.index?.files[path]) return
        deleted = true
      }
      this.pendingChanges.set(path, { uri, deleted })
      const threshold = settings.codeGraph.watcherRescanThreshold
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
    const indexing = this.startQueuedIndexJobs()
    try {
      await indexing
    } finally {
      if (this.pendingChanges.size > 0 && !this.changeTimer) {
        this.changeTimer = setTimeout(() => {
          this.changeTimer = undefined
          void this.applyPendingChanges()
        }, 800)
      }
    }
  }

  private startQueuedIndexJobs() {
    if (this.indexing) return this.indexing
    this.indexing = this.runQueuedIndexJobs().finally(() => {
      this.indexing = undefined
      this.schedulePendingRagWorkAfterCodeGraphReady("code graph indexing idle")
    })
    return this.indexing
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
    this.suspendRagWorkForCodeGraphIndexing("incremental code graph indexing started")
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
      if (!shouldIndexPath(relative, { indexTests: settings.codeGraph.indexTests })) {
        delete this.index.files[relative]
      } else if (change.deleted) {
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
    this.unloadColdShardsIfLarge()
    this.output.appendLine(`[codegraph] incrementally updated ${changes.length} file change(s)`)
    this.setReadyStatus("Local C/C++ code graph is ready after incremental update.")
    this.scheduleRagRefreshAfterCodeGraphReady(changes.map((change) => workspaceRelativePath(change.uri)))
  }

  private async setEnabled(enabled: boolean) {
    await vscode.workspace
      .getConfiguration("chipmate")
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
      this.schedulePendingRagWorkAfterCodeGraphReady("code graph loaded")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[codegraph] stored index unavailable; rebuild required: ${message}`)
      this.index = emptyIndex(root)
      await this.clearJobCheckpoint(root)
      this.setStatus({
        state: "degraded",
        enabled: this.getSettings().codeGraph.enabled,
        detail: "No current local code graph index exists yet. Rebuild the local code graph.",
        indexedFiles: 0,
        indexedFunctions: 0,
        indexedMacros: 0,
        truncated: false,
      })
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
    const saveStarted = Date.now()
    this.setStatus({
      ...this.statusValue,
      state: this.statusValue.state === "indexingIncremental" ? "indexingIncremental" : "indexingFull",
      enabled: true,
      detail: "Saving local C/C++ code graph index.",
    })
    const hydrateStarted = Date.now()
    this.output.appendLine(`[codegraph] building derived index`)
    this.index =
      this.index.derived && this.index.stats
        ? { ...this.index, storageMode: "sharded" }
        : await hydrateCodeGraphIndexAsync({ ...this.index, storageMode: "sharded" }, this.index.stats?.skippedFiles ?? 0, () =>
            budget.yieldIfNeeded(),
          )
    this.output.appendLine(`[codegraph] building derived index done elapsedMs=${Date.now() - hydrateStarted}`)
    const dir = this.indexDir(root)
    const shardsDir = vscode.Uri.joinPath(dir, "shards")
    await vscode.workspace.fs.createDirectory(shardsDir)

    const groups = groupFilesByShard(this.index.files)
    const shardGeneration = this.shardGenerationName(this.index.updatedAt)
    const manifestShards: CodeGraphShardInfo[] = []
    let filePartCount = 0
    let maxFilePartBytes = 0
    const fileSaveStarted = Date.now()
    this.output.appendLine(`[codegraph] saving file shard parts logicalShards=${groups.size} targetPartBytes=${CODEGRAPH_JSON_TARGET_PART_BYTES} hardPartBytes=${CODEGRAPH_JSON_HARD_PART_BYTES}`)
    for (const [key, files] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const shardPlanningStarted = Date.now()
      this.output.appendLine(`[codegraph] planning file shard ${key} files=${Object.keys(files).length}`)
      let lastSplitProgressLog = 0
      const stats = buildIndexStats(files)
      const parts = splitCodeGraphFilesForStorage(files, {
        shardKey: key,
        label: `file shard ${key}`,
        basePath: `shards/${shardGeneration}/${this.shardDirectoryName(key)}`,
        targetPartBytes: CODEGRAPH_JSON_TARGET_PART_BYTES,
        hardPartBytes: CODEGRAPH_JSON_HARD_PART_BYTES,
        onLargeFileSplit: (event) => {
          this.output.appendLine(`[codegraph] splitting large file ${event.path} field=${event.field} items=${event.items} chunks=${event.chunks}`)
        },
        onProgress: (event) => {
          const now = Date.now()
          if (now - lastSplitProgressLog >= 2000 || event.processed >= event.total) {
            lastSplitProgressLog = now
            this.output.appendLine(`[codegraph] splitting progress ${event.label} ${event.processed}/${event.total}`)
          }
        },
      })
      this.output.appendLine(`[codegraph] planned file shard ${key} parts=${parts.length} maxPartBytes=${parts.reduce((max, part) => Math.max(max, part.estimatedBytes), 0)} elapsedMs=${Date.now() - shardPlanningStarted}`)
      manifestShards.push({
        key,
        files: stats.files,
        functions: stats.functions,
        macros: stats.macros,
        bytes: stats.bytes,
        parts: parts.map((part) => ({
          key: part.key,
          path: part.path,
          entries: part.entries,
          estimatedBytes: part.estimatedBytes,
        })),
      })
      await writePartsWithConcurrency(parts, CODEGRAPH_STORAGE_WRITE_CONCURRENCY, async (part, index) => {
        this.setStatus({
          ...this.statusValue,
          detail: `Saving shard ${key} part ${index + 1}/${parts.length}.`,
          currentShard: key,
        })
        await writeJsonRelative(dir, part.path, part.payload, `file shard ${key}`, part.key)
        filePartCount += 1
        maxFilePartBytes = Math.max(maxFilePartBytes, part.estimatedBytes)
        await budget.yieldIfNeeded()
      }, (completed, total) => {
        this.output.appendLine(`[codegraph] saved file shard ${key} part ${completed}/${total}`)
      })
    }
    this.output.appendLine(`[codegraph] saving file shard parts done logicalShards=${manifestShards.length} parts=${filePartCount} maxPartBytes=${maxFilePartBytes} elapsedMs=${Date.now() - fileSaveStarted}`)

    const derived = this.index.derived ?? emptyDerivedIndex()
    const derivedGeneration = this.derivedGenerationName(this.index.updatedAt)
    const derivedSaveStarted = Date.now()
    const derivedSidecar = splitCodeGraphDerivedIndex(derived, {
      basePath: `derived/${derivedGeneration}`,
      targetPartBytes: CODEGRAPH_JSON_TARGET_PART_BYTES,
      hardPartBytes: CODEGRAPH_JSON_HARD_PART_BYTES,
    })
    this.output.appendLine(`[codegraph] saving derived sidecar parts parts=${derivedSidecar.parts.length} targetPartBytes=${CODEGRAPH_JSON_TARGET_PART_BYTES} hardPartBytes=${CODEGRAPH_JSON_HARD_PART_BYTES}`)
    await this.saveDerivedSidecar(dir, derivedSidecar, budget)
    const maxDerivedPartBytes = derivedSidecar.parts.reduce((max, part) => Math.max(max, part.estimatedBytes), 0)
    this.output.appendLine(`[codegraph] saving derived sidecar parts done parts=${derivedSidecar.parts.length} maxPartBytes=${maxDerivedPartBytes} elapsedMs=${Date.now() - derivedSaveStarted}`)

    const manifestSaveStarted = Date.now()
    this.output.appendLine(`[codegraph] saving manifest`)
    const manifest: CodeGraphShardManifest = {
      version: INDEX_VERSION,
      rootPath: this.index.rootPath,
      rootName: this.index.rootName,
      updatedAt: this.index.updatedAt,
      truncated: this.index.truncated,
      derived: derivedSidecar.manifest,
      stats: this.index.stats ?? buildIndexStats(this.index.files),
      schema: createCodeGraphStorageManifest(this.index),
      shards: manifestShards,
    }
    await vscode.workspace.fs.writeFile(this.manifestUri(root), encodeJson(manifest, "code graph manifest"))
    this.shardedManifest = manifest
    this.shardCache.clear()
    this.output.appendLine(`[codegraph] saving manifest done shards=${manifestShards.length} fileParts=${filePartCount} derivedParts=${derivedSidecar.parts.length} elapsedMs=${Date.now() - manifestSaveStarted} totalElapsedMs=${Date.now() - saveStarted}`)
    await this.cleanupOldShardGenerations(shardsDir, shardGeneration)
    await this.cleanupOldDerivedSidecars(vscode.Uri.joinPath(dir, "derived"), derivedGeneration)
  }

  private async loadShardedIndex(root: vscode.WorkspaceFolder, budget = new WorkBudget()): Promise<CodeGraphIndex> {
    const manifestBytes = await vscode.workspace.fs.readFile(this.manifestUri(root))
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as CodeGraphShardManifest
    if (!isCurrentCodeGraphIndexVersion(manifest.version) || manifest.rootPath !== root.uri.fsPath) {
      throw new Error("Code graph manifest does not match this workspace.")
    }
    this.shardedManifest = manifest
    const dir = this.indexDir(root)
    const derived = await this.loadDerivedSidecar(dir, manifest.derived, budget)

    if (manifest.stats.files >= LARGE_INDEX_LAZY_FILE_THRESHOLD && manifest.schema) {
      return {
        version: INDEX_VERSION,
        rootPath: manifest.rootPath,
        rootName: manifest.rootName,
        updatedAt: manifest.updatedAt,
        truncated: manifest.truncated,
        files: {},
        derived,
        stats: manifest.stats,
        storageMode: "sharded",
        schema: manifest.schema,
      }
    }

    const files: Record<string, CodeGraphFile> = {}
    const totalParts = manifest.shards.reduce((count, shard) => count + shard.parts.length, 0)
    let loadedParts = 0
    for (let index = 0; index < manifest.shards.length; index++) {
      const shard = manifest.shards[index]
      const shardFiles = await this.readShardFiles(dir, shard)
      loadedParts += shard.parts.length
      Object.assign(files, shardFiles)
      if (budget.shouldYield()) {
        this.setStatus({
          ...this.statusValue,
          state: "recovering",
          enabled: true,
          detail: `Loaded ${loadedParts}/${totalParts} code graph shard part(s).`,
          progress: { completed: loadedParts, total: totalParts },
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
      derived,
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
      derived: this.index.derived,
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
    if (!shard) throw new Error(`Code graph shard ${key} is missing from the manifest. Rebuild the local code graph index.`)
    try {
      const dir = this.indexDir(root)
      const files = await this.readShardFiles(dir, shard)
      this.shardCache.set(key, files)
      return files
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[codegraph] failed to load shard ${key}: ${message}`)
      throw new Error(`Code graph shard ${key} is incomplete: ${message}. Rebuild the local code graph index.`)
    }
  }

  private async readShardFiles(indexDir: vscode.Uri, shard: CodeGraphShardInfo) {
    const parts: CodeGraphShardData[] = []
    for (const part of shard.parts) {
      const payload = await readJsonRelative<CodeGraphShardData>(indexDir, part.path)
      if (!isCurrentCodeGraphIndexVersion(payload.version) || payload.key !== shard.key || payload.part !== part.key) {
        throw new Error(`Code graph shard ${shard.key} part ${part.key} does not match the current storage version.`)
      }
      parts.push(payload)
    }
    return mergeCodeGraphFileStorageParts(parts)
  }

  private hybridOptions(latencyBudgetMs?: number): HybridRetrievalOptions {
    this.configureRagProviders()
    const embeddingReady = Boolean(this.ragStatusValue.embeddingEnabled && this.ragIndex && this.ragEmbeddingProvider && this.currentRagIndexMatchesProvider())
    const rerankReady = Boolean(this.ragStatusValue.rerankEnabled && this.ragRerankProvider)
    return {
      settings: this.getSettings().rag,
      vectorIndex: embeddingReady ? this.ragIndex : undefined,
      embeddingProvider: embeddingReady ? this.ragEmbeddingProvider : undefined,
      rerankProvider: rerankReady ? this.ragRerankProvider : undefined,
      latencyBudgetMs,
    }
  }

  private configureRagProviders() {
    const settings = this.getSettings().rag
    this.ragEmbeddingProvider = undefined
    this.ragRerankProvider = undefined
    this.ragEmbeddingProviderError = undefined
    this.ragRerankProviderError = undefined
    if (settings.embedding.configError) {
      this.ragEmbeddingProviderError = settings.embedding.configError
    } else if (settings.embedding.endpoint) {
      try {
        this.ragEmbeddingProvider = createHttpEmbeddingProvider(settings, this.providerApiKey, this.ragHttpDiagnostics())
      } catch (error) {
        this.ragEmbeddingProviderError = error instanceof Error ? error.message : String(error)
        this.setRagStatus({
          ...this.ragStatusValue,
          enabled: false,
          availability: "unavailable",
          embeddingEnabled: false,
          endpointKind: checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts).kind,
          fallbackReason: this.ragEmbeddingProviderError,
        })
      }
    }
    if (settings.rerank.endpoint) {
      try {
        this.ragRerankProvider = createHttpRerankProvider(settings, this.providerApiKey, this.ragHttpDiagnostics())
      } catch (error) {
        this.ragRerankProviderError = error instanceof Error ? error.message : String(error)
        this.setRagStatus({
          ...this.ragStatusValue,
          rerankEnabled: false,
          rerankLastError: this.ragRerankProviderError,
        })
      }
    }
  }

  private ragHttpDiagnostics(): RagHttpDiagnostics {
    return (event) => this.output.appendLine(formatRagHttpDiagnosticEvent(event))
  }

  private async probeConfiguredRerankProvider(): Promise<RerankProbeStatus> {
    const settings = this.getSettings().rag
    if (!settings.rerank.endpoint) return { enabled: false }
    if (!this.ragRerankProvider) {
      return {
        enabled: false,
        lastError: this.ragRerankProviderError ?? "rerank provider is not configured",
      }
    }
    try {
      await probeRagRerankProvider(this.ragRerankProvider)
      return { enabled: true, provider: this.ragRerankProvider.id }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[rag] rerank probe failed: ${message}`)
      return { enabled: false, provider: this.ragRerankProvider.id, lastError: message }
    }
  }

  private async probeRagProvidersOnly(): Promise<RagStatus> {
    const settings = this.getSettings().rag
    if (settings.embedding.configError) return this.ragEmbeddingConfigErrorStatus(settings)
    if (!settings.embedding.endpoint) {
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      return {
        ...disabledRagStatus("embedding endpoint not configured; BM25/graph/state-machine fallback active"),
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      }
    }

    const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
    if (!policy.ok) {
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      return {
        ...disabledRagStatus(policy.reason),
        availability: "unavailable",
        endpointKind: policy.kind,
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
        fallbackReason: policy.reason,
      }
    }

    this.configureRagProviders()
    const rerankProbe = await this.probeConfiguredRerankProvider()
    if (!this.ragEmbeddingProvider) {
      this.ragIndex = undefined
      return {
        ...disabledRagStatus("embedding provider is not configured"),
        availability: "unavailable",
        endpointKind: policy.kind,
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      }
    }

    const expectedDimension = this.currentRagIndexMatchesProvider() ? this.ragIndex?.dimension ?? 0 : 0
    this.setRagStatus({
      ...this.ragStatusValue,
      enabled: false,
      availability: "checking",
      embeddingEnabled: false,
      endpointKind: policy.kind,
      fallbackReason: "checking embedding endpoint",
      lastError: undefined,
      rerankEnabled: rerankProbe.enabled,
      rerankProvider: rerankProbe.provider,
      rerankLastError: rerankProbe.lastError,
      embeddingProvider: this.ragEmbeddingProvider.id,
    })

    try {
      await this.probeRagEmbeddingProvider(expectedDimension)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...this.ragStatusValue,
        enabled: false,
        availability: "unavailable",
        embeddingEnabled: false,
        rerankEnabled: rerankProbe.enabled,
        endpointKind: policy.kind,
        lastError: message,
        fallbackReason: message,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      }
    }

    if (!this.currentRagIndexMatchesProvider()) {
      this.ragIndex = undefined
      return {
        enabled: false,
        availability: "not-indexed",
        embeddingEnabled: false,
        rerankEnabled: rerankProbe.enabled,
        endpointKind: policy.kind,
        chunks: 0,
        embeddedChunks: 0,
        vectorShards: 0,
        embeddingProvider: this.ragEmbeddingProvider.id,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
        fallbackReason: "embedding endpoint is reachable, but no matching RAG vector index is built; rebuild the local code graph to enable vector retrieval",
      }
    }

    return this.readyRagStatus(policy.kind, rerankProbe, this.ragIndex!)
  }

  private currentRagIndexMatchesProvider() {
    const settings = this.getSettings().rag
    const providerDimension = this.ragEmbeddingProvider?.dimension && this.ragEmbeddingProvider.dimension > 0
      ? this.ragEmbeddingProvider.dimension
      : undefined
    return Boolean(
      this.ragIndex
        && this.ragEmbeddingProvider
        && this.ragIndex.provider === this.ragEmbeddingProvider.id
        && this.ragIndex.model === this.ragEmbeddingProvider.model
        && (!providerDimension || this.ragIndex.dimension === providerDimension)
        && this.ragIndex.sourceIndexUpdatedAt === this.index?.updatedAt
        && this.ragIndex.indexTests === settings.indexTests
        && this.ragIndex.dimension > 0
        && this.ragIndex.vectors.length > 0,
    )
  }

  private ragIndexCanContinueElapsed() {
    const settings = this.getSettings().rag
    const providerDimension = this.ragEmbeddingProvider?.dimension && this.ragEmbeddingProvider.dimension > 0
      ? this.ragEmbeddingProvider.dimension
      : undefined
    return Boolean(
      this.ragIndex
        && this.ragEmbeddingProvider
        && this.ragIndex.provider === this.ragEmbeddingProvider.id
        && this.ragIndex.model === this.ragEmbeddingProvider.model
        && (!providerDimension || this.ragIndex.dimension <= 0 || this.ragIndex.dimension === providerDimension)
        && this.ragIndex.sourceIndexUpdatedAt === this.index?.updatedAt
        && this.ragIndex.indexTests === settings.indexTests
        && (this.ragIndex.pendingChunkCount ?? 0) > 0,
    )
  }

  private readyRagStatus(endpointKind: RagStatus["endpointKind"], rerankProbe: RerankProbeStatus, index: RagVectorIndex): RagStatus {
    return this.ragStatusForIndex(endpointKind, rerankProbe, index)
  }

  private ragStatusForIndex(endpointKind: RagStatus["endpointKind"], rerankProbe: RerankProbeStatus, index: RagVectorIndex): RagStatus {
    const totalChunks = index.totalChunks ?? index.chunks.length
    const pendingChunkCount = Math.max(0, index.pendingChunkCount ?? totalChunks - index.chunks.length)
    const indexAvailability = index.state === "stale"
      ? "paused"
      : pendingChunkCount > 0
      ? index.indexPausedReason ? "paused" : "partial"
      : "ready"
    const availability = indexAvailability
    const hasVectors = index.dimension > 0 && index.vectors.length > 0
    const fallbackReason = index.staleReason
      ? index.staleReason
      : index.indexPausedReason
      ? ragPausedReasonMessage(index.indexPausedReason, index.lastError)
      : pendingChunkCount > 0
        ? "RAG vector index is partially built; remaining chunks will be embedded on the next RAG index run"
        : undefined
    return {
      enabled: hasVectors,
      availability,
      indexAvailability,
      embeddingEnabled: hasVectors,
      rerankEnabled: rerankProbe.enabled,
      endpointKind,
      chunks: totalChunks,
      embeddedChunks: index.vectors.length,
      indexedChunkCount: index.vectors.length,
      pendingChunkCount,
      indexElapsedMs: index.buildElapsedMs,
      workerStatus: index.workerStatus,
      indexPausedReason: index.indexPausedReason,
      resumeScheduledAt: index.nextResumeAt,
      resumeDelayMs: index.resumeDelayMs,
      resumeReason: index.resumeReason,
      vectorShards: new Set(index.chunks.map((chunk) => chunk.shard)).size,
      embeddingProvider: index.provider,
      rerankProvider: rerankProbe.provider,
      rerankLastError: rerankProbe.lastError,
      dimension: index.dimension,
      updatedAt: index.updatedAt,
      lastError: index.lastError,
      fallbackReason,
    }
  }

  private ragStatusForIndexing(
    endpointKind: RagStatus["endpointKind"],
    rerankProbe: RerankProbeStatus,
    input: { progress?: RagIndexBuildProgress; index?: RagVectorIndex; indexElapsedMs?: number; workerStatus?: RagWorkerStatus; fallbackReason?: string } = {},
  ): RagStatus {
    const index = input.index ?? this.ragIndex
    const progress = input.progress
    const totalChunks = progress?.chunks ?? index?.totalChunks ?? this.ragStatusValue.chunks ?? 0
    const embeddedChunks = progress?.embeddedChunks ?? index?.vectors.length ?? this.ragStatusValue.embeddedChunks ?? 0
    const pendingChunkCount = progress?.pendingChunkCount ?? Math.max(0, totalChunks - embeddedChunks)
    const hasVectors = Boolean(index && index.dimension > 0 && index.vectors.length > 0)
    const indexElapsedMs = progress?.elapsedMs ?? index?.buildElapsedMs ?? input.indexElapsedMs
    const workerStatus = progress?.workerStatus ?? index?.workerStatus ?? input.workerStatus
    const previousProgress = this.ragStatusValue.indexProgress
    const indexProgress = progress
      ? this.ragIndexProgress(progress)
      : previousProgress
        ? {
            ...previousProgress,
            embeddedChunks,
            chunks: totalChunks,
            pendingChunkCount,
            updatedAt: Date.now(),
          }
        : undefined
    return {
      ...this.ragStatusValue,
      enabled: hasVectors,
      availability: "indexing",
      indexAvailability: hasVectors ? "partial" : "none",
      embeddingEnabled: hasVectors,
      rerankEnabled: rerankProbe.enabled,
      endpointKind,
      chunks: totalChunks,
      embeddedChunks,
      indexedChunkCount: embeddedChunks,
      pendingChunkCount,
      indexProgress,
      indexElapsedMs,
      workerStatus,
      indexPausedReason: undefined,
      resumeScheduledAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      vectorShards: index ? new Set(index.chunks.map((chunk) => chunk.shard)).size : this.ragStatusValue.vectorShards,
      embeddingProvider: index?.provider ?? this.ragEmbeddingProvider?.id ?? this.ragStatusValue.embeddingProvider,
      rerankProvider: rerankProbe.provider,
      rerankLastError: rerankProbe.lastError,
      dimension: index?.dimension ?? this.ragStatusValue.dimension,
      updatedAt: Date.now(),
      lastError: undefined,
      fallbackReason: input.fallbackReason ?? "RAG vector index is being built",
    }
  }

  private ragIndexProgress(progress: RagIndexBuildProgress): RagIndexProgress {
    return {
      ...progress,
      updatedAt: Date.now(),
    }
  }

  private setAbortedRagIndexStatus(endpointKind: RagStatus["endpointKind"], rerankProbe: RerankProbeStatus, message: string) {
    const queued = Boolean(this.pendingRagRefresh || this.pendingRagResumeTrigger)
    const suffix = queued ? "; another RAG rebuild is queued" : ""
    const interrupted = `RAG vector index build was interrupted${suffix}.`
    if (this.ragIndex?.indexPausedReason === "manual") {
      this.setRagStatus({
        ...this.ragStatusForIndex(endpointKind, rerankProbe, this.ragIndex),
        fallbackReason: ragPausedReasonMessage("manual", this.ragIndex.lastError ?? message),
        lastError: this.ragIndex.lastError ?? message,
        indexProgress: undefined,
      })
      return
    }
    if (this.ragIndex && this.ragIndex.dimension > 0 && this.ragIndex.vectors.length > 0) {
      this.setRagStatus({
        ...this.ragStatusForIndex(endpointKind, rerankProbe, this.ragIndex),
        availability: "partial",
        fallbackReason: interrupted,
        lastError: message,
        indexProgress: undefined,
      })
      return
    }

    const chunks = this.ragStatusValue.indexProgress?.chunks ?? this.ragStatusValue.chunks ?? 0
    this.setRagStatus({
      ...this.ragStatusValue,
      enabled: false,
      availability: "not-indexed",
      indexAvailability: "none",
      embeddingEnabled: false,
      rerankEnabled: rerankProbe.enabled,
      endpointKind,
      chunks,
      embeddedChunks: 0,
      indexedChunkCount: 0,
      pendingChunkCount: chunks,
      indexProgress: undefined,
      indexPausedReason: undefined,
      resumeScheduledAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      vectorShards: 0,
      rerankProvider: rerankProbe.provider,
      rerankLastError: rerankProbe.lastError,
      lastError: message,
      fallbackReason: `RAG vector index build was interrupted before vectors were saved${suffix}.`,
    })
  }

  private async pauseActiveRagIndex(reason: string, options: { requireCodeGraphPause?: boolean; pauseSequence?: number } = {}) {
    const pauseStillCurrent = () => options.requireCodeGraphPause
      ? this.paused
      : options.pauseSequence === undefined || this.ragManualPauseSequence === options.pauseSequence
    const activeOrQueued = Boolean(
      this.ragIndexInFlight
        || this.pendingRagRefresh
        || this.pendingRagResumeTrigger
        || this.ragStatusValue.availability === "indexing",
    )
    if (activeOrQueued) this.queuePendingRagRefresh(undefined, { continuePreviousElapsed: true })

    const snapshot = this.manualPausedRagSnapshot(reason)
    if (!snapshot) return
    if (!pauseStillCurrent()) return
    this.ragIndex = snapshot
    this.setRagStatus(this.ragStatusForManualPausedIndex(snapshot))

    const root = workspaceRoot()
    if (!root) return
    const saved = await this.saveRagIndex(root, snapshot, { state: "paused", completed: false })
    if (!pauseStillCurrent() || this.ragIndex?.indexPausedReason !== "manual") return
    this.ragIndex = saved
    this.setRagStatus(this.ragStatusForManualPausedIndex(saved))
    this.output.appendLine(`[rag-index] saved manual paused RAG index chunks=${saved.chunks.length}/${saved.totalChunks ?? saved.chunks.length} pending=${saved.pendingChunkCount ?? 0}`)
  }

  private manualPausedRagSnapshot(reason: string): RagVectorIndex | undefined {
    const root = workspaceRoot()
    if (!this.ragEmbeddingProvider) this.configureRagProviders()
    if (!root || !this.ragEmbeddingProvider) return undefined

    const progress = this.ragStatusValue.indexProgress
    const workerStatus = this.ragStatusValue.workerStatus
      ?? progress?.workerStatus
      ?? this.ragIndex?.workerStatus
      ?? initialRagWorkerStatus(this.getSettings().rag.embedding.concurrentRequests)
    const sourceIndexUpdatedAt = this.index?.updatedAt ?? this.ragIndex?.sourceIndexUpdatedAt
    const existing = this.ragIndex
    const existingMatchesActiveIndex = Boolean(
      existing
        && existing.provider === this.ragEmbeddingProvider.id
        && existing.model === this.ragEmbeddingProvider.model
        && existing.sourceIndexUpdatedAt === sourceIndexUpdatedAt
        && existing.indexTests === this.getSettings().rag.indexTests
        && existing.dimension > 0
        && existing.vectors.length > 0,
    )
    let totalChunks = Math.max(
      0,
      progress?.chunks ?? 0,
      this.ragStatusValue.chunks ?? 0,
      existing?.totalChunks ?? 0,
      existing?.chunks.length ?? 0,
    )
    if (totalChunks <= 0 && this.index && !this.isLazyManifestIndex()) {
      totalChunks = buildRagChunks(this.index, extractStateMachines(this.index, { maxTransitions: this.getSettings().codeGraph.maxStateTransitions }), {
        indexTests: this.getSettings().rag.indexTests,
      }).length
    }
    if (totalChunks <= 0) return undefined

    const chunks = existingMatchesActiveIndex ? existing!.chunks : []
    const vectors = existingMatchesActiveIndex ? existing!.vectors : []
    const dimension = vectors[0]?.length ?? this.ragEmbeddingProvider.dimension ?? existing?.dimension ?? 0
    return {
      version: 1,
      rootPath: root.uri.fsPath,
      updatedAt: Date.now(),
      sourceIndexUpdatedAt,
      indexTests: this.getSettings().rag.indexTests,
      provider: this.ragEmbeddingProvider.id,
      model: this.ragEmbeddingProvider.model,
      dimension,
      chunks,
      vectors,
      totalChunks,
      pendingChunkCount: Math.max(0, totalChunks - chunks.length),
      buildElapsedMs: this.ragStatusValue.indexElapsedMs ?? progress?.elapsedMs ?? existing?.buildElapsedMs,
      workerStatus,
      indexPausedReason: "manual",
      lastError: reason,
      requestsUsed: existing?.requestsUsed,
      nextResumeAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      extensionVersion: existing?.extensionVersion,
      buildId: existing?.buildId,
      state: "paused",
      completed: false,
      buildStartedAt: existing?.buildStartedAt,
    }
  }

  private resumeManualRagIndexing() {
    if (this.ragIndex?.indexPausedReason !== "manual") return false
    const pending = this.ragIndex.pendingChunkCount ?? Math.max(0, (this.ragIndex.totalChunks ?? this.ragIndex.chunks.length) - this.ragIndex.chunks.length)
    if (pending <= 0) return false
    this.ragIndex = {
      ...this.ragIndex,
      indexPausedReason: undefined,
      lastError: undefined,
      nextResumeAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      state: "building",
      completed: false,
    }
    this.queuePendingRagRefresh(undefined, { continuePreviousElapsed: true })
    this.output.appendLine(`[rag-index] resuming manual paused RAG index pending=${pending}`)
    this.runPendingRagRefreshWhenReady("manual-resume", { continuePreviousElapsed: true })
    return true
  }

  private clearManualRagPause(reason: string) {
    if (this.ragIndex?.indexPausedReason !== "manual") return
    const root = workspaceRoot()
    const pending = this.ragIndex.pendingChunkCount ?? Math.max(0, (this.ragIndex.totalChunks ?? this.ragIndex.chunks.length) - this.ragIndex.chunks.length)
    const hasVectors = this.ragIndex.dimension > 0 && this.ragIndex.vectors.length > 0
    if (hasVectors) {
      const index: RagVectorIndex = {
        ...this.ragIndex,
        indexPausedReason: undefined,
        lastError: undefined,
        nextResumeAt: undefined,
        resumeDelayMs: undefined,
        resumeReason: undefined,
        state: pending > 0 ? "building" : "ready",
        completed: pending <= 0,
      }
      this.ragIndex = index
      this.setRagStatus({
        ...this.ragStatusForIndex(this.ragStatusValue.endpointKind, {
          enabled: this.ragStatusValue.rerankEnabled,
          provider: this.ragStatusValue.rerankProvider,
          lastError: this.ragStatusValue.rerankLastError,
        }, index),
        availability: pending > 0 ? "partial" : "ready",
        fallbackReason: pending > 0 ? `RAG indexing cancelled: ${reason}.` : undefined,
        lastError: pending > 0 ? reason : undefined,
        indexProgress: undefined,
      })
      if (root) {
        void this.saveRagIndex(root, index, { state: index.state, completed: index.completed }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.output.appendLine(`[rag-index] failed to persist cancelled manual paused RAG index: ${message}`)
        })
      }
      return
    }

    this.ragIndex = undefined
    this.setRagStatus({
      ...this.ragStatusValue,
      enabled: false,
      availability: "not-indexed",
      indexAvailability: "none",
      embeddingEnabled: false,
      indexProgress: undefined,
      indexPausedReason: undefined,
      resumeScheduledAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      embeddedChunks: 0,
      indexedChunkCount: 0,
      vectorShards: 0,
      lastError: reason,
      fallbackReason: `RAG indexing cancelled: ${reason}.`,
    })
    if (root) {
      void this.clearStoredRagIndex(root, "after cancelling manual paused RAG index").catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.output.appendLine(`[rag-index] failed to clear cancelled manual paused RAG index: ${message}`)
      })
    }
  }

  private ragStatusForManualPausedIndex(index: RagVectorIndex): RagStatus {
    return {
      ...this.ragStatusForIndex(this.ragStatusValue.endpointKind, {
        enabled: this.ragStatusValue.rerankEnabled,
        provider: this.ragStatusValue.rerankProvider,
        lastError: this.ragStatusValue.rerankLastError,
      }, index),
      availability: "paused",
      indexAvailability: "paused",
      indexProgress: undefined,
      indexPausedReason: "manual",
      resumeScheduledAt: undefined,
      resumeDelayMs: undefined,
      resumeReason: undefined,
      fallbackReason: ragPausedReasonMessage("manual", index.lastError),
      lastError: index.lastError,
    }
  }

  private isManualRagIndexPaused() {
    return Boolean(
      this.ragIndex?.indexPausedReason === "manual"
        || (this.ragStatusValue.availability === "paused" && this.ragStatusValue.indexPausedReason === "manual"),
    )
  }

  private scheduleRagRefreshAfterCodeGraphReady(changedPaths?: string[]) {
    this.queuePendingRagRefresh(changedPaths)
    this.schedulePendingRagWorkAfterCodeGraphReady("code graph ready")
  }

  private clearPendingRagWorkTimer() {
    if (!this.pendingRagWorkTimer) return
    clearTimeout(this.pendingRagWorkTimer)
    this.pendingRagWorkTimer = undefined
  }

  private schedulePendingRagWorkAfterCodeGraphReady(reason: string, delayMs = 0) {
    if (this.disposed) return
    if (!this.pendingRagRefresh && !this.pendingRagResumeTrigger) {
      this.clearPendingRagWorkTimer()
      return
    }
    if (this.isManualRagIndexPaused()) {
      this.clearPendingRagWorkTimer()
      this.output.appendLine(`[rag-index] pending RAG work preserved while RAG indexing is manually paused reason=${reason}`)
      return
    }
    if (this.paused) {
      this.clearPendingRagWorkTimer()
      this.output.appendLine(`[rag-index] pending RAG work preserved while indexing is paused reason=${reason}`)
      return
    }
    this.clearPendingRagWorkTimer()
    this.pendingRagWorkTimer = setTimeout(() => {
      this.pendingRagWorkTimer = undefined
      this.runPendingRagRefreshWhenReady(reason)
    }, delayMs)
  }

  private runPendingRagRefreshWhenReady(reason: string, options: { restartInFlight?: boolean; ignorePrevious?: boolean; continuePreviousElapsed?: boolean } = {}) {
    if (this.disposed) return
    if (!this.pendingRagRefresh && !this.pendingRagResumeTrigger) return
    if (this.isManualRagIndexPaused()) {
      this.clearPendingRagWorkTimer()
      this.output.appendLine(`[rag-index] pending RAG work preserved while RAG indexing is manually paused reason=${reason}`)
      return
    }
    if (this.paused) {
      this.clearPendingRagWorkTimer()
      this.output.appendLine(`[rag-index] pending RAG work preserved while indexing is paused reason=${reason}`)
      return
    }
    if (!this.isCodeGraphReadyForRag()) {
      this.setRagWaitingForCodeGraphStatus()
      this.output.appendLine(`[rag-index] waiting for code graph before rebuild reason=${reason}`)
      if (this.statusValue.state === "ready") this.schedulePendingRagWorkAfterCodeGraphReady(reason, RAG_PENDING_READY_RETRY_MS)
      return
    }
    const pending = this.pendingRagRefresh
    const resumeTrigger = this.pendingRagResumeTrigger
    const ignorePrevious = this.pendingRagRefreshIgnorePrevious || Boolean(options.ignorePrevious)
    const continuePreviousElapsed = this.pendingRagRefreshContinuePreviousElapsed || Boolean(options.continuePreviousElapsed)
    this.pendingRagRefresh = undefined
    this.pendingRagRefreshIgnorePrevious = false
    this.pendingRagRefreshContinuePreviousElapsed = false
    this.pendingRagResumeTrigger = undefined
    if (pending) {
      void this.refreshRagIndex(pending === "full" ? undefined : [...pending], {
        restartInFlight: options.restartInFlight,
        reason,
        ignorePrevious,
        continuePreviousElapsed,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.output.appendLine(`[rag-index] pending rebuild failed reason=${reason}: ${message}`)
      })
      return
    }
    if (resumeTrigger) {
      void this.scheduleRagIndexResumeFromStatus(resumeTrigger).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.output.appendLine(`[rag-index] pending resume scheduling failed reason=${reason}: ${message}`)
      })
    }
  }

  private isCodeGraphReadyForRag() {
    return Boolean(
      workspaceRoot()
        && this.index
        && this.statusValue.state === "ready"
        && !this.indexing
        && !this.jobs.hasPending()
        && !this.jobs.snapshot().activeJobKind,
    )
  }

  private setRagWaitingForCodeGraphStatus() {
    this.setRagStatus({
      ...this.ragStatusValue,
      enabled: false,
      availability: this.index ? "checking" : "not-indexed",
      embeddingEnabled: false,
      fallbackReason: "Waiting for local code graph indexing before RAG rebuild.",
      lastError: undefined,
    })
  }

  private async refreshRagIndex(changedPaths?: string[], options: { restartInFlight?: boolean; reason?: string; continuePreviousElapsed?: boolean; ignorePrevious?: boolean } = {}) {
    if (this.isManualRagIndexPaused()) {
      this.queuePendingRagRefresh(changedPaths, {
        ignorePrevious: options.ignorePrevious,
        continuePreviousElapsed: options.continuePreviousElapsed,
      })
      this.clearPendingRagWorkTimer()
      this.output.appendLine(`[rag-index] pending RAG work preserved while RAG indexing is manually paused reason=${options.reason ?? "manual-pause"}`)
      return
    }
    if (this.paused) {
      this.queuePendingRagRefresh(changedPaths, {
        ignorePrevious: options.ignorePrevious,
        continuePreviousElapsed: options.continuePreviousElapsed,
      })
      this.output.appendLine(`[rag-index] rebuild deferred while indexing is paused reason=${options.reason ?? "paused"}`)
      return
    }
    if (!this.isCodeGraphReadyForRag()) {
      this.queuePendingRagRefresh(changedPaths, {
        ignorePrevious: options.ignorePrevious,
        continuePreviousElapsed: options.continuePreviousElapsed,
      })
      this.setRagWaitingForCodeGraphStatus()
      this.output.appendLine(`[rag-index] queued rebuild until code graph is ready reason=${options.reason ?? "not-ready"}`)
      return
    }
    if (this.ragIndexInFlight) {
      this.queuePendingRagRefresh(changedPaths, {
        ignorePrevious: options.ignorePrevious,
        continuePreviousElapsed: options.continuePreviousElapsed,
      })
      if (options.restartInFlight) this.abortRagIndex(options.reason ?? "RAG index restart requested")
      await this.ragIndexInFlight
      return
    }
    this.clearRagIndexResume()
    const controller = new AbortController()
    this.ragIndexController = controller
    this.ragIndexInFlight = this.rebuildRagIndex(changedPaths, controller.signal, {
      continuePreviousElapsed: options.continuePreviousElapsed,
      ignorePrevious: options.ignorePrevious,
    }).finally(async () => {
      if (this.ragIndexController === controller) this.ragIndexController = undefined
      this.ragIndexInFlight = undefined
      if (this.isManualRagIndexPaused()) {
        if (this.pendingRagRefresh || this.pendingRagResumeTrigger) {
          this.output.appendLine("[rag-index] pending RAG work preserved while RAG indexing is manually paused reason=active-build-finished")
        }
        return
      }
      const pending = this.pendingRagRefresh
      const ignorePrevious = this.pendingRagRefreshIgnorePrevious
      const continuePreviousElapsed = this.pendingRagRefreshContinuePreviousElapsed
      this.pendingRagRefresh = undefined
      this.pendingRagRefreshIgnorePrevious = false
      this.pendingRagRefreshContinuePreviousElapsed = false
      if (pending) await this.refreshRagIndex(pending === "full" ? undefined : [...pending], { ignorePrevious, continuePreviousElapsed })
    })
    await this.ragIndexInFlight
  }

  private abortRagIndex(reason: string) {
    if (!this.ragIndexController || this.ragIndexController.signal.aborted) return
    this.output.appendLine(`[rag-index] aborting active build: ${reason}`)
    this.ragIndexController.abort()
  }

  private suspendRagWorkForCodeGraphIndexing(reason: string) {
    const hadPendingWork = Boolean(this.ragIndexInFlight || this.pendingRagRefresh || this.pendingRagResumeTrigger || this.ragResumeTimer)
    this.clearRagIndexResume()
    this.abortRagIndex(reason)
    if (hadPendingWork) this.setRagWaitingForCodeGraphStatus()
  }

  private queuePendingRagRefresh(changedPaths?: string[], options: { ignorePrevious?: boolean; continuePreviousElapsed?: boolean } = {}) {
    this.pendingRagResumeTrigger = undefined
    if (options.ignorePrevious) this.pendingRagRefreshIgnorePrevious = true
    if (options.continuePreviousElapsed) this.pendingRagRefreshContinuePreviousElapsed = true
    if (!changedPaths) {
      this.pendingRagRefresh = "full"
      return
    }
    if (this.pendingRagRefresh === "full") return
    const pending = this.pendingRagRefresh ?? new Set<string>()
    for (const path of changedPaths) pending.add(path)
    this.pendingRagRefresh = pending
  }

  private clearRagIndexResume() {
    if (this.ragResumeTimer) clearTimeout(this.ragResumeTimer)
    this.ragResumeTimer = undefined
    this.pendingRagResumeTrigger = undefined
    if (this.ragIndex?.nextResumeAt || this.ragIndex?.resumeReason || this.ragIndex?.resumeDelayMs) {
      this.ragIndex = {
        ...this.ragIndex,
        nextResumeAt: undefined,
        resumeReason: undefined,
        resumeDelayMs: undefined,
      }
      this.setRagStatus(this.ragStatusValue.resumeScheduledAt ? {
        ...this.ragStatusValue,
        resumeScheduledAt: undefined,
        resumeReason: undefined,
        resumeDelayMs: undefined,
      } : this.ragStatusValue)
    }
  }

  private async scheduleRagIndexResumeFromStatus(trigger: string) {
    const settings = this.getSettings().rag
    if (settings.embedding.configError) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.setRagStatus(await this.ragEmbeddingConfigErrorStatus(settings))
      return
    }
    const index = this.ragIndex
    const reason = index?.indexPausedReason
    const pending = index?.pendingChunkCount ?? 0
    if (!index || pending <= 0) {
      this.clearRagIndexResume()
      return
    }
    if (index.state === "stale" || index.staleReason) {
      this.clearRagIndexResume()
      this.output.appendLine(`[rag-index] auto resume skipped reason=stale pending=${pending}${index.staleReason ? ` detail=${index.staleReason}` : ""}`)
      return
    }
    if (reason === "manual") {
      this.clearRagIndexResume()
      this.output.appendLine(`[rag-index] auto resume skipped reason=manual pending=${pending}`)
      return
    }
    if (!settings.embedding.resumeAutomatically) {
      this.clearRagIndexResume()
      this.output.appendLine(`[rag-index] auto resume skipped reason=disabled pending=${pending}`)
      return
    }
    if (this.disposed || this.paused) {
      this.output.appendLine(`[rag-index] auto resume skipped reason=${this.disposed ? "disposed" : "codegraph-paused"} pending=${pending}`)
      return
    }
    if (!this.isCodeGraphReadyForRag()) {
      this.pendingRagResumeTrigger = trigger
      this.setRagWaitingForCodeGraphStatus()
      this.output.appendLine(`[rag-index] auto resume deferred until code graph is ready trigger=${trigger} pending=${pending}`)
      return
    }
    const crossVersionValidatedResume = index.resumeCompatibility === "cross-version-validated"
    if (reason !== "request-budget" && reason !== "rate-limit" && !crossVersionValidatedResume) {
      this.clearRagIndexResume()
      this.output.appendLine(`[rag-index] auto resume skipped reason=${reason ?? "not-paused"} pending=${pending}`)
      return
    }
    if (!settings.embedding.endpoint || !this.getSettings().codeGraph.enabled) {
      this.clearRagIndexResume()
      return
    }
    const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
    if (!policy.ok) {
      this.clearRagIndexResume()
      return
    }

    if (reason !== "request-budget" && reason !== "rate-limit") {
      if (crossVersionValidatedResume) {
        this.clearRagIndexResume()
        this.queuePendingRagRefresh(undefined, { continuePreviousElapsed: true })
        this.output.appendLine(`[rag-index] cross-version partial validated for safe resume trigger=${trigger} pending=${pending}`)
        this.runPendingRagRefreshWhenReady("cross-version partial validated for safe resume", { continuePreviousElapsed: true })
        return
      }
      this.clearRagIndexResume()
      this.output.appendLine(`[rag-index] auto resume skipped reason=${reason ?? "not-paused"} pending=${pending}`)
      return
    }

    const resumeReason = reason
    const delayMs = this.ragResumeDelayMs(index, resumeReason)
    const nextResumeAt = Date.now() + delayMs
    const scheduled = {
      ...index,
      nextResumeAt,
      resumeDelayMs: delayMs,
      resumeReason: resumeReason satisfies RagResumeReason,
    }
    this.ragIndex = scheduled
    this.setRagStatus({
      ...this.ragStatusForIndex(policy.kind, {
        enabled: this.ragStatusValue.rerankEnabled,
        provider: this.ragStatusValue.rerankProvider,
        lastError: this.ragStatusValue.rerankLastError,
      }, scheduled),
      resumeScheduledAt: nextResumeAt,
      resumeDelayMs: delayMs,
      resumeReason,
    })
    const root = workspaceRoot()
    if (root) this.ragIndex = await this.saveRagIndex(root, scheduled)

    if (this.ragResumeTimer) clearTimeout(this.ragResumeTimer)
    this.output.appendLine(`[rag-index] resume scheduled reason=${resumeReason} trigger=${trigger} delayMs=${delayMs} pending=${pending}`)
    this.ragResumeTimer = setTimeout(() => {
      this.ragResumeTimer = undefined
      this.ragResumeInFlight = this.runRagIndexResume(resumeReason, pending)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.output.appendLine(`[rag-index] auto resume failed: ${message}`)
        })
        .finally(() => {
          this.ragResumeInFlight = undefined
        })
    }, delayMs)
  }

  private ragResumeDelayMs(index: RagVectorIndex, reason: RagResumeReason) {
    const settings = this.getSettings().rag.embedding
    if (reason === "rate-limit") {
      const fallback = settings.resumeDelayMs || settings.retryBackoffMs
      return Math.max(0, Math.floor(index.resumeDelayMs ?? fallback))
    }
    return Math.max(0, Math.floor(settings.resumeDelayMs))
  }

  private async runRagIndexResume(reason: RagResumeReason, pendingAtSchedule: number) {
    if (this.disposed || this.paused) return
    const pending = this.ragIndex?.pendingChunkCount ?? 0
    if (pending <= 0) return
    this.output.appendLine(`[rag-index] auto resume starting reason=${reason} pending=${pending} scheduledPending=${pendingAtSchedule}`)
    await this.refreshRagIndex(undefined, { reason: `auto-resume:${reason}`, continuePreviousElapsed: true })
  }

  private async rebuildRagIndex(changedPaths?: string[], signal?: AbortSignal, options: { continuePreviousElapsed?: boolean; ignorePrevious?: boolean } = {}) {
    const root = workspaceRoot()
    const settings = this.getSettings().rag
    await this.refreshProviderApiKey()
    this.queryCache.clear()
    if (!root || !this.index) return
    if (settings.embedding.configError) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.setRagStatus(await this.ragEmbeddingConfigErrorStatus(settings))
      return
    }
    if (!settings.embedding.endpoint) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      this.setRagStatus({
        ...disabledRagStatus("embedding endpoint not configured; BM25/graph/state-machine fallback active"),
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      })
      return
    }
    const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
    if (!policy.ok) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      this.setRagStatus({
        ...disabledRagStatus(policy.reason),
        availability: "unavailable",
        rerankEnabled: rerankProbe.enabled,
        endpointKind: policy.kind,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
        fallbackReason: policy.reason,
      })
      return
    }
    this.configureRagProviders()
    const rerankProbe = await this.probeConfiguredRerankProvider()
    if (!this.ragEmbeddingProvider) {
      this.clearRagIndexResume()
      this.setRagStatus({
        ...disabledRagStatus("embedding provider is not configured"),
        availability: "unavailable",
        endpointKind: policy.kind,
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      })
      return
    }

    const started = Date.now()
    const buildId = crypto.randomUUID()
    const buildStartedAt = Date.now()
    const continuePreviousElapsed = Boolean(options.continuePreviousElapsed && !options.ignorePrevious && !changedPaths && this.ragIndexCanContinueElapsed())
    const initialElapsedMs = continuePreviousElapsed
      ? Math.max(0, Math.floor(this.ragIndex?.buildElapsedMs ?? this.ragStatusValue.indexElapsedMs ?? 0))
      : 0
    const initialWorkerStatus = continuePreviousElapsed
      ? this.ragIndex?.workerStatus ?? initialRagWorkerStatus(settings.embedding.concurrentRequests)
      : initialRagWorkerStatus(settings.embedding.concurrentRequests)
    const existingRagStatus = this.currentRagIndexMatchesProvider()
      ? this.ragStatusForIndex(policy.kind, rerankProbe, this.ragIndex!)
      : this.ragStatusValue
    this.setRagStatus({
      ...existingRagStatus,
      enabled: existingRagStatus.embeddingEnabled,
      availability: "checking",
      rerankEnabled: rerankProbe.enabled,
      endpointKind: policy.kind,
      fallbackReason: "checking embedding endpoint and vector index",
      lastError: undefined,
      rerankLastError: rerankProbe.lastError,
      embeddingProvider: this.ragEmbeddingProvider.id,
      rerankProvider: rerankProbe.provider,
    })
    try {
      const activeIndex = this.isLazyManifestIndex() ? await this.activeIndexForQuestion("", []) : this.index
      if (!activeIndex) {
        this.setRagStatus({
          ...this.ragStatusValue,
          enabled: false,
          availability: "not-indexed",
          embeddingEnabled: false,
          fallbackReason: "No active local code graph index is available for RAG rebuild.",
        })
        return
      }
      this.setRagStatus(this.ragStatusForIndexing(policy.kind, rerankProbe, {
        indexElapsedMs: initialElapsedMs,
        workerStatus: initialWorkerStatus,
      }))
      const checkpointPlan = ragEmbeddingCheckpointPlan(settings.embedding)
      const adaptiveCeiling = Math.min(8, settings.embedding.concurrentRequests + 1)
      let savedFinalDuringBuild = false
      this.output.appendLine(`[rag-index] embedding ${changedPaths ? `${changedPaths.length} changed path(s)` : "full local code graph"} with batchSize=${settings.embedding.batchSize} maxTokensPerRequest=${settings.embedding.maxTokensPerRequest} concurrentRequests=${settings.embedding.concurrentRequests} adaptiveCeiling=${adaptiveCeiling} maxInFlightTokens=${settings.embedding.maxInFlightTokens} encodingFormat=${settings.embedding.encodingFormat} timeoutMs=${settings.embedding.timeoutMs} requestDelayMs=${settings.embedding.requestDelayMs} maxRequestsPerRun=${settings.embedding.maxRequestsPerRun || "unlimited"} maxRetries=${settings.embedding.maxRetries} retryBackoffMs=${settings.embedding.retryBackoffMs} checkpointMode=${checkpointPlan.mode} checkpointChunkInterval=${checkpointPlan.chunkInterval} checkpointIntervalMs=${checkpointPlan.intervalMs}`)
      const next = await buildRagVectorIndex({
        index: activeIndex,
        provider: this.ragEmbeddingProvider,
        sourceIndexUpdatedAt: this.index.updatedAt,
        indexTests: settings.indexTests,
        signal,
        previous: options.ignorePrevious ? undefined : this.ragIndex,
        changedPaths,
        stateMachines: extractStateMachines(activeIndex, { maxTransitions: this.getSettings().codeGraph.maxStateTransitions }),
        batchSize: settings.embedding.batchSize,
        maxTokensPerRequest: settings.embedding.maxTokensPerRequest,
        concurrentRequests: settings.embedding.concurrentRequests,
        maxInFlightTokens: settings.embedding.maxInFlightTokens,
        requestDelayMs: settings.embedding.requestDelayMs,
        maxRequestsPerRun: settings.embedding.maxRequestsPerRun,
        maxRetries: settings.embedding.maxRetries,
        retryBackoffMs: settings.embedding.retryBackoffMs,
        initialElapsedMs,
        resumeMissing: settings.embedding.resumeAutomatically || !changedPaths,
        checkpointChunkInterval: checkpointPlan.chunkInterval,
        checkpointIntervalMs: checkpointPlan.intervalMs,
        onProgress: (event) => {
          this.output.appendLine(formatRagIndexBuildProgress(event))
          this.setRagStatus(this.ragStatusForIndexing(policy.kind, rerankProbe, { progress: event }))
        },
        onBatchProfile: (event) => {
          this.output.appendLine(formatRagIndexBatchProfile(event))
        },
        onBuildSummary: (event) => {
          this.output.appendLine(formatRagIndexBuildSummary(event))
        },
        onSchedulerBlocked: (event) => {
          this.output.appendLine(formatRagEmbeddingSchedulerBlocked(event))
        },
        onIndexUpdate: async (partial) => {
          if (signal?.aborted) return
          if (partial.dimension <= 0 || partial.vectors.length === 0) return
          this.ragIndex = await this.saveRagIndex(root, partial, {
            buildId,
            buildStartedAt,
          })
          savedFinalDuringBuild = Boolean((partial.pendingChunkCount ?? 0) === 0 && !partial.indexPausedReason)
          if (signal?.aborted) return
          this.setRagStatus(this.ragStatusForIndexing(policy.kind, rerankProbe, { index: this.ragIndex }))
        },
      })
      if ((next.requestsUsed ?? 0) === 0) await this.probeRagEmbeddingProvider(next.dimension, signal)
      if (signal?.aborted) throw new RagIndexAbortError()
      this.lastRagElapsedMs = next.buildElapsedMs ?? initialElapsedMs + Date.now() - started
      if (!savedFinalDuringBuild || next.indexPausedReason || (next.pendingChunkCount ?? 0) > 0) {
        this.ragIndex = await this.saveRagIndex(root, next, {
          buildId,
          buildStartedAt,
          buildFinishedAt: (next.pendingChunkCount ?? 0) === 0 && !next.indexPausedReason ? Date.now() : undefined,
        })
      } else {
        this.ragIndex = this.ragIndex ?? next
      }
      if (signal?.aborted) throw new RagIndexAbortError()
      const saved = this.ragIndex ?? next
      this.setRagStatus(this.ragStatusForIndex(policy.kind, rerankProbe, saved))
      this.output.appendLine(`[rag-index] embedded ${saved.vectors.length}/${saved.totalChunks ?? saved.chunks.length} chunk(s) totalElapsedMs=${this.lastRagElapsedMs}${saved.indexPausedReason ? ` paused=${saved.indexPausedReason}` : ""}`)
      await this.scheduleRagIndexResumeFromStatus("index-build")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRagElapsedMs = this.ragStatusValue.indexElapsedMs ?? initialElapsedMs + Date.now() - started
      if (error instanceof RagIndexAbortError || signal?.aborted) {
        this.output.appendLine(`[rag-index] embedding index aborted after ${this.lastRagElapsedMs}ms: ${message}`)
        this.setAbortedRagIndexStatus(policy.kind, rerankProbe, message)
        return
      }
      this.setRagStatus({
        ...this.ragStatusValue,
        enabled: false,
        availability: "unavailable",
        embeddingEnabled: false,
        rerankEnabled: rerankProbe.enabled,
        endpointKind: policy.kind,
        lastError: message,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
        fallbackReason: message,
      })
      this.output.appendLine(`[rag] embedding index failed after ${this.lastRagElapsedMs}ms: ${message}`)
    }
  }

  private async saveRagIndex(root: vscode.WorkspaceFolder, index: RagVectorIndex, metadata: Partial<RagManifestLifecycleMetadata> = {}) {
    const dir = this.ragDir(root)
    const shardsDir = vscode.Uri.joinPath(dir, "shards")
    await vscode.workspace.fs.createDirectory(shardsDir)
    const savedIndex = this.ragIndexWithLifecycle(index, metadata)
    const manifest = createRagSerializedManifest(savedIndex)
    for (const shard of splitRagVectorIndex(savedIndex)) {
      const shardMetadata: RagSerializedShardMetadata = {
        version: 1,
        key: shard.key,
        dimension: savedIndex.dimension,
        chunks: shard.chunks,
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.json`), encodeJson(shardMetadata, `rag shard metadata ${shard.key}`))
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.f32`), encodeRaw(encodeRagShardVectors(shard.vectors, savedIndex.dimension)))
    }
    await vscode.workspace.fs.writeFile(this.ragManifestUri(root), encodeJson(manifest, "rag manifest"))
    return savedIndex
  }

  private async clearStoredRagIndex(root: vscode.WorkspaceFolder, reason = "before force rebuild") {
    try {
      await vscode.workspace.fs.delete(this.ragDir(root), { recursive: true, useTrash: false })
      this.output.appendLine(`[rag-index] cleared stored RAG vector index ${reason}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/FileNotFound|ENOENT|does not exist|nonexistent file|no such file/i.test(message)) return true
      this.output.appendLine(`[rag-index] failed to clear stored RAG vector index ${reason}: ${message}`)
      return false
    }
  }

  private ragIndexWithLifecycle(index: RagVectorIndex, metadata: Partial<RagManifestLifecycleMetadata>): RagVectorIndex {
    const pending = Math.max(0, index.pendingChunkCount ?? (index.totalChunks ?? index.chunks.length) - index.chunks.length)
    const completed = metadata.completed ?? index.completed ?? pending === 0
    const state = metadata.state ?? index.state ?? (
      index.staleReason ? "stale" : completed ? "ready" : index.indexPausedReason ? "paused" : "building"
    )
    const buildFinishedAt = metadata.buildFinishedAt ?? index.buildFinishedAt ?? (completed ? Date.now() : undefined)
    return {
      ...index,
      extensionVersion: metadata.extensionVersion ?? index.extensionVersion ?? this.extensionVersion(),
      buildId: metadata.buildId ?? index.buildId,
      state,
      completed,
      staleReason: metadata.staleReason ?? index.staleReason,
      buildStartedAt: metadata.buildStartedAt ?? index.buildStartedAt,
      buildFinishedAt,
    }
  }

  private extensionVersion() {
    const value = (this.context.extension.packageJSON as { version?: unknown }).version
    return typeof value === "string" && value.trim() ? value.trim() : "unknown"
  }

  private async probeRagEmbeddingProvider(dimension: number, signal?: AbortSignal) {
    if (!this.ragEmbeddingProvider) throw new Error("embedding provider is not configured")
    const vector = (await this.ragEmbeddingProvider.embed(["ChipMate RAG connectivity probe"], signal))[0]
    if (!vector) throw new Error("embedding provider returned no probe vector")
    if (dimension > 0 && vector.length !== dimension) {
      throw new Error(`embedding provider returned ${vector.length} dimension(s), expected ${dimension}`)
    }
  }

  private async loadRagIndex(root: vscode.WorkspaceFolder) {
    const settings = this.getSettings().rag
    await this.refreshProviderApiKey()
    if (settings.embedding.configError) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.setRagStatus(await this.ragEmbeddingConfigErrorStatus(settings))
      return
    }
    if (!settings.embedding.endpoint) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      this.setRagStatus({
        ...disabledRagStatus("embedding endpoint not configured; BM25/graph/state-machine fallback active"),
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      })
      return
    }

    const policy = checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts)
    if (!policy.ok) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.configureRagProviders()
      const rerankProbe = await this.probeConfiguredRerankProvider()
      this.setRagStatus({
        ...disabledRagStatus(policy.reason),
        availability: "unavailable",
        endpointKind: policy.kind,
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
        fallbackReason: policy.reason,
      })
      return
    }

    this.configureRagProviders()
    const rerankProbe = await this.probeConfiguredRerankProvider()
    if (!this.ragEmbeddingProvider) {
      this.clearRagIndexResume()
      this.ragIndex = undefined
      this.setRagStatus({
        ...disabledRagStatus("embedding provider is not configured"),
        availability: "unavailable",
        endpointKind: policy.kind,
        rerankEnabled: rerankProbe.enabled,
        rerankProvider: rerankProbe.provider,
        rerankLastError: rerankProbe.lastError,
      })
      return
    }

    try {
      const manifestBytes = await vscode.workspace.fs.readFile(this.ragManifestUri(root))
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RagSerializedManifest
      if (manifest.version !== 1 || manifest.rootPath !== root.uri.fsPath) {
        this.ragIndex = undefined
        this.setRagStatus(await this.probeRagProvidersOnly())
        return
      }
      if (manifest.provider !== this.ragEmbeddingProvider.id || manifest.model !== this.ragEmbeddingProvider.model) {
        this.ragIndex = undefined
        this.setRagStatus(await this.probeRagProvidersOnly())
        return
      }
      if (manifest.indexTests !== settings.indexTests) {
        this.output.appendLine(`[rag-index] stored vector index content policy changed; rebuild required indexTests=${settings.indexTests}`)
        this.ragIndex = undefined
        this.setRagStatus(await this.probeRagProvidersOnly())
        return
      }
      const currentExtensionVersion = this.extensionVersion()
      const staleReason = ragManifestStaleReason(manifest, currentExtensionVersion)
      const chunks: RagVectorIndex["chunks"] = []
      const vectors: RagVectorIndex["vectors"] = []
      const loadedShards: RagLoadedShardForResumeValidation[] = []
      const shardsDir = vscode.Uri.joinPath(this.ragDir(root), "shards")
      try {
        for (const shard of manifest.shards) {
          const metadataBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.json`))
          const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as RagSerializedShardMetadata
          const vectorBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(shardsDir, `${shard.key}.f32`))
          const shardVectors = decodeRagShardVectors(vectorBytes, manifest.dimension)
          loadedShards.push({ manifest: shard, metadata, vectors: shardVectors })
          chunks.push(...metadata.chunks)
          vectors.push(...shardVectors)
        }
      } catch (error) {
        if (staleReason) {
          const message = error instanceof Error ? error.message : String(error)
          this.output.appendLine(`[rag-index] cross-version partial resume rejected: failed to read shard data: ${message}`)
        }
        throw error
      }
      const crossVersionResume = staleReason
        ? validateRagCrossVersionPartialResume({
            manifest,
            currentExtensionVersion,
            rootPath: root.uri.fsPath,
            provider: this.ragEmbeddingProvider.id,
            model: this.ragEmbeddingProvider.model,
            providerDimension: this.ragEmbeddingProvider.dimension,
            sourceIndexUpdatedAt: this.index?.updatedAt,
            indexTests: settings.indexTests,
            shards: loadedShards,
          })
        : undefined
      const resumeCompatibility = crossVersionResume?.ok ? crossVersionResume.resumeCompatibility : undefined
      if (staleReason && crossVersionResume && !crossVersionResume.ok) {
        this.output.appendLine(`[rag-index] cross-version partial resume rejected: ${crossVersionResume.reason}`)
      }
      this.ragIndex = {
        version: 1,
        rootPath: manifest.rootPath,
        updatedAt: manifest.updatedAt,
        provider: manifest.provider,
        model: manifest.model,
        dimension: manifest.dimension,
        sourceIndexUpdatedAt: manifest.sourceIndexUpdatedAt,
        indexTests: manifest.indexTests,
        chunks,
        vectors,
        totalChunks: manifest.totalChunks ?? manifest.chunks,
        pendingChunkCount: manifest.pendingChunks ?? Math.max(0, (manifest.totalChunks ?? manifest.chunks) - chunks.length),
        buildElapsedMs: manifest.buildElapsedMs,
        workerStatus: manifest.workerStatus,
        indexPausedReason: manifest.indexPausedReason,
        lastError: manifest.lastError,
        nextResumeAt: manifest.nextResumeAt,
        resumeDelayMs: manifest.resumeDelayMs,
        resumeReason: manifest.resumeReason,
        extensionVersion: manifest.extensionVersion,
        buildId: manifest.buildId,
        state: resumeCompatibility ? manifest.indexPausedReason ? "paused" : "building" : staleReason ? "stale" : manifest.state,
        completed: resumeCompatibility ? false : staleReason ? false : manifest.completed,
        staleReason: resumeCompatibility ? undefined : staleReason ?? manifest.staleReason,
        resumeCompatibility,
        buildStartedAt: manifest.buildStartedAt,
        buildFinishedAt: manifest.buildFinishedAt,
      }
      try {
        await this.probeRagEmbeddingProvider(manifest.dimension)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.output.appendLine(`[rag-index] loaded existing vector index but embedding probe failed: ${message}`)
        this.setRagStatus({
          ...this.ragStatusForIndex(policy.kind, rerankProbe, this.ragIndex),
          enabled: false,
          availability: "unavailable",
          embeddingEnabled: false,
          lastError: message,
          fallbackReason: `Loaded existing RAG vector index, but embedding endpoint probe failed: ${message}`,
        })
        return
      }
      this.setRagStatus(this.ragStatusForIndex(policy.kind, rerankProbe, this.ragIndex))
      if (staleReason && resumeCompatibility) {
        const pending = this.ragIndex.pendingChunkCount ?? 0
        this.output.appendLine(`[rag-index] loaded cross-version partial vector index; cross-version partial validated for safe resume previousExtensionVersion=${manifest.extensionVersion} currentExtensionVersion=${currentExtensionVersion} pending=${pending}`)
        await this.scheduleRagIndexResumeFromStatus("index-load")
      } else if (staleReason) {
        this.output.appendLine(`[rag-index] loaded stale partial vector index; auto resume disabled: ${staleReason}`)
      } else if (this.currentRagIndexMatchesProvider()) {
        await this.scheduleRagIndexResumeFromStatus("index-load")
      } else {
        this.queuePendingRagRefresh()
        this.setRagWaitingForCodeGraphStatus()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output.appendLine(`[rag-index] failed to load stored vector index: ${message}`)
      this.ragIndex = undefined
      this.setRagStatus(await this.probeRagProvidersOnly())
    }
  }

  private setRagStatus(status: RagStatus) {
    this.ragStatusValue = status
    this.statusValue = { ...this.statusValue, rag: status, metrics: this.metrics() }
    this.onStatusChanged()
  }

  private ragApplyResult(action: RagConfigurationApplyResult["action"], status = this.ragStatusValue): RagConfigurationApplyResult {
    return {
      action,
      status,
      hasReusableIndex: this.currentRagIndexMatchesProvider(),
    }
  }

  private async ragEmbeddingConfigErrorStatus(settings: RagSettings): Promise<RagStatus> {
    const message = settings.embedding.configError ?? "RAG embedding configuration is invalid."
    this.configureRagProviders()
    const rerankProbe = await this.probeConfiguredRerankProvider()
    const endpointKind = settings.embedding.endpoint
      ? checkRagEndpoint(settings.embedding.endpoint, settings.allowedHosts).kind
      : "disabled"
    return {
      ...disabledRagStatus(message),
      availability: "unavailable",
      endpointKind,
      rerankEnabled: rerankProbe.enabled,
      rerankProvider: rerankProbe.provider,
      rerankLastError: rerankProbe.lastError,
      lastError: message,
      fallbackReason: message,
    }
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
      derived: this.index.derived,
      stats: this.shardedManifest.stats,
      storageMode: "sharded",
      schema: this.shardedManifest.schema ?? this.index.schema,
    }
    this.shardCache.clear()
  }

  private async cleanupOldShardGenerations(shardsDir: vscode.Uri, currentGeneration: string) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(shardsDir)
      await Promise.all(
        entries
          .filter(([name]) => name !== currentGeneration)
          .map(([name]) => vscode.workspace.fs.delete(vscode.Uri.joinPath(shardsDir, name), { recursive: true })),
      )
    } catch {
      // Cleanup is best-effort; the manifest already points at the current shard generation.
    }
  }

  private async saveDerivedSidecar(indexDir: vscode.Uri, sidecar: CodeGraphDerivedSidecarData, budget = new WorkBudget()) {
    await writePartsWithConcurrency(sidecar.parts, CODEGRAPH_STORAGE_WRITE_CONCURRENCY, async (part, index) => {
      this.setStatus({
        ...this.statusValue,
        detail: `Saving derived ${part.payload.field} part ${index + 1}/${sidecar.parts.length}.`,
        currentShard: part.payload.field,
      })
      await writeJsonRelative(indexDir, part.path, part.payload, `derived ${part.payload.field}`, part.key)
      await budget.yieldIfNeeded()
    }, (completed, total) => {
      this.output.appendLine(`[codegraph] saved derived sidecar part ${completed}/${total}`)
    })
  }

  private async loadDerivedSidecar(
    indexDir: vscode.Uri,
    manifest: CodeGraphShardManifest["derived"],
    budget = new WorkBudget(),
  ) {
    try {
      const parts: CodeGraphDerivedSidecarData["parts"] = []
      const total = CODEGRAPH_DERIVED_SIDECAR_FIELDS.reduce((count, field) => count + (manifest.fields[field]?.length ?? 0), 0)
      let completed = 0
      for (const field of CODEGRAPH_DERIVED_SIDECAR_FIELDS) {
        for (const shard of manifest.fields[field] ?? []) {
          const payload = await readJsonRelative<CodeGraphDerivedSidecarPartData>(indexDir, shard.path)
          parts.push({
            key: shard.key,
            path: shard.path,
            entries: shard.entries,
            estimatedBytes: shard.estimatedBytes,
            payload,
          })
          completed += 1
          if (budget.shouldYield()) {
            this.setStatus({
              ...this.statusValue,
              state: "recovering",
              enabled: true,
              detail: `Loaded ${completed}/${total} code graph derived sidecar part(s).`,
              progress: { completed, total },
              currentShard: field,
            })
            await budget.yieldNow()
          }
        }
      }
      return mergeCodeGraphDerivedSidecar({
        manifest,
        parts,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Stored code graph derived sidecar is incomplete: ${message}. Rebuild the local code graph index.`)
    }
  }

  private async cleanupOldDerivedSidecars(derivedDir: vscode.Uri, currentGeneration: string) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(derivedDir)
      await Promise.all(
        entries
          .filter(([name]) => name !== currentGeneration)
          .map(([name]) => vscode.workspace.fs.delete(vscode.Uri.joinPath(derivedDir, name), { recursive: true })),
      )
    } catch {
      // Cleanup is best-effort; the manifest already points at the current generation.
    }
  }

  private derivedGenerationName(updatedAt: number) {
    return `v${INDEX_VERSION}-${Math.max(0, Math.floor(updatedAt)).toString(36)}`
  }

  private shardGenerationName(updatedAt: number) {
    return `v${INDEX_VERSION}-${Math.max(0, Math.floor(updatedAt)).toString(36)}`
  }

  private shardDirectoryName(key: string) {
    return shardFileName(key).replace(/\.json$/i, "") || "root"
  }

  private indexDir(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "codegraph", workspaceRootKey(root))
  }

  private manifestUri(root: vscode.WorkspaceFolder) {
    return vscode.Uri.joinPath(this.indexDir(root), "manifest.json")
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
      await vscode.workspace.fs.writeFile(this.checkpointUri(root), encodeJson(checkpoint, "code graph job checkpoint"))
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
    derived: emptyDerivedIndex(),
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

function emptyDerivedIndex() {
  return {
    functionIdsByName: {},
    callerIdsByCallee: {},
    includeTargetsByFile: {},
    filePathsByInclude: {},
    directoryStats: {},
    symbolsByName: {},
    symbolsByPath: {},
    postingsByTerm: {},
    moduleStats: {},
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
  const gitScan = await gitTrackedSourceFiles(root, settings.codeGraph.maxFiles + 1, settings.codeGraph.indexTests)
  if (gitScan.trackedSourceFiles > 0) return gitScan
  const files = await vscode.workspace.findFiles(
    SOURCE_GLOB,
    excludeGlob([...settings.codeGraph.excludeGlobs, ...ignoreGlobs]),
    settings.codeGraph.maxFiles + 1,
  )
  const selected: vscode.Uri[] = []
  let skippedTestFiles = 0
  for (const uri of files) {
    const path = workspaceRelativePath(uri)
    if (isSensitivePath(path)) continue
    if (!shouldIndexPath(path, { indexTests: settings.codeGraph.indexTests })) {
      skippedTestFiles += 1
      continue
    }
    selected.push(uri)
  }
  return { files: selected, skippedTestFiles, trackedSourceFiles: selected.length + skippedTestFiles }
}

async function gitTrackedSourceFiles(root: vscode.WorkspaceFolder, limit: number, indexTests: boolean) {
  try {
    const { stdout } = await execFile("git", ["-C", root.uri.fsPath, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    const files: vscode.Uri[] = []
    let skippedTestFiles = 0
    let trackedSourceFiles = 0
    for (const path of stdout.split("\0")) {
      if (!path || !isSourcePath(path) || isSensitivePath(path)) continue
      trackedSourceFiles += 1
      if (!shouldIndexPath(path, { indexTests })) {
        skippedTestFiles += 1
        continue
      }
      if (files.length < limit) files.push(vscode.Uri.joinPath(root.uri, ...path.replace(/\\/g, "/").split("/")))
    }
    return { files, skippedTestFiles, trackedSourceFiles }
  } catch {
    return { files: [], skippedTestFiles: 0, trackedSourceFiles: 0 }
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

function disabledRagStatus(fallbackReason = "embedding endpoint not configured; BM25/graph/state-machine fallback active"): RagStatus {
  return {
    enabled: false,
    availability: "not-configured",
    indexAvailability: "none",
    embeddingEnabled: false,
    rerankEnabled: false,
    endpointKind: "disabled",
    chunks: 0,
    embeddedChunks: 0,
    vectorShards: 0,
    fallbackReason,
  }
}

function initialRagWorkerStatus(configuredWorkers: number): RagWorkerStatus {
  const configured = Math.floor(configuredWorkers)
  const activeWorkers = Number.isFinite(configured) ? Math.max(1, Math.min(4, configured)) : 3
  return {
    configuredWorkers: activeWorkers,
    activeWorkers,
    maxWorkers: Math.min(4, activeWorkers + 1),
    inFlightRequests: 0,
    queuePending: 0,
  }
}

function formatRagStatus(status?: RagStatus) {
  if (!status) return " RAG: not configured; BM25/graph/state-machine fallback active."
  const rerankReason = status.rerankLastError
  const rerank = status.rerankEnabled
    ? " Rerank: ready."
    : status.rerankProvider || rerankReason
      ? ` Rerank: unavailable${rerankReason ? `, ${rerankReason}` : ""}.`
      : ""
	  if (status.embeddingEnabled) {
	    if (status.availability === "indexing") {
	      return ` RAG: ${ragIndexingStatusMessage(status)}, ${status.endpointKind}.${rerank}`
	    }
	    if (status.availability === "partial") {
	      return ` RAG: partial, ${status.embeddedChunks}/${status.chunks} chunk(s), ${status.pendingChunkCount ?? Math.max(0, status.chunks - status.embeddedChunks)} pending${ragElapsedStatusMessage(status)}${ragWorkerStatusMessage(status)}${ragResumeScheduleMessage(status)}, ${status.vectorShards} shard(s), ${status.endpointKind}.${rerank}`
	    }
	    if (status.availability === "paused") {
	      return ` RAG: indexing paused, ${status.embeddedChunks}/${status.chunks} chunk(s), ${status.fallbackReason ?? ragPausedReasonMessage(status.indexPausedReason, status.lastError)}${ragElapsedStatusMessage(status)}${ragWorkerStatusMessage(status)}${ragResumeScheduleMessage(status)}, ${status.vectorShards} shard(s), ${status.endpointKind}.${rerank}`
	    }
	    return ` RAG: ready, ${status.embeddedChunks}/${status.chunks} chunk(s)${ragElapsedStatusMessage(status, "total")}${ragWorkerStatusMessage(status)}, ${status.vectorShards} shard(s), ${status.endpointKind}.${rerank}`
	  }
  if (status.availability === "checking") {
    return ` RAG: checking ${status.endpointKind} embedding endpoint; BM25/graph/state-machine fallback active.${rerank}`
  }
  if (status.availability === "indexing") {
    return ` RAG: ${ragIndexingStatusMessage(status)}; BM25/graph/state-machine fallback active.${rerank}`
  }
	  if (status.availability === "paused") {
	    return ` RAG: indexing paused, ${status.fallbackReason ?? ragPausedReasonMessage(status.indexPausedReason, status.lastError)}${ragElapsedStatusMessage(status)}${ragWorkerStatusMessage(status)}${ragResumeScheduleMessage(status)}; BM25/graph/state-machine fallback active.${rerank}`
	  }
	  if (status.availability === "partial") {
	    return ` RAG: partial, ${status.embeddedChunks}/${status.chunks} chunk(s), ${status.pendingChunkCount ?? Math.max(0, status.chunks - status.embeddedChunks)} pending${ragElapsedStatusMessage(status)}${ragWorkerStatusMessage(status)}${ragResumeScheduleMessage(status)}.${rerank}`
	  }
  if (status.availability === "not-indexed") {
    return ` RAG: not indexed${status.fallbackReason ? `, ${status.fallbackReason}` : ""}; BM25/graph/state-machine fallback active.${rerank}`
  }
  if (status.availability === "unavailable") {
    return ` RAG: unavailable${status.fallbackReason ? `, ${status.fallbackReason}` : ""}; BM25/graph/state-machine fallback active.${rerank}`
  }
  return ` RAG: not configured; BM25/graph/state-machine fallback active.${rerank}`
}

function ragIndexingStatusMessage(status: RagStatus) {
  const progress = status.indexProgress
  const chunks = `${status.embeddedChunks}/${status.chunks} chunk(s)`
  const pending = `${status.pendingChunkCount ?? Math.max(0, status.chunks - status.embeddedChunks)} pending`
  const telemetry = `${ragElapsedStatusMessage(status)}${ragWorkerStatusMessage(status)}`
  if (!progress) return `indexing, ${chunks}, ${pending}${telemetry}`
  if (progress.phase === "batch") {
    const requestLimit = progress.requestLimit && progress.requestLimit > 0 ? String(progress.requestLimit) : "unlimited"
    return `indexing, ${chunks}, batch ${progress.batchIndex}/${progress.batchCount}, request ${progress.requestNumber}/${requestLimit}, ${pending}${telemetry}`
  }
  if (progress.phase === "delay") return `indexing, ${chunks}, waiting ${progress.delayMs}ms, ${pending}${telemetry}`
  if (progress.phase === "rate-limit") return `indexing, ${chunks}, rate limited retry ${progress.retry}/${progress.maxRetries}, ${pending}${telemetry}`
  return `indexing paused, ${chunks}, ${pending}${telemetry}`
}

function ragElapsedStatusMessage(status: RagStatus, label = "elapsed") {
  const elapsedMs = status.indexElapsedMs ?? status.indexProgress?.elapsedMs
  if (elapsedMs === undefined) return ""
  return `, ${label} ${formatDuration(elapsedMs)}`
}

function ragWorkerStatusMessage(status: RagStatus) {
  const worker = status.workerStatus ?? status.indexProgress?.workerStatus
  if (!worker) return ""
  const change = worker.lastChange
    ? `; ${worker.lastChange.direction === "upgrade" ? "upgraded" : "degraded"} ${worker.lastChange.fromWorkers}->${worker.lastChange.toWorkers}: ${worker.lastChange.reason}`
    : ""
  return `, workers ${worker.activeWorkers}/${worker.maxWorkers}, ${worker.inFlightRequests} in flight, ${worker.queuePending} queued${change}`
}

function formatRagHttpDiagnosticEvent(event: RagHttpDiagnosticEvent) {
  const key = event.authorizationPresent
    ? `present ${event.apiKeyFingerprint ?? "fingerprint-unavailable"}`
    : "empty"
  const headers = event.authorizationPresent
    ? "content-type:application/json, authorization:Bearer <redacted>"
    : "content-type:application/json"
  const common = [
    `[rag-http] ${event.phase}`,
    event.kind,
    `${event.method} ${event.endpoint}`,
    event.model ? `model=${event.model}` : undefined,
    event.encodingFormat ? `encodingFormat=${event.encodingFormat}` : undefined,
    event.effectiveEncodingFormat ? `effectiveEncodingFormat=${event.effectiveEncodingFormat}` : undefined,
    event.base64Capability ? `base64Capability=${event.base64Capability}` : undefined,
    event.inputCount !== undefined ? `inputCount=${event.inputCount}` : undefined,
    event.batchSize !== undefined ? `batchSize=${event.batchSize}` : undefined,
    event.estimatedTokens !== undefined ? `estimatedTokens=${event.estimatedTokens}` : undefined,
    event.documentCount !== undefined ? `documentCount=${event.documentCount}` : undefined,
    event.topN !== undefined ? `topN=${event.topN}` : undefined,
    `timeoutMs=${event.timeoutMs}`,
    `headers=${headers}`,
    `key=${key}`,
  ].filter(Boolean)
  if (event.phase === "response") {
    common.push(`status=${event.status ?? "unknown"} ${event.statusText ?? ""}`.trim())
    common.push(`ok=${event.ok ? "true" : "false"}`)
    if (event.elapsedMs !== undefined) common.push(`requestSec=${formatSeconds(event.elapsedMs)}`)
    if (event.responseBytes !== undefined) common.push(`responseBytes=${event.responseBytes}`)
    if (event.parseElapsedMs !== undefined) common.push(`parseSec=${formatSeconds(event.parseElapsedMs)}`)
    if (event.errorPreview) common.push(`errorPreview=${compactLogValue(event.errorPreview)}`)
  } else if (event.phase === "normalize") {
    if (event.responseBytes !== undefined) common.push(`responseBytes=${event.responseBytes}`)
    if (event.normalizeElapsedMs !== undefined) common.push(`normalizeSec=${formatSeconds(event.normalizeElapsedMs)}`)
  } else if (event.phase === "encoding") {
    if (event.message) common.push(`message=${compactLogValue(event.message)}`)
  } else if (event.phase === "error") {
    if (event.elapsedMs !== undefined) common.push(`requestSec=${formatSeconds(event.elapsedMs)}`)
    if (event.message) common.push(`message=${compactLogValue(event.message)}`)
    if (event.errorName) common.push(`errorName=${compactLogValue(event.errorName)}`)
    if (event.errorMessage) common.push(`errorMessage=${compactLogValue(event.errorMessage)}`)
    if (event.errorCode) common.push(`errorCode=${compactLogValue(event.errorCode)}`)
    if (event.causeName) common.push(`causeName=${compactLogValue(event.causeName)}`)
    if (event.causeCode) common.push(`causeCode=${compactLogValue(event.causeCode)}`)
    if (event.causeErrno) common.push(`causeErrno=${compactLogValue(event.causeErrno)}`)
    if (event.causeSyscall) common.push(`causeSyscall=${compactLogValue(event.causeSyscall)}`)
    if (event.causeHostname) common.push(`causeHostname=${compactLogValue(event.causeHostname)}`)
    if (event.causeHost) common.push(`causeHost=${compactLogValue(event.causeHost)}`)
    if (event.causePort) common.push(`causePort=${compactLogValue(event.causePort)}`)
    if (event.causeAddress) common.push(`causeAddress=${compactLogValue(event.causeAddress)}`)
    if (event.causeMessage) common.push(`causeMessage=${compactLogValue(event.causeMessage)}`)
    if (event.causeStackFirstLine) common.push(`causeStack=${compactLogValue(event.causeStackFirstLine)}`)
    if (event.causeDetails?.length) common.push(`causeDetails=${compactLogValue(event.causeDetails.join(" | "))}`)
  }
  return common.join(" ")
}

function formatRagIndexBuildProgress(event: RagIndexBuildProgress) {
  const chunks = ` chunks=${event.embeddedChunks}/${event.chunks} pending=${event.pendingChunkCount}`
  const telemetry = ` elapsedMs=${event.elapsedMs} ${formatRagWorkerTelemetry(event.workerStatus)}`
  if (event.phase === "batch") {
    const requestLimit = event.requestLimit > 0 ? String(event.requestLimit) : "unlimited"
    const estimatedTokens = event.estimatedTokens !== undefined ? ` estimatedTokens=${event.estimatedTokens}` : ""
    const concurrency = [
      event.activeConcurrency !== undefined ? `activeConcurrency=${event.activeConcurrency}` : undefined,
      event.adaptiveCeiling !== undefined ? `adaptiveCeiling=${event.adaptiveCeiling}` : undefined,
      event.inFlightRequests !== undefined ? `inFlightRequests=${event.inFlightRequests}` : undefined,
      event.inFlightEstimatedTokens !== undefined ? `inFlightEstimatedTokens=${event.inFlightEstimatedTokens}` : undefined,
      event.queuePending !== undefined ? `queuePending=${event.queuePending}` : undefined,
    ].filter(Boolean).join(" ")
    return `[rag-index] embedding batch ${event.batchIndex}/${event.batchCount} request ${event.requestNumber}/${requestLimit} inputCount=${event.inputCount}${estimatedTokens}${concurrency ? ` ${concurrency}` : ""}${chunks}${telemetry}`
  }
  if (event.phase === "delay") return `[rag-index] delay ${event.delayMs}ms before next embedding request${chunks}${telemetry}`
  if (event.phase === "rate-limit") {
    const retryAfter = event.retryAfterMs !== undefined ? ` retryAfterMs=${event.retryAfterMs}` : ""
    return `[rag-index] rate limited status=${event.status}${retryAfter} retry=${event.retry}/${event.maxRetries} delayMs=${event.delayMs}${chunks}${telemetry}`
  }
  const requestLimit = event.requestLimit > 0 ? String(event.requestLimit) : "unlimited"
  return `[rag-index] paused: ${ragPausedReasonMessage(event.reason, event.message)} used=${event.requestsUsed} limit=${requestLimit}${chunks}${telemetry}`
}

function formatRagEmbeddingSchedulerBlocked(event: RagEmbeddingSchedulerBlockedEvent) {
  const requestLimit = event.requestLimit > 0 ? String(event.requestLimit) : "unlimited"
  return `[rag-index] embedding scheduler blocked reason=${event.reason} activeConcurrency=${event.activeConcurrency} adaptiveCeiling=${event.adaptiveCeiling} active.size=${event.activeSize} inFlightEstimatedTokens=${event.inFlightEstimatedTokens} nextEstimatedTokens=${event.nextEstimatedTokens} maxInFlightTokens=${event.maxInFlightTokens} queuePending=${event.queuePending} requestsUsed=${event.requestsUsed} requestLimit=${requestLimit}`
}

function formatRagIndexBatchProfile(event: RagIndexBatchProfile) {
  const checkpoint = event.checkpointElapsedMs !== undefined ? ` checkpointSec=${formatSeconds(event.checkpointElapsedMs)}` : " checkpoint=skipped"
  const responseBytes = event.responseBytes !== undefined ? ` responseBytes=${event.responseBytes}` : ""
  const encoding = event.effectiveEncodingFormat ? ` effectiveEncodingFormat=${event.effectiveEncodingFormat}` : ""
  return `[rag-index-profile] batch ${event.batchIndex}/${event.batchCount} request=${event.requestNumber} inputCount=${event.inputCount} estimatedTokens=${event.estimatedTokens} embeddingRequestSec=${formatSeconds(event.embeddingElapsedMs)} vectorNormalizeSec=${formatSeconds(event.vectorNormalizeElapsedMs)}${checkpoint} batchStatus=${event.batchStatus} activeConcurrency=${event.activeConcurrency} configuredConcurrency=${event.configuredConcurrency} adaptiveCeiling=${event.adaptiveCeiling} inFlightRequests=${event.inFlightRequests} inFlightEstimatedTokens=${event.inFlightEstimatedTokens} queuePending=${event.queuePending} retries=${event.retries} rateLimits=${event.rateLimits} timeouts=${event.timeouts}${responseBytes}${encoding} chunks=${event.embeddedChunks}/${event.chunks} pending=${event.pendingChunkCount} elapsedMs=${event.elapsedMs} ${formatRagWorkerTelemetry(event.workerStatus)}`
}

function formatRagIndexBuildSummary(event: RagIndexBuildSummary) {
  return `[rag-index-summary] wallSec=${formatSeconds(event.wallElapsedMs)} buildElapsedMs=${event.buildElapsedMs} requestSecTotal=${formatSeconds(event.requestElapsedMsTotal)} requestSecP50=${formatSeconds(event.requestElapsedMsP50)} requestSecP95=${formatSeconds(event.requestElapsedMsP95)} responseBytesTotal=${event.responseBytesTotal} retries=${event.retries} rateLimits=${event.rateLimits} timeouts=${event.timeouts} effectiveConcurrency=${event.effectiveConcurrency.toFixed(2)} chunksPerMin=${event.chunksPerMinute.toFixed(1)} tokensPerMin=${event.tokensPerMinute.toFixed(1)} configuredConcurrency=${event.configuredConcurrency} adaptiveCeiling=${event.adaptiveCeiling} ${formatRagWorkerTelemetry(event.workerStatus)}`
}

function ragEmbeddingCheckpointPlan(settings: RagSettings["embedding"]) {
  if (settings.checkpointMode === "off") {
    return { mode: settings.checkpointMode, chunkInterval: 0, intervalMs: 0 }
  }
  if (settings.checkpointMode === "safe") {
    return {
      mode: settings.checkpointMode,
      chunkInterval: RAG_INDEX_SAFE_CHECKPOINT_CHUNK_INTERVAL,
      intervalMs: RAG_INDEX_SAFE_CHECKPOINT_INTERVAL_MS,
    }
  }
  return {
    mode: "interval" as const,
    chunkInterval: Math.max(0, Math.floor(settings.checkpointChunkInterval)),
    intervalMs: Math.max(0, Math.floor(settings.checkpointIntervalMs)),
  }
}

function formatSeconds(ms: number) {
  return (Math.max(0, ms) / 1000).toFixed(2)
}

function formatDuration(ms: number) {
  const safeMs = Math.max(0, Math.floor(ms))
  if (safeMs < 1000) return `${safeMs}ms`
  const totalSeconds = Math.floor(safeMs / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${(safeMs / 1000).toFixed(safeMs < 10000 ? 1 : 0)}s`
}

function formatRagWorkerTelemetry(worker: RagWorkerStatus) {
  const change = worker.lastChange
    ? ` workerChange=${worker.lastChange.direction}:${worker.lastChange.fromWorkers}->${worker.lastChange.toWorkers}:${worker.lastChange.reason}`
    : ""
  return `workers=${worker.activeWorkers}/${worker.maxWorkers} configuredWorkers=${worker.configuredWorkers} inFlightRequests=${worker.inFlightRequests} queuePending=${worker.queuePending}${change}`
}

function ragPausedReasonMessage(reason?: RagStatus["indexPausedReason"], detail?: string) {
  const suffix = detail ? `: ${detail}` : ""
  if (reason === "request-budget") return `request budget reached${suffix}`
  if (reason === "rate-limit") return `rate limited${suffix}`
  if (reason === "provider-error") return `provider error${suffix}`
  if (reason === "manual") return `paused by user${suffix}`
  return `indexing paused${suffix}`
}

function ragResumeScheduleMessage(status: RagStatus) {
  if (!status.resumeScheduledAt || !status.resumeReason) return ""
  const remainingMs = Math.max(0, status.resumeScheduledAt - Date.now())
  const seconds = Math.ceil(remainingMs / 1000)
  const label = status.resumeReason === "rate-limit" ? "retry scheduled" : "resume scheduled"
  return `; ${label} in ${seconds}s`
}

function compactLogValue(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 300)
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

async function writePartsWithConcurrency<TPart>(
  parts: TPart[],
  concurrency: number,
  writePart: (part: TPart, index: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void,
) {
  let next = 0
  let completed = 0
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), parts.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < parts.length) {
      const index = next
      next += 1
      await writePart(parts[index], index)
      completed += 1
      onProgress(completed, parts.length)
    }
  })
  await Promise.all(workers)
}

function encodeJson(value: unknown, label = "code graph JSON", part?: string) {
  return encodeBoundedJson(value, { label, part, hardPartBytes: CODEGRAPH_JSON_HARD_PART_BYTES })
}

async function writeJsonRelative(root: vscode.Uri, relativePath: string, value: unknown, label = "code graph JSON", part?: string) {
  const uri = relativeUri(root, relativePath)
  await vscode.workspace.fs.createDirectory(parentUri(uri))
  await vscode.workspace.fs.writeFile(uri, encodeJson(value, label, part))
}

async function readJsonRelative<T>(root: vscode.Uri, relativePath: string): Promise<T> {
  const bytes = await vscode.workspace.fs.readFile(relativeUri(root, relativePath))
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

function relativeUri(root: vscode.Uri, relativePath: string) {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length === 0 || parts.includes("..")) throw new Error(`Invalid relative storage path: ${relativePath}`)
  return vscode.Uri.joinPath(root, ...parts)
}

function parentUri(uri: vscode.Uri) {
  const path = uri.path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/"
  return uri.with({ path })
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
