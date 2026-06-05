import type { CEmbeddedCompletionFixture } from "../../../../src/completion-c-embedded-quality"
import type { RetrievedCompletionSnippet } from "../../../../src/completion-types"

export const allChecks = [
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
] as const

const commonMustNotContain = [
  "```",
  "Here is",
  "Explanation:",
  "TODO",
  "Add your implementation",
  "your code here",
  "strcpy(",
  "strcat(",
  "sprintf(",
  "gets(",
  "NONEXISTENT_",
  "FAKE_",
  "UNKNOWN_",
  "HAL_UARTX",
  "GPIOZ",
  "USART99",
  "invented_",
]

export function cFixture(input: Omit<CEmbeddedCompletionFixture, "checks" | "languageId" | "mustNotContain"> & Partial<Pick<CEmbeddedCompletionFixture, "checks" | "languageId" | "mustNotContain">>): CEmbeddedCompletionFixture {
  return {
    languageId: "c",
    checks: [...allChecks],
    mustNotContain: commonMustNotContain,
    ...input,
  }
}

export function snippet(input: Partial<RetrievedCompletionSnippet> & Pick<RetrievedCompletionSnippet, "name" | "text">): RetrievedCompletionSnippet {
  return {
    kind: "function",
    path: "include/project.h",
    line: 1,
    score: 1100,
    ...input,
  }
}

export const commonHeader = [
  "#include <stdint.h>",
  "#include <stdbool.h>",
  "#include <stddef.h>",
  "#include <string.h>",
  "#define ARRAY_SIZE(x) (sizeof(x) / sizeof((x)[0]))",
  "#define MIN(a, b) ((a) < (b) ? (a) : (b))",
  "#define BIT(n) (1u << (n))",
  "#define HAL_OK 0",
  "#define HAL_ERR -1",
  "#define HAL_TIMEOUT -2",
  "#define LOG_ERR(tag, code) ((void)(tag), (void)(code))",
  "#define ASSERT_EQ(a, b) ((void)(a), (void)(b))",
  "#define ASSERT_TRUE(a) ((void)(a))",
  "#define pdMS_TO_TICKS(ms) (ms)",
  "#define pdPASS 1",
  "#define pdTRUE 1",
  "typedef int hal_status_t;",
  "static uint32_t millis_now(void) { return 0u; }",
  "static void cpu_relax(void) { }",
  "",
].join("\n")

export function doc(body: string) {
  return `${commonHeader}${body}`
}

export function fn(name: string, body: string, returnType = "hal_status_t") {
  return doc(`${returnType} ${name}(void)\n{\n${body}\n}\n`)
}

export function driverFn(name: string, body: string, returnType = "hal_status_t") {
  return doc(`${returnType} ${name}(uint32_t timeout_ms)\n{\n${body}\n}\n`)
}
