import * as vscode from "vscode"
import { renderQwenInlineCompletionItem } from "./range"
import type {
  QwenAutocompleteConfig,
  QwenAutocompleteInput,
  QwenAutocompleteOutcome,
  QwenAutocompleteRange,
  QwenRecentlyEditedRange,
  QwenTabAutocompleteOptions,
} from "./types"

export function qwenTabAutocompleteOptionsFromConfig(cfg: QwenAutocompleteConfig): QwenTabAutocompleteOptions {
  return {
    disable: !cfg.enabled || cfg.provider === "none",
    maxPromptTokens: cfg.maxPromptTokens,
    debounceDelay: cfg.debounceMs,
    modelTimeout: cfg.modelTimeout,
    maxSuffixPercentage: cfg.maxSuffixPercentage,
    prefixPercentage: cfg.prefixPercentage,
    transform: true,
    multilineCompletions: "auto",
    slidingWindowPrefixPercentage: cfg.prefixPercentage,
    slidingWindowSize: cfg.maxPromptTokens,
    useCache: cfg.cacheEnabled,
    onlyMyCode: true,
    useRecentlyEdited: cfg.recentlyEditedEnabled,
    useRecentlyOpened: cfg.recentlyOpenedEnabled,
    useImports: cfg.importDefinitionsEnabled,
    experimental_includeClipboard: false,
    experimental_includeRecentlyVisitedRanges: true,
    experimental_includeRecentlyEditedRanges: cfg.recentlyEditedEnabled,
    experimental_includeDiff: true,
    experimental_enableStaticContextualization: false,
  }
}

export function qwenAutocompleteInputFromVscode(input: {
  completionId: string
  context: vscode.InlineCompletionContext
  document: vscode.TextDocument
  position: vscode.Position
  recentlyEditedRanges?: QwenRecentlyEditedRange[]
  recentlyVisitedRanges?: QwenAutocompleteInput["recentlyVisitedRanges"]
}): QwenAutocompleteInput {
  const selected = input.context.selectedCompletionInfo
  return {
    isUntitledFile: input.document.isUntitled ?? input.document.uri.scheme !== "file",
    completionId: input.completionId,
    filepath: input.document.uri.fsPath || input.document.uri.path,
    pos: { line: input.position.line, character: input.position.character },
    recentlyVisitedRanges: input.recentlyVisitedRanges ?? [],
    recentlyEditedRanges: input.recentlyEditedRanges ?? [],
    manuallyPassFileContents: input.document.getText(),
    selectedCompletionInfo: selected
      ? {
          text: selected.text,
          range: qwenRangeFromVscode(selected.range),
        }
      : undefined,
  }
}

export function qwenOutcomeToInlineCompletionItem(input: {
  context: vscode.InlineCompletionContext
  document: vscode.TextDocument
  outcome: QwenAutocompleteOutcome
  position: vscode.Position
}): vscode.InlineCompletionItem | undefined {
  return renderQwenInlineCompletionItem(input.document, input.position, input.context, input.outcome.completion)
}

function qwenRangeFromVscode(range: vscode.Range): QwenAutocompleteRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}
