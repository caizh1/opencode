import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import { OpenAIChatClient, chatCompletionsUrl } from "../src/openai-chat-client"
import type { OpenAIChatSettings } from "../src/openai-chat-client"

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

describe("OpenAI-compatible chat client", () => {
  test("posts non-streaming chat completion requests", async () => {
    let captured: { url?: string; auth?: string; body?: Record<string, unknown> } = {}
    const baseUrl = await listen(async (request, response) => {
      captured = {
        url: request.url,
        auth: request.headers.authorization,
        body: await collectJson(request) as Record<string, unknown>,
      }
      json(response, 200, {
        id: "chatcmpl-1",
        model: "qwen-chat",
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        choices: [{ message: { role: "assistant", content: "hello" } }],
      })
    })

    const result = await new OpenAIChatClient(settings(baseUrl, { streaming: false }), "secret").complete({
      messages: [{ role: "user", content: "hi" }],
    })

    expect(captured.url).toBe("/chat/completions")
    expect(captured.auth).toBe("Bearer secret")
    expect(captured.body).toMatchObject({
      model: "qwen-chat",
      stream: false,
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
    })
    expect(result.streamed).toBe(false)
    expect(result.message).toMatchObject({ role: "assistant", content: "hello" })
    expect(result.usage?.total_tokens).toBe(8)
  })

  test("aggregates streaming content, reasoning, and tool calls", async () => {
    const events: string[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      })
      response.write(sse({
        id: "chatcmpl-stream",
        model: "qwen-chat",
        choices: [{ delta: { reasoning_content: "think " } }],
      }))
      response.write(sse({
        choices: [{ delta: { content: "Hel" } }],
      }))
      response.write(sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "workspace.search", arguments: "{\"query\":\"foo" },
            }],
          },
        }],
      }))
      response.write(sse({
        choices: [{
          delta: {
            content: "lo",
            tool_calls: [{
              index: 0,
              function: { arguments: "\"}" },
            }],
          },
        }],
      }))
      response.write("data: [DONE]\n\n")
      response.end()
    })

    const result = await new OpenAIChatClient(settings(baseUrl)).complete({
      messages: [{ role: "user", content: "hi" }],
      onEvent: (event) => events.push(event.type),
    })

    expect(result.streamed).toBe(true)
    expect(result.id).toBe("chatcmpl-stream")
    expect(result.model).toBe("qwen-chat")
    expect(result.message.content).toBe("Hello")
    expect(result.message.reasoning_content).toBe("think ")
    expect(result.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "workspace.search",
          arguments: "{\"query\":\"foo\"}",
        },
      },
    ])
    expect(events).toEqual(expect.arrayContaining(["reasoning-delta", "text-delta", "tool-call-delta"]))
  })

  test("falls back to non-streaming when streaming is rejected", async () => {
    const requests: Record<string, unknown>[] = []
    const events: string[] = []
    const baseUrl = await listen(async (request, response) => {
      const body = await collectJson(request) as Record<string, unknown>
      requests.push(body)
      if (body.stream === true) {
        response.writeHead(405, { "content-type": "text/plain" }).end("stream unsupported")
        return
      }
      json(response, 200, {
        choices: [{ message: { role: "assistant", content: "fallback ok" } }],
      })
    })

    const result = await new OpenAIChatClient(settings(baseUrl)).complete({
      messages: [{ role: "user", content: "hi" }],
      onEvent: (event) => events.push(event.type),
    })

    expect(requests.map((body) => body.stream)).toEqual([true, false])
    expect(result.streamed).toBe(false)
    expect(result.fallbackReason).toContain("405")
    expect(result.message.content).toBe("fallback ok")
    expect(events).toContain("fallback")
  })

  test("normalizes chat completion URLs", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1/chat/completions")
    expect(chatCompletionsUrl("http://localhost:8000/v1/chat/completions")).toBe("http://localhost:8000/v1/chat/completions")
  })
})

function settings(baseUrl: string, overrides: Partial<OpenAIChatSettings> = {}): OpenAIChatSettings {
  return {
    apiBaseUrl: baseUrl,
    model: "qwen-chat",
    maxTokens: 1024,
    temperature: 0.2,
    topP: 0.9,
    streaming: true,
    ...overrides,
  }
}

function listen(handler: http.RequestListener) {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind a TCP port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function collectJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let text = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text += chunk
    })
    request.on("end", () => resolve(JSON.parse(text || "{}")))
    request.on("error", reject)
  })
}

function json(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}
