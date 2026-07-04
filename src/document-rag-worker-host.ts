import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { parseSupportedDocument, type ParsedDocumentContent } from "./document-parser"

type WorkerStatus = {
  healthy: boolean
  workers: number
  version?: number
  error?: string
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

type WorkerSlot = {
  worker: Worker
  active: number
  pending: Map<number, PendingRequest>
  healthy: boolean
}

export class DocumentRagWorkerPool {
  private readonly workers: WorkerSlot[] = []
  private nextId = 0
  private disabledReason = ""

  async health(targetSize: number): Promise<WorkerStatus> {
    try {
      this.ensureSize(targetSize)
      if (this.workers.length === 0) return { healthy: false, workers: 0, error: this.disabledReason || "No workers available." }
      const results = await Promise.all(this.workers.map((slot) => this.request(slot, "health", {})))
      const first = results[0] as { healthy?: boolean; version?: number }
      return { healthy: results.every((item) => Boolean((item as { healthy?: boolean }).healthy)), workers: this.workers.length, version: first.version }
    } catch (error) {
      return { healthy: false, workers: this.workers.length, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async parseDocument(
    input: { path: string; bytes: Uint8Array; maxBytes: number },
    targetSize: number,
  ): Promise<ParsedDocumentContent | undefined> {
    try {
      this.ensureSize(targetSize)
      const slot = this.nextSlot()
      if (!slot) return parseSupportedDocument(input)
      return await this.request(slot, "parse", { document: input }) as ParsedDocumentContent | undefined
    } catch {
      return parseSupportedDocument(input)
    }
  }

  dispose() {
    for (const slot of this.workers) {
      for (const pending of slot.pending.values()) pending.reject(new Error("Document RAG worker pool disposed."))
      slot.pending.clear()
      void slot.worker.terminate()
    }
    this.workers.splice(0)
  }

  size() {
    return this.workers.length
  }

  isHealthy() {
    return this.workers.some((slot) => slot.healthy)
  }

  private ensureSize(targetSize: number) {
    if (this.disabledReason) return
    const size = Math.max(1, Math.min(4, Math.floor(targetSize)))
    while (this.workers.length < size) {
      try {
        const worker = new Worker(path.join(__dirname, "document-rag-worker.js"))
        const slot: WorkerSlot = { worker, active: 0, pending: new Map(), healthy: true }
        worker.on("message", (message: { id?: number; ok?: boolean; data?: unknown; error?: string }) => {
          if (typeof message.id !== "number") return
          const pending = slot.pending.get(message.id)
          if (!pending) return
          slot.pending.delete(message.id)
          slot.active = Math.max(0, slot.active - 1)
          if (message.ok) pending.resolve(message.data)
          else pending.reject(new Error(message.error || "Document RAG worker request failed."))
        })
        worker.on("error", (error) => {
          slot.healthy = false
          for (const pending of slot.pending.values()) pending.reject(error)
          slot.pending.clear()
        })
        worker.on("exit", (code) => {
          slot.healthy = false
          if (code !== 0) {
            const error = new Error(`Document RAG worker exited with ${code}.`)
            for (const pending of slot.pending.values()) pending.reject(error)
            slot.pending.clear()
          }
        })
        this.workers.push(slot)
      } catch (error) {
        this.disabledReason = error instanceof Error ? error.message : String(error)
        break
      }
    }
    while (this.workers.length > size) {
      const slot = this.workers.pop()
      if (slot) void slot.worker.terminate()
    }
  }

  private nextSlot() {
    const healthy = this.workers.filter((slot) => slot.healthy)
    if (healthy.length === 0) return undefined
    return healthy.sort((left, right) => left.active - right.active)[0]
  }

  private request(slot: WorkerSlot, type: "health" | "parse", payload: Record<string, unknown>) {
    const id = ++this.nextId
    slot.active++
    return new Promise<unknown>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject })
      slot.worker.postMessage({ id, type, ...payload })
    })
  }
}
