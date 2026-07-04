import { describe, expect, test } from "bun:test"
import { systemCases } from "./cases/catalog"
import { uiCases } from "./ui-matrix/catalog"

describe("live VS Code system test catalog", () => {
  test("contains broad first-system-test coverage areas", () => {
    const areas = new Set(systemCases.map((item) => item.area))
    for (const area of [
      "startup",
      "provider",
      "settings",
      "chat",
      "context",
      "codegraph",
      "code-rag",
      "document-rag",
      "documents",
      "comments",
      "agent-terminal",
      "tools",
      "diagram",
      "ui",
      "lifecycle",
      "offline",
      "security",
      "completion-boundary",
    ]) {
      expect(areas.has(area)).toBe(true)
    }
  })

  test("each case has the oracle fields needed for product-level reporting", () => {
    for (const item of systemCases) {
      expect(item.id).toBeTruthy()
      expect(item.userAction).toBeTruthy()
      expect(item.expected).toBeTruthy()
      expect(item.allowedFailures.length).toBeGreaterThanOrEqual(0)
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(item.boundaries.length).toBeGreaterThan(0)
    }
  })

  test("completion quality remains outside the system-test oracle", () => {
    const completionCases = systemCases.filter((item) => item.area.includes("completion"))
    expect(completionCases.length).toBe(1)
    expect(completionCases[0].id).toBe("completion.disabled-boundary")
  })

  test("contains the full user-facing UI matrix surfaces", () => {
    const surfaces = new Set(uiCases.map((item) => item.surface))
    for (const surface of [
      "vscode-shell",
      "activity-bar",
      "chat",
      "composer",
      "session-history",
      "context",
      "mention",
      "provider-settings",
      "rag-settings",
      "codegraph-status",
      "document-rag",
      "comments-review",
      "agent-terminal",
      "tools-skills",
      "diagram",
      "visual-accessibility",
      "lifecycle",
    ]) {
      expect(surfaces.has(surface)).toBe(true)
    }
    expect(uiCases.length).toBeGreaterThanOrEqual(100)
  })

  test("each UI case has a user-level oracle and evidence contract", () => {
    for (const item of uiCases) {
      expect(item.id.startsWith("ui.")).toBe(true)
      expect(item.userScenario).toBeTruthy()
      expect(item.userSteps.length).toBeGreaterThan(0)
      expect(item.expected.length).toBeGreaterThan(0)
      expect(item.boundaries.length).toBeGreaterThan(0)
      expect(item.oracles.length).toBeGreaterThan(0)
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(item.allowedFailures.length).toBeGreaterThan(0)
    }
  })

  test("UI matrix covers CodeGraph and Code RAG state observability", () => {
    const ids = new Set(uiCases.map((item) => item.id))
    for (const state of ["ready", "partial", "paused", "stale", "provider-error", "storage-error"]) {
      expect(ids.has(`ui.codegraph-status.state-${state}`)).toBe(true)
    }
    expect(ids.has("ui.rag-settings.rag-test-connectivity")).toBe(true)
    expect(ids.has("ui.rag-settings.rag-resume")).toBe(true)
    expect(ids.has("ui.rag-settings.rag-save-identity")).toBe(true)
  })
})
