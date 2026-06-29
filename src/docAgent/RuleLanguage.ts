import type { DocAgentModelProvider, DocumentPlan, GeneratedExampleSpec, RuleCardSpec, WordDocSpec } from "./types"
import { plainTableRows } from "./TableSpecUtils"

type RuleLanguageJson = {
  rules?: Partial<RuleCardSpec>[]
  warnings?: string[]
}

type RuleTextField = keyof Pick<RuleCardSpec, "name" | "scope" | "description" | "recommended" | "discouraged" | "rationale" | "exceptions" | "rolloutAdvice">

const RULE_TEXT_FIELDS: RuleTextField[] = ["name", "scope", "description", "recommended", "discouraged", "rationale", "exceptions", "rolloutAdvice"]

const ALLOWED_LATIN_PHRASES = [
  "Code Review Checklist",
  "Code Review",
  "Checklist",
]

const ALLOWED_LATIN_TOKENS = new Set([
  "api",
  "c",
  "ci",
  "qa",
  "cpu",
  "dmac",
  "nfc",
  "ecc",
  "cache",
  "cert",
  "misra",
  "gnu",
  "jpl",
  "nasa",
  "barr",
  "linux",
  "word",
  "clang",
  "tidy",
  "cppcheck",
  "main",
  "null",
  "true",
  "false",
  "bool",
  "volatile",
  "static",
  "const",
  "inline",
  "sizeof",
  "typedef",
  "enum",
  "struct",
])

const FIELD_FALLBACKS: Record<RuleTextField, string> = {
  name: "外部参考规则",
  scope: "通用编码原则",
  description: "该规则来自本地参考资料，已纳入团队规则草案，具体表述需结合来源依据在评审中确认。",
  recommended: "按团队规范要求实现，并在评审中确认关键约束已经满足。",
  discouraged: "避免保留来源中的模糊或未团队化表述。",
  rationale: "中文化后的规则便于团队成员理解、评审和执行。",
  exceptions: "确需例外时，应在评审记录中说明原因和风险控制措施。",
  rolloutAdvice: "纳入团队 Code Review Checklist，并在必要时配置静态检查或人工审查项。",
}

const EXACT_TRANSLATIONS: Record<string, string> = {
  "use header guards": "使用头文件保护宏",
  "header guards": "头文件保护宏",
  "pointer safety": "指针与内存安全",
  "pointer and memory safety": "指针与内存安全",
  "naming": "命名规范",
  "naming rules": "命名规范",
  "naming convention": "命名规范",
  "naming conventions": "命名规范",
  "error handling": "错误处理",
  "return value": "返回值处理",
  "return values": "返回值处理",
  "function design": "函数设计",
  "integer safety": "类型与整数安全",
  "integer overflow": "整数溢出",
  "macro constants": "宏和常量",
  "macros and constants": "宏、枚举、常量",
  "comments": "注释规范",
  "comment rules": "注释规范",
  "file layout": "文件结构",
  "source and header pairing": "源文件与头文件配对",
  "avoid undefined behavior": "避免未定义行为",
  "check return values": "检查返回值",
  "always check return values": "始终检查返回值",
  "do not dereference null pointers": "不要解引用空指针",
  "check pointer before use": "使用指针前检查指针有效性",
}

const KEYWORD_TRANSLATIONS: Array<[RegExp, string]> = [
  [/header\s+guards?|include\s+guards?/i, "使用头文件保护宏"],
  [/pointer|memory/i, "指针与内存安全"],
  [/naming|identifier/i, "命名规范"],
  [/return\s+values?|error\s+handling/i, "错误处理与返回值检查"],
  [/integer|overflow|cast/i, "类型与整数安全"],
  [/macro|enum|constant/i, "宏、枚举、常量规范"],
  [/comment/i, "注释规范"],
  [/function/i, "函数设计规范"],
  [/file|header|source/i, "文件与头文件组织规范"],
  [/undefined\s+behavior/i, "避免未定义行为"],
]

export class RuleLanguageNormalizer {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async normalize(rules: RuleCardSpec[], plan?: DocumentPlan, signal?: AbortSignal) {
    if (!requiresChineseRules(plan)) return { rules, warnings: [] }
    const offenders = rules.filter(ruleHasUntranslatedEnglish)
    if (offenders.length === 0) return { rules, warnings: [] }

    const warnings: string[] = []
    let nextRules = rules
    if (this.model) {
      try {
        const fixed = await this.model.completeJson<RuleLanguageJson>({
          purpose: "normalize-rule-language",
          system: "Rewrite only user-readable rule card text into Simplified Chinese. Keep code, identifiers, file names, standard acronyms, source refs, ruleId, priority and structure unchanged. Return JSON only.",
          prompt: JSON.stringify({
            targetLanguage: "zh-CN",
            instruction: "All human-readable RuleCard fields must be Simplified Chinese. Do not translate code snippets, file paths, API names, MISRA/CERT/GNU/Linux/NASA/JPL/Barr acronyms, or source references.",
            rules: offenders.map(ruleForLanguageRepair),
            outputShape: { rules: [{ ruleId: "", name: "", scope: "", description: "", recommended: "", discouraged: "", rationale: "", exceptions: "", rolloutAdvice: "" }], warnings: [] },
          }, null, 2),
        }, signal)
        nextRules = mergeLanguageRepair(nextRules, fixed.rules ?? [])
        for (const warning of fixed.warnings ?? []) warnings.push(warning)
      } catch (error) {
        warnings.push(`规则中文化模型修复失败，已改用本地术语表：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const locallyFixed = nextRules.map((rule) => normalizeRuleCardReadableText(rule))
    const changedCount = locallyFixed.filter((rule, index) => JSON.stringify(rule) !== JSON.stringify(nextRules[index])).length
    if (changedCount > 0) warnings.push(`存在 ${changedCount} 条规则包含英文正文，已使用本地术语表中文化；请人工复核语义。`)
    return { rules: locallyFixed, warnings }
  }
}

export function requiresChineseRules(plan?: DocumentPlan) {
  return !plan || plan.output.language === "zh-CN"
}

export function ruleHasUntranslatedEnglish(rule: RuleCardSpec) {
  return collectUntranslatedRuleFields(rule).length > 0
}

export function collectUntranslatedRuleFields(rule: RuleCardSpec) {
  const issues: string[] = []
  for (const field of RULE_TEXT_FIELDS) {
    const value = rule[field]
    if (typeof value === "string" && containsUntranslatedEnglishText(value)) issues.push(`${rule.ruleId}.${field}`)
  }
  for (const example of rule.generatedExamples ?? []) {
    for (const field of ["title", "explanation", "badExampleReason"] as const) {
      const value = example[field]
      if (typeof value === "string" && containsUntranslatedEnglishText(value)) issues.push(`${rule.ruleId}.generatedExamples.${field}`)
    }
    if (example.exampleFormat === "text" || example.exampleFormat === "checklist") {
      if (example.badExample && containsUntranslatedEnglishText(example.badExample)) issues.push(`${rule.ruleId}.generatedExamples.badExample`)
      if (example.goodExample && containsUntranslatedEnglishText(example.goodExample)) issues.push(`${rule.ruleId}.generatedExamples.goodExample`)
    }
  }
  return issues
}

export function collectUntranslatedSpecText(spec: WordDocSpec) {
  const issues: string[] = []
  for (const section of [...spec.sections, ...(spec.appendices ?? [])]) {
    const prefix = section.id || section.title
    for (const [index, paragraph] of section.paragraphs?.entries() ?? []) {
      if (containsUntranslatedEnglishText(paragraph)) issues.push(`${prefix}.paragraphs.${index}`)
    }
    for (const [index, bullet] of section.bullets?.entries() ?? []) {
      if (containsUntranslatedEnglishText(bullet)) issues.push(`${prefix}.bullets.${index}`)
    }
    for (const [index, item] of section.numberedItems?.entries() ?? []) {
      if (containsUntranslatedEnglishText(item)) issues.push(`${prefix}.numberedItems.${index}`)
    }
    for (const [index, item] of section.definitionList?.entries() ?? []) {
      if (containsUntranslatedEnglishText(item.term)) issues.push(`${prefix}.definitionList.${index}.term`)
      if (containsUntranslatedEnglishText(item.definition)) issues.push(`${prefix}.definitionList.${index}.definition`)
      if (item.note && containsUntranslatedEnglishText(item.note)) issues.push(`${prefix}.definitionList.${index}.note`)
    }
    for (const [index, item] of section.sourceList?.entries() ?? []) {
      if (containsUntranslatedEnglishText(item.title)) issues.push(`${prefix}.sourceList.${index}.title`)
      if (item.note && containsUntranslatedEnglishText(item.note)) issues.push(`${prefix}.sourceList.${index}.note`)
    }
    for (const [tableIndex, table] of section.tables?.entries() ?? []) {
      for (const [index, header] of table.headers.entries()) {
        if (containsUntranslatedEnglishText(header)) issues.push(`${prefix}.tables.${tableIndex}.headers.${index}`)
      }
      for (const [rowIndex, row] of plainTableRows(table).entries()) {
        for (const [cellIndex, cell] of row.entries()) {
          if (containsUntranslatedEnglishText(cell)) issues.push(`${prefix}.tables.${tableIndex}.rows.${rowIndex}.${cellIndex}`)
        }
      }
    }
    for (const rule of section.ruleCards ?? []) {
      issues.push(...collectUntranslatedRuleFields(rule))
    }
  }
  return [...new Set(issues)]
}

export function containsUntranslatedEnglishText(input: string) {
  const text = stripAllowedLatin(input)
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[A-Z]+-[A-Z0-9-]+\b/g, " ")
    .replace(/[\w./-]+\.(?:c|h|cpp|hpp|docx|pdf|md|txt)\b/gi, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (word) => allowedOrIdentifier(word) ? " " : word)
    .replace(/\s+/g, " ")
    .trim()
  if (!/[A-Za-z]/.test(text)) return false
  const words = latinWords(text).filter((word) => !allowedOrIdentifier(word))
  if (words.length === 0) return false
  if (!/[一-龥]/.test(input)) return true
  return words.length >= 2 || words.some((word) => commonEnglishRuleWord(word))
}

export function normalizeRuleCardReadableText(rule: RuleCardSpec): RuleCardSpec {
  const next: RuleCardSpec = { ...rule }
  for (const field of RULE_TEXT_FIELDS) {
    const value = next[field]
    if (typeof value === "string" && containsUntranslatedEnglishText(value)) {
      next[field] = localizeRuleText(value, field) as never
    }
  }
  if (next.generatedExamples?.length) {
    next.generatedExamples = next.generatedExamples.map(normalizeGeneratedExampleText)
  }
  return next
}

export function preferChineseRuleFields(generated: RuleCardSpec, fallback: RuleCardSpec | undefined, plan?: DocumentPlan): RuleCardSpec {
  if (!fallback || !requiresChineseRules(plan)) return normalizeRuleCardReadableText(generated)
  const next: RuleCardSpec = { ...generated }
  for (const field of RULE_TEXT_FIELDS) {
    const value = next[field]
    if (typeof value === "string" && containsUntranslatedEnglishText(value)) {
      next[field] = fallback[field] as never
    }
  }
  return normalizeRuleCardReadableText(next)
}

export function normalizeWordDocSpecReadableText(spec: WordDocSpec, plan?: DocumentPlan): WordDocSpec {
  if (!requiresChineseRules(plan) && spec.metadata.language !== "zh-CN") return spec
  return {
    ...spec,
    sections: spec.sections.map(normalizeSectionReadableText),
    appendices: spec.appendices?.map(normalizeSectionReadableText),
  }
}

export function localizeRuleCategory(input: string | undefined) {
  const value = input?.replace(/\s+/g, " ").trim()
  if (!value) return { text: "通用编码原则" }
  if (!containsUntranslatedEnglishText(value)) return { text: value }
  const translated = localizeRuleText(value, "scope")
  return {
    text: translated,
    warning: translated === FIELD_FALLBACKS.scope
      ? `候选规则分类「${value.slice(0, 40)}」不是简体中文，已按「${translated}」汇总。`
      : undefined,
  }
}

function normalizeGeneratedExampleText(example: GeneratedExampleSpec): GeneratedExampleSpec {
  const next = { ...example }
  if (containsUntranslatedEnglishText(next.title)) next.title = "补充示例"
  if (containsUntranslatedEnglishText(next.explanation)) next.explanation = "该示例用于说明团队规则的落地方式，不是原文摘录。"
  if (next.badExampleReason && containsUntranslatedEnglishText(next.badExampleReason)) next.badExampleReason = "该反例未满足当前规则要求，容易造成评审遗漏或维护风险。"
  if (next.exampleFormat === "text" || next.exampleFormat === "checklist") {
    if (next.badExample && containsUntranslatedEnglishText(next.badExample)) next.badExample = "不推荐：未按当前规则形成可检查的做法。"
    if (next.goodExample && containsUntranslatedEnglishText(next.goodExample)) next.goodExample = "推荐：按当前规则形成清晰、可评审的做法。"
  }
  return next
}

function normalizeSectionReadableText(section: WordDocSpec["sections"][number]): WordDocSpec["sections"][number] {
  return {
    ...section,
    paragraphs: section.paragraphs?.map(normalizeReportText),
    bullets: section.bullets?.map(normalizeReportText),
    numberedItems: section.numberedItems?.map(normalizeReportText),
    definitionList: section.definitionList?.map((item) => ({
      ...item,
      term: normalizeReportText(item.term),
      definition: normalizeReportText(item.definition),
      note: item.note ? normalizeReportText(item.note) : undefined,
    })),
    sourceList: section.sourceList?.map((item) => ({
      ...item,
      title: normalizeReportText(item.title),
      note: item.note ? normalizeReportText(item.note) : undefined,
    })),
    tables: section.tables?.map((table) => ({
      ...table,
      headers: table.headers.map(normalizeReportText),
      rows: table.rows.map((row) => row.map((cell) => typeof cell === "string" ? normalizeReportText(cell) : { ...cell, text: normalizeReportText(cell.text) })),
    })),
    ruleCards: section.ruleCards?.map(normalizeRuleCardReadableText),
  }
}

function normalizeReportText(input: string) {
  if (!containsUntranslatedEnglishText(input)) return input
  const summary = input.match(/^(.+?)([：:]\s*\d+\s*条候选规则)$/)
  if (summary) return `${localizeRuleCategory(summary[1]).text}${summary[2].replace(/^:/, "：")}`
  const category = localizeRuleCategory(input)
  if (category.text !== FIELD_FALLBACKS.scope) return category.text
  return "该项内容来自本地资料，已纳入团队评审范围，具体含义需结合来源文档复核。"
}

function ruleForLanguageRepair(rule: RuleCardSpec) {
  const result: Partial<RuleCardSpec> = { ruleId: rule.ruleId }
  for (const field of RULE_TEXT_FIELDS) {
    const value = rule[field]
    if (typeof value === "string") result[field] = value as never
  }
  return result
}

function mergeLanguageRepair(rules: RuleCardSpec[], repairs: Partial<RuleCardSpec>[]) {
  const byId = new Map(repairs.filter((rule) => rule.ruleId).map((rule) => [rule.ruleId, rule]))
  return rules.map((rule) => {
    const repair = byId.get(rule.ruleId)
    if (!repair) return rule
    const next: RuleCardSpec = { ...rule }
    for (const field of RULE_TEXT_FIELDS) {
      const value = repair[field]
      if (typeof value === "string" && value.trim() && !containsUntranslatedEnglishText(value)) {
        next[field] = value.trim() as never
      }
    }
    return next
  })
}

function localizeRuleText(input: string, field: RuleTextField) {
  const normalized = normalizeEnglishKey(input)
  if (EXACT_TRANSLATIONS[normalized]) return EXACT_TRANSLATIONS[normalized]
  for (const [pattern, translation] of KEYWORD_TRANSLATIONS) {
    if (pattern.test(input)) {
      if (field === "description") return `应${translation.replace(/规范$/, "")}，并将要求落实到代码评审和必要的静态检查中。`
      if (field === "recommended") return `推荐按团队约定执行：${translation}。`
      if (field === "discouraged") return `不推荐忽略${translation.replace(/规范$/, "")}相关要求。`
      if (field === "rationale") return `${translation}有助于提升代码一致性、可维护性和缺陷预防能力。`
      if (field === "exceptions") return `确需偏离${translation.replace(/规范$/, "")}时，应记录原因、影响范围和替代风险控制措施。`
      return translation
    }
  }
  return FIELD_FALLBACKS[field]
}

function normalizeEnglishKey(input: string) {
  return input
    .toLowerCase()
    .replace(/[“”"'.:;，。！？!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function stripAllowedLatin(input: string) {
  let text = input
  for (const phrase of ALLOWED_LATIN_PHRASES) {
    text = text.replace(new RegExp(escapeRegExp(phrase), "gi"), " ")
  }
  return text
}

function latinWords(input: string) {
  return input.match(/[A-Za-z][A-Za-z+-]*/g)?.map((word) => word.toLowerCase()) ?? []
}

function allowedOrIdentifier(word: string) {
  const normalized = word.toLowerCase()
  return ALLOWED_LATIN_TOKENS.has(normalized)
    || /^u?int(?:8|16|32|64)_t$/.test(normalized)
    || /^(?:size|ssize|uintptr|intptr)_t$/.test(normalized)
    || /^[a-z]+_[a-z0-9_]+$/.test(normalized)
    || /^[a-z]*\d+[a-z0-9_]*$/.test(normalized)
}

function commonEnglishRuleWord(word: string) {
  return /^(?:use|avoid|must|shall|should|required|recommended|discouraged|pointer|memory|header|guard|guards|naming|integer|overflow|return|error|function|comment|macro|constant|file|source)$/.test(word.toLowerCase())
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
