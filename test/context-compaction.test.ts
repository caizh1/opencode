import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildContextPackShadowReport, applyRequestStageTokenGate, buildContextWindowState } from "../src/context-pack"
import {
  appendContextCompactionEvent,
  buildCompactionCandidate,
  buildCompactSummaryPrompt,
  buildCompactedHistoryAdapterSnapshot,
  buildContextCompactionEvent,
  buildContextCompactionLifecycleEvent,
  chooseCompactionStrategy,
  compactSummaryOverflowRetryPlan,
  compactStateWithTokenBudgetFreshWindow,
  compactStateWithModelSummary,
  compactStateWithRequestStageFallbackPrune,
  compactedHistoryMessagesFromEvent,
  contextCompactionBaselineMetadata,
  contextCompactionEventsFromSessionEvents,
  DEFAULT_RETAINED_USER_MESSAGE_MAX_COUNT,
  DEFAULT_RETAINED_USER_MESSAGE_MAX_TOKENS,
  formatContextCompactionEventRecord,
  formatCompactionRecord,
  formatCompactionStrategyDecision,
  latestCompletedContextCompactionEvent,
  latestContextCompactionEvent,
  parseCompactSummaryModelOutput,
  runCompactHooks,
  shouldCreateCompactionCandidate,
  shouldSkipRedundantCompaction,
  type ReplacementHistoryItem,
  validateCompactSummaryQuality,
} from "../src/context-compaction"
import { buildConversationContextState, type ConversationContextEvent } from "../src/conversation-context"
import { resolveChatContextWindow } from "../src/context-window"
import type { ChipMateMessage } from "../src/types"

describe("context compaction scaffold", () => {
  test("is wired after request-stage token gate for compact telemetry", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "direct-agent-client.ts"), "utf8")
    expect(source).toContain("buildCompactionCandidate")
    expect(source).toContain("formatCompactionRecord")
    expect(source.indexOf("applyRequestStageTokenGate")).toBeLessThan(source.indexOf("buildCompactionCandidate"))
    expect(source).toContain("this.deps.output.appendLine(formatCompactionRecord(compactState))")
    expect(source).toContain("buildContextWindowState({ report: gated.report })")
    expect(source).toContain("formatContextWindowState(windowState)")
    expect(source).toContain("persistFallbackCompactionEvent")
    expect(source).toContain("formatContextCompactionEventRecord(compactEvent.contextCompaction)")
    expect(source).toContain("runCompactHookBoundary(\"pre\"")
    expect(source).toContain("runCompactHookBoundary(\"post\"")
    expect(source).toContain("compactHooks?.preCompact")
    expect(source).toContain("compactHooks?.postCompact")
    expect(source).toContain("persistModelGeneratedCompactionEvent")
    expect(source).toContain("requestCompactSummary")
    expect(source).toContain("parseCompactSummaryModelOutput")
    expect(source).toContain("validateCompactSummaryQuality")
    expect(source).toContain("chooseCompactionStrategy")
    expect(source).toContain("formatCompactionStrategyDecision")
    expect(source).toContain("persistTokenBudgetCompactionEvent")
    expect(source).toContain("latestCompletedContextCompactionEvent(events)")
    expect(source).toContain("buildCompactedHistoryAdapterSnapshot(completedCompact)")
    expect(source).toContain("[context-compact-adapter] using completed compact")
    expect(source).toContain("[context-compact-adapter] diagnostics")
  })

  test("creates compact candidates at soft threshold without pruning", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 1000, model: "unit-test", safetyMarginTokens: 0 })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "context ".repeat(70) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const report = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: softEffectiveWindowForReport(baseReport),
      },
    }
    const state = fixtureState()

    expect(shouldCreateCompactionCandidate(report)).toBe(true)
    const compact = buildCompactionCandidate({ state, budgetReport: report, now: 100 })
    expect(compact?.status).toBe("candidate")
    expect(compact?.trigger).toBe("soft_threshold")
    expect(compact?.initialContextReinjection).toBe("next_turn_full")
  })

  test("uses scoped pre-turn window pressure instead of prefill-only ratio", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "large prefill ".repeat(1200) },
        { role: "user", content: "<chipmate-task-state>\nCurrent objective: keep continuity\n</chipmate-task-state>" },
        { role: "user", content: "latest request" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const prefillTokens = baseReport.sections
      .filter((section) => section.id === "system_prompt" || section.id === "task_state")
      .reduce((sum, section) => sum + section.tokens, 0)
    const report = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: Math.max(1, Math.floor(prefillTokens / 0.95)),
      },
    }
    const scopedState = buildContextWindowState({ report })
    const totalRatioWouldHaveCompacted = report.totalEstimatedTokens / report.contextWindow.effectiveContextWindow >= 0.9

    expect(totalRatioWouldHaveCompacted).toBe(true)
    expect(scopedState.shouldCompact).toBe(false)
    expect(shouldCreateCompactionCandidate(report, scopedState)).toBe(false)
    expect(buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: report,
      windowState: scopedState,
      now: 101,
    })).toBeUndefined()
  })

  test("manual compact trigger creates a candidate without context pressure", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 100_000, model: "unit-test", safetyMarginTokens: 0 })
    const report = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "small latest request" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const state = fixtureState()

    expect(shouldCreateCompactionCandidate(report)).toBe(false)
    const compact = buildCompactionCandidate({
      state,
      budgetReport: report,
      trigger: "manual",
      now: 101,
    })

    expect(compact?.status).toBe("candidate")
    expect(compact?.trigger).toBe("manual")
    expect(compact?.initialContextReinjection).toBe("next_turn_full")
    expect(compact?.retainedMessageIds).toContain("u3")
    expect(compact?.replacementHistory.some((item) => item.kind === "initial_context")).toBe(true)
    expect(compact?.omittedMessageCount).toBeGreaterThan(0)
    expect(chooseCompactionStrategy({ compaction: compact!, modelSummaryAvailable: true })).toMatchObject({
      implementation: "local_summary",
      strategy: "local_summary",
      phase: "manual",
      reason: "user_requested",
    })
  })

  test("builds replacement history with retained user messages and a compaction summary item", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 40, model: "unit-test", safetyMarginTokens: 0 })
    const gated = applyRequestStageTokenGate({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "old ".repeat(1000) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const state = fixtureState()
    const compact = buildCompactionCandidate({ state, budgetReport: gated.report, now: 100 })

    expect(compact?.status).toBe("fallback_pruned")
    expect(compact?.trigger).toBe("request_stage_truncated")
    expect(compact?.retainedMessageIds).toEqual(["u1", "u2", "u3"])
    expect(compact?.replacementHistory.map((item) => item.kind)).toEqual([
      "retained_user_message",
      "retained_user_message",
      "retained_user_message",
      "initial_context",
      "compaction_summary",
    ])
    expect(compact?.replacementHistory.find((item) => item.kind === "initial_context")?.content).toContain("<chipmate-high-priority-state")
    expect(compact?.replacementHistory.find((item) => item.kind === "initial_context")?.content).toContain("TaskState:")
    expect(compact?.replacementHistory.at(-1)?.source).toBe("compaction_summary")
    expect(compact?.summary).toContain("Current objective: Keep context parity moving")
    expect(compact?.summary).toContain("User corrections: 必须保留用户纠偏。")
    expect(compact?.window.modelContextWindow).toBe(40)
  })

  test("can defer request-stage fallback so completed compact gets first chance", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 40, model: "unit-test", safetyMarginTokens: 0 })
    const gated = applyRequestStageTokenGate({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "old ".repeat(1000) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })

    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: gated.report,
      now: 102,
      deferRequestStageFallback: true,
    })

    expect(gated.report.truncated).toBe(true)
    expect(compact?.status).toBe("candidate")
    expect(compact?.trigger).toBe("request_stage_truncated")
    expect(compact?.fallbackReason).toBe("request-stage token gate pruned lower-priority context sections")
    const fallback = compactStateWithRequestStageFallbackPrune(compact!, gated.report)
    expect(fallback.status).toBe("fallback_pruned")
    expect(fallback.afterTokens).toBe(gated.report.totalEstimatedTokens)
    expect(fallback.omittedMessageCount).toBe(gated.report.omittedMessages)
  })

  test("retains recent user messages by token budget instead of a fixed three-message window", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 40, model: "unit-test", safetyMarginTokens: 0 })
    const gated = applyRequestStageTokenGate({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "old ".repeat(1000) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const events: ConversationContextEvent[] = []
    for (let index = 1; index <= 6; index += 1) {
      events.push({ type: "message", message: message(`u${index}`, "user", `User question:\nretain intent ${index}`, index * 2) })
      events.push({ type: "message", message: message(`a${index}`, "assistant", `answer ${index}`, index * 2 + 1) })
    }
    const state = buildConversationContextState({ sessionID: "s-retain", events, now: 100 })
    const moreThanThree = buildCompactionCandidate({
      state,
      budgetReport: gated.report,
      retainedUserMaxTokens: DEFAULT_RETAINED_USER_MESSAGE_MAX_TOKENS,
      retainedUserMaxMessages: 5,
      now: 101,
    })
    const tinyCap = buildCompactionCandidate({
      state,
      budgetReport: gated.report,
      retainedUserMaxTokens: 1,
      retainedUserMaxMessages: DEFAULT_RETAINED_USER_MESSAGE_MAX_COUNT,
      now: 102,
    })

    expect(moreThanThree?.retainedMessageIds).toEqual(["u2", "u3", "u4", "u5", "u6"])
    expect(moreThanThree?.replacementHistory.filter((item) => item.kind === "retained_user_message")).toHaveLength(5)
    expect(tinyCap?.retainedMessageIds).toEqual(["u6"])
  })

  test("formats compact telemetry with trigger, before/after tokens, retained and reinject mode", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 40, model: "unit-test", safetyMarginTokens: 0 })
    const gated = applyRequestStageTokenGate({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "old ".repeat(1000) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: gated.report,
      trigger: "mid_turn_pressure",
      now: 100,
    })

    expect(compact?.initialContextReinjection).toBe("mid_turn_insert")
    expect(formatCompactionRecord(compact!)).toContain("trigger=mid_turn_pressure")
    expect(formatCompactionRecord(compact!)).toContain("retained=3")
    expect(formatCompactionRecord(compact!)).toContain("reinject=mid_turn_insert")
  })

  test("does not create compact metadata when context pressure is low", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 })
    const report = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "short" },
      ],
      model: "unit-test",
      contextWindow,
    })

    expect(shouldCreateCompactionCandidate(report)).toBe(false)
    expect(buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: report,
      now: 100,
    })).toBeUndefined()
  })

  test("builds append-only persistent compact events that can be recovered from session events", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 40, model: "unit-test", safetyMarginTokens: 0 })
    const gated = applyRequestStageTokenGate({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "old ".repeat(1000) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const worldState = buildConversationContextState({
      sessionID: "world-compact",
      events: [
        {
          type: "world_baseline",
          worldBaseline: {
            id: "world-compact-1",
            workspaceRoot: "/repo",
            gitHead: "abc123",
            settingsHash: "settings-a",
            ragIndexVersion: "rag-a",
            toolVersionHash: "tools-a",
            model: "unit-test",
            createdAt: 1,
          },
        },
        ...fixtureEvents(),
      ],
      now: 100,
    })
    const compact = buildCompactionCandidate({ state: worldState, budgetReport: gated.report, now: 100 })
    const event = buildContextCompactionEvent({
      compaction: compact!,
      status: "completed",
      historyVersion: 2,
      baseEventId: "a3",
      sourceModel: "unit-test",
      sourceWindow: "manual",
      compactPromptSource: "default",
      omittedMessageIds: ["a1", "a2"],
      baselineMetadata: contextCompactionBaselineMetadata({
        state: worldState,
        sourceModel: "unit-test",
        sourceWindow: "manual",
      }),
      now: 110,
    })
    const original = fixtureEvents()
    const events = appendContextCompactionEvent(original, event)

    expect(original).toHaveLength(7)
    expect(events).toHaveLength(8)
    expect(contextCompactionEventsFromSessionEvents([...events, { type: "context_compaction", contextCompaction: { id: "bad" } }])).toHaveLength(1)
    expect(latestContextCompactionEvent(events)?.status).toBe("completed")
    expect(latestContextCompactionEvent(events)?.historyVersion).toBe(2)
    expect(latestContextCompactionEvent(events)?.replacementHistory.at(-1)?.kind).toBe("compaction_summary")
    expect(latestContextCompactionEvent(events)?.omittedMessageIds).toEqual(["a1", "a2"])
    expect(latestContextCompactionEvent(events)?.initialContextReinjection).toBe("next_turn_full")
    expect(latestContextCompactionEvent(events)?.baselineMetadata).toMatchObject({
      source: "world_baseline",
      workspaceRoot: "/repo",
      gitHead: "abc123",
      settingsHash: "settings-a",
      ragIndexVersion: "rag-a",
      sourceModel: "unit-test",
      sourceWindow: "manual",
      fullReinjectRequired: false,
    })
    expect(formatContextCompactionEventRecord(event.contextCompaction)).toContain("reinject=next_turn_full")
    expect(formatContextCompactionEventRecord(event.contextCompaction)).toContain("baseline=world_baseline")
  })

  test("records compact lifecycle items and runs compact hooks with stop semantics", async () => {
    const started = buildContextCompactionLifecycleEvent({
      compactionId: "compact-test",
      status: "started",
      trigger: "manual",
      now: 120,
    })
    const completed = buildContextCompactionLifecycleEvent({
      compactionId: "compact-test",
      status: "completed",
      trigger: "manual",
      now: 121,
      completedAt: 122,
    })
    const calls: string[] = []
    const continueOutcome = await runCompactHooks([], { compactionId: "compact-test", trigger: "manual", phase: "manual" })
    const stoppedOutcome = await runCompactHooks([
      (context) => {
        expect(context.compaction?.id).toBe("compact-test")
        calls.push(`${context.compactionId}:${context.phase}`)
      },
      () => ({ status: "stopped", reason: "unit test stop" }),
      () => {
        calls.push("should-not-run")
      },
    ], { compactionId: "compact-test", trigger: "manual", phase: "manual", compaction: {
      ...buildCompactionCandidate({
        state: fixtureState(),
        budgetReport: {
          ...buildContextPackShadowReport({
            messages: [{ role: "system", content: "system" }, { role: "user", content: "latest" }],
            model: "unit-test",
            contextWindow: resolveChatContextWindow({ configuredContextLength: 10, model: "unit-test", safetyMarginTokens: 0 }),
          }),
          truncated: true,
          omittedMessages: 1,
          omittedEstimatedTokens: 10,
          reason: "unit test compact",
        },
        now: 123,
      })!,
      id: "compact-test",
    } })
    const errorOutcome = await runCompactHooks([
      () => {
        throw new Error("hook exploded\nwith detail")
      },
    ], { compactionId: "compact-test", trigger: "manual", phase: "manual" })

    expect(started.contextCompactionLifecycle.status).toBe("started")
    expect(completed.contextCompactionLifecycle.completedAt).toBe(122)
    expect(continueOutcome).toEqual({ status: "continue" })
    expect(stoppedOutcome).toEqual({ status: "stopped", reason: "unit test stop" })
    expect(errorOutcome).toEqual({ status: "error", reason: "hook exploded with detail" })
    expect(calls).toEqual(["compact-test:manual"])
  })

  test("formats persistent compact event telemetry for all v1 statuses", () => {
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: {
        ...buildContextPackShadowReport({
          messages: [
            { role: "system", content: "system" },
            { role: "user", content: "latest" },
          ],
          model: "unit-test",
          contextWindow: resolveChatContextWindow({ configuredContextLength: 10, model: "unit-test", safetyMarginTokens: 0 }),
        }),
        truncated: true,
        omittedMessages: 2,
        omittedEstimatedTokens: 20,
        reason: "request-stage token gate pruned lower-priority context sections",
      },
      now: 150,
    })!
    const statuses = ["completed", "failed", "interrupted", "fallback_pruned"] as const
    const lines = statuses.map((status, index) => formatContextCompactionEventRecord(buildContextCompactionEvent({
      compaction: compact,
      status,
      historyVersion: 2 + index,
      implementation: status === "fallback_pruned" ? "fallback_pruned" : "local_summary",
      strategy: status === "fallback_pruned" ? "fallback_pruned" : "local_summary",
      phase: "request_stage",
      failureReason: status === "failed" ? "summary model failed\nretry later" : undefined,
      fallbackReason: status === "fallback_pruned" ? compact.fallbackReason : undefined,
      now: 160 + index,
    }).contextCompaction))

    expect(lines).toHaveLength(4)
    for (const status of statuses) {
      expect(lines.some((line) => line.includes(`status=${status}`))).toBe(true)
    }
    expect(lines[0]).toContain("reason=request_stage_truncated")
    expect(lines[0]).toContain("implementation=local_summary")
    expect(lines[0]).toContain("phase=request_stage")
    expect(lines[0]).toContain("durationMs=")
    expect(lines[1]).toContain("failure=summary model failed retry later")
    expect(lines[3]).toContain("implementation=fallback_pruned")
    expect(lines[3]).toContain("fallback=request-stage token gate pruned lower-priority context sections")
  })

  test("routes local summary token-budget and fallback compaction strategies", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 1000, model: "unit-test", safetyMarginTokens: 0 })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "context ".repeat(80) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const softReport = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: softEffectiveWindowForReport(baseReport),
      },
    }
    const candidate = buildCompactionCandidate({ state: fixtureState(), budgetReport: softReport, now: 210 })!
    const fallback = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: {
        ...softReport,
        truncated: true,
        omittedMessages: 2,
        omittedEstimatedTokens: 20,
        reason: "unit fallback",
      },
      now: 211,
    })!

    const local = chooseCompactionStrategy({ compaction: candidate, modelSummaryAvailable: true })
    const tokenBudget = chooseCompactionStrategy({ compaction: candidate, modelSummaryAvailable: false })
    const forcedTokenBudget = chooseCompactionStrategy({ compaction: candidate, modelSummaryAvailable: true, preferTokenBudget: true })
    const fallbackDecision = chooseCompactionStrategy({ compaction: fallback, modelSummaryAvailable: true })

    expect(local).toMatchObject({
      implementation: "local_summary",
      strategy: "local_summary",
      requiresModelSummary: true,
      compactPromptSource: "default",
      phase: "pre_turn",
    })
    expect(tokenBudget).toMatchObject({
      implementation: "token_budget",
      strategy: "token_budget",
      requiresModelSummary: false,
      compactPromptSource: "not_used",
    })
    expect(forcedTokenBudget.implementation).toBe("token_budget")
    expect(fallbackDecision).toMatchObject({
      implementation: "fallback_pruned",
      strategy: "fallback_pruned",
      status: "fallback_pruned",
      phase: "request_stage",
      requiresModelSummary: false,
      compactPromptSource: "not_used",
    })
    expect(formatCompactionStrategyDecision(candidate, tokenBudget)).toContain("implementation=token_budget")
    expect(formatCompactionStrategyDecision(candidate, tokenBudget)).toContain("requiresModelSummary=false")
  })

  test("skips redundant soft compact when latest completed event already covers unchanged pressure", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 1000, model: "unit-test", safetyMarginTokens: 0 })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "context ".repeat(80) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const softReport = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: softEffectiveWindowForReport(baseReport),
      },
    }
    const candidate = buildCompactionCandidate({ state: fixtureState(), budgetReport: softReport, now: 230 })!
    const completed = buildContextCompactionEvent({
      compaction: compactStateWithModelSummary(candidate, parseCompactSummaryModelOutput(JSON.stringify({
        summary: "Current objective: Keep context parity moving.",
        nextActions: ["Continue without repeating compact"],
        risks: ["Repeated compact may waste provider calls"],
      })), 231),
      status: "completed",
      historyVersion: 2,
      now: 232,
    }).contextCompaction
    const samePressure = {
      ...candidate,
      id: "compact-same-pressure",
      window: {
        ...candidate.window,
        activeTokens: candidate.window.activeTokens,
        scopeTokens: candidate.window.scopeTokens,
      },
    }
    const increasedPressure = {
      ...candidate,
      id: "compact-increased-pressure",
      window: {
        ...candidate.window,
        activeTokens: (candidate.window.activeTokens ?? candidate.beforeTokens) + 1,
        scopeTokens: (candidate.window.scopeTokens ?? candidate.beforeTokens) + 1,
      },
    }
    const truncated = {
      ...candidate,
      id: "compact-truncated",
      trigger: "request_stage_truncated" as const,
    }

    expect(shouldSkipRedundantCompaction({
      compaction: samePressure,
      latestCompleted: completed,
      currentHistoryVersion: 1,
    })).toMatchObject({
      skip: true,
      coveredById: completed.id,
    })
    expect(shouldSkipRedundantCompaction({
      compaction: increasedPressure,
      latestCompleted: completed,
      currentHistoryVersion: 1,
    }).skip).toBe(false)
    expect(shouldSkipRedundantCompaction({
      compaction: truncated,
      latestCompleted: completed,
      currentHistoryVersion: 1,
    }).skip).toBe(false)
  })

  test("token-budget compact writes lifecycle and completed event without model summary", () => {
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 1000, model: "unit-test", safetyMarginTokens: 0 })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "context ".repeat(80) },
        { role: "user", content: "latest" },
      ],
      model: "unit-test",
      contextWindow,
    })
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: {
        ...baseReport,
        contextWindow: {
          ...baseReport.contextWindow,
          effectiveContextWindow: softEffectiveWindowForReport(baseReport),
        },
      },
      now: 220,
    })!
    const decision = chooseCompactionStrategy({ compaction: compact, modelSummaryAvailable: false })
    const freshWindowState = compactStateWithTokenBudgetFreshWindow(compact)
    const started = buildContextCompactionLifecycleEvent({
      compactionId: freshWindowState.id,
      status: "started",
      trigger: freshWindowState.trigger,
      phase: decision.phase,
      now: 221,
      message: decision.lifecycleStartMessage,
    })
    const completed = buildContextCompactionLifecycleEvent({
      compactionId: freshWindowState.id,
      status: "completed",
      trigger: freshWindowState.trigger,
      phase: decision.phase,
      now: 222,
      completedAt: 222,
      message: decision.lifecycleCompletedMessage,
    })
    const event = buildContextCompactionEvent({
      compaction: freshWindowState,
      status: decision.status,
      historyVersion: 6,
      implementation: decision.implementation,
      strategy: decision.strategy,
      reason: decision.reason,
      phase: decision.phase,
      compactPromptSource: decision.compactPromptSource,
      lifecycleItemId: completed.contextCompactionLifecycle.id,
      now: 222,
    }).contextCompaction

    expect(started.contextCompactionLifecycle.message).toContain("Token-budget compact")
    expect(completed.contextCompactionLifecycle.message).toContain("without model summary")
    expect(event).toMatchObject({
      status: "completed",
      implementation: "token_budget",
      strategy: "token_budget",
      compactPromptSource: "not_used",
    })
    expect(event.summary).toContain("without a model-generated summary")
    expect(event.replacementHistory.every((item) => item.kind !== "compaction_summary")).toBe(true)
    expect(event.replacementHistory.some((item) => item.kind === "initial_context")).toBe(true)
    expect(compactedHistoryMessagesFromEvent(event).some((message) => message.kind === "compaction_summary")).toBe(false)
    expect(JSON.stringify(compactedHistoryMessagesFromEvent(event))).toContain("<chipmate-high-priority-state")
  })

  test("adapts only completed compact events into provider-safe replacement history", () => {
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: {
        ...buildContextPackShadowReport({
          messages: [
            { role: "system", content: "system" },
            { role: "user", content: "latest" },
          ],
          model: "unit-test",
          contextWindow: resolveChatContextWindow({ configuredContextLength: 10, model: "unit-test", safetyMarginTokens: 0 }),
        }),
        truncated: true,
        omittedMessages: 3,
        omittedEstimatedTokens: 30,
        reason: "unit test compact",
      },
      now: 170,
    })!
    const completed = buildContextCompactionEvent({
      compaction: {
        ...compact,
        replacementHistory: [
          ...compact.replacementHistory,
          {
            id: "init:system",
            kind: "initial_context",
            role: "system",
            content: "Workspace baseline",
            source: "initial_context",
          },
          {
            id: "summary:duplicate",
            kind: "compaction_summary",
            role: "assistant",
            content: "Duplicate summary should be skipped because only one summary is provider-visible",
            source: "compaction_summary",
          },
          {
            id: "summary:duplicate",
            kind: "compaction_summary",
            role: "assistant",
            content: "Duplicate id should be skipped",
            source: "compaction_summary",
          },
          {
            id: "tool:orphan",
            kind: "retained_user_message",
            role: "tool",
            content: "orphan tool output should not become chat history",
            source: "history_transcript",
          } as unknown as ReplacementHistoryItem,
          {
            id: "image:unsupported",
            kind: "retained_user_message",
            role: "user",
            content: { type: "image", image_url: "file:///tmp/unsupported.png" },
            source: "history_transcript",
          } as unknown as ReplacementHistoryItem,
        ],
      },
      status: "completed",
      historyVersion: 4,
      now: 180,
    }).contextCompaction
    const fallback = buildContextCompactionEvent({
      compaction: compact,
      status: "fallback_pruned",
      historyVersion: 5,
      now: 181,
    }).contextCompaction

    const snapshot = buildCompactedHistoryAdapterSnapshot(completed)
    const messages = compactedHistoryMessagesFromEvent(completed)
    const diagnosticCodes = snapshot.diagnostics.map((item) => item.code)

    expect(compactedHistoryMessagesFromEvent(fallback)).toEqual([])
    expect(messages).toEqual(snapshot.messages)
    expect(messages.length).toBe(6)
    expect(messages.every((message) => message.role !== "system")).toBe(true)
    expect(messages.filter((message) => message.kind === "retained_user_message").map((message) => message.role)).toEqual(["user", "user", "user"])
    expect(messages.filter((message) => message.kind === "initial_context")).toHaveLength(2)
    expect(messages.find((message) => message.kind === "initial_context")).toMatchObject({
      role: "user",
      content: expect.stringContaining("not as a new user request"),
    })
    const summaries = messages.filter((message) => message.kind === "compaction_summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.role).toBe("assistant")
    expect(summaries[0]?.content).toContain("ChipMate compacted conversation continuity context")
    expect(summaries[0]?.content).toContain("not as a new user request")
    expect(summaries[0]?.content).toContain('historyVersion="4"')
    expect(JSON.stringify(messages)).not.toContain("orphan tool output")
    expect(JSON.stringify(messages)).not.toContain("unsupported.png")
    expect(diagnosticCodes).toEqual(expect.arrayContaining([
      "system_role_normalized",
      "duplicate_compaction_summary",
      "duplicate_replacement_item",
      "orphan_tool_output_removed",
      "unsupported_modality_normalized",
    ]))
  })

  test("does not treat rolling memory summaries as compact replacement history", () => {
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: {
        ...buildContextPackShadowReport({
          messages: [{ role: "system", content: "system" }, { role: "user", content: "latest" }],
          model: "unit-test",
          contextWindow: resolveChatContextWindow({ configuredContextLength: 10, model: "unit-test", safetyMarginTokens: 0 }),
        }),
        truncated: true,
        omittedMessages: 1,
        omittedEstimatedTokens: 10,
        reason: "unit test compact",
      },
      now: 190,
    })!
    const memoryLikeCompact = {
      type: "memory",
      memory: {
        id: "memory-looks-like-compact",
        summary: "ChipMate compacted conversation continuity context but this is only rolling memory.",
        replacementHistory: compact.replacementHistory,
        contextCompaction: buildContextCompactionEvent({
          compaction: compact,
          status: "completed",
          historyVersion: 7,
          now: 191,
        }).contextCompaction,
      },
    }
    const failedCompact = buildContextCompactionEvent({
      compaction: { ...compact, status: "failed", failureReason: "quality gate failed" },
      status: "failed",
      historyVersion: 8,
      failureReason: "quality gate failed",
      now: 192,
    })
    const completed = buildContextCompactionEvent({
      compaction: compact,
      status: "completed",
      historyVersion: 9,
      now: 193,
    })

    expect(contextCompactionEventsFromSessionEvents([memoryLikeCompact])).toEqual([])
    expect(latestCompletedContextCompactionEvent([memoryLikeCompact, failedCompact])).toBeUndefined()
    expect(latestCompletedContextCompactionEvent([memoryLikeCompact, failedCompact, completed])?.historyVersion).toBe(9)
  })

  test("builds a bounded compact summary prompt from transcript and high-priority state", () => {
    const longBody = `very long user context ${"A".repeat(5000)} end-of-long-body`
    const state = buildConversationContextState({
      sessionID: "compact-prompt",
      events: [
        { type: "message", message: message("u-long", "user", `User question:\n${longBody}`, 1) },
        {
          type: "message",
          message: {
            info: { id: "a-tools", role: "assistant", time: { created: 2 } },
            parts: [
              { type: "text", text: "Edited and verified with evidence." },
              {
                type: "tool",
                tool: "chipmate_write_file",
                callID: "write-1",
                state: {
                  status: "completed",
                  input: { path: "src/compact-prompt.ts" },
                  output: { summary: "updated compact prompt builder" },
                },
              },
              {
                type: "tool",
                tool: "shell_exec",
                callID: "test-1",
                state: {
                  status: "failed",
                  input: { command: "bun test test/context-compaction.test.ts", cwd: "/repo" },
                  output: { exitCode: 1, stderr: "prompt fixture failed once" },
                },
              },
            ],
          },
        },
        {
          type: "plan",
          plan: {
            id: "plan-compact",
            steps: [{ id: "d1", title: "Design compact summary prompt", status: "in_progress", evidenceRefs: ["a-tools"] }],
            updatedAt: 3,
          },
        },
        {
          type: "evidence",
          evidence: {
            messageID: "a-tools",
            entries: [{
              source: "analysis",
              kind: "code",
              path: "src/context-compaction.ts",
              summary: "prompt builder evidence",
              truncated: false,
              staleness: "current",
            }],
          },
        },
        {
          type: "visual_evidence",
          visualEvidence: {
            id: "visual-compact",
            messageID: "a-tools",
            kind: "word-render-page",
            artifactPath: ".chipmate/render/page-1.png",
            sourceHash: "source-hash",
            fallbackText: "Rendered page fallback summary.",
            page: 1,
            staleness: "current",
          },
        },
      ],
      goal: {
        threadID: "compact-prompt",
        goalID: "goal-compact",
        objective: "Reach compaction parity",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 4,
      },
      now: 5,
    })

    const prompt = buildCompactSummaryPrompt({
      state,
      promptOverride: "Custom compact prompt override.",
      maxMessageChars: 160,
      maxStateChars: 1200,
    })
    const serialized = JSON.stringify(prompt.messages)

    expect(prompt.promptSource).toBe("override")
    expect(prompt.messages.map((message) => message.role)).toEqual(["system", "user"])
    expect(prompt.messages[0]?.content).toBe("Custom compact prompt override.")
    expect(prompt.transcriptMessageCount).toBeGreaterThan(0)
    expect(prompt.truncatedMessageCount).toBeGreaterThan(0)
    expect(serialized).toContain("TaskState:")
    expect(serialized).toContain("PlanState:")
    expect(serialized).toContain("Design compact summary prompt")
    expect(serialized).toContain("FileState:")
    expect(serialized).toContain("src/compact-prompt.ts [written]")
    expect(serialized).toContain("VerificationState:")
    expect(serialized).toContain("FailureState:")
    expect(serialized).toContain("EvidenceState:")
    expect(serialized).toContain("VisualEvidenceFallback:")
    expect(serialized).toContain(".chipmate/render/page-1.png")
    expect(serialized).toContain("[truncated")
    expect(serialized).not.toContain("end-of-long-body")
    expect(serialized).not.toContain("provider.apiBaseUrl")
  })

  test("plans compact-summary overflow retry by trimming oldest transcript messages", () => {
    const events: ConversationContextEvent[] = []
    for (let index = 1; index <= 8; index += 1) {
      events.push({ type: "message", message: message(`u-retry-${index}`, "user", `retry-user-${index}`, index) })
    }
    const state = buildConversationContextState({
      sessionID: "compact-overflow-retry",
      events,
      now: 20,
    })
    const prompt = buildCompactSummaryPrompt({
      state,
      maxTranscriptMessages: 8,
      maxMessageChars: 120,
    })
    const retry = compactSummaryOverflowRetryPlan(prompt)
    const trimmedPrompt = buildCompactSummaryPrompt({
      state,
      maxTranscriptMessages: retry.nextMaxTranscriptMessages,
      maxMessageChars: 120,
    })
    const serialized = JSON.stringify(trimmedPrompt.messages)

    expect(retry).toMatchObject({
      canRetry: true,
      nextMaxTranscriptMessages: 4,
      trimmedOldestMessageCount: 4,
    })
    expect(trimmedPrompt.transcriptMessageCount).toBe(4)
    expect(serialized).not.toContain("retry-user-1")
    expect(serialized).not.toContain("retry-user-4")
    expect(serialized).toContain("retry-user-5")
    expect(serialized).toContain("retry-user-8")
    expect(compactSummaryOverflowRetryPlan(trimmedPrompt).canRetry).toBe(true)
    const oneMessage = buildCompactSummaryPrompt({ state, maxTranscriptMessages: 1 })
    expect(compactSummaryOverflowRetryPlan(oneMessage)).toMatchObject({ canRetry: false })
  })

  test("parses model compact summary output and replaces scaffold summary history", () => {
    const baseReport = buildContextPackShadowReport({
      messages: [{ role: "system", content: "system" }, { role: "user", content: `latest ${"body ".repeat(500)}` }],
      model: "unit-test",
      contextWindow: resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 }),
    })
    const report = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: softEffectiveWindowForReport(baseReport),
      },
    }
    const compact = buildCompactionCandidate({
      state: fixtureState(),
      budgetReport: report,
      now: 200,
    })!
    const parsed = parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Model generated compact summary.",
      retainedUserMessageIds: ["u3"],
      nextActions: ["Implement D2"],
      risks: ["D3 quality gate is not complete"],
      stateCoverage: ["TaskState", "FileState"],
      omissions: ["Full old transcript"],
    }))
    const completed = compactStateWithModelSummary(compact, parsed, 201)
    const compactedMessages = compactedHistoryMessagesFromEvent(buildContextCompactionEvent({
      compaction: completed,
      status: "completed",
      historyVersion: 5,
      compactPromptSource: "default",
      now: 202,
    }).contextCompaction)

    expect(parsed.parsedJson).toBe(true)
    expect(parsed.summary).toBe("Model generated compact summary.")
    expect(completed.status).toBe("completed")
    expect(completed.summary).toBe("Model generated compact summary.")
    expect(completed.replacementHistory.filter((item) => item.kind === "compaction_summary")).toHaveLength(1)
    expect(completed.replacementHistory.at(-1)?.content).toContain("Next actions:")
    expect(completed.replacementHistory.at(-1)?.content).toContain("State coverage:")
    expect(JSON.stringify(compactedMessages)).toContain("Model generated compact summary.")
    expect(JSON.stringify(compactedMessages)).not.toContain("Compacted ChipMate conversation context.")
  })

  test("preserves high-priority task file verification failure and correction state in long-session replacement history", () => {
    const events: ConversationContextEvent[] = []
    for (let index = 1; index <= 32; index += 1) {
      events.push({ type: "message", message: message(`u-long-${index}`, "user", `User question:\nold filler request ${index} ${"noise ".repeat(20)}`, index * 2) })
      events.push({ type: "message", message: message(`a-long-${index}`, "assistant", `old filler answer ${index} ${"details ".repeat(20)}`, index * 2 + 1) })
    }
    events.push({ type: "message", message: message("u-correction", "user", "必须保留用户纠偏：不要把失败验证当成通过。", 100) })
    events.push({
      type: "message",
      message: {
        info: { id: "a-state", role: "assistant", time: { created: 101 } },
        parts: [
          { type: "text", text: "Updated stateful file and verification failed." },
          {
            type: "tool",
            tool: "chipmate_write_file",
            callID: "write-state",
            state: {
              status: "completed",
              input: { path: "src/stateful-context.ts" },
              output: { summary: "wrote stateful context guard" },
            },
          },
          {
            type: "tool",
            tool: "shell_exec",
            callID: "verify-state",
            state: {
              status: "failed",
              input: { command: "bun test test/stateful-context.test.ts", cwd: "/repo" },
              output: { exitCode: 1, stderr: "expected true to be false" },
            },
          },
        ],
      },
    })
    const state = buildConversationContextState({
      sessionID: "long-state",
      events,
      goal: {
        threadID: "long-state",
        goalID: "goal-long-state",
        objective: "Preserve high-priority compaction state",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 102,
      },
      now: 103,
    })
    const baseReport = buildContextPackShadowReport({
      messages: [
        { role: "system", content: "system" },
        { role: "assistant", content: "oversized ".repeat(4000) },
        { role: "user", content: "continue" },
      ],
      model: "unit-test",
      contextWindow: resolveChatContextWindow({ configuredContextLength: 10_000, model: "unit-test", safetyMarginTokens: 0 }),
    })
    const report = {
      ...baseReport,
      contextWindow: {
        ...baseReport.contextWindow,
        effectiveContextWindow: softEffectiveWindowForReport(baseReport),
      },
    }
    const compact = buildCompactionCandidate({
      state,
      budgetReport: report,
      retainedUserMaxTokens: 1,
      retainedUserMaxMessages: 1,
      now: 230,
    })!
    const parsed = parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Current objective: Preserve high-priority compaction state.",
      nextActions: ["Continue after compact"],
      risks: ["Some high-priority state may be omitted by the model summary"],
      stateCoverage: ["TaskState"],
      omissions: ["Raw old filler turns"],
    }))
    const completed = compactStateWithModelSummary(compact, parsed, 231)
    const event = buildContextCompactionEvent({
      compaction: completed,
      status: "completed",
      historyVersion: 12,
      compactPromptSource: "default",
      now: 232,
    }).contextCompaction
    const compactedMessages = compactedHistoryMessagesFromEvent(event)
    const serialized = JSON.stringify(compactedMessages)

    expect(compact.retainedMessageIds).toEqual(["u-correction"])
    expect(serialized).toContain("<chipmate-high-priority-state")
    expect(serialized).toContain("Preserve high-priority compaction state")
    expect(serialized).toContain("PlanState:")
    expect(serialized).toContain("goal-objective")
    expect(serialized).toContain("必须保留用户纠偏：不要把失败验证当成通过。")
    expect(serialized).toContain("FileState:")
    expect(serialized).toContain("src/stateful-context.ts")
    expect(serialized).toContain("VerificationState:")
    expect(serialized).toContain("bun test test/stateful-context.test.ts")
    expect(serialized).toContain("FailureState:")
    expect(serialized).toContain("expected true to be false")
    expect(serialized).not.toContain("old filler request 1")
    expect(serialized).not.toContain("old filler answer 1")
  })

  test("gates compact summary quality before completed event persistence", () => {
    const state = fixtureState()
    const good = parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Current objective: Keep context parity moving. Preserve task, file, verification, evidence, and failure state.",
      nextActions: ["Implement D3 summary quality gate"],
      risks: ["D4 failure event persistence is still pending"],
      stateCoverage: ["TaskState", "VerificationState"],
      omissions: ["Old raw transcript details"],
    }))
    const missingObjective = parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Generic compact summary without the goal.",
      nextActions: ["Continue"],
      risks: ["Some risk"],
    }))
    const missingNextActions = parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Current objective: Keep context parity moving.",
      risks: ["Some risk"],
    }))
    const tooLarge = parseCompactSummaryModelOutput(JSON.stringify({
      summary: `Current objective: Keep context parity moving. ${"x".repeat(2000)}`,
      nextActions: ["Continue"],
      risks: ["Some risk"],
    }))

    expect(validateCompactSummaryQuality({ result: good, state }).ok).toBe(true)
    expect(validateCompactSummaryQuality({ result: missingObjective, state }).issues.map((issue) => issue.code)).toContain("missing_current_objective")
    expect(validateCompactSummaryQuality({ result: missingNextActions, state }).issues.map((issue) => issue.code)).toContain("missing_next_actions")
    expect(validateCompactSummaryQuality({ result: tooLarge, state, maxBytes: 512 }).issues.map((issue) => issue.code)).toContain("summary_too_large")
    expect(validateCompactSummaryQuality({
      result: parseCompactSummaryModelOutput("!!!! #### ???? %%%% //// !!!! #### ???? %%%% ////"),
      state: buildConversationContextState({ sessionID: "no-goal", events: [], now: 1 }),
    }).issues.map((issue) => issue.code)).toContain("summary_gibberish")
  })

  test("treats compact session events as known context events without polluting transcript", () => {
    const compactEvent = buildContextCompactionEvent({
      compaction: buildCompactionCandidate({
        state: fixtureState(),
        budgetReport: {
          ...buildContextPackShadowReport({
            messages: [
              { role: "system", content: "system" },
              { role: "user", content: "latest" },
            ],
            model: "unit-test",
            contextWindow: resolveChatContextWindow({ configuredContextLength: 10, model: "unit-test", safetyMarginTokens: 0 }),
          }),
          truncated: true,
          omittedMessages: 1,
          omittedEstimatedTokens: 10,
          reason: "unit test compact",
        },
        now: 130,
      })!,
      status: "fallback_pruned",
      historyVersion: 2,
      now: 131,
    })
    const state = buildConversationContextState({
      sessionID: "s1",
      events: [...fixtureEvents(), compactEvent, buildContextCompactionLifecycleEvent({
        compactionId: compactEvent.contextCompaction.id,
        status: "completed",
        trigger: "request_stage_truncated",
        now: 132,
      })],
      now: 140,
    })

    expect(state.diagnostics.map((item) => item.message).join("\n")).not.toContain("context_compaction")
    expect(state.transcript.visibleItemCount).toBe(6)
  })
})

function fixtureEvents(): ConversationContextEvent[] {
  return [
    { type: "message", message: message("u1", "user", "User question:\nFirst request", 1) },
    { type: "message", message: message("a1", "assistant", "First answer", 2) },
    { type: "message", message: message("u2", "user", "User question:\nSecond request", 3) },
    { type: "message", message: message("a2", "assistant", "Second answer", 4) },
    { type: "message", message: message("u3", "user", "User question:\n必须保留用户纠偏。", 5) },
    { type: "message", message: message("a3", "assistant", "Third answer", 6) },
    {
      type: "memory",
      memory: {
        id: "memory-1",
        summary: "Older work exists.",
        coveredMessageIDs: ["u1"],
        updatedAt: 7,
      },
    },
  ]
}

function fixtureState() {
  return buildConversationContextState({
    sessionID: "s1",
    events: fixtureEvents(),
    goal: {
      threadID: "s1",
      goalID: "goal-1",
      objective: "Keep context parity moving",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 8,
    },
    now: 100,
  })
}

function message(id: string, role: "user" | "assistant", text: string, created: number): ChipMateMessage {
  return {
    info: { id, role, time: { created } },
    parts: [{ type: "text", text }],
  }
}

function bodyTokensForReport(report: ReturnType<typeof buildContextPackShadowReport>) {
  const prefillTokens = report.sections
    .filter((section) => section.id === "system_prompt" || section.id === "task_state")
    .reduce((sum, section) => sum + section.tokens, 0)
  return Math.max(1, report.totalEstimatedTokens - prefillTokens)
}

function softEffectiveWindowForReport(report: ReturnType<typeof buildContextPackShadowReport>) {
  return Math.max(report.totalEstimatedTokens + 1, Math.floor(bodyTokensForReport(report) / 0.91))
}
