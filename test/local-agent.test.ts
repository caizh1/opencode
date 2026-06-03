import { describe, expect, test } from "bun:test"
import { MissingLocalOnlyAgentError, requireRequestAgent, selectRequestAgent } from "../src/local-agent"
import type { OpenCodeAgentInfo, RemoteSettings } from "../src/types"

describe("VS Code local agent selection", () => {
  test("requires vscode-local while local-only mode is active", () => {
    const selection = requireRequestAgent({
      settings: settings({ localOnlyMode: true }),
      agents: [{ id: "vscode-local", name: "VS Code Local", isLocalOnly: true }],
    })

    expect(selection).toMatchObject({
      agent: "vscode-local",
      strict: true,
      ready: true,
    })
  })

  test("accepts remote display names that normalize to vscode-local", () => {
    for (const agent of [
      { id: "Vscode-Local", name: "Vscode-Local" },
      { id: "agent-generated-name", name: "VS Code Local" },
    ]) {
      const selection = requireRequestAgent({
        settings: settings({ localOnlyMode: true }),
        agents: [agent],
      })

      expect(selection).toMatchObject({
        agent: "vscode-local",
        strict: true,
        ready: true,
      })
    }
  })

  test("fails closed when vscode-local is missing", () => {
    expect(() =>
      requireRequestAgent({
        settings: settings({ localOnlyMode: true }),
        agents: [{ id: "build", name: "Build" }],
      }),
    ).toThrow(MissingLocalOnlyAgentError)
  })

  test("includes returned remote agents in missing-agent warnings", () => {
    const selection = selectRequestAgent({
      settings: settings({ localOnlyMode: true }),
      agents: [{ id: "build", name: "Build Agent" }],
    })

    expect(selection.ready).toBe(false)
    expect(selection.warning).toContain("Remote agents: build (Build Agent).")
  })

  test("does not fall back to the default agent in local-only mode", () => {
    const selection = selectRequestAgent({
      settings: settings({ localOnlyMode: true, defaultAgent: "build" }),
      agents: [{ id: "vscode-local", name: "VS Code Local" }],
    })

    expect(selection.agent).toBe("vscode-local")
  })

  test("keeps default agent support when local-only mode is disabled", () => {
    const selection = requireRequestAgent({
      settings: settings({ localOnlyMode: false, defaultAgent: "build" }),
      agents: [] satisfies OpenCodeAgentInfo[],
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
    serverUrl: "http://localhost:4096",
    username: "opencode",
    defaultModel: "",
    defaultAgent: input.defaultAgent ?? "",
    localOnlyAgent: "vscode-local",
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
      provider: "opencode",
      profile: "generic-chat",
      apiBaseUrl: "",
      model: "",
      maxTokens: 128,
      temperature: 0.2,
      topP: 0.8,
      debounceMs: 350,
      logLevel: "info",
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
        timeoutMs: 30000,
        requestDelayMs: 500,
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
