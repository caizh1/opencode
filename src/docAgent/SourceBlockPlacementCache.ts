import { createHash } from "node:crypto"
import * as path from "node:path"
import * as vscode from "vscode"

export const SOURCE_BLOCK_PLACEMENT_VERSION = "source-block-placement-v2-rule-anchor"

export type SourceBlockPlacementCacheEntry = {
  createdAt: string
  modelName: string
  plannerVersion: string
  targetRuleId: string
  placement: string
  confidence: number
  reason?: string
  label?: string
}

type CacheFile = {
  version: string
  entries: Record<string, SourceBlockPlacementCacheEntry>
}

export type SourceBlockPlacementCache = {
  get(key: string): Promise<SourceBlockPlacementCacheEntry | undefined>
  set(key: string, entry: Omit<SourceBlockPlacementCacheEntry, "createdAt" | "plannerVersion">): Promise<void>
  drainWarnings?(): string[]
}

export class WorkspaceSourceBlockPlacementCache implements SourceBlockPlacementCache {
  private loaded = false
  private data: CacheFile = { version: SOURCE_BLOCK_PLACEMENT_VERSION, entries: {} }
  private warnings: string[] = []
  private disabled = false

  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async get(key: string): Promise<SourceBlockPlacementCacheEntry | undefined> {
    await this.load()
    return this.data.entries[key]
  }

  async set(key: string, entry: Omit<SourceBlockPlacementCacheEntry, "createdAt" | "plannerVersion">) {
    await this.load()
    if (this.disabled) return
    this.data.entries[key] = {
      ...entry,
      createdAt: new Date().toISOString(),
      plannerVersion: SOURCE_BLOCK_PLACEMENT_VERSION,
    }
    await this.persist()
  }

  drainWarnings() {
    const result = this.warnings
    this.warnings = []
    return result
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(this.cachePath()))
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as CacheFile
      if (!parsed || typeof parsed !== "object" || !parsed.entries || parsed.version !== SOURCE_BLOCK_PLACEMENT_VERSION) {
        this.data = { version: SOURCE_BLOCK_PLACEMENT_VERSION, entries: {} }
        return
      }
      this.data = parsed
    } catch (error) {
      if (isMissingFileError(error)) return
      this.warnings.push(`来源块归位缓存不可用，已忽略：${error instanceof Error ? error.message : String(error)}`)
      this.data = { version: SOURCE_BLOCK_PLACEMENT_VERSION, entries: {} }
    }
  }

  private async persist() {
    try {
      const file = this.cachePath()
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)))
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(JSON.stringify(this.data), "utf8"))
    } catch (error) {
      this.disabled = true
      this.warnings.push(`来源块归位缓存写入失败，已跳过缓存：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private cachePath() {
    return path.join(this.workspaceRoot, ".chipmate", "cache", "doc-agent-source-placement.json")
  }
}

export function createWorkspaceSourceBlockPlacementCache() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return root ? new WorkspaceSourceBlockPlacementCache(root) : undefined
}

export function stableHash(input: string) {
  return createHash("sha256").update(input.replace(/\s+/g, " ").trim()).digest("hex")
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && /ENOENT|FileNotFound|not found|no such file/i.test(error.message)
}
