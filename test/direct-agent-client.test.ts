import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillRegistry } from "../src/skills"
import type { ToolRuntime, ToolRuntimeResult } from "../src/tool-runtime"
import type { RemoteSettings } from "../src/types"

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

let servers: http.Server[] = []

beforeEach(() => {
  workspaceFolders = []
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
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
      version: "direct-openai-compatible",
    })
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "chat-model", isDefault: true }),
      expect.objectContaining({ id: "completion-model", isDefault: false }),
      expect.objectContaining({ id: "gpt-chip", providerID: "openai-compatible" }),
      expect.objectContaining({ id: "qwen-fim", providerName: "OpenAI Compatible" }),
    ])
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
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read_file", arguments: "{\"path\":" } }] } }] }),
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
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read_file",
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
      } as unknown as ToolRuntime,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: true,
      tool_choice: "auto",
    })
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "tool result text" }),
    ]))
    expect(toolResults).toEqual([{ name: "chipmate_read_file", arguments: { path: "README.md" } }])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Done with tool." }),
      expect.objectContaining({ type: "tool", tool: "chipmate_read_file" }),
    ]))

    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("\"type\":\"session\"")
    expect(sessionLog).toContain("\"role\":\"user\"")
    expect(sessionLog).toContain("\"role\":\"assistant\"")
  })
})

function directClient(baseUrl: string, overrides: Partial<{
  storageRoot: string
  tools: ToolRuntime
}> = {}) {
  const settings = directSettings(baseUrl)
  return new DirectAgentClient({
    context: {
      globalStorageUri: UriShim.file(overrides.storageRoot ?? join(tmpdir(), "chipmate-direct-storage-default")),
    },
    output: {
      appendLine: () => undefined,
    },
    getSettings: () => settings,
    getApiKey: async () => "secret",
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
    } as unknown as ToolRuntime,
  } as never)
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
    },
    permissions: {
      mode: "full-access",
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
        batchSize: 128,
        maxTokensPerRequest: 65536,
        concurrentRequests: 3,
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
      vectorTopK: 24,
      rerankTopK: 16,
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
