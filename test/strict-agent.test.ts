import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("strict local-only agent selection", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const completionSource = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
  const localAgentSource = readFileSync(join(import.meta.dir, "..", "src", "local-agent.ts"), "utf8")
  const settingsSource = readFileSync(join(import.meta.dir, "..", "src", "settings.ts"), "utf8")
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8")

  test("defaults local-only requests to the ChipMate workspace agent", () => {
    expect(settingsSource).toContain('strictLocalOnlyAgent: config.get<boolean>("context.strictLocalOnlyAgent", true)')
    expect(localAgentSource).toContain('DEFAULT_LOCAL_ONLY_AGENT = "chipmate-local"')
    expect(localAgentSource).toContain("settings.context.localOnlyMode")
    expect(localAgentSource).toContain("Required ChipMate workspace agent")
  })

  test("fails closed when the required agent is missing", () => {
    expect(localAgentSource).toContain("MissingLocalOnlyAgentError")
    expect(localAgentSource).toContain("was not found. Available agents")
    expect(chatViewSource).toContain("ensureAgentList")
    expect(chatViewSource).toContain("throw new MissingLocalOnlyAgentError")
  })

  test("keeps local-only agents on chat while inline completion stays decoupled", () => {
    expect(chatViewSource).toContain("[agent] ${agentSelection.label}")
    expect(chatViewSource).toContain("agent: agentSelection.agent")
    expect(completionSource).not.toContain("resolveRequestAgent")
    expect(completionSource).not.toContain("agent: agentSelection.agent")
  })

  test("documents chipmate-local as the workspace-host guard", () => {
    expect(readme).toContain("chipmate-local")
    expect(readme).toContain("workspace extension host")
    expect(readme).toContain("chipmate.context.strictLocalOnlyAgent")
  })
})
