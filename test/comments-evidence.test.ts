import { describe, expect, test } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import { CommentEvidenceService } from "../src/comments/commentEvidenceService"
import type { CommentGenerationContext } from "../src/comments/commentTypes"

describe("AI comment evidence service", () => {
  test("uses graph-only evidence when RAG is not ready", async () => {
    const calls: string[] = []
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus({ availability: "indexing", indexAvailability: "partial", embeddedChunks: 2, pendingChunkCount: 3 }) }),
        queryEvidence: async (_question, options) => {
          calls.push(options?.retrievalMode ?? "none")
          return evidenceResult("graph", [{ file: "src/fw/main.c", startLine: 11, endLine: 13, snippet: "process_queue(owner);" }], {
            functionName: "process_queue",
          })
        },
      },
    })

    const result = await service.collect(commentContextStub())

    expect(calls).toEqual(["graph-only"])
    expect(result).toMatchObject({
      ok: true,
      retrievalMode: "graph-only",
      evidenceItemCount: 1,
      evidenceSummaryBytes: expect.any(Number),
      fallbackReason: "rag-not-ready",
      graphSummaryFunctionCount: 1,
      graphSummaryModuleCount: 1,
      graphSummaryStateMachineCount: 0,
      graphDirectRefCount: 1,
      ragRefCount: 0,
      identifierCount: expect.any(Number),
      anchorCount: expect.any(Number),
    })
    if (result.ok) {
      expect(result.evidenceSections.graphRepoSummary).toContain("process_queue")
      expect(result.evidenceSummary).toContain("CodeGraph 仓库摘要:")
      expect(result.evidenceSummary).not.toContain("RAG 语义摘要:\n未打包独立的 hybrid 证据引用。")
    }
  })

  test("runs graph-first then hybrid when RAG is ready", async () => {
    const calls: string[] = []
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus() }),
        queryEvidence: async (_question, options) => {
          calls.push(options?.retrievalMode ?? "none")
          if (options?.retrievalMode === "graph-only") {
            return evidenceResult("graph", [{ file: "src/fw/main.c", startLine: 11, endLine: 13, snippet: "process_queue(owner);" }], {
              functionName: "process_queue",
            })
          }
          return evidenceResult("hybrid", [{ file: "src/fw/helpers.c", startLine: 40, endLine: 45, snippet: "queue_owner_release(owner);" }], {
            functionName: "queue_owner_release",
            moduleName: "helpers",
          })
        },
      },
    })

    const result = await service.collect(commentContextStub())

    expect(calls).toEqual(["graph-only", "hybrid"])
    expect(result).toMatchObject({
      ok: true,
      retrievalMode: "hybrid",
      evidenceItemCount: 2,
      graphDirectRefCount: 1,
      ragRefCount: 1,
    })
    if (result.ok) {
      expect(result.evidenceSummary).toContain("CodeGraph 仓库摘要:")
      expect(result.evidenceSummary).toContain("RAG 语义摘要:")
      expect(result.evidenceSections.ragSummary).toContain("queue_owner_release")
      expect(result.outputDirective).toBe("encourage-1-3")
    }
  })

  test("does not continue when graph evidence is empty", async () => {
    const calls: string[] = []
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus() }),
        queryEvidence: async (_question, options) => {
          calls.push(options?.retrievalMode ?? "none")
          return evidenceResult("graph", [])
        },
      },
    })

    const result = await service.collect(commentContextStub())

    expect(calls).toEqual(["graph-only"])
    expect(result).toMatchObject({
      ok: false,
      reason: "no-graph-evidence",
      message: "没有找到可支撑当前选区注释的仓库证据。请调整选区，或等待索引完成后重试。",
      graphElapsedMs: expect.any(Number),
      fallbackReason: "graph-empty",
      graphDirectRefCount: 0,
      graphSummaryFunctionCount: 1,
      graphSummaryModuleCount: 1,
      graphSummaryStateMachineCount: 0,
      ragRefCount: 0,
      missingEvidenceCount: 0,
      identifierCount: expect.any(Number),
      anchorCount: expect.any(Number),
    })
  })

  test("falls back to graph-only when hybrid retrieval fails", async () => {
    const calls: string[] = []
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus() }),
        queryEvidence: async (_question, options) => {
          calls.push(options?.retrievalMode ?? "none")
          if (options?.retrievalMode === "graph-only") {
            return evidenceResult("graph", [{ file: "src/fw/main.c", startLine: 11, endLine: 13, snippet: "process_queue(owner);" }])
          }
          throw new Error("rerank timeout")
        },
      },
    })

    const result = await service.collect(commentContextStub())

    expect(calls).toEqual(["graph-only", "hybrid"])
    expect(result).toMatchObject({
      ok: true,
      retrievalMode: "graph-only",
      evidenceItemCount: 1,
      evidenceSummaryBytes: expect.any(Number),
      fallbackReason: "hybrid-failed:rerank timeout",
    })
  })

  test("keeps repo-level graph summary but prefers selection-relevant summaries", async () => {
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus({ availability: "indexing", indexAvailability: "partial", embeddedChunks: 2, pendingChunkCount: 3 }) }),
        queryEvidence: async () =>
          evidenceResult("graph", [{ file: "src/fw/main.c", startLine: 11, endLine: 13, snippet: "process_queue(owner);" }], {
            functionName: "process_queue",
            extraFunctions: [
              {
                id: "irrelevant-helper-id",
                name: "unrelated_helper",
                path: "src/other/unrelated.c",
                module: "other",
                signature: "void unrelated_helper(void)",
                summary: "unrelated helper manages another subsystem.",
                inputs: [],
                outputs: [],
                calls: [],
                stateMachines: [],
                risks: [],
                evidence: [],
                confidence: 0.5,
              },
            ],
          }),
      },
    })

    const result = await service.collect(commentContextStub())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidenceSections.graphRepoSummary).toContain("process_queue")
      expect(result.evidenceSections.graphRepoSummary).not.toContain("unrelated_helper")
    }
  })

  test("compacts graph-only evidence into bounded summaries and neutral grounding text", async () => {
    const service = new CommentEvidenceService({
      getSettings: () => settingsStub(),
      codeGraph: {
        status: () => codeGraphStatus({ rag: ragStatus({ availability: "indexing", indexAvailability: "partial", embeddedChunks: 2, pendingChunkCount: 3 }) }),
        queryEvidence: async () =>
          evidenceResult("graph", [
            { file: "src/fw/main.c", startLine: 11, endLine: 13, snippet: "process_queue(owner);" },
            { file: "src/fw/main.c", startLine: 14, endLine: 16, snippet: "owner->state = RUNNING;" },
            { file: "src/fw/main.c", startLine: 17, endLine: 19, snippet: "rollback_owner(owner);" },
            { file: "src/fw/main.c", startLine: 20, endLine: 22, snippet: "sync_dma(owner);" },
            { file: "src/fw/main.c", startLine: 23, endLine: 25, snippet: "notify_owner(owner);" },
          ], {
            functionName: "process_queue",
            extraFunctions: [
              functionSummaryStub("rollback_owner", "src/fw/main.c", "fw"),
              functionSummaryStub("sync_dma", "src/fw/main.c", "fw"),
            ],
            extraModules: [
              moduleSummaryStub("helpers", "helpers coordinate recovery."),
            ],
            extraStateMachines: [
              stateMachineStub("owner_fsm", "fw"),
              stateMachineStub("secondary_fsm", "fw"),
            ],
            answerPolicyReason: "Evidence was packed under budget and some candidates were omitted.",
          }),
      },
    })

    const result = await service.collect(commentContextStub())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outputDirective).toBe("encourage-1-3")
      expect(result.groundingConfidence).toBe("high")
      expect(result.evidenceCompacted).toBe(true)
      expect(result.groundingSummary).not.toContain("packed under budget")
      expect((result.evidenceSections.graphRepoSummary.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(4)
      expect((result.evidenceSections.graphDirectRefs.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(4)
    }
  })
})

function commentContextStub(): CommentGenerationContext {
  return {
    uri: "file:///repo/src/fw/main.c",
    filePath: "/repo/src/fw/main.c",
    workspacePath: "src/fw/main.c",
    languageId: "c",
    documentVersion: 1,
    selectionStartLine: 10,
    selectionEndLine: 14,
    selectionStartCharacter: 0,
    selectionEndCharacter: 22,
    selectionTextEndLine: 14,
    selectionTextEndCharacter: 22,
    selectedCode: [
      "if (owner->state == READY) {",
      "    process_queue(owner);",
      "}",
    ].join("\n"),
    contextBefore: "void run_owner(owner_t *owner) {",
    contextAfter: "owner->state = RUNNING;",
    existingCommentExamples: "// Existing style",
    retrievalMode: "graph-only",
    outputDirective: "allow-empty",
    groundingConfidence: "none",
    groundingSummary: "",
    evidenceCompacted: false,
    evidenceSections: {
      selectionAnchors: "",
      graphRepoSummary: "",
      graphDirectRefs: "",
      ragSummary: "",
      groundingSummary: "",
    },
    evidenceSummary: "",
    evidenceItemCount: 0,
    allowedInsertionAnchors: [],
    selectionIntent: "localBlock",
    proposalBudget: 3,
    primaryAnchorPolicy: "allow-when-useful",
    internalAnchorLines: [],
    contextHash: "hash",
  }
}

function settingsStub() {
  return {
    codeGraph: { enabled: true },
    analysis: {
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
    },
  } as never
}

function codeGraphStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: "ready",
    detail: "",
    enabled: true,
    indexedFiles: 12,
    indexedFunctions: 30,
    indexedMacros: 5,
    truncated: false,
    rag: ragStatus(),
    ...overrides,
  } as never
}

function ragStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    availability: "ready",
    indexAvailability: "ready",
    embeddingEnabled: true,
    rerankEnabled: true,
    endpointKind: "approved-host",
    chunks: 5,
    embeddedChunks: 5,
    pendingChunkCount: 0,
    vectorShards: 1,
    ...overrides,
  } as never
}

function evidenceResult(
  label: string,
  refs: Array<{ file: string; startLine: number; endLine: number; snippet?: string }>,
  overrides: {
    functionName?: string
    moduleName?: string
    extraFunctions?: QueryEvidenceResult["summaries"]["functions"]
    extraModules?: QueryEvidenceResult["summaries"]["modules"]
    extraStateMachines?: QueryEvidenceResult["stateMachines"]
    answerPolicyReason?: string
    answerPolicyConfidence?: "high" | "medium" | "low" | "none"
  } = {},
): QueryEvidenceResult {
  const moduleName = overrides.moduleName ?? "fw"
  const functionName = overrides.functionName ?? `${label}_helper`
  return {
    retrieval: undefined,
    stateMachines: overrides.extraStateMachines ?? [],
    summaries: {
      functions: [
        functionSummaryStub(functionName, refs[0]?.file ?? "src/fw/main.c", moduleName),
        ...(overrides.extraFunctions ?? []),
      ],
      files: [],
      modules: [
        moduleSummaryStub(moduleName, `${moduleName} manages queue state and ownership.`),
        ...(overrides.extraModules ?? []),
      ],
      subsystems: [],
    },
    evidencePack: {
      evidence: refs.map((ref, index) => ({
        file: ref.file,
        startLine: ref.startLine,
        endLine: ref.endLine,
        snippetHash: `${label}-${index}`,
        parserKind: "codegraph:function",
        snippet: ref.snippet,
      })),
      text: "",
      packedBytes: 0,
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: `${label}-trace`,
      question: `${label} question`,
      intent: "module-flow",
      steps: [],
      evidence: [],
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: overrides.answerPolicyConfidence ?? "high",
      reason: overrides.answerPolicyReason ?? "grounded",
      requiredCitation: "",
    },
    suggestedAnswer: `${label} answer`,
  }
}

function functionSummaryStub(name: string, path: string, module: string): QueryEvidenceResult["summaries"]["functions"][number] {
  return {
    id: `${name}-id`,
    name,
    path,
    module,
    signature: `void ${name}(void)`,
    summary: `${name} coordinates queue ownership.`,
    inputs: [],
    outputs: [],
    calls: [],
    stateMachines: [],
    risks: [],
    evidence: [],
    confidence: 0.9,
  }
}

function moduleSummaryStub(module: string, summary: string): QueryEvidenceResult["summaries"]["modules"][number] {
  return {
    module,
    summary,
    responsibilities: [],
    submodules: [],
    keyFlows: [],
    entrypoints: [],
    dependencies: [],
    stateMachines: [],
    evidence: [],
    confidence: 0.9,
  }
}

function stateMachineStub(name: string, module: string): QueryEvidenceResult["stateMachines"][number] {
  return {
    id: `${name}-id`,
    name,
    module,
    rootSymbols: [],
    stateVar: `${name}_state`,
    language: "c",
    confidence: 0.84,
    states: [],
    transitions: [],
    candidateTransitions: [],
    paths: [],
    query: {
      reachable: [],
      deadStates: [],
      cycles: [],
      errorPaths: [],
    },
    evidence: [],
    metrics: [],
    mermaid: "",
    dot: "",
  }
}
