import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { loadDocxZip, parseTopLevelElements, tableRows, xmlTextFrom } from "./WordDocumentInspector"
import { renderWordDocument } from "./WordRenderQualityGate"
import type { QualityIssue, WordEditRenderCheckResult } from "./types"

export type WordDocumentDiffInput = {
  before: WordDocumentDiffSide
  after: WordDocumentDiffSide
  workspaceRoot?: string
  artifactNameBase?: string
  pixelThreshold?: number
  timeoutMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
  remoteEndpoint?: string
}

export type WordDocumentDiffSide = {
  path: string
  bytes: Uint8Array
}

export type WordDocumentChangedPage = {
  page: number
  beforePngPath?: string
  afterPngPath?: string
  diffPngPath?: string
  absoluteBeforePngPath?: string
  absoluteAfterPngPath?: string
  absoluteDiffPngPath?: string
  byteChanged?: boolean
  missingSide?: "before" | "after"
  changedPixels?: number
  totalPixels?: number
  changedRatio?: number
  beforeWidth?: number
  beforeHeight?: number
  afterWidth?: number
  afterHeight?: number
  diffWidth?: number
  diffHeight?: number
  pixelThreshold?: number
  dimensionChanged?: boolean
  changeBounds?: WordDocumentDiffBounds
  changedRegions?: WordDocumentDiffRegionSummary[]
  dominantChangedRegions?: string[]
  visualSeverity?: "none" | "minor" | "moderate" | "major"
  visualSummary?: string
  riskFlags?: string[]
}

export type WordDocumentDiffBounds = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type WordDocumentDiffRegionSummary = {
  id: string
  row: "top" | "middle" | "bottom"
  column: "left" | "center" | "right"
  bounds: WordDocumentDiffBounds
  changedPixels: number
  changedRatio: number
}

export type WordDocumentDiffResult = {
  ok: boolean
  attemptedRender: boolean
  visualDiffComplete: boolean
  pixelDiffComplete: boolean
  beforeRender?: WordEditRenderCheckResult
  afterRender?: WordEditRenderCheckResult
  beforeText: string
  afterText: string
  textChanged: boolean
  textDiff: string
  textDiffPath?: string
  absoluteTextDiffPath?: string
  pageCountBefore?: number
  pageCountAfter?: number
  changedPages: WordDocumentChangedPage[]
  diffArtifactDir?: string
  absoluteDiffArtifactDir?: string
  issues: QualityIssue[]
}

export async function compareWordDocuments(input: WordDocumentDiffInput): Promise<WordDocumentDiffResult> {
  const issues: QualityIssue[] = []
  const artifactName = sanitizeArtifactName(input.artifactNameBase || `${path.basename(input.before.path, ".docx")}-vs-${path.basename(input.after.path, ".docx")}`)
  const beforeText = await comparableDocxText(input.before.bytes)
  const afterText = await comparableDocxText(input.after.bytes)
  const textDiff = unifiedTextDiff(beforeText, afterText, input.before.path, input.after.path)
  const textChanged = normalizeComparableText(beforeText) !== normalizeComparableText(afterText)
  const artifactDir = input.workspaceRoot ? await createDiffArtifactDir(input.workspaceRoot, artifactName) : undefined
  let textDiffPath: string | undefined
  let absoluteTextDiffPath: string | undefined
  if (artifactDir) {
    absoluteTextDiffPath = path.join(artifactDir.absolute, "text-diff.txt")
    await writeFile(absoluteTextDiffPath, textDiff)
    textDiffPath = posixRelative(input.workspaceRoot!, absoluteTextDiffPath)
  } else {
    issues.push(issue("warning", "word-diff-artifacts-unavailable", "No workspace root was provided; compare_word_documents returned text diff only and did not persist visual artifacts."))
  }

  let beforeRender: WordEditRenderCheckResult | undefined
  let afterRender: WordEditRenderCheckResult | undefined
  const changedPages: WordDocumentChangedPage[] = []
  if (input.workspaceRoot) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "chipmate-word-diff-"))
    try {
      const beforeDocxPath = path.join(tempRoot, `before-${safeDocxBasename(input.before.path)}`)
      const afterDocxPath = path.join(tempRoot, `after-${safeDocxBasename(input.after.path)}`)
      await writeFile(beforeDocxPath, input.before.bytes)
      await writeFile(afterDocxPath, input.after.bytes)
      beforeRender = await renderWordDocument({
        docxPath: beforeDocxPath,
        bytes: input.before.bytes,
        workspaceRoot: input.workspaceRoot,
        artifactNameBase: `${artifactName}-before`,
        timeoutMs: input.timeoutMs ?? 60_000,
        signal: input.signal,
        log: input.log,
        remoteEndpoint: input.remoteEndpoint,
      })
      afterRender = await renderWordDocument({
        docxPath: afterDocxPath,
        bytes: input.after.bytes,
        workspaceRoot: input.workspaceRoot,
        artifactNameBase: `${artifactName}-after`,
        timeoutMs: input.timeoutMs ?? 60_000,
        signal: input.signal,
        log: input.log,
        remoteEndpoint: input.remoteEndpoint,
      })
      issues.push(...beforeRender.issues, ...afterRender.issues)
      if (artifactDir) {
        const collected = await collectChangedPageArtifacts({
        beforePages: beforeRender.absolutePagePngPaths ?? [],
        afterPages: afterRender.absolutePagePngPaths ?? [],
        artifactDir,
        workspaceRoot: input.workspaceRoot,
      })
        changedPages.push(...collected.changedPages)
        issues.push(...collected.issues)
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const visualDiffComplete = Boolean(
    beforeRender?.attempted
    && afterRender?.attempted
    && beforeRender.absolutePagePngPaths?.length
    && afterRender.absolutePagePngPaths?.length,
  )
  if (input.workspaceRoot && !visualDiffComplete) {
    issues.push(issue("warning", "word-render-diff-incomplete", "DOCX render diff did not produce page PNGs for both documents; text diff is still available."))
  }

  return {
    ok: !issues.some((item) => item.severity === "error"),
    attemptedRender: Boolean(beforeRender || afterRender),
    visualDiffComplete,
    pixelDiffComplete: visualDiffComplete && changedPages.every((page) => page.missingSide || !page.byteChanged || Boolean(page.diffPngPath)),
    beforeRender,
    afterRender,
    beforeText,
    afterText,
    textChanged,
    textDiff,
    textDiffPath,
    absoluteTextDiffPath,
    pageCountBefore: beforeRender?.pageCount,
    pageCountAfter: afterRender?.pageCount,
    changedPages,
    diffArtifactDir: artifactDir?.relative,
    absoluteDiffArtifactDir: artifactDir?.absolute,
    issues: uniqueIssues(issues),
  }
}

async function comparableDocxText(bytes: Uint8Array) {
  const zip = await loadDocxZip(bytes)
  const lines: string[] = []
  const documentXml = await readZipText(zip, "word/document.xml")
  if (documentXml) {
    for (const element of parseTopLevelElements(documentXml)) {
      if (element.kind === "table") {
        for (const row of tableRows(element.xml)) lines.push(row.map((cell) => cell.trim()).join(" | "))
      } else {
        lines.push(xmlTextFrom(element.xml).trim())
      }
    }
  }
  for (const partPath of packageXmlPaths(zip, /^word\/(header|footer)\d+\.xml$/)) {
    const text = xmlTextFrom(await readZipText(zip, partPath) ?? "").trim()
    if (text) lines.push(`[${partPath}] ${text}`)
  }
  for (const partPath of ["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"]) {
    const text = xmlTextFrom(await readZipText(zip, partPath) ?? "").trim()
    if (text) lines.push(`[${partPath}] ${text}`)
  }
  return lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
}

async function readZipText(zip: Awaited<ReturnType<typeof loadDocxZip>>, partPath: string) {
  const part = zip.file(partPath)
  return part ? await part.async("string") : undefined
}

function packageXmlPaths(zip: Awaited<ReturnType<typeof loadDocxZip>>, pattern: RegExp) {
  return Object.keys(zip.files).filter((item) => pattern.test(item)).sort()
}

async function collectChangedPageArtifacts(input: {
  beforePages: string[]
  afterPages: string[]
  artifactDir: { absolute: string; relative: string }
  workspaceRoot: string
}) {
  const changedPages: WordDocumentChangedPage[] = []
  const issues: QualityIssue[] = []
  const pageCount = Math.max(input.beforePages.length, input.afterPages.length)
  for (let index = 0; index < pageCount; index += 1) {
    const beforePath = input.beforePages[index]
    const afterPath = input.afterPages[index]
    if (!beforePath || !afterPath) {
      const item: WordDocumentChangedPage = { page: index + 1, missingSide: beforePath ? "after" : "before" }
      if (beforePath) Object.assign(item, await copyPageArtifact(beforePath, input.artifactDir.absolute, input.workspaceRoot, `before-page-${index + 1}.png`, "before"))
      if (afterPath) Object.assign(item, await copyPageArtifact(afterPath, input.artifactDir.absolute, input.workspaceRoot, `after-page-${index + 1}.png`, "after"))
      changedPages.push(item)
      continue
    }
    const beforeHash = await fileSha256(beforePath)
    const afterHash = await fileSha256(afterPath)
    if (beforeHash !== afterHash) {
      issues.push(issue(
        "warning",
        "word-pixel-diff-skipped",
        `Rendered page ${index + 1} changed, but pixel diff PNG generation is skipped because the VSIX client no longer bundles local canvas. Remote pixel diff is not implemented yet.`,
      ))
      changedPages.push({
        page: index + 1,
        byteChanged: true,
        ...await copyPageArtifact(beforePath, input.artifactDir.absolute, input.workspaceRoot, `before-page-${index + 1}.png`, "before"),
        ...await copyPageArtifact(afterPath, input.artifactDir.absolute, input.workspaceRoot, `after-page-${index + 1}.png`, "after"),
      })
    }
  }
  return { changedPages, issues }
}

async function copyPageArtifact(source: string, artifactDir: string, workspaceRoot: string, filename: string, side: "before" | "after") {
  const target = path.join(artifactDir, filename)
  await copyFile(source, target)
  return side === "before"
    ? { beforePngPath: posixRelative(workspaceRoot, target), absoluteBeforePngPath: target }
    : { afterPngPath: posixRelative(workspaceRoot, target), absoluteAfterPngPath: target }
}

async function createDiffArtifactDir(workspaceRoot: string, artifactName: string) {
  const outputDir = path.join(workspaceRoot, ".chipmate", "docs", "diff", `${artifactName}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${Math.random().toString(36).slice(2, 6)}`)
  await mkdir(outputDir, { recursive: true })
  return { absolute: outputDir, relative: posixRelative(workspaceRoot, outputDir) }
}

function unifiedTextDiff(beforeText: string, afterText: string, beforeLabel: string, afterLabel: string) {
  const beforeLines = beforeText.split("\n")
  const afterLines = afterText.split("\n")
  const header = [`--- ${beforeLabel}`, `+++ ${afterLabel}`]
  if (normalizeComparableText(beforeText) === normalizeComparableText(afterText)) return [...header, "@@ text unchanged @@"].join("\n")
  const operations = diffLines(beforeLines, afterLines)
  return [
    ...header,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...operations.map((operation) => `${operation.kind}${operation.text}`),
  ].join("\n")
}

function diffLines(beforeLines: string[], afterLines: string[]) {
  if (beforeLines.length * afterLines.length > 200_000) return sequentialDiff(beforeLines, afterLines)
  const table = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0) as number[])
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      table[i]![j] = beforeLines[i] === afterLines[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const operations: Array<{ kind: " " | "-" | "+"; text: string }> = []
  let i = 0
  let j = 0
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      operations.push({ kind: " ", text: beforeLines[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      operations.push({ kind: "-", text: beforeLines[i]! })
      i += 1
    } else {
      operations.push({ kind: "+", text: afterLines[j]! })
      j += 1
    }
  }
  while (i < beforeLines.length) {
    operations.push({ kind: "-", text: beforeLines[i]! })
    i += 1
  }
  while (j < afterLines.length) {
    operations.push({ kind: "+", text: afterLines[j]! })
    j += 1
  }
  return operations
}

function sequentialDiff(beforeLines: string[], afterLines: string[]) {
  const operations: Array<{ kind: " " | "-" | "+"; text: string }> = []
  const lineCount = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < lineCount; index += 1) {
    const beforeLine = beforeLines[index]
    const afterLine = afterLines[index]
    if (beforeLine === afterLine && beforeLine !== undefined) operations.push({ kind: " ", text: beforeLine })
    else {
      if (beforeLine !== undefined) operations.push({ kind: "-", text: beforeLine })
      if (afterLine !== undefined) operations.push({ kind: "+", text: afterLine })
    }
  }
  return operations
}

async function fileSha256(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex")
}

function normalizeComparableText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function sanitizeArtifactName(input: string) {
  return input
    .replace(/\.docx$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "word-diff"
}

function safeDocxBasename(input: string) {
  const basename = sanitizeArtifactName(path.basename(input, ".docx"))
  return `${basename || "document"}.docx`
}

function posixRelative(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/")
}

function uniqueIssues(items: QualityIssue[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.severity}:${item.code}:${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function issue(severity: "error" | "warning", code: string, message: string): QualityIssue {
  return { severity, code, message }
}
