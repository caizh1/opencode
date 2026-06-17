import { buildQwenFimPrompt } from "./fimTemplates"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import type { QwenAutocompleteCodeSnippet } from "./snippets"
import { countTokens, pruneLinesFromBottom, pruneLinesFromTop } from "./tokenPruning"
import type { QwenAutocompleteConfig, QwenPromptRendererMode, QwenSnippetInjectionBlockedReason } from "./types"

export type QwenPromptPlan = {
  availablePromptTokens: number | null
  estimatedRenderedPromptTokens: number | null
  prompt: string
  promptRendererMode: QwenPromptRendererMode
  renderedPrefix: string
  renderedPrefixChars: number
  renderedPromptChars: number
  renderedSuffix: string
  renderedSuffixChars: number
  snippetInjectionBlockedReason: QwenSnippetInjectionBlockedReason
  snippetsInjectedIntoPrompt: boolean
}

type Gate = {
  allowed: boolean
  availablePromptTokens: number | null
  promptRendererMode: QwenPromptRendererMode
  snippetInjectionBlockedReason: QwenSnippetInjectionBlockedReason
}

type RenderInput = {
  cfg: QwenAutocompleteConfig
  helper: QwenAutocompleteHelperVars
  injectIntoPrompt?: boolean
  snippets: QwenAutocompleteCodeSnippet[]
}

const SEP = "<|system_separator_istruction_repository_level|>"
const FILE = "<|file_sep|>"
const REPO = "<|repo_name|>"

// Continue source mapping:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/templating/index.ts renderPromptWithTokenLimit
// - core/autocomplete/templating/AutocompleteTemplate.ts qwenMultifileFimTemplate
// This wrapper is intentionally qwen-owned. Disabled and blocked states do not
// call the multifile renderer so the old single-file qwen FIM prompt stays
// byte-for-byte identical unless snippet injection is explicitly active.
export function buildQwenPromptPlan(input: RenderInput): QwenPromptPlan {
  const gate = resolveQwenSnippetInjectionGate(input)
  if (!gate.allowed) {
    return single(input, gate)
  }
  return renderQwenMultifileFimPromptWithTokenLimit(input, gate.availablePromptTokens ?? 0)
}

export function resolveQwenSnippetInjectionGate(input: RenderInput): Gate {
  if (!input.cfg.enabled || input.cfg.provider !== "qwen-direct") return blocked("disabled", "disabled", null)
  const inject = input.injectIntoPrompt ?? (input.cfg.recentlyEditedEnabled && input.cfg.recentlyEditedInjectIntoPrompt)
  if (!inject) return blocked("disabled", "disabled", null)
  if (input.snippets.length === 0) return blocked("no-selected-snippets", "single-file-qwen-fim", null)
  if (!isQwenCoder(input.cfg.model)) return blocked("unsupported-model", "blocked", available(input.cfg))
  const tokens = available(input.cfg)
  if (tokens === null) return blocked("unknown-context-length", "blocked", null)
  if (tokens < input.cfg.maxPromptTokens) return blocked("insufficient-context-length", "blocked", tokens)
  return {
    allowed: true,
    availablePromptTokens: tokens,
    promptRendererMode: "qwen-multifile-fim",
    snippetInjectionBlockedReason: "none",
  }
}

export function renderQwenMultifileFimPromptWithTokenLimit(input: RenderInput, limit: number): QwenPromptPlan {
  const initial = build(input.helper.prunedPrefix, suffix(input.helper.prunedSuffix), input)
  if (countTokens(initial.prompt, input.cfg.model) <= limit) {
    return injected(input, initial, limit)
  }
  const prefixTokens = countTokens(input.helper.prunedPrefix, input.cfg.model)
  const suffixTokens = countTokens(suffix(input.helper.prunedSuffix), input.cfg.model)
  const total = prefixTokens + suffixTokens
  if (total > 0) {
    const prune = countTokens(initial.prompt, input.cfg.model) - limit
    const dropPrefix = Math.ceil(prune * (prefixTokens / total))
    const dropSuffix = Math.ceil(prune - dropPrefix)
    const prefixMax = Math.max(0, prefixTokens - dropPrefix)
    const suffixMax = Math.max(0, suffixTokens - dropSuffix)
    const pruned = build(
      pruneLinesFromTop(input.helper.prunedPrefix, prefixMax, input.cfg.model),
      pruneLinesFromBottom(suffix(input.helper.prunedSuffix), suffixMax, input.cfg.model),
      input,
    )
    if (countTokens(pruned.prompt, input.cfg.model) <= limit) {
      return injected(input, pruned, limit)
    }
  }
  // qwen adapter safety fallback: upstream returns the rebuilt prompt even if it
  // is still too large. qwen-direct blocks injection instead so context cannot
  // exceed the explicit qwen contextLength safety budget. This is not generic
  // Continue renderer parity and is documented in the parity ledger.
  return single(input, blocked("insufficient-context-length", "blocked", limit))
}

function build(
  prefix: string,
  suffixText: string,
  input: RenderInput,
): { prefix: string; prompt: string; suffix: string } {
  const paths = unique(
    [...input.snippets.map((snippet) => snippet.filepath), input.helper.filepath],
    input.helper.workspaceUris,
  )
  const files = input.snippets
    .map((snippet, index) => `${FILE}${paths[index]?.uniquePath ?? safeName(snippet.filepath)}\n${snippet.content}`)
    .join("\n")
  const current = paths[paths.length - 1]?.uniquePath ?? safeName(input.helper.filepath)
  const compiled = `${REPO}${repo(input.helper.workspaceUris)}\n${files}\n${FILE}${current}${SEP}${prefix}`
  return { prefix: compiled, prompt: template(compiled, suffixText), suffix: suffixText }
}

function template(prefix: string, suffixText: string): string {
  if (!prefix.includes(SEP)) return buildQwenFimPrompt({ prefix, suffix: suffixText })
  const [before, ...after] = prefix.split(SEP)
  return `${before}\n<|fim_prefix|>${after.join("")}<|fim_suffix|>${suffixText}<|fim_middle|>`
}

function injected(
  input: RenderInput,
  out: { prefix: string; prompt: string; suffix: string },
  tokens: number,
): QwenPromptPlan {
  const estimate = countTokens(out.prompt, input.cfg.model)
  return {
    availablePromptTokens: tokens,
    estimatedRenderedPromptTokens: estimate,
    prompt: out.prompt,
    promptRendererMode: "qwen-multifile-fim",
    renderedPrefix: out.prefix,
    renderedPrefixChars: out.prefix.length,
    renderedPromptChars: out.prompt.length,
    renderedSuffix: out.suffix,
    renderedSuffixChars: out.suffix.length,
    snippetInjectionBlockedReason: "none",
    snippetsInjectedIntoPrompt: true,
  }
}

function single(input: RenderInput, gate: Gate): QwenPromptPlan {
  const prompt = buildQwenFimPrompt({ prefix: input.helper.prunedPrefix, suffix: input.helper.prunedSuffix })
  return {
    availablePromptTokens: gate.availablePromptTokens,
    estimatedRenderedPromptTokens: countTokens(prompt, input.cfg.model),
    prompt,
    promptRendererMode: gate.promptRendererMode,
    renderedPrefix: input.helper.prunedPrefix,
    renderedPrefixChars: input.helper.prunedPrefix.length,
    renderedPromptChars: prompt.length,
    renderedSuffix: input.helper.prunedSuffix,
    renderedSuffixChars: input.helper.prunedSuffix.length,
    snippetInjectionBlockedReason: gate.snippetInjectionBlockedReason,
    snippetsInjectedIntoPrompt: false,
  }
}

function blocked(reason: QwenSnippetInjectionBlockedReason, mode: QwenPromptRendererMode, tokens: number | null): Gate {
  return {
    allowed: false,
    availablePromptTokens: tokens,
    promptRendererMode: mode,
    snippetInjectionBlockedReason: reason,
  }
}

function available(cfg: QwenAutocompleteConfig): number | null {
  if (cfg.contextLength <= 0) return null
  const safety = Math.min(1000, cfg.contextLength * 0.02)
  return cfg.contextLength - cfg.maxTokens - safety
}

function suffix(value: string): string {
  return value === "" ? "\n" : value
}

function isQwenCoder(model: string): boolean {
  const name = model.toLowerCase()
  return name.includes("qwen") && name.includes("coder")
}

function repo(workspaces: string[]): string {
  return safeName(workspaces[0] ?? "myproject") || "myproject"
}

function unique(paths: string[], workspaces: string[]): Array<{ uri: string; uniquePath: string }> {
  const rels = paths.map((item) => relative(item, workspaces))
  const counts = new Map<string, number>()
  const suffixes = rels.map((item) => {
    const parts = item.split("/")
    const out: string[] = []
    for (let i = parts.length - 1; i >= 0; i--) {
      const value = parts.slice(i).join("/")
      out.push(value)
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return out
  })
  return paths.map((uri, index) => ({
    uri,
    uniquePath: suffixes[index]?.find((item) => counts.get(item) === 1) ?? rels[index] ?? safeName(uri),
  }))
}

function relative(target: string, workspaces: string[]): string {
  const file = clean(target)
  const root = workspaces.map(clean).find((dir) => file === dir || file.startsWith(`${dir}/`))
  if (!root) return safeName(target)
  return file.slice(root.length).replace(/^\//, "") || safeName(target)
}

function clean(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname).replace(/\/$/, "")
  } catch {
    return value.replace(/\\/g, "/").replace(/\/$/, "")
  }
}

function safeName(value: string): string {
  const cleaned = clean(value)
  return cleaned.split("/").filter(Boolean).pop() ?? "Untitled.txt"
}
