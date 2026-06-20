export type QwenAutocompleteProvider = "qwen-direct" | "none"

export type QwenMultilineCompletions = "always" | "never" | "auto"

export type QwenAutocompleteLogLevel = "off" | "info" | "debug"

export type QwenPromptRendererMode = "single-file-qwen-fim" | "qwen-multifile-fim" | "disabled" | "blocked"

export type QwenRootPathBlockedReason =
  | "none"
  | "disabled"
  | "missing-tree-path"
  | "missing-query-asset"
  | "query-load-failed"
  | "timeout"
  | "guard-blocked"
  | "error"

export type QwenSnippetInjectionBlockedReason =
  | "none"
  | "disabled"
  | "no-selected-snippets"
  | "unknown-context-length"
  | "insufficient-context-length"
  | "unsupported-model"
  | "unsafe"
  | "error"

export type QwenAutocompleteConfig = {
  enabled: boolean
  provider: QwenAutocompleteProvider
  endpoint: string
  model: string
  apiKey: string
  debounceMs: number
  maxTokens: number
  maxPromptTokens: number
  modelTimeout: number
  maxSuffixPercentage: number
  prefixPercentage: number
  temperature: number
  cacheEnabled: boolean
  cacheMaxEntries: number
  prefixChars: number
  suffixChars: number
  multifileContextEnabled: boolean
  contextLength: number
  recentlyEditedEnabled: boolean
  recentlyEditedInjectIntoPrompt: boolean
  recentlyEditedMaxRanges: number
  recentlyEditedMaxRangeLines: number
  recentlyOpenedEnabled: boolean
  recentlyOpenedInjectIntoPrompt: boolean
  recentlyOpenedMaxFiles: number
  recentlyOpenedFileReadTimeoutMs: number
  importDefinitionsEnabled: boolean
  importDefinitionsInjectIntoPrompt: boolean
  importDefinitionsTimeoutMs: number
  importDefinitionsCacheSize: number
  rootPathEnabled: boolean
  rootPathInjectIntoPrompt: boolean
  rootPathTimeoutMs: number
  rootPathCacheSize: number
  trace: boolean
  logLevel: QwenAutocompleteLogLevel
  logPromptPreview: boolean
  logCompletionPreview: boolean
}

export type QwenAutocompletePosition = {
  line: number
  character: number
}

export type QwenAutocompleteRange = {
  start: QwenAutocompletePosition
  end: QwenAutocompletePosition
}

export type QwenRecentlyEditedRange = {
  filepath: string
  lines: string[]
  range?: QwenAutocompleteRange | unknown
  timestamp: number
  symbols?: Set<string>
}

export type QwenTabAutocompleteOptions = {
  disable: boolean
  maxPromptTokens: number
  debounceDelay: number
  modelTimeout: number
  maxSuffixPercentage: number
  prefixPercentage: number
  transform: boolean
  multilineCompletions: QwenMultilineCompletions
  slidingWindowPrefixPercentage: number
  slidingWindowSize: number
  useCache: boolean
  onlyMyCode: boolean
  useRecentlyEdited: boolean
  useRecentlyOpened: boolean
  useImports: boolean
  showWhateverWeHaveAtXMs?: number
  experimental_includeClipboard: boolean | number
  experimental_includeRecentlyVisitedRanges: boolean | number
  experimental_includeRecentlyEditedRanges: boolean | number
  experimental_includeDiff: boolean | number
  experimental_enableStaticContextualization: boolean
}

export type QwenAutocompleteInput = {
  isUntitledFile: boolean
  completionId: string
  filepath: string
  pos: QwenAutocompletePosition
  recentlyVisitedRanges: Array<{ filepath: string; content: string; type: "code" }>
  recentlyEditedRanges: QwenRecentlyEditedRange[]
  manuallyPassFileContents?: string
  manuallyPassPrefix?: string
  selectedCompletionInfo?: {
    text: string
    range: QwenAutocompleteRange
  }
  injectDetails?: string
}

export type QwenAutocompleteOutcome = QwenTabAutocompleteOptions & {
  accepted?: boolean
  time: number
  prefix: string
  suffix: string
  prompt: string
  completion: string
  modelProvider: string
  modelName: string
  completionOptions: unknown
  cacheHit: boolean
  numLines: number
  filepath: string
  gitRepo?: string
  completionId: string
  uniqueId: string
  timestamp: string
  enabledStaticContextualization?: boolean
}

export type QwenFimParts = {
  prefix: string
  suffix: string
}

export type QwenFimCompleteInput = {
  endpoint: string
  model: string
  apiKey: string
  prompt: string
  maxTokens: number
  temperature: number
  signal?: AbortSignal
  onResponse?: (info: { status: number }) => void
}

export type QwenRequestInfo = {
  id: string
  path: string
  line: number
  character: number
  version: number
}
