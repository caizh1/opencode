import { createHash } from "node:crypto"
import { sourceRuleAnchorFromNeighborText } from "./RuleAnchors"
import type {
  DocxReadBlock,
  PreservedBlock,
  ReferenceDocument,
  SourceBackedBlock,
  SourceBackedBlockKind,
  SourceExcerpt,
  SourcePreservationDecision,
  SourcePreservationPolicy,
  TableSpec,
} from "./types"

const MAX_BLOCKS_PER_DOCUMENT = 32
const SECTION_RESERVED_BLOCKS = 1

type PreservationCandidate = {
  block: DocxReadBlock
  preserved: PreservedBlock
  score: number
  sectionKey: string
  order: number
}

export type SourcePreservationResult = {
  preservedBlocks: PreservedBlock[]
  sourceBackedBlocks: SourceBackedBlock[]
  warnings: string[]
}

export class SourcePreservationExtractor {
  constructor(private readonly policy: SourcePreservationPolicy = defaultSourcePreservationPolicy) {}

  extract(documents: ReferenceDocument[]): SourcePreservationResult {
    const preservedBlocks: PreservedBlock[] = []
    const warnings: string[] = []
    for (const document of documents) {
      const candidates: PreservationCandidate[] = []
      for (const [index, block] of document.read.blocks.entries()) {
        const preserved = this.preserveBlock(document, block, block.blockIndex ?? index + 1)
        if (!preserved) continue
        if (preserved.warning) warnings.push(preserved.warning)
        candidates.push({
          block,
          preserved,
          score: preservationScore(document, block, preserved),
          sectionKey: majorSectionKey(block),
          order: block.blockIndex ?? index + 1,
        })
      }
      const selected = selectCandidates(candidates)
      preservedBlocks.push(...selected.map((item) => item.preserved))
      if (candidates.length > MAX_BLOCKS_PER_DOCUMENT) {
        const omitted = candidates
          .filter((candidate) => !selected.includes(candidate))
          .sort((left, right) => right.score - left.score || left.order - right.order)
          .slice(0, 5)
          .map((candidate) => candidate.block.headingPath.join(" > ") || "未命名章节")
        const omittedSummary = [...new Set(omitted)].slice(0, 4).join("；")
        warnings.push(`${document.read.metadata.path} 的可搬运来源块候选 ${candidates.length} 个，已按全篇章节覆盖和高价值信号择优保留 ${MAX_BLOCKS_PER_DOCUMENT} 个；此限制不影响规则抽取，可能影响原文示例/表格归位完整性。${omittedSummary ? ` 未纳入候选示例章节：${omittedSummary}。` : ""}`)
      }
    }
    return {
      preservedBlocks,
      sourceBackedBlocks: preservedBlocks.map(toSourceBackedBlock),
      warnings,
    }
  }

  private preserveBlock(document: ReferenceDocument, block: DocxReadBlock, index: number): PreservedBlock | undefined {
    if (block.kind === "heading") return undefined
    const rawText = block.text.trim()
    const normalizedText = normalizeForDisplay(block.text)
    if (!normalizedText || normalizedText.length < 12) return undefined
    const kind = blockKind(block)
    if (!isHighValueBlock(kind, block, normalizedText)) return undefined

    const decision = this.policy.decide({ document, block, kind, rawText, normalizedText })
    const source = sourceExcerpt(document, block, rawText, normalizedText)
    const limited = textForDecision(normalizedText, decision)
    const warning = [decision.warning, limited.warning].filter(Boolean).join("；") || undefined
    const base = {
      id: `${document.id}-preserved-${index}`,
      kind,
      title: blockTitle(block, kind),
      source,
      preserveMode: decision.preserveMode,
      warning,
    }

    if (kind === "table") {
      const table = decision.preserveMode === "verbatim-short" && decision.allowVerbatim !== false
        ? tableFromBlock(block, decision)
        : undefined
      return {
        ...base,
        table,
        text: table ? limited.text : summaryText(normalizedText, decision),
      }
    }

    if (kind === "list") {
      const items = decision.preserveMode === "verbatim-short" && decision.allowVerbatim !== false
        ? listItems(normalizedText).map((item) => textForDecision(item, decision).text).filter(Boolean)
        : [summaryText(normalizedText, decision)]
      if (items.length === 0) return undefined
      return {
        ...base,
        items,
        text: items.join("\n"),
      }
    }

    if ((kind === "code" || kind === "example") && decision.preserveMode === "verbatim-short" && decision.allowVerbatim !== false) {
      const code = codeFromText(rawText) || limited.text
      return {
        ...base,
        text: codeFromText(rawText) ? undefined : limited.text,
        code: codeFromText(rawText) ? { caption: blockTitle(block, kind), code: textForDecision(code, decision).text } : undefined,
      }
    }

    return {
      ...base,
      text: summaryText(normalizedText, decision),
    }
  }
}

function selectCandidates(candidates: PreservationCandidate[]) {
  if (candidates.length <= MAX_BLOCKS_PER_DOCUMENT) return candidates.sort(byOrder)
  const selected = new Set<PreservationCandidate>()
  const bySection = new Map<string, PreservationCandidate[]>()
  for (const candidate of candidates) {
    const group = bySection.get(candidate.sectionKey) ?? []
    group.push(candidate)
    bySection.set(candidate.sectionKey, group)
  }
  const sectionGroups = [...bySection.values()]
    .map((group) => group.sort(byScore))
    .sort((left, right) => left[0]!.order - right[0]!.order)
  const reservedGroups = sectionGroups.length > MAX_BLOCKS_PER_DOCUMENT
    ? evenlySampledGroups(sectionGroups, MAX_BLOCKS_PER_DOCUMENT)
    : sectionGroups
  for (const group of reservedGroups) {
    if (selected.size >= MAX_BLOCKS_PER_DOCUMENT) break
    for (const candidate of group.slice(0, SECTION_RESERVED_BLOCKS)) {
      selected.add(candidate)
      if (selected.size >= MAX_BLOCKS_PER_DOCUMENT) break
    }
  }
  for (const candidate of candidates.sort(byScore)) {
    if (selected.size >= MAX_BLOCKS_PER_DOCUMENT) break
    selected.add(candidate)
  }
  return [...selected].sort(byOrder)
}

function evenlySampledGroups(groups: PreservationCandidate[][], count: number) {
  if (groups.length <= count) return groups
  if (count <= 1) return [groups[0]!]
  const selected: PreservationCandidate[][] = []
  const used = new Set<number>()
  for (let slot = 0; slot < count; slot++) {
    const index = Math.round(slot * (groups.length - 1) / (count - 1))
    if (!used.has(index)) {
      selected.push(groups[index]!)
      used.add(index)
    }
  }
  for (let index = 0; selected.length < count && index < groups.length; index++) {
    if (!used.has(index)) selected.push(groups[index]!)
  }
  return selected.sort((left, right) => left[0]!.order - right[0]!.order)
}

function byScore(left: PreservationCandidate, right: PreservationCandidate) {
  return right.score - left.score || left.order - right.order
}

function byOrder(left: PreservationCandidate, right: PreservationCandidate) {
  return left.order - right.order
}

function preservationScore(document: ReferenceDocument, block: DocxReadBlock, preserved: PreservedBlock) {
  const text = `${block.headingPath.join(" ")} ${block.text}`
  let score = 0
  if (preserved.kind === "code" || preserved.kind === "example") score += 120
  else if (preserved.kind === "table") score += 110
  else if (preserved.kind === "list") score += 82
  else if (preserved.kind === "quote") score += 70
  else score += 46
  if (document.sourceOrigin === "internal_company") score += 24
  if (sourceRuleAnchorFromNeighborText({ text: block.text, previous: block.neighborTextPreview?.previous })) score += 36
  if (/(?:示例|例如|推荐写法|不推荐写法|正确示例|错误示例|example)/i.test(text)) score += 24
  if (/(?:必须|不得|禁止|应该|建议|shall|must|should|required|avoid)/i.test(text)) score += 16
  if (/(?:理由|风险|例外|review|checklist|检查项)/i.test(text)) score += 8
  return score
}

function majorSectionKey(block: DocxReadBlock) {
  return block.headingPath.join("\u0000") || "__root__"
}

const defaultSourcePreservationPolicy: SourcePreservationPolicy = {
  decide(input) {
    return {
      preserveMode: input.kind === "code" || input.kind === "example" ? "adapted-example" : "summarized",
      charLimit: 240,
      wordLimit: 80,
      allowVerbatim: false,
      note: "使用默认来源保留策略，仅保留摘要和来源追溯。",
    }
  },
}

function toSourceBackedBlock(block: PreservedBlock): SourceBackedBlock {
  return {
    id: block.id,
    kind: block.kind,
    title: block.title,
    text: block.text,
    items: block.items,
    table: block.table,
    codeBlock: block.code,
    source: block.source,
    preserveMode: block.preserveMode,
    note: block.warning ? `${preserveModeNote(block.preserveMode)} ${block.warning}` : preserveModeNote(block.preserveMode),
  }
}

function sourceExcerpt(document: ReferenceDocument, block: DocxReadBlock, rawText: string, normalizedText: string): SourceExcerpt {
  const sourceRuleAnchor = sourceRuleAnchorFromNeighborText({
    text: normalizedText,
    previous: block.neighborTextPreview?.previous,
  })
  return {
    sourceId: document.id,
    sourceName: document.read.metadata.title,
    sourceTitle: document.read.metadata.title,
    sourcePath: document.read.metadata.path,
    sourceRole: document.role,
    sourceOrigin: document.sourceOrigin,
    sourceRuleAnchor,
    headingPath: block.headingPath,
    sourceLocation: {
      ...block.sourceLocation,
      sourceRuleAnchor: sourceRuleAnchor ?? block.sourceLocation.sourceRuleAnchor,
    },
    sourceBlockId: block.sourceBlockId,
    blockIndex: block.blockIndex,
    sectionBlockIndex: block.sectionBlockIndex,
    neighborTextPreview: block.neighborTextPreview,
    originalBlockHash: {
      rawHash: sha256(rawText),
      normalizedHash: sha256(normalizeForHash(normalizedText)),
    },
  }
}

function blockKind(block: DocxReadBlock): SourceBackedBlockKind {
  if (block.kind === "table") return "table"
  if (block.kind === "list") return isExampleText(`${block.headingPath.join(" ")} ${block.text}`) ? "example" : "list"
  if (isQuote(block)) return "quote"
  if (looksLikeCode(block.text)) return "code"
  if (isExampleText(`${block.headingPath.join(" ")} ${block.text}`)) return "example"
  return "paragraph"
}

function isHighValueBlock(kind: SourceBackedBlockKind, block: DocxReadBlock, text: string) {
  if (kind === "table" || kind === "code" || kind === "example" || kind === "quote") return true
  if (kind === "list") return listItems(text).length > 0
  return /(?:必须|不得|禁止|应该|建议|shall|must|should|required|avoid|原则|理由|风险|例外|review|checklist)/i.test(`${block.headingPath.join(" ")} ${text}`)
}

function tableFromBlock(block: DocxReadBlock, decision: SourcePreservationDecision): TableSpec | undefined {
  const rows = block.text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:header|row\s+\d+):\s*/i, "").split("|").map((cell) => textForDecision(cell.trim(), decision).text).filter(Boolean))
    .filter((cells) => cells.length > 0)
  if (rows.length === 0) return undefined
  const headers = rows[0]!
  return {
    caption: block.label,
    headers,
    rows: rows.slice(1).map((row) => headers.map((_, index) => row[index] ?? "")),
  }
}

function listItems(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean)
}

function textForDecision(text: string, decision: SourcePreservationDecision) {
  const normalized = normalizeForDisplay(text)
  if (decision.preserveMode !== "verbatim-short" || decision.allowVerbatim === false) {
    return { text: summaryText(normalized, decision), warning: undefined as string | undefined }
  }
  const limited = limitText(normalized, decision)
  return {
    text: limited.text,
    warning: limited.truncated ? "短摘录超过策略限制，已截断保留。" : undefined,
  }
}

function summaryText(text: string, decision: SourcePreservationDecision) {
  const first = firstSentence(text)
  if (decision.preserveMode === "adapted-example") return `来源示例要点：${first}`
  if (decision.preserveMode === "paraphrased") return `来源改写要点：${first}`
  return `来源摘要：${first}`
}

function limitText(text: string, decision: SourcePreservationDecision) {
  const charLimit = decision.charLimit ?? 240
  const wordLimit = decision.wordLimit ?? 80
  if (isMostlyAscii(text)) {
    const words = text.split(/\s+/)
    if (words.length <= wordLimit) return { text, truncated: false }
    return { text: `${words.slice(0, wordLimit).join(" ")}\n[short excerpt truncated]`, truncated: true }
  }
  if (text.length <= charLimit) return { text, truncated: false }
  return { text: `${text.slice(0, charLimit)}\n[短摘录已截断]`, truncated: true }
}

function preserveModeNote(mode: SourcePreservationDecision["preserveMode"]) {
  if (mode === "verbatim-short") return "短摘录保留，用于追溯来源。"
  if (mode === "adapted-example") return "示例需按目标文档语境改写后使用。"
  if (mode === "summarized") return "来源内容已摘要化，避免复制完整原文。"
  return "来源内容已改写保留，避免复制完整原文。"
}

function blockTitle(block: DocxReadBlock, kind: SourceBackedBlockKind) {
  const heading = block.headingPath.at(-1)
  if (kind === "table") return block.label || (heading ? `${heading} 表格` : "来源表格")
  if (kind === "code") return heading ? `${heading} 代码片段` : "来源代码片段"
  if (kind === "example") return heading ? `${heading} 示例` : "来源示例"
  if (kind === "quote") return heading ? `${heading} 关键摘录` : "关键摘录"
  return heading ? `${heading} 摘录` : "来源摘录"
}

function looksLikeCode(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (lines.length === 1) return /(?:\/\/\/|\/\*|\*\/|#include|#define|;|[{}=()<>]|\b(?:if|for|while|return|switch|case|typedef|struct|enum|const|static|volatile)\b)/.test(lines[0]!)
  const codeLike = lines.filter((line) => /(?:\/\/\/|[{};=()<>]|\b(if|for|while|return|switch|case|class|function|def|const|let|var|typedef|struct|enum|volatile)\b)/.test(line)).length
  return codeLike >= Math.max(2, Math.ceil(lines.length * 0.45))
}

function codeFromText(text: string) {
  return looksLikeCode(text) ? normalizeForDisplay(text) : ""
}

function isExampleText(text: string) {
  return /(?:示例|例如|例子|用例|推荐写法|不推荐写法|正确示例|错误示例|good\s+example|bad\s+example|example)/i.test(text)
}

function isQuote(block: DocxReadBlock) {
  return block.kind === "note" || /(?:引用|原文|quote)/i.test(`${block.label ?? ""} ${block.headingPath.join(" ")} ${block.text}`)
}

function firstSentence(text: string) {
  const normalized = normalizeForDisplay(text)
  const sentence = normalized.split(/[。.!?]\s*/)[0]?.trim() || normalized
  return limitText(sentence, { preserveMode: "verbatim-short", charLimit: 200, wordLimit: 60, allowVerbatim: true }).text
}

function normalizeForDisplay(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

function normalizeForHash(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t\n]+/g, " ").trim()
}

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function isMostlyAscii(text: string) {
  if (!text) return false
  const ascii = [...text].filter((char) => char.charCodeAt(0) <= 127).length
  return ascii / text.length > 0.8
}
