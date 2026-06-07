export type CommentGuidedTokenGroups = {
  normalizedTokens: string[]
  actionTokens: string[]
  objectTokens: string[]
  domainTokens: string[]
  ignoredTokens: string[]
}

export type CommentGuidedTokenCoverage = {
  actionTokenCoverage: number
  objectTokenCoverage: number
  domainTokenCoverage: number
  matchedActionTokens: string[]
  matchedObjectTokens: string[]
  matchedDomainTokens: string[]
}

export type CommentGuidedCandidateScore = CommentGuidedTokenCoverage & {
  semanticScore: number
  graphProximityScore: number
  sameModuleScore: number
  codeShapeScore: number
  totalScore: number
}

const COMMENT_TOKEN_ALIASES = new Map<string, string>([
  ["clk", "clock"],
  ["rst", "reset"],
  ["cfg", "config"],
  ["irq", "interrupt"],
  ["poll", "wait"],
  ["until", "wait"],
])

const COMMENT_ACTION_TOKENS = new Set([
  "add",
  "apply",
  "build",
  "call",
  "check",
  "clear",
  "close",
  "config",
  "disable",
  "enable",
  "finish",
  "free",
  "handle",
  "init",
  "initialize",
  "load",
  "open",
  "parse",
  "prepare",
  "process",
  "read",
  "release",
  "reset",
  "restore",
  "return",
  "save",
  "set",
  "shutdown",
  "start",
  "stop",
  "store",
  "sync",
  "update",
  "validate",
  "wait",
  "write",
])

const COMMENT_DOMAIN_TOKENS = new Set([
  "ahci",
  "dma",
  "emmc",
  "flash",
  "ftl",
  "gpio",
  "i2c",
  "mmio",
  "nand",
  "nfc",
  "nfi",
  "nvme",
  "pcie",
  "rpmb",
  "sata",
  "spi",
  "ssd",
  "uart",
  "ufs",
  "usb",
])

const COMMENT_WEAK_FLOW_TOKENS = new Set([
  "done",
  "end",
  "flow",
  "init",
  "phase",
  "path",
  "stage",
  "start",
  "step",
])

const COMMENT_STOP_WORDS = new Set([
  "after",
  "before",
  "below",
  "code",
  "current",
  "for",
  "from",
  "here",
  "next",
  "the",
  "then",
  "this",
  "with",
])

export function normalizeCommentGuidedTokens(comment: string): CommentGuidedTokenGroups {
  const ignoredTokens: string[] = []
  const normalized = tokenizeCommentGuidedText(stripCommentMarker(comment))
    .map((token) => normalizeCommentToken(token))
    .filter((token) => {
      if (!token) return false
      if (COMMENT_STOP_WORDS.has(token) || isWeakFlowToken(token)) {
        ignoredTokens.push(token)
        return false
      }
      return true
    })

  const normalizedTokens = uniqueStrings(normalized)
  const actionTokens: string[] = []
  const objectTokens: string[] = []
  const domainTokens: string[] = []
  for (const token of normalizedTokens) {
    if (COMMENT_ACTION_TOKENS.has(token)) {
      actionTokens.push(token)
    } else if (COMMENT_DOMAIN_TOKENS.has(token)) {
      domainTokens.push(token)
    } else {
      objectTokens.push(token)
    }
  }

  return {
    normalizedTokens,
    actionTokens,
    objectTokens,
    domainTokens,
    ignoredTokens: uniqueStrings(ignoredTokens),
  }
}

export function scoreCommentGuidedCandidate(input: {
  comment: CommentGuidedTokenGroups
  candidateText: string
  graphProximityScore?: number
  sameModuleScore?: number
}) {
  const candidateTokens = new Set(tokenizeCommentGuidedText(input.candidateText).map(normalizeCommentToken).filter(Boolean))
  const action = matchedTokens(input.comment.actionTokens, candidateTokens)
  const object = matchedTokens(input.comment.objectTokens, candidateTokens)
  const domain = matchedTokens(input.comment.domainTokens, candidateTokens)
  const actionTokenCoverage = coverage(action.length, input.comment.actionTokens.length)
  const objectTokenCoverage = coverage(object.length, input.comment.objectTokens.length)
  const domainTokenCoverage = coverage(domain.length, input.comment.domainTokens.length)
  const graphProximityScore = input.graphProximityScore ?? 0
  const sameModuleScore = input.sameModuleScore ?? 0
  const codeShapeScore = commentGuidedCodeShapeScore(input.comment, input.candidateText)
  const semanticScore =
    actionTokenCoverage * 420 +
    objectTokenCoverage * 330 +
    domainTokenCoverage * 60 +
    action.length * 40 +
    object.length * 28 +
    domain.length * 6
  return {
    actionTokenCoverage,
    objectTokenCoverage,
    domainTokenCoverage,
    matchedActionTokens: action,
    matchedObjectTokens: object,
    matchedDomainTokens: domain,
    semanticScore,
    graphProximityScore,
    sameModuleScore,
    codeShapeScore,
    totalScore: semanticScore + graphProximityScore + sameModuleScore + codeShapeScore,
  }
}

export function commentGuidedCoverageSummary(coverage: CommentGuidedTokenCoverage) {
  return [
    `coverage action=${coverage.actionTokenCoverage.toFixed(2)}`,
    `object=${coverage.objectTokenCoverage.toFixed(2)}`,
    `domain=${coverage.domainTokenCoverage.toFixed(2)}`,
    coverage.matchedActionTokens.length ? `matched-action=${coverage.matchedActionTokens.join(",")}` : "",
    coverage.matchedObjectTokens.length ? `matched-object=${coverage.matchedObjectTokens.join(",")}` : "",
    coverage.matchedDomainTokens.length ? `matched-domain=${coverage.matchedDomainTokens.join(",")}` : "",
  ].filter(Boolean).join(" ")
}

export function commentGuidedScoreFromCoverage(coverage: Pick<CommentGuidedCandidateScore, "totalScore">) {
  return Math.round(coverage.totalScore)
}

function stripCommentMarker(input: string) {
  return input
    .trim()
    .replace(/^\/\/\s*/, "")
    .replace(/^#\s*/, "")
    .replace(/^\/\*\s*/, "")
    .replace(/\s*\*\/$/, "")
}

function tokenizeCommentGuidedText(input: string) {
  return uniqueStrings(
    input
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9_]+|_+/)
      .flatMap((token) => token.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/))
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 2),
  )
}

function normalizeCommentToken(input: string) {
  const lower = input.toLowerCase()
  const singular = lower.length > 3 && lower.endsWith("s") ? lower.slice(0, -1) : lower
  return COMMENT_TOKEN_ALIASES.get(singular) ?? singular
}

function isWeakFlowToken(token: string) {
  const base = token.replace(/\d+$/g, "")
  return COMMENT_WEAK_FLOW_TOKENS.has(base)
}

function matchedTokens(tokens: string[], candidateTokens: Set<string>) {
  return tokens.filter((token) => candidateTokens.has(token))
}

function coverage(matches: number, total: number) {
  return total > 0 ? matches / total : 0
}

function commentGuidedCodeShapeScore(comment: CommentGuidedTokenGroups, candidateText: string) {
  const text = candidateText.toLowerCase()
  let score = 0
  if (comment.actionTokens.includes("wait") && /\b(?:while|for|wait|sleep|delay|ready|done|timeout|relax)\b/.test(text)) score += 70
  if (comment.actionTokens.includes("reset") && /\b(?:reset|rst|clear|reinit|init)\b/.test(text)) score += 50
  if (comment.actionTokens.includes("config") && /\b(?:config|cfg|set|write|mask|bit)\b/.test(text)) score += 45
  if (comment.actionTokens.includes("enable") && /\b(?:enable|set|start|on)\b/.test(text)) score += 35
  if (comment.actionTokens.includes("disable") && /\b(?:disable|clear|stop|off)\b/.test(text)) score += 35
  return score
}

function uniqueStrings<T extends string>(values: T[]) {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
