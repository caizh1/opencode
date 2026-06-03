export type CompletionPlanKind = "symbol" | "comment-to-test" | "ordinary-code" | "disabled"

export type CompletionPlan = {
  kind: CompletionPlanKind
  replaceCurrentWord: boolean
  needsSymbolRetrieval: boolean
  needsTestRetrieval: boolean
  maxTokens: number
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
