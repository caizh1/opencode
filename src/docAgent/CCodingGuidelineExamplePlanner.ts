import { inferCCodingGuidelineRuleKind, isGeneratedExampleSemanticallyCompatible, type CRuleSemanticKind } from "./CCodingGuidelineQuality"
import { normalizeRuleExampleIntentForRule } from "./CCodingGuidelineExampleIntentNormalizer"
import { exampleForSemanticKind } from "./CCodingGuidelineSemanticRegistry"
import type { RuleExampleIntent } from "./CCodingGuidelineExampleIntentPlanner"
import { containsUntranslatedEnglishText, normalizeRuleCardReadableText } from "./RuleLanguage"
import type { DocumentPlan, GeneratedExampleSpec, RuleCardSpec, SourceBackedBlock } from "./types"

type RuleExampleKind =
  Exclude<CRuleSemanticKind, "generic" | "governance">

export class CCodingGuidelineExamplePlanner {
  constructor(
    private readonly plan?: DocumentPlan,
    private readonly options: { intents?: Map<string, RuleExampleIntent> } = {},
  ) {}

  attachExamples(rules: RuleCardSpec[]): RuleCardSpec[] {
    return rules.map((rule) => {
      const warnings: string[] = [...(rule.exampleWarnings ?? [])]
      const normalized = normalizeRuleExampleIntentForRule(rule, this.options.intents?.get(rule.ruleId))
      const intent = normalized.intent
      rule = normalized.rule
      warnings.push(...normalized.warnings)
      const preserved = this.plan?.ruleCardPolicy?.preserveInternalExamples === false ? [] : internalExamples(rule).slice(0, 1)
      const existingGenerated = validExistingGeneratedExamples(rule, warnings, this.plan, intent)
      const generated = this.plan?.ruleCardPolicy?.exampleStyle === "none"
        ? []
        : intent?.draftExample && isGeneratedExampleRelevant(rule, intent.draftExample)
        ? [ensureBadExampleReason(rule, intent.draftExample, this.plan)]
        : existingGenerated.length > 0
        ? existingGenerated
        : preserved.length > 0 && preserved.some((block) => block.kind === "code" || block.kind === "example")
        ? []
        : generatedExample(rule, this.plan, intent)
      const preservedIds = new Set(preserved.map((block) => block.id))
      return {
        ...rule,
        preservedExamples: preserved,
        generatedExamples: generated,
        exampleWarnings: warnings.length ? warnings : rule.exampleWarnings,
        sourceBackedBlocks: (rule.sourceBackedBlocks ?? []).filter((block) => !preservedIds.has(block.id)),
      }
    })
  }

  repairExamples(rules: RuleCardSpec[]): { rules: RuleCardSpec[]; warnings: string[] } {
    const warnings: string[] = []
    const repaired = rules.map((rule) => {
      const ruleWarnings: string[] = [...(rule.exampleWarnings ?? [])]
      const normalized = normalizeRuleExampleIntentForRule(rule, this.options.intents?.get(rule.ruleId))
      const intent = normalized.intent
      rule = normalized.rule
      ruleWarnings.push(...normalized.warnings)
      warnings.push(...normalized.warnings)
      const existing = rule.generatedExamples ?? []
      const valid = validExistingGeneratedExamples(rule, ruleWarnings, this.plan, intent)
      const invalid = existing.filter((example) => !isGeneratedExampleRelevant(rule, normalizeGeneratedExample(rule, example, intent)))
      const hasPreservedExample = Boolean(
        rule.preservedExamples?.some((block) => block.kind === "code" || block.kind === "example")
        || internalExamples(rule).some((block) => block.kind === "code" || block.kind === "example"),
      )
      const hasExternalSource = hasExternalExampleSource(rule)
      const shouldGenerate = this.plan?.ruleCardPolicy?.exampleStyle !== "none"
        && valid.length === 0
        && !hasPreservedExample
        && (invalid.length > 0 || this.plan?.ruleCardPolicy?.requireMinimalExamplePerRule || hasExternalSource)
      const nextGenerated = shouldGenerate ? generatedExample(rule, this.plan, intent) : valid
      const next: RuleCardSpec = {
        ...rule,
        generatedExamples: nextGenerated,
        exampleWarnings: ruleWarnings.length ? [...new Set(ruleWarnings)] : rule.exampleWarnings,
      }
      if (invalid.length > 0) {
        if ((next.generatedExamples ?? []).length > 0) return normalizeRuleCardReadableText(next)
        const message = `已移除不匹配示例：规则 ${rule.ruleId}「${rule.name}」，未生成新的可信示例。`
        warnings.push(message)
        return {
          ...next,
          exampleWarnings: [...new Set([...(next.exampleWarnings ?? []), message])],
        }
      }
      return normalizeRuleCardReadableText(next)
    })
    return { rules: repaired, warnings: [...new Set(warnings)] }
  }
}

function internalExamples(rule: RuleCardSpec) {
  return (rule.sourceBackedBlocks ?? [])
    .filter((block) => block.source.sourceOrigin === "internal_company" && exampleBlock(block))
    .sort((left, right) => exampleRank(left) - exampleRank(right))
}

function generatedExample(rule: RuleCardSpec, plan?: DocumentPlan, intent?: RuleExampleIntent): GeneratedExampleSpec[] {
  const externalBlock = (rule.sourceBackedBlocks ?? []).find((block) =>
    (block.source.sourceOrigin === "external_public" || block.source.sourceOrigin === "external_licensed") && exampleBlock(block),
  )
  const hasExternalSource = externalBlock || hasExternalExampleSource(rule)
  const requireMinimal = plan?.ruleCardPolicy?.requireMinimalExamplePerRule
  if (!hasExternalSource && !requireMinimal) return []
  const sourceRefs = externalBlock ? [sourceRef(externalBlock)] : rule.sources
  const intentDraft = intent?.draftExample ? normalizeGeneratedExample(rule, intent.draftExample, intent) : undefined
  if (intentDraft && isGeneratedExampleRelevant(rule, intentDraft)) return [ensureBadExampleReason(rule, intentDraft, plan)]
  const examples = cExampleForRule(rule, externalBlock ? "adapted" : "generated")
  if (!examples) return []
  const example: GeneratedExampleSpec = {
    id: `${rule.ruleId}-example-1`,
    title: externalBlock ? "补充示例：根据外部参考原则改写" : "补充示例：根据规则生成",
    language: examples.language,
    exampleType: examples.exampleType,
    exampleFormat: examples.exampleFormat,
    badExample: examples.badExample,
    badExampleReason: plan?.ruleCardPolicy?.includeBadExampleReason ? examples.badExampleReason : undefined,
    goodExample: examples.goodExample,
    explanation: externalBlock
      ? "该示例根据外部参考资料的原则改写，用于说明团队落地方式，不是原文摘录。"
      : "该示例根据团队规则含义生成，用于帮助评审和落地，不是原文摘录。",
    sourceRefs,
    generationMode: externalBlock ? "adapted-from-source" : "model-generated-from-rule",
    origin: externalBlock ? "adapted" : "generated",
    isVerbatim: false,
    semanticIntent: intent ? {
      summary: intent.semanticSummary,
      objective: intent.exampleObjective,
      mustInclude: intent.mustInclude,
      softHints: intent.softHints,
      mustAvoid: intent.mustAvoid,
      confidence: intent.confidence,
    } : undefined,
    validationNotes: intent ? [`示例按模型语义规划生成：${intent.reason}`] : undefined,
  }
  return [example]
}

function hasExternalExampleSource(rule: RuleCardSpec) {
  return Boolean(
    (rule.sourceBackedBlocks ?? []).some((block) => block.source.sourceOrigin === "external_public" || block.source.sourceOrigin === "external_licensed")
    || rule.sources.some((source) => /external|外部|参考|CERT|Barr|Linux|GNU|NASA|JPL|MISRA/i.test(source)),
  )
}

function validExistingGeneratedExamples(rule: RuleCardSpec, warnings: string[], plan?: DocumentPlan, intent?: RuleExampleIntent) {
  const valid: GeneratedExampleSpec[] = []
  for (const example of rule.generatedExamples ?? []) {
    const normalized = normalizeGeneratedExample(rule, example, intent)
    if (isGeneratedExampleRelevant(rule, normalized)) {
      valid.push(ensureBadExampleReason(rule, normalized, plan))
      continue
    }
  }
  return valid.slice(0, 1)
}

function ensureBadExampleReason(rule: RuleCardSpec, example: GeneratedExampleSpec, plan?: DocumentPlan): GeneratedExampleSpec {
  if (!plan?.ruleCardPolicy?.includeBadExampleReason || !example.badExample) return normalizeExampleReadableText(example)
  const existingReason = cleanReason(example.badExampleReason)
  if (existingReason && !containsUntranslatedEnglishText(existingReason)) return normalizeExampleReadableText(example)
  return {
    ...normalizeExampleReadableText(example),
    badExampleReason: badExampleReasonForRule(rule),
  }
}

function normalizeGeneratedExample(rule: RuleCardSpec, example: GeneratedExampleSpec, intent?: RuleExampleIntent): GeneratedExampleSpec {
  return normalizeExampleReadableText({
    ...example,
    id: example.id || `${rule.ruleId}-example-1`,
    title: example.title || "补充示例",
    sourceRefs: example.sourceRefs?.length ? example.sourceRefs : rule.sources,
    isVerbatim: false,
    semanticIntent: example.semanticIntent ?? (intent ? {
      summary: intent.semanticSummary,
      objective: intent.exampleObjective,
      mustInclude: intent.mustInclude,
      softHints: intent.softHints,
      mustAvoid: intent.mustAvoid,
      confidence: intent.confidence,
    } : undefined),
    validationNotes: example.validationNotes ?? (intent ? [`示例按模型语义规划校验：${intent.reason}`] : undefined),
  })
}

function exampleBlock(block: SourceBackedBlock) {
  return block.kind === "code" || block.kind === "example" || block.kind === "table" || block.kind === "list"
}

function exampleRank(block: SourceBackedBlock) {
  if (block.kind === "code") return 0
  if (block.kind === "example") return 1
  if (block.kind === "table") return 2
  return 3
}

function sourceRef(block: SourceBackedBlock) {
  const section = block.source.headingPath.join(" > ") || "未命名章节"
  return `${block.source.sourceId}:${section}:${block.source.originalBlockHash.normalizedHash.slice(0, 12)}`
}

function cExampleForRule(rule: RuleCardSpec, _origin: GeneratedExampleSpec["origin"]): Pick<GeneratedExampleSpec, "language" | "exampleType" | "exampleFormat" | "badExample" | "badExampleReason" | "goodExample"> | undefined {
  const kind = inferRuleExampleKind(rule)
  if (!kind) {
    return undefined
  }
  return exampleForSemanticKind(kind)
}

function badExampleReasonForRule(rule: RuleCardSpec) {
  return cExampleForRule(rule, "generated")?.badExampleReason
    ?? "该反例没有体现规则要求的关键约束，容易让评审者误判代码已经满足当前规范。"
}

function cleanReason(input: string | undefined) {
  return input?.replace(/\s+/g, " ").trim()
}

function inferRuleExampleKind(rule: RuleCardSpec): RuleExampleKind | undefined {
  const kind = inferCCodingGuidelineRuleKind(rule)
  if (kind === "generic" || kind === "governance") return undefined
  return kind
}

export function isGeneratedExampleRelevant(rule: RuleCardSpec, example: GeneratedExampleSpec) {
  return isGeneratedExampleSemanticallyCompatible(rule, example)
}

function normalizeExampleReadableText(example: GeneratedExampleSpec): GeneratedExampleSpec {
  const next = { ...example }
  if (containsUntranslatedEnglishText(next.title)) next.title = "补充示例：根据规则生成"
  if (containsUntranslatedEnglishText(next.explanation)) next.explanation = "该示例根据团队规则含义生成，用于帮助评审和落地，不是原文摘录。"
  if (next.badExampleReason && containsUntranslatedEnglishText(next.badExampleReason)) {
    next.badExampleReason = "该反例未满足当前规则要求，容易造成评审遗漏或维护风险。"
  }
  return next
}
