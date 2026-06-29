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
      })
      afterRender = await renderWordDocument({
        docxPath: afterDocxPath,
        bytes: input.after.bytes,
        workspaceRoot: input.workspaceRoot,
        artifactNameBase: `${artifactName}-after`,
        timeoutMs: input.timeoutMs ?? 60_000,
        signal: input.signal,
        log: input.log,
      })
      issues.push(...beforeRender.issues, ...afterRender.issues)
      if (artifactDir) {
        const collected = await collectChangedPageArtifacts({
        beforePages: beforeRender.absolutePagePngPaths ?? [],
        afterPages: afterRender.absolutePagePngPaths ?? [],
        artifactDir,
        workspaceRoot: input.workspaceRoot,
        pixelThreshold: normalizePixelThreshold(input.pixelThreshold),
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
  pixelThreshold: number
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
      const pixelDiff = await renderPagePixelDiff({
        beforePath,
        afterPath,
        targetPath: path.join(input.artifactDir.absolute, `diff-page-${index + 1}.png`),
        workspaceRoot: input.workspaceRoot,
        threshold: input.pixelThreshold,
      }).catch((error) => {
        issues.push(issue("warning", "word-pixel-diff-failed", `Rendered page ${index + 1} changed, but pixel diff PNG could not be generated: ${formatError(error)}`))
        return undefined
      })
      changedPages.push({
        page: index + 1,
        byteChanged: true,
        ...await copyPageArtifact(beforePath, input.artifactDir.absolute, input.workspaceRoot, `before-page-${index + 1}.png`, "before"),
        ...await copyPageArtifact(afterPath, input.artifactDir.absolute, input.workspaceRoot, `after-page-${index + 1}.png`, "after"),
        ...(pixelDiff ?? {}),
      })
    }
  }
  return { changedPages, issues }
}

async function renderPagePixelDiff(input: {
  beforePath: string
  afterPath: string
  targetPath: string
  workspaceRoot: string
  threshold: number
}) {
  const canvasModule = await import("canvas")
  const beforeImage = await canvasModule.loadImage(input.beforePath)
  const afterImage = await canvasModule.loadImage(input.afterPath)
  const width = Math.max(1, beforeImage.width, afterImage.width)
  const height = Math.max(1, beforeImage.height, afterImage.height)
  const beforeCanvas = canvasModule.createCanvas(width, height)
  const afterCanvas = canvasModule.createCanvas(width, height)
  const diffCanvas = canvasModule.createCanvas(width, height)
  const beforeContext = beforeCanvas.getContext("2d")
  const afterContext = afterCanvas.getContext("2d")
  const diffContext = diffCanvas.getContext("2d")
  for (const context of [beforeContext, afterContext, diffContext]) {
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
  }
  beforeContext.drawImage(beforeImage, 0, 0)
  afterContext.drawImage(afterImage, 0, 0)
  diffContext.drawImage(afterCanvas, 0, 0)
  const beforeData = beforeContext.getImageData(0, 0, width, height)
  const afterData = afterContext.getImageData(0, 0, width, height)
  const diffData = diffContext.getImageData(0, 0, width, height)
  let changedPixels = 0
  const changedMask = new Uint8Array(width * height)
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let offset = 0; offset < beforeData.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(beforeData.data[offset]! - afterData.data[offset]!),
      Math.abs(beforeData.data[offset + 1]! - afterData.data[offset + 1]!),
      Math.abs(beforeData.data[offset + 2]! - afterData.data[offset + 2]!),
      Math.abs(beforeData.data[offset + 3]! - afterData.data[offset + 3]!),
    )
    if (delta > input.threshold) {
      const pixel = offset / 4
      const x = pixel % width
      const y = Math.floor(pixel / width)
      changedPixels += 1
      changedMask[pixel] = 1
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      diffData.data[offset] = 220
      diffData.data[offset + 1] = 38
      diffData.data[offset + 2] = 38
      diffData.data[offset + 3] = 220
    }
  }
  diffContext.putImageData(diffData, 0, 0)
  await writeFile(input.targetPath, diffCanvas.toBuffer("image/png"))
  const totalPixels = width * height
  const changedRatio = totalPixels ? changedPixels / totalPixels : 0
  const changeBounds = changedPixels > 0
    ? { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
    : undefined
  const changedRegions = summarizeDiffRegions(changedMask, width, height)
  const dominantChangedRegions = changedRegions
    .filter((region) => region.changedPixels > 0)
    .sort((left, right) => right.changedPixels - left.changedPixels)
    .slice(0, 3)
    .map((region) => region.id)
  const riskFlags = diffRiskFlags({
    changedRatio,
    changeBounds,
    changedRegions,
    dimensionChanged: beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height,
  })
  return {
    diffPngPath: posixRelative(input.workspaceRoot, input.targetPath),
    absoluteDiffPngPath: input.targetPath,
    changedPixels,
    totalPixels,
    changedRatio,
    beforeWidth: beforeImage.width,
    beforeHeight: beforeImage.height,
    afterWidth: afterImage.width,
    afterHeight: afterImage.height,
    diffWidth: width,
    diffHeight: height,
    pixelThreshold: input.threshold,
    dimensionChanged: beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height,
    changeBounds,
    changedRegions,
    dominantChangedRegions,
    visualSeverity: visualSeverity(changedRatio),
    visualSummary: visualDiffSummary({ changedPixels, totalPixels, changedRatio, changeBounds, dominantChangedRegions, riskFlags }),
    riskFlags,
  }
}

function summarizeDiffRegions(mask: Uint8Array, width: number, height: number): WordDocumentDiffRegionSummary[] {
  const rows = ["top", "middle", "bottom"] as const
  const columns = ["left", "center", "right"] as const
  const regions: WordDocumentDiffRegionSummary[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const top = Math.floor((height * rowIndex) / rows.length)
    const bottom = Math.max(top, Math.floor((height * (rowIndex + 1)) / rows.length) - 1)
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const left = Math.floor((width * columnIndex) / columns.length)
      const right = Math.max(left, Math.floor((width * (columnIndex + 1)) / columns.length) - 1)
      let changedPixels = 0
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          changedPixels += mask[y * width + x] ?? 0
        }
      }
      const totalPixels = Math.max(1, (right - left + 1) * (bottom - top + 1))
      regions.push({
        id: `${rows[rowIndex]}-${columns[columnIndex]}`,
        row: rows[rowIndex],
        column: columns[columnIndex],
        bounds: { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 },
        changedPixels,
        changedRatio: changedPixels / totalPixels,
      })
    }
  }
  return regions
}

function diffRiskFlags(input: {
  changedRatio: number
  changeBounds?: WordDocumentDiffBounds
  changedRegions: WordDocumentDiffRegionSummary[]
  dimensionChanged: boolean
}) {
  const flags: string[] = []
  if (input.dimensionChanged) flags.push("page-dimension-change")
  if (input.changedRatio > 0 && input.changedRatio < 0.001) flags.push("tiny-pixel-change")
  if (input.changedRatio >= 0.15) flags.push("broad-page-change")
  const changedRegionCount = input.changedRegions.filter((region) => region.changedPixels > 0).length
  if (changedRegionCount >= 6) flags.push("multi-region-change")
  if (changedRegionCount <= 2 && input.changedRatio > 0) flags.push("localized-change")
  if (input.changeBounds) {
    const boundsAreaRatio = (input.changeBounds.width * input.changeBounds.height) / Math.max(1, input.changedRegions.reduce((max, region) => Math.max(max, region.bounds.right + 1), 0) * input.changedRegions.reduce((max, region) => Math.max(max, region.bounds.bottom + 1), 0))
    if (boundsAreaRatio > 0.5 && input.changedRatio < 0.05) flags.push("possible-reflow-or-antialias")
  }
  return flags
}

function visualSeverity(changedRatio: number): WordDocumentChangedPage["visualSeverity"] {
  if (changedRatio <= 0) return "none"
  if (changedRatio < 0.005) return "minor"
  if (changedRatio < 0.05) return "moderate"
  return "major"
}

function visualDiffSummary(input: {
  changedPixels: number
  totalPixels: number
  changedRatio: number
  changeBounds?: WordDocumentDiffBounds
  dominantChangedRegions: string[]
  riskFlags: string[]
}) {
  if (!input.changedPixels) return "No changed pixels above threshold."
  const ratio = `${(input.changedRatio * 100).toFixed(2)}%`
  const bounds = input.changeBounds ? `bbox ${input.changeBounds.left},${input.changeBounds.top}-${input.changeBounds.right},${input.changeBounds.bottom}` : "no bbox"
  const regions = input.dominantChangedRegions.length ? `dominant regions ${input.dominantChangedRegions.join(", ")}` : "no dominant region"
  const flags = input.riskFlags.length ? `; flags ${input.riskFlags.join(", ")}` : ""
  return `${input.changedPixels}/${input.totalPixels} pixels changed (${ratio}), ${bounds}, ${regions}${flags}.`
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

function formatError(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : String(errorValue)
}

function normalizePixelThreshold(input: number | undefined) {
  if (typeof input !== "number" || !Number.isFinite(input)) return 12
  return Math.max(0, Math.min(255, Math.trunc(input)))
}
