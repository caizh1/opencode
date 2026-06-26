import * as crypto from "node:crypto"
import * as vscode from "vscode"
import { parseSupportedDocument } from "./document-parser"
import {
  createDocumentRagChunks,
  decodeDocumentRagVectors,
  DOCUMENT_RAG_GLOB,
  documentRagExcludeGlob,
  documentRagKindFromPath,
  encodeDocumentRagVectors,
  hashDocumentBytes,
  isDocumentRagExcludedPath,
  isSupportedDocumentRagPath,
  normalizeDocumentRagVector,
  searchDocumentRagVectors,
  type DocumentRagChunk,
  type DocumentRagDocument,
  type DocumentRagSearchHit,
} from "./document-rag-index"
import { createHttpEmbeddingProvider, createHttpRerankProvider, type RagHttpDiagnosticEvent } from "./rag-provider"
import { estimateEmbeddingTokens } from "./rag-token"
import type { EmbeddingProvider, RerankProvider } from "./rag-types"
import type { CodeGraphStatus, DocumentRagStatus, RemoteSettings } from "./types"

export type DocumentRagQueryResult = {
  text: string
  hits: Array<{ path: string; startLine: number; endLine: number; score: number }>
  elapsedMs: number
}

export type DocumentRagContextProvider = {
  status(): DocumentRagStatus
  query(question: string, options?: {
    topK?: number
    maxEvidenceBytes?: number
    latencyBudgetMs?: number
  }): Promise<DocumentRagQueryResult | undefined>
}

type DocumentRagIndex = {
  version: 2
  rootKey: string
  rootPaths: string[]
  updatedAt: number
  lastScanAt?: number
  provider?: string
  model?: string
  dimension: number
  documents: Record<string, DocumentRagDocument>
  chunks: DocumentRagChunk[]
  vectors: number[][]
  lastError?: string
}

type SerializedDocumentRagIndex = Omit<DocumentRagIndex, "vectors"> & {
  vectorsPath: string
}

type PendingChange = {
  uri: vscode.Uri
  deleted: boolean
}

const DOCUMENT_RAG_VERSION = 2
const DOCUMENT_RAG_RECONCILE_INTERVAL_MS = 10 * 60 * 1000
const DOCUMENT_RAG_EVENT_DEBOUNCE_MS = 900
const DOCUMENT_RAG_BACKOFF_MS = 2500
const DOCUMENT_RAG_UNRESOLVED_CHANGE_RECONCILE_DELAY_MS = 500
const DOCUMENT_RAG_WATCHER_RESCAN_THRESHOLD = 500
const DOCUMENT_RAG_QUERY_BUDGET_MS = 1000
const DOCUMENT_RAG_EMBEDDING_BATCH_LIMIT = 32

export class DocumentRagService implements vscode.Disposable, DocumentRagContextProvider {
  private watcher?: vscode.FileSystemWatcher
  private workspaceFoldersDisposable?: vscode.Disposable
  private reconcileTimer?: ReturnType<typeof setTimeout>
  private changeTimer?: ReturnType<typeof setTimeout>
  private processTimer?: ReturnType<typeof setTimeout>
  private intervalTimer?: ReturnType<typeof setInterval>
  private pendingChanges = new Map<string, PendingChange>()
  private pendingDocuments = new Map<string, DocumentRagDocument>()
  private index?: DocumentRagIndex
  private running = false
  private paused = false
  private disposed = false
  private rescanScheduled = false
  private largeWorkspacePaused = false
  private statusValue: DocumentRagStatus = {
    enabled: true,
    availability: "no-documents",
    documentCount: 0,
    indexedDocuments: 0,
    skippedDocuments: 0,
    pendingDocuments: 0,
    chunks: 0,
    embeddedChunks: 0,
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly getSettings: () => RemoteSettings,
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly onStatusChange: () => void,
    private readonly shouldBackoff: () => boolean = () => false,
  ) {}

  start() {
    this.restartWatcher()
    this.workspaceFoldersDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.output.appendLine("[document-rag] workspace folders changed; scheduling reconcile")
      this.restartWatcher()
      this.index = undefined
      this.pendingChanges.clear()
      this.pendingDocuments.clear()
      this.scheduleReconcile("workspace folders changed", 100, true)
    })
    this.intervalTimer = setInterval(() => this.scheduleReconcile("periodic reconcile", 0), DOCUMENT_RAG_RECONCILE_INTERVAL_MS)
    this.scheduleReconcile("startup", 100)
  }

  dispose() {
    this.disposed = true
    this.watcher?.dispose()
    this.workspaceFoldersDisposable?.dispose()
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    if (this.processTimer) clearTimeout(this.processTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
  }

  status() {
    return { ...this.statusValue }
  }

  rebuild() {
    this.paused = false
    this.largeWorkspacePaused = false
    this.pendingChanges.clear()
    this.pendingDocuments.clear()
    this.index = this.emptyIndex()
    this.scheduleReconcile("manual rebuild", 0, true)
  }

  pauseIndexing(reason = "paused by user") {
    this.paused = true
    this.setStatus("paused", { fallbackReason: reason })
  }

  resumeIndexing() {
    this.paused = false
    this.largeWorkspacePaused = false
    this.scheduleReconcile("resume", 0)
  }

  async showStatus() {
    const status = this.statusValue
    const rows = [
      `Document RAG: ${status.availability}`,
      `Documents: ${status.indexedDocuments}/${status.documentCount}`,
      `Chunks: ${status.embeddedChunks}/${status.chunks}`,
      status.pendingDocuments ? `Pending documents: ${status.pendingDocuments}` : "",
      status.skippedDocuments ? `Skipped documents: ${status.skippedDocuments}` : "",
      status.lastError ? `Last error: ${status.lastError}` : "",
      status.fallbackReason ? `Detail: ${status.fallbackReason}` : "",
    ].filter(Boolean)
    await vscode.window.showInformationMessage(rows.join("\n"), { modal: false })
  }

  async query(question: string, options: {
    topK?: number
    maxEvidenceBytes?: number
    latencyBudgetMs?: number
  } = {}): Promise<DocumentRagQueryResult | undefined> {
    const started = Date.now()
    const status = this.statusValue.availability
    if (status !== "ready" && status !== "partial") return undefined
    const index = this.index
    if (!index || index.chunks.length === 0 || index.vectors.length === 0) return undefined
    const settings = this.getSettings()
    if (!settings.documentRag.enabled || !settings.rag.embedding.enabled) return undefined
    const provider = await this.embeddingProvider(settings)
    if (!provider) return undefined
    try {
      const budgetMs = Math.max(100, options.latencyBudgetMs ?? DOCUMENT_RAG_QUERY_BUDGET_MS)
      const signal = abortSignalAfter(budgetMs)
      const vectors = await provider.embed([question], signal)
      const queryVector = vectors[0]
      if (!queryVector) return undefined
      let hits = searchDocumentRagVectors({
        chunks: index.chunks,
        vectors: index.vectors,
        queryVector,
        topK: options.topK ?? settings.documentRag.queryTopK,
      })
      const remainingMs = budgetMs - (Date.now() - started)
      if (remainingMs > 150) {
        const rerank = await this.rerankProvider(settings).catch(() => undefined)
        if (rerank) {
          hits = await rerankDocumentHits(question, hits, rerank, settings.rag.rerankTopK, abortSignalAfter(remainingMs))
        }
      }
      const evidence = formatDocumentRagEvidence(hits, {
        maxBytes: options.maxEvidenceBytes ?? settings.documentRag.maxEvidenceBytes,
        status: this.statusValue,
      })
      const elapsedMs = Date.now() - started
      this.logQueryEvidence(hits, evidence, elapsedMs)
      if (!evidence.text) return undefined
      return {
        text: evidence.text,
        hits: hits.map((hit) => ({
          path: hit.chunk.path,
          startLine: hit.chunk.startLine,
          endLine: hit.chunk.endLine,
          score: hit.score,
        })),
        elapsedMs,
      }
    } catch (error) {
      this.output.appendLine(`[document-rag] query skipped: ${formatError(error)}`)
      return undefined
    }
  }

  private logQueryEvidence(hits: DocumentRagSearchHit[], evidence: FormattedDocumentRagEvidence, elapsedMs: number) {
    const status = this.statusValue
    this.output.appendLine(
      `[document-rag] query evidence injected=${evidence.injected.length} retrieved=${hits.length} omittedByBudget=${evidence.omittedByBudget} documents=${status.indexedDocuments}/${status.documentCount} chunks=${status.embeddedChunks}/${status.chunks} elapsedMs=${elapsedMs}`,
    )
    evidence.injected.forEach((item, index) => {
      const chunk = item.hit.chunk
      this.output.appendLine(
        `[document-rag] query evidence #${index + 1} path=${logString(chunk.path)} lines=${chunk.startLine}-${chunk.endLine} section=${logString(chunk.section)} kind=${chunk.kind} chunkKind=${logString(chunk.chunkKind ?? "")} label=${logString(chunk.label ?? "")} score=${item.hit.score.toFixed(3)} bytes=${item.bytes} preview=${logString(item.preview)}`,
      )
    })
  }

  refreshConfiguration() {
    if (!this.getSettings().documentRag.enabled) {
      this.pendingChanges.clear()
      this.pendingDocuments.clear()
      this.setStatus("disabled")
      return
    }
    this.scheduleReconcile("configuration changed", 0)
  }

  private restartWatcher() {
    this.watcher?.dispose()
    this.watcher = undefined
    if (!vscode.workspace.workspaceFolders?.length) {
      this.setStatus("no-documents", { fallbackReason: "No workspace folder is open." })
      return
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(DOCUMENT_RAG_GLOB)
    this.watcher.onDidCreate((uri) => this.handleFileEvent(uri, false))
    this.watcher.onDidChange((uri) => this.handleFileEvent(uri, false))
    this.watcher.onDidDelete((uri) => this.handleFileEvent(uri, true))
  }

  private handleFileEvent(uri: vscode.Uri, deleted: boolean) {
    if (this.disposed || !this.getSettings().documentRag.enabled) return
    const path = workspaceRelativePath(uri)
    if (!isSupportedDocumentRagPath(path)) return
    if (isDocumentRagExcludedPath(path, this.getSettings().documentRag.excludeGlobs)) return
    this.pendingChanges.set(path, { uri, deleted })
    if (this.pendingChanges.size >= DOCUMENT_RAG_WATCHER_RESCAN_THRESHOLD) {
      this.rescanScheduled = true
      this.output.appendLine(`[document-rag] watcher storm detected events=${this.pendingChanges.size}; scheduling reconcile`)
    }
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      void this.applyPendingChanges()
    }, DOCUMENT_RAG_EVENT_DEBOUNCE_MS)
  }

  private async applyPendingChanges() {
    if (this.disposed || this.pendingChanges.size === 0) return
    if (this.paused) {
      this.setStatus("paused", { fallbackReason: "Document changes are queued while indexing is paused." })
      return
    }
    const changes = [...this.pendingChanges.values()]
    this.pendingChanges.clear()
    if (this.rescanScheduled) {
      this.rescanScheduled = false
      this.scheduleReconcile("watcher storm", 0)
      return
    }
    await this.ensureIndex()
    let unresolvedWatcherEvent = false
    for (const change of changes) {
      const path = workspaceRelativePath(change.uri)
      if (change.deleted) {
        this.removeDocument(change.uri.toString())
        this.output.appendLine(`[document-rag] removed ${path}`)
        continue
      }
      const document = await this.documentFromUri(change.uri)
      if (!document) {
        unresolvedWatcherEvent = true
        continue
      }
      this.index!.documents[document.uri] = document
      if (document.skipped) {
        this.removeDocumentChunks(document.uri)
      } else {
        this.pendingDocuments.set(document.uri, document)
      }
    }
    await this.saveIndex()
    this.refreshStatusAfterPendingChanges()
    if (unresolvedWatcherEvent) {
      this.output.appendLine("[document-rag] unresolved watcher event(s); scheduling incremental reconcile")
      this.scheduleReconcile("unresolved watcher event", DOCUMENT_RAG_UNRESOLVED_CHANGE_RECONCILE_DELAY_MS)
    }
    if (this.pendingDocuments.size > 0) this.scheduleProcessQueue()
  }

  private scheduleReconcile(reason: string, delayMs: number, clearIndex = false) {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined
      void this.reconcile(reason, clearIndex)
    }, delayMs)
  }

  private async reconcile(reason: string, clearIndex = false) {
    if (this.disposed) return
    const settings = this.getSettings()
    if (!settings.documentRag.enabled) {
      this.setStatus("disabled")
      return
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.index = this.emptyIndex()
      this.setStatus("no-documents", { fallbackReason: "No workspace folder is open." })
      return
    }
    if (this.paused) {
      this.setStatus("paused", { fallbackReason: "Document RAG indexing is paused." })
      return
    }
    this.setStatus("scanning", { progress: this.progress("scanning") })
    try {
      if (clearIndex) this.index = this.emptyIndex()
      await this.ensureIndex()
      const files = await vscode.workspace.findFiles(
        DOCUMENT_RAG_GLOB,
        documentRagExcludeGlob(settings.documentRag.excludeGlobs),
        settings.documentRag.maxFiles + 1,
      )
      if (files.length > settings.documentRag.maxFiles) {
        this.largeWorkspacePaused = true
        this.pendingDocuments.clear()
        this.setStatus("large-workspace-paused", {
          fallbackReason: `Document RAG found more than ${settings.documentRag.maxFiles} document(s). Increase chipmate.documentRag.maxFiles or exclude paths before indexing.`,
          lastScanAt: Date.now(),
          documentCount: files.length,
        })
        this.output.appendLine(`[document-rag] large workspace paused found>${settings.documentRag.maxFiles} reason=${reason}`)
        return
      }
      this.largeWorkspacePaused = false
      const discovered = new Set<string>()
      for (const uri of files) {
        const document = await this.documentFromUri(uri)
        if (!document) continue
        discovered.add(document.uri)
        const previous = this.index!.documents[document.uri]
        this.index!.documents[document.uri] = previous?.hash && previous.size === document.size && previous.mtime === document.mtime
          ? { ...previous, skipped: previous.skipped, error: previous.error }
          : document
        if (document.skipped) {
          this.removeDocumentChunks(document.uri)
          continue
        }
        if (!previous || previous.size !== document.size || previous.mtime !== document.mtime || previous.skipped) {
          this.pendingDocuments.set(document.uri, document)
        }
      }
      for (const uri of Object.keys(this.index!.documents)) {
        if (!discovered.has(uri)) this.removeDocument(uri)
      }
      this.index!.lastScanAt = Date.now()
      await this.saveIndex()
      this.output.appendLine(`[document-rag] reconcile ${reason}: documents=${discovered.size} pending=${this.pendingDocuments.size}`)
      if (discovered.size === 0) {
        this.setStatus("no-documents", { lastScanAt: this.index!.lastScanAt })
        return
      }
      if (!settings.rag.embedding.enabled) {
        this.setStatus("not-configured", {
          fallbackReason: "Configure chipmate.rag.embedding.endpoint to build Document RAG.",
          lastScanAt: this.index!.lastScanAt,
        })
        return
      }
      this.scheduleProcessQueue()
    } catch (error) {
      this.setStatus("error", { lastError: formatError(error) })
      this.output.appendLine(`[document-rag] reconcile failed: ${formatError(error)}`)
    }
  }

  private scheduleProcessQueue(delayMs = 0) {
    if (this.processTimer) clearTimeout(this.processTimer)
    this.processTimer = setTimeout(() => {
      this.processTimer = undefined
      void this.processQueue()
    }, delayMs)
  }

  private async processQueue() {
    if (this.disposed || this.running || this.pendingDocuments.size === 0) {
      this.refreshReadyStatus()
      return
    }
    const settings = this.getSettings()
    if (!settings.documentRag.enabled) {
      this.setStatus("disabled")
      return
    }
    if (this.paused || this.largeWorkspacePaused) {
      this.setStatus(this.largeWorkspacePaused ? "large-workspace-paused" : "paused")
      return
    }
    if (!settings.rag.embedding.enabled) {
      this.setStatus("not-configured", { fallbackReason: "Configure chipmate.rag.embedding.endpoint to build Document RAG." })
      return
    }
    if (this.shouldBackoff()) {
      this.setStatus("indexing", {
        fallbackReason: "Waiting for local code graph or code RAG indexing to finish.",
        progress: this.progress("backoff"),
      })
      this.scheduleProcessQueue(DOCUMENT_RAG_BACKOFF_MS)
      return
    }
    this.running = true
    try {
      await this.ensureIndex()
      const provider = await this.embeddingProvider(settings)
      if (!provider) {
        this.setStatus("not-configured", { fallbackReason: "Document RAG embedding provider is not configured." })
        return
      }
      while (!this.disposed && this.pendingDocuments.size > 0) {
        if (this.paused || this.largeWorkspacePaused) break
        if (this.shouldBackoff()) {
          this.scheduleProcessQueue(DOCUMENT_RAG_BACKOFF_MS)
          break
        }
        const document = this.shiftPendingDocument()
        if (!document) break
        this.setStatus("indexing", { progress: this.progress("indexing") })
        await this.indexDocument(document, provider, settings)
      }
      this.refreshReadyStatus()
    } catch (error) {
      this.setStatus("error", { lastError: formatError(error) })
      this.output.appendLine(`[document-rag] indexing failed: ${formatError(error)}`)
    } finally {
      this.running = false
    }
  }

  private async indexDocument(document: DocumentRagDocument, provider: EmbeddingProvider, settings: RemoteSettings) {
    let bytes: Uint8Array
    let hash: string
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(document.uri))
      hash = hashDocumentBytes(bytes)
      const existing = this.index!.documents[document.uri]
      if (existing?.hash === hash && existing.chunkCount && this.index!.chunks.some((chunk) => chunk.documentUri === document.uri)) {
        return
      }
    } catch (error) {
      await this.markSkipped(document, formatError(error))
      return
    }
    let parsed: Awaited<ReturnType<typeof parseSupportedDocument>>
    try {
      parsed = await parseSupportedDocument({
        path: document.path,
        bytes,
        maxBytes: settings.documentRag.maxExtractedBytesPerFile,
      })
      if (!parsed) {
        await this.markSkipped(document, "unsupported document")
        return
      }
      if (parsed.kind === "pdf" && parsed.text.includes("No extractable PDF text layer found")) {
        await this.markSkipped(document, "no extractable PDF text layer")
        return
      }
    } catch (error) {
      await this.markSkipped(document, formatError(error))
      return
    }
    const remainingChunks = Math.max(0, settings.documentRag.maxChunks - this.index!.chunks.filter((chunk) => chunk.documentUri !== document.uri).length)
    const chunks = createDocumentRagChunks({
      document,
      text: parsed.text,
      blocks: parsed.blocks,
      sourceHash: hash,
      maxChunks: remainingChunks,
    })
    if (chunks.length === 0) {
      await this.markSkipped(document, "no extractable text")
      return
    }
    const vectors = await this.embedChunks(provider, chunks, settings)
    this.replaceDocument(document.uri, {
      ...document,
      hash,
      indexedAt: Date.now(),
      chunkCount: chunks.length,
      skipped: false,
      error: undefined,
    }, chunks, vectors)
    await this.saveIndex()
    this.output.appendLine(`[document-rag] indexed ${document.path} chunks=${chunks.length}`)
  }

  private async embedChunks(provider: EmbeddingProvider, chunks: DocumentRagChunk[], settings: RemoteSettings) {
    const batches = planDocumentEmbeddingBatches(chunks, Math.min(settings.rag.embedding.batchSize, DOCUMENT_RAG_EMBEDDING_BATCH_LIMIT), settings.rag.embedding.maxTokensPerRequest)
    const vectors: number[][] = []
    for (const batch of batches) {
      const embedded = await provider.embed(batch.map((chunk) => chunk.text))
      if (embedded.length !== batch.length) throw new Error(`embedding provider returned ${embedded.length} vector(s), expected ${batch.length}`)
      vectors.push(...embedded.map(normalizeDocumentRagVector))
    }
    return vectors
  }

  private async markSkipped(document: DocumentRagDocument, reason: string) {
    this.removeDocumentChunks(document.uri)
    this.index!.documents[document.uri] = {
      ...document,
      skipped: true,
      error: reason,
      indexedAt: Date.now(),
      chunkCount: 0,
    }
    await this.saveIndex()
    this.output.appendLine(`[document-rag] skipped ${document.path}: ${reason}`)
  }

  private async documentFromUri(uri: vscode.Uri): Promise<DocumentRagDocument | undefined> {
    const path = workspaceRelativePath(uri)
    if (!isSupportedDocumentRagPath(path)) return undefined
    if (isDocumentRagExcludedPath(path, this.getSettings().documentRag.excludeGlobs)) return undefined
    const kind = documentRagKindFromPath(path)
    if (!kind) return undefined
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type !== vscode.FileType.File) return undefined
      const document: DocumentRagDocument = {
        uri: uri.toString(),
        path,
        kind,
        size: stat.size,
        mtime: stat.mtime,
      }
      if (stat.size > this.getSettings().documentRag.maxFileBytes) {
        return {
          ...document,
          skipped: true,
          error: `file too large (${stat.size} bytes)`,
          indexedAt: Date.now(),
          chunkCount: 0,
        }
      }
      return document
    } catch {
      return undefined
    }
  }

  private async ensureIndex() {
    if (this.index && this.index.rootKey === workspaceRootKey()) return
    this.index = await this.loadIndex() ?? this.emptyIndex()
  }

  private emptyIndex(): DocumentRagIndex {
    return {
      version: DOCUMENT_RAG_VERSION,
      rootKey: workspaceRootKey(),
      rootPaths: workspaceRootPaths(),
      updatedAt: Date.now(),
      dimension: 0,
      documents: {},
      chunks: [],
      vectors: [],
    }
  }

  private replaceDocument(uri: string, document: DocumentRagDocument, chunks: DocumentRagChunk[], vectors: number[][]) {
    this.removeDocumentChunks(uri)
    this.index!.documents[uri] = document
    this.index!.chunks.push(...chunks)
    this.index!.vectors.push(...vectors)
    this.index!.dimension = this.index!.vectors[0]?.length ?? 0
    this.index!.provider = this.embeddingProviderId()
    this.index!.model = this.getSettings().rag.embedding.model
    this.index!.updatedAt = Date.now()
  }

  private removeDocument(uri: string) {
    delete this.index!.documents[uri]
    this.removeDocumentChunks(uri)
    this.pendingDocuments.delete(uri)
    this.index!.updatedAt = Date.now()
  }

  private removeDocumentChunks(uri: string) {
    if (!this.index) return
    const chunks: DocumentRagChunk[] = []
    const vectors: number[][] = []
    for (let index = 0; index < this.index.chunks.length; index++) {
      if (this.index.chunks[index].documentUri === uri) continue
      chunks.push(this.index.chunks[index])
      vectors.push(this.index.vectors[index])
    }
    this.index.chunks = chunks
    this.index.vectors = vectors
    this.index.dimension = vectors[0]?.length ?? 0
  }

  private shiftPendingDocument() {
    const first = this.pendingDocuments.keys().next().value as string | undefined
    if (!first) return undefined
    const document = this.pendingDocuments.get(first)
    this.pendingDocuments.delete(first)
    return document
  }

  private async embeddingProvider(settings = this.getSettings()) {
    if (!settings.rag.embedding.enabled) return undefined
    return createHttpEmbeddingProvider(settings.rag, await this.getApiKey(), (event) => {
      this.output.appendLine(formatDocumentRagHttpDiagnostic(event))
    })
  }

  private async rerankProvider(settings = this.getSettings()) {
    if (!settings.rag.rerank.enabled) return undefined
    return createHttpRerankProvider(settings.rag, await this.getApiKey(), (event) => {
      this.output.appendLine(formatDocumentRagHttpDiagnostic(event))
    })
  }

  private embeddingProviderId() {
    const settings = this.getSettings().rag
    return settings.embedding.endpoint ? `http:${settings.embedding.endpoint}` : undefined
  }

  private setStatus(availability: DocumentRagStatus["availability"], patch: Partial<DocumentRagStatus> = {}) {
    const index = this.index
    const documents = Object.values(index?.documents ?? {})
    const skippedDocuments = documents.filter((document) => document.skipped).length
    const indexedDocuments = documents.filter((document) => !document.skipped && (document.chunkCount ?? 0) > 0).length
    const pendingDocuments = this.pendingDocuments.size
    this.statusValue = {
      enabled: this.getSettings().documentRag.enabled,
      availability,
      documentCount: documents.length,
      indexedDocuments,
      skippedDocuments,
      pendingDocuments,
      chunks: index?.chunks.length ?? 0,
      embeddedChunks: index?.vectors.length ?? 0,
      pendingChunkCount: Math.max(0, (index?.chunks.length ?? 0) - (index?.vectors.length ?? 0)),
      dimension: index?.dimension,
      provider: index?.provider,
      model: index?.model ?? this.getSettings().rag.embedding.model,
      updatedAt: index?.updatedAt,
      lastScanAt: patch.lastScanAt ?? index?.lastScanAt,
      ...patch,
    }
    this.onStatusChange()
  }

  private refreshReadyStatus() {
    const index = this.index
    const documents = Object.values(index?.documents ?? {})
    if (!this.getSettings().documentRag.enabled) {
      this.setStatus("disabled")
      return
    }
    if (this.paused) {
      this.setStatus("paused")
      return
    }
    if (this.largeWorkspacePaused) {
      this.setStatus("large-workspace-paused")
      return
    }
    if (documents.length === 0) {
      this.setStatus("no-documents")
      return
    }
    if (!this.getSettings().rag.embedding.enabled) {
      this.setStatus("not-configured", { fallbackReason: "Configure chipmate.rag.embedding.endpoint to build Document RAG." })
      return
    }
    if (this.pendingDocuments.size > 0) {
      if (this.shouldBackoff()) {
        this.setStatus("indexing", {
          fallbackReason: "Waiting for local code graph or code RAG indexing to finish.",
          progress: this.progress("backoff"),
        })
        return
      }
      this.setStatus("indexing", { progress: this.progress("indexing") })
      return
    }
    const skipped = documents.filter((document) => document.skipped).length
    const chunks = index?.chunks.length ?? 0
    this.setStatus(skipped > 0 || chunks === 0 ? "partial" : "ready")
  }

  private refreshStatusAfterPendingChanges() {
    this.refreshReadyStatus()
  }

  private progress(phase: "scanning" | "indexing" | "backoff") {
    const documents = Object.values(this.index?.documents ?? {})
    return {
      phase,
      documents: documents.length,
      indexedDocuments: documents.filter((document) => !document.skipped && (document.chunkCount ?? 0) > 0).length,
      pendingDocuments: this.pendingDocuments.size,
      chunks: this.index?.chunks.length ?? 0,
      embeddedChunks: this.index?.vectors.length ?? 0,
      updatedAt: Date.now(),
    }
  }

  private async saveIndex() {
    if (!this.index) return
    const dir = this.indexDir()
    await vscode.workspace.fs.createDirectory(dir)
    const manifest: SerializedDocumentRagIndex = {
      ...this.index,
      vectorsPath: "vectors.f32",
    }
    const vectors = encodeDocumentRagVectors(this.index.vectors, this.index.dimension)
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "vectors.f32"), vectors)
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "manifest.json"), encodeJson(manifest))
  }

  private async loadIndex(): Promise<DocumentRagIndex | undefined> {
    try {
      const dir = this.indexDir()
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, "manifest.json"))
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as SerializedDocumentRagIndex
      if (manifest.version !== DOCUMENT_RAG_VERSION || manifest.rootKey !== workspaceRootKey()) return undefined
      const vectorBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, manifest.vectorsPath || "vectors.f32"))
      const vectors = decodeDocumentRagVectors(vectorBytes, manifest.dimension)
      if (vectors.length !== manifest.chunks.length) throw new Error("Document RAG vector/chunk count mismatch")
      return {
        ...manifest,
        vectors,
      }
    } catch {
      return undefined
    }
  }

  private indexDir() {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "document-rag", workspaceRootKey())
  }
}

function workspaceRootKey() {
  return crypto.createHash("sha1").update(workspaceRootPaths().join("\0") || "no-workspace").digest("hex")
}

function workspaceRootPaths() {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath).sort()
}

function workspaceRelativePath(uri: vscode.Uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")
}

function planDocumentEmbeddingBatches(chunks: DocumentRagChunk[], maxInputs: number, maxTokensPerRequest: number) {
  const batches: DocumentRagChunk[][] = []
  let current: DocumentRagChunk[] = []
  let tokens = 0
  for (const chunk of chunks) {
    const itemTokens = estimateEmbeddingTokens(chunk.text)
    if (current.length > 0 && (current.length + 1 > maxInputs || (maxTokensPerRequest > 0 && tokens + itemTokens > maxTokensPerRequest))) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(chunk)
    tokens += itemTokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function rerankDocumentHits(
  question: string,
  hits: DocumentRagSearchHit[],
  provider: RerankProvider,
  topK: number,
  signal?: AbortSignal,
) {
  const selected = hits.slice(0, Math.max(0, topK))
  if (selected.length === 0) return hits
  const scores = await provider.rerank({
    query: question,
    documents: selected.map((hit) => hit.chunk.text),
    topN: selected.length,
    signal,
  })
  const byIndex = new Map(scores.map((item) => [item.index, item.score]))
  const reranked = selected
    .map((hit, index) => ({ ...hit, score: hit.score + (byIndex.get(index) ?? 0) }))
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path))
  return [...reranked, ...hits.slice(selected.length)]
}

type FormattedDocumentRagEvidence = {
  text: string
  injected: Array<{
    hit: DocumentRagSearchHit
    bytes: number
    preview: string
  }>
  omittedByBudget: number
}

function formatDocumentRagEvidence(hits: DocumentRagSearchHit[], input: {
  maxBytes: number
  status: DocumentRagStatus
}): FormattedDocumentRagEvidence {
  if (hits.length === 0) return { text: "", injected: [], omittedByBudget: 0 }
  const header = [
    `<local-document-rag documents="${input.status.indexedDocuments}/${input.status.documentCount}" chunks="${input.status.embeddedChunks}/${input.status.chunks}" evidenceCount="${hits.length}">`,
    "<answer-rules>Answer document questions only from the document evidence below. Cite file paths and line ranges. If evidence is insufficient, say what is missing instead of guessing.</answer-rules>",
    "<evidence-list>",
  ]
  const footer = ["</evidence-list>", "</local-document-rag>"]
  const rows: string[] = []
  const injected: FormattedDocumentRagEvidence["injected"] = []
  let omittedByBudget = 0
  let used = byteLength([...header, ...footer].join("\n"))
  for (const hit of hits) {
    const row = `<evidence ${documentRagEvidenceAttributes(hit)}>\n${xmlText(hit.chunk.text)}\n</evidence>`
    const size = byteLength(row)
    if (used + size > input.maxBytes) {
      omittedByBudget = hits.length - injected.length
      break
    }
    rows.push(row)
    injected.push({
      hit,
      bytes: size,
      preview: documentRagEvidencePreview(hit.chunk.text),
    })
    used += size
  }
  if (rows.length === 0) return { text: "", injected, omittedByBudget }
  return {
    text: [...header, ...rows, ...footer].join("\n"),
    injected,
    omittedByBudget,
  }
}

function documentRagEvidenceAttributes(hit: DocumentRagSearchHit) {
  const chunk = hit.chunk
  const attrs: Array<[string, string | undefined]> = [
    ["kind", chunk.kind],
    ["path", chunk.path],
    ["lines", `${chunk.startLine}-${chunk.endLine}`],
    ["section", chunk.section],
    ["chunkKind", chunk.chunkKind],
    ["label", chunk.label],
    ["heading", chunk.headingPath?.join(" > ")],
    ["sheet", chunk.sheetName],
    ["rows", rangeAttr(chunk.rowStart, chunk.rowEnd)],
    ["range", chunk.cellRange],
    ["pages", rangeAttr(chunk.pageStart, chunk.pageEnd)],
    ["score", hit.score.toFixed(3)],
  ]
  return attrs
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}="${xmlAttr(value)}"`)
    .join(" ")
}

function rangeAttr(start: number | undefined, end: number | undefined) {
  if (start === undefined && end === undefined) return undefined
  if (start === undefined) return String(end)
  if (end === undefined || end === start) return String(start)
  return `${start}-${end}`
}

function abortSignalAfter(ms: number) {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), Math.max(1, ms))
  return controller.signal
}

function encodeJson(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function documentRagEvidencePreview(text: string, maxChars = 240) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 3) return normalized.slice(0, maxChars)
  return `${normalized.slice(0, maxChars - 3)}...`
}

function logString(value: string) {
  return JSON.stringify(value)
}

function xmlAttr(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatDocumentRagHttpDiagnostic(event: RagHttpDiagnosticEvent) {
  const status = event.status === undefined ? "" : ` status=${event.status}`
  const elapsed = event.elapsedMs === undefined ? "" : ` elapsedMs=${event.elapsedMs}`
  const detailParts = [
    event.message ? `message=${compactDocumentRagLogValue(event.message)}` : undefined,
    event.errorPreview ? `errorPreview=${compactDocumentRagLogValue(event.errorPreview)}` : undefined,
  ]
  if (event.phase === "error") {
    detailParts.push(
      event.errorName ? `errorName=${compactDocumentRagLogValue(event.errorName)}` : undefined,
      event.errorMessage ? `errorMessage=${compactDocumentRagLogValue(event.errorMessage)}` : undefined,
      event.errorCode ? `errorCode=${compactDocumentRagLogValue(event.errorCode)}` : undefined,
      event.causeName ? `causeName=${compactDocumentRagLogValue(event.causeName)}` : undefined,
      event.causeCode ? `causeCode=${compactDocumentRagLogValue(event.causeCode)}` : undefined,
      event.causeErrno ? `causeErrno=${compactDocumentRagLogValue(event.causeErrno)}` : undefined,
      event.causeSyscall ? `causeSyscall=${compactDocumentRagLogValue(event.causeSyscall)}` : undefined,
      event.causeHostname ? `causeHostname=${compactDocumentRagLogValue(event.causeHostname)}` : undefined,
      event.causeHost ? `causeHost=${compactDocumentRagLogValue(event.causeHost)}` : undefined,
      event.causePort ? `causePort=${compactDocumentRagLogValue(event.causePort)}` : undefined,
      event.causeAddress ? `causeAddress=${compactDocumentRagLogValue(event.causeAddress)}` : undefined,
      event.causeMessage ? `causeMessage=${compactDocumentRagLogValue(event.causeMessage)}` : undefined,
      event.causeStackFirstLine ? `causeStack=${compactDocumentRagLogValue(event.causeStackFirstLine)}` : undefined,
      event.causeDetails?.length ? `causeDetails=${compactDocumentRagLogValue(event.causeDetails.join(" | "))}` : undefined,
    )
  }
  const detail = detailParts.filter(Boolean).join(" ")
  return `[document-rag-http] ${event.kind}.${event.phase}${status}${elapsed}${detail ? ` ${detail}` : ""}`
}

function compactDocumentRagLogValue(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > 240 ? `${value.slice(0, 240)}...` : value
}

export function isCodeGraphBusyForDocumentRag(status: CodeGraphStatus | undefined) {
  if (!status) return false
  if (status.state === "indexing" || status.state === "indexingFull" || status.state === "indexingIncremental" || status.state === "recovering") return true
  return status.rag?.availability === "checking" || status.rag?.availability === "indexing"
}
