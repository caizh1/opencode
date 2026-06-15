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
    expect(derived.symbolsByName.nand_read_page[0].kind).toBe("function")
    expect(derived.postingsByTerm.nand.some((posting) => posting.path === "drivers/nand/nand.c")).toBe(true)
    expect(derived.moduleStats["drivers/nand"].hotSymbols).toContain("ecc_check")
  })

  test("handles prototype-named symbols without inherited object collisions", () => {
    const files = prototypeNamedFiles()
    const derived = buildDerivedIndex(files)

    expect(derived.functionIdsByName["constructor"]).toEqual(["drivers/prototype.c:constructor:2"])
    expect(derived.functionIdsByName["__proto__"]).toEqual(["drivers/prototype.c:__proto__:3"])
    expect(derived.functionIdsByName["toString"]).toEqual(["drivers/prototype.c:toString:4"])
    expect(derived.callerIdsByCallee["constructor"]).toEqual(["drivers/prototype.c:__proto__:3"])
    expect(derived.callerIdsByCallee["toString"]).toEqual(["drivers/prototype.c:caller:5"])
    expect(derived.filePathsByInclude["constructor"]).toEqual(["drivers/prototype.c"])
    expect(derived.symbolsByName["constructor"][0].kind).toBe("function")
    expect(derived.postingsByTerm["constructor"].some((posting) => posting.path === "drivers/prototype.c")).toBe(true)

    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files,
    })

    expect(index.derived?.functionIdsByName["constructor"]).toEqual(["drivers/prototype.c:constructor:2"])
    expect(index.derived?.callerIdsByCallee["toString"]).toEqual(["drivers/prototype.c:caller:5"])
  })

  test("hydrates legacy indexes with current version metadata", () => {
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files: sampleFiles(),
    })

    expect(index.version).toBe(9)
    expect(index.derived?.functionIdsByName.storage_boot).toEqual(["boot/storage.c:storage_boot:3"])
    expect(index.derived?.symbolsByName.storage_boot[0].kind).toBe("function")
    expect(index.stats?.files).toBe(2)
    expect(index.stats?.shards).toBe(2)
    expect(index.stats?.types).toBe(0)
  })

  test("hydrates version two files without current fields", () => {
    const [path, file] = Object.entries(sampleFiles())[0]
    const legacyFile = { ...file }
    delete (legacyFile as Partial<CodeGraphFile>).types
    delete (legacyFile as Partial<CodeGraphFile>).globals
    delete (legacyFile as Partial<CodeGraphFile>).tokens

    const index = hydrateCodeGraphIndex({
      version: 2,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files: { [path]: legacyFile as CodeGraphFile },
    })

    expect(index.version).toBe(9)
    expect(index.files[path].tokens.length).toBeGreaterThan(0)
    expect(index.derived?.postingsByTerm.nand.length).toBeGreaterThan(0)
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

function prototypeNamedFiles(): Record<string, CodeGraphFile> {
  const file = parseCFile({
    path: "drivers/prototype.c",
    hash: "proto",
    size: 10,
    text: `#include "constructor"
int constructor(void) { return 0; }
int __proto__(void) { return constructor(); }
int toString(void) { return __proto__(); }
int caller(void) { return toString(); }
`,
  })
  return { [file.path]: file }
}
