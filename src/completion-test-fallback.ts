import type { CompletionPostprocessRejectReason } from "./completion-postprocess"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"

type CompletionFallbackInput = {
  languageId: string
  plan: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
  rejectReason?: CompletionPostprocessRejectReason | string
}

const MIN_UNIT_TEST_FALLBACK_SCORE = 500

export function fallbackCompletionText(input: CompletionFallbackInput) {
  if (
    input.plan.kind !== "natural-command" &&
    input.plan.kind !== "comment-to-test" &&
    !(input.plan.kind === "previous-comment-continuation" && input.plan.needsTestRetrieval)
  ) return ""
  if (!input.rejectReason) return ""

  const symbol = unitTestTargetSymbol(input)
  if (!symbol) return ""

  if (isCStyleLanguage(input.languageId)) {
    return [
      `static void test_${sanitizeIdentifier(symbol)}(void)`,
      "{",
      `    (void)${symbol}();`,
      "}",
    ].join("\n")
  }

  return [
    `test("${symbol}", () => {`,
    `    ${symbol}()`,
    "})",
  ].join("\n")
}

function unitTestTargetSymbol(input: CompletionFallbackInput) {
  const fromSnippet = input.retrievedSnippets.find((snippet) =>
    snippet.name &&
    (snippet.score ?? 0) >= MIN_UNIT_TEST_FALLBACK_SCORE &&
    !looksLikeTestSymbol(snippet.name)
  )?.name
  if (fromSnippet) return fromSnippet

  const target = input.plan.targetSymbol
  return target && target.length >= 3 ? target : ""
}

function looksLikeTestSymbol(name: string) {
  return /(?:^|_)test(?:_|$)/i.test(name)
}

function sanitizeIdentifier(input: string) {
  const sanitized = input.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "")
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`
}

function isCStyleLanguage(languageId: string) {
  return new Set(["c", "cpp", "c++", "objective-c", "objective-cpp"]).has(languageId)
}
