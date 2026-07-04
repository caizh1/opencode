import { afterAll, describe, expect, test } from "bun:test"
import * as http from "node:http"
import { CompletionModelClient, CompletionModelRequestError, chatCompletionsUrl, completionApiBaseUrl, completionModel, completionsUrl, directCompletionRequestDiagnostic } from "../src/completion-model-client"
import { completionInsertText } from "../src/completion-text"
import type { RemoteSettings } from "../src/types"

let servers: http.Server[] = []

afterAll(async () => {
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

  test("posts Qwen coder FIM requests to raw completions", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        body: await collectJson(request) as Record<string, unknown>,
      }
      json(response, 200, {
        id: "cmpl",
        model: "qwen-coder",
        choices: [{ text: "_sum(a, b) {\n    return a + b;\n}" }],
      })
    })

    const prompt = "<|repo_name|>opencode<|file_sep|>test.ts\n<|fim_prefix|>function add<|fim_suffix|>\n<|fim_middle|>"
    const message = await new CompletionModelClient(settings(`${baseUrl}/v1`, { profile: "qwen-coder-fim" })).complete({ prompt })

    expect(captured.url).toBe("/v1/completions")
    expect(captured.body).toMatchObject({
      model: "qwen",
      prompt,
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.8,
    })
    expect(captured.body?.stop).toEqual(expect.arrayContaining(["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"]))
    expect(completionInsertText(message, "qwen-coder-fim")).toBe("_sum(a, b) {\n    return a + b;\n}")
  })

  test("allows per-request generation parameter overrides", async () => {
    let captured: Record<string, unknown> = {}
    const baseUrl = await listen(async (request, response) => {
      captured = await collectJson(request) as Record<string, unknown>
      json(response, 200, {
        choices: [{ text: "ok" }],
      })
    })

    await new CompletionModelClient(settings(baseUrl, { profile: "qwen-coder-fim" })).complete({
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
      maxTokens: 48,
      temperature: 0,
      topP: 1,
    })

    expect(captured).toMatchObject({
      max_tokens: 48,
      temperature: 0,
      top_p: 1,
    })
  })

  test("sends seed on raw FIM requests when provided", async () => {
    let captured: Record<string, unknown> = {}
    const baseUrl = await listen(async (request, response) => {
      captured = await collectJson(request) as Record<string, unknown>
      json(response, 200, {
        choices: [{ text: "ok" }],
      })
    })

    await new CompletionModelClient(settings(baseUrl, { profile: "qwen-coder-fim" })).complete({
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
      seed: 1234,
    })

    expect(captured).toMatchObject({
      seed: 1234,
    })
  })

  test("allows per-request profile overrides to raw FIM completions", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        body: await collectJson(request) as Record<string, unknown>,
      }
      json(response, 200, {
        choices: [{ text: "raw" }],
      })
    })

    await new CompletionModelClient(settings(baseUrl, { profile: "generic-chat" })).complete({
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
      profile: "qwen-coder-fim",
    })

    expect(captured.url).toBe("/completions")
    expect(captured.body).toMatchObject({
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
    })
  })

  test("allows per-request profile overrides to chat completions", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        body: await collectJson(request) as Record<string, unknown>,
      }
      json(response, 200, {
        choices: [{ message: { content: "chat" } }],
      })
    })

    await new CompletionModelClient(settings(baseUrl, { profile: "qwen-coder-fim" })).complete({
      prompt: "instruction",
      profile: "generic-chat",
    })

    expect(captured.url).toBe("/chat/completions")
    expect(captured.body).toMatchObject({
      messages: expect.any(Array),
    })
  })

  test("can force chat-completions transport for a qwen FIM prompt", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        body: await collectJson(request) as Record<string, unknown>,
      }
      json(response, 200, {
        choices: [{ message: { content: "chat fim" } }],
      })
    })

    await new CompletionModelClient(settings(baseUrl, { profile: "qwen-coder-fim" })).complete({
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
      transport: "chat-completions",
      seed: 77,
    })

    expect(captured.url).toBe("/chat/completions")
    expect(captured.body).toMatchObject({
      messages: expect.any(Array),
      seed: 77,
    })
  })

  test("accepts chat-shaped raw completion responses from compatible servers", async () => {
    const baseUrl = await listen((_request, response) => {
      json(response, 200, {
        choices: [{ message: { content: "return ok;" } }],
      })
    })

    const message = await new CompletionModelClient(settings(baseUrl, { profile: "qwen-coder-fim" })).complete({ prompt: "fim" })

    expect(completionInsertText(message, "qwen-coder-fim")).toBe("return ok;")
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

  test("explains direct FIM endpoint failures for chat-only compatible servers", () => {
    expect(directCompletionRequestDiagnostic(
      new CompletionModelRequestError(404, "404 Not Found"),
      "qwen-coder-fim",
    )).toContain("/completions")
    expect(directCompletionRequestDiagnostic(
      new CompletionModelRequestError(405, "405 Method Not Allowed"),
      "qwen-coder-fim",
    )).toContain("qwen-coder-fim")
    expect(directCompletionRequestDiagnostic(
      new CompletionModelRequestError(404, "404 Not Found"),
      "generic-chat",
    )).toBe("")
  })

  test("builds chat completion URLs and falls back to the default model", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1/chat/completions")
    expect(chatCompletionsUrl("http://localhost:8000/v1/chat/completions")).toBe("http://localhost:8000/v1/chat/completions")
    expect(completionsUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1/completions")
    expect(completionsUrl("http://localhost:8000/v1/chat/completions")).toBe("http://localhost:8000/v1/completions")
    expect(completionsUrl("http://localhost:8000/v1/completions")).toBe("http://localhost:8000/v1/completions")
    expect(completionModel(settings("http://localhost:8000/v1", { completionModel: "", defaultModel: "fallback" }))).toBe("fallback")
  })

  test("uses chat provider base URL until completion provider mode is custom", () => {
    expect(completionApiBaseUrl(settings("http://completion.local/v1", {
      providerBaseUrl: "http://chat.local/v1",
    }))).toBe("http://chat.local/v1")
    expect(completionApiBaseUrl(settings("http://completion.local/v1", {
      providerBaseUrl: "http://chat.local/v1",
      providerMode: "custom",
    }))).toBe("http://completion.local/v1")
  })
})

function settings(baseUrl: string, input: { completionModel?: string; defaultModel?: string; profile?: RemoteSettings["completion"]["profile"]; providerBaseUrl?: string; providerMode?: RemoteSettings["completion"]["providerMode"] } = {}): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: input.providerBaseUrl ?? baseUrl,
      chatModel: "",
      maxTokens: 4096,
      temperature: 0.2,
      topP: 0.8,
    },
    serverUrl: "http://localhost:4096",
    username: "chipmate",
    defaultModel: input.defaultModel ?? "",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
      maxHistoryTurns: 10,
      maxHistoryBytes: 40000,
      memorySummary: {
        enabled: true,
        maxBytes: 12000,
        triggerOverflowTurns: 2,
      },
    },
    permissions: {
      mode: "ask",
    },
    tools: {
      enabled: false,
      maxAgentSteps: 25,
    },
    skills: {
      enabled: [],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: true,
      maxCatalogBytes: 8000,
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: true,
      providerMode: input.providerMode ?? "inherit-chat",
      provider: "openai-compatible",
      profile: input.profile ?? "generic-chat",
      apiBaseUrl: baseUrl,
      model: input.completionModel ?? "qwen",
      maxTokens: 128,
      contextLength: 200000,
      temperature: 0.2,
      topP: 0.8,
      debounceMs: 350,
      logLevel: "info",
      debugFullRetrievalProbe: false,
      debugExpectedSymbol: "",
      commentGuidedRetrievalMode: "qa-exact",
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
      indexTests: false,
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
        batchSize: 64,
        maxTokensPerRequest: 65536,
        concurrentRequests: 2,
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
      indexTests: false,
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
