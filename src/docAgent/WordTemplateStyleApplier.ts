import { createRequire } from "node:module"
import * as path from "node:path"
import { DocxFileStore } from "./DocxFileStore"
import { DocxRenderQualityGate } from "./DocxRenderQualityGate"
import { renderWordDocument } from "./WordRenderQualityGate"
import type { WordEditRenderCheckResult, WordEditStructureCheckResult } from "./types"

const nodeRequire = createRequire(__filename)

type JsZipModule = typeof import("jszip")
type ZipEntry = {
  dir?: boolean
  async(type: "string" | "nodebuffer"): Promise<string | Buffer>
}
type ZipArchive = {
  file(path: string): ZipEntry | null
  file(path: string, data: string | Uint8Array | Buffer): void
  files: Record<string, ZipEntry>
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

type Relationship = {
  id: string
  type: string
  target: string
  targetMode?: string
}

export type WordTemplateStyleApplyAudit = {
  styleStrategy: {
    strategy: "replace-all" | "selective-allowlist"
    requestedStyleIds: string[]
    appliedStyleIds: string[]
    missingStyleIds: string[]
    conflictingStyleIds: string[]
    templateOnlyStyleIds: string[]
    targetOnlyStyleIds: string[]
    expandedDependencyStyleIds: string[]
  }
  numberingStrategy: {
    strategy: "replace-all"
    conflictingNumIds: string[]
    templateOnlyNumIds: string[]
    targetOnlyNumIds: string[]
    conflictingAbstractNumIds: string[]
  }
  relationshipStrategy: {
    copiedRelationshipParts: string[]
    copiedMediaParts: string[]
    skippedTemplateRelationshipParts: string[]
    unsupportedRelationships: Array<{
      sourcePart: string
      relId: string
      type: string
      target: string
      targetMode?: string
    }>
  }
}

export type WordTemplateStyleApplyResult = {
  path: string
  absolutePath: string
  targetPath: string
  templatePath: string
  copiedParts: string[]
  skippedParts: string[]
  templateAudit: WordTemplateStyleApplyAudit
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

type TemplatePart = {
  path: string
  required?: boolean
  contentType?: string
}

const TEMPLATE_STYLE_PARTS: TemplatePart[] = [
  { path: "word/styles.xml", required: true },
  { path: "word/theme/theme1.xml", contentType: "application/vnd.openxmlformats-officedocument.theme+xml" },
  { path: "word/fontTable.xml", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml" },
  { path: "word/numbering.xml", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml" },
]

const IMAGE_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

export class WordTemplateStyleApplier {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async apply(input: {
    target: { path: string; bytes: Uint8Array }
    template: { path: string; bytes: Uint8Array }
    outputFilenameBase?: string
    styleAllowlist?: string[]
    signal?: AbortSignal
    log?: (message: string) => void
    remoteEndpoint?: string
  }): Promise<WordTemplateStyleApplyResult> {
    input.signal?.throwIfAborted()
    const applied = await applyTemplateStylesToDocxBytes(input)
    const structureIssues = await new DocxRenderQualityGate().check(applied.bytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`Template-styled DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.target.path, ".docx")}-template-styled`,
      bytes: applied.bytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: applied.bytes,
      workspaceRoot: this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: 60_000,
      signal: input.signal,
      log: input.log,
      remoteEndpoint: input.remoteEndpoint,
    })
    const warnings = [
      ...applied.warnings,
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      targetPath: input.target.path,
      templatePath: input.template.path,
      copiedParts: applied.copiedParts,
      skippedParts: applied.skippedParts,
      templateAudit: applied.templateAudit,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export async function applyTemplateStylesToDocxBytes(input: {
  target: { path: string; bytes: Uint8Array }
  template: { path: string; bytes: Uint8Array }
  styleAllowlist?: string[]
}): Promise<{
  bytes: Uint8Array
  copiedParts: string[]
  skippedParts: string[]
  templateAudit: WordTemplateStyleApplyAudit
  warnings: string[]
}> {
  const JSZip = nodeRequire("jszip") as JsZipModule
  const targetZip = await JSZip.loadAsync(Buffer.from(input.target.bytes)) as ZipArchive
  const templateZip = await JSZip.loadAsync(Buffer.from(input.template.bytes)) as ZipArchive
  const copiedParts: string[] = []
  const skippedParts: string[] = []
  const overrides = new Map<string, Buffer>()
  const styleAllowlist = normalizedStyleAllowlist(input.styleAllowlist)

  for (const part of TEMPLATE_STYLE_PARTS) {
    const entry = templateZip.file(part.path)
    if (!entry) {
      skippedParts.push(part.path)
      if (part.required) throw new Error(`Template DOCX/DOTX is missing required style part: ${part.path}`)
      continue
    }
    if (part.path === "word/styles.xml" && styleAllowlist.length) {
      const targetStylesXml = await readZipText(targetZip, part.path)
      const templateStylesXml = await entry.async("string") as string
      overrides.set(part.path, Buffer.from(selectiveStylesXml(targetStylesXml, templateStylesXml, styleAllowlist).xml))
    } else {
      overrides.set(part.path, await entry.async("nodebuffer") as Buffer)
    }
    copiedParts.push(part.path)
  }

  if (!targetZip.file("[Content_Types].xml")) {
    throw new Error(`Target DOCX is missing [Content_Types].xml: ${input.target.path}`)
  }
  let contentTypesXml = await readZipText(targetZip, "[Content_Types].xml")
  const templateContentTypesXml = await readZipText(templateZip, "[Content_Types].xml")
  for (const part of TEMPLATE_STYLE_PARTS) {
    if (!part.contentType || !overrides.has(part.path)) continue
    contentTypesXml = ensureContentTypeOverride(contentTypesXml, `/${part.path}`, part.contentType)
  }

  for (const [partPath, bytes] of overrides.entries()) {
    targetZip.file(partPath, bytes)
  }
  const relationshipMerge = await copyRelationshipsForTemplateParts({
    targetZip,
    templateZip,
    templateContentTypesXml,
    targetContentTypesXml: contentTypesXml,
    copiedPartXmlByPath: await copiedPartXmlByPath(overrides),
  })
  contentTypesXml = relationshipMerge.contentTypesXml
  targetZip.file("[Content_Types].xml", contentTypesXml)
  const templateAudit = await auditTemplateStyleApplication({
    targetZip: await JSZip.loadAsync(Buffer.from(input.target.bytes)) as ZipArchive,
    templateZip,
    copiedPartXmlByPath: await copiedPartXmlByPath(overrides),
    styleAllowlist,
    relationshipMerge,
  })
  return {
    bytes: await targetZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    copiedParts,
    skippedParts,
    templateAudit,
    warnings: templateStyleWarnings(skippedParts, templateAudit),
  }
}

async function readZipText(zip: ZipArchive, partPath: string) {
  const part = zip.file(partPath)
  if (!part) throw new Error(`DOCX is missing required part: ${partPath}`)
  return await part.async("string") as string
}

async function readZipTextOptional(zip: ZipArchive, partPath: string): Promise<string | undefined> {
  const value = await zip.file(partPath)?.async("string")
  if (typeof value === "string") return value
  return value?.toString("utf8")
}

async function copiedPartXmlByPath(overrides: Map<string, Buffer>) {
  const values = new Map<string, string>()
  for (const [partPath, bytes] of overrides.entries()) {
    if (partPath.endsWith(".xml")) values.set(partPath, bytes.toString("utf8"))
  }
  return values
}

function normalizedStyleAllowlist(styleAllowlist?: string[]) {
  return [...new Set((styleAllowlist ?? []).map((item) => item.trim()).filter(Boolean))].sort()
}

function selectiveStylesXml(targetStylesXml: string, templateStylesXml: string, requestedStyleIds: string[]) {
  const targetStyles = parseStyleDefinitions(targetStylesXml)
  const templateStyles = parseStyleDefinitions(templateStylesXml)
  const selected = expandStyleDependencies(templateStyles, requestedStyleIds)
  const missingStyleIds = requestedStyleIds.filter((styleId) => !templateStyles.has(styleId)).sort()
  let nextXml = targetStylesXml
  for (const styleId of selected) {
    const templateStyle = templateStyles.get(styleId)
    if (!templateStyle) continue
    const existing = targetStyles.get(styleId)
    if (existing) {
      nextXml = nextXml.replace(existing.xml, templateStyle.xml)
    } else {
      nextXml = nextXml.replace("</w:styles>", `${templateStyle.xml}</w:styles>`)
    }
  }
  return { xml: nextXml, selectedStyleIds: selected, missingStyleIds }
}

function expandStyleDependencies(styles: Map<string, ParsedStyleDefinition>, requestedStyleIds: string[]) {
  const selected = new Set<string>()
  const visit = (styleId: string) => {
    if (selected.has(styleId)) return
    const style = styles.get(styleId)
    if (!style) return
    selected.add(styleId)
    for (const dependency of style.dependencies) visit(dependency)
  }
  for (const styleId of requestedStyleIds) visit(styleId)
  return [...selected].sort()
}

type ParsedStyleDefinition = {
  xml: string
  dependencies: string[]
}

function parseStyleDefinitions(stylesXml: string) {
  const styles = new Map<string, ParsedStyleDefinition>()
  for (const match of stylesXml.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)) {
    const xml = match[0]
    const styleId = xml.match(/\bw:styleId="([^"]+)"/)?.[1]
    if (!styleId) continue
    const dependencies = [...xml.matchAll(/<w:(?:basedOn|next|link)\b[^>]*\bw:val="([^"]+)"/g)].map((item) => item[1]).filter(Boolean)
    styles.set(styleId, { xml, dependencies })
  }
  return styles
}

function parseNumberingDefinitions(numberingXml: string, tag: "num" | "abstractNum", idAttribute: "numId" | "abstractNumId") {
  const definitions = new Map<string, string>()
  const pattern = new RegExp(`<w:${tag}\\b[\\s\\S]*?<\\/w:${tag}>`, "g")
  for (const match of numberingXml.matchAll(pattern)) {
    const xml = match[0]
    const id = xml.match(new RegExp(`\\bw:${idAttribute}="([^"]+)"`))?.[1]
    if (id) definitions.set(id, xml)
  }
  return definitions
}

async function auditTemplateStyleApplication(input: {
  targetZip: ZipArchive
  templateZip: ZipArchive
  copiedPartXmlByPath: Map<string, string>
  styleAllowlist: string[]
  relationshipMerge: TemplateRelationshipMergeResult
}): Promise<WordTemplateStyleApplyAudit> {
  const targetStylesXml = await readZipTextOptional(input.targetZip, "word/styles.xml") ?? ""
  const templateStylesXml = await readZipText(input.templateZip, "word/styles.xml")
  const targetStyles = parseStyleDefinitions(targetStylesXml)
  const templateStyles = parseStyleDefinitions(templateStylesXml)
  const requestedStyleIds = input.styleAllowlist
  const appliedStyleIds = requestedStyleIds.length ? expandStyleDependencies(templateStyles, requestedStyleIds) : [...templateStyles.keys()].sort()
  const missingStyleIds = requestedStyleIds.filter((styleId) => !templateStyles.has(styleId)).sort()
  const expandedDependencyStyleIds = appliedStyleIds.filter((styleId) => !requestedStyleIds.includes(styleId)).sort()
  const conflictingStyleIds = appliedStyleIds.filter((styleId) => {
    const targetStyle = targetStyles.get(styleId)
    const templateStyle = templateStyles.get(styleId)
    return Boolean(targetStyle && templateStyle && targetStyle.xml !== templateStyle.xml)
  }).sort()
  const templateOnlyStyleIds = appliedStyleIds.filter((styleId) => templateStyles.has(styleId) && !targetStyles.has(styleId)).sort()
  const targetOnlyStyleIds = [...targetStyles.keys()].filter((styleId) => !templateStyles.has(styleId)).sort()

  const targetNumberingXml = await readZipTextOptional(input.targetZip, "word/numbering.xml") ?? ""
  const templateNumberingXml = input.copiedPartXmlByPath.get("word/numbering.xml") ?? await readZipTextOptional(input.templateZip, "word/numbering.xml") ?? ""
  const targetNums = parseNumberingDefinitions(targetNumberingXml, "num", "numId")
  const templateNums = parseNumberingDefinitions(templateNumberingXml, "num", "numId")
  const targetAbstractNums = parseNumberingDefinitions(targetNumberingXml, "abstractNum", "abstractNumId")
  const templateAbstractNums = parseNumberingDefinitions(templateNumberingXml, "abstractNum", "abstractNumId")

  return {
    styleStrategy: {
      strategy: requestedStyleIds.length ? "selective-allowlist" : "replace-all",
      requestedStyleIds,
      appliedStyleIds,
      missingStyleIds,
      conflictingStyleIds,
      templateOnlyStyleIds,
      targetOnlyStyleIds,
      expandedDependencyStyleIds,
    },
    numberingStrategy: {
      strategy: "replace-all",
      conflictingNumIds: [...templateNums.keys()].filter((numId) => targetNums.has(numId) && targetNums.get(numId) !== templateNums.get(numId)).sort(naturalSort),
      templateOnlyNumIds: [...templateNums.keys()].filter((numId) => !targetNums.has(numId)).sort(naturalSort),
      targetOnlyNumIds: [...targetNums.keys()].filter((numId) => !templateNums.has(numId)).sort(naturalSort),
      conflictingAbstractNumIds: [...templateAbstractNums.keys()].filter((numId) => targetAbstractNums.has(numId) && targetAbstractNums.get(numId) !== templateAbstractNums.get(numId)).sort(naturalSort),
    },
    relationshipStrategy: {
      copiedRelationshipParts: input.relationshipMerge.copiedRelationshipParts,
      copiedMediaParts: input.relationshipMerge.copiedMediaParts,
      skippedTemplateRelationshipParts: input.relationshipMerge.skippedTemplateRelationshipParts,
      unsupportedRelationships: input.relationshipMerge.unsupportedRelationships,
    },
  }
}

type TemplateRelationshipMergeResult = {
  contentTypesXml: string
  copiedRelationshipParts: string[]
  copiedMediaParts: string[]
  skippedTemplateRelationshipParts: string[]
  unsupportedRelationships: WordTemplateStyleApplyAudit["relationshipStrategy"]["unsupportedRelationships"]
}

async function copyRelationshipsForTemplateParts(input: {
  targetZip: ZipArchive
  templateZip: ZipArchive
  templateContentTypesXml: string
  targetContentTypesXml: string
  copiedPartXmlByPath: Map<string, string>
}): Promise<TemplateRelationshipMergeResult> {
  let contentTypesXml = input.targetContentTypesXml
  const copiedRelationshipParts: string[] = []
  const copiedMediaParts: string[] = []
  const skippedTemplateRelationshipParts: string[] = []
  const unsupportedRelationships: WordTemplateStyleApplyAudit["relationshipStrategy"]["unsupportedRelationships"] = []

  for (const [partPath, partXml] of input.copiedPartXmlByPath.entries()) {
    const referencedRelIds = referencedRelationshipIds(partXml)
    const relsPath = relsPathForPart(partPath)
    const templateRelsXml = await readZipTextOptional(input.templateZip, relsPath)
    if (!referencedRelIds.size) {
      if (templateRelsXml) skippedTemplateRelationshipParts.push(relsPath)
      continue
    }
    if (!templateRelsXml) {
      unsupportedRelationships.push(...[...referencedRelIds].map((relId) => ({
        sourcePart: partPath,
        relId,
        type: "missing-relationship-part",
        target: relsPath,
      })))
      continue
    }
    const relationships = parseRelationships(templateRelsXml).filter((relationship) => referencedRelIds.has(relationship.id))
    const missingRelIds = [...referencedRelIds].filter((relId) => !relationships.some((relationship) => relationship.id === relId))
    unsupportedRelationships.push(...missingRelIds.map((relId) => ({
      sourcePart: partPath,
      relId,
      type: "missing-relationship",
      target: relsPath,
    })))
    const copiedRelationships: Relationship[] = []
    for (const relationship of relationships) {
      if (relationship.type !== IMAGE_RELATIONSHIP_TYPE || relationship.targetMode === "External") {
        unsupportedRelationships.push({
          sourcePart: partPath,
          relId: relationship.id,
          type: relationship.type,
          target: relationship.target,
          targetMode: relationship.targetMode,
        })
        continue
      }
      const mediaPath = resolveRelationshipTargetPath(partPath, relationship.target)
      const mediaEntry = input.templateZip.file(mediaPath)
      if (!mediaEntry) {
        unsupportedRelationships.push({
          sourcePart: partPath,
          relId: relationship.id,
          type: "missing-media-part",
          target: relationship.target,
          targetMode: relationship.targetMode,
        })
        continue
      }
      input.targetZip.file(mediaPath, await mediaEntry.async("nodebuffer") as Buffer)
      contentTypesXml = ensureMediaContentType(contentTypesXml, input.templateContentTypesXml, mediaPath)
      copiedMediaParts.push(mediaPath)
      copiedRelationships.push(relationship)
    }
    if (copiedRelationships.length) {
      input.targetZip.file(relsPath, relationshipsXml(copiedRelationships))
      copiedRelationshipParts.push(relsPath)
    }
  }
  if (unsupportedRelationships.length) {
    throw new Error(`Template style application cannot safely copy referenced template relationship(s): ${unsupportedRelationships.map((item) => `${item.sourcePart}:${item.relId}:${relationshipTypeLabel(item.type)}->${item.target}`).join(", ")}`)
  }
  return {
    contentTypesXml,
    copiedRelationshipParts: [...new Set(copiedRelationshipParts)].sort(),
    copiedMediaParts: [...new Set(copiedMediaParts)].sort(),
    skippedTemplateRelationshipParts: [...new Set(skippedTemplateRelationshipParts)].sort(),
    unsupportedRelationships,
  }
}

function referencedRelationshipIds(xml: string) {
  const ids = new Set<string>()
  for (const match of xml.matchAll(/\br:(?:id|embed|link)="([^"]+)"/g)) {
    ids.add(match[1])
  }
  return ids
}

function parseRelationships(relsXml: string) {
  const relationships: Relationship[] = []
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = match[1]
    const id = attrs.match(/\bId="([^"]+)"/)?.[1]
    const type = attrs.match(/\bType="([^"]+)"/)?.[1]
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1]
    if (!id || !type || !target) continue
    relationships.push({
      id,
      type,
      target,
      targetMode: attrs.match(/\bTargetMode="([^"]+)"/)?.[1],
    })
  }
  return relationships
}

function relationshipsXml(relationships: Relationship[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...relationships.map((relationship) => `<Relationship Id="${xmlAttr(relationship.id)}" Type="${xmlAttr(relationship.type)}" Target="${xmlAttr(relationship.target)}"${relationship.targetMode ? ` TargetMode="${xmlAttr(relationship.targetMode)}"` : ""}/>`),
    "</Relationships>",
  ].join("")
}

function relsPathForPart(partPath: string) {
  const directory = path.posix.dirname(partPath)
  const basename = path.posix.basename(partPath)
  return path.posix.join(directory, "_rels", `${basename}.rels`)
}

function resolveRelationshipTargetPath(sourcePartPath: string, target: string) {
  if (target.startsWith("/")) return target.slice(1)
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePartPath), target))
}

function ensureMediaContentType(contentTypesXml: string, templateContentTypesXml: string, mediaPath: string) {
  const partName = `/${mediaPath}`
  const overrideType = contentTypeOverride(templateContentTypesXml, partName)
  if (overrideType) return ensureContentTypeOverride(contentTypesXml, partName, overrideType)
  const extension = path.posix.extname(mediaPath).slice(1)
  const defaultType = extension ? contentTypeDefault(templateContentTypesXml, extension) : undefined
  if (!extension || !defaultType || contentTypesXml.includes(`Extension="${extension}"`)) return contentTypesXml
  return contentTypesXml.replace("</Types>", `<Default Extension="${extension}" ContentType="${defaultType}"/></Types>`)
}

function contentTypeOverride(contentTypesXml: string, partName: string) {
  return contentTypesXml.match(new RegExp(`<Override\\b(?=[^>]*PartName="${escapeRegExp(partName)}")[^>]*ContentType="([^"]+)"[^>]*/>`))?.[1]
}

function contentTypeDefault(contentTypesXml: string, extension: string) {
  return contentTypesXml.match(new RegExp(`<Default\\b(?=[^>]*Extension="${escapeRegExp(extension)}")[^>]*ContentType="([^"]+)"[^>]*/>`))?.[1]
}

function templateStyleWarnings(skippedParts: string[], audit: WordTemplateStyleApplyAudit) {
  const warnings: string[] = []
  if (skippedParts.length) warnings.push(`Template did not contain optional style part(s): ${skippedParts.join(", ")}`)
  if (audit.styleStrategy.missingStyleIds.length) warnings.push(`Template style allowlist item(s) were not found: ${audit.styleStrategy.missingStyleIds.join(", ")}`)
  if (audit.styleStrategy.conflictingStyleIds.length) warnings.push(`Template style application overwrote conflicting target style id(s): ${audit.styleStrategy.conflictingStyleIds.join(", ")}`)
  if (audit.numberingStrategy.conflictingNumIds.length || audit.numberingStrategy.conflictingAbstractNumIds.length) {
    warnings.push([
      "Template numbering replaced target numbering definitions.",
      audit.numberingStrategy.conflictingNumIds.length ? `Conflicting numId(s): ${audit.numberingStrategy.conflictingNumIds.join(", ")}.` : "",
      audit.numberingStrategy.conflictingAbstractNumIds.length ? `Conflicting abstractNumId(s): ${audit.numberingStrategy.conflictingAbstractNumIds.join(", ")}.` : "",
    ].filter(Boolean).join(" "))
  }
  if (audit.relationshipStrategy.copiedMediaParts.length) warnings.push(`Copied ${audit.relationshipStrategy.copiedMediaParts.length} template media part(s) referenced by copied style/numbering/theme parts.`)
  if (audit.relationshipStrategy.skippedTemplateRelationshipParts.length) warnings.push(`Ignored unreferenced template relationship part(s): ${audit.relationshipStrategy.skippedTemplateRelationshipParts.join(", ")}`)
  return warnings
}

function naturalSort(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

function ensureContentTypeOverride(contentTypesXml: string, partName: string, contentType: string) {
  const escapedPart = escapeRegExp(partName)
  const overridePattern = new RegExp(`<Override\\b(?=[^>]*PartName="${escapedPart}")[^>]*/>`)
  if (overridePattern.test(contentTypesXml)) {
    return contentTypesXml.replace(overridePattern, (tag) => {
      if (/ContentType="[^"]*"/.test(tag)) return tag.replace(/ContentType="[^"]*"/, `ContentType="${contentType}"`)
      return tag.replace(/\/>$/, ` ContentType="${contentType}"/>`)
    })
  }
  const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`
  return contentTypesXml.replace("</Types>", `${override}</Types>`)
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function relationshipTypeLabel(type: string) {
  return type.split("/").pop() ?? type
}

function xmlAttr(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
