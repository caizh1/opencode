import { createHash } from "node:crypto"

export type ChipMateCatalogPackageType = "skill" | "mcp"

export type ChipMateCatalogDependency = {
  id: string
  type: ChipMateCatalogPackageType
  version?: string
  required?: boolean
}

export type ChipMateCatalogPackage = {
  id: string
  type: ChipMateCatalogPackageType
  name: string
  version: string
  description: string
  downloadUrl: string
  sha256: string
  sizeBytes?: number
  permissions?: Record<string, unknown>
  dependencies: ChipMateCatalogDependency[]
}

export type ChipMateCatalog = {
  schemaVersion: 1
  updatedAt?: string
  packages: ChipMateCatalogPackage[]
}

export class ChipMateCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChipMateCatalogError"
  }
}

export async function fetchChipMateCatalog(catalogUrl: string, signal?: AbortSignal): Promise<ChipMateCatalog> {
  const response = await fetch(catalogUrl, { method: "GET", signal })
  const text = await response.text()
  if (!response.ok) throw new ChipMateCatalogError(`Catalog request failed: ${response.status} ${response.statusText}: ${truncate(text, 400)}`)
  try {
    return parseChipMateCatalog(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof ChipMateCatalogError) throw error
    throw new ChipMateCatalogError("Catalog response is not valid JSON.")
  }
}

export async function downloadChipMateCatalogPackage(input: {
  catalogUrl: string
  pkg: ChipMateCatalogPackage
  signal?: AbortSignal
}): Promise<Uint8Array> {
  const url = resolveCatalogDownloadUrl(input.catalogUrl, input.pkg.downloadUrl)
  const response = await fetch(url, { method: "GET", signal: input.signal })
  const body = new Uint8Array(await response.arrayBuffer())
  if (!response.ok) throw new ChipMateCatalogError(`Package download failed: ${response.status} ${response.statusText}.`)
  if (input.pkg.sizeBytes !== undefined && body.byteLength !== input.pkg.sizeBytes) {
    throw new ChipMateCatalogError(`Package size mismatch for ${input.pkg.id}: expected ${input.pkg.sizeBytes}, got ${body.byteLength}.`)
  }
  const actual = sha256Hex(body)
  if (actual !== input.pkg.sha256.toLowerCase()) {
    throw new ChipMateCatalogError(`Package sha256 mismatch for ${input.pkg.id}: expected ${input.pkg.sha256}, got ${actual}.`)
  }
  return body
}

export function parseChipMateCatalog(input: unknown): ChipMateCatalog {
  const root = objectRecord(input)
  const schemaVersion = Number(root.schemaVersion)
  if (schemaVersion !== 1) throw new ChipMateCatalogError("Catalog schemaVersion must be 1.")
  const packagesValue = root.packages
  if (!Array.isArray(packagesValue)) throw new ChipMateCatalogError("Catalog packages must be an array.")
  const packages = packagesValue.map(parsePackage)
  const duplicate = firstDuplicate(packages.map((pkg) => `${pkg.type}:${pkg.id}:${pkg.version}`))
  if (duplicate) throw new ChipMateCatalogError(`Catalog has duplicate package entry: ${duplicate}.`)
  return {
    schemaVersion: 1,
    updatedAt: stringValue(root.updatedAt) || undefined,
    packages,
  }
}

export function resolveCatalogDownloadUrl(catalogUrl: string, downloadUrl: string) {
  return new URL(downloadUrl, catalogUrl).toString()
}

export function sha256Hex(input: Uint8Array) {
  return createHash("sha256").update(input).digest("hex")
}

export function isSafePackageRelativePath(input: string) {
  const normalized = input.replace(/\\/g, "/")
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return false
  return !normalized.split("/").some((part) => part === "..")
}

function parsePackage(input: unknown): ChipMateCatalogPackage {
  const root = objectRecord(input)
  const id = requiredString(root.id, "package id")
  const type = packageType(root.type)
  const name = requiredString(root.name, `${id} name`)
  const version = requiredString(root.version, `${id} version`)
  const description = requiredString(root.description, `${id} description`)
  const downloadUrl = requiredString(root.downloadUrl, `${id} downloadUrl`)
  const sha256 = requiredString(root.sha256, `${id} sha256`).toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new ChipMateCatalogError(`${id} sha256 must be a 64-character hex digest.`)
  const dependencies = Array.isArray(root.dependencies) ? root.dependencies.map(parseDependency) : []
  return {
    id,
    type,
    name,
    version,
    description,
    downloadUrl,
    sha256,
    sizeBytes: numberValue(root.sizeBytes),
    permissions: objectRecordOrUndefined(root.permissions),
    dependencies,
  }
}

function parseDependency(input: unknown): ChipMateCatalogDependency {
  const root = objectRecord(input)
  return {
    id: requiredString(root.id, "dependency id"),
    type: packageType(root.type),
    version: stringValue(root.version) || undefined,
    required: Boolean(root.required),
  }
}

function packageType(input: unknown): ChipMateCatalogPackageType {
  if (input === "skill" || input === "mcp") return input
  throw new ChipMateCatalogError("Package type must be skill or mcp.")
}

function requiredString(input: unknown, label: string) {
  const value = stringValue(input).trim()
  if (!value) throw new ChipMateCatalogError(`${label} is required.`)
  return value
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
}

function objectRecordOrUndefined(input: unknown): Record<string, unknown> | undefined {
  const value = objectRecord(input)
  return Object.keys(value).length > 0 ? value : undefined
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined
}

function firstDuplicate(values: string[]) {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return ""
}

function truncate(input: string, max: number) {
  if (input.length <= max) return input
  return `${input.slice(0, max)}...`
}
