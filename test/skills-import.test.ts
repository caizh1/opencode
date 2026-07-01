import { beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  FileType: {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
  },
  Uri: UriShim,
  workspace: {
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      delete: async (uri: UriShim, options?: { recursive?: boolean }) => rm(uri.fsPath, { recursive: Boolean(options?.recursive), force: true }),
      readDirectory: async (uri: UriShim) => {
        const entries = await readdir(uri.fsPath, { withFileTypes: true })
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number])
      },
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      stat: async (uri: UriShim) => {
        const file = await stat(uri.fsPath)
        return {
          type: file.isDirectory() ? 2 : 1,
          ctime: file.ctimeMs,
          mtime: file.mtimeMs,
          size: file.size,
        }
      },
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
    },
  },
}))

const {
  importSkills,
  userAgentsSkillRoot,
  validateSkillImportSources,
} = await import("../src/skill-importer")

beforeEach(() => {})

describe("Skill import", () => {
  test("imports a single skill directory into user .agents skills", async () => {
    const root = await tempDir("chipmate-skill-import-")
    const home = await tempDir("chipmate-skill-home-")
    const source = join(root, "firmware-review")
    await mkdir(join(source, "references"), { recursive: true })
    await mkdir(join(source, "examples"), { recursive: true })
    await writeFile(join(source, "references", "checklist.md"), "Checklist\n")
    await writeFile(join(source, "examples", "ignored.md"), "Ignored\n")
    await writeFile(join(source, "SKILL.md"), [
      "---",
      "name: firmware-review",
      "description: Review firmware patches",
      "allowed-tools:",
      "  - chipmate_read",
      "---",
      "Read references/checklist.md first.",
      "",
    ].join("\n"))

    const result = await importSkills({
      sources: [UriShim.file(source) as never],
      userHome: home,
      settings: defaultSkillSettings(),
    })

    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]).toMatchObject({
      name: "firmware-review",
      commandName: "firmware-review",
      id: "user:firmware-review",
    })
    expect(await readFile(join(home, ".agents", "skills", "firmware-review", "SKILL.md"), "utf8")).toContain("Review firmware patches")
    expect(await readFile(join(home, ".agents", "skills", "firmware-review", "references", "checklist.md"), "utf8")).toBe("Checklist\n")
    await expect(readFile(join(home, ".agents", "skills", "firmware-review", "examples", "ignored.md"), "utf8")).rejects.toThrow()
  })

  test("imports multiple skills from a parent directory and a single SKILL.md file", async () => {
    const root = await tempDir("chipmate-skill-import-parent-")
    const home = await tempDir("chipmate-skill-home-")
    await writeSkill(join(root, "pack", "alpha"), "alpha", "Alpha workflow")
    await writeSkill(join(root, "pack", "beta"), "beta", "Beta workflow")
    const single = join(root, "single", "SKILL.md")
    await mkdir(join(root, "single"), { recursive: true })
    await writeFile(single, [
      "---",
      "name: single-file",
      "description: Single file workflow",
      "---",
      "Single body.",
      "",
    ].join("\n"))

    const result = await importSkills({
      sources: [UriShim.file(join(root, "pack")) as never, UriShim.file(single) as never],
      userHome: home,
      settings: defaultSkillSettings(),
    })

    expect(result.imported.map((item) => item.name).sort()).toEqual(["alpha", "beta", "single-file"])
    expect(await readFile(join(home, ".agents", "skills", "single-file", "SKILL.md"), "utf8")).toContain("Single file workflow")
  })

  test("imports child skills from host install roots without copying host directories", async () => {
    const root = await tempDir("chipmate-skill-import-host-root-")
    const home = await tempDir("chipmate-skill-home-")
    await writeSkill(
      join(root, ".opencode", "skills", "iar-to-gcc-migration-gated"),
      "iar-to-gcc-migration-gated",
      "Migrate IAR projects to GCC with gates",
      "",
      "Read references/migration-reference.md and run scripts/scan_iar_constructs.py with chipmate_run_command.",
    )
    await mkdir(join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "references"), { recursive: true })
    await mkdir(join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "scripts"), { recursive: true })
    await writeFile(join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "references", "migration-reference.md"), "Reference\n")
    await writeFile(join(root, ".opencode", "skills", "iar-to-gcc-migration-gated", "scripts", "scan_iar_constructs.py"), "print('scan')\n")
    await writeSkill(join(root, ".claude", "skills", "review"), "review", "Review workflow")

    const result = await importSkills({
      sources: [UriShim.file(root) as never],
      userHome: home,
      settings: defaultSkillSettings(),
    })

    expect(result.imported.map((item) => item.name).sort()).toEqual(["iar-to-gcc-migration-gated", "review"])
    expect(await readFile(join(home, ".agents", "skills", "iar-to-gcc-migration-gated", "SKILL.md"), "utf8")).toContain("Migrate IAR")
    expect(await readFile(join(home, ".agents", "skills", "iar-to-gcc-migration-gated", "references", "migration-reference.md"), "utf8")).toBe("Reference\n")
    expect(await readFile(join(home, ".agents", "skills", "iar-to-gcc-migration-gated", "scripts", "scan_iar_constructs.py"), "utf8")).toBe("print('scan')\n")
    await expect(readFile(join(home, ".agents", "skills", ".opencode"), "utf8")).rejects.toThrow()
  })

  test("imports child skills when selecting an .opencode directory directly", async () => {
    const root = await tempDir("chipmate-skill-import-opencode-dir-")
    const home = await tempDir("chipmate-skill-home-")
    await writeSkill(join(root, ".opencode", "skills", "migrate"), "migrate", "Migration workflow")

    const result = await importSkills({
      sources: [UriShim.file(join(root, ".opencode")) as never],
      userHome: home,
      settings: defaultSkillSettings(),
    })

    expect(result.imported.map((item) => item.name)).toEqual(["migrate"])
    expect(await readFile(join(home, ".agents", "skills", "migrate", "SKILL.md"), "utf8")).toContain("Migration workflow")
  })

  test("validates unsupported skill inputs before import", async () => {
    const root = await tempDir("chipmate-skill-import-invalid-")
    const home = await tempDir("chipmate-skill-home-")
    await mkdir(join(root, "bad-yaml"), { recursive: true })
    await writeFile(join(root, "bad-yaml", "SKILL.md"), "---\nname: [\n---\nBody\n")
    await writeSkill(join(root, "missing-description"), "missing-description", "")
    await writeSkill(join(root, "bad-tool"), "bad-tool", "Bad tool", "allowed-tools: [chipmate read]")
    await writeSkill(join(root, "missing-reference"), "missing-reference", "Missing reference", undefined, "See references/missing.md.")
    await mkdir(join(root, "single-no-name"), { recursive: true })
    await writeFile(join(root, "single-no-name", "SKILL.md"), "---\ndescription: No name\n---\nBody\n")

    const validations = await validateSkillImportSources({
      sources: [
        UriShim.file(join(root, "bad-yaml")) as never,
        UriShim.file(join(root, "missing-description")) as never,
        UriShim.file(join(root, "bad-tool")) as never,
        UriShim.file(join(root, "missing-reference")) as never,
        UriShim.file(join(root, "single-no-name", "SKILL.md")) as never,
      ],
      userHome: home,
      settings: defaultSkillSettings(),
    })

    expect(validations).toHaveLength(5)
    expect(validations.every((candidate) => !candidate.valid)).toBe(true)
    expect(validations.flatMap((candidate) => candidate.errors).join("\n")).toContain("frontmatter")
    expect(validations.flatMap((candidate) => candidate.errors).join("\n")).toContain("description is required")
    expect(validations.flatMap((candidate) => candidate.errors).join("\n")).toContain("invalid allowed-tools entry")
    expect(validations.flatMap((candidate) => candidate.errors).join("\n")).toContain("referenced resource not found")
    expect(validations.flatMap((candidate) => candidate.errors).join("\n")).toContain("name is required when importing a standalone SKILL.md")
  })

  test("handles conflicts and appends legacy enabled skill ids", async () => {
    const root = await tempDir("chipmate-skill-import-conflict-")
    const home = await tempDir("chipmate-skill-home-")
    const target = join(userAgentsSkillRoot(home), "review")
    await writeSkill(join(root, "review"), "review", "New review workflow")
    await writeSkill(target, "review", "Old review workflow")
    const savedEnabled: string[][] = []

    const skipped = await importSkills({
      sources: [UriShim.file(join(root, "review")) as never],
      userHome: home,
      settings: { ...defaultSkillSettings(), enabled: ["existing"] },
      confirmOverwrite: async () => false,
      saveEnabledSkills: async (enabled) => savedEnabled.push(enabled),
    })
    expect(skipped.imported).toHaveLength(0)
    expect(skipped.skipped[0]?.reason).toContain("already exists")
    expect(savedEnabled).toEqual([])
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("Old review workflow")

    const imported = await importSkills({
      sources: [UriShim.file(join(root, "review")) as never],
      userHome: home,
      settings: { ...defaultSkillSettings(), enabled: ["existing"] },
      confirmOverwrite: async () => true,
      saveEnabledSkills: async (enabled) => savedEnabled.push(enabled),
      existingSkills: [{
        name: "review",
        scope: "workspace",
        path: "/repo/.agents/skills/review/SKILL.md",
      }],
    })

    expect(imported.imported).toHaveLength(1)
    expect(imported.warnings.join("\n")).toContain("shadowed")
    expect(savedEnabled.at(-1)).toEqual(["existing", "user:review"])
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("New review workflow")
  })
})

function defaultSkillSettings() {
  return {
    enabled: [],
    overrides: {},
    scanUserSkills: true,
    scanOpenCodeSkills: true,
    scanClaudeSkills: true,
    scanCodexSkills: true,
    maxCatalogBytes: 8000,
  }
}

async function writeSkill(root: string, name: string, description: string, extraFrontmatter = "", body = "Body.") {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "SKILL.md"), [
    "---",
    `name: ${name}`,
    description ? `description: ${description}` : "",
    extraFrontmatter,
    "---",
    body,
    "",
  ].filter((line) => line !== "").join("\n"))
}

async function tempDir(prefix: string) {
  const path = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(path, { recursive: true })
  return path
}
