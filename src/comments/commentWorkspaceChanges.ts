import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { resolveWorkspaceReviewUnitSelectionAtLine } from "./commentFunctionRange"
import { commentWorkspaceLanguageIdForPath } from "./commentLanguage"
import type { CommentLineSpan, CommentWorkspaceReviewUnitKind } from "./commentTypes"

const execFileAsync = promisify(execFile)

const MAX_CHANGED_FILE_BYTES = 512 * 1024
const MAX_REVIEW_UNITS = 40
const FALLBACK_CONTEXT_LINES = 12

export type CommentWorkspaceSkipReason =
  | "not-git-workspace"
  | "deleted-file"
  | "binary-file"
  | "unsupported-language"
  | "file-too-large"
  | "open-failed"
  | "diff-map-failed"
  | "unit-limit"

export type CommentWorkspaceSkippedItem = {
  relativePath: string
  reason: CommentWorkspaceSkipReason
  detail: string
}

export type CommentWorkspaceReviewUnit = {
  id: string
  uri: string
  fsPath: string
  relativePath: string
  languageId: string
  unitKind: CommentWorkspaceReviewUnitKind
  title: string
  range: {
    startLine: number
    endLine: number
    startCharacter: number
    endCharacter: number
  }
  changedLineSpans: CommentLineSpan[]
  hunkCount: number
  diffHash: string
}

export type CommentWorkspaceChangesScanResult =
  | {
    ok: true
    rootPath: string
    diffHash: string
    units: CommentWorkspaceReviewUnit[]
    skipped: CommentWorkspaceSkippedItem[]
    changedFileCount: number
    hunkCount: number
  }
  | {
    ok: false
    reason: CommentWorkspaceSkipReason
    message: string
    skipped: CommentWorkspaceSkippedItem[]
  }

type DiffFileChange = {
  relativePath: string
  status: "modified" | "untracked"
  changedLineSpans: CommentLineSpan[]
  hunkCount: number
  binary?: boolean
  deleted?: boolean
}

export async function scanCommentWorkspaceChanges(): Promise<CommentWorkspaceChangesScanResult> {
  const root = vscode.workspace.workspaceFolders?.[0]
  if (!root) {
    return {
      ok: false,
      reason: "not-git-workspace",
      message: "当前没有打开的工作区。",
      skipped: [],
    }
  }

  const rootPath = await gitRootPath(root.uri.fsPath)
  if (!rootPath) {
    return {
      ok: false,
      reason: "not-git-workspace",
      message: "当前工作区不是 Git 仓库，暂不支持工作区改动注释生成。",
      skipped: [],
    }
  }

  const [diffText, statusText] = await Promise.all([
    git(rootPath, ["diff", "HEAD", "--unified=3", "--no-ext-diff", "--no-color", "--"]),
    git(rootPath, ["status", "--porcelain=v1", "-z"]),
  ])
  const changes = new Map<string, DiffFileChange>()
  for (const change of parseCommentWorkspaceUnifiedDiff(diffText.stdout)) changes.set(change.relativePath, change)
  for (const untracked of parseCommentWorkspaceUntrackedFiles(statusText.stdout)) {
    if (!changes.has(untracked)) {
      changes.set(untracked, {
        relativePath: untracked,
        status: "untracked",
        changedLineSpans: [],
        hunkCount: 1,
      })
    }
  }

  const skipped: CommentWorkspaceSkippedItem[] = []
  const units: CommentWorkspaceReviewUnit[] = []
  let hunkCount = 0
  for (const change of changes.values()) {
    const fileUnits = await reviewUnitsForChange(rootPath, change, skipped)
    for (const unit of fileUnits) {
      if (units.length >= MAX_REVIEW_UNITS) {
        skipped.push({
          relativePath: change.relativePath,
          reason: "unit-limit",
          detail: `已达到 V1 最大 review unit 数量 ${MAX_REVIEW_UNITS}。`,
        })
        break
      }
      units.push(unit)
    }
    hunkCount += change.hunkCount
  }

  const diffHash = hashText(JSON.stringify({
    diff: diffText.stdout,
    untracked: parseCommentWorkspaceUntrackedFiles(statusText.stdout),
  }))
  return {
    ok: true,
    rootPath,
    diffHash,
    units,
    skipped,
    changedFileCount: changes.size,
    hunkCount,
  }
}

async function reviewUnitsForChange(
  rootPath: string,
  change: DiffFileChange,
  skipped: CommentWorkspaceSkippedItem[],
): Promise<CommentWorkspaceReviewUnit[]> {
  if (change.deleted) {
    skipped.push({ relativePath: change.relativePath, reason: "deleted-file", detail: "删除文件没有可插入注释的位置。" })
    return []
  }
  if (change.binary) {
    skipped.push({ relativePath: change.relativePath, reason: "binary-file", detail: "二进制文件不参与 AI 注释生成。" })
    return []
  }
  const languageId = commentWorkspaceLanguageIdForPath(change.relativePath)
  if (!languageId) {
    skipped.push({ relativePath: change.relativePath, reason: "unsupported-language", detail: "当前文件语言暂不支持 AI 注释生成。" })
    return []
  }

  const fsPath = path.join(rootPath, change.relativePath)
  const fileStat = await safeStat(fsPath)
  if (!fileStat) {
    skipped.push({ relativePath: change.relativePath, reason: "open-failed", detail: "无法读取当前工作区文件。" })
    return []
  }
  if (fileStat.size > MAX_CHANGED_FILE_BYTES) {
    skipped.push({ relativePath: change.relativePath, reason: "file-too-large", detail: `文件超过 ${MAX_CHANGED_FILE_BYTES} bytes。` })
    return []
  }

  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath))
  } catch {
    skipped.push({ relativePath: change.relativePath, reason: "open-failed", detail: "无法打开当前工作区文件。" })
    return []
  }

  const changedLineSpans = change.status === "untracked"
    ? [{ startLine: 0, endLine: Math.max(0, document.lineCount - 1) }]
    : mergeLineSpans(change.changedLineSpans).filter((span) => span.startLine < document.lineCount)
  if (!changedLineSpans.length) {
    skipped.push({ relativePath: change.relativePath, reason: "diff-map-failed", detail: "没有可映射到当前文件的新增或修改行。" })
    return []
  }

  const groups = new Map<string, {
    unitKind: CommentWorkspaceReviewUnitKind
    startLine: number
    endLine: number
    changedLineSpans: CommentLineSpan[]
  }>()

  for (const span of changedLineSpans) {
    const structuredSelection = resolveWorkspaceReviewUnitSelectionAtLine(document, span.startLine, languageId)
    if (structuredSelection) {
      const startLine = structuredSelection.selection.start.line
      const endLine = structuredSelection.selection.end.line
      const key = `${structuredSelection.unitKind}:${startLine}:${endLine}`
      const existing = groups.get(key)
      if (existing) {
        existing.changedLineSpans.push(span)
      } else {
        groups.set(key, {
          unitKind: structuredSelection.unitKind,
          startLine,
          endLine,
          changedLineSpans: [span],
        })
      }
      continue
    }

    const startLine = Math.max(0, span.startLine - FALLBACK_CONTEXT_LINES)
    const endLine = Math.min(document.lineCount - 1, span.endLine + FALLBACK_CONTEXT_LINES)
    const key = `fileChunk:${startLine}:${endLine}`
    groups.set(key, {
      unitKind: "fileChunk",
      startLine,
      endLine,
      changedLineSpans: [span],
    })
  }

  return [...groups.values()]
    .sort((left, right) => left.startLine - right.startLine)
    .map((group, index) => {
      const unitChangedSpans = mergeLineSpans(group.changedLineSpans)
        .map((span) => ({
          startLine: Math.max(group.startLine, span.startLine),
          endLine: Math.min(group.endLine, span.endLine),
        }))
        .filter((span) => span.startLine <= span.endLine)
      const diffHash = hashText(JSON.stringify({
        relativePath: change.relativePath,
        unitKind: group.unitKind,
        range: [group.startLine, group.endLine],
        changedLineSpans: unitChangedSpans,
        hunkCount: change.hunkCount,
      }))
      return {
        id: `workspace-change-${shortHash(diffHash)}-${index}`,
        uri: document.uri.toString(),
        fsPath,
        relativePath: change.relativePath,
        languageId,
        unitKind: group.unitKind,
        title: unitTitle(document, languageId, group.unitKind, group.startLine, group.endLine),
        range: {
          startLine: group.startLine,
          endLine: group.endLine,
          startCharacter: 0,
          endCharacter: document.lineAt(group.endLine).text.length,
        },
        changedLineSpans: unitChangedSpans,
        hunkCount: change.hunkCount,
        diffHash,
      }
    })
}

export function parseCommentWorkspaceUnifiedDiff(input: string) {
  const changes: DiffFileChange[] = []
  let current: DiffFileChange | undefined
  let newLine = 0

  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) changes.push(finalizeDiffChange(current))
      current = undefined
      newLine = 0
      continue
    }
    if (line.startsWith("Binary files ")) {
      if (current) current.binary = true
      continue
    }
    if (line.startsWith("+++ ")) {
      const relativePath = parseNewPath(line.slice(4))
      if (!relativePath) {
        if (current) current.deleted = true
        continue
      }
      current = {
        relativePath,
        status: "modified",
        changedLineSpans: [],
        hunkCount: 0,
      }
      continue
    }
    if (!current) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      newLine = Math.max(0, Number(hunk[1]) - 1)
      current.hunkCount += 1
      continue
    }
    if (!line) continue
    const marker = line[0]
    if (marker === "+") {
      pushLine(current.changedLineSpans, newLine)
      newLine += 1
    } else if (marker === " ") {
      newLine += 1
    }
  }
  if (current) changes.push(finalizeDiffChange(current))
  return changes
}

function finalizeDiffChange(change: DiffFileChange): DiffFileChange {
  return {
    ...change,
    changedLineSpans: mergeLineSpans(change.changedLineSpans),
  }
}

function parseNewPath(input: string) {
  const value = input.trim()
  if (value === "/dev/null") return undefined
  if (value.startsWith("b/")) return unquoteGitPath(value.slice(2))
  return unquoteGitPath(value)
}

export function parseCommentWorkspaceUntrackedFiles(input: string) {
  const files: string[] = []
  for (const entry of input.split("\0")) {
    if (!entry.startsWith("?? ")) continue
    const file = entry.slice(3)
    if (file) files.push(file)
  }
  return files
}

function pushLine(spans: CommentLineSpan[], line: number) {
  const last = spans[spans.length - 1]
  if (last && last.endLine + 1 === line) {
    last.endLine = line
    return
  }
  spans.push({ startLine: line, endLine: line })
}

function mergeLineSpans(spans: CommentLineSpan[]) {
  const sorted = [...spans].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  const merged: CommentLineSpan[] = []
  for (const span of sorted) {
    if (span.endLine < span.startLine) continue
    const last = merged[merged.length - 1]
    if (last && span.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, span.endLine)
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

function unitTitle(document: vscode.TextDocument, languageId: string, kind: CommentWorkspaceReviewUnitKind, startLine: number, endLine: number) {
  const firstLine = document.lineAt(startLine).text.replace(/\s+/g, " ").trim()
  const prefix = kind === "function"
    ? languageId === "shellscript"
      ? "函数"
      : "函数"
    : kind === "block"
      ? languageId === "makefile"
        ? "规则块"
        : languageId === "yaml"
          ? "配置块"
          : "结构块"
      : "文件片段"
  const summary = firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine
  return `${prefix} · 第 ${startLine + 1}-${endLine + 1} 行${summary ? ` · ${summary}` : ""}`
}

async function gitRootPath(workspacePath: string) {
  try {
    const result = await git(workspacePath, ["rev-parse", "--show-toplevel"])
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  })
}

async function safeStat(fsPath: string) {
  try {
    return await stat(fsPath)
  } catch {
    return undefined
  }
}

function hashText(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function shortHash(input: string) {
  return hashText(input).slice(0, 12)
}

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  try {
    return JSON.parse(input)
  } catch {
    return input.replace(/^"|"$/g, "")
  }
}
