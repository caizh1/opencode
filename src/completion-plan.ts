import type { CompletionCIntent, CompletionPlan } from "./completion-types"
import {
  cIntentNeedsSymbolRetrieval,
  classifyCCompletionIntent,
  isCCompletionLanguage,
  looksLikeCaseBodyContext,
} from "./completion-c-intent"
import { planCEmbeddedCompletion } from "./completion-c-embedded-intent"

export type CompletionPlanInput = {
  languageId: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
  previousNonEmptyLine?: string
  nextNonEmptyLine?: string
  lines?: string[]
  line?: number
  triggerKind?: "automatic" | "manual" | "invoke" | string
}

export function planCompletion(input: CompletionPlanInput): CompletionPlan {
  const trimmed = input.linePrefix.trim()
  const currentWord = input.currentWord ?? ""
  const previousContinuation = previousCommentContinuationPlan(input, trimmed, currentWord)
  if (previousContinuation) return previousContinuation

  const commentSymbolPlan = commentSymbolReferencePlan(input, trimmed, currentWord)
  if (commentSymbolPlan) return commentSymbolPlan

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
      sourceComment: trimmed,
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
      sourceComment: trimmed,
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: true,
      maxTokens: 384,
      confidenceFloor: 0.5,
    }
  }

  if (isInsideUnsafeInlineContext(input)) {
    return disabledPlan()
  }

  const cEmbeddedPlan = planCEmbeddedCompletion(input)
  if (cEmbeddedPlan) return cEmbeddedPlan

  if (!trimmed && !input.lineSuffix.trim()) {
    const blankLinePlan = cBlankLinePlan(input)
    if (blankLinePlan) return blankLinePlan
    return disabledPlan()
  }

  if (isLowSignalInput(trimmed, currentWord) && !allowsLowSignalRequest(input, trimmed, currentWord)) {
    return disabledPlan()
  }

  const cIntent = classifyCCompletionIntent(input)

  if (isCompactCIdentifierOnly(input, trimmed, currentWord)) {
    return ordinaryCodePlan({
      cIntent: cIntent ?? "symbol-prefix",
      needsSymbolRetrieval: true,
    })
  }

  if (cIntent && cIntent !== "symbol-prefix") {
    return ordinaryCodePlan({
      cIntent,
      needsSymbolRetrieval: cIntentNeedsSymbolRetrieval(cIntent),
    })
  }

  if (currentWord.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)) {
    return {
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: currentWord,
      ...(cIntent ? { cIntent } : {}),
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
      maxTokens: 48,
      confidenceFloor: 0.75,
    }
  }

  return ordinaryCodePlan({
    cIntent,
    needsSymbolRetrieval: cIntentNeedsSymbolRetrieval(cIntent),
  })
}

function commentSymbolReferencePlan(input: CompletionPlanInput, trimmed: string, currentWord: string): CompletionPlan | undefined {
  if (!isSingleLineCommentPrompt(trimmed, input.languageId)) return
  if (!looksLikeCommentIdentifierPrefix(currentWord)) return

  const symbolFallbackKind = commentSymbolFallbackKind(trimmed)
  return {
    kind: "comment-symbol-reference",
    insertMode: "replace-current-word",
    targetSymbol: currentWord,
    ...(symbolFallbackKind ? { symbolFallbackKind } : {}),
    replaceCurrentWord: true,
    needsSymbolRetrieval: true,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: false,
    maxTokens: 0,
    confidenceFloor: 0.75,
  }
}

function previousCommentContinuationPlan(input: CompletionPlanInput, trimmed: string, currentWord: string): CompletionPlan | undefined {
  const sourceComment = input.previousNonEmptyLine?.trim()
  if (!sourceComment || !isSingleLineCommentPrompt(sourceComment, input.languageId)) return
  if (!looksLikeContinuationLine(trimmed, currentWord)) return

  const targetSymbol = commentTargetSymbol(sourceComment)
  if (!targetSymbol && !looksLikeCodeCommentPrompt(sourceComment)) return

  const testIntent = looksLikeTestIntentComment(sourceComment)
  const emptyContinuationLine = !trimmed && !input.lineSuffix.trim()
  return {
    kind: "previous-comment-continuation",
    insertMode: emptyContinuationLine ? "insert-at-cursor" : "replace-whole-line",
    sourceComment,
    ...(targetSymbol ? { targetSymbol } : {}),
    replaceCurrentWord: !emptyContinuationLine,
    needsSymbolRetrieval: Boolean(targetSymbol),
    needsTestRetrieval: testIntent,
    useFim: false,
    useInstruction: true,
    maxTokens: testIntent ? 768 : 384,
    confidenceFloor: testIntent ? 0.55 : 0.5,
  }
}

function bodyContinuationPlan(input: CompletionPlanInput): CompletionPlan | undefined {
  if (!isCCompletionLanguage(input.languageId)) return
  if (input.line === undefined || !input.lines) return
  if (!looksLikeBodyNeighborCode(input.previousNonEmptyLine) && !looksLikeBodyNeighborCode(input.nextNonEmptyLine)) return
  const state = cCursorState(input.lines, input.line, input.linePrefix.length)
  if (!state || state.inComment || state.inString) return
  if (!state.stack.some((item) => item === "block")) return

  return bodyContinuationPlanResult(input)
}

function cBlankLinePlan(input: CompletionPlanInput): CompletionPlan | undefined {
  if (!isCCompletionLanguage(input.languageId)) return
  if (input.line === undefined || !input.lines) return

  const state = cCursorState(input.lines, input.line, input.linePrefix.length)
  if (!state || state.inComment || state.inString) return

  const top = state.stack.at(-1)
  if (top === "aggregate") {
    return ordinaryCodePlan({
      maxTokens: 128,
      cIntent: "initializer",
      needsSymbolRetrieval: true,
    })
  }

  const bodyContinuation = bodyContinuationPlan(input)
  if (bodyContinuation) return bodyContinuation

  if (state.stack.length === 0 && looksLikeTopLevelDeclarationGap(input.previousNonEmptyLine, input.nextNonEmptyLine)) {
    return {
      kind: "top-level-declaration",
      insertMode: "insert-at-cursor",
      cIntent: "top-level-declaration",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsTestRetrieval: false,
      useFim: true,
      useInstruction: false,
      maxTokens: isManualTrigger(input.triggerKind) ? 192 : 128,
      confidenceFloor: 0.35,
    }
  }

  return undefined
}

function bodyContinuationPlanResult(input: CompletionPlanInput): CompletionPlan {
  const cIntent = classifyCCompletionIntent(input) ?? (looksLikeCaseBodyContext(input) ? "case-body" : "body-statement")
  return {
    kind: "body-continuation",
    insertMode: "insert-at-cursor",
    cIntent,
    replaceCurrentWord: false,
    needsSymbolRetrieval: cIntentNeedsSymbolRetrieval(cIntent),
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: isManualTrigger(input.triggerKind) ? 128 : 96,
    confidenceFloor: 0.35,
  }
}

function ordinaryCodePlan(input: {
  maxTokens?: number
  cIntent?: CompletionCIntent
  needsSymbolRetrieval?: boolean
} = {}): CompletionPlan {
  return {
    kind: "ordinary-code",
    insertMode: "insert-at-cursor",
    ...(input.cIntent ? { cIntent: input.cIntent } : {}),
    replaceCurrentWord: false,
    needsSymbolRetrieval: input.needsSymbolRetrieval ?? false,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens: input.maxTokens ?? 96,
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

const supportsCBodyContinuation = isCCompletionLanguage

function isManualTrigger(triggerKind: CompletionPlanInput["triggerKind"]) {
  return triggerKind === "manual" || triggerKind === "invoke"
}

function looksLikeUnitTestPrompt(trimmed: string) {
  return Boolean(unitTestTargetSymbol(trimmed))
}

function isSingleLineCommentPrompt(trimmed: string, languageId: string) {
  if (supportsSlashComments(languageId) && trimmed.startsWith("//")) return true
  if (supportsSlashComments(languageId) && isClosedSingleLineBlockComment(trimmed)) return true
  if (supportsHashComments(languageId) && trimmed.startsWith("#") && !trimmed.startsWith("#!")) return true
  return false
}

function unitTestTargetSymbol(trimmed: string) {
  const withoutComment = stripSingleLineCommentMarker(trimmed)
  const match =
    /\b(?:unit\s*test|unittest)\b(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,6}?\s+(?:for|of|to\s+test)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?/i.exec(withoutComment) ??
    /\b(?:write|add|create|generate|implement)?\s*tests?\s+(?:for|of)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?/i.exec(withoutComment)
  return match?.[1]
}

function stripSingleLineCommentMarker(trimmed: string) {
  return trimmed
    .replace(/^\/\/\s*/, "")
    .replace(/^#\s*/, "")
    .replace(/^\/\*\s*/, "")
    .replace(/\s*\*\/$/, "")
}

function isClosedSingleLineBlockComment(trimmed: string) {
  return /^\/\*[\s\S]*\*\/$/.test(trimmed) && !trimmed.slice(2, -2).includes("\n")
}

function looksLikeCodeCommentPrompt(trimmed: string) {
  const text = stripSingleLineCommentMarker(trimmed).trim()
  if (text.length < 6) return false
  return /\b(?:add|create|generate|implement|write|fix|return|test|function|method|class)\b/i.test(text)
}

function commentSymbolFallbackKind(trimmed: string) {
  if (looksLikeUnitTestPrompt(trimmed)) return "comment-to-test" as const
  if (looksLikeCodeCommentPrompt(trimmed)) return "comment-to-code" as const
  return undefined
}

function looksLikeCommentIdentifierPrefix(currentWord: string) {
  return currentWord.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)
}

function looksLikeCommentSymbolPrefix(currentWord: string) {
  if (currentWord.length < 3) return false
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)) return false
  return currentWord.includes("_") || /[A-Z]/.test(currentWord) || /\d/.test(currentWord)
}

function looksLikeContinuationLine(trimmed: string, currentWord: string) {
  if (!trimmed) return true
  if (currentWord && trimmed === currentWord) return true
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*){0,2}$/.test(trimmed)
}

function commentTargetSymbol(comment: string) {
  const text = stripSingleLineCommentMarker(comment)
  const identifiers = text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  return identifiers.filter(looksLikeCommentSymbolPrefix).at(-1)
}

function looksLikeTestIntentComment(comment: string) {
  const text = stripSingleLineCommentMarker(comment)
  return /\b(?:unit\s*test|unittest|test|spec|assert|expect)\b/i.test(text)
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

function looksLikeBodyNeighborCode(line: string | undefined) {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^(?:\/\/|\/\*|\*|#\s*(?:include|define|if|ifdef|ifndef|endif|elif|else|pragma)\b)/.test(trimmed)) return false
  return /[A-Za-z0-9_)}\];{]/.test(trimmed)
}

function cCursorState(lines: string[], line: number, character: number) {
  const beforeCursor = [
    ...lines.slice(0, line),
    (lines[line] ?? "").slice(0, character),
  ].join("\n")
  return scanCBlockState(beforeCursor)
}

function isInsideUnsafeInlineContext(input: CompletionPlanInput) {
  if (isInsideStringLiteral(input.linePrefix, input.languageId)) return true
  if (!isCCompletionLanguage(input.languageId)) return false
  if (input.line === undefined || !input.lines) return false
  const state = cCursorState(input.lines, input.line, input.linePrefix.length)
  return Boolean(state?.inComment || state?.inString)
}

function scanCBlockState(input: string) {
  const stack: Array<"block" | "aggregate"> = []
  let inBlockComment = false
  let inLineComment = false
  let quote: "'" | "\"" | undefined
  let escaped = false
  let sanitized = ""

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        sanitized += "\n"
      } else {
        sanitized += " "
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        sanitized += "  "
        index += 1
      } else {
        sanitized += char === "\n" ? "\n" : " "
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      sanitized += char === "\n" ? "\n" : " "
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      sanitized += "  "
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      sanitized += "  "
      index += 1
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      sanitized += " "
      continue
    }

    if (char === "{") {
      stack.push(openBraceContext(sanitized))
    } else if (char === "}") {
      stack.pop()
    }
    sanitized += char
  }

  return {
    stack,
    inComment: inBlockComment || inLineComment,
    inString: Boolean(quote),
  }
}

function openBraceContext(sanitizedBeforeBrace: string): "block" | "aggregate" {
  const tail = sanitizedBeforeBrace
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-180)
  if (/\b(?:struct|union|enum)\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(tail)) return "aggregate"
  if (/\btypedef\s+(?:struct|union|enum)(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.test(tail)) return "aggregate"
  if (/\b(?:struct|union|enum)\s*$/.test(tail)) return "aggregate"
  if (/(?:=|\[|,|\()\s*$/.test(tail) && !/\b(?:if|for|while|switch)\s*\([^{};]*$/.test(tail)) return "aggregate"
  return "block"
}

function allowsLowSignalRequest(input: CompletionPlanInput, trimmed: string, currentWord: string) {
  if (isManualTrigger(input.triggerKind)) return true
  return isCCompletionLanguage(input.languageId) && isShortIdentifierOnly(trimmed, currentWord)
}

function isShortIdentifierOnly(trimmed: string, currentWord: string) {
  if (!currentWord || trimmed !== currentWord) return false
  return currentWord.length <= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)
}

function isCompactCIdentifierOnly(input: CompletionPlanInput, trimmed: string, currentWord: string) {
  if (!isCCompletionLanguage(input.languageId)) return false
  if (!currentWord || trimmed !== currentWord) return false
  if (currentWord.length > 3) return false
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(currentWord)
}

function looksLikeTopLevelDeclarationGap(previousLine: string | undefined, nextLine: string | undefined) {
  return looksLikeTopLevelDeclarationNeighbor(previousLine) || looksLikeTopLevelDeclarationNeighbor(nextLine)
}

function looksLikeTopLevelDeclarationNeighbor(line: string | undefined) {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^(?:\/\/|\/\*|\*)/.test(trimmed)) return false
  if (/^#\s*(?:include|define|if|ifdef|ifndef|endif|elif|else|pragma)\b/.test(trimmed)) return true
  if (/^(?:typedef|struct|union|enum|extern|static|const|volatile|inline)\b/.test(trimmed)) return true
  if (/^[A-Za-z_][A-Za-z0-9_\s*()]*[;{]$/.test(trimmed)) return true
  if (/^[A-Z][A-Z0-9_]*\s*\(/.test(trimmed)) return true
  return false
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
