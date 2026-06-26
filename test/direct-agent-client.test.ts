import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SkillRegistry } from "../src/skills"
import type { ToolRuntime as ToolRuntimeInstance, ToolRuntimeResult } from "../src/tool-runtime"
import type { DrawioGeneratedDiagram } from "../src/drawio-diagram-generator"
import type { RemoteSettings } from "../src/types"
import { CHAT_SESSION_TITLE } from "../src/chat-session"
import { docxFixture } from "./document-fixtures"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []
let warningMessageSelection: string | undefined
let warningMessageCalls = 0

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
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => fallback,
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
const { generateDrawioDiagram } = await import("../src/drawio-diagram-generator")
const { setDrawioElkLayoutRunnerForTest } = await import("../src/drawio-layout-engine")

let servers: http.Server[] = []

beforeEach(() => {
  workspaceFolders = []
  warningMessageSelection = undefined
  warningMessageCalls = 0
})

afterEach(async () => {
  setDrawioElkLayoutRunnerForTest(undefined)
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

describe("ToolRuntime", () => {
  test("exposes read evidence and bounded workspace write tool definitions to models", () => {
    const runtime = new ToolRuntime({} as never)
    const toolNames = runtime.toolDefinitions().map((definition) => definition.function.name)

    expect(toolNames).toEqual([
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
      "read_docx",
      "chipmate_ask_user_clarification",
      "chipmate_validate_diagram_ir",
      "chipmate_create_drawio_diagram",
      "create_word_document",
      "chipmate_create_file",
      "chipmate_create_directory",
      "chipmate_edit_file",
    ])
    expect(toolNames).not.toContain("chipmate_write_file")
    expect(toolNames).not.toContain("chipmate_run_command")
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
    const clarification = runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_ask_user_clarification")
    expect(clarification?.function.parameters).toMatchObject({
      required: ["reason"],
      additionalProperties: false,
    })
    expect(clarification?.function.parameters.properties).toHaveProperty("questions")
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Use when"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Do not use"))).toBe(true)
    expect(runtime.toolDefinitions().every((definition) => definition.function.description.includes("Returns"))).toBe(true)
    expect(runtime.toolDefinitions().find((definition) => definition.function.name === "chipmate_read")?.function.description).toContain("Office/PDF")
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
    await writeFile(join(skillRoot, "references", "guide.md"), "Guide text\n")
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
    expect(auditEvents[0]?.detail).toMatchObject({
      skillId: "repo:review",
      skillName: "review",
      invocationMode: "explicit",
      toolAllowedBySkill: true,
    })
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

describe("DirectAgentClient", () => {
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

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function sse(body: unknown) {
  return `data: ${JSON.stringify(body)}\n\n`
}

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}
