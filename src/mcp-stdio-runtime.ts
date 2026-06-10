import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promises as fs } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { AgentToolExecutor } from "./agent-runtime"
import type { OpenAIChatTool, OpenAIChatToolCall } from "./openai-chat-client"
import { decideChipMatePermission, type ChipMateApprovalResult, type ChipMatePermissionDecision, type ChipMatePermissionProfile } from "./permissions"
import type { InstalledChipMatePackage } from "./skills-installer"
import type { ToolRegistryEntry } from "./tool-registry"

export type McpStdioManifest = {
  name?: string
  transport: "stdio"
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpToolResult = {
  ok: boolean
  packageId: string
  tool: string
  result?: unknown
  permission?: ChipMatePermissionDecision
}

export type McpStdioRuntimeOptions = {
  packages: InstalledChipMatePackage[]
  permissionProfile?: ChipMatePermissionProfile
  workspaceRoots?: string[]
  requestTimeoutMs?: number
  isToolApproved?: (packageId: string, toolName: string) => boolean
  requestApproval?: (
    permission: ChipMatePermissionDecision,
    context: {
      capability: "runMcpTool"
      key: string
      packageId: string
      toolName: string
      command: string
      cwd: string
    },
  ) => Promise<ChipMateApprovalResult> | ChipMateApprovalResult
}

const MCP_MANIFEST = "mcp.json"
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class McpStdioRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpStdioRuntimeError"
  }
}

export class McpStdioRuntime {
  constructor(private readonly options: McpStdioRuntimeOptions) {}

  async registryEntries(): Promise<ToolRegistryEntry[]> {
    const entries: ToolRegistryEntry[] = []
    for (const pkg of this.options.packages.filter((item) => item.type === "mcp")) {
      const manifest = await readMcpManifest(pkg.root)
      const tools = await withMcpClient(pkg, manifest, this.options.requestTimeoutMs, async (client) => client.listTools())
      for (const tool of tools) entries.push(this.registryEntry(pkg, manifest, tool))
    }
    return entries
  }

  private registryEntry(pkg: InstalledChipMatePackage, manifest: McpStdioManifest, tool: McpToolInfo): ToolRegistryEntry {
    const exposedName = mcpToolName(pkg.id, tool.name)
    return {
      name: exposedName,
      aliases: [exposedName.replace(/_/g, ".")],
      definition: {
        type: "function",
        function: {
          name: exposedName,
          description: tool.description || `MCP tool ${tool.name} from ${pkg.name}.`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      },
      execute: async (call, input) => this.executeMcpTool(pkg, manifest, tool.name, call, input),
    }
  }

  private async executeMcpTool(
    pkg: InstalledChipMatePackage,
    manifest: McpStdioManifest,
    toolName: string,
    call: OpenAIChatToolCall,
    input: Parameters<AgentToolExecutor>[1],
  ): Promise<McpToolResult> {
    const args = parseToolArguments(call.function.arguments)
    const commandText = [manifest.command, ...(manifest.args ?? []), `tools/call:${toolName}`].join(" ")
    const permission = decideChipMatePermission({
      profile: this.options.permissionProfile ?? "askApproval",
      capability: "runMcpTool",
      command: commandText,
      cwd: resolveMcpCwd(pkg.root, manifest),
      workspaceRoots: this.options.workspaceRoots,
      previouslyApproved: this.options.isToolApproved?.(pkg.id, toolName) ?? false,
    })
    const resolvedPermission = await this.resolvePermission(permission, {
      capability: "runMcpTool",
      key: `${pkg.id}:${toolName}`,
      packageId: pkg.id,
      toolName,
      command: commandText,
      cwd: resolveMcpCwd(pkg.root, manifest),
    })
    if (resolvedPermission.status !== "allow") {
      return {
        ok: false,
        packageId: pkg.id,
        tool: toolName,
        permission: resolvedPermission,
      }
    }

    const result = await withMcpClient(pkg, manifest, this.options.requestTimeoutMs, async (client) => client.callTool(toolName, args), input.signal)
    return {
      ok: !isMcpErrorResult(result),
      packageId: pkg.id,
      tool: toolName,
      result,
      permission: resolvedPermission,
    }
  }

  private async resolvePermission(
    permission: ChipMatePermissionDecision,
    context: Parameters<NonNullable<McpStdioRuntimeOptions["requestApproval"]>>[1],
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

export async function readMcpManifest(root: string): Promise<McpStdioManifest> {
  const raw = await fs.readFile(join(root, MCP_MANIFEST), "utf8")
  const parsed = JSON.parse(raw) as Partial<McpStdioManifest>
  if (parsed.transport !== "stdio") throw new McpStdioRuntimeError(`${MCP_MANIFEST} must declare stdio transport.`)
  if (!parsed.command || typeof parsed.command !== "string") throw new McpStdioRuntimeError(`${MCP_MANIFEST} must declare a command.`)
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    transport: "stdio",
    command: parsed.command,
    args: Array.isArray(parsed.args) ? parsed.args.filter((item): item is string => typeof item === "string") : [],
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    env: stringRecord(parsed.env),
  }
}

export function mcpToolName(packageId: string, toolName: string) {
  return `mcp_${safeToolSegment(packageId)}_${safeToolSegment(toolName)}`
}

async function withMcpClient<T>(
  pkg: InstalledChipMatePackage,
  manifest: McpStdioManifest,
  timeoutMs: number | undefined,
  callback: (client: McpStdioClient) => Promise<T>,
  signal?: AbortSignal,
) {
  const client = new McpStdioClient({
    root: pkg.root,
    manifest,
    timeoutMs: timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  })
  try {
    await client.start(signal)
    await client.initialize()
    return await callback(client)
  } finally {
    client.dispose()
  }
}

class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private stdout = Buffer.alloc(0)
  private stderr = ""
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(private readonly options: {
    root: string
    manifest: McpStdioManifest
    timeoutMs: number
  }) {}

  async start(signal?: AbortSignal) {
    const cwd = resolveMcpCwd(this.options.root, this.options.manifest)
    const command = resolveMcpCommand(this.options.root, this.options.manifest.command)
    this.child = spawn(command, this.options.manifest.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.options.manifest.env ?? {}) },
      shell: false,
    })
    this.child.stdout.on("data", (chunk) => this.handleStdout(Buffer.from(chunk)))
    this.child.stderr.on("data", (chunk) => {
      this.stderr += Buffer.from(chunk).toString("utf8").slice(0, 4096)
    })
    this.child.on("error", (error) => this.rejectAll(error))
    this.child.on("exit", (code, signalName) => {
      if (this.pending.size > 0) this.rejectAll(new McpStdioRuntimeError(`MCP server exited early (${code ?? signalName ?? "unknown"}): ${this.stderr.trim()}`))
    })
    if (signal) {
      if (signal.aborted) throw new McpStdioRuntimeError("MCP request was cancelled.")
      signal.addEventListener("abort", () => this.dispose(), { once: true })
    }
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ChipMate", version: "1" },
    })
    this.notify("notifications/initialized", {})
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request("tools/list", {})
    const tools = objectRecord(result).tools
    if (!Array.isArray(tools)) return []
    return tools
      .map((tool) => normalizeMcpTool(tool))
      .filter((tool): tool is McpToolInfo => Boolean(tool))
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return await this.request("tools/call", { name, arguments: args })
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new McpStdioRuntimeError("MCP client disposed."))
    }
    this.pending.clear()
    this.child?.kill()
    this.child = undefined
  }

  private request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++
    const message = { jsonrpc: "2.0", id, method, params }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpStdioRuntimeError(`MCP request timed out: ${method}`))
      }, this.options.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.writeMessage(message)
    return promise
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.writeMessage({ jsonrpc: "2.0", method, params })
  }

  private writeMessage(message: Record<string, unknown>) {
    if (!this.child) throw new McpStdioRuntimeError("MCP client is not started.")
    const body = JSON.stringify(message)
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`)
  }

  private handleStdout(chunk: Buffer) {
    this.stdout = Buffer.concat([this.stdout, chunk])
    while (true) {
      const separator = this.stdout.indexOf("\r\n\r\n")
      if (separator === -1) return
      const header = this.stdout.subarray(0, separator).toString("utf8")
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
      if (!lengthMatch) throw new McpStdioRuntimeError("MCP response is missing Content-Length.")
      const length = Number(lengthMatch[1])
      const start = separator + 4
      const end = start + length
      if (this.stdout.byteLength < end) return
      const body = this.stdout.subarray(start, end).toString("utf8")
      this.stdout = this.stdout.subarray(end)
      this.handleMessage(JSON.parse(body) as Record<string, unknown>)
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    const id = typeof message.id === "number" ? message.id : undefined
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (message.error) {
      pending.reject(new McpStdioRuntimeError(`MCP request failed: ${JSON.stringify(message.error)}`))
      return
    }
    pending.resolve(message.result)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function resolveMcpCommand(root: string, command: string) {
  return isAbsolute(command) ? command : resolve(root, command)
}

function resolveMcpCwd(root: string, manifest: McpStdioManifest) {
  if (!manifest.cwd) return root
  return isAbsolute(manifest.cwd) ? manifest.cwd : resolve(root, manifest.cwd)
}

function normalizeMcpTool(input: unknown): McpToolInfo | undefined {
  const tool = objectRecord(input)
  if (typeof tool.name !== "string" || !tool.name.trim()) return
  const inputSchema = objectRecord(tool.inputSchema)
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema: Object.keys(inputSchema).length ? inputSchema : { type: "object", properties: {} },
  }
}

function parseToolArguments(input: string): Record<string, unknown> {
  if (!input.trim()) return {}
  const parsed = JSON.parse(input) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function isMcpErrorResult(input: unknown) {
  return objectRecord(input).isError === true
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  const record = objectRecord(input)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

function safeToolSegment(input: string) {
  const value = input.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
  return value || "tool"
}
