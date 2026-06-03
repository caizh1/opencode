import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import {
  checkRagEndpoint,
  createHttpEmbeddingProvider,
  createHttpRerankProvider,
  normalizeEmbeddingResponse,
  normalizeRerankResponse,
  probeRagRerankProvider,
  type RagHttpDiagnosticEvent,
} from "../src/rag-provider"
import type { RagSettings } from "../src/types"

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

describe("offline RAG HTTP provider policy", () => {
  test("allows localhost, private LAN, and explicit allowlist hosts", () => {
    expect(checkRagEndpoint("http://127.0.0.1:8000/v1/embeddings").kind).toBe("localhost")
    expect(checkRagEndpoint("http://192.168.1.20:8000/v1/embeddings").kind).toBe("private-lan")
    expect(checkRagEndpoint("https://rag.internal/v1/embeddings", ["rag.internal"]).kind).toBe("approved-host")
  })

  test("blocks public endpoints before fetch", () => {
    const result = checkRagEndpoint("https://api.openai.com/v1/embeddings")
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("blocked")
    expect(result.reason).toContain("allowedHosts")
  })

  test("derives configured providers from endpoints instead of manual enabled flags", () => {
    const settings = ragSettings()
    expect(createHttpEmbeddingProvider(settings)?.id).toContain("localhost")
    expect(createHttpRerankProvider(settings)?.id).toContain("localhost")
  })

  test("rejects embedding providers when batch size configuration is invalid", () => {
    const settings = ragSettings()
    settings.embedding.configError = "Embedding batch size must be one of 32, 64, 128, 256, or 512."

    expect(() => createHttpEmbeddingProvider(settings)).toThrow("Embedding batch size must be one of 32, 64, 128, 256, or 512.")
  })

  test("sends optional bearer API keys to embedding and rerank endpoints", async () => {
    const captured: string[] = []
    const baseUrl = await listen((request, response) => {
      captured.push(request.headers.authorization ?? "")
      if (request.url === "/v1/embeddings") {
        json(response, 200, { data: [{ embedding: [1, 0, 0] }] })
        return
      }
      json(response, 200, { results: [{ index: 0, relevance_score: 0.8 }] })
    })
    const settings = ragSettings(`${baseUrl}/v1/embeddings`, `${baseUrl}/rerank`)

    await createHttpEmbeddingProvider(settings, "secret")?.embed(["query"])
    await createHttpRerankProvider(settings, "secret")?.rerank({ query: "q", documents: ["doc"], topN: 1 })

    expect(captured).toEqual(["Bearer secret", "Bearer secret"])
  })

  test("omits embedding dimensions and sends one request per embed call", async () => {
    let requests = 0
    let body: Record<string, unknown> | undefined
    const baseUrl = await listen((request, response) => {
      requests++
      let raw = ""
      request.on("data", (chunk) => {
        raw += chunk
      })
      request.on("end", () => {
        body = JSON.parse(raw)
        json(response, 200, {
          data: [
            { embedding: [1, 0, 0] },
            { embedding: [0, 1, 0] },
          ],
        })
      })
    })

    await createHttpEmbeddingProvider(ragSettings(`${baseUrl}/v1/embeddings`))?.embed(["query one", "query two"])

    expect(requests).toBe(1)
    expect(body?.input).toEqual(["query one", "query two"])
    expect(body).not.toHaveProperty("dimensions")
  })

  test("omits authorization when RAG API key is empty", async () => {
    let auth: string | undefined
    const baseUrl = await listen((request, response) => {
      auth = request.headers.authorization
      json(response, 200, { data: [{ embedding: [1, 0, 0] }] })
    })

    await createHttpEmbeddingProvider(ragSettings(`${baseUrl}/v1/embeddings`), "")?.embed(["query"])

    expect(auth).toBeUndefined()
  })

  test("reports sanitized embedding HTTP diagnostics", async () => {
    const events: RagHttpDiagnosticEvent[] = []
    const baseUrl = await listen((request, response) => {
      json(response, 200, {
        data: [
          { embedding: [1, 0, 0] },
          { embedding: [0, 1, 0] },
        ],
      })
    })
    const provider = createHttpEmbeddingProvider(ragSettings(`${baseUrl}/v1/embeddings`), "secret-key", (event) => events.push(event))

    await provider?.embed(["query one", "query two"])

    expect(events[0]).toMatchObject({
      phase: "request",
      kind: "embedding",
      method: "POST",
      endpoint: `${baseUrl}/v1/embeddings`,
      model: "local-embedding",
      inputCount: 2,
      batchSize: 128,
      timeoutMs: 30000,
      authorizationPresent: true,
    })
    expect(events[0]?.apiKeyFingerprint).toMatch(/^sha256:[a-f0-9]{8} len=10$/)
    expect(events[1]).toMatchObject({
      phase: "response",
      kind: "embedding",
      status: 200,
      ok: true,
    })
    expect(JSON.stringify(events)).not.toContain("secret-key")
  })

  test("reports sanitized failure diagnostics for rejected embedding requests", async () => {
    const events: RagHttpDiagnosticEvent[] = []
    const baseUrl = await listen((request, response) => {
      json(response, 401, { error: "invalid token" })
    })
    const provider = createHttpEmbeddingProvider(ragSettings(`${baseUrl}/v1/embeddings`), "bad-secret", (event) => events.push(event))

    await expect(provider!.embed(["query"])).rejects.toThrow(/401 Unauthorized:.*invalid token/)

    const response = events.find((event) => event.phase === "response")
    expect(response).toMatchObject({
      phase: "response",
      kind: "embedding",
      status: 401,
      ok: false,
      errorPreview: '{"error":"invalid token"}',
    })
    expect(JSON.stringify(events)).not.toContain("bad-secret")
  })

  test("probes rerank providers with a real authenticated request", async () => {
    let auth: string | undefined
    let body: Record<string, unknown> | undefined
    const baseUrl = await listen((request, response) => {
      auth = request.headers.authorization
      let raw = ""
      request.on("data", (chunk) => {
        raw += chunk
      })
      request.on("end", () => {
        body = JSON.parse(raw) as Record<string, unknown>
        json(response, 200, { results: [{ index: 0, relevance_score: 0.9 }] })
      })
    })
    const provider = createHttpRerankProvider(ragSettings(undefined, `${baseUrl}/rerank`), "secret")

    await expect(probeRagRerankProvider(provider!)).resolves.toEqual({ index: 0, score: 0.9 })

    expect(auth).toBe("Bearer secret")
    expect(body?.query).toContain("rerank connectivity probe")
    expect(body?.top_n).toBe(1)
    expect(body?.documents).toHaveLength(2)
  })

  test("fails rerank probes when the endpoint rejects the shared token", async () => {
    const baseUrl = await listen((request, response) => {
      json(response, 401, { error: "invalid token" })
    })
    const provider = createHttpRerankProvider(ragSettings(undefined, `${baseUrl}/rerank`), "bad-token")

    await expect(probeRagRerankProvider(provider!)).rejects.toThrow(/401 Unauthorized:.*invalid token/)
  })

  test("fails rerank probes when the response has no valid score", async () => {
    const baseUrl = await listen((request, response) => {
      json(response, 200, { results: [{ id: "missing-score" }] })
    })
    const provider = createHttpRerankProvider(ragSettings(undefined, `${baseUrl}/rerank`), "secret")

    await expect(probeRagRerankProvider(provider!)).rejects.toThrow("rerank provider returned no probe result")
  })

  test("normalizes embedding and rerank responses", () => {
    expect(normalizeEmbeddingResponse({
      data: [
        { embedding: [1, 0, 0] },
        { embedding: [0, 1, 0] },
      ],
    }, 2)).toEqual([[1, 0, 0], [0, 1, 0]])

    expect(normalizeRerankResponse({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    }, 2)).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ])
  })
})

function ragSettings(embeddingEndpoint = "http://127.0.0.1:8000/v1/embeddings", rerankEndpoint = "http://127.0.0.1:8000/rerank"): RagSettings {
  return {
    embedding: {
      enabled: false,
      endpoint: embeddingEndpoint,
      model: "local-embedding",
      batchSize: 128,
      maxTokensPerRequest: 65536,
      checkpointMode: "interval",
      checkpointChunkInterval: 8192,
      checkpointIntervalMs: 120000,
      timeoutMs: 30000,
      requestDelayMs: 500,
      maxRequestsPerRun: 100,
      maxRetries: 3,
      retryBackoffMs: 2000,
      resumeAutomatically: true,
      resumeDelayMs: 60000,
    },
    rerank: {
      enabled: false,
      endpoint: rerankEndpoint,
      model: "local-rerank",
    },
    allowedHosts: [],
    vectorTopK: 24,
    rerankTopK: 16,
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
