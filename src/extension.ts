import * as vscode from "vscode"
import { RemoteChatViewProvider } from "./chat-view"
import { LocalAnalysisBridge } from "./analysis-bridge"
import { LocalCodeGraphService } from "./codegraph-service"
import { RemoteCompletionProvider } from "./completion"
import { registerCompletionFormatCommand } from "./completion-format-command"
import { addPickedFilesToContext, LocalContextStore } from "./context"
import { EditorContextTracker } from "./editor-context"
import { registerLocalTerminalCommands } from "./local-terminal"
import { RemoteOpenCodeAuthError, RemoteOpenCodeClient } from "./remote-client"
import {
  promptAndSaveCompletionApiKey,
  promptAndSaveConnectionSettings,
  promptAndSaveRagApiKey,
  readCompletionApiKey,
  readRagApiKey,
  readRemotePassword,
  readRemoteSettings,
  saveConnectionSettings,
  settingsFromConnectionInput,
  type ConnectionSettingsInput,
} from "./settings"
import type { ConnectionState } from "./types"

let client: RemoteOpenCodeClient | undefined
const CONNECTION_TEST_TIMEOUT_MS = 8000
const RAG_CONFIG_REFRESH_DEBOUNCE_MS = 500

type ConnectionProbeResult =
  | { ok: true; detail: string }
  | { ok: false; state: "authFailed" | "error"; message: string }

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("OpenCode Remote")
  const contextStore = new LocalContextStore()
  const editorContextTracker = new EditorContextTracker()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = "opencode.remote.openChat"
  context.subscriptions.push(output, status, editorContextTracker)

  let activeConnectionState: ConnectionState = "disconnected"
  const setConnectionState = (state: ConnectionState, detail = "") => {
    activeConnectionState = state
    updateStatus(status, state, detail)
    chatProvider.setConnectionState(state, detail)
  }

  const getSettings = () => readRemoteSettings()
  const getClient = () => client
  const clearClient = (target: RemoteOpenCodeClient) => {
    if (client === target) client = undefined
  }
  const createClient = async () => {
    const settings = readRemoteSettings()
    const password = await readRemotePassword(context)
    return new RemoteOpenCodeClient(settings, password)
  }
  const connectClient = async (next: RemoteOpenCodeClient, beforeRefresh?: () => Promise<void>) => {
    output.appendLine(`[connect] Connecting to ${next.baseUrl}`)
    setConnectionState("connecting", `Connecting to ${next.baseUrl}`)
    const started = Date.now()
    const result = await probeClient(next, CONNECTION_TEST_TIMEOUT_MS)
    output.appendLine(`[connect] health ${Date.now() - started}ms`)
    if (!result.ok) {
      output.appendLine(result.message)
      setConnectionState(result.state, result.message)
      return false
    }

    await beforeRefresh?.()
    client = next
    setConnectionState("connected", result.detail)
    output.appendLine(`[connection] Connected to ${next.baseUrl}`)
    vscode.window.setStatusBarMessage("Connected to remote OpenCode", 2000)
    void chatProvider.refresh().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[refresh] background refresh failed: ${message}`)
    })
    return true
  }
  const testClientOnly = async (target: RemoteOpenCodeClient) => {
    const previousState = activeConnectionState
    output.appendLine(`[test] Testing ${target.baseUrl}`)
    const result = await probeClient(target, CONNECTION_TEST_TIMEOUT_MS)
    if (result.ok) {
      const message = `Test succeeded for ${target.baseUrl}. Click Connect to use this server.`
      output.appendLine(`[test] ${message}`)
      setConnectionState(previousState, message)
      return true
    }

    const message = `Test failed for ${target.baseUrl}: ${result.message}`
    output.appendLine(`[test] ${message}`)
    setConnectionState(previousState, message)
    return false
  }

  const connect = async () => {
    const saved = await promptAndSaveConnectionSettings(context)
    if (!saved) return
    const next = await createClient()
    await connectClient(next)
  }
  const connectWithSettings = async (input: ConnectionSettingsInput) => {
    const settings = settingsFromConnectionInput(input)
    const next = new RemoteOpenCodeClient(settings, input.password?.trim() || undefined)
    await connectClient(next, () => saveConnectionSettings(context, input))
  }
  const testWithSettings = async (input: ConnectionSettingsInput) => {
    const settings = settingsFromConnectionInput(input)
    const testClientInstance = new RemoteOpenCodeClient(settings, input.password?.trim() || undefined)
    await testClientOnly(testClientInstance)
  }

  let chatProvider: RemoteChatViewProvider
  const codeGraph = new LocalCodeGraphService(context, output, getSettings, () => readRagApiKey(context), () => chatProvider?.refreshCodeGraphStatus())
  context.subscriptions.push(codeGraph)
  let ragConfigurationApplyTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRagConfigurationApply = () => {
    if (ragConfigurationApplyTimer) clearTimeout(ragConfigurationApplyTimer)
    ragConfigurationApplyTimer = setTimeout(() => {
      ragConfigurationApplyTimer = undefined
      void codeGraph.applyRagConfiguration().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[rag] configuration apply failed: ${message}`)
      })
    }, RAG_CONFIG_REFRESH_DEBOUNCE_MS)
  }
  context.subscriptions.push(new vscode.Disposable(() => {
    if (ragConfigurationApplyTimer) clearTimeout(ragConfigurationApplyTimer)
  }))
  const analysisBridge = new LocalAnalysisBridge(
    output,
    (input) => codeGraph.runAnalysisTool(input),
    () => getSettings().analysis.bridgeEnabled,
  )
  context.subscriptions.push(analysisBridge)

  chatProvider = new RemoteChatViewProvider({
    output,
    contextStore,
    codeGraph,
    getClient,
    getSettings,
    getEditorContext: () => editorContextTracker.snapshot(),
    getCompletionApiKey: () => readCompletionApiKey(context),
    promptCompletionApiKey: async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) vscode.window.setStatusBarMessage("Inline completion API key saved", 2000)
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
    clearClient,
    openOutput: () => output.show(true),
  })
  context.subscriptions.push(chatProvider)

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opencode.remote.rag")) return
      scheduleRagConfigurationApply()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.remote.connect", connect),
    vscode.commands.registerCommand("opencode.remote.disconnect", async () => {
      client = undefined
      setConnectionState("disconnected")
      await chatProvider.refresh()
    }),
    vscode.commands.registerCommand("opencode.remote.testConnection", async () => {
      const next = await createClient()
      await testClientOnly(next)
    }),
    vscode.commands.registerCommand("opencode.remote.completion.setApiKey", async () => {
      const saved = await promptAndSaveCompletionApiKey(context)
      if (saved) {
        vscode.window.setStatusBarMessage("Inline completion API key saved", 2000)
        chatProvider.refreshState()
      }
    }),
    vscode.commands.registerCommand("opencode.remote.openChat", async () => {
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("opencode.remote.newSession", async () => {
      await chatProvider.reveal()
      await chatProvider.newSession()
    }),
    vscode.commands.registerCommand("opencode.remote.askSelection", async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask OpenCode about selection",
        prompt: "Question to send with the current selection.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeSelection: true, includeCurrentFile: false })
    }),
    vscode.commands.registerCommand("opencode.remote.askCurrentFile", async () => {
      const text = await vscode.window.showInputBox({
        title: "Ask OpenCode about current file",
        prompt: "Question to send with the current file context.",
        ignoreFocusOut: true,
      })
      if (!text) return
      await chatProvider.sendQuickQuestion(text, { includeCurrentFile: true })
    }),
    vscode.commands.registerCommand("opencode.remote.addFileToContext", async () => {
      const tracked = editorContextTracker.snapshot()
      const addedTracked = Boolean(tracked?.uri.scheme === "file")
      if (tracked?.uri.scheme === "file") contextStore.add(tracked.uri)
      if (!addedTracked) await addPickedFilesToContext(contextStore)
      vscode.window.setStatusBarMessage("Added file to OpenCode context", 2000)
    }),
    vscode.commands.registerCommand("opencode.remote.clearContext", async () => {
      contextStore.clear()
      vscode.window.setStatusBarMessage("Cleared OpenCode context", 2000)
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.index", async () => {
      await codeGraph.indexWorkspace(false)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.rebuild", async () => {
      await codeGraph.indexWorkspace(true)
      await chatProvider.reveal()
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.pause", async () => {
      codeGraph.pauseIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.resume", async () => {
      codeGraph.resumeIndexing()
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.cancel", async () => {
      codeGraph.cancelIndexing("requested from command palette")
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.benchmark", async () => {
      await codeGraph.benchmarkSyntheticRepository(1000)
      await codeGraph.showStatus()
    }),
    vscode.commands.registerCommand("opencode.remote.codeGraph.status", async () => {
      await codeGraph.showStatus()
    }),
  )

  try {
    registerLocalTerminalCommands(context)
  } catch (error) {
    reportActivationError(output, "Failed to register local terminal commands", error)
  }

  registerCompletionFormatCommand(context, output)

  updateStatus(status, "disconnected")
  status.show()

  try {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RemoteChatViewProvider.viewType, chatProvider))
  } catch (error) {
    reportActivationError(output, "Failed to register OpenCode Remote chat view", error)
  }

  try {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: "file" },
        new RemoteCompletionProvider({ getClient, getCompletionApiKey: () => readCompletionApiKey(context), getSettings, output }),
      ),
    )
  } catch (error) {
    reportActivationError(output, "Failed to register OpenCode Remote inline completion", error)
  }

  client = undefined
  setConnectionState("disconnected", "Ready. Enter a server URL and click Connect.")
  void analysisBridge.ensureStarted().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[analysis-bridge] failed to start: ${message}`)
  })
  void codeGraph.maybePromptAndIndex()
}

export function deactivate() {
  client = undefined
}

async function probeClient(target: RemoteOpenCodeClient, timeoutMs: number): Promise<ConnectionProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const health = await target.health(controller.signal)
    if (health.healthy === false) {
      return {
        ok: false,
        state: "error",
        message: "Remote OpenCode health check returned unhealthy.",
      }
    }
    return {
      ok: true,
      detail: health.version ? `version ${health.version}` : "",
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        state: "error",
        message: `Connection timed out after ${timeoutMs}ms (${target.baseUrl})`,
      }
    }
    if (error instanceof RemoteOpenCodeAuthError) {
      return {
        ok: false,
        state: "authFailed",
        message: error.message,
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      state: "error",
      message,
    }
  } finally {
    clearTimeout(timer)
  }
}

function updateStatus(status: vscode.StatusBarItem, state: ConnectionState, detail = "") {
  switch (state) {
    case "connected":
      status.text = "$(plug) OpenCode: Connected"
      status.tooltip = detail || "Remote OpenCode connected"
      status.backgroundColor = undefined
      break
    case "connecting":
      status.text = "$(sync~spin) OpenCode: Connecting"
      status.tooltip = detail || "Connecting to remote OpenCode"
      status.backgroundColor = undefined
      break
    case "authFailed":
      status.text = "$(warning) OpenCode: Auth Failed"
      status.tooltip = detail || "Remote OpenCode authentication failed"
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      break
    case "error":
      status.text = "$(error) OpenCode: Error"
      status.tooltip = detail || "Remote OpenCode connection error"
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
      break
    case "disconnected":
      status.text = "$(circle-slash) OpenCode: Disconnected"
      status.tooltip = detail || "Click to open OpenCode Remote and connect a server"
      status.backgroundColor = undefined
      break
  }
}

function reportActivationError(output: vscode.OutputChannel, title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  output.appendLine(`${title}: ${message}`)
  void vscode.window.showErrorMessage(`${title}. See the OpenCode Remote output for details.`)
}
