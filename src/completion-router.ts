import type { CompletionProfile, RemoteSettings } from "./types"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"

export type CompletionPromptKind = "qwen-fim" | "instruction"

export type CompletionModelRoute =
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

export function routeCompletionModel(input: RouteCompletionModelInput): CompletionModelRoute {
  const deterministicSymbol = deterministicSymbolText(input.plan, input.retrievedSnippets ?? [])
  if (deterministicSymbol) {
    return {
      kind: "deterministic-symbol",
      reason: "high-confidence-symbol",
      text: deterministicSymbol,
      maxTokens: 0,
      textProfile: "generic-chat",
    }
  }

  switch (input.plan.kind) {
    case "comment-to-test":
    case "natural-command":
      return instructionRoute(input, input.plan.maxTokens || 768)
    case "comment-to-code":
      return instructionRoute(input, input.plan.maxTokens || 384)
    case "symbol-completion":
      return {
        kind: "model",
        reason: "symbol-assist",
        promptKind: "qwen-fim",
        modelProfile: "qwen-coder-fim",
        textProfile: "qwen-coder-fim",
        maxTokens: clampTokens(input.plan.maxTokens || 96, 64, 128),
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
  if (plan.kind !== "symbol-completion") return ""
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

function clampTokens(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}
