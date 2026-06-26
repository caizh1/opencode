import { createHash } from "node:crypto"
import * as path from "node:path"
import * as vscode from "vscode"
import type { DocumentPlan, GeneratedExampleSpec, RuleCardSpec } from "./types"

export const RULE_EXAMPLE_INTENT_VERSION = "rule-example-intent-v5"

export type RuleExampleIntentCacheEntry = {
  createdAt: string
  plannerVersion: string
  modelName: string
  intent: {
    semanticSummary: string
    exampleObjective: string
    exampleFormat: NonNullable<GeneratedExampleSpec["exampleFormat"]>
    exampleType: string
    mustInclude: string[]
    softHints?: string[]
    mustAvoid: string[]
    badExampleFocus: string
    goodExampleFocus: string
    confidence: number
    reason: string
  }
  draftExample?: GeneratedExampleSpec
}

type CacheFile = {
  version: string
  entries: Record<string, RuleExampleIntentCacheEntry>
}

export type RuleExampleIntentCache = {
  get(key: string): Promise<RuleExampleIntentCacheEntry | undefined>
  set(key: string, entry: Omit<RuleExampleIntentCacheEntry, "createdAt" | "plannerVersion">): Promise<void>
  drainWarnings?(): string[]
}

export class WorkspaceRuleExampleIntentCache implements RuleExampleIntentCache {
  private loaded = false
  private data: CacheFile = { version: RULE_EXAMPLE_INTENT_VERSION, entries: {} }
  private warnings: string[] = []
  private disabled = false

  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async get(key: string): Promise<RuleExampleIntentCacheEntry | undefined> {
    await this.load()
    return this.data.entries[key]
  }

  async set(key: string, entry: Omit<RuleExampleIntentCacheEntry, "createdAt" | "plannerVersion">) {
    await this.load()
    if (this.disabled) return
    this.data.entries[key] = {
      ...entry,
      createdAt: new Date().toISOString(),
      plannerVersion: RULE_EXAMPLE_INTENT_VERSION,
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
      if (!parsed || typeof parsed !== "object" || !parsed.entries || parsed.version !== RULE_EXAMPLE_INTENT_VERSION) {
        this.data = { version: RULE_EXAMPLE_INTENT_VERSION, entries: {} }
        return
      }
      this.data = parsed
    } catch (error) {
      if (isMissingFileError(error)) return
      this.warnings.push(`规则示例语义规划缓存不可用，已忽略：${error instanceof Error ? error.message : String(error)}`)
      this.data = { version: RULE_EXAMPLE_INTENT_VERSION, entries: {} }
    }
  }

  private async persist() {
    try {
      const file = this.cachePath()
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)))
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(JSON.stringify(this.data), "utf8"))
    } catch (error) {
      this.disabled = true
      this.warnings.push(`规则示例语义规划缓存写入失败，已跳过缓存：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private cachePath() {
    return path.join(this.workspaceRoot, ".chipmate", "cache", "doc-agent-rule-example-intent.json")
  }
}

export function createWorkspaceRuleExampleIntentCache() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return root ? new WorkspaceRuleExampleIntentCache(root) : undefined
}

export function ruleExampleIntentCacheKey(input: {
  rule: RuleCardSpec
  plan?: DocumentPlan
  modelName: string
}) {
  return [
    RULE_EXAMPLE_INTENT_VERSION,
    input.modelName || "unknown-model",
    stableHash(ruleHashText(input.rule)),
    stableHash(JSON.stringify(input.rule.sources ?? [])),
    stableHash(JSON.stringify(input.plan?.ruleCardPolicy ?? {})),
  ].join(":")
}

export function stableHash(input: string) {
  return createHash("sha256").update(input.replace(/\s+/g, " ").trim()).digest("hex")
}

function ruleHashText(rule: RuleCardSpec) {
  return [
    rule.ruleId,
    rule.name,
    rule.scope,
    rule.description,
    rule.recommended ?? "",
    rule.discouraged ?? "",
    rule.rationale ?? "",
    rule.exceptions ?? "",
  ].join("\n")
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && /ENOENT|FileNotFound|not found|no such file/i.test(error.message)
}
