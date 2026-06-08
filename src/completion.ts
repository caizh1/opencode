import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as vscode from "vscode"
import type { CodeGraphContextProvider, CodeGraphEvidenceQueryOptions } from "./codegraph-types"
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
import { buildCEmbeddedCompletionEvidence, shouldBuildCEmbeddedCompletionEvidence, type CEmbeddedFullRetrievalDebugDump } from "./completion-c-embedded-evidence"
import { scoreCEmbeddedCompletionQuality, type CEmbeddedCompletionFixture, type CEmbeddedTriggerKind } from "./completion-c-embedded-quality"
import { inferCompletionIndent } from "./completion-indent"
import { CompletionModelClient, completionModel, directCompletionRequestDiagnostic } from "./completion-model-client"
import { runCompletionCandidatePipeline, type CompletionCandidatePipelineResult } from "./completion-candidate-pipeline"
import { planCompletion } from "./completion-plan"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel, routeLogValue, shouldRetryCompletionRejection, type CompletionModelRoute } from "./completion-router"
import { CompletionRequestCoordinator, type CompletionRequestCacheMetadata, type CompletionRequestOutcome } from "./completion-request-coordinator"
import { completionRetrievalPlan, shouldRetrieveCompletionSnippetsForPlan, type CompletionRetrievalPreferredKind } from "./completion-retrieval"
import { INLINE_COMPLETION_SESSION_TITLE } from "./completion-session"
import { completionSnippetFromSymbol } from "./completion-snippets"
import { resolveSymbols, symbolCandidateFromCodeGraph } from "./completion-symbol"
import { fallbackCompletionText } from "./completion-test-fallback"
import { COMPLETION_PLANNER_REVISION, completionTelemetryRoute, createCompletionRequestId, filePathHash, serializeCompletionDebugEvent, type CompletionDebugEvent, type CompletionTelemetryDraft } from "./completion-telemetry"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"
import { buildCompletionPrompt, buildQwenCoderFimPrompt, relativePath } from "./context"
import { isSessionNotFoundError, parseModel, RemoteOpenCodeClient } from "./remote-client"
import type { CompletionProfile, OpenCodeMessage, RemoteSettings } from "./types"

type CompletionDeps = {
  getClient: () => RemoteOpenCodeClient | undefined
  getCompletionApiKey?: () => Promise<string | undefined>
  getSettings: () => RemoteSettings
  codeGraph?: CodeGraphContextProvider
  output: vscode.OutputChannel
  extensionVersion?: string
}

type ModelCompletionRoute = Extract<CompletionModelRoute, { kind: "model" }>
type DeterministicSymbolRoute = Extract<CompletionModelRoute, { kind: "deterministic-symbol" }>
type CompletionLatencyKey = Exclude<keyof CompletionDebugEvent["latencyMs"], "total">
type SelectedCompletionInfo = vscode.InlineCompletionContext["selectedCompletionInfo"]
type PostprocessDebug = CompletionCandidatePipelineResult["postprocessDebug"]
type QualityCompletionEdit = CompletionEdit & {
  qualityContextText?: string
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
      nextNonEmptyLine: nextNonEmptyLineAfter(lines, position.line),
      lines,
      line: position.line,
      triggerKind: completionTriggerKind(context.triggerKind),
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

    this.logInfo(settings, `triggered ${completionPlannerLogDetails(plan, this.deps.extensionVersion)} ${details}`)
    const telemetry: CompletionTelemetryDraft = {
      requestId,
      completionId: requestId,
      extensionVersion: this.deps.extensionVersion,
      plannerRevision: COMPLETION_PLANNER_REVISION,
      languageId: document.languageId,
      filePathHash: filePathHash(document.uri.fsPath),
      triggerKind: completionTriggerKind(context.triggerKind),
      planKind: plan.kind,
      cIntent: plan.cIntent,
      insertMode: plan.insertMode,
      currentWord: currentWord?.text,
      targetSymbol: plan.targetSymbol,
      sourceCommentHash: plan.sourceComment ? filePathHash(plan.sourceComment) : undefined,
      sourceCommentPreview: plan.sourceComment,
      commentGuidedSkipReason: plan.commentGuidedSkipReason,
      retrievalMode: "none",
      evidenceKinds: [],
      contextLevel: "none",
      promptKind: "none",
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
    const cacheMetadata = completionRequestCacheMetadata(document, position, line, plan)

    const localFallback = buildCompletionEditResult({
      text: "",
      ...editInput,
      preferCurrentWordReplacement: plan.replaceCurrentWord,
    }).edit
    const start = this.requests.request({
      key: completionRequestKey(document, position, lineText, settings, plan),
      details,
      debounceMs: settings.completion.debounceMs,
      cacheMetadata,
      localFallback,
      validateEdit: (edit) => this.validateInlineCompletionEditForReturn({
        edit,
        document,
        editInput,
        plan,
        selectedCompletionInfo: context.selectedCompletionInfo,
        triggerKind: runtimeTriggerKind(context.triggerKind),
        selectedContextText: (edit as QualityCompletionEdit).qualityContextText,
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
      onRemoteReady: () => this.triggerInlineSuggestRefresh(document, cacheMetadata, settings, details),
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
        triggerKind: runtimeTriggerKind(context.triggerKind),
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
      triggerKind: runtimeTriggerKind(context.triggerKind),
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
        telemetry: input.telemetry,
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
      input.telemetry.promptKind = completionTelemetryPromptKind(route)
      updateCompletionTelemetryRoute(input.telemetry, route)
      this.logDebug(input.settings, `${routeLogValue(route, input.settings)} ${input.details}`)
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
          document: input.document,
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
        prompt: prompt.prompt,
        selectedContextText: prompt.selectedContextText,
        document: input.document,
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
    let effectiveModelProfile: CompletionProfile | undefined
    try {
      const symbolStarted = Date.now()
      const retrievedSnippets = await this.retrieveCompletionSnippets({
        document: input.document,
        settings: input.settings,
        details: input.details,
        plan: input.plan,
        editInput: input.editInput,
        telemetry: input.telemetry,
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
      input.telemetry.promptKind = completionTelemetryPromptKind(route)
      updateCompletionTelemetryRoute(input.telemetry, route)
      this.logDebug(input.settings, `${routeLogValue(route, input.settings)} ${input.details}`)
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
          document: input.document,
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
      effectiveModelProfile = route.modelProfile
      const routedDetails = `${input.details} ${routeRequestDetails(route, input.settings)}`

      const contextStarted = Date.now()
      const prompt = await this.completionPromptForRoute({
        route,
        document: input.document,
        position: input.position,
        settings: input.settings,
        details: routedDetails,
        plan,
        retrievedSnippets,
        transport: "openai-compatible",
        telemetry: input.telemetry,
      })
      input.telemetry.latencyMs.context = elapsedMs(contextStarted)
      const apiKey = await this.deps.getCompletionApiKey?.()
      const client = new CompletionModelClient(input.settings, apiKey)
      return await this.completionOutcomeWithRetry({
        prompt: prompt.prompt,
        selectedContextText: prompt.selectedContextText,
        document: input.document,
        settings: input.settings,
        details: routedDetails,
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
      const diagnostic = directCompletionRequestDiagnostic(error, effectiveModelProfile ?? input.settings.completion.profile)
      if (diagnostic) {
        this.logInfo(
          input.settings,
          `Completion failed: ${diagnostic} ${input.details} elapsedMs=${elapsedMs(input.started)}`,
        )
        this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, "direct-fim-endpoint-unsupported")
        return { status: "rejected", reason: "direct-fim-endpoint-unsupported", source: "remote" }
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
  }): Promise<{ prompt: string; selectedContextText: string }> {
    let selectedContextText = ""
    const onContextPack = (pack: CompletionContextPack) => {
      selectedContextText = pack.selected.map((block) => block.text).join("\n")
      input.telemetry.selectedContextBlocks = completionTelemetrySelectedContextBlocks(pack)
      input.telemetry.droppedContextBlocks = completionTelemetryDroppedContextBlocks(pack)
      input.telemetry.evidenceKinds = completionTelemetryEvidenceKinds(pack, input.telemetry.evidenceKinds)
      const droppedEvidenceKinds = completionTelemetryDroppedEvidenceKinds(pack)
      input.telemetry.evidenceDroppedReason = droppedEvidenceKinds.length > 0 ? "token-budget" : undefined
      input.telemetry.droppedEvidenceKinds = droppedEvidenceKinds.length > 0 ? droppedEvidenceKinds : undefined
      const promptEvidence = completionTelemetryPromptEvidence(pack)
      input.telemetry.evidencePromptBlocks = promptEvidence.blocks || undefined
      input.telemetry.evidencePromptTokens = promptEvidence.tokens || undefined
      input.telemetry.evidencePromptKinds = promptEvidence.kinds.length > 0 ? promptEvidence.kinds : undefined
      const actualPromptEvidenceNames = completionTelemetryActualPromptEvidenceNames(pack)
      if (actualPromptEvidenceNames.length > 0) {
        input.telemetry.actualPromptEvidenceNames = actualPromptEvidenceNames
        input.telemetry.selectedPromptEvidenceNames = actualPromptEvidenceNames
        const projected = input.telemetry.projectedEvidenceNames ?? input.telemetry.submittedEvidenceNames ?? []
        input.telemetry.droppedProjectedEvidenceNames = projected.filter((name) => !actualPromptEvidenceNames.includes(name)).slice(0, 8)
        const projectedTop = projected[0]
        input.telemetry.promptContainsProjectedHelper = Boolean(projectedTop && actualPromptEvidenceNames.includes(projectedTop))
        if (input.telemetry.cEmbeddedEvidenceTrace) {
          input.telemetry.cEmbeddedEvidenceTrace.actualPromptEvidenceNames = actualPromptEvidenceNames
          input.telemetry.cEmbeddedEvidenceTrace.selectedPromptEvidenceNames = actualPromptEvidenceNames
          input.telemetry.cEmbeddedEvidenceTrace.droppedProjectedEvidenceNames = input.telemetry.droppedProjectedEvidenceNames
          input.telemetry.cEmbeddedEvidenceTrace.promptContainsProjectedHelper = input.telemetry.promptContainsProjectedHelper
        }
      }
      input.telemetry.contextLevel = completionTelemetryContextLevel(pack)
      input.telemetry.contextWarnings = completionTelemetryContextWarnings(pack)
      if (input.plan.kind === "c-embedded-code" && input.plan.cIntent === "symbol-prefix") {
        input.telemetry.symbolPrefixContextTokens = pack.tokenEstimate
        input.telemetry.symbolPrefixDroppedTargetSymbols = completionTelemetryDroppedSymbolPrefixTargets(input.telemetry, pack)
      }
      this.logDebug(input.settings, `${completionContextDebugSummary(pack)} ${input.details}`)
    }
    const analysisEvidenceText = await this.retrieveCompletionAnalysisEvidence({
      document: input.document,
      position: input.position,
      settings: input.settings,
      details: input.details,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      telemetry: input.telemetry,
    })

    if (input.route.promptKind === "qwen-fim") {
      const prompt = buildQwenCoderFimPrompt({
        document: input.document,
        position: input.position,
        settings: input.settings,
        plan: input.plan,
        retrievedSnippets: input.retrievedSnippets,
        analysisEvidenceText,
        onContextPack,
      })
      this.writeFullRetrievalDebugDumpIfNeeded({
        document: input.document,
        settings: input.settings,
        details: input.details,
        telemetry: input.telemetry,
        prompt,
      })
      return { prompt, selectedContextText }
    }

    const prompt = await buildCompletionPrompt({
      document: input.document,
      position: input.position,
      settings: input.settings,
      transport: input.transport,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      analysisEvidenceText,
      onContextPack,
    })
    this.writeFullRetrievalDebugDumpIfNeeded({
      document: input.document,
      settings: input.settings,
      details: input.details,
      telemetry: input.telemetry,
      prompt,
    })
    return { prompt, selectedContextText }
  }

  private writeFullRetrievalDebugDumpIfNeeded(input: {
    document: vscode.TextDocument
    settings: RemoteSettings
    details: string
    telemetry: CompletionTelemetryDraft
    prompt: string
  }) {
    const dump = input.telemetry.fullRetrievalDebugDump as CEmbeddedFullRetrievalDebugDump | undefined
    if (!dump) return
    const expected = dump.expectedSymbol?.trim()
    const selectedBlocks = input.telemetry.selectedContextBlocks ?? []
    const selectedBlocksText = JSON.stringify(selectedBlocks)
    const expectedSymbolPresence = {
      ...dump.expectedSymbolPresence,
      selectedContextBlocks: expected ? selectedBlocksText.includes(expected) : false,
      finalPrompt: expected ? input.prompt.includes(expected) : false,
    }
    const output = {
      ...dump,
      selectedContextBlocks: selectedBlocks,
      finalPrompt: input.prompt,
      expectedSymbolPresence,
    }
    const root = vscode.workspace.getWorkspaceFolder?.(input.document.uri)?.uri?.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ??
      dirname(input.document.uri.fsPath)
    const dir = join(root, ".completion-quality", "live-retrieval-debug")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${safeFileName(input.telemetry.requestId)}.json`)
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`)
    input.telemetry.expectedSymbolInPrompt = expectedSymbolPresence.finalPrompt
    input.telemetry.fullRetrievalProbeDumpPath = path
    if (input.telemetry.cEmbeddedEvidenceTrace) {
      input.telemetry.cEmbeddedEvidenceTrace.expectedSymbolInPrompt = expectedSymbolPresence.finalPrompt
      input.telemetry.cEmbeddedEvidenceTrace.fullRetrievalProbeDumpPath = path
    }
    this.logDebug(input.settings, `fullRetrievalProbeDump=${quoteLogValue(path)} ${input.details}`)
  }

  private deterministicCompletionOutcome(input: {
    route: DeterministicSymbolRoute
    document: vscode.TextDocument
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
      document: input.document,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      selectedContextText: completionQualityContextText(input.retrievedSnippets),
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
    document: vscode.TextDocument
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
    selectedContextText?: string
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
      document: input.document,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets ?? [],
      selectedContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets ?? []),
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

    const retryPrompt = completionRetryPrompt(input.prompt, input.editInput, initial.reason, input.textProfile)
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
      document: input.document,
      settings: input.settings,
      details: input.details,
      started: input.started,
      editInput: input.editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets ?? [],
      selectedContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets ?? []),
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
    telemetry: CompletionTelemetryDraft
  }): Promise<RetrievedCompletionSnippet[]> {
    if (!this.deps.codeGraph) return []
    if (!shouldRetrieveCompletionSnippetsForPlan(input.plan, input.document.languageId)) return []

    const retrieval = completionRetrievalPlan({
      plan: input.plan,
      languageId: input.document.languageId,
      linePrefix: input.editInput.linePrefix,
      lineSuffix: input.editInput.lineSuffix,
      currentWord: input.editInput.currentWord,
    })
    const queries = uniqueNonEmpty([
      ...retrieval.queries,
      completionSymbolQuery(input.editInput),
    ]).slice(0, 4)
    if (queries.length === 0) return []
    input.telemetry.retrievalMode = mergeCompletionRetrievalMode(input.telemetry.retrievalMode, "graph-only")

    try {
      const limit = completionSymbolRetrievalLimit(input.plan)
      const batches = await Promise.all(queries.map(async (query) => {
        const symbols = await this.deps.codeGraph!.findSymbols({
          query,
          relatedPath: relativePath(input.document.uri),
          limit,
        })
        const resolved = resolveSymbols({
          query,
          relatedPath: relativePath(input.document.uri),
          candidates: symbols.map(symbolCandidateFromCodeGraph),
          cursorLine: input.editInput.position.line + 1,
          preferNearbyAbove: input.plan.kind === "comment-symbol-reference",
          limit,
          unitTestTarget: input.plan.kind === "comment-to-test" || input.plan.kind === "natural-command",
        })
        return { query, symbols: symbols.length, resolved }
      }))
      const snippets = rankRetrievedCompletionSnippets({
        snippets: batches.flatMap((batch) => batch.resolved.map(completionSnippetFromSymbol)),
        preferredKinds: retrieval.preferredKinds,
        limit,
      })
      const symbolCount = batches.reduce((sum, batch) => sum + batch.symbols, 0)
      const resolvedCount = batches.reduce((sum, batch) => sum + batch.resolved.length, 0)
      this.logDebug(input.settings, `retrieved symbols=${symbolCount} resolved=${resolvedCount} selected=${snippets.length} queries="${quoteLogValue(queries.join(","))}" policy=${retrieval.policyLabel} ${input.details}`)
      return snippets
    } catch (error) {
      this.logDebug(input.settings, `symbol-retrieval skipped reason="${quoteLogValue(formatError(error))}" ${input.details}`)
      return []
    }
  }

  private async retrieveCompletionAnalysisEvidence(input: {
    document: vscode.TextDocument
    position: vscode.Position
    settings: RemoteSettings
    details: string
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    telemetry: CompletionTelemetryDraft
  }) {
    if (!this.deps.codeGraph) return ""
    if (!input.settings.codeGraph.enabled) return ""
    if (!isCEmbeddedLanguage(input.document.languageId)) return ""

    const lineText = input.document.lineAt(input.position.line).text
    const retrieval = completionRetrievalPlan({
      plan: input.plan,
      languageId: input.document.languageId,
      linePrefix: lineText.slice(0, input.position.character),
      lineSuffix: lineText.slice(input.position.character),
      currentWord: currentWordBeforeCursor(lineText.slice(0, input.position.character), input.position.line)?.text,
    })
    const question = completionEvidenceQuestion({
      document: input.document,
      position: input.position,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      retrievalEvidenceQuestion: retrieval.evidenceQuestion,
    })
    if (!question) return ""

    try {
      if (shouldBuildCEmbeddedCompletionEvidence(input.plan)) {
        const result = await buildCEmbeddedCompletionEvidence({
          codeGraph: this.deps.codeGraph,
          plan: input.plan,
          question,
          relatedPaths: [relativePath(input.document.uri)],
          domainHints: input.plan.domainHints,
          prefix: completionRetrievalPrefix(input.document, input.position),
          suffix: completionRetrievalSuffix(input.document, input.position),
          ...completionScopedCursorContextWindow(input.document, input.position),
          debugFullRetrievalProbe: input.settings.completion.debugFullRetrievalProbe,
          debugExpectedSymbol: input.settings.completion.debugExpectedSymbol,
          commentGuidedRetrievalMode: input.settings.completion.commentGuidedRetrievalMode,
          requestId: input.telemetry.requestId,
        })
        input.telemetry.retrievalMode = mergeCompletionRetrievalMode(input.telemetry.retrievalMode, result.retrievalMode)
        input.telemetry.evidenceKinds = mergeCompletionEvidenceKinds(input.telemetry.evidenceKinds, result.evidenceKinds)
        input.telemetry.cEmbeddedEvidenceTrace = result.trace
        input.telemetry.normalizedCommentTokens = result.trace.normalizedCommentTokens
        input.telemetry.candidateTokenCoverage = result.trace.candidateTokenCoverage
        input.telemetry.semanticCandidateTopK = result.trace.semanticCandidateTopK
        input.telemetry.selectedSimilarFunctionNames = result.trace.selectedSimilarFunctionNames
        input.telemetry.retrievalElapsedMs = result.trace.retrievalElapsedMs
        input.telemetry.retrievalBudgetMs = result.trace.retrievalBudgetMs
        input.telemetry.retrievalTimedOut = result.trace.retrievalTimedOut
        input.telemetry.timeoutStage = result.trace.timeoutStage
        input.telemetry.qaAlignedEvidence = result.trace.qaAlignedEvidence
        input.telemetry.qaTopCandidate = result.trace.qaTopCandidate
        input.telemetry.completionTopCandidate = result.trace.completionTopCandidate
        input.telemetry.sharedTopCandidate = result.trace.sharedTopCandidate
        input.telemetry.qaRetrievalTopK = result.trace.qaRetrievalTopK
        input.telemetry.completionRetrievalTopK = result.trace.completionRetrievalTopK
        input.telemetry.alignmentReason = result.trace.alignmentReason
        input.telemetry.rerankEnabled = result.trace.rerankEnabled
        input.telemetry.ragAvailable = result.trace.ragAvailable
        input.telemetry.latencyBudgetMs = result.trace.latencyBudgetMs
        input.telemetry.maxEvidence = result.trace.maxEvidence
        input.telemetry.evidenceRoles = result.trace.evidenceRoles
        input.telemetry.generationModeHint = result.trace.generationModeHint
        input.telemetry.helperCallableConfidence = result.trace.helperCallableConfidence
        input.telemetry.callableHelperCandidates = result.trace.callableHelperCandidates
        input.telemetry.styleExampleCandidates = result.trace.styleExampleCandidates
        input.telemetry.qaStyleTopK = result.trace.qaStyleTopK
        input.telemetry.completionProjectionTopK = result.trace.completionProjectionTopK
        input.telemetry.droppedAlignedEvidence = result.trace.droppedAlignedEvidence
        input.telemetry.cursorContextFeatures = result.trace.cursorContextFeatures
        input.telemetry.cursorContextScope = result.trace.cursorContextScope
        input.telemetry.currentFunctionBodyIsEmpty = result.trace.currentFunctionBodyIsEmpty
        input.telemetry.scopedPreviousStatementCalls = result.trace.scopedPreviousStatementCalls
        input.telemetry.scopedNextStatementCalls = result.trace.scopedNextStatementCalls
        input.telemetry.cursorContextFallbackReason = result.trace.cursorContextFallbackReason
        input.telemetry.fullRetrievalCandidateCount = result.trace.fullRetrievalCandidateCount
        input.telemetry.projectionCandidateCount = result.trace.projectionCandidateCount
        input.telemetry.retrievalShape = result.trace.retrievalShape
        input.telemetry.qaExactTopK = result.trace.qaExactTopK
        input.telemetry.qaExactSubmittedEvidence = result.trace.qaExactSubmittedEvidence
        input.telemetry.qaExactContextTopK = result.trace.qaExactContextTopK
        input.telemetry.semanticQueryText = result.trace.semanticQueryText
        input.telemetry.graphQuestionTextHash = result.trace.graphQuestionTextHash
        input.telemetry.semanticTopK = result.trace.semanticTopK
        input.telemetry.graphTopK = result.trace.graphTopK
        input.telemetry.mergedTopK = result.trace.mergedTopK
        input.telemetry.selectedPromptEvidenceNames = result.trace.selectedPromptEvidenceNames
        input.telemetry.rawSemanticTopK = result.trace.rawSemanticTopK
        input.telemetry.rawGraphTopK = result.trace.rawGraphTopK
        input.telemetry.mergedRetrievalTopK = result.trace.mergedRetrievalTopK
        input.telemetry.projectionTopK = result.trace.projectionTopK
        input.telemetry.projectedEvidenceNames = result.trace.projectedEvidenceNames
        input.telemetry.actualPromptEvidenceNames = result.trace.actualPromptEvidenceNames
        input.telemetry.droppedProjectedEvidenceNames = result.trace.droppedProjectedEvidenceNames
        input.telemetry.rawTop1Aligned = result.trace.rawTop1Aligned
        input.telemetry.retrievalRecallAligned = result.trace.retrievalRecallAligned
        input.telemetry.projectionSelectedStrongHelper = result.trace.projectionSelectedStrongHelper
        input.telemetry.promptContainsProjectedHelper = result.trace.promptContainsProjectedHelper
        input.telemetry.probeAffectsPrompt = result.trace.probeAffectsPrompt
        input.telemetry.probeCompleted = result.trace.probeCompleted
        input.telemetry.projectionToPromptDropReason = result.trace.projectionToPromptDropReason
        input.telemetry.submittedEvidenceNames = result.trace.submittedEvidenceNames
        input.telemetry.expectedSymbolInQaExactRetrieval = result.trace.expectedSymbolInQaExactRetrieval
        input.telemetry.expectedSymbolInFullRetrieval = result.trace.expectedSymbolInFullRetrieval
        input.telemetry.expectedSymbolInProjection = result.trace.expectedSymbolInProjection
        input.telemetry.expectedSymbolInPrompt = result.trace.expectedSymbolInPrompt
        input.telemetry.symbolPrefixRetrievalShape = result.trace.symbolPrefixRetrievalShape
        input.telemetry.symbolPrefixLocalTopK = result.trace.symbolPrefixLocalTopK
        input.telemetry.symbolPrefixProjectedEvidenceNames = result.trace.symbolPrefixProjectedEvidenceNames
        input.telemetry.symbolPrefixDroppedTargetSymbols = result.trace.symbolPrefixDroppedTargetSymbols
        input.telemetry.typedPrefixCompatibleCandidates = result.trace.typedPrefixCompatibleCandidates
        input.telemetry.typedPrefixCompatiblePromptNames = result.trace.typedPrefixCompatiblePromptNames
        input.telemetry.symbolPrefixSemanticQueryText = result.trace.symbolPrefixSemanticQueryText
        input.telemetry.symbolPrefixSemanticTopK = result.trace.symbolPrefixSemanticTopK
        input.telemetry.symbolPrefixGraphTopK = result.trace.symbolPrefixGraphTopK
        input.telemetry.symbolPrefixMergedTopK = result.trace.symbolPrefixMergedTopK
        input.telemetry.symbolPrefixRerankTopK = result.trace.symbolPrefixRerankTopK
        input.telemetry.symbolPrefixSemanticSelectedNames = result.trace.symbolPrefixSemanticSelectedNames
        input.telemetry.symbolPrefixPrefixCompatibleNames = result.trace.symbolPrefixPrefixCompatibleNames
        input.telemetry.symbolPrefixSemanticVsPrefixDiverged = result.trace.symbolPrefixSemanticVsPrefixDiverged
        input.telemetry.symbolPrefixSelectionReason = result.trace.symbolPrefixSelectionReason
        input.telemetry.symbolPrefixCurrentFunctionTokens = result.trace.symbolPrefixCurrentFunctionTokens
        input.telemetry.symbolPrefixNonPrefixDroppedNames = result.trace.symbolPrefixNonPrefixDroppedNames
        input.telemetry.symbolPrefixProjectionReasons = result.trace.symbolPrefixProjectionReasons
        input.telemetry.symbolPrefixCompatibilityScores = result.trace.symbolPrefixCompatibilityScores
        input.telemetry.fullRetrievalDebugDump = result.debugDump
        const text = result.text.trim()
        if (text) {
          this.logDebug(input.settings, `c-embedded-evidence selected=${result.selectedEvidenceCount} kinds="${quoteLogValue(result.evidenceKinds.join(","))}" fallback=${result.trace.ragFallbackTriggered ? "hybrid" : "none"} ${input.details}`)
        }
        return text
      }

      const options = completionAnalysisEvidenceOptions(input.document)
      input.telemetry.retrievalMode = mergeCompletionRetrievalMode(input.telemetry.retrievalMode, options.retrievalMode ?? "graph-only")
      const result = await this.deps.codeGraph.queryEvidence(question, options)
      const text = result?.evidencePack.text.trim() ?? ""
      if (text) {
        this.logDebug(input.settings, `analysis-evidence selected bytes=${text.length} ${input.details}`)
      }
      return text
    } catch (error) {
      this.logDebug(input.settings, `analysis-evidence skipped reason="${quoteLogValue(formatError(error))}" ${input.details}`)
      return ""
    }
  }

  private completionOutcomeFromResponse(input: {
    response: OpenCodeMessage | undefined
    document: vscode.TextDocument
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    selectedContextText?: string
    attempt: "initial" | "retry"
    textProfile: CompletionProfile
    telemetry: CompletionTelemetryDraft
    selectedCompletionInfo?: SelectedCompletionInfo
  }): CompletionRequestOutcome {
    const editInput = completionEditInputWithSymbolHints(input.editInput, input.retrievedSnippets, input.telemetry)
    const pipeline = runCompletionCandidatePipeline({
      response: input.response,
      textProfile: input.textProfile,
      editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      selectedCompletionInfo: selectedCompletionInfoValue(input.selectedCompletionInfo),
      documentSuffix: documentSuffixFromPosition(input.document, input.editInput.position),
    })
    updateTypedPrefixTelemetry(input.telemetry, pipeline)
    input.telemetry.rawOutputLength = pipeline.rawText.length
    input.telemetry.latencyMs.postprocess = pipeline.latencyMs.postprocess
    input.telemetry.normalizedOutputLength = pipeline.postprocessText.length
    input.telemetry.trimReason = completionTelemetryTrimReason(pipeline)
    input.telemetry.finalInsertLength = completionTelemetryFinalInsertLength(pipeline)
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
    const quality = this.validateInlineCompletionEditForReturn({
      edit: adaptedEdit,
      document: input.document,
      editInput: input.editInput,
      plan: input.plan,
      selectedCompletionInfo: input.selectedCompletionInfo,
      triggerKind: runtimeTriggerKindFromTelemetry(input.telemetry.triggerKind),
      selectedContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets),
    })
    if (quality.status === "rejected") {
      const fallback = this.completionOutcomeFromQualityFallback({
        rejectReason: quality.reason,
        document: input.document,
        settings: input.settings,
        details: input.details,
        started: input.started,
        editInput: input.editInput,
        plan: input.plan,
        retrievedSnippets: input.retrievedSnippets,
        selectedContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets),
        attempt: input.attempt,
        textProfile: input.textProfile,
        telemetry: input.telemetry,
        selectedCompletionInfo: input.selectedCompletionInfo,
      })
      if (fallback) return fallback
      this.logInfo(input.settings, `quality-rejected reason=${quality.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
      this.logCompletionTelemetry(input.settings, input.telemetry, input.started, false, quality.reason)
      return { status: "rejected", reason: quality.reason, source: "remote" }
    }
    const qualityEdit: QualityCompletionEdit = {
      ...quality.edit,
      qualityContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets),
    }
    input.telemetry.finalRange = qualityEdit.replaceRange ?? zeroWidthRange(input.editInput.position)
    input.telemetry.filterText = qualityEdit.filterText ?? qualityEdit.insertText
    this.logDebug(input.settings, `inline-invariant ${inlineCompletionInvariantDetails({
      edit: qualityEdit,
      editInput: input.editInput,
      plan: input.plan,
      rawFirstLine,
      postprocessFirstLine,
      postprocessDebug: pipeline.postprocessDebug,
      rejectReason: pipeline.rejectionReason,
      selectedCompletionInfo: input.selectedCompletionInfo,
    })} ${input.details}`)
    if (input.attempt === "retry") {
      this.logInfo(input.settings, `retry-edit-ready ${editDetails(qualityEdit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${qualityEdit.insertText.length}`)
    } else {
      this.logInfo(input.settings, `edit-ready ${editDetails(qualityEdit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${qualityEdit.insertText.length}`)
    }
    this.logDebug(input.settings, `edit ${editDetails(qualityEdit)} visibleChars=${pipeline.candidateText.length} ${input.details}`)
    this.logCompletionTelemetry(input.settings, input.telemetry, input.started, true)
    return { status: "ok", edit: qualityEdit, source: "remote" }
  }

  private completionOutcomeFromQualityFallback(input: {
    rejectReason: string
    document: vscode.TextDocument
    settings: RemoteSettings
    details: string
    started: number
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    retrievedSnippets: RetrievedCompletionSnippet[]
    selectedContextText?: string
    attempt: "initial" | "retry"
    textProfile: CompletionProfile
    telemetry: CompletionTelemetryDraft
    selectedCompletionInfo?: SelectedCompletionInfo
  }): CompletionRequestOutcome | undefined {
    const fallbackText = fallbackCompletionText({
      languageId: input.editInput.languageId,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      rejectReason: input.rejectReason,
    })
    if (!fallbackText) return

    const editInput = completionEditInputWithSymbolHints(input.editInput, input.retrievedSnippets, input.telemetry)
    const pipeline = runCompletionCandidatePipeline({
      rawText: fallbackText,
      textProfile: input.textProfile,
      editInput,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      selectedCompletionInfo: selectedCompletionInfoValue(input.selectedCompletionInfo),
      documentSuffix: documentSuffixFromPosition(input.document, input.editInput.position),
    })
    updateTypedPrefixTelemetry(input.telemetry, pipeline)
    input.telemetry.rawOutputLength = pipeline.rawText.length
    input.telemetry.latencyMs.postprocess = pipeline.latencyMs.postprocess
    input.telemetry.normalizedOutputLength = pipeline.postprocessText.length
    input.telemetry.trimReason = completionTelemetryTrimReason(pipeline)
    input.telemetry.finalInsertLength = completionTelemetryFinalInsertLength(pipeline)
    input.telemetry.latencyMs.edit = pipeline.latencyMs.edit
    const rawFirstLine = firstLogLine(pipeline.rawText)
    const postprocessFirstLine = firstLogLine(pipeline.postprocessText)
    if (pipeline.decision === "rejected" || !pipeline.edit) {
      const reason = pipeline.rejectionReason ?? "filtered-or-no-visible-text"
      this.logInfo(input.settings, `quality-fallback-rejected originalReason=${input.rejectReason} reason=${reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
      return
    }

    const quality = this.validateInlineCompletionEditForReturn({
      edit: pipeline.edit,
      document: input.document,
      editInput: input.editInput,
      plan: input.plan,
      selectedCompletionInfo: input.selectedCompletionInfo,
      triggerKind: runtimeTriggerKindFromTelemetry(input.telemetry.triggerKind),
      selectedContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets),
    })
    if (quality.status === "rejected") {
      this.logInfo(input.settings, `quality-fallback-rejected originalReason=${input.rejectReason} reason=${quality.reason} ${input.details} elapsedMs=${elapsedMs(input.started)}`)
      return
    }

    const qualityEdit: QualityCompletionEdit = {
      ...quality.edit,
      qualityContextText: input.selectedContextText ?? completionQualityContextText(input.retrievedSnippets),
    }
    input.telemetry.finalRange = qualityEdit.replaceRange ?? zeroWidthRange(input.editInput.position)
    input.telemetry.filterText = qualityEdit.filterText ?? qualityEdit.insertText
    this.logDebug(input.settings, `inline-invariant ${inlineCompletionInvariantDetails({
      edit: qualityEdit,
      editInput: input.editInput,
      plan: input.plan,
      rawFirstLine,
      postprocessFirstLine,
      postprocessDebug: pipeline.postprocessDebug,
      rejectReason: pipeline.rejectionReason,
      selectedCompletionInfo: input.selectedCompletionInfo,
    })} ${input.details}`)
    this.logInfo(input.settings, `quality-fallback-ready originalReason=${input.rejectReason} attempt=${input.attempt} ${editDetails(qualityEdit)} ${input.details} elapsedMs=${elapsedMs(input.started)} chars=${qualityEdit.insertText.length}`)
    this.logDebug(input.settings, `edit ${editDetails(qualityEdit)} visibleChars=${pipeline.candidateText.length} ${input.details}`)
    this.logCompletionTelemetry(input.settings, input.telemetry, input.started, true)
    return { status: "ok", edit: qualityEdit, source: "remote" }
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
    const sessionID = await this.getSession(client, signal)
    return client.sendMessage({
      sessionID,
      text: prompt,
      model: parseModel(settings.defaultModel),
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
      completionId: telemetry.completionId,
      languageId: telemetry.languageId,
      filePathHash: telemetry.filePathHash,
      triggerKind: telemetry.triggerKind,
      planKind: telemetry.planKind,
      cIntent: telemetry.cIntent,
      insertMode: telemetry.insertMode,
      currentWord: telemetry.currentWord,
      targetSymbol: telemetry.targetSymbol,
      sourceCommentHash: telemetry.sourceCommentHash,
      sourceCommentPreview: telemetry.sourceCommentPreview,
      commentGuidedSkipReason: telemetry.commentGuidedSkipReason,
      retrievalMode: telemetry.retrievalMode,
      evidenceKinds: telemetry.evidenceKinds,
      evidenceDroppedReason: telemetry.evidenceDroppedReason,
      droppedEvidenceKinds: telemetry.droppedEvidenceKinds,
      evidencePromptBlocks: telemetry.evidencePromptBlocks,
      evidencePromptTokens: telemetry.evidencePromptTokens,
      evidencePromptKinds: telemetry.evidencePromptKinds,
      contextLevel: telemetry.contextLevel,
      contextWarnings: telemetry.contextWarnings,
      normalizedCommentTokens: telemetry.normalizedCommentTokens,
      candidateTokenCoverage: telemetry.candidateTokenCoverage,
      semanticCandidateTopK: telemetry.semanticCandidateTopK,
      selectedSimilarFunctionNames: telemetry.selectedSimilarFunctionNames,
      retrievalElapsedMs: telemetry.retrievalElapsedMs,
      retrievalBudgetMs: telemetry.retrievalBudgetMs,
      retrievalTimedOut: telemetry.retrievalTimedOut,
      timeoutStage: telemetry.timeoutStage,
      qaAlignedEvidence: telemetry.qaAlignedEvidence,
      qaTopCandidate: telemetry.qaTopCandidate,
      completionTopCandidate: telemetry.completionTopCandidate,
      sharedTopCandidate: telemetry.sharedTopCandidate,
      qaRetrievalTopK: telemetry.qaRetrievalTopK,
      completionRetrievalTopK: telemetry.completionRetrievalTopK,
      alignmentReason: telemetry.alignmentReason,
      rerankEnabled: telemetry.rerankEnabled,
      ragAvailable: telemetry.ragAvailable,
      latencyBudgetMs: telemetry.latencyBudgetMs,
      maxEvidence: telemetry.maxEvidence,
      evidenceRoles: telemetry.evidenceRoles,
      generationModeHint: telemetry.generationModeHint,
      helperCallableConfidence: telemetry.helperCallableConfidence,
      callableHelperCandidates: telemetry.callableHelperCandidates,
      styleExampleCandidates: telemetry.styleExampleCandidates,
      qaStyleTopK: telemetry.qaStyleTopK,
      completionProjectionTopK: telemetry.completionProjectionTopK,
      droppedAlignedEvidence: telemetry.droppedAlignedEvidence,
      cursorContextFeatures: telemetry.cursorContextFeatures,
      cursorContextScope: telemetry.cursorContextScope,
      currentFunctionBodyIsEmpty: telemetry.currentFunctionBodyIsEmpty,
      scopedPreviousStatementCalls: telemetry.scopedPreviousStatementCalls,
      scopedNextStatementCalls: telemetry.scopedNextStatementCalls,
      cursorContextFallbackReason: telemetry.cursorContextFallbackReason,
      fullRetrievalCandidateCount: telemetry.fullRetrievalCandidateCount,
      projectionCandidateCount: telemetry.projectionCandidateCount,
      retrievalShape: telemetry.retrievalShape,
      qaExactTopK: telemetry.qaExactTopK,
      qaExactSubmittedEvidence: telemetry.qaExactSubmittedEvidence,
      qaExactContextTopK: telemetry.qaExactContextTopK,
      semanticQueryText: telemetry.semanticQueryText,
      graphQuestionTextHash: telemetry.graphQuestionTextHash,
      semanticTopK: telemetry.semanticTopK,
      graphTopK: telemetry.graphTopK,
      mergedTopK: telemetry.mergedTopK,
      selectedPromptEvidenceNames: telemetry.selectedPromptEvidenceNames,
      rawSemanticTopK: telemetry.rawSemanticTopK,
      rawGraphTopK: telemetry.rawGraphTopK,
      mergedRetrievalTopK: telemetry.mergedRetrievalTopK,
      projectionTopK: telemetry.projectionTopK,
      projectedEvidenceNames: telemetry.projectedEvidenceNames,
      actualPromptEvidenceNames: telemetry.actualPromptEvidenceNames,
      droppedProjectedEvidenceNames: telemetry.droppedProjectedEvidenceNames,
      rawTop1Aligned: telemetry.rawTop1Aligned,
      retrievalRecallAligned: telemetry.retrievalRecallAligned,
      projectionSelectedStrongHelper: telemetry.projectionSelectedStrongHelper,
      promptContainsProjectedHelper: telemetry.promptContainsProjectedHelper,
      probeAffectsPrompt: telemetry.probeAffectsPrompt,
      probeCompleted: telemetry.probeCompleted,
      projectionToPromptDropReason: telemetry.projectionToPromptDropReason,
      submittedEvidenceNames: telemetry.submittedEvidenceNames,
      expectedSymbolInQaExactRetrieval: telemetry.expectedSymbolInQaExactRetrieval,
      expectedSymbolInFullRetrieval: telemetry.expectedSymbolInFullRetrieval,
      expectedSymbolInProjection: telemetry.expectedSymbolInProjection,
      expectedSymbolInPrompt: telemetry.expectedSymbolInPrompt,
      fullRetrievalProbeDumpPath: telemetry.fullRetrievalProbeDumpPath,
      typedPrefixAdapted: telemetry.typedPrefixAdapted,
      typedPrefixAdaptReason: telemetry.typedPrefixAdaptReason,
      typedPrefixCurrentWord: telemetry.typedPrefixCurrentWord,
      typedPrefixMatchedSymbol: telemetry.typedPrefixMatchedSymbol,
      typedPrefixOriginalFirstLine: telemetry.typedPrefixOriginalFirstLine,
      typedPrefixFinalFirstLine: telemetry.typedPrefixFinalFirstLine,
      deterministicSymbolSuppressed: telemetry.deterministicSymbolSuppressed,
      deterministicSymbolSuppressReason: telemetry.deterministicSymbolSuppressReason,
      symbolPrefixCandidateTopK: telemetry.symbolPrefixCandidateTopK,
      symbolPrefixContextTokens: telemetry.symbolPrefixContextTokens,
      symbolPrefixRoute: telemetry.symbolPrefixRoute,
      symbolPrefixRetrievalShape: telemetry.symbolPrefixRetrievalShape,
      symbolPrefixLocalTopK: telemetry.symbolPrefixLocalTopK,
      symbolPrefixProjectedEvidenceNames: telemetry.symbolPrefixProjectedEvidenceNames,
      symbolPrefixDroppedTargetSymbols: telemetry.symbolPrefixDroppedTargetSymbols,
      typedPrefixCompatibleCandidates: telemetry.typedPrefixCompatibleCandidates,
      typedPrefixCompatiblePromptNames: telemetry.typedPrefixCompatiblePromptNames,
      symbolPrefixSemanticQueryText: telemetry.symbolPrefixSemanticQueryText,
      symbolPrefixSemanticTopK: telemetry.symbolPrefixSemanticTopK,
      symbolPrefixGraphTopK: telemetry.symbolPrefixGraphTopK,
      symbolPrefixMergedTopK: telemetry.symbolPrefixMergedTopK,
      symbolPrefixRerankTopK: telemetry.symbolPrefixRerankTopK,
      symbolPrefixSemanticSelectedNames: telemetry.symbolPrefixSemanticSelectedNames,
      symbolPrefixPrefixCompatibleNames: telemetry.symbolPrefixPrefixCompatibleNames,
      symbolPrefixSemanticVsPrefixDiverged: telemetry.symbolPrefixSemanticVsPrefixDiverged,
      symbolPrefixSelectionReason: telemetry.symbolPrefixSelectionReason,
      symbolPrefixCurrentFunctionTokens: telemetry.symbolPrefixCurrentFunctionTokens,
      symbolPrefixNonPrefixDroppedNames: telemetry.symbolPrefixNonPrefixDroppedNames,
      symbolPrefixProjectionReasons: telemetry.symbolPrefixProjectionReasons,
      symbolPrefixCompatibilityScores: telemetry.symbolPrefixCompatibilityScores,
      promptKind: telemetry.promptKind,
      symbolCandidates: telemetry.symbolCandidates,
      selectedContextBlocks: telemetry.selectedContextBlocks,
      droppedContextBlocks: telemetry.droppedContextBlocks,
      modelRoute: telemetry.modelRoute,
      rawOutputLength: telemetry.rawOutputLength,
      normalizedOutputLength: telemetry.normalizedOutputLength,
      trimReason: telemetry.trimReason,
      finalInsertLength: telemetry.finalInsertLength,
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
    const cacheValidation = source === "cache" ? " revalidated=true" : ""
    this.logInfo(settings, `returned source=${source}${cacheValidation} ${editDetails(edit)} ${details} elapsedMs=${elapsedMs(started)} chars=${edit.insertText.length}`)
  }

  private triggerInlineSuggestRefresh(
    document: vscode.TextDocument,
    metadata: CompletionRequestCacheMetadata,
    settings: RemoteSettings,
    details: string,
  ) {
    const active = vscode.window.activeTextEditor
    if (!active || active.document.uri.toString() !== document.uri.toString()) return false
    if (!activeEditorStillCompatible(active, metadata)) return false

    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger").then(
      () => this.logDebug(settings, `refresh-inline-suggest ${details}`),
      (error: unknown) => this.logDebug(settings, `refresh-inline-suggest failed=${formatError(error)} ${details}`),
    )
    return true
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
    triggerKind: CEmbeddedTriggerKind
  }) {
    const validation = this.validateInlineCompletionEditForReturn({
      edit: input.edit,
      document: input.document,
      editInput: input.editInput,
      plan: input.plan,
      selectedCompletionInfo: input.selectedCompletionInfo,
      triggerKind: input.triggerKind,
      selectedContextText: (input.edit as QualityCompletionEdit).qualityContextText,
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

  private validateInlineCompletionEditForReturn(input: {
    edit: CompletionEdit
    document: vscode.TextDocument
    editInput: Omit<CompletionEditInput, "text">
    plan: CompletionPlan
    selectedCompletionInfo?: SelectedCompletionInfo
    triggerKind: CEmbeddedTriggerKind
    selectedContextText?: string
  }) {
    const validation = adaptAndValidateInlineCompletionEdit({
      edit: input.edit,
      editInput: input.editInput,
      plan: input.plan,
      selectedCompletionInfo: selectedCompletionInfoValue(input.selectedCompletionInfo),
    })
    if (validation.status === "rejected") return validation
    if (!isCEmbeddedLanguage(input.editInput.languageId)) return validation

    const originalText = input.document.getText()
    const appliedText = applyCompletionEditToText(originalText, validation.edit, input.editInput.position)
    const selectedContextText = input.selectedContextText || runtimeOpenDocumentContext(input.document)
    const score = scoreCEmbeddedCompletionQuality({
      fixture: runtimeCEmbeddedFixture({
        documentText: originalText,
        languageId: input.editInput.languageId,
        triggerKind: input.triggerKind,
        openTabs: runtimeOpenTabs(input.document),
      }),
      decision: "accepted",
      acceptedText: validation.edit.insertText,
      appliedText,
      originalText,
      linePrefix: input.editInput.linePrefix,
      lineSuffix: input.editInput.lineSuffix,
      edit: validation.edit,
      repeatAcceptedTexts: [validation.edit.insertText],
      repeatDecisions: ["accepted"],
      latencyMs: 0,
      selectedContextText,
    })
    const hardReject = score.issues.find((issue) => issue.hardReject)
    if (hardReject) {
      return {
        status: "rejected" as const,
        reason: `quality:${hardReject.kind}` as const,
      }
    }
    return validation
  }
}

function runtimeTriggerKind(kind: vscode.InlineCompletionTriggerKind | undefined): CEmbeddedTriggerKind {
  return kind === vscode.InlineCompletionTriggerKind.Automatic ? "automatic" : "manual"
}

function runtimeTriggerKindFromTelemetry(kind: CompletionTelemetryDraft["triggerKind"]): CEmbeddedTriggerKind {
  return kind === "automatic" ? "automatic" : "manual"
}

function isCEmbeddedLanguage(languageId: string) {
  return languageId === "c" || languageId === "cpp"
}

function runtimeCEmbeddedFixture(input: {
  documentText: string
  languageId: string
  triggerKind: CEmbeddedTriggerKind
  openTabs: CEmbeddedCompletionFixture["openTabs"]
}): CEmbeddedCompletionFixture {
  return {
    id: "runtime-c-embedded",
    category: "runtime C/embedded",
    languageId: input.languageId,
    path: "runtime.c",
    document: input.documentText,
    openTabs: input.openTabs,
    triggerKind: input.triggerKind,
    expectedIntent: "runtime C/embedded inline completion quality gate",
    mustContain: [],
    mustNotContain: [],
    maxLines: input.triggerKind === "automatic" ? 4 : 12,
    checks: [
      "checkVscodeContract",
      "checkApplyEditResult",
      "checkCParseOrCompile",
      "checkNoMarkdownOrExplanation",
      "checkNoPlaceholder",
      "checkNoDangerousC",
      "checkNoHallucinatedSymbol",
      "checkEmbeddedSafety",
    ],
  }
}

function runtimeOpenTabs(currentDocument: vscode.TextDocument): NonNullable<CEmbeddedCompletionFixture["openTabs"]> {
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === "file")
    .filter((document) => document.uri.toString() !== currentDocument.uri.toString())
    .slice(0, 12)
    .map((document) => ({
      path: relativePath(document.uri),
      languageId: document.languageId,
      text: document.getText(),
    }))
}

function runtimeOpenDocumentContext(currentDocument: vscode.TextDocument) {
  return [
    currentDocument.getText(),
    ...runtimeOpenTabs(currentDocument).map((tab) => tab.text),
  ].join("\n")
}

function completionQualityContextText(snippets: RetrievedCompletionSnippet[]) {
  return snippets.map((snippet) => `${snippet.name ?? ""}\n${snippet.text}`).join("\n")
}

function applyCompletionEditToText(text: string, edit: CompletionEdit, position: CompletionEditInput["position"]) {
  const range = edit.replaceRange ?? zeroWidthRange(position)
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const startLine = lines[range.startLine] ?? ""
  const endLine = lines[range.endLine] ?? ""
  const before = lines.slice(0, range.startLine)
  const after = lines.slice(range.endLine + 1)
  const replacement = `${startLine.slice(0, range.startCharacter)}${edit.insertText}${endLine.slice(range.endCharacter)}`
  return [...before, ...replacement.split("\n"), ...after].join("\n")
}

function documentSuffixFromPosition(document: vscode.TextDocument, position: CompletionEditInput["position"]) {
  const lastLine = document.lineCount - 1
  return document.getText(new vscode.Range(
    position.line,
    position.character,
    lastLine,
    document.lineAt(lastLine).text.length,
  ))
}

function completionRetryPrompt(prompt: string, editInput: Omit<CompletionEditInput, "text">, reason: string, textProfile: CompletionProfile) {
  const currentLine = truncateFeedback(`${editInput.linePrefix}${editInput.lineSuffix}`)
  const cursorPrefix = truncateFeedback(editInput.linePrefix)
  const feedback = completionRetryFeedback(reason, currentLine)
  if (textProfile === "qwen-coder-fim") {
    return completionFimRetryPrompt(prompt, feedback, cursorPrefix)
  }
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

function completionFimRetryPrompt(prompt: string, feedback: string, cursorPrefix: string) {
  const marker = "<|fim_prefix|>"
  const feedbackBlock = [
    "/* Completion retry feedback.",
    feedback,
    `The cursor is after the prefix "${quoteLogValue(cursorPrefix)}".`,
    "Return only the exact FIM middle insertion text.",
    "End completion retry feedback. */",
    "",
  ].join("\n")
  if (!prompt.includes(marker)) return `${feedbackBlock}${prompt}`
  return prompt.replace(marker, `${feedbackBlock}${marker}`)
}

function completionRetryFeedback(reason: string, currentLine: string) {
  switch (reason) {
    case "low-intent-output":
      return "Previous completion was rejected because it was generic success code that did not satisfy the source comment. Generate the smallest concrete code for the comment using visible local variables, existing cleanup/error style, and surrounding suffix context."
    case "suffix-duplicated-output":
      return "Previous completion was rejected because it copied code that already exists after the cursor. Generate only the missing code that belongs before the suffix; do not repeat the suffix."
    case "low-confidence-output":
      return "Previous completion was rejected because it contained only structural punctuation or otherwise lacked meaningful code."
    case "quality:placeholder":
      return "Previous completion was rejected because it contained placeholder text or scaffold-only code. Return concrete C/C++ code using visible symbols; do not use placeholder names such as condition, TODO, value, or test body."
    case "quality:C parse/compile":
      return `Previous completion was rejected because the applied C/C++ fragment did not parse in the current line "${quoteLogValue(currentLine)}". Return only a syntactically valid fragment for this exact prefix/suffix; preserve existing parentheses, braces, semicolons, and suffix text.`
    case "quality:markdown/explanation":
      return "Previous completion was rejected because it contained Markdown, backticks, fences, or explanatory prose. Return raw code only."
    default:
      return `Previous completion was rejected because it began with blank lines and did not continue the current line "${quoteLogValue(currentLine)}".`
  }
}

function completionRequestKey(document: vscode.TextDocument, position: vscode.Position, lineText: string, settings: RemoteSettings, plan: CompletionPlan) {
  return [
    document.uri.toString(),
    document.languageId,
    settings.completion.provider,
    settings.completion.profile,
    settings.completion.provider === "openai-compatible" ? document.version : "",
    position.line,
    position.character,
    lineText,
    plan.sourceComment ?? "",
    firstSuffixLineFromPosition(document, position),
  ].join("\u0000")
}

function completionRequestCacheMetadata(
  document: vscode.TextDocument,
  position: vscode.Position,
  linePrefix: string,
  plan: CompletionPlan,
): CompletionRequestCacheMetadata {
  return {
    documentUri: document.uri.toString(),
    languageId: document.languageId,
    line: position.line,
    position: {
      line: position.line,
      character: position.character,
    },
    linePrefix,
    firstSuffixLine: firstSuffixLineFromPosition(document, position),
    planKind: plan.kind,
    sourceComment: plan.sourceComment ?? "",
  }
}

function activeEditorStillCompatible(editor: vscode.TextEditor, metadata: CompletionRequestCacheMetadata) {
  const active = editor.selection.active
  if (active.line !== metadata.position.line) return false
  if (active.character < metadata.position.character) return false
  if (metadata.line < 0 || metadata.line >= editor.document.lineCount) return false
  const lineText = editor.document.lineAt(metadata.line).text
  const currentPrefix = lineText.slice(0, active.character)
  if (!currentPrefix.startsWith(metadata.linePrefix)) return false
  return firstSuffixLineFromPosition(editor.document, active) === metadata.firstSuffixLine
}

function firstSuffixLineFromPosition(document: vscode.TextDocument, position: vscode.Position) {
  const currentSuffix = document.lineAt(position.line).text.slice(position.character)
  if (currentSuffix.trim()) return currentSuffix.trim()
  for (let line = position.line + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text.trim()
    if (text) return text
  }
  return ""
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

function routeRequestDetails(route: CompletionModelRoute, settings: RemoteSettings) {
  if (route.kind !== "model") return ""
  const transport = route.modelProfile === "qwen-coder-fim" ? "raw-completions" : "chat-completions"
  return [
    `configuredProfile=${settings.completion.profile}`,
    `effectiveProfile=${route.modelProfile}`,
    `promptKind=${route.promptKind}`,
    settings.completion.provider === "openai-compatible"
      ? `transport=${transport}`
      : "",
  ].filter(Boolean).join(" ")
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

function completionEvidenceQuestion(input: {
  document: vscode.TextDocument
  position: vscode.Position
  plan: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
  retrievalEvidenceQuestion?: string
}) {
  const lineText = input.document.lineAt(input.position.line).text.trim()
  const functionName = cLikeFunctionNameNearPosition(input.document, input.position)
  const symbols = uniqueNonEmpty([
    input.plan.targetSymbol,
    ...input.retrievedSnippets.map((snippet) => snippet.name),
  ]).slice(0, 8)
  const nearbyCommentTokens = nearbyCompletionCommentTokens(input.document, input.position)
  const parts = [
    `inline completion for ${input.document.languageId} file ${relativePath(input.document.uri)}`,
    `current-path: ${relativePath(input.document.uri)}`,
    `plan ${input.plan.kind}`,
    input.plan.cIntent && input.plan.kind !== "comment-guided-c-code" ? `completion-intent: ${input.plan.cIntent}` : "",
    functionName ? `function: ${functionName}` : "",
    nearbyCommentTokens.length ? `nearby-comment-tokens: ${nearbyCommentTokens.join(" ")}` : "",
    symbols.length ? `symbols ${symbols.join(" ")}` : "",
    symbols.length ? `symbols: ${symbols.join(" ")}` : "",
    input.plan.sourceComment ? `source-comment: ${input.plan.sourceComment}` : "",
    input.retrievalEvidenceQuestion,
    lineText ? `cursor line ${lineText}` : "",
  ].filter(Boolean)
  return parts.join("\n")
}

function completionRetrievalPrefix(document: vscode.TextDocument, position: vscode.Position) {
  const before = Math.max(0, position.line - 80)
  return document.getText(new vscode.Range(before, 0, position.line, position.character))
}

function completionRetrievalSuffix(document: vscode.TextDocument, position: vscode.Position) {
  const after = Math.min(document.lineCount - 1, position.line + 60)
  return document.getText(new vscode.Range(position.line, position.character, after, document.lineAt(after).text.length))
}

function completionScopedCursorContextWindow(document: vscode.TextDocument, position: vscode.Position) {
  if (!isCEmbeddedLanguage(document.languageId)) {
    return {
      cursorPrefix: completionRetrievalPrefix(document, position),
      cursorSuffix: completionRetrievalSuffix(document, position),
      cursorContextScope: "file-window-fallback" as const,
      currentFunctionBodyIsEmpty: false,
      cursorContextFallbackReason: "non-c-language",
    }
  }
  const text = document.getText()
  const cursorOffset = completionDocumentOffsetAt(document, position, text)
  const scope = findCFunctionScopeAtOffset(text, cursorOffset)
  if (!scope) {
    return {
      cursorPrefix: completionRetrievalPrefix(document, position),
      cursorSuffix: completionRetrievalSuffix(document, position),
      cursorContextScope: "file-window-fallback" as const,
      currentFunctionBodyIsEmpty: false,
      cursorContextFallbackReason: "function-boundary-not-found",
    }
  }
  const bodyPrefix = text.slice(scope.openBrace + 1, cursorOffset)
  const bodySuffix = text.slice(cursorOffset, scope.closeBrace)
  return {
    cursorPrefix: text.slice(scope.headerStart, cursorOffset),
    cursorSuffix: text.slice(cursorOffset, scope.closeBrace + 1),
    cursorContextScope: "current-function" as const,
    currentFunctionBodyIsEmpty: cFunctionBodyIsEmpty(bodyPrefix, bodySuffix),
    cursorContextFallbackReason: undefined,
  }
}

function findCFunctionScopeAtOffset(text: string, cursorOffset: number) {
  const stack = cBraceStackBeforeOffset(text, cursorOffset)
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const openBrace = stack[index]!
    const header = cFunctionHeaderBeforeBrace(text, openBrace)
    if (!header) continue
    const closeBrace = findMatchingCBrace(text, openBrace)
    if (closeBrace < cursorOffset) continue
    return {
      headerStart: header.headerStart,
      openBrace,
      closeBrace,
    }
  }
  return undefined
}

function completionDocumentOffsetAt(document: vscode.TextDocument, position: vscode.Position, text: string) {
  const offsetAt = (document as { offsetAt?: (position: vscode.Position) => number }).offsetAt
  if (typeof offsetAt === "function") return offsetAt.call(document, position)
  const lines = text.split(/\r?\n/)
  let offset = 0
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
    offset += (lines[line]?.length ?? 0) + 1
  }
  return offset + position.character
}

function cFunctionHeaderBeforeBrace(text: string, openBrace: number) {
  const previousSeparators = [
    text.lastIndexOf(";", openBrace - 1),
    text.lastIndexOf("}", openBrace - 1),
    text.lastIndexOf("{", openBrace - 1),
  ]
  const segmentStart = Math.max(0, Math.max(...previousSeparators) + 1)
  const segment = text.slice(segmentStart, openBrace)
  const trimmedStart = segment.search(/\S/)
  if (trimmedStart < 0) return undefined
  const headerText = segment.slice(trimmedStart)
  const match = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*$/.exec(headerText)
  const name = match?.[1]
  if (!name || C_CONTROL_HEAD_NAMES.has(name)) return undefined
  return {
    headerStart: segmentStart + trimmedStart,
    name,
  }
}

function cBraceStackBeforeOffset(text: string, offset: number) {
  const stack: number[] = []
  scanCText(text, offset, (char, index) => {
    if (char === "{") stack.push(index)
    if (char === "}") stack.pop()
  })
  return stack
}

function findMatchingCBrace(text: string, openBrace: number) {
  let depth = 0
  let closeBrace = text.length
  scanCText(text, text.length, (char, index) => {
    if (index < openBrace) return
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        closeBrace = index
        return false
      }
    }
    return undefined
  })
  return closeBrace
}

function scanCText(text: string, limit: number, visit: (char: string, index: number) => false | void) {
  let state: "code" | "line-comment" | "block-comment" | "string" | "char" = "code"
  for (let index = 0; index < Math.min(limit, text.length); index += 1) {
    const char = text[index]!
    const next = text[index + 1]
    if (state === "line-comment") {
      if (char === "\n") state = "code"
      continue
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        index += 1
        state = "code"
      }
      continue
    }
    if (state === "string") {
      if (char === "\\") {
        index += 1
      } else if (char === "\"") {
        state = "code"
      }
      continue
    }
    if (state === "char") {
      if (char === "\\") {
        index += 1
      } else if (char === "'") {
        state = "code"
      }
      continue
    }
    if (char === "/" && next === "/") {
      index += 1
      state = "line-comment"
      continue
    }
    if (char === "/" && next === "*") {
      index += 1
      state = "block-comment"
      continue
    }
    if (char === "\"") {
      state = "string"
      continue
    }
    if (char === "'") {
      state = "char"
      continue
    }
    if (visit(char, index) === false) return
  }
}

function cFunctionBodyIsEmpty(prefix: string, suffix: string) {
  return stripCCommentsAndStrings(`${prefix}\n${suffix}`)
    .replace(/^\s*#.*$/gm, "")
    .trim().length === 0
}

function stripCCommentsAndStrings(text: string) {
  let output = ""
  scanCText(text, text.length, (char) => {
    output += char
  })
  return output
}

const C_CONTROL_HEAD_NAMES = new Set(["if", "for", "while", "switch", "return", "sizeof"])

function nearbyCompletionCommentTokens(document: vscode.TextDocument, position: vscode.Position) {
  if (!isCEmbeddedLanguage(document.languageId)) return []
  const tokens: string[] = []
  for (let line = position.line; line >= Math.max(0, position.line - 8); line -= 1) {
    const raw = document.lineAt(line).text
    const text = line === position.line ? raw.slice(0, position.character) : raw
    const commentText = commentPortion(text)
    if (!commentText) continue
    tokens.push(...(commentText.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []))
  }
  return uniqueNonEmpty(tokens.reverse()).slice(-8)
}

function commentPortion(line: string) {
  const slash = line.indexOf("//")
  if (slash >= 0) return line.slice(slash + 2)
  const block = line.indexOf("/*")
  if (block >= 0) return line.slice(block + 2)
  const continuation = /^\s*\*\s?(.*)$/.exec(line)
  return continuation?.[1] ?? ""
}

function completionAnalysisEvidenceOptions(document: vscode.TextDocument): CodeGraphEvidenceQueryOptions {
  return {
    retrievalMode: "hybrid",
    relatedPaths: [relativePath(document.uri)],
  }
}

function cLikeFunctionNameNearPosition(document: vscode.TextDocument, position: vscode.Position) {
  if (document.languageId !== "c" && document.languageId !== "cpp") return ""
  const keywords = new Set(["if", "for", "while", "switch", "return", "sizeof"])
  for (let line = position.line; line >= Math.max(0, position.line - 80); line -= 1) {
    const text = document.lineAt(line).text
    const match = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*$/.exec(text) ??
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:\{|$)/.exec(text)
    const name = match?.[1]
    if (name && !keywords.has(name)) return name
  }
  return ""
}

function completionSymbolRetrievalLimit(plan: CompletionPlan) {
  if (plan.kind === "comment-symbol-reference") return 50
  return plan.needsTestRetrieval ? 30 : 8
}

function updateCompletionTelemetryPlan(telemetry: CompletionTelemetryDraft, plan: CompletionPlan) {
  telemetry.planKind = plan.kind
  telemetry.insertMode = plan.insertMode
  telemetry.targetSymbol = plan.targetSymbol
  telemetry.cIntent = plan.cIntent
  telemetry.sourceCommentHash = plan.sourceComment ? filePathHash(plan.sourceComment) : undefined
  telemetry.sourceCommentPreview = plan.sourceComment
  telemetry.commentGuidedSkipReason = plan.commentGuidedSkipReason
}

function updateCompletionTelemetryRoute(telemetry: CompletionTelemetryDraft, route: CompletionModelRoute) {
  if (route.kind === "deterministic-symbol") {
    telemetry.symbolPrefixRoute = telemetry.cIntent === "symbol-prefix" ? "deterministic-symbol" : undefined
    return
  }
  if (route.kind !== "model") return
  telemetry.deterministicSymbolSuppressed = route.deterministicSymbolSuppressed
  telemetry.deterministicSymbolSuppressReason = route.deterministicSymbolSuppressReason
  telemetry.symbolPrefixCandidateTopK = route.symbolPrefixCandidateTopK
  telemetry.symbolPrefixRoute = route.symbolPrefixRoute
}

function completionEditInputWithSymbolHints(
  editInput: Omit<CompletionEditInput, "text">,
  snippets: RetrievedCompletionSnippet[],
  telemetry: CompletionTelemetryDraft,
): Omit<CompletionEditInput, "text"> {
  const symbolHints = completionEditSymbolHints(snippets, telemetry)
  return symbolHints.length > 0 ? { ...editInput, symbolHints } : editInput
}

function completionEditSymbolHints(snippets: RetrievedCompletionSnippet[], telemetry: CompletionTelemetryDraft) {
  return uniqueNonEmpty([
    ...snippets.map((snippet) => snippet.name ?? ""),
    ...completionTelemetryNameList(telemetry.selectedSimilarFunctionNames),
    ...completionTelemetryNameList(telemetry.qaRetrievalTopK),
    ...completionTelemetryNameList(telemetry.completionRetrievalTopK),
    ...completionTelemetryNameList(telemetry.qaStyleTopK),
    ...completionTelemetryNameList(telemetry.completionProjectionTopK),
    ...completionTelemetryNameList(telemetry.qaExactTopK),
    ...completionTelemetryNameList(telemetry.qaExactSubmittedEvidence),
    ...completionTelemetryNameList(telemetry.qaExactContextTopK),
    ...completionTelemetryNameList(telemetry.semanticTopK),
    ...completionTelemetryNameList(telemetry.graphTopK),
    ...completionTelemetryNameList(telemetry.mergedTopK),
    ...completionTelemetryNameList(telemetry.rawSemanticTopK),
    ...completionTelemetryNameList(telemetry.rawGraphTopK),
    ...completionTelemetryNameList(telemetry.mergedRetrievalTopK),
    ...completionTelemetryNameList(telemetry.projectionTopK),
    ...completionTelemetryNameList(telemetry.projectedEvidenceNames),
    ...completionTelemetryNameList(telemetry.actualPromptEvidenceNames),
    ...completionTelemetryNameList(telemetry.selectedPromptEvidenceNames),
    ...completionTelemetryNameList(telemetry.submittedEvidenceNames),
    ...completionTelemetryNameList(telemetry.callableHelperCandidates),
    ...completionTelemetryNameList(telemetry.styleExampleCandidates),
    ...completionTelemetryNameList(telemetry.droppedAlignedEvidence),
    ...completionTelemetryNameList(telemetry.droppedProjectedEvidenceNames),
    ...completionTelemetryNameList(telemetry.qaTopCandidate ? [telemetry.qaTopCandidate] : []),
    ...completionTelemetryNameList(telemetry.completionTopCandidate ? [telemetry.completionTopCandidate] : []),
    ...completionTelemetryNameList(telemetry.sharedTopCandidate ? [telemetry.sharedTopCandidate] : []),
    ...(telemetry.symbolCandidates ?? []).map((candidate) => candidate.name),
    ...(telemetry.selectedContextBlocks ?? []).flatMap((block) => completionIdentifierNames(block.title)),
  ]).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).slice(0, 80)
}

function completionTelemetryNameList(values: string[] | undefined) {
  return (values ?? []).flatMap(completionIdentifierNames)
}

function completionIdentifierNames(text: string) {
  return text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
}

function updateTypedPrefixTelemetry(telemetry: CompletionTelemetryDraft, pipeline: CompletionCandidatePipelineResult) {
  const typedPrefix = pipeline.typedPrefixAdaptation
  telemetry.typedPrefixAdapted = Boolean(typedPrefix)
  if (!typedPrefix) return
  telemetry.typedPrefixAdaptReason = typedPrefix.reason
  telemetry.typedPrefixCurrentWord = typedPrefix.currentWord
  telemetry.typedPrefixMatchedSymbol = typedPrefix.matchedSymbol
  telemetry.typedPrefixOriginalFirstLine = typedPrefix.originalFirstLine
  telemetry.typedPrefixFinalFirstLine = typedPrefix.finalFirstLine
}

function completionTelemetryPromptKind(route: CompletionModelRoute): NonNullable<CompletionDebugEvent["promptKind"]> {
  if (route.kind === "none") return "none"
  if (route.kind === "deterministic-symbol") return "deterministic-symbol"
  return route.promptKind
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

function completionPlannerLogDetails(plan: CompletionPlan, extensionVersion: string | undefined) {
  return [
    `plannerRevision=${COMPLETION_PLANNER_REVISION}`,
    extensionVersion ? `extensionVersion=${quoteLogValue(extensionVersion)}` : "",
    `planKind=${plan.kind}`,
    plan.cIntent ? `cIntent=${quoteLogValue(plan.cIntent)}` : "",
    plan.targetSymbol ? `targetSymbol="${quoteLogValue(plan.targetSymbol)}"` : "",
    plan.sourceComment ? `sourceCommentPreview="${quoteLogValue(truncateLine(plan.sourceComment))}"` : "",
    plan.commentGuidedSkipReason ? `commentGuidedSkipReason=${quoteLogValue(plan.commentGuidedSkipReason)}` : "",
  ].filter(Boolean).join(" ")
}

function quoteLogValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function safeFileName(input: string) {
  return input.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120) || "completion-debug"
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

function nextNonEmptyLineAfter(lines: string[], line: number) {
  for (let index = line + 1; index < lines.length; index++) {
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
  const enumValues = vscode.InlineCompletionTriggerKind
  if (enumValues && kind === enumValues.Invoke) return "invoke"
  if (enumValues && kind === enumValues.Automatic) return "automatic"
  return kind === undefined ? undefined : String(kind)
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

function completionTelemetryEvidenceKinds(pack: CompletionContextPack, existing: string[] | undefined) {
  const kinds = new Set([
    ...(existing ?? []),
    ...pack.selected.map((block) => block.kind),
  ])
  return [...kinds].sort()
}

function completionTelemetryDroppedEvidenceKinds(pack: CompletionContextPack) {
  const kinds = new Set(
    pack.dropped
      .filter((block) => block.kind === "analysis-evidence" || block.kind === "c-embedded-evidence")
      .map((block) => block.kind === "c-embedded-evidence" ? block.title.split(":")[0]?.trim() || block.kind : block.kind),
  )
  return [...kinds].sort()
}

function completionTelemetryPromptEvidence(pack: CompletionContextPack) {
  const blocks = pack.selected.filter((block) => block.kind === "analysis-evidence" || block.kind === "c-embedded-evidence")
  return {
    blocks: blocks.length,
    tokens: blocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
    kinds: uniqueNonEmpty(blocks.map((block) => block.kind === "c-embedded-evidence" ? block.title.split(":")[0]?.trim() : block.kind)),
  }
}

function completionTelemetryActualPromptEvidenceNames(pack: CompletionContextPack) {
  return uniqueNonEmpty(pack.selected
    .filter((block) => block.kind === "c-embedded-evidence")
    .map((block) =>
      /^Symbol:\s*(.+)$/m.exec(block.text)?.[1]?.trim() ??
        /^c-[A-Za-z0-9-]+:\s*(.+)$/.exec(block.title)?.[1]?.trim() ??
        ""))
    .slice(0, 8)
}

function completionTelemetryDroppedSymbolPrefixTargets(telemetry: CompletionTelemetryDraft, pack: CompletionContextPack) {
  const raw = telemetry.symbolPrefixCandidateTopK ?? []
  if (raw.length === 0) return telemetry.symbolPrefixDroppedTargetSymbols
  const selectedTargetText = pack.selected
    .filter((block) => block.kind === "target-symbol")
    .map((block) => `${block.title}\n${block.text}`)
    .join("\n")
  return raw.filter((name) => !selectedTargetText.includes(name)).slice(0, 8)
}

function completionTelemetryContextWarnings(pack: CompletionContextPack) {
  const selectedKinds = new Set(pack.selected.map((block) => block.kind))
  const warnings = [
    !selectedKinds.has("current-prefix") && pack.dropped.some((block) => block.kind === "current-prefix")
      ? "dropped-current-prefix"
      : "",
    !selectedKinds.has("current-suffix") && pack.dropped.some((block) => block.kind === "current-suffix")
      ? "dropped-current-suffix"
      : "",
  ].filter(Boolean)
  return warnings.length > 0 ? warnings : undefined
}

function mergeCompletionEvidenceKinds(existing: string[] | undefined, next: string[]) {
  const kinds = new Set([...(existing ?? []), ...next])
  return [...kinds].sort()
}

function completionTelemetryContextLevel(pack: CompletionContextPack): NonNullable<CompletionDebugEvent["contextLevel"]> {
  if (pack.tokenEstimate <= 0 || pack.selected.length === 0) return "none"
  if (pack.tokenEstimate < 500) return "light"
  if (pack.tokenEstimate < 1600) return "standard"
  return "rich"
}

function mergeCompletionRetrievalMode(
  current: CompletionDebugEvent["retrievalMode"],
  next: NonNullable<CompletionDebugEvent["retrievalMode"]>,
): NonNullable<CompletionDebugEvent["retrievalMode"]> {
  if (current === "hybrid" || next === "hybrid") return "hybrid"
  if (current === "graph-only" || next === "graph-only") return "graph-only"
  return "none"
}

function completionTelemetryTrimReason(pipeline: CompletionCandidatePipelineResult) {
  if (pipeline.postprocessDebug.stripReason) return pipeline.postprocessDebug.stripReason
  const sourceText = pipeline.postprocessText || pipeline.fallbackText
  if (sourceText && pipeline.candidateText && sourceText !== pipeline.candidateText) return "c-intent-trim"
  return pipeline.reasons.find((reason) => reason.startsWith("postprocess:") || reason.startsWith("fallback:"))
}

function completionTelemetryFinalInsertLength(pipeline: CompletionCandidatePipelineResult) {
  return pipeline.edit?.insertText.length ?? pipeline.editText.length
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

function rankRetrievedCompletionSnippets(input: {
  snippets: RetrievedCompletionSnippet[]
  preferredKinds?: CompletionRetrievalPreferredKind[]
  limit: number
}) {
  const byKey = new Map<string, RetrievedCompletionSnippet>()
  for (const snippet of input.snippets) {
    const key = [snippet.kind, snippet.path, snippet.name ?? "", snippet.line].join("\0")
    const existing = byKey.get(key)
    if (!existing || snippetScore(snippet, input.preferredKinds) > snippetScore(existing, input.preferredKinds)) {
      byKey.set(key, snippet)
    }
  }
  return [...byKey.values()]
    .sort((left, right) =>
      snippetScore(right, input.preferredKinds) - snippetScore(left, input.preferredKinds) ||
      (left.path || "").localeCompare(right.path || "") ||
      (left.name || "").localeCompare(right.name || ""))
    .slice(0, Math.max(1, input.limit))
}

function snippetScore(snippet: RetrievedCompletionSnippet, preferredKinds: CompletionRetrievalPreferredKind[] | undefined) {
  return (snippet.score ?? 0) + (preferredKinds?.includes(snippetPreferredKind(snippet)) ? 160 : 0)
}

function snippetPreferredKind(snippet: RetrievedCompletionSnippet): CompletionRetrievalPreferredKind {
  if (/field|member/i.test(snippet.kind)) return "field"
  if (/macro/i.test(snippet.kind)) return "macro"
  if (/type|struct|union|enum|typedef/i.test(snippet.kind)) return "type"
  if (/function|method|existing test/i.test(snippet.kind)) return "function"
  return "global"
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
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
  const firstLine = input.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
  if (firstLine.length <= 80) return firstLine
  return `${firstLine.slice(0, 77)}...`
}

function truncateFeedback(input: string) {
  if (input.length <= 160) return input
  return `${input.slice(0, 157)}...`
}
