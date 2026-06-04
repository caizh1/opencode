import { describe, expect, mock, test } from "bun:test"
import { completionContextDebugSummary, packCompletionContext } from "../src/completion-context"
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
})

function commentToTestPlan() {
  return planCompletion({
    languageId: "c",
    linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
    lineSuffix: "",
  })
}

function ordinaryPlan(): CompletionPlan {
  return planCompletion({
    languageId: "typescript",
    linePrefix: "const value = ",
    lineSuffix: "",
  })
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
