import {
  CODEGRAPH_JSON_HARD_PART_BYTES,
  CODEGRAPH_JSON_TARGET_PART_BYTES,
  splitArrayRecordIntoBoundedJsonParts,
  splitRecordIntoBoundedJsonParts,
  type BoundedJsonPart,
} from "./codegraph-bounded-json"
import { CURRENT_CODE_GRAPH_INDEX_VERSION } from "./codegraph-index"
import type {
  CodeGraphDerivedIndex,
  CodeGraphDerivedSidecarField,
  CodeGraphDerivedSidecarManifest,
  CodeGraphDerivedSidecarShard,
  CodeGraphDirectoryStats,
  CodeGraphModuleStats,
  CodeGraphPosting,
  CodeGraphSymbol,
} from "./codegraph-types"

export const CODEGRAPH_DERIVED_SIDECAR_FIELDS: CodeGraphDerivedSidecarField[] = [
  "functionIdsByName",
  "callerIdsByCallee",
  "includeTargetsByFile",
  "filePathsByInclude",
  "directoryStats",
  "symbolsByName",
  "symbolsByPath",
  "postingsByTerm",
  "moduleStats",
]

export type CodeGraphDerivedSidecarPartData = {
  version: typeof CURRENT_CODE_GRAPH_INDEX_VERSION
  field: CodeGraphDerivedSidecarField
  key: string
  records: Record<string, unknown>
}

export type CodeGraphDerivedSidecarData = {
  manifest: CodeGraphDerivedSidecarManifest
  parts: BoundedJsonPart<CodeGraphDerivedSidecarPartData>[]
}

type SplitOptions = {
  basePath?: string
  targetPartBytes?: number
  hardPartBytes?: number
}

export function splitCodeGraphDerivedIndex(
  derived: CodeGraphDerivedIndex,
  options: SplitOptions = {},
): CodeGraphDerivedSidecarData {
  const basePath = normalizeBasePath(options.basePath ?? "derived")
  const fields = emptySidecarFieldManifest()
  const parts: BoundedJsonPart<CodeGraphDerivedSidecarPartData>[] = []

  for (const field of CODEGRAPH_DERIVED_SIDECAR_FIELDS) {
    const fieldParts = splitDerivedField(field, derived[field] as Record<string, unknown>, basePath, options)
    fields[field] = fieldParts.map(sidecarShard)
    parts.push(...fieldParts)
  }

  return {
    manifest: {
      version: CURRENT_CODE_GRAPH_INDEX_VERSION,
      fields,
    },
    parts,
  }
}

export function mergeCodeGraphDerivedSidecar(input: CodeGraphDerivedSidecarData): CodeGraphDerivedIndex {
  assertSidecarVersion(input.manifest.version, "derived manifest")
  const expectedParts = expectedSidecarPartCounts(input.manifest)
  const derived = emptyDerivedIndex()
  const knownFields = new Set<string>(CODEGRAPH_DERIVED_SIDECAR_FIELDS)

  for (const part of input.parts) {
    assertSidecarVersion(part.payload.version, `derived ${part.payload.field} part ${part.payload.key}`)
    if (!knownFields.has(part.payload.field)) {
      throw new Error(`Unsupported derived sidecar field ${part.payload.field}. Rebuild the local code graph index.`)
    }
    const expectedKey = sidecarPartCountKey(part.payload.field, part.payload.key)
    const remaining = expectedParts.get(expectedKey) ?? 0
    if (remaining <= 0) {
      throw new Error(`Unexpected derived sidecar part ${part.payload.field}/${part.payload.key}. Rebuild the local code graph index.`)
    }
    expectedParts.set(expectedKey, remaining - 1)
    mergeFieldRecords(derived, part.payload.field, part.payload.records)
  }

  for (const [key, remaining] of expectedParts) {
    if (remaining > 0) throw new Error(`Missing derived sidecar part ${key}. Rebuild the local code graph index.`)
  }

  return sortDerivedIndex(derived)
}

function splitDerivedField(
  field: CodeGraphDerivedSidecarField,
  record: Record<string, unknown>,
  basePath: string,
  options: SplitOptions,
) {
  if (derivedFieldContainsArrays(field)) {
    return splitArrayRecordIntoBoundedJsonParts<unknown, CodeGraphDerivedSidecarPartData>({
      record: record as Record<string, unknown[]>,
      label: `derived ${field}`,
      targetPartBytes: options.targetPartBytes ?? CODEGRAPH_JSON_TARGET_PART_BYTES,
      hardPartBytes: options.hardPartBytes ?? CODEGRAPH_JSON_HARD_PART_BYTES,
      pathForPart: (_partIndex, partKey) => `${basePath}/${field}/${partKey}.json`,
      createPayload: (records, partKey) => ({
        version: CURRENT_CODE_GRAPH_INDEX_VERSION,
        field,
        key: partKey,
        records,
      }),
    })
  }
  return splitRecordIntoBoundedJsonParts<unknown, CodeGraphDerivedSidecarPartData>({
    record,
    label: `derived ${field}`,
    targetPartBytes: options.targetPartBytes ?? CODEGRAPH_JSON_TARGET_PART_BYTES,
    hardPartBytes: options.hardPartBytes ?? CODEGRAPH_JSON_HARD_PART_BYTES,
    pathForPart: (_partIndex, partKey) => `${basePath}/${field}/${partKey}.json`,
    createPayload: (records, partKey) => ({
      version: CURRENT_CODE_GRAPH_INDEX_VERSION,
      field,
      key: partKey,
      records,
    }),
  })
}

function derivedFieldContainsArrays(field: CodeGraphDerivedSidecarField) {
  return field !== "directoryStats" && field !== "moduleStats"
}

function sidecarShard(part: BoundedJsonPart<CodeGraphDerivedSidecarPartData>): CodeGraphDerivedSidecarShard {
  return {
    key: part.key,
    path: part.path,
    entries: part.entries,
    estimatedBytes: part.estimatedBytes,
  }
}

function assertSidecarVersion(version: number, label: string) {
  if (version !== CURRENT_CODE_GRAPH_INDEX_VERSION) {
    throw new Error(`Unsupported ${label} version ${version}. Rebuild the local code graph index.`)
  }
}

function expectedSidecarPartCounts(manifest: CodeGraphDerivedSidecarManifest) {
  const counts = new Map<string, number>()
  for (const field of CODEGRAPH_DERIVED_SIDECAR_FIELDS) {
    for (const part of manifest.fields[field] ?? []) {
      const key = sidecarPartCountKey(field, part.key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function sidecarPartCountKey(field: CodeGraphDerivedSidecarField, key: string) {
  return `${field}/${key}`
}

function mergeFieldRecords(
  derived: CodeGraphDerivedIndex,
  field: CodeGraphDerivedSidecarField,
  records: Record<string, unknown>,
) {
  const target = derived[field] as Record<string, unknown>
  for (const [key, value] of Object.entries(records).sort(([left], [right]) => left.localeCompare(right))) {
    const existing = target[key]
    if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value]
    } else {
      target[key] = value
    }
  }
}

function emptyDerivedIndex(): CodeGraphDerivedIndex {
  return {
    functionIdsByName: emptyRecord<string[]>(),
    callerIdsByCallee: emptyRecord<string[]>(),
    includeTargetsByFile: emptyRecord<string[]>(),
    filePathsByInclude: emptyRecord<string[]>(),
    directoryStats: emptyRecord<CodeGraphDirectoryStats>(),
    symbolsByName: emptyRecord<CodeGraphSymbol[]>(),
    symbolsByPath: emptyRecord<CodeGraphSymbol[]>(),
    postingsByTerm: emptyRecord<CodeGraphPosting[]>(),
    moduleStats: emptyRecord<CodeGraphModuleStats>(),
  }
}

function sortDerivedIndex(derived: CodeGraphDerivedIndex): CodeGraphDerivedIndex {
  return {
    functionIdsByName: sortedArrayRecord(derived.functionIdsByName),
    callerIdsByCallee: sortedArrayRecord(derived.callerIdsByCallee),
    includeTargetsByFile: sortedArrayRecord(derived.includeTargetsByFile),
    filePathsByInclude: sortedArrayRecord(derived.filePathsByInclude),
    directoryStats: sortedRecord(derived.directoryStats),
    symbolsByName: sortedArrayRecord(derived.symbolsByName),
    symbolsByPath: sortedArrayRecord(derived.symbolsByPath),
    postingsByTerm: sortedArrayRecord(derived.postingsByTerm),
    moduleStats: sortedRecord(derived.moduleStats),
  }
}

function emptySidecarFieldManifest() {
  const fields = Object.create(null) as CodeGraphDerivedSidecarManifest["fields"]
  for (const field of CODEGRAPH_DERIVED_SIDECAR_FIELDS) fields[field] = []
  return fields
}

function normalizeBasePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "derived"
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function sortedRecord<T>(record: Record<string, T>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) as Record<string, T>
}

function sortedArrayRecord<T>(record: Record<string, T[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values]]),
  ) as Record<string, T[]>
}
