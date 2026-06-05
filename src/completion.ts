import * as vscode from "vscode"
import type { CodeGraphContextProvider } from "./codegraph-types"
import {
  buildCompletionEditResult,
  adaptAndValidateInlineCompletionEdit,
  type CompletionEdit,
  type CompletionEditInput,
  type CompletionRange,
  type CompletionSelectedCompletionInfo,
} from "./completion-edit"
import { completionFormatCommand } from "./completion-format-command"
import { completionContextDebugSummary, type CompletionContextPack } from "./completion-context"
import { inferCompletionIndent } from "./completion-indent"
import { CompletionModelClient, completionModel } from "./completion-model-client"
import { runCompletionCandidatePipeline, type CompletionCandidatePipelineResult } from "./completion-candidate-pipeline"
import { planCompletion } from "./completion-plan"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel, routeLogValue, shouldRetryCompletionRejection, type CompletionModelRoute } from "./completion-router"
import { CompletionRequestCoordinator, type CompletionRequestOutcome } from "./completion-request-coordinator"
import { INLINE_COMPLETION_SESSION_TITLE } from "./completion-session"
import { completionSnippetFromSymbol } from "./completion-snippets"
import { resolveSymbols, symbolCandidateFromCodeGraph } from "./completion-symbol"
import { completionTelemetryRoute, createCompletionRequestId, filePathHash, serializeCompletionDebugEvent, type CompletionDebugEvent, type CompletionTelemetryDraft } from "./completion-telemetry"
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
type SelectedCompletionInfo = vscode.InlineCompletionContext["selectedCompletionInfo"]
type PostprocessDebug = CompletionCandidatePipelineResult["postprocessDebug"]

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
    context: vscode.InlineCompletionContext,
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

    const started = Date.now()
    const planningStarted = Date.now()
    const lines = documentLines(document)
    const indent = inferCompletionIndent({
      lines,
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
    const plan = planCompletion({
      ...editInput,
      previousNonEmptyLine: previousNonEmptyLineBefore(lines, position.line),
    })
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
    const telemetry: CompletionTelemetryDraft = {
      requestId,
      languageId: document.languageId,
      filePathHash: filePathHash(document.uri.fsPath),
      triggerKind: completionTriggerKind(context.triggerKind),
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
      this.logDebug(settings, !line.trim() && position.character === 0
        ? `skip: empty line at column 0 ${details}`
        : `skip: disabled plan ${details}`)
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
      validateEdit: (edit) => adaptAndValidateInlineCompletionEdit({
        edit,
        editInput,
        plan,
        selectedCompletionInfo: selectedCompletionInfoValue(context.selectedCompletionInfo),
      }),
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
              selectedCompletionInfo: context.selectedCompletionInfo,
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
              selectedCompletionInfo: context.selectedCompletionInfo,
            }),
      onRemoteReady: () => this.triggerInlineSuggestRefresh(document, position, settings, details),
    })

    if (start.immediate?.status === "ok") {
      const ready = this.inlineItemIfValid({
        edit: start.immediate.edit,
        document,
        editInput,
        plan,
        selectedCompletionInfo: context.selectedCompletionInfo,
        settings,
        details,
        source: start.immediate.source,
      })
      if (ready) {
        this.logReturned(settings, start.immediate.source, ready.edit, details, started)
        return [ready.item]
      }
    }

    if (!start.pending) return

    const outcome = await waitForOutcome(start.pending, token)
    if (!outcome) {
      this.logInfo(settings, `cancelled reason=vscode-token ${details} elapsedMs=${elapsedMs(started)}`)
      return
    }
    if (outcome.status !== "ok") return

    const ready = this.inlineItemIfValid({
      edit: outcome.edit,
      document,
      editInput,
      plan,
      selectedCompletionInfo: context.selectedCompletionInfo,
      settings,
      details,
      source: outcome.source,
    })
    if (!ready) return

    this.logReturned(settings, outcome.source, ready.edit, details, started)
    return [ready.item]
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
    selectedCompletionInfo?: SelectedCompletionInfo
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
      const plan = resolveCompletionPlanAfterSymbolRetrieval(input.plan, retrievedSnippets)
      updateCompletionTelemetryPlan(input.telemetry, plan)
      const route = routeCompletionModel({
        plan,
        settings: input.settings,
        retrievedSnippets,
      })
      input.telemetry.modelRoute = completionTelemetryRoute(route)
      this.logDebug(input.settings, `${routeLogValue(route)} ${input.details}`)
      if (route.kind === "none") {
        return this.noCompletionCandidateOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          telemetry: input.telemetry,
        })
      }
      if (route.kind === "deterministic-symbol") {
        return this.deterministicCompletionOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          editInput: input.editInput,
          plan,
          retrievedSnippets,
          telemetry: input.telemetry,
          selectedCompletionInfo: input.selectedCompletionInfo,
        })
      }

      const contextStarted = Date.now()
      const prompt = await this.completionPromptForRoute({
        route,
        document: input.document,
        position: input.position,
        settings: input.settings,
        details: input.details,
        plan,
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
        plan,
        retrievedSnippets,
        textProfile: route.textProfile,
        telemetry: input.telemetry,
        selectedCompletionInfo: input.selectedCompletionInfo,
        sendPrompt: (promptText) => this.sendCompletion(input.client, promptText, input.settings, input.signal),
      })
    } catch (error) {
      if (input.signal.aborted) {
        this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "cancelled")
        return { status: "rejected", reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "remote-error")
      return { status: "rejected", reason: "remote-error", source: "remote" }
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
    selectedCompletionInfo?: SelectedCompletionInfo
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
      const plan = resolveCompletionPlanAfterSymbolRetrieval(input.plan, retrievedSnippets)
      updateCompletionTelemetryPlan(input.telemetry, plan)
      const route = routeCompletionModel({
        plan,
        settings: input.settings,
        retrievedSnippets,
      })
      input.telemetry.modelRoute = completionTelemetryRoute(route)
      this.logDebug(input.settings, `${routeLogValue(route)} ${input.details}`)
      if (route.kind === "none") {
        return this.noCompletionCandidateOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          telemetry: input.telemetry,
        })
      }
      if (route.kind === "deterministic-symbol") {
        return this.deterministicCompletionOutcome({
          route,
          settings: input.settings,
          details: input.details,
          started: input.started,
          editInput: input.editInput,
          plan,
          retrievedSnippets,
          telemetry: input.telemetry,
          selectedCompletionInfo: input.selectedCompletionInfo,
        })
      }

      const contextStarted = Date.now()
      const prompt = await this.completionPromptForRoute({
        route,
        document: input.document,
        position: input.position,
        settings: input.settings,
        details: input.details,
        plan,
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
        plan,
        retrievedSnippets,
        textProfile: route.textProfile,
        telemetry: input.telemetry,
        selectedCompletionInfo: input.selectedCompletionInfo,
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
        return { status: "rejected", reason: "cancelled", source: "remote" }
      }
      this.logInfo(
        input.settings,
        `Completion failed: ${formatError(error)} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
      )
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "remote-error")
      return { status: "rejected", reason: "remote-error", source: "remote" }
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
    selectedCompletionInfo?: SelectedCompletionInfo
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
      selectedCompletionInfo: input.selectedCompletionInfo,
    })
  }

  private noCompletionCandidateOutcome(input: {
    route: Extract<CompletionModelRoute, { kind: "none" }>
    settings: RemoteSettings
    details: string
    started: number
    telemetry: CompletionTelemetryDraft
  }): CompletionRequestOutcome {
    this.logInfo(input.settings, `no-completion reason=${input.route.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
    this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, input.route.reason)
    return { status: "rejected", reason: input.route.reason, source: "remote" }
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
    selectedCompletionInfo?: SelectedCompletionInfo
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
      selectedCompletionInfo: input.selectedCompletionInfo,
    })
    if (initial.status === "ok" || !shouldRetryCompletionRejection({
      reason: initial.reason,
      plan: input.plan,
      textProfile: input.textProfile,
    })) return initial

    const retryPrompt = completionRetryPrompt(input.prompt, input.editInput, initial.reason)
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
      selectedCompletionInfo: input.selectedCompletionInfo,
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
        limit: completionSymbolRetrievalLimit(input.plan),
      })
      const resolved = resolveSymbols({
        query,
        relatedPath: relativePath(input.document.uri),
        candidates: symbols.map(symbolCandidateFromCodeGraph),
        cursorLine: input.editInput.position.line + 1,
        preferNearbyAbove: input.plan.kind === "comment-symbol-reference",
        limit: completionSymbolRetrievalLimit(input.plan),
        unitTestTarget: input.plan.kind === "comment-to-test" || input.plan.kind === "natural-command",
      })
      this.logDebug(input.settings, `retrieved symbols=${symbols.length} resolved=${resolved.length} query="${quoteLogValue(query)}" ${input.details}`)
      return resolved.map(completionSnippetFromSymbol)
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
    selectedCompletionInfo?: SelectedCompletionInfo
  }): CompletionRequestOutcome {
    const pipeline = runCompletionCandidatePipeline({
      response: input.response,
      textProfile: input.textProfile,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      selectedCompletionInfo: selectedCompletionInfoValue(input.selectedCompletionInfo),
    })
    input.telemetry.rawOutputLength = pipeline.rawText.length
    input.telemetry.latencyMs.postprocess = pipeline.latencyMs.postprocess
    input.telemetry.normalizedOutputLength = pipeline.postprocessText.length
    input.telemetry.latencyMs.edit = pipeline.latencyMs.edit
    const rawFirstLine = firstLogLine(pipeline.rawText)
    const postprocessFirstLine = firstLogLine(pipeline.postprocessText)
    if (pipeline.decision === "rejected") {
      const reason = pipeline.rejectionReason ?? "filtered-or-no-visible-text"
      this.logDebug(input.settings, `inline-invariant ${inlineCompletionInvariantDetails({
        edit: pipeline.edit,
        editInput: input.editInput,
        plan: input.plan,
        rawFirstLine,
        postprocessFirstLine,
        postprocessDebug: pipeline.postprocessDebug,
        rejectReason: reason,
        selectedCompletionInfo: input.selectedCompletionInfo,
      })} ${input.details}`)
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
      return { status: "rejected", reason, source: "remote" }
    }

    const adaptedEdit = pipeline.edit
    if (!adaptedEdit) {
      const reason = "filtered-or-no-visible-text"
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, reason)
      return { status: "rejected", reason, source: "remote" }
    }
    input.telemetry.finalRange = adaptedEdit.replaceRange ?? zeroWidthRange(input.editInput.position)
    input.telemetry.filterText = adaptedEdit.filterText ?? adaptedEdit.insertText
    this.logDebug(input.settings, `inline-invariant ${inlineCompletionInvariantDetails({
      edit: adaptedEdit,
      editInput: input.editInput,
      plan: input.plan,
      rawFirstLine,
      postprocessFirstLine,
      postprocessDebug: pipeline.postprocessDebug,
      rejectReason: pipeline.rejectionReason,
      selectedCompletionInfo: input.selectedCompletionInfo,
    })} ${input.details}`)
    if (input.attempt === "retry") {
      this.logInfo(input.settings, `retry-edit-ready ${editDetails(adaptedEdit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${adaptedEdit.insertText.length}`)
    } else {
      this.logInfo(input.settings, `edit-ready ${editDetails(adaptedEdit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${adaptedEdit.insertText.length}`)
    }
    this.logDebug(input.settings, `edit ${editDetails(adaptedEdit)} visibleChars=${pipeline.candidateText.length} ${input.details}`)
    this.logCompletionTelemetry(input.settings, input.telemetry, input.started, true)
    return { status: "ok", edit: adaptedEdit, source: "remote" }
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

  private inlineItemIfValid(input: {
    edit: CompletionEdit
    document: vscode.TextDocument
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    selectedCompletionInfo?: SelectedCompletionInfo
    settings: RemoteSettings
    details: string
    source: CompletionRequestOutcome["source"]
  }) {
    const validation = adaptAndValidateInlineCompletionEdit({
      edit: input.edit,
      editInput: input.editInput,
      plan: input.plan,
      selectedCompletionInfo: selectedCompletionInfoValue(input.selectedCompletionInfo),
    })
    if (validation.status === "ok") {
      return {
        item: this.inlineItem(validation.edit, input.document),
        edit: validation.edit,
      }
    }

    this.logDebug(input.settings, `inline-item-rejected reason=${validation.reason} source=${input.source} ${inlineCompletionInvariantDetails({
      edit: input.edit,
      editInput: input.editInput,
      plan: input.plan,
      rawFirstLine: "",
      postprocessFirstLine: "",
      postprocessDebug: { prefixMode: "none" },
      rejectReason: validation.reason,
      selectedCompletionInfo: input.selectedCompletionInfo,
    })} ${input.details}`)
    return undefined
  }
}

function completionRetryPrompt(prompt: string, editInput: Omit<CompletionEditInput, "text">, reason: string) {
  const currentLine = truncateFeedback(`${editInput.linePrefix}${editInput.lineSuffix}`)
  const cursorPrefix = truncateFeedback(editInput.linePrefix)
  const feedback = reason === "low-confidence-output"
    ? "Previous completion was rejected because it contained only structural punctuation or otherwise lacked meaningful code."
    : `Previous completion was rejected because it began with blank lines and did not continue the current line "${quoteLogValue(currentLine)}".`
  return [
    prompt,
    "",
    "<completion-feedback>",
    feedback,
    `The cursor is after the prefix "${quoteLogValue(cursorPrefix)}".`,
    "Return only meaningful code that continues or replaces the cursor context, or return empty.",
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
        resolve({ status: "rejected", reason: "provider-wait-error", source: "remote" })
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

function completionSymbolQuery(input: Omit<CompletionEditInput, "text">) {
  if (input.currentWord && input.currentWord.length >= 2) return input.currentWord
  const identifiers = input.linePrefix.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  return identifiers
    .filter((identifier) => !new Set(["unit", "test", "unittest", "for", "of", "to", "function"]).has(identifier.toLowerCase()))
    .at(-1)
}

function completionSymbolRetrievalLimit(plan: CompletionPlan) {
  if (plan.kind === "comment-symbol-reference") return 50
  return plan.needsTestRetrieval ? 30 : 8
}

function updateCompletionTelemetryPlan(telemetry: CompletionTelemetryDraft, plan: CompletionPlan) {
  telemetry.planKind = plan.kind
  telemetry.insertMode = plan.insertMode
  telemetry.targetSymbol = plan.targetSymbol
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

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
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

function inlineCompletionInvariantDetails(input: {
  edit?: CompletionEdit
  editInput: Omit<CompletionEditInput, "text">
  plan: CompletionPlan
  rawFirstLine: string
  postprocessFirstLine: string
  postprocessDebug: PostprocessDebug
  rejectReason?: string
  selectedCompletionInfo?: SelectedCompletionInfo
}) {
  const rangeText = input.edit?.replaceRange
    ? currentLineRangeText(input.editInput, input.edit.replaceRange)
    : ""
  const insertFirstLine = input.edit ? firstLogLine(input.edit.insertText) : ""
  const filterText = input.edit ? input.edit.filterText ?? input.edit.insertText : ""
  const risks = inlineCompletionDisplayRisks({
    edit: input.edit,
    editInput: input.editInput,
    selectedCompletionInfo: input.selectedCompletionInfo,
  })
  return [
    `rawFirstLine="${quoteLogValue(truncateLine(input.rawFirstLine))}"`,
    `postprocessFirstLine="${quoteLogValue(truncateLine(input.postprocessFirstLine))}"`,
    `insertMode="${input.plan.insertMode}"`,
    `prefixMode="${input.postprocessDebug.prefixMode}"`,
    ...(input.postprocessDebug.stripReason ? [`stripReason="${input.postprocessDebug.stripReason}"`] : []),
    `linePrefix="${quoteLogValue(truncateLine(input.editInput.linePrefix))}"`,
    `currentWord="${quoteLogValue(input.editInput.currentWord ?? "")}"`,
    `replaceRange=${input.edit?.replaceRange ? rangeLogValue(input.edit.replaceRange) : "none"}`,
    `rangeText="${quoteLogValue(truncateLine(rangeText))}"`,
    `insertFirstLine="${quoteLogValue(truncateLine(insertFirstLine))}"`,
    `filterText="${quoteLogValue(truncateLine(filterText))}"`,
    ...(input.rejectReason ? [`rejectReason="${quoteLogValue(input.rejectReason)}"`] : []),
    `displayRisk="${risks.length ? quoteLogValue(risks.join(",")) : "none"}"`,
  ].join(" ")
}

function inlineCompletionDisplayRisks(input: {
  edit?: CompletionEdit
  editInput: Omit<CompletionEditInput, "text">
  selectedCompletionInfo?: SelectedCompletionInfo
}) {
  const risks: string[] = []
  if (!input.edit) {
    if (input.selectedCompletionInfo) risks.push("selected-info-without-edit")
    return risks
  }

  const filterText = input.edit.filterText ?? input.edit.insertText
  const rangeText = input.edit.replaceRange
    ? currentLineRangeText(input.editInput, input.edit.replaceRange)
    : ""
  if (!filterText.startsWith(rangeText)) {
    risks.push("rangeText-not-prefix-of-filterText")
  }

  if (!input.selectedCompletionInfo) return risks

  if (!input.edit.replaceRange || !sameCompletionRangeAsVscodeRange(input.edit.replaceRange, input.selectedCompletionInfo.range)) {
    risks.push("selectedCompletionInfo-range-mismatch")
  }
  if (!input.edit.insertText.startsWith(input.selectedCompletionInfo.text)) {
    risks.push("selectedCompletionInfo-text-not-prefix")
  }
  return risks
}

function currentLineRangeText(input: Omit<CompletionEditInput, "text">, range: CompletionRange) {
  if (range.startLine !== input.position.line || range.endLine !== input.position.line) return "<cross-line>"
  const lineText = `${input.linePrefix}${input.lineSuffix}`
  return lineText.slice(range.startCharacter, range.endCharacter)
}

function selectedCompletionInfoValue(input: SelectedCompletionInfo | undefined): CompletionSelectedCompletionInfo | undefined {
  if (!input) return undefined
  return {
    text: input.text,
    range: {
      startLine: input.range.start.line,
      startCharacter: input.range.start.character,
      endLine: input.range.end.line,
      endCharacter: input.range.end.character,
    },
  }
}

function sameCompletionRangeAsVscodeRange(range: CompletionRange, vscodeRange: vscode.Range) {
  return range.startLine === vscodeRange.start.line &&
    range.startCharacter === vscodeRange.start.character &&
    range.endLine === vscodeRange.end.line &&
    range.endCharacter === vscodeRange.end.character
}

function rangeLogValue(range: CompletionRange) {
  return `${range.startLine + 1}:${range.startCharacter + 1}-${range.endLine + 1}:${range.endCharacter + 1}`
}

function firstLogLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
}

function truncateLine(input: string) {
  if (input.length <= 80) return input
  return `${input.slice(0, 77)}...`
}

function truncateFeedback(input: string) {
  if (input.length <= 160) return input
  return `${input.slice(0, 157)}...`
}
