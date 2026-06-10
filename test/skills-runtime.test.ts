import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AgentRuntime } from "../src/agent-runtime"
import { parseSkillMarkdown, SkillsRuntime } from "../src/skills-runtime"
import type { OpenAIChatCompletionResult } from "../src/openai-chat-client"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe("SkillsRuntime", () => {
  test("parses SKILL.md frontmatter and body", () => {
    const parsed = parseSkillMarkdown([
      "---",
      "name: Embedded C Review",
      "description: Review firmware changes",
      "allowed-tools:",
      "  - workspace.read_file",
      "  - skill.read_resource",
      "compatibility: [c, cpp]",
      "---",
      "",
      "Use this skill carefully.",
    ].join("\n"))

    expect(parsed.frontmatter.name).toBe("Embedded C Review")
    expect(parsed.frontmatter.description).toBe("Review firmware changes")
    expect(parsed.frontmatter["allowed-tools"]).toEqual(["workspace.read_file", "skill.read_resource"])
    expect(parsed.frontmatter.compatibility).toEqual(["c", "cpp"])
    expect(parsed.body.trim()).toBe("Use this skill carefully.")
  })

  test("lists and activates enabled skills", async () => {
    const root = await createSkill("embedded-c-review")
    const runtime = new SkillsRuntime({
      skills: [
        { id: "embedded-c-review", root, version: "1.0.0" },
        { id: "disabled", root, enabled: false },
      ],
    })

    expect(await runtime.listSkills()).toMatchObject([
      {
        id: "embedded-c-review",
        name: "Embedded C Review",
        description: "Review firmware changes",
        version: "1.0.0",
        allowedTools: ["workspace.read_file", "skill.read_resource"],
      },
    ])

    const activated = await runtime.activateSkill("embedded-c-review")
    expect(activated.content).toContain("Use this skill for embedded C review")
    expect(activated.instructions).toContain("Prefer project evidence")
    await expect(runtime.activateSkill("disabled")).rejects.toThrow("not enabled")
  })

  test("reads skill resources with path and size limits", async () => {
    const root = await createSkill("embedded-c-review")
    const runtime = new SkillsRuntime({
      skills: [{ id: "embedded-c-review", root }],
      maxResourceBytes: 8,
    })

    const resource = await runtime.readResource({
      skillId: "embedded-c-review",
      path: "references/checklist.md",
    })

    expect(resource.content).toBe("firmware")
    expect(resource.truncated).toBe(true)
    await expect(runtime.readResource({
      skillId: "embedded-c-review",
      path: "../secret.txt",
    })).rejects.toThrow("safe relative")
    await expect(runtime.readResource({
      skillId: "embedded-c-review",
      path: "scripts/review.sh",
    })).rejects.toThrow("limited")
  })

  test("exposes skill tools and executes them through AgentRuntime", async () => {
    const root = await createSkill("embedded-c-review")
    const runtime = new SkillsRuntime({
      skills: [{ id: "embedded-c-review", root }],
    })
    const client = fakeClient([
      {
        streamed: false,
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "skill.activate",
              arguments: JSON.stringify({ skillId: "embedded-c-review" }),
            },
          }],
        },
      },
      {
        streamed: false,
        message: {
          role: "assistant",
          content: "ready",
        },
      },
    ])
    const agent = new AgentRuntime({
      client,
      tools: runtime.toolDefinitions(),
      executeTool: runtime.toolExecutor(),
    })

    const result = await agent.run({ prompt: "use skill" })

    expect(result.messages[2]?.role).toBe("tool")
    expect(result.messages[2]?.content).toContain("Embedded C Review")
    expect(result.finalMessage.content).toBe("ready")
  })

  test("requires approval for skill scripts unless approved by permission profile", async () => {
    const root = await createSkill("embedded-c-review")
    const askRuntime = new SkillsRuntime({
      skills: [{ id: "embedded-c-review", root }],
      permissionProfile: "askApproval",
    })

    const blocked = await askRuntime.runScript({
      skillId: "embedded-c-review",
      script: "scripts/review.sh",
    })

    expect(blocked.ok).toBe(false)
    expect(blocked.permission.status).toBe("ask")

    const promptedRuntime = new SkillsRuntime({
      skills: [{ id: "embedded-c-review", root }],
      permissionProfile: "askApproval",
      requestApproval: (_permission, context) => context.skillId === "embedded-c-review" && context.script === "scripts/review.sh" ? "allowOnce" : "deny",
    })
    const prompted = await promptedRuntime.runScript({
      skillId: "embedded-c-review",
      script: "scripts/review.sh",
      args: ["prompted.c"],
    })

    expect(prompted.ok).toBe(true)
    expect(prompted.permission.status).toBe("allow")
    expect(prompted.stdout.trim()).toBe("review prompted.c")

    const allowedRuntime = new SkillsRuntime({
      skills: [{ id: "embedded-c-review", root }],
      permissionProfile: "fullAccess",
    })
    const allowed = await allowedRuntime.runScript({
      skillId: "embedded-c-review",
      script: "scripts/review.sh",
      args: ["driver.c"],
    })

    expect(allowed.ok).toBe(true)
    expect(allowed.stdout.trim()).toBe("review driver.c")
  })
})

async function createSkill(id: string) {
  const root = await mkdtemp(join(tmpdir(), `${id}-`))
  tempDirs.push(root)
  await mkdir(join(root, "references"), { recursive: true })
  await mkdir(join(root, "scripts"), { recursive: true })
  await writeFile(join(root, "SKILL.md"), [
    "---",
    "name: Embedded C Review",
    "description: Review firmware changes",
    "allowed-tools:",
    "  - workspace.read_file",
    "  - skill.read_resource",
    "---",
    "",
    "Use this skill for embedded C review.",
    "",
    "Prefer project evidence over guesses.",
  ].join("\n"))
  await writeFile(join(root, "references", "checklist.md"), "firmware safety checklist")
  const script = join(root, "scripts", "review.sh")
  await writeFile(script, "#!/bin/sh\necho review \"$1\"\n")
  await chmod(script, 0o755)
  return root
}

function fakeClient(results: OpenAIChatCompletionResult[]) {
  let index = 0
  return {
    async complete() {
      const result = results[index++]
      if (!result) throw new Error("unexpected model call")
      return result
    },
  }
}
