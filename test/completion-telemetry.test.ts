import { describe, expect, test } from "bun:test"
import {
  COMPLETION_PLANNER_REVISION,
  completionTelemetryRoute,
  createCompletionRequestId,
  filePathHash,
  serializeCompletionDebugEvent,
  truncateTelemetryText,
  type CompletionDebugEvent,
} from "../src/completion-telemetry"

describe("completion telemetry", () => {
  test("creates request ids with a stable completion prefix", () => {
    expect(createCompletionRequestId()).toMatch(/^cc-[0-9a-z]+-[0-9a-z]+$/)
  })

  test("hashes file paths without exposing absolute paths", () => {
    const fullPath = "/Users/archer/Work/opencode/src/secret.ts"
    const hash = filePathHash(fullPath)

    expect(hash).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(hash).toBe(filePathHash(fullPath))
    expect(hash).not.toContain("/Users/archer")
    expect(hash).not.toContain("secret.ts")
  })

  test("serializes stable event fields and redacts path-like content", () => {
    const event: CompletionDebugEvent = {
      requestId: "cc-test-1",
      completionId: "cc-test-1",
      extensionVersion: "0.0.155",
      plannerRevision: COMPLETION_PLANNER_REVISION,
      languageId: "typescript",
      filePathHash: filePathHash("/Users/archer/Work/opencode/src/secret.ts"),
      triggerKind: "automatic",
      planKind: "ordinary-code",
      cIntent: "body-statement",
      insertMode: "insert-at-cursor",
      currentWord: "value",
      sourceCommentPreview: "//step2. wait nfc clock rest",
      commentGuidedSkipReason: "not-c-body-context",
      retrievalMode: "hybrid",
      evidenceKinds: ["target-symbol", "analysis-evidence"],
      evidencePromptBlocks: 3,
      evidencePromptTokens: 220,
      evidencePromptKinds: ["c-base-type", "c-struct-definition"],
      contextLevel: "standard",
      promptKind: "qwen-fim",
      modelRoute: "fim",
      rawOutputLength: 24,
      normalizedOutputLength: 12,
      trimReason: "c-intent-trim",
      finalInsertLength: 10,
      finalRange: {
        startLine: 0,
        startCharacter: 4,
        endLine: 0,
        endCharacter: 4,
      },
      filterText: "/Users/archer/Work/opencode/src/secret.ts ".repeat(8),
      accepted: false,
      rejectReason: "echoed-prefix",
      latencyMs: {
        planning: 1,
        symbol: 2,
        context: 3,
        model: 4,
        postprocess: 5,
        edit: 6,
        total: 21,
      },
    }

    const serialized = serializeCompletionDebugEvent(event)
    const parsed = JSON.parse(serialized.replace(/^\[completion-telemetry\] /, "")) as CompletionDebugEvent

    expect(parsed).toMatchObject({
      requestId: "cc-test-1",
      completionId: "cc-test-1",
      extensionVersion: "0.0.155",
      plannerRevision: COMPLETION_PLANNER_REVISION,
      languageId: "typescript",
      planKind: "ordinary-code",
      cIntent: "body-statement",
      sourceCommentPreview: "//step2. wait nfc clock rest",
      commentGuidedSkipReason: "not-c-body-context",
      retrievalMode: "hybrid",
      evidenceKinds: ["target-symbol", "analysis-evidence"],
      evidencePromptBlocks: 3,
      evidencePromptTokens: 220,
      evidencePromptKinds: ["c-base-type", "c-struct-definition"],
      contextLevel: "standard",
      promptKind: "qwen-fim",
      insertMode: "insert-at-cursor",
      modelRoute: "fim",
      trimReason: "c-intent-trim",
      finalInsertLength: 10,
      accepted: false,
      rejectReason: "echoed-prefix",
    })
    expect(serialized).not.toContain("/Users/archer")
    expect(serialized).not.toContain("secret.ts")
    expect(serialized).not.toContain("api-key")
    expect((parsed.filterText ?? "").length).toBeLessThanOrEqual(160)
  })

  test("maps model routes into telemetry route values", () => {
    expect(completionTelemetryRoute({ kind: "deterministic-symbol" })).toBe("deterministic-symbol")
    expect(completionTelemetryRoute({ kind: "model", promptKind: "qwen-fim" })).toBe("fim")
    expect(completionTelemetryRoute({ kind: "model", promptKind: "instruction" })).toBe("instruction")
    expect(completionTelemetryRoute(undefined)).toBe("none")
  })

  test("truncates multiline text for safe telemetry fields", () => {
    expect(truncateTelemetryText("line1\nline2\n" + "x".repeat(200), 20)).toBe("line1\\nline2\\nxxxxxxxx...")
  })
})
