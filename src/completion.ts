import * as vscode from "vscode"
import type { CodeGraphContextProvider } from "./codegraph-types"
import { buildCompletionEditResult, buildInlineCompletionEditResult, type CompletionEdit, type CompletionEditInput, type CompletionRange } from "./completion-edit"
import { completionFormatCommand } from "./completion-format-command"
import { completionContextDebugSummary, type CompletionContextPack } from "./completion-context"
import { inferCompletionIndent } from "./completion-indent"
import { CompletionModelClient, completionModel } from "./completion-model-client"
import { postprocessCompletion } from "./completion-postprocess"
import { planCompletion } from "./completion-plan"
import { routeCompletionModel, routeLogValue, type CompletionModelRoute } from "./completion-router"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "./completion-request-coordinator"
import { INLINE_COMPLETION_SESSION_TITLE } from "./completion-session"
import { resolveSymbols, symbolCandidateFromCodeGraph, type ResolvedSymbolCandidate } from "./completion-symbol"
import { completionTelemetryRoute, createCompletionRequestId, filePathHash, serializeCompletionDebugEvent, type CompletionDebugEvent, type CompletionTelemetryDraft } from "./completion-telemetry"
import { fallbackCompletionText } from "./completion-test-fallback"
import { completionInsertText } from "./completion-text"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"
import { buildCompletionPrompt, buildQwenCoderFimPrompt, relativePath } from "./context"
import { resolveRequestAgent } from "./local-agent"
import { isSessionNotFoundError, parseModel, RemoteOpenCodeClient } from "./remote-client"
import type { CompletionProfile, OpenCodeMessage, RemoteSettings } from "./types"

type CompletionDeps = {
  getClient: () => RemoteOpenCodeClient | undefined
  getCompletionApiKey?: () => Promise<string | undefined>
  getSettings: () => RemoteSettings
  codeGraph?: CodeGraphContextProvider
  output: vscode.OutputChannel
}

type ModelCompletionRoute = Extract<CompletionModelRoute, { kind: "model" }>
type DeterministicSymbolRoute = Extract<CompletionModelRoute, { kind: "deterministic-symbol" }>
type CompletionLatencyKey = Exclude<keyof CompletionDebugEvent["latencyMs"], "total">

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
    const requestId = createCompletionRequestId()
    if (!settings.completion.enabled) {
      this.logDebug(settings, `skip: completion disabled requestId=${requestId}`)
      return
    }
    if (document.uri.scheme !== "file") {
      this.logDebug(settings, `skip: non-file document uri=${document.uri.toString()} requestId=${requestId}`)
      return
    }

    const lineText = document.lineAt(position.line).text
    const line = lineText.slice(0, position.character)
    const lineSuffix = lineText.slice(position.character)
    const currentWord = currentWordBeforeCursor(line, position.line)
    const details = `${requestDetails(document, position, settings)} requestId=${requestId}`
    if (!line.trim() && position.character === 0) {
      this.logDebug(settings, `skip: empty line at column 0 ${details}`)
      return
    }

    const started = Date.now()
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
    const planningStarted = Date.now()
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
    const plan = planCompletion(editInput)
    const telemetry: CompletionTelemetryDraft = {
      requestId,
      languageId: document.languageId,
      filePathHash: filePathHash(document.uri.fsPath),
      triggerKind: completionTriggerKind(_context.triggerKind),
      planKind: plan.kind,
      insertMode: plan.insertMode,
      currentWord: currentWord?.text,
      targetSymbol: plan.targetSymbol,
      modelRoute: "none",
      accepted: false,
      latencyMs: {
        planning: elapsedMs(planningStarted),
        total: 0,
      },
    }
    if (plan.kind === "disabled") {
      this.logDebug(settings, `skip: disabled plan ${details}`)
      this.logCompletionTelemetry(settings, telemetry, started, false, "disabled-plan")
      return
    }

    const localFallback = buildCompletionEditResult({
      text: "",
      ...editInput,
      preferCurrentWordReplacement: plan.replaceCurrentWord,
    }).edit
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
              plan,
              telemetry,
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
              plan,
              telemetry,
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
    plan: CompletionPlan
    telemetry: CompletionTelemetryDraft
  }): Promise<CompletionRequestOutcome> {
    try {
      const symbolStarted = Date.now()
      const retrievedSnippets = await this.retrieveCompletionSnippets({
        document: input.document,
        settings: input.settings,
        details: input.details,
        plan: input.plan,
        editInput: input.editInput,
      })
      input.telemetry.latencyMs.symbol = elapsedMs(symbolStarted)
      input.telemetry.symbolCandidates = completionTelemetrySymbolCandidates(retrievedSnippets)
      const route = routeCompletionModel({
        plan: input.plan,
        settings: input.settings,
        retrievedSnippets,
      })
      input.telemetry.modelRoute = completionTelemetryRoute(route)
      this.logDebug(input.settings, `${routeLogValue(route)} ${input.details}`)
      if (route.kind === "deterministic-symbol") {
        return this.deterministicCompletionOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          editInput: input.editInput,
          plan: input.plan,
          retrievedSnippets,
          telemetry: input.telemetry,
        })
      }

      const contextStarted = Date.now()
      const prompt = await this.completionPromptForRoute({
        route,
        document: input.document,
        position: input.position,
        settings: input.settings,
        details: input.details,
        plan: input.plan,
        retrievedSnippets,
        telemetry: input.telemetry,
      })
      input.telemetry.latencyMs.context = elapsedMs(contextStarted)
      return await this.completionOutcomeWithRetry({
        prompt,
        settings: input.settings,
        details: input.details,
        started: input.started,
        editInput: input.editInput,
        plan: input.plan,
        retrievedSnippets,
        textProfile: route.textProfile,
        telemetry: input.telemetry,
        sendPrompt: (promptText) => this.sendCompletion(input.client, promptText, input.settings, input.signal),
      })
    } catch (error) {
      if (input.signal.aborted) {
        this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "cancelled")
        return { reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "remote-error")
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
    plan: CompletionPlan
    telemetry: CompletionTelemetryDraft
  }): Promise<CompletionRequestOutcome> {
    try {
      const symbolStarted = Date.now()
      const retrievedSnippets = await this.retrieveCompletionSnippets({
        document: input.document,
        settings: input.settings,
        details: input.details,
        plan: input.plan,
        editInput: input.editInput,
      })
      input.telemetry.latencyMs.symbol = elapsedMs(symbolStarted)
      input.telemetry.symbolCandidates = completionTelemetrySymbolCandidates(retrievedSnippets)
      const route = routeCompletionModel({
        plan: input.plan,
        settings: input.settings,
        retrievedSnippets,
      })
      input.telemetry.modelRoute = completionTelemetryRoute(route)
      this.logDebug(input.settings, `${routeLogValue(route)} ${input.details}`)
      if (route.kind === "deterministic-symbol") {
        return this.deterministicCompletionOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          editInput: input.editInput,
          plan: input.plan,
          retrievedSnippets,
          telemetry: input.telemetry,
        })
      }

      const contextStarted = Date.now()
      const prompt = await this.completionPromptForRoute({
        route,
        document: input.document,
        position: input.position,
        settings: input.settings,
        details: input.details,
        plan: input.plan,
        retrievedSnippets,
        transport: "openai-compatible",
        telemetry: input.telemetry,
      })
      input.telemetry.latencyMs.context = elapsedMs(contextStarted)
      const apiKey = await this.deps.getCompletionApiKey?.()
      const client = new CompletionModelClient(input.settings, apiKey)
      return await this.completionOutcomeWithRetry({
        prompt,
        settings: input.settings,
        details: input.details,
        started: input.started,
        editInput: input.editInput,
        plan: input.plan,
        retrievedSnippets,
        textProfile: route.textProfile,
        telemetry: input.telemetry,
        sendPrompt: (promptText) => client.complete({
          prompt: promptText,
          signal: input.signal,
          maxTokens: route.maxTokens,
          temperature: route.temperature,
          topP: route.topP,
          profile: route.modelProfile,
        }),
      })
    } catch (error) {
      if (input.signal.aborted) {
        this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "cancelled")
        return { reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "remote-error")
      return { reason: "remote-error", source: "remote" }
    }
  }

  private async completionPromptForRoute(input: {
    route: ModelCompletionRoute
    document: vscode.TextDocument
    position: vscode.Position
    settings: RemoteSettings
    details: string
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    transport?: "opencode" | "openai-compatible"
    telemetry: CompletionTelemetryDraft
  }) {
    const onContextPack = (pack: CompletionContextPack) => {
      input.telemetry.selectedContextBlocks = completionTelemetrySelectedContextBlocks(pack)
      input.telemetry.droppedContextBlocks = completionTelemetryDroppedContextBlocks(pack)
      this.logDebug(input.settings, `${completionContextDebugSummary(pack)} ${input.details}`)
    }

    if (input.route.promptKind === "qwen-fim") {
      return buildQwenCoderFimPrompt({
        document: input.document,
        position: input.position,
        settings: input.settings,
        plan: input.plan,
        retrievedSnippets: input.retrievedSnippets,
        onContextPack,
      })
    }

    return buildCompletionPrompt({
      document: input.document,
      position: input.position,
      settings: input.settings,
      transport: input.transport,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      onContextPack,
    })
  }

  private deterministicCompletionOutcome(input: {
    route: DeterministicSymbolRoute
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    telemetry: CompletionTelemetryDraft
  }): CompletionRequestOutcome {
    this.logInfo(input.settings, `deterministic-symbol reason=${input.route.reason} ${input.details}`)
    return this.completionOutcomeFromResponse({
      response: deterministicCompletionMessage(input.route.text),
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      attempt: "initial",
      textProfile: input.route.textProfile,
      telemetry: input.telemetry,
    })
  }

  private async completionOutcomeWithRetry(input: {
    prompt: string
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    retrievedSnippets?: RetrievedCompletionSnippet[]
    textProfile: CompletionProfile
    telemetry: CompletionTelemetryDraft
    sendPrompt: (prompt: string) => Promise<OpenCodeMessage | undefined>
  }): Promise<CompletionRequestOutcome> {
    this.logInfo(input.settings, `sent ${input.details}`)
    const modelStarted = Date.now()
    let response: OpenCodeMessage | undefined
    try {
      response = await input.sendPrompt(input.prompt)
    } finally {
      addCompletionTelemetryLatency(input.telemetry, "model", elapsedMs(modelStarted))
    }
    this.logInfo(input.settings, `received ${input.details} elapsedMs=${elapsedMs(input.started)}`)

    const initial = this.completionOutcomeFromResponse({
      response,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets ?? [],
      attempt: "initial",
      textProfile: input.textProfile,
      telemetry: input.telemetry,
    })
    if (initial.edit || initial.reason !== "misaligned-leading-newline" || input.textProfile === "qwen-coder-fim") return initial

    const retryPrompt = completionRetryPrompt(input.prompt, input.editInput)
    this.logInfo(input.settings, `retry-sent reason=${initial.reason} ${input.details}`)
    const retryModelStarted = Date.now()
    let retryResponse: OpenCodeMessage | undefined
    try {
      retryResponse = await input.sendPrompt(retryPrompt)
    } finally {
      addCompletionTelemetryLatency(input.telemetry, "model", elapsedMs(retryModelStarted))
    }
    this.logInfo(input.settings, `retry-received reason=${initial.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
    return this.completionOutcomeFromResponse({
      response: retryResponse,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets ?? [],
      attempt: "retry",
      textProfile: input.textProfile,
      telemetry: input.telemetry,
    })
  }

  private async retrieveCompletionSnippets(input: {
    document: vscode.TextDocument
    settings: RemoteSettings
    details: string
    plan: CompletionPlan
    editInput: Omit<CompletionEditInput, "text">
  }): Promise<RetrievedCompletionSnippet[]> {
    if (!this.deps.codeGraph) return []
    if (!input.plan.needsSymbolRetrieval && !input.plan.needsTestRetrieval) return []

    const query = input.plan.targetSymbol || completionSymbolQuery(input.editInput)
    if (!query) return []

    try {
      const symbols = await this.deps.codeGraph.findSymbols({
        query,
        relatedPath: relativePath(input.document.uri),
        limit: input.plan.needsTestRetrieval ? 10 : 8,
      })
      const resolved = resolveSymbols({
        query,
        relatedPath: relativePath(input.document.uri),
        candidates: symbols.map(symbolCandidateFromCodeGraph),
        limit: input.plan.needsTestRetrieval ? 10 : 8,
        unitTestTarget: input.plan.kind === "comment-to-test" || input.plan.kind === "natural-command",
      })
      this.logDebug(input.settings, `retrieved symbols=${symbols.length} resolved=${resolved.length} query="${quoteLogValue(query)}" ${input.details}`)
      return resolved.map(symbolSnippet)
    } catch (error) {
      this.logDebug(input.settings, `symbol-retrieval skipped reason="${quoteLogValue(formatError(error))}" ${input.details}`)
      return []
    }
  }

  private completionOutcomeFromResponse(input: {
    response: OpenCodeMessage | undefined
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    attempt: "initial" | "retry"
    textProfile: CompletionProfile
    telemetry: CompletionTelemetryDraft
  }): CompletionRequestOutcome {
    const rawVisibleText = completionInsertText(input.response, input.textProfile)
    input.telemetry.rawOutputLength = rawVisibleText.length
    const postprocessStarted = Date.now()
    const postprocessResult = rawVisibleText
      ? postprocessCompletion({
          rawText: rawVisibleText,
          linePrefix: input.editInput.linePrefix,
          lineSuffix: input.editInput.lineSuffix,
          currentWord: input.editInput.currentWord,
          fullCurrentLine: `${input.editInput.linePrefix}${input.editInput.lineSuffix}`,
          languageId: input.editInput.languageId,
          plan: input.plan,
          indent: {
            currentIndent: lineIndent(input.editInput.linePrefix),
            targetIndent: input.editInput.indent.targetIndent,
            indentUnit: input.editInput.indent.indentUnit,
          },
        })
      : {
          text: "",
          rejected: true,
          reason: "empty-output" as const,
        }
    input.telemetry.latencyMs.postprocess = elapsedMs(postprocessStarted)
    const visibleText = postprocessResult.text
    input.telemetry.normalizedOutputLength = visibleText.length
    const fallbackText =
      fallbackCompletionText({
        languageId: input.editInput.languageId,
        plan: input.plan,
        retrievedSnippets: input.retrievedSnippets,
        rejectReason: postprocessResult.reason,
      }) ||
      fallbackSymbolText(input.plan, input.retrievedSnippets, input.editInput.currentWord)
    const candidateText = visibleText || fallbackText
    if (!candidateText) {
      const reason = postprocessResult.rejected ? postprocessResult.reason : "filtered-or-no-visible-text"
      if (input.attempt === "retry") {
        this.logInfo(
          input.settings,
          `retry-edit-rejected reason=${reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      } else {
        this.logInfo(
          input.settings,
          `empty reason=${reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
      }
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, reason)
      return { reason, source: "remote" }
    }

    const editStarted = Date.now()
    let result = buildInlineCompletionEditResult({
      text: candidateText,
      ...input.editInput,
      plan: input.plan,
    })
    if (!result.edit && fallbackText && fallbackText !== candidateText) {
      result = buildInlineCompletionEditResult({
        text: fallbackText,
        ...input.editInput,
        plan: input.plan,
      })
    }
    input.telemetry.latencyMs.edit = elapsedMs(editStarted)
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
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, result.reason)
      return { reason: result.reason, source: "remote" }
    }

    input.telemetry.finalRange = edit.replaceRange ?? zeroWidthRange(input.editInput.position)
    input.telemetry.filterText = edit.filterText ?? edit.insertText
    if (input.attempt === "retry") {
      this.logInfo(input.settings, `retry-edit-ready ${editDetails(edit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${edit.insertText.length}`)
    } else {
      this.logInfo(input.settings, `edit-ready ${editDetails(edit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${edit.insertText.length}`)
    }
    this.logDebug(input.settings, `edit ${editDetails(edit)} visibleChars=${candidateText.length} ${input.details}`)
    this.logCompletionTelemetry(input.settings, input.telemetry, input.started, true)
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

  private logCompletionTelemetry(
    settings: RemoteSettings,
    telemetry: CompletionTelemetryDraft,
    started: number,
    accepted: boolean,
    rejectReason?: string,
  ) {
    this.logDebug(settings, serializeCompletionDebugEvent({
      requestId: telemetry.requestId,
      languageId: telemetry.languageId,
      filePathHash: telemetry.filePathHash,
      triggerKind: telemetry.triggerKind,
      planKind: telemetry.planKind,
      insertMode: telemetry.insertMode,
      currentWord: telemetry.currentWord,
      targetSymbol: telemetry.targetSymbol,
      symbolCandidates: telemetry.symbolCandidates,
      selectedContextBlocks: telemetry.selectedContextBlocks,
      droppedContextBlocks: telemetry.droppedContextBlocks,
      modelRoute: telemetry.modelRoute,
      rawOutputLength: telemetry.rawOutputLength,
      normalizedOutputLength: telemetry.normalizedOutputLength,
      finalRange: telemetry.finalRange,
      filterText: telemetry.filterText,
      accepted,
      rejectReason,
      latencyMs: {
        ...telemetry.latencyMs,
        total: elapsedMs(started),
      },
    }))
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

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function completionSymbolQuery(input: Omit<CompletionEditInput, "text">) {
  if (input.currentWord && input.currentWord.length >= 2) return input.currentWord
  const identifiers = input.linePrefix.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  return identifiers
    .filter((identifier) => !new Set(["unit", "test", "unittest", "for", "of", "to", "function"]).has(identifier.toLowerCase()))
    .at(-1)
}

function symbolSnippet(symbol: ResolvedSymbolCandidate): RetrievedCompletionSnippet {
  const path = symbol.filePath ?? ""
  const kind = /(?:^|[\\/._-])(?:test|tests|spec|mock|fixture)(?:[\\/._-]|$)/i.test(path) || /test|spec|mock|fixture/i.test(symbol.name)
    ? "existing test"
    : symbol.kind
  return {
    kind,
    path,
    line: symbol.line ?? 1,
    name: symbol.name,
    text: symbol.signature || firstNonEmptyLine(symbol.snippet ?? "") || symbol.name,
    score: symbol.score,
  }
}

function fallbackSymbolText(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[], currentWord: string | undefined) {
  if (!plan.replaceCurrentWord || !currentWord) return ""
  const current = currentWord.toLowerCase()
  return snippets
    .map((snippet) => snippet.name ?? "")
    .find((name) => name.toLowerCase().startsWith(current) && name.length > currentWord.length) ?? ""
}

function deterministicCompletionMessage(text: string): OpenCodeMessage {
  return {
    info: {
      id: "deterministic-symbol",
      role: "assistant",
      providerID: "local",
      modelID: "symbol-resolver",
    },
    parts: [{ type: "text", text }],
  }
}

function firstNonEmptyLine(input: string) {
  return input.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""
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

function completionTriggerKind(kind: vscode.InlineCompletionTriggerKind | undefined) {
  switch (kind) {
    case vscode.InlineCompletionTriggerKind.Invoke:
      return "invoke"
    case vscode.InlineCompletionTriggerKind.Automatic:
      return "automatic"
    default:
      return kind === undefined ? undefined : String(kind)
  }
}

function completionTelemetrySymbolCandidates(snippets: RetrievedCompletionSnippet[]) {
  const candidates = snippets
    .filter((snippet) => snippet.name)
    .slice(0, 10)
    .map((snippet) => ({
      name: snippet.name ?? "",
      kind: snippet.kind,
      score: snippet.score ?? 0,
      source: "symbol-resolver",
    }))
  return candidates.length > 0 ? candidates : undefined
}

function completionTelemetrySelectedContextBlocks(pack: CompletionContextPack) {
  const blocks = pack.selected.slice(0, 12).map((block) => ({
    kind: block.kind,
    title: block.title,
    tokenEstimate: block.tokenEstimate,
    score: block.score,
  }))
  return blocks.length > 0 ? blocks : undefined
}

function completionTelemetryDroppedContextBlocks(pack: CompletionContextPack) {
  const blocks = pack.dropped.slice(0, 12).map((block) => ({
    kind: block.kind,
    title: block.title,
    reason: "token-budget",
  }))
  return blocks.length > 0 ? blocks : undefined
}

function zeroWidthRange(position: CompletionEditInput["position"]): CompletionRange {
  return {
    startLine: position.line,
    startCharacter: position.character,
    endLine: position.line,
    endCharacter: position.character,
  }
}

function addCompletionTelemetryLatency(telemetry: CompletionTelemetryDraft, key: CompletionLatencyKey, ms: number) {
  telemetry.latencyMs[key] = (telemetry.latencyMs[key] ?? 0) + ms
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
