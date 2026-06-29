import { applyRuleOrganizationPlanToSections } from "./RuleOrganization"
import type { ConflictResolutionChoice, DocumentPlan, DocumentPlanSection, DocumentSection, EvidencePack, RuleCardSpec } from "./types"

export class DocumentOutlinePlanner {
  build(input: { pack: EvidencePack; rules: RuleCardSpec[]; plan?: DocumentPlan }): DocumentSection[] {
    const sections = baseSections(input)
    if (!input.plan) return sections

    const byId = new Map(sections.map((section) => [section.id, section]))
    const planned: DocumentSection[] = []
    for (const item of input.plan.sectionPlan) {
      if (item.id === "conflicts" && input.pack.conflictRules.length === 0) continue
      const existing = byId.get(item.id)
      if (existing) planned.push({ ...existing, title: item.title || existing.title })
      else planned.push(customSection(item))
    }
    if (input.pack.conflictRules.length > 0 && !planned.some((section) => section.id === "conflicts")) {
      const insertAt = planned.findIndex((section) => section.id === "team-rules")
      const conflictSection = conflictSectionFor(input)
      if (insertAt >= 0) planned.splice(insertAt, 0, conflictSection)
      else planned.push(conflictSection)
    }
    return applyRuleOrganizationPlanToSections(planned.length > 0 ? planned : sections, input.plan)
  }
}

function baseSections(input: { pack: EvidencePack; rules: RuleCardSpec[]; plan?: DocumentPlan }): DocumentSection[] {
  const sections: DocumentSection[] = [
      {
        id: "management-summary",
        level: 1,
        title: "管理层摘要",
        paragraphs: [
          `本报告基于 ${input.pack.candidateRules.length} 条候选规则和 ${input.pack.sourceBackedBlocks.length} 个来源摘录块生成，目标是形成可评审、可追溯、可落地的团队编码规范。`,
          conflictTreatmentParagraph(input.plan),
        ],
      },
      {
        id: "purpose-scope",
        level: 1,
        title: "文档目的与适用范围",
        paragraphs: [
          "本文档面向团队 C 语言开发、维护、代码评审和静态检查落地场景，目标是在公司内部规范基础上吸收公开参考规范的工程实践，形成可执行、可追溯、可持续演进的团队版编码规范。",
        ],
      },
      {
        id: "source-summary",
        level: 1,
        title: "资料来源说明",
        paragraphs: [
          "本报告仅使用用户在 QA 中提供的本地 Word 文档作为来源。插件不会联网搜索、下载或自动获取公开规范资料。",
        ],
        tables: [{
          headers: ["来源类型", "摘要"],
          rows: [
            ["公司内部规范", input.pack.internalSummary.join("\n") || "未识别到明确内部规则。"],
            ["外部参考规范", input.pack.externalSummary.join("\n") || "未识别到明确外部规则。"],
          ],
        }],
        sourceBackedBlocks: sourceOverviewBlocks(input.pack),
      },
      {
        id: "diff-analysis",
        level: 1,
        title: "内外规范差异分析",
        paragraphs: [
          "内部规范作为默认落地基线，外部参考资料用于补强缺失项、解释风险背景、补充推荐做法和落地建议。若来源之间存在冲突，本报告按用户在生成流程中的选择处理；保留待评审的冲突不会自动覆盖任一来源。",
        ],
        tables: [{
          headers: ["差异类型", "数量", "处理策略"],
          rows: [
            ["重合规则", String(input.pack.overlappingRules.length), "保留内部表述，吸收外部理由或示例。"],
            ["冲突规则", String(input.pack.conflictRules.length), conflictTreatmentLabel(input.plan)],
            ["外部补强规则", String(input.pack.externallyRecommendedRules.length), "作为建议或后续完善项纳入。"],
          ],
        }],
      },
      {
        id: "team-rules",
        level: 1,
        title: "团队版规则正文",
        paragraphs: [
          "以下规则为团队化改写结果，每条规则保留来源依据，避免直接复制外部规范原文。",
        ],
        ruleCards: input.rules,
      },
      {
        id: "examples",
        level: 1,
        title: "推荐 / 不推荐代码示例",
        paragraphs: [
          "示例用于说明规则意图，具体项目应结合已有代码风格、编译器告警和静态检查规则进行调整。",
        ],
        codeBlocks: [
          {
            language: "c",
            caption: "推荐：显式边界检查和错误返回",
            code: "if (len > BUFFER_SIZE) {\n    return -EINVAL;\n}\nmemcpy(dst, src, len);",
          },
          {
            language: "c",
            caption: "不推荐：缺少边界检查",
            code: "memcpy(dst, src, len);",
          },
        ],
        sourceBackedBlocks: sourceExampleBlocks(input.pack),
      },
      {
        id: "checklist",
        level: 1,
        title: "Code Review Checklist",
        bullets: [
          "命名是否符合模块、类型、函数和宏的团队规则。",
          "函数是否职责单一，错误路径和资源释放路径清晰。",
          "指针、数组、长度和整数转换是否有边界保护。",
          "头文件依赖、宏、副作用和条件编译是否可维护。",
          "是否存在未说明的规范例外或安全风险。",
        ],
      },
      {
        id: "static-analysis",
        level: 1,
        title: "静态检查落地建议",
        paragraphs: [
          "建议将必须级规则优先纳入编译告警、clang-tidy/cppcheck/自研脚本或人工审查清单，并定期复盘误报、漏报和例外审批记录。",
        ],
      },
      {
        id: "risks-limits",
        level: 1,
        title: "风险与限制",
        bullets: [
          "本报告基于用户提供的本地 Word 资料，不代表公开规范的完整授权文本。",
          "若外部资料为授权规范整理稿，应由团队确认其使用范围和版权边界。",
          "Word-native 目录页码可通过 refresh_word_native_fields 或在 Word 中更新域。",
        ],
      },
      {
        id: "next-steps",
        level: 1,
        title: "后续完善建议",
        bullets: [
          "补充项目真实代码反例和推荐示例。",
          "将规则映射到静态检查配置和 CI 门禁。",
          "建立例外审批和版本修订机制。",
        ],
      },
      {
        id: "references",
        level: 1,
        title: "References",
        paragraphs: [
          "以下来源均为用户本地提供的 Word 文档。未读取过的资料不会进入最终引用。",
        ],
      },
    ]
    if (input.pack.conflictRules.length > 0) {
      sections.splice(4, 0, conflictSectionFor(input))
    }
    return sections
}

function customSection(item: DocumentPlanSection): DocumentSection {
  return {
    id: item.id,
    level: 1,
    title: item.title,
    paragraphs: [
      item.purpose || "用户在生成请求中明确要求加入该内容，本节作为后续团队评审和补充的结构化占位。",
    ],
  }
}

function conflictSectionFor(input: { pack: EvidencePack; plan?: DocumentPlan }): DocumentSection {
  return {
    id: "conflicts",
    level: 1,
    title: "冲突与处理建议",
    paragraphs: [conflictTreatmentParagraph(input.plan)],
    tables: [{
      headers: ["规则主题", "内部依据", "外部依据", "用户决策", "处理建议"],
      rows: input.pack.conflictRules.map((item) => [
        item.title,
        item.internal ? `${item.internal.sourceDocument} / ${item.internal.sourceSection}` : "",
        item.external ? `${item.external.sourceDocument} / ${item.external.sourceSection}` : "",
        decisionLabel(item.decision?.choice),
        item.recommendation,
      ]),
    }],
  }
}

function sourceOverviewBlocks(pack: EvidencePack) {
  return pack.sourceBackedBlocks
    .filter((block) => block.kind === "table" || block.kind === "quote" || block.kind === "list" || block.kind === "paragraph")
    .slice(0, 8)
}

function sourceExampleBlocks(pack: EvidencePack) {
  return pack.sourceBackedBlocks
    .filter((block) => block.kind === "example" || block.kind === "code")
    .slice(0, 8)
}

function decisionLabel(choice?: ConflictResolutionChoice) {
  if (choice === "internal") return "采用第一份/内部规范"
  if (choice === "external") return "采用第二份/外部参考"
  if (choice === "review") return "保留为待评审冲突"
  return "未选择，按内部规范优先"
}

function conflictTreatmentLabel(plan?: DocumentPlan) {
  if (plan?.conflictPolicy === "prefer_internal") return "按用户指令自动采用第一份/内部规范。"
  if (plan?.conflictPolicy === "prefer_external") return "按用户指令自动采用第二份/外部参考。"
  if (plan?.conflictPolicy === "keep_review") return "按用户指令保留为待评审冲突。"
  return "进入冲突与处理建议，待团队评审。"
}

function conflictTreatmentParagraph(plan?: DocumentPlan) {
  if (plan?.conflictPolicy === "prefer_internal") return "用户已明确要求冲突内容优先采用团队内部文档；本报告将内部规则作为主规则，外部差异仅进入理由、差异说明或后续建议。"
  if (plan?.conflictPolicy === "prefer_external") return "用户已明确要求冲突内容优先采用外部参考资料；本报告保留内部依据，供团队评审外部规则是否适合落地。"
  if (plan?.conflictPolicy === "keep_review") return "用户已明确要求冲突内容保留待评审；本报告不会自动覆盖任一来源。"
  return "若来源之间存在冲突，本报告默认暂停并请求用户确认；未经确认的冲突不会自动覆盖内部规范。"
}
