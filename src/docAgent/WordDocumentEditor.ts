import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import * as vscode from "vscode"
import { DocxFileStore } from "./DocxFileStore"
import { locatorKey, validateDocumentEditPlan } from "./DocumentEditPlan"
import { renderWordDocument } from "./WordRenderQualityGate"
import { applyOoxmlPartPatches, normalizeOoxmlPackagePart, validateOoxmlXmlSafety } from "./OoxmlPatch"
import { tableCellAlignment, tableCellColSpan, tableCellRowSpan, tableCellText } from "./TableSpecUtils"
import {
  loadDocxZip,
  listKindByNumIdFromNumberingXml,
  parseTopLevelElements,
  paragraphListInfo,
  paragraphStyleId,
  tableRows,
  xmlTextFrom,
} from "./WordDocumentInspector"
import {
  analyzeContentControlFillSupport,
  contentControlKindFromXml,
  topLevelSdtXmlBlocks,
} from "./WordContentControlXml"
import type {
	  CalloutSpec,
	  BriefCardSpec,
	  BriefCardsSpec,
	  CodeBlockSpec,
	  DocumentEditOperation,
	  DocumentEditPlan,
	  EvidenceCardSpec,
	  EvidenceCardsSpec,
	  FigureSpec,
	  InsertSectionBlockSpec,
		  ParagraphRunSpec,
		  ParagraphSpec,
		  QualityIssue,
		  QuoteBlockSpec,
		  RedactionExactItem,
		  RedactionPatternSpec,
		  TableSpec,
	  WordDocumentInspection,
	  WordDocumentLocator,
	  WordEditRenderCheckResult,
	  WordEditStructureCheckResult,
	  WordTablePreservationCheckResult,
	  WordListItemSpec,
	  WordListSpec,
	} from "./types"

const nodeRequire = createRequire(__filename)
const PAGE_SIZE_TWIPS = {
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 },
} as const

type JsZipCtor = new () => {
  file(path: string, data: string | Uint8Array): void
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
}

type ApplyResult = {
  path: string
  absolutePath: string
  bytes: Uint8Array
  appliedOperations: Array<{ type: DocumentEditOperation["type"]; locator: WordDocumentLocator; detail: string }>
  structureCheckResult: WordEditStructureCheckResult
  tablePreservationCheckResult: WordTablePreservationCheckResult
  renderCheckResult: WordEditRenderCheckResult
  repairAttempted: boolean
  warnings: string[]
  errors: string[]
}

type CommentDraft = {
  id: number
  text: string
  author: string
  initials: string
  date: string
}

type CommentResolutionUpdate = {
  commentId: string
  resolved: boolean
}

type CommentTextUpdate = {
  commentId: string
  text: string
}

type DocumentProtectionUpdate = {
  mode: Extract<DocumentEditOperation, { type: "setDocumentProtection" }>["mode"]
  enforce?: boolean
}

type InsertListNumberingIds = {
  bullet: number
  numbered: number
  checklistUnchecked: number
  checklistChecked: number
}

type InsertedFigureBuildItem = {
  figure: FigureSpec
  relId: string
  target: string
  mediaPath: string
  width: number
  height: number
  docPrId: number
  bookmarkId: number
}

type InsertedNoteBuildItem = {
  run: ParagraphRunSpec
  id: number
  kind: "footnote" | "endnote"
  text: string
}

type NumberingLevelSpec = {
  format: "bullet" | "decimal"
  text: string
  font?: string
}

type InsertSectionRenderContext = {
  numberingIds?: InsertListNumberingIds
  figureBySpec: Map<FigureSpec, InsertedFigureBuildItem>
  hyperlinkRelIds: Map<ParagraphRunSpec, string>
  noteMap: Map<ParagraphRunSpec, InsertedNoteBuildItem>
}

type RedactionAudit = {
  totalMatches: number
  exactMatches: number
  patternMatches: number
  touchedTextNodes: number
  touchedParts: number
  patternLabels: Record<string, number>
}

export class WordDocumentEditor {
  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async apply(input: {
    sourcePath: string
    bytes: Uint8Array
    inspection: WordDocumentInspection
    plan: DocumentEditPlan
    signal?: AbortSignal
    log?: (message: string) => void
    remoteEndpoint?: string
  }): Promise<ApplyResult> {
    input.signal?.throwIfAborted()
    const validation = validateDocumentEditPlan(input.plan, input.inspection)
    if (!validation.ok || !validation.plan) throw new Error(`DocumentEditPlan validation failed: ${validation.errors.join("; ")}`)
    const tempRoot = await mkdtemp(path.join(tmpdir(), "chipmate-word-edit-"))
    const unpacked = path.join(tempRoot, "unpacked")
    const candidate = path.join(tempRoot, "candidate.docx")
    try {
      await mkdir(unpacked, { recursive: true })
      await writeFile(path.join(tempRoot, "source.docx"), input.bytes)
      const zip = await loadDocxZip(input.bytes)
      await unpackZip(zip, unpacked)
      const documentPath = path.join(unpacked, "word", "document.xml")
      let documentXml = await readFile(documentPath, "utf8")
      const listKindByNumId = listKindByNumIdFromNumberingXml(await readTextIfExists(path.join(unpacked, "word", "numbering.xml")))
      let nextCommentId = nextCommentIdFromXml(await readTextIfExists(path.join(unpacked, "word", "comments.xml")))
      let nextRevisionId = nextRevisionIdFromXml(documentXml)
      let trackedRevisionUsed = false
      let removeAllCommentsRequested = false
      let trackedChangeCleanMode: "accept" | "reject" | undefined
      let documentProtectionUpdate: DocumentProtectionUpdate | undefined
      let metadataScrubRequested = false
      const redactionRequests: Array<Extract<DocumentEditOperation, { type: "redactText" }>> = []
      const redactionOperationIndexes: number[] = []
      const appliedOperations: ApplyResult["appliedOperations"] = []
      const commentDrafts: CommentDraft[] = []
      const commentTextUpdates: CommentTextUpdate[] = []
      const commentResolutionUpdates: CommentResolutionUpdate[] = []
      for (const operation of validation.plan.operations) {
        input.signal?.throwIfAborted()
	        let applied: { documentXml: string; detail: string }
	        if (operation.type === "addComment") applied = addCommentOperation(documentXml, operation, commentDrafts, nextCommentId++)
	        else if (operation.type === "replaceParagraphWithRichParagraph") applied = await replaceParagraphWithRichParagraph(unpacked, documentXml, operation)
	        else if (operation.type === "replaceParagraphWithBlocks") applied = await replaceParagraphWithBlocks(unpacked, documentXml, operation)
	        else if (operation.type === "replaceParagraphWithTrackedChange") applied = trackedReplaceParagraph(documentXml, operation, nextRevisionId)
        else if (operation.type === "replaceParagraphWithRichTrackedChange") applied = await trackedReplaceParagraphWithRichParagraph(unpacked, documentXml, operation, nextRevisionId)
        else if (operation.type === "replaceTextWithTrackedChange") applied = trackedReplaceText(documentXml, operation, nextRevisionId)
        else if (operation.type === "updateTableWithTrackedChange") applied = trackedUpdateTableCell(documentXml, operation, nextRevisionId)
        else if (operation.type === "updateCommentText") applied = updateCommentTextOperation(documentXml, operation, commentTextUpdates)
        else if (operation.type === "setCommentResolved") applied = setCommentResolvedOperation(documentXml, operation, commentResolutionUpdates)
        else if (operation.type === "addTextWatermark") applied = await addTextWatermarkOperation(unpacked, documentXml, operation)
        else if (operation.type === "removeWatermark") applied = await removeWatermarkOperation(unpacked, documentXml, operation)
        else if (operation.type === "replaceImage") applied = await replaceImageOperation(unpacked, documentXml, operation)
        else if (operation.type === "updateImageAltText") applied = await updateImageAltTextOperation(unpacked, documentXml, operation)
        else if (operation.type === "updateNoteText") applied = await updateNoteTextOperation(unpacked, documentXml, operation)
        else if (operation.type === "updateHyperlinkTarget") applied = await updateHyperlinkTargetOperation(unpacked, documentXml, operation)
        else if (operation.type === "setDocumentProtection") applied = setDocumentProtectionOperation(documentXml, operation)
        else if (operation.type === "removeAllComments") applied = removeAllCommentsOperation(documentXml)
        else if (operation.type === "acceptAllTrackedChanges") applied = cleanTrackedChangesOperation(documentXml, "accept")
        else if (operation.type === "rejectAllTrackedChanges") applied = cleanTrackedChangesOperation(documentXml, "reject")
	        else if (operation.type === "scrubDocumentMetadata") applied = scrubDocumentMetadataOperation(documentXml)
	        else if (operation.type === "redactText") applied = redactTextOperation(documentXml, operation)
	        else if (operation.type === "patchOoxmlPart") applied = await patchOoxmlPartOperation(unpacked, documentXml, operation)
	        else if (operation.type === "insertSection") applied = await insertSectionOperation(unpacked, documentXml, operation)
	        else applied = applyOperation(documentXml, operation, listKindByNumId)
        if (operation.type === "replaceParagraphWithTrackedChange" || operation.type === "replaceParagraphWithRichTrackedChange" || operation.type === "replaceTextWithTrackedChange" || operation.type === "updateTableWithTrackedChange") {
          nextRevisionId += 2
          trackedRevisionUsed = true
        }
        if (operation.type === "removeAllComments") removeAllCommentsRequested = true
        if (operation.type === "acceptAllTrackedChanges") trackedChangeCleanMode = "accept"
        if (operation.type === "rejectAllTrackedChanges") trackedChangeCleanMode = "reject"
        if (operation.type === "setDocumentProtection") documentProtectionUpdate = { mode: operation.mode, enforce: operation.enforce }
        if (operation.type === "scrubDocumentMetadata") metadataScrubRequested = true
        if (operation.type === "redactText") {
          redactionRequests.push(operation)
          redactionOperationIndexes.push(appliedOperations.length)
        }
        documentXml = applied.documentXml
        appliedOperations.push({ type: operation.type, locator: operation.locator, detail: applied.detail })
      }
      documentXml = ensureDocumentFallbacks(documentXml)
      const tablePreservationCheckResult = checkTablePreservation(validation.plan.operations, input.inspection, documentXml)
      if (!tablePreservationCheckResult.ok) {
        throw new Error(`Edited DOCX failed table preservation validation: ${tablePreservationCheckResult.issues.filter((item) => item.severity === "error").map((item) => `${item.code}: ${item.message}`).join("; ")}`)
      }
      await writeFile(documentPath, documentXml)
      await ensurePackageFallbacks(unpacked)
      if (commentDrafts.length > 0) await ensureCommentPackageParts(unpacked, commentDrafts)
      if (commentTextUpdates.length > 0) await applyCommentTextUpdates(unpacked, commentTextUpdates)
      if (commentResolutionUpdates.length > 0) await applyCommentResolutionUpdates(unpacked, commentResolutionUpdates)
      if (trackedRevisionUsed) await ensureTrackedRevisionPackageParts(unpacked)
      if (documentProtectionUpdate) await applyDocumentProtectionUpdate(unpacked, documentProtectionUpdate)
      if (removeAllCommentsRequested) await stripAllCommentPackageParts(unpacked)
      if (trackedChangeCleanMode) await cleanTrackedChangePackageParts(unpacked, trackedChangeCleanMode)
      if (metadataScrubRequested) await scrubDocumentMetadataPackageParts(unpacked)
      if (redactionRequests.length) {
        const audit = await redactPackageParts(unpacked, redactionRequests)
        for (const index of redactionOperationIndexes) {
          const operation = appliedOperations[index]
          if (operation) operation.detail = `${operation.detail}; ${formatRedactionAudit(audit)}`
        }
      }
      let bytes: Uint8Array = await packDirectory(unpacked)
      let structureCheckResult = await new WordEditStructureGate().check(bytes)
      if (!structureCheckResult.ok) throw new Error(`Edited DOCX failed structural validation: ${structureCheckResult.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("; ")}`)
      await writeFile(candidate, bytes)
      let renderCheckResult = await renderWordDocument({
        docxPath: candidate,
        bytes,
        workspaceRoot: this.workspaceRoot,
        artifactNameBase: validation.plan.outputFilenameBase || validation.plan.outputTitle || path.basename(input.sourcePath, ".docx"),
        structureIssues: structureCheckResult.issues,
        timeoutMs: 60_000,
        signal: input.signal,
        log: input.log,
        remoteEndpoint: input.remoteEndpoint,
      })
      let repairAttempted = false
      if (repairableIssues([...structureCheckResult.issues, ...renderCheckResult.issues]).length > 0) {
        repairAttempted = true
        const repaired = await repairWordDocument(bytes, [...structureCheckResult.issues, ...renderCheckResult.issues])
        if (repaired.applied.length) {
          input.log?.(`[word-agent] repair applied: ${repaired.applied.join(", ")}`)
          bytes = repaired.bytes
          await writeFile(candidate, bytes)
          structureCheckResult = await new WordEditStructureGate().check(bytes)
          if (!structureCheckResult.ok) throw new Error(`Repaired DOCX failed structural validation: ${structureCheckResult.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("; ")}`)
          renderCheckResult = await renderWordDocument({
            docxPath: candidate,
            bytes,
            workspaceRoot: this.workspaceRoot,
            artifactNameBase: validation.plan.outputFilenameBase || validation.plan.outputTitle || path.basename(input.sourcePath, ".docx"),
            structureIssues: structureCheckResult.issues,
            timeoutMs: 60_000,
            signal: input.signal,
            log: input.log,
            remoteEndpoint: input.remoteEndpoint,
          })
        }
      }
      const stored = await new DocxFileStore(this.workspaceRoot).write({
        filename: validation.plan.outputFilenameBase || validation.plan.outputTitle || path.basename(input.sourcePath),
        bytes,
      })
      const warnings = [
        ...validation.warnings,
        ...structureCheckResult.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
        ...renderCheckResult.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      ]
      return {
        ...stored,
        bytes,
        appliedOperations,
        structureCheckResult,
        tablePreservationCheckResult,
        renderCheckResult,
        repairAttempted,
        warnings: unique(warnings),
        errors: [],
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export class WordEditStructureGate {
  async check(bytes: Uint8Array): Promise<WordEditStructureCheckResult> {
    const issues: QualityIssue[] = []
    let zip: Awaited<ReturnType<typeof loadDocxZip>>
    try {
      zip = await loadDocxZip(bytes)
    } catch (error) {
      return { ok: false, issues: [issue("error", "invalid-docx-zip", `DOCX is not a readable ZIP package: ${formatError(error)}`)] }
    }
    const documentXml = await zip.file("word/document.xml")?.async("string")
    const stylesXml = await zip.file("word/styles.xml")?.async("string")
    if (!zip.file("[Content_Types].xml")) issues.push(issue("error", "missing-content-types", "DOCX is missing [Content_Types].xml."))
    if (!zip.file("_rels/.rels")) issues.push(issue("error", "missing-package-relationships", "DOCX is missing _rels/.rels."))
    if (!documentXml) issues.push(issue("error", "missing-document-xml", "DOCX is missing word/document.xml."))
    if (!stylesXml) issues.push(issue("error", "missing-styles-xml", "DOCX is missing word/styles.xml."))
    if (documentXml && !documentXml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
      issues.push(issue("error", "missing-wordprocessing-namespace", "word/document.xml is missing WordprocessingML namespace."))
    }
    if (documentXml && strippedText(documentXml).length < 5) issues.push(issue("error", "empty-body", "Edited DOCX body is empty."))
    if (stylesXml) {
      for (const styleId of REQUIRED_STYLE_IDS) {
        if (!new RegExp(`w:styleId="${styleId}"`).test(stylesXml)) issues.push(issue("error", "missing-fallback-style", `DOCX is missing fallback style ${styleId}.`))
      }
    }
    if (!zip.file("word/header1.xml")) issues.push(issue("warning", "missing-header", "DOCX has no header; fallback header can be added by repair."))
    if (!zip.file("word/footer1.xml")) issues.push(issue("warning", "missing-footer", "DOCX has no footer; fallback footer can be added by repair."))
    if (documentXml && /目录占位|更新目录域|TOC_PLACEHOLDER/i.test(documentXml)) {
      issues.push(issue("warning", "toc-placeholder", "DOCX still contains a TOC placeholder."))
    }
    if (documentXml) issues.push(...tableWarnings(documentXml))
    return { ok: !issues.some((item) => item.severity === "error"), issues }
  }
}

async function repairWordDocument(bytes: Uint8Array, issues: QualityIssue[]) {
  const repairable = repairableIssues(issues)
  if (!repairable.length) return { bytes, applied: [] as string[] }
  const zip = await loadDocxZip(bytes)
  const documentXml = await zip.file("word/document.xml")?.async("string")
  let nextDocumentXml = documentXml ?? ""
  const applied: string[] = []
  if (repairable.some((item) => item.code === "toc-placeholder") && nextDocumentXml) {
    nextDocumentXml = nextDocumentXml.replace(/目录占位：打开 Word 后请更新目录域。|打开 Word 后请更新目录域。|TOC_PLACEHOLDER/gi, "目录（静态占位已清理）")
    applied.push("toc-placeholder")
  }
  if (repairable.some((item) => item.code === "table-overflow-risk") && nextDocumentXml) {
    nextDocumentXml = ensureFixedTables(nextDocumentXml)
    applied.push("table-width")
  }
  if (nextDocumentXml) zip.file("word/document.xml", nextDocumentXml)
  if (repairable.some((item) => item.code === "missing-header" || item.code === "missing-footer")) {
    zip.file("word/header1.xml", fallbackHeaderXml())
    zip.file("word/footer1.xml", fallbackFooterXml())
    zip.file("word/_rels/document.xml.rels", ensureDocumentRelationships(await zip.file("word/_rels/document.xml.rels")?.async("string")))
    zip.file("[Content_Types].xml", ensureContentTypes(await zip.file("[Content_Types].xml")?.async("string")))
    applied.push("header-footer")
  }
  zip.file("word/styles.xml", ensureStylesXml(await zip.file("word/styles.xml")?.async("string")))
  return { bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), applied: unique(applied) }
}

function applyOperation(documentXml: string, operation: DocumentEditOperation, listKindByNumId: Map<string, "bullet" | "numbered" | "checklist">) {
  if (operation.type === "replaceParagraph") return replaceParagraph(documentXml, operation)
  if (operation.type === "replaceText") return replaceText(documentXml, operation)
  if (operation.type === "updateHeadingLevel") return updateHeadingLevel(documentXml, operation)
  if (operation.type === "updateTable") return updateTable(documentXml, operation)
  if (operation.type === "replaceTable") return replaceTable(documentXml, operation)
  if (operation.type === "insertTableColumn") return insertTableColumn(documentXml, operation)
  if (operation.type === "updateTableHeaderRows") return updateTableHeaderRows(documentXml, operation)
  if (operation.type === "updateList") return updateList(documentXml, operation, listKindByNumId)
  if (operation.type === "updateSectionPageSetup") return updateSectionPageSetup(documentXml, operation)
  if (operation.type === "updateCaptionText") return updateCaptionText(documentXml, operation)
  if (operation.type === "updateHyperlinkText") return updateHyperlinkText(documentXml, operation)
  if (operation.type === "fillContentControl") return fillContentControl(documentXml, operation)
  if (operation.type === "setDocumentProtection") throw new Error("setDocumentProtection must be handled before generic applyOperation.")
	  if (operation.type === "addComment") throw new Error("addComment must be handled before generic applyOperation.")
	  if (operation.type === "replaceParagraphWithRichParagraph") throw new Error("replaceParagraphWithRichParagraph must be handled before generic applyOperation.")
	  if (operation.type === "replaceParagraphWithBlocks") throw new Error("replaceParagraphWithBlocks must be handled before generic applyOperation.")
	  if (operation.type === "replaceParagraphWithTrackedChange") throw new Error("replaceParagraphWithTrackedChange must be handled before generic applyOperation.")
  if (operation.type === "replaceParagraphWithRichTrackedChange") throw new Error("replaceParagraphWithRichTrackedChange must be handled before generic applyOperation.")
  if (operation.type === "replaceTextWithTrackedChange") throw new Error("replaceTextWithTrackedChange must be handled before generic applyOperation.")
  if (operation.type === "updateTableWithTrackedChange") throw new Error("updateTableWithTrackedChange must be handled before generic applyOperation.")
  if (operation.type === "updateCommentText") throw new Error("updateCommentText must be handled before generic applyOperation.")
  if (operation.type === "setCommentResolved") throw new Error("setCommentResolved must be handled before generic applyOperation.")
  if (operation.type === "addTextWatermark") throw new Error("addTextWatermark must be handled before generic applyOperation.")
  if (operation.type === "removeWatermark") throw new Error("removeWatermark must be handled before generic applyOperation.")
  if (operation.type === "replaceImage") throw new Error("replaceImage must be handled before generic applyOperation.")
  if (operation.type === "updateImageAltText") throw new Error("updateImageAltText must be handled before generic applyOperation.")
  if (operation.type === "updateNoteText") throw new Error("updateNoteText must be handled before generic applyOperation.")
  if (operation.type === "updateHyperlinkTarget") throw new Error("updateHyperlinkTarget must be handled before generic applyOperation.")
  if (operation.type === "removeAllComments") throw new Error("removeAllComments must be handled before generic applyOperation.")
  if (operation.type === "acceptAllTrackedChanges") throw new Error("acceptAllTrackedChanges must be handled before generic applyOperation.")
  if (operation.type === "rejectAllTrackedChanges") throw new Error("rejectAllTrackedChanges must be handled before generic applyOperation.")
	  if (operation.type === "scrubDocumentMetadata") throw new Error("scrubDocumentMetadata must be handled before generic applyOperation.")
	  if (operation.type === "redactText") throw new Error("redactText must be handled before generic applyOperation.")
	  if (operation.type === "patchOoxmlPart") throw new Error("patchOoxmlPart must be handled before generic applyOperation.")
	  if (operation.type === "insertSection") throw new Error("insertSection must be handled before generic applyOperation.")
	  throw new Error(`Unsupported document edit operation: ${(operation as { type?: string }).type}`)
	}

function addCommentOperation(documentXml: string, operation: Extract<DocumentEditOperation, { type: "addComment" }>, comments: CommentDraft[], id: number) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`addComment locator not found: ${operation.locator.blockId}`)
  comments.push({
    id,
    text: operation.text,
    author: operation.author?.trim() || "ChipMate",
    initials: operation.initials?.trim() || "CM",
    date: new Date().toISOString(),
  })
  const commented = [
    `<w:commentRangeStart w:id="${id}"/>`,
    target.xml,
    `<w:commentRangeEnd w:id="${id}"/>`,
    `<w:p><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`,
  ].join("")
  return {
    documentXml: documentXml.replace(target.xml, commented),
    detail: `added comment ${id} to paragraph ${target.blockId}`,
  }
}

function setCommentResolvedOperation(documentXml: string, operation: Extract<DocumentEditOperation, { type: "setCommentResolved" }>, updates: CommentResolutionUpdate[]) {
  const commentId = operation.locator.commentId
  if (!commentId) throw new Error("setCommentResolved requires a comment locator with commentId.")
  updates.push({ commentId, resolved: operation.resolved })
  return {
    documentXml,
    detail: `${operation.resolved ? "resolved" : "reopened"} comment ${commentId}`,
  }
}

function updateCommentTextOperation(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateCommentText" }>, updates: CommentTextUpdate[]) {
  const commentId = operation.locator.commentId
  if (!commentId) throw new Error("updateCommentText requires a comment locator with commentId.")
  updates.push({ commentId, text: operation.text })
  return {
    documentXml,
    detail: `updated comment ${commentId} text`,
  }
}

function removeAllCommentsOperation(documentXml: string) {
  return {
    documentXml: stripCommentMarkup(documentXml),
    detail: "removed all Word comments",
  }
}

function cleanTrackedChangesOperation(documentXml: string, mode: "accept" | "reject") {
  const unsupported = unsupportedTrackedFormattingRevisionTypes(documentXml)
  if (unsupported.length) {
    throw new Error(`${mode === "accept" ? "acceptAllTrackedChanges" : "rejectAllTrackedChanges"} cannot safely clean tracked formatting revisions: ${unsupported.join(", ")}.`)
  }
  return {
    documentXml: applyTrackedChangesXml(documentXml, mode),
    detail: `${mode === "accept" ? "accepted" : "rejected"} all tracked changes`,
  }
}

function scrubDocumentMetadataOperation(documentXml: string) {
  return {
    documentXml: stripRsidAttributes(documentXml),
    detail: "scrubbed document metadata",
  }
}

function redactTextOperation(documentXml: string, operation: Extract<DocumentEditOperation, { type: "redactText" }>) {
  const exactCount = operation.items?.length ?? 0
  const patternCount = operation.patterns?.length ?? 0
  return {
    documentXml,
    detail: `queued redaction for ${exactCount} exact text item(s) and ${patternCount} pattern(s)`,
  }
}

function setDocumentProtectionOperation(documentXml: string, operation: Extract<DocumentEditOperation, { type: "setDocumentProtection" }>) {
  return {
    documentXml,
    detail: operation.mode === "off" ? "cleared document protection" : `set document protection to ${operation.mode}`,
  }
}

async function patchOoxmlPartOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "patchOoxmlPart" }>) {
  const part = normalizeOoxmlPackagePart(operation.part)
  if (!part) throw new Error(`patchOoxmlPart part is not allowed: ${operation.part}`)
  const rootPath = path.resolve(root)
  const targetPath = path.resolve(root, ...part.split("/"))
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`patchOoxmlPart resolved outside DOCX package: ${operation.part}`)
  }
  const isDocument = part === "word/document.xml"
  let xml = isDocument ? documentXml : await readTextIfExists(targetPath)
  if (!xml) {
    if (!operation.createIfMissing || !operation.initialXml) throw new Error(`patchOoxmlPart target part does not exist: ${part}`)
    const safetyErrors = validateOoxmlXmlSafety(part, operation.initialXml, `patchOoxmlPart(${part}).initialXml`)
    if (safetyErrors.length) throw new Error(safetyErrors.join("; "))
    xml = operation.initialXml
  }
  const patched = applyOoxmlPartPatches(part, xml, operation.patches)
  if (!isDocument) {
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, patched.xml)
  }
  return {
    documentXml: isDocument ? patched.xml : documentXml,
    detail: `patched ${part} with ${operation.patches.length} OOXML patch(es); ${patched.details.join(", ")}; byteDelta=${patched.byteDelta}; reason=${operation.reason.slice(0, 160)}`,
  }
}

async function addTextWatermarkOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "addTextWatermark" }>) {
  const wordDir = path.join(root, "word")
  await mkdir(wordDir, { recursive: true })
  const headerPaths = (await listFiles(wordDir).catch(() => [] as string[]))
    .filter((file) => /\/word\/header\d+\.xml$/.test(file.replace(/\\/g, "/")))
    .sort((left, right) => watermarkPartSortKey(left).localeCompare(watermarkPartSortKey(right)))
  const targetPaths = headerPaths.length ? headerPaths : [path.join(wordDir, "header1.xml")]
  const touchedParts: string[] = []
  for (const headerPath of targetPaths) {
    const headerXml = await readTextIfExists(headerPath) || fallbackHeaderXml()
    await writeFile(headerPath, headerXml.replace("</w:hdr>", `${watermarkParagraphXml(operation.text)}</w:hdr>`))
    touchedParts.push(wordPartPath(headerPath))
  }
  return {
    documentXml,
    detail: `added text watermark to ${touchedParts.length} header part(s): ${touchedParts.join(", ")}; text="${operation.text.slice(0, 80)}"`,
  }
}

async function removeWatermarkOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "removeWatermark" }>) {
  const wordDir = path.join(root, "word")
  const files = (await listFiles(wordDir))
    .filter((file) => /\/word\/(?:document|header\d+|footer\d+)\.xml$/.test(file))
    .sort((left, right) => watermarkPartSortKey(left).localeCompare(watermarkPartSortKey(right)))
  let watermarkIndex = 0
  let removedCount = 0
  let nextDocumentXml = documentXml
  const touchedParts = new Set<string>()
  for (const file of files) {
    const part = wordPartPath(file)
    const xml = part === "word/document.xml" ? nextDocumentXml : await readTextIfExists(file)
    const rewritten = removeWatermarkCandidates(xml, part, (candidate) => {
      watermarkIndex += 1
      const matches = operation.locator.watermarkIndex
        ? watermarkIndex === operation.locator.watermarkIndex
        : operation.locator.watermarkText ? candidate.text === operation.locator.watermarkText : false
      if (!matches) return false
      removedCount += 1
      touchedParts.add(part)
      return true
    })
    if (rewritten !== xml) {
      if (part === "word/document.xml") nextDocumentXml = rewritten
      else await writeFile(file, rewritten)
    }
  }
  if (removedCount === 0) throw new Error(`removeWatermark locator not found: ${operation.locator.blockId ?? operation.locator.watermarkIndex ?? operation.locator.watermarkText}`)
  return {
    documentXml: nextDocumentXml,
    detail: `removed ${removedCount} watermark(s) from ${touchedParts.size} part(s): ${[...touchedParts].join(", ")}; locator=${operation.locator.watermarkText || operation.locator.watermarkIndex || operation.locator.blockId}`,
  }
}

async function updateImageAltTextOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateImageAltText" }>) {
  const wordDir = path.join(root, "word")
  const files = (await listFiles(wordDir))
    .filter((file) => /\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file))
    .sort((left, right) => imageStoryPartSortKey(left).localeCompare(imageStoryPartSortKey(right)))
  let imageIndex = 0
  let found = false
  let nextDocumentXml = documentXml
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/")
    const isDocument = /\/word\/document\.xml$/.test(normalized)
    const xml = isDocument ? nextDocumentXml : await readTextIfExists(file)
    const nextXml = xml.replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, (drawingXml) => {
      imageIndex += 1
      if (found || !imageLocatorMatches(operation.locator, drawingXml, imageIndex)) return drawingXml
      const updated = replaceDrawingDocPrAltText(drawingXml, operation.altText, operation.title)
      found = true
      return updated
    })
    if (nextXml !== xml) {
      if (isDocument) nextDocumentXml = nextXml
      else await writeFile(file, nextXml)
    }
  }
  if (!found) throw new Error(`updateImageAltText locator not found: ${operation.locator.blockId ?? operation.locator.imageIndex ?? operation.locator.imageRelId}`)
  return {
    documentXml: nextDocumentXml,
    detail: `updated image alt text ${operation.locator.blockId ?? operation.locator.imageIndex ?? operation.locator.imageRelId}`,
  }
}

async function replaceImageOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceImage" }>) {
  const wordDir = path.join(root, "word")
  const files = (await listFiles(wordDir))
    .filter((file) => /\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file))
    .sort((left, right) => imageStoryPartSortKey(left).localeCompare(imageStoryPartSortKey(right)))
  const bytes = figureBytes(operation.figure)
  const size = figureSizeEmuFromPixels(operation.figure.image.width, operation.figure.image.height)
  let imageIndex = 0
  let found: { relId: string; part: string; target: string; mediaPath: string } | undefined
  let nextDocumentXml = documentXml
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/")
    const isDocument = /\/word\/document\.xml$/.test(normalized)
    const packagePart = path.relative(root, file).replace(/\\/g, "/")
    const xml = isDocument ? nextDocumentXml : await readTextIfExists(file)
    const nextXml = xml.replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, (drawingXml) => {
      imageIndex += 1
      if (found || !imageLocatorMatches(operation.locator, drawingXml, imageIndex)) return drawingXml
      const relId = drawingXml.match(/\br:(?:embed|link)="([^"]*)"/)?.[1]
      if (!relId) throw new Error("replaceImage requires a drawing with an embedded local image relationship.")
      const target = imageRelationshipTarget(root, packagePart, relId)
      const mediaPath = resolvePackageRelationshipTarget(packagePart, target)
      if (!mediaPath || !/\.png$/i.test(mediaPath)) throw new Error("replaceImage currently supports local PNG image relationships only.")
      found = { relId, part: packagePart, target, mediaPath }
      return updateDrawingForReplacement(drawingXml, operation.figure, size)
    })
    if (nextXml !== xml) {
      if (isDocument) nextDocumentXml = nextXml
      else await writeFile(file, nextXml)
    }
  }
  if (!found) throw new Error(`replaceImage locator not found: ${operation.locator.blockId ?? operation.locator.imageIndex ?? operation.locator.imageRelId}`)
  await mkdir(path.dirname(path.join(root, found.mediaPath)), { recursive: true })
  await writeFile(path.join(root, found.mediaPath), bytes)
  await writeFile(path.join(root, "[Content_Types].xml"), ensurePngContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  return {
    documentXml: nextDocumentXml,
    detail: `replaced image ${operation.locator.blockId ?? operation.locator.imageIndex ?? operation.locator.imageRelId} at ${found.mediaPath}`,
  }
}

function imageLocatorMatches(locator: WordDocumentLocator, drawingXml: string, imageIndex: number) {
  if (locator.imageIndex && locator.imageIndex !== imageIndex) return false
  const relId = drawingXml.match(/\br:(?:embed|link)="([^"]*)"/)?.[1]
  if (locator.imageRelId && relId !== locator.imageRelId) return false
  if (locator.blockId && locator.blockId !== `image-${imageIndex}`) return false
  return true
}

function updateDrawingForReplacement(drawingXml: string, figure: FigureSpec, size: { cx: number; cy: number }) {
  let next = replaceDrawingDocPrAltText(drawingXml, figure.altText || figure.caption || figure.title, figure.title)
  next = replaceDrawingPictureName(next, figure.title)
  next = replaceDrawingExtent(next, "wp:extent", size)
  next = replaceDrawingExtent(next, "a:ext", size)
  return next
}

function replaceDrawingDocPrAltText(drawingXml: string, altText: string, title: string | undefined) {
  const docPr = drawingXml.match(/<wp:docPr\b[^>]*\/?>/)?.[0]
  if (!docPr) throw new Error("updateImageAltText requires a wp:docPr element in the target drawing.")
  const nextDocPr = setXmlTagAttribute(setXmlTagAttribute(setXmlTagAttribute(docPr, "descr", altText), "title", title?.trim() || altText), "name", title?.trim() || altText)
  return drawingXml.replace(docPr, nextDocPr)
}

function replaceDrawingPictureName(drawingXml: string, name: string) {
  const picPr = drawingXml.match(/<pic:cNvPr\b[^>]*\/?>/)?.[0]
  if (!picPr) return drawingXml
  return drawingXml.replace(picPr, setXmlTagAttribute(picPr, "name", name))
}

function replaceDrawingExtent(drawingXml: string, tagName: "wp:extent" | "a:ext", size: { cx: number; cy: number }) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*\\/?>`)
  const tag = drawingXml.match(pattern)?.[0]
  if (!tag) return drawingXml
  return drawingXml.replace(tag, setXmlTagAttribute(setXmlTagAttribute(tag, "cx", String(size.cx)), "cy", String(size.cy)))
}

function imageRelationshipTarget(root: string, packagePart: string, relId: string) {
  const relsPath = path.join(root, relationshipPartNameForPackagePart(packagePart))
  const relsXml = readFileSyncText(relsPath)
  const relationship = relationshipXmlById(relsXml, relId)
  if (!relationship) throw new Error(`replaceImage relationship not found: ${relId}`)
  if (/TargetMode="External"/.test(relationship)) throw new Error("replaceImage cannot replace external linked images.")
  const target = relationship.match(/\bTarget="([^"]*)"/)?.[1]
  if (!target) throw new Error(`replaceImage relationship ${relId} has no Target.`)
  return decodeXmlText(target)
}

function relationshipXmlById(relsXml: string, relId: string) {
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const xml = match[0]
    if (xml.match(/\bId="([^"]*)"/)?.[1] === relId) return xml
  }
  return undefined
}

function relationshipPartNameForPackagePart(packagePart: string) {
  const slash = packagePart.lastIndexOf("/")
  if (slash < 0) return `_rels/${packagePart}.rels`
  const dir = packagePart.slice(0, slash + 1)
  const filename = packagePart.slice(slash + 1)
  return `${dir}_rels/${filename}.rels`
}

function resolvePackageRelationshipTarget(packagePart: string, target: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined
  const raw = target.startsWith("/") ? target.slice(1) : `${packagePart.slice(0, packagePart.lastIndexOf("/") + 1)}${target}`
  return normalizePackagePath(raw)
}

function normalizePackagePath(input: string) {
  const parts: string[] = []
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join("/")
}

function figureSizeEmuFromPixels(width: number, height: number) {
  const emusPerPixel = 9525
  const maxCx = 9000 * 635
  const rawCx = Math.max(1, positivePixelDimension(width)) * emusPerPixel
  const rawCy = Math.max(1, positivePixelDimension(height)) * emusPerPixel
  const scale = Math.min(1, maxCx / rawCx)
  return {
    cx: Math.max(1, Math.round(rawCx * scale)),
    cy: Math.max(1, Math.round(rawCy * scale)),
  }
}

function readFileSyncText(file: string) {
  return nodeRequire("node:fs").readFileSync(file, "utf8") as string
}

function setXmlTagAttribute(tag: string, name: string, value: string) {
  const escaped = xmlAttr(value)
  const pattern = new RegExp(`\\b${name}="[^"]*"`)
  if (pattern.test(tag)) return tag.replace(pattern, `${name}="${escaped}"`)
  return tag.replace(/\/?>$/, (suffix) => ` ${name}="${escaped}"${suffix}`)
}

function imageStoryPartSortKey(file: string) {
  const normalized = file.replace(/\\/g, "/")
  const part = normalized.match(/word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/)?.[0] ?? normalized
  if (part === "word/document.xml") return "0:word/document.xml"
  if (/^word\/header\d+\.xml$/.test(part)) return `1:${part}`
  if (/^word\/footer\d+\.xml$/.test(part)) return `2:${part}`
  if (part === "word/footnotes.xml") return "3:word/footnotes.xml"
  if (part === "word/endnotes.xml") return "4:word/endnotes.xml"
  return `9:${part}`
}

async function updateNoteTextOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateNoteText" }>) {
  const kind = operation.locator.noteKind
  const noteId = operation.locator.noteId
  if (!kind || !noteId) throw new Error("updateNoteText requires a note locator with noteKind and noteId.")
  const partName = kind === "endnote" ? "endnotes.xml" : "footnotes.xml"
  const partPath = path.join(root, "word", partName)
  const xml = await readTextIfExists(partPath)
  if (!xml) throw new Error(`updateNoteText requires word/${partName}.`)
  const tag = kind === "endnote" ? "endnote" : "footnote"
  let found = false
  const pattern = new RegExp(`<w:${tag}\\b[\\s\\S]*?<\\/w:${tag}>`, "g")
  const nextXml = xml.replace(pattern, (noteXml) => {
    const currentId = noteXml.match(/\bw:id="([^"]*)"/)?.[1]
    if (found || currentId !== noteId) return noteXml
    found = true
    return rewriteNoteText(noteXml, kind, operation.text)
  })
  if (!found) throw new Error(`updateNoteText locator not found: ${kind} ${noteId}`)
  await writeFile(partPath, nextXml)
  return {
    documentXml,
    detail: `updated ${kind} ${noteId}`,
  }
}

function rewriteNoteText(noteXml: string, kind: "footnote" | "endnote", text: string) {
  const paragraphs = noteXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []
  const nextParagraphs = noteParagraphsXml(paragraphs[0], kind, text)
  if (paragraphs.length) {
    let nextXml = noteXml
    for (const paragraph of paragraphs) nextXml = nextXml.replace(paragraph, "")
    const closeTag = kind === "endnote" ? "</w:endnote>" : "</w:footnote>"
    return nextXml.replace(closeTag, `${nextParagraphs}${closeTag}`)
  }
  const closeTag = kind === "endnote" ? "</w:endnote>" : "</w:footnote>"
  return noteXml.replace(closeTag, `${nextParagraphs}${closeTag}`)
}

function noteParagraphsXml(existingParagraph: string | undefined, kind: "footnote" | "endnote", text: string) {
  return noteTextParagraphs(text).map((paragraphText, index) => noteParagraphXml(existingParagraph, kind, paragraphText, index === 0)).join("")
}

function noteParagraphXml(existingParagraph: string | undefined, kind: "footnote" | "endnote", text: string, includeReference: boolean) {
  const refTag = kind === "endnote" ? "endnoteRef" : "footnoteRef"
  const styleId = kind === "endnote" ? "EndnoteText" : "FootnoteText"
  const pPr = existingParagraph?.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? `<w:pPr><w:pStyle w:val="${styleId}"/><w:spacing w:before="0" w:after="0"/></w:pPr>`
  const refRun = includeReference ? existingParagraph?.match(new RegExp(`<w:r\\b[\\s\\S]*?<w:${refTag}\\s*\\/>[\\s\\S]*?<\\/w:r>`))?.[0]
    ?? `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${refTag}/></w:r>`
    : ""
  const textRun = existingParagraph?.match(/<w:r\b[\s\S]*?<w:t\b[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/)?.[0]
  const rPr = textRun?.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return `<w:p>${pPr}${refRun}<w:r>${rPr}${textRuns(`${includeReference ? " " : ""}${text}`)}</w:r></w:p>`
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

function nextCommentIdFromXml(xml: string) {
  let max = -1
  for (const match of xml.matchAll(/<w:comment\b[^>]*\bw:id="(\d+)"/g)) {
    max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function nextRevisionIdFromXml(xml: string) {
  let max = -1
  for (const match of xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:id="(\d+)"/g)) {
    max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function replaceParagraph(documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceParagraph" }>) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceParagraph locator not found: ${operation.locator.blockId}`)
  const nextParagraph = rewriteParagraphText(target.xml, operation.text)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `replaced paragraph ${target.blockId}`,
  }
}

async function replaceParagraphWithRichParagraph(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceParagraphWithRichParagraph" }>) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceParagraphWithRichParagraph locator not found: ${operation.locator.blockId}`)
  const context = await richParagraphEditContext(root, [operation.paragraph], new Map())
  const fallbackStyleId = paragraphStyleId(target.xml) ?? "Normal"
  const nextParagraph = richParagraphXml(operation.paragraph, context, fallbackStyleId)
  if (!nextParagraph) throw new Error(`replaceParagraphWithRichParagraph produced an empty paragraph for ${target.blockId}.`)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `replaced paragraph ${target.blockId} with rich paragraph`,
  }
}

async function replaceParagraphWithBlocks(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceParagraphWithBlocks" }>) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceParagraphWithBlocks locator not found: ${operation.locator.blockId}`)
  const renderContext = await renderContextForInsertBlocks(root, documentXml, operation.blocks)
  const rows = operation.blocks.flatMap((block) => insertSectionBlockXml(block, renderContext)).filter(Boolean)
  const xml = rows.join("")
  if (!xml) throw new Error(`replaceParagraphWithBlocks produced no replacement blocks for ${target.blockId}.`)
  return {
    documentXml: documentXml.replace(target.xml, xml),
    detail: `replaced paragraph ${target.blockId} with ${rows.length} block(s)`,
  }
}

function replaceText(documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceText" }>) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceText locator not found: ${operation.locator.blockId}`)
  const visibleText = xmlTextFrom(target.xml)
  if (!visibleText.includes(operation.oldText)) throw new Error(`replaceText oldText was not found in paragraph ${target.blockId}.`)
  const replacedInRun = replaceTextInParagraphTextNodes(target.xml, operation.oldText, operation.newText)
  const nextParagraph = replacedInRun
    ?? rewriteParagraphText(target.xml, visibleText.replace(operation.oldText, operation.newText))
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `replaced text in paragraph ${target.blockId}`,
  }
}

function trackedReplaceParagraph(documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceParagraphWithTrackedChange" }>, revisionId: number) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceParagraphWithTrackedChange locator not found: ${operation.locator.blockId}`)
  const nextParagraph = trackedParagraphReplacementXml(target.xml, xmlTextFrom(target.xml), operation.text, operation.author, revisionId)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `tracked replacement for paragraph ${target.blockId}`,
  }
}

async function trackedReplaceParagraphWithRichParagraph(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceParagraphWithRichTrackedChange" }>, revisionId: number) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceParagraphWithRichTrackedChange locator not found: ${operation.locator.blockId}`)
  const context = await richParagraphEditContext(root, [operation.paragraph], new Map())
  const nextParagraph = trackedRichParagraphReplacementXml(target.xml, operation.paragraph, context, operation.author, revisionId)
  if (!nextParagraph) throw new Error(`replaceParagraphWithRichTrackedChange produced an empty paragraph for ${target.blockId}.`)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `tracked rich replacement for paragraph ${target.blockId}`,
  }
}

function trackedReplaceText(documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceTextWithTrackedChange" }>, revisionId: number) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`replaceTextWithTrackedChange locator not found: ${operation.locator.blockId}`)
  const visibleText = xmlTextFrom(target.xml)
  if (!visibleText.includes(operation.oldText)) throw new Error(`replaceTextWithTrackedChange oldText was not found in paragraph ${target.blockId}.`)
  const nextParagraph = trackedParagraphTextReplacementXml(target.xml, operation.oldText, operation.newText, operation.author, revisionId)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `tracked text replacement for paragraph ${target.blockId}`,
  }
}

function trackedUpdateTableCell(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateTableWithTrackedChange" }>, revisionId: number) {
  const elements = parseTopLevelElements(documentXml)
  const tableIndex = operation.locator.tableIndex
  const target = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)
  if (!target) throw new Error(`updateTableWithTrackedChange locator not found: table ${tableIndex}`)
  const rowIndex = operation.locator.rowIndex ?? 0
  const cellIndex = operation.locator.cellIndex ?? 0
  const tableXml = replaceTableCellTextWithTrackedChange(target.xml, rowIndex, cellIndex, operation.text, operation.author, revisionId)
  return {
    documentXml: documentXml.replace(target.xml, tableXml),
    detail: `tracked table cell replacement for table ${tableIndex} cell ${rowIndex}:${cellIndex}`,
  }
}

function updateHeadingLevel(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateHeadingLevel" }>) {
  const elements = parseTopLevelElements(documentXml)
  const target = elements.find((element) => element.kind === "paragraph" && locatorMatches(operation.locator, element.blockId))
  if (!target) throw new Error(`updateHeadingLevel locator not found: ${operation.locator.blockId}`)
  const nextParagraph = setParagraphStyle(target.xml, `Heading${operation.level}`)
  return {
    documentXml: documentXml.replace(target.xml, nextParagraph),
    detail: `updated heading level for paragraph ${target.blockId} to ${operation.level}`,
  }
}

async function insertSectionOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "insertSection" }>) {
  const lists = insertSectionLists(operation)
  const figures = insertSectionFigures(operation)
  const richParagraphs = insertSectionRichParagraphs(operation)
  const numberingIds = lists.length ? await ensureInsertListNumberingPackageParts(root) : undefined
  const insertedFigures = figures.length ? await insertFigurePackageParts(root, documentXml, figures) : []
  const renderContext = await richParagraphEditContext(root, richParagraphs, new Map(insertedFigures.map((item) => [item.figure, item])), numberingIds)
  const bodyBlocks = operation.blocks?.length
    ? operation.blocks.flatMap((block) => insertSectionBlockXml(block, renderContext))
    : legacyInsertSectionBlocks(operation, renderContext)
  const xml = [
    paragraphXml(operation.title, `Heading${operation.level ?? 1}`),
    ...bodyBlocks,
  ].join("")
  if (operation.locator.kind === "paragraph" && operation.locator.blockId) {
    const elements = parseTopLevelElements(documentXml)
    const target = elements.find((element) => locatorMatches(operation.locator, element.blockId))
    if (target) return { documentXml: documentXml.replace(target.xml, `${target.xml}${xml}`), detail: `inserted section after ${target.blockId}` }
  }
  const sectPr = documentXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0]
	  if (sectPr) return { documentXml: documentXml.replace(sectPr, `${xml}${sectPr}`), detail: "inserted section before sectPr" }
	  return { documentXml: documentXml.replace("</w:body>", `${xml}</w:body>`), detail: "inserted section at document end" }
	}

async function renderContextForInsertBlocks(root: string, documentXml: string, blocks: InsertSectionBlockSpec[]) {
  const lists = blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "list" }> => block.type === "list").map((block) => block.list)
  const figures = blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "figure" }> => block.type === "figure").map((block) => block.figure)
  const richParagraphs = blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "richParagraph" }> => block.type === "richParagraph").map((block) => block.paragraph)
  const numberingIds = lists.length ? await ensureInsertListNumberingPackageParts(root) : undefined
  const insertedFigures = figures.length ? await insertFigurePackageParts(root, documentXml, figures) : []
  return richParagraphEditContext(root, richParagraphs, new Map(insertedFigures.map((item) => [item.figure, item])), numberingIds)
}

function insertSectionLists(operation: Extract<DocumentEditOperation, { type: "insertSection" }>) {
  if (operation.blocks?.length) return operation.blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "list" }> => block.type === "list").map((block) => block.list)
  return operation.lists ?? []
}

function insertSectionFigures(operation: Extract<DocumentEditOperation, { type: "insertSection" }>) {
  if (operation.blocks?.length) return operation.blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "figure" }> => block.type === "figure").map((block) => block.figure)
  return operation.figures ?? []
}

function insertSectionRichParagraphs(operation: Extract<DocumentEditOperation, { type: "insertSection" }>) {
  if (operation.blocks?.length) return operation.blocks.filter((block): block is Extract<InsertSectionBlockSpec, { type: "richParagraph" }> => block.type === "richParagraph").map((block) => block.paragraph)
  return operation.richParagraphs ?? []
}

function legacyInsertSectionBlocks(operation: Extract<DocumentEditOperation, { type: "insertSection" }>, context: InsertSectionRenderContext) {
  return [
    ...(operation.paragraphs ?? []).map((text) => paragraphXml(text, "Normal")),
    ...(operation.richParagraphs ?? []).map((paragraph) => richParagraphXml(paragraph, context)),
    ...(operation.lists ?? []).flatMap((list) => listXml(list, context.numberingIds)),
    ...(operation.figures ?? []).flatMap((figure) => figureXmlForSpec(figure, context)),
    ...(operation.tables ?? []).map(tableXml),
    ...(operation.callouts ?? []).map(calloutXml),
    ...(operation.briefCards?.length ? [briefCardsXml({ cards: operation.briefCards })] : []),
    ...(operation.evidenceCards?.length ? [evidenceCardsXml({ cards: operation.evidenceCards })] : []),
    ...(operation.quoteBlocks ?? []).flatMap(quoteBlockXml),
    ...(operation.codeBlocks ?? []).map(codeBlockXml),
  ].filter(Boolean)
}

function insertSectionBlockXml(block: InsertSectionBlockSpec, context: InsertSectionRenderContext): string[] {
  if (block.type === "paragraph") return [paragraphXml(block.text, "Normal")]
  if (block.type === "richParagraph") return [richParagraphXml(block.paragraph, context)].filter(Boolean)
  if (block.type === "list") return listXml(block.list, context.numberingIds)
  if (block.type === "figure") return figureXmlForSpec(block.figure, context)
  if (block.type === "table") return [tableXml(block.table)]
  if (block.type === "callout") return [calloutXml(block.callout)]
  if (block.type === "briefCards") return [briefCardsXml(block.briefCards)]
  if (block.type === "evidenceCards") return [evidenceCardsXml(block.evidenceCards)]
  if (block.type === "quoteBlock") return quoteBlockXml(block.quoteBlock)
  if (block.type === "codeBlock") return [codeBlockXml(block.codeBlock)]
  return []
}

function listXml(spec: WordListSpec, ids: InsertListNumberingIds | undefined) {
  if (!ids) throw new Error("insertSection lists require numbering package setup.")
  const rows: string[] = []
  if (spec.title?.trim()) rows.push(paragraphXml(spec.title, "Caption"))
  for (const item of flattenListItems(spec.items ?? [])) {
    rows.push(listParagraphXml(item.text, listNumId(spec.kind, item, ids), item.level))
  }
  return rows
}

function figureXmlForSpec(spec: FigureSpec, context: InsertSectionRenderContext) {
  const item = context.figureBySpec.get(spec)
  if (!item) throw new Error(`insertSection figure "${spec.title}" was not prepared.`)
  return figureXml(item)
}

async function richParagraphEditContext(root: string, paragraphs: ParagraphSpec[], figureBySpec: Map<FigureSpec, InsertedFigureBuildItem>, numberingIds?: InsertListNumberingIds): Promise<InsertSectionRenderContext> {
  const runs = paragraphs.flatMap((paragraph) => paragraph.runs ?? [])
  return {
    numberingIds,
    figureBySpec,
    hyperlinkRelIds: await insertHyperlinkRelationships(root, runs),
    noteMap: await insertNotePackageParts(root, runs),
  }
}

async function insertHyperlinkRelationships(root: string, runs: ParagraphRunSpec[]) {
  const linkRuns = runs.filter((run) => run.hyperlink?.url?.trim())
  const relIds = new Map<ParagraphRunSpec, string>()
  if (!linkRuns.length) return relIds
  const relsDir = path.join(root, "word", "_rels")
  await mkdir(relsDir, { recursive: true })
  const relsPath = path.join(relsDir, "document.xml.rels")
  let relsXml = ensureDocumentRelationships(await readTextIfExists(relsPath))
  for (const run of linkRuns) {
    const target = run.hyperlink?.url?.trim()
    if (!target) continue
    const relId = nextRelationshipId(relsXml, "rIdChipMateHyperlink")
    relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${xmlAttr(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlAttr(target)}" TargetMode="External"/></Relationships>`)
    relIds.set(run, relId)
  }
  await writeFile(relsPath, relsXml)
  return relIds
}

async function insertNotePackageParts(root: string, runs: ParagraphRunSpec[]) {
  const noteRuns = runs.filter((run) => run.note?.text?.trim())
  const noteMap = new Map<ParagraphRunSpec, InsertedNoteBuildItem>()
  if (!noteRuns.length) return noteMap
  const wordDir = path.join(root, "word")
  const relsDir = path.join(wordDir, "_rels")
  await mkdir(wordDir, { recursive: true })
  await mkdir(relsDir, { recursive: true })
  let contentTypesXml = await readTextIfExists(path.join(root, "[Content_Types].xml"))
  let relsXml = await readTextIfExists(path.join(relsDir, "document.xml.rels"))
  for (const kind of ["footnote", "endnote"] as const) {
    const kindRuns = noteRuns.filter((run) => (run.note?.kind === "endnote" ? "endnote" : "footnote") === kind)
    if (!kindRuns.length) continue
    const partPath = path.join(wordDir, kind === "endnote" ? "endnotes.xml" : "footnotes.xml")
    const currentXml = ensureNotesXml(await readTextIfExists(partPath), kind)
    await writeFile(partPath, appendNoteItemsXml(currentXml, kind, kindRuns, noteMap))
    contentTypesXml = ensureNotesContentType(contentTypesXml, kind)
    relsXml = ensureNotesRelationship(relsXml, kind)
  }
  await writeFile(path.join(root, "[Content_Types].xml"), contentTypesXml)
  await writeFile(path.join(relsDir, "document.xml.rels"), relsXml)
  return noteMap
}

function flattenListItems(items: WordListItemSpec[], parentLevel: 0 | 1 | 2 = 0): Array<{ text: string; level: 0 | 1 | 2; checked?: boolean }> {
  const rows: Array<{ text: string; level: 0 | 1 | 2; checked?: boolean }> = []
  for (const item of items) {
    const level = normalizeInsertedListLevel(item.level, parentLevel)
    const text = typeof item.text === "string" ? item.text.trim() : ""
    if (text) rows.push({ text, level, checked: item.checked })
    if (Array.isArray(item.children) && item.children.length) {
      rows.push(...flattenListItems(item.children, normalizeInsertedListLevel(undefined, level + 1)))
    }
  }
  return rows
}

function normalizeInsertedListLevel(value: unknown, fallback: number): 0 | 1 | 2 {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.min(2, Math.trunc(numeric))) as 0 | 1 | 2
}

function listNumId(kind: WordListSpec["kind"], item: { checked?: boolean }, ids: InsertListNumberingIds) {
  if (kind === "numbered") return ids.numbered
  if (kind === "checklist") return item.checked ? ids.checklistChecked : ids.checklistUnchecked
  return ids.bullet
}

function listParagraphXml(text: string, numId: number, level: 0 | 1 | 2 = 0) {
  if (!text.trim()) return ""
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="ListParagraph"/>',
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`,
    "</w:pPr>",
    `<w:r>${textRuns(text)}</w:r>`,
    "</w:p>",
  ].join("")
}

function richParagraphXml(spec: ParagraphSpec, context: InsertSectionRenderContext, defaultStyleId = "Normal") {
  const runs = (spec.runs ?? []).map((run) => richRunXml(run, context)).filter(Boolean).join("")
  if (!runs) return ""
  const styleId = spec.style === "muted" ? "Muted" : spec.style === "body" ? "Normal" : defaultStyleId || "Normal"
  const alignment = spec.alignment === "center" || spec.alignment === "right" ? spec.alignment : spec.alignment === "left" ? "left" : undefined
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${xmlAttr(styleId)}"/>`,
    alignment ? `<w:jc w:val="${alignment}"/>` : "",
    "</w:pPr>",
    runs,
    "</w:p>",
  ].join("")
}

function richRunXml(spec: ParagraphRunSpec, context: InsertSectionRenderContext) {
  if (spec.note?.text?.trim()) return noteReferenceXml(spec, context)
  if (spec.reference?.bookmark?.trim()) return referenceFieldXml(spec)
  const text = spec.text ?? spec.hyperlink?.url ?? spec.hyperlink?.anchor ?? ""
  if (!text.trim()) return ""
  if (spec.hyperlink?.url?.trim()) {
    const relId = context.hyperlinkRelIds.get(spec)
    if (!relId) return richTextRunXml(text, spec)
    return [
      `<w:hyperlink r:id="${xmlAttr(relId)}"${spec.hyperlink.tooltip ? ` w:tooltip="${xmlAttr(spec.hyperlink.tooltip)}"` : ""}>`,
      richTextRunXml(text, spec, { color: "0563C1", underline: true }),
      "</w:hyperlink>",
    ].join("")
  }
  if (spec.hyperlink?.anchor?.trim()) {
    const anchor = safeBookmarkName(spec.hyperlink.anchor)
    if (!anchor) return richTextRunXml(text, spec)
    return [
      `<w:hyperlink w:anchor="${xmlAttr(anchor)}"${spec.hyperlink.tooltip ? ` w:tooltip="${xmlAttr(spec.hyperlink.tooltip)}"` : ""}>`,
      richTextRunXml(text, spec, { color: "0563C1", underline: true }),
      "</w:hyperlink>",
    ].join("")
  }
  const markerRuns = richTextWithCrossReferenceMarkersXml(text, spec)
  if (markerRuns) return markerRuns
  return richTextRunXml(text, spec)
}

function noteReferenceXml(spec: ParagraphRunSpec, context: InsertSectionRenderContext) {
  const item = context.noteMap.get(spec)
  if (!item) throw new Error("richParagraph note run was not prepared for this edit operation.")
  const tag = item.kind === "endnote" ? "endnoteReference" : "footnoteReference"
  return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${tag} w:id="${item.id}"/></w:r>`
}

function referenceFieldXml(spec: ParagraphRunSpec) {
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
    richTextRunXml(fallbackText, spec),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("")
}

function richTextWithCrossReferenceMarkersXml(text: string, spec: ParagraphRunSpec) {
  const markerPattern = /\{\{\s*(ref|pageref)\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})(?:\|([^{}]{0,200}))?\s*\}\}/gi
  let cursor = 0
  let found = false
  const runs: string[] = []
  for (const match of text.matchAll(markerPattern)) {
    const start = match.index ?? 0
    const full = match[0] ?? ""
    if (start > cursor) runs.push(richTextRunXml(text.slice(cursor, start), spec))
    const rawBookmark = match[2] ?? ""
    const bookmark = safeBookmarkName(rawBookmark)
    if (bookmark) {
      const field = (match[1] ?? "").toUpperCase() === "PAGEREF" ? "PAGEREF" : "REF"
      const fallbackText = (match[3] ?? "").trim() || bookmark
      runs.push(referenceFieldXml({
        ...spec,
        text: fallbackText,
        reference: { bookmark, field, fallbackText },
      }))
    } else {
      runs.push(richTextRunXml(full, spec))
    }
    found = true
    cursor = start + full.length
  }
  if (!found) return ""
  if (cursor < text.length) runs.push(richTextRunXml(text.slice(cursor), spec))
  return runs.filter(Boolean).join("")
}

function richTextRunXml(text: string, spec: ParagraphRunSpec, overrides: { color?: string; underline?: boolean } = {}) {
  return [
    "<w:r><w:rPr>",
    spec.bold ? "<w:b/>" : "",
    spec.italic ? "<w:i/>" : "",
    overrides.color ? `<w:color w:val="${xmlAttr(overrides.color)}"/>` : "",
    overrides.underline ? '<w:u w:val="single"/>' : "",
    "</w:rPr>",
    textRuns(text),
    "</w:r>",
  ].join("")
}

function figureXml(item: InsertedFigureBuildItem) {
  const figure = item.figure
  return [
    figure.title ? paragraphXml(figure.title, "Caption") : "",
    figureDrawingParagraphXml(item),
    figure.caption || figure.label || figure.bookmark ? figureCaptionParagraphXml(item) : "",
  ].filter(Boolean)
}

function figureCaptionParagraphXml(item: InsertedFigureBuildItem) {
  const figure = item.figure
  const label = figure.label?.trim() || "Figure"
  const number = figure.number?.trim() || String(item.docPrId)
  const caption = figure.caption?.trim()
  const bookmark = safeBookmarkName(figure.bookmark || figure.id || `fig_${item.docPrId}`)
  return [
    "<w:p>",
    "<w:pPr>",
    '<w:pStyle w:val="Caption"/>',
    '<w:jc w:val="center"/>',
    "</w:pPr>",
    bookmark ? `<w:bookmarkStart w:id="${item.bookmarkId}" w:name="${xmlAttr(bookmark)}"/>` : "",
    `<w:r><w:t xml:space="preserve">${xmlText(`${label} `)}</w:t></w:r>`,
    seqFieldXml(label, number),
    bookmark ? `<w:bookmarkEnd w:id="${item.bookmarkId}"/>` : "",
    caption ? `<w:r><w:t xml:space="preserve">${xmlText(`: ${caption}`)}</w:t></w:r>` : "",
    "</w:p>",
  ].join("")
}

function seqFieldXml(label: string, cachedNumber: string) {
  const sequenceId = sequenceIdentifier(label)
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> SEQ ${xmlText(sequenceId)} \\* ARABIC </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r><w:t xml:space="preserve">${xmlText(cachedNumber)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("")
}

function sequenceIdentifier(label: string) {
  const normalized = label.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : "Figure"
}

function safeBookmarkName(input: string | undefined) {
  const normalized = String(input || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  if (!normalized) return ""
  return /^[A-Za-z_]/.test(normalized) ? normalized : `b_${normalized}`.slice(0, 40)
}

function figureDrawingParagraphXml(item: InsertedFigureBuildItem) {
  const size = figureSizeEmu(item)
  const figure = item.figure
  const name = figure.title || `Figure ${item.docPrId}`
  const description = figure.altText || figure.caption || figure.title
  return [
    "<w:p>",
    "<w:pPr>",
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

function figureSizeEmu(item: InsertedFigureBuildItem) {
  const emusPerPixel = 9525
  const maxCx = 9000 * 635
  const rawCx = Math.max(1, item.width) * emusPerPixel
  const rawCy = Math.max(1, item.height) * emusPerPixel
  const scale = Math.min(1, maxCx / rawCx)
  return {
    cx: Math.max(1, Math.round(rawCx * scale)),
    cy: Math.max(1, Math.round(rawCy * scale)),
  }
}

function updateTable(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateTable" }>) {
  const elements = parseTopLevelElements(documentXml)
  const tableIndex = operation.locator.tableIndex
  const target = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)
  if (!target) throw new Error(`updateTable locator not found: table ${tableIndex}`)
  const updates = operation.locator.kind === "tableCell"
    ? [{ rowIndex: operation.locator.rowIndex ?? 0, cellIndex: operation.locator.cellIndex ?? 0, text: operation.text ?? "" }]
    : operation.cellUpdates ?? []
  if (!updates.length) throw new Error("updateTable requires a tableCell locator or cellUpdates.")
  let tableXml = target.xml
  for (const update of updates) tableXml = replaceTableCellText(tableXml, update.rowIndex, update.cellIndex, update.text)
  return { documentXml: documentXml.replace(target.xml, tableXml), detail: `updated ${updates.length} table cell(s) in table ${tableIndex}` }
}

function replaceTable(documentXml: string, operation: Extract<DocumentEditOperation, { type: "replaceTable" }>) {
  const elements = parseTopLevelElements(documentXml)
  const tableIndex = operation.locator.tableIndex
  const target = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)
  if (!target) throw new Error(`replaceTable locator not found: table ${tableIndex}`)
  return {
    documentXml: documentXml.replace(target.xml, tableXml(operation.table)),
    detail: `replaced table ${tableIndex}`,
  }
}

function insertTableColumn(documentXml: string, operation: Extract<DocumentEditOperation, { type: "insertTableColumn" }>) {
  const elements = parseTopLevelElements(documentXml)
  const tableIndex = operation.locator.tableIndex
  const target = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)
  if (!target) throw new Error(`insertTableColumn locator not found: table ${tableIndex}`)
  const tableXml = insertTableColumnXml(target.xml, operation)
  return {
    documentXml: documentXml.replace(target.xml, tableXml),
    detail: `inserted table column in table ${tableIndex}`,
  }
}

function updateTableHeaderRows(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateTableHeaderRows" }>) {
  const elements = parseTopLevelElements(documentXml)
  const tableIndex = operation.locator.tableIndex
  const target = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)
  if (!target) throw new Error(`updateTableHeaderRows locator not found: table ${tableIndex}`)
  const tableXml = setTableHeaderRows(target.xml, operation.headerRowCount)
  return {
    documentXml: documentXml.replace(target.xml, tableXml),
    detail: `updated ${operation.headerRowCount} table header row(s) in table ${tableIndex}`,
  }
}

function insertTableColumnXml(tableXml: string, operation: Extract<DocumentEditOperation, { type: "insertTableColumn" }>) {
  const rows = tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
  if (rows.length === 0) throw new Error("insertTableColumn requires a table with at least one row.")
  if (operation.values.length !== rows.length - 1) throw new Error(`insertTableColumn values length ${operation.values.length} does not match non-header row count ${rows.length - 1}.`)
  const columnCounts = rows.map((row) => row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g)?.length ?? 0)
  const maxColumns = Math.max(...columnCounts)
  const columnIndex = Math.min(operation.columnIndex ?? maxColumns, maxColumns)
  let nextTableXml = updateTableGridForInsertedColumn(tableXml, columnIndex)
  for (const [rowIndex, row] of rows.entries()) {
    const text = rowIndex === 0 ? operation.header : operation.values[rowIndex - 1] ?? ""
    const updated = insertCellIntoRow(row, columnIndex, text)
    nextTableXml = nextTableXml.replace(row, updated)
  }
  return nextTableXml
}

function updateTableGridForInsertedColumn(tableXml: string, columnIndex: number) {
  const gridMatch = tableXml.match(/<w:tblGrid\b[^>]*>[\s\S]*?<\/w:tblGrid>/)
  if (!gridMatch) return tableXml
  const gridXml = gridMatch[0]
  const cols = gridXml.match(/<w:gridCol\b[^>]*\/>/g) ?? []
  if (!cols.length) return tableXml
  const source = cols[Math.min(columnIndex, cols.length - 1)] ?? cols[cols.length - 1]!
  const insertAt = Math.min(columnIndex, cols.length)
  const nextCols = [...cols.slice(0, insertAt), source, ...cols.slice(insertAt)]
  return tableXml.replace(gridXml, gridXml.replace(/<w:tblGrid\b([^>]*)>[\s\S]*?<\/w:tblGrid>/, `<w:tblGrid$1>${nextCols.join("")}</w:tblGrid>`))
}

function insertCellIntoRow(rowXml: string, columnIndex: number, text: string) {
  const cells = rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []
  const insertAt = Math.min(columnIndex, cells.length)
  const reference = cells[Math.max(0, Math.min(insertAt, cells.length - 1))]
  const cell = insertedTableCellXml(text, reference)
  if (!cells.length) return rowXml.replace("</w:tr>", `${cell}</w:tr>`)
  if (insertAt >= cells.length) return rowXml.replace(cells[cells.length - 1]!, `${cells[cells.length - 1]}${cell}`)
  return rowXml.replace(cells[insertAt]!, `${cell}${cells[insertAt]}`)
}

function insertedTableCellXml(text: string, referenceCellXml: string | undefined) {
  const tcPr = referenceCellXml?.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0]
    ?.replace(/<w:gridSpan\b[^>]*\/>/g, "")
    .replace(/<w:vMerge\b[^>]*\/>/g, "")
    .replace(/<w:vMerge\b[\s\S]*?<\/w:vMerge>/g, "")
    ?? "<w:tcPr><w:vAlign w:val=\"center\"/></w:tcPr>"
  return `<w:tc>${tcPr}${paragraphXml(text || " ", "Normal")}</w:tc>`
}

function checkTablePreservation(
  operations: DocumentEditOperation[],
  inspection: WordDocumentInspection,
  documentXml: string,
): WordTablePreservationCheckResult {
  const tableOperations = operations.filter((operation) =>
    operation.type === "replaceTable" ||
    operation.type === "insertTableColumn" ||
    operation.type === "updateTable" ||
    operation.type === "updateTableWithTrackedChange" ||
    operation.type === "updateTableHeaderRows"
  )
  const issues: QualityIssue[] = []
  const details: WordTablePreservationCheckResult["operations"] = []
  const elements = parseTopLevelElements(documentXml)
  let beforeNonEmptyCells = 0
  let afterNonEmptyCells = 0
  let preservedNonEmptyCells = 0
  let lostNonEmptyCells = 0
  for (const operation of tableOperations) {
    const tableIndex = operation.locator.tableIndex
    const beforeTable = inspection.tables.find((table) => table.tableIndex === tableIndex)
    const afterXml = elements.find((element) => element.kind === "table" && element.tableIndex === tableIndex)?.xml
    if (!beforeTable || !afterXml) continue
    const beforeRows = beforeTable.rows
    const afterRows = tableRows(afterXml)
    const summary = tablePreservationSummary(beforeRows, afterRows)
    beforeNonEmptyCells += summary.beforeNonEmptyCells
    afterNonEmptyCells += summary.afterNonEmptyCells
    preservedNonEmptyCells += summary.preservedNonEmptyCells
    lostNonEmptyCells += summary.lostNonEmptyCells
    details.push({
      type: operation.type,
      tableIndex,
      beforeRows: beforeRows.length,
      afterRows: afterRows.length,
      beforeColumns: maxTableColumns(beforeRows),
      afterColumns: maxTableColumns(afterRows),
      beforeNonEmptyCells: summary.beforeNonEmptyCells,
      afterNonEmptyCells: summary.afterNonEmptyCells,
      preservedNonEmptyCells: summary.preservedNonEmptyCells,
      lostNonEmptyCells: summary.lostNonEmptyCells,
      preservationRatio: summary.preservationRatio,
    })
    if (operation.type === "replaceTable" && summary.beforeNonEmptyCells >= 20 && (summary.preservationRatio < 0.8 || afterRows.length < beforeRows.length)) {
      issues.push(issue("error", "replace-table-content-loss-risk", `replaceTable on table ${tableIndex} would preserve only ${Math.round(summary.preservationRatio * 100)}% of inspected non-empty cells; use insertTableColumn/updateTable for local table edits or provide a complete replacement table.`))
    }
    if (operation.type === "insertTableColumn" && (afterRows.length !== beforeRows.length || maxTableColumns(afterRows) < maxTableColumns(beforeRows) + 1 || summary.lostNonEmptyCells > 0)) {
      issues.push(issue("error", "insert-table-column-preservation-failed", `insertTableColumn on table ${tableIndex} did not preserve the original table shape/content.`))
    }
  }
  return {
    ok: !issues.some((item) => item.severity === "error"),
    issues,
    checkedTables: details.length,
    beforeNonEmptyCells,
    afterNonEmptyCells,
    preservedNonEmptyCells,
    lostNonEmptyCells,
    operations: details,
  }
}

function tablePreservationSummary(beforeRows: string[][], afterRows: string[][]) {
  const beforeCells = beforeRows.flat().map(normalizedCellText).filter(Boolean)
  const afterCounts = new Map<string, number>()
  for (const text of afterRows.flat().map(normalizedCellText).filter(Boolean)) afterCounts.set(text, (afterCounts.get(text) ?? 0) + 1)
  let preservedNonEmptyCells = 0
  for (const text of beforeCells) {
    const count = afterCounts.get(text) ?? 0
    if (count <= 0) continue
    preservedNonEmptyCells += 1
    afterCounts.set(text, count - 1)
  }
  const beforeNonEmptyCells = beforeCells.length
  const afterNonEmptyCells = afterRows.flat().map(normalizedCellText).filter(Boolean).length
  const lostNonEmptyCells = Math.max(0, beforeNonEmptyCells - preservedNonEmptyCells)
  return {
    beforeNonEmptyCells,
    afterNonEmptyCells,
    preservedNonEmptyCells,
    lostNonEmptyCells,
    preservationRatio: beforeNonEmptyCells ? preservedNonEmptyCells / beforeNonEmptyCells : 1,
  }
}

function normalizedCellText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function maxTableColumns(rows: string[][]) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0)
}

function setTableHeaderRows(tableXml: string, headerRowCount: number) {
  let rowIndex = 0
  return tableXml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (rowXml) => {
    rowIndex += 1
    return rowIndex <= headerRowCount ? ensureTableRowHeader(rowXml) : removeTableRowHeader(rowXml)
  })
}

function ensureTableRowHeader(rowXml: string) {
  if (/<w:tblHeader\b/.test(rowXml)) return rowXml
  if (/<w:trPr\b[^>]*\/>/.test(rowXml)) {
    return rowXml.replace(/<w:trPr\b[^>]*\/>/, "<w:trPr><w:tblHeader/></w:trPr>")
  }
  if (/<w:trPr\b[\s\S]*?<\/w:trPr>/.test(rowXml)) {
    return rowXml.replace(/<w:trPr\b[^>]*>/, (tag) => `${tag}<w:tblHeader/>`)
  }
  return rowXml.replace(/<w:tr\b([^>]*)>/, "<w:tr$1><w:trPr><w:tblHeader/></w:trPr>")
}

function removeTableRowHeader(rowXml: string) {
  return rowXml
    .replace(/<w:tblHeader\b[^>]*\/>/g, "")
    .replace(/<w:tblHeader\b[^>]*>\s*<\/w:tblHeader>/g, "")
    .replace(/<w:trPr\b[^>]*>\s*<\/w:trPr>/g, "")
}

function updateList(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateList" }>, listKindByNumId: Map<string, "bullet" | "numbered" | "checklist">) {
  const target = listGroups(documentXml, listKindByNumId).find((group) =>
    operation.locator.listIndex ? group.listIndex === operation.locator.listIndex : operation.locator.blockId === group.blockId,
  )
  if (!target) throw new Error(`updateList locator not found: ${operation.locator.blockId ?? operation.locator.listIndex}`)
  const templatesByLevel = new Map<number, string>()
  for (const item of target.items) {
    if (!templatesByLevel.has(item.level)) templatesByLevel.set(item.level, item.xml)
  }
  const nextItems = operation.items.map((item, index) => {
    const level = normalizeListEditLevel(item.level ?? target.items[index]?.level ?? 0)
    const template = templatesByLevel.get(level) ?? target.items[Math.min(index, target.items.length - 1)]?.xml ?? target.items[0]?.xml
    if (!template) throw new Error(`updateList has no paragraph template for list ${target.listIndex}.`)
    return setParagraphListLevel(rewriteParagraphText(template, item.text), level)
  }).join("")
  return {
    documentXml: documentXml.replace(target.xml, nextItems),
    detail: `updated ${operation.items.length} list item(s) in list ${target.listIndex}`,
  }
}

function listGroups(documentXml: string, listKindByNumId: Map<string, "bullet" | "numbered" | "checklist">) {
  const groups: Array<{
    listIndex: number
    blockId: string
    xml: string
    numId: string
    kind?: "bullet" | "numbered" | "checklist"
    items: Array<{ xml: string; blockId: string; level: number }>
  }> = []
  let active: (typeof groups)[number] | undefined
  for (const element of parseTopLevelElements(documentXml)) {
    if (element.kind !== "paragraph") {
      active = undefined
      continue
    }
    const info = paragraphListInfo(element.xml, listKindByNumId)
    if (!info) {
      active = undefined
      continue
    }
    const sameList = active
      && (active.numId === info.numId || (active.kind === "checklist" && info.kind === "checklist"))
    if (!sameList) {
      const listIndex = groups.length + 1
      active = { listIndex, blockId: `list-${listIndex}`, xml: "", numId: info.numId, kind: info.kind, items: [] }
      groups.push(active)
    }
    const current = active
    if (!current) throw new Error("updateList internal error: active list missing after list paragraph detection")
    current.xml += element.xml
    current.items.push({ xml: element.xml, blockId: element.blockId, level: info.level })
  }
  return groups
}

function setParagraphListLevel(paragraphXml: string, level: number) {
  const safeLevel = normalizeListEditLevel(level)
  if (/<w:ilvl\b[^>]*\/?>/.test(paragraphXml)) {
    return paragraphXml.replace(/<w:ilvl\b[^>]*\/?>/, `<w:ilvl w:val="${safeLevel}"/>`)
  }
  return paragraphXml.replace(/<w:numPr\b[^>]*>/, (tag) => `${tag}<w:ilvl w:val="${safeLevel}"/>`)
}

function normalizeListEditLevel(value: number | undefined) {
  return value === 1 || value === 2 ? value : 0
}

function updateSectionPageSetup(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateSectionPageSetup" }>) {
  const matches = Array.from(documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g))
  const targetIndex = operation.locator.sectionIndex ?? sectionIndexFromBlockId(operation.locator.blockId)
  const target = matches.find((_match, index) => index + 1 === targetIndex)
  if (!target) throw new Error(`updateSectionPageSetup locator not found: ${operation.locator.blockId ?? operation.locator.sectionIndex}`)
  const start = target.index ?? documentXml.indexOf(target[0])
  if (start < 0) throw new Error(`updateSectionPageSetup locator not found in document XML: ${operation.locator.blockId ?? operation.locator.sectionIndex}`)
  const nextSectionXml = rewriteSectionPageSetup(target[0], operation.page)
  return {
    documentXml: `${documentXml.slice(0, start)}${nextSectionXml}${documentXml.slice(start + target[0].length)}`,
    detail: `updated page setup for section ${targetIndex}`,
  }
}

function rewriteSectionPageSetup(sectionXml: string, page: Extract<DocumentEditOperation, { type: "updateSectionPageSetup" }>["page"]) {
  const currentPgSz = sectionXml.match(/<w:pgSz\b[^>]*\/?>/)?.[0]
  const currentPgMar = sectionXml.match(/<w:pgMar\b[^>]*\/?>/)?.[0]
  const baseSize = page.size ? PAGE_SIZE_TWIPS[page.size] : undefined
  let width = page.widthTwips ?? baseSize?.width ?? sectionAttrNumber(currentPgSz, "w") ?? PAGE_SIZE_TWIPS.a4.width
  let height = page.heightTwips ?? baseSize?.height ?? sectionAttrNumber(currentPgSz, "h") ?? PAGE_SIZE_TWIPS.a4.height
  const currentOrientation = sectionOrientationFromSize(sectionAttr(currentPgSz, "orient"), width, height)
  const orientation = page.orientation ?? currentOrientation
  if (orientation === "landscape" && width < height) [width, height] = [height, width]
  if (orientation === "portrait" && width > height) [width, height] = [height, width]
  const nextPgSz = `<w:pgSz w:w="${width}" w:h="${height}"${orientation === "landscape" ? ' w:orient="landscape"' : ""}/>`
  const currentMargins = {
    top: sectionAttrNumber(currentPgMar, "top") ?? 1440,
    right: sectionAttrNumber(currentPgMar, "right") ?? 1440,
    bottom: sectionAttrNumber(currentPgMar, "bottom") ?? 1440,
    left: sectionAttrNumber(currentPgMar, "left") ?? 1440,
    header: sectionAttrNumber(currentPgMar, "header") ?? 720,
    footer: sectionAttrNumber(currentPgMar, "footer") ?? 720,
    gutter: sectionAttrNumber(currentPgMar, "gutter") ?? 0,
  }
  const margins = { ...currentMargins, ...(page.margins ?? {}) }
  const nextPgMar = `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="${margins.header}" w:footer="${margins.footer}" w:gutter="${margins.gutter}"/>`
  const cleaned = sectionXml
    .replace(/<w:pgSz\b[^>]*\/?>/, "")
    .replace(/<w:pgMar\b[^>]*\/?>/, "")
  return cleaned.replace("</w:sectPr>", `${nextPgSz}${nextPgMar}</w:sectPr>`)
}

function updateCaptionText(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateCaptionText" }>) {
  let captionIndex = 0
  let found = false
  const nextXml = documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const info = captionInfoFromParagraph(paragraphXml)
    if (!info) return paragraphXml
    captionIndex += 1
    if (found || !captionLocatorMatches(operation.locator, info, captionIndex)) return paragraphXml
    found = true
    return rewriteCaptionParagraphText(paragraphXml, operation.caption, info)
  })
  if (!found) throw new Error(`updateCaptionText locator not found: ${operation.locator.blockId ?? operation.locator.captionIndex}`)
  return {
    documentXml: nextXml,
    detail: `updated caption ${operation.locator.blockId ?? operation.locator.captionIndex}`,
  }
}

type CaptionEditInfo = {
  captionKind: "figure" | "table" | "unknown"
  label?: string
  number?: string
  fieldInstruction?: string
}

function captionInfoFromParagraph(paragraphXml: string): CaptionEditInfo | undefined {
  const styleId = paragraphStyleId(paragraphXml)
  const fieldInstruction = normalizeFieldInstruction(fieldInstrTextFrom(paragraphXml))
  const seqMatch = fieldInstruction.match(/\bSEQ\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)
  const isCaptionStyle = styleId?.replace(/\s+/g, "").toLowerCase() === "caption"
  if (!seqMatch && !isCaptionStyle) return undefined
  const number = complexFieldCachedText(paragraphXml)
  const sequenceLabel = seqMatch?.[1]
  const fullText = xmlTextFrom(paragraphXml).trim()
  const label = captionVisibleLabel(fullText, number) ?? sequenceLabel
  return {
    captionKind: captionKindFrom(label, sequenceLabel),
    label,
    number,
    fieldInstruction: seqMatch ? fieldInstruction : undefined,
  }
}

function captionLocatorMatches(locator: WordDocumentLocator, info: CaptionEditInfo, captionIndex: number) {
  if (locator.captionIndex && locator.captionIndex !== captionIndex) return false
  if (locator.blockId && locator.blockId !== `caption-${captionIndex}`) return false
  if (locator.captionKind && locator.captionKind !== info.captionKind) return false
  if (locator.captionLabel && info.label && locator.captionLabel !== info.label) return false
  return true
}

function rewriteCaptionParagraphText(paragraphXml: string, caption: string, info: CaptionEditInfo) {
  const body = normalizeCaptionBody(caption, info)
  const text = info.fieldInstruction ? `: ${body}` : body
  const runs = Array.from(paragraphXml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g))
  const endRunIndex = runs.findIndex((run) => /<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/.test(run[0]))
  if (endRunIndex >= 0) {
    for (let index = endRunIndex + 1; index < runs.length; index += 1) {
      const run = runs[index]
      if (!run || !/<w:t\b/.test(run[0])) continue
      return replaceXmlSlice(paragraphXml, run.index ?? paragraphXml.indexOf(run[0]), run[0], rewriteTextRun(run[0], text))
    }
    return paragraphXml.replace("</w:p>", `${captionTextRun(paragraphXml, text)}</w:p>`)
  }
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (!run || !/<w:t\b/.test(run[0])) continue
    return replaceXmlSlice(paragraphXml, run.index ?? paragraphXml.indexOf(run[0]), run[0], rewriteTextRun(run[0], text))
  }
  return paragraphXml.replace("</w:p>", `${captionTextRun(paragraphXml, text)}</w:p>`)
}

function replaceXmlSlice(input: string, start: number, oldXml: string, newXml: string) {
  if (start < 0) return input.replace(oldXml, newXml)
  return `${input.slice(0, start)}${newXml}${input.slice(start + oldXml.length)}`
}

function rewriteTextRun(runXml: string, text: string) {
  const rPr = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return `<w:r>${rPr}${textRuns(text)}</w:r>`
}

function captionTextRun(paragraphXml: string, text: string) {
  const rPr = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return `<w:r>${rPr}${textRuns(text)}</w:r>`
}

function normalizeCaptionBody(caption: string, info: CaptionEditInfo) {
  let text = caption.trim().replace(/^[:：]\s*/, "")
  if (info.label && info.number) {
    const prefix = new RegExp(`^${escapeRegExp(info.label)}\\s+${escapeRegExp(info.number)}\\s*[:：]?\\s*`, "i")
    text = text.replace(prefix, "")
  } else if (info.label) {
    const prefix = new RegExp(`^${escapeRegExp(info.label)}\\s*[:：]?\\s*`, "i")
    text = text.replace(prefix, "")
  }
  return text.trim()
}

function captionVisibleLabel(fullText: string, number: string | undefined) {
  if (!number) return undefined
  const index = fullText.indexOf(number)
  if (index <= 0) return undefined
  const label = fullText.slice(0, index).trim()
  return label || undefined
}

function fieldInstrTextFrom(xml: string) {
  return (xml.match(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g) ?? [])
    .map((tag) => decodeXmlText(tag.replace(/^<w:instrText\b[^>]*>/, "").replace(/<\/w:instrText>$/, "")))
    .join("")
}

function complexFieldCachedText(xml: string) {
  const runs = xml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []
  const separateIndex = runs.findIndex((run) => /<w:fldChar\b[^>]*w:fldCharType="separate"[^>]*\/>/.test(run))
  if (separateIndex < 0) return undefined
  const endIndex = runs.findIndex((run, index) => index > separateIndex && /<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/.test(run))
  if (endIndex < 0 || endIndex <= separateIndex + 1) return undefined
  const cachedText = xmlTextFrom(runs.slice(separateIndex + 1, endIndex).join("")).trim()
  return cachedText || undefined
}

function normalizeFieldInstruction(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function captionKindFrom(label: string | undefined, sequenceLabel: string | undefined): "figure" | "table" | "unknown" {
  const text = [label, sequenceLabel].filter(Boolean).join(" ").toLowerCase()
  if (/\b(table|tbl)\b|表/.test(text)) return "table"
  if (/\b(figure|fig)\b|图/.test(text)) return "figure"
  return "unknown"
}

function updateHyperlinkText(documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateHyperlinkText" }>) {
  let hyperlinkIndex = 0
  let found = false
  const nextXml = documentXml.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, (hyperlinkXml) => {
    hyperlinkIndex += 1
    if (found || !hyperlinkLocatorMatches(operation.locator, hyperlinkXml, hyperlinkIndex)) return hyperlinkXml
    found = true
    return rewriteHyperlinkText(hyperlinkXml, operation.text)
  })
  if (!found) throw new Error(`updateHyperlinkText locator not found: ${operation.locator.blockId ?? operation.locator.hyperlinkIndex ?? operation.locator.hyperlinkRelId ?? operation.locator.hyperlinkAnchor}`)
  return {
    documentXml: nextXml,
    detail: `updated hyperlink text ${operation.locator.blockId ?? operation.locator.hyperlinkIndex}`,
  }
}

function hyperlinkLocatorMatches(locator: WordDocumentLocator, hyperlinkXml: string, hyperlinkIndex: number) {
  if (locator.hyperlinkIndex && locator.hyperlinkIndex !== hyperlinkIndex) return false
  const relId = hyperlinkXml.match(/\br:id="([^"]*)"/)?.[1]
  if (locator.hyperlinkRelId && relId !== locator.hyperlinkRelId) return false
  const anchor = hyperlinkXml.match(/\bw:anchor="([^"]*)"/)?.[1]
  if (locator.hyperlinkAnchor && anchor !== locator.hyperlinkAnchor) return false
  if (locator.blockId && locator.blockId !== `hyperlink-${hyperlinkIndex}`) return false
  return true
}

function rewriteHyperlinkText(hyperlinkXml: string, text: string) {
  const open = hyperlinkXml.match(/^<w:hyperlink\b[^>]*>/)?.[0]
  if (!open) throw new Error("updateHyperlinkText requires a w:hyperlink element.")
  const textRun = hyperlinkXml.match(/<w:r\b[\s\S]*?<w:t\b[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/)?.[0]
  const rPr = textRun?.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return `${open}<w:r>${rPr}${textRuns(text)}</w:r></w:hyperlink>`
}

async function updateHyperlinkTargetOperation(root: string, documentXml: string, operation: Extract<DocumentEditOperation, { type: "updateHyperlinkTarget" }>) {
  const relsPath = path.join(root, "word", "_rels", "document.xml.rels")
  let relsXml = ensureDocumentRelationships(await readTextIfExists(relsPath))
  let hyperlinkIndex = 0
  let found = false
  const nextXml = documentXml.replace(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g, (hyperlinkXml) => {
    hyperlinkIndex += 1
    if (found || !hyperlinkLocatorMatches(operation.locator, hyperlinkXml, hyperlinkIndex)) return hyperlinkXml
    found = true
    const rewritten = rewriteHyperlinkTarget(hyperlinkXml, operation, relsXml)
    relsXml = rewritten.relsXml
    return rewritten.hyperlinkXml
  })
  if (!found) throw new Error(`updateHyperlinkTarget locator not found: ${operation.locator.blockId ?? operation.locator.hyperlinkIndex ?? operation.locator.hyperlinkRelId ?? operation.locator.hyperlinkAnchor}`)
  await mkdir(path.dirname(relsPath), { recursive: true })
  await writeFile(relsPath, relsXml)
  return {
    documentXml: nextXml,
    detail: `updated hyperlink target ${operation.locator.blockId ?? operation.locator.hyperlinkIndex}`,
  }
}

function rewriteHyperlinkTarget(hyperlinkXml: string, operation: Extract<DocumentEditOperation, { type: "updateHyperlinkTarget" }>, inputRelsXml: string) {
  const open = hyperlinkXml.match(/^<w:hyperlink\b[^>]*>/)?.[0]
  if (!open) throw new Error("updateHyperlinkTarget requires a w:hyperlink element.")
  const close = "</w:hyperlink>"
  const body = hyperlinkXml.slice(open.length, hyperlinkXml.endsWith(close) ? -close.length : undefined)
  const url = operation.url?.trim()
  const anchor = operation.anchor?.trim()
  const tooltip = operation.tooltip
  let relsXml = inputRelsXml
  let nextOpen = open
  if (url) {
    const currentRelId = xmlAttrValueFromTag(open, "id")
    const relId = currentRelId || nextRelationshipId(relsXml, "rIdChipMateHyperlink")
    relsXml = upsertHyperlinkRelationship(relsXml, relId, url)
    nextOpen = setXmlAttr(removeXmlAttr(nextOpen, "anchor"), "r:id", relId)
  } else if (anchor) {
    const safeAnchor = safeBookmarkName(anchor)
    if (!safeAnchor) throw new Error("updateHyperlinkTarget anchor produced an empty Word bookmark name.")
    nextOpen = setXmlAttr(removeXmlAttr(nextOpen, "id"), "w:anchor", safeAnchor)
  }
  if (tooltip !== undefined) {
    nextOpen = tooltip.trim() ? setXmlAttr(nextOpen, "w:tooltip", tooltip.trim()) : removeXmlAttr(nextOpen, "tooltip")
  }
  return { hyperlinkXml: `${nextOpen}${body}${close}`, relsXml }
}

function upsertHyperlinkRelationship(input: string, relId: string, url: string) {
  let xml = ensureDocumentRelationships(input)
  let found = false
  xml = xml.replace(/<Relationship\b[^>]*\/>/g, (relationship) => {
    if (xmlAttrValueFromTag(relationship, "Id") !== relId) return relationship
    found = true
    return `<Relationship Id="${xmlAttr(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlAttr(url)}" TargetMode="External"/>`
  })
  if (!found) {
    xml = xml.replace("</Relationships>", `<Relationship Id="${xmlAttr(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlAttr(url)}" TargetMode="External"/></Relationships>`)
  }
  return xml
}

function sectionIndexFromBlockId(blockId: string | undefined) {
  const match = blockId?.match(/^section-(\d+)$/)
  return match?.[1] ? Number(match[1]) : undefined
}

function sectionOrientationFromSize(orient: string | undefined, width: number, height: number): "portrait" | "landscape" {
  if (orient === "landscape") return "landscape"
  if (orient === "portrait") return "portrait"
  return width > height ? "landscape" : "portrait"
}

function sectionAttr(xml: string | undefined, name: string) {
  return xml?.match(new RegExp(`\\bw:${name}="([^"]*)"`))?.[1]
}

function sectionAttrNumber(xml: string | undefined, name: string) {
  const value = Number(sectionAttr(xml, name))
  return Number.isFinite(value) ? value : undefined
}

function fillContentControl(documentXml: string, operation: Extract<DocumentEditOperation, { type: "fillContentControl" }>) {
  const block = topLevelSdtXmlBlocks(documentXml).find((item) => contentControlLocatorMatches(operation.locator, item.xml, item.index))
  if (!block) throw new Error(`fillContentControl locator not found: ${operation.locator.blockId ?? operation.locator.contentControlTag ?? operation.locator.contentControlIndex}`)
  const kind = contentControlKindFromXml(block.xml)
  const fillAnalysis = analyzeContentControlFillSupport(block.xml, kind, block.nestedControlCount)
  if (!fillAnalysis.fillSupported) {
    throw new Error(`fillContentControl does not support this content control: ${fillAnalysis.fillUnsupportedReason ?? "unsupported-content-control"}`)
  }
  const rewritten = rewriteSdtContentText(block.xml, operation.text)
  const nextXml = `${documentXml.slice(0, block.start)}${rewritten}${documentXml.slice(block.end)}`
  return {
    documentXml: nextXml,
    detail: `filled content control ${operation.locator.contentControlTag || operation.locator.contentControlTitle || operation.locator.blockId || operation.locator.contentControlIndex}`,
  }
}

function rewriteParagraphText(paragraphXml: string, text: string) {
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  const rPr = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return `<w:p>${pPr}<w:r>${rPr}${textRuns(text)}</w:r></w:p>`
}

function setParagraphStyle(paragraphXml: string, styleId: string) {
  const styleTag = `<w:pStyle w:val="${xmlAttr(styleId)}"/>`
  if (/<w:pPr\b[^>]*\/>/.test(paragraphXml)) {
    return paragraphXml.replace(/<w:pPr\b[^>]*\/>/, `<w:pPr>${styleTag}</w:pPr>`)
  }
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0]
  if (pPr) {
    const nextPPr = /<w:pStyle\b[^>]*\/?>/.test(pPr)
      ? pPr.replace(/<w:pStyle\b[^>]*\/?>/, styleTag)
      : pPr.replace(/<w:pPr\b[^>]*>/, (tag) => `${tag}${styleTag}`)
    return paragraphXml.replace(pPr, nextPPr)
  }
  return paragraphXml.replace(/<w:p\b([^>]*)>/, `<w:p$1><w:pPr>${styleTag}</w:pPr>`)
}

function replaceTextInParagraphTextNodes(paragraphXml: string, oldText: string, newText: string) {
  let replaced = false
  const next = paragraphXml.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (match, attrs: string, encodedText: string) => {
    if (replaced) return match
    const text = decodeXmlText(encodedText)
    if (!text.includes(oldText)) return match
    replaced = true
    return `<w:t${attrs}>${xmlText(text.replace(oldText, newText))}</w:t>`
  })
  return replaced ? next : undefined
}

function trackedParagraphReplacementXml(paragraphXml: string, oldText: string, newText: string, author: string | undefined, revisionId: number) {
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  const rPr = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  const date = new Date().toISOString()
  const revisionAuthor = author?.trim() || "ChipMate"
  return [
    "<w:p>",
    pPr,
    `<w:del w:id="${revisionId}" w:author="${xmlAttr(revisionAuthor)}" w:date="${xmlAttr(date)}"><w:r>${rPr}${deletedTextRuns(oldText || " ")}</w:r></w:del>`,
    `<w:ins w:id="${revisionId + 1}" w:author="${xmlAttr(revisionAuthor)}" w:date="${xmlAttr(date)}"><w:r>${rPr}${textRuns(newText)}</w:r></w:ins>`,
    "</w:p>",
  ].join("")
}

function trackedRichParagraphReplacementXml(paragraphXml: string, paragraph: ParagraphSpec, context: InsertSectionRenderContext, author: string | undefined, revisionId: number) {
  const oldText = xmlTextFrom(paragraphXml)
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  const rPr = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  const date = new Date().toISOString()
  const revisionAuthor = author?.trim() || "ChipMate"
  const inserted = (paragraph.runs ?? [])
    .map((run) => richRunXml(run, context))
    .filter(Boolean)
    .map((runXml) => trackedInsertionXml(runXml, revisionId + 1, revisionAuthor, date))
    .join("")
  if (!inserted) return ""
  return [
    "<w:p>",
    pPr,
    `<w:del w:id="${revisionId}" w:author="${xmlAttr(revisionAuthor)}" w:date="${xmlAttr(date)}"><w:r>${rPr}${deletedTextRuns(oldText || " ")}</w:r></w:del>`,
    inserted,
    "</w:p>",
  ].join("")
}

function trackedInsertionXml(runXml: string, revisionId: number, author: string, date: string) {
  const hyperlinkOpen = runXml.match(/^<w:hyperlink\b[^>]*>/)?.[0]
  if (hyperlinkOpen && runXml.endsWith("</w:hyperlink>")) {
    const body = runXml.slice(hyperlinkOpen.length, -"</w:hyperlink>".length)
    return `${hyperlinkOpen}<w:ins w:id="${revisionId}" w:author="${xmlAttr(author)}" w:date="${xmlAttr(date)}">${body}</w:ins></w:hyperlink>`
  }
  return `<w:ins w:id="${revisionId}" w:author="${xmlAttr(author)}" w:date="${xmlAttr(date)}">${runXml}</w:ins>`
}

function trackedParagraphTextReplacementXml(paragraphXml: string, oldText: string, newText: string, author: string | undefined, revisionId: number) {
  const visibleText = xmlTextFrom(paragraphXml)
  const start = visibleText.indexOf(oldText)
  if (start < 0) throw new Error("replaceTextWithTrackedChange oldText was not found in the target paragraph.")
  const before = visibleText.slice(0, start)
  const after = visibleText.slice(start + oldText.length)
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  const rPr = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  const date = new Date().toISOString()
  const revisionAuthor = author?.trim() || "ChipMate"
  return [
    "<w:p>",
    pPr,
    before ? `<w:r>${rPr}${textRuns(before)}</w:r>` : "",
    `<w:del w:id="${revisionId}" w:author="${xmlAttr(revisionAuthor)}" w:date="${xmlAttr(date)}"><w:r>${rPr}${deletedTextRuns(oldText)}</w:r></w:del>`,
    `<w:ins w:id="${revisionId + 1}" w:author="${xmlAttr(revisionAuthor)}" w:date="${xmlAttr(date)}"><w:r>${rPr}${textRuns(newText)}</w:r></w:ins>`,
    after ? `<w:r>${rPr}${textRuns(after)}</w:r>` : "",
    "</w:p>",
  ].join("")
}

function replaceTableCellText(tableXml: string, rowIndex: number, cellIndex: number, text: string) {
  const rows = tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
  const row = rows[rowIndex]
  if (!row) throw new Error(`Table row ${rowIndex} does not exist.`)
  const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []
  const cell = cells[cellIndex]
  if (!cell) throw new Error(`Table cell ${rowIndex}:${cellIndex} does not exist.`)
  const tcPr = cell.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0] ?? ""
  const nextCell = `<w:tc>${tcPr}${paragraphXml(text || " ", "Normal")}</w:tc>`
  return tableXml.replace(row, row.replace(cell, nextCell))
}

function replaceTableCellTextWithTrackedChange(tableXml: string, rowIndex: number, cellIndex: number, text: string, author: string | undefined, revisionId: number) {
  const rows = tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
  const row = rows[rowIndex]
  if (!row) throw new Error(`Table row ${rowIndex} does not exist.`)
  const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []
  const cell = cells[cellIndex]
  if (!cell) throw new Error(`Table cell ${rowIndex}:${cellIndex} does not exist.`)
  const tcPr = cell.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0] ?? ""
  const firstParagraph = cell.match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0] ?? "<w:p></w:p>"
  const oldText = xmlTextFrom(cell).trim()
  const nextCell = `<w:tc>${tcPr}${trackedParagraphReplacementXml(firstParagraph, oldText, text, author, revisionId)}</w:tc>`
  return tableXml.replace(row, row.replace(cell, nextCell))
}

function contentControlLocatorMatches(locator: WordDocumentLocator, sdtXml: string, index: number) {
  if (locator.contentControlIndex && locator.contentControlIndex !== index) return false
  const tag = sdtXml.match(/<w:tag\b[^>]*\bw:val="([^"]*)"/)?.[1]
  const title = sdtXml.match(/<w:alias\b[^>]*\bw:val="([^"]*)"/)?.[1]
  if (locator.contentControlTag && decodeXmlText(tag ?? "") !== locator.contentControlTag) return false
  if (locator.contentControlTitle && decodeXmlText(title ?? "") !== locator.contentControlTitle) return false
  if (locator.blockId && locator.blockId !== `sdt-${index}`) return false
  return true
}

function rewriteSdtContentText(sdtXml: string, text: string) {
  if (/<w14:checkbox\b/.test(sdtXml)) return rewriteCheckboxSdt(sdtXml, text)
  const contentMatch = sdtXml.match(/<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/)
  if (!contentMatch) return sdtXml.replace("</w:sdt>", `<w:sdtContent>${paragraphXml(text, "Normal")}</w:sdtContent></w:sdt>`)
  const contentXml = contentMatch[1] ?? ""
  const firstParagraph = contentXml.match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0]
  const nextContent = firstParagraph
    ? contentXml.replace(firstParagraph, rewriteParagraphText(firstParagraph, text))
    : paragraphXml(text, "Normal")
  return sdtXml.replace(contentMatch[0], `<w:sdtContent>${nextContent}</w:sdtContent>`)
}

function rewriteCheckboxSdt(sdtXml: string, text: string) {
  const checked = checkboxEditValue(text)
  const visible = checked ? "☑" : "☐"
  const nextChecked = `<w14:checked w14:val="${checked ? "1" : "0"}"/>`
  let nextXml = /<w14:checked\b[^>]*\/?>/.test(sdtXml)
    ? sdtXml.replace(/<w14:checked\b[^>]*\/?>/, nextChecked)
    : sdtXml.replace(/<w14:checkbox\b[^>]*>/, (tag) => `${tag}${nextChecked}`)
  const contentMatch = nextXml.match(/<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/)
  if (!contentMatch) return nextXml.replace("</w:sdt>", `<w:sdtContent>${paragraphXml(visible, "Normal")}</w:sdtContent></w:sdt>`)
  const contentXml = contentMatch[1] ?? ""
  const firstParagraph = contentXml.match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0]
  const nextContent = firstParagraph
    ? contentXml.replace(firstParagraph, rewriteParagraphText(firstParagraph, visible))
    : paragraphXml(visible, "Normal")
  return nextXml.replace(contentMatch[0], `<w:sdtContent>${nextContent}</w:sdtContent>`)
}

function checkboxEditValue(text: string) {
  const normalized = text.trim()
  if (/^(?:1|true|yes|checked|on|是|已选|勾选|☑)$/i.test(normalized)) return true
  if (/^(?:0|false|no|unchecked|off|否|未选|☐)$/i.test(normalized)) return false
  return Boolean(normalized)
}

function watermarkParagraphXml(text: string) {
  const id = `ChipMateWatermark${Date.now().toString(36)}`
  return [
    "<w:p><w:r><w:pict>",
    `<v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" id="${xmlAttr(id)}" o:spid="_x0000_s1025" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:468pt;rotation:315;z-index:-251654144;mso-position-horizontal:center;mso-position-vertical:center;mso-wrap-edited:f" fillcolor="#C0C0C0" stroked="f">`,
    '<v:fill opacity="0.15"/>',
    `<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${xmlAttr(text)}"/>`,
    '<v:path textpathok="t"/>',
    "</v:shape>",
    "</w:pict></w:r></w:p>",
  ].join("")
}

function watermarkTextFromPict(pictXml: string) {
  const match = pictXml.match(/<(?:[A-Za-z0-9]+:)?textpath\b[^>]*\bstring="([^"]*)"/i)
  return match?.[1] ? decodeXmlText(match[1]).trim() : ""
}

type RemovableWatermarkCandidate = {
  offset: number
  end: number
  text: string
}

function removeWatermarkCandidates(xml: string, part: string, shouldRemove: (candidate: RemovableWatermarkCandidate) => boolean) {
  const candidates = removableWatermarkCandidates(xml, part)
  if (!candidates.length) return xml
  let output = ""
  let cursor = 0
  for (const candidate of candidates) {
    output += xml.slice(cursor, candidate.offset)
    if (!shouldRemove(candidate)) output += xml.slice(candidate.offset, candidate.end)
    cursor = candidate.end
  }
  output += xml.slice(cursor)
  return output
}

function removableWatermarkCandidates(xml: string, part: string) {
  const candidates: RemovableWatermarkCandidate[] = []
  for (const match of xml.matchAll(/<w:pict\b[\s\S]*?<\/w:pict>/g)) {
    const pict = match[0]
    const text = watermarkTextFromPict(pict)
    if (text) {
      candidates.push({ offset: match.index ?? 0, end: (match.index ?? 0) + pict.length, text })
      continue
    }
    if (isVmlImageBackgroundCandidate(pict, part)) {
      candidates.push({
        offset: match.index ?? 0,
        end: (match.index ?? 0) + pict.length,
        text: `VML image background: ${vmlImageBackgroundLabel(pict)}`,
      })
    }
  }
  for (const match of xml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
    const drawing = match[0]
    if (!isDrawingImageBackgroundCandidate(drawing, part)) continue
    candidates.push({
      offset: match.index ?? 0,
      end: (match.index ?? 0) + drawing.length,
      text: `DrawingML image background: ${drawingImageBackgroundLabel(drawing)}`,
    })
  }
  return candidates.sort((left, right) => left.offset - right.offset)
}

function isVmlImageBackgroundCandidate(pictXml: string, part: string) {
  if (!/<(?:[A-Za-z0-9]+:)?imagedata\b/i.test(pictXml)) return false
  return /^word\/(?:header|footer)\d+\.xml$/.test(part) || /z-index\s*:\s*-/i.test(pictXml)
}

function isDrawingImageBackgroundCandidate(drawingXml: string, part: string) {
  if (!/<wp:anchor\b/.test(drawingXml)) return false
  return /^word\/(?:header|footer)\d+\.xml$/.test(part) || /\bbehindDoc="(?:1|true)"/.test(drawingXml)
}

function vmlImageBackgroundLabel(pictXml: string) {
  const imageData = pictXml.match(/<(?:[A-Za-z0-9]+:)?imagedata\b[^>]*\/?>/i)?.[0] ?? pictXml
  return xmlAttrValueFromTag(imageData, "id") ?? xmlAttrValueFromTag(imageData, "relid") ?? "missing relationship"
}

function drawingImageBackgroundLabel(drawingXml: string) {
  return xmlAttrValueFromTag(drawingXml, "embed") ?? xmlAttrValueFromTag(drawingXml, "link") ?? "missing relationship"
}

function watermarkPartSortKey(file: string) {
  const normalized = file.replace(/\\/g, "/")
  const part = normalized.match(/word\/(?:document|header\d+|footer\d+)\.xml$/)?.[0] ?? normalized
  return part === "word/document.xml" ? "0:word/document.xml" : `1:${part}`
}

function wordPartPath(file: string) {
  const normalized = file.replace(/\\/g, "/")
  return normalized.match(/word\/[^/]+\.xml$/)?.[0] ?? normalized
}

async function unpackZip(zip: Awaited<ReturnType<typeof loadDocxZip>>, targetDir: string) {
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const absolute = path.join(targetDir, entryPath)
    await mkdir(path.dirname(absolute), { recursive: true })
    const data = await entry.async("nodebuffer" as never) as unknown as Buffer
    await writeFile(absolute, data)
  }
}

async function packDirectory(root: string) {
  const JSZip = nodeRequire("jszip") as JsZipCtor
  const zip = new JSZip()
  for (const file of await listFiles(root)) {
    zip.file(path.relative(root, file).replace(/\\/g, "/"), await readFile(file))
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(absolute))
    else result.push(absolute)
  }
  return result
}

async function ensurePackageFallbacks(root: string) {
  const wordDir = path.join(root, "word")
  await mkdir(path.join(wordDir, "_rels"), { recursive: true })
  await writeFile(path.join(root, "[Content_Types].xml"), ensureContentTypes(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await writeFile(path.join(root, "_rels", ".rels"), ensurePackageRelationships(await readTextIfExists(path.join(root, "_rels", ".rels"))))
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), ensureDocumentRelationships(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
  await writeFile(path.join(wordDir, "styles.xml"), ensureStylesXml(await readTextIfExists(path.join(wordDir, "styles.xml"))))
  await writeFile(path.join(wordDir, "header1.xml"), await readTextIfExists(path.join(wordDir, "header1.xml")) || fallbackHeaderXml())
  await writeFile(path.join(wordDir, "footer1.xml"), await readTextIfExists(path.join(wordDir, "footer1.xml")) || fallbackFooterXml())
}

async function ensureCommentPackageParts(root: string, comments: CommentDraft[]) {
  const wordDir = path.join(root, "word")
  const commentsPath = path.join(wordDir, "comments.xml")
  await writeFile(commentsPath, appendCommentsXml(await readTextIfExists(commentsPath), comments))
  await writeFile(path.join(root, "[Content_Types].xml"), ensureCommentsContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), ensureCommentsRelationship(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
}

async function ensureTrackedRevisionPackageParts(root: string) {
  const wordDir = path.join(root, "word")
  const settingsPath = path.join(wordDir, "settings.xml")
  await writeFile(settingsPath, ensureTrackRevisionsSettings(await readTextIfExists(settingsPath)))
  await writeFile(path.join(root, "[Content_Types].xml"), ensureSettingsContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), ensureSettingsRelationship(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
}

async function applyDocumentProtectionUpdate(root: string, update: DocumentProtectionUpdate) {
  const wordDir = path.join(root, "word")
  const settingsPath = path.join(wordDir, "settings.xml")
  await writeFile(settingsPath, setDocumentProtectionXml(await readTextIfExists(settingsPath), update))
  await writeFile(path.join(root, "[Content_Types].xml"), ensureSettingsContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), ensureSettingsRelationship(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
}

async function applyCommentResolutionUpdates(root: string, updates: CommentResolutionUpdate[]) {
  const commentsPath = path.join(root, "word", "comments.xml")
  let commentsXml = await readTextIfExists(commentsPath)
  if (!commentsXml) throw new Error("setCommentResolved requires word/comments.xml.")
  const paraIdsByCommentId = commentParaIdsByCommentId(commentsXml)
  for (const update of updates) commentsXml = updateCommentResolvedXml(commentsXml, update)
  await writeFile(commentsPath, commentsXml)
  const commentsExtendedPath = path.join(root, "word", "commentsExtended.xml")
  let commentsExtendedXml = await readTextIfExists(commentsExtendedPath)
  if (commentsExtendedXml) {
    for (const update of updates) {
      const paraId = paraIdsByCommentId.get(update.commentId)
      if (paraId) commentsExtendedXml = updateCommentExtendedResolvedXml(commentsExtendedXml, paraId, update.resolved)
    }
    await writeFile(commentsExtendedPath, commentsExtendedXml)
  }
}

async function applyCommentTextUpdates(root: string, updates: CommentTextUpdate[]) {
  const commentsPath = path.join(root, "word", "comments.xml")
  let commentsXml = await readTextIfExists(commentsPath)
  if (!commentsXml) throw new Error("updateCommentText requires word/comments.xml.")
  for (const update of updates) commentsXml = updateCommentTextXml(commentsXml, update)
  await writeFile(commentsPath, commentsXml)
}

async function stripAllCommentPackageParts(root: string) {
  const wordDir = path.join(root, "word")
  const storyFiles = (await listFiles(wordDir)).filter((file) => /\/word\/(?:document|header\d+|footer\d+)\.xml$/.test(file))
  for (const file of storyFiles) {
    await writeFile(file, stripCommentMarkup(await readTextIfExists(file)))
  }
  await rm(path.join(wordDir, "comments.xml"), { force: true }).catch(() => undefined)
  await rm(path.join(wordDir, "commentsExtended.xml"), { force: true }).catch(() => undefined)
  await rm(path.join(wordDir, "commentsIds.xml"), { force: true }).catch(() => undefined)
  await writeFile(path.join(root, "[Content_Types].xml"), stripCommentsContentTypes(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), stripCommentsRelationships(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
}

async function cleanTrackedChangePackageParts(root: string, mode: "accept" | "reject") {
  const wordDir = path.join(root, "word")
  const storyFiles = (await listFiles(wordDir)).filter((file) => /\/word\/(?:document|header\d+|footer\d+)\.xml$/.test(file))
  for (const file of storyFiles) {
    await writeFile(file, applyTrackedChangesXml(await readTextIfExists(file), mode))
  }
  const settingsPath = path.join(wordDir, "settings.xml")
  const settingsXml = await readTextIfExists(settingsPath)
  if (settingsXml) await writeFile(settingsPath, removeTrackRevisionsSetting(settingsXml))
}

async function scrubDocumentMetadataPackageParts(root: string) {
  const wordDir = path.join(root, "word")
  const storyFiles = (await listFiles(wordDir)).filter((file) => /\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file))
  for (const file of storyFiles) {
    await writeFile(file, stripRsidAttributes(await readTextIfExists(file)))
  }
  const corePath = path.join(root, "docProps", "core.xml")
  const coreXml = await readTextIfExists(corePath)
  if (coreXml) await writeFile(corePath, scrubCoreProperties(coreXml))
  await rm(path.join(root, "docProps", "custom.xml"), { force: true }).catch(() => undefined)
  await writeFile(path.join(root, "_rels", ".rels"), stripCustomPropertiesRelationships(await readTextIfExists(path.join(root, "_rels", ".rels"))))
  await writeFile(path.join(root, "[Content_Types].xml"), stripCustomPropertiesContentTypes(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
}

async function redactPackageParts(root: string, operations: Array<Extract<DocumentEditOperation, { type: "redactText" }>>): Promise<RedactionAudit> {
  const wordDir = path.join(root, "word")
  const includeComments = operations.some((operation) => operation.includeComments)
  const partPattern = includeComments
    ? /\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/
    : /\/word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/
  const storyFiles = (await listFiles(wordDir)).filter((file) => partPattern.test(file))
  const rules = compileRedactionRules(operations)
  const audit = emptyRedactionAudit()
  for (const file of storyFiles) {
    const result = redactXmlTextNodes(await readTextIfExists(file), rules)
    mergeRedactionAudit(audit, result.audit)
    if (result.xml !== await readTextIfExists(file)) {
      audit.touchedParts += 1
      await writeFile(file, result.xml)
    }
  }
  return audit
}

async function readTextIfExists(file: string) {
  return await readFile(file, "utf8").catch(() => "")
}

async function ensureInsertListNumberingPackageParts(root: string): Promise<InsertListNumberingIds> {
  const wordDir = path.join(root, "word")
  await mkdir(wordDir, { recursive: true })
  const numberingPath = path.join(wordDir, "numbering.xml")
  const existing = await readTextIfExists(numberingPath)
  await writeFile(path.join(root, "[Content_Types].xml"), ensureNumberingContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  await mkdir(path.join(wordDir, "_rels"), { recursive: true })
  await writeFile(path.join(wordDir, "_rels", "document.xml.rels"), ensureNumberingRelationship(await readTextIfExists(path.join(wordDir, "_rels", "document.xml.rels"))))
  if (!existing.trim()) {
    await writeFile(numberingPath, numberingXml())
    return { bullet: 1, numbered: 2, checklistUnchecked: 3, checklistChecked: 4 }
  }
  let xml = existing
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    xml = xml.replace("<w:numbering", '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')
  }
  const nextAbstractNumId = nextNumericXmlId(xml, /<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"/g, 1)
  const nextNumId = nextNumericXmlId(xml, /<w:num\b[^>]*\bw:numId="(\d+)"/g, 1)
  const ids = {
    bullet: nextNumId,
    numbered: nextNumId + 1,
    checklistUnchecked: nextNumId + 2,
    checklistChecked: nextNumId + 3,
  }
  const additions = [
    abstractNumberingXml(nextAbstractNumId, [
      { format: "bullet", text: "•" },
      { format: "bullet", text: "◦" },
      { format: "bullet", text: "▪" },
    ]),
    abstractNumberingXml(nextAbstractNumId + 1, [
      { format: "decimal", text: "%1." },
      { format: "decimal", text: "%1.%2." },
      { format: "decimal", text: "%1.%2.%3." },
    ]),
    abstractNumberingXml(nextAbstractNumId + 2, [
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☐", font: "Segoe UI Symbol" },
    ]),
    abstractNumberingXml(nextAbstractNumId + 3, [
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
      { format: "bullet", text: "☑", font: "Segoe UI Symbol" },
    ]),
    `<w:num w:numId="${ids.bullet}"><w:abstractNumId w:val="${nextAbstractNumId}"/></w:num>`,
    `<w:num w:numId="${ids.numbered}"><w:abstractNumId w:val="${nextAbstractNumId + 1}"/></w:num>`,
    `<w:num w:numId="${ids.checklistUnchecked}"><w:abstractNumId w:val="${nextAbstractNumId + 2}"/></w:num>`,
    `<w:num w:numId="${ids.checklistChecked}"><w:abstractNumId w:val="${nextAbstractNumId + 3}"/></w:num>`,
  ].join("")
  xml = xml.includes("</w:numbering>") ? xml.replace("</w:numbering>", `${additions}</w:numbering>`) : `${xml}${additions}`
  await writeFile(numberingPath, xml)
  return ids
}

async function insertFigurePackageParts(root: string, documentXml: string, figures: FigureSpec[]): Promise<InsertedFigureBuildItem[]> {
  const wordDir = path.join(root, "word")
  const mediaDir = path.join(wordDir, "media")
  const relsDir = path.join(wordDir, "_rels")
  await mkdir(mediaDir, { recursive: true })
  await mkdir(relsDir, { recursive: true })
  const relsPath = path.join(relsDir, "document.xml.rels")
  let relsXml = ensureDocumentRelationships(await readTextIfExists(relsPath))
  const existingMediaFiles = await readdir(mediaDir).catch(() => [] as string[])
  let nextImageNumber = Math.max(
    1,
    nextNumericXmlId(relsXml, /\bTarget="media\/image(\d+)\.png"/g, 1),
    ...existingMediaFiles.map((file) => Number(file.match(/^image(\d+)\.png$/)?.[1] ?? 0) + 1),
  )
  let nextDocPrId = Math.max(1, nextNumericXmlId(documentXml, /\b(?:wp:docPr|pic:cNvPr)\b[^>]*\bid="(\d+)"/g, 1))
  let nextBookmarkId = Math.max(1000, nextNumericXmlId(documentXml, /<w:bookmarkStart\b[^>]*\bw:id="(\d+)"/g, 1000))
  const items: InsertedFigureBuildItem[] = []
  for (const figure of figures) {
    const bytes = figureBytes(figure)
    const imageNumber = nextImageNumber++
    const relId = nextRelationshipId(relsXml, "rIdChipMateImage")
    const target = `media/image${imageNumber}.png`
    const mediaPath = `word/${target}`
    await writeFile(path.join(root, mediaPath), bytes)
    relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${xmlAttr(relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${xmlAttr(target)}"/></Relationships>`)
    items.push({
      figure,
      relId,
      target,
      mediaPath,
      width: positivePixelDimension(figure.image.width),
      height: positivePixelDimension(figure.image.height),
      docPrId: nextDocPrId++,
      bookmarkId: nextBookmarkId++,
    })
  }
  await writeFile(relsPath, relsXml)
  await writeFile(path.join(root, "[Content_Types].xml"), ensurePngContentType(await readTextIfExists(path.join(root, "[Content_Types].xml"))))
  return items
}

function figureBytes(figure: FigureSpec) {
  if (figure.image.contentType !== "image/png") throw new Error(`Unsupported figure content type: ${figure.image.contentType}`)
  const bytes = figure.image.bytes?.length ? figure.image.bytes : figure.image.base64?.trim() ? Uint8Array.from(Buffer.from(figure.image.base64, "base64")) : undefined
  if (!bytes?.length) throw new Error(`Figure "${figure.title}" is missing PNG bytes.`)
  if (!isPngBytes(bytes)) throw new Error(`Figure "${figure.title}" is not a valid PNG byte stream.`)
  return bytes
}

function isPngBytes(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
}

function positivePixelDimension(value: number) {
  return Math.max(1, Math.min(8000, Math.round(Number.isFinite(value) ? value : 1)))
}

function nextNumericXmlId(xml: string, pattern: RegExp, fallback: number) {
  let max = fallback - 1
  for (const match of xml.matchAll(pattern)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) max = Math.max(max, value)
  }
  return max + 1
}

function nextRelationshipId(xml: string, prefix: string) {
  const used = new Set(Array.from(xml.matchAll(/\bId="([^"]+)"/g)).map((match) => match[1]))
  let index = 1
  while (used.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function ensureDocumentFallbacks(documentXml: string) {
  let xml = documentXml
  xml = ensureDocumentNamespace(xml, "r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
  xml = ensureDocumentNamespace(xml, "wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing")
  xml = ensureDocumentNamespace(xml, "a", "http://schemas.openxmlformats.org/drawingml/2006/main")
  xml = ensureDocumentNamespace(xml, "pic", "http://schemas.openxmlformats.org/drawingml/2006/picture")
  xml = ensureFixedTables(xml)
  if (!/<w:sectPr\b/.test(xml)) xml = xml.replace("</w:body>", `${sectionPropertiesXml()}</w:body>`)
  if (!/<w:headerReference\b/.test(xml)) xml = xml.replace(/<w:sectPr\b([^>]*)>/, '<w:sectPr$1><w:headerReference w:type="default" r:id="rIdChipMateHeader"/>')
  if (!/<w:footerReference\b/.test(xml)) xml = xml.replace(/<w:sectPr\b([^>]*)>/, '<w:sectPr$1><w:footerReference w:type="default" r:id="rIdChipMateFooter"/>')
  return xml
}

function ensureDocumentNamespace(xml: string, prefix: string, uri: string) {
  if (xml.includes(`xmlns:${prefix}="${uri}"`)) return xml
  return xml.replace("<w:document ", `<w:document xmlns:${prefix}="${uri}" `)
}

function ensureFixedTables(documentXml: string) {
  return documentXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) => {
    if (/<w:tblGrid>/.test(table) && /<w:tblLayout[^>]*w:type="fixed"/.test(table)) return table
    const rows = tableRows(table)
    const columnCount = Math.max(1, ...rows.map((row) => row.length))
    const widths = distributeWidth(columnCount)
    let next = table
    if (!/<w:tblPr>/.test(next)) next = next.replace("<w:tbl>", `<w:tbl><w:tblPr>${tableWidthXml(widths)}<w:tblLayout w:type="fixed"/></w:tblPr>`)
    else next = next.replace(/<w:tblPr\b[^>]*>/, (tag) => `${tag}${/<w:tblW\b/.test(next) ? "" : tableWidthXml(widths)}${/<w:tblLayout\b/.test(next) ? "" : '<w:tblLayout w:type="fixed"/>'}`)
    if (!/<w:tblGrid>/.test(next)) next = next.replace(/<\/w:tblPr>/, `</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`)
    return next.replace(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/g, (tcPr) => /<w:tcW\b/.test(tcPr) ? tcPr : tcPr.replace("<w:tcPr>", `<w:tcPr><w:tcW w:w="${widths[0] ?? 2200}" w:type="dxa"/>`))
  })
}

function tableWarnings(documentXml: string) {
  const warnings: QualityIssue[] = []
  const tables = documentXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? []
  for (const table of tables) {
    if (!/<w:tblGrid>/.test(table) || !/<w:tblLayout[^>]*w:type="fixed"/.test(table)) warnings.push(issue("warning", "table-overflow-risk", "A table is missing fixed layout/grid and may render compressed."))
    if (tableRows(table).some((row) => row.some((cell) => cell.length > 280))) warnings.push(issue("warning", "table-overflow-risk", "A table cell contains long text and may overflow; repair may adjust table geometry."))
  }
  return uniqueIssues(warnings)
}

function repairableIssues(issues: QualityIssue[]) {
  return issues.filter((item) => item.severity === "warning" && ["toc-placeholder", "table-overflow-risk", "missing-header", "missing-footer"].includes(item.code))
}

function paragraphXml(text: string, styleId: string, alignment?: "center" | "right") {
  const alignmentXml = alignment ? `<w:jc w:val="${alignment}"/>` : ""
  return `<w:p><w:pPr><w:pStyle w:val="${xmlAttr(styleId)}"/>${alignmentXml}</w:pPr><w:r>${textRuns(text)}</w:r></w:p>`
}

function tableXml(spec: TableSpec) {
  const widths = distributeWidth(Math.max(1, spec.headers.length))
  const rows = [
    tableRowXml(spec.headers, widths),
    tableBodyRowsXml(spec, widths),
  ].join("")
  return `<w:tbl><w:tblPr>${tablePropertiesXml(widths)}</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`
}

function tableBodyRowsXml(spec: TableSpec, widths: number[]) {
  const activeRowSpans = new Map<number, { remaining: number; colSpan: number }>()
  return spec.rows.map((row) => {
    const cells: string[] = []
    let rowCellIndex = 0
    for (let columnIndex = 0; columnIndex < widths.length;) {
      const active = activeRowSpans.get(columnIndex)
      if (active) {
        cells.push(tableCellContentXml(paragraphXml(" ", "Normal"), sumNumbers(widths.slice(columnIndex, columnIndex + active.colSpan)), undefined, { gridSpan: active.colSpan, vMerge: "continue" }))
        active.remaining -= 1
        if (active.remaining <= 0) activeRowSpans.delete(columnIndex)
        columnIndex += active.colSpan
        continue
      }
      const rawCell = row[rowCellIndex++]
      const colSpan = Math.min(tableCellColSpan(rawCell), widths.length - columnIndex)
      const rowSpan = tableCellRowSpan(rawCell)
      if (rowSpan > 1) activeRowSpans.set(columnIndex, { remaining: rowSpan - 1, colSpan })
      const alignment = tableCellAlignment(rawCell) ?? spec.columnAlignments?.[columnIndex]
      cells.push(tableCellContentXml(
        paragraphXml(tableCellText(rawCell) || " ", "Normal", alignment === "center" || alignment === "right" ? alignment : undefined),
        sumNumbers(widths.slice(columnIndex, columnIndex + colSpan)),
        undefined,
        { gridSpan: colSpan, vMerge: rowSpan > 1 ? "restart" : undefined },
      ))
      columnIndex += colSpan
    }
    return `<w:tr>${cells.join("")}</w:tr>`
  }).join("")
}

function calloutXml(spec: CalloutSpec) {
  const widths = distributeWidth(1)
  const fill = spec.kind === "warning" ? "FFF4CE" : spec.kind === "risk" ? "FDE7E9" : spec.kind === "success" ? "DFF6DD" : "EAF4FF"
  const rows = [
    tableRowXml([spec.title], widths, { fill, styleId: "Heading3" }),
    tableRowXml([spec.body], widths, { fill, styleId: "Normal" }),
  ].join("")
  return `<w:tbl><w:tblPr>${tablePropertiesXml(widths)}</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`
}

function briefCardsXml(spec: BriefCardsSpec) {
  const cards = (spec.cards ?? []).filter((card) => card.title?.trim())
  if (!cards.length) return ""
  const columns = briefCardColumns(spec.columns, cards.length)
  const widths = distributeWidth(columns)
  const rows: string[] = []
  for (let index = 0; index < cards.length; index += columns) {
    const rowCards = cards.slice(index, index + columns)
    const cells = rowCards.map((card, cellIndex) => briefCardCellXml(card, widths[cellIndex] ?? widths[0]))
    while (cells.length < columns) cells.push(tableCellContentXml(paragraphXml(" ", "Normal"), widths[cells.length] ?? widths[0]))
    rows.push(`<w:tr>${cells.join("")}</w:tr>`)
  }
  return `<w:tbl><w:tblPr>${tablePropertiesXml(widths)}</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`
}

function briefCardColumns(columns: BriefCardsSpec["columns"], cardCount: number) {
  if (columns === 1 || columns === 2 || columns === 3) return columns
  if (cardCount === 1) return 1
  return cardCount >= 3 ? 3 : 2
}

function briefCardCellXml(card: BriefCardSpec, width: number) {
  const content = [
    paragraphXml(card.title, "Heading3"),
    card.value?.trim() ? paragraphXml(card.value.trim(), "Caption") : "",
    card.body?.trim() ? paragraphXml(card.body.trim(), "Normal") : "",
    card.footer?.trim() ? paragraphXml(card.footer.trim(), "Muted") : "",
  ].filter(Boolean).join("")
  return tableCellContentXml(content || paragraphXml(" ", "Normal"), width, briefCardFill(card))
}

function tableCellContentXml(contentXml: string, width: number, fill?: string, options: { gridSpan?: number; vMerge?: "restart" | "continue" } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${options.gridSpan && options.gridSpan > 1 ? `<w:gridSpan w:val="${options.gridSpan}"/>` : ""}${options.vMerge === "restart" ? '<w:vMerge w:val="restart"/>' : options.vMerge === "continue" ? "<w:vMerge/>" : ""}${fill ? `<w:shd w:fill="${xmlAttr(fill)}"/>` : ""}<w:vAlign w:val="center"/></w:tcPr>${contentXml}</w:tc>`
}

function sumNumbers(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0)
}

function briefCardFill(card: BriefCardSpec) {
  if (card.tone === "warning") return "FFF4CE"
  if (card.tone === "risk") return "FDE7E9"
  if (card.tone === "success") return "DFF6DD"
  if (card.tone === "info") return "EAF4FF"
  return "F8FAFC"
}

function evidenceCardsXml(spec: EvidenceCardsSpec) {
  const cards = (spec.cards ?? []).filter((card) => card.title?.trim() && card.summary?.trim())
  if (!cards.length) return ""
  const columns = evidenceCardColumns(spec.columns, cards.length)
  const widths = distributeWidth(columns)
  const rows: string[] = []
  for (let index = 0; index < cards.length; index += columns) {
    const rowCards = cards.slice(index, index + columns)
    const cells = rowCards.map((card, cellIndex) => evidenceCardCellXml(card, widths[cellIndex] ?? widths[0]))
    while (cells.length < columns) cells.push(tableCellContentXml(paragraphXml(" ", "Normal"), widths[cells.length] ?? widths[0]))
    rows.push(`<w:tr>${cells.join("")}</w:tr>`)
  }
  return `<w:tbl><w:tblPr>${tablePropertiesXml(widths)}</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`
}

function evidenceCardColumns(columns: EvidenceCardsSpec["columns"], cardCount: number) {
  if (columns === 1 || columns === 2) return columns
  return cardCount === 1 ? 1 : 2
}

function evidenceCardCellXml(card: EvidenceCardSpec, width: number) {
  const metadata = evidenceCardMetadata(card)
  const content = [
    paragraphXml(card.title, "Heading3"),
    paragraphXml(card.summary, "Normal"),
    card.quote?.trim() ? paragraphXml(card.quote.trim(), "Quote") : "",
    metadata ? paragraphXml(metadata, "Muted") : "",
  ].filter(Boolean).join("")
  return tableCellContentXml(content || paragraphXml(" ", "Normal"), width, evidenceCardFill(card))
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

function evidenceCardFill(card: EvidenceCardSpec) {
  if (card.role === "contradictory") return "FFF4CE"
  if (card.confidence === "low") return "FFF4CE"
  if (card.role === "primary") return "F0F7FF"
  return "F8FAFC"
}

function quoteBlockXml(spec: QuoteBlockSpec) {
  const text = spec.text?.trim()
  if (!text) return []
  const pullQuote = spec.kind === "pullQuote"
  const styleId = pullQuote ? "IntenseQuote" : "Quote"
  const alignment = pullQuote ? "center" as const : undefined
  const attribution = [spec.attribution, spec.source].filter((item): item is string => Boolean(item?.trim())).join(" - ")
  return [
    paragraphXml(text, styleId, alignment),
    attribution ? paragraphXml(`- ${attribution}`, "Muted", alignment) : "",
  ].filter(Boolean)
}

function codeBlockXml(spec: CodeBlockSpec) {
  const widths = distributeWidth(1)
  const caption = spec.caption?.trim() ? paragraphXml(spec.caption, "Caption") : ""
  const language = spec.language?.trim() ? `${spec.language.trim()}\n` : ""
  const rows = tableRowXml([`${language}${spec.code}`], widths, { fill: "F6F8FA", styleId: "CodeBlock" })
  return `${caption}<w:tbl><w:tblPr>${tablePropertiesXml(widths, false)}</w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`
}

function tableRowXml(cells: string[], widths: number[], options: { fill?: string; styleId?: string } = {}) {
  return `<w:tr>${cells.map((cell, index) => `<w:tc><w:tcPr><w:tcW w:w="${widths[index] ?? widths[0] ?? 2200}" w:type="dxa"/>${options.fill ? `<w:shd w:fill="${xmlAttr(options.fill)}"/>` : ""}</w:tcPr>${paragraphXml(cell, options.styleId ?? "Normal")}</w:tc>`).join("")}</w:tr>`
}

function textRuns(text: string) {
  return text.split(/\r?\n/).map((line, index) => `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlText(line)}</w:t>`).join("")
}

function deletedTextRuns(text: string) {
  return text.split(/\r?\n/).map((line, index) => `${index > 0 ? "<w:br/>" : ""}<w:delText xml:space="preserve">${xmlText(line)}</w:delText>`).join("")
}

function distributeWidth(columns: number) {
  const width = Math.floor(9000 / Math.max(1, columns))
  return Array.from({ length: Math.max(1, columns) }, () => width)
}

function tableWidthXml(widths: number[]) {
  return `<w:tblW w:w="${widths.reduce((sum, width) => sum + width, 0)}" w:type="dxa"/>`
}

function tablePropertiesXml(widths: number[], includeInsideBorders = true) {
  return [
    tableWidthXml(widths),
    tableBordersXml(includeInsideBorders),
    '<w:tblLayout w:type="fixed"/>',
  ].join("")
}

function tableBordersXml(includeInsideBorders: boolean) {
  return [
    '<w:tblBorders>',
    '<w:top w:val="single" w:sz="4" w:color="B8C2CC"/>',
    '<w:left w:val="single" w:sz="4" w:color="B8C2CC"/>',
    '<w:bottom w:val="single" w:sz="4" w:color="B8C2CC"/>',
    '<w:right w:val="single" w:sz="4" w:color="B8C2CC"/>',
    includeInsideBorders ? '<w:insideH w:val="single" w:sz="4" w:color="B8C2CC"/>' : "",
    includeInsideBorders ? '<w:insideV w:val="single" w:sz="4" w:color="B8C2CC"/>' : "",
    '</w:tblBorders>',
  ].join("")
}

const REQUIRED_STYLE_IDS = ["Normal", "Heading1", "Heading2", "Heading3", "Muted", "ListParagraph", "TableGrid", "CodeBlock", "Caption", "TOCStatic", "FootnoteText", "EndnoteText", "Quote", "IntenseQuote"]

function ensureStylesXml(input: string | undefined) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>'
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    xml = xml.replace("<w:styles", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')
  }
  const missing = REQUIRED_STYLE_IDS.filter((styleId) => !new RegExp(`w:styleId="${styleId}"`).test(xml))
  if (!missing.length) return xml
  const additions = missing.map(fallbackStyleXml).join("")
  return xml.includes("</w:styles>") ? xml.replace("</w:styles>", `${additions}</w:styles>`) : `${xml}${additions}`
}

function fallbackStyleXml(styleId: string) {
  const name = styleId === "Heading1" ? "heading 1" : styleId === "Heading2" ? "heading 2" : styleId === "Heading3" ? "heading 3" : styleId === "FootnoteText" ? "Footnote Text" : styleId === "EndnoteText" ? "Endnote Text" : styleId === "IntenseQuote" ? "Intense Quote" : styleId
  const isNoteStyle = styleId === "FootnoteText" || styleId === "EndnoteText"
  const size = styleId === "Heading1" ? 32 : styleId === "Heading2" ? 26 : styleId === "Heading3" ? 22 : styleId === "IntenseQuote" ? 26 : styleId === "CodeBlock" || isNoteStyle ? 18 : 21
  const bold = styleId.startsWith("Heading") || styleId === "Caption" || styleId === "IntenseQuote" ? "<w:b/>" : ""
  const italic = styleId === "Quote" || styleId === "IntenseQuote" ? "<w:i/>" : ""
  const color = styleId === "Muted" || styleId === "Quote" ? '<w:color w:val="6B7280"/>' : styleId === "IntenseQuote" ? '<w:color w:val="2563EB"/>' : ""
  const font = styleId === "CodeBlock" ? "Menlo" : "Arial"
  const outline = styleId === "Heading1" ? '<w:outlineLvl w:val="0"/>' : styleId === "Heading2" ? '<w:outlineLvl w:val="1"/>' : styleId === "Heading3" ? '<w:outlineLvl w:val="2"/>' : ""
  const defaultAttr = styleId === "Normal" ? ' w:default="1"' : ""
  return `<w:style w:type="paragraph" w:styleId="${styleId}"${defaultAttr}><w:name w:val="${name}"/><w:pPr><w:spacing w:before="80" w:after="80"/>${outline}</w:pPr><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="Microsoft YaHei"/>${bold}${italic}${color}<w:sz w:val="${size}"/></w:rPr></w:style>`
}

function ensureContentTypes(input: string | undefined) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  for (const item of [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
  ]) {
    const partName = item.match(/PartName="([^"]+)"/)?.[1]
    const extension = item.match(/Extension="([^"]+)"/)?.[1]
    if ((partName && !xml.includes(`PartName="${partName}"`)) || (extension && !xml.includes(`Extension="${extension}"`))) xml = xml.replace("</Types>", `${item}</Types>`)
  }
  return xml
}

function ensureCommentsContentType(input: string | undefined) {
  const item = '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
  let xml = ensureContentTypes(input)
  if (!xml.includes('PartName="/word/comments.xml"')) xml = xml.replace("</Types>", `${item}</Types>`)
  return xml
}

function ensureSettingsContentType(input: string | undefined) {
  const item = '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
  let xml = ensureContentTypes(input)
  if (!xml.includes('PartName="/word/settings.xml"')) xml = xml.replace("</Types>", `${item}</Types>`)
  return xml
}

function ensureNumberingContentType(input: string | undefined) {
  const item = '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  let xml = ensureContentTypes(input)
  if (!xml.includes('PartName="/word/numbering.xml"')) xml = xml.replace("</Types>", `${item}</Types>`)
  return xml
}

function ensurePngContentType(input: string | undefined) {
  const item = '<Default Extension="png" ContentType="image/png"/>'
  let xml = ensureContentTypes(input)
  if (!xml.includes('Extension="png"')) xml = xml.replace("</Types>", `${item}</Types>`)
  return xml
}

function ensureNotesContentType(input: string | undefined, kind: "footnote" | "endnote") {
  const part = kind === "endnote" ? "endnotes" : "footnotes"
  const item = `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part}+xml"/>`
  let xml = ensureContentTypes(input)
  if (!xml.includes(`PartName="/word/${part}.xml"`)) xml = xml.replace("</Types>", `${item}</Types>`)
  return xml
}

function ensurePackageRelationships(input: string | undefined) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  if (!xml.includes("officeDocument/2006/relationships/officeDocument")) {
    xml = xml.replace("</Relationships>", '<Relationship Id="rIdChipMateDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  }
  return xml
}

function ensureDocumentRelationships(input: string | undefined) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  for (const rel of [
    '<Relationship Id="rIdChipMateStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdChipMateHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdChipMateFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
  ]) {
    const type = rel.match(/Type="([^"]+)"/)?.[1]
    if (type && !xml.includes(type)) xml = xml.replace("</Relationships>", `${rel}</Relationships>`)
  }
  return xml
}

function ensureCommentsRelationship(input: string | undefined) {
  const rel = '<Relationship Id="rIdChipMateComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
  let xml = ensureDocumentRelationships(input)
  if (!xml.includes("officeDocument/2006/relationships/comments")) xml = xml.replace("</Relationships>", `${rel}</Relationships>`)
  return xml
}

function ensureSettingsRelationship(input: string | undefined) {
  const rel = '<Relationship Id="rIdChipMateSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
  let xml = ensureDocumentRelationships(input)
  if (!xml.includes("officeDocument/2006/relationships/settings")) xml = xml.replace("</Relationships>", `${rel}</Relationships>`)
  return xml
}

function ensureNumberingRelationship(input: string | undefined) {
  const rel = '<Relationship Id="rIdChipMateNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  let xml = ensureDocumentRelationships(input)
  if (!xml.includes("officeDocument/2006/relationships/numbering")) xml = xml.replace("</Relationships>", `${rel}</Relationships>`)
  return xml
}

function ensureNotesRelationship(input: string | undefined, kind: "footnote" | "endnote") {
  const part = kind === "endnote" ? "endnotes" : "footnotes"
  const id = kind === "endnote" ? "rIdChipMateEndnotes" : "rIdChipMateFootnotes"
  const rel = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${part}" Target="${part}.xml"/>`
  let xml = ensureDocumentRelationships(input)
  if (!xml.includes(`officeDocument/2006/relationships/${part}`)) xml = xml.replace("</Relationships>", `${rel}</Relationships>`)
  return xml
}

function ensureNotesXml(input: string | undefined, kind: "footnote" | "endnote") {
  const root = kind === "endnote" ? "endnotes" : "footnotes"
  const tag = kind === "endnote" ? "endnote" : "footnote"
  let xml = input?.trim() || [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
    `</w:${root}>`,
  ].join("")
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    xml = xml.replace(`<w:${root}`, `<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`)
  }
  if (!new RegExp(`<w:${tag}\\b(?=[^>]*\\bw:id="-1")`).test(xml)) {
    xml = xml.replace(`</w:${root}>`, `<w:${tag} w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}></w:${root}>`)
  }
  if (!new RegExp(`<w:${tag}\\b(?=[^>]*\\bw:id="0")`).test(xml)) {
    xml = xml.replace(`</w:${root}>`, `<w:${tag} w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}></w:${root}>`)
  }
  return xml
}

function appendNoteItemsXml(input: string, kind: "footnote" | "endnote", runs: ParagraphRunSpec[], noteMap: Map<ParagraphRunSpec, InsertedNoteBuildItem>) {
  const root = kind === "endnote" ? "endnotes" : "footnotes"
  let xml = input
  let nextId = nextNoteId(xml, kind)
  const additions: string[] = []
  for (const run of runs) {
    const text = run.note?.text?.trim()
    if (!text) continue
    const id = nextId++
    noteMap.set(run, { run, id, kind, text })
    additions.push(noteItemXml(kind, id, text))
  }
  if (!additions.length) return xml
  return xml.includes(`</w:${root}>`) ? xml.replace(`</w:${root}>`, `${additions.join("")}</w:${root}>`) : `${xml}${additions.join("")}`
}

function noteItemXml(kind: "footnote" | "endnote", id: number, text: string) {
  const tag = kind === "endnote" ? "endnote" : "footnote"
  return [
    `<w:${tag} w:id="${id}">`,
    noteParagraphsXml(undefined, kind, text),
    `</w:${tag}>`,
  ].join("")
}

function nextNoteId(xml: string, kind: "footnote" | "endnote") {
  const tag = kind === "endnote" ? "endnote" : "footnote"
  let max = 0
  for (const match of xml.matchAll(new RegExp(`<w:${tag}\\b[^>]*\\bw:id="(-?\\d+)"`, "g"))) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
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

function updateCommentResolvedXml(input: string, update: CommentResolutionUpdate) {
  const id = escapeRegExp(update.commentId)
  const pattern = new RegExp(`(<w:comment\\b(?=[^>]*\\bw:id="${id}")[^>]*)(>)`)
  if (!pattern.test(input)) throw new Error(`Comment ${update.commentId} not found in word/comments.xml.`)
  const date = new Date().toISOString()
  return input.replace(pattern, (_match, start: string, close: string) => {
    let tag = start as string
    tag = tag.replace(/\s+w:done="[^"]*"/g, "")
    if (update.resolved) tag += ' w:done="1"'
    if (/\s+w:date="[^"]*"/.test(tag)) tag = tag.replace(/\s+w:date="[^"]*"/, ` w:date="${xmlAttr(date)}"`)
    else tag += ` w:date="${xmlAttr(date)}"`
    return `${tag}${close}`
  })
}

function commentParaIdsByCommentId(commentsXml: string) {
  const result = new Map<string, string>()
  for (const match of commentsXml.matchAll(/<w:comment\b[\s\S]*?<\/w:comment>/g)) {
    const commentXml = match[0]
    const commentId = commentXmlAttrValue(commentXml, "id")
    const firstParagraph = commentXml.match(/<w:p\b[^>]*>/)?.[0]
    const paraId = firstParagraph ? commentXmlAttrValue(firstParagraph, "paraId") : undefined
    if (commentId && paraId) result.set(commentId, paraId)
  }
  return result
}

function updateCommentExtendedResolvedXml(input: string, paraId: string, resolved: boolean) {
  let found = false
  const next = input.replace(/<(?:[A-Za-z0-9_-]+:)?commentEx\b[^>]*\/?>/g, (tag) => {
    if (commentXmlAttrValue(tag, "paraId") !== paraId) return tag
    found = true
    let nextTag = tag.replace(/\s+(?:[A-Za-z0-9_-]+:)?done="[^"]*"/g, "")
    if (resolved) nextTag = setXmlTagAttribute(nextTag, "w15:done", "1")
    return nextTag
  })
  return found ? next : input
}

function commentXmlAttrValue(xml: string, name: string) {
  const match = xml.match(new RegExp(`\\b(?:[A-Za-z0-9_-]+:)?${escapeRegExp(name)}="([^"]*)"`))
  return match?.[1] ? decodeXmlText(match[1]) : undefined
}

function updateCommentTextXml(input: string, update: CommentTextUpdate) {
  let found = false
  const next = input.replace(/<w:comment\b[\s\S]*?<\/w:comment>/g, (commentXml) => {
    const currentId = commentXml.match(/\bw:id="([^"]*)"/)?.[1]
    if (found || currentId !== update.commentId) return commentXml
    found = true
    return rewriteCommentText(commentXml, update.text)
  })
  if (!found) throw new Error(`Comment ${update.commentId} not found in word/comments.xml.`)
  return next
}

function rewriteCommentText(commentXml: string, text: string) {
  const paragraph = commentXml.match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0]
  const body = commentXml.match(/^(<w:comment\b[^>]*>)[\s\S]*(<\/w:comment>)$/)
  const nextParagraphs = commentParagraphsXml(text, paragraph)
  if (body) return `${body[1]}${nextParagraphs}${body[2]}`
  return commentXml.replace("</w:comment>", `${nextParagraphs}</w:comment>`)
}

function commentParagraphsXml(text: string, existingParagraph?: string) {
  const pPr = existingParagraph?.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ""
  const textRun = existingParagraph?.match(/<w:r\b[\s\S]*?<w:t\b[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/)?.[0]
  const rPr = textRun?.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? ""
  return commentTextParagraphs(text)
    .map((paragraphText) => `<w:p>${pPr}<w:r>${rPr}${textRuns(paragraphText)}</w:r></w:p>`)
    .join("")
}

function commentTextParagraphs(text: string) {
  const paragraphs = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  return paragraphs.length ? paragraphs : [" "]
}

function stripCommentMarkup(input: string) {
  return input
    .replace(/<w:p\b[^>]*>\s*(?:<w:pPr\b[\s\S]*?<\/w:pPr>\s*)?<w:r\b[^>]*>\s*<w:commentReference\b[^>]*\/>\s*<\/w:r>\s*<\/w:p>/g, "")
    .replace(/<w:r\b[^>]*>[\s\S]*?<w:commentReference\b[^>]*\/>[\s\S]*?<\/w:r>/g, "")
    .replace(/<w:commentRangeStart\b[^>]*\/>/g, "")
    .replace(/<w:commentRangeEnd\b[^>]*\/>/g, "")
    .replace(/<w:commentReference\b[^>]*\/>/g, "")
}

function stripCommentsContentTypes(input: string | undefined) {
  return ensureContentTypes(input)
    .replace(/<Override\b[^>]*PartName="\/word\/comments(?:Extended|Ids)?\.xml"[^>]*\/>/g, "")
}

function stripCommentsRelationships(input: string | undefined) {
  return ensureDocumentRelationships(input)
    .replace(/<Relationship\b[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/comments"[^>]*\/>/g, "")
    .replace(/<Relationship\b[^>]*Type="http:\/\/schemas\.microsoft\.com\/office\/2011\/relationships\/commentsExtended"[^>]*\/>/g, "")
    .replace(/<Relationship\b[^>]*(?:Type="http:\/\/schemas\.microsoft\.com\/office\/2016\/09\/relationships\/commentsIds"[^>]*|Target="commentsIds\.xml"[^>]*)\/>/g, "")
}

function unsupportedTrackedFormattingRevisionTypes(documentXml: string) {
  return ["rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange"].filter((type) => new RegExp(`<w:${type}\\b`).test(documentXml))
}

function applyTrackedChangesXml(input: string, mode: "accept" | "reject") {
  const unsupported = unsupportedTrackedFormattingRevisionTypes(input)
  if (unsupported.length) {
    throw new Error(`${mode === "accept" ? "acceptAllTrackedChanges" : "rejectAllTrackedChanges"} cannot safely clean tracked formatting revisions: ${unsupported.join(", ")}.`)
  }
  if (mode === "accept") {
    return unwrapRevisionTag(
      unwrapRevisionTag(
        input
          .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
          .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, ""),
        "ins",
      ),
      "moveTo",
    )
  }
  return removeEmptyHyperlinks(delTextToText(
    unwrapRevisionTag(
      unwrapRevisionTag(
        input
          .replace(/<w:ins\b[\s\S]*?<\/w:ins>/g, "")
          .replace(/<w:moveTo\b[\s\S]*?<\/w:moveTo>/g, ""),
        "del",
      ),
      "moveFrom",
    ),
  ))
}

function unwrapRevisionTag(input: string, tag: string) {
  return input.replace(new RegExp(`<w:${tag}\\b[^>]*>([\\s\\S]*?)<\\/w:${tag}>`, "g"), "$1")
}

function delTextToText(input: string) {
  return input
    .replace(/<w:delText\b([^>]*)>/g, "<w:t$1>")
    .replace(/<\/w:delText>/g, "</w:t>")
}

function removeEmptyHyperlinks(input: string) {
  return input.replace(/<w:hyperlink\b[^>]*>\s*<\/w:hyperlink>/g, "")
}

function removeTrackRevisionsSetting(input: string) {
  return input
    .replace(/<w:trackRevisions\b[^>]*\/>/g, "")
    .replace(/<w:trackRevisions\b[^>]*>[\s\S]*?<\/w:trackRevisions>/g, "")
}

function stripRsidAttributes(input: string) {
  return input.replace(/\s+w:rsid[A-Za-z0-9]*="[^"]*"/g, "")
}

function scrubCoreProperties(input: string) {
  return input
    .replace(/<dc:creator\b([^>]*)>[\s\S]*?<\/dc:creator>/g, "<dc:creator$1></dc:creator>")
    .replace(/<cp:lastModifiedBy\b([^>]*)>[\s\S]*?<\/cp:lastModifiedBy>/g, "<cp:lastModifiedBy$1></cp:lastModifiedBy>")
}

function stripCustomPropertiesRelationships(input: string | undefined) {
  const xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  return xml.replace(/<Relationship\b[^>]*Target="[^"]*docProps\/custom\.xml"[^>]*\/>/g, "")
}

function stripCustomPropertiesContentTypes(input: string | undefined) {
  return ensureContentTypes(input).replace(/<Override\b[^>]*PartName="\/docProps\/custom\.xml"[^>]*\/>/g, "")
}

function redactXmlTextNodes(input: string, rules: RedactionRule[]) {
  const audit = emptyRedactionAudit()
  if (!rules.length) return { xml: input, audit }
  const xml = input.replace(/<w:(t|delText)\b([^>]*)>([\s\S]*?)<\/w:\1>/g, (_match, tagName: string, attrs: string, encodedText: string) => {
    const text = decodeXmlText(encodedText)
    const result = redactPlainText(text, rules)
    mergeRedactionAudit(audit, result.audit)
    if (result.text !== text) audit.touchedTextNodes += 1
    const redacted = result.text
    return `<w:${tagName}${attrs}>${xmlText(redacted)}</w:${tagName}>`
  })
  return { xml, audit }
}

type RedactionRule =
  | { kind: "exact"; text: string; replacement?: string; preserveLength?: boolean }
  | { kind: "pattern"; label: string; regex: RegExp; replacement?: string; preserveLength?: boolean }

function redactPlainText(input: string, rules: RedactionRule[]) {
  let output = input
  const audit = emptyRedactionAudit()
  for (const rule of rules) {
    if (rule.kind === "exact") {
      if (!rule.text) continue
      const parts = output.split(rule.text)
      const matches = parts.length - 1
      if (matches > 0) {
        audit.exactMatches += matches
        audit.totalMatches += matches
        output = parts.join(redactionReplacement(rule, rule.text))
      }
      continue
    }
    rule.regex.lastIndex = 0
    output = output.replace(rule.regex, (match: string) => {
      audit.patternMatches += 1
      audit.totalMatches += 1
      audit.patternLabels[rule.label] = (audit.patternLabels[rule.label] ?? 0) + 1
      return redactionReplacement(rule, match)
    })
  }
  return { text: output, audit }
}

function redactionReplacement(rule: { replacement?: string; preserveLength?: boolean }, matchedText: string) {
  const replacement = rule.replacement ?? "█"
  if (rule.preserveLength === false) return replacement
  return fitToLength(replacement, matchedText.length)
}

function fitToLength(input: string, length: number) {
  if (length <= 0) return ""
  const source = input || "█"
  return source.repeat(Math.ceil(length / source.length)).slice(0, length)
}

function compileRedactionRules(operations: Array<Extract<DocumentEditOperation, { type: "redactText" }>>) {
  const rules: RedactionRule[] = []
  for (const operation of operations) {
    for (const item of operation.items ?? []) rules.push({ kind: "exact", ...item })
    for (const pattern of operation.patterns ?? []) {
      const rule = compileRedactionPattern(pattern)
      if (rule) rules.push(rule)
    }
  }
  return rules
}

function compileRedactionPattern(pattern: RedactionPatternSpec): RedactionRule | undefined {
  const kind = pattern.kind ?? "custom"
  if (kind === "email") {
    return {
      kind: "pattern",
      label: pattern.label?.trim() || "email",
      regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      replacement: pattern.replacement,
      preserveLength: pattern.preserveLength,
    }
  }
  if (kind === "phone") {
    return {
      kind: "pattern",
      label: pattern.label?.trim() || "phone",
      regex: /\+?\d[\d\s().-]{6,}\d/g,
      replacement: pattern.replacement,
      preserveLength: pattern.preserveLength,
    }
  }
  if (!pattern.pattern?.trim()) return undefined
  return {
    kind: "pattern",
    label: pattern.label?.trim() || "custom",
    regex: new RegExp(pattern.pattern, uniqueRegexFlags(`${pattern.flags ?? ""}g`)),
    replacement: pattern.replacement,
    preserveLength: pattern.preserveLength,
  }
}

function uniqueRegexFlags(input: string) {
  return [...new Set(input.replace(/[^gimsu]/g, "").split(""))].join("")
}

function emptyRedactionAudit(): RedactionAudit {
  return {
    totalMatches: 0,
    exactMatches: 0,
    patternMatches: 0,
    touchedTextNodes: 0,
    touchedParts: 0,
    patternLabels: {},
  }
}

function mergeRedactionAudit(target: RedactionAudit, source: RedactionAudit) {
  target.totalMatches += source.totalMatches
  target.exactMatches += source.exactMatches
  target.patternMatches += source.patternMatches
  target.touchedTextNodes += source.touchedTextNodes
  for (const [label, count] of Object.entries(source.patternLabels)) {
    target.patternLabels[label] = (target.patternLabels[label] ?? 0) + count
  }
}

function formatRedactionAudit(audit: RedactionAudit) {
  const patternSummary = Object.entries(audit.patternLabels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `${label}:${count}`)
    .join(", ")
  return `package audit redacted ${audit.totalMatches} match(es) across ${audit.touchedParts} part(s), ${audit.touchedTextNodes} text node(s); exact=${audit.exactMatches}, pattern=${audit.patternMatches}${patternSummary ? ` (${patternSummary})` : ""}`
}

function ensureTrackRevisionsSettings(input: string | undefined) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>'
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    xml = xml.replace("<w:settings", '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')
  }
  if (!/<w:trackRevisions\b/.test(xml)) xml = xml.replace("</w:settings>", "<w:trackRevisions/></w:settings>")
  return xml
}

function setDocumentProtectionXml(input: string | undefined, update: DocumentProtectionUpdate) {
  let xml = input?.trim() || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>'
  if (!xml.includes('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')) {
    xml = xml.replace("<w:settings", '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"')
  }
  xml = xml
    .replace(/<w:documentProtection\b[^>]*\/>/g, "")
    .replace(/<w:documentProtection\b[^>]*>[\s\S]*?<\/w:documentProtection>/g, "")
  if (update.mode === "off") return xml
  const enforcement = update.enforce === false ? "0" : "1"
  return xml.replace("</w:settings>", `<w:documentProtection w:edit="${xmlAttr(update.mode)}" w:enforcement="${enforcement}" w:formatting="0"/></w:settings>`)
}

function appendCommentsXml(input: string | undefined, comments: CommentDraft[]) {
  const existing = input?.trim()
  const additions = comments.map(commentXml).join("")
  if (existing && existing.includes("</w:comments>")) return existing.replace("</w:comments>", `${additions}</w:comments>`)
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    additions,
    "</w:comments>",
  ].join("")
}

function commentXml(comment: CommentDraft) {
  return [
    `<w:comment w:id="${comment.id}" w:author="${xmlAttr(comment.author)}" w:initials="${xmlAttr(comment.initials)}" w:date="${xmlAttr(comment.date)}">`,
    commentParagraphsXml(comment.text),
    "</w:comment>",
  ].join("")
}

function fallbackHeaderXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>ChipMate Word Agent</w:t></w:r></w:p></w:hdr>'
}

function fallbackFooterXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Generated by ChipMate</w:t></w:r></w:p></w:ftr>'
}

function sectionPropertiesXml() {
  return '<w:sectPr><w:headerReference w:type="default" r:id="rIdChipMateHeader"/><w:footerReference w:type="default" r:id="rIdChipMateFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
}

function locatorMatches(locator: WordDocumentLocator, blockId: string) {
  return locator.blockId === blockId || locatorKey(locator).includes(`|${blockId}|`)
}

function strippedText(xml: string) {
  return xml.replace(/<[^>]+>/g, "").replace(/\s+/g, "")
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function uniqueIssues(issues: QualityIssue[]) {
  const seen = new Set<string>()
  return issues.filter((item) => {
    const key = `${item.severity}:${item.code}:${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function issue(severity: "error" | "warning", code: string, message: string): QualityIssue {
  return { severity, code, message }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function xmlText(input: string) {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function xmlAttr(input: string) {
  return xmlText(input).replace(/"/g, "&quot;")
}

function decodeXmlText(input: string) {
  return input
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function xmlAttrValueFromTag(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b(?:[A-Za-z0-9_-]+:)?${escapeRegExp(name)}="([^"]*)"`))
  return match?.[1] ? decodeXmlText(match[1]) : undefined
}

function removeXmlAttr(tag: string, name: string) {
  return tag.replace(new RegExp(`\\s+(?:[A-Za-z0-9_-]+:)?${escapeRegExp(name)}="[^"]*"`, "g"), "")
}

function setXmlAttr(tag: string, qualifiedName: string, value: string) {
  const bareName = qualifiedName.split(":").pop() || qualifiedName
  const replacement = ` ${qualifiedName}="${xmlAttr(value)}"`
  const pattern = new RegExp(`\\s+(?:[A-Za-z0-9_-]+:)?${escapeRegExp(bareName)}="[^"]*"`)
  if (pattern.test(tag)) return tag.replace(pattern, replacement)
  return tag.replace(/\/?>$/, (end) => `${replacement}${end}`)
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
