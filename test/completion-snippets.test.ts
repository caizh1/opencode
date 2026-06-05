import { describe, expect, test } from "bun:test"
import { completionSnippetFromSymbol } from "../src/completion-snippets"
import type { ResolvedSymbolCandidate } from "../src/completion-symbol"

describe("completion snippets", () => {
  test("prefers complete symbol snippets over signatures for instruction context", () => {
    const snippet = completionSnippetFromSymbol(symbol({
      name: "alpha_feature_finalize",
      signature: "static void alpha_feature_finalize(void)",
      snippet: [
        "static void alpha_feature_finalize(void)",
        "{",
        "    alpha_release_state();",
        "}",
      ].join("\n"),
    }))

    expect(snippet.text).toContain("alpha_release_state();")
    expect(snippet.text).not.toBe("static void alpha_feature_finalize(void)")
  })

  test("classifies test-shaped paths as existing test snippets without target-specific names", () => {
    const snippet = completionSnippetFromSymbol(symbol({
      name: "test_storage_flush",
      filePath: "src/storage/storage_spec.c",
      snippet: "static void test_storage_flush(void) {}",
    }))

    expect(snippet.kind).toBe("existing test")
  })
})

function symbol(input: Partial<ResolvedSymbolCandidate>): ResolvedSymbolCandidate {
  return {
    name: input.name ?? "alpha_feature_finalize",
    kind: input.kind ?? "function",
    signature: input.signature,
    filePath: input.filePath ?? "src/features/alpha.c",
    line: input.line ?? 10,
    score: input.score ?? 100,
    matchScore: input.matchScore ?? 100,
    reasons: input.reasons ?? ["exact"],
    snippet: input.snippet,
    source: input.source ?? "codeGraph",
  }
}
