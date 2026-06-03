import type { CompletionPlan } from "./completion-types"

export type CompletionPlanInput = {
  languageId: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
}

export function planCompletion(input: CompletionPlanInput): CompletionPlan {
  const trimmed = input.linePrefix.trim()
  const currentWord = input.currentWord ?? ""

  if (!trimmed && !input.lineSuffix.trim()) {
    return disabledPlan()
  }

  if (looksLikeUnitTestPrompt(trimmed)) {
    const commentPrompt = isSingleLineCommentPrompt(trimmed, input.languageId)
    return {
      kind: "comment-to-test",
      replaceCurrentWord: !commentPrompt && Boolean(currentWord),
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      maxTokens: 192,
    }
  }

  if (currentWord.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)) {
    return {
      kind: "symbol",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      maxTokens: 48,
    }
  }

  return {
    kind: "ordinary-code",
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    maxTokens: 96,
  }
}

function disabledPlan(): CompletionPlan {
  return {
    kind: "disabled",
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    maxTokens: 0,
  }
}

function looksLikeUnitTestPrompt(trimmed: string) {
  if (!/\bunit\s*test\b|\bunittest\b/i.test(trimmed)) return false
  return /\bfor\b|\bof\b|\bto\s+test\b/i.test(trimmed)
}

function isSingleLineCommentPrompt(trimmed: string, languageId: string) {
  if (supportsSlashComments(languageId) && trimmed.startsWith("//")) return true
  if (supportsHashComments(languageId) && trimmed.startsWith("#") && !trimmed.startsWith("#!")) return true
  return false
}

function supportsSlashComments(languageId: string) {
  return new Set([
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "javascript",
    "javascriptreact",
    "rust",
    "typescript",
    "typescriptreact",
  ]).has(languageId)
}

function supportsHashComments(languageId: string) {
  return new Set(["bash", "python", "shell", "shellscript", "sh", "zsh"]).has(languageId)
}
