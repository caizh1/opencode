import * as vscode from "vscode"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import type { QwenMultilineCompletions } from "./types"

export type QwenMultilineInput = {
  helper: QwenAutocompleteHelperVars
  position: vscode.Position
  selected?: vscode.SelectedCompletionInfo
  multilineCompletions?: QwenMultilineCompletions
}

export type QwenMultilineBlockedReason = "none" | "option-never" | "single-line-comment" | "language-use-multiline"

export type QwenMultilineClassifierResult = {
  allowed: boolean
  mode: QwenMultilineCompletions
  source: "option" | "selected-completion-info" | "single-line-comment" | "language-use-multiline" | "default"
  blockedReason: QwenMultilineBlockedReason
  language: string
  singleLineComment: string | null
  selectedCompletionInfo: boolean
  useMultilineApplied: boolean
}

// Continue parity source: commit eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/classification/shouldCompleteMultiline.ts
// - core/autocomplete/constants/AutocompleteLanguageInfo.ts
// Note: the upstream comment says selected IntelliSense should be single-line,
// but the actual code returns true when selectedCompletionInfo exists.
export function classifyQwenMultiline(input: QwenMultilineInput): QwenMultilineClassifierResult {
  const mode = input.multilineCompletions ?? "auto"
  if (mode === "always") return result(input, mode, true, "option", "none", false)
  if (mode === "never") return result(input, mode, false, "option", "option-never", false)
  if (input.selected) return result(input, mode, true, "selected-completion-info", "none", false)

  const line = input.helper.fullPrefix.split("\n").slice(-1)[0] ?? ""
  const comment = input.helper.lang.singleLineComment
  if (comment && line.trimStart().startsWith(comment)) {
    return result(input, mode, false, "single-line-comment", "single-line-comment", false)
  }

  if (input.helper.lang.useMultiline) {
    const allowed = input.helper.lang.useMultiline({
      prefix: input.helper.prunedPrefix,
      suffix: input.helper.prunedSuffix,
    })
    return result(input, mode, allowed, "language-use-multiline", allowed ? "none" : "language-use-multiline", true)
  }

  return result(input, mode, true, "default", "none", false)
}

export function shouldCompleteMultilineQwen(input: QwenMultilineInput): boolean {
  return classifyQwenMultiline(input).allowed
}

function result(
  input: QwenMultilineInput,
  mode: QwenMultilineCompletions,
  allowed: boolean,
  source: QwenMultilineClassifierResult["source"],
  blockedReason: QwenMultilineBlockedReason,
  useMultilineApplied: boolean,
): QwenMultilineClassifierResult {
  return {
    allowed,
    blockedReason,
    language: input.helper.lang.name,
    mode,
    selectedCompletionInfo: Boolean(input.selected),
    singleLineComment: input.helper.lang.singleLineComment ?? null,
    source,
    useMultilineApplied,
  }
}
