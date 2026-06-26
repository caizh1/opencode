import * as vscode from "vscode"
import { activationMs, activationNow, formatActivationSlowRequireTiming, readActivationEntryTiming } from "./activation-timing"
import { registerAgentTerminal } from "./agent-terminal-vscode"
import { AuditLog } from "./audit-log"
import { RemoteChatViewProvider } from "./chat-view"
import { CHIPMATE_COMMANDS, CHIPMATE_COMMENT_OUTPUT_CHANNEL, CHIPMATE_OUTPUT_CHANNEL, PROVIDER_API_KEY_SECRET_KEY } from "./chipmate-constants"
import { LocalCodeGraphService } from "./codegraph-service"
import { COMPLETION_PLANNER_REVISION } from "./completion-telemetry"
import { registerCompletionFormatCommand } from "./completion-format-command"
import { registerCommentReview } from "./comments/commentCommands"
import { addPickedFilesToContext, addTrackedFileToContext, addTrackedSelectionToContext, LocalContextStore } from "./context"
import { DirectAgentClient } from "./direct-agent-client"
import { DocumentRagService, isCodeGraphBusyForDocumentRag } from "./document-rag"
import { EditorContextTracker } from "./editor-context"
import { shouldPromptReloadForInstalledVersion } from "./extension-version"
import { registerQwenAutocompleteProvider } from "./qwen-autocomplete"
import {
  connectionInputHasPassword,
  migrateLegacyRagApiKey,
  promptAndSaveProviderApiKey,
  readProviderApiKey,
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
const EXTENSION_UPDATE_RELOAD_RETRY_DELAYS_MS = [1000, 3000] as const
const RELOAD_WINDOW_ACTION = "Reload Window"

export async function activate(context: vscode.ExtensionContext) {
  const activationStartedAt = activationNow()
  const output = vscode.window.createOutputChannel(CHIPMATE_OUTPUT_CHANNEL)
  const commentOutput = vscode.window.createOutputChannel(CHIPMATE_COMMENT_OUTPUT_CHANNEL)
  const extensionVersion = typeof context.extension.packageJSON?.version === "string"
    ? context.extension.packageJSON.version
    : undefined
  const logActivationPhase = (phase: string, phaseStartedAt: number) => {
    const now = activationNow()
    output.appendLine(`[activation-timing] phase=${phase} phaseMs=${activationMs(now - phaseStartedAt)} totalMs=${activationMs(now - activationStartedAt)}`)
    return now
  }
  const logActivationEnvironment = (getSettings: () => ReturnType<typeof readRemoteSettings>) => {
    const settings = getSettings()
    output.appendLine(
      `[activation-timing] environment workspaceFolders=${vscode.workspace.workspaceFolders?.length ?? 0} providerApiBaseUrlConfigured=${Boolean(settings.provider.apiBaseUrl)} providerChatModelConfigured=${Boolean(settings.provider.chatModel)} codeGraphEnabled=${settings.codeGraph.enabled} documentRagEnabled=${settings.documentRag.enabled} completionEnabled=${settings.completion.enabled}`,
    )
  }

  const contextStore = new LocalContextStore()
  const editorContextTracker = new EditorContextTracker()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = CHIPMATE_COMMANDS.openChat
  context.subscriptions.push(output, commentOutput, status, editorContextTracker)
  output.appendLine(`[activation] extensionVersion=${extensionVersion ?? "unknown"} plannerRevision=${COMPLETION_PLANNER_REVISION}`)
  logPreActivationTiming(output)
  logActivationPhase("bootstrap", activationStartedAt)

  let phaseStartedAt = activationNow()
  registerExtensionUpdateReloadPrompt(context, output, activationStartedAt)
  logActivationPhase("update-reload-prompt", phaseStartedAt)

  phaseStartedAt = activationNow()
  try {
    const migrated = await migrateLegacyRagApiKey(context)
    if (migrated) output.appendLine("[provider] migrated legacy RAG credential to provider API key")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[provider] legacy RAG credential migration failed: ${message}`)
  }
  logActivationPhase("legacy-rag-key-migration", phaseStartedAt)

  phaseStartedAt = activationNow()
  const getSettings = () => readRemoteSettings()
  const audit = new AuditLog(context)
  const skills = new SkillRegistry(() => getSettings().skills, output)
  const tools = new ToolRuntime(audit, output)
  const directClient = new DirectAgentClient({
    context,
    output,
    getSettings,
    getApiKey: () => readProviderApiKey(context),
    skills,
    tools,
  })
  client = directClient
  logActivationEnvironment(getSettings)
  logActivationPhase("runtime-services", phaseStartedAt)

  phaseStartedAt = activationNow()
  registerAgentTerminal({
    context,
    output,
    getClient: () => client,
  })
  logActivationPhase("agent-terminal", phaseStartedAt)

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
    setConnectionState(health.state, health.detail ?? (health.version ? `provider ${health.version}` : ""))
    await chatProvider.refresh()
    return health.healthy
  }
  const connectWithSettings = async (input: ConnectionSettingsInput) => {
    const providerKeyTouched = connectionInputHasPassword(input)
    await saveConnectionSettings(context, input)
    if (providerKeyTouched) {
      await refreshAfterProviderCredentialChange("connect-settings")
      return
    }
    await refreshProviderState()
  }
  const testWithSettings = async (input: ConnectionSettingsInput) => {
    const settings = settingsFromConnectionInput(input)
    if (!settings.provider.apiBaseUrl || !settings.provider.chatModel) {
      setConnectionState("error", "Provider API base URL and chat model are required.")
      return
    }
    const providerKeyTouched = connectionInputHasPassword(input)
    await saveConnectionSettings(context, input)
    if (providerKeyTouched) {
      await refreshAfterProviderCredentialChange("test-settings")
      return
    }
    await refreshProviderState()
  }

  phaseStartedAt = activationNow()
  const codeGraph = new LocalCodeGraphService(context, output, getSettings, () => readProviderApiKey(context), () => chatProvider?.refreshCodeGraphStatus())
  context.subscriptions.push(codeGraph)
  const documentRag = new DocumentRagService(
    context,
    output,
    getSettings,
    () => readProviderApiKey(context),
    () => chatProvider?.refreshState(),
    () => isCodeGraphBusyForDocumentRag(codeGraph.status()),
  )
  context.subscriptions.push(documentRag)
  tools.setContextProviders({ codeGraph, documentRag, getSettings })
  logActivationPhase("rag-services", phaseStartedAt)
  async function refreshRagProvidersAfterProviderKeyChange() {
    try {
      await codeGraph.applyRagConfiguration()
      documentRag.refreshConfiguration()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[rag] provider API key refresh failed: ${message}`)
    }
  }
  let providerCredentialRefreshInFlight: Promise<void> | undefined
  function refreshAfterProviderCredentialChange(reason: string) {
    if (providerCredentialRefreshInFlight) return providerCredentialRefreshInFlight
    providerCredentialRefreshInFlight = (async () => {
      output.appendLine(`[provider] provider API key changed; refreshing provider and RAG state reason=${reason}`)
      await refreshRagProvidersAfterProviderKeyChange()
      await refreshProviderState()
    })().finally(() => {
      providerCredentialRefreshInFlight = undefined
    })
    return providerCredentialRefreshInFlight
  }
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

  phaseStartedAt = activationNow()
  chatProvider = new RemoteChatViewProvider({
    output,
    extensionUri: context.extensionUri,
    contextStore,
    codeGraph,
    documentRag,
    getClient: () => client,
    getSettings,
    getEditorContext: () => editorContextTracker.snapshot(),
    getProviderApiKey: () => readProviderApiKey(context),
    connectWithSettings,
    testWithSettings,
    setConnectionState,
    clearClient: (target) => {
      if (client === target) client = directClient
    },
    openAgentTerminal: async () => {
      await vscode.commands.executeCommand(CHIPMATE_COMMANDS.openAgentTerminal)
    },
    openOutput: () => output.show(true),
    suppressNextRagConfigurationApply,
    invalidateSkills: () => skills.invalidate(),
    listSkills: () => skills.listSkills(),
  })
  context.subscriptions.push(chatProvider)
  logActivationPhase("chat-provider", phaseStartedAt)

  phaseStartedAt = activationNow()
  registerCommentReview({
    context,
    output: commentOutput,
    getSettings,
    getApiKey: () => readProviderApiKey(context),
    codeGraph,
    tools,
    extensionVersion,
  })

  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key !== PROVIDER_API_KEY_SECRET_KEY) return
      void refreshAfterProviderCredentialChange("secret-storage").catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[provider] provider API key refresh after secret change failed: ${message}`)
        setConnectionState("error", message)
      })
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("chipmate.skills")) {
        skills.invalidate()
        void chatProvider.refresh()
      }
      if (event.affectsConfiguration("chipmate.rag")) {
        if (Date.now() >= ignoreRagConfigurationChangesUntil) scheduleRagConfigurationApply()
        documentRag.refreshConfiguration()
      }
      if (event.affectsConfiguration("chipmate.documentRag")) {
        documentRag.refreshConfiguration()
      }
      if (event.affectsConfiguration("chipmate.codeGraph.indexTests")) {
        output.appendLine("[codegraph] test directory indexing setting changed; queued full rebuild")
        void codeGraph.indexWorkspace(true).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          output.appendLine(`[codegraph] rebuild after test indexing setting change failed: ${message}`)
        })
      }
      if (event.affectsConfiguration("chipmate.provider")) {
        void refreshProviderState().catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          output.appendLine(`[provider] refresh failed: ${message}`)
          setConnectionState("error", message)
        })
      }
      if (event.affectsConfiguration("chipmate.permissions") || event.affectsConfiguration("chipmate.tools")) {
        chatProvider.refreshState()
      }
    }),
  )
  logActivationPhase("comment-review-and-listeners", phaseStartedAt)

  phaseStartedAt = activationNow()
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
      const item = await addTrackedFileToContext(contextStore, tracked)
      if (!item) {
        const count = await addPickedFilesToContext(contextStore)
        if (count > 0) vscode.window.setStatusBarMessage(`Attached ${count} file(s) to ChipMate context`, 2000)
      } else {
        vscode.window.setStatusBarMessage("Added current file to ChipMate context", 2000)
      }
      chatProvider.refreshState()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.addSelectionToContext, async () => {
      const item = await addTrackedSelectionToContext(contextStore, getSettings(), editorContextTracker.snapshot())
      if (!item) {
        vscode.window.showWarningMessage("Select code in a local file before adding it to ChipMate context.")
        return
      }
      chatProvider.refreshState()
      vscode.window.setStatusBarMessage("Added selection to ChipMate context", 2000)
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.clearContext, async () => {
      contextStore.clear()
      chatProvider.refreshState()
      vscode.window.setStatusBarMessage("Cleared ChipMate context", 2000)
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.openOutput, () => output.show(false)),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.setProviderApiKey, async () => {
      const saved = await promptAndSaveProviderApiKey(context)
      if (saved) {
        vscode.window.setStatusBarMessage("ChipMate provider API key saved", 2000)
        await refreshAfterProviderCredentialChange("command")
      }
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
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.documentRagRebuild, async () => {
      documentRag.rebuild()
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.documentRagPause, async () => {
      documentRag.pauseIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.documentRagResume, async () => {
      documentRag.resumeIndexing()
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.documentRagStatus, async () => {
      await documentRag.showStatus()
    }),
  )

  registerCompletionFormatCommand(context, output)
  updateStatus(status, "disconnected")
  status.show()
  logActivationPhase("commands", phaseStartedAt)

  phaseStartedAt = activationNow()
  try {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RemoteChatViewProvider.viewType, chatProvider))
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate chat view", error)
  }
  logActivationPhase("webview-provider", phaseStartedAt)

  phaseStartedAt = activationNow()
  try {
    context.subscriptions.push(registerQwenAutocompleteProvider(context, {
      apiKey: () => readProviderApiKey(context),
      log: (message) => output.appendLine(message),
      rootPathGraph: {
        findSymbols: (input) => codeGraph.findSymbols(input),
        status: () => codeGraph.status(),
      },
    }))
  } catch (error) {
    reportActivationError(output, "Failed to register ChipMate inline completion", error)
  }
  logActivationPhase("qwen-autocomplete", phaseStartedAt)

  phaseStartedAt = activationNow()
  await refreshProviderState().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[provider] restore failed: ${message}`)
    setConnectionState("error", message)
  })
  logActivationPhase("provider-refresh", phaseStartedAt)

  phaseStartedAt = activationNow()
  documentRag.start()
  logActivationPhase("document-rag-start", phaseStartedAt)

  phaseStartedAt = activationNow()
  void codeGraph.maybePromptAndIndex()
  logActivationPhase("codegraph-start-kickoff", phaseStartedAt)
  output.appendLine(`[activation-timing] done totalMs=${activationMs(activationNow() - activationStartedAt)}`)
}

export function deactivate() {
  client = undefined
}

function logPreActivationTiming(output: vscode.OutputChannel) {
  const timing = readActivationEntryTiming()
  if (!timing) return
  output.appendLine(
    `[activation-timing] preactivate entryWaitMs=${formatActivationTimingMs(timing.entryWaitMs)} moduleLoadMs=${formatActivationTimingMs(timing.moduleLoadMs)} beforeDelegateMs=${formatActivationTimingMs(timing.beforeDelegateMs)}`,
  )
  for (const item of timing.slowRequires) {
    output.appendLine(formatActivationSlowRequireTiming("[activation-timing]", item))
  }
}

function formatActivationTimingMs(value: number | undefined) {
  return value === undefined ? "unknown" : String(value)
}

function registerExtensionUpdateReloadPrompt(context: vscode.ExtensionContext, output: vscode.OutputChannel, activationStartedAt: number) {
  const extensionId = context.extension.id || "local.chipmate"
  const runningVersion = readPackageJsonVersion(context.extension.packageJSON)
  const updateReloadLogValue = (value: string | undefined) => value ?? "unknown"
  const updateReloadSinceActivationMs = () => activationMs(activationNow() - activationStartedAt)
  const appendUpdateReloadLog = (message: string) => {
    output.appendLine(`[update-reload] ${message} sinceActivationMs=${updateReloadSinceActivationMs()}`)
  }
  if (!runningVersion) {
    appendUpdateReloadLog(`event=disabled extensionId=${updateReloadLogValue(extensionId)} skipReason=no-running-version`)
    return
  }

  let promptInFlightVersion: string | undefined
  const promptedVersionsThisActivation = new Set<string>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const previousActivatedVersion = context.globalState.get<string>(EXTENSION_UPDATE_LAST_ACTIVATED_KEY)
  const rememberActivatedVersion = () => context.globalState.update(EXTENSION_UPDATE_LAST_ACTIVATED_KEY, runningVersion)
  const reloadPromptTargetVersion = (acceptedVersion: string | undefined, installedVersion: string | undefined) => {
    if (installedVersion && shouldPromptReloadForInstalledVersion(installedVersion, runningVersion)) return installedVersion
    if (previousActivatedVersion && shouldPromptReloadForInstalledVersion(runningVersion, previousActivatedVersion)) return runningVersion
    if (acceptedVersion !== runningVersion) return runningVersion
    return undefined
  }
  const reloadPromptSkipReason = (acceptedVersion: string | undefined, installedVersion: string | undefined) => {
    if (!installedVersion) return "metadata-unavailable"
    if (acceptedVersion === runningVersion && installedVersion === runningVersion) return "same-version"
    if (!shouldPromptReloadForInstalledVersion(installedVersion, runningVersion)) return "not-newer"
    return "not-newer"
  }
  const logCheckResult = (reason: string, decision: "prompt" | "skip" | "retry", installedVersion: string | undefined, acceptedVersion: string | undefined, reloadVersion: string | undefined, skipReason?: string) => {
    appendUpdateReloadLog(
      `event=check-result reason=${reason} decision=${decision} extensionId=${updateReloadLogValue(extensionId)} runningVersion=${updateReloadLogValue(runningVersion)} installedVersion=${updateReloadLogValue(installedVersion)} previousActivatedVersion=${updateReloadLogValue(previousActivatedVersion)} acceptedVersion=${updateReloadLogValue(acceptedVersion)} reloadVersion=${updateReloadLogValue(reloadVersion)} skipReason=${updateReloadLogValue(skipReason)}`,
    )
  }
  const checkForInstalledUpdate = async (reason: string) => {
    const acceptedVersion = context.globalState.get<string>(EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY)
    const installedVersion = readPackageJsonVersion(vscode.extensions.getExtension(extensionId)?.packageJSON)
    appendUpdateReloadLog(
      `event=check-start reason=${reason} extensionId=${updateReloadLogValue(extensionId)} runningVersion=${updateReloadLogValue(runningVersion)} installedVersion=${updateReloadLogValue(installedVersion)} previousActivatedVersion=${updateReloadLogValue(previousActivatedVersion)} acceptedVersion=${updateReloadLogValue(acceptedVersion)}`,
    )
    const reloadVersion = reloadPromptTargetVersion(acceptedVersion, installedVersion)
    if (!reloadVersion) {
      const skipReason = reloadPromptSkipReason(acceptedVersion, installedVersion)
      logCheckResult(reason, skipReason === "metadata-unavailable" ? "retry" : "skip", installedVersion, acceptedVersion, undefined, skipReason)
      await rememberActivatedVersion()
      return
    }

    if (acceptedVersion === reloadVersion) {
      logCheckResult(reason, "skip", installedVersion, acceptedVersion, reloadVersion, "accepted")
      await rememberActivatedVersion()
      return
    }
    if (promptedVersionsThisActivation.has(reloadVersion) || promptInFlightVersion === reloadVersion) {
      logCheckResult(reason, "skip", installedVersion, acceptedVersion, reloadVersion, "already-prompted")
      return
    }

    promptInFlightVersion = reloadVersion
    promptedVersionsThisActivation.add(reloadVersion)
    try {
      logCheckResult(reason, "prompt", installedVersion, acceptedVersion, reloadVersion)
      await context.globalState.update(EXTENSION_UPDATE_RELOAD_PROMPT_KEY, reloadVersion)
      const selected = await vscode.window.showInformationMessage(
        `ChipMate 已更新到 ${reloadVersion}，重新加载窗口后新版本会生效。`,
        RELOAD_WINDOW_ACTION,
      )
      if (selected === RELOAD_WINDOW_ACTION) {
        appendUpdateReloadLog(`event=prompt-selection reason=${reason} reloadVersion=${reloadVersion} selected=reload`)
        await context.globalState.update(EXTENSION_UPDATE_RELOAD_ACCEPTED_KEY, reloadVersion)
        await rememberActivatedVersion()
        appendUpdateReloadLog(`event=reload-command reason=${reason} reloadVersion=${reloadVersion}`)
        await vscode.commands.executeCommand("workbench.action.reloadWindow")
      } else {
        appendUpdateReloadLog(`event=prompt-selection reason=${reason} reloadVersion=${reloadVersion} selected=dismissed`)
      }
    } finally {
      if (promptInFlightVersion === reloadVersion) promptInFlightVersion = undefined
    }
  }
  const runScheduledReloadPromptCheck = (reason: string) => {
    void checkForInstalledUpdate(reason).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[update-reload] event=check-failed reason=${reason} message=${message}`)
    })
  }
  const scheduleDelayedReloadPromptCheck = (reason: string, delayMs: number) => {
    const existing = retryTimers.get(reason)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      retryTimers.delete(reason)
      runScheduledReloadPromptCheck(reason)
    }, delayMs)
    retryTimers.set(reason, timer)
  }
  const scheduleReloadPromptCheck = (reason: string) => {
    runScheduledReloadPromptCheck(reason)
    if (reason !== "extensions-changed") return
    for (const delayMs of EXTENSION_UPDATE_RELOAD_RETRY_DELAYS_MS) {
      scheduleDelayedReloadPromptCheck(`retry-${delayMs}ms`, delayMs)
    }
  }

  appendUpdateReloadLog(`event=registered extensionId=${updateReloadLogValue(extensionId)} runningVersion=${updateReloadLogValue(runningVersion)} previousActivatedVersion=${updateReloadLogValue(previousActivatedVersion)}`)
  context.subscriptions.push(vscode.extensions.onDidChange(() => {
    appendUpdateReloadLog(`event=extensions-changed extensionId=${updateReloadLogValue(extensionId)} runningVersion=${updateReloadLogValue(runningVersion)}`)
    scheduleReloadPromptCheck("extensions-changed")
  }))
  context.subscriptions.push(new vscode.Disposable(() => {
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
  }))
  scheduleReloadPromptCheck("activation")
}

function readPackageJsonVersion(packageJSON: unknown) {
  if (!packageJSON || typeof packageJSON !== "object" || !("version" in packageJSON)) return undefined
  const version = (packageJSON as { version?: unknown }).version
  return typeof version === "string" && version.trim() ? version.trim() : undefined
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
