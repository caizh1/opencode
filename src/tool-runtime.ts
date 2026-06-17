import { spawn } from "node:child_process"
import * as vscode from "vscode"
import { AuditLog } from "./audit-log"
import { parseSupportedDocument } from "./document-parser"
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
  status?: "completed" | "failed" | "blocked" | "approval-required"
  error?: string
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
      case "chipmate_read":
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
          status: "blocked",
        }
    }
  }

  toolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chipmate_read",
          description: "Read a UTF-8 text file or supported Office/PDF document from the current workspace host.",
          parameters: objectSchema({
            path: { type: "string", description: "Absolute or workspace-relative path to read." },
          }, ["path"]),
        },
      },
    ]
  }

  private async readFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
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
    let text: string
    try {
      input.signal?.throwIfAborted()
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target))
      const document = parseSupportedDocument({ path: target, bytes, maxBytes: MAX_OUTPUT_BYTES })
      text = document?.text ?? new TextDecoder().decode(bytes)
    } catch (error) {
      if (input.signal?.aborted) throw error
      if (isFileNotFoundError(error)) {
        const output = `File not found: ${target}`
        return failed(`Read file: ${target}`, output, output, decision.risk)
      }
      const message = formatErrorMessage(error)
      return failed(`Read file: ${target}`, `Read file failed: ${target}\n${message}`, message, decision.risk)
    }
    return {
      title: `Read file: ${target}`,
      output: truncateBytes(text, MAX_OUTPUT_BYTES),
      approved: true,
      status: "completed",
      risk: decision.risk,
    }
  }

  private async writeFile(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
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
      status: "completed",
      risk: decision.risk,
    }
  }

  private async runCommand(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
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
      status: "completed",
      risk: decision.risk,
    }
  }

  private async httpRequest(input: ToolRuntimeInput): Promise<ToolRuntimeResult> {
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
      status: "completed",
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
    status: decision.requiresApproval ? "approval-required" : "blocked",
    requiresApproval: decision.requiresApproval,
    risk: decision.risk,
  }
}

function failed(title: string, output: string, error: string, risk?: string): ToolRuntimeResult {
  return {
    title,
    output,
    approved: false,
    status: "failed",
    error,
    risk,
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

function isFileNotFoundError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  if (code === "ENOENT" || code === "FileNotFound") return true
  return /(?:ENOENT|FileNotFound|EntryNotFound|does not exist|no such file|nonexistent file)/i.test(formatErrorMessage(error))
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
