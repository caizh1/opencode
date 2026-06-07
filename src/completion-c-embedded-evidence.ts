import type { QueryEvidenceResult, StateMachine } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence } from "./codegraph-types"
import type { CompletionCIntent, CompletionPlan } from "./completion-types"

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
}

export type CEmbeddedEvidenceTrace = {
  ragFallbackTriggered: boolean
  ragFallbackReason?: string
  graphEvidenceCount: number
  ragEvidenceCount: number
  finalSelectedEvidenceCount: number
  minimumUsefulEvidenceMet: boolean
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
}

const COMPLETION_EVIDENCE_INTENTS = new Set<CompletionCIntent>([
  "member-access",
  "call-args",
  "initializer",
  "error-path",
  "state-machine",
  "mmio-register",
])

export function shouldBuildCEmbeddedCompletionEvidence(plan: CompletionPlan) {
  return plan.kind === "c-embedded-code" && Boolean(plan.cIntent && COMPLETION_EVIDENCE_INTENTS.has(plan.cIntent))
}

export async function buildCEmbeddedCompletionEvidence(input: CEmbeddedCompletionEvidenceInput): Promise<CEmbeddedCompletionEvidenceResult> {
  const intent = input.plan.cIntent
  if (!intent || !COMPLETION_EVIDENCE_INTENTS.has(intent)) return emptyResult()

  const graphResult = await input.codeGraph.queryEvidence(input.question, {
    retrievalMode: "graph-only",
    relatedPaths: input.relatedPaths,
  })
  const graphItems = selectEvidenceItems({
    result: graphResult,
    intent,
    domainHints: input.domainHints ?? [],
    sourceMode: "graph",
  })
  const graphUseful = minimumUsefulEvidence(intent, graphItems)
  let finalItems = graphItems
  let retrievalMode: CEmbeddedCompletionEvidenceResult["retrievalMode"] = graphResult ? "graph-only" : "none"
  let ragFallbackTriggered = false
  let ragFallbackReason: string | undefined
  let ragEvidenceCount = 0

  if (!graphUseful.met) {
    ragFallbackTriggered = true
    ragFallbackReason = graphUseful.reason
    try {
      const hybridResult = await input.codeGraph.queryEvidence(input.question, {
        retrievalMode: "hybrid",
        relatedPaths: input.relatedPaths,
      })
      retrievalMode = "hybrid"
      const hybridItems = selectEvidenceItems({
        result: hybridResult,
        intent,
        domainHints: input.domainHints ?? [],
        sourceMode: "hybrid",
      })
      ragEvidenceCount = hybridItems.filter((item) => item.source === "rag").length
      finalItems = mergeEvidenceItems(graphItems, hybridItems)
    } catch (error) {
      ragFallbackReason = `${ragFallbackReason}; hybrid fallback unavailable: ${formatError(error)}`
    }
  }

  const selected = finalItems
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path) || left.startLine - right.startLine)
    .slice(0, input.maxItems ?? 12)
  const finalUseful = minimumUsefulEvidence(intent, selected)
  const trace: CEmbeddedEvidenceTrace = {
    ragFallbackTriggered,
    ragFallbackReason,
    graphEvidenceCount: graphItems.length,
    ragEvidenceCount,
    finalSelectedEvidenceCount: selected.length,
    minimumUsefulEvidenceMet: finalUseful.met,
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

function selectEvidenceItems(input: {
  result: QueryEvidenceResult | undefined
  intent: CompletionCIntent
  domainHints: string[]
  sourceMode: "graph" | "hybrid"
}) {
  const items: CEmbeddedEvidenceItem[] = []
  for (const evidence of input.result?.retrieval?.evidence ?? []) {
    const kind = evidenceKindForIntent(input.intent, evidence)
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

function evidenceKindForIntent(intent: CompletionCIntent, evidence: CodeGraphEvidence): CEmbeddedEvidenceKind | undefined {
  const reason = evidence.reason.toLowerCase()
  switch (intent) {
    case "member-access":
      if (reason.includes("struct-definition") || reason.includes("struct-field")) return "c-struct-definition"
      if (reason.includes("base-type")) return "c-base-type"
      if (reason.includes("same-field-usage") || reason.includes("same-usage")) return "c-same-usage"
      return undefined
    case "call-args":
      if (reason.includes("callee-signature")) return "c-callee-signature"
      if (reason.includes("return-handling")) return "c-return-handling"
      if (reason.includes("call-example") || reason.includes("call-site")) return "c-call-example"
      return undefined
    case "initializer":
      if (reason.includes("struct-definition")) return "c-struct-definition"
      if (reason.includes("callback-signature")) return "c-callback-signature"
      if (reason.includes("initializer-example")) return "c-initializer-example"
      return undefined
    case "error-path":
      if (reason.includes("cleanup-pattern")) return "c-cleanup-pattern"
      if (reason.includes("return-style")) return "c-return-style"
      if (reason.includes("error-label") || reason.includes("cleanup-label")) return "c-error-labels"
      return undefined
    case "state-machine":
      if (reason.includes("state-") || reason.includes("state-context") || reason.includes("state-machine") || reason.includes("transition")) return "c-state-machine"
      return undefined
    case "mmio-register":
      if (reason.includes("register-access")) return "c-register-access-example"
      if (reason.includes("register-family") || reason.includes("register-macro")) return "c-register-macro"
      return undefined
    default:
      return undefined
  }
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

function minimumUsefulEvidence(intent: CompletionCIntent, items: CEmbeddedEvidenceItem[]) {
  const has = (kind: CEmbeddedEvidenceKind) => items.some((item) => item.kind === kind)
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
      return useful(true, "")
  }
}

function useful(met: boolean, reason: string) {
  return { met, reason: met ? undefined : reason }
}

function formatCEmbeddedEvidenceText(intent: CompletionCIntent, items: CEmbeddedEvidenceItem[], trace: CEmbeddedEvidenceTrace) {
  if (items.length === 0) return ""
  return [
    `<c-embedded-evidence intent="${xmlAttr(intent)}" selected="${items.length}" retrievalFallback="${trace.ragFallbackTriggered ? "hybrid" : "graph-only"}">`,
    `<fallback-trace ragFallbackTriggered="${trace.ragFallbackTriggered ? "true" : "false"}" graphEvidenceCount="${trace.graphEvidenceCount}" ragEvidenceCount="${trace.ragEvidenceCount}" finalSelectedEvidenceCount="${trace.finalSelectedEvidenceCount}" minimumUsefulEvidenceMet="${trace.minimumUsefulEvidenceMet ? "true" : "false"}"${trace.ragFallbackReason ? ` ragFallbackReason="${xmlAttr(trace.ragFallbackReason)}"` : ""} />`,
    ...items.map(formatEvidenceItem),
    "</c-embedded-evidence>",
  ].join("\n")
}

function formatEvidenceItem(item: CEmbeddedEvidenceItem) {
  return [
    `<evidence kind="${xmlAttr(item.kind)}"${item.name ? ` name="${xmlAttr(item.name)}"` : ""} path="${xmlAttr(item.path)}" lines="${item.startLine}-${item.endLine}" reason="${xmlAttr(item.reason)}" score="${Math.round(item.score)}" source="${item.source}" domainBoost="${item.domainBoostApplied ? "true" : "false"}">`,
    xmlText(item.text),
    "</evidence>",
  ].join("\n")
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

function xmlAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
