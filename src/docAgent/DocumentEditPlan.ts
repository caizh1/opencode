import type {
  CalloutSpec,
  BriefCardSpec,
  BriefCardsSpec,
  CodeBlockSpec,
  DocAgentModelProvider,
  DocumentEditOperation,
  DocumentEditPlan,
  DocumentEditPlanValidationResult,
  EvidenceCardSpec,
  EvidenceCardsSpec,
  FigureSpec,
  InsertSectionBlockSpec,
  ParagraphRunSpec,
  ParagraphSpec,
  QuoteBlockSpec,
  RedactionPatternSpec,
  TableCellValue,
  TableSpec,
  WordDocumentInspection,
  WordDocumentLocator,
  WordListItemSpec,
  WordListSpec,
} from "./types"
import { normalizeOoxmlPackagePart, normalizeOoxmlPartPatches, validateOoxmlPatchPlan } from "./OoxmlPatch"
import { normalizeTableCellValue, validateTableGeometry } from "./TableSpecUtils"

export const DOCUMENT_EDIT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["planId", "targetPath", "operations", "warnings"],
  properties: {
    planId: { type: "string" },
    targetPath: { type: "string" },
    outputTitle: { type: "string" },
    outputFilenameBase: { type: "string" },
    operations: {
      type: "array",
      items: {
        oneOf: [
          { type: "object", required: ["type", "locator", "title"], properties: { type: { const: "insertSection" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "replaceParagraph" } } },
          { type: "object", required: ["type", "locator", "paragraph"], properties: { type: { const: "replaceParagraphWithRichParagraph" } } },
          { type: "object", required: ["type", "locator", "blocks"], properties: { type: { const: "replaceParagraphWithBlocks" } } },
          { type: "object", required: ["type", "locator", "oldText", "newText"], properties: { type: { const: "replaceText" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "replaceParagraphWithTrackedChange" } } },
          { type: "object", required: ["type", "locator", "paragraph"], properties: { type: { const: "replaceParagraphWithRichTrackedChange" } } },
          { type: "object", required: ["type", "locator", "oldText", "newText"], properties: { type: { const: "replaceTextWithTrackedChange" } } },
	          { type: "object", required: ["type", "locator", "level"], properties: { type: { const: "updateHeadingLevel" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "updateTable" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "updateTableWithTrackedChange" } } },
	          { type: "object", required: ["type", "locator", "table"], properties: { type: { const: "replaceTable" } } },
	          { type: "object", required: ["type", "locator", "headerRowCount"], properties: { type: { const: "updateTableHeaderRows" } } },
	          { type: "object", required: ["type", "locator", "items"], properties: { type: { const: "updateList" } } },
	          { type: "object", required: ["type", "locator", "page"], properties: { type: { const: "updateSectionPageSetup" } } },
	          { type: "object", required: ["type", "locator", "mode"], properties: { type: { const: "setDocumentProtection" } } },
	          { type: "object", required: ["type", "locator", "altText"], properties: { type: { const: "updateImageAltText" } } },
	          { type: "object", required: ["type", "locator", "figure"], properties: { type: { const: "replaceImage" } } },
	          { type: "object", required: ["type", "locator", "caption"], properties: { type: { const: "updateCaptionText" } } },
	          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "updateHyperlinkText" } } },
	          { type: "object", required: ["type", "locator"], properties: { type: { const: "updateHyperlinkTarget" } } },
	          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "updateNoteText" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "addComment" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "updateCommentText" } } },
          { type: "object", required: ["type", "locator", "resolved"], properties: { type: { const: "setCommentResolved" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "fillContentControl" } } },
          { type: "object", required: ["type", "locator", "text"], properties: { type: { const: "addTextWatermark" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "removeWatermark" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "removeAllComments" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "acceptAllTrackedChanges" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "rejectAllTrackedChanges" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "scrubDocumentMetadata" } } },
          { type: "object", required: ["type", "locator"], properties: { type: { const: "redactText" } } },
          { type: "object", required: ["type", "locator", "part", "reason", "patches"], properties: { type: { const: "patchOoxmlPart" } } },
        ],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const

type EditPlanJson = Partial<DocumentEditPlan>

export class DocumentEditPlanner {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async plan(input: {
    question: string
    targetPath: string
    inspection: WordDocumentInspection
    signal?: AbortSignal
  }): Promise<DocumentEditPlanValidationResult> {
    const fallback = deterministicPlan(input)
    if (!this.model) return validateDocumentEditPlan(fallback, input.inspection)
    try {
      const generated = await this.model.completeJson<EditPlanJson>({
        purpose: "plan-document",
        system: [
          "You are a Word document edit planner. Return JSON only.",
	          "You must output a DocumentEditPlan using only insertSection, replaceParagraph, replaceParagraphWithRichParagraph, replaceParagraphWithBlocks, replaceText, replaceParagraphWithTrackedChange, replaceParagraphWithRichTrackedChange, replaceTextWithTrackedChange, updateHeadingLevel, updateTable, updateTableWithTrackedChange, replaceTable, updateTableHeaderRows, updateList, updateSectionPageSetup, setDocumentProtection, updateImageAltText, replaceImage, updateCaptionText, updateHyperlinkText, updateHyperlinkTarget, updateNoteText, addComment, updateCommentText, setCommentResolved, fillContentControl, addTextWatermark, removeWatermark, removeAllComments, acceptAllTrackedChanges, rejectAllTrackedChanges, scrubDocumentMetadata, redactText, or patchOoxmlPart.",
          "Every operation must use a locator copied exactly from the provided locator registry.",
          "Never invent blockId, tableIndex, rowIndex, cellIndex, sourceLocation, or paths.",
          "Prefer native operations. Use patchOoxmlPart only when the user explicitly needs a low-level OOXML repair that no native operation supports; it must use documentEndLocator, a safe XML package part, exact oldText/anchor/closeTag preconditions, and a short reason. Do not write files.",
          "For insertSection, prefer blocks when the order of paragraphs, richParagraphs, lists, figures, tables, callouts, briefCards, evidenceCards, quoteBlocks, or codeBlocks matters.",
          "For cross-references in richParagraph text, prefer explicit reference runs; when prose is easier as one text run, use {{ref:bookmark|visible text}} or {{pageref:bookmark|page text}} markers so the tool converts them into live Word REF/PAGEREF fields.",
          "For table cells that need merged layout, use TableSpec row cell objects like { text, colSpan, rowSpan, alignment }; never fake merged cells with blank columns or raw OOXML.",
        ].join("\n"),
        prompt: JSON.stringify({
          userRequest: input.question,
          targetPath: input.targetPath,
	          allowedOperations: ["insertSection", "replaceParagraph", "replaceParagraphWithRichParagraph", "replaceParagraphWithBlocks", "replaceText", "replaceParagraphWithTrackedChange", "replaceParagraphWithRichTrackedChange", "replaceTextWithTrackedChange", "updateHeadingLevel", "updateTable", "updateTableWithTrackedChange", "replaceTable", "updateTableHeaderRows", "updateList", "updateSectionPageSetup", "setDocumentProtection", "updateImageAltText", "replaceImage", "updateCaptionText", "updateHyperlinkText", "updateHyperlinkTarget", "updateNoteText", "addComment", "updateCommentText", "setCommentResolved", "fillContentControl", "addTextWatermark", "removeWatermark", "removeAllComments", "acceptAllTrackedChanges", "rejectAllTrackedChanges", "scrubDocumentMetadata", "redactText", "patchOoxmlPart"],
          locatorRegistry: locatorPrompt(input.inspection),
          expectedOutputShape: {
            planId: "short id",
            targetPath: input.targetPath,
            outputTitle: "optional title",
            outputFilenameBase: "optional safe filename base",
            operations: [
              { type: "insertSection", locator: input.inspection.documentEndLocator, title: "章节标题", level: 1, blocks: [{ type: "paragraph", text: "正文" }, { type: "richParagraph", paragraph: { runs: [{ text: "参见 " }, { text: "附录", hyperlink: { anchor: "appendix" } }] } }, { type: "list", list: { kind: "numbered", items: [{ text: "步骤一" }] } }, { type: "callout", callout: { kind: "info", title: "提示", body: "重点说明" } }, { type: "briefCards", briefCards: { columns: 3, cards: [{ title: "状态", value: "进行中", body: "关键事实摘要" }] } }, { type: "evidenceCards", evidenceCards: { columns: 2, cards: [{ title: "证据 A", summary: "证据摘要", source: "source.docx", path: "docs/source.docx", role: "primary", confidence: "high" }] } }, { type: "quoteBlock", quoteBlock: { kind: "quote", text: "引用正文", attribution: "来源" } }, { type: "codeBlock", codeBlock: { language: "text", caption: "示例", code: "content" } }] },
              { type: "replaceParagraph", locator: input.inspection.paragraphs[0]?.locator, text: "替换后的段落" },
              { type: "replaceParagraphWithRichParagraph", locator: input.inspection.paragraphs[0]?.locator, paragraph: { runs: [{ text: "替换后的 " }, { text: "强调文字", bold: true }] } },
              { type: "replaceParagraphWithBlocks", locator: input.inspection.paragraphs[0]?.locator, blocks: [{ type: "paragraph", text: "替换后的结构化正文" }, { type: "list", list: { kind: "bullet", items: [{ text: "结构化列表项" }] } }] },
              { type: "replaceText", locator: input.inspection.paragraphs[0]?.locator, oldText: "原片段", newText: "新片段" },
              { type: "replaceParagraphWithTrackedChange", locator: input.inspection.paragraphs[0]?.locator, text: "红线插入的新段落", author: "ChipMate" },
              { type: "replaceParagraphWithRichTrackedChange", locator: input.inspection.paragraphs[0]?.locator, paragraph: { runs: [{ text: "红线插入的 " }, { text: "结构化内容", bold: true }] }, author: "ChipMate" },
              { type: "replaceTextWithTrackedChange", locator: input.inspection.paragraphs[0]?.locator, oldText: "原片段", newText: "红线替换片段", author: "ChipMate" },
	              { type: "updateHeadingLevel", locator: input.inspection.paragraphs.find((item) => item.headingLevel)?.locator, level: 2 },
	              { type: "updateTable", locator: input.inspection.locators.find((item) => item.kind === "tableCell"), text: "新的单元格内容" },
	              { type: "updateTableWithTrackedChange", locator: input.inspection.locators.find((item) => item.kind === "tableCell"), text: "红线替换后的单元格内容", author: "ChipMate" },
	              { type: "replaceTable", locator: input.inspection.tables[0]?.locator, table: { headers: ["列 A", "列 B"], rows: [[{ text: "分组标题", colSpan: 2, alignment: "center" }], ["新值", "说明"]] } },
	              { type: "updateTableHeaderRows", locator: input.inspection.tables[0]?.locator, headerRowCount: 1 },
              { type: "updateList", locator: input.inspection.lists[0]?.locator, items: [{ text: "新的列表项", level: 0 }] },
              { type: "updateSectionPageSetup", locator: input.inspection.sections[0]?.locator, page: { size: "a4", orientation: "portrait", margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
	              { type: "updateImageAltText", locator: input.inspection.images[0]?.locator, altText: "描述图片内容的替代文本", title: "可选图片标题" },
	              { type: "replaceImage", locator: input.inspection.images[0]?.locator, figure: { title: "替换后的图片", altText: "替换后的 PNG 图片", image: { contentType: "image/png", base64: "base64 png", width: 640, height: 360 } } },
	              { type: "updateCaptionText", locator: input.inspection.captions[0]?.locator, caption: "更新后的图注或表注正文" },
	              { type: "updateHyperlinkText", locator: input.inspection.hyperlinks[0]?.locator, text: "描述性链接文本" },
	              { type: "updateHyperlinkTarget", locator: input.inspection.hyperlinks[0]?.locator, url: "https://example.com/new-target", tooltip: "可选链接提示" },
	              { type: "updateNoteText", locator: input.inspection.notes[0]?.locator, text: "更新后的脚注或尾注正文" },
              { type: "addComment", locator: input.inspection.paragraphs[0]?.locator, text: "批注内容第一段\n批注内容第二段", author: "ChipMate" },
              { type: "updateCommentText", locator: input.inspection.comments[0]?.locator, text: "更新后的批注正文第一段\n更新后的批注正文第二段" },
              { type: "setCommentResolved", locator: input.inspection.comments[0]?.locator, resolved: true },
              { type: "fillContentControl", locator: input.inspection.contentControls[0]?.locator, text: "填写内容" },
              { type: "addTextWatermark", locator: input.inspection.documentEndLocator, text: "CONFIDENTIAL" },
              { type: "removeWatermark", locator: input.inspection.watermarks[0]?.locator },
              { type: "removeAllComments", locator: input.inspection.documentEndLocator },
              { type: "acceptAllTrackedChanges", locator: input.inspection.documentEndLocator },
              { type: "rejectAllTrackedChanges", locator: input.inspection.documentEndLocator },
              { type: "scrubDocumentMetadata", locator: input.inspection.documentEndLocator },
              { type: "redactText", locator: input.inspection.documentEndLocator, items: [{ text: "sensitive@example.com" }], patterns: [{ kind: "email" }, { kind: "phone" }], includeComments: false },
              { type: "patchOoxmlPart", locator: input.inspection.documentEndLocator, part: "word/settings.xml", reason: "native operations cannot express this low-level OOXML flag", patches: [{ action: "appendBeforeClose", closeTag: "</w:settings>", text: "<w:doNotTrackMoves/>", expectedOccurrences: 1 }] },
            ],
            warnings: [],
          },
        }),
      }, input.signal)
      const normalized = normalizeDocumentEditPlan(generated, input.targetPath)
      const validated = validateDocumentEditPlan(normalized, input.inspection)
      if (validated.ok) return validated
      const fallbackValidated = validateDocumentEditPlan({
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `模型返回的 DocumentEditPlan 未通过运行时校验，已使用本地受控 fallback：${validated.errors.join("；")}`,
        ],
      }, input.inspection)
      return fallbackValidated.ok ? fallbackValidated : validated
    } catch (error) {
      const fallbackValidated = validateDocumentEditPlan({
        ...fallback,
        warnings: [...fallback.warnings, `模型规划失败，已使用本地受控 fallback：${formatError(error)}`],
      }, input.inspection)
      return fallbackValidated
    }
  }
}

export function normalizeDocumentEditPlan(input: EditPlanJson, targetPath: string): DocumentEditPlan {
  const operations = Array.isArray(input.operations)
    ? input.operations.map(normalizeOperation).filter((item): item is DocumentEditOperation => Boolean(item))
    : []
  return {
    planId: cleanId(input.planId) || `word-edit-${Date.now().toString(36)}`,
    targetPath,
    outputTitle: typeof input.outputTitle === "string" ? input.outputTitle.trim().slice(0, 160) : undefined,
    outputFilenameBase: typeof input.outputFilenameBase === "string" ? safeFilenameBase(input.outputFilenameBase) : undefined,
    operations,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 500)) : [],
  }
}

export function validateDocumentEditPlan(plan: DocumentEditPlan, inspection: WordDocumentInspection): DocumentEditPlanValidationResult {
  const errors: string[] = []
  const warnings = [...plan.warnings]
  if (!plan || typeof plan !== "object") errors.push("DocumentEditPlan must be an object.")
  if (!plan.planId?.trim()) errors.push("DocumentEditPlan.planId is required.")
  if (plan.targetPath !== inspection.metadata.path) errors.push(`DocumentEditPlan.targetPath must equal inspected path: ${inspection.metadata.path}.`)
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) errors.push("DocumentEditPlan.operations must contain at least one operation.")
  if (plan.operations.length > 20) errors.push("DocumentEditPlan.operations exceeds the first-version limit of 20 operations.")
  for (const [index, operation] of (plan.operations ?? []).entries()) {
    validateOperation(operation, index, inspection, errors)
  }
  return { ok: errors.length === 0, errors, warnings, plan: errors.length ? undefined : plan }
}

function validateOperation(operation: DocumentEditOperation, index: number, inspection: WordDocumentInspection, errors: string[]) {
  const prefix = `operations[${index}]`
  if (!operation || typeof operation !== "object") {
    errors.push(`${prefix} must be an object.`)
    return
  }
  if (!["insertSection", "replaceParagraph", "replaceParagraphWithRichParagraph", "replaceParagraphWithBlocks", "replaceText", "replaceParagraphWithTrackedChange", "replaceParagraphWithRichTrackedChange", "replaceTextWithTrackedChange", "updateHeadingLevel", "updateTable", "updateTableWithTrackedChange", "replaceTable", "updateTableHeaderRows", "updateList", "updateSectionPageSetup", "setDocumentProtection", "updateImageAltText", "replaceImage", "updateCaptionText", "updateHyperlinkText", "updateHyperlinkTarget", "updateNoteText", "addComment", "updateCommentText", "setCommentResolved", "fillContentControl", "addTextWatermark", "removeWatermark", "removeAllComments", "acceptAllTrackedChanges", "rejectAllTrackedChanges", "scrubDocumentMetadata", "redactText", "patchOoxmlPart"].includes(operation.type)) {
    errors.push(`${prefix}.type is not supported.`)
    return
  }
  if (!locatorExists(operation.locator, inspection)) {
    errors.push(`${prefix}.locator was not produced by inspect_word_document.`)
    return
  }
  if (operation.type === "insertSection") {
    if (!operation.title?.trim()) errors.push(`${prefix}.title is required.`)
    if (operation.locator.kind !== "documentEnd" && operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must be documentEnd or paragraph.`)
    if (operation.level && ![1, 2, 3].includes(operation.level)) errors.push(`${prefix}.level must be 1, 2, or 3.`)
    validateInsertSectionBlocks(operation, prefix, errors)
    return
  }
  if (operation.type === "replaceParagraph") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    return
  }
  if (operation.type === "replaceParagraphWithRichParagraph") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    validateRichParagraphs([operation.paragraph], `${prefix}.paragraph`, errors)
    return
  }
  if (operation.type === "replaceParagraphWithBlocks") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    if (!Array.isArray(operation.blocks) || operation.blocks.length === 0) errors.push(`${prefix}.blocks must contain at least one block.`)
    if (operation.blocks?.length > 40) errors.push(`${prefix}.blocks exceeds 40 items.`)
    for (const [blockIndex, block] of (operation.blocks ?? []).entries()) {
      validateInsertSectionBlock(block, `${prefix}.blocks[${blockIndex}]`, errors)
    }
    return
  }
  if (operation.type === "replaceText") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    if (!operation.oldText?.trim()) errors.push(`${prefix}.oldText is required.`)
    if (typeof operation.newText !== "string") errors.push(`${prefix}.newText is required.`)
    if (operation.oldText && operation.oldText.length > 500) errors.push(`${prefix}.oldText exceeds 500 characters.`)
    if (typeof operation.newText === "string" && operation.newText.length > 1000) errors.push(`${prefix}.newText exceeds 1000 characters.`)
    if (operation.oldText === operation.newText) errors.push(`${prefix}.newText must differ from oldText.`)
    return
  }
  if (operation.type === "replaceParagraphWithTrackedChange") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    return
  }
  if (operation.type === "replaceParagraphWithRichTrackedChange") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    validateRichParagraphs([operation.paragraph], `${prefix}.paragraph`, errors)
    return
  }
  if (operation.type === "replaceTextWithTrackedChange") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph.`)
    if (!operation.oldText?.trim()) errors.push(`${prefix}.oldText is required.`)
    if (typeof operation.newText !== "string" || !operation.newText.trim()) errors.push(`${prefix}.newText is required.`)
    if (operation.oldText && operation.oldText.length > 500) errors.push(`${prefix}.oldText exceeds 500 characters.`)
    if (typeof operation.newText === "string" && operation.newText.length > 1000) errors.push(`${prefix}.newText exceeds 1000 characters.`)
    if (operation.oldText === operation.newText) errors.push(`${prefix}.newText must differ from oldText.`)
    return
  }
  if (operation.type === "updateHeadingLevel") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph returned by inspect_word_document.`)
    if (![1, 2, 3].includes(operation.level)) errors.push(`${prefix}.level must be 1, 2, or 3.`)
    return
  }
	  if (operation.type === "updateTable") {
	    if (operation.locator.kind !== "table" && operation.locator.kind !== "tableCell") errors.push(`${prefix}.locator must target a table or tableCell.`)
	    if (operation.locator.kind === "tableCell" && !operation.text?.trim()) errors.push(`${prefix}.text is required for tableCell updates.`)
    for (const [cellIndex, cell] of (operation.cellUpdates ?? []).entries()) {
      if (!Number.isInteger(cell.rowIndex) || cell.rowIndex < 0) errors.push(`${prefix}.cellUpdates[${cellIndex}].rowIndex is invalid.`)
      if (!Number.isInteger(cell.cellIndex) || cell.cellIndex < 0) errors.push(`${prefix}.cellUpdates[${cellIndex}].cellIndex is invalid.`)
      if (!cell.text?.trim()) errors.push(`${prefix}.cellUpdates[${cellIndex}].text is required.`)
	    }
	    return
	  }
  if (operation.type === "updateTableWithTrackedChange") {
    if (operation.locator.kind !== "tableCell") errors.push(`${prefix}.locator must target a tableCell returned by inspect_word_document.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    if (operation.author && operation.author.length > 80) errors.push(`${prefix}.author exceeds 80 characters.`)
    return
  }
	  if (operation.type === "replaceTable") {
	    if (operation.locator.kind !== "table") errors.push(`${prefix}.locator must target a table returned by inspect_word_document.`)
	    validateTables([operation.table], `${prefix}.table`, errors)
	    return
	  }
  if (operation.type === "updateTableHeaderRows") {
    if (operation.locator.kind !== "table") errors.push(`${prefix}.locator must target a table returned by inspect_word_document.`)
    if (!Number.isInteger(operation.headerRowCount) || operation.headerRowCount < 1 || operation.headerRowCount > 10) {
      errors.push(`${prefix}.headerRowCount must be an integer between 1 and 10.`)
    }
    const table = inspection.tables.find((item) => locatorKey(item.locator) === locatorKey(operation.locator))
    if (table && operation.headerRowCount > table.rows.length) errors.push(`${prefix}.headerRowCount exceeds the inspected table row count.`)
    return
  }
  if (operation.type === "updateList") {
    if (operation.locator.kind !== "list") errors.push(`${prefix}.locator must target a list returned by inspect_word_document.`)
    if (!Array.isArray(operation.items) || operation.items.length === 0) errors.push(`${prefix}.items must contain at least one list item.`)
    if (operation.items?.length > 80) errors.push(`${prefix}.items exceeds the limit of 80 list items.`)
    for (const [itemIndex, item] of (operation.items ?? []).entries()) {
      if (!item.text?.trim()) errors.push(`${prefix}.items[${itemIndex}].text is required.`)
      if (item.text && item.text.length > 1000) errors.push(`${prefix}.items[${itemIndex}].text exceeds 1000 characters.`)
      if (item.level !== undefined && ![0, 1, 2].includes(item.level)) errors.push(`${prefix}.items[${itemIndex}].level must be 0, 1, or 2.`)
    }
    return
  }
  if (operation.type === "updateSectionPageSetup") {
    if (operation.locator.kind !== "section") errors.push(`${prefix}.locator must target a section returned by inspect_word_document.`)
    if (!operation.page || typeof operation.page !== "object") errors.push(`${prefix}.page is required.`)
    if (operation.page?.size !== undefined && operation.page.size !== "a4" && operation.page.size !== "letter") errors.push(`${prefix}.page.size must be a4 or letter.`)
    if (operation.page?.orientation !== undefined && operation.page.orientation !== "portrait" && operation.page.orientation !== "landscape") errors.push(`${prefix}.page.orientation must be portrait or landscape.`)
    validateTwips(operation.page?.widthTwips, `${prefix}.page.widthTwips`, 6000, 25000, errors)
    validateTwips(operation.page?.heightTwips, `${prefix}.page.heightTwips`, 6000, 25000, errors)
    const margins = operation.page?.margins
    if (margins) {
      validateTwips(margins.top, `${prefix}.page.margins.top`, 0, 4000, errors)
      validateTwips(margins.right, `${prefix}.page.margins.right`, 0, 4000, errors)
      validateTwips(margins.bottom, `${prefix}.page.margins.bottom`, 0, 4000, errors)
      validateTwips(margins.left, `${prefix}.page.margins.left`, 0, 4000, errors)
      validateTwips(margins.header, `${prefix}.page.margins.header`, 0, 3000, errors)
      validateTwips(margins.footer, `${prefix}.page.margins.footer`, 0, 3000, errors)
      validateTwips(margins.gutter, `${prefix}.page.margins.gutter`, 0, 3000, errors)
    }
    if (!operation.page?.size && operation.page?.widthTwips === undefined && operation.page?.heightTwips === undefined && !operation.page?.orientation && !operation.page?.margins) {
      errors.push(`${prefix}.page must request size, explicit twips, orientation, or margins.`)
    }
    return
  }
  if (operation.type === "setDocumentProtection") {
    if (operation.locator.kind !== "documentEnd" && operation.locator.kind !== "documentProtection") errors.push(`${prefix}.locator must be documentEnd or documentProtection.`)
    if (!["off", "readOnly", "comments", "trackedChanges", "forms"].includes(operation.mode)) errors.push(`${prefix}.mode must be off, readOnly, comments, trackedChanges, or forms.`)
    if (operation.enforce !== undefined && typeof operation.enforce !== "boolean") errors.push(`${prefix}.enforce must be boolean when provided.`)
    return
  }
  if (operation.type === "updateImageAltText") {
    if (operation.locator.kind !== "image") errors.push(`${prefix}.locator must target an image returned by inspect_word_document.`)
    if (!operation.altText?.trim()) errors.push(`${prefix}.altText is required.`)
    if (operation.altText && operation.altText.length > 500) errors.push(`${prefix}.altText exceeds 500 characters.`)
    if (operation.title && operation.title.length > 160) errors.push(`${prefix}.title exceeds 160 characters.`)
    return
  }
  if (operation.type === "replaceImage") {
    if (operation.locator.kind !== "image") errors.push(`${prefix}.locator must target an image returned by inspect_word_document.`)
    validateFigures([operation.figure], `${prefix}.figure`, errors)
    return
  }
  if (operation.type === "updateCaptionText") {
    if (operation.locator.kind !== "caption") errors.push(`${prefix}.locator must target a caption returned by inspect_word_document.`)
    if (!operation.caption?.trim()) errors.push(`${prefix}.caption is required.`)
    if (operation.caption && operation.caption.length > 300) errors.push(`${prefix}.caption exceeds 300 characters.`)
    return
  }
	  if (operation.type === "updateHyperlinkText") {
	    if (operation.locator.kind !== "hyperlink") errors.push(`${prefix}.locator must target a hyperlink returned by inspect_word_document.`)
	    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
	    if (operation.text && operation.text.length > 500) errors.push(`${prefix}.text exceeds 500 characters.`)
	    return
	  }
	  if (operation.type === "updateHyperlinkTarget") {
	    if (operation.locator.kind !== "hyperlink") errors.push(`${prefix}.locator must target a hyperlink returned by inspect_word_document.`)
	    const hasUrl = Boolean(operation.url?.trim())
	    const hasAnchor = Boolean(operation.anchor?.trim())
	    if (hasUrl && hasAnchor) errors.push(`${prefix} must set either url or anchor, not both.`)
	    if (!hasUrl && !hasAnchor && operation.tooltip === undefined) errors.push(`${prefix} must set url, anchor, or tooltip.`)
	    if (operation.url && operation.url.length > 2048) errors.push(`${prefix}.url exceeds 2048 characters.`)
	    if (operation.anchor && operation.anchor.length > 120) errors.push(`${prefix}.anchor exceeds 120 characters.`)
	    if (operation.tooltip && operation.tooltip.length > 160) errors.push(`${prefix}.tooltip exceeds 160 characters.`)
	    if (operation.url && /[\x00-\x1F]/.test(operation.url)) errors.push(`${prefix}.url contains control characters.`)
	    return
	  }
  if (operation.type === "updateNoteText") {
    if (operation.locator.kind !== "note") errors.push(`${prefix}.locator must target a note returned by inspect_word_document.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    if (operation.text && operation.text.length > 4000) errors.push(`${prefix}.text exceeds 4000 characters.`)
    return
  }
  if (operation.type === "addComment") {
    if (operation.locator.kind !== "paragraph") errors.push(`${prefix}.locator must target a paragraph for addComment.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    return
  }
  if (operation.type === "updateCommentText") {
    if (operation.locator.kind !== "comment") errors.push(`${prefix}.locator must target a comment returned by inspect_word_document.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    if (operation.text && operation.text.length > 4000) errors.push(`${prefix}.text exceeds 4000 characters.`)
    return
  }
  if (operation.type === "setCommentResolved") {
    if (operation.locator.kind !== "comment") errors.push(`${prefix}.locator must target a comment.`)
    if (typeof operation.resolved !== "boolean") errors.push(`${prefix}.resolved must be boolean.`)
    return
  }
  if (operation.type === "fillContentControl") {
    if (operation.locator.kind !== "contentControl") errors.push(`${prefix}.locator must target a content control.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    if (operation.text && operation.text.length > 4000) errors.push(`${prefix}.text exceeds 4000 characters.`)
    const target = contentControlForLocator(operation.locator, inspection)
    if (target?.fillSupported === false) {
      errors.push(`${prefix}.locator targets an unsupported content control for fillContentControl: ${target.fillUnsupportedReason ?? "unsupported-content-control"}.`)
    }
    return
  }
  if (operation.type === "addTextWatermark") {
    if (operation.locator.kind !== "documentEnd") errors.push(`${prefix}.locator must be documentEnd for addTextWatermark.`)
    if (!operation.text?.trim()) errors.push(`${prefix}.text is required.`)
    if (operation.text && operation.text.length > 120) errors.push(`${prefix}.text exceeds 120 characters.`)
    return
  }
  if (operation.type === "removeWatermark") {
    if (operation.locator.kind !== "watermark") errors.push(`${prefix}.locator must target a watermark returned by inspect_word_document.`)
    return
  }
  if (operation.type === "removeAllComments") {
    if (operation.locator.kind !== "documentEnd") errors.push(`${prefix}.locator must be documentEnd for removeAllComments.`)
    return
  }
  if (operation.type === "acceptAllTrackedChanges" || operation.type === "rejectAllTrackedChanges") {
    if (operation.locator.kind !== "documentEnd") errors.push(`${prefix}.locator must be documentEnd for ${operation.type}.`)
    const unsupported = unsupportedTrackedChangeTypesForCleanCopy(inspection)
    if (unsupported.length) {
      errors.push(`${prefix}.${operation.type} cannot safely clean tracked formatting revisions: ${unsupported.join(", ")}.`)
    }
    return
  }
  if (operation.type === "scrubDocumentMetadata") {
    if (operation.locator.kind !== "documentEnd") errors.push(`${prefix}.locator must be documentEnd for scrubDocumentMetadata.`)
    return
  }
  if (operation.type === "redactText") {
    if (operation.locator.kind !== "documentEnd") errors.push(`${prefix}.locator must be documentEnd for redactText.`)
    const exactItems = operation.items ?? []
    const patterns = operation.patterns ?? []
    if (exactItems.length === 0 && patterns.length === 0) errors.push(`${prefix} must contain at least one exact item or redaction pattern.`)
    if (exactItems.length > 50) errors.push(`${prefix}.items exceeds the limit of 50 exact text items.`)
    if (patterns.length > 20) errors.push(`${prefix}.patterns exceeds the limit of 20 redaction patterns.`)
    for (const [itemIndex, item] of (operation.items ?? []).entries()) {
      if (!item.text?.trim()) errors.push(`${prefix}.items[${itemIndex}].text is required.`)
      if (item.text && item.text.length > 500) errors.push(`${prefix}.items[${itemIndex}].text exceeds 500 characters.`)
      if (item.replacement && item.replacement.length > 200) errors.push(`${prefix}.items[${itemIndex}].replacement exceeds 200 characters.`)
    }
    for (const [patternIndex, pattern] of patterns.entries()) {
      const patternPrefix = `${prefix}.patterns[${patternIndex}]`
      const kind = pattern.kind ?? "custom"
      if (kind !== "email" && kind !== "phone" && kind !== "custom") errors.push(`${patternPrefix}.kind is invalid.`)
      if (kind === "custom" && !pattern.pattern?.trim()) errors.push(`${patternPrefix}.pattern is required for custom patterns.`)
      if (pattern.pattern && pattern.pattern.length > 200) errors.push(`${patternPrefix}.pattern exceeds 200 characters.`)
      if (pattern.label && pattern.label.length > 80) errors.push(`${patternPrefix}.label exceeds 80 characters.`)
      if (pattern.replacement && pattern.replacement.length > 200) errors.push(`${patternPrefix}.replacement exceeds 200 characters.`)
      if (pattern.flags && !/^[imsu]*$/.test(pattern.flags)) errors.push(`${patternPrefix}.flags may only include i, m, s, or u.`)
      if (pattern.pattern) {
        try {
          new RegExp(pattern.pattern, uniqueRegexFlags(pattern.flags))
        } catch (error) {
          errors.push(`${patternPrefix}.pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return
  }
  if (operation.type === "patchOoxmlPart") {
    errors.push(...validateOoxmlPatchPlan({
      part: operation.part,
      patches: operation.patches,
      locatorKind: operation.locator.kind,
      reason: operation.reason,
      createIfMissing: operation.createIfMissing,
      initialXml: operation.initialXml,
      prefix,
    }))
  }
}

function validateInsertSectionBlocks(operation: Extract<DocumentEditOperation, { type: "insertSection" }>, prefix: string, errors: string[]) {
  if (operation.paragraphs && operation.paragraphs.length > 20) errors.push(`${prefix}.paragraphs exceeds 20 items.`)
  if (operation.richParagraphs && operation.richParagraphs.length > 20) errors.push(`${prefix}.richParagraphs exceeds 20 items.`)
  if (operation.tables && operation.tables.length > 6) errors.push(`${prefix}.tables exceeds 6 items.`)
  if (operation.callouts && operation.callouts.length > 8) errors.push(`${prefix}.callouts exceeds 8 items.`)
  if (operation.briefCards && operation.briefCards.length > 12) errors.push(`${prefix}.briefCards exceeds 12 items.`)
  if (operation.evidenceCards && operation.evidenceCards.length > 12) errors.push(`${prefix}.evidenceCards exceeds 12 items.`)
  if (operation.quoteBlocks && operation.quoteBlocks.length > 8) errors.push(`${prefix}.quoteBlocks exceeds 8 items.`)
  if (operation.codeBlocks && operation.codeBlocks.length > 8) errors.push(`${prefix}.codeBlocks exceeds 8 items.`)
  if (operation.lists && operation.lists.length > 8) errors.push(`${prefix}.lists exceeds 8 items.`)
  if (operation.figures && operation.figures.length > 4) errors.push(`${prefix}.figures exceeds 4 items.`)
  if (operation.blocks && operation.blocks.length > 40) errors.push(`${prefix}.blocks exceeds 40 items.`)
  for (const [itemIndex, text] of (operation.paragraphs ?? []).entries()) {
    validateParagraphText(text, `${prefix}.paragraphs[${itemIndex}]`, errors)
  }
  validateRichParagraphs(operation.richParagraphs ?? [], `${prefix}.richParagraphs`, errors)
  validateWordLists(operation.lists ?? [], `${prefix}.lists`, errors)
  validateFigures(operation.figures ?? [], `${prefix}.figures`, errors)
  validateCallouts(operation.callouts ?? [], `${prefix}.callouts`, errors)
  validateBriefCards(operation.briefCards ?? [], `${prefix}.briefCards`, errors)
  validateEvidenceCards(operation.evidenceCards ?? [], `${prefix}.evidenceCards`, errors)
  validateQuoteBlocks(operation.quoteBlocks ?? [], `${prefix}.quoteBlocks`, errors)
  validateCodeBlocks(operation.codeBlocks ?? [], `${prefix}.codeBlocks`, errors)
  for (const [blockIndex, block] of (operation.blocks ?? []).entries()) {
    const blockPrefix = `${prefix}.blocks[${blockIndex}]`
    validateInsertSectionBlock(block, blockPrefix, errors)
  }
}

function validateInsertSectionBlock(block: InsertSectionBlockSpec, prefix: string, errors: string[]) {
  if (!block || typeof block !== "object") {
    errors.push(`${prefix} must be an object.`)
    return
  }
  if (block.type === "paragraph") {
    validateParagraphText(block.text, `${prefix}.text`, errors)
    return
  }
  if (block.type === "richParagraph") {
    validateRichParagraphs([block.paragraph], `${prefix}.paragraph`, errors)
    return
  }
  if (block.type === "list") {
    validateWordLists([block.list], `${prefix}.list`, errors)
    return
  }
  if (block.type === "figure") {
    validateFigures([block.figure], `${prefix}.figure`, errors)
    return
  }
  if (block.type === "table") {
    validateTables([block.table], `${prefix}.table`, errors)
    return
  }
  if (block.type === "callout") {
    validateCallouts([block.callout], `${prefix}.callout`, errors)
    return
  }
  if (block.type === "briefCards") {
    validateBriefCardsGroup(block.briefCards, `${prefix}.briefCards`, errors)
    return
  }
  if (block.type === "evidenceCards") {
    validateEvidenceCardsGroup(block.evidenceCards, `${prefix}.evidenceCards`, errors)
    return
  }
  if (block.type === "quoteBlock") {
    validateQuoteBlocks([block.quoteBlock], `${prefix}.quoteBlock`, errors)
    return
  }
  if (block.type === "codeBlock") {
    validateCodeBlocks([block.codeBlock], `${prefix}.codeBlock`, errors)
    return
  }
  errors.push(`${prefix}.type is invalid.`)
}

function validateParagraphText(text: string | undefined, prefix: string, errors: string[]) {
  if (!text?.trim()) errors.push(`${prefix} is required.`)
  if (text && text.length > 2000) errors.push(`${prefix} exceeds 2000 characters.`)
}

function validateRichParagraphs(paragraphs: ParagraphSpec[], prefix: string, errors: string[]) {
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    if (!Array.isArray(paragraph.runs) || paragraph.runs.length === 0) errors.push(`${prefix}[${paragraphIndex}].runs must contain at least one run.`)
    if (paragraph.runs?.length > 40) errors.push(`${prefix}[${paragraphIndex}].runs exceeds 40 items.`)
    if (paragraph.alignment && !["left", "center", "right"].includes(paragraph.alignment)) errors.push(`${prefix}[${paragraphIndex}].alignment is invalid.`)
    if (paragraph.style && !["body", "muted"].includes(paragraph.style)) errors.push(`${prefix}[${paragraphIndex}].style is invalid.`)
    for (const [runIndex, run] of (paragraph.runs ?? []).entries()) {
      validateRichRun(run, `${prefix}[${paragraphIndex}].runs[${runIndex}]`, errors)
    }
  }
}

function validateRichRun(run: ParagraphRunSpec, prefix: string, errors: string[]) {
  if (run.text && run.text.length > 1000) errors.push(`${prefix}.text exceeds 1000 characters.`)
  if (run.hyperlink?.url && run.hyperlink.url.length > 2048) errors.push(`${prefix}.hyperlink.url exceeds 2048 characters.`)
  if (run.hyperlink?.anchor && run.hyperlink.anchor.length > 120) errors.push(`${prefix}.hyperlink.anchor exceeds 120 characters.`)
  if (run.hyperlink?.tooltip && run.hyperlink.tooltip.length > 160) errors.push(`${prefix}.hyperlink.tooltip exceeds 160 characters.`)
  if (run.reference?.bookmark && run.reference.bookmark.length > 120) errors.push(`${prefix}.reference.bookmark exceeds 120 characters.`)
  if (run.reference?.field && !["REF", "PAGEREF"].includes(run.reference.field)) errors.push(`${prefix}.reference.field is invalid.`)
  if (run.reference?.fallbackText && run.reference.fallbackText.length > 200) errors.push(`${prefix}.reference.fallbackText exceeds 200 characters.`)
  if (run.note) {
    if (run.note.kind && !["footnote", "endnote"].includes(run.note.kind)) errors.push(`${prefix}.note.kind is invalid.`)
    if (!run.note.text?.trim()) errors.push(`${prefix}.note.text is required.`)
    if (run.note.text && run.note.text.length > 1000) errors.push(`${prefix}.note.text exceeds 1000 characters.`)
  }
  const visibleText = run.text?.trim() || run.hyperlink?.url?.trim() || run.hyperlink?.anchor?.trim() || run.reference?.fallbackText?.trim() || run.note?.text?.trim()
  if (!visibleText && !run.reference?.bookmark?.trim()) errors.push(`${prefix} must contain visible text, a hyperlink, a reference, or a note.`)
}

function validateWordLists(lists: WordListSpec[], prefix: string, errors: string[]) {
  for (const [listIndex, list] of lists.entries()) {
    if (!["bullet", "numbered", "checklist"].includes(list.kind)) errors.push(`${prefix}[${listIndex}].kind is invalid.`)
    if (list.title && list.title.length > 160) errors.push(`${prefix}[${listIndex}].title exceeds 160 characters.`)
    const items = flattenWordListItems(list.items)
    if (!items.length) errors.push(`${prefix}[${listIndex}].items must contain at least one item.`)
    if (items.length > 60) errors.push(`${prefix}[${listIndex}].items exceeds 60 flattened items.`)
    for (const [itemIndex, item] of items.entries()) {
      if (!item.text?.trim()) errors.push(`${prefix}[${listIndex}].items[${itemIndex}].text is required.`)
      if (item.text && item.text.length > 500) errors.push(`${prefix}[${listIndex}].items[${itemIndex}].text exceeds 500 characters.`)
    }
  }
}

function validateFigures(figures: FigureSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of figures.entries()) {
    if (!item.title?.trim()) errors.push(`${prefix}[${itemIndex}].title is required.`)
    if (item.title && item.title.length > 160) errors.push(`${prefix}[${itemIndex}].title exceeds 160 characters.`)
    if (item.caption && item.caption.length > 300) errors.push(`${prefix}[${itemIndex}].caption exceeds 300 characters.`)
    if (item.altText && item.altText.length > 500) errors.push(`${prefix}[${itemIndex}].altText exceeds 500 characters.`)
    const image = item.image
    if (!image) {
      errors.push(`${prefix}[${itemIndex}].image is required.`)
      continue
    }
    if (image.contentType !== "image/png") errors.push(`${prefix}[${itemIndex}].image.contentType must be image/png.`)
    if (!Number.isFinite(image.width) || image.width < 1 || image.width > 8000) errors.push(`${prefix}[${itemIndex}].image.width must be between 1 and 8000.`)
    if (!Number.isFinite(image.height) || image.height < 1 || image.height > 8000) errors.push(`${prefix}[${itemIndex}].image.height must be between 1 and 8000.`)
    const base64 = image.base64?.trim()
    if (!image.bytes?.length && !base64) errors.push(`${prefix}[${itemIndex}].image.base64 is required.`)
    if (base64 && base64.length > 5_000_000) errors.push(`${prefix}[${itemIndex}].image.base64 exceeds 5MB encoded limit.`)
  }
}

function validateCallouts(callouts: CalloutSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of callouts.entries()) {
    if (!["info", "warning", "risk", "success"].includes(item.kind)) errors.push(`${prefix}[${itemIndex}].kind is invalid.`)
    if (!item.title?.trim()) errors.push(`${prefix}[${itemIndex}].title is required.`)
    if (!item.body?.trim()) errors.push(`${prefix}[${itemIndex}].body is required.`)
    if (item.title && item.title.length > 160) errors.push(`${prefix}[${itemIndex}].title exceeds 160 characters.`)
    if (item.body && item.body.length > 2000) errors.push(`${prefix}[${itemIndex}].body exceeds 2000 characters.`)
  }
}

function validateBriefCardsGroup(group: BriefCardsSpec, prefix: string, errors: string[]) {
  if (group.columns && ![1, 2, 3].includes(group.columns)) errors.push(`${prefix}.columns must be 1, 2, or 3.`)
  if (!Array.isArray(group.cards) || group.cards.length === 0) errors.push(`${prefix}.cards must contain at least one card.`)
  if (group.cards?.length > 12) errors.push(`${prefix}.cards exceeds 12 items.`)
  validateBriefCards(group.cards ?? [], `${prefix}.cards`, errors)
}

function validateBriefCards(cards: BriefCardSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of cards.entries()) {
    if (!item.title?.trim()) errors.push(`${prefix}[${itemIndex}].title is required.`)
    if (item.title && item.title.length > 120) errors.push(`${prefix}[${itemIndex}].title exceeds 120 characters.`)
    if (item.value && item.value.length > 120) errors.push(`${prefix}[${itemIndex}].value exceeds 120 characters.`)
    if (item.body && item.body.length > 500) errors.push(`${prefix}[${itemIndex}].body exceeds 500 characters.`)
    if (item.footer && item.footer.length > 200) errors.push(`${prefix}[${itemIndex}].footer exceeds 200 characters.`)
    if (item.tone && !["neutral", "info", "success", "warning", "risk"].includes(item.tone)) errors.push(`${prefix}[${itemIndex}].tone is invalid.`)
    if (!item.value?.trim() && !item.body?.trim() && !item.footer?.trim()) errors.push(`${prefix}[${itemIndex}] must include value, body, or footer.`)
  }
}

function validateEvidenceCardsGroup(group: EvidenceCardsSpec, prefix: string, errors: string[]) {
  if (group.columns && ![1, 2].includes(group.columns)) errors.push(`${prefix}.columns must be 1 or 2.`)
  if (!Array.isArray(group.cards) || group.cards.length === 0) errors.push(`${prefix}.cards must contain at least one card.`)
  if (group.cards?.length > 12) errors.push(`${prefix}.cards exceeds 12 items.`)
  validateEvidenceCards(group.cards ?? [], `${prefix}.cards`, errors)
}

function validateEvidenceCards(cards: EvidenceCardSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of cards.entries()) {
    if (!item.title?.trim()) errors.push(`${prefix}[${itemIndex}].title is required.`)
    if (!item.summary?.trim()) errors.push(`${prefix}[${itemIndex}].summary is required.`)
    if (item.title && item.title.length > 160) errors.push(`${prefix}[${itemIndex}].title exceeds 160 characters.`)
    if (item.summary && item.summary.length > 1000) errors.push(`${prefix}[${itemIndex}].summary exceeds 1000 characters.`)
    if (item.source && item.source.length > 240) errors.push(`${prefix}[${itemIndex}].source exceeds 240 characters.`)
    if (item.path && item.path.length > 500) errors.push(`${prefix}[${itemIndex}].path exceeds 500 characters.`)
    if (item.locator && item.locator.length > 240) errors.push(`${prefix}[${itemIndex}].locator exceeds 240 characters.`)
    if (item.quote && item.quote.length > 1000) errors.push(`${prefix}[${itemIndex}].quote exceeds 1000 characters.`)
    if (item.role && !["primary", "supporting", "contradictory", "background"].includes(item.role)) errors.push(`${prefix}[${itemIndex}].role is invalid.`)
    if (item.confidence && !["high", "medium", "low"].includes(item.confidence)) errors.push(`${prefix}[${itemIndex}].confidence is invalid.`)
    if (item.sourceRefs && item.sourceRefs.length > 12) errors.push(`${prefix}[${itemIndex}].sourceRefs exceeds 12 items.`)
    for (const [refIndex, ref] of (item.sourceRefs ?? []).entries()) {
      if (!ref?.trim()) errors.push(`${prefix}[${itemIndex}].sourceRefs[${refIndex}] is required.`)
      if (ref && ref.length > 120) errors.push(`${prefix}[${itemIndex}].sourceRefs[${refIndex}] exceeds 120 characters.`)
    }
  }
}

function validateQuoteBlocks(quoteBlocks: QuoteBlockSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of quoteBlocks.entries()) {
    if (item.kind && !["quote", "pullQuote"].includes(item.kind)) errors.push(`${prefix}[${itemIndex}].kind is invalid.`)
    if (!item.text?.trim()) errors.push(`${prefix}[${itemIndex}].text is required.`)
    if (item.text && item.text.length > 2000) errors.push(`${prefix}[${itemIndex}].text exceeds 2000 characters.`)
    if (item.attribution && item.attribution.length > 300) errors.push(`${prefix}[${itemIndex}].attribution exceeds 300 characters.`)
    if (item.source && item.source.length > 300) errors.push(`${prefix}[${itemIndex}].source exceeds 300 characters.`)
  }
}

function validateCodeBlocks(codeBlocks: CodeBlockSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of codeBlocks.entries()) {
    if (!item.code?.trim()) errors.push(`${prefix}[${itemIndex}].code is required.`)
    if (item.code && item.code.length > 8000) errors.push(`${prefix}[${itemIndex}].code exceeds 8000 characters.`)
    if (item.caption && item.caption.length > 300) errors.push(`${prefix}[${itemIndex}].caption exceeds 300 characters.`)
    if (item.language && item.language.length > 40) errors.push(`${prefix}[${itemIndex}].language exceeds 40 characters.`)
  }
}

function validateTables(tables: TableSpec[], prefix: string, errors: string[]) {
  for (const [itemIndex, item] of tables.entries()) {
    if (!Array.isArray(item.headers) || item.headers.length === 0) errors.push(`${prefix}[${itemIndex}].headers must contain at least one header.`)
    if (!Array.isArray(item.rows) || item.rows.length === 0) errors.push(`${prefix}[${itemIndex}].rows must contain at least one row.`)
    if (item.caption && item.caption.length > 300) errors.push(`${prefix}[${itemIndex}].caption exceeds 300 characters.`)
    errors.push(...validateTableGeometry(item, `${prefix}[${itemIndex}]`).map((issue) => issue.message))
  }
}

function normalizeOperation(input: unknown): DocumentEditOperation | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const locator = normalizeLocator(raw.locator)
  if (raw.type === "insertSection" && locator) {
    return {
      type: "insertSection",
      locator,
      title: String(raw.title ?? "").trim(),
      level: normalizeLevel(raw.level),
      paragraphs: stringArray(raw.paragraphs),
      richParagraphs: normalizeRichParagraphs(raw.richParagraphs),
      tables: normalizeTables(raw.tables),
      callouts: normalizeCallouts(raw.callouts),
      briefCards: normalizeBriefCards(raw.briefCards),
      evidenceCards: normalizeEvidenceCards(raw.evidenceCards),
      quoteBlocks: normalizeQuoteBlocks(raw.quoteBlocks),
      codeBlocks: normalizeCodeBlocks(raw.codeBlocks),
      lists: normalizeWordLists(raw.lists),
      figures: normalizeFigures(raw.figures),
      blocks: normalizeInsertSectionBlocks(raw.blocks),
    }
  }
  if (raw.type === "replaceParagraph" && locator) {
    return { type: "replaceParagraph", locator, text: String(raw.text ?? "").trim() }
  }
  if (raw.type === "replaceParagraphWithRichParagraph" && locator) {
    const paragraph = normalizeRichParagraphs([raw.paragraph])?.[0]
    if (!paragraph) return undefined
    return { type: "replaceParagraphWithRichParagraph", locator, paragraph }
  }
  if (raw.type === "replaceParagraphWithBlocks" && locator) {
    const blocks = normalizeInsertSectionBlocks(raw.blocks)
    if (!blocks?.length) return undefined
    return { type: "replaceParagraphWithBlocks", locator, blocks }
  }
  if (raw.type === "replaceText" && locator) {
    return {
      type: "replaceText",
      locator,
      oldText: String(raw.oldText ?? "").trim(),
      newText: typeof raw.newText === "string" ? raw.newText.slice(0, 1000) : String(raw.newText ?? "").slice(0, 1000),
    }
  }
  if (raw.type === "replaceParagraphWithTrackedChange" && locator) {
    return {
      type: "replaceParagraphWithTrackedChange",
      locator,
      text: String(raw.text ?? "").trim(),
      author: typeof raw.author === "string" ? raw.author.trim().slice(0, 80) : undefined,
    }
  }
  if (raw.type === "replaceParagraphWithRichTrackedChange" && locator) {
    const paragraph = normalizeRichParagraphs([raw.paragraph])?.[0]
    if (!paragraph) return undefined
    return {
      type: "replaceParagraphWithRichTrackedChange",
      locator,
      paragraph,
      author: typeof raw.author === "string" ? raw.author.trim().slice(0, 80) : undefined,
    }
  }
  if (raw.type === "replaceTextWithTrackedChange" && locator) {
    return {
      type: "replaceTextWithTrackedChange",
      locator,
      oldText: String(raw.oldText ?? "").trim(),
      newText: typeof raw.newText === "string" ? raw.newText.slice(0, 1000) : String(raw.newText ?? "").slice(0, 1000),
      author: typeof raw.author === "string" ? raw.author.trim().slice(0, 80) : undefined,
    }
  }
  if (raw.type === "updateHeadingLevel" && locator) {
    return { type: "updateHeadingLevel", locator, level: normalizeLevel(raw.level) }
  }
	  if (raw.type === "updateTable" && locator) {
	    return {
	      type: "updateTable",
	      locator,
      text: typeof raw.text === "string" ? raw.text.trim() : undefined,
	      cellUpdates: Array.isArray(raw.cellUpdates)
	        ? raw.cellUpdates.map(normalizeCellUpdate).filter((item): item is { rowIndex: number; cellIndex: number; text: string } => Boolean(item))
	        : undefined,
	    }
	  }
  if (raw.type === "updateTableWithTrackedChange" && locator) {
    return {
      type: "updateTableWithTrackedChange",
      locator,
      text: String(raw.text ?? "").trim().slice(0, 1000),
      author: typeof raw.author === "string" ? raw.author.trim().slice(0, 80) : undefined,
    }
  }
	  if (raw.type === "replaceTable" && locator) {
	    const table = normalizeTables([raw.table])?.[0]
	    if (!table) return undefined
	    return { type: "replaceTable", locator, table }
	  }
	  if (raw.type === "updateTableHeaderRows" && locator) {
	    return { type: "updateTableHeaderRows", locator, headerRowCount: normalizeHeaderRowCount(raw.headerRowCount) }
	  }
  if (raw.type === "updateList" && locator) {
    return {
      type: "updateList",
      locator,
      items: Array.isArray(raw.items)
        ? raw.items.map(normalizeListUpdateItem).filter((item): item is NonNullable<ReturnType<typeof normalizeListUpdateItem>> => Boolean(item))
        : [],
    }
  }
  if (raw.type === "updateSectionPageSetup" && locator) {
    return {
      type: "updateSectionPageSetup",
      locator,
      page: normalizeSectionPageSetup(raw.page),
    }
  }
  if (raw.type === "setDocumentProtection" && locator) {
    return {
      type: "setDocumentProtection",
      locator,
      mode: normalizeProtectionMode(raw.mode),
      enforce: typeof raw.enforce === "boolean" ? raw.enforce : undefined,
    }
  }
  if (raw.type === "updateImageAltText" && locator) {
    return {
      type: "updateImageAltText",
      locator,
      altText: String(raw.altText ?? "").trim().slice(0, 500),
      title: typeof raw.title === "string" ? raw.title.trim().slice(0, 160) : undefined,
    }
  }
  if (raw.type === "replaceImage" && locator) {
    const figure = normalizeFigures([raw.figure])?.[0]
    if (!figure) return undefined
    return { type: "replaceImage", locator, figure }
  }
  if (raw.type === "updateCaptionText" && locator) {
    return { type: "updateCaptionText", locator, caption: String(raw.caption ?? raw.text ?? "").trim().slice(0, 300) }
  }
	  if (raw.type === "updateHyperlinkText" && locator) {
	    return { type: "updateHyperlinkText", locator, text: String(raw.text ?? "").trim().slice(0, 500) }
	  }
	  if (raw.type === "updateHyperlinkTarget" && locator) {
	    return {
	      type: "updateHyperlinkTarget",
	      locator,
	      url: typeof raw.url === "string" ? raw.url.trim().slice(0, 2048) : undefined,
	      anchor: typeof raw.anchor === "string" ? raw.anchor.trim().slice(0, 120) : undefined,
	      tooltip: typeof raw.tooltip === "string" ? raw.tooltip.trim().slice(0, 160) : undefined,
	    }
	  }
  if (raw.type === "updateNoteText" && locator) {
    return { type: "updateNoteText", locator, text: String(raw.text ?? "").trim().slice(0, 4000) }
  }
  if (raw.type === "addComment" && locator) {
    return {
      type: "addComment",
      locator,
      text: String(raw.text ?? "").trim(),
      author: typeof raw.author === "string" ? raw.author.trim().slice(0, 80) : undefined,
      initials: typeof raw.initials === "string" ? raw.initials.trim().slice(0, 12) : undefined,
    }
  }
  if (raw.type === "updateCommentText" && locator) {
    return { type: "updateCommentText", locator, text: String(raw.text ?? "").trim().slice(0, 4000) }
  }
  if (raw.type === "setCommentResolved" && locator) {
    return { type: "setCommentResolved", locator, resolved: raw.resolved !== false }
  }
  if (raw.type === "fillContentControl" && locator) {
    return { type: "fillContentControl", locator, text: String(raw.text ?? "").trim().slice(0, 4000) }
  }
  if (raw.type === "addTextWatermark" && locator) {
    return { type: "addTextWatermark", locator, text: String(raw.text ?? "").trim().slice(0, 120) }
  }
  if (raw.type === "removeWatermark" && locator) {
    return { type: "removeWatermark", locator }
  }
  if (raw.type === "removeAllComments" && locator) {
    return { type: "removeAllComments", locator }
  }
  if (raw.type === "acceptAllTrackedChanges" && locator) {
    return { type: "acceptAllTrackedChanges", locator }
  }
  if (raw.type === "rejectAllTrackedChanges" && locator) {
    return { type: "rejectAllTrackedChanges", locator }
  }
  if (raw.type === "scrubDocumentMetadata" && locator) {
    return { type: "scrubDocumentMetadata", locator }
  }
  if (raw.type === "redactText" && locator) {
    return {
      type: "redactText",
      locator,
      items: Array.isArray(raw.items) ? raw.items.map(normalizeRedactionItem).filter((item): item is NonNullable<ReturnType<typeof normalizeRedactionItem>> => Boolean(item)) : [],
      patterns: Array.isArray(raw.patterns) ? raw.patterns.map(normalizeRedactionPattern).filter((item): item is NonNullable<ReturnType<typeof normalizeRedactionPattern>> => Boolean(item)) : [],
      includeComments: raw.includeComments === true,
    }
  }
  if (raw.type === "patchOoxmlPart" && locator) {
    const part = normalizeOoxmlPackagePart(raw.part)
    const patches = normalizeOoxmlPartPatches(raw.patches)
    if (!part || !patches?.length) return undefined
    return {
      type: "patchOoxmlPart",
      locator,
      part,
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 300) : "",
      patches,
      createIfMissing: raw.createIfMissing === true,
      initialXml: typeof raw.initialXml === "string" ? raw.initialXml.slice(0, 120_000) : undefined,
    }
  }
  return undefined
}

function normalizeLocator(input: unknown): WordDocumentLocator | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const kind = raw.kind
  if (kind !== "paragraph" && kind !== "table" && kind !== "tableCell" && kind !== "comment" && kind !== "contentControl" && kind !== "watermark" && kind !== "note" && kind !== "image" && kind !== "caption" && kind !== "section" && kind !== "field" && kind !== "style" && kind !== "list" && kind !== "hyperlink" && kind !== "documentEnd") return undefined
  return {
    kind,
    blockId: typeof raw.blockId === "string" ? raw.blockId : undefined,
    commentId: typeof raw.commentId === "string" ? raw.commentId : undefined,
    contentControlIndex: typeof raw.contentControlIndex === "number" ? raw.contentControlIndex : undefined,
    contentControlTag: typeof raw.contentControlTag === "string" ? raw.contentControlTag : undefined,
    contentControlTitle: typeof raw.contentControlTitle === "string" ? raw.contentControlTitle : undefined,
    watermarkIndex: typeof raw.watermarkIndex === "number" ? raw.watermarkIndex : undefined,
    watermarkText: typeof raw.watermarkText === "string" ? raw.watermarkText : undefined,
    noteIndex: typeof raw.noteIndex === "number" ? raw.noteIndex : undefined,
    noteKind: raw.noteKind === "footnote" || raw.noteKind === "endnote" ? raw.noteKind : undefined,
    noteId: typeof raw.noteId === "string" ? raw.noteId : undefined,
    imageIndex: typeof raw.imageIndex === "number" ? raw.imageIndex : undefined,
    imageRelId: typeof raw.imageRelId === "string" ? raw.imageRelId : undefined,
    imageTarget: typeof raw.imageTarget === "string" ? raw.imageTarget : undefined,
    captionIndex: typeof raw.captionIndex === "number" ? raw.captionIndex : undefined,
    captionKind: raw.captionKind === "figure" || raw.captionKind === "table" || raw.captionKind === "unknown" ? raw.captionKind : undefined,
    captionLabel: typeof raw.captionLabel === "string" ? raw.captionLabel : undefined,
    sectionIndex: typeof raw.sectionIndex === "number" ? raw.sectionIndex : undefined,
    fieldIndex: typeof raw.fieldIndex === "number" ? raw.fieldIndex : undefined,
    fieldType: typeof raw.fieldType === "string" ? raw.fieldType : undefined,
    styleIndex: typeof raw.styleIndex === "number" ? raw.styleIndex : undefined,
    styleId: typeof raw.styleId === "string" ? raw.styleId : undefined,
    listIndex: typeof raw.listIndex === "number" ? raw.listIndex : undefined,
    listNumId: typeof raw.listNumId === "string" ? raw.listNumId : undefined,
    listLevel: typeof raw.listLevel === "number" ? raw.listLevel : undefined,
    hyperlinkIndex: typeof raw.hyperlinkIndex === "number" ? raw.hyperlinkIndex : undefined,
    hyperlinkRelId: typeof raw.hyperlinkRelId === "string" ? raw.hyperlinkRelId : undefined,
    hyperlinkAnchor: typeof raw.hyperlinkAnchor === "string" ? raw.hyperlinkAnchor : undefined,
    tableIndex: typeof raw.tableIndex === "number" ? raw.tableIndex : undefined,
    rowIndex: typeof raw.rowIndex === "number" ? raw.rowIndex : undefined,
    cellIndex: typeof raw.cellIndex === "number" ? raw.cellIndex : undefined,
    headingPath: Array.isArray(raw.headingPath) ? raw.headingPath.filter((item): item is string => typeof item === "string") : undefined,
    sourceLocation: raw.sourceLocation && typeof raw.sourceLocation === "object" ? raw.sourceLocation as never : undefined,
    normalizedHash: typeof raw.normalizedHash === "string" ? raw.normalizedHash : undefined,
  }
}

function locatorExists(locator: WordDocumentLocator | undefined, inspection: WordDocumentInspection) {
  if (!locator) return false
  return inspection.locators.some((item) => locatorKey(item) === locatorKey(locator))
}

function contentControlForLocator(locator: WordDocumentLocator | undefined, inspection: WordDocumentInspection) {
  if (!locator) return undefined
  const key = locatorKey(locator)
  return inspection.contentControls.find((item) => locatorKey(item.locator) === key)
}

export function locatorKey(locator: WordDocumentLocator) {
  return [
    locator.kind,
    locator.blockId ?? "",
    locator.commentId ?? "",
    locator.contentControlIndex ?? "",
    locator.contentControlTag ?? "",
    locator.contentControlTitle ?? "",
    locator.watermarkIndex ?? "",
    locator.watermarkText ?? "",
    locator.noteIndex ?? "",
    locator.noteKind ?? "",
    locator.noteId ?? "",
    locator.imageIndex ?? "",
    locator.imageRelId ?? "",
    locator.imageTarget ?? "",
    locator.captionIndex ?? "",
    locator.captionKind ?? "",
    locator.captionLabel ?? "",
    locator.sectionIndex ?? "",
    locator.fieldIndex ?? "",
    locator.fieldType ?? "",
    locator.styleIndex ?? "",
    locator.styleId ?? "",
    locator.listIndex ?? "",
    locator.listNumId ?? "",
    locator.listLevel ?? "",
    locator.hyperlinkIndex ?? "",
    locator.hyperlinkRelId ?? "",
    locator.hyperlinkAnchor ?? "",
    locator.tableIndex ?? "",
    locator.rowIndex ?? "",
    locator.cellIndex ?? "",
    locator.normalizedHash ?? "",
  ].join("|")
}

function findTableCellContaining(inspection: WordDocumentInspection, text: string) {
  if (!text.trim()) return undefined
  for (const table of inspection.tables) {
    for (const [rowIndex, row] of table.rows.entries()) {
      for (const [cellIndex, cellText] of row.entries()) {
        if (!cellText.includes(text)) continue
        const locator = inspection.locators.find((item) =>
          item.kind === "tableCell"
          && item.tableIndex === table.tableIndex
          && item.rowIndex === rowIndex
          && item.cellIndex === cellIndex
        )
        if (locator) return { locator, text: cellText }
      }
    }
  }
  return undefined
}

function normalizeReplacementEndpoint(text: string) {
  return text.trim().replace(/^(?:表格|单元格)(?:里|内|中)?的?\s*/, "").trim()
}

function deterministicPlan(input: { question: string; targetPath: string; inspection: WordDocumentInspection }): DocumentEditPlan {
  const question = input.question.trim()
  const warnings: string[] = []
  const operations: DocumentEditOperation[] = []
  const wantsTrackedChanges = /修订模式|修订|红线|tracked|track changes|redline/i.test(question)
  const wantsRemoveComments = /删除.*批注|移除.*批注|清理.*批注|去掉.*批注|remove.*comments|strip.*comments/i.test(question)
  const wantsResolveComments = /解决.*批注|批注.*解决|标记.*批注.*完成|resolve.*comment/i.test(question)
  const wantsUpdateCommentText = /(?:更新|修改|替换|修订).*(?:批注|评论|comment|review note)|(?:批注|评论|comment|review note).*(?:更新|修改|替换|修订)/i.test(question)
  const wantsAcceptTrackedChanges = /接受.*修订|接受.*红线|accept.*tracked|accept.*redline/i.test(question)
  const wantsRejectTrackedChanges = /拒绝.*修订|拒绝.*红线|reject.*tracked|reject.*redline/i.test(question)
  const wantsMetadataScrub = /清理.*元数据|去除.*元数据|删除.*元数据|隐私.*清理|metadata.*scrub|scrub.*metadata|remove.*metadata/i.test(question)
  const wantsRedaction = /脱敏|匿名化|打码|遮罩|redact|anonym/i.test(question)
  const wantsRemoveWatermark = /删除.*水印|移除.*水印|去掉.*水印|remove.*watermark/i.test(question)
  const wantsPageSetup = /页面设置|页边距|页面方向|纸张|纸型|横向|纵向|landscape|portrait|\bA4\b|\bletter\b|margin/i.test(question)
  const wantsProtection = /限制编辑|保护文档|文档保护|只读|read.?only|comments.?only|tracked.?changes.?only|forms.?only|protect|protection|取消保护|清除保护|解除保护/i.test(question)
  const wantsTableHeaderRows = /(?:表格|table).*(?:表头|标题行|header row|header rows|repeat.*header)|(?:表头|标题行|header row|header rows|repeat.*header).*(?:表格|table)|重复.*(?:表头|标题行)/i.test(question)
  const wantsHeadingLevelFix = /(?:标题|heading).*(?:层级|级别|跳级|结构|hierarchy|level|skip)|(?:层级|级别|跳级|结构|hierarchy|level|skip).*(?:标题|heading)/i.test(question)
	  const wantsImageAltText = /图片.*(?:替代文本|alt|描述)|图.*(?:替代文本|alt|描述)|image.*alt|alt\s*text|accessibility|无障碍/i.test(question)
	  const wantsHyperlinkText = /(?:链接|超链接|hyperlink|link).*(?:文本|文案|描述|可访问|无障碍|accessibility|descriptive)|(?:文本|文案|描述|可访问|无障碍|accessibility|descriptive).*(?:链接|超链接|hyperlink|link)/i.test(question)
	  const wantsHyperlinkTarget = /(?:链接|超链接|hyperlink|link).*(?:目标|地址|url|URL|指向|跳转)|(?:目标|地址|url|URL|指向|跳转).*(?:链接|超链接|hyperlink|link)/i.test(question)
	  const wantsCaptionUpdate = /(?:更新|修改|替换|修订).*(?:图注|表注|caption|figure caption|table caption)|(?:图注|表注|caption|figure caption|table caption).*(?:更新|修改|替换|修订)/i.test(question)
	  const wantsNoteUpdate = /(?:更新|修改|替换|修订).*(?:脚注|尾注|note|footnote|endnote)|(?:脚注|尾注|note|footnote|endnote).*(?:更新|修改|替换|修订)/i.test(question)
	  const addWatermark = question.match(/(?:添加|新增|加上|加入|add).{0,20}(?:水印|watermark)[：: ]?["“]?([^"”\n。；;]{2,80})["”]?/i)
  const requestedUrl = question.match(/https?:\/\/[^\s"'”）)]+/i)?.[0]
  const replacement = question.match(/把(.{1,120}?)替换为(.{1,500})/)
  if (replacement) {
    const oldText = normalizeReplacementEndpoint(replacement[1]!)
    const newText = replacement[2]!.trim()
    const paragraphWithText = input.inspection.paragraphs.find((item) => item.text.includes(oldText))
    const tableCell = findTableCellContaining(input.inspection, oldText)
    const prefersTableCell = tableCell && (!paragraphWithText || /表格|单元格|table|cell/i.test(question))
    if (prefersTableCell) {
      const text = tableCell.text.replace(oldText, newText)
      operations.push(wantsTrackedChanges
        ? { type: "updateTableWithTrackedChange", locator: tableCell.locator, text, author: "ChipMate" }
        : { type: "updateTable", locator: tableCell.locator, text })
    } else {
      const paragraph = paragraphWithText ?? input.inspection.paragraphs.find((item) => item.text.trim())
      if (paragraph) {
        operations.push(wantsTrackedChanges
          ? { type: "replaceParagraphWithTrackedChange", locator: paragraph.locator, text: paragraph.text.replace(oldText, newText), author: "ChipMate" }
          : { type: "replaceText", locator: paragraph.locator, oldText, newText })
      } else warnings.push(`未找到可替换段落，无法生成 ${wantsTrackedChanges ? "replaceParagraphWithTrackedChange" : "replaceParagraph"} fallback。`)
    }
  }
  if (!wantsTableHeaderRows && /更新.*表格|表格.*更新|覆盖矩阵/.test(question)) {
    const cellLocator = input.inspection.locators.find((item) => item.kind === "tableCell" && item.rowIndex !== 0)
      ?? input.inspection.locators.find((item) => item.kind === "tableCell")
    if (cellLocator) operations.push({ type: "updateTable", locator: cellLocator, text: "已根据用户要求更新，请人工复核。" })
    else warnings.push("未找到表格单元格，无法生成 updateTable fallback。")
  }
  if (wantsTableHeaderRows) {
    const table = input.inspection.tables[0]
    if (table) operations.push({ type: "updateTableHeaderRows", locator: table.locator, headerRowCount: 1 })
    else warnings.push("未找到可更新表头行的表格，无法生成 updateTableHeaderRows fallback。")
  }
  if (/更新.*列表|列表.*更新|清单.*更新|update.*list/i.test(question)) {
    const list = input.inspection.lists[0]
    if (list) {
      operations.push({
        type: "updateList",
        locator: list.locator,
        items: list.items.map((item, index) => ({
          text: index === 0 ? "已根据用户要求更新，请人工复核。" : item.text,
          level: item.level === 1 || item.level === 2 ? item.level : 0,
        })),
      })
    } else warnings.push("未找到可更新的列表，无法生成 updateList fallback。")
  }
  if (wantsPageSetup) {
    const section = input.inspection.sections[0]
    if (section) {
      operations.push({
        type: "updateSectionPageSetup",
        locator: section.locator,
        page: fallbackPageSetupFromQuestion(question),
      })
    } else warnings.push("未找到可更新的 section，无法生成 updateSectionPageSetup fallback。")
  }
  if (wantsProtection) {
    operations.push({
      type: "setDocumentProtection",
      locator: input.inspection.protection?.locator ?? input.inspection.documentEndLocator,
      mode: fallbackProtectionModeFromQuestion(question),
    })
  }
  if (wantsHeadingLevelFix) {
    const repair = fallbackHeadingLevelRepair(input.inspection)
    if (repair) operations.push({ type: "updateHeadingLevel", locator: repair.locator, level: repair.level })
    else warnings.push("未找到可修复的标题层级跳跃，无法生成 updateHeadingLevel fallback。")
  }
  if (wantsImageAltText) {
    const image = input.inspection.images[0]
    if (image) operations.push({ type: "updateImageAltText", locator: image.locator, altText: "已根据用户要求补充图片替代文本，请人工复核。" })
    else warnings.push("未找到可更新的图片，无法生成 updateImageAltText fallback。")
  }
	  if (wantsHyperlinkText) {
	    const hyperlink = input.inspection.hyperlinks[0]
	    if (hyperlink) operations.push({ type: "updateHyperlinkText", locator: hyperlink.locator, text: "已根据用户要求更新为描述性链接文本，请人工复核。" })
	    else warnings.push("未找到可更新的超链接，无法生成 updateHyperlinkText fallback。")
	  }
	  if (wantsHyperlinkTarget) {
	    const hyperlink = input.inspection.hyperlinks[0]
	    if (hyperlink && requestedUrl) operations.push({ type: "updateHyperlinkTarget", locator: hyperlink.locator, url: requestedUrl })
	    else if (!hyperlink) warnings.push("未找到可更新目标的超链接，无法生成 updateHyperlinkTarget fallback。")
	    else warnings.push("用户请求更新超链接目标，但未在提示中找到明确 URL，未生成 updateHyperlinkTarget fallback。")
	  }
  if (wantsCaptionUpdate) {
    const caption = input.inspection.captions[0]
    if (caption) operations.push({ type: "updateCaptionText", locator: caption.locator, caption: "已根据用户要求更新图注/表注正文，请人工复核。" })
    else warnings.push("未找到可更新的图注或表注，无法生成 updateCaptionText fallback。")
  }
  if (wantsNoteUpdate) {
    const note = input.inspection.notes[0]
    if (note) operations.push({ type: "updateNoteText", locator: note.locator, text: "已根据用户要求更新脚注/尾注正文，请人工复核。" })
    else warnings.push("未找到可更新的脚注或尾注，无法生成 updateNoteText fallback。")
  }
  if (!wantsRemoveComments && !wantsResolveComments && wantsUpdateCommentText) {
    const comment = input.inspection.comments[0]
    if (comment) operations.push({ type: "updateCommentText", locator: comment.locator, text: "已根据用户要求更新批注正文，请人工复核。" })
    else warnings.push("未找到可更新的批注，无法生成 updateCommentText fallback。")
  }
  if (!wantsRemoveComments && !wantsResolveComments && !wantsUpdateCommentText && /批注|评论|comment|review note/i.test(question)) {
    const paragraph = input.inspection.paragraphs.find((item) => item.text.trim())
    if (paragraph) operations.push({ type: "addComment", locator: paragraph.locator, text: question || "请复核此处。", author: "ChipMate", initials: "CM" })
    else warnings.push("未找到可添加批注的段落，无法生成 addComment fallback。")
  }
  if (wantsRemoveComments) {
    operations.push({ type: "removeAllComments", locator: input.inspection.documentEndLocator })
  }
  if (wantsResolveComments) {
    const comment = input.inspection.comments[0]
    if (comment) operations.push({ type: "setCommentResolved", locator: comment.locator, resolved: true })
    else warnings.push("未找到可标记完成的批注，无法生成 setCommentResolved fallback。")
  }
  if (wantsAcceptTrackedChanges) {
    operations.push({ type: "acceptAllTrackedChanges", locator: input.inspection.documentEndLocator })
  }
  if (wantsRejectTrackedChanges) {
    operations.push({ type: "rejectAllTrackedChanges", locator: input.inspection.documentEndLocator })
  }
  if (wantsMetadataScrub) {
    operations.push({ type: "scrubDocumentMetadata", locator: input.inspection.documentEndLocator })
  }
  if (wantsRedaction) {
    const exactItems = extractRedactionItems(input.inspection)
    const patterns: Extract<DocumentEditOperation, { type: "redactText" }>["patterns"] = []
    if (/邮箱|邮件|email/i.test(question)) patterns.push({ kind: "email" })
    if (/电话|手机|手机号|phone|tel/i.test(question)) patterns.push({ kind: "phone" })
    if (exactItems.length || patterns.length) operations.push({ type: "redactText", locator: input.inspection.documentEndLocator, items: exactItems, patterns, includeComments: /批注|comments?/i.test(question) })
    else warnings.push("未识别到可安全精确脱敏的邮箱/电话/敏感文本，无法生成 redactText fallback。")
  }
  if (wantsRemoveWatermark) {
    const watermark = input.inspection.watermarks[0]
    if (watermark) operations.push({ type: "removeWatermark", locator: watermark.locator })
    else warnings.push("未找到可移除的水印，无法生成 removeWatermark fallback。")
  } else if (addWatermark?.[1]) {
    operations.push({ type: "addTextWatermark", locator: input.inspection.documentEndLocator, text: addWatermark[1].trim() })
  }
  if (/新增|添加|补充|加入|追加|完善|生成|汇报版|review|审稿/.test(question) || operations.length === 0) {
    operations.push({
      type: "insertSection",
      locator: input.inspection.documentEndLocator,
      title: extractSectionTitle(question),
      level: 1,
      paragraphs: [question || "根据用户要求补充本章节。"],
    })
  }
  return {
    planId: `word-edit-${Date.now().toString(36)}`,
    targetPath: input.targetPath,
    outputFilenameBase: safeFilenameBase(input.inspection.metadata.title || "word-edit"),
    operations,
    warnings,
  }
}

function locatorPrompt(inspection: WordDocumentInspection) {
  return {
    summary: {
      trackedChangeCount: inspection.summary.trackedChangeCount,
      trackedChangeTypeCounts: inspection.summary.trackedChangeTypeCounts,
      advancedTrackedChangeWarnings: inspection.summary.advancedTrackedChangeWarnings,
      protectionMode: inspection.summary.protectionMode,
    },
    documentEndLocator: inspection.documentEndLocator,
    paragraphs: inspection.paragraphs.slice(0, 80).map((item) => ({
      locator: item.locator,
      text: item.text.slice(0, 240),
      styleId: item.styleId,
      headingLevel: item.headingLevel,
      list: item.list,
      headingPath: item.headingPath,
    })),
    lists: inspection.lists.slice(0, 40).map((item) => ({
      locator: item.locator,
      kind: item.kind,
      numId: item.numId,
      levelCount: item.levelCount,
      itemCount: item.itemCount,
      headingPath: item.headingPath,
      itemsPreview: item.items.slice(0, 12),
    })),
    tables: inspection.tables.slice(0, 20).map((item) => ({
      locator: item.locator,
      headingPath: item.headingPath,
      rowsPreview: item.rows.slice(0, 8).map((row) => row.slice(0, 8)),
      cellLocators: inspection.locators.filter((locator) => locator.kind === "tableCell" && locator.tableIndex === item.tableIndex).slice(0, 40),
    })),
    comments: inspection.comments.slice(0, 40).map((item) => ({
      locator: item.locator,
      text: item.text.slice(0, 240),
      author: item.author,
      resolved: item.resolved,
      anchorText: item.anchorText,
    })),
    contentControls: inspection.contentControls.slice(0, 80).map((item) => ({
      locator: item.locator,
      tag: item.tag,
      title: item.title,
      text: item.text.slice(0, 240),
      kind: item.kind,
      fillSupported: item.fillSupported,
      fillUnsupportedReason: item.fillUnsupportedReason,
      nestedControlCount: item.nestedControlCount,
      hasRichContent: item.hasRichContent,
      checked: item.checked,
      options: item.options?.slice(0, 40),
      dateFormat: item.dateFormat,
    })),
    watermarks: inspection.watermarks.slice(0, 40).map((item) => ({
      locator: item.locator,
      part: item.part,
      kind: item.kind,
      text: item.text.slice(0, 160),
    })),
    notes: inspection.notes.slice(0, 80).map((item) => ({
      locator: item.locator,
      part: item.part,
      kind: item.noteKind,
      noteId: item.noteId,
      text: item.text.slice(0, 240),
    })),
    images: inspection.images.slice(0, 80).map((item) => ({
      locator: item.locator,
      part: item.part,
      relId: item.relId,
      target: item.target,
      mediaPath: item.mediaPath,
      name: item.name,
      altText: item.altText,
      widthEmu: item.widthEmu,
      heightEmu: item.heightEmu,
    })),
    captions: inspection.captions.slice(0, 80).map((item) => ({
      locator: item.locator,
      kind: item.captionKind,
      label: item.label,
      number: item.number,
      text: item.text.slice(0, 240),
      fullText: item.fullText.slice(0, 240),
      bookmark: item.bookmark,
      fieldInstruction: item.fieldInstruction,
      headingPath: item.headingPath,
    })),
    hyperlinks: inspection.hyperlinks.slice(0, 80).map((item) => ({
      locator: item.locator,
      part: item.part,
      text: item.text.slice(0, 240),
      relId: item.relId,
      target: item.target,
      anchor: item.anchor,
      tooltip: item.tooltip,
    })),
    protection: inspection.protection ? {
      locator: inspection.protection.locator,
      part: inspection.protection.part,
      mode: inspection.protection.mode,
      enforced: inspection.protection.enforced,
      formatting: inspection.protection.formatting,
    } : undefined,
    sections: inspection.sections.slice(0, 20).map((item) => ({
      locator: item.locator,
      part: item.part,
      type: item.type,
      isFinal: item.isFinal,
      differentFirstPage: item.differentFirstPage,
      oddEvenHeaders: item.oddEvenHeaders,
      page: item.page,
      headers: item.headers,
      footers: item.footers,
      headerFooterLinks: item.headerFooterLinks,
    })),
    fields: inspection.fields.slice(0, 80).map((item) => ({
      locator: item.locator,
      part: item.part,
      kind: item.fieldKind,
      type: item.type,
      instruction: item.instruction.slice(0, 240),
      cachedText: item.cachedText?.slice(0, 240),
    })),
    styles: inspection.styles.slice(0, 120).map((item) => ({
      locator: item.locator,
      part: item.part,
      styleId: item.styleId,
      type: item.type,
      name: item.name,
      basedOn: item.basedOn,
      isDefault: item.isDefault,
      paragraphUseCount: item.paragraphUseCount,
      runUseCount: item.runUseCount,
    })),
  }
}

function unsupportedTrackedChangeTypesForCleanCopy(inspection: WordDocumentInspection) {
  const counts = inspection.summary.trackedChangeTypeCounts ?? {}
  return ["rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange"].filter((type) => (counts[type] ?? 0) > 0)
}

function normalizeCellUpdate(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  return {
    rowIndex: Number(raw.rowIndex),
    cellIndex: Number(raw.cellIndex),
    text: String(raw.text ?? "").trim(),
  }
}

function normalizeHeaderRowCount(input: unknown) {
  const value = Number(input)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(10, Math.round(value)))
}

function normalizeListUpdateItem(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 1000) : ""
  if (!text) return undefined
  const level = Number(raw.level)
  return {
    text,
    level: level === 1 || level === 2 ? level : 0,
  } as { text: string; level: 0 | 1 | 2 }
}

function normalizeSectionPageSetup(input: unknown): Extract<DocumentEditOperation, { type: "updateSectionPageSetup" }>["page"] {
  if (!input || typeof input !== "object") return {}
  const raw = input as Record<string, unknown>
  const size = typeof raw.size === "string" ? raw.size.toLowerCase() : undefined
  const orientation = typeof raw.orientation === "string" ? raw.orientation.toLowerCase() : undefined
  return {
    size: size === "a4" || size === "letter" ? size : undefined,
    widthTwips: normalizeTwips(raw.widthTwips),
    heightTwips: normalizeTwips(raw.heightTwips),
    orientation: orientation === "portrait" || orientation === "landscape" ? orientation : undefined,
    margins: normalizeSectionMargins(raw.margins),
  }
}

function normalizeSectionMargins(input: unknown): Extract<DocumentEditOperation, { type: "updateSectionPageSetup" }>["page"]["margins"] {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const margins = {
    top: normalizeTwips(raw.top),
    right: normalizeTwips(raw.right),
    bottom: normalizeTwips(raw.bottom),
    left: normalizeTwips(raw.left),
    header: normalizeTwips(raw.header),
    footer: normalizeTwips(raw.footer),
    gutter: normalizeTwips(raw.gutter),
  }
  return Object.values(margins).some((value) => value !== undefined) ? margins : undefined
}

function normalizeProtectionMode(input: unknown): Extract<DocumentEditOperation, { type: "setDocumentProtection" }>["mode"] {
  const value = String(input ?? "").trim().replace(/[-\s]+/g, "_").toLowerCase()
  if (value === "off" || value === "none" || value === "clear" || value === "unprotected") return "off"
  if (value === "readonly" || value === "read_only") return "readOnly"
  if (value === "comments" || value === "commentsonly" || value === "comments_only") return "comments"
  if (value === "trackedchanges" || value === "tracked_changes" || value === "trackedchangesonly" || value === "tracked_changes_only") return "trackedChanges"
  if (value === "forms" || value === "formsonly" || value === "forms_only") return "forms"
  return "off"
}

function normalizeTwips(input: unknown) {
  if (input === undefined || input === null || input === "") return undefined
  const value = Number(input)
  return Number.isFinite(value) ? Math.round(value) : undefined
}

function normalizeRedactionItem(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 500) : ""
  if (!text) return undefined
  return {
    text,
    replacement: typeof raw.replacement === "string" ? raw.replacement.slice(0, 200) : undefined,
    preserveLength: raw.preserveLength !== false,
  }
}

function normalizeRedactionPattern(input: unknown): RedactionPatternSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const kind = raw.kind === "email" || raw.kind === "phone" || raw.kind === "custom" ? raw.kind : typeof raw.pattern === "string" ? "custom" : undefined
  const pattern = typeof raw.pattern === "string" ? raw.pattern.trim().slice(0, 200) : undefined
  if (!kind && !pattern) return undefined
  return {
    kind,
    pattern,
    flags: typeof raw.flags === "string" ? uniqueRegexFlags(raw.flags).replace(/g/g, "") : undefined,
    label: typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : undefined,
    replacement: typeof raw.replacement === "string" ? raw.replacement.slice(0, 200) : undefined,
    preserveLength: raw.preserveLength !== false,
  }
}

function extractRedactionItems(inspection: WordDocumentInspection) {
  const haystack = [
    ...inspection.paragraphs.map((item) => item.text),
    ...inspection.tables.flatMap((table) => table.rows.flat()),
    ...inspection.notes.map((item) => item.text),
  ].join("\n")
  const matches = haystack.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
  return [...new Set(matches)].slice(0, 20).map((text) => ({ text }))
}

function uniqueRegexFlags(input: string | undefined) {
  return [...new Set((input ?? "").replace(/[^imsu]/g, "").split(""))].join("")
}

function fallbackPageSetupFromQuestion(question: string): Extract<DocumentEditOperation, { type: "updateSectionPageSetup" }>["page"] {
  const size = /\bletter\b/i.test(question) ? "letter" as const : /\bA4\b/i.test(question) ? "a4" as const : undefined
  const orientation = /横向|landscape/i.test(question) ? "landscape" as const : /纵向|portrait/i.test(question) ? "portrait" as const : undefined
  const narrowMargins = /窄边距|narrow/i.test(question)
  const mentionsMargins = /页边距|margin/i.test(question)
  const defaultMargins = !size && !orientation && !mentionsMargins
  return {
    size,
    orientation,
    margins: narrowMargins
      ? { top: 720, right: 720, bottom: 720, left: 720 }
      : mentionsMargins || defaultMargins ? { top: 1440, right: 1440, bottom: 1440, left: 1440 } : undefined,
  }
}

function fallbackProtectionModeFromQuestion(question: string): Extract<DocumentEditOperation, { type: "setDocumentProtection" }>["mode"] {
  if (/取消保护|清除保护|解除保护|remove.*protection|clear.*protection|unprotect/i.test(question)) return "off"
  if (/批注|评论|comments?.?only/i.test(question)) return "comments"
  if (/修订|红线|tracked.?changes?.?only/i.test(question)) return "trackedChanges"
  if (/表单|forms?.?only/i.test(question)) return "forms"
  if (/只读|read.?only|protect|protection|限制编辑|保护文档|文档保护/i.test(question)) return "readOnly"
  return "readOnly"
}

function fallbackHeadingLevelRepair(inspection: WordDocumentInspection): { locator: WordDocumentLocator; level: 1 | 2 | 3 } | undefined {
  let previous: 1 | 2 | 3 | undefined
  for (const paragraph of inspection.paragraphs) {
    const level = paragraph.headingLevel
    if (!level) continue
    if (previous && level > previous + 1) return { locator: paragraph.locator, level: Math.min(3, previous + 1) as 1 | 2 | 3 }
    previous = level
  }
  return undefined
}

function validateTwips(value: number | undefined, field: string, min: number, max: number, errors: string[]) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < min || value > max) errors.push(`${field} must be an integer between ${min} and ${max} twips.`)
}

function normalizeLevel(input: unknown): 1 | 2 | 3 {
  return input === 2 || input === 3 ? input : 1
}

function normalizeTables(input: unknown): TableSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const tables: TableSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const headers = stringArray(raw.headers)
    const rows = normalizeTableRows(raw.rows)
    if (headers.length && rows.length) {
      tables.push({
        id: typeof raw.id === "string" ? cleanId(raw.id) : undefined,
        caption: typeof raw.caption === "string" ? raw.caption.trim().slice(0, 300) : undefined,
        label: typeof raw.label === "string" ? raw.label.trim().slice(0, 40) : undefined,
        number: typeof raw.number === "string" ? raw.number.trim().slice(0, 40) : undefined,
        bookmark: typeof raw.bookmark === "string" ? raw.bookmark.trim().slice(0, 80) : undefined,
        headers,
        rows,
        columnWidthRatios: normalizeColumnWidthRatios(raw.columnWidthRatios, headers.length),
        columnAlignments: normalizeColumnAlignments(raw.columnAlignments, headers.length),
        repeatHeader: raw.repeatHeader === false ? false : undefined,
      })
    }
  }
  return tables.length ? tables : undefined
}

function normalizeTableRows(input: unknown): TableCellValue[][] {
  if (!Array.isArray(input)) return []
  return input
    .map((row) => Array.isArray(row)
      ? row.map(normalizeTableCellValue).filter((cell): cell is TableCellValue => Boolean(cell))
      : [])
    .filter((row) => row.length > 0)
}

function normalizeColumnWidthRatios(input: unknown, expectedLength: number) {
  if (!Array.isArray(input) || input.length !== expectedLength) return undefined
  const values = input.map((item) => Number(item))
  return values.every((item) => Number.isFinite(item) && item > 0) ? values : undefined
}

function normalizeColumnAlignments(input: unknown, expectedLength: number): Array<"left" | "center" | "right"> | undefined {
  if (!Array.isArray(input) || input.length !== expectedLength) return undefined
  const values = input.map((item) => item === "center" || item === "right" ? item : "left")
  return values
}

function normalizeCallouts(input: unknown): CalloutSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const callouts: CalloutSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const kind = normalizeCalloutKind(raw.kind)
    const title = String(raw.title ?? "").trim().slice(0, 160)
    const body = String(raw.body ?? "").trim().slice(0, 2000)
    if (title && body) callouts.push({ kind, title, body })
  }
  return callouts.length ? callouts.slice(0, 8) : undefined
}

function normalizeCalloutKind(input: unknown): CalloutSpec["kind"] {
  return input === "warning" || input === "risk" || input === "success" ? input : "info"
}

function normalizeBriefCards(input: unknown): BriefCardSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const cards: BriefCardSpec[] = []
  for (const item of input) {
    const card = normalizeBriefCard(item)
    if (card) cards.push(card)
  }
  return cards.length ? cards.slice(0, 12) : undefined
}

function normalizeBriefCard(input: unknown): BriefCardSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const title = String(raw.title ?? "").trim().slice(0, 120)
  const value = typeof raw.value === "string" ? raw.value.trim().slice(0, 120) : undefined
  const body = typeof raw.body === "string" ? raw.body.trim().slice(0, 500) : undefined
  const footer = typeof raw.footer === "string" ? raw.footer.trim().slice(0, 200) : undefined
  if (!title || (!value && !body && !footer)) return undefined
  return {
    title,
    value,
    body,
    footer,
    tone: normalizeBriefCardTone(raw.tone),
  }
}

function normalizeBriefCardsGroup(input: unknown): BriefCardsSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const cards = normalizeBriefCards(raw.cards)
  if (!cards?.length) return undefined
  return {
    cards,
    columns: normalizeBriefCardColumns(raw.columns),
  }
}

function normalizeBriefCardTone(input: unknown): BriefCardSpec["tone"] {
  return input === "info" || input === "success" || input === "warning" || input === "risk" ? input : input === "neutral" ? "neutral" : undefined
}

function normalizeBriefCardColumns(input: unknown): BriefCardsSpec["columns"] {
  return input === 1 || input === 2 || input === 3 ? input : undefined
}

function normalizeEvidenceCards(input: unknown): EvidenceCardSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const cards: EvidenceCardSpec[] = []
  for (const item of input) {
    const card = normalizeEvidenceCard(item)
    if (card) cards.push(card)
  }
  return cards.length ? cards.slice(0, 12) : undefined
}

function normalizeEvidenceCard(input: unknown): EvidenceCardSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const title = String(raw.title ?? "").trim().slice(0, 160)
  const summary = String(raw.summary ?? raw.body ?? "").trim().slice(0, 1000)
  if (!title || !summary) return undefined
  return {
    title,
    summary,
    source: typeof raw.source === "string" ? raw.source.trim().slice(0, 240) : undefined,
    path: typeof raw.path === "string" ? raw.path.trim().slice(0, 500) : undefined,
    locator: typeof raw.locator === "string" ? raw.locator.trim().slice(0, 240) : undefined,
    quote: typeof raw.quote === "string" ? raw.quote.trim().slice(0, 1000) : undefined,
    role: normalizeEvidenceRole(raw.role),
    confidence: normalizeEvidenceConfidence(raw.confidence),
    sourceRefs: stringArray(raw.sourceRefs).slice(0, 12).map((item) => item.slice(0, 120)),
  }
}

function normalizeEvidenceCardsGroup(input: unknown): EvidenceCardsSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const cards = normalizeEvidenceCards(raw.cards)
  if (!cards?.length) return undefined
  return {
    cards,
    columns: normalizeEvidenceCardColumns(raw.columns),
  }
}

function normalizeEvidenceRole(input: unknown): EvidenceCardSpec["role"] {
  return input === "primary" || input === "supporting" || input === "contradictory" || input === "background" ? input : undefined
}

function normalizeEvidenceConfidence(input: unknown): EvidenceCardSpec["confidence"] {
  return input === "high" || input === "medium" || input === "low" ? input : undefined
}

function normalizeEvidenceCardColumns(input: unknown): EvidenceCardsSpec["columns"] {
  return input === 1 || input === 2 ? input : undefined
}

function normalizeQuoteBlocks(input: unknown): QuoteBlockSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const quoteBlocks: QuoteBlockSpec[] = []
  for (const item of input) {
    const quoteBlock = normalizeQuoteBlock(item)
    if (quoteBlock) quoteBlocks.push(quoteBlock)
  }
  return quoteBlocks.length ? quoteBlocks.slice(0, 8) : undefined
}

function normalizeQuoteBlock(input: unknown): QuoteBlockSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const text = String(raw.text ?? "").trim().slice(0, 2000)
  if (!text) return undefined
  return {
    kind: raw.kind === "pullQuote" ? "pullQuote" : "quote",
    text,
    attribution: typeof raw.attribution === "string" ? raw.attribution.trim().slice(0, 300) : undefined,
    source: typeof raw.source === "string" ? raw.source.trim().slice(0, 300) : undefined,
  }
}

function normalizeCodeBlocks(input: unknown): CodeBlockSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const codeBlocks: CodeBlockSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const code = String(raw.code ?? "").trim().slice(0, 8000)
    if (!code) continue
    codeBlocks.push({
      language: typeof raw.language === "string" ? raw.language.trim().slice(0, 40) : undefined,
      caption: typeof raw.caption === "string" ? raw.caption.trim().slice(0, 300) : undefined,
      code,
    })
  }
  return codeBlocks.length ? codeBlocks.slice(0, 8) : undefined
}

function normalizeWordLists(input: unknown): WordListSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const lists: WordListSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const kind = normalizeWordListKind(raw.kind)
    const items = normalizeWordListItems(raw.items)
    if (!items.length) continue
    lists.push({
      kind,
      title: typeof raw.title === "string" ? raw.title.trim().slice(0, 160) : undefined,
      items,
    })
  }
  return lists.length ? lists.slice(0, 8) : undefined
}

function normalizeWordListKind(input: unknown): WordListSpec["kind"] {
  return input === "numbered" || input === "checklist" ? input : "bullet"
}

function normalizeWordListItems(input: unknown): WordListItemSpec[] {
  if (!Array.isArray(input)) return []
  const items: WordListItemSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const text = String(raw.text ?? "").trim().slice(0, 500)
    const children = normalizeWordListItems(raw.children).slice(0, 20)
    if (!text && !children.length) continue
    items.push({
      text,
      level: normalizeListLevel(raw.level),
      checked: typeof raw.checked === "boolean" ? raw.checked : undefined,
      children: children.length ? children : undefined,
    })
  }
  return items.slice(0, 60)
}

function normalizeListLevel(input: unknown): 0 | 1 | 2 | undefined {
  if (input !== 0 && input !== 1 && input !== 2) return undefined
  return input
}

function flattenWordListItems(items: WordListItemSpec[]): WordListItemSpec[] {
  const flattened: WordListItemSpec[] = []
  for (const item of items) {
    if (item.text?.trim()) flattened.push(item)
    if (item.children?.length) flattened.push(...flattenWordListItems(item.children))
  }
  return flattened
}

function normalizeFigures(input: unknown): FigureSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const figures: FigureSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const image = raw.image && typeof raw.image === "object" ? raw.image as Record<string, unknown> : undefined
    const title = String(raw.title ?? "").trim().slice(0, 160)
    const base64 = typeof image?.base64 === "string" ? image.base64.trim() : undefined
    const width = Math.trunc(Number(image?.width))
    const height = Math.trunc(Number(image?.height))
    if (!title || !base64 || !Number.isFinite(width) || !Number.isFinite(height)) continue
    figures.push({
      id: typeof raw.id === "string" ? cleanId(raw.id) : undefined,
      title,
      caption: typeof raw.caption === "string" ? raw.caption.trim().slice(0, 300) : undefined,
      label: typeof raw.label === "string" ? raw.label.trim().slice(0, 40) : undefined,
      number: typeof raw.number === "string" ? raw.number.trim().slice(0, 40) : undefined,
      bookmark: typeof raw.bookmark === "string" ? raw.bookmark.trim().slice(0, 80) : undefined,
      altText: typeof raw.altText === "string" ? raw.altText.trim().slice(0, 500) : undefined,
      image: {
        contentType: "image/png",
        base64,
        width,
        height,
      },
    })
  }
  return figures.length ? figures.slice(0, 4) : undefined
}

function normalizeRichParagraphs(input: unknown): ParagraphSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const paragraphs: ParagraphSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const runs = normalizeParagraphRuns(raw.runs)
    if (!runs.length) continue
    paragraphs.push({
      runs,
      style: raw.style === "muted" ? "muted" : raw.style === "body" ? "body" : undefined,
      alignment: raw.alignment === "center" || raw.alignment === "right" || raw.alignment === "left" ? raw.alignment : undefined,
    })
  }
  return paragraphs.length ? paragraphs.slice(0, 20) : undefined
}

function normalizeParagraphRuns(input: unknown): ParagraphRunSpec[] {
  if (!Array.isArray(input)) return []
  const runs: ParagraphRunSpec[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const hyperlink = raw.hyperlink && typeof raw.hyperlink === "object" ? raw.hyperlink as Record<string, unknown> : undefined
    const reference = raw.reference && typeof raw.reference === "object" ? raw.reference as Record<string, unknown> : undefined
    const note = raw.note && typeof raw.note === "object" ? raw.note as Record<string, unknown> : undefined
    const run: ParagraphRunSpec = {
      text: typeof raw.text === "string" ? raw.text.slice(0, 1000) : undefined,
      bold: typeof raw.bold === "boolean" ? raw.bold : undefined,
      italic: typeof raw.italic === "boolean" ? raw.italic : undefined,
      hyperlink: hyperlink
        ? {
            url: typeof hyperlink.url === "string" ? hyperlink.url.trim().slice(0, 2048) : undefined,
            anchor: typeof hyperlink.anchor === "string" ? hyperlink.anchor.trim().slice(0, 120) : undefined,
            tooltip: typeof hyperlink.tooltip === "string" ? hyperlink.tooltip.trim().slice(0, 160) : undefined,
          }
        : undefined,
      reference: reference
        ? {
            bookmark: typeof reference.bookmark === "string" ? reference.bookmark.trim().slice(0, 120) : "",
            field: reference.field === "PAGEREF" ? "PAGEREF" : "REF",
            fallbackText: typeof reference.fallbackText === "string" ? reference.fallbackText.trim().slice(0, 200) : undefined,
          }
        : undefined,
      note: note
        ? {
            kind: note.kind === "endnote" ? "endnote" : "footnote",
            text: typeof note.text === "string" ? note.text.trim().slice(0, 1000) : "",
          }
        : undefined,
    }
    if (run.hyperlink && !run.hyperlink.url && !run.hyperlink.anchor) run.hyperlink = undefined
    if (run.reference && !run.reference.bookmark) run.reference = undefined
    if (run.note && !run.note.text) run.note = undefined
    const visible = run.text?.trim() || run.hyperlink?.url || run.hyperlink?.anchor || run.reference?.bookmark || run.note?.text
    if (!visible) continue
    runs.push(run)
  }
  return runs.slice(0, 40)
}

function normalizeInsertSectionBlocks(input: unknown): InsertSectionBlockSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const blocks: InsertSectionBlockSpec[] = []
  for (const item of input) {
    const block = normalizeInsertSectionBlock(item)
    if (block) blocks.push(block)
  }
  return blocks.length ? blocks.slice(0, 40) : undefined
}

function normalizeInsertSectionBlock(input: unknown): InsertSectionBlockSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  if (raw.type === "paragraph") {
    const text = String(raw.text ?? "").trim().slice(0, 2000)
    return text ? { type: "paragraph", text } : undefined
  }
  if (raw.type === "richParagraph") {
    const paragraphInput = raw.paragraph ?? raw.richParagraph ?? raw
    const paragraph = normalizeRichParagraphs([paragraphInput])?.[0]
    return paragraph ? { type: "richParagraph", paragraph } : undefined
  }
  if (raw.type === "list") {
    const list = normalizeWordLists([raw.list ?? raw])?.[0]
    return list ? { type: "list", list } : undefined
  }
  if (raw.type === "figure") {
    const figure = normalizeFigures([raw.figure ?? raw])?.[0]
    return figure ? { type: "figure", figure } : undefined
  }
  if (raw.type === "table") {
    const table = normalizeTables([raw.table ?? raw])?.[0]
    return table ? { type: "table", table } : undefined
  }
  if (raw.type === "callout") {
    const callout = normalizeCallouts([raw.callout ?? raw])?.[0]
    return callout ? { type: "callout", callout } : undefined
  }
  if (raw.type === "briefCards") {
    const briefCards = normalizeBriefCardsGroup(raw.briefCards ?? raw)
    return briefCards ? { type: "briefCards", briefCards } : undefined
  }
  if (raw.type === "evidenceCards") {
    const evidenceCards = normalizeEvidenceCardsGroup(raw.evidenceCards ?? raw)
    return evidenceCards ? { type: "evidenceCards", evidenceCards } : undefined
  }
  if (raw.type === "quoteBlock") {
    const quoteBlock = normalizeQuoteBlocks([raw.quoteBlock ?? raw])?.[0]
    return quoteBlock ? { type: "quoteBlock", quoteBlock } : undefined
  }
  if (raw.type === "codeBlock") {
    const codeBlock = normalizeCodeBlocks([raw.codeBlock ?? raw])?.[0]
    return codeBlock ? { type: "codeBlock", codeBlock } : undefined
  }
  return undefined
}

function stringArray(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []
}

function cleanId(input: unknown) {
  return typeof input === "string" ? input.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) : ""
}

function safeFilenameBase(input: string) {
  return input.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "word-edit"
}

function extractSectionTitle(question: string) {
  const match = question.match(/(?:新增|添加|补充|加入|追加)(?:一个|一节|章节|一章)?[“"「]?([^“"」\n，。,.]{2,40})[”"」]?/)
  if (match?.[1]) return match[1].replace(/章节$/, "").trim() || "补充说明"
  if (/覆盖矩阵/.test(question)) return "覆盖矩阵补充说明"
  if (/review|审稿|修订/.test(question)) return "审稿修订说明"
  return "补充说明"
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
