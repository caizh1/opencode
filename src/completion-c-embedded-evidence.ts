import type { QueryEvidenceResult, StateMachine } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence } from "./codegraph-types"
import { normalizeCommentGuidedTokens, scoreCommentGuidedCandidate, type CommentGuidedTokenCoverage, type CommentGuidedTokenGroups } from "./completion-comment-guided-ranking"
import type { CompletionCIntent, CompletionPlan } from "./completion-types"
import { retrieveRepositoryEvidenceForIntent, type RepositoryEvidenceAlignmentReason, type RepositoryEvidenceItem, type RepositoryEvidenceResult } from "./repository-evidence"

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
}

export type CEmbeddedCompletionEvidenceResult = {
  text: string
  items: CEmbeddedEvidenceItem[]
  evidenceKinds: CEmbeddedEvidenceKind[]
  selectedEvidenceCount: number
  retrievalMode: "none" | "graph-only" | "hybrid"
  trace: CEmbeddedEvidenceTrace
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
  const repository = await retrieveRepositoryEvidenceForIntent({
    codeGraph: input.codeGraph,
    mode: "completion",
    task: "comment-guided-code",
    sourceComment,
    currentFile: currentPathFromEvidenceQuestion(input.question) ?? input.relatedPaths[0] ?? "",
    currentFunction: currentFunctionFromEvidenceQuestion(input.question),
    prefix: input.prefix,
    suffix: input.suffix,
    nearbyIdentifiers: nearbyIdentifiersFromEvidenceQuestion(input.question),
    maxEvidence: maxItems,
    maxBytes: 4_000,
    latencyBudgetMs: input.retrievalBudgetMs,
  })
  const finalItems = repository.completionPack.evidence.map((item) =>
    evidenceItemFromRepositoryEvidence(item, input.domainHints ?? [], commentTokens))
  const selected = selectPromptEvidenceItems(input.intent, finalItems, maxItems)
  const usefulEvidence = minimumUsefulEvidence(input.intent, selected, true)
  const trace = commentGuidedRepositoryTrace({
    repository,
    selected,
    commentTokens,
    usefulEvidenceMet: usefulEvidence.met,
    retrievalStarted: input.retrievalStarted,
    retrievalBudgetMs: input.retrievalBudgetMs,
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
  const source = evidence.source === "vector" || evidence.source === "rerank" || evidence.source === "hybrid" ? "rag" : "graph"
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

function repositoryEvidenceKind(evidence: RepositoryEvidenceItem): CEmbeddedEvidenceKind {
  const reason = `${evidence.kind} ${evidence.reason ?? ""} ${evidence.parserKind ?? ""}`.toLowerCase()
  if (evidence.kind === "function" || evidence.parserKind === "function-summary" || /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(evidence.snippet)) {
    return "c-comment-semantic-match"
  }
  if (reason.includes("state")) return "c-state-machine"
  if (reason.includes("module") || reason.includes("summary")) return "c-same-module-flow"
  return "c-similar-block"
}

function commentGuidedRepositoryTrace(input: {
  repository: RepositoryEvidenceResult
  selected: CEmbeddedEvidenceItem[]
  commentTokens: CommentGuidedTokenGroups
  usefulEvidenceMet: boolean
  retrievalStarted: number
  retrievalBudgetMs: number | undefined
}): CEmbeddedEvidenceTrace {
  const qaRetrievalTopK = input.repository.trace.topCandidateNames
  const completionRetrievalTopK = input.repository.trace.selectedCandidateNames
  const qaTopCandidate = qaRetrievalTopK[0]
  const completionTopCandidate = completionRetrievalTopK[0]
  const telemetryCandidates = input.repository.fullTopK.filter((item) => item.name).slice(0, 8)
  return {
    ragFallbackTriggered: input.repository.trace.retrievalMode === "graph-only-fallback",
    ragFallbackReason: input.repository.trace.alignmentReason === "graph-only-fallback" ? "shared repository evidence fell back to graph-only retrieval" : undefined,
    graphEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "graph").length,
    ragEvidenceCount: input.repository.fullTopK.filter((item) => item.source === "vector" || item.source === "rerank" || item.source === "hybrid").length,
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
    retrievalBudgetMs: input.retrievalBudgetMs,
    retrievalTimedOut: input.repository.trace.timedOut || (input.retrievalBudgetMs !== undefined && input.repository.trace.latencyMs > input.retrievalBudgetMs),
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
  }
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

function nearbyIdentifiersFromEvidenceQuestion(question: string) {
  const prefix = "nearby-identifiers:"
  const value = question.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(prefix))?.slice(prefix.length).trim() ?? ""
  return value.split(/[^A-Za-z0-9_]+/).filter((token) => token.length >= 2)
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
    ...items.map(formatPromptEvidenceItem),
  ].join("\n\n")
}

function formatPromptEvidenceItem(item: CEmbeddedEvidenceItem) {
  return [
    `C evidence: ${item.kind}`,
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
