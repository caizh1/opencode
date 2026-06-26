import * as vscode from "vscode"
import { CHIPMATE_CONFIG_SECTION } from "../chipmate-constants"
import { DEFAULT_COMPLETION_MODEL } from "../settings"
import { QWEN_AUTOCOMPLETE_CACHE_DEFAULT_MAX_ENTRIES, clampMaxEntries } from "./autocompleteLruCache"
import type {
  QwenAutocompleteConfig,
  QwenAutocompleteLogLevel,
  QwenAutocompleteProfile,
  QwenAutocompleteProvider,
} from "./types"

export const QWEN_CONFIG_SECTION = CHIPMATE_CONFIG_SECTION

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function provider(value: unknown): QwenAutocompleteProvider {
  if (value === "qwen-direct" || value === "fim-direct" || value === "none") return value
  return "none"
}

function profile(value: unknown, providerValue: QwenAutocompleteProvider): QwenAutocompleteProfile {
  if (providerValue === "qwen-direct") return "qwen-coder-fim"
  if (value === "deepseek-fim") return value
  return "qwen-coder-fim"
}

function logLevel(value: unknown): QwenAutocompleteLogLevel {
  if (value === "info" || value === "debug") return value
  return "off"
}

export function readQwenAutocompleteConfig(): QwenAutocompleteConfig {
  const cfg = vscode.workspace.getConfiguration(QWEN_CONFIG_SECTION)
  const providerBaseUrl = str(cfg.get("provider.apiBaseUrl"), "").trim()
  const completionBaseUrl = str(cfg.get("completion.apiBaseUrl"), "").trim()
  const providerValue = provider(cfg.get("completion.provider", "qwen-direct"))
  const profileValue = profile(cfg.get("completion.profile", "qwen-coder-fim"), providerValue)
  return {
    enabled: bool(cfg.get("completion.enabled"), true),
    provider: providerValue,
    profile: profileValue,
    endpoint: completionsUrl(completionBaseUrl || providerBaseUrl, profileValue),
    model: str(cfg.get("completion.model"), DEFAULT_COMPLETION_MODEL).trim() || DEFAULT_COMPLETION_MODEL,
    apiKey: "",
    debounceMs: num(cfg.get("completion.debounceMs"), 350, 0, 5_000),
    maxTokens: num(cfg.get("completion.maxTokens"), 128, 1, 2_048),
    maxPromptTokens: num(cfg.get("completion.maxPromptTokens"), 1024, 1, 200_000),
    modelTimeout: num(cfg.get("completion.modelTimeout"), 150, 1, 600_000),
    maxSuffixPercentage: num(cfg.get("completion.maxSuffixPercentage"), 0.2, 0, 1),
    prefixPercentage: num(cfg.get("completion.prefixPercentage"), 0.3, 0, 1),
    temperature: num(cfg.get("completion.temperature"), 0.1, 0, 2),
    topP: num(cfg.get("completion.topP"), 1, 0, 1),
    cacheEnabled: bool(cfg.get("completion.cache.enabled"), true),
    cacheMaxEntries: clampMaxEntries(cfg.get("completion.cache.maxEntries") ?? QWEN_AUTOCOMPLETE_CACHE_DEFAULT_MAX_ENTRIES),
    prefixChars: num(cfg.get("completion.prefixChars"), 12_000, 0, 200_000),
    suffixChars: num(cfg.get("completion.suffixChars"), 6_000, 0, 200_000),
    multifileContextEnabled: bool(cfg.get("completion.multifileContext.enabled"), false),
    contextLength: num(cfg.get("completion.contextLength"), 200_000, 0, 1_000_000),
    recentlyEditedEnabled: bool(cfg.get("completion.context.recentlyEdited.enabled"), true),
    recentlyEditedInjectIntoPrompt: bool(cfg.get("completion.context.recentlyEdited.injectIntoPrompt"), true),
    recentlyEditedMaxRanges: num(cfg.get("completion.context.recentlyEdited.maxRanges"), 3, 1, 20),
    recentlyEditedMaxRangeLines: num(cfg.get("completion.context.recentlyEdited.maxRangeLines"), 20, 1, 200),
    recentlyOpenedEnabled: bool(cfg.get("completion.context.recentlyOpened.enabled"), true),
    recentlyOpenedInjectIntoPrompt: bool(cfg.get("completion.context.recentlyOpened.injectIntoPrompt"), true),
    recentlyOpenedMaxFiles: num(cfg.get("completion.context.recentlyOpened.maxFiles"), 20, 1, 20),
    recentlyOpenedFileReadTimeoutMs: num(cfg.get("completion.context.recentlyOpened.fileReadTimeoutMs"), 80, 1, 5_000),
    importDefinitionsEnabled: bool(cfg.get("completion.context.importDefinitions.enabled"), true),
    importDefinitionsInjectIntoPrompt: bool(cfg.get("completion.context.importDefinitions.injectIntoPrompt"), true),
    importDefinitionsTimeoutMs: num(cfg.get("completion.context.importDefinitions.timeoutMs"), 100, 1, 5_000),
    importDefinitionsCacheSize: num(cfg.get("completion.context.importDefinitions.cacheSize"), 10, 1, 10),
    rootPathEnabled: bool(cfg.get("completion.context.rootPath.enabled"), true),
    rootPathInjectIntoPrompt: bool(cfg.get("completion.context.rootPath.injectIntoPrompt"), true),
    rootPathTimeoutMs: num(cfg.get("completion.context.rootPath.timeoutMs"), 100, 1, 5_000),
    rootPathCacheSize: num(cfg.get("completion.context.rootPath.cacheSize"), 100, 1, 100),
    trace: bool(cfg.get("completion.trace"), false),
    logLevel: logLevel(cfg.get("completion.logLevel")),
    logPromptPreview: bool(cfg.get("completion.logPromptPreview"), false),
    logCompletionPreview: bool(cfg.get("completion.logCompletionPreview"), true),
  }
}

export function qwenAutocompleteEnabled(cfg: QwenAutocompleteConfig): boolean {
  return cfg.enabled && (cfg.provider === "qwen-direct" || cfg.provider === "fim-direct")
}

export function completionsUrl(baseUrl: string, profileValue: QwenAutocompleteProfile = "qwen-coder-fim"): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (profileValue === "deepseek-fim") return deepseekCompletionsUrl(trimmed)
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/completions")
  if (/\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/completions`
}

function deepseekCompletionsUrl(trimmed: string): string {
  const official = officialDeepSeekUrl(trimmed)
  if (official) return official
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, "/completions")
  if (/\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/completions`
}

function officialDeepSeekUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.hostname !== "api.deepseek.com") return null
    const pathname = url.pathname.replace(/\/+$/, "")
    if (pathname === "" || pathname === "/v1" || pathname === "/beta") {
      url.pathname = "/beta/completions"
      return url.toString().replace(/\/$/, "")
    }
    if (pathname === "/beta/completions") return url.toString().replace(/\/$/, "")
    return null
  } catch {
    return null
  }
}
