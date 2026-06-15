import {
  CODEGRAPH_JSON_HARD_PART_BYTES,
  CODEGRAPH_JSON_TARGET_PART_BYTES,
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

type SplitFilesOptions = {
  shardKey: string
  basePath: string
  label: string
  targetPartBytes?: number
  hardPartBytes?: number
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
  for (const payload of parts) {
    assertFileShardVersion(payload.version, payload.key, payload.part)
    for (const part of payload.fileParts) {
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
  const files: Record<string, CodeGraphFile> = Object.create(null) as Record<string, CodeGraphFile>
  for (const [path, builder] of [...builders.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!builder.base) throw new Error(`Missing stored code graph file base for ${path}.`)
    files[path] = buildFileFromParts(builder.base, builder.arrays)
  }
  return files
}

function splitCodeGraphFile(file: CodeGraphFile, options: SplitFilesOptions): CodeGraphStoredFilePart[] {
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
