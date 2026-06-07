import { describe, expect, test } from "bun:test"
import { normalizeCommentGuidedTokens, scoreCommentGuidedCandidate } from "../src/completion-comment-guided-ranking"

describe("generic comment-guided completion ranking", () => {
  test("normalizes generic engineering aliases without project-specific symbols", () => {
    const tokens = normalizeCommentGuidedTokens("// step2: poll clk rst cfg irq until ready")

    expect(tokens.normalizedTokens).toContain("wait")
    expect(tokens.normalizedTokens).toContain("clock")
    expect(tokens.normalizedTokens).toContain("reset")
    expect(tokens.normalizedTokens).toContain("config")
    expect(tokens.normalizedTokens).toContain("interrupt")
    expect(tokens.ignoredTokens).toContain("step")
  })

  test("ranks action and object coverage above domain-only matches", () => {
    const comment = normalizeCommentGuidedTokens("// wait nfc clock reset")
    const domainOnly = scoreCommentGuidedCandidate({
      comment,
      candidateText: "void nfc_transfer_helper(void) { nfc_submit(); }",
      sameModuleScore: 50,
      graphProximityScore: 60,
    })
    const semantic = scoreCommentGuidedCandidate({
      comment,
      candidateText: "void controller_wait_clock_reset(void) { while (!clock_ready()) cpu_relax(); }",
    })

    expect(domainOnly.domainTokenCoverage).toBeGreaterThan(0)
    expect(domainOnly.actionTokenCoverage).toBe(0)
    expect(domainOnly.objectTokenCoverage).toBe(0)
    expect(semantic.actionTokenCoverage).toBeGreaterThan(0)
    expect(semantic.objectTokenCoverage).toBeGreaterThan(0)
    expect(semantic.totalScore).toBeGreaterThan(domainOnly.totalScore)
  })
})
