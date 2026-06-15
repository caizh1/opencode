import * as vscode from "vscode"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { AuditLog } from "./audit-log"
import { RemoteChatViewProvider } from "./chat-view"
import { CHIPMATE_COMMANDS, CHIPMATE_OUTPUT_CHANNEL } from "./chipmate-constants"
import { LocalCodeGraphService } from "./codegraph-service"
import { RemoteCompletionProvider } from "./completion"
import { COMPLETION_PLANNER_REVISION } from "./completion-telemetry"
import { registerCompletionFormatCommand } from "./completion-format-command"
import { addPickedFilesToContext, LocalContextStore } from "./context"
import { DirectAgentClient } from "./direct-agent-client"
import { EditorContextTracker } from "./editor-context"
import {
  promptAndSaveCompletionApiKey,
  promptAndSaveRagApiKey,
  readCompletionApiKey,
  readRagApiKey,
  readRemoteSettings,
  saveConnectionSettings,
  settingsFromConnectionInput,
  type ConnectionSettingsInput,
} from "./settings"
import { SkillRegistry } from "./skills"
import { ToolRuntime } from "./tool-runtime"
import type { ConnectionState } from "./types"

let client: DirectAgentClient | undefined
const RAG_CONFIG_REFRESH_DEBOUNCE_MS = 500
const INTERNAL_RAG_CONFIG_CHANGE_SUPPRESSION_MS = 5000
const EXTENSION_UPDATE_RELOAD_PROMPT_KEY = "chipmate.updateReloadPrompt.version"
const EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY = "chipmate.updateReloadAccepted.version"
const EXTENSION_UPDATE_LAST_ACTIVATED_KEY = "chipmate.updateLastActivated.version"
const RELOAD_WINDOW_ACTION = "Reload Window"

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(CHIPMATE_OUTPUT_CHANNEL)
  const extensionVersion = typeof context.extension.packageJSON?.version === "string"
    ? context.extension.packageJSON.version
    : undefined
  output.appendLine(`[activation] extensionVersion=${extensionVersion ?? "unknown"} plannerRevision=${COMPLETION_PLANNER_REVISION}`)

  const contextStore = new LocalContextStore()
  const editorContextTracker = new EditorContextTracker()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = CHIPMATE_COMMANDS.openChat
  context.subscriptions.push(output, status, editorContextTracker)
  registerExtensionUpdateReloadPrompt(context, output)

  const getSettings = () => readRemoteSettings()
  const audit = new AuditLog(context)
  const skills = new SkillRegistry(() => getSettings().skills.enabled, output)
  const tools = new ToolRuntime(audit, output)
  const directClient = new DirectAgentClient({
    context,
    output,
    getSettings,
    getApiKey: () => readCompletionApiKey(context),
    skills,
    tools,
  })
  client = directClient

  let chatProvider: RemoteChatViewProvider
  const setConnectionState = (state: ConnectionState, detail = "") => {
    updateStatus(status, state, detail)
    chatProvider.setConnectionState(state, detail)
  }
  const refreshProviderState = async () => {
    const settings = getSettings()
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      setConnectionState("disconnected", "Ready. Configure an OpenAI-compatible provider to start ChipMate.")
      return false
    }
    const health = await directClient.health()
    setConnectionState(health.healthy ? "connected" : "error", health.version ? `provider ${health.version}` : "")
    await chatProvider.refresh()
    return health.healthy
  }
  const connectWithSettings = async (input: ConnectionSettingsInput) => {
    await saveConnectionSettings(context, input)
    await refreshProviderState()
  }
  const testWithSettings = async (input: ConnectionSettingsInput) => {
    const settings = settingsFromConnectionInput(input)
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      setConnectionState("error", "Provider API base URL and chat model are required.")
      return
    }
    await saveConnectionSettings(context, input)
    await refreshProviderState()
  }

  const codeGraph = new LocalCodeGraphService(context, output, getSettings, () => readRagApiKey(context), () => chatProvider?.refreshCodeGraphStatus())
  context.subscriptions.push(codeGraph)
  let ragConfigurationApplyTimer: ReturnType<typeof setTimeout> | undefined
  let ignoreRagConfigurationChangesUntil = 0
  const suppressNextRagConfigurationApply = () => {
    ignoreRagConfigurationChangesUntil = Date.now() + INTERNAL_RAG_CONFIG_CHANGE_SUPPRESSION_MS
    if (ragConfigurationApplyTimer) {
      clearTimeout(ragConfigurationApplyTimer)
      ragConfigurationApplyTimer = undefined
    }
  }
  const scheduleRagConfigurationApply = () => {
    if (ragConfigurationApplyTimer) clearTimeout(ragConfigurationApplyTimer)
    ragConfigurationApplyTimer = setTimeout(() => {
      ragConfigurationApplyTimer = undefined
      if (Date.now() < ignoreRagConfigurationChangesUntil) return
      void codeGraph.applyRagConfiguration().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[rag] configuration apply failed: ${message}`)
      })
    }, RAG_CONFIG_REFRESH_DEBOUNCE_MS)
  }
  context.subscriptions.push(new vscode.Disposable(() => {
    if (ragConfigurationApplyTimer) clearTimeout(ragConfigurationApplyTimer)
  }))

  chatProvider = new RemoteChatViewProvider({
    output,
    extensionUri: context.extensionUri,
    contextStore,
    codeGraph,
    getClient: () => client,
    getSettings,
    getEditorContext: () => editorContextTracker.snapshot(),
    getCompletionApiKey: () => readCompletionApiKey(context),
    promptCompletionApiKey: async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) vscode.window.setStatusBarMessage("ChipMate provider API key saved", 2000)
      return saved
    },
    promptRagApiKey: async () => {
      const saved = await promptAndSaveRagApiKey(context)
      if (saved) vscode.window.setStatusBarMessage("RAG API key saved", 2000)
      if (saved) await codeGraph.applyRagConfiguration()
      return saved
    },
    connectWithSettings,
    testWithSettings,
    setConnectionState,
    clearClient: (target) => {
      if (client === target) client = directClient
    },
    openOutput: () => output.show(true),
    suppressNextRagConfigurationApply,
    invalidateSkills: () => skills.invalidate(),
    listSkills: () => skills.listSkills(),
  })
  context.subscriptions.push(chatProvider)

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("chipmate.skills")) {
        skills.invalidate()
        void chatProvider.refresh()
      }
      if (event.affectsConfiguration("chipmate.rag")) {
        if (Date.now() >= ignoreRagConfigurationChangesUntil) scheduleRagConfigurationApply()
      }
      if (event.affectsConfiguration("chipmate.provider") || event.affectsConfiguration("chipmate.permissions") || event.affectsConfiguration("chipmate.tools")) {
        chatProvider.refreshState()
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.openChat, async () => {
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.newSession, async () => {
      await chatProvider.reveal()
      await chatProvider.newSession()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.askSelection, async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask ChipMate about selection",
        prompt: "Question to send with the current selection.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeSelection: true, includeCurrentFile: false })
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.askCurrentFile, async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask ChipMate about current file",
        prompt: "Question to send with the current file context.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeCurrentFile: true })
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.addFileToContext, async () => {
      const tracked = editorContextTracker.snapshot()
      const addedTracked = Boolean(tracked?.uri.scheme === "file")
      if (tracked?.uri.scheme === "file") contextStore.add(tracked.uri)
      if (!addedTracked) await addPickedFilesToContext(contextStore)
      vscode.window.setStatusBarMessage("Added file to ChipMate context", 2000)
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.clearContext, async () => {
      contextStore.clear()
      vscode.window.setStatusBarMessage("Cleared ChipMate context", 2000)
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.openOutput, () => output.show(false)),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.setProviderApiKey, async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) {
        vscode.window.setStatusBarMessage("ChipMate provider API key saved", 2000)
        chatProvider.refreshState()
      }
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.completionRunDirectAblation, async () => {
      await runDirectQwenAblationCommand(context, output)
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.completionCommitInlineSuggestion, async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit")
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphIndex, async () => {
      await codeGraph.indexWorkspace(false)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphRebuild, async () => {
      await codeGraph.indexWorkspace(true)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphPause, async () => {
      codeGraph.pauseIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphResume, async () => {
      codeGraph.resumeIndexing()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphCancel, async () => {
      codeGraph.cancelIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphBenchmark, async () => {
      await codeGraph.benchmarkSyntheticRepository(1000)
      await codeGraph.showStatus()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.codeGraphStatus, async () => {
      await codeGraph.showStatus()
    }),
  )

  registerCompletionFormatCommand(context, output)
  updateStatus(status, "disconnected")
  status.show()

  try {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RemoteChatViewProvider.viewType, chatProvider))
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate chat view", error)
  }

  try {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: "file" },
        new RemoteCompletionProvider({ getClient: () => client, getCompletionApiKey: () => readCompletionApiKey(context), getSettings, codeGraph, output, extensionVersion }),
      ),
    )
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate inline completion", error)
  }

  await refreshProviderState().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[provider] restore failed: ${message}`)
    setConnectionState("error", message)
  })
  void codeGraph.maybePromptAndIndex()
}

export function deactivate() {
  client = undefined
}

function registerExtensionUpdateReloadPrompt(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const extensionId = context.extension.id || "local.chipmate"
  const runningVersion = readPackageJsonVersion(context.extension.packageJSON)
  if (!runningVersion) return

  let promptInFlightVersion: string | undefined
  const promptedVersionsThisActivation = new Set<string>()
  const previousActivatedVersion = context.globalState.get<string>(EXTENSION_UPDATE_LAST_ACTIVATED_KEY)
  const rememberActivatedVersion = () => context.globalState.update(EXTENSION_UPDATE_LAST_ACTIVATED_KEY, runningVersion)
  const reloadPromptTargetVersion = (acceptedVersion?: string) => {
    const installedVersion = readPackageJsonVersion(vscode.extensions.getExtension(extensionId)?.packageJSON)
    if (installedVersion && shouldPromptReloadForInstalledVersion(installedVersion, runningVersion)) return installedVersion
    if (previousActivatedVersion && shouldPromptReloadForInstalledVersion(runningVersion, previousActivatedVersion)) return runningVersion
    if (acceptedVersion !== runningVersion) return runningVersion
    return undefined
  }
  const checkForInstalledUpdate = async () => {
    const acceptedVersion = context.globalState.get<string>(EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY)
    const reloadVersion = reloadPromptTargetVersion(acceptedVersion)
    if (!reloadVersion) {
      await rememberActivatedVersion()
      return
    }

    if (acceptedVersion === reloadVersion) {
      await rememberActivatedVersion()
      return
    }
    if (promptedVersionsThisActivation.has(reloadVersion) || promptInFlightVersion === reloadVersion) return

    promptInFlightVersion = reloadVersion
    promptedVersionsThisActivation.add(reloadVersion)
    try {
      await context.globalState.update(EXTENSION_UPDATE_RELOAD_PROMPT_KEY, reloadVersion)
      const selected = await vscode.window.showInformationMessage(
        `ChipMate 已更新到 ${reloadVersion}，重新加载窗口后新版本会生效。`,
        RELOAD_WINDOW_ACTION,
      )
      if (selected === RELOAD_WINDOW_ACTION) {
        await context.globalState.update(EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY, reloadVersion)
        await rememberActivatedVersion()
        await vscode.commands.executeCommand("workbench.action.reloadWindow")
      }
    } finally {
      if (promptInFlightVersion === reloadVersion) promptInFlightVersion = undefined
    }
  }

  context.subscriptions.push(vscode.extensions.onDidChange(() => {
    void checkForInstalledUpdate().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[update] reload prompt failed: ${message}`)
    })
  }))
  void checkForInstalledUpdate().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[update] activation reload prompt failed: ${message}`)
  })
}

function shouldPromptReloadForInstalledVersion(installedVersion: string, runningVersion: string) {
  if (installedVersion === runningVersion) return false
  return compareExtensionVersions(installedVersion, runningVersion) > 0
}

function compareExtensionVersions(left: string, right: string) {
  const leftParts = readSemverCoreParts(left)
  const rightParts = readSemverCoreParts(right)
  if (!leftParts || !rightParts) return left === right ? 0 : 1
  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index] - rightParts[index]
    if (delta !== 0) return delta
  }
  return 0
}

function readSemverCoreParts(version: string): [number, number, number] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function readPackageJsonVersion(packageJSON: unknown) {
  if (!packageJSON || typeof packageJSON !== "object" || !("version" in packageJSON)) return undefined
  const version = (packageJSON as { version?: unknown }).version
  return typeof version === "string" && version.trim() ? version.trim() : undefined
}

async function runDirectQwenAblationCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const settings = readRemoteSettings()
  const apiKey = await readCompletionApiKey(context)
  const apiBaseUrl = settings.provider.apiBaseUrl.trim()
  const model = settings.completion.model.trim() || settings.provider.chatModel.trim()
  if (!apiBaseUrl || !model) {
    const message = "Direct Qwen ablation requires ChipMate provider API base URL and completion model in VS Code settings."
    output.appendLine(`[completion-ablation] ${message}`)
    void vscode.window.showErrorMessage(message)
    return
  }

  const cwd = completionBenchmarkCwd(context)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPLETION_API_BASE_URL: apiBaseUrl,
    COMPLETION_MODEL: model,
    COMPLETION_TRANSPORT: "raw-completions",
    COMPLETION_PROMPT_STYLE: "qwen-fim",
    COMPLETION_TEMPERATURE: "0",
    COMPLETION_MAX_TOKENS: String(settings.completion.maxTokens || 128),
    COMPLETION_TOP_P: String(settings.completion.topP ?? 1),
  }
  if (apiKey?.trim()) env.COMPLETION_API_KEY = apiKey.trim()

  output.show(true)
  output.appendLine(`[completion-ablation] starting direct-qwen ablation cwd=${cwd}`)
  output.appendLine(`[completion-ablation] apiBaseUrl=${apiBaseUrl} model=${model} apiKey=${apiKey?.trim() ? "present" : "empty"} transport=raw-completions promptStyle=qwen-fim`)
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Running Direct Qwen completion ablation",
    cancellable: false,
  }, () => new Promise<void>((resolve) => {
    const child = spawn("bun", ["run", "benchmark:completion-quality", "--", "--direct-qwen-ablation"], {
      cwd,
      env,
      shell: false,
    })
    child.stdout.on("data", (chunk) => output.append(chunk.toString()))
    child.stderr.on("data", (chunk) => output.append(chunk.toString()))
    child.on("error", (error) => {
      const message = `Direct Qwen ablation failed to start: ${error.message}`
      output.appendLine(`[completion-ablation] ${message}`)
      void vscode.window.showErrorMessage(message)
      resolve()
    })
    child.on("close", (code) => {
      if (code === 0) {
        output.appendLine("[completion-ablation] completed; see docs/completion-p2-direct-qwen-ablation-report.md")
        void vscode.window.showInformationMessage("Direct Qwen completion ablation completed.")
      } else {
        const message = `Direct Qwen ablation failed with exit code ${code ?? "unknown"}.`
        output.appendLine(`[completion-ablation] ${message}`)
        void vscode.window.showErrorMessage(message)
      }
      resolve()
    })
  }))
}

function completionBenchmarkCwd(context: vscode.ExtensionContext) {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath
    if (existsSync(join(root, "package.json")) && existsSync(join(root, "scripts", "completion-quality-benchmark.ts"))) return root
  }
  return context.extensionUri.fsPath
}

function updateStatus(status: vscode.StatusBarItem, state: ConnectionState, detail = "") {
  switch (state) {
    case "connected":
      status.text = "$(plug) ChipMate: Connected"
      status.tooltip = detail || "ChipMate provider connected"
      status.backgroundColor = undefined
      break
    case "connecting":
      status.text = "$(sync~spin) ChipMate: Connecting"
      status.tooltip = detail || "Connecting to ChipMate provider"
      status.backgroundColor = undefined
      break
    case "authFailed":
      status.text = "$(warning) ChipMate: Auth Failed"
      status.tooltip = detail || "ChipMate provider authentication failed"
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      break
    case "error":
      status.text = "$(error) ChipMate: Error"
      status.tooltip = detail || "ChipMate provider error"
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
      break
    case "disconnected":
      status.text = "$(circle-slash) ChipMate: Configure"
      status.tooltip = detail || "Open ChipMate and configure a provider"
      status.backgroundColor = undefined
      break
  }
}

function reportActivationError(output: vscode.OutputChannel, title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  output.appendLine(`${title}: ${message}`)
  void vscode.window.showErrorMessage(`${title}. See the ChipMate output for details.`)
}
