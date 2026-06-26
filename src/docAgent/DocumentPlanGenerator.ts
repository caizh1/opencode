import type {
  DocAgentModelProvider,
  DocumentPlan,
  DocumentPlanConflictPolicy,
  DocumentPlanContentRequirement,
  DocumentPlanExternalRulePlacement,
  DocumentPlanRuleOrderingPolicy,
  DocumentPlanRuleSectioningPolicy,
  DocumentPlanSection,
  ReferenceDocument,
  RuleCardSpec,
} from "./types"
import { normalizeRuleCardReadableText, requiresChineseRules } from "./RuleLanguage"

type PlanJson = Partial<DocumentPlan>

export class DocumentPlanGenerator {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async generate(input: {
    question: string
    recipeId: string
    documents: ReferenceDocument[]
  }, signal?: AbortSignal): Promise<DocumentPlan> {
    const deterministic = normalizeDocumentPlan(deterministicPlan(input))
    if (!this.model) return deterministic
    try {
      const generated = await this.model.completeJson<PlanJson>({
        purpose: "plan-document",
        system: "Extract a safe structured DocumentPlan from the user request. Return JSON only. Never invent file paths.",
        prompt: JSON.stringify({
          question: input.question,
          recipeId: input.recipeId,
          defaults: deterministic,
          planningInstructions: [
            "Understand natural-language intent about rule order, front/back placement, appendices, priority and source roles.",
            "Convert those intents into ruleOrderingPolicy, ruleSectioningPolicy and externalRulePlacement.",
            "If the user says internal/company/team rules should be first and external/common/industry rules should be below, use internal-first and split-by-source-role.",
            "If the user says external/common/industry rules should go to appendix, use externalRulePlacement=appendix.",
            "If the user says external references are only for reference, use externalRulePlacement=reference-only.",
          ],
          sources: input.documents.map((doc) => ({
            id: doc.id,
            path: doc.read.metadata.path,
            title: doc.read.metadata.title,
            mentionIndex: doc.mentionIndex,
            role: doc.role,
            origin: doc.sourceOrigin,
          })),
          allowedConflictPolicy: ["ask", "prefer_internal", "prefer_external", "keep_review"],
          allowedPlacements: ["front", "before-rules", "rules", "after-rules", "appendix"],
          allowedRuleOrderingPolicy: ["internal-first", "external-first", "priority-first", "by-category", "model-planned"],
          allowedRuleSectioningPolicy: ["single-section", "split-by-source-role", "split-by-priority", "split-by-category"],
          allowedExternalRulePlacement: ["main-body", "appendix", "reference-only"],
        }, null, 2),
      }, signal)
      return normalizeDocumentPlan(mergePlan(deterministic, generated))
    } catch {
      return deterministic
    }
  }
}

export function normalizeDocumentPlan(plan: Partial<DocumentPlan>): DocumentPlan {
  const fallback = defaultCPlan()
  const title = cleanTitle(plan.output?.title) || fallback.output.title
  const conflictPolicy = normalizeConflictPolicy(plan.conflictPolicy)
  const contentRequirements = normalizeContentRequirements(plan.contentRequirements ?? [])
  const sectionPlan = normalizeSectionPlan(plan.sectionPlan ?? fallback.sectionPlan, contentRequirements)
  const warnings = [...(plan.warnings ?? [])]
  const ruleOrderingPolicy = normalizeRuleOrderingPolicy(plan.ruleOrderingPolicy, fallback.ruleOrderingPolicy, warnings)
  const ruleSectioningPolicy = normalizeRuleSectioningPolicy(plan.ruleSectioningPolicy, fallback.ruleSectioningPolicy, warnings)
  const externalRulePlacement = normalizeExternalRulePlacement(plan.externalRulePlacement, fallback.externalRulePlacement, warnings)
  const ruleCardPolicy = {
    ...fallback.ruleCardPolicy!,
    ...(plan.ruleCardPolicy ?? {}),
    exampleStyle: normalizeExampleStyle(plan.ruleCardPolicy?.exampleStyle) ?? fallback.ruleCardPolicy!.exampleStyle,
    includeBadExampleReason: plan.ruleCardPolicy?.includeBadExampleReason === true,
  }
  if (plan.output?.filenameBase && unsafeFilenameBase(plan.output.filenameBase)) {
    warnings.push("输出文件名包含路径或非法字符，已根据文档标题重新生成安全文件名。")
  }
  return {
    documentType: plan.documentType === "generic-report" ? "generic-report" : "c-coding-guideline",
    output: {
      title,
      subtitle: cleanText(plan.output?.subtitle) || fallback.output.subtitle,
      filenameBase: safeFilenameBase(plan.output?.filenameBase) || safeFilenameBase(title),
      language: plan.output?.language === "en-US" ? "en-US" : "zh-CN",
    },
    conflictPolicy,
    ruleOrderingPolicy,
    ruleSectioningPolicy,
    externalRulePlacement,
    sectionPlan,
    ruleCardPolicy,
    contentRequirements,
    sourcePolicy: {
      internalPriority: plan.sourcePolicy?.internalPriority ?? true,
      externalVerbatimAllowed: plan.sourcePolicy?.externalVerbatimAllowed ?? false,
      requireSourceTraceability: plan.sourcePolicy?.requireSourceTraceability ?? true,
    },
    warnings,
  }
}

export function defaultCPlan(): DocumentPlan {
  return {
    documentType: "c-coding-guideline",
    output: {
      title: "团队 C 语言编码规范",
      subtitle: "基于公司内部规范与本地参考资料的团队版指南",
      filenameBase: "team-c-coding-guideline",
      language: "zh-CN",
    },
    conflictPolicy: "ask",
    ruleOrderingPolicy: "internal-first",
    ruleSectioningPolicy: "single-section",
    externalRulePlacement: "main-body",
    sectionPlan: [
      section("management-summary", "管理层摘要", "总结文档目标、来源和关键结论。", true, "front"),
      section("purpose-scope", "文档目的与适用范围", "说明文档目标、适用团队和使用场景。", true, "front"),
      section("source-summary", "资料来源说明", "说明本地 Word 来源、内部与外部资料角色。", true, "front"),
      section("diff-analysis", "内外规范差异分析", "分析重合、冲突和外部补强内容。", true, "before-rules"),
      section("team-rules", "团队版规则正文", "以规则卡形式呈现团队化规范正文。", true, "rules"),
      section("examples", "推荐 / 不推荐代码示例", "集中展示代码示例和来源示例。", false, "after-rules"),
      section("checklist", "Code Review Checklist", "提供代码评审检查清单。", false, "after-rules"),
      section("static-analysis", "静态检查落地建议", "说明静态检查和 CI 落地方式。", false, "after-rules"),
      section("risks-limits", "风险与限制", "说明资料、授权、目录更新和生成边界。", true, "after-rules"),
      section("next-steps", "后续完善建议", "说明后续完善方向。", false, "after-rules"),
      section("references", "References", "列出最终引用来源。", true, "after-rules"),
    ],
    ruleCardPolicy: {
      rewriteNamesForReadability: false,
      rewriteScopesForReadability: false,
      requireMinimalExamplePerRule: false,
      includeBadExampleReason: false,
      exampleStyle: "bad-good-pair",
      preserveInternalExamples: true,
      adaptExternalExamples: true,
    },
    contentRequirements: [],
    sourcePolicy: {
      internalPriority: true,
      externalVerbatimAllowed: false,
      requireSourceTraceability: true,
    },
    warnings: [],
  }
}

export function normalizeRuleScope(scope: string | undefined, fallback = "通用编码原则") {
  const value = cleanText(scope)
  if (!value) return fallback
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-")
  if (/^(c-gen|c-general|general-c|generic-c|generic|general|c|coding|guideline|rule|rules|scope|n\/a|na|none|default)$/.test(normalized)) {
    return fallback
  }
  if (/^[a-z0-9-]{1,12}$/.test(normalized) && !/[一-龥]/.test(value)) return fallback
  return value
}

export function normalizeRuleCardForPlan(rule: RuleCardSpec, plan: DocumentPlan): RuleCardSpec {
  const fallbackScope = plan.ruleCardPolicy?.rewriteScopesForReadability ? "通用编码原则" : "通用编码原则"
  const normalized = {
    ...rule,
    name: cleanText(rule.name) || "未命名规则",
    scope: normalizeRuleScope(rule.scope, fallbackScope),
  }
  return requiresChineseRules(plan) ? normalizeRuleCardReadableText(normalized) : normalized
}

function deterministicPlan(input: { question: string; recipeId: string; documents: ReferenceDocument[] }): DocumentPlan {
  const base = defaultCPlan()
  const title = extractRequestedTitle(input.question)
  const conflictPolicy = extractConflictPolicy(input.question)
  const organization = extractRuleOrganizationPolicy(input.question)
  const requirements = extractContentRequirements(input.question)
  const ruleCardPolicy = {
    ...base.ruleCardPolicy!,
    rewriteNamesForReadability: /(?:规则名称|规则名|规则标题|名称).*(?:易懂|清晰|通俗|好理解|可读)|(?:易懂|清晰|通俗|好理解|可读).*(?:规则名称|规则名|规则标题|名称)/i.test(input.question),
    rewriteScopesForReadability: /(?:适用范围|使用范围|scope).*(?:易懂|清晰|通俗|好理解|可读)|(?:易懂|清晰|通俗|好理解|可读).*(?:适用范围|使用范围|scope)/i.test(input.question),
    requireMinimalExamplePerRule: /(?:每条|每一条|所有)(?:核心)?规则.*(?:最小示例|示例|例子)|(?:最小示例|示例|例子).*(?:每条|每一条|所有)(?:核心)?规则/i.test(input.question),
    includeBadExampleReason: shouldIncludeBadExampleReason(input.question),
  }
  return {
    ...base,
    output: {
      ...base.output,
      title: title || base.output.title,
      filenameBase: title ? safeFilenameBase(title) : base.output.filenameBase,
    },
    conflictPolicy,
    ...organization,
    ruleCardPolicy,
    contentRequirements: requirements,
    sectionPlan: normalizeSectionPlan(base.sectionPlan, requirements),
  }
}

function mergePlan(base: DocumentPlan, generated: PlanJson): DocumentPlan {
  return {
    ...base,
    documentType: generated.documentType ?? base.documentType,
    output: {
      ...base.output,
      ...(generated.output ?? {}),
      title: generated.output?.title ?? base.output.title,
    },
    conflictPolicy: generated.conflictPolicy ?? base.conflictPolicy,
    ruleOrderingPolicy: generated.ruleOrderingPolicy ?? base.ruleOrderingPolicy,
    ruleSectioningPolicy: generated.ruleSectioningPolicy ?? base.ruleSectioningPolicy,
    externalRulePlacement: generated.externalRulePlacement ?? base.externalRulePlacement,
    sectionPlan: generated.sectionPlan?.length ? generated.sectionPlan : base.sectionPlan,
    ruleCardPolicy: {
      ...base.ruleCardPolicy!,
      ...(generated.ruleCardPolicy ?? {}),
      includeBadExampleReason: base.ruleCardPolicy?.includeBadExampleReason === true || generated.ruleCardPolicy?.includeBadExampleReason === true,
    },
    contentRequirements: [
      ...base.contentRequirements,
      ...(generated.contentRequirements ?? []),
    ],
    sourcePolicy: {
      ...base.sourcePolicy,
      ...(generated.sourcePolicy ?? {}),
    },
    warnings: [
      ...base.warnings,
      ...(generated.warnings ?? []),
    ],
  }
}

function section(id: string, title: string, purpose: string, required: boolean, placement: DocumentPlanSection["placement"]): DocumentPlanSection {
  return { id, title, purpose, required, placement }
}

function normalizeSectionPlan(sections: DocumentPlanSection[], requirements: DocumentPlanContentRequirement[]) {
  const requiredDefaults = defaultCPlan().sectionPlan.filter((item) => item.required)
  const byId = new Map<string, DocumentPlanSection>()
  for (const item of [...requiredDefaults, ...sections]) {
    const id = safeId(item.id) || safeId(item.title)
    const title = cleanText(item.title)
    if (!id || !title) continue
    byId.set(id, {
      id,
      title,
      purpose: cleanText(item.purpose) || title,
      required: Boolean(item.required || requiredDefaults.some((required) => required.id === id)),
      placement: normalizePlacement(item.placement),
    })
  }
  for (const requirement of requirements) {
    if (requirement.target !== "section" && requirement.target !== "document" && requirement.target !== "appendix") continue
    const id = requirement.id
    if (byId.has(id)) continue
    byId.set(id, {
      id,
      title: titleFromRequirement(requirement.instruction),
      purpose: requirement.instruction,
      required: requirement.required,
      placement: requirement.target === "appendix" ? "appendix" : "after-rules",
    })
  }
  return [...byId.values()].sort((left, right) => placementRank(left.placement) - placementRank(right.placement))
}

function normalizeContentRequirements(requirements: DocumentPlanContentRequirement[]) {
  const result: DocumentPlanContentRequirement[] = []
  const seen = new Set<string>()
  for (const item of requirements) {
    const instruction = cleanText(item.instruction)
    if (!instruction) continue
    const id = safeId(item.id) || safeId(instruction)
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      instruction,
      target: normalizeContentTarget(item.target),
      required: item.required !== false,
    })
  }
  return result
}

function extractRequestedTitle(question: string) {
  const patterns = [
    /(?:标题|文档标题|文档名|名称)\s*(?:用|为|叫|设置为|命名为|改为)\s*[《“"]?([^《》“”"\n，。,；;]{2,80})[》”"]?/i,
    /(?:文档内容|最终文档|新文档)\s*(?:要)?(?:用|叫)\s*[《“"]?([^《》“”"\n，。,；;]{2,80})[》”"]?/i,
    /生成(?:一份|一个)?\s*[《“"]([^《》“”"\n]{2,80})[》”"]/i,
  ]
  for (const pattern of patterns) {
    const match = question.match(pattern)
    const title = cleanTitle(match?.[1])
    if (title) return title
  }
  return undefined
}

function extractConflictPolicy(question: string): DocumentPlanConflictPolicy {
  const text = question.replace(/\s+/g, "")
  const conflict = /冲突|不一致|矛盾|相互冲突/.test(text)
  if (conflict && /保留待评审|待评审|人工评审|不要自动覆盖|不自动覆盖/.test(text)) return "keep_review"
  if (
    /(冲突|不一致|矛盾).*?(采用|选择|按|以|优先|为准).*?(内部|公司|团队|第一份|第1份)/.test(text)
    || /(内部|公司|团队|第一份|第1份).*?(优先|为准|采用|选择).*?(冲突|不一致|矛盾)/.test(text)
    || /外部.*?参考.*?(内部|公司|团队).*?(优先|为准)/.test(text)
  ) return "prefer_internal"
  if (
    /(冲突|不一致|矛盾).*?(采用|选择|按|以|优先|为准).*?(外部|参考|第二份|第2份)/.test(text)
    || /(外部|参考|第二份|第2份).*?(优先|为准|采用|选择).*?(冲突|不一致|矛盾)/.test(text)
  ) return "prefer_external"
  return "ask"
}

function extractContentRequirements(question: string) {
  const result: DocumentPlanContentRequirement[] = []
  const pattern = /(?:加入|增加|补充|添加)(?:一个|一章|一节|一些|相关|对应)?[《“"]?([^《》“”"\n，。,；;]{2,60}?)(?:[》”"])?(?:章节|部分|内容|附录|清单|表格)?(?=[，。,；;\n]|$)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(question))) {
    const raw = cleanText(match[1])
    if (!raw || /每条规则|示例|例子/.test(raw)) continue
    const target = /附录/.test(match[0]) ? "appendix" : "section"
    result.push({
      id: safeId(raw),
      instruction: raw,
      target,
      required: true,
    })
  }
  return result
}

function shouldIncludeBadExampleReason(question: string) {
  return /(?:不推荐示例|不推荐写法|反例|错误示例).*(?:原因|理由|为什么|问题)|(?:原因|理由|为什么|问题).*(?:不推荐示例|不推荐写法|反例|错误示例)/i.test(question)
}

function extractRuleOrganizationPolicy(question: string): Pick<DocumentPlan, "ruleOrderingPolicy" | "ruleSectioningPolicy" | "externalRulePlacement"> {
  const text = question.replace(/\s+/g, "")
  const mentionsInternal = /内部|公司|团队|第一份|第1份|internal|company|team/i.test(text)
  const mentionsExternal = /外部|参考|行业|通用|第二份|第2份|external|industry|common|public/i.test(text)
  const internalFirst = mentionsInternal && mentionsExternal && /(?:内部|公司|团队|第一份|第1份).*?(?:前面|上面|优先|先|顶部|最上)|(?:前面|上面|顶部|最上).*?(?:内部|公司|团队|第一份|第1份)/i.test(text)
  const externalFirst = mentionsInternal && mentionsExternal && /(?:外部|参考|行业|通用|第二份|第2份).*?(?:前面|上面|优先|先|顶部|最上)|(?:前面|上面|顶部|最上).*?(?:外部|参考|行业|通用|第二份|第2份)/i.test(text)
  const splitBySource = mentionsInternal && mentionsExternal && /(?:分节|分组|分开|单独|下面|后面|放到下面|放下面|区分|先.*后|上面.*下面)/i.test(text)
  const externalAppendix = mentionsExternal && /(?:外部|参考|行业|通用|第二份|第2份).*?(?:附录)|(?:附录).*?(?:外部|参考|行业|通用|第二份|第2份)/i.test(text)
  const externalReferenceOnly = mentionsExternal && /(?:只做参考|仅作参考|只进入参考|不作为正式规则|不进正文)/i.test(text)
  const priorityFirst = /(?:优先级|严重程度|强制级别|必须级).*?(?:排序|优先|前面|先)|(?:排序|前面|先).*?(?:优先级|严重程度|强制级别|必须级)/i.test(text)
  const byCategory = /(?:按|按照).*(?:类别|分类|模块|主题).*(?:排序|组织|分组|分节)|(?:分类|类别|模块|主题).*?(?:分组|分节|排序)/i.test(text)

  return {
    ruleOrderingPolicy: priorityFirst ? "priority-first" : byCategory ? "by-category" : internalFirst ? "internal-first" : externalFirst ? "external-first" : "internal-first",
    ruleSectioningPolicy: byCategory ? "split-by-category" : priorityFirst && /分组|分节|拆分/.test(text) ? "split-by-priority" : splitBySource ? "split-by-source-role" : "single-section",
    externalRulePlacement: externalReferenceOnly ? "reference-only" : externalAppendix ? "appendix" : "main-body",
  }
}

function normalizeConflictPolicy(policy: unknown): DocumentPlanConflictPolicy {
  if (policy === "prefer_internal" || policy === "prefer_external" || policy === "keep_review" || policy === "ask") return policy
  return "ask"
}

function normalizeRuleOrderingPolicy(policy: unknown, fallback: DocumentPlanRuleOrderingPolicy, warnings: string[]): DocumentPlanRuleOrderingPolicy {
  if (policy === "internal-first" || policy === "external-first" || policy === "priority-first" || policy === "by-category" || policy === "model-planned") return policy
  if (policy !== undefined) warnings.push(`规则排序策略 ${String(policy)} 不合法，已回退为 ${fallback}。`)
  return fallback
}

function normalizeRuleSectioningPolicy(policy: unknown, fallback: DocumentPlanRuleSectioningPolicy, warnings: string[]): DocumentPlanRuleSectioningPolicy {
  if (policy === "single-section" || policy === "split-by-source-role" || policy === "split-by-priority" || policy === "split-by-category") return policy
  if (policy !== undefined) warnings.push(`规则分节策略 ${String(policy)} 不合法，已回退为 ${fallback}。`)
  return fallback
}

function normalizeExternalRulePlacement(policy: unknown, fallback: DocumentPlanExternalRulePlacement, warnings: string[]): DocumentPlanExternalRulePlacement {
  if (policy === "main-body" || policy === "appendix" || policy === "reference-only") return policy
  if (policy !== undefined) warnings.push(`外部规则放置策略 ${String(policy)} 不合法，已回退为 ${fallback}。`)
  return fallback
}

function normalizeExampleStyle(style: unknown) {
  if (style === "minimal" || style === "bad-good-pair" || style === "checklist" || style === "none") return style
  return undefined
}

function normalizePlacement(placement: unknown): DocumentPlanSection["placement"] {
  if (placement === "front" || placement === "before-rules" || placement === "rules" || placement === "after-rules" || placement === "appendix") return placement
  return "after-rules"
}

function normalizeContentTarget(target: unknown): DocumentPlanContentRequirement["target"] {
  if (target === "document" || target === "section" || target === "rule-card" || target === "appendix") return target
  return "section"
}

function placementRank(placement: DocumentPlanSection["placement"]) {
  if (placement === "front") return 0
  if (placement === "before-rules") return 1
  if (placement === "rules") return 2
  if (placement === "after-rules") return 3
  return 4
}

function titleFromRequirement(instruction: string) {
  const title = cleanText(instruction)
    .replace(/^(?:加入|增加|补充|添加)/, "")
    .replace(/(?:章节|部分|内容|附录|清单|表格)$/g, "")
  return title || "用户指定补充内容"
}

function cleanTitle(input: unknown) {
  const title = cleanText(input)
    .replace(/^(?:一份|一个|新的|新)/, "")
    .replace(/(?:word|docx|文档)$/i, "")
    .trim()
  if (!title || title.length < 2) return undefined
  if (/^(?:请|帮我|生成|整合|综合)$/.test(title)) return undefined
  return title.slice(0, 80)
}

function cleanText(input: unknown) {
  return typeof input === "string" ? input.replace(/\s+/g, " ").trim() : ""
}

function safeId(input: unknown) {
  const value = cleanText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!value) return ""
  const ascii = value.replace(/[^\x00-\x7F]+/g, "")
  return (ascii || `section-${hashText(value).slice(0, 8)}`).slice(0, 48)
}

function safeFilenameBase(input: unknown) {
  const value = cleanText(input)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) return undefined
  return value.slice(0, 80)
}

function unsafeFilenameBase(input: string) {
  return /[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(input) || input.toLowerCase().endsWith(".docx")
}

function hashText(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
