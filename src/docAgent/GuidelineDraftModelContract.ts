import { normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { normalizeRuleCardReadableText } from "./RuleLanguage"
import { plainTableRows } from "./TableSpecUtils"
import type { DocumentPlan, GeneratedExampleSpec, RuleCardSpec, SourceBackedBlock, SourceOrigin } from "./types"

export type CandidateRuleClassification =
  | "formal-rule"
  | "pending-review"
  | "implementation-guidance"
  | "risk-limit"
  | "reference-only"
  | "appendix-only"

export type ExampleClassification =
  | "preserved-internal-example"
  | "adapted-external-example"
  | "model-generated-example"

export type ClassifiedGuidelineItem = {
  id: string
  title: string
  text: string
  classification: Exclude<CandidateRuleClassification, "formal-rule" | "pending-review">
  sourceRefs: string[]
  sourceBlockRefs: string[]
  reason?: string
}

type ModelGeneratedExample = Omit<Partial<GeneratedExampleSpec>, "isVerbatim" | "origin" | "generationMode"> & {
  isVerbatim?: unknown
  origin?: unknown
  generationMode?: unknown
  classification?: unknown
  exampleClassification?: unknown
}

export type DraftRuleModel = Omit<Partial<RuleCardSpec>, "generatedExamples" | "preservedExamples" | "sourceBackedBlocks"> & {
  classification?: unknown
  candidateClassification?: unknown
  preservedExampleRefs?: unknown
  sourceBackedBlockRefs?: unknown
  generatedExamples?: ModelGeneratedExample[]
  preservedExamples?: unknown
  sourceBackedBlocks?: unknown
  reason?: unknown
}

export type DraftModelOutput = {
  rules?: DraftRuleModel[]
  pendingReviewRules?: DraftRuleModel[]
  implementationGuidanceItems?: unknown[]
  riskLimitItems?: unknown[]
  referenceOnlyItems?: unknown[]
  warnings?: string[]
}

export type DraftNormalizationResult = {
  rules: RuleCardSpec[]
  pendingReviewRules: RuleCardSpec[]
  implementationGuidanceItems: ClassifiedGuidelineItem[]
  riskLimitItems: ClassifiedGuidelineItem[]
  referenceOnlyItems: ClassifiedGuidelineItem[]
  warnings: string[]
  stats: {
    formalRules: number
    pendingReviewRules: number
    preservedExampleRefs: number
    generatedExamples: number
    adaptedExternalExamples: number
    implementationGuidanceItems: number
    riskLimitItems: number
    referenceOnlyItems: number
  }
}

type NormalizeContext = {
  fallbackRules: RuleCardSpec[]
  sourceBlocks: SourceBackedBlock[]
  plan?: DocumentPlan
}

export function guidelineDraftClassificationContract() {
  return [
    "Classify before writing final content. Use only these controlled classifications.",
    "candidateRule classifications: formal-rule, pending-review, implementation-guidance, risk-limit, reference-only, appendix-only.",
    "sourceBlock classifications: preserved-example-ref, generated-example-source, rule-explanation, recommended-practice, discouraged-practice, rationale, exception, checklist, unassigned.",
    "example classifications: preserved-internal-example, adapted-external-example, model-generated-example.",
    "rules[] may contain only formal-rule items. Non-rule content must go to pendingReviewRules or the classified item arrays.",
    "Internal verbatim examples must be represented only as preservedExampleRefs/sourceBackedBlockRefs pointing to provided sourceBackedBlocks ids; do not copy them into generatedExamples.",
    "Do not fabricate preservedExamples or sourceBackedBlocks objects. The system will resolve refs to real source blocks.",
    "generatedExamples are only model-generated or adapted examples. They are never verbatim excerpts and must have isVerbatim=false.",
    "External source examples must be adapted, summarized, or regenerated in team style; never copy external prose/code as verbatim.",
    "Static analysis, CI, rollout workflow, risk, copyright, compliance, reference, appendix, directory, and index material must not become formal RuleCards unless it is a concrete executable coding rule.",
  ].join("\n")
}

export function guidelineDraftOutputSchema() {
  return {
    rules: [{
      classification: "formal-rule",
      ruleId: "C-001",
      name: "具体中文规则名",
      priority: "必须|应该|建议",
      scope: "具体中文适用范围",
      description: "具体规则说明",
      recommended: "推荐做法",
      discouraged: "不推荐做法",
      rationale: "理由",
      exceptions: "例外情况",
      sources: ["source ref"],
      preservedExampleRefs: ["sourceBackedBlock.id or sourceBlockId for internal original examples"],
      sourceBackedBlockRefs: ["sourceBackedBlock.id or sourceBlockId for supporting source blocks"],
      generatedExamples: [{
        classification: "adapted-external-example | model-generated-example",
        title: "补充示例：根据规则生成",
        exampleFormat: "code | file-layout | naming-pair | checklist | text",
        badExample: "不推荐示例",
        badExampleReason: "不推荐原因",
        goodExample: "推荐示例",
        explanation: "中文说明，必须说明不是原文摘录",
        sourceRefs: ["source ref"],
        origin: "generated | adapted",
        generationMode: "model-generated-from-rule | adapted-from-source",
        isVerbatim: false,
      }],
    }],
    pendingReviewRules: [{
      classification: "pending-review",
      ruleId: "C-xxx",
      name: "待复核候选项",
      description: "为何无法具体化",
      sources: ["source ref"],
    }],
    implementationGuidanceItems: [{
      classification: "implementation-guidance",
      title: "静态检查或落地建议",
      text: "只进入落地建议章节，不生成核心 RuleCard",
      sourceRefs: ["source ref"],
      sourceBlockRefs: ["source block id"],
      reason: "分类原因",
    }],
    riskLimitItems: [{
      classification: "risk-limit",
      title: "风险、版权或合规边界",
      text: "只进入风险与限制章节",
      sourceRefs: ["source ref"],
      sourceBlockRefs: ["source block id"],
      reason: "分类原因",
    }],
    referenceOnlyItems: [{
      classification: "reference-only | appendix-only",
      title: "References 或附录索引",
      text: "只进入 References/附录",
      sourceRefs: ["source ref"],
      sourceBlockRefs: ["source block id"],
      reason: "分类原因",
    }],
    warnings: ["string"],
  }
}

export function sourceBlockForModel(block: SourceBackedBlock) {
  return {
    id: block.id,
    kind: block.kind,
    contentKind: block.contentKind,
    title: block.title,
    textPreview: blockText(block).slice(0, 500),
    sourceRole: block.source.sourceRole,
    sourceOrigin: block.source.sourceOrigin,
    source: `${block.source.sourcePath} / ${block.source.headingPath.join(" > ") || "未命名章节"}`,
    sourceBlockId: block.source.sourceBlockId,
    sourceRuleAnchor: block.source.sourceRuleAnchor,
    preserveMode: block.preserveMode,
    note: block.note,
  }
}

export function normalizeDraftModelOutput(output: DraftModelOutput, context: NormalizeContext): DraftNormalizationResult {
  const warnings: string[] = []
  const rules: RuleCardSpec[] = []
  const pendingReviewRules: RuleCardSpec[] = []
  const implementationGuidanceItems: ClassifiedGuidelineItem[] = []
  const riskLimitItems: ClassifiedGuidelineItem[] = []
  const referenceOnlyItems: ClassifiedGuidelineItem[] = []

  for (const [index, raw] of (output.rules ?? []).entries()) {
    const classification = normalizeCandidateClassification(raw.classification ?? raw.candidateClassification, "formal-rule")
    if (classification === "formal-rule") {
      const rule = normalizeRule(raw, context, index, warnings)
      if (rule) rules.push(rule)
      continue
    }
    if (classification === "pending-review") {
      const rule = normalizeRule(raw, context, index, warnings)
      if (rule) pendingReviewRules.push(withPendingReason(rule, raw))
      continue
    }
    addClassifiedItem(raw, classification, context, warnings, { implementationGuidanceItems, riskLimitItems, referenceOnlyItems })
  }

  for (const [index, raw] of (output.pendingReviewRules ?? []).entries()) {
    const rule = normalizeRule(raw, context, index, warnings)
    if (rule) pendingReviewRules.push(withPendingReason(rule, raw))
  }

  for (const item of output.implementationGuidanceItems ?? []) addClassifiedItem(item, "implementation-guidance", context, warnings, { implementationGuidanceItems, riskLimitItems, referenceOnlyItems })
  for (const item of output.riskLimitItems ?? []) addClassifiedItem(item, "risk-limit", context, warnings, { implementationGuidanceItems, riskLimitItems, referenceOnlyItems })
  for (const item of output.referenceOnlyItems ?? []) {
    const classification = normalizeCandidateClassification((item as { classification?: unknown })?.classification, "reference-only")
    addClassifiedItem(item, classification === "appendix-only" ? "appendix-only" : "reference-only", context, warnings, { implementationGuidanceItems, riskLimitItems, referenceOnlyItems })
  }

  return {
    rules,
    pendingReviewRules,
    implementationGuidanceItems,
    riskLimitItems,
    referenceOnlyItems,
    warnings: uniqueStrings([...(output.warnings ?? []).map(cleanText), ...warnings]),
    stats: {
      formalRules: rules.length,
      pendingReviewRules: pendingReviewRules.length,
      preservedExampleRefs: rules.reduce((count, rule) => count + (rule.preservedExamples?.length ?? 0), 0),
      generatedExamples: rules.reduce((count, rule) => count + (rule.generatedExamples?.length ?? 0), 0),
      adaptedExternalExamples: rules.reduce((count, rule) => count + (rule.generatedExamples ?? []).filter((example) => example.origin === "adapted").length, 0),
      implementationGuidanceItems: implementationGuidanceItems.length,
      riskLimitItems: riskLimitItems.length,
      referenceOnlyItems: referenceOnlyItems.length,
    },
  }
}

export function normalizeGeneratedExamplesForRule(rule: RuleCardSpec): RuleCardSpec {
  if (!rule.generatedExamples) return normalizeRuleCardReadableText(rule)
  const warnings: string[] = []
  const normalized = normalizeExamples(rule.generatedExamples, rule.sources, warnings)
  return normalizeRuleCardReadableText({
    ...rule,
    generatedExamples: normalized,
    exampleWarnings: warnings.length ? [...(rule.exampleWarnings ?? []), ...warnings] : rule.exampleWarnings,
  })
}

export function normalizeGeneratedExamplesInSpecRule(rule: RuleCardSpec): RuleCardSpec {
  if (!rule.generatedExamples) return normalizeRuleCardReadableText(rule)
  const warnings: string[] = []
  return normalizeRuleCardReadableText({
    ...rule,
    generatedExamples: normalizeExamples(rule.generatedExamples, rule.sources, warnings),
    exampleWarnings: warnings.length ? [...(rule.exampleWarnings ?? []), ...warnings] : rule.exampleWarnings,
  })
}

function normalizeRule(raw: DraftRuleModel, context: NormalizeContext, index: number, warnings: string[]): RuleCardSpec | undefined {
  const fallback = findFallbackRule(raw, context.fallbackRules, index)
  const sources = cleanStrings(raw.sources).length ? cleanStrings(raw.sources) : fallback?.sources ?? []
  const name = cleanText(raw.name) || fallback?.name
  const description = cleanText(raw.description) || fallback?.description
  if (!name || !description) return undefined
  if (Array.isArray(raw.preservedExamples) && raw.preservedExamples.length > 0) {
    warnings.push(`模型尝试直接构造 preservedExamples，已忽略；请使用 preservedExampleRefs 引用真实来源块：${name}`)
  }
  if (Array.isArray(raw.sourceBackedBlocks) && raw.sourceBackedBlocks.length > 0) {
    warnings.push(`模型尝试直接构造 sourceBackedBlocks，已忽略；请使用 sourceBackedBlockRefs 引用真实来源块：${name}`)
  }
  const preservedExamples = resolveSourceBlockRefs(raw.preservedExampleRefs, context.sourceBlocks, {
    internalOnly: true,
    usage: "preservedExamples",
    warnings,
    ruleName: name,
  })
  const sourceBackedBlocks = resolveSourceBlockRefs(raw.sourceBackedBlockRefs, context.sourceBlocks, {
    internalOnly: false,
    usage: "sourceBackedBlocks",
    warnings,
    ruleName: name,
  })
  const rule: RuleCardSpec = {
    ...(fallback ?? {}),
    ruleId: cleanText(raw.ruleId) || fallback?.ruleId || `C-${String(index + 1).padStart(3, "0")}`,
    name,
    priority: normalizePriority(raw.priority) ?? fallback?.priority ?? "应该",
    scope: cleanText(raw.scope) || fallback?.scope || "通用编码原则",
    description,
    recommended: cleanText(raw.recommended) || fallback?.recommended,
    discouraged: cleanText(raw.discouraged) || fallback?.discouraged,
    rationale: cleanText(raw.rationale) || fallback?.rationale,
    exceptions: cleanText(raw.exceptions) || fallback?.exceptions || "确需例外时，应记录原因、影响范围和替代风险控制措施，并经过代码评审确认。",
    sources,
    sourceRole: normalizeRole(raw.sourceRole) ?? fallback?.sourceRole,
    sourceOrigin: normalizeOrigin(raw.sourceOrigin) ?? fallback?.sourceOrigin,
    sourceRuleAnchor: cleanText(raw.sourceRuleAnchor) || fallback?.sourceRuleAnchor,
    sourceRoleReason: cleanText(raw.sourceRoleReason) || fallback?.sourceRoleReason,
    rolloutAdvice: cleanText(raw.rolloutAdvice) || fallback?.rolloutAdvice,
    sourceBackedBlocks: sourceBackedBlocks.length ? sourceBackedBlocks : fallback?.sourceBackedBlocks,
    preservedExamples: preservedExamples.length ? preservedExamples : fallback?.preservedExamples,
    generatedExamples: normalizeExamples(raw.generatedExamples ?? [], sources, warnings),
    sourceDerivedItems: Array.isArray(raw.sourceDerivedItems) && raw.sourceDerivedItems.length ? raw.sourceDerivedItems : fallback?.sourceDerivedItems,
    exampleWarnings: cleanStrings(raw.exampleWarnings).length ? cleanStrings(raw.exampleWarnings) : fallback?.exampleWarnings,
  }
  if (!rule.generatedExamples?.length && fallback?.generatedExamples?.length) {
    rule.generatedExamples = normalizeExamples(fallback.generatedExamples, sources, warnings)
  }
  const planned = context.plan ? normalizeRuleCardForPlan(rule, context.plan) : rule
  return normalizeRuleCardReadableText(planned)
}

function normalizeExamples(examples: ModelGeneratedExample[], sourceRefs: string[], warnings: string[]): GeneratedExampleSpec[] {
  const result: GeneratedExampleSpec[] = []
  for (const [index, example] of examples.entries()) {
    const classification = normalizeExampleClassification(example.classification ?? example.exampleClassification)
    const title = cleanText(example.title) || "补充示例"
    if (classification === "preserved-internal-example" || example.isVerbatim === true) {
      warnings.push(`模型将原文示例放入 generatedExamples，已忽略该示例；原文示例必须通过 preservedExampleRefs 引用：${title}`)
      continue
    }
    const refs = cleanStrings(example.sourceRefs).length ? cleanStrings(example.sourceRefs) : sourceRefs
    result.push({
      ...example,
      id: cleanText(example.id) || `generated-example-${index + 1}`,
      title,
      explanation: cleanText(example.explanation) || "该示例根据当前规则语义生成，用于帮助评审和落地，不是原文摘录。",
      sourceRefs: refs,
      origin: classification === "adapted-external-example" || example.origin === "adapted" ? "adapted" : "generated",
      generationMode: classification === "adapted-external-example" || example.generationMode === "adapted-from-source" ? "adapted-from-source" : "model-generated-from-rule",
      isVerbatim: false,
    })
  }
  return result
}

function resolveSourceBlockRefs(input: unknown, blocks: SourceBackedBlock[], options: { internalOnly: boolean; usage: string; warnings: string[]; ruleName: string }) {
  const refs = cleanStrings(input)
  if (refs.length === 0) return []
  const lookup = sourceBlockLookup(blocks)
  const result: SourceBackedBlock[] = []
  for (const ref of refs) {
    const block = lookup.get(ref)
    if (!block) {
      options.warnings.push(`模型引用的来源块不存在，已忽略：${ref}（规则：${options.ruleName}）`)
      continue
    }
    if (options.internalOnly && block.source.sourceOrigin !== "internal_company") {
      options.warnings.push(`模型将非内部来源块作为原文示例引用，已忽略：${ref}（规则：${options.ruleName}）`)
      continue
    }
    if (options.internalOnly && block.preserveMode !== "verbatim-short") {
      options.warnings.push(`模型引用的内部来源块不允许短原文保留，已忽略：${ref}（规则：${options.ruleName}）`)
      continue
    }
    result.push(block)
  }
  return uniqueBlocks(result)
}

function sourceBlockLookup(blocks: SourceBackedBlock[]) {
  const lookup = new Map<string, SourceBackedBlock>()
  for (const block of blocks) {
    const keys = [
      block.id,
      block.source.sourceBlockId,
      block.source.sourceLocation.sourceBlockId,
      `${block.source.sourceId}:${block.id}`,
      block.source.sourceBlockId ? `${block.source.sourceId}:${block.source.sourceBlockId}` : undefined,
    ].filter(Boolean) as string[]
    for (const key of keys) lookup.set(key, block)
  }
  return lookup
}

function addClassifiedItem(
  raw: unknown,
  classification: CandidateRuleClassification,
  context: NormalizeContext,
  warnings: string[],
  buckets: {
    implementationGuidanceItems: ClassifiedGuidelineItem[]
    riskLimitItems: ClassifiedGuidelineItem[]
    referenceOnlyItems: ClassifiedGuidelineItem[]
  },
) {
  if (classification === "formal-rule" || classification === "pending-review") return
  const item = normalizeClassifiedItem(raw, classification, context, warnings)
  if (!item) return
  if (classification === "implementation-guidance") buckets.implementationGuidanceItems.push(item)
  else if (classification === "risk-limit") buckets.riskLimitItems.push(item)
  else buckets.referenceOnlyItems.push(item)
}

function normalizeClassifiedItem(raw: unknown, classification: ClassifiedGuidelineItem["classification"], context: NormalizeContext, warnings: string[]): ClassifiedGuidelineItem | undefined {
  const value = raw as Record<string, unknown>
  const title = cleanText(value.title) || cleanText(value.name)
  const text = cleanText(value.text) || cleanText(value.description) || cleanText(value.reason)
  if (!title && !text) return undefined
  const sourceRefs = cleanStrings(value.sourceRefs).length ? cleanStrings(value.sourceRefs) : cleanStrings(value.sources)
  const sourceBlockRefs = cleanStrings(value.sourceBlockRefs)
  for (const ref of sourceBlockRefs) {
    if (!sourceBlockLookup(context.sourceBlocks).has(ref)) warnings.push(`模型分类项引用的来源块不存在，已仅保留文字说明：${ref}`)
  }
  return {
    id: cleanText(value.id) || `${classification}-${hashish(`${title}:${text}`).slice(0, 8)}`,
    title: title || text.slice(0, 32),
    text: text || title,
    classification,
    sourceRefs,
    sourceBlockRefs,
    reason: cleanText(value.reason),
  }
}

function withPendingReason(rule: RuleCardSpec, raw: DraftRuleModel): RuleCardSpec {
  const reason = cleanText(raw.reason) || "模型分类为待人工复核，未进入正式规则正文。"
  return {
    ...rule,
    exampleWarnings: [...(rule.exampleWarnings ?? []), reason],
  }
}

function findFallbackRule(raw: DraftRuleModel, fallbackRules: RuleCardSpec[], index: number) {
  const ruleId = cleanText(raw.ruleId)
  const name = cleanText(raw.name)
  return fallbackRules.find((rule) => rule.ruleId === ruleId)
    ?? fallbackRules.find((rule) => name && rule.name === name)
    ?? fallbackRules[index]
}

function normalizeCandidateClassification(input: unknown, fallback: CandidateRuleClassification): CandidateRuleClassification {
  if (input === "formal-rule" || input === "pending-review" || input === "implementation-guidance" || input === "risk-limit" || input === "reference-only" || input === "appendix-only") return input
  return fallback
}

function normalizeExampleClassification(input: unknown): ExampleClassification | undefined {
  if (input === "preserved-internal-example" || input === "adapted-external-example" || input === "model-generated-example") return input
  return undefined
}

function normalizePriority(input: unknown): RuleCardSpec["priority"] | undefined {
  return input === "必须" || input === "应该" || input === "建议" ? input : undefined
}

function normalizeRole(input: unknown) {
  return input === "internal" || input === "external" || input === "unknown" ? input : undefined
}

function normalizeOrigin(input: unknown): SourceOrigin | undefined {
  return input === "internal_company" || input === "external_public" || input === "external_licensed" || input === "unknown" ? input : undefined
}

function blockText(block: SourceBackedBlock) {
  return [
    block.title,
    block.text,
    block.items?.join("\n"),
    block.table ? [block.table.caption, block.table.headers.join(" | "), ...plainTableRows(block.table).map((row) => row.join(" | "))].filter(Boolean).join("\n") : "",
    block.codeBlock?.code,
    block.note,
  ].filter(Boolean).join("\n")
}

function cleanText(input: unknown) {
  return String(input ?? "").replace(/\s+/g, " ").trim()
}

function cleanStrings(input: unknown) {
  return Array.isArray(input) ? input.map(cleanText).filter(Boolean) : []
}

function uniqueStrings(input: string[]) {
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))]
}

function uniqueBlocks(blocks: SourceBackedBlock[]) {
  const seen = new Set<string>()
  const result: SourceBackedBlock[] = []
  for (const block of blocks) {
    if (seen.has(block.id)) continue
    seen.add(block.id)
    result.push(block)
  }
  return result
}

function hashish(input: string) {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(16)
}
