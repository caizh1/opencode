import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { canLoadBundledTreeSitter, parseCFileWithAst } from "../src/codegraph-ast"

const extensionPath = join(import.meta.dir, "..")

describe("bundled Tree-sitter AST analyzer", () => {
  test("loads bundled C and C++ WASM grammars from the extension package", async () => {
    expect(await canLoadBundledTreeSitter(extensionPath)).toBe(true)
  })

  test("adds AST control-flow summaries to parsed C files", async () => {
    const file = await parseCFileWithAst({
      extensionPath,
      path: "drivers/fsm.c",
      hash: "1",
      size: 1,
      text: `
enum mode { MODE_IDLE, MODE_RUN };
int step(int state, int event) {
  switch (state) {
    case MODE_IDLE:
      if (event) return MODE_RUN;
      return MODE_IDLE;
    default:
      return state;
  }
}
`,
    })

    expect(file.functions.some((fn) => fn.name === "step")).toBe(true)
    expect(file.astSummary?.parser).toBe("tree-sitter-wasm")
    expect(file.astSummary?.switchStatements).toBe(1)
    expect(file.astSummary?.ifStatements).toBe(1)
    expect(file.astSummary?.caseStatements).toBeGreaterThanOrEqual(1)
    expect(file.astSummary?.controls.some((control) => control.kind === "switch")).toBe(true)
  })
})
