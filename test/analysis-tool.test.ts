import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import {
  buildAnalysisSummaries,
  DEFAULT_ANALYSIS_BUDGET,
  DEFAULT_ANALYSIS_TOOL_POLICY,
  evaluateAnswerPolicy,
  packEvidenceRefs,
  queryEvidence,
  runAnalysisTool,
} from "../src/codegraph-analysis"
import { createOpenCodeLocalAgentPolicyTemplate, createOpenCodeLocalAnalysisTool, localAnalysisToolNames } from "../src/analysis-tool-template"
import type { CodeGraphIndex } from "../src/codegraph-types"

describe("analysis tool API and offline evidence RAG", () => {
  test("serves search, symbol, graph, module, and state-machine queries with audit", async () => {
    const index = sampleIndex()
    const search = await runAnalysisTool({ index, tool: "search", args: { query: "who calls nand_read_page" } })
    expect(search.ok).toBe(true)
    expect(search.evidence.length).toBeGreaterThan(0)
    expect(search.audit.tool).toBe("search")
    expect(search.audit.blocked).toBe(false)

    const symbol = await runAnalysisTool({ index, tool: "getSymbol", args: { name: "nand_read_page" } })
    expect(symbol.ok).toBe(true)
    expect(symbol.evidence[0].file).toBe("drivers/nand/nand.c")

    const chain = await runAnalysisTool({ index, tool: "getCallChain", args: { symbol: "storage_boot", target: "ecc_check" } })
    expect(chain.ok).toBe(true)
    expect(JSON.stringify(chain.data)).toContain("call-chain")

    const moduleMap = await runAnalysisTool({ index, tool: "getModuleMap" })
    expect(moduleMap.ok).toBe(true)
    expect(JSON.stringify(moduleMap.data)).toContain("drivers/nand")

    const machines = await runAnalysisTool({ index, tool: "getStateMachines", args: { query: "nand" } })
    expect(machines.ok).toBe(true)
    expect(JSON.stringify(machines.data)).toContain("transitionTable")

    const path = await runAnalysisTool({ index, tool: "getStatePath", args: { source: "NAND_INIT", target: "NAND_READY" } })
    expect(path.ok).toBe(true)
    expect(JSON.stringify(path.data)).toContain("NAND_READY")
  })

  test("enforces tool policy and evidence budgets", async () => {
    const index = sampleIndex()
    const blocked = await runAnalysisTool({
      index,
      tool: "search",
      args: { query: "nand" },
      policy: { ...DEFAULT_ANALYSIS_TOOL_POLICY, allowedTools: ["queryEvidence"] },
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.audit.blocked).toBe(true)

    const result = queryEvidence(index, "解释 nand 模块启动流程和状态切换", {
      ...DEFAULT_ANALYSIS_BUDGET,
      maxEvidenceItems: 2,
      maxEvidenceBytes: 600,
    })
    expect(result.evidencePack.evidence.length).toBeLessThanOrEqual(2)
    expect(result.evidencePack.truncated).toBe(true)
    expect(result.trace.steps.map((step) => step.label)).toContain("evidence-pack")
    expect(result.answerPolicy.allowed).toBe(true)
    expect(result.suggestedAnswer).toContain("Evidence:")
  })

  test("builds deterministic summaries and answer policy refuses missing evidence", () => {
    const summaries = buildAnalysisSummaries(sampleIndex())
    expect(summaries.functions.some((item) => item.name === "nand_read_page" && item.evidence.length > 0)).toBe(true)
    expect(summaries.files.some((item) => item.path === "drivers/nand/nand.c" && item.coreSymbols.includes("nand_read_page"))).toBe(true)
    expect(summaries.modules.some((item) => item.module === "drivers/nand" && item.evidence.length > 0)).toBe(true)
    expect(summaries.subsystems.some((item) => item.name === "drivers")).toBe(true)

    const emptyPack = packEvidenceRefs([], DEFAULT_ANALYSIS_BUDGET, ["missing symbol X"])
    const policy = evaluateAnswerPolicy("解释 X", emptyPack)
    expect(policy.allowed).toBe(false)
    expect(policy.confidence).toBe("none")
  })

  test("generates OpenCode custom tool and offline agent policy templates", () => {
    const tool = createOpenCodeLocalAnalysisTool({ endpoint: "http://127.0.0.1:1234", token: "secret" })
    expect(tool).toContain("@opencode-ai/plugin")
    expect(tool).toContain("opencode_local_analysis")
    expect(tool).toContain("Bearer")
    expect(tool).toContain("queryEvidence")
    expect(localAnalysisToolNames()).toContain("getStatePath")

    const policy = JSON.parse(createOpenCodeLocalAgentPolicyTemplate())
    expect(policy.agent["vscode-local"].permission.webfetch).toBe("deny")
    expect(policy.agent["vscode-local"].permission.websearch).toBe("deny")
    expect(policy.agent["vscode-local"].permission.edit).toBe("deny")
    expect(policy.agent["vscode-local"].permission.bash).toBe("deny")
    expect(policy.agent["vscode-local"].permission.opencode_local_analysis).toBe("allow")
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
enum nand_state {
  NAND_INIT,
  NAND_READY,
  NAND_ERROR,
};
static enum nand_state state;
int ecc_check(void) { return 0; }
int nand_read_page(void) {
  switch (state) {
  case NAND_INIT:
    state = NAND_READY;
    break;
  case NAND_READY:
    if (ecc_check() < 0) {
      state = NAND_ERROR;
    }
    break;
  }
  return ecc_check();
}
`,
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "2",
      size: 1,
      text: `
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
