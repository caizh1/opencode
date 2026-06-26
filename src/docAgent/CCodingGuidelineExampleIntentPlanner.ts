import { isGeneratedExampleSemanticallyCompatible } from "./CCodingGuidelineQuality"
import { normalizeRuleExampleIntentForRule } from "./CCodingGuidelineExampleIntentNormalizer"
import { ruleExampleIntentCacheKey, type RuleExampleIntentCache, type RuleExampleIntentCacheEntry } from "./RuleExampleIntentCache"
import { containsUntranslatedEnglishText } from "./RuleLanguage"
import type { DocAgentModelProvider, DocumentPlan, GeneratedExampleSpec, RuleCardSpec } from "./types"

export type RuleExampleIntent = {
  ruleId: string
  semanticSummary: string
  exampleObjective: string
  exampleFormat: NonNullable<GeneratedExampleSpec["exampleFormat"]>
  exampleType: string
  mustInclude: string[]
  softHints?: string[]
  mustAvoid: string[]
  badExampleFocus: string
  goodExampleFocus: string
  confidence: number
  reason: string
  draftExample?: GeneratedExampleSpec
}

type IntentJson = {
  intents?: Array<{
    ruleId?: string
    semanticSummary?: string
    exampleObjective?: string
    exampleFormat?: GeneratedExampleSpec["exampleFormat"]
    exampleType?: string
    mustInclude?: string[]
    mustAvoid?: string[]
    badExampleFocus?: string
    goodExampleFocus?: string
    confidence?: number
    reason?: string
    draftExample?: Partial<GeneratedExampleSpec>
  }>
  warnings?: string[]
}

type RawRuleExampleIntent = NonNullable<IntentJson["intents"]>[number]

export type RuleExampleIntentResult = {
  intents: Map<string, RuleExampleIntent>
  warnings: string[]
}

const DEFAULT_BATCH_SIZE = 8
const ALLOWED_FORMATS: Array<NonNullable<GeneratedExampleSpec["exampleFormat"]>> = ["code", "file-layout", "naming-pair", "checklist", "text"]

export class CCodingGuidelineExampleIntentPlanner {
  constructor(
    private readonly model?: DocAgentModelProvider,
    private readonly options: { cache?: RuleExampleIntentCache; modelName?: string; batchSize?: number } = {},
  ) {}

  async plan(input: {
    question: string
    plan?: DocumentPlan
    rules: RuleCardSpec[]
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<RuleExampleIntentResult> {
    const warnings: string[] = []
    const intents = new Map<string, RuleExampleIntent>()
    const modelName = this.options.modelName ?? this.model?.cacheKey?.() ?? "unknown-model"
    const pending: Array<{ rule: RuleCardSpec; cacheKey: string }> = []

    for (const rule of input.rules) {
      input.signal?.throwIfAborted()
      const cacheKey = ruleExampleIntentCacheKey({ rule, plan: input.plan, modelName })
      const cached = await this.cachedIntent(rule, cacheKey, warnings)
      if (cached) {
        intents.set(rule.ruleId, cached)
        continue
      }
      pending.push({ rule, cacheKey })
    }
    for (const warning of this.options.cache?.drainWarnings?.() ?? []) warnings.push(warning)
    if (!this.model || pending.length === 0) {
      if (!this.model && pending.length > 0) input.log?.("[doc-agent] rule example intent model skipped: no model provider")
      return { intents, warnings: [...new Set(warnings)] }
    }

    const batches = chunk(pending, Math.max(1, Math.floor(this.options.batchSize ?? DEFAULT_BATCH_SIZE)))
    for (const [index, batch] of batches.entries()) {
      input.signal?.throwIfAborted()
      input.log?.(`[doc-agent] planning rule example intents: batch=${index + 1}/${batches.length}; rules=${batch.length}`)
      try {
        const output = await this.requestIntentBatch({
          question: input.question,
          plan: input.plan,
          rules: batch.map((item) => item.rule),
          signal: input.signal,
        })
        warnings.push(...(output.warnings ?? []))
        await this.acceptOutput({ output, batch, intents, warnings, input })
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error
        warnings.push(`规则示例语义规划批次失败，已拆分单条重试：${error instanceof Error ? error.message : String(error)}`)
        for (const item of batch) {
          input.signal?.throwIfAborted()
          try {
            const output = await this.requestIntentBatch({
              question: input.question,
              plan: input.plan,
              rules: [item.rule],
              signal: input.signal,
              repairInstruction: "Previous batch failed. Return one focused intent and one concise draft example for this single rule.",
            })
            warnings.push(...(output.warnings ?? []))
            await this.acceptOutput({ output, batch: [item], intents, warnings, input })
          } catch (singleError) {
            if (input.signal?.aborted || isAbortError(singleError)) throw singleError
            warnings.push(`规则 ${item.rule.ruleId}「${item.rule.name}」示例语义规划失败，已转本地兜底：${singleError instanceof Error ? singleError.message : String(singleError)}`)
          }
        }
      }
    }
    return { intents, warnings: [...new Set(warnings)] }
  }

  private async cachedIntent(rule: RuleCardSpec, cacheKey: string, warnings: string[]) {
    if (!this.options.cache) return undefined
    try {
      const entry = await this.options.cache.get(cacheKey)
      if (!entry) return undefined
      return intentFromCacheEntry(rule, entry)
    } catch (error) {
      warnings.push(`规则示例语义规划缓存读取失败，已转模型规划：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async requestIntentBatch(input: {
    question: string
    plan?: DocumentPlan
    rules: RuleCardSpec[]
    signal?: AbortSignal
    repairInstruction?: string
  }) {
    if (!this.model) return {}
    return await this.model.completeJson<IntentJson>({
      purpose: "plan-rule-examples",
      system: [
        "You plan semantically correct examples for C coding guideline RuleCards.",
        "Return JSON only.",
        "Each draft example must demonstrate exactly the current rule, not a generic safety template.",
        "Use Simplified Chinese for titles, explanations, reasons and intent text.",
        "Code identifiers and C syntax may remain English.",
      ].join(" "),
      prompt: JSON.stringify({
        question: input.question,
        repairInstruction: input.repairInstruction,
        examplePolicy: input.plan?.ruleCardPolicy,
        outputSchema: {
          intents: [{
            ruleId: "string",
            semanticSummary: "简体中文，说明这条规则真正约束什么",
            exampleObjective: "简体中文，说明示例必须证明什么",
            exampleFormat: "code | file-layout | naming-pair | checklist | text",
            exampleType: "bad-good-pair | checklist | text",
            mustInclude: ["示例中必须体现的语义点"],
            mustAvoid: ["示例中禁止出现的无关主题或模板"],
            badExampleFocus: "反例应体现的错误点",
            goodExampleFocus: "正例应体现的正确点",
            confidence: 0.9,
            reason: "简短中文理由",
            draftExample: {
              title: "中文标题",
              language: "c",
              exampleFormat: "code",
              exampleType: "bad-good-pair",
              badExample: "short example",
              badExampleReason: "中文原因",
              goodExample: "short example",
              explanation: "中文说明",
            },
          }],
          warnings: ["string"],
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
          sources: rule.sources.slice(0, 6),
          existingGeneratedExamples: (rule.generatedExamples ?? []).map((example) => ({
            title: example.title,
            exampleFormat: example.exampleFormat,
            exampleType: example.exampleType,
            badExample: example.badExample,
            goodExample: example.goodExample,
            explanation: example.explanation,
          })).slice(0, 1),
        })),
        hardRules: [
          "For pointer-vs-zero/NULL comparison rules, use examples like if (ptr == NULL) / if (ptr != NULL), and avoid memcpy/buffer boundary examples.",
          "For constant-left equality comparison rules, use examples like if (NULL == ptr) or if (0 == flag), and avoid macro naming or enum examples.",
          "For macro naming rules, macro examples are allowed only when the rule is about macro/constant naming.",
          "For static analysis rules, use checklist/config examples, not file-layout or pointer examples.",
          "If a rule is not suitable for C code, choose checklist or text instead of forcing code.",
        ],
      }),
    }, input.signal)
  }

  private async acceptOutput(input: {
    output: IntentJson
    batch: Array<{ rule: RuleCardSpec; cacheKey: string }>
    intents: Map<string, RuleExampleIntent>
    warnings: string[]
    input: { question: string; plan?: DocumentPlan; signal?: AbortSignal; log?: (message: string) => void }
  }) {
    const byRule = new Map((input.output.intents ?? []).map((intent) => [String(intent.ruleId ?? ""), intent]))
    for (const item of input.batch) {
      input.input.signal?.throwIfAborted()
      let intent = normalizeIntent(item.rule, byRule.get(item.rule.ruleId))
      if (!intent) {
        input.warnings.push(`规则 ${item.rule.ruleId}「${item.rule.name}」未返回示例语义规划，已转本地兜底。`)
        continue
      }
      const normalized = normalizeRuleExampleIntentForRule(item.rule, intent)
      input.warnings.push(...normalized.warnings)
      intent = normalized.intent ?? intent
      if (intent.draftExample && !isGeneratedExampleSemanticallyCompatible(item.rule, intent.draftExample)) {
        input.warnings.push(`规则 ${item.rule.ruleId}「${item.rule.name}」的模型示例草案未通过语义校验，已请求单条修复。`)
        const repaired = await this.repairSingleIntent(item.rule, intent, input.input)
        if (repaired) intent = repaired
        else intent = { ...intent, draftExample: undefined }
      }
      input.intents.set(item.rule.ruleId, intent)
      await this.cacheIntent(item.cacheKey, intent, input.warnings)
    }
  }

  private async repairSingleIntent(rule: RuleCardSpec, intent: RuleExampleIntent, input: { question: string; plan?: DocumentPlan; signal?: AbortSignal }) {
    try {
      const output = await this.requestIntentBatch({
        question: input.question,
        plan: input.plan,
        rules: [rule],
        signal: input.signal,
        repairInstruction: `Previous draft failed local semantic validation. Keep the intent, but regenerate an example that satisfies mustInclude and avoids mustAvoid. Previous intent: ${JSON.stringify(intent)}`,
      })
      return normalizeIntent(rule, output.intents?.[0])
    } catch {
      return undefined
    }
  }

  private async cacheIntent(cacheKey: string, intent: RuleExampleIntent, warnings: string[]) {
    if (!this.options.cache || intent.confidence < 0.5) return
    if (intent.draftExample?.validationNotes?.some((note) => /未通过|不匹配|失败/.test(note))) return
    try {
      await this.options.cache.set(cacheKey, {
        modelName: this.options.modelName ?? this.model?.cacheKey?.() ?? "unknown-model",
        intent: {
          semanticSummary: intent.semanticSummary,
          exampleObjective: intent.exampleObjective,
        exampleFormat: intent.exampleFormat,
        exampleType: intent.exampleType,
        mustInclude: intent.mustInclude,
        softHints: intent.softHints,
        mustAvoid: intent.mustAvoid,
          badExampleFocus: intent.badExampleFocus,
          goodExampleFocus: intent.goodExampleFocus,
          confidence: intent.confidence,
          reason: intent.reason,
        },
        draftExample: intent.draftExample,
      })
    } catch (error) {
      warnings.push(`规则示例语义规划缓存写入失败，已跳过缓存：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function normalizeIntent(rule: RuleCardSpec, raw: RawRuleExampleIntent | undefined): RuleExampleIntent | undefined {
  if (!raw || String(raw.ruleId ?? "") !== rule.ruleId) return undefined
  const exampleFormat = ALLOWED_FORMATS.includes(raw.exampleFormat as NonNullable<GeneratedExampleSpec["exampleFormat"]>)
    ? raw.exampleFormat as NonNullable<GeneratedExampleSpec["exampleFormat"]>
    : "code"
  const confidence = clampNumber(raw.confidence, 0, 1, 0.5)
  const intentBase = {
    ruleId: rule.ruleId,
    semanticSummary: cleanText(raw.semanticSummary) || `${rule.name}的示例语义`,
    exampleObjective: cleanText(raw.exampleObjective) || "示例必须体现当前规则的关键约束。",
    exampleFormat,
    exampleType: cleanText(raw.exampleType) || (exampleFormat === "checklist" ? "checklist" : "bad-good-pair"),
    mustInclude: cleanStringList(raw.mustInclude).slice(0, 8),
    mustAvoid: cleanStringList(raw.mustAvoid).slice(0, 8),
    badExampleFocus: cleanText(raw.badExampleFocus) || "反例应体现违反当前规则的写法。",
    goodExampleFocus: cleanText(raw.goodExampleFocus) || "正例应体现符合当前规则的写法。",
    confidence,
    reason: cleanText(raw.reason) || "模型根据规则语义生成示例规划。",
  }
  const draftExample = normalizeDraftExample(rule, intentBase, raw.draftExample)
  return { ...intentBase, draftExample }
}

function normalizeDraftExample(rule: RuleCardSpec, intent: Omit<RuleExampleIntent, "draftExample">, raw: Partial<GeneratedExampleSpec> | undefined): GeneratedExampleSpec | undefined {
  if (!raw) return undefined
  const exampleFormat = ALLOWED_FORMATS.includes(raw.exampleFormat as NonNullable<GeneratedExampleSpec["exampleFormat"]>)
    ? raw.exampleFormat
    : intent.exampleFormat
  const example: GeneratedExampleSpec = {
    id: cleanText(raw.id) || `${rule.ruleId}-intent-example-1`,
    title: cleanText(raw.title) || "补充示例：根据规则语义规划生成",
    language: exampleFormat === "code" ? cleanText(raw.language) || "c" : cleanText(raw.language) || undefined,
    exampleType: cleanText(raw.exampleType) || intent.exampleType,
    exampleFormat,
    badExample: cleanTextBlock(raw.badExample),
    badExampleReason: readableReason(cleanText(raw.badExampleReason)),
    goodExample: cleanTextBlock(raw.goodExample),
    explanation: cleanText(raw.explanation) || "该示例根据当前规则语义生成，用于帮助评审和落地，不是原文摘录。",
    sourceRefs: raw.sourceRefs?.length ? raw.sourceRefs : rule.sources,
    generationMode: raw.generationMode === "adapted-from-source" ? "adapted-from-source" : "model-generated-from-rule",
    origin: raw.origin === "adapted" ? "adapted" : "generated",
    isVerbatim: false,
    semanticIntent: {
      summary: intent.semanticSummary,
      objective: intent.exampleObjective,
      mustInclude: intent.mustInclude,
      softHints: intent.softHints,
      mustAvoid: intent.mustAvoid,
      confidence: intent.confidence,
    },
    validationNotes: ["模型语义规划草案。"],
  }
  return example
}

function intentFromCacheEntry(rule: RuleCardSpec, entry: RuleExampleIntentCacheEntry): RuleExampleIntent | undefined {
  const intent: RuleExampleIntent = {
    ruleId: rule.ruleId,
    ...entry.intent,
    draftExample: entry.draftExample,
  }
  const normalized = normalizeRuleExampleIntentForRule(rule, intent).intent ?? intent
  if (normalized.draftExample && !isGeneratedExampleSemanticallyCompatible(rule, normalized.draftExample)) return { ...normalized, draftExample: undefined }
  return normalized
}

function cleanStringList(input: unknown) {
  return Array.isArray(input)
    ? input.map((item) => cleanText(item)).filter(Boolean)
    : []
}

function cleanText(input: unknown) {
  return String(input ?? "").replace(/\s+/g, " ").trim()
}

function cleanTextBlock(input: unknown) {
  return String(input ?? "").replace(/\r\n/g, "\n").trim()
}

function clampNumber(input: unknown, min: number, max: number, fallback: number) {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function readableReason(input: string | undefined) {
  if (!input) return undefined
  return containsUntranslatedEnglishText(input)
    ? "该反例未满足当前规则要求，容易造成评审遗漏或维护风险。"
    : input
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
}
