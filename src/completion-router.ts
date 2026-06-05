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
      reason: "ordinary-code" | "instruction-task" | "symbol-assist"
      promptKind: CompletionPromptKind
      modelProfile: CompletionProfile
      textProfile: CompletionProfile
      maxTokens: number
      temperature: number
      topP?: number
    }

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
  if (input.textProfile === "qwen-coder-fim") return false
  if (input.reason === "misaligned-leading-newline") return true
  return input.reason === "low-confidence-output" && input.plan.useInstruction
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
  const deterministicSymbol = deterministicSymbolText(plan, input.retrievedSnippets ?? [])
  if (deterministicSymbol) {
    return {
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: deterministicSymbol,
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
    case "ordinary-code":
      return {
        kind: "model",
        reason: "ordinary-code",
        promptKind: "qwen-fim",
        modelProfile: "qwen-coder-fim",
        textProfile: "qwen-coder-fim",
        maxTokens: clampTokens(input.settings.completion.maxTokens || 192, 128, 256),
        temperature: Math.min(input.settings.completion.temperature, 0.2),
        topP: input.settings.completion.topP,
      }
    case "disabled":
      return instructionRoute(input, 0)
  }
}

export function routeLogValue(route: CompletionModelRoute) {
  if (route.kind === "none") {
    return `route=none reason=${route.reason} maxTokens=0`
  }
  if (route.kind === "deterministic-symbol") {
    return `route=deterministic-symbol reason=${route.reason} maxTokens=0`
  }
  return [
    `route=${route.promptKind}`,
    `reason=${route.reason}`,
    `modelProfile=${route.modelProfile}`,
    `maxTokens=${route.maxTokens}`,
    `temperature=${route.temperature}`,
  ].join(" ")
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
  if (plan.kind !== "symbol-completion" && plan.kind !== "comment-symbol-reference") return ""
  const target = plan.targetSymbol?.toLowerCase()
  if (!target) return ""

  const selected = snippets.find((snippet) => {
    const name = snippet.name?.toLowerCase()
    if (!name || name.length <= target.length) return false
    if (!name.startsWith(target)) return false
    return (snippet.score ?? 0) >= 1000
  })

  return selected?.name ?? ""
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
