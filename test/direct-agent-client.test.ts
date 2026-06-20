import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillRegistry } from "../src/skills"
import type { ToolRuntime as ToolRuntimeInstance, ToolRuntimeResult } from "../src/tool-runtime"
import type { RemoteSettings } from "../src/types"
import { docxFixture } from "./document-fixtures"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  InlineCompletionTriggerKind: {
    Invoke: 0,
    Automatic: 1,
  },
  InlineCompletionItem: class InlineCompletionItem {
    insertText: string
    range?: unknown
    command?: unknown
    filterText?: string

    constructor(insertText: string, range?: unknown, command?: unknown) {
      this.insertText = insertText
      this.range = range
      this.command = command
    }
  },
  Range: class Range {
    start: { line: number; character: number }
    end: { line: number; character: number }

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  ConfigurationTarget: {
    Global: "global",
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: UriShim,
  commands: {
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? "",
    getWorkspaceFolder: () => workspaceFolders[0],
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => fallback,
      update: async () => undefined,
    }),
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      readDirectory: async (uri: UriShim) => {
        const entries = await readdir(uri.fsPath, { withFileTypes: true })
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number])
      },
      delete: async (uri: UriShim) => rm(uri.fsPath, { force: true, recursive: true }),
    },
  },
  window: {
    get activeTextEditor() {
      return undefined
    },
    get visibleTextEditors() {
      return []
    },
  },
  Position: class Position {},
  Selection: class Selection {},
}))

const { DirectAgentClient } = await import("../src/direct-agent-client")
const { ToolRuntime } = await import("../src/tool-runtime")

let servers: http.Server[] = []

beforeEach(() => {
  workspaceFolders = []
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

describe("ToolRuntime", () => {
  test("only exposes read tool definitions to models", () => {
    const runtime = new ToolRuntime({} as never)
    const toolNames = runtime.toolDefinitions().map((definition) => definition.function.name)

    expect(toolNames).toEqual([
      "chipmate_search_text",
      "chipmate_search_code",
      "chipmate_graph_inspect_symbol",
      "chipmate_graph_find_references",
      "chipmate_graph_callers",
      "chipmate_graph_callees",
      "chipmate_graph_trace_call_chain",
      "chipmate_graph_analyze_impact",
      "chipmate_graph_map_module",
      "chipmate_graph_find_state_machines",
      "chipmate_graph_trace_state_path",
      "chipmate_search_documents",
      "chipmate_read_evidence",
      "chipmate_read",
    ])
    expect(toolNames).not.toContain("chipmate_write_file")
    expect(toolNames).not.toContain("chipmate_run_command")
    expect(toolNames).not.toContain("chipmate_http_request")
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Use when"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Do not use"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Returns"))).toBe(true)
    expect(runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_read")?.function.description).toContain("Office/PDF")
  })

  test("graph tools return refIds that can be read with chipmate_read_evidence", async () => {
    const root = await tempDir("chipmate-tool-graph-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    runtime.setContextProviders({
      codeGraph: {
        status: () => ({ rag: { enabled: false, embeddingEnabled: false, availability: "unavailable", indexAvailability: "none", chunks: 0, embeddedChunks: 0 } }),
        findSymbols: async () => [],
        queryEvidence: async () => undefined,
        runAnalysisTool: async () => ({
          ok: true,
          traceId: "trace-callers",
          tool: "getCallers",
          elapsedMs: 1,
          data: { mode: "callers" },
          evidence: [{
            file: "src/driver.c",
            startLine: 10,
            endLine: 14,
            snippetHash: "hash",
            parserKind: "codegraph:caller",
            snippet: "void boot(void) {\n  nand_read_page();\n}",
          }],
          audit: { traceId: "trace-callers", tool: "getCallers", argsSummary: "nand_read_page", evidenceCount: 1, elapsedMs: 1, blocked: false },
        }),
      } as never,
      getSettings: () => directSettings("http://127.0.0.1/v1"),
    })

    const result = await runtime.execute({
      sessionID: "session-a",
      mode: "ask",
      name: "chipmate_graph_callers",
      arguments: { symbol: "nand_read_page" },
    })
    const payload = JSON.parse(result.output) as { evidence: Array<{ refId: string; sourceKind: string; path: string }>; coverage: string }

    expect(result.approved).toBe(true)
    expect(payload.coverage).toBe("bounded-complete")
    expect(payload.evidence[0]).toMatchObject({ path: "src/driver.c", sourceKind: "codegraph:caller" })

    const expanded = await runtime.execute({
      sessionID: "session-a",
      mode: "ask",
      name: "chipmate_read_evidence",
      arguments: { refId: payload.evidence[0]?.refId },
    })
    const expandedPayload = JSON.parse(expanded.output) as { evidence: Array<{ snippet: string }> }
    expect(expandedPayload.evidence[0]?.snippet).toContain("nand_read_page")
  })

  test("document search returns unified evidence refs from Document RAG", async () => {
    const root = await tempDir("chipmate-tool-doc-rag-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const settings = directSettings("http://127.0.0.1/v1")
    settings.documentRag.enabled = true
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    runtime.setContextProviders({
      documentRag: {
        status: () => ({
          enabled: true,
          availability: "ready",
          documentCount: 1,
          indexedDocuments: 1,
          skippedDocuments: 0,
          pendingDocuments: 0,
          chunks: 1,
          embeddedChunks: 1,
        }),
        query: async () => ({
          text: '<local-document-rag documents="1/1" chunks="1/1" evidenceCount="1"><evidence-list><evidence kind="pdf" path="docs/spec.pdf" lines="4-6" section="pdf:1" score="0.991">upgrade flow</evidence></evidence-list></local-document-rag>',
          hits: [{ path: "docs/spec.pdf", startLine: 4, endLine: 6, score: 0.991 }],
          elapsedMs: 3,
        }),
      },
      getSettings: () => settings,
    })

    const result = await runtime.execute({
      sessionID: "session-doc",
      mode: "ask",
      name: "chipmate_search_documents",
      arguments: { query: "upgrade flow" },
    })
    const payload = JSON.parse(result.output) as { evidence: Array<{ refId: string; path: string; sourceKind: string; snippet: string }>; data: { ragHits: unknown[] } }

    expect(payload.evidence[0]).toMatchObject({ path: "docs/spec.pdf", sourceKind: "document-rag:pdf" })
    expect(payload.evidence[0]?.snippet).toContain("upgrade flow")
    expect(payload.data.ragHits).toHaveLength(1)
  })

  test("reads supported documents through the exposed workspace read tool", async () => {
    const root = await tempDir("chipmate-tool-document-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await writeFile(join(root, "brief.docx"), docxFixture("Tool readable Word document"))
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_read",
      arguments: { path: "brief.docx" },
    })

    expect(result.approved).toBe(true)
    const payload = JSON.parse(result.output) as { answerSummary: string; evidence: Array<{ refId: string; path: string; sourceKind: string; snippet: string }>; coverage: string; data: { text: string } }
    expect(payload.answerSummary).toContain("brief.docx")
    expect(payload.coverage).toBe("complete")
    expect(payload.evidence[0]).toMatchObject({ path: "brief.docx", sourceKind: "document:docx" })
    expect(payload.evidence[0]?.refId).toBeTruthy()
    expect(payload.data.text).toContain("DOCX text:")
    expect(payload.data.text).toContain("Tool readable Word document")
  })

  test("returns a failed result when chipmate_read targets a missing workspace file", async () => {
    const root = await tempDir("chipmate-tool-missing-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const missingPath = join(root, "hw", "ufs.c")

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_read",
      arguments: { path: "hw/ufs.c" },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(result.output).toContain("File not found:")
    expect(result.output).toContain(missingPath)
  })
})

describe("DirectAgentClient", () => {
  test("discovers /models and falls back to configured model names", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/v1/models") {
        json(response, 200, { data: [{ id: "gpt-chip" }, { id: "qwen-fim" }] })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: true,
      state: "connected",
      detail: "provider /models",
      version: "direct-openai-compatible",
    })
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "chat-model", isDefault: true, source: "configured" }),
      expect.objectContaining({ id: "completion-model", isDefault: false, source: "configured" }),
      expect.objectContaining({ id: "gpt-chip", providerID: "openai-compatible", providerIndex: 0, source: "provider" }),
      expect.objectContaining({ id: "qwen-fim", providerIndex: 1, providerName: "OpenAI Compatible", source: "provider" }),
    ])
  })

  test("health reports disconnected when provider settings are incomplete", async () => {
    const client = directClient("")

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "disconnected",
      detail: "Ready. Configure an OpenAI-compatible provider to start ChipMate.",
      version: "direct-openai-compatible",
    })
  })

  test("health reports authFailed for invalid provider credentials", async () => {
    const requests: string[] = []
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? "")
      if (request.url === "/v1/models") {
        json(response, 401, { error: { message: "invalid token" } })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { apiKey: "" })

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "authFailed",
      detail: "Provider authentication failed. Set a valid ChipMate provider API key.",
      version: "direct-openai-compatible",
    })
    expect(requests).toEqual(["/v1/models"])
  })

  test("health falls back from unsupported /models to a minimal chat probe", async () => {
    const requests: Array<{ url?: string; body?: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      requests.push({ url: request.url })
      if (request.url === "/v1/models") {
        response.writeHead(404).end()
        return
      }
      if (request.url === "/v1/chat/completions") {
        const body = await collectJson(request)
        requests[requests.length - 1].body = body
        json(response, 200, { choices: [{ message: { role: "assistant", content: "ok" } }] })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: true,
      state: "connected",
      detail: "provider direct-openai-compatible",
      version: "direct-openai-compatible",
    })
    expect(requests.map((request) => request.url)).toEqual(["/v1/models", "/v1/chat/completions"])
    expect(requests[1]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      max_tokens: 1,
    })
  })

  test("health reports authFailed when the chat probe rejects credentials", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(404).end()
        return
      }
      if (request.url === "/v1/chat/completions") {
        await collectJson(request)
        json(response, 403, { error: { message: "Unauthorized API key" } })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { apiKey: "bad-token" })

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "authFailed",
      detail: "Provider authentication failed. Set a valid ChipMate provider API key.",
      version: "direct-openai-compatible",
    })
  })

  test("health reports provider probe errors without entering connected state", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "text/html" }).end("<html>not json</html>")
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "error",
      detail: "Provider /models probe returned malformed JSON.",
      version: "direct-openai-compatible",
    })
  })

  test("does not expose or execute tool calls when tools are disabled", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "Checking " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Read file",
            output: "tool result text",
            approved: true,
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: true,
    })
    expect(requests[0]?.body).not.toHaveProperty("tools")
    expect(requests[0]?.body).not.toHaveProperty("tool_choice")
    expect(requests[0]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
    expect(toolResults).toEqual([])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("工具调用已关闭") }),
    ]))
  })

  test("sends recent clean chat history without replaying old local context", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? "First answer." : "Second answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-history-storage-") })
    const session = await client.createSession()

    await client.sendMessage({
      sessionID: session.id,
      text: [
        "User question:",
        "Explain the failure",
        "",
        "Local workspace context:",
        "secret old file context",
        "",
        "Local code graph evidence:",
        "secret old graph evidence",
      ].join("\n"),
    })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "Explain the failure" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "continue" },
    ])
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("secret old file context")
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("secret old graph evidence")
  })

  test("keeps chat history disabled when maxHistoryTurns is zero", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ url: request.url, body: await collectJson(request) })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      historyTurns: 0,
      storageRoot: await tempDir("chipmate-no-history-storage-"),
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "first" })
    await client.sendMessage({ sessionID: session.id, text: "second" })

    expect(requests[1]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "second" },
    ])
  })

  test("trims long assistant history from the front and keeps the tail", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const longAnswer = `${"A".repeat(200)}TAIL`
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? longAnswer : "done" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      historyBytes: 60,
      storageRoot: await tempDir("chipmate-trim-history-storage-"),
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "first" })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    const messages = requests[1]?.body.messages as Array<{ role: string; content?: string }>
    const assistantHistory = messages.find((message) => message.role === "assistant")?.content ?? ""
    expect(assistantHistory).toEndWith("TAIL")
    expect(assistantHistory.length).toBeLessThanOrEqual(60)
    expect(assistantHistory).not.toContain("A".repeat(80))
  })

  test("streams chat completions, executes tool calls, and stores session JSONL on the workspace host", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":" } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Done with tool." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-direct-storage-")
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      storageRoot,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Read file",
            output: "tool result text",
            approved: true,
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: true,
      tool_choice: "auto",
    })
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(["chipmate_read"])
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "tool result text" }),
    ]))
    expect(toolResults).toEqual([{ name: "chipmate_read", arguments: { path: "README.md" } }])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Done with tool." }),
      expect.objectContaining({ type: "tool", tool: "chipmate_read" }),
    ]))

    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("\"type\":\"session\"")
    expect(sessionLog).toContain("\"role\":\"user\"")
    expect(sessionLog).toContain("\"role\":\"assistant\"")
  })

  test("blocks legacy read-file tool calls that were not exposed to the model", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Trying old tool." } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_legacy", function: { name: "chipmate_read_file", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Blocked handled." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Unexpected",
            output: "should not execute",
            approved: true,
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "read README" })

    expect(requests).toHaveLength(2)
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(["chipmate_read"])
    expect(toolResults).toEqual([])
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_legacy",
        content: "Tool is not exposed to the model in this chat mode: chipmate_read_file",
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read_file",
        state: expect.objectContaining({
          status: "blocked",
          output: "Tool is not exposed to the model in this chat mode: chipmate_read_file",
        }),
      }),
      expect.objectContaining({ type: "text", text: "Blocked handled." }),
    ]))
    expect(outputLines.join("\n")).toContain("[tool] blocked unexposed tool_call name=chipmate_read_file")
  })

  test("continues the chat when chipmate_read reports a missing file", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_missing", function: { name: "chipmate_read", arguments: "{\"path\":\"hw/ufs.c\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "The file does not exist." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const root = await tempDir("chipmate-missing-read-workspace-")
    const storageRoot = await tempDir("chipmate-missing-read-storage-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const client = directClient(baseUrl, {
      storageRoot,
      toolsEnabled: true,
      tools: runtime,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "read /hw/ufs.c" })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_missing",
        content: expect.stringContaining("File not found:"),
      }),
    ]))
    expect(JSON.stringify(requests[1]?.body.messages)).toContain(join(root, "hw", "ufs.c"))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read",
        state: expect.objectContaining({
          status: "failed",
          output: expect.stringContaining("File not found:"),
        }),
      }),
      expect.objectContaining({ type: "text", text: "The file does not exist." }),
    ]))
    expect((await client.getSessionStatuses())[session.id]?.type).toBe("idle")
    expect((await client.getMessages(session.id)).some((message) => Boolean(message.info.error))).toBe(false)
  })

  test("converts exposed tool runtime exceptions into failed tool results", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_throw", function: { name: "chipmate_read", arguments: "{\"path\":\"missing.c\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Handled failed tool." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-exception-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          throw Object.assign(new Error("ENOENT: no such file or directory, open '/missing.c'"), { code: "ENOENT" })
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "read missing.c" })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_throw",
        content: expect.stringContaining("Tool failed: chipmate_read"),
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read",
        state: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("ENOENT"),
        }),
      }),
      expect.objectContaining({ type: "text", text: "Handled failed tool." }),
    ]))
    expect((await client.getSessionStatuses())[session.id]?.type).toBe("idle")
    expect((await client.getMessages(session.id)).some((message) => message.info.error?.message?.includes("对话已中断"))).toBe(false)
    expect(outputLines.join("\n")).toContain("[tool] chipmate_read failed: ENOENT")
  })

  test("does not replay prior tool results as next-turn history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "follow up" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-history-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Read file",
          output: "tool result text",
          approved: true,
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "inspect repo" })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: "tool result text" }),
    ]))
    expect(requests[2]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
    expect(JSON.stringify(requests[2]?.body.messages)).not.toContain("tool result text")
  })

  test("persists interrupted partial assistant text for next-turn history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.write(sse({ choices: [{ delta: { content: "Partial answer before interruption." } }] }))
        response.destroy(new Error("stream interrupted"))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "continued" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-partial-history-storage-") })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "first" })).rejects.toThrow()
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "Partial answer before interruption." },
    ]))
  })

  test("accepts finish_reason as a chat completion stream marker without DONE", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "Finished by reason." } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-finish-reason-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "first" })

    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Finished by reason." }),
    ]))
    expect(outputLines.join("\n")).toContain("[chat-stream] request start model=chat-model")
    expect(outputLines.join("\n")).toContain("doneMarker=false")
    expect(outputLines.join("\n")).toContain("finishReason=stop")
  })

  test("records async stream interruptions when the provider closes before completion", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.write(sse({ choices: [{ delta: { content: "Partial answer before clean close." } }] }))
      response.end()
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-async-interrupt-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "first" })
    await waitFor(async () => (await client.getSessionStatuses())[session.id]?.type === "error")

    const messages = await client.getMessages(session.id)
    expect(messages.some((message) => message.info.error?.message?.includes("对话已中断"))).toBe(true)
    expect(messages.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("Partial answer before clean close.")))).toBe(true)
    expect(outputLines.join("\n")).toContain("[send] interrupted")
    expect(outputLines.join("\n")).toContain("closed before completion marker")
    expect(outputLines.join("\n")).toContain("deltaCount=")
    expect(outputLines.join("\n")).toContain("textBytes=")
    expect(outputLines.join("\n")).toContain("firstChunkMs=")
    expect(outputLines.join("\n")).toContain("doneMarker=false")
  })

  test("diagnoses 200 streams that close without OpenAI SSE data", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end("event: ping\n\n")
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-empty-sse-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "first" })).rejects.toThrow(/rawPreview=event: ping/)

    const output = outputLines.join("\n")
    expect(output).toContain("[chat-stream] response status=200 contentType=text/event-stream")
    expect(output).toContain("sseDataCount=0")
    expect(output).toContain("rawBytes=")
    expect(output).toContain("emptySsePreview=event: ping")
  })

  test("parses CRLF-delimited OpenAI SSE streams", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "CRLF works." } }] })}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-crlf-sse-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "first" })

    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "CRLF works." }),
    ]))
    expect(outputLines.join("\n")).toContain("doneMarker=true")
  })

  test("does not record session errors for user-aborted async sends", async () => {
    const outputLines: string[] = []
    let receivedRequest!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      receivedRequest = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.write(sse({ choices: [{ delta: { content: "Partial answer before user stop." } }] }))
      receivedRequest()
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-user-abort-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "first" })
    await requestReceived
    await client.abortSession(session.id)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const messages = await client.getMessages(session.id)
    expect(messages.some((message) => Boolean(message.info.error))).toBe(false)
    expect(outputLines.join("\n")).not.toContain("[send] interrupted")
  })

  test("deletes persisted sessions and emits session.deleted", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-delete-session-storage-") })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = client.subscribeEvents((event) => events.push(event), controller.signal)
    const first = await client.createSession("First chat")
    const second = await client.createSession("Second chat")
    await client.abortSession(first.id)

    await expect(client.deleteSession(first.id)).resolves.toBe(true)
    controller.abort()
    await subscription

    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: second.id, title: "Second chat" }),
    ])
    await expect(client.getMessages(first.id)).resolves.toEqual([])
    expect((await client.getSessionStatuses())[first.id]).toBeUndefined()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.deleted",
        properties: { info: expect.objectContaining({ id: first.id, title: "First chat" }) },
      }),
    ]))
  })
})

function directClient(baseUrl: string, overrides: Partial<{
  storageRoot: string
  outputLines: string[]
  tools: ToolRuntimeInstance
  toolsEnabled: boolean
  historyTurns: number
  historyBytes: number
  apiKey: string | undefined
}> = {}) {
  const settings = directSettings(baseUrl)
  settings.tools.enabled = overrides.toolsEnabled === true
  if (overrides.historyTurns !== undefined) settings.context.maxHistoryTurns = overrides.historyTurns
  if (overrides.historyBytes !== undefined) settings.context.maxHistoryBytes = overrides.historyBytes
  return new DirectAgentClient({
    context: {
      globalStorageUri: UriShim.file(overrides.storageRoot ?? join(tmpdir(), "chipmate-direct-storage-default")),
    },
    output: {
      appendLine: (line: string) => overrides.outputLines?.push(line),
    },
    getSettings: () => settings,
    getApiKey: async () => Object.prototype.hasOwnProperty.call(overrides, "apiKey") ? overrides.apiKey : "secret",
    skills: {
      enabledSkills: async () => [],
      loadSkill: async () => undefined,
    } as unknown as SkillRegistry,
    tools: overrides.tools ?? {
      toolDefinitions: () => [],
      execute: async () => ({
        title: "noop",
        output: "noop",
        approved: true,
      }),
    } as unknown as ToolRuntimeInstance,
  } as never)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition.")
}

function directSettings(baseUrl: string): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: baseUrl,
      chatModel: "chat-model",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
    },
    serverUrl: baseUrl,
    username: "chipmate",
    defaultModel: "chat-model",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
      maxHistoryTurns: 3,
      maxHistoryBytes: 12000,
    },
    permissions: {
      mode: "full-access",
    },
    tools: {
      enabled: false,
    },
    skills: {
      enabled: [],
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: baseUrl,
      model: "completion-model",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      debounceMs: 0,
      logLevel: "off",
      debugFullRetrievalProbe: false,
      debugExpectedSymbol: "",
      commentGuidedRetrievalMode: "qa-exact",
    },
    codeGraph: {
      enabled: true,
      promptOnWorkspaceOpen: false,
      analysisMode: "auto",
      maxFiles: 50000,
      maxContextBytes: 24000,
      maxEvidenceBytes: 60000,
      maxGraphDepth: 2,
      maxFanout: 40,
      maxDeepFiles: 24,
      maxStateTransitions: 120,
      watcherRescanThreshold: 750,
      workerConcurrency: 4,
      queryCacheSize: 80,
      memoryLimitMb: 4096,
      compileCommandsPath: "",
      clangdPath: "",
      scipClangPath: "",
      excludeGlobs: [],
      indexTests: false,
    },
    analysis: {
      bridgeEnabled: false,
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      maxFileSliceBytes: 16000,
      maxGraphEdges: 120,
      maxPaths: 10,
    },
    rag: {
      embedding: {
        enabled: false,
        endpoint: "",
        model: "",
        batchSize: 64,
        maxTokensPerRequest: 65536,
        concurrentRequests: 2,
        maxInFlightTokens: 360000,
        encodingFormat: "auto",
        checkpointMode: "interval",
        checkpointChunkInterval: 8192,
        checkpointIntervalMs: 120000,
        timeoutMs: 30000,
        requestDelayMs: 0,
        maxRequestsPerRun: 100,
        maxRetries: 3,
        retryBackoffMs: 2000,
        resumeAutomatically: true,
        resumeDelayMs: 60000,
      },
      rerank: {
        enabled: false,
        endpoint: "",
        model: "",
      },
      allowedHosts: [],
      indexTests: false,
      vectorTopK: 24,
      rerankTopK: 16,
    },
    documentRag: {
      enabled: true,
      maxFiles: 5000,
      maxFileBytes: 25 * 1024 * 1024,
      maxExtractedBytesPerFile: 1024 * 1024,
      maxChunks: 50000,
      excludeGlobs: [],
      queryTopK: 12,
      maxEvidenceBytes: 24000,
    },
  }
}

function listen(handler: http.RequestListener) {
  return new Promise<string>((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server address unavailable")
      resolve(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

function collectJson(request: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk.toString()
    })
    request.on("end", () => {
      resolve(JSON.parse(body || "{}") as Record<string, unknown>)
    })
  })
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function sse(body: unknown) {
  return `data: ${JSON.stringify(body)}\n\n`
}

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}
