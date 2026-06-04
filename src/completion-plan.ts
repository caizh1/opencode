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
    const targetSymbol = unitTestTargetSymbol(trimmed)
    if (!commentPrompt) {
      return {
        kind: "natural-command",
        insertMode: "replace-whole-line",
        ...(targetSymbol ? { targetSymbol } : {}),
        replaceCurrentWord: false,
        needsSymbolRetrieval: true,
        needsTestRetrieval: true,
        useFim: false,
        useInstruction: true,
        maxTokens: 768,
        confidenceFloor: 0.55,
      }
    }

    return {
      kind: "comment-to-test",
      insertMode: "insert-after-line",
      ...(targetSymbol ? { targetSymbol } : {}),
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useFim: false,
      useInstruction: true,
      maxTokens: 768,
      confidenceFloor: 0.55,
    }
  }

  if (isSingleLineCommentPrompt(trimmed, input.languageId) && looksLikeCodeCommentPrompt(trimmed)) {
    return {
      kind: "comment-to-code",
      insertMode: "insert-after-line",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: true,
      maxTokens: 384,
      confidenceFloor: 0.5,
    }
  }

  if (currentWord.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)) {
    return {
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: currentWord,
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
      maxTokens: 48,
      confidenceFloor: 0.75,
    }
  }

  return {
    kind: "ordinary-code",
    insertMode: "insert-at-cursor",
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: 96,
    confidenceFloor: 0.35,
  }
}

function disabledPlan(): CompletionPlan {
  return {
    kind: "disabled",
    insertMode: "insert-at-cursor",
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: false,
    maxTokens: 0,
    confidenceFloor: 1,
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

function unitTestTargetSymbol(trimmed: string) {
  const withoutComment = stripSingleLineCommentMarker(trimmed)
  const match = /\b(?:unit\s*test|unittest)\b\s+(?:for|of|to\s+test)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?/i.exec(withoutComment)
  return match?.[1]
}

function stripSingleLineCommentMarker(trimmed: string) {
  return trimmed.replace(/^\/\/\s*/, "").replace(/^#\s*/, "")
}

function looksLikeCodeCommentPrompt(trimmed: string) {
  const text = stripSingleLineCommentMarker(trimmed).trim()
  if (text.length < 6) return false
  return /\b(?:add|create|generate|implement|write|fix|return|test|function|method|class)\b/i.test(text)
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
