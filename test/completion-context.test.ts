import { describe, expect, mock, test } from "bun:test"
import { completionContextDebugSummary, formatRepoContext, packCompletionContext } from "../src/completion-context"
import { planCompletion } from "../src/completion-plan"
import type { CompletionPlan, RetrievedCompletionSnippet } from "../src/completion-types"

mock.module("vscode", () => ({
  Range: class Range {
    start: { line: number; character: number }
    end: { line: number; character: number }

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
  },
  DiagnosticSeverity: {},
  ConfigurationTarget: {
    Global: "global",
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath?.replace(/^\/repo\//, "") ?? "",
    getWorkspaceFolder: () => ({ name: "repo" }),
    workspaceFolders: [{ name: "repo" }],
    textDocuments: [],
    fs: {
      readFile: async () => new Uint8Array(),
    },
    openTextDocument: async () => undefined,
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
  Selection: class Selection {},
  Position: class Position {},
}))

describe("completion context packer", () => {
  test("selects target symbols and similar tests within a token budget", () => {
    const pack = packCompletionContext({
      plan: commentToTestPlan(),
      languageId: "c",
      currentPath: "src/epr/epr_ppn_raw_test.c",
      prefix: "#include <gtest/gtest.h>\n// unit test for epr_ppn_raw_write_cb_dfx()",
      suffix: "",
      retrievedSnippets: [
        targetSnippet("int epr_ppn_raw_write_cb_dfx(void) { return 0; }"),
        similarTestSnippet("TEST(EprPpnRaw, WriteWithCbDfx) { EXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx()); }"),
      ],
      tokenBudget: 180,
    })

    expect(pack.selected.map((block) => block.kind)).toEqual(expect.arrayContaining(["target-symbol", "similar-test", "include"]))
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.tokenBudget)
    expect(completionContextDebugSummary(pack)).toContain("selected=")
  })

  test("drops lower-scored blocks when the budget is too small", () => {
    const pack = packCompletionContext({
      plan: commentToTestPlan(),
      languageId: "c",
      currentPath: "src/epr/epr_ppn_raw_test.c",
      prefix: "void destination(void) {}",
      suffix: "",
      retrievedSnippets: [
        targetSnippet("int epr_ppn_raw_write_cb_dfx(void) { return 0; }"),
        similarTestSnippet("TEST(EprPpnRaw, Existing) {\n" + "EXPECT_TRUE(epr_ppn_raw_write_cb_dfx() == 0);\n".repeat(80) + "}"),
      ],
      tokenBudget: 30,
    })

    expect(pack.selected.some((block) => block.kind === "target-symbol")).toBe(true)
    expect(pack.dropped.length).toBeGreaterThan(0)
  })

  test("selects open tabs as completion project context", () => {
    const pack = packCompletionContext({
      plan: ordinaryPlan(),
      languageId: "typescript",
      currentPath: "src/current.ts",
      prefix: "const next = ",
      suffix: "",
      retrievedSnippets: [],
      openTabs: [
        {
          path: "src/settings.ts",
          languageId: "typescript",
          text: "export const defaultRetryDelayMs = 250",
        },
      ],
      tokenBudget: 120,
    })

    expect(pack.selected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "open-tab",
        title: "open tab: src/settings.ts",
      }),
    ]))
    expect(formatRepoContext(pack)).toContain("defaultRetryDelayMs")
  })

  test("body continuations include boosted C embedded open-tab context", () => {
    const pack = packCompletionContext({
      plan: bodyContinuationPlan(),
      languageId: "c",
      currentPath: "src/drivers/uart_hw.c",
      prefix: "hal_status_t enable_uart(void)\n{\n    ",
      suffix: "\n    return HAL_OK;\n}\n",
      retrievedSnippets: [],
      openTabs: [
        {
          path: "docs/notes.txt",
          languageId: "plaintext",
          text: "ordinary note",
        },
        {
          path: "include/chip/uart_regs.h",
          languageId: "c",
          text: "#define UART_CTRL_ENABLE BIT(0)\nvoid uart_bus_unlock(uart_bus_t *bus);\n",
        },
      ],
      tokenBudget: 260,
    })

    expect(pack.selected.map((block) => block.kind)).toEqual(expect.arrayContaining(["open-tab", "current-prefix", "current-suffix"]))
    expect(pack.selected[0]).toMatchObject({
      kind: "open-tab",
      filePath: "include/chip/uart_regs.h",
    })
    expect(formatRepoContext(pack)).toContain("UART_CTRL_ENABLE")
  })

  test("selects local analysis evidence for completion context within budget", () => {
    const pack = packCompletionContext({
      plan: bodyContinuationPlan(),
      languageId: "c",
      currentPath: "src/drivers/uart_hw.c",
      prefix: "hal_status_t uart_enable(void)\n{\n    ",
      suffix: "\n}\n",
      retrievedSnippets: [],
      analysisEvidenceText: [
        "Evidence:",
        "include/chip/uart_regs.h: #define UART_CTRL_ENABLE BIT(0)",
        "src/drivers/uart_bus.c: void uart_bus_unlock(uart_bus_t *bus);",
      ].join("\n"),
      tokenBudget: 260,
    })

    expect(pack.selected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "analysis-evidence",
        title: "local analysis evidence",
      }),
    ]))
    expect(formatRepoContext(pack)).toContain("UART_CTRL_ENABLE")
  })

  test("prioritizes MMIO macro context for C/C++ register intents", () => {
    const pack = packCompletionContext({
      plan: cIntentPlan("mmio-register"),
      languageId: "c",
      currentPath: "src/drivers/ctrl.c",
      prefix: "void ctrl_enable(void)\n{\n    writel(",
      suffix: ");\n}\n",
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/drivers/ctrl.c",
          line: 40,
          name: "ctrl_enable",
          text: "int ctrl_enable(struct ctrl *ctrl) { return ctrl_start(ctrl); }",
          score: 60,
        },
        {
          kind: "macro",
          path: "include/drivers/ctrl_regs.h",
          line: 12,
          name: "CTRL_STATUS_REG",
          text: "#define CTRL_STATUS_REG 0x20\n#define CTRL_STATUS_READY BIT(0)\n#define CTRL_STATUS_MASK GENMASK(3, 0)",
          score: 55,
        },
      ],
      tokenBudget: 260,
    })

    expect(pack.selected[0]).toMatchObject({
      kind: "target-symbol",
      filePath: "include/drivers/ctrl_regs.h",
    })
    expect(formatRepoContext(pack)).toContain("CTRL_STATUS_READY")
  })

  test("prioritizes cleanup evidence for C/C++ error-path intents", () => {
    const pack = packCompletionContext({
      plan: cIntentPlan("error-path"),
      languageId: "c",
      currentPath: "src/drivers/probe.c",
      prefix: "int driver_probe(struct device *dev)\n{\n    int ret;\n    if (ret) {\n        ",
      suffix: "\n    }\nout_unlock:\n    driver_unlock(dev);\n    return ret;\n}\n",
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/drivers/other.c",
          line: 20,
          name: "driver_probe_other",
          text: "if (ret) {\n    goto out_unlock;\n}\nout_unlock:\n    driver_unlock(dev);\n    return ret;",
          score: 50,
        },
      ],
      analysisEvidenceText: "src/drivers/probe.c: cleanup labels include out_unlock; existing style uses goto out_unlock and return ret.",
      tokenBudget: 360,
    })

    expect(pack.selected.map((block) => block.kind)).toContain("analysis-evidence")
    expect(pack.selected[0].text).toContain("out_unlock")
  })

  test("drops local analysis evidence when token budget is too small", () => {
    const pack = packCompletionContext({
      plan: ordinaryPlan(),
      languageId: "c",
      currentPath: "src/current.c",
      prefix: "int value = ",
      suffix: "",
      retrievedSnippets: [],
      analysisEvidenceText: "x".repeat(2000),
      tokenBudget: 40,
    })

    expect(pack.dropped.map((block) => block.kind)).toContain("analysis-evidence")
  })

  test("delivers structured C embedded evidence within a 900 token budget", () => {
    const prefix = [
      "static int driver_submit(struct driver_ctx *ctx)",
      "{",
      ...Array.from({ length: 48 }, (_, index) => `    uint32_t local_${index} = ctx->status + ${index};`),
      "    ctx->",
    ].join("\n")
    const pack = packCompletionContext({
      plan: cEmbeddedIntentPlan("member-access"),
      languageId: "c",
      currentPath: "src/drivers/submit.c",
      prefix,
      suffix: "\n    return 0;\n}\n",
      retrievedSnippets: [],
      openTabs: [
        {
          path: "include/large_context.h",
          languageId: "c",
          text: "uint32_t unrelated_table[256];\n".repeat(120),
        },
      ],
      analysisEvidenceText: [
        "C embedded evidence for intent: member-access",
        "",
        "C evidence: c-base-type",
        "Symbol: driver_ctx",
        "Source: include/driver.h:10",
        "Reason: completion base-type",
        "Score: 300",
        "Retrieval source: graph",
        "Domain boost: no",
        "Code:",
        "base-type: struct driver_ctx",
        "",
        "C evidence: c-struct-definition",
        "Symbol: driver_ctx",
        "Source: include/driver.h:10-18",
        "Reason: completion struct-definition",
        "Score: 290",
        "Retrieval source: graph",
        "Domain boost: no",
        "Code:",
        "struct driver_ctx { int status; int flags; };",
        "",
        "C evidence: c-same-usage",
        "Source: src/drivers/other.c:42",
        "Reason: completion same-field-usage",
        "Score: 260",
        "Retrieval source: graph",
        "Domain boost: no",
        "Code:",
        "if (ctx->status) return ctx->status;",
      ].join("\n"),
      tokenBudget: 900,
    })

    const selectedKinds = pack.selected.map((block) => block.kind)
    expect(selectedKinds).toContain("current-prefix")
    expect(selectedKinds).toContain("c-embedded-evidence")
    expect(formatRepoContext(pack)).toContain('kind="c-embedded-evidence"')
    expect(formatRepoContext(pack)).toContain("base-type: struct driver_ctx")
    expect(formatRepoContext(pack)).toContain("C evidence: c-base-type")
    expect(formatRepoContext(pack)).not.toContain("<c-embedded-evidence")
    expect(formatRepoContext(pack)).not.toContain("<evidence")
    expect(pack.selected.filter((block) => block.kind === "c-embedded-evidence").length).toBeGreaterThanOrEqual(2)
    expect(pack.tokenEstimate).toBeLessThanOrEqual(900)
  })

  test("comment-guided C code keeps prefix and suffix ahead of source comment and evidence", () => {
    const plan: CompletionPlan = {
      kind: "comment-guided-c-code",
      insertMode: "insert-at-cursor",
      sourceComment: "// step2: wait nfc clock reset",
      cIntent: "body-statement",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsIntentRetrieval: true,
      needsTestRetrieval: false,
      useFim: true,
      useInstruction: false,
      maxTokens: 128,
      confidenceFloor: 0.35,
    }
    const pack = packCompletionContext({
      plan,
      languageId: "c",
      currentPath: "backend/hal/nfi_hal_ctrl_drv.c",
      prefix: [
        "int nfi_hal_controller_init(void)",
        "{",
        "    nfi_power_on();",
        "    // step2: wait nfc clock reset",
        "    ",
      ].join("\n"),
      suffix: [
        "",
        "    nfi_enable();",
        "    return 0;",
        "}",
      ].join("\n"),
      retrievedSnippets: [],
      openTabs: [{
        path: "backend/hal/noisy.c",
        languageId: "c",
        text: "void noisy(void) {\n" + "    unrelated();\n".repeat(500) + "}",
      }],
      analysisEvidenceText: [
        "C embedded evidence for intent: comment-guided-c-code",
        "",
        "C evidence: c-similar-function",
        "Symbol: nfdrv_wait_nfc_clk_reset",
        "Source: backend/hal/ctrl_drv/nfdrv_init.c:759-762",
        "Reason: completion comment-semantic-match similar-function",
        "Score: 420",
        "Retrieval source: graph",
        "Domain boost: no",
        "Code:",
        "void nfdrv_wait_nfc_clk_reset(void)\n{\n    delay_us(10);\n}",
        "",
        "C evidence: c-same-module-flow",
        "Source: backend/hal:1",
        "Reason: completion same-module-flow",
        "Score: 160",
        "Retrieval source: graph",
        "Domain boost: no",
        "Code:",
        "module backend/hal: controller init flow helpers",
      ].join("\n"),
      tokenBudget: 900,
    })

    const selectedKinds = pack.selected.map((block) => block.kind)
    expect(selectedKinds).toContain("current-prefix")
    expect(selectedKinds).toContain("current-suffix")
    expect(selectedKinds).toContain("source-comment")
    expect(pack.selected.some((block) => block.kind === "c-embedded-evidence" && block.title.startsWith("c-similar-function"))).toBe(true)
    expect(pack.dropped.find((block) => block.kind === "current-prefix")).toBeUndefined()
    expect(pack.dropped.find((block) => block.kind === "current-suffix")).toBeUndefined()
    const prompt = formatRepoContext(pack)
    expect(prompt).toContain("// step2: wait nfc clock reset")
    expect(prompt).toContain("C evidence: c-similar-function")
    expect(prompt).toContain("nfdrv_wait_nfc_clk_reset")
  })

  test("Qwen FIM prompt includes packed repo context before FIM tokens", async () => {
    const { buildQwenCoderFimPrompt } = await import("../src/context")
    const prompt = buildQwenCoderFimPrompt({
      document: fakeDocument("const value = ", "typescript"),
      position: { line: 0, character: "const value = ".length },
      settings: settings(),
      plan: {
        ...ordinaryPlan(),
        targetSymbol: "epr_ppn_raw_write_cb_dfx",
        needsSymbolRetrieval: true,
      },
      retrievedSnippets: [
        targetSnippet("int epr_ppn_raw_write_cb_dfx(void) { return 0; }"),
      ],
    })

    expect(prompt).toContain("<repo_context>")
    expect(prompt).toContain("epr_ppn_raw_write_cb_dfx")
    expect(prompt.indexOf("<repo_context>")).toBeLessThan(prompt.indexOf("<|fim_prefix|>"))
    expect(prompt).toContain("<|fim_suffix|>")
    expect(prompt).toContain("<|fim_middle|>")
  })

  test("Qwen FIM prompt includes local analysis evidence in packed context", async () => {
    const { buildQwenCoderFimPrompt } = await import("../src/context")
    const prompt = buildQwenCoderFimPrompt({
      document: fakeDocument("uint32_t flags = ", "c"),
      position: { line: 0, character: "uint32_t flags = ".length },
      settings: settings(),
      plan: bodyContinuationPlan(),
      retrievedSnippets: [],
      analysisEvidenceText: "include/chip/flags.h: #define FLAG_READY BIT(0)",
    })

    expect(prompt).toContain('kind="analysis-evidence"')
    expect(prompt).toContain("FLAG_READY")
    expect(prompt.indexOf("FLAG_READY")).toBeLessThan(prompt.indexOf("<|fim_prefix|>"))
  })

  test("Qwen FIM prompt includes C intent metadata before FIM tokens", async () => {
    const { buildQwenCoderFimPrompt } = await import("../src/context")
    const prompt = buildQwenCoderFimPrompt({
      document: fakeDocument("void f(struct req *req)\n{\n    req->", "c"),
      position: { line: 2, character: "    req->".length },
      settings: settings(),
      plan: cIntentPlan("member-access"),
      retrievedSnippets: [
        {
          kind: "type",
          path: "include/req.h",
          line: 4,
          name: "struct req",
          text: "struct req {\n    int status;\n};",
          score: 80,
        },
      ],
    })

    expect(prompt).toContain("// intent: member-access")
    expect(prompt).toContain("// retrieval:")
    expect(prompt).toContain("// constraints: return only insertion text; preserve local style")
    expect(prompt.indexOf("// intent: member-access")).toBeLessThan(prompt.indexOf("<|fim_prefix|>"))
  })

  test("instruction prompt includes target symbol definition and similar tests", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const line = "// unit test for epr_ppn_raw_write_cb_dfx()"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(line, "c"),
      position: { line: 0, character: line.length },
      settings: settings(),
      plan: commentToTestPlan(),
      retrievedSnippets: [
        targetSnippet("int epr_ppn_raw_write_cb_dfx(void) { return 0; }"),
        similarTestSnippet("TEST(EprPpnRaw, ExistingWriteCbDfx) { EXPECT_EQ(0, epr_ppn_raw_write_cb_dfx()); }"),
      ],
    })

    expect(prompt).toContain("Task:\nGenerate a unit test for the target symbol.")
    expect(prompt).toContain("Target symbol:")
    expect(prompt).toContain("int epr_ppn_raw_write_cb_dfx")
    expect(prompt).toContain("Similar tests:")
    expect(prompt).toContain("ExistingWriteCbDfx")
    expect(prompt).toContain("Current file:")
  })

  test("instruction prompt includes local analysis evidence", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const line = "// initialize uart safely"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(line, "c"),
      position: { line: 0, character: line.length },
      settings: settings(),
      plan: commentToCodePlan("uart_init"),
      retrievedSnippets: [],
      analysisEvidenceText: "src/drivers/uart_bus.c: hal_status_t uart_bus_lock(uart_bus_t *bus);",
    })

    expect(prompt).toContain("Local analysis evidence:")
    expect(prompt).toContain("uart_bus_lock")
  })

  test("comment-guided C code prompt keeps source comment, prefix, and suffix in FIM context", async () => {
    const { buildQwenCoderFimPrompt } = await import("../src/context")
    const documentText = [
      "static int driver_open(Device *dev)",
      "{",
      "    int ret;",
      "    // Add project-style error cleanup before success return.",
      "    ",
      "    ret = driver_start(dev);",
      "    if (ret < 0) {",
      "        return ret;",
      "    }",
      "    return 0;",
      "}",
    ].join("\n")
    const lines = documentText.split("\n")
    const position = { line: 4, character: 4 }
    const plan = planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: lines[3],
      nextNonEmptyLine: lines[5],
      lines,
      line: position.line,
    })
    expect(plan.kind).toBe("comment-guided-c-code")
    const prompt = buildQwenCoderFimPrompt({
      document: fakeDocument(documentText, "c"),
      position,
      settings: settings(),
      plan,
      retrievedSnippets: [],
    })

    expect(prompt).toContain("<|fim_prefix|>")
    expect(prompt).toContain("<|fim_suffix|>")
    expect(prompt).toContain('kind="source-comment"')
    expect(prompt).toContain('kind="current-prefix"')
    expect(prompt).toContain('kind="current-suffix"')
    expect(prompt).toContain("// Add project-style error cleanup before success return.")
    expect(prompt).toContain("ret = driver_start(dev);")
    expect(prompt).toContain("driver_open")
    expect(prompt).toContain("int ret;")
    expect(prompt).not.toContain("Task:\nGenerate code that satisfies the source comment.")
  })

  test("instruction prompt keeps full target function bodies when snippets include them", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const line = "// arbitrary intent alpha_feature_finalize"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(line, "c"),
      position: { line: 0, character: line.length },
      settings: settings(),
      plan: commentToCodePlan("alpha_feature_finalize"),
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/features/alpha.c",
          line: 10,
          name: "alpha_feature_finalize",
          text: [
            "static void alpha_feature_finalize(void)",
            "{",
            "    alpha_release_state();",
            "}",
          ].join("\n"),
          score: 99,
        },
      ],
    })

    expect(prompt).toContain("Target symbol:")
    expect(prompt).toContain("alpha_release_state();")
  })

  test("test instructions include framework context from test-shaped snippets", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const line = "// unit test for alpha_feature_finalize()"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(line, "c"),
      position: { line: 0, character: line.length },
      settings: settings(),
      plan: commentToTestPlanFor("alpha_feature_finalize"),
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/features/alpha.c",
          line: 10,
          name: "alpha_feature_finalize",
          text: "static void alpha_feature_finalize(void) {}",
          score: 99,
        },
        {
          kind: "existing test",
          path: "src/features/alpha_test.c",
          line: 30,
          name: "test_alpha_feature_finalize",
          text: [
            "#include <glib.h>",
            "static void alpha_fixture_setup(void)",
            "{",
            "    alpha_fixture_init();",
            "}",
            "",
            "static void test_alpha_feature_finalize(void)",
            "{",
            "    g_assert_true(alpha_feature_finalize_for_test());",
            "}",
          ].join("\n"),
          score: 88,
        },
      ],
    })

    expect(prompt).toContain("Similar tests:")
    expect(prompt).toContain("Test framework context:")
    expect(prompt).toContain("#include <glib.h>")
    expect(prompt).toContain("alpha_fixture_setup")
    expect(prompt).toContain("g_assert_true")
  })

  test("ordinary comment-to-code instructions do not include test framework context", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const line = "// arbitrary intent alpha_feature_finalize"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(line, "c"),
      position: { line: 0, character: line.length },
      settings: settings(),
      plan: commentToCodePlan("alpha_feature_finalize"),
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/features/alpha.c",
          line: 10,
          name: "alpha_feature_finalize",
          text: "static void alpha_feature_finalize(void) {}",
          score: 99,
        },
        {
          kind: "existing test",
          path: "src/features/alpha_test.c",
          line: 30,
          name: "test_alpha_feature_finalize",
          text: "static void test_alpha_feature_finalize(void) { g_assert_true(true); }",
          score: 88,
        },
      ],
    })

    expect(prompt).not.toContain("Test framework context:")
    expect(prompt).not.toContain("test_alpha_feature_finalize")
  })

  test("previous comment continuation prompt names the source comment and current line prefix", async () => {
    const { buildCompletionPrompt } = await import("../src/context")
    const sourceComment = "// 任意描述 alpha_feature_finalize"
    const currentPrefix = "stat"
    const prompt = await buildCompletionPrompt({
      document: fakeDocument(`${sourceComment}\n${currentPrefix}`, "c"),
      position: { line: 1, character: currentPrefix.length },
      settings: settings(),
      plan: previousCommentContinuationPlan(sourceComment),
      retrievedSnippets: [
        {
          kind: "function",
          path: "src/features/alpha.c",
          line: 10,
          name: "alpha_feature_finalize",
          text: "static void alpha_feature_finalize(void) {}",
          score: 99,
        },
      ],
    })

    expect(prompt).toContain("Source comment:")
    expect(prompt).toContain(sourceComment)
    expect(prompt).toContain("Current line prefix:")
    expect(prompt).toContain(currentPrefix)
  })
})

function commentToTestPlan() {
  return planCompletion({
    languageId: "c",
    linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
    lineSuffix: "",
  })
}

function commentToTestPlanFor(symbol: string) {
  return {
    ...planCompletion({
      languageId: "c",
      linePrefix: `// unit test for ${symbol}()`,
      lineSuffix: "",
    }),
    targetSymbol: symbol,
  }
}

function commentToCodePlan(symbol: string): CompletionPlan {
  return {
    kind: "comment-to-code",
    insertMode: "insert-after-line",
    targetSymbol: symbol,
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: true,
    maxTokens: 384,
    confidenceFloor: 0.5,
  }
}

function previousCommentContinuationPlan(sourceComment: string): CompletionPlan {
  return {
    kind: "previous-comment-continuation",
    insertMode: "replace-whole-line",
    sourceComment,
    targetSymbol: "alpha_feature_finalize",
    replaceCurrentWord: true,
    needsSymbolRetrieval: true,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: true,
    maxTokens: 384,
    confidenceFloor: 0.5,
  }
}

function ordinaryPlan(): CompletionPlan {
  return planCompletion({
    languageId: "typescript",
    linePrefix: "const value = ",
    lineSuffix: "",
  })
}

function bodyContinuationPlan(): CompletionPlan {
  return {
    kind: "body-continuation",
    insertMode: "insert-at-cursor",
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: 96,
    confidenceFloor: 0.35,
  }
}

function cIntentPlan(cIntent: NonNullable<CompletionPlan["cIntent"]>): CompletionPlan {
  return {
    kind: cIntent === "top-level-declaration" ? "top-level-declaration" : "ordinary-code",
    insertMode: "insert-at-cursor",
    cIntent,
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: 96,
    confidenceFloor: 0.35,
  }
}

function cEmbeddedIntentPlan(cIntent: NonNullable<CompletionPlan["cIntent"]>): CompletionPlan {
  return {
    ...cIntentPlan(cIntent),
    kind: "c-embedded-code",
    needsIntentRetrieval: true,
  }
}

function targetSnippet(text: string): RetrievedCompletionSnippet {
  return {
    kind: "function",
    path: "src/epr/epr_ppn_raw.c",
    line: 10,
    name: "epr_ppn_raw_write_cb_dfx",
    text,
    score: 99,
  }
}

function similarTestSnippet(text: string): RetrievedCompletionSnippet {
  return {
    kind: "existing test",
    path: "src/epr/epr_ppn_raw_test.c",
    line: 30,
    name: "test_epr_ppn_raw_write_cb_dfx",
    text,
    score: 70,
  }
}

function fakeDocument(text: string, languageId: string) {
  const lines = text.split("\n")
  return {
    uri: {
      scheme: "file",
      fsPath: "/repo/src/epr/epr_ppn_raw_test.c",
      toString: () => "file:///repo/src/epr/epr_ppn_raw_test.c",
    },
    languageId,
    lineCount: lines.length,
    version: 1,
    lineAt(line: number) {
      return { text: lines[line] ?? "" }
    },
    getText(range?: { start: { line: number; character: number }; end: { line: number; character: number } }) {
      if (!range) return text
      if (range.start.line === range.end.line) {
        return (lines[range.start.line] ?? "").slice(range.start.character, range.end.character)
      }
      const selected = lines.slice(range.start.line, range.end.line + 1)
      selected[0] = selected[0].slice(range.start.character)
      selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.end.character)
      return selected.join("\n")
    },
  } as never
}

function settings() {
  return {
    context: {
      maxFileBytes: 16000,
    },
  } as never
}
