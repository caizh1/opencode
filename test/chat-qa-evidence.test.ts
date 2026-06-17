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
  Uri: UriShim,
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
    asRelativePath: (uri: UriShim) => {
      const root = workspaceFolders[0]?.uri.fsPath
      return root && uri.fsPath.startsWith(`${root}/`) ? uri.fsPath.slice(root.length + 1) : uri.fsPath
    },
    openTextDocument: async (uri: UriShim) => textDocuments.find((document) => document.uri.toString() === uri.toString()),
    fs: {
      readFile: async (uri: UriShim) => fileBytes.get(uri.fsPath) ?? new Uint8Array(),
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

const { buildChatPrompt, LocalContextStore } = await import("../src/context")

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
    },
    permissions: {
      mode: "full-access",
    },
    tools: {
      enabled: false,
    },
    skills: {
      enabled: [],
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: false,
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: "http://127.0.0.1/v1",
      model: "",
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
  }
}
