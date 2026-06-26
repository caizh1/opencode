import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { runAnalysisTool } from "../src/codegraph-analysis"
import { buildCodeGraphContext, classifyQuestion, extractSymbols, retrieveEvidence, searchCodeGraphSymbols } from "../src/codegraph-query"
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

  test("extracts bounded function CFG data for diagram workflows", async () => {
    const result = await runAnalysisTool({
      index: sampleIndex(),
      tool: "getFunctionCfg",
      args: { symbol: "nand_read_page" },
    })

    const data = result.data as { cfg?: { nodes?: Array<{ kind: string }>; edges?: unknown[] } }
    const kinds = data.cfg?.nodes?.map((node) => node.kind) ?? []
    expect(result.ok).toBe(true)
    expect(kinds).toContain("entry")
    expect(kinds).toContain("branch")
    expect(kinds).toContain("call")
    expect(kinds).toContain("return")
    expect(data.cfg?.edges?.length).toBeGreaterThan(0)
    expect(result.evidence[0]?.parserKind).toBe("function-cfg")
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

  test("finds snake-case prefix symbol completions", () => {
    const result = searchCodeGraphSymbols({
      index: eprIndex(),
      query: "epr_ppn_raw_wr",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
      limit: 5,
    })

    expect(result[0]?.name).toBe("epr_ppn_raw_write_with_cb_dfx")
    expect(result[0]?.kind).toBe("function")
    expect(result[0]?.reason).toContain("prefix")
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

  test("retrieves generic C embedded completion evidence by intent", () => {
    const index = completionEvidenceIndex()

    const member = retrieveEvidence({
      index,
      question: [
        "inline completion for c file drivers/uart/uart.c",
        "completion-intent: member-access",
        "member-base: req",
        "member-prefix: sta",
      ].join("\n"),
      maxBytes: 60000,
    })
    expect(member?.evidence.some((item) => item.reason.includes("struct-field") && item.snippet.includes("status"))).toBe(true)

    const callArgs = retrieveEvidence({
      index,
      question: [
        "inline completion for c file drivers/uart/uart.c",
        "completion-intent: call-args",
        "callee: driver_start",
      ].join("\n"),
      maxBytes: 60000,
    })
    expect(callArgs?.evidence.some((item) => item.reason.includes("call-site") && item.snippet.includes("driver_start(dev, &default_ops)"))).toBe(true)

    const initializer = retrieveEvidence({
      index,
      question: [
        "inline completion for c file drivers/uart/uart.c",
        "completion-intent: initializer",
        "initializer-field: on_event",
      ].join("\n"),
      maxBytes: 60000,
    })
    expect(initializer?.evidence.some((item) => item.reason.includes("initializer-example") && item.snippet.includes(".on_event"))).toBe(true)

    const errorPath = retrieveEvidence({
      index,
      question: [
        "inline completion for c file drivers/uart/uart.c",
        "completion-intent: error-path",
        "function: driver_probe",
        "goto-label-prefix: out_",
      ].join("\n"),
      maxBytes: 60000,
    })
    expect(errorPath?.evidence.some((item) => item.reason.includes("cleanup-label") && item.snippet.includes("driver_unlock"))).toBe(true)

    const mmio = retrieveEvidence({
      index,
      question: [
        "inline completion for c file drivers/uart/uart.c",
        "completion-intent: mmio-register",
        "register-tokens: FIELD_PREP UART_CTRL_ENABLE",
      ].join("\n"),
      maxBytes: 60000,
    })
    expect(mmio?.evidence.some((item) => item.reason.includes("register-family") && item.snippet.includes("UART_CTRL_ENABLE_MASK"))).toBe(true)
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
int nand_read_page(int ready) {
  if (!ready) return -1;
  return ecc_check();
}
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

function eprIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "src/epr/epr_ppn_raw.c",
      hash: "epr",
      size: 1,
      text: `
int epr_ppn_raw_write_with_cb_dfx(void) { return 0; }
int epr_ppn_raw_write_cb_dfx(void) { return 0; }
int epr_ppn_raw_read(void) { return 0; }
`,
    }),
    parseCFile({
      path: "src/epr/epr_ppn_raw_test.c",
      hash: "test",
      size: 1,
      text: `
int test_epr_ppn_raw_write_with_cb_dfx(void) { return epr_ppn_raw_write_with_cb_dfx(); }
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

function completionEvidenceIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "drivers/uart/uart.c",
      hash: "uart",
      size: 1,
      text: `
#define UART_CTRL_REG 0x00u
#define UART_CTRL_ENABLE BIT(0)
#define UART_CTRL_ENABLE_MASK GENMASK(0, 0)
typedef void (*driver_cb_t)(uint32_t event);
static void driver_on_event(uint32_t event) { (void)event; }
typedef struct { uint32_t status; uint32_t state; } request_t;
typedef struct { driver_cb_t on_event; uint32_t mask; } driver_ops_t;
static const driver_ops_t default_ops = { .on_event = driver_on_event, .mask = BIT(0), };

int driver_start(struct device *dev, const driver_ops_t *ops) { return 0; }

int driver_probe(request_t *req, struct device *dev)
{
  int ret = driver_lock(dev);
  if (ret) {
    goto out_unlock;
  }
  ret = driver_start(dev, &default_ops);
  if (ret) {
    goto out_unlock;
  }
  return req->status;
out_unlock:
  driver_unlock(dev);
  return ret;
}
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
