import type { QwenAutocompleteProfile, QwenFimParts, QwenFimRequestShape } from "./types"

// Continue parity source: commit eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/templating/AutocompleteTemplate.ts
// - core/autocomplete/templating/getStopTokens.ts
const QWEN_TEMPLATE_LOCAL_STOPS = [
  "<|endoftext|>",
  "<|fim_prefix|>",
  "<|fim_middle|>",
  "<|fim_suffix|>",
  "<|fim_pad|>",
  "<|repo_name|>",
  "<|file_sep|>",
  "<|im_start|>",
  "<|im_end|>",
]

// Continue getStopTokens appends these common stops after template-local stops.
const CONTINUE_COMMON_STOPS = ["/src/", "#- coding: utf-8", "```"]

const CONTINUE_QWEN_CODER_EFFECTIVE_STOPS = [...QWEN_TEMPLATE_LOCAL_STOPS, ...CONTINUE_COMMON_STOPS]

export const DEEPSEEK_FIM_STOP = ["```"]

export function getContinueAutocompleteStopTokens(_model: string): string[] {
  return [...CONTINUE_QWEN_CODER_EFFECTIVE_STOPS]
}

export function getFimStopTokens(profile: QwenAutocompleteProfile, model: string): string[] {
  if (profile === "deepseek-fim") return [...DEEPSEEK_FIM_STOP]
  return getContinueAutocompleteStopTokens(model)
}

export function fimRequestShape(profile: QwenAutocompleteProfile): QwenFimRequestShape {
  return profile === "deepseek-fim" ? "prompt-suffix" : "qwen-prompt"
}

export const QWEN_FIM_STOP = getContinueAutocompleteStopTokens("qwen-coder-30b0")

export function buildQwenFimPrompt(parts: QwenFimParts): string {
  return `<|fim_prefix|>${parts.prefix}<|fim_suffix|>${parts.suffix}<|fim_middle|>`
}

export function isQwenCoderModel(model: string): boolean {
  const name = model.toLowerCase()
  return name.includes("qwen") && name.includes("coder")
}
