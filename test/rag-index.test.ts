import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { buildRagChunks, buildRagVectorIndex, decodeRagShardVectors, encodeRagShardVectors, searchRagVectorIndex, splitRagVectorIndex } from "../src/rag-index"
import type { CodeGraphIndex } from "../src/codegraph-types"
import type { EmbeddingProvider } from "../src/rag-types"

describe("local RAG vector index", () => {
  test("builds chunks, embeds vectors, searches, and serializes shard vectors", async () => {
    const index = sampleIndex()
    const chunks = buildRagChunks(index)
    expect(chunks.some((chunk) => chunk.kind === "function" && chunk.text.includes("nand_read_page"))).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === "module-summary")).toBe(true)

    const vectorIndex = await buildRagVectorIndex({ index, provider: fakeEmbeddingProvider() })
    expect(vectorIndex.chunks.length).toBe(chunks.length)
    expect(vectorIndex.dimension).toBe(3)

    const hits = searchRagVectorIndex(vectorIndex, embedText("flash page read"), 3)
    expect(hits.some((hit) => hit.chunk.text.includes("nand_read_page"))).toBe(true)

    const shard = splitRagVectorIndex(vectorIndex)[0]
    const encoded = encodeRagShardVectors(shard.vectors, vectorIndex.dimension)
    expect(decodeRagShardVectors(encoded, vectorIndex.dimension)).toHaveLength(shard.vectors.length)
  })

  test("reuses unchanged chunk vectors during incremental rebuilds", async () => {
    const index = sampleIndex()
    const provider = countingEmbeddingProvider()
    const first = await buildRagVectorIndex({ index, provider })
    const second = await buildRagVectorIndex({
      index,
      provider,
      previous: first,
      changedPaths: ["boot/storage.c"],
    })

    expect(second.chunks.length).toBe(first.chunks.length)
    expect(provider.calls).toBeLessThan(first.chunks.length + second.chunks.length)
  })
})

function sampleIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/nand/nand.c",
      hash: "nand",
      size: 1,
      text: `
int ecc_check(void) { return 0; }
int nand_read_page(void) { return ecc_check(); }
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "storage",
      size: 1,
      text: "int storage_boot(void) { return nand_read_page(); }",
    }),
  ]
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  }
}

function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "fake",
    model: "fake",
    embed: async (input) => input.map(embedText),
  }
}

function countingEmbeddingProvider(): EmbeddingProvider & { calls: number } {
  return {
    ...fakeEmbeddingProvider(),
    calls: 0,
    async embed(input) {
      this.calls += input.length
      return input.map(embedText)
    },
  }
}

function embedText(text: string) {
  const lower = text.toLowerCase()
  return normalize([
    /nand|flash|page|ecc/.test(lower) ? 1 : 0,
    /storage|boot/.test(lower) ? 1 : 0,
    /module|file/.test(lower) ? 1 : 0,
  ])
}

function normalize(values: number[]) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1
  return values.map((value) => value / norm)
}
