import type { ResolvedSymbolCandidate } from "./completion-symbol"
import type { RetrievedCompletionSnippet } from "./completion-types"

export function completionSnippetFromSymbol(symbol: ResolvedSymbolCandidate): RetrievedCompletionSnippet {
  const path = symbol.filePath ?? ""
  return {
    kind: completionSnippetKind(symbol.name, path, symbol.kind),
    path,
    line: symbol.line ?? 1,
    name: symbol.name,
    text: preferredSymbolText(symbol),
    score: symbol.score,
  }
}

function completionSnippetKind(name: string, path: string, kind: string) {
  return /(?:^|[\\/._-])(?:test|tests|spec|mock|fixture)(?:[\\/._-]|$)/i.test(path) || /test|spec|mock|fixture/i.test(name)
    ? "existing test"
    : kind
}

function preferredSymbolText(symbol: ResolvedSymbolCandidate) {
  return symbol.snippet?.trim() || symbol.signature?.trim() || symbol.name
}
