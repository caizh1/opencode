import { createHash } from "node:crypto"
import type { CompletionInsertMode, CompletionPlanKind } from "./completion-types"

export const COMPLETION_PLANNER_REVISION = "p2.12-current-function-scoped-context"

export type CompletionTelemetryRoute = "fim" | "instruction" | "deterministic-symbol" | "none"

export interface CompletionDebugEvent {
  requestId: string
  completionId?: string
  extensionVersion?: string
  plannerRevision?: string
  languageId: string
  filePathHash?: string
  triggerKind?: string

  planKind: CompletionPlanKind
  cIntent?: string
  insertMode: CompletionInsertMode
  currentWord?: string
  targetSymbol?: string
  sourceCommentHash?: string
  sourceCommentPreview?: string
  commentGuidedSkipReason?: string
  retrievalMode?: "none" | "graph-only" | "hybrid"
  evidenceKinds?: string[]
  evidenceDroppedReason?: string
  droppedEvidenceKinds?: string[]
  evidencePromptBlocks?: number
  evidencePromptTokens?: number
  evidencePromptKinds?: string[]
  cEmbeddedEvidenceTrace?: {
    ragFallbackTriggered: boolean
    ragFallbackReason?: string
    graphEvidenceCount: number
    ragEvidenceCount: number
    finalSelectedEvidenceCount: number
    minimumUsefulEvidenceMet: boolean
    normalizedCommentTokens?: string[]
    candidateTokenCoverage?: Array<{
      name?: string
      kind: string
      actionTokenCoverage: number
      objectTokenCoverage: number
      domainTokenCoverage: number
      matchedActionTokens: string[]
      matchedObjectTokens: string[]
      matchedDomainTokens: string[]
    }>
    semanticCandidateTopK?: Array<{
      name?: string
      kind: string
      score: number
      actionTokenCoverage?: number
      objectTokenCoverage?: number
      domainTokenCoverage?: number
    }>
    selectedSimilarFunctionNames?: string[]
    retrievalElapsedMs?: number
    retrievalBudgetMs?: number
    retrievalTimedOut?: boolean
    timeoutStage?: string
    qaAlignedEvidence?: boolean
    qaTopCandidate?: string
    completionTopCandidate?: string
    sharedTopCandidate?: string
    qaRetrievalTopK?: string[]
    completionRetrievalTopK?: string[]
    alignmentReason?: string
    rerankEnabled?: boolean
    ragAvailable?: boolean
    latencyBudgetMs?: number
    maxEvidence?: number
    evidenceRoles?: string[]
    generationModeHint?: string
    helperCallableConfidence?: string
    callableHelperCandidates?: string[]
    styleExampleCandidates?: string[]
    qaStyleTopK?: string[]
    completionProjectionTopK?: string[]
    droppedAlignedEvidence?: string[]
    cursorContextFeatures?: Record<string, unknown>
    cursorContextScope?: string
    currentFunctionBodyIsEmpty?: boolean
    scopedPreviousStatementCalls?: string[]
    scopedNextStatementCalls?: string[]
    cursorContextFallbackReason?: string
    fullRetrievalCandidateCount?: number
    projectionCandidateCount?: number
    retrievalShape?: string
    qaExactTopK?: string[]
    qaExactSubmittedEvidence?: string[]
    qaExactContextTopK?: string[]
    semanticQueryText?: string
    graphQuestionTextHash?: string
    semanticTopK?: string[]
    graphTopK?: string[]
    mergedTopK?: string[]
    selectedPromptEvidenceNames?: string[]
    rawSemanticTopK?: string[]
    rawGraphTopK?: string[]
    mergedRetrievalTopK?: string[]
    projectionTopK?: string[]
    projectedEvidenceNames?: string[]
    actualPromptEvidenceNames?: string[]
    droppedProjectedEvidenceNames?: string[]
    rawTop1Aligned?: boolean
    retrievalRecallAligned?: boolean
    projectionSelectedStrongHelper?: boolean
    promptContainsProjectedHelper?: boolean
    probeAffectsPrompt?: boolean
    probeCompleted?: boolean
    projectionToPromptDropReason?: string
    submittedEvidenceNames?: string[]
    expectedSymbolInQaExactRetrieval?: boolean
    expectedSymbolInFullRetrieval?: boolean
    expectedSymbolInProjection?: boolean
    expectedSymbolInPrompt?: boolean
    fullRetrievalProbeDumpPath?: string
    symbolPrefixRetrievalShape?: string
    symbolPrefixLocalTopK?: string[]
    symbolPrefixProjectedEvidenceNames?: string[]
    symbolPrefixDroppedTargetSymbols?: string[]
    typedPrefixCompatibleCandidates?: string[]
    typedPrefixCompatiblePromptNames?: string[]
    symbolPrefixSemanticQueryText?: string
    symbolPrefixSemanticTopK?: string[]
    symbolPrefixGraphTopK?: string[]
    symbolPrefixMergedTopK?: string[]
    symbolPrefixRerankTopK?: string[]
    symbolPrefixSemanticSelectedNames?: string[]
    symbolPrefixPrefixCompatibleNames?: string[]
    symbolPrefixSemanticVsPrefixDiverged?: boolean
    symbolPrefixSelectionReason?: string
    symbolPrefixCurrentFunctionTokens?: string[]
    symbolPrefixNonPrefixDroppedNames?: string[]
    symbolPrefixProjectionReasons?: Array<{
      name?: string
      reason: string
      prefixCompatible: boolean
      currentFunctionTokenScore: number
      projectionScore: number
    }>
    symbolPrefixCompatibilityScores?: Array<{
      name?: string
      prefixCompatible: boolean
      localFlowScore: number
      projectionScore: number
      broadUtility: boolean
    }>
  }
  normalizedCommentTokens?: string[]
  candidateTokenCoverage?: Array<{
    name?: string
    kind: string
    actionTokenCoverage: number
    objectTokenCoverage: number
    domainTokenCoverage: number
    matchedActionTokens: string[]
    matchedObjectTokens: string[]
    matchedDomainTokens: string[]
  }>
  semanticCandidateTopK?: Array<{
    name?: string
    kind: string
    score: number
    actionTokenCoverage?: number
    objectTokenCoverage?: number
    domainTokenCoverage?: number
  }>
  selectedSimilarFunctionNames?: string[]
  retrievalElapsedMs?: number
  retrievalBudgetMs?: number
  retrievalTimedOut?: boolean
  timeoutStage?: string
  qaAlignedEvidence?: boolean
  qaTopCandidate?: string
  completionTopCandidate?: string
  sharedTopCandidate?: string
  qaRetrievalTopK?: string[]
  completionRetrievalTopK?: string[]
  alignmentReason?: string
  rerankEnabled?: boolean
  ragAvailable?: boolean
  latencyBudgetMs?: number
  maxEvidence?: number
  evidenceRoles?: string[]
  generationModeHint?: string
  helperCallableConfidence?: string
  callableHelperCandidates?: string[]
  styleExampleCandidates?: string[]
  qaStyleTopK?: string[]
  completionProjectionTopK?: string[]
  droppedAlignedEvidence?: string[]
  cursorContextFeatures?: Record<string, unknown>
  cursorContextScope?: string
  currentFunctionBodyIsEmpty?: boolean
  scopedPreviousStatementCalls?: string[]
  scopedNextStatementCalls?: string[]
  cursorContextFallbackReason?: string
  fullRetrievalCandidateCount?: number
  projectionCandidateCount?: number
  retrievalShape?: string
  qaExactTopK?: string[]
  qaExactSubmittedEvidence?: string[]
  qaExactContextTopK?: string[]
  semanticQueryText?: string
  graphQuestionTextHash?: string
  semanticTopK?: string[]
  graphTopK?: string[]
  mergedTopK?: string[]
  selectedPromptEvidenceNames?: string[]
  rawSemanticTopK?: string[]
  rawGraphTopK?: string[]
  mergedRetrievalTopK?: string[]
  projectionTopK?: string[]
  projectedEvidenceNames?: string[]
  actualPromptEvidenceNames?: string[]
  droppedProjectedEvidenceNames?: string[]
  rawTop1Aligned?: boolean
  retrievalRecallAligned?: boolean
  projectionSelectedStrongHelper?: boolean
  promptContainsProjectedHelper?: boolean
  probeAffectsPrompt?: boolean
  probeCompleted?: boolean
  projectionToPromptDropReason?: string
  submittedEvidenceNames?: string[]
  expectedSymbolInQaExactRetrieval?: boolean
  expectedSymbolInFullRetrieval?: boolean
  expectedSymbolInProjection?: boolean
  expectedSymbolInPrompt?: boolean
  fullRetrievalProbeDumpPath?: string
  typedPrefixAdapted?: boolean
  typedPrefixAdaptReason?: string
  typedPrefixCurrentWord?: string
  typedPrefixMatchedSymbol?: string
  typedPrefixOriginalFirstLine?: string
  typedPrefixFinalFirstLine?: string
  deterministicSymbolSuppressed?: boolean
  deterministicSymbolSuppressReason?: string
  symbolPrefixCandidateTopK?: string[]
  symbolPrefixContextTokens?: number
  symbolPrefixRoute?: "fim" | "deterministic-symbol"
  symbolPrefixRetrievalShape?: string
  symbolPrefixLocalTopK?: string[]
  symbolPrefixProjectedEvidenceNames?: string[]
  symbolPrefixDroppedTargetSymbols?: string[]
  typedPrefixCompatibleCandidates?: string[]
  typedPrefixCompatiblePromptNames?: string[]
  symbolPrefixSemanticQueryText?: string
  symbolPrefixSemanticTopK?: string[]
  symbolPrefixGraphTopK?: string[]
  symbolPrefixMergedTopK?: string[]
  symbolPrefixRerankTopK?: string[]
  symbolPrefixSemanticSelectedNames?: string[]
  symbolPrefixPrefixCompatibleNames?: string[]
  symbolPrefixSemanticVsPrefixDiverged?: boolean
  symbolPrefixSelectionReason?: string
  symbolPrefixCurrentFunctionTokens?: string[]
  symbolPrefixNonPrefixDroppedNames?: string[]
  symbolPrefixProjectionReasons?: Array<{
    name?: string
    reason: string
    prefixCompatible: boolean
    currentFunctionTokenScore: number
    projectionScore: number
  }>
  symbolPrefixCompatibilityScores?: Array<{
    name?: string
    prefixCompatible: boolean
    localFlowScore: number
    projectionScore: number
    broadUtility: boolean
  }>
  contextLevel?: "none" | "light" | "standard" | "rich"
  contextWarnings?: string[]
  promptKind?: "qwen-fim" | "instruction" | "deterministic-symbol" | "none"

  symbolCandidates?: Array<{
    name: string
    kind: string
    score: number
    source: string
  }>

  selectedContextBlocks?: Array<{
    kind: string
    title: string
    tokenEstimate: number
    score: number
  }>

  droppedContextBlocks?: Array<{
    kind: string
    title: string
    reason: string
  }>

  modelRoute: CompletionTelemetryRoute
  rawOutputLength?: number
  normalizedOutputLength?: number
  trimReason?: string
  finalInsertLength?: number

  finalRange?: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  }

  filterText?: string
  accepted: boolean
  rejectReason?: string

  latencyMs: {
    planning?: number
    symbol?: number
    context?: number
    model?: number
    postprocess?: number
    edit?: number
    total: number
  }
}

export type CompletionTelemetryDraft = Partial<CompletionDebugEvent> & {
  requestId: string
  languageId: string
  planKind: CompletionPlanKind
  insertMode: CompletionInsertMode
  modelRoute: CompletionTelemetryRoute
  accepted: boolean
  latencyMs: CompletionDebugEvent["latencyMs"]
  fullRetrievalDebugDump?: unknown
}

export function createCompletionRequestId() {
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function filePathHash(path: string | undefined) {
  const normalized = (path ?? "").replace(/\\/g, "/")
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`
}

export function completionTelemetryRoute(route: { kind: "none" } | { kind: "deterministic-symbol" } | { kind: "model"; promptKind: "qwen-fim" | "instruction" } | undefined): CompletionTelemetryRoute {
  if (!route) return "none"
  if (route.kind === "none") return "none"
  if (route.kind === "deterministic-symbol") return "deterministic-symbol"
  return route.promptKind === "qwen-fim" ? "fim" : "instruction"
}

export function serializeCompletionDebugEvent(event: CompletionDebugEvent) {
  return `[completion-telemetry] ${JSON.stringify(sanitizeCompletionDebugEvent(event))}`
}

export function sanitizeCompletionDebugEvent(event: CompletionDebugEvent): CompletionDebugEvent {
  return {
    ...event,
    completionId: event.completionId ? truncateTelemetryText(event.completionId, 80) : undefined,
    extensionVersion: event.extensionVersion ? truncateTelemetryText(event.extensionVersion, 40) : undefined,
    plannerRevision: event.plannerRevision ? truncateTelemetryText(event.plannerRevision, 80) : undefined,
    cIntent: event.cIntent ? truncateTelemetryText(event.cIntent, 80) : undefined,
    currentWord: event.currentWord ? truncateTelemetryText(event.currentWord, 80) : undefined,
    targetSymbol: event.targetSymbol ? truncateTelemetryText(event.targetSymbol, 120) : undefined,
    sourceCommentHash: event.sourceCommentHash ? truncateTelemetryText(event.sourceCommentHash, 80) : undefined,
    sourceCommentPreview: event.sourceCommentPreview ? truncateTelemetryText(event.sourceCommentPreview, 160) : undefined,
    commentGuidedSkipReason: event.commentGuidedSkipReason ? truncateTelemetryText(event.commentGuidedSkipReason, 120) : undefined,
    evidenceKinds: event.evidenceKinds?.map((kind) => truncateTelemetryText(kind, 60)).slice(0, 16),
    evidenceDroppedReason: event.evidenceDroppedReason ? truncateTelemetryText(event.evidenceDroppedReason, 80) : undefined,
    droppedEvidenceKinds: event.droppedEvidenceKinds?.map((kind) => truncateTelemetryText(kind, 60)).slice(0, 16),
    evidencePromptBlocks: event.evidencePromptBlocks !== undefined ? finiteNumber(event.evidencePromptBlocks) : undefined,
    evidencePromptTokens: event.evidencePromptTokens !== undefined ? finiteNumber(event.evidencePromptTokens) : undefined,
    evidencePromptKinds: event.evidencePromptKinds?.map((kind) => truncateTelemetryText(kind, 60)).slice(0, 16),
    contextWarnings: event.contextWarnings?.map((warning) => truncateTelemetryText(warning, 80)).slice(0, 8),
    cEmbeddedEvidenceTrace: event.cEmbeddedEvidenceTrace ? {
      ragFallbackTriggered: Boolean(event.cEmbeddedEvidenceTrace.ragFallbackTriggered),
      ragFallbackReason: event.cEmbeddedEvidenceTrace.ragFallbackReason ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.ragFallbackReason, 180) : undefined,
      graphEvidenceCount: finiteNumber(event.cEmbeddedEvidenceTrace.graphEvidenceCount),
      ragEvidenceCount: finiteNumber(event.cEmbeddedEvidenceTrace.ragEvidenceCount),
      finalSelectedEvidenceCount: finiteNumber(event.cEmbeddedEvidenceTrace.finalSelectedEvidenceCount),
      minimumUsefulEvidenceMet: Boolean(event.cEmbeddedEvidenceTrace.minimumUsefulEvidenceMet),
      normalizedCommentTokens: sanitizeTokenList(event.cEmbeddedEvidenceTrace.normalizedCommentTokens),
      candidateTokenCoverage: sanitizeCandidateTokenCoverage(event.cEmbeddedEvidenceTrace.candidateTokenCoverage),
      semanticCandidateTopK: sanitizeSemanticCandidateTopK(event.cEmbeddedEvidenceTrace.semanticCandidateTopK),
      selectedSimilarFunctionNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.selectedSimilarFunctionNames),
      retrievalElapsedMs: event.cEmbeddedEvidenceTrace.retrievalElapsedMs !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.retrievalElapsedMs) : undefined,
      retrievalBudgetMs: event.cEmbeddedEvidenceTrace.retrievalBudgetMs !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.retrievalBudgetMs) : undefined,
      retrievalTimedOut: event.cEmbeddedEvidenceTrace.retrievalTimedOut !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.retrievalTimedOut) : undefined,
      timeoutStage: event.cEmbeddedEvidenceTrace.timeoutStage ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.timeoutStage, 80) : undefined,
      qaAlignedEvidence: event.cEmbeddedEvidenceTrace.qaAlignedEvidence !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.qaAlignedEvidence) : undefined,
      qaTopCandidate: event.cEmbeddedEvidenceTrace.qaTopCandidate ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.qaTopCandidate, 120) : undefined,
      completionTopCandidate: event.cEmbeddedEvidenceTrace.completionTopCandidate ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.completionTopCandidate, 120) : undefined,
      sharedTopCandidate: event.cEmbeddedEvidenceTrace.sharedTopCandidate ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.sharedTopCandidate, 120) : undefined,
      qaRetrievalTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.qaRetrievalTopK),
      completionRetrievalTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.completionRetrievalTopK),
      alignmentReason: event.cEmbeddedEvidenceTrace.alignmentReason ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.alignmentReason, 80) : undefined,
      rerankEnabled: event.cEmbeddedEvidenceTrace.rerankEnabled !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.rerankEnabled) : undefined,
      ragAvailable: event.cEmbeddedEvidenceTrace.ragAvailable !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.ragAvailable) : undefined,
      latencyBudgetMs: event.cEmbeddedEvidenceTrace.latencyBudgetMs !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.latencyBudgetMs) : undefined,
      maxEvidence: event.cEmbeddedEvidenceTrace.maxEvidence !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.maxEvidence) : undefined,
      evidenceRoles: sanitizeTokenList(event.cEmbeddedEvidenceTrace.evidenceRoles),
      generationModeHint: event.cEmbeddedEvidenceTrace.generationModeHint ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.generationModeHint, 80) : undefined,
      helperCallableConfidence: event.cEmbeddedEvidenceTrace.helperCallableConfidence ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.helperCallableConfidence, 40) : undefined,
      callableHelperCandidates: sanitizeTokenList(event.cEmbeddedEvidenceTrace.callableHelperCandidates),
      styleExampleCandidates: sanitizeTokenList(event.cEmbeddedEvidenceTrace.styleExampleCandidates),
      qaStyleTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.qaStyleTopK),
      completionProjectionTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.completionProjectionTopK),
      droppedAlignedEvidence: sanitizeTokenList(event.cEmbeddedEvidenceTrace.droppedAlignedEvidence),
      cursorContextFeatures: sanitizeCursorContextFeatures(event.cEmbeddedEvidenceTrace.cursorContextFeatures),
      cursorContextScope: event.cEmbeddedEvidenceTrace.cursorContextScope ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.cursorContextScope, 80) : undefined,
      currentFunctionBodyIsEmpty: event.cEmbeddedEvidenceTrace.currentFunctionBodyIsEmpty !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.currentFunctionBodyIsEmpty) : undefined,
      scopedPreviousStatementCalls: sanitizeTokenList(event.cEmbeddedEvidenceTrace.scopedPreviousStatementCalls),
      scopedNextStatementCalls: sanitizeTokenList(event.cEmbeddedEvidenceTrace.scopedNextStatementCalls),
      cursorContextFallbackReason: event.cEmbeddedEvidenceTrace.cursorContextFallbackReason ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.cursorContextFallbackReason, 120) : undefined,
      fullRetrievalCandidateCount: event.cEmbeddedEvidenceTrace.fullRetrievalCandidateCount !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.fullRetrievalCandidateCount) : undefined,
      projectionCandidateCount: event.cEmbeddedEvidenceTrace.projectionCandidateCount !== undefined ? finiteNumber(event.cEmbeddedEvidenceTrace.projectionCandidateCount) : undefined,
      retrievalShape: event.cEmbeddedEvidenceTrace.retrievalShape ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.retrievalShape, 40) : undefined,
      qaExactTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.qaExactTopK),
      qaExactSubmittedEvidence: sanitizeTokenList(event.cEmbeddedEvidenceTrace.qaExactSubmittedEvidence),
      qaExactContextTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.qaExactContextTopK),
      semanticQueryText: event.cEmbeddedEvidenceTrace.semanticQueryText ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.semanticQueryText, 600) : undefined,
      graphQuestionTextHash: event.cEmbeddedEvidenceTrace.graphQuestionTextHash ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.graphQuestionTextHash, 80) : undefined,
      semanticTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.semanticTopK),
      graphTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.graphTopK),
      mergedTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.mergedTopK),
      selectedPromptEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.selectedPromptEvidenceNames),
      rawSemanticTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.rawSemanticTopK),
      rawGraphTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.rawGraphTopK),
      mergedRetrievalTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.mergedRetrievalTopK),
      projectionTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.projectionTopK),
      projectedEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.projectedEvidenceNames),
      actualPromptEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.actualPromptEvidenceNames),
      droppedProjectedEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.droppedProjectedEvidenceNames),
      rawTop1Aligned: event.cEmbeddedEvidenceTrace.rawTop1Aligned !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.rawTop1Aligned) : undefined,
      retrievalRecallAligned: event.cEmbeddedEvidenceTrace.retrievalRecallAligned !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.retrievalRecallAligned) : undefined,
      projectionSelectedStrongHelper: event.cEmbeddedEvidenceTrace.projectionSelectedStrongHelper !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.projectionSelectedStrongHelper) : undefined,
      promptContainsProjectedHelper: event.cEmbeddedEvidenceTrace.promptContainsProjectedHelper !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.promptContainsProjectedHelper) : undefined,
      probeAffectsPrompt: event.cEmbeddedEvidenceTrace.probeAffectsPrompt !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.probeAffectsPrompt) : undefined,
      probeCompleted: event.cEmbeddedEvidenceTrace.probeCompleted !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.probeCompleted) : undefined,
      projectionToPromptDropReason: event.cEmbeddedEvidenceTrace.projectionToPromptDropReason ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.projectionToPromptDropReason, 80) : undefined,
      submittedEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.submittedEvidenceNames),
      expectedSymbolInQaExactRetrieval: event.cEmbeddedEvidenceTrace.expectedSymbolInQaExactRetrieval !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.expectedSymbolInQaExactRetrieval) : undefined,
      expectedSymbolInFullRetrieval: event.cEmbeddedEvidenceTrace.expectedSymbolInFullRetrieval !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.expectedSymbolInFullRetrieval) : undefined,
      expectedSymbolInProjection: event.cEmbeddedEvidenceTrace.expectedSymbolInProjection !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.expectedSymbolInProjection) : undefined,
      expectedSymbolInPrompt: event.cEmbeddedEvidenceTrace.expectedSymbolInPrompt !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.expectedSymbolInPrompt) : undefined,
      fullRetrievalProbeDumpPath: event.cEmbeddedEvidenceTrace.fullRetrievalProbeDumpPath ? sanitizeDebugPath(event.cEmbeddedEvidenceTrace.fullRetrievalProbeDumpPath) : undefined,
      symbolPrefixRetrievalShape: event.cEmbeddedEvidenceTrace.symbolPrefixRetrievalShape ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.symbolPrefixRetrievalShape, 80) : undefined,
      symbolPrefixLocalTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixLocalTopK),
      symbolPrefixProjectedEvidenceNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixProjectedEvidenceNames),
      symbolPrefixDroppedTargetSymbols: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixDroppedTargetSymbols),
      typedPrefixCompatibleCandidates: sanitizeTokenList(event.cEmbeddedEvidenceTrace.typedPrefixCompatibleCandidates),
      typedPrefixCompatiblePromptNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.typedPrefixCompatiblePromptNames),
      symbolPrefixSemanticQueryText: event.cEmbeddedEvidenceTrace.symbolPrefixSemanticQueryText ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.symbolPrefixSemanticQueryText, 600) : undefined,
      symbolPrefixSemanticTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixSemanticTopK),
      symbolPrefixGraphTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixGraphTopK),
      symbolPrefixMergedTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixMergedTopK),
      symbolPrefixRerankTopK: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixRerankTopK),
      symbolPrefixSemanticSelectedNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixSemanticSelectedNames),
      symbolPrefixPrefixCompatibleNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixPrefixCompatibleNames),
      symbolPrefixSemanticVsPrefixDiverged: event.cEmbeddedEvidenceTrace.symbolPrefixSemanticVsPrefixDiverged !== undefined ? Boolean(event.cEmbeddedEvidenceTrace.symbolPrefixSemanticVsPrefixDiverged) : undefined,
      symbolPrefixSelectionReason: event.cEmbeddedEvidenceTrace.symbolPrefixSelectionReason ? truncateTelemetryText(event.cEmbeddedEvidenceTrace.symbolPrefixSelectionReason, 160) : undefined,
      symbolPrefixCurrentFunctionTokens: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixCurrentFunctionTokens),
      symbolPrefixNonPrefixDroppedNames: sanitizeTokenList(event.cEmbeddedEvidenceTrace.symbolPrefixNonPrefixDroppedNames),
      symbolPrefixProjectionReasons: sanitizeSymbolPrefixProjectionReasons(event.cEmbeddedEvidenceTrace.symbolPrefixProjectionReasons),
      symbolPrefixCompatibilityScores: sanitizeSymbolPrefixCompatibilityScores(event.cEmbeddedEvidenceTrace.symbolPrefixCompatibilityScores),
    } : undefined,
    normalizedCommentTokens: sanitizeTokenList(event.normalizedCommentTokens),
    candidateTokenCoverage: sanitizeCandidateTokenCoverage(event.candidateTokenCoverage),
    semanticCandidateTopK: sanitizeSemanticCandidateTopK(event.semanticCandidateTopK),
    selectedSimilarFunctionNames: sanitizeTokenList(event.selectedSimilarFunctionNames),
    retrievalElapsedMs: event.retrievalElapsedMs !== undefined ? finiteNumber(event.retrievalElapsedMs) : undefined,
    retrievalBudgetMs: event.retrievalBudgetMs !== undefined ? finiteNumber(event.retrievalBudgetMs) : undefined,
    retrievalTimedOut: event.retrievalTimedOut !== undefined ? Boolean(event.retrievalTimedOut) : undefined,
    timeoutStage: event.timeoutStage ? truncateTelemetryText(event.timeoutStage, 80) : undefined,
    qaAlignedEvidence: event.qaAlignedEvidence !== undefined ? Boolean(event.qaAlignedEvidence) : undefined,
    qaTopCandidate: event.qaTopCandidate ? truncateTelemetryText(event.qaTopCandidate, 120) : undefined,
    completionTopCandidate: event.completionTopCandidate ? truncateTelemetryText(event.completionTopCandidate, 120) : undefined,
    sharedTopCandidate: event.sharedTopCandidate ? truncateTelemetryText(event.sharedTopCandidate, 120) : undefined,
    qaRetrievalTopK: sanitizeTokenList(event.qaRetrievalTopK),
    completionRetrievalTopK: sanitizeTokenList(event.completionRetrievalTopK),
    alignmentReason: event.alignmentReason ? truncateTelemetryText(event.alignmentReason, 80) : undefined,
    rerankEnabled: event.rerankEnabled !== undefined ? Boolean(event.rerankEnabled) : undefined,
    ragAvailable: event.ragAvailable !== undefined ? Boolean(event.ragAvailable) : undefined,
    latencyBudgetMs: event.latencyBudgetMs !== undefined ? finiteNumber(event.latencyBudgetMs) : undefined,
    maxEvidence: event.maxEvidence !== undefined ? finiteNumber(event.maxEvidence) : undefined,
    evidenceRoles: sanitizeTokenList(event.evidenceRoles),
    generationModeHint: event.generationModeHint ? truncateTelemetryText(event.generationModeHint, 80) : undefined,
    helperCallableConfidence: event.helperCallableConfidence ? truncateTelemetryText(event.helperCallableConfidence, 40) : undefined,
    callableHelperCandidates: sanitizeTokenList(event.callableHelperCandidates),
    styleExampleCandidates: sanitizeTokenList(event.styleExampleCandidates),
    qaStyleTopK: sanitizeTokenList(event.qaStyleTopK),
    completionProjectionTopK: sanitizeTokenList(event.completionProjectionTopK),
    droppedAlignedEvidence: sanitizeTokenList(event.droppedAlignedEvidence),
    cursorContextFeatures: sanitizeCursorContextFeatures(event.cursorContextFeatures),
    cursorContextScope: event.cursorContextScope ? truncateTelemetryText(event.cursorContextScope, 80) : undefined,
    currentFunctionBodyIsEmpty: event.currentFunctionBodyIsEmpty !== undefined ? Boolean(event.currentFunctionBodyIsEmpty) : undefined,
    scopedPreviousStatementCalls: sanitizeTokenList(event.scopedPreviousStatementCalls),
    scopedNextStatementCalls: sanitizeTokenList(event.scopedNextStatementCalls),
    cursorContextFallbackReason: event.cursorContextFallbackReason ? truncateTelemetryText(event.cursorContextFallbackReason, 120) : undefined,
    fullRetrievalCandidateCount: event.fullRetrievalCandidateCount !== undefined ? finiteNumber(event.fullRetrievalCandidateCount) : undefined,
    projectionCandidateCount: event.projectionCandidateCount !== undefined ? finiteNumber(event.projectionCandidateCount) : undefined,
    retrievalShape: event.retrievalShape ? truncateTelemetryText(event.retrievalShape, 40) : undefined,
    qaExactTopK: sanitizeTokenList(event.qaExactTopK),
    qaExactSubmittedEvidence: sanitizeTokenList(event.qaExactSubmittedEvidence),
    qaExactContextTopK: sanitizeTokenList(event.qaExactContextTopK),
    semanticQueryText: event.semanticQueryText ? truncateTelemetryText(event.semanticQueryText, 600) : undefined,
    graphQuestionTextHash: event.graphQuestionTextHash ? truncateTelemetryText(event.graphQuestionTextHash, 80) : undefined,
    semanticTopK: sanitizeTokenList(event.semanticTopK),
    graphTopK: sanitizeTokenList(event.graphTopK),
    mergedTopK: sanitizeTokenList(event.mergedTopK),
    selectedPromptEvidenceNames: sanitizeTokenList(event.selectedPromptEvidenceNames),
    rawSemanticTopK: sanitizeTokenList(event.rawSemanticTopK),
    rawGraphTopK: sanitizeTokenList(event.rawGraphTopK),
    mergedRetrievalTopK: sanitizeTokenList(event.mergedRetrievalTopK),
    projectionTopK: sanitizeTokenList(event.projectionTopK),
    projectedEvidenceNames: sanitizeTokenList(event.projectedEvidenceNames),
    actualPromptEvidenceNames: sanitizeTokenList(event.actualPromptEvidenceNames),
    droppedProjectedEvidenceNames: sanitizeTokenList(event.droppedProjectedEvidenceNames),
    rawTop1Aligned: event.rawTop1Aligned !== undefined ? Boolean(event.rawTop1Aligned) : undefined,
    retrievalRecallAligned: event.retrievalRecallAligned !== undefined ? Boolean(event.retrievalRecallAligned) : undefined,
    projectionSelectedStrongHelper: event.projectionSelectedStrongHelper !== undefined ? Boolean(event.projectionSelectedStrongHelper) : undefined,
    promptContainsProjectedHelper: event.promptContainsProjectedHelper !== undefined ? Boolean(event.promptContainsProjectedHelper) : undefined,
    probeAffectsPrompt: event.probeAffectsPrompt !== undefined ? Boolean(event.probeAffectsPrompt) : undefined,
    probeCompleted: event.probeCompleted !== undefined ? Boolean(event.probeCompleted) : undefined,
    projectionToPromptDropReason: event.projectionToPromptDropReason ? truncateTelemetryText(event.projectionToPromptDropReason, 80) : undefined,
    submittedEvidenceNames: sanitizeTokenList(event.submittedEvidenceNames),
    expectedSymbolInQaExactRetrieval: event.expectedSymbolInQaExactRetrieval !== undefined ? Boolean(event.expectedSymbolInQaExactRetrieval) : undefined,
    expectedSymbolInFullRetrieval: event.expectedSymbolInFullRetrieval !== undefined ? Boolean(event.expectedSymbolInFullRetrieval) : undefined,
    expectedSymbolInProjection: event.expectedSymbolInProjection !== undefined ? Boolean(event.expectedSymbolInProjection) : undefined,
    expectedSymbolInPrompt: event.expectedSymbolInPrompt !== undefined ? Boolean(event.expectedSymbolInPrompt) : undefined,
    fullRetrievalProbeDumpPath: event.fullRetrievalProbeDumpPath ? sanitizeDebugPath(event.fullRetrievalProbeDumpPath) : undefined,
    typedPrefixAdapted: event.typedPrefixAdapted !== undefined ? Boolean(event.typedPrefixAdapted) : undefined,
    typedPrefixAdaptReason: event.typedPrefixAdaptReason ? truncateTelemetryText(event.typedPrefixAdaptReason, 80) : undefined,
    typedPrefixCurrentWord: event.typedPrefixCurrentWord ? truncateTelemetryText(event.typedPrefixCurrentWord, 80) : undefined,
    typedPrefixMatchedSymbol: event.typedPrefixMatchedSymbol ? truncateTelemetryText(event.typedPrefixMatchedSymbol, 120) : undefined,
    typedPrefixOriginalFirstLine: event.typedPrefixOriginalFirstLine ? truncateTelemetryText(event.typedPrefixOriginalFirstLine, 160) : undefined,
    typedPrefixFinalFirstLine: event.typedPrefixFinalFirstLine ? truncateTelemetryText(event.typedPrefixFinalFirstLine, 160) : undefined,
    deterministicSymbolSuppressed: event.deterministicSymbolSuppressed !== undefined ? Boolean(event.deterministicSymbolSuppressed) : undefined,
    deterministicSymbolSuppressReason: event.deterministicSymbolSuppressReason ? truncateTelemetryText(event.deterministicSymbolSuppressReason, 80) : undefined,
    symbolPrefixCandidateTopK: sanitizeTokenList(event.symbolPrefixCandidateTopK),
    symbolPrefixContextTokens: event.symbolPrefixContextTokens !== undefined ? finiteNumber(event.symbolPrefixContextTokens) : undefined,
    symbolPrefixRoute: event.symbolPrefixRoute,
    symbolPrefixRetrievalShape: event.symbolPrefixRetrievalShape ? truncateTelemetryText(event.symbolPrefixRetrievalShape, 80) : undefined,
    symbolPrefixLocalTopK: sanitizeTokenList(event.symbolPrefixLocalTopK),
    symbolPrefixProjectedEvidenceNames: sanitizeTokenList(event.symbolPrefixProjectedEvidenceNames),
    symbolPrefixDroppedTargetSymbols: sanitizeTokenList(event.symbolPrefixDroppedTargetSymbols),
    typedPrefixCompatibleCandidates: sanitizeTokenList(event.typedPrefixCompatibleCandidates),
    typedPrefixCompatiblePromptNames: sanitizeTokenList(event.typedPrefixCompatiblePromptNames),
    symbolPrefixSemanticQueryText: event.symbolPrefixSemanticQueryText ? truncateTelemetryText(event.symbolPrefixSemanticQueryText, 600) : undefined,
    symbolPrefixSemanticTopK: sanitizeTokenList(event.symbolPrefixSemanticTopK),
    symbolPrefixGraphTopK: sanitizeTokenList(event.symbolPrefixGraphTopK),
    symbolPrefixMergedTopK: sanitizeTokenList(event.symbolPrefixMergedTopK),
    symbolPrefixRerankTopK: sanitizeTokenList(event.symbolPrefixRerankTopK),
    symbolPrefixSemanticSelectedNames: sanitizeTokenList(event.symbolPrefixSemanticSelectedNames),
    symbolPrefixPrefixCompatibleNames: sanitizeTokenList(event.symbolPrefixPrefixCompatibleNames),
    symbolPrefixSemanticVsPrefixDiverged: event.symbolPrefixSemanticVsPrefixDiverged !== undefined ? Boolean(event.symbolPrefixSemanticVsPrefixDiverged) : undefined,
    symbolPrefixSelectionReason: event.symbolPrefixSelectionReason ? truncateTelemetryText(event.symbolPrefixSelectionReason, 160) : undefined,
    symbolPrefixCurrentFunctionTokens: sanitizeTokenList(event.symbolPrefixCurrentFunctionTokens),
    symbolPrefixNonPrefixDroppedNames: sanitizeTokenList(event.symbolPrefixNonPrefixDroppedNames),
    symbolPrefixProjectionReasons: sanitizeSymbolPrefixProjectionReasons(event.symbolPrefixProjectionReasons),
    symbolPrefixCompatibilityScores: sanitizeSymbolPrefixCompatibilityScores(event.symbolPrefixCompatibilityScores),
    symbolCandidates: event.symbolCandidates?.map((candidate) => ({
      name: truncateTelemetryText(candidate.name, 120),
      kind: truncateTelemetryText(candidate.kind, 40),
      score: finiteNumber(candidate.score),
      source: truncateTelemetryText(candidate.source, 40),
    })),
    selectedContextBlocks: event.selectedContextBlocks?.map((block) => ({
      kind: truncateTelemetryText(block.kind, 40),
      title: truncateTelemetryText(block.title, 120),
      tokenEstimate: finiteNumber(block.tokenEstimate),
      score: finiteNumber(block.score),
    })),
    droppedContextBlocks: event.droppedContextBlocks?.map((block) => ({
      kind: truncateTelemetryText(block.kind, 40),
      title: truncateTelemetryText(block.title, 120),
      reason: truncateTelemetryText(block.reason, 80),
    })),
    trimReason: event.trimReason ? truncateTelemetryText(event.trimReason, 120) : undefined,
    filterText: event.filterText ? truncateTelemetryText(event.filterText, 160) : undefined,
    rejectReason: event.rejectReason ? truncateTelemetryText(event.rejectReason, 80) : undefined,
    latencyMs: sanitizeLatency(event.latencyMs),
  }
}

export function truncateTelemetryText(input: string, max = 160) {
  const redacted = redactPathLikeText(input).replace(/\r\n/g, "\n")
  const truncated = redacted.length <= max ? redacted : `${redacted.slice(0, max)}...`
  return truncated.replace(/\n/g, "\\n")
}

function redactPathLikeText(input: string) {
  return input
    .replace(/(?:\/[A-Za-z0-9_. -]+){2,}/g, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)+[^\\\r\n]*/g, "[path]")
}

function sanitizeDebugPath(input: string) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\n/g, "\\n")
  return normalized.length <= 260 ? normalized : `${normalized.slice(0, 260)}...`
}

function sanitizeLatency(input: CompletionDebugEvent["latencyMs"]) {
  return {
    ...(input.planning !== undefined ? { planning: finiteNumber(input.planning) } : {}),
    ...(input.symbol !== undefined ? { symbol: finiteNumber(input.symbol) } : {}),
    ...(input.context !== undefined ? { context: finiteNumber(input.context) } : {}),
    ...(input.model !== undefined ? { model: finiteNumber(input.model) } : {}),
    ...(input.postprocess !== undefined ? { postprocess: finiteNumber(input.postprocess) } : {}),
    ...(input.edit !== undefined ? { edit: finiteNumber(input.edit) } : {}),
    total: finiteNumber(input.total),
  }
}

function sanitizeTokenList(input: string[] | undefined) {
  return input?.map((item) => truncateTelemetryText(item, 80)).slice(0, 16)
}

function sanitizeCandidateTokenCoverage(input: CompletionDebugEvent["candidateTokenCoverage"]) {
  return input?.slice(0, 8).map((item) => ({
    name: item.name ? truncateTelemetryText(item.name, 120) : undefined,
    kind: truncateTelemetryText(item.kind, 60),
    actionTokenCoverage: finiteNumber(item.actionTokenCoverage),
    objectTokenCoverage: finiteNumber(item.objectTokenCoverage),
    domainTokenCoverage: finiteNumber(item.domainTokenCoverage),
    matchedActionTokens: sanitizeTokenList(item.matchedActionTokens) ?? [],
    matchedObjectTokens: sanitizeTokenList(item.matchedObjectTokens) ?? [],
    matchedDomainTokens: sanitizeTokenList(item.matchedDomainTokens) ?? [],
  }))
}

function sanitizeSemanticCandidateTopK(input: CompletionDebugEvent["semanticCandidateTopK"]) {
  return input?.slice(0, 8).map((item) => ({
    name: item.name ? truncateTelemetryText(item.name, 120) : undefined,
    kind: truncateTelemetryText(item.kind, 60),
    score: finiteNumber(item.score),
    actionTokenCoverage: item.actionTokenCoverage !== undefined ? finiteNumber(item.actionTokenCoverage) : undefined,
    objectTokenCoverage: item.objectTokenCoverage !== undefined ? finiteNumber(item.objectTokenCoverage) : undefined,
    domainTokenCoverage: item.domainTokenCoverage !== undefined ? finiteNumber(item.domainTokenCoverage) : undefined,
  }))
}

function sanitizeSymbolPrefixCompatibilityScores(input: CompletionDebugEvent["symbolPrefixCompatibilityScores"]) {
  return input?.slice(0, 8).map((item) => ({
    name: item.name ? truncateTelemetryText(item.name, 120) : undefined,
    prefixCompatible: Boolean(item.prefixCompatible),
    localFlowScore: finiteNumber(item.localFlowScore),
    projectionScore: finiteNumber(item.projectionScore),
    broadUtility: Boolean(item.broadUtility),
  }))
}

function sanitizeSymbolPrefixProjectionReasons(input: CompletionDebugEvent["symbolPrefixProjectionReasons"]) {
  return input?.slice(0, 8).map((item) => ({
    name: item.name ? truncateTelemetryText(item.name, 120) : undefined,
    reason: truncateTelemetryText(item.reason, 160),
    prefixCompatible: Boolean(item.prefixCompatible),
    currentFunctionTokenScore: finiteNumber(item.currentFunctionTokenScore),
    projectionScore: finiteNumber(item.projectionScore),
  }))
}

function sanitizeCursorContextFeatures(input: Record<string, unknown> | undefined) {
  if (!input) return undefined
  return {
    previousStatementCalls: sanitizeUnknownStringList(input.previousStatementCalls),
    nextStatementCalls: sanitizeUnknownStringList(input.nextStatementCalls),
    scopedPreviousStatementCalls: sanitizeUnknownStringList(input.scopedPreviousStatementCalls),
    scopedNextStatementCalls: sanitizeUnknownStringList(input.scopedNextStatementCalls),
    nearbyLogOrMessageText: sanitizeUnknownStringList(input.nearbyLogOrMessageText, 6, 120),
    currentFunctionName: typeof input.currentFunctionName === "string" ? truncateTelemetryText(input.currentFunctionName, 120) : undefined,
    statementHoleKind: typeof input.statementHoleKind === "string" ? truncateTelemetryText(input.statementHoleKind, 80) : undefined,
    flowOrdinalTokens: sanitizeUnknownStringList(input.flowOrdinalTokens),
    visibleLocals: sanitizeUnknownStringList(input.visibleLocals),
    visibleIdentifiers: sanitizeUnknownStringList(input.visibleIdentifiers, 16, 80),
    cursorContextScope: typeof input.cursorContextScope === "string" ? truncateTelemetryText(input.cursorContextScope, 80) : undefined,
    currentFunctionBodyIsEmpty: input.currentFunctionBodyIsEmpty !== undefined ? Boolean(input.currentFunctionBodyIsEmpty) : undefined,
    cursorContextFallbackReason: typeof input.cursorContextFallbackReason === "string" ? truncateTelemetryText(input.cursorContextFallbackReason, 120) : undefined,
  }
}

function sanitizeUnknownStringList(input: unknown, maxItems = 8, maxText = 80) {
  if (!Array.isArray(input)) return undefined
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncateTelemetryText(item, maxText))
    .slice(0, maxItems)
}

function finiteNumber(input: number) {
  return Number.isFinite(input) ? Math.max(0, Math.round(input)) : 0
}
