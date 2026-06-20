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

const { decidePermission, isIntranetUrl } = await import("../src/permissions")
const { SkillRegistry, parseSkillMarkdown, renderSkillsForPrompt } = await import("../src/skills")

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
      enabled: true,
      allowedTools: ["chipmate_read", "chipmate_run_command"],
      disableModelInvocation: false,
      userInvocable: true,
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

    const registry = new SkillRegistry(() => ["review"])
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
})

async function tempDir(prefix: string) {
  const root = join(tmpdir(), `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  return root
}
