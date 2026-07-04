import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildTurnRecap,
  buildConversationContextState,
  buildLegacyPromptAssemblyBaseline,
  ConversationContextManager,
  CONVERSATION_CONTEXT_STATE_VERSION,
  renderTaskStateContext,
  type ConversationContextEvent,
} from "../src/conversation-context"
import type { ChipMateMessage } from "../src/types"

describe("conversation context parity scaffold", () => {
  test("captures the legacy prompt assembly baseline and task-state insertion point", () => {
    const baseline = buildLegacyPromptAssemblyBaseline()

    expect(baseline.mode).toBe("read-only-fixture")
    expect(baseline.sections.map((section) => section.id)).toEqual([
      "system_prompt",
      "conversation_memory",
      "evidence_ledger",
      "tool_history",
      "recent_raw_turns",
      "current_user_content",
    ])
    expect(baseline.sections.filter((section) => section.required).map((section) => section.id)).toEqual([
      "system_prompt",
      "current_user_content",
    ])

    const directAgentSource = readFileSync(join(import.meta.dir, "..", "src", "direct-agent-client.ts"), "utf8")
    expect(directAgentSource).toContain("conversationMemoryContextMessage")
    expect(directAgentSource).toContain("evidenceLedgerHistoryMessage")
    expect(directAgentSource).toContain("toolExecutionHistoryMessage")
    expect(directAgentSource).toContain("recentChatHistoryMessages")
    expect(directAgentSource).toContain("conversationTaskStateContextMessage")
    expect(directAgentSource).toContain("buildCompactedHistoryAdapterSnapshot(completedCompact)")
    expect(directAgentSource).toContain("compactInitialContextReinjectionMessage(completedCompact, events, settings)")
    expect(directAgentSource).toContain("return [taskStateMessage, initialContextReinjectionMessage, memoryMessage, evidenceHistoryMessage, toolHistoryMessage, ...history]")
    expect(directAgentSource).toContain("buildConversationContextState")
  })

  test("builds a versioned context state from existing session event shapes", () => {
    const events = fixtureEvents()
    const state = buildConversationContextState({
      sessionID: "session-1",
      events,
      goal: {
        objective: "Implement context parity Batch A",
        status: "running",
        updatedAt: 40,
        turnCount: 2,
      },
      now: 50,
    })

    expect(state.version).toBe(CONVERSATION_CONTEXT_STATE_VERSION)
    expect(state.sessionID).toBe("session-1")
    expect(state.createdAt).toBe(1)
    expect(state.updatedAt).toBe(30)
    expect(state.task.goal?.objective).toBe("Implement context parity Batch A")
    expect(state.memory.latestSummary).toBe("Older turns said: keep scope narrow.")
    expect(state.memory.coveredMessageIDs).toEqual(["m1"])
    expect(state.evidence.entries).toHaveLength(1)
    expect(state.evidence.entries[0]?.summary).toBe("analysis evidence")
    expect(state.visualEvidence.entries).toHaveLength(1)
    expect(state.visualEvidence.entries[0]?.artifactPath).toBe(".chipmate/docs/page-1.png")
  })

  test("maps reusable chat messages into a model-visible transcript with provenance", () => {
    const state = new ConversationContextManager().build({
      sessionID: "session-1",
      events: fixtureEvents(),
      now: 50,
    })

    const visible = state.transcript.items.filter((item) => item.visibility === "model-visible")
    const omitted = state.transcript.items.filter((item) => item.visibility === "omitted")

    expect(state.transcript.historyVersion).toBe(1)
    expect(visible.map((item) => [item.role, item.content])).toEqual([
      ["user", "Explain context state"],
      ["assistant", "Sure."],
    ])
    expect(visible[0]?.provenance).toMatchObject({
      source: "session_event",
      eventType: "message",
      sourceEventId: "m1",
    })
    expect(omitted.map((item) => item.omittedReason)).toEqual([
      "assistant error message is not reusable chat transcript",
      "local document agent history is not reusable chat transcript",
    ])
  })

  test("keeps damaged or unknown events non-fatal and auditable", () => {
    const state = buildConversationContextState({
      sessionID: "session-damaged",
      events: [
        { type: "message" },
        { type: "future_context_event", value: true },
      ],
      now: 80,
    })

    expect(state.transcript.items).toHaveLength(0)
    expect(state.diagnostics.map((item) => item.severity)).toEqual(["warning", "info"])
    expect(state.diagnostics.map((item) => item.provenance.eventType)).toEqual(["message", "future_context_event"])
  })

  test("builds turn recaps for success, failures, aborts, and tool failures", () => {
    const user = message("u1", "user", "User question:\nImplement task\n注意：必须保持旧请求路径可回退。", 1)
    const success = buildTurnRecap({
      sessionID: "session-1",
      userMessage: user,
      assistantMessage: message("a1", "assistant", "Done", 2),
      now: 3,
    })
    const failed = buildTurnRecap({
      sessionID: "session-1",
      userMessage: user,
      assistantMessage: message("a2", "assistant", "Failed", 4, { error: { message: "provider failed" } }),
      now: 5,
    })
    const aborted = buildTurnRecap({
      sessionID: "session-1",
      userMessage: user,
      assistantMessage: message("a3", "assistant", "Aborted", 6, { error: { message: "request canceled" } }),
      now: 7,
    })
    const toolFailure = buildTurnRecap({
      sessionID: "session-1",
      userMessage: user,
      assistantMessage: {
        info: { id: "a4", role: "assistant", time: { created: 8 } },
        parts: [
          { type: "text", text: "Tool failed" },
          { type: "tool", tool: "chipmate_read_file", state: { status: "failed", error: "ENOENT" } },
        ],
      },
      now: 9,
    })

    expect([success.status, failed.status, aborted.status, toolFailure.status]).toEqual([
      "success",
      "failed",
      "aborted",
      "tool_failure",
    ])
    expect(success.corrections).toEqual(["注意：必须保持旧请求路径可回退。"])
    expect(failed.failureReason).toBe("provider failed")
    expect(aborted.failureReason).toBe("request canceled")
    expect(toolFailure.failureReason).toBe("chipmate_read_file: ENOENT")
  })

  test("aggregates turn recaps into high-priority task context", () => {
    const state = buildConversationContextState({
      sessionID: "session-1",
      events: [
        { type: "message", message: message("u1", "user", "User question:\n不是这样，必须优先保留用户纠偏。", 1) },
        { type: "message", message: message("a1", "assistant", "Done", 2) },
        { type: "message", message: message("u2", "user", "User question:\nRun tests", 3) },
        { type: "message", message: message("a2", "assistant", "Failed", 4, { error: { message: "test failed" } }) },
      ],
      goal: {
        objective: "Continue context parity implementation",
        status: "active",
        updatedAt: 5,
        turnCount: 2,
      },
      now: 6,
    })

    expect(state.task.corrections).toEqual(["不是这样，必须优先保留用户纠偏。"])
    expect(state.task.latestFailure?.reason).toBe("test failed")
    expect(state.task.nextActions).toContain("Resolve previous failed: test failed")
    expect(renderTaskStateContext(state)).toContain("High-priority user corrections")
    expect(renderTaskStateContext(state)).toContain("Latest failure: test failed")
  })

  test("normalizes transcript risks and carries file verification failure state", () => {
    const state = buildConversationContextState({
      sessionID: "session-1",
      events: [
        { type: "message", message: message("u1", "user", "User question:\nUpdate context files", 1) },
        {
          type: "message",
          message: {
            info: { id: "a1", role: "assistant", time: { created: 2 } },
            parts: [
              { type: "text", text: "Working" },
              {
                type: "tool",
                tool: "chipmate_write_file",
                callID: "write-1",
                state: {
                  status: "completed",
                  input: { path: "src/context-file.ts" },
                  output: { summary: "updated file" },
                },
              },
              {
                type: "tool",
                tool: "shell_exec",
                callID: "test-1",
                state: {
                  status: "failed",
                  input: { command: "bun test test/context-file.test.ts", cwd: "/repo" },
                  output: { exitCode: 1, stderr: "expected true to be false", path: "src/context-file.ts" },
                },
              },
              {
                type: "tool",
                tool: "shell_exec",
                state: {
                  status: "completed",
                  output: "orphan output",
                },
              },
            ],
          },
        },
        {
          type: "evidence",
          evidence: {
            messageID: "a1",
            entries: [{
              source: "analysis",
              kind: "code",
              path: "src/context-file.ts",
              summary: "current file evidence",
              truncated: false,
              staleness: "current",
            }],
          },
        },
      ],
      now: 3,
    })

    expect(state.normalization.orphanOutputCount).toBe(1)
    expect(state.normalization.diagnostics.map((item) => item.message)).toContain(
      "Tool output has no call id and is omitted from normalized model-visible transcript.",
    )
    expect(state.file.entries.some((entry) => entry.path === "src/context-file.ts" && entry.status === "written")).toBe(true)
    expect(state.file.entries.some((entry) => entry.path === "src/context-file.ts" && entry.source === "evidence")).toBe(true)
    expect(state.verification.entries).toContainEqual(expect.objectContaining({
      status: "failed",
      command: "bun test test/context-file.test.ts",
      cwd: "/repo",
      exitCode: 1,
    }))
    expect(state.failure.latest?.reason).toContain("expected true to be false")
    const rendered = renderTaskStateContext(state)
    expect(rendered).toContain("VerificationState:")
    expect(rendered).toContain("bun test test/context-file.test.ts")
    expect(rendered).toContain("FileState:")
    expect(rendered).toContain("src/context-file.ts [written]")
    expect(rendered).toContain("FailureState latest: expected true to be false")
  })

  test("carries plan checkpoint resume state and cleans rolled back turn state", () => {
    const state = buildConversationContextState({
      sessionID: "session-1",
      events: [
        { type: "message", message: message("u1", "user", "User question:\nImplement rollback", 1) },
        {
          type: "message",
          message: {
            info: { id: "a1", role: "assistant", time: { created: 2 } },
            parts: [
              { type: "text", text: "Edited and verified" },
              {
                type: "tool",
                tool: "chipmate_write_file",
                callID: "write-1",
                state: {
                  status: "completed",
                  input: { path: "src/rolled-back.ts" },
                },
              },
              {
                type: "tool",
                tool: "shell_exec",
                callID: "test-1",
                state: {
                  status: "completed",
                  input: { command: "bun test test/rolled-back.test.ts", cwd: "/repo" },
                  output: { exitCode: 0, stdout: "pass" },
                },
              },
            ],
          },
        },
        {
          type: "plan",
          plan: {
            id: "plan-1",
            updatedAt: 3,
            steps: [
              { id: "f1", title: "Persist plan state", status: "completed", evidenceRefs: ["a1"], updatedAt: 3 },
              { id: "f2", title: "Reinject after rollback", status: "in_progress", evidenceRefs: [], updatedAt: 4 },
            ],
          },
        },
        {
          type: "checkpoint",
          checkpoint: {
            id: "checkpoint-1",
            currentStepID: "f2",
            nextAction: "Rebuild context after rollback",
            resumeInstructions: "Continue from f2 after clearing rolled back tool state.",
            createdAt: 5,
          },
        },
        {
          type: "rollback",
          rollback: {
            id: "rollback-1",
            reason: "User backtracked the previous assistant turn",
            rolledBackMessageIDs: ["a1"],
            rolledBackTurnIDs: ["a1"],
            cleanedStateRefs: ["file:src/rolled-back.ts", "verification:test-1"],
            createdAt: 6,
          },
        },
      ],
      now: 7,
    })

    const rolledBackItem = state.transcript.items.find((item) => item.sourceMessageId === "a1")
    expect(rolledBackItem?.visibility).toBe("omitted")
    expect(rolledBackItem?.omittedReason).toBe("message was removed from model-visible history by rollback marker")
    expect(state.plan.activeStepID).toBe("f2")
    expect(state.checkpoint.latest?.currentStepID).toBe("f2")
    expect(state.resume.source).toBe("checkpoint")
    expect(state.resume.fullReinjectRequired).toBe(true)
    expect(state.resume.instructions).toContain("Rollback occurred; reinject current world/task/file/verification state before continuing.")
    expect(state.rollback.latest?.cleanedStateRefs).toContain("file:src/rolled-back.ts")
    expect(state.file.entries.some((entry) => entry.path === "src/rolled-back.ts")).toBe(false)
    expect(state.verification.entries.some((entry) => entry.command === "bun test test/rolled-back.test.ts")).toBe(false)
    const rendered = renderTaskStateContext(state)
    expect(rendered).toContain("PlanState:")
    expect(rendered).toContain("f2 [in_progress] Reinject after rollback")
    expect(rendered).toContain("ResumeState (checkpoint):")
    expect(rendered).toContain("RollbackState: full initial context reinjection required before continuing.")
  })

  test("tracks evidence freshness world baseline and visual fallback state", () => {
    const state = buildConversationContextState({
      sessionID: "session-1",
      events: [
        {
          type: "world_baseline",
          worldBaseline: {
            id: "world-1",
            workspaceRoot: "/repo",
            gitHead: "abc123",
            gitDirty: false,
            settingsHash: "settings-a",
            ragIndexVersion: "rag-1",
            model: "public-model",
            createdAt: 1,
          },
        },
        {
          type: "evidence",
          evidence: {
            messageID: "a1",
            entries: [
              {
                source: "analysis",
                kind: "code",
                path: "src/current.ts",
                summary: "current fact",
                truncated: false,
                staleness: "current",
              },
              {
                source: "codegraph",
                kind: "symbol",
                path: "src/stale.ts",
                summary: "old symbol fact",
                truncated: false,
                staleness: "stale",
              },
              {
                source: "rag",
                kind: "doc",
                path: "docs/unknown.md",
                summary: "unknown freshness doc",
                truncated: false,
                staleness: "unknown",
              },
            ],
          },
        },
        {
          type: "visual_evidence",
          visualEvidence: {
            id: "visual-2",
            messageID: "a1",
            kind: "screenshot",
            title: "Context panel",
            artifactPath: ".chipmate/visual/context.png",
            sourceHash: "visual-hash",
            coverage: "context-summary",
            staleness: "current",
            createdAt: 2,
            mediaType: "image/png",
            byteLength: 42,
          },
        },
      ],
      now: 3,
    })

    expect(state.evidence.currentCount).toBe(1)
    expect(state.evidence.staleCount).toBe(1)
    expect(state.evidence.unknownCount).toBe(1)
    expect(state.evidence.entries.find((entry) => entry.path === "src/stale.ts")?.freshnessReason).toContain("stale")
    expect(state.world.latest?.workspaceRoot).toBe("/repo")
    expect(state.world.fullReinjectRequired).toBe(false)
    expect(state.visualEvidence.entries[0]?.fallbackText).toContain(".chipmate/visual/context.png")
    expect(state.visualEvidence.entries[0]?.coverage).toBe("context-summary")
    const rendered = renderTaskStateContext(state)
    expect(rendered).toContain("EvidenceState: current=1 stale=1 unknown=1")
    expect(rendered).toContain("stale src/stale.ts")
    expect(rendered).toContain("WorldStateBaseline: root=/repo git=abc123")
    expect(rendered).toContain("VisualEvidenceState:")
    expect(rendered).toContain("coverage=context-summary")
  })

  test("requires full world reinjection when baseline is missing or rollback invalidates it", () => {
    const missing = buildConversationContextState({
      sessionID: "session-missing-world",
      events: [],
      now: 1,
    })
    expect(missing.world.fullReinjectRequired).toBe(true)
    expect(missing.world.reason).toBe("missing world baseline")

    const rolledBack = buildConversationContextState({
      sessionID: "session-rollback-world",
      events: [
        {
          type: "world_baseline",
          worldBaseline: {
            id: "world-2",
            workspaceRoot: "/repo",
            gitHead: "abc123",
            createdAt: 1,
          },
        },
        {
          type: "rollback",
          rollback: {
            id: "rollback-world",
            rolledBackMessageIDs: ["a1"],
            createdAt: 2,
          },
        },
      ],
      now: 3,
    })
    expect(rolledBack.world.fullReinjectRequired).toBe(true)
    expect(rolledBack.world.reason).toBe("rollback invalidated baseline")
    expect(renderTaskStateContext(rolledBack)).toContain("WorldStateBaseline: root=/repo git=abc123 fullReinjectRequired=true")
  })
})

function fixtureEvents(): ConversationContextEvent[] {
  return [
    {
      type: "session",
      session: {
        id: "session-1",
        title: "ChipMate Chat",
        time: { created: 1, updated: 30 },
      },
    },
    { type: "message", message: message("m1", "user", "User question:\nExplain context state", 10) },
    { type: "message", message: message("m2", "assistant", "Sure.", 20) },
    { type: "message", message: message("m3", "assistant", "Failed", 21, { error: { message: "provider failed" } }) },
    { type: "message", message: message("m4", "assistant", "Generated doc", 22, { mode: "doc-agent-local" }) },
    {
      type: "memory",
      memory: {
        id: "memory-1",
        sessionID: "session-1",
        summary: "Older turns said: keep scope narrow.",
        coveredMessageIDs: ["m1"],
        createdAt: 25,
        updatedAt: 26,
        summaryVersion: 1,
      },
    },
    {
      type: "evidence",
      evidence: {
        messageID: "m2",
        createdAt: 27,
        entries: [{
          source: "analysis",
          kind: "code",
          path: "src/example.ts",
          summary: "analysis evidence",
          truncated: false,
          staleness: "current",
        }],
      },
    },
    {
      type: "visual_evidence",
      visualEvidence: {
        id: "visual-1",
        messageID: "m2",
        kind: "word-render-page",
        title: "Page 1",
        artifactPath: ".chipmate/docs/page-1.png",
        sourceHash: "hash",
        page: 1,
        createdAt: 28,
        mediaType: "image/png",
        byteLength: 100,
      },
    },
  ]
}

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
