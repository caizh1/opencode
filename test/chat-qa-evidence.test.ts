import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidenceQueryOptions } from "../src/codegraph-types"
import type { CodeGraphStatus, RagAvailability, RagStatus, RemoteSettings } from "../src/types"
import { docxFixture, pdfFixture, xlsxFixture } from "./document-fixtures"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []
let textDocuments: FakeDocument[] = []
let fileBytes = new Map<string, Uint8Array>()

class UriShim {
  readonly scheme = "file"

  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

class RangeShim {
  readonly start: { line: number; character: number }
  readonly end: { line: number; character: number }

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter }
    this.end = { line: endLine, character: endCharacter }
  }
}

class PositionShim {
  constructor(readonly line: number, readonly character: number) {}
}

class RelativePatternShim {
  readonly baseUri: UriShim

  constructor(base: { uri?: UriShim } | UriShim | string, readonly pattern: string) {
    if (typeof base === "string") {
      this.baseUri = UriShim.file(base)
    } else if ("uri" in base && base.uri) {
      this.baseUri = base.uri
    } else {
      this.baseUri = base as UriShim
    }
  }
}

type FakeDocument = {
  uri: UriShim
  languageId: string
  lineCount: number
  getText: (range?: RangeShim) => string
  lineAt: (line: number) => { text: string }
}

mock.module("vscode", () => ({
  Range: RangeShim,
  Position: PositionShim,
  RelativePattern: RelativePatternShim,
  Uri: UriShim,
  env: {
    remoteName: undefined,
  },
  FileType: {
    File: 1,
    Directory: 2,
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
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  ConfigurationTarget: {
    Global: "global",
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    get textDocuments() {
      return textDocuments
    },
    getWorkspaceFolder: (uri: UriShim) => workspaceFolders.find((folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`)),
    asRelativePath: (uri: UriShim) => {
      const root = workspaceFolders[0]?.uri.fsPath
      return root && uri.fsPath.startsWith(`${root}/`) ? uri.fsPath.slice(root.length + 1) : uri.fsPath
    },
    findFiles: async (include: RelativePatternShim | string, _exclude?: unknown, maxResults?: number) => {
      const base = include instanceof RelativePatternShim ? include.baseUri.fsPath : workspaceFolders[0]?.uri.fsPath ?? "/repo"
      const files = [...fileBytes.keys()]
        .filter((file) => file.startsWith(`${base}/`))
        .sort()
        .slice(0, maxResults ?? undefined)
      return files.map((file) => UriShim.file(file))
    },
    openTextDocument: async (uri: UriShim) => textDocuments.find((document) => document.uri.toString() === uri.toString()),
    fs: {
      readFile: async (uri: UriShim) => fileBytes.get(uri.fsPath) ?? new Uint8Array(),
      stat: async (uri: UriShim) => {
        if (fileBytes.has(uri.fsPath)) return { type: 1 }
        if ([...fileBytes.keys()].some((file) => file.startsWith(`${uri.fsPath}/`))) return { type: 2 }
        throw new Error("ENOENT")
      },
    },
  },
  window: {
    get activeTextEditor() {
      return undefined
    },
    get visibleTextEditors() {
      return []
    },
  },
}))

const { buildChatPrompt, buildChatPromptWithEvidence, LocalContextStore } = await import("../src/context")
const { UnderstandingPlanner } = await import("../src/understanding-planner")

beforeEach(() => {
  workspaceFolders = [{ name: "repo", uri: UriShim.file("/repo") }]
  textDocuments = []
  fileBytes = new Map()
})

describe("QA chat evidence retrieval", () => {
  test("includes Office and PDF attachments as extracted local context", async () => {
    fileBytes.set("/repo/docs/brief.docx", docxFixture("Word project brief"))
    fileBytes.set("/repo/docs/table.xlsx", xlsxFixture())
    fileBytes.set("/repo/docs/spec.pdf", pdfFixture("PDF requirements text"))
    const contextSummary: Array<{ path: string; skipped: boolean }> = []

    const prompt = await buildChatPrompt({
      question: "请总结这些文档",
      options: {
        includeSelection: false,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      mentionedFiles: [
        UriShim.file("/repo/docs/brief.docx") as never,
        UriShim.file("/repo/docs/table.xlsx") as never,
        UriShim.file("/repo/docs/spec.pdf") as never,
      ],
      onContextSummary: (items) => contextSummary.push(...items),
    })

    expect(prompt).toContain("Word project brief")
    expect(prompt).toContain('sheet "Summary" range=A1:C2')
    expect(prompt).toContain("PDF requirements text")
    expect(contextSummary).toEqual([
      expect.objectContaining({ path: "docs/brief.docx", skipped: false }),
      expect.objectContaining({ path: "docs/table.xlsx", skipped: false }),
      expect.objectContaining({ path: "docs/spec.pdf", skipped: false }),
    ])
  })

  test("continues to skip unsupported binary attachments", async () => {
    fileBytes.set("/repo/bin/blob.dat", new Uint8Array([0, 1, 2, 3, 4]))
    const contextSummary: Array<{ path: string; skipped: boolean }> = []
    const localSettings = settings()
    localSettings.context.localOnlyMode = false

    const prompt = await buildChatPrompt({
      question: "看这个二进制文件",
      options: {
        includeSelection: false,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: localSettings,
      contextStore: new LocalContextStore(),
      mentionedFiles: [UriShim.file("/repo/bin/blob.dat") as never],
      onContextSummary: (items) => contextSummary.push(...items),
    })

    expect(prompt).toContain("[binary file skipped]")
    expect(contextSummary).toEqual([
      expect.objectContaining({ path: "bin/blob.dat", skipped: true }),
    ])
  })

  test("expands mentioned folders recursively while keeping build and excluding out/dist", async () => {
    const encoder = new TextEncoder()
    fileBytes.set("/repo/module/main.c", encoder.encode("int module_main(void) { return 0; }\n"))
    fileBytes.set("/repo/module/include/driver.h", encoder.encode("#pragma once\nint module_main(void);\n"))
    fileBytes.set("/repo/module/build/check.sh", encoder.encode("#!/bin/sh\necho check\n"))
    fileBytes.set("/repo/module/build/config.yml", encoder.encode("target: module\n"))
    fileBytes.set("/repo/module/build/tool.py", encoder.encode("print('tool')\n"))
    fileBytes.set("/repo/module/build/CMakeLists.txt", encoder.encode("add_library(module main.c)\n"))
    fileBytes.set("/repo/module/out/generated.c", encoder.encode("int generated_out(void) { return 1; }\n"))
    fileBytes.set("/repo/module/dist/package.yml", encoder.encode("ignored: true\n"))
    fileBytes.set("/repo/module/build/blob.o", new Uint8Array([0, 1, 2, 3]))
    const contextSummary: Array<{ path: string; source: string; skipped: boolean }> = []
    const localSettings = settings()
    localSettings.context.localOnlyMode = false

    const prompt = await buildChatPrompt({
      question: "分析这个模块目录",
      options: {
        includeSelection: false,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: localSettings,
      contextStore: new LocalContextStore(),
      mentionedContext: [{
        uri: UriShim.file("/repo/module") as never,
        type: "folder",
        label: "module",
        insertText: "module/",
      }],
      onContextSummary: (items) => contextSummary.push(...items),
    })

    expect(prompt).toContain("int module_main(void)")
    expect(prompt).toContain("#pragma once")
    expect(prompt).toContain("#!/bin/sh")
    expect(prompt).toContain("target: module")
    expect(prompt).toContain("print('tool')")
    expect(prompt).toContain("add_library(module main.c)")
    expect(prompt).toContain('<file path="module/include/driver.h" language="c"')
    expect(prompt).toContain('<file path="module/build/check.sh" language="shellscript"')
    expect(prompt).toContain('<file path="module/build/config.yml" language="yaml"')
    expect(prompt).toContain('<file path="module/build/CMakeLists.txt" language="cmake"')
    expect(prompt).not.toContain("generated_out")
    expect(prompt).not.toContain("ignored: true")
    expect(prompt).not.toContain("[binary file skipped]")
    expect(contextSummary).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "module/build/check.sh", source: "mentioned folder", skipped: false }),
      expect.objectContaining({ path: "module/build/config.yml", source: "mentioned folder", skipped: false }),
      expect.objectContaining({ path: "module/build/tool.py", source: "mentioned folder", skipped: false }),
      expect.objectContaining({ path: "module/include/driver.h", source: "mentioned folder", skipped: false }),
    ]))
    expect(contextSummary.some((item) => item.path.includes("/out/") || item.path.includes("/dist/"))).toBe(false)
  })

  test("limits recursive folder context by the existing maxFiles budget", async () => {
    const encoder = new TextEncoder()
    fileBytes.set("/repo/budget/a.c", encoder.encode("int a(void) { return 1; }\n"))
    fileBytes.set("/repo/budget/b.c", encoder.encode("int b(void) { return 2; }\n"))
    fileBytes.set("/repo/budget/c.c", encoder.encode("int c(void) { return 3; }\n"))
    const contextSummary: Array<{ path: string; skipped: boolean }> = []
    const localSettings = settings()
    localSettings.context.localOnlyMode = false
    localSettings.context.maxFiles = 2

    const prompt = await buildChatPrompt({
      question: "分析这个目录",
      options: {
        includeSelection: false,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: localSettings,
      contextStore: new LocalContextStore(),
      mentionedContext: [{
        uri: UriShim.file("/repo/budget") as never,
        type: "folder",
        label: "budget",
        insertText: "budget/",
      }],
      onContextSummary: (items) => contextSummary.push(...items),
    })

    expect(prompt).toContain("int a")
    expect(prompt).toContain("int b")
    expect(prompt).not.toContain("int c")
    expect(contextSummary.map((item) => item.path)).toEqual(["budget/a.c", "budget/b.c"])
  })

  test("queries analysis evidence with the raw QA question and related workspace paths", async () => {
    const document = fakeDocument("ftl/bkm/ftl_bkm.c", "int ftl_bkm_init_free_mng(void) { return 0; }\n")
    textDocuments = [document]
    const calls: CapturedCodeGraphCalls = { build: [], query: [] }
    const question = "请解释 FTL BKM 模块的职责、入口和状态机"

    const prompt = await buildChatPrompt({
      question,
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithRagStatus(readyRagStatus(), calls),
    })

    expect(calls.query).toHaveLength(1)
    expect(calls.query[0]?.question).toBe(question)
    expect(calls.query[0]?.question).not.toContain("body-statement")
    expect(calls.build[0]).toMatchObject({
      question,
      retrievalMode: "hybrid",
      latencyBudgetMs: 2000,
    })
    expect(calls.query[0]?.options).toMatchObject({
      relatedPaths: ["ftl/bkm/ftl_bkm.c"],
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      retrievalMode: "hybrid",
      latencyBudgetMs: 2000,
    })
    expect(prompt).toContain("Local analysis evidence pack:")
    expect(prompt).toContain("ftl/bkm/ftl_bkm.c")
  })

  test("uses understanding planner evidence for non-fast-path broad code questions", async () => {
    const document = fakeDocument("src/gc.c", "void gc_collect(void) { scan_heap(); }\n")
    textDocuments = [document]
    const calls: CapturedCodeGraphCalls = { build: [], query: [] }
    const toolCalls: string[] = []
    const prompt = await buildChatPrompt({
      question: "提升 GC 速度的因素有哪些",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithPlannerTools(readyRagStatus(), calls, toolCalls),
      understandingPlanner: new UnderstandingPlanner({
        provider: async () => gcSpeedPlan(),
      }),
    })

    expect(prompt).toContain("Local understanding planner evidence:")
    expect(prompt).toContain("Question summary: 分析影响 GC 速度的代码因素")
    expect(prompt).toContain("type=module_map")
    expect(prompt).toContain("void gc_collect(void)")
    expect(prompt).toContain("Aggregated evidence factors:")
    expect(prompt).toContain("Call frequency and hot paths")
    expect(prompt).toContain("Configuration thresholds")
    expect(prompt).toContain("Tests and benchmarks")
    expect(prompt).toContain("Missing factor evidence:")
    expect(prompt).toContain("hypothesis=true")
    expect(prompt).toContain("Answer grounding rules:")
    expect(prompt).not.toContain("Local analysis evidence pack:")
    expect(calls.query.map((item) => item.question)).toContain("gc speed latency performance")
    expect(calls.query.map((item) => item.question)).not.toContain("提升 GC 速度的因素有哪些")
    expect(toolCalls).toContain("getModuleMap:gc")
    expect(toolCalls).toContain("getCallers:gc_collect")
    expect(toolCalls).toContain("getCallees:gc_collect")
  })

  test("passes previous understanding plan, trace, and confirmed concepts into follow-up planning", async () => {
    const document = fakeDocument("src/gc.c", "void gc_collect(void) { scan_heap(); }\n")
    textDocuments = [document]
    const first = await buildChatPromptWithEvidence({
      question: "提升 GC 速度的因素有哪些",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithPlannerTools(readyRagStatus(), { build: [], query: [] }, []),
      understandingPlanner: new UnderstandingPlanner({
        provider: async () => gcSpeedPlan(),
      }),
    })

    const providerInputs: unknown[] = []
    await buildChatPrompt({
      question: "那配置阈值这一块继续展开",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithPlannerTools(readyRagStatus(), { build: [], query: [] }, []),
      previousUnderstanding: {
        plan: first.understandingPlannerAudit?.result.kind === "planned" ? first.understandingPlannerAudit.result.plan : undefined,
        trace: first.understandingPlannerAudit?.execution?.trace ?? first.understandingPlannerAudit?.result.trace,
        confirmedConcepts: first.understandingPlannerAudit?.result.kind === "planned" ? first.understandingPlannerAudit.result.plan.concepts : [],
        previousEvidenceRefs: first.understandingPlannerAudit?.aggregation?.factors.flatMap((factor) => factor.supportingEvidence),
        previousGaps: first.understandingPlannerAudit?.aggregation?.gaps,
        previousClaims: first.understandingPlannerAudit?.aggregation?.claims,
      },
      understandingPlanner: new UnderstandingPlanner({
        provider: async (input) => {
          providerInputs.push(input)
          return gcSpeedPlan()
        },
      }),
    })

    expect(providerInputs).toHaveLength(1)
    expect(providerInputs[0]).toMatchObject({
      previousPlan: expect.objectContaining({ questionSummary: "分析影响 GC 速度的代码因素" }),
      previousTrace: expect.objectContaining({ planner_used: true }),
      confirmedConcepts: ["GC", "speed", "latency"],
      previousEvidenceRefs: expect.any(Array),
      previousGaps: expect.any(Array),
      previousClaims: expect.any(Array),
    })
  })

  test("keeps explicit graph fast-path questions on existing analysis retrieval", async () => {
    const document = fakeDocument("src/gc.c", "void gc_collect(void) {}\n")
    textDocuments = [document]
    const calls: CapturedCodeGraphCalls = { build: [], query: [] }
    const prompt = await buildChatPrompt({
      question: "谁调用了 gc_collect",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithRagStatus(readyRagStatus(), calls),
      understandingPlanner: new UnderstandingPlanner({
        provider: async () => {
          throw new Error("provider should not run for fast path")
        },
      }),
    })

    expect(prompt).toContain("Local analysis evidence pack:")
    expect(prompt).toContain("planner_used=false fast_path_reason=callers")
    expect(calls.query.map((item) => item.question)).toEqual(["谁调用了 gc_collect"])
  })

  test("falls back to existing analysis retrieval when planner fails", async () => {
    const document = fakeDocument("src/gc.c", "void gc_collect(void) {}\n")
    textDocuments = [document]
    const calls: CapturedCodeGraphCalls = { build: [], query: [] }
    const prompt = await buildChatPrompt({
      question: "提升 GC 速度的因素有哪些",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: codeGraphWithRagStatus(readyRagStatus(), calls),
      understandingPlanner: new UnderstandingPlanner({
        provider: async () => ({ tasks: [] }),
      }),
    })

    expect(prompt).toContain("fallback_reason=planner-missing-questionSummary")
    expect(prompt).toContain("Local analysis evidence pack:")
    expect(calls.query.map((item) => item.question)).toEqual(["提升 GC 速度的因素有哪些"])
  })

  test("uses graph-only retrieval while RAG is indexing", async () => {
    const calls = await buildPromptWithRagStatus({ availability: "indexing", indexAvailability: "partial", embeddedChunks: 12, pendingChunkCount: 8 })

    expect(calls.build[0]).toMatchObject({ retrievalMode: "graph-only" })
    expect(calls.build[0]?.latencyBudgetMs).toBeUndefined()
    expect(calls.query[0]?.options).toMatchObject({ retrievalMode: "graph-only" })
    expect(calls.query[0]?.options?.latencyBudgetMs).toBeUndefined()
  })

  test("does not use hybrid retrieval for incomplete RAG states", async () => {
    const cases: Array<{ availability: RagAvailability; indexAvailability: RagStatus["indexAvailability"] }> = [
      { availability: "partial", indexAvailability: "partial" },
      { availability: "paused", indexAvailability: "paused" },
      { availability: "unavailable", indexAvailability: "none" },
      { availability: "not-indexed", indexAvailability: "none" },
      { availability: "checking", indexAvailability: "none" },
    ]

    for (const item of cases) {
      const calls = await buildPromptWithRagStatus({
        availability: item.availability,
        indexAvailability: item.indexAvailability,
        embeddedChunks: item.availability === "partial" ? 8 : 0,
        pendingChunkCount: item.availability === "partial" ? 2 : 10,
      })
      expect(calls.build[0]?.retrievalMode).toBe("graph-only")
      expect(calls.query[0]?.options?.retrievalMode).toBe("graph-only")
    }
  })

  test("allows hybrid retrieval only when RAG is complete and ready", async () => {
    const calls = await buildPromptWithRagStatus(readyRagStatus())

    expect(calls.build[0]).toMatchObject({ retrievalMode: "hybrid", latencyBudgetMs: 2000 })
    expect(calls.query[0]?.options).toMatchObject({ retrievalMode: "hybrid", latencyBudgetMs: 2000 })
  })

  test("includes document RAG evidence while the document index is partial", async () => {
    const localSettings = settings()
    localSettings.documentRag.enabled = true
    const query = mock(async () => ({
      text: '<local-document-rag documents="3/4" chunks="9/9" evidenceCount="1"><evidence-list><evidence kind="pdf" path="docs/spec.pdf" lines="4-6" section="pdf:1" score="0.991">upgrade flow</evidence></evidence-list></local-document-rag>',
      hits: [{ path: "docs/spec.pdf", startLine: 4, endLine: 6, score: 0.991 }],
      elapsedMs: 8,
    }))

    const prompt = await buildChatPrompt({
      question: "文档里有没有 upgrade flow",
      options: {
        includeSelection: false,
        includeCurrentFile: false,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: localSettings,
      contextStore: new LocalContextStore(),
      documentRag: {
        status: () => ({
          enabled: true,
          availability: "partial",
          documentCount: 4,
          indexedDocuments: 3,
          skippedDocuments: 1,
          pendingDocuments: 0,
          chunks: 9,
          embeddedChunks: 9,
        }),
        query,
      },
    })

    expect(query).toHaveBeenCalledWith("文档里有没有 upgrade flow", expect.objectContaining({
      topK: localSettings.documentRag.queryTopK,
      maxEvidenceBytes: localSettings.documentRag.maxEvidenceBytes,
    }))
    expect(prompt).toContain("Local document RAG evidence:")
    expect(prompt).toContain('path="docs/spec.pdf"')
    expect(prompt).toContain("upgrade flow")
  })

  test("returns compact evidence ledger separately from full prompt evidence", async () => {
    const document = fakeDocument("src/main.c", "int secret_file_body(void) { return 7; }\n")
    textDocuments = [document]
    const localSettings = settings()
    localSettings.documentRag.enabled = true

    const result = await buildChatPromptWithEvidence({
      question: "解释 main flow",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: localSettings,
      contextStore: new LocalContextStore(),
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 0, character: 0 } as never,
      },
      codeGraph: {
        ...codeGraphWithRagStatus(readyRagStatus(), { build: [], query: [] }),
        buildContext: async () => ({
          text: '<local-code-graph><evidence path="src/main.c">secret graph evidence</evidence></local-code-graph>',
          mode: "symbol" as never,
          symbols: ["secret_file_body"],
          truncated: false,
          metrics: {
            mode: "symbol" as never,
            tokens: [],
            symbols: ["secret_file_body"],
            candidateCount: 1,
            evidenceCount: 1,
            omittedCandidates: 0,
            packedBytes: 96,
            truncated: false,
            elapsedMs: 3,
          },
        }),
      },
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
          text: '<local-document-rag><evidence path="docs/spec.pdf">secret document evidence</evidence></local-document-rag>',
          hits: [{ path: "docs/spec.pdf", startLine: 4, endLine: 6, score: 0.9 }],
          elapsedMs: 2,
        }),
      },
    })

    expect(result.prompt).toContain("secret_file_body")
    expect(result.prompt).toContain("secret graph evidence")
    expect(result.prompt).toContain("secret document evidence")
    expect(result.contextSummary).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/main.c", skipped: false }),
    ]))
    expect(result.evidenceLedgerInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "local-context", kind: "file", path: "src/main.c", staleness: "current" }),
      expect.objectContaining({ source: "codegraph", kind: "codegraph", query: "解释 main flow", staleness: "current" }),
      expect.objectContaining({ source: "document-rag", kind: "document", path: "docs/spec.pdf", range: "4-6", staleness: "current" }),
    ]))
    const ledgerText = JSON.stringify(result.evidenceLedgerInput)
    expect(ledgerText).not.toContain("return 7")
    expect(ledgerText).not.toContain("secret graph evidence")
    expect(ledgerText).not.toContain("secret document evidence")
  })

  test("packs explicit attached selection before automatic current-file context", async () => {
    const document = fakeDocument("hw/char/char-hmp-cmds.c", "int before(void) { return 0; }\nselected_call();\nint after(void) { return 1; }\n")
    textDocuments = [document]
    const store = new LocalContextStore()
    store.addSelection({
      uri: document.uri as never,
      languageId: "c",
      startLine: 2,
      endLine: 2,
      text: "selected_call();",
      truncated: false,
    })

    const prompt = await buildChatPrompt({
      question: "解释选中的代码",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: store,
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 1, character: 0 } as never,
      },
    })

    expect(prompt).toContain('source="attached selection"')
    expect(prompt).toContain('lines="2-2"')
    expect(prompt).toContain("selected_call();")
    expect(prompt).not.toContain('source="current file"')
  })

  test("keeps one-shot selection snapshots available for the accepted send", async () => {
    const document = fakeDocument("src/once.c", "void once(void) {\n  selected_once();\n}\n")
    textDocuments = [document]
    const store = new LocalContextStore()
    const item = store.addSelection({
      uri: document.uri as never,
      languageId: "c",
      startLine: 2,
      endLine: 2,
      text: "selected_once();",
      truncated: false,
    })
    const snapshot = store.snapshot()

    expect(item.lifetime).toBe("one-shot")
    expect(store.consumeOneShot(snapshot)).toBe(1)
    expect(store.list()).toHaveLength(0)

    const prompt = await buildChatPrompt({
      question: "解释这段一次性上下文",
      options: {
        includeSelection: false,
        includeCurrentFile: true,
        includeOpenFiles: false,
        includeDiagnostics: false,
        includeGitDiff: false,
      },
      settings: settings(),
      contextStore: store,
      contextItems: snapshot,
      editorContext: {
        uri: document.uri as never,
        selection: { isEmpty: true } as never,
        position: { line: 1, character: 0 } as never,
      },
    })

    expect(prompt).toContain('source="attached selection"')
    expect(prompt).toContain("selected_once();")
    expect(prompt).not.toContain('source="current file"')
  })

  test("keeps pinned context when one-shot context is consumed", () => {
    const store = new LocalContextStore()
    const oneShot = store.addFile(UriShim.file("/repo/src/one-shot.c") as never)
    const pinned = store.addFile(UriShim.file("/repo/src/pinned.c") as never)
    store.setLifetime(pinned.id, "persistent")

    expect(oneShot.lifetime).toBe("one-shot")
    expect(store.viewItems().find((item) => item.id === pinned.id)?.lifetime).toBe("persistent")
    expect(store.consumeOneShot(store.snapshot())).toBe(1)
    expect(store.list().map((item) => item.id)).toEqual([pinned.id])
  })
})

type CapturedCodeGraphCalls = {
  build: Array<Parameters<CodeGraphContextProvider["buildContext"]>[0]>
  query: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }>
}

async function buildPromptWithRagStatus(rag: Partial<RagStatus>) {
  const document = fakeDocument("ftl/bkm/ftl_bkm.c", "int ftl_bkm_init_free_mng(void) { return 0; }\n")
  textDocuments = [document]
  const calls: CapturedCodeGraphCalls = { build: [], query: [] }
  await buildChatPrompt({
    question: "请解释 FTL BKM 模块",
    options: {
      includeSelection: false,
      includeCurrentFile: true,
      includeOpenFiles: false,
      includeDiagnostics: false,
      includeGitDiff: false,
    },
    settings: settings(),
    contextStore: new LocalContextStore(),
    editorContext: {
      uri: document.uri as never,
      selection: { isEmpty: true } as never,
      position: { line: 0, character: 0 } as never,
    },
    codeGraph: codeGraphWithRagStatus(rag, calls),
  })
  return calls
}

function codeGraphWithRagStatus(rag: Partial<RagStatus>, calls: CapturedCodeGraphCalls): CodeGraphContextProvider {
  return {
    status: () => codeGraphStatus(rag),
    buildContext: async (input) => {
      calls.build.push(input)
      return undefined
    },
    queryEvidence: async (question, options) => {
      calls.query.push({ question, options })
      return queryEvidenceResult(question)
    },
  } as CodeGraphContextProvider
}

function codeGraphWithPlannerTools(rag: Partial<RagStatus>, calls: CapturedCodeGraphCalls, toolCalls: string[]): CodeGraphContextProvider {
  return {
    ...codeGraphWithRagStatus(rag, calls),
    findSymbols: async (input) => {
      toolCalls.push(`findSymbols:${input.query}`)
      return [
        {
          name: input.query,
          kind: "function",
          path: "src/gc.c",
          startLine: 1,
          endLine: 1,
          signature: "void gc_collect(void)",
          snippet: "void gc_collect(void) {}",
          score: 1,
          reason: "test",
        },
      ]
    },
    runAnalysisTool: async (input) => {
      toolCalls.push(`${input.tool}:${input.args?.query ?? input.args?.symbol ?? ""}`)
      return {
        ok: true,
        traceId: `trace-${input.tool}`,
        tool: input.tool,
        elapsedMs: 1,
        data: {},
        evidence: [{
          file: "src/gc.c",
          startLine: 1,
          endLine: 1,
          snippetHash: `hash-${input.tool}`,
          parserKind: "test",
          snippet: "void gc_collect(void) {}",
        }],
        audit: {
          traceId: `trace-${input.tool}`,
          tool: input.tool,
          argsSummary: "",
          evidenceCount: 1,
          elapsedMs: 1,
          blocked: false,
        },
      }
    },
  } as CodeGraphContextProvider
}

function gcSpeedPlan() {
  return {
    questionSummary: "分析影响 GC 速度的代码因素",
    concepts: ["GC", "speed", "latency"],
    hypotheses: ["scan scope", "lock contention", "batch size"],
    tasks: [
      { type: "semantic_search", query: "gc speed latency performance" },
      { type: "symbol_discovery", query: "gc" },
      { type: "module_map", query: "gc" },
      { type: "config_search", query: "gc threshold batch interval" },
      { type: "test_search", query: "gc performance benchmark" },
      { type: "call_expansion", query: "gc", symbol: "gc_collect", direction: "both" },
    ],
    answerShape: "factor_grouped",
    riskNotes: ["Evidence can suggest factors but cannot prove runtime impact without measurement."],
  }
}

function codeGraphStatus(rag: Partial<RagStatus>): CodeGraphStatus {
  return {
    state: "ready",
    detail: "ready",
    enabled: true,
    indexedFiles: 1,
    indexedFunctions: 1,
    indexedMacros: 0,
    truncated: false,
    rag: {
      ...readyRagStatus(),
      ...rag,
    },
  }
}

function readyRagStatus(): RagStatus {
  return {
    enabled: true,
    availability: "ready",
    indexAvailability: "ready",
    embeddingEnabled: true,
    rerankEnabled: true,
    endpointKind: "localhost",
    chunks: 10,
    embeddedChunks: 10,
    indexedChunkCount: 10,
    pendingChunkCount: 0,
    vectorShards: 1,
  }
}

function fakeDocument(path: string, text: string): FakeDocument {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  return {
    uri: UriShim.file(`/repo/${path}`),
    languageId: "c",
    lineCount: lines.length,
    getText: (range?: RangeShim) => {
      if (!range) return text
      return lines.slice(range.start.line, range.end.line + 1).join("\n")
    },
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  }
}

function queryEvidenceResult(question: string): QueryEvidenceResult {
  return {
    stateMachines: [],
    summaries: {
      functions: [],
      files: [],
      modules: [],
      subsystems: [],
    },
    evidencePack: {
      evidence: [],
      text: '<evidence path="ftl/bkm/ftl_bkm.c" lines="1-1" parser="function" hash="sha256:test">int ftl_bkm_init_free_mng(void) { return 0; }</evidence>',
      packedBytes: 120,
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: "qa-test",
      question,
      intent: "module-flow",
      steps: [{ label: "retrieval", detail: "1 evidence item(s)", elapsedMs: 0 }],
      evidence: [],
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: "high",
      reason: "Evidence is available for a grounded answer.",
      requiredCitation: "Cite file:start-end for each concrete claim.",
    },
    suggestedAnswer: "Use the cited QA evidence.",
  }
}

function settings(): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: "http://127.0.0.1/v1",
      chatModel: "chat-model",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
    },
    serverUrl: "http://127.0.0.1/v1",
    username: "chipmate",
    defaultModel: "chat-model",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: false,
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
      enabled: false,
      providerMode: "inherit-chat",
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: "http://127.0.0.1/v1",
      model: "",
      maxTokens: 128,
      contextLength: 200000,
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
      enabled: false,
      maxFiles: 5000,
      maxFileBytes: 25 * 1024 * 1024,
      maxExtractedBytesPerFile: 1024 * 1024,
      maxChunks: 50000,
      excludeGlobs: [],
      queryTopK: 12,
      maxEvidenceBytes: 24000,
      workerConcurrency: 2,
    },
  }
}
