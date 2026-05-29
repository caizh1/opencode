import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import {
  RemoteOpenCodeAuthError,
  RemoteOpenCodeClient,
  RemoteOpenCodeConnectionError,
  RemoteOpenCodeRequestError,
  isSessionNotFoundError,
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
      strictLocalOnlyAgent: false,
    },
    completion: {
      enabled: false,
      debounceMs: 350,
      logLevel: "info",
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
