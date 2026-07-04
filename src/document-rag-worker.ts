import { parentPort } from "node:worker_threads"
import { parseSupportedDocument, type ParsedDocumentContent } from "./document-parser"

type WorkerRequest =
  | { id: number; type: "health" }
  | { id: number; type: "parse"; document: { path: string; bytes: Uint8Array; maxBytes: number } }

type WorkerResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string }

parentPort?.on("message", async (message: WorkerRequest) => {
  try {
    if (message.type === "health") {
      reply({ id: message.id, ok: true, data: { healthy: true, version: 1 } })
      return
    }
    if (message.type === "parse") {
      const parsed: ParsedDocumentContent | undefined = await parseSupportedDocument(message.document)
      reply({ id: message.id, ok: true, data: parsed })
      return
    }
    const unknown = message as { id?: number }
    reply({ id: unknown.id ?? -1, ok: false, error: "Unknown Document RAG worker request." })
  } catch (error) {
    reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

function reply(response: WorkerResponse) {
  parentPort?.postMessage(response)
}
