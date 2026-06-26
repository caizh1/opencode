import { normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { guidelineDraftClassificationContract, guidelineDraftOutputSchema, normalizeDraftModelOutput, sourceBlockForModel, type ClassifiedGuidelineItem, type DraftModelOutput } from "./GuidelineDraftModelContract"
import { normalizeRuleCardReadableText } from "./RuleLanguage"
import type { DocAgentModelProvider, DocumentPlan, EvidencePack, ReferenceDocument, RuleCardSpec } from "./types"

export type GuidelineDraftComposeResult = {
  rules: RuleCardSpec[]
  pendingReviewRules: RuleCardSpec[]
  implementationGuidanceItems: ClassifiedGuidelineItem[]
  riskLimitItems: ClassifiedGuidelineItem[]
  referenceOnlyItems: ClassifiedGuidelineItem[]
  warnings: string[]
  usedModel: boolean
  stats?: {
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

export class GuidelineDraftComposer {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async compose(input: {
    question: string
    plan?: DocumentPlan
    documents: ReferenceDocument[]
    pack: EvidencePack
    rules: RuleCardSpec[]
    signal?: AbortSignal
  }): Promise<GuidelineDraftComposeResult> {
    const fallback = normalizeRules(input.rules, input.rules, input.plan)
    const emptyClassifiedItems = { implementationGuidanceItems: [], riskLimitItems: [], referenceOnlyItems: [] }
    if (!this.model) return { rules: fallback, pendingReviewRules: [], ...emptyClassifiedItems, warnings: [], usedModel: false }
    try {
      const output = await this.model.completeJson<DraftModelOutput>({
        purpose: "compose-guideline-draft",
        system: [
          "You are composing a team-facing C coding guideline draft from local Word evidence.",
          "Return JSON only.",
          "The model owns semantic drafting: make every RuleCard readable, concrete, source-backed, and useful.",
          guidelineDraftClassificationContract(),
          "Do not keep placeholder names such as 外部参考规则, 通用规则, 候选规则 in formal rules.",
          "If a candidate cannot be made concrete from evidence, put it in pendingReviewRules instead of formal rules.",
          "All human-readable fields must be Simplified Chinese. Code identifiers, file names, and source refs may stay as-is.",
          "Generated examples must demonstrate the exact rule; if uncertain, omit the example and explain in warnings.",
        ].join("\n"),
        prompt: JSON.stringify({
          question: input.question,
          documentPlan: input.plan,
          sources: input.documents.map((doc) => ({
            id: doc.id,
            title: doc.read.metadata.title,
            path: doc.read.metadata.path,
            role: doc.role,
            origin: doc.sourceOrigin,
          })),
          evidence: {
            internalSummary: input.pack.internalSummary,
            externalSummary: input.pack.externalSummary,
            candidateRules: input.pack.candidateRules.slice(0, 80).map((rule) => ({
              id: rule.id,
              title: rule.title,
              category: rule.category,
              priority: rule.priority,
              description: rule.description,
              recommended: rule.recommended,
              discouraged: rule.discouraged,
              rationale: rule.rationale,
              exceptions: rule.exceptions,
              sourceRole: rule.sourceRole,
              sourceOrigin: rule.sourceOrigin,
              source: `${rule.sourceDocument} / ${rule.sourceSection}`,
              sourceRuleAnchor: rule.sourceRuleAnchor,
            })),
            sourceBackedBlocks: input.pack.sourceBackedBlocks.slice(0, 80).map(sourceBlockForModel),
          },
          draftRules: input.rules.map((rule) => compactRule(rule)),
          outputSchema: guidelineDraftOutputSchema(),
        }),
      }, input.signal)
      const normalized = normalizeDraftModelOutput(output, {
        fallbackRules: fallback,
        sourceBlocks: input.pack.sourceBackedBlocks,
        plan: input.plan,
      })
      if (normalized.rules.length === 0) {
        return {
          rules: fallback,
          pendingReviewRules: [],
          ...emptyClassifiedItems,
          warnings: ["模型草案生成未返回可用 RuleCard，已保留合并阶段草案。", ...normalized.warnings],
          usedModel: false,
        }
      }
      return {
        rules: normalized.rules,
        pendingReviewRules: normalized.pendingReviewRules,
        implementationGuidanceItems: normalized.implementationGuidanceItems,
        riskLimitItems: normalized.riskLimitItems,
        referenceOnlyItems: normalized.referenceOnlyItems,
        warnings: normalized.warnings,
        usedModel: true,
        stats: normalized.stats,
      }
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) throw abortError("Guideline draft composition aborted.")
      return {
        rules: fallback,
        pendingReviewRules: [],
        ...emptyClassifiedItems,
        warnings: [`模型草案生成失败，已保留合并阶段草案：${error instanceof Error ? error.message : String(error)}`],
        usedModel: false,
      }
    }
  }
}

function normalizeRules(rawRules: Array<Partial<RuleCardSpec>>, fallbackRules: RuleCardSpec[], plan?: DocumentPlan) {
  return rawRules
    .map((raw, index) => normalizeRule(raw, fallbackRules, index, plan))
    .filter((rule): rule is RuleCardSpec => Boolean(rule))
}

function normalizeRule(raw: Partial<RuleCardSpec>, fallbackRules: RuleCardSpec[], index: number, plan?: DocumentPlan): RuleCardSpec | undefined {
  const fallback = findFallbackRule(raw, fallbackRules, index)
  const sources = cleanStrings(raw.sources).length ? cleanStrings(raw.sources) : fallback?.sources ?? []
  const name = cleanText(raw.name) || fallback?.name
  const description = cleanText(raw.description) || fallback?.description
  if (!name || !description) return undefined
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
    sourceBackedBlocks: raw.sourceBackedBlocks?.length ? raw.sourceBackedBlocks : fallback?.sourceBackedBlocks,
    preservedExamples: raw.preservedExamples?.length ? raw.preservedExamples : fallback?.preservedExamples,
    generatedExamples: raw.generatedExamples?.length ? normalizeExamples(raw.generatedExamples, sources) : fallback?.generatedExamples,
    sourceDerivedItems: raw.sourceDerivedItems?.length ? raw.sourceDerivedItems : fallback?.sourceDerivedItems,
    exampleWarnings: raw.exampleWarnings?.length ? cleanStrings(raw.exampleWarnings) : fallback?.exampleWarnings,
  }
  const planned = plan ? normalizeRuleCardForPlan(rule, plan) : rule
  return normalizeRuleCardReadableText(planned)
}

function normalizeExamples(examples: NonNullable<RuleCardSpec["generatedExamples"]>, sourceRefs: string[]) {
  return examples.map((example, index) => ({
    ...example,
    id: cleanText(example.id) || `generated-example-${index + 1}`,
    title: cleanText(example.title) || "补充示例",
    explanation: cleanText(example.explanation) || "该示例根据当前规则语义生成，用于帮助评审和落地，不是原文摘录。",
    sourceRefs: cleanStrings(example.sourceRefs).length ? cleanStrings(example.sourceRefs) : sourceRefs,
    origin: example.origin === "adapted" ? "adapted" as const : "generated" as const,
    generationMode: example.generationMode === "adapted-from-source" ? "adapted-from-source" as const : "model-generated-from-rule" as const,
    isVerbatim: false as const,
  }))
}

function findFallbackRule(raw: Partial<RuleCardSpec>, fallbackRules: RuleCardSpec[], index: number) {
  const ruleId = cleanText(raw.ruleId)
  const name = cleanText(raw.name)
  return fallbackRules.find((rule) => rule.ruleId === ruleId)
    ?? fallbackRules.find((rule) => name && rule.name === name)
    ?? fallbackRules[index]
}

function compactRule(rule: RuleCardSpec) {
  return {
    ruleId: rule.ruleId,
    name: rule.name,
    priority: rule.priority,
    scope: rule.scope,
    description: rule.description,
    recommended: rule.recommended,
    discouraged: rule.discouraged,
    rationale: rule.rationale,
    exceptions: rule.exceptions,
    sources: rule.sources,
    sourceRole: rule.sourceRole,
    sourceOrigin: rule.sourceOrigin,
    generatedExamples: rule.generatedExamples?.slice(0, 1).map((example) => ({
      title: example.title,
      exampleFormat: example.exampleFormat,
      badExample: example.badExample,
      goodExample: example.goodExample,
      explanation: example.explanation,
    })),
  }
}

function cleanText(input: unknown) {
  return String(input ?? "").replace(/\s+/g, " ").trim()
}

function cleanStrings(input: unknown) {
  return Array.isArray(input) ? input.map(cleanText).filter(Boolean) : []
}

function normalizePriority(input: unknown): RuleCardSpec["priority"] | undefined {
  return input === "必须" || input === "应该" || input === "建议" ? input : undefined
}

function normalizeRole(input: unknown) {
  return input === "internal" || input === "external" || input === "unknown" ? input : undefined
}

function normalizeOrigin(input: unknown) {
  return input === "internal_company" || input === "external_public" || input === "external_licensed" || input === "unknown" ? input : undefined
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
}

function abortError(message: string) {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
