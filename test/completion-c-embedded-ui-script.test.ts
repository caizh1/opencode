import { describe, expect, test } from "bun:test"
import {
  applyOutputTelemetry,
  completionUiWorkspaceSettings,
  parseArgs,
  reconcileAcceptance,
  selectQemuScenarios,
  type UiResult,
} from "../scripts/completion-c-embedded-ui"

describe("C/embedded UI matrix script settings", () => {
  test("inherits direct model endpoint, model, and profile by default", () => {
    const options = parseArgs(["--prepare-only", "--workspace", "/tmp/ui-matrix"])
    const settings = completionUiWorkspaceSettings(options)

    expect(settings["opencode.remote.completion.provider"]).toBe("openai-compatible")
    expect(settings["opencode.remote.completion.enabled"]).toBe(true)
    expect(settings).not.toHaveProperty("opencode.remote.completion.apiBaseUrl")
    expect(settings).not.toHaveProperty("opencode.remote.completion.model")
    expect(settings).not.toHaveProperty("opencode.remote.completion.profile")
    expect(settings).not.toHaveProperty("opencode.remote.rag.embedding.endpoint")
    expect(settings).not.toHaveProperty("opencode.remote.rag.rerank.endpoint")
  })

  test("writes explicit direct model overrides without model-name whitelisting", () => {
    const options = parseArgs([
      "--prepare-only",
      "--workspace",
      "/tmp/ui-matrix",
      "--api-base-url",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "--model",
      "future-code-model-2026",
      "--profile",
      "generic-chat",
    ])
    const settings = completionUiWorkspaceSettings(options)

    expect(settings["opencode.remote.completion.apiBaseUrl"]).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
    expect(settings["opencode.remote.completion.model"]).toBe("future-code-model-2026")
    expect(settings["opencode.remote.completion.profile"]).toBe("generic-chat")
  })

  test("allows Qwen FIM profile only when explicitly requested", () => {
    const options = parseArgs(["--prepare-only", "--profile", "qwen-coder-fim"])
    const settings = completionUiWorkspaceSettings(options)

    expect(settings["opencode.remote.completion.profile"]).toBe("qwen-coder-fim")
  })

  test("parses qemu direct options with safe defaults", () => {
    const options = parseArgs(["--qemu-direct", "--prepare-only", "--restore-after-each"])

    expect(options.qemuDirect).toBe(true)
    expect(options.workspace).toBe("/tmp/opencode-qemu-completion-ui-138")
    expect(options.sourceWorkspace).toBe("/Users/archer/Work/qemu")
    expect(options.scenarioLimit).toBe(72)
    expect(options.restoreAfterEach).toBe(true)
  })

  test("builds deterministic qemu scenarios with temporary completion gaps", () => {
    const scenarios = selectQemuScenarios([
      {
        path: "util/sample.c",
        absolutePath: "/qemu/util/sample.c",
        text: "int sample(int x)\n{\n    if (x) {\n        return x;\n    }\n}\n",
      },
      {
        path: "include/hw/sample.h",
        absolutePath: "/qemu/include/hw/sample.h",
        text: "#define SAMPLE_FLAG 1\nstruct SampleState { int value; };\n",
      },
    ], 2)

    expect(scenarios).toHaveLength(2)
    expect(scenarios[0].relativePath).toBe("util/sample.c")
    expect(scenarios[0].mutation?.insertedText).toContain("<|cursor|>")
    expect(scenarios[0].mutation?.text).not.toContain("<|cursor|>")
    expect(scenarios[0].cursor.line).toBeGreaterThan(0)
  })

  test("keeps accepted inline telemetry as the primary UI row when later cursor telemetry is disabled", () => {
    const result = uiResult("E02-isr-safe-queue")
    result.changed = true
    const output = [
      '[OpenCode Remote] completion request requestId=cc-ok path="/tmp/opencode-c-embedded-ui-matrix/scenarios/E02-isr-safe-queue/src/irq/timer_irq.c"',
      '[completion-telemetry] {"requestId":"cc-ok","planKind":"body-continuation","modelRoute":"fim","insertMode":"insert-at-cursor","accepted":true}',
      "[OpenCode Remote] returned source=remote requestId=cc-ok",
      '[OpenCode Remote] completion request requestId=cc-later path="/tmp/opencode-c-embedded-ui-matrix/scenarios/E02-isr-safe-queue/src/irq/timer_irq.c"',
      '[completion-telemetry] {"requestId":"cc-later","planKind":"disabled","modelRoute":"none","insertMode":"insert-at-cursor","accepted":false,"rejectReason":"plan:disabled-plan"}',
    ].join("\n")

    applyOutputTelemetry([result], output)
    result.commitAttempted = true
    reconcileAcceptance([result])

    expect(result.inlineSuggestion).toBe(true)
    expect(result.inlineReturned).toBe(true)
    expect(result.textApplied).toBe(true)
    expect(result.acceptedAndApplied).toBe(true)
    expect(result.planKind).toBe("body-continuation")
    expect(result.modelRoute).toBe("fim")
    expect(result.flags.disabledPlan).toBe(true)
  })

  test("keeps returned inline, commit attempt, and applied text as separate evidence", () => {
    const result = uiResult("H02-crc-check")
    const output = [
      '[OpenCode Remote] completion request requestId=cc-h02 path="/tmp/opencode-c-embedded-ui-matrix/scenarios/H02-crc-check/src/proto/frame.c"',
      '[completion-telemetry] {"requestId":"cc-h02","planKind":"ordinary-code","modelRoute":"fim","insertMode":"insert-at-cursor","accepted":true,"filterText":"crc16(data, len) != expected"}',
      '[OpenCode Remote] returned source=remote range=3:8-3:8 insertMode=insert-at-cursor firstLine="crc16(data, len) != expected" requestId=cc-h02',
    ].join("\n")

    applyOutputTelemetry([result], output)
    result.commitAttempted = true
    result.changed = false
    reconcileAcceptance([result])

    expect(result.inlineReturned).toBe(true)
    expect(result.commitAttempted).toBe(true)
    expect(result.textApplied).toBe(false)
    expect(result.acceptedAndApplied).toBe(false)
    expect(result.notes).toContain("inline returned and commit attempted but returned text was not applied")
  })
})

function uiResult(id: string): UiResult {
  return {
    id,
    category: "E. Interrupts critical sections and concurrency",
    path: `/tmp/${id}.c`,
    cursor: { line: 0, character: 0 },
    triggerKind: "manual",
    inlineSuggestion: false,
    inlineReturned: false,
    commitAttempted: false,
    textApplied: false,
    acceptedAndApplied: false,
    changed: false,
    inlineFirstLines: [],
    qualityRejected: false,
    flags: {
      disabledPlan: false,
      badEditContract: false,
      parseError: false,
      unsafeC: false,
      hallucinatedAPI: false,
      placeholder: false,
    },
    notes: [],
  }
}
