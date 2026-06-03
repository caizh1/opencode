import * as vscode from "vscode"
import { buildCompletionEditResult, type CompletionEdit, type CompletionEditInput, type CompletionRange } from "./completion-edit"
import { completionFormatCommand } from "./completion-format-command"
import { inferCompletionIndent } from "./completion-indent"
import { CompletionModelClient, completionModel } from "./completion-model-client"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "./completion-request-coordinator"
import { INLINE_COMPLETION_SESSION_TITLE } from "./completion-session"
import { completionInsertText } from "./completion-text"
import { buildCompletionPrompt, buildQwenCoderFimPrompt, relativePath } from "./context"
import { resolveRequestAgent } from "./local-agent"
import { isSessionNotFoundError, parseModel, RemoteOpenCodeClient } from "./remote-client"
import type { OpenCodeMessage, RemoteSettings } from "./types"

type CompletionDeps = {
  getClient: () => RemoteOpenCodeClient | undefined
  getCompletionApiKey?: () => Promise<string | undefined>
  getSettings: () => RemoteSettings
  output: vscode.OutputChannel
}

export class RemoteCompletionProvider implements vscode.InlineCompletionItemProvider {
  private sessionID?: string
  private readonly requests: CompletionRequestCoordinator

  constructor(private readonly deps: CompletionDeps) {
    this.requests = new CompletionRequestCoordinator({
      logInfo: (message) => this.logInfo(this.deps.getSettings(), message),
    })
  }

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

    const lineText = document.lineAt(position.line).text
    const line = lineText.slice(0, position.character)
    const lineSuffix = lineText.slice(position.character)
    const currentWord = currentWordBeforeCursor(line, position.line)
    if (!line.trim() && position.character === 0) {
      this.logDebug(settings, `skip: empty line at column 0 ${requestDetails(document, position, settings)}`)
      return
    }

    const started = Date.now()
    const details = requestDetails(document, position, settings)
    const client = this.deps.getClient()
    if (settings.completion.provider === "opencode" && !client) {
      this.logDebug(settings, `skip: no active remote client ${details}`)
      return
    }
    if (settings.completion.provider === "openai-compatible") {
      if (!settings.completion.apiBaseUrl) {
        this.logDebug(settings, `skip: direct completion API base URL is not configured ${details}`)
        return
      }
      if (!completionModel(settings)) {
        this.logDebug(settings, `skip: direct completion model is not configured ${details}`)
        return
      }
    }

    this.logInfo(settings, `triggered ${details}`)
    const indent = inferCompletionIndent({
      lines: documentLines(document),
      line: position.line,
      linePrefix: line,
      fallbackIndentUnit: fallbackIndentUnitForDocument(document),
    })
    const editInput = {
      languageId: document.languageId,
      linePrefix: line,
      lineSuffix,
      position: { line: position.line, character: position.character },
      indent,
      currentWord: currentWord?.text,
      currentWordRange: currentWord?.range,
    }
    const localFallback = buildCompletionEditResult({ text: "", ...editInput }).edit
    const start = this.requests.request({
      key: completionRequestKey(document, position, lineText, settings),
      details,
      debounceMs: settings.completion.debounceMs,
      localFallback,
      runRemote: (signal) =>
        settings.completion.provider === "openai-compatible"
          ? this.directCompletionOutcome({
              document,
              position,
              settings,
              details,
              started,
              signal,
              editInput,
            })
          : this.remoteCompletionOutcome({
              client: client!,
              document,
              position,
              settings,
              details,
              started,
              signal,
              editInput,
            }),
      onRemoteReady: () => this.triggerInlineSuggestRefresh(document, position, settings, details),
    })

    if (start.immediate?.edit) {
      this.logReturned(settings, start.immediate.source, start.immediate.edit, details, started)
      return [this.inlineItem(start.immediate.edit, document)]
    }

    if (!start.pending) return

    const outcome = await waitForOutcome(start.pending, token)
    if (!outcome) {
      this.logInfo(settings, `cancelled reason=vscode-token ${details} elapsedMs=${elapsedMs(started)}`)
      return
    }
    if (!outcome.edit) return

    this.logReturned(settings, outcome.source, outcome.edit, details, started)
    return [this.inlineItem(outcome.edit, document)]
  }

  private async remoteCompletionOutcome(input: {
    client: RemoteOpenCodeClient
    document: vscode.TextDocument
    position: vscode.Position
    settings: RemoteSettings
    details: string
    started: number
    signal: AbortSignal
    editInput: Omit<CompletionEditInput, "text">
  }): Promise<CompletionRequestOutcome> {
    try {
      const prompt = await buildCompletionPrompt({
        document: input.document,
        position: input.position,
        settings: input.settings,
      })
      return await this.completionOutcomeWithRetry({
        prompt,
        settings: input.settings,
        details: input.details,
        started: input.started,
        editInput: input.editInput,
        sendPrompt: (promptText) => this.sendCompletion(input.client, promptText, input.settings, input.signal),
      })
    } catch (error) {
      if (input.signal.aborted) {
        return { reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      return { reason: "remote-error", source: "remote" }
    }
  }

  private async directCompletionOutcome(input: {
    document: vscode.TextDocument
    position: vscode.Position
    settings: RemoteSettings
    details: string
    started: number
    signal: AbortSignal
    editInput: Omit<CompletionEditInput, "text">
  }): Promise<CompletionRequestOutcome> {
    try {
      const prompt = input.settings.completion.profile === "qwen-coder-fim"
        ? buildQwenCoderFimPrompt({
            document: input.document,
            position: input.position,
            settings: input.settings,
          })
        : await buildCompletionPrompt({
            document: input.document,
            position: input.position,
            settings: input.settings,
            transport: "openai-compatible",
          })
      const apiKey = await this.deps.getCompletionApiKey?.()
      const client = new CompletionModelClient(input.settings, apiKey)
      return await this.completionOutcomeWithRetry({
        prompt,
        settings: input.settings,
        details: input.details,
        started: input.started,
        editInput: input.editInput,
        sendPrompt: (promptText) => client.complete({ prompt: promptText, signal: input.signal }),
      })
    } catch (error) {
      if (input.signal.aborted) {
        return { reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      return { reason: "remote-error", source: "remote" }
    }
  }

  private async completionOutcomeWithRetry(input: {
    prompt: string
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    sendPrompt: (prompt: string) => Promise<OpenCodeMessage | undefined>
  }): Promise<CompletionRequestOutcome> {
    this.logInfo(input.settings, `sent ${input.details}`)
    const response = await input.sendPrompt(input.prompt)
    this.logInfo(input.settings, `received ${input.details} elapsedMs=${elapsedMs(input.started)}`)

    const initial = this.completionOutcomeFromResponse({
      response,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      attempt: "initial",
    })
    if (initial.edit || initial.reason !== "misaligned-leading-newline" || completionTextProfile(input.settings) === "qwen-coder-fim") return initial

    const retryPrompt = completionRetryPrompt(input.prompt, input.editInput)
    this.logInfo(input.settings, `retry-sent reason=${initial.reason} ${input.details}`)
    const retryResponse = await input.sendPrompt(retryPrompt)
    this.logInfo(input.settings, `retry-received reason=${initial.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
    return this.completionOutcomeFromResponse({
      response: retryResponse,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      attempt: "retry",
    })
  }

  private completionOutcomeFromResponse(input: {
    response: OpenCodeMessage | undefined
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    attempt: "initial" | "retry"
  }): CompletionRequestOutcome {
    const visibleText = completionInsertText(input.response, completionTextProfile(input.settings))
    if (!visibleText) {
      if (input.attempt === "retry") {
        this.logInfo(
          input.settings,
          `retry-edit-rejected reason=filtered-or-no-visible-text ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      } else {
        this.logInfo(
          input.settings,
          `empty reason=filtered-or-no-visible-text ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      }
      return { reason: "filtered-or-no-visible-text", source: "remote" }
    }

    const result = buildCompletionEditResult({
      text: visibleText,
      ...input.editInput,
    })
    const edit = result.edit
    if (!edit) {
      if (input.attempt === "retry") {
        this.logInfo(
          input.settings,
          `retry-edit-rejected reason=${result.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      } else {
        this.logInfo(
          input.settings,
          `edit-rejected reason=${result.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      }
      return { reason: result.reason, source: "remote" }
    }

    if (input.attempt === "retry") {
      this.logInfo(input.settings, `retry-edit-ready ${editDetails(edit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${edit.insertText.length}`)
    } else {
      this.logInfo(input.settings, `edit-ready ${editDetails(edit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${edit.insertText.length}`)
    }
    this.logDebug(input.settings, `edit ${editDetails(edit)} visibleChars=${visibleText.length} ${input.details}`)
    return { edit, source: "remote" }
  }

  private async getSession(client: RemoteOpenCodeClient, signal: AbortSignal) {
    if (this.sessionID) return this.sessionID
    const session = await client.createSession(INLINE_COMPLETION_SESSION_TITLE, signal)
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
    const agentSelection = await resolveRequestAgent(client, settings, signal)
    const sessionID = await this.getSession(client, signal)
    return client.sendMessage({
      sessionID,
      text: prompt,
      model: parseModel(settings.defaultModel),
      agent: agentSelection.agent,
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

  private logReturned(
    settings: RemoteSettings,
    source: "cache" | "local-fallback" | "remote",
    edit: CompletionEdit,
    details: string,
    started: number,
  ) {
    this.logDebug(settings, `edit ${editDetails(edit)} ${details}`)
    this.logInfo(settings, `returned source=${source} ${editDetails(edit)} ${details} elapsedMs=${elapsedMs(started)} chars=${edit.insertText.length}`)
  }

  private triggerInlineSuggestRefresh(
    document: vscode.TextDocument,
    position: vscode.Position,
    settings: RemoteSettings,
    details: string,
  ) {
    const active = vscode.window.activeTextEditor
    if (!active || active.document.uri.toString() !== document.uri.toString()) return
    if (!active.selection.active.isEqual(position)) return

    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(
      () => this.logDebug(settings, `refresh-inline-suggest ${details}`),
      (error: unknown) => this.logDebug(settings, `refresh-inline-suggest failed=${formatError(error)} ${details}`),
    )
  }

  private inlineItem(edit: CompletionEdit, document: vscode.TextDocument) {
    const range = edit.replaceRange
      ? new vscode.Range(
          edit.replaceRange.startLine,
          edit.replaceRange.startCharacter,
          edit.replaceRange.endLine,
          edit.replaceRange.endCharacter,
        )
      : undefined
    const command = edit.formatRange ? completionFormatCommand(document.uri, edit.formatRange) : undefined
    const item = new vscode.InlineCompletionItem(edit.insertText, range, command)
    if (edit.filterText) item.filterText = edit.filterText
    return item
  }
}

function completionRetryPrompt(prompt: string, editInput: Omit<CompletionEditInput, "text">) {
  const currentLine = truncateFeedback(`${editInput.linePrefix}${editInput.lineSuffix}`)
  const cursorPrefix = truncateFeedback(editInput.linePrefix)
  return [
    prompt,
    "",
    "<completion-feedback>",
    `Previous completion was rejected because it began with blank lines and did not continue the current line "${quoteLogValue(currentLine)}".`,
    `The cursor is after the prefix "${quoteLogValue(cursorPrefix)}".`,
    "Return only text that continues or replaces the cursor context, or return empty.",
    "</completion-feedback>",
  ].join("\n")
}

function completionRequestKey(document: vscode.TextDocument, position: vscode.Position, lineText: string, settings: RemoteSettings) {
  return [
    document.uri.toString(),
    document.languageId,
    settings.completion.provider,
    settings.completion.profile,
    settings.completion.provider === "openai-compatible" ? document.version : "",
    position.line,
    position.character,
    lineText,
  ].join("\u0000")
}

function waitForOutcome(
  pending: Promise<CompletionRequestOutcome>,
  token: vscode.CancellationToken,
): Promise<CompletionRequestOutcome | undefined> {
  if (token.isCancellationRequested) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    const listener = token.onCancellationRequested(() => {
      listener.dispose()
      resolve(undefined)
    })
    pending.then(
      (outcome) => {
        listener.dispose()
        resolve(outcome)
      },
      () => {
        listener.dispose()
        resolve({ reason: "provider-wait-error", source: "remote" })
      },
    )
  })
}

function requestDetails(document: vscode.TextDocument, position: vscode.Position, settings: RemoteSettings) {
  const model = settings.completion.provider === "openai-compatible"
    ? completionModel(settings) || "direct-model-missing"
    : settings.defaultModel.trim() || "server-default"
  return [
    `path="${quoteLogValue(relativePath(document.uri))}"`,
    `line=${position.line + 1}`,
    `character=${position.character + 1}`,
    `provider=${settings.completion.provider}`,
    `profile=${settings.completion.profile}`,
    `model="${quoteLogValue(model)}"`,
    `debounceMs=${settings.completion.debounceMs}`,
  ].join(" ")
}

function elapsedMs(started: number) {
  return Date.now() - started
}

function completionTextProfile(settings: RemoteSettings) {
  return settings.completion.provider === "openai-compatible" ? settings.completion.profile : "generic-chat"
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function quoteLogValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function fallbackIndentUnitForDocument(document: vscode.TextDocument) {
  const editor = editorForDocument(document)
  const config = vscode.workspace.getConfiguration("editor", document.uri)
  const insertSpaces = editor?.options.insertSpaces ?? config.get<boolean | string>("insertSpaces", true)
  if (insertSpaces === false || insertSpaces === "false") return "\t"

  const tabSize = editor?.options.tabSize ?? config.get<number | string>("tabSize", 4)
  const size = typeof tabSize === "number" ? tabSize : Number(tabSize)
  if (!Number.isFinite(size) || size <= 0) return "    "
  return " ".repeat(Math.floor(size))
}

function editorForDocument(document: vscode.TextDocument) {
  const active = vscode.window.activeTextEditor
  if (active?.document.uri.toString() === document.uri.toString()) return active
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString())
}

function documentLines(document: vscode.TextDocument) {
  const lines: string[] = []
  for (let line = 0; line < document.lineCount; line++) {
    lines.push(document.lineAt(line).text)
  }
  return lines
}

function currentWordBeforeCursor(linePrefix: string, line: number): { text: string; range: CompletionRange } | undefined {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)
  if (!match) return
  const text = match[0]
  const startCharacter = linePrefix.length - text.length
  return {
    text,
    range: {
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter: linePrefix.length,
    },
  }
}

function editDetails(edit: CompletionEdit) {
  return [
    `range=${edit.replaceRange ? rangeLogValue(edit.replaceRange) : "insert"}`,
    `filterText="${quoteLogValue(truncateLine(edit.filterText ?? ""))}"`,
    `firstLine="${quoteLogValue(truncateLine(edit.insertText.split(/\r?\n/)[0] ?? ""))}"`,
    ...(edit.normalized ? [`normalized=${edit.normalized}`] : []),
  ].join(" ")
}

function rangeLogValue(range: CompletionRange) {
  return `${range.startLine + 1}:${range.startCharacter + 1}-${range.endLine + 1}:${range.endCharacter + 1}`
}

function truncateLine(input: string) {
  if (input.length <= 80) return input
  return `${input.slice(0, 77)}...`
}

function truncateFeedback(input: string) {
  if (input.length <= 160) return input
  return `${input.slice(0, 157)}...`
}
