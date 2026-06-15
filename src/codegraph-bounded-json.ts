export const CODEGRAPH_JSON_TARGET_PART_BYTES = 32 * 1024 * 1024
export const CODEGRAPH_JSON_HARD_PART_BYTES = 64 * 1024 * 1024

type JsonStringify = (value: unknown) => string | undefined

export type BoundedJsonOptions = {
  label: string
  part?: string
  hardPartBytes?: number
  stringify?: JsonStringify
}

export type BoundedJsonPart<TPayload> = {
  key: string
  path: string
  entries: number
  estimatedBytes: number
  payload: TPayload
}

export type SplitRecordIntoBoundedJsonPartsOptions<TValue, TPayload> = {
  record: Record<string, TValue>
  label: string
  createPayload: (records: Record<string, TValue>, partKey: string) => TPayload
  pathForPart: (partIndex: number, partKey: string) => string
  targetPartBytes?: number
  hardPartBytes?: number
  stringify?: JsonStringify
}

export type SplitArrayRecordIntoBoundedJsonPartsOptions<TValue, TPayload> = {
  record: Record<string, TValue[]>
  label: string
  createPayload: (records: Record<string, TValue[]>, partKey: string) => TPayload
  pathForPart: (partIndex: number, partKey: string) => string
  targetPartBytes?: number
  hardPartBytes?: number
  stringify?: JsonStringify
}

const encoder = new TextEncoder()

export function encodeBoundedJson(value: unknown, options: BoundedJsonOptions): Uint8Array {
  return encoder.encode(stringifyBoundedJson(value, options))
}

export function stringifyBoundedJson(value: unknown, options: BoundedJsonOptions): string {
  const hardPartBytes = normalizeHardPartBytes(options.hardPartBytes)
  const json = stringifyForDiagnostic(value, options)
  const bytes = jsonByteLength(json)
  if (bytes > hardPartBytes) {
    throw new Error(`${storagePartLabel(options)} is ${bytes} bytes, above hard JSON part limit ${hardPartBytes}.`)
  }
  return json
}

export function splitRecordIntoBoundedJsonParts<TValue, TPayload>(
  options: SplitRecordIntoBoundedJsonPartsOptions<TValue, TPayload>,
): BoundedJsonPart<TPayload>[] {
  const hardPartBytes = normalizeHardPartBytes(options.hardPartBytes)
  const targetPartBytes = normalizeTargetPartBytes(options.targetPartBytes, hardPartBytes)
  const entries = Object.entries(options.record).sort(([left], [right]) => left.localeCompare(right))
  const parts: BoundedJsonPart<TPayload>[] = []
  let partIndex = 0
  let current = createPartState(options, partIndex)

  const flush = () => {
    if (current.entries === 0) return
    const payload = options.createPayload(current.records, current.key)
    const json = stringifyBoundedJson(payload, {
      label: options.label,
      part: current.key,
      hardPartBytes,
      stringify: options.stringify,
    })
    const estimatedBytes = jsonByteLength(json)
    parts.push({
      key: current.key,
      path: options.pathForPart(partIndex, current.key),
      entries: current.entries,
      estimatedBytes,
      payload,
    })
    partIndex += 1
    current = createPartState(options, partIndex)
  }

  for (const [key, value] of entries) {
    const singleRecord = Object.create(null) as Record<string, TValue>
    singleRecord[key] = value
    const singlePayload = options.createPayload(singleRecord, current.key)
    const singleBytes = jsonByteLength(stringifyBoundedJson(singlePayload, {
      label: `${options.label} record ${key}`,
      part: current.key,
      hardPartBytes,
      stringify: options.stringify,
    }))
    const incrementalBytes = Math.max(1, singleBytes - current.emptyBytes + 1)
    if (current.entries > 0 && current.estimatedBytes + incrementalBytes > targetPartBytes) flush()
    current.records[key] = value
    current.entries += 1
    current.estimatedBytes += incrementalBytes
    if (current.estimatedBytes >= hardPartBytes) flush()
  }

  flush()
  return parts
}

export function splitArrayRecordIntoBoundedJsonParts<TValue, TPayload>(
  options: SplitArrayRecordIntoBoundedJsonPartsOptions<TValue, TPayload>,
): BoundedJsonPart<TPayload>[] {
  const hardPartBytes = normalizeHardPartBytes(options.hardPartBytes)
  const targetPartBytes = normalizeTargetPartBytes(options.targetPartBytes, hardPartBytes)
  const entries = Object.entries(options.record).sort(([left], [right]) => left.localeCompare(right))
  const parts: BoundedJsonPart<TPayload>[] = []
  let partIndex = 0
  let current = createPartState(options, partIndex)

  const flush = () => {
    if (current.entries === 0) return
    const payload = options.createPayload(current.records, current.key)
    const json = stringifyBoundedJson(payload, {
      label: options.label,
      part: current.key,
      hardPartBytes,
      stringify: options.stringify,
    })
    const estimatedBytes = jsonByteLength(json)
    parts.push({
      key: current.key,
      path: options.pathForPart(partIndex, current.key),
      entries: current.entries,
      estimatedBytes,
      payload,
    })
    partIndex += 1
    current = createPartState(options, partIndex)
  }

  for (const [key, values] of entries) {
    if (!Array.isArray(values) || values.length === 0) continue
    const chunks = splitArrayValueIntoBoundedChunks({
      values,
      label: `${options.label} record ${key}`,
      hardPartBytes,
      createPayload: (items) => {
        const records = Object.create(null) as Record<string, TValue[]>
        records[key] = items
        return options.createPayload(records, current.key)
      },
      stringify: options.stringify,
    })
    for (const chunk of chunks) {
      if (current.records[key]) flush()
      const records = Object.create(null) as Record<string, TValue[]>
      records[key] = chunk
      const singlePayload = options.createPayload(records, current.key)
      const singleBytes = jsonByteLength(stringifyBoundedJson(singlePayload, {
        label: `${options.label} record ${key}`,
        part: current.key,
        hardPartBytes,
        stringify: options.stringify,
      }))
      const incrementalBytes = Math.max(1, singleBytes - current.emptyBytes + 1)
      if (current.entries > 0 && current.estimatedBytes + incrementalBytes > targetPartBytes) flush()
      current.records[key] = chunk
      current.entries += chunk.length
      current.estimatedBytes += incrementalBytes
      if (current.estimatedBytes >= hardPartBytes) flush()
    }
  }

  flush()
  return parts
}

export function splitArrayValueIntoBoundedChunks<TValue, TPayload>(options: {
  values: TValue[]
  label: string
  createPayload: (values: TValue[]) => TPayload
  targetPartBytes?: number
  hardPartBytes?: number
  stringify?: JsonStringify
}): TValue[][] {
  const hardPartBytes = normalizeHardPartBytes(options.hardPartBytes)
  const targetPartBytes = normalizeTargetPartBytes(options.targetPartBytes, hardPartBytes)
  const chunks: TValue[][] = []
  let current: TValue[] = []

  const flush = () => {
    if (current.length === 0) return
    chunks.push(current)
    current = []
  }

  for (let index = 0; index < options.values.length; index += 1) {
    const item = options.values[index]
    stringifyBoundedJson(options.createPayload([item]), {
      label: `${options.label} item ${index}`,
      hardPartBytes,
      stringify: options.stringify,
    })
    const next = [...current, item]
    const nextBytes = jsonByteLength(stringifyBoundedJson(options.createPayload(next), {
      label: options.label,
      hardPartBytes,
      stringify: options.stringify,
    }))
    if (current.length > 0 && nextBytes > targetPartBytes) {
      flush()
      current.push(item)
      continue
    }
    current = next
    if (nextBytes >= hardPartBytes) flush()
  }

  flush()
  return chunks
}

export function codeGraphPartName(part: number) {
  return Math.max(0, part).toString(36).padStart(4, "0")
}

function createPartState<TValue, TPayload>(
  options: SplitRecordIntoBoundedJsonPartsOptions<TValue, TPayload>,
  partIndex: number,
) {
  const key = codeGraphPartName(partIndex)
  const records = Object.create(null) as Record<string, TValue>
  const emptyPayload = options.createPayload(records, key)
  const emptyBytes = jsonByteLength(stringifyBoundedJson(emptyPayload, {
    label: options.label,
    part: key,
    hardPartBytes: options.hardPartBytes,
    stringify: options.stringify,
  }))
  return {
    key,
    records,
    emptyBytes,
    estimatedBytes: emptyBytes,
    entries: 0,
  }
}

function stringifyForDiagnostic(value: unknown, options: BoundedJsonOptions): string {
  try {
    const json = (options.stringify ?? JSON.stringify)(value)
    if (typeof json !== "string") throw new TypeError("JSON.stringify returned undefined")
    return json
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to serialize ${storagePartLabel(options)}: ${message}`)
  }
}

function storagePartLabel(options: BoundedJsonOptions) {
  return options.part ? `${options.label} part ${options.part}` : options.label
}

function jsonByteLength(json: string) {
  return encoder.encode(json).byteLength
}

function normalizeHardPartBytes(value: number | undefined) {
  const normalized = Math.floor(value ?? CODEGRAPH_JSON_HARD_PART_BYTES)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : CODEGRAPH_JSON_HARD_PART_BYTES
}

function normalizeTargetPartBytes(value: number | undefined, hardPartBytes: number) {
  const normalized = Math.floor(value ?? CODEGRAPH_JSON_TARGET_PART_BYTES)
  if (!Number.isFinite(normalized) || normalized <= 0) return Math.min(CODEGRAPH_JSON_TARGET_PART_BYTES, hardPartBytes)
  return Math.min(normalized, hardPartBytes)
}
