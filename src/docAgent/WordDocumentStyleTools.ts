import { createRequire } from "node:module"
import * as path from "node:path"
import { DocxRenderQualityGate } from "./DocxRenderQualityGate"
import { DocxFileStore } from "./DocxFileStore"
import { xmlTextFrom } from "./WordDocumentInspector"
import { renderWordDocument } from "./WordRenderQualityGate"
import type { WordEditRenderCheckResult, WordEditStructureCheckResult } from "./types"

const nodeRequire = createRequire(__filename)

type JsZipModule = typeof import("jszip")
type ZipEntry = {
  dir?: boolean
  async(type: "string"): Promise<string>
}
type ZipArchive = {
  file(path: string): ZipEntry | null
  file(path: string, data: string | Uint8Array): void
  files: Record<string, ZipEntry>
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

export type WordStyleLintReport = {
  inputPath: string
  paragraphCount: number
  runCount: number
  fontsByCharCount: Record<string, number>
  directRunFormattingRuns: number
  directParagraphFormattingParagraphs: number
  headingLikeParagraphsNotHeadingStyle: Array<{ partPath: string; paragraphIndex: number; text: string; styleId?: string }>
  examples: {
    directRunFormatting: Array<{ partPath: string; paragraphIndex: number; runText: string; styleId?: string }>
    directParagraphFormatting: Array<{ partPath: string; paragraphIndex: number; text: string; styleId?: string }>
  }
  notes: string[]
}

export type WordRunFormattingKind = "font" | "bold" | "italic" | "underline" | "color" | "size"

export type WordStyleNormalizeOptions = {
  clearRunFormatting?: boolean
  clearParagraphFormatting?: boolean
  enforceHeadingSpacing?: boolean
  headingSpaceAfterTwips?: number
  preserveRunFormatting?: WordRunFormattingKind[]
}

export type WordStyleNormalizeResult = {
  path: string
  absolutePath: string
  beforeReport: WordStyleLintReport
  afterReport: WordStyleLintReport
  runOverridesCleared: number
  runOverridesPreserved: number
  paragraphOverridesCleared: number
  headingSpacingUpdates: number
  preservedRunFormatting: WordRunFormattingKind[]
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

type EffectiveWordStyleNormalizeOptions = {
  clearRunFormatting: boolean
  clearParagraphFormatting: boolean
  enforceHeadingSpacing: boolean
  headingSpaceAfterTwips: number
  preserveRunFormatting: Set<WordRunFormattingKind>
}

export class WordDocumentStyleNormalizer {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async normalize(input: {
    path: string
    bytes: Uint8Array
    outputFilenameBase?: string
    options?: WordStyleNormalizeOptions
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<WordStyleNormalizeResult> {
    input.signal?.throwIfAborted()
    const normalized = await normalizeWordDocumentStyleBytes(input.bytes, input.path, input.options)
    const structureIssues = await new DocxRenderQualityGate().check(normalized.bytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`Style-normalized DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.path, ".docx")}-style-normalized`,
      bytes: normalized.bytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: normalized.bytes,
      workspaceRoot: this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: 60_000,
      signal: input.signal,
      log: input.log,
    })
    const warnings = [
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      beforeReport: normalized.beforeReport,
      afterReport: normalized.afterReport,
      runOverridesCleared: normalized.runOverridesCleared,
      runOverridesPreserved: normalized.runOverridesPreserved,
      paragraphOverridesCleared: normalized.paragraphOverridesCleared,
      headingSpacingUpdates: normalized.headingSpacingUpdates,
      preservedRunFormatting: normalized.preservedRunFormatting,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export async function auditWordDocumentStyles(input: { path: string; bytes: Uint8Array }): Promise<WordStyleLintReport> {
  const zip = await loadZip(input.bytes)
  const fonts = new Map<string, number>()
  const report: WordStyleLintReport = {
    inputPath: input.path,
    paragraphCount: 0,
    runCount: 0,
    fontsByCharCount: {},
    directRunFormattingRuns: 0,
    directParagraphFormattingParagraphs: 0,
    headingLikeParagraphsNotHeadingStyle: [],
    examples: {
      directRunFormatting: [],
      directParagraphFormatting: [],
    },
    notes: [
      "Direct formatting is not always wrong, but it often causes inconsistent output when templates change.",
      "Heading-like paragraphs not using Heading styles can break TOC and accessibility.",
    ],
  }
  for (const partPath of styleRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    inspectXmlPart(xml, partPath, report, fonts)
  }
  report.fontsByCharCount = Object.fromEntries([...fonts.entries()].sort((left, right) => right[1] - left[1]))
  return report
}

export async function normalizeWordDocumentStyleBytes(bytes: Uint8Array, pathLabel: string, options?: WordStyleNormalizeOptions): Promise<{
  bytes: Uint8Array
  beforeReport: WordStyleLintReport
  afterReport: WordStyleLintReport
  runOverridesCleared: number
  runOverridesPreserved: number
  paragraphOverridesCleared: number
  headingSpacingUpdates: number
  preservedRunFormatting: WordRunFormattingKind[]
}> {
  const preservedRunFormatting = normalizePreserveRunFormatting(options?.preserveRunFormatting)
  const effectiveOptions: EffectiveWordStyleNormalizeOptions = {
    clearRunFormatting: options?.clearRunFormatting !== false,
    clearParagraphFormatting: options?.clearParagraphFormatting === true,
    enforceHeadingSpacing: options?.enforceHeadingSpacing === true,
    headingSpaceAfterTwips: positiveTwips(options?.headingSpaceAfterTwips, 120),
    preserveRunFormatting: new Set(preservedRunFormatting),
  }
  const beforeReport = await auditWordDocumentStyles({ path: pathLabel, bytes })
  const zip = await loadZip(bytes)
  let runOverridesCleared = 0
  let runOverridesPreserved = 0
  let paragraphOverridesCleared = 0
  let headingSpacingUpdates = 0
  for (const partPath of styleRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    const normalized = normalizeXmlPartStyles(xml, effectiveOptions)
    runOverridesCleared += normalized.runOverridesCleared
    runOverridesPreserved += normalized.runOverridesPreserved
    paragraphOverridesCleared += normalized.paragraphOverridesCleared
    headingSpacingUpdates += normalized.headingSpacingUpdates
    if (normalized.xml !== xml) zip.file(partPath, normalized.xml)
  }
  const nextBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const afterReport = await auditWordDocumentStyles({ path: pathLabel, bytes: nextBytes })
  return { bytes: nextBytes, beforeReport, afterReport, runOverridesCleared, runOverridesPreserved, paragraphOverridesCleared, headingSpacingUpdates, preservedRunFormatting }
}

function inspectXmlPart(xml: string, partPath: string, report: WordStyleLintReport, fonts: Map<string, number>) {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []
  for (const paragraphXml of paragraphs) {
    report.paragraphCount += 1
    const paragraphIndex = report.paragraphCount
    const styleId = paragraphStyleId(paragraphXml)
    const text = xmlTextFrom(paragraphXml).replace(/\s+/g, " ").trim()
    if (hasDirectParagraphFormatting(paragraphXml)) {
      report.directParagraphFormattingParagraphs += 1
      if (report.examples.directParagraphFormatting.length < 5) {
        report.examples.directParagraphFormatting.push({ partPath, paragraphIndex, text: text.slice(0, 120), styleId })
      }
    }
    if (looksLikeHeadingWithoutHeadingStyle(paragraphXml, text, styleId) && report.headingLikeParagraphsNotHeadingStyle.length < 20) {
      report.headingLikeParagraphsNotHeadingStyle.push({ partPath, paragraphIndex, text: text.slice(0, 120), styleId })
    }
    const runs = paragraphXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []
    for (const runXml of runs) {
      report.runCount += 1
      const runText = xmlTextFrom(runXml)
      const fontName = runFontName(runXml)
      if (fontName && runText) fonts.set(fontName, (fonts.get(fontName) ?? 0) + runText.length)
      if (hasDirectRunFormatting(runXml)) {
        report.directRunFormattingRuns += 1
        if (report.examples.directRunFormatting.length < 5) {
          report.examples.directRunFormatting.push({ partPath, paragraphIndex, runText: runText.replace(/\s+/g, " ").trim().slice(0, 80), styleId })
        }
      }
    }
  }
}

function normalizeXmlPartStyles(xml: string, options: EffectiveWordStyleNormalizeOptions) {
  let runOverridesCleared = 0
  let runOverridesPreserved = 0
  let paragraphOverridesCleared = 0
  let headingSpacingUpdates = 0
  let next = xml
  if (options.clearRunFormatting) {
    next = next.replace(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/g, (runProperties) => {
      const normalized = clearRunDirectFormatting(runProperties, options.preserveRunFormatting)
      if (normalized !== runProperties) runOverridesCleared += 1
      if (hasDirectRunFormatting(normalized) && options.preserveRunFormatting.size > 0) runOverridesPreserved += 1
      return normalized
    })
  }
  if (options.clearParagraphFormatting || options.enforceHeadingSpacing) {
    next = next.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
      let paragraph = paragraphXml
      if (options.clearParagraphFormatting) {
        const cleared = clearParagraphDirectFormatting(paragraph)
        if (cleared !== paragraph) {
          paragraphOverridesCleared += 1
          paragraph = cleared
        }
      }
      if (options.enforceHeadingSpacing && isHeadingStyle(paragraphStyleId(paragraph))) {
        const updated = enforceParagraphSpacing(paragraph, options.headingSpaceAfterTwips)
        if (updated !== paragraph) {
          headingSpacingUpdates += 1
          paragraph = updated
        }
      }
      return paragraph
    })
  }
  return { xml: next, runOverridesCleared, runOverridesPreserved, paragraphOverridesCleared, headingSpacingUpdates }
}

async function loadZip(bytes: Uint8Array) {
  const JSZip = nodeRequire("jszip") as JsZipModule
  return await JSZip.loadAsync(Buffer.from(bytes)) as ZipArchive
}

async function readZipText(zip: ZipArchive, partPath: string) {
  const part = zip.file(partPath)
  return part ? await part.async("string") : undefined
}

function styleRelevantPartPaths(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((item) => /^word\/document\.xml$|^word\/(?:header|footer)\d+\.xml$|^word\/(?:footnotes|endnotes)\.xml$/i.test(item))
    .sort()
}

function paragraphStyleId(paragraphXml: string) {
  return paragraphXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1]
}

function hasDirectParagraphFormatting(paragraphXml: string) {
  const properties = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  return /<w:(?:spacing|ind)\b/.test(properties)
}

function hasDirectRunFormatting(runXml: string) {
  const properties = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return /<w:(?:rFonts|b|bCs|i|iCs|u|color|sz|szCs)\b/.test(properties)
}

function looksLikeHeadingWithoutHeadingStyle(paragraphXml: string, text: string, styleId: string | undefined) {
  if (!text || text.length > 80) return false
  if (/[.;:。；：]$/.test(text)) return false
  if (isHeadingStyle(styleId)) return false
  return /<w:b(?:\s|\/|>)/.test(paragraphXml)
}

function isHeadingStyle(styleId: string | undefined) {
  return /^Heading[1-9]$/i.test(styleId ?? "")
}

function runFontName(runXml: string) {
  const rFonts = runXml.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? ""
  return rFonts.match(/w:ascii="([^"]+)"/)?.[1]
    ?? rFonts.match(/w:hAnsi="([^"]+)"/)?.[1]
    ?? rFonts.match(/w:eastAsia="([^"]+)"/)?.[1]
}

const RUN_FORMATTING_TAGS: Array<{ kind: WordRunFormattingKind; tags: string[] }> = [
  { kind: "font", tags: ["rFonts"] },
  { kind: "bold", tags: ["b", "bCs"] },
  { kind: "italic", tags: ["i", "iCs"] },
  { kind: "underline", tags: ["u"] },
  { kind: "color", tags: ["color"] },
  { kind: "size", tags: ["sz", "szCs"] },
]

function normalizePreserveRunFormatting(input: WordRunFormattingKind[] | undefined) {
  const allowed = new Set(RUN_FORMATTING_TAGS.map((item) => item.kind))
  return [...new Set((input ?? []).filter((item): item is WordRunFormattingKind => allowed.has(item)))].sort()
}

function clearRunDirectFormatting(runPropertiesXml: string, preserveRunFormatting: Set<WordRunFormattingKind>) {
  let body = runPropertiesXml.replace(/^<w:rPr\b[^>]*>/, "").replace(/<\/w:rPr>$/, "")
  for (const group of RUN_FORMATTING_TAGS) {
    if (preserveRunFormatting.has(group.kind)) continue
    for (const tag of group.tags) {
      body = body.replace(new RegExp(`<w:${tag}\\b[^>]*/>`, "g"), "")
      body = body.replace(new RegExp(`<w:${tag}\\b[^>]*>[\\s\\S]*?</w:${tag}>`, "g"), "")
    }
  }
  return body.trim() ? `<w:rPr>${body}</w:rPr>` : ""
}

function clearParagraphDirectFormatting(paragraphXml: string) {
  return paragraphXml.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/, (propertiesXml) => {
    let body = propertiesXml.replace(/^<w:pPr\b[^>]*>/, "").replace(/<\/w:pPr>$/, "")
    for (const tag of ["spacing", "ind"]) {
      body = body.replace(new RegExp(`<w:${tag}\\b[^>]*/>`, "g"), "")
      body = body.replace(new RegExp(`<w:${tag}\\b[^>]*>[\\s\\S]*?</w:${tag}>`, "g"), "")
    }
    return `<w:pPr>${body}</w:pPr>`
  })
}

function enforceParagraphSpacing(paragraphXml: string, spaceAfterTwips: number) {
  const spacingXml = `<w:spacing w:after="${spaceAfterTwips}"/>`
  if (paragraphXml.includes("<w:pPr")) {
    return paragraphXml.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/, (propertiesXml) => {
      if (/<w:spacing\b[^>]*\/>/.test(propertiesXml)) return propertiesXml.replace(/<w:spacing\b[^>]*\/>/, spacingXml)
      return propertiesXml.replace("</w:pPr>", `${spacingXml}</w:pPr>`)
    })
  }
  return paragraphXml.replace(/<w:p\b[^>]*>/, (openTag) => `${openTag}<w:pPr>${spacingXml}</w:pPr>`)
}

function positiveTwips(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}
