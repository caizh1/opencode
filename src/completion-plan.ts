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

  if (isInsideStringLiteral(input.linePrefix, input.languageId)) {
    return disabledPlan()
  }

  if (isLowSignalInput(trimmed, currentWord)) {
    return disabledPlan()
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

function isInsideStringLiteral(linePrefix: string, languageId: string) {
  if (!supportsStringContextSkip(languageId)) return false

  let quote: "'" | "\"" | "`" | undefined
  let escaped = false
  for (let index = 0; index < linePrefix.length; index += 1) {
    const char = linePrefix[index]
    const next = linePrefix[index + 1]

    if (!quote && char === "/" && next === "/" && supportsSlashComments(languageId)) break
    if (!quote && char === "#") break

    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = Boolean(quote)
      continue
    }

    if (quote) {
      if (char === quote) quote = undefined
      continue
    }

    if (char === "\"" || char === "'" || (char === "`" && supportsBacktickStrings(languageId))) {
      quote = char
    }
  }

  return Boolean(quote)
}

function isLowSignalInput(trimmed: string, currentWord: string) {
  if (!trimmed) return false
  if (/^[;,.()[\]{}]+$/.test(trimmed)) return true
  if (currentWord && trimmed === currentWord && currentWord.length < 3 && !isControlFlowStem(currentWord)) return true
  return false
}

function isControlFlowStem(input: string) {
  return input === "if"
}

function supportsStringContextSkip(languageId: string) {
  return new Set([
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "javascript",
    "javascriptreact",
    "python",
    "rust",
    "typescript",
    "typescriptreact",
  ]).has(languageId)
}

function supportsBacktickStrings(languageId: string) {
  return new Set(["javascript", "javascriptreact", "typescript", "typescriptreact"]).has(languageId)
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
