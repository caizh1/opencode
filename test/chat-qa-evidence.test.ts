import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import type { CodeGraphEvidenceQueryOptions } from "../src/codegraph-types"
import type { RemoteSettings } from "../src/types"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []
let textDocuments: FakeDocument[] = []

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
      readFile: async () => new Uint8Array(),
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
})

describe("QA chat evidence retrieval", () => {
  test("queries analysis evidence with the raw QA question and related workspace paths", async () => {
    const document = fakeDocument("ftl/bkm/ftl_bkm.c", "int ftl_bkm_init_free_mng(void) { return 0; }\n")
    textDocuments = [document]
    const calls: Array<{ question: string; options?: CodeGraphEvidenceQueryOptions }> = []
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
      codeGraph: {
        buildContext: async () => undefined,
        queryEvidence: async (capturedQuestion: string, options?: CodeGraphEvidenceQueryOptions) => {
          calls.push({ question: capturedQuestion, options })
          return queryEvidenceResult(capturedQuestion)
        },
      } as never,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.question).toBe(question)
    expect(calls[0]?.question).not.toContain("body-statement")
    expect(calls[0]?.options).toMatchObject({
      relatedPaths: ["ftl/bkm/ftl_bkm.c"],
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
    })
    expect(prompt).toContain("Local analysis evidence pack:")
    expect(prompt).toContain("ftl/bkm/ftl_bkm.c")
  })
})

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
        batchSize: 128,
        maxTokensPerRequest: 65536,
        concurrentRequests: 3,
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
      vectorTopK: 24,
      rerankTopK: 16,
    },
  }
}
