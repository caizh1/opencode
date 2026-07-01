import { createRequire } from "node:module"
import * as path from "node:path"
import { DocxRenderQualityGate } from "./DocxRenderQualityGate"
import { DocxFileStore } from "./DocxFileStore"
import { renderWordDocument } from "./WordRenderQualityGate"
import type { WordEditRenderCheckResult, WordEditStructureCheckResult } from "./types"

const nodeRequire = createRequire(__filename)

type JsZipModule = typeof import("jszip")
type ZipEntry = {
  dir?: boolean
  async(type: "string"): Promise<string>
  async(type: "nodebuffer"): Promise<Buffer>
}
type ZipArchive = {
  file(path: string): ZipEntry | null
  file(path: string, data: string | Uint8Array): void
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

type Relationship = {
  id: string
  type: string
  target: string
  targetMode?: string
}

const IMAGE_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
const HYPERLINK_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"

export type WordDocumentMergeAudit = {
  styleStrategy: {
    strategy: "base-wins"
    conflictingStyleIds: string[]
    referencedAppendOnlyStyleIds: string[]
  }
  numberingStrategy: {
    strategy: "base-wins"
    conflictingNumIds: string[]
    referencedAppendOnlyNumIds: string[]
    conflictingAbstractNumIds: string[]
  }
  relationshipStrategy: {
    mergedHyperlinkCount: number
    mergedImageCount: number
    unsupportedRelationshipCount: number
    unsupportedMarkupKinds: string[]
  }
  unsupportedRelationships: Array<{
    relId: string
    type: string
    target: string
    targetMode?: string
  }>
}

export type WordDocumentMergeInput = {
  base: { path: string; bytes: Uint8Array }
  append: { path: string; bytes: Uint8Array }
  outputFilenameBase?: string
  allowDrawings?: boolean
  workspaceRoot?: string
  timeoutMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
  remoteEndpoint?: string
}

export type WordDocumentMergeResult = {
  path: string
  absolutePath: string
  bodyChildrenAppended: number
  drawingsAllowed: boolean
  mergedImageCount: number
  mergeAudit: WordDocumentMergeAudit
  structureCheckResult: WordEditStructureCheckResult
  renderCheckResult: WordEditRenderCheckResult
  warnings: string[]
  errors: string[]
}

export class WordDocumentMerger {
  constructor(private readonly workspaceRoot = process.cwd()) {}

  async merge(input: WordDocumentMergeInput): Promise<WordDocumentMergeResult> {
    input.signal?.throwIfAborted()
    const mergeResult = await mergeDocxBytes(input)
    const structureIssues = await new DocxRenderQualityGate().check(mergeResult.bytes)
    const errors = structureIssues.filter((item) => item.severity === "error")
    if (errors.length) {
      throw new Error(`Merged DOCX failed structural validation: ${errors.map((item) => item.message).join("; ")}`)
    }
    const stored = await new DocxFileStore(input.workspaceRoot ?? this.workspaceRoot).write({
      filename: input.outputFilenameBase || `${path.basename(input.base.path, ".docx")}-merged`,
      bytes: mergeResult.bytes,
    })
    const renderCheckResult = await renderWordDocument({
      docxPath: stored.absolutePath,
      bytes: mergeResult.bytes,
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
      artifactNameBase: input.outputFilenameBase || path.basename(stored.absolutePath, ".docx"),
      structureIssues,
      timeoutMs: input.timeoutMs ?? 60_000,
      signal: input.signal,
      log: input.log,
      remoteEndpoint: input.remoteEndpoint,
    })
    const warnings = [
      ...mergeResult.warnings,
      ...structureIssues.filter((item) => item.severity === "warning").map((item) => item.message),
      ...renderCheckResult.issues.filter((item) => item.severity === "warning").map((item) => item.message),
    ]
    return {
      path: stored.path,
      absolutePath: stored.absolutePath,
      bodyChildrenAppended: mergeResult.bodyChildrenAppended,
      drawingsAllowed: input.allowDrawings === true,
      mergedImageCount: mergeResult.mergedImageCount,
      mergeAudit: mergeResult.mergeAudit,
      structureCheckResult: { ok: true, issues: structureIssues },
      renderCheckResult,
      warnings: [...new Set(warnings)],
      errors: [],
    }
  }
}

export async function mergeDocxBytes(input: WordDocumentMergeInput): Promise<{
  bytes: Uint8Array
  bodyChildrenAppended: number
  mergedImageCount: number
  mergeAudit: WordDocumentMergeAudit
  warnings: string[]
}> {
  const JSZip = nodeRequire("jszip") as JsZipModule
  const baseZip = await JSZip.loadAsync(Buffer.from(input.base.bytes)) as ZipArchive
  const appendZip = await JSZip.loadAsync(Buffer.from(input.append.bytes)) as ZipArchive
  const baseDocumentXml = await readDocumentXml(baseZip, input.base.path)
  const appendDocumentXml = await readDocumentXml(appendZip, input.append.path)
  const baseBody = extractBodyInner(baseDocumentXml, input.base.path)
  const baseParts = splitTrailingSectPr(baseBody)
  const appendParts = splitTrailingSectPr(extractBodyInner(appendDocumentXml, input.append.path))
  let appendBody = appendParts.body
  const mergeAudit = await auditDeepMerge(baseZip, appendZip, appendBody)
  const unsupportedSummary = unsupportedMergeSummary(mergeAudit)
  if (unsupportedSummary) throw new Error(unsupportedSummary)
  if (!input.allowDrawings && hasDrawingMarkup(appendBody)) {
    throw new Error("Append DOCX contains drawings/images. Re-run with allowDrawings only when relationship compatibility has been reviewed.")
  }
  const warnings: string[] = mergeAuditWarnings(mergeAudit)
  let mergedImageCount = 0
  let nextBaseDocumentXml = mergeDocumentNamespaces(baseDocumentXml, appendDocumentXml)
  const hyperlinkMerge = await mergeAppendHyperlinkRelationships(baseZip, appendZip, appendBody)
  appendBody = hyperlinkMerge.appendBody
  mergeAudit.relationshipStrategy.mergedHyperlinkCount = hyperlinkMerge.mergedHyperlinkCount
  warnings.push(...hyperlinkMerge.warnings)
  if (input.allowDrawings && hasDrawingMarkup(appendBody)) {
    const drawingMerge = await mergeAppendDrawingRelationships(baseZip, appendZip, appendBody)
    appendBody = drawingMerge.appendBody
    mergedImageCount = drawingMerge.mergedImageCount
    mergeAudit.relationshipStrategy.mergedImageCount = mergedImageCount
    warnings.push(...drawingMerge.warnings)
  }
  const bodyChildrenAppended = countTopLevelBodyChildren(appendBody)
  const mergedBody = `${baseParts.body}${appendBody}${baseParts.sectPr ?? ""}`
  baseZip.file("word/document.xml", replaceBodyInner(nextBaseDocumentXml, mergedBody))
  return {
    bytes: await baseZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    bodyChildrenAppended,
    mergedImageCount,
    mergeAudit,
    warnings,
  }
}

async function readDocumentXml(zip: ZipArchive, sourcePath: string) {
  const documentPart = zip.file("word/document.xml")
  if (!documentPart) throw new Error(`DOCX is missing word/document.xml: ${sourcePath}`)
  return await documentPart.async("string")
}

function extractBodyInner(documentXml: string, sourcePath: string) {
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)
  if (!body) throw new Error(`DOCX document.xml is missing w:body: ${sourcePath}`)
  return body[1] ?? ""
}

function replaceBodyInner(documentXml: string, bodyInner: string) {
  return documentXml.replace(/(<w:body\b[^>]*>)[\s\S]*?(<\/w:body>)/, `$1${bodyInner}$2`)
}

function splitTrailingSectPr(bodyInner: string) {
  const match = bodyInner.match(/([\s\S]*?)(<w:sectPr\b[\s\S]*?<\/w:sectPr>)\s*$/)
  if (!match) return { body: bodyInner, sectPr: undefined as string | undefined }
  return { body: match[1] ?? "", sectPr: match[2] }
}

async function mergeAppendDrawingRelationships(baseZip: ZipArchive, appendZip: ZipArchive, appendBody: string) {
  const appendRelsXml = await readZipText(appendZip, "word/_rels/document.xml.rels") ?? ""
  let baseRelsXml = ensureRelationshipsXml(await readZipText(baseZip, "word/_rels/document.xml.rels"))
  let contentTypesXml = ensureContentTypesXml(await readZipText(baseZip, "[Content_Types].xml"))
  const appendContentTypesXml = await readZipText(appendZip, "[Content_Types].xml") ?? ""
  const appendRelationships = parseRelationships(appendRelsXml)
  const imageRelationships = appendRelationships.filter((relationship) =>
    relationship.type === IMAGE_RELATIONSHIP_TYPE && relationshipIdReferenced(appendBody, relationship.id)
  )
  if (!imageRelationships.length) {
    return {
      appendBody,
      mergedImageCount: 0,
      warnings: ["Append DOCX contains drawing markup, but no local image relationships were found to merge."],
    }
  }
  const idMap = new Map<string, string>()
  let mergedImageCount = 0
  for (const relationship of imageRelationships) {
    const newRelId = nextRelationshipId(baseRelsXml, "rIdChipMateMergeImage")
    let nextTarget = relationship.target
    if (relationship.targetMode !== "External") {
      const sourcePart = relationshipTargetPart("word/document.xml", relationship.target)
      const sourceEntry = appendZip.file(sourcePart)
      if (!sourceEntry) throw new Error(`Append DOCX image relationship ${relationship.id} points to a missing part: ${sourcePart}`)
      nextTarget = nextMergedMediaTarget(baseZip, relationship.target)
      baseZip.file(`word/${nextTarget}`, await sourceEntry.async("nodebuffer"))
      contentTypesXml = ensureMediaContentType(contentTypesXml, appendContentTypesXml, nextTarget)
      mergedImageCount++
    }
    baseRelsXml = baseRelsXml.replace("</Relationships>", `${relationshipXml({
      id: newRelId,
      type: relationship.type,
      target: nextTarget,
      targetMode: relationship.targetMode,
    })}</Relationships>`)
    idMap.set(relationship.id, newRelId)
  }
  baseZip.file("word/_rels/document.xml.rels", baseRelsXml)
  baseZip.file("[Content_Types].xml", contentTypesXml)
  return {
    appendBody: remapRelationshipIds(appendBody, idMap),
    mergedImageCount,
    warnings: mergedImageCount > 0 ? [`Merged ${mergedImageCount} append DOCX image relationship(s) and media part(s).`] : [],
  }
}

async function mergeAppendHyperlinkRelationships(baseZip: ZipArchive, appendZip: ZipArchive, appendBody: string) {
  const appendRelsXml = await readZipText(appendZip, "word/_rels/document.xml.rels") ?? ""
  let baseRelsXml = ensureRelationshipsXml(await readZipText(baseZip, "word/_rels/document.xml.rels"))
  const appendRelationships = parseRelationships(appendRelsXml)
  const hyperlinkRelationships = appendRelationships.filter((relationship) =>
    relationship.type === HYPERLINK_RELATIONSHIP_TYPE && relationshipIdReferenced(appendBody, relationship.id)
  )
  if (!hyperlinkRelationships.length) {
    return { appendBody, mergedHyperlinkCount: 0, warnings: [] as string[] }
  }
  const idMap = new Map<string, string>()
  for (const relationship of hyperlinkRelationships) {
    const newRelId = nextRelationshipId(baseRelsXml, "rIdChipMateMergeHyperlink")
    baseRelsXml = baseRelsXml.replace("</Relationships>", `${relationshipXml({
      id: newRelId,
      type: relationship.type,
      target: relationship.target,
      targetMode: relationship.targetMode ?? "External",
    })}</Relationships>`)
    idMap.set(relationship.id, newRelId)
  }
  baseZip.file("word/_rels/document.xml.rels", baseRelsXml)
  return {
    appendBody: remapRelationshipIds(appendBody, idMap),
    mergedHyperlinkCount: hyperlinkRelationships.length,
    warnings: [`Merged ${hyperlinkRelationships.length} append DOCX hyperlink relationship(s).`],
  }
}

async function auditDeepMerge(baseZip: ZipArchive, appendZip: ZipArchive, appendBody: string): Promise<WordDocumentMergeAudit> {
  const baseStylesXml = await readZipText(baseZip, "word/styles.xml") ?? ""
  const appendStylesXml = await readZipText(appendZip, "word/styles.xml") ?? ""
  const baseNumberingXml = await readZipText(baseZip, "word/numbering.xml") ?? ""
  const appendNumberingXml = await readZipText(appendZip, "word/numbering.xml") ?? ""
  const appendRelationships = parseRelationships(await readZipText(appendZip, "word/_rels/document.xml.rels") ?? "")
  const unsupportedRelationships = appendRelationships
    .filter((relationship) => relationshipIdReferenced(appendBody, relationship.id))
    .filter((relationship) => !isSupportedBodyRelationship(relationship))
    .map((relationship) => ({
      relId: relationship.id,
      type: relationship.type,
      target: relationship.target,
      targetMode: relationship.targetMode,
    }))
  const unsupportedMarkupKinds = unsupportedObjectMarkupKinds(appendBody)
  return {
    styleStrategy: styleMergeStrategy(baseStylesXml, appendStylesXml, appendBody),
    numberingStrategy: numberingMergeStrategy(baseNumberingXml, appendNumberingXml, appendBody),
    relationshipStrategy: {
      mergedHyperlinkCount: 0,
      mergedImageCount: 0,
      unsupportedRelationshipCount: unsupportedRelationships.length,
      unsupportedMarkupKinds,
    },
    unsupportedRelationships,
  }
}

function styleMergeStrategy(baseStylesXml: string, appendStylesXml: string, appendBody: string): WordDocumentMergeAudit["styleStrategy"] {
  const baseStyles = parseStyleDefinitions(baseStylesXml)
  const appendStyles = parseStyleDefinitions(appendStylesXml)
  const referenced = referencedStyleIds(appendBody)
  const conflictingStyleIds = [...referenced].filter((styleId) => {
    const baseStyle = baseStyles.get(styleId)
    const appendStyle = appendStyles.get(styleId)
    return Boolean(baseStyle && appendStyle && baseStyle !== appendStyle)
  }).sort()
  const referencedAppendOnlyStyleIds = [...referenced].filter((styleId) => appendStyles.has(styleId) && !baseStyles.has(styleId)).sort()
  return { strategy: "base-wins", conflictingStyleIds, referencedAppendOnlyStyleIds }
}

function numberingMergeStrategy(baseNumberingXml: string, appendNumberingXml: string, appendBody: string): WordDocumentMergeAudit["numberingStrategy"] {
  const baseNums = parseNumberingDefinitions(baseNumberingXml, "num", "numId")
  const appendNums = parseNumberingDefinitions(appendNumberingXml, "num", "numId")
  const baseAbstractNums = parseNumberingDefinitions(baseNumberingXml, "abstractNum", "abstractNumId")
  const appendAbstractNums = parseNumberingDefinitions(appendNumberingXml, "abstractNum", "abstractNumId")
  const referenced = referencedNumIds(appendBody)
  const conflictingNumIds = [...referenced].filter((numId) => {
    const baseNum = baseNums.get(numId)
    const appendNum = appendNums.get(numId)
    return Boolean(baseNum && appendNum && baseNum !== appendNum)
  }).sort(naturalSort)
  const referencedAppendOnlyNumIds = [...referenced].filter((numId) => appendNums.has(numId) && !baseNums.has(numId)).sort(naturalSort)
  const conflictingAbstractNumIds = [...appendAbstractNums.keys()].filter((abstractNumId) => {
    const baseAbstractNum = baseAbstractNums.get(abstractNumId)
    const appendAbstractNum = appendAbstractNums.get(abstractNumId)
    return Boolean(baseAbstractNum && appendAbstractNum && baseAbstractNum !== appendAbstractNum)
  }).sort(naturalSort)
  return { strategy: "base-wins", conflictingNumIds, referencedAppendOnlyNumIds, conflictingAbstractNumIds }
}

function mergeAuditWarnings(audit: WordDocumentMergeAudit) {
  const warnings: string[] = []
  if (audit.styleStrategy.conflictingStyleIds.length || audit.styleStrategy.referencedAppendOnlyStyleIds.length) {
    warnings.push([
      "Style merge strategy: base-wins; append style definitions are not imported.",
      audit.styleStrategy.conflictingStyleIds.length ? `Conflicting referenced style id(s) ignored: ${audit.styleStrategy.conflictingStyleIds.join(", ")}.` : "",
      audit.styleStrategy.referencedAppendOnlyStyleIds.length ? `Referenced append-only style id(s) may render with Word defaults: ${audit.styleStrategy.referencedAppendOnlyStyleIds.join(", ")}.` : "",
    ].filter(Boolean).join(" "))
  }
  if (audit.numberingStrategy.conflictingNumIds.length || audit.numberingStrategy.referencedAppendOnlyNumIds.length || audit.numberingStrategy.conflictingAbstractNumIds.length) {
    warnings.push([
      "Numbering merge strategy: base-wins; append numbering definitions are not imported.",
      audit.numberingStrategy.conflictingNumIds.length ? `Conflicting referenced numId(s) ignored: ${audit.numberingStrategy.conflictingNumIds.join(", ")}.` : "",
      audit.numberingStrategy.referencedAppendOnlyNumIds.length ? `Referenced append-only numId(s) may lose original list formatting: ${audit.numberingStrategy.referencedAppendOnlyNumIds.join(", ")}.` : "",
      audit.numberingStrategy.conflictingAbstractNumIds.length ? `Conflicting abstractNumId(s) detected: ${audit.numberingStrategy.conflictingAbstractNumIds.join(", ")}.` : "",
    ].filter(Boolean).join(" "))
  }
  return warnings
}

function unsupportedMergeSummary(audit: WordDocumentMergeAudit) {
  const parts: string[] = []
  if (audit.unsupportedRelationships.length) {
    parts.push(`unsupported referenced relationship(s): ${audit.unsupportedRelationships.map((item) => `${item.relId}:${relationshipTypeLabel(item.type)}->${item.target}`).join(", ")}`)
  }
  if (audit.relationshipStrategy.unsupportedMarkupKinds.length) {
    parts.push(`unsupported object markup: ${audit.relationshipStrategy.unsupportedMarkupKinds.join(", ")}`)
  }
  return parts.length ? `Append DOCX contains unsupported embedded object(s); merge was not performed (${parts.join("; ")}).` : undefined
}

function isSupportedBodyRelationship(relationship: Relationship) {
  return relationship.type === IMAGE_RELATIONSHIP_TYPE || relationship.type === HYPERLINK_RELATIONSHIP_TYPE
}

function unsupportedObjectMarkupKinds(bodyInner: string) {
  const kinds = new Set<string>()
  if (/<w:object\b/.test(bodyInner)) kinds.add("w:object")
  if (/<o:OLEObject\b/.test(bodyInner)) kinds.add("o:OLEObject")
  if (/<w:control\b/.test(bodyInner)) kinds.add("w:control")
  if (/<w:altChunk\b/.test(bodyInner)) kinds.add("w:altChunk")
  return [...kinds].sort()
}

async function readZipText(zip: ZipArchive, partPath: string) {
  return await zip.file(partPath)?.async("string")
}

function mergeDocumentNamespaces(baseDocumentXml: string, appendDocumentXml: string) {
  const baseOpen = baseDocumentXml.match(/<w:document\b[^>]*>/)?.[0]
  const appendOpen = appendDocumentXml.match(/<w:document\b[^>]*>/)?.[0]
  if (!baseOpen || !appendOpen) return baseDocumentXml
  let nextOpen = baseOpen
  for (const namespace of appendOpen.match(/\s+xmlns(?::[A-Za-z0-9_]+)?="[^"]*"/g) ?? []) {
    const prefix = namespace.match(/\s+(xmlns(?::[A-Za-z0-9_]+)?)=/)?.[1]
    if (!prefix || new RegExp(`\\s${escapeRegExp(prefix)}=`).test(nextOpen)) continue
    nextOpen = nextOpen.replace(/>$/, `${namespace}>`)
  }
  return nextOpen === baseOpen ? baseDocumentXml : baseDocumentXml.replace(baseOpen, nextOpen)
}

function parseRelationships(xml: string): Relationship[] {
  return (xml.match(/<Relationship\b[^>]*\/>/g) ?? []).map((tag) => ({
    id: xmlAttribute(tag, "Id") ?? "",
    type: xmlAttribute(tag, "Type") ?? "",
    target: xmlAttribute(tag, "Target") ?? "",
    targetMode: xmlAttribute(tag, "TargetMode"),
})).filter((relationship) => relationship.id && relationship.type && relationship.target)
}

function parseStyleDefinitions(xml: string) {
  const styles = new Map<string, string>()
  for (const match of xml.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)) {
    const styleXml = match[0]
    const openTag = styleXml.match(/<w:style\b[^>]*>/)?.[0] ?? ""
    const styleId = xmlNamespacedAttribute(openTag, "w", "styleId")
    if (styleId) styles.set(styleId, normalizeXmlForCompare(styleXml))
  }
  return styles
}

function parseNumberingDefinitions(xml: string, tagName: "num" | "abstractNum", attrName: "numId" | "abstractNumId") {
  const definitions = new Map<string, string>()
  for (const match of xml.matchAll(new RegExp(`<w:${tagName}\\b[\\s\\S]*?<\\/w:${tagName}>`, "g"))) {
    const itemXml = match[0]
    const openTag = itemXml.match(new RegExp(`<w:${tagName}\\b[^>]*>`))?.[0] ?? ""
    const id = xmlNamespacedAttribute(openTag, "w", attrName)
    if (id) definitions.set(id, normalizeXmlForCompare(itemXml))
  }
  return definitions
}

function referencedStyleIds(bodyInner: string) {
  const ids = new Set<string>()
  for (const match of bodyInner.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\b[^>]*\bw:val="([^"]+)"/g)) {
    if (match[1]) ids.add(match[1])
  }
  return ids
}

function referencedNumIds(bodyInner: string) {
  const ids = new Set<string>()
  for (const match of bodyInner.matchAll(/<w:numId\b[^>]*\bw:val="([^"]+)"/g)) {
    if (match[1]) ids.add(match[1])
  }
  return ids
}

function normalizeXmlForCompare(xml: string) {
  return xml.replace(/\s+/g, " ").trim()
}

function xmlAttribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`))?.[1]
}

function xmlNamespacedAttribute(tag: string, prefix: string, name: string) {
  return tag.match(new RegExp(`\\b${escapeRegExp(prefix)}:${escapeRegExp(name)}="([^"]*)"`))?.[1]
}

function naturalSort(left: string, right: string) {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left.localeCompare(right)
}

function relationshipIdReferenced(xml: string, id: string) {
  return new RegExp(`\\br:(?:embed|link|id)="${escapeRegExp(id)}"`).test(xml)
}

function relationshipTypeLabel(type: string) {
  return type.split("/").pop() || type
}

function relationshipTargetPart(sourcePart: string, target: string) {
  if (target.startsWith("/")) return target.replace(/^\/+/, "")
  const sourceDir = path.posix.dirname(sourcePart)
  const normalized = path.posix.normalize(path.posix.join(sourceDir, target))
  if (normalized.startsWith("../")) throw new Error(`Unsupported append DOCX relationship target outside package root: ${target}`)
  return normalized
}

function nextMergedMediaTarget(zip: ZipArchive, originalTarget: string) {
  const ext = normalizedExtension(originalTarget)
  for (let index = 1; index < 10000; index++) {
    const candidate = `media/chipmate-merge-image${index}${ext}`
    if (!zip.file(`word/${candidate}`)) return candidate
  }
  throw new Error("Could not allocate a unique merged image media part name.")
}

function normalizedExtension(target: string) {
  const ext = path.posix.extname(target).toLowerCase()
  return ext || ".png"
}

function ensureMediaContentType(baseXml: string, appendXml: string, target: string) {
  const extension = normalizedExtension(target).slice(1)
  if (new RegExp(`<Default\\s+[^>]*Extension="${escapeRegExp(extension)}"`).test(baseXml)) return baseXml
  const appendDefault = (appendXml.match(new RegExp(`<Default\\s+[^>]*Extension="${escapeRegExp(extension)}"[^>]*/>`)) ?? [])[0]
  const contentType = appendDefault?.match(/\bContentType="([^"]*)"/)?.[1] ?? knownImageContentType(extension)
  if (!contentType) throw new Error(`Unsupported append DOCX image media extension: ${extension}`)
  return baseXml.replace("</Types>", `<Default Extension="${xmlAttr(extension)}" ContentType="${xmlAttr(contentType)}"/></Types>`)
}

function knownImageContentType(extension: string) {
  if (extension === "png") return "image/png"
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "gif") return "image/gif"
  if (extension === "bmp") return "image/bmp"
  if (extension === "tif" || extension === "tiff") return "image/tiff"
  if (extension === "emf") return "image/x-emf"
  if (extension === "wmf") return "image/x-wmf"
  return undefined
}

function remapRelationshipIds(xml: string, idMap: Map<string, string>) {
  let next = xml
  for (const [from, to] of idMap.entries()) {
    next = next.replace(new RegExp(`(\\br:(?:embed|link|id)=")${escapeRegExp(from)}(")`, "g"), `$1${to}$2`)
  }
  return next
}

function relationshipXml(relationship: Relationship) {
  return [
    `<Relationship Id="${xmlAttr(relationship.id)}"`,
    ` Type="${xmlAttr(relationship.type)}"`,
    ` Target="${xmlAttr(relationship.target)}"`,
    relationship.targetMode ? ` TargetMode="${xmlAttr(relationship.targetMode)}"` : "",
    "/>",
  ].join("")
}

function nextRelationshipId(xml: string, prefix: string) {
  let index = 1
  while (xml.includes(`Id="${prefix}${index}"`)) index++
  return `${prefix}${index}`
}

function ensureRelationshipsXml(input: string | undefined) {
  const xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  return xml.includes("</Relationships>") ? xml : `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
}

function ensureContentTypesXml(input: string | undefined) {
  const xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  return xml.includes("</Types>") ? xml : `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
}

function xmlAttr(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasDrawingMarkup(bodyInner: string) {
  return /<w:(?:drawing|pict)\b|<wp:inline\b|<wp:anchor\b|<v:shape\b|<pic:pic\b/.test(bodyInner)
}

function countTopLevelBodyChildren(bodyInner: string) {
  return (bodyInner.match(/<w:(?:p|tbl|sdt)\b/g) ?? []).length
}
