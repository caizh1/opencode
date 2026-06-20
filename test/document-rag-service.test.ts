import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "document-rag.ts"), "utf8")
const extensionSource = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")
const contextSource = readFileSync(join(import.meta.dir, "..", "src", "context.ts"), "utf8")
const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")

describe("document RAG service integration", () => {
  test("registers a document watcher and reconciles missed events", () => {
    expect(serviceSource).toContain("vscode.workspace.createFileSystemWatcher(DOCUMENT_RAG_GLOB)")
    expect(serviceSource).toContain("onDidCreate")
    expect(serviceSource).toContain("onDidChange")
    expect(serviceSource).toContain("onDidDelete")
    expect(serviceSource).toContain("onDidChangeWorkspaceFolders")
    expect(serviceSource).toContain("DOCUMENT_RAG_RECONCILE_INTERVAL_MS")
    expect(serviceSource).toContain("watcher storm")
    expect(serviceSource).toContain("DOCUMENT_RAG_UNRESOLVED_CHANGE_RECONCILE_DELAY_MS")
    expect(serviceSource).toContain('"unresolved watcher event"')
  })

  test("keeps Document RAG separate from code graph and code RAG lifecycle", () => {
    expect(extensionSource).toContain("new DocumentRagService")
    expect(extensionSource).toContain("documentRag.start()")
    expect(extensionSource).toContain("isCodeGraphBusyForDocumentRag(codeGraph.status())")
    expect(serviceSource).toContain('"document-rag"')
    expect(serviceSource).not.toContain('"codegraph", workspaceRootKey()')
  })

  test("backs off during code indexing and does not block chat sends", () => {
    expect(serviceSource).toContain("Waiting for local code graph or code RAG indexing to finish.")
    expect(serviceSource).toContain("DOCUMENT_RAG_BACKOFF_MS")
    expect(contextSource).toContain("retrieveDocumentRagEvidence")
    expect(contextSource).toContain("CHAT_DOCUMENT_RAG_LATENCY_BUDGET_MS")
    expect(contextSource).toContain("catch {")
    expect(chatViewSource).toContain("await this.waitForCodeGraphReady(settings)")
    expect(chatViewSource).not.toContain("waitForDocumentRag")
  })

  test("applies watcher adds and removals incrementally without forcing a full rebuild", () => {
    expect(serviceSource).toContain("this.removeDocument(change.uri.toString())")
    expect(serviceSource).toContain("this.pendingDocuments.set(document.uri, document)")
    expect(serviceSource).toContain("this.refreshStatusAfterPendingChanges()")
    expect(serviceSource).toContain('this.scheduleReconcile("watcher storm", 0)')
    expect(serviceSource).toContain('this.scheduleReconcile("unresolved watcher event"')
    expect(serviceSource).not.toContain('this.scheduleReconcile("watcher storm", 0, true)')
    expect(serviceSource).not.toContain('this.scheduleReconcile("unresolved watcher event", 0, true)')
  })

  test("continues to answer chats from partial document indexes", () => {
    expect(contextSource).toContain('if (status.availability !== "ready" && status.availability !== "partial") return undefined')
  })

  test("logs the document evidence that is injected into the chat prompt", () => {
    expect(serviceSource).toContain("this.logQueryEvidence(hits, evidence, elapsedMs)")
    expect(serviceSource).toContain("[document-rag] query evidence injected=${evidence.injected.length} retrieved=${hits.length} omittedByBudget=${evidence.omittedByBudget}")
    expect(serviceSource).toContain("path=${logString(chunk.path)} lines=${chunk.startLine}-${chunk.endLine}")
    expect(serviceSource).toContain("section=${logString(chunk.section)} kind=${chunk.kind}")
    expect(serviceSource).toContain("score=${item.hit.score.toFixed(3)} bytes=${item.bytes} preview=${logString(item.preview)}")
    expect(serviceSource).toContain("documentRagEvidencePreview(hit.chunk.text)")
    expect(serviceSource).toContain("maxChars = 240")
    expect(serviceSource).toContain("omittedByBudget = hits.length - injected.length")
  })

  test("surfaces Document RAG state independently in chat state", () => {
    expect(chatViewSource).toContain("documentRag?: DocumentRagContextProvider")
    expect(chatViewSource).toContain("documentRag: this.deps.documentRag?.status()")
    expect(chatViewSource).toContain('type: "pauseDocumentRagIndexing"')
    expect(chatViewSource).toContain('type: "resumeDocumentRagIndexing"')
    expect(chatViewSource).toContain('type: "rebuildDocumentRag"')
    expect(chatViewSource).toContain('type: "showDocumentRagStatus"')
  })
})
