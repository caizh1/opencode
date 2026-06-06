import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  C_EMBEDDED_CHECKERS,
  gateForCEmbeddedScore,
  scoreCEmbeddedCompletionQuality,
  type CEmbeddedCompletionFixture,
} from "../src/completion-c-embedded-quality"

const fixtureDir = resolve(import.meta.dir, "completion-quality/c-embedded/fixtures")

describe("C/embedded completion quality fixtures", () => {
  test("cover twelve C/embedded categories with ten fixtures each", async () => {
    const fixtures = await loadFixtures()
    expect(fixtures.length).toBeGreaterThanOrEqual(120)

    const categoryCounts = new Map<string, number>()
    const ids = new Set<string>()
    for (const fixture of fixtures) {
      expect(fixture.id).toBeTruthy()
      expect(ids.has(fixture.id)).toBe(false)
      ids.add(fixture.id)
      expect(fixture.category).toMatch(/^[A-L]\./)
      expect(fixture.languageId).toBe("c")
      expect(fixture.path).toBeTruthy()
      expect(fixture.document).toContain("<|cursor|>")
      expect(["automatic", "manual"]).toContain(fixture.triggerKind)
      expect(fixture.expectedIntent).toBeTruthy()
      expect(Array.isArray(fixture.mustContain)).toBe(true)
      expect(Array.isArray(fixture.mustNotContain)).toBe(true)
      expect(fixture.maxLines).toBeGreaterThanOrEqual(1)
      expect(fixture.checks).toEqual([...C_EMBEDDED_CHECKERS])
      if (fixture.mustContainAny) {
        expect(fixture.mustContainAny.every((group) => Array.isArray(group) && group.length > 0)).toBe(true)
      }
      categoryCounts.set(fixture.category, (categoryCounts.get(fixture.category) ?? 0) + 1)
    }

    expect(categoryCounts.size).toBe(12)
    for (const count of categoryCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(10)
    }
  })

  test("exposes all required checker names", () => {
    expect([...C_EMBEDDED_CHECKERS]).toEqual([
      "checkVscodeContract",
      "checkApplyEditResult",
      "checkCParseOrCompile",
      "checkNoMarkdownOrExplanation",
      "checkNoPlaceholder",
      "checkNoDangerousC",
      "checkNoHallucinatedSymbol",
      "checkIntentMatch",
      "checkEmbeddedSafety",
      "checkProjectStyle",
      "checkStability",
      "checkLatency",
    ])
  })
})

describe("C/embedded completion quality scorer", () => {
  test("hard rejects unsafe buffer completions", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "strcpy(dst, src);",
      appliedText: "hal_status_t f(char *dst, const char *src) { strcpy(dst, src); return HAL_OK; }",
      checks: ["checkNoDangerousC", "checkIntentMatch"],
      mustContain: ["snprintf"],
    }))

    expect(score.gate).toBe("reject")
    expect(score.issues.map((issue) => issue.kind)).toContain("unsafe buffer")
    expect(score.issues.some((issue) => issue.hardReject)).toBe(true)
  })

  test("labels bad edit contracts", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      decision: "rejected",
      rejectionReason: "selectedCompletionInfo-range-mismatch",
      acceptedText: "",
      appliedText: "int x;\n",
      checks: ["checkVscodeContract", "checkIntentMatch"],
      mustContain: ["int x = 1;"],
    }))

    expect(score.gate).toBe("reject")
    expect(score.issues.map((issue) => issue.kind)).toContain("bad edit contract")
  })

  test("classifies disabled plans as planner coverage misses instead of edit contracts", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      decision: "rejected",
      rejectionReason: "plan:disabled-plan",
      acceptedText: "",
      appliedText: "int x;\n",
      checks: ["checkVscodeContract"],
    }))

    expect(score.gate).toBe("reject")
    expect(score.issues.map((issue) => issue.kind)).toContain("planner disabled")
    expect(score.issues.map((issue) => issue.kind)).not.toContain("bad edit contract")
    expect(score.issues.map((issue) => issue.kind)).not.toContain("auto-show risk")
  })

  test("does not mark every rejected completion as auto-show risk", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      decision: "rejected",
      rejectionReason: "empty-output",
      acceptedText: "",
      appliedText: "int x;\n",
      checks: ["checkVscodeContract"],
    }))

    expect(score.issues.map((issue) => issue.kind)).toContain("bad edit contract")
    expect(score.issues.map((issue) => issue.kind)).not.toContain("auto-show risk")
  })

  test("hard rejects automatic C parse failures", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "flags & BIT(0",
      appliedText: "hal_status_t f(uint32_t flags) { if (flags & BIT(0) { return HAL_OK; } return HAL_ERR; }",
      checks: ["checkCParseOrCompile"],
    }))

    expect(score.gate).toBe("reject")
    expect(score.issues.map((issue) => issue.kind)).toContain("C parse/compile")
    expect(score.issues.some((issue) => issue.kind === "C parse/compile" && issue.hardReject)).toBe(true)
  })

  test("does not hard reject embedded project context missing from standalone clang", () => {
    const vendorType = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "return HAL_OK;",
      appliedText: [
        "#include \"vendor_hal.h\"",
        "hal_status_t driver_probe(VendorDevice *dev)",
        "{",
        "    return HAL_OK;",
        "}",
      ].join("\n"),
      checks: ["checkCParseOrCompile"],
    }))
    expect(vendorType.issues.map((issue) => issue.kind)).toContain("C parse/compile")
    expect(vendorType.issues.some((issue) => issue.kind === "C parse/compile" && issue.hardReject)).toBe(false)
    expect(vendorType.gate).not.toBe("reject")

    const rtosType = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "return HAL_OK;",
      appliedText: [
        "hal_status_t queue_attach(StaticQueue_t *queue)",
        "{",
        "    return HAL_OK;",
        "}",
      ].join("\n"),
      checks: ["checkCParseOrCompile"],
    }))
    expect(rtosType.issues.map((issue) => issue.kind)).toContain("C parse/compile")
    expect(rtosType.issues.some((issue) => issue.kind === "C parse/compile" && issue.hardReject)).toBe(false)
    expect(rtosType.gate).not.toBe("reject")

    const configMacro = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "if (CONFIG_DRIVER_ENABLED) {\n    return HAL_OK;\n}",
      appliedText: [
        "hal_status_t driver_enable(void)",
        "{",
        "    if (CONFIG_DRIVER_ENABLED) {",
        "        return HAL_OK;",
        "    }",
        "    return HAL_ERR;",
        "}",
      ].join("\n"),
      checks: ["checkCParseOrCompile"],
    }))
    expect(configMacro.issues.map((issue) => issue.kind)).toContain("C parse/compile")
    expect(configMacro.issues.some((issue) => issue.kind === "C parse/compile" && issue.hardReject)).toBe(false)
    expect(configMacro.gate).not.toBe("reject")

    const projectInclude = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "return HAL_OK;",
      appliedText: [
        "#define DRIVER_CONFIG_HEADER \"driver_local_config.h\"",
        "#include DRIVER_CONFIG_HEADER",
        "hal_status_t driver_configure(void)",
        "{",
        "    return HAL_OK;",
        "}",
      ].join("\n"),
      checks: ["checkCParseOrCompile"],
    }))
    expect(projectInclude.issues.map((issue) => issue.kind)).toContain("C parse/compile")
    expect(projectInclude.issues.some((issue) => issue.kind === "C parse/compile" && issue.hardReject)).toBe(false)
    expect(projectInclude.gate).not.toBe("reject")
  })

  test("hard rejects Markdown and stray backticks in C completions", () => {
    const fenced = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "```c\nreturn HAL_OK;\n```",
      appliedText: "hal_status_t f(void) { return HAL_OK; }",
      checks: ["checkNoMarkdownOrExplanation"],
    }))
    expect(fenced.gate).toBe("reject")
    expect(fenced.issues.map((issue) => issue.kind)).toContain("markdown/explanation")
    expect(fenced.issues.some((issue) => issue.hardReject)).toBe(true)

    const inlineBacktick = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "`flags & BIT(0)`",
      appliedText: "hal_status_t f(uint32_t flags) { if (`flags & BIT(0)`) { return HAL_OK; } return HAL_ERR; }",
      checks: ["checkNoMarkdownOrExplanation"],
    }))
    expect(inlineBacktick.gate).toBe("reject")
    expect(inlineBacktick.issues.map((issue) => issue.kind)).toContain("markdown/explanation")
  })

  test("allows project-style APIs and macros when they are present in context", () => {
    const score = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "UART0->CTRL |= UART_CTRL_ENABLE;\nuart_bus_unlock(bus);",
      appliedText: "void f(void) { UART0->CTRL |= UART_CTRL_ENABLE; uart_bus_unlock(bus); }",
      checks: ["checkNoHallucinatedSymbol"],
      selectedContextText: "#define UART_CTRL_ENABLE BIT(0)\n#define UART0 ((volatile uart_regs_t *)0x40000000u)\nvoid uart_bus_unlock(uart_bus_t *bus);\n",
    }))

    expect(score.issues.map((issue) => issue.kind)).not.toContain("hallucinated API")
  })

  test("labels ISR blocking, missing volatile, hallucinated API, placeholder, and unstable output", () => {
    const isr = scoreCEmbeddedCompletionQuality(scoreInput({
      category: "E. Interrupts critical sections and concurrency",
      path: "src/irq/timer_irq.c",
      acceptedText: "vTaskDelay(1);",
      appliedText: "void TIMER0_IRQHandler(void) { vTaskDelay(1); }",
      checks: ["checkEmbeddedSafety"],
    }))
    expect(isr.issues.map((issue) => issue.kind)).toContain("ISR blocking")

    const volatileScore = scoreCEmbeddedCompletionQuality(scoreInput({
      category: "D. MMIO registers and volatile",
      acceptedText: "#define UART_DR (*(uint32_t *)UART_BASE)",
      appliedText: "#define UART_BASE 0x40000000u\n#define UART_DR (*(uint32_t *)UART_BASE)\n",
      checks: ["checkEmbeddedSafety"],
    }))
    expect(volatileScore.issues.map((issue) => issue.kind)).toContain("missing volatile")

    const hallucinated = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "HAL_UARTX_Read(bus);",
      appliedText: "int f(void) { return HAL_UARTX_Read(bus); }",
      checks: ["checkNoHallucinatedSymbol"],
    }))
    expect(hallucinated.issues.map((issue) => issue.kind)).toContain("hallucinated API")

    const placeholder = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "// TODO: Add your implementation",
      appliedText: "void f(void) { /* TODO: Add your implementation */ }",
      checks: ["checkNoPlaceholder"],
    }))
    expect(placeholder.issues.map((issue) => issue.kind)).toContain("placeholder")

    const unstable = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "return HAL_OK;",
      appliedText: "hal_status_t f(void) { return HAL_OK; }",
      repeatAcceptedTexts: ["return HAL_OK;", "return HAL_ERR;"],
      checks: ["checkStability"],
    }))
    expect(unstable.issues.map((issue) => issue.kind)).toContain("unstable output")
  })

  test("hard rejects generated code-here placeholder comments with descriptors", () => {
    const codePlaceholder = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "// Your ISR code here\n    }",
      appliedText: "void TIMER0_IRQHandler(void) { uint8_t byte = 0u; // Your ISR code here }",
      checks: ["checkNoPlaceholder"],
    }))
    const implementationPlaceholder = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "// Your driver implementation here",
      appliedText: "void driver_poll(void) { // Your driver implementation here }",
      checks: ["checkNoPlaceholder"],
    }))
    const actionHerePlaceholder = scoreCEmbeddedCompletionQuality(scoreInput({
      acceptedText: "// Handle the received data here",
      appliedText: "void UART0_IRQHandler(void) { // Handle the received data here }",
      checks: ["checkNoPlaceholder"],
    }))

    for (const score of [codePlaceholder, implementationPlaceholder, actionHerePlaceholder]) {
      expect(score.gate).toBe("reject")
      expect(score.issues.map((issue) => issue.kind)).toContain("placeholder")
      expect(score.issues.some((issue) => issue.kind === "placeholder" && issue.hardReject)).toBe(true)
    }
  })

  test("applies gate thresholds and hard reject override", () => {
    expect(gateForCEmbeddedScore(85)).toBe("auto show")
    expect(gateForCEmbeddedScore(70)).toBe("manual only")
    expect(gateForCEmbeddedScore(69)).toBe("reject")
    expect(gateForCEmbeddedScore(100, [{
      kind: "unsafe buffer",
      message: "unsafe",
      checker: "checkNoDangerousC",
      dimension: "safety",
      severity: "critical",
      hardReject: true,
    }])).toBe("reject")
  })
})

async function loadFixtures() {
  const files = (await readdir(fixtureDir))
    .filter((file) => file.endsWith(".ts") && !file.startsWith("_"))
    .sort()
  const fixtures: CEmbeddedCompletionFixture[] = []
  for (const file of files) {
    const module = await import(`${pathToFileURL(resolve(fixtureDir, file)).href}?t=${Date.now()}`)
    fixtures.push(...(module.default as CEmbeddedCompletionFixture[]))
  }
  return fixtures
}

function scoreInput(input: Partial<Parameters<typeof scoreCEmbeddedCompletionQuality>[0]> & {
  checks?: CEmbeddedCompletionFixture["checks"]
  mustContain?: string[]
  category?: string
  path?: string
}): Parameters<typeof scoreCEmbeddedCompletionQuality>[0] {
  return {
    fixture: {
      id: "score-fixture",
      category: input.category ?? "I. Memory buffer and safety",
      languageId: "c",
      path: input.path ?? "src/driver/test.c",
      document: "int f(void) { <|cursor|> }\n",
      triggerKind: "automatic",
      expectedIntent: "score fixture",
      mustContain: input.mustContain ?? [],
      mustNotContain: ["HAL_UARTX", "TODO", "Add your implementation", "strcpy("],
      maxLines: 4,
      checks: input.checks ?? [...C_EMBEDDED_CHECKERS],
    },
    decision: input.decision ?? "accepted",
    rejectionReason: input.rejectionReason,
    acceptedText: input.acceptedText ?? "",
    appliedText: input.appliedText ?? "",
    originalText: input.originalText ?? "",
    linePrefix: input.linePrefix ?? "",
    lineSuffix: input.lineSuffix ?? "",
    edit: input.edit ?? {
      insertText: input.acceptedText ?? "",
      replaceRange: { startLine: 0, startCharacter: 14, endLine: 0, endCharacter: 14 },
      filterText: input.acceptedText ?? "",
    },
    repeatAcceptedTexts: input.repeatAcceptedTexts ?? [input.acceptedText ?? ""],
    repeatDecisions: input.repeatDecisions ?? [input.decision ?? "accepted"],
    latencyMs: input.latencyMs ?? 0,
    selectedContextText: input.selectedContextText ?? "",
  }
}
