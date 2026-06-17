import { createRequire } from "node:module"
import { llamaTokenizer } from "../autocomplete/continuedev/core/llm/llamaTokenizer.js"

type Encoding = {
  encode(text: string, allowedSpecial?: "all" | string[], disallowedSpecial?: "all" | string[]): number[]
  decode(tokens: number[]): string
}

const nodeRequire = createRequire(__filename)
const { encodingForModel: tiktoken } = nodeRequire("js-tiktoken") as {
  encodingForModel: (model: string) => Encoding
}

type MessagePart = {
  type?: string
  text?: string
}

type MessageContent = string | MessagePart[]

type Template =
  | "alpaca"
  | "anthropic"
  | "chatml"
  | "codellama-70b"
  | "codestral"
  | "deepseek"
  | "gemma"
  | "granite"
  | "llama2"
  | "llama3"
  | "llava"
  | "neural-chat"
  | "none"
  | "openchat"
  | "phi2"
  | "phind"
  | "xwin-coder"
  | "zephyr"

export type QwenTokenizerSource = "gpt-4" | "llama"

export type QwenTokenPruningOptions = {
  maxPromptTokens: number
  prefixPercentage: number
  maxSuffixPercentage: number
}

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/util/parameters.ts DEFAULT_AUTOCOMPLETE_OPTS
// - core/llm/autodetect.ts autodetectTemplateType
// - core/llm/countTokens.ts countTokens/pruneLinesFromTop/pruneLinesFromBottom
export const QWEN_CONTINUE_TOKEN_PRUNING_DEFAULTS: QwenTokenPruningOptions = {
  maxPromptTokens: 1024,
  prefixPercentage: 0.3,
  maxSuffixPercentage: 0.2,
}

export type QwenApproximateTokenPruningOptions = QwenTokenPruningOptions

export const QWEN_APPROXIMATE_TOKEN_PRUNING_DEFAULTS = QWEN_CONTINUE_TOKEN_PRUNING_DEFAULTS

const TEMPLATE_RULES: Array<{ type: Template; matches: (model: string) => boolean }> = [
  { type: "llama3", matches: (model) => model.includes("llama3") || model.includes("llama-3") },
  { type: "llava", matches: (model) => model.includes("llava") },
  { type: "zephyr", matches: (model) => model.includes("tinyllama") },
  { type: "xwin-coder", matches: (model) => model.includes("xwin") },
  { type: "chatml", matches: (model) => model.includes("dolphin") },
  { type: "gemma", matches: (model) => model.includes("gemma") },
  { type: "phi2", matches: (model) => model.includes("phi2") },
  { type: "phind", matches: (model) => model.includes("phind") },
  { type: "llama2", matches: (model) => model.includes("llama") },
  { type: "zephyr", matches: (model) => model.includes("zephyr") },
  { type: "none", matches: (model) => model.includes("claude") },
  { type: "none", matches: (model) => model.includes("nova") },
  { type: "none", matches: (model) => model.includes("codestral") },
  { type: "alpaca", matches: (model) => model.includes("alpaca") || model.includes("wizard") },
  { type: "llama2", matches: (model) => model.includes("mistral") || model.includes("mixtral") },
  { type: "deepseek", matches: (model) => model.includes("deepseek") },
  { type: "chatml", matches: (model) => model.includes("hermes") },
  { type: "openchat", matches: (model) => model.includes("ninja") || model.includes("openchat") },
  { type: "neural-chat", matches: (model) => model.includes("neural-chat") },
  { type: "granite", matches: (model) => model.includes("granite") },
]

class LlamaEncoding implements Encoding {
  encode(text: string): number[] {
    return llamaTokenizer.encode(text)
  }

  decode(tokens: number[]): string {
    return llamaTokenizer.decode(tokens)
  }
}

let gpt: Encoding | null = null
const llama = new LlamaEncoding()

export function autodetectTemplateType(model: string): Template | undefined {
  const name = model.toLowerCase()
  if (name.includes("codellama") && name.includes("70b")) return "codellama-70b"
  if (providerHandlesTemplate(name)) return undefined
  return TEMPLATE_RULES.find((rule) => rule.matches(name))?.type ?? "chatml"
}

export function tokenizerSourceForModel(model: string): QwenTokenizerSource {
  const type = autodetectTemplateType(model)
  if (!type || type === "none") return "gpt-4"
  return "llama"
}

export function encodingForModel(model: string): Encoding {
  if (tokenizerSourceForModel(model) === "llama") return llama
  return (gpt ??= tiktoken("gpt-4"))
}

export function countTokens(content: MessageContent, model = "llama2"): number {
  const enc = encodingForModel(model)
  const base = Array.isArray(content)
    ? content.reduce((sum, part) => sum + countPart(part, enc), 0)
    : enc.encode(content ?? "", "all", []).length
  return adjusted(base, model)
}

export function pruneLinesFromTop(text: string, max: number, model: string): string {
  const lines = text.split("\n")
  const tokens = lines.map((line) => countTokens(line, model))
  const total = tokens.reduce((sum, token) => sum + token, 0) + Math.max(0, lines.length - 1)
  const start = pruneTopIndex(tokens, total, max)
  return lines.slice(start).join("\n")
}

export function pruneLinesFromBottom(text: string, max: number, model: string): string {
  const lines = text.split("\n")
  const tokens = lines.map((line) => countTokens(line, model))
  const total = tokens.reduce((sum, token) => sum + token, 0) + Math.max(0, lines.length - 1)
  const end = pruneBottomIndex(tokens, total, max)
  return lines.slice(0, end).join("\n")
}

export function prunePrefixSuffixWithTokenBudget(
  prefix: string,
  suffix: string,
  model: string,
  opts: QwenTokenPruningOptions = QWEN_CONTINUE_TOKEN_PRUNING_DEFAULTS,
): {
  estimatedPrefixTokens: number
  estimatedPromptTokens: number
  estimatedSuffixTokens: number
  prunedPrefix: string
  prunedSuffix: string
} {
  const max = opts.maxPromptTokens * opts.prefixPercentage
  const prunedPrefix = pruneLinesFromTop(prefix, max, model)
  const suffixMax = Math.min(
    opts.maxPromptTokens - countTokens(prunedPrefix, model),
    opts.maxSuffixPercentage * opts.maxPromptTokens,
  )
  const prunedSuffix = pruneLinesFromBottom(suffix, suffixMax, model)
  const estimatedPrefixTokens = countTokens(prunedPrefix, model)
  const estimatedSuffixTokens = countTokens(prunedSuffix, model)
  return {
    estimatedPrefixTokens,
    estimatedPromptTokens: estimatedPrefixTokens + estimatedSuffixTokens,
    estimatedSuffixTokens,
    prunedPrefix,
    prunedSuffix,
  }
}

function providerHandlesTemplate(model: string): boolean {
  return (
    model.includes("gpt") ||
    model.includes("command") ||
    model.includes("aya") ||
    model.includes("chat-bison") ||
    model.includes("pplx") ||
    model.includes("gemini") ||
    model.includes("grok") ||
    model.includes("moonshot") ||
    model.includes("kimi") ||
    model.includes("mercury") ||
    model.includes("glm") ||
    /^o\d/.test(model)
  )
}

function countPart(part: MessagePart, enc: Encoding): number {
  if (part.type === "imageUrl") return 1024
  return enc.encode(part.text ?? "", "all", []).length
}

function adjusted(base: number, model: string): number {
  const name = model.toLowerCase()
  const factor = name.includes("claude")
    ? 1.23
    : name.includes("gemini")
      ? 1.18
      : name.includes("stral") || name.includes("mixtral")
        ? 1.26
        : 1
  return Math.ceil(base * factor)
}

function pruneTopIndex(tokens: number[], total: number, max: number): number {
  let sum = total
  let start = 0
  while (sum > max && start < tokens.length) {
    sum -= tokens[start] ?? 0
    if (tokens.length - start > 1) sum--
    start++
  }
  return start
}

function pruneBottomIndex(tokens: number[], total: number, max: number): number {
  let sum = total
  let end = tokens.length
  while (sum > max && end > 0) {
    end--
    sum -= tokens[end] ?? 0
    if (end > 0) sum--
  }
  return end
}
