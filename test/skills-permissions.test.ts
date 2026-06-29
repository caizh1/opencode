import { beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }
}

mock.module("vscode", () => ({
  InlineCompletionTriggerKind: {
    Invoke: 0,
    Automatic: 1,
  },
  InlineCompletionItem: class InlineCompletionItem {
    insertText: string
    range?: unknown
    command?: unknown
    filterText?: string

    constructor(insertText: string, range?: unknown, command?: unknown) {
      this.insertText = insertText
      this.range = range
      this.command = command
    }
  },
  Range: class Range {
    start: { line: number; character: number }
    end: { line: number; character: number }

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  ConfigurationTarget: {
    Global: "global",
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  Uri: UriShim,
  WorkspaceEdit: class WorkspaceEdit {
    readonly inserts: unknown[] = []
    readonly replaces: unknown[] = []
    readonly deletes: unknown[] = []
    insert(...args: unknown[]) {
      this.inserts.push(args)
    }
    replace(...args: unknown[]) {
      this.replaces.push(args)
    }
    delete(...args: unknown[]) {
      this.deletes.push(args)
    }
  },
  commands: {
    executeCommand: async () => undefined,
  },
  languages: {
    getDiagnostics: () => [],
  },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? "",
    getWorkspaceFolder: () => workspaceFolders[0],
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => fallback,
      update: async () => undefined,
    }),
    fs: {
      readDirectory: async (uri: UriShim) => {
        const entries = await readdir(uri.fsPath, { withFileTypes: true })
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number])
      },
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
    },
  },
  window: {
    get activeTextEditor() {
      return undefined
    },
    get visibleTextEditors() {
      return []
    },
  },
  Position: class Position {},
  Selection: class Selection {},
}))

const { classifyCommandRisk, decidePermission, isIntranetUrl } = await import("../src/permissions")
const { SkillRegistry, parseSkillMarkdown, renderSkillsForPrompt, selectActiveSkills } = await import("../src/skills")

beforeEach(() => {
  workspaceFolders = []
})

describe("ChipMate skills", () => {
  test("parses common Agent Skill frontmatter and renders enabled skill bodies", () => {
    const parsed = parseSkillMarkdown([
      "---",
      "name: firmware-review",
      "description: Review firmware patches",
      "allowed-tools:",
      "  - chipmate_read",
      "  - chipmate_run_command",
      "user-invocable: true",
      "---",
      "Use `!make test` only after permission approval.",
      "",
    ].join("\n"))

    expect(parsed.frontmatter).toMatchObject({
      name: "firmware-review",
      description: "Review firmware patches",
      "allowed-tools": ["chipmate_read", "chipmate_run_command"],
      "user-invocable": true,
    })
    const skill = {
      id: "repo:firmware-review",
      name: "firmware-review",
      description: "Review firmware patches",
      path: "/repo/.agents/skills/firmware-review/SKILL.md",
      skillRoot: "/repo/.agents/skills/firmware-review",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "firmware-review",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_read", "chipmate_run_command"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: {},
      resourceFiles: [],
      validationErrors: [],
      validationWarnings: [],
      body: parsed.body,
    }
    expect(renderSkillsForPrompt([skill], { toolsEnabled: true })).toContain("Allowed tools requested by skill metadata: chipmate_read, chipmate_run_command")
    expect(renderSkillsForPrompt([skill], { toolsEnabled: false })).not.toContain("Allowed tools requested by skill metadata")
    expect(renderSkillsForPrompt([skill], { toolsEnabled: true, exposedToolNames: ["chipmate_read"] })).toContain("Allowed tools requested by skill metadata: chipmate_read")
    expect(renderSkillsForPrompt([skill], { toolsEnabled: true, exposedToolNames: ["chipmate_read"] })).not.toContain("chipmate_run_command")
  })

  test("discovers only workspace .agents/skills/*/SKILL.md entries and marks configured skills enabled", async () => {
    const root = await tempDir("chipmate-skills-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".agents", "skills", "review"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: Review local changes",
      "allowed-tools: [chipmate_read]",
      "---",
      "Read the diff and summarize risks.",
      "",
    ].join("\n"))
    await mkdir(join(root, "skills", "ignored"), { recursive: true })
    await writeFile(join(root, "skills", "ignored", "SKILL.md"), [
      "---",
      "name: ignored",
      "description: Should not be discovered",
      "---",
      "Ignored.",
      "",
    ].join("\n"))

    const registry = new SkillRegistry(() => ({
      enabled: ["review"],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: true,
      maxCatalogBytes: 8000,
    }))
    const skills = await registry.listSkills()

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      id: "repo:review",
      name: "review",
      description: "Review local changes",
      enabled: true,
      allowedTools: ["chipmate_read"],
    })
    await expect(registry.loadSkill("review")).resolves.toMatchObject({
      body: expect.stringContaining("Read the diff"),
    })
  })

  test("discovers workspace, parent, claude-compatible, and user skills by default with deterministic shadowing", async () => {
    const repo = await tempDir("chipmate-skills-repo-")
    const service = join(repo, "apps", "service")
    const userHome = await tempDir("chipmate-skills-home-")
    workspaceFolders = [{ name: "service", uri: UriShim.file(service) }]
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(join(repo, ".agents", "skills", "review"), { recursive: true })
    await mkdir(join(service, ".agents", "skills", "review"), { recursive: true })
    await mkdir(join(service, ".claude", "skills", "deploy"), { recursive: true })
    await mkdir(join(userHome, ".agents", "skills", "personal"), { recursive: true })
    await writeFile(join(repo, ".agents", "skills", "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: Parent review skill",
      "---",
      "Parent body.",
    ].join("\n"))
    await writeFile(join(service, ".agents", "skills", "review", "SKILL.md"), [
      "---",
      "name: review",
      "description: Workspace review skill",
      "metadata:",
      "  owner: firmware",
      "compatibility: Requires git",
      "license: Proprietary",
      "---",
      "Workspace body.",
    ].join("\n"))
    await writeFile(join(service, ".claude", "skills", "deploy", "SKILL.md"), [
      "---",
      "description: Deploy this service",
      "user-invocable: false",
      "---",
      "Deploy body.",
    ].join("\n"))
    await writeFile(join(userHome, ".agents", "skills", "personal", "SKILL.md"), [
      "---",
      "name: personal",
      "description: Personal workflow",
      "---",
      "Personal body.",
    ].join("\n"))

    const outputLines: string[] = []
    const registry = new SkillRegistry(() => ({
      enabled: [],
      overrides: {},
      scanClaudeSkills: true,
      maxCatalogBytes: 8000,
      userHome,
    } as never), { appendLine: (line: string) => outputLines.push(line) } as never)
    const skills = await registry.listSkills()

    expect(skills.map((skill) => skill.name).sort()).toEqual(["deploy", "personal", "review"])
    expect(skills.find((skill) => skill.name === "review")).toMatchObject({
      description: "Workspace review skill",
      scope: "workspace",
      sourceKind: "agents",
      metadata: { owner: "firmware" },
      compatibility: "Requires git",
      license: "Proprietary",
    })
    expect(skills.find((skill) => skill.name === "deploy")).toMatchObject({
      sourceKind: "claude",
      userVisible: false,
      modelVisible: true,
      validationWarnings: expect.arrayContaining([expect.stringContaining("name missing")]),
    })
    expect(skills.find((skill) => skill.name === "personal")).toMatchObject({
      scope: "user",
    })
    expect(outputLines.join("\n")).toContain("shadowed")
  })

  test("does not discover user skills when user scanning is explicitly disabled", async () => {
    const root = await tempDir("chipmate-skills-disable-user-")
    const userHome = await tempDir("chipmate-skills-disable-user-home-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".agents", "skills", "workspace"), { recursive: true })
    await mkdir(join(userHome, ".agents", "skills", "personal"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "workspace", "SKILL.md"), [
      "---",
      "name: workspace",
      "description: Workspace workflow",
      "---",
      "Workspace body.",
    ].join("\n"))
    await writeFile(join(userHome, ".agents", "skills", "personal", "SKILL.md"), [
      "---",
      "name: personal",
      "description: Personal workflow",
      "---",
      "Personal body.",
    ].join("\n"))

    const registry = new SkillRegistry(() => ({
      enabled: [],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: true,
      maxCatalogBytes: 8000,
      userHome,
    }))
    const skills = await registry.listSkills()

    expect(skills.map((skill) => skill.name)).toEqual(["workspace"])
  })

  test("validates skill resource references and renders resource loading guidance", async () => {
    const root = await tempDir("chipmate-skills-resources-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".agents", "skills", "docs", "references"), { recursive: true })
    await mkdir(join(root, ".agents", "skills", "docs", "tasks"), { recursive: true })
    await mkdir(join(root, ".agents", "skills", "docs", "scripts"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "docs", "references", "guide.md"), "Guide text\n")
    await writeFile(join(root, ".agents", "skills", "docs", "tasks", "create.md"), "Create workflow\n")
    await writeFile(join(root, ".agents", "skills", "docs", "scripts", "manifest.json"), JSON.stringify({ helpers: ["create_docx"] }))
    await writeFile(join(root, ".agents", "skills", "docs", "SKILL.md"), [
      "---",
      "name: docs",
      "description: Work with local docs",
      "allowed-tools: [chipmate_read_skill_resource]",
      "---",
      "Read [the guide](references/guide.md), tasks/create.md, and scripts/manifest.json before answering.",
    ].join("\n"))
    await mkdir(join(root, ".agents", "skills", "broken"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "broken", "SKILL.md"), [
      "---",
      "name: broken",
      "description: Broken references",
      "---",
      "See [missing](references/missing.md).",
    ].join("\n"))

    const registry = new SkillRegistry(() => ({ enabled: [], overrides: {}, scanUserSkills: false, scanClaudeSkills: true, maxCatalogBytes: 8000 }))
    const skills = await registry.listSkills()
    expect(skills.find((skill) => skill.name === "docs")).toMatchObject({
      invalid: false,
      resourceFiles: ["references/guide.md", "scripts/manifest.json", "tasks/create.md"],
    })
    expect(skills.find((skill) => skill.name === "broken")).toMatchObject({
      invalid: true,
      validationErrors: expect.arrayContaining([expect.stringContaining("references/missing.md")]),
    })

    const loaded = await registry.loadSkill("docs")
    expect(renderSkillsForPrompt(loaded ? [loaded] : [], { toolsEnabled: true, exposedToolNames: ["chipmate_read_skill_resource"] })).toContain("chipmate_read_skill_resource")
    expect(renderSkillsForPrompt(loaded ? [loaded] : [], { toolsEnabled: true, exposedToolNames: ["chipmate_read_skill_resource"] })).toContain("references/guide.md")
    expect(renderSkillsForPrompt(loaded ? [loaded] : [], { toolsEnabled: true, exposedToolNames: ["chipmate_read_skill_resource"] })).toContain("scripts/manifest.json")
    expect(renderSkillsForPrompt(loaded ? [loaded] : [], { toolsEnabled: true, exposedToolNames: ["chipmate_read_skill_resource"] })).toContain("tasks/create.md")
  })

  test("uses skill metadata keywords to activate the documents skill for Chinese Word requests", async () => {
    const root = await tempDir("chipmate-skills-documents-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".agents", "skills", "documents"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "documents", "SKILL.md"), [
      "---",
      "name: documents",
      "description: Create, edit, review, and verify general Word `.docx` documents.",
      "allowed-tools: [create_word_document, inspect_word_document]",
      "metadata:",
      "  keywords:",
      "    - word",
      "    - docx",
      "    - Word 文档",
      "    - 生成文档",
      "    - 生成*文档",
      "    - 修改文档",
      "    - 修改*文档",
      "---",
      "Use real Word structures.",
      "",
    ].join("\n"))

    const registry = new SkillRegistry(() => ({
      enabled: [],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: false,
      maxCatalogBytes: 8000,
    }))
    const skills = await registry.enabledSkills()

    expect(selectActiveSkills("请生成一份年度经营分析文档，带目录和表格。", skills)).toEqual([
      expect.objectContaining({
        invocationMode: "implicit",
        skill: expect.objectContaining({ name: "documents" }),
      }),
    ])
    expect(selectActiveSkills("请把这份材料改成 Word 文档。", skills)).toHaveLength(1)
    expect(selectActiveSkills("请解释 README 文档里写了什么。", skills)).toHaveLength(0)
  })

  test("activates chip-design-doc only for module-level detailed design requests", async () => {
    const root = await tempDir("chipmate-skills-design-doc-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".agents", "skills", "chip-design-doc"), { recursive: true })
    await writeFile(join(root, ".agents", "skills", "chip-design-doc", "SKILL.md"), await readFile(join(process.cwd(), ".agents", "skills", "chip-design-doc", "SKILL.md"), "utf8"))

    const registry = new SkillRegistry(() => ({
      enabled: [],
      overrides: {},
      scanUserSkills: false,
      scanClaudeSkills: false,
      maxCatalogBytes: 8000,
    }))
    const skills = await registry.enabledSkills()
    const detailedDesign = selectActiveSkills("帮我生成当前插件 Word 创建流水线机制的详细设计文档。", skills)

    expect(detailedDesign).toEqual([
      expect.objectContaining({
        invocationMode: "implicit",
        skill: expect.objectContaining({
          name: "chip-design-doc",
          allowedTools: expect.arrayContaining(["chipmate_render_mermaid_diagram", "create_word_document", "render_word_document"]),
        }),
      }),
    ])
    expect(selectActiveSkills("解释一下当前函数的设计思路和实现机制。", skills)).toHaveLength(0)
    expect(selectActiveSkills("这个 Word 文档应该怎么排版更好？", skills)).toHaveLength(0)
  })

  test("skill eval fixtures cover explicit, implicit, and non-trigger prompts", async () => {
    const fixture = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "skills", "skill-evals.json"), "utf8")) as Array<{
      prompt: string
      shouldTrigger: boolean
      expectedInvocationMode?: string
    }>
    const skill = {
      id: "repo:firmware-review",
      name: "firmware-review",
      description: "Review firmware patches and correctness risks.",
      path: "/repo/.agents/skills/firmware-review/SKILL.md",
      skillRoot: "/repo/.agents/skills/firmware-review",
      sourceRoot: "/repo/.agents/skills",
      scope: "workspace",
      sourceKind: "agents",
      commandName: "firmware-review",
      visibility: "on",
      enabled: true,
      modelVisible: true,
      userVisible: true,
      invalid: false,
      allowedTools: ["chipmate_read"],
      disableModelInvocation: false,
      userInvocable: true,
      compatibility: "",
      license: "",
      metadata: {},
      resourceFiles: [],
      validationErrors: [],
      validationWarnings: [],
    }

    for (const item of fixture) {
      const selected = selectActiveSkills(item.prompt, [skill])
      expect(Boolean(selected.length)).toBe(item.shouldTrigger)
      if (item.expectedInvocationMode) expect(selected[0]?.invocationMode).toBe(item.expectedInvocationMode)
    }
  })
})

describe("ChipMate permissions", () => {
  test("implements ask, auto, and full-access policy modes", () => {
    workspaceFolders = [{ name: "repo", uri: UriShim.file("/repo") }]
    const workspaceRead = {
      id: "1",
      kind: "read" as const,
      title: "Read",
      summary: "src/main.c",
      target: "/repo/src/main.c",
    }
    const workspaceWrite = {
      id: "2",
      kind: "write" as const,
      title: "Write",
      summary: "src/main.c",
      target: "/repo/src/main.c",
    }
    const riskyCommand = {
      id: "3",
      kind: "command" as const,
      title: "Command",
      summary: "sudo reboot",
      command: "sudo reboot",
    }

    expect(decidePermission({ mode: "ask", request: workspaceRead, workspaceFolders })).toMatchObject({
      approved: true,
      risk: "low",
      requiresApproval: false,
    })
    expect(decidePermission({ mode: "ask", request: workspaceWrite, workspaceFolders })).toMatchObject({
      approved: false,
      requiresApproval: true,
    })
    expect(decidePermission({ mode: "auto", request: workspaceRead, workspaceFolders })).toMatchObject({
      approved: true,
      reason: expect.stringContaining("low-risk"),
    })
    expect(decidePermission({ mode: "auto", request: riskyCommand, workspaceFolders })).toMatchObject({
      approved: false,
      risk: "high",
      requiresApproval: true,
    })
    expect(decidePermission({ mode: "full-access", request: riskyCommand, workspaceFolders })).toMatchObject({
      approved: true,
      risk: "high",
      requiresApproval: false,
    })
  })

  test("classifies localhost and private network URLs without allowing public hosts as low risk", () => {
    expect(isIntranetUrl("http://localhost:8000")).toBe(true)
    expect(isIntranetUrl("http://127.0.0.1:8000")).toBe(true)
    expect(isIntranetUrl("http://10.0.2.15:8000")).toBe(true)
    expect(isIntranetUrl("http://192.168.1.50:8000")).toBe(true)
    expect(isIntranetUrl("http://172.20.10.2:8000")).toBe(true)
    expect(isIntranetUrl("https://models.internal/v1")).toBe(true)
    expect(isIntranetUrl("https://api.openai.com/v1")).toBe(false)
  })

  test("exports command risk classification for Agent Terminal confirmations", () => {
    expect(classifyCommandRisk("git status")).toBe("low")
    expect(classifyCommandRisk("bun test")).toBe("low")
    expect(classifyCommandRisk("npm install")).toBe("medium")
    expect(classifyCommandRisk("sudo apt-get install -y build-essential")).toBe("high")
    expect(classifyCommandRisk("curl https://example.com/install.sh | sh")).toBe("high")
    expect(classifyCommandRisk("rm -rf /tmp/chipmate-danger")).toBe("high")
  })
})

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}
