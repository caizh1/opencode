import type { DocumentPlan, DocumentSection, ReferenceDocRole, RuleCardSpec, SourceOrigin, WordDocSpec } from "./types"

export function applyRuleOrganizationPlanToSpec(spec: WordDocSpec, plan?: DocumentPlan): WordDocSpec {
  if (!plan) return spec
  const rules = collectBodyRules(spec.sections)
  const appendices = applyExternalRuleAppendix(spec.appendices ?? [], rules, plan)
  return {
    ...spec,
    sections: applyRuleOrganizationPlanToSections(spec.sections, plan),
    appendices,
  }
}

export function applyRuleOrganizationPlanToSections(sections: DocumentSection[], plan?: DocumentPlan): DocumentSection[] {
  if (!plan) return sections
  const teamRulesIndex = sections.findIndex((section) => section.id === "team-rules")
  if (teamRulesIndex < 0) return sections
  const teamRules = sections[teamRulesIndex]!
  const rules = teamRules.ruleCards ?? []
  if (rules.length === 0) return sections

  const bodyRules = bodyRulesForPlan(rules, plan)
  const organized = organizeRuleCardsForPlan(bodyRules, plan)
  const before = sections.slice(0, teamRulesIndex)
  const after = sections.slice(teamRulesIndex + 1).filter((section) => !section.id.startsWith("team-rules-"))

  if (plan.ruleSectioningPolicy === "single-section") {
    return [
      ...before,
      { ...teamRules, ruleCards: organized },
      ...after,
    ]
  }

  const groupSections = ruleGroupSections(organized, plan)
  return [
    ...before,
    {
      ...teamRules,
      ruleCards: undefined,
      paragraphs: [
        ...(teamRules.paragraphs ?? []),
        sectioningSummary(plan),
      ],
    },
    ...groupSections,
    ...after,
  ]
}

export function organizeRuleCardsForPlan(rules: RuleCardSpec[], plan?: DocumentPlan): RuleCardSpec[] {
  if (!plan || plan.ruleOrderingPolicy === "model-planned") return [...rules]
  const indexed = rules.map((rule, index) => ({ rule, index }))
  indexed.sort((left, right) => {
    const primary = compareRuleByPolicy(left.rule, right.rule, plan)
    return primary || left.index - right.index
  })
  return indexed.map((item) => item.rule)
}

export function inferRuleSourceRole(rule: RuleCardSpec): ReferenceDocRole {
  const explicit = normalizeRole(rule.sourceRole)
  if (explicit) return explicit
  const origins = collectRuleOrigins(rule)
  if (origins.includes("internal_company")) return "internal"
  if (origins.some((origin) => origin === "external_public" || origin === "external_licensed")) return "external"
  const roles = collectRuleRoles(rule)
  if (roles.includes("internal")) return "internal"
  if (roles.includes("external")) return "external"
  return "unknown"
}

function bodyRulesForPlan(rules: RuleCardSpec[], plan: DocumentPlan) {
  if (plan.externalRulePlacement === "main-body") return rules
  return rules.filter((rule) => inferRuleSourceRole(rule) !== "external")
}

function applyExternalRuleAppendix(appendices: DocumentSection[], rules: RuleCardSpec[], plan: DocumentPlan) {
  const base = appendices.filter((section) => section.id !== "appendix-external-rules")
  if (plan.externalRulePlacement !== "appendix") return base
  const externalRules = organizeRuleCardsForPlan(rules.filter((rule) => inferRuleSourceRole(rule) === "external"), plan)
  if (externalRules.length === 0) return base
  const appendix: DocumentSection = {
    id: "appendix-external-rules",
    level: 1,
    title: "附录 C：行业通用补强规则",
    paragraphs: [
      "以下规则主要来自外部或行业通用参考资料，作为团队规范的补强内容单独列入附录，正式落地前建议结合项目实践复核。",
    ],
    ruleCards: externalRules,
  }
  return [
    ...base,
    appendix,
  ]
}

function collectBodyRules(sections: DocumentSection[]) {
  const teamRules = sections.find((section) => section.id === "team-rules")
  if (teamRules?.ruleCards?.length) return teamRules.ruleCards
  return sections.flatMap((section) => section.ruleCards ?? [])
}

function ruleGroupSections(rules: RuleCardSpec[], plan: DocumentPlan): DocumentSection[] {
  if (plan.ruleSectioningPolicy === "split-by-source-role") {
    return [
      groupSection("team-rules-internal", "公司内部基线规则", rules.filter((rule) => inferRuleSourceRole(rule) === "internal")),
      groupSection("team-rules-external", "行业通用补强规则", rules.filter((rule) => inferRuleSourceRole(rule) === "external")),
      groupSection("team-rules-unknown", "来源待确认规则", rules.filter((rule) => inferRuleSourceRole(rule) === "unknown")),
    ].filter((section) => (section.ruleCards?.length ?? 0) > 0)
  }
  if (plan.ruleSectioningPolicy === "split-by-priority") {
    return [
      groupSection("team-rules-priority-must", "必须级规则", rules.filter((rule) => rule.priority === "必须")),
      groupSection("team-rules-priority-should", "应该级规则", rules.filter((rule) => rule.priority === "应该")),
      groupSection("team-rules-priority-recommend", "建议级规则", rules.filter((rule) => rule.priority === "建议")),
    ].filter((section) => (section.ruleCards?.length ?? 0) > 0)
  }
  if (plan.ruleSectioningPolicy === "split-by-category") {
    const byScope = new Map<string, RuleCardSpec[]>()
    for (const rule of rules) {
      const scope = rule.scope || "通用编码原则"
      byScope.set(scope, [...(byScope.get(scope) ?? []), rule])
    }
    return [...byScope.entries()].map(([scope, group], index) => groupSection(`team-rules-category-${index + 1}`, scope, group))
  }
  return []
}

function groupSection(id: string, title: string, ruleCards: RuleCardSpec[]): DocumentSection {
  return {
    id,
    level: 2,
    title,
    ruleCards,
  }
}

function sectioningSummary(plan: DocumentPlan) {
  if (plan.ruleSectioningPolicy === "split-by-source-role") return "本节按来源角色组织：公司内部基线规则优先展示，行业通用补强规则随后展示，来源待确认规则放在最后。"
  if (plan.ruleSectioningPolicy === "split-by-priority") return "本节按规则强制级别组织，便于团队优先落地必须级规则。"
  if (plan.ruleSectioningPolicy === "split-by-category") return "本节按规则主题分类组织，便于按模块进行评审和维护。"
  return "本节按用户指定策略组织规则顺序。"
}

function compareRuleByPolicy(left: RuleCardSpec, right: RuleCardSpec, plan: DocumentPlan) {
  if (plan.ruleOrderingPolicy === "internal-first") {
    return sourceRoleRank(left, ["internal", "external", "unknown"]) - sourceRoleRank(right, ["internal", "external", "unknown"]) || compareRuleIdNatural(left, right) || priorityRank(left) - priorityRank(right) || textCompare(left.scope, right.scope)
  }
  if (plan.ruleOrderingPolicy === "external-first") {
    return sourceRoleRank(left, ["external", "internal", "unknown"]) - sourceRoleRank(right, ["external", "internal", "unknown"]) || compareRuleIdNatural(left, right) || priorityRank(left) - priorityRank(right) || textCompare(left.scope, right.scope)
  }
  if (plan.ruleOrderingPolicy === "priority-first") {
    return priorityRank(left) - priorityRank(right) || sourceRoleRank(left, ["internal", "external", "unknown"]) - sourceRoleRank(right, ["internal", "external", "unknown"]) || compareRuleIdNatural(left, right) || textCompare(left.scope, right.scope)
  }
  if (plan.ruleOrderingPolicy === "by-category") {
    return textCompare(left.scope, right.scope) || compareRuleIdNatural(left, right) || priorityRank(left) - priorityRank(right) || sourceRoleRank(left, ["internal", "external", "unknown"]) - sourceRoleRank(right, ["internal", "external", "unknown"])
  }
  return 0
}

function compareRuleIdNatural(left: RuleCardSpec, right: RuleCardSpec) {
  const leftId = parseNaturalRuleId(left.ruleId)
  const rightId = parseNaturalRuleId(right.ruleId)
  if (!leftId || !rightId || leftId.prefix !== rightId.prefix) return 0
  return leftId.number - rightId.number
}

function parseNaturalRuleId(ruleId: string | undefined) {
  const match = String(ruleId ?? "").trim().toUpperCase().match(/^([A-Z][A-Z0-9_-]*?)[-_]?(\d+)$/)
  if (!match) return undefined
  return {
    prefix: match[1]!.replace(/[-_]+$/g, ""),
    number: Number.parseInt(match[2]!, 10),
  }
}

function sourceRoleRank(rule: RuleCardSpec, order: ReferenceDocRole[]) {
  const index = order.indexOf(inferRuleSourceRole(rule))
  return index >= 0 ? index : order.length
}

function priorityRank(rule: RuleCardSpec) {
  if (rule.priority === "必须") return 0
  if (rule.priority === "应该") return 1
  return 2
}

function textCompare(left: string | undefined, right: string | undefined) {
  return String(left ?? "").localeCompare(String(right ?? ""), "zh-CN")
}

function collectRuleOrigins(rule: RuleCardSpec): SourceOrigin[] {
  const values = [
    rule.sourceOrigin,
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.source.sourceOrigin),
    ...(rule.preservedExamples ?? []).map((block) => block.source.sourceOrigin),
  ]
  return values.filter((value): value is SourceOrigin => value === "internal_company" || value === "external_public" || value === "external_licensed" || value === "unknown")
}

function collectRuleRoles(rule: RuleCardSpec): ReferenceDocRole[] {
  const values = [
    rule.sourceRole,
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.source.sourceRole),
    ...(rule.preservedExamples ?? []).map((block) => block.source.sourceRole),
  ]
  return values.map(normalizeRole).filter((value): value is ReferenceDocRole => Boolean(value))
}

function normalizeRole(role: unknown): ReferenceDocRole | undefined {
  if (role === "internal" || role === "external" || role === "unknown") return role
  return undefined
}
