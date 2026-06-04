import { planKindOnlyPostprocessPlan, postprocessCompletion } from "./completion-postprocess"
import type { CompletionPlanKind } from "./completion-types"

export type CompletionNormalizeInput = {
  rawText: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  fullCurrentLine?: string
  planKind?: CompletionPlanKind
  preferCurrentWordReplacement?: boolean
}

export function normalizeCompletionText(input: CompletionNormalizeInput) {
  return postprocessCompletion({
    rawText: input.rawText,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix,
    currentWord: input.currentWord,
    fullCurrentLine: input.fullCurrentLine,
    languageId: "",
    plan: planKindOnlyPostprocessPlan({
      planKind: input.planKind,
      replaceCurrentWord: input.preferCurrentWordReplacement,
    }),
    indent: {
      currentIndent: lineIndent(input.linePrefix),
      targetIndent: "",
      indentUnit: "    ",
    },
  }).text
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}
