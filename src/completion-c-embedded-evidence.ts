import type { QueryEvidenceResult, StateMachine } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence } from "./codegraph-types"
import { normalizeCommentGuidedTokens, scoreCommentGuidedCandidate, type CommentGuidedTokenCoverage, type CommentGuidedTokenGroups } from "./completion-comment-guided-ranking"
import { extractCommentGuidedCursorContext, type CommentGuidedCursorContextFeatures } from "./completion-cursor-context"
import type { CompletionCIntent, CompletionPlan } from "./completion-types"
import { retrieveRepositoryEvidenceForIntent, type RepositoryEvidenceAlignmentReason, type RepositoryEvidenceItem, type RepositoryEvidenceResult } from "./repository-evidence"
import type { CompletionCommentGuidedRetrievalMode } from "./types"

export type CEmbeddedEvidenceKind =
  | "c-base-type"
  | "c-struct-definition"
  | "c-same-usage"
  | "c-callee-signature"
  | "c-call-example"
  | "c-return-handling"
  | "c-initializer-example"
  | "c-callback-signature"
  | "c-error-labels"
  | "c-cleanup-pattern"
  | "c-return-style"
  | "c-state-machine"
  | "c-register-macro"
  | "c-register-access-example"
  | "c-symbol-definition"
  | "c-symbol-reference"
  | "c-helper-usage"
  | "c-local-context"
  | "c-macro-definition"
  | "c-type-definition"
  | "c-call-style"
  | "c-comment-semantic-match"
  | "c-similar-function"
  | "c-similar-block"
  | "c-same-module-flow"

export type CEmbeddedEvidenceRole = "callable-helper" | "prefix-compatible-helper" | "style-example" | "local-flow" | "weak-target-symbol" | "weak-context"
export type CEmbeddedGenerationModeHint = "prefer-existing-helper" | "synthesize-from-style" | "continue-local-code"
export type CEmbeddedHelperCallableConfidence = "high" | "medium" | "low" | "none"

export type CEmbeddedEvidenceItem = {
  kind: CEmbeddedEvidenceKind
  name?: string
  path: string
  startLine: number
  endLine: number
  reason: string
  score: number
  domainBoostApplied: boolean
  source: "graph" | "rag"
  text: string
  tokenCoverage?: CommentGuidedTokenCoverage
  evidenceRole?: CEmbeddedEvidenceRole
  helperCallableConfidence?: Exclude<CEmbeddedHelperCallableConfidence, "none">
}

export type CEmbeddedEvidenceTrace = {
  ragFallbackTriggered: boolean
  ragFallbackReason?: string
  graphEvidenceCount: number
  ragEvidenceCount: number
  finalSelectedEvidenceCount: number
  minimumUsefulEvidenceMet: boolean
  normalizedCommentTokens?: string[]
  candidateTokenCoverage?: Array<{
    name?: string
    kind: CEmbeddedEvidenceKind
    actionTokenCoverage: number
    objectTokenCoverage: number
    domainTokenCoverage: number
    matchedActionTokens: string[]
    matchedObjectTokens: string[]
    matchedDomainTokens: string[]
  }>
  semanticCandidateTopK?: Array<{
    name?: string
    kind: CEmbeddedEvidenceKind
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
  alignmentReason?: RepositoryEvidenceAlignmentReason
  rerankEnabled?: boolean
  ragAvailable?: boolean
  latencyBudgetMs?: number
  maxEvidence?: number
  evidenceRoles?: CEmbeddedEvidenceRole[]
  generationModeHint?: CEmbeddedGenerationModeHint
  helperCallableConfidence?: CEmbeddedHelperCallableConfidence
  callableHelperCandidates?: string[]
  styleExampleCandidates?: string[]
  qaStyleTopK?: string[]
  completionProjectionTopK?: string[]
  droppedAlignedEvidence?: string[]
  cursorContextFeatures?: CommentGuidedCursorContextFeatures
  cursorContextScope?: "current-function" | "file-window-fallback"
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

export type CEmbeddedCompletionEvidenceResult = {
  text: string
  items: CEmbeddedEvidenceItem[]
  evidenceKinds: CEmbeddedEvidenceKind[]
  selectedEvidenceCount: number
  retrievalMode: "none" | "graph-only" | "hybrid"
  trace: CEmbeddedEvidenceTrace
  debugDump?: CEmbeddedFullRetrievalDebugDump
}

export type CEmbeddedFullRetrievalDebugDump = {
  requestId?: string
  sourceComment: string
  currentFile: string
  currentFunction?: string
  normalizedCommentTokens: string[]
  cursorContextFeatures: CommentGuidedCursorContextFeatures
  queryText: string
  retrievalMode: string
  retrievalElapsedMs: number
  retrievalBudgetMs?: number
  retrievalTimedOut: boolean
  retrievalShape?: string
  rerankEnabled?: boolean
  ragAvailable?: boolean
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
  probeAffectsPrompt?: boolean
  probeCompleted?: boolean
  projectionToPromptDropReason?: string
  expectedSymbol?: string
  expectedSymbolPresence: {
    qaExactRetrieval?: boolean
    fullRetrieval: boolean
    projection: boolean
    submittedEvidence: boolean
    selectedContextBlocks?: boolean
    finalPrompt?: boolean
  }
  fullRetrievalTopK: CEmbeddedRetrievalDebugCandidate[]
  completionProjectionRankedTopK: CEmbeddedRetrievalDebugCandidate[]
  completionPackSubmitted: CEmbeddedRetrievalDebugCandidate[]
}

export type CEmbeddedRetrievalDebugCandidate = {
  rank: number
  name?: string
  kind: string
  source: string
  path?: string
  startLine?: number
  endLine?: number
  score: number
  projectionScore?: number
  reason?: string
  snippetPreview: string
  actionTokenCoverage: number
  objectTokenCoverage: number
  domainTokenCoverage: number
  cursorContextScores?: RepositoryEvidenceItem["cursorContextScores"]
}

export type CEmbeddedCompletionEvidenceInput = {
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence">
  plan: CompletionPlan
  question: string
  relatedPaths: string[]
  domainHints?: string[]
  maxItems?: number
  prefix?: string
  suffix?: string
  debugFullRetrievalProbe?: boolean
  debugExpectedSymbol?: string
  commentGuidedRetrievalMode?: CompletionCommentGuidedRetrievalMode
  requestId?: string
  cursorPrefix?: string
  cursorSuffix?: string
  cursorContextScope?: "current-function" | "file-window-fallback"
  currentFunctionBodyIsEmpty?: boolean
  cursorContextFallbackReason?: string
}

const STRONG_COMPLETION_EVIDENCE_INTENTS = new Set<CompletionCIntent>([
  "member-access",
  "call-args",
  "initializer",
  "error-path",
  "state-machine",
  "mmio-register",
])

export function shouldBuildCEmbeddedCompletionEvidence(plan: CompletionPlan) {
  return plan.kind === "c-embedded-code" || plan.kind === "comment-guided-c-code"
}

export async function buildCEmbeddedCompletionEvidence(input: CEmbeddedCompletionEvidenceInput): Promise<CEmbeddedCompletionEvidenceResult> {
  const intent = input.plan.cIntent ?? "body-statement"
  const commentGuided = input.plan.kind === "comment-guided-c-code"
  const retrievalStarted = Date.now()
  const retrievalBudgetMs = commentGuided ? input.plan.retrievalBudgetMs ?? 2500 : undefined
  let retrievalTimedOut = false

  if (commentGuided) {
    return buildCommentGuidedRepositoryEvidence({
      ...input,
      intent,
      retrievalBudgetMs,
      retrievalStarted,
    })
  }
  if (intent === "symbol-prefix") {
    return buildSymbolPrefixRepositoryEvidence({
      ...input,
      intent,
      retrievalStarted,
    })
  }
  if (intent === "body-statement") {
    return buildBodyStatementRepositoryEvidence({
      ...input,
      intent,
      retrievalStarted,
    })
  }

  const graphQuery = await queryEvidenceWithBudget(input.codeGraph, input.question, {
    retrievalMode: "graph-only",
    relatedPaths: input.relatedPaths,
  }, retrievalBudgetMs)
  retrievalTimedOut ||= graphQuery.timedOut
  const graphResult = graphQuery.result
  const graphItems = selectEvidenceItems({
    result: graphResult,
    intent,
    commentGuided,
    domainHints: input.domainHints ?? [],
    sourceMode: "graph",
  })
  const graphUseful = minimumUsefulEvidence(intent, graphItems, commentGuided)
  let finalItems = graphItems
  let retrievalMode: CEmbeddedCompletionEvidenceResult["retrievalMode"] = graphResult ? "graph-only" : "none"
  let ragFallbackTriggered = false
  let ragFallbackReason: string | undefined
  let ragEvidenceCount = 0

  if (!graphUseful.met && !retrievalTimedOut) {
    ragFallbackTriggered = true
    ragFallbackReason = graphUseful.reason
    try {
      const remainingBudget = retrievalBudgetMs !== undefined
        ? Math.max(1, retrievalBudgetMs - (Date.now() - retrievalStarted))
        : undefined
      const hybridQuery = await queryEvidenceWithBudget(input.codeGraph, input.question, {
        retrievalMode: "hybrid",
        relatedPaths: input.relatedPaths,
      }, remainingBudget)
      retrievalTimedOut ||= hybridQuery.timedOut
      const hybridResult = hybridQuery.result
      retrievalMode = "hybrid"
      const hybridItems = selectEvidenceItems({
        result: hybridResult,
        intent,
        commentGuided,
        domainHints: input.domainHints ?? [],
        sourceMode: "hybrid",
      })
      ragEvidenceCount = hybridItems.filter((item) => item.source === "rag").length
      finalItems = mergeEvidenceItems(graphItems, hybridItems)
    } catch (error) {
      ragFallbackReason = `${ragFallbackReason}; hybrid fallback unavailable: ${formatError(error)}`
    }
  }

  const selected = selectPromptEvidenceItems(intent, finalItems, input.maxItems ?? maxEvidenceItemsForIntent(intent, commentGuided))
  const finalUseful = minimumUsefulEvidence(intent, selected, commentGuided)
  const trace: CEmbeddedEvidenceTrace = {
    ragFallbackTriggered,
    ragFallbackReason,
    graphEvidenceCount: graphItems.length,
    ragEvidenceCount,
    finalSelectedEvidenceCount: selected.length,
    minimumUsefulEvidenceMet: finalUseful.met,
    normalizedCommentTokens: commentGuided ? normalizeCommentGuidedTokens(sourceCommentFromEvidenceQuestion(input.question)).normalizedTokens : undefined,
    candidateTokenCoverage: commentGuided ? selected.flatMap(evidenceTokenCoverageTelemetry) : undefined,
    semanticCandidateTopK: commentGuided ? finalItems
      .filter((item) => item.kind === "c-comment-semantic-match" || item.kind === "c-similar-function" || item.kind === "c-helper-usage")
      .sort((left, right) => right.score - left.score)
      .slice(0, 8)
      .map((item) => ({
        name: item.name,
        kind: item.kind,
        score: Math.round(item.score),
        actionTokenCoverage: item.tokenCoverage?.actionTokenCoverage,
        objectTokenCoverage: item.tokenCoverage?.objectTokenCoverage,
        domainTokenCoverage: item.tokenCoverage?.domainTokenCoverage,
      })) : undefined,
    selectedSimilarFunctionNames: commentGuided ? uniqueStrings(selected
      .filter((item) => item.name && (item.kind === "c-comment-semantic-match" || item.kind === "c-similar-function" || item.kind === "c-helper-usage"))
      .map((item) => item.name ?? "")) : undefined,
    retrievalElapsedMs: Date.now() - retrievalStarted,
    retrievalBudgetMs,
    retrievalTimedOut,
  }
  return {
    text: formatCEmbeddedEvidenceText(intent, selected, trace),
    items: selected,
    evidenceKinds: uniqueStrings(selected.map((item) => item.kind)),
    selectedEvidenceCount: selected.length,
    retrievalMode,
    trace,
  }
}

async function buildCommentGuidedRepositoryEvidence(input: CEmbeddedCompletionEvidenceInput & {
  intent: CompletionCIntent
  retrievalBudgetMs: number | undefined
  retrievalStarted: number
}): Promise<CEmbeddedCompletionEvidenceResult> {
  const maxItems = input.maxItems ?? maxEvidenceItemsForIntent(input.intent, true)
  const sourceComment = sourceCommentFromEvidenceQuestion(input.question)
  const commentTokens = normalizeCommentGuidedTokens(sourceComment)
  const currentFile = currentPathFromEvidenceQuestion(input.question) ?? input.relatedPaths[0] ?? ""
  const currentFunction = currentFunctionFromEvidenceQuestion(input.question)
  const cursorPrefix = input.cursorPrefix ?? input.prefix
  const cursorSuffix = input.cursorSuffix ?? input.suffix
  const cursorContext = extractCommentGuidedCursorContext({
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    currentFunctionName: currentFunction,
    sourceComment,
    cursorContextScope: input.cursorContextScope,
    currentFunctionBodyIsEmpty: input.currentFunctionBodyIsEmpty,
    cursorContextFallbackReason: input.cursorContextFallbackReason,
  })
  const contextInput = { ...input, prefix: cursorPrefix, suffix: cursorSuffix }
  const commentGuidedRetrievalMode = input.commentGuidedRetrievalMode ?? "qa-exact"
  const qaExact = commentGuidedRetrievalMode !== "completion"
  const repository = await retrieveRepositoryEvidenceForIntent({
    codeGraph: input.codeGraph,
    mode: "completion",
    task: "comment-guided-code",
    sourceComment,
    currentFile,
    currentFunction,
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.question),
    maxEvidence: maxItems,
    maxBytes: 4_000,
    latencyBudgetMs: input.retrievalBudgetMs,
    debugFullRetrievalProbe: input.debugFullRetrievalProbe,
    cursorContext,
    retrievalShape: qaExact ? "qa-exact" : "default",
  })
  const finalItems = repository.completionPack.evidence.map((item) =>
    evidenceItemFromRepositoryEvidence(item, input.domainHints ?? [], commentTokens))
  const generationModeHint = generationModeHintForCommentGuided(contextInput, finalItems)
  const roleItems = annotateCommentGuidedEvidenceRoles({
    items: finalItems,
    input: contextInput,
    commentTokens,
    generationModeHint,
  })
  const selected = qaExact
    ? selectQaExactPromptEvidence(roleItems, maxItems)
    : selectCommentGuidedPromptEvidence(roleItems, maxItems, generationModeHint)
  const usefulEvidence = minimumUsefulEvidence(input.intent, selected, true)
  const trace = commentGuidedRepositoryTrace({
    repository,
    selected,
    allItems: roleItems,
    commentTokens,
    cursorContext,
    expectedSymbol: input.debugExpectedSymbol,
    generationModeHint,
    usefulEvidenceMet: usefulEvidence.met,
    retrievalStarted: input.retrievalStarted,
    retrievalBudgetMs: input.retrievalBudgetMs,
  })
  const debugDump = input.debugFullRetrievalProbe
    ? commentGuidedFullRetrievalDebugDump({
        repository,
        selected,
        sourceComment,
        currentFile,
        currentFunction,
        commentTokens,
        cursorContext,
        expectedSymbol: input.debugExpectedSymbol,
        requestId: input.requestId,
        trace,
      })
    : undefined
  return {
    text: formatCEmbeddedEvidenceText(input.intent, selected, trace),
    items: selected,
    evidenceKinds: uniqueStrings(selected.map((item) => item.kind)),
    selectedEvidenceCount: selected.length,
    retrievalMode: repositoryCompletionRetrievalMode(repository),
    trace,
    debugDump,
  }
}

async function buildSymbolPrefixRepositoryEvidence(input: CEmbeddedCompletionEvidenceInput & {
  intent: CompletionCIntent
  retrievalStarted: number
}): Promise<CEmbeddedCompletionEvidenceResult> {
  const maxItems = input.maxItems ?? maxEvidenceItemsForIntent(input.intent, false)
  const currentFile = currentPathFromEvidenceQuestion(input.question) ?? input.relatedPaths[0] ?? ""
  const currentFunction = currentFunctionFromEvidenceQuestion(input.question)
  const currentWord = currentWordFromEvidenceQuestion(input.question)
  const cursorPrefix = input.cursorPrefix ?? input.prefix
  const cursorSuffix = input.cursorSuffix ?? input.suffix
  const cursorContext = extractCommentGuidedCursorContext({
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    currentFunctionName: currentFunction,
    sourceComment: nearbyCommentTextFromEvidenceQuestion(input.question),
    cursorContextScope: input.cursorContextScope,
    currentFunctionBodyIsEmpty: input.currentFunctionBodyIsEmpty,
    cursorContextFallbackReason: input.cursorContextFallbackReason,
  })
  const contextInput = { ...input, prefix: cursorPrefix, suffix: cursorSuffix }
  const repository = await retrieveRepositoryEvidenceForIntent({
    codeGraph: input.codeGraph,
    mode: "completion",
    task: "symbol-prefix",
    question: input.question,
    sourceComment: nearbyCommentTextFromEvidenceQuestion(input.question),
    currentWord,
    currentFile,
    currentFunction,
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.question),
    maxEvidence: maxItems,
    maxBytes: 4_000,
    cursorContext,
    retrievalShape: "qa-semantic",
  })
  const finalItems = repository.completionPack.evidence.map((item) =>
    symbolPrefixEvidenceItemFromRepository(item, input.domainHints ?? []))
  const roleItems = annotateSymbolPrefixEvidenceRoles({
    items: finalItems,
    input: contextInput,
    currentWord,
    currentFile,
    currentFunction,
    cursorContext,
  })
  const selected = selectSymbolPrefixPromptEvidence(roleItems, maxItems, currentWord)
  const usefulEvidence = minimumUsefulEvidence(input.intent, selected, false)
  const trace = symbolPrefixRepositoryTrace({
    repository,
    selected,
    allItems: roleItems,
    currentWord,
    cursorContext,
    usefulEvidenceMet: usefulEvidence.met,
    retrievalStarted: input.retrievalStarted,
  })
  return {
    text: formatCEmbeddedEvidenceText(input.intent, selected, trace),
    items: selected,
    evidenceKinds: uniqueStrings(selected.map((item) => item.kind)),
    selectedEvidenceCount: selected.length,
    retrievalMode: repositoryCompletionRetrievalMode(repository),
    trace,
  }
}

async function buildBodyStatementRepositoryEvidence(input: CEmbeddedCompletionEvidenceInput & {
  intent: CompletionCIntent
  retrievalStarted: number
}): Promise<CEmbeddedCompletionEvidenceResult> {
  const maxItems = Math.max(input.maxItems ?? maxEvidenceItemsForIntent(input.intent, false), 3)
  const currentFile = currentPathFromEvidenceQuestion(input.question) ?? input.relatedPaths[0] ?? ""
  const currentFunction = currentFunctionFromEvidenceQuestion(input.question)
  const sourceComment = nearbyCommentTextFromEvidenceQuestion(input.question)
  const cursorPrefix = input.cursorPrefix ?? input.prefix
  const cursorSuffix = input.cursorSuffix ?? input.suffix
  const cursorContext = extractCommentGuidedCursorContext({
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    currentFunctionName: currentFunction,
    sourceComment,
    cursorContextScope: input.cursorContextScope,
    currentFunctionBodyIsEmpty: input.currentFunctionBodyIsEmpty,
    cursorContextFallbackReason: input.cursorContextFallbackReason,
  })
  const contextInput = { ...input, prefix: cursorPrefix, suffix: cursorSuffix }
  const repository = await retrieveRepositoryEvidenceForIntent({
    codeGraph: input.codeGraph,
    mode: "completion",
    task: "body-statement",
    question: input.question,
    sourceComment,
    currentWord: currentWordFromEvidenceQuestion(input.question),
    currentFile,
    currentFunction,
    prefix: cursorPrefix,
    suffix: cursorSuffix,
    nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.question),
    maxEvidence: maxItems,
    maxBytes: 4_000,
    latencyBudgetMs: input.plan.retrievalBudgetMs ?? 3000,
    cursorContext,
  })
  const finalItems = repository.completionPack.evidence.map((item) =>
    bodyStatementEvidenceItemFromRepository(item, input.domainHints ?? []))
  const roleItems = annotateBodyStatementEvidenceRoles({
    items: finalItems,
    input: contextInput,
    currentFile,
    cursorContext,
  })
  const selected = selectBodyStatementPromptEvidence(roleItems, maxItems)
  const usefulEvidence = minimumUsefulEvidence(input.intent, selected, false)
  const trace = bodyStatementRepositoryTrace({
    repository,
    selected,
    allItems: roleItems,
    cursorContext,
    usefulEvidenceMet: usefulEvidence.met,
    retrievalStarted: input.retrievalStarted,
  })
  return {
    text: formatCEmbeddedEvidenceText(input.intent, selected, trace),
    items: selected,
    evidenceKinds: uniqueStrings(selected.map((item) => item.kind)),
    selectedEvidenceCount: selected.length,
    retrievalMode: repositoryCompletionRetrievalMode(repository),
    trace,
  }
}

function selectQaExactPromptEvidence(items: CEmbeddedEvidenceItem[], maxItems: number) {
  return selectCommentGuidedPromptEvidence(items, Math.max(1, Math.min(maxItems, 3)), "prefer-existing-helper")
}

function selectEvidenceItems(input: {
  result: QueryEvidenceResult | undefined
  intent: CompletionCIntent
  commentGuided?: boolean
  domainHints: string[]
  sourceMode: "graph" | "hybrid"
}) {
  const items: CEmbeddedEvidenceItem[] = []
  for (const evidence of input.result?.retrieval?.evidence ?? []) {
    const kind = evidenceKindForIntent(input.intent, evidence, Boolean(input.commentGuided))
    if (!kind) continue
    const source = evidence.reason.startsWith("vector:") ? "rag" : "graph"
    if (input.sourceMode === "graph" && source === "rag") continue
    items.push(evidenceItemFromGraphEvidence(evidence, kind, source, input.domainHints))
  }
  if (input.intent === "state-machine") {
    for (const machine of input.result?.stateMachines ?? []) {
      const item = evidenceItemFromStateMachine(machine, input.domainHints)
      if (item) items.push(item)
    }
  }
  return mergeEvidenceItems(items)
}

function evidenceKindForIntent(intent: CompletionCIntent, evidence: CodeGraphEvidence, commentGuided = false): CEmbeddedEvidenceKind | undefined {
  const reason = evidence.reason.toLowerCase()
  if (commentGuided) {
    if (reason.includes("comment-semantic-match")) return "c-comment-semantic-match"
    if (reason.includes("similar-function")) return "c-similar-function"
    if (reason.includes("similar-block")) return "c-similar-block"
    if (reason.includes("same-module-flow") || reason.includes("module match")) return "c-same-module-flow"
    if (reason.includes("helper-usage")) return "c-helper-usage"
  }
  switch (intent) {
    case "member-access":
      if (reason.includes("struct-definition") || reason.includes("struct-field")) return "c-struct-definition"
      if (reason.includes("base-type")) return "c-base-type"
      if (reason.includes("same-field-usage") || reason.includes("same-usage")) return "c-same-usage"
      return genericEvidenceKind(evidence)
    case "call-args":
      if (reason.includes("callee-signature")) return "c-callee-signature"
      if (reason.includes("return-handling")) return "c-return-handling"
      if (reason.includes("call-example") || reason.includes("call-site")) return "c-call-example"
      return genericEvidenceKind(evidence)
    case "initializer":
      if (reason.includes("struct-definition")) return "c-struct-definition"
      if (reason.includes("callback-signature")) return "c-callback-signature"
      if (reason.includes("initializer-example")) return "c-initializer-example"
      return genericEvidenceKind(evidence)
    case "error-path":
      if (reason.includes("cleanup-pattern")) return "c-cleanup-pattern"
      if (reason.includes("return-style")) return "c-return-style"
      if (reason.includes("error-label") || reason.includes("cleanup-label")) return "c-error-labels"
      return genericEvidenceKind(evidence)
    case "state-machine":
      if (reason.includes("state-") || reason.includes("state-context") || reason.includes("state-machine") || reason.includes("transition")) return "c-state-machine"
      return genericEvidenceKind(evidence)
    case "mmio-register":
      if (reason.includes("register-access")) return "c-register-access-example"
      if (reason.includes("register-family") || reason.includes("register-macro")) return "c-register-macro"
      if (isRegisterAccessSnippet(evidence.snippet)) return "c-register-access-example"
      if (isRegisterMacroSnippet(evidence.snippet)) return "c-register-macro"
      return genericEvidenceKind(evidence)
    default:
      return genericEvidenceKind(evidence)
  }
}

function genericEvidenceKind(evidence: CodeGraphEvidence): CEmbeddedEvidenceKind | undefined {
  const reason = evidence.reason.toLowerCase()
  const snippet = evidence.snippet
  const kind = evidence.kind
  if (kind === "macro" || /^\s*#\s*define\b/m.test(snippet)) return "c-macro-definition"
  if (kind === "type" || /\b(?:struct|union|enum|typedef)\b/.test(snippet) || reason.includes("type")) return "c-type-definition"
  if (kind === "include") return "c-local-context"
  if (kind === "function" || reason.includes("callee") || reason.includes("caller")) {
    return /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(snippet) ? "c-helper-usage" : "c-symbol-definition"
  }
  if (kind === "global") return "c-symbol-definition"
  if (kind === "text" || kind === "module") return "c-local-context"
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*;/.test(snippet) || reason.includes("call")) return "c-call-style"
  if (reason.includes("reference") || reason.includes("usage")) return "c-symbol-reference"
  if (reason.includes("symbol") || reason.includes("definition")) return "c-symbol-definition"
  return undefined
}

function isRegisterMacroSnippet(snippet: string) {
  return /^\s*#\s*define\s+[A-Z][A-Z0-9_]*(?:_REG|_MASK|_SHIFT|_BIT|_BITS|_CTRL|_CFG|_STATUS|_ENABLE|_DISABLE)\b/m.test(snippet) ||
    /\b(?:BIT|GENMASK|FIELD_PREP|FIELD_GET)\s*\(/.test(snippet)
}

function isRegisterAccessSnippet(snippet: string) {
  return /\b(?:readl|writel|readw|writew|readb|writeb|ioread(?:8|16|32|64)?|iowrite(?:8|16|32|64)?)\s*\(/.test(snippet) ||
    /\b(?:volatile|barrier|mb|rmb|wmb)\s*\(/.test(snippet)
}

function evidenceItemFromGraphEvidence(
  evidence: CodeGraphEvidence,
  kind: CEmbeddedEvidenceKind,
  source: CEmbeddedEvidenceItem["source"],
  domainHints: string[],
): CEmbeddedEvidenceItem {
  const domainBoostApplied = hasDomainBoost(evidence, domainHints)
  return {
    kind,
    name: evidenceName(evidence),
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    reason: evidence.reason,
    score: evidence.score + (domainBoostApplied ? 25 : 0),
    domainBoostApplied,
    source,
    text: evidence.snippet.trim(),
    tokenCoverage: commentGuidedTokenCoverageFromReason(evidence.reason),
  }
}

function evidenceItemFromRepositoryEvidence(evidence: RepositoryEvidenceItem, domainHints: string[], commentTokens?: CommentGuidedTokenGroups): CEmbeddedEvidenceItem {
  const source = evidence.source === "vector" ||
    evidence.source === "rerank" ||
    evidence.source === "hybrid" ||
    evidence.source === "semantic-rag" ||
    evidence.source === "semantic-rerank"
    ? "rag"
    : "graph"
  const text = evidence.snippet.trim()
  const item: CEmbeddedEvidenceItem = {
    kind: repositoryEvidenceKind(evidence),
    name: evidence.name,
    path: evidence.path ?? "",
    startLine: evidence.startLine ?? 1,
    endLine: evidence.endLine ?? evidence.startLine ?? 1,
    reason: evidence.reason ?? evidence.parserKind ?? "repository evidence",
    score: evidence.score,
    domainBoostApplied: false,
    source,
    text,
    tokenCoverage: commentTokens ? scoreCommentGuidedCandidate({
      comment: commentTokens,
      candidateText: [evidence.name, evidence.kind, evidence.reason, evidence.parserKind, evidence.snippet].filter(Boolean).join("\n"),
    }) : undefined,
  }
  return {
    ...item,
    domainBoostApplied: hasDomainBoost({
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      kind: "text",
      score: item.score,
      reason: item.reason,
      snippet: item.text,
    }, domainHints),
  }
}

function symbolPrefixEvidenceItemFromRepository(evidence: RepositoryEvidenceItem, domainHints: string[]) {
  const item = evidenceItemWithProjectionScore(evidence, domainHints)
  if (item.kind === "c-comment-semantic-match" && isFunctionDefinitionLike(item.text)) {
    return { ...item, kind: "c-helper-usage" as const }
  }
  if (item.kind === "c-same-module-flow") {
    return { ...item, kind: "c-local-context" as const }
  }
  return item
}

function bodyStatementEvidenceItemFromRepository(evidence: RepositoryEvidenceItem, domainHints: string[]) {
  const item = evidenceItemWithProjectionScore(evidence, domainHints)
  if (item.kind === "c-comment-semantic-match" && isFunctionDefinitionLike(item.text)) {
    return { ...item, kind: "c-helper-usage" as const }
  }
  if (item.kind === "c-same-module-flow") {
    return { ...item, kind: "c-local-context" as const }
  }
  return item
}

function evidenceItemWithProjectionScore(evidence: RepositoryEvidenceItem, domainHints: string[]) {
  const item = evidenceItemFromRepositoryEvidence(evidence, domainHints)
  return {
    ...item,
    score: evidence.projectionScore ?? item.score,
  }
}

function repositoryEvidenceKind(evidence: RepositoryEvidenceItem): CEmbeddedEvidenceKind {
  const reason = `${evidence.kind} ${evidence.reason ?? ""} ${evidence.parserKind ?? ""}`.toLowerCase()
  if (evidence.kind === "function" || evidence.parserKind === "function-summary" || /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(evidence.snippet)) {
    return "c-comment-semantic-match"
  }
  if (reason.includes("state")) return "c-state-machine"
  if (reason.includes("module") || reason.includes("summary")) return "c-same-module-flow"
  return "c-similar-block"
}

function annotateCommentGuidedEvidenceRoles(input: {
  items: CEmbeddedEvidenceItem[]
  input: CEmbeddedCompletionEvidenceInput & { intent: CompletionCIntent }
  commentTokens: CommentGuidedTokenGroups
  generationModeHint: CEmbeddedGenerationModeHint
}) {
  const currentPath = currentPathFromEvidenceQuestion(input.input.question) ?? input.input.relatedPaths[0] ?? ""
  const currentFunction = currentFunctionFromEvidenceQuestion(input.input.question)
  return input.items.map((item) => {
    const confidence = callableHelperConfidence({
      item,
      commentTokens: input.commentTokens,
      prefix: input.input.prefix ?? "",
      suffix: input.input.suffix ?? "",
      currentPath,
      currentFunction,
      nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.input.question),
    })
    const role = evidenceRoleForCommentGuidedItem({
      item,
      confidence,
      generationModeHint: input.generationModeHint,
      currentPath,
    })
    return {
      ...item,
      evidenceRole: role,
      helperCallableConfidence: confidence === "none" ? undefined : confidence,
    }
  })
}

function evidenceRoleForCommentGuidedItem(input: {
  item: CEmbeddedEvidenceItem
  confidence: CEmbeddedHelperCallableConfidence
  generationModeHint: CEmbeddedGenerationModeHint
  currentPath: string
}): CEmbeddedEvidenceRole {
  if (input.generationModeHint !== "continue-local-code" && (input.confidence === "high" || input.confidence === "medium")) {
    return "callable-helper"
  }
  const coverage = input.item.tokenCoverage
  if (
    input.item.kind === "c-comment-semantic-match" ||
    input.item.kind === "c-similar-function" ||
    input.item.kind === "c-similar-block" ||
    input.item.kind === "c-helper-usage"
  ) {
    if ((coverage?.actionTokenCoverage ?? 0) > 0 || (coverage?.objectTokenCoverage ?? 0) > 0) return "style-example"
  }
  if (input.item.kind === "c-same-module-flow" || sameRepositoryDirectory(input.item.path, input.currentPath)) return "local-flow"
  return "weak-context"
}

function annotateSymbolPrefixEvidenceRoles(input: {
  items: CEmbeddedEvidenceItem[]
  input: CEmbeddedCompletionEvidenceInput & { intent: CompletionCIntent }
  currentWord: string
  currentFile: string
  currentFunction?: string
  cursorContext: CommentGuidedCursorContextFeatures
}) {
  return input.items.map((item) => {
    const prefixCompatible = symbolPrefixCompatible(input.currentWord, item.name)
    const localFlowScore = symbolPrefixLocalFlowScore(item, input.cursorContext, input.currentFile)
    const broadUtility = isBroadUtilityEvidenceItem(item)
    let role: CEmbeddedEvidenceRole = "weak-context"
    if (prefixCompatible && isFunctionDefinitionLike(item.text) && !broadUtility) {
      role = "prefix-compatible-helper"
    } else if (prefixCompatible && broadUtility) {
      role = "weak-target-symbol"
    } else if (localFlowScore > 0 || sameRepositoryDirectory(item.path, input.currentFile)) {
      role = "local-flow"
    } else if (isFunctionDefinitionLike(item.text) || item.kind === "c-helper-usage" || item.kind === "c-comment-semantic-match") {
      role = "style-example"
    } else if (prefixCompatible) {
      role = "weak-target-symbol"
    }
    return {
      ...item,
      evidenceRole: role,
      helperCallableConfidence: role === "prefix-compatible-helper" ? "medium" as const : item.helperCallableConfidence,
      score: item.score + localFlowScore + (prefixCompatible ? 40 : 0) - (broadUtility ? 120 : 0),
    }
  })
}

function annotateBodyStatementEvidenceRoles(input: {
  items: CEmbeddedEvidenceItem[]
  input: CEmbeddedCompletionEvidenceInput & { intent: CompletionCIntent }
  currentFile: string
  cursorContext: CommentGuidedCursorContextFeatures
}) {
  return input.items.map((item) => {
    const localFlowScore = symbolPrefixLocalFlowScore(item, input.cursorContext, input.currentFile)
    const broadUtility = isBroadUtilityEvidenceItem(item)
    let role: CEmbeddedEvidenceRole = "weak-context"
    let confidence: CEmbeddedHelperCallableConfidence = "none"
    if (!broadUtility && (localFlowScore > 0 || sameRepositoryDirectory(item.path, input.currentFile))) {
      role = "local-flow"
    } else if (broadUtility && localFlowScore >= 160) {
      role = "local-flow"
    } else if (isFunctionDefinitionLike(item.text)) {
      role = "style-example"
    }
    if (
      role === "local-flow" &&
      isFunctionDefinitionLike(item.text) &&
      isStatementInsertionPosition(input.input.prefix ?? "", input.input.suffix ?? "") &&
      functionParamsCanBeSatisfied(item.text, input.input.prefix ?? "", nearbyIdentifiersFromEvidenceQuestion(input.input.question)) &&
      !broadUtility
    ) {
      confidence = localFlowScore >= 120 ? "medium" : "low"
    }
    if (broadUtility && role !== "local-flow") {
      role = "weak-context"
      confidence = "none"
    }
    return {
      ...item,
      evidenceRole: role,
      helperCallableConfidence: confidence === "none" ? item.helperCallableConfidence : confidence,
      score: item.score + localFlowScore - (broadUtility ? 120 : 0),
    }
  })
}

function selectSymbolPrefixPromptEvidence(items: CEmbeddedEvidenceItem[], maxItems: number, _currentWord: string | undefined) {
  const hasStrongerEvidence = items.some((item) =>
    item.evidenceRole === "local-flow" ||
    item.evidenceRole === "prefix-compatible-helper" ||
    item.evidenceRole === "style-example")
  const candidates = hasStrongerEvidence
    ? items.filter((item) => item.evidenceRole !== "weak-target-symbol" && item.evidenceRole !== "weak-context")
    : items
  const ranked = [...candidates].sort((left, right) =>
    symbolPrefixRolePriority(left) - symbolPrefixRolePriority(right) ||
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine)
  return ranked.slice(0, Math.max(1, Math.min(maxItems, 3)))
}

function selectBodyStatementPromptEvidence(items: CEmbeddedEvidenceItem[], maxItems: number) {
  const hasStrongerEvidence = items.some((item) => item.evidenceRole === "local-flow" || item.evidenceRole === "style-example")
  const candidates = hasStrongerEvidence ? items.filter((item) => item.evidenceRole !== "weak-context" && !isBroadUtilityEvidenceItem(item)) : items
  const ranked = [...candidates].sort((left, right) =>
    bodyStatementRolePriority(left) - bodyStatementRolePriority(right) ||
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine)
  const selected: CEmbeddedEvidenceItem[] = []
  const usedKeys = new Set<string>()
  const usedNames = new Set<string>()
  for (const item of ranked) {
    const key = evidenceItemKey(item)
    const name = item.name?.toLowerCase()
    if (usedKeys.has(key) || (name && usedNames.has(name))) continue
    selected.push(item)
    usedKeys.add(key)
    if (name) usedNames.add(name)
    if (selected.length >= Math.max(1, Math.min(maxItems, 3))) break
  }
  return selected
}

function bodyStatementRolePriority(item: CEmbeddedEvidenceItem) {
  switch (item.evidenceRole) {
    case "local-flow":
      return 0
    case "style-example":
      return 1
    case "callable-helper":
    case "prefix-compatible-helper":
      return 2
    default:
      return 3
  }
}

function symbolPrefixRolePriority(item: CEmbeddedEvidenceItem) {
  switch (item.evidenceRole) {
    case "local-flow":
      return 0
    case "style-example":
      return 1
    case "prefix-compatible-helper":
      return 2
    case "weak-target-symbol":
      return 3
    case "callable-helper":
      return 4
    default:
      return 5
  }
}

function callableHelperConfidence(input: {
  item: CEmbeddedEvidenceItem
  commentTokens: CommentGuidedTokenGroups
  prefix: string
  suffix: string
  currentPath: string
  currentFunction?: string
  nearbyIdentifiers: string[]
}): CEmbeddedHelperCallableConfidence {
  if (!isStatementInsertionPosition(input.prefix, input.suffix)) return "none"
  if (!isFunctionDefinitionLike(input.item.text)) return "none"
  if (
    input.currentFunction &&
    sameRepositoryPath(input.item.path, input.currentPath) &&
    input.item.name?.toLowerCase() === input.currentFunction.toLowerCase()
  ) {
    return "none"
  }
  const nameCoverage = scoreCommentGuidedCandidate({
    comment: input.commentTokens,
    candidateText: input.item.name ?? "",
  })
  const action = nameCoverage.actionTokenCoverage
  const object = nameCoverage.objectTokenCoverage
  const fallbackAction = input.item.tokenCoverage?.actionTokenCoverage ?? 0
  const fallbackObject = input.item.tokenCoverage?.objectTokenCoverage ?? 0
  const domainOnly = action <= 0 && object <= 0 && fallbackAction <= 0 && fallbackObject <= 0 && (input.item.tokenCoverage?.domainTokenCoverage ?? 0) > 0
  if (domainOnly) return "none"
  if (!functionParamsCanBeSatisfied(input.item.text, input.prefix, input.nearbyIdentifiers)) return "low"
  if (action >= 0.5 && object >= 0.5) return "high"
  if (action > 0 && object > 0) return "medium"
  return "none"
}

function generationModeHintForCommentGuided(
  input: CEmbeddedCompletionEvidenceInput & { intent: CompletionCIntent },
  items: CEmbeddedEvidenceItem[],
): CEmbeddedGenerationModeHint {
  if (input.intent !== "body-statement" || isPartialLocalCodePosition(input.prefix ?? "", input.suffix ?? "")) {
    return "continue-local-code"
  }
  const currentPath = currentPathFromEvidenceQuestion(input.question) ?? input.relatedPaths[0] ?? ""
  const currentFunction = currentFunctionFromEvidenceQuestion(input.question)
  const hasCallable = items.some((item) => {
    const confidence = callableHelperConfidence({
      item,
      commentTokens: normalizeCommentGuidedTokens(input.plan.sourceComment ?? input.question ?? ""),
      prefix: input.prefix ?? "",
      suffix: input.suffix ?? "",
      currentPath,
      currentFunction,
      nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.question),
    })
    return confidence === "high" || confidence === "medium"
  })
  return hasCallable ? "prefer-existing-helper" : "synthesize-from-style"
}

function selectCommentGuidedPromptEvidence(
  items: CEmbeddedEvidenceItem[],
  maxItems: number,
  generationModeHint: CEmbeddedGenerationModeHint,
) {
  const ranked = [...items].sort((left, right) =>
    commentGuidedRolePriority(left, generationModeHint) - commentGuidedRolePriority(right, generationModeHint) ||
    commentGuidedCoverageRank(right) - commentGuidedCoverageRank(left) ||
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine)
  return ranked.slice(0, Math.max(1, maxItems))
}

function commentGuidedRolePriority(item: CEmbeddedEvidenceItem, generationModeHint: CEmbeddedGenerationModeHint) {
  const role = item.evidenceRole ?? "weak-context"
  if (generationModeHint === "continue-local-code") {
    if (role === "style-example") return 0
    if (role === "local-flow") return 1
    if (role === "weak-context") return 2
    return 3
  }
  if (generationModeHint === "prefer-existing-helper") {
    if (role === "callable-helper") return 0
    if (role === "style-example") return 1
    if (role === "local-flow") return 2
    return 3
  }
  if (role === "style-example") return 0
  if (role === "local-flow") return 1
  if (role === "callable-helper") return 2
  return 3
}

function commentGuidedCoverageRank(item: CEmbeddedEvidenceItem) {
  const coverage = item.tokenCoverage
  if (!coverage) return 0
  return coverage.actionTokenCoverage * 1000 + coverage.objectTokenCoverage * 800 + coverage.domainTokenCoverage * 100
}

function isStatementInsertionPosition(prefix: string, suffix: string) {
  const linePrefix = prefix.replace(/\r\n/g, "\n").split("\n").at(-1) ?? ""
  const lineSuffix = suffix.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
  if (/\b(?:if|while|for|switch)\s*\([^)]*$/.test(linePrefix)) return false
  if (/(?:->|\.|=|\+|-|\*|\/|%|&&|\|\||,|\()\s*$/.test(linePrefix)) return false
  if (/^\s*(?:[)\]}]|==|!=|<=|>=|&&|\|\||,)/.test(lineSuffix)) return false
  return true
}

function isPartialLocalCodePosition(prefix: string, suffix: string) {
  const linePrefix = prefix.replace(/\r\n/g, "\n").split("\n").at(-1) ?? ""
  const lineSuffix = suffix.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
  return /\b(?:if|while|for|switch)\s*\([^)]*$/.test(linePrefix) ||
    /(?:->|\.|=|\+|-|\*|\/|%|&&|\|\||,|\()\s*$/.test(linePrefix) ||
    /^\s*(?:[)\]}]|==|!=|<=|>=|&&|\|\||,)/.test(lineSuffix)
}

function isFunctionDefinitionLike(text: string) {
  return /^\s*(?:static\s+)?(?:inline\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|;)/m.test(text.trim())
}

function symbolPrefixCompatible(currentWord: string | undefined, name: string | undefined) {
  const prefix = currentWord?.trim().toLowerCase() ?? ""
  const candidate = name?.trim().toLowerCase() ?? ""
  return prefix.length >= 2 && candidate.startsWith(prefix) && candidate.length > prefix.length
}

function symbolPrefixLocalFlowScore(item: CEmbeddedEvidenceItem, features: CommentGuidedCursorContextFeatures, currentFile: string) {
  const candidateTokens = new Set(`${item.name ?? ""}\n${item.path}\n${item.reason}\n${item.text}`.split(/[^A-Za-z0-9_]+/).map((token) => token.toLowerCase()).filter((token) => token.length > 2))
  const localTokens = [
    features.currentFunctionName,
    ...features.previousStatementCalls,
    ...features.nextStatementCalls,
    ...features.nearbyLogOrMessageText,
  ].flatMap((value) => typeof value === "string" ? value.split(/[^A-Za-z0-9_]+/) : [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2)
  let score = sameRepositoryDirectory(item.path, currentFile) ? 80 : 0
  const seen = new Set<string>()
  for (const token of localTokens) {
    if (seen.has(token) || !candidateTokens.has(token)) continue
    seen.add(token)
    score += 45
  }
  return Math.min(score, 260)
}

function isBroadUtilityEvidenceItem(item: CEmbeddedEvidenceItem) {
  return isBroadUtilityName(`${item.name ?? ""}\n${item.reason}`)
}

function isBroadUtilityRepositoryEvidence(item: RepositoryEvidenceItem) {
  return isBroadUtilityName(`${item.name ?? ""}\n${item.reason ?? ""}`)
}

function isBroadUtilityName(input: string) {
  const text = input.toLowerCase()
  const tokens = text.split(/[^a-z0-9]+|_/).filter(Boolean)
  return tokens.some((token) => /^(?:dump|debug|dbg|print|printf|trace|log)/.test(token))
}

function sameRepositoryPath(left: string, right: string) {
  if (!left || !right) return false
  const normalizedLeft = normalizePath(left)
  const normalizedRight = normalizePath(right)
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
}

function sameRepositoryDirectory(left: string, right: string) {
  if (!left || !right) return false
  const leftParts = normalizePath(left).split("/")
  const rightParts = normalizePath(right).split("/")
  leftParts.pop()
  rightParts.pop()
  const leftDir = leftParts.join("/")
  const rightDir = rightParts.join("/")
  return leftDir === rightDir ||
    leftDir.endsWith(`/${rightDir}`) ||
    rightDir.endsWith(`/${leftDir}`)
}

function functionParamsCanBeSatisfied(text: string, prefix: string, nearbyIdentifiers: string[]) {
  const params = firstFunctionParams(text)
  if (params === undefined) return true
  const normalized = params.trim()
  if (!normalized || normalized === "void") return true
  const paramNames = normalized.split(",").map((param) =>
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(param.trim())?.[1] ?? "",
  ).filter(Boolean)
  if (paramNames.length === 0) return true
  const visible = new Set([
    ...nearbyIdentifiers,
    ...prefix.split(/[^A-Za-z0-9_]+/),
  ].map((token) => token.toLowerCase()).filter((token) => token.length >= 2))
  return paramNames.every((name) => visible.has(name.toLowerCase())) || paramNames.length <= 1
}

function firstFunctionParams(text: string) {
  return /^[^{;\n]*\b[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/m.exec(text.trim())?.[1]
}

function aggregateHelperConfidence(items: CEmbeddedEvidenceItem[]): CEmbeddedHelperCallableConfidence {
  if (items.some((item) => item.helperCallableConfidence === "high")) return "high"
  if (items.some((item) => item.helperCallableConfidence === "medium")) return "medium"
  if (items.some((item) => item.helperCallableConfidence === "low")) return "low"
  return "none"
}

function droppedAlignedEvidence(fullTopK: string[], selectedTopK: string[]) {
  const selected = new Set(selectedTopK)
  return fullTopK.filter((name) => !selected.has(name)).slice(0, 8)
}

function droppedProjectedEvidence(projected: string[], actualPrompt: string[]) {
  const actual = new Set(actualPrompt)
  return projected.filter((name) => !actual.has(name)).slice(0, 8)
}

function projectionToPromptDropReason(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  expectedSymbol?: string
}) {
  const expected = input.expectedSymbol?.trim()
  if (!expected) return undefined
  const projectionNames = candidateNames(input.repository.completionProjectionRanked)
  if (!projectionNames.includes(expected)) return "not-in-projection"
  const selectedNames = uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean))
  if (selectedNames.includes(expected) || input.selected.some((item) => item.text.includes(expected))) return undefined
  if (input.repository.completionPack.truncated) return "evidence-budget"
  return "weaker-role-score"
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^file:\/\//, "")
}

function commentGuidedRepositoryTrace(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  allItems: CEmbeddedEvidenceItem[]
  commentTokens: CommentGuidedTokenGroups
  cursorContext: CommentGuidedCursorContextFeatures
  expectedSymbol?: string
  generationModeHint: CEmbeddedGenerationModeHint
  usefulEvidenceMet: boolean
  retrievalStarted: number
  retrievalBudgetMs: number | undefined
}): CEmbeddedEvidenceTrace {
  const qaRetrievalTopK = input.repository.trace.topCandidateNames
  const completionRetrievalTopK = input.repository.trace.selectedCandidateNames
  const qaTopCandidate = qaRetrievalTopK[0]
  const completionTopCandidate = completionRetrievalTopK[0]
  const telemetryCandidates = input.repository.fullTopK.filter((item) => item.name).slice(0, 8)
  const expected = input.expectedSymbol?.trim()
  const actualPromptEvidenceNames = uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean))
  const projectedEvidenceNames = input.repository.trace.projectedEvidenceNames ?? input.repository.trace.selectedCandidateNames
  const projectionTopK = input.repository.trace.projectionTopK ?? candidateNames(input.repository.completionProjectionRanked).slice(0, 8)
  const projectedTopCandidate = projectedEvidenceNames[0]
  return {
    ragFallbackTriggered: input.repository.trace.retrievalMode === "graph-only-fallback",
    ragFallbackReason: input.repository.trace.alignmentReason === "graph-only-fallback" ? "shared repository evidence fell back to graph-only retrieval" : undefined,
    graphEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "graph" || item.source === "graph-comment-guided" || item.source === "local-flow").length,
    ragEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "vector" || item.source === "rerank" || item.source === "hybrid" || item.source === "semantic-rag" || item.source === "semantic-rerank").length,
    finalSelectedEvidenceCount: input.selected.length,
    minimumUsefulEvidenceMet: input.usefulEvidenceMet,
    normalizedCommentTokens: input.commentTokens.normalizedTokens,
    candidateTokenCoverage: input.selected.flatMap(evidenceTokenCoverageTelemetry),
    semanticCandidateTopK: telemetryCandidates.map((item) => {
      const coverage = scoreCommentGuidedCandidate({
        comment: input.commentTokens,
        candidateText: [item.name, item.kind, item.reason, item.parserKind, item.snippet].filter(Boolean).join("\n"),
      })
      return {
        name: item.name,
        kind: repositoryEvidenceKind(item),
        score: Math.round(item.score),
        actionTokenCoverage: coverage.actionTokenCoverage,
        objectTokenCoverage: coverage.objectTokenCoverage,
        domainTokenCoverage: coverage.domainTokenCoverage,
      }
    }),
    selectedSimilarFunctionNames: uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean)),
    retrievalElapsedMs: input.repository.trace.latencyMs,
    retrievalBudgetMs: input.repository.trace.latencyBudgetMs,
    retrievalTimedOut: input.repository.trace.timedOut,
    timeoutStage: input.repository.trace.timeoutStage,
    qaAlignedEvidence: Boolean(qaTopCandidate && completionRetrievalTopK.includes(qaTopCandidate)),
    qaTopCandidate,
    completionTopCandidate,
    sharedTopCandidate: qaTopCandidate,
    qaRetrievalTopK,
    completionRetrievalTopK,
    alignmentReason: input.repository.trace.alignmentReason,
    rerankEnabled: input.repository.trace.rerankEnabled,
    ragAvailable: input.repository.trace.ragAvailable,
    latencyBudgetMs: input.repository.trace.latencyBudgetMs,
    maxEvidence: input.repository.completionPack.evidence.length,
    evidenceRoles: uniqueStrings(input.selected.map((item) => item.evidenceRole ?? "weak-context")),
    generationModeHint: input.generationModeHint,
    helperCallableConfidence: aggregateHelperConfidence(input.selected),
    callableHelperCandidates: uniqueStrings(input.allItems
      .filter((item) => item.evidenceRole === "callable-helper" && item.name)
      .map((item) => item.name ?? "")),
    styleExampleCandidates: uniqueStrings(input.allItems
      .filter((item) => item.evidenceRole === "style-example" && item.name)
      .map((item) => item.name ?? "")),
    qaStyleTopK: input.repository.trace.topCandidateNames,
    completionProjectionTopK: input.repository.trace.selectedCandidateNames,
    droppedAlignedEvidence: droppedAlignedEvidence(input.repository.trace.topCandidateNames, input.repository.trace.selectedCandidateNames),
    cursorContextFeatures: input.cursorContext,
    cursorContextScope: input.cursorContext.cursorContextScope,
    currentFunctionBodyIsEmpty: input.cursorContext.currentFunctionBodyIsEmpty,
    scopedPreviousStatementCalls: input.cursorContext.scopedPreviousStatementCalls,
    scopedNextStatementCalls: input.cursorContext.scopedNextStatementCalls,
    cursorContextFallbackReason: input.cursorContext.cursorContextFallbackReason,
    fullRetrievalCandidateCount: input.repository.trace.fullCandidateCount,
    projectionCandidateCount: input.repository.trace.projectionCandidateCount,
    retrievalShape: input.repository.trace.retrievalShape,
    qaExactTopK: input.repository.trace.qaExactTopK,
    qaExactSubmittedEvidence: input.repository.trace.qaExactSubmittedEvidence,
    qaExactContextTopK: input.repository.trace.qaExactContextTopK,
    semanticQueryText: input.repository.trace.semanticQueryText,
    graphQuestionTextHash: input.repository.trace.graphQuestionTextHash,
    semanticTopK: input.repository.trace.semanticTopK,
    graphTopK: input.repository.trace.graphTopK,
    mergedTopK: input.repository.trace.mergedTopK,
    selectedPromptEvidenceNames: actualPromptEvidenceNames,
    rawSemanticTopK: input.repository.trace.rawSemanticTopK ?? input.repository.trace.semanticTopK,
    rawGraphTopK: input.repository.trace.rawGraphTopK ?? input.repository.trace.graphTopK,
    mergedRetrievalTopK: input.repository.trace.mergedRetrievalTopK ?? input.repository.trace.mergedTopK,
    projectionTopK,
    projectedEvidenceNames,
    actualPromptEvidenceNames,
    droppedProjectedEvidenceNames: droppedProjectedEvidence(projectedEvidenceNames, actualPromptEvidenceNames),
    rawTop1Aligned: input.repository.trace.rawTop1Aligned ?? Boolean(qaTopCandidate && qaTopCandidate === projectedTopCandidate),
    retrievalRecallAligned: input.repository.trace.retrievalRecallAligned ?? Boolean(projectedTopCandidate && qaRetrievalTopK.includes(projectedTopCandidate)),
    projectionSelectedStrongHelper: input.repository.trace.projectionSelectedStrongHelper ?? Boolean(input.selected.some((item) => item.evidenceRole === "callable-helper")),
    promptContainsProjectedHelper: input.repository.trace.promptContainsProjectedHelper ?? Boolean(projectedTopCandidate && actualPromptEvidenceNames.includes(projectedTopCandidate)),
    probeAffectsPrompt: false,
    probeCompleted: input.repository.trace.probeCompleted,
    projectionToPromptDropReason: projectionToPromptDropReason(input),
    submittedEvidenceNames: actualPromptEvidenceNames,
    expectedSymbolInQaExactRetrieval: expected && input.repository.trace.retrievalShape === "qa-exact" ? candidateNames(input.repository.fullTopK).includes(expected) : undefined,
    expectedSymbolInFullRetrieval: expected ? candidateNames(input.repository.fullTopK).includes(expected) : undefined,
    expectedSymbolInProjection: expected ? candidateNames(input.repository.completionProjectionRanked).includes(expected) : undefined,
    expectedSymbolInPrompt: expected ? input.selected.some((item) => item.name === expected || item.text.includes(expected)) : undefined,
  }
}

function bodyStatementRepositoryTrace(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  allItems: CEmbeddedEvidenceItem[]
  cursorContext: CommentGuidedCursorContextFeatures
  usefulEvidenceMet: boolean
  retrievalStarted: number
}): CEmbeddedEvidenceTrace {
  const topCandidateNames = input.repository.trace.topCandidateNames
  const projectedNames = candidateNames(input.repository.completionProjectionRanked).slice(0, 8)
  const selectedNames = uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean))
  return {
    ragFallbackTriggered: input.repository.trace.retrievalMode === "graph-only-fallback",
    ragFallbackReason: input.repository.trace.alignmentReason === "graph-only-fallback" ? "shared repository body-statement evidence fell back to graph-only retrieval" : undefined,
    graphEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "graph" || item.source === "graph-comment-guided" || item.source === "local-flow").length,
    ragEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "vector" || item.source === "rerank" || item.source === "hybrid" || item.source === "semantic-rag" || item.source === "semantic-rerank").length,
    finalSelectedEvidenceCount: input.selected.length,
    minimumUsefulEvidenceMet: input.usefulEvidenceMet,
    retrievalElapsedMs: input.repository.trace.latencyMs,
    retrievalBudgetMs: input.repository.trace.latencyBudgetMs,
    retrievalTimedOut: input.repository.trace.timedOut,
    timeoutStage: input.repository.trace.timeoutStage,
    qaAlignedEvidence: Boolean(topCandidateNames[0] && projectedNames.includes(topCandidateNames[0]!)),
    qaTopCandidate: topCandidateNames[0],
    completionTopCandidate: selectedNames[0] ?? projectedNames[0],
    sharedTopCandidate: topCandidateNames[0],
    qaRetrievalTopK: topCandidateNames,
    completionRetrievalTopK: selectedNames.length > 0 ? selectedNames : projectedNames,
    alignmentReason: input.repository.trace.alignmentReason,
    rerankEnabled: input.repository.trace.rerankEnabled,
    ragAvailable: input.repository.trace.ragAvailable,
    latencyBudgetMs: input.repository.trace.latencyBudgetMs,
    maxEvidence: input.repository.completionPack.evidence.length,
    evidenceRoles: uniqueStrings(input.selected.map((item) => item.evidenceRole ?? "weak-context")),
    generationModeHint: "synthesize-from-style",
    helperCallableConfidence: aggregateHelperConfidence(input.selected),
    callableHelperCandidates: uniqueStrings(input.allItems
      .filter((item) => item.helperCallableConfidence && item.name)
      .map((item) => item.name ?? "")),
    styleExampleCandidates: uniqueStrings(input.allItems
      .filter((item) => item.evidenceRole === "style-example" && item.name)
      .map((item) => item.name ?? "")),
    qaStyleTopK: topCandidateNames,
    completionProjectionTopK: projectedNames,
    droppedAlignedEvidence: droppedAlignedEvidence(topCandidateNames, selectedNames),
    cursorContextFeatures: input.cursorContext,
    cursorContextScope: input.cursorContext.cursorContextScope,
    currentFunctionBodyIsEmpty: input.cursorContext.currentFunctionBodyIsEmpty,
    scopedPreviousStatementCalls: input.cursorContext.scopedPreviousStatementCalls,
    scopedNextStatementCalls: input.cursorContext.scopedNextStatementCalls,
    cursorContextFallbackReason: input.cursorContext.cursorContextFallbackReason,
    fullRetrievalCandidateCount: input.repository.trace.fullCandidateCount,
    projectionCandidateCount: input.repository.trace.projectionCandidateCount,
    retrievalShape: input.repository.trace.retrievalShape,
    semanticQueryText: input.repository.trace.queryText,
    projectionTopK: projectedNames,
    projectedEvidenceNames: projectedNames,
    actualPromptEvidenceNames: selectedNames,
    droppedProjectedEvidenceNames: droppedProjectedEvidence(projectedNames, selectedNames),
    rawTop1Aligned: Boolean(topCandidateNames[0] && topCandidateNames[0] === projectedNames[0]),
    retrievalRecallAligned: Boolean(projectedNames[0] && topCandidateNames.includes(projectedNames[0])),
    projectionSelectedStrongHelper: input.selected.some((item) => item.evidenceRole === "local-flow" || item.evidenceRole === "style-example"),
    promptContainsProjectedHelper: Boolean(projectedNames[0] && selectedNames.includes(projectedNames[0])),
    probeAffectsPrompt: false,
    probeCompleted: false,
    submittedEvidenceNames: selectedNames,
  }
}

function symbolPrefixRepositoryTrace(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  allItems: CEmbeddedEvidenceItem[]
  currentWord: string
  cursorContext: CommentGuidedCursorContextFeatures
  usefulEvidenceMet: boolean
  retrievalStarted: number
}): CEmbeddedEvidenceTrace {
  const topCandidateNames = input.repository.trace.topCandidateNames
  const projectedNames = candidateNames(input.repository.completionProjectionRanked).slice(0, 8)
  const selectedNames = uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean))
  const compatibilityScores = input.repository.completionProjectionRanked.slice(0, 8).map((item) => {
    const name = item.name
    const broadUtility = isBroadUtilityRepositoryEvidence(item)
    const localFlowScore = (item.cursorContextScores?.currentFunctionFlowScore ?? 0) +
      (item.cursorContextScores?.neighborCallProximityScore ?? 0) +
      (item.cursorContextScores?.messageTextSimilarityScore ?? 0)
    return {
      name,
      prefixCompatible: symbolPrefixCompatible(input.currentWord, name),
      localFlowScore,
      projectionScore: Math.round(item.projectionScore ?? item.score),
      broadUtility,
    }
  })
  return {
    ragFallbackTriggered: input.repository.trace.retrievalMode === "graph-only-fallback",
    ragFallbackReason: input.repository.trace.alignmentReason === "graph-only-fallback" ? "shared repository evidence fell back to graph-only retrieval" : undefined,
    graphEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "graph" || item.source === "graph-comment-guided" || item.source === "local-flow").length,
    ragEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "vector" || item.source === "rerank" || item.source === "hybrid" || item.source === "semantic-rag" || item.source === "semantic-rerank").length,
    finalSelectedEvidenceCount: input.selected.length,
    minimumUsefulEvidenceMet: input.usefulEvidenceMet,
    retrievalElapsedMs: input.repository.trace.latencyMs,
    retrievalBudgetMs: input.repository.trace.latencyBudgetMs,
    retrievalTimedOut: input.repository.trace.timedOut,
    timeoutStage: input.repository.trace.timeoutStage,
    qaAlignedEvidence: Boolean(topCandidateNames[0] && projectedNames.includes(topCandidateNames[0]!)),
    qaTopCandidate: topCandidateNames[0],
    completionTopCandidate: selectedNames[0] ?? projectedNames[0],
    sharedTopCandidate: topCandidateNames[0],
    qaRetrievalTopK: topCandidateNames,
    completionRetrievalTopK: selectedNames.length > 0 ? selectedNames : projectedNames,
    alignmentReason: input.repository.trace.alignmentReason,
    rerankEnabled: input.repository.trace.rerankEnabled,
    ragAvailable: input.repository.trace.ragAvailable,
    latencyBudgetMs: input.repository.trace.latencyBudgetMs,
    maxEvidence: input.repository.completionPack.evidence.length,
    evidenceRoles: uniqueStrings(input.selected.map((item) => item.evidenceRole ?? "weak-context")),
    generationModeHint: "continue-local-code",
    helperCallableConfidence: aggregateHelperConfidence(input.selected),
    callableHelperCandidates: uniqueStrings(input.allItems
      .filter((item) => item.evidenceRole === "prefix-compatible-helper" && item.name)
      .map((item) => item.name ?? "")),
    styleExampleCandidates: uniqueStrings(input.allItems
      .filter((item) => item.evidenceRole === "style-example" && item.name)
      .map((item) => item.name ?? "")),
    completionProjectionTopK: projectedNames,
    droppedAlignedEvidence: droppedAlignedEvidence(topCandidateNames, selectedNames),
    cursorContextFeatures: input.cursorContext,
    cursorContextScope: input.cursorContext.cursorContextScope,
    currentFunctionBodyIsEmpty: input.cursorContext.currentFunctionBodyIsEmpty,
    scopedPreviousStatementCalls: input.cursorContext.scopedPreviousStatementCalls,
    scopedNextStatementCalls: input.cursorContext.scopedNextStatementCalls,
    cursorContextFallbackReason: input.cursorContext.cursorContextFallbackReason,
    fullRetrievalCandidateCount: input.repository.trace.fullCandidateCount,
    projectionCandidateCount: input.repository.trace.projectionCandidateCount,
    retrievalShape: input.repository.trace.retrievalShape,
    semanticQueryText: input.repository.trace.queryText,
    projectionTopK: projectedNames,
    projectedEvidenceNames: projectedNames,
    actualPromptEvidenceNames: selectedNames,
    droppedProjectedEvidenceNames: droppedProjectedEvidence(projectedNames, selectedNames),
    rawTop1Aligned: Boolean(topCandidateNames[0] && topCandidateNames[0] === projectedNames[0]),
    retrievalRecallAligned: Boolean(projectedNames[0] && topCandidateNames.includes(projectedNames[0])),
    projectionSelectedStrongHelper: input.selected.some((item) => item.evidenceRole === "prefix-compatible-helper" || item.evidenceRole === "local-flow"),
    promptContainsProjectedHelper: Boolean(projectedNames[0] && selectedNames.includes(projectedNames[0])),
    probeAffectsPrompt: false,
    probeCompleted: false,
    submittedEvidenceNames: selectedNames,
    symbolPrefixRetrievalShape: input.repository.trace.retrievalShape === "qa-semantic" ? "qa-semantic" : "shared-repository",
    symbolPrefixLocalTopK: input.repository.completionProjectionRanked
      .filter((item) => {
        const scores = item.cursorContextScores
        return Boolean(scores && scores.currentFunctionFlowScore + scores.neighborCallProximityScore + scores.messageTextSimilarityScore > 0)
      })
      .flatMap((item) => item.name ? [item.name] : [])
      .slice(0, 8),
    symbolPrefixProjectedEvidenceNames: projectedNames,
    typedPrefixCompatibleCandidates: input.repository.trace.typedPrefixCompatibleCandidates,
    typedPrefixCompatiblePromptNames: selectedNames.filter((name) => symbolPrefixCompatible(input.currentWord, name)),
    symbolPrefixSemanticQueryText: input.repository.trace.symbolPrefixSemanticQueryText,
    symbolPrefixSemanticTopK: input.repository.trace.symbolPrefixSemanticTopK,
    symbolPrefixGraphTopK: input.repository.trace.symbolPrefixGraphTopK,
    symbolPrefixMergedTopK: input.repository.trace.symbolPrefixMergedTopK,
    symbolPrefixRerankTopK: input.repository.trace.symbolPrefixRerankTopK,
    symbolPrefixSemanticSelectedNames: input.repository.trace.symbolPrefixSemanticSelectedNames,
    symbolPrefixPrefixCompatibleNames: input.repository.trace.symbolPrefixPrefixCompatibleNames,
    symbolPrefixSemanticVsPrefixDiverged: input.repository.trace.symbolPrefixSemanticVsPrefixDiverged,
    symbolPrefixSelectionReason: input.repository.trace.symbolPrefixSelectionReason,
    symbolPrefixCurrentFunctionTokens: input.repository.trace.symbolPrefixCurrentFunctionTokens,
    symbolPrefixNonPrefixDroppedNames: uniqueStrings([
      ...(input.repository.trace.symbolPrefixNonPrefixDroppedNames ?? []),
      ...input.allItems
        .filter((item) => item.name && !selectedNames.includes(item.name) && !symbolPrefixCompatible(input.currentWord, item.name))
        .map((item) => item.name ?? ""),
    ]).slice(0, 8),
    symbolPrefixProjectionReasons: input.repository.trace.symbolPrefixProjectionReasons,
    symbolPrefixCompatibilityScores: compatibilityScores,
  }
}

function commentGuidedFullRetrievalDebugDump(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  sourceComment: string
  currentFile: string
  currentFunction?: string
  commentTokens: CommentGuidedTokenGroups
  cursorContext: CommentGuidedCursorContextFeatures
  expectedSymbol?: string
  requestId?: string
  trace: CEmbeddedEvidenceTrace
}): CEmbeddedFullRetrievalDebugDump {
  const expected = input.expectedSymbol?.trim()
  const fullNames = candidateNames(input.repository.fullTopK)
  const projectionNames = candidateNames(input.repository.completionProjectionRanked)
  const submittedNames = uniqueStrings(input.selected.map((item) => item.name ?? "").filter(Boolean))
  return {
    requestId: input.requestId,
    sourceComment: input.sourceComment,
    currentFile: input.currentFile,
    currentFunction: input.currentFunction,
    normalizedCommentTokens: input.commentTokens.normalizedTokens,
    cursorContextFeatures: input.cursorContext,
    queryText: input.repository.trace.queryText,
    retrievalMode: input.repository.trace.retrievalMode,
    retrievalElapsedMs: input.repository.trace.latencyMs,
    retrievalBudgetMs: input.repository.trace.latencyBudgetMs,
    retrievalTimedOut: input.repository.trace.timedOut,
    retrievalShape: input.repository.trace.retrievalShape,
    rerankEnabled: input.repository.trace.rerankEnabled,
    ragAvailable: input.repository.trace.ragAvailable,
    qaExactTopK: input.repository.trace.qaExactTopK,
    qaExactSubmittedEvidence: input.repository.trace.qaExactSubmittedEvidence,
    qaExactContextTopK: input.repository.trace.qaExactContextTopK,
    semanticQueryText: input.repository.trace.semanticQueryText,
    graphQuestionTextHash: input.repository.trace.graphQuestionTextHash,
    semanticTopK: input.repository.trace.semanticTopK,
    graphTopK: input.repository.trace.graphTopK,
    mergedTopK: input.repository.trace.mergedTopK,
    rawSemanticTopK: input.trace.rawSemanticTopK,
    rawGraphTopK: input.trace.rawGraphTopK,
    mergedRetrievalTopK: input.trace.mergedRetrievalTopK,
    projectionTopK: input.trace.projectionTopK,
    projectedEvidenceNames: input.trace.projectedEvidenceNames,
    actualPromptEvidenceNames: input.trace.actualPromptEvidenceNames,
    droppedProjectedEvidenceNames: input.trace.droppedProjectedEvidenceNames,
    probeAffectsPrompt: input.trace.probeAffectsPrompt,
    probeCompleted: input.trace.probeCompleted,
    selectedPromptEvidenceNames: submittedNames,
    projectionToPromptDropReason: input.trace.projectionToPromptDropReason,
    expectedSymbol: expected || undefined,
    expectedSymbolPresence: {
      qaExactRetrieval: expected && input.repository.trace.retrievalShape === "qa-exact" ? fullNames.includes(expected) : undefined,
      fullRetrieval: expected ? fullNames.includes(expected) : false,
      projection: expected ? projectionNames.includes(expected) : false,
      submittedEvidence: expected ? submittedNames.includes(expected) : false,
      finalPrompt: input.trace.expectedSymbolInPrompt,
    },
    fullRetrievalTopK: debugCandidates(input.repository.fullTopK, input.commentTokens, 200),
    completionProjectionRankedTopK: debugCandidates(input.repository.completionProjectionRanked, input.commentTokens, 200),
    completionPackSubmitted: debugCandidates(input.repository.completionPack.evidence, input.commentTokens, 20),
  }
}

function debugCandidates(items: RepositoryEvidenceItem[], commentTokens: CommentGuidedTokenGroups, limit: number): CEmbeddedRetrievalDebugCandidate[] {
  return items.slice(0, limit).map((item, index) => {
    const coverage = scoreCommentGuidedCandidate({
      comment: commentTokens,
      candidateText: [item.name, item.kind, item.reason, item.parserKind, item.snippet].filter(Boolean).join("\n"),
    })
    return {
      rank: index + 1,
      name: item.name,
      kind: item.kind,
      source: item.source,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      score: Math.round(item.score),
      projectionScore: item.projectionScore !== undefined ? Math.round(item.projectionScore) : undefined,
      reason: item.reason,
      snippetPreview: oneLine(item.snippet, 500),
      actionTokenCoverage: coverage.actionTokenCoverage,
      objectTokenCoverage: coverage.objectTokenCoverage,
      domainTokenCoverage: coverage.domainTokenCoverage,
      cursorContextScores: item.cursorContextScores,
    }
  })
}

function candidateNames(items: Array<{ name?: string }>) {
  return uniqueStrings(items.map((item) => item.name ?? "").filter(Boolean))
}

function repositoryCompletionRetrievalMode(repository: RepositoryEvidenceResult): CEmbeddedCompletionEvidenceResult["retrievalMode"] {
  switch (repository.trace.retrievalMode) {
    case "hybrid":
    case "vector":
      return "hybrid"
    case "graph":
    case "graph-only-fallback":
    case "cached":
      return repository.fullTopK.length ? "graph-only" : "none"
  }
}

function evidenceItemFromStateMachine(machine: StateMachine, domainHints: string[]): CEmbeddedEvidenceItem | undefined {
  const firstEvidence = machine.evidence[0] ?? machine.transitions[0]?.evidence ?? machine.states[0]?.definitionRange
  if (!firstEvidence) return undefined
  const text = [
    `state-machine: ${machine.name}`,
    `state-var: ${machine.stateVar}`,
    `states: ${machine.states.map((state) => state.name).slice(0, 16).join(", ")}`,
    machine.transitions.length
      ? `transitions: ${machine.transitions.slice(0, 8).map((transition) => `${transition.fromState}->${transition.toState}`).join(", ")}`
      : "",
    firstEvidence.snippet ?? "",
  ].filter(Boolean).join("\n")
  const domainBoostApplied = domainHints.some((hint) => text.toLowerCase().includes(hint.toLowerCase()) || firstEvidence.file.toLowerCase().includes(hint.toLowerCase()))
  return {
    kind: "c-state-machine",
    name: machine.name,
    path: firstEvidence.file,
    startLine: firstEvidence.startLine,
    endLine: firstEvidence.endLine,
    reason: "completion state-machine transition-context",
    score: 260 + (domainBoostApplied ? 25 : 0),
    domainBoostApplied,
    source: "graph",
    text,
  }
}

function minimumUsefulEvidence(intent: CompletionCIntent, items: CEmbeddedEvidenceItem[], commentGuided = false) {
  const has = (kind: CEmbeddedEvidenceKind) => items.some((item) => item.kind === kind)
  if (commentGuided) {
    return useful(
      has("c-comment-semantic-match") || has("c-similar-function") || has("c-similar-block"),
      "comment-guided code needs a semantic match, similar function, or similar block",
    )
  }
  switch (intent) {
    case "member-access":
      return useful((has("c-base-type") || has("c-struct-definition")) && items.length >= 2, "member-access needs base type or struct definition plus one more graph evidence item")
    case "call-args":
      return useful(has("c-callee-signature") && has("c-call-example"), "call-args needs callee signature and at least one call example")
    case "initializer":
      return useful((has("c-struct-definition") || has("c-initializer-example")) && items.length >= 2, "initializer needs struct definition or initializer example plus one more graph evidence item")
    case "error-path":
      return useful(has("c-error-labels") || has("c-cleanup-pattern"), "error-path needs same-function labels or cleanup pattern")
    case "state-machine":
      return useful(has("c-state-machine"), "state-machine needs state enum, macro, case, or transition context")
    case "mmio-register":
      return useful(has("c-register-macro") || has("c-register-access-example"), "mmio-register needs register macro family or register access example")
    default:
      return useful(items.length > 0, `${intent} needs at least one graph evidence item`)
  }
}

function maxEvidenceItemsForIntent(intent: CompletionCIntent, commentGuided = false) {
  if (commentGuided) return 3
  return STRONG_COMPLETION_EVIDENCE_INTENTS.has(intent) ? 4 : 2
}

function selectPromptEvidenceItems(intent: CompletionCIntent, items: CEmbeddedEvidenceItem[], maxItems: number) {
  const ranked = [...items].sort((left, right) =>
    evidenceKindPriority(intent, left.kind) - evidenceKindPriority(intent, right.kind) ||
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine)
  const selected: CEmbeddedEvidenceItem[] = []
  const usedKeys = new Set<string>()

  for (const kind of evidencePriorityKinds(intent)) {
    const item = ranked.find((candidate) => candidate.kind === kind && !usedKeys.has(evidenceItemKey(candidate)))
    if (!item) continue
    selected.push(item)
    usedKeys.add(evidenceItemKey(item))
    if (selected.length >= maxItems) return selected
  }

  for (const item of ranked) {
    const key = evidenceItemKey(item)
    if (usedKeys.has(key)) continue
    selected.push(item)
    usedKeys.add(key)
    if (selected.length >= maxItems) break
  }

  return selected
}

function evidenceItemKey(item: CEmbeddedEvidenceItem) {
  return `${item.kind}\0${item.path}\0${item.startLine}\0${item.endLine}\0${item.text.slice(0, 120)}`
}

function evidencePriorityKinds(intent: CompletionCIntent): CEmbeddedEvidenceKind[] {
  switch (intent) {
    case "member-access":
      return ["c-base-type", "c-struct-definition", "c-same-usage", "c-type-definition"]
    case "call-args":
      return ["c-callee-signature", "c-call-example", "c-return-handling", "c-helper-usage"]
    case "initializer":
      return ["c-struct-definition", "c-initializer-example", "c-callback-signature", "c-helper-usage"]
    case "error-path":
      return ["c-error-labels", "c-cleanup-pattern", "c-return-style", "c-call-style"]
    case "state-machine":
    case "case-body":
    case "switch-case":
    case "condition":
      return ["c-state-machine", "c-type-definition", "c-macro-definition", "c-call-style", "c-helper-usage"]
    case "mmio-register":
      return ["c-register-macro", "c-register-access-example", "c-macro-definition", "c-helper-usage"]
    default:
      return ["c-comment-semantic-match", "c-similar-function", "c-similar-block", "c-same-module-flow", "c-helper-usage", "c-call-style", "c-symbol-definition", "c-type-definition", "c-macro-definition", "c-symbol-reference", "c-local-context"]
  }
}

function evidenceKindPriority(intent: CompletionCIntent, kind: CEmbeddedEvidenceKind) {
  const index = evidencePriorityKinds(intent).indexOf(kind)
  return index >= 0 ? index : 99
}

function useful(met: boolean, reason: string) {
  return { met, reason: met ? undefined : reason }
}

async function queryEvidenceWithBudget(
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence">,
  question: string,
  options: Parameters<CodeGraphContextProvider["queryEvidence"]>[1],
  budgetMs: number | undefined,
) {
  if (!budgetMs || budgetMs <= 0) {
    return { result: await codeGraph.queryEvidence(question, options), timedOut: false }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), budgetMs)
    })
    const result = await Promise.race([codeGraph.queryEvidence(question, options), timeoutPromise])
    if (result === "timeout") return { result: undefined, timedOut: true }
    return { result, timedOut: false }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function sourceCommentFromEvidenceQuestion(question: string) {
  const prefix = "source-comment:"
  return question.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() ?? ""
}

function currentPathFromEvidenceQuestion(question: string) {
  const prefix = "current-path:"
  return question.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim()
}

function currentFunctionFromEvidenceQuestion(question: string) {
  const lines = question.split(/\r?\n/)
  for (const key of ["function:", "current-function:"]) {
    const value = lines.find((line) => line.toLowerCase().startsWith(key))?.slice(key.length).trim()
    if (value) return value
  }
  return undefined
}

function currentWordFromEvidenceQuestion(question: string) {
  const prefix = "current-word:"
  return question.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() ?? ""
}

function nearbyCommentTextFromEvidenceQuestion(question: string) {
  const prefix = "nearby-comment-tokens:"
  return question.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() ?? ""
}

function nearbyIdentifiersFromEvidenceQuestion(question: string) {
  const prefix = "nearby-identifiers:"
  const lines = question.split(/\r?\n/)
  const value = lines.find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() ?? ""
  const symbols = lines.find((line) => line.toLowerCase().startsWith("symbols:"))?.slice("symbols:".length).trim() ?? ""
  const nearbyCommentTokens = lines.find((line) => line.toLowerCase().startsWith("nearby-comment-tokens:"))?.slice("nearby-comment-tokens:".length).trim() ?? ""
  return uniqueStrings([value, symbols, nearbyCommentTokens].join(" ").split(/[^A-Za-z0-9_]+/).filter((token) => token.length >= 2))
}

function evidenceTokenCoverageTelemetry(item: CEmbeddedEvidenceItem) {
  if (!item.tokenCoverage) return []
  return [{
    name: item.name,
    kind: item.kind,
    actionTokenCoverage: item.tokenCoverage.actionTokenCoverage,
    objectTokenCoverage: item.tokenCoverage.objectTokenCoverage,
    domainTokenCoverage: item.tokenCoverage.domainTokenCoverage,
    matchedActionTokens: item.tokenCoverage.matchedActionTokens,
    matchedObjectTokens: item.tokenCoverage.matchedObjectTokens,
    matchedDomainTokens: item.tokenCoverage.matchedDomainTokens,
  }]
}

function commentGuidedTokenCoverageFromReason(reason: string): CommentGuidedTokenCoverage | undefined {
  const action = numberMatch(reason, /\bcoverage action=([0-9.]+)/)
  const object = numberMatch(reason, /\bobject=([0-9.]+)/)
  const domain = numberMatch(reason, /\bdomain=([0-9.]+)/)
  if (action === undefined && object === undefined && domain === undefined) return undefined
  return {
    actionTokenCoverage: action ?? 0,
    objectTokenCoverage: object ?? 0,
    domainTokenCoverage: domain ?? 0,
    matchedActionTokens: csvMatch(reason, /\bmatched-action=([A-Za-z0-9_,.-]+)/),
    matchedObjectTokens: csvMatch(reason, /\bmatched-object=([A-Za-z0-9_,.-]+)/),
    matchedDomainTokens: csvMatch(reason, /\bmatched-domain=([A-Za-z0-9_,.-]+)/),
  }
}

function numberMatch(input: string, pattern: RegExp) {
  const value = pattern.exec(input)?.[1]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function csvMatch(input: string, pattern: RegExp) {
  return pattern.exec(input)?.[1]?.split(",").filter(Boolean) ?? []
}

function formatCEmbeddedEvidenceText(intent: CompletionCIntent, items: CEmbeddedEvidenceItem[], trace: CEmbeddedEvidenceTrace) {
  if (items.length === 0) return ""
  return [
    `C embedded evidence for intent: ${intent}`,
    trace.generationModeHint ? `Generation mode hint: ${trace.generationModeHint}` : "",
    ...items.map((item) => formatPromptEvidenceItem(item, trace.generationModeHint)),
  ].filter(Boolean).join("\n\n")
}

function formatPromptEvidenceItem(item: CEmbeddedEvidenceItem, generationModeHint?: CEmbeddedGenerationModeHint) {
  return [
    `C evidence: ${item.kind}`,
    generationModeHint ? `Generation mode hint: ${generationModeHint}` : "",
    item.evidenceRole ? `Evidence role: ${item.evidenceRole}` : "",
    item.helperCallableConfidence ? `Helper callable confidence: ${item.helperCallableConfidence}` : "",
    item.name ? `Symbol: ${item.name}` : "",
    `Source: ${item.path}:${item.startLine}${item.endLine !== item.startLine ? `-${item.endLine}` : ""}`,
    `Reason: ${oneLine(item.reason, 180)}`,
    `Score: ${Math.round(item.score)}`,
    `Retrieval source: ${item.source}`,
    `Domain boost: ${item.domainBoostApplied ? "yes" : "no"}`,
    "Code:",
    limitEvidenceCode(item.text),
  ].filter(Boolean).join("\n")
}

function limitEvidenceCode(input: string) {
  const text = input.trim()
  if (text.length <= 900) return text
  return `${text.slice(0, 900).replace(/\s+$/, "")}\n/* evidence snippet truncated */`
}

function mergeEvidenceItems(...groups: CEmbeddedEvidenceItem[][]) {
  const byKey = new Map<string, CEmbeddedEvidenceItem>()
  for (const item of groups.flat()) {
    const key = `${item.kind}\0${item.path}\0${item.startLine}\0${item.endLine}\0${item.reason}\0${item.text.slice(0, 80)}`
    const existing = byKey.get(key)
    if (!existing || item.score > existing.score) byKey.set(key, item)
  }
  return [...byKey.values()]
}

function evidenceName(evidence: CodeGraphEvidence) {
  const named = /(?:type|base-type|callee|label|family|state-machine|function|macro):\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(evidence.snippet)
  return named?.[1]
}

function hasDomainBoost(evidence: CodeGraphEvidence, domainHints: string[]) {
  if (domainHints.length === 0) return false
  const text = `${evidence.path}\n${evidence.snippet}\n${evidence.reason}`.toLowerCase()
  return domainHints.some((hint) => text.includes(hint.toLowerCase()))
}

function uniqueStrings<T extends string>(values: T[]) {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function emptyResult(): CEmbeddedCompletionEvidenceResult {
  return {
    text: "",
    items: [],
    evidenceKinds: [],
    selectedEvidenceCount: 0,
    retrievalMode: "none",
    trace: {
      ragFallbackTriggered: false,
      graphEvidenceCount: 0,
      ragEvidenceCount: 0,
      finalSelectedEvidenceCount: 0,
      minimumUsefulEvidenceMet: false,
    },
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function oneLine(input: string, max: number) {
  const text = input.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+$/, "")}...`
}
