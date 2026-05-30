import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { buildCodeGraphContext, classifyQuestion, extractSymbols } from "../src/codegraph-query"
import type { CodeGraphIndex } from "../src/codegraph-types"

describe("code graph query context", () => {
  test("classifies common code graph questions", () => {
    expect(classifyQuestion("谁调用了 nand_read_page")).toBe("callers")
    expect(classifyQuestion("show call chain from submit_io to nand_read_page")).toBe("call-chain")
    expect(classifyQuestion("改 ecc_check 会影响哪里")).toBe("impact")
    expect(classifyQuestion("给我一个模块架构概览")).toBe("overview")
    expect(classifyQuestion("nand_read_page 调用了谁")).toBe("callees")
  })

  test("extracts C identifiers from mixed language questions", () => {
    expect(extractSymbols("谁调用了 `nand_read_page` and ecc_check?")).toContain("nand_read_page")
    expect(extractSymbols("谁调用了 `nand_read_page` and ecc_check?")).toContain("ecc_check")
  })

  test("builds dynamic caller context without dumping the whole index", () => {
    const index = sampleIndex()
    const context = buildCodeGraphContext({
      index,
      question: "谁调用了 nand_read_page",
      maxBytes: 12000,
    })

    expect(context?.mode).toBe("callers")
    expect(context?.text).toContain("<local-code-graph")
    expect(context?.text).toContain("<query-plan")
    expect(context?.text).toContain('<symbol name="nand_read_page"')
    expect(context?.text).toContain("<callers>")
    expect(context?.text).toContain('name="storage_boot"')
    expect(context?.text).toContain("<evidence>")
    expect(context?.text).not.toContain("unused_helper")
  })

  test("builds call chain context when source and target are present", () => {
    const context = buildCodeGraphContext({
      index: sampleIndex(),
      question: "show call chain from storage_boot to ecc_check",
      maxBytes: 12000,
    })

    expect(context?.mode).toBe("call-chain")
    expect(context?.text).toContain("<call-chain>")
    expect(context?.text).toContain('name="storage_boot"')
    expect(context?.text).toContain('name="nand_read_page"')
    expect(context?.text).toContain('name="ecc_check"')
  })

  test("builds impact context through transitive callers", () => {
    const context = buildCodeGraphContext({
      index: sampleIndex(),
      question: "改 ecc_check 会影响哪里",
      maxBytes: 12000,
    })

    expect(context?.mode).toBe("impact")
    expect(context?.text).toContain("<impact-callers>")
    expect(context?.text).toContain('name="nand_read_page"')
    expect(context?.text).toContain('name="storage_boot"')
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
int ecc_check(void) { return 0; }
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
