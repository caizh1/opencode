import { promises as fs } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { inflateRawSync } from "node:zlib"
import type { InstalledSkill } from "./skills-runtime"
import type { ChipMateCatalogPackage, ChipMateCatalogPackageType } from "./skills-catalog"
import { isSafePackageRelativePath } from "./skills-catalog"

export type InstalledChipMatePackageManifest = {
  schemaVersion: 1
  id: string
  type: ChipMateCatalogPackageType
  name: string
  version: string
  description: string
  installedAt: string
  sourceCatalogUrl: string
  dependencies?: ChipMateCatalogPackage["dependencies"]
}

export type InstalledChipMatePackage = InstalledChipMatePackageManifest & {
  root: string
}

export type ChipMatePackageInstallResult = {
  installed: InstalledChipMatePackage
  previousVersion?: string
}

const PACKAGE_MANIFEST = ".chipmate-package.json"
const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP_STORED = 0
const ZIP_DEFLATED = 8
const ZIP_FLAG_ENCRYPTED = 0x0001
const ZIP_FLAG_UTF8_NAME = 0x0800
const ZIP64_UINT16 = 0xffff
const ZIP64_UINT32 = 0xffffffff

type ZipEntry = {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
}

export class ChipMatePackageInstallerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChipMatePackageInstallerError"
  }
}

export class ChipMatePackageInstaller {
  constructor(private readonly root: string) {}

  async listInstalled(type?: ChipMateCatalogPackageType): Promise<InstalledChipMatePackage[]> {
    const types: ChipMateCatalogPackageType[] = type ? [type] : ["skill", "mcp"]
    const groups = await Promise.all(types.map((item) => this.listInstalledType(item)))
    return groups.flat().sort((left, right) => left.name.localeCompare(right.name))
  }

  async installedSkills(): Promise<InstalledSkill[]> {
    return (await this.listInstalled("skill")).map((item) => ({
      id: item.id,
      root: item.root,
      version: item.version,
      enabled: true,
    }))
  }

  async installZip(input: {
    catalogUrl: string
    pkg: ChipMateCatalogPackage
    bytes: Uint8Array
    now?: Date
  }): Promise<ChipMatePackageInstallResult> {
    await fs.mkdir(this.tempRoot(), { recursive: true })
    const temp = await fs.mkdtemp(join(this.tempRoot(), `${input.pkg.type}-${input.pkg.id}-`))
    try {
      await extractZip(input.bytes, temp)
      const contentRoot = await packageContentRoot(temp, input.pkg)
      const target = this.packageRoot(input.pkg.type, input.pkg.id)
      const previous = await readInstalledManifest(target)
      await this.backupCurrent(target, input.pkg.type, input.pkg.id)
      await fs.rm(target, { recursive: true, force: true })
      await fs.mkdir(dirname(target), { recursive: true })
      await copyDirectory(contentRoot, target)
      const manifest: InstalledChipMatePackageManifest = {
        schemaVersion: 1,
        id: input.pkg.id,
        type: input.pkg.type,
        name: input.pkg.name,
        version: input.pkg.version,
        description: input.pkg.description,
        installedAt: (input.now ?? new Date()).toISOString(),
        sourceCatalogUrl: input.catalogUrl,
        dependencies: input.pkg.dependencies.length ? input.pkg.dependencies : undefined,
      }
      await fs.writeFile(join(target, PACKAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
      return {
        installed: { ...manifest, root: target },
        previousVersion: previous?.version,
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }
  }

  async rollback(input: {
    type: ChipMateCatalogPackageType
    id: string
  }): Promise<InstalledChipMatePackage> {
    const backupDir = this.backupRoot(input.type, input.id)
    const entries = await fs.readdir(backupDir, { withFileTypes: true }).catch(() => [])
    const latest = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1)
    if (!latest) throw new ChipMatePackageInstallerError(`No rollback package is available for ${input.type}:${input.id}.`)
    const source = join(backupDir, latest)
    const target = this.packageRoot(input.type, input.id)
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(dirname(target), { recursive: true })
    await copyDirectory(source, target)
    await fs.rm(source, { recursive: true, force: true })
    const manifest = await readInstalledManifest(target)
    if (!manifest) throw new ChipMatePackageInstallerError(`Rollback package is missing ${PACKAGE_MANIFEST}.`)
    return { ...manifest, root: target }
  }

  packageRoot(type: ChipMateCatalogPackageType, id: string) {
    return join(this.root, packageTypeDirectory(type), safePackageId(id))
  }

  private async listInstalledType(type: ChipMateCatalogPackageType) {
    const dir = join(this.root, packageTypeDirectory(type))
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const installed: InstalledChipMatePackage[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const root = join(dir, entry.name)
      const manifest = await readInstalledManifest(root)
      if (!manifest || manifest.type !== type) continue
      installed.push({ ...manifest, root })
    }
    return installed
  }

  private async backupCurrent(target: string, type: ChipMateCatalogPackageType, id: string) {
    const manifest = await readInstalledManifest(target)
    if (!manifest) return
    const backup = join(this.backupRoot(type, id), `${Date.now()}-${safePackageId(manifest.version)}`)
    await fs.mkdir(dirname(backup), { recursive: true })
    await copyDirectory(target, backup)
  }

  private backupRoot(type: ChipMateCatalogPackageType, id: string) {
    return join(this.root, "backups", packageTypeDirectory(type), safePackageId(id))
  }

  private tempRoot() {
    return join(this.root, ".tmp")
  }
}

async function extractZip(bytes: Uint8Array, target: string) {
  await fs.mkdir(target, { recursive: true })

  const archive = Buffer.from(bytes)
  for (const entry of readZipEntries(archive)) {
    if (!isSafePackageRelativePath(entry.name)) {
      throw new ChipMatePackageInstallerError(`Package archive contains an unsafe path: ${entry.name}`)
    }
    const normalized = entry.name.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!normalized || entry.isDirectory) continue
    if (!isSafePackageRelativePath(normalized)) {
      throw new ChipMatePackageInstallerError(`Package archive contains an unsafe path: ${normalized}`)
    }
    const output = resolve(target, normalized)
    if (!isPathInside(output, target)) {
      throw new ChipMatePackageInstallerError(`Package archive path escapes the install root: ${entry.name}`)
    }
    await fs.mkdir(dirname(output), { recursive: true })
    await fs.writeFile(output, extractZipEntry(archive, entry))
  }
}

function readZipEntries(archive: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(archive)
  const diskNumber = archive.readUInt16LE(endOffset + 4)
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6)
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8)
  const totalEntries = archive.readUInt16LE(endOffset + 10)
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12)
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16)

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ChipMatePackageInstallerError("Package archive uses multi-disk zip, which is not supported.")
  }
  if (totalEntries === ZIP64_UINT16 || centralDirectorySize === ZIP64_UINT32 || centralDirectoryOffset === ZIP64_UINT32) {
    throw new ChipMatePackageInstallerError("Package archive uses Zip64, which is not supported.")
  }
  if (centralDirectoryOffset + centralDirectorySize > archive.length) {
    throw new ChipMatePackageInstallerError("Package archive has an invalid central directory.")
  }

  const entries: ZipEntry[] = []
  let cursor = centralDirectoryOffset
  for (let index = 0; index < totalEntries; index += 1) {
    ensureReadable(archive, cursor, 46, "central directory entry")
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new ChipMatePackageInstallerError("Package archive has an invalid central directory entry.")
    }

    const flags = archive.readUInt16LE(cursor + 8)
    const compressionMethod = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const diskStart = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localHeaderOffset = archive.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    ensureReadable(archive, cursor + 46, nameLength, "central directory file name")

    if (flags & ZIP_FLAG_ENCRYPTED) throw new ChipMatePackageInstallerError("Package archive contains encrypted entries, which are not supported.")
    if (diskStart !== 0) throw new ChipMatePackageInstallerError("Package archive uses multi-disk entries, which are not supported.")
    if (compressedSize === ZIP64_UINT32 || uncompressedSize === ZIP64_UINT32 || localHeaderOffset === ZIP64_UINT32) {
      throw new ChipMatePackageInstallerError("Package archive uses Zip64 entries, which are not supported.")
    }
    if (compressionMethod !== ZIP_STORED && compressionMethod !== ZIP_DEFLATED) {
      throw new ChipMatePackageInstallerError(`Package archive uses unsupported compression method ${compressionMethod}.`)
    }

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decodeZipName(nameBytes, flags)
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/") || ((externalAttributes >>> 16) & 0o170000) === 0o040000,
    })
    cursor = next
  }

  return entries
}

function extractZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
  ensureReadable(archive, entry.localHeaderOffset, 30, "local file header")
  if (archive.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new ChipMatePackageInstallerError(`Package archive has an invalid local file header for ${entry.name}.`)
  }

  const nameLength = archive.readUInt16LE(entry.localHeaderOffset + 26)
  const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28)
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  ensureReadable(archive, dataStart, entry.compressedSize, `zip entry ${entry.name}`)

  const compressed = archive.subarray(dataStart, dataEnd)
  const data = entry.compressionMethod === ZIP_DEFLATED ? inflateRawSync(compressed) : Buffer.from(compressed)
  if (data.byteLength !== entry.uncompressedSize) {
    throw new ChipMatePackageInstallerError(`Package archive entry ${entry.name} has an invalid uncompressed size.`)
  }
  return data
}

function findEndOfCentralDirectory(archive: Buffer) {
  const minOffset = Math.max(0, archive.length - 0xffff - 22)
  for (let offset = archive.length - 22; offset >= minOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.length) return offset
  }
  throw new ChipMatePackageInstallerError("Package archive is not a valid zip file.")
}

function decodeZipName(bytes: Buffer, flags: number) {
  return bytes.toString(flags & ZIP_FLAG_UTF8_NAME ? "utf8" : "latin1")
}

function ensureReadable(buffer: Buffer, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new ChipMatePackageInstallerError(`Package archive has a truncated ${label}.`)
  }
}

async function packageContentRoot(temp: string, pkg: ChipMateCatalogPackage) {
  if (pkg.type === "skill") {
    const direct = join(temp, "SKILL.md")
    if (await exists(direct)) return temp
    const entries = await fs.readdir(temp, { withFileTypes: true })
    const candidates: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const root = join(temp, entry.name)
      if (await exists(join(root, "SKILL.md"))) candidates.push(root)
    }
    if (candidates.length === 1) return candidates[0]!
    throw new ChipMatePackageInstallerError(`Skill package ${pkg.id} must contain SKILL.md at the package root or inside a single top-level folder.`)
  }
  return temp
}

async function readInstalledManifest(root: string): Promise<InstalledChipMatePackageManifest | undefined> {
  const raw = await fs.readFile(join(root, PACKAGE_MANIFEST), "utf8").catch(() => "")
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as InstalledChipMatePackageManifest
    if (parsed.schemaVersion !== 1 || !parsed.id || !parsed.type || !parsed.version) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function copyDirectory(source: string, target: string) {
  await fs.mkdir(target, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(from, to)
      continue
    }
    if (!entry.isFile()) continue
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.copyFile(from, to)
  }
}

async function exists(path: string) {
  return fs.stat(path).then(() => true, () => false)
}

function packageTypeDirectory(type: ChipMateCatalogPackageType) {
  return type === "skill" ? "skills" : "mcps"
}

function safePackageId(input: string) {
  const value = basename(input.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "-")
  if (!value || value === "." || value === "..") throw new ChipMatePackageInstallerError(`Invalid package id: ${input}`)
  return value
}

function isPathInside(path: string, root: string) {
  const normalizedPath = resolve(path)
  const normalizedRoot = resolve(root)
  const rel = relative(normalizedRoot, normalizedPath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}
