import type { EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence } from "./codegraph-types"
import { normalizeCommentGuidedTokens, scoreCommentGuidedCandidate } from "./completion-comment-guided-ranking"
import type { CommentGuidedCursorContextFeatures } from "./completion-cursor-context"

export type RepositoryEvidenceMode = "qa" | "completion"

export type RepositoryEvidenceTask =
  | "comment-guided-code"
  | "member-access"
  | "call-args"
  | "initializer"
  | "error-path"
  | "state-machine"
  | "mmio-register"
  | "body-statement"

export type RepositoryEvidenceSource = "graph" | "vector" | "rerank" | "summary" | "state-machine" | "hybrid"

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
  codeGraph: Pick<CodeGraphContextProvider, "queryEvidence">
  mode: RepositoryEvidenceMode
  task: RepositoryEvidenceTask
  question?: string
  sourceComment?: string
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
}

type TimedEvidenceQuery = {
  result?: QueryEvidenceResult
  timedOut: boolean
  elapsedMs: number
  timeoutStage?: string
}

export async function retrieveRepositoryEvidenceForIntent(input: RepositoryEvidenceForIntentInput): Promise<RepositoryEvidenceResult> {
  const started = Date.now()
  const queryText = repositoryEvidenceQuery(input)
  const queryTokens = repositoryEvidenceQueryTokens(input)
  const budget = input.debugFullRetrievalProbe ? undefined : input.latencyBudgetMs
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
  const completionPack = packRepositoryEvidence(completionProjectionRanked, Math.min(maxEvidence, 3), Math.min(input.maxBytes ?? 4_000, 4_000))
  const retrievalMode = repositoryRetrievalMode(retrievalResult, fallbackUsed)
  const rerankEnabled = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "rerank"))
  const ragAvailable = Boolean(retrievalResult?.trace.steps.some((step) => step.label === "vector" || step.label === "rerank"))
  const topCandidateNames = candidateNames(fullTopK).slice(0, 8)
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
      alignmentReason,
    },
  }
}

function repositoryEvidenceQuery(input: RepositoryEvidenceForIntentInput) {
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
    input.question ? `question: ${input.question}` : "",
    `task: ${input.task}`,
    `current-file: ${input.currentFile}`,
    input.currentFunction ? `current-function: ${input.currentFunction}` : "",
    input.sourceComment ? `source-comment: ${input.sourceComment}` : "",
    input.nearbyIdentifiers?.length ? `nearby-identifiers: ${input.nearbyIdentifiers.join(" ")}` : "",
    input.cursorContext ? formatCursorContextFeatures(input.cursorContext) : "",
    input.prefix ? `prefix-context:\n${tailLines(input.prefix, 28)}` : "",
    input.suffix ? `suffix-context:\n${headLines(input.suffix, 18)}` : "",
    "goal: retrieve similar functions, code blocks, graph evidence, vector evidence, and rerank trace that ground the requested code.",
  ].filter(Boolean).join("\n")
}

function repositoryEvidenceQueryTokens(input: RepositoryEvidenceForIntentInput) {
  return uniqueStrings([
    ...tokenize(input.sourceComment ?? ""),
    ...tokenize(input.question ?? ""),
    ...tokenize(input.currentFile),
    ...tokenize(input.currentFunction ?? ""),
    ...(input.nearbyIdentifiers ?? []).flatMap(tokenize),
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

function repositoryEvidenceQueryOptions(input: RepositoryEvidenceForIntentInput) {
  const completionComment = input.mode === "completion" && input.task === "comment-guided-code"
  if (completionComment && input.debugFullRetrievalProbe) {
    return {
      maxEvidenceItems: 200,
      maxEvidenceBytes: 200_000,
      latencyBudgetMs: undefined,
    }
  }
  return {
    maxEvidenceItems: completionComment ? Math.max(input.maxEvidence * 8, 24) : undefined,
    maxEvidenceBytes: completionComment ? Math.max(input.maxBytes ?? 0, 18_000) : input.maxBytes,
    latencyBudgetMs: input.latencyBudgetMs,
  }
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

function repositoryEvidenceItems(result: QueryEvidenceResult | undefined): RepositoryEvidenceItem[] {
  const items: RepositoryEvidenceItem[] = []
  for (const evidence of result?.retrieval?.evidence ?? []) {
    items.push(repositoryItemFromCodeGraphEvidence(evidence))
  }
  for (const evidence of result?.stateMachines.flatMap((machine) => machine.evidence) ?? []) {
    items.push(repositoryItemFromEvidenceRef(evidence, "state-machine"))
  }
  for (const evidence of result?.evidencePack.evidence ?? []) {
    items.push(repositoryItemFromEvidenceRef(evidence, "summary"))
  }
  return dedupeEvidence(items)
    .sort((left, right) => right.score - left.score || (left.path ?? "").localeCompare(right.path ?? "") || (left.startLine ?? 0) - (right.startLine ?? 0))
}

function repositoryItemFromCodeGraphEvidence(evidence: CodeGraphEvidence): RepositoryEvidenceItem {
  return {
    kind: evidence.kind,
    name: evidenceName(evidence.snippet),
    source: evidenceSource(evidence.reason),
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    snippet: evidence.snippet,
    score: evidence.score,
    reason: evidence.reason,
  }
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

function completionProjectionItems(items: RepositoryEvidenceItem[], input: RepositoryEvidenceForIntentInput) {
  if (input.mode !== "completion") return items
  const currentFile = normalizePath(input.currentFile)
  const currentFunction = input.currentFunction?.toLowerCase()
  const filtered = items.filter((item) => {
    if (!isCodeLikeEvidence(item)) return false
    if (
      input.task === "comment-guided-code" &&
      currentFunction &&
      sameRepositoryPath(item.path ?? "", currentFile) &&
      item.name?.toLowerCase() === currentFunction
    ) {
      return false
    }
    return true
  })
  if (input.task !== "comment-guided-code") return filtered
  return rankCommentGuidedProjectionItems(filtered, input)
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
  const actionObjectCoverage = coverage.actionTokenCoverage + coverage.objectTokenCoverage
  const domainOnly = actionObjectCoverage <= 0 && coverage.domainTokenCoverage > 0
  let score = item.score
  score += coverage.actionTokenCoverage * 520
  score += coverage.objectTokenCoverage * 420
  score += coverage.domainTokenCoverage * 45
  if (isFunctionLikeEvidence(item)) score += 120
  if (statementPosition && isLikelyCallableHelper(item, input, coverage)) score += 520
  if (isSameModulePath(item.path, input.currentFile)) score += 80
  const cursorScores = cursorContextScores(item, input, coverage)
  score += cursorScores.currentFunctionFlowScore
  score += cursorScores.neighborCallProximityScore
  score += cursorScores.callStatementFitScore
  score += cursorScores.messageTextSimilarityScore
  score -= cursorScores.stateStylePenalty
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
) {
  if (!isFunctionLikeEvidence(item)) return false
  if (coverage.actionTokenCoverage <= 0 || coverage.objectTokenCoverage <= 0) return false
  if (sameRepositoryPath(item.path ?? "", input.currentFile) && item.name?.toLowerCase() === input.currentFunction?.toLowerCase()) return false
  return functionParamsCanBeSatisfied(item.snippet, input)
}

function isFunctionLikeEvidence(item: RepositoryEvidenceItem) {
  if (item.kind === "function" || item.parserKind === "function-summary") return true
  return /^\s*(?:static\s+)?(?:inline\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|;)/m.test(item.snippet)
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
