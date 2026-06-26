import { SOURCE_BLOCK_PLACEMENT_VERSION, stableHash, type SourceBlockPlacementCache } from "./SourceBlockPlacementCache"
import { containsUntranslatedEnglishText } from "./RuleLanguage"
import type { DocAgentModelProvider, DocumentPlan, GeneratedExampleSpec, RuleCardSpec, SourceBackedBlock, SourceDerivedItemSpec } from "./types"

type PlacementKind = "rule-explanation" | "recommended" | "discouraged" | "preserved-example" | "rationale" | "exception" | "checklist" | "unassigned"

type PlacementJson = {
  placements?: Array<{
    blockId?: string
    targetRuleId?: string
    placement?: PlacementKind
    confidence?: number
    reason?: string
    label?: string
  }>
  warnings?: string[]
}

export type SourceBlockPlacementDecision = {
  blockId: string
  targetRuleId: string
  placement: PlacementKind
  confidence: number
  reason?: string
  label?: string
  decisionSource?: "deterministic" | "cache" | "model"
}

export type SourceBlockPlacementCandidate = {
  block: SourceBackedBlock
  relevantRules: RuleCardSpec[]
  cacheKey: string
}

export type SourceBlockPlacementValidator = (input: {
  rule: RuleCardSpec
  block: SourceBackedBlock
  placement: SourceBlockPlacementDecision
}) => { ok: boolean; warning?: string }

type PlacementBatch = {
  blocks: SourceBackedBlock[]
  rules: RuleCardSpec[]
  candidates: SourceBlockPlacementCandidate[]
}

export type SourceBlockPlacementResult = {
  rules: RuleCardSpec[]
  assignedBlockIds: string[]
  warnings: string[]
}

export type SourceBlockPlacementProgress = {
  stage: "skipped" | "preplace" | "cache" | "batch-start" | "batch-success" | "batch-warning" | "complete"
  message: string
  batchIndex?: number
  totalBatches?: number
  blockCount?: number
  placementCount?: number
  cacheHitCount?: number
  skippedCount?: number
  assignedCount?: number
  warningCount?: number
  warning?: string
}

const MIN_CONFIDENCE = 0.55
const MAX_BLOCKS_PER_BATCH = 8
const MAX_RULES_PER_BATCH = 6
const MAX_PROMPT_CHARS_PER_BATCH = 10 * 1024
const MAX_PRESERVED_EXAMPLES_PER_RULE = 4

export class SourceBlockPlacementPlanner {
  constructor(
    private readonly model?: DocAgentModelProvider,
    private readonly options: { cache?: SourceBlockPlacementCache; modelName?: string; validatePlacement?: SourceBlockPlacementValidator } = {},
  ) {}

  async apply(input: {
    question: string
    plan?: DocumentPlan
    rules: RuleCardSpec[]
    blocks: SourceBackedBlock[]
    signal?: AbortSignal
    log?: (message: string) => void
    onProgress?: (progress: SourceBlockPlacementProgress) => void
  }): Promise<SourceBlockPlacementResult> {
    if (input.rules.length === 0 || input.blocks.length === 0) {
      const assignedBlockIds = assignedBlockIdsFromRules(input.rules)
      input.onProgress?.({
        stage: "skipped",
        message: input.rules.length === 0
            ? "来源块语义归位跳过：没有可归位规则"
            : "来源块语义归位跳过：没有待归位来源块",
        assignedCount: assignedBlockIds.length,
      })
      return { rules: input.rules, assignedBlockIds, warnings: [] }
    }
    const warnings: string[] = []
    const placements: SourceBlockPlacementDecision[] = []
    const relevantBlocks = input.blocks.filter(highValuePlacementBlock)
    const skippedCount = input.blocks.length - relevantBlocks.length
    const modelName = this.options.modelName ?? this.model?.cacheKey?.() ?? "unknown-model"
    const preplaced = preplaceDeterministic(input.rules, relevantBlocks)
    placements.push(...preplaced.placements)
    input.onProgress?.({
      stage: "preplace",
      message: `来源块确定性预归位：${preplaced.placements.length} 个直接归位 · ${preplaced.remaining.length} 个待判断 · ${skippedCount} 个低价值块跳过`,
      blockCount: relevantBlocks.length,
      placementCount: preplaced.placements.length,
      skippedCount,
    })
    input.log?.(`[doc-agent] source placement preplace: total=${input.blocks.length}; relevant=${relevantBlocks.length}; deterministic=${preplaced.placements.length}; skipped=${skippedCount}; remaining=${preplaced.remaining.length}`)

    const cache = this.options.cache
    const cacheWarnings: string[] = []
    const cachedPlacements: SourceBlockPlacementDecision[] = []
    const pendingCandidates: SourceBlockPlacementCandidate[] = []
    for (const candidate of preplaced.remaining.map((candidate) => withCacheKey(candidate, input.plan, modelName))) {
      input.signal?.throwIfAborted()
      if (!cache) {
        pendingCandidates.push(candidate)
        continue
      }
      try {
        const entry = await cache.get(candidate.cacheKey)
        const cached = placementFromCacheEntry(candidate, entry, input.rules)
        if (cached) cachedPlacements.push(cached)
        else pendingCandidates.push(candidate)
      } catch (error) {
        cacheWarnings.push(`来源块归位缓存读取失败，已转模型归位：${error instanceof Error ? error.message : String(error)}`)
        pendingCandidates.push(candidate)
      }
    }
    placements.push(...cachedPlacements)
    for (const warning of cache?.drainWarnings?.() ?? []) cacheWarnings.push(warning)
    warnings.push(...cacheWarnings)
    input.onProgress?.({
      stage: "cache",
      message: `来源块归位缓存：命中 ${cachedPlacements.length} 个 · 待模型判断 ${pendingCandidates.length} 个`,
      cacheHitCount: cachedPlacements.length,
      blockCount: pendingCandidates.length,
      warningCount: cacheWarnings.length,
      warning: cacheWarnings.join("\n") || undefined,
    })
    input.log?.(`[doc-agent] source placement cache: hits=${cachedPlacements.length}; pending=${pendingCandidates.length}; warnings=${cacheWarnings.length}`)

    if (!this.model || pendingCandidates.length === 0) {
      if (!this.model && pendingCandidates.length > 0) input.log?.("[doc-agent] source placement model skipped: no model provider")
      const result = applyPlacements(input.rules, input.blocks, placements, warnings, new Set(relevantBlocks.map((block) => block.id)), this.options.validatePlacement)
      input.onProgress?.({
        stage: "complete",
        message: `来源块语义归位完成：归入 ${result.assignedBlockIds.length} 个来源块 · warning ${result.warnings.length} 条`,
        assignedCount: result.assignedBlockIds.length,
        warningCount: result.warnings.length,
      })
      return result
    }

    const batches = placementBatches(pendingCandidates)
    for (const [index, batch] of batches.entries()) {
      const batchIndex = index + 1
      input.signal?.throwIfAborted()
      input.onProgress?.({
        stage: "batch-start",
        message: `来源块语义归位：第 ${batchIndex}/${batches.length} 批 · ${batch.blocks.length} 个来源块 · ${batch.rules.length} 条相关规则`,
        batchIndex,
        totalBatches: batches.length,
        blockCount: batch.blocks.length,
      })
      try {
        const planned = await planBatchWithRecovery({
          batch,
          batchLabel: `${batchIndex}/${batches.length}`,
          cache,
          input,
          model: this.model,
          modelName,
          validatePlacement: this.options.validatePlacement,
        })
        const normalized = planned.placements
        placements.push(...normalized)
        warnings.push(...planned.warnings)
        input.onProgress?.({
          stage: planned.warnings.length ? "batch-warning" : "batch-success",
          message: `来源块语义归位完成：第 ${batchIndex}/${batches.length} 批 · ${normalized.length} 条归位建议`,
          batchIndex,
          totalBatches: batches.length,
          blockCount: batch.blocks.length,
          placementCount: normalized.length,
          warningCount: planned.warnings.length,
          warning: planned.warnings.join("\n") || undefined,
        })
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error
        const warning = `来源块语义归位失败，已保留原规则内容并跳过该批来源块：${error instanceof Error ? error.message : String(error)}`
        warnings.push(warning)
        input.onProgress?.({
          stage: "batch-warning",
          message: `来源块语义归位失败：第 ${batchIndex}/${batches.length} 批`,
          batchIndex,
          totalBatches: batches.length,
          blockCount: batch.blocks.length,
          warningCount: 1,
          warning,
        })
      }
    }
    const result = applyPlacements(input.rules, input.blocks, placements, warnings, new Set(relevantBlocks.map((block) => block.id)), this.options.validatePlacement)
    input.onProgress?.({
      stage: "complete",
      message: `来源块语义归位完成：归入 ${result.assignedBlockIds.length} 个来源块 · warning ${result.warnings.length} 条`,
      assignedCount: result.assignedBlockIds.length,
      warningCount: result.warnings.length,
    })
    return result
  }
}

function preplaceDeterministic(rules: RuleCardSpec[], blocks: SourceBackedBlock[]): { placements: SourceBlockPlacementDecision[]; remaining: Array<Omit<SourceBlockPlacementCandidate, "cacheKey">> } {
  const placements: SourceBlockPlacementDecision[] = []
  const remaining: Array<Omit<SourceBlockPlacementCandidate, "cacheKey">> = []
  for (const block of blocks) {
    const match = deterministicRuleMatch(block, rules)
    if (match && (block.source.sourceOrigin === "internal_company" || (block.contentKind === "example" && match.reason.includes("唯一匹配")))) {
      const placementKind = deterministicPlacementKind(block)
      if (!placementKind) {
        remaining.push({
          block,
          relevantRules: relatedRulesForBlock(block, rules),
        })
        continue
      }
      placements.push({
        blockId: block.id,
        targetRuleId: match.rule.ruleId,
        placement: placementKind,
        confidence: match.confidence,
        reason: match.reason,
        label: labelForPlacement(placementKind),
        decisionSource: "deterministic",
      })
      continue
    }
    remaining.push({
      block,
      relevantRules: relatedRulesForBlock(block, rules),
    })
  }
  return { placements, remaining }
}

function withCacheKey(candidate: Omit<SourceBlockPlacementCandidate, "cacheKey">, plan: DocumentPlan | undefined, modelName: string): SourceBlockPlacementCandidate {
  return {
    ...candidate,
    cacheKey: placementCacheKey(candidate.block, candidate.relevantRules, plan, modelName),
  }
}

function placementFromCacheEntry(candidate: SourceBlockPlacementCandidate, entry: Awaited<ReturnType<NonNullable<SourceBlockPlacementCache["get"]>>>, rules: RuleCardSpec[]): SourceBlockPlacementDecision | undefined {
  if (!entry || entry.plannerVersion !== SOURCE_BLOCK_PLACEMENT_VERSION) return undefined
  const placement = normalizePlacement(entry.placement)
  if (placement === "unassigned" || entry.confidence < MIN_CONFIDENCE) return undefined
  if (!rules.some((rule) => rule.ruleId === entry.targetRuleId)) return undefined
  return {
    blockId: candidate.block.id,
    targetRuleId: entry.targetRuleId,
    placement,
    confidence: entry.confidence,
    reason: entry.reason || "来源块归位缓存命中。",
    label: entry.label,
    decisionSource: "cache",
  }
}

async function writeModelPlacementsToCache(
  cache: SourceBlockPlacementCache | undefined,
  modelName: string,
  batch: { candidates: SourceBlockPlacementCandidate[] },
  placements: SourceBlockPlacementDecision[],
  rules: RuleCardSpec[],
  log?: (message: string) => void,
) {
  if (!cache) return
  const byBlock = new Map(batch.candidates.map((candidate) => [candidate.block.id, candidate]))
  for (const placement of placements) {
    const candidate = byBlock.get(placement.blockId)
    if (!candidate || placement.placement === "unassigned" || placement.confidence < MIN_CONFIDENCE) continue
    if (!rules.some((rule) => rule.ruleId === placement.targetRuleId)) continue
    try {
      await cache.set(candidate.cacheKey, {
        modelName,
        targetRuleId: placement.targetRuleId,
        placement: placement.placement,
        confidence: placement.confidence,
        reason: placement.reason,
        label: placement.label,
      })
    } catch (error) {
      log?.(`[doc-agent] source placement cache write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function planBatchWithRecovery(input: {
  batch: PlacementBatch
  batchLabel: string
  cache?: SourceBlockPlacementCache
  input: {
    question: string
    plan?: DocumentPlan
    signal?: AbortSignal
    log?: (message: string) => void
  }
  model: DocAgentModelProvider
  modelName: string
  validatePlacement?: SourceBlockPlacementValidator
  depth?: number
}): Promise<{ placements: SourceBlockPlacementDecision[]; warnings: string[] }> {
  try {
    return await runPlacementBatch(input)
  } catch (error) {
    if (input.input.signal?.aborted || isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (input.batch.candidates.length <= 1) {
      const block = input.batch.blocks[0]
      return {
        placements: [],
        warnings: [`来源块语义归位失败，已跳过该来源块：${block ? sourceLabel(block) : input.batchLabel}；${message}`],
      }
    }
    const [left, right] = splitPlacementBatch(input.batch)
    input.input.log?.(`[doc-agent] source placement batch split retry: batch=${input.batchLabel}; blocks=${input.batch.blocks.length}; left=${left.blocks.length}; right=${right.blocks.length}; reason=${message}`)
    const splitWarning = /finish_reason=length|responseBytes=0|valid JSON|JSON\.parse/i.test(message)
      ? `来源块语义归位批次输出被截断或 JSON 无效，已缩小批次重试：${input.batchLabel}。`
      : ""
    const leftResult = await planBatchWithRecovery({ ...input, batch: left, batchLabel: `${input.batchLabel}.1`, depth: (input.depth ?? 0) + 1 })
    const rightResult = await planBatchWithRecovery({ ...input, batch: right, batchLabel: `${input.batchLabel}.2`, depth: (input.depth ?? 0) + 1 })
    return {
      placements: [...leftResult.placements, ...rightResult.placements],
      warnings: [...new Set([splitWarning, ...leftResult.warnings, ...rightResult.warnings].filter(Boolean))],
    }
  }
}

async function runPlacementBatch(input: {
  batch: PlacementBatch
  batchLabel: string
  cache?: SourceBlockPlacementCache
  input: {
    question: string
    plan?: DocumentPlan
    signal?: AbortSignal
    log?: (message: string) => void
  }
  model: DocAgentModelProvider
  modelName: string
  validatePlacement?: SourceBlockPlacementValidator
}): Promise<{ placements: SourceBlockPlacementDecision[]; warnings: string[] }> {
  const prompt = placementPrompt({
    question: input.input.question,
    plan: input.input.plan,
    rules: input.batch.rules,
    blocks: input.batch.blocks,
  })
  input.input.log?.(`[doc-agent] planning source block placement: batch=${input.batchLabel}; blocks=${input.batch.blocks.length}; rules=${input.batch.rules.length}; promptBytes=${Buffer.byteLength(prompt, "utf8")}`)
  const result = await input.model.completeJson<PlacementJson>({
    purpose: "plan-source-block-placement",
    system: "Place source-backed blocks into rule cards. Return JSON only. Output only assigned placements; omit unassigned blocks and never use empty targetRuleId.",
    prompt,
  }, input.input.signal)
  const normalized = validatePlacementsForBatch(
    normalizePlacements(result.placements ?? []).map((placement) => ({ ...placement, decisionSource: "model" as const })),
    input.batch,
    input.validatePlacement,
  )
  await writeModelPlacementsToCache(input.cache, input.modelName, input.batch, normalized.placements, input.batch.rules, input.input.log)
  return { placements: normalized.placements, warnings: [...(result.warnings ?? []), ...normalized.warnings] }
}

function splitPlacementBatch(batch: PlacementBatch): [PlacementBatch, PlacementBatch] {
  const midpoint = Math.max(1, Math.floor(batch.candidates.length / 2))
  return [batchFromCandidates(batch.candidates.slice(0, midpoint)), batchFromCandidates(batch.candidates.slice(midpoint))]
}

function batchFromCandidates(candidates: SourceBlockPlacementCandidate[]): PlacementBatch {
  return {
    candidates,
    blocks: candidates.map((candidate) => candidate.block),
    rules: unionRules([], candidates.flatMap((candidate) => candidate.relevantRules)).slice(0, MAX_RULES_PER_BATCH),
  }
}

function placementCacheKey(block: SourceBackedBlock, rules: RuleCardSpec[], plan: DocumentPlan | undefined, modelName: string) {
  const blockHash = block.source.originalBlockHash?.normalizedHash || stableHash(blockText(block))
  const ruleHash = stableHash(rules.map(ruleDigest).join("\n"))
  const planHash = stableHash(JSON.stringify({
    documentType: plan?.documentType,
    language: plan?.output.language,
    ruleCardPolicy: plan?.ruleCardPolicy,
    sourcePolicy: plan?.sourcePolicy,
  }))
  return [
    SOURCE_BLOCK_PLACEMENT_VERSION,
    modelName || "unknown-model",
    block.source.sourceId,
    block.source.sourceOrigin ?? "unknown",
    block.source.sourceRole ?? "unknown",
    block.source.headingPath.join(">"),
    block.source.sourceRuleAnchor ?? "no-anchor",
    blockHash,
    ruleHash,
    planHash,
  ].join(":")
}

function placementPrompt(input: {
  question: string
  plan?: DocumentPlan
  rules: RuleCardSpec[]
  blocks: SourceBackedBlock[]
}) {
  return JSON.stringify({
    task: "把来源块归位到最相关的规则卡。只返回需要归位的块；无法判断的块直接省略，不要输出 unassigned。",
    question: input.question.slice(0, 500),
    documentPlan: input.plan ? {
      language: input.plan.output.language,
      title: input.plan.output.title,
      ruleCardPolicy: input.plan.ruleCardPolicy,
    } : undefined,
    allowedPlacement: ["rule-explanation", "recommended", "discouraged", "preserved-example", "rationale", "exception", "checklist"],
    rules: input.rules.map((rule) => ({
      ruleId: rule.ruleId,
      name: rule.name,
      sourceRuleAnchor: rule.sourceRuleAnchor,
      scope: rule.scope,
      description: rule.description,
      recommended: rule.recommended?.slice(0, 180),
      discouraged: rule.discouraged?.slice(0, 180),
      sources: rule.sources.slice(0, 3),
    })),
    blocks: input.blocks.map((block) => ({
      blockId: block.id,
      sourceBlockId: block.source.sourceBlockId,
      kind: block.kind,
      title: block.title?.slice(0, 80),
      textPreview: blockText(block).slice(0, 500),
      sourceOrigin: block.source.sourceOrigin,
      sourceRole: block.source.sourceRole,
      sourceRuleAnchor: block.source.sourceRuleAnchor,
      headingPath: block.source.headingPath,
      blockIndex: block.source.blockIndex,
      sectionBlockIndex: block.source.sectionBlockIndex,
      previous: block.source.neighborTextPreview?.previous?.slice(0, 120),
      next: block.source.neighborTextPreview?.next?.slice(0, 120),
    })),
    outputRules: [
      "只输出 placements 数组；省略无法归位的 block。",
      "targetRuleId 必须是输入 rules 中的 ruleId，不能留空。",
      "reason 和 label 必须是短中文，reason 不超过 30 个字。",
    ],
    outputShape: {
      placements: [{
        blockId: "",
        targetRuleId: "",
        placement: "preserved-example",
        confidence: 0.9,
        reason: "语义匹配该规则",
        label: "内部示例",
      }],
      warnings: [],
    },
  })
}

function placementBatches(candidates: SourceBlockPlacementCandidate[]) {
  const sorted = [...candidates].sort((left, right) => {
    const source = left.block.source.sourceId.localeCompare(right.block.source.sourceId)
    if (source !== 0) return source
    return (left.block.source.blockIndex ?? 0) - (right.block.source.blockIndex ?? 0)
  })
  const batches: PlacementBatch[] = []
  let current: SourceBlockPlacementCandidate[] = []
  let currentRules: RuleCardSpec[] = []
  let currentSourceId = ""

  const flush = () => {
    if (current.length === 0) return
    batches.push(batchFromCandidates(current))
    current = []
    currentRules = []
    currentSourceId = ""
  }

  for (const candidate of sorted) {
    const candidateRules = candidate.relevantRules.slice(0, MAX_RULES_PER_BATCH)
    const nextRules = unionRules(currentRules, candidateRules).slice(0, MAX_RULES_PER_BATCH)
    const nextCandidates = [...current, candidate]
    const nextSourceId = candidate.block.source.sourceId
    const sourceChanged = currentSourceId && currentSourceId !== nextSourceId
    const promptTooLarge = placementPrompt({
      question: "",
      rules: nextRules,
      blocks: nextCandidates.map((item) => item.block),
    }).length > MAX_PROMPT_CHARS_PER_BATCH
    if (current.length > 0 && (sourceChanged || nextCandidates.length > MAX_BLOCKS_PER_BATCH || nextRules.length > MAX_RULES_PER_BATCH || promptTooLarge)) {
      flush()
    }
    current.push(candidate)
    currentRules = unionRules(currentRules, candidateRules).slice(0, MAX_RULES_PER_BATCH)
    currentSourceId = nextSourceId
  }
  flush()
  return batches
}

function highValuePlacementBlock(block: SourceBackedBlock) {
  if (block.kind === "code" || block.kind === "example" || block.kind === "table" || block.kind === "list" || block.kind === "quote") return true
  return /(?:示例|例如|推荐写法|不推荐写法|理由|风险|例外|checklist|review|检查项|落地建议|example|rationale|exception)/i.test(blockText(block))
}

function deterministicRuleMatch(block: SourceBackedBlock, rules: RuleCardSpec[]): { rule: RuleCardSpec; confidence: number; reason: string } | undefined {
  const exact = exactMatchingRules(block, rules)
  if (exact.length === 1) {
    return { rule: exact[0]!, confidence: 0.9, reason: "来源文档和章节唯一匹配，已本地预归位。" }
  }
  if (block.source.sourceOrigin !== "internal_company" || !exampleBlock(block)) return undefined
  const scored = rules
    .map((rule) => ({ rule, score: deterministicMatchScore(block, rule) }))
    .filter((item) => item.score >= 5)
    .sort((left, right) => right.score - left.score)
  const best = scored[0]
  if (!best) return undefined
  const secondScore = scored[1]?.score ?? 0
  if (best.score < secondScore + 3) return undefined
  return { rule: best.rule, confidence: Math.min(0.88, 0.62 + best.score / 30), reason: "来源块与规则主题高置信匹配，已本地预归位。" }
}

function deterministicMatchScore(block: SourceBackedBlock, rule: RuleCardSpec) {
  let score = 0
  if (rule.sources.some((source) => sourceMatchesBlock(source, block))) score += 8
  const headingTokens = tokens(block.source.headingPath.join(" "))
  const blockTokens = tokens(`${block.title ?? ""} ${blockText(block)}`)
  const ruleTokens = tokens(`${rule.name} ${rule.scope} ${rule.description} ${rule.recommended ?? ""} ${rule.discouraged ?? ""}`)
  score += headingTokens.filter((token) => ruleTokens.includes(token)).length * 3
  score += blockTokens.filter((token) => ruleTokens.includes(token)).length
  return score
}

function exactMatchingRules(block: SourceBackedBlock, rules: RuleCardSpec[]) {
  const anchor = block.source.sourceRuleAnchor
  if (anchor) {
    const anchored = rules.filter((rule) =>
      rule.sourceRuleAnchor === anchor
      && rule.sources.some((source) => sourceMatchesBlock(source, block)),
    )
    if (anchored.length > 0) return anchored
  }
  return rules.filter((rule) => rule.sources.some((source) => sourceMatchesBlock(source, block)))
}

function relatedRulesForBlock(block: SourceBackedBlock, rules: RuleCardSpec[]) {
  const exact = exactMatchingRules(block, rules)
  if (exact.length > 0) return exact.slice(0, MAX_RULES_PER_BATCH)
  const blockTokens = tokens(`${block.title ?? ""} ${block.source.headingPath.join(" ")} ${blockText(block)}`)
  const scored = rules
    .map((rule) => {
      const ruleTokens = tokens(`${rule.name} ${rule.scope} ${rule.description} ${rule.recommended ?? ""} ${rule.discouraged ?? ""}`)
      const overlap = blockTokens.filter((token) => ruleTokens.includes(token)).length
      return { rule, score: overlap }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.rule)
  return (scored.length > 0 ? scored : rules).slice(0, Math.min(MAX_RULES_PER_BATCH, 6))
}

function sourceMatchesBlock(source: string, block: SourceBackedBlock) {
  const normalized = normalizeForMatch(source)
  const sourcePath = normalizeForMatch(block.source.sourcePath)
  const sourceId = normalizeForMatch(block.source.sourceId)
  const sourceName = normalizeForMatch(block.source.sourceName ?? block.source.sourceTitle ?? "")
  const pathParts = block.source.sourcePath.split(/[\\/]/).filter(Boolean)
  const basename = normalizeForMatch(pathParts.at(-1) ?? "")
  const hasSourceIdentity = Boolean(sourcePath && normalized.includes(sourcePath))
    || Boolean(sourceId && normalized.includes(sourceId))
    || Boolean(basename && normalized.includes(basename))
    || Boolean(sourceName && normalized.includes(sourceName))
  if (!hasSourceIdentity) return false
  const section = normalizeForMatch(block.source.headingPath.join(" > "))
  const leaf = normalizeForMatch(block.source.headingPath.at(-1) ?? "")
  const sourceRuleAnchor = normalizeForMatch(block.source.sourceRuleAnchor ?? "")
  if (sourceRuleAnchor && normalized.includes(sourceRuleAnchor)) return true
  return !section && !leaf || Boolean(section && normalized.includes(section)) || Boolean(leaf && normalized.includes(leaf))
}

function deterministicPlacementKind(block: SourceBackedBlock): PlacementKind | undefined {
  const text = `${block.title ?? ""} ${blockText(block)}`
  if ((block.kind === "code" || block.kind === "example") && block.source.sourceOrigin === "internal_company" && block.source.sourceRuleAnchor) return "preserved-example"
  if ((block.kind === "code" || block.kind === "example") && isLikelyExampleBlock(block)) return "preserved-example"
  if (/(?:不推荐|错误示例|bad example|avoid)/i.test(text)) return "discouraged"
  if (/(?:推荐|正确示例|good example)/i.test(text)) return "recommended"
  if (/(?:理由|原因|rationale)/i.test(text)) return "rationale"
  if (/(?:例外|exception)/i.test(text)) return "exception"
  if (block.kind === "list" && /(?:checklist|review|检查项)/i.test(text)) return "checklist"
  if (block.kind === "code" || block.kind === "example") return undefined
  return "rule-explanation"
}

function isLikelyExampleBlock(block: SourceBackedBlock) {
  const text = `${block.title ?? ""} ${blockText(block)} ${block.source.neighborTextPreview?.previous ?? ""} ${block.source.neighborTextPreview?.next ?? ""}`
  return /(?:示例|例如|例子|实例如下|如下|example)/i.test(text)
}

function unionRules(left: RuleCardSpec[], right: RuleCardSpec[]) {
  const byId = new Map(left.map((rule) => [rule.ruleId, rule]))
  for (const rule of right) {
    if (!byId.has(rule.ruleId)) byId.set(rule.ruleId, rule)
  }
  return [...byId.values()]
}

function ruleDigest(rule: RuleCardSpec) {
  return [
    rule.ruleId,
    rule.name,
    rule.scope,
    rule.description,
    rule.recommended ?? "",
    rule.discouraged ?? "",
    rule.sourceRuleAnchor ?? "",
    rule.sources.join("|"),
  ].join("\n")
}

function tokens(text: string) {
  return normalizeForMatch(text).split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((token) => token.length >= 2).slice(0, 80)
}

function normalizeForMatch(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

function normalizePlacements(items: NonNullable<PlacementJson["placements"]>): SourceBlockPlacementDecision[] {
  return items
    .map((item) => ({
      blockId: clean(item.blockId),
      targetRuleId: clean(item.targetRuleId),
      placement: normalizePlacement(item.placement),
      confidence: normalizeConfidence(item.confidence),
      reason: clean(item.reason),
      label: clean(item.label),
    }))
    .filter((item) => item.blockId && item.targetRuleId && item.placement && item.placement !== "unassigned")
}

function validatePlacementsForBatch(
  placements: SourceBlockPlacementDecision[],
  batch: PlacementBatch,
  validatePlacement: SourceBlockPlacementValidator | undefined,
) {
  if (!validatePlacement) return { placements, warnings: [] }
  const ruleById = new Map(batch.rules.map((rule) => [rule.ruleId, rule]))
  const blockById = new Map(batch.blocks.map((block) => [block.id, block]))
  const accepted: SourceBlockPlacementDecision[] = []
  const warnings: string[] = []
  for (const placement of placements) {
    const rule = ruleById.get(placement.targetRuleId)
    const block = blockById.get(placement.blockId)
    if (!rule || !block) continue
    const result = validatePlacement({ rule, block, placement })
    if (result.ok) {
      accepted.push(placement)
      continue
    }
    if (result.warning) warnings.push(result.warning)
  }
  return { placements: accepted, warnings: [...new Set(warnings)] }
}

function applyPlacements(
  rules: RuleCardSpec[],
  blocks: SourceBackedBlock[],
  placements: SourceBlockPlacementDecision[],
  warnings: string[],
  warningBlockIds: Set<string>,
  validatePlacement?: SourceBlockPlacementValidator,
): SourceBlockPlacementResult {
  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const managedIds = new Set(blocks.flatMap((block) => [block.id, block.source.sourceBlockId].filter(Boolean) as string[]))
  const ruleById = new Map(rules.map((rule) => [rule.ruleId, stripManagedBlocks(rule, managedIds)]))
  const assigned = new Set<string>()
  const lowConfidenceExampleBlocks = new Set(blocks.filter((block) => warningBlockIds.has(block.id) && exampleBlock(block)).map((block) => block.id))
  const lowConfidenceLabels: string[] = []

  for (const placement of placements) {
    const block = blockById.get(placement.blockId)
    const rule = ruleById.get(placement.targetRuleId)
    if (!block || !rule) continue
    if (placement.placement === "unassigned") continue
    if (validatePlacement) {
      const validation = validatePlacement({ rule, block, placement })
      if (!validation.ok) {
        if (validation.warning) warnings.push(validation.warning)
        continue
      }
    }
    if (placement.confidence < MIN_CONFIDENCE) {
      if (exampleBlock(block)) lowConfidenceLabels.push(sourceLabel(block))
      continue
    }
    lowConfidenceExampleBlocks.delete(block.id)
    assigned.add(block.id)
    if (placement.placement === "preserved-example") {
      placeExample(rule, block)
    } else {
      rule.sourceDerivedItems = [...(rule.sourceDerivedItems ?? []), sourceDerivedItem(rule, block, placement)]
      rule.sourceBackedBlocks = [...(rule.sourceBackedBlocks ?? []), block]
    }
    ruleById.set(rule.ruleId, rule)
  }

  if (lowConfidenceLabels.length > 0) {
    warnings.push(summaryWarning("来源示例未能高置信归位", lowConfidenceLabels))
  }
  const unassignedInternalLabels: string[] = []
  for (const block of blocks) {
    if (assigned.has(block.id)) continue
    if (lowConfidenceExampleBlocks.has(block.id) && block.source.sourceOrigin === "internal_company") {
      unassignedInternalLabels.push(sourceLabel(block))
    }
  }
  if (unassignedInternalLabels.length > 0) {
    warnings.push(summaryWarning("内部来源示例未归入具体规则", unassignedInternalLabels))
  }

  const nextRules = rules.map((rule) => {
    const next = ruleById.get(rule.ruleId) ?? rule
    return {
      ...next,
      sourceBackedBlocks: (next.sourceBackedBlocks ?? []).filter((block) => !exampleAlreadyPreserved(next, block)),
    }
  })
  return { rules: nextRules, assignedBlockIds: [...assigned], warnings: [...new Set(warnings.filter(Boolean))] }
}

function summaryWarning(prefix: string, labels: string[]) {
  const unique = [...new Set(labels)]
  const visible = unique.slice(0, 5).join("；")
  const suffix = unique.length > 5 ? `；另有 ${unique.length - 5} 个来源块未展开显示` : ""
  return `${prefix}：${visible}${suffix}。`
}

function stripManagedBlocks(rule: RuleCardSpec, managedIds: Set<string>): RuleCardSpec {
  return {
    ...rule,
    preservedExamples: (rule.preservedExamples ?? []).filter((block) => !managedIds.has(block.id) && !managedIds.has(block.source.sourceBlockId ?? "")),
    sourceBackedBlocks: (rule.sourceBackedBlocks ?? []).filter((block) => !managedIds.has(block.id) && !managedIds.has(block.source.sourceBlockId ?? "")),
  }
}

function placeExample(rule: RuleCardSpec, block: SourceBackedBlock) {
  if (block.source.sourceOrigin === "internal_company") {
    const examples = [...(rule.preservedExamples ?? [])]
    if (!examples.some((item) => item.id === block.id)) examples.push(block)
    rule.preservedExamples = examples
      .sort((left, right) => {
        const score = preservedExampleScore(right) - preservedExampleScore(left)
        if (score !== 0) return score
        return (left.source.blockIndex ?? 0) - (right.source.blockIndex ?? 0)
      })
      .slice(0, MAX_PRESERVED_EXAMPLES_PER_RULE)
    rule.sourceBackedBlocks = (rule.sourceBackedBlocks ?? []).filter((item) => item.id !== block.id)
    return
  }
  const generated = [...(rule.generatedExamples ?? [])]
  if (!generated.some((item) => item.sourceRefs.includes(sourceRef(block)))) {
    generated.push(adaptedExample(rule, block))
    if (containsUntranslatedEnglishText(blockText(block))) {
      rule.exampleWarnings = [...new Set([
        ...(rule.exampleWarnings ?? []),
        `规则 ${rule.ruleId}「${rule.name}」的外部来源示例包含英文原文，已改写为中文团队化示例说明，请人工复核语义。`,
      ])]
    }
  }
  rule.generatedExamples = generated.slice(0, 2)
}

function adaptedExample(rule: RuleCardSpec, block: SourceBackedBlock): GeneratedExampleSpec {
  return {
    id: `${rule.ruleId}-source-${block.id}`,
    title: "补充示例：根据外部参考原则改写",
    exampleFormat: block.kind === "list" ? "checklist" : "text",
    exampleType: block.kind === "list" ? "checklist" : "source-adapted",
    goodExample: sourceAdaptedGoodExample(block),
    explanation: "该示例根据来源资料的原则摘要或改写，用于说明团队落地方式，不是原文摘录。",
    sourceRefs: [sourceRef(block)],
    generationMode: "adapted-from-source",
    origin: "adapted",
    isVerbatim: false,
  }
}

function sourceAdaptedGoodExample(block: SourceBackedBlock) {
  if (block.kind === "list") {
    return [
      "- 将来源原则转化为团队可检查项",
      "- 在代码评审中确认本规则已满足",
      "- 对例外情况记录原因、影响范围和风险控制措施",
    ].join("\n")
  }
  if (block.kind === "table") return "推荐：将来源表格中的约束整理为团队规则字段和评审检查项，并保留来源引用供人工复核。"
  if (block.kind === "code" || block.kind === "example") return "推荐：参考来源示例表达的原则，使用团队命名、错误处理和评审要求重写最小示例；不要直接复制外部原始示例。"
  return "推荐：将来源原则改写为团队可执行、可评审的做法，并在本规则的评审记录中确认。"
}

function sourceDerivedItem(rule: RuleCardSpec, block: SourceBackedBlock, placement: SourceBlockPlacementDecision): SourceDerivedItemSpec {
  return {
    id: `${rule.ruleId}-${block.id}-${placement.placement}`,
    label: placement.label || labelForPlacement(placement.placement),
    itemType: sourceDerivedItemType(placement.placement),
    text: blockText(block),
    sourceRefs: [sourceRef(block)],
    sourceBlockIds: [block.source.sourceBlockId || block.id],
  }
}

function sourceDerivedItemType(placement: PlacementKind): SourceDerivedItemSpec["itemType"] {
  if (placement === "recommended" || placement === "discouraged" || placement === "rationale" || placement === "checklist") return placement
  if (placement === "exception") return "exception"
  return "rule-explanation"
}

function exampleAlreadyPreserved(rule: RuleCardSpec, block: SourceBackedBlock) {
  return rule.preservedExamples?.some((item) => item.id === block.id) || rule.generatedExamples?.some((item) => item.sourceRefs.includes(sourceRef(block)))
}

function preservedExampleScore(block: SourceBackedBlock) {
  const text = blockText(block)
  let score = 0
  if (block.kind === "code" || block.kind === "example") score += 40
  if (block.kind === "table" || block.kind === "list") score += 20
  if (isLikelyExampleBlock(block)) score += 30
  if (block.codeBlock?.code || /[;{}=()<>]|\/\/\//.test(text)) score += 15
  if (/^\s*【(?:建议|规则|规范|要求)/.test(text)) score -= 25
  if (/实例如下|示例如下|例如/.test(text) && text.length < 80) score -= 10
  return score
}

function assignedBlockIdsFromRules(rules: RuleCardSpec[]) {
  return [...new Set(rules.flatMap((rule) => [
    ...(rule.preservedExamples ?? []).map((block) => block.id),
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.id),
    ...(rule.sourceDerivedItems ?? []).flatMap((item) => item.sourceBlockIds),
  ]))]
}

function blockText(block: SourceBackedBlock) {
  const tableText = block.table ? [block.table.headers.join(" | "), ...block.table.rows.map((row) => row.join(" | "))].join("\n") : ""
  return [
    block.codeBlock?.code,
    block.items?.join("\n"),
    block.text,
    tableText,
    block.note,
  ].find((text) => text?.trim())?.trim().slice(0, 1200) ?? ""
}

function sourceRef(block: SourceBackedBlock) {
  const section = block.source.headingPath.join(" > ") || "未命名章节"
  const hash = block.source.originalBlockHash.normalizedHash.slice(0, 12)
  return `${block.source.sourceId}:${section}:${hash}`
}

function sourceLabel(block: SourceBackedBlock) {
  return `${block.source.sourceName || block.source.sourcePath} / ${block.source.headingPath.join(" > ") || "未命名章节"}`
}

function exampleBlock(block: SourceBackedBlock) {
  return block.kind === "example" || block.kind === "code"
}

function labelForPlacement(placement: PlacementKind) {
  if (placement === "rule-explanation") return "来源说明"
  if (placement === "recommended") return "来源推荐做法"
  if (placement === "discouraged") return "来源不推荐做法"
  if (placement === "rationale") return "来源理由"
  if (placement === "exception") return "来源例外"
  if (placement === "checklist") return "来源检查项"
  return "来源补充"
}

function normalizePlacement(input: unknown): PlacementKind {
  const value = String(input ?? "")
  if (value === "rule-explanation" || value === "recommended" || value === "discouraged" || value === "preserved-example" || value === "rationale" || value === "exception" || value === "checklist" || value === "unassigned") return value
  return "unassigned"
}

function normalizeConfidence(input: unknown) {
  const value = Number(input)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function clean(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}
