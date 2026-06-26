import type {
  DocAgentModelProvider,
  ReferenceDocRole,
  ReferenceDocument,
  SourceOrigin,
  SourceOriginClassification,
  SourceOriginClassifier,
  SourcePreservationPolicy,
} from "./types"

const INTERNAL_RE = /(?:公司|内部|internal|company|团队|team)/i
const PUBLIC_RE = /(?:CERT|Barr|Linux|GNU|NASA|JPL)/i
const EXTERNAL_REFERENCE_RE = /(?:外部|公开|参考|public|external)/i
const LICENSED_RE = /(?:MISRA)/i
const MODEL_CONFIDENCE_THRESHOLD = 0.55

type SourceRolePlanJson = {
  sources?: Array<{
    sourceId?: string
    sourceOrigin?: SourceOrigin
    origin?: SourceOrigin
    role?: ReferenceDocRole
    confidence?: number
    reason?: string
    explicit?: boolean
  }>
  warnings?: string[]
}

export class CCodingGuidelineSourceClassifier implements SourceOriginClassifier {
  classify(input: { question: string; documents: ReferenceDocument[] }): SourceOriginClassification[] {
    const explicit = explicitSourceMap(input.question)
    return input.documents.map((document, index) => {
      const mentionIndex = document.mentionIndex ?? index
      const explicitOrigin = explicit.get(mentionIndex)
      if (explicitOrigin) {
        return classification(document.id, explicitOrigin, 1, `用户显式指定第 ${mentionIndex + 1} 份来源。`, true)
      }
      const text = `${document.read.metadata.path} ${document.read.metadata.title}`
      if (INTERNAL_RE.test(text)) {
        return classification(document.id, "internal_company", 0.72, "根据文件名或 metadata 推断为公司内部规范。", false, "来源角色由文件名或 metadata 推断，请确认是否为公司内部规范。")
      }
      if (LICENSED_RE.test(text)) {
        return classification(document.id, "external_licensed", 0.78, "根据文件名或 metadata 推断为授权外部规范资料。", false, "来源角色由文件名或 metadata 推断，请确认授权资料使用边界。")
      }
      if (PUBLIC_RE.test(text) || EXTERNAL_REFERENCE_RE.test(text)) {
        return classification(document.id, "external_public", 0.72, "根据文件名或 metadata 推断为公开外部参考资料。", false, "来源角色由文件名或 metadata 推断，请确认公开资料来源。")
      }
      return classification(document.id, "unknown", 0.2, "无法根据用户描述、文件名或 metadata 判断来源类型。", false, "来源类型未识别，已按 unknown 处理，不使用长原文摘录。")
    })
  }

  async classifyWithModel(input: {
    question: string
    documents: ReferenceDocument[]
    model?: DocAgentModelProvider
    signal?: AbortSignal
    log?: (message: string) => void
  }): Promise<SourceOriginClassification[]> {
    const fallback = this.classify(input)
    if (!input.model) return fallback
    try {
      input.log?.(`[doc-agent] planning source roles with model: documents=${input.documents.length}`)
      const plan = await input.model.completeJson<SourceRolePlanJson>({
        purpose: "plan-source-roles",
        system: "Infer source roles for local Word documents from the user request and the stable mention order. Return JSON only. User explicit statements have priority over filenames.",
        prompt: sourceRolePrompt(input.question, input.documents),
      }, input.signal)
      return mergeModelClassifications(input.documents, fallback, plan)
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) throw error
      input.log?.(`[doc-agent] source role model planning failed; using deterministic fallback: ${error instanceof Error ? error.message : String(error)}`)
      return fallback
    }
  }
}

export class CCodingGuidelinePreservationPolicy implements SourcePreservationPolicy {
  decide(input: Parameters<SourcePreservationPolicy["decide"]>[0]) {
    const origin = input.document.sourceOrigin
    if (origin === "internal_company") {
      return {
        preserveMode: "verbatim-short" as const,
        charLimit: 600,
        wordLimit: 120,
        allowVerbatim: true,
        note: "公司内部资料短摘录保留。",
      }
    }
    if (input.kind === "code" || input.kind === "example") {
      return {
        preserveMode: "adapted-example" as const,
        charLimit: 200,
        wordLimit: 60,
        allowVerbatim: false,
        note: externalNote(origin),
      }
    }
    if (input.kind === "table" || input.kind === "list") {
      return {
        preserveMode: "summarized" as const,
        charLimit: 200,
        wordLimit: 60,
        allowVerbatim: false,
        note: externalNote(origin),
      }
    }
    return {
      preserveMode: origin === "unknown" ? "summarized" as const : "paraphrased" as const,
      charLimit: 200,
      wordLimit: 60,
      allowVerbatim: false,
      warning: origin === "unknown" ? "来源类型未知，已避免长原文摘录。" : undefined,
      note: externalNote(origin),
    }
  }
}

function explicitSourceMap(question: string) {
  const result = new Map<number, SourceOrigin>()
  const normalized = question.replace(/\s+/g, "")
  const ordinals = [
    /(?:第一份|第1份|第一个(?:文档|文件|资料)?|第一(?:个)?(?:文档|文件|资料|篇)?|1st|first|前者)/i,
    /(?:第二份|第2份|第二个(?:文档|文件|资料)?|第二(?:个)?(?:文档|文件|资料|篇)?|2nd|second|后者)/i,
    /(?:第三份|第3份|第三个(?:文档|文件|资料)?|第三(?:个)?(?:文档|文件|资料|篇)?|3rd|third)/i,
    /(?:第四份|第4份|第四个(?:文档|文件|资料)?|第四(?:个)?(?:文档|文件|资料|篇)?|4th|fourth)/i,
  ]
  const matches = ordinals.map((ordinal) => {
    const match = normalized.match(ordinal)
    return match ? { match, index: match.index ?? 0 } : undefined
  })
  ordinals.forEach((ordinal, index) => {
    const match = matches[index]?.match
    if (!match) return
    const start = Math.max(0, match.index ?? 0)
    const nextStart = matches
      .map((item) => item?.index)
      .filter((item): item is number => item !== undefined && item > start)
      .sort((left, right) => left - right)[0]
    const end = Math.min(normalized.length, nextStart ?? start + 56, start + 56)
    const window = normalized.slice(start, end)
    if (LICENSED_RE.test(window) || /(?:授权|licensed)/i.test(window)) result.set(index, "external_licensed")
    else if (EXTERNAL_REFERENCE_RE.test(window) || PUBLIC_RE.test(window)) result.set(index, "external_public")
    else if (INTERNAL_RE.test(window)) result.set(index, "internal_company")
  })
  return result
}

function sourceRolePrompt(question: string, documents: ReferenceDocument[]) {
  return JSON.stringify({
    task: "Classify each local Word source document role for a C coding guideline generation task. Understand natural user wording such as 第一个文档/第二个文档/第一份/第二份/前者/后者. Do not invent files. Use only allowed sourceOrigin values.",
    allowedSourceOrigin: ["internal_company", "external_public", "external_licensed", "unknown"],
    allowedRole: ["internal", "external", "unknown"],
    userQuestion: question,
    documents: documents
      .map((document, index) => ({
        sourceId: document.id,
        mentionIndex: document.mentionIndex ?? index,
        ordinal: `${index + 1}`,
        path: document.read.metadata.path,
        title: document.read.metadata.title,
      }))
      .sort((left, right) => left.mentionIndex - right.mentionIndex),
    outputShape: {
      sources: [{
        sourceId: "src-1",
        sourceOrigin: "internal_company",
        role: "internal",
        confidence: 0.95,
        reason: "User explicitly said the first document is the company internal document.",
        explicit: true,
      }],
      warnings: [],
    },
  }, null, 2)
}

function mergeModelClassifications(documents: ReferenceDocument[], fallback: SourceOriginClassification[], plan: SourceRolePlanJson): SourceOriginClassification[] {
  const fallbackById = new Map(fallback.map((item) => [item.sourceId, item]))
  const modelById = new Map((plan.sources ?? []).map((item) => [clean(item.sourceId), item]))
  return documents.map((document) => {
    const fallbackItem = fallbackById.get(document.id) ?? classification(document.id, "unknown", 0.2, "未找到本地来源分类结果。", false, "来源类型未识别，已按 unknown 处理，不使用长原文摘录。")
    const modelItem = modelById.get(document.id)
    const origin = normalizeOrigin(modelItem?.sourceOrigin ?? modelItem?.origin)
    const confidence = normalizeConfidence(modelItem?.confidence)
    const explicit = modelItem?.explicit === true
    if (!origin || confidence < MODEL_CONFIDENCE_THRESHOLD) return fallbackItem
    const role = normalizeRole(modelItem?.role, origin)
    const reason = clean(modelItem?.reason) || "模型根据用户描述和 @ 文件顺序识别来源角色。"
    const conflictWarning = explicit && fallbackItem.origin !== "unknown" && fallbackItem.origin !== origin
      ? `来源角色与文件名/metadata 推断不一致，已按用户显式说明处理：${document.read.metadata.path}。`
      : undefined
    return {
      sourceId: document.id,
      origin,
      role,
      confidence,
      reason,
      explicit,
      warning: conflictWarning,
    }
  })
}

function normalizeOrigin(input: unknown): SourceOrigin | undefined {
  if (input === "internal_company" || input === "external_public" || input === "external_licensed" || input === "unknown") return input
  return undefined
}

function normalizeRole(input: unknown, origin: SourceOrigin): ReferenceDocRole {
  if (input === "internal" || input === "external" || input === "unknown") return input
  return roleFromOrigin(origin)
}

function normalizeConfidence(input: unknown) {
  const value = Number(input)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function clean(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}

function classification(sourceId: string, origin: SourceOrigin, confidence: number, reason: string, explicit: boolean, warning?: string): SourceOriginClassification {
  return {
    sourceId,
    origin,
    role: roleFromOrigin(origin),
    confidence,
    reason,
    explicit,
    warning,
  }
}

function roleFromOrigin(origin: SourceOrigin): ReferenceDocRole {
  if (origin === "internal_company") return "internal"
  if (origin === "external_public" || origin === "external_licensed") return "external"
  return "unknown"
}

function externalNote(origin: SourceOrigin) {
  if (origin === "external_licensed") return "授权外部资料默认摘要或改写，不复制完整原文。"
  if (origin === "external_public") return "公开外部资料默认摘要或改写，不复制完整原文。"
  return "来源类型未知，默认摘要或改写，不使用长原文摘录。"
}
