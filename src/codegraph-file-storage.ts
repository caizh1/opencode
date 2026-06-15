import {
  CODEGRAPH_JSON_HARD_PART_BYTES,
  CODEGRAPH_JSON_TARGET_PART_BYTES,
  estimateJsonBytes,
  splitArrayValueIntoBoundedChunks,
  splitRecordIntoBoundedJsonParts,
  type BoundedJsonPart,
} from "./codegraph-bounded-json"
import { CURRENT_CODE_GRAPH_INDEX_VERSION } from "./codegraph-index"
import type {
  CodeGraphAstControl,
  CodeGraphCallSite,
  CodeGraphErrorLabel,
  CodeGraphFile,
  CodeGraphFunction,
  CodeGraphGlobalSymbol,
  CodeGraphInclude,
  CodeGraphInitializerExample,
  CodeGraphMacro,
  CodeGraphRegisterMacroFamily,
  CodeGraphShardData,
  CodeGraphStoredFileArrayField,
  CodeGraphStoredFileBase,
  CodeGraphStoredFilePart,
  CodeGraphTypeSymbol,
  CodeGraphFileToken,
} from "./codegraph-types"

export const CODEGRAPH_FILE_ARRAY_FIELDS: CodeGraphStoredFileArrayField[] = [
  "includes",
  "macros",
  "functions",
  "types",
  "globals",
  "callSites",
  "initializers",
  "errorLabels",
  "registerMacroFamilies",
  "tokens",
  "astSummary.controls",
]

const LARGE_FILE_SIZE_BYTES = 2 * 1024 * 1024
const LARGE_FILE_ARRAY_ITEMS = 25000
const LARGE_FILE_RECORD_BYTES = 24 * 1024 * 1024

type SplitFilesOptions = {
  shardKey: string
  basePath: string
  label: string
  targetPartBytes?: number
  hardPartBytes?: number
  stringify?: (value: unknown) => string | undefined
  onLargeFileSplit?: (event: { path: string; field: CodeGraphStoredFileArrayField; items: number; chunks: number }) => void
  onProgress?: (event: { label: string; processed: number; total: number }) => void
}

export function splitCodeGraphFilesForStorage(
  files: Record<string, CodeGraphFile>,
  options: SplitFilesOptions,
): BoundedJsonPart<CodeGraphShardData>[] {
  const fileParts = Object.create(null) as Record<string, CodeGraphStoredFilePart>
  for (const file of Object.values(files).sort((left, right) => left.path.localeCompare(right.path))) {
    for (const part of splitCodeGraphFile(file, options)) fileParts[filePartRecordKey(part)] = part
  }
  return splitRecordIntoBoundedJsonParts<CodeGraphStoredFilePart, CodeGraphShardData>({
    record: fileParts,
    label: options.label,
    targetPartBytes: options.targetPartBytes ?? CODEGRAPH_JSON_TARGET_PART_BYTES,
    hardPartBytes: options.hardPartBytes ?? CODEGRAPH_JSON_HARD_PART_BYTES,
    stringify: options.stringify,
    pathForPart: (_partIndex, partKey) => `${normalizeBasePath(options.basePath)}/${partKey}.json`,
    createPayload: (records, partKey) => ({
      version: CURRENT_CODE_GRAPH_INDEX_VERSION,
      key: options.shardKey,
      part: partKey,
      fileParts: Object.entries(records)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, part]) => part),
    }),
  })
}

export function mergeCodeGraphFileStorageParts(parts: CodeGraphShardData[]): Record<string, CodeGraphFile> {
  const builders = new Map<string, FileBuilder>()
  const wholeFiles = Object.create(null) as Record<string, CodeGraphFile>
  for (const payload of parts) {
    assertFileShardVersion(payload.version, payload.key, payload.part)
    for (const part of payload.fileParts) {
      if (part.kind === "whole") {
        wholeFiles[part.path] = part.file
        continue
      }
      const builder = getBuilder(builders, part.path)
      if (part.kind === "base") {
        builder.base = part.file
      } else {
        const chunks = builder.arrays.get(part.field) ?? []
        chunks.push({ offset: part.offset, items: part.items })
        builder.arrays.set(part.field, chunks)
      }
    }
  }
  const files: Record<string, CodeGraphFile> = { ...wholeFiles }
  for (const [path, builder] of [...builders.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!builder.base) throw new Error(`Missing stored code graph file base for ${path}.`)
    files[path] = buildFileFromParts(builder.base, builder.arrays)
  }
  return files
}

function splitCodeGraphFile(file: CodeGraphFile, options: SplitFilesOptions): CodeGraphStoredFilePart[] {
  if (!shouldSplitCodeGraphFile(file, options)) {
    return [{
      kind: "whole",
      path: file.path,
      file,
    }]
  }
  const parts: CodeGraphStoredFilePart[] = [{
    kind: "base",
    path: file.path,
    file: fileBase(file),
  }]
  for (const field of CODEGRAPH_FILE_ARRAY_FIELDS) {
    const values = fileArray(file, field)
    if (values.length === 0) continue
    let offset = 0
    const chunks = splitArrayValueIntoBoundedChunks({
      values,
      label: `${options.label} file ${file.path} ${field}`,
      targetPartBytes: options.targetPartBytes ?? CODEGRAPH_JSON_TARGET_PART_BYTES,
      hardPartBytes: options.hardPartBytes ?? CODEGRAPH_JSON_HARD_PART_BYTES,
      stringify: options.stringify,
      progressIntervalItems: 2048,
      onProgress: options.onProgress,
      createPayload: (items) => ({
        version: CURRENT_CODE_GRAPH_INDEX_VERSION,
        key: options.shardKey,
        part: "single-file-array",
        fileParts: [{
          kind: "array",
          path: file.path,
          field,
          offset,
          items,
        }],
      } satisfies CodeGraphShardData),
    })
    options.onLargeFileSplit?.({ path: file.path, field, items: values.length, chunks: chunks.length })
    for (const chunk of chunks) {
      parts.push({
        kind: "array",
        path: file.path,
        field,
        offset,
        items: chunk,
      })
      offset += chunk.length
    }
  }
  return parts
}

function shouldSplitCodeGraphFile(file: CodeGraphFile, options: SplitFilesOptions) {
  const hardPartBytes = options.hardPartBytes ?? CODEGRAPH_JSON_HARD_PART_BYTES
  if (file.size > LARGE_FILE_SIZE_BYTES) return true
  if (CODEGRAPH_FILE_ARRAY_FIELDS.reduce((count, field) => count + fileArray(file, field).length, 0) > LARGE_FILE_ARRAY_ITEMS) return true
  try {
    const bytes = estimateJsonBytes({
      version: CURRENT_CODE_GRAPH_INDEX_VERSION,
      key: options.shardKey,
      part: "single-file",
      fileParts: [{
        kind: "whole",
        path: file.path,
        file,
      }],
    } satisfies CodeGraphShardData, { label: `${options.label} file ${file.path}`, stringify: options.stringify })
    return bytes > Math.min(LARGE_FILE_RECORD_BYTES, Math.floor(hardPartBytes * 0.75))
  } catch {
    return true
  }
}

function fileBase(file: CodeGraphFile): CodeGraphStoredFileBase {
  const {
    includes: _includes,
    macros: _macros,
    functions: _functions,
    types: _types,
    globals: _globals,
    callSites: _callSites,
    initializers: _initializers,
    errorLabels: _errorLabels,
    registerMacroFamilies: _registerMacroFamilies,
    tokens: _tokens,
    astSummary,
    ...base
  } = file
  return {
    ...base,
    astSummary: astSummary ? {
      parser: astSummary.parser,
      language: astSummary.language,
      functions: astSummary.functions,
      calls: astSummary.calls,
      ifStatements: astSummary.ifStatements,
      switchStatements: astSummary.switchStatements,
      caseStatements: astSummary.caseStatements,
      assignments: astSummary.assignments,
      errors: astSummary.errors,
    } : undefined,
    optionalArrayFields: CODEGRAPH_FILE_ARRAY_FIELDS.filter((field) => optionalFileArrayExists(file, field)),
  }
}

function fileArray(file: CodeGraphFile, field: CodeGraphStoredFileArrayField): unknown[] {
  switch (field) {
    case "includes":
      return file.includes
    case "macros":
      return file.macros
    case "functions":
      return file.functions
    case "types":
      return file.types
    case "globals":
      return file.globals
    case "callSites":
      return file.callSites ?? []
    case "initializers":
      return file.initializers ?? []
    case "errorLabels":
      return file.errorLabels ?? []
    case "registerMacroFamilies":
      return file.registerMacroFamilies ?? []
    case "tokens":
      return file.tokens
    case "astSummary.controls":
      return file.astSummary?.controls ?? []
  }
}

function buildFileFromParts(
  base: CodeGraphStoredFileBase,
  arrays: Map<CodeGraphStoredFileArrayField, Array<{ offset: number; items: unknown[] }>>,
): CodeGraphFile {
  const { astSummary, optionalArrayFields: optionalFields = [], ...fileBase } = base
  const optionalFieldSet = new Set(optionalFields)
  const file: CodeGraphFile = {
    ...fileBase,
    includes: arrayItems<CodeGraphInclude>(arrays, "includes"),
    macros: arrayItems<CodeGraphMacro>(arrays, "macros"),
    functions: arrayItems<CodeGraphFunction>(arrays, "functions"),
    types: arrayItems<CodeGraphTypeSymbol>(arrays, "types"),
    globals: arrayItems<CodeGraphGlobalSymbol>(arrays, "globals"),
    callSites: optionalArrayItems<CodeGraphCallSite>(arrays, "callSites", optionalFieldSet),
    initializers: optionalArrayItems<CodeGraphInitializerExample>(arrays, "initializers", optionalFieldSet),
    errorLabels: optionalArrayItems<CodeGraphErrorLabel>(arrays, "errorLabels", optionalFieldSet),
    registerMacroFamilies: optionalArrayItems<CodeGraphRegisterMacroFamily>(arrays, "registerMacroFamilies", optionalFieldSet),
    tokens: arrayItems<CodeGraphFileToken>(arrays, "tokens"),
  }
  if (astSummary) file.astSummary = {
    ...astSummary,
    controls: arrayItems<CodeGraphAstControl>(arrays, "astSummary.controls"),
  }
  return file
}

function arrayItems<T>(arrays: Map<CodeGraphStoredFileArrayField, Array<{ offset: number; items: unknown[] }>>, field: CodeGraphStoredFileArrayField): T[] {
  return (arrays.get(field) ?? [])
    .sort((left, right) => left.offset - right.offset)
    .flatMap((chunk) => chunk.items) as T[]
}

function optionalArrayItems<T>(
  arrays: Map<CodeGraphStoredFileArrayField, Array<{ offset: number; items: unknown[] }>>,
  field: CodeGraphStoredFileArrayField,
  optionalFieldSet: Set<CodeGraphStoredFileArrayField>,
): T[] | undefined {
  const items = arrayItems<T>(arrays, field)
  return items.length > 0 || optionalFieldSet.has(field) ? items : undefined
}

function optionalFileArrayExists(file: CodeGraphFile, field: CodeGraphStoredFileArrayField) {
  switch (field) {
    case "callSites":
      return file.callSites !== undefined
    case "initializers":
      return file.initializers !== undefined
    case "errorLabels":
      return file.errorLabels !== undefined
    case "registerMacroFamilies":
      return file.registerMacroFamilies !== undefined
    default:
      return false
  }
}

function getBuilder(builders: Map<string, FileBuilder>, path: string) {
  const existing = builders.get(path)
  if (existing) return existing
  const builder: FileBuilder = { arrays: new Map() }
  builders.set(path, builder)
  return builder
}

function filePartRecordKey(part: CodeGraphStoredFilePart) {
  if (part.kind === "whole") return `${part.path}\0whole`
  if (part.kind === "base") return `${part.path}\0base`
  return `${part.path}\0${part.field}\0${part.offset.toString(36).padStart(8, "0")}`
}

function assertFileShardVersion(version: number, key: string, part: string) {
  if (version !== CURRENT_CODE_GRAPH_INDEX_VERSION) {
    throw new Error(`Code graph shard ${key} part ${part} does not match the current storage version.`)
  }
}

function normalizeBasePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "shards"
}

type FileBuilder = {
  base?: CodeGraphStoredFileBase
  arrays: Map<CodeGraphStoredFileArrayField, Array<{ offset: number; items: unknown[] }>>
}
