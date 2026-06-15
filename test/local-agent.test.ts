import { describe, expect, test } from "bun:test"
import { MissingLocalOnlyAgentError, requireRequestAgent, selectRequestAgent } from "../src/local-agent"
import type { ChipMateAgentInfo, RemoteSettings } from "../src/types"

describe("ChipMate workspace agent selection", () => {
  test("requires chipmate-local while local-only mode is active", () => {
    const selection = requireRequestAgent({
      settings: settings({ localOnlyMode: true }),
      agents: [{ id: "chipmate-local", name: "ChipMate Local", isLocalOnly: true }],
    })

    expect(selection).toMatchObject({
      agent: "chipmate-local",
      strict: true,
      ready: true,
    })
  })

  test("accepts display names that normalize to chipmate-local", () => {
    for (const agent of [
      { id: "ChipMate-Local", name: "ChipMate-Local" },
      { id: "agent-generated-name", name: "ChipMate Local" },
    ]) {
      const selection = requireRequestAgent({
        settings: settings({ localOnlyMode: true }),
        agents: [agent],
      })

      expect(selection).toMatchObject({
        agent: "chipmate-local",
        strict: true,
        ready: true,
      })
    }
  })

  test("fails closed when chipmate-local is missing", () => {
    expect(() =>
      requireRequestAgent({
        settings: settings({ localOnlyMode: true }),
        agents: [{ id: "build", name: "Build" }],
      }),
    ).toThrow(MissingLocalOnlyAgentError)
  })

  test("includes returned available agents in missing-agent warnings", () => {
    const selection = selectRequestAgent({
      settings: settings({ localOnlyMode: true }),
      agents: [{ id: "build", name: "Build Agent" }],
    })

    expect(selection.ready).toBe(false)
    expect(selection.warning).toContain("Available agents: build (Build Agent).")
  })

  test("does not fall back to the default agent in local-only mode", () => {
    const selection = selectRequestAgent({
      settings: settings({ localOnlyMode: true, defaultAgent: "build" }),
      agents: [{ id: "chipmate-local", name: "ChipMate Local" }],
    })

    expect(selection.agent).toBe("chipmate-local")
  })

  test("keeps default agent support when local-only mode is disabled", () => {
    const selection = requireRequestAgent({
      settings: settings({ localOnlyMode: false, defaultAgent: "build" }),
      agents: [] satisfies ChipMateAgentInfo[],
    })

    expect(selection).toMatchObject({
      agent: "build",
      strict: false,
      ready: true,
    })
  })
})

function settings(input: { localOnlyMode: boolean; defaultAgent?: string }): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: "http://localhost:8000/v1",
      chatModel: "chat-model",
      maxTokens: 4096,
      temperature: 0.2,
      topP: 1,
    },
    serverUrl: "http://localhost:8000/v1",
    username: "chipmate",
    defaultModel: "",
    defaultAgent: input.defaultAgent ?? "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: input.localOnlyMode,
      strictLocalOnlyAgent: true,
    },
    completion: {
      enabled: false,
      provider: "openai-compatible",
      profile: "generic-chat",
      apiBaseUrl: "",
      model: "",
      maxTokens: 128,
      temperature: 0.2,
      topP: 0.8,
      debounceMs: 350,
      logLevel: "info",
      debugFullRetrievalProbe: false,
      debugExpectedSymbol: "",
      commentGuidedRetrievalMode: "qa-exact",
    },
    permissions: {
      mode: "ask",
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
      indexTests: false,
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
      indexTests: false,
      vectorTopK: 24,
      rerankTopK: 16,
    },
  }
}
