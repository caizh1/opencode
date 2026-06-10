import { describe, expect, test } from "bun:test"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel, routeLogValue, shouldRetryCompletionRejection } from "../src/completion-router"
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

  test("logs the effective direct FIM profile and endpoint for ordinary code", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    ret = ",
        lineSuffix: "",
      }),
      settings: settings({ provider: "openai-compatible", profile: "generic-chat" }),
    })

    expect(routeLogValue(route, settings({ provider: "openai-compatible", profile: "generic-chat" }))).toContain("configuredProfile=generic-chat")
    expect(routeLogValue(route, settings({ provider: "openai-compatible", profile: "generic-chat" }))).toContain("effectiveProfile=qwen-coder-fim")
    expect(routeLogValue(route, settings({ provider: "openai-compatible", profile: "generic-chat" }))).toContain("endpoint=/completions")
    expect(routeLogValue(route, settings({ provider: "openai-compatible", profile: "generic-chat" }))).toContain("promptKind=qwen-fim")
  })

  test("routes C/C++ top-level declarations to Qwen Coder FIM", () => {
    const lines = ["#include <stdint.h>", "", "typedef struct device device_t;"]
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "",
        lineSuffix: "",
        previousNonEmptyLine: lines[0],
        nextNonEmptyLine: lines[2],
        lines,
        line: 1,
        triggerKind: "automatic",
      }),
      settings: settings({ maxTokens: 512, temperature: 0.8, profile: "generic-chat" }),
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "ordinary-code",
      promptKind: "qwen-fim",
      modelProfile: "qwen-coder-fim",
      textProfile: "qwen-coder-fim",
      maxTokens: 128,
      temperature: 0.2,
    })
  })

  test("routes comment-guided C code to FIM prompt style using the configured direct profile", () => {
    const route = routeCompletionModel({
      plan: {
        kind: "comment-guided-c-code",
        insertMode: "insert-at-cursor",
        sourceComment: "// step2: wait nfc clock reset",
        cIntent: "body-statement",
        replaceCurrentWord: false,
        needsSymbolRetrieval: false,
        needsIntentRetrieval: true,
        needsTestRetrieval: false,
        useFim: true,
        useInstruction: false,
        maxTokens: 128,
        confidenceFloor: 0.35,
      },
      settings: settings({ provider: "openai-compatible", profile: "generic-chat", maxTokens: 512, temperature: 0.8 }),
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "comment-guided-c-code",
      promptKind: "qwen-fim",
      modelProfile: "generic-chat",
      textProfile: "generic-chat",
      maxTokens: 128,
      temperature: 0.2,
    })
    const log = routeLogValue(route, settings({ provider: "openai-compatible", profile: "generic-chat" }))
    expect(log).toContain("reason=comment-guided-c-code")
    expect(log).toContain("configuredProfile=generic-chat")
    expect(log).toContain("effectiveProfile=generic-chat")
    expect(log).toContain("promptKind=qwen-fim")
    expect(log).toContain("endpoint=/chat/completions")
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
      text: "ite_with_cb_dfx",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("routes broad C embedded symbol prefixes through FIM instead of deterministic symbol completion", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "  nf",
        lineSuffix: "",
        currentWord: "nf",
      }),
      settings: settings(),
      retrievedSnippets: [
        snippet("nfi_hal_active_desc_dump", 9500),
        snippet("nfi_hal_cdma_desc_dump", 9500),
        snippet("nfi_hal_controller_init", 9300),
      ],
    })

    expect(route).toMatchObject({
      kind: "model",
      reason: "ordinary-code",
      promptKind: "qwen-fim",
      modelProfile: "qwen-coder-fim",
      textProfile: "qwen-coder-fim",
      deterministicSymbolSuppressed: true,
      deterministicSymbolSuppressReason: "short-prefix",
      symbolPrefixRoute: "fim",
      symbolPrefixCandidateTopK: [
        "nfi_hal_active_desc_dump",
        "nfi_hal_cdma_desc_dump",
        "nfi_hal_controller_init",
      ],
    })
  })

  test("keeps deterministic C embedded symbol completion when a long prefix has a clearly leading candidate", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "  driver_contr",
        lineSuffix: "",
        currentWord: "driver_contr",
      }),
      settings: settings(),
      retrievedSnippets: [
        snippet("driver_controller_init", 9500),
        snippet("driver_contract_dump", 1200),
      ],
    })

    expect(route).toEqual({
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: "oller_init",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("returns deterministic comment symbol references without calling a model", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// arbitrary words alpha_feature_",
        lineSuffix: "",
        currentWord: "alpha_feature_",
      }),
      settings: settings(),
      retrievedSnippets: [
        snippet("alpha_feature_finalize", 9500),
      ],
    })

    expect(route).toEqual({
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: "alpha_feature_finalize",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("returns deterministic references for plain identifier prefixes in unit-test comments", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// give me a unit test code for confident",
        lineSuffix: "",
        currentWord: "confident",
      }),
      settings: settings(),
      retrievedSnippets: [
        snippet("confidential_guest_support_class_init", 9500),
      ],
    })

    expect(route).toEqual({
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: "confidential_guest_support_class_init",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("switches complete unit-test comment symbols to instruction test generation", () => {
    const initialPlan = planCompletion({
      languageId: "c",
      linePrefix: "// give me a unit test code for confidential_guest_support_class_init",
      lineSuffix: "",
      currentWord: "confidential_guest_support_class_init",
    })
    const effectivePlan = resolveCompletionPlanAfterSymbolRetrieval(initialPlan, [
      snippet("confidential_guest_support_class_init", 9500),
    ])

    expect(effectivePlan).toMatchObject({
      kind: "comment-to-test",
      insertMode: "insert-after-line",
      targetSymbol: "confidential_guest_support_class_init",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useInstruction: true,
      maxTokens: 768,
    })
  })

  test("switches complete comment symbols to instruction code generation", () => {
    const initialPlan = planCompletion({
      languageId: "c",
      linePrefix: "// 中文说明 alpha_feature_finalize",
      lineSuffix: "",
      currentWord: "alpha_feature_finalize",
    })
    const effectivePlan = resolveCompletionPlanAfterSymbolRetrieval(initialPlan, [
      snippet("alpha_feature_finalize", 9500),
    ])
    const route = routeCompletionModel({
      plan: effectivePlan,
      settings: settings(),
      retrievedSnippets: [
        snippet("alpha_feature_finalize", 9500),
      ],
    })

    expect(effectivePlan).toMatchObject({
      kind: "comment-to-code",
      insertMode: "insert-after-line",
      targetSymbol: "alpha_feature_finalize",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      useInstruction: true,
    })
    expect(route).toMatchObject({
      kind: "model",
      reason: "instruction-task",
      promptKind: "instruction",
      modelProfile: "generic-chat",
      textProfile: "generic-chat",
    })
  })

  test("falls back to comment code generation when a comment identifier has no symbol candidate", () => {
    const initialPlan = planCompletion({
      languageId: "typescript",
      linePrefix: "// implement add two numbers",
      lineSuffix: "",
      currentWord: "numbers",
    })
    const effectivePlan = resolveCompletionPlanAfterSymbolRetrieval(initialPlan, [])
    const route = routeCompletionModel({
      plan: effectivePlan,
      settings: settings(),
      retrievedSnippets: [],
    })

    expect(effectivePlan).toMatchObject({
      kind: "comment-to-code",
      insertMode: "insert-after-line",
      targetSymbol: "numbers",
      replaceCurrentWord: false,
      useInstruction: true,
    })
    expect(route).toMatchObject({
      kind: "model",
      reason: "instruction-task",
      promptKind: "instruction",
      modelProfile: "generic-chat",
      textProfile: "generic-chat",
    })
  })

  test("does not fall back to a model for comment symbol references without candidates", () => {
    const route = routeCompletionModel({
      plan: planCompletion({
        languageId: "c",
        linePrefix: "// arbitrary words alpha_feature_",
        lineSuffix: "",
        currentWord: "alpha_feature_",
      }),
      settings: settings(),
      retrievedSnippets: [],
    })

    expect(route).toEqual({
      kind: "none",
      reason: "no-symbol-candidate",
      maxTokens: 0,
      textProfile: "generic-chat",
    })
  })

  test("retries low-confidence instruction output but not FIM output", () => {
    const commentPlan = resolveCompletionPlanAfterSymbolRetrieval(planCompletion({
      languageId: "c",
      linePrefix: "// arbitrary words alpha_feature_finalize",
      lineSuffix: "",
      currentWord: "alpha_feature_finalize",
    }), [
      snippet("alpha_feature_finalize", 9500),
    ])
    const ordinaryPlan = planCompletion({
      languageId: "typescript",
      linePrefix: "const value = ",
      lineSuffix: "",
    })

    expect(shouldRetryCompletionRejection({
      reason: "low-confidence-output",
      plan: commentPlan,
      textProfile: "generic-chat",
    })).toBe(true)
    expect(shouldRetryCompletionRejection({
      reason: "low-confidence-output",
      plan: ordinaryPlan,
      textProfile: "qwen-coder-fim",
    })).toBe(false)
  })

  test("retries recoverable quality rejections once without retrying safety gates", () => {
    const ordinaryPlan = planCompletion({
      languageId: "c",
      linePrefix: "    if (",
      lineSuffix: ") {",
      triggerKind: "automatic",
    })

    expect(shouldRetryCompletionRejection({
      reason: "quality:placeholder",
      plan: ordinaryPlan,
      textProfile: "qwen-coder-fim",
    })).toBe(true)
    expect(shouldRetryCompletionRejection({
      reason: "quality:C parse/compile",
      plan: ordinaryPlan,
      textProfile: "qwen-coder-fim",
    })).toBe(true)
    expect(shouldRetryCompletionRejection({
      reason: "quality:markdown/explanation",
      plan: ordinaryPlan,
      textProfile: "generic-chat",
    })).toBe(true)
    expect(shouldRetryCompletionRejection({
      reason: "quality:dangerous C",
      plan: ordinaryPlan,
      textProfile: "generic-chat",
    })).toBe(false)
  })

  test("uses generic embedded FIM for low-confidence C symbol prefixes", () => {
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
      reason: "ordinary-code",
      promptKind: "qwen-fim",
      modelProfile: "qwen-coder-fim",
      textProfile: "qwen-coder-fim",
      maxTokens: 96,
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
    username: "chipmate",
    defaultModel: "",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
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
