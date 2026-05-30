import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { buildCodeGraphContext, classifyQuestion, extractSymbols, retrieveEvidence } from "../src/codegraph-query"
import type { CodeGraphIndex } from "../src/codegraph-types"

describe("code graph query context", () => {
  test("classifies common Chinese and English code graph questions", () => {
    expect(classifyQuestion("谁调用了 nand_read_page")).toBe("callers")
    expect(classifyQuestion("nand_read_page 调用了谁")).toBe("callees")
    expect(classifyQuestion("show call chain from submit_io to nand_read_page")).toBe("call-chain")
    expect(classifyQuestion("改 ecc_check 会影响哪里")).toBe("impact")
    expect(classifyQuestion("给我一个 nand 模块架构概览")).toBe("overview")
  })

  test("extracts C identifiers from mixed language questions", () => {
    expect(extractSymbols("谁调用了 `nand_read_page` and ecc_check?")).toContain("nand_read_page")
    expect(extractSymbols("谁调用了 “nand_read_page” and ecc_check?")).toContain("nand_read_page")
    expect(extractSymbols("谁调用了 `nand_read_page` and ecc_check?")).toContain("ecc_check")
  })

  test("retrieves function definition, callers, callees, and evidence without dumping the whole index", () => {
    const result = retrieveEvidence({
      index: sampleIndex(),
      question: "解释 nand_read_page",
      maxBytes: 12000,
      maxDepth: 2,
      maxFanout: 20,
    })

    expect(result?.mode).toBe("explain")
    expect(result?.symbols).toContain("nand_read_page")
    expect(result?.candidateCount).toBeGreaterThanOrEqual(result?.evidence.length ?? 0)
    expect(result?.packedBytes).toBeGreaterThan(0)
    expect(result?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result?.evidence.some((item) => item.path === "drivers/nand/nand.c" && item.snippet.includes("nand_read_page"))).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("caller") && item.snippet.includes("storage_boot"))).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("callee") && item.snippet.includes("ecc_check"))).toBe(true)
    expect(result?.evidence.some((item) => item.snippet.includes("unused_helper"))).toBe(false)
  })

  test("queries prototype-named symbols without inherited object collisions", () => {
    const result = retrieveEvidence({
      index: prototypeNamedIndex(),
      question: "who calls constructor",
      maxBytes: 12000,
      maxDepth: 2,
      maxFanout: 20,
    })

    expect(result?.symbols).toContain("constructor")
    expect(result?.evidence.some((item) => item.reason.includes("caller") && item.snippet.includes("__proto__"))).toBe(true)

    const context = buildCodeGraphContext({
      index: prototypeNamedIndex(),
      question: "who calls constructor",
      maxBytes: 12000,
      maxDepth: 2,
      maxFanout: 20,
    })
    expect(context?.text).toContain("__proto__")

    expect(() =>
      retrieveEvidence({
        index: sampleIndex(),
        question: "explain constructor",
        maxBytes: 12000,
        maxDepth: 2,
        maxFanout: 20,
      }),
    ).not.toThrow()
  })

  test("builds evidence-formatted prompt context with metrics", () => {
    const context = buildCodeGraphContext({
      index: sampleIndex(),
      question: "谁调用了 nand_read_page",
      maxBytes: 12000,
      maxDepth: 2,
      maxFanout: 20,
    })

    expect(context?.mode).toBe("callers")
    expect(context?.metrics.mode).toBe("callers")
    expect(context?.metrics.evidenceCount).toBeGreaterThan(0)
    expect(context?.text).toContain("<local-code-graph")
    expect(context?.text).toContain('candidates="')
    expect(context?.text).toContain("<evidence-list>")
    expect(context?.text).toContain('path="drivers/nand/nand.c"')
    expect(context?.text).toContain('path="boot/storage.c"')
    expect(context?.text).toContain("Cite file paths and line ranges")
  })

  test("builds call chain context when source and target are present", () => {
    const context = buildCodeGraphContext({
      index: sampleIndex(),
      question: "show call chain from storage_boot to ecc_check",
      maxBytes: 12000,
      maxDepth: 4,
      maxFanout: 20,
    })

    expect(context?.mode).toBe("call-chain")
    expect(context?.text).toContain("call-chain step 1")
    expect(context?.text).toContain("storage_boot")
    expect(context?.text).toContain("nand_read_page")
    expect(context?.text).toContain("ecc_check")
  })

  test("builds impact context through bounded transitive callers", () => {
    const context = buildCodeGraphContext({
      index: sampleIndex(),
      question: "改 ecc_check 会影响哪里",
      maxBytes: 12000,
      maxDepth: 3,
      maxFanout: 20,
    })

    expect(context?.mode).toBe("impact")
    expect(context?.text).toContain("transitive caller")
    expect(context?.text).toContain("nand_read_page")
    expect(context?.text).toContain("storage_boot")
  })

  test("retrieves modules and text matches from paths, macros, and comments", () => {
    const result = retrieveEvidence({
      index: sampleIndex(),
      question: "nand 模块 ECC configuration 概览",
      maxBytes: 12000,
      maxDepth: 2,
      maxFanout: 20,
    })

    expect(result?.mode).toBe("overview")
    expect(result?.evidence.some((item) => item.kind === "module" && item.path === "drivers/nand")).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("macro:ecc"))).toBe(true)
    expect(result?.evidence.some((item) => item.reason.includes("comment:configuration"))).toBe(true)
  })

  test("marks evidence packing as truncated when byte budget is small", () => {
    const result = retrieveEvidence({
      index: sampleIndex(),
      question: "解释 nand_read_page",
      maxBytes: 120,
      maxDepth: 2,
      maxFanout: 20,
    })

    expect(result?.truncated).toBe(true)
    expect(result?.omittedCandidates).toBeGreaterThan(0)
  })
})

function sampleIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/nand/nand.c",
      hash: "1",
      size: 1,
      text: `
#include "nand.h"
#define ECC_CONFIGURATION 1
typedef unsigned int nand_page_t;
struct nand_chip { int ready; };
int ecc_check(void) { return 0; }
// ECC configuration flow for nand page reads.
int nand_read_page(void) { return ecc_check(); }
int unused_helper(void) { return 1; }
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "2",
      size: 1,
      text: `
#include "nand.h"
int storage_boot(void) { return nand_read_page(); }
`,
    }),
    parseCFile({
      path: "drivers/nand/nand_extra.c",
      hash: "3",
      size: 1,
      text: `
#include "nand.h"
int nand_extra_probe(void) { return 0; }
`,
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

function prototypeNamedIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/prototype.c",
      hash: "proto",
      size: 1,
      text: `#include "constructor"
int constructor(void) { return 0; }
int __proto__(void) { return constructor(); }
int toString(void) { return __proto__(); }
int caller(void) { return toString(); }
`,
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
