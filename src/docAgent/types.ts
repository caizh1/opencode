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

export type TableSpec = {
  caption?: string
  headers: string[]
  rows: string[][]
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

export type SourceRef = {
  id: string
  title: string
  path?: string
  role?: ReferenceDocRole
  origin?: SourceOrigin
}

export type DocumentSection = {
  id: string
  level: 1 | 2 | 3
  title: string
  paragraphs?: string[]
  bullets?: string[]
  numberedItems?: string[]
  tables?: TableSpec[]
  codeBlocks?: CodeBlockSpec[]
  callouts?: CalloutSpec[]
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
  sourceCount: number
  warningCount: number
  warnings: string[]
  errors: string[]
}

export type DocAgentModelRequest = {
  purpose: "plan-document" | "plan-source-roles" | "extract-rules" | "extract-rules-batch" | "merge-guidelines" | "normalize-rule-language" | "plan-source-block-placement" | "plan-rule-examples" | "compose-guideline-draft" | "review-guideline-draft" | "generate-word-spec"
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
