import { homedir } from "node:os"
import * as nodePath from "node:path"
import * as vscode from "vscode"
import { load as loadYaml } from "js-yaml"
import type { RemoteSettings } from "./types"

export type SkillScope = "workspace" | "parent" | "user"
export type SkillSourceKind = "agents" | "claude"
export type SkillVisibility = "on" | "name-only" | "user-invocable-only" | "off"
export type SkillInvocationMode = "explicit" | "implicit"

export type SkillMetadata = {
  id: string
  name: string
  description: string
  path: string
  skillRoot: string
  sourceRoot: string
  scope: SkillScope
  sourceKind: SkillSourceKind
  commandName: string
  visibility: SkillVisibility
  enabled: boolean
  modelVisible: boolean
  userVisible: boolean
  invalid: boolean
  allowedTools: string[]
  disableModelInvocation: boolean
  userInvocable: boolean
  compatibility: string
  license: string
  metadata: Record<string, string>
  resourceFiles: string[]
  validationErrors: string[]
  validationWarnings: string[]
}

export type LoadedSkill = SkillMetadata & {
  body: string
  invocationMode?: SkillInvocationMode
}

export type ActiveSkillPolicy = {
  id: string
  name: string
  path: string
  skillRoot: string
  allowedTools: string[]
  invocationMode: SkillInvocationMode
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
  compatibility?: string
  license?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

type SkillRegistrySettings = RemoteSettings["skills"] & {
  userHome?: string
}

type SkillSource = {
  sourceRoot: string
  scope: SkillScope
  sourceKind: SkillSourceKind
  workspaceName: string
  priority: number
}

type SkillCandidate = SkillMetadata & {
  priority: number
}

const AGENTS_SKILL_ROOT = ".agents/skills"
const CLAUDE_SKILL_ROOT = ".claude/skills"
const SKILL_FILE = "SKILL.md"
const CATALOG_DEFAULT_MAX_BYTES = 8000
const RESOURCE_DIRS = ["references", "assets", "scripts", "tasks"] as const
const VALID_TOOL_NAME = /^[A-Za-z0-9_.:-]+$/

export const SKILL_FILE_NAME = SKILL_FILE
export const SKILL_RESOURCE_DIRS = RESOURCE_DIRS
export const VALID_SKILL_TOOL_NAME = VALID_TOOL_NAME

export class SkillRegistry {
  private cache?: SkillMetadata[]

  constructor(
    private readonly skillSettings: () => string[] | SkillRegistrySettings,
    private readonly output?: vscode.OutputChannel,
  ) {}

  invalidate() {
    this.cache = undefined
  }

  async listSkills() {
    if (!this.cache) this.cache = await this.scanSkills()
    return this.cache
  }

  async enabledSkills() {
    const skills = await this.listSkills()
    return skills.filter((skill) => skill.enabled && skill.modelVisible)
  }

  async loadSkill(id: string, invocationMode?: SkillInvocationMode): Promise<LoadedSkill | undefined> {
    const skill = (await this.listSkills()).find((candidate) => matchesSkillID(candidate, id))
    if (!skill || skill.invalid) return
    const uri = vscode.Uri.file(skill.path)
    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
    const parsed = parseSkillMarkdown(content, skill.path)
    this.output?.appendLine(`[skills] load name=${skill.name} id=${skill.id} mode=${invocationMode ?? "implicit"} path=${skill.path}`)
    return {
      ...skill,
      body: parsed.body,
      invocationMode,
    }
  }

  async activeSkillsForPrompt(userText: string) {
    const enabledSkills = await this.enabledSkills()
    const active = selectActiveSkills(userText, enabledSkills)
    return active
  }

  private async scanSkills() {
    const settings = normalizeSkillSettings(this.skillSettings())
    const sources = await this.skillSources(settings)
    const candidates: SkillCandidate[] = []
    for (const source of sources) {
      candidates.push(...await this.scanSource(source, settings))
    }
    candidates.sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    const selected = new Map<string, SkillCandidate>()
    for (const candidate of candidates) {
      const key = candidate.name.toLowerCase()
      const existing = selected.get(key)
      if (!existing) {
        selected.set(key, candidate)
        continue
      }
      this.output?.appendLine(`[skills] shadowed name=${candidate.name} path=${candidate.path} by=${existing.path}`)
    }
    const skills = [...selected.values()]
      .map(({ priority: _priority, ...skill }) => skill)
      .sort((left, right) => left.name.localeCompare(right.name))
    this.output?.appendLine(`[skills] discovered count=${skills.length} sources=${sources.length} enabled=${skills.filter((skill) => skill.enabled).length}`)
    return skills
  }

  private async scanSource(source: SkillSource, settings: SkillRegistrySettings) {
    const entries = await readDirectorySafe(source.sourceRoot)
    const skills: SkillCandidate[] = []
    for (const [entry, fileType] of entries) {
      if (fileType !== vscode.FileType.Directory) continue
      const skillRoot = nodePath.join(source.sourceRoot, entry)
      const skillFile = nodePath.join(skillRoot, SKILL_FILE)
      try {
        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(skillFile)))
        const parsed = parseSkillMarkdown(content, skillFile)
        const skill = await buildSkillMetadata({
          entry,
          body: parsed.body,
          frontmatter: parsed.frontmatter,
          settings,
          source,
          skillFile,
          skillRoot,
        })
        skills.push({ ...skill, priority: source.priority })
        this.output?.appendLine(`[skills] found name=${skill.name} scope=${skill.scope} source=${skill.sourceKind} visibility=${skill.visibility} invalid=${skill.invalid} path=${skill.path}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.output?.appendLine(`[skills] skipped ${skillFile}: ${message}`)
      }
    }
    return skills
  }

  private async skillSources(settings: SkillRegistrySettings) {
    const sources: SkillSource[] = []
    const seen = new Set<string>()
    const addSource = (source: SkillSource) => {
      const key = `${source.sourceRoot}:${source.sourceKind}`
      if (seen.has(key)) return
      seen.add(key)
      sources.push(source)
    }
    let priority = 0
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const workspaceRoot = folder.uri.fsPath
      const parents = await workspaceSkillParents(workspaceRoot)
      for (let index = 0; index < parents.length; index += 1) {
        addSource({
          sourceRoot: nodePath.join(parents[index], AGENTS_SKILL_ROOT),
          scope: index === 0 ? "workspace" : "parent",
          sourceKind: "agents",
          workspaceName: folder.name,
          priority: priority + index,
        })
      }
      if (settings.scanClaudeSkills) {
        addSource({
          sourceRoot: nodePath.join(workspaceRoot, CLAUDE_SKILL_ROOT),
          scope: "workspace",
          sourceKind: "claude",
          workspaceName: folder.name,
          priority: priority + 100,
        })
      }
      priority += 200
    }
    if (settings.scanUserSkills) {
      const home = settings.userHome ?? homedir()
      addSource({
        sourceRoot: nodePath.join(home, AGENTS_SKILL_ROOT),
        scope: "user",
        sourceKind: "agents",
        workspaceName: "user",
        priority: 10_000,
      })
      if (settings.scanClaudeSkills) {
        addSource({
          sourceRoot: nodePath.join(home, CLAUDE_SKILL_ROOT),
          scope: "user",
          sourceKind: "claude",
          workspaceName: "user",
          priority: 10_100,
        })
      }
    }
    return sources
  }
}

export function parseSkillMarkdown(content: string, path = SKILL_FILE): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: {}, body: content }
  const rawFrontmatter = match[1].trim()
  const body = content.slice(match[0].length)
  return {
    frontmatter: parseYamlFrontmatter(rawFrontmatter, path),
    body,
  }
}

export function renderSkillsForPrompt(skills: LoadedSkill[], options: { toolsEnabled?: boolean; exposedToolNames?: readonly string[] } = {}) {
  if (skills.length === 0) return ""
  const toolsEnabled = options.toolsEnabled === true
  const exposedToolNames = options.exposedToolNames ? new Set(options.exposedToolNames) : undefined
  return [
    "Enabled ChipMate skills:",
    "When a skill lists resource files, read them with chipmate_read_skill_resource only after the skill is active. Do not execute scripts directly; script use still requires the normal ChipMate tool permission path.",
    ...skills.map((skill) => {
      const allowedTools = exposedToolNames
        ? skill.allowedTools.filter((tool) => exposedToolNames.has(tool))
        : skill.allowedTools
      return [
        `<skill name="${escapeAttribute(skill.name)}" path="${escapeAttribute(skill.path)}" root="${escapeAttribute(skill.skillRoot)}">`,
        `Invocation: ${skill.invocationMode ?? "implicit"}`,
        skill.resourceFiles.length > 0 ? `Resource files: ${skill.resourceFiles.join(", ")}` : "",
        skill.body.trim(),
        toolsEnabled && allowedTools.length > 0 ? `\nAllowed tools requested by skill metadata: ${allowedTools.join(", ")}` : "",
        "</skill>",
      ].filter(Boolean).join("\n")
    }),
  ].join("\n\n")
}

export function skillSystemCatalog(skills: SkillMetadata[], maxBytes = CATALOG_DEFAULT_MAX_BYTES) {
  const visible = skills.filter((skill) => skill.enabled && skill.modelVisible && !skill.invalid)
  if (visible.length === 0) return "No ChipMate skills are enabled."
  const lines = [
    "Available enabled ChipMate skills. Use them when the user's request matches the description. Load only the minimum useful skills.",
  ]
  for (const skill of visible) {
    const description = skill.visibility === "name-only" ? "(name-only)" : skill.description
    lines.push(`- ${skill.name}: ${description}`)
  }
  return trimCatalog(lines, maxBytes)
}

export function selectActiveSkills(userText: string, skills: SkillMetadata[]) {
  const explicit = explicitSkillNames(userText)
  const selected = new Map<string, { skill: SkillMetadata; invocationMode: SkillInvocationMode }>()
  for (const skill of skills) {
    if (!skill.enabled || skill.invalid) continue
    if (explicit.some((name) => matchesSkillInvocation(skill, name))) {
      selected.set(skill.id, { skill, invocationMode: "explicit" })
    }
  }
  if (selected.size === 0) {
    for (const skill of skills) {
      if (!skill.enabled || !skill.modelVisible || skill.invalid) continue
      if (skillMatchesPrompt(skill, userText)) selected.set(skill.id, { skill, invocationMode: "implicit" })
    }
  }
  return [...selected.values()]
}

export function activeSkillPolicies(skills: LoadedSkill[]): ActiveSkillPolicy[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    path: skill.path,
    skillRoot: skill.skillRoot,
    allowedTools: skill.allowedTools,
    invocationMode: skill.invocationMode ?? "implicit",
  }))
}

function normalizeSkillSettings(input: string[] | SkillRegistrySettings): SkillRegistrySettings {
  if (Array.isArray(input)) {
    return {
      enabled: input,
      overrides: {},
      scanUserSkills: true,
      scanClaudeSkills: true,
      maxCatalogBytes: CATALOG_DEFAULT_MAX_BYTES,
    }
  }
  return {
    enabled: Array.isArray(input.enabled) ? input.enabled : [],
    overrides: input.overrides && typeof input.overrides === "object" ? input.overrides : {},
    scanUserSkills: input.scanUserSkills !== false,
    scanClaudeSkills: input.scanClaudeSkills !== false,
    maxCatalogBytes: Number.isFinite(input.maxCatalogBytes) ? input.maxCatalogBytes : CATALOG_DEFAULT_MAX_BYTES,
    userHome: input.userHome,
  }
}

async function buildSkillMetadata(input: {
  entry: string
  body: string
  frontmatter: SkillFrontmatter
  settings: SkillRegistrySettings
  source: SkillSource
  skillFile: string
  skillRoot: string
}): Promise<SkillMetadata> {
  const validationErrors: string[] = []
  const validationWarnings: string[] = []
  const frontmatterName = typeof input.frontmatter.name === "string" ? input.frontmatter.name.trim() : ""
  const name = frontmatterName || input.entry
  if (!frontmatterName) validationWarnings.push("name missing; defaulted from skill directory")
  const description = typeof input.frontmatter.description === "string" ? input.frontmatter.description.trim() : ""
  if (!description) validationErrors.push("description is required")
  const commandName = normalizeCommandName(name)
  if (!commandName) validationErrors.push("name must contain at least one command-safe character")
  const allowedTools = normalizeAllowedTools(input.frontmatter["allowed-tools"] ?? input.frontmatter.allowedTools)
  const invalidAllowedTools = allowedTools.filter((tool) => !VALID_TOOL_NAME.test(tool))
  for (const tool of invalidAllowedTools) validationErrors.push(`invalid allowed-tools entry: ${tool}`)
  const resourceFiles = await collectSkillResourceFiles(input.skillRoot)
  const referencedResources = extractReferencedResourceFiles(input.body)
  for (const resource of referencedResources) {
    if (!resourceFiles.includes(resource)) validationErrors.push(`referenced resource not found: ${resource}`)
  }
  const visibility = skillVisibility(input.settings, {
    id: `${input.source.workspaceName}:${name}`,
    name,
    commandName,
  })
  const disableModelInvocation = Boolean(input.frontmatter["disable-model-invocation"] ?? input.frontmatter.disableModelInvocation)
  const userInvocable = input.frontmatter["user-invocable"] !== false && input.frontmatter.userInvocable !== false
  const invalid = validationErrors.length > 0
  const enabled = visibility !== "off" && !invalid
  return {
    id: `${input.source.workspaceName}:${name}`,
    name,
    description,
    path: input.skillFile,
    skillRoot: input.skillRoot,
    sourceRoot: input.source.sourceRoot,
    scope: input.source.scope,
    sourceKind: input.source.sourceKind,
    commandName,
    visibility,
    enabled,
    modelVisible: enabled && !disableModelInvocation && visibility !== "user-invocable-only",
    userVisible: enabled && userInvocable && visibility !== "name-only",
    invalid,
    allowedTools,
    disableModelInvocation,
    userInvocable,
    compatibility: stringField(input.frontmatter.compatibility),
    license: stringField(input.frontmatter.license),
    metadata: normalizeStringMap(input.frontmatter.metadata),
    resourceFiles,
    validationErrors,
    validationWarnings,
  }
}

async function workspaceSkillParents(workspaceRoot: string) {
  const roots: string[] = []
  let current = normalizePath(workspaceRoot)
  while (current && !roots.includes(current)) {
    roots.push(current)
    if (await directoryExists(nodePath.join(current, ".git"))) break
    const parent = nodePath.dirname(current)
    if (!parent || parent === current) break
    current = parent
  }
  return roots
}

async function collectSkillResourceFiles(skillRoot: string) {
  const files: string[] = []
  for (const directory of RESOURCE_DIRS) {
    await collectFiles(nodePath.join(skillRoot, directory), directory, files, 3)
  }
  return files.sort()
}

async function collectFiles(root: string, relativeRoot: string, files: string[], depth: number): Promise<void> {
  if (depth < 0) return
  for (const [entry, fileType] of await readDirectorySafe(root)) {
    const relativePath = normalizePath(nodePath.join(relativeRoot, entry))
    const absolutePath = nodePath.join(root, entry)
    if (fileType === vscode.FileType.File) {
      files.push(relativePath)
      continue
    }
    if (fileType === vscode.FileType.Directory) await collectFiles(absolutePath, relativePath, files, depth - 1)
  }
}

function extractReferencedResourceFiles(body: string) {
  const resources = new Set<string>()
  const pattern = /\b(references|assets|scripts)\/[A-Za-z0-9._/@+-]+/g
  for (const match of body.matchAll(pattern)) {
    resources.add(normalizePath(match[0]))
  }
  return [...resources].sort()
}

async function readDirectorySafe(path: string): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(vscode.Uri.file(path))
  } catch {
    return []
  }
}

async function directoryExists(path: string) {
  try {
    await vscode.workspace.fs.readDirectory(vscode.Uri.file(path))
    return true
  } catch {
    return false
  }
}

function parseYamlFrontmatter(input: string, path: string): SkillFrontmatter {
  const parsed = loadYaml(input, { filename: path })
  if (!parsed) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Skill frontmatter in ${path} must be a YAML mapping`)
  }
  return parsed as SkillFrontmatter
}

function normalizeAllowedTools(input: string | string[] | undefined) {
  if (!input) return []
  const values = Array.isArray(input) ? input : input.split(/[,\n]/)
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function normalizeStringMap(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const cleanKey = key.trim()
    if (!cleanKey) continue
    result[cleanKey] = typeof value === "string" ? value.trim() : JSON.stringify(value)
  }
  return result
}

function skillVisibility(settings: SkillRegistrySettings, input: { id: string; name: string; commandName: string }): SkillVisibility {
  const override = settings.overrides[input.id] ?? settings.overrides[input.name] ?? settings.overrides[input.commandName]
  if (override) return override
  const legacyEnabled = new Set(settings.enabled)
  if (legacyEnabled.size > 0) return legacyEnabled.has(input.id) || legacyEnabled.has(input.name) || legacyEnabled.has(input.commandName) ? "on" : "off"
  return "on"
}

function explicitSkillNames(text: string) {
  const names: string[] = []
  const pattern = /(?:^|\s)([$/])([A-Za-z0-9][A-Za-z0-9_.-]{0,80})(?=\s|$|[:：,，])/g
  for (const match of text.matchAll(pattern)) names.push(match[2])
  return names
}

function matchesSkillInvocation(skill: SkillMetadata, name: string) {
  const normalized = name.toLowerCase()
  return [skill.name, skill.commandName, skill.id].some((value) => value.toLowerCase() === normalized)
}

function matchesSkillID(skill: SkillMetadata, id: string) {
  return skill.id === id || skill.name === id || skill.commandName === id
}

function skillMatchesPrompt(skill: SkillMetadata, userText: string) {
  const text = userText.toLowerCase()
  if (text.includes(skill.name.toLowerCase()) || text.includes(skill.commandName.toLowerCase())) return true
  const compactText = compactKeywordText(userText)
  for (const keyword of skillMetadataKeywords(skill)) {
    if (keywordMatchesText(compactText, keyword)) return true
  }
  const tokens = [...new Set(`${skill.name} ${skill.description}`.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 5))]
  return tokens.some((token) => text.includes(token))
}

function keywordMatchesText(compactText: string, keyword: string) {
  const compactKeyword = compactKeywordText(keyword)
  if (!compactKeyword.includes("*")) return compactText.includes(compactKeyword)
  const segments = compactKeyword.split("*").filter(Boolean)
  if (segments.length === 0) return false
  let offset = 0
  for (const segment of segments) {
    const index = compactText.indexOf(segment, offset)
    if (index < 0) return false
    offset = index + segment.length
  }
  return true
}

function skillMetadataKeywords(skill: SkillMetadata) {
  const rawValues = [
    skill.metadata.keywords,
    skill.metadata.keyword,
    skill.metadata.triggers,
    skill.metadata.triggerKeywords,
  ].filter(Boolean)
  const keywords = new Set<string>()
  for (const raw of rawValues) {
    for (const item of splitMetadataKeywords(raw)) {
      const clean = item.trim()
      if (clean.length >= 2) keywords.add(clean)
    }
  }
  return [...keywords]
}

function splitMetadataKeywords(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map((item) => String(item))
    } catch {
      // Fall through to delimiter-based parsing.
    }
  }
  return trimmed.split(/[,;\n|]/)
}

function compactKeywordText(input: string) {
  return input.toLowerCase().replace(/\s+/g, "")
}

function trimCatalog(lines: string[], maxBytes: number) {
  const output: string[] = []
  let bytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8")
    if (output.length > 0 && bytes + lineBytes > maxBytes) {
      output.push(`... ${lines.length - output.length} more skill(s) omitted by catalog budget.`)
      break
    }
    output.push(line)
    bytes += lineBytes
  }
  return output.join("\n")
}

function normalizeCommandName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function normalizeSkillCommandName(name: string) {
  return normalizeCommandName(name)
}

export function normalizeSkillAllowedTools(input: string | string[] | undefined) {
  return normalizeAllowedTools(input)
}

export function extractSkillReferencedResourceFiles(body: string) {
  return extractReferencedResourceFiles(body)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "")
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function escapeAttribute(input: string) {
  return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
