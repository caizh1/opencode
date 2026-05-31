import type { CodeGraphStatus } from "./types"
import type { AnalysisToolName, AnalysisToolResult, CodeIntelligenceSnapshot, QueryEvidenceResult } from "./analysis-types"
import type { CodeGraphStorageSchemaManifest } from "./codegraph-storage-schema"

export type CodeGraphInclude = {
  target: string
  system: boolean
  line: number
}

export type CodeGraphMacro = {
  name: string
  line: number
  snippet?: string
}

export type CodeGraphCall = {
  name: string
  line: number
}

export type CodeGraphTypeSymbol = {
  name: string
  kind: "struct" | "union" | "enum" | "typedef"
  startLine: number
  endLine: number
  snippet: string
}

export type CodeGraphGlobalSymbol = {
  name: string
  line: number
  snippet: string
}

export type CodeGraphAstControl = {
  kind: "if" | "switch" | "case"
  startLine: number
  endLine: number
  condition?: string
}

export type CodeGraphAstSummary = {
  parser: "tree-sitter-wasm"
  language: string
  functions: number
  calls: number
  ifStatements: number
  switchStatements: number
  caseStatements: number
  assignments: number
  errors: number
  controls: CodeGraphAstControl[]
}

export type CodeGraphFileTokenKind = "path" | "identifier" | "comment" | "macro" | "type" | "global"

export type CodeGraphFileToken = {
  term: string
  kind: CodeGraphFileTokenKind
  line: number
}

export type CodeGraphFunction = {
  id: string
  path: string
  name: string
  signature: string
  startLine: number
  endLine: number
  isStatic: boolean
  calls: CodeGraphCall[]
  snippet: string
}

export type CodeGraphFile = {
  path: string
  language: string
  hash: string
  sha256?: string
  mtime?: number
  module?: string
  shard?: string
  size: number
  indexedAt: number
  includes: CodeGraphInclude[]
  macros: CodeGraphMacro[]
  functions: CodeGraphFunction[]
  types: CodeGraphTypeSymbol[]
  globals: CodeGraphGlobalSymbol[]
  tokens: CodeGraphFileToken[]
  astSummary?: CodeGraphAstSummary
}

export type CodeGraphDirectoryStats = {
  files: number
  functions: number
  macros: number
  types: number
  globals: number
  bytes: number
}

export type CodeGraphIndexStats = {
  files: number
  functions: number
  macros: number
  types: number
  globals: number
  bytes: number
  shards: number
  skippedFiles: number
}

export type CodeGraphSymbolKind = "function" | "macro" | "type" | "global" | "file"

export type CodeGraphSymbol = {
  id: string
  kind: CodeGraphSymbolKind
  name: string
  path: string
  startLine: number
  endLine: number
  signature?: string
  snippet: string
}

export type CodeGraphPostingKind = CodeGraphFileTokenKind | "function" | "include"

export type CodeGraphPosting = {
  term: string
  path: string
  line: number
  kind: CodeGraphPostingKind
  weight: number
  symbolId?: string
}

export type CodeGraphModuleStats = CodeGraphDirectoryStats & {
  externalCallers: number
  hotSymbols: string[]
}

export type CodeGraphDerivedIndex = {
  functionIdsByName: Record<string, string[]>
  callerIdsByCallee: Record<string, string[]>
  includeTargetsByFile: Record<string, string[]>
  filePathsByInclude: Record<string, string[]>
  directoryStats: Record<string, CodeGraphDirectoryStats>
  symbolsByName: Record<string, CodeGraphSymbol[]>
  symbolsByPath: Record<string, CodeGraphSymbol[]>
  postingsByTerm: Record<string, CodeGraphPosting[]>
  moduleStats: Record<string, CodeGraphModuleStats>
}

export type CodeGraphIndex = {
  version: 1 | 2 | 3
  rootPath: string
  rootName: string
  updatedAt: number
  truncated: boolean
  files: Record<string, CodeGraphFile>
  derived?: CodeGraphDerivedIndex
  stats?: CodeGraphIndexStats
  storageMode?: "legacy-json" | "sharded"
  schema?: CodeGraphStorageSchemaManifest
}

export type CodeGraphShardManifest = {
  version: 2 | 3
  rootPath: string
  rootName: string
  updatedAt: number
  truncated: boolean
  derived: CodeGraphDerivedIndex
  stats: CodeGraphIndexStats
  schema?: CodeGraphStorageSchemaManifest
  shards: CodeGraphShardInfo[]
}

export type CodeGraphShardInfo = {
  key: string
  path: string
  files: number
  functions: number
  macros: number
  bytes: number
}

export type CodeGraphShardData = {
  version: 2 | 3
  key: string
  files: Record<string, CodeGraphFile>
}

export type CodeGraphQueryMode = "overview" | "callers" | "callees" | "call-chain" | "impact" | "explain"

export type CodeGraphEvidence = {
  path: string
  startLine: number
  endLine: number
  kind: CodeGraphSymbolKind | "caller" | "callee" | "include" | "module" | "text"
  score: number
  reason: string
  snippet: string
}

export type CodeGraphRetrievalResult = {
  mode: CodeGraphQueryMode
  tokens: string[]
  symbols: string[]
  evidence: CodeGraphEvidence[]
  candidateCount: number
  packedBytes: number
  omittedCandidates: number
  truncated: boolean
  elapsedMs: number
}

export type CodeGraphQueryMetrics = {
  mode: CodeGraphQueryMode
  tokens: string[]
  symbols: string[]
  candidateCount: number
  evidenceCount: number
  omittedCandidates: number
  packedBytes: number
  truncated: boolean
  elapsedMs: number
}

export type CodeGraphPromptContext = {
  text: string
  mode: CodeGraphQueryMode
  symbols: string[]
  truncated: boolean
  metrics: CodeGraphQueryMetrics
}

export type CodeGraphContextProvider = {
  status(): CodeGraphStatus
  indexWorkspace(force: boolean): Promise<void>
  cancelIndexing(reason?: string): void
  pauseIndexing(reason?: string): void
  resumeIndexing(): void
  metrics(): NonNullable<CodeGraphStatus["metrics"]>
  waitForReady(): Promise<void>
  showStatus(): Promise<void>
  buildContext(input: {
    question: string
    relatedPaths: string[]
    maxBytes: number
    maxDepth: number
    maxFanout: number
  }): Promise<CodeGraphPromptContext | undefined>
  intelligenceSnapshot(): Promise<CodeIntelligenceSnapshot | undefined>
  runAnalysisTool(input: {
    tool: AnalysisToolName
    args?: Record<string, unknown>
  }): Promise<AnalysisToolResult>
  queryEvidence(question: string): Promise<QueryEvidenceResult | undefined>
}
