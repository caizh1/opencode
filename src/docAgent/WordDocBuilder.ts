import { createRequire } from "node:module"
import type { CalloutSpec, CodeBlockSpec, DocumentSection, GeneratedExampleSpec, RuleCardSpec, SourceBackedBlock, TableSpec, WordDocSpec } from "./types"
import type { ReportTheme, TextStyle } from "./themes/ReportTheme"
import { TeamGuidelineReportTheme } from "./themes/TeamGuidelineReportTheme"

const nodeRequire = createRequire(__filename)

type ZipFile = {
  file(path: string, data: string | Uint8Array): void
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

type JsZipCtor = new () => ZipFile

const A4_WIDTH_TWIPS = 11906
const TABLE_INDENT_TWIPS = 120

export class WordDocBuilder {
  constructor(private readonly theme: ReportTheme = TeamGuidelineReportTheme) {}

  async build(spec: WordDocSpec): Promise<Uint8Array> {
    const JSZip = nodeRequire("jszip") as JsZipCtor
    const zip = new JSZip()
    zip.file("[Content_Types].xml", contentTypesXml())
    zip.file("_rels/.rels", packageRelationshipsXml())
    zip.file("docProps/core.xml", corePropertiesXml(spec))
    zip.file("docProps/app.xml", appPropertiesXml())
    zip.file("word/_rels/document.xml.rels", documentRelationshipsXml())
    zip.file("word/styles.xml", stylesXml(this.theme))
    zip.file("word/header1.xml", headerXml(spec, this.theme))
    zip.file("word/footer1.xml", footerXml(this.theme))
    zip.file("word/document.xml", documentXml(spec, this.theme))
    return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  }
}

function documentXml(spec: WordDocSpec, theme: ReportTheme) {
  const body: string[] = []
  body.push(...coverElements(spec, theme))
  body.push(pageBreak())
  body.push(heading("目录", 1, theme))
  body.push(tocField(theme))
  body.push(paragraph("提示：请在 Word 中右键目录并选择“更新域”，即可生成静态页码目录。", theme.styles.muted, "Muted"))
  body.push(pageBreak())
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
  for (const section of spec.sections) body.push(...sectionElements(section, theme))
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
  for (const appendix of spec.appendices ?? []) body.push(...sectionElements(appendix, theme, true))
  body.push(sectionProperties(theme))
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<w:body>",
    body.join(""),
    "</w:body>",
    "</w:document>",
  ].join("")
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

function sectionElements(section: DocumentSection, theme: ReportTheme, appendix = false) {
  const rows: string[] = [heading(section.title, section.level, theme, appendix)]
  for (const text of section.paragraphs ?? []) rows.push(paragraph(text, theme.styles.body))
  for (const item of section.bullets ?? []) rows.push(paragraph(`• ${item}`, theme.styles.body))
  for (const [index, item] of (section.numberedItems ?? []).entries()) rows.push(paragraph(`${index + 1}. ${item}`, theme.styles.body))
  for (const callout of section.callouts ?? []) rows.push(calloutTable(callout, theme))
  for (const tableSpec of section.tables ?? []) rows.push(table(tableSpec, theme))
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

function heading(text: string, level: 1 | 2 | 3, theme: ReportTheme, appendix = false) {
  const style = level === 1 ? theme.styles.heading1 : level === 2 ? theme.styles.heading2 : theme.styles.heading3
  const styleId = level === 1 ? "Heading1" : level === 2 ? "Heading2" : "Heading3"
  return paragraph(text, appendix ? { ...style, ...theme.styles.appendix } : style, styleId)
}

function paragraph(text: string, style: TextStyle, styleId = "Normal", alignment?: "center") {
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

function run(text: string, style: TextStyle) {
  return [
    "<w:r><w:rPr>",
    style.font ? `<w:rFonts w:ascii="${xmlAttr(style.font)}" w:hAnsi="${xmlAttr(style.font)}" w:eastAsia="${xmlAttr(style.font)}"/>` : "",
    style.bold ? "<w:b/>" : "",
    style.italic ? "<w:i/>" : "",
    style.color ? `<w:color w:val="${style.color}"/>` : "",
    `<w:sz w:val="${style.sizeHalfPoints}"/>`,
    "</w:rPr>",
    ...textRuns(text),
    "</w:r>",
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

function table(spec: TableSpec, theme: ReportTheme) {
  const columnWidths = genericTableColumnWidths(spec.headers, theme)
  const rows = [
    tableRow(spec.headers.map((header, index) => tableCell(header, theme.styles.tableHeader, theme, theme.table.headerFill, undefined, columnWidths[index]))),
    ...spec.rows.map((row) => tableRow(spec.headers.map((_, index) => tableCell(row[index] ?? "", theme.styles.tableCell, theme, undefined, undefined, columnWidths[index])))),
  ].join("")
  return [
    spec.caption ? paragraph(spec.caption, theme.styles.muted) : "",
    "<w:tbl>",
    tableProperties(theme, theme.table.borderSize, columnWidths),
    rows,
    "</w:tbl>",
  ].join("")
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

function tableRow(cells: string[]) {
  return `<w:tr>${cells.join("")}</w:tr>`
}

function tableCell(text: string, style: TextStyle, theme: ReportTheme, fill?: string, gridSpan?: number, width?: number) {
  return [
    "<w:tc>",
    "<w:tcPr>",
    width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : "",
    gridSpan && gridSpan > 1 ? `<w:gridSpan w:val="${gridSpan}"/>` : "",
    fill ? `<w:shd w:fill="${fill}"/>` : "",
    "</w:tcPr>",
    paragraph(text || " ", style, "Normal"),
    "</w:tc>",
  ].join("")
}

function pageTextWidth(theme: ReportTheme) {
  return A4_WIDTH_TWIPS - theme.page.margin.left - theme.page.margin.right - TABLE_INDENT_TWIPS
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
  const ratioTotal = ratios.reduce((acc, item) => acc + item, 0)
  let remaining = totalWidth
  return ratios.map((ratio, index) => {
    if (index === ratios.length - 1) return remaining
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
    '<w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u">',
    run("目录占位：打开 Word 后请更新目录域。", theme.styles.muted),
    "</w:fldSimple></w:p>",
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
    '<w:pgSz w:w="11906" w:h="16838"/>',
    `<w:pgMar w:top="${margin.top}" w:right="${margin.right}" w:bottom="${margin.bottom}" w:left="${margin.left}" w:header="720" w:footer="720" w:gutter="0"/>`,
    "</w:sectPr>",
  ].join("")
}

function stylesXml(theme: ReportTheme) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    styleXml("Normal", "Normal", theme.styles.normal, theme, "paragraph", true),
    styleXml("Title", "Title", theme.styles.coverTitle, theme, "paragraph"),
    styleXml("Subtitle", "Subtitle", theme.styles.coverSubtitle, theme, "paragraph"),
    styleXml("Muted", "Muted", theme.styles.muted, theme, "paragraph"),
    styleXml("Heading1", "heading 1", theme.styles.heading1, theme, "paragraph", false, 0),
    styleXml("Heading2", "heading 2", theme.styles.heading2, theme, "paragraph", false, 1),
    styleXml("Heading3", "heading 3", theme.styles.heading3, theme, "paragraph", false, 2),
    "</w:styles>",
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

function footerXml(theme: ReportTheme) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    paragraph("ChipMate Document Agent · 打开 Word 后请更新目录域", theme.styles.footer, "Normal", "center"),
    "</w:ftr>",
  ].join("")
}

function contentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
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

function documentRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    "</Relationships>",
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

function sanitizeXmlText(input: string) {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
}

function normalizeW3CDateTime(input: string) {
  const parsed = new Date(input)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
}
