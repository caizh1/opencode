import { describe, expect, test } from "bun:test"
import { DocumentRagWorkerPool } from "../src/document-rag-worker-host"

describe("Document RAG worker pool", () => {
  test("parses documents through worker pool or fallback parser", async () => {
    const pool = new DocumentRagWorkerPool()
    try {
      const status = await pool.health(2)
      const parsed = await pool.parseDocument({
        path: "docs/spec.txt.pdf",
        bytes: new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT (Document RAG worker text) Tj ET\nendstream\nendobj\n%%EOF\n"),
        maxBytes: 4096,
      }, 2)

      expect(status.workers).toBeGreaterThanOrEqual(0)
      expect(parsed?.kind).toBe("pdf")
      expect(parsed?.text.length).toBeGreaterThan(0)
    } finally {
      pool.dispose()
    }
  })
})
