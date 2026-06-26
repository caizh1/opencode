import { ruleExtractionCacheKey, RULE_EXTRACTOR_VERSION, type RuleExtractionCache } from "./RuleExtractionCache"
import { classifyCSourceContent } from "./CCodingGuidelineQuality"
import { firstRuleAnchor, normalizeRuleAnchor } from "./RuleAnchors"
import type { CandidateRule, DocAgentModelProvider, ReferenceChunk, RulePriority, SourceContentKind } from "./types"

const DEFAULT_BATCH_SIZE = 3
const DEFAULT_MAX_BATCH_BYTES = 16 * 1024
const DEFAULT_CONCURRENCY = 2
const MAX_MODEL_RULES_PER_CHUNK = 6

type RuleJson = {
  rules?: Array<Partial<CandidateRule> & {
    priority?: RulePriority | "必须" | "应该" | "建议"
    sourceContentKind?: SourceContentKind
  }>
}

type BatchRuleJson = {
  chunkResults?: Array<{
    chunkId?: string
    rules?: RuleJson["rules"]
    warnings?: string[]
  }>
}

type IndexedChunk = {
  chunk: ReferenceChunk
  index: number
}

export type RuleExtractionProgress = {
  index: number
  total: number
  chunk: ReferenceChunk
  stage: "start" | "success" | "fallback" | "cache" | "batch-start" | "batch-success" | "skip"
  message: string
  ruleCount?: number
  warning?: string
  completed?: number
  batchIndex?: number
  totalBatches?: number
  cacheHitCount?: number
  skippedCount?: number
}

export type RuleExtractionOptions = {
  signal?: AbortSignal
  onProgress?: (progress: RuleExtractionProgress) => void
  log?: (message: string) => void
  batchSize?: number
  maxBatchBytes?: number
  concurrency?: number
  cache?: RuleExtractionCache
  modelName?: string
}

export class GuidelineRuleExtractor {
  constructor(private readonly model?: DocAgentModelProvider) {}

  async extract(chunks: ReferenceChunk[], options?: AbortSignal | RuleExtractionOptions) {
    const opts = normalizeOptions(options)
    const total = chunks.length
    const results: CandidateRule[][] = Array.from({ length: chunks.length }, () => [])
    const warnings: string[] = []
    let completed = 0
    let cacheHitCount = 0
    const pending: IndexedChunk[] = []
    const modelName = opts.modelName ?? this.model?.cacheKey?.() ?? "unknown-model"

    for (let index = 0; index < chunks.length; index += 1) {
      opts.signal?.throwIfAborted()
      const chunk = chunks[index]!
      const current = index + 1
      const startMessage = `提取候选规则：${current}/${total} - ${chunkLabel(chunk)}`
      opts.log?.(`[doc-agent] ${startMessage}`)
      opts.onProgress?.({ index: current, total, chunk, stage: "start", message: startMessage, completed })
      const cached = await getCachedRules(opts.cache, chunk, modelName, warnings, opts.log)
      if (cached) {
        results[index] = cached.map((rule, localIndex) => ({
          ...rule,
          id: `${chunk.id}-cache-${localIndex + 1}`,
          sourceDocument: chunk.sourcePath,
          sourceRole: chunk.role,
          sourceOrigin: chunk.sourceOrigin,
          sourceRuleAnchor: normalizeRuleAnchor(rule.sourceRuleAnchor) ?? chunk.sourceRuleAnchor,
          sourceSection: sourceSectionForChunk(chunk, normalizeRuleAnchor(rule.sourceRuleAnchor) ?? chunk.sourceRuleAnchor),
          sourceLocation: sourceLocationForChunk(chunk, normalizeRuleAnchor(rule.sourceRuleAnchor) ?? chunk.sourceRuleAnchor),
        }))
        completed += 1
        cacheHitCount += 1
        const message = `提取候选规则：${current}/${total} - ${chunkLabel(chunk)}（缓存命中，${cached.length} 条规则）`
        opts.log?.(`[doc-agent] extraction cache hit: ${chunk.id}; rules=${cached.length}`)
        opts.onProgress?.({ index: current, total, chunk, stage: "cache", message, ruleCount: cached.length, completed, cacheHitCount })
      } else {
        pending.push({ chunk, index })
      }
    }

    if (pending.length === 0) {
      drainCacheWarnings(opts.cache, warnings)
      return { rules: dedupeRules(results.flat()), warnings: dedupeWarnings(warnings) }
    }

    if (!this.model) {
      for (const item of pending) {
        const extracted = heuristicRules(item.chunk)
        results[item.index] = extracted
        completed += 1
        emitSuccess(item, total, extracted.length, completed, opts)
      }
      drainCacheWarnings(opts.cache, warnings)
      return { rules: dedupeRules(results.flat()), warnings: dedupeWarnings(warnings) }
    }

    const batches = makeBatches(pending, opts)
    opts.log?.(`[doc-agent] rule extraction batches: chunks=${chunks.length}; pending=${pending.length}; cacheHits=${cacheHitCount}; batches=${batches.length}; concurrency=${normalizedConcurrency(opts.concurrency)}`)
    await runBatches(batches, normalizedConcurrency(opts.concurrency), async (batch, batchIndex) => {
      opts.signal?.throwIfAborted()
      const first = batch[0]!
      opts.log?.(`[doc-agent] extract-rules batch ${batchIndex + 1}/${batches.length}: chunks=${batch.length}`)
      opts.onProgress?.({
        index: first.index + 1,
        total,
        chunk: first.chunk,
        stage: "batch-start",
        message: `批量提取候选规则：${batchIndex + 1}/${batches.length}（${batch.length} 个 chunk）`,
        completed,
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        cacheHitCount,
      })
      try {
        const output = await this.model!.completeJson<BatchRuleJson>({
          purpose: "extract-rules-batch",
          system: "Extract C coding guideline rules for each chunk as strict JSON. Do not copy long source text. Return JSON only.",
          prompt: batchExtractionPrompt(batch.map((item) => item.chunk)),
        }, opts.signal)
        const byChunk = new Map((output.chunkResults ?? []).map((item) => [String(item.chunkId ?? ""), item]))
        for (const item of batch) {
          opts.signal?.throwIfAborted()
          const result = byChunk.get(item.chunk.id)
          if (!result) {
            const warning = `批量规则提取缺少 chunk 结果：${chunkLabel(item.chunk)}`
            opts.log?.(`[doc-agent] ${warning}; retrySingleChunk=true`)
            completed = await retrySingleChunkOrFallback({
              item,
              total,
              completed,
              reason: warning,
              results,
              opts,
              model: this.model!,
              modelName,
              warnings,
            })
            continue
          }
          const extracted = normalizeModelRules({ rules: result.rules }, item.chunk)
          results[item.index] = extracted
          if (extracted.length === 0) pushNoRulesWarning(item.chunk, warnings, opts.log)
          for (const warning of result.warnings ?? []) warnings.push(`${chunkLabel(item.chunk)}：${warning}`)
          await setCachedRules(opts.cache, item.chunk, modelName, extracted, warnings, opts.log)
          completed += 1
          emitSuccess(item, total, extracted.length, completed, opts)
        }
        opts.log?.(`[doc-agent] extract-rules batch ${batchIndex + 1}/${batches.length} completed`)
        opts.onProgress?.({
          index: first.index + 1,
          total,
          chunk: first.chunk,
          stage: "batch-success",
          message: `批量提取候选规则完成：${batchIndex + 1}/${batches.length}`,
          completed,
          batchIndex: batchIndex + 1,
          totalBatches: batches.length,
          cacheHitCount,
        })
      } catch (error) {
        if (opts.signal?.aborted || isAbortError(error)) throw error
        const warning = `批量规则提取失败：batch ${batchIndex + 1}/${batches.length}：${error instanceof Error ? error.message : String(error)}`
        opts.log?.(`[doc-agent] ${warning}; retrySingleChunks=${batch.length}`)
        for (const item of batch) {
          completed = await retrySingleChunkOrFallback({
            item,
            total,
            completed,
            reason: warning,
            results,
            opts,
            model: this.model!,
            modelName,
            warnings,
          })
        }
      }
    })

    drainCacheWarnings(opts.cache, warnings)
    return { rules: dedupeRules(results.flat()), warnings: dedupeWarnings(warnings) }
  }
}

function normalizeOptions(options?: AbortSignal | RuleExtractionOptions): RuleExtractionOptions {
  if (!options) return {}
  return isAbortSignal(options) ? { signal: options } : options
}

function isAbortSignal(input: AbortSignal | RuleExtractionOptions): input is AbortSignal {
  return "aborted" in input && typeof input.addEventListener === "function"
}

function chunkLabel(chunk: ReferenceChunk) {
  return `${chunk.sourcePath} / ${chunk.headingPath.join(" > ") || "未命名章节"}`
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function extractionPrompt(chunk: ReferenceChunk) {
  return [
    "Extract at most 6 core rules from this chunk.",
    "First judge whether the chunk is a real coding rule section. If it is only examples, risk/limitations, references, appendix index, or implementation guidance, return an empty rules array.",
    'For each returned rule include sourceContentKind as one of: "core-rule", "rule-matrix", "unknown". Do not return rules from sourceContentKind values such as example, implementation-guidance, risk-limit, reference, appendix-index or narrative.',
    "Output title, category, description, recommended, discouraged, rationale and exceptions in Simplified Chinese. If the source text is English, translate the rule meaning into Chinese instead of copying English sentences.",
    "Keep every JSON string concise. Do not copy long source text.",
    "",
    `sourcePath: ${chunk.sourcePath}`,
    `sourceRole: ${chunk.role}`,
    `sourceOrigin: ${chunk.sourceOrigin ?? "unknown"}`,
    `sourceRuleAnchor: ${chunk.sourceRuleAnchor ?? "none"}`,
    `sourceContentKindHint: ${chunk.contentKind ?? classifyCSourceContent({ headingPath: chunk.headingPath, text: chunk.text })}`,
    `section: ${chunk.headingPath.join(" > ") || "Untitled section"}`,
    "",
    "Return JSON shape:",
    '{"rules":[{"title":"","category":"","priority":"must|should|recommend","sourceRuleAnchor":"","sourceContentKind":"core-rule|rule-matrix|unknown","description":"","recommended":"","discouraged":"","rationale":"","exceptions":""}]}',
    "",
    "Source text:",
    chunk.text,
  ].join("\n")
}

function batchExtractionPrompt(chunks: ReferenceChunk[]) {
  return [
    "Extract at most 6 core rules per chunk.",
    "Every input chunkId must appear exactly once in chunkResults, even when no clear rules are found.",
    "Only output rules for chunks that are real coding rule sections or rule matrix entries. Chunks that are examples, risk/limitations, references, appendix index, or implementation guidance must return rules: [].",
    'For each rule include sourceContentKind as one of: "core-rule", "rule-matrix", "unknown".',
    "Output every user-readable rule field in Simplified Chinese. If a chunk is English, translate the rule meaning into Chinese instead of returning English rule text.",
    "Keep every JSON string concise. Do not copy long source text.",
    "",
    "Return JSON shape:",
    '{"chunkResults":[{"chunkId":"","rules":[{"title":"","category":"","priority":"must|should|recommend","sourceRuleAnchor":"","sourceContentKind":"core-rule|rule-matrix|unknown","description":"","recommended":"","discouraged":"","rationale":"","exceptions":""}],"warnings":[]}]}',
    "",
    "Chunks:",
    JSON.stringify(chunks.map((chunk) => ({
      chunkId: chunk.id,
      sourcePath: chunk.sourcePath,
      sourceRole: chunk.role,
      sourceOrigin: chunk.sourceOrigin,
      sourceRuleAnchor: chunk.sourceRuleAnchor,
      sourceContentKindHint: chunk.contentKind ?? classifyCSourceContent({ headingPath: chunk.headingPath, text: chunk.text }),
      section: chunk.headingPath.join(" > ") || "Untitled section",
      text: chunk.text,
    })), null, 2),
  ].join("\n")
}

function normalizeModelRules(output: RuleJson, chunk: ReferenceChunk): CandidateRule[] {
  const fallbackContentKind = chunk.contentKind ?? classifyCSourceContent({ headingPath: chunk.headingPath, text: chunk.text })
  return (Array.isArray(output.rules) ? output.rules : []).slice(0, MAX_MODEL_RULES_PER_CHUNK).map((rule, index) => {
    const sourceRuleAnchor = normalizeRuleAnchor(rule.sourceRuleAnchor) ?? chunk.sourceRuleAnchor ?? firstRuleAnchor(`${clean(rule.title)} ${clean(rule.description)}`)
    return {
      id: `${chunk.id}-model-${index + 1}`,
      title: clean(rule.title) || fallbackTitle(chunk, index),
      category: clean(rule.category) || categoryFromText(clean(rule.title) || chunk.text),
      priority: normalizePriority(rule.priority),
      description: clean(rule.description) || firstSentence(chunk.text),
      recommended: clean(rule.recommended),
      discouraged: clean(rule.discouraged),
      rationale: clean(rule.rationale),
      exceptions: clean(rule.exceptions),
      sourceDocument: chunk.sourcePath,
      sourceRole: chunk.role,
      sourceOrigin: chunk.sourceOrigin,
      sourceContentKind: normalizeSourceContentKind(rule.sourceContentKind) ?? fallbackContentKind,
      sourceRuleAnchor,
      sourceSection: sourceSectionForChunk(chunk, sourceRuleAnchor),
      sourceLocation: sourceLocationForChunk(chunk, sourceRuleAnchor),
    }
  }).filter((rule) => rule.description.length > 0)
}

export function heuristicRules(chunk: ReferenceChunk): CandidateRule[] {
  const sourceContentKind = chunk.contentKind ?? classifyCSourceContent({ headingPath: chunk.headingPath, text: chunk.text })
  const lines = chunk.text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/^\d+[.)]\s*/, "").trim())
    .filter((line) => line.length >= 12)
    .filter((line) => /(?:【\s*(?:规则|建议)|必须|不得|禁止|应该|建议|需要|shall|must|should|avoid|required)/i.test(line))
    .slice(0, 8)
  return lines.map((line, index) => {
    const sourceRuleAnchor = firstRuleAnchor(line) ?? chunk.sourceRuleAnchor
    return {
      id: `${chunk.id}-heuristic-${index + 1}`,
      title: titleFromLine(line, index),
      category: categoryFromText(`${chunk.headingPath.join(" ")} ${line}`),
      priority: priorityFromText(line),
      description: line,
      sourceDocument: chunk.sourcePath,
      sourceRole: chunk.role,
      sourceOrigin: chunk.sourceOrigin,
      sourceContentKind,
      sourceRuleAnchor,
      sourceSection: sourceSectionForChunk(chunk, sourceRuleAnchor),
      sourceLocation: sourceLocationForChunk(chunk, sourceRuleAnchor),
    }
  })
}

function normalizeSourceContentKind(input: unknown): SourceContentKind | undefined {
  const value = String(input ?? "")
  if (value === "core-rule" || value === "rule-matrix" || value === "example" || value === "implementation-guidance" || value === "risk-limit" || value === "reference" || value === "appendix-index" || value === "narrative" || value === "unknown") return value
  return undefined
}

function makeBatches(chunks: IndexedChunk[], options: RuleExtractionOptions) {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE))
  const maxBytes = Math.max(1024, Math.floor(options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES))
  const batches: IndexedChunk[][] = []
  let current: IndexedChunk[] = []
  let currentBytes = 0
  let currentGroup = ""
  const flush = () => {
    if (current.length === 0) return
    batches.push(current)
    current = []
    currentBytes = 0
    currentGroup = ""
  }
  for (const item of chunks) {
    const bytes = Buffer.byteLength(item.chunk.text, "utf8")
    const group = `${item.chunk.sourceId}:${item.chunk.role}:${item.chunk.sourceOrigin ?? "unknown"}`
    if (
      current.length > 0
      && (current.length >= batchSize || currentBytes + bytes > maxBytes || currentGroup !== group)
    ) {
      flush()
    }
    current.push(item)
    currentBytes += bytes
    currentGroup = group
  }
  flush()
  return batches
}

async function runBatches<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index]!, index)
    }
  })
  await Promise.all(workers)
}

function normalizedConcurrency(input: number | undefined) {
  return Math.max(1, Math.min(4, Math.floor(input ?? DEFAULT_CONCURRENCY)))
}

async function getCachedRules(cache: RuleExtractionCache | undefined, chunk: ReferenceChunk, modelName: string, warnings: string[], log?: (message: string) => void) {
  if (!cache) return undefined
  try {
    const key = ruleExtractionCacheKey({ chunk, modelName, extractorVersion: RULE_EXTRACTOR_VERSION })
    const result = await cache.get(key)
    if (!result) log?.(`[doc-agent] extraction cache miss: ${chunk.id}`)
    return result
  } catch (error) {
    const warning = `规则抽取缓存读取失败，已忽略：${error instanceof Error ? error.message : String(error)}`
    warnings.push(warning)
    log?.(`[doc-agent] ${warning}`)
    return undefined
  }
}

async function setCachedRules(cache: RuleExtractionCache | undefined, chunk: ReferenceChunk, modelName: string, rules: CandidateRule[], warnings: string[], log?: (message: string) => void) {
  if (!cache) return
  try {
    const key = ruleExtractionCacheKey({ chunk, modelName, extractorVersion: RULE_EXTRACTOR_VERSION })
    await cache.set(key, rules)
  } catch (error) {
    const warning = `规则抽取缓存写入失败，已忽略：${error instanceof Error ? error.message : String(error)}`
    warnings.push(warning)
    log?.(`[doc-agent] ${warning}`)
  }
}

function drainCacheWarnings(cache: RuleExtractionCache | undefined, warnings: string[]) {
  for (const warning of cache?.drainWarnings?.() ?? []) warnings.push(warning)
}

async function retrySingleChunkOrFallback(input: {
  item: IndexedChunk
  total: number
  completed: number
  reason: string
  results: CandidateRule[][]
  opts: RuleExtractionOptions
  model: DocAgentModelProvider
  modelName: string
  warnings: string[]
}) {
  const { item, total, reason, results, opts, model, modelName, warnings } = input
  opts.signal?.throwIfAborted()
  opts.log?.(`[doc-agent] retry extract-rules single chunk after batch issue: ${chunkLabel(item.chunk)}`)
  try {
    const output = await model.completeJson<RuleJson>({
      purpose: "extract-rules",
      system: "Extract C coding guideline rules from one chunk as strict JSON. Do not copy long source text. Return JSON only.",
      prompt: extractionPrompt(item.chunk),
    }, opts.signal)
    opts.signal?.throwIfAborted()
    const extracted = normalizeModelRules(output, item.chunk)
    results[item.index] = extracted
    if (extracted.length === 0) pushNoRulesWarning(item.chunk, warnings, opts.log)
    await setCachedRules(opts.cache, item.chunk, modelName, extracted, warnings, opts.log)
    const nextCompleted = input.completed + 1
    opts.log?.(`[doc-agent] single chunk retry succeeded: ${chunkLabel(item.chunk)}; rules=${extracted.length}`)
    emitSuccess(item, total, extracted.length, nextCompleted, opts)
    return nextCompleted
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) throw error
    const retryWarning = retryFailureWarning(reason, item.chunk, error)
    warnings.push(retryWarning)
    opts.log?.(`[doc-agent] ${retryWarning}`)
    return fallbackChunk(item, total, input.completed, retryWarning, results, opts)
  }
}

function retryFailureWarning(reason: string, chunk: ReferenceChunk, error: unknown) {
  const errorText = error instanceof Error ? error.message : String(error)
  if (reason.startsWith("批量规则提取失败")) {
    return `批量失败后单 chunk 重试仍失败：${chunkLabel(chunk)}：${errorText}`
  }
  if (reason.startsWith("批量规则提取缺少")) {
    return `批量结果缺少该 chunk，单 chunk 重试仍失败：${chunkLabel(chunk)}：${errorText}`
  }
  return `${reason}；单 chunk 重试仍失败：${errorText}`
}

function emitSuccess(item: IndexedChunk, total: number, ruleCount: number, completed: number, opts: RuleExtractionOptions) {
  const message = `提取候选规则：${item.index + 1}/${total} - ${chunkLabel(item.chunk)}，得到 ${ruleCount} 条规则`
  opts.log?.(`[doc-agent] ${message}`)
  opts.onProgress?.({ index: item.index + 1, total, chunk: item.chunk, stage: "success", message, ruleCount, completed })
}

function fallbackChunk(item: IndexedChunk, total: number, completed: number, warning: string, results: CandidateRule[][], opts: RuleExtractionOptions) {
  const fallback = heuristicRules(item.chunk)
  results[item.index] = fallback
  const nextCompleted = completed + 1
  const message = `提取候选规则：${item.index + 1}/${total} - ${chunkLabel(item.chunk)}（模型失败，单 chunk 重试后已回退本地规则，得到 ${fallback.length} 条）`
  opts.onProgress?.({ index: item.index + 1, total, chunk: item.chunk, stage: "fallback", message, ruleCount: fallback.length, warning, completed: nextCompleted })
  return nextCompleted
}

const NO_RULE_WARNING_LOW_VALUE_HEADING_RE = /(?:目录|附录|速查表|风险|限制|后续完善|参考资料|引用|修订|版本|变更记录|references?|appendix|contents?|revision|history)/i
const STRONG_RULE_SIGNAL_RE = /(?:必须|不得|禁止|应该|建议|应当|shall|must|should|required|不应|禁止使用)/i

function pushNoRulesWarning(chunk: ReferenceChunk, warnings: string[], log?: (message: string) => void) {
  const warning = `未从 ${chunkLabel(chunk)} 提取到明确规则。`
  if (!shouldWarnNoRules(chunk)) {
    log?.(`[doc-agent] info: ${warning}`)
    return
  }
  warnings.push(warning)
}

function shouldWarnNoRules(chunk: ReferenceChunk) {
  const heading = chunk.headingPath.join(" ")
  if (NO_RULE_WARNING_LOW_VALUE_HEADING_RE.test(heading)) return false
  return STRONG_RULE_SIGNAL_RE.test(chunk.text)
}

function dedupeRules(rules: CandidateRule[]) {
  const seen = new Set<string>()
  const result: CandidateRule[] = []
  for (const rule of rules) {
    const key = `${rule.sourceDocument}:${rule.sourceSection}:${rule.title}:${rule.description}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(rule)
  }
  return result
}

function dedupeWarnings(warnings: string[]) {
  return [...new Set(warnings.filter(Boolean))]
}

function normalizePriority(priority: unknown): RulePriority {
  const value = String(priority ?? "").toLowerCase()
  if (value === "must" || value.includes("必须") || value.includes("shall")) return "must"
  if (value === "should" || value.includes("应该")) return "should"
  return "recommend"
}

function priorityFromText(text: string): RulePriority {
  if (/【\s*规则/i.test(text)) return "must"
  if (/【\s*建议/i.test(text)) return "recommend"
  if (/(?:必须|不得|禁止|shall|must|required)/i.test(text)) return "must"
  if (/(?:应该|should)/i.test(text)) return "should"
  return "recommend"
}

function categoryFromText(text: string) {
  if (/(?:存储访问一致性|存储同步|多主设备|多核访问|共享变量|cache|ECC|原子性|barrier|DMAC|NFC|内存屏障|同步屏障)/i.test(text)) return "存储访问一致性"
  if (/(?:命名|name|identifier)/i.test(text)) return "命名规范"
  if (/(?:指针|内存|pointer|memory)/i.test(text)) return "指针与内存安全"
  if (/(?:整数|类型|cast|integer|type)/i.test(text)) return "类型与整数安全"
  if (/(?:注释|comment)/i.test(text)) return "注释规范"
  if (/(?:函数|function)/i.test(text)) return "函数设计"
  if (/(?:头文件|header)/i.test(text)) return "头文件规范"
  if (/(?:宏|macro|enum|常量)/i.test(text)) return "宏、枚举、常量"
  if (/(?:错误|返回值|error|return)/i.test(text)) return "错误处理"
  return "通用编码原则"
}

function titleFromLine(line: string, index: number) {
  const text = line
    .replace(/【\s*(?:规则|建议)\s*[0-9]+(?:[-.][0-9]+)*\s*】/g, "")
    .replace(/[。；;].*$/, "")
    .replace(/^(?:必须|应该|建议|禁止|不得)\s*/, "")
    .trim()
  return text.slice(0, 36) || `规则 ${index + 1}`
}

function sourceSectionForChunk(chunk: ReferenceChunk, sourceRuleAnchor: string | undefined) {
  const section = chunk.headingPath.join(" > ") || "未命名章节"
  return sourceRuleAnchor ? `${section} > ${sourceRuleAnchor}` : section
}

function sourceLocationForChunk(chunk: ReferenceChunk, sourceRuleAnchor: string | undefined) {
  const location = chunk.sourceLocations[0] ?? { path: chunk.sourcePath, headingPath: chunk.headingPath }
  return sourceRuleAnchor ? { ...location, sourceRuleAnchor } : location
}

function fallbackTitle(chunk: ReferenceChunk, index: number) {
  const heading = chunk.headingPath.at(-1)
  return heading ? `${heading} 规则 ${index + 1}` : `规则 ${index + 1}`
}

function firstSentence(text: string) {
  return text.split(/[。.!?]\s*/)[0]?.trim().slice(0, 240) ?? ""
}

function clean(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}

// Kept for compatibility with focused tests and future single-chunk diagnostics.
export const singleChunkExtractionPromptForTest = extractionPrompt
export const batchExtractionPromptForTest = batchExtractionPrompt
