import { isCCompletionLanguage } from "./completion-c-intent"
import type { CompletionPlan, CompletionRetrievalPolicy, CompletionRetrievalPolicyKind } from "./completion-types"
import type { CompletionPlanInput } from "./completion-plan"

export type CEmbeddedCompletionIntentInput = CompletionPlanInput

type CCursorState = {
  stack: Array<"block" | "aggregate">
  inComment: boolean
  inString: boolean
}

export function planCEmbeddedCompletion(input: CEmbeddedCompletionIntentInput): CompletionPlan | undefined {
  if (!isCCompletionLanguage(input.languageId)) return
  if (isUnsafeCContext(input)) return

  const cIntent = classifyCEmbeddedIntent(input)
  if (!cIntent) return

  const currentWord = input.currentWord ?? ""
  const symbolPrefix = cIntent === "symbol-prefix" && isIdentifier(currentWord)
  const maxTokens = maxTokensForIntent(cIntent, input.triggerKind)
  return {
    kind: "c-embedded-code",
    insertMode: "insert-at-cursor",
    ...(symbolPrefix ? { targetSymbol: currentWord } : {}),
    cIntent,
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsIntentRetrieval: true,
    needsTestRetrieval: false,
    useFim: true,
    useInstruction: false,
    maxTokens,
    confidenceFloor: confidenceFloorForIntent(cIntent),
    retrievalPolicy: retrievalPolicyForIntent(cIntent),
    domainHints: domainHintsForInput(input),
  }
}

export function classifyCEmbeddedIntent(input: CEmbeddedCompletionIntentInput) {
  if (!isCCompletionLanguage(input.languageId)) return
  const trimmed = input.linePrefix.trim()
  const currentWord = input.currentWord ?? ""
  const state = cCursorState(input)

  if (looksLikePreprocessor(trimmed)) return "preprocessor" as const
  if (looksLikeInitializer(input, state)) return "initializer" as const
  if (looksLikeMemberAccess(input.linePrefix, currentWord)) return "member-access" as const
  if (looksLikeTopLevelDeclaration(input, trimmed, state)) return "top-level-decl" as const
  if (looksLikeMmioRegisterContext(input.linePrefix, currentWord)) return "mmio-register" as const
  if (looksLikeStateMachineContext(input, trimmed, currentWord)) return "state-machine" as const
  if (looksLikeSwitchCaseContext(input, trimmed)) return "switch-case" as const
  if (looksLikeConditionContext(trimmed)) return "condition" as const
  if (looksLikeErrorPathContext(input, trimmed)) return "error-path" as const
  if (looksLikeCallArguments(trimmed)) return "call-args" as const
  if (looksLikeAssignmentRhs(trimmed)) return "assignment-rhs" as const
  if (currentWord && isIdentifier(currentWord)) return "symbol-prefix" as const
  if (trimmed && isIdentifierishStatement(trimmed)) return "body-statement" as const
  if (state?.stack.at(-1) === "block" || isManualTrigger(input.triggerKind)) return "body-statement" as const
  return undefined
}

export function retrievalPolicyForIntent(intent: NonNullable<CompletionPlan["cIntent"]>): CompletionRetrievalPolicy {
  return {
    label: retrievalPolicyLabelForIntent(intent),
    intent,
    queryMode: "c-embedded-intent",
    preferredKinds: retrievalPreferredKindsForIntent(intent),
  }
}

function retrievalPolicyLabelForIntent(intent: NonNullable<CompletionPlan["cIntent"]>) {
  switch (intent) {
    case "member-access":
      return "c-member-access"
    case "symbol-prefix":
      return "c-symbol-prefix"
    case "initializer":
      return "c-initializer"
    case "call-args":
      return "c-call-args"
    case "assignment-rhs":
      return "c-assignment-rhs"
    case "condition":
      return "c-condition"
    case "error-path":
      return "c-error-path"
    case "mmio-register":
      return "c-mmio-register"
    case "case-body":
    case "switch-case":
      return "c-case-body"
    case "top-level-declaration":
    case "top-level-decl":
      return "c-top-level-declaration"
    case "preprocessor":
      return "c-preprocessor"
    case "state-machine":
      return "c-state-machine"
    case "body-statement":
      return "c-body-statement"
  }
}

function retrievalPreferredKindsForIntent(intent: NonNullable<CompletionPlan["cIntent"]>): CompletionRetrievalPolicyKind[] {
  switch (intent) {
    case "member-access":
    case "initializer":
      return ["field", "type", "function", "global"]
    case "symbol-prefix":
      return ["function", "type", "macro", "global"]
    case "call-args":
      return ["function", "type", "macro", "global"]
    case "assignment-rhs":
      return ["function", "macro", "global", "type"]
    case "condition":
    case "case-body":
    case "switch-case":
    case "state-machine":
      return ["type", "macro", "function", "global"]
    case "error-path":
    case "body-statement":
      return ["function", "global", "type", "macro"]
    case "mmio-register":
    case "preprocessor":
      return ["macro", "global", "function", "type"]
    case "top-level-declaration":
    case "top-level-decl":
      return ["type", "macro", "function", "global"]
  }
}

export function domainHintsForInput(input: Pick<CEmbeddedCompletionIntentInput, "linePrefix" | "lineSuffix" | "currentWord" | "previousNonEmptyLine" | "nextNonEmptyLine" | "lines" | "line">) {
  const nearbyLines = input.lines && input.line !== undefined
    ? input.lines.slice(Math.max(0, input.line - 6), Math.min(input.lines.length, input.line + 7)).join("\n")
    : ""
  const text = [
    input.linePrefix,
    input.lineSuffix,
    input.currentWord,
    input.previousNonEmptyLine,
    input.nextNonEmptyLine,
    nearbyLines,
  ].filter(Boolean).join("\n")
  const hints: string[] = []
  if (/\bufs(?:\b|_)|\bUFS_|\bUfs[A-Z]/i.test(text)) hints.push("ufs")
  if (/\bssd(?:\b|_)|\bSSD_|\bSsd[A-Z]/i.test(text)) hints.push("ssd")
  if (/\bnand(?:\b|_)|\bNAND_|\bNand[A-Z]/i.test(text)) hints.push("nand")
  if (/\bftl(?:\b|_)|\bFTL_|\bFtl[A-Z]/i.test(text)) hints.push("ftl")
  if (/\brpmb(?:\b|_)|\bRPMB_|\bRpmb[A-Z]/i.test(text)) hints.push("rpmb")
  return hints
}

function maxTokensForIntent(intent: NonNullable<CompletionPlan["cIntent"]>, triggerKind: CompletionPlanInput["triggerKind"]) {
  const manual = isManualTrigger(triggerKind)
  switch (intent) {
    case "top-level-decl":
    case "top-level-declaration":
      return manual ? 192 : 128
    case "body-statement":
    case "switch-case":
    case "case-body":
    case "state-machine":
      return manual ? 128 : 96
    case "initializer":
    case "call-args":
    case "mmio-register":
      return manual ? 160 : 128
    case "preprocessor":
    case "member-access":
    case "symbol-prefix":
    case "condition":
    case "assignment-rhs":
    case "error-path":
      return manual ? 128 : 96
  }
}

function confidenceFloorForIntent(intent: NonNullable<CompletionPlan["cIntent"]>) {
  switch (intent) {
    case "member-access":
    case "symbol-prefix":
    case "mmio-register":
      return 0.4
    case "top-level-decl":
    case "top-level-declaration":
    case "body-statement":
    case "switch-case":
    case "case-body":
      return 0.35
    default:
      return 0.38
  }
}

function looksLikePreprocessor(trimmed: string) {
  return /^#\s*(?:define|if|ifdef|ifndef|elif|else|endif|include|pragma|undef)?\b/.test(trimmed) ||
    trimmed === "#"
}

function looksLikeInitializer(input: CEmbeddedCompletionIntentInput, state: CCursorState | undefined) {
  const trimmed = input.linePrefix.trim()
  if (/(?:^|[,{]\s*)\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(trimmed)) return true
  if (/(?:^|[,{]\s*)\.[A-Za-z_][A-Za-z0-9_]*\s*$/.test(trimmed) && input.lineSuffix.trim().startsWith("=")) return true
  if (state?.stack.at(-1) === "aggregate") return true
  return false
}

function looksLikeMemberAccess(linePrefix: string, currentWord: string) {
  const beforeWord = currentWord && linePrefix.endsWith(currentWord)
    ? linePrefix.slice(0, -currentWord.length)
    : linePrefix
  return /(?:->|\.)\s*$/.test(beforeWord)
}

function looksLikeConditionContext(trimmed: string) {
  return /\b(?:if|while)\s*\([^()]*$/.test(trimmed)
}

function looksLikeCallArguments(trimmed: string) {
  if (/\b(?:if|for|while|switch)\s*\([^()]*$/.test(trimmed)) return false
  return /\b[A-Za-z_][A-Za-z0-9_]*\s*\([^()]*$/.test(trimmed)
}

function looksLikeAssignmentRhs(trimmed: string) {
  if (/[=!<>]=\s*$/.test(trimmed)) return false
  return /(?:[A-Za-z_][A-Za-z0-9_]*|(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.test(trimmed)
}

function looksLikeErrorPathContext(input: CEmbeddedCompletionIntentInput, trimmed: string) {
  if (/^goto(?:\s+[A-Za-z_][A-Za-z0-9_]*)?$/.test(trimmed)) return true
  if (looksLikeRetErrGuard(input.previousNonEmptyLine)) return true
  if (hasVisibleLabel(input) && /\b(?:goto|ret|retval|err|errno|rc|status|error)\b/i.test(input.linePrefix)) return true
  return false
}

function looksLikeSwitchCaseContext(input: CEmbeddedCompletionIntentInput, trimmed: string) {
  if (/^(?:case\b.*:|default\s*:)\s*$/.test(trimmed)) return true
  const previous = input.previousNonEmptyLine?.trim() ?? ""
  return /^(?:case\b.*:|default\s*:)$/.test(previous)
}

function looksLikeStateMachineContext(input: CEmbeddedCompletionIntentInput, trimmed: string, currentWord: string) {
  if (/\bswitch\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(trimmed) && stateLikeText(trimmed)) return true
  if (looksLikeSwitchCaseContext(input, trimmed) && stateLikeText(enclosingSwitchSubject(input))) return true
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(trimmed) && stateAssignmentLikeText(trimmed)) return true
  if (currentWord && /(?:^|_)(?:STATE|STATUS|MODE|PHASE)(?:_|$)/i.test(currentWord)) return true
  if (/\b(?:state|status|mode|phase)\s*=\s*[A-Za-z_][A-Za-z0-9_]*$/i.test(trimmed)) return true
  return stateLikeText(input.previousNonEmptyLine ?? "") && /^(?:case\b.*:|default\s*:)$/.test(trimmed)
}

function looksLikeTopLevelDeclaration(input: CEmbeddedCompletionIntentInput, trimmed: string, state: CCursorState | undefined) {
  const topLevel = !state || state.stack.length === 0
  if (!topLevel) return false
  if (!trimmed && isManualTrigger(input.triggerKind)) return true
  if (!trimmed) return looksLikeTopLevelDeclarationGap(input.previousNonEmptyLine, input.nextNonEmptyLine)
  if (/^(?:static|extern|inline|typedef|struct|union|enum|const|volatile|unsigned|signed|void|int|char|short|long|bool|size_t|uint(?:8|16|32|64)_t|int(?:8|16|32|64)_t)\b/.test(trimmed)) return true
  if (/^[A-Z][A-Z0-9_]*\s*\([^()]*$/.test(trimmed)) {
    return !looksLikeMmioRegisterContext(input.linePrefix, input.currentWord ?? "")
  }
  return false
}

function looksLikeMmioRegisterContext(linePrefix: string, currentWord: string) {
  const identifiers = linePrefix.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  const last = currentWord || identifiers.at(-1) || ""
  if (last && /(?:_REG|_MASK|_SHIFT|_BIT|_BITS|_CTRL|_CFG|_STATUS|_ENABLE|_DISABLE)$/i.test(last)) return true
  if (identifiers.some(isMmioHelperIdentifier)) return true
  if (/\b(?:BIT|GENMASK|FIELD_PREP|FIELD_GET)\s*\([^()]*$/.test(linePrefix)) return true
  if (/\b[A-Z][A-Z0-9_]*(?:_REG|_MASK|_SHIFT|_BIT|_BITS)\b/.test(linePrefix)) return true
  return false
}

function isMmioHelperIdentifier(identifier: string) {
  return /^(?:readl|writel|readw|writew|readb|writeb|ioread(?:8|16|32|64)?|iowrite(?:8|16|32|64)?|FIELD_PREP|FIELD_GET|GENMASK|BIT)$/.test(identifier)
}

function looksLikeRetErrGuard(line: string | undefined) {
  const trimmed = line?.trim() ?? ""
  if (!/\bif\s*\([^)]*\)\s*\{\s*$/.test(trimmed)) return false
  return /\b(?:ret|retval|err|errno|rc|status|error|failed|fail)\b/i.test(trimmed)
}

function hasVisibleLabel(input: CEmbeddedCompletionIntentInput) {
  if (!input.lines || input.line === undefined) return false
  const before = input.lines.slice(0, input.line).join("\n")
  const after = input.lines.slice(input.line + 1, Math.min(input.lines.length, input.line + 80)).join("\n")
  return labelPattern().test(before) || labelPattern().test(after)
}

function labelPattern() {
  return /^[ \t]*[A-Za-z_][A-Za-z0-9_]*:\s*(?:\/\/.*)?$/m
}

function stateLikeText(input: string) {
  return /\b(?:state|status|mode|phase)\b/i.test(input) ||
    /\b[A-Z][A-Z0-9_]*(?:_STATE|_STATUS|_MODE|_PHASE|STATE_|STATUS_|MODE_|PHASE_)[A-Z0-9_]*\b/.test(input)
}

function stateAssignmentLikeText(input: string) {
  return /\b(?:state|mode|phase)\b/i.test(input) ||
    /\b[A-Z][A-Z0-9_]*(?:_STATE|_MODE|_PHASE|STATE_|MODE_|PHASE_)[A-Z0-9_]*\b/.test(input)
}

function enclosingSwitchSubject(input: CEmbeddedCompletionIntentInput) {
  if (!input.lines || input.line === undefined) return ""
  for (let index = input.line; index >= Math.max(0, input.line - 80); index -= 1) {
    const text = input.lines[index] ?? ""
    const match = /\bswitch\s*\(([^)]*)\)/.exec(text)
    if (match?.[1]) return match[1]
  }
  return ""
}

function isIdentifier(input: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(input)
}

function isIdentifierishStatement(input: string) {
  return /[A-Za-z_][A-Za-z0-9_]*(?:\s|$|[({[=+\-*/&|!~?:,.>])/.test(input)
}

function isManualTrigger(triggerKind: CompletionPlanInput["triggerKind"]) {
  return triggerKind === "manual" || triggerKind === "invoke"
}

function isUnsafeCContext(input: CEmbeddedCompletionIntentInput) {
  const trimmed = input.linePrefix.trim()
  if (/^(?:\/\/|\/\*|\*)/.test(trimmed)) return true
  const state = cCursorState(input)
  return Boolean(state?.inComment || state?.inString || isInsideLineString(input.linePrefix))
}

function cCursorState(input: CEmbeddedCompletionIntentInput): CCursorState | undefined {
  if (!input.lines || input.line === undefined) return undefined
  const beforeCursor = [
    ...input.lines.slice(0, input.line),
    (input.lines[input.line] ?? "").slice(0, input.linePrefix.length),
  ].join("\n")
  return scanCBlockState(beforeCursor)
}

function scanCBlockState(input: string): CCursorState {
  const stack: CCursorState["stack"] = []
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

function isInsideLineString(linePrefix: string) {
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (let index = 0; index < linePrefix.length; index += 1) {
    const char = linePrefix[index]
    const next = linePrefix[index + 1]
    if (!quote && char === "/" && next === "/") break
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
    if (char === "\"" || char === "'") quote = char
  }
  return Boolean(quote)
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
