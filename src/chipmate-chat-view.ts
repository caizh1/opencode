import * as vscode from "vscode"
import { AgentRuntime, type AgentRuntimeEvent } from "./agent-runtime"
import { ChatSessionStore, type ChatSessionMessage, type ChatSessionRecord, type ChatSessionStorage, type ChatSessionStoreSnapshot } from "./chat-session-store"
import type { CodeGraphContextProvider } from "./codegraph-types"
import { buildChatPrompt, type ContextSummaryItem, LocalContextStore, MissingLocalContextError, relativePath } from "./context"
import type { TrackedEditorContext } from "./editor-context"
import { buildMentionIndex, searchMentionIndex, type MentionIndexEntry } from "./mention-index"
import { McpStdioRuntime } from "./mcp-stdio-runtime"
import { OpenAIChatClient, type OpenAIChatMessage } from "./openai-chat-client"
import type { ChipMateApprovalResult, ChipMatePermissionDecision, ChipMatePermissionProfile } from "./permissions"
import { ChipMatePackageInstaller, type InstalledChipMatePackage } from "./skills-installer"
import { downloadChipMateCatalogPackage, fetchChipMateCatalog, type ChipMateCatalogPackage } from "./skills-catalog"
import { SkillsRuntime } from "./skills-runtime"
import { ToolRegistry, type ToolRegistryEntry } from "./tool-registry"
import type { ChatContextOptions, RemoteSettings } from "./types"
import { liquidIcon, type LiquidIconName } from "./webview/liquid-icons"
import { createNonce } from "./webview/nonce"
import { WorkspaceTools } from "./workspace-tools"

type ChipMateViewMessage =
  | { type: "ready" }
  | { type: "newSession" }
  | { type: "selectSession"; sessionId: string }
  | { type: "sendMessage"; text: string; mentionedFiles?: MentionedFileRef[] }
  | { type: "cancelSend" }
  | { type: "searchFilesForMention"; query?: string; requestId?: number }
  | { type: "refreshCatalog" }
  | { type: "installPackage"; id: string; packageType: "skill" | "mcp"; version: string }
  | { type: "rollbackPackage"; id: string; packageType: "skill" | "mcp" }
  | { type: "saveSettings"; apiBaseUrl: string; model: string; catalogUrl: string; permissionProfile: ChipMatePermissionProfile }
  | { type: "setApiKey" }
  | { type: "addFile" }
  | { type: "clearContext" }
  | { type: "openOutput" }

type ChipMateRenderedMessage = {
  id: string
  role: string
  text: string
  createdAt: number
}

type ChipMateRenderedSession = {
  id: string
  title: string
  updatedAt: number
}

type MentionedFileRef = {
  uri: string
  label?: string
}

type MentionIndexState = {
  entries: MentionIndexEntry[]
  truncated: boolean
}

type ChipMateViewState = {
  apiBaseUrl: string
  model: string
  configured: boolean
  permissionProfile: ChipMatePermissionProfile
  catalogUrl: string
  catalogPackages: ChipMateCatalogPackage[]
  installedPackages: InstalledChipMatePackage[]
  sessions: ChipMateRenderedSession[]
  activeSessionId?: string
  messages: ChipMateRenderedMessage[]
  contextLabels: string[]
  contextSummary: ContextSummaryItem[]
  sending: boolean
  streamingText: string
  toolStatus: string
  error: string
  catalogError: string
}

type ChipMateChatViewProviderDeps = {
  context: vscode.ExtensionContext
  output: vscode.OutputChannel
  contextStore: LocalContextStore
  codeGraph?: CodeGraphContextProvider
  getSettings: () => RemoteSettings
  getModelApiKey: () => Promise<string | undefined>
  promptModelApiKey: () => Promise<boolean>
  getEditorContext: () => TrackedEditorContext | undefined
  openOutput: () => void
}

const CHAT_SESSIONS_KEY = "chipmate.chat.sessions"
const DEFAULT_MAX_TOOL_ROUNDS = 6
const STREAM_POST_THROTTLE_MS = 80
const iconNames: LiquidIconName[] = ["chat", "sparkle", "send", "add", "attach", "discard", "history", "refresh", "settings", "database", "key", "shield", "file", "stop", "retry", "apply"]
const icons = Object.fromEntries(iconNames.map((name) => [name, liquidIcon(name)])) as Record<LiquidIconName, string>

export class ChipMateChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "chipmate.sidebar"

  private view?: vscode.WebviewView
  private readonly sessionStore: ChatSessionStore
  private readonly installer: ChipMatePackageInstaller
  private activeSessionId?: string
  private sessions: ChatSessionRecord[] = []
  private installedPackages: InstalledChipMatePackage[] = []
  private catalogPackages: ChipMateCatalogPackage[] = []
  private contextSummary: ContextSummaryItem[] = []
  private sending = false
  private streamingText = ""
  private toolStatus = ""
  private error = ""
  private catalogError = ""
  private sendAbort?: AbortController
  private lastStreamPostAt = 0
  private mentionIndex?: MentionIndexState
  private mentionIndexBuild?: Promise<MentionIndexState>
  private readonly toolApprovals = new Set<string>()

  constructor(private readonly deps: ChipMateChatViewProviderDeps) {
    this.sessionStore = new ChatSessionStore(new VsCodeMementoChatStorage(deps.context, CHAT_SESSIONS_KEY))
    this.installer = new ChipMatePackageInstaller(vscode.Uri.joinPath(deps.context.globalStorageUri, "packages").fsPath)
  }

  dispose() {
    this.sendAbort?.abort()
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = createChipMateViewHtml(webviewView.webview.cspSource)
    webviewView.webview.onDidReceiveMessage((message: ChipMateViewMessage) => {
      void this.handleMessage(message)
    })
    void this.refreshState()
  }

  async reveal() {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.chipmate")
      await vscode.commands.executeCommand(`${ChipMateChatViewProvider.viewType}.focus`)
    } catch (error) {
      this.reportError("Failed to reveal ChipMate view", error)
    }
  }

  async newSession() {
    const session = await this.sessionStore.createSession()
    this.activeSessionId = session.id
    await this.refreshState()
  }

  async sendQuickQuestion(text: string, options?: Partial<ChatContextOptions>) {
    await this.reveal()
    await this.sendMessage(text, options)
  }

  refreshStateOnly() {
    void this.refreshState()
  }

  private async handleMessage(message: ChipMateViewMessage) {
    switch (message.type) {
      case "ready":
        await this.refreshState()
        break
      case "newSession":
        await this.newSession()
        break
      case "selectSession":
        this.activeSessionId = message.sessionId
        await this.refreshState()
        break
      case "sendMessage":
        await this.sendMessage(message.text, undefined, this.mentionedFileUris(message.mentionedFiles ?? []))
        break
      case "cancelSend":
        this.sendAbort?.abort()
        break
      case "searchFilesForMention":
        await this.searchFilesForMention(message.query ?? "", message.requestId)
        break
      case "refreshCatalog":
        await this.refreshCatalog()
        break
      case "installPackage":
        await this.installPackage(message.packageType, message.id, message.version)
        break
      case "rollbackPackage":
        await this.rollbackPackage(message.packageType, message.id)
        break
      case "saveSettings":
        await this.saveSettings(message)
        break
      case "setApiKey":
        if (await this.deps.promptModelApiKey()) vscode.window.setStatusBarMessage("ChipMate API key saved", 2000)
        await this.refreshState()
        break
      case "addFile":
        await this.addActiveFileToContext()
        break
      case "clearContext":
        this.deps.contextStore.clear()
        await this.refreshState()
        break
      case "openOutput":
        this.deps.openOutput()
        break
    }
  }

  private async sendMessage(text: string, options?: Partial<ChatContextOptions>, mentionedFiles: vscode.Uri[] = []) {
    const question = text.trim() || (mentionedFiles.length ? "Please review the referenced files." : "")
    if (!question || this.sending) return
    const settings = this.deps.getSettings()
    if (!settings.chat.apiBaseUrl || !settings.chat.model) {
      this.error = "Configure a ChipMate OpenAI-compatible API base URL and model first."
      this.postState()
      return
    }

    this.sending = true
    this.error = ""
    this.streamingText = ""
    this.toolStatus = ""
    this.sendAbort = new AbortController()
    this.postState()
    try {
      const session = await this.ensureActiveSession()
      const history = await this.modelHistory(session.id)
      await this.sessionStore.appendMessage(session.id, { role: "user", content: question })
      await this.refreshSessions()
      this.postState()

      const prompt = await buildChatPrompt({
        question,
        options: chatContextOptions(settings, options),
        settings,
        contextStore: this.deps.contextStore,
        mentionedFiles,
        editorContext: this.deps.getEditorContext(),
        codeGraph: this.deps.codeGraph,
        onContextSummary: (items) => {
          this.contextSummary = items
        },
      })
      const apiKey = await this.deps.getModelApiKey()
      const installedPackages = await this.installer.listInstalled()
      const registry = await this.createToolRegistry(settings, installedPackages)
      const client = new OpenAIChatClient({
        apiBaseUrl: settings.chat.apiBaseUrl,
        model: settings.chat.model,
        maxTokens: settings.chat.maxTokens,
        temperature: settings.chat.temperature,
        topP: settings.chat.topP,
        streaming: settings.chat.streaming,
      }, apiKey)
      const runtime = new AgentRuntime({
        client,
        tools: registry.toolDefinitions(),
        executeTool: registry.executor(),
        maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      })
      const result = await runtime.run({
        messages: [
          chipMateSystemMessage(installedPackages),
          ...history,
          { role: "user", content: prompt },
        ],
        signal: this.sendAbort.signal,
        onEvent: (event) => this.handleRuntimeEvent(event),
      })
      await this.sessionStore.appendMessage(session.id, {
        role: "assistant",
        content: result.finalMessage.content || "",
        reasoning_content: result.finalMessage.reasoning_content,
      })
      this.streamingText = ""
      this.toolStatus = ""
    } catch (error) {
      const message = error instanceof MissingLocalContextError
        ? error.message
        : error instanceof Error ? error.message : String(error)
      this.error = message
      this.deps.output.appendLine(`[chat] ${message}`)
    } finally {
      this.sending = false
      this.sendAbort = undefined
      await this.refreshState()
    }
  }

  private async createToolRegistry(settings: RemoteSettings, installedPackages: InstalledChipMatePackage[]) {
    const workspaceRoots = workspaceRootPaths()
    const installedSkills = installedPackages
      .filter((item) => item.type === "skill")
      .map((item) => ({
        id: item.id,
        root: item.root,
        version: item.version,
        enabled: true,
      }))
    const skills = new SkillsRuntime({
      skills: installedSkills,
      permissionProfile: settings.permissions.profile,
      workspaceRoots,
      isScriptApproved: (skillId, script) => this.hasToolApproval("runSkillScript", `${skillId}:${script}`),
      requestApproval: (permission, context) => this.requestToolApproval(permission, context),
    })
    const mcp = new McpStdioRuntime({
      packages: installedPackages.filter((item) => item.type === "mcp"),
      permissionProfile: settings.permissions.profile,
      workspaceRoots,
      isToolApproved: (packageId, toolName) => this.hasToolApproval("runMcpTool", `${packageId}:${toolName}`),
      requestApproval: (permission, context) => this.requestToolApproval(permission, context),
    })
    const workspaceTools = new WorkspaceTools({
      workspaceRoots: workspaceRoots.length ? workspaceRoots : [this.deps.context.globalStorageUri.fsPath],
      permissionProfile: settings.permissions.profile,
      isApproved: (capability, key) => this.hasToolApproval(capability, key),
      requestApproval: (permission, context) => this.requestToolApproval(permission, context),
    })
    return new ToolRegistry([
      ...skillRegistryEntries(skills),
      ...(await mcp.registryEntries()),
      ...workspaceTools.registryEntries(),
    ])
  }

  private async modelHistory(sessionId: string): Promise<OpenAIChatMessage[]> {
    const session = await this.sessionStore.getSession(sessionId)
    if (!session) return []
    return session.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-12)
      .map((message) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : "",
        reasoning_content: message.reasoning_content,
      }))
  }

  private handleRuntimeEvent(event: AgentRuntimeEvent) {
    if (event.type === "model-event") {
      if (event.event.type === "text-delta") {
        this.streamingText += event.event.text
        this.postStateThrottled()
      }
      if (event.event.type === "reasoning-delta" && !this.streamingText) {
        this.toolStatus = "Thinking..."
        this.postStateThrottled()
      }
      if (event.event.type === "fallback") {
        this.toolStatus = "Streaming fallback: using non-streaming response."
        this.postStateThrottled()
      }
    }
    if (event.type === "tool-start") {
      this.toolStatus = `Running ${event.call.function.name}`
      this.postStateThrottled()
    }
    if (event.type === "tool-result") {
      this.toolStatus = event.error ? `${event.call.function.name} failed` : `${event.call.function.name} done`
      this.postStateThrottled()
    }
  }

  private postStateThrottled() {
    const now = Date.now()
    if (now - this.lastStreamPostAt < STREAM_POST_THROTTLE_MS) return
    this.lastStreamPostAt = now
    this.postState()
  }

  private async refreshCatalog() {
    const settings = this.deps.getSettings()
    this.catalogError = ""
    if (!settings.skills.catalogUrl) {
      this.catalogPackages = []
      this.catalogError = "Configure a catalog URL first."
      this.postState()
      return
    }
    try {
      const catalog = await fetchChipMateCatalog(settings.skills.catalogUrl)
      this.catalogPackages = catalog.packages
    } catch (error) {
      this.catalogError = error instanceof Error ? error.message : String(error)
    }
    this.postState()
  }

  private async installPackage(type: "skill" | "mcp", id: string, version: string) {
    const settings = this.deps.getSettings()
    const pkg = this.catalogPackages.find((item) => item.type === type && item.id === id && item.version === version)
    if (!pkg) {
      this.catalogError = `Package not found in the current catalog: ${type}:${id}@${version}`
      this.postState()
      return
    }
    try {
      const bytes = await downloadChipMateCatalogPackage({ catalogUrl: settings.skills.catalogUrl, pkg })
      const result = await this.installer.installZip({ catalogUrl: settings.skills.catalogUrl, pkg, bytes })
      this.catalogError = result.previousVersion
        ? `Installed ${pkg.name} ${pkg.version}; previous ${result.previousVersion} is available for rollback.`
        : `Installed ${pkg.name} ${pkg.version}.`
      await this.refreshInstalledPackages()
    } catch (error) {
      this.catalogError = error instanceof Error ? error.message : String(error)
    }
    this.postState()
  }

  private async rollbackPackage(type: "skill" | "mcp", id: string) {
    try {
      const restored = await this.installer.rollback({ type, id })
      this.catalogError = `Rolled back ${restored.name} to ${restored.version}.`
      await this.refreshInstalledPackages()
    } catch (error) {
      this.catalogError = error instanceof Error ? error.message : String(error)
    }
    this.postState()
  }

  private async saveSettings(input: Extract<ChipMateViewMessage, { type: "saveSettings" }>) {
    const config = vscode.workspace.getConfiguration("chipmate")
    await config.update("chat.apiBaseUrl", input.apiBaseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("chat.model", input.model.trim(), vscode.ConfigurationTarget.Global)
    await config.update("skills.catalogUrl", input.catalogUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("permissions.profile", input.permissionProfile, vscode.ConfigurationTarget.Global)
    vscode.window.setStatusBarMessage("ChipMate settings saved", 2000)
    await this.refreshState()
  }

  private async addActiveFileToContext() {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.setStatusBarMessage("Open a local file before adding context.", 2000)
      return
    }
    this.deps.contextStore.add(editor.document.uri)
    await this.refreshState()
  }

  private async searchFilesForMention(query: string, requestId?: number) {
    this.view?.webview.postMessage({ type: "mentionStatus", requestId, query, status: "searching" })
    try {
      const index = await this.ensureMentionIndex()
      const files = searchMentionIndex(index.entries, query, 50)
      this.view?.webview.postMessage({
        type: "mentionResults",
        requestId,
        query,
        files,
        truncated: index.truncated,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.output.appendLine(`[mention] search failed: ${message}`)
      this.view?.webview.postMessage({ type: "mentionResults", requestId, query, files: [], error: message })
    }
  }

  private async ensureMentionIndex() {
    if (this.mentionIndex) return this.mentionIndex
    if (!this.mentionIndexBuild) this.mentionIndexBuild = this.buildMentionIndex()
    this.mentionIndex = await this.mentionIndexBuild
    this.mentionIndexBuild = undefined
    return this.mentionIndex
  }

  private async buildMentionIndex(): Promise<MentionIndexState> {
    if (!vscode.workspace.workspaceFolders?.length) return { entries: [], truncated: false }

    const limit = 20000
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/.git/**,**/.vscode-test/**,**/dist/**,**/out/**}",
      limit + 1,
    )
    const truncated = files.length > limit
    const sourceFiles = files.slice(0, limit).map((uri) => ({
      uri: uri.toString(),
      label: relativePath(uri),
    }))
    const entries = buildMentionIndex(sourceFiles)
    this.deps.output.appendLine(
      `[mention] indexed ${sourceFiles.length} file(s), ${entries.filter((entry) => entry.type === "folder").length} folder(s)${
        truncated ? " (truncated)" : ""
      }`,
    )
    return { entries, truncated }
  }

  private mentionedFileUris(files: MentionedFileRef[]) {
    const result: vscode.Uri[] = []
    const seen = new Set<string>()
    for (const file of files) {
      try {
        const uri = vscode.Uri.parse(file.uri)
        if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) continue
        const key = uri.toString()
        if (seen.has(key)) continue
        seen.add(key)
        result.push(uri)
      } catch {
        this.deps.output.appendLine(`[mention] skipped invalid URI: ${file.uri}`)
      }
    }
    return result
  }

  private async ensureActiveSession() {
    if (this.activeSessionId) {
      const active = await this.sessionStore.getSession(this.activeSessionId)
      if (active) return active
    }
    const session = await this.sessionStore.createSession()
    this.activeSessionId = session.id
    return session
  }

  private async refreshState() {
    await Promise.all([
      this.refreshSessions(),
      this.refreshInstalledPackages(),
    ])
    this.postState()
  }

  private async refreshSessions() {
    this.sessions = await this.sessionStore.listSessions()
    if (!this.activeSessionId || !this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0]?.id
    }
  }

  private async refreshInstalledPackages() {
    this.installedPackages = await this.installer.listInstalled()
  }

  private postState() {
    const webview = this.view?.webview
    if (!webview) return
    const settings = this.deps.getSettings()
    const active = this.sessions.find((session) => session.id === this.activeSessionId)
    const state: ChipMateViewState = {
      apiBaseUrl: settings.chat.apiBaseUrl,
      model: settings.chat.model,
      configured: Boolean(settings.chat.apiBaseUrl && settings.chat.model),
      permissionProfile: settings.permissions.profile,
      catalogUrl: settings.skills.catalogUrl,
      catalogPackages: this.catalogPackages,
      installedPackages: this.installedPackages,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
      activeSessionId: this.activeSessionId,
      messages: (active?.messages ?? []).map(renderMessage),
      contextLabels: this.deps.contextStore.labels(),
      contextSummary: this.contextSummary,
      sending: this.sending,
      streamingText: this.streamingText,
      toolStatus: this.toolStatus,
      error: this.error,
      catalogError: this.catalogError,
    }
    void webview.postMessage({ type: "state", state })
  }

  private reportError(title: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.output.appendLine(`[view] ${title}: ${message}`)
    void vscode.window.showErrorMessage(`${title}. See the ChipMate output for details.`)
  }

  private hasToolApproval(capability: string, key: string) {
    return this.toolApprovals.has(toolApprovalKey(capability, key))
  }

  private async requestToolApproval(
    permission: ChipMatePermissionDecision,
    context: {
      capability: string
      key: string
      command?: string
      targetPath?: string
      cwd?: string
      skillId?: string
      script?: string
      packageId?: string
      toolName?: string
    },
  ): Promise<ChipMateApprovalResult> {
    const allowOnce = "Allow Once"
    const allowAlways = "Always Allow"
    const deny = "Deny"
    const selected = await vscode.window.showWarningMessage(
      `ChipMate requests permission to ${permissionActionLabel(context.capability)}.`,
      {
        modal: true,
        detail: approvalDetail(permission, context),
      },
      allowOnce,
      allowAlways,
      deny,
    )
    if (selected === allowAlways) {
      this.toolApprovals.add(toolApprovalKey(context.capability, context.key))
      return "allowAlways"
    }
    if (selected === allowOnce) return "allowOnce"
    return "deny"
  }
}

function toolApprovalKey(capability: string, key: string) {
  return `${capability}:${key}`
}

function permissionActionLabel(capability: string) {
  switch (capability) {
    case "writeWorkspace":
      return "write a workspace file"
    case "runShell":
      return "run a shell command"
    case "runSkillScript":
      return "run a skill script"
    case "runMcpTool":
      return "run an MCP tool"
    default:
      return "run this tool"
  }
}

function approvalDetail(
  permission: ChipMatePermissionDecision,
  context: {
    capability: string
    key: string
    command?: string
    targetPath?: string
    cwd?: string
    skillId?: string
    script?: string
    packageId?: string
    toolName?: string
  },
) {
  return [
    permission.reason,
    context.targetPath ? `Target: ${context.targetPath}` : "",
    context.command ? `Command: ${context.command}` : "",
    context.cwd ? `Working directory: ${context.cwd}` : "",
    context.skillId ? `Skill: ${context.skillId}` : "",
    context.script ? `Script: ${context.script}` : "",
    context.packageId ? `MCP package: ${context.packageId}` : "",
    context.toolName ? `MCP tool: ${context.toolName}` : "",
  ].filter(Boolean).join("\n")
}

class VsCodeMementoChatStorage implements ChatSessionStorage {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly key: string,
  ) {}

  async read(): Promise<ChatSessionStoreSnapshot | undefined> {
    return this.context.globalState.get<ChatSessionStoreSnapshot>(this.key)
  }

  async write(snapshot: ChatSessionStoreSnapshot): Promise<void> {
    await this.context.globalState.update(this.key, snapshot)
  }
}

function skillRegistryEntries(runtime: SkillsRuntime): ToolRegistryEntry[] {
  const executor = runtime.toolExecutor()
  return runtime.toolDefinitions().map((definition) => ({
    name: definition.function.name,
    aliases: [definition.function.name.replace(/_/g, ".")],
    definition,
    execute: executor,
  }))
}

function chatContextOptions(settings: RemoteSettings, overrides: Partial<ChatContextOptions> | undefined): ChatContextOptions {
  return {
    includeSelection: overrides?.includeSelection ?? false,
    includeCurrentFile: overrides?.includeCurrentFile ?? true,
    includeOpenFiles: overrides?.includeOpenFiles ?? true,
    includeDiagnostics: overrides?.includeDiagnostics ?? settings.context.includeDiagnostics,
    includeGitDiff: overrides?.includeGitDiff ?? settings.context.includeGitDiff,
  }
}

function chipMateSystemMessage(installedPackages: InstalledChipMatePackage[]): OpenAIChatMessage {
  const installedSkills = installedPackages.filter((pkg) => pkg.type === "skill")
  const installedMcps = installedPackages.filter((pkg) => pkg.type === "mcp")
  const skills = installedSkills.length
    ? installedSkills.map((skill) => `- ${skill.id}${skill.version ? `@${skill.version}` : ""}`).join("\n")
    : "- No skills installed yet."
  const mcps = installedMcps.length
    ? installedMcps.map((pkg) => `- ${pkg.id}@${pkg.version}`).join("\n")
    : "- No MCP servers installed yet."
  return {
    role: "system",
    content: [
      "You are ChipMate, a local coding agent running inside VS Code.",
      "Use standard OpenAI tool calls when workspace inspection, file edits, shell commands, or skill resources are needed.",
      "Prefer installed skills when they match the user's task. Call skill_list and skill_activate before relying on a skill.",
      "Use MCP tools when their names and descriptions match the task.",
      "Respect tool permission results. If a tool returns an ask/deny permission result, explain what approval or profile change is needed.",
      "Installed skills:",
      skills,
      "Installed MCP servers:",
      mcps,
    ].join("\n"),
  }
}

function workspaceRootPaths() {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath)
}

function renderMessage(message: ChatSessionMessage): ChipMateRenderedMessage {
  return {
    id: message.id,
    role: message.role,
    text: typeof message.content === "string" ? message.content : "",
    createdAt: message.createdAt,
  }
}

function createChipMateViewHtml(cspSource: string, nonce = createNonce()) {
  const iconsJson = JSON.stringify(icons)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChipMate</title>
  <style>
    :root {
      color-scheme: light dark;
      --cm-bg: var(--vscode-sideBar-background);
      --cm-ink: var(--vscode-foreground);
      --cm-muted: var(--vscode-descriptionForeground);
      --cm-accent: color-mix(in srgb, var(--vscode-button-background) 78%, #a8e8ff 22%);
      --cm-accent-soft: color-mix(in srgb, var(--cm-accent) 14%, transparent);
      --cm-accent-quiet: color-mix(in srgb, var(--cm-accent) 22%, var(--cm-bg));
      --cm-surface: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
      --cm-surface-raised: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-foreground) 6%);
      --cm-surface-soft: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
      --cm-input: color-mix(in srgb, var(--vscode-input-background) 86%, var(--vscode-editor-background) 14%);
      --cm-border: color-mix(in srgb, var(--vscode-foreground) 11%, transparent);
      --cm-border-strong: color-mix(in srgb, var(--vscode-foreground) 17%, transparent);
      --cm-highlight: color-mix(in srgb, #fff 18%, transparent);
      --cm-shadow: 0 14px 32px color-mix(in srgb, #000 28%, transparent);
      --cm-shadow-soft: 0 6px 18px color-mix(in srgb, #000 16%, transparent);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--cm-ink);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--cm-bg) 92%, #fff 4%) 0%, var(--cm-bg) 42%, color-mix(in srgb, var(--cm-bg) 92%, #000 8%) 100%);
    }
    button, textarea, input, select { font: inherit; }
    button { border: 0; cursor: pointer; color: inherit; }
    button:disabled { opacity: .55; cursor: default; }
    button, input, textarea, select { transition: background-color .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease, opacity .16s ease; }
    .oc-liquid-icon { width: 1em; height: 1em; display: block; }
    .app { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100vh; overflow: hidden; }
    .chrome {
      margin: 8px 8px 0;
      padding: 6px;
      border: 1px solid color-mix(in srgb, var(--cm-border-strong) 72%, transparent);
      border-radius: 18px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--cm-surface-raised) 86%, #fff 5%), color-mix(in srgb, var(--cm-surface-soft) 82%, #000 5%));
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent),
        inset 0 -1px 0 color-mix(in srgb, #000 16%, transparent),
        0 10px 28px color-mix(in srgb, #000 18%, transparent);
      backdrop-filter: blur(22px) saturate(1.2);
    }
    .topbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      padding: 3px 4px 6px;
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 13px;
      display: grid;
      place-items: center;
      color: color-mix(in srgb, var(--cm-accent) 58%, var(--cm-ink));
      border: 1px solid var(--cm-border-strong);
      background:
        linear-gradient(150deg, color-mix(in srgb, var(--cm-accent) 18%, transparent), color-mix(in srgb, var(--cm-surface-raised) 92%, #fff 4%));
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent), inset 0 -1px 0 color-mix(in srgb, #000 18%, transparent), var(--cm-shadow-soft);
    }
    .mark svg, .iconButton svg { width: 18px; height: 18px; }
    .title { min-width: 0; display: grid; gap: 3px; }
    .name { font-weight: 700; font-size: 13px; line-height: 1.12; }
    .subtitle { color: var(--cm-muted); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .iconbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; flex-wrap: wrap; }
    .iconButton {
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      border-radius: 9px;
      color: color-mix(in srgb, var(--cm-muted) 88%, var(--cm-ink));
      border: 1px solid transparent;
      background: transparent;
    }
    .iconButton:hover {
      color: var(--cm-ink);
      border-color: var(--cm-border-strong);
      background: color-mix(in srgb, var(--cm-surface-raised) 88%, var(--cm-accent) 8%);
      box-shadow: inset 0 1px 0 var(--cm-highlight);
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 3px;
      margin: 3px 0 0;
      padding: 3px;
      border: 1px solid var(--cm-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--cm-surface-soft) 82%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
    }
    .tab {
      min-width: 0;
      height: 28px;
      border-radius: 9px;
      color: var(--cm-muted);
      background: transparent;
      border: 1px solid transparent;
    }
    .tab:hover { color: var(--cm-ink); }
    .tab.active {
      color: var(--cm-ink);
      border-color: color-mix(in srgb, var(--cm-border-strong) 82%, var(--cm-accent) 18%);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--cm-surface-raised) 92%, #fff 5%), color-mix(in srgb, var(--cm-surface-raised) 84%, var(--cm-accent) 8%));
      box-shadow: inset 0 1px 0 var(--cm-highlight), var(--cm-shadow-soft);
    }
    .panel { min-height: 0; overflow: auto; padding: 11px 10px 12px; display: none; scrollbar-gutter: stable; }
    .panel.active { display: grid; align-content: start; gap: 11px; }
    .sessionSwitch {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .sessionSelectShell {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      border-radius: 999px;
      padding: 5px 8px;
      min-height: 30px;
      color: color-mix(in srgb, var(--cm-muted) 86%, var(--cm-ink));
      border: 1px solid var(--cm-border);
      background: color-mix(in srgb, var(--cm-surface-soft) 72%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
    }
    .sessionSelectShell:hover,
    .sessionSelectShell:focus-within {
      border-color: color-mix(in srgb, var(--cm-accent) 42%, var(--cm-border));
      background: color-mix(in srgb, var(--cm-accent) 13%, var(--cm-surface-raised));
    }
    .sessionIcon {
      display: inline-grid;
      place-items: center;
      width: 15px;
      height: 15px;
      color: color-mix(in srgb, var(--cm-accent) 74%, var(--cm-ink));
      flex: 0 0 auto;
    }
    .sessionIcon svg { width: 15px; height: 15px; }
    .sessionSelect {
      width: 100%;
      min-width: 0;
      border: 0;
      outline: 0;
      color: var(--cm-ink);
      background: transparent;
    }
    .sessionSelect:disabled { color: var(--cm-muted); opacity: .8; }
    .sessionSelect option { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    .sessionNew {
      width: 30px;
      height: 30px;
      display: inline-grid;
      place-items: center;
      border-radius: 11px;
      color: color-mix(in srgb, var(--cm-accent) 70%, var(--cm-ink));
      border: 1px solid color-mix(in srgb, var(--cm-border-strong) 80%, transparent);
      background:
        linear-gradient(150deg, color-mix(in srgb, var(--cm-accent) 18%, transparent), color-mix(in srgb, var(--cm-surface-raised) 90%, #fff 3%));
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent), var(--cm-shadow-soft);
    }
    .sessionNew:hover {
      color: var(--cm-ink);
      border-color: color-mix(in srgb, var(--cm-accent) 46%, var(--cm-border));
      background: color-mix(in srgb, var(--cm-accent) 18%, var(--cm-surface-raised));
    }
    .sessionNew svg { width: 16px; height: 16px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--cm-border);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--cm-muted);
      background: color-mix(in srgb, var(--cm-surface-soft) 76%, transparent);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button.chip:hover { color: var(--cm-ink); border-color: var(--cm-border-strong); background: color-mix(in srgb, var(--cm-surface-raised) 84%, var(--cm-accent) 7%); }
    .chipIcon { display: inline-grid; place-items: center; width: 13px; height: 13px; flex: 0 0 auto; color: color-mix(in srgb, var(--cm-accent) 68%, var(--cm-ink)); }
    .chipIcon svg { width: 13px; height: 13px; }
    .mentionBox {
      display: none;
      max-height: 180px;
      overflow: auto;
      margin: 0;
      border: 1px solid var(--cm-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--cm-surface-raised) 96%, #000 4%);
      box-shadow: var(--cm-shadow);
    }
    .mentionBox.active { display: grid; }
    .mentionItem {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 7px 9px;
      color: var(--vscode-foreground);
      background: transparent;
      border-bottom: 1px solid color-mix(in srgb, var(--cm-border) 70%, transparent);
      text-align: left;
    }
    .mentionItem:last-child { border-bottom: 0; }
    .mentionItem:hover { background: color-mix(in srgb, var(--cm-accent) 10%, transparent); }
    .mentionLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mentionKind { color: var(--cm-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
    .messages { display: grid; gap: 9px; align-content: start; min-height: 220px; }
    .message {
      display: grid;
      gap: 5px;
      padding: 9px;
      border: 1px solid var(--cm-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--cm-surface-soft) 80%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent);
    }
    .message.user {
      border-color: color-mix(in srgb, var(--cm-accent) 30%, var(--cm-border));
      background: color-mix(in srgb, var(--cm-accent) 12%, var(--cm-surface-soft));
    }
    .role { color: var(--cm-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
    .text { white-space: pre-wrap; line-height: 1.45; overflow-wrap: anywhere; }
    .empty { color: color-mix(in srgb, var(--cm-muted) 88%, transparent); text-align: center; padding: 26px 8px; }
    .notice {
      border: 1px solid color-mix(in srgb, var(--cm-border) 78%, var(--cm-accent) 12%);
      border-radius: 12px;
      padding: 10px 11px;
      color: color-mix(in srgb, var(--cm-muted) 86%, var(--cm-ink));
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--cm-surface-raised) 86%, var(--cm-accent) 6%), color-mix(in srgb, var(--cm-surface-soft) 90%, transparent));
      line-height: 1.4;
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
    }
    .notice.error { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 45%, var(--cm-border)); }
    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--cm-border);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--cm-bg) 72%, transparent), color-mix(in srgb, var(--cm-bg) 94%, #000 4%));
      box-shadow: 0 -10px 30px color-mix(in srgb, #000 18%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
      backdrop-filter: blur(20px) saturate(1.12);
    }
    .composer > .chips, .composer > .mentionBox { grid-column: 1 / -1; }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 120px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--cm-input);
      border: 1px solid color-mix(in srgb, var(--cm-border-strong) 82%, transparent);
      border-radius: 12px;
      padding: 9px 10px;
      outline: none;
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent);
    }
    textarea:focus, .field input:focus, .field select:focus {
      border-color: color-mix(in srgb, var(--cm-accent) 55%, var(--cm-border));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--cm-accent) 18%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
    }
    .sendButton {
      width: 48px;
      min-height: 48px;
      display: inline-grid;
      place-items: center;
      border-radius: 14px;
      color: var(--vscode-button-foreground);
      background:
        linear-gradient(160deg, color-mix(in srgb, var(--cm-accent) 88%, #fff 6%), color-mix(in srgb, var(--cm-accent) 76%, #000 14%));
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 28%, transparent), 0 8px 20px color-mix(in srgb, var(--cm-accent) 26%, transparent);
    }
    .sendButton:hover { box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 34%, transparent), 0 10px 24px color-mix(in srgb, var(--cm-accent) 32%, transparent); }
    .sendButton svg { width: 19px; height: 19px; }
    .grid { display: grid; gap: 8px; }
    .field { display: grid; gap: 4px; color: var(--cm-muted); font-size: 11px; }
    .field input, .field select {
      width: 100%;
      min-width: 0;
      color: var(--vscode-input-foreground);
      background: var(--cm-input);
      border: 1px solid color-mix(in srgb, var(--cm-border-strong) 82%, transparent);
      border-radius: 10px;
      padding: 6px 8px;
      outline: none;
    }
    .sectionTitle { font-size: 10px; font-weight: 700; color: color-mix(in srgb, var(--cm-muted) 88%, transparent); text-transform: uppercase; }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .button {
      min-height: 28px;
      border-radius: 10px;
      padding: 5px 9px;
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--cm-border);
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 76%, var(--cm-surface-raised) 24%);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
    }
    .button:hover { border-color: var(--cm-border-strong); filter: brightness(1.05); }
    .button.primary {
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--cm-accent) 44%, transparent);
      background: linear-gradient(160deg, color-mix(in srgb, var(--cm-accent) 86%, #fff 5%), color-mix(in srgb, var(--cm-accent) 78%, #000 12%));
    }
    .packageList { display: grid; gap: 8px; }
    .package {
      display: grid;
      gap: 7px;
      padding: 9px;
      border-radius: 12px;
      border: 1px solid var(--cm-border);
      background: color-mix(in srgb, var(--cm-surface-soft) 80%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
    }
    .packageHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .packageName { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .packageMeta { color: var(--cm-muted); font-size: 11px; overflow-wrap: anywhere; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .chrome, .composer { backdrop-filter: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="chrome" aria-label="ChipMate navigation">
      <header class="topbar">
        <div class="mark" data-icon="sparkle"></div>
        <div class="title">
          <div class="name">ChipMate</div>
          <div class="subtitle" id="subtitle">Local agent runtime</div>
        </div>
        <div class="iconbar">
          <button class="iconButton" id="setKey" title="Set API key" data-icon="key"></button>
          <button class="iconButton" id="openOutput" title="Open output" data-icon="history"></button>
        </div>
      </header>
      <nav class="tabs">
        <button class="tab active" data-tab="chat">Chat</button>
        <button class="tab" data-tab="skills">Skills</button>
      </nav>
    </section>
    <main class="panel active" id="chatPanel">
      <div class="sessionSwitch">
        <label class="sessionSelectShell" title="Select chat session">
          <span class="sessionIcon">${icons.chat}</span>
          <select class="sessionSelect" id="sessionSelect" aria-label="Select chat session"></select>
        </label>
        <button class="sessionNew" id="newSession" title="New chat" data-icon="add"></button>
      </div>
      <div class="chips" id="contextChips"></div>
      <div id="chatNotice"></div>
      <div class="messages" id="messages"></div>
    </main>
    <main class="panel" id="skillsPanel">
      <div class="grid">
        <div class="sectionTitle">Model</div>
        <label class="field">API base URL <input id="apiBaseUrl" placeholder="http://localhost:8000/v1"></label>
        <label class="field">Model <input id="model" placeholder="qwen-coder"></label>
        <label class="field">Permission profile
          <select id="permissionProfile">
            <option value="askApproval">Ask approval</option>
            <option value="readOnly">Read only</option>
            <option value="trustedWorkspace">Trusted workspace</option>
            <option value="fullAccess">Full access</option>
          </select>
        </label>
        <div class="sectionTitle">Offline Catalog</div>
        <label class="field">Catalog URL <input id="catalogUrl" placeholder="http://offline.local/catalog.json"></label>
        <div class="actions">
          <button class="button primary" id="saveSettings">Save</button>
          <button class="button" id="refreshCatalog">Refresh catalog</button>
        </div>
        <div id="catalogNotice"></div>
        <div class="sectionTitle">Available</div>
        <div class="packageList" id="catalogPackages"></div>
        <div class="sectionTitle">Installed</div>
        <div class="packageList" id="installedPackages"></div>
      </div>
    </main>
    <footer class="composer">
      <div class="chips" id="mentionChips"></div>
      <div class="mentionBox" id="mentionBox"></div>
      <textarea id="composer" placeholder="Ask ChipMate"></textarea>
      <button class="sendButton" id="send" title="Send" data-icon="send"></button>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const icons = ${iconsJson}
    let state = undefined
    let activeTab = "chat"
    let mentionRequestId = 0
    let mentionResults = []
    let selectedMentionFiles = []
    let activeMentionQuery = ""
    const byId = (id) => document.getElementById(id)
    document.querySelectorAll("[data-icon]").forEach((node) => { node.innerHTML = icons[node.dataset.icon] || "" })
    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") {
        state = event.data.state
        render()
      }
      if (event.data?.type === "mentionResults" && event.data.requestId === mentionRequestId) {
        mentionResults = event.data.files || []
        renderMentionResults(event.data.error || "")
      }
    })
    vscode.postMessage({ type: "ready" })
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        activeTab = button.dataset.tab
        render()
      })
    })
    byId("send").addEventListener("click", send)
    byId("composer").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send()
    })
    byId("composer").addEventListener("input", updateMentionSearch)
    byId("mentionBox").addEventListener("click", (event) => {
      const item = event.target.closest("[data-mention-index]")
      if (!item) return
      selectMention(Number(item.dataset.mentionIndex))
    })
    byId("setKey").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }))
    byId("openOutput").addEventListener("click", () => vscode.postMessage({ type: "openOutput" }))
    byId("newSession").addEventListener("click", () => vscode.postMessage({ type: "newSession" }))
    byId("sessionSelect").addEventListener("change", (event) => {
      const sessionId = event.target.value
      if (sessionId) vscode.postMessage({ type: "selectSession", sessionId })
    })
    byId("saveSettings").addEventListener("click", () => vscode.postMessage({
      type: "saveSettings",
      apiBaseUrl: byId("apiBaseUrl").value,
      model: byId("model").value,
      catalogUrl: byId("catalogUrl").value,
      permissionProfile: byId("permissionProfile").value,
    }))
    byId("refreshCatalog").addEventListener("click", () => vscode.postMessage({ type: "refreshCatalog" }))
    byId("catalogPackages").addEventListener("click", (event) => {
      const button = event.target.closest("[data-install]")
      if (!button) return
      vscode.postMessage({ type: "installPackage", id: button.dataset.id, packageType: button.dataset.type, version: button.dataset.version })
    })
    byId("installedPackages").addEventListener("click", (event) => {
      const button = event.target.closest("[data-rollback]")
      if (!button) return
      vscode.postMessage({ type: "rollbackPackage", id: button.dataset.id, packageType: button.dataset.type })
    })
    function send() {
      const input = byId("composer")
      const text = input.value.trim()
      if ((!text && selectedMentionFiles.length === 0) || state?.sending) return
      input.value = ""
      const mentionedFiles = selectedMentionFiles.slice()
      selectedMentionFiles = []
      mentionResults = []
      renderSelectedMentions()
      renderMentionResults("")
      vscode.postMessage({ type: "sendMessage", text, mentionedFiles })
    }
    function updateMentionSearch() {
      const input = byId("composer")
      const beforeCursor = input.value.slice(0, input.selectionStart || input.value.length)
      const match = /(^|\\s)@([^\\s@]*)$/.exec(beforeCursor)
      if (!match) {
        activeMentionQuery = ""
        mentionResults = []
        renderMentionResults("")
        return
      }
      activeMentionQuery = match[2] || ""
      const requestId = ++mentionRequestId
      vscode.postMessage({ type: "searchFilesForMention", query: activeMentionQuery, requestId })
    }
    function selectMention(index) {
      const item = mentionResults[index]
      if (!item) return
      if (item.type === "folder") {
        replaceActiveMention(item.insertText)
        updateMentionSearch()
        return
      }
      if (item.uri && !selectedMentionFiles.some((file) => file.uri === item.uri)) {
        selectedMentionFiles.push({ uri: item.uri, label: item.label })
      }
      replaceActiveMention(item.insertText)
      mentionResults = []
      renderSelectedMentions()
      renderMentionResults("")
      byId("composer").focus()
    }
    function replaceActiveMention(insertText) {
      const input = byId("composer")
      const cursor = input.selectionStart || input.value.length
      const beforeCursor = input.value.slice(0, cursor)
      const afterCursor = input.value.slice(cursor)
      const replaced = beforeCursor.replace(/(^|\\s)@([^\\s@]*)$/, (full, prefix) => prefix + "@" + insertText + " ")
      input.value = replaced + afterCursor
      input.selectionStart = input.selectionEnd = replaced.length
    }
    function renderSelectedMentions() {
      byId("mentionChips").innerHTML = selectedMentionFiles.map((file, index) =>
        '<button class="chip" data-remove-mention="' + index + '">@' + escapeHtml(file.label || file.uri) + '</button>'
      ).join("")
      byId("mentionChips").querySelectorAll("[data-remove-mention]").forEach((button) => {
        button.addEventListener("click", () => {
          selectedMentionFiles.splice(Number(button.dataset.removeMention), 1)
          renderSelectedMentions()
        }, { once: true })
      })
    }
    function renderMentionResults(error) {
      const box = byId("mentionBox")
      const rows = error
        ? '<div class="notice error">' + escapeHtml(error) + '</div>'
        : mentionResults.map((item, index) =>
            '<button class="mentionItem" data-mention-index="' + index + '"><span class="mentionLabel">' +
            escapeHtml(item.insertText || item.label) + '</span><span class="mentionKind">' + escapeHtml(item.type) + '</span></button>'
          ).join("")
      box.innerHTML = rows
      box.classList.toggle("active", Boolean(rows))
    }
    function render() {
      if (!state) return
      document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === activeTab))
      byId("chatPanel").classList.toggle("active", activeTab === "chat")
      byId("skillsPanel").classList.toggle("active", activeTab === "skills")
      byId("subtitle").textContent = state.configured ? state.model + " · " + readableProfile(state.permissionProfile) : "Model required"
      byId("apiBaseUrl").value = state.apiBaseUrl || ""
      byId("model").value = state.model || ""
      byId("catalogUrl").value = state.catalogUrl || ""
      byId("permissionProfile").value = state.permissionProfile || "askApproval"
      byId("send").disabled = !!state.sending
      renderSessions()
      renderContext()
      renderSelectedMentions()
      renderMessages()
      renderPackages()
      renderNotices()
    }
    function renderSessions() {
      const sessions = state.sessions || []
      const select = byId("sessionSelect")
      select.disabled = sessions.length === 0
      select.innerHTML = sessions.length
        ? sessions.map((session) =>
            '<option value="' + escapeAttr(session.id) + '" ' + (session.id === state.activeSessionId ? 'selected' : '') + '>' +
            escapeHtml(displaySessionTitle(session, sessions)) + '</option>'
          ).join("")
        : '<option value="">New chat</option>'
    }
    function displaySessionTitle(session, sessions) {
      const base = normalizedSessionTitle(session.title)
      const same = sessions.filter((item) => normalizedSessionTitle(item.title) === base)
      if (same.length <= 1) return base
      return base + " " + (same.findIndex((item) => item.id === session.id) + 1)
    }
    function normalizedSessionTitle(title) {
      const clean = String(title || "").trim().replace(/^ChipMate\\s+/i, "")
      return clean || "Chat"
    }
    function readableProfile(profile) {
      return String(profile || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    }
    function renderContext() {
      const labels = state.contextLabels || []
      byId("contextChips").innerHTML = labels.length
        ? labels.map((label) => '<span class="chip">' + escapeHtml(label) + '</span>').join("") + '<button class="chip" id="clearContext"><span class="chipIcon">' + icons.discard + '</span><span>Clear</span></button>'
        : '<button class="chip" id="addContext"><span class="chipIcon">' + icons.attach + '</span><span>Add current file</span></button>'
      const add = byId("addContext")
      const clear = byId("clearContext")
      if (add) add.addEventListener("click", () => vscode.postMessage({ type: "addFile" }), { once: true })
      if (clear) clear.addEventListener("click", () => vscode.postMessage({ type: "clearContext" }), { once: true })
    }
    function renderMessages() {
      const messages = state.messages || []
      const streaming = state.streamingText ? [{ id: "streaming", role: "assistant", text: state.streamingText, createdAt: Date.now() }] : []
      const all = messages.concat(streaming)
      byId("messages").innerHTML = all.length ? all.map((message) =>
        '<article class="message ' + escapeAttr(message.role) + '"><div class="role">' + escapeHtml(message.role) + '</div><div class="text">' + escapeHtml(message.text) + '</div></article>'
      ).join("") : '<div class="empty">No messages yet.</div>'
    }
    function renderPackages() {
      byId("catalogPackages").innerHTML = (state.catalogPackages || []).length ? state.catalogPackages.map((pkg) =>
        '<div class="package"><div class="packageHead"><div class="packageName">' + escapeHtml(pkg.name) + '</div><span class="chip">' + escapeHtml(pkg.type) + '</span></div>' +
        '<div class="packageMeta">' + escapeHtml(pkg.id + "@" + pkg.version) + '</div><div>' + escapeHtml(pkg.description || "") + '</div>' +
        '<div class="actions"><button class="button primary" data-install data-id="' + escapeAttr(pkg.id) + '" data-type="' + escapeAttr(pkg.type) + '" data-version="' + escapeAttr(pkg.version) + '">Install</button></div></div>'
      ).join("") : '<div class="notice">No catalog loaded.</div>'
      byId("installedPackages").innerHTML = (state.installedPackages || []).length ? state.installedPackages.map((pkg) =>
        '<div class="package"><div class="packageHead"><div class="packageName">' + escapeHtml(pkg.name) + '</div><span class="chip">' + escapeHtml(pkg.type) + '</span></div>' +
        '<div class="packageMeta">' + escapeHtml(pkg.id + "@" + pkg.version) + '</div><div>' + escapeHtml(pkg.description || "") + '</div>' +
        '<div class="actions"><button class="button" data-rollback data-id="' + escapeAttr(pkg.id) + '" data-type="' + escapeAttr(pkg.type) + '">Rollback</button></div></div>'
      ).join("") : '<div class="notice">No packages installed.</div>'
    }
    function renderNotices() {
      byId("chatNotice").innerHTML = [
        state.error ? '<div class="notice error">' + escapeHtml(state.error) + '</div>' : '',
        state.toolStatus ? '<div class="notice">' + escapeHtml(state.toolStatus) + '</div>' : '',
        !state.configured ? '<div class="notice">Configure an OpenAI-compatible model before sending.</div>' : '',
      ].join("")
      byId("catalogNotice").innerHTML = state.catalogError ? '<div class="notice">' + escapeHtml(state.catalogError) + '</div>' : ''
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))
    }
    function escapeAttr(value) { return escapeHtml(value) }
  </script>
</body>
</html>`
}
