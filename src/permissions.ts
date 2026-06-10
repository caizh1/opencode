export type ChipMatePermissionProfile = "readOnly" | "askApproval" | "trustedWorkspace" | "fullAccess"

export type ChipMateToolCapability =
  | "readWorkspace"
  | "writeWorkspace"
  | "runShell"
  | "runSkillScript"
  | "runMcpTool"

export type ChipMatePermissionRequest = {
  profile: ChipMatePermissionProfile
  capability: ChipMateToolCapability
  command?: string
  cwd?: string
  targetPath?: string
  workspaceRoots?: string[]
  previouslyApproved?: boolean
}

export type ChipMatePermissionDecision =
  | { status: "allow"; reason: string }
  | { status: "ask"; reason: string; hardProtection?: boolean }
  | { status: "deny"; reason: string; hardProtection?: boolean }

export type ChipMateApprovalResult = "allowOnce" | "allowAlways" | "deny"

const SENSITIVE_PATH_PATTERNS = [
  /^\/$/,
  /^\/etc(?:\/|$)/,
  /^\/bin(?:\/|$)/,
  /^\/sbin(?:\/|$)/,
  /^\/usr\/bin(?:\/|$)/,
  /^\/usr\/sbin(?:\/|$)/,
  /^\/dev(?:\/|$)/,
  /^\/System(?:\/|$)/,
  /^\/Library\/Keychains(?:\/|$)/,
  /^\/var\/db(?:\/|$)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.gnupg(?:\/|$)/,
  /(?:^|\/)\.aws(?:\/|$)/,
  /(?:^|\/)\.kube(?:\/|$)/,
]

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(?:-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\s+(?:--\s+)?(?:\/|~|\$HOME)(?:\s|$)/i,
  /\bsudo\s+rm\s+(?:-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\s+(?:--\s+)?(?:\/|~|\$HOME)(?:\s|$)/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bdd\b[\s\S]*\bof=\/dev\//i,
  /\bchmod\s+-R\s+777\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /\bchown\s+-R\b[\s\S]+(?:\/|~|\$HOME)(?:\s|$)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
]

export function decideChipMatePermission(request: ChipMatePermissionRequest): ChipMatePermissionDecision {
  const hardBlock = hardProtectionReason(request)
  if (hardBlock) return { status: "deny", reason: hardBlock, hardProtection: true }

  switch (request.profile) {
    case "readOnly":
      return request.capability === "readWorkspace"
        ? { status: "allow", reason: "Read-only profile allows workspace reads." }
        : { status: "deny", reason: `Read-only profile denies ${request.capability}.` }
    case "askApproval":
      return request.capability === "readWorkspace"
        ? { status: "allow", reason: "Ask Approval profile allows workspace reads." }
        : approvalDecision(request, "Ask Approval profile requires approval.")
    case "trustedWorkspace":
      if (request.capability === "readWorkspace" || request.capability === "writeWorkspace" || request.capability === "runSkillScript" || request.capability === "runMcpTool") {
        return request.previouslyApproved
          ? { status: "allow", reason: "Trusted workspace approval was already granted." }
          : approvalDecision(request, "Trusted workspace requires first-use approval.")
      }
      return approvalDecision(request, "Trusted workspace requires shell approval.")
    case "fullAccess":
      return { status: "allow", reason: "Full Access profile allows this operation." }
    default:
      return { status: "ask", reason: "Unknown permission profile; approval required." }
  }
}

export function hardProtectionReason(request: ChipMatePermissionRequest) {
  const command = request.command?.trim()
  if (command && DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return "Command matches a hard-protected destructive shell pattern."
  }

  const targetPath = normalizePathForPolicy(request.targetPath)
  if (targetPath && SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(targetPath))) {
    return "Target path is protected by ChipMate hard safety rules."
  }

  if (request.capability === "writeWorkspace" && targetPath && request.workspaceRoots?.length) {
    const inside = request.workspaceRoots.some((root) => isPathInside(targetPath, root))
    if (!inside) return "Workspace write target is outside the configured workspace roots."
  }

  return ""
}

export function isPathInside(path: string, root: string) {
  const normalizedPath = normalizePathForPolicy(path)
  const normalizedRoot = normalizePathForPolicy(root).replace(/\/+$/, "")
  if (!normalizedPath || !normalizedRoot) return false
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function approvalDecision(request: ChipMatePermissionRequest, reason: string): ChipMatePermissionDecision {
  if (request.previouslyApproved) return { status: "allow", reason: `${reason} Previous approval is still valid.` }
  return { status: "ask", reason }
}

function normalizePathForPolicy(input: string | undefined) {
  if (!input) return ""
  return input.replace(/\\/g, "/").replace(/\/+/g, "/")
}
