import type { CodeGraphSymbolCandidate, CodeGraphSymbolKind } from "./codegraph-types"
import type { RetrievedCompletionSnippet } from "./completion-types"

export type SymbolCandidateKind = "function" | "method" | "macro" | "type" | "variable" | "unknown"

export type SymbolCandidateSource = "codeGraph" | "workspace" | "openDocument" | "retrievedSnippet"

export interface SymbolCandidate {
  name: string
  kind: SymbolCandidateKind
  signature?: string
  filePath?: string
  line?: number
  score: number
  snippet?: string
  source: SymbolCandidateSource
}

export type ResolvedSymbolCandidate = SymbolCandidate & {
  score: number
  matchScore: number
  reasons: string[]
}

export type SymbolResolverInput = {
  query: string
  candidates: SymbolCandidate[]
  relatedPath?: string
  cursorLine?: number
  preferNearbyAbove?: boolean
  limit?: number
  unitTestTarget?: boolean
}

export type SymbolScore = {
  score: number
  reasons: string[]
}

export function resolveSymbols(input: SymbolResolverInput): ResolvedSymbolCandidate[] {
  const query = normalizeIdent(input.query)
  if (!query) return []

  const relatedPath = input.relatedPath ? normalizePath(input.relatedPath) : undefined
  const relatedDir = relatedPath ? directoryPath(relatedPath) : undefined

  return input.candidates
    .map((candidate, index) => {
      const match = scoreSymbol(query, candidate.name)
      if (match.score <= 0) return

      const reasons = [...match.reasons]
      let score = match.score + sourceRank(candidate.source)
      score += Math.min(Math.max(candidate.score, 0), 100)

      const candidatePath = candidate.filePath ? normalizePath(candidate.filePath) : undefined
      if (candidatePath && relatedPath && candidatePath === relatedPath) {
        score += 250
        reasons.push("same-file")
        const nearby = nearbyAboveScore(candidate, input.cursorLine, Boolean(input.preferNearbyAbove))
        if (nearby > 0) {
          score += nearby
          reasons.push("nearby-above")
        }
      } else if (candidatePath && relatedDir && directoryPath(candidatePath) === relatedDir) {
        score += 120
        reasons.push("same-directory")
      }

      const kindBonus = symbolKindRank(candidate.kind, Boolean(input.unitTestTarget))
      if (kindBonus > 0) {
        score += kindBonus
        reasons.push(`kind:${candidate.kind}`)
      }

      return {
        ...candidate,
        score,
        matchScore: match.score,
        reasons,
        index,
      }
    })
    .filter((candidate): candidate is ResolvedSymbolCandidate & { index: number } => Boolean(candidate))
    .sort((left, right) =>
      right.score - left.score ||
      right.matchScore - left.matchScore ||
      symbolKindRank(right.kind, Boolean(input.unitTestTarget)) - symbolKindRank(left.kind, Boolean(input.unitTestTarget)) ||
      left.index - right.index ||
      left.name.localeCompare(right.name)
    )
    .slice(0, Math.max(1, Math.min(50, input.limit ?? 8)))
    .map(({ index: _index, ...candidate }) => candidate)
}

export function scoreSymbol(query: string, name: string): SymbolScore {
  const q = normalizeIdent(query)
  const n = normalizeIdent(name)
  if (!q || !n) return { score: 0, reasons: [] }

  if (q === n) return { score: 10000, reasons: ["exact"] }
  if (n.startsWith(q)) return { score: 9000, reasons: ["prefix"] }

  const qTokens = q.split("_").filter(Boolean)
  const nTokens = n.split("_").filter(Boolean)
  let score = 0
  let matched = 0
  let nameIndex = 0
  const reasons: string[] = []

  for (const queryToken of qTokens) {
    let found = false

    while (nameIndex < nTokens.length) {
      const nameToken = nTokens[nameIndex++]

      if (nameToken === queryToken) {
        score += 1000
        matched++
        found = true
        reasons.push(`token-exact:${queryToken}`)
        break
      }

      if (nameToken.startsWith(queryToken)) {
        score += 700
        matched++
        found = true
        reasons.push(`token-prefix:${queryToken}->${nameToken}`)
        break
      }

      if (isAbbrev(queryToken, nameToken)) {
        score += 500
        matched++
        found = true
        reasons.push(`token-abbrev:${queryToken}->${nameToken}`)
        break
      }
    }

    if (!found) {
      reasons.push(`missing:${queryToken}`)
    }
  }

  if (matched === qTokens.length && matched > 0) {
    return {
      score: score + matched * 50,
      reasons: reasons.some((reason) => reason.startsWith("token-abbrev")) ? [...reasons, "snake-abbrev"] : reasons,
    }
  }

  if (isAbbrev(q, n.replace(/_/g, ""))) {
    return { score: 350, reasons: ["subsequence"] }
  }

  return { score: 0, reasons }
}

export function isAbbrev(queryToken: string, nameToken: string) {
  const query = normalizeIdent(queryToken).replace(/_/g, "")
  const name = normalizeIdent(nameToken).replace(/_/g, "")
  if (!query || !name) return false
  if (name.startsWith(query)) return true

  let queryIndex = 0
  for (const char of name) {
    if (char === query[queryIndex]) queryIndex++
    if (queryIndex === query.length) return true
  }
  return false
}

export function symbolCandidateFromCodeGraph(symbol: CodeGraphSymbolCandidate): SymbolCandidate {
  return {
    name: symbol.name,
    kind: symbolKindFromCodeGraph(symbol.kind),
    signature: symbol.signature,
    filePath: symbol.path,
    line: symbol.startLine,
    score: symbol.score,
    snippet: symbol.snippet,
    source: "codeGraph",
  }
}

export function symbolCandidateFromRetrievedSnippet(snippet: RetrievedCompletionSnippet): SymbolCandidate | undefined {
  if (!snippet.name) return
  return {
    name: snippet.name,
    kind: symbolKindFromSnippet(snippet.kind),
    signature: snippet.text,
    filePath: snippet.path,
    line: snippet.line,
    score: snippet.score ?? 0,
    snippet: snippet.text,
    source: "retrievedSnippet",
  }
}

function normalizeIdent(input: string) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/").replace(/^\/+/, "")
}

function directoryPath(path: string) {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

function sourceRank(source: SymbolCandidateSource) {
  switch (source) {
    case "openDocument":
      return 50
    case "codeGraph":
      return 40
    case "workspace":
      return 30
    case "retrievedSnippet":
      return 20
  }
}

function nearbyAboveScore(candidate: SymbolCandidate, cursorLine: number | undefined, preferNearbyAbove: boolean) {
  if (!preferNearbyAbove || !cursorLine || !candidate.line || candidate.line >= cursorLine) return 0
  const distance = Math.max(0, cursorLine - candidate.line)
  return 2000 + Math.max(0, 1000 - distance)
}

function symbolKindRank(kind: SymbolCandidateKind, unitTestTarget: boolean) {
  switch (kind) {
    case "function":
    case "method":
      return unitTestTarget ? 500 : 80
    case "macro":
      return 60
    case "type":
      return 40
    case "variable":
      return 20
    case "unknown":
      return 0
  }
}

function symbolKindFromCodeGraph(kind: CodeGraphSymbolKind): SymbolCandidateKind {
  switch (kind) {
    case "function":
      return "function"
    case "macro":
      return "macro"
    case "type":
      return "type"
    case "global":
      return "variable"
    case "file":
      return "unknown"
  }
}

function symbolKindFromSnippet(kind: string): SymbolCandidateKind {
  const normalized = kind.toLowerCase()
  if (normalized.includes("function")) return "function"
  if (normalized.includes("method")) return "method"
  if (normalized.includes("macro")) return "macro"
  if (normalized.includes("type") || normalized.includes("struct") || normalized.includes("enum")) return "type"
  if (normalized.includes("global") || normalized.includes("variable")) return "variable"
  return "unknown"
}
