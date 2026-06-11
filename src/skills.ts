import * as vscode from "vscode"

export type SkillMetadata = {
  id: string
  name: string
  description: string
  path: string
  enabled: boolean
  allowedTools: string[]
  disableModelInvocation: boolean
  userInvocable: boolean
}

export type LoadedSkill = SkillMetadata & {
  body: string
}

type SkillFrontmatter = {
  name?: string
  description?: string
  "allowed-tools"?: string | string[]
  allowedTools?: string | string[]
  "disable-model-invocation"?: boolean
  disableModelInvocation?: boolean
  "user-invocable"?: boolean
  userInvocable?: boolean
}

const SKILL_ROOT = ".agents/skills"
const SKILL_FILE = "SKILL.md"

export class SkillRegistry {
  private cache?: SkillMetadata[]

  constructor(
    private readonly enabledSkillNames: () => string[],
    private readonly output?: vscode.OutputChannel,
  ) {}

  invalidate() {
    this.cache = undefined
  }

  async listSkills() {
    if (!this.cache) this.cache = await this.scanWorkspaceSkills()
    return this.cache
  }

  async enabledSkills() {
    const skills = await this.listSkills()
    return skills.filter((skill) => skill.enabled)
  }

  async loadSkill(id: string): Promise<LoadedSkill | undefined> {
    const skill = (await this.listSkills()).find((candidate) => candidate.id === id || candidate.name === id)
    if (!skill) return
    const uri = vscode.Uri.file(skill.path)
    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
    const parsed = parseSkillMarkdown(content, skill.path)
    return {
      ...skill,
      body: parsed.body,
    }
  }

  private async scanWorkspaceSkills() {
    const enabled = new Set(this.enabledSkillNames())
    const roots = vscode.workspace.workspaceFolders ?? []
    const skills: SkillMetadata[] = []
    for (const root of roots) {
      const skillRoot = vscode.Uri.joinPath(root.uri, SKILL_ROOT)
      let entries: [string, vscode.FileType][]
      try {
        entries = await vscode.workspace.fs.readDirectory(skillRoot)
      } catch {
        continue
      }
      for (const [entry, fileType] of entries) {
        if (fileType !== vscode.FileType.Directory) continue
        const skillFile = vscode.Uri.joinPath(skillRoot, entry, SKILL_FILE)
        try {
          const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(skillFile))
          const parsed = parseSkillMarkdown(content, skillFile.fsPath)
          const name = parsed.frontmatter.name?.trim() || entry
          const description = parsed.frontmatter.description?.trim() || ""
          if (!name || !description) continue
          const allowedTools = normalizeAllowedTools(parsed.frontmatter["allowed-tools"] ?? parsed.frontmatter.allowedTools)
          skills.push({
            id: `${root.name}:${name}`,
            name,
            description,
            path: skillFile.fsPath,
            enabled: enabled.has(name) || enabled.has(`${root.name}:${name}`),
            allowedTools,
            disableModelInvocation: Boolean(parsed.frontmatter["disable-model-invocation"] ?? parsed.frontmatter.disableModelInvocation),
            userInvocable: parsed.frontmatter["user-invocable"] !== false && parsed.frontmatter.userInvocable !== false,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.output?.appendLine(`[skills] skipped ${skillFile.fsPath}: ${message}`)
        }
      }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name))
  }
}

export function parseSkillMarkdown(content: string, path = SKILL_FILE): { frontmatter: SkillFrontmatter; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content }
  const end = content.indexOf("\n---", 3)
  if (end === -1) return { frontmatter: {}, body: content }
  const rawFrontmatter = content.slice(3, end).trim()
  const body = content.slice(end).replace(/^\n---\r?\n?/, "")
  return {
    frontmatter: parseSimpleYaml(rawFrontmatter, path),
    body,
  }
}

export function renderSkillsForPrompt(skills: LoadedSkill[]) {
  if (skills.length === 0) return ""
  return [
    "Enabled ChipMate skills:",
    ...skills.map((skill) => [
      `<skill name="${escapeAttribute(skill.name)}" path="${escapeAttribute(skill.path)}">`,
      skill.body.trim(),
      skill.allowedTools.length > 0 ? `\nAllowed tools requested by skill metadata: ${skill.allowedTools.join(", ")}` : "",
      "</skill>",
    ].join("\n")),
  ].join("\n\n")
}

export function skillSystemCatalog(skills: SkillMetadata[]) {
  if (skills.length === 0) return "No ChipMate skills are enabled."
  return [
    "Available enabled ChipMate skills. Use them when the user's request matches the description. Load only the minimum useful skills.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n")
}

function parseSimpleYaml(input: string, path: string): SkillFrontmatter {
  const result: Record<string, unknown> = {}
  let activeListKey = ""
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "")
    if (!line.trim() || line.trim().startsWith("#")) continue
    const listMatch = line.match(/^\s*-\s+(.+)$/)
    if (listMatch && activeListKey) {
      const current = Array.isArray(result[activeListKey]) ? result[activeListKey] as string[] : []
      current.push(cleanYamlScalar(listMatch[1]))
      result[activeListKey] = current
      continue
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) throw new Error(`Unsupported frontmatter line in ${path}: ${line}`)
    const key = match[1]
    const value = match[2]
    if (value === "") {
      activeListKey = key
      result[key] = []
      continue
    }
    activeListKey = ""
    result[key] = parseYamlScalar(value)
  }
  return result as SkillFrontmatter
}

function parseYamlScalar(value: string): string | boolean | string[] {
  const trimmed = value.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(cleanYamlScalar).filter(Boolean)
  }
  return cleanYamlScalar(trimmed)
}

function cleanYamlScalar(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function normalizeAllowedTools(input: string | string[] | undefined) {
  if (!input) return []
  const values = Array.isArray(input) ? input : input.split(/[,\n]/)
  return values.map((value) => value.trim()).filter(Boolean)
}

function escapeAttribute(input: string) {
  return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
