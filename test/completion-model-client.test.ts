import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import { CompletionModelClient, chatCompletionsUrl, completionModel } from "../src/completion-model-client"
import { completionInsertText } from "../src/completion-text"
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

describe("direct completion model client", () => {
  test("posts OpenAI-compatible chat completion requests", async () => {
    let captured: { url?: string; auth?: string; body?: unknown } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        auth: request.headers.authorization,
        body: await collectJson(request),
      }
      json(response, 200, {
        id: "cmpl",
        model: "qwen",
        choices: [{ message: { content: "return 1;" } }],
      })
    })

    const message = await new CompletionModelClient(settings(`${baseUrl}/v1`), "secret").complete({ prompt: "complete" })

    expect(captured.url).toBe("/v1/chat/completions")
    expect(captured.auth).toBe("Bearer secret")
    expect(captured.body).toMatchObject({
      model: "qwen",
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.8,
    })
    expect(completionInsertText(message)).toBe("return 1;")
  })

  test("omits authorization for empty API keys and drops reasoning content from insert text", async () => {
    let auth: string | undefined
    const baseUrl = await listen((request, response) => {
      auth = request.headers.authorization
      json(response, 200, {
        choices: [{ message: { reasoning_content: "think", content: "<think>hidden</think>return 2;" } }],
      })
    })

    const message = await new CompletionModelClient(settings(baseUrl), "").complete({ prompt: "complete" })

    expect(auth).toBeUndefined()
    expect(message.parts).toContainEqual({ type: "reasoning", text: "think" })
    expect(completionInsertText(message)).toBe("return 2;")
  })

  test("reports HTTP and malformed response errors", async () => {
    const httpBaseUrl = await listen((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" }).end("broken")
    })
    await expect(new CompletionModelClient(settings(httpBaseUrl)).complete({ prompt: "complete" })).rejects.toMatchObject({
      name: "CompletionModelRequestError",
      status: 500,
    })

    const emptyBaseUrl = await listen((_request, response) => {
      json(response, 200, { choices: [] })
    })
    await expect(new CompletionModelClient(settings(emptyBaseUrl)).complete({ prompt: "complete" })).rejects.toMatchObject({
      name: "CompletionModelRequestError",
    })
  })

  test("builds chat completion URLs and falls back to the default model", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1/chat/completions")
    expect(chatCompletionsUrl("http://localhost:8000/v1/chat/completions")).toBe("http://localhost:8000/v1/chat/completions")
    expect(completionModel(settings("http://localhost:8000/v1", { completionModel: "", defaultModel: "fallback" }))).toBe("fallback")
  })
})

function settings(baseUrl: string, input: { completionModel?: string; defaultModel?: string } = {}): RemoteSettings {
  return {
    serverUrl: "http://localhost:4096",
    username: "opencode",
    defaultModel: input.defaultModel ?? "",
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
      enabled: true,
      provider: "openai-compatible",
      apiBaseUrl: baseUrl,
      model: input.completionModel ?? "qwen",
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
        batchSize: 32,
        timeoutMs: 30000,
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
    request.on("end", () => {
      resolve(JSON.parse(body))
    })
  })
}
