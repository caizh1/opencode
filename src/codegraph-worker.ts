import { parentPort } from "node:worker_threads"
import { parseCFile } from "./codegraph-c-parser"
import { hydrateCodeGraphIndex } from "./codegraph-index"
import type { CodeGraphFile, CodeGraphIndex } from "./codegraph-types"

type WorkerRequest =
  | { id: number; type: "health" }
  | { id: number; type: "parse"; file: { path: string; text: string; hash: string; size: number } }
  | { id: number; type: "hydrate"; index: CodeGraphIndex; skippedFiles?: number }

type WorkerResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string }

parentPort?.on("message", (message: WorkerRequest) => {
  try {
    if (message.type === "health") {
      reply({ id: message.id, ok: true, data: { healthy: true, version: 1 } })
      return
    }
    if (message.type === "parse") {
      const file: CodeGraphFile = parseCFile(message.file)
      reply({ id: message.id, ok: true, data: file })
      return
    }
    if (message.type === "hydrate") {
      reply({ id: message.id, ok: true, data: hydrateCodeGraphIndex(message.index, message.skippedFiles ?? 0) })
      return
    }
    const unknown = message as { id?: number }
    reply({ id: unknown.id ?? -1, ok: false, error: "Unknown code graph worker request." })
  } catch (error) {
    reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

function reply(response: WorkerResponse) {
  parentPort?.postMessage(response)
}
