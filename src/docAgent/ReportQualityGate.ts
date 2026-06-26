import { normalizeRuleScope } from "./DocumentPlanGenerator"
import { collectCGuidelineRuleQualityIssues } from "./CCodingGuidelineQuality"
import { collectUntranslatedRuleFields, collectUntranslatedSpecText, requiresChineseRules } from "./RuleLanguage"
import type { DocumentPlan, EvidencePack, QualityIssue, ReferenceDocument, RuleCardSpec, WordDocSpec } from "./types"
import { WordDocSpecValidator } from "./WordDocSpecValidator"

export class ReportQualityGate {
  private readonly validator = new WordDocSpecValidator()

  check(input: { documents: ReferenceDocument[]; pack: EvidencePack; rules: RuleCardSpec[]; spec: WordDocSpec; plan?: DocumentPlan }): QualityIssue[] {
    const issues = [...this.validator.validate(input.spec)]
    const internal = input.documents.filter((doc) => doc.role === "internal").length
    const external = input.documents.filter((doc) => doc.role === "external").length
    if (input.documents.length < 2) issues.push(error("insufficient-sources", "At least two local DOCX sources are required."))
    if (internal === 0) issues.push(warning("internal-source-uncertain", "内部规范来源识别不确定。"))
    if (external === 0) issues.push(warning("external-source-missing", "外部参考规范来源不足。"))
    if (input.rules.length < 6) issues.push(warning("few-rules", "提取到的规则数量偏少，建议补充更多资料或人工复核。"))
    if (!input.spec.sections.some(hasCodeExample)) issues.push(warning("missing-code-examples", "缺少推荐/不推荐代码示例。"))
    if (input.pack.conflictRules.length === 0) issues.push(warning("no-conflicts-found", "未识别到冲突规则；如果资料较完整，请人工确认是否确实无冲突。"))
    for (const issue of planIssues(input)) issues.push(issue)
    for (const warningText of input.pack.warnings) issues.push(warning("evidence-warning", warningText))
    return issues
  }
}

function planIssues(input: { pack: EvidencePack; rules: RuleCardSpec[]; spec: WordDocSpec; plan?: DocumentPlan }): QualityIssue[] {
  const plan = input.plan
  if (!plan) return []
  const issues: QualityIssue[] = []
  for (const requirement of plan.contentRequirements.filter((item) => item.required)) {
    if (!specHasRequirement(input.spec, requirement.instruction, requirement.id)) {
      issues.push(warning("missing-required-content", `用户要求的内容未完整进入文档：${requirement.instruction}`))
    }
  }
  if (plan.ruleCardPolicy?.requireMinimalExamplePerRule) {
    const missing = input.rules.filter((rule) => !hasRuleExample(rule))
    if (missing.length > 0) issues.push(warning("missing-rule-examples", `仍有 ${missing.length} 条规则缺少最小示例。`))
  }
  if (plan.ruleCardPolicy?.includeBadExampleReason) {
    const missingReasons = input.rules.filter((rule) =>
      (rule.generatedExamples ?? []).some((example) => example.badExample && !example.badExampleReason?.trim()),
    )
    if (missingReasons.length > 0) issues.push(warning("missing-bad-example-reasons", `仍有 ${missingReasons.length} 条规则的不推荐示例缺少不推荐原因。`))
  }
  for (const rule of input.rules) {
    for (const message of rule.exampleWarnings ?? []) {
      issues.push(warning("rule-example-quality", message))
    }
    if (!rule.sources?.length) {
      issues.push(error("missing-rule-source-ref", `规则 ${rule.ruleId}「${rule.name}」缺少来源依据，不能生成正式 Word。`))
    }
    for (const example of rule.generatedExamples ?? []) {
      if (!example.sourceRefs?.length) {
        issues.push(error("missing-example-source-ref", `规则 ${rule.ruleId}「${rule.name}」的生成示例缺少 sourceRefs，不能生成正式 Word。`))
      }
      if (example.isVerbatim !== false) {
        issues.push(error("invalid-generated-example-verbatim", `规则 ${rule.ruleId}「${rule.name}」的生成示例不能标记为原文摘录。`))
      }
    }
  }
  for (const issue of collectCGuidelineRuleQualityIssues(input.rules)) {
    issues.push(warning(`semantic-diagnostic-${issue.code}`, issue.message))
  }
  const invalidScopes = input.rules.filter((rule) => normalizeRuleScope(rule.scope) !== rule.scope || /c-gen|general-c|generic/i.test(rule.scope))
  if (invalidScopes.length > 0) issues.push(warning("unreadable-rule-scope", `存在 ${invalidScopes.length} 条规则的适用范围不可读，已建议归一化。`))
  if (requiresChineseRules(plan) || input.spec.metadata.language === "zh-CN") {
    const ruleIssues = input.rules.flatMap(collectUntranslatedRuleFields)
    const specIssues = collectUntranslatedSpecText(input.spec)
    const issuePaths = [...new Set([...ruleIssues, ...specIssues])]
    if (issuePaths.length > 0) issues.push(error("non-chinese-rule-content", `仍有 ${issuePaths.length} 处规则正文或规范说明不是简体中文，请先完成中文化后再生成正式 Word：${issuePaths.slice(0, 6).join("、")}`))
  }
  if (input.pack.conflictRules.length > 0 && plan.conflictPolicy !== "ask" && !input.pack.conflictDecisions?.length) {
    issues.push(warning("missing-auto-conflict-decisions", "用户指定了自动冲突策略，但证据包中未记录冲突决策。"))
  }
  return issues
}

function hasCodeExample(section: WordDocSpec["sections"][number]) {
  return Boolean(
    section.codeBlocks?.length
    || section.sourceBackedBlocks?.some((block) => block.kind === "code" || block.kind === "example")
    || section.ruleCards?.some((rule) =>
      rule.generatedExamples?.length
      || rule.preservedExamples?.some((block) => block.kind === "code" || block.kind === "example")
      || rule.sourceBackedBlocks?.some((block) => block.kind === "code" || block.kind === "example"),
    ),
  )
}

function hasRuleExample(rule: RuleCardSpec) {
  return Boolean(
    rule.generatedExamples?.length
    || rule.preservedExamples?.length
    || rule.sourceBackedBlocks?.some((block) => block.kind === "code" || block.kind === "example"),
  )
}

function specHasRequirement(spec: WordDocSpec, instruction: string, id: string) {
  const needle = normalizeRequirementText(instruction)
  return [...spec.sections, ...(spec.appendices ?? [])].some((section) =>
    section.id === id
    || normalizeRequirementText(section.title).includes(needle)
    || needle.includes(normalizeRequirementText(section.title))
    || section.paragraphs?.some((paragraph) => normalizeRequirementText(paragraph).includes(needle)),
  )
}

function normalizeRequirementText(input: string) {
  return input.replace(/\s+/g, "").replace(/章节|部分|内容|附录|清单|表格/g, "")
}

function error(code: string, message: string): QualityIssue {
  return { severity: "error", code, message }
}

function warning(code: string, message: string): QualityIssue {
  return { severity: "warning", code, message }
}
