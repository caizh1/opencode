import * as vscode from "vscode"
import type { CodeGraphAnalysisMode, CompletionLogLevel, RemoteSettings } from "./types"

export const PASSWORD_SECRET_KEY = "opencode.remote.password"

export type ConnectionSettingsInput = {
  serverUrl: string
  username: string
  password: string | undefined
}

export function readRemoteSettings(): RemoteSettings {
  const config = vscode.workspace.getConfiguration("opencode.remote")
  return {
    serverUrl: normalizeServerUrl(config.get<string>("serverUrl", "http://localhost:4096")),
    username: config.get<string>("username", "opencode"),
    defaultModel: config.get<string>("defaultModel", ""),
    defaultAgent: config.get<string>("defaultAgent", ""),
    localOnlyAgent: config.get<string>("localOnlyAgent", "vscode-local"),
    context: {
      maxFileBytes: Math.max(1000, config.get<number>("context.maxFileBytes", 16000)),
      maxFiles: Math.max(1, Math.min(50, config.get<number>("context.maxFiles", 8))),
      includeDiagnostics: config.get<boolean>("context.includeDiagnostics", true),
      includeGitDiff: config.get<boolean>("context.includeGitDiff", false),
      localOnlyMode: config.get<boolean>("context.localOnlyMode", true),
      strictLocalOnlyAgent: config.get<boolean>("context.strictLocalOnlyAgent", true),
    },
    completion: {
      enabled: config.get<boolean>("completion.enabled", false),
      debounceMs: Math.max(0, config.get<number>("completion.debounceMs", 350)),
      logLevel: readCompletionLogLevel(config.get<string>("completion.logLevel", "info")),
    },
    codeGraph: {
      enabled: config.get<boolean>("codeGraph.enabled", true),
      promptOnWorkspaceOpen: config.get<boolean>("codeGraph.promptOnWorkspaceOpen", true),
      analysisMode: readCodeGraphAnalysisMode(config.get<string>("codeGraph.analysisMode", "auto")),
      maxFiles: Math.max(100, Math.min(250000, config.get<number>("codeGraph.maxFiles", 50000))),
      maxContextBytes: Math.max(2000, Math.min(100000, config.get<number>("codeGraph.maxContextBytes", 24000))),
      maxEvidenceBytes: Math.max(4000, Math.min(200000, config.get<number>("codeGraph.maxEvidenceBytes", 60000))),
      maxGraphDepth: Math.max(1, Math.min(5, config.get<number>("codeGraph.maxGraphDepth", 2))),
      maxFanout: Math.max(5, Math.min(200, config.get<number>("codeGraph.maxFanout", 40))),
      maxDeepFiles: Math.max(1, Math.min(200, config.get<number>("codeGraph.maxDeepFiles", 24))),
      maxStateTransitions: Math.max(10, Math.min(1000, config.get<number>("codeGraph.maxStateTransitions", 120))),
      watcherRescanThreshold: Math.max(25, Math.min(10000, config.get<number>("codeGraph.watcherRescanThreshold", 750))),
      workerConcurrency: Math.max(1, Math.min(16, config.get<number>("codeGraph.workerConcurrency", 4))),
      queryCacheSize: Math.max(0, Math.min(500, config.get<number>("codeGraph.queryCacheSize", 80))),
      memoryLimitMb: Math.max(128, Math.min(32768, config.get<number>("codeGraph.memoryLimitMb", 4096))),
      compileCommandsPath: config.get<string>("codeGraph.compileCommandsPath", "").trim(),
      clangdPath: config.get<string>("codeGraph.clangdPath", "").trim(),
      scipClangPath: config.get<string>("codeGraph.scipClangPath", "").trim(),
      excludeGlobs: readStringArray(config.get<unknown>("codeGraph.excludeGlobs", [])),
    },
    analysis: {
      bridgeEnabled: config.get<boolean>("analysis.bridge.enabled", true),
      maxEvidenceItems: Math.max(1, Math.min(200, config.get<number>("analysis.maxEvidenceItems", 40))),
      maxEvidenceBytes: Math.max(4000, Math.min(200000, config.get<number>("analysis.maxEvidenceBytes", 60000))),
      maxFileSliceBytes: Math.max(1000, Math.min(100000, config.get<number>("analysis.maxFileSliceBytes", 16000))),
      maxGraphEdges: Math.max(10, Math.min(1000, config.get<number>("analysis.maxGraphEdges", 120))),
      maxPaths: Math.max(1, Math.min(50, config.get<number>("analysis.maxPaths", 10))),
    },
  }
}

export async function readRemotePassword(context: vscode.ExtensionContext) {
  return context.secrets.get(PASSWORD_SECRET_KEY)
}

export async function writeRemotePassword(context: vscode.ExtensionContext, password: string | undefined) {
  if (password) {
    await context.secrets.store(PASSWORD_SECRET_KEY, password)
    return
  }
  await context.secrets.delete(PASSWORD_SECRET_KEY)
}

export async function promptAndSaveConnectionSettings(context: vscode.ExtensionContext) {
  const current = readRemoteSettings()
  const serverUrl = await vscode.window.showInputBox({
    title: "Remote OpenCode server URL",
    prompt: "Enter the base URL for opencode serve.",
    value: current.serverUrl,
    ignoreFocusOut: true,
  })
  if (!serverUrl) return false

  const username = await vscode.window.showInputBox({
    title: "Remote OpenCode username",
    prompt: "HTTP Basic Auth username. Leave as opencode unless you changed OPENCODE_SERVER_USERNAME.",
    value: current.username || "opencode",
    ignoreFocusOut: true,
  })
  if (username === undefined) return false

  const password = await vscode.window.showInputBox({
    title: "Remote OpenCode password",
    prompt: "HTTP Basic Auth password. Leave empty if the server is unsecured.",
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return false

  await saveConnectionSettings(context, { serverUrl, username, password: password || undefined })
  return true
}

export async function saveConnectionSettings(context: vscode.ExtensionContext, input: ConnectionSettingsInput) {
  const settings = settingsFromConnectionInput(input)

  const config = vscode.workspace.getConfiguration("opencode.remote")
  await config.update("serverUrl", settings.serverUrl, vscode.ConfigurationTarget.Global)
  await config.update("username", settings.username, vscode.ConfigurationTarget.Global)
  await writeRemotePassword(context, input.password?.trim() || undefined)
}

export function settingsFromConnectionInput(input: ConnectionSettingsInput): RemoteSettings {
  const serverUrl = normalizeServerUrl(input.serverUrl)
  if (!serverUrl) throw new Error("Remote OpenCode server URL is required.")
  return {
    ...readRemoteSettings(),
    serverUrl,
    username: input.username.trim() || "opencode",
  }
}

export function normalizeServerUrl(input: string) {
  const value = input.trim()
  if (!value) return ""
  return value.replace(/\/+$/, "")
}

function readCompletionLogLevel(input: string): CompletionLogLevel {
  if (input === "off" || input === "info" || input === "debug") return input
  return "info"
}

function readCodeGraphAnalysisMode(input: string): CodeGraphAnalysisMode {
  if (input === "auto" || input === "fast" || input === "ast" || input === "semantic") return input
  return "auto"
}

function readStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}
