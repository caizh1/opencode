import { beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCFile } from "../src/codegraph-c-parser"
import { DEFAULT_ANALYSIS_BUDGET, queryEvidence, runAnalysisTool } from "../src/codegraph-analysis"
import type { CodeGraphIndex } from "../src/codegraph-types"
import type { WordDocSpec } from "../src/docAgent/types"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: UriShim,
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => {
        await mkdir(join(uri.fsPath, ".."), { recursive: true })
        await writeFile(uri.fsPath, data)
      },
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      stat: async (uri: UriShim) => {
        const item = await stat(uri.fsPath)
        return { type: item.isDirectory() ? 2 : 1, size: item.size }
      },
    },
  },
}))

const { DesignDocAgentFlow, isDesignDocIntent, validateDesignDocTargets } = await import("../src/designDoc/DesignDocAgentFlow")

const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x04, 0x00,
  0x09, 0xfb, 0x03, 0xfd, 0xa7, 0x98, 0x9d, 0xa6,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
])

beforeEach(async () => {
  workspaceFolders = []
})

describe("DesignDocAgentFlow", () => {
  test("detects code-scoped detailed design intent without stealing generic document requests", () => {
    expect(isDesignDocIntent("请为 @drivers/nand 生成芯片级详细设计文档")).toBe(true)
    expect(isDesignDocIntent("帮我生成当前插件 word 创建流水线的机制的详细设计文档")).toBe(true)
    expect(isDesignDocIntent("请完善为一份正式设计文档。")).toBe(false)
    expect(isDesignDocIntent("请生成一份产品方案设计文档。")).toBe(false)
    expect(isDesignDocIntent("解释一下当前函数的设计思路和实现机制。")).toBe(false)
    expect(isDesignDocIntent("这个 Word 文档应该怎么排版更好？")).toBe(false)
    expect(isDesignDocIntent("随便解释一下这个函数")).toBe(false)

    const root = validateDesignDocTargets([{ path: ".", kind: "folder" }])
    expect(root.ok).toBe(false)
    expect(root.reason).toContain("整个仓库")
  })

  test("keeps design-doc Word output behind the generic create_word_document boundary", async () => {
    const source = await readFile(new URL("../src/designDoc/DesignDocAgentFlow.ts", import.meta.url), "utf8")

    expect(source).toContain('import { createWordDocument } from "../tools/createWordDocumentTool"')
    expect(source).toContain("createDocument?: typeof createWordDocument")
    expect(source).toContain("(input.createDocument ?? createWordDocument)")
    expect(source).not.toMatch(/WordDocBuilder|WordDocumentEditor|WordDocumentInspector|DocxFileStore|new\s+WordDoc|new\s+WordDocument/)
    expect(source).not.toMatch(/from "\.\.\/docAgent\/(?!types)/)
  })

  test("generates a module design doc spec, diagrams, and evidence artifacts", async () => {
    const root = await workspaceRoot()
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const index = sampleIndex()
    const provider = sampleProvider(index)
    let capturedSpec: WordDocSpec | undefined
    const renderCalls: string[] = []

    const result = await new DesignDocAgentFlow().run({
      question: "请生成芯片级详细设计文档，覆盖状态机切换条件。",
      targets: [{ path: "drivers/nand", kind: "folder" }],
      codeGraph: provider,
      renderMermaid: async ({ id, source }) => {
        renderCalls.push(id)
        expect(source).toMatch(/^(flowchart|stateDiagram-v2)/)
        return { bytes: TINY_PNG, width: 640, height: 360 }
      },
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return {
          path: ".chipmate/docs/nand-design.docx",
          absolutePath: join(root, ".chipmate/docs/nand-design.docx"),
          title: spec.metadata.title,
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

	    expect(result.title).toContain("drivers/nand")
	    expect(result.diagrams.length).toBeGreaterThanOrEqual(3)
	    expect(result.diagrams.every((item) => item.kind === "mermaid")).toBe(true)
	    expect(result.diagrams.every((item) => item.path?.endsWith(".mmd"))).toBe(true)
	    expect(result.diagrams.every((item) => item.png?.path?.endsWith(".png"))).toBe(true)
	    expect(result.diagrams.every((item) => /^(flowchart|stateDiagram-v2)/.test(item.source))).toBe(true)
	    expect(result.diagrams.map((item) => item.type)).toContain("state-machine")
	    expect(renderCalls).toEqual(result.diagrams.map((item) => item.id))
	    expect(result.runSummaryPath).toContain(".chipmate/docs/design-doc-")
	    expect(result.runSummary?.targetResolution?.source).toBe("explicit")
	    expect(capturedSpec?.sections.map((section) => section.title).join("\n")).toContain("状态机切换流程")
	    expect(capturedSpec?.sections.map((section) => section.title).join("\n")).toContain("功能详细设计")
	    const sectionsById = new Map(capturedSpec?.sections.map((section) => [section.id, section]) ?? [])
	    for (const sectionId of ["current-design", "business-flow", "code-flow", "state-machines"]) {
	      const figure = sectionsById.get(sectionId)?.figures?.[0]
	      expect(figure?.image.contentType).toBe("image/png")
	      expect(figure?.image.bytes).toEqual(TINY_PNG)
	    }
	    expect(sectionsById.get("diagrams")?.figures).toBeUndefined()
	    expect(JSON.stringify(capturedSpec)).toContain("NAND_READY")
	    expect(JSON.stringify(capturedSpec)).toContain(".mmd")
	    expect(JSON.stringify(capturedSpec)).toContain(".png")
	    expect(JSON.stringify(capturedSpec)).not.toContain("flowchart TD")
	    expect(JSON.stringify(capturedSpec)).not.toContain("stateDiagram-v2")
	
	    const summaryText = await readFile(join(root, result.runSummaryPath!), "utf8")
	    expect(summaryText).toContain("drivers/nand")
	    expect(summaryText).toContain("\"targetResolution\"")
	    expect(summaryText).toContain("state-machine")
	    expect(summaryText).toContain("\"kind\": \"mermaid\"")
	    expect(summaryText).toContain("\"pngPath\"")
	    const diagramText = await readFile(join(root, result.diagrams[0]!.path!), "utf8")
	    expect(diagramText).toMatch(/^flowchart TD/)
	    const diagramPng = await readFile(join(root, result.diagrams[0]!.png!.path!))
	    expect([...diagramPng.slice(0, 8)]).toEqual([...TINY_PNG.slice(0, 8)])
	    await rm(root, { recursive: true, force: true })
	  })

  test("infers detailed design targets from the prompt when no explicit context is provided", async () => {
    const root = await workspaceRoot()
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const index = sampleIndex()
    const provider = sampleProvider(index)
    let capturedSpec: WordDocSpec | undefined
    const modelCalls: string[] = []

    const result = await new DesignDocAgentFlow().run({
      question: "请生成当前仓库 NAND read page 机制的详细设计文档，覆盖状态机。",
      targets: [],
      codeGraph: provider,
      model: {
        completeJson: async (request) => {
          modelCalls.push(request.purpose)
          expect(request.purpose).toBe("resolve-design-doc-targets")
          expect(request.prompt).toContain("drivers/nand")
          return {
            selectedTargets: [{ path: "drivers/nand", kind: "folder", reason: "NAND read page evidence is concentrated here." }],
            confidence: 0.88,
            explanation: "NAND read page 机制的入口和状态迁移证据集中在 drivers/nand。",
          }
        },
      },
      renderMermaid: async ({ source }) => {
        expect(source).toMatch(/^(flowchart|stateDiagram-v2)/)
        return { bytes: TINY_PNG, width: 640, height: 360 }
      },
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return {
          path: ".chipmate/docs/nand-inferred-design.docx",
          absolutePath: join(root, ".chipmate/docs/nand-inferred-design.docx"),
          title: spec.metadata.title,
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

    expect(modelCalls).toEqual(["resolve-design-doc-targets"])
    expect(result.runSummary?.targetResolution?.source).toBe("model-inferred")
    expect(result.runSummary?.targetResolution?.targets.map((target) => target.path)).toEqual(["drivers/nand"])
    expect(result.runSummary?.targetResolution?.confidence).toBe(0.88)
    expect(result.title).toContain("drivers/nand")
    expect(JSON.stringify(capturedSpec)).toContain("范围由 ChipMate 自动识别")
    expect(JSON.stringify(capturedSpec)).toContain("drivers/nand")
    expect(JSON.stringify(capturedSpec)).not.toContain("请先用 @")

    const summaryText = await readFile(join(root, result.runSummaryPath!), "utf8")
    expect(summaryText).toContain("\"source\": \"model-inferred\"")
    expect(summaryText).toContain("\"path\": \"drivers/nand\"")
    await rm(root, { recursive: true, force: true })
  })
})

async function workspaceRoot() {
  const root = join(tmpdir(), `chipmate-design-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}

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
int nand_reset(void) {
  state = NAND_INIT;
  return 0;
}
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
      path: "drivers/nand/nand.h",
      hash: "2",
      size: 1,
      text: "int nand_read_page(void);\nint nand_reset(void);\n",
    }),
    parseCFile({
      path: "boot/storage.c",
      hash: "3",
      size: 1,
      text: "int storage_boot(void) { return nand_read_page(); }\n",
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

function sampleProvider(index: CodeGraphIndex) {
  return {
    status: () => ({ state: "ready", enabled: true, detail: "ready" }),
    runAnalysisTool: async (input: { tool: Parameters<typeof runAnalysisTool>[0]["tool"]; args?: Record<string, unknown> }) =>
      runAnalysisTool({ index, tool: input.tool, args: input.args }),
    queryEvidence: async (question: string, options?: { relatedPaths?: string[]; maxEvidenceItems?: number; maxEvidenceBytes?: number }) =>
      queryEvidence(index, question, {
        ...DEFAULT_ANALYSIS_BUDGET,
        maxEvidenceItems: options?.maxEvidenceItems ?? 80,
        maxEvidenceBytes: options?.maxEvidenceBytes ?? 120000,
        maxGraphEdges: 240,
      }, options?.relatedPaths ?? []),
  }
}
