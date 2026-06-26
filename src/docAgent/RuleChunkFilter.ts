import type { ReferenceChunk } from "./types"

export type RuleChunkSkip = {
  chunk: ReferenceChunk
  reason: string
}

export type RuleChunkFilterResult = {
  modelChunks: ReferenceChunk[]
  skippedChunks: RuleChunkSkip[]
  skipReasons: Record<string, number>
}

const RULE_SIGNAL_RE = /(?:【\s*(?:规则|建议)|必须|不得|禁止|应该|建议|应当|需要|shall|must|should|avoid|required|recommended|禁止使用|不应)/i
const LOW_VALUE_HEADING_RE = /(?:目录|修订|版本|变更记录|封面|references?|参考资料|引用|revision|history|cover|contents?)/i

export class RuleChunkFilter {
  filter(chunks: ReferenceChunk[]): RuleChunkFilterResult {
    const modelChunks: ReferenceChunk[] = []
    const skippedChunks: RuleChunkSkip[] = []
    for (const chunk of chunks) {
      const reason = skipReason(chunk)
      if (reason) skippedChunks.push({ chunk, reason })
      else modelChunks.push(chunk)
    }
    return {
      modelChunks,
      skippedChunks,
      skipReasons: skippedChunks.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1
        return acc
      }, {}),
    }
  }
}

function skipReason(chunk: ReferenceChunk) {
  const text = normalize(chunk.text)
  const heading = chunk.headingPath.join(" ")
  if (!text) return "empty"
  if (LOW_VALUE_HEADING_RE.test(heading) && !RULE_SIGNAL_RE.test(text)) return "low-value-section"
  if (looksLikeToc(text)) return "table-of-contents"
  if (text.length < 24 && !RULE_SIGNAL_RE.test(text)) return "too-short"
  if (!RULE_SIGNAL_RE.test(text) && weakRuleSignal(text) < 2) return "no-rule-signal"
  return undefined
}

function looksLikeToc(text: string) {
  const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 3) return false
  const tocLike = lines.filter((line) => /\.{2,}\s*\d+$/.test(line) || /\s+\d+$/.test(line)).length
  return tocLike / lines.length >= 0.6
}

function weakRuleSignal(text: string) {
  let score = 0
  if (/[。.;；]\s*(?:必须|应该|建议|禁止|不得|需要|shall|must|should)/i.test(text)) score += 1
  if (/【\s*(?:规则|建议)\s*[0-9]+(?:[-.][0-9]+)*\s*】/i.test(text)) score += 2
  if (/(?:规则|规范|要求|原则|checklist|guideline|standard)/i.test(text)) score += 1
  if (/(?:推荐写法|不推荐写法|good example|bad example|示例)/i.test(text)) score += 1
  return score
}

function normalize(input: string) {
  return input.replace(/\s+/g, " ").trim()
}
