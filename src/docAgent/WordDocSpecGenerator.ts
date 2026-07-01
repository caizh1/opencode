import { normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { normalizeGeneratedExamplesInSpecRule } from "./GuidelineDraftModelContract"
import { applyRuleOrganizationPlanToSpec } from "./RuleOrganization"
import { normalizeWordDocSpecReadableText, preferChineseRuleFields } from "./RuleLanguage"
import type { DocAgentModelProvider, DocumentPlan, DocumentSection, EvidencePack, ReferenceDocument, RuleCardSpec, WordDocSpec } from "./types"

type SpecJson = Partial<WordDocSpec>

export class WordDocSpecGenerator {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async generate(input: {
    question: string
    plan?: DocumentPlan
    documents: ReferenceDocument[]
    pack: EvidencePack
    rules: RuleCardSpec[]
    sections: DocumentSection[]
  }, signal?: AbortSignal): Promise<WordDocSpec> {
    const fallback = deterministicSpec(input)
    try {
      if (!this.model) return finalizeSpec(fallback, input.plan)
      const generated = await this.model.completeJson<SpecJson>({
        purpose: "generate-word-spec",
        system: "Create a polished generic WordDocSpec for a team C coding guideline report. Return JSON only. For zh-CN documents, all human-readable rule and section content must be Simplified Chinese.",
        prompt: JSON.stringify({
          question: input.question,
          documentPlan: input.plan,
          sources: input.documents.map((doc) => ({ id: doc.id, title: doc.read.metadata.title, path: doc.read.metadata.path, role: doc.role, origin: doc.sourceOrigin })),
          rules: input.rules,
          requiredSections: input.sections.map((section) => section.title),
        }, null, 2),
      }, signal)
      return finalizeSpec(mergeGeneratedSpec(fallback, generated, input.plan), input.plan)
    } catch {
      return finalizeSpec(fallback, input.plan)
    }
  }
}

function finalizeSpec(spec: WordDocSpec, plan?: DocumentPlan) {
  return normalizeWordDocSpecReadableText(applyRuleOrganizationPlanToSpec(applyDocumentPlanToSpec(spec, plan), plan), plan)
}

function deterministicSpec(input: {
  plan?: DocumentPlan
  documents: ReferenceDocument[]
  pack: EvidencePack
  rules: RuleCardSpec[]
  sections: DocumentSection[]
}): WordDocSpec {
  const now = new Date().toISOString()
  const title = input.plan?.output.title || "团队 C 语言编码规范"
  const subtitle = input.plan?.output.subtitle || "基于公司内部规范与本地参考资料的团队版指南"
  const sources = input.documents.map((doc) => ({
    id: doc.id,
    title: doc.read.metadata.title,
    path: doc.read.metadata.path,
    role: doc.role,
    origin: doc.sourceOrigin,
  }))
  return {
    metadata: {
      title,
      subtitle,
      documentType: "C Coding Guideline",
      language: input.plan?.output.language ?? "zh-CN",
      generatedAt: now,
      author: "ChipMate Document Agent",
      sourceSummary: `整合 ${input.documents.length} 份本地 Word 资料，生成 ${input.rules.length} 条团队版规则。`,
    },
    sources,
    cover: {
      title,
      subtitle,
      preparedBy: "ChipMate Document Agent",
    },
    revisionHistory: [{
      version: "0.1",
      date: now.slice(0, 10),
      author: "ChipMate Document Agent",
      summary: "Phase 1 自动生成草案，待团队评审和目录更新。",
    }],
    executiveSummary: {
      paragraphs: [
        "本报告基于用户提供的本地 Word 资料，综合公司内部 C 编码规范与外部参考规范整理稿，形成面向团队落地的编码规范草案。",
        conflictSummary(input.plan),
      ],
      highlights: [
        `${input.rules.length} 条团队版规则卡片`,
        `${input.pack.conflictRules.length} 条冲突或待评审主题`,
        "生成文档包含 Checklist、静态检查建议、References 和附录",
      ],
    },
    sections: input.sections,
    appendices: [
      {
        id: "appendix-rule-index",
        level: 1,
        title: "附录 A：规则速查表",
        tables: [{
          headers: ["规则编号", "规则名称", "强制级别", "适用范围"],
          rows: input.rules.map((rule) => [rule.ruleId, rule.name, rule.priority, rule.scope]),
        }],
      },
      {
        id: "appendix-review-checklist",
        level: 1,
        title: "附录 B：Code Review Checklist",
        bullets: [
          "必须级规则是否全部满足或记录了例外审批。",
          "高风险指针、内存、整数和错误处理规则是否完成专项检查。",
          "引用外部规范的规则是否完成团队化改写和来源标注。",
        ],
      },
    ],
    references: sources.map((source) => ({
      sourceId: source.id,
      title: source.title,
      path: source.path,
      note: source.role === "internal" ? "内部规范来源" : "本地参考规范来源",
    })),
    qualityChecklist: {
      assumptions: [
        "用户已经将公开参考资料整理为本地 Word 文档并提供给插件。",
        "内部规范识别基于文件名和 @ 顺序，必要时需要人工复核。",
      ],
      limitations: [
        "首版不联网搜索，不读取 PDF/OCR，不继承输入 Word 的视觉样式。",
        "Word-native 目录页码需在 Word 中更新域；当前 VSIX 不运行本地字段刷新。",
      ],
      missingInputs: [],
      risks: [
        "授权规范资料的使用范围需由团队自行确认。",
      ],
    },
  }
}

function mergeGeneratedSpec(fallback: WordDocSpec, generated: SpecJson, plan?: DocumentPlan): WordDocSpec {
  const generatedSections = Array.isArray(generated.sections) && generated.sections.length > 0
    ? mergeGeneratedSections(fallback.sections, generated.sections, plan)
    : fallback.sections
  return {
    ...fallback,
    metadata: { ...fallback.metadata, ...(generated.metadata ?? {}) },
    executiveSummary: generated.executiveSummary ?? fallback.executiveSummary,
    sections: generatedSections,
    appendices: generated.appendices ?? fallback.appendices,
    references: generated.references ?? fallback.references,
    qualityChecklist: generated.qualityChecklist ?? fallback.qualityChecklist,
  }
}

function mergeGeneratedSections(fallback: WordDocSpec["sections"], generated: WordDocSpec["sections"], plan?: DocumentPlan) {
  const merged = generated.map((section) => {
    const fallbackSection = fallback.find((item) => item.id === section.id) ?? fallback.find((item) => item.title === section.title)
    if (!fallbackSection) return section
    return {
      ...section,
      sourceBackedBlocks: section.sourceBackedBlocks?.length ? section.sourceBackedBlocks : fallbackSection.sourceBackedBlocks,
      ruleCards: mergeGeneratedRuleCards(fallbackSection.ruleCards ?? [], section.ruleCards ?? [], plan),
    }
  })
  const existingIds = new Set(merged.map((section) => section.id))
  for (const section of fallback) {
    if (!existingIds.has(section.id)) merged.push(section)
  }
  return merged
}

function mergeGeneratedRuleCards(fallback: NonNullable<WordDocSpec["sections"][number]["ruleCards"]>, generated: NonNullable<WordDocSpec["sections"][number]["ruleCards"]>, plan?: DocumentPlan) {
  if (generated.length === 0) return fallback
  return generated.map((rule) => {
    const fallbackRule = fallback.find((item) => item.ruleId === rule.ruleId) ?? fallback.find((item) => item.name === rule.name)
    const readable = preferChineseRuleFields(rule, fallbackRule, plan)
    const merged = fallbackRule ? {
      ...readable,
      sourceBackedBlocks: rule.sourceBackedBlocks?.length ? rule.sourceBackedBlocks : fallbackRule.sourceBackedBlocks,
      preservedExamples: rule.preservedExamples?.length ? rule.preservedExamples : fallbackRule.preservedExamples,
      generatedExamples: fallbackRule.generatedExamples?.length ? fallbackRule.generatedExamples : rule.generatedExamples,
      sourceDerivedItems: rule.sourceDerivedItems?.length ? rule.sourceDerivedItems : fallbackRule.sourceDerivedItems,
      exampleWarnings: [...(fallbackRule.exampleWarnings ?? []), ...(rule.exampleWarnings ?? [])],
    } : readable
    const normalized = normalizeGeneratedExamplesInSpecRule(merged)
    return plan ? normalizeRuleCardForPlan(normalized, plan) : normalized
  })
}

function applyDocumentPlanToSpec(spec: WordDocSpec, plan?: DocumentPlan): WordDocSpec {
  if (!plan) return spec
  return {
    ...spec,
    metadata: {
      ...spec.metadata,
      title: plan.output.title,
      subtitle: plan.output.subtitle ?? spec.metadata.subtitle,
      language: plan.output.language,
    },
    cover: {
      ...(spec.cover ?? { title: plan.output.title }),
      title: plan.output.title,
      subtitle: plan.output.subtitle ?? spec.cover?.subtitle,
    },
    sections: spec.sections.map((section) => ({
      ...section,
      ruleCards: section.ruleCards?.map((rule) => normalizeRuleCardForPlan(normalizeGeneratedExamplesInSpecRule(rule), plan)),
    })),
    appendices: spec.appendices?.map((section) => ({
      ...section,
      ruleCards: section.ruleCards?.map((rule) => normalizeRuleCardForPlan(normalizeGeneratedExamplesInSpecRule(rule), plan)),
    })),
  }
}

function conflictSummary(plan?: DocumentPlan) {
  if (plan?.conflictPolicy === "prefer_internal") return "合并策略以内部规范为基线；若来源之间存在冲突，已按用户指令优先采用内部规范，外部资料仅作为理由、示例和差异说明的补强。"
  if (plan?.conflictPolicy === "prefer_external") return "若来源之间存在冲突，已按用户指令优先采用外部参考规范，并在差异说明中保留内部依据。"
  if (plan?.conflictPolicy === "keep_review") return "若来源之间存在冲突，已按用户指令保留为待评审事项，不自动覆盖任一来源。"
  return "合并策略以内部规范为基线，外部资料用于补强理由、示例、风险说明和执行建议；冲突内容不自动覆盖，而是进入冲突与处理建议。"
}
