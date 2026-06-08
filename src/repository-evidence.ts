import { createHash } from "node:crypto"
import type { EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence, CodeGraphPromptContext } from "./codegraph-types"
import { normalizeCommentGuidedTokens, scoreCommentGuidedCandidate } from "./completion-comment-guided-ranking"
import type { CommentGuidedCursorContextFeatures } from "./completion-cursor-context"

export type RepositoryEvidenceMode = "qa" | "completion"

export type RepositoryEvidenceTask =
  | "comment-guided-code"
  | "symbol-prefix"
  | "member-access"
  | "call-args"
  | "initializer"
  | "error-path"
  | "state-machine"
  | "mmio-register"
  | "body-statement"

export type RepositoryEvidenceSource = "graph" | "vector" | "rerank" | "summary" | "state-machine" | "hybrid" | "semantic-rag" | "semantic-rerank" | "graph-comment-guided" | "local-flow"
export type RepositoryEvidenceRetrievalShape = "default" | "qa-exact" | "qa-semantic"

export type RepositoryEvidenceItem = {
  kind: string
  name?: string
  source: RepositoryEvidenceSource
  path?: string
  startLine?: number
  endLine?: number
  snippet: string
  score: number
  reason?: string
  parserKind?: string
  projectionScore?: number
  cursorContextScores?: RepositoryEvidenceCursorContextScores
}

export type RepositoryEvidenceCursorContextScores = {
  currentFunctionFlowScore: number
  neighborCallProximityScore: number
  callStatementFitScore: number
  messageTextSimilarityScore: number
  stateStylePenalty: number
}

export type RepositoryEvidencePack = {
  evidence: RepositoryEvidenceItem[]
  text: string
  omittedEvidence: number
  truncated: boolean
}

export type RepositoryEvidenceAlignmentReason =
  | "aligned"
  | "latency-budget"
  | "max-evidence"
  | "token-budget"
  | "rerank-disabled"
  | "rag-unavailable"
  | "graph-only-fallback"
  | "not-in-index"
  | "projection-trimmed"

export type RepositoryEvidenceTrace = {
  retrievalMode: "graph" | "hybrid" | "vector" | "graph-only-fallback" | "cached"
  rerankEnabled: boolean
  ragAvailable: boolean
  latencyMs: number
  latencyBudgetMs?: number
  timedOut: boolean
  timeoutStage?: string
  queryText: string
  queryTokens: string[]
  topCandidateNames: string[]
  selectedCandidateNames: string[]
  fullCandidateCount: number
  projectionCandidateCount: number
  retrievalShape: RepositoryEvidenceRetrievalShape
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
  qaExactTopK?: string[]
  qaExactSubmittedEvidence?: string[]
  qaExactContextTopK?: string[]
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
  alignmentReason?: RepositoryEvidenceAlignmentReason
}

export type RepositoryEvidenceResult = {
  fullTopK: RepositoryEvidenceItem[]
  qaPack: RepositoryEvidencePack
  completionPack: RepositoryEvidencePack
  trace: RepositoryEvidenceTrace
  retrievalResult?: QueryEvidenceResult
  alignmentCandidates: RepositoryEvidenceItem[]
  completionProjectionRanked: RepositoryEvidenceItem[]
}

export type RepositoryEvidenceForIntentInput = {
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence"> & Partial<Pick<CodeGraphContextProvider, "buildContext">>
  mode: RepositoryEvidenceMode
  task: RepositoryEvidenceTask
  question?: string
  sourceComment?: string
  currentWord?: string
  currentFile: string
  currentFunction?: string
  prefix?: string
  suffix?: string
  nearbyIdentifiers?: string[]
  maxEvidence: number
  maxBytes?: number
  latencyBudgetMs?: number
  debugFullRetrievalProbe?: boolean
  cursorContext?: CommentGuidedCursorContextFeatures
  retrievalShape?: RepositoryEvidenceRetrievalShape
}

type TimedEvidenceQuery = {
  result?: QueryEvidenceResult
  timedOut: boolean
  elapsedMs: number
  timeoutStage?: string
}

export async function retrieveRepositoryEvidenceForIntent(input: RepositoryEvidenceForIntentInput): Promise<RepositoryEvidenceResult> {
  if (isSemanticRetrieval(input)) return retrieveSemanticRepositoryEvidenceForIntent(input)

  const started = Date.now()
  const queryText = repositoryEvidenceQuery(input)
  const queryTokens = repositoryEvidenceQueryTokens(input)
  const budget = input.latencyBudgetMs
  const queryOptions = repositoryEvidenceQueryOptions(input)
  let query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
    ...queryOptions,
    retrievalMode: "hybrid",
    relatedPaths: [input.currentFile],
  }, budget, "hybrid")
  let retrievalResult = query.result
  let fallbackUsed = false
  let timeoutStage = query.timeoutStage
  let timedOutAny = query.timedOut

  if (!retrievalResult && query.timedOut) {
    fallbackUsed = true
    const fallbackBudget = budget === undefined ? undefined : Math.max(1, Math.min(500, budget))
    query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
      ...queryOptions,
      retrievalMode: "graph-only",
      relatedPaths: [input.currentFile],
    }, fallbackBudget, "graph-only-fallback")
    timedOutAny ||= query.timedOut
    timeoutStage = timeoutStage ?? query.timeoutStage
    retrievalResult = query.result
  } else if (!retrievalResult) {
    fallbackUsed = true
    query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
      ...queryOptions,
      retrievalMode: "graph-only",
      relatedPaths: [input.currentFile],
    }, budget, "graph-only-fallback")
    timedOutAny ||= query.timedOut
    timeoutStage = timeoutStage ?? query.timeoutStage
    retrievalResult = query.result
  }

  const latencyMs = Date.now() - started
  const timedOut = timedOutAny || (budget !== undefined && latencyMs > budget)
  const fullTopK = repositoryEvidenceItems(retrievalResult)
  const maxEvidence = Math.max(1, input.maxEvidence)
  const qaPack = packRepositoryEvidence(fullTopK, maxEvidence, input.maxBytes ?? 24_000)
  const completionProjectionRanked = completionProjectionItems(fullTopK, input)
  const completionPack = packCompletionRepositoryEvidence(completionProjectionRanked, input, maxEvidence, input.maxBytes ?? 4_000)
  const symbolPrefixTrace = symbolPrefixTraceFields(input, completionProjectionRanked, completionPack)
  const retrievalMode = repositoryRetrievalMode(retrievalResult, fallbackUsed)
  const rerankEnabled = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "rerank"))
  const ragAvailable = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "vector" || step.label === "rerank"))
  const topCandidateNames = candidateNames(fullTopK).slice(0, 8)
  const projectionTopK = candidateNames(completionProjectionRanked).slice(0, 8)
  const selectedCandidateNames = candidateNames(completionPack.evidence).slice(0, 8)
  const alignmentReason = alignmentReasonFor({
    fullTopK,
    completionPack,
    timedOut,
    retrievalMode,
    rerankEnabled,
    ragAvailable,
  })

  return {
    fullTopK,
    qaPack,
    completionPack,
    retrievalResult,
    alignmentCandidates: fullTopK,
    completionProjectionRanked,
    trace: {
      retrievalMode,
      rerankEnabled,
      ragAvailable,
      latencyMs,
      latencyBudgetMs: budget,
      timedOut,
      timeoutStage: timedOut ? timeoutStage ?? query.timeoutStage ?? "elapsed-over-budget" : undefined,
      queryText,
      queryTokens,
      topCandidateNames,
      selectedCandidateNames,
      fullCandidateCount: fullTopK.length,
      projectionCandidateCount: completionProjectionRanked.length,
      retrievalShape: "default",
      projectionTopK,
      projectedEvidenceNames: selectedCandidateNames,
      actualPromptEvidenceNames: selectedCandidateNames,
      selectedPromptEvidenceNames: selectedCandidateNames,
      ...symbolPrefixTrace,
      alignmentReason,
    },
  }
}

async function retrieveSemanticRepositoryEvidenceForIntent(input: RepositoryEvidenceForIntentInput): Promise<RepositoryEvidenceResult> {
  const started = Date.now()
  const retrievalShape = input.retrievalShape ?? "qa-exact"
  const semanticQueryText = buildSemanticRepositoryQuery(input)
  const graphQuestionText = buildSemanticGraphQuestion(input)
  const queryTokens = repositoryEvidenceQueryTokens(input)
  const queryEvidence = requestScopedEvidenceQuery(input.codeGraph)
  const budget = input.latencyBudgetMs
  const semanticPromise = queryEvidence(semanticQueryText, {
    ...semanticRepositoryQueryOptions(input),
    retrievalMode: "hybrid",
    relatedPaths: [input.currentFile],
  }, budget, "semantic-hybrid")
  const graphPromise = queryEvidence(graphQuestionText, {
    ...semanticGraphQueryOptions(input),
    retrievalMode: "graph-only",
    relatedPaths: [input.currentFile],
  }, budget, semanticGraphStage(input))
  const [semanticQuery, graphQuery] = await Promise.all([semanticPromise, graphPromise])
  const retrievalResult = semanticQuery.result
  const graphResult = graphQuery.result
  const latencyMs = Date.now() - started
  const timedOut = semanticQuery.timedOut || graphQuery.timedOut || (budget !== undefined && latencyMs > budget)
  const semanticItems = repositoryEvidenceItems(retrievalResult).map(markSemanticEvidenceSource)
  const graphItems = repositoryEvidenceItems(graphResult, undefined, "graph-comment-guided")
  const fullTopK = sortRepositoryEvidenceForRetrieval(dedupeEvidence([...semanticItems, ...graphItems]))
  const graphTopK = candidateNames(graphItems).slice(0, 8)
  const semanticTopK = candidateNames(semanticItems).slice(0, 8)
  const maxEvidence = Math.max(1, input.maxEvidence)
  const qaPack = packRepositoryEvidence(fullTopK, maxEvidence, input.maxBytes ?? 24_000)
  const completionProjectionRanked = completionProjectionItems(fullTopK, input)
  const completionPack = packCompletionRepositoryEvidence(completionProjectionRanked, input, maxEvidence, input.maxBytes ?? 4_000)
  const symbolPrefixTrace = symbolPrefixTraceFields(input, completionProjectionRanked, completionPack, {
    semanticItems,
    graphItems,
    fullTopK,
    semanticQueryText,
    rerankEnabled: Boolean(retrievalResult?.trace.steps.some((step) => step.label === "rerank")),
  })
  const retrievalMode = retrievalResult
    ? repositoryRetrievalMode(retrievalResult, false)
    : repositoryRetrievalMode(graphResult, Boolean(graphResult))
  const rerankEnabled = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "rerank"))
  const ragAvailable = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "vector" || step.label === "rerank"))
  const topCandidateNames = candidateNames(fullTopK).slice(0, 8)
  const projectionTopK = candidateNames(completionProjectionRanked).slice(0, 8)
  const projectedEvidenceNames = candidateNames(completionPack.evidence).slice(0, 8)
  const selectedCandidateNames = projectedEvidenceNames
  const alignmentReason = alignmentReasonFor({
    fullTopK,
    completionPack,
    timedOut,
    retrievalMode,
    rerankEnabled,
    ragAvailable,
  })
  const rawTopCandidate = topCandidateNames[0]
  const projectedTopCandidate = projectedEvidenceNames[0]
  return {
    fullTopK,
    qaPack,
    completionPack,
    retrievalResult,
    alignmentCandidates: fullTopK,
    completionProjectionRanked,
    trace: {
      retrievalMode,
      rerankEnabled,
      ragAvailable,
      latencyMs,
      latencyBudgetMs: budget,
      timedOut,
      timeoutStage: timedOut ? semanticQuery.timeoutStage ?? graphQuery.timeoutStage ?? "elapsed-over-budget" : undefined,
      queryText: semanticQueryText,
      queryTokens,
      topCandidateNames,
      selectedCandidateNames,
      fullCandidateCount: fullTopK.length,
      projectionCandidateCount: completionProjectionRanked.length,
      retrievalShape,
      semanticQueryText,
      graphQuestionTextHash: hashText(graphQuestionText),
      semanticTopK,
      graphTopK,
      mergedTopK: topCandidateNames,
      selectedPromptEvidenceNames: projectedEvidenceNames,
      rawSemanticTopK: semanticTopK,
      rawGraphTopK: graphTopK,
      mergedRetrievalTopK: topCandidateNames,
      projectionTopK,
      projectedEvidenceNames,
      actualPromptEvidenceNames: projectedEvidenceNames,
      droppedProjectedEvidenceNames: [],
      rawTop1Aligned: Boolean(rawTopCandidate && rawTopCandidate === projectedTopCandidate),
      retrievalRecallAligned: Boolean(projectedTopCandidate && topCandidateNames.includes(projectedTopCandidate)),
      projectionSelectedStrongHelper: Boolean(projectedTopCandidate),
      promptContainsProjectedHelper: Boolean(projectedTopCandidate && projectedEvidenceNames.includes(projectedTopCandidate)),
      probeAffectsPrompt: false,
      probeCompleted: Boolean(input.debugFullRetrievalProbe),
      projectionToPromptDropReason: completionPack.truncated ? "max-evidence" : undefined,
      qaExactTopK: retrievalShape === "qa-exact" ? topCandidateNames : undefined,
      qaExactSubmittedEvidence: retrievalShape === "qa-exact" ? projectedEvidenceNames : undefined,
      qaExactContextTopK: [],
      ...symbolPrefixTrace,
      alignmentReason,
    },
  }
}

function markSemanticEvidenceSource(item: RepositoryEvidenceItem): RepositoryEvidenceItem {
  if (item.source === "rerank") return { ...item, source: "semantic-rerank" }
  if (item.source === "vector" || item.source === "hybrid") return { ...item, source: "semantic-rag" }
  if (item.source === "graph") return { ...item, source: "semantic-rag" }
  return item
}

function repositoryEvidenceQuery(input: RepositoryEvidenceForIntentInput) {
  if (isQaExactRetrieval(input)) return qaExactRepositoryEvidenceQuery(input)
  return [
    "Repository evidence request for local code intelligence.",
    input.mode === "completion" && input.task === "comment-guided-code"
      ? "cursor-task: choose existing local helper/function calls, similar code blocks, and same-module flow evidence for this inline code hole."
      : "",
    input.mode === "completion" && input.task === "comment-guided-code"
      ? "expected-evidence: function definitions, callable helper signatures, similar functions, same-module flow, and concise call examples."
      : "",
    input.mode === "completion" && input.task === "comment-guided-code"
      ? "avoid-evidence: current function body summaries, file/module summaries, and broad domain-only matches unless no stronger code evidence exists."
      : "",
    input.mode === "completion" && input.task === "symbol-prefix"
      ? "cursor-task: rank evidence for a C/C++ typed symbol prefix inside the current function. Use the prefix as a weak compatibility hint, not as the whole retrieval intent."
      : "",
    input.mode === "completion" && input.task === "symbol-prefix"
      ? "expected-evidence: current-function flow, nearby helper definitions, same-module call examples, visible locals, and concise prefix-compatible symbols."
      : "",
    input.mode === "completion" && input.task === "symbol-prefix"
      ? "avoid-evidence: broad debug, dump, print, trace, or global prefix-only matches unless they are locally relevant to the current cursor flow."
      : "",
    input.mode === "completion" && input.task === "body-statement"
      ? "cursor-task: rank evidence for a blank or ordinary C/C++ statement hole inside the current function."
      : "",
    input.mode === "completion" && input.task === "body-statement"
      ? "expected-evidence: current-function flow, nearby call sequence, same-module helper definitions, local style examples, visible locals, and concise control-flow snippets."
      : "",
    input.mode === "completion" && input.task === "body-statement"
      ? "avoid-evidence: broad debug, dump, print, trace, log, type-only, or domain-only matches unless they explain the local cursor flow."
      : "",
    input.question ? `question: ${input.question}` : "",
    `task: ${input.task}`,
    `current-file: ${input.currentFile}`,
    input.currentFunction ? `current-function: ${input.currentFunction}` : "",
    input.currentWord ? `typed-prefix-hint: ${input.currentWord}` : "",
    input.sourceComment ? `source-comment: ${input.sourceComment}` : "",
    input.nearbyIdentifiers?.length ? `nearby-identifiers: ${input.nearbyIdentifiers.join(" ")}` : "",
    input.cursorContext ? formatCursorContextFeatures(input.cursorContext) : "",
    input.prefix ? `prefix-context:\n${tailLines(input.prefix, 28)}` : "",
    input.suffix ? `suffix-context:\n${headLines(input.suffix, 18)}` : "",
    "goal: retrieve similar functions, code blocks, graph evidence, vector evidence, and rerank trace that ground the requested code.",
  ].filter(Boolean).join("\n")
}

function qaExactRepositoryEvidenceQuery(input: RepositoryEvidenceForIntentInput) {
  return buildCommentGuidedSemanticQuery(input)
}

function buildSemanticRepositoryQuery(input: RepositoryEvidenceForIntentInput) {
  if (isQaSemanticSymbolPrefixRetrieval(input)) return buildSymbolPrefixSemanticQuery(input)
  return buildCommentGuidedSemanticQuery(input)
}

function buildSemanticGraphQuestion(input: RepositoryEvidenceForIntentInput) {
  if (isQaSemanticSymbolPrefixRetrieval(input)) return buildSymbolPrefixGraphQuestion(input)
  return buildCommentGuidedGraphQuestion(input)
}

function buildCommentGuidedSemanticQuery(input: RepositoryEvidenceForIntentInput) {
  const sourceComment = input.sourceComment?.trim()
  const cursor = input.cursorContext
  const nearbyCalls = uniqueStrings([
    ...(cursor?.previousStatementCalls ?? []),
    ...(cursor?.nextStatementCalls ?? []),
  ]).slice(0, 6)
  const nearbyMessages = (cursor?.nearbyLogOrMessageText ?? []).map((text) => oneLine(text, 90)).slice(0, 4)
  return [
    "User question:",
    [
      "In this local C/C++ file, what exact code or existing helper/function call should be inserted at the cursor?",
      sourceComment ? `The source comment immediately before the cursor is: ${sourceComment}` : "",
      `Current file/function: ${input.currentFile}${input.currentFunction ? ` / ${input.currentFunction}` : ""}`,
      nearbyCalls.length ? `Nearby calls: ${nearbyCalls.join(", ")}` : "",
      nearbyMessages.length ? `Nearby step/log text: ${nearbyMessages.join(" | ")}` : "",
      "Use local code graph and repository evidence to find the most relevant existing helper, similar function, or concise code block.",
      "Return evidence only; do not answer in prose.",
    ].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n")
}

function buildSymbolPrefixSemanticQuery(input: RepositoryEvidenceForIntentInput) {
  const cursor = input.cursorContext
  const nearbyCalls = uniqueStrings([
    ...(cursor?.previousStatementCalls ?? []),
    ...(cursor?.nextStatementCalls ?? []),
  ]).slice(0, 6)
  const nearbyMessages = (cursor?.nearbyLogOrMessageText ?? []).map((text) => oneLine(text, 90)).slice(0, 4)
  const visibleLocals = (cursor?.visibleLocals ?? []).slice(0, 12)
  const visibleIdentifiers = uniqueStrings([
    ...(input.nearbyIdentifiers ?? []),
    ...(cursor?.visibleIdentifiers ?? []),
  ]).slice(0, 18)
  return [
    "User question:",
    [
      "In this local C/C++ file, which existing helper, similar function, base implementation, or concise code block best fits the cursor?",
      `Current file/function: ${input.currentFile}${input.currentFunction ? ` / ${input.currentFunction}` : ""}`,
      cursor?.statementHoleKind ? `Cursor code hole: ${cursor.statementHoleKind}` : "",
      input.currentWord ? `The user has already typed identifier prefix: ${input.currentWord}` : "",
      input.currentWord ? "Use the typed prefix as an insertion constraint and compatibility hint, not as the whole retrieval query." : "",
      visibleLocals.length ? `Visible locals/parameters: ${visibleLocals.join(", ")}` : "",
      visibleIdentifiers.length ? `Nearby identifiers: ${visibleIdentifiers.join(", ")}` : "",
      nearbyCalls.length ? `Nearby calls inside the current function: ${nearbyCalls.join(", ")}` : "",
      nearbyMessages.length ? `Nearby comment/log text: ${nearbyMessages.join(" | ")}` : "",
      "Find repository evidence for the most relevant implementation pattern at this cursor: existing helper, similar function, similar block, or base/sibling implementation.",
      "Return evidence only; do not answer in prose.",
    ].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n")
}

function buildCommentGuidedGraphQuestion(input: RepositoryEvidenceForIntentInput) {
  const sourceComment = input.sourceComment?.trim()
  return [
    "Repository graph evidence request for C inline completion.",
    "completion-intent: comment-guided-c-code",
    `current-path: ${input.currentFile}`,
    input.currentFunction ? `function: ${input.currentFunction}` : "",
    sourceComment ? `source-comment: ${sourceComment}` : "",
    input.nearbyIdentifiers?.length ? `nearby-identifiers: ${input.nearbyIdentifiers.join(" ")}` : "",
    "goal: retrieve short similar functions, callable helpers, code blocks, and same-module flow evidence for this source comment.",
  ].filter(Boolean).join("\n")
}

function buildSymbolPrefixGraphQuestion(input: RepositoryEvidenceForIntentInput) {
  return [
    "Repository graph evidence request for C inline symbol prefix completion.",
    "completion-intent: symbol-prefix",
    `current-path: ${input.currentFile}`,
    input.currentFunction ? `function: ${input.currentFunction}` : "",
    input.currentWord ? `typed-prefix: ${input.currentWord}` : "",
    input.nearbyIdentifiers?.length ? `nearby-identifiers: ${input.nearbyIdentifiers.join(" ")}` : "",
    input.cursorContext ? formatCursorContextFeatures(input.cursorContext) : "",
    "goal: retrieve current-function flow, same-module helpers, similar functions, base or sibling implementations, and concise typed-prefix compatible symbols.",
  ].filter(Boolean).join("\n")
}

function hashText(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex").slice(0, 16)}`
}

function repositoryEvidenceQueryTokens(input: RepositoryEvidenceForIntentInput) {
  return uniqueStrings([
    ...tokenize(input.sourceComment ?? ""),
    ...tokenize(input.question ?? ""),
    ...tokenize(input.currentWord ?? ""),
    ...tokenize(input.currentFile),
    ...tokenize(input.currentFunction ?? ""),
    ...(input.nearbyIdentifiers ?? []).flatMap(tokenize),
    ...(input.cursorContext?.previousStatementCalls ?? []).flatMap(tokenize),
    ...(input.cursorContext?.nextStatementCalls ?? []).flatMap(tokenize),
    ...(input.cursorContext?.nearbyLogOrMessageText ?? []).flatMap(tokenize),
  ]).slice(0, 32)
}

async function queryEvidenceWithTimeout(
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence">,
  question: string,
  options: Parameters<CodeGraphContextProvider["queryEvidence"]>[1],
  budgetMs: number | undefined,
  stage: string,
): Promise<TimedEvidenceQuery> {
  const started = Date.now()
  if (!budgetMs || budgetMs <= 0) {
    const result = await codeGraph.queryEvidence(question, options)
    const elapsedMs = Date.now() - started
    return { result, elapsedMs, timedOut: false }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), budgetMs)
    })
    const result = await Promise.race([codeGraph.queryEvidence(question, options), timeoutPromise])
    const elapsedMs = Date.now() - started
    if (result === "timeout") return { elapsedMs, timedOut: true, timeoutStage: stage }
    return {
      result,
      elapsedMs,
      timedOut: elapsedMs > budgetMs,
      timeoutStage: elapsedMs > budgetMs ? stage : undefined,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function requestScopedEvidenceQuery(codeGraph: Pick<CodeGraphContextProvider, "queryEvidence">) {
  const pending = new Map<string, Promise<TimedEvidenceQuery>>()
  return (
    question: string,
    options: Parameters<CodeGraphContextProvider["queryEvidence"]>[1],
    budgetMs: number | undefined,
    stage: string,
  ) => {
    const key = evidenceQueryKey(question, options, budgetMs, stage)
    const cached = pending.get(key)
    if (cached) return cached
    const query = queryEvidenceWithTimeout(codeGraph, question, options, budgetMs, stage)
    pending.set(key, query)
    return query
  }
}

function evidenceQueryKey(
  question: string,
  options: Parameters<CodeGraphContextProvider["queryEvidence"]>[1],
  budgetMs: number | undefined,
  stage: string,
) {
  return JSON.stringify({
    question,
    stage,
    budgetMs,
    retrievalMode: options?.retrievalMode,
    relatedPaths: options?.relatedPaths ?? [],
    maxEvidenceItems: options?.maxEvidenceItems,
    maxEvidenceBytes: options?.maxEvidenceBytes,
    latencyBudgetMs: options?.latencyBudgetMs,
  })
}

function repositoryEvidenceQueryOptions(input: RepositoryEvidenceForIntentInput) {
  const completionComment = input.mode === "completion" && input.task === "comment-guided-code"
  const completionSymbolPrefix = input.mode === "completion" && input.task === "symbol-prefix"
  const completionBodyStatement = input.mode === "completion" && input.task === "body-statement"
  if (isSemanticRetrieval(input)) {
    return {
      latencyBudgetMs: input.latencyBudgetMs,
    }
  }
  return {
    maxEvidenceItems: completionComment
      ? Math.max(input.maxEvidence * 8, 24)
      : completionSymbolPrefix
        ? Math.max(input.maxEvidence * 10, 32)
        : completionBodyStatement
          ? Math.max(input.maxEvidence * 8, 24)
        : undefined,
    maxEvidenceBytes: completionComment || completionSymbolPrefix || completionBodyStatement ? Math.max(input.maxBytes ?? 0, 18_000) : input.maxBytes,
    latencyBudgetMs: input.latencyBudgetMs,
  }
}

function semanticRepositoryQueryOptions(input: RepositoryEvidenceForIntentInput) {
  const completionComment = input.mode === "completion" && input.task === "comment-guided-code"
  const completionSymbolPrefix = input.mode === "completion" && input.task === "symbol-prefix"
  if (!completionComment && !completionSymbolPrefix) {
    return {
      latencyBudgetMs: input.latencyBudgetMs,
    }
  }
  return {
    maxEvidenceItems: Math.max(input.maxEvidence * 10, 32),
    maxEvidenceBytes: Math.max(input.maxBytes ?? 0, 24_000),
    latencyBudgetMs: input.latencyBudgetMs,
  }
}

function semanticGraphQueryOptions(input: RepositoryEvidenceForIntentInput) {
  return {
    maxEvidenceItems: Math.max(input.maxEvidence * 12, 48),
    maxEvidenceBytes: Math.max(input.maxBytes ?? 0, 24_000),
    latencyBudgetMs: input.latencyBudgetMs,
  }
}

function semanticGraphStage(input: RepositoryEvidenceForIntentInput) {
  return isQaSemanticSymbolPrefixRetrieval(input) ? "graph-symbol-prefix" : "graph-comment-guided"
}

function isQaExactRetrieval(input: RepositoryEvidenceForIntentInput) {
  return input.task === "comment-guided-code" && input.retrievalShape === "qa-exact"
}

function isQaSemanticSymbolPrefixRetrieval(input: RepositoryEvidenceForIntentInput) {
  return input.mode === "completion" && input.task === "symbol-prefix" && input.retrievalShape === "qa-semantic"
}

function isSemanticRetrieval(input: RepositoryEvidenceForIntentInput) {
  return isQaExactRetrieval(input) || isQaSemanticSymbolPrefixRetrieval(input)
}

function formatCursorContextFeatures(features: CommentGuidedCursorContextFeatures) {
  return [
    "cursor-context:",
    `statement-hole-kind: ${features.statementHoleKind}`,
    features.currentFunctionName ? `current-function-name: ${features.currentFunctionName}` : "",
    features.previousStatementCalls.length ? `previous-statement-calls: ${features.previousStatementCalls.join(" ")}` : "",
    features.nextStatementCalls.length ? `next-statement-calls: ${features.nextStatementCalls.join(" ")}` : "",
    features.nearbyLogOrMessageText.length ? `nearby-message-text: ${features.nearbyLogOrMessageText.join(" | ")}` : "",
    features.flowOrdinalTokens.length ? `flow-ordinal-tokens: ${features.flowOrdinalTokens.join(" ")}` : "",
    features.visibleLocals.length ? `visible-locals: ${features.visibleLocals.join(" ")}` : "",
    features.visibleIdentifiers.length ? `visible-identifiers: ${features.visibleIdentifiers.slice(0, 24).join(" ")}` : "",
  ].filter(Boolean).join("\n")
}

function repositoryEvidenceItems(
  result: QueryEvidenceResult | undefined,
  context?: CodeGraphPromptContext,
  sourceOverride?: RepositoryEvidenceSource,
  contextSource: RepositoryEvidenceSource = "local-flow",
): RepositoryEvidenceItem[] {
  const items: RepositoryEvidenceItem[] = []
  for (const evidence of result?.retrieval?.evidence ?? []) {
    items.push(repositoryItemFromCodeGraphEvidence(evidence, sourceOverride))
  }
  for (const evidence of result?.stateMachines.flatMap((machine) => machine.evidence) ?? []) {
    items.push(repositoryItemFromEvidenceRef(evidence, "state-machine"))
  }
  for (const evidence of result?.evidencePack.evidence ?? []) {
    items.push(repositoryItemFromEvidenceRef(evidence, "summary"))
  }
  items.push(...repositoryItemsFromCodeGraphContext(context, contextSource))
  return dedupeEvidence(items)
    .sort(repositoryEvidenceSort)
}

function repositoryItemsFromCodeGraphContext(context: CodeGraphPromptContext | undefined, contextSource: RepositoryEvidenceSource): RepositoryEvidenceItem[] {
  if (!context?.text) return []
  const items: RepositoryEvidenceItem[] = []
  const evidencePattern = /<evidence\b([^>]*)>\s*([\s\S]*?)\s*<\/evidence>/g
  let match: RegExpExecArray | null
  while ((match = evidencePattern.exec(context.text)) !== null) {
    const attrs = parseXmlAttributes(match[1] ?? "")
    const path = attrs.path
    const lines = parseLineRange(attrs.lines)
    const reason = attrs.reason ?? "qa local code graph evidence"
    const snippet = decodeXmlText(match[2] ?? "").trim()
    if (!snippet) continue
    items.push({
      kind: attrs.kind ?? "text",
      name: evidenceName(snippet),
      source: contextSource,
      path,
      startLine: lines.startLine,
      endLine: lines.endLine,
      snippet,
      score: Number(attrs.score ?? 0) || 0,
      reason,
    })
  }
  return items
}

function parseXmlAttributes(input: string) {
  const attrs: Record<string, string> = {}
  const attrPattern = /\b([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = attrPattern.exec(input)) !== null) {
    attrs[match[1]!] = decodeXmlText(match[2] ?? "")
  }
  return attrs
}

function parseLineRange(input: string | undefined) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(input ?? "")
  const startLine = Number(match?.[1] ?? 1)
  const endLine = Number(match?.[2] ?? match?.[1] ?? startLine)
  return {
    startLine: Number.isFinite(startLine) ? startLine : 1,
    endLine: Number.isFinite(endLine) ? endLine : Number.isFinite(startLine) ? startLine : 1,
  }
}

function decodeXmlText(input: string) {
  return input
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function repositoryItemFromCodeGraphEvidence(evidence: CodeGraphEvidence, sourceOverride?: RepositoryEvidenceSource): RepositoryEvidenceItem {
  return {
    kind: evidence.kind,
    name: evidenceName(evidence.snippet),
    source: sourceOverride ?? evidenceSource(evidence.reason),
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    snippet: evidence.snippet,
    score: evidence.score,
    reason: evidence.reason,
  }
}

function sortRepositoryEvidenceForRetrieval(items: RepositoryEvidenceItem[]) {
  return items.sort(repositoryEvidenceSort)
}

function repositoryEvidenceSort(left: RepositoryEvidenceItem, right: RepositoryEvidenceItem) {
  return right.score - left.score ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.startLine ?? 0) - (right.startLine ?? 0)
}

function repositoryItemFromEvidenceRef(evidence: EvidenceRef, source: RepositoryEvidenceSource): RepositoryEvidenceItem {
  return {
    kind: evidence.parserKind,
    name: evidenceName(evidence.snippet ?? ""),
    source,
    path: evidence.file,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    snippet: evidence.snippet ?? "",
    score: source === "summary" ? 80 : 120,
    reason: evidence.parserKind,
    parserKind: evidence.parserKind,
  }
}

function packRepositoryEvidence(items: RepositoryEvidenceItem[], maxItems: number, maxBytes: number): RepositoryEvidencePack {
  const selected: RepositoryEvidenceItem[] = []
  let bytes = 0
  let omitted = 0
  for (const item of items) {
    const text = formatRepositoryEvidenceItem(item)
    const size = Buffer.byteLength(text, "utf8")
    if (selected.length >= maxItems || bytes + size > maxBytes) {
      omitted++
      continue
    }
    selected.push(item)
    bytes += size
  }
  return {
    evidence: selected,
    text: selected.map(formatRepositoryEvidenceItem).join("\n"),
    omittedEvidence: omitted,
    truncated: omitted > 0,
  }
}

function packCompletionRepositoryEvidence(
  items: RepositoryEvidenceItem[],
  input: RepositoryEvidenceForIntentInput,
  maxEvidence: number,
  maxBytes: number,
) {
  const maxItems = Math.min(Math.max(1, maxEvidence), 3)
  const maxPackedBytes = Math.min(maxBytes, 4_000)
  if (input.mode === "completion" && input.task === "symbol-prefix") {
    if (isQaSemanticSymbolPrefixRetrieval(input)) {
      return packQaSemanticSymbolPrefixEvidence(items, input, maxItems, maxPackedBytes)
    }
    const context = symbolPrefixProjectionContext(items, input)
    const compatible = items.filter((item) =>
      symbolPrefixCompatibleName(context.prefix, item.name) &&
      isCodeLikeEvidence(item) &&
      !isBroadUtilityEvidence(item) &&
      !isSummaryLikeEvidence(item))
    if (compatible.length > 0) {
      return packRepositoryEvidence(compatible, maxItems, maxPackedBytes)
    }
  }
  return packRepositoryEvidence(items, maxItems, maxPackedBytes)
}

function packQaSemanticSymbolPrefixEvidence(
  items: RepositoryEvidenceItem[],
  input: RepositoryEvidenceForIntentInput,
  maxItems: number,
  maxBytes: number,
) {
  const context = symbolPrefixProjectionContext(items, input)
  const semanticCodeEvidence = items.filter((item) =>
    isSemanticRepositoryEvidence(item) &&
    isCodeLikeEvidence(item) &&
    !isSummaryLikeEvidence(item) &&
    !isBroadUtilityEvidence(item))
  const semanticFunctionEvidence = semanticCodeEvidence.filter(isFunctionLikeEvidence)
  const semanticEvidence = semanticFunctionEvidence.length > 0 ? semanticFunctionEvidence : semanticCodeEvidence
  const prefixCompatible = items.filter((item) =>
    symbolPrefixCompatibleName(context.prefix, item.name) &&
    isCodeLikeEvidence(item) &&
    !isSummaryLikeEvidence(item) &&
    !isBroadUtilityEvidence(item))
  const localFlowCodeEvidence = items.filter((item) =>
    isCodeLikeEvidence(item) &&
    !isSummaryLikeEvidence(item) &&
    !isBroadUtilityEvidence(item) &&
    !semanticEvidence.includes(item) &&
    !prefixCompatible.includes(item))
  const primaryCount = semanticEvidence.length + prefixCompatible.length
  const localFlowFunctions = localFlowCodeEvidence.filter(isFunctionLikeEvidence)
  const localFlow = primaryCount > 0
    ? localFlowFunctions
    : localFlowFunctions.length > 0 ? localFlowFunctions : localFlowCodeEvidence
  const primaryEvidence = dedupeEvidence([
    ...semanticEvidence,
    ...prefixCompatible,
  ])
  const ordered = primaryEvidence.length > 0
    ? primaryEvidence
    : dedupeEvidence([
      ...localFlow,
      ...items,
    ])
  const primaryLimit = primaryEvidence.length > 0
    ? Math.min(maxItems, Math.max(1, primaryEvidence.length))
    : maxItems
  return packRepositoryEvidence(ordered, primaryLimit, maxBytes)
}

function completionProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  if (input.mode !== "completion") return items
  const currentFile = normalizePath(input.currentFile)
  const currentFunction = input.currentFunction?.toLowerCase()
  const filtered = items.filter((item) => {
    if (!isCodeLikeEvidence(item)) return false
    if (
      (input.task === "comment-guided-code" || input.task === "body-statement") &&
      currentFunction &&
      sameRepositoryPath(item.path ?? "", currentFile) &&
      item.name?.toLowerCase() === currentFunction
    ) {
      return false
    }
    return true
  })
  if (input.task === "symbol-prefix") return rankSymbolPrefixProjectionItems(filtered, input)
  if (input.task === "body-statement") return rankBodyStatementProjectionItems(filtered, input)
  if (input.task !== "comment-guided-code") return filtered
  if (isQaExactRetrieval(input)) return qaExactCompletionProjectionItems(filtered, input)
  return rankCommentGuidedProjectionItems(filtered, input)
}

function rankSymbolPrefixProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  const context = symbolPrefixProjectionContext(items, input)
  return items.map((item) => {
    const scored = symbolPrefixProjectionScore(item, input, context)
    return {
      ...item,
      projectionScore: scored.totalScore,
      cursorContextScores: scored.cursorScores,
    }
  }).sort((left, right) =>
    (right.projectionScore ?? right.score) - (left.projectionScore ?? left.score) ||
    right.score - left.score ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.startLine ?? 0) - (right.startLine ?? 0))
}

function rankBodyStatementProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  return items.map((item) => {
    const scored = bodyStatementProjectionScore(item, input)
    return {
      ...item,
      projectionScore: scored.totalScore,
      cursorContextScores: scored.cursorScores,
    }
  }).sort((left, right) =>
    (right.projectionScore ?? right.score) - (left.projectionScore ?? left.score) ||
    right.score - left.score ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.startLine ?? 0) - (right.startLine ?? 0))
}

type SymbolPrefixProjectionContext = {
  prefix: string
  currentFunctionTokens: string[]
  hasCompatibleCodeCandidate: boolean
}

function symbolPrefixProjectionContext(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput): SymbolPrefixProjectionContext {
  const prefix = (input.currentWord ?? "").toLowerCase()
  const currentFunctionTokens = currentFunctionSemanticTokens(input)
  const hasCompatibleCodeCandidate = Boolean(prefix && items.some((item) =>
    symbolPrefixCompatibleName(prefix, item.name) &&
    isCodeLikeEvidence(item) &&
    !isSummaryLikeEvidence(item) &&
    !isBroadUtilityEvidence(item)))
  return {
    prefix,
    currentFunctionTokens,
    hasCompatibleCodeCandidate,
  }
}

function symbolPrefixProjectionScore(
  item: RepositoryEvidenceItem,
  input: RepositoryEvidenceForIntentInput,
  context: SymbolPrefixProjectionContext,
) {
  const emptyCoverage = {
    actionTokenCoverage: 0,
    objectTokenCoverage: 0,
    domainTokenCoverage: 0,
    matchedActionTokens: [],
    matchedObjectTokens: [],
    matchedDomainTokens: [],
    semanticScore: 0,
    graphProximityScore: 0,
    sameModuleScore: 0,
    codeShapeScore: 0,
    totalScore: 0,
  }
  const prefixCompatible = symbolPrefixCompatibleName(context.prefix, item.name)
  const cursorScores = cursorContextScores(item, input, emptyCoverage)
  const statementPosition = isStatementInsertionPosition(input.prefix ?? "", input.suffix ?? "")
  const functionLike = isFunctionLikeEvidence(item)
  const summary = isSummaryLikeEvidence(item)
  const broadUtility = isBroadUtilityEvidence(item)
  const currentFunctionTokenScore = symbolPrefixCurrentFunctionTokenScore(item, context)
  const sameModuleScore = isSameModulePath(item.path, input.currentFile) ? 260 : 0
  const callFitScore = statementPosition && functionLike && functionParamsCanBeSatisfied(item.snippet, input) ? 260 : 0
  const qaSemantic = isQaSemanticSymbolPrefixRetrieval(input)
  const semanticScore = isSemanticRepositoryEvidence(item) ? qaSemantic ? 720 : 80 : 0
  const typedPrefixCompatibilityScore = prefixCompatible
    ? qaSemantic
      ? context.prefix.length <= 2 ? 260 : 380
      : context.prefix.length <= 2 ? 780 : 940
    : context.hasCompatibleCodeCandidate
      ? qaSemantic ? -120 : -900
      : 0
  const rawScoreCapped = Math.min(item.score, prefixCompatible ? qaSemantic ? 500 : 620 : qaSemantic ? 520 : 360)
  let score = rawScoreCapped
  if (functionLike) score += 220
  score += semanticScore
  score += typedPrefixCompatibilityScore
  score += currentFunctionTokenScore
  score += sameModuleScore
  score += cursorScores.currentFunctionFlowScore * 3
  score += cursorScores.neighborCallProximityScore * 2
  score += cursorScores.messageTextSimilarityScore
  score += callFitScore
  if (summary) score -= 320
  if (!prefixCompatible && context.hasCompatibleCodeCandidate && !functionLike) score -= qaSemantic ? 180 : 520
  if (broadUtility) {
    const localFlowScore = cursorScores.currentFunctionFlowScore + cursorScores.neighborCallProximityScore + cursorScores.messageTextSimilarityScore
    score -= localFlowScore > 80 && prefixCompatible ? 260 : 620
  }
  return { totalScore: score, cursorScores }
}

function currentFunctionSemanticTokens(input: RepositoryEvidenceForIntentInput) {
  return uniqueStrings([
    ...(input.currentFunction ? tokenize(input.currentFunction) : []),
    ...normalizePath(input.currentFile).split("/").flatMap(tokenize),
    ...(input.cursorContext?.visibleLocals ?? []).flatMap(tokenize),
    ...(input.cursorContext?.visibleIdentifiers ?? []).flatMap(tokenize),
  ].filter((token) => token.length > 2))
}

function symbolPrefixCurrentFunctionTokenScore(item: RepositoryEvidenceItem, context: SymbolPrefixProjectionContext) {
  if (context.currentFunctionTokens.length === 0) return 0
  const nameTokens = new Set(tokenize(item.name ?? ""))
  const locationTokens = new Set(tokenize(`${item.path ?? ""}\n${item.reason ?? ""}`))
  let score = 0
  const seen = new Set<string>()
  for (const token of context.currentFunctionTokens) {
    if (seen.has(token)) continue
    if (nameTokens.has(token)) {
      score += 170
      seen.add(token)
    } else if (locationTokens.has(token)) {
      score += 50
      seen.add(token)
    }
  }
  return Math.min(score, 760)
}

function symbolPrefixCompatibleName(prefix: string, name: string | undefined) {
  return Boolean(prefix && name?.toLowerCase().startsWith(prefix))
}

function isSemanticRepositoryEvidence(item: RepositoryEvidenceItem) {
  return item.source === "semantic-rag" ||
    item.source === "semantic-rerank" ||
    item.source === "rerank" ||
    item.source === "vector" ||
    item.source === "hybrid"
}

function symbolPrefixTraceFields(
  input: RepositoryEvidenceForIntentInput,
  ranked: RepositoryEvidenceItem[],
  pack: RepositoryEvidencePack,
  semanticContext?: {
    semanticItems: RepositoryEvidenceItem[]
    graphItems: RepositoryEvidenceItem[]
    fullTopK: RepositoryEvidenceItem[]
    semanticQueryText: string
    rerankEnabled: boolean
  },
): Pick<RepositoryEvidenceTrace,
  "typedPrefixCompatibleCandidates" |
  "typedPrefixCompatiblePromptNames" |
  "symbolPrefixSemanticQueryText" |
  "symbolPrefixSemanticTopK" |
  "symbolPrefixGraphTopK" |
  "symbolPrefixMergedTopK" |
  "symbolPrefixRerankTopK" |
  "symbolPrefixSemanticSelectedNames" |
  "symbolPrefixPrefixCompatibleNames" |
  "symbolPrefixSemanticVsPrefixDiverged" |
  "symbolPrefixSelectionReason" |
  "symbolPrefixCurrentFunctionTokens" |
  "symbolPrefixNonPrefixDroppedNames" |
  "symbolPrefixProjectionReasons"
> {
  if (input.mode !== "completion" || input.task !== "symbol-prefix") return {}
  const context = symbolPrefixProjectionContext(ranked, input)
  const selectedNames = new Set(candidateNames(pack.evidence))
  const compatibleCandidates = candidateNames(ranked.filter((item) => symbolPrefixCompatibleName(context.prefix, item.name))).slice(0, 8)
  const compatiblePromptNames = candidateNames(pack.evidence.filter((item) => symbolPrefixCompatibleName(context.prefix, item.name))).slice(0, 8)
  const semanticTopK = candidateNames(semanticContext?.semanticItems ?? []).slice(0, 8)
  const graphTopK = candidateNames(semanticContext?.graphItems ?? []).slice(0, 8)
  const mergedTopK = candidateNames(semanticContext?.fullTopK ?? ranked).slice(0, 8)
  const semanticSelectedNames = candidateNames(pack.evidence.filter(isSemanticRepositoryEvidence)).slice(0, 8)
  const prefixCompatibleTop = compatibleCandidates[0]
  const semanticTop = semanticTopK[0]
  const nonPrefixDroppedNames = candidateNames(ranked.filter((item) =>
    item.name &&
    !symbolPrefixCompatibleName(context.prefix, item.name) &&
    !selectedNames.has(item.name))).slice(0, 8)
  return {
    typedPrefixCompatibleCandidates: compatibleCandidates,
    typedPrefixCompatiblePromptNames: compatiblePromptNames,
    symbolPrefixSemanticQueryText: semanticContext?.semanticQueryText,
    symbolPrefixSemanticTopK: semanticTopK.length ? semanticTopK : undefined,
    symbolPrefixGraphTopK: graphTopK.length ? graphTopK : undefined,
    symbolPrefixMergedTopK: mergedTopK.length ? mergedTopK : undefined,
    symbolPrefixRerankTopK: semanticContext?.rerankEnabled ? semanticTopK : undefined,
    symbolPrefixSemanticSelectedNames: semanticSelectedNames.length ? semanticSelectedNames : undefined,
    symbolPrefixPrefixCompatibleNames: compatibleCandidates.length ? compatibleCandidates : undefined,
    symbolPrefixSemanticVsPrefixDiverged: Boolean(semanticTop && prefixCompatibleTop && semanticTop !== prefixCompatibleTop),
    symbolPrefixSelectionReason: semanticContext
      ? semanticSelectedNames.length
        ? "qa-semantic selected semantic evidence before prefix-compatible fallback"
        : compatiblePromptNames.length
          ? "qa-semantic used prefix-compatible fallback after semantic projection"
          : "qa-semantic used local-flow fallback"
      : undefined,
    symbolPrefixCurrentFunctionTokens: context.currentFunctionTokens.slice(0, 12),
    symbolPrefixNonPrefixDroppedNames: nonPrefixDroppedNames,
    symbolPrefixProjectionReasons: ranked.slice(0, 8).map((item) => ({
      name: item.name,
      reason: symbolPrefixProjectionReason(item, context),
      prefixCompatible: symbolPrefixCompatibleName(context.prefix, item.name),
      currentFunctionTokenScore: symbolPrefixCurrentFunctionTokenScore(item, context),
      projectionScore: Math.round(item.projectionScore ?? item.score),
    })),
  }
}

function symbolPrefixProjectionReason(item: RepositoryEvidenceItem, context: SymbolPrefixProjectionContext) {
  const parts: string[] = []
  if (isSemanticRepositoryEvidence(item)) parts.push("semantic-evidence")
  if (symbolPrefixCompatibleName(context.prefix, item.name)) parts.push("typed-prefix-compatible")
  else if (context.hasCompatibleCodeCandidate) parts.push("non-prefix-demoted")
  if (symbolPrefixCurrentFunctionTokenScore(item, context) > 0) parts.push("current-function-token-overlap")
  if (isBroadUtilityEvidence(item)) parts.push("broad-utility-demoted")
  if (isSummaryLikeEvidence(item)) parts.push("summary-demoted")
  return parts.join(",") || "fallback"
}

function bodyStatementProjectionScore(item: RepositoryEvidenceItem, input: RepositoryEvidenceForIntentInput) {
  const emptyCoverage = {
    actionTokenCoverage: 0,
    objectTokenCoverage: 0,
    domainTokenCoverage: 0,
    matchedActionTokens: [],
    matchedObjectTokens: [],
    matchedDomainTokens: [],
    semanticScore: 0,
    graphProximityScore: 0,
    sameModuleScore: 0,
    codeShapeScore: 0,
    totalScore: 0,
  }
  const cursorScores = cursorContextScores(item, input, emptyCoverage)
  const statementPosition = isStatementInsertionPosition(input.prefix ?? "", input.suffix ?? "")
  const emptyFunctionBody = isEmptyFunctionBodyCursor(input)
  const sameCurrentFile = sameRepositoryPath(item.path ?? "", input.currentFile)
  let score = Math.min(item.score, 700)
  if (isFunctionLikeEvidence(item)) score += 150
  if (isSameModulePath(item.path, input.currentFile)) score += 170
  if (sameCurrentFile) score += emptyFunctionBody ? -420 : 60
  if (item.source === "semantic-rag" || item.source === "semantic-rerank" || item.source === "rerank") score += 80
  score += cursorScores.currentFunctionFlowScore * 2.4
  score += cursorScores.neighborCallProximityScore * 2.6
  score += cursorScores.messageTextSimilarityScore * 1.5
  if (statementPosition && isFunctionLikeEvidence(item) && functionParamsCanBeSatisfied(item.snippet, input)) score += 160
  if (isSummaryLikeEvidence(item)) score -= 260
  if (isBroadUtilityEvidence(item)) score -= 420
  score -= cursorScores.stateStylePenalty
  return { totalScore: score, cursorScores }
}

function isEmptyFunctionBodyCursor(input: RepositoryEvidenceForIntentInput) {
  return input.cursorContext?.currentFunctionBodyIsEmpty === true ||
    input.cursorContext?.statementHoleKind === "empty-function-body"
}

function qaExactCompletionProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  const functionDefinitions: RepositoryEvidenceItem[] = []
  const primaryBlocks: RepositoryEvidenceItem[] = []
  const fallback: RepositoryEvidenceItem[] = []
  for (const item of items) {
    if (isSummaryLikeEvidence(item)) {
      fallback.push(item)
      continue
    }
    const coverage = scoreCommentGuidedCandidate({
      comment: normalizeCommentGuidedTokens(input.sourceComment ?? input.question ?? ""),
      candidateText: [item.name, item.kind, item.reason, item.parserKind, item.snippet].filter(Boolean).join("\n"),
    })
    const noCoverage = coverage.actionTokenCoverage <= 0 && coverage.objectTokenCoverage <= 0 && coverage.domainTokenCoverage <= 0
    const domainOnly = coverage.actionTokenCoverage <= 0 && coverage.objectTokenCoverage <= 0 && coverage.domainTokenCoverage > 0
    if (noCoverage || domainOnly) {
      fallback.push(item)
      continue
    }
    if (isFunctionDefinitionEvidence(item)) {
      functionDefinitions.push(item)
      continue
    }
    primaryBlocks.push(item)
  }
  const primary = [...functionDefinitions, ...primaryBlocks]
  return rankCommentGuidedProjectionItems(primary.length > 0 ? primary : fallback, input)
}

function rankCommentGuidedProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  const comment = normalizeCommentGuidedTokens(input.sourceComment ?? input.question ?? "")
  const statementPosition = isStatementInsertionPosition(input.prefix ?? "", input.suffix ?? "")
  return items.map((item) => {
    const scored = commentGuidedProjectionScore(item, input, comment, statementPosition)
    return {
      ...item,
      projectionScore: scored.totalScore,
      cursorContextScores: scored.cursorScores,
    }
  }).sort((left, right) =>
    (right.projectionScore ?? right.score) - (left.projectionScore ?? left.score) ||
    right.score - left.score ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.startLine ?? 0) - (right.startLine ?? 0))
}

function commentGuidedProjectionScore(
  item: RepositoryEvidenceItem,
  input: RepositoryEvidenceForIntentInput,
  comment: ReturnType<typeof normalizeCommentGuidedTokens>,
  statementPosition: boolean,
) {
  const coverage = scoreCommentGuidedCandidate({
    comment,
    candidateText: [item.name, item.kind, item.reason, item.parserKind, item.snippet].filter(Boolean).join("\n"),
  })
  const nameCoverage = scoreCommentGuidedCandidate({
    comment,
    candidateText: item.name ?? "",
  })
  const snippetCoverage = scoreCommentGuidedCandidate({
    comment,
    candidateText: [item.kind, item.reason, item.parserKind, item.snippet].filter(Boolean).join("\n"),
  })
  const actionObjectCoverage = coverage.actionTokenCoverage + coverage.objectTokenCoverage
  const domainOnly = actionObjectCoverage <= 0 && coverage.domainTokenCoverage > 0
  const nameActionObjectCoverage = nameCoverage.actionTokenCoverage + nameCoverage.objectTokenCoverage
  const snippetActionObjectCoverage = snippetCoverage.actionTokenCoverage + snippetCoverage.objectTokenCoverage
  let score = Math.min(item.score, 700)
  score += nameCoverage.actionTokenCoverage * 1150
  score += nameCoverage.objectTokenCoverage * 1050
  score += nameCoverage.domainTokenCoverage * 120
  score += snippetCoverage.actionTokenCoverage * 260
  score += snippetCoverage.objectTokenCoverage * 180
  score += snippetCoverage.domainTokenCoverage * 35
  if (isFunctionLikeEvidence(item)) score += 120
  if (statementPosition && isLikelyCallableHelper(item, input, coverage, nameCoverage)) score += nameActionObjectCoverage > 0 ? 720 : 180
  if (isSameModulePath(item.path, input.currentFile)) score += 80
  const cursorScores = cursorContextScores(item, input, coverage)
  score += cursorScores.currentFunctionFlowScore
  score += cursorScores.neighborCallProximityScore
  score += cursorScores.callStatementFitScore
  score += cursorScores.messageTextSimilarityScore
  score -= cursorScores.stateStylePenalty
  if (nameActionObjectCoverage <= 0 && snippetActionObjectCoverage > 0) score -= 180
  if (domainOnly) score -= 260
  if (isSummaryLikeEvidence(item)) score -= 220
  return { totalScore: score, cursorScores }
}

function cursorContextScores(
  item: RepositoryEvidenceItem,
  input: RepositoryEvidenceForIntentInput,
  coverage: ReturnType<typeof scoreCommentGuidedCandidate>,
): RepositoryEvidenceCursorContextScores {
  const features = input.cursorContext
  if (!features) {
    return {
      currentFunctionFlowScore: 0,
      neighborCallProximityScore: 0,
      callStatementFitScore: 0,
      messageTextSimilarityScore: 0,
      stateStylePenalty: 0,
    }
  }
  const candidateText = [item.name, item.path, item.reason, item.snippet].filter(Boolean).join("\n")
  const candidateTokens = new Set(tokenize(candidateText))
  const currentFunctionTokens = tokenize(features.currentFunctionName ?? "").filter((token) => token.length > 2)
  const currentFunctionFlowScore = Math.min(tokenOverlapScore(currentFunctionTokens, candidateTokens, 35), 120)
  const neighborTokens = [
    ...features.previousStatementCalls,
    ...features.nextStatementCalls,
  ].flatMap(tokenize).filter((token) => token.length > 2)
  const neighborCallProximityScore = Math.min(tokenOverlapScore(neighborTokens, candidateTokens, 28), 120)
  const callable = isFunctionLikeEvidence(item) && functionParamsCanBeSatisfied(item.snippet, input)
  const actionObjectMatch = coverage.actionTokenCoverage > 0 || coverage.objectTokenCoverage > 0
  const callStatementFitScore = features.statementHoleKind === "blank-statement" && callable && actionObjectMatch ? 220 : 0
  const messageTokens = features.nearbyLogOrMessageText.flatMap(tokenize).filter((token) => token.length > 2)
  const messageTextSimilarityScore = Math.min(tokenOverlapScore(messageTokens, candidateTokens, 18), 90)
  const stateStylePenalty = features.statementHoleKind === "blank-statement" && isStateStyleEvidence(item) ? 240 : 0
  return {
    currentFunctionFlowScore,
    neighborCallProximityScore,
    callStatementFitScore,
    messageTextSimilarityScore,
    stateStylePenalty,
  }
}

function tokenOverlapScore(tokens: string[], candidateTokens: Set<string>, weight: number) {
  let score = 0
  const seen = new Set<string>()
  for (const token of tokens) {
    if (seen.has(token) || !candidateTokens.has(token)) continue
    seen.add(token)
    score += weight
  }
  return score
}

function isStateStyleEvidence(item: RepositoryEvidenceItem) {
  const text = `${item.name ?? ""}\n${item.reason ?? ""}\n${item.snippet}`.toLowerCase()
  return /\b(?:fsm|state|sub_fsm|transition)\b/.test(text) || /\bset_[a-z0-9_]*state\b/.test(text)
}

function isLikelyCallableHelper(
  item: RepositoryEvidenceItem,
  input: RepositoryEvidenceForIntentInput,
  coverage: ReturnType<typeof scoreCommentGuidedCandidate>,
  nameCoverage = coverage,
) {
  if (!isFunctionLikeEvidence(item)) return false
  if (nameCoverage.actionTokenCoverage <= 0 || nameCoverage.objectTokenCoverage <= 0) return false
  if (sameRepositoryPath(item.path ?? "", input.currentFile) && item.name?.toLowerCase() === input.currentFunction?.toLowerCase()) return false
  return functionParamsCanBeSatisfied(item.snippet, input)
}

function isFunctionLikeEvidence(item: RepositoryEvidenceItem) {
  if (item.kind === "function" || item.parserKind === "function-summary") return true
  return /^\s*(?:static\s+)?(?:inline\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|;)/m.test(item.snippet)
}

function isFunctionDefinitionEvidence(item: RepositoryEvidenceItem) {
  if (item.parserKind === "function-summary") return true
  return /^\s*(?:static\s+)?(?:inline\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|;)/m.test(item.snippet.trim())
}

function functionParamsCanBeSatisfied(snippet: string, input: RepositoryEvidenceForIntentInput) {
  const params = firstFunctionParams(snippet)
  if (!params) return true
  const normalized = params.trim()
  if (!normalized || normalized === "void") return true
  const paramNames = normalized.split(",").map((param) =>
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(param.trim())?.[1] ?? "",
  ).filter(Boolean)
  if (paramNames.length === 0) return true
  const visible = new Set([
    ...(input.nearbyIdentifiers ?? []),
    ...tokenize(input.prefix ?? ""),
  ].map((token) => token.toLowerCase()))
  return paramNames.every((name) => visible.has(name.toLowerCase())) || paramNames.length <= 1
}

function firstFunctionParams(snippet: string) {
  return /^[^{;\n]*\b[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/m.exec(snippet.trim())?.[1]
}

function isStatementInsertionPosition(prefix: string, suffix: string) {
  const linePrefix = prefix.replace(/\r\n/g, "\n").split("\n").at(-1) ?? ""
  const lineSuffix = suffix.replace(/\r\n/g, "\n").split("\n")[0] ?? ""
  if (/\b(?:if|while|for|switch)\s*\([^)]*$/.test(linePrefix)) return false
  if (/(?:->|\.|=|\+|-|\*|\/|%|&&|\|\||,|\()\s*$/.test(linePrefix)) return false
  if (/^\s*(?:[)\]}]|==|!=|<=|>=|&&|\|\||,)/.test(lineSuffix)) return false
  return true
}

function isSameModulePath(path: string | undefined, currentFile: string) {
  if (!path) return false
  const left = normalizePath(path).split("/")
  const right = normalizePath(currentFile).split("/")
  left.pop()
  right.pop()
  return left.join("/") === right.join("/")
}

function isSummaryLikeEvidence(item: RepositoryEvidenceItem) {
  return item.source === "summary" ||
    item.kind === "module" ||
    item.kind === "text" ||
    item.parserKind?.includes("summary") ||
    /^file\s+\S+:\s+\d+\s+function\(s\),/i.test(item.snippet.trim())
}

function isBroadUtilityEvidence(item: RepositoryEvidenceItem) {
  const name = item.name ?? evidenceName(item.snippet) ?? ""
  const text = `${name}\n${item.reason ?? ""}`.toLowerCase()
  const tokens = text.split(/[^a-z0-9]+|_/).filter(Boolean)
  return tokens.some((token) => /^(?:dump|debug|dbg|print|printf|trace|log)/.test(token))
}

function isCodeLikeEvidence(item: RepositoryEvidenceItem) {
  if (item.source === "state-machine") return true
  if (item.kind === "function" || item.kind === "macro" || item.kind === "type" || item.kind === "global") return true
  if (item.parserKind === "function-summary" || item.parserKind === "state-transition") return true
  const snippet = item.snippet.trim()
  if (!snippet) return false
  if (/^file\s+\S+:\s+\d+\s+function\(s\),/i.test(snippet)) return false
  if (/^\w[\w-]*\s+summary:/i.test(snippet)) return false
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|;)/.test(snippet) ||
    /^\s*#\s*(?:define|include)\b/m.test(snippet) ||
    /\b(?:struct|union|enum|typedef)\b/.test(snippet) ||
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*;/.test(snippet) ||
    (/\b(?:if|while|for|switch|goto|return)\b/.test(snippet) && /[;{}]/.test(snippet))
}

function formatRepositoryEvidenceItem(item: RepositoryEvidenceItem) {
  return [
    `kind=${item.kind}`,
    item.name ? `name=${item.name}` : "",
    item.path ? `source=${item.path}:${item.startLine ?? 1}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ""}` : "",
    `retrieval-source=${item.source}`,
    item.reason ? `reason=${item.reason}` : "",
    item.snippet,
  ].filter(Boolean).join("\n")
}

function evidenceSource(reason: string): RepositoryEvidenceSource {
  if (reason.includes("rerank:")) return "rerank"
  if (reason.startsWith("vector:")) return "vector"
  if (reason.includes("state-machine")) return "state-machine"
  return "graph"
}

function repositoryRetrievalMode(result: QueryEvidenceResult | undefined, fallbackUsed: boolean): RepositoryEvidenceTrace["retrievalMode"] {
  if (fallbackUsed) return "graph-only-fallback"
  const steps = result?.trace.steps ?? []
  if (steps.some((step) => step.label === "rerank")) return "hybrid"
  if (steps.some((step) => step.label === "vector")) return "vector"
  if (steps.some((step) => step.label === "hybrid-retrieval")) return "hybrid"
  return "graph"
}

function alignmentReasonFor(input: {
  fullTopK: RepositoryEvidenceItem[]
  completionPack: RepositoryEvidencePack
  timedOut: boolean
  retrievalMode: RepositoryEvidenceTrace["retrievalMode"]
  rerankEnabled: boolean
  ragAvailable: boolean
}): RepositoryEvidenceAlignmentReason {
  const top = candidateNames(input.fullTopK)[0]
  if (!top) return "not-in-index"
  if (candidateNames(input.completionPack.evidence).includes(top)) return "aligned"
  if (input.timedOut) return "latency-budget"
  if (input.retrievalMode === "graph-only-fallback") return "graph-only-fallback"
  if (!input.ragAvailable) return "rag-unavailable"
  if (!input.rerankEnabled) return "rerank-disabled"
  if (input.completionPack.truncated) return "projection-trimmed"
  return "max-evidence"
}

function candidateNames(items: RepositoryEvidenceItem[]) {
  return uniqueStrings(items.map((item) => item.name).filter((name): name is string => typeof name === "string" && name.length > 0 && !isGenericEvidenceName(name)))
}

function evidenceName(snippet: string) {
  const explicit = /(?:function|symbol|name):\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(snippet)?.[1]
  if (explicit && !isGenericEvidenceName(explicit)) return explicit
  return snippet.split(/\r?\n/).map((line) => {
    const name = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line)?.[1]
    return name && !isGenericEvidenceName(name) ? name : undefined
  }).find(Boolean)
}

function isGenericEvidenceName(name: string) {
  return /^(?:file|function|functions|macro|macros|type|types|summary|module|if|while|for|switch|return|sizeof)$/i.test(name)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^file:\/\//, "")
}

function sameRepositoryPath(left: string, right: string) {
  const normalizedLeft = normalizePath(left)
  const normalizedRight = normalizePath(right)
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
}

function dedupeEvidence(items: RepositoryEvidenceItem[]) {
  const byKey = new Map<string, RepositoryEvidenceItem>()
  for (const item of items) {
    const key = `${item.kind}\0${item.path ?? ""}\0${item.startLine ?? 0}\0${item.endLine ?? 0}\0${item.snippet.slice(0, 100)}`
    const existing = byKey.get(key)
    if (!existing || item.score > existing.score) byKey.set(key, item)
  }
  return [...byKey.values()]
}

function headLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(0, count).join("\n")
}

function tailLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(-count).join("\n")
}

function oneLine(input: string, max: number) {
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).replace(/\s+$/, "")}...`
}

function tokenize(input: string) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+|_+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
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
