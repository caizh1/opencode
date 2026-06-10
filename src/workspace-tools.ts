import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { AgentToolExecutor } from "./agent-runtime"
import type { OpenAIChatTool, OpenAIChatToolCall } from "./openai-chat-client"
import { decideChipMatePermission, type ChipMateApprovalResult, type ChipMatePermissionDecision, type ChipMatePermissionProfile } from "./permissions"
import type { ToolRegistryEntry } from "./tool-registry"

export type WorkspaceToolsOptions = {
  workspaceRoots: string[]
  permissionProfile?: ChipMatePermissionProfile
  isApproved?: (capability: "writeWorkspace" | "runShell", key: string) => boolean
  requestApproval?: (
    permission: ChipMatePermissionDecision,
    context: {
      capability: "writeWorkspace" | "runShell"
      key: string
      command?: string
      targetPath?: string
      cwd?: string
    },
  ) => Promise<ChipMateApprovalResult> | ChipMateApprovalResult
  maxReadBytes?: number
  maxSearchResults?: number
  shellTimeoutMs?: number
  maxShellOutputBytes?: number
}

export type WorkspaceToolResult = {
  ok: boolean
  permission?: ChipMatePermissionDecision
  [key: string]: unknown
}

const DEFAULT_MAX_READ_BYTES = 80_000
const DEFAULT_MAX_SEARCH_RESULTS = 50
const DEFAULT_SHELL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_SHELL_OUTPUT_BYTES = 120_000
const DEFAULT_EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", "out", "build", ".vscode-test"])

export class WorkspaceToolsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceToolsError"
  }
}

export class WorkspaceTools {
  constructor(private readonly options: WorkspaceToolsOptions) {
    if (options.workspaceRoots.length === 0) throw new WorkspaceToolsError("At least one workspace root is required.")
  }

  toolDefinitions(): OpenAIChatTool[] {
    return workspaceToolDefinitions()
  }

  registryEntries(): ToolRegistryEntry[] {
    const executor = this.toolExecutor()
    return this.toolDefinitions().map((definition) => ({
      name: definition.function.name,
      aliases: [definition.function.name.replace(/_/g, ".")],
      definition,
      execute: executor,
    }))
  }

  toolExecutor(): AgentToolExecutor {
    return async (call, input) => this.executeToolCall(call, input)
  }

  async executeToolCall(call: OpenAIChatToolCall, input: Parameters<AgentToolExecutor>[1]) {
    const name = call.function.name.replace(/\./g, "_")
    const args = parseToolArguments(call.function.arguments)
    switch (name) {
      case "workspace_search":
        return await this.search({
          query: requiredString(args, "query"),
          path: stringValue(args.path),
          maxResults: numberValue(args.maxResults),
        })
      case "workspace_read_file":
        return await this.readFile({
          path: requiredString(args, "path"),
          maxBytes: numberValue(args.maxBytes),
        })
      case "workspace_write_file":
        return await this.writeFile({
          path: requiredString(args, "path"),
          content: requiredString(args, "content"),
        })
      case "shell_run":
        return await this.runShell({
          command: requiredString(args, "command"),
          cwd: stringValue(args.cwd),
          timeoutMs: numberValue(args.timeoutMs),
        }, input.signal)
      default:
        throw new WorkspaceToolsError(`Unknown workspace tool: ${call.function.name}`)
    }
  }

  async search(input: {
    query: string
    path?: string
    maxResults?: number
  }): Promise<WorkspaceToolResult> {
    const root = this.workspaceRootFor(input.path || ".")
    const start = input.path ? this.resolveWorkspacePath(input.path) : root
    const maxResults = Math.max(1, Math.min(500, input.maxResults ?? this.options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS))
    const results: Array<{ path: string; line?: number; preview?: string }> = []
    await walkFiles(start, async (file) => {
      if (results.length >= maxResults) return false
      const text = await fs.readFile(file, "utf8").catch(() => "")
      if (!text) return true
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]!.includes(input.query)) continue
        results.push({
          path: this.relativeWorkspacePath(file),
          line: index + 1,
          preview: lines[index]!.trim().slice(0, 240),
        })
        if (results.length >= maxResults) return false
      }
      return true
    })
    return { ok: true, results, truncated: results.length >= maxResults }
  }

  async readFile(input: {
    path: string
    maxBytes?: number
  }): Promise<WorkspaceToolResult> {
    const absolute = this.resolveWorkspacePath(input.path)
    const bytes = await fs.readFile(absolute)
    const maxBytes = input.maxBytes ?? this.options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
    const truncated = bytes.byteLength > maxBytes
    const selected = truncated ? bytes.subarray(0, maxBytes) : bytes
    return {
      ok: true,
      path: this.relativeWorkspacePath(absolute),
      content: new TextDecoder().decode(selected),
      truncated,
    }
  }

  async writeFile(input: {
    path: string
    content: string
  }): Promise<WorkspaceToolResult> {
    const absolute = this.resolveWorkspacePath(input.path)
    const permission = decideChipMatePermission({
      profile: this.options.permissionProfile ?? "askApproval",
      capability: "writeWorkspace",
      targetPath: absolute,
      workspaceRoots: this.options.workspaceRoots,
      previouslyApproved: this.options.isApproved?.("writeWorkspace", this.relativeWorkspacePath(absolute)) ?? false,
    })
    const resolvedPermission = await this.resolvePermission(permission, {
      capability: "writeWorkspace",
      key: this.relativeWorkspacePath(absolute),
      targetPath: absolute,
    })
    if (resolvedPermission.status !== "allow") return { ok: false, permission: resolvedPermission }
    await fs.mkdir(dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, input.content)
    return {
      ok: true,
      path: this.relativeWorkspacePath(absolute),
      bytes: Buffer.byteLength(input.content, "utf8"),
      permission: resolvedPermission,
    }
  }

  async runShell(input: {
    command: string
    cwd?: string
    timeoutMs?: number
  }, signal?: AbortSignal): Promise<WorkspaceToolResult> {
    const cwd = input.cwd ? this.resolveWorkspacePath(input.cwd) : this.options.workspaceRoots[0]!
    const permission = decideChipMatePermission({
      profile: this.options.permissionProfile ?? "askApproval",
      capability: "runShell",
      command: input.command,
      cwd,
      workspaceRoots: this.options.workspaceRoots,
      previouslyApproved: this.options.isApproved?.("runShell", input.command) ?? false,
    })
    const resolvedPermission = await this.resolvePermission(permission, {
      capability: "runShell",
      key: input.command,
      command: input.command,
      cwd,
    })
    if (resolvedPermission.status !== "allow") return { ok: false, permission: resolvedPermission }
    const result = await spawnShell({
      command: input.command,
      cwd,
      signal,
      timeoutMs: input.timeoutMs ?? this.options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      maxOutputBytes: this.options.maxShellOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES,
    })
    return {
      ok: result.exitCode === 0,
      ...result,
      permission: resolvedPermission,
    }
  }

  private resolveWorkspacePath(input: string) {
    const normalized = input.replace(/\\/g, "/")
    if (isAbsolute(normalized)) {
      if (this.options.workspaceRoots.some((root) => isPathInside(normalized, root))) return resolve(normalized)
      throw new WorkspaceToolsError("Path is outside the workspace.")
    }
    const root = this.workspaceRootFor(normalized)
    const absolute = resolve(root, normalized)
    if (!isPathInside(absolute, root)) throw new WorkspaceToolsError("Path escapes the workspace root.")
    return absolute
  }

  private workspaceRootFor(input: string) {
    const normalized = input.replace(/\\/g, "/")
    for (const root of this.options.workspaceRoots) {
      if (normalized === basename(root) || normalized.startsWith(`${basename(root)}/`)) return root
    }
    return this.options.workspaceRoots[0]!
  }

  private relativeWorkspacePath(input: string) {
    const absolute = resolve(input)
    const root = this.options.workspaceRoots.find((candidate) => isPathInside(absolute, candidate)) ?? this.options.workspaceRoots[0]!
    return relative(root, absolute).replace(/\\/g, "/")
  }

  private async resolvePermission(
    permission: ChipMatePermissionDecision,
    context: Parameters<NonNullable<WorkspaceToolsOptions["requestApproval"]>>[1],
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

export function workspaceToolDefinitions(): OpenAIChatTool[] {
  return [
    {
      type: "function",
      function: {
        name: "workspace_search",
        description: "Search text in workspace files.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            maxResults: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "workspace_read_file",
        description: "Read a workspace file, optionally capped by maxBytes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            maxBytes: { type: "number" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "workspace_write_file",
        description: "Write a workspace file under the active permission profile.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shell_run",
        description: "Run a shell command from the workspace host under the active permission profile.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeoutMs: { type: "number" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
  ]
}

function parseToolArguments(input: string) {
  if (!input.trim()) return {}
  try {
    const parsed = JSON.parse(input) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw new WorkspaceToolsError("Tool arguments must be valid JSON.")
  }
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = stringValue(args[key])
  if (!value) throw new WorkspaceToolsError(`${key} is required.`)
  return value
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : undefined
}

async function walkFiles(path: string, onFile: (path: string) => Promise<boolean>): Promise<boolean> {
  const stat = await fs.stat(path)
  if (stat.isFile()) return onFile(path)
  if (!stat.isDirectory()) return true
  const entries = await fs.readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      if (!await walkFiles(child, onFile)) return false
      continue
    }
    if (!entry.isFile()) continue
    if (looksBinaryPath(child)) continue
    if (!await onFile(child)) return false
  }
  return true
}

function looksBinaryPath(path: string) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".wasm", ".zip", ".gz", ".tar", ".pdf", ".vsix"].includes(extname(path).toLowerCase())
}

function isPathInside(path: string, root: string) {
  const normalizedPath = resolve(path)
  const normalizedRoot = resolve(root)
  const rel = relative(normalizedRoot, normalizedPath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function spawnShell(input: {
  command: string
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}) {
  return new Promise<{
    stdout: string
    stderr: string
    exitCode?: number
    signal?: string
  }>((resolvePromise) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: process.env,
    })
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
    }, input.timeoutMs)
    const abort = () => child.kill()
    input.signal?.addEventListener("abort", abort, { once: true })
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
      input.signal?.removeEventListener("abort", abort)
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
      input.signal?.removeEventListener("abort", abort)
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
