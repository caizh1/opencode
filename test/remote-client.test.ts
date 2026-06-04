import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import {
  RemoteOpenCodeAuthError,
  RemoteOpenCodeClient,
  RemoteOpenCodeConnectionError,
  RemoteOpenCodeRequestError,
  isSessionNotFoundError,
  normalizeAgents,
  normalizeModels,
} from "../src/remote-client"
import type { RemoteSettings } from "../src/types"

let servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  servers = []
})

describe("RemoteOpenCodeClient", () => {
  test("reads health from a remote server", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/global/health") {
        json(response, 200, { healthy: true, version: "test" })
        return
      }
      response.writeHead(404).end()
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).health()).resolves.toEqual({
      healthy: true,
      version: "test",
    })
  })

  test("maps 401 responses to auth errors", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(401).end("no")
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).health()).rejects.toBeInstanceOf(RemoteOpenCodeAuthError)
  })

  test("includes HTTP status and body in request errors", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" }).end("broken")
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).health()).rejects.toMatchObject({
      name: "RemoteOpenCodeRequestError",
      status: 500,
      message: "500 Internal Server Error: broken",
    } satisfies Partial<RemoteOpenCodeRequestError>)
  })

  test("wraps network failures with the base URL", async () => {
    await expect(new RemoteOpenCodeClient(settings("http://127.0.0.1:9")).health()).rejects.toMatchObject({
      name: "RemoteOpenCodeConnectionError",
      baseUrl: "http://127.0.0.1:9",
    } satisfies Partial<RemoteOpenCodeConnectionError>)
  })

  test("aborted requests fail cleanly", async () => {
    const baseUrl = await listen(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).health(controller.signal)).rejects.toMatchObject({
      name: "RemoteOpenCodeConnectionError",
      baseUrl,
    } satisfies Partial<RemoteOpenCodeConnectionError>)
  })

  test("lists models from config providers", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/config/providers") {
        json(response, 200, {
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-sonnet-4-20250514": { name: "Claude Sonnet 4" },
              },
            },
          ],
          default: { anthropic: "claude-sonnet-4-20250514" },
        })
        return
      }
      response.writeHead(404).end()
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).listModels()).resolves.toEqual([
      {
        id: "anthropic/claude-sonnet-4-20250514",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        providerName: "Anthropic",
        isDefault: true,
      },
    ])
  })

  test("falls back to provider endpoint for models", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/config/providers") {
        response.writeHead(404).end()
        return
      }
      if (request.url === "/provider") {
        json(response, 200, {
          all: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-5", name: "GPT-5" }] }],
          default: { model: "openai/gpt-5" },
        })
        return
      }
      response.writeHead(404).end()
    })

    const models = await new RemoteOpenCodeClient(settings(baseUrl)).listModels()

    expect(models[0]).toMatchObject({
      id: "openai/gpt-5",
      isDefault: true,
    })
  })

  test("lists and normalizes remote agents", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/agent") {
        json(response, 200, [
          { id: "build", name: "Build", description: "Full tools" },
          { id: "vscode-local", description: "VS Code local context", mode: "primary" },
        ])
        return
      }
      response.writeHead(404).end()
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).listAgents()).resolves.toEqual([
      {
        id: "vscode-local",
        name: "vscode-local",
        description: "VS Code local context",
        mode: "primary",
        isLocalOnly: true,
      },
      {
        id: "build",
        name: "Build",
        description: "Full tools",
        isLocalOnly: false,
      },
    ])
  })

  test("reads remote session retry statuses", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/session/status") {
        json(response, 200, {
          s1: {
            type: "retry",
            attempt: 16,
            message: "Gateway Time-out",
            next: 1780364586400,
          },
        })
        return
      }
      response.writeHead(404).end()
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).getSessionStatuses()).resolves.toEqual({
      s1: {
        type: "retry",
        attempt: 16,
        message: "Gateway Time-out",
        next: 1780364586400,
      },
    })
  })

  test("does not hide agent discovery failures", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/agent") {
        response.writeHead(500, { "content-type": "text/plain" }).end("agent broken")
        return
      }
      response.writeHead(404).end()
    })

    await expect(new RemoteOpenCodeClient(settings(baseUrl)).listAgents()).rejects.toMatchObject({
      name: "RemoteOpenCodeRequestError",
      status: 500,
    } satisfies Partial<RemoteOpenCodeRequestError>)
  })

  test("sends model only when one is provided", async () => {
    const bodies: unknown[] = []
    const baseUrl = await listen((request, response) => {
      if (request.url === "/session/abc/message") {
        collectJson(request).then((body) => {
          bodies.push(body)
          json(response, 200, { info: { id: "m1" }, parts: [] })
        })
        return
      }
      response.writeHead(404).end()
    })
    const client = new RemoteOpenCodeClient(settings(baseUrl))

    await client.sendMessage({ sessionID: "abc", text: "hello" })
    await client.sendMessage({
      sessionID: "abc",
      text: "hello",
      model: { providerID: "openai", modelID: "gpt-5" },
    })

    expect(bodies[0]).not.toHaveProperty("model")
    expect(bodies[1]).toMatchObject({ model: { providerID: "openai", modelID: "gpt-5" } })
  })

  test("sends async messages without waiting for a response body", async () => {
    const bodies: unknown[] = []
    const baseUrl = await listen((request, response) => {
      if (request.url === "/session/abc/prompt_async") {
        collectJson(request).then((body) => {
          bodies.push(body)
          response.writeHead(204).end()
        })
        return
      }
      response.writeHead(404).end()
    })

    await new RemoteOpenCodeClient(settings(baseUrl)).sendMessageAsync({
      sessionID: "abc",
      text: "hello",
      model: { providerID: "openai", modelID: "gpt-5" },
      agent: "vscode-local",
    })

    expect(bodies).toEqual([
      {
        model: { providerID: "openai", modelID: "gpt-5" },
        agent: "vscode-local",
        parts: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("subscribes to SSE events across chunk boundaries", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/event") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })
        response.write('data: {"type":"server.connected","properties":{}}\n\n')
        response.write('data: {"type":"message.updated","properties":{"info":{"id":"m1"')
        setTimeout(() => {
          response.write(',"sessionID":"s1","role":"assistant"}}}\n\n')
        }, 5)
        request.on("close", () => response.end())
        return
      }
      response.writeHead(404).end()
    })

    const client = new RemoteOpenCodeClient(settings(baseUrl))
    const controller = new AbortController()
    const events: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE events")), 1000)
      void client
        .subscribeEvents(
          (event) => {
            events.push(event)
            if (events.length === 2) {
              clearTimeout(timer)
              controller.abort()
              resolve()
            }
          },
          controller.signal,
        )
        .catch((error) => {
          if (controller.signal.aborted) return
          clearTimeout(timer)
          reject(error)
        })
    })

    expect(events).toEqual([
      { type: "server.connected", properties: {} },
      { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } },
    ])
  })

  test("can subscribe to the global SSE event stream", async () => {
    const requestedPaths: string[] = []
    const baseUrl = await listen((request, response) => {
      requestedPaths.push(request.url ?? "")
      if (request.url === "/global/event") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })
        response.write('data: {"type":"server.connected","properties":{}}\n\n')
        request.on("close", () => response.end())
        return
      }
      response.writeHead(404).end()
    })

    const client = new RemoteOpenCodeClient(settings(baseUrl))
    const controller = new AbortController()
    const events: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for global SSE events")), 1000)
      void client
        .subscribeEvents(
          (event) => {
            events.push(event)
            clearTimeout(timer)
            controller.abort()
            resolve()
          },
          controller.signal,
          undefined,
          "/global/event",
        )
        .catch((error) => {
          if (controller.signal.aborted) return
          clearTimeout(timer)
          reject(error)
        })
    })

    expect(requestedPaths).toEqual(["/global/event"])
    expect(events).toEqual([{ type: "server.connected", properties: {} }])
  })
})

describe("model normalization", () => {
  test("normalizes provider model maps", () => {
    expect(
      normalizeModels({
        providers: [{ id: "ollama", name: "Ollama", models: { "qwen3-coder": { name: "Qwen Coder" } } }],
        default: { ollama: "qwen3-coder" },
      }),
    ).toContainEqual({
      id: "ollama/qwen3-coder",
      providerID: "ollama",
      modelID: "qwen3-coder",
      name: "Qwen Coder",
      providerName: "Ollama",
      isDefault: true,
    })
  })

  test("preserves limits from provider model maps", () => {
    expect(
      normalizeModels({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-sonnet-4": {
                name: "Claude Sonnet 4",
                limit: { context: 200_000, output: 64_000 },
              },
            },
          },
        ],
      }),
    ).toContainEqual({
      id: "anthropic/claude-sonnet-4",
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      providerName: "Anthropic",
      isDefault: false,
      contextLimit: 200_000,
      outputLimit: 64_000,
    })
  })

  test("preserves limits from provider model arrays", () => {
    expect(
      normalizeModels({
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-5", name: "GPT-5", limit: { context: 128_000, output: 16_000 } }],
          },
        ],
      }),
    ).toContainEqual({
      id: "openai/gpt-5",
      providerID: "openai",
      modelID: "gpt-5",
      name: "GPT-5",
      providerName: "OpenAI",
      isDefault: false,
      contextLimit: 128_000,
      outputLimit: 16_000,
    })
  })
})

describe("agent normalization", () => {
  test("normalizes agent maps and marks the required VS Code local agent", () => {
    expect(
      normalizeAgents({
        agent: {
          build: { description: "Full tools" },
          "vscode-local": { name: "VS Code Local", disable: false },
          disabled: { disable: true },
        },
      }),
    ).toEqual([
      {
        id: "vscode-local",
        name: "VS Code Local",
        isLocalOnly: true,
      },
      {
        id: "build",
        name: "build",
        description: "Full tools",
        isLocalOnly: false,
      },
      {
        id: "disabled",
        name: "disabled",
        disabled: true,
        isLocalOnly: false,
      },
    ])
  })

  test("normalizes direct agent map responses", () => {
    expect(
      normalizeAgents({
        "vscode-local": { description: "Required" },
        build: { description: "Other" },
      }),
    ).toContainEqual({
      id: "vscode-local",
      name: "vscode-local",
      description: "Required",
      isLocalOnly: true,
    })
  })

  test("marks OpenCode title-cased VS Code local agents as local-only", () => {
    expect(normalizeAgents([{ name: "Vscode-Local" }])).toContainEqual({
      id: "Vscode-Local",
      name: "Vscode-Local",
      isLocalOnly: true,
    })
    expect(normalizeAgents([{ id: "display", name: "VS Code Local" }])).toContainEqual({
      id: "display",
      name: "VS Code Local",
      isLocalOnly: true,
    })
  })
})

describe("request error helpers", () => {
  test("recognizes missing remote sessions", () => {
    expect(isSessionNotFoundError(new RemoteOpenCodeRequestError(404, "404 Not Found: session not found"))).toBe(true)
    expect(isSessionNotFoundError(new RemoteOpenCodeRequestError(404, "404 Not Found: route not found"))).toBe(false)
    expect(isSessionNotFoundError(new RemoteOpenCodeRequestError(500, "500 Internal Server Error: session not found"))).toBe(false)
  })
})

function settings(serverUrl: string): RemoteSettings {
  return {
    serverUrl,
    username: "opencode",
    defaultModel: "",
    defaultAgent: "",
    localOnlyAgent: "vscode-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
    },
    completion: {
      enabled: false,
      provider: "opencode",
      profile: "generic-chat",
      apiBaseUrl: "",
      model: "",
      maxTokens: 128,
      temperature: 0.2,
      topP: 0.8,
      debounceMs: 350,
      logLevel: "info",
    },
    codeGraph: {
      enabled: false,
      promptOnWorkspaceOpen: true,
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
      bridgeEnabled: true,
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
        maxInFlightTokens: 180000,
        encodingFormat: "float",
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
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function collectJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => resolve(JSON.parse(body)))
  })
}
