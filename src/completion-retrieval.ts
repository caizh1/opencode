import { isCCompletionLanguage } from "./completion-c-intent"
import type { CompletionPlan } from "./completion-types"

export type CompletionRetrievalPreferredKind = "type" | "macro" | "function" | "global"

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
  if (plan.needsSymbolRetrieval || plan.needsTestRetrieval) return true
  if (!isCCompletionLanguage(languageId)) return false
  return plan.kind === "ordinary-code" ||
    plan.kind === "body-continuation" ||
    plan.kind === "top-level-declaration"
}

export function completionRetrievalQuery(input: CompletionRetrievalQueryInput) {
  return completionRetrievalPlan(input).queries[0] ?? ""
}

export function completionRetrievalPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  if (input.plan.targetSymbol) {
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
        queries: [input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: `C/C++ inline completion for symbol-prefix ${input.currentWord || lastIdentifier(input.linePrefix)}; find matching symbols, declarations, macros, and nearby usage.`,
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
      return retrievalPlan({
        queries: [switchSubject(input.linePrefix), input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: "C/C++ inline completion for switch/case body; find state machine branches, enum values, and nearby case handling style.",
        policyLabel: "c-case-body",
        preferredKinds: ["type", "macro", "function", "global"],
      })
    case "body-statement":
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix), recentStatementIdentifier(input.linePrefix)],
        evidenceQuestion: "C/C++ inline completion for a function body statement; find visible local helpers, macros, and nearby body-statement style.",
        policyLabel: "c-body-statement",
        preferredKinds: ["function", "macro", "type", "global"],
      })
    case "top-level-declaration":
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: "C/C++ inline completion for top-level declaration; find nearby typedefs, macros, globals, function prototypes, and declarations.",
        policyLabel: "c-top-level-declaration",
        preferredKinds: ["type", "macro", "function", "global"],
      })
    default:
      return retrievalPlan({
        queries: [input.currentWord, lastIdentifier(input.linePrefix)],
        evidenceQuestion: "Find local symbols and nearby usage relevant to this inline completion.",
        policyLabel: "generic-completion",
        preferredKinds: ["function", "type", "macro", "global"],
      })
  }
}

function memberAccessPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const base = memberAccessBase(input.linePrefix)
  const member = input.currentWord || memberAccessMemberPrefix(input.linePrefix)
  return retrievalPlan({
    queries: [base, member, recentStatementIdentifier(input.linePrefix)],
    evidenceQuestion: `C/C++ inline completion for member-access on base ${base || "<unknown>"} with member prefix ${member || "<none>"}; find type definitions, struct fields, and nearby field usage.`,
    policyLabel: "c-member-access",
    preferredKinds: ["type", "global", "function"],
  })
}

function initializerPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const field = designatedInitializerField(input.linePrefix)
  return retrievalPlan({
    queries: [field, input.currentWord, lastIdentifier(input.linePrefix)],
    evidenceQuestion: `C/C++ inline completion for initializer field ${field || input.currentWord || "<unknown>"}; find struct or typedef definitions, callback signatures, and similar initializer examples.`,
    policyLabel: "c-initializer",
    preferredKinds: ["type", "function", "global"],
  })
}

function callArgsPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const callee = callExpressionCallee(input.linePrefix)
  return retrievalPlan({
    queries: [callee, assignmentLhsIdentifier(input.linePrefix), input.currentWord],
    evidenceQuestion: `C/C++ inline completion for call-args of ${callee || "<unknown>"}; find callee declaration, nearby call-site examples, argument order, and return handling.`,
    policyLabel: "c-call-args",
    preferredKinds: ["function", "type", "macro", "global"],
  })
}

function assignmentPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const lhs = assignmentLhsIdentifier(input.linePrefix)
  return retrievalPlan({
    queries: [lhs, input.currentWord, lastIdentifier(input.linePrefix)],
    evidenceQuestion: `C/C++ inline completion for assignment RHS of ${lhs || "<unknown>"}; find value producers, macros, return values, and nearby assignments.`,
    policyLabel: "c-assignment-rhs",
    preferredKinds: ["function", "macro", "global", "type"],
  })
}

function conditionPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const identifiers = trailingIdentifiers(input.linePrefix).filter((item) => !/^(?:if|while)$/.test(item))
  return retrievalPlan({
    queries: [input.currentWord, ...identifiers, recentStatementIdentifier(input.linePrefix)],
    evidenceQuestion: "C/C++ inline completion for condition expression; find current function variables, status or state enum values, condition branch examples, and nearby guard style.",
    policyLabel: "c-condition",
    preferredKinds: ["type", "macro", "function", "global"],
  })
}

function errorPathPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const label = gotoLabelPrefix(input.linePrefix)
  const lhs = assignmentLhsIdentifier(input.linePrefix)
  return retrievalPlan({
    queries: [label, input.currentWord, lhs, "goto", "ret"],
    evidenceQuestion: `C/C++ inline completion for error-path${label ? ` label ${label}` : ""}; find cleanup labels, goto out-style exits, ret/err handling, unlock/free cleanup, and same-file cleanup examples.`,
    policyLabel: "c-error-path",
    preferredKinds: ["function", "global", "type", "macro"],
  })
}

function mmioRegisterPlan(input: CompletionRetrievalQueryInput): CompletionRetrievalPlan {
  const helpers = mmioIdentifiers(input.linePrefix)
  return retrievalPlan({
    queries: [...helpers, input.currentWord, registerLikeIdentifier(input.linePrefix), lastIdentifier(input.linePrefix)],
    evidenceQuestion: "C/C++ inline completion for MMIO/register access; find register macros, bit masks, read/write helpers, volatile or barrier usage, and nearby register access examples.",
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
