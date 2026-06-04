import { describe, expect, test } from "bun:test"
import { routeCompletionModel } from "../src/completion-router"
import { planCompletion } from "../src/completion-plan"
import type { RetrievedCompletionSnippet } from "../src/completion-types"
import type { RemoteSettings } from "../src/types"

describe("completion model router", () => {
  test("routes ordinary code to Qwen Coder FIM with a low token budget", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "typescript",
        linePrefix: "const value = ",
        lineSuffix: "",
      }),
      settings: settings({ maxTokens: 512, temperature: 0.8, profile: "generic-chat" }),
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "ordinary-code",
      promptKind: "qwen-fim",
      modelProfile: "qwen-coder-fim",
      textProfile: "qwen-coder-fim",
      maxTokens: 256,
      temperature: 0.2,
    })
  })

  test("routes comment-to-test prompts to instruction mode without FIM", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
        lineSuffix: "",
      }),
      settings: settings({ profile: "qwen-coder-fim" }),
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "instruction-task",
      promptKind: "instruction",
      modelProfile: "generic-chat",
      textProfile: "generic-chat",
      maxTokens: 768,
    })
  })

  test("routes natural language unit-test commands to instruction mode without FIM", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "unit test for epr_ppn_raw_wr",
        lineSuffix: "",
      }),
      settings: settings({ profile: "qwen-coder-fim" }),
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "instruction-task",
      promptKind: "instruction",
      modelProfile: "generic-chat",
      textProfile: "generic-chat",
      maxTokens: 768,
    })
  })

  test("returns high-confidence symbol completions without calling a model", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "  epr_ppn_raw_wr",
        lineSuffix: "",
        currentWord: "epr_ppn_raw_wr",
      }),
      settings: settings(),
      retrievedSnippets: [
        snippet("epr_ppn_raw_write_with_cb_dfx", 9500),
      ],
    })

    expect(route).toEqual({
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: "epr_ppn_raw_write_with_cb_dfx",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("uses a small FIM assist route for low-confidence symbol completions", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "  epr_ppn_raw_wr",
        lineSuffix: "(",
        currentWord: "epr_ppn_raw_wr",
      }),
      settings: settings({ maxTokens: 512 }),
      retrievedSnippets: [
        snippet("epr_ppn_raw_write_with_cb_dfx", 50),
      ],
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "symbol-assist",
      promptKind: "qwen-fim",
      modelProfile: "qwen-coder-fim",
      textProfile: "qwen-coder-fim",
      maxTokens: 64,
      temperature: 0,
    })
  })
})

function snippet(name: string, score: number): RetrievedCompletionSnippet {
  return {
    kind: "function",
    path: "src/epr/epr_ppn_raw.c",
    line: 10,
    text: `int ${name}(void);`,
    name,
    score,
  }
}

function settings(input: Partial<RemoteSettings["completion"]> = {}): RemoteSettings {
  return {
    serverUrl: "http://localhost:4096",
    username: "opencode",
    defaultModel: "",
    defaultAgent: "",
    localOnlyAgent: "vscode-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible",
      profile: "generic-chat",
      apiBaseUrl: "http://localhost:8000/v1",
      model: "qwen",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      debounceMs: 350,
      logLevel: "info",
      ...input,
    },
    codeGraph: {
      enabled: false,
      promptOnWorkspaceOpen: true,
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
      bridgeEnabled: true,
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
        maxInFlightTokens: 180000,
        encodingFormat: "float",
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
