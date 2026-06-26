export type RuleAnchorMatch = {
  label: string
  kind: "规则" | "建议"
  number: string
  index: number
}

const RULE_ANCHOR_RE = /【\s*(规则|建议)\s*([0-9]+(?:[-.][0-9]+)*)\s*】/g
const SUBSECTION_HEADING_RE = /^\s*\d+(?:\.\d+)+\s+\S+/

export function findRuleAnchors(text: string): RuleAnchorMatch[] {
  const matches: RuleAnchorMatch[] = []
  for (const match of text.matchAll(RULE_ANCHOR_RE)) {
    const kind = match[1] === "建议" ? "建议" : "规则"
    const number = match[2] ?? ""
    matches.push({
      label: `${kind}${number}`,
      kind,
      number,
      index: match.index ?? 0,
    })
  }
  return matches
}

export function firstRuleAnchor(text: string | undefined): string | undefined {
  return findRuleAnchors(String(text ?? ""))[0]?.label
}

export function normalizeRuleAnchor(input: unknown): string | undefined {
  const value = String(input ?? "").trim()
  if (!value) return undefined
  const direct = value.match(/^(规则|建议)\s*([0-9]+(?:[-.][0-9]+)*)$/)
  if (direct) return `${direct[1]}${direct[2]}`
  const embedded = value.match(/(?:^|[>\s/])\s*(规则|建议)\s*([0-9]+(?:[-.][0-9]+)*)/)
  if (embedded) return `${embedded[1]}${embedded[2]}`
  return firstRuleAnchor(value)
}

export function splitTextByRuleAnchors(text: string): Array<{ sourceRuleAnchor: string; text: string }> {
  const anchors = findRuleAnchors(text)
  if (anchors.length === 0) return []
  const starts = anchors.map((anchor) => segmentStartForAnchor(text, anchor.index))
  return anchors.map((anchor, index) => {
    const start = starts[index] ?? anchor.index
    const end = starts[index + 1] ?? text.length
    return {
      sourceRuleAnchor: anchor.label,
      text: text.slice(start, end).trim(),
    }
  }).filter((segment) => segment.text.length > 0)
}

export function sourceRuleAnchorFromNeighborText(input: {
  text?: string
  previous?: string
}): string | undefined {
  return firstRuleAnchor(input.text) ?? firstRuleAnchor(input.previous)
}

function segmentStartForAnchor(text: string, anchorIndex: number) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, anchorIndex - 1)) + 1
  const previousLineStart = text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1
  const previousLine = text.slice(previousLineStart, lineStart).trim()
  return SUBSECTION_HEADING_RE.test(previousLine) ? previousLineStart : lineStart
}
