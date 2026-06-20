import crypto from "node:crypto"
import path from "node:path"
import * as vscode from "vscode"
import { readQwenAutocompleteConfig } from "./config"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import { QwenFimRequestError } from "./QwenFimClient"
import type { QwenAutocompleteConfig, QwenAutocompleteLogLevel } from "./types"

export type QwenDiagnosticPhase =
  | "provider-enter"
  | "config-read"
  | "ignore-guard"
  | "debounce"
  | "root-path:start"
  | "root-path:tree-path"
  | "root-path:c-query"
  | "root-path:receiver"
  | "root-path:type-chain"
  | "root-path:lsp-definition"
  | "root-path:codegraph"
  | "root-path:evidence-build"
  | "root-path:selected"
  | "prompt-built"
  | "request-start"
  | "response"
  | "postprocess"
  | "render"
  | "return-items"
  | "cancelled"
  | "stale"
  | "error"

export type QwenEmptyReason =
  | "none"
  | "disabled"
  | "prefiltered"
  | "guard-blocked"
  | "cancelled"
  | "stale"
  | "http-error"
  | "qwen-error"
  | "empty-model-response"
  | "empty-after-postprocess"
  | "render-rejected"
  | "selected-completion-invalid"

export type QwenCacheStatus = "disabled" | "miss" | "hit" | "render-rejected"

export type QwenDiagnosticInput = {
  cfg: QwenAutocompleteConfig
  requestId: string
  phase: QwenDiagnosticPhase
  document: vscode.TextDocument
  position: vscode.Position
  selected?: vscode.SelectedCompletionInfo
  prefixChars?: number
  suffixChars?: number
  helper?: QwenAutocompleteHelperVars
  diagnosticFields?: Record<string, unknown>
  guardBlocked?: boolean
  guardDecision?: string
  guardEnabled?: boolean
  guardErrorFailClosed?: boolean
  guardIgnored?: boolean
  guardLanguageAllowed?: boolean
  guardReason?: string
  guardSchemeAllowed?: boolean
  guardSensitive?: boolean
  guardSource?: string
  guardWorkspaceAllowed?: boolean
  prefilterDecision?: string
  prefilterExtension?: string
  prefilterLanguage?: string
  prefilterProviderEnabled?: boolean
  prefilterReason?: string
  contextReadGuardDecision?: string | null
  contextReadGuardSkippedCount?: number
  debounceMs?: number
  cancelled?: boolean
  stale?: boolean
  httpStatus?: number | null
  latencyMs?: number
  rawTextLength?: number
  filteredTextLength?: number
  finalTextLength?: number
  itemCount?: number
  cacheEnabled?: boolean
  cacheStatus?: QwenCacheStatus
  cacheHit?: boolean
  cacheEntryCount?: number
  cacheLookupPrefixChars?: number
  cacheReturnedChars?: number | null
  nonStreamingFilterEnabled?: boolean
  nonStreamingFilterApplied?: boolean
  nonStreamingFilterReasons?: string
  nonStreamingFilterInputChars?: number
  nonStreamingFilterOutputChars?: number
  nonStreamingFilterRejected?: boolean
  nonStreamingFilterTrimmed?: boolean
  nonStreamingFilterStopTokenHit?: boolean
  nonStreamingFilterSimilarLineHit?: boolean
  nonStreamingFilterRepeatingLineHit?: boolean
  nonStreamingFilterMarkdownFenceHit?: boolean
  nonStreamingFilterPathLineHit?: boolean
  nonStreamingFilterAdapterMode?: string
  snippetScaffoldEnabled?: boolean
  snippetSelectionAdapterPriority?: string
  snippetSelectionBudgetRemaining?: number
  snippetSelectionDroppedByBudgetCount?: number
  snippetSelectionDroppedDuplicateFileCount?: number
  snippetSelectionDroppedInvalidCount?: number
  snippetSelectionEnabled?: boolean
  snippetSelectionInjectedCount?: number
  snippetSelectionInjectedSources?: string
  snippetSelectionTotalPayloadCount?: number
  snippetSelectionTotalSelectedCount?: number
  snippetSelectionTotalSelectedTokens?: number
  snippetTotalCount?: number
  selectedSnippetCount?: number
  snippetTokenBudget?: number
  selectedSnippetTokens?: number
  recentlyOpenedFormattedCount?: number
  recentlyOpenedTrimmedCount?: number
  baseSnippetSelectedCount?: number
  baseSnippetInjectedCount?: number
  recentlyEditedEnabled?: boolean
  recentlyEditedInjectIntoPrompt?: boolean
  recentlyEditedTrackedRangeCount?: number
  recentlyEditedPayloadCount?: number
  recentlyEditedSelectedCount?: number
  recentlyEditedSelectedTokens?: number
  recentlyOpenedEnabled?: boolean
  recentlyOpenedInjectIntoPrompt?: boolean
  recentlyOpenedTrackedFileCount?: number
  recentlyOpenedPayloadCount?: number
  recentlyOpenedSelectedCount?: number
  recentlyOpenedSelectedTokens?: number
  recentlyOpenedReadTimeoutMs?: number
  recentlyOpenedSkippedCount?: number
  recentlyOpenedInjectedIntoPrompt?: boolean
  recentlyVisitedEnabled?: boolean
  recentlyVisitedTrackedRangeCount?: number
  recentlyVisitedPayloadCount?: number
  recentlyVisitedSelectedCount?: number
  recentlyVisitedSelectedTokens?: number
  recentlyVisitedInjectedIntoPrompt?: boolean
  importDefinitionsEnabled?: boolean
  importDefinitionsInjectIntoPrompt?: boolean
  importDefinitionsCacheSize?: number
  importDefinitionsPayloadCount?: number
  importDefinitionsSelectedCount?: number
  importDefinitionsSelectedTokens?: number
  importDefinitionsTimeoutMs?: number
  importDefinitionsSkippedCount?: number
  importDefinitionsInjectedIntoPrompt?: boolean
  rootPathEnabled?: boolean
  rootPathInjectIntoPrompt?: boolean
  rootPathCacheSize?: number
  rootPathPayloadCount?: number
  rootPathSelectedCount?: number
  rootPathSelectedTokens?: number
  rootPathTimeoutMs?: number
  rootPathSkippedCount?: number
  rootPathInjectedIntoPrompt?: boolean
  rootPathBlockedReason?: string
  rootPathLanguage?: string | null
  rootPathBackend?: string
  rootPathCapturedSymbols?: string
  rootPathEvidenceTokens?: number
  rootPathCodeGraphSkippedReason?: string
  rootPathBudgetTrimmed?: boolean
  receiverTypeResolved?: boolean
  fieldEvidenceSelected?: boolean
  typedefChainSelected?: boolean
  snippetsInjectedIntoPrompt?: boolean
  contextLength?: number
  contextLengthSource?: string
  availablePromptTokens?: number | null
  promptRendererMode?: string
  snippetInjectionBlockedReason?: string
  renderedPrefixChars?: number | null
  renderedSuffixChars?: number | null
  renderedPromptChars?: number | null
  estimatedRenderedPromptTokens?: number | null
  multilineAllowed?: boolean
  multilineBlockedReason?: string
  multilineClassifierMode?: string
  multilineClassifierSource?: string
  multilineLanguage?: string
  multilineSelectedCompletionInfo?: boolean
  multilineSingleLineComment?: string
  multilineUseMultilineApplied?: boolean
  multilineShown?: boolean
  range?: unknown
  insertText?: string
  filterReason?: string
  emptyReason?: QwenEmptyReason
  error?: unknown
  prompt?: string
  completion?: string
}

export const QWEN_DIAGNOSTIC_CHANNEL = "ChipMate qwen-direct autocomplete"
const MAX_LINES = 2_000
const MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_LIMIT = 160
const TOKEN = /(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{24,}/g
const URL_HOST = /\bhttps?:\/\/[^/\s"]+/g
const PATHISH = /(?:[A-Za-z]:\\|\/)[^\s"]{12,}/g

let channel: vscode.OutputChannel | undefined
let lines: string[] = []
let bytes = 0

export function emitQwenDiagnostic(input: QwenDiagnosticInput): void {
  if (!enabled(input.cfg)) return
  const entry = entryFor(input)
  const line = JSON.stringify(entry)
  buffer(line)
  getChannel().appendLine(line)
}

export function showQwenAutocompleteLogs(): void {
  getChannel().show()
}

export async function exportQwenAutocompleteDiagnostics(): Promise<boolean> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`qwen-direct-autocomplete-diagnostics-${stamp()}.jsonl`),
    filters: { JSONL: ["jsonl"] },
    saveLabel: "Export",
  })
  if (!uri) return false
  const text = exportText()
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"))
  return true
}

export function qwenDiagnosticsForTests(): string[] {
  return [...lines]
}

export function resetQwenDiagnosticsForTests(): void {
  lines = []
  bytes = 0
  channel = undefined
}

export function endpointPath(endpoint: string): string | null {
  try {
    return new URL(endpoint).pathname || null
  } catch {
    const match = endpoint.match(/\/v\d+\/[^?\s]+/)
    return match?.[0] ?? null
  }
}

export function pathHash(file: string): string {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16)
}

export function rangePreview(range: unknown): string | null {
  if (!rangeInfo(range)) return null
  return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`
}

export function errorKind(err: unknown): string | null {
  if (err instanceof QwenFimRequestError) return err.status > 0 ? "http-error" : "qwen-error"
  if (err instanceof Error) return err.name || "Error"
  if (err === undefined || err === null) return null
  return "unknown"
}

export function errorReason(err: unknown): QwenEmptyReason {
  if (err instanceof QwenFimRequestError) {
    if (err.status > 0) return "http-error"
    if (err.message.includes("missing choices[0].text") || err.message.includes("empty")) return "empty-model-response"
  }
  return "qwen-error"
}

export function redact(value: string): string {
  return value.replace(TOKEN, "[redacted]").replace(URL_HOST, "[redacted-host]").replace(PATHISH, "[redacted-path]")
}

function entryFor(input: QwenDiagnosticInput): Record<string, unknown> {
  const selected = selectedInfo(input.selected)
  const level = input.cfg.logLevel
  const text = input.insertText ?? input.completion
  return clean({
    ts: new Date().toISOString(),
    requestId: input.requestId,
    phase: input.phase,
    provider: "qwen-direct",
    model: input.cfg.model,
    endpointPath: endpointPath(input.cfg.endpoint),
    ...fileInfo(input.document),
    ...posInfo(input.position),
    prefixChars: none(input.prefixChars),
    suffixChars: none(input.suffixChars),
    ...helperInfo(input.cfg, input.helper),
    selectedCompletionInfoPresent: selected.present,
    selectedTextLength: selected.length,
    selectedRangePreview: selected.range,
    guardBlocked: none(input.guardBlocked),
    ...safetyInfo(input),
    debounceMs: input.debounceMs ?? input.cfg.debounceMs,
    cancelled: input.cancelled ?? false,
    stale: input.stale ?? false,
    httpStatus: none(input.httpStatus),
    latencyMs: none(input.latencyMs),
    rawTextLength: none(input.rawTextLength),
    filteredTextLength: none(input.filteredTextLength),
    finalTextLength: none(input.finalTextLength),
    itemCount: none(input.itemCount),
    cacheEnabled: none(input.cacheEnabled),
    cacheStatus: input.cacheStatus ?? null,
    cacheHit: none(input.cacheHit),
    cacheEntryCount: none(input.cacheEntryCount),
    cacheLookupPrefixChars: none(input.cacheLookupPrefixChars),
    cacheReturnedChars: none(input.cacheReturnedChars),
    nonStreamingFilterEnabled: none(input.nonStreamingFilterEnabled),
    nonStreamingFilterApplied: none(input.nonStreamingFilterApplied),
    nonStreamingFilterReasons: input.nonStreamingFilterReasons ?? null,
    nonStreamingFilterInputChars: none(input.nonStreamingFilterInputChars),
    nonStreamingFilterOutputChars: none(input.nonStreamingFilterOutputChars),
    nonStreamingFilterRejected: none(input.nonStreamingFilterRejected),
    nonStreamingFilterTrimmed: none(input.nonStreamingFilterTrimmed),
    nonStreamingFilterStopTokenHit: none(input.nonStreamingFilterStopTokenHit),
    nonStreamingFilterSimilarLineHit: none(input.nonStreamingFilterSimilarLineHit),
    nonStreamingFilterRepeatingLineHit: none(input.nonStreamingFilterRepeatingLineHit),
    nonStreamingFilterMarkdownFenceHit: none(input.nonStreamingFilterMarkdownFenceHit),
    nonStreamingFilterPathLineHit: none(input.nonStreamingFilterPathLineHit),
    nonStreamingFilterAdapterMode: input.nonStreamingFilterAdapterMode ?? null,
    snippetScaffoldEnabled: none(input.snippetScaffoldEnabled),
    snippetSelectionEnabled: none(input.snippetSelectionEnabled),
    snippetSelectionTotalPayloadCount: none(input.snippetSelectionTotalPayloadCount),
    snippetSelectionTotalSelectedCount: none(input.snippetSelectionTotalSelectedCount),
    snippetSelectionTotalSelectedTokens: none(input.snippetSelectionTotalSelectedTokens),
    snippetSelectionDroppedByBudgetCount: none(input.snippetSelectionDroppedByBudgetCount),
    snippetSelectionDroppedDuplicateFileCount: none(input.snippetSelectionDroppedDuplicateFileCount),
    snippetSelectionDroppedInvalidCount: none(input.snippetSelectionDroppedInvalidCount),
    snippetSelectionInjectedCount: none(input.snippetSelectionInjectedCount),
    snippetSelectionInjectedSources: input.snippetSelectionInjectedSources ?? null,
    snippetSelectionAdapterPriority: input.snippetSelectionAdapterPriority ?? null,
    snippetSelectionBudgetRemaining: none(input.snippetSelectionBudgetRemaining),
    snippetTotalCount: none(input.snippetTotalCount),
    selectedSnippetCount: none(input.selectedSnippetCount),
    snippetTokenBudget: none(input.snippetTokenBudget),
    selectedSnippetTokens: none(input.selectedSnippetTokens),
    recentlyOpenedFormattedCount: none(input.recentlyOpenedFormattedCount),
    recentlyOpenedTrimmedCount: none(input.recentlyOpenedTrimmedCount),
    baseSnippetSelectedCount: none(input.baseSnippetSelectedCount),
    baseSnippetInjectedCount: none(input.baseSnippetInjectedCount),
    recentlyEditedEnabled: none(input.recentlyEditedEnabled),
    recentlyEditedInjectIntoPrompt: none(input.recentlyEditedInjectIntoPrompt),
    recentlyEditedTrackedRangeCount: none(input.recentlyEditedTrackedRangeCount),
    recentlyEditedPayloadCount: none(input.recentlyEditedPayloadCount),
    recentlyEditedSelectedCount: none(input.recentlyEditedSelectedCount),
    recentlyEditedSelectedTokens: none(input.recentlyEditedSelectedTokens),
    recentlyOpenedEnabled: none(input.recentlyOpenedEnabled),
    recentlyOpenedInjectIntoPrompt: none(input.recentlyOpenedInjectIntoPrompt),
    recentlyOpenedTrackedFileCount: none(input.recentlyOpenedTrackedFileCount),
    recentlyOpenedPayloadCount: none(input.recentlyOpenedPayloadCount),
    recentlyOpenedSelectedCount: none(input.recentlyOpenedSelectedCount),
    recentlyOpenedSelectedTokens: none(input.recentlyOpenedSelectedTokens),
    recentlyOpenedReadTimeoutMs: none(input.recentlyOpenedReadTimeoutMs),
    recentlyOpenedSkippedCount: none(input.recentlyOpenedSkippedCount),
    recentlyOpenedInjectedIntoPrompt: none(input.recentlyOpenedInjectedIntoPrompt),
    recentlyVisitedEnabled: none(input.recentlyVisitedEnabled),
    recentlyVisitedTrackedRangeCount: none(input.recentlyVisitedTrackedRangeCount),
    recentlyVisitedPayloadCount: none(input.recentlyVisitedPayloadCount),
    recentlyVisitedSelectedCount: none(input.recentlyVisitedSelectedCount),
    recentlyVisitedSelectedTokens: none(input.recentlyVisitedSelectedTokens),
    recentlyVisitedInjectedIntoPrompt: none(input.recentlyVisitedInjectedIntoPrompt),
    importDefinitionsEnabled: none(input.importDefinitionsEnabled),
    importDefinitionsInjectIntoPrompt: none(input.importDefinitionsInjectIntoPrompt),
    importDefinitionsCacheSize: none(input.importDefinitionsCacheSize),
    importDefinitionsPayloadCount: none(input.importDefinitionsPayloadCount),
    importDefinitionsSelectedCount: none(input.importDefinitionsSelectedCount),
    importDefinitionsSelectedTokens: none(input.importDefinitionsSelectedTokens),
    importDefinitionsTimeoutMs: none(input.importDefinitionsTimeoutMs),
    importDefinitionsSkippedCount: none(input.importDefinitionsSkippedCount),
    importDefinitionsInjectedIntoPrompt: none(input.importDefinitionsInjectedIntoPrompt),
    rootPathEnabled: none(input.rootPathEnabled),
    rootPathInjectIntoPrompt: none(input.rootPathInjectIntoPrompt),
    rootPathCacheSize: none(input.rootPathCacheSize),
    rootPathPayloadCount: none(input.rootPathPayloadCount),
    rootPathSelectedCount: none(input.rootPathSelectedCount),
    rootPathSelectedTokens: none(input.rootPathSelectedTokens),
    rootPathTimeoutMs: none(input.rootPathTimeoutMs),
    rootPathSkippedCount: none(input.rootPathSkippedCount),
    rootPathInjectedIntoPrompt: none(input.rootPathInjectedIntoPrompt),
    rootPathBlockedReason: input.rootPathBlockedReason ?? null,
    rootPathLanguage: input.rootPathLanguage ?? null,
    rootPathBackend: input.rootPathBackend ?? null,
    rootPathCapturedSymbols: input.rootPathCapturedSymbols ?? null,
    rootPathEvidenceTokens: none(input.rootPathEvidenceTokens),
    rootPathCodeGraphSkippedReason: input.rootPathCodeGraphSkippedReason ?? null,
    rootPathBudgetTrimmed: none(input.rootPathBudgetTrimmed),
    receiverTypeResolved: none(input.receiverTypeResolved),
    fieldEvidenceSelected: none(input.fieldEvidenceSelected),
    typedefChainSelected: none(input.typedefChainSelected),
    snippetsInjectedIntoPrompt: none(input.snippetsInjectedIntoPrompt),
    contextLength: none(input.contextLength),
    contextLengthSource: input.contextLengthSource ?? null,
    availablePromptTokens: none(input.availablePromptTokens),
    promptRendererMode: input.promptRendererMode ?? null,
    snippetInjectionBlockedReason: input.snippetInjectionBlockedReason ?? null,
    renderedPrefixChars: none(input.renderedPrefixChars),
    renderedSuffixChars: none(input.renderedSuffixChars),
    renderedPromptChars: none(input.renderedPromptChars),
    estimatedRenderedPromptTokens: none(input.estimatedRenderedPromptTokens),
    ...multilineInfo(input),
    rangePreview: rangePreview(input.range),
    insertFirstLinePreview: completionPreview(level, input.cfg, text),
    filterReason: input.filterReason ?? "none",
    emptyReason: input.emptyReason ?? "none",
    errorKind: errorKind(input.error),
    errorMessage: input.error ? redact(summary(input.error)) : null,
    promptPreview: promptPreview(),
    ...(input.diagnosticFields ?? {}),
  })
}

function multilineInfo(input: QwenDiagnosticInput): Record<string, unknown> {
  return {
    multilineAllowed: none(input.multilineAllowed),
    multilineBlockedReason: input.multilineBlockedReason ?? null,
    multilineClassifierMode: input.multilineClassifierMode ?? null,
    multilineClassifierSource: input.multilineClassifierSource ?? null,
    multilineLanguage: input.multilineLanguage ?? null,
    multilineSelectedCompletionInfo: none(input.multilineSelectedCompletionInfo),
    multilineSingleLineComment: input.multilineSingleLineComment ?? null,
    multilineUseMultilineApplied: none(input.multilineUseMultilineApplied),
    multilineShown: none(input.multilineShown),
  }
}

function safetyInfo(input: QwenDiagnosticInput): Record<string, unknown> {
  return {
    guardEnabled: none(input.guardEnabled),
    guardDecision: input.guardDecision ?? null,
    guardReason: input.guardReason ?? null,
    guardSource: input.guardSource ?? null,
    guardSchemeAllowed: none(input.guardSchemeAllowed),
    guardWorkspaceAllowed: none(input.guardWorkspaceAllowed),
    guardLanguageAllowed: none(input.guardLanguageAllowed),
    guardIgnored: none(input.guardIgnored),
    guardSensitive: none(input.guardSensitive),
    guardErrorFailClosed: none(input.guardErrorFailClosed),
    prefilterDecision: input.prefilterDecision ?? null,
    prefilterReason: input.prefilterReason ?? null,
    prefilterLanguage: input.prefilterLanguage ?? null,
    prefilterExtension: input.prefilterExtension ?? null,
    prefilterProviderEnabled: none(input.prefilterProviderEnabled),
    contextReadGuardDecision: input.contextReadGuardDecision ?? null,
    contextReadGuardSkippedCount: none(input.contextReadGuardSkippedCount),
  }
}

function fileInfo(document: vscode.TextDocument): Record<string, unknown> {
  const file = document.uri.fsPath || document.uri.path || ""
  const ext = path.extname(file).toLowerCase()
  return {
    languageId: document.languageId,
    fileExt: ext || null,
    pathHash: pathHash(file),
  }
}

function posInfo(position: vscode.Position): Record<string, unknown> {
  return {
    line: position.line + 1,
    character: position.character + 1,
  }
}

function none<T>(value: T | null | undefined): T | null {
  return value ?? null
}

function exportText(): string {
  const meta = JSON.stringify({
    ts: new Date().toISOString(),
    type: "metadata",
    extensionVersion: extensionVersion(),
    vscodeVersion: vscode.version,
    platform: process.platform,
    arch: process.arch,
  })
  const settings = JSON.stringify({
    ts: new Date().toISOString(),
    type: "qwen-settings",
    settings: settingsSnapshot(readQwenAutocompleteConfig()),
  })
  return `${[meta, settings, ...lines].join("\n")}\n`
}

function settingsSnapshot(cfg: QwenAutocompleteConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    endpointPath: endpointPath(cfg.endpoint),
    model: cfg.model,
    apiKey: cfg.apiKey ? "[redacted]" : "",
    debounceMs: cfg.debounceMs,
    maxTokens: cfg.maxTokens,
    maxPromptTokens: cfg.maxPromptTokens,
    modelTimeout: cfg.modelTimeout,
    prefixPercentage: cfg.prefixPercentage,
    maxSuffixPercentage: cfg.maxSuffixPercentage,
    temperature: cfg.temperature,
    cacheEnabled: cfg.cacheEnabled,
    cacheMaxEntries: cfg.cacheMaxEntries,
    prefixChars: cfg.prefixChars,
    suffixChars: cfg.suffixChars,
    multifileContextEnabled: cfg.multifileContextEnabled,
    contextLength: cfg.contextLength,
    recentlyEditedEnabled: cfg.recentlyEditedEnabled,
    recentlyEditedInjectIntoPrompt: cfg.recentlyEditedInjectIntoPrompt,
    recentlyEditedMaxRanges: cfg.recentlyEditedMaxRanges,
    recentlyEditedMaxRangeLines: cfg.recentlyEditedMaxRangeLines,
    recentlyOpenedEnabled: cfg.recentlyOpenedEnabled,
    recentlyOpenedInjectIntoPrompt: cfg.recentlyOpenedInjectIntoPrompt,
    recentlyOpenedMaxFiles: cfg.recentlyOpenedMaxFiles,
    recentlyOpenedFileReadTimeoutMs: cfg.recentlyOpenedFileReadTimeoutMs,
    importDefinitionsEnabled: cfg.importDefinitionsEnabled,
    importDefinitionsInjectIntoPrompt: cfg.importDefinitionsInjectIntoPrompt,
    importDefinitionsTimeoutMs: cfg.importDefinitionsTimeoutMs,
    importDefinitionsCacheSize: cfg.importDefinitionsCacheSize,
    rootPathEnabled: cfg.rootPathEnabled,
    rootPathInjectIntoPrompt: cfg.rootPathInjectIntoPrompt,
    rootPathTimeoutMs: cfg.rootPathTimeoutMs,
    rootPathCacheSize: cfg.rootPathCacheSize,
    trace: cfg.trace,
    logLevel: cfg.logLevel,
    logPromptPreview: cfg.logPromptPreview,
    logCompletionPreview: cfg.logCompletionPreview,
  }
}

function helperInfo(cfg: QwenAutocompleteConfig, helper?: QwenAutocompleteHelperVars): Record<string, unknown> {
  const base = {
    maxPromptTokens: cfg.maxPromptTokens,
    prefixPercentage: cfg.prefixPercentage,
    maxSuffixPercentage: cfg.maxSuffixPercentage,
  }
  if (!helper) return { ...base, ...emptyHelperInfo() }
  return {
    ...base,
    fullPrefixChars: helper.fullPrefix.length,
    fullSuffixChars: helper.fullSuffix.length,
    prunedPrefixChars: helper.prunedPrefix.length,
    prunedSuffixChars: helper.prunedSuffix.length,
    prunedCaretWindowChars: helper.prunedCaretWindow.length,
    estimatedPrefixTokens: helper.estimatedPrefixTokens,
    estimatedSuffixTokens: helper.estimatedSuffixTokens,
    estimatedPromptTokens: helper.estimatedPromptTokens,
    tokenizerSource: helper.tokenizerSource,
    helperParityMode: helper.helperParityMode,
    treePathStatus: helper.treePathStatus,
    treePathDepth: helper.treePath?.length ?? 0,
    treeSitterStage: helper.treeSitterDiagnostic?.stage ?? null,
    treeSitterLanguageName: helper.treeSitterDiagnostic?.languageName ?? null,
    treeSitterQueryPath: helper.treeSitterDiagnostic?.queryPath ?? null,
    treeSitterAssetRootConfigured: helper.treeSitterDiagnostic?.assetRootConfigured ?? null,
    treeSitterAssetRootBasename: helper.treeSitterDiagnostic?.assetRootBasename ?? null,
    treeSitterVendorRootExists: helper.treeSitterDiagnostic?.vendorRootExists ?? null,
    treeSitterRuntimeJsExists: helper.treeSitterDiagnostic?.runtimeJsExists ?? null,
    treeSitterRuntimeWasmExists: helper.treeSitterDiagnostic?.runtimeWasmExists ?? null,
    treeSitterLanguageWasmExists: helper.treeSitterDiagnostic?.languageWasmExists ?? null,
    treeSitterQueryAssetExists: helper.treeSitterDiagnostic?.queryAssetExists ?? null,
    treeSitterErrorKind: helper.treeSitterDiagnostic?.errorKind ?? null,
    treeSitterErrorMessage: helper.treeSitterDiagnostic?.errorMessage
      ? redact(helper.treeSitterDiagnostic.errorMessage)
      : null,
  }
}

function emptyHelperInfo(): Record<string, unknown> {
  return {
    fullPrefixChars: null,
    fullSuffixChars: null,
    prunedPrefixChars: null,
    prunedSuffixChars: null,
    prunedCaretWindowChars: null,
    estimatedPrefixTokens: null,
    estimatedSuffixTokens: null,
    estimatedPromptTokens: null,
    tokenizerSource: null,
    helperParityMode: null,
    treePathStatus: null,
    treePathDepth: null,
    treeSitterStage: null,
    treeSitterLanguageName: null,
    treeSitterQueryPath: null,
    treeSitterAssetRootConfigured: null,
    treeSitterAssetRootBasename: null,
    treeSitterVendorRootExists: null,
    treeSitterRuntimeJsExists: null,
    treeSitterRuntimeWasmExists: null,
    treeSitterLanguageWasmExists: null,
    treeSitterQueryAssetExists: null,
    treeSitterErrorKind: null,
    treeSitterErrorMessage: null,
  }
}

function buffer(line: string): void {
  lines.push(line)
  bytes += Buffer.byteLength(line, "utf8") + 1
  while (lines.length > MAX_LINES || bytes > MAX_BYTES) {
    const head = lines.shift()
    if (!head) continue
    bytes -= Buffer.byteLength(head, "utf8") + 1
  }
}

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel(QWEN_DIAGNOSTIC_CHANNEL)
  return channel
}

function enabled(cfg: QwenAutocompleteConfig): boolean {
  return cfg.trace && cfg.logLevel !== "off"
}

function selectedInfo(selected?: vscode.SelectedCompletionInfo): {
  present: boolean
  length: number | null
  range: string | null
} {
  if (!selected) return { present: false, length: null, range: null }
  return {
    present: true,
    length: selected.text.length,
    range: rangePreview(selected.range),
  }
}

function completionPreview(level: QwenAutocompleteLogLevel, cfg: QwenAutocompleteConfig, text?: string): string | null {
  if (level !== "debug" || !cfg.logCompletionPreview || !text) return null
  return redact(firstLine(text))
}

function promptPreview(): null {
  // qwen prompts may include selected snippets/source after multifile FIM injection;
  // keep prompt diagnostics to redacted counts/chars/tokens/hash only.
  return null
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.slice(0, PREVIEW_LIMIT) ?? ""
}

function extensionVersion(): string {
  return String(vscode.extensions.getExtension("chipmate.chipmate")?.packageJSON?.version ?? "unknown")
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function summary(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300)
  return String(err).slice(0, 300)
}

function clean(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value === undefined ? null : value]))
}

function rangeInfo(value: unknown): value is {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  if (!value || typeof value !== "object") return false
  const range = value as { start?: unknown; end?: unknown }
  if (!point(range.start) || !point(range.end)) return false
  return true
}

function point(value: unknown): value is { line: number; character: number } {
  if (!value || typeof value !== "object") return false
  const pos = value as { line?: unknown; character?: unknown }
  return typeof pos.line === "number" && typeof pos.character === "number"
}
