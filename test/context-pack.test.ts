import { describe, expect, test } from "bun:test"
import {
  applyRequestStageTokenGate,
  buildContextPackShadowReport,
  buildContextWindowState,
  formatContextPackBudgetReport,
  formatContextWindowState,
} from "../src/context-pack"
import { resolveChatContextWindow } from "../src/context-window"

describe("context pack shadow report and request-stage token gate", () => {
  test("reports included context sections without changing messages in shadow mode", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "<chipmate-task-state>\nCurrent objective: test\n</chipmate-task-state>" },
      { role: "assistant", content: "older memory" },
      { role: "user", content: "latest request" },
    ]
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 1000, model: "unit-test" })
    const report = buildContextPackShadowReport({ messages, model: "unit-test", contextWindow })

    expect(report.source).toBe("shadow")
    expect(report.messageCount).toBe(messages.length)
    expect(report.sections.map((section) => section.id)).toEqual([
      "system_prompt",
      "task_state",
      "assistant_2",
      "latest_user_request",
    ])
    expect(formatContextPackBudgetReport(report)).toContain("source=shadow")
  })

  test("prunes lower-priority middle context while preserving system, task state, and latest user request", () => {
    const large = "old context ".repeat(2000)
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "<chipmate-task-state>\nLatest failure: keep me\n</chipmate-task-state>" },
      { role: "assistant", content: large },
      { role: "assistant", content: large },
      { role: "user", content: "latest request" },
    ]
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 300, model: "unit-test", safetyMarginTokens: 0 })
    const result = applyRequestStageTokenGate({ messages, model: "unit-test", contextWindow })

    expect(result.report.source).toBe("request-stage-token-gate")
    expect(result.report.truncated).toBe(true)
    expect(result.report.omittedMessages).toBeGreaterThan(0)
    expect(result.messages[0]?.content).toBe("system")
    expect(result.messages.some((message) => String(message.content).includes("<chipmate-task-state>"))).toBe(true)
    expect(result.messages[result.messages.length - 1]?.content).toBe("latest request")
  })

  test("computes pre-turn pressure from body-after-prefill scope", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 })
    const base = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "body pressure ".repeat(800) },
        { role: "user", content: "latest request" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const bodyTokens = base.totalEstimatedTokens - base.sections.find((section) => section.id === "system_prompt")!.tokens
    const report = {
      ...base,
      contextWindow: {
        ...base.contextWindow,
        effectiveContextWindow: Math.max(1, Math.floor(bodyTokens / 0.95)),
      },
    }
    const state = buildContextWindowState({ report })

    expect(state.autoCompactScope).toBe("body_after_prefill")
    expect(state.scopeTokens).toBe(state.bodyTokens)
    expect(state.prefillTokens).toBeGreaterThan(0)
    expect(state.shouldCompact).toBe(true)
    expect(state.reason).toBe("soft_threshold")
    expect(state.tokensUntilCompaction).toBe(0)
    expect(formatContextWindowState(state)).toContain("scope=body_after_prefill")
    expect(formatContextWindowState(state)).toContain("reason=soft_threshold")
  })

  test("does not auto-compact only because prefill baseline is large", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 })
    const base = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "large prefill ".repeat(1200) },
        { role: "user", content: "<chipmate-task-state>\nCurrent objective: keep continuity\n</chipmate-task-state>" },
        { role: "user", content: "latest request" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const prefillTokens = base.sections
      .filter((section) => section.id === "system_prompt" || section.id === "task_state")
      .reduce((sum, section) => sum + section.tokens, 0)
    const report = {
      ...base,
      contextWindow: {
        ...base.contextWindow,
        effectiveContextWindow: Math.max(1, Math.floor(prefillTokens / 0.95)),
      },
    }
    const state = buildContextWindowState({ report })

    expect(state.prefillTokens).toBeGreaterThan(state.compactionThresholdTokens)
    expect(state.scopeTokens).toBeLessThan(state.compactionThresholdTokens)
    expect(state.hardLimitReached).toBe(false)
    expect(state.requestStageTruncated).toBe(false)
    expect(state.shouldCompact).toBe(false)
    expect(state.reason).toBeUndefined()
  })
})
