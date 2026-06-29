import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { DocxFileStore } from "./DocxFileStore"
import { DocxRenderQualityGate } from "./DocxRenderQualityGate"
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

export type WordFieldReport = {
  inputPath: string
  fieldCount: number
  fieldTypeCounts: Record<string, number>
  fieldsByPart: Record<string, Array<{ type: string; instruction: string }>>
  examples: Array<{ partPath: string; type: string; instruction: string }>
  staleFieldHints: string[]
  unsupportedMaterialization: string[]
}

export type WordRefFieldFlattenResult = {
  path: string
  absolutePath: string
  sourcePath: string
  beforeReport: WordFieldReport
  afterReport: WordFieldReport
  flattenedFields: number
  touchedParts: string[]
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

export type WordSeqFieldMaterializeResult = {
  path: string
  absolutePath: string
  sourcePath: string
  beforeReport: WordFieldReport
  afterReport: WordFieldReport
  materializedFields: number
  updatedFields: number
  touchedParts: string[]
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

export type WordNativeFieldRefreshResult = {
  path: string
  absolutePath: string
  sourcePath: string
  refreshMode: "libreoffice-saved-docx" | "preserved-live-fields-render-verified"
  beforeReport: WordFieldReport
  preparedReport: WordFieldReport
  afterReport: WordFieldReport
  refreshedFieldTypes: string[]
  touchedParts: string[]
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

const FIELD_UPDATE_SENSITIVE_TYPES = new Set(["TOC", "REF", "PAGEREF", "NUMPAGES", "PAGE", "SEQ"])
const UNSUPPORTED_HEADLESS_TYPES = new Set(["TOC", "NUMPAGES", "PAGE"])
const WORD_NATIVE_REFRESH_TYPES = new Set(["TOC", "PAGE", "NUMPAGES"])

export class WordRefFieldFlattener {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async flatten(input: {
    path: string
    bytes: Uint8Array
    outputFilenameBase?: string
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<WordRefFieldFlattenResult> {
    input.signal?.throwIfAborted()
    const flattened = await flattenRefFieldsInDocxBytes(input.bytes, input.path)
    const structureIssues = await new DocxRenderQualityGate().check(flattened.bytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`REF-field-flattened DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.path, ".docx")}-ref-fields-flattened`,
      bytes: flattened.bytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: flattened.bytes,
      workspaceRoot: this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: 60_000,
      signal: input.signal,
      log: input.log,
    })
    const warnings = [
      ...flattened.warnings,
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      sourcePath: input.path,
      beforeReport: flattened.beforeReport,
      afterReport: flattened.afterReport,
      flattenedFields: flattened.flattenedFields,
      touchedParts: flattened.touchedParts,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export class WordSeqFieldMaterializer {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async materialize(input: {
    path: string
    bytes: Uint8Array
    outputFilenameBase?: string
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<WordSeqFieldMaterializeResult> {
    input.signal?.throwIfAborted()
    const materialized = await materializeSeqFieldsInDocxBytes(input.bytes, input.path)
    const structureIssues = await new DocxRenderQualityGate().check(materialized.bytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`SEQ-field-materialized DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.path, ".docx")}-seq-fields-materialized`,
      bytes: materialized.bytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: materialized.bytes,
      workspaceRoot: this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: 60_000,
      signal: input.signal,
      log: input.log,
    })
    const warnings = [
      ...materialized.warnings,
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      sourcePath: input.path,
      beforeReport: materialized.beforeReport,
      afterReport: materialized.afterReport,
      materializedFields: materialized.materializedFields,
      updatedFields: materialized.updatedFields,
      touchedParts: materialized.touchedParts,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export class WordNativeFieldRefresher {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async refresh(input: {
    path: string
    bytes: Uint8Array
    outputFilenameBase?: string
    timeoutMs?: number
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<WordNativeFieldRefreshResult> {
    input.signal?.throwIfAborted()
    const prepared = await prepareNativeFieldRefreshInDocxBytes(input.bytes, input.path)
    const libreOfficeBytes = await refreshDocxWithLibreOffice({
      bytes: prepared.bytes,
      filename: path.basename(input.path) || "word-native-fields.docx",
      timeoutMs: input.timeoutMs ?? 90_000,
      signal: input.signal,
      log: input.log,
    })
    const libreOfficeReport = await auditWordDocumentFields({ path: input.path, bytes: libreOfficeBytes })
    const expectedNativeFieldTypes = Object.keys(prepared.preparedReport.fieldTypeCounts)
      .filter((type) => WORD_NATIVE_REFRESH_TYPES.has(type))
      .sort()
    const strippedNativeFieldTypes = expectedNativeFieldTypes.filter((type) =>
      (libreOfficeReport.fieldTypeCounts[type] ?? 0) < (prepared.preparedReport.fieldTypeCounts[type] ?? 0))
    const refreshMode: WordNativeFieldRefreshResult["refreshMode"] = strippedNativeFieldTypes.length
      ? "preserved-live-fields-render-verified"
      : "libreoffice-saved-docx"
    const outputBytes = refreshMode === "libreoffice-saved-docx" ? libreOfficeBytes : prepared.bytes
    const afterReport = refreshMode === "libreoffice-saved-docx" ? libreOfficeReport : prepared.preparedReport
    const structureIssues = await new DocxRenderQualityGate().check(outputBytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`Word-native-field-refreshed DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.path, ".docx")}-native-fields-refreshed`,
      bytes: outputBytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: outputBytes,
      workspaceRoot: this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: input.timeoutMs ?? 90_000,
      signal: input.signal,
      log: input.log,
    })
    const refreshedFieldTypes = Object.keys(prepared.beforeReport.fieldTypeCounts)
      .filter((type) => WORD_NATIVE_REFRESH_TYPES.has(type))
      .sort()
    const warnings = [
      ...prepared.warnings,
      ...(refreshedFieldTypes.length ? [] : ["No TOC/PAGE/NUMPAGES fields were found for Word-native refresh."]),
      ...(strippedNativeFieldTypes.length
        ? [`LibreOffice saved DOCX removed live native field(s) ${strippedNativeFieldTypes.join(", ")}; kept the preserved live-field DOCX with updateFields enabled and render verification evidence instead.`]
        : []),
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    if (!renderCheckResult.attempted || !(renderCheckResult.pagePngPaths?.length)) {
      warnings.push("Word-native field refresh created a DOCX copy, but render verification did not produce page PNG evidence.")
    }
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      sourcePath: input.path,
      refreshMode,
      beforeReport: prepared.beforeReport,
      preparedReport: prepared.preparedReport,
      afterReport,
      refreshedFieldTypes,
      touchedParts: prepared.touchedParts,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export async function auditWordDocumentFields(input: { path: string; bytes: Uint8Array }): Promise<WordFieldReport> {
  const zip = await loadZip(input.bytes)
  const fieldTypeCounts = new Map<string, number>()
  const fieldsByPart: WordFieldReport["fieldsByPart"] = {}
  const examples: WordFieldReport["examples"] = []

  for (const partPath of fieldRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    const fields = extractFieldInstructions(xml).map((instruction) => ({
      type: fieldType(instruction),
      instruction,
    }))
    if (!fields.length) continue
    fieldsByPart[partPath] = fields
    for (const field of fields) {
      fieldTypeCounts.set(field.type, (fieldTypeCounts.get(field.type) ?? 0) + 1)
      if (examples.length < 12) examples.push({ partPath, type: field.type, instruction: field.instruction.slice(0, 240) })
    }
  }

  const fieldCount = [...fieldTypeCounts.values()].reduce((sum, value) => sum + value, 0)
  const presentTypes = new Set(fieldTypeCounts.keys())
  const staleFieldHints = [...presentTypes].some((type) => FIELD_UPDATE_SENSITIVE_TYPES.has(type))
    ? ["Document contains fields that can render stale in DOCX->PDF/PNG flows. Use refresh_word_native_fields for TOC/PAGE/NUMPAGES, flatten REF/PAGEREF cached results when deterministic screenshots are enough, or materialize SEQ cached numbers for captions."]
    : []
  const unsupportedMaterialization = [...presentTypes]
    .filter((type) => UNSUPPORTED_HEADLESS_TYPES.has(type))
    .map((type) => `${type} requires Word-native layout/TOC recalculation; use refresh_word_native_fields with local LibreOffice rather than REF/SEQ materialization.`)

  return {
    inputPath: input.path,
    fieldCount,
    fieldTypeCounts: Object.fromEntries([...fieldTypeCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    fieldsByPart,
    examples,
    staleFieldHints,
    unsupportedMaterialization,
  }
}

export async function flattenRefFieldsInDocxBytes(bytes: Uint8Array, pathLabel: string): Promise<{
  bytes: Uint8Array
  beforeReport: WordFieldReport
  afterReport: WordFieldReport
  flattenedFields: number
  touchedParts: string[]
  warnings: string[]
}> {
  const beforeReport = await auditWordDocumentFields({ path: pathLabel, bytes })
  const zip = await loadZip(bytes)
  let flattenedFields = 0
  const touchedParts: string[] = []
  for (const partPath of fieldRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    const flattened = flattenRefFieldsInXmlPart(xml)
    flattenedFields += flattened.count
    if (flattened.xml !== xml) {
      zip.file(partPath, flattened.xml)
      touchedParts.push(partPath)
    }
  }
  const nextBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const afterReport = await auditWordDocumentFields({ path: pathLabel, bytes: nextBytes })
  const warnings = flattenedFields === 0
    ? ["No REF/PAGEREF fields with cached visible text were flattened."]
    : []
  if (beforeReport.unsupportedMaterialization.length) warnings.push(...beforeReport.unsupportedMaterialization)
  return { bytes: nextBytes, beforeReport, afterReport, flattenedFields, touchedParts, warnings }
}

export async function materializeSeqFieldsInDocxBytes(bytes: Uint8Array, pathLabel: string): Promise<{
  bytes: Uint8Array
  beforeReport: WordFieldReport
  afterReport: WordFieldReport
  materializedFields: number
  updatedFields: number
  touchedParts: string[]
  warnings: string[]
}> {
  const beforeReport = await auditWordDocumentFields({ path: pathLabel, bytes })
  const zip = await loadZip(bytes)
  const countsBySequence = new Map<string, number>()
  let materializedFields = 0
  let updatedFields = 0
  const touchedParts: string[] = []
  for (const partPath of fieldRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    const materialized = materializeSeqFieldsInXmlPart(xml, countsBySequence)
    materializedFields += materialized.materializedFields
    updatedFields += materialized.updatedFields
    if (materialized.xml !== xml) {
      zip.file(partPath, materialized.xml)
      touchedParts.push(partPath)
    }
  }
  const nextBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const afterReport = await auditWordDocumentFields({ path: pathLabel, bytes: nextBytes })
  const warnings = materializedFields === 0
    ? ["No complex SEQ fields with cached visible text were materialized."]
    : []
  if (beforeReport.unsupportedMaterialization.length) warnings.push(...beforeReport.unsupportedMaterialization)
  return { bytes: nextBytes, beforeReport, afterReport, materializedFields, updatedFields, touchedParts, warnings }
}

export async function prepareNativeFieldRefreshInDocxBytes(bytes: Uint8Array, pathLabel: string): Promise<{
  bytes: Uint8Array
  beforeReport: WordFieldReport
  preparedReport: WordFieldReport
  touchedParts: string[]
  warnings: string[]
}> {
  const beforeReport = await auditWordDocumentFields({ path: pathLabel, bytes })
  const zip = await loadZip(bytes)
  const touchedParts: string[] = []

  for (const partPath of fieldRelevantPartPaths(zip)) {
    const xml = await readZipText(zip, partPath)
    if (!xml) continue
    const next = markNativeFieldRefreshDirtyInXmlPart(xml)
    if (next !== xml) {
      zip.file(partPath, next)
      touchedParts.push(partPath)
    }
  }

  const settingsXml = await readZipText(zip, "word/settings.xml")
  const nextSettingsXml = ensureUpdateFieldsSetting(settingsXml)
  if (nextSettingsXml !== settingsXml) {
    zip.file("word/settings.xml", nextSettingsXml)
    touchedParts.push("word/settings.xml")
  }

  const contentTypes = await readZipText(zip, "[Content_Types].xml")
  if (contentTypes) {
    const nextContentTypes = ensureSettingsContentType(contentTypes)
    if (nextContentTypes !== contentTypes) {
      zip.file("[Content_Types].xml", nextContentTypes)
      touchedParts.push("[Content_Types].xml")
    }
  }

  const rels = await readZipText(zip, "word/_rels/document.xml.rels")
  if (rels) {
    const nextRels = ensureSettingsRelationship(rels)
    if (nextRels !== rels) {
      zip.file("word/_rels/document.xml.rels", nextRels)
      touchedParts.push("word/_rels/document.xml.rels")
    }
  }

  const nextBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const preparedReport = await auditWordDocumentFields({ path: pathLabel, bytes: nextBytes })
  const nativeCount = ["TOC", "PAGE", "NUMPAGES"].reduce((sum, type) => sum + (beforeReport.fieldTypeCounts[type] ?? 0), 0)
  const warnings = nativeCount === 0 ? ["No TOC/PAGE/NUMPAGES fields were found for Word-native refresh."] : []
  return { bytes: nextBytes, beforeReport, preparedReport, touchedParts: [...new Set(touchedParts)], warnings }
}

function extractFieldInstructions(xml: string) {
  const instructions: string[] = []
  for (const tag of xml.match(/<w:fldSimple\b[^>]*\/>|<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/g) ?? []) {
    const instruction = xmlAttribute(tag, "instr")
    if (instruction) instructions.push(normalizeInstruction(instruction))
  }
  for (const block of complexFieldBlocks(xml)) {
    const instruction = instrTextFrom(block)
    if (instruction) instructions.push(normalizeInstruction(instruction))
  }
  return instructions.filter(Boolean)
}

function complexFieldBlocks(xml: string) {
  return xml.match(/<w:r\b[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>[\s\S]*?<\/w:r>[\s\S]*?<w:r\b[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>[\s\S]*?<\/w:r>/g) ?? []
}

function flattenRefFieldsInXmlPart(xml: string) {
  let count = 0
  const next = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) =>
    flattenRefFieldsInParagraph(paragraphXml, () => {
      count += 1
    }))
  return { xml: next, count }
}

function flattenRefFieldsInParagraph(paragraphXml: string, onFlatten: () => void) {
  const runs = paragraphXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []
  if (!runs.length) return paragraphXml
  const replacements: Array<{ oldXml: string; newXml: string }> = []
  for (let index = 0; index < runs.length; index += 1) {
    if (!isFieldRun(runs[index]!, "begin")) continue
    let separateIndex = -1
    let endIndex = -1
    for (let cursor = index + 1; cursor < runs.length; cursor += 1) {
      if (isFieldRun(runs[cursor]!, "separate")) separateIndex = cursor
      if (isFieldRun(runs[cursor]!, "end")) {
        endIndex = cursor
        break
      }
    }
    if (separateIndex < 0 || endIndex < 0 || separateIndex >= endIndex) continue
    const instruction = normalizeInstruction(instrTextFrom(runs.slice(index, separateIndex + 1).join("")))
    if (!/\b(?:PAGEREF|REF)\b/i.test(instruction)) continue
    const visible = xmlTextFrom(runs.slice(separateIndex + 1, endIndex).join(""))
    if (!visible.trim()) continue
    replacements.push({
      oldXml: runs.slice(index, endIndex + 1).join(""),
      newXml: `<w:r>${textRuns(visible)}</w:r>`,
    })
    onFlatten()
    index = endIndex
  }
  let next = paragraphXml
  for (const replacement of replacements) {
    next = next.replace(replacement.oldXml, replacement.newXml)
  }
  return next
}

function materializeSeqFieldsInXmlPart(xml: string, countsBySequence: Map<string, number>) {
  let materializedFields = 0
  let updatedFields = 0
  const next = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) =>
    materializeSeqFieldsInParagraph(paragraphXml, countsBySequence, (updated) => {
      materializedFields += 1
      if (updated) updatedFields += 1
    }))
  return { xml: next, materializedFields, updatedFields }
}

function materializeSeqFieldsInParagraph(paragraphXml: string, countsBySequence: Map<string, number>, onMaterialize: (updated: boolean) => void) {
  const runs = paragraphXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []
  if (!runs.length) return paragraphXml
  const replacements: Array<{ oldXml: string; newXml: string }> = []
  for (let index = 0; index < runs.length; index += 1) {
    if (!isFieldRun(runs[index]!, "begin")) continue
    let separateIndex = -1
    let endIndex = -1
    for (let cursor = index + 1; cursor < runs.length; cursor += 1) {
      if (isFieldRun(runs[cursor]!, "separate")) separateIndex = cursor
      if (isFieldRun(runs[cursor]!, "end")) {
        endIndex = cursor
        break
      }
    }
    if (separateIndex < 0 || endIndex < 0 || separateIndex >= endIndex) continue
    const instruction = normalizeInstruction(instrTextFrom(runs.slice(index, separateIndex + 1).join("")))
    const sequenceLabel = seqLabel(instruction)
    if (!sequenceLabel) continue
    const nextNumber = nextSeqNumber(instruction, sequenceLabel, countsBySequence)
    const visible = xmlTextFrom(runs.slice(separateIndex + 1, endIndex).join("")).trim()
    if (!visible) continue
    const nextVisible = String(nextNumber)
    const updated = visible !== nextVisible
    if (updated) {
      replacements.push({
        oldXml: runs.slice(separateIndex + 1, endIndex).join(""),
        newXml: `<w:r>${textRuns(nextVisible)}</w:r>`,
      })
    }
    onMaterialize(updated)
    index = endIndex
  }
  let next = paragraphXml
  for (const replacement of replacements) {
    next = next.replace(replacement.oldXml, replacement.newXml)
  }
  return next
}

function markNativeFieldRefreshDirtyInXmlPart(xml: string) {
  let next = xml.replace(/<w:fldSimple\b([^>]*\bw:instr="[^"]*\b(?:TOC|PAGE|NUMPAGES)\b[^"]*"[^>]*)>/gi, (tag, attrs: string) => {
    if (/\bw:dirty=/.test(attrs)) return tag
    return `<w:fldSimple${attrs} w:dirty="true">`
  })
  if (/\b(?:TOC|PAGE|NUMPAGES)\b/i.test(instrTextFrom(xml))) {
    next = next.replace(/<w:fldChar\b([^>]*\bw:fldCharType="begin"[^>]*)\/>/gi, (tag, attrs: string) => {
      if (/\bw:dirty=/.test(attrs)) return tag
      return `<w:fldChar${attrs} w:dirty="true"/>`
    })
  }
  return next
}

function ensureUpdateFieldsSetting(xml: string | undefined) {
  if (!xml) {
    return [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:updateFields w:val="true"/>',
      "</w:settings>",
    ].join("")
  }
  if (/<w:updateFields\b/i.test(xml)) {
    return xml.replace(/<w:updateFields\b[^>]*\/>/i, '<w:updateFields w:val="true"/>')
  }
  return xml.replace(/<w:settings\b[^>]*>/i, (open) => `${open}<w:updateFields w:val="true"/>`)
}

function ensureSettingsContentType(xml: string) {
  if (/PartName="\/word\/settings\.xml"/i.test(xml)) return xml
  return xml.replace("</Types>", '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>')
}

function ensureSettingsRelationship(xml: string) {
  if (/Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/settings"/i.test(xml)) return xml
  const relId = nextRelationshipId(xml, "rIdSettings")
  return xml.replace("</Relationships>", `<Relationship Id="${xmlAttr(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`)
}

function nextRelationshipId(xml: string, preferred: string) {
  if (!new RegExp(`Id="${preferred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(xml)) return preferred
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value))
  return `rId${Math.max(1, ...ids) + 1}`
}

async function refreshDocxWithLibreOffice(input: {
  bytes: Uint8Array
  filename: string
  timeoutMs: number
  signal?: AbortSignal
  log?: (message: string) => void
}) {
  const safeFilename = input.filename.toLowerCase().endsWith(".docx") ? input.filename : `${input.filename}.docx`
  const errors: string[] = []
  for (const command of sofficeCandidates()) {
    input.signal?.throwIfAborted()
    const tempRoot = await mkdtemp(path.join(tmpdir(), "chipmate-word-field-refresh-"))
    const inDir = path.join(tempRoot, "in")
    const outDir = path.join(tempRoot, "out")
    const profileDir = path.join(tempRoot, "lo-profile")
    const homeDir = path.join(tempRoot, "home")
    try {
      await mkdir(inDir, { recursive: true })
      await mkdir(outDir, { recursive: true })
      await mkdir(profileDir, { recursive: true })
      await mkdir(homeDir, { recursive: true })
      const inputPath = path.join(inDir, safeFilename)
      await writeFile(inputPath, Buffer.from(input.bytes))
      const result = await runSofficeDocxRefresh(command, inputPath, outDir, profileDir, homeDir, input.timeoutMs, input.signal)
      if (!result.ok) {
        errors.push(`${command}: ${result.message}`)
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      const outputPath = path.join(outDir, safeFilename)
      const outputStat = await stat(outputPath).catch(() => undefined)
      if (!outputStat || outputStat.size <= 0) {
        errors.push(`${command}: converted DOCX was not produced`)
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      const bytes = await readFile(outputPath)
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
      input.log?.(`[word-fields] refreshed native fields through ${command}`)
      return bytes
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
      if (input.signal?.aborted) throw error
      errors.push(`${command}: ${formatError(error)}`)
    }
  }
  throw new Error(`LibreOffice native field refresh failed or is unavailable: ${errors.length ? errors.join(" | ") : "no soffice candidate succeeded"}`)
}

function sofficeCandidates() {
  const bundledSoffice = process.env.HOME
    ? path.join(process.env.HOME, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "bin", "soffice")
    : undefined
  return unique([
    process.env.CHIPMATE_SOFFICE_PATH,
    bundledSoffice,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "soffice",
    "libreoffice",
  ].filter((item): item is string => Boolean(item)))
}

async function runSofficeDocxRefresh(command: string, docxPath: string, outDir: string, profileDir: string, homeDir: string, timeoutMs: number, signal?: AbortSignal) {
  return await runCommand(command, [
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    `-env:UserInstallation=file://${profileDir}`,
    "--convert-to",
    "docx",
    "--outdir",
    outDir,
    docxPath,
  ], timeoutMs, signal, { HOME: homeDir })
}

async function runCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>) {
  return await new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, message: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    const abort = () => {
      clearTimeout(timer)
      child.kill("SIGKILL")
      reject(new Error("refresh_word_native_fields aborted"))
    }
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve({ ok: false, message: error.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve({ ok: code === 0, message: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `exit ${code}` })
    })
  })
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function seqLabel(instruction: string) {
  return instruction.match(/\bSEQ\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]
}

function nextSeqNumber(instruction: string, sequenceLabel: string, countsBySequence: Map<string, number>) {
  const reset = instruction.match(/\\r\s+(-?\d+)/i)?.[1]
  if (reset) {
    const value = Number(reset)
    countsBySequence.set(sequenceLabel, value)
    return value
  }
  if (/\\c\b/i.test(instruction)) {
    return countsBySequence.get(sequenceLabel) ?? 0
  }
  const value = (countsBySequence.get(sequenceLabel) ?? 0) + 1
  countsBySequence.set(sequenceLabel, value)
  return value
}

function isFieldRun(runXml: string, type: "begin" | "separate" | "end") {
  return new RegExp(`<w:fldChar\\b[^>]*w:fldCharType="${type}"[^>]*/>`).test(runXml)
}

async function loadZip(bytes: Uint8Array) {
  const JSZip = nodeRequire("jszip") as JsZipModule
  return await JSZip.loadAsync(Buffer.from(bytes)) as ZipArchive
}

async function readZipText(zip: ZipArchive, partPath: string) {
  const part = zip.file(partPath)
  return part ? await part.async("string") : undefined
}

function fieldRelevantPartPaths(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((item) => /^word\/document\.xml$|^word\/(?:header|footer)\d+\.xml$|^word\/(?:footnotes|endnotes)\.xml$/i.test(item))
    .sort()
}

function instrTextFrom(xml: string) {
  return (xml.match(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g) ?? [])
    .map((tag) => decodeXml(tag.replace(/^<w:instrText\b[^>]*>/, "").replace(/<\/w:instrText>$/, "")))
    .join("")
}

function fieldType(instruction: string) {
  const value = normalizeInstruction(instruction)
  return value.split(/\s+/)[0]?.toUpperCase() || "(empty)"
}

function normalizeInstruction(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function xmlAttribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = tag.match(new RegExp(`(?:^|\\s)(?:w:)?${escaped}="([^"]*)"`))
  return match ? decodeXml(match[1] ?? "") : undefined
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function textRuns(text: string) {
  return text.split(/\r?\n/).map((line, index) => `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlText(line)}</w:t>`).join("")
}

function xmlText(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function xmlAttr(input: string) {
  return xmlText(input).replace(/"/g, "&quot;")
}

function decodeXml(input: string) {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}
