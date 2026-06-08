import { isCCompletionLanguage } from "./completion-c-intent"
import { normalizeCommentGuidedTokens } from "./completion-comment-guided-ranking"
import type { CompletionPlan } from "./completion-types"

export type CompletionRetrievalPreferredKind = "type" | "macro" | "function" | "global" | "field"

export type CompletionRetrievalPlan = {
  queries: string[]
  evidenceQuestion: string
  policyLabel: string
  preferredKinds?: CompletionRetrievalPreferredKind[]
}

export type CompletionRetrievalQueryInput = {
  plan: CompletionPlan
  languageId: string
  linePrefix: string
  lineSuffix: string
  currentWord?: string
}

export function shouldRetrieveCompletionSnippetsForPlan(plan: CompletionPlan, languageId: string) {
  if (plan.needsSymbolRetrieval || plan.needsIntentRetrieval || plan.needsTestRetrieval) return true
  if (!isCCompletionLanguage(languageId)) return false
  return plan.kind === "ordinary-code" ||
    plan.kind === "c-embedded-code" ||
    plan.kind === "comment-guided-c-code" ||
    plan.kind === "body-continuation" ||
    plan.kind === "top-level-declaration"
}

export function completionRetrievalQuery(input: CompletionRetrievalQueryInput) {
  return completionRetrievalPlan(input).queries[0] ?? ""
}

export function completionRetrievalPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  if (input.plan.kind === "comment-guided-c-code") {
    return commentGuidedCCodePlan(input)
  }

  if (input.plan.targetSymbol && !isCEmbeddedSymbolPrefixPlan(input.plan)) {
    return retrievalPlan({
      queries: [input.plan.targetSymbol],
      evidenceQuestion: `Find the target symbol ${input.plan.targetSymbol} and nearby usage for inline completion.`,
      policyLabel: input.plan.needsTestRetrieval ? "target-test-symbol" : "target-symbol",
      preferredKinds: ["function", "type", "global"],
    })
  }

  if (input.plan.needsTestRetrieval && input.currentWord) {
    return retrievalPlan({
      queries: [input.currentWord],
      evidenceQuestion: `Find symbols and test examples related to ${input.currentWord}.`,
      policyLabel: "test-symbol-prefix",
      preferredKinds: ["function", "type", "global"],
    })
  }

  switch (input.plan.cIntent) {
    case "member-access":
      return memberAccessPlan(input)
    case "symbol-prefix":
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix), recentStatementIdentifier(input.linePrefix), ...nearbyCommentTokens(input.linePrefix).slice(0, 2)],
        evidenceQuestion: evidenceQuestion("symbol-prefix", [
          ["current-word", input.currentWord],
          ["last-identifier", lastIdentifier(input.linePrefix)],
          ["recent-identifier", recentStatementIdentifier(input.linePrefix)],
          ["nearby-comment-tokens", nearbyCommentTokens(input.linePrefix).join(" ")],
          ["line-prefix-shape", lineShape(input.linePrefix)],
          ["line-suffix-shape", lineShape(input.lineSuffix)],
        ], "Find matching symbols, declarations, macros, current-function flow, nearby helper calls, and same-module usage. Treat very short current-word prefixes as weak hints; prioritize cursor-local context."),
        policyLabel: "c-symbol-prefix",
        preferredKinds: ["function", "type", "macro", "global"],
      })
    case "initializer":
      return initializerPlan(input)
    case "call-args":
      return callArgsPlan(input)
    case "assignment-rhs":
      return assignmentPlan(input)
    case "condition":
      return conditionPlan(input)
    case "error-path":
      return errorPathPlan(input)
    case "mmio-register":
      return mmioRegisterPlan(input)
    case "case-body":
    case "switch-case":
      return retrievalPlan({
        queries: [switchSubject(input.linePrefix), input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: evidenceQuestion("case-body", [
          ["switch-subject", switchSubject(input.linePrefix)],
          ["current-word", input.currentWord],
          ["last-identifier", lastIdentifier(input.linePrefix)],
        ], "Find state machine branches, enum values, legal transitions, and nearby case handling style."),
        policyLabel: "c-case-body",
        preferredKinds: ["type", "macro", "function", "global"],
      })
    case "body-statement":
      const bodyCommentTokens = nearbyCommentTokens(input.linePrefix)
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix), recentStatementIdentifier(input.linePrefix), ...bodyCommentTokens.slice(0, 2)],
        evidenceQuestion: evidenceQuestion("body-statement", [
          ["last-identifier", lastIdentifier(input.linePrefix)],
          ["recent-identifier", recentStatementIdentifier(input.linePrefix)],
          ["current-word", input.currentWord],
          ["nearby-comment-tokens", bodyCommentTokens.join(" ")],
        ], "Find visible local helpers, macros, nearby body-statement style, and same-module embedded C examples."),
        policyLabel: "c-body-statement",
        preferredKinds: ["function", "macro", "type", "global"],
      })
    case "top-level-declaration":
    case "top-level-decl":
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: evidenceQuestion("top-level-declaration", [
          ["current-word", input.currentWord],
          ["last-identifier", lastIdentifier(input.linePrefix)],
        ], "Find nearby typedefs, macros, globals, function prototypes, and declarations."),
        policyLabel: "c-top-level-declaration",
        preferredKinds: ["type", "macro", "function", "global"],
      })
    case "preprocessor":
      return retrievalPlan({
        queries: [preprocessorIdentifier(input.linePrefix), input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: evidenceQuestion("preprocessor", [
          ["directive", preprocessorDirective(input.linePrefix)],
          ["current-word", input.currentWord],
          ["last-identifier", lastIdentifier(input.linePrefix)],
        ], "Find matching macros, include guards, compile-time constants, and nearby preprocessor style."),
        policyLabel: "c-preprocessor",
        preferredKinds: ["macro", "type", "global", "function"],
      })
    case "state-machine":
      return retrievalPlan({
        queries: [stateMachineIdentifier(input.linePrefix), input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: evidenceQuestion("state-machine", [
          ["symbols", uniqueNonEmpty([stateMachineIdentifier(input.linePrefix), input.currentWord, lastIdentifier(input.linePrefix)]).join(" ")],
          ["current-word", input.currentWord],
          ["recent-identifier", recentStatementIdentifier(input.linePrefix)],
        ], "Find state variables, enum values, legal transitions, switch branches, and nearby state-machine update style."),
        policyLabel: "c-state-machine",
        preferredKinds: ["type", "macro", "function", "global"],
      })
    default:
      const commentTokens = nearbyCommentTokens(input.linePrefix)
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix), ...commentTokens.slice(0, 2)],
        evidenceQuestion: evidenceQuestion("generic-c-embedded", [
          ["current-word", input.currentWord],
          ["last-identifier", lastIdentifier(input.linePrefix)],
          ["nearby-comment-tokens", commentTokens.join(" ")],
        ], "Find local symbols, helper calls, macros, type hints, and nearby usage relevant to this inline completion."),
        policyLabel: "generic-completion",
        preferredKinds: ["function", "type", "macro", "global"],
      })
  }
}

function isCEmbeddedSymbolPrefixPlan(plan: CompletionPlan) {
  return plan.kind === "c-embedded-code" && plan.cIntent === "symbol-prefix"
}

function commentGuidedCCodePlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const commentText = stripCommentMarker(input.plan.sourceComment ?? "")
  const commentTokens = semanticCommentTokens(commentText)
  const nearby = uniqueNonEmpty([
    ...trailingIdentifiers(input.linePrefix).slice(-6),
    lastIdentifier(input.linePrefix),
    recentStatementIdentifier(input.linePrefix),
  ])
  return retrievalPlan({
    queries: [...commentTokens.slice(0, 3), ...nearby.slice(0, 2)],
    evidenceQuestion: evidenceQuestion("comment-guided-c-code", [
      ["source-comment", commentText],
      ["nearby-identifiers", nearby.join(" ")],
      ["line-prefix-shape", lineShape(input.linePrefix)],
      ["line-suffix-shape", lineShape(input.lineSuffix)],
      ["current-word", input.currentWord],
    ], "Find short, similar C functions, code blocks, and same-module flow examples that implement the source comment near this cursor."),
    policyLabel: "c-comment-guided-code",
    preferredKinds: ["function", "macro", "type", "global"],
  })
}

function memberAccessPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const base = memberAccessBase(input.linePrefix)
  const member = input.currentWord || memberAccessMemberPrefix(input.linePrefix)
  return retrievalPlan({
    queries: [base, member, recentStatementIdentifier(input.linePrefix)],
    evidenceQuestion: evidenceQuestion("member-access", [
      ["member-base", base],
      ["member-prefix", member],
      ["recent-identifier", recentStatementIdentifier(input.linePrefix)],
    ], "Find base expression type, struct or union fields, and nearby field usage examples."),
    policyLabel: "c-member-access",
    preferredKinds: ["field", "type", "global", "function"],
  })
}

function initializerPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const field = designatedInitializerField(input.linePrefix)
  return retrievalPlan({
    queries: [field, input.currentWord, lastIdentifier(input.linePrefix)],
    evidenceQuestion: evidenceQuestion("initializer", [
      ["initializer-field", field || input.currentWord],
      ["last-identifier", lastIdentifier(input.linePrefix)],
    ], "Find aggregate type, struct fields, callback signatures, field order, and similar designated initializer examples."),
    policyLabel: "c-initializer",
    preferredKinds: ["field", "type", "function", "global"],
  })
}

function callArgsPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const callee = callExpressionCallee(input.linePrefix)
  return retrievalPlan({
    queries: [callee, assignmentLhsIdentifier(input.linePrefix), input.currentWord],
    evidenceQuestion: evidenceQuestion("call-args", [
      ["callee", callee],
      ["assignment-lhs", assignmentLhsIdentifier(input.linePrefix)],
      ["current-word", input.currentWord],
    ], "Find callee declaration, nearby call-site examples, argument order, and return handling."),
    policyLabel: "c-call-args",
    preferredKinds: ["function", "type", "macro", "global"],
  })
}

function assignmentPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const lhs = assignmentLhsIdentifier(input.linePrefix)
  return retrievalPlan({
    queries: [lhs, input.currentWord, lastIdentifier(input.linePrefix)],
    evidenceQuestion: evidenceQuestion("assignment-rhs", [
      ["assignment-lhs", lhs],
      ["current-word", input.currentWord],
      ["last-identifier", lastIdentifier(input.linePrefix)],
    ], "Find value producers, macros, return values, and nearby assignments."),
    policyLabel: "c-assignment-rhs",
    preferredKinds: ["function", "macro", "global", "type"],
  })
}

function conditionPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const identifiers = trailingIdentifiers(input.linePrefix).filter((item) => !/^(?:if|while)$/.test(item))
  return retrievalPlan({
    queries: [input.currentWord, ...identifiers, recentStatementIdentifier(input.linePrefix)],
    evidenceQuestion: evidenceQuestion("condition", [
      ["symbols", identifiers.join(" ")],
      ["current-word", input.currentWord],
      ["recent-identifier", recentStatementIdentifier(input.linePrefix)],
    ], "Find current function variables, status or state enum values, condition branch examples, and nearby guard style."),
    policyLabel: "c-condition",
    preferredKinds: ["type", "macro", "function", "global"],
  })
}

function errorPathPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const label = gotoLabelPrefix(input.linePrefix)
  const lhs = assignmentLhsIdentifier(input.linePrefix)
  return retrievalPlan({
    queries: [label, input.currentWord, lhs, "goto", "ret"],
    evidenceQuestion: evidenceQuestion("error-path", [
      ["goto-label-prefix", label],
      ["assignment-lhs", lhs],
      ["current-word", input.currentWord],
    ], "Find same-function cleanup labels, goto out-style exits, ret/err handling, unlock/free/release cleanup order, and same-file cleanup examples."),
    policyLabel: "c-error-path",
    preferredKinds: ["function", "global", "type", "macro"],
  })
}

function mmioRegisterPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const helpers = mmioIdentifiers(input.linePrefix)
  return retrievalPlan({
    queries: [...helpers, input.currentWord, registerLikeIdentifier(input.linePrefix), lastIdentifier(input.linePrefix)],
    evidenceQuestion: evidenceQuestion("mmio-register", [
      ["register-tokens", uniqueNonEmpty([...helpers, input.currentWord, registerLikeIdentifier(input.linePrefix), lastIdentifier(input.linePrefix)]).join(" ")],
    ], "Find register macro families, bit masks, shifts, read/write helpers, volatile or barrier usage, and nearby register access examples."),
    policyLabel: "c-mmio-register",
    preferredKinds: ["macro", "global", "function"],
  })
}

function retrievalPlan(input: Omit<CompletionRetrievalPlan, "queries"> & { queries: Array<string | undefined> }): CompletionRetrievalPlan {
  return {
    ...input,
    queries: uniqueNonEmpty(input.queries).slice(0, 4),
  }
}

function evidenceQuestion(intent: string, fields: Array<[string, string | undefined]>, instruction: string) {
  return [
    `completion-intent: ${intent}`,
    ...fields
      .map(([key, value]) => [key, value?.trim()] as const)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}: ${value}`),
    `goal: ${instruction}`,
  ].join("\n")
}

function stripCommentMarker(input: string) {
  return input
    .trim()
    .replace(/^\/\/\s*/, "")
    .replace(/^#\s*/, "")
    .replace(/^\/\*\s*/, "")
    .replace(/\s*\*\/$/, "")
    .trim()
}

function semanticCommentTokens(input: string) {
  return normalizeCommentGuidedTokens(input).normalizedTokens
}

function lineShape(input: string) {
  const line = input.split(/\r?\n/).at(-1)?.trim() ?? ""
  if (!line) return "blank"
  if (/\b(?:if|while|for|switch)\s*\([^)]*$/.test(line)) return "condition"
  if (/\bgoto\s+[A-Za-z_][A-Za-z0-9_]*?$/.test(line)) return "goto"
  if (/\.\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(line)) return "initializer"
  if (/[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*$/.test(line)) return "call"
  return "statement"
}

function uniqueNonEmpty(items: Array<string | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const value = item?.trim()
    if (!value || value.length < 2) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function memberAccessBase(linePrefix: string) {
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|\.)\s*(?:[A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix)
  return match?.[1] ?? ""
}

function memberAccessMemberPrefix(linePrefix: string) {
  const match = /(?:->|\.)\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix)
  return match?.[1] ?? ""
}

function designatedInitializerField(linePrefix: string) {
  const match = /\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(linePrefix)
  return match?.[1] ?? ""
}

function callExpressionCallee(linePrefix: string) {
  const matches = [...linePrefix.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*$/g)]
  const callee = matches.at(-1)?.[1] ?? ""
  if (/^(?:if|for|while|switch)$/.test(callee)) return ""
  return callee
}

function assignmentLhsIdentifier(linePrefix: string) {
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:[A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix)
  return match?.[1] ?? ""
}

function gotoLabelPrefix(linePrefix: string) {
  const match = /\bgoto\s+([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix)
  return match?.[1] ?? ""
}

function switchSubject(linePrefix: string) {
  const match = /\bswitch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(linePrefix)
  return match?.[1] ?? ""
}

function preprocessorDirective(linePrefix: string) {
  const match = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(linePrefix)
  return match?.[1] ?? ""
}

function preprocessorIdentifier(linePrefix: string) {
  const withoutDirective = linePrefix.replace(/^\s*#\s*[A-Za-z_][A-Za-z0-9_]*/, "")
  return lastIdentifier(withoutDirective)
}

function stateMachineIdentifier(linePrefix: string) {
  const match = /\b([A-Za-z_][A-Za-z0-9_]*(?:state|status|mode|phase)|(?:state|status|mode|phase)[A-Za-z_][A-Za-z0-9_]*)\b/i.exec(linePrefix)
  return match?.[1] ?? switchSubject(linePrefix)
}

function recentStatementIdentifier(input: string) {
  const lines = input.replace(/\r\n/g, "\n").split("\n").slice(-5).join("\n")
  return lastIdentifier(lines)
}

function lastIdentifier(input: string) {
  const matches = input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)
  return matches?.at(-1) ?? ""
}

function trailingIdentifiers(input: string) {
  return (input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).slice(-4).reverse()
}

function nearbyCommentTokens(input: string) {
  const commentLines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(-8)
    .filter((line) => /^\s*(?:(?:\/\/)|(?:\/\*)|\*)/.test(line))
  const tokens = commentLines.flatMap((line) => line.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [])
  return uniqueNonEmpty(tokens).slice(-6).reverse()
}

function mmioIdentifiers(input: string) {
  const identifiers = input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  return identifiers
    .filter((identifier) => /^(?:readl|writel|readw|writew|readb|writeb|ioread(?:8|16|32|64)?|iowrite(?:8|16|32|64)?|FIELD_PREP|FIELD_GET|GENMASK|BIT)$/.test(identifier))
    .reverse()
}

function registerLikeIdentifier(input: string) {
  const identifiers = input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  for (let index = identifiers.length - 1; index >= 0; index -= 1) {
    const identifier = identifiers[index]
    if (identifier && /(?:_REG|_MASK|_SHIFT|_BIT|_BITS|_CTRL|_CFG|_STATUS|_ENABLE|_DISABLE)$/i.test(identifier)) {
      return identifier
    }
  }
  return ""
}
