import type { ParsedDocumentBlockKind } from "../document-parser"

export type DocumentLanguage = "zh-CN" | "en-US"

export type SourceLocation = {
  path: string
  lineStart?: number
  lineEnd?: number
  headingPath?: string[]
  sourceRuleAnchor?: string
  sourceBlockId?: string
  blockIndex?: number
  sectionBlockIndex?: number
}

export type PreserveMode = "verbatim-short" | "paraphrased" | "summarized" | "adapted-example"

export type SourceBackedBlockKind = "paragraph" | "table" | "list" | "code" | "example" | "quote"

export type SourceOrigin = "internal_company" | "external_public" | "external_licensed" | "unknown"

export type SourceContentKind =
  | "core-rule"
  | "rule-matrix"
  | "example"
  | "implementation-guidance"
  | "risk-limit"
  | "reference"
  | "appendix-index"
  | "narrative"
  | "unknown"

export type OriginalBlockHash = {
  rawHash: string
  normalizedHash: string
}

export type SourceOriginClassification = {
  sourceId: string
  origin: SourceOrigin
  role: ReferenceDocRole
  confidence: number
  reason: string
  explicit: boolean
  warning?: string
}

export type SourceOriginClassifier = {
  classify(input: { question: string; documents: ReferenceDocument[] }): SourceOriginClassification[]
}

export type SourcePreservationDecision = {
  preserveMode: PreserveMode
  charLimit?: number
  wordLimit?: number
  allowVerbatim?: boolean
  warning?: string
  note?: string
}

export type SourcePreservationPolicy = {
  decide(input: {
    document: ReferenceDocument
    block: DocxReadBlock
    kind: SourceBackedBlockKind
    rawText: string
    normalizedText: string
  }): SourcePreservationDecision
}

export type SourceExcerpt = {
  sourceId: string
  sourceName?: string
  sourceTitle?: string
  sourcePath: string
  sourceRole?: ReferenceDocRole
  sourceOrigin?: SourceOrigin
  sourceRuleAnchor?: string
  headingPath: string[]
  sourceLocation: SourceLocation
  sourceBlockId?: string
  blockIndex?: number
  sectionBlockIndex?: number
  neighborTextPreview?: {
    previous?: string
    next?: string
  }
  originalBlockHash: OriginalBlockHash
}

export type PreservedBlock = {
  id: string
  kind: SourceBackedBlockKind
  title?: string
  text?: string
  items?: string[]
  table?: TableSpec
  code?: CodeBlockSpec
  source: SourceExcerpt
  preserveMode: PreserveMode
  warning?: string
}

export type SourceBackedBlock = {
  id: string
  kind: SourceBackedBlockKind
  contentKind?: SourceContentKind
  title?: string
  text?: string
  items?: string[]
  table?: TableSpec
  codeBlock?: CodeBlockSpec
  source: SourceExcerpt
  preserveMode: PreserveMode
  note?: string
}

export type DocxReadBlock = {
  id: string
  sourceBlockId: string
  blockIndex: number
  sectionBlockIndex: number
  kind: Extract<ParsedDocumentBlockKind, "heading" | "paragraph" | "list" | "table" | "note" | "text">
  text: string
  label?: string
  level?: 1 | 2 | 3
  headingPath: string[]
  neighborTextPreview?: {
    previous?: string
    next?: string
  }
  sourceLocation: SourceLocation
}

export type DocxReadResult = {
  metadata: {
    path: string
    title: string
    byteSize: number
    truncated: boolean
    readWarnings: string[]
  }
  blocks: DocxReadBlock[]
  textPreview: string
}

export type WordDocumentProtectionMode = "readOnly" | "comments" | "trackedChanges" | "forms"

export type WordDocumentLocatorKind = "paragraph" | "table" | "tableCell" | "comment" | "contentControl" | "watermark" | "note" | "image" | "caption" | "section" | "field" | "style" | "list" | "hyperlink" | "documentProtection" | "documentEnd"

export type WordDocumentLocator = {
  kind: WordDocumentLocatorKind
  blockId?: string
  commentId?: string
  contentControlIndex?: number
  contentControlTag?: string
  contentControlTitle?: string
  watermarkIndex?: number
  watermarkText?: string
  noteIndex?: number
  noteKind?: "footnote" | "endnote"
  noteId?: string
  imageIndex?: number
  imageRelId?: string
  imageTarget?: string
  captionIndex?: number
  captionKind?: WordCaptionKind
  captionLabel?: string
  sectionIndex?: number
  fieldIndex?: number
  fieldType?: string
  styleIndex?: number
  styleId?: string
  listIndex?: number
  listNumId?: string
  listLevel?: number
  hyperlinkIndex?: number
  hyperlinkRelId?: string
  hyperlinkAnchor?: string
  protectionMode?: WordDocumentProtectionMode
  tableIndex?: number
  rowIndex?: number
  cellIndex?: number
  headingPath?: string[]
  sourceLocation?: SourceLocation
  normalizedHash?: string
}

export type WordDocumentParagraphInspection = {
  id: string
  blockId: string
  paragraphIndex: number
  blockIndex: number
  text: string
  styleId?: string
  headingLevel?: 1 | 2 | 3
  list?: {
    listIndex?: number
    numId: string
    level: number
    kind?: WordListKind
  }
  headingPath: string[]
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentListInspection = {
  id: string
  blockId: string
  listIndex: number
  numId: string
  kind?: WordListKind
  levelCount: number
  itemCount: number
  items: Array<{
    paragraphId: string
    paragraphIndex: number
    blockIndex: number
    text: string
    level: number
  }>
  headingPath: string[]
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentTableInspection = {
  id: string
  blockId: string
  tableIndex: number
  blockIndex: number
  headingPath: string[]
  rows: string[][]
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentCommentInspection = {
  id: string
  commentId: string
  text: string
  author?: string
  initials?: string
  date?: string
  resolved: boolean
  resolvedSource?: "comment" | "commentsExtended" | "both" | "none"
  paraId?: string
  parentParaId?: string
  parentCommentId?: string
  durableId?: string
  commentsExtendedDone?: boolean
  anchorText?: string
  anchors: Array<{ part: string; text?: string }>
  locator: WordDocumentLocator
}

export type WordDocumentContentControlInspection = {
  id: string
  blockId: string
  contentControlIndex: number
  tag?: string
  title?: string
  text: string
  kind: "plainText" | "checkbox" | "dropdown" | "date" | "unknown"
  fillSupported: boolean
  fillUnsupportedReason?: "nested-content-control" | "rich-content-control" | "unsupported-content-control" | "complex-content-control"
  nestedControlCount: number
  hasRichContent: boolean
  checked?: boolean
  options?: string[]
  dateFormat?: string
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentWatermarkInspection = {
  id: string
  blockId: string
  watermarkIndex: number
  part: string
  kind: "vmlTextPath" | "vmlImageShape" | "drawingImageBackground"
  text: string
  relId?: string
  target?: string
  targetMode?: string
  relationshipMode?: "embedded" | "external" | "missing"
  mediaPath?: string
  mediaExtension?: string
  contentType?: string
  mediaExists?: boolean
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentNoteInspection = {
  id: string
  blockId: string
  noteIndex: number
  noteKind: "footnote" | "endnote"
  noteId: string
  part: string
  text: string
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentImageInspection = {
  id: string
  blockId: string
  imageIndex: number
  part: string
  placement?: "inline" | "floating" | "unknown"
  relId?: string
  target?: string
  targetMode?: string
  relationshipMode?: "embedded" | "external" | "missing"
  mediaPath?: string
  mediaExtension?: string
  contentType?: string
  mediaExists?: boolean
  name?: string
  altText?: string
  widthEmu?: number
  heightEmu?: number
  replaceSupported: boolean
  replaceUnsupportedReason?: string
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordCaptionKind = "figure" | "table" | "unknown"

export type WordDocumentCaptionInspection = {
  id: string
  blockId: string
  captionIndex: number
  captionKind: WordCaptionKind
  label?: string
  number?: string
  text: string
  fullText: string
  fieldInstruction?: string
  bookmark?: string
  paragraphId: string
  paragraphIndex: number
  blockIndex: number
  headingPath: string[]
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentSectionInspection = {
  id: string
  blockId: string
  sectionIndex: number
  part: string
  type?: string
  isFinal: boolean
  differentFirstPage: boolean
  oddEvenHeaders: boolean
  page: {
    widthTwips?: number
    heightTwips?: number
    orientation?: "portrait" | "landscape"
    margins?: {
      top?: number
      right?: number
      bottom?: number
      left?: number
      header?: number
      footer?: number
      gutter?: number
    }
  }
  headers: Array<{ type?: string; relId?: string }>
  footers: Array<{ type?: string; relId?: string }>
  headerFooterLinks: Array<{
    kind: "header" | "footer"
    type: "default" | "first" | "even"
    relId?: string
    hasReference: boolean
    linkedToPrevious: boolean
  }>
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentFieldInspection = {
  id: string
  blockId: string
  fieldIndex: number
  part: string
  fieldKind: "simple" | "complex"
  type: string
  instruction: string
  cachedText?: string
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentStyleInspection = {
  id: string
  blockId: string
  styleIndex: number
  part: string
  styleId: string
  type?: string
  name?: string
  basedOn?: string
  isDefault: boolean
  paragraphUseCount: number
  runUseCount: number
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentHyperlinkInspection = {
  id: string
  blockId: string
  hyperlinkIndex: number
  part: string
  text: string
  relId?: string
  target?: string
  anchor?: string
  tooltip?: string
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentProtectionInspection = {
  id: string
  blockId: string
  part: string
  mode: WordDocumentProtectionMode
  enforced: boolean
  formatting?: boolean
  sourceLocation: SourceLocation
  normalizedHash: string
  locator: WordDocumentLocator
}

export type WordDocumentInspection = {
  metadata: {
    path: string
    title: string
    byteSize: number
  }
  paragraphs: WordDocumentParagraphInspection[]
  tables: WordDocumentTableInspection[]
  lists: WordDocumentListInspection[]
  comments: WordDocumentCommentInspection[]
  contentControls: WordDocumentContentControlInspection[]
  watermarks: WordDocumentWatermarkInspection[]
  notes: WordDocumentNoteInspection[]
  images: WordDocumentImageInspection[]
  captions: WordDocumentCaptionInspection[]
  sections: WordDocumentSectionInspection[]
  fields: WordDocumentFieldInspection[]
  styles: WordDocumentStyleInspection[]
  hyperlinks: WordDocumentHyperlinkInspection[]
  protection?: WordDocumentProtectionInspection
  locators: WordDocumentLocator[]
  documentEndLocator: WordDocumentLocator
  summary: {
    paragraphCount: number
    tableCount: number
    listCount: number
    listItemCount: number
    commentCount: number
    contentControlCount: number
    watermarkCount: number
    noteCount: number
    footnoteCount: number
    endnoteCount: number
    imageCount: number
    captionCount: number
    sectionCount: number
    fieldCount: number
    fieldTypeCounts: Record<string, number>
    styleCount: number
    hyperlinkCount: number
    hasProtection: boolean
    protectionMode: WordDocumentProtectionMode | "off"
    trackedChangeCount: number
    trackedChangeTypeCounts: Record<string, number>
    advancedTrackedChangeWarnings: string[]
    headingCount: number
    hasHeader: boolean
    hasFooter: boolean
    hasStyles: boolean
    hasTocPlaceholder: boolean
  }
  warnings: string[]
}

export type InsertSectionBlockSpec =
  | {
      type: "paragraph"
      text: string
    }
  | {
      type: "richParagraph"
      paragraph: ParagraphSpec
    }
  | {
      type: "list"
      list: WordListSpec
    }
  | {
      type: "figure"
      figure: FigureSpec
    }
  | {
      type: "table"
      table: TableSpec
    }
  | {
      type: "callout"
      callout: CalloutSpec
    }
  | {
      type: "briefCards"
      briefCards: BriefCardsSpec
    }
  | {
      type: "evidenceCards"
      evidenceCards: EvidenceCardsSpec
    }
  | {
      type: "quoteBlock"
      quoteBlock: QuoteBlockSpec
    }
  | {
      type: "codeBlock"
      codeBlock: CodeBlockSpec
    }

export type OoxmlPartPatchSpec =
  | {
      action: "replace"
      oldText: string
      newText: string
      expectedOccurrences?: number
    }
  | {
      action: "insertBefore" | "insertAfter"
      anchor: string
      text: string
      expectedOccurrences?: number
    }
  | {
      action: "appendBeforeClose"
      closeTag: string
      text: string
      expectedOccurrences?: number
    }

export type DocumentEditOperation =
  | {
      type: "insertSection"
      locator: WordDocumentLocator
      title: string
      level?: 1 | 2 | 3
      paragraphs?: string[]
      richParagraphs?: ParagraphSpec[]
      tables?: TableSpec[]
      callouts?: CalloutSpec[]
      briefCards?: BriefCardSpec[]
      evidenceCards?: EvidenceCardSpec[]
      quoteBlocks?: QuoteBlockSpec[]
      codeBlocks?: CodeBlockSpec[]
      lists?: WordListSpec[]
      figures?: FigureSpec[]
      blocks?: InsertSectionBlockSpec[]
    }
  | {
      type: "replaceParagraph"
      locator: WordDocumentLocator
      text: string
    }
  | {
      type: "replaceParagraphWithRichParagraph"
      locator: WordDocumentLocator
      paragraph: ParagraphSpec
    }
  | {
      type: "replaceParagraphWithBlocks"
      locator: WordDocumentLocator
      blocks: InsertSectionBlockSpec[]
    }
  | {
      type: "replaceText"
      locator: WordDocumentLocator
      oldText: string
      newText: string
    }
  | {
      type: "replaceParagraphWithTrackedChange"
      locator: WordDocumentLocator
      text: string
      author?: string
    }
  | {
      type: "replaceParagraphWithRichTrackedChange"
      locator: WordDocumentLocator
      paragraph: ParagraphSpec
      author?: string
    }
  | {
      type: "replaceTextWithTrackedChange"
      locator: WordDocumentLocator
      oldText: string
      newText: string
      author?: string
    }
  | {
      type: "updateHeadingLevel"
      locator: WordDocumentLocator
      level: 1 | 2 | 3
    }
	  | {
	      type: "updateTable"
	      locator: WordDocumentLocator
	      text?: string
	      cellUpdates?: Array<{ rowIndex: number; cellIndex: number; text: string }>
	    }
	  | {
	      type: "updateTableWithTrackedChange"
	      locator: WordDocumentLocator
	      text: string
	      author?: string
	    }
	  | {
	      type: "replaceTable"
	      locator: WordDocumentLocator
	      table: TableSpec
	    }
	  | {
	      type: "updateTableHeaderRows"
	      locator: WordDocumentLocator
	      headerRowCount: number
	    }
  | {
      type: "updateList"
      locator: WordDocumentLocator
      items: Array<{ text: string; level?: 0 | 1 | 2 }>
    }
  | {
      type: "updateSectionPageSetup"
      locator: WordDocumentLocator
      page: {
        size?: "a4" | "letter"
        widthTwips?: number
        heightTwips?: number
        orientation?: "portrait" | "landscape"
        margins?: {
          top?: number
          right?: number
          bottom?: number
          left?: number
          header?: number
          footer?: number
          gutter?: number
        }
      }
    }
  | {
      type: "setDocumentProtection"
      locator: WordDocumentLocator
      mode: WordDocumentProtectionMode | "off"
      enforce?: boolean
    }
  | {
      type: "updateImageAltText"
      locator: WordDocumentLocator
      altText: string
      title?: string
    }
  | {
      type: "replaceImage"
      locator: WordDocumentLocator
      figure: FigureSpec
    }
  | {
      type: "updateCaptionText"
      locator: WordDocumentLocator
      caption: string
    }
	  | {
	      type: "updateHyperlinkText"
	      locator: WordDocumentLocator
	      text: string
	    }
	  | {
	      type: "updateHyperlinkTarget"
	      locator: WordDocumentLocator
	      url?: string
	      anchor?: string
	      tooltip?: string
	    }
	  | {
	      type: "updateNoteText"
	      locator: WordDocumentLocator
	      text: string
	    }
  | {
      type: "addComment"
      locator: WordDocumentLocator
      text: string
      author?: string
      initials?: string
    }
  | {
      type: "updateCommentText"
      locator: WordDocumentLocator
      text: string
    }
  | {
      type: "setCommentResolved"
      locator: WordDocumentLocator
      resolved: boolean
    }
  | {
      type: "fillContentControl"
      locator: WordDocumentLocator
      text: string
    }
  | {
      type: "addTextWatermark"
      locator: WordDocumentLocator
      text: string
    }
  | {
      type: "removeWatermark"
      locator: WordDocumentLocator
    }
  | {
      type: "removeAllComments"
      locator: WordDocumentLocator
    }
  | {
      type: "acceptAllTrackedChanges"
      locator: WordDocumentLocator
    }
  | {
      type: "rejectAllTrackedChanges"
      locator: WordDocumentLocator
    }
  | {
      type: "scrubDocumentMetadata"
      locator: WordDocumentLocator
    }
  | {
      type: "redactText"
      locator: WordDocumentLocator
      items?: RedactionExactItem[]
      patterns?: RedactionPatternSpec[]
      includeComments?: boolean
    }
  | {
      type: "patchOoxmlPart"
      locator: WordDocumentLocator
      part: string
      reason: string
      patches: OoxmlPartPatchSpec[]
      createIfMissing?: boolean
      initialXml?: string
    }

export type RedactionExactItem = {
  text: string
  replacement?: string
  preserveLength?: boolean
}

export type RedactionPatternSpec = {
  kind?: "email" | "phone" | "custom"
  pattern?: string
  flags?: string
  label?: string
  replacement?: string
  preserveLength?: boolean
}

export type DocumentEditPlan = {
  planId: string
  targetPath: string
  outputTitle?: string
  outputFilenameBase?: string
  operations: DocumentEditOperation[]
  warnings: string[]
}

export type DocumentEditPlanValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  plan?: DocumentEditPlan
}

export type WordEditStructureCheckResult = {
  ok: boolean
  issues: QualityIssue[]
}

export type WordEditRenderCheckResult = {
  attempted: boolean
  ok: boolean
  visualQaStatus?: "completed" | "skipped"
  skipReason?: "remote-unconfigured" | "remote-unavailable" | "remote-invalid-response" | "artifact-persist-failed"
  pdfPath?: string
  pdfArtifactPath?: string
  renderArtifactDir?: string
  pagePngPaths?: string[]
  absolutePagePngPaths?: string[]
  pageVisualSummaries?: WordRenderedPageVisualSummary[]
  pageCount?: number
  issues: QualityIssue[]
  sofficePath?: string
  pdfToPngPath?: string
  pdfToPngRenderer?: "pdftoppm" | "pdfjs-canvas"
  renderProvider?: "remote-opencode"
  remoteEndpoint?: string
  elapsedMs?: number
}

export type WordRenderedPageVisualSummary = {
  page: number
  path?: string
  absolutePath?: string
  width: number
  height: number
  totalPixels: number
  inkPixels: number
  inkRatio: number
  contentBounds?: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
  edgeInk: {
    top: boolean
    right: boolean
    bottom: boolean
    left: boolean
  }
  visualRegions?: WordRenderedPageRegionSummary[]
  inkComponents?: WordRenderedPageInkComponent[]
}

export type WordRenderedPageRegionSummary = {
  id: string
  row: "top" | "middle" | "bottom"
  column: "left" | "center" | "right"
  bounds: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
  inkPixels: number
  inkRatio: number
}

export type WordRenderedPageInkComponent = {
  id: string
  bounds: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
  inkPixels: number
  tileCount: number
  inkRatio: number
  pageArea: string
  edgeTouching: {
    top: boolean
    right: boolean
    bottom: boolean
    left: boolean
  }
  riskFlags: string[]
}

export type WordVisualQaVerdict = {
  status: "pass" | "needs-fix" | "blocked"
  inspectedPages: number[]
  evidence: Array<{
    page: number
    kind: "page-png" | "visual-summary" | "render-warning"
    path?: string
    finding: string
    severity: "info" | "warning" | "error"
  }>
  fixes?: Array<{
    target: "content" | "layout" | "table" | "figure" | "header-footer" | "field" | "unknown"
    action: string
  }>
  limitations: string[]
}

export type DocumentSkillRunSummary = {
  sourceDoc: string
  outputDoc?: string
  inspectSummary?: WordDocumentInspection["summary"]
  editPlan?: DocumentEditPlan
  appliedOperations: Array<{ type: DocumentEditOperation["type"]; locator: WordDocumentLocator; detail: string }>
  structureCheckResult?: WordEditStructureCheckResult
  renderCheckResult?: WordEditRenderCheckResult
  visualQaVerdict?: WordVisualQaVerdict
  repairAttempted: boolean
  warnings: string[]
  errors: string[]
}

export type ReferenceDocRole = "internal" | "external" | "unknown"

export type ReferenceDocument = {
  id: string
  role: ReferenceDocRole
  sourceOrigin: SourceOrigin
  sourceOriginConfidence?: number
  sourceOriginReason?: string
  sourceOriginWarning?: string
  sourceOriginExplicit?: boolean
  mentionIndex?: number
  read: DocxReadResult
}

export type ReferenceChunk = {
  id: string
  sourceId: string
  sourcePath: string
  role: ReferenceDocRole
  sourceOrigin?: SourceOrigin
  contentKind?: SourceContentKind
  sourceRuleAnchor?: string
  headingPath: string[]
  text: string
  sourceLocations: SourceLocation[]
}

export type RulePriority = "must" | "should" | "recommend"

export type CandidateRule = {
  id: string
  title: string
  category: string
  priority: RulePriority
  description: string
  recommended?: string
  discouraged?: string
  rationale?: string
  exceptions?: string
  sourceDocument: string
  sourceRole: ReferenceDocRole
  sourceOrigin?: SourceOrigin
  sourceContentKind?: SourceContentKind
  sourceRuleAnchor?: string
  sourceSection: string
  sourceLocation: SourceLocation
}

export type ConflictRule = {
  id: string
  title: string
  internal?: CandidateRule
  external?: CandidateRule
  recommendation: string
  decision?: ConflictResolutionDecision
}

export type ConflictResolutionChoice = "internal" | "external" | "review"

export type ConflictResolutionDecision = {
  conflictId: string
  choice: ConflictResolutionChoice
  note?: string
}

export type DocumentPlanDocumentType = "c-coding-guideline" | "generic-report"

export type DocumentPlanConflictPolicy = "ask" | "prefer_internal" | "prefer_external" | "keep_review"

export type DocumentPlanSectionPlacement = "front" | "before-rules" | "rules" | "after-rules" | "appendix"

export type DocumentPlanContentTarget = "document" | "section" | "rule-card" | "appendix"

export type DocumentPlanExampleStyle = "minimal" | "bad-good-pair" | "checklist" | "none"

export type DocumentPlanRuleOrderingPolicy = "internal-first" | "external-first" | "priority-first" | "by-category" | "model-planned"

export type DocumentPlanRuleSectioningPolicy = "single-section" | "split-by-source-role" | "split-by-priority" | "split-by-category"

export type DocumentPlanExternalRulePlacement = "main-body" | "appendix" | "reference-only"

export type DocumentPlan = {
  documentType: DocumentPlanDocumentType
  output: {
    title: string
    subtitle?: string
    filenameBase?: string
    language: DocumentLanguage
  }
  conflictPolicy: DocumentPlanConflictPolicy
  ruleOrderingPolicy: DocumentPlanRuleOrderingPolicy
  ruleSectioningPolicy: DocumentPlanRuleSectioningPolicy
  externalRulePlacement: DocumentPlanExternalRulePlacement
  sectionPlan: DocumentPlanSection[]
  ruleCardPolicy?: DocumentRuleCardPolicy
  contentRequirements: DocumentPlanContentRequirement[]
  sourcePolicy: {
    internalPriority: boolean
    externalVerbatimAllowed: boolean
    requireSourceTraceability: boolean
  }
  warnings: string[]
}

export type DocumentPlanSection = {
  id: string
  title: string
  purpose: string
  required: boolean
  placement: DocumentPlanSectionPlacement
}

export type DocumentRuleCardPolicy = {
  rewriteNamesForReadability: boolean
  rewriteScopesForReadability: boolean
  requireMinimalExamplePerRule: boolean
  includeBadExampleReason: boolean
  exampleStyle: DocumentPlanExampleStyle
  preserveInternalExamples: boolean
  adaptExternalExamples: boolean
}

export type DocumentPlanContentRequirement = {
  id: string
  instruction: string
  target: DocumentPlanContentTarget
  required: boolean
}

export type EvidencePack = {
  internalSummary: string[]
  externalSummary: string[]
  overlappingRules: CandidateRule[]
  conflictRules: ConflictRule[]
  conflictDecisions?: ConflictResolutionDecision[]
  externallyRecommendedRules: CandidateRule[]
  unsuitableExternalRules: CandidateRule[]
  candidateRules: CandidateRule[]
  sourceBackedBlocks: SourceBackedBlock[]
  warnings: string[]
}

export type RuleCardSpec = {
  ruleId: string
  name: string
  priority: "必须" | "应该" | "建议"
  scope: string
  description: string
  recommended?: string
  discouraged?: string
  rationale?: string
  exceptions?: string
  sources: string[]
  sourceRole?: ReferenceDocRole
  sourceOrigin?: SourceOrigin
  sourceRuleAnchor?: string
  sourceRoleReason?: string
  rolloutAdvice?: string
  sourceBackedBlocks?: SourceBackedBlock[]
  preservedExamples?: SourceBackedBlock[]
  generatedExamples?: GeneratedExampleSpec[]
  sourceDerivedItems?: SourceDerivedItemSpec[]
  exampleWarnings?: string[]
}

export type SourceDerivedItemSpec = {
  id: string
  label: string
  itemType: "rule-explanation" | "recommended" | "discouraged" | "rationale" | "exception" | "checklist"
  text: string
  sourceRefs: string[]
  sourceBlockIds: string[]
}

export type GeneratedExampleSpec = {
  id: string
  title: string
  language?: string
  exampleType?: string
  exampleFormat?: "code" | "file-layout" | "naming-pair" | "checklist" | "text"
  badExample?: string
  badExampleReason?: string
  goodExample?: string
  explanation: string
  sourceRefs: string[]
  generationMode: "adapted-from-source" | "model-generated-from-rule"
  origin: "generated" | "adapted"
  isVerbatim: false
  semanticIntent?: GeneratedExampleSemanticIntent
  validationNotes?: string[]
}

export type GeneratedExampleSemanticIntent = {
  summary: string
  objective: string
  mustInclude: string[]
  softHints?: string[]
  mustAvoid: string[]
  confidence: number
}

export type TableCellSpec = {
  text: string
  colSpan?: number
  rowSpan?: number
  alignment?: "left" | "center" | "right"
}

export type TableCellValue = string | TableCellSpec

export type TableSpec = {
  id?: string
  caption?: string
  label?: string
  number?: string
  bookmark?: string
  headers: string[]
  rows: TableCellValue[][]
  columnWidthRatios?: number[]
  columnAlignments?: Array<"left" | "center" | "right">
  repeatHeader?: boolean
}

export type CodeBlockSpec = {
  language?: string
  caption?: string
  code: string
}

export type CalloutSpec = {
  kind: "info" | "warning" | "risk" | "success"
  title: string
  body: string
}

export type BriefCardTone = "neutral" | "info" | "success" | "warning" | "risk"

export type BriefCardSpec = {
  title: string
  value?: string
  body?: string
  footer?: string
  tone?: BriefCardTone
}

export type BriefCardsSpec = {
  cards: BriefCardSpec[]
  columns?: 1 | 2 | 3
}

export type EvidenceCardRole = "primary" | "supporting" | "contradictory" | "background"

export type EvidenceCardConfidence = "high" | "medium" | "low"

export type EvidenceCardSpec = {
  title: string
  summary: string
  source?: string
  path?: string
  locator?: string
  quote?: string
  role?: EvidenceCardRole
  confidence?: EvidenceCardConfidence
  sourceRefs?: string[]
}

export type EvidenceCardsSpec = {
  cards: EvidenceCardSpec[]
  columns?: 1 | 2
}

export type QuoteBlockSpec = {
  kind?: "quote" | "pullQuote"
  text: string
  attribution?: string
  source?: string
}

export type FormFieldSpec = {
  id?: string
  label: string
  tag: string
  kind?: "plainText" | "checkbox" | "dropdown" | "date"
  placeholder?: string
  value?: string
  checked?: boolean
  options?: string[]
  dateFormat?: string
  helpText?: string
}

export type DefinitionListItemSpec = {
  term: string
  definition: string
  note?: string
}

export type SourceListItemSpec = {
  sourceId?: string
  title: string
  path?: string
  role?: ReferenceDocRole
  origin?: SourceOrigin
  note?: string
}

export type WordHyperlinkSpec = {
  url?: string
  anchor?: string
  tooltip?: string
}

export type WordCrossReferenceSpec = {
  bookmark: string
  field?: "REF" | "PAGEREF"
  fallbackText?: string
}

export type WordNoteSpec = {
  kind?: "footnote" | "endnote"
  text: string
}

export type ParagraphRunSpec = {
  text?: string
  bold?: boolean
  italic?: boolean
  hyperlink?: WordHyperlinkSpec
  reference?: WordCrossReferenceSpec
  note?: WordNoteSpec
}

export type ParagraphSpec = {
  runs: ParagraphRunSpec[]
  style?: "body" | "muted"
  alignment?: "left" | "center" | "right"
}

export type WordListKind = "bullet" | "numbered" | "checklist"

export type WordListItemSpec = {
  text: string
  level?: 0 | 1 | 2
  checked?: boolean
  children?: WordListItemSpec[]
}

export type WordListSpec = {
  kind: WordListKind
  title?: string
  items: WordListItemSpec[]
}

export type SourceRef = {
  id: string
  title: string
  path?: string
  role?: ReferenceDocRole
  origin?: SourceOrigin
}

export type WordDesignPreset =
  | "google_docs_default"
  | "standard_business_brief"
  | "compact_reference_guide"
  | "narrative_proposal"

export type WordPresetAlias =
  | "rfi_response"
  | "decision_memo"
  | "launch_messaging_guide"
  | "contract_negotiation_brief"
  | "neighborhood_business_proposal"
  | "grant_proposal"

export type WordHeaderPattern =
  | "none"
  | "memo_masthead"
  | "proposal_centerpiece"
  | "editorial_cover"
  | "customer_pack"
  | "workshop_agenda"
  | "customer_story"

export type WordContentFormFactor =
  | "prose-section"
  | "lead-callout"
  | "numbered-steps"
  | "grouped-bullets"
  | "checklist"
  | "note-box"
  | "definition-list"
  | "table"
  | "form-layout"
  | "source-list"

export type WordPageSize = "letter" | "a4"

export type WordDocLayoutSpec = {
  preset?: WordDesignPreset
  presetAlias?: WordPresetAlias
  headerPattern?: WordHeaderPattern
  overrides?: Array<{
    role: string
    reason: string
    tokenChanges: Record<string, unknown>
  }>
  page?: {
    size?: WordPageSize
    marginTwips?: Partial<{ top: number; right: number; bottom: number; left: number }>
  }
  navigation?: {
    mode?: "field-toc" | "static-toc" | "none"
    includeTopBottomLinks?: boolean
    includeBackToTocLinks?: boolean
  }
  headingLadder?: Array<{ level: 1 | 2 | 3; role: string; guidance?: string }>
  formFactors?: Array<{ sectionId: string; factor: WordContentFormFactor; reason?: string }>
  tablePolicy?: {
    useTablesOnlyForComparableRecords?: boolean
    avoidProseHeavyTables?: boolean
    requireExplicitGeometry?: boolean
  }
  visualQa?: {
    requireRender?: boolean
    requirePagePngReview?: boolean
  }
}

export type FigureSpec = {
  id?: string
  title: string
  caption?: string
  label?: string
  number?: string
  bookmark?: string
  altText?: string
	  image: {
	    contentType: "image/png"
	    bytes?: Uint8Array
	    base64?: string
	    path?: string
	    artifactPath?: string
	    width: number
	    height: number
	  }
	}

export type DocumentSection = {
  id: string
  level: 1 | 2 | 3
  title: string
  bookmark?: string
  formFactor?: WordContentFormFactor
  paragraphs?: string[]
  richParagraphs?: ParagraphSpec[]
  bullets?: string[]
  numberedItems?: string[]
  lists?: WordListSpec[]
  definitionList?: DefinitionListItemSpec[]
  sourceList?: SourceListItemSpec[]
  figures?: FigureSpec[]
  tables?: TableSpec[]
  codeBlocks?: CodeBlockSpec[]
  callouts?: CalloutSpec[]
  briefCards?: BriefCardSpec[]
  evidenceCards?: EvidenceCardSpec[]
  quoteBlocks?: QuoteBlockSpec[]
  formFields?: FormFieldSpec[]
  ruleCards?: RuleCardSpec[]
  sourceBackedBlocks?: SourceBackedBlock[]
  sourceRefs?: string[]
}

export type WordDocSpec = {
  metadata: {
    title: string
    subtitle?: string
    documentType: string
    language: DocumentLanguage
    generatedAt: string
    author?: string
    sourceSummary?: string
  }
  layout?: WordDocLayoutSpec
  protection?: {
    mode: "readOnly" | "comments" | "trackedChanges" | "forms"
    enforce?: boolean
  }
  sources: SourceRef[]
  cover?: {
    title: string
    subtitle?: string
    preparedFor?: string
    preparedBy?: string
  }
  revisionHistory?: Array<{ version: string; date: string; author: string; summary: string }>
  executiveSummary?: { paragraphs: string[]; highlights?: string[] }
  sections: DocumentSection[]
  appendices?: DocumentSection[]
  references?: Array<{ sourceId: string; title: string; path?: string; note?: string }>
  qualityChecklist?: {
    assumptions: string[]
    limitations: string[]
    missingInputs: string[]
    risks: string[]
  }
}

export type QualityIssue = {
  severity: "error" | "warning"
  code: string
  message: string
}

export type DocumentAgentProgress =
  | { stage: "reading"; message: string; current?: number; total?: number }
  | { stage: "extracting"; message: string; current?: number; total?: number }
  | { stage: "merging"; message: string; current?: number; total?: number }
  | { stage: "rendering"; message: string }
  | { stage: "done"; message: string }

export type DocAgentTimelineEvent = {
  id: string
  type:
    | "run.started"
    | "plan"
    | "read_docx"
    | "source_classify"
    | "chunking"
    | "model.extract"
    | "fallback"
    | "evidence"
    | "conflict.review"
    | "merge"
    | "compose-draft"
    | "review-draft"
    | "revise-draft"
    | "word_spec"
    | "quality_gate"
    | "final-structural-gate"
    | "inspect_word_document"
    | "edit_plan"
    | "apply_word_document_edits"
    | "render_word_document"
    | "repair_word_document"
    | "create_word_document"
    | "done"
    | "error"
  title: string
  detail?: string
  status: "running" | "completed" | "warning" | "waiting" | "error"
  timelineKey?: string
  stateLabel?: string
  timestamp: number
  current?: number
  total?: number
  warning?: string
  path?: string
}

export type GeneratedDocumentResult = {
  path: string
  absolutePath: string
  title?: string
  designPreset?: WordDesignPreset
  sourceCount: number
  warningCount: number
  warnings: string[]
  errors: string[]
  structureIssues?: QualityIssue[]
  renderCheckResult?: WordEditRenderCheckResult
  runSummaryPath?: string
}

export type DocAgentModelRequest = {
  purpose: "plan-document" | "plan-source-roles" | "extract-rules" | "extract-rules-batch" | "merge-guidelines" | "normalize-rule-language" | "plan-source-block-placement" | "plan-rule-examples" | "compose-guideline-draft" | "review-guideline-draft" | "generate-word-spec" | "resolve-design-doc-targets"
  system: string
  prompt: string
}

export type DocAgentModelWaitEvent = {
  purpose: DocAgentModelRequest["purpose"]
  model: string
  stage: string
  elapsedMs: number
  warning?: string
}

export type DocAgentModelProvider = {
  cacheKey?(): string
  completeJson<T>(request: DocAgentModelRequest, signal?: AbortSignal): Promise<T>
}
