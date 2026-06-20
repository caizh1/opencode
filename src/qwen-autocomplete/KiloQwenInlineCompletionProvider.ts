import * as vscode from "vscode"
import { AutocompleteDebouncer } from "./AutocompleteDebouncer"
import { emitQwenDiagnostic, errorReason, type QwenCacheStatus, type QwenEmptyReason } from "./diagnostics"
import { QwenAutocompleteLruCache, type QwenAutocompleteCache } from "./autocompleteLruCache"
import { getContinueAutocompleteStopTokens } from "./fimTemplates"
import { QwenFimClient } from "./QwenFimClient"
import { readQwenAutocompleteConfig, qwenAutocompleteEnabled } from "./config"
import {
  decideQwenGuard,
  shouldGuardQwenDocument,
  type QwenGuardDecision,
  type QwenGuardSource,
  type QwenSafetyGuard,
} from "./guard"
import { createQwenAutocompleteHelperAsync, type QwenAutocompleteHelperVars } from "./helperVars"
import type { QwenImportDefinitionsSource } from "./importDefinitions"
import {
  QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK,
  QwenModelContextResolver,
  type QwenResolvedContextLength,
} from "./modelContext"
import { classifyQwenMultiline, type QwenMultilineClassifierResult } from "./multiline"
import { firstLogLine, postprocessQwenCompletion } from "./postprocess"
import { decideQwenPrefilter, type QwenPrefilterDecision } from "./prefilter"
import { buildQwenPromptPlan, type QwenPromptPlan } from "./qwenMultifileFimRenderer"
import { renderQwenInlineCompletionItem } from "./range"
import type { QwenRecentlyEditedSource } from "./recentlyEdited"
import type { QwenRecentlyVisitedSource } from "./recentlyVisited"
import type { QwenRecentlyOpenedSource } from "./recentlyOpened"
import type { QwenRootPathSource, QwenRootPathTraceEntry, QwenRootPathTraceSummary } from "./rootPathContext"
import {
  emptyQwenSnippetPayload,
  selectQwenSnippets,
  type QwenAutocompleteCodeSnippet,
  type QwenSnippetPayload,
  type QwenSnippetSelection,
} from "./snippets"
import { filterQwenCompletionDetailed, type QwenNonStreamingFilterResult } from "./streamFilters"
import { countTokens } from "./tokenPruning"
import type { QwenAutocompleteConfig, QwenRequestInfo } from "./types"

export { QWEN_DOCUMENT_SELECTOR, isQwenSupportedDocument } from "./prefilter"

type Deps = {
  apiKey?: () => Promise<string | undefined>
  client?: QwenFimClient
  debouncer?: AutocompleteDebouncer
  read?: () => QwenAutocompleteConfig
  guard?: QwenSafetyGuard
  cache?: QwenAutocompleteCache
  contextLength?: QwenModelContextResolver
  edited?: QwenRecentlyEditedSource
  visited?: QwenRecentlyVisitedSource
  opened?: QwenRecentlyOpenedSource
  imports?: QwenImportDefinitionsSource
  root?: QwenRootPathSource
  log?: (message: string) => void
}

type Pending = QwenRequestInfo & {
  abort: AbortController
}

type ForceFreshRequest = {
  documentUri: string
  version: number
  line: number
  character: number
  expiresAt: number
}

type Gate = {
  selected: vscode.SelectedCompletionInfo | undefined
  items?: vscode.InlineCompletionItem[]
}

type CacheResult = {
  hit: boolean
  returned: number | null
  status: QwenCacheStatus
  items?: vscode.InlineCompletionItem[]
}

type SnippetState = {
  edited: QwenAutocompleteCodeSnippet[]
  visited: QwenAutocompleteCodeSnippet[]
  opened: QwenAutocompleteCodeSnippet[]
  openedSkipped: number
  imports: QwenAutocompleteCodeSnippet[]
  importSkipped: number
  root: QwenAutocompleteCodeSnippet[]
  rootSkipped: number
  rootBlocked: string
  rootSummary: QwenRootPathTraceSummary
  rootTrace: QwenRootPathTraceEntry[]
  payload: QwenSnippetPayload
  selection: QwenSnippetSelection
}

type InjectFlags = {
  edited: boolean
  visited: boolean
  opened: boolean
  imports: boolean
  root: boolean
}

type InjectionState = {
  droppedDuplicateFileCount: number
  priority: string
  snippets: QwenAutocompleteCodeSnippet[]
  sources: string[]
}

export class KiloQwenInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly client: QwenFimClient
  private readonly apiKey: () => Promise<string | undefined>
  private readonly debouncer: AutocompleteDebouncer
  private readonly read: () => QwenAutocompleteConfig
  private readonly guard: QwenSafetyGuard
  private readonly cache: QwenAutocompleteCache
  private readonly contextLength: QwenModelContextResolver
  private readonly edited?: QwenRecentlyEditedSource
  private readonly visited?: QwenRecentlyVisitedSource
  private readonly opened?: QwenRecentlyOpenedSource
  private readonly imports?: QwenImportDefinitionsSource
  private readonly root?: QwenRootPathSource
  private readonly log: (message: string) => void
  private readonly customGuard: boolean
  private current: Pending | null = null
  private forceFresh: ForceFreshRequest | null = null
  private seq = 0

  constructor(deps: Deps = {}) {
    this.client = deps.client ?? new QwenFimClient()
    this.apiKey = deps.apiKey ?? (async () => undefined)
    this.debouncer = deps.debouncer ?? new AutocompleteDebouncer()
    this.read = deps.read ?? readQwenAutocompleteConfig
    this.guard = deps.guard ?? shouldGuardQwenDocument
    this.cache = deps.cache ?? new QwenAutocompleteLruCache()
    this.contextLength = deps.contextLength ?? new QwenModelContextResolver()
    this.edited = deps.edited
    this.visited = deps.visited
    this.opened = deps.opened
    this.imports = deps.imports
    this.root = deps.root
    this.log = deps.log ?? ((message) => console.info(message))
    this.customGuard = Boolean(deps.guard)
  }

  dispose(): void {
    this.debouncer.dispose()
    void this.cache.dispose?.()
    this.edited?.dispose()
    this.visited?.dispose()
    this.opened?.dispose()
    this.imports?.dispose()
    this.root?.dispose()
    this.current?.abort.abort()
    this.current = null
    this.forceFresh = null
  }

  forceFreshOnce(document: vscode.TextDocument, position: vscode.Position): void {
    this.forceFresh = {
      documentUri: document.uri.toString(),
      version: document.version,
      line: position.line,
      character: position.character,
      expiresAt: Date.now() + 5_000,
    }
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const id = this.nextId()
    const lifecycleStarted = Date.now()
    const cfg = this.read()
    const selected = context.selectedCompletionInfo
    this.emit(cfg, { requestId: id, phase: "provider-enter", document, position, selected })
    this.emit(cfg, { requestId: id, phase: "config-read", document, position, selected })
    const gate = await this.gate(cfg, id, document, position, selected, token, lifecycleStarted)
    if (gate.items) return gate.items

    const req = this.start(id, document, position)
    token.onCancellationRequested(() => req.abort.abort())
    const started = Date.now()
    const apiKey = (await this.apiKey())?.trim() || cfg.apiKey
    const helper = await createQwenAutocompleteHelperAsync(document, position, gate.selected, {
      maxPromptTokens: cfg.maxPromptTokens,
      maxSuffixPercentage: cfg.maxSuffixPercentage,
      modelName: cfg.model,
      prefixPercentage: cfg.prefixPercentage,
      resolveTreePath: true,
    })
    const snippets = await this.snippets(cfg, helper, document)
    this.emitRootTrace(cfg, id, document, position, gate.selected, snippets)
    const inject = this.injectable(cfg, snippets)
    const resolvedContext = await this.resolveContextLength(cfg, apiKey, inject.snippets.length > 0)
    const prompt = buildQwenPromptPlan({
      cfg: this.withContextLength(cfg, resolvedContext),
      helper,
      injectIntoPrompt: inject.snippets.length > 0,
      snippets: inject.snippets,
    })
    const multi = classifyQwenMultiline({ helper, position, selected: gate.selected })
    const multiline = multi.allowed
    const forceFresh = this.consumeForceFresh(document, position)
    this.emit(cfg, {
      requestId: id,
      phase: "prompt-built",
      document,
      position,
      selected: gate.selected,
      prefixChars: helper.prunedPrefix.length,
      suffixChars: helper.prunedSuffix.length,
      helper,
      ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
      ...this.multilineFields(multi),
      prompt: prompt.prompt,
    })

    const cached = forceFresh
      ? { hit: false, returned: null, status: "miss" as const }
      : await this.lookupCache(
          cfg,
          id,
          document,
          position,
          context,
          gate.selected,
          started,
          helper,
          inject,
          multiline,
          multi,
          snippets,
          prompt,
          resolvedContext,
        )
    if (cached.items) return cached.items

    let httpStatus: number | null = null
    try {
      this.emit(cfg, {
        requestId: id,
        phase: "request-start",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        ...this.multilineFields(multi),
      })
      const raw = await this.client.complete({
        endpoint: cfg.endpoint,
        model: cfg.model,
        apiKey,
        prompt: prompt.prompt,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        signal: req.abort.signal,
        onResponse: (info) => {
          httpStatus = info.status
        },
      })
      this.emit(cfg, {
        requestId: id,
        phase: "response",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        httpStatus,
        latencyMs: Date.now() - started,
        rawTextLength: raw.length,
        ...this.multilineFields(multi),
        completion: raw,
      })
      if (!this.fresh(req, document, position, token)) {
        this.emit(cfg, {
          requestId: id,
          phase: "stale",
          document,
          position,
          selected: gate.selected,
          stale: true,
          latencyMs: Date.now() - started,
          rawTextLength: raw.length,
          helper,
          ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
          ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
          emptyReason: "stale",
        })
        return this.empty(
          cfg,
          id,
          document,
          position,
          gate.selected,
          started,
          "stale",
          helper,
          snippets,
          prompt,
          {},
          inject,
          resolvedContext,
        )
      }
      const filtered = filterQwenCompletionDetailed({
        completion: raw,
        suffix: helper.prunedSuffix,
        stopTokens: getContinueAutocompleteStopTokens(cfg.model),
        helper,
        position,
        multiline,
      })
      if (filtered.rejected) {
        this.emit(cfg, {
          requestId: id,
          phase: "postprocess",
          document,
          position,
          selected: gate.selected,
          prefixChars: helper.prunedPrefix.length,
          suffixChars: helper.prunedSuffix.length,
          helper,
          ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
          ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
          ...this.filterFields(filtered),
          rawTextLength: raw.length,
          filteredTextLength: filtered.text.length,
          finalTextLength: 0,
          ...this.multilineFields(multi),
          emptyReason: "empty-after-postprocess",
          completion: filtered.text,
        })
        return this.empty(
          cfg,
          id,
          document,
          position,
          gate.selected,
          started,
          "empty-after-postprocess",
          helper,
          snippets,
          prompt,
          {},
          inject,
          resolvedContext,
        )
      }
      const processed = postprocessQwenCompletion({
        completion: filtered.text,
        model: cfg.model,
        prefix: helper.prunedPrefix,
        suffix: helper.prunedSuffix,
      })
      this.emit(cfg, {
        requestId: id,
        phase: "postprocess",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        ...this.filterFields(filtered),
        rawTextLength: raw.length,
        filteredTextLength: filtered.text.length,
        finalTextLength: processed?.length ?? 0,
        ...this.multilineFields(multi),
        emptyReason: processed ? "none" : "empty-after-postprocess",
        completion: processed,
      })
      if (!processed) {
        return this.empty(
          cfg,
          id,
          document,
          position,
          gate.selected,
          started,
          "empty-after-postprocess",
          helper,
          snippets,
          prompt,
          {},
          inject,
          resolvedContext,
        )
      }
      const text = gate.selected ? gate.selected.text + processed : processed
      if (gate.selected && !text.startsWith(gate.selected.text)) {
        return this.empty(
          cfg,
          id,
          document,
          position,
          gate.selected,
          started,
          "selected-completion-invalid",
          helper,
          snippets,
          prompt,
          {},
          inject,
          resolvedContext,
        )
      }
      const item = renderQwenInlineCompletionItem(document, position, context, text)
      this.emit(cfg, {
        requestId: id,
        phase: "render",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        finalTextLength: text.length,
        itemCount: item ? 1 : 0,
        ...this.multilineFields(multi),
        multilineShown: text.includes("\n"),
        range: item?.range,
        insertText: text,
        emptyReason: item ? "none" : "render-rejected",
      })
      if (!item) {
        return this.empty(
          cfg,
          id,
          document,
          position,
          gate.selected,
          started,
          "render-rejected",
          helper,
          snippets,
          prompt,
          {},
          inject,
          resolvedContext,
        )
      }
      await this.putCache(cfg, helper, prompt, processed)
      this.emit(cfg, {
        requestId: id,
        phase: "return-items",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        finalTextLength: text.length,
        itemCount: 1,
        ...this.multilineFields(multi),
        multilineShown: text.includes("\n"),
        range: item.range,
        insertText: text,
        latencyMs: Date.now() - started,
      })
      this.logDone(req, started, helper.prunedPrefix.length, helper.prunedSuffix.length, text)
      return [item]
    } catch (err) {
      if (req.abort.signal.aborted || token.isCancellationRequested) {
        return this.cancelled(cfg, id, document, position, gate.selected, started)
      }
      const reason = errorReason(err)
      this.emit(cfg, {
        requestId: id,
        phase: "error",
        document,
        position,
        selected: gate.selected,
        prefixChars: helper.prunedPrefix.length,
        suffixChars: helper.prunedSuffix.length,
        helper,
        ...this.cacheFields(cfg, cached.status, cached.hit, helper, cached.returned),
        ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
        httpStatus,
        latencyMs: Date.now() - started,
        emptyReason: reason,
        error: err,
      })
      this.logError(req, started, helper.prunedPrefix.length, helper.prunedSuffix.length, err)
      return this.empty(
        cfg,
        id,
        document,
        position,
        gate.selected,
        started,
        reason,
        helper,
        snippets,
        prompt,
        {},
        inject,
        resolvedContext,
      )
    }
  }

  private async lookupCache(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    selected: vscode.SelectedCompletionInfo | undefined,
    started: number,
    helper: QwenAutocompleteHelperVars,
    inject: InjectionState,
    multiline: boolean,
    multi: QwenMultilineClassifierResult,
    snippets: SnippetState,
    prompt: QwenPromptPlan,
    resolvedContext: QwenResolvedContextLength,
  ): Promise<CacheResult> {
    if (!cfg.cacheEnabled) return { hit: false, returned: null, status: "disabled" }
    try {
      await this.cache.setMaxEntries(cfg.cacheMaxEntries)
      const completion = await this.cache.get(this.cachePrefix(helper, prompt))
      if (!completion) return { hit: false, returned: null, status: "miss" }
      return this.renderCached(
        cfg,
        requestId,
        document,
        position,
        context,
        selected,
        started,
        helper,
        multiline,
        multi,
        completion,
        snippets,
        prompt,
        inject,
        resolvedContext,
      )
    } catch (err) {
      void err
      return { hit: false, returned: null, status: "miss" }
    }
  }

  private renderCached(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    selected: vscode.SelectedCompletionInfo | undefined,
    started: number,
    helper: QwenAutocompleteHelperVars,
    multiline: boolean,
    multi: QwenMultilineClassifierResult,
    completion: string,
    snippets: SnippetState,
    prompt: QwenPromptPlan,
    inject: InjectionState,
    resolvedContext: QwenResolvedContextLength,
  ): CacheResult {
    const text = selected ? selected.text + completion : completion
    const item = renderQwenInlineCompletionItem(document, position, context, text)
    const base = this.cacheFields(cfg, item ? "hit" : "render-rejected", !!item, helper, completion.length)
    this.emit(cfg, {
      requestId,
      phase: "render",
      document,
      position,
      selected,
      prefixChars: helper.prunedPrefix.length,
      suffixChars: helper.prunedSuffix.length,
      helper,
      ...base,
      ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
      finalTextLength: text.length,
      itemCount: item ? 1 : 0,
      ...this.multilineFields(multi),
      multilineShown: text.includes("\n"),
      range: item?.range,
      insertText: text,
      emptyReason: item ? "none" : "render-rejected",
    })
    if (!item) return { hit: false, returned: completion.length, status: "render-rejected" }
    this.emit(cfg, {
      requestId,
      phase: "return-items",
      document,
      position,
      selected,
      prefixChars: helper.prunedPrefix.length,
      suffixChars: helper.prunedSuffix.length,
      helper,
      ...base,
      ...this.snippetFields(cfg, snippets, prompt, inject, resolvedContext),
      finalTextLength: text.length,
      itemCount: 1,
      ...this.multilineFields(multi),
      multilineShown: text.includes("\n"),
      range: item.range,
      insertText: text,
      latencyMs: Date.now() - started,
    })
    this.logDone(
      {
        id: requestId,
        path: vscode.workspace.asRelativePath(document.uri, false),
        line: position.line,
        character: position.character,
        version: document.version,
        abort: new AbortController(),
      },
      started,
      helper.prunedPrefix.length,
      helper.prunedSuffix.length,
      text,
    )
    return { hit: true, returned: completion.length, status: "hit", items: [item] }
  }

  private cacheFields(
    cfg: QwenAutocompleteConfig,
    status: QwenCacheStatus,
    hit: boolean,
    helper: QwenAutocompleteHelperVars,
    returned: number | null,
  ): Record<string, unknown> {
    return {
      cacheEnabled: cfg.cacheEnabled,
      cacheStatus: status,
      cacheHit: hit,
      cacheEntryCount: this.cache.size(),
      cacheLookupPrefixChars: helper.prunedPrefix.length,
      cacheReturnedChars: returned,
    }
  }

  private multilineFields(result: QwenMultilineClassifierResult): Record<string, unknown> {
    return {
      multilineAllowed: result.allowed,
      multilineBlockedReason: result.blockedReason,
      multilineClassifierMode: result.mode,
      multilineClassifierSource: result.source,
      multilineLanguage: result.language,
      multilineSelectedCompletionInfo: result.selectedCompletionInfo,
      multilineSingleLineComment: result.singleLineComment ?? "",
      multilineUseMultilineApplied: result.useMultilineApplied,
    }
  }

  private prefilterFields(result: QwenPrefilterDecision, cfg: QwenAutocompleteConfig): Record<string, unknown> {
    return {
      prefilterDecision: result.prefiltered ? "blocked" : "allowed",
      prefilterExtension: result.extension,
      prefilterLanguage: result.languageId,
      prefilterProviderEnabled: qwenAutocompleteEnabled(cfg),
      prefilterReason: result.reason,
    }
  }

  private guardFields(result: QwenGuardDecision): Record<string, unknown> {
    return {
      contextReadGuardDecision: result.source === "context-read" ? (result.blocked ? "blocked" : "allowed") : null,
      guardDecision: result.blocked ? "blocked" : "allowed",
      guardEnabled: true,
      guardErrorFailClosed: result.errorFailClosed,
      guardIgnored: result.ignored,
      guardLanguageAllowed: true,
      guardReason: result.reason,
      guardSchemeAllowed: result.schemeAllowed,
      guardSensitive: result.sensitive,
      guardSource: result.source,
      guardWorkspaceAllowed: result.workspaceAllowed,
    }
  }

  private filterFields(result: QwenNonStreamingFilterResult): Record<string, unknown> {
    return {
      nonStreamingFilterEnabled: true,
      nonStreamingFilterApplied: result.reasons.length > 0,
      nonStreamingFilterReasons: result.reasons.join(","),
      nonStreamingFilterInputChars: result.inputChars,
      nonStreamingFilterOutputChars: result.outputChars,
      nonStreamingFilterRejected: result.rejected,
      nonStreamingFilterTrimmed: result.trimmed,
      nonStreamingFilterStopTokenHit: result.reasons.includes("stop-token") || result.reasons.includes("fim-marker"),
      nonStreamingFilterSimilarLineHit: result.reasons.includes("stop-at-similar-line"),
      nonStreamingFilterRepeatingLineHit: result.reasons.includes("repeating-lines"),
      nonStreamingFilterMarkdownFenceHit: result.reasons.includes("markdown-fence"),
      nonStreamingFilterPathLineHit: result.reasons.includes("path-line"),
      nonStreamingFilterAdapterMode: "non-streaming-full-text",
    }
  }

  private async snippets(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    document: vscode.TextDocument,
  ): Promise<SnippetState> {
    const payload = emptyQwenSnippetPayload()
    const edited = this.edited?.snippets(cfg) ?? []
    const visited = this.visited?.snippets(cfg) ?? []
    const opened = (await this.opened?.snippets(cfg, document)) ?? { skippedCount: 0, snippets: [] }
    const imports = (await this.imports?.snippets(cfg, helper, document)) ?? { skippedCount: 0, snippets: [] }
    const root = (await this.root?.snippets(cfg, helper)) ?? {
      blockedReason: cfg.rootPathEnabled ? "error" : "disabled",
      summary: emptyRootSummary(),
      skippedCount: 0,
      snippets: [],
      trace: [],
    }
    payload.recentlyEditedRangeSnippets = edited
    payload.recentlyVisitedRangesSnippets = visited
    payload.recentlyOpenedFileSnippets = opened.snippets
    payload.importDefinitionSnippets = imports.snippets
    payload.rootPathSnippets = root.snippets
    const selection = selectQwenSnippets(helper, payload, {
      includeDiff: true,
      includeRecentlyEditedRanges: cfg.recentlyEditedEnabled,
      includeRecentlyVisitedRanges: true,
      useImports: cfg.importDefinitionsEnabled,
      maxPromptTokens: cfg.maxPromptTokens,
      modelName: cfg.model,
      useRecentlyOpened: cfg.recentlyOpenedEnabled,
      useRootPath: cfg.rootPathEnabled,
    })
    return {
      edited,
      importSkipped: imports.skippedCount,
      imports: imports.snippets,
      opened: opened.snippets,
      openedSkipped: opened.skippedCount,
      payload,
      root: root.snippets,
      rootBlocked: root.blockedReason,
      rootSkipped: root.skippedCount,
      rootSummary: root.summary,
      rootTrace: root.trace,
      selection,
      visited,
    }
  }

  private snippetFields(
    cfg: QwenAutocompleteConfig,
    state: SnippetState,
    prompt?: QwenPromptPlan,
    inject = this.injectable(cfg, state),
    resolvedContext?: QwenResolvedContextLength,
  ): Record<string, unknown> {
    return {
      snippetScaffoldEnabled: true,
      snippetTotalCount: state.selection.totalCount,
      selectedSnippetCount: state.selection.selectedCount,
      snippetTokenBudget: state.selection.snippetTokenBudget,
      selectedSnippetTokens: state.selection.selectedSnippetTokens,
      snippetSelectionEnabled: true,
      snippetSelectionTotalPayloadCount: state.selection.totalCount,
      snippetSelectionTotalSelectedCount: state.selection.selectedCount,
      snippetSelectionTotalSelectedTokens: state.selection.selectedSnippetTokens,
      snippetSelectionDroppedByBudgetCount: state.selection.droppedByBudgetCount,
      snippetSelectionDroppedDuplicateFileCount:
        state.selection.droppedDuplicateFileCount + inject.droppedDuplicateFileCount,
      snippetSelectionDroppedInvalidCount: state.selection.droppedInvalidCount,
      snippetSelectionInjectedCount: prompt?.snippetsInjectedIntoPrompt ? inject.snippets.length : 0,
      snippetSelectionInjectedSources: prompt?.snippetsInjectedIntoPrompt ? inject.sources.join(",") : "",
      snippetSelectionAdapterPriority: inject.priority,
      snippetSelectionBudgetRemaining: state.selection.budgetRemaining,
      contextReadGuardDecision: "applied",
      contextReadGuardSkippedCount: state.openedSkipped + state.importSkipped + state.rootSkipped,
      recentlyOpenedFormattedCount: state.selection.recentlyOpenedFormattedCount,
      recentlyOpenedTrimmedCount: state.selection.recentlyOpenedTrimmedCount,
      baseSnippetSelectedCount: state.selection.baseSnippetSelectedCount,
      baseSnippetInjectedCount: prompt?.snippetsInjectedIntoPrompt
        ? inject.snippets.filter(
            (snippet) => this.selectedImports(state).includes(snippet) || this.selectedRoot(state).includes(snippet),
          ).length
        : 0,
      ...this.editedFields(cfg, state),
      ...this.visitedFields(cfg, state, prompt, inject),
      ...this.openedFields(cfg, state, prompt, inject),
      ...this.importFields(cfg, state, prompt, inject),
      ...this.rootFields(cfg, state, prompt, inject),
      ...this.promptFields(cfg, prompt, resolvedContext),
    }
  }

  private emitRootTrace(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    selected: vscode.SelectedCompletionInfo | undefined,
    state: SnippetState,
  ): void {
    for (const entry of state.rootTrace) {
      this.emit(cfg, {
        requestId,
        phase: entry.phase,
        document,
        position,
        selected,
        diagnosticFields: entry.fields,
        ...this.rootSummaryFields(state),
      })
    }
  }

  private rootSummaryFields(state: SnippetState): Record<string, unknown> {
    return {
      rootPathLanguage: state.rootSummary.rootPathLanguage,
      rootPathBackend: state.rootSummary.rootPathBackend,
      rootPathCapturedSymbols: state.rootSummary.rootPathCapturedSymbols,
      rootPathEvidenceTokens: state.rootSummary.rootPathEvidenceTokens,
      rootPathCodeGraphSkippedReason: state.rootSummary.rootPathCodeGraphSkippedReason,
      rootPathBudgetTrimmed: state.rootSummary.rootPathBudgetTrimmed,
      receiverTypeResolved: state.rootSummary.receiverTypeResolved,
      fieldEvidenceSelected: state.rootSummary.fieldEvidenceSelected,
      typedefChainSelected: state.rootSummary.typedefChainSelected,
    }
  }

  private editedFields(cfg: QwenAutocompleteConfig, state: SnippetState): Record<string, unknown> {
    const edited = this.selectedEdited(state)
    return {
      recentlyEditedEnabled: cfg.recentlyEditedEnabled,
      recentlyEditedTrackedRangeCount: this.edited?.count() ?? 0,
      recentlyEditedPayloadCount: state.payload.recentlyEditedRangeSnippets.length,
      recentlyEditedSelectedCount: edited.length,
      recentlyEditedSelectedTokens: edited.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0),
      recentlyEditedInjectIntoPrompt: cfg.recentlyEditedInjectIntoPrompt,
    }
  }

  private visitedFields(
    cfg: QwenAutocompleteConfig,
    state: SnippetState,
    prompt: QwenPromptPlan | undefined,
    inject: InjectionState,
  ): Record<string, unknown> {
    const visited = this.selectedVisited(state)
    return {
      recentlyVisitedEnabled: true,
      recentlyVisitedTrackedRangeCount: this.visited?.count() ?? 0,
      recentlyVisitedPayloadCount: state.payload.recentlyVisitedRangesSnippets.length,
      recentlyVisitedSelectedCount: visited.length,
      recentlyVisitedSelectedTokens: visited.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0),
      recentlyVisitedInjectedIntoPrompt: prompt?.snippetsInjectedIntoPrompt
        ? inject.snippets.some((snippet) => visited.includes(snippet))
        : false,
    }
  }

  private openedFields(
    cfg: QwenAutocompleteConfig,
    state: SnippetState,
    prompt?: QwenPromptPlan,
    inject = this.injectable(cfg, state),
  ): Record<string, unknown> {
    const opened = this.selectedOpened(state)
    return {
      recentlyOpenedEnabled: cfg.recentlyOpenedEnabled,
      recentlyOpenedInjectIntoPrompt: cfg.recentlyOpenedInjectIntoPrompt,
      recentlyOpenedTrackedFileCount: this.opened?.count() ?? 0,
      recentlyOpenedPayloadCount: state.payload.recentlyOpenedFileSnippets.length,
      recentlyOpenedSelectedCount: opened.length,
      recentlyOpenedSelectedTokens: opened.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0),
      recentlyOpenedReadTimeoutMs: cfg.recentlyOpenedFileReadTimeoutMs,
      recentlyOpenedSkippedCount: state.openedSkipped,
      recentlyOpenedInjectedIntoPrompt: prompt?.snippetsInjectedIntoPrompt
        ? inject.snippets.some((snippet) => opened.includes(snippet))
        : false,
    }
  }

  private importFields(
    cfg: QwenAutocompleteConfig,
    state: SnippetState,
    prompt?: QwenPromptPlan,
    inject = this.injectable(cfg, state),
  ): Record<string, unknown> {
    const imports = this.selectedImports(state)
    return {
      importDefinitionsEnabled: cfg.importDefinitionsEnabled,
      importDefinitionsInjectIntoPrompt: cfg.importDefinitionsInjectIntoPrompt,
      importDefinitionsCacheSize: cfg.importDefinitionsCacheSize,
      importDefinitionsPayloadCount: state.payload.importDefinitionSnippets.length,
      importDefinitionsSelectedCount: imports.length,
      importDefinitionsSelectedTokens: imports.reduce(
        (sum, snippet) => sum + countTokens(snippet.content, cfg.model),
        0,
      ),
      importDefinitionsTimeoutMs: cfg.importDefinitionsTimeoutMs,
      importDefinitionsSkippedCount: state.importSkipped,
      importDefinitionsInjectedIntoPrompt: prompt?.snippetsInjectedIntoPrompt
        ? inject.snippets.some((snippet) => imports.includes(snippet))
        : false,
    }
  }

  private rootFields(
    cfg: QwenAutocompleteConfig,
    state: SnippetState,
    prompt?: QwenPromptPlan,
    inject = this.injectable(cfg, state),
  ): Record<string, unknown> {
    const root = this.selectedRoot(state)
    return {
      rootPathEnabled: cfg.rootPathEnabled,
      rootPathInjectIntoPrompt: cfg.rootPathInjectIntoPrompt,
      rootPathCacheSize: cfg.rootPathCacheSize,
      rootPathPayloadCount: state.payload.rootPathSnippets.length,
      rootPathSelectedCount: root.length,
      rootPathSelectedTokens: root.reduce((sum, snippet) => sum + countTokens(snippet.content, cfg.model), 0),
      rootPathTimeoutMs: cfg.rootPathTimeoutMs,
      rootPathSkippedCount: state.rootSkipped,
      rootPathInjectedIntoPrompt: prompt?.snippetsInjectedIntoPrompt
        ? inject.snippets.some((snippet) => root.includes(snippet))
        : false,
      rootPathBlockedReason: state.rootBlocked,
      ...this.rootSummaryFields(state),
    }
  }

  private promptFields(
    cfg: QwenAutocompleteConfig,
    prompt: QwenPromptPlan | undefined,
    resolvedContext?: QwenResolvedContextLength,
  ): Record<string, unknown> {
    return {
      contextLength: resolvedContext?.value ?? cfg.contextLength,
      contextLengthSource: resolvedContext?.source ?? (cfg.contextLength > 0 ? "configured" : "unknown"),
      availablePromptTokens: prompt?.availablePromptTokens ?? null,
      promptRendererMode: prompt?.promptRendererMode ?? "disabled",
      snippetInjectionBlockedReason: prompt?.snippetInjectionBlockedReason ?? "disabled",
      renderedPrefixChars: prompt?.renderedPrefixChars ?? null,
      renderedSuffixChars: prompt?.renderedSuffixChars ?? null,
      renderedPromptChars: prompt?.renderedPromptChars ?? null,
      estimatedRenderedPromptTokens: prompt?.estimatedRenderedPromptTokens ?? null,
      snippetsInjectedIntoPrompt: prompt?.snippetsInjectedIntoPrompt ?? false,
    }
  }

  private selectedEdited(state: SnippetState): QwenAutocompleteCodeSnippet[] {
    return state.selection.snippets.filter((snippet) =>
      state.edited.includes(snippet as QwenAutocompleteCodeSnippet),
    ) as QwenAutocompleteCodeSnippet[]
  }

  private selectedVisited(state: SnippetState): QwenAutocompleteCodeSnippet[] {
    return state.selection.snippets.filter((snippet) =>
      state.visited.includes(snippet as QwenAutocompleteCodeSnippet),
    ) as QwenAutocompleteCodeSnippet[]
  }

  private selectedOpened(state: SnippetState): QwenAutocompleteCodeSnippet[] {
    return state.selection.snippets.filter((snippet) =>
      state.opened.includes(snippet as QwenAutocompleteCodeSnippet),
    ) as QwenAutocompleteCodeSnippet[]
  }

  private selectedImports(state: SnippetState): QwenAutocompleteCodeSnippet[] {
    return state.selection.snippets.filter((snippet) =>
      state.imports.includes(snippet as QwenAutocompleteCodeSnippet),
    ) as QwenAutocompleteCodeSnippet[]
  }

  private selectedRoot(state: SnippetState): QwenAutocompleteCodeSnippet[] {
    return state.selection.snippets.filter((snippet) =>
      state.root.includes(snippet as QwenAutocompleteCodeSnippet),
    ) as QwenAutocompleteCodeSnippet[]
  }

  private injectable(cfg: QwenAutocompleteConfig, state: SnippetState): InjectionState {
    const flags = this.injectFlags(cfg)
    const files = new Set<string>()
    const out: QwenAutocompleteCodeSnippet[] = []
    const sources = new Set<string>()
    let droppedDuplicateFileCount = 0
    for (const snippet of state.selection.snippets) {
      const current = snippet as QwenAutocompleteCodeSnippet
      if (!current.filepath) continue
      const source = this.injectSource(current, state)
      if (!source || !this.sourceEnabled(source, flags)) continue
      if (files.has(current.filepath)) {
        droppedDuplicateFileCount++
        continue
      }
      files.add(current.filepath)
      out.push(current)
      sources.add(source)
    }
    return {
      droppedDuplicateFileCount,
      priority: "recentlyOpened>recentlyVisited>recentlyEdited>importDefinitions>rootPath",
      snippets: out,
      sources: [...sources],
    }
  }

  private injectFlags(cfg: QwenAutocompleteConfig): InjectFlags {
    return {
      edited: cfg.recentlyEditedEnabled && cfg.recentlyEditedInjectIntoPrompt,
      visited: true,
      imports: cfg.importDefinitionsEnabled && cfg.importDefinitionsInjectIntoPrompt,
      opened: cfg.recentlyOpenedEnabled && cfg.recentlyOpenedInjectIntoPrompt,
      root: cfg.rootPathEnabled && cfg.rootPathInjectIntoPrompt,
    }
  }

  private injectSource(item: QwenAutocompleteCodeSnippet, state: SnippetState): string | null {
    if (state.opened.includes(item)) return "recentlyOpened"
    if (state.visited.includes(item)) return "recentlyVisited"
    if (state.edited.includes(item)) return "recentlyEdited"
    if (state.imports.includes(item)) return "importDefinitions"
    if (state.root.includes(item)) return "rootPath"
    return null
  }

  private sourceEnabled(source: string, flags: InjectFlags): boolean {
    if (source === "recentlyOpened") return flags.opened
    if (source === "recentlyVisited") return flags.visited
    if (source === "recentlyEdited") return flags.edited
    if (source === "importDefinitions") return flags.imports
    if (source === "rootPath") return flags.root
    return false
  }

  private async putCache(
    cfg: QwenAutocompleteConfig,
    helper: QwenAutocompleteHelperVars,
    prompt: QwenPromptPlan,
    completion: string,
  ): Promise<void> {
    if (!cfg.cacheEnabled) return
    try {
      await this.cache.setMaxEntries(cfg.cacheMaxEntries)
      await this.cache.put(this.cachePrefix(helper, prompt), completion)
    } catch (err) {
      void err
    }
  }

  private nextId(): string {
    return `qwen-${Date.now()}-${++this.seq}`
  }

  private consumeForceFresh(document: vscode.TextDocument, position: vscode.Position): boolean {
    const pending = this.forceFresh
    if (!pending) return false
    if (pending.expiresAt < Date.now()) {
      this.forceFresh = null
      return false
    }
    if (pending.documentUri !== document.uri.toString()) return false
    this.forceFresh = null
    return (
      pending.version === document.version &&
      pending.line === position.line &&
      pending.character === position.character
    )
  }

  private start(id: string, document: vscode.TextDocument, position: vscode.Position): Pending {
    this.current?.abort.abort()
    const req: Pending = {
      id,
      path: vscode.workspace.asRelativePath(document.uri, false),
      line: position.line,
      character: position.character,
      version: document.version,
      abort: new AbortController(),
    }
    this.current = req
    return req
  }

  private async guardDecision(document: vscode.TextDocument, source: QwenGuardSource): Promise<QwenGuardDecision> {
    if (!this.customGuard) return decideQwenGuard(document, source)
    try {
      const blocked = await this.guard(document)
      return {
        blocked,
        errorFailClosed: false,
        ignored: false,
        reason: blocked ? "custom" : "none",
        schemeAllowed: document.uri.scheme === "file",
        sensitive: false,
        source,
        workspaceAllowed: true,
      }
    } catch (err) {
      void err
      return {
        blocked: true,
        errorFailClosed: true,
        ignored: false,
        reason: "error",
        schemeAllowed: document.uri.scheme === "file",
        sensitive: false,
        source,
        workspaceAllowed: false,
      }
    }
  }

  private async gate(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    selected: vscode.SelectedCompletionInfo | undefined,
    token: vscode.CancellationToken,
    started: number,
  ): Promise<Gate> {
    if (!qwenAutocompleteEnabled(cfg)) {
      return {
        selected,
        items: this.empty(
          cfg,
          requestId,
          document,
          position,
          selected,
          started,
          "disabled",
          undefined,
          undefined,
          undefined,
          {
            prefilterProviderEnabled: false,
          },
        ),
      }
    }
    const prefilter = decideQwenPrefilter(document)
    const prefilterFields = this.prefilterFields(prefilter, cfg)
    if (prefilter.prefiltered) {
      return {
        selected,
        items: this.empty(
          cfg,
          requestId,
          document,
          position,
          selected,
          started,
          "prefiltered",
          undefined,
          undefined,
          undefined,
          prefilterFields,
        ),
      }
    }
    if (token.isCancellationRequested) {
      return { selected, items: this.cancelled(cfg, requestId, document, position, selected, started) }
    }
    const guard = await this.guardDecision(document, "current-file")
    this.emit(cfg, {
      requestId,
      phase: "ignore-guard",
      document,
      position,
      selected,
      ...prefilterFields,
      ...this.guardFields(guard),
      guardBlocked: guard.blocked,
      emptyReason: guard.blocked ? "guard-blocked" : "none",
    })
    if (guard.blocked) {
      return {
        selected,
        items: this.empty(
          cfg,
          requestId,
          document,
          position,
          selected,
          started,
          "guard-blocked",
          undefined,
          undefined,
          undefined,
          {
            ...prefilterFields,
            ...this.guardFields(guard),
          },
        ),
      }
    }
    if (selected && !validSelectedCompletionInfo(document, selected)) {
      return {
        selected,
        items: this.empty(cfg, requestId, document, position, selected, started, "selected-completion-invalid"),
      }
    }
    if (token.isCancellationRequested) {
      return { selected, items: this.cancelled(cfg, requestId, document, position, selected, started) }
    }
    const debounced = await this.debouncer.delayAndShouldDebounce(cfg.debounceMs)
    this.emit(cfg, {
      requestId,
      phase: "debounce",
      document,
      position,
      selected,
      debounceMs: cfg.debounceMs,
      cancelled: debounced,
      emptyReason: debounced ? "cancelled" : "none",
    })
    if (debounced) {
      return { selected, items: this.empty(cfg, requestId, document, position, selected, started, "cancelled") }
    }
    if (token.isCancellationRequested) {
      return { selected, items: this.cancelled(cfg, requestId, document, position, selected, started) }
    }
    return { selected }
  }

  private cancelled(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    selected: vscode.SelectedCompletionInfo | undefined,
    started: number,
  ): vscode.InlineCompletionItem[] {
    this.emit(cfg, {
      requestId,
      phase: "cancelled",
      document,
      position,
      selected,
      cancelled: true,
      latencyMs: Date.now() - started,
      emptyReason: "cancelled",
    })
    return this.empty(cfg, requestId, document, position, selected, started, "cancelled")
  }

  private empty(
    cfg: QwenAutocompleteConfig,
    requestId: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    selected: vscode.SelectedCompletionInfo | undefined,
    started: number,
    emptyReason: QwenEmptyReason,
    helper?: QwenAutocompleteHelperVars,
    snippets?: SnippetState,
    prompt?: QwenPromptPlan,
    extra: Record<string, unknown> = {},
    inject?: InjectionState,
    resolvedContext?: QwenResolvedContextLength,
  ): vscode.InlineCompletionItem[] {
    this.emit(cfg, {
      requestId,
      phase: "return-items",
      document,
      position,
      selected,
      cancelled: emptyReason === "cancelled",
      stale: emptyReason === "stale",
      latencyMs: Date.now() - started,
      itemCount: 0,
      helper,
      ...(snippets ? this.snippetFields(cfg, snippets, prompt, inject, resolvedContext) : {}),
      ...extra,
      emptyReason,
      filterReason: emptyReason,
    })
    return []
  }

  private async resolveContextLength(
    cfg: QwenAutocompleteConfig,
    apiKey: string,
    needed: boolean,
  ): Promise<QwenResolvedContextLength> {
    if (cfg.contextLength > 0) return { source: "configured", value: cfg.contextLength }
    if (!needed) return { source: "fallback-200k", value: QWEN_AUTODETECT_CONTEXT_LENGTH_FALLBACK }
    return this.contextLength.resolve({
      contextLength: cfg.contextLength,
      endpoint: cfg.endpoint,
      model: cfg.model,
      apiKey,
    })
  }

  private withContextLength(cfg: QwenAutocompleteConfig, resolved: QwenResolvedContextLength): QwenAutocompleteConfig {
    if (!Number.isFinite(resolved.value) || resolved.value <= 0 || cfg.contextLength === resolved.value) return cfg
    return {
      ...cfg,
      contextLength: resolved.value,
    }
  }

  private cachePrefix(helper: QwenAutocompleteHelperVars, prompt: QwenPromptPlan): string {
    return prompt.snippetsInjectedIntoPrompt ? prompt.renderedPrefix : helper.prunedPrefix
  }

  private emit(cfg: QwenAutocompleteConfig, input: Omit<Parameters<typeof emitQwenDiagnostic>[0], "cfg">): void {
    try {
      emitQwenDiagnostic({ ...input, cfg })
    } catch (err) {
      void err
      // Diagnostics must never affect autocomplete behavior.
    }
  }

  private fresh(
    req: Pending,
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): boolean {
    return (
      !token.isCancellationRequested &&
      !req.abort.signal.aborted &&
      this.current?.id === req.id &&
      document.version === req.version &&
      position.line === req.line &&
      position.character === req.character
    )
  }

  private logDone(req: Pending, started: number, prefix: number, suffix: number, text: string): void {
    this.log(
      `[ChipMate] qwen-autocomplete requestId=${req.id} path=${quote(req.path)} line=${req.line + 1} character=${
        req.character + 1
      } latency=${Date.now() - started} prefixChars=${prefix} suffixChars=${suffix} firstLine=${quote(firstLogLine(text))}`,
    )
  }

  private logError(req: Pending, started: number, prefix: number, suffix: number, err: unknown): void {
    this.log(
      `[ChipMate] qwen-autocomplete requestId=${req.id} path=${quote(req.path)} line=${req.line + 1} character=${
        req.character + 1
      } latency=${Date.now() - started} prefixChars=${prefix} suffixChars=${suffix} error=${quote(summary(err))}`,
    )
  }
}

function validSelectedCompletionInfo(document: vscode.TextDocument, selected: vscode.SelectedCompletionInfo): boolean {
  const text = document.getText(selected.range)
  const typed = selected.range.end.character - selected.range.start.character
  if (typed < 4) return false
  return selected.text.startsWith(text)
}

function quote(value: string): string {
  return JSON.stringify(value.slice(0, 180))
}

function summary(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
}

function emptyRootSummary(): QwenRootPathTraceSummary {
  return {
    rootPathLanguage: null,
    rootPathBackend: "none",
    rootPathCapturedSymbols: "",
    rootPathEvidenceTokens: 0,
    rootPathCodeGraphSkippedReason: "not-run",
    rootPathBudgetTrimmed: false,
    receiverTypeResolved: false,
    fieldEvidenceSelected: false,
    typedefChainSelected: false,
  }
}
