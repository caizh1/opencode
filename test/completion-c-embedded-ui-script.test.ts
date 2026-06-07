import { describe, expect, test } from "bun:test"
import {
  applyOutputTelemetry,
  completionUiWorkspaceSettings,
  parseArgs,
  reconcileAcceptance,
  selectQemuP2Scenarios,
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
    expect(options.qemuCodeGraph).toBe("off")
    expect(options.qemuIndexWaitMs).toBe(0)
    expect(options.qemuIndexMaxFiles).toBe(50000)
    expect(options.restoreAfterEach).toBe(true)
  })

  test("parses qemu P2 matrix with repo-local output and codegraph enabled", () => {
    const options = parseArgs(["--qemu-p2-matrix", "--prepare-only", "--restore-after-each"])

    expect(options.qemuDirect).toBe(true)
    expect(options.qemuP2Matrix).toBe(true)
    expect(options.workspace).toContain(".completion-quality/qemu-p2-ui")
    expect(options.scenarioLimit).toBe(12)
    expect(options.qemuCodeGraph).toBe("on")
    expect(options.qemuIndexWaitMs).toBe(240000)
    expect(options.qemuIndexMaxFiles).toBe(5000)
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

  test("builds P2 qemu scenarios for all evidence-builder intents", () => {
    const files = [
      {
        path: "backends/member.c",
        absolutePath: "/qemu/backends/member.c",
        text: "void f(void)\n{\n    DeviceState *dev;\n}\n",
      },
      {
        path: "backends/call.c",
        absolutePath: "/qemu/backends/call.c",
        text: "void f(void)\n{\n    qemu_opts_del(opts);\n}\n",
      },
      {
        path: "hw/init.c",
        absolutePath: "/qemu/hw/init.c",
        text: "static const TypeInfo info = {\n    .name = TYPE_SAMPLE,\n};\n",
      },
      {
        path: "backends/error.c",
        absolutePath: "/qemu/backends/error.c",
        text: "int f(void)\n{\n    goto out;\nout:\n    return 0;\n}\n",
      },
      {
        path: "backends/state.c",
        absolutePath: "/qemu/backends/state.c",
        text: "void f(void)\n{\n    state = RUN_STATE_RUNNING;\n}\n",
      },
      {
        path: "hw/mmio.c",
        absolutePath: "/qemu/hw/mmio.c",
        text: "#define SAMPLE_CTRL_MASK GENMASK(3, 0)\n",
      },
    ]
    const scenarios = selectQemuP2Scenarios(files, 12)

    expect(scenarios.map((scenario) => scenario.category)).toEqual([
      "QEMU P2 member-access",
      "QEMU P2 call-args",
      "QEMU P2 initializer",
      "QEMU P2 error-path",
      "QEMU P2 state-machine",
      "QEMU P2 mmio-register",
    ])
    expect(scenarios.every((scenario) => scenario.mutation?.insertedText.includes("<|cursor|>"))).toBe(true)
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
      '[completion-telemetry] {"requestId":"cc-h02","planKind":"c-embedded-code","cIntent":"call-args","retrievalMode":"hybrid","evidenceKinds":["current-prefix","c-callee-signature","c-call-example"],"cEmbeddedEvidenceTrace":{"finalSelectedEvidenceCount":3,"minimumUsefulEvidenceMet":true},"contextLevel":"standard","promptKind":"qwen-fim","modelRoute":"fim","insertMode":"insert-at-cursor","accepted":true,"filterText":"crc16(data, len) != expected"}',
      '[OpenCode Remote] returned source=remote range=3:8-3:8 insertMode=insert-at-cursor firstLine="crc16(data, len) != expected" requestId=cc-h02',
    ].join("\n")

    applyOutputTelemetry([result], output)
    result.commitAttempted = true
    result.changed = false
    reconcileAcceptance([result])

    expect(result.inlineReturned).toBe(true)
    expect(result.planKind).toBe("c-embedded-code")
    expect(result.actualCIntent).toBe("call-args")
    expect(result.retrievalMode).toBe("hybrid")
    expect(result.evidenceKinds).toContain("c-callee-signature")
    expect(result.evidenceKinds).toContain("c-call-example")
    expect(result.selectedEvidenceCount).toBe(3)
    expect(result.contextLevel).toBe("standard")
    expect(result.promptKind).toBe("qwen-fim")
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
    evidenceKinds: [],
    selectedEvidenceCount: 0,
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
