import { createWordDocument } from "../tools/createWordDocumentTool"
import { readDocx } from "../tools/readDocxTool"
import { CCodingGuidelineExampleIntentPlanner } from "./CCodingGuidelineExampleIntentPlanner"
import { CCodingGuidelineExamplePlanner } from "./CCodingGuidelineExamplePlanner"
import { CCodingGuidelinePreservationPolicy, CCodingGuidelineSourceClassifier } from "./CCodingGuidelineSourceClassifier"
import { CandidateRuleQualityGate, classifyCSourceContent, sanitizeCGuidelineRuleCards, validateCCodingGuidelineSourcePlacement } from "./CCodingGuidelineQuality"
import { CCodingGuidelineRecipe } from "./CCodingGuidelineRecipe"
import { DocumentRecipeRegistry } from "./DocumentRecipeRegistry"
import { DocumentPlanGenerator, normalizeRuleCardForPlan } from "./DocumentPlanGenerator"
import { DocumentOutlinePlanner } from "./DocumentOutlinePlanner"
import { EvidencePackBuilder } from "./EvidencePackBuilder"
import { GuidelineDraftComposer } from "./GuidelineDraftComposer"
import { normalizeGeneratedExamplesForRule, type ClassifiedGuidelineItem } from "./GuidelineDraftModelContract"
import { GuidelineDraftReviewAgent } from "./GuidelineDraftReviewAgent"
import { GuidelineMerger, type GuidelineMergeProgress } from "./GuidelineMerger"
import { GuidelineRuleExtractor } from "./GuidelineRuleExtractor"
import { LocalReferencePackRecipe } from "./LocalReferencePackRecipe"
import { ReferenceDocExtractor } from "./ReferenceDocExtractor"
import { ReportQualityGate } from "./ReportQualityGate"
import { createWorkspaceRuleExtractionCache } from "./RuleExtractionCache"
import { createWorkspaceRuleExampleIntentCache } from "./RuleExampleIntentCache"
import { normalizeRuleCardReadableText } from "./RuleLanguage"
import { RuleChunkFilter } from "./RuleChunkFilter"
import { createWorkspaceSourceBlockPlacementCache } from "./SourceBlockPlacementCache"
import { SourceBlockPlacementPlanner, type SourceBlockPlacementProgress } from "./SourceBlockPlacementPlanner"
import { SourcePreservationExtractor } from "./SourcePreservationExtractor"
import { WordDocSpecGenerator } from "./WordDocSpecGenerator"
import type {
  ConflictResolutionChoice,
  ConflictResolutionDecision,
  ConflictRule,
  DocAgentModelProvider,
  DocAgentTimelineEvent,
  DocumentPlan,
  DocumentAgentProgress,
  EvidencePack,
  GeneratedDocumentResult,
  ReferenceDocument,
  DocumentSection,
  SourceOriginClassification,
  SourceBackedBlock,
  RuleCardSpec,
  WordDocSpec,
} from "./types"

type TimelineEventInput = Omit<DocAgentTimelineEvent, "id" | "timestamp">

const DOCUMENT_STAGE_TOTAL = 10

export type DocumentAgentInput = {
  question: string
  files: Array<{ path: string; bytes: Uint8Array; mentionIndex?: number }>
  model?: DocAgentModelProvider
  signal?: AbortSignal
  onProgress?: (progress: DocumentAgentProgress) => void
  onTimeline?: (event: DocAgentTimelineEvent) => void
  resolveConflictDecisions?: (conflicts: ConflictRule[], signal?: AbortSignal) => Promise<ConflictResolutionDecision[]>
  log?: (message: string) => void
  createDocument?: typeof createWordDocument
}

export class GuidelineReferencePackFlow {
  private readonly registry = new DocumentRecipeRegistry()
  private readonly referenceExtractor = new ReferenceDocExtractor()

  constructor() {
    this.registry.register(new CCodingGuidelineRecipe())
    this.registry.register(new LocalReferencePackRecipe())
  }

  async run(input: DocumentAgentInput): Promise<GeneratedDocumentResult> {
    let eventSequence = 0
    const runWarnings = new Set<string>()
    const emit = (event: TimelineEventInput) => {
      const item: DocAgentTimelineEvent = {
        id: `doc-agent-${++eventSequence}`,
        timestamp: Date.now(),
        ...event,
      }
      input.onTimeline?.(item)
      return item
    }
    const addWarnings = (source: string, warnings: string[]) => {
      for (const warning of warnings) {
        const trimmed = warning.trim()
        if (!trimmed) continue
        if (runWarnings.has(trimmed)) continue
        runWarnings.add(trimmed)
        input.log?.(`[doc-agent] warning (${source}): ${trimmed}`)
      }
    }

    const orderedFiles = orderInputFiles(input.files)
    input.log?.(`[doc-agent] start local reference pack flow: files=${orderedFiles.length}`)
    emit({ type: "run.started", title: "启动本地 Word 生成流程", status: "running", detail: `${orderedFiles.length} 份本地 Word 资料` })
    if (orderedFiles.length < 2) {
      throw new Error("请至少 @ 两份 .docx：公司内部 C 编码规范 + 外部参考规范资料。")
    }
    try {
      const readDocuments: ReferenceDocument[] = []
      for (let index = 0; index < orderedFiles.length; index += 1) {
        input.signal?.throwIfAborted()
        const file = orderedFiles[index]!
        input.log?.(`[doc-agent] reading docx ${index + 1}/${orderedFiles.length}: ${file.path}`)
        emit({
          type: "read_docx",
          title: "读取 Word 资料",
          detail: `正在读取 ${index + 1}/${orderedFiles.length}：${file.path}`,
          status: "running",
          timelineKey: "read_docx",
          stateLabel: "读取中",
          current: 1,
          total: DOCUMENT_STAGE_TOTAL,
        })
        input.onProgress?.({ stage: "reading", message: `读取 Word：${file.path}`, current: index + 1, total: orderedFiles.length })
        const read = await readDocx({ path: file.path, bytes: file.bytes })
        addWarnings(`read_docx ${file.path}`, read.metadata.readWarnings)
        readDocuments.push({ id: `src-${index + 1}`, role: "unknown", sourceOrigin: "unknown", mentionIndex: file.mentionIndex ?? index, read })
        input.log?.(`[doc-agent] read docx ${index + 1}/${orderedFiles.length}: ${file.path}; blocks=${read.blocks.length}; warnings=${read.metadata.readWarnings.length}`)
        emit({
          type: "read_docx",
          title: "读取 Word 资料",
          detail: `已读取 ${index + 1}/${orderedFiles.length}：${file.path} · ${read.blocks.length} 个语义块`,
          status: "completed",
          timelineKey: "read_docx",
          stateLabel: index + 1 === orderedFiles.length ? "完成" : "读取中",
          current: 1,
          total: DOCUMENT_STAGE_TOTAL,
        })
      }

      const recipe = await this.registry.select({ question: input.question, documents: readDocuments })
      if (!recipe) throw new Error("未找到可处理该 Word 整合任务的 DocumentRecipe。")
      input.log?.(`[doc-agent] selected recipe: ${recipe.id}`)
      const plan = await new DocumentPlanGenerator(input.model).generate({
        question: input.question,
        recipeId: recipe.id,
        documents: readDocuments,
      }, input.signal)
      input.log?.(`[doc-agent] built document plan: title=${plan.output.title}; conflictPolicy=${plan.conflictPolicy}; sections=${plan.sectionPlan.length}`)
      emit({
        type: "plan",
        title: "生成 DocumentPlan",
        detail: `${plan.output.title} · 冲突策略 ${plan.conflictPolicy} · ${plan.sectionPlan.length} 个计划章节`,
        status: "completed",
        timelineKey: "plan",
        stateLabel: "完成",
        current: 2,
        total: DOCUMENT_STAGE_TOTAL,
      })
      addWarnings("plan", plan.warnings)
      const classifications = recipe.id === "c-coding-guideline"
        ? await new CCodingGuidelineSourceClassifier().classifyWithModel({
          question: input.question,
          documents: readDocuments,
          model: input.model,
          signal: input.signal,
          log: input.log,
        })
        : []
      const sourceWarnings = classifications.flatMap((item) => item.warning ? [item.warning] : [])
      const documents = this.referenceExtractor.classifyDocuments(applySourceClassifications(readDocuments, classifications))
      if (classifications.length > 0) {
        input.log?.(`[doc-agent] source roles: ${classifications.map((item) => `${item.sourceId}=${item.origin}/${item.role}; confidence=${item.confidence}; explicit=${item.explicit}`).join(", ")}`)
        emit({
          type: "source_classify",
          title: "识别来源角色",
          detail: `${classifications.length} 份资料已识别来源角色`,
          status: "completed",
          timelineKey: "source_classify",
          stateLabel: "完成",
          current: 2,
          total: DOCUMENT_STAGE_TOTAL,
        })
        addWarnings("source_classify", sourceWarnings)
      }

      const chunks = documents.flatMap((document) => this.referenceExtractor.chunks(document)).map((chunk) => ({
        ...chunk,
        contentKind: classifyCSourceContent({ headingPath: chunk.headingPath, text: chunk.text }),
      }))
      const filteredChunks = new RuleChunkFilter().filter(chunks)
      const preservation = new SourcePreservationExtractor(new CCodingGuidelinePreservationPolicy()).extract(documents)
      const sourceBackedBlocks = preservation.sourceBackedBlocks.map((block) => ({
        ...block,
        contentKind: classifyCSourceContent({ headingPath: block.source.headingPath, text: blockTextForContentKind(block), kind: block.kind }),
      }))
      const internalWarning = hasInternalSource(documents) ? [] : ["内部规范来源识别不确定：未明确识别到公司内部规范。"]
      addWarnings("source_preservation", [...internalWarning, ...preservation.warnings])
      input.log?.(`[doc-agent] built reference chunks: ${chunks.length}; modelChunks=${filteredChunks.modelChunks.length}; skipped=${filteredChunks.skippedChunks.length}`)
      input.log?.(`[doc-agent] extracted source-backed blocks: ${sourceBackedBlocks.length}; warnings=${preservation.warnings.length}`)
      emit({
        type: "chunking",
        title: "按章节切分资料",
        detail: `${chunks.length} 个 chunk · 跳过 ${filteredChunks.skippedChunks.length} 个低规则信号 chunk · 模型处理 ${filteredChunks.modelChunks.length} 个 chunk`,
        status: "completed",
        timelineKey: "chunking",
        stateLabel: "完成",
        current: 3,
        total: DOCUMENT_STAGE_TOTAL,
      })
      for (const skipped of filteredChunks.skippedChunks) {
        input.log?.(`[doc-agent] skip rule extraction chunk: ${chunkLabel(skipped.chunk)}; reason=${skipped.reason}`)
      }
      input.onProgress?.({ stage: "extracting", message: `按章节分块提取候选规则：${chunks.length} 个 chunk，跳过 ${filteredChunks.skippedChunks.length} 个，模型处理 ${filteredChunks.modelChunks.length} 个`, current: 0, total: chunks.length })
      emit({
        type: "model.extract",
        title: "抽取候选规则",
        detail: `准备处理 ${filteredChunks.modelChunks.length} 个模型 chunk`,
        status: "running",
        timelineKey: "model.extract",
        stateLabel: "抽取中",
        current: 3,
        total: DOCUMENT_STAGE_TOTAL,
      })
      const extracted = await new GuidelineRuleExtractor(input.model).extract(filteredChunks.modelChunks, {
        signal: input.signal,
        log: input.log,
        batchSize: 4,
        concurrency: 2,
        cache: createWorkspaceRuleExtractionCache(),
        modelName: input.model?.cacheKey?.() ?? "doc-agent-model",
        onProgress: (progress) => {
          input.onProgress?.({ stage: "extracting", message: progress.message, current: progress.index, total: progress.total })
          input.log?.(`[doc-agent] rule extraction progress: ${progress.message}`)
          if (progress.stage === "fallback") {
            addWarnings("rule_extraction", [progress.warning ?? progress.message])
            return
          }
        },
      })
      addWarnings("rule_extraction", extracted.warnings)
      const candidateQuality = new CandidateRuleQualityGate().filter(extracted.rules)
      addWarnings("candidate_quality", candidateQuality.warnings)
      emit({
        type: "model.extract",
        title: "抽取候选规则",
        detail: `${candidateQuality.rules.length} 条候选规则 · 过滤 ${candidateQuality.rejected.length} 条非规则内容 · warning ${extracted.warnings.length + candidateQuality.warnings.length} 条`,
        status: "completed",
        timelineKey: "model.extract",
        stateLabel: "完成",
        current: 3,
        total: DOCUMENT_STAGE_TOTAL,
      })
      input.log?.(`[doc-agent] extracted candidate rules: rules=${extracted.rules.length}; accepted=${candidateQuality.rules.length}; rejected=${candidateQuality.rejected.length}; warnings=${extracted.warnings.length + candidateQuality.warnings.length}`)
      let pack = new EvidencePackBuilder().build({
        documents,
        rules: candidateQuality.rules,
        sourceBackedBlocks,
        warnings: [...plan.warnings, ...sourceWarnings, ...internalWarning, ...preservation.warnings, ...extracted.warnings, ...candidateQuality.warnings],
      })
      input.log?.(`[doc-agent] built evidence pack: candidates=${pack.candidateRules.length}; conflicts=${pack.conflictRules.length}; warnings=${pack.warnings.length}`)
      emit({
        type: "evidence",
        title: "整理 EvidencePack",
        detail: `${pack.candidateRules.length} 条候选规则 · ${pack.conflictRules.length} 条冲突 · warning ${pack.warnings.length} 条`,
        status: "completed",
        timelineKey: "evidence",
        stateLabel: "完成",
        current: 4,
        total: DOCUMENT_STAGE_TOTAL,
      })
      if (pack.conflictRules.length > 0) {
        input.log?.(`[doc-agent] waiting for conflict decisions: conflicts=${pack.conflictRules.length}`)
        const autoDecisions = conflictDecisionsFromPlan(plan, pack.conflictRules)
        const decisions = autoDecisions ?? await requestConflictDecisions(input, pack.conflictRules)
        input.signal?.throwIfAborted()
        pack = applyConflictDecisions(pack, decisions)
        input.log?.(`[doc-agent] resolved conflict decisions: ${decisions.map((item) => `${item.conflictId}=${item.choice}`).join(", ")}`)
        emit({
          type: "conflict.review",
          title: autoDecisions ? "已按用户指令处理冲突" : "冲突处理选择已确认",
          detail: autoDecisions ? `${conflictPolicyLabel(plan)} · ${conflictDecisionSummary(decisions)}` : conflictDecisionSummary(decisions),
          status: "completed",
          timelineKey: "conflict.review",
          stateLabel: "完成",
          total: pack.conflictRules.length,
        })
      }
      input.onProgress?.({ stage: "merging", message: "合并内部规范与外部参考规则", current: 5, total: DOCUMENT_STAGE_TOTAL })
      input.log?.("[doc-agent] merging internal and external rules")
      emit({
        type: "merge",
        title: "合并内部规范与外部参考规则",
        detail: `${pack.candidateRules.length} 条候选规则 · ${pack.conflictRules.length} 条冲突 · ${pack.sourceBackedBlocks.length} 个来源块`,
        status: "running",
        timelineKey: "merge",
        stateLabel: "合并中",
        current: 5,
        total: DOCUMENT_STAGE_TOTAL,
      })
      const merged = await new GuidelineMerger(input.model).merge(pack, plan, input.signal, {
        onProgress: (progress) => {
          input.log?.(`[doc-agent] merge progress: ${progress.message}`)
          if (progress.warning) addWarnings("merge", [progress.warning])
          input.onProgress?.({ stage: "merging", message: "合并内部规范与外部参考规则", current: 5, total: DOCUMENT_STAGE_TOTAL })
          emit({
            type: "merge",
            title: "合并内部规范与外部参考规则",
            detail: mergeProgressSummary(progress),
            status: "running",
            timelineKey: "merge",
            stateLabel: "合并中",
            current: 5,
            total: DOCUMENT_STAGE_TOTAL,
          })
        },
      })
      const placed = await new SourceBlockPlacementPlanner(input.model, {
        cache: createWorkspaceSourceBlockPlacementCache(),
        modelName: input.model?.cacheKey?.() ?? "unknown-model",
        validatePlacement: validateCCodingGuidelineSourcePlacement,
      }).apply({
        question: input.question,
        plan,
        rules: merged.rules,
        blocks: pack.sourceBackedBlocks,
        signal: input.signal,
        log: input.log,
        onProgress: (progress) => {
          input.log?.(`[doc-agent] source placement progress: ${progress.message}`)
          if (progress.warning) addWarnings("source_placement", [progress.warning])
          input.onProgress?.({ stage: "merging", message: "合并内部规范与外部参考规则", current: 5, total: DOCUMENT_STAGE_TOTAL })
          emit({
            type: "merge",
            title: "合并内部规范与外部参考规则",
            detail: sourceBlockPlacementProgressSummary(progress),
            status: "running",
            timelineKey: "merge",
            stateLabel: "来源归位中",
            current: 5,
            total: DOCUMENT_STAGE_TOTAL,
          })
        },
      })
      const sanitizedPlaced = sanitizeCGuidelineRuleCards(placed.rules.map((rule) => normalizeRuleCardForPlan(rule, plan)))
      const draftSourceRules = sanitizedPlaced.rules
      emit({
        type: "compose-draft",
        title: "模型生成规则草案",
        detail: `${draftSourceRules.length} 条规则进入模型草案生成`,
        status: "running",
        timelineKey: "compose-draft",
        stateLabel: "生成中",
        current: 6,
        total: DOCUMENT_STAGE_TOTAL,
      })
      const composedDraft = await new GuidelineDraftComposer(input.model).compose({
        question: input.question,
        plan,
        documents,
        pack,
        rules: draftSourceRules,
        signal: input.signal,
      })
      addWarnings("compose_draft", composedDraft.warnings)
      input.log?.(`[doc-agent] composed guideline draft: rules=${composedDraft.rules.length}; pending=${composedDraft.pendingReviewRules.length}; preservedRefs=${composedDraft.stats?.preservedExampleRefs ?? 0}; generatedExamples=${composedDraft.stats?.generatedExamples ?? 0}; guidance=${composedDraft.implementationGuidanceItems.length}; risks=${composedDraft.riskLimitItems.length}; references=${composedDraft.referenceOnlyItems.length}; model=${composedDraft.usedModel}; warnings=${composedDraft.warnings.length}`)
      emit({
        type: "compose-draft",
        title: "模型生成规则草案",
        detail: `${composedDraft.rules.length} 条正式规则 · 待复核 ${composedDraft.pendingReviewRules.length} 条 · 内部原文示例引用 ${composedDraft.stats?.preservedExampleRefs ?? 0} 个 · 外部/补充示例 ${composedDraft.stats?.generatedExamples ?? 0} 个 · 落地建议 ${composedDraft.implementationGuidanceItems.length} 项 · 风险限制 ${composedDraft.riskLimitItems.length} 项`,
        status: "completed",
        timelineKey: "compose-draft",
        stateLabel: composedDraft.usedModel ? "完成" : "使用回退草案",
        current: 6,
        total: DOCUMENT_STAGE_TOTAL,
      })

      emit({
        type: "review-draft",
        title: "模型审稿与语义自检",
        detail: `${composedDraft.rules.length} 条规则草案进入模型审稿`,
        status: "running",
        timelineKey: "review-draft",
        stateLabel: "审稿中",
        current: 7,
        total: DOCUMENT_STAGE_TOTAL,
      })
      const reviewedDraft = await new GuidelineDraftReviewAgent(input.model).review({
        question: input.question,
        plan,
        pack,
        rules: composedDraft.rules,
        signal: input.signal,
      })
      const pendingReviewRules = uniqueRuleCards([...composedDraft.pendingReviewRules, ...reviewedDraft.pendingReviewRules])
      addWarnings("review_draft", reviewedDraft.warnings)
      input.log?.(`[doc-agent] reviewed guideline draft: rules=${reviewedDraft.rules.length}; pending=${pendingReviewRules.length}; findings=${reviewedDraft.findings.length}; fixedCritical=${reviewedDraft.fixedCriticalCount}; warnings=${reviewedDraft.warnings.length}`)
      emit({
        type: reviewedDraft.fixedCriticalCount > 0 ? "revise-draft" : "review-draft",
        title: reviewedDraft.fixedCriticalCount > 0 ? "模型审稿修订完成" : "模型审稿完成",
        detail: `${reviewedDraft.rules.length} 条正式规则 · 修复 critical ${reviewedDraft.fixedCriticalCount} 条 · 待复核 ${pendingReviewRules.length} 条 · warning ${reviewedDraft.warnings.length} 条`,
        status: "completed",
        timelineKey: "review-draft",
        stateLabel: reviewedDraft.fixedCriticalCount > 0 ? "已修订" : "完成",
        current: 7,
        total: DOCUMENT_STAGE_TOTAL,
      })

      let mergedRules = reviewedDraft.rules.map((rule) => normalizeGeneratedExamplesForRule(normalizeRuleCardReadableText(rule)))
      const modelLedWarnings = [...composedDraft.warnings, ...reviewedDraft.warnings]
      if (!input.model || !composedDraft.usedModel) {
        const exampleIntents = await new CCodingGuidelineExampleIntentPlanner(input.model, {
          cache: createWorkspaceRuleExampleIntentCache(),
          modelName: input.model?.cacheKey?.() ?? "unknown-model",
        }).plan({
          question: input.question,
          plan,
          rules: mergedRules,
          signal: input.signal,
          log: input.log,
        })
        addWarnings("example_intent", exampleIntents.warnings)
        const repairedExamples = new CCodingGuidelineExamplePlanner(plan, { intents: exampleIntents.intents }).repairExamples(mergedRules)
        mergedRules = repairedExamples.rules.map((rule) => normalizeGeneratedExamplesForRule(normalizeRuleCardReadableText(rule)))
        modelLedWarnings.push(...exampleIntents.warnings, ...repairedExamples.warnings)
      }
      const mergedWarnings = [...merged.warnings, ...placed.warnings, ...sanitizedPlaced.warnings, ...modelLedWarnings]
      addWarnings("merge", mergedWarnings)
      const placedPack = removeAssignedSourceBlocks(pack, mergedRules, placed.assignedBlockIds)
      input.log?.(`[doc-agent] merged guideline rules: rules=${mergedRules.length}; pending=${pendingReviewRules.length}; warnings=${mergedWarnings.length}; placedSourceBlocks=${placed.assignedBlockIds.length}`)
      input.onProgress?.({ stage: "merging", message: "规则合并完成", current: 5, total: DOCUMENT_STAGE_TOTAL })
      emit({
        type: "merge",
        title: "合并内部规范与外部参考规则",
        detail: `${mergedRules.length} 条团队版规则 · 待复核 ${pendingReviewRules.length} 条 · 来源块归位 ${placed.assignedBlockIds.length} 个 · warning ${mergedWarnings.length} 条`,
        status: "completed",
        timelineKey: "merge",
        stateLabel: "完成",
        current: 5,
        total: DOCUMENT_STAGE_TOTAL,
      })
      const outline = addPendingReviewSection(addClassifiedModelSections(new DocumentOutlinePlanner().build({ pack: placedPack, rules: mergedRules, plan }), {
        implementationGuidanceItems: composedDraft.implementationGuidanceItems,
        riskLimitItems: composedDraft.riskLimitItems,
        referenceOnlyItems: composedDraft.referenceOnlyItems,
      }), pendingReviewRules)
      emit({ type: "word_spec", title: "生成 WordDocSpec", status: "running", timelineKey: "word_spec", stateLabel: "生成中", current: 8, total: DOCUMENT_STAGE_TOTAL })
      const spec = await new WordDocSpecGenerator(input.model).generate({
        question: input.question,
        plan,
        documents,
        pack: { ...placedPack, warnings: [...placedPack.warnings, ...mergedWarnings] },
        rules: mergedRules,
        sections: outline,
      }, input.signal)
      const normalizedSpec = normalizeGeneratedExamplesInSpec(spec)
      emit({ type: "word_spec", title: "生成 WordDocSpec", detail: `${spec.sections.length} 个正文章节`, status: "completed", timelineKey: "word_spec", stateLabel: "完成", current: 8, total: DOCUMENT_STAGE_TOTAL })
      const qualityIssues = new ReportQualityGate().check({
        documents,
        pack: { ...placedPack, warnings: [...placedPack.warnings, ...mergedWarnings] },
        rules: mergedRules,
        spec: normalizedSpec,
        plan,
      })
      const errors = qualityIssues.filter((issue) => issue.severity === "error")
      if (errors.length > 0) {
        input.log?.(`[doc-agent] quality gate failed: errors=${errors.length}; warnings=${qualityIssues.filter((issue) => issue.severity === "warning").length}`)
        addWarnings("quality_gate", qualityIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message))
        const errorText = errors.map((issue) => issue.message).join("\n")
        emit({ type: "final-structural-gate", title: "最终结构与安全质量检查", detail: `失败：${errors.length} 条 error · warning ${qualityIssues.filter((issue) => issue.severity === "warning").length} 条，详见 Output > ChipMate`, status: "error", timelineKey: "quality_gate", stateLabel: "失败", current: 9, total: DOCUMENT_STAGE_TOTAL })
        throw new Error(errorText)
      }
      const warnings = qualityIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message)
      addWarnings("quality_gate", warnings)
      input.log?.(`[doc-agent] report quality gate passed: warnings=${warnings.length}`)
      emit({ type: "final-structural-gate", title: "最终结构与安全质量检查", detail: `warning ${warnings.length} 条`, status: "completed", timelineKey: "quality_gate", stateLabel: "完成", current: 9, total: DOCUMENT_STAGE_TOTAL })
      input.onProgress?.({ stage: "rendering", message: "生成团队规范 Word 文档" })
      input.log?.("[doc-agent] rendering Word document")
      emit({ type: "create_word_document", title: "写入 Word 文档", status: "running", timelineKey: "create_word_document", stateLabel: "写入中", current: 10, total: DOCUMENT_STAGE_TOTAL })
      const created = await (input.createDocument ?? createWordDocument)({
        spec: normalizedSpec,
        filename: plan.output.filenameBase || normalizedSpec.metadata.title || "team-c-coding-guideline",
      })
      addWarnings("create_word_document", created.warnings)
      input.log?.(`[doc-agent] created Word document: ${created.path}; warnings=${created.warningCount}`)
      emit({ type: "create_word_document", title: "写入 Word 文档", detail: created.path, status: "completed", timelineKey: "create_word_document", stateLabel: "完成", current: 10, total: DOCUMENT_STAGE_TOTAL, path: created.path })
      input.onProgress?.({ stage: "done", message: `已生成：${created.path}` })
      const finalWarnings = uniqueWarnings([...runWarnings, ...warnings, ...created.warnings])
      emit({
        type: "done",
        title: "本地 Word 生成完成",
        detail: finalWarnings.length ? `${created.path}\n完成，发现 ${finalWarnings.length} 条 warning，详见 Output > ChipMate。` : created.path,
        status: "completed",
        timelineKey: "done",
        stateLabel: "完成",
        current: DOCUMENT_STAGE_TOTAL,
        total: DOCUMENT_STAGE_TOTAL,
        path: created.path,
      })
      return {
        ...created,
        title: normalizedSpec.metadata.title,
        warningCount: finalWarnings.length,
        warnings: finalWarnings,
        errors: [],
      }
    } catch (error) {
      if (!input.signal?.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        emit({
          type: "error",
          title: "本地 Word 生成失败",
          detail: runWarnings.size ? `${message}\n失败前记录 ${runWarnings.size} 条 warning，详见 Output > ChipMate。` : message,
          status: "error",
          timelineKey: "error",
          stateLabel: "失败",
        })
      }
      throw error
    }
  }
}

function chunkLabel(chunk: { sourcePath: string; headingPath: string[] }) {
  return `${chunk.sourcePath} / ${chunk.headingPath.join(" > ") || "未命名章节"}`
}

function addPendingReviewSection(sections: DocumentSection[], rules: RuleCardSpec[]) {
  if (rules.length === 0) return sections
  const pending: DocumentSection = {
    id: "pending-review-candidates",
    level: 1,
    title: "待人工复核候选项",
    paragraphs: [
      "以下内容来自模型审稿阶段：这些候选项未能可靠具体化为正式编码规则，未进入团队版规则正文，建议由团队结合来源资料人工复核后再决定是否纳入。",
    ],
    tables: [{
      headers: ["规则编号", "候选主题", "来源依据", "复核原因"],
      rows: rules.map((rule) => [
        rule.ruleId,
        rule.name,
        rule.sources.join("\n") || "缺少来源依据",
        rule.exampleWarnings?.join("\n") || "模型审稿未能给出可发布的正式规则表述。",
      ]),
    }],
  }
  const existing = sections.filter((section) => section.id !== pending.id)
  const insertAt = existing.findIndex((section) => section.id === "references")
  if (insertAt >= 0) {
    return [...existing.slice(0, insertAt), pending, ...existing.slice(insertAt)]
  }
  return [...existing, pending]
}

function addClassifiedModelSections(sections: DocumentSection[], items: {
  implementationGuidanceItems: ClassifiedGuidelineItem[]
  riskLimitItems: ClassifiedGuidelineItem[]
  referenceOnlyItems: ClassifiedGuidelineItem[]
}) {
  let next = sections
  next = appendItemsToSection(next, "static-analysis", "静态检查落地建议", items.implementationGuidanceItems)
  next = appendItemsToSection(next, "risks-limits", "风险与限制", items.riskLimitItems)
  next = appendItemsToSection(next, "references", "References", items.referenceOnlyItems)
  return next
}

function appendItemsToSection(sections: DocumentSection[], id: string, title: string, items: ClassifiedGuidelineItem[]) {
  if (items.length === 0) return sections
  const bullets = items.map((item) => `${item.title}：${item.text}${item.sourceRefs.length ? `（来源：${item.sourceRefs.join("；")}）` : ""}`)
  const existing = sections.find((section) => section.id === id)
  if (existing) {
    return sections.map((section) => section.id === id ? {
      ...section,
      bullets: [...(section.bullets ?? []), ...bullets],
    } : section)
  }
  const insertAt = sections.findIndex((section) => section.id === "references")
  const section: DocumentSection = { id, level: 1, title, bullets }
  if (insertAt >= 0 && id !== "references") return [...sections.slice(0, insertAt), section, ...sections.slice(insertAt)]
  return [...sections, section]
}

function normalizeGeneratedExamplesInSpec(spec: WordDocSpec): WordDocSpec {
  return {
    ...spec,
    sections: spec.sections.map((section) => ({
      ...section,
      ruleCards: section.ruleCards?.map(normalizeGeneratedExamplesForRule),
    })),
    appendices: spec.appendices?.map((section) => ({
      ...section,
      ruleCards: section.ruleCards?.map(normalizeGeneratedExamplesForRule),
    })),
  }
}

function uniqueRuleCards(rules: RuleCardSpec[]) {
  const seen = new Set<string>()
  const result: RuleCardSpec[] = []
  for (const rule of rules) {
    const key = `${rule.ruleId}:${rule.name}:${rule.sources.join("|")}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(rule)
  }
  return result
}

function mergeProgressSummary(progress: GuidelineMergeProgress) {
  if (progress.stage === "guidelines-start") return `模型合并团队规则卡 · ${progress.ruleCount ?? 0} 条候选规则`
  if (progress.stage === "guidelines-batch-start") return `模型分批合并 · 第 ${progress.batchIndex ?? 0}/${progress.totalBatches ?? 0} 批 · ${progress.ruleCount ?? 0} 条候选规则`
  if (progress.stage === "guidelines-batch-success") return `模型分批合并完成 · 第 ${progress.batchIndex ?? 0}/${progress.totalBatches ?? 0} 批 · ${progress.ruleCount ?? 0} 条规则卡`
  if (progress.stage === "guidelines-batch-warning") return `模型分批合并回退 · 第 ${progress.batchIndex ?? 0}/${progress.totalBatches ?? 0} 批 · 仅该批使用本地合并`
  if (progress.stage === "guidelines-success") return `模型合并完成 · ${progress.ruleCount ?? 0} 条团队规则卡`
  if (progress.stage === "normalize-start") return `规则语言与字段归一 · ${progress.ruleCount ?? 0} 条规则`
  if (progress.stage === "normalize-success") return `规则归一完成 · ${progress.ruleCount ?? 0} 条规则`
  if (progress.stage === "examples-start") return `挂载规则示例 · ${progress.ruleCount ?? 0} 条规则`
  if (progress.stage === "examples-success") return `规则示例挂载完成 · ${progress.ruleCount ?? 0} 条规则`
  return "模型合并切换本地回退，继续处理"
}

function sourceBlockPlacementProgressSummary(progress: SourceBlockPlacementProgress) {
  if (progress.stage === "skipped") return "来源块语义归位已跳过"
  if (progress.stage === "preplace") return `来源块预归位 · 直接归位 ${progress.placementCount ?? 0} 个 · 跳过 ${progress.skippedCount ?? 0} 个低价值块`
  if (progress.stage === "cache") return `来源块归位缓存 · 命中 ${progress.cacheHitCount ?? 0} 个 · 待模型判断 ${progress.blockCount ?? 0} 个`
  if (progress.stage === "complete") return `来源块语义归位完成 · 归入 ${progress.assignedCount ?? 0} 个来源块`
  const batch = progress.batchIndex && progress.totalBatches ? `第 ${progress.batchIndex}/${progress.totalBatches} 批` : "当前批"
  if (progress.stage === "batch-start") return `来源块语义归位 · ${batch} · ${progress.blockCount ?? 0} 个来源块`
  return `来源块语义归位完成 · ${batch} · ${progress.placementCount ?? 0} 条归位建议`
}

function uniqueWarnings(warnings: string[]) {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))]
}

function blockTextForContentKind(block: SourceBackedBlock) {
  return [
    block.title ?? "",
    block.text ?? "",
    block.items?.join("\n") ?? "",
    block.table ? [block.table.caption ?? "", block.table.headers.join(" | "), ...block.table.rows.map((row) => row.join(" | "))].join("\n") : "",
    block.codeBlock?.code ?? "",
    block.note ?? "",
  ].filter(Boolean).join("\n")
}

async function requestConflictDecisions(input: DocumentAgentInput, conflicts: ConflictRule[]): Promise<ConflictResolutionDecision[]> {
  input.onProgress?.({ stage: "merging", message: `等待处理 ${conflicts.length} 条规则冲突` })
  input.onTimeline?.({
    id: `doc-agent-conflict-wait-${Date.now()}`,
    timestamp: Date.now(),
    type: "conflict.review",
    title: "等待冲突处理选择",
    detail: `${conflicts.length} 条冲突需要确认`,
    status: "waiting",
    total: conflicts.length,
  })
  const resolver = input.resolveConflictDecisions
  const raw = resolver
    ? await abortable(resolver(conflicts, input.signal), input.signal)
    : conflicts.map((conflict) => ({ conflictId: conflict.id, choice: "review" as const, note: "未提供交互处理器，默认保留待评审。" }))
  return normalizeDecisions(conflicts, raw)
}

function conflictDecisionsFromPlan(plan: DocumentPlan, conflicts: ConflictRule[]): ConflictResolutionDecision[] | undefined {
  if (plan.conflictPolicy === "ask") return undefined
  const choice: ConflictResolutionChoice = plan.conflictPolicy === "prefer_internal"
    ? "internal"
    : plan.conflictPolicy === "prefer_external"
      ? "external"
      : "review"
  return normalizeDecisions(conflicts, conflicts.map((conflict) => ({
    conflictId: conflict.id,
    choice,
    note: conflictPolicyLabel(plan),
  })))
}

function conflictPolicyLabel(plan: DocumentPlan) {
  if (plan.conflictPolicy === "prefer_internal") return "按用户指令采用第一份/内部规范"
  if (plan.conflictPolicy === "prefer_external") return "按用户指令采用第二份/外部参考"
  if (plan.conflictPolicy === "keep_review") return "按用户指令保留为待评审冲突"
  return "按用户选择处理"
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError("Document agent operation aborted."))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError("Document agent operation aborted."))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function normalizeDecisions(conflicts: ConflictRule[], decisions: ConflictResolutionDecision[]) {
  const byId = new Map(decisions.map((decision) => [decision.conflictId, decision]))
  return conflicts.map((conflict) => {
    const decision = byId.get(conflict.id)
    return {
      conflictId: conflict.id,
      choice: normalizeChoice(decision?.choice),
      note: decision?.note,
    }
  })
}

function normalizeChoice(choice: ConflictResolutionChoice | undefined): ConflictResolutionChoice {
  if (choice === "internal" || choice === "external" || choice === "review") return choice
  return "review"
}

function applyConflictDecisions(pack: EvidencePack, decisions: ConflictResolutionDecision[]): EvidencePack {
  const byId = new Map(decisions.map((decision) => [decision.conflictId, decision]))
  const conflictRules = pack.conflictRules.map((conflict) => ({
    ...conflict,
    decision: byId.get(conflict.id) ?? conflict.decision,
  }))
  return {
    ...pack,
    conflictRules,
    conflictDecisions: decisions,
    warnings: [...pack.warnings, conflictDecisionWarning(decisions)],
  }
}

function removeAssignedSourceBlocks(pack: EvidencePack, rules: Array<{ sourceBackedBlocks?: SourceBackedBlock[]; preservedExamples?: SourceBackedBlock[]; sourceDerivedItems?: Array<{ sourceBlockIds: string[] }> }>, assignedBlockIds: string[]): EvidencePack {
  const assigned = new Set(assignedBlockIds)
  for (const rule of rules) {
    for (const block of rule.sourceBackedBlocks ?? []) {
      assigned.add(block.id)
      if (block.source.sourceBlockId) assigned.add(block.source.sourceBlockId)
    }
    for (const block of rule.preservedExamples ?? []) {
      assigned.add(block.id)
      if (block.source.sourceBlockId) assigned.add(block.source.sourceBlockId)
    }
    for (const item of rule.sourceDerivedItems ?? []) {
      for (const id of item.sourceBlockIds) assigned.add(id)
    }
  }
  return {
    ...pack,
    sourceBackedBlocks: pack.sourceBackedBlocks.filter((block) => !assigned.has(block.id) && !assigned.has(block.source.sourceBlockId ?? "")),
  }
}

function conflictDecisionWarning(decisions: ConflictResolutionDecision[]) {
  const internal = decisions.filter((item) => item.choice === "internal").length
  const external = decisions.filter((item) => item.choice === "external").length
  const review = decisions.filter((item) => item.choice === "review").length
  return `存在 ${decisions.length} 条冲突，已按用户选择处理：采用第一份 ${internal} 条，采用第二份 ${external} 条，保留待评审 ${review} 条。`
}

function conflictDecisionSummary(decisions: ConflictResolutionDecision[]) {
  const internal = decisions.filter((item) => item.choice === "internal").length
  const external = decisions.filter((item) => item.choice === "external").length
  const review = decisions.filter((item) => item.choice === "review").length
  return `采用第一份 ${internal} 条 · 采用第二份 ${external} 条 · 保留待评审 ${review} 条`
}

function abortError(message: string) {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function orderInputFiles(files: DocumentAgentInput["files"]) {
  return [...files].sort((left, right) => {
    const leftIndex = Number.isFinite(left.mentionIndex) ? left.mentionIndex! : Number.MAX_SAFE_INTEGER
    const rightIndex = Number.isFinite(right.mentionIndex) ? right.mentionIndex! : Number.MAX_SAFE_INTEGER
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return files.indexOf(left) - files.indexOf(right)
  })
}

function applySourceClassifications(documents: ReferenceDocument[], classifications: SourceOriginClassification[]) {
  const byId = new Map(classifications.map((item) => [item.sourceId, item]))
  return documents.map((document) => {
    const classification = byId.get(document.id)
    if (!classification) return document
    return {
      ...document,
      role: classification.role,
      sourceOrigin: classification.origin,
      sourceOriginConfidence: classification.confidence,
      sourceOriginReason: classification.reason,
      sourceOriginWarning: classification.warning,
      sourceOriginExplicit: classification.explicit,
    }
  })
}

function sourceRoleLabel(classification: SourceOriginClassification) {
  if (classification.origin === "internal_company") return "公司内部资料"
  if (classification.origin === "external_public") return "公开外部参考资料"
  if (classification.origin === "external_licensed") return "授权外部参考资料"
  return "来源类型未知"
}

function hasInternalSource(documents: ReferenceDocument[]) {
  return documents.some((doc) => doc.sourceOrigin === "internal_company")
}
