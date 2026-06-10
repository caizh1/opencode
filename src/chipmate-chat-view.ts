import * as vscode from "vscode"
import { AgentRuntime, type AgentRuntimeEvent } from "./agent-runtime"
import { ChatSessionStore, type ChatSessionMessage, type ChatSessionRecord, type ChatSessionStorage, type ChatSessionStoreSnapshot } from "./chat-session-store"
import type { CodeGraphContextProvider } from "./codegraph-types"
import { buildChatPrompt, type ContextSummaryItem, LocalContextStore, MissingLocalContextError, relativePath } from "./context"
import type { TrackedEditorContext } from "./editor-context"
import { buildMentionIndex, searchMentionIndex } from "./mention-index"
import { McpStdioRuntime } from "./mcp-stdio-runtime"
import { OpenAIChatClient, type OpenAIChatMessage } from "./openai-chat-client"
import type { ChipMateApprovalResult, ChipMatePermissionDecision, ChipMatePermissionProfile } from "./permissions"
import { saveCompletionSettings, saveRagSettings } from "./settings"
import { ChipMatePackageInstaller, type InstalledChipMatePackage } from "./skills-installer"
import { downloadChipMateCatalogPackage, fetchChipMateCatalog, type ChipMateCatalogPackage } from "./skills-catalog"
import { SkillsRuntime } from "./skills-runtime"
import { ToolRegistry, type ToolRegistryEntry } from "./tool-registry"
import type { ChatContextOptions, RemoteSettings } from "./types"
import { createChipMateViewHtml } from "./webview/chipmate-html"
import type {
  ChipMateKnowledgeAction,
  ChipMateMcpProbeResult,
  ChipMateMcpProbeTool,
  ChipMateRenderedMessage,
  ChipMateSkillCapabilitySummary,
  ChipMateViewMessage,
  ChipMateViewState,
  MentionedFileRef,
  MentionIndexState,
} from "./webview/chipmate-view-types"
import { WorkspaceTools } from "./workspace-tools"

type ChipMateChatViewProviderDeps = {
  context: vscode.ExtensionContext
  output: vscode.OutputChannel
  contextStore: LocalContextStore
  codeGraph?: CodeGraphContextProvider
  getSettings: () => RemoteSettings
  getModelApiKey: () => Promise<string | undefined>
  promptModelApiKey: () => Promise<boolean>
  promptRagApiKey: () => Promise<boolean>
  getEditorContext: () => TrackedEditorContext | undefined
  openOutput: () => void
}

const CHAT_SESSIONS_KEY = "chipmate.chat.sessions"
const DEFAULT_MAX_TOOL_ROUNDS = 6
const STREAM_POST_THROTTLE_MS = 80

export class ChipMateChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "chipmate.sidebar"

  private view?: vscode.WebviewView
  private readonly sessionStore: ChatSessionStore
  private readonly installer: ChipMatePackageInstaller
  private activeSessionId?: string
  private sessions: ChatSessionRecord[] = []
  private installedPackages: InstalledChipMatePackage[] = []
  private catalogPackages: ChipMateCatalogPackage[] = []
  private skillSummaries: ChipMateSkillCapabilitySummary[] = []
  private mcpProbeResults: Record<string, ChipMateMcpProbeResult> = {}
  private contextSummary: ContextSummaryItem[] = []
  private sending = false
  private streamingText = ""
  private toolStatus = ""
  private error = ""
  private catalogError = ""
  private knowledgeNotice = ""
  private settingsNotice = ""
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
      case "probeMcpPackage":
        await this.probeMcpPackages(message.id)
        break
      case "knowledgeAction":
        await this.handleKnowledgeAction(message.action)
        break
      case "saveSettings":
        await this.saveSettings(message)
        break
      case "saveModelSettings":
        await this.saveModelSettings(message)
        break
      case "saveKnowledgeSettings":
        await this.saveKnowledgeSettings(message)
        break
      case "saveGlobalSettings":
        await this.saveGlobalSettings(message)
        break
      case "setApiKey":
        if (await this.deps.promptModelApiKey()) vscode.window.setStatusBarMessage("ChipMate API key saved", 2000)
        await this.refreshState()
        break
      case "setRagApiKey":
        if (await this.deps.promptRagApiKey()) vscode.window.setStatusBarMessage("ChipMate RAG API key saved", 2000)
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

  private async probeMcpPackages(packageId?: string) {
    const packages = this.installedPackages.filter((item) => item.type === "mcp" && (!packageId || item.id === packageId))
    if (!packages.length) {
      this.catalogError = packageId ? `MCP package is not installed: ${packageId}` : "No MCP packages are installed."
      this.postState()
      return
    }

    for (const pkg of packages) {
      this.mcpProbeResults[pkg.id] = {
        packageId: pkg.id,
        state: "probing",
        manifestValid: false,
        tools: [],
      }
    }
    this.postState()

    for (const pkg of packages) {
      try {
        const runtime = new McpStdioRuntime({
          packages: [pkg],
          permissionProfile: this.deps.getSettings().permissions.profile,
          workspaceRoots: workspaceRootPaths(),
        })
        const entries = await runtime.registryEntries()
        const tools: ChipMateMcpProbeTool[] = entries.map((entry) => ({
          name: entry.name,
          exposedName: entry.name,
          description: entry.definition.function.description,
          inputSchema: entry.definition.function.parameters as Record<string, unknown>,
          schemaSummary: schemaSummary(entry.definition.function.parameters),
          availability: "Ready",
        }))
        this.mcpProbeResults[pkg.id] = {
          packageId: pkg.id,
          state: "ready",
          manifestValid: true,
          tools,
          probedAt: Date.now(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.mcpProbeResults[pkg.id] = {
          packageId: pkg.id,
          state: "error",
          manifestValid: false,
          tools: [],
          error: message,
          probedAt: Date.now(),
        }
      }
      this.postState()
    }
  }

  private async handleKnowledgeAction(action: ChipMateKnowledgeAction) {
    const codeGraph = this.deps.codeGraph
    if (!codeGraph) {
      this.knowledgeNotice = "CodeGraph service is not available in this workspace."
      this.postState()
      return
    }
    try {
      switch (action) {
        case "check": {
          const status = await codeGraph.testRagConfiguration()
          this.knowledgeNotice = `Knowledge check complete: RAG ${status?.availability ?? "checked"}.`
          break
        }
        case "apply": {
          const result = await codeGraph.applyRagConfiguration({ preserveExistingIndex: true })
          this.knowledgeNotice = `Knowledge apply complete: ${result.action}.`
          break
        }
        case "rebuild":
          await codeGraph.indexWorkspace(true)
          await codeGraph.applyRagConfiguration({ forceRebuild: true })
          this.knowledgeNotice = "Knowledge rebuild started."
          break
        case "pause":
          codeGraph.pauseIndexing("requested from ChipMate Knowledge")
          codeGraph.pauseRagIndexing("manual")
          this.knowledgeNotice = "Knowledge indexing paused."
          break
        case "resume":
          codeGraph.resumeIndexing()
          codeGraph.resumeRagIndexing()
          this.knowledgeNotice = "Knowledge indexing resumed."
          break
        case "cancel":
          codeGraph.cancelIndexing("requested from ChipMate Knowledge")
          codeGraph.cancelRagIndexing("requested from ChipMate Knowledge")
          this.knowledgeNotice = "Knowledge indexing cancellation requested."
          break
      }
    } catch (error) {
      this.knowledgeNotice = error instanceof Error ? error.message : String(error)
    }
    await this.refreshState()
  }

  private async saveSettings(input: Extract<ChipMateViewMessage, { type: "saveSettings" }>) {
    const config = vscode.workspace.getConfiguration("chipmate")
    await config.update("chat.apiBaseUrl", input.apiBaseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("chat.model", input.model.trim(), vscode.ConfigurationTarget.Global)
    await config.update("skills.catalogUrl", input.catalogUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("permissions.profile", input.permissionProfile, vscode.ConfigurationTarget.Global)
    this.settingsNotice = "ChipMate settings saved."
    vscode.window.setStatusBarMessage("ChipMate settings saved", 2000)
    await this.refreshState()
  }

  private async saveModelSettings(input: Extract<ChipMateViewMessage, { type: "saveModelSettings" }>) {
    const config = vscode.workspace.getConfiguration("chipmate")
    await config.update("chat.apiBaseUrl", input.chatApiBaseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("chat.model", input.chatModel.trim(), vscode.ConfigurationTarget.Global)
    await config.update("chat.streaming", Boolean(input.chatStreaming), vscode.ConfigurationTarget.Global)
    await config.update("chat.maxTokens", boundedNumber(input.chatMaxTokens, 1, 32768, 4096), vscode.ConfigurationTarget.Global)
    await config.update("chat.temperature", boundedNumber(input.chatTemperature, 0, 2, 0.2), vscode.ConfigurationTarget.Global)
    await config.update("chat.topP", boundedNumber(input.chatTopP, 0, 1, 1), vscode.ConfigurationTarget.Global)
    await saveCompletionSettings({
      enabled: Boolean(input.completionEnabled),
      provider: "openai-compatible",
      profile: input.completionProfile,
      apiBaseUrl: input.completionApiBaseUrl,
      model: input.completionModel,
      maxTokens: boundedNumber(input.completionMaxTokens, 1, 4096, 128),
      temperature: boundedNumber(input.completionTemperature, 0, 2, 0),
      topP: boundedNumber(input.completionTopP, 0, 1, 1),
    })
    await config.update("completion.debounceMs", boundedNumber(input.completionDebounceMs, 0, 5000, 350), vscode.ConfigurationTarget.Global)
    await config.update("completion.logLevel", input.completionLogLevel, vscode.ConfigurationTarget.Global)
    this.settingsNotice = "Model settings saved."
    vscode.window.setStatusBarMessage("ChipMate model settings saved", 2000)
    await this.refreshState()
  }

  private async saveKnowledgeSettings(input: Extract<ChipMateViewMessage, { type: "saveKnowledgeSettings" }>) {
    await saveRagSettings(input.rag)
    this.knowledgeNotice = "Knowledge settings saved. Use Apply to refresh RAG without a forced rebuild."
    vscode.window.setStatusBarMessage("ChipMate knowledge settings saved", 2000)
    await this.refreshState()
  }

  private async saveGlobalSettings(input: Extract<ChipMateViewMessage, { type: "saveGlobalSettings" }>) {
    const config = vscode.workspace.getConfiguration("chipmate")
    await config.update("skills.catalogUrl", input.catalogUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global)
    await config.update("permissions.profile", input.permissionProfile, vscode.ConfigurationTarget.Global)
    this.settingsNotice = "Global ChipMate settings saved."
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
    await this.refreshSessions()
    await this.refreshInstalledPackages()
    await this.refreshSkillSummaries()
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
    const installedMcpIds = new Set(this.installedPackages.filter((item) => item.type === "mcp").map((item) => item.id))
    for (const id of Object.keys(this.mcpProbeResults)) {
      if (!installedMcpIds.has(id)) delete this.mcpProbeResults[id]
    }
  }

  private async refreshSkillSummaries() {
    const installedSkills = this.installedPackages.filter((item) => item.type === "skill")
    this.skillSummaries = await Promise.all(installedSkills.map(async (skill): Promise<ChipMateSkillCapabilitySummary> => {
      try {
        const runtime = new SkillsRuntime({
          skills: [{ id: skill.id, root: skill.root, version: skill.version, enabled: true }],
          permissionProfile: this.deps.getSettings().permissions.profile,
          workspaceRoots: workspaceRootPaths(),
          isScriptApproved: (skillId, script) => this.hasToolApproval("runSkillScript", `${skillId}:${script}`),
          requestApproval: (permission, context) => this.requestToolApproval(permission, context),
        })
        const [summary] = await runtime.listSkills()
        return {
          ...summary!,
          state: "Ready",
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          id: skill.id,
          name: skill.name || skill.id,
          description: skill.description || message,
          version: skill.version,
          root: skill.root,
          allowedTools: [],
          compatibility: [],
          state: message.includes("SKILL.md") ? "Missing SKILL.md" : "Invalid package",
          error: message,
        }
      }
    }))
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
      skillSummaries: this.skillSummaries,
      mcpProbeResults: this.mcpProbeResults,
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
      knowledgeNotice: this.knowledgeNotice,
      settingsNotice: this.settingsNotice,
      chatSettings: settings.chat,
      completionSettings: settings.completion,
      ragSettings: settings.rag,
      codeGraphSettings: settings.codeGraph,
      contextSettings: settings.context,
      codeGraphStatus: this.deps.codeGraph?.status(),
      ragStatus: this.deps.codeGraph?.status().rag,
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

function boundedNumber(input: number, min: number, max: number, fallback: number) {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function schemaSummary(input: unknown) {
  if (!input || typeof input !== "object") return "schema unavailable"
  const root = input as { properties?: unknown; required?: unknown }
  const properties = root.properties && typeof root.properties === "object" ? Object.keys(root.properties) : []
  const required = Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : []
  if (!properties.length) return "no parameters"
  const requiredSet = new Set(required)
  return properties.slice(0, 6).map((name) => requiredSet.has(name) ? `${name}*` : name).join(", ")
}
