import * as vscode from "vscode"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ChipMateChatViewProvider } from "./chipmate-chat-view"
import { LocalCodeGraphService } from "./codegraph-service"
import { RemoteCompletionProvider } from "./completion"
import { COMPLETION_PLANNER_REVISION } from "./completion-telemetry"
import { registerCompletionFormatCommand } from "./completion-format-command"
import { addPickedFilesToContext, LocalContextStore } from "./context"
import { EditorContextTracker } from "./editor-context"
import {
  promptAndSaveCompletionApiKey,
  promptAndSaveRagApiKey,
  readCompletionApiKey,
  readRagApiKey,
  readRemoteSettings,
} from "./settings"
import type { RemoteSettings } from "./types"

const RAG_CONFIG_REFRESH_DEBOUNCE_MS = 500
const INTERNAL_RAG_CONFIG_CHANGE_SUPPRESSION_MS = 5000
const EXTENSION_UPDATE_RELOAD_PROMPT_KEY = "chipmate.updateReloadPrompt.version"
const EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY = "chipmate.updateReloadAccepted.version"
const EXTENSION_UPDATE_LAST_ACTIVATED_KEY = "chipmate.updateLastActivated.version"
const RELOAD_WINDOW_ACTION = "Reload Window"

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("ChipMate")
  const extensionVersion = typeof context.extension.packageJSON?.version === "string"
    ? context.extension.packageJSON.version
    : undefined
  output.appendLine(`[activation] extensionVersion=${extensionVersion ?? "unknown"} plannerRevision=${COMPLETION_PLANNER_REVISION}`)

  const contextStore = new LocalContextStore()
  const editorContextTracker = new EditorContextTracker()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = "chipmate.openChat"
  context.subscriptions.push(output, status, editorContextTracker)
  registerExtensionUpdateReloadPrompt(context, output)

  const getSettings = () => readRemoteSettings()
  let chatProvider: ChipMateChatViewProvider
  const codeGraph = new LocalCodeGraphService(context, output, getSettings, () => readRagApiKey(context), () => chatProvider?.refreshStateOnly())
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

  chatProvider = new ChipMateChatViewProvider({
    context,
    output,
    contextStore,
    codeGraph,
    getSettings,
    getModelApiKey: () => readCompletionApiKey(context),
    promptModelApiKey: async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) vscode.window.setStatusBarMessage("ChipMate API key saved", 2000)
      return saved
    },
    promptRagApiKey: async () => {
      const saved = await promptAndSaveRagApiKey(context)
      if (saved) vscode.window.setStatusBarMessage("ChipMate RAG API key saved", 2000)
      return saved
    },
    getEditorContext: () => editorContextTracker.snapshot(),
    openOutput: () => output.show(true),
  })
  context.subscriptions.push(chatProvider)

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("chipmate.rag")) {
        if (Date.now() >= ignoreRagConfigurationChangesUntil) scheduleRagConfigurationApply()
      }
      if (event.affectsConfiguration("chipmate")) {
        updateStatus(status, getSettings())
        chatProvider.refreshStateOnly()
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("chipmate.openChat", async () => {
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("chipmate.newSession", async () => {
      await chatProvider.reveal()
      await chatProvider.newSession()
    }),
    vscode.commands.registerCommand("chipmate.askSelection", async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask ChipMate about selection",
        prompt: "Question to send with the current selection.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeSelection: true, includeCurrentFile: false })
    }),
    vscode.commands.registerCommand("chipmate.askCurrentFile", async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask ChipMate about current file",
        prompt: "Question to send with the current file context.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeCurrentFile: true })
    }),
    vscode.commands.registerCommand("chipmate.addFileToContext", async () => {
      const tracked = editorContextTracker.snapshot()
      const addedTracked = Boolean(tracked?.uri.scheme === "file")
      if (tracked?.uri.scheme === "file") contextStore.add(tracked.uri)
      if (!addedTracked) await addPickedFilesToContext(contextStore)
      vscode.window.setStatusBarMessage("Added file to ChipMate context", 2000)
      chatProvider.refreshStateOnly()
    }),
    vscode.commands.registerCommand("chipmate.clearContext", async () => {
      contextStore.clear()
      vscode.window.setStatusBarMessage("Cleared ChipMate context", 2000)
      chatProvider.refreshStateOnly()
    }),
    vscode.commands.registerCommand("chipmate.openOutput", () => {
      output.show(false)
    }),
    vscode.commands.registerCommand("chipmate.completion.setApiKey", async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) {
        vscode.window.setStatusBarMessage("ChipMate API key saved", 2000)
        chatProvider.refreshStateOnly()
      }
    }),
    vscode.commands.registerCommand("chipmate.completion.runDirectAblation", async () => {
      await runDirectQwenAblationCommand(context, output)
    }),
    vscode.commands.registerCommand("chipmate.completion.commitInlineSuggestion", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit")
    }),
    vscode.commands.registerCommand("chipmate.rag.setApiKey", async () => {
      const saved = await promptAndSaveRagApiKey(context)
      if (saved) {
        vscode.window.setStatusBarMessage("ChipMate RAG API key saved", 2000)
        suppressNextRagConfigurationApply()
        await codeGraph.applyRagConfiguration()
      }
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.index", async () => {
      await codeGraph.indexWorkspace(false)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.rebuild", async () => {
      await codeGraph.indexWorkspace(true)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.pause", async () => {
      codeGraph.pauseIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.resume", async () => {
      codeGraph.resumeIndexing()
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.cancel", async () => {
      codeGraph.cancelIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.benchmark", async () => {
      await codeGraph.benchmarkSyntheticRepository(1000)
      await codeGraph.showStatus()
    }),
    vscode.commands.registerCommand("chipmate.codeGraph.status", async () => {
      await codeGraph.showStatus()
    }),
  )

  registerCompletionFormatCommand(context, output)

  updateStatus(status, getSettings())
  status.show()

  try {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChipMateChatViewProvider.viewType, chatProvider))
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate chat view", error)
  }

  try {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: "file" },
        new RemoteCompletionProvider({
          getCompletionApiKey: () => readCompletionApiKey(context),
          getSettings,
          codeGraph,
          output,
          extensionVersion,
        }),
      ),
    )
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate inline completion", error)
  }

  void codeGraph.maybePromptAndIndex()
}

export function deactivate() {
  // ChipMate owns no external model server process or remote session.
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
        `ChipMate updated to ${reloadVersion}. Reload the window to activate the new version.`,
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
  const apiBaseUrl = settings.completion.apiBaseUrl.trim() || settings.chat.apiBaseUrl.trim()
  const model = settings.completion.model.trim() || settings.chat.model.trim() || settings.defaultModel.trim()
  if (!apiBaseUrl || !model) {
    const message = "Direct Qwen ablation requires a ChipMate API base URL and model in VS Code settings."
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

function updateStatus(status: vscode.StatusBarItem, settings: RemoteSettings) {
  if (settings.chat.apiBaseUrl && settings.chat.model) {
    status.text = "$(sparkle) ChipMate"
    status.tooltip = `ChipMate: ${settings.chat.model} @ ${settings.chat.apiBaseUrl}`
    status.backgroundColor = undefined
    return
  }
  status.text = "$(circle-slash) ChipMate"
  status.tooltip = "Configure ChipMate model settings"
  status.backgroundColor = undefined
}

function reportActivationError(output: vscode.OutputChannel, title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  output.appendLine(`${title}: ${message}`)
  void vscode.window.showErrorMessage(`${title}. See the ChipMate output for details.`)
}
