import * as path from "node:path"
import { createHash } from "node:crypto"
import * as vscode from "vscode"
import type { CandidateRule, ReferenceChunk } from "./types"

export const RULE_EXTRACTOR_VERSION = "rule-extractor-v3-rule-anchor"

type CacheFile = {
  version: string
  entries: Record<string, CacheEntry>
}

type CacheEntry = {
  createdAt: string
  modelName: string
  extractorVersion: string
  rules: CandidateRule[]
}

export type RuleExtractionCache = {
  get(key: string): Promise<CandidateRule[] | undefined>
  set(key: string, rules: CandidateRule[]): Promise<void>
  drainWarnings?(): string[]
}

export class WorkspaceRuleExtractionCache implements RuleExtractionCache {
  private loaded = false
  private data: CacheFile = { version: RULE_EXTRACTOR_VERSION, entries: {} }
  private warnings: string[] = []
  private disabled = false

  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async get(key: string): Promise<CandidateRule[] | undefined> {
    await this.load()
    return this.data.entries[key]?.rules
  }

  async set(key: string, rules: CandidateRule[]) {
    await this.load()
    if (this.disabled) return
    this.data.entries[key] = {
      createdAt: new Date().toISOString(),
      modelName: modelNameFromKey(key),
      extractorVersion: RULE_EXTRACTOR_VERSION,
      rules,
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
      if (!parsed || typeof parsed !== "object" || !parsed.entries || parsed.version !== RULE_EXTRACTOR_VERSION) {
        this.data = { version: RULE_EXTRACTOR_VERSION, entries: {} }
        return
      }
      this.data = parsed
    } catch (error) {
      if (isMissingFileError(error)) return
      this.warnings.push(`规则抽取缓存不可用，已忽略：${error instanceof Error ? error.message : String(error)}`)
      this.data = { version: RULE_EXTRACTOR_VERSION, entries: {} }
    }
  }

  private async persist() {
    try {
      const file = this.cachePath()
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)))
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(JSON.stringify(this.data), "utf8"))
    } catch (error) {
      this.disabled = true
      this.warnings.push(`规则抽取缓存写入失败，已跳过缓存：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private cachePath() {
    return path.join(this.workspaceRoot, ".chipmate", "cache", "doc-agent-rule-extraction.json")
  }
}

export function createWorkspaceRuleExtractionCache() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return root ? new WorkspaceRuleExtractionCache(root) : undefined
}

export function ruleExtractionCacheKey(input: {
  chunk: ReferenceChunk
  modelName: string
  extractorVersion?: string
}) {
  const normalized = normalizeForHash(input.chunk.text)
  const contentHash = createHash("sha256").update(normalized).digest("hex")
  return [
    input.extractorVersion ?? RULE_EXTRACTOR_VERSION,
    input.modelName || "unknown-model",
    input.chunk.role,
    input.chunk.sourceOrigin ?? "unknown",
    contentHash,
  ].join(":")
}

function normalizeForHash(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function modelNameFromKey(key: string) {
  return key.split(":")[1] ?? "unknown-model"
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && /ENOENT|FileNotFound|not found|no such file/i.test(error.message)
}
