import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("strict local-only agent selection", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const settingsSource = readFileSync(join(import.meta.dir, "..", "src", "settings.ts"), "utf8")
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8")

  test("does not force the local-only agent unless strict mode is enabled", () => {
    expect(settingsSource).toContain('strictLocalOnlyAgent: config.get<boolean>("context.strictLocalOnlyAgent", false)')
    expect(chatViewSource).toContain("settings.context.strictLocalOnlyAgent && localOnlyAgent")
    expect(chatViewSource).toContain("label: \"no agent override\"")
  })

  test("still supports default agent when strict local-only mode is disabled", () => {
    expect(chatViewSource).toContain("const defaultAgent = settings.defaultAgent.trim()")
    expect(chatViewSource).toContain("label: `default agent: ${defaultAgent}`")
  })

  test("logs the chosen agent and explains strict-agent send failures", () => {
    expect(chatViewSource).toContain("[agent] ${agentSelection.label}")
    expect(chatViewSource).toContain("confirm the remote OpenCode server has that agent configured")
    expect(chatViewSource).toContain("looksLikeServerAgentError")
  })

  test("documents strict agent as opt-in", () => {
    expect(readme).toContain("does not force a remote agent")
    expect(readme).toContain("opencode.remote.context.strictLocalOnlyAgent")
    expect(readme).toContain("Do not enable strict")
  })
})
