import { createRequire } from "node:module"
import type { QualityIssue } from "./types"

const nodeRequire = createRequire(__filename)

type JsZipModule = typeof import("jszip")
type ZipEntry = {
  dir?: boolean
  async(type: "string"): Promise<string>
}
type ZipArchive = {
  file(path: string): ZipEntry | null
  files: Record<string, ZipEntry>
}

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/header1.xml",
  "word/footer1.xml",
]

const REQUIRED_CONTENT_TYPES: Record<string, string> = {
  "/word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  "/word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  "/word/header1.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  "/word/footer1.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
  "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
  "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
}

const REL_TYPES = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  appProperties: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
  numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
}

export class DocxRenderQualityGate {
  async check(bytes: Uint8Array): Promise<QualityIssue[]> {
    const issues: QualityIssue[] = []
    const JSZip = nodeRequire("jszip") as JsZipModule
    let zip: ZipArchive
    try {
      zip = await JSZip.loadAsync(Buffer.from(bytes)) as ZipArchive
    } catch (errorValue) {
      return [error("invalid-docx-zip", `Generated DOCX is not a readable ZIP package: ${formatError(errorValue)}`)]
    }
    const entryPaths = packageFilePaths(zip)
    issues.push(...checkRequiredParts(zip))
    const xmlParts = await readXmlParts(zip, entryPaths, issues)
    const contentTypesXml = xmlParts.get("[Content_Types].xml")
    const packageRelsXml = xmlParts.get("_rels/.rels")
    const documentRelsXml = xmlParts.get("word/_rels/document.xml.rels")
    const documentXml = xmlParts.get("word/document.xml")
    const stylesXml = xmlParts.get("word/styles.xml")
    const headerXml = xmlParts.get("word/header1.xml")
    const footerXml = xmlParts.get("word/footer1.xml")
    const coreXml = xmlParts.get("docProps/core.xml")
    const appXml = xmlParts.get("docProps/app.xml")
    const header = zip.file("word/header1.xml")
    const footer = zip.file("word/footer1.xml")

    if (contentTypesXml) issues.push(...checkContentTypes(contentTypesXml, entryPaths))
    if (packageRelsXml) issues.push(...checkPackageRelationships(packageRelsXml, entryPaths))
    if (documentRelsXml) issues.push(...checkDocumentRelationships(documentRelsXml, entryPaths, documentXml))
    if (documentXml) issues.push(...checkDocumentNamespaces(documentXml))
    if (stylesXml) issues.push(...checkStylesNamespaces(stylesXml))
    if (headerXml) issues.push(...checkWordPartNamespace("header", headerXml, "<w:hdr"))
    if (footerXml) issues.push(...checkWordPartNamespace("footer", footerXml, "<w:ftr"))
    if (coreXml) issues.push(...checkCoreProperties(coreXml))
    if (appXml) issues.push(...checkAppProperties(appXml))

    if (!documentXml) issues.push(error("missing-document-xml", "Generated DOCX is missing word/document.xml."))
    if (!stylesXml) issues.push(error("missing-styles-xml", "Generated DOCX is missing word/styles.xml."))
    if (!header || !footer) issues.push(warning("missing-header-footer", "Generated DOCX should include header and footer."))
    if (stylesXml && !/w:styleId="Heading1"[\s\S]*w:name w:val="heading 1"/.test(stylesXml)) issues.push(error("missing-heading1-style", "Generated DOCX is missing Heading 1 style."))
    if (stylesXml && !/w:styleId="Heading2"[\s\S]*w:name w:val="heading 2"/.test(stylesXml)) issues.push(error("missing-heading2-style", "Generated DOCX is missing Heading 2 style."))
    if (stylesXml && !/w:styleId="Heading3"[\s\S]*w:name w:val="heading 3"/.test(stylesXml)) issues.push(error("missing-heading3-style", "Generated DOCX is missing Heading 3 style."))
    if (documentXml && !documentXml.includes("<w:tbl>")) issues.push(warning("missing-tables", "Generated DOCX does not contain tables."))
    if (documentXml) issues.push(...checkTableGeometry(documentXml))
    if (documentXml) issues.push(...checkAccessibility(documentXml))
    if (documentXml) issues.push(...checkDocumentXmlOrdering(documentXml))
    if (stylesXml) issues.push(...checkStylesXmlOrdering(stylesXml))
    if (documentXml && !/(References|参考资料)/.test(documentXml)) issues.push(warning("missing-references-section", "Generated DOCX does not contain a References section. This is acceptable for non-source-backed documents."))
    if (documentXml && strippedText(documentXml).length < 200) issues.push(error("empty-body", "Generated DOCX body is empty or too short."))
    return issues
  }
}

async function readXmlParts(zip: ZipArchive, entryPaths: string[], issues: QualityIssue[]) {
  const parts = new Map<string, string>()
  for (const path of entryPaths.filter((item) => item.endsWith(".xml") || item.endsWith(".rels"))) {
    const part = zip.file(path)
    if (!part) continue
    try {
      const xml = await part.async("string")
      parts.set(path, xml)
      issues.push(...checkXmlWellFormed(path, xml))
    } catch (errorValue) {
      issues.push(error("unreadable-xml-part", `Generated DOCX XML part cannot be read: ${path}: ${formatError(errorValue)}`))
    }
  }
  return parts
}

function packageFilePaths(zip: ZipArchive) {
  return Object.entries(zip.files)
    .filter(([, entry]) => !entry.dir)
    .map(([path]) => path)
    .sort()
}

function checkRequiredParts(zip: ZipArchive) {
  return REQUIRED_PARTS
    .filter((path) => !zip.file(path))
    .map((path) => error("missing-docx-part", `Generated DOCX is missing required part: ${path}.`))
}

function checkXmlWellFormed(path: string, xml: string) {
  const issues: QualityIssue[] = []
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml)) {
    issues.push(error("invalid-xml-control-character", `Generated DOCX XML part contains XML 1.0 control characters: ${path}.`))
  }
  if (/(^|[^&])&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(xml)) {
    issues.push(error("invalid-xml-entity", `Generated DOCX XML part contains an unescaped ampersand: ${path}.`))
  }
  const stack: string[] = []
  for (const match of xml.matchAll(/<[^>]+>/g)) {
    const tag = match[0]
    if (tag.startsWith("<?") || tag.startsWith("<!--") || tag.startsWith("<!")) continue
    if (tag.startsWith("</")) {
      const name = tag.match(/^<\/([^\s>]+)>$/)?.[1]
      const expected = stack.pop()
      if (!name || expected !== name) {
        issues.push(error("malformed-xml-part", `Generated DOCX XML part has mismatched tag order in ${path}.`))
        return issues
      }
      continue
    }
    if (tag.endsWith("/>")) continue
    const name = tag.match(/^<([^\s>/]+)/)?.[1]
    if (name) stack.push(name)
  }
  if (stack.length) issues.push(error("malformed-xml-part", `Generated DOCX XML part has unclosed tags in ${path}.`))
  return issues
}

function checkContentTypes(contentTypesXml: string, entryPaths: string[]) {
  const issues: QualityIssue[] = []
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const tag of contentTypesXml.match(/<Default\b[^>]*\/>/g) ?? []) {
    const attrs = parseXmlAttributes(tag)
    if (attrs.Extension && attrs.ContentType) defaults.set(attrs.Extension, attrs.ContentType)
  }
  for (const tag of contentTypesXml.match(/<Override\b[^>]*\/>/g) ?? []) {
    const attrs = parseXmlAttributes(tag)
    if (attrs.PartName && attrs.ContentType) overrides.set(attrs.PartName, attrs.ContentType)
  }
  if (defaults.get("rels") !== "application/vnd.openxmlformats-package.relationships+xml") {
    issues.push(error("missing-rels-content-type", "Generated DOCX is missing the package relationships content type default."))
  }
  if (defaults.get("xml") !== "application/xml") {
    issues.push(error("missing-xml-content-type", "Generated DOCX is missing the XML content type default."))
  }
  for (const [partName, expected] of Object.entries(REQUIRED_CONTENT_TYPES)) {
    const actual = overrides.get(partName)
    if (actual !== expected) {
      issues.push(error("missing-required-content-type", `Generated DOCX has an invalid content type for ${partName}.`))
    }
  }
  const actualParts = new Set(entryPaths)
  for (const partName of overrides.keys()) {
    const normalized = partName.replace(/^\/+/, "")
    if (!actualParts.has(normalized)) {
      issues.push(error("content-type-target-missing", `Generated DOCX content type references a missing part: ${partName}.`))
    }
  }
  return issues
}

function checkPackageRelationships(packageRelsXml: string, entryPaths: string[]) {
  const issues: QualityIssue[] = []
  const rels = parseRelationships(packageRelsXml)
  issues.push(...checkDuplicateRelationshipIds(rels, "package"))
  issues.push(...checkRelationshipTargets(rels, "", entryPaths, "package"))
  if (!rels.some((rel) => rel.Type === REL_TYPES.officeDocument && rel.Target === "word/document.xml")) {
    issues.push(error("missing-office-document-relationship", "Generated DOCX package relationships must point to word/document.xml."))
  }
  if (!rels.some((rel) => rel.Type === REL_TYPES.coreProperties && rel.Target === "docProps/core.xml")) {
    issues.push(error("missing-core-properties-relationship", "Generated DOCX package relationships must point to docProps/core.xml."))
  }
  if (!rels.some((rel) => rel.Type === REL_TYPES.appProperties && rel.Target === "docProps/app.xml")) {
    issues.push(error("missing-app-properties-relationship", "Generated DOCX package relationships must point to docProps/app.xml."))
  }
  return issues
}

function checkDocumentRelationships(documentRelsXml: string, entryPaths: string[], documentXml?: string) {
  const issues: QualityIssue[] = []
  const rels = parseRelationships(documentRelsXml)
  issues.push(...checkDuplicateRelationshipIds(rels, "document"))
  issues.push(...checkRelationshipTargets(rels, "word", entryPaths, "document"))
  const styles = rels.find((rel) => rel.Type === REL_TYPES.styles)
  const header = rels.find((rel) => rel.Type === REL_TYPES.header)
  const footer = rels.find((rel) => rel.Type === REL_TYPES.footer)
  const numbering = rels.find((rel) => rel.Type === REL_TYPES.numbering)
  if (!styles || resolveRelationshipTarget("word", styles.Target ?? "") !== "word/styles.xml") {
    issues.push(error("missing-styles-relationship", "Generated DOCX document relationships must point to word/styles.xml."))
  }
  if (!header || resolveRelationshipTarget("word", header.Target ?? "") !== "word/header1.xml") {
    issues.push(error("missing-header-relationship", "Generated DOCX document relationships must point to word/header1.xml."))
  }
  if (!footer || resolveRelationshipTarget("word", footer.Target ?? "") !== "word/footer1.xml") {
    issues.push(error("missing-footer-relationship", "Generated DOCX document relationships must point to word/footer1.xml."))
  }
  if (documentXml) {
    const relationshipIds = new Set(rels.map((rel) => rel.Id).filter(Boolean))
    const referencedIds = [...documentXml.matchAll(/\br:id="([^"]+)"/g)].map((match) => match[1]!)
    for (const id of referencedIds) {
      if (!relationshipIds.has(id)) {
        issues.push(error("missing-document-relationship-id", `Generated DOCX document XML references missing relationship id: ${id}.`))
      }
    }
    if (/<w:numPr\b/.test(documentXml) && (!numbering || resolveRelationshipTarget("word", numbering.Target ?? "") !== "word/numbering.xml")) {
      issues.push(error("missing-numbering-relationship", "Generated DOCX uses real list numbering but document relationships do not point to word/numbering.xml."))
    }
  }
  return issues
}

function checkDuplicateRelationshipIds(rels: Relationship[], scope: string) {
  const issues: QualityIssue[] = []
  const seen = new Set<string>()
  for (const rel of rels) {
    if (!rel.Id) continue
    if (seen.has(rel.Id)) issues.push(error("duplicate-relationship-id", `Generated DOCX ${scope} relationships contain duplicate id: ${rel.Id}.`))
    seen.add(rel.Id)
  }
  return issues
}

function checkRelationshipTargets(rels: Relationship[], base: string, entryPaths: string[], scope: string) {
  const issues: QualityIssue[] = []
  const actualParts = new Set(entryPaths)
  for (const rel of rels) {
    if (rel.TargetMode === "External") continue
    if (!rel.Target) {
      issues.push(error("missing-relationship-target", `Generated DOCX ${scope} relationship is missing a Target.`))
      continue
    }
    const resolved = resolveRelationshipTarget(base, rel.Target)
    if (resolved.startsWith("../") || resolved.includes("/../")) {
      issues.push(error("relationship-target-escapes-package", `Generated DOCX ${scope} relationship target escapes the package: ${rel.Target}.`))
      continue
    }
    if (!actualParts.has(resolved)) {
      issues.push(error("relationship-target-missing", `Generated DOCX ${scope} relationship points to a missing part: ${rel.Target}.`))
    }
  }
  return issues
}

function checkDocumentNamespaces(documentXml: string) {
  const issues: QualityIssue[] = []
  if (!documentXml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    issues.push(error("missing-wordprocessing-namespace", "Generated DOCX document.xml is missing the WordprocessingML namespace."))
  }
  if (!documentXml.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')) {
    issues.push(error("missing-relationships-namespace", "Generated DOCX document.xml is missing the relationships namespace."))
  }
  if (!/<w:body>[\s\S]*<w:sectPr>[\s\S]*<\/w:sectPr>[\s\S]*<\/w:body>/.test(documentXml)) {
    issues.push(error("missing-section-properties", "Generated DOCX document.xml must include body section properties."))
  }
  return issues
}

function checkStylesNamespaces(stylesXml: string) {
  if (stylesXml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) return []
  return [error("missing-styles-wordprocessing-namespace", "Generated DOCX styles.xml is missing the WordprocessingML namespace.")]
}

function checkWordPartNamespace(kind: string, xml: string, rootTag: string) {
  const issues: QualityIssue[] = []
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    issues.push(error(`missing-${kind}-wordprocessing-namespace`, `Generated DOCX ${kind} part is missing the WordprocessingML namespace.`))
  }
  if (!xml.includes(rootTag)) {
    issues.push(error(`missing-${kind}-root`, `Generated DOCX ${kind} part has an unexpected root element.`))
  }
  return issues
}

function checkCoreProperties(coreXml: string) {
  const issues: QualityIssue[] = []
  if (!coreXml.includes('xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"')) {
    issues.push(error("missing-core-properties-namespace", "Generated DOCX core properties are missing the cp namespace."))
  }
  if (!coreXml.includes('xmlns:dcterms="http://purl.org/dc/terms/"')) {
    issues.push(error("missing-dcterms-namespace", "Generated DOCX core properties are missing the dcterms namespace."))
  }
  if (!/<dcterms:created\b[^>]*xsi:type="dcterms:W3CDTF"/.test(coreXml)) {
    issues.push(error("missing-created-core-property", "Generated DOCX core properties must include a W3CDTF created timestamp."))
  }
  return issues
}

function checkAppProperties(appXml: string) {
  if (appXml.includes('xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"')) return []
  return [error("missing-app-properties-namespace", "Generated DOCX app properties are missing the extended-properties namespace.")]
}

function checkTableGeometry(documentXml: string) {
  const issues: QualityIssue[] = []
  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
  if (!tables.length) return issues
  const autoSized = tables.filter((table) => /<w:tblW[^>]*w:type="auto"/.test(table))
  if (autoSized.length) {
    issues.push(error("auto-table-width", "Generated DOCX contains auto-width tables; use fixed DXA table geometry to avoid compressed rendering."))
  }
  const missingFixedLayout = tables.filter((table) => !/<w:tblLayout[^>]*w:type="fixed"/.test(table))
  if (missingFixedLayout.length) {
    issues.push(error("missing-fixed-table-layout", "Generated DOCX tables must use fixed layout."))
  }
  const missingGrid = tables.filter((table) => !table.includes("<w:tblGrid>"))
  if (missingGrid.length) {
    issues.push(error("missing-table-grid", "Generated DOCX tables must include tblGrid column widths."))
  }
  const missingCellWidths = tables.filter((table) => !/<w:tcW[^>]*w:type="dxa"/.test(table))
  if (missingCellWidths.length) {
    issues.push(error("missing-table-cell-widths", "Generated DOCX table cells must include DXA widths."))
  }
  issues.push(...checkTableOverflowRisks(documentXml, tables))
  return issues
}

function checkTableOverflowRisks(documentXml: string, tables: string[]) {
  const issues: QualityIssue[] = []
  const usableWidth = documentUsableWidthTwips(documentXml)
  tables.forEach((table, index) => {
    const tableNumber = index + 1
    const tableWidth = dxaWidthFromTag(table.match(/<w:tblW\b[^>]*\/?>/)?.[0])
    const gridWidths = [...table.matchAll(/<w:gridCol\b[^>]*\/?>/g)]
      .map((match) => dxaWidthFromTag(match[0]))
      .filter((width): width is number => width !== undefined)
    const gridWidth = gridWidths.reduce((sum, width) => sum + width, 0)
    const effectiveWidth = gridWidth || tableWidth
    if (usableWidth && effectiveWidth && effectiveWidth > usableWidth + 80) {
      issues.push(warning("table-overflow-risk", `Generated DOCX table ${tableNumber} width ${effectiveWidth} DXA exceeds usable page width ${usableWidth} DXA; reduce columns, adjust ratios, or split the table.`))
    }
    if (tableWidth && gridWidth && Math.abs(tableWidth - gridWidth) > 80) {
      issues.push(warning("table-overflow-risk", `Generated DOCX table ${tableNumber} tblW (${tableWidth} DXA) does not match tblGrid total (${gridWidth} DXA); Word may reflow columns unpredictably.`))
    }
    if (gridWidths.length > 6) {
      issues.push(warning("table-overflow-risk", `Generated DOCX table ${tableNumber} has ${gridWidths.length} columns; dense tables may compress in Word/PDF render output.`))
    }
    const longCells = tableCellTexts(table).filter((text) => text.length > 280 || text.split(/\r?\n/).length > 5)
    if (longCells.length) {
      issues.push(warning("table-overflow-risk", `Generated DOCX table ${tableNumber} contains long prose-heavy cells; use prose, bullets, callouts, or split rows when content is not comparable row/column data.`))
    }
  })
  return issues
}

function documentUsableWidthTwips(documentXml: string) {
  const sectionProperties = documentXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)?.at(-1)
  if (!sectionProperties) return undefined
  const pageSize = parseXmlAttributes(sectionProperties.match(/<w:pgSz\b[^>]*\/?>/)?.[0] ?? "")
  const margins = parseXmlAttributes(sectionProperties.match(/<w:pgMar\b[^>]*\/?>/)?.[0] ?? "")
  const pageWidth = numberAttr(pageSize, "w")
  if (!pageWidth) return undefined
  const left = numberAttr(margins, "left") ?? 1440
  const right = numberAttr(margins, "right") ?? 1440
  const gutter = numberAttr(margins, "gutter") ?? 0
  return Math.max(0, pageWidth - left - right - gutter)
}

function dxaWidthFromTag(tag: string | undefined) {
  if (!tag) return undefined
  const attrs = parseXmlAttributes(tag)
  const type = attrs["w:type"] ?? attrs.type
  if (type && type !== "dxa") return undefined
  return numberAttr(attrs, "w")
}

function numberAttr(attrs: Record<string, string>, localName: string) {
  const raw = attrs[`w:${localName}`] ?? attrs[localName]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function tableCellTexts(tableXml: string) {
  return (tableXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [])
    .map((cell) => xmlTextFrom(cell).replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function checkAccessibility(documentXml: string) {
  const issues: QualityIssue[] = []
  const imageDocPrs = documentXml.match(/<wp:docPr\b[^>]*\/>/g) ?? []
  const missingAlt = imageDocPrs.filter((tag) => {
    const attrs = parseXmlAttributes(tag)
    return !attrs.descr?.trim()
  })
  if (missingAlt.length) issues.push(warning("a11y-missing-image-alt", "Generated DOCX contains images without non-empty alt text descriptions."))

  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
  const missingHeaderRows = tables.filter((table) => !/<w:tblHeader\b/.test(table))
  if (missingHeaderRows.length) issues.push(warning("a11y-missing-table-header", "Generated DOCX contains tables without a repeated/header row flag."))

  const headingLevels = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => Number(match[0].match(/<w:pStyle\b[^>]*w:val="Heading([1-6])"/)?.[1]))
    .filter((level) => Number.isInteger(level) && level > 0)
  let previous = 0
  for (const level of headingLevels) {
    if (previous > 0 && level > previous + 1) {
      issues.push(warning("a11y-heading-level-skip", "Generated DOCX heading hierarchy skips a level."))
      break
    }
    previous = level
  }

  const hyperlinkTexts = (documentXml.match(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g) ?? []).map(xmlTextFrom)
  const weakLinks = hyperlinkTexts.filter((text) => /^(?:click here|here|link|read more|点击这里|点此|链接)$/i.test(text.trim()) || /^https?:\/\//i.test(text.trim()))
  if (weakLinks.length) issues.push(warning("a11y-nondescriptive-link-text", "Generated DOCX contains hyperlinks with non-descriptive text."))
  return issues
}

function checkDocumentXmlOrdering(documentXml: string) {
  const issues: QualityIssue[] = []
  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
  const repairProneTableProperties = tables.filter((table) => {
    const properties = table.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] ?? ""
    return appearsBefore(properties, "<w:tblLayout", "<w:tblBorders")
  })
  if (repairProneTableProperties.length) {
    issues.push(error("repair-prone-table-property-order", "Generated DOCX table properties use WordprocessingML element order that can trigger Microsoft Word repair mode."))
  }
  const paragraphProperties = documentXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/g) ?? []
  const repairProneParagraphProperties = paragraphProperties.filter((properties) => appearsBefore(properties, "<w:jc", "<w:spacing"))
  if (repairProneParagraphProperties.length) {
    issues.push(error("repair-prone-paragraph-property-order", "Generated DOCX paragraph properties use WordprocessingML element order that can trigger Microsoft Word repair mode."))
  }
  const sectionProperties = documentXml.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g) ?? []
  const repairProneSectionProperties = sectionProperties.filter((properties) => appearsBefore(properties, "<w:pgMar", "<w:pgSz"))
  if (repairProneSectionProperties.length) {
    issues.push(error("repair-prone-section-property-order", "Generated DOCX section properties use WordprocessingML element order that can trigger Microsoft Word repair mode."))
  }
  const tableCells = documentXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/g) ?? []
  const repairProneTableCells = tableCells.filter((properties) => appearsBefore(properties, "<w:shd", "<w:gridSpan"))
  if (repairProneTableCells.length) {
    issues.push(error("repair-prone-table-cell-property-order", "Generated DOCX table cell properties use WordprocessingML element order that can trigger Microsoft Word repair mode."))
  }
  return issues
}

function checkStylesXmlOrdering(stylesXml: string) {
  const issues: QualityIssue[] = []
  const paragraphProperties = stylesXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/g) ?? []
  const repairProneStyleProperties = paragraphProperties.filter((properties) => appearsBefore(properties, "<w:outlineLvl", "<w:spacing"))
  if (repairProneStyleProperties.length) {
    issues.push(error("repair-prone-style-property-order", "Generated DOCX style paragraph properties use WordprocessingML element order that can trigger Microsoft Word repair mode."))
  }
  return issues
}

function appearsBefore(text: string, earlier: string, later: string) {
  const earlierIndex = text.indexOf(earlier)
  const laterIndex = text.indexOf(later)
  return earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex
}

function strippedText(xml: string) {
  return xml.replace(/<[^>]+>/g, "").replace(/\s+/g, "")
}

function xmlTextFrom(xml: string) {
  return (xml.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
    .map((tag) => decodeXmlAttribute(tag.replace(/^<w:t\b[^>]*>/, "").replace(/<\/w:t>$/, "")))
    .join("")
}

type Relationship = {
  Id?: string
  Type?: string
  Target?: string
  TargetMode?: string
}

function parseRelationships(xml: string): Relationship[] {
  return (xml.match(/<Relationship\b[^>]*\/>/g) ?? []).map((tag) => parseXmlAttributes(tag))
}

function parseXmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of tag.matchAll(/\s([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]!] = decodeXmlAttribute(match[2]!)
  }
  return attrs
}

function decodeXmlAttribute(input: string) {
  return input
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function resolveRelationshipTarget(base: string, target: string) {
  if (/^[a-z]+:/i.test(target)) return target
  const segments = [...(base ? base.split("/") : []), ...target.split("/")].filter(Boolean)
  const normalized: string[] = []
  for (const segment of segments) {
    if (segment === ".") continue
    if (segment === "..") {
      if (!normalized.length) return `../${target}`
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }
  return normalized.join("/")
}

function formatError(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : String(errorValue)
}

function error(code: string, message: string): QualityIssue {
  return { severity: "error", code, message }
}

function warning(code: string, message: string): QualityIssue {
  return { severity: "warning", code, message }
}
