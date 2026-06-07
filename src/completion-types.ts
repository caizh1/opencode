export type CompletionPlanKind =
  | "ordinary-code"
  | "c-embedded-code"
  | "body-continuation"
  | "top-level-declaration"
  | "symbol-completion"
  | "comment-symbol-reference"
  | "previous-comment-continuation"
  | "comment-to-code"
  | "comment-to-test"
  | "natural-command"
  | "disabled"

export type CompletionSymbolFallbackKind = "comment-to-code" | "comment-to-test"

export type CompletionRetrievalPolicyKind = "function" | "type" | "macro" | "global" | "field"

export type CompletionRetrievalPolicy = {
  label: string
  intent: CompletionCIntent
  queryMode: "c-embedded-intent"
  preferredKinds: CompletionRetrievalPolicyKind[]
}

export type CompletionCIntent =
  | "member-access"
  | "symbol-prefix"
  | "initializer"
  | "call-args"
  | "assignment-rhs"
  | "case-body"
  | "switch-case"
  | "top-level-declaration"
  | "top-level-decl"
  | "preprocessor"
  | "state-machine"
  | "body-statement"
  | "condition"
  | "error-path"
  | "mmio-register"

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
  cIntent?: CompletionCIntent
  symbolFallbackKind?: CompletionSymbolFallbackKind
  replaceCurrentWord: boolean
  needsSymbolRetrieval: boolean
  needsIntentRetrieval?: boolean
  needsTestRetrieval: boolean
  useFim: boolean
  useInstruction: boolean
  maxTokens: number
  confidenceFloor: number
  retrievalPolicy?: CompletionRetrievalPolicy
  domainHints?: string[]
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
