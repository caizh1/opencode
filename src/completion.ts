import * as vscode from "vscode"
import { buildCompletionPrompt, relativePath } from "./context"
import { isSessionNotFoundError, messageText, parseModel, RemoteOpenCodeClient } from "./remote-client"
import type { RemoteSettings } from "./types"

type CompletionDeps = {
  getClient: () => RemoteOpenCodeClient | undefined
  getSettings: () => RemoteSettings
  output: vscode.OutputChannel
}

export class RemoteCompletionProvider implements vscode.InlineCompletionItemProvider {
  private abort?: AbortController
  private sessionID?: string
  private readonly cache = new Map<string, string>()

  constructor(private readonly deps: CompletionDeps) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = this.deps.getSettings()
    if (!settings.completion.enabled) {
      this.logDebug(settings, "skip: completion disabled")
      return
    }
    if (document.uri.scheme !== "file") {
      this.logDebug(settings, `skip: non-file document uri=${document.uri.toString()}`)
      return
    }

    const client = this.deps.getClient()
    if (!client) {
      this.logDebug(settings, `skip: no active remote client ${requestDetails(document, position, settings)}`)
      return
    }

    const line = document.lineAt(position.line).text.slice(0, position.character)
    if (!line.trim() && position.character === 0) {
      this.logDebug(settings, `skip: empty line at column 0 ${requestDetails(document, position, settings)}`)
      return
    }

    const key = `${document.uri.toString()}:${position.line}:${position.character}:${line}`
    const cached = this.cache.get(key)
    if (cached) {
      this.logDebug(settings, `cache hit ${requestDetails(document, position, settings)} chars=${cached.length}`)
      return [new vscode.InlineCompletionItem(cached)]
    }

    const started = Date.now()
    let phase = "debounce"
    const details = requestDetails(document, position, settings)
    this.logInfo(settings, `triggered ${details}`)
    await delay(settings.completion.debounceMs)
    if (token.isCancellationRequested) {
      this.logDebug(settings, `cancelled during debounce ${details} elapsedMs=${elapsedMs(started)}`)
      return
    }

    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    const cancellationListener = token.onCancellationRequested(() => abort.abort())

    try {
      phase = "prompt"
      const prompt = await buildCompletionPrompt({ document, position, settings })
      phase = "request"
      this.logInfo(settings, `sent ${details}`)
      const response = await this.sendCompletion(client, prompt, settings, abort.signal)
      phase = "response"
      const insertText = cleanupCompletion(messageText(response))
      if (!insertText) {
        this.logInfo(settings, `empty ${details} elapsedMs=${elapsedMs(started)}`)
        return
      }
      this.cache.set(key, insertText)
      if (this.cache.size > 100) {
        const first = this.cache.keys().next().value
        if (first) this.cache.delete(first)
      }
      this.logInfo(settings, `done ${details} elapsedMs=${elapsedMs(started)} chars=${insertText.length}`)
      return [new vscode.InlineCompletionItem(insertText)]
    } catch (error) {
      if (abort.signal.aborted || token.isCancellationRequested) {
        this.logInfo(settings, `cancelled phase=${phase} ${details} elapsedMs=${elapsedMs(started)}`)
      } else {
        this.logInfo(settings, `Completion failed: ${formatError(error)} ${details} elapsedMs=${elapsedMs(started)}`)
      }
      return
    } finally {
      cancellationListener.dispose()
    }
  }

  private async getSession(client: RemoteOpenCodeClient, signal: AbortSignal) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession("VS Code inline completion", signal)
    this.sessionID = session.id
    return session.id
  }

  private async sendCompletion(
    client: RemoteOpenCodeClient,
    prompt: string,
    settings: RemoteSettings,
    signal: AbortSignal,
  ) {
    try {
      return await this.sendCompletionWithSession(client, prompt, settings, signal)
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      this.sessionID = undefined
      this.deps.output.appendLine("Completion session was not found; retrying with a new session.")
      return this.sendCompletionWithSession(client, prompt, settings, signal)
    }
  }

  private async sendCompletionWithSession(
    client: RemoteOpenCodeClient,
    prompt: string,
    settings: RemoteSettings,
    signal: AbortSignal,
  ) {
    const sessionID = await this.getSession(client, signal)
    return client.sendMessage({
      sessionID,
      text: prompt,
      model: parseModel(settings.defaultModel),
      agent: settings.defaultAgent || undefined,
      signal,
    })
  }

  private logInfo(settings: RemoteSettings, message: string) {
    if (settings.completion.logLevel === "off") return
    this.deps.output.appendLine(`[completion] ${message}`)
  }

  private logDebug(settings: RemoteSettings, message: string) {
    if (settings.completion.logLevel !== "debug") return
    this.deps.output.appendLine(`[completion] ${message}`)
  }
}

function cleanupCompletion(input: string) {
  let text = input.trim()
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "")
  text = text.replace(/^Here is.*?:\s*/i, "")
  return text
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestDetails(document: vscode.TextDocument, position: vscode.Position, settings: RemoteSettings) {
  const model = settings.defaultModel.trim() || "server-default"
  return [
    `path="${quoteLogValue(relativePath(document.uri))}"`,
    `line=${position.line + 1}`,
    `character=${position.character + 1}`,
    `model="${quoteLogValue(model)}"`,
    `debounceMs=${settings.completion.debounceMs}`,
  ].join(" ")
}

function elapsedMs(started: number) {
  return Date.now() - started
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function quoteLogValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
