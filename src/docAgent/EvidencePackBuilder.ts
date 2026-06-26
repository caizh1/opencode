import { localizeRuleCategory } from "./RuleLanguage"
import type { CandidateRule, ConflictRule, EvidencePack, ReferenceDocument, SourceBackedBlock } from "./types"

export class EvidencePackBuilder {
  build(input: { documents: ReferenceDocument[]; rules: CandidateRule[]; sourceBackedBlocks?: SourceBackedBlock[]; warnings?: string[] }): EvidencePack {
    const internal = input.rules.filter((rule) => rule.sourceRole === "internal")
    const external = input.rules.filter((rule) => rule.sourceRole === "external")
    const overlapping = external.filter((rule) => internal.some((item) => similarRule(item, rule)))
    const externalOnly = external.filter((rule) => !internal.some((item) => similarRule(item, rule)))
    const conflicts = external
      .flatMap((rule) => {
        const internalRule = internal.find((item) => item.category === rule.category && opposingPriority(item, rule))
        return internalRule ? [{ internal: internalRule, external: rule }] : []
      })
    const conflictRules: ConflictRule[] = conflicts
      .slice(0, 12)
      .map((conflict, index) => ({
        id: `conflict-${index + 1}`,
        title: conflict.external.title,
        internal: conflict.internal,
        external: conflict.external,
        recommendation: "保留内部规范作为默认要求；将外部资料中的理由、风险提示或落地建议作为补充，待团队评审后再决定是否升级。",
      }))
    const internalSummary = summarizeRules(internal)
    const externalSummary = summarizeRules(external)
    return {
      internalSummary: internalSummary.items,
      externalSummary: externalSummary.items,
      overlappingRules: overlapping,
      conflictRules,
      externallyRecommendedRules: externalOnly,
      unsuitableExternalRules: [],
      candidateRules: input.rules,
      sourceBackedBlocks: input.sourceBackedBlocks ?? [],
      warnings: [
        ...(input.warnings ?? []),
        ...internalSummary.warnings,
        ...externalSummary.warnings,
        ...(conflicts.length > conflictRules.length ? [`识别到 ${conflicts.length} 条潜在冲突，第一版仅展示前 ${conflictRules.length} 条供处理。`] : []),
        ...(internal.length === 0 ? ["未明确识别到公司内部规范规则。"] : []),
        ...(external.length === 0 ? ["未明确识别到外部参考规范规则。"] : []),
      ],
    }
  }
}

function summarizeRules(rules: CandidateRule[]) {
  const categories = new Map<string, number>()
  const warnings: string[] = []
  for (const rule of rules) {
    const category = localizeRuleCategory(rule.category)
    if (category.warning) warnings.push(category.warning)
    categories.set(category.text, (categories.get(category.text) ?? 0) + 1)
  }
  const items = [...categories.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => `${category}：${count} 条候选规则`)
  return { items, warnings: [...new Set(warnings)] }
}

function similarRule(left: CandidateRule, right: CandidateRule) {
  if (left.category !== right.category) return false
  const leftTokens = tokens(`${left.title} ${left.description}`)
  const rightTokens = tokens(`${right.title} ${right.description}`)
  const common = leftTokens.filter((token) => rightTokens.includes(token)).length
  return common >= 2 || left.title === right.title
}

function opposingPriority(left: CandidateRule, right: CandidateRule) {
  return left.priority === "must" && right.priority === "recommend" || left.priority === "recommend" && right.priority === "must"
}

function tokens(text: string) {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((token) => token.length >= 2).slice(0, 24)
}
