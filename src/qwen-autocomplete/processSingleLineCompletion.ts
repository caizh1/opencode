// Ported for qwen-direct rendering parity from Continue commit
// eaa23c5a9de86049dff765f635c18f61d1d043bb:
// - core/autocomplete/util/processSingleLineCompletion.ts
// - extensions/vscode/src/autocomplete/completionProvider.ts
// - core/autocomplete/templating/constructPrefixSuffix.ts
import * as Diff from "diff"

interface SingleLineCompletionResult {
  completionText: string
  range?: {
    start: number
    end: number
  }
}

interface DiffType {
  count?: number
  added?: boolean
  removed?: boolean
  value: string
}

type DiffPartType = "+" | "-" | "="

function diffPatternMatches(diffs: DiffType[], pattern: DiffPartType[]): boolean {
  if (diffs.length !== pattern.length) return false

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]!
    const diffPartType: DiffPartType = !diff.added && !diff.removed ? "=" : diff.added ? "+" : "-"

    if (diffPartType !== pattern[i]) return false
  }

  return true
}

export function processSingleLineCompletion(
  lastLineOfCompletionText: string,
  currentText: string,
  cursorPosition: number,
): SingleLineCompletionResult | undefined {
  const diffs: DiffType[] = Diff.diffWords(currentText, lastLineOfCompletionText)

  if (diffPatternMatches(diffs, ["+"])) {
    return {
      completionText: lastLineOfCompletionText,
    }
  }

  if (diffPatternMatches(diffs, ["+", "="]) || diffPatternMatches(diffs, ["+", "=", "+"])) {
    return {
      completionText: lastLineOfCompletionText,
      range: {
        start: cursorPosition,
        end: currentText.length + cursorPosition,
      },
    }
  }

  if (diffPatternMatches(diffs, ["+", "-"]) || diffPatternMatches(diffs, ["-", "+"])) {
    return {
      completionText: lastLineOfCompletionText,
    }
  }

  if (diffs[0]?.added) {
    return {
      completionText: diffs[0].value,
    }
  }

  return {
    completionText: lastLineOfCompletionText,
  }
}
