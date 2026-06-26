import { collectCGuidelineRuleQualityIssues } from "./CCodingGuidelineQuality"
import { normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { guidelineDraftClassificationContract, guidelineDraftOutputSchema, normalizeDraftModelOutput, sourceBlockForModel, type DraftRuleModel } from "./GuidelineDraftModelContract"
import { normalizeRuleCardReadableText } from "./RuleLanguage"
import type { DocAgentModelProvider, DocumentPlan, EvidencePack, RuleCardSpec, SourceBackedBlock } from "./types"

export type GuidelineDraftReviewFinding = {
  severity: "critical" | "warning" | "note"
  ruleId?: string
  issue: string
  suggestedPatch?: DraftRuleModel
}

type ReviewJson = {
  findings?: GuidelineDraftReviewFinding[]
  warnings?: string[]
}

export type GuidelineDraftReviewResult = {
  rules: RuleCardSpec[]
  pendingReviewRules: RuleCardSpec[]
  findings: GuidelineDraftReviewFinding[]
  warnings: string[]
  fixedCriticalCount: number
}

const GENERIC_RULE_NAME_RE = /^(?:外部参考规则|通用规则|参考规则|未命名规则|规则\s*\d*|候选规则)$/i

export class GuidelineDraftReviewAgent {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async review(input: {
    question: string
    plan?: DocumentPlan
    pack: EvidencePack
    rules: RuleCardSpec[]
    signal?: AbortSignal
  }): Promise<GuidelineDraftReviewResult> {
    const warnings: string[] = []
    let findings: GuidelineDraftReviewFinding[] = []
    if (this.model) {
      try {
        const output = await this.model.completeJson<ReviewJson>({
          purpose: "review-guideline-draft",
          system: [
            "You are reviewing a generated C coding guideline draft against local Word evidence.",
            "Return JSON only.",
            guidelineDraftClassificationContract(),
            "Review semantics, source faithfulness, readability, example relevance, external paraphrasing, and placeholder rules.",
            "Use critical only when a formal RuleCard must be patched or removed from formal rules.",
            "For every critical finding, provide suggestedPatch when the rule can be fixed from evidence.",
            "If a rule cannot be made concrete, say so without a patch; the system will move it to pending review.",
            "Do not ask for external web search.",
          ].join("\n"),
          prompt: JSON.stringify({
            question: input.question,
            documentPlan: input.plan,
            evidence: {
              internalSummary: input.pack.internalSummary,
              externalSummary: input.pack.externalSummary,
              conflicts: input.pack.conflictRules.map((conflict) => ({
                id: conflict.id,
                title: conflict.title,
                recommendation: conflict.recommendation,
                decision: conflict.decision,
              })),
              sourceBackedBlocks: input.pack.sourceBackedBlocks.slice(0, 80).map(sourceBlockForModel),
            },
            rules: input.rules.map((rule) => ({
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
              generatedExamples: rule.generatedExamples?.map((example) => ({
                title: example.title,
                exampleFormat: example.exampleFormat,
                badExample: example.badExample,
                badExampleReason: example.badExampleReason,
                goodExample: example.goodExample,
                explanation: example.explanation,
                sourceRefs: example.sourceRefs,
                origin: example.origin,
              })),
            })),
            outputSchema: {
              findings: [{
                severity: "critical | warning | note",
                ruleId: "C-001",
                issue: "中文问题描述",
                suggestedPatch: {
                  classification: "formal-rule | pending-review | implementation-guidance | risk-limit | reference-only | appendix-only",
                  name: "具体中文规则名",
                  scope: "具体适用范围",
                  description: "清晰规则说明",
                  recommended: "推荐写法",
                  discouraged: "不推荐写法",
                  rationale: "理由",
                  preservedExampleRefs: ["sourceBackedBlock.id for internal original examples"],
                  sourceBackedBlockRefs: ["sourceBackedBlock.id"],
                  generatedExamples: guidelineDraftOutputSchema().rules[0].generatedExamples,
                },
              }],
              warnings: ["string"],
            },
          }),
        }, input.signal)
        findings = normalizeFindings(output.findings ?? [])
        warnings.push(...(output.warnings ?? []))
      } catch (error) {
        if (isAbortError(error) || input.signal?.aborted) throw abortError("Guideline draft review aborted.")
        warnings.push(`模型草案审稿失败，已仅执行本地结构复核：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    findings.push(...localReviewFindings(input.rules))
    return applyFindings(input.rules, findings, warnings, input.pack.sourceBackedBlocks, input.plan)
  }
}

function applyFindings(
  inputRules: RuleCardSpec[],
  findings: GuidelineDraftReviewFinding[],
  warnings: string[],
  sourceBlocks: SourceBackedBlock[],
  plan?: DocumentPlan,
): GuidelineDraftReviewResult {
  const rules = new Map(inputRules.map((rule) => [rule.ruleId, rule]))
  const pending = new Map<string, RuleCardSpec>()
  let fixedCriticalCount = 0
  for (const finding of findings) {
    const rule = finding.ruleId ? rules.get(finding.ruleId) : undefined
    if (!rule) {
      if (finding.severity !== "note") warnings.push(`模型审稿发现未定位规则的问题：${finding.issue}`)
      continue
    }
    if (finding.severity === "critical") {
      if (finding.suggestedPatch && Object.keys(finding.suggestedPatch).length > 0) {
        const patched = normalizePatchedRule(rule, finding.suggestedPatch, sourceBlocks, warnings, plan)
        if (!isGenericRuleName(patched.name) && patched.description.trim()) {
          rules.set(rule.ruleId, patched)
          fixedCriticalCount += 1
          continue
        }
      }
      if (isPlaceholderFinding(finding) && !isGenericRuleName(rule.name)) {
        continue
      }
      if (/示例|example/i.test(finding.issue)) {
        rules.set(rule.ruleId, {
          ...rule,
          generatedExamples: [],
          exampleWarnings: [...(rule.exampleWarnings ?? []), `示例未能可靠生成，已移除并保留规则正文：${finding.issue}`],
        })
        warnings.push(`示例未能可靠生成，已移除：规则 ${rule.ruleId}「${rule.name}」。`)
        continue
      }
      rules.delete(rule.ruleId)
      pending.set(rule.ruleId, {
        ...rule,
        exampleWarnings: [...(rule.exampleWarnings ?? []), `已移入待人工复核候选项：${finding.issue}`],
      })
      warnings.push(`规则 ${rule.ruleId}「${rule.name}」已移入待人工复核候选项：${finding.issue}`)
      continue
    }
    if (finding.severity === "warning") {
      warnings.push(`模型审稿 warning：规则 ${rule.ruleId}「${rule.name}」：${finding.issue}`)
    }
  }

  for (const rule of [...rules.values()]) {
    if (!isGenericRuleName(rule.name)) continue
    rules.delete(rule.ruleId)
    pending.set(rule.ruleId, {
      ...rule,
      exampleWarnings: [...(rule.exampleWarnings ?? []), "规则名称仍为占位名，已移入待人工复核候选项。"],
    })
    warnings.push(`规则 ${rule.ruleId}「${rule.name}」未能具体化，已移入待人工复核候选项。`)
  }

  return {
    rules: [...rules.values()].map((rule) => plan ? normalizeRuleCardForPlan(normalizeRuleCardReadableText(rule), plan) : normalizeRuleCardReadableText(rule)),
    pendingReviewRules: [...pending.values()],
    findings: uniqueFindings(findings),
    warnings: [...new Set(warnings.filter((warning) => warning.trim()))],
    fixedCriticalCount,
  }
}

function normalizePatchedRule(rule: RuleCardSpec, patch: DraftRuleModel, sourceBlocks: SourceBackedBlock[], warnings: string[], plan?: DocumentPlan): RuleCardSpec {
  const normalized = normalizeDraftModelOutput({
    rules: [{
      ...patch,
      classification: patch.classification ?? "formal-rule",
      ruleId: rule.ruleId,
    }],
  }, {
    fallbackRules: [rule],
    sourceBlocks,
    plan,
  })
  warnings.push(...normalized.warnings)
  return normalized.rules[0] ?? (plan ? normalizeRuleCardForPlan(normalizeRuleCardReadableText(rule), plan) : normalizeRuleCardReadableText(rule))
}

function localReviewFindings(rules: RuleCardSpec[]): GuidelineDraftReviewFinding[] {
  const findings: GuidelineDraftReviewFinding[] = []
  for (const rule of rules) {
    if (isGenericRuleName(rule.name)) {
      findings.push({
        severity: "critical",
        ruleId: rule.ruleId,
        issue: "规则名称仍是占位名称，无法作为正式编码规则发布。",
      })
    }
  }
  for (const issue of collectCGuidelineRuleQualityIssues(rules)) {
    if (issue.code === "rule-example-mismatch") {
      findings.push({
        severity: "warning",
        issue: issue.message,
      })
    }
  }
  return findings
}

function normalizeFindings(findings: GuidelineDraftReviewFinding[]) {
  return findings
    .map((finding) => ({
      severity: normalizeSeverity(finding.severity),
      ruleId: cleanText(finding.ruleId),
      issue: cleanText(finding.issue),
      suggestedPatch: finding.suggestedPatch,
    }))
    .filter((finding) => finding.issue)
}

function normalizeSeverity(input: unknown): GuidelineDraftReviewFinding["severity"] {
  if (input === "critical" || input === "warning" || input === "note") return input
  return "warning"
}

function uniqueFindings(findings: GuidelineDraftReviewFinding[]) {
  const seen = new Set<string>()
  const result: GuidelineDraftReviewFinding[] = []
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.ruleId ?? ""}:${finding.issue}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(finding)
  }
  return result
}

function isGenericRuleName(name: string) {
  return GENERIC_RULE_NAME_RE.test(name.replace(/\s+/g, " ").trim())
}

function isPlaceholderFinding(finding: GuidelineDraftReviewFinding) {
  return /占位|未具体化|placeholder|generic/i.test(finding.issue)
}

function cleanText(input: unknown) {
  return String(input ?? "").replace(/\s+/g, " ").trim()
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
}

function abortError(message: string) {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
