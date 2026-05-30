import type { CodeGraphStatus } from "./types"

export type CodeGraphInclude = {
  target: string
  system: boolean
  line: number
}

export type CodeGraphMacro = {
  name: string
  line: number
}

export type CodeGraphCall = {
  name: string
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
  size: number
  indexedAt: number
  includes: CodeGraphInclude[]
  macros: CodeGraphMacro[]
  functions: CodeGraphFunction[]
}

export type CodeGraphDirectoryStats = {
  files: number
  functions: number
  macros: number
  bytes: number
}

export type CodeGraphIndexStats = {
  files: number
  functions: number
  macros: number
  bytes: number
  shards: number
  skippedFiles: number
}

export type CodeGraphDerivedIndex = {
  functionIdsByName: Record<string, string[]>
  callerIdsByCallee: Record<string, string[]>
  includeTargetsByFile: Record<string, string[]>
  filePathsByInclude: Record<string, string[]>
  directoryStats: Record<string, CodeGraphDirectoryStats>
}

export type CodeGraphIndex = {
  version: 1 | 2
  rootPath: string
  rootName: string
  updatedAt: number
  truncated: boolean
  files: Record<string, CodeGraphFile>
  derived?: CodeGraphDerivedIndex
  stats?: CodeGraphIndexStats
  storageMode?: "legacy-json" | "sharded"
}

export type CodeGraphShardManifest = {
  version: 2
  rootPath: string
  rootName: string
  updatedAt: number
  truncated: boolean
  derived: CodeGraphDerivedIndex
  stats: CodeGraphIndexStats
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
  version: 2
  key: string
  files: Record<string, CodeGraphFile>
}

export type CodeGraphPromptContext = {
  text: string
  mode: string
  symbols: string[]
  truncated: boolean
}

export type CodeGraphContextProvider = {
  status(): CodeGraphStatus
  indexWorkspace(force: boolean): Promise<void>
  showStatus(): Promise<void>
  buildContext(input: {
    question: string
    relatedPaths: string[]
    maxBytes: number
  }): Promise<CodeGraphPromptContext | undefined>
}
