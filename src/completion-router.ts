import type { CompletionProfile, RemoteSettings } from "./types"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"

export type CompletionPromptKind = "qwen-fim" | "instruction"

export type CompletionModelRoute =
  | {
      kind: "none"
      reason: "no-symbol-candidate"
      maxTokens: 0
      textProfile: CompletionProfile
    }
  | {
      kind: "deterministic-symbol"
      reason: "high-confidence-symbol"
      text: string
      maxTokens: 0
      textProfile: CompletionProfile
    }
  | {
      kind: "model"
      reason: "ordinary-code" | "instruction-task" | "symbol-assist" | "comment-guided-c-code"
      promptKind: CompletionPromptKind
      modelProfile: CompletionProfile
      textProfile: CompletionProfile
      maxTokens: number
      temperature: number
      topP?: number
      deterministicSymbolSuppressed?: boolean
      deterministicSymbolSuppressReason?: CEmbeddedSymbolPrefixSuppressReason
      symbolPrefixCandidateTopK?: string[]
      symbolPrefixRoute?: "fim"
    }

export type CEmbeddedSymbolPrefixSuppressReason =
  | "short-prefix"
  | "ambiguous-prefix"

export type RouteCompletionModelInput = {
  plan: CompletionPlan
  settings: RemoteSettings
  retrievedSnippets?: RetrievedCompletionSnippet[]
}

export function shouldRetryCompletionRejection(input: {
  reason: string
  plan: CompletionPlan
  textProfile: CompletionProfile
}) {
  if (isRecoverableQualityRejection(input.reason)) return true
  if (isCommentCodeInstructionPlan(input.plan) && input.reason === "low-intent-output") return true
  if (isCommentCodeInstructionPlan(input.plan) && input.reason === "suffix-duplicated-output") return true
  if (input.textProfile === "qwen-coder-fim") return false
  if (input.reason === "misaligned-leading-newline") return true
  return input.reason === "low-confidence-output" && input.plan.useInstruction
}

function isRecoverableQualityRejection(reason: string) {
  return reason === "quality:placeholder" ||
    reason === "quality:C parse/compile" ||
    reason === "quality:markdown/explanation"
}

function isCommentCodeInstructionPlan(plan: CompletionPlan) {
  return plan.kind === "comment-to-code" ||
    (plan.kind === "previous-comment-continuation" && Boolean(plan.sourceComment) && !plan.needsTestRetrieval)
}

export function resolveCompletionPlanAfterSymbolRetrieval(plan: CompletionPlan, retrievedSnippets: RetrievedCompletionSnippet[]): CompletionPlan {
  if (plan.kind !== "comment-symbol-reference") return plan

  const exactSymbol = exactSymbolText(plan, retrievedSnippets)
  if (exactSymbol) return commentSymbolInstructionPlan(plan, exactSymbol)

  const longerSymbol = deterministicSymbolText(plan, retrievedSnippets)
  if (longerSymbol) return plan

  if (plan.symbolFallbackKind) return commentSymbolInstructionPlan(plan, plan.targetSymbol)

  return plan
}

function commentSymbolInstructionPlan(plan: CompletionPlan, targetSymbol: string | undefined): CompletionPlan {
  const kind = plan.symbolFallbackKind ?? "comment-to-code"
  const testIntent = kind === "comment-to-test"
  return {
    kind,
    insertMode: "insert-after-line",
    ...(targetSymbol ? { targetSymbol } : {}),
    replaceCurrentWord: false,
    needsSymbolRetrieval: Boolean(targetSymbol) || testIntent,
    needsTestRetrieval: testIntent,
    useFim: false,
    useInstruction: true,
    maxTokens: testIntent ? 768 : 384,
    confidenceFloor: testIntent ? 0.55 : 0.5,
  }
}

export function routeCompletionModel(input: RouteCompletionModelInput): CompletionModelRoute {
  const plan = resolveCompletionPlanAfterSymbolRetrieval(input.plan, input.retrievedSnippets ?? [])
  const deterministicSymbol = deterministicSymbolDecision(plan, input.retrievedSnippets ?? [])
  if (deterministicSymbol.text) {
    return {
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: deterministicSymbol.text,
      maxTokens: 0,
      textProfile: "generic-chat",
    }
  }

  switch (plan.kind) {
    case "comment-to-test":
    case "natural-command":
      return instructionRoute({ ...input, plan }, plan.maxTokens || 768)
    case "previous-comment-continuation":
    case "comment-to-code":
      return instructionRoute({ ...input, plan }, plan.maxTokens || 384)
    case "comment-symbol-reference":
      return {
        kind: "none",
        reason: "no-symbol-candidate",
        maxTokens: 0,
        textProfile: "generic-chat",
      }
    case "symbol-completion":
      return {
        kind: "model",
        reason: "symbol-assist",
        promptKind: "qwen-fim",
        modelProfile: "qwen-coder-fim",
        textProfile: "qwen-coder-fim",
        maxTokens: clampTokens(plan.maxTokens || 96, 64, 128),
        temperature: 0,
        topP: input.settings.completion.topP,
      }
    case "comment-guided-c-code":
      return {
        kind: "model",
        reason: "comment-guided-c-code",
        promptKind: "qwen-fim",
        modelProfile: input.settings.completion.profile,
        textProfile: input.settings.completion.profile,
        maxTokens: clampTokens(plan.maxTokens || 128, 96, 192),
        temperature: Math.min(input.settings.completion.temperature, 0.2),
        topP: input.settings.completion.topP,
      }
    case "ordinary-code":
    case "c-embedded-code":
    case "body-continuation":
    case "top-level-declaration":
      return {
        kind: "model",
        reason: "ordinary-code",
        promptKind: "qwen-fim",
        modelProfile: "qwen-coder-fim",
        textProfile: "qwen-coder-fim",
        maxTokens: plan.kind === "c-embedded-code"
          ? clampTokens(plan.maxTokens || 128, 96, 256)
          : plan.kind === "body-continuation"
          ? clampTokens(plan.maxTokens || 96, 96, 128)
          : plan.kind === "top-level-declaration"
            ? clampTokens(input.settings.completion.maxTokens || plan.maxTokens || 192, 128, 192)
            : clampTokens(input.settings.completion.maxTokens || 192, 128, 256),
        temperature: Math.min(input.settings.completion.temperature, 0.2),
        topP: input.settings.completion.topP,
        ...(deterministicSymbol.suppressed ? {
          deterministicSymbolSuppressed: true,
          deterministicSymbolSuppressReason: deterministicSymbol.suppressed.reason,
          symbolPrefixCandidateTopK: deterministicSymbol.suppressed.candidateTopK,
          symbolPrefixRoute: "fim" as const,
        } : {}),
      }
    case "disabled":
      return instructionRoute(input, 0)
  }
}

export function routeLogValue(route: CompletionModelRoute, settings?: RemoteSettings) {
  if (route.kind === "none") {
    return `route=none reason=${route.reason} maxTokens=0`
  }
  if (route.kind === "deterministic-symbol") {
    return `route=deterministic-symbol reason=${route.reason} maxTokens=0`
  }
  const rawFimTransport = route.modelProfile === "qwen-coder-fim"
  return [
    `route=${route.promptKind}`,
    `reason=${route.reason}`,
    `modelProfile=${route.modelProfile}`,
    settings ? `configuredProfile=${settings.completion.profile}` : "",
    settings ? `effectiveProfile=${route.modelProfile}` : "",
    settings ? `endpoint=${rawFimTransport ? "/completions" : "/chat/completions"}` : "",
    `promptKind=${route.promptKind}`,
    `maxTokens=${route.maxTokens}`,
    `temperature=${route.temperature}`,
    route.deterministicSymbolSuppressed ? `deterministicSymbolSuppressed=${route.deterministicSymbolSuppressReason}` : "",
  ].filter(Boolean).join(" ")
}

function instructionRoute(input: RouteCompletionModelInput, maxTokens: number): CompletionModelRoute {
  return {
    kind: "model",
    reason: "instruction-task",
    promptKind: "instruction",
    modelProfile: "generic-chat",
    textProfile: "generic-chat",
    maxTokens: clampTokens(maxTokens, 1, 1024),
    temperature: 0,
    topP: input.settings.completion.topP,
  }
}

function deterministicSymbolText(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]) {
  return deterministicSymbolDecision(plan, snippets).text
}

function deterministicSymbolDecision(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]): {
  text: string
  suppressed?: {
    reason: CEmbeddedSymbolPrefixSuppressReason
    candidateTopK: string[]
  }
} {
  if (plan.kind !== "symbol-completion" && plan.kind !== "comment-symbol-reference" && !isCEmbeddedSymbolPrefixPlan(plan)) return { text: "" }
  const target = plan.targetSymbol?.toLowerCase()
  if (!target) return { text: "" }

  const candidates = snippets.filter((snippet) => {
    const name = snippet.name?.toLowerCase()
    if (!name || name.length <= target.length) return false
    if (!name.startsWith(target)) return false
    return (snippet.score ?? 0) >= 1000
  })
  if (isCEmbeddedSymbolPrefixPlan(plan)) {
    const suppressed = cEmbeddedSymbolPrefixSuppression(plan, candidates)
    if (suppressed) return { text: "", suppressed }
  }

  const selected = candidates[0]
  if (!selected?.name) return { text: "" }
  if (isCEmbeddedSymbolPrefixPlan(plan)) {
    return { text: selected.name.slice(plan.targetSymbol?.length ?? 0) }
  }
  return { text: selected.name }
}

function cEmbeddedSymbolPrefixSuppression(
  plan: CompletionPlan,
  candidates: RetrievedCompletionSnippet[],
): { reason: CEmbeddedSymbolPrefixSuppressReason; candidateTopK: string[] } | undefined {
  const target = plan.targetSymbol ?? ""
  const candidateTopK = candidates.map((candidate) => candidate.name ?? "").filter(Boolean).slice(0, 8)
  if (target.length < 3) {
    return { reason: "short-prefix", candidateTopK }
  }
  const topScore = Math.max(...candidates.map((candidate) => snippetScore(candidate)))
  const closeCandidates = candidates.filter((candidate) => snippetScore(candidate) >= topScore - 250)
  if (closeCandidates.length >= 2) {
    return { reason: "ambiguous-prefix", candidateTopK }
  }
  return
}

function snippetScore(snippet: RetrievedCompletionSnippet) {
  const score = snippet.score ?? 0
  return Number.isFinite(score) ? score : 0
}

function isCEmbeddedSymbolPrefixPlan(plan: CompletionPlan) {
  return plan.kind === "c-embedded-code" && plan.cIntent === "symbol-prefix" && Boolean(plan.targetSymbol)
}

function exactSymbolText(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]) {
  const target = plan.targetSymbol?.toLowerCase()
  if (!target) return ""
  return snippets.find((snippet) => snippet.name?.toLowerCase() === target)?.name ?? ""
}

function clampTokens(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}
