import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { CodeGraphHotCache, planShardKeysForQuery } from "../src/codegraph-shard-planner"

describe("code graph shard planner and hot cache", () => {
  test("selects query-relevant shards from symbols, postings, and related paths", () => {
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files: Object.fromEntries([
        parseCFile({
          path: "drivers/nand/nand.c",
          hash: "1",
          size: 1,
          text: "int ecc_check(void) { return 0; }\nint nand_read_page(void) { return ecc_check(); }\n",
        }),
        parseCFile({
          path: "boot/storage.c",
          hash: "2",
          size: 1,
          text: "int storage_boot(void) { return nand_read_page(); }\n",
        }),
      ].map((file) => [file.path, file])),
    })

    const plan = planShardKeysForQuery({
      index: { ...index, storageMode: "sharded", stats: { ...index.stats!, shards: 20 } },
      question: "who calls nand_read_page",
      relatedPaths: ["boot/storage.c"],
      maxShards: 1,
    })

    expect(plan.shardKeys).toEqual(["boot"])
    expect(plan.candidatePaths).toContain("boot/storage.c")
    expect(plan.lazy).toBe(true)
  })

  test("keeps only hot cache entries within the configured size", () => {
    const cache = new CodeGraphHotCache<string, number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)

    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("c")).toBe(3)
  })
})
