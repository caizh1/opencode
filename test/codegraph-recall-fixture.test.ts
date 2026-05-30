import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { retrieveEvidence } from "../src/codegraph-query"
import type { CodeGraphIndex } from "../src/codegraph-types"

describe("code graph recall quality fixture", () => {
  test("finds direct callers", () => {
    const result = retrieveEvidence({
      index: fixtureIndex(),
      question: "谁调用了 nand_read_page",
      maxBytes: 24000,
      maxDepth: 2,
      maxFanout: 40,
    })

    expect(evidenceContains(result, "boot/storage.c", "storage_boot")).toBe(true)
    expect(evidenceContains(result, "kernel/io/writeback.c", "writeback_flush")).toBe(true)
  })

  test("finds callees", () => {
    const result = retrieveEvidence({
      index: fixtureIndex(),
      question: "nand_read_page 调用了谁",
      maxBytes: 24000,
      maxDepth: 2,
      maxFanout: 40,
    })

    expect(evidenceContains(result, "drivers/nand/nand.c", "ecc_check")).toBe(true)
    expect(evidenceContains(result, "drivers/nand/nand.c", "dma_submit")).toBe(true)
  })

  test("finds a call chain", () => {
    const result = retrieveEvidence({
      index: fixtureIndex(),
      question: "show call chain from storage_boot to ecc_check",
      maxBytes: 24000,
      maxDepth: 4,
      maxFanout: 40,
    })

    expect(evidenceContains(result, "boot/storage.c", "storage_boot")).toBe(true)
    expect(evidenceContains(result, "drivers/nand/nand.c", "nand_read_page")).toBe(true)
    expect(evidenceContains(result, "drivers/nand/nand.c", "ecc_check")).toBe(true)
  })

  test("expands impact through transitive callers", () => {
    const result = retrieveEvidence({
      index: fixtureIndex(),
      question: "改 ecc_check 会影响哪里",
      maxBytes: 24000,
      maxDepth: 3,
      maxFanout: 40,
    })

    expect(evidenceContains(result, "drivers/nand/nand.c", "nand_read_page")).toBe(true)
    expect(evidenceContains(result, "boot/storage.c", "storage_boot")).toBe(true)
    expect(evidenceContains(result, "kernel/io/writeback.c", "writeback_flush")).toBe(true)
  })

  test("retrieves module, macro, and comment evidence", () => {
    const result = retrieveEvidence({
      index: fixtureIndex(),
      question: "nand 模块 retry policy wear leveling 概览",
      maxBytes: 24000,
      maxDepth: 2,
      maxFanout: 40,
    })

    expect(result?.evidence.some((item) => item.kind === "module" && item.path === "drivers/nand")).toBe(true)
    expect(evidenceReasonContains(result, "macro:retry")).toBe(true)
    expect(evidenceReasonContains(result, "comment:wear")).toBe(true)
    expect(evidenceContains(result, "drivers/nand/nand.c", "CONFIG_ECC_RETRY")).toBe(true)
  })
})

function evidenceContains(result: ReturnType<typeof retrieveEvidence>, path: string, text: string) {
  return Boolean(result?.evidence.some((item) => item.path === path && item.snippet.includes(text)))
}

function evidenceReasonContains(result: ReturnType<typeof retrieveEvidence>, text: string) {
  return Boolean(result?.evidence.some((item) => item.reason.includes(text)))
}

function fixtureIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/nand/nand.c",
      hash: "nand",
      size: 1,
      text: `
#include "nand.h"
#define CONFIG_ECC_RETRY 3
typedef unsigned int nand_page_t;
struct nand_chip { int ready; };
// wear leveling retry policy for nand page reads
int ecc_check(void) { return CONFIG_ECC_RETRY; }
int dma_submit(void) { return 0; }
int nand_read_page(void) { dma_submit(); return ecc_check(); }
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "storage",
      size: 1,
      text: `
#include "nand.h"
int storage_boot(void) { return nand_read_page(); }
`,
    }),
    parseCFile({
      path: "kernel/io/writeback.c",
      hash: "writeback",
      size: 1,
      text: `
#include "nand.h"
int writeback_flush(void) { return nand_read_page(); }
`,
    }),
    parseCFile({
      path: "drivers/net/ethernet.c",
      hash: "net",
      size: 1,
      text: `
int ethernet_probe(void) { return 0; }
`,
    }),
  ]

  return {
    version: 1,
    rootPath: "/fixture",
    rootName: "fixture",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  }
}
