import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildCompactionCandidate, buildContextCompactionEvent, compactStateWithModelSummary, parseCompactSummaryModelOutput } from "../src/context-compaction"
import { buildContextSummarySnapshot } from "../src/context-summary"
import { buildConversationContextState, type ConversationContextEvent } from "../src/conversation-context"
import { DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS, resolveChatContextWindow } from "../src/context-window"
import type { ContextPackBudgetReport } from "../src/context-pack"
import type { ChipMateMessage } from "../src/types"

describe("context summary parity UI model", () => {
  test("aggregates task, plan, evidence, budget, fallback, compact and rollback state", () => {
    const state = buildConversationContextState({
      sessionID: "session-summary",
      events: [
        { type: "message", message: message("u1", "user", "User question:\nBuild summary", 1) },
        { type: "message", message: message("a1", "assistant", "Failed", 2, { error: { message: "test failed" } }) },
        {
          type: "plan",
          plan: {
            id: "plan-1",
            steps: [{ id: "h1", title: "Context Summary model", status: "in_progress" }],
            updatedAt: 3,
          },
        },
        {
          type: "evidence",
          evidence: {
            messageID: "a1",
            entries: [{
              source: "analysis",
              kind: "code",
              path: "src/context-summary.ts",
              summary: "summary state",
              truncated: false,
              staleness: "stale",
            }],
          },
        },
        {
          type: "rollback",
          rollback: {
            id: "rollback-1",
            rolledBackMessageIDs: [],
            fullReinjectRequired: true,
            createdAt: 4,
          },
        },
      ],
      now: 5,
    })
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 0, model: "unknown-private-compatible-model" })
    const budgetReport: ContextPackBudgetReport = {
      source: "request-stage-token-gate",
      model: "unknown-private-compatible-model",
      messageCount: 3,
      totalEstimatedTokens: 260000,
      totalBytes: 1000,
      contextWindow,
      sections: [{ id: "task_state", label: "system", priority: 95, tokens: 1000, bytes: 200, truncated: true, reason: "test" }],
      omittedMessages: 2,
      omittedEstimatedTokens: 5000,
      truncated: true,
      reason: "request-stage token gate pruned lower-priority context sections",
    }
    const compaction = buildCompactionCandidate({ state, budgetReport, now: 6 })
    const summary = buildContextSummarySnapshot({
      state,
      budgetReport,
      contextWindow,
      compaction,
      now: 7,
    })

    expect(summary.version).toBe(1)
    expect(summary.fallbackNotice).toContain(String(DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS))
    expect(summary.rollbackWarning).toContain("Rollback requires full initial context reinjection")
    expect(summary.compactWarning).toContain("Context was pruned")
    expect(summary.sections.map((section) => section.id)).toContain("task")
    expect(summary.sections.map((section) => section.id)).toContain("evidence")
    expect(summary.sections.find((section) => section.id === "budget")).toMatchObject({
      severity: "warning",
      omitted: 2,
    })
    expect(summary.sections.find((section) => section.id === "window")?.value).toBe(`${DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS} tokens`)
  })

  test("webview exposes a read-only Liquid Glass Context Summary entry point", () => {
    const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
    const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")

    expect(chatViewSource).toContain("contextSummary: this.webviewContextSummary(settings)")
    expect(chatViewSource).toContain("private webviewContextSummary(settings: RemoteSettings): ContextSummarySnapshot")
    expect(chatViewSource).toContain("getLatestContextCompaction(sessionID, signal)")
    expect(chatViewSource).toContain("this.contextCompactionBySession.get(this.sessionID)")
    expect(chatHtmlSource).toContain("renderContextSummaryRows(root)")
    expect(chatHtmlSource).toContain("Context Summary")
    expect(chatHtmlSource).toContain("Window fallback:")
    expect(chatHtmlSource).toContain("Rollback:")
    expect(chatHtmlSource).toContain("Compact:")
  })

  test("renders persisted completed compact status with summary age telemetry and long-thread warning", () => {
    const state = buildConversationContextState({
      sessionID: "session-compact-completed",
      events: [{ type: "message", message: message("u1", "user", "User question:\nKeep compact visible", 1) }],
      now: 2,
    })
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 100, model: "unit-test", safetyMarginTokens: 0 })
    const budgetReport: ContextPackBudgetReport = {
      source: "request-stage-token-gate",
      model: "unit-test",
      messageCount: 2,
      totalEstimatedTokens: 95,
      totalBytes: 1000,
      contextWindow,
      sections: [],
      omittedMessages: 0,
      omittedEstimatedTokens: 0,
      truncated: false,
    }
    const candidate = buildCompactionCandidate({ state, budgetReport, now: 10 })!
    const completedState = compactStateWithModelSummary(candidate, parseCompactSummaryModelOutput(JSON.stringify({
      summary: "Completed compact summary for Context Summary UI.",
      retainedUserMessageIds: ["u1"],
      nextActions: ["Continue after compact"],
      risks: ["Long thread accuracy may drift"],
      stateCoverage: ["TaskState"],
      omissions: ["Older raw transcript"],
    })), 11)
    const completed = buildContextCompactionEvent({
      compaction: completedState,
      status: "completed",
      historyVersion: 4,
      reason: "soft_threshold",
      implementation: "local_summary",
      strategy: "local_summary",
      phase: "pre_turn",
      sourceWindow: "configured",
      now: 12_000,
    }).contextCompaction

    const summary = buildContextSummarySnapshot({ contextWindow, compaction: completed, now: 15_000 })
    const compact = summary.sections.find((section) => section.id === "compact")

    expect(summary.compactWarning).toContain("Context has been compacted")
    expect(summary.compactWarning).toContain("start a new session")
    expect(compact).toMatchObject({
      severity: "info",
      value: "soft_threshold completed",
      omitted: completed.omittedMessageCount,
    })
    expect(compact?.detail).toContain("strategy=local_summary")
    expect(compact?.detail).toContain("implementation=local_summary")
    expect(compact?.detail).toContain("phase=pre_turn")
    expect(compact?.detail).toContain("historyVersion=4")
    expect(compact?.detail).toContain("summaryAge=3s")
    expect(compact?.detail).toContain("tokens=")
    expect(compact?.detail).toContain("sourceWindow=configured")
  })

  test("marks failed compaction as degraded but non-blocking context state", () => {
    const state = buildConversationContextState({
      sessionID: "session-compact-failed",
      events: [{ type: "message", message: message("u1", "user", "User question:\nBuild summary", 1) }],
      now: 2,
    })
    const contextWindow = resolveChatContextWindow({ configuredContextLength: 100, model: "unit-test", safetyMarginTokens: 0 })
    const budgetReport: ContextPackBudgetReport = {
      source: "request-stage-token-gate",
      model: "unit-test",
      messageCount: 2,
      totalEstimatedTokens: 95,
      totalBytes: 1000,
      contextWindow,
      sections: [],
      omittedMessages: 0,
      omittedEstimatedTokens: 0,
      truncated: false,
    }
    const compaction = {
      ...buildCompactionCandidate({ state, budgetReport, now: 3 })!,
      status: "failed" as const,
      failureReason: "Compact summary quality gate failed: missing_next_actions",
    }
    const summary = buildContextSummarySnapshot({ state, budgetReport, contextWindow, compaction, now: 4 })

    expect(summary.compactWarning).toContain("Compact failed")
    expect(summary.compactWarning).toContain("missing_next_actions")
    expect(summary.sections.find((section) => section.id === "compact")).toMatchObject({
      severity: "warning",
      value: "soft_threshold failed",
      detail: expect.stringContaining("failure=Compact summary quality gate failed"),
    })
  })

  test("parity eval fixture keeps 30 plus turns, rollback, stale evidence, visual fallback and verification visible", () => {
    const events: ConversationContextEvent[] = [
      {
        type: "world_baseline",
        worldBaseline: {
          id: "world-1",
          workspaceRoot: "/repo",
          gitHead: "abc123",
          createdAt: 1,
        },
      },
    ]
    for (let turn = 1; turn <= 31; turn += 1) {
      events.push({ type: "message", message: message(`u${turn}`, "user", `User question:\nContinue parity turn ${turn}`, turn * 2) })
      events.push({ type: "message", message: message(`a${turn}`, "assistant", `Completed turn ${turn}`, turn * 2 + 1) })
    }
    events.push({
      type: "message",
      message: {
        info: { id: "a-test", role: "assistant", time: { created: 80 } },
        parts: [
          { type: "text", text: "Verification failed" },
          {
            type: "tool",
            tool: "shell_exec",
            callID: "verify-1",
            state: {
              status: "failed",
              input: { command: "bun test test/context-summary.test.ts", cwd: "/repo" },
              output: { exitCode: 1, stderr: "expected parity", path: "src/context-summary.ts" },
            },
          },
        ],
      },
    })
    events.push({
      type: "evidence",
      evidence: {
        messageID: "a-test",
        entries: [{
          source: "rag",
          kind: "doc",
          path: "docs/stale.md",
          summary: "stale RAG fact",
          truncated: false,
          staleness: "stale",
        }],
      },
    })
    events.push({
      type: "visual_evidence",
      visualEvidence: {
        id: "visual-1",
        title: "Context Summary screenshot",
        artifactPath: ".chipmate/context-summary.png",
        sourceHash: "hash",
        coverage: "context-summary",
        staleness: "unknown",
      },
    })
    events.push({
      type: "rollback",
      rollback: {
        id: "rollback-31",
        rolledBackMessageIDs: ["a31"],
        rolledBackTurnIDs: ["a31"],
        createdAt: 90,
      },
    })

    const state = buildConversationContextState({ sessionID: "parity-30-turn", events, now: 100 })
    const summary = buildContextSummarySnapshot({ state, now: 101 })

    expect(state.transcript.items.filter((item) => item.visibility === "model-visible" && item.role === "user")).toHaveLength(31)
    expect(state.transcript.items.find((item) => item.sourceMessageId === "a31")?.visibility).toBe("omitted")
    expect(state.verification.entries.some((entry) => entry.command === "bun test test/context-summary.test.ts")).toBe(true)
    expect(state.evidence.staleCount).toBe(1)
    expect(state.visualEvidence.entries[0]?.fallbackText).toContain(".chipmate/context-summary.png")
    expect(summary.sections.map((section) => section.id)).toContain("verification")
    expect(summary.sections.find((section) => section.id === "world")?.value).toBe("Full reinject required")
  })
})

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  created: number,
  overrides: Partial<ChipMateMessage["info"]> = {},
): ChipMateMessage {
  return {
    info: {
      id,
      role,
      time: { created },
      ...overrides,
    },
    parts: [{ type: "text", text }],
  }
}
