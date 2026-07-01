import { createRequire } from "node:module"
import type { BriefCardSpec, BriefCardsSpec, CalloutSpec, CodeBlockSpec, DefinitionListItemSpec, DocumentSection, EvidenceCardSpec, EvidenceCardsSpec, FigureSpec, FormFieldSpec, GeneratedExampleSpec, ParagraphRunSpec, ParagraphSpec, QuoteBlockSpec, RuleCardSpec, SourceBackedBlock, SourceListItemSpec, TableSpec, WordDocSpec, WordHeaderPattern, WordListItemSpec, WordListSpec } from "./types"
import type { ReportTheme, TextStyle } from "./themes/ReportTheme"
import { TeamGuidelineReportTheme } from "./themes/TeamGuidelineReportTheme"
import { resolveWordHeaderPattern, resolveWordTheme } from "./themes/WordDesignPresets"
import { tableCellAlignment, tableCellColSpan, tableCellRowSpan, tableCellText } from "./TableSpecUtils"

const nodeRequire = createRequire(__filename)

type ZipFile = {
  file(path: string, data: string | Uint8Array): void
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

type JsZipCtor = new () => ZipFile

type WordBuildContext = {
  figures: FigureBuildItem[]
  figureMap: WeakMap<FigureSpec, FigureBuildItem>
  tables: TableBuildItem[]
  tableMap: WeakMap<TableSpec, TableBuildItem>
  externalHyperlinkMap: WeakMap<ParagraphRunSpec, string>
  externalHyperlinks: ExternalHyperlinkBuildItem[]
  sectionBookmarkMap: WeakMap<DocumentSection, number>
  sectionBookmarkNameMap: WeakMap<DocumentSection, string>
  noteMap: WeakMap<ParagraphRunSpec, NoteBuildItem>
  footnotes: NoteBuildItem[]
  endnotes: NoteBuildItem[]
  includeSettings: boolean
  navigation: {
    mode: "field-toc" | "static-toc" | "none"
    tocBookmarkId?: number
    topBookmarkId?: number
    bottomBookmarkId?: number
    includeTopBottomLinks: boolean
    includeBackToTocLinks: boolean
  }
}

type FigureBuildItem = {
  figure: FigureSpec
  relId: string
  mediaPath: string
  target: string
  bytes: Uint8Array
  width: number
  height: number
  docPrId: number
  bookmarkId: number
}

type TableBuildItem = {
  table: TableSpec
  tableIndex: number
  bookmarkId: number
}

type ExternalHyperlinkBuildItem = {
  run: ParagraphRunSpec
  relId: string
  target: string
}

type NoteBuildItem = {
  run: ParagraphRunSpec
  id: number
  kind: "footnote" | "endnote"
  text: string
}

type RenderedListItem = {
  text: string
  level: 0 | 1 | 2
  checked?: boolean
}

type NumberingLevelSpec = {
  format: "bullet" | "decimal"
  text: string
  font?: string
}

const A4_WIDTH_TWIPS = 11906
const A4_HEIGHT_TWIPS = 16838
const LETTER_WIDTH_TWIPS = 12240
const LETTER_HEIGHT_TWIPS = 15840
const TABLE_INDENT_TWIPS = 120
const EMUS_PER_TWIP = 635
const EMUS_PER_PIXEL = 9525

export class WordDocBuilder {
  constructor(private readonly theme: ReportTheme = TeamGuidelineReportTheme) {}

  async build(spec: WordDocSpec): Promise<Uint8Array> {
    const JSZip = nodeRequire("jszip") as JsZipCtor
    const zip = new JSZip()
    const theme = resolveWordTheme(this.theme, spec.layout)
    const context = buildContext(spec)
    zip.file("[Content_Types].xml", contentTypesXml(context))
    zip.file("_rels/.rels", packageRelationshipsXml())
    zip.file("docProps/core.xml", corePropertiesXml(spec))
    zip.file("docProps/app.xml", appPropertiesXml())
    zip.file("word/_rels/document.xml.rels", documentRelationshipsXml(context))
    zip.file("word/styles.xml", stylesXml(theme))
    zip.file("word/numbering.xml", numberingXml())
    zip.file("word/header1.xml", headerXml(spec, theme))
    zip.file("word/footer1.xml", footerXml(theme, context))
    if (context.includeSettings) zip.file("word/settings.xml", settingsXml(spec))
    if (context.footnotes.length) zip.file("word/footnotes.xml", notesXml("footnote", context.footnotes, theme))
    if (context.endnotes.length) zip.file("word/endnotes.xml", notesXml("endnote", context.endnotes, theme))
    zip.file("word/document.xml", documentXml(spec, theme, context))
    for (const figure of context.figures) zip.file(figure.mediaPath, figure.bytes)
    return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  }
}

function buildContext(spec: WordDocSpec): WordBuildContext {
  const figures: FigureBuildItem[] = []
  const figureMap = new WeakMap<FigureSpec, FigureBuildItem>()
  const tables: TableBuildItem[] = []
  const tableMap = new WeakMap<TableSpec, TableBuildItem>()
  const externalHyperlinks: ExternalHyperlinkBuildItem[] = []
  const externalHyperlinkMap = new WeakMap<ParagraphRunSpec, string>()
  const sectionBookmarkMap = new WeakMap<DocumentSection, number>()
  const sectionBookmarkNameMap = new WeakMap<DocumentSection, string>()
  const noteMap = new WeakMap<ParagraphRunSpec, NoteBuildItem>()
  const footnotes: NoteBuildItem[] = []
  const endnotes: NoteBuildItem[] = []
  const allSections = [...spec.sections, ...(spec.appendices ?? [])]
  const navigationMode = spec.layout?.navigation?.mode ?? "field-toc"
  const navigation = {
    mode: navigationMode,
    includeTopBottomLinks: spec.layout?.navigation?.includeTopBottomLinks !== false,
    includeBackToTocLinks: spec.layout?.navigation?.includeBackToTocLinks !== false,
  }
  for (const section of allSections) {
    for (const figure of section.figures ?? []) {
      const index = figures.length + 1
      const bytes = figureBytes(figure)
      const item: FigureBuildItem = {
        figure,
        relId: `rIdImage${index}`,
        mediaPath: `word/media/image${index}.png`,
        target: `media/image${index}.png`,
        bytes,
        width: positivePixelDimension(figure.image.width),
        height: positivePixelDimension(figure.image.height),
        docPrId: index,
        bookmarkId: 1000 + index,
      }
      figures.push(item)
      figureMap.set(figure, item)
    }
    for (const table of section.tables ?? []) {
      const tableIndex = tables.length + 1
      const item: TableBuildItem = {
        table,
        tableIndex,
        bookmarkId: 2000 + tableIndex,
      }
      tables.push(item)
      tableMap.set(table, item)
    }
    for (const paragraph of section.richParagraphs ?? []) {
      for (const run of paragraph.runs ?? []) {
        const url = run.hyperlink?.url?.trim()
        if (!url) continue
        const index = externalHyperlinks.length + 1
        const relId = `rIdHyperlink${index}`
        externalHyperlinks.push({ run, relId, target: url })
        externalHyperlinkMap.set(run, relId)
      }
      for (const run of paragraph.runs ?? []) {
        const text = run.note?.text?.trim()
        if (!text) continue
        const kind = run.note?.kind === "endnote" ? "endnote" : "footnote"
        const bucket = kind === "endnote" ? endnotes : footnotes
        const item: NoteBuildItem = { run, id: bucket.length + 1, kind, text }
        bucket.push(item)
        noteMap.set(run, item)
      }
    }
  }
  let nextBookmarkId = 10_000 + figures.length + tables.length
  const usedBookmarkNames = new Set<string>()
  const navigationBookmarks: Partial<WordBuildContext["navigation"]> = {}
  if (navigation.mode === "static-toc") {
    navigationBookmarks.topBookmarkId = ++nextBookmarkId
    navigationBookmarks.tocBookmarkId = ++nextBookmarkId
    navigationBookmarks.bottomBookmarkId = ++nextBookmarkId
    usedBookmarkNames.add("Top")
    usedBookmarkNames.add("TOC")
    usedBookmarkNames.add("Bottom")
  }
  for (const [index, section] of allSections.entries()) {
    const rawBookmark = section.bookmark?.trim() || (navigation.mode === "static-toc" ? `sec_${index + 1}_${section.id || "section"}` : "")
    if (!rawBookmark) continue
    const bookmarkName = uniqueBookmarkName(safeBookmarkName(rawBookmark), usedBookmarkNames, `sec_${index + 1}`)
    nextBookmarkId += 1
    sectionBookmarkMap.set(section, nextBookmarkId)
    sectionBookmarkNameMap.set(section, bookmarkName)
  }
  return {
    figures,
    figureMap,
    tables,
    tableMap,
    externalHyperlinkMap,
    externalHyperlinks,
    sectionBookmarkMap,
    sectionBookmarkNameMap,
    noteMap,
    footnotes,
    endnotes,
    includeSettings: Boolean(spec.protection) || navigation.mode === "field-toc",
    navigation: { ...navigation, ...navigationBookmarks },
  }
}

function figureBytes(figure: FigureSpec) {
  if (figure.image.contentType !== "image/png") throw new Error(`Unsupported figure content type: ${figure.image.contentType}`)
  if (figure.image.bytes?.length) return figure.image.bytes
  if (figure.image.base64?.trim()) return Uint8Array.from(Buffer.from(figure.image.base64, "base64"))
  throw new Error(`Figure "${figure.title}" is missing PNG bytes.`)
}

function positivePixelDimension(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 1
}

function documentXml(spec: WordDocSpec, theme: ReportTheme, context: WordBuildContext) {
  const body: string[] = []
  if (context.navigation.mode === "static-toc" && context.navigation.topBookmarkId) body.push(bookmarkMarker("Top", context.navigation.topBookmarkId))
  body.push(...firstPageElements(spec, theme))
  body.push(pageBreak())
  if (context.navigation.mode !== "none") {
    if (context.navigation.mode === "static-toc") {
      body.push(heading("目录", 1, theme, false, "TOC", context.navigation.tocBookmarkId))
      if (context.navigation.includeTopBottomLinks) body.push(internalLinksParagraph([{ label: "Top", anchor: "Top" }, { label: "Bottom", anchor: "Bottom" }], theme))
      body.push(...staticTocElements(spec, theme, context))
    } else {
      body.push(heading("目录", 1, theme))
      body.push(tocField(theme))
      body.push(paragraph("提示：已写入 Word-native 目录域；当前远端渲染可检查缓存显示效果，真实目录页码刷新需在 Word 中更新域。", theme.styles.muted, "Muted"))
    }
    body.push(pageBreak())
  }
  if (spec.revisionHistory?.length) {
    body.push(heading("修订记录", 1, theme))
    body.push(table({
      headers: ["版本", "日期", "作者", "摘要"],
      rows: spec.revisionHistory.map((item) => [item.version, item.date, item.author, item.summary]),
    }, theme))
  }
  if (spec.executiveSummary) {
    body.push(heading("管理层摘要", 1, theme))
    for (const text of spec.executiveSummary.paragraphs) body.push(paragraph(text, theme.styles.body))
    if (spec.executiveSummary.highlights?.length) {
      body.push(table({
        headers: ["重点"],
        rows: spec.executiveSummary.highlights.map((item) => [item]),
      }, theme))
    }
  }
  for (const section of spec.sections) body.push(...sectionElements(section, theme, context))
  if (spec.references?.length) {
    if (!spec.sections.some((section) => section.title === "References")) body.push(heading("References", 1, theme))
    body.push(table({
      headers: ["来源", "路径", "说明"],
      rows: spec.references.map((ref) => [ref.title, ref.path ?? "", ref.note ?? ""]),
    }, theme))
  }
  if (spec.qualityChecklist) {
    body.push(heading("假设、限制与风险", 1, theme))
    body.push(table({
      headers: ["类别", "内容"],
      rows: [
        ["假设", spec.qualityChecklist.assumptions.join("\n")],
        ["限制", spec.qualityChecklist.limitations.join("\n")],
        ["缺失输入", spec.qualityChecklist.missingInputs.join("\n") || "无"],
        ["风险", spec.qualityChecklist.risks.join("\n")],
      ],
    }, theme))
  }
  for (const appendix of spec.appendices ?? []) body.push(...sectionElements(appendix, theme, context, true))
  if (context.navigation.mode === "static-toc" && context.navigation.bottomBookmarkId) body.push(bookmarkMarker("Bottom", context.navigation.bottomBookmarkId))
  body.push(sectionProperties(theme))
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    "<w:body>",
    body.join(""),
    "</w:body>",
    "</w:document>",
  ].join("")
}

function firstPageElements(spec: WordDocSpec, theme: ReportTheme) {
  const pattern = resolveWordHeaderPattern(spec.layout)
  if (pattern !== "none") return headerPatternElements(pattern, spec, theme)
  return coverElements(spec, theme)
}

function coverElements(spec: WordDocSpec, theme: ReportTheme) {
  const cover = spec.cover
  return [
    paragraph(cover?.title ?? spec.metadata.title, theme.styles.coverTitle, "Title", "center"),
    paragraph(cover?.subtitle ?? spec.metadata.subtitle ?? "", theme.styles.coverSubtitle, "Subtitle", "center"),
    paragraph(`文档类型：${spec.metadata.documentType}`, theme.styles.body, undefined, "center"),
    paragraph(`生成时间：${spec.metadata.generatedAt.slice(0, 10)}`, theme.styles.body, undefined, "center"),
    paragraph(cover?.preparedFor ? `适用对象：${cover.preparedFor}` : "", theme.styles.body, undefined, "center"),
    paragraph(cover?.preparedBy ? `编制：${cover.preparedBy}` : "", theme.styles.body, undefined, "center"),
  ].filter(Boolean)
}

function headerPatternElements(pattern: WordHeaderPattern, spec: WordDocSpec, theme: ReportTheme) {
  const cover = spec.cover
  const title = cover?.title ?? spec.metadata.title
  const subtitle = cover?.subtitle ?? spec.metadata.subtitle ?? spec.metadata.documentType
  const metadataRows = firstPageMetadataRows(spec)
  if (pattern === "proposal_centerpiece") {
    return [
      paragraph(spec.metadata.documentType, { ...theme.styles.muted, bold: true }, "Muted", "center"),
      paragraph(title, { ...theme.styles.coverTitle, sizeHalfPoints: Math.max(theme.styles.coverTitle.sizeHalfPoints, 48) }, "Title", "center"),
      paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle", "center"),
      table({
        headers: ["项目", "信息"],
        rows: metadataRows,
        columnWidthRatios: [0.28, 0.72],
        repeatHeader: false,
      }, theme),
    ]
  }
  if (pattern === "editorial_cover") {
    return [
      paragraph(spec.metadata.documentType, { ...theme.styles.muted, bold: true, color: theme.colors.secondary }, "Muted", "center"),
      paragraph(title, { ...theme.styles.coverTitle, sizeHalfPoints: Math.max(theme.styles.coverTitle.sizeHalfPoints, 52) }, "Title", "center"),
      paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle", "center"),
      paragraph(spec.metadata.sourceSummary ?? "", theme.styles.muted, "Muted", "center"),
    ]
  }
  if (pattern === "customer_pack") {
    return [
      paragraph(spec.metadata.documentType, { ...theme.styles.muted, bold: true }, "Muted"),
      paragraph(title, theme.styles.coverTitle, "Title"),
      paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle"),
      table({
        headers: ["字段", "内容"],
        rows: metadataRows,
        columnWidthRatios: [0.24, 0.76],
        repeatHeader: false,
      }, theme),
    ]
  }
  if (pattern === "workshop_agenda") {
    return [
      paragraph(title, theme.styles.coverTitle, "Title"),
      paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle"),
      table({
        headers: ["时间", "对象", "目标"],
        rows: [[spec.metadata.generatedAt.slice(0, 10), cover?.preparedFor ?? "待定", spec.metadata.documentType]],
        columnWidthRatios: [0.22, 0.28, 0.5],
        repeatHeader: false,
      }, theme),
    ]
  }
  if (pattern === "customer_story") {
    return [
      paragraph(spec.metadata.documentType, { ...theme.styles.muted, bold: true }, "Muted", "center"),
      paragraph(title, theme.styles.coverTitle, "Title", "center"),
      paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle", "center"),
      paragraph(firstHighlight(spec), { ...theme.styles.body, italic: true, sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints + 2, 24), color: theme.colors.secondary }, "Quote", "center"),
    ]
  }
  return [
    paragraph(spec.metadata.documentType.toUpperCase(), { ...theme.styles.muted, bold: true, color: theme.colors.primary }, "Muted"),
    paragraph(title, theme.styles.coverTitle, "Title"),
    paragraph(subtitle, theme.styles.coverSubtitle, "Subtitle"),
    table({
      headers: ["字段", "内容"],
      rows: metadataRows,
      columnWidthRatios: [0.22, 0.78],
      repeatHeader: false,
    }, theme),
  ]
}

function firstPageMetadataRows(spec: WordDocSpec) {
  const cover = spec.cover
  return [
    ["Document Type", spec.metadata.documentType],
    ["Generated", spec.metadata.generatedAt.slice(0, 10)],
    ["Prepared For", cover?.preparedFor ?? ""],
    ["Prepared By", cover?.preparedBy ?? spec.metadata.author ?? "ChipMate"],
  ].filter(([, value]) => value.trim())
}

function firstHighlight(spec: WordDocSpec) {
  return spec.executiveSummary?.highlights?.[0]?.trim()
    || spec.executiveSummary?.paragraphs?.[0]?.trim()
    || spec.metadata.sourceSummary?.trim()
    || spec.metadata.documentType
}

function sectionElements(section: DocumentSection, theme: ReportTheme, context: WordBuildContext, appendix = false) {
  const bookmarkName = context.sectionBookmarkNameMap.get(section) ?? section.bookmark
  const rows: string[] = [heading(section.title, section.level, theme, appendix, bookmarkName, context.sectionBookmarkMap.get(section))]
  if (context.navigation.mode === "static-toc" && context.navigation.includeBackToTocLinks) rows.push(internalLinksParagraph([{ label: "返回目录", anchor: "TOC" }], theme))
  if (section.briefCards?.length) rows.push(briefCardsTable({ cards: section.briefCards }, theme))
  for (const text of section.paragraphs ?? []) rows.push(paragraph(text, theme.styles.body))
  for (const richParagraph of section.richParagraphs ?? []) rows.push(richParagraphXml(richParagraph, theme, context))
  if (section.definitionList?.length) rows.push(definitionListTable(section.definitionList, theme))
  if (section.sourceList?.length) rows.push(sourceListTable(section.sourceList, theme))
  if (section.evidenceCards?.length) rows.push(evidenceCardsTable({ cards: section.evidenceCards }, theme))
  for (const item of section.bullets ?? []) rows.push(listParagraph(item, theme.styles.body, 1))
  for (const item of section.numberedItems ?? []) rows.push(listParagraph(item, theme.styles.body, 2))
  for (const list of section.lists ?? []) rows.push(...listElements(list, theme))
  for (const figure of section.figures ?? []) rows.push(...figureElements(figure, theme, context))
  for (const quoteBlock of section.quoteBlocks ?? []) rows.push(...quoteBlockElements(quoteBlock, theme))
  for (const callout of section.callouts ?? []) rows.push(calloutTable(callout, theme))
  for (const tableSpec of section.tables ?? []) rows.push(table(tableSpec, theme, context))
  if (section.formFields?.length) rows.push(formFieldsTable(section.formFields, theme))
  for (const block of section.sourceBackedBlocks ?? []) rows.push(...sourceBackedBlockElements(block, theme))
  for (const ruleCard of section.ruleCards ?? []) {
    rows.push(ruleCardTable(ruleCard, theme))
    for (const block of ruleCard.preservedExamples ?? []) rows.push(...sourceBackedBlockElements(block, theme, "保留示例"))
    for (const example of ruleCard.generatedExamples ?? []) rows.push(generatedExampleTable(example, theme))
    for (const block of ruleCard.sourceBackedBlocks ?? []) rows.push(...sourceBackedBlockElements(block, theme))
  }
  for (const codeBlock of section.codeBlocks ?? []) rows.push(codeBlockTable(codeBlock, theme))
  return rows
}

function heading(text: string, level: 1 | 2 | 3, theme: ReportTheme, appendix = false, bookmark?: string, bookmarkId?: number) {
  const style = level === 1 ? theme.styles.heading1 : level === 2 ? theme.styles.heading2 : theme.styles.heading3
  const styleId = level === 1 ? "Heading1" : level === 2 ? "Heading2" : "Heading3"
  const resolvedStyle = appendix ? { ...style, ...theme.styles.appendix } : style
  const safeBookmark = bookmark ? safeBookmarkName(bookmark) : ""
  if (!safeBookmark || !bookmarkId) return paragraph(text, resolvedStyle, styleId)
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${xmlAttr(styleId)}"/>`,
    `<w:spacing w:before="${resolvedStyle.spacingBefore ?? 0}" w:after="${resolvedStyle.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    `<w:bookmarkStart w:id="${bookmarkId}" w:name="${xmlAttr(safeBookmark)}"/>`,
    run(text, resolvedStyle),
    `<w:bookmarkEnd w:id="${bookmarkId}"/>`,
    "</w:p>",
  ].join("")
}

function paragraph(text: string, style: TextStyle, styleId = "Normal", alignment?: "center" | "right") {
  if (!text.trim()) return ""
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${xmlAttr(styleId)}"/>`,
    `<w:spacing w:before="${style.spacingBefore ?? 0}" w:after="${style.spacingAfter ?? 0}"/>`,
    alignment ? `<w:jc w:val="${alignment}"/>` : "",
    "</w:pPr>",
    run(text, style),
    "</w:p>",
  ].join("")
}

function paragraphWithRuns(runs: string[], style: TextStyle, styleId = "Normal", alignment?: "center" | "right") {
  const content = runs.filter(Boolean).join("")
  if (!content) return ""
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${xmlAttr(styleId)}"/>`,
    `<w:spacing w:before="${style.spacingBefore ?? 0}" w:after="${style.spacingAfter ?? 0}"/>`,
    alignment ? `<w:jc w:val="${alignment}"/>` : "",
    "</w:pPr>",
    content,
    "</w:p>",
  ].join("")
}

function richParagraphXml(spec: ParagraphSpec, theme: ReportTheme, context: WordBuildContext) {
  const style = spec.style === "muted" ? theme.styles.muted : theme.styles.body
  const styleId = spec.style === "muted" ? "Muted" : "Normal"
  const runs = (spec.runs ?? []).map((item) => richRunXml(item, style, context)).filter(Boolean).join("")
  if (!runs) return ""
  const alignment = spec.alignment === "center" || spec.alignment === "right" ? spec.alignment : undefined
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${xmlAttr(styleId)}"/>`,
    `<w:spacing w:before="${style.spacingBefore ?? 0}" w:after="${style.spacingAfter ?? 0}"/>`,
    alignment ? `<w:jc w:val="${alignment}"/>` : "",
    "</w:pPr>",
    runs,
    "</w:p>",
  ].join("")
}

function quoteBlockElements(spec: QuoteBlockSpec, theme: ReportTheme) {
  const text = spec.text?.trim()
  if (!text) return []
  const pullQuote = spec.kind === "pullQuote"
  const styleId = pullQuote ? "IntenseQuote" : "Quote"
  const style = pullQuote
    ? { ...theme.styles.body, italic: true, bold: true, sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints + 4, 26), color: theme.colors.secondary }
    : { ...theme.styles.muted, italic: true, sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints, theme.styles.muted.sizeHalfPoints) }
  const alignment = pullQuote ? "center" as const : undefined
  const attribution = [spec.attribution, spec.source].filter((item): item is string => Boolean(item?.trim())).join(" - ")
  return [
    paragraph(text, style, styleId, alignment),
    attribution ? paragraph(`- ${attribution}`, theme.styles.muted, "Muted", alignment) : "",
  ].filter(Boolean)
}

function richRunXml(spec: ParagraphRunSpec, style: TextStyle, context: WordBuildContext) {
  if (spec.note?.text?.trim()) return noteReferenceXml(spec, context)
  if (spec.reference?.bookmark?.trim()) return referenceFieldXml(spec, style)
  const text = spec.text ?? spec.hyperlink?.url ?? spec.hyperlink?.anchor ?? ""
  if (!text.trim()) return ""
  const runStyle = { ...style, bold: spec.bold ?? style.bold, italic: spec.italic ?? style.italic }
  if (spec.hyperlink?.url?.trim()) {
    const relId = context.externalHyperlinkMap.get(spec)
    if (!relId) return run(text, runStyle)
    return [
      `<w:hyperlink r:id="${xmlAttr(relId)}"${spec.hyperlink.tooltip ? ` w:tooltip="${xmlAttr(spec.hyperlink.tooltip)}"` : ""}>`,
      run(text, runStyle, { color: "0563C1", underline: true }),
      "</w:hyperlink>",
    ].join("")
  }
  if (spec.hyperlink?.anchor?.trim()) {
    const anchor = safeBookmarkName(spec.hyperlink.anchor)
    if (!anchor) return run(text, runStyle)
    return [
      `<w:hyperlink w:anchor="${xmlAttr(anchor)}"${spec.hyperlink.tooltip ? ` w:tooltip="${xmlAttr(spec.hyperlink.tooltip)}"` : ""}>`,
      run(text, runStyle, { color: "0563C1", underline: true }),
      "</w:hyperlink>",
    ].join("")
  }
  const markerRuns = richTextWithCrossReferenceMarkersXml(text, runStyle)
  if (markerRuns) return markerRuns
  return run(text, runStyle)
}

function noteReferenceXml(spec: ParagraphRunSpec, context: WordBuildContext) {
  const item = context.noteMap.get(spec)
  if (!item) return ""
  const tag = item.kind === "endnote" ? "endnoteReference" : "footnoteReference"
  return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${tag} w:id="${item.id}"/></w:r>`
}

function referenceFieldXml(spec: ParagraphRunSpec, style: TextStyle) {
  const reference = spec.reference
  if (!reference?.bookmark?.trim()) return ""
  const field = reference.field === "PAGEREF" ? "PAGEREF" : "REF"
  const bookmark = safeBookmarkName(reference.bookmark)
  if (!bookmark) return ""
  const fallbackText = reference.fallbackText?.trim() || spec.text?.trim() || bookmark
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ${field} ${xmlText(bookmark)} \\h </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    run(fallbackText, style),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("")
}

function richTextWithCrossReferenceMarkersXml(text: string, style: TextStyle) {
  const markerPattern = /\{\{\s*(ref|pageref)\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})(?:\|([^{}]{0,200}))?\s*\}\}/gi
  let cursor = 0
  let found = false
  const runs: string[] = []
  for (const match of text.matchAll(markerPattern)) {
    const start = match.index ?? 0
    const full = match[0] ?? ""
    if (start > cursor) runs.push(run(text.slice(cursor, start), style))
    const bookmark = safeBookmarkName(match[2] ?? "")
    if (bookmark) {
      const field = (match[1] ?? "").toUpperCase() === "PAGEREF" ? "PAGEREF" : "REF"
      const fallbackText = (match[3] ?? "").trim() || bookmark
      runs.push(referenceFieldXml({
        text: fallbackText,
        reference: { bookmark, field, fallbackText },
      }, style))
    } else {
      runs.push(run(full, style))
    }
    found = true
    cursor = start + full.length
  }
  if (!found) return ""
  if (cursor < text.length) runs.push(run(text.slice(cursor), style))
  return runs.filter(Boolean).join("")
}

function listElements(spec: WordListSpec, theme: ReportTheme) {
  const rows: string[] = []
  if (spec.title?.trim()) rows.push(paragraph(spec.title, theme.styles.muted, "Muted"))
  for (const item of flattenListItems(spec.items ?? [])) {
    rows.push(listParagraph(item.text, theme.styles.body, listNumId(spec.kind, item), item.level))
  }
  return rows
}

function flattenListItems(items: WordListItemSpec[], parentLevel: 0 | 1 | 2 = 0): RenderedListItem[] {
  const rows: RenderedListItem[] = []
  for (const item of items) {
    const level = normalizeListLevel(item.level, parentLevel)
    const text = typeof item.text === "string" ? item.text.trim() : ""
    if (text) rows.push({ text, level, checked: item.checked })
    if (Array.isArray(item.children) && item.children.length) {
      rows.push(...flattenListItems(item.children, normalizeListLevel(undefined, level + 1)))
    }
  }
  return rows
}

function normalizeListLevel(value: unknown, fallback: number): 0 | 1 | 2 {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.min(2, Math.trunc(numeric))) as 0 | 1 | 2
}

function listNumId(kind: WordListSpec["kind"], item: RenderedListItem) {
  if (kind === "numbered") return 2
  if (kind === "checklist") return item.checked ? 4 : 3
  return 1
}

function listParagraph(text: string, style: TextStyle, numId: number, level: 0 | 1 | 2 = 0) {
  if (!text.trim()) return ""
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="ListParagraph"/>',
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`,
    `<w:spacing w:before="${style.spacingBefore ?? 0}" w:after="${style.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    run(text, style),
    "</w:p>",
  ].join("")
}

function run(text: string, style: TextStyle, overrides?: { color?: string; underline?: boolean }) {
  const color = overrides?.color ?? style.color
  return [
    "<w:r><w:rPr>",
    style.font ? `<w:rFonts w:ascii="${xmlAttr(style.font)}" w:hAnsi="${xmlAttr(style.font)}" w:eastAsia="${xmlAttr(style.font)}"/>` : "",
    style.bold ? "<w:b/>" : "",
    style.italic ? "<w:i/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    overrides?.underline ? '<w:u w:val="single"/>' : "",
    `<w:sz w:val="${style.sizeHalfPoints}"/>`,
    "</w:rPr>",
    ...textRuns(text),
    "</w:r>",
  ].join("")
}

function fieldRun(instruction: string, fallbackText: string, style: TextStyle) {
  return [
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ${xmlText(instruction)} </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    run(fallbackText, style),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("")
}

function textRuns(text: string) {
  const lines = text.split(/\r?\n/)
  const result: string[] = []
  lines.forEach((line, index) => {
    if (index > 0) result.push("<w:br/>")
    result.push(`<w:t xml:space="preserve">${xmlText(line)}</w:t>`)
  })
  return result
}

function table(spec: TableSpec, theme: ReportTheme, context?: WordBuildContext) {
  const columnWidths = spec.columnWidthRatios?.length === spec.headers.length
    ? distributeByRatios(pageTextWidth(theme), spec.columnWidthRatios)
    : genericTableColumnWidths(spec.headers, theme)
  const item = context?.tableMap.get(spec)
  const rows = [
    tableRow(spec.headers.map((header, index) => tableCell(header, theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[index], spec.columnAlignments?.[index] ?? "center")), spec.repeatHeader !== false),
    tableBodyRows(spec, theme, columnWidths),
  ].join("")
  return [
    item && (spec.caption || spec.label || spec.bookmark) ? tableCaptionParagraph(spec, item, theme) : spec.caption ? paragraph(spec.caption, theme.styles.muted) : "",
    "<w:tbl>",
    tableProperties(theme, theme.table.borderSize, columnWidths),
    rows,
    "</w:tbl>",
  ].join("")
}

function tableBodyRows(spec: TableSpec, theme: ReportTheme, columnWidths: number[]) {
  const activeRowSpans = new Map<number, { remaining: number; colSpan: number }>()
  return spec.rows.map((row) => {
    const cells: string[] = []
    let rowCellIndex = 0
    for (let columnIndex = 0; columnIndex < columnWidths.length;) {
      const active = activeRowSpans.get(columnIndex)
      if (active) {
        cells.push(tableCell("", theme.styles.tableCell, theme, undefined, active.colSpan > 1 ? active.colSpan : undefined, sum(columnWidths.slice(columnIndex, columnIndex + active.colSpan)), undefined, { vMerge: "continue" }))
        active.remaining -= 1
        if (active.remaining <= 0) activeRowSpans.delete(columnIndex)
        columnIndex += active.colSpan
        continue
      }
      const rawCell = row[rowCellIndex++]
      const colSpan = Math.min(tableCellColSpan(rawCell), columnWidths.length - columnIndex)
      const rowSpan = tableCellRowSpan(rawCell)
      if (rowSpan > 1) activeRowSpans.set(columnIndex, { remaining: rowSpan - 1, colSpan })
      cells.push(tableCell(
        tableCellText(rawCell),
        theme.styles.tableCell,
        theme,
        undefined,
        colSpan > 1 ? colSpan : undefined,
        sum(columnWidths.slice(columnIndex, columnIndex + colSpan)),
        tableCellAlignment(rawCell) ?? spec.columnAlignments?.[columnIndex],
        rowSpan > 1 ? { vMerge: "restart" } : undefined,
      ))
      columnIndex += colSpan
    }
    return tableRow(cells)
  }).join("")
}

function tableCaptionParagraph(spec: TableSpec, item: TableBuildItem, theme: ReportTheme) {
  const label = spec.label?.trim() || "Table"
  const number = spec.number?.trim() || String(item.tableIndex)
  const caption = spec.caption?.trim()
  const bookmark = safeBookmarkName(spec.bookmark || spec.id || `tbl_${item.tableIndex}`)
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="Caption"/>',
    `<w:spacing w:before="${theme.styles.muted.spacingBefore ?? 0}" w:after="${theme.styles.muted.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    bookmark ? `<w:bookmarkStart w:id="${item.bookmarkId}" w:name="${xmlAttr(bookmark)}"/>` : "",
    run(`${label} `, theme.styles.muted),
    seqFieldXml(label, number, theme.styles.muted),
    bookmark ? `<w:bookmarkEnd w:id="${item.bookmarkId}"/>` : "",
    caption ? run(`: ${caption}`, theme.styles.muted) : "",
    "</w:p>",
  ].join("")
}

function definitionListTable(items: DefinitionListItemSpec[], theme: ReportTheme) {
  const columnWidths = distributeByRatios(pageTextWidth(theme), [30, 70])
  const rows = [
    tableRow([
      tableCell("术语", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[0], "center"),
      tableCell("定义 / 说明", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[1], "center"),
    ]),
    ...items
      .filter((item) => item.term?.trim() && item.definition?.trim())
      .map((item) => tableRow([
        tableCell(item.term, { ...theme.styles.tableCell, bold: true }, theme, undefined, undefined, columnWidths[0]),
        tableCell([item.definition, item.note ? `备注：${item.note}` : ""].filter(Boolean).join("\n"), theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
      ])),
  ].join("")
  return ["<w:tbl>", tableProperties(theme, theme.table.borderSize, columnWidths), rows, "</w:tbl>"].join("")
}

function sourceListTable(items: SourceListItemSpec[], theme: ReportTheme) {
  const columnWidths = distributeByRatios(pageTextWidth(theme), [28, 18, 30, 24])
  const rows = [
    tableRow([
      tableCell("来源", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[0], "center"),
      tableCell("角色", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[1], "center"),
      tableCell("路径", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[2], "center"),
      tableCell("说明", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[3], "center"),
    ]),
    ...items
      .filter((item) => item.title?.trim() || item.sourceId?.trim())
      .map((item) => tableRow([
        tableCell([item.sourceId, item.title].filter(Boolean).join("\n"), theme.styles.tableCell, theme, undefined, undefined, columnWidths[0]),
        tableCell([item.role, item.origin].filter(Boolean).join("\n"), theme.styles.tableCell, theme, undefined, undefined, columnWidths[1], "center"),
        tableCell(item.path ?? "", theme.styles.tableCell, theme, undefined, undefined, columnWidths[2]),
        tableCell(item.note ?? "", theme.styles.tableCell, theme, undefined, undefined, columnWidths[3]),
      ])),
  ].join("")
  return ["<w:tbl>", tableProperties(theme, theme.table.borderSize, columnWidths), rows, "</w:tbl>"].join("")
}

function briefCardsTable(spec: BriefCardsSpec, theme: ReportTheme) {
  const cards = (spec.cards ?? []).filter((card) => card.title?.trim())
  if (!cards.length) return ""
  const columns = briefCardColumns(spec.columns, cards.length)
  const columnWidths = distributeByRatios(pageTextWidth(theme), Array.from({ length: columns }, () => 1))
  const rows: string[] = []
  for (let index = 0; index < cards.length; index += columns) {
    const rowCards = cards.slice(index, index + columns)
    const cells = rowCards.map((card, cellIndex) => briefCardCell(card, theme, columnWidths[cellIndex] ?? columnWidths[0]))
    while (cells.length < columns) cells.push(rawTableCell(paragraph(" ", theme.styles.tableCell), theme, undefined, columnWidths[cells.length] ?? columnWidths[0]))
    rows.push(tableRow(cells))
  }
  return ["<w:tbl>", tableProperties(theme, theme.callout.borderSize, columnWidths), rows.join(""), "</w:tbl>"].join("")
}

function briefCardColumns(columns: BriefCardsSpec["columns"], cardCount: number) {
  if (columns === 1 || columns === 2 || columns === 3) return columns
  if (cardCount === 1) return 1
  return cardCount >= 3 ? 3 : 2
}

function briefCardCell(card: BriefCardSpec, theme: ReportTheme, width: number) {
  const valueStyle = {
    ...theme.styles.body,
    bold: true,
    sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints + 4, 26),
    color: theme.colors.primary,
  }
  const titleStyle = { ...theme.styles.tableCell, bold: true, color: theme.colors.secondary }
  const content = [
    paragraph(card.title, titleStyle),
    card.value?.trim() ? paragraph(card.value.trim(), valueStyle) : "",
    card.body?.trim() ? paragraph(card.body.trim(), theme.styles.tableCell) : "",
    card.footer?.trim() ? paragraph(card.footer.trim(), theme.styles.muted, "Muted") : "",
  ].filter(Boolean).join("")
  return rawTableCell(content || paragraph(" ", theme.styles.tableCell), theme, briefCardFill(card, theme), width)
}

function briefCardFill(card: BriefCardSpec, theme: ReportTheme) {
  if (card.tone === "warning") return theme.colors.warning
  if (card.tone === "risk") return theme.colors.danger
  if (card.tone === "success") return theme.colors.success
  if (card.tone === "info") return theme.callout.fill
  return theme.colors.surface
}

function evidenceCardsTable(spec: EvidenceCardsSpec, theme: ReportTheme) {
  const cards = (spec.cards ?? []).filter((card) => card.title?.trim() && card.summary?.trim())
  if (!cards.length) return ""
  const columns = evidenceCardColumns(spec.columns, cards.length)
  const columnWidths = distributeByRatios(pageTextWidth(theme), Array.from({ length: columns }, () => 1))
  const rows: string[] = []
  for (let index = 0; index < cards.length; index += columns) {
    const rowCards = cards.slice(index, index + columns)
    const cells = rowCards.map((card, cellIndex) => evidenceCardCell(card, theme, columnWidths[cellIndex] ?? columnWidths[0]))
    while (cells.length < columns) cells.push(rawTableCell(paragraph(" ", theme.styles.tableCell), theme, undefined, columnWidths[cells.length] ?? columnWidths[0]))
    rows.push(tableRow(cells))
  }
  return ["<w:tbl>", tableProperties(theme, theme.example.borderSize, columnWidths), rows.join(""), "</w:tbl>"].join("")
}

function evidenceCardColumns(columns: EvidenceCardsSpec["columns"], cardCount: number) {
  if (columns === 1 || columns === 2) return columns
  return cardCount === 1 ? 1 : 2
}

function evidenceCardCell(card: EvidenceCardSpec, theme: ReportTheme, width: number) {
  const titleStyle = { ...theme.styles.ruleCardTitle, sizeHalfPoints: Math.max(theme.styles.tableCell.sizeHalfPoints + 2, theme.styles.ruleCardTitle.sizeHalfPoints - 2) }
  const meta = evidenceCardMetadata(card)
  const content = [
    paragraph(card.title, titleStyle),
    paragraph(card.summary, theme.styles.tableCell),
    card.quote?.trim() ? paragraph(card.quote.trim(), { ...theme.styles.muted, italic: true }, "Quote") : "",
    meta ? paragraph(meta, theme.styles.muted, "Muted") : "",
  ].filter(Boolean).join("")
  return rawTableCell(content || paragraph(" ", theme.styles.tableCell), theme, evidenceCardFill(card, theme), width)
}

function evidenceCardMetadata(card: EvidenceCardSpec) {
  const rows = [
    card.source ? `来源：${card.source}` : "",
    card.path ? `路径：${card.path}` : "",
    card.locator ? `定位：${card.locator}` : "",
    card.role ? `角色：${card.role}` : "",
    card.confidence ? `置信度：${card.confidence}` : "",
    card.sourceRefs?.length ? `引用：${card.sourceRefs.join(", ")}` : "",
  ]
  return rows.filter(Boolean).join("\n")
}

function evidenceCardFill(card: EvidenceCardSpec, theme: ReportTheme) {
  if (card.role === "contradictory") return theme.colors.warning
  if (card.confidence === "low") return theme.colors.warning
  if (card.role === "primary") return theme.example.preservedFill
  return theme.colors.surface
}

function ruleCardTable(rule: RuleCardSpec, theme: ReportTheme) {
  const columnWidths = ruleCardColumnWidths(theme)
  const rows = [
    tableRow([tableCell(`${rule.ruleId} ${rule.name}`, theme.styles.ruleCardTitle, theme, theme.ruleCard.fill, 2, sum(columnWidths))]),
    tableRow([
      tableCell("强制级别", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.priority, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("适用范围", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.scope, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("规则说明", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.description, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("推荐写法", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.recommended ?? "按团队规则和上下文实现。", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("不推荐写法", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.discouraged ?? "避免无边界、无依据或不可维护的实现。", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("理由", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.rationale ?? "降低缺陷率，提升一致性和可维护性。", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("例外情况", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.exceptions ?? "例外需说明原因并经过评审。", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("来源依据", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.sources.join("\n"), theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("团队落地建议", theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(rule.rolloutAdvice ?? "纳入 Code Review Checklist。", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    ...(rule.sourceDerivedItems ?? []).map((item) => tableRow([
      tableCell(item.label, theme.styles.ruleCardLabel, theme, theme.ruleCard.labelFill, undefined, columnWidths[0]),
      tableCell(`${item.text}\n来源：${item.sourceRefs.join("\n")}`, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ])),
  ].join("")
  return ["<w:tbl>", tableProperties(theme, theme.ruleCard.borderSize, columnWidths), rows, "</w:tbl>"].join("")
}

function codeBlockTable(spec: CodeBlockSpec, theme: ReportTheme) {
  const columnWidths = [pageTextWidth(theme)]
  return [
    spec.caption ? paragraph(spec.caption, theme.styles.muted) : "",
    "<w:tbl>",
    tableProperties(theme, theme.codeBlock.borderSize, columnWidths),
    tableRow([tableCell(spec.code, { ...theme.styles.code, font: theme.fonts.code }, theme, theme.codeBlock.fill, undefined, columnWidths[0])]),
    "</w:tbl>",
  ].join("")
}

function figureElements(figure: FigureSpec, theme: ReportTheme, context: WordBuildContext) {
  const item = context.figureMap.get(figure)
  if (!item) return []
  return [
    figure.title ? paragraph(figure.title, theme.styles.muted, "Muted", "center") : "",
    figureDrawingParagraph(figure, item, theme),
    figure.caption || figure.label || figure.bookmark ? figureCaptionParagraph(figure, item, theme) : "",
  ].filter(Boolean)
}

function figureCaptionParagraph(figure: FigureSpec, item: FigureBuildItem, theme: ReportTheme) {
  const label = figure.label?.trim() || "Figure"
  const number = figure.number?.trim() || String(item.docPrId)
  const caption = figure.caption?.trim()
  const bookmark = safeBookmarkName(figure.bookmark || figure.id || `fig_${item.docPrId}`)
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="Caption"/>',
    `<w:spacing w:before="${theme.styles.muted.spacingBefore ?? 0}" w:after="${theme.styles.muted.spacingAfter ?? 0}"/>`,
    '<w:jc w:val="center"/>',
    "</w:pPr>",
    bookmark ? `<w:bookmarkStart w:id="${item.bookmarkId}" w:name="${xmlAttr(bookmark)}"/>` : "",
    run(`${label} `, theme.styles.muted),
    seqFieldXml(label, number, theme.styles.muted),
    bookmark ? `<w:bookmarkEnd w:id="${item.bookmarkId}"/>` : "",
    caption ? run(`: ${caption}`, theme.styles.muted) : "",
    "</w:p>",
  ].join("")
}

function seqFieldXml(label: string, cachedNumber: string, style: TextStyle) {
  const sequenceId = sequenceIdentifier(label)
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> SEQ ${xmlText(sequenceId)} \\* ARABIC </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    run(cachedNumber, style),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("")
}

function sequenceIdentifier(label: string) {
  const normalized = label.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : "Figure"
}

function figureDrawingParagraph(figure: FigureSpec, item: FigureBuildItem, theme: ReportTheme) {
  const size = figureSizeEmu(item, theme)
  const name = figure.title || `Figure ${item.docPrId}`
  const description = figure.altText || figure.caption || figure.title
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:spacing w:before="${theme.styles.body.spacingBefore ?? 0}" w:after="${theme.styles.body.spacingAfter ?? 0}"/>`,
    '<w:jc w:val="center"/>',
    "</w:pPr>",
    "<w:r><w:drawing>",
    '<wp:inline distT="0" distB="0" distL="0" distR="0">',
    `<wp:extent cx="${size.cx}" cy="${size.cy}"/>`,
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
    `<wp:docPr id="${item.docPrId}" name="${xmlAttr(name)}" descr="${xmlAttr(description)}"/>`,
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    "<pic:pic>",
    `<pic:nvPicPr><pic:cNvPr id="${item.docPrId}" name="${xmlAttr(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${xmlAttr(item.relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${size.cx}" cy="${size.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`,
    "</pic:pic>",
    "</a:graphicData></a:graphic>",
    "</wp:inline>",
    "</w:drawing></w:r>",
    "</w:p>",
  ].join("")
}

function figureSizeEmu(item: FigureBuildItem, theme: ReportTheme) {
  const maxCx = pageTextWidth(theme) * EMUS_PER_TWIP
  const rawCx = Math.max(1, item.width) * EMUS_PER_PIXEL
  const rawCy = Math.max(1, item.height) * EMUS_PER_PIXEL
  const scale = Math.min(1, maxCx / rawCx)
  return {
    cx: Math.max(1, Math.round(rawCx * scale)),
    cy: Math.max(1, Math.round(rawCy * scale)),
  }
}

function calloutTable(spec: CalloutSpec, theme: ReportTheme) {
  const columnWidths = [pageTextWidth(theme)]
  const fill = spec.kind === "warning" ? theme.colors.warning : spec.kind === "risk" ? theme.colors.danger : spec.kind === "success" ? theme.colors.success : theme.callout.fill
  return [
    "<w:tbl>",
    tableProperties(theme, theme.callout.borderSize, columnWidths),
    tableRow([tableCell(spec.title, theme.styles.calloutTitle, theme, fill, undefined, columnWidths[0])]),
    tableRow([tableCell(spec.body, theme.styles.calloutBody, theme, fill, undefined, columnWidths[0])]),
    "</w:tbl>",
  ].join("")
}

function formFieldsTable(fields: FormFieldSpec[], theme: ReportTheme) {
  const columnWidths = distributeByRatios(pageTextWidth(theme), [32, 68])
  const rows = [
    tableRow([
      tableCell("字段", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[0], "center"),
      tableCell("填写内容", theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[1], "center"),
    ], true),
    ...fields.map((field, index) => tableRow([
      tableCell([field.label, field.helpText].filter(Boolean).join("\n"), theme.styles.tableCell, theme, undefined, undefined, columnWidths[0]),
      rawTableCell(sdtFieldXml(field, theme, index + 1), theme, undefined, columnWidths[1]),
    ])),
  ].join("")
  return [
    "<w:tbl>",
    tableProperties(theme, theme.table.borderSize, columnWidths),
    rows,
    "</w:tbl>",
  ].join("")
}

function sdtFieldXml(field: FormFieldSpec, theme: ReportTheme, index: number) {
  if (field.kind === "checkbox") return sdtCheckboxXml(field, theme, index)
  if (field.kind === "dropdown") return sdtDropdownXml(field, theme, index)
  if (field.kind === "date") return sdtDateXml(field, theme, index)
  return sdtPlainTextXml(field, theme, index)
}

function sdtPlainTextXml(field: FormFieldSpec, theme: ReportTheme, index: number) {
  const tag = field.tag.trim() || field.id?.trim() || field.label.trim() || `FIELD_${index}`
  const title = field.label.trim() || tag
  const visibleText = field.value?.trim() || field.placeholder?.trim() || `{{${tag}}}`
  return [
    "<w:sdt>",
    "<w:sdtPr>",
    `<w:alias w:val="${xmlAttr(title)}"/>`,
    `<w:tag w:val="${xmlAttr(tag)}"/>`,
    `<w:id w:val="${100000 + index}"/>`,
    '<w:text w:multiLine="1"/>',
    "</w:sdtPr>",
    "<w:sdtContent>",
    paragraph(visibleText, theme.styles.body),
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function sdtCheckboxXml(field: FormFieldSpec, theme: ReportTheme, index: number) {
  const tag = field.tag.trim() || field.id?.trim() || field.label.trim() || `FIELD_${index}`
  const title = field.label.trim() || tag
  const checked = field.checked ?? checkboxValueFromText(field.value)
  return [
    "<w:sdt>",
    "<w:sdtPr>",
    `<w:alias w:val="${xmlAttr(title)}"/>`,
    `<w:tag w:val="${xmlAttr(tag)}"/>`,
    `<w:id w:val="${100000 + index}"/>`,
    "<w14:checkbox>",
    `<w14:checked w14:val="${checked ? "1" : "0"}"/>`,
    '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/>',
    '<w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/>',
    "</w14:checkbox>",
    "</w:sdtPr>",
    "<w:sdtContent>",
    paragraph(checked ? "☑" : "☐", theme.styles.body),
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function sdtDropdownXml(field: FormFieldSpec, theme: ReportTheme, index: number) {
  const tag = field.tag.trim() || field.id?.trim() || field.label.trim() || `FIELD_${index}`
  const title = field.label.trim() || tag
  const options = sanitizedFieldOptions(field)
  const visibleText = field.value?.trim() || field.placeholder?.trim() || options[0] || `{{${tag}}}`
  return [
    "<w:sdt>",
    "<w:sdtPr>",
    `<w:alias w:val="${xmlAttr(title)}"/>`,
    `<w:tag w:val="${xmlAttr(tag)}"/>`,
    `<w:id w:val="${100000 + index}"/>`,
    "<w:dropDownList>",
    ...options.map((option) => `<w:listItem w:value="${xmlAttr(option)}" w:displayText="${xmlAttr(option)}"/>`),
    "</w:dropDownList>",
    "</w:sdtPr>",
    "<w:sdtContent>",
    paragraph(visibleText, theme.styles.body),
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function sdtDateXml(field: FormFieldSpec, theme: ReportTheme, index: number) {
  const tag = field.tag.trim() || field.id?.trim() || field.label.trim() || `FIELD_${index}`
  const title = field.label.trim() || tag
  const dateFormat = field.dateFormat?.trim() || "yyyy-MM-dd"
  const visibleText = field.value?.trim() || field.placeholder?.trim() || `{{${tag}}}`
  return [
    "<w:sdt>",
    "<w:sdtPr>",
    `<w:alias w:val="${xmlAttr(title)}"/>`,
    `<w:tag w:val="${xmlAttr(tag)}"/>`,
    `<w:id w:val="${100000 + index}"/>`,
    "<w:date>",
    `<w:dateFormat w:val="${xmlAttr(dateFormat)}"/>`,
    '<w:lid w:val="zh-CN"/>',
    '<w:storeMappedDataAs w:val="dateTime"/>',
    field.value?.trim() ? `<w:fullDate w:val="${xmlAttr(normalizedFullDate(field.value.trim()))}"/>` : "",
    "</w:date>",
    "</w:sdtPr>",
    "<w:sdtContent>",
    paragraph(visibleText, theme.styles.body),
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function checkboxValueFromText(value: string | undefined) {
  if (!value) return false
  return /^(?:1|true|yes|checked|on|是|已选|勾选|☑)$/i.test(value.trim())
}

function sanitizedFieldOptions(field: FormFieldSpec) {
  const options = (field.options ?? []).map((option) => option.trim()).filter(Boolean)
  const value = field.value?.trim()
  if (value && !options.includes(value)) options.unshift(value)
  const placeholder = field.placeholder?.trim()
  if (placeholder && !options.includes(placeholder)) options.unshift(placeholder)
  return [...new Set(options)].slice(0, 40)
}

function normalizedFullDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`
  return value
}

function sourceBackedBlockElements(block: SourceBackedBlock, theme: ReportTheme, labelPrefix?: string) {
  const source = sourceBackedLabel(block)
  const title = [labelPrefix, block.title, source].filter(Boolean).join(" · ")
  if (block.kind === "table" && block.table) {
    return [table({ ...block.table, caption: `${block.table.caption || block.title || "来源表格"} · ${source}` }, theme)]
  }
  if ((block.kind === "code" || block.kind === "example") && block.codeBlock) {
    return [codeBlockTable({ ...block.codeBlock, caption: `${block.codeBlock.caption || block.title || "来源示例"} · ${source}` }, theme)]
  }
  if (block.items?.length) {
    return [calloutTable({
      kind: "info",
      title,
      body: [...block.items.map((item) => `• ${item}`), preserveModeLabel(block)].join("\n"),
    }, theme)]
  }
  const body = [block.text || block.note || "", preserveModeLabel(block)].filter(Boolean).join("\n")
  return [calloutTable({
    kind: block.kind === "quote" ? "warning" : "info",
    title,
    body,
  }, theme)]
}

function generatedExampleTable(example: GeneratedExampleSpec, theme: ReportTheme) {
  const columnWidths = ruleCardColumnWidths(theme)
  const label = example.origin === "adapted" ? "补充示例：根据来源原则改写" : "补充示例：根据规则生成"
  const rows = [
    tableRow([tableCell(`${label} · ${example.title}`, theme.styles.ruleCardTitle, theme, theme.example.generatedFill, 2, sum(columnWidths))]),
    tableRow([
      tableCell("示例类型", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell([example.exampleFormat, example.exampleType, example.language].filter(Boolean).join(" / ") || "example", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    example.badExample ? tableRow([
      tableCell("不推荐示例", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell(example.badExample, { ...theme.styles.code, font: theme.fonts.code }, theme, theme.codeBlock.fill, undefined, columnWidths[1]),
    ]) : "",
    example.badExampleReason ? tableRow([
      tableCell("不推荐原因", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell(example.badExampleReason, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]) : "",
    example.goodExample ? tableRow([
      tableCell("推荐示例", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell(example.goodExample, { ...theme.styles.code, font: theme.fonts.code }, theme, theme.codeBlock.fill, undefined, columnWidths[1]),
    ]) : "",
    tableRow([
      tableCell("说明", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell(`${example.explanation}\n不是原文摘录：${example.isVerbatim === false ? "是" : "否"}`, theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
    tableRow([
      tableCell("来源依据", theme.styles.ruleCardLabel, theme, theme.example.labelFill, undefined, columnWidths[0]),
      tableCell(example.sourceRefs.join("\n") || "基于当前规则生成", theme.styles.tableCell, theme, undefined, undefined, columnWidths[1]),
    ]),
  ].join("")
  return ["<w:tbl>", tableProperties(theme, theme.example.borderSize, columnWidths), rows, "</w:tbl>"].join("")
}

function sourceBackedLabel(block: SourceBackedBlock) {
  const section = block.source.headingPath.join(" > ") || "未命名章节"
  return `来源：${block.source.sourceName || block.source.sourceTitle || block.source.sourcePath} / ${section}`
}

function preserveModeLabel(block: SourceBackedBlock) {
  const label = block.preserveMode === "verbatim-short"
    ? "保留方式：短摘录"
    : block.preserveMode === "adapted-example"
      ? "保留方式：团队化改写示例"
      : block.preserveMode === "summarized"
        ? "保留方式：摘要"
        : "保留方式：改写"
  const hash = block.source.originalBlockHash?.normalizedHash ? `来源Hash：${block.source.originalBlockHash.normalizedHash.slice(0, 12)}` : ""
  return [block.note ? `${label}。${block.note}` : label, hash].filter(Boolean).join("\n")
}

function tableProperties(theme: ReportTheme, borderSize = theme.table.borderSize, columnWidths = [pageTextWidth(theme)]) {
  const tableWidth = sum(columnWidths)
  return [
    "<w:tblPr>",
    `<w:tblW w:w="${tableWidth}" w:type="dxa"/>`,
    `<w:tblInd w:w="${TABLE_INDENT_TWIPS}" w:type="dxa"/>`,
    "<w:tblBorders>",
    border("top", borderSize, theme.colors.border),
    border("left", borderSize, theme.colors.border),
    border("bottom", borderSize, theme.colors.border),
    border("right", borderSize, theme.colors.border),
    border("insideH", borderSize, theme.colors.border),
    border("insideV", borderSize, theme.colors.border),
    "</w:tblBorders>",
    '<w:tblLayout w:type="fixed"/>',
    `<w:tblCellMar><w:top w:w="${theme.table.cellMargin}" w:type="dxa"/><w:left w:w="${theme.table.cellMargin}" w:type="dxa"/><w:bottom w:w="${theme.table.cellMargin}" w:type="dxa"/><w:right w:w="${theme.table.cellMargin}" w:type="dxa"/></w:tblCellMar>`,
    "</w:tblPr>",
    `<w:tblGrid>${columnWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
  ].join("")
}

function tableRow(cells: string[], repeatHeader = false) {
  return `<w:tr>${repeatHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.join("")}</w:tr>`
}

function tableCell(text: string, style: TextStyle, theme: ReportTheme, fill?: string, gridSpan?: number, width?: number, alignment?: "left" | "center" | "right", merge?: { vMerge?: "restart" | "continue" }) {
  return [
    "<w:tc>",
    "<w:tcPr>",
    width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : "",
    gridSpan && gridSpan > 1 ? `<w:gridSpan w:val="${gridSpan}"/>` : "",
    merge?.vMerge === "restart" ? '<w:vMerge w:val="restart"/>' : merge?.vMerge === "continue" ? "<w:vMerge/>" : "",
    fill ? `<w:shd w:fill="${fill}"/>` : "",
    '<w:vAlign w:val="center"/>',
    "</w:tcPr>",
    paragraph(text || " ", style, "Normal", alignment === "center" || alignment === "right" ? alignment : undefined),
    "</w:tc>",
  ].join("")
}

function rawTableCell(contentXml: string, theme: ReportTheme, fill?: string, width?: number) {
  return [
    "<w:tc>",
    "<w:tcPr>",
    width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : "",
    fill ? `<w:shd w:fill="${fill}"/>` : "",
    '<w:vAlign w:val="center"/>',
    "</w:tcPr>",
    contentXml,
    "</w:tc>",
  ].join("")
}

function pageTextWidth(theme: ReportTheme) {
  return pageWidthTwips(theme) - theme.page.margin.left - theme.page.margin.right - TABLE_INDENT_TWIPS
}

function genericTableColumnWidths(headers: string[], theme: ReportTheme) {
  const tableWidth = pageTextWidth(theme)
  if (headers.length <= 1) return [tableWidth]
  const normalized = headers.map((header) => header.trim())
  const presets = columnPreset(normalized)
  if (presets) return distributeByRatios(tableWidth, presets)
  return distributeByRatios(tableWidth, Array.from({ length: headers.length }, () => 1))
}

function columnPreset(headers: string[]) {
  const joined = headers.join("|")
  if (joined === "版本|日期|作者|摘要") return [12, 18, 24, 46]
  if (joined === "来源|路径|说明") return [30, 34, 36]
  if (joined === "类别|内容") return [24, 76]
  if (joined === "差异类型|数量|处理策略") return [30, 16, 54]
  if (joined === "规则主题|内部依据|外部依据|用户决策|处理建议") return [20, 22, 22, 16, 20]
  if (joined === "规则编号|规则名称|强制级别|适用范围") return [18, 34, 18, 30]
  if (headers.length === 2) return [32, 68]
  return undefined
}

function ruleCardColumnWidths(theme: ReportTheme) {
  return distributeByRatios(pageTextWidth(theme), [28, 72])
}

function distributeByRatios(totalWidth: number, ratios: number[]) {
  const normalizedRatios = ratios.map((item) => Number.isFinite(item) && item > 0 ? item : 1)
  const ratioTotal = normalizedRatios.reduce((acc, item) => acc + item, 0)
  let remaining = totalWidth
  return normalizedRatios.map((ratio, index) => {
    if (index === normalizedRatios.length - 1) return remaining
    const width = Math.max(720, Math.round((totalWidth * ratio) / ratioTotal))
    remaining -= width
    return width
  })
}

function sum(values: number[]) {
  return values.reduce((acc, item) => acc + item, 0)
}

function border(kind: string, size: number, color: string) {
  return `<w:${kind} w:val="single" w:sz="${size}" w:space="0" w:color="${color}"/>`
}

function tocField(theme: ReportTheme) {
  return [
    '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>',
    '<w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u" w:dirty="true">',
    run("目录占位：打开 Word 后请更新目录域。", theme.styles.muted),
    "</w:fldSimple></w:p>",
  ].join("")
}

function staticTocElements(spec: WordDocSpec, theme: ReportTheme, context: WordBuildContext) {
  const sections = [...spec.sections, ...(spec.appendices ?? [])]
  const rows: string[] = []
  for (const section of sections) {
    const bookmark = context.sectionBookmarkNameMap.get(section)
    if (!bookmark) continue
    const prefix = section.level === 1 ? "" : section.level === 2 ? "  " : "    "
    rows.push(tocEntryParagraph(`${prefix}${section.title}`, bookmark, theme))
  }
  return rows.length ? rows : [paragraph("暂无可导航章节。", theme.styles.muted, "Muted")]
}

function tocEntryParagraph(text: string, anchor: string, theme: ReportTheme) {
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="Normal"/>',
    `<w:spacing w:before="${theme.styles.body.spacingBefore ?? 0}" w:after="${theme.styles.body.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    internalHyperlinkRun(text, anchor, theme.styles.body),
    "</w:p>",
  ].join("")
}

function internalLinksParagraph(links: Array<{ label: string; anchor: string }>, theme: ReportTheme) {
  const runs: string[] = []
  links.forEach((link, index) => {
    if (index > 0) runs.push(run("  |  ", theme.styles.muted))
    runs.push(internalHyperlinkRun(link.label, link.anchor, theme.styles.muted))
  })
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="Muted"/>',
    `<w:spacing w:before="${theme.styles.muted.spacingBefore ?? 0}" w:after="${theme.styles.muted.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    runs.join(""),
    "</w:p>",
  ].join("")
}

function internalHyperlinkRun(text: string, anchor: string, style: TextStyle) {
  const safeAnchor = safeBookmarkName(anchor)
  if (!safeAnchor) return run(text, style)
  return [
    `<w:hyperlink w:anchor="${xmlAttr(safeAnchor)}">`,
    run(text, style, { color: "0563C1", underline: true }),
    "</w:hyperlink>",
  ].join("")
}

function bookmarkMarker(name: string, id: number) {
  return [
    "<w:p>",
    `<w:bookmarkStart w:id="${id}" w:name="${xmlAttr(safeBookmarkName(name))}"/>`,
    `<w:bookmarkEnd w:id="${id}"/>`,
    "</w:p>",
  ].join("")
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
}

function sectionProperties(theme: ReportTheme) {
  const margin = theme.page.margin
  return [
    "<w:sectPr>",
    '<w:headerReference w:type="default" r:id="rIdHeader1"/>',
    '<w:footerReference w:type="default" r:id="rIdFooter1"/>',
    `<w:pgSz w:w="${pageWidthTwips(theme)}" w:h="${pageHeightTwips(theme)}"/>`,
    `<w:pgMar w:top="${margin.top}" w:right="${margin.right}" w:bottom="${margin.bottom}" w:left="${margin.left}" w:header="720" w:footer="720" w:gutter="0"/>`,
    "</w:sectPr>",
  ].join("")
}

function pageWidthTwips(theme: ReportTheme) {
  if (theme.page.width) return theme.page.width
  return theme.page.size === "Letter" ? LETTER_WIDTH_TWIPS : A4_WIDTH_TWIPS
}

function pageHeightTwips(theme: ReportTheme) {
  if (theme.page.height) return theme.page.height
  return theme.page.size === "Letter" ? LETTER_HEIGHT_TWIPS : A4_HEIGHT_TWIPS
}

function stylesXml(theme: ReportTheme) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    styleXml("Normal", "Normal", theme.styles.normal, theme, "paragraph", true),
    styleXml("Title", "Title", theme.styles.coverTitle, theme, "paragraph"),
    styleXml("Subtitle", "Subtitle", theme.styles.coverSubtitle, theme, "paragraph"),
    styleXml("Muted", "Muted", theme.styles.muted, theme, "paragraph"),
    styleXml("Quote", "Quote", { ...theme.styles.muted, italic: true, sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints, theme.styles.muted.sizeHalfPoints) }, theme, "paragraph"),
    styleXml("IntenseQuote", "Intense Quote", { ...theme.styles.body, italic: true, bold: true, sizeHalfPoints: Math.max(theme.styles.body.sizeHalfPoints + 4, 26), color: theme.colors.secondary }, theme, "paragraph"),
    styleXml("ListParagraph", "List Paragraph", theme.styles.body, theme, "paragraph"),
    styleXml("Heading1", "heading 1", theme.styles.heading1, theme, "paragraph", false, 0),
    styleXml("Heading2", "heading 2", theme.styles.heading2, theme, "paragraph", false, 1),
    styleXml("Heading3", "heading 3", theme.styles.heading3, theme, "paragraph", false, 2),
    styleXml("FootnoteText", "Footnote Text", theme.styles.muted, theme, "paragraph"),
    styleXml("EndnoteText", "Endnote Text", theme.styles.muted, theme, "paragraph"),
    "</w:styles>",
  ].join("")
}

function numberingXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    abstractNumberingXml(1, [
      { format: "bullet", text: "•" },
      { format: "bullet", text: "◦" },
      { format: "bullet", text: "▪" },
    ]),
    abstractNumberingXml(2, [
      { format: "decimal", text: "%1." },
      { format: "decimal", text: "%1.%2." },
      { format: "decimal", text: "%1.%2.%3." },
    ]),
    abstractNumberingXml(3, [
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
    ]),
    abstractNumberingXml(4, [
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
    ]),
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>',
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>',
    '<w:num w:numId="3"><w:abstractNumId w:val="3"/></w:num>',
    '<w:num w:numId="4"><w:abstractNumId w:val="4"/></w:num>',
    "</w:numbering>",
  ].join("")
}

function abstractNumberingXml(abstractNumId: number, levels: NumberingLevelSpec[]) {
  return [
    `<w:abstractNum w:abstractNumId="${abstractNumId}">`,
    '<w:multiLevelType w:val="hybridMultilevel"/>',
    ...levels.map((level, index) => numberingLevelXml(index, level)),
    "</w:abstractNum>",
  ].join("")
}

function numberingLevelXml(index: number, level: NumberingLevelSpec) {
  const left = 720 * (index + 1)
  return [
    `<w:lvl w:ilvl="${index}">`,
    '<w:start w:val="1"/>',
    `<w:numFmt w:val="${level.format}"/>`,
    `<w:lvlText w:val="${xmlAttr(level.text)}"/>`,
    '<w:lvlJc w:val="left"/>',
    `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>`,
    level.font ? `<w:rPr><w:rFonts w:ascii="${xmlAttr(level.font)}" w:hAnsi="${xmlAttr(level.font)}" w:eastAsia="${xmlAttr(level.font)}"/></w:rPr>` : "",
    "</w:lvl>",
  ].join("")
}

function styleXml(styleId: string, name: string, style: TextStyle, theme: ReportTheme, type: "paragraph", isDefault = false, outlineLevel?: number) {
  return [
    `<w:style w:type="${type}" w:styleId="${styleId}"${isDefault ? ' w:default="1"' : ""}>`,
    `<w:name w:val="${xmlAttr(name)}"/>`,
    "<w:pPr>",
    `<w:spacing w:before="${style.spacingBefore ?? 0}" w:after="${style.spacingAfter ?? 0}"/>`,
    outlineLevel !== undefined ? `<w:outlineLvl w:val="${outlineLevel}"/>` : "",
    "</w:pPr>",
    "<w:rPr>",
    `<w:rFonts w:ascii="${xmlAttr(style.font ?? theme.fonts.latin)}" w:hAnsi="${xmlAttr(style.font ?? theme.fonts.latin)}" w:eastAsia="${xmlAttr(theme.fonts.body)}"/>`,
    style.bold ? "<w:b/>" : "",
    style.italic ? "<w:i/>" : "",
    style.color ? `<w:color w:val="${style.color}"/>` : "",
    `<w:sz w:val="${style.sizeHalfPoints}"/>`,
    "</w:rPr>",
    "</w:style>",
  ].join("")
}

function headerXml(spec: WordDocSpec, theme: ReportTheme) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    paragraph(spec.metadata.title, theme.styles.header),
    "</w:hdr>",
  ].join("")
}

function footerXml(theme: ReportTheme, context: WordBuildContext) {
  const footerContent = context.navigation.mode === "field-toc"
    ? paragraphWithRuns([
      run("ChipMate Document Agent · Page ", theme.styles.footer),
      fieldRun("PAGE", "1", theme.styles.footer),
      run(" of ", theme.styles.footer),
      fieldRun("NUMPAGES", "1", theme.styles.footer),
    ], theme.styles.footer, "Normal", "center")
    : paragraph("ChipMate Document Agent · 打开 Word 后请更新目录域", theme.styles.footer, "Normal", "center")
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    footerContent,
    "</w:ftr>",
  ].join("")
}

function contentTypesXml(context: WordBuildContext) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    context.figures.length ? '<Default Extension="png" ContentType="image/png"/>' : "",
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
    context.includeSettings ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : "",
    context.footnotes.length ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : "",
    context.endnotes.length ? '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>' : "",
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("")
}

function packageRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("")
}

function documentRelationshipsXml(context: WordBuildContext) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    '<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    context.includeSettings ? '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' : "",
    context.footnotes.length ? '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' : "",
    context.endnotes.length ? '<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>' : "",
    ...context.figures.map((figure) => `<Relationship Id="${xmlAttr(figure.relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${xmlAttr(figure.target)}"/>`),
    ...context.externalHyperlinks.map((link) => `<Relationship Id="${xmlAttr(link.relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlAttr(link.target)}" TargetMode="External"/>`),
    "</Relationships>",
  ].join("")
}

function notesXml(kind: "footnote" | "endnote", notes: NoteBuildItem[], theme: ReportTheme) {
  const root = kind === "footnote" ? "footnotes" : "endnotes"
  const itemTag = kind === "footnote" ? "footnote" : "endnote"
  const refTag = kind === "footnote" ? "footnoteRef" : "endnoteRef"
  const styleId = kind === "footnote" ? "FootnoteText" : "EndnoteText"
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
    `<w:${itemTag} w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:${itemTag}>`,
    `<w:${itemTag} w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${itemTag}>`,
    ...notes.map((note) => [
      `<w:${itemTag} w:id="${note.id}">`,
      ...noteParagraphsXml(note.text, theme, styleId, refTag),
      `</w:${itemTag}>`,
    ].join("")),
    `</w:${root}>`,
  ].join("")
}

function noteParagraphsXml(text: string, theme: ReportTheme, styleId: string, refTag: string) {
  return noteTextParagraphs(text).map((paragraphText, index) => noteParagraphXml(paragraphText, theme, styleId, refTag, index === 0))
}

function noteParagraphXml(text: string, theme: ReportTheme, styleId: string, refTag: string, includeReference: boolean) {
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${styleId}"/>`,
    `<w:spacing w:before="0" w:after="${theme.styles.muted.spacingAfter ?? 0}"/>`,
    "</w:pPr>",
    includeReference ? `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${refTag}/></w:r>` : "",
    run(`${includeReference ? " " : ""}${text}`, theme.styles.muted),
    "</w:p>",
  ].join("")
}

function noteTextParagraphs(text: string) {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  return paragraphs.length ? paragraphs : [""]
}

function settingsXml(spec: WordDocSpec) {
  const protection = spec.protection
  const protectionXml = protection
    ? `<w:documentProtection w:edit="${xmlAttr(protection.mode)}" w:enforcement="${protection.enforce === false ? "0" : "1"}"/>`
    : ""
  const updateFieldsXml = spec.layout?.navigation?.mode === "field-toc" ? '<w:updateFields w:val="true"/>' : ""
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    updateFieldsXml,
    protectionXml,
    "</w:settings>",
  ].join("")
}

function corePropertiesXml(spec: WordDocSpec) {
  const generatedAt = normalizeW3CDateTime(spec.metadata.generatedAt)
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${xmlText(spec.metadata.title)}</dc:title>`,
    `<dc:creator>${xmlText(spec.metadata.author ?? "ChipMate")}</dc:creator>`,
    `<cp:lastModifiedBy>${xmlText(spec.metadata.author ?? "ChipMate")}</cp:lastModifiedBy>`,
    `<dcterms:created xsi:type="dcterms:W3CDTF">${xmlText(generatedAt)}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${xmlText(generatedAt)}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join("")
}

function appPropertiesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
    "<Application>ChipMate</Application>",
    "<DocSecurity>0</DocSecurity>",
    "<ScaleCrop>false</ScaleCrop>",
    "</Properties>",
  ].join("")
}

function xmlText(input: string) {
  return sanitizeXmlText(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function xmlAttr(input: string) {
  return xmlText(input).replace(/"/g, "&quot;")
}

function safeBookmarkName(input: string) {
  const normalized = input.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  if (!normalized) return ""
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`
}

function uniqueBookmarkName(preferred: string, used: Set<string>, fallback: string) {
  const base = safeBookmarkName(preferred) || safeBookmarkName(fallback) || "bookmark"
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = safeBookmarkName(`${base}_${suffix}`) || `bookmark_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function sanitizeXmlText(input: string) {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
}

function normalizeW3CDateTime(input: string) {
  const parsed = new Date(input)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
}
