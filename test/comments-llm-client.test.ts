import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import type * as net from "node:net"
import { CommentLLMClient, CommentLLMGenerationError, type CommentLLMDiagnosticEvent } from "../src/comments/commentLLMClient"
import { parseCommentProposalResponse } from "../src/comments/commentProposalParser"

let servers: http.Server[] = []
let sockets: net.Socket[] = []

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets = []
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

describe("AI comment LLM client", () => {
  test("times out stalled comment generation requests", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, _response) => {
      // Intentionally never respond so the client timeout path fires.
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(`${baseUrl}/v1`),
      getApiKey: async () => "secret",
    })

    await expect(client.generate("comment me", undefined, 20, (event) => events.push(event))).rejects.toThrow("注释生成在 20ms 后超时。")

    expect(events.map((event) => event.stage)).toContain("model.http.prepare")
    expect(events.map((event) => event.stage)).toContain("model.http.fetch.start")
    const timeout = events.find((event) => event.stage === "model.http.timeout")
    expect(timeout?.fields).toMatchObject({
      timeoutMs: 20,
      lastStage: "model.http.fetch.start",
      responseHeadersReceived: false,
      firstChunkReceived: false,
      client: "comment-stream",
      stream: true,
    })
    expect(JSON.stringify(events)).not.toContain("comment me")
    expect(JSON.stringify(events)).not.toContain(baseUrl)
    expect(JSON.stringify(events)).not.toContain("secret")
  })

  test("distinguishes body-read timeout after response headers", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      // Keep the stream open so the first SSE chunk is the stalled phase.
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(`${baseUrl}/v1`),
      getApiKey: async () => "",
    })

    await expect(client.generate("comment body", undefined, 30, (event) => events.push(event))).rejects.toThrow("注释生成在 30ms 后超时。")

    expect(events.some((event) => event.stage === "model.http.response.headers")).toBe(true)
    const timeout = events.find((event) => event.stage === "model.http.timeout")
    expect(timeout?.fields).toMatchObject({
      timeoutMs: 30,
      lastStage: "model.http.response.headers",
      responseHeadersReceived: true,
      firstChunkReceived: false,
    })
  })

  test("returns assistant content collected from streaming chat completion chunks", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    let requestBody: Record<string, unknown> | undefined
    const baseUrl = await listen(async (_request, response) => {
      requestBody = await readRequestJson(_request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "{\"proposals\":" } }] }),
        sse({ choices: [{ delta: { content: "[]}" }, finish_reason: "stop" }] }),
        sse({ choices: [], usage: {
          prompt_tokens: 31,
          completion_tokens: 225,
          total_tokens: 256,
          completion_tokens_details: {
            reasoning_tokens: 17,
            text_tokens: 208,
          },
        } }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.tokenUsage).toEqual({
      usageAvailable: true,
      usagePromptTokens: 31,
      usageCompletionTokens: 225,
      usageTotalTokens: 256,
      usageReasoningTokens: 17,
      usageTextTokens: 208,
    })
    expect(events.map((event) => event.stage)).toContain("model.http.prepare")
    expect(events.map((event) => event.stage)).toContain("model.http.fetch.start")
    expect(events.map((event) => event.stage)).toContain("model.http.response.headers")
    expect(events.map((event) => event.stage)).toContain("model.http.stream.firstChunk")
    expect(events.map((event) => event.stage)).toContain("model.response.normalize")
    expect(events.map((event) => event.stage)).toContain("model.http.stream.done")
    const streamEvents = events.filter((event) => event.stage === "model.stream.delta")
    expect(streamEvents.length).toBeGreaterThan(0)
    expect(streamEvents.some((event) => String(event.fields?.visiblePreview ?? "").includes("\"proposals\""))).toBe(true)
    expect(streamEvents.some((event) => event.fields?.usageCompletionTokens === 225)).toBe(true)
    expect(requestBody?.max_tokens).toBeUndefined()
    expect(requestBody?.response_format).toEqual({ type: "json_object" })
    expect(requestBody?.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
    ])
    expect(JSON.stringify(requestBody?.messages)).toContain("Your first visible output character must be {")
    expect(JSON.stringify(requestBody?.messages)).toContain("/no_think")
    expect(JSON.stringify(requestBody)).not.toContain("thinking_token_budget")
    expect(JSON.stringify(requestBody)).not.toContain("chat_template_kwargs")
    expect(JSON.stringify(requestBody)).not.toContain("enable_thinking")
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      thinkingBudget: "disabled",
      responseFormat: "json_object",
      noThinkHint: true,
      messageShape: "system-user",
      maxTokensSent: false,
      maxTokens: "omitted",
      providerMaxTokensConfigured: 4096,
      jsonPrefixGuard: "accepted",
      jsonPrefixGuardMode: "json-object",
      usageAvailable: true,
      usagePromptTokens: 31,
      usageCompletionTokens: 225,
      usageTotalTokens: 256,
      usageReasoningTokens: 17,
      usageTextTokens: 208,
      normalizedTextBytes: 16,
      strippedThinkBlockCount: 0,
      openThinking: false,
      jsonFenceStripped: false,
      jsonFenceLanguage: "none",
    })
    expect(events.find((event) => event.stage === "model.http.stream.done")?.fields).toMatchObject({
      responseStatus: 200,
      responseContentType: "text/event-stream",
      client: "comment-stream",
      stream: true,
      responseFormat: "json_object",
      jsonPrefixGuard: "accepted",
      usageAvailable: true,
      usageCompletionTokens: 225,
      deltaCount: 3,
      sseDataCount: 4,
      doneMarker: true,
      finishReason: "stop",
      textBytes: 16,
    })
  })

  test("redacts source-like anchor text from stream preview without changing final JSON", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const json = JSON.stringify({
      proposals: [{
        kind: "logicBlock",
        insertBeforeLine: 1,
        indent: "  ",
        commentText: "// 中文注释",
        anchor: { targetLineText: "do_work(secret);" },
        confidence: "medium",
        reason: "说明原因",
      }],
    })
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: json }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe(json)
    const preview = events
      .filter((event) => event.stage === "model.stream.delta")
      .map((event) => String(event.fields?.visiblePreview ?? ""))
      .join("\n")
    expect(preview).toContain("<redacted>")
    expect(preview).not.toContain("do_work(secret);")
  })

  test("falls back once when response_format is rejected by the provider", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const requestBodies: Record<string, unknown>[] = []
    let requestCount = 0
    const baseUrl = await listen(async (request, response) => {
      requestBodies.push(await readRequestJson(request))
      requestCount += 1
      if (requestCount === 1) {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "unknown field response_format" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "{\"proposals\":[]}" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]?.response_format).toEqual({ type: "json_object" })
    expect(requestBodies[1]?.response_format).toBeUndefined()
    expect(requestBodies[0]?.max_tokens).toBeUndefined()
    expect(requestBodies[1]?.max_tokens).toBeUndefined()
    expect(events.some((event) => event.stage === "model.http.response_format.fallback")).toBe(true)
    expect(events.find((event) => event.stage === "model.http.response_format.fallback")?.fields).toMatchObject({
      responseStatus: 400,
      responseFormat: "json_object",
      responseFormatFallback: true,
    })
    expect(events.filter((event) => event.stage === "model.http.prepare").map((event) => event.fields?.responseFormat)).toEqual([
      "json_object",
      "fallback-disabled",
    ])
    expect(JSON.stringify(requestBodies)).not.toContain("enable_thinking")
    expect(JSON.stringify(requestBodies)).not.toContain("thinking_token_budget")
    expect(JSON.stringify(requestBodies)).not.toContain("chat_template_kwargs")
  })

  test("reports usageAvailable false when the stream has no usage chunk", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "{\"proposals\":[]}" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(result.tokenUsage).toEqual({ usageAvailable: false })
    expect(events.find((event) => event.stage === "model.http.stream.done")?.fields).toMatchObject({
      usageAvailable: false,
    })
  })

  test("strips a complete markdown json fence after visible thinking", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "<think>短思考。</think>\n\n```json\n" } }] }),
        sse({ choices: [{ delta: { content: "{\"proposals\":[]}\n```" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(parseCommentProposalResponse(result.text)).toMatchObject({ ok: true, proposals: [] })
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      thinkingBudget: "disabled",
      strippedThinkBlockCount: 1,
      openThinking: false,
      jsonFenceStripped: true,
      jsonFenceLanguage: "json",
      normalizedTextBytes: 16,
    })
    expect(events.some((event) => event.stage === "model.stream.delta" && String(event.fields?.reasoningPreview ?? "").includes("短思考"))).toBe(true)
    expect(JSON.stringify(events.filter((event) => event.stage !== "model.stream.delta"))).not.toContain("短思考")
  })

  test("strips a complete markdown fence without a language label", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "```\n{\"proposals\":[]}\n```" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      jsonFenceStripped: true,
      jsonFenceLanguage: "none",
      normalizedTextBytes: 16,
    })
  })

  test("fails fast when explanatory text appears before fenced JSON", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "下面是结果：\n```json\n{\"proposals\":[]}\n```" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    let error: unknown
    try {
      await client.generate("comment me", undefined, 1000, (event) => events.push(event))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(CommentLLMGenerationError)
    expect((error as CommentLLMGenerationError).terminalReason).toBe("model-non-json-prefix")
    expect(events.find((event) => event.stage === "model.response.normalize")).toBeUndefined()
    expect(events.find((event) => event.stage === "model.http.error")).toBeUndefined()
  })

  test("does not strip multiple fenced blocks as JSON", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "```json\n{\"proposals\":[]}\n```\n```json\n{\"proposals\":[]}\n```" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(parseCommentProposalResponse(result.text).ok).toBe(false)
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      jsonFenceStripped: false,
      jsonFenceLanguage: "json",
    })
  })

  test("does not strip fenced non-json content", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "```json\nnot json\n```" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(parseCommentProposalResponse(result.text)).toEqual({
      ok: false,
      reason: "不允许 markdown code fence",
    })
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      jsonFenceStripped: false,
      jsonFenceLanguage: "json",
    })
  })

  test("drops structured reasoning_content while keeping final JSON content", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { reasoning_content: "分析选区。" } }] }),
        sse({ choices: [{ delta: { content: "{\"proposals\":[]}" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      reasoningDeltaCount: 1,
      structuredReasoningBytes: 15,
      strippedThinkBlockCount: 0,
      jsonFenceStripped: false,
      normalizedTextBytes: 16,
    })
    expect(events.some((event) => event.stage === "model.stream.delta" && String(event.fields?.reasoningPreview ?? "").includes("分析选区"))).toBe(true)
    expect(JSON.stringify(events.filter((event) => event.stage !== "model.stream.delta"))).not.toContain("分析选区")
  })

  test("strips visible think blocks before returning strict JSON", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "<think>先理解代码路径。</think>\n" } }] }),
        sse({ choices: [{ delta: { content: "{\"proposals\":[]}" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text.trim()).toBe("{\"proposals\":[]}")
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      strippedThinkBlockCount: 1,
      openThinking: false,
      jsonFenceStripped: false,
      normalizedTextBytes: 17,
    })
    expect(events.some((event) => event.stage === "model.stream.delta" && String(event.fields?.reasoningPreview ?? "").includes("先理解代码路径"))).toBe(true)
    expect(JSON.stringify(events.filter((event) => event.stage !== "model.stream.delta"))).not.toContain("先理解代码路径")
  })

  test("strips think tags even when the tag spans multiple chunks", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "<thi" } }] }),
        sse({ choices: [{ delta: { content: "nk>跨 chunk thinking</thi" } }] }),
        sse({ choices: [{ delta: { content: "nk>{\"proposals\":[]}" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    const result = await client.generate("comment me", undefined, 1000, (event) => events.push(event))

    expect(result.text).toBe("{\"proposals\":[]}")
    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      strippedThinkBlockCount: 1,
      openThinking: false,
      jsonFenceStripped: false,
      normalizedTextBytes: 16,
    })
    expect(events.some((event) => event.stage === "model.stream.delta" && String(event.fields?.reasoningPreview ?? "").includes("跨 chunk thinking"))).toBe(true)
    expect(JSON.stringify(events.filter((event) => event.stage !== "model.stream.delta"))).not.toContain("跨 chunk thinking")
  })

  test("rejects unclosed thinking output that is truncated by the model", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "<think>一直在分析，没有最终 JSON" }, finish_reason: "length" }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    await expect(client.generate("comment me", undefined, 1000, (event) => events.push(event))).rejects.toThrow("模型输出停留在 thinking 内容中，未返回完整 JSON。")

    expect(events.find((event) => event.stage === "model.response.normalize")?.fields).toMatchObject({
      strippedThinkBlockCount: 1,
      openThinking: true,
      normalizedTextBytes: 0,
      finishReason: "length",
    })
    expect(events.find((event) => event.stage === "model.http.error")).toBeUndefined()
    expect(events.some((event) => event.stage === "model.stream.delta" && String(event.fields?.reasoningPreview ?? "").includes("一直在分析"))).toBe(true)
    expect(JSON.stringify(events.filter((event) => event.stage !== "model.stream.delta"))).not.toContain("一直在分析")
  })

  test("logs non-2xx response metadata without leaking prompt or url", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "server busy" }))
    })
    const client = new CommentLLMClient({
      getSettings: () => settings(`${baseUrl}/v1`),
      getApiKey: async () => "private-token",
    })

    await expect(client.generate("secret selected code", undefined, 1000, (event) => events.push(event))).rejects.toThrow("注释生成失败: 503")

    expect(events.find((event) => event.stage === "model.http.response.headers")?.fields).toMatchObject({
      responseStatus: 503,
      responseContentType: "application/json",
    })
    expect(events.find((event) => event.stage === "model.http.response.body")?.fields?.responseBytes).toBeGreaterThan(0)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(baseUrl)
    expect(serialized).not.toContain("secret selected code")
    expect(serialized).not.toContain("private-token")
  })

  test("logs network error cause metadata", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const originalFetch = globalThis.fetch
    const cause = new Error("connect ETIMEDOUT 10.0.0.1")
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause })
    }) as typeof fetch
    try {
      const client = new CommentLLMClient({
        getSettings: () => settings("http://provider.internal/v1"),
        getApiKey: async () => "",
      })

      await expect(client.generate("comment network", undefined, 1000, (event) => events.push(event))).rejects.toThrow("注释生成请求失败: fetch failed")
    } finally {
      globalThis.fetch = originalFetch
    }

    const error = events.find((event) => event.stage === "model.http.error")
    expect(error?.fields).toMatchObject({
      lastStage: "model.http.fetch.start",
      responseHeadersReceived: false,
      firstChunkReceived: false,
      errorName: "TypeError",
      errorMessage: "fetch failed",
      errorCauseName: "Error",
      errorCauseMessage: "connect ETIMEDOUT 10.0.0.1",
    })
    expect(JSON.stringify(events)).not.toContain("comment network")
    expect(JSON.stringify(events)).not.toContain("provider.internal")
  })

  test("rejects streaming responses that close without a completion marker", async () => {
    const events: CommentLLMDiagnosticEvent[] = []
    const baseUrl = await listen((_request, response) => {
      const body = sse({ choices: [{ delta: { content: "{\"proposals\":[]}" } }] })
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": Buffer.byteLength(body).toString(),
      })
      response.end(body)
    }, { forceClose: false })
    const client = new CommentLLMClient({
      getSettings: () => settings(baseUrl),
      getApiKey: async () => "",
    })

    let thrown: unknown
    try {
      await client.generate("comment me", undefined, 1000, (event) => events.push(event))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/注释生成请求失败: (注释生成流结束前未收到完成标记。|The socket connection was closed unexpectedly)/)
    const error = events.find((event) => event.stage === "model.http.error")
    expect(error).toBeDefined()
    if (events.some((event) => event.stage === "model.http.stream.done")) {
      expect(error?.fields).toMatchObject({
        lastStage: "model.http.stream.done",
        responseHeadersReceived: true,
        firstChunkReceived: true,
      })
    } else {
      expect(error?.fields).toMatchObject({
        responseHeadersReceived: false,
        firstChunkReceived: false,
      })
    }
    expect(JSON.stringify(events)).not.toContain("comment me")
  })
})

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function readRequestJson(request: http.IncomingMessage) {
  let body = ""
  for await (const chunk of request) body += chunk
  return JSON.parse(body) as Record<string, unknown>
}

async function listen(handler: http.RequestListener, options: { forceClose?: boolean } = {}) {
  const server = http.createServer((request, response) => {
    if (options.forceClose !== false) response.setHeader("connection", "close")
    handler(request, response)
  })
  if (options.forceClose !== false) server.keepAliveTimeout = 1
  server.on("connection", (socket) => {
    sockets.push(socket)
    socket.on("close", () => {
      sockets = sockets.filter((item) => item !== socket)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server address unavailable")
  return `http://127.0.0.1:${address.port}`
}

function settings(baseUrl: string) {
  return {
    provider: {
      apiBaseUrl: baseUrl,
      chatModel: "qwen",
      maxTokens: 4096,
      temperature: 0.2,
      topP: 1,
    },
  } as never
}
