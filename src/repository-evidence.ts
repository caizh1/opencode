import type { EvidenceRef, QueryEvidenceResult } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence } from "./codegraph-types"

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
  alignmentReason?: RepositoryEvidenceAlignmentReason
}

export type RepositoryEvidenceResult = {
  fullTopK: RepositoryEvidenceItem[]
  qaPack: RepositoryEvidencePack
  completionPack: RepositoryEvidencePack
  trace: RepositoryEvidenceTrace
  retrievalResult?: QueryEvidenceResult
  alignmentCandidates: RepositoryEvidenceItem[]
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
  const budget = input.latencyBudgetMs
  let query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
    retrievalMode: "hybrid",
    relatedPaths: [input.currentFile],
  }, budget, "hybrid")
  let retrievalResult = query.result
  let fallbackUsed = false
  let timeoutStage = query.timeoutStage

  if (!retrievalResult && query.timedOut) {
    fallbackUsed = true
    const fallbackBudget = budget === undefined ? undefined : Math.max(1, Math.min(500, budget))
    query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
      retrievalMode: "graph-only",
      relatedPaths: [input.currentFile],
    }, fallbackBudget, "graph-only-fallback")
    timeoutStage = timeoutStage ?? query.timeoutStage
    retrievalResult = query.result
  } else if (!retrievalResult) {
    fallbackUsed = true
    query = await queryEvidenceWithTimeout(input.codeGraph, queryText, {
      retrievalMode: "graph-only",
      relatedPaths: [input.currentFile],
    }, budget, "graph-only-fallback")
    timeoutStage = timeoutStage ?? query.timeoutStage
    retrievalResult = query.result
  }

  const latencyMs = Date.now() - started
  const timedOut = query.timedOut || (budget !== undefined && latencyMs > budget)
  const fullTopK = repositoryEvidenceItems(retrievalResult)
  const maxEvidence = Math.max(1, input.maxEvidence)
  const qaPack = packRepositoryEvidence(fullTopK, maxEvidence, input.maxBytes ?? 24_000)
  const completionPack = packRepositoryEvidence(completionProjectionItems(fullTopK, input), Math.min(maxEvidence, 3), Math.min(input.maxBytes ?? 4_000, 4_000))
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
      alignmentReason,
    },
  }
}

function repositoryEvidenceQuery(input: RepositoryEvidenceForIntentInput) {
  return [
    "Repository evidence request for local code intelligence.",
    input.question ? `question: ${input.question}` : "",
    `task: ${input.task}`,
    `current-file: ${input.currentFile}`,
    input.currentFunction ? `current-function: ${input.currentFunction}` : "",
    input.sourceComment ? `source-comment: ${input.sourceComment}` : "",
    input.nearbyIdentifiers?.length ? `nearby-identifiers: ${input.nearbyIdentifiers.join(" ")}` : "",
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
  return items.filter((item) => {
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
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*;/.test(snippet)
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
  return /^(?:file|function|functions|macro|macros|type|types|summary|module)$/i.test(name)
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
