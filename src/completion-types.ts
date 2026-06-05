export type CompletionPlanKind =
  | "ordinary-code"
  | "symbol-completion"
  | "comment-symbol-reference"
  | "previous-comment-continuation"
  | "comment-to-code"
  | "comment-to-test"
  | "natural-command"
  | "disabled"

export type CompletionSymbolFallbackKind = "comment-to-code" | "comment-to-test"

export type CompletionInsertMode =
  | "replace-current-word"
  | "insert-at-cursor"
  | "insert-after-line"
  | "replace-whole-line"

export type CompletionPlan = {
  kind: CompletionPlanKind
  insertMode: CompletionInsertMode
  targetSymbol?: string
  sourceComment?: string
  symbolFallbackKind?: CompletionSymbolFallbackKind
  replaceCurrentWord: boolean
  needsSymbolRetrieval: boolean
  needsTestRetrieval: boolean
  useFim: boolean
  useInstruction: boolean
  maxTokens: number
  confidenceFloor: number
}

export type RetrievedCompletionSnippet = {
  kind: string
  path: string
  line: number
  text: string
  name?: string
  score?: number
}

export type CompletionBackendRequest = {
  path: string
  languageId: string
  prefix: string
  suffix: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  retrievedSnippets: RetrievedCompletionSnippet[]
  maxTokens: number
  temperature: number
  topP?: number
}

export type CompletionCandidate = {
  text: string
  source: string
}
