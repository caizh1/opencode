import { CCodingGuidelineExamplePlanner } from "./CCodingGuidelineExamplePlanner"
import { inferCCodingGuidelineRuleKind, sanitizeCGuidelineRuleCards } from "./CCodingGuidelineQuality"
import { normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { normalizeRuleAnchor } from "./RuleAnchors"
import { inferRuleSourceRole } from "./RuleOrganization"
import { RuleLanguageNormalizer } from "./RuleLanguage"
import type { CandidateRule, ConflictResolutionDecision, DocAgentModelProvider, DocumentPlan, EvidencePack, ReferenceDocRole, RuleCardSpec, SourceOrigin } from "./types"

type MergeJson = {
  rules?: RuleCardSpec[]
  warnings?: string[]
}

export type GuidelineMergeProgress = {
  stage: "guidelines-start" | "guidelines-batch-start" | "guidelines-batch-success" | "guidelines-batch-warning" | "guidelines-success" | "normalize-start" | "normalize-success" | "examples-start" | "examples-success" | "fallback"
  message: string
  ruleCount?: number
  warningCount?: number
  warning?: string
  batchIndex?: number
  totalBatches?: number
}

export type GuidelineMergeOptions = {
  onProgress?: (progress: GuidelineMergeProgress) => void
}

export class GuidelineMerger {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async merge(pack: EvidencePack, plan?: DocumentPlan, signal?: AbortSignal, options: GuidelineMergeOptions = {}) {
    let fallbackWarning: string | undefined
    try {
      if (this.model) {
        const candidateRules = candidateRulesForMerge(pack)
        options.onProgress?.({
          stage: "guidelines-start",
          message: `调用模型合并团队规则卡（分批）：${candidateRules.length} 条候选规则`,
          ruleCount: candidateRules.length,
        })
        const result = await mergeGuidelinesInBatches(this.model, pack, candidateRules, plan, signal, options)
        const rules = result.rules
        options.onProgress?.({
          stage: "guidelines-success",
          message: `模型合并完成：${rules.length} 条团队规则卡`,
          ruleCount: rules.length,
          warningCount: result.warnings.length,
        })
        if (rules.length > 0) {
          options.onProgress?.({
            stage: "normalize-start",
            message: `中文化归一规则字段：${rules.length} 条规则`,
            ruleCount: rules.length,
          })
          const language = await new RuleLanguageNormalizer(this.model).normalize(rules, plan, signal)
          options.onProgress?.({
            stage: "normalize-success",
            message: `规则字段归一完成：${language.rules.length} 条规则 · warning ${language.warnings.length} 条`,
            ruleCount: language.rules.length,
            warningCount: language.warnings.length,
          })
          options.onProgress?.({
            stage: "examples-start",
            message: `挂载规则示例：${language.rules.length} 条规则`,
            ruleCount: language.rules.length,
          })
          const rulesWithExamples = withExamples(language.rules, plan)
          const quality = sanitizeCGuidelineRuleCards(rulesWithExamples)
          options.onProgress?.({
            stage: "examples-success",
            message: `规则示例挂载完成：${quality.rules.length} 条规则`,
            ruleCount: quality.rules.length,
          })
          return { rules: quality.rules, warnings: [...result.warnings, ...language.warnings, ...quality.warnings] }
        }
        fallbackWarning = "模型合并未产出可用规则，已改用本地确定性合并。"
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      // Deterministic fallback below keeps the flow usable when model JSON is not valid.
      fallbackWarning = `模型合并失败，已改用本地确定性合并：${error instanceof Error ? error.message : String(error)}`
    }
    options.onProgress?.({
      stage: "fallback",
      message: fallbackWarning ?? "未配置模型，使用本地确定性合并。",
      warning: fallbackWarning,
    })
    const fallbackRules = deterministicMerge(pack, plan)
    options.onProgress?.({
      stage: "normalize-start",
      message: `中文化归一本地合并规则：${fallbackRules.length} 条规则`,
      ruleCount: fallbackRules.length,
    })
    const language = await new RuleLanguageNormalizer().normalize(fallbackRules, plan, signal)
    options.onProgress?.({
      stage: "normalize-success",
      message: `规则字段归一完成：${language.rules.length} 条规则 · warning ${language.warnings.length} 条`,
      ruleCount: language.rules.length,
      warningCount: language.warnings.length,
    })
    options.onProgress?.({
      stage: "examples-start",
      message: `挂载规则示例：${language.rules.length} 条规则`,
      ruleCount: language.rules.length,
    })
    const rulesWithExamples = withExamples(language.rules, plan)
    const quality = sanitizeCGuidelineRuleCards(rulesWithExamples)
    options.onProgress?.({
      stage: "examples-success",
      message: `规则示例挂载完成：${quality.rules.length} 条规则`,
      ruleCount: quality.rules.length,
    })
    return { rules: quality.rules, warnings: [...(fallbackWarning ? [fallbackWarning] : []), ...language.warnings, ...quality.warnings] }
  }
}

const MERGE_RULES_PER_BATCH = 16
const MAX_SOURCE_BLOCKS_PER_MERGE_BATCH = 24
const MAX_FINAL_RULE_CARDS = 36

async function mergeGuidelinesInBatches(
  model: DocAgentModelProvider,
  pack: EvidencePack,
  candidateRules: CandidateRule[],
  plan: DocumentPlan | undefined,
  signal: AbortSignal | undefined,
  options: GuidelineMergeOptions,
) {
  const batches = chunkCandidateRulesForMerge(candidateRules)
  const warnings: string[] = []
  const mergedRules: RuleCardSpec[] = []
  for (const [index, batch] of batches.entries()) {
    if (signal?.aborted) throw abortError("Document guideline merge aborted.")
    const batchIndex = index + 1
    const batchPack = evidencePackForMergeBatch(pack, batch)
    options.onProgress?.({
      stage: "guidelines-batch-start",
      message: `模型合并第 ${batchIndex}/${batches.length} 批：${batch.length} 条候选规则`,
      ruleCount: batch.length,
      batchIndex,
      totalBatches: batches.length,
    })
    try {
      const result = await model.completeJson<MergeJson>({
        purpose: "merge-guidelines",
        system: "Merge C coding guideline evidence into team-facing rule cards. Keep internal requirements first. All user-readable RuleCard fields must be Simplified Chinese. Return JSON only.",
        prompt: mergePrompt(batchPack, plan),
      }, signal)
      const rules = normalizeRuleCards(result.rules ?? [], batchPack, plan)
      if (rules.length === 0) {
        throw new Error("model returned no usable rule cards for this batch")
      }
      mergedRules.push(...rules)
      warnings.push(...(result.warnings ?? []))
      options.onProgress?.({
        stage: "guidelines-batch-success",
        message: `模型合并第 ${batchIndex}/${batches.length} 批完成：${rules.length} 条规则卡`,
        ruleCount: rules.length,
        warningCount: result.warnings?.length ?? 0,
        batchIndex,
        totalBatches: batches.length,
      })
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError("Document guideline merge aborted.")
      const warning = `模型合并失败（第 ${batchIndex}/${batches.length} 批），已仅对该批使用本地确定性合并：${error instanceof Error ? error.message : String(error)}`
      warnings.push(warning)
      options.onProgress?.({
        stage: "guidelines-batch-warning",
        message: warning,
        warning,
        ruleCount: batch.length,
        batchIndex,
        totalBatches: batches.length,
      })
      mergedRules.push(...deterministicMerge(batchPack, plan))
    }
  }
  return {
    rules: renumberAndDedupeRules(mergedRules, pack, plan),
    warnings,
  }
}

function chunkCandidateRulesForMerge(rules: CandidateRule[]) {
  const sorted = [...rules].sort((left, right) => {
    const leftKey = `${candidateRoleRank(left.sourceRole)}:${left.sourceDocument}:${left.category}:${left.sourceSection}:${left.title}`
    const rightKey = `${candidateRoleRank(right.sourceRole)}:${right.sourceDocument}:${right.category}:${right.sourceSection}:${right.title}`
    return leftKey.localeCompare(rightKey, "zh-CN")
  })
  const batches: CandidateRule[][] = []
  for (let index = 0; index < sorted.length; index += MERGE_RULES_PER_BATCH) {
    batches.push(sorted.slice(index, index + MERGE_RULES_PER_BATCH))
  }
  return batches.length > 0 ? batches : [[]]
}

function evidencePackForMergeBatch(pack: EvidencePack, candidateRules: CandidateRule[]): EvidencePack {
  const ruleIds = new Set(candidateRules.map((rule) => rule.id))
  return {
    ...pack,
    candidateRules,
    overlappingRules: pack.overlappingRules.filter((rule) => ruleIds.has(rule.id)),
    externallyRecommendedRules: pack.externallyRecommendedRules.filter((rule) => ruleIds.has(rule.id)),
    unsuitableExternalRules: pack.unsuitableExternalRules.filter((rule) => ruleIds.has(rule.id)),
    conflictRules: pack.conflictRules.filter((conflict) => (conflict.internal && ruleIds.has(conflict.internal.id)) || (conflict.external && ruleIds.has(conflict.external.id))),
    sourceBackedBlocks: sourceBlocksForRules(candidateRules, pack, MAX_SOURCE_BLOCKS_PER_MERGE_BATCH),
  }
}

function renumberAndDedupeRules(rules: RuleCardSpec[], pack: EvidencePack, plan?: DocumentPlan) {
  const deduped: RuleCardSpec[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule.name?.trim() || !rule.description?.trim()) continue
    const key = normalizedRuleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    const withSources = {
      ...rule,
      sources: Array.isArray(rule.sources) && rule.sources.length > 0 ? uniqueStrings(rule.sources) : pack.candidateRules.slice(0, 2).map(candidateSourceRef),
      sourceBackedBlocks: Array.isArray(rule.sourceBackedBlocks) && rule.sourceBackedBlocks.length > 0 ? rule.sourceBackedBlocks : sourceBlocksForSourceRefs(rule.sources ?? [], pack),
    }
    deduped.push(withSourceMetadata(withSources, pack))
  }
  return deduped.slice(0, MAX_FINAL_RULE_CARDS).map((rule, index) => {
    const numbered = {
      ...rule,
      ruleId: `C-${String(index + 1).padStart(3, "0")}`,
    }
    const guarded = guardRuleEvidence(numbered, pack)
    return plan ? normalizeRuleCardForPlan(guarded, plan) : guarded
  })
}

function normalizedRuleKey(rule: RuleCardSpec) {
  const anchor = normalizeRuleAnchor(rule.sourceRuleAnchor) ?? sourceRuleAnchorFromSources(rule.sources ?? [])
  const semantic = semanticRuleKey(`${rule.name} ${rule.scope} ${rule.description} ${rule.recommended ?? ""}`)
  return anchor ? `${anchor}:${semantic}` : semantic
}

function normalizedCandidateRuleKey(rule: CandidateRule) {
  const semantic = semanticRuleKey(`${rule.title} ${rule.category} ${rule.description} ${rule.recommended ?? ""}`)
  return rule.sourceRuleAnchor ? `${rule.sourceRuleAnchor}:${semantic}` : semantic
}

function semanticRuleKey(text: string) {
  const normalized = normalizeKeyText(text)
  if (/(?:单一职责|single responsibility)/i.test(normalized)) return "function:single-responsibility"
  if (/(?:编译警告|告警|warning)/i.test(normalized)) return "static:compiler-warning"
  if (/(?:静态分析|检查闭环|cppcheck|clang-tidy|lint)/i.test(normalized)) return "static:analysis-closure"
  if (/(?:头文件保护|include guard|header guard|define保护)/i.test(normalized)) return "file:header-guard"
  if (/(?:源文件|头文件|文件组织|文件结构|\.c|\.h)/i.test(normalized)) return "file:layout"
  if (/(?:命名|前缀|naming|identifier)/i.test(normalized)) return `naming:${compactTopic(normalized)}`
  if (/(?:存储访问一致性|存储同步|多主设备|多核访问|共享变量|cache|ECC|原子性|barrier|DMAC|NFC)/i.test(normalized)) return `memory-consistency:${compactTopic(normalized)}`
  if (/(?:返回值|错误码|错误处理|return value|errno)/i.test(normalized)) return "error:return-value"
  if (/(?:循环|轮询|超时|上界|timeout|bounded)/i.test(normalized)) return "loop:bounded-timeout"
  if (/(?:ISR|中断服务|irq)/i.test(normalized)) return "isr:minimal"
  if (/(?:递归|recursion)/i.test(normalized)) return "control:recursion"
  if (/(?:缓冲区|数组|buffer|memcpy)/i.test(normalized)) return "memory:buffer-boundary"
  if (/(?:整数|溢出|强制转换|integer|overflow|cast)/i.test(normalized)) return "integer:range-cast"
  const kind = inferCCodingGuidelineRuleKindFromTextSafe(text)
  return `${kind}:${compactTopic(normalized)}`
}

function inferCCodingGuidelineRuleKindFromTextSafe(text: string) {
  return inferCCodingGuidelineRuleKind({
    ruleId: "C-000",
    name: text,
    priority: "应该",
    scope: "",
    description: text,
    sources: [],
  })
}

function compactTopic(text: string) {
  return text
    .replace(/(?:c-gen-\d+|c-rule-\d+|规则|建议|必须|应该|不得|禁止|使用|进行|保持|要求)/gi, "")
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length >= 2)
    .slice(0, 6)
    .join("-")
}

function normalizeKeyText(value: string | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase()
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function candidateSourceRef(rule: CandidateRule) {
  const section = rule.sourceRuleAnchor && !rule.sourceSection.includes(rule.sourceRuleAnchor)
    ? `${rule.sourceSection} > ${rule.sourceRuleAnchor}`
    : rule.sourceSection
  return `${rule.sourceDocument} / ${section}`
}

function guardRuleEvidence(rule: RuleCardSpec, pack: EvidencePack): RuleCardSpec {
  const sourceRuleAnchor = normalizeRuleAnchor(rule.sourceRuleAnchor) ?? sourceRuleAnchorFromSources(rule.sources)
  const internal = rule.sourceRole === "internal" || rule.sourceOrigin === "internal_company"
  if (!internal || !sourceRuleAnchor) return rule
  const candidate = evidenceCandidateForRule({ ...rule, sourceRuleAnchor }, pack)
  if (!candidate) return { ...rule, sourceRuleAnchor }
  const evidenceBlocks = sourceBlocksForRules([candidate], pack, 8)
  const expectedKind = inferCCodingGuidelineRuleKind(candidate)
  const warnings: string[] = []
  const next: RuleCardSpec = {
    ...rule,
    sourceRuleAnchor,
    sources: uniqueStrings([...rule.sources, candidateSourceRef(candidate)]),
    sourceBackedBlocks: uniqueSourceBlocks([
      ...(rule.sourceBackedBlocks ?? []).filter((block) => block.source.sourceRuleAnchor === sourceRuleAnchor),
      ...evidenceBlocks,
    ]),
  }
  repairRuleField(next, "description", candidate.description, expectedKind, warnings)
  repairRuleField(next, "recommended", candidate.recommended, expectedKind, warnings)
  repairRuleField(next, "discouraged", candidate.discouraged, expectedKind, warnings)
  repairRuleField(next, "rationale", candidate.rationale, expectedKind, warnings)
  repairRuleField(next, "exceptions", candidate.exceptions, expectedKind, warnings)
  repairRuleField(next, "rolloutAdvice", undefined, expectedKind, warnings)
  if (evidenceBlocks.some((block) => block.source.sourceOrigin === "internal_company" && (block.kind === "code" || block.kind === "example"))) {
    if ((next.generatedExamples ?? []).length > 0) warnings.push(`规则 ${next.ruleId}「${next.name}」已有同锚点内部来源示例，已移除模型生成示例。`)
    next.generatedExamples = []
  } else {
    next.generatedExamples = (next.generatedExamples ?? []).filter((example) => !exampleCrossWired(example, expectedKind))
  }
  if (warnings.length > 0) next.exampleWarnings = [...new Set([...(next.exampleWarnings ?? []), ...warnings])]
  return next
}

function evidenceCandidateForRule(rule: RuleCardSpec, pack: EvidencePack) {
  const candidates = candidateRulesForRule(rule, pack)
  return candidates.find((candidate) => candidate.sourceRuleAnchor && candidate.sourceRuleAnchor === rule.sourceRuleAnchor)
    ?? pack.candidateRules.find((candidate) => candidate.sourceRuleAnchor && candidate.sourceRuleAnchor === rule.sourceRuleAnchor && rule.sources.some((source) => source.includes(candidate.sourceDocument)))
    ?? candidates[0]
}

function repairRuleField(
  rule: RuleCardSpec,
  field: "description" | "recommended" | "discouraged" | "rationale" | "exceptions" | "rolloutAdvice",
  candidateValue: string | undefined,
  expectedKind: ReturnType<typeof inferCCodingGuidelineRuleKind>,
  warnings: string[],
) {
  const value = rule[field]
  if (!value?.trim()) {
    if (candidateValue?.trim()) rule[field] = candidateValue
    return
  }
  if (!fieldCrossWired(value, expectedKind)) return
  if (candidateValue?.trim()) {
    rule[field] = candidateValue
  } else {
    delete rule[field]
  }
  warnings.push(`规则 ${rule.ruleId}「${rule.name}」的${ruleFieldLabel(field)}与同锚点来源语义不一致，已按来源证据修正。`)
}

function fieldCrossWired(value: string, expectedKind: ReturnType<typeof inferCCodingGuidelineRuleKind>) {
  if (expectedKind !== "memory-consistency") return false
  return crossWiredStorageText(value)
}

function exampleCrossWired(example: NonNullable<RuleCardSpec["generatedExamples"]>[number], expectedKind: ReturnType<typeof inferCCodingGuidelineRuleKind>) {
  if (expectedKind !== "memory-consistency") return false
  return crossWiredStorageText(`${example.title} ${example.badExample ?? ""} ${example.goodExample ?? ""} ${example.explanation}`)
}

function crossWiredStorageText(value: string) {
  const text = normalizeKeyText(value)
  const hasWrongSignal = /(?:可能失败|返回值|错误码|memcpy\s*\(\s*buffer|buffer\s*==\s*null|einval|指针与内存安全)/i.test(text)
  const hasStorageSignal = /(?:存储同步|多主设备|多核访问|共享变量|cache|缓存|ecc|原子|barrier|synchronization|dmac|nfc|内存屏障|同步屏障|锁机制)/i.test(text)
  return hasWrongSignal && !hasStorageSignal
}

function uniqueSourceBlocks(blocks: NonNullable<RuleCardSpec["sourceBackedBlocks"]>) {
  const seen = new Set<string>()
  const result: NonNullable<RuleCardSpec["sourceBackedBlocks"]> = []
  for (const block of blocks) {
    if (seen.has(block.id)) continue
    seen.add(block.id)
    result.push(block)
  }
  return result
}

function ruleFieldLabel(field: string) {
  if (field === "description") return "规则说明"
  if (field === "recommended") return "推荐写法"
  if (field === "discouraged") return "不推荐写法"
  if (field === "rationale") return "理由"
  if (field === "exceptions") return "例外情况"
  return "团队落地建议"
}

function withExamples(rules: RuleCardSpec[], plan?: DocumentPlan) {
  return new CCodingGuidelineExamplePlanner(plan).attachExamples(rules.map((rule) => plan ? normalizeRuleCardForPlan(rule, plan) : rule))
}

function deterministicMerge(pack: EvidencePack, plan?: DocumentPlan): RuleCardSpec[] {
  const groups = new Map<string, CandidateRule[]>()
  for (const rule of candidateRulesForMerge(pack)) {
    const key = normalizedCandidateRuleKey(rule)
    const existing = groups.get(key) ?? []
    existing.push(rule)
    groups.set(key, existing)
  }
  return [...groups.values()].slice(0, 36).map((rules, index) => {
    const primary = rules.find((rule) => rule.sourceRole === "internal") ?? rules[0]!
    const supplemental = rules.find((rule) => rule !== primary)
    const rule = {
      ruleId: `C-${String(index + 1).padStart(3, "0")}`,
      name: primary.title,
      priority: priorityLabel(primary.priority),
      scope: primary.category,
      description: primary.description,
      recommended: primary.recommended || supplemental?.recommended,
      discouraged: primary.discouraged || supplemental?.discouraged,
      rationale: primary.rationale || supplemental?.rationale,
      exceptions: primary.exceptions || supplemental?.exceptions || "确需例外时，应在代码评审记录中说明原因、影响范围和替代风险控制措施。",
      sources: rules.map(candidateSourceRef),
      sourceRole: primaryRuleRole(rules),
      sourceOrigin: primaryRuleOrigin(rules),
      sourceRuleAnchor: primary.sourceRuleAnchor,
      sourceRoleReason: "根据候选规则来源角色推断；同时存在内部和外部来源时以内部规则为主。",
      rolloutAdvice: "纳入团队 Code Review Checklist；高风险规则优先配置静态检查或人工审查项。",
      sourceBackedBlocks: sourceBlocksForRules(rules, pack),
    }
    return plan ? normalizeRuleCardForPlan(rule, plan) : rule
  })
}

function normalizeRuleCards(rules: RuleCardSpec[], pack: EvidencePack, plan?: DocumentPlan) {
  return rules
    .filter((rule) => rule.name?.trim() && rule.description?.trim())
    .map((rule, index) => {
      const normalized = {
      ruleId: rule.ruleId || `C-${String(index + 1).padStart(3, "0")}`,
      name: rule.name,
      priority: rule.priority === "必须" || rule.priority === "应该" || rule.priority === "建议" ? rule.priority : "应该",
      scope: rule.scope || "通用编码原则",
      description: rule.description,
      recommended: rule.recommended,
      discouraged: rule.discouraged,
      rationale: rule.rationale,
      exceptions: rule.exceptions,
      sources: Array.isArray(rule.sources) && rule.sources.length > 0 ? rule.sources : pack.candidateRules.slice(0, 2).map(candidateSourceRef),
      sourceRole: normalizeReferenceDocRole(rule.sourceRole),
      sourceOrigin: normalizeSourceOrigin(rule.sourceOrigin),
      sourceRuleAnchor: normalizeRuleAnchor(rule.sourceRuleAnchor) ?? sourceRuleAnchorFromSources(rule.sources ?? []),
      sourceRoleReason: rule.sourceRoleReason,
      rolloutAdvice: rule.rolloutAdvice,
      sourceBackedBlocks: Array.isArray(rule.sourceBackedBlocks) && rule.sourceBackedBlocks.length > 0 ? rule.sourceBackedBlocks : sourceBlocksForSourceRefs(rule.sources ?? [], pack),
      preservedExamples: rule.preservedExamples,
      generatedExamples: rule.generatedExamples,
      exampleWarnings: rule.exampleWarnings,
      }
      const withMetadata = withSourceMetadata(normalized, pack)
      return plan ? normalizeRuleCardForPlan(withMetadata, plan) : withMetadata
    })
}

function mergePrompt(pack: EvidencePack, plan?: DocumentPlan) {
  const decisions = conflictDecisionSummaries(pack)
  return [
    "User document plan:",
    JSON.stringify(plan ?? {}, null, 2),
    "",
    plan?.ruleCardPolicy?.rewriteNamesForReadability ? "Rewrite rule names so a team engineer can understand them at a glance." : "",
    plan?.ruleCardPolicy?.rewriteScopesForReadability ? "Use readable Chinese rule scopes; never use internal slugs such as c-gen or generic labels." : "",
    "All user-readable RuleCard fields must be Simplified Chinese: name, scope, description, recommended, discouraged, rationale, exceptions and rolloutAdvice. English public references are evidence only; do not copy English rule sentences into the final RuleCard. Keep code identifiers, file names, standard acronyms and source refs unchanged.",
    plan?.ruleCardPolicy?.requireMinimalExamplePerRule ? "Each core rule should be suitable for one minimal example. The example must reflect that exact rule; do not use generic pointer, buffer, or return-value examples for unrelated rules. File structure, naming, process, or checklist rules may use non-code examples." : "",
    plan?.ruleCardPolicy?.includeBadExampleReason ? "When a generated example has badExample, also provide badExampleReason as a separate explanation of why the bad example violates this exact rule. Do not put the reason inside the badExample code/text block." : "",
    "",
    "Evidence summary:",
    JSON.stringify({
      internalSummary: pack.internalSummary,
      externalSummary: pack.externalSummary,
      conflicts: pack.conflictRules.map((item) => ({
        title: item.title,
        recommendation: item.recommendation,
        decision: item.decision ? decisionLabel(item.decision.choice) : undefined,
      })),
      conflictDecisions: decisions,
      rules: candidateRulesForMerge(pack).slice(0, 80).map((rule) => ({
        title: rule.title,
        category: rule.category,
        priority: rule.priority,
        description: rule.description,
        sourceRole: rule.sourceRole,
        sourceRuleAnchor: rule.sourceRuleAnchor,
        source: candidateSourceRef(rule),
      })),
      sourceBackedBlocks: pack.sourceBackedBlocks.slice(0, 36).map((block) => ({
        kind: block.kind,
        title: block.title,
        preserveMode: block.preserveMode,
        sourceRole: block.source.sourceRole,
        sourceRuleAnchor: block.source.sourceRuleAnchor,
        source: `${block.source.sourcePath} / ${block.source.headingPath.join(" > ") || "未命名章节"}`,
        note: block.note,
      })),
    }, null, 2),
    "",
    "Return JSON shape:",
    '{"rules":[{"ruleId":"C-001","name":"","priority":"必须|应该|建议","scope":"","description":"","recommended":"","discouraged":"","rationale":"","exceptions":"","sources":[],"sourceRole":"internal|external|unknown","sourceOrigin":"internal_company|external_public|external_licensed|unknown","sourceRuleAnchor":"","sourceRoleReason":"","rolloutAdvice":""}],"warnings":[]}',
  ].join("\n")
}

function candidateRoleRank(role: ReferenceDocRole) {
  if (role === "internal") return 0
  if (role === "external") return 1
  return 2
}

function priorityLabel(priority: CandidateRule["priority"]): "必须" | "应该" | "建议" {
  if (priority === "must") return "必须"
  if (priority === "should") return "应该"
  return "建议"
}

function candidateRulesForMerge(pack: EvidencePack) {
  const excluded = new Set<string>()
  const decisions = new Map((pack.conflictDecisions ?? []).map((decision) => [decision.conflictId, decision]))
  for (const conflict of pack.conflictRules) {
    const decision = decisions.get(conflict.id) ?? conflict.decision
    if (!decision || decision.choice === "review") continue
    if (decision.choice === "internal" && conflict.external) excluded.add(conflict.external.id)
    if (decision.choice === "external" && conflict.internal) excluded.add(conflict.internal.id)
  }
  return pack.candidateRules.filter((rule) => !excluded.has(rule.id))
}

function sourceBlocksForRules(rules: CandidateRule[], pack: EvidencePack, limit = 4) {
  const anchored = pack.sourceBackedBlocks.filter((block) => rules.some((rule) => blockMatchesRuleAnchor(block, rule)))
  const fallback = pack.sourceBackedBlocks.filter((block) => !anchored.includes(block) && rules.some((rule) => blockMatchesRule(block, rule)))
  const result = anchored.length > 0 ? anchored : fallback
  return sortSourceBlocks(result).slice(0, limit)
}

function sourceBlocksForSourceRefs(sources: string[], pack: EvidencePack) {
  if (!sources.length) return []
  const result = pack.sourceBackedBlocks.filter((block) => sources.some((source) => sourceMatchesBlock(source, block)))
  return sortSourceBlocks(result).slice(0, 4)
}

function blockMatchesRule(block: EvidencePack["sourceBackedBlocks"][number], rule: CandidateRule) {
  if (block.source.sourcePath !== rule.sourceDocument) return false
  if (rule.sourceRuleAnchor || block.source.sourceRuleAnchor) return Boolean(rule.sourceRuleAnchor && block.source.sourceRuleAnchor && rule.sourceRuleAnchor === block.source.sourceRuleAnchor)
  const blockSection = block.source.headingPath.join(" > ") || "未命名章节"
  const leaf = block.source.headingPath.at(-1)
  return blockSection === rule.sourceSection || blockSection.includes(rule.sourceSection) || Boolean(leaf && rule.sourceSection.includes(leaf))
}

function blockMatchesRuleAnchor(block: EvidencePack["sourceBackedBlocks"][number], rule: CandidateRule) {
  return Boolean(
    rule.sourceRuleAnchor
    && block.source.sourceRuleAnchor
    && rule.sourceRuleAnchor === block.source.sourceRuleAnchor
    && block.source.sourcePath === rule.sourceDocument,
  )
}

function sourceMatchesBlock(source: string, block: EvidencePack["sourceBackedBlocks"][number]) {
  const blockSection = block.source.headingPath.join(" > ") || "未命名章节"
  const leaf = block.source.headingPath.at(-1)
  return source.includes(block.source.sourcePath)
    && (
      Boolean(block.source.sourceRuleAnchor && source.includes(block.source.sourceRuleAnchor))
      || source.includes(blockSection)
      || Boolean(leaf && source.includes(leaf))
    )
}

function withSourceMetadata(rule: RuleCardSpec, pack: EvidencePack): RuleCardSpec {
  const candidates = candidateRulesForRule(rule, pack)
  const role = normalizeReferenceDocRole(rule.sourceRole)
    ?? primaryRoleFromSourceBlocks(rule)
    ?? (candidates.length ? primaryRuleRole(candidates) : undefined)
    ?? inferRuleSourceRole(rule)
  const origin = normalizeSourceOrigin(rule.sourceOrigin)
    ?? primaryOriginFromSourceBlocks(rule)
    ?? (candidates.length ? primaryRuleOrigin(candidates) : undefined)
    ?? originForRole(role)
  const sourceRuleAnchor = normalizeRuleAnchor(rule.sourceRuleAnchor)
    ?? sourceRuleAnchorFromSources(rule.sources ?? [])
    ?? candidates.find((candidate) => candidate.sourceRuleAnchor)?.sourceRuleAnchor
    ?? sourceRuleAnchorFromBlocks(rule)
  return {
    ...rule,
    sourceRole: role,
    sourceOrigin: origin,
    sourceRuleAnchor,
    sourceRoleReason: rule.sourceRoleReason || (candidates.length ? "根据规则来源依据和候选规则来源角色推断。" : "未找到明确候选来源，按规则已有来源块或 unknown 处理。"),
  }
}

function candidateRulesForRule(rule: RuleCardSpec, pack: EvidencePack) {
  const sources = rule.sources ?? []
  if (!sources.length) return []
  return pack.candidateRules.filter((candidate) => sources.some((source) => sourceMatchesCandidate(source, candidate)))
}

function sourceMatchesCandidate(source: string, candidate: CandidateRule) {
  const leaf = candidate.sourceLocation.headingPath?.at(-1)
  return source.includes(candidate.sourceDocument)
    && (
      Boolean(candidate.sourceRuleAnchor && source.includes(candidate.sourceRuleAnchor))
      || source.includes(candidate.sourceSection)
      || Boolean(leaf && source.includes(leaf))
    )
}

function primaryRuleRole(rules: CandidateRule[]): ReferenceDocRole {
  if (rules.some((rule) => rule.sourceRole === "internal")) return "internal"
  if (rules.some((rule) => rule.sourceRole === "external")) return "external"
  return "unknown"
}

function primaryRuleOrigin(rules: CandidateRule[]): SourceOrigin {
  const internal = rules.find((rule) => rule.sourceRole === "internal" && rule.sourceOrigin)
  if (internal?.sourceOrigin) return internal.sourceOrigin
  const external = rules.find((rule) => rule.sourceRole === "external" && rule.sourceOrigin)
  if (external?.sourceOrigin) return external.sourceOrigin
  return rules.find((rule) => rule.sourceOrigin)?.sourceOrigin ?? "unknown"
}

function primaryRoleFromSourceBlocks(rule: RuleCardSpec): ReferenceDocRole | undefined {
  const roles = [
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.source.sourceRole),
    ...(rule.preservedExamples ?? []).map((block) => block.source.sourceRole),
  ].map(normalizeReferenceDocRole).filter((role): role is ReferenceDocRole => Boolean(role))
  if (roles.includes("internal")) return "internal"
  if (roles.includes("external")) return "external"
  if (roles.includes("unknown")) return "unknown"
  return undefined
}

function primaryOriginFromSourceBlocks(rule: RuleCardSpec): SourceOrigin | undefined {
  const origins = [
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.source.sourceOrigin),
    ...(rule.preservedExamples ?? []).map((block) => block.source.sourceOrigin),
  ].map(normalizeSourceOrigin).filter((origin): origin is SourceOrigin => Boolean(origin))
  if (origins.includes("internal_company")) return "internal_company"
  const external = origins.find((origin) => origin === "external_public" || origin === "external_licensed")
  if (external) return external
  if (origins.includes("unknown")) return "unknown"
  return undefined
}

function sourceRuleAnchorFromBlocks(rule: RuleCardSpec) {
  return [
    ...(rule.sourceBackedBlocks ?? []).map((block) => block.source.sourceRuleAnchor),
    ...(rule.preservedExamples ?? []).map((block) => block.source.sourceRuleAnchor),
  ].find(Boolean)
}

function sourceRuleAnchorFromSources(sources: string[]) {
  for (const source of sources) {
    const anchor = normalizeRuleAnchor(source)
    if (anchor) return anchor
  }
  return undefined
}

function originForRole(role: ReferenceDocRole): SourceOrigin {
  if (role === "internal") return "internal_company"
  return "unknown"
}

function normalizeReferenceDocRole(role: unknown): ReferenceDocRole | undefined {
  if (role === "internal" || role === "external" || role === "unknown") return role
  return undefined
}

function normalizeSourceOrigin(origin: unknown): SourceOrigin | undefined {
  if (origin === "internal_company" || origin === "external_public" || origin === "external_licensed" || origin === "unknown") return origin
  return undefined
}

function sortSourceBlocks(blocks: EvidencePack["sourceBackedBlocks"]) {
  const rank = (kind: EvidencePack["sourceBackedBlocks"][number]["kind"]) => {
    if (kind === "example" || kind === "code") return 0
    if (kind === "table") return 1
    if (kind === "quote") return 2
    if (kind === "list") return 3
    return 4
  }
  return [...blocks].sort((left, right) => rank(left.kind) - rank(right.kind))
}

function conflictDecisionSummaries(pack: EvidencePack) {
  const decisions = new Map((pack.conflictDecisions ?? []).map((decision) => [decision.conflictId, decision]))
  return pack.conflictRules.map((conflict) => {
    const decision = decisions.get(conflict.id) ?? conflict.decision
    return {
      title: conflict.title,
      choice: decision ? decisionLabel(decision.choice) : "未选择，按内部规范优先并保留待评审",
      note: decision?.note,
    }
  })
}

function decisionLabel(choice: ConflictResolutionDecision["choice"]) {
  if (choice === "internal") return "采用第一份/内部规范"
  if (choice === "external") return "采用第二份/外部参考"
  return "保留为待评审冲突"
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function abortError(message: string) {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}
