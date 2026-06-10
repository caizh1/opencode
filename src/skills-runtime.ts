import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { basename, isAbsolute, relative, resolve } from "node:path"
import type { AgentToolExecutor } from "./agent-runtime"
import type { OpenAIChatTool, OpenAIChatToolCall } from "./openai-chat-client"
import { decideChipMatePermission, type ChipMateApprovalResult, type ChipMatePermissionDecision, type ChipMatePermissionProfile } from "./permissions"
import { isSafePackageRelativePath } from "./skills-catalog"

export type InstalledSkill = {
  id: string
  root: string
  version?: string
  enabled?: boolean
}

export type SkillFrontmatter = Record<string, string | string[] | boolean | number>

export type SkillSummary = {
  id: string
  name: string
  description: string
  version?: string
  root: string
  allowedTools: string[]
  compatibility: string[]
}

export type SkillActivation = SkillSummary & {
  instructions: string
  content: string
  frontmatter: SkillFrontmatter
}

export type SkillResource = {
  skillId: string
  path: string
  content: string
  truncated: boolean
}

export type SkillRunScriptResult = {
  ok: boolean
  skillId: string
  script: string
  stdout: string
  stderr: string
  exitCode?: number
  signal?: string
  elapsedMs: number
  permission: ChipMatePermissionDecision
}

export type SkillRuntimeOptions = {
  skills: InstalledSkill[]
  maxResourceBytes?: number
  maxScriptOutputBytes?: number
  scriptTimeoutMs?: number
  permissionProfile?: ChipMatePermissionProfile
  workspaceRoots?: string[]
  isScriptApproved?: (skillId: string, script: string) => boolean
  requestApproval?: (
    permission: ChipMatePermissionDecision,
    context: {
      capability: "runSkillScript"
      key: string
      skillId: string
      script: string
      command: string
      cwd: string
    },
  ) => Promise<ChipMateApprovalResult> | ChipMateApprovalResult
}

const SKILL_MARKDOWN = "SKILL.md"
const RESOURCE_ROOTS = ["references", "assets", "templates"]
const DEFAULT_MAX_RESOURCE_BYTES = 80_000
const DEFAULT_MAX_SCRIPT_OUTPUT_BYTES = 120_000
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000

export class SkillRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkillRuntimeError"
  }
}

export class SkillsRuntime {
  constructor(private readonly options: SkillRuntimeOptions) {}

  async listSkills(): Promise<SkillSummary[]> {
    const summaries = await Promise.all(this.enabledSkills().map((skill) => this.skillSummary(skill)))
    return summaries.sort((left, right) => left.name.localeCompare(right.name))
  }

  async activateSkill(skillId: string): Promise<SkillActivation> {
    const skill = this.requireSkill(skillId)
    const loaded = await this.loadSkillMarkdown(skill)
    return {
      ...this.summaryFromLoaded(skill, loaded),
      instructions: loaded.body.trim(),
      content: loaded.raw,
      frontmatter: loaded.frontmatter,
    }
  }

  async readResource(input: {
    skillId: string
    path: string
    maxBytes?: number
  }): Promise<SkillResource> {
    const skill = this.requireSkill(input.skillId)
    const resourcePath = normalizeRelativePath(input.path)
    if (!isAllowedResourcePath(resourcePath)) {
      throw new SkillRuntimeError("Skill resources are limited to SKILL.md, references/, assets/, and templates/.")
    }
    const absolute = resolveSkillPath(skill.root, resourcePath)
    const maxBytes = input.maxBytes ?? this.options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES
    const bytes = await fs.readFile(absolute)
    const truncated = bytes.byteLength > maxBytes
    const selected = truncated ? bytes.subarray(0, maxBytes) : bytes
    return {
      skillId: skill.id,
      path: resourcePath,
      content: new TextDecoder().decode(selected),
      truncated,
    }
  }

  async runScript(input: {
    skillId: string
    script: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    permissionProfile?: ChipMatePermissionProfile
    timeoutMs?: number
  }): Promise<SkillRunScriptResult> {
    const started = Date.now()
    const skill = this.requireSkill(input.skillId)
    const scriptPath = normalizeRelativePath(input.script)
    if (!scriptPath.startsWith("scripts/")) {
      throw new SkillRuntimeError("Skill scripts must live under scripts/.")
    }
    const absoluteScript = resolveSkillPath(skill.root, scriptPath)
    const cwd = input.cwd ? resolveSkillPath(skill.root, normalizeRelativePath(input.cwd)) : skill.root
    const command = absoluteScript
    const permission = decideChipMatePermission({
      profile: input.permissionProfile ?? this.options.permissionProfile ?? "askApproval",
      capability: "runSkillScript",
      command: [command, ...(input.args ?? [])].join(" "),
      cwd,
      workspaceRoots: this.options.workspaceRoots,
      previouslyApproved: this.options.isScriptApproved?.(skill.id, scriptPath) ?? false,
    })
    const resolvedPermission = await this.resolvePermission(permission, {
      capability: "runSkillScript",
      key: `${skill.id}:${scriptPath}`,
      skillId: skill.id,
      script: scriptPath,
      command: [command, ...(input.args ?? [])].join(" "),
      cwd,
    })
    if (resolvedPermission.status !== "allow") {
      return {
        ok: false,
        skillId: skill.id,
        script: scriptPath,
        stdout: "",
        stderr: resolvedPermission.reason,
        elapsedMs: Date.now() - started,
        permission: resolvedPermission,
      }
    }

    const result = await spawnSkillScript({
      command,
      args: input.args ?? [],
      cwd,
      env: input.env,
      timeoutMs: input.timeoutMs ?? this.options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
      maxOutputBytes: this.options.maxScriptOutputBytes ?? DEFAULT_MAX_SCRIPT_OUTPUT_BYTES,
    })
    return {
      ok: result.exitCode === 0,
      skillId: skill.id,
      script: scriptPath,
      ...result,
      elapsedMs: Date.now() - started,
      permission: resolvedPermission,
    }
  }

  toolDefinitions(): OpenAIChatTool[] {
    return skillRuntimeToolDefinitions()
  }

  toolExecutor(): AgentToolExecutor {
    return async (call) => this.executeToolCall(call)
  }

  async executeToolCall(call: OpenAIChatToolCall) {
    const name = normalizeToolName(call.function.name)
    const args = parseToolArguments(call.function.arguments)
    switch (name) {
      case "skill_list":
        return { skills: await this.listSkills() }
      case "skill_activate":
        return await this.activateSkill(requiredArg(args, "skillId"))
      case "skill_read_resource":
        return await this.readResource({
          skillId: requiredArg(args, "skillId"),
          path: requiredArg(args, "path"),
          maxBytes: numberArg(args, "maxBytes"),
        })
      case "skill_run_script":
        return await this.runScript({
          skillId: requiredArg(args, "skillId"),
          script: requiredArg(args, "script"),
          args: stringArrayArg(args, "args"),
          cwd: stringArg(args, "cwd"),
          env: stringRecordArg(args, "env"),
          timeoutMs: numberArg(args, "timeoutMs"),
        })
      default:
        throw new SkillRuntimeError(`Unknown skill tool: ${call.function.name}`)
    }
  }

  private enabledSkills() {
    return this.options.skills.filter((skill) => skill.enabled !== false)
  }

  private requireSkill(skillId: string) {
    const match = this.enabledSkills().find((skill) => skill.id === skillId)
    if (!match) throw new SkillRuntimeError(`Skill is not enabled or installed: ${skillId}`)
    return match
  }

  private async skillSummary(skill: InstalledSkill): Promise<SkillSummary> {
    return this.summaryFromLoaded(skill, await this.loadSkillMarkdown(skill))
  }

  private summaryFromLoaded(skill: InstalledSkill, loaded: ParsedSkillMarkdown): SkillSummary {
    const name = stringFrontmatter(loaded.frontmatter, "name") || skill.id
    const description = stringFrontmatter(loaded.frontmatter, "description") || firstParagraph(loaded.body)
    return {
      id: skill.id,
      name,
      description,
      version: skill.version,
      root: skill.root,
      allowedTools: arrayFrontmatter(loaded.frontmatter, "allowed-tools"),
      compatibility: arrayFrontmatter(loaded.frontmatter, "compatibility"),
    }
  }

  private async loadSkillMarkdown(skill: InstalledSkill) {
    const path = resolveSkillPath(skill.root, SKILL_MARKDOWN)
    const raw = await fs.readFile(path, "utf8")
    return parseSkillMarkdown(raw)
  }

  private async resolvePermission(
    permission: ChipMatePermissionDecision,
    context: Parameters<NonNullable<SkillRuntimeOptions["requestApproval"]>>[1],
  ): Promise<ChipMatePermissionDecision> {
    if (permission.status !== "ask") return permission
    if (!this.options.requestApproval) return permission
    const approval = await this.options.requestApproval(permission, context)
    if (approval === "deny") return { status: "deny", reason: `${permission.reason} User denied this request.` }
    return {
      status: "allow",
      reason: approval === "allowAlways"
        ? `${permission.reason} User approved this operation and future matching requests.`
        : `${permission.reason} User approved this operation once.`,
    }
  }
}

export function skillRuntimeToolDefinitions(): OpenAIChatTool[] {
  return [
    {
      type: "function",
      function: {
        name: "skill_list",
        description: "List enabled ChipMate skills available in the current workspace.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill_activate",
        description: "Load the full SKILL.md instructions for an enabled skill.",
        parameters: {
          type: "object",
          properties: {
            skillId: { type: "string" },
          },
          required: ["skillId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill_read_resource",
        description: "Read a resource file from an enabled skill package.",
        parameters: {
          type: "object",
          properties: {
            skillId: { type: "string" },
            path: { type: "string" },
            maxBytes: { type: "number" },
          },
          required: ["skillId", "path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill_run_script",
        description: "Run a script from an enabled skill package under the current workspace permission profile.",
        parameters: {
          type: "object",
          properties: {
            skillId: { type: "string" },
            script: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            timeoutMs: { type: "number" },
          },
          required: ["skillId", "script"],
          additionalProperties: false,
        },
      },
    },
  ]
}

type ParsedSkillMarkdown = {
  raw: string
  frontmatter: SkillFrontmatter
  body: string
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const normalized = raw.replace(/^\uFEFF/, "")
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { raw, frontmatter: {}, body: normalized }
  }
  const lines = normalized.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return { raw, frontmatter: {}, body: normalized }
  const frontmatter = parseSimpleYaml(lines.slice(1, end))
  return {
    raw,
    frontmatter,
    body: lines.slice(end + 1).join("\n"),
  }
}

function parseSimpleYaml(lines: string[]): SkillFrontmatter {
  const result: SkillFrontmatter = {}
  let activeArrayKey = ""
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    if (activeArrayKey && line.startsWith("- ")) {
      const current = result[activeArrayKey]
      const values = Array.isArray(current) ? current : []
      result[activeArrayKey] = [...values, unquote(line.slice(2).trim())]
      continue
    }
    activeArrayKey = ""
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const value = match[2] ?? ""
    if (!value) {
      result[key] = []
      activeArrayKey = key
      continue
    }
    result[key] = parseYamlScalar(value)
  }
  return result
}

function parseYamlScalar(value: string): string | string[] | boolean | number {
  const trimmed = value.trim()
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed.slice(1, -1).split(",").map((part) => unquote(part.trim())).filter(Boolean)
  }
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) return numeric
  return unquote(trimmed)
}

function unquote(input: string) {
  return input.replace(/^['"]|['"]$/g, "")
}

function resolveSkillPath(root: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  const absolute = resolve(root, normalized)
  const rel = relative(resolve(root), absolute)
  if (rel.startsWith("..") || isAbsolute(rel)) throw new SkillRuntimeError("Skill path escapes the package root.")
  return absolute
}

function normalizeRelativePath(input: string) {
  const value = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
  if (!isSafePackageRelativePath(value)) throw new SkillRuntimeError("Skill path must be a safe relative package path.")
  return value
}

function isAllowedResourcePath(input: string) {
  return input === SKILL_MARKDOWN || RESOURCE_ROOTS.some((root) => input === root || input.startsWith(`${root}/`))
}

function normalizeToolName(input: string) {
  return input.replace(/\./g, "_")
}

function parseToolArguments(input: string) {
  if (!input.trim()) return {}
  try {
    const parsed = JSON.parse(input) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw new SkillRuntimeError("Skill tool arguments must be valid JSON.")
  }
}

function requiredArg(args: Record<string, unknown>, key: string) {
  const value = stringArg(args, key)
  if (!value) throw new SkillRuntimeError(`${key} is required.`)
  return value
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === "string" ? value : ""
}

function numberArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined
}

function stringArrayArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function stringRecordArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") result[entryKey] = entryValue
  }
  return result
}

function stringFrontmatter(frontmatter: SkillFrontmatter, key: string) {
  const value = frontmatter[key]
  return typeof value === "string" ? value : ""
}

function arrayFrontmatter(frontmatter: SkillFrontmatter, key: string) {
  const value = frontmatter[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  return []
}

function firstParagraph(input: string) {
  return input.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").slice(0, 240) ?? ""
}

function spawnSkillScript(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}) {
  return new Promise<{
    stdout: string
    stderr: string
    exitCode?: number
    signal?: string
  }>((resolvePromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
      },
      shell: false,
    })
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
    }, input.timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk, input.maxOutputBytes)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk, input.maxOutputBytes)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        stdout: stdout.toString("utf8"),
        stderr: `${stderr.toString("utf8")}${error.message}`,
        exitCode: 1,
      })
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      })
    })
  })
}

function appendCapped(existing: Buffer, next: Buffer, max: number) {
  if (existing.byteLength >= max) return existing
  const remaining = max - existing.byteLength
  return Buffer.concat([existing, next.subarray(0, remaining)])
}
