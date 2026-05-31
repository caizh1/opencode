import type { CodeGraphFile, CodeGraphIndex } from "./codegraph-types"
import { ensureDerivedIndex, moduleKey, shardKeyForPath } from "./codegraph-index"
import type { StateMachine } from "./analysis-types"

export const CODEGRAPH_STORAGE_SCHEMA_VERSION = 1
export const CODEGRAPH_STORAGE_BACKEND = "json-sharded-sqlite-compatible" as const

export type CodeGraphSchemaTable =
  | "files"
  | "symbols"
  | "edges"
  | "postings"
  | "modules"
  | "state_machines"
  | "summaries"
  | "snapshots"
  | "schema_version"

export type CodeGraphStorageSchemaManifest = {
  version: number
  backend: typeof CODEGRAPH_STORAGE_BACKEND
  tables: CodeGraphSchemaTable[]
  ddl: string[]
  edgeKinds: CodeGraphStorageEdgeKind[]
  tableCounts: Partial<Record<CodeGraphSchemaTable, number>>
}

export type CodeGraphStorageEdgeKind = "call" | "include" | "import" | "type" | "reference" | "state-transition"

export type CodeGraphStorageEdge = {
  edgeId: string
  src: string
  dst: string
  edgeKind: CodeGraphStorageEdgeKind
  file: string
  startLine: number
  endLine: number
  confidence: number
  buildConfig?: string
}

export const CODEGRAPH_SQLITE_SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, language TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, module TEXT NOT NULL, shard TEXT NOT NULL, indexed_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS snapshots (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL, language TEXT NOT NULL, module TEXT NOT NULL, shard TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS symbols (symbol_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, fq_name TEXT NOT NULL, file TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, confidence REAL NOT NULL DEFAULT 1.0)",
  "CREATE TABLE IF NOT EXISTS edges (edge_id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, edge_kind TEXT NOT NULL, file TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, build_config TEXT)",
  "CREATE TABLE IF NOT EXISTS postings (term TEXT NOT NULL, doc_id TEXT NOT NULL, field TEXT NOT NULL, weight REAL NOT NULL, line INTEGER NOT NULL, symbol_id TEXT, PRIMARY KEY(term, doc_id, field, line, symbol_id))",
  "CREATE TABLE IF NOT EXISTS modules (module TEXT PRIMARY KEY, files INTEGER NOT NULL, functions INTEGER NOT NULL, macros INTEGER NOT NULL, types INTEGER NOT NULL, globals INTEGER NOT NULL, bytes INTEGER NOT NULL, external_callers INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS state_machines (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL, module TEXT NOT NULL, state_var TEXT NOT NULL, language TEXT NOT NULL, confidence REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS summaries (summary_id TEXT PRIMARY KEY, summary_kind TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, evidence_refs TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0)",
]

const TABLES: CodeGraphSchemaTable[] = [
  "files",
  "symbols",
  "edges",
  "postings",
  "modules",
  "state_machines",
  "summaries",
  "snapshots",
  "schema_version",
]

export function createCodeGraphStorageManifest(index: CodeGraphIndex, stateMachines: StateMachine[] = []): CodeGraphStorageSchemaManifest {
  const derived = ensureDerivedIndex(index)
  const files = Object.values(index.files)
  const symbolCount = Object.values(derived.symbolsByPath).reduce((count, values) => count + values.length, 0)
  const postingCount = Object.values(derived.postingsByTerm).reduce((count, values) => count + values.length, 0)
  const edgeCount = createCodeGraphStorageEdges(index, stateMachines).length
  const moduleCount = new Set(files.map((file) => moduleKey(file.path))).size
  return {
    version: CODEGRAPH_STORAGE_SCHEMA_VERSION,
    backend: CODEGRAPH_STORAGE_BACKEND,
    tables: TABLES,
    ddl: CODEGRAPH_SQLITE_SCHEMA,
    edgeKinds: ["call", "include", "import", "type", "reference", "state-transition"],
    tableCounts: {
      files: files.length,
      snapshots: files.length,
      symbols: symbolCount,
      edges: edgeCount,
      postings: postingCount,
      modules: moduleCount,
      state_machines: stateMachines.length,
      summaries: files.length + Object.keys(derived.moduleStats).length,
      schema_version: 1,
    },
  }
}

export function snapshotRowForFile(file: CodeGraphFile) {
  return {
    path: file.path,
    size: file.size,
    mtime: file.mtime ?? file.indexedAt ?? 0,
    sha256: file.sha256 ?? file.hash,
    language: file.language,
    module: file.module ?? moduleKey(file.path),
    shard: file.shard ?? shardKeyForPath(file.path),
  }
}

export function createCodeGraphStorageEdges(index: CodeGraphIndex, stateMachines: StateMachine[] = []): CodeGraphStorageEdge[] {
  const edges: CodeGraphStorageEdge[] = []
  for (const file of Object.values(index.files)) {
    for (const include of file.includes) {
      edges.push(edge(`${file.path}:include:${include.line}:${include.target}`, file.path, include.target, "include", file.path, include.line, include.line, 0.9))
      edges.push(edge(`${file.path}:import:${include.line}:${include.target}`, file.path, include.target, "import", file.path, include.line, include.line, 0.85))
    }
    for (const type of file.types) {
      edges.push(edge(`${file.path}:type:${type.startLine}:${type.name}`, file.path, type.name, "type", file.path, type.startLine, type.endLine, 0.8))
    }
    for (const symbol of [...file.macros.map((item) => ({ name: item.name, line: item.line })), ...file.globals.map((item) => ({ name: item.name, line: item.line }))]) {
      edges.push(edge(`${file.path}:reference:${symbol.line}:${symbol.name}`, file.path, symbol.name, "reference", file.path, symbol.line, symbol.line, 0.65))
    }
    for (const fn of file.functions) {
      for (const call of fn.calls) {
        edges.push(edge(`${fn.id}:call:${call.line}:${call.name}`, fn.id, call.name, "call", file.path, call.line, call.line, 0.75))
      }
    }
  }
  for (const machine of stateMachines) {
    for (const transition of machine.transitions) {
      edges.push(edge(
        transition.id,
        transition.fromState,
        transition.toState,
        "state-transition",
        transition.evidence.file,
        transition.evidence.startLine,
        transition.evidence.endLine,
        transition.confidence,
      ))
    }
  }
  return edges
}

function edge(
  edgeId: string,
  src: string,
  dst: string,
  edgeKind: CodeGraphStorageEdgeKind,
  file: string,
  startLine: number,
  endLine: number,
  confidence: number,
): CodeGraphStorageEdge {
  return { edgeId, src, dst, edgeKind, file, startLine, endLine, confidence }
}
