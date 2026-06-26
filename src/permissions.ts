import * as vscode from "vscode"
import type { PermissionMode } from "./types"

export type ToolKind = "read" | "write" | "command" | "network"
export type ToolRisk = "low" | "medium" | "high"

export type ToolRequest = {
  id: string
  kind: ToolKind
  title: string
  summary: string
  target?: string
  command?: string
  cwd?: string
  url?: string
  method?: string
}

export type PermissionDecision = {
  approved: boolean
  reason: string
  risk: ToolRisk
  requiresApproval: boolean
}

const SENSITIVE_FILE_NAMES = new Set([".env", ".env.local", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"])

export function decidePermission(input: {
  mode: PermissionMode
  request: ToolRequest
  workspaceFolders?: readonly vscode.WorkspaceFolder[]
}): PermissionDecision {
  const risk = classifyToolRisk(input.request, input.workspaceFolders)
  if (input.mode === "full-access") {
    return { approved: true, reason: "full access mode records this action without prompting", risk, requiresApproval: false }
  }
  if (input.mode === "ask") {
    if (input.request.kind === "read" && risk === "low") {
      return { approved: true, reason: "workspace reads are allowed in ask mode", risk, requiresApproval: false }
    }
    return { approved: false, reason: "ask mode requires approval for writes, commands, and network requests", risk, requiresApproval: true }
  }
  if (risk === "low") {
    return { approved: true, reason: "auto mode approved a low-risk workspace action", risk, requiresApproval: false }
  }
  return { approved: false, reason: "auto mode requires approval for high-risk actions", risk, requiresApproval: true }
}

export function classifyToolRisk(request: ToolRequest, workspaceFolders = vscode.workspace.workspaceFolders ?? []): ToolRisk {
  if (request.kind === "network") return isIntranetUrl(request.url ?? "") ? "low" : "high"
  if (request.kind === "command") return classifyCommandRisk(request.command ?? "")
  if (request.kind === "write") return fileRisk(request.target ?? "", workspaceFolders, true)
  return fileRisk(request.target ?? "", workspaceFolders, false)
}

export function classifyCommandRisk(command: string): ToolRisk {
  return commandRisk(command)
}

export function isIntranetUrl(input: string) {
  try {
    const url = new URL(input)
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true
    if (/^127\./.test(host) || host === "::1") return true
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    const match172 = host.match(/^172\.(\d+)\./)
    if (match172) {
      const second = Number(match172[1])
      if (second >= 16 && second <= 31) return true
    }
    return false
  } catch {
    return false
  }
}

function fileRisk(target: string, workspaceFolders: readonly vscode.WorkspaceFolder[], writing: boolean): ToolRisk {
  if (!target) return "medium"
  const normalized = target.replace(/\\/g, "/")
  const basename = normalized.split("/").pop() ?? ""
  if (SENSITIVE_FILE_NAMES.has(basename) || /(?:^|\/)\.ssh(?:\/|$)/.test(normalized)) return "high"
  const uri = vscode.Uri.file(target)
  const inWorkspace = workspaceFolders.some((folder) => isSubpath(folder.uri.fsPath, uri.fsPath))
  if (!inWorkspace) return writing ? "high" : "medium"
  if (writing && /(?:^|\/)(?:\.git|node_modules|dist|build|out)(?:\/|$)/.test(normalized)) return "high"
  return "low"
}

function commandRisk(command: string): ToolRisk {
  const value = command.trim()
  if (!value) return "medium"
  if (/\b(?:rm\s+-rf|sudo|su\s|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=|shutdown|reboot)\b/i.test(value)) return "high"
  if (/\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i.test(value) && /https?:\/\//i.test(value)) return "high"
  if (/\b(?:git\s+status|git\s+diff|git\s+log|ls|pwd|cat|rg|grep|find|npm\s+test|bun\s+test|bun\s+run\s+lint|bun\s+run\s+compile)\b/i.test(value)) {
    return "low"
  }
  return "medium"
}

function isSubpath(root: string, candidate: string) {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const normalizedCandidate = candidate.replace(/\\/g, "/")
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}
