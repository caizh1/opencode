import type { EvidenceRef, QueryEvidenceResult } from "../analysis-types"
import type { CodeGraphContextProvider } from "../codegraph-types"
import type { CodeGraphStatus, RagStatus, RemoteSettings } from "../types"
import type { CommentDiagnosticStageEvent } from "./commentDiagnostics"
import type {
  CommentEvidenceSections,
  CommentGenerationContext,
  CommentGroundingConfidence,
  CommentOutputDirective,
} from "./commentTypes"

const COMMENT_EVIDENCE_LATENCY_BUDGET_MS = 2000
const COMMENT_EVIDENCE_FUNCTION_LIMIT = 2
const COMMENT_EVIDENCE_MODULE_LIMIT = 1
const COMMENT_EVIDENCE_STATE_MACHINE_LIMIT = 1
const COMMENT_EVIDENCE_REF_LIMIT = 4
const COMMENT_EVIDENCE_SUMMARY_LIMIT = 6000
const COMMENT_EVIDENCE_SELECTION_LINE_LIMIT = 10
const COMMENT_EVIDENCE_IDENTIFIER_LIMIT = 18

const C_FAMILY_KEYWORDS = new Set([
  "alignas",
  "alignof",
  "asm",
  "auto",
  "bool",
  "break",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "continue",
  "decltype",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "false",
  "float",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "nullptr",
  "operator",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "true",
  "try",
  "typedef",
  "typename",
  "union",
  "unsigned",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
])

export type CommentEvidenceServiceInput = {
  codeGraph?: Pick<CodeGraphContextProvider, "queryEvidence" | "status">
  getSettings: () => RemoteSettings
}

export type CommentEvidenceSuccess = {
  ok: true
  retrievalMode: "graph-only" | "hybrid"
  evidenceSections: CommentEvidenceSections
  evidenceSummary: string
  evidenceItemCount: number
  evidenceSummaryBytes: number
  graphElapsedMs: number
  hybridElapsedMs?: number
  fallbackReason?: string
  graphSummaryFunctionCount: number
  graphSummaryModuleCount: number
  graphSummaryStateMachineCount: number
  graphDirectRefCount: number
  ragRefCount: number
  missingEvidenceCount: number
  identifierCount: number
  anchorCount: number
  outputDirective: CommentOutputDirective
  groundingConfidence: CommentGroundingConfidence
  groundingSummary: string
  evidenceCompacted: boolean
}

export type CommentEvidenceFailure = {
  ok: false
  reason: "codegraph-not-ready" | "no-graph-evidence"
  message: string
  graphElapsedMs?: number
  hybridElapsedMs?: number
  fallbackReason?: string
  graphSummaryFunctionCount: number
  graphSummaryModuleCount: number
  graphSummaryStateMachineCount: number
  graphDirectRefCount: number
  ragRefCount: number
  missingEvidenceCount: number
  identifierCount: number
  anchorCount: number
  outputDirective: CommentOutputDirective
  groundingConfidence: CommentGroundingConfidence
  groundingSummary: string
  evidenceCompacted: boolean
}

export type CommentEvidenceResult = CommentEvidenceSuccess | CommentEvidenceFailure

export type CommentEvidenceDiagnosticLogger = (event: CommentDiagnosticStageEvent) => void

export class CommentEvidenceService {
  constructor(private readonly deps: CommentEvidenceServiceInput) {}

  async collect(context: CommentGenerationContext, logger?: CommentEvidenceDiagnosticLogger): Promise<CommentEvidenceResult> {
    const settings = this.deps.getSettings()
    const codeGraph = this.deps.codeGraph
    const identifiers = extractSelectionIdentifiers(context.selectedCode)
    const anchorLines = selectionAnchorLines(context.selectedCode)
    const baseCounts = {
      graphSummaryFunctionCount: 0,
      graphSummaryModuleCount: 0,
      graphSummaryStateMachineCount: 0,
      graphDirectRefCount: 0,
      ragRefCount: 0,
      missingEvidenceCount: 0,
      identifierCount: identifiers.length,
      anchorCount: anchorLines.length,
      outputDirective: "allow-empty" as const,
      groundingConfidence: "none" as const,
      groundingSummary: "仓库证据暂不可用于注释生成。",
      evidenceCompacted: false,
    }
    if (!settings.codeGraph.enabled || !codeGraph) {
      logger?.({
        stage: "evidence.graph.unavailable",
        fields: {
          reason: settings.codeGraph.enabled ? "codegraph-unavailable" : "codegraph-disabled",
          ...baseCounts,
        },
      })
      return {
        ok: false,
        reason: "codegraph-not-ready",
        message: "AI 注释需要本地 CodeGraph 证据。请启用 CodeGraph，并等待索引完成。",
        fallbackReason: settings.codeGraph.enabled ? "codegraph-unavailable" : "codegraph-disabled",
        ...baseCounts,
      }
    }

    const status = codeGraph.status()
    if (status.state !== "ready") {
      logger?.({
        stage: "evidence.graph.unavailable",
        fields: {
          reason: `codegraph-${status.state}`,
          state: status.state,
          detail: status.detail || "",
          ...baseCounts,
        },
      })
      return {
        ok: false,
        reason: "codegraph-not-ready",
        message: codeGraphNotReadyMessage(status),
        fallbackReason: `codegraph-${status.state}`,
        ...baseCounts,
      }
    }

    logger?.({
      stage: "evidence.graph.start",
      fields: {
        retrievalMode: "graph-only",
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
      },
    })
    const graphQuestion = buildGraphEvidenceQuestion(context, identifiers, anchorLines)
    const graphStarted = Date.now()
    const graphResult = await codeGraph.queryEvidence(graphQuestion, {
      retrievalMode: "graph-only",
      relatedPaths: [context.workspacePath],
      maxEvidenceItems: settings.analysis.maxEvidenceItems,
      maxEvidenceBytes: settings.analysis.maxEvidenceBytes,
    })
    const graphElapsedMs = Date.now() - graphStarted
    const graphSelection = selectRelevantGraphSelection(graphResult, context, identifiers)
    const graphCounts = {
      graphSummaryFunctionCount: graphSelection.functions.length,
      graphSummaryModuleCount: graphSelection.modules.length,
      graphSummaryStateMachineCount: graphSelection.stateMachines.length,
      graphDirectRefCount: graphSelection.directRefs.length,
      missingEvidenceCount: graphResult?.evidencePack.missingEvidence.length ?? 0,
      groundingConfidence: graphResult?.answerPolicy.confidence ?? "none",
      evidenceCompacted: isEvidenceCompacted(graphResult, graphSelection),
    }
    const graphGroundingSummary = groundingSummaryForComments({
      retrievalMode: "graph-only",
      confidence: graphCounts.groundingConfidence,
      graphResult,
      hybridResult: undefined,
      evidenceCompacted: graphCounts.evidenceCompacted,
    })
    const graphOutputDirective = decideOutputDirective("graph-only", graphCounts.graphDirectRefCount, graphCounts.groundingConfidence)
    logger?.({
      stage: "evidence.graph.done",
      fields: {
        elapsedMs: graphElapsedMs,
        graphSummaryFunctionCount: graphCounts.graphSummaryFunctionCount,
        graphSummaryModuleCount: graphCounts.graphSummaryModuleCount,
        graphSummaryStateMachineCount: graphCounts.graphSummaryStateMachineCount,
        graphDirectRefCount: graphCounts.graphDirectRefCount,
        missingEvidenceCount: graphCounts.missingEvidenceCount,
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
        groundingConfidence: graphCounts.groundingConfidence,
        outputDirective: graphOutputDirective,
        evidenceCompacted: graphCounts.evidenceCompacted,
      },
    })
    if (graphSelection.directRefs.length === 0) {
      return {
        ok: false,
        reason: "no-graph-evidence",
        message: "没有找到可支撑当前选区注释的仓库证据。请调整选区，或等待索引完成后重试。",
        graphElapsedMs,
        fallbackReason: "graph-empty",
        graphSummaryFunctionCount: graphCounts.graphSummaryFunctionCount,
        graphSummaryModuleCount: graphCounts.graphSummaryModuleCount,
        graphSummaryStateMachineCount: graphCounts.graphSummaryStateMachineCount,
        graphDirectRefCount: 0,
        ragRefCount: 0,
        missingEvidenceCount: graphCounts.missingEvidenceCount,
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
        outputDirective: graphOutputDirective,
        groundingConfidence: graphCounts.groundingConfidence,
        groundingSummary: graphGroundingSummary,
        evidenceCompacted: graphCounts.evidenceCompacted,
      }
    }

    if (!isCommentRagReady(status.rag)) {
      const evidenceSections = buildEvidenceSections({
        context,
        identifiers,
        anchorLines,
        graphSelection,
        graphResult,
        groundingSummary: graphGroundingSummary,
        retrievalMode: "graph-only",
      })
      const evidenceSummary = limitText(buildEvidenceSummary(evidenceSections), COMMENT_EVIDENCE_SUMMARY_LIMIT)
      return {
        ok: true,
        retrievalMode: "graph-only",
        evidenceSections,
        evidenceSummary,
        evidenceItemCount: graphSelection.directRefs.length,
        evidenceSummaryBytes: byteLength(evidenceSummary),
        graphElapsedMs,
        fallbackReason: "rag-not-ready",
        graphSummaryFunctionCount: graphCounts.graphSummaryFunctionCount,
        graphSummaryModuleCount: graphCounts.graphSummaryModuleCount,
        graphSummaryStateMachineCount: graphCounts.graphSummaryStateMachineCount,
        graphDirectRefCount: graphCounts.graphDirectRefCount,
        ragRefCount: 0,
        missingEvidenceCount: graphCounts.missingEvidenceCount,
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
        outputDirective: graphOutputDirective,
        groundingConfidence: graphCounts.groundingConfidence,
        groundingSummary: graphGroundingSummary,
        evidenceCompacted: graphCounts.evidenceCompacted,
      }
    }

    logger?.({
      stage: "evidence.hybrid.start",
      fields: {
        retrievalMode: "hybrid",
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
      },
    })
    const hybridQuestion = buildHybridEvidenceQuestion(context, identifiers, anchorLines)
    const hybridStarted = Date.now()
    try {
      const hybridResult = await codeGraph.queryEvidence(hybridQuestion, {
        retrievalMode: "hybrid",
        relatedPaths: [context.workspacePath],
        maxEvidenceItems: settings.analysis.maxEvidenceItems,
        maxEvidenceBytes: settings.analysis.maxEvidenceBytes,
        latencyBudgetMs: COMMENT_EVIDENCE_LATENCY_BUDGET_MS,
      })
      const hybridElapsedMs = Date.now() - hybridStarted
      const hybridRefs = uniqueEvidenceRefs(hybridResult)
      const ragRefs = subtractEvidenceRefs(hybridRefs, graphSelection.directRefs)
      const hybridGroundingConfidence = hybridResult?.answerPolicy.confidence ?? graphCounts.groundingConfidence
      const hybridOutputDirective = decideOutputDirective("hybrid", graphCounts.graphDirectRefCount, hybridGroundingConfidence)
      const hybridEvidenceCompacted = isEvidenceCompacted(hybridResult, graphSelection, ragRefs)
      logger?.({
        stage: "evidence.hybrid.done",
        fields: {
          elapsedMs: hybridElapsedMs,
          ragRefCount: ragRefs.length,
          missingEvidenceCount: hybridResult?.evidencePack.missingEvidence.length ?? 0,
          outputDirective: hybridOutputDirective,
          groundingConfidence: hybridGroundingConfidence,
          evidenceCompacted: hybridEvidenceCompacted,
        },
      })
      const hybridGroundingSummary = groundingSummaryForComments({
        retrievalMode: "hybrid",
        confidence: hybridGroundingConfidence,
        graphResult,
        hybridResult,
        evidenceCompacted: hybridEvidenceCompacted,
      })
      const mergedRefs = uniqueEvidenceRefs(graphResult, hybridResult)
      const evidenceSections = buildEvidenceSections({
        context,
        identifiers,
        anchorLines,
        graphSelection,
        graphResult,
        hybridResult,
        ragRefs,
        groundingSummary: hybridGroundingSummary,
        retrievalMode: "hybrid",
      })
      const evidenceSummary = limitText(buildEvidenceSummary(evidenceSections), COMMENT_EVIDENCE_SUMMARY_LIMIT)
      return {
        ok: true,
        retrievalMode: "hybrid",
        evidenceSections,
        evidenceSummary,
        evidenceItemCount: mergedRefs.length,
        evidenceSummaryBytes: byteLength(evidenceSummary),
        graphElapsedMs,
        hybridElapsedMs,
        graphSummaryFunctionCount: graphCounts.graphSummaryFunctionCount,
        graphSummaryModuleCount: graphCounts.graphSummaryModuleCount,
        graphSummaryStateMachineCount: graphCounts.graphSummaryStateMachineCount,
        graphDirectRefCount: graphCounts.graphDirectRefCount,
        ragRefCount: ragRefs.length,
        missingEvidenceCount: Math.max(
          graphCounts.missingEvidenceCount,
          hybridResult?.evidencePack.missingEvidence.length ?? 0,
        ),
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
        outputDirective: hybridOutputDirective,
        groundingConfidence: hybridGroundingConfidence,
        groundingSummary: hybridGroundingSummary,
        evidenceCompacted: hybridEvidenceCompacted,
      }
    } catch (error) {
      const hybridElapsedMs = Date.now() - hybridStarted
      logger?.({
        stage: "evidence.hybrid.fallback",
        fields: {
          elapsedMs: hybridElapsedMs,
          reason: formatError(error),
        },
      })
      const evidenceSections = buildEvidenceSections({
        context,
        identifiers,
        anchorLines,
        graphSelection,
        graphResult,
        groundingSummary: graphGroundingSummary,
        retrievalMode: "graph-only",
      })
      const evidenceSummary = limitText(buildEvidenceSummary(evidenceSections), COMMENT_EVIDENCE_SUMMARY_LIMIT)
      return {
        ok: true,
        retrievalMode: "graph-only",
        evidenceSections,
        evidenceSummary,
        evidenceItemCount: graphSelection.directRefs.length,
        evidenceSummaryBytes: byteLength(evidenceSummary),
        graphElapsedMs,
        hybridElapsedMs,
        fallbackReason: `hybrid-failed:${formatError(error)}`,
        graphSummaryFunctionCount: graphCounts.graphSummaryFunctionCount,
        graphSummaryModuleCount: graphCounts.graphSummaryModuleCount,
        graphSummaryStateMachineCount: graphCounts.graphSummaryStateMachineCount,
        graphDirectRefCount: graphCounts.graphDirectRefCount,
        ragRefCount: 0,
        missingEvidenceCount: graphCounts.missingEvidenceCount,
        identifierCount: identifiers.length,
        anchorCount: anchorLines.length,
        outputDirective: graphOutputDirective,
        groundingConfidence: graphCounts.groundingConfidence,
        groundingSummary: graphGroundingSummary,
        evidenceCompacted: graphCounts.evidenceCompacted,
      }
    }
  }
}

function buildGraphEvidenceQuestion(context: CommentGenerationContext, identifiers: string[], anchorLines: string[]) {
  return [
    "Repository graph evidence request for C/C++ comment generation.",
    "comment-intent: selection-review",
    `current-path: ${context.workspacePath}`,
    `selection-lines: ${context.selectionStartLine}-${context.selectionEndLine}`,
    identifiers.length ? `selection-identifiers: ${identifiers.join(" ")}` : "",
    anchorLines.length ? `selection-anchors: ${anchorLines.join(" | ")}` : "",
    "goal: retrieve structural evidence that explains why this selected code exists, including state transitions, ownership, hardware ordering, DMA/cache constraints, error recovery, or same-module call flow.",
  ].filter(Boolean).join("\n")
}

function buildHybridEvidenceQuestion(context: CommentGenerationContext, identifiers: string[], anchorLines: string[]) {
  return [
    "User question:",
    [
      "For this selected C/C++ code, gather grounded repository evidence that explains why the code exists and any non-obvious hardware, protocol, DMA/cache, state-machine, concurrency, or error-recovery behavior.",
      `Current file: ${context.workspacePath}`,
      `Selection lines: ${context.selectionStartLine}-${context.selectionEndLine}`,
      identifiers.length ? `Selection identifiers: ${identifiers.join(", ")}` : "",
      anchorLines.length ? `Anchor lines: ${anchorLines.join(" | ")}` : "",
      `Selected code excerpt:\n${selectionExcerpt(context.selectedCode)}`,
      "Return grounded repository evidence only; do not answer with speculative prose.",
    ].filter(Boolean).join("\n"),
  ].join("\n")
}

function buildEvidenceSections(input: {
  context: CommentGenerationContext
  identifiers: string[]
  anchorLines: string[]
  graphSelection: CommentGraphSelection
  graphResult?: QueryEvidenceResult
  hybridResult?: QueryEvidenceResult
  ragRefs?: EvidenceRef[]
  groundingSummary: string
  retrievalMode: "graph-only" | "hybrid"
}): CommentEvidenceSections {
  const graphFunctionRows = formatFunctionRows(input.graphSelection.functions)
  const graphModuleRows = formatModuleRows(input.graphSelection.modules)
  const graphStateRows = formatStateMachineRows(input.graphSelection.stateMachines)
  const graphRefRows = formatEvidenceRefs(input.graphSelection.directRefs)
  const ragRefRows = formatEvidenceRefs((input.ragRefs ?? []).slice(0, COMMENT_EVIDENCE_REF_LIMIT))
  const graphInterpretation = groundedInterpretationRows("CodeGraph", input.graphResult)
  const hybridInterpretation = groundedInterpretationRows("Hybrid", input.hybridResult)

  return {
    selectionAnchors: [
      `当前文件: ${input.context.workspacePath}`,
      `选区行: ${input.context.selectionStartLine}-${input.context.selectionEndLine}`,
      input.identifiers.length ? `选区标识符: ${input.identifiers.join(", ")}` : "",
      input.anchorLines.length ? `锚点行:\n${input.anchorLines.map((line) => `- ${line}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    graphRepoSummary: [
      graphInterpretation,
      graphFunctionRows.length ? `函数摘要:\n${graphFunctionRows.join("\n")}` : "",
      graphModuleRows.length ? `模块摘要:\n${graphModuleRows.join("\n")}` : "",
      graphStateRows.length ? `状态机摘要:\n${graphStateRows.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    graphDirectRefs: graphRefRows.length ? graphRefRows.join("\n") : "未打包 CodeGraph 直接引用。",
    ragSummary: input.retrievalMode === "hybrid"
      ? [
        hybridInterpretation,
        ragRefRows.length ? `Hybrid 证据引用:\n${ragRefRows.join("\n")}` : "未打包独立的 hybrid 证据引用。",
      ].filter(Boolean).join("\n\n")
      : "",
    toolEvidence: "",
    groundingSummary: input.groundingSummary,
  }
}

function buildEvidenceSummary(sections: CommentEvidenceSections) {
  return [
    "选区锚点证据:",
    sections.selectionAnchors,
    "",
    "CodeGraph 仓库摘要:",
    sections.graphRepoSummary,
    "",
    "CodeGraph 直接引用:",
    sections.graphDirectRefs,
    sections.ragSummary ? `\nRAG 语义摘要:\n${sections.ragSummary}` : "",
    sections.groundingSummary ? `\n证据结论摘要:\n${sections.groundingSummary}` : "",
  ].filter(Boolean).join("\n")
}

function formatFunctionRows(functions: Array<QueryEvidenceResult["summaries"]["functions"][number]>) {
  return functions
    .map((item) => `- ${item.name} (${item.path}): ${oneLine(item.summary, 160)}`)
}

function formatModuleRows(modules: Array<QueryEvidenceResult["summaries"]["modules"][number]>) {
  return modules
    .map((item) => `- ${item.module}: ${oneLine(item.summary, 160)}`)
}

function formatStateMachineRows(stateMachines: Array<QueryEvidenceResult["stateMachines"][number]>) {
  return stateMachines
    .map((item) => `- ${item.name}: ${item.transitions.length} 个迁移，置信度 ${item.confidence.toFixed(2)}`)
}

function formatEvidenceRefs(refs: EvidenceRef[]) {
  return refs.map((item) => {
    const range = `${item.file}:${item.startLine}-${item.endLine}`
    const snippet = oneLine(item.snippet ?? "", 120)
    return snippet ? `- ${range} -> ${snippet}` : `- ${range}`
  })
}

function missingEvidenceRows(...results: Array<QueryEvidenceResult | undefined>) {
  const rows = uniqueStrings(results.flatMap((result) => result?.evidencePack.missingEvidence ?? []))
    .slice(0, 4)
    .map((item) => `- ${oneLine(item, 160)}`)
  return rows.length ? `已知证据缺口:\n${rows.join("\n")}` : ""
}

function selectionAnchorLines(selectedCode: string) {
  return selectedCode
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, COMMENT_EVIDENCE_SELECTION_LINE_LIMIT)
    .map((line) => oneLine(line, 120))
}

function selectionExcerpt(selectedCode: string) {
  return selectedCode
    .split(/\r?\n/g)
    .slice(0, COMMENT_EVIDENCE_SELECTION_LINE_LIMIT)
    .map((line) => oneLine(line, 160))
    .join("\n")
}

type CommentGraphSelection = {
  functions: QueryEvidenceResult["summaries"]["functions"]
  modules: QueryEvidenceResult["summaries"]["modules"]
  stateMachines: QueryEvidenceResult["stateMachines"]
  directRefs: EvidenceRef[]
}

function selectRelevantGraphSelection(
  result: QueryEvidenceResult | undefined,
  context: CommentGenerationContext,
  identifiers: string[],
): CommentGraphSelection {
  const directRefs = uniqueEvidenceRefs(result).slice(0, COMMENT_EVIDENCE_REF_LIMIT)
  const directRefPaths = new Set(directRefs.map((item) => normalizePath(item.file)))
  const identifierSet = new Set(identifiers.map((item) => item.toLowerCase()))
  const currentPath = normalizePath(context.workspacePath)
  const currentModule = moduleFromWorkspacePath(currentPath)

  const functions = rankRows(
    result?.summaries.functions ?? [],
    (item) => {
      const haystack = `${item.name} ${item.path} ${item.module} ${item.summary} ${item.calls.join(" ")} ${item.stateMachines.join(" ")}`.toLowerCase()
      let score = 0
      if (normalizePath(item.path) === currentPath) score += 120
      if (directRefPaths.has(normalizePath(item.path))) score += 90
      if (item.module === currentModule) score += 40
      score += identifierHits(haystack, identifierSet) * 25
      if (item.stateMachines.length) score += 8
      return score
    },
    COMMENT_EVIDENCE_FUNCTION_LIMIT,
  )

  const relatedModules = new Set<string>([
    currentModule,
    ...functions.map((item) => item.module),
    ...Array.from(directRefPaths).map((item) => moduleFromWorkspacePath(item)),
  ])
  const modules = rankRows(
    result?.summaries.modules ?? [],
    (item) => {
      const haystack = `${item.module} ${item.summary} ${item.keyFlows.join(" ")} ${item.entrypoints.join(" ")} ${item.dependencies.join(" ")}`.toLowerCase()
      let score = 0
      if (relatedModules.has(item.module)) score += item.module === currentModule ? 120 : 80
      score += identifierHits(haystack, identifierSet) * 18
      return score
    },
    COMMENT_EVIDENCE_MODULE_LIMIT,
  )

  const stateMachines = rankRows(
    result?.stateMachines ?? [],
    (item) => {
      let score = 0
      if (item.module === currentModule) score += 70
      if (item.evidence.some((ref) => directRefPaths.has(normalizePath(ref.file)))) score += 90
      if (item.evidence.some((ref) => normalizePath(ref.file) === currentPath)) score += 120
      score += identifierHits(`${item.name} ${item.stateVar} ${item.rootSymbols.join(" ")}`.toLowerCase(), identifierSet) * 25
      return score
    },
    COMMENT_EVIDENCE_STATE_MACHINE_LIMIT,
  )

  return { functions, modules, stateMachines, directRefs }
}

function rankRows<T>(items: T[], score: (item: T) => number, limit: number) {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item)
}

function extractSelectionIdentifiers(selectedCode: string) {
  const matches = selectedCode.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  return uniqueStrings(matches.filter((item) => !C_FAMILY_KEYWORDS.has(item)))
    .slice(0, COMMENT_EVIDENCE_IDENTIFIER_LIMIT)
}

function uniqueEvidenceRefs(...results: Array<QueryEvidenceResult | undefined>) {
  const seen = new Set<string>()
  const refs: EvidenceRef[] = []
  for (const result of results) {
    for (const item of result?.evidencePack.evidence ?? []) {
      const key = `${item.file}:${item.startLine}:${item.endLine}:${item.snippetHash}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(item)
    }
  }
  return refs
}

function subtractEvidenceRefs(refs: EvidenceRef[], baseline: EvidenceRef[]) {
  const baselineKeys = new Set(baseline.map(evidenceRefKey))
  return refs.filter((item) => !baselineKeys.has(evidenceRefKey(item))).slice(0, COMMENT_EVIDENCE_REF_LIMIT)
}

function evidenceRefKey(ref: EvidenceRef) {
  return `${normalizePath(ref.file)}:${ref.startLine}:${ref.endLine}:${ref.snippetHash}`
}

function uniqueStrings(input: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function oneLine(input: string, maxLength: number) {
  const normalized = input.replace(/\s+/g, " ").trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

function limitText(input: string, maxLength: number) {
  return input.length <= maxLength ? input : `${input.slice(0, Math.max(0, maxLength - 9))}\n[证据已截断]`
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}

function codeGraphNotReadyMessage(status: CodeGraphStatus) {
  if (status.state === "error") {
    return `本地 CodeGraph 未就绪: ${status.detail || "索引失败"}。请重建 CodeGraph 后重试。`
  }
  if (status.state === "disabled") {
    return "AI 注释需要本地 CodeGraph 证据。请启用 chipmate.codeGraph.enabled，并等待索引完成。"
  }
  return `AI 注释需要本地 CodeGraph 证据。CodeGraph 当前状态为 ${status.state}${status.detail ? `: ${status.detail}` : ""}。`
}

function isCommentRagReady(rag: RagStatus | undefined) {
  if (!rag) return false
  const pending = rag.pendingChunkCount ?? Math.max(0, rag.chunks - rag.embeddedChunks)
  return Boolean(
    rag.enabled &&
      rag.embeddingEnabled &&
      rag.availability === "ready" &&
      rag.indexAvailability === "ready" &&
      rag.chunks > 0 &&
      rag.embeddedChunks >= rag.chunks &&
      pending === 0,
  )
}

function formatError(error: unknown) {
  return error instanceof Error ? oneLine(error.message, 180) : oneLine(String(error), 180)
}

function identifierHits(haystack: string, identifiers: Set<string>) {
  let hits = 0
  for (const identifier of identifiers) {
    if (haystack.includes(identifier)) hits += 1
  }
  return hits
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/")
}

function moduleFromWorkspacePath(input: string) {
  const normalized = normalizePath(input)
  const lastSlash = normalized.lastIndexOf("/")
  return lastSlash === -1 ? normalized : normalized.slice(0, lastSlash)
}

function groundedInterpretationRows(label: string, result: QueryEvidenceResult | undefined) {
  const rows = [
    result?.suggestedAnswer ? `${label} 证据解释: ${oneLine(result.suggestedAnswer, 320)}` : "",
  ].filter(Boolean)
  return rows.join("\n")
}

function decideOutputDirective(
  _retrievalMode: "graph-only" | "hybrid",
  graphDirectRefCount: number,
  groundingConfidence: CommentGroundingConfidence,
): CommentOutputDirective {
  if (graphDirectRefCount <= 0) return "allow-empty"
  if (groundingConfidence === "high" || groundingConfidence === "medium") return "encourage-1-3"
  return "allow-empty"
}

function isEvidenceCompacted(
  result: QueryEvidenceResult | undefined,
  graphSelection: CommentGraphSelection,
  ragRefs: EvidenceRef[] = [],
) {
  if (!result) return false
  if (result.evidencePack.truncated || result.evidencePack.omittedEvidence > 0) return true
  if ((result.summaries.functions.length ?? 0) > graphSelection.functions.length) return true
  if ((result.summaries.modules.length ?? 0) > graphSelection.modules.length) return true
  if ((result.stateMachines.length ?? 0) > graphSelection.stateMachines.length) return true
  if (uniqueEvidenceRefs(result).length > graphSelection.directRefs.length + ragRefs.length) return true
  return false
}

function groundingSummaryForComments(input: {
  retrievalMode: "graph-only" | "hybrid"
  confidence: CommentGroundingConfidence
  graphResult?: QueryEvidenceResult
  hybridResult?: QueryEvidenceResult
  evidenceCompacted: boolean
}) {
  const prefix = input.retrievalMode === "hybrid"
    ? `Hybrid 证据置信度: ${input.confidence}。`
    : `CodeGraph 证据置信度: ${input.confidence}。`
  const support = input.confidence === "high"
    ? "仓库证据强烈支持至少一条非显然注释。"
    : input.confidence === "medium"
      ? "仓库证据在锚定直接引用时支持少量有根据的非显然注释。"
      : input.confidence === "low"
        ? "仓库证据较弱；只有当 provided refs 明确给出非显然解释时才生成注释。"
        : "仓库证据不足，无法安全生成注释。"
  const compacted = input.evidenceCompacted
    ? "证据区已为注释生成做过压缩；请把当前 summaries 和 refs 视为有根据的子集。"
    : ""
  const missing = missingEvidenceRows(input.graphResult, input.hybridResult)
  return [prefix, support, compacted, missing].filter(Boolean).join("\n")
}
