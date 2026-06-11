import { spawn } from "node:child_process"
import * as vscode from "vscode"
import { AuditLog } from "./audit-log"
import { decidePermission, type PermissionDecision, type ToolRequest } from "./permissions"
import type { PermissionMode } from "./types"

export type ToolRuntimeInput = {
  sessionID?: string
  mode: PermissionMode
  name: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}

export type ToolRuntimeResult = {
  title: string
  output: string
  approved: boolean
  requiresApproval?: boolean
  risk?: string
}

const MAX_OUTPUT_BYTES = 64 * 1024

export class ToolRuntime {
  constructor(
    private readonly audit: AuditLog,
    private readonly output?: vscode.OutputChannel,
  ) {}

  async execute(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
    switch (input.name) {
      case "chipmate_read_file":
        return this.readFile(input)
      case "chipmate_write_file":
        return this.writeFile(input)
      case "chipmate_run_command":
        return this.runCommand(input)
      case "chipmate_http_request":
        return this.httpRequest(input)
      default:
        return {
          title: input.name,
          output: `Unknown ChipMate tool: ${input.name}`,
          approved: false,
        }
    }
  }

  toolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chipmate_read_file",
          description: "Read a UTF-8 text file from the current workspace host.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to read." },
          }, ["path"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_write_file",
          description: "Write UTF-8 text to a file on the current workspace host.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to write." },
            content: { type: "string", description: "Full file content to write." },
          }, ["path", "content"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_run_command",
          description: "Run a shell command on the current workspace host.",
          parameters: objectSchema({
            command: { type: "string", description: "Command line to run with the platform default shell." },
            cwd: { type: "string", description: "Optional working directory. Defaults to the workspace root." },
          }, ["command"]),
        },
      },
      {
        type: "function",
        function: {
          name: "chipmate_http_request",
          description: "Call an HTTP endpoint reachable from the current workspace host.",
          parameters: objectSchema({
            url: { type: "string", description: "HTTP or HTTPS URL." },
            method: { type: "string", description: "HTTP method, default GET." },
            body: { type: "string", description: "Optional request body." },
          }, ["url"]),
        },
      },
    ]
  }

  private async readFile(input: ToolRuntimeInput) {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const request: ToolRequest = {
      id: randomId(),
      kind: "read",
      title: "Read file",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, tool: input.name })
    if (!decision.approved) return blocked("Read file", decision)
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(target)))
    return {
      title: `Read file: ${target}`,
      output: truncateBytes(text, MAX_OUTPUT_BYTES),
      approved: true,
      risk: decision.risk,
    }
  }

  private async writeFile(input: ToolRuntimeInput) {
    const target = resolveWorkspacePath(stringArg(input.arguments.path))
    const content = stringArg(input.arguments.content)
    const request: ToolRequest = {
      id: randomId(),
      kind: "write",
      title: "Write file",
      summary: target,
      target,
    }
    const decision = await this.resolvePermission(input, request, { path: target, bytes: Buffer.byteLength(content, "utf8"), tool: input.name })
    if (!decision.approved) return blocked("Write file", decision)
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new TextEncoder().encode(content))
    return {
      title: `Wrote file: ${target}`,
      output: `Wrote ${Buffer.byteLength(content, "utf8")} byte(s).`,
      approved: true,
      risk: decision.risk,
    }
  }

  private async runCommand(input: ToolRuntimeInput) {
    const command = stringArg(input.arguments.command)
    const cwd = resolveWorkspacePath(stringArg(input.arguments.cwd) || workspaceRoot())
    const request: ToolRequest = {
      id: randomId(),
      kind: "command",
      title: "Run command",
      summary: command,
      command,
      cwd,
    }
    const decision = await this.resolvePermission(input, request, { command, cwd, tool: input.name })
    if (!decision.approved) return blocked("Run command", decision)
    const output = await runShell(command, cwd, input.signal)
    return {
      title: `Command: ${command}`,
      output: truncateBytes(output, MAX_OUTPUT_BYTES),
      approved: true,
      risk: decision.risk,
    }
  }

  private async httpRequest(input: ToolRuntimeInput) {
    const url = stringArg(input.arguments.url)
    const method = stringArg(input.arguments.method) || "GET"
    const body = stringArg(input.arguments.body)
    const request: ToolRequest = {
      id: randomId(),
      kind: "network",
      title: "HTTP request",
      summary: `${method.toUpperCase()} ${url}`,
      url,
      method,
    }
    const decision = await this.resolvePermission(input, request, { url, method, hasBody: Boolean(body), tool: input.name })
    if (!decision.approved) return blocked("HTTP request", decision)
    const response = await fetch(url, {
      method,
      body: body || undefined,
      signal: input.signal,
    })
    const text = await response.text()
    return {
      title: `${method.toUpperCase()} ${url}`,
      output: truncateBytes(`HTTP ${response.status} ${response.statusText}\n${text}`, MAX_OUTPUT_BYTES),
      approved: true,
      risk: decision.risk,
    }
  }

  private async resolvePermission(input: ToolRuntimeInput, request: ToolRequest, detail: unknown): Promise<PermissionDecision> {
    let decision = decidePermission({ mode: input.mode, request })
    if (!decision.approved && decision.requiresApproval) {
      const approveLabel = "批准一次"
      const picked = await vscode.window.showWarningMessage(
        `ChipMate 请求执行：${request.title}`,
        {
          modal: true,
          detail: `${request.summary}\n\n风险等级：${decision.risk}\n原因：${decision.reason}`,
        },
        approveLabel,
        "拒绝",
      )
      decision = picked === approveLabel
        ? { ...decision, approved: true, requiresApproval: false, reason: `user approved once; ${decision.reason}` }
        : { ...decision, approved: false, reason: `user denied approval; ${decision.reason}` }
    }
    await this.auditDecision(input, decision, detail)
    return decision
  }

  private async auditDecision(input: ToolRuntimeInput, decision: { approved: boolean; risk: string; reason: string }, detail: unknown) {
    this.output?.appendLine(`[tool] ${input.name} approved=${decision.approved} risk=${decision.risk} reason=${decision.reason}`)
    await this.audit.append({
      id: randomId(),
      at: Date.now(),
      sessionID: input.sessionID,
      kind: input.name,
      title: input.name,
      approved: decision.approved,
      risk: decision.risk,
      reason: decision.reason,
      detail,
    })
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function blocked(title: string, decision: { reason: string; risk: string; requiresApproval: boolean }): ToolRuntimeResult {
  return {
    title,
    output: `Blocked by ChipMate permissions: ${decision.reason}`,
    approved: false,
    requiresApproval: decision.requiresApproval,
    risk: decision.risk,
  }
}

function runShell(command: string, cwd: string, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh"
    const args = process.platform === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["-lc", command]
    const child = spawn(shell, args, { cwd, shell: false })
    let output = ""
    const onAbort = () => {
      child.kill()
      reject(new Error("Command aborted."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort)
      resolve(`${output}${code === 0 ? "" : `\n[exit code ${code ?? "unknown"}]`}`)
    })
  })
}

function resolveWorkspacePath(input: string) {
  if (!input) return workspaceRoot()
  const uri = vscode.Uri.file(input)
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(input)) return uri.fsPath
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), ...input.split(/[\\/]/)).fsPath
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}

function stringArg(input: unknown) {
  return typeof input === "string" ? input : ""
}

function truncateBytes(input: string, maxBytes: number) {
  const bytes = Buffer.from(input, "utf8")
  if (bytes.length <= maxBytes) return input
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
