import { describe, expect, test } from "bun:test"
import { buildDerivedIndex, groupFilesByShard, hydrateCodeGraphIndex } from "../src/codegraph-index"
import { parseCFile } from "../src/codegraph-c-parser"
import type { CodeGraphFile } from "../src/codegraph-types"

describe("code graph derived index", () => {
  test("builds symbol, caller, include, and directory indexes", () => {
    const files = sampleFiles()
    const derived = buildDerivedIndex(files)

    expect(derived.functionIdsByName.nand_read_page).toEqual(["drivers/nand/nand.c:nand_read_page:4"])
    expect(derived.callerIdsByCallee.ecc_check).toEqual(["drivers/nand/nand.c:nand_read_page:4"])
    expect(derived.filePathsByInclude["nand.h"]).toEqual(["boot/storage.c", "drivers/nand/nand.c"])
    expect(derived.directoryStats["drivers/nand"].functions).toBe(2)
  })

  test("hydrates legacy indexes with version two metadata", () => {
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files: sampleFiles(),
    })

    expect(index.version).toBe(2)
    expect(index.derived?.functionIdsByName.storage_boot).toEqual(["boot/storage.c:storage_boot:3"])
    expect(index.stats?.files).toBe(2)
    expect(index.stats?.shards).toBe(2)
  })

  test("groups files into stable directory shards", () => {
    const groups = groupFilesByShard(sampleFiles())

    expect([...groups.keys()].sort()).toEqual(["boot", "drivers/nand"])
  })
})

function sampleFiles(): Record<string, CodeGraphFile> {
  const files = [
    parseCFile({
      path: "drivers/nand/nand.c",
      hash: "1",
      size: 10,
      text: `
#include "nand.h"
int ecc_check(void) { return 0; }
int nand_read_page(void) { return ecc_check(); }
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "2",
      size: 20,
      text: `
#include "nand.h"
int storage_boot(void) { return nand_read_page(); }
`,
    }),
  ]
  return Object.fromEntries(files.map((file) => [file.path, file]))
}
