import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("code graph RAG configuration validation", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "codegraph-service.ts"), "utf8")

  test("blocks invalid embedding batch size before provider creation and indexing", () => {
    expect(source).toContain("private async ragEmbeddingConfigErrorStatus")
    expect(source).toContain("if (settings.embedding.configError) {")
    expect(source).toContain("return this.ragEmbeddingConfigErrorStatus(settings)")
    expect(source).toContain("this.setRagStatus(await this.ragEmbeddingConfigErrorStatus(settings))")
    expect(source.indexOf("if (settings.embedding.configError) {")).toBeLessThan(source.indexOf("createHttpEmbeddingProvider(settings"))
    expect(source).toContain("lastError: message")
    expect(source).toContain("fallbackReason: message")
  })
})
