import { describe, expect, test } from "bun:test"
import { checkRagEndpoint, normalizeEmbeddingResponse, normalizeRerankResponse } from "../src/rag-provider"

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
