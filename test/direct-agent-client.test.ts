import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillRegistry } from "../src/skills"
import type { GoalToolHandler, ToolRuntime as ToolRuntimeInstance, ToolRuntimeResult } from "../src/tool-runtime"
import type { DrawioGeneratedDiagram } from "../src/drawio-diagram-generator"
import type { RemoteSettings, ThreadGoalStatus } from "../src/types"
import { CHAT_SESSION_TITLE } from "../src/chat-session"
import { cGuidelineDocxFixture, docxFixture } from "./document-fixtures"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []
let warningMessageSelection: string | undefined
let warningMessageCalls = 0
let configurationValues: Record<string, unknown> = {}

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  InlineCompletionTriggerKind: {
    Invoke: 0,
    Automatic: 1,
  },
  InlineCompletionItem: class InlineCompletionItem {
    insertText: string
    range?: unknown
    command?: unknown
    filterText?: string

    constructor(insertText: string, range?: unknown, command?: unknown) {
      this.insertText = insertText
      this.range = range
      this.command = command
    }
  },
  Range: class Range {
    start: { line: number; character: number }
    end: { line: number; character: number }

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  ConfigurationTarget: {
    Global: "global",
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: UriShim,
  env: {
    remoteName: undefined,
  },
  WorkspaceEdit: class WorkspaceEdit {
    readonly inserts: unknown[] = []
    readonly replaces: unknown[] = []
    readonly deletes: unknown[] = []
    insert(...args: unknown[]) {
      this.inserts.push(args)
    }
    replace(...args: unknown[]) {
      this.replaces.push(args)
    }
    delete(...args: unknown[]) {
      this.deletes.push(args)
    }
  },
  commands: {
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? "",
    getWorkspaceFolder: () => workspaceFolders[0],
    getConfiguration: (section?: string) => ({
      get: <T>(key: string, fallback: T) => {
        const fullKey = section ? `${section}.${key}` : key
        if (Object.prototype.hasOwnProperty.call(configurationValues, fullKey)) return configurationValues[fullKey] as T
        if (Object.prototype.hasOwnProperty.call(configurationValues, key)) return configurationValues[key] as T
        return fallback
      },
      update: async () => undefined,
    }),
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      readDirectory: async (uri: UriShim) => {
        const entries = await readdir(uri.fsPath, { withFileTypes: true })
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number])
      },
      delete: async (uri: UriShim) => rm(uri.fsPath, { force: true, recursive: true }),
    },
  },
  window: {
    get activeTextEditor() {
      return undefined
    },
    get visibleTextEditors() {
      return []
    },
    showWarningMessage: async () => {
      warningMessageCalls += 1
      return warningMessageSelection
    },
  },
  Position: class Position {},
  Selection: class Selection {},
}))

const { DirectAgentClient } = await import("../src/direct-agent-client")
const { ToolRuntime } = await import("../src/tool-runtime")
const { GoalRuntime, GoalStore, MAX_THREAD_GOAL_OBJECTIVE_CHARS } = await import("../src/goal-runtime")
const { generateDrawioDiagram } = await import("../src/drawio-diagram-generator")
const { setDrawioElkLayoutRunnerForTest } = await import("../src/drawio-layout-engine")
const { setMermaidPngRendererForTest } = await import("../src/mermaid-png-renderer")
const ExcelJSModule = await import("exceljs")
const ExcelJS = (ExcelJSModule.default ?? ExcelJSModule) as typeof import("exceljs")

let servers: http.Server[] = []
let previousKiloSessionRetryLimit: string | undefined

beforeEach(() => {
  workspaceFolders = []
  warningMessageSelection = undefined
  warningMessageCalls = 0
  configurationValues = {}
  previousKiloSessionRetryLimit = process.env.KILO_SESSION_RETRY_LIMIT
  delete process.env.KILO_SESSION_RETRY_LIMIT
})

afterEach(async () => {
  setDrawioElkLayoutRunnerForTest(undefined)
  setMermaidPngRendererForTest(undefined)
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  if (previousKiloSessionRetryLimit === undefined) delete process.env.KILO_SESSION_RETRY_LIMIT
  else process.env.KILO_SESSION_RETRY_LIMIT = previousKiloSessionRetryLimit
})

describe("ToolRuntime", () => {
  test("chat view leaves document requests on the generic DirectAgent route", async () => {
    const source = await readFile(join(process.cwd(), "src", "chat-view.ts"), "utf8")

    expect(source).not.toContain("tryRunDesignDocAgentFlow")
    expect(source).not.toContain("tryRunDocumentAgentFlow")
    expect(source).not.toContain("new DesignDocAgentFlow")
    expect(source).not.toContain("new WordEditAgentFlow")
    expect(source).not.toContain("isDesignDocIntent")
    expect(source).not.toContain("isWordEditIntent")
  })

		  test("exposes read evidence and bounded workspace write tool definitions to models", () => {
	    const runtime = new ToolRuntime({} as never)
	    const toolNames = runtime.toolDefinitions().map((definition) => definition.function.name)

	    expect(toolNames).toEqual([
	      "get_goal",
	      "create_goal",
	      "update_goal",
	      "chipmate_search_text",
      "chipmate_search_code",
      "chipmate_graph_inspect_symbol",
      "chipmate_graph_find_references",
      "chipmate_graph_callers",
      "chipmate_graph_callees",
      "chipmate_graph_trace_call_chain",
      "chipmate_graph_analyze_impact",
      "chipmate_graph_map_module",
      "chipmate_graph_find_state_machines",
      "chipmate_graph_trace_state_path",
      "chipmate_graph_function_cfg",
      "chipmate_graph_expand_flow_slice",
      "chipmate_graph_state_flow_detail",
      "chipmate_search_documents",
      "chipmate_read_evidence",
      "chipmate_read",
      "chipmate_read_skill_resource",
      "chipmate_run_skill_script",
      "chipmate_run_command",
      "read_docx",
      "inspect_word_document",
      "apply_word_document_edits",
      "render_word_document",
      "compare_word_documents",
      "merge_word_documents",
      "extract_xlsx_table",
      "export_word_table_to_csv",
      "audit_word_document_styles",
      "normalize_word_document_styles",
      "apply_word_template_styles",
      "audit_word_document_fields",
      "flatten_word_ref_fields",
      "materialize_word_seq_fields",
	      "refresh_word_native_fields",
	      "chipmate_ask_user_clarification",
	      "chipmate_validate_diagram_ir",
	      "chipmate_render_mermaid_diagram",
	      "chipmate_create_drawio_diagram",
	      "create_word_document",
      "chipmate_create_file",
      "chipmate_create_directory",
      "chipmate_edit_file",
    ])
    expect(toolNames).not.toContain("chipmate_write_file")
    expect(toolNames).not.toContain("chipmate_http_request")
    const createFile = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_create_file")
    expect(createFile?.function.parameters).toMatchObject({
      required: ["path", "content"],
      additionalProperties: false,
    })
    const createDirectory = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_create_directory")
    expect(createDirectory?.function.parameters).toMatchObject({
      required: ["path"],
      additionalProperties: false,
    })
    const editFile = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_edit_file")
    expect(editFile?.function.parameters).toMatchObject({
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    })
    const drawio = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_create_drawio_diagram")
	    expect(drawio?.function.parameters).toMatchObject({
	      required: ["title"],
	      additionalProperties: false,
	    })
	    expect(drawio?.function.parameters.properties).toHaveProperty("composition")
	    const mermaid = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_render_mermaid_diagram")
	    expect(mermaid?.function.parameters).toMatchObject({
	      required: ["source", "title"],
	      additionalProperties: false,
	    })
	    expect(mermaid?.function.parameters.properties).toHaveProperty("scale")
	    expect(mermaid?.function.description).toContain("PNG figure")
    const createWordDocument = runtime.toolDefinitions().find((definition) => definition.function.name === "create_word_document")
    expect(createWordDocument?.function.parameters).toMatchObject({
      required: ["spec"],
      additionalProperties: false,
      properties: {
        spec: {
          required: ["metadata", "sources", "sections"],
          properties: {
            metadata: { required: ["title", "documentType", "language", "generatedAt"] },
            sources: { type: "array" },
            sections: {
              type: "array",
              items: {
                required: ["id", "level", "title"],
                properties: {
                  paragraphs: { type: "array", items: { type: "string" } },
                },
              },
            },
            layout: {
              properties: {
                navigation: {
                  properties: {
                    mode: { enum: ["field-toc", "static-toc", "none"] },
                  },
                },
              },
            },
          },
        },
      },
    })
    expect(createWordDocument?.function.description).toContain("sources must be an array")
    expect(createWordDocument?.function.description).toContain("sections[].paragraphs/bullets/numberedItems must be arrays of strings")
    const clarification = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_ask_user_clarification")
    expect(clarification?.function.parameters).toMatchObject({
      required: ["reason"],
      additionalProperties: false,
    })
    expect(clarification?.function.parameters.properties).toHaveProperty("questions")
    const getGoal = runtime.toolDefinitions().find((definition) => definition.function.name === "get_goal")
    const createGoal = runtime.toolDefinitions().find((definition) => definition.function.name === "create_goal")
    const updateGoal = runtime.toolDefinitions().find((definition) => definition.function.name === "update_goal")
    expect(getGoal?.function.description).toContain("token and elapsed-time usage")
    expect(createGoal?.function.parameters).toMatchObject({
      required: ["objective"],
      additionalProperties: false,
    })
    expect(createGoal?.function.parameters.properties).toHaveProperty("token_budget")
    expect(createGoal?.function.parameters.properties).not.toHaveProperty("tokenBudget")
    expect(createGoal?.function.description).toContain("system/developer instructions")
    expect(createGoal?.function.description).toContain("do not infer goals from ordinary tasks")
    expect(updateGoal?.function.parameters).toMatchObject({
      required: ["status"],
      additionalProperties: false,
    })
    expect(updateGoal?.function.parameters.properties.status.enum).toEqual(["complete", "blocked"])
    expect(updateGoal?.function.description).toContain("at least three consecutive goal turns")
    expect(updateGoal?.function.description).toContain("fresh blocked audit")
    expect(updateGoal?.function.description).toContain("Do not mark a goal complete merely because its budget is nearly exhausted")
    expect(updateGoal?.function.description).toContain("controlled by the user or system")
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Use when"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Do not use"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Returns"))).toBe(true)
	    expect(runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_read")?.function.description).toContain("Office/PDF")
	  })

	  test("executes goal tools through injected goal handlers", async () => {
	    const runtime = new ToolRuntime({ append: async () => undefined } as never)
	    const calls: string[] = []
	    const goal = {
	      threadID: "session-1",
	      goalID: "goal-1",
	      objective: "finish the migration",
	      status: "active" as const,
	      tokenBudget: 100,
	      tokensUsed: 25,
	      timeUsedSeconds: 7,
	      createdAt: 1,
	      updatedAt: 2,
	    }
	    const goals: GoalToolHandler = {
	      getGoal: async (sessionID: string) => {
	        calls.push(`get:${sessionID}`)
	        return { goal: null, remainingTokens: null, completionBudgetReport: null }
	      },
	      createGoal: async (sessionID: string, input: { objective: string; tokenBudget?: number }) => {
	        calls.push(`create:${sessionID}:${input.objective}:${input.tokenBudget}`)
	        return { goal: { ...goal, objective: input.objective, tokenBudget: input.tokenBudget }, remainingTokens: input.tokenBudget ?? null, completionBudgetReport: null }
	      },
	      updateGoal: async (sessionID: string, input: { status: ThreadGoalStatus }) => {
	        calls.push(`update:${sessionID}:${input.status}`)
	        return { goal: { ...goal, status: input.status }, remainingTokens: 75, completionBudgetReport: input.status === "complete" ? "Goal achieved. Report final usage from this tool result's structured goal fields." : null }
	      },
	    }

	    const getResult = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "get_goal",
	      arguments: {},
	      goals,
	    })
	    const createResult = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "create_goal",
	      arguments: { objective: "ship goal", token_budget: 100 },
	      goals,
	    })
	    const updateResult = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "update_goal",
	      arguments: { status: "complete" },
	      goals,
	    })

	    expect(getResult.status).toBe("completed")
	    expect(JSON.parse(getResult.output)).toMatchObject({ goal: null, remainingTokens: null })
	    expect(JSON.parse(createResult.output)).toMatchObject({ goal: { objective: "ship goal", status: "active" }, remainingTokens: 100 })
	    expect(JSON.parse(updateResult.output)).toMatchObject({ goal: { status: "complete" }, completionBudgetReport: expect.stringContaining("structured goal fields") })
	    expect(calls).toEqual([
	      "get:session-1",
	      "create:session-1:ship goal:100",
	      "update:session-1:complete",
	    ])
	  })

  test("create_word_document uses the real Word toolchain and writes a DOCX artifact", async () => {
    const root = await tempDir("chipmate-real-create-word-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "annual-business-review.docx",
        spec: {
          metadata: {
            title: "年度经营分析",
            documentType: "business-report",
            language: "zh-CN",
            generatedAt: "2026-06-28T00:00:00.000Z",
            author: "ChipMate Document Agent",
          },
          sources: [],
          layout: {
            preset: "standard_business_brief",
            navigation: { mode: "static-toc" },
          },
          cover: {
            title: "年度经营分析",
            subtitle: "本地 Word v1 真实工具链验收",
            preparedFor: "Management Review",
            preparedBy: "ChipMate",
          },
          sections: [{
            id: "overview",
            level: 1,
            title: "经营概览",
            paragraphs: ["本节概述年度经营表现。"],
            lists: [{
              kind: "bullet",
              items: [{ text: "收入增长" }, { text: "成本可控" }],
            }],
            tables: [{
              headers: ["指标", "结果"],
              rows: [["收入", "增长"], ["成本", "稳定"]],
              columnWidthRatios: [35, 65],
            }],
          }],
          references: [],
          qualityChecklist: {
            assumptions: ["输入数据来自用户提供的经营材料。"],
            limitations: ["该测试只验证真实 DOCX artifact 写出。"],
            missingInputs: [],
            risks: [],
          },
        },
      },
    })

    expect(result).toMatchObject({
      title: expect.stringContaining("Created Word document"),
      approved: true,
      status: "completed",
    })
    const payload = JSON.parse(result.output) as {
      answerSummary: string
      nextActions: Array<{ tool: string; args?: { path?: string } }>
      data: { path: string; absolutePath: string; title: string; renderCheckResult: { ok: boolean; attempted: boolean } }
    }
    expect(payload.answerSummary).toContain("Created Word document: .chipmate/docs/")
    expect(payload.data.path).toMatch(/^\.chipmate\/docs\/annual-business-review-\d{8}-\d{6}\.docx$/)
    expect(payload.nextActions).toContainEqual(expect.objectContaining({
      tool: "render_word_document",
      args: { path: payload.data.path },
    }))
    expect(payload.data.absolutePath).toBe(join(root, payload.data.path))
    expect(payload.data.title).toBe("年度经营分析")
    expect(payload.data.renderCheckResult.ok).toBe(true)
    expect(typeof payload.data.renderCheckResult.attempted).toBe("boolean")
    const bytes = await readFile(payload.data.absolutePath)
    expect(bytes.length).toBeGreaterThan(1000)
    expect(Buffer.from(bytes.subarray(0, 2)).toString("utf8")).toBe("PK")
  }, 20_000)

  test("create_word_document rejects stringified WordDocSpec objects", async () => {
    const root = await tempDir("chipmate-real-create-word-string-spec-rejected-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const outputLines: string[] = []
    const runtime = new ToolRuntime(
      { append: async () => undefined } as never,
      { appendLine: (line: string) => outputLines.push(line) } as never,
    )

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "string-spec.docx",
        spec: JSON.stringify(minimalWordDocSpecForTest("String Spec Document")),
      },
    })

    expect(result.status).toBe("failed")
    const payload = JSON.parse(result.output) as { data: { errorCode: string; diagnostic: { specType: string; legacyStringSpec: boolean; argumentBytes: number }; expectedShape: unknown } }
    expect(payload.data.errorCode).toBe("word-doc-spec-string-disallowed")
    expect(payload.data.diagnostic).toMatchObject({ specType: "string", legacyStringSpec: true })
    expect(payload.data.diagnostic.argumentBytes).toBeGreaterThan(0)
    expect(payload.data.expectedShape).toBeTruthy()
    expect(outputLines.join("\n")).toContain("legacyStringSpec=true")
    expect(outputLines.join("\n")).toContain("errorCode=word-doc-spec-string-disallowed")
  })

  test("create_word_document rejects malformed string spec with diagnostic shape fields", async () => {
    const root = await tempDir("chipmate-real-create-word-malformed-string-spec-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const outputLines: string[] = []
    const runtime = new ToolRuntime(
      { append: async () => undefined } as never,
      { appendLine: (line: string) => outputLines.push(line) } as never,
    )

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "bad-string-spec.docx",
        spec: "{\"metadata\":{\"title\":\"Bad\"},\"sections\":[",
      },
    })

    expect(result.status).toBe("failed")
    const payload = JSON.parse(result.output) as { data: { errorCode: string; diagnostic: { specType: string; legacyStringSpec: boolean; argumentBytes: number } } }
    expect(payload.data.errorCode).toBe("word-doc-spec-string-disallowed")
    expect(payload.data.diagnostic).toMatchObject({ specType: "string", legacyStringSpec: true })
    expect(payload.data.diagnostic.argumentBytes).toBeGreaterThan(0)
    expect(outputLines.join("\n")).toContain("legacyStringSpec=true")
    expect(outputLines.join("\n")).toContain("errorCode=word-doc-spec-string-disallowed")
  })

  test("create_word_document defaults missing sources to an empty array", async () => {
    const root = await tempDir("chipmate-real-create-word-missing-sources-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const spec = minimalWordDocSpecForTest("Missing Sources Default")
    delete (spec as { sources?: unknown }).sources

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "missing-sources.docx",
        spec,
      },
    })

    expect(result.status).toBe("completed")
    const payload = JSON.parse(result.output) as { data: { absolutePath: string; sourceCount: number; title: string } }
    expect(payload.data.title).toBe("Missing Sources Default")
    expect(payload.data.sourceCount).toBe(0)
    expect((await readFile(payload.data.absolutePath)).length).toBeGreaterThan(1000)
  }, 20_000)

  test("create_word_document accepts legacy text-object paragraphs and top-level navigation without retry", async () => {
    const root = await tempDir("chipmate-real-create-word-legacy-shape-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const spec = minimalWordDocSpecForTest("Legacy Shape")
    ;(spec as { navigation?: unknown }).navigation = { toc: true, tocDepth: 3 }
    ;(spec.sections[0] as unknown as { paragraphs: unknown[]; bullets: unknown[]; numberedItems: unknown[] }).paragraphs = [
      { text: "模型有时会把普通段落写成带 text 字段的对象；工具入口应把这种等价形态收敛成字符串。" },
      "已经是字符串的段落必须保持不变。",
    ]
    ;(spec.sections[0] as unknown as { paragraphs: unknown[]; bullets: unknown[]; numberedItems: unknown[] }).bullets = [
      { text: "兼容 bullet 的 text 对象。" },
    ]
    ;(spec.sections[0] as unknown as { paragraphs: unknown[]; bullets: unknown[]; numberedItems: unknown[] }).numberedItems = [
      { text: "兼容 numberedItems 的 text 对象。" },
    ]

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "legacy-shape.docx",
        spec,
      },
    })

    expect(result.status).toBe("completed")
    const payload = JSON.parse(result.output) as { data: { absolutePath: string; title: string } }
    expect(payload.data.title).toBe("Legacy Shape")
    expect((await readFile(payload.data.absolutePath)).length).toBeGreaterThan(1000)
  }, 20_000)

  test("create_word_document rejects unsupported paragraph object shape before Word builder", async () => {
    const root = await tempDir("chipmate-real-create-word-invalid-paragraph-shape-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const spec = minimalWordDocSpecForTest("Invalid Paragraph Shape")
    ;(spec.sections[0] as unknown as { paragraphs: unknown[] }).paragraphs = [{ body: "不是支持的段落对象形态。" }]

    const result = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "invalid-paragraph-shape.docx",
        spec,
      },
    })

    expect(result.status).toBe("failed")
    const payload = JSON.parse(result.output) as { data: { errorCode: string; validationErrors: string[]; diagnostic: { specShapeHash: string; sections: number } }; gaps: string[] }
    expect(payload.data.errorCode).toBe("word-doc-spec-validation-failed")
    expect(payload.data.validationErrors).toContain("sections[0].paragraphs[0]: expected string, got object keys=body.")
    expect(payload.gaps).toContain("sections[0].paragraphs[0]: expected string, got object keys=body.")
    expect(payload.data.diagnostic.sections).toBe(1)
    expect(payload.data.diagnostic.specShapeHash).toMatch(/^[0-9a-f]{8}$/)
  })

  test("create_word_document returns structured diagnostics when spec is missing or invalid", async () => {
    const root = await tempDir("chipmate-real-create-word-invalid-spec-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const missing = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: { filename: "missing-spec.docx" },
    })
    const missingPayload = JSON.parse(missing.output) as { data: { errorCode: string; expectedShape: unknown; receivedArgumentKeys: string[] }; gaps: string[] }
    expect(missing.status).toBe("failed")
    expect(missingPayload.data.errorCode).toBe("word-doc-spec-missing")
    expect(missingPayload.data.expectedShape).toEqual(expect.objectContaining({ metadata: expect.any(Object), sources: [], sections: expect.any(Array) }))
    expect(missingPayload.data.receivedArgumentKeys).toEqual(["filename"])
    expect(missingPayload.gaps[0]).toContain("Missing required argument: spec")

    const invalid = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "invalid-spec.docx",
        spec: { metadata: {}, sections: [] },
      },
    })
    const invalidPayload = JSON.parse(invalid.output) as { data: { errorCode: string; validationErrors: string[] }; gaps: string[] }
    expect(invalid.status).toBe("failed")
    expect(invalid.output).not.toBe("Missing or invalid WordDocSpec.")
    expect(invalidPayload.data.errorCode).toBe("word-doc-spec-validation-failed")
    expect(invalidPayload.data.validationErrors).toEqual(expect.arrayContaining([
      "WordDocSpec metadata.title is required.",
      "WordDocSpec metadata.documentType is required.",
      "WordDocSpec must include sections.",
    ]))
    expect(invalidPayload.gaps).toEqual(expect.arrayContaining(["WordDocSpec metadata.title is required."]))
  })

  test("render_word_document runs as a public ToolRuntime visual QA tool", async () => {
    const root = await tempDir("chipmate-real-render-word-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const created = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "render-target.docx",
        spec: {
          metadata: {
            title: "Render Target",
            documentType: "render-smoke",
            language: "en-US",
            generatedAt: "2026-06-28T00:00:00.000Z",
          },
          sources: [],
          layout: {
            preset: "standard_business_brief",
          },
          sections: [{
            id: "overview",
            level: 1,
            title: "Overview",
            paragraphs: [
              "This document is rendered through the standalone public visual QA tool so the model can inspect layout evidence without changing the source file.",
              "The smoke document includes enough body text to pass the document quality gate while keeping the test focused on render artifact exposure.",
            ],
            lists: [{
              kind: "bullet",
              items: [
                { text: "Generate a local DOCX artifact first." },
                { text: "Run render_word_document as an independent visual QA step." },
                { text: "Return PDF and page PNG evidence when local render tools are available." },
              ],
            }],
          }],
          references: [],
          qualityChecklist: {
            assumptions: [],
            limitations: [],
            missingInputs: [],
            risks: [],
          },
        },
      },
    })
    if (created.status !== "completed") {
      throw new Error(created.output)
    }
    expect(created.status).toBe("completed")
    const createdPayload = JSON.parse(created.output) as { data: { path: string; absolutePath: string } }

    const rendered = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "render_word_document",
      arguments: {
        path: createdPayload.data.path,
        artifactNameBase: "render-tool-smoke",
        timeoutMs: 5_000,
      },
    })

    expect(rendered.approved).toBe(true)
    expect(rendered.status).toBe("completed")
    expect(rendered.artifacts).toEqual([
      expect.objectContaining({
        kind: "word-render",
        payload: expect.objectContaining({
          kind: "word-render",
          path: createdPayload.data.path,
          absolutePath: createdPayload.data.absolutePath,
          renderCheckResult: expect.objectContaining({
            ok: expect.any(Boolean),
            attempted: expect.any(Boolean),
          }),
        }),
      }),
    ])
    const payload = JSON.parse(rendered.output) as {
      answerSummary: string
      data: { renderCheckResult: { ok: boolean; attempted: boolean; pagePngPaths?: string[]; pdfArtifactPath?: string; visualQaStatus?: string; skipReason?: string } }
      coverage: string
      gaps: string[]
    }
    expect(payload.answerSummary).toContain("Word document")
    expect(typeof payload.data.renderCheckResult.ok).toBe("boolean")
    if (payload.data.renderCheckResult.attempted && (payload.data.renderCheckResult.pagePngPaths?.length ?? 0) > 0) {
      expect(payload.coverage).toBe("complete")
      expect(payload.data.renderCheckResult.pagePngPaths?.[0]).toMatch(/^\.chipmate\/docs\/rendered\/render-tool-smoke-/)
    } else {
      expect(payload.coverage).toBe("partial")
      expect(payload.answerSummary).toContain("Page-level visual QA skipped")
      expect(payload.data.renderCheckResult.visualQaStatus).toBe("skipped")
      expect(payload.data.renderCheckResult.skipReason).toBeTruthy()
      expect(payload.gaps.length).toBeGreaterThan(0)
    }
  }, 30_000)

  test("render_word_document reads the configured remote endpoint from ToolRuntime and renders pages", async () => {
    const root = await tempDir("chipmate-configured-remote-render-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const docxPath = join(root, "configured-render.docx")
    await writeFile(docxPath, docxFixture("Configured remote render target"))
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = (await listen(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/render/word") {
        response.writeHead(404).end()
        return
      }
      requests.push({ url: request.url, body: await collectJson(request) })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        ok: true,
        pageCount: 1,
        pdf: { contentType: "application/pdf", base64: Buffer.from("%PDF-1.4\n% ChipMate test\n").toString("base64") },
        pages: [{
          page: 1,
          contentType: "image/png",
          base64: Buffer.from(tinyPngBytes()).toString("base64"),
          width: 1,
          height: 1,
          visualSummary: { totalPixels: 1, inkPixels: 1, inkRatio: 1 },
        }],
        issues: [],
        renderer: { kind: "remote-opencode", docxToPdf: "libreoffice", pdfToPng: "pdftoppm" },
      }))
    })).replace(/\/v1$/, "")
    configurationValues["chipmate.wordRender.remoteEndpoint"] = baseUrl
    const outputLines: string[] = []
    const runtime = new ToolRuntime({ append: async () => undefined } as never, { appendLine: (line: string) => outputLines.push(line), append: () => undefined } as never)

    const rendered = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "render_word_document",
      arguments: {
        path: "configured-render.docx",
        artifactNameBase: "configured-render",
        timeoutMs: 5_000,
      },
    })

    expect(rendered.status).toBe("completed")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.filename).toBe("configured-render.docx")
    expect(outputLines.some((line) => line.includes("[word-render] remote endpoint configured"))).toBe(true)
    expect(outputLines.some((line) => line.includes("[word-agent] rendered Word document through remote endpoint"))).toBe(true)
    const payload = JSON.parse(rendered.output) as {
      coverage: string
      data: { renderCheckResult: { attempted: boolean; visualQaStatus?: string; remoteEndpoint?: string; pagePngPaths?: string[]; pdfArtifactPath?: string } }
    }
    expect(payload.coverage).toBe("complete")
    expect(payload.data.renderCheckResult.attempted).toBe(true)
    expect(payload.data.renderCheckResult.visualQaStatus).toBe("completed")
    expect(payload.data.renderCheckResult.remoteEndpoint).toBe(`${baseUrl}/render/word`)
    expect(payload.data.renderCheckResult.pdfArtifactPath).toMatch(/^\.chipmate\/docs\/rendered\/configured-render-.+\/document\.pdf$/)
    expect(payload.data.renderCheckResult.pagePngPaths?.[0]).toMatch(/^\.chipmate\/docs\/rendered\/configured-render-.+\/page-1\.png$/)
    expect((await readFile(join(root, payload.data.renderCheckResult.pagePngPaths![0]))).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
  })

  test("create_word_document passes the configured remote endpoint to its internal render check", async () => {
    const root = await tempDir("chipmate-create-word-configured-render-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = (await listen(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/render/word") {
        response.writeHead(404).end()
        return
      }
      requests.push({ url: request.url, body: await collectJson(request) })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        ok: true,
        pageCount: 1,
        pdf: { contentType: "application/pdf", base64: Buffer.from("%PDF-1.4\n% ChipMate test\n").toString("base64") },
        pages: [{
          page: 1,
          contentType: "image/png",
          base64: Buffer.from(tinyPngBytes()).toString("base64"),
          width: 1,
          height: 1,
          visualSummary: { totalPixels: 1, inkPixels: 1, inkRatio: 1 },
        }],
        issues: [],
        renderer: { kind: "remote-opencode", docxToPdf: "libreoffice", pdfToPng: "pdftoppm" },
      }))
    })).replace(/\/v1$/, "")
    configurationValues["chipmate.wordRender.remoteEndpoint"] = baseUrl
    const outputLines: string[] = []
    const runtime = new ToolRuntime({ append: async () => undefined } as never, { appendLine: (line: string) => outputLines.push(line), append: () => undefined } as never)

    const created = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "configured-create.docx",
        spec: minimalWordDocSpecForTest("配置远端渲染的创建文档"),
      },
    })

    expect(created.status).toBe("completed")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.filename).toMatch(/^configured-create-\d{8}-\d{6}\.docx$/)
    expect(outputLines.some((line) => line.includes("[word-doc] internal render endpoint configured"))).toBe(true)
    const payload = JSON.parse(created.output) as {
      gaps: string[]
      data: { warnings: string[]; renderCheckResult: { visualQaStatus?: string; remoteEndpoint?: string; pagePngPaths?: string[] } }
    }
    expect(payload.data.renderCheckResult.visualQaStatus).toBe("completed")
    expect(payload.data.renderCheckResult.remoteEndpoint).toBe(`${baseUrl}/render/word`)
    expect(payload.data.renderCheckResult.pagePngPaths?.[0]).toMatch(/^\.chipmate\/docs\/rendered\/configured-create-.+\/page-1\.png$/)
    expect([...payload.gaps, ...payload.data.warnings].join("\n")).not.toContain("remote-unconfigured")
    expect([...payload.gaps, ...payload.data.warnings].join("\n")).not.toContain("page-level visual QA was skipped")
  })

  test("extract_xlsx_table returns a TableSpec that can be used by create_word_document", async () => {
    const root = await tempDir("chipmate-xlsx-table-spec-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const workbookPath = join(root, "metrics.xlsx")
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet("Summary")
    sheet.addRow(["Metric", "Count", "Formula"])
    sheet.addRow(["Boards", 3, { formula: "B2*2", result: 6 }])
    sheet.addRow(["Units", 5, { formula: "B3*2", result: 10 }])
    await workbook.xlsx.writeFile(workbookPath)
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const extracted = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "extract_xlsx_table",
      arguments: {
        path: "metrics.xlsx",
        sheetName: "Summary",
        range: "A1:C3",
      },
    })
    expect(extracted.status).toBe("completed")
    const extractedPayload = JSON.parse(extracted.output) as {
      data: {
        sourceRange: string
        table: { headers: string[]; rows: string[][]; repeatHeader: boolean; columnWidthRatios: number[] }
      }
      gaps: string[]
    }
    expect(extractedPayload.data.sourceRange).toBe("A1:C3")
    expect(extractedPayload.data.table.headers).toEqual(["Metric", "Count", "Formula"])
    expect(extractedPayload.data.table.rows).toEqual([["Boards", "3", "6"], ["Units", "5", "10"]])
    expect(extractedPayload.data.table.repeatHeader).toBe(true)
    expect(extractedPayload.data.table.columnWidthRatios).toHaveLength(3)
    expect(extractedPayload.gaps).toEqual([])

    const created = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "metrics-report.docx",
        spec: {
          metadata: {
            title: "Metrics Report",
            documentType: "spreadsheet-backed-report",
            language: "en-US",
            generatedAt: "2026-06-28T00:00:00.000Z",
          },
          sources: [{ id: "metrics-xlsx", title: "metrics.xlsx", path: "metrics.xlsx" }],
          cover: {
            title: "Metrics Report",
            subtitle: "Spreadsheet-backed Word table smoke test",
            preparedBy: "ChipMate",
          },
          sections: [{
            id: "metrics",
            level: 1,
            title: "Metrics",
            paragraphs: [
              "Spreadsheet data is inserted as a real Word table so the model can still choose surrounding document structure, section placement, and explanatory prose.",
              "This test intentionally keeps spreadsheet conversion bounded to simple rectangular data while proving that the returned TableSpec is accepted by the generic Word document pipeline.",
            ],
            tables: [extractedPayload.data.table],
          }],
          qualityChecklist: {
            assumptions: ["The selected worksheet range is a simple rectangular table with one header row."],
            limitations: ["Spreadsheet styling and formula recalculation are intentionally out of scope for this helper."],
            missingInputs: [],
            risks: [],
          },
        },
      },
    })
    expect(created.status, created.output).toBe("completed")
    const createdPayload = JSON.parse(created.output) as { data: { absolutePath: string } }
    expect((await readFile(createdPayload.data.absolutePath)).subarray(0, 2).toString()).toBe("PK")
  }, 20_000)

  test("export_word_table_to_csv writes a CSV artifact from an inspected Word table", async () => {
    const root = await tempDir("chipmate-word-table-csv-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const docxPath = join(root, "guideline-table.docx")
    await writeFile(docxPath, cGuidelineDocxFixture({
      title: "Guideline",
      sections: [{ heading: "Tables", paragraphs: ["Export this table."] }],
      tableRows: [
        ["Naming", "Use clear names"],
        ["Comma", "Value, with comma"],
        ["Quote", "Use \"quoted\" text"],
      ],
    }))
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const exported = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "export_word_table_to_csv",
      arguments: {
        path: "guideline-table.docx",
        tableIndex: 1,
        outputFilenameBase: "guideline-table-export",
      },
    })

    expect(exported.status).toBe("completed")
    const payload = JSON.parse(exported.output) as {
      data: { path: string; absolutePath: string; rowCount: number; columnCount: number; tableIndex: number }
      evidence: Array<{ path: string; kind: string }>
    }
    expect(payload.data).toMatchObject({
      path: ".chipmate/docs/tables/guideline-table-export.csv",
      absolutePath: join(root, ".chipmate", "docs", "tables", "guideline-table-export.csv"),
      rowCount: 4,
      columnCount: 2,
      tableIndex: 1,
    })
    expect(payload.evidence).toEqual([{ path: payload.data.path, kind: "csv-table" }])
    expect(await readFile(payload.data.absolutePath, "utf8")).toBe([
      "规则,说明",
      "Naming,Use clear names",
      "Comma,\"Value, with comma\"",
      "Quote,\"Use \"\"quoted\"\" text\"",
      "",
    ].join("\n"))
  })

  test("v1 local Word user path runs through ToolRuntime create inspect edit render and style audit", async () => {
    const root = await tempDir("chipmate-v1-toolruntime-word-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const pngBase64 = Buffer.from(tinyPngBytes()).toString("base64")

    const created = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "create_word_document",
      arguments: {
        filename: "v1-toolruntime-word-smoke.docx",
        spec: {
          metadata: {
            title: "ToolRuntime Word v1 smoke",
            documentType: "local-word-v1-smoke",
            language: "en-US",
            generatedAt: "2026-06-28T00:00:00.000Z",
            author: "ChipMate Documents Skill",
          },
          sources: [],
          layout: {
            preset: "narrative_proposal",
            navigation: { mode: "static-toc", includeTopBottomLinks: true, includeBackToTocLinks: true },
            visualQa: { requireRender: true, requirePagePngReview: true },
          },
          cover: {
            title: "ToolRuntime Word v1 smoke",
            subtitle: "Create, inspect, edit, render, and audit through public Word tools",
            preparedBy: "ChipMate",
          },
          sections: [{
            id: "overview",
            level: 1,
            title: "Overview",
            paragraphs: [
              "Draft overview paragraph for locator editing.",
              "This local report is generated from a model-owned WordDocSpec.",
            ],
            lists: [{
              kind: "numbered",
              items: [{ text: "Plan the document" }, { text: "Generate real Word structure" }, { text: "Verify artifacts" }],
            }],
            tables: [{
              caption: "Smoke workflow coverage.",
              headers: ["Workflow", "Evidence"],
              rows: [
                ["New document", "create_word_document writes a local .docx"],
                ["Inspection", "inspect_word_document returns locators"],
                ["Edit", "apply_word_document_edits writes a checked copy"],
              ],
              columnWidthRatios: [35, 65],
            }],
            figures: [{
              title: "Smoke PNG figure",
              caption: "PNG figure inserted in the section that owns it.",
              label: "Figure",
              bookmark: "fig_toolruntime_smoke",
              altText: "ToolRuntime smoke PNG",
              image: {
                contentType: "image/png",
                base64: pngBase64,
                width: 32,
                height: 16,
              },
            }],
          }],
          references: [],
          qualityChecklist: {
            assumptions: ["The model chooses content and layout before calling create_word_document."],
            limitations: ["This smoke covers the v1 local Word path, not every v2 OOXML edge case."],
            missingInputs: [],
            risks: [],
          },
        },
      },
    })
    expect(created.status).toBe("completed")
    const createdPayload = JSON.parse(created.output) as {
      gaps: string[]
      data: {
        path: string
        absolutePath: string
        renderCheckResult: { ok: boolean; attempted: boolean; pagePngPaths?: string[] }
      }
    }
    expect(createdPayload.data.path).toMatch(/^\.chipmate\/docs\/v1-toolruntime-word-smoke-\d{8}-\d{6}\.docx$/)
    expect(createdPayload.data.absolutePath).toBe(join(root, createdPayload.data.path))
    await expectRenderAttemptOrHonestFallback(root, createdPayload)
    expect((await readFile(createdPayload.data.absolutePath)).subarray(0, 2).toString()).toBe("PK")

    const readResult = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "read_docx",
      arguments: { path: createdPayload.data.path },
    })
    expect(readResult.status).toBe("completed")
    const readPayload = JSON.parse(readResult.output) as { data: { blocks: unknown[]; metadata: { path: string } } }
    expect(readPayload.data.metadata.path).toBe(createdPayload.data.path)
    expect(readPayload.data.blocks.length).toBeGreaterThan(0)

    const inspected = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "inspect_word_document",
      arguments: { path: createdPayload.data.path },
    })
    expect(inspected.status).toBe("completed")
    const inspectionPayload = JSON.parse(inspected.output) as {
      data: {
        documentEndLocator: Record<string, unknown>
        summary: {
          tableCount: number
          listItemCount: number
          imageCount: number
          captionCount: number
          fieldCount: number
        }
        paragraphs: Array<{ text: string; locator: Record<string, unknown> }>
      }
    }
    const inspection = inspectionPayload.data
    expect(inspection.summary.tableCount).toBeGreaterThanOrEqual(1)
    expect(inspection.summary.listItemCount).toBeGreaterThanOrEqual(3)
    expect(inspection.summary.imageCount).toBe(1)
    expect(inspection.summary.captionCount).toBeGreaterThanOrEqual(1)
    expect(inspection.summary.fieldCount).toBeGreaterThan(0)
    const overviewParagraph = inspection.paragraphs.find((item) => item.text === "Draft overview paragraph for locator editing.")
    expect(overviewParagraph).toBeDefined()

    const edited = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "apply_word_document_edits",
      arguments: {
        path: createdPayload.data.path,
        plan: {
          planId: "toolruntime-v1-word-smoke-edit",
          targetPath: createdPayload.data.path,
          outputFilenameBase: "v1-toolruntime-word-smoke-edited",
          operations: [
            {
              type: "addComment",
              locator: overviewParagraph!.locator,
              text: "Reviewer note inserted through apply_word_document_edits.",
              author: "Reviewer",
              initials: "RV",
            },
            {
              type: "insertSection",
              locator: inspection.documentEndLocator,
              title: "Follow-up Evidence",
              level: 1,
              paragraphs: ["This section was inserted into an existing .docx using inspected locators."],
              lists: [{ kind: "checklist", items: [{ text: "Confirm generated DOCX", checked: true }, { text: "Confirm edited DOCX" }] }],
              tables: [{
                headers: ["Artifact", "Status"],
                rows: [["Generated DOCX", "Present"], ["Edited DOCX", "Present"]],
                columnWidthRatios: [45, 55],
              }],
              figures: [{
                title: "Inserted smoke PNG",
                caption: "PNG inserted during the edit path.",
                label: "Figure",
                altText: "Inserted ToolRuntime smoke PNG",
                image: {
                  contentType: "image/png",
                  base64: pngBase64,
                  width: 32,
                  height: 16,
                },
              }],
            },
          ],
          warnings: [],
        },
      },
    })
    expect(edited.status).toBe("completed")
    const editedPayload = JSON.parse(edited.output) as {
      gaps: string[]
      data: {
        path: string
        absolutePath: string
        appliedOperations: Array<{ type: string }>
        structureCheckResult: { ok: boolean }
        renderCheckResult: { ok: boolean; attempted: boolean; pagePngPaths?: string[] }
      }
    }
    expect(editedPayload.data.path).toMatch(/^\.chipmate\/docs\/v1-toolruntime-word-smoke-edited-\d{8}-\d{6}\.docx$/)
    expect(editedPayload.data.appliedOperations.map((operation) => operation.type)).toEqual(["addComment", "insertSection"])
    expect(editedPayload.data.structureCheckResult.ok).toBe(true)
    await expectRenderAttemptOrHonestFallback(root, editedPayload)

    const editedInspectionResult = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "inspect_word_document",
      arguments: { path: editedPayload.data.path },
    })
    const editedInspection = (JSON.parse(editedInspectionResult.output) as {
      data: { summary: { commentCount: number; tableCount: number; imageCount: number; listItemCount: number }; paragraphs: Array<{ text: string }> }
    }).data
    expect(editedInspection.summary.commentCount).toBe(1)
    expect(editedInspection.summary.tableCount).toBeGreaterThanOrEqual(2)
    expect(editedInspection.summary.imageCount).toBe(2)
    expect(editedInspection.summary.listItemCount).toBeGreaterThanOrEqual(5)
    expect(editedInspection.paragraphs.some((item) => item.text === "Follow-up Evidence")).toBe(true)

    const styleAudit = await runtime.execute({
      sessionID: "session-1",
      mode: "auto",
      name: "audit_word_document_styles",
      arguments: { path: editedPayload.data.path },
    })
    expect(styleAudit.status).toBe("completed")
    const stylePayload = JSON.parse(styleAudit.output) as { data: { inputPath: string; paragraphCount: number; runCount: number } }
    expect(stylePayload.data.inputPath).toBe(editedPayload.data.path)
    expect(stylePayload.data.paragraphCount).toBeGreaterThan(0)
    expect(stylePayload.data.runCount).toBeGreaterThan(0)
  }, 20_000)

	  test("blocks goal tools without session-scoped goal handlers and validates status and budgets", async () => {
	    const runtime = new ToolRuntime({ append: async () => undefined } as never)
	    const unavailable = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "get_goal",
	      arguments: {},
	    })
	    const missingSession = await runtime.execute({
	      mode: "auto",
	      name: "get_goal",
	      arguments: {},
	      goals: {
	        getGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        createGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        updateGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	      },
	    })
	    const badBudget = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "create_goal",
	      arguments: { objective: "budget", token_budget: 0 },
	      goals: {
	        getGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        createGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        updateGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	      },
	    })
	    const badStatus = await runtime.execute({
	      sessionID: "session-1",
	      mode: "auto",
	      name: "update_goal",
	      arguments: { status: "paused" },
	      goals: {
	        getGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        createGoal: async () => ({ goal: null, remainingTokens: null, completionBudgetReport: null }),
	        updateGoal: async (_sessionID, input) => {
	          if (input.status !== "complete" && input.status !== "blocked") throw new Error("invalid status")
	          return { goal: null, remainingTokens: null, completionBudgetReport: null }
	        },
	      },
	    })

	    expect(unavailable.status).toBe("failed")
	    expect(unavailable.error).toContain("goal tools unavailable")
	    expect(missingSession.status).toBe("failed")
	    expect(missingSession.error).toContain("missing sessionID")
	    expect(badBudget.status).toBe("failed")
	    expect(badBudget.error).toContain("budgets must be positive")
	    expect(badStatus.status).toBe("failed")
	    expect(badStatus.error).toContain("invalid status")
	  })

	  test("creates draw.io diagrams without workspace writes or approval", async () => {
	    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const result = await runtime.execute({
      name: "chipmate_create_drawio_diagram",
      mode: "auto",
      arguments: {
        title: "Tool diagram",
        diagramType: "flowchart",
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        edges: [{ source: "a", target: "b", label: "next" }],
      },
    })

    expect(result.status).toBe("completed")
    expect(result.approved).toBe(true)
    expect(result.requiresApproval).toBeUndefined()
    const payload = JSON.parse(result.output)
    expect(payload.kind).toBe("drawio")
    expect(payload.diagramId).toStartWith("drawio-")
    expect(payload.mxGraphModelXml).toBeUndefined()
    expect(payload.hasChatDiagramArtifact).toBe(true)
    expect(payload.layoutEngine).toBe("elk")
    expect(payload.counts).toMatchObject({ nodes: 2, edges: 1, containers: 0 })
    expect(payload.assistantInstruction).toContain("do not repeat the XML")
    expect(result.artifacts?.[0]?.kind).toBe("drawio")
    expect(result.artifacts?.[0]?.payload.mxGraphModelXml).toContain("<mxGraphModel")
    expect(result.artifacts?.[0]?.payload.mxGraphModelXml).toContain('source="n-a"')
	    expect(result.artifacts?.[0]?.payload.normalizedSpec.layoutEngine).toBe("elk")
	  })

	  test("renders Mermaid diagrams to .mmd and PNG artifacts for Word figures", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    setMermaidPngRendererForTest(async (input) => {
	      expect(input.source).toContain("flowchart TD")
	      expect(input.outputPath).toMatch(/\.png$/)
	      expect(input.scale).toBe(3)
	      await writeFile(input.outputPath!, tinyPngBytes())
	      return {
	        bytes: tinyPngBytes(),
	        width: 320,
	        height: 180,
	        pixelWidth: 960,
	        pixelHeight: 540,
	        scale: 3,
	        contentBounds: { x: 8, y: 10, width: 300, height: 160 },
	        cropBounds: { x: 0, y: 0, width: 320, height: 180 },
	        padding: 32,
	        contentCropRatio: 0.83,
	        artifactPath: input.outputPath,
	      }
	    })
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const result = await runtime.execute({
      name: "chipmate_render_mermaid_diagram",
      mode: "full-access",
      arguments: {
	        title: "Mermaid tool flow",
	        diagramId: "word-flow",
	        artifactNameBase: "word-flow",
	        source: "flowchart TD\n  A[Start] --> B[Done]",
	        scale: 3,
	      },
	    })

	    expect(result.status).toBe("completed")
	    expect(result.approved).toBe(true)
	    expect(result.artifacts?.[0]?.kind).toBe("mermaid")
	    const payload = JSON.parse(result.output)
	    expect(payload.data.mmdPath).toMatch(/\.chipmate\/docs\/diagrams\/word-flow-.+\.mmd/)
	    expect(payload.data.pngPath).toMatch(/\.chipmate\/docs\/diagrams\/word-flow-.+\.png/)
	    expect(payload.data.figure.image).toMatchObject({
	      contentType: "image/png",
	      path: payload.data.pngPath,
	      artifactPath: payload.data.pngPath,
	      width: 320,
	      height: 180,
	    })
	    expect(payload.data.pixelWidth).toBe(960)
	    expect(payload.data.pixelHeight).toBe(540)
	    expect(payload.data.scale).toBe(3)
	    expect(payload.data.contentBounds).toEqual({ x: 8, y: 10, width: 300, height: 160 })
	    expect(payload.data.cropBounds).toEqual({ x: 0, y: 0, width: 320, height: 180 })
	    expect(payload.data.figure.image.width).toBe(320)
	    expect(payload.data.figure.image.height).toBe(180)
	    expect(await readFile(join(root, payload.data.mmdPath), "utf8")).toContain("flowchart TD")
	    expect((await readFile(join(root, payload.data.pngPath))).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
	  })

	  test("renders Mermaid diagrams through the remote render server", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-remote-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const baseUrl = (await listen(async (request, response) => {
	      if (request.method !== "POST" || request.url !== "/render/mermaid") {
	        response.writeHead(404).end()
	        return
	      }
	      const body = await collectJson(request)
	      expect(body.source).toContain("flowchart TD")
	      expect(body.scale).toBe(3)
	      response.writeHead(200, { "content-type": "application/json" })
	      response.end(JSON.stringify({
	        ok: true,
	        png: { contentType: "image/png", base64: Buffer.from(tinyPngBytes()).toString("base64") },
	        width: 640,
	        height: 360,
	        pixelWidth: 1920,
	        pixelHeight: 1080,
	        scale: 3,
	        contentBounds: { x: 20, y: 20, width: 600, height: 320 },
	        cropBounds: { x: 0, y: 0, width: 640, height: 360 },
	        padding: 32,
	        contentCropRatio: 0.83,
	        issues: [],
	        renderer: { kind: "remote-opencode", diagramToPng: "mermaid-chromium" },
	      }))
	    })).replace(/\/v1$/, "")
	    const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	    process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = baseUrl
	    try {
	      const runtime = new ToolRuntime({ append: async () => undefined } as never)
	      const result = await runtime.execute({
	        name: "chipmate_render_mermaid_diagram",
	        mode: "full-access",
	        arguments: {
	          title: "Remote Mermaid tool flow",
	          diagramId: "remote-word-flow",
	          artifactNameBase: "remote-word-flow",
	          source: "flowchart TD\n  A[Start] --> B[Done]",
	          scale: 3,
	        },
	      })

	      expect(result.status).toBe("completed")
	      const payload = JSON.parse(result.output)
	      expect(payload.data.renderProvider).toBe("remote-opencode")
	      expect(payload.data.fallbackUsed).toBe(false)
	      expect(payload.data.pixelWidth).toBe(1920)
	      expect(payload.data.pixelHeight).toBe(1080)
	      expect(payload.data.scale).toBe(3)
	      expect(payload.data.contentBounds).toEqual({ x: 20, y: 20, width: 600, height: 320 })
	      expect(payload.data.cropBounds).toEqual({ x: 0, y: 0, width: 640, height: 360 })
	      expect(payload.data.figure.image.path).toBe(payload.data.pngPath)
	      expect(payload.data.figure.image.width).toBe(640)
	      expect(payload.data.figure.image.height).toBe(360)
	      expect((await readFile(join(root, payload.data.pngPath))).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
	    } finally {
	      if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	      else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
	    }
	  })

	  test("reports missing Mermaid scale metadata from older remote render servers", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-remote-old-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const baseUrl = (await listen(async (request, response) => {
	      if (request.method !== "POST" || request.url !== "/render/mermaid") {
	        response.writeHead(404).end()
	        return
	      }
	      const body = await collectJson(request)
	      expect(body.scale).toBe(3)
	      response.writeHead(200, { "content-type": "application/json" })
	      response.end(JSON.stringify({
	        ok: true,
	        png: { contentType: "image/png", base64: Buffer.from(tinyPngBytes()).toString("base64") },
	        width: 640,
	        height: 360,
	        issues: [],
	        renderer: { kind: "remote-opencode", diagramToPng: "mermaid-chromium" },
	      }))
	    })).replace(/\/v1$/, "")
	    const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	    process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = baseUrl
	    try {
	      const runtime = new ToolRuntime({ append: async () => undefined } as never)
	      const result = await runtime.execute({
	        name: "chipmate_render_mermaid_diagram",
	        mode: "full-access",
	        arguments: {
	          title: "Old remote Mermaid tool flow",
	          diagramId: "old-remote-word-flow",
	          artifactNameBase: "old-remote-word-flow",
	          source: "flowchart TD\n  A[Start] --> B[Done]",
	          scale: 3,
	        },
	      })

	      expect(result.status).toBe("completed")
	      const payload = JSON.parse(result.output)
	      expect(payload.data.pixelWidth).toBe(1)
	      expect(payload.data.pixelHeight).toBe(1)
	      expect(payload.data.scale).toBe(3)
	      expect(payload.data.warnings.join("\n")).toContain("mermaid-render-scale-metadata-missing")
	      expect(payload.data.warnings.join("\n")).toContain("mermaid-render-crop-metadata-missing")
	    } finally {
	      if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	      else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
	    }
	  })

	  test("fails Mermaid PNG rendering after remote infrastructure failure in remote-only mode", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-remote-fallback-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const baseUrl = (await listen(async (request, response) => {
	      if (request.method !== "POST" || request.url !== "/render/mermaid") {
	        response.writeHead(404).end()
	        return
	      }
	      await collectJson(request)
	      response.writeHead(503, { "content-type": "application/json" })
	      response.end(JSON.stringify({
	        ok: false,
	        issues: [{ severity: "error", code: "remote-unavailable", message: "mock remote Mermaid service unavailable" }],
	      }))
	    })).replace(/\/v1$/, "")
	    const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	    process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = baseUrl
	    try {
	      const runtime = new ToolRuntime({ append: async () => undefined } as never)
	      const result = await runtime.execute({
	        name: "chipmate_render_mermaid_diagram",
	        mode: "full-access",
	        arguments: {
	          title: "Fallback Mermaid tool flow",
	          diagramId: "fallback-word-flow",
	          artifactNameBase: "fallback-word-flow",
	          source: "flowchart TD\n  A[Start] --> B[Done]",
	        },
	      })

	      expect(result.status).toBe("failed")
	      expect(result.artifacts).toBeUndefined()
	      const payload = JSON.parse(result.output)
	      expect(payload.errorCode).toBe("remote-unavailable")
	      expect(payload.data.pngGenerated).toBe(false)
	      expect(payload.data.wordFigureUsable).toBe(false)
	      expect(payload.data.diagnostic.errorCode).toBe("remote-unavailable")
	      expect(payload.gaps.join("\n")).toContain("mock remote Mermaid service unavailable")
	      expect(JSON.stringify(payload.nextActions)).toContain("/render/mermaid")
	      expect(JSON.stringify(payload.nextActions)).toContain("without this diagram image")
	      expect(await readFile(join(root, payload.data.mmdPath), "utf8")).toContain("flowchart TD")
	    } finally {
	      if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	      else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
	    }
	  })

	  test("does not use local Mermaid rendering after remote parse failure", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-remote-parse-failure-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const parseMessage = "Parse error on line 26: Expecting DIAMOND_STOP, got SQE"
	    const baseUrl = (await listen(async (request, response) => {
	      if (request.method !== "POST" || request.url !== "/render/mermaid") {
	        response.writeHead(404).end()
	        return
	      }
	      await collectJson(request)
	      response.writeHead(200, { "content-type": "application/json" })
	      response.end(JSON.stringify({
	        ok: false,
	        issues: [{ severity: "error", code: "remote-render-failed", message: parseMessage }],
	      }))
	    })).replace(/\/v1$/, "")
	    const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	    process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = baseUrl
	    try {
	      const runtime = new ToolRuntime({ append: async () => undefined } as never)
	      const result = await runtime.execute({
	        name: "chipmate_render_mermaid_diagram",
	        mode: "full-access",
	        arguments: {
	          title: "Remote parse failure Mermaid tool flow",
	          diagramId: "remote-parse-failure-word-flow",
	          artifactNameBase: "remote-parse-failure-word-flow",
	          source: "flowchart TD\n  C5[\"是否有 C/C++<br/>文件变更?\"] C6[\"生成 compile.json\"]",
	        },
	      })

	      expect(result.status).toBe("failed")
	      expect(result.artifacts).toBeUndefined()
	      const payload = JSON.parse(result.output)
	      expect(payload.errorCode).toBe("remote-render-failed")
	      expect(payload.data.pngGenerated).toBe(false)
	      expect(payload.data.wordFigureUsable).toBe(false)
	      expect(payload.data.mustNotEmbedSourceAsFigure).toBe(true)
	      expect(payload.data.diagnostic.message).toContain("Parse error on line 26")
	      expect(payload.gaps.join("\n")).toContain("Parse error on line 26")
	      expect(JSON.stringify(payload.nextActions)).toContain("chipmate_render_mermaid_diagram")
	      expect(JSON.stringify(payload.nextActions)).not.toContain('"tool":"create_word_document"')
	      expect(await readFile(join(root, payload.data.mmdPath), "utf8")).toContain("C5")
	    } finally {
	      if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
	      else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
	    }
	  })

	  test("returns structured diagnostics and the written .mmd path when remote Mermaid PNG rendering is unconfigured", async () => {
	    const root = await tempDir("chipmate-mermaid-tool-fail-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const outputLines: string[] = []
	    const runtime = new ToolRuntime({ append: async () => undefined } as never, { appendLine: (line: string) => outputLines.push(line), append: () => undefined } as never)
	    const result = await runtime.execute({
	      name: "chipmate_render_mermaid_diagram",
	      mode: "full-access",
	      arguments: {
	        title: "Mermaid tool flow",
	        diagramId: "word-flow",
	        artifactNameBase: "word-flow",
	        source: "flowchart TD\n  A[Start] --> B[Done]",
	      },
	    })

	    expect(result.status).toBe("failed")
	    expect(result.artifacts).toBeUndefined()
	    const payload = JSON.parse(result.output)
	    expect(payload.errorCode).toBe("remote-unconfigured")
	    expect(payload.data.pngGenerated).toBe(false)
	    expect(payload.data.mmdPath).toMatch(/\.chipmate\/docs\/diagrams\/word-flow-.+\.mmd/)
	    expect(payload.data.expectedPngPath).toMatch(/\.chipmate\/docs\/diagrams\/word-flow-.+\.png/)
	    expect(payload.data.diagnostic.message).toContain("Remote Mermaid render server is not configured")
	    expect(payload.gaps.join("\n")).toContain("PNG artifact was not generated")
	    expect(payload.nextActions[0].action).toContain("remote render server")
	    expect(await readFile(join(root, payload.data.mmdPath), "utf8")).toContain("flowchart TD")
	    expect(outputLines.some((line) => line.includes("[mermaid-render] failed code=remote-unconfigured"))).toBe(true)
	  })

	  test("fails draw.io rendering when ELK fails instead of returning a fallback diagram", async () => {
    setDrawioElkLayoutRunnerForTest(async () => {
      throw new Error("mock elk unavailable")
    })
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const result = await runtime.execute({
      name: "chipmate_create_drawio_diagram",
      mode: "auto",
      arguments: {
        title: "Tool diagram",
        diagramType: "flowchart",
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        edges: [{ source: "a", target: "b", label: "next" }],
      },
    })

    expect(result.status).toBe("failed")
    expect(result.output).toContain("stage=elk.layout")
    expect(result.output).toContain("mock elk unavailable")
    expect(result.output).not.toContain("<mxGraphModel")
  })

  test("creates bounded clarification requests without approval", async () => {
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const result = await runtime.execute({
      name: "chipmate_ask_user_clarification",
      mode: "auto",
      arguments: {
        reason: "Need to know the diagram format.",
        questions: [{
          id: "diagram_type",
          question: "要画哪种图？",
          choices: [
            { id: "drawio", label: "draw.io" },
            { id: "mermaid", label: "Mermaid" },
          ],
        }],
      },
    })

    expect(result.status).toBe("user-input-required")
    expect(result.approved).toBe(true)
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        kind: "clarification",
        payload: expect.objectContaining({
          kind: "clarification",
          reason: "Need to know the diagram format.",
          questions: [expect.objectContaining({ id: "diagram_type", question: "要画哪种图？" })],
        }),
      }),
    ])
    expect(result.output).toContain("\"waiting_for_user\"")
  })

  test("validates DiagramIR with coverage gaps before rendering", async () => {
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const result = await runtime.execute({
      name: "chipmate_validate_diagram_ir",
      mode: "auto",
      arguments: {
        diagramIr: {
          title: "Entry flow",
          diagramType: "code-flow",
          nodes: [{ id: "entry", label: "entry" }, { id: "exit", label: "exit" }],
          edges: [{ source: "entry", target: "exit", label: "returns" }],
        },
      },
    })

    expect(result.status).toBe("completed")
    expect(result.approved).toBe(true)
    expect(result.requiresApproval).toBeUndefined()
    const payload = JSON.parse(result.output)
    expect(payload.ok).toBe(false)
    expect(payload.coverageReport.coverage).toBe("unknown")
    expect(payload.gaps.join("\n")).toContain("Complex diagram has no evidenceRefs")
    expect(payload.drawioSpec.diagramType).toBe("code-flow")
    expect(payload.nextEvidenceSuggestions[0].tool).toBe("chipmate_graph_expand_flow_slice")
  })

  test("reads active skill resources and audits skill policy context", async () => {
    const root = await tempDir("chipmate-tool-skill-resource-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const skillRoot = join(root, ".agents", "skills", "review")
    await mkdir(join(skillRoot, "references"), { recursive: true })
    await mkdir(join(skillRoot, "tasks"), { recursive: true })
    await mkdir(join(skillRoot, "scripts"), { recursive: true })
    await writeFile(join(skillRoot, "references", "guide.md"), "Guide text\n")
    await writeFile(join(skillRoot, "tasks", "verify.md"), "Verify text\n")
    await writeFile(join(skillRoot, "scripts", "manifest.json"), JSON.stringify({ helpers: [{ codexScript: "render_and_diff.py" }] }))
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_read_skill_resource",
      arguments: { skill: "review", path: "references/guide.md" },
      activeSkills: [{
        id: "repo:review",
        name: "review",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_read_skill_resource"],
        invocationMode: "explicit",
      }],
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      output: expect.stringContaining("Guide text"),
    })
    const taskResult = await runtime.execute({
      mode: "ask",
      name: "chipmate_read_skill_resource",
      arguments: { skill: "review", path: "tasks/verify.md" },
      activeSkills: [{
        id: "repo:review",
        name: "review",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_read_skill_resource"],
        invocationMode: "explicit",
      }],
    })
    expect(taskResult).toMatchObject({
      approved: true,
      status: "completed",
      output: expect.stringContaining("Verify text"),
    })
    const scriptResult = await runtime.execute({
      mode: "ask",
      name: "chipmate_read_skill_resource",
      arguments: { skill: "review", path: "scripts/manifest.json" },
      activeSkills: [{
        id: "repo:review",
        name: "review",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_read_skill_resource"],
        invocationMode: "explicit",
      }],
    })
    expect(scriptResult).toMatchObject({
      approved: true,
      status: "completed",
      output: expect.stringContaining("render_and_diff.py"),
    })
    expect(auditEvents[0]?.detail).toMatchObject({
      skillId: "repo:review",
      skillName: "review",
      invocationMode: "explicit",
      toolAllowedBySkill: true,
    })
  })

  test("runs workspace commands through permission modes with bounded output and skill audit context", async () => {
    const root = await tempDir("chipmate-tool-run-command-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ approved?: boolean; detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { approved?: boolean; detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const approvalRequired = await runtime.execute({
      mode: "ask",
      name: "chipmate_run_command",
      arguments: { command: "printf 'hello\\n'", reason: "gate check" },
      activeSkills: [{
        id: "repo:iar-to-gcc-migration-gated",
        name: "iar-to-gcc-migration-gated",
        path: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "SKILL.md"),
        skillRoot: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated"),
        sourceKind: "opencode",
        allowedTools: [],
        invocationMode: "explicit",
      }],
    })
    expect(approvalRequired).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })

    const approved = await runtime.execute({
      mode: "ask",
      name: "chipmate_run_command",
      arguments: { command: "printf 'hello\\n'", reason: "approved gate check" },
      approve: async (request) => {
        expect(request.detail).toMatchObject({
          command: "printf 'hello\\n'",
          reason: "approved gate check",
          skillName: "iar-to-gcc-migration-gated",
          skillSourceKind: "opencode",
        })
        return { approved: true, reason: "test approval" }
      },
      activeSkills: [{
        id: "repo:iar-to-gcc-migration-gated",
        name: "iar-to-gcc-migration-gated",
        path: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "SKILL.md"),
        skillRoot: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated"),
        sourceKind: "opencode",
        allowedTools: [],
        invocationMode: "explicit",
      }],
    })
    const approvedPayload = JSON.parse(approved.output)
    expect(approved).toMatchObject({
      approved: true,
      status: "completed",
    })
    expect(approved.output).toContain("hello")
    expect(approvedPayload.data).toMatchObject({
      command: "printf 'hello\\n'",
      cwd: ".",
      absoluteCwd: root,
      exitCode: 0,
      timedOut: false,
      reason: "approved gate check",
    })

    const capped = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_command",
      arguments: { command: "printf 'abcdefghij'", maxOutputBytes: 5 },
      activeSkills: [{
        id: "repo:iar-to-gcc-migration-gated",
        name: "iar-to-gcc-migration-gated",
        path: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "SKILL.md"),
        skillRoot: join(root, ".opencode", "skills", "iar-to-gcc-migration-gated"),
        sourceKind: "opencode",
        allowedTools: ["chipmate_run_command"],
        invocationMode: "explicit",
      }],
    })
    const cappedPayload = JSON.parse(capped.output)
    expect(cappedPayload).toMatchObject({
      truncated: true,
      coverage: "partial",
      data: {
        stdout: "abcde",
        truncated: true,
      },
    })
    expect(auditEvents.at(-1)?.detail).toMatchObject({
      skillName: "iar-to-gcc-migration-gated",
      skillSourceKind: "opencode",
      toolAllowedBySkill: true,
      command: "printf 'abcdefghij'",
    })

    const timeoutCommand = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 200)"`
    const timedOut = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_command",
      arguments: { command: timeoutCommand, timeoutMs: 10 },
    })
    const timedOutPayload = JSON.parse(timedOut.output)
    expect(timedOut).toMatchObject({
      approved: true,
      status: "failed",
    })
    expect(timedOutPayload).toMatchObject({
      gaps: ["Command timed out before completion."],
      data: {
        timedOut: true,
        exitCode: 124,
        timeoutMs: 10,
      },
    })
  })

  test("rejects command cwd outside the current workspace", async () => {
    const root = await tempDir("chipmate-tool-run-command-workspace-")
    const outside = await tempDir("chipmate-tool-run-command-outside-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_command",
      arguments: { command: "pwd", cwd: outside },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "failed",
      error: "Command cwd is outside workspace",
    })
  })

  test("runs active skill scripts only through manifest-approved execution boundary", async () => {
    const root = await tempDir("chipmate-tool-skill-script-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const skillRoot = join(root, ".agents", "skills", "scripted")
    await mkdir(join(skillRoot, "scripts"), { recursive: true })
    await writeFile(join(skillRoot, "scripts", "hello.mjs"), [
      "let input = ''",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  const args = JSON.parse(input || '{}')",
      "  console.log(JSON.stringify({ greeting: `hello ${args.name}` }))",
      "})",
      "",
    ].join("\n"))
    await writeFile(join(skillRoot, "scripts", "manifest.json"), JSON.stringify({
      version: "test-script-manifest",
      executionPolicy: { directExecution: true },
      helpers: [{
        codexScript: "hello.py",
        status: "executable",
        execution: {
          runtime: "node",
          entrypoint: "scripts/hello.mjs",
          timeoutMs: 5000,
        },
      }],
    }))
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "scripted", script: "hello.py", arguments: { name: "Ada" } },
      activeSkills: [{
        id: "repo:scripted",
        name: "scripted",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })

    const resultOutput = result.output
    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      output: expect.stringContaining("hello Ada"),
    })
    expect(resultOutput).toContain("test-script-manifest")
    expect(auditEvents[0]?.detail).toMatchObject({
      skillId: "repo:scripted",
      skillName: "scripted",
      toolAllowedBySkill: true,
      skillScript: "hello.py",
      entrypoint: "scripts/hello.mjs",
      runtime: "node",
      argumentKeys: ["name"],
    })

    await writeFile(join(skillRoot, "scripts", "manifest.json"), JSON.stringify({
      executionPolicy: { directExecution: false },
      helpers: [{
        codexScript: "hello.py",
        status: "executable",
        execution: { runtime: "node", entrypoint: "scripts/hello.mjs" },
      }],
    }))
    const blocked = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "scripted", script: "hello.py" },
      activeSkills: [{
        id: "repo:scripted",
        name: "scripted",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })
    expect(blocked).toMatchObject({
      approved: false,
      status: "failed",
      error: expect.stringContaining("directExecution"),
    })
  })

  test("runs v2 per-helper skill scripts with bounded artifacts and evidence", async () => {
    const root = await tempDir("chipmate-tool-skill-script-v2-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await writeFile(join(root, "input.docx"), "fixture")
    const skillRoot = join(root, ".agents", "skills", "scripted")
    await mkdir(join(skillRoot, "scripts"), { recursive: true })
    await writeFile(join(skillRoot, "scripts", "report.mjs"), [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "let input = ''",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', async () => {",
      "  const args = JSON.parse(input || '{}')",
      "  const artifactDir = process.env.CHIPMATE_SKILL_ARTIFACT_DIR",
      "  await mkdir(artifactDir, { recursive: true })",
      "  await writeFile(join(artifactDir, 'report.json'), JSON.stringify({ ok: true, documentPath: args.documentPath }) + '\\n')",
      "  console.log(JSON.stringify({ ok: true, artifact: 'report.json' }))",
      "})",
      "",
    ].join("\n"))
    await writeFile(join(skillRoot, "scripts", "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      version: "test-script-manifest-v2",
      executionPolicy: { directExecution: false, networkPolicy: "none" },
      helpers: [{
        name: "report",
        status: "executable",
        execution: {
          directExecution: true,
          runtime: "node",
          entrypoint: "scripts/report.mjs",
          inputSchema: {
            type: "object",
            required: ["documentPath"],
            additionalProperties: false,
            properties: {
              documentPath: { type: "string", pathKind: "workspace", allowedExtensions: [".docx"] },
            },
          },
          outputArtifacts: [{
            name: "report",
            kind: "diagnostic-json",
            contentType: "application/json",
            path: "report.json",
            required: true,
          }],
          timeoutMs: 5000,
          maxOutputBytes: 4096,
          allowedExtensions: [".docx"],
          networkPolicy: "none",
        },
      }],
    }))
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "scripted", script: "report", arguments: { documentPath: "input.docx" } },
      activeSkills: [{
        id: "repo:scripted",
        name: "scripted",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })

    const payload = JSON.parse(result.output)
    expect(result.status).toBe("completed")
    expect(result.artifacts?.[0]).toMatchObject({
      kind: "skill-script",
      payload: {
        kind: "skill-script",
        skill: "scripted",
        script: "report",
        artifactRoot: expect.stringContaining(".chipmate/docs/skill-script-artifacts"),
        artifacts: [],
      },
    })
    const artifactPath = String(payload.data.artifacts[0].path)
    expect(payload.data.artifacts[0].name).toBe("report")
    expect(artifactPath).toContain(".chipmate/docs/skill-script-artifacts")
    expect(typeof payload.data.artifacts[0].bytes).toBe("number")
    expect(payload.evidence?.[0]).toMatchObject({
      sourceKind: "skill-script-artifact",
      snippet: expect.stringContaining("input.docx"),
    })
    expect(auditEvents[0]?.detail).toMatchObject({
      skillScript: "report",
      directExecutionScope: "helper",
      networkPolicy: "none",
      outputArtifactCount: 1,
    })
    expect(artifactPath ? await readFile(join(root, artifactPath), "utf8") : "").toContain("input.docx")
  })

  test("runs documents word runtime field refresh limitation helper through manifest opt-in", async () => {
    const root = await tempDir("chipmate-tool-documents-runtime-helper-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const skillRoot = join(import.meta.dir, "..", ".agents", "skills", "documents")
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "documents", script: "word_runtime_field_refresh_report", arguments: {} },
      activeSkills: [{
        id: "repo:documents",
        name: "documents",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })

    const payload = JSON.parse(result.output)
    expect(result.status).toBe("completed")
    expect(payload.data.script).toBe("word_runtime_field_refresh_report")
    expect(payload.data.networkPolicy).toBe("none")
    expect(payload.data.artifacts[0]).toMatchObject({
      name: "word-runtime-field-refresh-report",
      kind: "diagnostic-json",
      contentType: "application/json",
    })
    const artifactPath = String(payload.data.artifacts[0].path)
    const report = JSON.parse(await readFile(join(root, artifactPath), "utf8"))
    expect(report.nativeFieldRefresh).toMatchObject({
      available: false,
      reason: expect.stringContaining("Remote native field refresh is not implemented"),
    })
    expect(report.directHelperScope).toMatchObject({
      readOnly: true,
      recommendedAction: expect.stringContaining("update fields manually in Word"),
    })
  })

  test("rejects v2 skill script inputs outside declared schema and extensions", async () => {
    const root = await tempDir("chipmate-tool-skill-script-v2-reject-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const skillRoot = join(root, ".agents", "skills", "scripted")
    await mkdir(join(skillRoot, "scripts"), { recursive: true })
    await writeFile(join(skillRoot, "scripts", "noop.mjs"), "console.log('{}')\n")
    await writeFile(join(skillRoot, "scripts", "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      executionPolicy: { directExecution: false, networkPolicy: "none" },
      helpers: [{
        name: "noop",
        status: "executable",
        execution: {
          directExecution: true,
          runtime: "node",
          entrypoint: "scripts/noop.mjs",
          inputSchema: {
            type: "object",
            required: ["documentPath"],
            additionalProperties: false,
            properties: {
              documentPath: { type: "string", pathKind: "workspace", allowedExtensions: [".docx"] },
            },
          },
          timeoutMs: 5000,
          maxOutputBytes: 1024,
          allowedExtensions: [".docx"],
          networkPolicy: "none",
        },
      }],
    }))
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const badExtension = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "scripted", script: "noop", arguments: { documentPath: "notes.txt" } },
      activeSkills: [{
        id: "repo:scripted",
        name: "scripted",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })
    expect(badExtension).toMatchObject({
      approved: false,
      status: "failed",
      error: expect.stringContaining("extension"),
    })

    const outsideWorkspace = await runtime.execute({
      mode: "full-access",
      name: "chipmate_run_skill_script",
      arguments: { skill: "scripted", script: "noop", arguments: { documentPath: "../outside.docx", extra: true } },
      activeSkills: [{
        id: "repo:scripted",
        name: "scripted",
        path: join(skillRoot, "SKILL.md"),
        skillRoot,
        allowedTools: ["chipmate_run_skill_script"],
        invocationMode: "explicit",
      }],
    })
    expect(outsideWorkspace.output).toContain("Unexpected argument: extra")
    expect(outsideWorkspace.output).toContain("inside the workspace")
  })

  test("graph tools return refIds that can be read with chipmate_read_evidence", async () => {
    const root = await tempDir("chipmate-tool-graph-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    runtime.setContextProviders({
      codeGraph: {
        status: () => ({ rag: { enabled: false, embeddingEnabled: false, availability: "unavailable", indexAvailability: "none", chunks: 0, embeddedChunks: 0 } }),
        findSymbols: async () => [],
        queryEvidence: async () => undefined,
        runAnalysisTool: async () => ({
          ok: true,
          traceId: "trace-callers",
          tool: "getCallers",
          elapsedMs: 1,
          data: { mode: "callers" },
          evidence: [{
            file: "src/driver.c",
            startLine: 10,
            endLine: 14,
            snippetHash: "hash",
            parserKind: "codegraph:caller",
            snippet: "void boot(void) {\n  nand_read_page();\n}",
          }],
          audit: { traceId: "trace-callers", tool: "getCallers", argsSummary: "nand_read_page", evidenceCount: 1, elapsedMs: 1, blocked: false },
        }),
      } as never,
      getSettings: () => directSettings("http://127.0.0.1/v1"),
    })

    const result = await runtime.execute({
      sessionID: "session-a",
      mode: "ask",
      name: "chipmate_graph_callers",
      arguments: { symbol: "nand_read_page" },
    })
    const payload = JSON.parse(result.output) as { evidence: Array<{ refId: string; sourceKind: string; path: string }>; coverage: string }

    expect(result.approved).toBe(true)
    expect(payload.coverage).toBe("bounded-complete")
    expect(payload.evidence[0]).toMatchObject({ path: "src/driver.c", sourceKind: "codegraph:caller" })

    const expanded = await runtime.execute({
      sessionID: "session-a",
      mode: "ask",
      name: "chipmate_read_evidence",
      arguments: { refId: payload.evidence[0]?.refId },
    })
    const expandedPayload = JSON.parse(expanded.output) as { evidence: Array<{ snippet: string }> }
    expect(expandedPayload.evidence[0]?.snippet).toContain("nand_read_page")
  })

  test("document search returns unified evidence refs from Document RAG", async () => {
    const root = await tempDir("chipmate-tool-doc-rag-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const settings = directSettings("http://127.0.0.1/v1")
    settings.documentRag.enabled = true
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    runtime.setContextProviders({
      documentRag: {
        status: () => ({
          enabled: true,
          availability: "ready",
          documentCount: 1,
          indexedDocuments: 1,
          skippedDocuments: 0,
          pendingDocuments: 0,
          chunks: 1,
          embeddedChunks: 1,
        }),
        query: async () => ({
          text: '<local-document-rag documents="1/1" chunks="1/1" evidenceCount="1"><evidence-list><evidence kind="pdf" path="docs/spec.pdf" lines="4-6" section="pdf:1" score="0.991">upgrade flow</evidence></evidence-list></local-document-rag>',
          hits: [{ path: "docs/spec.pdf", startLine: 4, endLine: 6, score: 0.991 }],
          elapsedMs: 3,
        }),
      },
      getSettings: () => settings,
    })

    const result = await runtime.execute({
      sessionID: "session-doc",
      mode: "ask",
      name: "chipmate_search_documents",
      arguments: { query: "upgrade flow" },
    })
    const payload = JSON.parse(result.output) as { evidence: Array<{ refId: string; path: string; sourceKind: string; snippet: string }>; data: { ragHits: unknown[] } }

    expect(payload.evidence[0]).toMatchObject({ path: "docs/spec.pdf", sourceKind: "document-rag:pdf" })
    expect(payload.evidence[0]?.snippet).toContain("upgrade flow")
    expect(payload.data.ragHits).toHaveLength(1)
  })

  test("reads supported documents through the exposed workspace read tool", async () => {
    const root = await tempDir("chipmate-tool-document-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await writeFile(join(root, "brief.docx"), docxFixture("Tool readable Word document"))
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_read",
      arguments: { path: "brief.docx" },
    })

    expect(result.approved).toBe(true)
    const payload = JSON.parse(result.output) as { answerSummary: string; evidence: Array<{ refId: string; path: string; sourceKind: string; snippet: string }>; coverage: string; data: { text: string } }
    expect(payload.answerSummary).toContain("brief.docx")
    expect(payload.coverage).toBe("complete")
    expect(payload.evidence[0]).toMatchObject({ path: "brief.docx", sourceKind: "document:docx" })
    expect(payload.evidence[0]?.refId).toBeTruthy()
    expect(payload.data.text).toContain("DOCX text:")
    expect(payload.data.text).toContain("Tool readable Word document")
  })

  test("returns a failed result when chipmate_read targets a missing workspace file", async () => {
    const root = await tempDir("chipmate-tool-missing-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const missingPath = join(root, "hw", "ufs.c")

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_read",
      arguments: { path: "hw/ufs.c" },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(result.output).toContain("File not found:")
    expect(result.output).toContain(missingPath)
  })

  test("creates a new workspace text file and omits content from audit detail", async () => {
    const root = await tempDir("chipmate-create-file-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: {
        path: "src/generated.ts",
        content: "export const generated = true\n",
        reason: "Create a starting implementation file.",
      },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      title: "Created file: src/generated.ts",
    })
    expect(await readFile(join(root, "src", "generated.ts"), "utf8")).toBe("export const generated = true\n")
    expect(result.output).toContain('"path": "src/generated.ts"')
    expect(result.output).toContain('"bytes": 30')
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]?.detail).toMatchObject({
      path: "src/generated.ts",
      bytes: 30,
      tool: "chipmate_create_file",
    })
    expect(JSON.stringify(auditEvents[0]?.detail)).not.toContain("export const generated")
  })

  test("refuses to overwrite an existing workspace file", async () => {
    const root = await tempDir("chipmate-create-existing-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "generated.ts"), "original\n")
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: { path: "src/generated.ts", content: "replacement\n" },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(result.output).toContain("File already exists: src/generated.ts")
    expect(await readFile(join(root, "src", "generated.ts"), "utf8")).toBe("original\n")
  })

  test("blocks create file paths outside the workspace and sensitive paths", async () => {
    const root = await tempDir("chipmate-create-blocked-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const outside = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: { path: "../outside.ts", content: "export {}\n" },
    })
    const sensitive = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: { path: ".git/config", content: "[core]\n" },
    })
    const env = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: { path: ".env", content: "TOKEN=secret\n" },
    })

    expect(outside.status).toBe("failed")
    expect(outside.output).toContain("outside the current workspace")
    expect(sensitive.status).toBe("failed")
    expect(sensitive.output).toContain("sensitive path")
    expect(env.status).toBe("failed")
    expect(env.output).toContain("sensitive path")
  })

  test("blocks binary-like create file content", async () => {
    const root = await tempDir("chipmate-create-binary-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_file",
      arguments: { path: "src/binary.bin", content: "abc\0def" },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(result.output).toContain("binary")
  })

  test("creates a file in ask mode when the QA approval handler approves", async () => {
    const root = await tempDir("chipmate-create-approved-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ approved?: boolean; detail?: Record<string, unknown> }> = []
    const approvals: Array<{ title: string; summary: string; risk: string; detail: unknown }> = []
    const runtime = new ToolRuntime({ append: async (event: { approved?: boolean; detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_file",
      arguments: { path: "src/approved.ts", content: "export const approved = true\n" },
      approve: async (request) => {
        approvals.push({
          title: request.title,
          summary: request.summary,
          risk: request.risk,
          detail: request.detail,
        })
        return { approved: true, reason: "test approval" }
      },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      title: "Created file: src/approved.ts",
    })
    expect(await readFile(join(root, "src", "approved.ts"), "utf8")).toBe("export const approved = true\n")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      title: "Create file",
      summary: "src/approved.ts",
      risk: "low",
    })
    expect(approvals[0]?.detail).toMatchObject({
      path: "src/approved.ts",
      bytes: 29,
      tool: "chipmate_create_file",
    })
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({ approved: true })
    expect(warningMessageCalls).toBe(0)
  })

  test("does not create a file when ask mode QA approval is denied", async () => {
    const root = await tempDir("chipmate-create-denied-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ approved?: boolean; detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { approved?: boolean; detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_file",
      arguments: { path: "src/denied.ts", content: "export const denied = true\n" },
      approve: async () => ({ approved: false, reason: "test denial" }),
    })

    expect(result).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    await expect(readFile(join(root, "src", "denied.ts"), "utf8")).rejects.toThrow()
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({ approved: false })
    expect(JSON.stringify(auditEvents[0]?.detail)).not.toContain("denied = true")
    expect(warningMessageCalls).toBe(0)
  })

  test("does not create a file when ask mode has no QA approval handler", async () => {
    const root = await tempDir("chipmate-create-no-approval-handler-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_file",
      arguments: { path: "src/unavailable.ts", content: "export const unavailable = true\n" },
    })

    expect(result).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    expect(result.output).toContain("QA inline approval unavailable")
    await expect(readFile(join(root, "src", "unavailable.ts"), "utf8")).rejects.toThrow()
    expect(warningMessageCalls).toBe(0)
  })

  test("creates a new workspace folder and omits content from audit detail", async () => {
    const root = await tempDir("chipmate-create-directory-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: {
        path: "generated/scripts/",
        reason: "Keep optimized scripts together.",
      },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      title: "Created folder: generated/scripts",
    })
    await expect(readdir(join(root, "generated", "scripts"))).resolves.toEqual([])
    expect(result.output).toContain('"path": "generated/scripts"')
    expect(result.output).toContain('"reason": "Keep optimized scripts together."')
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]?.detail).toMatchObject({
      path: "generated/scripts",
      reason: "Keep optimized scripts together.",
      tool: "chipmate_create_directory",
    })
  })

  test("creates parent folders for a new workspace folder", async () => {
    const root = await tempDir("chipmate-create-directory-parents-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "one/two/three" },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
    })
    await expect(readdir(join(root, "one", "two", "three"))).resolves.toEqual([])
  })

  test("refuses to create a folder when the target path already exists", async () => {
    const root = await tempDir("chipmate-create-directory-existing-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "existing-dir"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "existing.ts"), "export {}\n")
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const existingDirectory = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "existing-dir" },
    })
    const existingFile = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "src/existing.ts" },
    })

    expect(existingDirectory).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(existingDirectory.output).toContain("Folder path already exists: existing-dir")
    expect(existingFile).toMatchObject({
      approved: false,
      status: "failed",
    })
    expect(existingFile.output).toContain("Folder path already exists: src/existing.ts")
  })

  test("blocks create folder paths outside the workspace and sensitive paths", async () => {
    const root = await tempDir("chipmate-create-directory-blocked-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const outside = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "../outside" },
    })
    const sensitiveGit = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: ".git/hooks" },
    })
    const sensitiveEnv = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "configs/.env" },
    })
    const abnormal = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "safe/../unsafe" },
    })
    const nul = await runtime.execute({
      mode: "auto",
      name: "chipmate_create_directory",
      arguments: { path: "safe\0unsafe" },
    })

    expect(outside.status).toBe("failed")
    expect(outside.output).toContain("outside the current workspace")
    expect(sensitiveGit.status).toBe("failed")
    expect(sensitiveGit.output).toContain("sensitive path")
    expect(sensitiveEnv.status).toBe("failed")
    expect(sensitiveEnv.output).toContain("sensitive path")
    expect(abnormal.status).toBe("failed")
    expect(abnormal.output).toContain("unsupported path segment")
    expect(nul.status).toBe("failed")
    expect(nul.output).toContain("NUL byte")
  })

  test("creates a folder in ask mode only when QA approval approves", async () => {
    const root = await tempDir("chipmate-create-directory-approved-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const auditEvents: Array<{ approved?: boolean; detail?: Record<string, unknown> }> = []
    const approvals: Array<{ title: string; summary: string; risk: string; detail: unknown }> = []
    const runtime = new ToolRuntime({ append: async (event: { approved?: boolean; detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const approved = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_directory",
      arguments: { path: "approved-folder", reason: "QA approved folder" },
      approve: async (request) => {
        approvals.push({
          title: request.title,
          summary: request.summary,
          risk: request.risk,
          detail: request.detail,
        })
        return { approved: true, reason: "test approval" }
      },
    })
    const denied = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_directory",
      arguments: { path: "denied-folder" },
      approve: async () => ({ approved: false, reason: "test denial" }),
    })
    const unavailable = await runtime.execute({
      mode: "ask",
      name: "chipmate_create_directory",
      arguments: { path: "unavailable-folder" },
    })

    expect(approved).toMatchObject({
      approved: true,
      status: "completed",
      title: "Created folder: approved-folder",
    })
    await expect(readdir(join(root, "approved-folder"))).resolves.toEqual([])
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      title: "Create folder",
      summary: expect.stringContaining("approved-folder"),
      risk: "low",
    })
    expect(approvals[0]?.detail).toMatchObject({
      path: "approved-folder",
      reason: "QA approved folder",
      tool: "chipmate_create_directory",
    })
    expect(denied).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    expect(unavailable).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    expect(unavailable.output).toContain("QA inline approval unavailable")
    await expect(readdir(join(root, "denied-folder"))).rejects.toThrow()
    await expect(readdir(join(root, "unavailable-folder"))).rejects.toThrow()
    expect(auditEvents).toHaveLength(3)
    expect(warningMessageCalls).toBe(0)
  })

  test("edits an existing workspace text file by exact replacement without leaking replacement text to audit", async () => {
    const root = await tempDir("chipmate-edit-file-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "existing.ts"), "export const value = 1\n")
    const auditEvents: Array<{ detail?: Record<string, unknown> }> = []
    const runtime = new ToolRuntime({ append: async (event: { detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: {
        path: "src/existing.ts",
        oldString: "export const value = 1\n",
        newString: "export const value = \"$& literal\"\n",
        reason: "Update the exported constant.",
      },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
      title: "Edited file: src/existing.ts",
    })
    expect(await readFile(join(root, "src", "existing.ts"), "utf8")).toBe("export const value = \"$& literal\"\n")
    expect(result.output).toContain('"path": "src/existing.ts"')
    expect(result.output).toContain('"replacements": 1')
    expect(result.output).not.toContain("value = 1")
    expect(result.output).not.toContain("$& literal")
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]?.detail).toMatchObject({
      path: "src/existing.ts",
      replacements: 1,
      replaceAll: false,
      tool: "chipmate_edit_file",
    })
    expect(JSON.stringify(auditEvents[0]?.detail)).not.toContain("value = 1")
    expect(JSON.stringify(auditEvents[0]?.detail)).not.toContain("$& literal")
  })

  test("replaces all exact occurrences and preserves target line endings", async () => {
    const root = await tempDir("chipmate-edit-replace-all-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "crlf.txt"), "one\r\none\r\n")
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const result = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: {
        path: "src/crlf.txt",
        oldString: "one\n",
        newString: "two\n",
        replaceAll: true,
      },
    })

    expect(result).toMatchObject({
      approved: true,
      status: "completed",
    })
    expect(result.output).toContain('"replacements": 2')
    expect(await readFile(join(root, "src", "crlf.txt"), "utf8")).toBe("two\r\ntwo\r\n")
  })

  test("blocks exact edit misses, ambiguous matches, no-op edits, missing files, unsafe paths, and binary content", async () => {
    const root = await tempDir("chipmate-edit-blocked-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "existing.ts"), "alpha\nbeta\nalpha\n")
    await writeFile(join(root, "src", "binary.bin"), "abc\0def")
    const runtime = new ToolRuntime({ append: async () => undefined } as never)

    const missingOld = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "src/existing.ts", oldString: "gamma\n", newString: "delta\n" },
    })
    const ambiguous = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "src/existing.ts", oldString: "alpha\n", newString: "omega\n" },
    })
    const same = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "src/existing.ts", oldString: "beta\n", newString: "beta\n" },
    })
    const missingFile = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "src/missing.ts", oldString: "x", newString: "y" },
    })
    const outside = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "../outside.ts", oldString: "x", newString: "y" },
    })
    const sensitive = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: ".env", oldString: "TOKEN=old", newString: "TOKEN=new" },
    })
    const binary = await runtime.execute({
      mode: "auto",
      name: "chipmate_edit_file",
      arguments: { path: "src/binary.bin", oldString: "abc", newString: "xyz" },
    })

    expect(missingOld.output).toContain("Could not find oldString")
    expect(ambiguous.output).toContain("Found multiple exact matches")
    expect(same.output).toContain("oldString and newString are identical")
    expect(missingFile.output).toContain("File does not exist")
    expect(outside.output).toContain("outside the current workspace")
    expect(sensitive.output).toContain("sensitive path")
    expect(binary.output).toContain("binary")
    expect(await readFile(join(root, "src", "existing.ts"), "utf8")).toBe("alpha\nbeta\nalpha\n")
    expect(await readFile(join(root, "src", "binary.bin"), "utf8")).toBe("abc\0def")
  })

  test("edits a file in ask mode only when QA approval approves", async () => {
    const root = await tempDir("chipmate-edit-approved-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "approved.ts"), "export const approved = false\n")
    await writeFile(join(root, "src", "denied.ts"), "export const denied = false\n")
    await writeFile(join(root, "src", "unavailable.ts"), "export const unavailable = false\n")
    const auditEvents: Array<{ approved?: boolean; detail?: Record<string, unknown> }> = []
    const approvals: Array<{ title: string; summary: string; risk: string; detail: unknown }> = []
    const runtime = new ToolRuntime({ append: async (event: { approved?: boolean; detail?: Record<string, unknown> }) => { auditEvents.push(event) } } as never)

    const approved = await runtime.execute({
      mode: "ask",
      name: "chipmate_edit_file",
      arguments: {
        path: "src/approved.ts",
        oldString: "export const approved = false\n",
        newString: "export const approved = true\n",
      },
      approve: async (request) => {
        approvals.push({
          title: request.title,
          summary: request.summary,
          risk: request.risk,
          detail: request.detail,
        })
        return { approved: true, reason: "test approval" }
      },
    })
    const denied = await runtime.execute({
      mode: "ask",
      name: "chipmate_edit_file",
      arguments: {
        path: "src/denied.ts",
        oldString: "export const denied = false\n",
        newString: "export const denied = true\n",
      },
      approve: async () => ({ approved: false, reason: "test denial" }),
    })
    const unavailable = await runtime.execute({
      mode: "ask",
      name: "chipmate_edit_file",
      arguments: {
        path: "src/unavailable.ts",
        oldString: "export const unavailable = false\n",
        newString: "export const unavailable = true\n",
      },
    })

    expect(approved).toMatchObject({
      approved: true,
      status: "completed",
      title: "Edited file: src/approved.ts",
    })
    expect(denied).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    expect(unavailable).toMatchObject({
      approved: false,
      status: "approval-required",
      requiresApproval: true,
    })
    expect(await readFile(join(root, "src", "approved.ts"), "utf8")).toBe("export const approved = true\n")
    expect(await readFile(join(root, "src", "denied.ts"), "utf8")).toBe("export const denied = false\n")
    expect(await readFile(join(root, "src", "unavailable.ts"), "utf8")).toBe("export const unavailable = false\n")
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      title: "Edit file",
      summary: expect.stringContaining("src/approved.ts"),
      risk: "low",
    })
    expect(approvals[0]?.detail).toMatchObject({
      path: "src/approved.ts",
      replacements: 1,
      tool: "chipmate_edit_file",
    })
    expect(JSON.stringify(approvals[0]?.detail)).not.toContain("approved = false")
    expect(JSON.stringify(approvals[0]?.detail)).not.toContain("approved = true")
    expect(auditEvents).toHaveLength(3)
    expect(warningMessageCalls).toBe(0)
  })
})

describe("GoalRuntime", () => {
  test("validates objectives and preserves create-goal exclusivity until completion", async () => {
    const runtime = new GoalRuntime(extensionContext(await tempDir("chipmate-goal-runtime-")))

    await expect(runtime.createGoalFromTool("thread-1", "")).rejects.toThrow("must not be empty")

    const created = await runtime.createGoalFromTool("thread-1", "finish the migration", 100)
    expect(created.goal).toMatchObject({
      threadID: "thread-1",
      objective: "finish the migration",
      status: "active",
      tokenBudget: 100,
      tokensUsed: 0,
    })
    expect(created.remainingTokens).toBe(100)
    await expect(runtime.createGoalFromTool("thread-1", "start another goal")).rejects.toThrow("unfinished goal")

    const completed = await runtime.updateGoalFromTool("thread-1", "complete")
    expect(completed.goal?.status).toBe("complete")
    expect(completed.completionBudgetReport).toContain("structured goal fields")
    expect(completed.completionBudgetReport).toContain("goal.tokensUsed")
    expect(completed.completionBudgetReport).toContain("goal.tokenBudget")

    const replacement = await runtime.createGoalFromTool("thread-1", "next migration")
    expect(replacement.goal).toMatchObject({
      objective: "next migration",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
    })
    expect(replacement.goal?.goalID).not.toBe(created.goal?.goalID)
  })

  test("materializes long objectives and expands them for prompts and editing", async () => {
    const runtime = new GoalRuntime(extensionContext(await tempDir("chipmate-goal-materialized-")))
    const longObjective = `ship the whole migration\n${"long objective detail ".repeat(260)}`.trim()
    expect([...longObjective].length).toBeGreaterThan(MAX_THREAD_GOAL_OBJECTIVE_CHARS)

    const created = await runtime.createGoalFromTool("thread-long", longObjective, 100000)
    const storedObjective = created.goal?.objective ?? ""
    expect(storedObjective).toContain("Read the ChipMate goal objective file at ")
    expect(storedObjective).toContain(" before continuing.")
    expect([...storedObjective].length).toBeLessThanOrEqual(MAX_THREAD_GOAL_OBJECTIVE_CHARS)
    expect(storedObjective).not.toContain("long objective detail long objective detail long objective detail")

    const match = storedObjective.match(/^Read the ChipMate goal objective file at (.*) before continuing\.$/)
    expect(match?.[1]).toBeTruthy()
    expect(await readFile(match![1], "utf8")).toBe(longObjective)

    const displayGoal = await runtime.goalForDisplay(created.goal!)
    expect(displayGoal.objective).toBe(longObjective)

    const prompt = await runtime.continuationPrompt(created.goal!)
    expect(prompt).toContain("ship the whole migration")
    expect(prompt).toContain("long objective detail long objective detail")
    expect(prompt).not.toContain("Read the ChipMate goal objective file")

    const editedObjective = `${longObjective}\nupdated requirement`
    await runtime.setGoal("thread-long", { objective: editedObjective, status: "active" })
    const steering = runtime.consumePendingSteering("thread-long").join("\n")
    expect(steering).toContain("updated requirement")
    expect(steering).not.toContain("Read the ChipMate goal objective file")
  })

  test("accounts usage, enforces token budget, and ignores stale expected goal ids", async () => {
    const store = new GoalStore(extensionContext(await tempDir("chipmate-goal-store-")))
    const goal = await store.createGoal("thread-2", "budgeted goal", 10)
    expect(goal?.status).toBe("active")

    const stale = await store.accountUsage({
      threadID: "thread-2",
      expectedGoalID: "old-goal",
      tokenDelta: 5,
      timeDeltaSeconds: 2,
    })
    expect(stale).toBeUndefined()
    expect(await store.getGoal("thread-2")).toMatchObject({ tokensUsed: 0, timeUsedSeconds: 0, status: "active" })

    const accounted = await store.accountUsage({
      threadID: "thread-2",
      expectedGoalID: goal?.goalID,
      tokenDelta: 12,
      timeDeltaSeconds: 3,
    })
    expect(accounted).toMatchObject({
      tokensUsed: 12,
      timeUsedSeconds: 3,
      status: "budget_limited",
    })

    const budgetLimited = await store.accountUsage({
      threadID: "thread-2",
      expectedGoalID: goal?.goalID,
      tokenDelta: 2,
      mode: "activeOnly",
    })
    expect(budgetLimited).toMatchObject({ tokensUsed: 14, status: "budget_limited" })

    const paused = await store.replaceGoal("thread-paused", "paused accounting", "paused")
    expect(await store.accountUsage({
      threadID: "thread-paused",
      expectedGoalID: paused.goalID,
      tokenDelta: 5,
      mode: "activeOnly",
    })).toBeUndefined()
    expect(await store.accountUsage({
      threadID: "thread-paused",
      expectedGoalID: paused.goalID,
      tokenDelta: 5,
      mode: "activeOrStopped",
    })).toMatchObject({ tokensUsed: 5, status: "paused" })

    const completed = await store.replaceGoal("thread-complete", "complete accounting", "complete")
    expect(await store.accountUsage({
      threadID: "thread-complete",
      expectedGoalID: completed.goalID,
      tokenDelta: 5,
      mode: "activeOrStopped",
    })).toBeUndefined()
    expect(await store.accountUsage({
      threadID: "thread-complete",
      expectedGoalID: completed.goalID,
      tokenDelta: 5,
      mode: "activeOrComplete",
    })).toMatchObject({ tokensUsed: 5, status: "complete" })
  })

  test("runtime emits budget steering and restricts model-side status updates", async () => {
    const runtime = new GoalRuntime(extensionContext(await tempDir("chipmate-goal-budget-")))
    const created = await runtime.createGoalFromTool("thread-3", "finish within budget", 5)
    const goalID = created.goal?.goalID
    expect(goalID).toBeTruthy()

    await runtime.startTurn("thread-3", "assistant-1")
    const limited = await runtime.recordTokenUsage("thread-3", { input: 2, output: 4, total: 6 })
    expect(limited).toMatchObject({ status: "budget_limited", tokensUsed: 6 })
    const stillLimited = await runtime.recordTokenUsage("thread-3", { input: 5, output: 5, total: 10 })
    expect(stillLimited).toMatchObject({ status: "budget_limited", tokensUsed: 10 })
    const steering = runtime.consumePendingSteering("thread-3").join("\n")
    expect(steering).toContain("token budget")
    expect(steering.split("The active ChipMate thread goal has reached its token budget.").length - 1).toBe(1)
    expect(runtime.consumePendingSteering("thread-3")).toEqual([])
    await expect(runtime.updateGoalFromTool("thread-3", "paused")).rejects.toThrow("can only mark")
  })

  test("runtime accounts idle goal progress before external mutations", async () => {
    const realNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    try {
      const runtime = new GoalRuntime(extensionContext(await tempDir("chipmate-goal-idle-accounting-")))
      const goal = await runtime.setGoal("thread-idle", {
        objective: "account idle time before pausing",
        status: "active",
        tokenBudget: 100000,
      })
      expect(goal).toMatchObject({ status: "active", timeUsedSeconds: 0 })
      now += 2500

      const paused = await runtime.pauseGoal("thread-idle")
      expect(paused).toMatchObject({
        status: "paused",
        goalID: goal.goalID,
        timeUsedSeconds: 2,
      })
    } finally {
      Date.now = realNow
    }
  })

  test("continuation prompt preserves Codex-grade completion and blocked audits", async () => {
    const runtime = new GoalRuntime(extensionContext(await tempDir("chipmate-goal-prompt-")))
    const prompt = await runtime.continuationPrompt({
      threadID: "thread-prompt",
      goalID: "goal-prompt",
      objective: "ship the goal implementation",
      status: "active",
      tokenBudget: 1000,
      tokensUsed: 42,
      timeUsedSeconds: 7,
      createdAt: 1,
      updatedAt: 1,
    })

    expect(prompt).toContain("If update_plan is available")
    expect(prompt).toContain("Treat alignment as movement toward the requested end state")
    expect(prompt).toContain("Derive concrete requirements from the objective")
    expect(prompt).toContain("For every explicit requirement, numbered item, named artifact, command, test, gate, invariant, and deliverable")
    expect(prompt).toContain("The audit must prove completion, not merely fail to find obvious remaining work.")
    expect(prompt).toContain("Do not call update_goal with status \"blocked\" the first time a blocker appears.")
    expect(prompt).toContain("If the user resumes a goal that was previously marked \"blocked\", treat the resumed run as a fresh blocked audit.")
    expect(prompt).toContain("Do not mark a goal complete merely because the budget is nearly exhausted or because you are stopping work.")
  })
})

describe("DirectAgentClient", () => {
  test("runs active goals through internal continuation and completes via update_goal without user-history pollution", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (requests.length === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_goal", function: { name: "update_goal", arguments: "{\"status\":\"complete\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      writeChatSse(response, "Goal completed.")
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-goal-continuation-storage-"),
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = client.subscribeEvents((event) => events.push(event), controller.signal)
    const session = await client.createSession()

    const goal = await client.startGoalOperation({
      sessionID: session.id,
      objective: "complete the active goal",
      tokenBudget: 100,
    })
    expect(goal.status).toBe("active")

    await waitFor(async () => (await client.getGoal(session.id))?.status === "complete", 1500)
    controller.abort()
    await subscription

    const completed = await client.getGoal(session.id)
    expect(completed).toMatchObject({
      status: "complete",
      objective: "complete the active goal",
    })
    expect(requests).toHaveLength(2)
    const firstMessages = (requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>
    expect(firstMessages[firstMessages.length - 1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Continue working toward the active ChipMate thread goal."),
    })
    const toolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(toolNames).toEqual(expect.arrayContaining(["get_goal", "create_goal", "update_goal"]))
    const messages = await client.getMessages(session.id)
    expect(messages.some((message) => message.info.role === "user")).toBe(false)
    expect(messages.some((message) => textPartsForTest(message).includes("Goal completed."))).toBe(true)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "goal.operation.started" }),
      expect.objectContaining({ type: "goal.updated", properties: expect.objectContaining({ goal: expect.objectContaining({ status: "complete" }) }) }),
      expect.objectContaining({ type: "goal.operation.finished" }),
    ]))
  })

  test("schedules goal continuation after an ordinary async user turn becomes idle", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (requests.length === 1) {
        writeChatSse(response, "Initial progress.")
        return
      }
      if (requests.length === 2) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_goal", function: { name: "update_goal", arguments: "{\"status\":\"complete\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      writeChatSse(response, "Goal finished after continuation.")
    })
    const storageRoot = await tempDir("chipmate-goal-after-user-storage-")
    const client = directClient(baseUrl, {
      storageRoot,
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })
    const session = await client.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    await store.createGoal(session.id, "continue after the user turn", 100000)

    await client.sendMessageAsync({ sessionID: session.id, text: "make some progress" })
    await waitFor(async () => {
      const goal = await client.getGoal(session.id)
      const messages = await client.getMessages(session.id)
      return goal?.status === "complete"
        && messages.some((message) => textPartsForTest(message).includes("Goal finished after continuation."))
    }, 1500)

    expect(requests).toHaveLength(3)
    const continuationMessages = (requests[1]?.body.messages ?? []) as Array<{ role?: string; content?: string }>
    expect(continuationMessages[continuationMessages.length - 1]?.content).toContain("Continue working toward the active ChipMate thread goal.")
    const messages = await client.getMessages(session.id)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
    expect(messages.some((message) => textPartsForTest(message).includes("Goal finished after continuation."))).toBe(true)
  })

  test("restores active goals after session resume and starts continuation without user-history pollution", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (requests.length === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_goal", function: { name: "update_goal", arguments: "{\"status\":\"complete\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      writeChatSse(response, "Restored goal completed.")
    })
    const storageRoot = await tempDir("chipmate-goal-restore-active-storage-")
    const seedClient = directClient(baseUrl, { storageRoot })
    const session = await seedClient.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    await store.createGoal(session.id, "continue after extension reload", 100000)
    const restoredClient = directClient(baseUrl, {
      storageRoot,
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = restoredClient.subscribeEvents((event) => events.push(event), controller.signal)

    const restored = await restoredClient.restoreGoalAfterSessionResume(session.id)
    expect(restored).toMatchObject({ status: "active", objective: "continue after extension reload" })
    await waitFor(async () => (await restoredClient.getGoal(session.id))?.status === "complete", 1500)
    controller.abort()
    await subscription

    expect(requests).toHaveLength(2)
    const continuationMessages = (requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>
    expect(continuationMessages[continuationMessages.length - 1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Continue working toward the active ChipMate thread goal."),
    })
    await waitFor(async () => (await restoredClient.getMessages(session.id))
      .some((message) => textPartsForTest(message).includes("Restored goal completed.")), 1500)
    const messages = await restoredClient.getMessages(session.id)
    expect(messages.some((message) => message.info.role === "user")).toBe(false)
    expect(messages.some((message) => textPartsForTest(message).includes("Restored goal completed."))).toBe(true)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "goal.updated", properties: expect.objectContaining({ goal: expect.objectContaining({ status: "active" }) }) }),
      expect.objectContaining({ type: "goal.operation.started" }),
      expect.objectContaining({ type: "goal.updated", properties: expect.objectContaining({ goal: expect.objectContaining({ status: "complete" }) }) }),
    ]))
  })

  test("does not auto-continue paused blocked or usage-limited goals after session resume", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url === "/v1/chat/completions") {
        requests.push({ body: await collectJson(request) })
        writeChatSse(response, "Unexpected continuation.")
        return
      }
      response.writeHead(404).end()
    })
    const storageRoot = await tempDir("chipmate-goal-restore-stopped-storage-")
    const seedClient = directClient(baseUrl, { storageRoot })
    const store = new GoalStore(extensionContext(storageRoot))
    const statuses: ThreadGoalStatus[] = ["paused", "blocked", "usage_limited"]

    for (const status of statuses) {
      const session = await seedClient.createSession(`goal ${status}`)
      await store.replaceGoal(session.id, `restore ${status}`, status, 100000)
      const restoredClient = directClient(baseUrl, {
        storageRoot,
        tools: new ToolRuntime({ append: async () => undefined } as never),
        toolsEnabled: true,
      })
      const restored = await restoredClient.restoreGoalAfterSessionResume(session.id)
      expect(restored).toMatchObject({ status, objective: `restore ${status}` })
      expect(restoredClient.getGoalOperation(session.id)).toBeUndefined()
    }

    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(requests).toHaveLength(0)
  })

  test("uses the edited goal objective when edit races with restored continuation", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (requests.length === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_goal", function: { name: "update_goal", arguments: "{\"status\":\"complete\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      writeChatSse(response, "Edited goal completed.")
    })
    const storageRoot = await tempDir("chipmate-goal-edit-race-storage-")
    const seedClient = directClient(baseUrl, { storageRoot })
    const session = await seedClient.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    await store.createGoal(session.id, "old objective", 100000)
    const client = directClient(baseUrl, {
      storageRoot,
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })

    await client.restoreGoalAfterSessionResume(session.id)
    await client.setGoal({ sessionID: session.id, objective: "new objective" })
    await waitFor(async () => (await client.getGoal(session.id))?.status === "complete", 1500)

    const firstPrompt = JSON.stringify(requests[0]?.body.messages ?? [])
    expect(firstPrompt).toContain("new objective")
    expect(firstPrompt).not.toContain("old objective")
  })

  test("does not start restored continuation after a racing clear", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url === "/v1/chat/completions") {
        requests.push({ body: await collectJson(request) })
        writeChatSse(response, "Unexpected goal turn.")
        return
      }
      response.writeHead(404).end()
    })
    const storageRoot = await tempDir("chipmate-goal-clear-race-storage-")
    const seedClient = directClient(baseUrl, { storageRoot })
    const session = await seedClient.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    await store.createGoal(session.id, "clear before continuation", 100000)
    const client = directClient(baseUrl, {
      storageRoot,
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
    })

    await client.restoreGoalAfterSessionResume(session.id)
    await client.clearGoal(session.id)
    await new Promise((resolve) => setTimeout(resolve, 180))

    expect(requests).toHaveLength(0)
    expect(await client.getGoal(session.id)).toBeUndefined()
  })

  test("ordinary abort accounts but does not pause an active goal", async () => {
    let receivedRequest!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      receivedRequest = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(sse({ choices: [{ delta: { content: "Partial goal work before stop." } }] }))
      receivedRequest()
    })
    const storageRoot = await tempDir("chipmate-goal-ordinary-abort-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    await store.createGoal(session.id, "stay active after ordinary abort", 100000)

    await client.sendMessageAsync({ sessionID: session.id, text: "work on active goal" })
    await requestReceived
    await client.abortSession(session.id)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(await client.getGoal(session.id)).toMatchObject({
      status: "active",
      objective: "stay active after ordinary abort",
    })
    expect(client.getGoalOperation(session.id)).toMatchObject({ active: false, status: "active" })
  })

  test("explicit goal operation cancel pauses the active goal", async () => {
    let receivedRequest!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      receivedRequest = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(sse({ choices: [{ delta: { content: "Partial goal operation before cancel." } }] }))
      receivedRequest()
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-goal-cancel-operation-storage-"),
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })
    const session = await client.createSession()
    await client.startGoalOperation({
      sessionID: session.id,
      objective: "pause when canceling whole goal operation",
      tokenBudget: 100000,
    })
    await requestReceived

    await client.cancelGoalOperation(session.id)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(await client.getGoal(session.id)).toMatchObject({
      status: "paused",
      objective: "pause when canceling whole goal operation",
    })
    expect(client.getGoalOperation(session.id)).toMatchObject({ active: false, status: "paused" })
  })

  test("resumes blocked goals without losing progress and continues when idle", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_goal", function: { name: "update_goal", arguments: "{\"status\":\"complete\"}" } }] } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-goal-resume-blocked-storage-")
    const seedClient = directClient(baseUrl, { storageRoot })
    const session = await seedClient.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    const blocked = await store.replaceGoal(session.id, "resume this blocked goal", "blocked", 100000)
    await store.accountUsage({
      threadID: session.id,
      expectedGoalID: blocked.goalID,
      tokenDelta: 12,
      timeDeltaSeconds: 3,
      mode: "activeOrStopped",
    })
    const client = directClient(baseUrl, {
      storageRoot,
      tools: new ToolRuntime({ append: async () => undefined } as never),
      toolsEnabled: true,
      maxAgentSteps: 4,
    })

    const resumed = await client.resumeGoal(session.id)
    expect(resumed).toMatchObject({
      status: "active",
      goalID: blocked.goalID,
      tokensUsed: 12,
      timeUsedSeconds: 3,
    })
    await waitFor(async () => (await client.getGoal(session.id))?.status === "complete", 1500)

    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0]?.body.messages ?? [])).toContain("resume this blocked goal")
  })

  test("marks active goals blocked on non-retry provider errors", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      response.writeHead(400, { "content-type": "text/plain" }).end("bad request")
    })
    const storageRoot = await tempDir("chipmate-goal-provider-blocked-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    const goal = await store.createGoal(session.id, "provider error should block", 100000)

    let thrown: unknown
    try {
      await client.sendMessage({ sessionID: session.id, text: "trigger provider error" })
    } catch (error) {
      thrown = error
    }
    expect(errorMessage(thrown)).toMatch(/400 Bad Request|socket connection was closed/i)
    const blocked = await client.getGoal(session.id)
    expect(blocked).toMatchObject({
      status: "blocked",
      goalID: goal?.goalID,
    })
  })

  test("marks active goals usage-limited when retryable usage errors are exhausted", async () => {
    process.env.KILO_SESSION_RETRY_LIMIT = "1"
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(429, {
        "content-type": "text/plain",
        "retry-after-ms": "0",
      }).end("too many requests")
    })
    const storageRoot = await tempDir("chipmate-goal-usage-limited-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const store = new GoalStore(extensionContext(storageRoot))
    const goal = await store.createGoal(session.id, "usage limit should pause goal", 100000)

    await expect(client.sendMessage({ sessionID: session.id, text: "trigger usage limit" })).rejects.toThrow(/429 Too Many Requests/)
    const limited = await client.getGoal(session.id)
    expect(requests).toHaveLength(2)
    expect(limited).toMatchObject({
      status: "usage_limited",
      goalID: goal?.goalID,
    })
  })

  test("retries chat completion 429 responses with Retry-After-MS and resends the same request", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (requests.length === 1) {
        response.writeHead(429, {
          "content-type": "text/plain",
          "retry-after-ms": "0",
        }).end("provider overloaded")
        return
      }
      writeChatSse(response, "Recovered answer.")
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-retry-429-storage-"),
      outputLines,
    })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = client.subscribeEvents((event) => events.push(event), controller.signal)
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "please answer" })
    controller.abort()
    await subscription

    expect(textPartsForTest(assistant)).toContain("Recovered answer.")
    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual(requests[0]?.body.messages)
    const retryEvent = events.find((event) =>
      Boolean(
        event &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "session.status" &&
        (event as { properties?: { status?: { type?: unknown } } }).properties?.status?.type === "retry",
      ),
    )
    expect(retryEvent).toMatchObject({
      type: "session.status",
      properties: {
        sessionID: session.id,
        status: {
          type: "retry",
          attempt: 1,
          message: "Too Many Requests",
          next: expect.any(Number),
        },
      },
    })
    expect(outputLines.join("\n")).toContain("[chat-retry] retryable model error")
  })

  test("retries chat completion JSON too_many_requests errors", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      if (requests.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after-ms": "0",
        }).end(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
        return
      }
      writeChatSse(response, "JSON retry recovered.")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-retry-json-storage-") })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "retry json" })

    expect(requests).toHaveLength(2)
    expect(textPartsForTest(assistant)).toContain("JSON retry recovered.")
  })

  test("retries chat completion plain text rate-limit errors", async () => {
    for (const errorText of ["rate limit exceeded", "too many requests"]) {
      const requests: Array<{ body: Record<string, unknown> }> = []
      const baseUrl = await listen(async (request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end()
          return
        }
        requests.push({ body: await collectJson(request) })
        if (requests.length === 1) {
          response.writeHead(429, {
            "content-type": "text/plain",
            "retry-after-ms": "0",
          }).end(errorText)
          return
        }
        writeChatSse(response, `Recovered from ${errorText}.`)
      })
      const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-retry-text-storage-") })
      const session = await client.createSession()

      const assistant = await client.sendMessage({ sessionID: session.id, text: errorText })

      expect(requests).toHaveLength(2)
      expect(textPartsForTest(assistant)).toContain(`Recovered from ${errorText}.`)
    }
  })

  test("does not retry non-rate-limit 400 chat completion errors", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(400, {
        "content-type": "text/plain",
        "retry-after-ms": "0",
      }).end("bad request")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-no-retry-400-storage-") })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "bad request" })).rejects.toThrow(/400 Bad Request/)

    expect(requests).toHaveLength(1)
  })

  test("requests and records reported stream usage chunks", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "Reported answer." } }] }),
        sse({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17,
            completion_tokens_details: { reasoning_tokens: 2 },
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-reported-usage-storage-") })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "usage please" })
    const stats = await client.getUsageStats()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.stream_options).toEqual({ include_usage: true })
    expect(textPartsForTest(assistant)).toContain("Reported answer.")
    expect(assistant.info.usageKind).toBe("reported")
    expect(assistant.info.tokens).toMatchObject({
      total: 17,
      input: 12,
      output: 5,
      reasoning: 2,
      cache: { read: 3 },
    })
    expect(stats.summary.recordedResponses).toBe(1)
    expect(stats.summary.reportedTokens).toBe(14)
  })

  test("keeps only the latest model-call usage for one visible assistant turn", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          sse({ choices: [], usage: { prompt_tokens: 100_000, completion_tokens: 20, total_tokens: 100_020 } }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Final answer." } }] }),
        sse({ choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 } }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-latest-usage-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Read file",
          output: "tool result text",
          approved: true,
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })
    const stats = await client.getUsageStats()

    expect(requests).toHaveLength(2)
    expect(textPartsForTest(assistant)).toContain("Final answer.")
    expect(assistant.info.tokens).toMatchObject({
      total: 1_050,
      input: 1_000,
      output: 50,
    })
    expect(stats.summary.totalTokens).toBe(1_050)
  })

  test("retries stream chat without usage options and records estimated fallback", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      if (body.stream_options) {
        response.writeHead(400, { "content-type": "text/plain" }).end("stream_options include_usage unsupported")
        return
      }
      writeChatSse(response, "Estimated answer.")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-estimated-usage-storage-") })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "usage fallback" })
    const stats = await client.getUsageStats()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body.stream_options).toEqual({ include_usage: true })
    expect(requests[1]?.body.stream_options).toBeUndefined()
    expect(textPartsForTest(assistant)).toContain("Estimated answer.")
    expect(assistant.info.usageKind).toBe("estimated")
    expect(assistant.info.tokens?.total).toBeGreaterThan(0)
    expect(stats.summary.recordedResponses).toBe(1)
    expect(stats.summary.estimatedResponses).toBe(1)
    expect(stats.summary.estimatedTokens).toBe(assistant.info.tokens?.total)
  })

  test("aborts during retry sleep without recording a chat error", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    let retrySeen!: () => void
    const retryEventSeen = new Promise<void>((resolve) => {
      retrySeen = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(429, {
        "content-type": "text/plain",
        "retry-after-ms": "1000",
      }).end("rate limit exceeded")
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-retry-abort-storage-"),
      outputLines,
    })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = client.subscribeEvents((event) => {
      events.push(event)
      if (
        event &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "session.status" &&
        (event as { properties?: { status?: { type?: unknown } } }).properties?.status?.type === "retry"
      ) {
        retrySeen()
      }
    }, controller.signal)
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "abort while retrying" })
    await retryEventSeen
    await client.abortSession(session.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await subscription

    const messages = await client.getMessages(session.id)
    expect(requests).toHaveLength(1)
    expect(messages.some((message) => Boolean(message.info.error))).toBe(false)
    expect(outputLines.join("\n")).not.toContain("[send] interrupted")
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.status",
        properties: expect.objectContaining({
          sessionID: session.id,
          status: expect.objectContaining({ type: "idle" }),
        }),
      }),
    ]))
  })

  test("honors KILO_SESSION_RETRY_LIMIT for chat completion retries", async () => {
    process.env.KILO_SESSION_RETRY_LIMIT = "2"
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ body: await collectJson(request) })
      response.writeHead(429, {
        "content-type": "text/plain",
        "retry-after-ms": "0",
      }).end("too many requests")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-retry-limit-storage-") })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "retry until limit" })).rejects.toThrow(/429 Too Many Requests/)

    expect(requests).toHaveLength(3)
  })

  test("discovers /models and falls back to configured model names", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/v1/models") {
        json(response, 200, { data: [{ id: "gpt-chip" }, { id: "qwen-fim" }] })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: true,
      state: "connected",
      detail: "provider /models",
      version: "direct-openai-compatible",
    })
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "chat-model", isDefault: true, source: "configured" }),
      expect.objectContaining({ id: "completion-model", isDefault: false, source: "configured" }),
      expect.objectContaining({ id: "gpt-chip", providerID: "openai-compatible", providerIndex: 0, source: "provider" }),
      expect.objectContaining({ id: "qwen-fim", providerIndex: 1, providerName: "OpenAI Compatible", source: "provider" }),
    ])
  })

  test("health reports disconnected when provider settings are incomplete", async () => {
    const client = directClient("")

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "disconnected",
      detail: "Ready. Configure an OpenAI-compatible provider to start ChipMate.",
      version: "direct-openai-compatible",
    })
  })

  test("health reports authFailed for invalid provider credentials", async () => {
    const requests: string[] = []
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? "")
      if (request.url === "/v1/models") {
        json(response, 401, { error: { message: "invalid token" } })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { apiKey: "" })

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "authFailed",
      detail: "Provider authentication failed. Set a valid ChipMate provider API key.",
      version: "direct-openai-compatible",
    })
    expect(requests).toEqual(["/v1/models"])
  })

  test("health falls back from unsupported /models to a minimal chat probe", async () => {
    const requests: Array<{ url?: string; body?: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      requests.push({ url: request.url })
      if (request.url === "/v1/models") {
        response.writeHead(404).end()
        return
      }
      if (request.url === "/v1/chat/completions") {
        const body = await collectJson(request)
        requests[requests.length - 1].body = body
        json(response, 200, { choices: [{ message: { role: "assistant", content: "ok" } }] })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: true,
      state: "connected",
      detail: "provider direct-openai-compatible",
      version: "direct-openai-compatible",
    })
    expect(requests.map((request) => request.url)).toEqual(["/v1/models", "/v1/chat/completions"])
    expect(requests[1]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      max_tokens: 1,
    })
  })

  test("health reports authFailed when the chat probe rejects credentials", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(404).end()
        return
      }
      if (request.url === "/v1/chat/completions") {
        await collectJson(request)
        json(response, 403, { error: { message: "Unauthorized API key" } })
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { apiKey: "bad-token" })

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "authFailed",
      detail: "Provider authentication failed. Set a valid ChipMate provider API key.",
      version: "direct-openai-compatible",
    })
  })

  test("health reports provider probe errors without entering connected state", async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "text/html" }).end("<html>not json</html>")
        return
      }
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl)

    await expect(client.health()).resolves.toEqual({
      healthy: false,
      state: "error",
      detail: "Provider /models probe returned malformed JSON.",
      version: "direct-openai-compatible",
    })
  })

  test("plans terminal commands from provider JSON without exposing tools", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      json(response, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              type: "command",
              command: "sudo apt-get update && sudo apt-get install -y build-essential",
              explanation: "Install Linux compiler build tools.",
              title: "安装 Linux 构建工具",
              purpose: "安装编译项目常用工具链。",
              expectedOutcome: "终端会显示 apt 安装输出。",
              riskNote: "需要 sudo 权限，会修改系统软件包。",
              confidence: "high",
            }),
          },
        }],
      })
    })
    const client = directClient(baseUrl, { toolsEnabled: true })

    await expect(client.planTerminalCommand({
      mode: "initial",
      cwd: "/repo",
      userText: "帮我安装 build-essentials",
      recentActivity: ["$ pwd"],
      projectContext: {
        cwd: "/repo",
        root: "/repo",
        relativeCwd: ".",
        rootFiles: ["configure", "meson.build", "README.rst"],
        buildFiles: ["configure", "meson.build"],
        buildDirectories: ["build"],
        docs: ["docs/devel/build-system.rst"],
        snippets: [{
          path: "docs/devel/build-system.rst",
          kind: "doc",
          text: "QEMU uses Meson and Ninja for builds.",
          truncated: false,
        }],
        hints: ["configure script", "Meson"],
        truncated: false,
        errors: [],
      },
    })).resolves.toEqual({
      kind: "command",
      command: "sudo apt-get update && sudo apt-get install -y build-essential",
      explanation: "Install Linux compiler build tools.",
      title: "安装 Linux 构建工具",
      purpose: "安装编译项目常用工具链。",
      expectedOutcome: "终端会显示 apt 安装输出。",
      riskNote: "需要 sudo 权限，会修改系统软件包。",
      confidence: "high",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      temperature: 0,
    })
    expect(requests[0]?.body).not.toHaveProperty("tools")
    const prompt = JSON.stringify(requests[0]?.body.messages)
    expect(prompt).toContain("Current working directory: /repo")
    expect(prompt).toContain("Project context:")
    expect(prompt).toContain("Build files: configure, meson.build")
    expect(prompt).toContain("Relevant docs: docs/devel/build-system.rst")
    expect(prompt).toContain("QEMU uses Meson and Ninja")
    expect(prompt).toContain("Do not claim you read or verified files that are not present in Project context")
    expect(prompt).toContain("title")
    expect(prompt).toContain("purpose")
    expect(prompt).toContain("expectedOutcome")
    expect(prompt).toContain("riskNote")
    expect(prompt).toContain("use `cloc .` instead of `cloc`")
    expect(prompt).toContain("Shell kind:")
    expect(prompt).toContain("find . -type f -name '*.d' -print")
    expect(prompt).toContain("Get-ChildItem -Path . -Recurse -Filter *.d -File")
    expect(prompt).toContain("cmd /c dir /s /b *.d")
  })

  test("uses provider maxTokens for terminal planning without a 1024 cap", async () => {
    const cases = [
      { configured: 4096, expected: 4096 },
      { configured: 8192, expected: 8192 },
      { configured: 16384, expected: 16384 },
      { configured: 128, expected: 256 },
    ]

    for (const item of cases) {
      const requests: Array<{ body: Record<string, unknown> }> = []
      const outputLines: string[] = []
      const baseUrl = await listen(async (request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end()
          return
        }
        const body = await collectJson(request)
        requests.push({ body })
        json(response, 200, {
          choices: [{
            message: {
              role: "assistant",
              content: JSON.stringify({ type: "answer", message: "ok" }),
            },
          }],
        })
      })
      const client = directClient(baseUrl, { maxTokens: item.configured, outputLines })

      await expect(client.planTerminalCommand({
        mode: "initial",
        cwd: "/repo",
        userText: "status",
      })).resolves.toEqual({ kind: "answer", message: "ok" })

      expect(requests[0]?.body.max_tokens).toBe(item.expected)
      expect(outputLines.join("\n")).toContain(`maxTokens=${item.expected}`)
    }
  })

  test("summarizes terminal command results as short JSON without tools", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      json(response, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              status: "warning",
              headline: "统计得到 234659 total",
              resultLines: ["统计得到 234659 total。"],
              warnings: ["wc 跳过了一些目录。"],
              nextStep: "结果可用，ChipMate 不会继续修复。",
            }),
          },
        }],
      })
    })
    const client = directClient(baseUrl, { outputLines, toolsEnabled: true })

    await expect(client.summarizeTerminalCommandResult({
      cwd: "/repo",
      command: "git ls-files -z | xargs -0 wc -l | tail -1",
      source: "repair",
      originalRequest: "帮我统计代码行数",
      title: "统计项目代码行数",
      purpose: "统计当前项目代码行数",
      expectedOutcome: "显示 total 行",
      risk: "low",
      failureBasis: "计划命令 `cloc .` 未执行。",
      exitCode: 1,
      signalName: null,
      elapsedMs: 42,
      outputTail: "wc: roms/edk2: read: Is a directory\n  234659 total\n",
      hasUsableResult: true,
      warnings: ["wc 目录 warning"],
    })).resolves.toEqual({
      status: "warning",
      headline: "统计得到 234659 total",
      resultLines: ["统计得到 234659 total。"],
      warnings: ["wc 跳过了一些目录。"],
      nextStep: "结果可用，ChipMate 不会继续修复。",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      temperature: 0,
    })
    expect(requests[0]?.body).not.toHaveProperty("tools")
    const prompt = JSON.stringify(requests[0]?.body.messages)
    expect(prompt).toContain("Original user request: 帮我统计代码行数")
    expect(prompt).toContain("Executed command: git ls-files -z | xargs -0 wc -l | tail -1")
    expect(prompt).toContain("Exit code: 1")
    expect(prompt).toContain("Has usable result despite failure: yes")
    expect(prompt).toContain("wc: roms/edk2")
    expect(prompt).toContain("Repair basis: 计划命令 `cloc .` 未执行。")
    expect(outputLines.join("\n")).toContain("[terminal-summary] request")
  })

  test("rejects invalid terminal result summaries and ignores hidden reasoning-only responses", async () => {
    const invalidBaseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, { choices: [{ message: { role: "assistant", content: "not json" } }] })
    })
    const invalidClient = directClient(invalidBaseUrl)

    await expect(invalidClient.summarizeTerminalCommandResult({
      cwd: "/repo",
      command: "npm test",
      source: "agent",
      exitCode: 1,
      signalName: null,
      elapsedMs: 1,
      outputTail: "failed",
      hasUsableResult: false,
    })).rejects.toThrow(/malformed JSON/)

    const hiddenBaseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, { choices: [{ message: { role: "assistant", content: "", reasoning_content: "{\"status\":\"success\"}" } }] })
    })
    const hiddenClient = directClient(hiddenBaseUrl)

    await expect(hiddenClient.summarizeTerminalCommandResult({
      cwd: "/repo",
      command: "npm test",
      source: "agent",
      exitCode: 0,
      signalName: null,
      elapsedMs: 1,
      outputTail: "ok",
      hasUsableResult: true,
    })).rejects.toThrow(/did not include message content/)
  })

  test("keeps legacy terminal command plans compatible when optional display fields are absent", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              type: "command",
              command: "cloc",
              explanation: "Count source lines.",
              confidence: "medium",
            }),
          },
        }],
      })
    })
    const client = directClient(baseUrl)

    await expect(client.planTerminalCommand({
      mode: "initial",
      cwd: "/repo",
      userText: "count lines",
    })).resolves.toEqual({
      kind: "command",
      command: "cloc",
      explanation: "Count source lines.",
      confidence: "medium",
      title: undefined,
      purpose: undefined,
      expectedOutcome: undefined,
      riskNote: undefined,
    })
  })

  test("retries terminal command planning once when JSON is invalid without dropping repair context", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      json(response, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: requests.length === 1
              ? "not json"
              : JSON.stringify({ type: "answer", message: "No command needed." }),
          },
        }],
      })
    })
    const client = directClient(baseUrl)

    await expect(client.planTerminalCommand({
      mode: "repair",
      cwd: "/repo",
      userText: "帮我统计仓库代码行数",
      failedCommand: "cloc .",
      failureKind: "missing-command",
      missingCommand: "cloc",
      repairPreference: "prefer-no-install-fallback",
      platform: "darwin",
      shell: "/bin/zsh",
      exitCode: 127,
      outputTail: "zsh:1: command not found: cloc",
      attemptedCommands: ["cloc ."],
      failureReason: "missing command: cloc",
    })).resolves.toEqual({ kind: "answer", message: "No command needed." })

    expect(requests).toHaveLength(2)
    const retryPrompt = JSON.stringify(requests[1]?.body.messages)
    expect(retryPrompt).toContain("previous assistant response was invalid")
    expect(retryPrompt).toContain("Keep using the original user request and all repair context above")
    expect(retryPrompt).toContain("User request: 帮我统计仓库代码行数")
    expect(retryPrompt).toContain("Failed command: cloc .")
    expect(retryPrompt).toContain("Missing command: cloc")
    expect(retryPrompt).toContain("zsh:1: command not found: cloc")
  })

  test("retries terminal command planning once when response omits message content without dropping repair context", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      json(response, 200, requests.length === 1
        ? { choices: [{ message: { role: "assistant" } }] }
        : { choices: [{ message: { role: "assistant", content: JSON.stringify({ type: "answer", message: "No command needed." }) } }] })
    })
    const outputLines: string[] = []
    const client = directClient(baseUrl, { outputLines })

    await expect(client.planTerminalCommand({
      mode: "repair",
      cwd: "/repo",
      userText: "count source lines",
      failedCommand: "cloc .",
      failureKind: "missing-command",
      missingCommand: "cloc",
      repairPreference: "prefer-no-install-fallback",
      platform: "linux",
      shell: "/bin/bash",
      exitCode: 127,
      outputTail: "bash: cloc: command not found",
      attemptedCommands: ["cloc ."],
      failureReason: "missing command: cloc",
    })).resolves.toEqual({ kind: "answer", message: "No command needed." })

    expect(requests).toHaveLength(2)
    const retryPrompt = JSON.stringify(requests[1]?.body.messages)
    expect(retryPrompt).toContain("previous assistant response was invalid")
    expect(retryPrompt).toContain("User request: count source lines")
    expect(retryPrompt).toContain("Failed command: cloc .")
    expect(retryPrompt).toContain("Missing command: cloc")
    expect(retryPrompt).toContain("bash: cloc: command not found")
    expect(outputLines.join("\n")).toContain("rawSummary=")
  })

  test("accepts OpenAI-compatible terminal planner response shapes", async () => {
    const cases = [
      {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({ type: "answer", message: "from parts" }) }],
            },
          }],
        },
        expected: { kind: "answer", message: "from parts" },
      },
      {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: [{ type: "text", text: { value: JSON.stringify({ type: "answer", message: "from nested text value" }) } }],
            },
          }],
        },
        expected: { kind: "answer", message: "from nested text value" },
      },
      {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: [{ type: "output_text", content: JSON.stringify({ type: "answer", message: "from content field" }) }],
            },
          }],
        },
        expected: { kind: "answer", message: "from content field" },
      },
      {
        response: {
          choices: [{
            message: {
              role: "assistant",
              content: { type: "answer", message: "from object" },
            },
          }],
        },
        expected: { kind: "answer", message: "from object" },
      },
      {
        response: { type: "answer", message: "from top-level" },
        expected: { kind: "answer", message: "from top-level" },
      },
      {
        response: {
          choices: [{
            text: JSON.stringify({ type: "answer", message: "from choice text" }),
          }],
        },
        expected: { kind: "answer", message: "from choice text" },
      },
      {
        response: {
          choices: [{
            message: {
              role: "assistant",
              tool_calls: [{
                id: "call_terminal_plan",
                type: "function",
                function: {
                  name: "terminal_plan",
                  arguments: JSON.stringify({ type: "answer", message: "from tool call arguments" }),
                },
              }],
            },
          }],
        },
        expected: { kind: "answer", message: "from tool call arguments" },
      },
    ] as const

    for (const item of cases) {
      const baseUrl = await listen(async (request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end()
          return
        }
        await collectJson(request)
        json(response, 200, item.response)
      })
      const client = directClient(baseUrl)

      await expect(client.planTerminalCommand({
        mode: "initial",
        cwd: "/repo",
        userText: "status",
      })).resolves.toEqual(item.expected)
    }
  })

  test("returns clarify terminal plans and includes repair context", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      json(response, 200, {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({ type: "clarify", question: "Which package manager should I use?" }),
          },
        }],
      })
    })
    const client = directClient(baseUrl)

    await expect(client.planTerminalCommand({
      mode: "repair",
      cwd: "/repo",
      userText: "install the dependency",
      failedCommand: "apt-get install dependency",
      failureKind: "missing-command",
      missingCommand: "apt-get",
      repairPreference: "prefer-no-install-fallback",
      platform: "darwin",
      shell: "/bin/zsh",
      exitCode: 127,
      outputTail: "apt-get: command not found",
      attemptedCommands: ["apt-get install dependency"],
      failureReason: "command exited with code 127",
    })).resolves.toEqual({ kind: "clarify", question: "Which package manager should I use?" })

    const prompt = JSON.stringify(requests[0]?.body.messages)
    expect(prompt).toContain("Mode: repair")
    expect(prompt).toContain("Failed command: apt-get install dependency")
    expect(prompt).toContain("Failure kind: missing-command")
    expect(prompt).toContain("Missing command: apt-get")
    expect(prompt).toContain("Repair preference: prefer-no-install-fallback")
    expect(prompt).toContain("Platform: darwin")
    expect(prompt).toContain("Shell: /bin/zsh")
    expect(prompt).toContain("apt-get: command not found")
  })

  test("surfaces terminal command planner provider errors and invalid retry responses", async () => {
    const failingBaseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 500, { error: { message: "provider down" } })
    })
    const failingClient = directClient(failingBaseUrl)

    await expect(failingClient.planTerminalCommand({
      mode: "initial",
      cwd: "/repo",
      userText: "install tools",
    })).rejects.toThrow(/Terminal command planning failed: 500/)

    const invalidBaseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, { choices: [{ message: { role: "assistant", content: "still not json" } }] })
    })
    const invalidClient = directClient(invalidBaseUrl)

    await expect(invalidClient.planTerminalCommand({
      mode: "initial",
      cwd: "/repo",
      userText: "install tools",
    })).rejects.toThrow(/invalid response after retry/)
  })

  test("reports missing terminal planner content after one retry with response summaries", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, { choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "hidden" } }] })
    })
    const client = directClient(baseUrl, { outputLines })

    await expect(client.planTerminalCommand({
      mode: "initial",
      cwd: "/repo",
      userText: "install tools",
    })).rejects.toThrow(/did not include message content/)

    const output = outputLines.join("\n")
    expect(output).toContain("invalid response, retrying once")
    expect(output).toContain("invalid response after retry")
    expect(output).toContain("rawSummary=")
    expect(output).toContain("finish_reason=length")
    expect(output).toContain("maxTokens=256")
    expect(output).toContain("reasoning=present")
    expect(output).not.toContain("hidden")
  })

  test("does not expose or execute tool calls when tools are disabled", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "Checking " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Read file",
            output: "tool result text",
            approved: true,
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: true,
    })
    expect(requests[0]?.body).not.toHaveProperty("tools")
    expect(requests[0]?.body).not.toHaveProperty("tool_choice")
    expect(requests[0]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
    expect(toolResults).toEqual([])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("工具调用已关闭") }),
    ]))
  })

  test("emits pending and running tool parts before a streamed tool call completes", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    let releaseTool: ((result: ToolRuntimeResult) => void) | undefined
    const toolStarted = new Promise<ToolRuntimeResult>((resolve) => {
      releaseTool = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "I have sufficient evidence. Let me organize this into a DiagramIR." } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_validate", function: {} }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "chipmate_validate_diagram_ir" } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"diagram\":{\"nodes\":[]}}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Diagram rendered." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const events: unknown[] = []
    const subscriptionController = new AbortController()
    const client = directClient(baseUrl, {
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_validate_diagram_ir",
            description: "Validate DiagramIR",
            parameters: { type: "object", properties: { diagram: { type: "object" } } },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => toolStarted,
      } as unknown as ToolRuntimeInstance,
    })
    void client.subscribeEvents((event) => events.push(event), subscriptionController.signal)

    const session = await client.createSession()
    const send = client.sendMessage({ sessionID: session.id, text: "draw architecture" })
    await waitFor(() => toolPartEvents(events, "call_validate").some((part) => part.state?.status === "running"))
    const pendingPart = toolPartEvents(events, "call_validate").find((part) => part.state?.status === "pending")
    const runningPart = toolPartEvents(events, "call_validate").find((part) => part.state?.status === "running")
    expect(pendingPart).toMatchObject({ tool: "chipmate_validate_diagram_ir" })
    expect(runningPart).toMatchObject({ tool: "chipmate_validate_diagram_ir" })
    expect(runningPart?.state).not.toHaveProperty("input")
    expect(runningPart?.state).not.toHaveProperty("output")
    expect(runningPart?.state).not.toHaveProperty("error")
    expect(requests).toHaveLength(1)

    releaseTool?.({
      title: "DiagramIR valid",
      output: "DiagramIR valid",
      approved: true,
      status: "completed",
      risk: "low",
    })
    const assistant = await send
    subscriptionController.abort()

    expect(requests).toHaveLength(2)
    expect(toolPartEvents(events, "call_validate").map((part) => part.state?.status)).toEqual(expect.arrayContaining(["pending", "running", "completed"]))
    const finalToolParts = assistant.parts.filter((part) => "id" in part && part.id === "call_validate")
    expect(finalToolParts).toHaveLength(1)
    expect(finalToolParts[0]).toMatchObject({
      type: "tool",
      tool: "chipmate_validate_diagram_ir",
      state: expect.objectContaining({
        status: "completed",
        input: { diagram: { nodes: [] } },
        output: "DiagramIR valid",
      }),
    })
  })

  test("pauses for clarification and resumes the same tool call after the answer", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "我需要先确认一个关键条件。" } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_clarify", function: { name: "chipmate_ask_user_clarification", arguments: "{\"reason\":\"Need diagram format\",\"questions\":[{\"id\":\"diagram_type\",\"question\":\"要画哪种图？\",\"choices\":[{\"id\":\"drawio\",\"label\":\"draw.io\"},{\"id\":\"mermaid\",\"label\":\"Mermaid\"}]}]}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已按 draw.io 继续。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-clarification-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_ask_user_clarification",
            description: "Use when a bounded user answer is required. Do not use when the request is clear. Returns a pending clarification request.",
            parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Ask user clarification",
          output: JSON.stringify({ kind: "clarification", clarificationId: "clarify-diagram-format", status: "waiting_for_user" }),
          approved: true,
          status: "user-input-required",
          risk: "low",
          artifacts: [{
            kind: "clarification",
            payload: {
              kind: "clarification",
              clarificationId: "clarify-diagram-format",
              title: "Clarification needed: 要画哪种图？",
              reason: "Need diagram format",
              blocking: true,
              questions: [{
                id: "diagram_type",
                question: "要画哪种图？",
                choices: [
                  { id: "drawio", label: "draw.io" },
                  { id: "mermaid", label: "Mermaid" },
                ],
              }],
            },
          }],
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const send = client.sendMessage({ sessionID: session.id, text: "帮我画图" })
    await waitFor(() => client.resolveClarification("clarify-diagram-format", [{
      questionId: "diagram_type",
      choiceId: "drawio",
      text: "draw.io",
    }]))
    const assistant = await send
    const messages = await client.getMessages(session.id)
    const secondRequestMessages = (requests[1]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: string }>
    const clarificationToolMessage = secondRequestMessages.find((message) => message.role === "tool" && message.tool_call_id === "call_clarify")

    expect(requests).toHaveLength(2)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
    expect(clarificationToolMessage?.content).toContain("\"kind\":\"clarification_answer\"")
    expect(clarificationToolMessage?.content).toContain("\"choiceId\":\"drawio\"")
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("已按 draw.io 继续。") }),
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_ask_user_clarification",
        state: expect.objectContaining({ status: "completed", output: expect.stringContaining("clarification_answer") }),
      }),
      expect.objectContaining({
        type: "clarification",
        clarificationId: "clarify-diagram-format",
        status: "answered",
        toolCallID: "call_clarify",
        answers: [expect.objectContaining({ questionId: "diagram_type", choiceId: "drawio", text: "draw.io" })],
      }),
    ]))
    expect(outputLines.join("\n")).not.toContain("fallback")
  })

  test("sends recent clean chat history without replaying old local context", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? "First answer." : "Second answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-history-storage-") })
    const session = await client.createSession()

    await client.sendMessage({
      sessionID: session.id,
      text: [
        "User question:",
        "Explain the failure",
        "",
        "Local workspace context:",
        "secret old file context",
        "",
        "Local code graph evidence:",
        "secret old graph evidence",
      ].join("\n"),
    })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user", content: "Explain the failure" }),
      expect.objectContaining({ role: "assistant", content: "First answer." }),
      { role: "user", content: "continue" },
    ])
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("secret old file context")
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("secret old graph evidence")
  })

  test("persists plugin-chat mode while replaying clean unwrapped history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? "First reply." : "Second reply." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-plugin-chat-history-storage-") })
    const session = await client.createSession(CHAT_SESSION_TITLE)

    await client.sendMessage({ sessionID: session.id, text: "first question", messageMode: "plugin-chat" })
    await client.sendMessage({ sessionID: session.id, text: "continue", messageMode: "plugin-chat" })

    const persisted = await client.getMessages(session.id)
    const firstUser = persisted.find((message) => message.info.role === "user")
    const firstAssistant = persisted.find((message) => message.info.role === "assistant")
    expect(firstUser?.info.mode).toBe("plugin-chat")
    expect(firstAssistant?.info.mode).toBe("plugin-chat")
    expect(textPartsForTest(firstUser ?? { parts: [] })).toBe("User question:\nfirst question")
    expect(requests[1]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user", content: "first question" }),
      expect.objectContaining({ role: "assistant", content: "First reply." }),
      { role: "user", content: "continue" },
    ])
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("User question:\nfirst question")
  })

  test("keeps chat history disabled when maxHistoryTurns is zero", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      requests.push({ url: request.url, body: await collectJson(request) })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      historyTurns: 0,
      storageRoot: await tempDir("chipmate-no-history-storage-"),
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "first" })
    await client.sendMessage({ sessionID: session.id, text: "second" })

    expect(requests[1]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "second" },
    ])
  })

  test("trims long assistant history from the front and keeps the tail", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const longAnswer = `${"A".repeat(200)}TAIL`
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? longAnswer : "done" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      historyBytes: 60,
      storageRoot: await tempDir("chipmate-trim-history-storage-"),
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "first" })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    const messages = requests[1]?.body.messages as Array<{ role: string; content?: string }>
    const assistantHistory = messages.find((message) => message.role === "assistant")?.content ?? ""
    expect(assistantHistory).toEndWith("TAIL")
    expect(assistantHistory.length).toBeLessThanOrEqual(60)
    expect(assistantHistory).not.toContain("A".repeat(80))
  })

  test("summarizes older chat history beyond the raw recent window and refreshes incrementally", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    let streamCount = 0
    let summaryCount = 0
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (body.stream === false) {
        summaryCount += 1
        json(response, 200, {
          choices: [{
            message: {
              content: JSON.stringify({
                summary: summaryCount === 1 ? "Old preserved memory." : "Updated preserved memory.",
                importantDecisions: [`summary-${summaryCount}`],
                openQuestions: [],
                filesAndSymbols: [],
                userPreferences: [],
              }),
            },
          }],
        })
        return
      }
      streamCount += 1
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: `answer ${streamCount}` } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-memory-storage-")
    const client = directClient(baseUrl, {
      storageRoot,
      historyTurns: 10,
      memorySummaryTriggerOverflowTurns: 2,
    })
    const session = await client.createSession()

    for (let index = 1; index <= 13; index += 1) {
      await client.sendMessage({ sessionID: session.id, text: `question ${index}` })
    }

    await waitFor(() => requests.filter((item) => item.body.stream === false).length === 1)
    const summaryRequests = requests.filter((item) => item.body.stream === false)
    const firstSummaryPrompt = JSON.stringify(summaryRequests[0]?.body.messages)
    expect(firstSummaryPrompt).toContain("question 1")
    expect(firstSummaryPrompt).toContain("question 2")
    expect(firstSummaryPrompt).not.toContain("question 3")

    const streamRequests = requests.filter((item) => item.body.stream === true)
    const thirteenthRequestMessages = streamRequests.at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(requests.findIndex((item) => item.body === streamRequests.at(-1)?.body)).toBeLessThan(requests.findIndex((item) => item.body === summaryRequests[0]?.body))
    expect(JSON.stringify(thirteenthRequestMessages)).not.toContain("Conversation memory summary")

    await client.sendMessage({ sessionID: session.id, text: "question 14" })

    const fourteenthRequestMessages = requests.filter((item) => item.body.stream === true).at(-1)?.body.messages as Array<{ role: string; content?: string }>
    const memoryMessage = thirteenthRequestMessages.find((message) =>
      message.role === "assistant" && typeof message.content === "string" && message.content.includes("Conversation memory summary")
    )
    expect(memoryMessage).toBeUndefined()
    const fourteenthMemoryMessage = fourteenthRequestMessages.find((message) =>
      message.role === "assistant" && typeof message.content === "string" && message.content.includes("Conversation memory summary")
    )
    expect(fourteenthMemoryMessage?.content).toContain("Old preserved memory.")
    const fourteenthUserMessages = fourteenthRequestMessages.filter((message) => message.role === "user").map((message) => message.content)
    expect(fourteenthUserMessages).not.toContain("question 1")
    expect(fourteenthUserMessages).not.toContain("question 2")
    expect(fourteenthUserMessages).toContain("question 4")
    expect(fourteenthUserMessages).toContain("question 13")
    expect(fourteenthUserMessages).toContain("question 14")

    await client.sendMessage({ sessionID: session.id, text: "question 15" })

    await waitFor(() => requests.filter((item) => item.body.stream === false).length === 2)
    const refreshedSummaryRequests = requests.filter((item) => item.body.stream === false)
    const secondSummaryPrompt = JSON.stringify(refreshedSummaryRequests[1]?.body.messages)
    expect(secondSummaryPrompt).toContain("Old preserved memory.")
    expect(secondSummaryPrompt).toContain("question 3")
    expect(secondSummaryPrompt).toContain("question 4")
    expect(secondSummaryPrompt).not.toContain("question 1")
    expect(secondSummaryPrompt).not.toContain("question 2")

    const sessionPath = join(storageRoot, "sessions", `${session.id}.jsonl`)
    await waitFor(async () => (await readFile(sessionPath, "utf8")).includes("\"type\":\"memory\""))
    const sessionLog = await readFile(sessionPath, "utf8")
    expect(sessionLog).toContain("\"type\":\"memory\"")
    expect(sessionLog).toContain("Updated preserved memory.")
  })

  test("persists user history text and replays compact evidence ledger separately", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 1 ? "First answer." : "Second answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-evidence-ledger-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const packedPrompt = [
      "User question:",
      "Explain the failure",
      "",
      "Local workspace context:",
      "secret old file context",
      "",
      "Local code graph evidence:",
      "secret old graph evidence",
    ].join("\n")

    await client.sendMessage({
      sessionID: session.id,
      text: packedPrompt,
      historyText: "Explain the failure",
      evidenceLedger: [{
        source: "local-context",
        kind: "file",
        path: "src/main.c",
        summary: "Attached file src/main.c was included as current local context.",
        truncated: false,
        staleness: "current",
      }],
    })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(JSON.stringify(requests[0]?.body.messages)).toContain("secret old file context")
    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("Explain the failure")
    expect(sessionLog).toContain("\"type\":\"evidence\"")
    expect(sessionLog).toContain("src/main.c")
    expect(sessionLog).not.toContain("secret old file context")
    expect(sessionLog).not.toContain("secret old graph evidence")

    const secondMessages = requests[1]?.body.messages as Array<{ role: string; content?: string }>
    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Explain the failure" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Evidence history") }),
      { role: "user", content: "continue" },
    ]))
    const secondPayload = JSON.stringify(secondMessages)
    expect(secondPayload).toContain("Attached file src/main.c")
    expect(secondPayload).not.toContain("secret old file context")
    expect(secondPayload).not.toContain("secret old graph evidence")
  })

  test("attaches only previous assistant visual evidence to the next chat request", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "Visual answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-visual-context-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const [, previousAssistant] = await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "draw a flow" },
        { role: "assistant", text: "Here is the rendered diagram." },
      ],
    })
    await client.appendVisualEvidence({
      sessionID: session.id,
      messageID: previousAssistant!.info.id,
      kind: "drawio",
      diagramId: "drawio-1",
      title: "Flow diagram",
      sourceHash: "source-a",
      dataUri: tinyPngDataUri(),
      width: 32,
      height: 32,
    })

    await client.sendMessage({ sessionID: session.id, text: "这张图里的箭头是什么意思" })

    const messages = requests[0]?.body.messages as Array<{ role: string; content?: unknown }>
    const currentUser = messages[messages.length - 1]
    expect(currentUser?.role).toBe("user")
    expect(currentUser?.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("这张图里的箭头是什么意思") }),
      expect.objectContaining({
        type: "image_url",
        image_url: expect.objectContaining({ url: tinyPngDataUri() }),
      }),
    ])
    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("\"type\":\"visual_evidence\"")
    expect(sessionLog).not.toContain(tinyPngDataUri())
  })

  test("allows dense visual evidence above the soft image budget but rejects images above the hard budget", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "Dense visual answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-dense-visual-context-storage-")
    const client = directClient(baseUrl, { storageRoot })
    const session = await client.createSession()
    const [, previousAssistant] = await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "draw a dense flow" },
        { role: "assistant", text: "Here is the rendered dense diagram." },
      ],
    })
    const denseByteLength = 1024 * 1024 + 64 * 1024 - 2
    const denseDataUri = pngDataUriWithDecodedBytes(denseByteLength)
    await client.appendVisualEvidence({
      sessionID: session.id,
      messageID: previousAssistant!.info.id,
      kind: "mermaid",
      diagramId: "dense-mermaid",
      dataUri: denseDataUri,
      width: 2048,
      height: 1152,
    })

    await expect(client.appendVisualEvidence({
      sessionID: session.id,
      messageID: previousAssistant!.info.id,
      kind: "drawio",
      diagramId: "too-large-drawio",
      dataUri: pngDataUriWithDecodedBytes(2 * 1024 * 1024 + 4),
      width: 4096,
      height: 4096,
    })).rejects.toThrow("Rendered diagram image is too large for visual context")
    await client.sendMessage({ sessionID: session.id, text: "这张密集图里最长的路径是什么" })

    const messages = requests[0]?.body.messages as Array<{ role: string; content?: unknown }>
    const currentUser = messages[messages.length - 1]
    expect(currentUser?.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("这张密集图里最长的路径是什么") }),
      expect.objectContaining({
        type: "image_url",
        image_url: expect.objectContaining({ url: denseDataUri }),
      }),
    ])
    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain(`"byteLength":${denseByteLength}`)
    expect(sessionLog).not.toContain(denseDataUri)
  })

  test("does not attach visual evidence older than the previous assistant turn or include it in summaries", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (body.stream === false) {
        json(response, 200, { choices: [{ message: { role: "assistant", content: "Summarized text only." } }] })
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "Text answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-visual-window-storage-"),
      historyTurns: 1,
      memorySummaryTriggerOverflowTurns: 1,
    })
    const session = await client.createSession()
    const [, oldAssistant] = await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "draw the first diagram" },
        { role: "assistant", text: "First rendered diagram." },
      ],
    })
    await client.appendVisualEvidence({
      sessionID: session.id,
      messageID: oldAssistant!.info.id,
      kind: "mermaid",
      diagramId: "mermaid-old",
      title: "Old diagram",
      sourceHash: "old-source",
      dataUri: tinyPngDataUri(),
      width: 32,
      height: 32,
    })
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "talk about something else" },
        { role: "assistant", text: "No diagram in this turn." },
      ],
    })

    await client.sendMessage({ sessionID: session.id, text: "继续" })
    await waitFor(() => requests.some((item) => item.body.stream === false))

    const streamRequest = requests.find((item) => item.body.stream === true)
    expect(JSON.stringify(streamRequest?.body.messages)).not.toContain("image_url")
    expect(JSON.stringify(streamRequest?.body.messages)).not.toContain(tinyPngDataUri())
    const summaryRequest = requests.find((item) => item.body.stream === false)
    expect(JSON.stringify(summaryRequest?.body.messages)).not.toContain("image_url")
    expect(JSON.stringify(summaryRequest?.body.messages)).not.toContain(tinyPngDataUri())
  })

  test("falls back to text-only chat when visual input is rejected by the provider", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (requests.length === 1) {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "image_url is not supported" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "Fallback text answer." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const outputLines: string[] = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-visual-fallback-storage-"),
      outputLines,
    })
    const session = await client.createSession()
    const [, previousAssistant] = await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "draw" },
        { role: "assistant", text: "diagram" },
      ],
    })
    await client.appendVisualEvidence({
      sessionID: session.id,
      messageID: previousAssistant!.info.id,
      kind: "drawio",
      dataUri: tinyPngDataUri(),
      width: 32,
      height: 32,
    })

    const assistant = await client.sendMessage({ sessionID: session.id, text: "explain this image" })

    expect(textPartsForTest(assistant)).toContain("Fallback text answer.")
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0]?.body.messages)).toContain("image_url")
    expect(JSON.stringify(requests[1]?.body.messages)).not.toContain("image_url")
    expect(outputLines.join("\n")).toContain("[visual-context] provider rejected image input; retrying text-only")
  })

  test("keeps rolling memory disabled when memorySummary is off", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-memory-disabled-storage-"),
      historyTurns: 10,
      memorySummaryEnabled: false,
    })
    const session = await client.createSession()

    for (let index = 1; index <= 13; index += 1) {
      await client.sendMessage({ sessionID: session.id, text: `disabled question ${index}` })
    }

    expect(requests.every((item) => item.body.stream === true)).toBe(true)
    const lastMessages = requests.at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(JSON.stringify(lastMessages)).not.toContain("Conversation memory summary")
    const lastUserMessages = lastMessages.filter((message) => message.role === "user").map((message) => message.content)
    expect(lastUserMessages).not.toContain("disabled question 1")
    expect(lastUserMessages).not.toContain("disabled question 2")
    expect(lastUserMessages).toContain("disabled question 13")
  })

  test("falls back to recent raw history when rolling memory summarization fails", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (body.stream === false) {
        json(response, 200, { choices: [{ message: { content: "not json" } }] })
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      outputLines,
      storageRoot: await tempDir("chipmate-memory-failure-storage-"),
      historyTurns: 10,
      memorySummaryTriggerOverflowTurns: 2,
    })
    const session = await client.createSession()

    for (let index = 1; index <= 13; index += 1) {
      await client.sendMessage({ sessionID: session.id, text: `failure question ${index}` })
    }

    await waitFor(() => requests.filter((item) => item.body.stream === false).length === 1)
    const lastMessages = requests.filter((item) => item.body.stream === true).at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(JSON.stringify(lastMessages)).not.toContain("Conversation memory summary")
    expect(JSON.stringify(lastMessages)).toContain("failure question 13")
    expect(outputLines.some((line) => line.includes("[chat-memory] summary failed"))).toBe(true)
  })

  test("allows rolling memory when maxHistoryTurns disables raw history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (body.stream === false) {
        json(response, 200, {
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "Memory without raw history.",
                importantDecisions: [],
                openQuestions: [],
                filesAndSymbols: [],
                userPreferences: [],
              }),
            },
          }],
        })
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-memory-no-raw-storage-"),
      historyTurns: 0,
      memorySummaryTriggerOverflowTurns: 2,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "raw off first" })
    await client.sendMessage({ sessionID: session.id, text: "raw off second" })
    await client.sendMessage({ sessionID: session.id, text: "raw off third" })

    await waitFor(() => requests.filter((item) => item.body.stream === false).length === 1)
    const lastMessages = requests.filter((item) => item.body.stream === true).at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(JSON.stringify(lastMessages)).not.toContain("Memory without raw history.")
    expect(JSON.stringify(lastMessages)).not.toContain("raw off first")
    expect(JSON.stringify(lastMessages)).not.toContain("raw off second")
    expect(JSON.stringify(lastMessages)).toContain("raw off third")

    await client.sendMessage({ sessionID: session.id, text: "raw off fourth" })
    const nextMessages = requests.filter((item) => item.body.stream === true).at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(JSON.stringify(nextMessages)).toContain("Memory without raw history.")
    expect(JSON.stringify(nextMessages)).toContain("raw off fourth")
  })

  test("caps stored rolling memory summaries by configured bytes", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (body.stream === false) {
        json(response, 200, {
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "A".repeat(200),
                importantDecisions: ["B".repeat(200)],
                openQuestions: [],
                filesAndSymbols: [],
                userPreferences: [],
              }),
            },
          }],
        })
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-memory-cap-storage-")
    const client = directClient(baseUrl, {
      storageRoot,
      historyTurns: 10,
      memorySummaryMaxBytes: 40,
      memorySummaryTriggerOverflowTurns: 2,
    })
    const session = await client.createSession()

    for (let index = 1; index <= 13; index += 1) {
      await client.sendMessage({ sessionID: session.id, text: `cap question ${index}` })
    }

    const sessionPath = join(storageRoot, "sessions", `${session.id}.jsonl`)
    await waitFor(async () => (await readFile(sessionPath, "utf8")).includes("\"type\":\"memory\""))
    const sessionLog = await readFile(sessionPath, "utf8")
    const memoryEvent = sessionLog.split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; memory?: { summary?: string } })
      .find((event) => event.type === "memory")
    expect(memoryEvent?.memory?.summary?.length).toBeLessThanOrEqual(40)

    await client.sendMessage({ sessionID: session.id, text: "cap question 14" })
    const lastMessages = requests.filter((item) => item.body.stream === true).at(-1)?.body.messages as Array<{ role: string; content?: string }>
    expect(lastMessages[1]?.content).toContain("Conversation memory summary")
  })

  test("streams chat completions, executes tool calls, and stores session JSONL on the workspace host", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":" } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Done with tool." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const storageRoot = await tempDir("chipmate-direct-storage-")
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      storageRoot,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Read file",
            output: "tool result text",
            approved: true,
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect repo" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: true,
      tool_choice: "auto",
    })
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(["chipmate_read"])
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "tool result text" }),
    ]))
    expect(toolResults).toEqual([{ name: "chipmate_read", arguments: { path: "README.md" } }])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Done with tool." }),
      expect.objectContaining({ type: "tool", tool: "chipmate_read" }),
    ]))

    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("\"type\":\"session\"")
    expect(sessionLog).toContain("\"role\":\"user\"")
    expect(sessionLog).toContain("\"role\":\"assistant\"")
  })

  test("inserts a rendered draw.io diagram part after the draw.io tool succeeds", async () => {
    const generated = await generateDrawioDiagram({
      diagramIr: {
        title: "Chat renderer flow",
        diagramType: "flowchart",
        composition: { mode: "multi", reason: "User asked for overview and detail diagrams." },
        nodes: [{ id: "model", label: "Model" }, { id: "tool", label: "Tool" }],
        edges: [{ source: "model", target: "tool", label: "spec" }],
        subdiagrams: [{
          title: "Renderer detail",
          diagramType: "flowchart",
          nodes: [{ id: "runtime", label: "Runtime" }, { id: "png", label: "PNG" }],
          edges: [{ source: "runtime", target: "png", label: "export" }],
        }],
      },
    })
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Chat renderer flow\",\"nodes\":[{\"id\":\"model\",\"label\":\"Model\"},{\"id\":\"tool\",\"label\":\"Tool\"}],\"edges\":[{\"source\":\"model\",\"target\":\"tool\",\"label\":\"spec\"}]}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "图已经生成。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_drawio_diagram",
            description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
            parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: `Created draw.io diagram: ${generated.title}`,
          output: JSON.stringify({
            kind: "drawio",
            diagramId: generated.diagramId,
            title: generated.title,
            layoutEngine: "elk",
            counts: {
              nodes: generated.normalizedSpec.nodes.length,
              edges: generated.normalizedSpec.edges.length,
              containers: generated.normalizedSpec.containers.length,
              additionalDiagrams: generated.additionalDiagrams?.length ?? 0,
            },
            hasChatDiagramArtifact: true,
          }, null, 2),
          artifacts: [{ kind: "drawio", payload: generated }],
          approved: true,
          status: "completed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "画一个 drawio 流程图" })

    expect(requests).toHaveLength(2)
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "chipmate_create_drawio_diagram" }),
      expect.objectContaining({
        type: "diagram",
        kind: "drawio",
        title: "Chat renderer flow",
        xml: expect.stringContaining("<mxGraphModel"),
        source: "tool",
        toolCallID: "call_drawio",
      }),
      expect.objectContaining({
        type: "diagram",
        kind: "drawio",
        title: "Renderer detail",
        xml: expect.stringContaining("<mxGraphModel"),
        source: "tool",
        toolCallID: "call_drawio",
      }),
      expect.objectContaining({ type: "text", text: "图已经生成。" }),
    ]))
    const toolMessage = ((requests[1]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: string }>)
      .find((message) => message.role === "tool" && message.tool_call_id === "call_drawio")
    expect(toolMessage?.content).toContain("hasChatDiagramArtifact")
	    expect(toolMessage?.content).not.toContain("mxGraphModelXml")
	    expect(toolMessage?.content).not.toContain("<mxGraphModel")
	  })

	  test("inserts a rendered Mermaid diagram part after the Mermaid tool succeeds", async () => {
	    const requests: Array<{ body: Record<string, unknown> }> = []
	    const outputLines: string[] = []
	    const source = "flowchart TD\n  start[Start] --> done[Done]"
	    const baseUrl = await listen(async (request, response) => {
	      if (request.url !== "/v1/chat/completions") {
	        response.writeHead(404).end()
	        return
	      }
	      const body = await collectJson(request)
	      requests.push({ body })
	      response.writeHead(200, { "content-type": "text/event-stream" })
	      if (requests.length === 1) {
	        response.end([
	          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mermaid", function: { name: "chipmate_render_mermaid_diagram", arguments: JSON.stringify({ title: "Mermaid renderer flow", source, diagramId: "mermaid-flow" }) } }] } }] }),
	          "data: [DONE]\n\n",
	        ].join(""))
	        return
	      }
	      response.end([
	        sse({ choices: [{ delta: { content: "Mermaid 图已经生成。" } }] }),
	        "data: [DONE]\n\n",
	      ].join(""))
	    })
	    const client = directClient(baseUrl, {
	      storageRoot: await tempDir("chipmate-direct-mermaid-storage-"),
	      outputLines,
	      toolsEnabled: true,
	      tools: {
	        toolDefinitions: () => [{
	          type: "function",
	          function: {
	            name: "chipmate_render_mermaid_diagram",
	            description: "Use when a Mermaid diagram should be rendered. Do not use for draw.io. Returns artifacts.",
	            parameters: { type: "object", properties: { title: { type: "string" }, source: { type: "string" } }, required: ["source", "title"], additionalProperties: false },
	          },
	        }],
	        execute: async (): Promise<ToolRuntimeResult> => ({
	          title: "Rendered Mermaid diagram: Mermaid renderer flow",
	          output: JSON.stringify({
	            answerSummary: "Rendered Mermaid diagram.",
	            data: {
	              kind: "mermaid",
	              title: "Mermaid renderer flow",
	              diagramId: "mermaid-flow",
	              sourceText: source,
	              mmdPath: ".chipmate/docs/diagrams/mermaid-flow.mmd",
	              pngPath: ".chipmate/docs/diagrams/mermaid-flow.png",
	              width: 320,
	              height: 180,
	            },
	          }),
	          artifacts: [{
	            kind: "mermaid",
	            payload: {
	              kind: "mermaid",
	              title: "Mermaid renderer flow",
	              diagramId: "mermaid-flow",
	              sourceText: source,
	              mmdPath: ".chipmate/docs/diagrams/mermaid-flow.mmd",
	              absoluteMmdPath: "/tmp/mermaid-flow.mmd",
	              pngPath: ".chipmate/docs/diagrams/mermaid-flow.png",
	              absolutePngPath: "/tmp/mermaid-flow.png",
	              width: 320,
	              height: 180,
	              warnings: [],
	            },
	          }],
	          approved: true,
	          status: "completed",
	          risk: "low",
	        }),
	      } as unknown as ToolRuntimeInstance,
	    })

	    const session = await client.createSession()
	    const assistant = await client.sendMessage({ sessionID: session.id, text: "生成一个可嵌入 Word 的 Mermaid 流程图" })

	    expect(requests).toHaveLength(2)
	    expect(assistant.parts).toEqual(expect.arrayContaining([
	      expect.objectContaining({ type: "tool", tool: "chipmate_render_mermaid_diagram" }),
	      expect.objectContaining({
	        type: "diagram",
	        kind: "mermaid",
	        title: "Mermaid renderer flow",
	        sourceText: source,
	        source: "tool",
	        displayMode: "artifact",
	        toolCallID: "call_mermaid",
	        diagramId: "mermaid-flow",
	        mmdPath: ".chipmate/docs/diagrams/mermaid-flow.mmd",
	        pngPath: ".chipmate/docs/diagrams/mermaid-flow.png",
	        width: 320,
	        height: 180,
	      }),
	      expect.objectContaining({
	        type: "runProgress",
	        title: "执行进度",
	        status: "completed",
	        items: expect.arrayContaining([
	          expect.objectContaining({
	            title: "渲染 Mermaid PNG",
	            status: "completed",
	          }),
	        ]),
	      }),
	      expect.objectContaining({ type: "text", text: "Mermaid 图已经生成。" }),
	    ]))
	    expect(outputLines.join("\n")).toContain("[mermaid-artifact] inserted count=1")
	  })

	  test("keeps legacy draw.io output parsing when no artifact is present", async () => {
    const generated = await generateDrawioDiagram({
      title: "Legacy renderer flow",
      nodes: [{ id: "model", label: "Model" }, { id: "tool", label: "Tool" }],
      edges: [{ source: "model", target: "tool", label: "spec" }],
    })
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Legacy renderer flow\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "旧格式图已经生成。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-legacy-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_drawio_diagram",
            description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
            parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: `Created draw.io diagram: ${generated.title}`,
          output: JSON.stringify(generated, null, 2),
          approved: true,
          status: "completed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "画一个 drawio 流程图" })

    expect(requests).toHaveLength(2)
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "diagram",
        kind: "drawio",
        title: "Legacy renderer flow",
        xml: expect.stringContaining("<mxGraphModel"),
        source: "tool",
        toolCallID: "call_drawio",
      }),
    ]))
  })

  test("inserts large draw.io diagrams from artifacts without sending XML back to the model", async () => {
    const largeXml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n-large" value="${"A".repeat(70 * 1024)}" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>`
    const generated: DrawioGeneratedDiagram = {
      kind: "drawio",
      diagramId: "drawio-large",
      title: "Large artifact diagram",
      mxGraphModelXml: largeXml,
      warnings: [],
      normalizedSpec: {
        title: "Large artifact diagram",
        diagramType: "flowchart",
        layout: "layered",
        layoutEngine: "elk",
        theme: "default",
        nodes: [],
        edges: [],
        containers: [],
      },
    }
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Large artifact diagram\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "大图已经生成。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const compactOutput = JSON.stringify({
      kind: "drawio",
      diagramId: generated.diagramId,
      title: generated.title,
      hasChatDiagramArtifact: true,
      counts: { xmlBytes: largeXml.length },
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-large-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_drawio_diagram",
            description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
            parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: `Created draw.io diagram: ${generated.title}`,
          output: compactOutput,
          artifacts: [{ kind: "drawio", payload: generated }],
          approved: true,
          status: "completed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "画一个大型 drawio 图" })
    const toolMessage = ((requests[1]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: string }>)
      .find((message) => message.role === "tool" && message.tool_call_id === "call_drawio")

    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "diagram",
        kind: "drawio",
        title: "Large artifact diagram",
        xml: largeXml,
      }),
    ]))
    expect(toolMessage?.content).toBe(compactOutput)
    expect(toolMessage?.content).not.toContain("<mxGraphModel")
    expect(outputLines.join("\n")).toContain("[drawio-artifact] inserted count=1 source=artifact")
  })

  test("does not insert a diagram from truncated legacy draw.io JSON", async () => {
    const generated = await generateDrawioDiagram({
      title: "Truncated legacy diagram",
      nodes: [{ id: "a", label: "A" }],
    })
    const truncatedOutput = JSON.stringify(generated, null, 2).slice(0, 512)
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Truncated legacy diagram\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "没有插入图。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-truncated-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_drawio_diagram",
            description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
            parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: `Created draw.io diagram: ${generated.title}`,
          output: truncatedOutput,
          approved: true,
          status: "completed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "画一个 drawio 流程图" })

    expect(assistant.parts.some((part) => part.type === "diagram")).toBe(false)
    expect(outputLines.join("\n")).toContain("[drawio-artifact] skipped reason=no drawio payload in artifacts or output")
  })

  test("repairs a diagram workflow when validation succeeds but the model stops before rendering", async () => {
    const generated = await generateDrawioDiagram({
      title: "Repaired diagram",
      nodes: [{ id: "start", label: "Start" }, { id: "end", label: "End" }],
      edges: [{ source: "start", target: "end", label: "next" }],
    })
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_validate", function: { name: "chipmate_validate_diagram_ir", arguments: "{\"diagramIr\":{\"title\":\"Repaired diagram\",\"diagramType\":\"flowchart\",\"nodes\":[{\"id\":\"start\",\"label\":\"Start\"},{\"id\":\"end\",\"label\":\"End\"}],\"edges\":[{\"source\":\"start\",\"target\":\"end\",\"label\":\"next\"}]}}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { content: "这是流程说明，但还没有图。" } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 3) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Repaired diagram\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "图已经补充生成。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-repair-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "chipmate_validate_diagram_ir",
              description: "Use when a DiagramIR needs validation. Do not use as renderer. Returns normalized DiagramIR.",
              parameters: { type: "object", properties: { diagramIr: { type: "object" } }, required: ["diagramIr"], additionalProperties: false },
            },
          },
          {
            type: "function",
            function: {
              name: "chipmate_create_drawio_diagram",
              description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
              parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
            },
          },
        ],
        execute: async (input: { name: string }): Promise<ToolRuntimeResult> => {
          if (input.name === "chipmate_validate_diagram_ir") {
            return {
              title: "Validated DiagramIR: Repaired diagram",
              output: JSON.stringify({
                ok: true,
                answerSummary: "DiagramIR is ready for draw.io rendering.",
                assistantInstruction: "If the user asked for a diagram, call chipmate_create_drawio_diagram with this normalized DiagramIR or drawioSpec next.",
                drawioSpec: {
                  title: "Repaired diagram",
                  diagramType: "flowchart",
                  nodes: [{ id: "start", label: "Start" }, { id: "end", label: "End" }],
                  edges: [{ source: "start", target: "end", label: "next" }],
                },
              }),
              approved: true,
              status: "completed",
              risk: "low",
            }
          }
          return {
            title: `Created draw.io diagram: ${generated.title}`,
            output: JSON.stringify({ kind: "drawio", title: generated.title, hasChatDiagramArtifact: true }),
            artifacts: [{ kind: "drawio", payload: generated }],
            approved: true,
            status: "completed",
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "先验证再画 drawio 图" })

    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[2]?.body.messages)).toContain("ChipMate diagram workflow repair")
    expect(requests[3]?.body.tools).toBeUndefined()
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "diagram", kind: "drawio", title: "Repaired diagram", toolCallID: "call_drawio" }),
      expect.objectContaining({ type: "text", text: "图已经补充生成。" }),
    ]))
    expect(outputLines.join("\n")).toContain("[drawio-workflow] repair start")
  })

  test("does not insert a draw.io diagram part when the draw.io tool fails", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_drawio", function: { name: "chipmate_create_drawio_diagram", arguments: "{\"title\":\"Broken diagram\",\"nodes\":[{\"id\":\"a\",\"label\":\"A\"}]}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "图生成失败，已保留错误信息。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-direct-drawio-failed-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_drawio_diagram",
            description: "Use when a draw.io diagram is requested. Do not use for file writes. Returns deterministic XML.",
            parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Create draw.io diagram",
          output: "Create draw.io diagram failed: ELK layout failed at stage=elk.layout title=\"Broken diagram\" diagramType=\"flowchart\" nodes=1 edges=0 containers=0: mock",
          approved: true,
          status: "failed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "画一个 drawio 流程图" })

    expect(requests).toHaveLength(2)
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "chipmate_create_drawio_diagram" }),
      expect.objectContaining({ type: "text", text: "图生成失败，已保留错误信息。" }),
    ]))
    expect(assistant.parts.some((part) => part.type === "diagram")).toBe(false)
  })

  test("blocks legacy read-file tool calls that were not exposed to the model", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Trying old tool." } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_legacy", function: { name: "chipmate_read_file", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Blocked handled." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Unexpected",
            output: "should not execute",
            approved: true,
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "read README" })

    expect(requests).toHaveLength(2)
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(["chipmate_read"])
    expect(toolResults).toEqual([])
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_legacy",
        content: "Tool is not exposed to the model in this chat mode: chipmate_read_file",
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read_file",
        state: expect.objectContaining({
          status: "blocked",
          output: "Tool is not exposed to the model in this chat mode: chipmate_read_file",
        }),
      }),
      expect.objectContaining({ type: "text", text: "Blocked handled." }),
    ]))
    expect(outputLines.join("\n")).toContain("[tool] blocked unexposed tool_call name=chipmate_read_file")
  })

  test("blocks legacy write-file tool calls that were not exposed to the model", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_write", function: { name: "chipmate_write_file", arguments: "{\"path\":\"src/existing.ts\",\"content\":\"overwrite\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Write blocked." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolResults: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client = directClient(baseUrl, {
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_file",
            description: "Create a new file",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
          },
        }],
        execute: async (input: { name: string; arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          toolResults.push({ name: input.name, arguments: input.arguments })
          return {
            title: "Unexpected",
            output: "should not execute",
            approved: true,
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "overwrite src/existing.ts" })

    expect(requests).toHaveLength(2)
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(["chipmate_create_file"])
    expect(toolResults).toEqual([])
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_write",
        content: "Tool is not exposed to the model in this chat mode: chipmate_write_file",
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_write_file",
        state: expect.objectContaining({
          status: "blocked",
          output: "Tool is not exposed to the model in this chat mode: chipmate_write_file",
        }),
      }),
      expect.objectContaining({ type: "text", text: "Write blocked." }),
    ]))
    expect(outputLines.join("\n")).toContain("[tool] blocked unexposed tool_call name=chipmate_write_file")
  })

  test("emits an inline approval tool part and continues after QA approval", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create", function: { name: "chipmate_create_file", arguments: "{\"path\":\"src/generated.ts\",\"content\":\"export const generated = true\\n\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Created." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const events: unknown[] = []
    const subscriptionController = new AbortController()
    const client = directClient(baseUrl, {
      toolsEnabled: true,
      permissionMode: "ask",
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_file",
            description: "Create a new file",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          const approval = await input.approve?.({
            id: "approval-create-1",
            sessionID: input.sessionID,
            mode: input.mode,
            tool: input.name,
            title: "Create file",
            summary: "src/generated.ts",
            risk: "medium",
            reason: "ask mode requires approval",
            request: { id: "approval-create-1", kind: "write", title: "Create file", summary: "src/generated.ts", target: "/repo/src/generated.ts" } as never,
            arguments: input.arguments,
            detail: { path: "src/generated.ts", bytes: 30, tool: input.name },
          })
          if (!approval?.approved) {
            return {
              title: "Create file",
              output: "Blocked by ChipMate permissions: denied",
              approved: false,
              status: "approval-required",
              requiresApproval: true,
              risk: "medium",
            }
          }
          return {
            title: "Created file: src/generated.ts",
            output: "Created src/generated.ts",
            approved: true,
            status: "completed",
            risk: "medium",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    void client.subscribeEvents((event) => events.push(event), subscriptionController.signal)

    const session = await client.createSession()
    const send = client.sendMessage({ sessionID: session.id, text: "create src/generated.ts" })
    await waitFor(() => events.some((event) =>
      Boolean(
        event
        && typeof event === "object"
        && (event as { type?: string }).type === "message.part.updated"
        && (((event as { properties?: { part?: { state?: { status?: string; metadata?: { approvalRequestId?: string } } } } }).properties?.part?.state?.status) === "approval-required")
        && (((event as { properties?: { part?: { state?: { status?: string; metadata?: { approvalRequestId?: string } } } } }).properties?.part?.state?.metadata?.approvalRequestId) === "approval-create-1"),
      )
    ))
    expect(requests).toHaveLength(1)

    expect(client.resolveToolApproval("approval-create-1", true)).toBe(true)
    const assistant = await send
    subscriptionController.abort()

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_create",
        content: "Created src/generated.ts",
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_create_file",
        state: expect.objectContaining({
          status: "completed",
          output: "Created src/generated.ts",
        }),
      }),
      expect.objectContaining({ type: "text", text: "Created." }),
    ]))
  })

  test("continues the chat when chipmate_read reports a missing file", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_missing", function: { name: "chipmate_read", arguments: "{\"path\":\"hw/ufs.c\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "The file does not exist." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const root = await tempDir("chipmate-missing-read-workspace-")
    const storageRoot = await tempDir("chipmate-missing-read-storage-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const runtime = new ToolRuntime({ append: async () => undefined } as never)
    const client = directClient(baseUrl, {
      storageRoot,
      toolsEnabled: true,
      tools: runtime,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "read /hw/ufs.c" })

    expect(requests).toHaveLength(2)
    const exposedToolNames = ((requests[0]?.body.tools ?? []) as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toContain("chipmate_create_file")
    expect(exposedToolNames).toContain("chipmate_create_directory")
    expect(exposedToolNames).toContain("chipmate_edit_file")
    expect(exposedToolNames).not.toContain("chipmate_write_file")
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_missing",
        content: expect.stringContaining("File not found:"),
      }),
    ]))
    expect(JSON.stringify(requests[1]?.body.messages)).toContain(join(root, "hw", "ufs.c"))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read",
        state: expect.objectContaining({
          status: "failed",
          output: expect.stringContaining("File not found:"),
        }),
      }),
      expect.objectContaining({ type: "text", text: "The file does not exist." }),
    ]))
    expect((await client.getSessionStatuses())[session.id]?.type).toBe("idle")
    expect((await client.getMessages(session.id)).some((message) => Boolean(message.info.error))).toBe(false)
  })

  test("loads explicitly invoked skills and passes active skill policy to tool execution", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "chipmate_read", arguments: "{\"path\":\"src/driver.c\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Used skill." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:firmware-review",
      name: "firmware-review",
      description: "Review firmware changes",
      path: "/repo/.agents/skills/firmware-review/SKILL.md",
      skillRoot: "/repo/.agents/skills/firmware-review",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "firmware-review",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_read"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: {},
      resourceFiles: ["references/checklist.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async () => ({
          ...skill,
          body: "Review changed files with the firmware checklist.",
          invocationMode: "explicit",
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          return {
            title: "Read file",
            output: "driver text",
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "$firmware-review inspect src/driver.c" })

    expect(requests).toHaveLength(2)
    const systemContent = ((requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>).find((message) => message.role === "system")?.content ?? ""
    expect(systemContent).toContain('<skill name="firmware-review"')
    expect(systemContent).toContain("Invocation: explicit")
    expect(systemContent).toContain("references/checklist.md")
    expect(executions[0]?.activeSkills).toEqual([
      expect.objectContaining({
        id: "repo:firmware-review",
        name: "firmware-review",
        invocationMode: "explicit",
        allowedTools: ["chipmate_read"],
      }),
    ])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Used skill." }),
    ]))
  })

  test("loads the documents skill implicitly for Chinese local Word generation requests", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const toolArgs = {
      spec: {
        metadata: { title: "年度经营分析", documentType: "business-report", language: "zh-CN" },
        layout: { preset: "standard_business_brief" },
        sections: [{ id: "overview", level: 1, title: "概览", paragraphs: ["年度经营分析。"] }],
      },
      filename: "implicit-loaded-doc.docx",
    }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Documents skill loaded." } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_loaded_doc", function: { name: "create_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/implicit-loaded-doc.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档", "修改*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const client = directClient(baseUrl, {
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: create real Word structures before calling create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Create Word document",
          output: JSON.stringify({
            answerSummary: "Created Word document: .chipmate/docs/implicit-loaded-doc.docx",
            evidence: [],
            gaps: [],
            nextActions: [],
            truncated: false,
            coverage: "complete",
            data: { path: ".chipmate/docs/implicit-loaded-doc.docx" },
          }),
          approved: true,
          status: "completed",
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份年度经营分析文档，带目录和表格。" })

    expect(requests).toHaveLength(3)
    const systemContent = ((requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>).find((message) => message.role === "system")?.content ?? ""
    expect(systemContent).toContain('<skill name="documents"')
    expect(systemContent).toContain("Invocation: implicit")
    expect(systemContent).toContain("tasks/create_edit_v1.md")
    expect(systemContent).toContain("Documents skill body marker")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("ChipMate deliverable discipline checkpoint")
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "create_word_document" }),
      expect.objectContaining({
        type: "generatedDocument",
        path: ".chipmate/docs/implicit-loaded-doc.docx",
        toolCallID: "call_create_loaded_doc",
      }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("已生成 Word 文档：.chipmate/docs/implicit-loaded-doc.docx") }),
    ]))
  })

  test("executes create_word_document for an implicit Chinese documents skill request", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const toolArgs = {
      spec: {
        metadata: {
          title: "年度经营分析",
          documentType: "business-report",
          language: "zh-CN",
        },
        layout: {
          preset: "standard_business_brief",
          navigation: { mode: "static-toc" },
        },
        sections: [{
          id: "overview",
          level: 1,
          title: "经营概览",
          paragraphs: ["本节概述年度经营表现。"],
          tables: [{
            headers: ["指标", "结果"],
            rows: [["收入", "增长"]],
          }],
        }],
      },
      filename: "annual-business-review.docx",
    }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word", function: { name: "create_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成年度经营分析 Word：.chipmate/docs/annual-business-review.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: plan first, then call create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: {
              type: "object",
              properties: {
                spec: { type: "object" },
                filename: { type: "string" },
              },
              required: ["spec"],
            },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          return {
            title: "Create Word document",
            output: "Generated document: .chipmate/docs/annual-business-review.docx",
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份年度经营分析文档，带目录和表格。" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "create_word_document" }) }),
    ]))
    const systemContent = ((requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>).find((message) => message.role === "system")?.content ?? ""
    expect(systemContent).toContain('<skill name="documents"')
    expect(systemContent).toContain("Invocation: implicit")
    expect(executions).toHaveLength(1)
    expect(executions[0]).toEqual(expect.objectContaining({
      name: "create_word_document",
      arguments: expect.objectContaining({
        filename: "annual-business-review.docx",
        spec: expect.objectContaining({
          metadata: expect.objectContaining({ title: "年度经营分析" }),
          layout: expect.objectContaining({ preset: "standard_business_brief" }),
        }),
      }),
      activeSkills: [expect.objectContaining({
        id: "repo:documents",
        name: "documents",
        invocationMode: "implicit",
        allowedTools: ["create_word_document"],
      })],
    }))
    const secondRequestMessages = (requests[1]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: string }>
    expect(secondRequestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_create_word",
        content: "Generated document: .chipmate/docs/annual-business-review.docx",
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "create_word_document" }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("已生成年度经营分析 Word：.chipmate/docs/annual-business-review.docx") }),
    ]))
  })

  test("steers document requests to converge on create_word_document before the tool budget is exhausted", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const toolArgs = {
      spec: {
        metadata: { title: "机制说明", documentType: "technical-report", language: "zh-CN" },
        layout: { preset: "standard_business_brief" },
        sections: [{ id: "overview", level: 1, title: "概览", paragraphs: ["基于已收集证据生成。"] }],
      },
      filename: "converged-doc.docx",
    }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "chipmate_read", arguments: "{\"path\":\"src/direct-agent-client.ts\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word", function: { name: "create_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/converged-doc.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_read", "create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-doc-convergence-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 6,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: evidence enough means create_word_document now.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "chipmate_read",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          if (input.name === "create_word_document") {
            return {
              title: "Create Word document",
              output: JSON.stringify({
                answerSummary: "Created Word document: .chipmate/docs/converged-doc.docx",
                evidence: [],
                gaps: [],
                nextActions: [],
                truncated: false,
                coverage: "complete",
                data: { path: ".chipmate/docs/converged-doc.docx" },
              }),
              approved: true,
              status: "completed",
            }
          }
          return {
            title: "Read file",
            output: JSON.stringify({
              answerSummary: "Read source evidence.",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "bounded-complete",
              data: { text: "evidence" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档，总结当前机制。" })

    expect(requests).toHaveLength(3)
    const checkpointMessages = JSON.stringify(requests[1]?.body.messages)
    expect(checkpointMessages).toContain("ChipMate evidence convergence checkpoint")
    expect(checkpointMessages).toContain("Stop open-ended search/read loops")
    expect(checkpointMessages).toContain("Expected deliverables: Word .docx document")
    expect(executions.map((item) => item.name)).toEqual(["chipmate_read", "create_word_document"])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "create_word_document" }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("已生成 Word 文档：.chipmate/docs/converged-doc.docx") }),
    ]))
    expect(outputLines.join("\n")).toContain("[tool-loop] evidence convergence checkpoint inserted")
  })

  test("steers a failed document producer tool to repair WordDocSpec instead of broad search", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_bad", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "repair.docx", spec: { metadata: {}, sections: [] } }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_good", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "repair.docx", spec: minimalWordDocSpecForTest("修复后的文档") }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成修复后的 Word 文档：.chipmate/docs/repair.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["create_word_document", "chipmate_search_text"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-doc-producer-repair-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 4,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: repair invalid WordDocSpec and retry create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
            },
          },
          {
            type: "function",
            function: {
              name: "chipmate_search_text",
              description: "Search text",
              parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          if (executions.length === 1) {
            return {
              title: "Create Word document",
              output: JSON.stringify({
                answerSummary: "Create Word document failed: WordDocSpec validation failed: WordDocSpec metadata.title is required.",
                evidence: [],
                gaps: ["WordDocSpec metadata.title is required."],
                nextActions: [{ tool: "create_word_document", reason: "Repair the WordDocSpec and retry.", args: {} }],
                truncated: false,
                coverage: "partial",
                data: {
                  errorCode: "word-doc-spec-validation-failed",
                  errorMessage: "WordDocSpec validation failed: WordDocSpec metadata.title is required.",
                  validationErrors: ["WordDocSpec metadata.title is required."],
                },
              }),
              approved: false,
              status: "failed",
              error: "WordDocSpec validation failed: WordDocSpec metadata.title is required.",
            }
          }
          return {
            title: "Create Word document",
            output: JSON.stringify({
              answerSummary: "Created Word document: .chipmate/docs/repair.docx",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "complete",
              data: { path: ".chipmate/docs/repair.docx" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档，总结当前机制。" })

    expect(executions.map((item) => item.name)).toEqual(["create_word_document", "create_word_document"])
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("ChipMate producer failure repair checkpoint")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("Do not resume broad search/read loops")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("WordDocSpec metadata.title is required.")
    expect(textPartsForTest(assistant)).toContain(".chipmate/docs/repair.docx")
    expect(outputLines.join("\n")).toContain("[tool-loop] producer failure repair checkpoint inserted")
  })

  test("steers stringified WordDocSpec failures to retry with an object spec", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const firstArgs = JSON.stringify({
      filename: "string-repair.docx",
      spec: JSON.stringify(minimalWordDocSpecForTest("字符串规格文档")),
    })
    const secondArgs = JSON.stringify({
      filename: "string-repair.docx",
      spec: minimalWordDocSpecForTest("对象规格文档"),
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_string_spec", function: { name: "create_word_document", arguments: firstArgs } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_object_spec", function: { name: "create_word_document", arguments: secondArgs } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/string-repair.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const specTypes: string[] = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-string-spec-repair-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 3,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document"]),
          body: "Documents skill body marker: never stringify WordDocSpec.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          specTypes.push(typeof input.arguments.spec)
          if (typeof input.arguments.spec === "string") {
            return {
              title: "Create Word document",
              output: JSON.stringify({
                answerSummary: "Create Word document failed: WordDocSpec argument spec was a string.",
                evidence: [],
                gaps: ["WordDocSpec argument spec was a string."],
                nextActions: [{ tool: "create_word_document", reason: "Retry with spec as an object.", args: {} }],
                truncated: false,
                coverage: "partial",
                data: {
                  errorCode: "word-doc-spec-string-disallowed",
                  errorMessage: "WordDocSpec argument spec was a string.",
                  diagnostic: { specType: "string", legacyStringSpec: true },
                },
              }),
              approved: false,
              status: "failed",
              error: "WordDocSpec argument spec was a string.",
            }
          }
          return {
            title: "Create Word document",
            output: JSON.stringify({
              answerSummary: "Created Word document: .chipmate/docs/string-repair.docx",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "complete",
              data: { path: ".chipmate/docs/string-repair.docx" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(specTypes).toEqual(["string", "object"])
    const repairPrompt = JSON.stringify(requests[1]?.body.messages)
    expect(repairPrompt).toContain("ChipMate producer failure repair checkpoint")
    expect(repairPrompt).toContain("Do not pass spec as a quoted string")
    expect(repairPrompt).toContain("JSON.stringify(spec)")
    expect(repairPrompt).toContain("word-doc-spec-string-disallowed")
    expect(textPartsForTest(assistant)).toContain(".chipmate/docs/string-repair.docx")
  })

  test("steers failed Mermaid Word figures to repair the source before creating the Word document", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mermaid_bad", function: { name: "chipmate_render_mermaid_diagram", arguments: JSON.stringify({ title: "流程图", source: "flowchart TD\n  C5[\"是否有 C/C++<br/>文件变更?\"] C6[\"生成 compile.json\"]" }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mermaid_good", function: { name: "chipmate_render_mermaid_diagram", arguments: JSON.stringify({ title: "流程图", source: "flowchart TD\n  C5{\"是否有 C/C++ 文件变更?\"}\n  C6[\"生成 compile.json\"]\n  C5 -->|是| C6" }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 3) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "with-flow.docx", spec: minimalWordDocSpecForTest("带流程图的文档") }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已修复 Mermaid 并生成 Word 文档：.chipmate/docs/with-flow.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_render_mermaid_diagram", "create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-doc-mermaid-repair-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 4,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: Mermaid figures must be rendered to PNG before create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "chipmate_render_mermaid_diagram",
              description: "Render Mermaid to PNG",
              parameters: { type: "object", properties: { source: { type: "string" }, title: { type: "string" } }, required: ["source", "title"] },
            },
          },
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          if (executions.length === 1) {
            return {
              title: "Render Mermaid diagram failed: 流程图",
              output: JSON.stringify({
                answerSummary: "Mermaid diagram \"流程图\" was not rendered to PNG. Remote Mermaid render server reached Mermaid parsing/rendering but rejected the provided source; fix the Mermaid source and retry rendering.",
                errorCode: "remote-render-failed",
                evidence: [{ kind: "artifact", path: ".chipmate/docs/diagrams/flow.mmd", description: "Mermaid source was written before PNG rendering failed." }],
                gaps: [
                  "PNG artifact was not generated.",
                  "Remote Mermaid render server reached Mermaid parsing/rendering but rejected the provided source; fix the Mermaid source and retry rendering.",
                  "Parse error on line 26: Expecting DIAMOND_STOP, got SQE",
                ],
                nextActions: [{ action: "Fix the Mermaid source syntax and retry chipmate_render_mermaid_diagram.", reason: "Do not continue to create_word_document without a successful PNG artifact." }],
                truncated: false,
                coverage: "partial",
                data: {
                  pngGenerated: false,
                  wordFigureUsable: false,
                  mustNotEmbedSourceAsFigure: true,
                },
              }),
              approved: false,
              status: "failed",
              error: "Parse error on line 26: Expecting DIAMOND_STOP, got SQE",
            }
          }
          if (input.name === "chipmate_render_mermaid_diagram") return {
            title: "Rendered Mermaid diagram: 流程图",
            output: JSON.stringify({
              answerSummary: "Rendered Mermaid diagram \"流程图\" to .chipmate/docs/diagrams/flow.png.",
              evidence: [],
              gaps: [],
              nextActions: [{ tool: "create_word_document", reason: "Insert the returned PNG artifact path into the matching WordDocSpec section as a FigureSpec.", args: {} }],
              truncated: false,
              coverage: "complete",
              data: {
                pngGenerated: true,
                wordFigureUsable: true,
                figure: { image: { path: ".chipmate/docs/diagrams/flow.png", artifactPath: ".chipmate/docs/diagrams/flow.png", contentType: "image/png", width: 320, height: 180 } },
              },
            }),
            approved: true,
            status: "completed",
          }
          return {
            title: "Create Word document",
            output: JSON.stringify({
              answerSummary: "Created Word document: .chipmate/docs/with-flow.docx",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "complete",
              data: { path: ".chipmate/docs/with-flow.docx" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份带 Mermaid 流程图的 Word 文档。" })

    expect(executions.map((item) => item.name)).toEqual(["chipmate_render_mermaid_diagram", "chipmate_render_mermaid_diagram", "create_word_document"])
    const checkpointMessages = JSON.stringify(requests[1]?.body.messages)
    expect(checkpointMessages).toContain("ChipMate producer failure repair checkpoint")
    expect(checkpointMessages).toContain("Parse error on line 26")
    expect(checkpointMessages).toContain("Fix the Mermaid source syntax and retry chipmate_render_mermaid_diagram")
    expect(checkpointMessages).toContain("wordFigureUsable")
    expect(textPartsForTest(assistant)).toContain(".chipmate/docs/with-flow.docx")
    expect(outputLines.join("\n")).toContain("[tool-loop] producer failure repair checkpoint inserted")
  })

  test("executes render_word_document for an implicit Chinese Word visual QA request and inserts render artifacts", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const root = await tempDir("chipmate-render-word-workspace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const pagePngPath = join(root, ".chipmate", "docs", "rendered", "sample-render-20260628-000000-test", "page-1.png")
    await mkdir(join(root, ".chipmate", "docs", "rendered", "sample-render-20260628-000000-test"), { recursive: true })
    await writeFile(pagePngPath, Buffer.from(tinyPngDataUri().replace(/^data:image\/png;base64,/, ""), "base64"))
    const toolArgs = {
      path: ".chipmate/docs/sample.docx",
      artifactNameBase: "sample-render",
    }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_render_word", function: { name: "render_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已完成 Word 渲染质检，发现 1 页 PNG 证据。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["render_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "渲染", "排版"]) },
      resourceFiles: ["tasks/render_verify_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const renderPayload = {
      kind: "word-render",
      path: ".chipmate/docs/sample.docx",
      absolutePath: "/repo/.chipmate/docs/sample.docx",
      renderArtifactDir: ".chipmate/docs/rendered/sample-render-20260628-000000-test",
      pdfArtifactPath: ".chipmate/docs/rendered/sample-render-20260628-000000-test/document.pdf",
      pagePngPaths: [".chipmate/docs/rendered/sample-render-20260628-000000-test/page-1.png"],
      pageVisualSummaries: [{
        page: 1,
        path: ".chipmate/docs/rendered/sample-render-20260628-000000-test/page-1.png",
        width: 32,
        height: 32,
        inkRatio: 0.2,
        contentBounds: { left: 1, top: 1, right: 20, bottom: 20 },
        edgeInk: { top: true, right: false, bottom: false, left: true },
      }],
      issues: [{ severity: "warning", code: "render-page-edge-ink", message: "Rendered page has near-edge ink." }],
      renderCheckResult: {
        attempted: true,
        ok: true,
        renderArtifactDir: ".chipmate/docs/rendered/sample-render-20260628-000000-test",
        pdfArtifactPath: ".chipmate/docs/rendered/sample-render-20260628-000000-test/document.pdf",
        pagePngPaths: [".chipmate/docs/rendered/sample-render-20260628-000000-test/page-1.png"],
        pageCount: 1,
        pageVisualSummaries: [{
          page: 1,
          path: ".chipmate/docs/rendered/sample-render-20260628-000000-test/page-1.png",
          width: 32,
          height: 32,
          inkRatio: 0.2,
          contentBounds: { left: 1, top: 1, right: 20, bottom: 20 },
          edgeInk: { top: true, right: false, bottom: false, left: true },
        }],
        issues: [{ severity: "warning", code: "render-page-edge-ink", message: "Rendered page has near-edge ink." }],
      },
    }
    const storageRoot = await tempDir("chipmate-render-word-storage-")
    const client = directClient(baseUrl, {
      storageRoot,
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents render skill body marker: use render_word_document for visual QA.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "render_word_document",
            description: "Render a Word document",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                artifactNameBase: { type: "string" },
              },
              required: ["path"],
            },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          return {
            title: "Rendered Word document: .chipmate/docs/sample.docx",
            output: JSON.stringify({
              answerSummary: "Rendered Word document: .chipmate/docs/sample.docx; pages: 1; PNG artifacts: 1.",
              data: {
                path: ".chipmate/docs/sample.docx",
                renderCheckResult: renderPayload.renderCheckResult,
              },
            }),
            approved: true,
            status: "completed",
            artifacts: [{ kind: "word-render", payload: renderPayload as never }],
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "帮我渲染检查这个 Word 文档 .chipmate/docs/sample.docx 的排版，有没有溢出。" })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "render_word_document" }) }),
    ]))
    const systemContent = ((requests[0]?.body.messages ?? []) as Array<{ role?: string; content?: string }>).find((message) => message.role === "system")?.content ?? ""
    expect(systemContent).toContain("render_word_document")
    expect(systemContent).toContain("Use render_word_document directly")
    expect(executions).toEqual([expect.objectContaining({
      name: "render_word_document",
      arguments: toolArgs,
      activeSkills: [expect.objectContaining({
        id: "repo:documents",
        allowedTools: ["render_word_document"],
      })],
    })])
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", tool: "render_word_document" }),
      expect.objectContaining({
        type: "wordRender",
        path: ".chipmate/docs/sample.docx",
        pdfArtifactPath: ".chipmate/docs/rendered/sample-render-20260628-000000-test/document.pdf",
        pagePngPaths: [".chipmate/docs/rendered/sample-render-20260628-000000-test/page-1.png"],
        pageCount: 1,
        warnings: ["render-page-edge-ink: Rendered page has near-edge ink."],
      }),
      expect.objectContaining({ type: "text", text: "已完成 Word 渲染质检，发现 1 页 PNG 证据。" }),
    ]))
    expect(outputLines.join("\n")).toContain("[word-render-artifact] inserted count=1")
    expect(outputLines.join("\n")).toContain("[word-visual-qa] steering batch=1 renderRound=1/2 artifact=1 pages=1 images=1")
    const qaRequest = requests[1]?.body.messages as Array<{ role?: string; content?: unknown }>
    const qaUser = qaRequest[qaRequest.length - 1]
    expect(qaUser?.role).toBe("user")
    expect(qaUser?.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Word visual QA render round 1/2, page batch 1/1") }),
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: tinyPngDataUri() }) }),
    ])
    const sessionLog = await readFile(join(storageRoot, "sessions", `${session.id}.jsonl`), "utf8")
    expect(sessionLog).toContain("\"kind\":\"word-render-page\"")
    expect(sessionLog).not.toContain(tinyPngDataUri())
  })

  test("queues all long Word render page PNGs for visual QA in fixed-size batches", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const root = await tempDir("chipmate-render-word-batches-workspace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const renderDir = ".chipmate/docs/rendered/long-render"
    await mkdir(join(root, renderDir), { recursive: true })
    const pagePngPaths = Array.from({ length: 6 }, (_, index) => `${renderDir}/page-${index + 1}.png`)
    for (const relative of pagePngPaths) {
      await writeFile(join(root, relative), Buffer.from(tinyPngDataUri().replace(/^data:image\/png;base64,/, ""), "base64"))
    }
    const toolArgs = { path: ".chipmate/docs/long.docx", artifactNameBase: "long-render" }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_render_long_word", function: { name: "render_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([sse({ choices: [{ delta: { content: "第 1 批页面已检查。" } }] }), "data: [DONE]\n\n"].join(""))
        return
      }
      response.end([sse({ choices: [{ delta: { content: "6 页 Word 图片级视觉 QA 已全部检查。" } }] }), "data: [DONE]\n\n"].join(""))
    })
    const pageVisualSummaries = pagePngPaths.map((path, index) => ({
      page: index + 1,
      path,
      width: 32,
      height: 32,
      inkRatio: 0.2,
      edgeInk: { top: false, right: false, bottom: false, left: false },
    }))
    const renderPayload = {
      kind: "word-render",
      path: ".chipmate/docs/long.docx",
      renderArtifactDir: renderDir,
      pdfArtifactPath: `${renderDir}/document.pdf`,
      pagePngPaths,
      pageVisualSummaries,
      renderCheckResult: {
        attempted: true,
        ok: true,
        pagePngPaths,
        pageCount: 6,
        pageVisualSummaries,
        issues: [],
      },
    }
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-render-word-batches-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "render_word_document",
            description: "Render a Word document",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                artifactNameBase: { type: "string" },
              },
              required: ["path"],
            },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Rendered Word document: .chipmate/docs/long.docx",
          output: JSON.stringify({ answerSummary: "Rendered Word document: .chipmate/docs/long.docx; pages: 6." }),
          approved: true,
          status: "completed",
          artifacts: [{ kind: "word-render", payload: renderPayload as never }],
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "帮我逐页图片级检查 6 页 Word 文档 .chipmate/docs/long.docx" })

    expect(requests).toHaveLength(3)
    const firstBatch = JSON.stringify(requests[1]?.body.messages)
    const secondBatch = JSON.stringify(requests[2]?.body.messages)
    const firstBatchMessages = requests[1]?.body.messages as Array<{ role?: string; content?: unknown }>
    const secondBatchMessages = requests[2]?.body.messages as Array<{ role?: string; content?: unknown }>
    const firstBatchContent = firstBatchMessages.at(-1)?.content as Array<{ type?: string }>
    const secondBatchContent = secondBatchMessages.at(-1)?.content as Array<{ type?: string }>
    expect(firstBatch).toContain("Word visual QA render round 1/2, page batch 1/2")
    expect(firstBatch).toContain("Pages in this batch: 1, 2, 3")
    expect(secondBatch).toContain("Word visual QA render round 1/2, page batch 2/2")
    expect(secondBatch).toContain("Pages in this batch: 4, 5, 6")
    expect(firstBatchContent.filter((part) => part.type === "image_url")).toHaveLength(3)
    expect(secondBatchContent.filter((part) => part.type === "image_url")).toHaveLength(3)
    expect(outputLines.join("\n")).toContain("[word-visual-qa] steering batch=1 renderRound=1/2 artifact=1 pages=1,2,3 images=3")
    expect(outputLines.join("\n")).toContain("[word-visual-qa] steering batch=2 renderRound=1/2 artifact=1 pages=4,5,6 images=3")
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "wordRender",
        pagePngPaths,
        visualQaCoverage: expect.objectContaining({ totalPages: 6, queuedPages: 6, batchSize: 3, batchCount: 2 }),
      }),
      expect.objectContaining({ type: "text", text: "6 页 Word 图片级视觉 QA 已全部检查。" }),
    ]))
  })

  test("falls back to text-only during Word visual QA when provider rejects page PNG input", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const root = await tempDir("chipmate-word-visual-fallback-workspace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const relativePng = ".chipmate/docs/rendered/word-visual-fallback/page-1.png"
    await mkdir(join(root, ".chipmate", "docs", "rendered", "word-visual-fallback"), { recursive: true })
    await writeFile(join(root, relativePng), Buffer.from(tinyPngDataUri().replace(/^data:image\/png;base64,/, ""), "base64"))
    const toolArgs = { path: ".chipmate/docs/sample.docx" }
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      if (requests.length === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_render_word_reject", function: { name: "render_word_document", arguments: JSON.stringify(toolArgs) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "image input is not supported" } }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "已基于视觉摘要完成检查，未完成逐页图片视觉检查。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const renderPayload = {
      kind: "word-render",
      path: ".chipmate/docs/sample.docx",
      renderArtifactDir: ".chipmate/docs/rendered/word-visual-fallback",
      pagePngPaths: [relativePng],
      renderCheckResult: {
        attempted: true,
        ok: true,
        pagePngPaths: [relativePng],
        pageCount: 1,
        pageVisualSummaries: [{
          page: 1,
          path: relativePng,
          width: 32,
          height: 32,
          inkRatio: 0.2,
          edgeInk: { top: false, right: false, bottom: false, left: false },
        }],
        issues: [],
      },
    }
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-word-visual-fallback-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "render_word_document",
            description: "Render a Word document",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Rendered Word document",
          output: JSON.stringify({ answerSummary: "Rendered Word document; pages: 1." }),
          approved: true,
          status: "completed",
          artifacts: [{ kind: "word-render", payload: renderPayload as never }],
        }),
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "渲染检查 sample.docx" })

    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("image_url")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("Word visual QA render round 1/2, page batch 1/1")
    expect(JSON.stringify(requests[2]?.body.messages)).not.toContain("image_url")
    expect(JSON.stringify(requests[2]?.body.messages)).toContain("Word visual QA render round 1/2, page batch 1/1")
    expect(outputLines.join("\n")).toContain("[visual-context] provider rejected image input; retrying text-only")
    expect(textPartsForTest(assistant)).toContain("未完成逐页图片视觉检查")
  })

  test("bounds Word visual QA steering to two checkpoints", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const root = await tempDir("chipmate-word-visual-max-workspace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const relativePng = ".chipmate/docs/rendered/word-visual-max/page-1.png"
    await mkdir(join(root, ".chipmate", "docs", "rendered", "word-visual-max"), { recursive: true })
    await writeFile(join(root, relativePng), Buffer.from(tinyPngDataUri().replace(/^data:image\/png;base64,/, ""), "base64"))
    const renderToolCall = (id: string) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "render_word_document", arguments: JSON.stringify({ path: ".chipmate/docs/sample.docx" }) } }] } }] })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length <= 3) {
        response.end([renderToolCall(`call_render_${requests.length}`), "data: [DONE]\n\n"].join(""))
        return
      }
      response.end([sse({ choices: [{ delta: { content: "最终只保留两轮 Word 视觉 QA checkpoint。" } }] }), "data: [DONE]\n\n"].join(""))
    })
    const renderPayload = {
      kind: "word-render",
      path: ".chipmate/docs/sample.docx",
      renderArtifactDir: ".chipmate/docs/rendered/word-visual-max",
      pagePngPaths: [relativePng],
      renderCheckResult: {
        attempted: true,
        ok: true,
        pagePngPaths: [relativePng],
        pageCount: 1,
        pageVisualSummaries: [{ page: 1, path: relativePng, width: 32, height: 32, inkRatio: 0.2 }],
        issues: [],
      },
    }
    const executions: Array<Parameters<ToolRuntimeInstance["execute"]>[0]> = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-word-visual-max-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "render_word_document",
            description: "Render a Word document",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          executions.push(input)
          return {
            title: "Rendered Word document",
            output: JSON.stringify({ answerSummary: "Rendered Word document; pages: 1." }),
            approved: true,
            status: "completed",
            artifacts: [{ kind: "word-render", payload: renderPayload as never }],
          }
        },
      } as unknown as ToolRuntimeInstance,
    })

    const session = await client.createSession()
    const assistant = await client.sendMessage({ sessionID: session.id, text: "连续渲染检查 sample.docx" })

    expect(executions).toHaveLength(3)
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("Word visual QA render round 1/2, page batch 1/1")
    expect(JSON.stringify(requests[2]?.body.messages)).toContain("Word visual QA render round 2/2, page batch 1/1")
    expect(outputLines.join("\n")).toContain("[word-visual-qa] steering batch=1 renderRound=1/2")
    expect(outputLines.join("\n")).toContain("[word-visual-qa] steering batch=2 renderRound=2/2")
    expect(outputLines.join("\n")).not.toContain("renderRound=3/2")
    expect(textPartsForTest(assistant)).toContain("最终只保留两轮")
  })

  test("converts exposed tool runtime exceptions into failed tool results", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_throw", function: { name: "chipmate_read", arguments: "{\"path\":\"missing.c\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Handled failed tool." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-exception-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          throw Object.assign(new Error("ENOENT: no such file or directory, open '/missing.c'"), { code: "ENOENT" })
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "read missing.c" })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_throw",
        content: expect.stringContaining("Tool failed: chipmate_read"),
      }),
    ]))
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        tool: "chipmate_read",
        state: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("ENOENT"),
        }),
      }),
      expect.objectContaining({ type: "text", text: "Handled failed tool." }),
    ]))
    expect((await client.getSessionStatuses())[session.id]?.type).toBe("idle")
    expect((await client.getMessages(session.id)).some((message) => message.info.error?.message?.includes("对话已中断"))).toBe(false)
    expect(outputLines.join("\n")).toContain("[tool] chipmate_read failed: ENOENT")
  })

  test("does not replay prior tool results as next-turn history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { content: "Checking " } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "follow up" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-history-storage-"),
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Read file",
          output: "tool result text",
          approved: true,
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "inspect repo" })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: "tool result text" }),
    ]))
    expect(requests[2]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
    const nextTurnPrompt = JSON.stringify(requests[2]?.body.messages)
    expect(nextTurnPrompt).toContain("Tool execution history")
    expect(nextTurnPrompt).toContain("chipmate_read completed")
    expect(nextTurnPrompt).toContain("path=README.md")
    expect(nextTurnPrompt).not.toContain("tool result text")
  })

  test("replays compact create-file tool summaries across intervening turns without file content", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const fooArgs = JSON.stringify({
      path: "scripts/foo_opt.py",
      content: "SECRET_GENERATED_CONTENT_FOO",
      reason: "optimize foo",
    })
    const barArgs = JSON.stringify({
      path: "scripts/bar_opt.py",
      content: "SECRET_GENERATED_CONTENT_BAR",
      reason: "optimize bar",
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: "call_foo", function: { name: "chipmate_create_file", arguments: fooArgs } },
                  { index: 1, id: "call_bar", function: { name: "chipmate_create_file", arguments: barArgs } },
                ],
              },
            }],
          }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 2 ? "Created optimized scripts." : requests.length === 3 ? "Answered another question." : "You created two scripts." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-create-summary-storage-"),
      toolsEnabled: true,
      memorySummaryEnabled: false,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_file",
            description: "Create a new file",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["path", "content"] },
          },
        }],
        execute: async (input: { arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          const path = String(input.arguments.path ?? "")
          const content = String(input.arguments.content ?? "")
          const bytes = new TextEncoder().encode(content).length
          return {
            title: `Created file: ${path}`,
            output: JSON.stringify({
              answerSummary: `Created file: ${path}`,
              path,
              bytes,
            }),
            approved: true,
            status: "completed",
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "create optimized scripts" })
    await client.sendMessage({ sessionID: session.id, text: "explain something else" })
    await client.sendMessage({ sessionID: session.id, text: "刚才创建了哪些脚本" })

    expect(requests).toHaveLength(4)
    const finalPrompt = JSON.stringify(requests[3]?.body.messages)
    expect(finalPrompt).toContain("Tool execution history")
    expect(finalPrompt).toContain("chipmate_create_file completed")
    expect(finalPrompt).toContain("scripts/foo_opt.py")
    expect(finalPrompt).toContain("scripts/bar_opt.py")
    expect(finalPrompt).toContain("bytes=")
    expect(finalPrompt).toContain("reason=optimize foo")
    expect(finalPrompt).toContain("reason=optimize bar")
    expect(finalPrompt).not.toContain("SECRET_GENERATED_CONTENT_FOO")
    expect(finalPrompt).not.toContain("SECRET_GENERATED_CONTENT_BAR")
    expect(requests[3]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
  })

  test("replays compact create-directory tool summaries across intervening turns", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const directoryArgs = JSON.stringify({
      path: "generated/optimized-scripts/",
      reason: "group optimized scripts",
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_dir", function: { name: "chipmate_create_directory", arguments: directoryArgs } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 2 ? "Created folder." : requests.length === 3 ? "Answered another question." : "You created one folder." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-create-directory-summary-storage-"),
      toolsEnabled: true,
      memorySummaryEnabled: false,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_create_directory",
            description: "Create a new folder",
            parameters: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (input: { arguments: Record<string, unknown> }): Promise<ToolRuntimeResult> => {
          const path = String(input.arguments.path ?? "").replace(/\/+$/g, "")
          return {
            title: `Created folder: ${path}`,
            output: JSON.stringify({
              answerSummary: `Created folder: ${path}`,
              path,
              reason: input.arguments.reason,
            }),
            approved: true,
            status: "completed",
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "create a folder for optimized scripts" })
    await client.sendMessage({ sessionID: session.id, text: "explain something else" })
    await client.sendMessage({ sessionID: session.id, text: "刚才创建了哪个文件夹" })

    expect(requests).toHaveLength(4)
    const finalPrompt = JSON.stringify(requests[3]?.body.messages)
    expect(finalPrompt).toContain("Tool execution history")
    expect(finalPrompt).toContain("chipmate_create_directory completed")
    expect(finalPrompt).toContain("generated/optimized-scripts")
    expect(finalPrompt).toContain("reason=group optimized scripts")
    expect(requests[3]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
  })

  test("keeps tool execution summaries when maxHistoryTurns is zero", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 2 ? "Read done." : "Continuing." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-summary-zero-history-storage-"),
      toolsEnabled: true,
      historyTurns: 0,
      memorySummaryEnabled: false,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Read file",
          output: JSON.stringify({
            answerSummary: "Read README.md (12 lines).",
            path: "README.md",
            bytes: 1200,
          }),
          approved: true,
          status: "completed",
          risk: "low",
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "inspect README" })
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests).toHaveLength(3)
    expect(requests[2]?.body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Tool execution history") }),
      { role: "user", content: "continue" },
    ])
    const prompt = JSON.stringify(requests[2]?.body.messages)
    expect(prompt).toContain("chipmate_read completed")
    expect(prompt).toContain("README.md")
    expect(prompt).not.toContain("Read done.")
  })

  test("summarizes failed and blocked tool executions without unsafe arguments", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: "call_failed", function: { name: "chipmate_read", arguments: "{\"path\":\"missing.c\"}" } },
                  { index: 1, id: "call_blocked", function: { name: "chipmate_write_file", arguments: "{\"path\":\"src/existing.ts\",\"content\":\"OVERWRITE_SECRET\"}" } },
                ],
              },
            }],
          }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: requests.length === 2 ? "Handled tool failures." : "Explained tool failures." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-failed-blocked-summary-storage-"),
      toolsEnabled: true,
      memorySummaryEnabled: false,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "Read file failed",
          output: "File not found: missing.c",
          approved: false,
          status: "failed",
          error: "File not found: missing.c",
          risk: "failed",
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "read and overwrite" })
    await client.sendMessage({ sessionID: session.id, text: "what happened" })

    expect(requests).toHaveLength(3)
    const prompt = JSON.stringify(requests[2]?.body.messages)
    expect(prompt).toContain("Tool execution history")
    expect(prompt).toContain("chipmate_read failed")
    expect(prompt).toContain("File not found: missing.c")
    expect(prompt).toContain("chipmate_write_file blocked")
    expect(prompt).toContain("Tool is not exposed to the model")
    expect(prompt).toContain("path=src/existing.ts")
    expect(prompt).not.toContain("OVERWRITE_SECRET")
    expect(requests[2]?.body.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool" }),
    ]))
  })

  test("persists interrupted partial assistant text for next-turn history", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end(sse({ choices: [{ delta: { content: "Partial answer before interruption." } }] }))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "continued" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-partial-history-storage-") })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "first" })).rejects.toThrow()
    await client.sendMessage({ sessionID: session.id, text: "continue" })

    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "Partial answer before interruption." }),
    ]))
  })

  test("accepts finish_reason as a chat completion stream marker without DONE", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        sse({ choices: [{ delta: { content: "Finished by reason." } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-finish-reason-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "first" })

    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Finished by reason." }),
    ]))
    expect(requests[0]?.body).not.toHaveProperty("max_tokens")
    expect(outputLines.join("\n")).toContain("[chat-stream] request start model=chat-model")
    expect(outputLines.join("\n")).toContain("doneMarker=false")
    expect(outputLines.join("\n")).toContain("finishReason=stop")
  })

  test("records async stream interruptions when the provider closes before completion", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.write(sse({ choices: [{ delta: { content: "Partial answer before clean close." } }] }))
      response.end()
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-async-interrupt-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "first" })
    await waitFor(async () => (await client.getSessionStatuses())[session.id]?.type === "error")

    const messages = await client.getMessages(session.id)
    expect(messages.some((message) => message.info.error?.message?.includes("对话已中断"))).toBe(true)
    expect(messages.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("Partial answer before clean close.")))).toBe(true)
    expect(outputLines.join("\n")).toContain("[send] interrupted")
    expect(outputLines.join("\n")).toContain("closed before completion marker")
    expect(outputLines.join("\n")).toContain("deltaCount=")
    expect(outputLines.join("\n")).toContain("textBytes=")
    expect(outputLines.join("\n")).toContain("firstChunkMs=")
    expect(outputLines.join("\n")).toContain("doneMarker=false")
  })

  test("diagnoses 200 streams that close without OpenAI SSE data", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end("event: ping\n\n")
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-empty-sse-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await expect(client.sendMessage({ sessionID: session.id, text: "first" })).rejects.toThrow(/rawPreview=event: ping/)

    const output = outputLines.join("\n")
    expect(output).toContain("[chat-stream] response status=200 contentType=text/event-stream")
    expect(output).toContain("sseDataCount=0")
    expect(output).toContain("rawBytes=")
    expect(output).toContain("emptySsePreview=event: ping")
  })

  test("parses CRLF-delimited OpenAI SSE streams", async () => {
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "CRLF works." } }] })}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-crlf-sse-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "first" })

    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "CRLF works." }),
    ]))
    expect(outputLines.join("\n")).toContain("doneMarker=true")
  })

  test("reports async send busy status while a stream is in flight", async () => {
    let receivedRequest!: () => void
    let releaseStream!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      receivedRequest = resolve
    })
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.write(sse({ choices: [{ delta: { content: "Still working." } }] }))
      receivedRequest()
      await streamReleased
      response.end("data: [DONE]\n\n")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-async-busy-storage-") })
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "first" })
    await requestReceived
    await waitFor(async () => (await client.getSessionStatuses())[session.id]?.type === "busy")
    releaseStream()
    await waitFor(async () => (await client.getSessionStatuses())[session.id]?.type === "idle")
  })

  test("finalizes from same-turn bounded tool outputs after the default 25 agent steps", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length <= 25) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, function: { name: "chipmate_read", arguments: `{\"path\":\"file-${requests.length}.txt\"}` } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Final summary from bounded evidence." } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-loop-limit-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return {
            title: "Read file",
            output: JSON.stringify({
              answerSummary: `Read file-${toolExecutions}.txt`,
              data: { text: `RAW_BOUNDED_OUTPUT_${toolExecutions}` },
              truncated: false,
              coverage: "complete",
            }),
            approved: true,
            status: "completed",
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "inspect many files" })

    expect(requests).toHaveLength(26)
    expect(toolExecutions).toBe(25)
    expect(requests[0]?.body.tools).toBeDefined()
    expect(requests[25]?.body.tools).toBeUndefined()
    expect(requests[25]?.body.tool_choice).toBeUndefined()
    const finalizationPrompt = JSON.stringify(requests[25]?.body.messages)
    expect(finalizationPrompt).toContain("RAW_BOUNDED_OUTPUT_1")
    expect(finalizationPrompt).toContain("RAW_BOUNDED_OUTPUT_25")
    expect(finalizationPrompt).toContain("bounded raw tool outputs")
    expect(finalizationPrompt).not.toContain("Tool execution history")
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Final summary from bounded evidence." }),
    ]))
    const output = outputLines.join("\n")
    expect(output).toContain("[tool-loop] limit reached steps=25/25 totalToolCalls=25")
    expect(output).toContain("[tool-loop] finalization success")
  })

  test("does not present inline Markdown as completed Word output when the tool loop limit is reached without a DOCX", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mermaid", function: { name: "chipmate_render_mermaid_diagram", arguments: "{\"source\":\"flowchart TD\\nA-->B\",\"title\":\"流程图\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "完整 Word 文档如下：\n\n# 详细设计\n\n这里是正文。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_render_mermaid_diagram", "create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-doc-missing-deliverable-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 1,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: final answer must link the generated .docx.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_render_mermaid_diagram",
            description: "Render Mermaid",
            parameters: { type: "object", properties: { source: { type: "string" }, title: { type: "string" } }, required: ["source", "title"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return {
            title: "Rendered Mermaid diagram: 流程图",
            output: JSON.stringify({
              answerSummary: "Rendered Mermaid diagram \"流程图\" to .chipmate/docs/diagrams/flow.png.",
              evidence: [],
              gaps: [],
              nextActions: [{ tool: "create_word_document", reason: "Insert the returned PNG artifact path into the matching WordDocSpec section as a FigureSpec.", args: {} }],
              truncated: false,
              coverage: "complete",
              data: {
                kind: "mermaid",
                pngPath: ".chipmate/docs/diagrams/flow.png",
                mmdPath: ".chipmate/docs/diagrams/flow.mmd",
              },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档，包含流程图。" })

    expect(requests).toHaveLength(2)
    expect(toolExecutions).toBe(1)
    expect(requests[1]?.body.tools).toBeUndefined()
    const finalizationPrompt = JSON.stringify(requests[1]?.body.messages)
    expect(finalizationPrompt).toContain("Deliverable discipline")
    expect(finalizationPrompt).toContain("create_word_document")
    expect(finalizationPrompt).toContain("Do not present inline Markdown")
    const text = textPartsForTest(assistant)
    expect(text).toContain("未生成请求的本地交付物")
    expect(text).toContain("Word .docx document")
    expect(text).toContain("create_word_document")
    expect(text).not.toContain("完整 Word 文档如下")
    expect(outputLines.join("\n")).toContain("[tool-loop] enforced missing deliverable final answer")
  })

  test("does not truncate create_word_document arguments above the generic stream limit", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const largeParagraph = "A".repeat(150 * 1024)
    const largeSpec = minimalWordDocSpecForTest("大规格 Word 文档")
    largeSpec.sections[0].paragraphs.push(largeParagraph)
    const toolArgs = { filename: "large-word-spec.docx", spec: largeSpec }
    const serializedArgs = JSON.stringify(toolArgs)
    expect(Buffer.byteLength(serializedArgs, "utf8")).toBeGreaterThan(128 * 1024)
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_large_word", function: { name: "create_word_document", arguments: serializedArgs } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/large-word-spec.docx" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    let receivedArgs: Record<string, unknown> | undefined
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-large-word-args-storage-"),
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document"]),
          body: "Documents skill body marker: large WordDocSpec should be passed intact.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
          },
        }],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          receivedArgs = input.arguments
          return {
            title: "Create Word document",
            output: JSON.stringify({
              answerSummary: "Created Word document: .chipmate/docs/large-word-spec.docx",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "complete",
              data: { path: ".chipmate/docs/large-word-spec.docx" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份很长的 Word 文档。" })

    expect(receivedArgs?.filename).toBe("large-word-spec.docx")
    const receivedSpec = receivedArgs?.spec as ReturnType<typeof minimalWordDocSpecForTest> | undefined
    expect(receivedSpec?.sections[0].paragraphs.at(-1)).toBe(largeParagraph)
    expect(textPartsForTest(assistant)).toContain(".chipmate/docs/large-word-spec.docx")
    expect(outputLines.join("\n")).not.toContain("tool-arguments-truncated")
  })

  test("inserts a Word render checkpoint after create_word_document succeeds before finalizing", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "needs-render.docx", spec: minimalWordDocSpecForTest("需要渲染 QA 的文档") }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_render_word", function: { name: "render_word_document", arguments: JSON.stringify({ path: ".chipmate/docs/needs-render-20260630.docx" }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/needs-render-20260630.docx。页面级视觉 QA 已跳过：远端 render 服务未配置。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolExecutions: string[] = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-word-render-checkpoint-storage-"),
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document", "render_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document", "render_word_document"]),
          body: "Documents skill body marker: render_word_document must be called after create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
            },
          },
          {
            type: "function",
            function: {
              name: "render_word_document",
              description: "Render a Word document",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          toolExecutions.push(input.name)
          if (input.name === "create_word_document") {
            return {
              title: "Created Word document: .chipmate/docs/needs-render-20260630.docx",
              output: JSON.stringify({
                answerSummary: "Created Word document: .chipmate/docs/needs-render-20260630.docx",
                evidence: [],
                gaps: [],
                nextActions: [{ tool: "render_word_document", reason: "Run page-level visual QA for the generated DOCX.", args: { path: ".chipmate/docs/needs-render-20260630.docx" } }],
                truncated: false,
                coverage: "complete",
                data: { path: ".chipmate/docs/needs-render-20260630.docx" },
              }),
              approved: true,
              status: "completed",
            }
          }
          return {
            title: "Rendered Word document skipped",
            output: JSON.stringify({
              answerSummary: "Page-level visual QA skipped because remote render server was unconfigured.",
              evidence: [],
              gaps: ["Page-level visual QA skipped because remote render server was unconfigured."],
              nextActions: [],
              truncated: false,
              coverage: "partial",
              data: {
                path: ".chipmate/docs/needs-render-20260630.docx",
                visualQaStatus: "skipped",
                skipReason: "remote-unconfigured",
              },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(toolExecutions).toEqual(["create_word_document", "render_word_document"])
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("ChipMate Word render QA checkpoint")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain(".chipmate/docs/needs-render-20260630.docx")
    expect(outputLines.join("\n")).toContain("[tool-loop] word-render checkpoint inserted")
    expect(outputLines.join("\n")).toContain("documentSkillActive=true")
    expect(textPartsForTest(assistant)).toContain("页面级视觉 QA 已跳过")
  })

  test("discloses missing Word render QA if the model stops after the render checkpoint", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word_no_render", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "no-render.docx", spec: minimalWordDocSpecForTest("未渲染 QA 的文档") }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "已生成 Word 文档：.chipmate/docs/no-render-20260630.docx。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolExecutions: string[] = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-word-render-disclosure-storage-"),
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document", "render_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document", "render_word_document"]),
          body: "Documents skill body marker: render_word_document must be called after create_word_document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
            },
          },
          {
            type: "function",
            function: {
              name: "render_word_document",
              description: "Render a Word document",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          toolExecutions.push(input.name)
          return {
            title: "Created Word document: .chipmate/docs/no-render-20260630.docx",
            output: JSON.stringify({
              answerSummary: "Created Word document: .chipmate/docs/no-render-20260630.docx",
              evidence: [],
              gaps: [],
              nextActions: [{ tool: "render_word_document", reason: "Run page-level visual QA for the generated DOCX.", args: { path: ".chipmate/docs/no-render-20260630.docx" } }],
              truncated: false,
              coverage: "complete",
              data: { path: ".chipmate/docs/no-render-20260630.docx" },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(toolExecutions).toEqual(["create_word_document"])
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("ChipMate Word render QA checkpoint")
    const text = textPartsForTest(assistant)
    expect(text).toContain("已生成 Word 文档")
    expect(text).toContain("页面级视觉 QA 未完成")
    expect(outputLines.join("\n")).toContain("[tool-loop] enforced word render QA disclosure")
  })

  test("adds the generated Word document location when the final answer omits it", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create_word_location", function: { name: "create_word_document", arguments: JSON.stringify({ filename: "location.docx", spec: minimalWordDocSpecForTest("路径披露文档") }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      if (requests.length === 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_render_word_location", function: { name: "render_word_document", arguments: JSON.stringify({ path: ".chipmate/docs/location-20260630.docx" }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "Word 文档已经生成，页面级视觉 QA 已完成。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const toolExecutions: string[] = []
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-word-location-disclosure-storage-"),
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document", "render_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document", "render_word_document"]),
          body: "Documents skill body marker: final answer must visibly include the generated docx path.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [
          {
            type: "function",
            function: {
              name: "create_word_document",
              description: "Create a Word document",
              parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
            },
          },
          {
            type: "function",
            function: {
              name: "render_word_document",
              description: "Render a Word document",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
        ],
        execute: async (input: Parameters<ToolRuntimeInstance["execute"]>[0]): Promise<ToolRuntimeResult> => {
          toolExecutions.push(input.name)
          if (input.name === "create_word_document") {
            return {
              title: "Created Word document: .chipmate/docs/location-20260630.docx",
              output: JSON.stringify({
                answerSummary: "Created Word document: .chipmate/docs/location-20260630.docx",
                evidence: [],
                gaps: [],
                nextActions: [{ tool: "render_word_document", reason: "Run page-level visual QA for the generated DOCX.", args: { path: ".chipmate/docs/location-20260630.docx" } }],
                truncated: false,
                coverage: "complete",
                data: { path: ".chipmate/docs/location-20260630.docx" },
              }),
              approved: true,
              status: "completed",
            }
          }
          return {
            title: "Rendered Word document",
            output: JSON.stringify({
              answerSummary: "Rendered Word document successfully.",
              evidence: [],
              gaps: [],
              nextActions: [],
              truncated: false,
              coverage: "complete",
              data: {
                path: ".chipmate/docs/location-20260630.docx",
                visualQaStatus: "completed",
              },
            }),
            approved: true,
            status: "completed",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(toolExecutions).toEqual(["create_word_document", "render_word_document"])
    const text = textPartsForTest(assistant)
    expect(text).toContain("Word 文档已经生成")
    expect(text).toContain("生成位置：.chipmate/docs/location-20260630.docx")
    expect(outputLines.join("\n")).toContain("[tool-loop] enforced generated document location path=.chipmate/docs/location-20260630.docx")
  })

  test("keeps the generic stream argument limit for non-Word tools", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const hugeArgs = JSON.stringify({ path: `${"a".repeat(150 * 1024)}.txt` })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_huge_read", function: { name: "chipmate_read", arguments: hugeArgs } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "普通工具参数过大，未执行读取。" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-generic-tool-arg-limit-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return { title: "Read file", output: "should not run", approved: true, status: "completed" }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    await client.sendMessage({ sessionID: session.id, text: "读取一个超长路径。" })

    expect(toolExecutions).toBe(0)
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("tool-arguments-truncated")
    expect(outputLines.join("\n")).toContain("[tool] chipmate_read status=failed")
  })

  test("reports invalid create_word_document JSON without treating it as a missing spec", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_bad_word_json", function: { name: "create_word_document", arguments: "{\"filename\":\"bad.docx\",\"spec\":" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "完整 Word 文档如下：\n\n# 未实际生成的文档" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-invalid-word-json-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 1,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document"]),
          body: "Documents skill body marker: invalid tool JSON must not become a missing WordDocSpec.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return { title: "Create Word document", output: "should not run", approved: true, status: "completed" }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(toolExecutions).toBe(0)
    const text = textPartsForTest(assistant)
    expect(text).toContain("未生成请求的本地交付物")
    expect(text).toContain("tool-arguments-invalid-json")
    expect(text).not.toContain("word-doc-spec-missing")
    expect(text).not.toContain("完整 Word 文档如下")
    const followupMessages = requests[1]?.body.messages as Array<{ role?: string; tool_calls?: Array<{ function?: { arguments?: string } }> }> | undefined
    const recordedToolCall = followupMessages?.flatMap((message) => message.tool_calls ?? [])[0]
    expect(recordedToolCall?.function?.arguments).toContain("_chipmateInvalidToolArguments")
    expect(recordedToolCall?.function?.arguments).not.toBe("{\"filename\":\"bad.docx\",\"spec\":")
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("tool-arguments-invalid-json")
    expect(outputLines.join("\n")).toContain("toolArgumentsSanitized=true")
  })

  test("does not accept copy-to-Word Markdown as a completed DOCX deliverable", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end([
        sse({ choices: [{ delta: { content: "由于 Word 文档生成工具在处理大型 JSON 规范时遇到了解析限制，我将直接在此提供完整文档内容。您可以直接将以下内容复制到 Word 或 Markdown 编辑器中使用。\n\n---\n\nUFS3030-CV 项目 CI/CD 流程详细设计文档" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-copy-markdown-docx-storage-"),
      outputLines,
      toolsEnabled: true,
      skills: {
        enabledSkills: async () => [documentsSkillForTest(["create_word_document"])],
        loadSkill: async (_id, invocationMode) => ({
          ...documentsSkillForTest(["create_word_document"]),
          body: "Documents skill body marker: inline Markdown is not a DOCX artifact.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({ title: "Create Word document", output: "should not run", approved: true, status: "completed" }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成 UFS3030-CV 项目 CI/CD 流程详细设计 Word 文档。" })

    const text = textPartsForTest(assistant)
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect(text).toContain("未生成请求的本地交付物")
    expect(text).not.toContain("复制到 Word 或 Markdown")
    expect(text).not.toContain("UFS3030-CV 项目 CI/CD 流程详细设计文档")
    expect(outputLines.join("\n")).toContain("[tool-loop] enforced missing deliverable final answer")
  })

  test("reports producer validation failures when repeated create_word_document attempts never produce DOCX", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length <= 2) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_create_fail_${requests.length}`, function: { name: "create_word_document", arguments: JSON.stringify({ filename: "still-invalid.docx", spec: { metadata: {}, sections: [] } }) } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { content: "完整 Word 文档如下：\n\n# 未实际生成的文档" } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    const skill = {
      id: "repo:documents",
      name: "documents",
      description: "Create, edit, review, and verify general Word `.docx` documents.",
      path: "/repo/.agents/skills/documents/SKILL.md",
      skillRoot: "/repo/.agents/skills/documents",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "documents",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["create_word_document"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
      resourceFiles: ["tasks/create_edit_v1.md"],
      validationErrors: [],
      validationWarnings: [],
    }
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-doc-repeated-producer-failure-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 2,
      skills: {
        enabledSkills: async () => [skill],
        loadSkill: async (_id, invocationMode) => ({
          ...skill,
          body: "Documents skill body marker: failed WordDocSpec must not be treated as a completed document.",
          invocationMode,
        }),
      } as unknown as SkillRegistry,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "create_word_document",
            description: "Create a Word document",
            parameters: { type: "object", properties: { spec: { type: "object" }, filename: { type: "string" } }, required: ["spec"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return {
            title: "Create Word document",
            output: JSON.stringify({
              answerSummary: "Create Word document failed: WordDocSpec validation failed: WordDocSpec metadata.title is required.",
              evidence: [],
              gaps: ["WordDocSpec metadata.title is required."],
              nextActions: [{ tool: "create_word_document", reason: "Repair the WordDocSpec and retry.", args: {} }],
              truncated: false,
              coverage: "partial",
              data: {
                errorCode: "word-doc-spec-validation-failed",
                errorMessage: "WordDocSpec validation failed: WordDocSpec metadata.title is required.",
                validationErrors: ["WordDocSpec metadata.title is required."],
                diagnostic: {
                  specShapeHash: "deadbeef",
                  specType: "object",
                  sections: 0,
                  sources: 0,
                  figures: 0,
                  tables: 0,
                },
              },
            }),
            approved: false,
            status: "failed",
            error: "WordDocSpec validation failed: WordDocSpec metadata.title is required.",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "请生成一份 Word 文档。" })

    expect(toolExecutions).toBe(2)
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("ChipMate producer failure repair checkpoint")
    expect(JSON.stringify(requests[2]?.body.messages)).toContain("Producer failures this turn")
    expect(outputLines.join("\n")).toContain("producer failure recorded tool=create_word_document")
    expect(outputLines.join("\n")).toContain("specShapeHash=deadbeef")
    expect(outputLines.join("\n")).toContain("repeatedInvalidSpec=true")
    expect(outputLines.join("\n")).toContain("producer failure repair checkpoint inserted")
    const text = textPartsForTest(assistant)
    expect(text).toContain("未生成请求的本地交付物")
    expect(text).toContain("最终产物工具失败原因")
    expect(text).toContain("word-doc-spec-validation-failed")
    expect(text).toContain("WordDocSpec metadata.title is required.")
    expect(text).not.toContain("完整 Word 文档如下")
  })

  test("does not execute tool calls returned by tool-loop finalization", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ url: request.url, body })
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      if (requests.length === 1) {
        response.end([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_initial", function: { name: "chipmate_read", arguments: "{\"path\":\"README.md\"}" } }] } }] }),
          "data: [DONE]\n\n",
        ].join(""))
        return
      }
      response.end([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_final", function: { name: "chipmate_read", arguments: "{\"path\":\"NEVER_EXECUTE.md\"}" } }] } }] }),
        "data: [DONE]\n\n",
      ].join(""))
    })
    let toolExecutions = 0
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-tool-loop-finalization-toolcall-storage-"),
      outputLines,
      toolsEnabled: true,
      maxAgentSteps: 1,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => {
          toolExecutions += 1
          return {
            title: "Read file",
            output: "RAW_BOUNDED_OUTPUT",
            approved: true,
            status: "completed",
            risk: "low",
          }
        },
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()

    const assistant = await client.sendMessage({ sessionID: session.id, text: "read until limit" })

    expect(requests).toHaveLength(2)
    expect(toolExecutions).toBe(1)
    expect(requests[1]?.body.tools).toBeUndefined()
    expect(textPartsForTest(assistant)).toContain("已达到本轮工具调用上限")
    expect(textPartsForTest(assistant)).toContain("finalization returned 1 tool_call")
    expect(outputLines.join("\n")).toContain("[tool-loop] finalization fallback: finalization returned 1 tool_call(s)")
  })

  test("does not record session errors for user-aborted async sends", async () => {
    const outputLines: string[] = []
    let receivedRequest!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      receivedRequest = resolve
    })
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(200, {
        "content-type": "text/event-stream",
      })
      response.write(sse({ choices: [{ delta: { content: "Partial answer before user stop." } }] }))
      receivedRequest()
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-user-abort-storage-"),
      outputLines,
    })
    const session = await client.createSession()

    await client.sendMessageAsync({ sessionID: session.id, text: "first" })
    await requestReceived
    await client.abortSession(session.id)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const messages = await client.getMessages(session.id)
    expect(messages.some((message) => Boolean(message.info.error))).toBe(false)
    expect(outputLines.join("\n")).not.toContain("[send] interrupted")
  })

  test("repairs Mermaid render failures without exposing tools and persists a repair assistant message", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const outputLines: string[] = []
    const brokenSource = [
      "graph TD",
      "EE[extension-entry.ts] --> Settings[settings]",
      "classDef external fill:#fafafa,stroke:#9e9e9e,color:#616161,stroke-dasharray=5 5",
      "class EE external",
    ].join("\n")
    const repairedSource = [
      "```mermaid",
      "graph TD",
      "  EE[\"extension-entry.ts\"] --> Settings[\"settings\"]",
      "  classDef external fill:#fafafa,stroke:#9e9e9e,color:#616161",
      "  class EE external",
      "```",
    ].join("\n")
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      json(response, 200, {
        choices: [{ message: { role: "assistant", content: repairedSource } }],
        usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 },
      })
    })
    const client = directClient(baseUrl, {
      storageRoot: await tempDir("chipmate-mermaid-repair-storage-"),
      outputLines,
      toolsEnabled: true,
      tools: {
        toolDefinitions: () => [{
          type: "function",
          function: {
            name: "chipmate_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }],
        execute: async (): Promise<ToolRuntimeResult> => ({
          title: "should not run",
          output: "should not run",
          approved: true,
        }),
      } as unknown as ToolRuntimeInstance,
    })
    const session = await client.createSession()
    const [, originalAssistant] = await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "请画 Mermaid 架构图" },
        { role: "assistant", text: `这里是图：\n\n\`\`\`mermaid\n${brokenSource}\n\`\`\`` },
      ],
    })

    const assistant = await client.repairMermaidDiagram({
      sessionID: session.id,
      messageID: originalAssistant!.info.id,
      sourceHash: "fixture-source",
      source: brokenSource,
      error: "Lexical error on line 119. Unrecognized text.",
      language: "mermaid",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      temperature: 0,
    })
    expect(requests[0]?.body).not.toHaveProperty("tools")
    expect(requests[0]?.body).not.toHaveProperty("tool_choice")
    const promptPayload = JSON.stringify(requests[0]?.body.messages)
    expect(promptPayload).toContain("Return exactly one fenced")
    expect(promptPayload).toContain("Lexical error on line 119")
    expect(promptPayload).toContain("stroke-dasharray=5 5")
    expect(textPartsForTest(assistant)).toContain("我根据 Mermaid 渲染错误重画了一版")
    expect(textPartsForTest(assistant)).toContain(repairedSource)

    const messages = await client.getMessages(session.id)
    const persisted = messages.at(-1)
    expect(persisted?.info.mode).toBe("mermaid-repair")
    expect(persisted?.info.usageKind).toBe("reported")
    expect(textPartsForTest(persisted!)).toContain(repairedSource)
    expect(outputLines.join("\n")).toContain("[mermaid-repair] request")
    expect(outputLines.join("\n")).toContain("tools=disabled")
  })

  test("does not persist a Mermaid repair assistant message when the provider fails", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      response.writeHead(500, { "content-type": "text/plain" }).end("model unavailable")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-mermaid-repair-failed-storage-") })
    const session = await client.createSession()
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        { role: "user", text: "请画 Mermaid 图" },
        { role: "assistant", text: "```mermaid\ngraph TD\nA --> B\n```" },
      ],
    })

    await expect(client.repairMermaidDiagram({
      sessionID: session.id,
      messageID: "assistant-original",
      sourceHash: "fixture-source",
      source: "graph TD\nA --> B",
      error: "Mermaid render failed",
      language: "mermaid",
    })).rejects.toThrow(/Mermaid repair failed: 500/)

    const messages = await client.getMessages(session.id)
    expect(messages).toHaveLength(2)
    expect(messages.some((message) => message.info.mode === "mermaid-repair")).toBe(false)
  })

  test("persists local document-agent history messages without provider calls", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(500).end("provider should not be called")
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-local-history-storage-") })
    const session = await client.createSession()

    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [
        {
          role: "user",
          text: "User question:\n请综合这些资料生成 Word。",
          parts: [{ type: "text", text: "User question:\n请综合这些资料生成 Word。" }],
          mode: "doc-agent-local",
        },
        {
          role: "assistant",
          text: "已生成团队规范：.chipmate/docs/team.docx",
          mode: "doc-agent-local",
          parts: [
	            { type: "text", text: "已生成团队规范：.chipmate/docs/team.docx" },
	            { type: "generatedDocument", path: ".chipmate/docs/team.docx", sourceCount: 2, warningCount: 1 },
	            { type: "diagram", kind: "mermaid", title: "设计流程图", sourceText: "flowchart TD\n  start[Start] --> done[Done]", diagramId: "design-doc-code-flow-1" },
	            { type: "docAgentTimeline", title: "本地 Word 生成完成", status: "completed", events: [{ type: "done", title: "完成", status: "completed" }] },
	          ],
        },
      ],
    })

    const messages = await client.getMessages(session.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.info.mode).toBe("doc-agent-local")
	    expect(messages[1]?.parts).toEqual(expect.arrayContaining([
	      expect.objectContaining({ type: "generatedDocument", path: ".chipmate/docs/team.docx" }),
	      expect.objectContaining({ type: "diagram", kind: "mermaid", sourceText: expect.stringContaining("flowchart TD") }),
	      expect.objectContaining({ type: "docAgentTimeline", status: "completed" }),
	    ]))
  })

  test("generates and persists model display titles for plugin chat sessions", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await collectJson(request)
      requests.push({ body })
      json(response, 200, {
        choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "历史标题与批量删除" }) } }],
      })
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-session-title-storage-") })
    const session = await client.createSession(CHAT_SESSION_TITLE)
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [{ role: "user", text: "User question:\nsession 历史里标题都一样，还要批量删除。" }],
    })

    await expect(client.ensureSessionDisplayTitle(session.id)).resolves.toMatchObject({
      id: session.id,
      title: CHAT_SESSION_TITLE,
      displayTitle: "历史标题与批量删除",
      displayTitleSource: "model",
    })
    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        title: CHAT_SESSION_TITLE,
        displayTitle: "历史标题与批量删除",
        displayTitleSource: "model",
      }),
    ])
    await client.ensureSessionDisplayTitle(session.id)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "chat-model",
      stream: false,
      max_tokens: 48,
      temperature: 0,
    })
  })

  test("falls back to a local display title when model title content is empty", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, { choices: [{ message: { role: "assistant", content: "" } }] })
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-session-title-fallback-storage-") })
    const session = await client.createSession(CHAT_SESSION_TITLE)
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [{ role: "user", text: "User question:\n请修复历史 session 标题并支持批量删除。" }],
    })

    await expect(client.ensureSessionDisplayTitle(session.id)).resolves.toMatchObject({
      id: session.id,
      displayTitle: "请修复历史 session 标题并支持批量删除",
      displayTitleSource: "fallback",
    })
  })

  test("keeps display titles when later append-only session updates touch the record", async () => {
    const baseUrl = await listen(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      await collectJson(request)
      json(response, 200, {
        choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "保留历史标题" }) } }],
      })
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-session-title-touch-storage-") })
    const session = await client.createSession(CHAT_SESSION_TITLE)
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [{ role: "user", text: "User question:\n生成历史标题。" }],
    })
    await client.ensureSessionDisplayTitle(session.id)
    await client.appendLocalMessages({
      sessionID: session.id,
      messages: [{ role: "assistant", text: "标题已经生成。" }],
    })

    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        displayTitle: "保留历史标题",
        displayTitleSource: "model",
      }),
    ])
  })

  test("deletes persisted sessions and emits session.deleted", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(404).end()
    })
    const client = directClient(baseUrl, { storageRoot: await tempDir("chipmate-delete-session-storage-") })
    const events: unknown[] = []
    const controller = new AbortController()
    const subscription = client.subscribeEvents((event) => events.push(event), controller.signal)
    const first = await client.createSession("First chat")
    const second = await client.createSession("Second chat")
    await client.abortSession(first.id)

    await expect(client.deleteSession(first.id)).resolves.toBe(true)
    controller.abort()
    await subscription

    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: second.id, title: "Second chat" }),
    ])
    await expect(client.getMessages(first.id)).resolves.toEqual([])
    expect((await client.getSessionStatuses())[first.id]).toBeUndefined()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.deleted",
        properties: { info: expect.objectContaining({ id: first.id, title: "First chat" }) },
      }),
    ]))
  })
})

function directClient(baseUrl: string, overrides: Partial<{
  storageRoot: string
  outputLines: string[]
  tools: ToolRuntimeInstance
  toolsEnabled: boolean
  permissionMode: RemoteSettings["permissions"]["mode"]
  historyTurns: number
  historyBytes: number
  memorySummaryEnabled: boolean
  memorySummaryMaxBytes: number
  memorySummaryTriggerOverflowTurns: number
  apiKey: string | undefined
  maxTokens: number
  maxAgentSteps: number
  skills: Partial<SkillRegistry>
}> = {}) {
  const settings = directSettings(baseUrl)
  settings.tools.enabled = overrides.toolsEnabled === true
  if (overrides.maxAgentSteps !== undefined) settings.tools.maxAgentSteps = overrides.maxAgentSteps
  if (overrides.permissionMode !== undefined) settings.permissions.mode = overrides.permissionMode
  if (overrides.historyTurns !== undefined) settings.context.maxHistoryTurns = overrides.historyTurns
  if (overrides.historyBytes !== undefined) settings.context.maxHistoryBytes = overrides.historyBytes
  if (overrides.memorySummaryEnabled !== undefined) settings.context.memorySummary.enabled = overrides.memorySummaryEnabled
  if (overrides.memorySummaryMaxBytes !== undefined) settings.context.memorySummary.maxBytes = overrides.memorySummaryMaxBytes
  if (overrides.memorySummaryTriggerOverflowTurns !== undefined) settings.context.memorySummary.triggerOverflowTurns = overrides.memorySummaryTriggerOverflowTurns
  if (overrides.maxTokens !== undefined) settings.provider.maxTokens = overrides.maxTokens
  return new DirectAgentClient({
    context: {
      globalStorageUri: UriShim.file(overrides.storageRoot ?? join(tmpdir(), "chipmate-direct-storage-default")),
    },
    output: {
      appendLine: (line: string) => overrides.outputLines?.push(line),
    },
    getSettings: () => settings,
    getApiKey: async () => Object.prototype.hasOwnProperty.call(overrides, "apiKey") ? overrides.apiKey : "secret",
    skills: overrides.skills ?? {
      enabledSkills: async () => [],
      loadSkill: async () => undefined,
    } as unknown as SkillRegistry,
    tools: overrides.tools ?? {
      toolDefinitions: () => [],
      execute: async () => ({
        title: "noop",
        output: "noop",
        approved: true,
      }),
    } as unknown as ToolRuntimeInstance,
  } as never)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition.")
}

function textPartsForTest(message: { parts: Array<{ type?: unknown; text?: unknown }> }) {
  return message.parts
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("")
}

function minimalWordDocSpecForTest(title = "Test Document") {
  return {
    metadata: {
      title,
      documentType: "technical-report",
      language: "zh-CN",
      generatedAt: "2026-06-28T00:00:00.000Z",
    },
    sources: [],
    sections: [{
      id: "overview",
      level: 1,
      title: "概览",
      paragraphs: [
        "这是一个用于测试 WordDocSpec 工具入口的最小文档，包含足够的正文内容以通过本地 DOCX 结构门禁。",
        "测试重点是验证 create_word_document 能接受对象形式或字符串化 JSON 形式的 spec，并在参数错误时返回可修复诊断。",
        "该文档不依赖外部资料，sources 可以为空；真实任务中模型仍应根据证据生成更完整的章节、假设和限制。",
      ],
    }],
  }
}

function documentsSkillForTest(allowedTools: string[]) {
  return {
    id: "repo:documents",
    name: "documents",
    description: "Create, edit, review, and verify general Word `.docx` documents.",
    path: "/repo/.agents/skills/documents/SKILL.md",
    skillRoot: "/repo/.agents/skills/documents",
    sourceRoot: "/repo/.agents/skills",
    scope: "workspace",
    sourceKind: "agents",
    commandName: "documents",
    visibility: "on",
    enabled: true,
    modelVisible: true,
    userVisible: true,
    invalid: false,
    allowedTools,
    disableModelInvocation: false,
    userInvocable: true,
    compatibility: "",
    license: "",
    metadata: { keywords: JSON.stringify(["word", "docx", "Word 文档", "生成*文档"]) },
    resourceFiles: ["tasks/create_edit_v1.md"],
    validationErrors: [],
    validationWarnings: [],
  }
}

function tinyPngDataUri() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
}

function pngDataUriWithDecodedBytes(bytes: number) {
  const base64Length = Math.ceil(bytes / 3) * 4
  return `data:image/png;base64,${"A".repeat(base64Length)}`
}

function toolPartEvents(events: unknown[], id: string) {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return []
    const record = event as { type?: unknown; properties?: { part?: unknown } }
    if (record.type !== "message.part.updated") return []
    const part = record.properties?.part
    if (!part || typeof part !== "object") return []
    const toolPart = part as { id?: unknown; type?: unknown; tool?: unknown; state?: Record<string, unknown> }
    return toolPart.type === "tool" && toolPart.id === id ? [toolPart] : []
  })
}

function directSettings(baseUrl: string): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: baseUrl,
      chatModel: "chat-model",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
    },
    serverUrl: baseUrl,
    username: "chipmate",
    defaultModel: "chat-model",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
      maxHistoryTurns: 10,
      maxHistoryBytes: 40000,
      memorySummary: {
        enabled: true,
        maxBytes: 12000,
        triggerOverflowTurns: 2,
      },
    },
    permissions: {
      mode: "full-access",
    },
    tools: {
      enabled: false,
      maxAgentSteps: 25,
    },
    skills: {
      enabled: [],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: true,
      maxCatalogBytes: 8000,
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: baseUrl,
      model: "completion-model",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      debounceMs: 0,
      logLevel: "off",
      debugFullRetrievalProbe: false,
      debugExpectedSymbol: "",
      commentGuidedRetrievalMode: "qa-exact",
    },
    codeGraph: {
      enabled: true,
      promptOnWorkspaceOpen: false,
      analysisMode: "auto",
      maxFiles: 50000,
      maxContextBytes: 24000,
      maxEvidenceBytes: 60000,
      maxGraphDepth: 2,
      maxFanout: 40,
      maxDeepFiles: 24,
      maxStateTransitions: 120,
      watcherRescanThreshold: 750,
      workerConcurrency: 4,
      queryCacheSize: 80,
      memoryLimitMb: 4096,
      compileCommandsPath: "",
      clangdPath: "",
      scipClangPath: "",
      excludeGlobs: [],
      indexTests: false,
    },
    analysis: {
      bridgeEnabled: false,
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      maxFileSliceBytes: 16000,
      maxGraphEdges: 120,
      maxPaths: 10,
    },
    rag: {
      embedding: {
        enabled: false,
        endpoint: "",
        model: "",
        batchSize: 64,
        maxTokensPerRequest: 65536,
        concurrentRequests: 2,
        maxInFlightTokens: 360000,
        encodingFormat: "auto",
        checkpointMode: "interval",
        checkpointChunkInterval: 8192,
        checkpointIntervalMs: 120000,
        timeoutMs: 30000,
        requestDelayMs: 0,
        maxRequestsPerRun: 100,
        maxRetries: 3,
        retryBackoffMs: 2000,
        resumeAutomatically: true,
        resumeDelayMs: 60000,
      },
      rerank: {
        enabled: false,
        endpoint: "",
        model: "",
      },
      allowedHosts: [],
      indexTests: false,
      vectorTopK: 24,
      rerankTopK: 16,
    },
    documentRag: {
      enabled: true,
      maxFiles: 5000,
      maxFileBytes: 25 * 1024 * 1024,
      maxExtractedBytesPerFile: 1024 * 1024,
      maxChunks: 50000,
      excludeGlobs: [],
      queryTopK: 12,
      maxEvidenceBytes: 24000,
    },
  }
}

function listen(handler: http.RequestListener) {
  return new Promise<string>((resolve) => {
    const server = http.createServer((request, response) => {
      response.setHeader("connection", "close")
      handler(request, response)
    })
    server.keepAliveTimeout = 1
    servers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server address unavailable")
      resolve(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

function collectJson(request: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk.toString()
    })
    request.on("end", () => {
      resolve(JSON.parse(body || "{}") as Record<string, unknown>)
    })
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function writeChatSse(response: http.ServerResponse, content: string) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end([
    sse({ choices: [{ delta: { content } }] }),
    "data: [DONE]\n\n",
  ].join(""))
}

function sse(body: unknown) {
  return `data: ${JSON.stringify(body)}\n\n`
}

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}

function extensionContext(storageRoot: string) {
  return {
    globalStorageUri: UriShim.file(storageRoot),
  } as never
}

async function expectRenderAttemptOrHonestFallback(
  workspaceRoot: string,
  payload: { gaps?: string[]; data: { renderCheckResult: { ok: boolean; attempted: boolean; pagePngPaths?: string[]; visualQaStatus?: string; skipReason?: string } } },
) {
  expect(payload.data.renderCheckResult.ok).toBe(true)
  if (payload.data.renderCheckResult.attempted) {
    expect(payload.data.renderCheckResult.pagePngPaths?.length).toBeGreaterThan(0)
    for (const pagePngPath of payload.data.renderCheckResult.pagePngPaths ?? []) {
      expect((await readFile(join(workspaceRoot, pagePngPath))).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
    }
    return
  }
  expect(payload.data.renderCheckResult.visualQaStatus).toBe("skipped")
  expect(payload.data.renderCheckResult.skipReason).toBeTruthy()
  expect((payload.gaps ?? []).join("\n")).toMatch(/remote Word render|Remote Word render|page-level visual QA was skipped/i)
}

function tinyPngBytes() {
  return Uint8Array.from([
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
}
