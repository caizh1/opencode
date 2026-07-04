import { beforeEach, describe, expect, mock, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import type { IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cGuidelineDocxFixture } from "./document-fixtures"
import type { GuidelineMergeProgress } from "../src/docAgent/GuidelineMerger"
import type { SourceBlockPlacementCache, SourceBlockPlacementCacheEntry } from "../src/docAgent/SourceBlockPlacementCache"
import type { CandidateRule, DocAgentModelProvider, DocAgentModelRequest, DocAgentTimelineEvent, EvidencePack, GeneratedExampleSpec, ReferenceChunk, RuleCardSpec, SourceBackedBlock, TableSpec, WordDocSpec } from "../src/docAgent/types"
import type { RemoteSettings } from "../src/types"

let workspaceFolders: Array<{ name: string; uri: UriShim }> = []

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }

  toString() {
    return `file://${this.fsPath}`
  }
}

mock.module("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: UriShim,
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    fs: {
      createDirectory: async (uri: UriShim) => mkdir(uri.fsPath, { recursive: true }),
      writeFile: async (uri: UriShim, data: Uint8Array) => writeFile(uri.fsPath, data),
      readFile: async (uri: UriShim) => readFile(uri.fsPath),
      stat: async (uri: UriShim) => {
        const item = await stat(uri.fsPath)
        return { type: item.isDirectory() ? 2 : 1, size: item.size }
      },
    },
  },
}))

const { readDocx } = await import("../src/tools/readDocxTool")
const { ReferenceDocExtractor } = await import("../src/docAgent/ReferenceDocExtractor")
const { GuidelineRuleExtractor, batchExtractionPromptForTest, singleChunkExtractionPromptForTest } = await import("../src/docAgent/GuidelineRuleExtractor")
const { GuidelineMerger } = await import("../src/docAgent/GuidelineMerger")
const { WordDocSpecGenerator } = await import("../src/docAgent/WordDocSpecGenerator")
const { EvidencePackBuilder } = await import("../src/docAgent/EvidencePackBuilder")
const { DocumentOutlinePlanner } = await import("../src/docAgent/DocumentOutlinePlanner")
const { DocumentPlanGenerator, normalizeDocumentPlan, normalizeRuleCardForPlan } = await import("../src/docAgent/DocumentPlanGenerator")
const { applyRuleOrganizationPlanToSections, applyRuleOrganizationPlanToSpec } = await import("../src/docAgent/RuleOrganization")
const { SourcePreservationExtractor } = await import("../src/docAgent/SourcePreservationExtractor")
const { CCodingGuidelinePreservationPolicy, CCodingGuidelineSourceClassifier } = await import("../src/docAgent/CCodingGuidelineSourceClassifier")
const { CCodingGuidelineExampleIntentPlanner } = await import("../src/docAgent/CCodingGuidelineExampleIntentPlanner")
const { CCodingGuidelineExamplePlanner } = await import("../src/docAgent/CCodingGuidelineExamplePlanner")
const { exampleForSemanticKind, inferSemanticKindFromText } = await import("../src/docAgent/CCodingGuidelineSemanticRegistry")
const { CandidateRuleQualityGate, collectCGuidelineRuleQualityIssues, validateCCodingGuidelineSourcePlacement } = await import("../src/docAgent/CCodingGuidelineQuality")
const { GuidelineReferencePackFlow } = await import("../src/docAgent/DocumentAgentFlow")
const { DocxRenderQualityGate } = await import("../src/docAgent/DocxRenderQualityGate")
const { WordDocBuilder } = await import("../src/docAgent/WordDocBuilder")
const { WordDocSpecValidator } = await import("../src/docAgent/WordDocSpecValidator")
const { defaultWordThemeForSpec, resolveWordDesignPreset, resolveWordHeaderPattern, resolveWordPresetTokenMap } = await import("../src/docAgent/themes/WordDesignPresets")
const { ReportQualityGate } = await import("../src/docAgent/ReportQualityGate")
const { ChipMateDocModelProvider, DOCUMENT_MODEL_COMPAT_MAX_TOKENS } = await import("../src/docAgent/ChipMateDocModelProvider")
const { RuleChunkFilter } = await import("../src/docAgent/RuleChunkFilter")
const { WorkspaceRuleExtractionCache } = await import("../src/docAgent/RuleExtractionCache")
const { SourceBlockPlacementPlanner } = await import("../src/docAgent/SourceBlockPlacementPlanner")
const { SOURCE_BLOCK_PLACEMENT_VERSION } = await import("../src/docAgent/SourceBlockPlacementCache")
const { createWordDocument } = await import("../src/tools/createWordDocumentTool")
const { DocumentEditPlanner, normalizeDocumentEditPlanWithDiagnostics, validateDocumentEditPlan } = await import("../src/docAgent/DocumentEditPlan")
const { WordDocumentEditor } = await import("../src/docAgent/WordDocumentEditor")
const { auditWordDocumentFields, flattenRefFieldsInDocxBytes, materializeSeqFieldsInDocxBytes, prepareNativeFieldRefreshInDocxBytes, WordNativeFieldRefresher, WordRefFieldFlattener, WordSeqFieldMaterializer } = await import("../src/docAgent/WordDocumentFields")
const { WordDocumentInspector } = await import("../src/docAgent/WordDocumentInspector")
const { isWordEditIntent, WordEditAgentFlow } = await import("../src/docAgent/WordEditAgentFlow")
const { renderWordDocument } = await import("../src/docAgent/WordRenderQualityGate")
const { compareWordDocuments } = await import("../src/docAgent/WordDocumentDiff")
const { WordDocumentMerger, mergeDocxBytes } = await import("../src/docAgent/WordDocumentMerger")
const { auditWordDocumentStyles, normalizeWordDocumentStyleBytes, WordDocumentStyleNormalizer } = await import("../src/docAgent/WordDocumentStyleTools")
const { applyTemplateStylesToDocxBytes, WordTemplateStyleApplier } = await import("../src/docAgent/WordTemplateStyleApplier")

beforeEach(() => {
  workspaceFolders = []
})

function groupedTimelineEvents(events: DocAgentTimelineEvent[]) {
  const byKey = new Map<string, DocAgentTimelineEvent>()
  for (const event of events) {
    if (event.timelineKey) byKey.set(event.timelineKey, event)
  }
  return byKey
}

describe("doc agent intent and extraction", () => {
  test("does not route document generation through the legacy guideline reference-pack flow", () => {
    const generationRequests = [
      { text: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。", docxCount: 1 },
      { text: "请综合这些资料，生成团队 C 语言编码规范 Word。", docxCount: 2 },
      { text: "请生成团队研发流程规范文档，包含表格和目录。", docxCount: 3 },
      { text: "请把这些材料整理成客户汇报版 docx。", docxCount: 3 },
    ]

    for (const request of generationRequests) {
      expect(isWordEditIntent(request)).toBe(false)
    }
  })

  test("does not treat one-source generic Word generation as an edit of the source document", () => {
    expect(isWordEditIntent({
      text: "根据这份资料生成一份客户汇报 Word。",
      docxCount: 1,
    })).toBe(false)
    expect(isWordEditIntent({
      text: "请整理成一份项目方案文档。",
      docxCount: 1,
    })).toBe(false)
    expect(isWordEditIntent({
      text: "请完善为一份正式设计文档。",
      docxCount: 1,
    })).toBe(false)

    expect(isWordEditIntent({
      text: "请新增一个审稿说明章节，生成汇报版 Word。",
      docxCount: 1,
    })).toBe(true)
    expect(isWordEditIntent({
      text: "请更新目录页码并修复表格标题。",
      docxCount: 1,
    })).toBe(true)
    expect(isWordEditIntent({
      text: "请把这份材料润色成正式 Word 文档。",
      docxCount: 1,
    })).toBe(true)
  })

  test("read_docx returns semantic structure without style inheritance promises", async () => {
    const bytes = cGuidelineDocxFixture({
      title: "公司内部 C 编码规范",
      sections: [{
        heading: "命名规范",
        paragraphs: ["必须使用清晰的模块前缀命名全局函数。"],
        bullets: ["禁止使用含糊的单字母全局变量名。"],
      }],
      tableRows: [["C-NAME-001", "函数命名必须体现模块边界。"]],
    })

    const result = await readDocx({ path: "docs/company-c-guideline.docx", bytes })

    expect(result.metadata.title).toContain("公司内部 C 编码规范")
    expect(result.blocks.some((block) => block.kind === "heading")).toBe(true)
    expect(result.blocks.some((block) => block.kind === "table")).toBe(true)
    expect(result.blocks.every((block) => block.sourceLocation.path === "docs/company-c-guideline.docx")).toBe(true)
  })

  test("extracts candidate rules by section chunk with a fake model provider", async () => {
    const read = await readDocx({
      path: "docs/company-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "公司内部 C 编码规范",
        sections: [
          { heading: "指针与内存", paragraphs: ["必须检查指针参数是否为空。"] },
          { heading: "错误处理", paragraphs: ["应该统一使用负错误码表示失败。"] },
        ],
      }),
    })
    const extractor = new ReferenceDocExtractor()
    const docs = extractor.classifyDocuments([{ id: "src-1", read }])
    const chunks = docs.flatMap((doc) => extractor.chunks(doc))

    const result = await new GuidelineRuleExtractor(new FakeModelProvider()).extract(chunks)

    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(result.rules.length).toBeGreaterThan(0)
    expect(result.rules[0]?.sourceDocument).toBe("docs/company-c-guideline.docx")
  })

  test("splits numbered storage consistency rules into rule-local chunks with anchors", async () => {
    const read = await readDocx({
      path: "docs/company-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "IPD-R-10003355 C&C++编码规范V1.3",
        sections: [{ heading: "4.18 存储访问一致性", paragraphs: storageConsistencyParagraphs() }],
      }),
    })
    const extractor = new ReferenceDocExtractor()
    const docs = extractor.classifyDocuments([{ id: "src-1", read, sourceOrigin: "internal_company" }])
    const chunks = docs.flatMap((doc) => extractor.chunks(doc))

    expect(chunks.map((chunk) => chunk.sourceRuleAnchor).filter(Boolean)).toEqual(["建议18-1.1", "规则18-1.2", "规则18-1.3", "规则18-1.4"])

    const extracted = await new GuidelineRuleExtractor().extract(chunks)
    const syncRule = extracted.rules.find((rule) => rule.sourceRuleAnchor === "规则18-1.2")

    expect(syncRule?.description).toContain("写者传递信息给读者前，需要做存储同步")
    expect(syncRule?.sourceSection).toContain("规则18-1.2")
  })

  test("reports progress for each model-backed chunk extraction", async () => {
    const chunks = referenceChunks(26)
    const progress: string[] = []

    const result = await new GuidelineRuleExtractor(new FakeModelProvider()).extract(chunks, {
      onProgress: (item) => {
        if (item.stage === "start") progress.push(item.message)
      },
    })

    expect(result.rules.length).toBe(26)
    expect(progress).toHaveLength(26)
    expect(progress[0]).toContain("提取候选规则：1/26")
    expect(progress[25]).toContain("提取候选规则：26/26")
  })

  test("rule extraction prompts require Simplified Chinese rule fields", () => {
    const chunk = referenceChunks(1)[0]!

    expect(singleChunkExtractionPromptForTest(chunk)).toContain("Simplified Chinese")
    expect(singleChunkExtractionPromptForTest(chunk)).toContain("translate the rule meaning into Chinese")
    expect(batchExtractionPromptForTest([chunk])).toContain("Simplified Chinese")
    expect(batchExtractionPromptForTest([chunk])).toContain("instead of returning English rule text")
  })

  test("retries chunks individually when a model batch fails", async () => {
    const chunks = referenceChunks(3)

    const result = await new GuidelineRuleExtractor(new FailingChunkModelProvider(1)).extract(chunks)

    expect(result.rules.length).toBe(3)
    expect(result.warnings.some((warning) => warning.includes("批量规则提取失败"))).toBe(false)
    expect(result.rules.some((rule) => rule.id.includes("heuristic"))).toBe(false)
  })

  test("falls back only after batch and single chunk extraction both fail", async () => {
    const result = await new GuidelineRuleExtractor(new BatchAndSingleFailModelProvider("章节 2")).extract(referenceChunks(3), {
      batchSize: 3,
      concurrency: 1,
    })

    expect(result.rules).toHaveLength(3)
    expect(result.rules.filter((rule) => rule.id.includes("heuristic"))).toHaveLength(1)
    expect(result.rules.some((rule) => rule.id.includes("chunk-2-heuristic"))).toBe(true)
    expect(result.warnings.filter((warning) => warning.startsWith("批量规则提取失败"))).toHaveLength(0)
    expect(result.warnings.some((warning) => warning.includes("批量失败后单 chunk 重试仍失败"))).toBe(true)
  })

  test("does not warn when low-value sections produce no extracted rules", async () => {
    const chunks = [
      { ...referenceChunks(1)[0]!, id: "toc", headingPath: ["目录"], text: "目的 范围 规则 参考资料" },
      { ...referenceChunks(1)[0]!, id: "risk", headingPath: ["10. 风险、限制与后续完善"], text: "本文仍需根据团队实践持续完善。" },
      { ...referenceChunks(1)[0]!, id: "appendix", headingPath: ["附录 A. 规则分类速查表"], text: "分类 规则编号 适用范围" },
    ]
    const result = await new GuidelineRuleExtractor(new EmptyRuleModelProvider()).extract(chunks, {
      batchSize: 3,
      concurrency: 1,
    })

    expect(result.rules).toHaveLength(0)
    expect(result.warnings.some((warning) => warning.includes("未从"))).toBe(false)
  })

  test("filters low-value chunks before model extraction without affecting source preservation", () => {
    const chunks = [
      { ...referenceChunks(1)[0]!, id: "toc", headingPath: ["目录"], text: "一、目的 ........ 1\n二、范围 ........ 2\n三、规则 ........ 3" },
      { ...referenceChunks(1)[0]!, id: "revision", headingPath: ["修订记录"], text: "版本 作者 日期\n0.1 team 2026" },
      { ...referenceChunks(1)[0]!, id: "rule", headingPath: ["命名规范"], text: "必须使用模块前缀命名全局函数。" },
    ]

    const result = new RuleChunkFilter().filter(chunks)

    expect(result.modelChunks.map((chunk) => chunk.id)).toEqual(["rule"])
    expect(result.skippedChunks).toHaveLength(2)
    expect(Object.keys(result.skipReasons).length).toBeGreaterThan(0)
  })

  test("extracts 26 chunks in batches with bounded concurrency", async () => {
    const model = new CountingBatchModelProvider()
    const stages: string[] = []

    const result = await new GuidelineRuleExtractor(model).extract(referenceChunks(26), {
      batchSize: 4,
      concurrency: 2,
      onProgress: (item) => {
        if (item.stage === "start" || item.stage === "success") stages.push(item.stage)
      },
    })

    expect(result.rules.length).toBe(26)
    expect(model.batchCalls).toBeLessThanOrEqual(7)
    expect(model.maxInFlight).toBeLessThanOrEqual(2)
    expect(stages.filter((stage) => stage === "start")).toHaveLength(26)
    expect(stages.filter((stage) => stage === "success")).toHaveLength(26)
  })

  test("retries only missing chunk results in a model batch", async () => {
    const result = await new GuidelineRuleExtractor(new PartialBatchModelProvider("chunk-2")).extract(referenceChunks(3), {
      batchSize: 3,
      concurrency: 1,
    })

    expect(result.rules).toHaveLength(3)
    expect(result.rules.some((rule) => rule.id.includes("chunk-2-heuristic"))).toBe(false)
    expect(result.warnings.some((warning) => warning.includes("缺少 chunk 结果"))).toBe(false)
  })

  test("caches rule extraction results by chunk content and model name", async () => {
    const root = await tempDir("chipmate-rule-cache-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const cache = new WorkspaceRuleExtractionCache(root)
    const model = new CountingBatchModelProvider()

    const first = await new GuidelineRuleExtractor(model).extract(referenceChunks(2), {
      cache,
      modelName: "doc-model-a",
      batchSize: 2,
    })
    const second = await new GuidelineRuleExtractor(model).extract(referenceChunks(2), {
      cache,
      modelName: "doc-model-a",
      batchSize: 2,
    })
    const third = await new GuidelineRuleExtractor(model).extract([{ ...referenceChunks(1)[0]!, text: "必须检查修改后的接口返回值。" }], {
      cache,
      modelName: "doc-model-a",
      batchSize: 2,
    })

    expect(first.rules).toHaveLength(2)
    expect(second.rules).toHaveLength(2)
    expect(third.rules).toHaveLength(1)
    expect(model.batchCalls).toBe(2)
  })

  test("continues when the rule extraction cache file is corrupted", async () => {
    const root = await tempDir("chipmate-rule-cache-corrupt-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    await mkdir(join(root, ".chipmate", "cache"), { recursive: true })
    await writeFile(join(root, ".chipmate", "cache", "doc-agent-rule-extraction.json"), "{not-json")
    const model = new CountingBatchModelProvider()

    const result = await new GuidelineRuleExtractor(model).extract(referenceChunks(1), {
      cache: new WorkspaceRuleExtractionCache(root),
      modelName: "doc-model-a",
    })

    expect(result.rules).toHaveLength(1)
    expect(result.warnings.some((warning) => warning.includes("缓存不可用"))).toBe(true)
    expect(model.batchCalls).toBe(1)
  })

  test("falls back on model timeout errors but stops on user abort", async () => {
    const timedOut = await new GuidelineRuleExtractor(new TimeoutModelProvider()).extract(referenceChunks(1))
    expect(timedOut.rules).toHaveLength(1)
    expect(timedOut.rules[0]?.id).toContain("heuristic")
    expect(timedOut.warnings[0]).toContain("timed out")

    const controller = new AbortController()
    await expect(new GuidelineRuleExtractor(new AbortModelProvider(controller)).extract(referenceChunks(1), controller.signal)).rejects.toThrow()
  })

  test("classifies source origin inside the C recipe instead of ReferenceDocExtractor", async () => {
    const reads = [
      await readDocx({
        path: "docs/team-rules.docx",
        bytes: cGuidelineDocxFixture({ title: "团队规范", sections: [{ heading: "规则", paragraphs: ["必须检查返回值。"] }] }),
      }),
      await readDocx({
        path: "docs/MISRA-reference.docx",
        bytes: cGuidelineDocxFixture({ title: "MISRA 授权资料", sections: [{ heading: "规则", paragraphs: ["应该避免未定义行为。"] }] }),
      }),
      await readDocx({
        path: "docs/unknown.docx",
        bytes: cGuidelineDocxFixture({ title: "资料", sections: [{ heading: "规则", paragraphs: ["建议统一风格。"] }] }),
      }),
    ]
    const baseDocs = new ReferenceDocExtractor().classifyDocuments(reads.map((read, index) => ({ id: `src-${index + 1}`, read, mentionIndex: index })))

    const explicit = new CCodingGuidelineSourceClassifier().classify({
      question: "第一份是公司内部规范，第二份是外部授权资料。",
      documents: baseDocs,
    })
    const inferred = new CCodingGuidelineSourceClassifier().classify({ question: "请生成 C 规范。", documents: baseDocs })

    expect(baseDocs.every((doc) => doc.sourceOrigin === "unknown")).toBe(true)
    expect(explicit[0]?.origin).toBe("internal_company")
    expect(explicit[1]?.origin).toBe("external_licensed")
    expect(explicit[0]?.explicit).toBe(true)
    expect(inferred[0]?.origin).toBe("internal_company")
    expect(inferred[1]?.origin).toBe("external_licensed")
    expect(inferred[2]?.origin).toBe("unknown")
    expect(inferred.some((item) => item.warning)).toBe(true)
  })

  test("uses model-planned source roles for natural document order wording and validates fallbacks", async () => {
    const reads = [
      await readDocx({
        path: "docs/MISRA-looking-name.docx",
        bytes: cGuidelineDocxFixture({ title: "普通文件名", sections: [{ heading: "规则", paragraphs: ["必须检查返回值。"] }] }),
      }),
      await readDocx({
        path: "docs/reference.docx",
        bytes: cGuidelineDocxFixture({ title: "参考资料", sections: [{ heading: "规则", paragraphs: ["应该避免未定义行为。"] }] }),
      }),
    ]
    const baseDocs = new ReferenceDocExtractor().classifyDocuments(reads.map((read, index) => ({ id: `src-${index + 1}`, read, mentionIndex: index })))
    const classifier = new CCodingGuidelineSourceClassifier()
    const naturalFallback = classifier.classify({
      question: "第一个文档是公司内文档，第二个文档是外部通用文档，请综合生成 Word。",
      documents: baseDocs,
    })

    const planned = await classifier.classifyWithModel({
      question: "请按我给出的文档角色综合生成 Word。",
      documents: baseDocs,
      model: new SourceRoleModelProvider([
        { sourceId: "src-1", sourceOrigin: "internal_company", role: "internal", confidence: 0.96, explicit: true, reason: "用户说明第一个文档是公司内文档。" },
        { sourceId: "src-2", sourceOrigin: "external_public", role: "external", confidence: 0.94, explicit: true, reason: "用户说明第二个文档是外部通用文档。" },
      ]),
    })
    const invalid = await classifier.classifyWithModel({
      question: "请综合生成 Word。",
      documents: baseDocs,
      model: new SourceRoleModelProvider([
        { sourceId: "src-1", sourceOrigin: "bad-origin", role: "internal", confidence: 0.99, explicit: true, reason: "非法来源类型。" },
      ]),
    })

    expect(naturalFallback[0]?.origin).toBe("internal_company")
    expect(naturalFallback[1]?.origin).toBe("external_public")
    expect(planned[0]?.origin).toBe("internal_company")
    expect(planned[0]?.explicit).toBe(true)
    expect(planned[0]?.warning).toContain("已按用户显式说明处理")
    expect(planned[1]?.origin).toBe("external_public")
    expect(invalid[0]?.origin).toBe("external_licensed")
  })

  test("builds a document plan from explicit user instructions", async () => {
    const plan = await new DocumentPlanGenerator().generate({
      question: "请综合这些资料生成 Word。文档标题用 XXX团队C语言编码规范。如果遇到冲突直接采用团队内部文档。请给每条规则写一个最小示例，并在不推荐示例中给出不推荐原因，把规则名称和适用范围写得更易懂。加入落地路线图章节。",
      recipeId: "c-coding-guideline",
      documents: [],
    })

    expect(plan.output.title).toBe("XXX团队C语言编码规范")
    expect(plan.output.filenameBase).toContain("XXX团队C语言编码规范")
    expect(plan.conflictPolicy).toBe("prefer_internal")
    expect(plan.ruleCardPolicy?.requireMinimalExamplePerRule).toBe(true)
    expect(plan.ruleCardPolicy?.includeBadExampleReason).toBe(true)
    expect(plan.ruleCardPolicy?.rewriteNamesForReadability).toBe(true)
    expect(plan.ruleCardPolicy?.rewriteScopesForReadability).toBe(true)
    expect(plan.sectionPlan.some((section) => section.title.includes("落地路线图"))).toBe(true)

    const defaultPlan = await new DocumentPlanGenerator().generate({
      question: "请综合这些资料生成 Word。请给每条规则写一个最小示例。",
      recipeId: "c-coding-guideline",
      documents: [],
    })
    expect(defaultPlan.ruleCardPolicy?.includeBadExampleReason).toBe(false)
  })

  test("uses model-planned rule organization policies from the user prompt", async () => {
    const plan = await new DocumentPlanGenerator(new DocumentPlanModelProvider({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "split-by-source-role",
      externalRulePlacement: "main-body",
    })).generate({
      question: "把公司内部规则放最上面，行业通用规范放下面。",
      recipeId: "c-coding-guideline",
      documents: [],
    })

    expect(plan.ruleOrderingPolicy).toBe("internal-first")
    expect(plan.ruleSectioningPolicy).toBe("split-by-source-role")
    expect(plan.externalRulePlacement).toBe("main-body")
  })

  test("plans external rules into appendices and normalizes invalid organization enums", async () => {
    const appendixPlan = await new DocumentPlanGenerator(new DocumentPlanModelProvider({
      externalRulePlacement: "appendix",
      ruleOrderingPolicy: "external-first",
    })).generate({
      question: "外部建议放附录，正文先保留公司内部规则。",
      recipeId: "c-coding-guideline",
      documents: [],
    })
    const invalidPlan = normalizeDocumentPlan({
      ruleOrderingPolicy: "frontish" as never,
      ruleSectioningPolicy: "split-by-color" as never,
      externalRulePlacement: "side-note" as never,
    })

    expect(appendixPlan.externalRulePlacement).toBe("appendix")
    expect(appendixPlan.ruleOrderingPolicy).toBe("external-first")
    expect(invalidPlan.ruleOrderingPolicy).toBe("internal-first")
    expect(invalidPlan.ruleSectioningPolicy).toBe("single-section")
    expect(invalidPlan.externalRulePlacement).toBe("main-body")
    expect(invalidPlan.warnings.join("\n")).toContain("不合法")
  })

  test("falls back deterministically for common internal-first wording when no planner model is available", async () => {
    const plan = await new DocumentPlanGenerator().generate({
      question: "请把公司内部规则放最上面，行业通用规范放下面。",
      recipeId: "c-coding-guideline",
      documents: [],
    })

    expect(plan.ruleOrderingPolicy).toBe("internal-first")
    expect(plan.ruleSectioningPolicy).toBe("split-by-source-role")
    expect(plan.externalRulePlacement).toBe("main-body")
  })

  test("extracts generic source-backed blocks using the recipe preservation policy", async () => {
    const internalRead = await readDocx({
      path: "docs/company-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "公司内部 C 编码规范",
        sections: [{
          heading: "指针与内存安全",
          paragraphs: [
            "必须检查指针参数是否为空。",
            "示例：if (ptr == NULL) return -EINVAL; 推荐在入口处快速失败。",
          ],
          bullets: ["Code Review 必须确认错误路径释放资源。"],
        }],
        tableRows: [["C-PTR-001", "指针参数必须先检查再使用。"]],
      }),
    })
    const externalRead = await readDocx({
      path: "docs/external-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "外部 C 编码规范参考资料",
        sections: [{
          heading: "示例与风险",
          paragraphs: ["示例：外部资料建议使用防御式检查说明风险，团队文档应结合项目语境改写。"],
        }],
      }),
    })
    const baseDocuments = new ReferenceDocExtractor().classifyDocuments([{ id: "src-1", read: internalRead, mentionIndex: 0 }, { id: "src-2", read: externalRead, mentionIndex: 1 }])
    const classifications = new CCodingGuidelineSourceClassifier().classify({
      question: "第一份是公司内部规范，第二份是外部参考规范。",
      documents: baseDocuments,
    })
    const byId = new Map(classifications.map((item) => [item.sourceId, item]))
    const documents = new ReferenceDocExtractor().classifyDocuments(baseDocuments.map((doc) => {
      const item = byId.get(doc.id)!
      return { ...doc, role: item.role, sourceOrigin: item.origin }
    }))

    const result = new SourcePreservationExtractor(new CCodingGuidelinePreservationPolicy()).extract(documents)

    expect(result.sourceBackedBlocks.some((block) => block.kind === "table")).toBe(true)
    expect(result.sourceBackedBlocks.some((block) => block.kind === "list" || block.kind === "paragraph")).toBe(true)
    expect(result.sourceBackedBlocks.some((block) => block.kind === "example")).toBe(true)
    expect(result.sourceBackedBlocks.every((block) => block.source.sourceLocation.path.endsWith(".docx"))).toBe(true)
    expect(result.sourceBackedBlocks.filter((block) => block.source.sourceOrigin !== "internal_company").every((block) => block.preserveMode !== "verbatim-short")).toBe(true)
    expect(result.sourceBackedBlocks.every((block) => block.source.originalBlockHash.rawHash && block.source.originalBlockHash.normalizedHash)).toBe(true)
  })

  test("selects source-backed blocks across the full document instead of the first 32 candidates", async () => {
    const sections = Array.from({ length: 80 }, (_, index) => ({
      heading: `规则章节 ${index + 1}`,
      paragraphs: [`示例：uint32_t marker_${index + 1} = ${index + 1}U; 必须保留可追溯的规则示例。`],
    }))
    const read = await readDocx({
      path: "docs/company-large-c-guideline.docx",
      bytes: cGuidelineDocxFixture({ title: "公司内部大型规范", sections }),
    })
    const result = new SourcePreservationExtractor(new CCodingGuidelinePreservationPolicy()).extract([{
      id: "src-1",
      role: "internal",
      sourceOrigin: "internal_company",
      read,
    }])
    const sourceText = result.sourceBackedBlocks.map(sourceBlockTextForTest).join("\n")
    expect(read.blocks.length).toBeGreaterThan(32)
    expect(result.sourceBackedBlocks.length).toBe(32)
    expect(sourceText).toContain("marker_1")
    expect(sourceText).toContain("marker_42")
    expect(sourceText).toContain("marker_80")
    expect(result.warnings.join("\n")).toContain("可搬运来源块候选")
    expect(result.warnings.join("\n")).toContain("不影响规则抽取")
  })

  test("limits verbatim-short preserved blocks for long internal excerpts", () => {
    const longText = `${"必须保留短摘录。".repeat(80)}结束。`
    const result = new SourcePreservationExtractor(new CCodingGuidelinePreservationPolicy()).extract([{
      id: "src-1",
      role: "internal",
      sourceOrigin: "internal_company",
      read: {
        metadata: { path: "docs/company-c-guideline.docx", title: "公司内部规范", byteSize: 1000, truncated: false, readWarnings: [] },
        blocks: [{
          id: "b1",
          kind: "paragraph",
          text: longText,
          headingPath: ["关键原文"],
          sourceLocation: { path: "docs/company-c-guideline.docx", headingPath: ["关键原文"] },
        }],
        textPreview: longText,
      },
    }])
    const block = result.sourceBackedBlocks[0]
    expect(block?.preserveMode).toBe("verbatim-short")
    expect(block?.text?.length).toBeLessThan(longText.length)
    expect(result.warnings.some((warning) => warning.includes("短摘录超过"))).toBe(true)
  })

  test("SourcePreservationExtractor follows policy decisions and keeps normalized hashes stable", () => {
    const doc = (text: string) => ({
      id: "src-1",
      role: "unknown" as const,
      sourceOrigin: "unknown" as const,
      read: {
        metadata: { path: "docs/source.docx", title: "Source", byteSize: 1000, truncated: false, readWarnings: [] },
        blocks: [{
          id: "b1",
          kind: "paragraph" as const,
          text,
          headingPath: ["Rules"],
          sourceLocation: { path: "docs/source.docx", headingPath: ["Rules"] },
        }],
        textPreview: text,
      },
    })
    const policy = {
      decide: () => ({ preserveMode: "verbatim-short" as const, charLimit: 80, wordLimit: 20, allowVerbatim: true, note: "fake policy" }),
    }

    const first = new SourcePreservationExtractor(policy).extract([doc("必须检查返回值。\n\n应该记录错误。")]).sourceBackedBlocks[0]!
    const second = new SourcePreservationExtractor(policy).extract([doc("必须检查返回值。   应该记录错误。")]).sourceBackedBlocks[0]!

    expect(first.preserveMode).toBe("verbatim-short")
    expect(first.note).toContain("短摘录保留")
    expect(first.source.originalBlockHash.rawHash).not.toBe(second.source.originalBlockHash.rawHash)
    expect(first.source.originalBlockHash.normalizedHash).toBe(second.source.originalBlockHash.normalizedHash)
  })

  test("keeps Phase 2A boundaries out of generic extractor, builder, and agent flow", async () => {
    const referenceExtractor = await readFile(join(process.cwd(), "src/docAgent/ReferenceDocExtractor.ts"), "utf8")
    const wordBuilder = await readFile(join(process.cwd(), "src/docAgent/WordDocBuilder.ts"), "utf8")
    const docAgentFiles = await readFile(join(process.cwd(), "src/docAgent/DocumentAgentFlow.ts"), "utf8")
    const chatHtml = await readFile(join(process.cwd(), "src/chat-html.ts"), "utf8")
    const chatView = await readFile(join(process.cwd(), "src/chat-view.ts"), "utf8")

    expect(referenceExtractor).not.toMatch(/MISRA|CERT|Barr|Linux|GNU|NASA|JPL|coding guideline|embedded C/i)
    expect(wordBuilder).not.toMatch(/MISRA|CERT|Barr|Linux|GNU|NASA|JPL|coding guideline|embedded C/i)
    expect(docAgentFiles).not.toMatch(/GenericDocumentAgentFlow|DocumentTaskPlanner|SourceAcquisitionRunner|GenericEvidencePackBuilder/)
    expect(chatHtml).toContain("mentionIndex")
    expect(chatView).toContain("mentionIndex")
  })
})

describe("word edit agent", () => {
  test("inspect_word_document exposes real locators and rejects invented locators", async () => {
    const bytes = cGuidelineDocxFixture({
      title: "可编辑 Word",
      sections: [{ heading: "第一章", paragraphs: ["这是第一段。"] }],
      tableRows: [["状态", "旧值"]],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/edit.docx", bytes })
    expect(inspection.paragraphs.length).toBeGreaterThan(0)
    expect(inspection.tables.length).toBe(1)

    const valid = validateDocumentEditPlan({
      planId: "valid",
      targetPath: "docs/edit.docx",
      operations: [{ type: "replaceParagraph", locator: inspection.paragraphs[0]!.locator, text: "新标题" }],
      warnings: [],
    }, inspection)
    expect(valid.ok).toBe(true)

    const invalid = validateDocumentEditPlan({
      planId: "invalid",
      targetPath: "docs/edit.docx",
      operations: [{ type: "replaceParagraph", locator: { kind: "paragraph", blockId: "p-made-up" }, text: "不应执行" }],
      warnings: [],
    }, inspection)
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join("\n")).toContain("locator")
  })

  test("normalizeDocumentEditPlanWithDiagnostics reports dropped malformed operations safely", () => {
    const secretText = "SECRET_EDIT_TEXT_SHOULD_NOT_LEAK"
    const missingType = normalizeDocumentEditPlanWithDiagnostics({
      operations: [{ action: "replaceText", locator: { kind: "paragraph", blockId: "p1" }, oldText: secretText, newText: "safe" } as never],
    }, "docs/edit.docx")
    expect(missingType.plan.operations).toHaveLength(0)
    expect(missingType.diagnostics.rawOperationCount).toBe(1)
    expect(missingType.diagnostics.normalizedOperationCount).toBe(0)
    expect(missingType.diagnostics.droppedOperationCount).toBe(1)
    expect(missingType.diagnostics.errors.join("\n")).toContain("operations[0].type is required")
    expect(missingType.diagnostics.errors.join("\n")).toContain("keys=action,locator,newText,oldText")
    expect(JSON.stringify(missingType.diagnostics)).not.toContain(secretText)
    expect(missingType.diagnostics.operationDiagnostics[0]?.textFieldBytes.oldText).toBeGreaterThan(0)

    const unsupported = normalizeDocumentEditPlanWithDiagnostics({
      operations: [{ type: "rewriteEverything", locator: { kind: "paragraph", blockId: "p1" } } as never],
    }, "docs/edit.docx")
    expect(unsupported.diagnostics.errors.join("\n")).toContain('operations[0].type is not supported: "rewriteEverything"')

    const invalidLocator = normalizeDocumentEditPlanWithDiagnostics({
      operations: [{ type: "replaceText", locator: { kind: "unknown" }, oldText: "a", newText: "b" } as never],
    }, "docs/edit.docx")
    expect(invalidLocator.diagnostics.errors.join("\n")).toContain("operations[0].locator is missing or invalid")
  })

  test("edit planner fallback uses table cell tracked change for inspected table replacements", async () => {
    const bytes = cGuidelineDocxFixture({
      title: "表格红线 Word",
      sections: [{ heading: "状态章节", paragraphs: ["表格下面需要审阅。"] }],
      tableRows: [["字段", "值"], ["状态", "Draft"]],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-redline.docx", bytes })
    const plan = await new DocumentEditPlanner().plan({
      question: "请用红线把表格里的 Draft 替换为 Final",
      targetPath: "docs/table-redline.docx",
      inspection,
    })

    expect(plan.ok).toBe(true)
    const operation = plan.plan!.operations[0]
    const table = inspection.tables.find((item) => item.rows.some((row) => row.includes("Draft")))!
    const expectedRowIndex = table.rows.findIndex((row) => row.includes("Draft"))
    const expectedCellIndex = table.rows[expectedRowIndex]!.findIndex((cell) => cell === "Draft")
    expect(operation?.type).toBe("updateTableWithTrackedChange")
    expect(operation?.locator.kind).toBe("tableCell")
    expect(operation?.locator.rowIndex).toBe(expectedRowIndex)
    expect(operation?.locator.cellIndex).toBe(expectedCellIndex)
    if (operation?.type === "updateTableWithTrackedChange") {
      expect(operation.text).toBe("Final")
    }
  })

  test("apply_word_document_edits can replace exact text inside a paragraph", async () => {
    const root = await tempDir("chipmate-word-inline-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "局部编辑 Word",
      sections: [{ heading: "现有章节", paragraphs: ["这是第一段，需要局部调整，并保留其余文字。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/inline-edit.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text.includes("需要局部调整"))!
    const validation = validateDocumentEditPlan({
      planId: "inline-edit",
      targetPath: "docs/inline-edit.docx",
      operations: [{ type: "replaceText", locator: paragraph.locator, oldText: "需要局部调整", newText: "需要精确调整" }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/inline-edit.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).toContain("这是第一段")
    expect(documentXml).toContain("需要精确调整")
    expect(documentXml).toContain("并保留其余文字")
    expect(documentXml).not.toContain("需要局部调整")
    expect(result.appliedOperations[0]?.type).toBe("replaceText")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can apply controlled OOXML part patches", async () => {
    const root = await tempDir("chipmate-word-ooxml-patch-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "OOXML 补丁 Word",
      sections: [{ heading: "现有章节", paragraphs: ["正文保留。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/ooxml-patch.docx", bytes })
    const validation = validateDocumentEditPlan({
      planId: "ooxml-patch",
      targetPath: "docs/ooxml-patch.docx",
      outputFilenameBase: "ooxml-patch-output",
      operations: [{
        type: "patchOoxmlPart",
        locator: inspection.documentEndLocator,
        part: "word/document.xml",
        reason: "native operations cannot express this small OOXML repair in the fixture",
        patches: [{
          action: "appendBeforeClose",
          closeTag: "</w:body>",
          text: "<w:p><w:r><w:t>OOXML patched paragraph</w:t></w:r></w:p>",
          expectedOccurrences: 1,
        }],
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const unsafeValidation = validateDocumentEditPlan({
      planId: "ooxml-patch-unsafe",
      targetPath: "docs/ooxml-patch.docx",
      operations: [{
        type: "patchOoxmlPart",
        locator: inspection.documentEndLocator,
        part: "word/_rels/document.xml.rels",
        reason: "unsafe external relationship should be rejected",
        patches: [{
          action: "appendBeforeClose",
          closeTag: "</Relationships>",
          text: '<Relationship Id="rIdUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/x.png" TargetMode="External"/>',
        }],
      }],
      warnings: [],
    }, inspection)
    expect(unsafeValidation.ok).toBe(false)
    expect(unsafeValidation.errors.join("\n")).toContain("external relationships")

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/ooxml-patch.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).toContain("OOXML patched paragraph")
    expect(result.appliedOperations[0]?.type).toBe("patchOoxmlPart")
    expect(result.appliedOperations[0]?.detail).toContain("patched word/document.xml")
    expect(result.structureCheckResult.ok).toBe(true)
  })

	  test("apply_word_document_edits can replace a paragraph with a rich paragraph", async () => {
    const root = await tempDir("chipmate-word-rich-replace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "富文本替换 Word",
      sections: [{ heading: "现有章节", paragraphs: ["正文保留。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/rich-replace.docx", bytes })
    const heading = inspection.paragraphs.find((item) => item.text === "现有章节")!
    const validation = validateDocumentEditPlan({
      planId: "rich-replace",
      targetPath: "docs/rich-replace.docx",
      outputFilenameBase: "rich-replace-output",
      operations: [{
        type: "replaceParagraphWithRichParagraph",
        locator: heading.locator,
        paragraph: {
          runs: [
            { text: "更新后的" },
            { text: "标题", bold: true },
            { text: "，参见 " },
            { text: "外部规范", hyperlink: { url: "https://example.com/spec", tooltip: "规范链接" } },
            { text: " / " },
            { text: "返回顶部", italic: true, hyperlink: { anchor: "Top" } },
            { text: " / " },
            { text: "图 1", reference: { bookmark: "fig_sample", field: "REF", fallbackText: "图 1" } },
            { text: " / 带脚注" },
            { note: { kind: "footnote", text: "替换段落脚注。" } },
          ],
        },
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/rich-replace.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const footnotesXml = await readDocxPart(outputBytes, "word/footnotes.xml")
    const replacedIndex = documentXml.indexOf("更新后的")
    const paragraphXml = documentXml.slice(documentXml.lastIndexOf("<w:p>", replacedIndex), documentXml.indexOf("</w:p>", replacedIndex) + "</w:p>".length)
    expect(documentXml).toContain("更新后的")
    expect(documentXml).not.toContain("现有章节")
    expect(paragraphXml).toContain(`<w:pStyle w:val="${heading.styleId}"/>`)
    expect(paragraphXml).toContain("<w:b/>")
    expect(paragraphXml).toContain("<w:i/>")
    expect(paragraphXml).toContain('<w:hyperlink r:id="rIdChipMateHyperlink1" w:tooltip="规范链接">')
    expect(paragraphXml).toContain('<w:hyperlink w:anchor="Top">')
    expect(paragraphXml).toContain('<w:instrText xml:space="preserve"> REF fig_sample \\h </w:instrText>')
    expect(paragraphXml).toContain('<w:footnoteReference w:id="1"/>')
    expect(contentTypesXml).toContain('PartName="/word/footnotes.xml"')
    expect(documentRelsXml).toContain('Target="https://example.com/spec" TargetMode="External"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"')
    expect(footnotesXml).toContain('<w:footnote w:id="-1" w:type="separator">')
    expect(footnotesXml).toContain("<w:footnoteRef/>")
    expect(footnotesXml).toContain("替换段落脚注。")
    expect(result.appliedOperations[0]?.type).toBe("replaceParagraphWithRichParagraph")
	    expect(result.structureCheckResult.ok).toBe(true)
	  })

  test("apply_word_document_edits can replace a paragraph with ordered structural blocks", async () => {
    const root = await tempDir("chipmate-word-block-replace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "结构块替换 Word",
      sections: [{ heading: "现有章节", paragraphs: ["待替换结构块。", "后续正文。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/block-replace.docx", bytes })
    const target = inspection.paragraphs.find((item) => item.text === "待替换结构块。")!
    const validation = validateDocumentEditPlan({
      planId: "block-replace",
      targetPath: "docs/block-replace.docx",
      outputFilenameBase: "block-replace-output",
      operations: [{
        type: "replaceParagraphWithBlocks",
        locator: target.locator,
        blocks: [
          { type: "paragraph", text: "替换后的结构化正文。" },
          {
            type: "list",
            list: {
              kind: "checklist",
              items: [
                { text: "确认范围", checked: true },
                { text: "确认证据", checked: false },
              ],
            },
          },
          {
            type: "figure",
            figure: {
              title: "替换流程图",
              caption: "段落替换插入的 PNG。",
              label: "Figure",
              bookmark: "fig_replace_blocks",
              altText: "替换流程图 PNG",
              image: {
                contentType: "image/png",
                base64: Buffer.from(tinyPngBytes()).toString("base64"),
                width: 32,
                height: 16,
              },
            },
          },
          { type: "table", table: { headers: ["项", "状态"], rows: [["结构行项", "已落地"]] } },
          {
            type: "evidenceCards",
            evidenceCards: {
              cards: [{
                title: "替换证据",
                summary: "段落被替换成结构块序列。",
                source: "Edit Plan",
                sourceRefs: ["EDIT-1"],
                role: "primary",
                confidence: "high",
              }],
            },
          },
          {
            type: "quoteBlock",
            quoteBlock: {
              kind: "quote",
              text: "Structured replacement keeps the document shape.",
              attribution: "Documents Skill",
            },
          },
        ],
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/block-replace.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const numberingXml = await readDocxPart(outputBytes, "word/numbering.xml")
    const parts = await docxPartPaths(outputBytes)
    expect(documentXml).not.toContain("待替换结构块。")
    expect(appearsBefore(documentXml, "替换后的结构化正文。", "确认范围")).toBe(true)
    expect(appearsBefore(documentXml, "确认证据", "替换流程图")).toBe(true)
    expect(appearsBefore(documentXml, "替换流程图", "结构行项")).toBe(true)
    expect(appearsBefore(documentXml, "结构行项", "替换证据")).toBe(true)
    expect(appearsBefore(documentXml, "替换证据", "Structured replacement keeps the document shape.")).toBe(true)
    expect(appearsBefore(documentXml, "Structured replacement keeps the document shape.", "后续正文。")).toBe(true)
    expect(documentXml).toContain('<w:pStyle w:val="ListParagraph"/>')
    expect(numberingXml).toContain('w:lvlText w:val="☐"')
    expect(numberingXml).toContain('w:lvlText w:val="☑"')
    expect(documentXml).toContain("<w:drawing>")
    expect(documentXml).toContain('descr="替换流程图 PNG"')
    expect(documentXml).toContain('<w:bookmarkStart w:id="1000" w:name="fig_replace_blocks"/>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>')
    expect(documentXml).toContain('<w:t xml:space="preserve">: 段落替换插入的 PNG。</w:t>')
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">来源：Edit Plan</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">引用：EDIT-1</w:t>')
    expect(documentXml).toContain('<w:pStyle w:val="Quote"/>')
    expect(parts).toContain("word/media/image1.png")
    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(contentTypesXml).toContain('PartName="/word/numbering.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"')
    expect(result.appliedOperations[0]?.type).toBe("replaceParagraphWithBlocks")
    expect(result.structureCheckResult.ok).toBe(true)
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(updatedInspection.lists.some((list) => list.kind === "checklist" && list.items.some((item) => item.text === "确认范围"))).toBe(true)
    expect(updatedInspection.images.some((image) => image.target === "media/image1.png" && image.altText === "替换流程图 PNG")).toBe(true)
  })

	  test("apply_word_document_edits can insert a section with lists figures callouts and code blocks", async () => {
    const root = await tempDir("chipmate-word-rich-insert-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "富内容插入文档",
      sections: [{ heading: "现有章节", paragraphs: ["现有正文。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/rich-insert.docx", bytes })
    const validation = validateDocumentEditPlan({
      planId: "rich-insert",
      targetPath: "docs/rich-insert.docx",
      outputFilenameBase: "rich-insert-output",
      operations: [{
        type: "insertSection",
        locator: inspection.documentEndLocator,
	        title: "新增审阅说明",
	        level: 2,
	        paragraphs: ["新增段落正文。"],
	        lists: [{
	          kind: "numbered",
	          title: "交付步骤",
	          items: [
	            { text: "确认证据来源" },
	            { text: "复核渲染页面", level: 1 },
	            { text: "发布最终版本", level: 2 },
	          ],
	        }],
	        figures: [{
	          title: "新增流程图",
	          caption: "新增 section 中的 PNG 图表。",
	          label: "Figure",
	          bookmark: "fig_inserted_flow",
	          altText: "新增流程图 PNG",
	          image: {
	            contentType: "image/png",
	            base64: Buffer.from(tinyPngBytes()).toString("base64"),
	            width: 32,
	            height: 16,
	          },
	        }],
	        callouts: [{ kind: "warning", title: "审阅风险", body: "这里需要人工确认边界条件。" }],
	        codeBlocks: [{ language: "c", caption: "边界检查示例", code: "if (ptr == NULL) {\n    return -EINVAL;\n}" }],
	      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/rich-insert.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

	    const outputBytes = await readFile(join(root, result.path))
	    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
	    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
	    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
	    const numberingXml = await readDocxPart(outputBytes, "word/numbering.xml")
	    const parts = await docxPartPaths(outputBytes)
	    const richTableIndex = documentXml.indexOf("审阅风险")
	    const richTableXml = documentXml.slice(documentXml.lastIndexOf("<w:tbl>", richTableIndex), documentXml.indexOf("</w:tbl>", richTableIndex) + "</w:tbl>".length)
	    expect(documentXml).toContain("新增审阅说明")
	    expect(documentXml).toContain("交付步骤")
	    expect(documentXml).toContain("确认证据来源")
	    expect(documentXml).toContain("复核渲染页面")
	    expect(documentXml).toContain("发布最终版本")
	    expect(documentXml).toContain('<w:pStyle w:val="ListParagraph"/>')
	    expect(documentXml).toContain("<w:drawing>")
	    expect(documentXml).toContain('descr="新增流程图 PNG"')
	    expect(documentXml).toContain('<w:bookmarkStart w:id="1000" w:name="fig_inserted_flow"/>')
	    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>')
	    expect(documentXml).toContain('<w:t xml:space="preserve">: 新增 section 中的 PNG 图表。</w:t>')
	    expect(documentXml).toContain("审阅风险")
	    expect(documentXml).toContain("这里需要人工确认边界条件。")
	    expect(documentXml).toContain("边界检查示例")
	    expect(documentXml).toContain("return -EINVAL;")
	    expect(documentXml).toContain('<w:pStyle w:val="CodeBlock"/>')
	    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
	    expect(appearsBefore(richTableXml, "<w:tblBorders>", '<w:tblLayout w:type="fixed"/>')).toBe(true)
	    expect(parts).toContain("word/media/image1.png")
	    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>')
	    expect(contentTypesXml).toContain('PartName="/word/numbering.xml"')
	    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"')
	    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"')
	    expect(numberingXml).toContain('w:multiLevelType w:val="hybridMultilevel"')
	    expect(numberingXml).toContain('w:lvlText w:val="%1.%2.%3."')
	    expect(result.appliedOperations[0]?.type).toBe("insertSection")
	    expect(result.structureCheckResult.ok).toBe(true)
	    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
	    expect(updatedInspection.lists.some((list) => list.kind === "numbered" && list.items.some((item) => item.text === "发布最终版本" && item.level === 2))).toBe(true)
	    expect(updatedInspection.images.some((image) => image.target === "media/image1.png" && image.altText === "新增流程图 PNG")).toBe(true)
	  })

  test("apply_word_document_edits preserves ordered insertSection blocks with rich paragraphs", async () => {
    const root = await tempDir("chipmate-word-ordered-insert-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "有序内容块插入文档",
      sections: [{ heading: "现有章节", paragraphs: ["现有正文。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/ordered-insert.docx", bytes })
    const validation = validateDocumentEditPlan({
      planId: "ordered-insert",
      targetPath: "docs/ordered-insert.docx",
      outputFilenameBase: "ordered-insert-output",
      operations: [{
        type: "insertSection",
        locator: inspection.documentEndLocator,
        title: "新增有序内容块",
        level: 2,
        blocks: [
          { type: "callout", callout: { kind: "info", title: "块级提示", body: "先给出编辑意图。" } },
          {
            type: "briefCards",
            briefCards: {
              columns: 2,
              cards: [
                { title: "状态", value: "Ready", body: "关键事实先进入摘要卡。", tone: "success" },
                { title: "风险", value: "Low", footer: "来自审阅记录", tone: "info" },
              ],
            },
          },
          {
            type: "evidenceCards",
            evidenceCards: {
              columns: 2,
              cards: [
                {
                  title: "需求证据",
                  summary: "用户要求引用块和证据摘要保持可追溯。",
                  source: "Architecture Review",
                  path: "docs/review.docx",
                  locator: "section-2",
                  quote: "Evidence must stay anchored.",
                  role: "primary",
                  confidence: "high",
                  sourceRefs: ["REQ-9"],
                },
              ],
            },
          },
          { type: "quoteBlock", quoteBlock: { kind: "quote", text: "Evidence must stay anchored.", attribution: "Architecture Review", source: "REQ-9" } },
          {
            type: "richParagraph",
            paragraph: {
              runs: [
                { text: "请参考 " },
                { text: "外部资料", bold: true, hyperlink: { url: "https://example.com/spec", tooltip: "外部规范" } },
                { text: " 和 " },
                { text: "内部章节", italic: true, hyperlink: { anchor: "sec_internal_notes" } },
                { text: "，并查看 " },
                { text: "图 1", reference: { bookmark: "fig_ordered_flow", field: "REF", fallbackText: "图 1" } },
                { text: "，并保留审阅尾注" },
                { note: { kind: "endnote", text: "块级尾注。" } },
                { text: "。" },
              ],
            },
          },
          { type: "list", list: { kind: "numbered", title: "块级步骤", items: [{ text: "先审阅证据" }, { text: "再更新正文", level: 1 }] } },
          {
            type: "figure",
            figure: {
              title: "块级图",
              caption: "按 blocks 顺序插入的 PNG。",
              label: "Figure",
              bookmark: "fig_ordered_flow",
              altText: "块级图 PNG",
              image: {
                contentType: "image/png",
                base64: Buffer.from(tinyPngBytes()).toString("base64"),
                width: 32,
                height: 16,
              },
            },
          },
          { type: "table", table: { headers: ["项", "说明"], rows: [["块级表格", "位于图片之后"]] } },
          { type: "codeBlock", codeBlock: { language: "text", caption: "块级代码", code: "ordered=true" } },
        ],
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/ordered-insert.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const endnotesXml = await readDocxPart(outputBytes, "word/endnotes.xml")
    const parts = await docxPartPaths(outputBytes)
    expect(appearsBefore(documentXml, "块级提示", "状态")).toBe(true)
    expect(appearsBefore(documentXml, "Ready", "需求证据")).toBe(true)
    expect(appearsBefore(documentXml, "需求证据", "Evidence must stay anchored.")).toBe(true)
    expect(appearsBefore(documentXml, "Evidence must stay anchored.", "外部资料")).toBe(true)
    expect(appearsBefore(documentXml, "外部资料", "块级步骤")).toBe(true)
    expect(appearsBefore(documentXml, "块级步骤", "块级图")).toBe(true)
    expect(appearsBefore(documentXml, "块级图", "块级表格")).toBe(true)
    expect(appearsBefore(documentXml, "块级表格", "块级代码")).toBe(true)
    expect(documentXml).toContain('<w:pStyle w:val="Quote"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">- Architecture Review - REQ-9</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">关键事实先进入摘要卡。</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">来自审阅记录</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">用户要求引用块和证据摘要保持可追溯。</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">来源：Architecture Review</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">路径：docs/review.docx</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">引用：REQ-9</w:t>')
    expect(documentXml).toContain('<w:hyperlink r:id="rIdChipMateHyperlink1" w:tooltip="外部规范">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="sec_internal_notes">')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> REF fig_ordered_flow \\h </w:instrText>')
    expect(documentXml).toContain('<w:endnoteReference w:id="1"/>')
    expect(contentTypesXml).toContain('PartName="/word/endnotes.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/spec" TargetMode="External"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"')
    expect(endnotesXml).toContain('<w:endnote w:id="-1" w:type="separator">')
    expect(endnotesXml).toContain("<w:endnoteRef/>")
    expect(endnotesXml).toContain("块级尾注。")
    expect(parts).toContain("word/media/image1.png")
    expect(parts).toContain("word/endnotes.xml")
    expect(result.appliedOperations[0]?.type).toBe("insertSection")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can update Word list items while preserving numbering", async () => {
    const root = await tempDir("chipmate-word-list-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "list-edit"
    spec.sources = []
    spec.references = []
    spec.sections = [{
      id: "delivery",
      level: 1,
      title: "Delivery Checklist",
      paragraphs: ["List edit sample."],
      lists: [{
        kind: "numbered",
        items: [
          { text: "Draft scope" },
          { text: "Review evidence", level: 1 },
          { text: "Publish pack", level: 2 },
        ],
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/list-edit.docx", bytes })
    const list = inspection.lists.find((item) => item.kind === "numbered")!
    const validation = validateDocumentEditPlan({
      planId: "update-list",
      targetPath: "docs/list-edit.docx",
      outputFilenameBase: "updated-list-doc",
      operations: [{
        type: "updateList",
        locator: list.locator,
        items: [
          { text: "Confirm scope", level: 0 },
          { text: "Review rendered pages", level: 1 },
          { text: "Publish final package", level: 2 },
          { text: "Archive evidence", level: 1 },
        ],
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/list-edit.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).toContain("Confirm scope")
    expect(documentXml).toContain("Review rendered pages")
    expect(documentXml).toContain("Publish final package")
    expect(documentXml).toContain("Archive evidence")
    expect(documentXml).not.toContain("Draft scope")
    expect(documentXml).not.toContain("<w:t xml:space=\"preserve\">1. Confirm scope</w:t>")
    expect(documentXml).toContain("<w:numPr>")
    expect(documentXml).toContain('<w:ilvl w:val="2"/>')
    expect(result.appliedOperations[0]?.type).toBe("updateList")
    expect(result.structureCheckResult.ok).toBe(true)
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    const updatedList = updatedInspection.lists.find((item) => item.kind === "numbered")!
    expect(updatedList.itemCount).toBe(4)
    expect(updatedList.items.map((item) => item.text)).toEqual(["Confirm scope", "Review rendered pages", "Publish final package", "Archive evidence"])
    expect(updatedList.items.map((item) => item.level)).toEqual([0, 1, 2, 1])
  })

	  test("apply_word_document_edits can mark inspected table header rows for accessibility", async () => {
	    const root = await tempDir("chipmate-word-table-header-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "table-header-edit"
    spec.sections = [{
      id: "table",
      level: 1,
      title: "Table Header",
      tables: [{
        headers: ["Field", "Value"],
        rows: [["Owner", "Team"], ["Status", "Ready"]],
      }],
    }]
    let bytes = await new WordDocBuilder().build(spec)
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace("<w:tblHeader/>", ""))
    const initialIssues = await new DocxRenderQualityGate().check(bytes)
    expect(initialIssues.map((issue) => issue.code)).toContain("a11y-missing-table-header")
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-header.docx", bytes })
    const table = inspection.tables[0]!
    const validation = validateDocumentEditPlan({
      planId: "update-table-header",
      targetPath: "docs/table-header.docx",
      outputFilenameBase: "table-header-updated",
      operations: [{ type: "updateTableHeaderRows", locator: table.locator, headerRowCount: 1 }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/table-header.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const issueCodes = (await new DocxRenderQualityGate().check(outputBytes)).map((issue) => issue.code)
    const ownerIndex = documentXml.indexOf("Owner")
    const targetTableXml = documentXml.slice(documentXml.lastIndexOf("<w:tbl", ownerIndex), documentXml.indexOf("</w:tbl>", ownerIndex) + "</w:tbl>".length)
    expect(targetTableXml.match(/<w:tblHeader\/>/g)?.length).toBe(1)
    expect(targetTableXml.indexOf("<w:tblHeader/>")).toBeLessThan(targetTableXml.indexOf("Owner"))
    expect(issueCodes).not.toContain("a11y-missing-table-header")
    expect(result.appliedOperations[0]?.type).toBe("updateTableHeaderRows")
	    expect(result.structureCheckResult.ok).toBe(true)
	  })

	  test("apply_word_document_edits can replace an inspected table with a fixed-layout table", async () => {
	    const root = await tempDir("chipmate-word-table-replace-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const spec = minimalRenderableWordDocSpec()
	    spec.metadata.documentType = "table-replace"
	    spec.sections = [{
	      id: "table",
	      level: 1,
	      title: "Table Replace",
	      tables: [{
	        headers: ["Old Field", "Old Value"],
	        rows: [["Owner", "Team"], ["Status", "Ready"]],
	      }],
	    }]
	    const bytes = await new WordDocBuilder().build(spec)
	    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-replace.docx", bytes })
	    const table = inspection.tables.find((item) => item.rows.some((row) => row.includes("Old Field")))!
	    const validation = validateDocumentEditPlan({
	      planId: "replace-table",
	      targetPath: "docs/table-replace.docx",
	      outputFilenameBase: "table-replaced",
	      operations: [{
	        type: "replaceTable",
	        locator: table.locator,
	        table: {
	          headers: ["Metric", "Before", "After"],
	          rows: [
	            ["Coverage", "Partial", "Complete"],
	            ["Risk", "Open", "Closed"],
	          ],
	        },
	      }],
	      warnings: [],
	    }, inspection)
	    expect(validation.ok).toBe(true)

	    const result = await new WordDocumentEditor(root).apply({
	      sourcePath: "docs/table-replace.docx",
	      bytes,
	      inspection,
	      plan: validation.plan!,
	    })

	    const outputBytes = await readFile(join(root, result.path))
	    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
	    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
	    const updatedTable = updatedInspection.tables.find((item) => item.rows.some((row) => row.includes("Metric")))!
	    expect(documentXml).toContain("Metric")
	    expect(documentXml).toContain("Complete")
	    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
	    expect(documentXml).not.toContain("Old Field")
	    expect(documentXml).not.toContain("Ready")
	    expect(updatedTable.rows).toEqual([
	      ["Metric", "Before", "After"],
	      ["Coverage", "Partial", "Complete"],
	      ["Risk", "Open", "Closed"],
	    ])
	    expect(result.appliedOperations[0]?.type).toBe("replaceTable")
	    expect(result.structureCheckResult.ok).toBe(true)
	  })

	  test("apply_word_document_edits can insert a table column while preserving existing table content", async () => {
	    const root = await tempDir("chipmate-word-table-column-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const spec = minimalRenderableWordDocSpec()
	    spec.metadata.documentType = "table-column-insert"
	    spec.sections = [{
	      id: "table",
	      level: 1,
	      title: "Table Column",
	      tables: [{
	        headers: ["Item", "Owner"],
	        rows: Array.from({ length: 20 }, (_unused, index) => [`Phase ${index + 1}`, `Owner ${index + 1}`]),
	      }],
	    }]
	    const bytes = await new WordDocBuilder().build(spec)
	    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-column.docx", bytes })
	    const table = inspection.tables.find((item) => item.rows.some((row) => row.includes("Item") && row.includes("Owner")))!
	    const validation = validateDocumentEditPlan({
	      planId: "insert-column",
	      targetPath: "docs/table-column.docx",
	      outputFilenameBase: "table-column-inserted",
	      operations: [{
	        type: "insertTableColumn",
	        locator: table.locator,
	        header: "是否满足验收标准",
	        values: table.rows.slice(1).map((_row, index) => index % 2 === 0 ? "满足" : "不满足"),
	      }],
	      warnings: [],
	    }, inspection)
	    expect(validation.ok).toBe(true)

	    const result = await new WordDocumentEditor(root).apply({
	      sourcePath: "docs/table-column.docx",
	      bytes,
	      inspection,
	      plan: validation.plan!,
	    })

	    const outputBytes = await readFile(join(root, result.path))
	    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
	    const updatedTable = updatedInspection.tables.find((item) => item.rows.some((row) => row.includes("Item") && row.includes("Owner")))!
	    expect(updatedTable.rows[0]).toEqual(["Item", "Owner", "是否满足验收标准"])
	    expect(updatedTable.rows[1]).toEqual(["Phase 1", "Owner 1", "满足"])
	    expect(updatedTable.rows[20]).toEqual(["Phase 20", "Owner 20", "不满足"])
	    expect(result.tablePreservationCheckResult.ok).toBe(true)
	    expect(result.tablePreservationCheckResult.lostNonEmptyCells).toBe(0)
	    expect(result.appliedOperations[0]?.type).toBe("insertTableColumn")
	  })

	  test("apply_word_document_edits blocks destructive large-table replaceTable edits", async () => {
	    const root = await tempDir("chipmate-word-table-replace-risk-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const spec = minimalRenderableWordDocSpec()
	    spec.metadata.documentType = "table-replace-risk"
	    spec.sections = [{
	      id: "table",
	      level: 1,
	      title: "Table Replace Risk",
	      tables: [{
	        headers: ["Item", "Owner"],
	        rows: Array.from({ length: 20 }, (_unused, index) => [`Phase ${index + 1}`, `Owner ${index + 1}`]),
	      }],
	    }]
	    const bytes = await new WordDocBuilder().build(spec)
	    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-replace-risk.docx", bytes })
	    const table = inspection.tables.find((item) => item.rows.some((row) => row.includes("Item") && row.includes("Owner")))!
	    const validation = validateDocumentEditPlan({
	      planId: "destructive-replace",
	      targetPath: "docs/table-replace-risk.docx",
	      outputFilenameBase: "table-replace-risk",
	      operations: [{
	        type: "replaceTable",
	        locator: table.locator,
	        table: {
	          headers: ["是否满足验收标准"],
	          rows: [["不满足"], ["满足"]],
	        },
	      }],
	      warnings: [],
	    }, inspection)
	    expect(validation.ok).toBe(true)

	    await expect(new WordDocumentEditor(root).apply({
	      sourcePath: "docs/table-replace-risk.docx",
	      bytes,
	      inspection,
	      plan: validation.plan!,
	    })).rejects.toThrow("replace-table-content-loss-risk")
	  })

	  test("apply_word_document_edits can replace a table with merged cells", async () => {
	    const root = await tempDir("chipmate-word-table-merge-replace-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const spec = minimalRenderableWordDocSpec()
	    spec.sections = [{
	      id: "table",
	      level: 1,
	      title: "Merged Table Replace",
	      tables: [{
	        headers: ["Old A", "Old B", "Old C"],
	        rows: [["A", "B", "C"]],
	      }],
	    }]
	    const bytes = await new WordDocBuilder().build(spec)
	    const inspection = await new WordDocumentInspector().inspect({ path: "docs/merged-table-replace.docx", bytes })
	    const table = inspection.tables.find((item) => item.rows.some((row) => row.includes("Old A")))!
	    const validation = validateDocumentEditPlan({
	      planId: "replace-table-with-merge",
	      targetPath: "docs/merged-table-replace.docx",
	      outputFilenameBase: "table-merged-replaced",
	      operations: [{
	        type: "replaceTable",
	        locator: table.locator,
	        table: {
	          headers: ["Stage", "Owner", "Status"],
	          rows: [
	            [{ text: "Plan", colSpan: 2, alignment: "center" }, "Open"],
	            [{ text: "Shared", rowSpan: 2 }, "Alice", "Ready"],
	            ["Bob", "Done"],
	          ],
	        },
	      }],
	      warnings: [],
	    }, inspection)
	    expect(validation.ok).toBe(true)

	    const result = await new WordDocumentEditor(root).apply({
	      sourcePath: "docs/merged-table-replace.docx",
	      bytes,
	      inspection,
	      plan: validation.plan!,
	    })

	    const outputBytes = await readFile(join(root, result.path))
	    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
	    expect(documentXml).toContain('<w:gridSpan w:val="2"/>')
	    expect(documentXml).toContain('<w:vMerge w:val="restart"/>')
	    expect(documentXml).toContain("<w:vMerge/>")
	    expect(documentXml).toContain("Plan")
	    expect(documentXml).toContain("Shared")
	    expect(result.structureCheckResult.ok).toBe(true)
	  })

	  test("apply_word_document_edits can fix skipped heading levels from an inspect locator", async () => {
	    const root = await tempDir("chipmate-word-heading-level-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "heading-level-edit"
    spec.sections = [
      { id: "top", level: 1, title: "Top Section", paragraphs: ["Heading level sample."] },
      { id: "skipped", level: 3, title: "Skipped Level", paragraphs: ["This heading initially skips level 2."] },
    ]
    const bytes = await new WordDocBuilder().build(spec)
    const initialIssueCodes = (await new DocxRenderQualityGate().check(bytes)).map((issue) => issue.code)
    expect(initialIssueCodes).toContain("a11y-heading-level-skip")
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/heading-level.docx", bytes })
    const skippedHeading = inspection.paragraphs.find((paragraph) => paragraph.text === "Skipped Level")!
    expect(skippedHeading.headingLevel).toBe(3)
    const validation = validateDocumentEditPlan({
      planId: "update-heading-level",
      targetPath: "docs/heading-level.docx",
      outputFilenameBase: "heading-level-updated",
      operations: [{ type: "updateHeadingLevel", locator: skippedHeading.locator, level: 2 }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/heading-level.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const issueCodes = (await new DocxRenderQualityGate().check(outputBytes)).map((issue) => issue.code)
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    const updatedHeading = updatedInspection.paragraphs.find((paragraph) => paragraph.text === "Skipped Level")!
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"/>')
    expect(issueCodes).not.toContain("a11y-heading-level-skip")
    expect(updatedHeading.headingLevel).toBe(2)
    expect(updatedHeading.styleId).toBe("Heading2")
    expect(result.appliedOperations[0]?.type).toBe("updateHeadingLevel")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can update section page setup from an inspect locator", async () => {
    const root = await tempDir("chipmate-word-section-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "section-edit"
    spec.layout = { page: { size: "a4" } }
    spec.sections = [{
      id: "page-setup",
      level: 1,
      title: "Page Setup",
      paragraphs: ["Section page setup sample."],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/section-edit.docx", bytes })
    const section = inspection.sections[0]!
    const validation = validateDocumentEditPlan({
      planId: "update-section-page",
      targetPath: "docs/section-edit.docx",
      outputFilenameBase: "section-page-setup",
      operations: [{
        type: "updateSectionPageSetup",
        locator: section.locator,
        page: {
          size: "letter",
          orientation: "landscape",
          margins: { top: 720, right: 900, bottom: 720, left: 900, header: 360, footer: 360, gutter: 0 },
        },
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/section-edit.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(result.appliedOperations[0]?.type).toBe("updateSectionPageSetup")
    expect(result.structureCheckResult.ok).toBe(true)
    expect(documentXml).toContain('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
    expect(documentXml).toContain('<w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900" w:header="360" w:footer="360" w:gutter="0"/>')
    expect(documentXml.indexOf("<w:pgSz")).toBeLessThan(documentXml.indexOf("<w:pgMar"))
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    const updatedSection = updatedInspection.sections[0]!
    expect(updatedSection.page.orientation).toBe("landscape")
    expect(updatedSection.page.widthTwips).toBe(15840)
    expect(updatedSection.page.heightTwips).toBe(12240)
    expect(updatedSection.page.margins?.left).toBe(900)
    expect(updatedSection.page.margins?.header).toBe(360)
  })

  test("inspect_word_document reports section first-page odd-even header footer linkage", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "section-audit"
    spec.layout = { page: { size: "letter" } }
    spec.sections = [
      { id: "portrait", level: 1, title: "Portrait Section", paragraphs: ["First section content."] },
      { id: "landscape", level: 1, title: "Landscape Section", paragraphs: ["Second section content."] },
    ]
    let bytes = await new WordDocBuilder().build(spec)
    bytes = await writeDocxPart(
      bytes,
      "word/settings.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders/></w:settings>',
    )
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace(
      /<w:sectPr\b[\s\S]*?<\/w:sectPr>/,
      [
        '<w:p><w:pPr><w:sectPr>',
        '<w:headerReference w:type="default" r:id="rIdHeader1"/>',
        '<w:headerReference w:type="first" r:id="rIdFirstHeader"/>',
        '<w:footerReference w:type="default" r:id="rIdFooter1"/>',
        '<w:footerReference w:type="even" r:id="rIdEvenFooter"/>',
        '<w:type w:val="nextPage"/>',
        '<w:pgSz w:w="12240" w:h="15840"/>',
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>',
        '<w:titlePg/>',
        '</w:sectPr></w:pPr></w:p>',
        '<w:sectPr>',
        '<w:headerReference w:type="even" r:id="rIdEvenHeader2"/>',
        '<w:type w:val="continuous"/>',
        '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>',
        '<w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900" w:header="360" w:footer="360" w:gutter="0"/>',
        '</w:sectPr>',
      ].join(""),
    ))

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/section-audit.docx", bytes })

    expect(inspection.summary.sectionCount).toBe(2)
    const first = inspection.sections[0]!
    const second = inspection.sections[1]!
    expect(first.type).toBe("nextPage")
    expect(first.differentFirstPage).toBe(true)
    expect(first.oddEvenHeaders).toBe(true)
    expect(first.headerFooterLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "header", type: "default", relId: "rIdHeader1", hasReference: true, linkedToPrevious: false }),
      expect.objectContaining({ kind: "header", type: "first", relId: "rIdFirstHeader", hasReference: true, linkedToPrevious: false }),
      expect.objectContaining({ kind: "header", type: "even", relId: undefined, hasReference: false, linkedToPrevious: false }),
      expect.objectContaining({ kind: "footer", type: "even", relId: "rIdEvenFooter", hasReference: true, linkedToPrevious: false }),
    ]))
    expect(second.type).toBe("continuous")
    expect(second.page.orientation).toBe("landscape")
    expect(second.differentFirstPage).toBe(false)
    expect(second.oddEvenHeaders).toBe(true)
    expect(second.headerFooterLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "header", type: "default", relId: undefined, hasReference: false, linkedToPrevious: true }),
      expect.objectContaining({ kind: "header", type: "even", relId: "rIdEvenHeader2", hasReference: true, linkedToPrevious: false }),
      expect.objectContaining({ kind: "footer", type: "default", relId: undefined, hasReference: false, linkedToPrevious: true }),
      expect.objectContaining({ kind: "footer", type: "even", relId: undefined, hasReference: false, linkedToPrevious: true }),
    ]))
  })

  test("apply_word_document_edits can set and clear document protection modes", async () => {
    const root = await tempDir("chipmate-word-protection-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/protection.docx", bytes })
    expect(inspection.summary.hasProtection).toBe(false)
    expect(inspection.summary.protectionMode).toBe("off")

    const protectedResult = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/protection.docx",
      bytes,
      inspection,
      plan: {
        planId: "set-protection",
        targetPath: "docs/protection.docx",
        outputFilenameBase: "comments-protected-doc",
        operations: [
          { type: "setDocumentProtection", locator: inspection.documentEndLocator, mode: "comments" },
        ],
        warnings: [],
      },
    })

    const protectedBytes = await readFile(join(root, protectedResult.path))
    const parts = await docxPartPaths(protectedBytes)
    const contentTypesXml = await readDocxPart(protectedBytes, "[Content_Types].xml")
    const documentRelsXml = await readDocxPart(protectedBytes, "word/_rels/document.xml.rels")
    const settingsXml = await readDocxPart(protectedBytes, "word/settings.xml")
    const protectedInspection = await new WordDocumentInspector().inspect({ path: protectedResult.path, bytes: protectedBytes })
    expect(parts).toContain("word/settings.xml")
    expect(contentTypesXml).toContain('PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"')
    expect(settingsXml).toContain('<w:documentProtection w:edit="comments" w:enforcement="1" w:formatting="0"/>')
    expect(protectedInspection.summary.hasProtection).toBe(true)
    expect(protectedInspection.summary.protectionMode).toBe("comments")
    expect(protectedInspection.protection).toEqual(expect.objectContaining({
      mode: "comments",
      enforced: true,
      formatting: false,
      part: "word/settings.xml",
    }))
    expect(protectedInspection.protection?.locator.kind).toBe("documentProtection")
    expect(protectedResult.appliedOperations[0]?.type).toBe("setDocumentProtection")

    const cleared = await new WordDocumentEditor(root).apply({
      sourcePath: protectedResult.path,
      bytes: protectedBytes,
      inspection: protectedInspection,
      plan: {
        planId: "clear-protection",
        targetPath: protectedResult.path,
        outputFilenameBase: "unprotected-doc",
        operations: [
          { type: "setDocumentProtection", locator: protectedInspection.protection!.locator, mode: "off" },
        ],
        warnings: [],
      },
    })
    const clearedBytes = await readFile(join(root, cleared.path))
    const clearedSettingsXml = await readDocxPart(clearedBytes, "word/settings.xml")
    const clearedInspection = await new WordDocumentInspector().inspect({ path: cleared.path, bytes: clearedBytes })
    expect(clearedSettingsXml).not.toContain("documentProtection")
    expect(clearedInspection.summary.hasProtection).toBe(false)
    expect(clearedInspection.summary.protectionMode).toBe("off")
    expect(clearedInspection.protection).toBeUndefined()
  }, 15_000)

  test("apply_word_document_edits can update image alt text from an inspect locator", async () => {
    const root = await tempDir("chipmate-word-image-alt-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "image-alt-edit"
    spec.sections = [{
      id: "figures",
      level: 1,
      title: "Figures",
      paragraphs: ["Image alt text sample."],
      figures: [{
        id: "fig-alt",
        title: "Old Figure Name",
        caption: "Figure caption.",
        altText: "Old alt text",
        image: {
          contentType: "image/png",
          bytes: tinyPngBytes(),
          width: 160,
          height: 90,
        },
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/image-alt.docx", bytes })
    const image = inspection.images[0]!
    const validation = validateDocumentEditPlan({
      planId: "update-image-alt",
      targetPath: "docs/image-alt.docx",
      outputFilenameBase: "image-alt-updated",
      operations: [{
        type: "updateImageAltText",
        locator: image.locator,
        altText: "Review flow <architecture> & states",
        title: "Architecture review image",
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/image-alt.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(result.appliedOperations[0]?.type).toBe("updateImageAltText")
    expect(result.structureCheckResult.ok).toBe(true)
    expect(documentXml).toContain('descr="Review flow &lt;architecture&gt; &amp; states"')
    expect(documentXml).toContain('title="Architecture review image"')
    expect(documentXml).not.toContain('descr="Old alt text"')
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(updatedInspection.images[0]?.altText).toBe("Review flow <architecture> & states")
  })

  test("apply_word_document_edits can replace an inspected PNG image binary", async () => {
    const root = await tempDir("chipmate-word-image-replace-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "image-replace-edit"
    spec.sections = [{
      id: "figures",
      level: 1,
      title: "Figures",
      paragraphs: ["Image replacement sample."],
      figures: [{
        id: "fig-replace",
        title: "Old Figure",
        caption: "Old figure caption.",
        altText: "Old image alt",
        image: {
          contentType: "image/png",
          bytes: tinyPngBytes(),
          width: 160,
          height: 90,
        },
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/image-replace.docx", bytes })
    const image = inspection.images[0]!
    expect(image.mediaPath).toBe("word/media/image1.png")
    const oldMediaBytes = await readDocxBinaryPart(bytes, image.mediaPath!)
    const nextPngBytes = alternateTinyPngBytes()
    expect(Buffer.from(oldMediaBytes).equals(Buffer.from(nextPngBytes))).toBe(false)

    const validation = validateDocumentEditPlan({
      planId: "replace-image",
      targetPath: "docs/image-replace.docx",
      outputFilenameBase: "image-replaced",
      operations: [{
        type: "replaceImage",
        locator: image.locator,
        figure: {
          title: "Updated Flow Image",
          altText: "Updated rendered flow image",
          image: {
            contentType: "image/png",
            base64: Buffer.from(nextPngBytes).toString("base64"),
            width: 320,
            height: 180,
          },
        },
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/image-replace.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const updatedMediaBytes = await readDocxBinaryPart(outputBytes, image.mediaPath!)
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(result.appliedOperations[0]?.type).toBe("replaceImage")
    expect(result.structureCheckResult.ok).toBe(true)
    expect(Buffer.from(updatedMediaBytes).equals(Buffer.from(nextPngBytes))).toBe(true)
    expect(documentXml).toContain('name="Updated Flow Image"')
    expect(documentXml).toContain('descr="Updated rendered flow image"')
    expect(documentXml).toContain('title="Updated Flow Image"')
    expect(documentXml).toContain('cx="3048000"')
    expect(documentXml).toContain('cy="1714500"')
    expect(updatedInspection.images[0]?.altText).toBe("Updated rendered flow image")
    expect(updatedInspection.images[0]?.widthEmu).toBe(3048000)
    expect(updatedInspection.images[0]?.heightEmu).toBe(1714500)
  })

  test("apply_word_document_edits can inspect and update figure and table captions", async () => {
    const root = await tempDir("chipmate-word-caption-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "caption-edit"
    spec.sections = [{
      id: "captions",
      level: 1,
      title: "Captions",
      paragraphs: ["Caption update sample."],
      figures: [{
        id: "fig-caption",
        title: "Architecture",
        caption: "Old figure caption.",
        label: "Figure",
        number: "7",
        bookmark: "fig_caption_target",
        altText: "Architecture figure",
        image: {
          contentType: "image/png",
          bytes: tinyPngBytes(),
          width: 160,
          height: 90,
        },
      }],
      tables: [{
        id: "tbl-caption",
        caption: "Old table caption.",
        label: "Table",
        number: "3",
        bookmark: "tbl_caption_target",
        headers: ["Item", "Status"],
        rows: [["Caption support", "Implemented"]],
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/captions.docx", bytes })
    expect(inspection.summary.captionCount).toBe(2)
    expect(inspection.summary.fieldTypeCounts.SEQ).toBe(2)
    const figureCaption = inspection.captions.find((caption) => caption.captionKind === "figure")!
    const tableCaption = inspection.captions.find((caption) => caption.captionKind === "table")!
    expect(figureCaption.locator.kind).toBe("caption")
    expect(figureCaption.text).toBe("Old figure caption.")
    expect(figureCaption.fieldInstruction).toBe("SEQ Figure \\* ARABIC")
    expect(figureCaption.bookmark).toBe("fig_caption_target")
    expect(tableCaption.text).toBe("Old table caption.")
    expect(tableCaption.fieldInstruction).toBe("SEQ Table \\* ARABIC")
    expect(tableCaption.bookmark).toBe("tbl_caption_target")

    const validation = validateDocumentEditPlan({
      planId: "update-captions",
      targetPath: "docs/captions.docx",
      outputFilenameBase: "captions-updated",
      operations: [
        {
          type: "updateCaptionText",
          locator: figureCaption.locator,
          caption: "Review flow <architecture> & state transitions.",
        },
        {
          type: "updateCaptionText",
          locator: tableCaption.locator,
          caption: "Updated coverage matrix.",
        },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/captions.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(result.appliedOperations.map((operation) => operation.type)).toEqual(["updateCaptionText", "updateCaptionText"])
    expect(result.structureCheckResult.ok).toBe(true)
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Table \\* ARABIC </w:instrText>')
    expect(documentXml).toContain('<w:bookmarkStart w:id="1001" w:name="fig_caption_target"/>')
    expect(documentXml).toContain('<w:bookmarkStart w:id="2001" w:name="tbl_caption_target"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">: Review flow &lt;architecture&gt; &amp; state transitions.</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">: Updated coverage matrix.</w:t>')
    expect(documentXml).not.toContain("Old figure caption.")
    expect(documentXml).not.toContain("Old table caption.")
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(updatedInspection.summary.captionCount).toBe(2)
    expect(updatedInspection.captions.find((caption) => caption.captionKind === "figure")?.text).toBe("Review flow <architecture> & state transitions.")
    expect(updatedInspection.captions.find((caption) => caption.captionKind === "table")?.text).toBe("Updated coverage matrix.")
    expect(updatedInspection.fields.filter((field) => field.type === "SEQ")).toHaveLength(2)
  })

  test("apply_word_document_edits can update hyperlink text from an inspect locator", async () => {
    const root = await tempDir("chipmate-word-link-text-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "link-text-edit"
    spec.sources = []
    spec.references = []
    spec.sections = [{
      id: "links",
      level: 1,
      title: "Links",
      richParagraphs: [{
        runs: [
          { text: "Review " },
          { text: "click here", hyperlink: { url: "https://openai.com/docs", tooltip: "Official docs" } },
          { text: " before release." },
        ],
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const initialIssueCodes = (await new DocxRenderQualityGate().check(bytes)).map((issue) => issue.code)
    expect(initialIssueCodes).toContain("a11y-nondescriptive-link-text")
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/link-text.docx", bytes })
    expect(inspection.summary.hyperlinkCount).toBe(1)
    const hyperlink = inspection.hyperlinks[0]!
    expect(hyperlink.text).toBe("click here")
    expect(hyperlink.target).toBe("https://openai.com/docs")
    const validation = validateDocumentEditPlan({
      planId: "update-link-text",
      targetPath: "docs/link-text.docx",
      outputFilenameBase: "link-text-updated",
      operations: [{ type: "updateHyperlinkText", locator: hyperlink.locator, text: "OpenAI documentation" }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/link-text.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const issueCodes = (await new DocxRenderQualityGate().check(outputBytes)).map((issue) => issue.code)
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(documentXml).toContain("OpenAI documentation")
    expect(documentXml).not.toContain("click here")
    expect(documentRelsXml).toContain('Target="https://openai.com/docs"')
    expect(issueCodes).not.toContain("a11y-nondescriptive-link-text")
    expect(updatedInspection.hyperlinks[0]?.text).toBe("OpenAI documentation")
    expect(updatedInspection.hyperlinks[0]?.target).toBe("https://openai.com/docs")
    expect(result.appliedOperations[0]?.type).toBe("updateHyperlinkText")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can update hyperlink targets from inspect locators", async () => {
    const root = await tempDir("chipmate-word-link-target-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "link-target-edit"
    spec.sources = []
    spec.references = []
    spec.sections = [
      {
        id: "links",
        level: 1,
        title: "Links",
        richParagraphs: [{
          runs: [
            { text: "Review " },
            { text: "OpenAI docs", hyperlink: { url: "https://openai.com/docs", tooltip: "Official docs" } },
            { text: " and jump to " },
            { text: "implementation", hyperlink: { anchor: "sec_impl", tooltip: "Implementation section" } },
            { text: "." },
          ],
        }],
      },
      {
        id: "impl",
        level: 1,
        title: "Implementation",
        bookmark: "sec_impl",
        paragraphs: ["Implementation details."],
      },
    ]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/link-target.docx", bytes })
    const externalLink = inspection.hyperlinks.find((link) => link.target === "https://openai.com/docs")!
    const internalLink = inspection.hyperlinks.find((link) => link.anchor === "sec_impl")!
    const validation = validateDocumentEditPlan({
      planId: "update-link-targets",
      targetPath: "docs/link-target.docx",
      outputFilenameBase: "link-target-updated",
      operations: [
        { type: "updateHyperlinkTarget", locator: externalLink.locator, url: "https://example.com/new?x=1&scope=dev", tooltip: "Updated docs" },
        { type: "updateHyperlinkTarget", locator: internalLink.locator, anchor: "sec_impl_v2", tooltip: "Updated jump" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/link-target.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(documentXml).toContain("OpenAI docs")
    expect(documentXml).toContain("implementation")
    expect(documentXml).toContain('<w:hyperlink r:id="rIdHyperlink1" w:tooltip="Updated docs">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="sec_impl_v2" w:tooltip="Updated jump">')
    expect(documentRelsXml).toContain('Target="https://example.com/new?x=1&amp;scope=dev" TargetMode="External"')
    expect(documentRelsXml).not.toContain('Target="https://openai.com/docs"')
    expect(updatedInspection.hyperlinks.find((link) => link.text === "OpenAI docs")?.target).toBe("https://example.com/new?x=1&scope=dev")
    expect(updatedInspection.hyperlinks.find((link) => link.text === "OpenAI docs")?.tooltip).toBe("Updated docs")
    expect(updatedInspection.hyperlinks.find((link) => link.text === "implementation")?.anchor).toBe("sec_impl_v2")
    expect(updatedInspection.hyperlinks.find((link) => link.text === "implementation")?.tooltip).toBe("Updated jump")
    expect(result.appliedOperations.map((item) => item.type)).toEqual(["updateHyperlinkTarget", "updateHyperlinkTarget"])
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can update footnote and endnote text from inspect locators", async () => {
    const root = await tempDir("chipmate-word-note-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "note-edit"
    spec.sections = [{
      id: "notes",
      level: 1,
      title: "Notes",
      richParagraphs: [{
        runs: [
          { text: "Footnote target" },
          { note: { kind: "footnote", text: "Original footnote text." } },
          { text: " and endnote target" },
          { note: { kind: "endnote", text: "Original endnote text." } },
          { text: "." },
        ],
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/notes-edit.docx", bytes })
    const footnote = inspection.notes.find((note) => note.noteKind === "footnote")!
    const endnote = inspection.notes.find((note) => note.noteKind === "endnote")!
    const validation = validateDocumentEditPlan({
      planId: "update-notes",
      targetPath: "docs/notes-edit.docx",
      outputFilenameBase: "notes-updated",
      operations: [
        { type: "updateNoteText", locator: footnote.locator, text: "Updated footnote <scope> & evidence.\nSecond footnote paragraph." },
        { type: "updateNoteText", locator: endnote.locator, text: "Updated endnote review note.\nSecond endnote paragraph." },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/notes-edit.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const footnotesXml = await readDocxPart(outputBytes, "word/footnotes.xml")
    const endnotesXml = await readDocxPart(outputBytes, "word/endnotes.xml")
    expect(result.appliedOperations.map((item) => item.type)).toEqual(["updateNoteText", "updateNoteText"])
    expect(result.structureCheckResult.ok).toBe(true)
    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>')
    expect(documentXml).toContain('<w:endnoteReference w:id="1"/>')
    expect(footnotesXml).toContain("<w:footnoteRef/>")
    expect(footnotesXml).toContain("Updated footnote &lt;scope&gt; &amp; evidence.")
    expect(footnotesXml).toContain("Second footnote paragraph.")
    expect((readNoteItemXml(footnotesXml, "footnote", "1").match(/<w:p\b/g) ?? []).length).toBe(2)
    expect(footnotesXml).not.toContain("Original footnote text.")
    expect(endnotesXml).toContain("<w:endnoteRef/>")
    expect(endnotesXml).toContain("Updated endnote review note.")
    expect(endnotesXml).toContain("Second endnote paragraph.")
    expect((readNoteItemXml(endnotesXml, "endnote", "1").match(/<w:p\b/g) ?? []).length).toBe(2)
    expect(endnotesXml).not.toContain("Original endnote text.")
    const updatedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(updatedInspection.notes.map((note) => note.text)).toEqual([
      "Updated footnote <scope> & evidence.\nSecond footnote paragraph.",
      "Updated endnote review note.\nSecond endnote paragraph.",
    ])
  })

  test("inspect_word_document exposes content controls and apply_word_document_edits fills them", async () => {
    const root = await tempDir("chipmate-word-content-control-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "fillable-form"
    spec.sections = [{
      id: "intake",
      level: 1,
      title: "Intake Form",
      paragraphs: ["Please complete the fields below."],
      formFields: [
        { label: "Reviewer", tag: "REVIEWER", placeholder: "{{REVIEWER}}", helpText: "Person responsible for review." },
        { label: "Review date", tag: "REVIEW_DATE", value: "2026-06-27" },
        { label: "Approved", tag: "APPROVED", kind: "checkbox", checked: true },
      ],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/form.docx", bytes })
    expect(inspection.summary.contentControlCount).toBe(3)
    expect(inspection.contentControls.map((item) => item.tag)).toEqual(["REVIEWER", "REVIEW_DATE", "APPROVED"])
    const reviewer = inspection.contentControls.find((item) => item.tag === "REVIEWER")!
    const approved = inspection.contentControls.find((item) => item.tag === "APPROVED")!
    expect(approved.kind).toBe("checkbox")
    expect(approved.checked).toBe(true)
    const validation = validateDocumentEditPlan({
      planId: "fill-form",
      targetPath: "docs/form.docx",
      outputFilenameBase: "filled-form",
      operations: [
        { type: "fillContentControl", locator: reviewer.locator, text: "Alice Reviewer" },
        { type: "fillContentControl", locator: approved.locator, text: "false" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/form.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const afterInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(documentXml).toContain('<w:tag w:val="REVIEWER"/>')
    expect(documentXml).toContain("Alice Reviewer")
    expect(documentXml).toContain('<w14:checked w14:val="0"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">☐</w:t>')
    expect(documentXml).not.toContain("{{REVIEWER}}")
    expect(afterInspection.contentControls.find((item) => item.tag === "REVIEWER")?.text).toBe("Alice Reviewer")
    expect(afterInspection.contentControls.find((item) => item.tag === "APPROVED")?.checked).toBe(false)
    expect(result.appliedOperations.map((operation) => operation.type)).toEqual(["fillContentControl", "fillContentControl"])
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("inspect_word_document reports split-run rich and nested content control fill boundaries", async () => {
    const root = await tempDir("chipmate-word-rich-content-control-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "complex-form"
    spec.sections = [{
      id: "complex-form",
      level: 1,
      title: "Complex Form",
      formFields: [
        { label: "Split marker", tag: "SPLIT", placeholder: "{{SPLIT}}" },
        { label: "Rich field", tag: "RICH", placeholder: "{{RICH}}" },
        { label: "Outer field", tag: "OUTER", placeholder: "{{OUTER}}" },
      ],
    }]
    let bytes = await new WordDocBuilder().build(spec)
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => {
      let nextXml = replaceFirstSdtByTag(xml, "SPLIT", (sdtXml) => splitSdtTextRuns(sdtXml, "{{SPLIT}}", ["{{SPL", "IT}}"]))
      nextXml = replaceFirstSdtByTag(nextXml, "RICH", () => richContentControlFixtureXml())
      nextXml = replaceFirstSdtByTag(nextXml, "OUTER", () => nestedContentControlFixtureXml())
      return nextXml
    })

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/complex-form.docx", bytes })
    expect(inspection.summary.contentControlCount).toBe(3)
    const split = inspection.contentControls.find((item) => item.tag === "SPLIT")!
    const rich = inspection.contentControls.find((item) => item.tag === "RICH")!
    const nested = inspection.contentControls.find((item) => item.tag === "OUTER")!
    expect(split.text).toBe("{{SPLIT}}")
    expect(split.fillSupported).toBe(true)
    expect(split.nestedControlCount).toBe(0)
    expect(rich.fillSupported).toBe(false)
    expect(rich.fillUnsupportedReason).toBe("rich-content-control")
    expect(rich.hasRichContent).toBe(true)
    expect(nested.fillSupported).toBe(false)
    expect(nested.fillUnsupportedReason).toBe("nested-content-control")
    expect(nested.nestedControlCount).toBe(1)

    const splitValidation = validateDocumentEditPlan({
      planId: "fill-split",
      targetPath: "docs/complex-form.docx",
      outputFilenameBase: "complex-form-filled",
      operations: [{ type: "fillContentControl", locator: split.locator, text: "Filled split value" }],
      warnings: [],
    }, inspection)
    expect(splitValidation.ok).toBe(true)
    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/complex-form.docx",
      bytes,
      inspection,
      plan: splitValidation.plan!,
    })
    const outputBytes = await readFile(join(root, result.path))
    const outputXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(outputXml).toContain("Filled split value")
    expect(outputXml).not.toContain("{{SPL")

    const nestedValidation = validateDocumentEditPlan({
      planId: "fill-nested",
      targetPath: "docs/complex-form.docx",
      outputFilenameBase: "nested-filled",
      operations: [{ type: "fillContentControl", locator: nested.locator, text: "Should not fill" }],
      warnings: [],
    }, inspection)
    expect(nestedValidation.ok).toBe(false)
    expect(nestedValidation.errors.join("\n")).toContain("nested-content-control")
  })

  test("apply_word_document_edits can add inspect and remove VML text watermarks", async () => {
    const root = await tempDir("chipmate-word-watermark-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/watermark.docx", bytes })
    expect(inspection.summary.watermarkCount).toBe(0)

    const watermarked = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/watermark.docx",
      bytes,
      inspection,
      plan: {
        planId: "add-watermark",
        targetPath: "docs/watermark.docx",
        outputFilenameBase: "watermarked-doc",
        operations: [{ type: "addTextWatermark", locator: inspection.documentEndLocator, text: "CONFIDENTIAL" }],
        warnings: [],
      },
    })
    const watermarkedBytes = await readFile(join(root, watermarked.path))
    const watermarkedHeaderXml = await readDocxPart(watermarkedBytes, "word/header1.xml")
    const watermarkedInspection = await new WordDocumentInspector().inspect({ path: watermarked.path, bytes: watermarkedBytes })
    expect(watermarkedHeaderXml).toContain("<v:textpath")
    expect(watermarkedHeaderXml).toContain('string="CONFIDENTIAL"')
    expect(watermarkedInspection.summary.watermarkCount).toBe(1)
    expect(watermarkedInspection.watermarks[0]!.text).toBe("CONFIDENTIAL")
    expect(watermarked.appliedOperations[0]?.type).toBe("addTextWatermark")
    expect(watermarked.appliedOperations[0]?.detail).toContain("1 header part(s)")
    expect(watermarked.appliedOperations[0]?.detail).toContain("word/header1.xml")

    const cleaned = await new WordDocumentEditor(root).apply({
      sourcePath: watermarked.path,
      bytes: watermarkedBytes,
      inspection: watermarkedInspection,
      plan: {
        planId: "remove-watermark",
        targetPath: watermarked.path,
        outputFilenameBase: "watermark-removed-doc",
        operations: [{ type: "removeWatermark", locator: watermarkedInspection.watermarks[0]!.locator }],
        warnings: [],
      },
    })

    const cleanedBytes = await readFile(join(root, cleaned.path))
    const cleanedHeaderXml = await readDocxPart(cleanedBytes, "word/header1.xml")
    const cleanedInspection = await new WordDocumentInspector().inspect({ path: cleaned.path, bytes: cleanedBytes })
    expect(cleanedHeaderXml).not.toContain("<v:textpath")
    expect(cleanedHeaderXml).not.toContain("CONFIDENTIAL")
    expect(cleanedInspection.summary.watermarkCount).toBe(0)
    expect(cleaned.appliedOperations[0]?.type).toBe("removeWatermark")
    expect(cleaned.appliedOperations[0]?.detail).toContain("removed 1 watermark(s)")
    expect(cleaned.appliedOperations[0]?.detail).toContain("word/header1.xml")
    expect(cleaned.structureCheckResult.ok).toBe(true)
    expect(cleaned.renderCheckResult).toBeDefined()
    expect(Array.isArray(cleaned.renderCheckResult.issues)).toBe(true)
  }, 15_000)

  test("apply_word_document_edits audits multi-part VML watermarks across headers and footers", async () => {
    const root = await tempDir("chipmate-word-watermark-multipart-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    let bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    bytes = await writeDocxPart(bytes, "word/header2.xml", watermarkHeaderFixtureXml())
    bytes = await writeDocxPart(bytes, "word/footer1.xml", watermarkFooterFixtureXml("FOOTER ONLY"))
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/watermark-multipart.docx", bytes })
    expect(inspection.summary.watermarkCount).toBe(1)
    expect(inspection.watermarks[0]!.part).toBe("word/footer1.xml")

    const watermarked = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/watermark-multipart.docx",
      bytes,
      inspection,
      plan: {
        planId: "add-multipart-watermark",
        targetPath: "docs/watermark-multipart.docx",
        outputFilenameBase: "watermark-multipart-added",
        operations: [{ type: "addTextWatermark", locator: inspection.documentEndLocator, text: "MULTI HEADER" }],
        warnings: [],
      },
    })
    const watermarkedBytes = await readFile(join(root, watermarked.path))
    const header1Xml = await readDocxPart(watermarkedBytes, "word/header1.xml")
    const header2Xml = await readDocxPart(watermarkedBytes, "word/header2.xml")
    const footer1Xml = await readDocxPart(watermarkedBytes, "word/footer1.xml")
    const addedInspection = await new WordDocumentInspector().inspect({ path: watermarked.path, bytes: watermarkedBytes })
    expect(header1Xml).toContain('string="MULTI HEADER"')
    expect(header2Xml).toContain('string="MULTI HEADER"')
    expect(footer1Xml).toContain('string="FOOTER ONLY"')
    expect(addedInspection.watermarks.map((item) => `${item.part}:${item.text}`)).toContain("word/header1.xml:MULTI HEADER")
    expect(addedInspection.watermarks.map((item) => `${item.part}:${item.text}`)).toContain("word/header2.xml:MULTI HEADER")
    expect(addedInspection.watermarks.map((item) => `${item.part}:${item.text}`)).toContain("word/footer1.xml:FOOTER ONLY")
    expect(watermarked.appliedOperations[0]?.detail).toContain("2 header part(s)")
    expect(watermarked.appliedOperations[0]?.detail).toContain("word/header1.xml")
    expect(watermarked.appliedOperations[0]?.detail).toContain("word/header2.xml")

    const footerWatermark = addedInspection.watermarks.find((item) => item.part === "word/footer1.xml")!
    const cleaned = await new WordDocumentEditor(root).apply({
      sourcePath: watermarked.path,
      bytes: watermarkedBytes,
      inspection: addedInspection,
      plan: {
        planId: "remove-footer-watermark",
        targetPath: watermarked.path,
        outputFilenameBase: "watermark-footer-removed",
        operations: [{ type: "removeWatermark", locator: footerWatermark.locator }],
        warnings: [],
      },
    })
    const cleanedBytes = await readFile(join(root, cleaned.path))
    const cleanedFooterXml = await readDocxPart(cleanedBytes, "word/footer1.xml")
    const cleanedHeader1Xml = await readDocxPart(cleanedBytes, "word/header1.xml")
    const cleanedInspection = await new WordDocumentInspector().inspect({ path: cleaned.path, bytes: cleanedBytes })
    expect(cleanedFooterXml).not.toContain("FOOTER ONLY")
    expect(cleanedHeader1Xml).toContain("MULTI HEADER")
    expect(cleanedInspection.watermarks.some((item) => item.part === "word/footer1.xml")).toBe(false)
    expect(cleanedInspection.watermarks.filter((item) => item.text === "MULTI HEADER")).toHaveLength(2)
    expect(cleaned.appliedOperations[0]?.detail).toContain("removed 1 watermark(s)")
    expect(cleaned.appliedOperations[0]?.detail).toContain("word/footer1.xml")
    expect(cleaned.structureCheckResult.ok).toBe(true)
    expect(cleaned.renderCheckResult).toBeDefined()
    expect(Array.isArray(cleaned.renderCheckResult.issues)).toBe(true)
  }, 15_000)

  test("inspect_word_document reports and removes DrawingML and image-like background watermarks", async () => {
    const root = await tempDir("chipmate-word-advanced-background-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    let bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    bytes = await ensurePngDefaultContentTypeFixture(bytes)
    bytes = await writeDocxPart(bytes, "word/header3.xml", drawingBackgroundHeaderFixtureXml())
    bytes = await writeDocxPart(bytes, "word/_rels/header3.xml.rels", backgroundImageRelsFixtureXml("rIdDrawingBg", "media/image99.png"))
    bytes = await writeDocxPart(bytes, "word/footer2.xml", vmlImageBackgroundFooterFixtureXml())
    bytes = await writeDocxPart(bytes, "word/_rels/footer2.xml.rels", backgroundImageRelsFixtureXml("rIdVmlBg", "media/image98.png"))
    bytes = await writeDocxPart(bytes, "word/media/image99.png", tinyPngBytes())
    bytes = await writeDocxPart(bytes, "word/media/image98.png", tinyPngBytes())

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/backgrounds.docx", bytes })
    const drawingBackground = inspection.watermarks.find((item) => item.kind === "drawingImageBackground")
    const vmlImageBackground = inspection.watermarks.find((item) => item.kind === "vmlImageShape")
    expect(drawingBackground).toMatchObject({
      part: "word/header3.xml",
      relId: "rIdDrawingBg",
      relationshipMode: "embedded",
      mediaPath: "word/media/image99.png",
      mediaExists: true,
    })
    expect(vmlImageBackground).toMatchObject({
      part: "word/footer2.xml",
      relId: "rIdVmlBg",
      relationshipMode: "embedded",
      mediaPath: "word/media/image98.png",
      mediaExists: true,
    })
    expect(inspection.summary.watermarkCount).toBe(2)

    const cleaned = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/backgrounds.docx",
      bytes,
      inspection,
      plan: {
        planId: "remove-drawing-background",
        targetPath: "docs/backgrounds.docx",
        outputFilenameBase: "drawing-background-removed",
        operations: [{ type: "removeWatermark", locator: drawingBackground!.locator }],
        warnings: [],
      },
    })

    const cleanedBytes = await readFile(join(root, cleaned.path))
    const cleanedHeaderXml = await readDocxPart(cleanedBytes, "word/header3.xml")
    const cleanedFooterXml = await readDocxPart(cleanedBytes, "word/footer2.xml")
    const cleanedInspection = await new WordDocumentInspector().inspect({ path: cleaned.path, bytes: cleanedBytes })
    expect(cleanedHeaderXml).not.toContain("<w:drawing")
    expect(cleanedHeaderXml).not.toContain("rIdDrawingBg")
    expect(cleanedFooterXml).toContain("<v:imagedata")
    expect(cleanedFooterXml).toContain("rIdVmlBg")
    expect(cleanedInspection.watermarks.some((item) => item.kind === "drawingImageBackground")).toBe(false)
    expect(cleanedInspection.watermarks.some((item) => item.kind === "vmlImageShape")).toBe(true)
    expect(cleaned.appliedOperations[0]?.detail).toContain("removed 1 watermark(s)")
    expect(cleaned.appliedOperations[0]?.detail).toContain("word/header3.xml")
    expect(cleaned.structureCheckResult.ok).toBe(true)
  })

  test("make-docx-fixtures generates public DOCX regression fixtures", async () => {
    const root = await tempDir("chipmate-docx-fixtures-")
    const outDir = join(root, "fixtures")
    const result = spawnSync("bun", ["scripts/make-docx-fixtures.ts", "--out", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Generated 3 DOCX fixture(s)")

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")) as {
      fixtureVersion: number
      fixtures: Array<{ name: string; path: string; features: string[] }>
    }
    expect(manifest.fixtureVersion).toBe(1)
    expect(manifest.fixtures.map((item) => item.name)).toEqual([
      "watermark-multipart",
      "tracked-change-basic",
      "fields-captions-crossrefs",
    ])

    const watermarkBytes = await readFile(join(outDir, "watermark-multipart.docx"))
    const watermarkInspection = await new WordDocumentInspector().inspect({ path: "fixtures/watermark-multipart.docx", bytes: watermarkBytes })
    expect(watermarkInspection.summary.watermarkCount).toBe(3)
    expect(watermarkInspection.watermarks.map((item) => item.part).sort()).toEqual(["word/footer1.xml", "word/header1.xml", "word/header2.xml"])

    const trackedBytes = await readFile(join(outDir, "tracked-change-basic.docx"))
    const trackedXml = await readDocxPart(trackedBytes, "word/document.xml")
    expect(trackedXml).toContain("<w:del ")
    expect(trackedXml).toContain("<w:ins ")
    expect(trackedXml).toContain("Original tracked text.")
    expect(trackedXml).toContain("Revised tracked text.")

    const fieldBytes = await readFile(join(outDir, "fields-captions-crossrefs.docx"))
    const report = await auditWordDocumentFields({ path: "fixtures/fields-captions-crossrefs.docx", bytes: fieldBytes })
    expect(report.fieldTypeCounts.REF).toBe(1)
    expect(report.fieldTypeCounts.PAGEREF).toBe(1)
    expect(report.fieldTypeCounts.SEQ).toBe(2)
  })

  test("apply_word_document_edits writes a new docx and preserves paragraph/table properties", async () => {
    const root = await tempDir("chipmate-word-edit-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "可编辑 Word",
      sections: [{ heading: "旧章节标题", paragraphs: ["需要保留的正文。"] }],
      tableRows: [["状态", "旧值"], ["保持", "不变"]],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/edit.docx", bytes })
    const heading = inspection.paragraphs.find((item) => item.text === "旧章节标题")!
    const cell = inspection.locators.find((item) => item.kind === "tableCell" && item.tableIndex === 1 && item.rowIndex === 1 && item.cellIndex === 1)!
    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/edit.docx",
      bytes,
      inspection,
      plan: {
        planId: "apply",
        targetPath: "docs/edit.docx",
        outputFilenameBase: "edited-doc",
        operations: [
          { type: "replaceParagraph", locator: heading.locator, text: "新章节标题" },
          { type: "updateTable", locator: cell, text: "新值" },
        ],
        warnings: [],
      },
    })

    expect(result.path).toMatch(/^\.chipmate\/docs\/edited-doc-.+\.docx$/)
    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const stylesXml = await readDocxPart(outputBytes, "word/styles.xml")
    expect(documentXml).toContain("新章节标题")
    expect(documentXml).not.toContain("旧章节标题")
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"/>')
    expect(documentXml).toContain("新值")
    expect(documentXml).toContain("不变")
    expect(stylesXml).toContain('w:styleId="TOCStatic"')
    expect(stylesXml).toContain('w:styleId="TableGrid"')
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can add paragraph comments with OOXML anchors", async () => {
    const root = await tempDir("chipmate-word-comment-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "批注文档",
      sections: [{ heading: "现有章节", paragraphs: ["这段需要批注。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/comment.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "这段需要批注。")!
    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/comment.docx",
      bytes,
      inspection,
      plan: {
        planId: "comment",
        targetPath: "docs/comment.docx",
        outputFilenameBase: "commented-doc",
        operations: [
          { type: "addComment", locator: paragraph.locator, text: "请确认这里的表述是否准确。\n第二段说明 <risk> & owner。", author: "Reviewer", initials: "RV" },
        ],
        warnings: [],
      },
    })

    const outputBytes = await readFile(join(root, result.path))
    const parts = await docxPartPaths(outputBytes)
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const commentsXml = await readDocxPart(outputBytes, "word/comments.xml")

    expect(parts).toContain("word/comments.xml")
    expect(contentTypesXml).toContain('PartName="/word/comments.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"')
    expect(documentXml).toContain('<w:commentRangeStart w:id="0"/>')
    expect(documentXml).toContain('<w:commentRangeEnd w:id="0"/>')
    expect(documentXml).toContain('<w:commentReference w:id="0"/>')
    expect(commentsXml).toContain('w:author="Reviewer"')
    expect(commentsXml).toContain("请确认这里的表述是否准确。")
    expect(commentsXml).toContain("第二段说明 &lt;risk&gt; &amp; owner。")
    expect(commentsXml.match(/<w:p>/g)?.length).toBe(2)
    expect(result.appliedOperations[0]?.type).toBe("addComment")

    const commentedInspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(commentedInspection.summary.commentCount).toBe(1)
    expect(commentedInspection.comments[0]).toMatchObject({
      commentId: "0",
      text: "请确认这里的表述是否准确。\n第二段说明 <risk> & owner。",
      author: "Reviewer",
      resolved: false,
    })
    expect(commentedInspection.comments[0]?.anchorText).toContain("这段需要批注。")
  })

  test("apply_word_document_edits can update existing comment text from an inspect locator", async () => {
    const root = await tempDir("chipmate-word-comment-update-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "批注更新文档",
      sections: [{ heading: "现有章节", paragraphs: ["这段批注正文会被更新。"] }],
    })
    const initialInspection = await new WordDocumentInspector().inspect({ path: "docs/comment-update.docx", bytes })
    const paragraph = initialInspection.paragraphs.find((item) => item.text === "这段批注正文会被更新。")!
    const commented = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/comment-update.docx",
      bytes,
      inspection: initialInspection,
      plan: {
        planId: "comment-add-before-update",
        targetPath: "docs/comment-update.docx",
        outputFilenameBase: "comment-update-source",
        operations: [
          { type: "addComment", locator: paragraph.locator, text: "原始批注意见。", author: "Reviewer", initials: "RV" },
        ],
        warnings: [],
      },
    })
    const commentedBytes = await readFile(join(root, commented.path))
    const commentedInspection = await new WordDocumentInspector().inspect({ path: commented.path, bytes: commentedBytes })
    const comment = commentedInspection.comments[0]!
    const validation = validateDocumentEditPlan({
      planId: "comment-update",
      targetPath: commented.path,
      outputFilenameBase: "comment-updated-doc",
      operations: [
        { type: "updateCommentText", locator: comment.locator, text: "Updated comment <risk> & owner.\nSecond paragraph requires sign-off." },
      ],
      warnings: [],
    }, commentedInspection)
    expect(validation.ok).toBe(true)

    const updated = await new WordDocumentEditor(root).apply({
      sourcePath: commented.path,
      bytes: commentedBytes,
      inspection: commentedInspection,
      plan: validation.plan!,
    })

    const updatedBytes = await readFile(join(root, updated.path))
    const documentXml = await readDocxPart(updatedBytes, "word/document.xml")
    const commentsXml = await readDocxPart(updatedBytes, "word/comments.xml")
    const updatedInspection = await new WordDocumentInspector().inspect({ path: updated.path, bytes: updatedBytes })
    expect(documentXml).toContain(`<w:commentRangeStart w:id="${comment.commentId}"/>`)
    expect(documentXml).toContain(`<w:commentRangeEnd w:id="${comment.commentId}"/>`)
    expect(documentXml).toContain(`<w:commentReference w:id="${comment.commentId}"/>`)
    expect(commentsXml).toContain(`w:id="${comment.commentId}"`)
    expect(commentsXml).toContain("Updated comment &lt;risk&gt; &amp; owner.")
    expect(commentsXml).toContain("Second paragraph requires sign-off.")
    expect(commentsXml.match(/<w:p>/g)?.length).toBe(2)
    expect(commentsXml).not.toContain("原始批注意见。")
    expect(updatedInspection.comments[0]?.text).toBe("Updated comment <risk> & owner.\nSecond paragraph requires sign-off.")
    expect(updatedInspection.comments[0]?.author).toBe("Reviewer")
    expect(updatedInspection.comments[0]?.anchorText).toContain("这段批注正文会被更新。")
    expect(updated.appliedOperations[0]?.type).toBe("updateCommentText")
    expect(updated.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can resolve existing comments", async () => {
    const root = await tempDir("chipmate-word-comment-resolve-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "批注处理文档",
      sections: [{ heading: "现有章节", paragraphs: ["这段有待处理批注。"] }],
    })
    const initialInspection = await new WordDocumentInspector().inspect({ path: "docs/comment-resolve.docx", bytes })
    const paragraph = initialInspection.paragraphs.find((item) => item.text === "这段有待处理批注。")!
    const commented = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/comment-resolve.docx",
      bytes,
      inspection: initialInspection,
      plan: {
        planId: "comment-add",
        targetPath: "docs/comment-resolve.docx",
        outputFilenameBase: "comment-resolve-doc",
        operations: [
          { type: "addComment", locator: paragraph.locator, text: "这条意见已经处理。", author: "Reviewer", initials: "RV" },
        ],
        warnings: [],
      },
    })
    const commentedBytes = await addCommentMetadataParts(await readFile(join(root, commented.path)), [
      { commentId: "0", paraId: "10000000", durableId: "durable-root" },
    ])
    const commentedInspection = await new WordDocumentInspector().inspect({ path: commented.path, bytes: commentedBytes })
    const comment = commentedInspection.comments[0]!
    expect(comment.paraId).toBe("10000000")
    expect(comment.durableId).toBe("durable-root")
    expect(comment.resolvedSource).toBe("none")

    const resolved = await new WordDocumentEditor(root).apply({
      sourcePath: commented.path,
      bytes: commentedBytes,
      inspection: commentedInspection,
      plan: {
        planId: "comment-resolve",
        targetPath: commented.path,
        outputFilenameBase: "comment-resolved-doc",
        operations: [
          { type: "setCommentResolved", locator: comment.locator, resolved: true },
        ],
        warnings: [],
      },
    })

    const resolvedBytes = await readFile(join(root, resolved.path))
    const commentsXml = await readDocxPart(resolvedBytes, "word/comments.xml")
    const commentsExtendedXml = await readDocxPart(resolvedBytes, "word/commentsExtended.xml")
    const resolvedInspection = await new WordDocumentInspector().inspect({ path: resolved.path, bytes: resolvedBytes })
    expect(commentsXml).toContain('w:done="1"')
    expect(commentsExtendedXml).toContain('w15:done="1"')
    expect(resolvedInspection.comments[0]?.resolved).toBe(true)
    expect(resolvedInspection.comments[0]?.resolvedSource).toBe("both")
    expect(resolvedInspection.comments[0]?.commentsExtendedDone).toBe(true)
    expect(resolved.appliedOperations[0]?.type).toBe("setCommentResolved")
  })

  test("inspect_word_document reports commentsExtended thread metadata", async () => {
    const root = await tempDir("chipmate-word-comment-thread-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "批注线程文档",
      sections: [{ heading: "现有章节", paragraphs: ["根批注段落。", "回复批注段落。"] }],
    })
    const initialInspection = await new WordDocumentInspector().inspect({ path: "docs/comment-thread.docx", bytes })
    const rootParagraph = initialInspection.paragraphs.find((item) => item.text === "根批注段落。")!
    const replyParagraph = initialInspection.paragraphs.find((item) => item.text === "回复批注段落。")!
    const commented = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/comment-thread.docx",
      bytes,
      inspection: initialInspection,
      plan: {
        planId: "comment-thread-add",
        targetPath: "docs/comment-thread.docx",
        outputFilenameBase: "comment-thread-source",
        operations: [
          { type: "addComment", locator: rootParagraph.locator, text: "Root review thread.", author: "Reviewer", initials: "RV" },
          { type: "addComment", locator: replyParagraph.locator, text: "Reply review item.", author: "Reviewer", initials: "RV" },
        ],
        warnings: [],
      },
    })
    const threadedBytes = await addCommentMetadataParts(await readFile(join(root, commented.path)), [
      { commentId: "0", paraId: "11111111", durableId: "durable-root" },
      { commentId: "1", paraId: "22222222", parentParaId: "11111111", durableId: "durable-reply", done: true },
    ])

    const inspection = await new WordDocumentInspector().inspect({ path: commented.path, bytes: threadedBytes })
    const rootComment = inspection.comments.find((comment) => comment.commentId === "0")!
    const replyComment = inspection.comments.find((comment) => comment.commentId === "1")!
    expect(rootComment.paraId).toBe("11111111")
    expect(rootComment.durableId).toBe("durable-root")
    expect(rootComment.resolved).toBe(false)
    expect(rootComment.resolvedSource).toBe("none")
    expect(replyComment.paraId).toBe("22222222")
    expect(replyComment.parentParaId).toBe("11111111")
    expect(replyComment.parentCommentId).toBe("0")
    expect(replyComment.durableId).toBe("durable-reply")
    expect(replyComment.commentsExtendedDone).toBe(true)
    expect(replyComment.resolved).toBe(true)
    expect(replyComment.resolvedSource).toBe("commentsExtended")
  })

  test("apply_word_document_edits can strip all comments for a clean copy", async () => {
    const root = await tempDir("chipmate-word-comment-strip-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "批注清理文档",
      sections: [{ heading: "现有章节", paragraphs: ["这段批注将被清理。"] }],
    })
    const initialInspection = await new WordDocumentInspector().inspect({ path: "docs/comment-strip.docx", bytes })
    const paragraph = initialInspection.paragraphs.find((item) => item.text === "这段批注将被清理。")!
    const commented = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/comment-strip.docx",
      bytes,
      inspection: initialInspection,
      plan: {
        planId: "comment-strip-add",
        targetPath: "docs/comment-strip.docx",
        outputFilenameBase: "comment-strip-source",
        operations: [
          { type: "addComment", locator: paragraph.locator, text: "最终版需要删除此批注。", author: "Reviewer", initials: "RV" },
        ],
        warnings: [],
      },
    })
    const commentedBytes = await addCommentMetadataParts(await readFile(join(root, commented.path)), [
      { commentId: "0", paraId: "30000000", durableId: "durable-strip", done: true },
    ])
    const commentedInspection = await new WordDocumentInspector().inspect({ path: commented.path, bytes: commentedBytes })
    expect(commentedInspection.summary.commentCount).toBe(1)

    const stripped = await new WordDocumentEditor(root).apply({
      sourcePath: commented.path,
      bytes: commentedBytes,
      inspection: commentedInspection,
      plan: {
        planId: "comment-strip",
        targetPath: commented.path,
        outputFilenameBase: "comment-stripped-doc",
        operations: [
          { type: "removeAllComments", locator: commentedInspection.documentEndLocator },
        ],
        warnings: [],
      },
    })

    const strippedBytes = await readFile(join(root, stripped.path))
    const parts = await docxPartPaths(strippedBytes)
    const contentTypesXml = await readDocxPart(strippedBytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(strippedBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(strippedBytes, "word/_rels/document.xml.rels")
    const strippedInspection = await new WordDocumentInspector().inspect({ path: stripped.path, bytes: strippedBytes })

    expect(parts).not.toContain("word/comments.xml")
    expect(parts).not.toContain("word/commentsExtended.xml")
    expect(parts).not.toContain("word/commentsIds.xml")
    expect(contentTypesXml).not.toContain("comments+xml")
    expect(contentTypesXml).not.toContain("commentsIds")
    expect(documentRelsXml).not.toContain("/relationships/comments")
    expect(documentRelsXml).not.toContain("commentsIds")
    expect(documentXml).not.toContain("commentRangeStart")
    expect(documentXml).not.toContain("commentRangeEnd")
    expect(documentXml).not.toContain("commentReference")
    expect(strippedInspection.summary.commentCount).toBe(0)
    expect(stripped.appliedOperations[0]?.type).toBe("removeAllComments")
  })

  test("apply_word_document_edits can replace a paragraph with tracked changes", async () => {
    const root = await tempDir("chipmate-word-redline-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "红线文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧版描述需要修订。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/redline.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧版描述需要修订。")!
    const validation = validateDocumentEditPlan({
      planId: "redline",
      targetPath: "docs/redline.docx",
      operations: [
        { type: "replaceParagraphWithTrackedChange", locator: paragraph.locator, text: "新版描述保留为可审阅修订。", author: "Reviewer" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/redline.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const settingsXml = await readDocxPart(outputBytes, "word/settings.xml")

    expect(contentTypesXml).toContain('PartName="/word/settings.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"')
    expect(settingsXml).toContain("<w:trackRevisions/>")
    expect(documentXml).toContain('<w:del w:id="0"')
    expect(documentXml).toContain('<w:delText xml:space="preserve">旧版描述需要修订。</w:delText>')
    expect(documentXml).toContain('<w:ins w:id="1"')
    expect(documentXml).toContain('<w:t xml:space="preserve">新版描述保留为可审阅修订。</w:t>')
    expect(documentXml).toContain('w:author="Reviewer"')
    expect(result.appliedOperations[0]?.type).toBe("replaceParagraphWithTrackedChange")
  })

  test("apply_word_document_edits can replace a paragraph with rich tracked changes", async () => {
    const root = await tempDir("chipmate-word-rich-redline-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "富文本红线文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧版富文本段落需要修订。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/rich-redline.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧版富文本段落需要修订。")!
    const validation = validateDocumentEditPlan({
      planId: "rich-redline",
      targetPath: "docs/rich-redline.docx",
      outputFilenameBase: "rich-redline-source",
      operations: [
        {
          type: "replaceParagraphWithRichTrackedChange",
          locator: paragraph.locator,
          author: "Reviewer",
          paragraph: {
            runs: [
              { text: "新版 " },
              { text: "重点", bold: true },
              { text: " 内容参见 " },
              { text: "规范链接", hyperlink: { url: "https://example.com/rich-redline", tooltip: "富文本红线链接" } },
              { note: { kind: "footnote", text: "富文本红线脚注。" } },
            ],
          },
        },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/rich-redline.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const redlinedBytes = await readFile(join(root, redlined.path))
    const documentXml = await readDocxPart(redlinedBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(redlinedBytes, "word/_rels/document.xml.rels")
    const contentTypesXml = await readDocxPart(redlinedBytes, "[Content_Types].xml")
    const footnotesXml = await readDocxPart(redlinedBytes, "word/footnotes.xml")
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })
    expect(redlined.appliedOperations[0]?.type).toBe("replaceParagraphWithRichTrackedChange")
    expect(redlined.structureCheckResult.ok).toBe(true)
    expect(redlinedInspection.summary.trackedChangeCount).toBeGreaterThan(0)
    expect(documentXml).toContain('<w:del w:id="0"')
    expect(documentXml).toContain('<w:delText xml:space="preserve">旧版富文本段落需要修订。</w:delText>')
    expect(documentXml).toContain('<w:ins w:id="1"')
    expect(documentXml).toContain("<w:b/>")
    expect(documentXml).toContain('<w:hyperlink r:id="rIdChipMateHyperlink1" w:tooltip="富文本红线链接">')
    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>')
    expect(documentRelsXml).toContain('Target="https://example.com/rich-redline" TargetMode="External"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"')
    expect(contentTypesXml).toContain('PartName="/word/footnotes.xml"')
    expect(footnotesXml).toContain("富文本红线脚注。")

    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "rich-redline-accept",
        targetPath: redlined.path,
        outputFilenameBase: "rich-redline-accepted",
        operations: [{ type: "acceptAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
        warnings: [],
      },
    })
    const acceptedBytes = await readFile(join(root, accepted.path))
    const acceptedXml = await readDocxPart(acceptedBytes, "word/document.xml")
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    expect(acceptedInspection.summary.trackedChangeCount).toBe(0)
    expect(acceptedXml).not.toContain("<w:ins ")
    expect(acceptedXml).not.toContain("<w:del ")
    expect(acceptedXml).toContain("<w:b/>")
    expect(acceptedXml).toContain('<w:hyperlink r:id="rIdChipMateHyperlink1" w:tooltip="富文本红线链接">')
    expect(acceptedXml).toContain('<w:footnoteReference w:id="1"/>')
    expect(acceptedXml).not.toContain("旧版富文本段落需要修订。")
  })

  test("apply_word_document_edits can replace paragraph-local text with tracked changes", async () => {
    const root = await tempDir("chipmate-word-inline-redline-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "段内红线文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧版描述需要局部修订。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/inline-redline.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧版描述需要局部修订。")!
    const validation = validateDocumentEditPlan({
      planId: "inline-redline",
      targetPath: "docs/inline-redline.docx",
      outputFilenameBase: "inline-redline-source",
      operations: [
        { type: "replaceTextWithTrackedChange", locator: paragraph.locator, oldText: "局部", newText: "精准", author: "Reviewer" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/inline-redline.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const redlinedBytes = await readFile(join(root, redlined.path))
    const redlinedXml = await readDocxPart(redlinedBytes, "word/document.xml")
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })
    expect(redlinedXml).toContain("旧版描述需要")
    expect(redlinedXml).toContain('<w:del w:id="0"')
    expect(redlinedXml).toContain('<w:delText xml:space="preserve">局部</w:delText>')
    expect(redlinedXml).toContain('<w:ins w:id="1"')
    expect(redlinedXml).toContain('<w:t xml:space="preserve">精准</w:t>')
    expect(redlinedXml).toContain("修订。")
    expect(redlinedXml).toContain('w:author="Reviewer"')
    expect(redlined.appliedOperations[0]?.type).toBe("replaceTextWithTrackedChange")
    expect(redlinedInspection.summary.trackedChangeCount).toBeGreaterThan(0)

    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "inline-redline-accept",
        targetPath: redlined.path,
        outputFilenameBase: "inline-redline-accepted",
        operations: [{ type: "acceptAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
        warnings: [],
      },
    })
    const acceptedBytes = await readFile(join(root, accepted.path))
    const acceptedXml = await readDocxPart(acceptedBytes, "word/document.xml")
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    expect(acceptedInspection.paragraphs.some((item) => item.text === "旧版描述需要精准修订。")).toBe(true)
    expect(acceptedXml).not.toContain("<w:del")
    expect(acceptedXml).not.toContain("<w:ins")

    const rejected = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "inline-redline-reject",
        targetPath: redlined.path,
        outputFilenameBase: "inline-redline-rejected",
        operations: [{ type: "rejectAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
        warnings: [],
      },
    })
    const rejectedBytes = await readFile(join(root, rejected.path))
    const rejectedXml = await readDocxPart(rejectedBytes, "word/document.xml")
    const rejectedInspection = await new WordDocumentInspector().inspect({ path: rejected.path, bytes: rejectedBytes })
    expect(rejectedInspection.paragraphs.some((item) => item.text === "旧版描述需要局部修订。")).toBe(true)
    expect(rejectedInspection.paragraphs.some((item) => item.text.includes("精准"))).toBe(false)
    expect(rejectedXml).not.toContain("<w:del")
    expect(rejectedXml).not.toContain("<w:ins")
  })

  test("apply_word_document_edits can replace text spanning split runs with tracked changes", async () => {
    const root = await tempDir("chipmate-word-split-run-redline-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    let bytes = cGuidelineDocxFixture({
      title: "跨 run 红线文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧版描述需要局部修订。"] }],
    })
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace(
      "<w:t>旧版描述需要局部修订。</w:t>",
      "<w:t>旧版描述需要局</w:t></w:r><w:r><w:t>部修订。</w:t>",
    ))
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/split-run-redline.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧版描述需要局部修订。")!
    const validation = validateDocumentEditPlan({
      planId: "split-run-redline",
      targetPath: "docs/split-run-redline.docx",
      outputFilenameBase: "split-run-redline-source",
      operations: [
        { type: "replaceTextWithTrackedChange", locator: paragraph.locator, oldText: "局部", newText: "精准", author: "Reviewer" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/split-run-redline.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const redlinedBytes = await readFile(join(root, redlined.path))
    const redlinedXml = await readDocxPart(redlinedBytes, "word/document.xml")
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })
    expect(redlinedInspection.summary.trackedChangeTypeCounts.del).toBe(1)
    expect(redlinedInspection.summary.trackedChangeTypeCounts.ins).toBe(1)
    expect(redlinedXml).toContain('<w:delText xml:space="preserve">局部</w:delText>')
    expect(redlinedXml).toContain('<w:t xml:space="preserve">精准</w:t>')

    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "split-run-redline-accept",
        targetPath: redlined.path,
        outputFilenameBase: "split-run-redline-accepted",
        operations: [{ type: "acceptAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
        warnings: [],
      },
    })
    const acceptedBytes = await readFile(join(root, accepted.path))
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    expect(acceptedInspection.summary.trackedChangeCount).toBe(0)
    expect(acceptedInspection.paragraphs.some((item) => item.text === "旧版描述需要精准修订。")).toBe(true)
  })

  test("inspect_word_document reports move revisions and accept reject handles them", async () => {
    const root = await tempDir("chipmate-word-move-revisions-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    let bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace(
      "</w:body>",
      '<w:p><w:moveFrom w:id="10" w:author="Reviewer" w:date="2026-06-28T00:00:00Z"><w:r><w:delText xml:space="preserve">Moved from here.</w:delText></w:r></w:moveFrom><w:moveTo w:id="11" w:author="Reviewer" w:date="2026-06-28T00:00:00Z"><w:r><w:t xml:space="preserve">Moved to here.</w:t></w:r></w:moveTo></w:p></w:body>',
    ))
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/move-revisions.docx", bytes })
    expect(inspection.summary.trackedChangeTypeCounts.moveFrom).toBe(1)
    expect(inspection.summary.trackedChangeTypeCounts.moveTo).toBe(1)
    expect(inspection.summary.advancedTrackedChangeWarnings.some((warning) => warning.includes("Tracked move revisions"))).toBe(true)

    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/move-revisions.docx",
      bytes,
      inspection,
      plan: {
        planId: "accept-move",
        targetPath: "docs/move-revisions.docx",
        outputFilenameBase: "move-accepted",
        operations: [{ type: "acceptAllTrackedChanges", locator: inspection.documentEndLocator }],
        warnings: [],
      },
    })
    const acceptedBytes = await readFile(join(root, accepted.path))
    const acceptedXml = await readDocxPart(acceptedBytes, "word/document.xml")
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    expect(acceptedInspection.summary.trackedChangeCount).toBe(0)
    expect(acceptedXml).toContain("Moved to here.")
    expect(acceptedXml).not.toContain("Moved from here.")
    expect(acceptedXml).not.toContain("<w:move")

    const rejected = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/move-revisions.docx",
      bytes,
      inspection,
      plan: {
        planId: "reject-move",
        targetPath: "docs/move-revisions.docx",
        outputFilenameBase: "move-rejected",
        operations: [{ type: "rejectAllTrackedChanges", locator: inspection.documentEndLocator }],
        warnings: [],
      },
    })
    const rejectedBytes = await readFile(join(root, rejected.path))
    const rejectedXml = await readDocxPart(rejectedBytes, "word/document.xml")
    const rejectedInspection = await new WordDocumentInspector().inspect({ path: rejected.path, bytes: rejectedBytes })
    expect(rejectedInspection.summary.trackedChangeCount).toBe(0)
    expect(rejectedXml).toContain("Moved from here.")
    expect(rejectedXml).not.toContain("Moved to here.")
    expect(rejectedXml).not.toContain("<w:move")
  }, 15_000)

  test("inspect_word_document reports formatting revisions and clean copy validation fails closed", async () => {
    let bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace(
      "</w:body>",
      '<w:p><w:r><w:rPr><w:rPrChange w:id="21" w:author="Reviewer" w:date="2026-06-28T00:00:00Z"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>Formatting revision text.</w:t></w:r></w:p></w:body>',
    ))
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/format-revision.docx", bytes })
    expect(inspection.summary.trackedChangeTypeCounts.rPrChange).toBe(1)
    expect(inspection.summary.trackedChangeCount).toBeGreaterThan(0)
    expect(inspection.warnings.some((warning) => warning.includes("Tracked formatting revisions"))).toBe(true)
    const validation = validateDocumentEditPlan({
      planId: "accept-format-revision",
      targetPath: "docs/format-revision.docx",
      outputFilenameBase: "format-revision-accepted",
      operations: [{ type: "acceptAllTrackedChanges", locator: inspection.documentEndLocator }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(false)
    expect(validation.errors.join("\n")).toContain("rPrChange")
  })

  test("apply_word_document_edits can update a table cell with tracked changes", async () => {
    const root = await tempDir("chipmate-word-table-redline-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "table-redline"
    spec.sections = [{
      id: "table",
      level: 1,
      title: "Table Redline",
      tables: [{
        headers: ["Field", "Value"],
        rows: [["Status", "Draft"]],
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/table-redline.docx", bytes })
    const targetTable = inspection.tables.find((table) => table.rows.some((row) => row.includes("Draft")))!
    const statusCell = inspection.locators.find((locator) => locator.kind === "tableCell" && locator.tableIndex === targetTable.tableIndex && locator.rowIndex === 1 && locator.cellIndex === 1)!
    const validation = validateDocumentEditPlan({
      planId: "table-cell-redline",
      targetPath: "docs/table-redline.docx",
      outputFilenameBase: "table-cell-redlined",
      operations: [
        { type: "updateTableWithTrackedChange", locator: statusCell, text: "Final", author: "Reviewer" },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/table-redline.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const redlinedBytes = await readFile(join(root, redlined.path))
    const redlinedXml = await readDocxPart(redlinedBytes, "word/document.xml")
    const settingsXml = await readDocxPart(redlinedBytes, "word/settings.xml")
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })
    expect(settingsXml).toContain("<w:trackRevisions/>")
    expect(redlinedXml).toContain('<w:del w:id="0"')
    expect(redlinedXml).toContain('<w:delText xml:space="preserve">Draft</w:delText>')
    expect(redlinedXml).toContain('<w:ins w:id="1"')
    expect(redlinedXml).toContain('<w:t xml:space="preserve">Final</w:t>')
    expect(redlinedXml).toContain('w:author="Reviewer"')
    expect(redlinedInspection.summary.trackedChangeCount).toBeGreaterThan(0)
    expect(redlined.appliedOperations[0]?.type).toBe("updateTableWithTrackedChange")

    const acceptValidation = validateDocumentEditPlan({
      planId: "accept-table-cell-redline",
      targetPath: redlined.path,
      outputFilenameBase: "table-cell-redline-accepted",
      operations: [{ type: "acceptAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
      warnings: [],
    }, redlinedInspection)
    expect(acceptValidation.ok).toBe(true)
    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: acceptValidation.plan!,
    })
    const acceptedBytes = await readFile(join(root, accepted.path))
    const acceptedXml = await readDocxPart(acceptedBytes, "word/document.xml")
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    const acceptedTable = acceptedInspection.tables.find((table) => table.rows.some((row) => row.includes("Status")))!
    expect(acceptedXml).not.toContain("<w:del")
    expect(acceptedXml).not.toContain("<w:ins ")
    expect(acceptedTable.rows.flat()).toContain("Final")
    expect(acceptedTable.rows.flat()).not.toContain("Draft")

    const rejectValidation = validateDocumentEditPlan({
      planId: "reject-table-cell-redline",
      targetPath: redlined.path,
      outputFilenameBase: "table-cell-redline-rejected",
      operations: [{ type: "rejectAllTrackedChanges", locator: redlinedInspection.documentEndLocator }],
      warnings: [],
    }, redlinedInspection)
    expect(rejectValidation.ok).toBe(true)
    const rejected = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: rejectValidation.plan!,
    })
    const rejectedBytes = await readFile(join(root, rejected.path))
    const rejectedXml = await readDocxPart(rejectedBytes, "word/document.xml")
    const rejectedInspection = await new WordDocumentInspector().inspect({ path: rejected.path, bytes: rejectedBytes })
    const rejectedTable = rejectedInspection.tables.find((table) => table.rows.some((row) => row.includes("Status")))!
    expect(rejectedXml).not.toContain("<w:del")
    expect(rejectedXml).not.toContain("<w:ins ")
    expect(rejectedTable.rows.flat()).toContain("Draft")
    expect(rejectedTable.rows.flat()).not.toContain("Final")
  }, 15_000)

  test("apply_word_document_edits can accept all tracked changes into a clean copy", async () => {
    const root = await tempDir("chipmate-word-redline-accept-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "接受修订文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧内容等待接受修订。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/redline-accept.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧内容等待接受修订。")!
    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/redline-accept.docx",
      bytes,
      inspection,
      plan: {
        planId: "redline-accept-source",
        targetPath: "docs/redline-accept.docx",
        outputFilenameBase: "redline-accept-source",
        operations: [
          { type: "replaceParagraphWithTrackedChange", locator: paragraph.locator, text: "新内容作为接受后的正文。", author: "Reviewer" },
        ],
        warnings: [],
      },
    })
    const redlinedBytes = await readFile(join(root, redlined.path))
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })
    expect(redlinedInspection.summary.trackedChangeCount).toBeGreaterThan(0)

    const accepted = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "redline-accept",
        targetPath: redlined.path,
        outputFilenameBase: "redline-accepted-doc",
        operations: [
          { type: "acceptAllTrackedChanges", locator: redlinedInspection.documentEndLocator },
        ],
        warnings: [],
      },
    })

    const acceptedBytes = await readFile(join(root, accepted.path))
    const documentXml = await readDocxPart(acceptedBytes, "word/document.xml")
    const settingsXml = await readDocxPart(acceptedBytes, "word/settings.xml")
    const acceptedInspection = await new WordDocumentInspector().inspect({ path: accepted.path, bytes: acceptedBytes })
    expect(documentXml).not.toContain("<w:del")
    expect(documentXml).not.toContain("<w:ins")
    expect(documentXml).not.toContain("旧内容等待接受修订。")
    expect(documentXml).toContain("新内容作为接受后的正文。")
    expect(settingsXml).not.toContain("trackRevisions")
    expect(acceptedInspection.summary.trackedChangeCount).toBe(0)
    expect(accepted.appliedOperations[0]?.type).toBe("acceptAllTrackedChanges")
  })

  test("apply_word_document_edits can reject all tracked changes into a clean copy", async () => {
    const root = await tempDir("chipmate-word-redline-reject-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "拒绝修订文档",
      sections: [{ heading: "现有章节", paragraphs: ["旧内容等待拒绝修订。"] }],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/redline-reject.docx", bytes })
    const paragraph = inspection.paragraphs.find((item) => item.text === "旧内容等待拒绝修订。")!
    const redlined = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/redline-reject.docx",
      bytes,
      inspection,
      plan: {
        planId: "redline-reject-source",
        targetPath: "docs/redline-reject.docx",
        outputFilenameBase: "redline-reject-source",
        operations: [
          { type: "replaceParagraphWithTrackedChange", locator: paragraph.locator, text: "新内容应在拒绝后消失。", author: "Reviewer" },
        ],
        warnings: [],
      },
    })
    const redlinedBytes = await readFile(join(root, redlined.path))
    const redlinedInspection = await new WordDocumentInspector().inspect({ path: redlined.path, bytes: redlinedBytes })

    const rejected = await new WordDocumentEditor(root).apply({
      sourcePath: redlined.path,
      bytes: redlinedBytes,
      inspection: redlinedInspection,
      plan: {
        planId: "redline-reject",
        targetPath: redlined.path,
        outputFilenameBase: "redline-rejected-doc",
        operations: [
          { type: "rejectAllTrackedChanges", locator: redlinedInspection.documentEndLocator },
        ],
        warnings: [],
      },
    })

    const rejectedBytes = await readFile(join(root, rejected.path))
    const documentXml = await readDocxPart(rejectedBytes, "word/document.xml")
    const settingsXml = await readDocxPart(rejectedBytes, "word/settings.xml")
    const rejectedInspection = await new WordDocumentInspector().inspect({ path: rejected.path, bytes: rejectedBytes })
    expect(documentXml).not.toContain("<w:del")
    expect(documentXml).not.toContain("<w:ins")
    expect(documentXml).toContain("旧内容等待拒绝修订。")
    expect(documentXml).not.toContain("新内容应在拒绝后消失。")
    expect(settingsXml).not.toContain("trackRevisions")
    expect(rejectedInspection.summary.trackedChangeCount).toBe(0)
    expect(rejected.appliedOperations[0]?.type).toBe("rejectAllTrackedChanges")
  })

  test("apply_word_document_edits can scrub personal metadata and rsid attributes", async () => {
    const root = await tempDir("chipmate-word-privacy-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    let bytes = cGuidelineDocxFixture({
      title: "隐私清理文档",
      sections: [{ heading: "现有章节", paragraphs: ["正文内容必须保留。"] }],
    })
    bytes = await writeDocxPart(bytes, "docProps/core.xml", [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      "<dc:title>隐私清理文档</dc:title>",
      "<dc:creator>Alice Reviewer</dc:creator>",
      "<cp:lastModifiedBy>Bob Editor</cp:lastModifiedBy>",
      "</cp:coreProperties>",
    ].join(""))
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace("<w:p>", '<w:p w:rsidR="00ABCDEF" w:rsidRDefault="00ABCDEF" w:rsidP="00ABCDEF">'))
    bytes = await replaceDocxPart(bytes, "[Content_Types].xml", (xml) => xml.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'))
    bytes = await replaceDocxPart(bytes, "_rels/.rels", (xml) => xml.replace("</Relationships>", '<Relationship Id="rIdCustomProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'))
    bytes = await writeDocxPart(bytes, "docProps/custom.xml", [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">',
      '<property name="InternalReviewer"><vt:lpwstr xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">Alice</vt:lpwstr></property>',
      "</Properties>",
    ].join(""))
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/privacy.docx", bytes })

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/privacy.docx",
      bytes,
      inspection,
      plan: {
        planId: "privacy-scrub",
        targetPath: "docs/privacy.docx",
        outputFilenameBase: "privacy-scrubbed-doc",
        operations: [
          { type: "scrubDocumentMetadata", locator: inspection.documentEndLocator },
        ],
        warnings: [],
      },
    })

    const outputBytes = await readFile(join(root, result.path))
    const parts = await docxPartPaths(outputBytes)
    const coreXml = await readDocxPart(outputBytes, "docProps/core.xml")
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const packageRelsXml = await readDocxPart(outputBytes, "_rels/.rels")
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")

    expect(coreXml).toContain("<dc:creator></dc:creator>")
    expect(coreXml).toContain("<cp:lastModifiedBy></cp:lastModifiedBy>")
    expect(coreXml).not.toContain("Alice Reviewer")
    expect(coreXml).not.toContain("Bob Editor")
    expect(parts).not.toContain("docProps/custom.xml")
    expect(contentTypesXml).not.toContain("/docProps/custom.xml")
    expect(packageRelsXml).not.toContain("docProps/custom.xml")
    expect(documentXml).not.toContain("w:rsid")
    expect(documentXml).toContain("正文内容必须保留。")
    expect(result.appliedOperations[0]?.type).toBe("scrubDocumentMetadata")
  })

  test("apply_word_document_edits can redact exact visible text while preserving layout length", async () => {
    const root = await tempDir("chipmate-word-redact-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const sensitiveEmail = "ada@example.com"
    const bytes = cGuidelineDocxFixture({
      title: "脱敏文档",
      sections: [{ heading: "联系人", paragraphs: [`Reviewer email: ${sensitiveEmail}`, "公开版本不能包含邮箱。"] }],
      tableRows: [["字段", "值"], ["Owner", sensitiveEmail]],
    })
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/redact.docx", bytes })
    const validation = validateDocumentEditPlan({
      planId: "redact",
      targetPath: "docs/redact.docx",
      operations: [
        { type: "redactText", locator: inspection.documentEndLocator, items: [{ text: sensitiveEmail }], includeComments: false },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/redact.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const expectedMask = "█".repeat(sensitiveEmail.length)
    expect(documentXml).not.toContain(sensitiveEmail)
    expect(documentXml).toContain(expectedMask)
    expect(documentXml).toContain("Reviewer email:")
    expect(result.appliedOperations[0]?.type).toBe("redactText")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("apply_word_document_edits can redact email and phone patterns with comments included", async () => {
    const root = await tempDir("chipmate-word-redact-patterns-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const email = "ada@example.com"
    const commentEmail = "reviewer@example.com"
    const phone = "+1 415-555-0101"
    const bytes = cGuidelineDocxFixture({
      title: "模式脱敏文档",
      sections: [{ heading: "联系人", paragraphs: [`Primary contact: ${email} / ${phone}`, "公开版本需要脱敏邮箱和电话。"] }],
      tableRows: [["字段", "值"], ["Owner email", email], ["Owner phone", phone]],
    })
    const initialInspection = await new WordDocumentInspector().inspect({ path: "docs/redact-patterns.docx", bytes })
    const commented = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/redact-patterns.docx",
      bytes,
      inspection: initialInspection,
      plan: {
        planId: "add-redaction-comment",
        targetPath: "docs/redact-patterns.docx",
        outputFilenameBase: "redact-patterns-commented",
        operations: [{ type: "addComment", locator: initialInspection.paragraphs[0]!.locator, text: `Reviewer backup: ${commentEmail}`, author: "ChipMate" }],
        warnings: [],
      },
    })
    const commentedBytes = await readFile(join(root, commented.path))
    const inspection = await new WordDocumentInspector().inspect({ path: commented.path, bytes: commentedBytes })
    const validation = validateDocumentEditPlan({
      planId: "redact-patterns",
      targetPath: commented.path,
      outputFilenameBase: "redacted-patterns",
      operations: [
        {
          type: "redactText",
          locator: inspection.documentEndLocator,
          patterns: [{ kind: "email" }, { kind: "phone", replacement: "X" }],
          includeComments: true,
        },
      ],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: commented.path,
      bytes: commentedBytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const commentsXml = await readDocxPart(outputBytes, "word/comments.xml")
    expect(documentXml).not.toContain(email)
    expect(documentXml).not.toContain(phone)
    expect(commentsXml).not.toContain(commentEmail)
    expect(documentXml).toContain("Primary contact:")
    expect(documentXml).toMatch(/X{8,}/)
    expect(result.appliedOperations[0]?.detail).toContain("package audit redacted")
    expect(result.appliedOperations[0]?.detail).toContain("email:")
    expect(result.appliedOperations[0]?.detail).toContain("phone:")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("WordEditAgentFlow persists DocumentSkillRunSummary", async () => {
    const root = await tempDir("chipmate-word-edit-flow-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = cGuidelineDocxFixture({
      title: "审稿版文档",
      sections: [{ heading: "现有章节", paragraphs: ["原始内容。"] }],
    })
    const result = await new WordEditAgentFlow(root).run({
      question: "请新增一个审稿说明章节，生成汇报版 Word。",
      file: { path: "docs/review.docx", bytes },
    })

    expect(result.path).toMatch(/^\.chipmate\/docs\/.+\.docx$/)
    expect(result.runSummaryPath).toMatch(/^\.chipmate\/docs\/document-skill-run-.+\.json$/)
    const summary = JSON.parse(await readFile(join(root, result.runSummaryPath!), "utf8"))
    expect(summary.sourceDoc).toBe("docs/review.docx")
    expect(summary.outputDoc).toBe(result.path)
    expect(summary.inspectSummary.paragraphCount).toBeGreaterThan(0)
    expect(summary.editPlan.operations.length).toBeGreaterThan(0)
    expect(summary.appliedOperations.length).toBeGreaterThan(0)
    expect(summary.structureCheckResult.ok).toBe(true)
    expect(typeof summary.repairAttempted).toBe("boolean")
  })

  test("render_word_document persists page PNG visual QA artifacts", async () => {
    const root = await tempDir("chipmate-word-render-")
    const docxPath = join(root, "sample.docx")
    await writeFile(docxPath, await new WordDocBuilder().build(minimalRenderableWordDocSpec()))
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const bytes = await readFile(docxPath)
      const result = await renderWordDocument({
        docxPath,
        bytes,
        workspaceRoot: root,
        artifactNameBase: "visual-qa",
        structureIssues: [],
        timeoutMs: 10_000,
      })

      expect(result.attempted).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.visualQaStatus).toBe("completed")
      expect(result.pageCount).toBe(1)
      expect(result.renderArtifactDir).toMatch(/^\.chipmate\/docs\/rendered\/visual-qa-/)
      expect(result.pdfArtifactPath).toMatch(/document\.pdf$/)
      expect(result.renderProvider).toBe("remote-opencode")
      expect(result.pdfToPngRenderer).toBe("pdftoppm")
      expect(result.pagePngPaths).toHaveLength(1)
      expect(existsSync(join(root, result.pagePngPaths![0]!))).toBe(true)
      expect(result.pageVisualSummaries).toHaveLength(1)
      expect(result.pageVisualSummaries![0]!.path).toBe(result.pagePngPaths![0])
      expect(result.pageVisualSummaries![0]!.width).toBe(1)
      expect(result.pageVisualSummaries![0]!.height).toBe(1)
      expect(result.pageVisualSummaries![0]!.inkPixels).toBeGreaterThan(0)
      expect(result.pageVisualSummaries![0]!.inkRatio).toBeGreaterThan(0)
      expect(result.pageVisualSummaries![0]!.contentBounds?.width).toBeGreaterThan(0)
      expect(result.pageVisualSummaries![0]!.visualRegions).toHaveLength(9)
      expect(result.pageVisualSummaries![0]!.visualRegions?.some((region) => region.id === "top-left" && region.inkPixels > 0)).toBe(true)
      expect(result.pageVisualSummaries![0]!.inkComponents?.[0]?.bounds.width).toBeGreaterThan(0)
      expect(result.pageVisualSummaries![0]!.inkComponents?.[0]?.pageArea).toBeTruthy()
      expect(result.pageVisualSummaries![0]!.inkComponents?.[0]?.riskFlags).toContain("near-page-edge")
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("render_word_document skips visual QA when remote render server is unconfigured", async () => {
    const root = await tempDir("chipmate-word-render-unconfigured-")
    const docxPath = join(root, "sample.docx")
    await writeFile(docxPath, await new WordDocBuilder().build(minimalRenderableWordDocSpec()))
    const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
    delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
    let result: Awaited<ReturnType<typeof renderWordDocument>>
    try {
      result = await renderWordDocument({
        docxPath,
        bytes: await readFile(docxPath),
        workspaceRoot: root,
        artifactNameBase: "visual-qa-unconfigured",
        structureIssues: [],
        timeoutMs: 10_000,
      })
    } finally {
      if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
      else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
    }

    expect(result.attempted).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.visualQaStatus).toBe("skipped")
    expect(result.skipReason).toBe("remote-unconfigured")
    expect(result.pagePngPaths).toBeUndefined()
    expect(result.renderProvider).toBe("remote-opencode")
    expect(result.issues.some((item) => item.code === "remote-word-render-unconfigured")).toBe(true)
  }, 15_000)

  test("render_word_document skips visual QA when remote render server is unavailable", async () => {
    const root = await tempDir("chipmate-word-render-remote-fail-")
    const docxPath = join(root, "sample.docx")
    await writeFile(docxPath, await new WordDocBuilder().build(minimalRenderableWordDocSpec()))
    const restoreRenderTools = await installFakeWordRenderTools(root, { remote: "fail" })
    try {
      const result = await renderWordDocument({
        docxPath,
        bytes: await readFile(docxPath),
        workspaceRoot: root,
        artifactNameBase: "visual-qa-remote-fail",
        structureIssues: [],
        timeoutMs: 10_000,
      })

      expect(result.attempted).toBe(false)
      expect(result.ok).toBe(true)
      expect(result.visualQaStatus).toBe("skipped")
      expect(result.skipReason).toBe("remote-unavailable")
      expect(result.pagePngPaths).toBeUndefined()
      expect(result.renderProvider).toBe("remote-opencode")
      expect(result.issues.some((item) => item.code === "remote-word-render-unavailable")).toBe(true)
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("render_word_document skips visual QA when remote render server returns invalid JSON", async () => {
    const root = await tempDir("chipmate-word-render-remote-invalid-")
    const docxPath = join(root, "sample.docx")
    await writeFile(docxPath, await new WordDocBuilder().build(minimalRenderableWordDocSpec()))
    const restoreRenderTools = await installFakeWordRenderTools(root, { remote: "invalid-json" })
    try {
      const result = await renderWordDocument({
        docxPath,
        bytes: await readFile(docxPath),
        workspaceRoot: root,
        artifactNameBase: "visual-qa-remote-invalid",
        structureIssues: [],
        timeoutMs: 10_000,
      })

      expect(result.attempted).toBe(false)
      expect(result.ok).toBe(true)
      expect(result.visualQaStatus).toBe("skipped")
      expect(result.skipReason).toBe("remote-invalid-response")
      expect(result.pagePngPaths).toBeUndefined()
      expect(result.issues.some((item) => item.code === "remote-word-render-invalid-response")).toBe(true)
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("render_word_document skips visual QA when returned artifacts cannot be saved", async () => {
    const root = await tempDir("chipmate-word-render-persist-fail-")
    const docxPath = join(root, "sample.docx")
    await writeFile(docxPath, await new WordDocBuilder().build(minimalRenderableWordDocSpec()))
    await writeFile(join(root, ".chipmate"), "not a directory")
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const result = await renderWordDocument({
        docxPath,
        bytes: await readFile(docxPath),
        workspaceRoot: root,
        artifactNameBase: "visual-qa-persist-fail",
        structureIssues: [],
        timeoutMs: 10_000,
      })

      expect(result.attempted).toBe(false)
      expect(result.ok).toBe(true)
      expect(result.visualQaStatus).toBe("skipped")
      expect(result.skipReason).toBe("artifact-persist-failed")
      expect(result.pagePngPaths).toBeUndefined()
      expect(result.issues.some((item) => item.code === "remote-word-render-artifact-persist-failed")).toBe(true)
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("compare_word_documents reports no text or rendered-page changes for identical DOCX bytes", async () => {
    const root = await tempDir("chipmate-word-diff-same-")
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const result = await compareWordDocuments({
        before: { path: "docs/before.docx", bytes },
        after: { path: "docs/after.docx", bytes },
        workspaceRoot: root,
        artifactNameBase: "same-doc",
        timeoutMs: 10_000,
      })

      expect(result.ok).toBe(true)
      expect(result.textChanged).toBe(false)
      expect(result.visualDiffComplete).toBe(true)
      expect(result.pixelDiffComplete).toBe(true)
      expect(result.changedPages).toEqual([])
      expect(result.diffArtifactDir).toMatch(/^\.chipmate\/docs\/diff\/same-doc-/)
      expect(result.textDiffPath).toMatch(/text-diff\.txt$/)
      expect(existsSync(join(root, result.textDiffPath!))).toBe(true)
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("compare_word_documents persists text diff and changed rendered page PNG artifacts", async () => {
    const root = await tempDir("chipmate-word-diff-changed-")
    const beforeBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const afterSpec = minimalRenderableWordDocSpec()
    afterSpec.sections[0]!.paragraphs = ["更新后的团队规则应明确评审责任、状态切换条件和例外处理路径。"]
    const afterBytes = await new WordDocBuilder().build(afterSpec)
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const result = await compareWordDocuments({
        before: { path: "docs/before.docx", bytes: beforeBytes },
        after: { path: "docs/after.docx", bytes: afterBytes },
        workspaceRoot: root,
        artifactNameBase: "changed-doc",
        timeoutMs: 10_000,
      })

      expect(result.ok).toBe(true)
      expect(result.textChanged).toBe(true)
      expect(result.textDiff).toContain("-所有团队规则都应包含清晰的适用范围、来源依据和落地建议。")
      expect(result.textDiff).toContain("+更新后的团队规则应明确评审责任、状态切换条件和例外处理路径。")
      expect(result.visualDiffComplete).toBe(true)
      expect(result.beforeRender?.pageVisualSummaries?.[0]?.inkPixels).toBeGreaterThan(0)
      expect(result.afterRender?.pageVisualSummaries?.[0]?.contentBounds?.height).toBeGreaterThan(0)
      expect(result.afterRender?.pageVisualSummaries?.[0]?.visualRegions).toHaveLength(9)
      expect(result.afterRender?.pageVisualSummaries?.[0]?.inkComponents?.[0]?.inkPixels).toBeGreaterThan(0)
      expect(result.pixelDiffComplete).toBe(false)
      expect(result.changedPages).toHaveLength(1)
      expect(result.changedPages[0]!.beforePngPath).toMatch(/before-page-1\.png$/)
      expect(result.changedPages[0]!.afterPngPath).toMatch(/after-page-1\.png$/)
      expect(result.changedPages[0]!.diffPngPath).toBeUndefined()
      expect(result.changedPages[0]!.byteChanged).toBe(true)
      expect(result.issues.some((item) => item.code === "word-pixel-diff-skipped")).toBe(true)
      expect(existsSync(join(root, result.changedPages[0]!.beforePngPath!))).toBe(true)
      expect(existsSync(join(root, result.changedPages[0]!.afterPngPath!))).toBe(true)
      expect(await readFile(join(root, result.textDiffPath!), "utf8")).toContain("@@")
    } finally {
      restoreRenderTools()
    }
  })

  test("compare_word_documents skips local pixel diff even when a pixel threshold is provided", async () => {
    const root = await tempDir("chipmate-word-diff-threshold-")
    const beforeBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const afterSpec = minimalRenderableWordDocSpec()
    afterSpec.sections[0]!.paragraphs = ["更新后的团队规则应明确评审责任、状态切换条件和例外处理路径。"]
    const afterBytes = await new WordDocBuilder().build(afterSpec)
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const result = await compareWordDocuments({
        before: { path: "docs/before.docx", bytes: beforeBytes },
        after: { path: "docs/after.docx", bytes: afterBytes },
        workspaceRoot: root,
        artifactNameBase: "threshold-doc",
        pixelThreshold: 255,
        timeoutMs: 10_000,
      })

      expect(result.ok).toBe(true)
      expect(result.textChanged).toBe(true)
      expect(result.visualDiffComplete).toBe(true)
      expect(result.pixelDiffComplete).toBe(false)
      expect(result.changedPages).toHaveLength(1)
      expect(result.changedPages[0]!.byteChanged).toBe(true)
      expect(result.changedPages[0]!.pixelThreshold).toBeUndefined()
      expect(result.changedPages[0]!.diffPngPath).toBeUndefined()
      expect(result.issues.some((item) => item.code === "word-pixel-diff-skipped")).toBe(true)
    } finally {
      restoreRenderTools()
    }
  })

  test("merge_word_documents appends body OOXML while preserving base section properties", async () => {
    const root = await tempDir("chipmate-word-merge-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const baseSpec = minimalRenderableWordDocSpec()
    baseSpec.metadata.title = "Base Document"
    baseSpec.cover = { title: "Base Document" }
    baseSpec.sections = [{
      id: "base-section",
      level: 1,
      title: "Base Section",
      paragraphs: ["Base-only paragraph."],
      tables: [{
        headers: ["Base", "Status"],
        rows: [["A", "kept"]],
      }],
    }]
    const appendSpec = minimalRenderableWordDocSpec()
    appendSpec.metadata.title = "Append Document"
    appendSpec.cover = { title: "Append Document" }
    appendSpec.sections = [{
      id: "append-section",
      level: 1,
      title: "Append Section",
      paragraphs: ["Append-only paragraph."],
      tables: [{
        headers: ["Append", "Status"],
        rows: [["B", "added"]],
      }],
    }]
    const result = await new WordDocumentMerger(root).merge({
      base: { path: "docs/base.docx", bytes: await new WordDocBuilder().build(baseSpec) },
      append: { path: "docs/append.docx", bytes: await new WordDocBuilder().build(appendSpec) },
      outputFilenameBase: "merged-doc",
      workspaceRoot: root,
      timeoutMs: 10_000,
    })

    expect(result.path).toMatch(/^\.chipmate\/docs\/merged-doc-.+\.docx$/)
    expect(result.bodyChildrenAppended).toBeGreaterThan(0)
    expect(result.structureCheckResult.ok).toBe(true)
    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).toContain("Base-only paragraph.")
    expect(documentXml).toContain("Append-only paragraph.")
    expect(appearsBefore(documentXml, "Base-only paragraph.", "Append-only paragraph.")).toBe(true)
    expect(documentXml.match(/<w:sectPr\b/g)).toHaveLength(1)
  })

  test("merge_word_documents refuses append drawings by default", async () => {
    const baseBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const appendSpec = minimalRenderableWordDocSpec()
    appendSpec.sections[0]!.figures = [{
      title: "Unsafe Figure",
      altText: "Figure that requires image relationship merge",
      image: {
        contentType: "image/png",
        bytes: tinyPngBytes(),
        width: 10,
        height: 10,
      },
    }]
    const appendBytes = await new WordDocBuilder().build(appendSpec)

    await expect(mergeDocxBytes({
      base: { path: "docs/base.docx", bytes: baseBytes },
      append: { path: "docs/append-with-image.docx", bytes: appendBytes },
    })).rejects.toThrow("drawings/images")
  })

  test("merge_word_documents merges append PNG figure media when drawings are allowed", async () => {
    const root = await tempDir("chipmate-word-merge-images-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const baseSpec = minimalRenderableWordDocSpec()
    baseSpec.metadata.title = "Base Image Merge Document"
    baseSpec.cover = { title: "Base Image Merge Document" }
    baseSpec.sections = [{
      id: "base",
      level: 1,
      title: "Base",
      paragraphs: ["Base paragraph before appended figure."],
    }]
    const appendSpec = minimalRenderableWordDocSpec()
    appendSpec.metadata.title = "Append Image Document"
    appendSpec.cover = { title: "Append Image Document" }
    appendSpec.sections = [{
      id: "append",
      level: 1,
      title: "Append",
      paragraphs: ["Append paragraph before figure."],
      figures: [{
        title: "Merged Figure",
        caption: "A PNG figure copied from the append document.",
        label: "Figure",
        bookmark: "fig_merged_image",
        altText: "Merged figure PNG",
        image: {
          contentType: "image/png",
          bytes: tinyPngBytes(),
          width: 32,
          height: 16,
        },
      }],
    }]

    const result = await new WordDocumentMerger(root).merge({
      base: { path: "docs/base.docx", bytes: await new WordDocBuilder().build(baseSpec) },
      append: { path: "docs/append-image.docx", bytes: await new WordDocBuilder().build(appendSpec) },
      outputFilenameBase: "merged-image-doc",
      allowDrawings: true,
      workspaceRoot: root,
      timeoutMs: 10_000,
    })

    expect(result.drawingsAllowed).toBe(true)
    expect(result.mergedImageCount).toBe(1)
    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(outputBytes, "word/_rels/document.xml.rels")
    const contentTypesXml = await readDocxPart(outputBytes, "[Content_Types].xml")
    const parts = await docxPartPaths(outputBytes)
    const embedRelId = documentXml.match(/\br:embed="([^"]+)"/)?.[1]
    expect(embedRelId).toMatch(/^rIdChipMateMergeImage/)
    const mergedTarget = documentRelsXml.match(new RegExp(`Id="${embedRelId}"[^>]*Target="([^"]+)"`))?.[1]
    expect(mergedTarget).toBe("media/chipmate-merge-image1.png")
    expect(parts).toContain(`word/${mergedTarget}`)
    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(documentXml).toContain("Base paragraph before appended figure.")
    expect(documentXml).toContain("Append paragraph before figure.")
    expect(documentXml).toContain('descr="Merged figure PNG"')
    expect(documentXml).toMatch(/<w:bookmarkStart\b[^>]*w:name="fig_merged_image"\/>/)
    expect(documentXml).toMatch(/<w:document\b[^>]*xmlns:wp=/)
    expect(appearsBefore(documentXml, "Base paragraph before appended figure.", "Append paragraph before figure.")).toBe(true)
    const inspection = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(inspection.images.some((image) => image.target === mergedTarget && image.altText === "Merged figure PNG")).toBe(true)
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("merge_word_documents reports style and numbering conflict strategy", async () => {
    const root = await tempDir("chipmate-word-merge-conflicts-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const baseSpec = minimalRenderableWordDocSpec()
    baseSpec.metadata.title = "Base Conflict Document"
    baseSpec.cover = { title: "Base Conflict Document" }
    baseSpec.sections = [{
      id: "base",
      level: 1,
      title: "Base Conflict Section",
      paragraphs: ["Base paragraph before append."],
      lists: [{
        kind: "numbered",
        items: [{ text: "Base list item" }],
      }],
    }]
    const appendSpec = minimalRenderableWordDocSpec()
    appendSpec.metadata.title = "Append Conflict Document"
    appendSpec.cover = { title: "Append Conflict Document" }
    appendSpec.sections = [{
      id: "append",
      level: 1,
      title: "Append Conflict Section",
      paragraphs: ["Append paragraph with custom style."],
      lists: [{
        kind: "numbered",
        items: [{ text: "Append list item" }],
      }],
    }]
    const baseBytes = await new WordDocBuilder().build(baseSpec)
    const baseNumberingXml = await readDocxPart(baseBytes, "word/numbering.xml")
    const baseNumId = baseNumberingXml.match(/<w:num\b[^>]*w:numId="([^"]+)"/)?.[1] ?? "1"
    let appendBytes = await new WordDocBuilder().build(appendSpec)
    appendBytes = await replaceDocxPart(appendBytes, "word/styles.xml", (xml) => xml
      .replace(/(<w:style\b[^>]*w:styleId="Heading1"[\s\S]*?<w:name w:val=")[^"]*("[\s\S]*?<\/w:style>)/, "$1Append Heading One$2")
      .replace("</w:styles>", '<w:style w:type="paragraph" w:styleId="AppendOnlyStyle"><w:name w:val="Append Only Style"/></w:style></w:styles>'))
    appendBytes = await replaceDocxPart(appendBytes, "word/document.xml", (xml) => xml.replace(
      /(<w:p\b[\s\S]*?Append paragraph with custom style\.[\s\S]*?<\/w:p>)/,
      '$1<w:p><w:pPr><w:pStyle w:val="AppendOnlyStyle"/></w:pPr><w:r><w:t>Append-only styled paragraph.</w:t></w:r></w:p>',
    ).replace(/<w:numId\b[^>]*w:val="[^"]+"\/>/, `<w:numId w:val="${baseNumId}"/>`))
    appendBytes = await replaceDocxPart(appendBytes, "word/numbering.xml", (xml) => xml.replace(
      "</w:numbering>",
      `<w:abstractNum w:abstractNumId="909"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum><w:num w:numId="${baseNumId}"><w:abstractNumId w:val="909"/></w:num></w:numbering>`,
    ))

    const result = await new WordDocumentMerger(root).merge({
      base: { path: "docs/base-conflict.docx", bytes: baseBytes },
      append: { path: "docs/append-conflict.docx", bytes: appendBytes },
      outputFilenameBase: "merged-conflict-doc",
      workspaceRoot: root,
      timeoutMs: 10_000,
    })

    expect(result.mergeAudit.styleStrategy.strategy).toBe("base-wins")
    expect(result.mergeAudit.styleStrategy.conflictingStyleIds).toContain("Heading1")
    expect(result.mergeAudit.styleStrategy.referencedAppendOnlyStyleIds).toContain("AppendOnlyStyle")
    expect(result.mergeAudit.numberingStrategy.strategy).toBe("base-wins")
    expect(result.mergeAudit.numberingStrategy.conflictingNumIds.length).toBeGreaterThan(0)
    expect(result.warnings.some((warning) => warning.includes("Style merge strategy: base-wins"))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("Numbering merge strategy: base-wins"))).toBe(true)
    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).toContain("Append-only styled paragraph.")
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("merge_word_documents blocks unsupported embedded object relationships", async () => {
    const baseBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    let appendBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    appendBytes = await replaceDocxPart(appendBytes, "word/_rels/document.xml.rels", (xml) => xml.replace(
      "</Relationships>",
      '<Relationship Id="rIdOleObject1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/></Relationships>',
    ))
    appendBytes = await replaceDocxPart(appendBytes, "word/document.xml", (xml) => xml.replace(
      "</w:body>",
      '<w:p><w:r><w:object><o:OLEObject r:id="rIdOleObject1"/></w:object></w:r></w:p></w:body>',
    ))
    appendBytes = await writeDocxPart(appendBytes, "word/embeddings/oleObject1.bin", new Uint8Array([1, 2, 3, 4]))

    await expect(mergeDocxBytes({
      base: { path: "docs/base.docx", bytes: baseBytes },
      append: { path: "docs/append-ole.docx", bytes: appendBytes },
      allowDrawings: true,
    })).rejects.toThrow(/unsupported embedded object[\s\S]*oleObject/)
  })

  test("audit_word_document_styles reports direct formatting and heading-like drift", async () => {
    const bytes = await styleDriftDocxFixture()
    const report = await auditWordDocumentStyles({ path: "docs/style-drift.docx", bytes })

    expect(report.directRunFormattingRuns).toBeGreaterThan(0)
    expect(report.directParagraphFormattingParagraphs).toBeGreaterThan(0)
    expect(report.fontsByCharCount["Courier New"]).toBeGreaterThan(0)
    expect(report.headingLikeParagraphsNotHeadingStyle.some((item) => item.text.includes("Manual Formatting Heading"))).toBe(true)
    expect(report.examples.directRunFormatting.some((item) => item.runText.includes("Manual Formatting Heading"))).toBe(true)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/style-drift.docx", bytes })
    expect(inspection.summary.styleCount).toBeGreaterThan(0)
    expect(inspection.styles.some((style) => style.styleId === "Normal" && style.paragraphUseCount > 0)).toBe(true)
    expect(inspection.styles.some((style) => style.styleId === "Heading1" && style.type === "paragraph")).toBe(true)
    expect(inspection.styles.every((style) => style.locator.kind === "style")).toBe(true)
  })

  test("normalize_word_document_styles clears direct formatting and writes a checked DOCX copy", async () => {
    const root = await tempDir("chipmate-word-style-normalize-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const bytes = await styleDriftDocxFixture()
    const normalized = await normalizeWordDocumentStyleBytes(bytes, "docs/style-drift.docx", { clearParagraphFormatting: true })

    expect(normalized.runOverridesCleared).toBeGreaterThan(0)
    expect(normalized.paragraphOverridesCleared).toBeGreaterThan(0)
    expect(normalized.afterReport.directRunFormattingRuns).toBeLessThan(normalized.beforeReport.directRunFormattingRuns)
    const normalizedXml = await readDocxPart(normalized.bytes, "word/document.xml")
    expect(normalizedXml).not.toContain("Courier New")
    expect(normalizedXml).not.toContain("FF0000")
    expect(normalizedXml).not.toContain('w:after="480"')
    expect(normalizedXml).not.toContain('w:left="720"')

    const result = await new WordDocumentStyleNormalizer(root).normalize({
      path: "docs/style-drift.docx",
      bytes,
      outputFilenameBase: "style-normalized",
      options: { clearParagraphFormatting: true },
    })
    expect(result.path).toMatch(/^\.chipmate\/docs\/style-normalized-.+\.docx$/)
    expect(result.structureCheckResult.ok).toBe(true)
    expect(result.runOverridesCleared).toBeGreaterThan(0)
    expect(existsSync(join(root, result.path))).toBe(true)
  })

  test("normalize_word_document_styles can preserve intentional run emphasis while clearing drift", async () => {
    const bytes = await styleDriftDocxFixture()
    const normalized = await normalizeWordDocumentStyleBytes(bytes, "docs/style-drift.docx", {
      clearParagraphFormatting: true,
      preserveRunFormatting: ["bold", "italic"],
    })

    expect(normalized.preservedRunFormatting).toEqual(["bold", "italic"])
    expect(normalized.runOverridesCleared).toBeGreaterThan(0)
    expect(normalized.runOverridesPreserved).toBeGreaterThan(0)
    expect(normalized.paragraphOverridesCleared).toBeGreaterThan(0)
    expect(normalized.afterReport.directRunFormattingRuns).toBeGreaterThan(0)

    const normalizedXml = await readDocxPart(normalized.bytes, "word/document.xml")
    expect(normalizedXml).toContain("<w:b/>")
    expect(normalizedXml).toContain("<w:i/>")
    expect(normalizedXml).not.toContain("Courier New")
    expect(normalizedXml).not.toContain("FF0000")
    expect(normalizedXml).not.toContain('<w:sz w:val="32"/>')
    expect(normalizedXml).not.toContain('w:after="480"')
    expect(normalizedXml).not.toContain('w:left="720"')
  })

  test("apply_word_template_styles copies template style parts into a checked DOCX copy", async () => {
    const root = await tempDir("chipmate-word-template-style-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const targetBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    let templateBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    templateBytes = await replaceDocxPart(templateBytes, "word/styles.xml", (xml) => xml.replace("</w:styles>", '<w:style w:type="paragraph" w:styleId="TemplateOnlyStyle"><w:name w:val="Template Only Style"/></w:style></w:styles>'))
    templateBytes = await replaceDocxPart(templateBytes, "word/numbering.xml", (xml) => xml.replace("</w:numbering>", '<w:abstractNum w:abstractNumId="77"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum></w:numbering>'))
    templateBytes = await writeDocxPart(templateBytes, "word/theme/theme1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ChipMate Template Theme"><a:themeElements><a:clrScheme name="TemplateColors"/><a:fontScheme name="TemplateFonts"/><a:fmtScheme name="TemplateFormats"/></a:themeElements></a:theme>')
    templateBytes = await writeDocxPart(templateBytes, "word/fontTable.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Template Sans"/></w:fonts>')

    const applied = await applyTemplateStylesToDocxBytes({
      target: { path: "docs/target.docx", bytes: targetBytes },
      template: { path: "docs/template.dotx", bytes: templateBytes },
    })
    expect(applied.copiedParts).toEqual([
      "word/styles.xml",
      "word/theme/theme1.xml",
      "word/fontTable.xml",
      "word/numbering.xml",
    ])
    expect(applied.skippedParts).toEqual([])
    expect(applied.templateAudit.styleStrategy.strategy).toBe("replace-all")
    expect(applied.templateAudit.styleStrategy.templateOnlyStyleIds).toContain("TemplateOnlyStyle")
    expect(applied.templateAudit.numberingStrategy.templateOnlyNumIds).toEqual([])
    const stylesXml = await readDocxPart(applied.bytes, "word/styles.xml")
    const numberingXml = await readDocxPart(applied.bytes, "word/numbering.xml")
    const themeXml = await readDocxPart(applied.bytes, "word/theme/theme1.xml")
    const fontTableXml = await readDocxPart(applied.bytes, "word/fontTable.xml")
    const contentTypesXml = await readDocxPart(applied.bytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(applied.bytes, "word/document.xml")
    expect(stylesXml).toContain('w:styleId="TemplateOnlyStyle"')
    expect(numberingXml).toContain('w:abstractNumId="77"')
    expect(themeXml).toContain("ChipMate Template Theme")
    expect(fontTableXml).toContain("Template Sans")
    expect(contentTypesXml).toContain('PartName="/word/theme/theme1.xml"')
    expect(contentTypesXml).toContain('PartName="/word/fontTable.xml"')
    expect(documentXml).toContain("团队版规则正文")
    const appliedInspection = await new WordDocumentInspector().inspect({ path: "docs/template-styled.docx", bytes: applied.bytes })
    expect(appliedInspection.styles.some((style) => style.styleId === "TemplateOnlyStyle" && style.name === "Template Only Style")).toBe(true)

    const result = await new WordTemplateStyleApplier(root).apply({
      target: { path: "docs/target.docx", bytes: targetBytes },
      template: { path: "docs/template.dotx", bytes: templateBytes },
      outputFilenameBase: "template-styled",
    })
    expect(result.path).toMatch(/^\.chipmate\/docs\/template-styled-.+\.docx$/)
    expect(result.structureCheckResult.ok).toBe(true)
    expect(result.copiedParts).toContain("word/styles.xml")
    expect(result.templateAudit.styleStrategy.strategy).toBe("replace-all")
    expect(existsSync(join(root, result.path))).toBe(true)
  })

  test("apply_word_template_styles can selectively import template styles and report conflicts", async () => {
    const targetBytes = await replaceDocxPart(await new WordDocBuilder().build(minimalRenderableWordDocSpec()), "word/styles.xml", (xml) => xml
      .replace("</w:styles>", '<w:style w:type="paragraph" w:styleId="TargetOnlyStyle"><w:name w:val="Target Only Style"/></w:style></w:styles>')
      .replace(/<w:style\b[^>]*\bw:styleId="Heading1"[\s\S]*?<\/w:style>/, '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Target Heading 1"/><w:rPr><w:color w:val="111111"/></w:rPr></w:style>'))
    let templateBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    templateBytes = await replaceDocxPart(templateBytes, "word/styles.xml", (xml) => xml
      .replace(/<w:style\b[^>]*\bw:styleId="Heading1"[\s\S]*?<\/w:style>/, '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Template Heading 1"/><w:rPr><w:color w:val="222222"/></w:rPr></w:style>')
      .replace("</w:styles>", [
        '<w:style w:type="paragraph" w:styleId="TemplateOnlyStyle"><w:name w:val="Template Only Style"/><w:basedOn w:val="TemplateBase"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="TemplateBase"><w:name w:val="Template Base"/></w:style>',
        '<w:style w:type="paragraph" w:styleId="UnselectedTemplateStyle"><w:name w:val="Unselected Template Style"/></w:style>',
        "</w:styles>",
      ].join("")))

    const applied = await applyTemplateStylesToDocxBytes({
      target: { path: "docs/target.docx", bytes: targetBytes },
      template: { path: "docs/template.dotx", bytes: templateBytes },
      styleAllowlist: ["TemplateOnlyStyle", "Heading1", "MissingTemplateStyle"],
    })

    const stylesXml = await readDocxPart(applied.bytes, "word/styles.xml")
    expect(stylesXml).toContain('w:styleId="TemplateOnlyStyle"')
    expect(stylesXml).toContain('w:styleId="TemplateBase"')
    expect(stylesXml).toContain('w:styleId="TargetOnlyStyle"')
    expect(stylesXml).toContain("Template Heading 1")
    expect(stylesXml).not.toContain("Target Heading 1")
    expect(stylesXml).not.toContain("UnselectedTemplateStyle")
    expect(applied.templateAudit.styleStrategy).toMatchObject({
      strategy: "selective-allowlist",
      requestedStyleIds: ["Heading1", "MissingTemplateStyle", "TemplateOnlyStyle"],
      missingStyleIds: ["MissingTemplateStyle"],
    })
    expect(applied.templateAudit.styleStrategy.appliedStyleIds).toEqual(["Heading1", "TemplateBase", "TemplateOnlyStyle"])
    expect(applied.templateAudit.styleStrategy.expandedDependencyStyleIds).toEqual(["TemplateBase"])
    expect(applied.templateAudit.styleStrategy.conflictingStyleIds).toContain("Heading1")
    expect(applied.warnings.some((warning) => warning.includes("MissingTemplateStyle"))).toBe(true)
    expect(applied.warnings.some((warning) => warning.includes("Heading1"))).toBe(true)
  })

  test("apply_word_template_styles handles template part media relationships and fails closed for unsupported relationships", async () => {
    const targetBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    let templateBytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    templateBytes = await replaceDocxPart(templateBytes, "word/numbering.xml", (xml) => xml
      .replace("<w:numbering", '<w:numbering xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"')
      .replace("</w:numbering>", [
        '<w:numPicBullet w:numPicBulletId="42"><w:pict><v:shape><v:imagedata r:id="rIdTemplateBullet"/></v:shape></w:pict></w:numPicBullet>',
        "</w:numbering>",
      ].join("")))
    templateBytes = await writeDocxPart(templateBytes, "word/_rels/numbering.xml.rels", [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rIdTemplateBullet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/template-bullet.png"/>',
      "</Relationships>",
    ].join(""))
    templateBytes = await writeDocxPart(templateBytes, "word/media/template-bullet.png", tinyPngBytes())
    templateBytes = await ensurePngDefaultContentTypeFixture(templateBytes)

    const applied = await applyTemplateStylesToDocxBytes({
      target: { path: "docs/target.docx", bytes: targetBytes },
      template: { path: "docs/template-with-media.dotx", bytes: templateBytes },
    })
    const numberingRelsXml = await readDocxPart(applied.bytes, "word/_rels/numbering.xml.rels")
    const mediaBytes = await readDocxBinaryPart(applied.bytes, "word/media/template-bullet.png")
    expect(numberingRelsXml).toContain('Id="rIdTemplateBullet"')
    expect(mediaBytes.length).toBeGreaterThan(0)
    expect(applied.templateAudit.relationshipStrategy.copiedRelationshipParts).toContain("word/_rels/numbering.xml.rels")
    expect(applied.templateAudit.relationshipStrategy.copiedMediaParts).toContain("word/media/template-bullet.png")
    expect(applied.warnings.some((warning) => warning.includes("template media part"))).toBe(true)

    let unsafeTemplateBytes = await replaceDocxPart(templateBytes, "word/numbering.xml", (xml) => xml.replace("rIdTemplateBullet", "rIdUnsafeObject"))
    unsafeTemplateBytes = await writeDocxPart(unsafeTemplateBytes, "word/_rels/numbering.xml.rels", [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rIdUnsafeObject" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/>',
      "</Relationships>",
    ].join(""))
    await expect(applyTemplateStylesToDocxBytes({
      target: { path: "docs/target.docx", bytes: targetBytes },
      template: { path: "docs/unsafe-template.dotx", bytes: unsafeTemplateBytes },
    })).rejects.toThrow(/unsupported|oleObject|cannot safely copy/)
  })

  test("audit_word_document_fields reports fields and flatten_word_ref_fields freezes cached REF text", async () => {
    const root = await tempDir("chipmate-word-field-flatten-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [
      {
        id: "target",
        level: 1,
        title: "Referenced Section",
        bookmark: "sec_target",
        paragraphs: ["This section is referenced by fields."],
        tables: [{
          headers: ["Field", "Status"],
          rows: [["REF", "target"]],
        }],
      },
      {
        id: "refs",
        level: 1,
        title: "References",
        richParagraphs: [{
          runs: [
            { text: "See " },
            { reference: { bookmark: "sec_target", field: "REF", fallbackText: "Referenced Section" } },
            { text: " on page " },
            { reference: { bookmark: "sec_target", field: "PAGEREF", fallbackText: "3" } },
            { text: "." },
          ],
        }],
        tables: [{
          headers: ["Check", "Result"],
          rows: [["Fields", "Present"]],
        }],
      },
    ]
    const bytes = await new WordDocBuilder().build(spec)
    const report = await auditWordDocumentFields({ path: "docs/fields.docx", bytes })
    expect(report.fieldTypeCounts.REF).toBe(1)
    expect(report.fieldTypeCounts.PAGEREF).toBe(1)
    expect(report.staleFieldHints.length).toBeGreaterThan(0)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/fields.docx", bytes })
    expect(inspection.summary.fieldCount).toBeGreaterThanOrEqual(3)
    expect(inspection.summary.fieldTypeCounts.REF).toBe(1)
    expect(inspection.summary.fieldTypeCounts.PAGEREF).toBe(1)
    expect(inspection.summary.fieldTypeCounts.TOC).toBe(1)
    const refFields = inspection.fields.filter((field) => field.type === "REF" || field.type === "PAGEREF")
    expect(refFields.map((field) => field.type)).toEqual(["REF", "PAGEREF"])
    expect(refFields.map((field) => field.cachedText)).toEqual(["Referenced Section", "3"])
    expect(refFields.every((field) => field.fieldKind === "complex")).toBe(true)
    expect(inspection.fields.every((field) => field.locator.kind === "field")).toBe(true)
    expect(inspection.fields.some((field) => field.type === "TOC" && field.fieldKind === "simple")).toBe(true)
    expect(inspection.locators.some((locator) => locator.kind === "field" && locator.fieldType === "REF")).toBe(true)

    const flattened = await flattenRefFieldsInDocxBytes(bytes, "docs/fields.docx")
    expect(flattened.flattenedFields).toBe(2)
    expect(flattened.touchedParts).toContain("word/document.xml")
    expect(flattened.afterReport.fieldTypeCounts.REF ?? 0).toBe(0)
    expect(flattened.afterReport.fieldTypeCounts.PAGEREF ?? 0).toBe(0)
    const flattenedXml = await readDocxPart(flattened.bytes, "word/document.xml")
    expect(flattenedXml).not.toContain("<w:instrText")
    expect(flattenedXml).toContain('<w:t xml:space="preserve">Referenced Section</w:t>')
    expect(flattenedXml).toContain('<w:t xml:space="preserve">3</w:t>')

    const result = await new WordRefFieldFlattener(root).flatten({
      path: "docs/fields.docx",
      bytes,
      outputFilenameBase: "ref-fields-flattened",
    })
    expect(result.path).toMatch(/^\.chipmate\/docs\/ref-fields-flattened-.+\.docx$/)
    expect(result.structureCheckResult.ok).toBe(true)
    expect(result.flattenedFields).toBe(2)
    expect(existsSync(join(root, result.path))).toBe(true)
  })

  test("rich paragraph cross-reference markers are authored as live REF and PAGEREF fields", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [
      {
        id: "target",
        level: 1,
        title: "Referenced Section",
        bookmark: "sec_target",
        paragraphs: ["This section is the cross-reference target."],
      },
      {
        id: "refs",
        level: 1,
        title: "Generated Cross References",
        richParagraphs: [{
          runs: [{
            text: "See {{ref:sec_target|Referenced Section}} on page {{pageref:sec_target|3}}.",
          }],
        }],
      },
    ]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    expect(documentXml).not.toContain("{{ref:")
    expect(documentXml).not.toContain("{{pageref:")
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> REF sec_target \\h </w:instrText>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> PAGEREF sec_target \\h </w:instrText>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Referenced Section</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">3</w:t>')

    const report = await auditWordDocumentFields({ path: "docs/marker-crossrefs.docx", bytes })
    expect(report.fieldTypeCounts.REF).toBe(1)
    expect(report.fieldTypeCounts.PAGEREF).toBe(1)

    const flattened = await flattenRefFieldsInDocxBytes(bytes, "docs/marker-crossrefs.docx")
    expect(flattened.flattenedFields).toBe(2)
    expect(flattened.afterReport.fieldTypeCounts.REF ?? 0).toBe(0)
    expect(flattened.afterReport.fieldTypeCounts.PAGEREF ?? 0).toBe(0)
  })

  test("apply_word_document_edits converts rich paragraph cross-reference markers into live fields", async () => {
    const root = await tempDir("chipmate-word-edit-marker-crossrefs-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "target",
      level: 1,
      title: "Referenced Section",
      bookmark: "sec_target",
      paragraphs: ["This section is referenced by an inserted section."],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/edit-marker-crossrefs.docx", bytes })
    const validation = validateDocumentEditPlan({
      planId: "insert-marker-crossrefs",
      targetPath: "docs/edit-marker-crossrefs.docx",
      outputFilenameBase: "edit-marker-crossrefs",
      operations: [{
        type: "insertSection",
        locator: inspection.documentEndLocator,
        title: "Generated Cross References",
        level: 1,
        blocks: [{
          type: "richParagraph",
          paragraph: {
            runs: [{ text: "See {{ref:sec_target|Referenced Section}} on page {{pageref:sec_target|3}}." }],
          },
        }],
      }],
      warnings: [],
    }, inspection)
    expect(validation.ok).toBe(true)

    const result = await new WordDocumentEditor(root).apply({
      sourcePath: "docs/edit-marker-crossrefs.docx",
      bytes,
      inspection,
      plan: validation.plan!,
    })

    const outputBytes = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(outputBytes, "word/document.xml")
    expect(documentXml).not.toContain("{{ref:")
    expect(documentXml).not.toContain("{{pageref:")
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> REF sec_target \\h </w:instrText>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> PAGEREF sec_target \\h </w:instrText>')
    const inspectionAfter = await new WordDocumentInspector().inspect({ path: result.path, bytes: outputBytes })
    expect(inspectionAfter.summary.fieldTypeCounts.REF).toBe(1)
    expect(inspectionAfter.summary.fieldTypeCounts.PAGEREF).toBe(1)
    expect(result.structureCheckResult.ok).toBe(true)
  })

  test("materialize_word_seq_fields updates stale caption SEQ cached numbers without flattening fields", async () => {
    const root = await tempDir("chipmate-word-seq-materialize-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "captioned-assets",
      level: 1,
      title: "Captioned Assets",
      paragraphs: ["Figures and tables should keep live SEQ fields while cached numbers render deterministically."],
      figures: [
        {
          id: "fig-one",
          title: "First figure",
          caption: "First figure caption.",
          label: "Figure",
          bookmark: "fig_one",
          altText: "First figure",
          image: { contentType: "image/png", bytes: tinyPngBytes(), width: 160, height: 90 },
        },
        {
          id: "fig-two",
          title: "Second figure",
          caption: "Second figure caption.",
          label: "Figure",
          bookmark: "fig_two",
          altText: "Second figure",
          image: { contentType: "image/png", bytes: tinyPngBytes(), width: 160, height: 90 },
        },
      ],
      tables: [{
        headers: ["Name", "Value"],
        rows: [["alpha", "1"]],
        caption: "Table caption.",
        label: "Table",
        bookmark: "tbl_one",
      }],
    }]
    const bytes = await new WordDocBuilder().build(spec)
    const staleBytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => {
      let staleValue = 8
      return xml.replace(
        /(<w:r><w:fldChar w:fldCharType="begin"\/><\/w:r>[\s\S]*?<w:instrText xml:space="preserve"> SEQ (?:Figure|Table) \\[*] ARABIC <\/w:instrText>[\s\S]*?<w:fldChar w:fldCharType="separate"\/><\/w:r>)([\s\S]*?)(<w:r><w:fldChar w:fldCharType="end"\/><\/w:r>)/g,
        (_match, before, _cached, after) => `${before}<w:r><w:t xml:space="preserve">${staleValue += 1}</w:t></w:r>${after}`,
      )
    })
    const staleInspection = await new WordDocumentInspector().inspect({ path: "docs/stale-seq.docx", bytes: staleBytes })
    const staleSeqFields = staleInspection.fields.filter((field) => field.type === "SEQ")
    expect(staleSeqFields.map((field) => field.cachedText)).toEqual(["9", "10", "11"])

    const materialized = await materializeSeqFieldsInDocxBytes(staleBytes, "docs/stale-seq.docx")
    expect(materialized.materializedFields).toBe(3)
    expect(materialized.updatedFields).toBe(3)
    expect(materialized.touchedParts).toEqual(["word/document.xml"])
    expect(materialized.afterReport.fieldTypeCounts.SEQ).toBe(3)

    const materializedInspection = await new WordDocumentInspector().inspect({ path: "docs/stale-seq.docx", bytes: materialized.bytes })
    const materializedSeqFields = materializedInspection.fields.filter((field) => field.type === "SEQ")
    expect(materializedSeqFields.map((field) => field.instruction)).toEqual(["SEQ Figure \\* ARABIC", "SEQ Figure \\* ARABIC", "SEQ Table \\* ARABIC"])
    expect(materializedSeqFields.map((field) => field.cachedText)).toEqual(["1", "2", "1"])
    const materializedXml = await readDocxPart(materialized.bytes, "word/document.xml")
    expect(materializedXml).toContain('<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>')
    expect(materializedXml).toContain('<w:instrText xml:space="preserve"> SEQ Table \\* ARABIC </w:instrText>')
    expect(materializedXml).toContain('<w:fldChar w:fldCharType="begin"/>')
    expect(materializedXml).toContain('<w:fldChar w:fldCharType="end"/>')

    const result = await new WordSeqFieldMaterializer(root).materialize({
      path: "docs/stale-seq.docx",
      bytes: staleBytes,
      outputFilenameBase: "seq-fields-materialized",
    })
    expect(result.path).toMatch(/^\.chipmate\/docs\/seq-fields-materialized-.+\.docx$/)
    expect(result.structureCheckResult.ok).toBe(true)
    expect(result.materializedFields).toBe(3)
    expect(result.updatedFields).toBe(3)
    expect(existsSync(join(root, result.path))).toBe(true)
  })

  test("Word native field audit reports TOC PAGE NUMPAGES while refresh is remote-only unavailable", async () => {
    const root = await tempDir("chipmate-word-native-field-refresh-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      ...spec.layout,
      navigation: { mode: "field-toc" },
    }
    spec.sections = [
      {
        id: "overview",
        level: 1,
        title: "Overview",
        paragraphs: ["The table of contents should remain a Word-native TOC field."],
      },
      {
        id: "details",
        level: 1,
        title: "Details",
        paragraphs: Array.from({ length: 16 }, (_, index) => `Detail paragraph ${index + 1} keeps enough content for render verification.`),
      },
    ]
    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const footerXml = await readDocxPart(bytes, "word/footer1.xml")
    const settingsXml = await readDocxPart(bytes, "word/settings.xml")
    expect(documentXml).toContain('w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u" w:dirty="true"')
    expect(footerXml).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>')
    expect(footerXml).toContain('<w:instrText xml:space="preserve"> NUMPAGES </w:instrText>')
    expect(settingsXml).toContain('<w:updateFields w:val="true"/>')

    const report = await auditWordDocumentFields({ path: "docs/native-fields.docx", bytes })
    expect(report.fieldTypeCounts.TOC).toBe(1)
    expect(report.fieldTypeCounts.PAGE).toBe(1)
    expect(report.fieldTypeCounts.NUMPAGES).toBe(1)
    expect(report.unsupportedMaterialization.join("\n")).toContain("remote native field refresh is not implemented")

    const prepared = await prepareNativeFieldRefreshInDocxBytes(bytes, "docs/native-fields.docx")
    expect(prepared.preparedReport.fieldTypeCounts.TOC).toBe(1)
    expect(prepared.preparedReport.fieldTypeCounts.PAGE).toBe(1)
    expect(prepared.preparedReport.fieldTypeCounts.NUMPAGES).toBe(1)

    await expect(new WordNativeFieldRefresher(root).refresh({
      path: "docs/native-fields.docx",
      bytes,
      outputFilenameBase: "native-fields-refreshed",
      timeoutMs: 90_000,
    })).rejects.toThrow(/remote-render-only build/)
  }, 120_000)

  test("refresh_word_native_fields fails closed without probing local LibreOffice", async () => {
    const root = await tempDir("chipmate-word-native-field-refresh-unavailable-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      ...spec.layout,
      navigation: { mode: "field-toc" },
    }
    const bytes = await new WordDocBuilder().build(spec)
    await expect(new WordNativeFieldRefresher(root).refresh({
      path: "docs/native-fields.docx",
      bytes,
      outputFilenameBase: "native-fields-refreshed",
      timeoutMs: 1_000,
    })).rejects.toThrow(/does not run local LibreOffice\/soffice/)
    expect(existsSync(join(root, ".chipmate", "docs"))).toBe(false)
  })
})

describe("doc model provider request timeout", () => {
  test("requests JSON mode for rule extraction and falls back when unsupported", async () => {
    const requests: unknown[] = []
    const logs: string[] = []
    const provider = new ChipMateDocModelProvider({
      getSettings: () => ({
        ...remoteSettings(),
        provider: { ...remoteSettings().provider, maxTokens: 1024 },
      }),
      getApiKey: async () => "token",
      log: (message) => logs.push(message),
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")))
        if (requests.length === 1) {
          return new Response(JSON.stringify({ error: { message: "response_format json_object unsupported" } }), { status: 400, statusText: "Bad Request" })
        }
        return jsonChatResponse('{"chunkResults":[]}', "stop")
      },
    })

    const result = await provider.completeJson<{ chunkResults: unknown[] }>({
      purpose: "extract-rules-batch",
      system: "Return JSON",
      prompt: "extract",
    })

    expect(result.chunkResults).toEqual([])
    expect((requests[0] as { response_format?: unknown }).response_format).toEqual({ type: "json_object" })
    expect((requests[0] as { max_tokens?: number }).max_tokens).toBeUndefined()
    expect((requests[1] as { response_format?: unknown }).response_format).toBeUndefined()
    expect((requests[1] as { max_tokens?: number }).max_tokens).toBeUndefined()
    expect(logs.some((line) => line.includes("response_format unsupported"))).toBe(true)
  })

  test("logs parse diagnostics when the document model returns invalid JSON content", async () => {
    const logs: string[] = []
    const provider = new ChipMateDocModelProvider({
      getSettings: remoteSettings,
      getApiKey: async () => "token",
      log: (message) => logs.push(message),
      fetch: async () => jsonChatResponse("not-json", "length"),
    })

    await expect(provider.completeJson({
      purpose: "extract-rules",
      system: "Return JSON",
      prompt: "extract",
    })).rejects.toThrow(/Model did not return valid JSON.*finish_reason=length/)
    expect(logs.some((line) => line.includes("document model JSON parse failed") && line.includes("finish_reason=length") && line.includes("raw=not-json"))).toBe(true)
  })

  test("omits max_tokens from document model requests even when provider maxTokens is configured", async () => {
    const requests: Array<{ max_tokens?: number }> = []
    const provider = new ChipMateDocModelProvider({
      getSettings: () => ({
        ...remoteSettings(),
        provider: { ...remoteSettings().provider, maxTokens: 24_000 },
      }),
      getApiKey: async () => "token",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")))
        return jsonChatResponse('{"placements":[]}', "stop")
      },
    })

    await provider.completeJson({
      purpose: "plan-source-block-placement",
      system: "Return JSON",
      prompt: "{}",
    })

    expect(requests[0]?.max_tokens).toBeUndefined()
  })

  test("does not raise too-low provider maxTokens for document model requests", async () => {
    const requests: Array<{ max_tokens?: number }> = []
    const provider = new ChipMateDocModelProvider({
      getSettings: () => ({
        ...remoteSettings(),
        provider: { ...remoteSettings().provider, maxTokens: 1024 },
      }),
      getApiKey: async () => "token",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")))
        return jsonChatResponse('{"placements":[]}', "stop")
      },
    })

    await provider.completeJson({
      purpose: "plan-source-block-placement",
      system: "Return JSON",
      prompt: "{}",
    })

    expect(requests[0]?.max_tokens).toBeUndefined()
  })

  test("retries once with compatibility max_tokens when a provider requires it", async () => {
    const requests: Array<{ max_tokens?: number }> = []
    const logs: string[] = []
    const provider = new ChipMateDocModelProvider({
      getSettings: () => ({
        ...remoteSettings(),
        provider: { ...remoteSettings().provider, maxTokens: 1024 },
      }),
      getApiKey: async () => "token",
      log: (message) => logs.push(message),
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")))
        if (requests.length === 1) {
          return new Response(JSON.stringify({ error: { message: "max_tokens is required" } }), { status: 400, statusText: "Bad Request" })
        }
        return jsonChatResponse('{"placements":[]}', "stop")
      },
    })

    await provider.completeJson({
      purpose: "plan-source-block-placement",
      system: "Return JSON",
      prompt: "{}",
    })

    expect(requests[0]?.max_tokens).toBeUndefined()
    expect(requests[1]?.max_tokens).toBe(DOCUMENT_MODEL_COMPAT_MAX_TOKENS)
    expect(logs.some((line) => line.includes("provider requires max_tokens"))).toBe(true)
  })

  test("keeps long-running merge requests alive and emits soft waiting diagnostics", async () => {
    const logs: string[] = []
    const waiting: unknown[] = []
    const provider = new ChipMateDocModelProvider({
      getSettings: remoteSettings,
      getApiKey: async () => "token",
      softWaitMs: 5,
      log: (message) => logs.push(message),
      onStillWaiting: (event) => waiting.push(event),
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 18))
        return jsonChatResponse('{"rules":[],"warnings":[]}', "stop")
      },
    })

    const result = await provider.completeJson<{ rules: unknown[] }>({
      purpose: "merge-guidelines",
      system: "Return JSON",
      prompt: "merge",
    })

    expect(result.rules).toEqual([])
    expect(logs.some((line) => line.includes("[doc-agent] still waiting") && line.includes("purpose=merge-guidelines"))).toBe(true)
    expect(waiting.some((event) => typeof event === "object" && event !== null && (event as { purpose?: string }).purpose === "merge-guidelines")).toBe(true)
  })

  test("times out stalled document model requests", async () => {
    const provider = new ChipMateDocModelProvider({
      getSettings: remoteSettings,
      getApiKey: async () => "token",
      timeoutMs: 5,
      fetch: async () => await new Promise<Response>(() => {}),
    })

    await expect(provider.completeJson({
      purpose: "extract-rules",
      system: "Return JSON",
      prompt: "extract",
    })).rejects.toThrow(/timed out after 5ms.*purpose=extract-rules.*model=doc-model.*stage=fetch/)
  })

  test("aborts document model requests from the outer signal without waiting for timeout", async () => {
    const controller = new AbortController()
    const provider = new ChipMateDocModelProvider({
      getSettings: remoteSettings,
      getApiKey: async () => "token",
      timeoutMs: 10_000,
      fetch: async () => await new Promise<Response>(() => {}),
    })
    setTimeout(() => controller.abort(), 1)

    await expect(provider.completeJson({
      purpose: "extract-rules",
      system: "Return JSON",
      prompt: "extract",
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  test("aborts long-running document model requests from the outer signal", async () => {
    const controller = new AbortController()
    const provider = new ChipMateDocModelProvider({
      getSettings: remoteSettings,
      getApiKey: async () => "token",
      softWaitMs: 5,
      fetch: async () => await new Promise<Response>(() => {}),
    })
    setTimeout(() => controller.abort(), 1)

    await expect(provider.completeJson({
      purpose: "merge-guidelines",
      system: "Return JSON",
      prompt: "merge",
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("doc agent merge/spec/render", () => {
  test("uses fake model provider for merge and spec generation without provider calls", async () => {
    const model = new FakeModelProvider()
    const internalRead = await readDocx({
      path: "docs/company-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "公司内部 C 编码规范",
        sections: [{ heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] }],
      }),
    })
    const externalRead = await readDocx({
      path: "docs/external-c-guideline.docx",
      bytes: cGuidelineDocxFixture({
        title: "外部 C 编码规范参考",
        sections: [{ heading: "命名规范", paragraphs: ["应该避免缩写并保持命名一致。"] }],
      }),
    })
    const reference = new ReferenceDocExtractor()
    const documents = reference.classifyDocuments([{ id: "src-1", read: internalRead }, { id: "src-2", read: externalRead }])
    const chunks = documents.flatMap((doc) => reference.chunks(doc))
    const extracted = await new GuidelineRuleExtractor(model).extract(chunks)
    const pack = new EvidencePackBuilder().build({ documents, rules: extracted.rules })
    const merged = await new GuidelineMerger(model).merge(pack)
    const sections = new DocumentOutlinePlanner().build({ pack, rules: merged.rules })
    const spec = await new WordDocSpecGenerator(model).generate({
      question: "生成团队 C 语言编码规范 Word",
      documents,
      pack,
      rules: merged.rules,
      sections,
    })

    expect(merged.rules[0]?.name).toContain("指针")
    expect(spec.metadata.title).toContain("团队 C 语言编码规范")
    expect(spec.sections.some((section) => section.ruleCards?.length)).toBe(true)
  })

  test("normalizes English model rule cards into Chinese before examples and rendering", async () => {
    const plan = await minimalExamplePlan()
    const pack = evidencePackWithRules([{
      ...candidateRule("english-1"),
      title: "Use header guards",
      category: "Header guards",
      description: "Every header file should use include guards.",
      recommended: "Use header guards to prevent multiple inclusion.",
      discouraged: "Do not omit include guards.",
      rationale: "Header guards prevent duplicate definitions.",
      exceptions: "None.",
    }])

    const merged = await new GuidelineMerger(new EnglishRuleModelProvider()).merge(pack, plan)
    const rule = merged.rules[0]

    expect(rule?.name).toBe("使用头文件保护宏")
    expect(rule?.scope).toBe("头文件保护宏")
    expect(rule?.description).toContain("头文件")
    expect(`${rule?.name} ${rule?.scope} ${rule?.description}`).not.toMatch(/Use header guards|Header guards|Every header/i)
  })

  test("merges guideline rules in batches and falls back only the failed batch", async () => {
    const pack = evidencePackWithRules(Array.from({ length: 40 }, (_, index) => ({
      ...candidateRule(`merge-${index + 1}`),
      title: `批量合并规则 ${index + 1}`,
      category: index < 20 ? "指针与内存安全" : "错误处理",
      sourceSection: index < 20 ? "指针与内存安全" : "错误处理",
      description: `第 ${index + 1} 条候选规则说明。`,
    })))
    const progress: GuidelineMergeProgress[] = []
    const model = new PartialFailingMergeModelProvider(2)

    const merged = await new GuidelineMerger(model).merge(pack, await minimalExamplePlan(), undefined, {
      onProgress: (item) => progress.push(item),
    })

    expect(model.mergeCalls).toBeGreaterThan(1)
    expect(merged.rules.length).toBeGreaterThan(1)
    expect(merged.warnings.some((warning) => warning.includes("模型合并失败（第 2/"))).toBe(true)
    expect(progress.some((item) => item.stage === "guidelines-batch-warning" && item.batchIndex === 2)).toBe(true)
    expect(progress.some((item) => item.stage === "guidelines-batch-success")).toBe(true)
  })

  test("organizes rule cards by source role according to the document plan", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "single-section",
      externalRulePlacement: "main-body",
    })
    const internal = organizationRule("C-002", "内部规则", "internal")
    const external = organizationRule("C-001", "外部规则", "external")
    const unknown = organizationRule("C-003", "未知规则", "unknown")
    const sections = applyRuleOrganizationPlanToSections([
      { id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [external, unknown, internal] },
    ], plan)

    expect(sections[0]?.ruleCards?.map((rule) => rule.name)).toEqual(["内部规则", "外部规则", "未知规则"])
  })

  test("orders same-group numbered rules by natural rule id", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "single-section",
      externalRulePlacement: "main-body",
    })
    const sections = applyRuleOrganizationPlanToSections([
      { id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [
        organizationRule("C-015", "规则十五", "internal"),
        organizationRule("C-002", "规则二", "internal"),
        organizationRule("C-012", "规则十二", "internal"),
        organizationRule("C-001", "规则一", "internal"),
      ] },
    ], plan)

    expect(sections[0]?.ruleCards?.map((rule) => rule.ruleId)).toEqual(["C-001", "C-002", "C-012", "C-015"])
  })

  test("splits organized rule cards into source-role sections", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "split-by-source-role",
      externalRulePlacement: "main-body",
    })
    const sections = applyRuleOrganizationPlanToSections([
      { id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [
        organizationRule("C-001", "外部规则", "external"),
        organizationRule("C-002", "内部规则", "internal"),
        organizationRule("C-003", "未知规则", "unknown"),
      ] },
    ], plan)

    expect(sections.map((section) => section.id)).toEqual(["team-rules", "team-rules-internal", "team-rules-external", "team-rules-unknown"])
    expect(sections.find((section) => section.id === "team-rules")?.ruleCards).toBeUndefined()
    expect(sections.find((section) => section.id === "team-rules-internal")?.title).toBe("公司内部基线规则")
    expect(sections.find((section) => section.id === "team-rules-external")?.ruleCards?.[0]?.name).toBe("外部规则")
  })

  test("keeps natural rule id order inside split source-role sections", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "split-by-source-role",
      externalRulePlacement: "main-body",
    })
    const sections = applyRuleOrganizationPlanToSections([
      { id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [
        organizationRule("C-015", "规则十五", "internal"),
        organizationRule("C-002", "规则二", "internal"),
        organizationRule("C-012", "规则十二", "internal"),
        organizationRule("C-001", "规则一", "internal"),
        organizationRule("C-004", "外部规则四", "external"),
        organizationRule("C-003", "外部规则三", "external"),
      ] },
    ], plan)

    expect(sections.find((section) => section.id === "team-rules-internal")?.ruleCards?.map((rule) => rule.ruleId)).toEqual(["C-001", "C-002", "C-012", "C-015"])
    expect(sections.find((section) => section.id === "team-rules-external")?.ruleCards?.map((rule) => rule.ruleId)).toEqual(["C-003", "C-004"])
  })

  test("keeps non-numeric rule ids on the stable fallback path", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "single-section",
      externalRulePlacement: "main-body",
    })
    const sections = applyRuleOrganizationPlanToSections([
      { id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [
        organizationRule("RULE-A", "非数字规则 A", "internal"),
        organizationRule("C-STATIC", "非数字规则 Static", "internal"),
      ] },
    ], plan)

    expect(sections[0]?.ruleCards?.map((rule) => rule.ruleId)).toEqual(["RULE-A", "C-STATIC"])
  })

  test("moves external-only rules into an appendix when requested by the plan", () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "single-section",
      externalRulePlacement: "appendix",
    })
    const spec = applyRuleOrganizationPlanToSpec({
      metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
      sources: [],
      sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [
        organizationRule("C-001", "外部规则", "external"),
        organizationRule("C-002", "内部规则", "internal"),
      ] }],
      appendices: [],
    }, plan)

    expect(spec.sections.find((section) => section.id === "team-rules")?.ruleCards?.map((rule) => rule.name)).toEqual(["内部规则"])
    expect(spec.appendices?.find((section) => section.id === "appendix-external-rules")?.ruleCards?.map((rule) => rule.name)).toEqual(["外部规则"])
  })

  test("reapplies rule organization after a generated WordDocSpec shuffles rule order", async () => {
    const plan = normalizeDocumentPlan({
      ruleOrderingPolicy: "internal-first",
      ruleSectioningPolicy: "single-section",
      externalRulePlacement: "main-body",
    })
    const internal = organizationRule("C-001", "内部规则", "internal")
    const external = organizationRule("C-002", "外部规则", "external")
    const spec = await new WordDocSpecGenerator(new ShuffledRuleSpecModelProvider([external, internal])).generate({
      question: "公司内部规则放前面，行业通用规则放后面。",
      plan,
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [internal, external],
      sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [internal, external] }],
    })

    expect(spec.sections.find((section) => section.id === "team-rules")?.ruleCards?.map((rule) => rule.name)).toEqual(["内部规则", "外部规则"])
  })

  test("keeps Chinese fallback rule fields when generated WordDocSpec returns English rules", async () => {
    const plan = await minimalExamplePlan()
    const rule = sourceHeaderPairRule()
    const pack = evidencePackWithRules([candidateRule("source-header")])
    const spec = await new WordDocSpecGenerator(new EnglishWordSpecModelProvider()).generate({
      question: "生成团队 C 语言编码规范 Word",
      plan,
      documents: [],
      pack,
      rules: [rule],
      sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [rule] }],
    })

    const specRule = spec.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-001")
    expect(specRule?.name).toBe("源文件与头文件配对")
    expect(specRule?.description).toContain("一个 .c 文件必须有一个 .h 文件对应")
    expect(`${specRule?.name} ${specRule?.description}`).not.toMatch(/Use header guards|Every header/i)
  })

  test("reports an error when final zh-CN rules still contain English rule text", async () => {
    const plan = await minimalExamplePlan()
    const rule = {
      ...sourceHeaderPairRule(),
      name: "Use header guards",
      scope: "Header guards",
      description: "Every header file should use include guards.",
    }
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [rule],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [rule] }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.severity === "error" && issue.code === "non-chinese-rule-content")).toBe(true)
  })

  test("localizes English evidence summary categories before building source-summary tables", () => {
    const known = new EvidencePackBuilder().build({
      documents: [],
      rules: [{
        ...candidateRule("header-guards"),
        category: "Header guards",
      }],
    })
    const unknown = new EvidencePackBuilder().build({
      documents: [],
      rules: [{
        ...candidateRule("unknown-category"),
        category: "Project lifecycle policy",
      }],
    })

    expect(known.internalSummary.join("\n")).toContain("头文件保护宏")
    expect(known.internalSummary.join("\n")).not.toMatch(/Header guards/i)
    expect(unknown.internalSummary.join("\n")).toContain("通用编码原则")
    expect(unknown.warnings.some((warning) => warning.includes("候选规则分类") && warning.includes("通用编码原则"))).toBe(true)
  })

  test("normalizes English source-summary table cells before the quality gate", async () => {
    const plan = await minimalExamplePlan()
    const rule = sourceHeaderPairRule()
    const spec = await new WordDocSpecGenerator().generate({
      question: "生成团队 C 语言编码规范 Word",
      plan,
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [rule],
      sections: [{
        id: "source-summary",
        level: 1,
        title: "资料来源说明",
        tables: [{
          headers: ["来源类型", "摘要"],
          rows: [["公司内部规范", "Header guards：1 条候选规则"]],
        }],
      }],
    })
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [rule],
      spec,
      plan,
    })

    expect(spec.sections.find((section) => section.id === "source-summary")?.tables?.[0]?.rows[0]?.[1]).toContain("头文件保护宏")
    expect(issues.some((issue) => issue.severity === "error" && issue.code === "non-chinese-rule-content")).toBe(false)
  })

  test("allows source paths, C file names, and standard acronyms in report tables", async () => {
    const plan = await minimalExamplePlan()
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{
          id: "source-summary",
          level: 1,
          title: "资料来源说明",
          tables: [{
            headers: ["来源", "说明"],
            rows: [["本地资料", "docs/company-guideline.docx；motor.c / motor.h；MISRA、CERT、API"]],
          }],
        }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.severity === "error" && issue.code === "non-chinese-rule-content")).toBe(false)
  })

  test("still reports ordinary English prose in report tables when it is not normalized first", async () => {
    const plan = await minimalExamplePlan()
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{
          id: "source-summary",
          level: 1,
          title: "资料来源说明",
          tables: [{
            headers: ["来源", "说明"],
            rows: [["公司内部规范", "Use header guards to prevent multiple inclusion."]],
          }],
        }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.severity === "error" && issue.message.includes("source-summary.tables.0.rows.0.1"))).toBe(true)
  })

  test("filters non-rule external sections before building formal rule cards", () => {
    const gate = new CandidateRuleQualityGate()
    const result = gate.filter([
      {
        ...candidateRule("impl-guidance"),
        sourceRole: "external",
        sourceOrigin: "external_public",
        sourceContentKind: "implementation-guidance",
        title: "高风险模块引入安全规则集",
        sourceSection: "9. 静态检查和落地建议",
        sourceDocument: "docs/external-c-guideline.docx",
        sourceLocation: { path: "docs/external-c-guideline.docx", headingPath: ["9. 静态检查和落地建议"] },
      },
      {
        ...candidateRule("risk-limit"),
        sourceRole: "external",
        sourceOrigin: "external_public",
        sourceContentKind: "risk-limit",
        title: "版权边界",
        description: "该内容用于说明公开资料使用限制。",
        sourceSection: "10. 风险、限制与后续完善",
        sourceDocument: "docs/external-c-guideline.docx",
        sourceLocation: { path: "docs/external-c-guideline.docx", headingPath: ["10. 风险、限制与后续完善"] },
      },
      {
        ...candidateRule("appendix-index"),
        sourceRole: "external",
        sourceOrigin: "external_public",
        sourceContentKind: "appendix-index",
        title: "生成专属规范",
        sourceSection: "附录 A. 规则分类速查表",
        sourceDocument: "docs/external-c-guideline.docx",
        sourceLocation: { path: "docs/external-c-guideline.docx", headingPath: ["附录 A. 规则分类速查表"] },
      },
    ])

    expect(result.rules).toHaveLength(0)
    expect(result.rejected.map((rule) => rule.id)).toEqual(["impl-guidance", "risk-limit", "appendix-index"])
    expect(result.warnings.join("\n")).toContain("静态检查和落地建议")
    expect(result.warnings.join("\n")).toContain("风险、限制")
    expect(result.warnings.join("\n")).toContain("附录 A")
  })

  test("deduplicates matrix and core rule cards for the same guideline topic", async () => {
    const pack = evidencePackWithRules([
      {
        ...candidateRule("C-GEN-004"),
        title: "函数保持单一职责",
        category: "快速规则矩阵",
        description: "函数应该保持单一职责。",
        sourceContentKind: "rule-matrix",
        sourceSection: "快速规则矩阵",
      },
      {
        ...candidateRule("C-RULE-003"),
        title: "函数保持单一职责",
        category: "函数设计",
        description: "每个函数应只承担一个清晰职责。",
        sourceContentKind: "core-rule",
        sourceSection: "5. 核心规则卡片",
      },
    ])

    const merged = await new GuidelineMerger().merge(pack, await minimalExamplePlan())

    expect(merged.rules.filter((rule) => rule.name.includes("函数保持单一职责"))).toHaveLength(1)
  })

  test("rejects source block placements whose semantics do not match the target rule", () => {
    const validation = validateCCodingGuidelineSourcePlacement({
      rule: placementRule({
        ruleId: "RULE-ERR",
        name: "错误返回值必须处理",
        scope: "错误处理",
        description: "可能失败的函数调用必须检查返回值。",
      }),
      block: placementBlock({
        id: "volatile-example",
        text: "volatile 不替代临界区，寄存器轮询必须考虑并发访问。",
        source: { headingPath: ["6.5 volatile 不替代临界区"] },
      }),
      placement: { blockId: "volatile-example", targetRuleId: "RULE-ERR", placement: "preserved-example", confidence: 0.9 },
    })

    expect(validation.ok).toBe(false)
    expect(validation.warning).toContain("语义不匹配")
  })

  test("uses a centralized semantic registry for rule classification and fallback examples", () => {
    const cases = [
      ["file-layout", "源文件与头文件必须配对，公开接口通过 .h 声明，实现文件包含对应头文件。"],
      ["naming", "命名必须表达模块、动作和单位，避免无语义缩写。"],
      ["comment", "注释必须解释代码意图和约束，注释风格遵循团队约定。"],
      ["function-design", "函数必须保持单一职责，接口参数和返回值表达完整契约。"],
      ["error-handling", "错误返回值必须检查和处理，失败路径不能被静默忽略。"],
      ["pointer-memory", "缓冲区访问和 memcpy 前必须检查指针、长度和容量边界。"],
      ["pointer-null-comparison", "指针与零值比较必须显式使用 ptr == NULL 或 ptr != NULL。"],
      ["pointer-operator-spacing", "指针和地址操作符后不能有空格，例如 int *ptr、&value。"],
      ["pointer-initialization", "声明指针时必须初始化，禁止未初始化指针和野指针。"],
      ["trailing-whitespace", "行尾无意义留白和水平留白不得提交。"],
      ["assignment-operator-spacing", "赋值运算符前后必须保留空格。"],
      ["unary-operator-spacing", "一元操作符与操作数之间不加空格。"],
      ["binary-operator-spacing", "二元运算符前后必须保留空格。"],
      ["postfix-operator-spacing", "数组下标、成员运算符和函数调用必须紧邻对象。"],
      ["pragma-pack-pairing", "#pragma pack 必须成对设置和恢复。"],
      ["variable-scope", "变量应保持最小作用域并就近声明。"],
      ["global-state", "减少静态全局变量和跨文件全局状态。"],
      ["type-definition", "自定义数据类型和固定宽度类型必须表达数据大小。"],
      ["literal-constant", "非平凡数字和魔法数必须定义为有意义的常量名称。"],
      ["operator-precedence", "不确定运算符优先级时必须使用括号。"],
      ["sizeof-usage", "使用 sizeof(varname) 代替 sizeof(type)。"],
      ["expression-complexity", "复杂表达式必须拆分为简单语句。"],
      ["reentrancy", "可重入函数必须使用局部变量或上下文状态。"],
      ["external-state-mutability", "不变量可能被外部修改时必须重新确认状态。"],
      ["brace-style", "大括号和程序块分界符必须独占一行。"],
      ["const-correctness", "只读输入参数必须使用 const 指针。"],
      ["integer-type", "整数类型、索引和强制转换必须检查溢出与截断风险。"],
      ["macro-constant", "宏、枚举和常量名称必须包含模块前缀、业务含义和单位。"],
      ["constant-left-comparison", "相等比较应采用常量左置或右值左置，例如 NULL == ptr。"],
      ["parameter-passing", "函数接口必须明确传值还是传址，区分只读输入和输出参数。"],
      ["volatile-register", "volatile 寄存器访问不能替代临界区和并发控制。"],
      ["isr", "ISR 中断服务函数必须短小确定，只设置标志并延后复杂处理。"],
      ["bounded-loop", "循环和轮询必须有明确上界、超时或最大重试次数。"],
      ["recursion", "嵌入式场景应避免无界递归，必要时证明最大递归深度。"],
      ["static-analysis", "静态检查、编译警告和 CI 扫描必须解释、修复或记录偏差。"],
      ["formatting", "格式化、缩进、空格和对齐必须遵循团队统一排版规则。"],
      ["dynamic-memory", "动态内存 malloc/free 在关键路径中应避免或有明确失败释放路径。"],
      ["undefined-behavior", "移位、除零和 signed overflow 等未定义行为必须避免。"],
      ["determinism", "实时路径执行时间必须确定且可预测，满足嵌入式确定性要求。"],
      ["memory-consistency", "多核或多主设备共享变量访问必须保证 cache、barrier 和原子性一致。"],
      ["checklist", "Code Review checklist 必须覆盖必须级规则、例外记录和高风险检查项。"],
    ] as const

    for (const [kind, text] of cases) {
      expect(inferSemanticKindFromText(text)).toBe(kind)
      const fallback = exampleForSemanticKind(kind as any)
      expect(fallback).toBeTruthy()
      const rule: RuleCardSpec = {
        ruleId: `SEM-${kind}`,
        name: text.split("，")[0] ?? kind,
        priority: "应该",
        scope: text,
        description: text,
        recommended: text,
        discouraged: `不要违反规则：${text}`,
        rationale: "该规则需要通过示例帮助团队评审和落地。",
        exceptions: "无",
        sources: [`src:${kind}`],
        generatedExamples: fallback ? [{
          id: `SEM-${kind}-example`,
          title: "补充示例：根据规则生成",
          explanation: "该示例根据团队规则含义生成，用于帮助评审和落地，不是原文摘录。",
          sourceRefs: [`src:${kind}`],
          generationMode: "model-generated-from-rule",
          origin: "generated",
          isVerbatim: false,
          ...fallback,
        }] : [],
      }
      const issues = collectCGuidelineRuleQualityIssues([rule]).filter((issue) => issue.code === "rule-example-mismatch")
      expect(issues, `${kind}: ${issues.map((issue) => issue.message).join("\n")}`).toHaveLength(0)
    }
  })

  test("keeps neighboring semantic kinds from stealing each other's examples", () => {
    const collisions = [
      ["声明指针时必须初始化，禁止未初始化指针造成未定义行为。", "pointer-initialization", "pointer-operator-spacing"],
      ["指针和地址操作符后不能有空格，例如 int *ptr 和 &value。", "pointer-operator-spacing", "pointer-initialization"],
      ["指针与零值比较必须显式使用 NULL。", "pointer-null-comparison", "pointer-memory"],
      ["定义有意义的常量名称，宏名必须包含模块前缀和单位。", "literal-constant", "bounded-loop"],
      ["循环必须有明确上界、超时或最大重试次数。", "bounded-loop", "macro-constant"],
      ["明确传值还是传址，简单标量传值，结构体使用 const 指针。", "parameter-passing", "comment"],
      ["静态扫描及警告解读必须进入 CI 闭环。", "static-analysis", "file-layout"],
      ["volatile 寄存器访问不能替代临界区。", "volatile-register", "bounded-loop"],
      ["赋值运算符前后必须保留空格。", "assignment-operator-spacing", "formatting"],
      ["数组下标、成员运算符和函数调用必须紧邻对象。", "postfix-operator-spacing", "formatting"],
      ["非平凡数字必须定义为有意义常量。", "literal-constant", "naming"],
      ["#pragma pack 必须成对恢复。", "pragma-pack-pairing", "file-layout"],
    ] as const

    for (const [text, expected, rejected] of collisions) {
      const kind = inferSemanticKindFromText(text)
      expect(kind).toBe(expected)
      expect(kind).not.toBe(rejected)
    }
  })

  test("plans examples with formats that match static analysis, loop, ISR, and naming rules", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const rules = new CCodingGuidelineExamplePlanner(plan).attachExamples([
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-STATIC",
        name: "编译警告和静态分析闭环",
        scope: "静态检查",
        description: "新增告警必须修复或记录偏差。",
      },
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-LOOP",
        name: "循环必须设置上界或超时",
        scope: "控制流",
        description: "轮询和等待循环必须有明确退出条件。",
      },
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-ISR",
        name: "ISR 保持短小确定",
        scope: "中断处理",
        description: "中断服务函数只设置标志并延后复杂处理。",
      },
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-NAME",
        name: "命名必须表达语义",
        scope: "命名规范",
        description: "变量和函数命名应体现模块、动作和单位。",
      },
    ])

    const staticExample = rules.find((rule) => rule.ruleId === "C-STATIC")?.generatedExamples?.[0]
    const loopExample = rules.find((rule) => rule.ruleId === "C-LOOP")?.generatedExamples?.[0]
    const isrExample = rules.find((rule) => rule.ruleId === "C-ISR")?.generatedExamples?.[0]
    const namingExample = rules.find((rule) => rule.ruleId === "C-NAME")?.generatedExamples?.[0]

    expect(staticExample?.exampleFormat).toBe("checklist")
    expect(`${staticExample?.badExample}\n${staticExample?.goodExample}`).not.toMatch(/motor\.h|motor\.c/)
    expect(loopExample?.goodExample).toMatch(/timeout|ETIMEDOUT/)
    expect(isrExample?.goodExample).toMatch(/IRQHandler|uart_rx_pending|parse_packet/)
    expect(namingExample?.exampleFormat).toBe("naming-pair")
    expect(`${namingExample?.badExample}\n${namingExample?.goodExample}`).not.toMatch(/overflow|memcpy/)
  })

  test("repairs mismatched generated examples before the quality gate", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const rules = [
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-STATIC",
        name: "静态扫描及警告解读",
        scope: "静态检查",
        description: "编译器警告和静态扫描结果必须解释、修复或记录偏差。",
        generatedExamples: [fileLayoutGeneratedExample("C-STATIC")],
      },
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-MACRO",
        name: "宏命名规则",
        scope: "宏、枚举、常量",
        description: "宏命名必须体现模块前缀、单位和取值语义。",
        generatedExamples: [volatileGeneratedExample("C-MACRO")],
      },
      {
        ...sourceHeaderPairRule(),
        ruleId: "C-LOOP",
        name: "循环必须有明确上界",
        scope: "控制流",
        description: "循环和轮询必须有最大重试次数、超时或明确 break 条件。",
        generatedExamples: [namingGeneratedExample("C-LOOP")],
      },
    ]

    const repaired = new CCodingGuidelineExamplePlanner(plan).repairExamples(rules)
    const issues = collectCGuidelineRuleQualityIssues(repaired.rules)

    expect(repaired.warnings.filter((warning) => warning.includes("已重新生成不匹配示例")).length).toBe(0)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
    expect(repaired.rules.find((rule) => rule.ruleId === "C-STATIC")?.generatedExamples?.[0]?.exampleFormat).toBe("checklist")
    expect(repaired.rules.find((rule) => rule.ruleId === "C-MACRO")?.generatedExamples?.[0]?.goodExample).toContain("#define SENSOR_TIMEOUT_MS")
    expect(repaired.rules.find((rule) => rule.ruleId === "C-LOOP")?.generatedExamples?.[0]?.goodExample).toMatch(/MAX_RETRY_COUNT|ETIMEDOUT/)
  })

  test("keeps obvious mismatched generated examples as quality errors when repair is not applied", () => {
    const staticRule = {
      ...sourceHeaderPairRule(),
      ruleId: "C-STATIC",
      name: "静态扫描及警告解读",
      scope: "静态检查",
      description: "编译器警告和静态扫描结果必须解释、修复或记录偏差。",
      generatedExamples: [fileLayoutGeneratedExample("C-STATIC")],
    }
    const macroRule = {
      ...sourceHeaderPairRule(),
      ruleId: "C-MACRO",
      name: "宏命名规则",
      scope: "宏、枚举、常量",
      description: "宏命名必须体现模块前缀、单位和取值语义。",
      generatedExamples: [volatileGeneratedExample("C-MACRO")],
    }
    const loopRule = {
      ...sourceHeaderPairRule(),
      ruleId: "C-LOOP",
      name: "循环必须有明确上界",
      scope: "控制流",
      description: "循环和轮询必须有最大重试次数、超时或明确 break 条件。",
      generatedExamples: [namingGeneratedExample("C-LOOP")],
    }

    const issues = collectCGuidelineRuleQualityIssues([staticRule, macroRule, loopRule])

    expect(issues.filter((issue) => issue.code === "rule-example-mismatch")).toHaveLength(3)
    expect(issues.map((issue) => issue.message).join("\n")).toContain("exampleFormat")
    expect(issues.map((issue) => issue.message).join("\n")).toContain("示例标题")
  })

  test("uses model example intents for NULL comparison and constant-left comparison rules", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const rules = [nullComparisonRule(), constantLeftComparisonRule()]
    const intentResult = await new CCodingGuidelineExampleIntentPlanner(new RuleExampleIntentModelProvider("valid")).plan({
      question: "每条规则的示例必须符合当前规则含义。",
      plan,
      rules,
    })

    const repaired = new CCodingGuidelineExamplePlanner(plan, { intents: intentResult.intents }).repairExamples(rules)
    const nullExample = repaired.rules.find((rule) => rule.ruleId === "C-NULL")?.generatedExamples?.[0]
    const leftExample = repaired.rules.find((rule) => rule.ruleId === "C-LEFT")?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues(repaired.rules)

    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
    expect(`${nullExample?.badExample}\n${nullExample?.goodExample}`).toContain("ptr == NULL")
    expect(`${nullExample?.badExample}\n${nullExample?.goodExample}`).not.toContain("memcpy")
    expect(`${leftExample?.badExample}\n${leftExample?.goodExample}`).toContain("NULL == ptr")
    expect(`${leftExample?.badExample}\n${leftExample?.goodExample}`).not.toMatch(/SENSOR_TIMEOUT_MS|typedef enum/)
    expect(nullExample?.semanticIntent?.mustAvoid.join(" ")).toContain("memcpy")
  })

  test("repairs mismatched model draft examples before falling back", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const model = new RuleExampleIntentModelProvider("bad-first-draft")
    const rules = [nullComparisonRule()]

    const intentResult = await new CCodingGuidelineExampleIntentPlanner(model).plan({
      question: "每条规则的示例必须符合当前规则含义。",
      plan,
      rules,
    })
    const repaired = new CCodingGuidelineExamplePlanner(plan, { intents: intentResult.intents }).repairExamples(rules)
    const example = repaired.rules[0]?.generatedExamples?.[0]

    expect(model.exampleIntentCalls).toBeGreaterThanOrEqual(2)
    expect(intentResult.warnings.some((warning) => warning.includes("模型示例草案未通过语义校验"))).toBe(true)
    expect(`${example?.badExample}\n${example?.goodExample}`).toContain("ptr != NULL")
    expect(`${example?.badExample}\n${example?.goodExample}`).not.toContain("memcpy")
  })

  test("falls back locally when example intent planning fails without emitting generic templates", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const rules = [nullComparisonRule(), constantLeftComparisonRule()]
    const intentResult = await new CCodingGuidelineExampleIntentPlanner(new RuleExampleIntentModelProvider("throw")).plan({
      question: "每条规则的示例必须符合当前规则含义。",
      plan,
      rules,
    })

    const repaired = new CCodingGuidelineExamplePlanner(plan, { intents: intentResult.intents }).repairExamples(rules)
    const combined = repaired.rules.flatMap((rule) => rule.generatedExamples ?? []).map((example) => `${example.badExample}\n${example.goodExample}`).join("\n")
    const issues = collectCGuidelineRuleQualityIssues(repaired.rules)

    expect(intentResult.warnings.some((warning) => warning.includes("示例语义规划失败") || warning.includes("批次失败"))).toBe(true)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
    expect(combined).toContain("ptr == NULL")
    expect(combined).toContain("NULL == ptr")
    expect(combined).not.toMatch(/memcpy\(buffer|SENSOR_TIMEOUT_MS|typedef enum/)
  })

  test("rejects comparison-rule examples that reuse generic pointer or macro templates before repair", () => {
    const nullRule = {
      ...nullComparisonRule(),
      generatedExamples: [memcpyGeneratedExample("C-NULL")],
    }
    const leftRule = {
      ...constantLeftComparisonRule(),
      generatedExamples: [macroNamingGeneratedExample("C-LEFT")],
    }

    const issues = collectCGuidelineRuleQualityIssues([nullRule, leftRule])

    expect(issues.filter((issue) => issue.code === "rule-example-mismatch")).toHaveLength(2)
    expect(issues.map((issue) => issue.message).join("\n")).toContain("pointer-null-comparison")
    expect(issues.map((issue) => issue.message).join("\n")).toContain("constant-left-comparison")
  })

  test("intent mustAvoid contract rejects otherwise plausible generated examples", () => {
    const rule = {
      ...nullComparisonRule(),
      generatedExamples: [{
        ...memcpyGeneratedExample("C-NULL"),
        semanticIntent: {
          summary: "指针显式 NULL 比较",
          objective: "示例必须体现显式 NULL 比较。",
          mustInclude: ["显式 NULL 指针比较"],
          mustAvoid: ["memcpy buffer 模板"],
          confidence: 0.9,
        },
      }],
    }

    const issues = collectCGuidelineRuleQualityIssues([rule])

    expect(issues.some((issue) => issue.message.includes("mustAvoid"))).toBe(true)
  })

  test("plans pointer and address operator spacing examples as code, not checklist", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const [rule] = new CCodingGuidelineExamplePlanner(plan).attachExamples([{
      ...sourceHeaderPairRule(),
      ruleId: "C-PTR-SPACE",
      name: "指针/地址操作符后不能有空格",
      scope: "指针声明和地址操作表达式",
      description: "指针声明、解引用和取地址表达式中，指针/地址操作符后不能有空格。",
      recommended: "使用 int *ptr、*ptr 和 &value。",
      discouraged: "不要写成 int * ptr、* ptr 或 & value。",
    }])
    const example = rule?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues([rule!])

    expect(example?.exampleFormat).toBe("code")
    expect(`${example?.badExample}\n${example?.goodExample}`).toMatch(/int \* ptr/)
    expect(`${example?.badExample}\n${example?.goodExample}`).toMatch(/int \*ptr/)
    expect(`${example?.badExample}\n${example?.goodExample}`).toMatch(/& value/)
    expect(`${example?.badExample}\n${example?.goodExample}`).toMatch(/&value/)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
  })

  test("does not turn generic pointer declaration intent into operator-spacing requirements", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const intents = new Map<string, any>([["C-PTR-INIT", {
      ruleId: "C-PTR-INIT",
      semanticSummary: "声明指针时必须初始化，避免未初始化指针导致未定义行为。",
      exampleObjective: "示例必须体现指针声明后的初始化和使用前检查。",
      exampleFormat: "code",
      exampleType: "bad-good-pair",
      mustInclude: ["指针声明"],
      mustAvoid: ["指针或地址操作符空格对比"],
      badExampleFocus: "声明指针后未初始化就使用。",
      goodExampleFocus: "声明时初始化为 NULL，并在使用前赋值和检查。",
      confidence: 0.9,
      reason: "测试指针声明宽泛约束不应误归一为空格规则。",
    }]])
    const result = new CCodingGuidelineExamplePlanner(plan, { intents }).repairExamples([{
      ...sourceHeaderPairRule(),
      ruleId: "C-PTR-INIT",
      name: "声明指针时必须初始化",
      scope: "指针声明和使用",
      description: "指针变量声明时必须初始化为 NULL 或有效对象地址，避免未初始化指针造成未定义行为。",
      recommended: "声明指针时立即初始化为 NULL 或有效对象地址，并在解引用前检查。",
      discouraged: "不要声明未初始化指针，也不要在赋值前解引用或传递该指针。",
    }])
    const rule = result.rules[0]
    const example = rule?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues(result.rules)
    const combined = `${example?.badExample}\n${example?.goodExample}`

    expect(example?.exampleFormat).toBe("code")
    expect(example?.semanticIntent?.mustInclude).toHaveLength(0)
    expect(example?.semanticIntent?.softHints).toContain("指针声明")
    expect(result.warnings.some((warning) => warning.includes("已降级为提示"))).toBe(false)
    expect(combined).toContain("sensor_state_t *state;")
    expect(combined).toContain("sensor_state_t *state = NULL;")
    expect(combined).not.toMatch(/int \* ptr|& value/)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
  })

  test("uses high-confidence intent to repair a generic external rule into constant naming semantics", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const intents = new Map<string, any>([["C-EXT", {
      ruleId: "C-EXT",
      semanticSummary: "常量名称必须表达业务含义。",
      exampleObjective: "示例必须体现定义有意义的常量名称。",
      exampleFormat: "code",
      exampleType: "bad-good-pair",
      mustInclude: ["定义有意义的常量名称"],
      mustAvoid: ["循环 timeout 模板"],
      badExampleFocus: "常量名缺少模块和单位。",
      goodExampleFocus: "常量名包含模块前缀和单位。",
      confidence: 0.9,
      reason: "模型识别该外部参考规则实际讨论常量命名。",
    }]])
    const result = new CCodingGuidelineExamplePlanner(plan, { intents }).repairExamples([{
      ...sourceHeaderPairRule(),
      ruleId: "C-EXT",
      name: "外部参考规则",
      scope: "控制流",
      description: "外部参考资料提示循环必须有明确上界，但当前模型意图识别为常量命名。",
      recommended: "按来源原则执行。",
      discouraged: "不要保留模糊命名。",
    }])
    const rule = result.rules[0]
    const example = rule?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues(result.rules)

    expect(rule?.name).toBe("非平凡数字必须定义为有意义常量")
    expect(example?.goodExample).toMatch(/#define SENSOR_(?:TIMEOUT_MS|MAX_SAMPLE_COUNT)/)
    expect(`${example?.badExample}\n${example?.goodExample}`).not.toMatch(/MAX_RETRY_COUNT|ETIMEDOUT/)
    expect(example?.semanticIntent?.softHints ?? []).toHaveLength(0)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
  })

  test("plans value-vs-address parameter passing examples instead of comment examples", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const [rule] = new CCodingGuidelineExamplePlanner(plan).attachExamples([{
      ...sourceHeaderPairRule(),
      ruleId: "C-PARAM",
      name: "明确传值还是传址",
      scope: "函数接口参数设计",
      description: "函数参数必须明确采用值传递还是指针传递，简单标量传值，结构体和输出参数传址。",
      recommended: "简单标量参数使用传值；结构体只读输入使用 const 指针。",
      discouraged: "不要对简单标量无故传指针，也不要让大结构体隐式按值复制。",
    }])
    const example = rule?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues([rule!])

    expect(example?.exampleFormat).toBe("code")
    expect(`${example?.badExample}\n${example?.goodExample}`).toContain("uint32_t timeout_ms")
    expect(`${example?.badExample}\n${example?.goodExample}`).toContain("const sensor_config_t *config")
    expect(`${example?.badExample}\n${example?.goodExample}`).not.toMatch(/\/\* 配置采样周期|\/\/\//)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
  })

  test("downgrades unverifiable model mustInclude to soft hints without blocking generation", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例。")
    const intents = new Map<string, any>([["C-NULL", {
      ruleId: "C-NULL",
      semanticSummary: "指针与零值比较时应显式使用 NULL。",
      exampleObjective: "示例必须体现当前规则。",
      exampleFormat: "code",
      exampleType: "bad-good-pair",
      mustInclude: ["一眼就能看出团队风格"],
      mustAvoid: ["memcpy buffer 模板"],
      badExampleFocus: "隐式指针判断。",
      goodExampleFocus: "显式 NULL 判断。",
      confidence: 0.9,
      reason: "测试模糊约束降级。",
    }]])
    const repaired = new CCodingGuidelineExamplePlanner(plan, { intents }).repairExamples([nullComparisonRule()])
    const example = repaired.rules[0]?.generatedExamples?.[0]
    const issues = collectCGuidelineRuleQualityIssues(repaired.rules)

    expect(example?.semanticIntent?.mustInclude).toHaveLength(0)
    expect(example?.semanticIntent?.softHints).toContain("一眼就能看出团队风格")
    expect(repaired.warnings.some((warning) => warning.includes("已降级为提示"))).toBe(false)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(false)
  })

  test("normalizes English bad example reasons before the quality gate", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例，并在不推荐示例中给出不推荐原因。")
    const repaired = new CCodingGuidelineExamplePlanner(plan).repairExamples([{
      ...nullComparisonRule(),
      generatedExamples: [{
        ...{
          id: "C-NULL-english-reason",
          title: "补充示例：显式 NULL 指针比较",
          language: "c",
          exampleFormat: "code" as const,
          exampleType: "bad-good-pair",
          badExample: "if (ptr) {\n    use_value(ptr);\n}",
          badExampleReason: "This hides the pointer validity check from reviewers.",
          goodExample: "if (ptr != NULL) {\n    use_value(ptr);\n}",
          explanation: "该示例体现显式 NULL 比较，不是原文摘录。",
          sourceRefs: ["src-1:null"],
          generationMode: "model-generated-from-rule" as const,
          origin: "generated" as const,
          isVerbatim: false as const,
        },
      }],
    }])
    const example = repaired.rules[0]?.generatedExamples?.[0]
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: emptyEvidencePack(),
      rules: repaired.rules,
      spec: minimalSpecWithRules(repaired.rules),
      plan,
    })

    expect(example?.badExampleReason).not.toContain("This hides")
    expect(issues.some((issue) => issue.severity === "error" && issue.message.includes("badExampleReason"))).toBe(false)
  })

  test("reports placeholder rule card content and mismatched examples as quality errors", () => {
    const badRule = {
      ...sourceHeaderPairRule(),
      ruleId: "C-BAD",
      name: "高风险模块引入安全规则集",
      scope: "静态检查",
      description: "该规则来自本地参考资料，已纳入团队规则草案，具体表述需结合来源依据在评审中确认。",
      recommended: "推荐按团队约定执行：文件与头文件组织规范。",
      generatedExamples: [{
        id: "bad-static-example",
        title: "补充示例：根据规则生成",
        exampleFormat: "file-layout" as const,
        exampleType: "bad-good-pair",
        badExample: "// motor.c\nint motor_init(void) { return 0; }",
        goodExample: "// motor.h\nint motor_init(void);",
        explanation: "该示例用于说明团队规则的落地方式，不是原文摘录。",
        sourceRefs: ["src-2:9. 静态检查和落地建议:hash"],
        generationMode: "model-generated-from-rule" as const,
        origin: "generated" as const,
        isVerbatim: false as const,
      }],
    }
    const issues = collectCGuidelineRuleQualityIssues([badRule])

    expect(issues.some((issue) => issue.code === "rule-placeholder-content")).toBe(true)
    expect(issues.some((issue) => issue.code === "rule-example-mismatch")).toBe(true)
  })

  test("does not treat code or file-layout generated examples as untranslated rule prose", async () => {
    const plan = await minimalExamplePlan()
    const rule = {
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "layout-example",
        title: "补充示例：根据规则生成",
        exampleFormat: "file-layout" as const,
        exampleType: "bad-good-pair",
        badExample: "// motor.c\nint motor_init(const motor_config_t *config)\n{\n    return 0;\n}",
        goodExample: "// motor.h\n#ifndef MOTOR_H\n#define MOTOR_H\nint motor_init(const motor_config_t *config);\n#endif\n\n// motor.c\n#include \"motor.h\"",
        explanation: "该示例用于说明团队规则的落地方式，不是原文摘录。",
        sourceRefs: ["src-1:文件结构:hash"],
        generationMode: "model-generated-from-rule" as const,
        origin: "generated" as const,
        isVerbatim: false as const,
      }],
    }
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [rule],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [rule] }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.severity === "error" && issue.code === "non-chinese-rule-content")).toBe(false)
  })

  test("still rejects untranslated prose in text generated examples", async () => {
    const plan = await minimalExamplePlan()
    const rule = {
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "text-example",
        title: "补充示例：根据外部参考原则改写",
        exampleFormat: "text" as const,
        exampleType: "source-adapted",
        goodExample: "Use header guards to prevent multiple inclusion.",
        explanation: "该示例用于说明团队规则的落地方式，不是原文摘录。",
        sourceRefs: ["src-2:Header guards:hash"],
        generationMode: "adapted-from-source" as const,
        origin: "adapted" as const,
        isVerbatim: false as const,
      }],
    }
    const issues = new ReportQualityGate().check({
      documents: [],
      pack: evidencePackWithRules([]),
      rules: [rule],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{ id: "team-rules", level: 1, title: "团队版规则正文", ruleCards: [rule] }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.severity === "error" && issue.message.includes("generatedExamples.goodExample"))).toBe(true)
  })

  test("normalizes English generated example title and text fallback before quality gate", async () => {
    const plan = await minimalExamplePlan()
    const normalized = normalizeRuleCardForPlan({
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "text-example",
        title: "Supplemental Example",
        exampleFormat: "text" as const,
        exampleType: "source-adapted",
        goodExample: "Use header guards to prevent multiple inclusion.",
        explanation: "Adapted from source material.",
        sourceRefs: ["src-2:Header guards:hash"],
        generationMode: "adapted-from-source" as const,
        origin: "adapted" as const,
        isVerbatim: false as const,
      }],
    }, plan)
    const example = normalized.generatedExamples?.[0]

    expect(example?.title).toBe("补充示例")
    expect(example?.goodExample).toBe("推荐：按当前规则形成清晰、可评审的做法。")
    expect(example?.explanation).toBe("该示例用于说明团队规则的落地方式，不是原文摘录。")
  })

  test("runs the complete GuidelineReferencePackFlow and creates a renderable sample Word", async () => {
    const root = await tempDir("chipmate-doc-agent-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const timeline: DocAgentTimelineEvent[] = []
    const logs: string[] = []
    const internal = cGuidelineDocxFixture({
      title: "公司内部 C 编码规范",
      sections: [
        { heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] },
        { heading: "指针与内存安全", paragraphs: ["必须检查指针参数是否为空。", "推荐在入口处返回明确错误码。"] },
      ],
      tableRows: [["C-NAME-001", "全局函数必须体现模块边界。"]],
    })
    const external = cGuidelineDocxFixture({
      title: "外部 C 编码规范参考资料",
      sections: [
        { heading: "错误处理", paragraphs: ["应该统一检查返回值并处理错误路径。"] },
        { heading: "整数安全", paragraphs: ["必须避免有符号和无符号整数混用导致溢出。", "示例：外部资料中的整数边界示例应按团队代码风格改写。"] },
      ],
      tableRows: [["C-ERR-001", "调用返回值应该被检查。"]],
    })

    const result = await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。请给每条规则写最小示例，并在不推荐示例中给出不推荐原因。",
      files: [
        { path: "docs/company-c-guideline.docx", bytes: internal },
        { path: "docs/external-c-guideline.docx", bytes: external },
      ],
      model: new FakeModelProvider(),
      onTimeline: (event) => timeline.push(event),
      log: (message) => logs.push(message),
    })

    expect(result.path).toMatch(/^\.chipmate\/docs\/.+\.docx$/)
    expect(result.sourceCount).toBe(2)
    expect(existsSync(join(root, result.path))).toBe(true)
    const generated = await readFile(join(root, result.path))
    const documentXml = await readDocxPart(generated, "word/document.xml")
    const stylesXml = await readDocxPart(generated, "word/styles.xml")
    expect(documentXml).toContain('<w:tblW w:w="')
    expect(documentXml).not.toContain('w:type="auto"')
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(documentXml).toContain("<w:tblGrid>")
    expect(documentXml).toContain('<w:tcW w:w="')
    expect(documentXml).toMatch(/<w:tblBorders>[\s\S]*?<\/w:tblBorders><w:tblLayout w:type="fixed"\/>/)
    expect((documentXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/g) ?? []).some((properties) => appearsBefore(properties, "<w:jc", "<w:spacing"))).toBe(false)
    expect((stylesXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/g) ?? []).some((properties) => appearsBefore(properties, "<w:outlineLvl", "<w:spacing"))).toBe(false)
    expect(documentXml).toContain("来源：")
    expect(documentXml).toContain("保留方式：")
    expect(documentXml).toContain("不推荐原因")
    const tableWidth = Number(documentXml.match(/<w:tblW w:w="(\d+)" w:type="dxa"\/>/)?.[1] ?? 0)
    expect(tableWidth).toBeGreaterThan(8000)
    const issues = await new DocxRenderQualityGate().check(generated)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
    const visibleTimeline = groupedTimelineEvents(timeline)
    expect([...visibleTimeline.keys()]).toEqual(expect.arrayContaining([
      "read_docx",
      "plan",
      "source_classify",
      "chunking",
      "model.extract",
      "evidence",
      "merge",
      "compose-draft",
      "review-draft",
      "word_spec",
      "quality_gate",
      "create_word_document",
      "done",
    ]))
    expect([...visibleTimeline.keys()].some((key) => key.startsWith("merge:"))).toBe(false)
    expect([...visibleTimeline.keys()].some((key) => key.startsWith("extract:") || key.startsWith("extract-batch:"))).toBe(false)
    expect(visibleTimeline.get("merge")).toEqual(expect.objectContaining({
      type: "merge",
      status: "completed",
      current: 5,
      total: 10,
    }))
    expect(visibleTimeline.get("compose-draft")).toEqual(expect.objectContaining({
      type: "compose-draft",
      status: "completed",
      current: 6,
      total: 10,
    }))
    expect(visibleTimeline.get("review-draft")).toEqual(expect.objectContaining({
      status: "completed",
      current: 7,
      total: 10,
    }))
    expect(visibleTimeline.get("done")).toEqual(expect.objectContaining({
      status: "completed",
      current: 10,
      total: 10,
    }))
    expect(logs.some((line) => line.includes("[doc-agent] merge progress: 调用模型合并团队规则卡"))).toBe(true)
    expect(logs.some((line) => line.includes("[doc-agent] merge progress: 中文化归一规则字段"))).toBe(true)
    expect(logs.some((line) => line.includes("[doc-agent] merge progress: 挂载规则示例"))).toBe(true)
    expect(logs.some((line) => line.includes("[doc-agent] source placement progress: 来源块语义归位"))).toBe(true)
  })

  test("v1 usable Word smoke covers create edit report render comments redlines and style QA", async () => {
    const root = await tempDir("chipmate-word-v1-smoke-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const restoreRenderTools = await installFakeWordRenderTools(root)
    try {
      const spec: WordDocSpec = {
        ...minimalRenderableWordDocSpec(),
        metadata: {
          title: "ChipMate v1 Word smoke report",
          subtitle: "Offline local Word acceptance fixture",
          documentType: "generic-word-v1-smoke",
          language: "en-US",
          generatedAt: "2026-06-28T00:00:00.000Z",
          author: "ChipMate Document Agent",
        },
        sources: [],
        references: [],
        layout: {
          preset: "narrative_proposal",
          page: { size: "letter" },
          navigation: { mode: "static-toc", includeTopBottomLinks: true, includeBackToTocLinks: true },
          tablePolicy: {
            useTablesOnlyForComparableRecords: true,
            avoidProseHeavyTables: true,
            requireExplicitGeometry: true,
          },
          visualQa: { requireRender: true, requirePagePngReview: true },
        },
        cover: {
          title: "ChipMate v1 Word smoke report",
          subtitle: "Offline local Word acceptance fixture",
          preparedFor: "Word parity review",
          preparedBy: "ChipMate Document Agent",
        },
        executiveSummary: {
          paragraphs: ["This fixture verifies that the generic Word pipeline can create, render, inspect, edit, and audit a normal local report."],
          highlights: ["Creates a DOCX through the public tool", "Uses Word-native report structures", "Edits with locators instead of overwriting the package"],
        },
        sections: [
          {
            id: "overview",
            level: 1,
            title: "Overview",
            bookmark: "sec_overview",
            paragraphs: [
              "This paragraph receives a reviewer comment.",
              "The report body uses ordinary prose rather than a task-specific producer.",
            ],
            richParagraphs: [{
              runs: [
                { text: "Jump to " },
                { text: "implementation", hyperlink: { anchor: "sec_impl" } },
                { text: " and review " },
                { reference: { bookmark: "tbl_smoke_status", field: "REF", fallbackText: "Table 1" } },
                { text: " before handoff." },
              ],
            }],
            bullets: ["Model-owned section planning", "Tool-owned Word structure", "Render-backed verification"],
            numberedItems: ["Draft the report", "Inspect generated structure", "Apply controlled edits"],
            tables: [{
              id: "tbl-smoke-status",
              caption: "Word v1 smoke workflow status.",
              label: "Table",
              number: "1",
              bookmark: "tbl_smoke_status",
              headers: ["Workflow", "Evidence", "Status"],
              rows: [
                ["New document", "create_word_document wrote .chipmate/docs output", "Pass"],
                ["Report structure", "TOC, list, table, figure, caption, and cross-reference", "Pass"],
                ["Edit flow", "inspect_word_document locators feed apply_word_document_edits", "Pass"],
              ],
              columnWidthRatios: [28, 52, 20],
              columnAlignments: ["left", "left", "center"],
            }],
          },
          {
            id: "implementation",
            level: 2,
            title: "Implementation",
            bookmark: "sec_impl",
            paragraphs: [
              "This paragraph will be replaced by a tracked change.",
              "The section owns its figure so the image is not moved to the start or end of the document.",
            ],
            richParagraphs: [{
              runs: [
                { text: "The rendered artifact in " },
                { reference: { bookmark: "fig_smoke_architecture", field: "REF", fallbackText: "Figure 1" } },
                { text: " proves PNG media insertion with alt text." },
              ],
            }],
            figures: [{
              id: "fig-smoke-architecture",
              title: "Smoke architecture",
              caption: "Rendered PNG media inserted in the owning section.",
              label: "Figure",
              number: "1",
              bookmark: "fig_smoke_architecture",
              altText: "Smoke architecture PNG",
              image: {
                contentType: "image/png",
                bytes: tinyPngBytes(),
                width: 320,
                height: 180,
              },
            }],
          },
        ],
        qualityChecklist: {
          assumptions: ["Local LibreOffice and PDF-to-PNG render tools may be substituted by deterministic test doubles."],
          limitations: ["This smoke fixture proves the v1 local Word loop, not every v2 edge-case OOXML feature."],
          missingInputs: [],
          risks: ["Manual VS Code installation smoke is still required before claiming extension UI acceptance."],
        },
      }

      const created = await createWordDocument({ spec, filename: "v1-word-smoke.docx" })
      expect(created.path).toMatch(/^\.chipmate\/docs\/v1-word-smoke-.+\.docx$/)
      expect(existsSync(created.absolutePath)).toBe(true)
      expect(created.renderCheckResult.attempted).toBe(true)
      expect(created.renderCheckResult.ok).toBe(true)
      expect(created.renderCheckResult.pageCount).toBe(1)
      expect(created.renderCheckResult.pagePngPaths?.length).toBe(1)
      expect(existsSync(join(root, created.renderCheckResult.pagePngPaths![0]!))).toBe(true)

      const createdBytes = await readFile(created.absolutePath)
      const createdXml = await readDocxPart(createdBytes, "word/document.xml")
      const createdInspection = await new WordDocumentInspector().inspect({ path: created.path, bytes: createdBytes })
      expect(createdXml).toContain('w:name="TOC"')
      expect(createdXml).toContain("返回目录")
      expect(createdXml).toContain('<w:tblLayout w:type="fixed"/>')
      expect(createdXml).toContain('<w:tblHeader/>')
      expect(createdXml).toContain('<w:drawing>')
      expect(createdXml).toContain('<w:pStyle w:val="Caption"/>')
      expect(createdXml).toContain('<w:instrText xml:space="preserve"> REF tbl_smoke_status \\h </w:instrText>')
      expect(createdXml).toContain('<w:instrText xml:space="preserve"> REF fig_smoke_architecture \\h </w:instrText>')
      expect(createdInspection.summary.headingCount).toBeGreaterThanOrEqual(2)
      expect(createdInspection.summary.listItemCount).toBeGreaterThanOrEqual(6)
      expect(createdInspection.summary.tableCount).toBeGreaterThanOrEqual(1)
      expect(createdInspection.summary.imageCount).toBe(1)
      expect(createdInspection.summary.captionCount).toBeGreaterThanOrEqual(2)
      expect(createdInspection.summary.hyperlinkCount).toBeGreaterThanOrEqual(1)
      expect(createdInspection.summary.fieldTypeCounts.REF).toBeGreaterThanOrEqual(2)

      const commentParagraph = createdInspection.paragraphs.find((item) => item.text === "This paragraph receives a reviewer comment.")!
      const redlineParagraph = createdInspection.paragraphs.find((item) => item.text === "This paragraph will be replaced by a tracked change.")!
      const editPlan = validateDocumentEditPlan({
        planId: "v1-smoke-edit",
        targetPath: created.path,
        outputFilenameBase: "v1-word-smoke-edited",
        operations: [
          { type: "addComment", locator: commentParagraph.locator, text: "Confirm this summary before publishing.\nSecond reviewer note stays in the same Word comment.", author: "Reviewer", initials: "RV" },
          { type: "replaceParagraphWithTrackedChange", locator: redlineParagraph.locator, text: "This paragraph is now a tracked replacement for reviewer approval.", author: "Reviewer" },
        ],
        warnings: [],
      }, createdInspection)
      expect(editPlan.ok).toBe(true)

      const edited = await new WordDocumentEditor(root).apply({
        sourcePath: created.path,
        bytes: createdBytes,
        inspection: createdInspection,
        plan: editPlan.plan!,
      })
      expect(edited.path).toMatch(/^\.chipmate\/docs\/v1-word-smoke-edited-.+\.docx$/)
      expect(edited.structureCheckResult.ok).toBe(true)
      expect(edited.renderCheckResult.attempted).toBe(true)
      expect(edited.renderCheckResult.ok).toBe(true)
      expect(edited.renderCheckResult.pagePngPaths?.length).toBe(1)
      const editedInspection = await new WordDocumentInspector().inspect({ path: edited.path, bytes: edited.bytes })
      expect(editedInspection.summary.commentCount).toBe(1)
      expect(editedInspection.summary.trackedChangeCount).toBeGreaterThan(0)
      expect(editedInspection.comments[0]?.text).toContain("Second reviewer note stays in the same Word comment.")
      expect(editedInspection.paragraphs.some((item) => item.text.includes("tracked replacement for reviewer approval"))).toBe(true)

      const styleReport = await auditWordDocumentStyles({ path: edited.path, bytes: edited.bytes })
      expect(styleReport.inputPath).toBe(edited.path)
      expect(styleReport.paragraphCount).toBeGreaterThan(0)
      expect(styleReport.runCount).toBeGreaterThan(0)
      expect(styleReport.notes.length).toBeGreaterThan(0)
      expect(styleReport.headingLikeParagraphsNotHeadingStyle.some((item) => item.text.includes("Manual Formatting Heading"))).toBe(false)

      const driftReport = await auditWordDocumentStyles({ path: "docs/style-drift.docx", bytes: await styleDriftDocxFixture() })
      expect(driftReport.directRunFormattingRuns).toBeGreaterThan(0)
      expect(driftReport.headingLikeParagraphsNotHeadingStyle.some((item) => item.text.includes("Manual Formatting Heading"))).toBe(true)
    } finally {
      restoreRenderTools()
    }
  }, 15_000)

  test("passes a focused Word 2016 structural compatibility gate for generated DOCX packages", async () => {
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const parts = await docxPartPaths(bytes)
    const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
    const packageRelsXml = await readDocxPart(bytes, "_rels/.rels")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")

    expect(parts).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/footer1.xml",
      "word/header1.xml",
      "word/styles.xml",
    ]))
    expect(contentTypesXml).toContain('PartName="/word/document.xml"')
    expect(contentTypesXml).toContain('PartName="/word/styles.xml"')
    expect(packageRelsXml).toContain('Target="word/document.xml"')
    expect(packageRelsXml).toContain('Target="docProps/core.xml"')
    expect(documentRelsXml).toContain('Target="styles.xml"')
    expect(documentRelsXml).toContain('Target="header1.xml"')
    expect(documentRelsXml).toContain('Target="footer1.xml"')

    const issues = await new DocxRenderQualityGate().check(bytes)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("uses high-contrast table headers for generated Word design presets", async () => {
    const presets = ["standard_business_brief", "compact_reference_guide", "narrative_proposal", "google_docs_default"] as const
    for (const preset of presets) {
      const theme = defaultWordThemeForSpec({ preset })
      expect(headerContrastRatioForTest(theme.table.headerFill, theme.styles.tableHeader.color ?? "")).toBeGreaterThanOrEqual(4.5)
      expect(theme.table.headerFill).not.toBe("FFFFFF")

      const spec = minimalRenderableWordDocSpec()
      spec.layout = { preset }
      const bytes = await new WordDocBuilder().build(spec)
      const documentXml = await readDocxPart(bytes, "word/document.xml")
      const headerRow = documentXml.match(/<w:tr\b[\s\S]*?<w:tblHeader\/>[\s\S]*?<\/w:tr>/)?.[0] ?? ""
      expect(headerRow).toContain(`w:fill="${theme.table.headerFill}"`)
      expect(headerRow).toContain(`w:color w:val="${theme.styles.tableHeader.color}"`)
      const issues = await new DocxRenderQualityGate().check(bytes)
      expect(issues.map((issue) => issue.code)).not.toContain("table-header-low-contrast")
    }
  })

  test("flags low-contrast and near-white table headers in DOCX structure QA", async () => {
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const whiteOnWhite = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml
      .replace(/w:fill="1F4E79"/g, 'w:fill="FFFFFF"')
      .replace(/w:color w:val="FFFFFF"/g, 'w:color w:val="FFFFFF"'))
    const whiteOnWhiteIssues = await new DocxRenderQualityGate().check(whiteOnWhite)
    expect(whiteOnWhiteIssues.map((issue) => issue.code)).toContain("table-header-low-contrast")
    expect(whiteOnWhiteIssues.map((issue) => issue.code)).toContain("table-header-fill-too-light")
    expect(whiteOnWhiteIssues.find((issue) => issue.code === "table-header-low-contrast")?.message).toMatch(/table 1 header row 1 cell 1.*fill #FFFFFF, text #FFFFFF/)

    const shallowGrayOnWhite = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml
      .replace(/w:fill="1F4E79"/g, 'w:fill="F2F4F7"')
      .replace(/w:color w:val="FFFFFF"/g, 'w:color w:val="FFFFFF"'))
    const shallowIssues = await new DocxRenderQualityGate().check(shallowGrayOnWhite)
    expect(shallowIssues.map((issue) => issue.code)).toContain("table-header-low-contrast")

    const highContrastIssues = await new DocxRenderQualityGate().check(bytes)
    expect(highContrastIssues.map((issue) => issue.code)).not.toContain("table-header-low-contrast")
  })

  test("embeds PNG figures in the section that owns them", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [
      {
        ...spec.sections[0]!,
        figures: [{
          id: "fig-architecture",
          title: "架构边界图",
          caption: "PNG 图表应位于本章节正文中。",
          label: "Figure",
          number: "1",
          bookmark: "fig_architecture",
          altText: "架构边界图 PNG",
          image: {
            contentType: "image/png",
            bytes: tinyPngBytes(),
            width: 320,
            height: 180,
          },
        }],
      },
      {
        id: "after-figure",
        level: 1,
        title: "后续章节",
        paragraphs: ["用于验证图片没有被统一插到文档开头或结尾。"],
      },
    ]

    const bytes = await new WordDocBuilder().build(spec)
    const parts = await docxPartPaths(bytes)
    const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")

    expect(parts).toContain("word/media/image1.png")
    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"')
    expect(documentXml).toContain('r:embed="rIdImage1"')
    expect(documentXml).toContain('<w:pStyle w:val="Caption"/>')
    expect(documentXml).toContain('<w:bookmarkStart w:id="1001" w:name="fig_architecture"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Figure </w:t>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText>')
    expect(documentXml).toContain('<w:t xml:space="preserve">1</w:t>')
    expect(documentXml).toContain('<w:bookmarkEnd w:id="1001"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">: PNG 图表应位于本章节正文中。</w:t>')
    const fieldReport = await auditWordDocumentFields({ path: "docs/figure.docx", bytes })
    expect(fieldReport.fieldTypeCounts.SEQ).toBe(1)
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/figure.docx", bytes })
    expect(inspection.summary.fieldTypeCounts.SEQ).toBe(1)
    expect(inspection.fields.some((field) => field.type === "SEQ" && field.instruction === "SEQ Figure \\* ARABIC" && field.cachedText === "1")).toBe(true)
    const image = inspection.images[0]!
    expect(inspection.summary.imageCount).toBe(1)
    expect(image.placement).toBe("inline")
    expect(image.relationshipMode).toBe("embedded")
    expect(image.targetMode).toBeUndefined()
    expect(image.relId).toBe("rIdImage1")
    expect(image.target).toBe("media/image1.png")
    expect(image.mediaPath).toBe("word/media/image1.png")
    expect(image.mediaExtension).toBe("png")
    expect(image.contentType).toBe("image/png")
    expect(image.mediaExists).toBe(true)
    expect(image.replaceSupported).toBe(true)
    expect(image.replaceUnsupportedReason).toBeUndefined()
    expect(image.name).toBe("架构边界图")
    expect(image.altText).toBe("架构边界图 PNG")
    expect(image.widthEmu).toBeGreaterThan(0)
    expect(image.heightEmu).toBeGreaterThan(0)
    expect(image.locator.kind).toBe("image")
    expect(image.locator.imageRelId).toBe("rIdImage1")
    expect(inspection.locators.some((locator) => locator.kind === "image" && locator.imageTarget === "media/image1.png")).toBe(true)

    const sectionIndex = documentXml.indexOf("团队版规则正文")
    const drawingIndex = documentXml.indexOf("<w:drawing>")
    const nextSectionIndex = documentXml.indexOf("后续章节")
	    expect(sectionIndex).toBeGreaterThanOrEqual(0)
	    expect(drawingIndex).toBeGreaterThan(sectionIndex)
	    expect(nextSectionIndex).toBeGreaterThan(drawingIndex)
	  })

	  test("create_word_document hydrates PNG figures from local artifact paths", async () => {
	    const root = await tempDir("chipmate-doc-agent-figure-path-")
	    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
	    const pngPath = join(root, ".chipmate", "docs", "diagrams", "flow.png")
	    await mkdir(join(root, ".chipmate", "docs", "diagrams"), { recursive: true })
	    await writeFile(pngPath, tinyPngBytes())
	    const spec = minimalRenderableWordDocSpec()
	    spec.sections[0] = {
	      ...spec.sections[0]!,
	      figures: [{
	        title: "Mermaid 渲染图",
	        caption: "该图片来自 Mermaid PNG artifact。",
	        altText: "Mermaid 渲染图 PNG",
	        image: {
	          contentType: "image/png",
	          path: ".chipmate/docs/diagrams/flow.png",
	          artifactPath: ".chipmate/docs/diagrams/flow.png",
	          width: 320,
	          height: 180,
	        },
	      }],
	    }

	    const result = await createWordDocument({ spec, filename: "figure-path.docx" })
	    const bytes = await readFile(result.absolutePath!)

	    expect(await docxPartPaths(bytes)).toContain("word/media/image1.png")
	    expect((await readDocxBinaryPart(bytes, "word/media/image1.png")).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
	    expect(await readDocxPart(bytes, "word/document.xml")).toContain('r:embed="rIdImage1"')
	  })

	  test("create_word_document keeps high-DPI Mermaid PNG pixels without changing Word display size", async () => {
	    const spec = minimalRenderableWordDocSpec()
	    spec.sections[0] = {
	      ...spec.sections[0]!,
	      figures: [{
	        title: "高清 Mermaid 渲染图",
	        caption: "该图片使用 scale 3 渲染，但 Word 显示尺寸保持 CSS layout size。",
	        altText: "高清 Mermaid 渲染图 PNG",
	        image: {
	          contentType: "image/png",
	          bytes: pngBytesWithHeaderDimensions(960, 540),
	          width: 320,
	          height: 180,
	        },
	      }],
	    }

	    const result = await createWordDocument({ spec, filename: "figure-high-dpi.docx" })
	    const bytes = await readFile(result.absolutePath!)
	    const media = await readDocxBinaryPart(bytes, "word/media/image1.png")
	    const documentXml = await readDocxPart(bytes, "word/document.xml")

	    expect(pngHeaderDimensions(media)).toEqual({ width: 960, height: 540 })
	    expect(documentXml).toContain('<wp:extent cx="3048000" cy="1714500"/>')
	  })

	  test("inspect_word_document reports floating external and non-PNG image boundaries", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "advanced-images",
      level: 1,
      title: "Advanced Images",
      figures: [
        {
          id: "external",
          title: "Linked external screenshot",
          altText: "External screenshot",
          image: {
            contentType: "image/png",
            bytes: tinyPngBytes(),
            width: 160,
            height: 90,
          },
        },
        {
          id: "jpeg",
          title: "JPEG screenshot",
          altText: "JPEG screenshot",
          image: {
            contentType: "image/png",
            bytes: tinyPngBytes(),
            width: 160,
            height: 90,
          },
        },
      ],
    }]

    let bytes = await new WordDocBuilder().build(spec)
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => {
      let drawingIndex = 0
      return xml.replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, (drawingXml) => {
        drawingIndex += 1
        if (drawingIndex !== 1) return drawingXml
        return drawingXml
          .replace("<wp:inline", "<wp:anchor")
          .replace("</wp:inline>", "</wp:anchor>")
          .replace('r:embed="rIdImage1"', 'r:link="rIdImage1"')
      })
    })
    bytes = await replaceDocxPart(bytes, "word/_rels/document.xml.rels", (xml) => xml
      .replace(/<Relationship\b[^>]*\bId="rIdImage1"[^>]*\/>/, '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/linked-screenshot.jpg" TargetMode="External"/>')
      .replace('Target="media/image2.png"', 'Target="media/image2.jpg"'))
    bytes = await replaceDocxPart(bytes, "[Content_Types].xml", (xml) => xml.includes('Extension="jpg"') ? xml : xml.replace("</Types>", '<Default Extension="jpg" ContentType="image/jpeg"/></Types>'))
    bytes = await writeDocxPart(bytes, "word/media/image2.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/advanced-images.docx", bytes })
    expect(inspection.summary.imageCount).toBe(2)
    const external = inspection.images.find((image) => image.relId === "rIdImage1")!
    const jpeg = inspection.images.find((image) => image.relId === "rIdImage2")!

    expect(external.placement).toBe("floating")
    expect(external.relationshipMode).toBe("external")
    expect(external.targetMode).toBe("External")
    expect(external.target).toBe("https://example.com/linked-screenshot.jpg")
    expect(external.mediaPath).toBeUndefined()
    expect(external.mediaExtension).toBe("jpg")
    expect(external.contentType).toBeUndefined()
    expect(external.mediaExists).toBeUndefined()
    expect(external.replaceSupported).toBe(false)
    expect(external.replaceUnsupportedReason).toBe("external-linked-image")

    expect(jpeg.placement).toBe("inline")
    expect(jpeg.relationshipMode).toBe("embedded")
    expect(jpeg.target).toBe("media/image2.jpg")
    expect(jpeg.mediaPath).toBe("word/media/image2.jpg")
    expect(jpeg.mediaExtension).toBe("jpg")
    expect(jpeg.contentType).toBe("image/jpeg")
    expect(jpeg.mediaExists).toBe(true)
    expect(jpeg.replaceSupported).toBe(false)
    expect(jpeg.replaceUnsupportedReason).toBe("non-png-media")
  })

  test("writes quote and pull quote blocks as real Word quote styles", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "quoted-evidence",
      level: 1,
      title: "Quoted Evidence",
      quoteBlocks: [
        { kind: "quote", text: "Evidence stays attached to a source.", attribution: "Review Board", source: "REQ-9" },
        { kind: "pullQuote", text: "Use structure, not fake quoted paragraphs.", attribution: "Codex documents" },
      ],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const stylesXml = await readDocxPart(bytes, "word/styles.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(documentXml).toContain('<w:pStyle w:val="Quote"/>')
    expect(documentXml).toContain('<w:pStyle w:val="IntenseQuote"/>')
    expect(documentXml).toContain('<w:jc w:val="center"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">- Review Board - REQ-9</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">- Codex documents</w:t>')
    expect(stylesXml).toContain('w:styleId="Quote"')
    expect(stylesXml).toContain('w:styleId="IntenseQuote"')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes multi-column brief cards as fixed-layout Word card tables", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "brief-cards",
      level: 1,
      title: "Executive Snapshot",
      briefCards: [
        { title: "Status", value: "Ready", body: "All required evidence is attached.", footer: "Updated today", tone: "success" },
        { title: "Risk", value: "Low", body: "No blocking issues remain.", tone: "info" },
        { title: "Owner", value: "Platform Team", footer: "Primary contact", tone: "neutral" },
      ],
      paragraphs: ["Brief cards should stay in this section before the narrative."],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(documentXml).toContain('<w:shd w:fill="E8F5E9"/>')
    expect(documentXml).toContain('<w:shd w:fill="EAF3FF"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Status</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Ready</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">All required evidence is attached.</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Updated today</w:t>')
    expect(appearsBefore(documentXml, "Status", "Brief cards should stay in this section before the narrative.")).toBe(true)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes source evidence cards as traceable fixed-layout Word cards", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "evidence-cards",
      level: 1,
      title: "Evidence Summary",
      paragraphs: ["Evidence cards should preserve source context without becoming a plain source list."],
      evidenceCards: [
        {
          title: "Architecture Decision",
          summary: "The design review requires source evidence to remain attached to the claim.",
          source: "Architecture Review",
          path: "docs/review.docx",
          locator: "section-2",
          quote: "Evidence must stay anchored.",
          role: "primary",
          confidence: "high",
          sourceRefs: ["REQ-9", "ARCH-2"],
        },
        {
          title: "Open Risk",
          summary: "One referenced section conflicts with the proposed rollout wording.",
          source: "Risk Register",
          path: "docs/risks.docx",
          role: "contradictory",
          confidence: "medium",
        },
      ],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Architecture Decision</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">The design review requires source evidence to remain attached to the claim.</w:t>')
    expect(documentXml).toContain('<w:pStyle w:val="Quote"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Evidence must stay anchored.</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">来源：Architecture Review</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">路径：docs/review.docx</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">定位：section-2</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">引用：REQ-9, ARCH-2</w:t>')
    expect(documentXml).toContain('<w:shd w:fill="F0F7FF"/>')
    expect(documentXml).toContain('<w:shd w:fill="FFF4CE"/>')
    expect(appearsBefore(documentXml, "Evidence Summary", "Architecture Decision")).toBe(true)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes external hyperlinks internal anchors and cross-reference fields", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [
      {
        id: "overview",
        level: 1,
        title: "Overview",
        bookmark: "sec_overview",
        richParagraphs: [{
          runs: [
            { text: "Read " },
            { text: "OpenAI docs", hyperlink: { url: "https://openai.com/docs", tooltip: "Official docs" } },
            { text: " and jump to " },
            { text: "implementation", hyperlink: { anchor: "sec_impl" } },
            { text: "." },
          ],
        }],
        tables: [{
          id: "tbl-link-support",
          caption: "Link support status.",
          label: "Table",
          number: "1",
          bookmark: "tbl_link_support",
          headers: ["Item", "Status"],
          rows: [["Link support", "Implemented"]],
        }],
      },
      {
        id: "implementation",
        level: 1,
        title: "Implementation",
        bookmark: "sec_impl",
        richParagraphs: [{
          runs: [
            { text: "See " },
            { reference: { bookmark: "fig_architecture", field: "REF", fallbackText: "Figure 1" } },
            { text: " and " },
            { reference: { bookmark: "tbl_link_support", field: "REF", fallbackText: "Table 1" } },
            { text: " for the architecture and table references." },
          ],
        }],
        figures: [{
          id: "fig-architecture",
          title: "Architecture",
          caption: "Reference target.",
          label: "Figure",
          number: "1",
          bookmark: "fig_architecture",
          altText: "Architecture reference target",
          image: {
            contentType: "image/png",
            bytes: tinyPngBytes(),
            width: 320,
            height: 180,
          },
        }],
      },
    ]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")
    const issues = await new DocxRenderQualityGate().check(bytes)
    const inspection = await new WordDocumentInspector().inspect({ path: "hyperlinks.docx", bytes })

    expect(documentRelsXml).toContain('Id="rIdHyperlink1"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://openai.com/docs" TargetMode="External"')
    expect(documentXml).toContain('<w:hyperlink r:id="rIdHyperlink1" w:tooltip="Official docs">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="sec_impl">')
    expect(documentXml).toContain('w:name="sec_overview"')
    expect(documentXml).toContain('w:name="sec_impl"')
    expect(documentXml).toContain('w:name="fig_architecture"')
    expect(documentXml).toContain('w:name="tbl_link_support"')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> REF fig_architecture \\h </w:instrText>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> REF tbl_link_support \\h </w:instrText>')
    expect(documentXml).toContain('<w:instrText xml:space="preserve"> SEQ Table \\* ARABIC </w:instrText>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Figure 1</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Table 1</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">: Link support status.</w:t>')
    expect(inspection.summary.hyperlinkCount).toBe(2)
    expect(inspection.hyperlinks.find((link) => link.relId === "rIdHyperlink1")?.target).toBe("https://openai.com/docs")
    expect(inspection.hyperlinks.find((link) => link.relId === "rIdHyperlink1")?.tooltip).toBe("Official docs")
    expect(inspection.hyperlinks.find((link) => link.anchor === "sec_impl")?.text).toBe("implementation")
    expect(inspection.locators.some((locator) => locator.kind === "hyperlink" && locator.hyperlinkAnchor === "sec_impl")).toBe(true)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes headless-safe static TOC with internal navigation anchors", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      ...(spec.layout ?? {}),
      navigation: { mode: "static-toc", includeTopBottomLinks: true, includeBackToTocLinks: true },
    }
    spec.sections = [
      {
        id: "overview",
        level: 1,
        title: "Overview",
        paragraphs: ["Overview body."],
      },
      {
        id: "implementation",
        level: 2,
        title: "Implementation",
        paragraphs: ["Implementation body."],
      },
    ]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(documentXml).not.toContain("fldSimple")
    expect(documentXml).toContain('w:name="Top"')
    expect(documentXml).toContain('w:name="TOC"')
    expect(documentXml).toContain('w:name="Bottom"')
    expect(documentXml).toContain('w:name="sec_1_overview"')
    expect(documentXml).toContain('w:name="sec_2_implementation"')
    expect(documentXml).toContain('<w:hyperlink w:anchor="sec_1_overview">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="sec_2_implementation">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="Top">')
    expect(documentXml).toContain('<w:hyperlink w:anchor="Bottom">')
    expect(documentXml.match(/<w:hyperlink w:anchor="TOC">/g)?.length).toBeGreaterThanOrEqual(2)
    expect(documentXml).toContain("返回目录")
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes plain text checkbox dropdown and date content controls for fillable forms", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "fillable-form"
    spec.protection = { mode: "forms" }
    spec.sections = [{
      id: "intake",
      level: 1,
      title: "Intake Form",
      paragraphs: ["Please complete the fields below."],
      formFields: [
        { label: "Reviewer", tag: "REVIEWER", placeholder: "{{REVIEWER}}", helpText: "Person responsible for review." },
        { label: "Review date", tag: "REVIEW_DATE", value: "2026-06-27" },
        { label: "Approved", tag: "APPROVED", kind: "checkbox", checked: true },
        { label: "Priority", tag: "PRIORITY", kind: "dropdown", value: "High", options: ["Low", "Medium", "High"] },
        { label: "Due date", tag: "DUE_DATE", kind: "date", value: "2026-07-01", dateFormat: "yyyy-MM-dd" },
      ],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const parts = await docxPartPaths(bytes)
    const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")
    const settingsXml = await readDocxPart(bytes, "word/settings.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(parts).toContain("word/settings.xml")
    expect(contentTypesXml).toContain('PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"')
    expect(settingsXml).toContain('<w:documentProtection w:edit="forms" w:enforcement="1"/>')
    expect(documentXml).toContain("<w:sdt>")
    expect(documentXml).toContain('xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"')
    expect(documentXml).toContain('<w:alias w:val="Reviewer"/>')
    expect(documentXml).toContain('<w:tag w:val="REVIEWER"/>')
    expect(documentXml).toContain('<w:text w:multiLine="1"/>')
    expect(documentXml).toContain("<w14:checkbox>")
    expect(documentXml).toContain('<w14:checked w14:val="1"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">☑</w:t>')
    expect(documentXml).toContain("<w:dropDownList>")
    expect(documentXml).toContain('<w:listItem w:value="High" w:displayText="High"/>')
    expect(documentXml).toContain("<w:date>")
    expect(documentXml).toContain('<w:dateFormat w:val="yyyy-MM-dd"/>')
    expect(documentXml).toContain('<w:fullDate w:val="2026-07-01T00:00:00Z"/>')
    expect(documentXml).toContain('<w:t xml:space="preserve">{{REVIEWER}}</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">2026-06-27</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">High</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">2026-07-01</w:t>')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/form-controls.docx", bytes })
    expect(inspection.summary.contentControlCount).toBe(5)
    expect(inspection.contentControls.map((control) => control.kind)).toEqual(["plainText", "plainText", "checkbox", "dropdown", "date"])
    expect(inspection.contentControls.find((control) => control.tag === "APPROVED")?.checked).toBe(true)
    expect(inspection.contentControls.find((control) => control.tag === "PRIORITY")?.options).toEqual(["Low", "Medium", "High"])
    expect(inspection.contentControls.find((control) => control.tag === "DUE_DATE")?.dateFormat).toBe("yyyy-MM-dd")
  })

  test("writes true footnotes and endnotes with note parts and relationships", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "notes",
      level: 1,
      title: "Notes",
      richParagraphs: [{
        runs: [
          { text: "This claim has a footnote" },
          { note: { kind: "footnote", text: "Footnote text should live in word/footnotes.xml." } },
          { text: " and an endnote" },
          { note: { kind: "endnote", text: "Endnote text should live in word/endnotes.xml." } },
          { text: "." },
        ],
      }],
      tables: [{
        headers: ["Item", "Status"],
        rows: [["Notes", "Implemented"]],
      }],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const parts = await docxPartPaths(bytes)
    const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")
    const footnotesXml = await readDocxPart(bytes, "word/footnotes.xml")
    const endnotesXml = await readDocxPart(bytes, "word/endnotes.xml")
    const stylesXml = await readDocxPart(bytes, "word/styles.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(parts).toContain("word/footnotes.xml")
    expect(parts).toContain("word/endnotes.xml")
    expect(contentTypesXml).toContain('PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"')
    expect(contentTypesXml).toContain('PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"')
    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>')
    expect(documentXml).toContain('<w:endnoteReference w:id="1"/>')
    expect(footnotesXml).toContain('<w:footnote w:id="-1" w:type="separator">')
    expect(footnotesXml).toContain('<w:footnote w:id="0" w:type="continuationSeparator">')
    expect(footnotesXml).toContain("Footnote text should live in word/footnotes.xml.")
    expect(endnotesXml).toContain('<w:endnote w:id="-1" w:type="separator">')
    expect(endnotesXml).toContain('<w:endnote w:id="0" w:type="continuationSeparator">')
    expect(endnotesXml).toContain("Endnote text should live in word/endnotes.xml.")
    expect(stylesXml).toContain('w:styleId="FootnoteText"')
    expect(stylesXml).toContain('w:styleId="EndnoteText"')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/notes.docx", bytes })
    expect(inspection.summary.noteCount).toBe(2)
    expect(inspection.summary.footnoteCount).toBe(1)
    expect(inspection.summary.endnoteCount).toBe(1)
    expect(inspection.notes.map((note) => note.noteKind)).toEqual(["footnote", "endnote"])
    expect(inspection.notes.map((note) => note.noteId)).toEqual(["1", "1"])
    expect(inspection.notes.map((note) => note.text)).toEqual([
      "Footnote text should live in word/footnotes.xml.",
      "Endnote text should live in word/endnotes.xml.",
    ])
    expect(inspection.notes.every((note) => note.locator.kind === "note")).toBe(true)
    expect(inspection.notes.some((note) => note.text.includes("separator"))).toBe(false)
  })

  test("writes and inspects multi-paragraph footnotes and endnotes", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "multi-note",
      level: 1,
      title: "Multi Note",
      richParagraphs: [{
        runs: [
          { text: "This claim has a multi-paragraph footnote" },
          { note: { kind: "footnote", text: "Footnote first paragraph.\nFootnote second paragraph." } },
          { text: " and a multi-paragraph endnote" },
          { note: { kind: "endnote", text: "Endnote first paragraph.\nEndnote second paragraph." } },
          { text: "." },
        ],
      }],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const footnotesXml = await readDocxPart(bytes, "word/footnotes.xml")
    const endnotesXml = await readDocxPart(bytes, "word/endnotes.xml")
    const footnoteXml = readNoteItemXml(footnotesXml, "footnote", "1")
    const endnoteXml = readNoteItemXml(endnotesXml, "endnote", "1")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect((footnoteXml.match(/<w:p\b/g) ?? []).length).toBe(2)
    expect((endnoteXml.match(/<w:p\b/g) ?? []).length).toBe(2)
    expect(footnoteXml).toContain("<w:footnoteRef/>")
    expect(endnoteXml).toContain("<w:endnoteRef/>")
    expect(footnoteXml).not.toContain("<w:br/>")
    expect(endnoteXml).not.toContain("<w:br/>")
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])

    const inspection = await new WordDocumentInspector().inspect({ path: "docs/multi-notes.docx", bytes })
    expect(inspection.notes.map((note) => note.text)).toEqual([
      "Footnote first paragraph.\nFootnote second paragraph.",
      "Endnote first paragraph.\nEndnote second paragraph.",
    ])
  })

  test("uses design presets, real Word numbering, and explicit table geometry for generic documents", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      preset: "compact_reference_guide",
      page: { size: "letter" },
      formFactors: [{ sectionId: "team-rules", factor: "checklist", reason: "dense reference" }],
      tablePolicy: { requireExplicitGeometry: true, avoidProseHeavyTables: true },
    }
    spec.sections = [{
      id: "team-rules",
      level: 1,
      title: "Checklist",
      formFactor: "checklist",
      paragraphs: ["This generic document is intentionally not a source-backed coding guideline report."],
      bullets: ["Review scope", "Confirm owner"],
      numberedItems: ["Draft", "Review", "Publish"],
      lists: [
        {
          kind: "bullet",
          title: "Nested scope list",
          items: [
            { text: "Plan review scope", children: [{ text: "Map owners" }, { text: "Confirm evidence", children: [{ text: "Attach render artifacts" }] }] },
          ],
        },
        {
          kind: "numbered",
          items: [
            { text: "Prepare draft" },
            { text: "Review draft", level: 1 },
            { text: "Publish final", level: 2 },
          ],
        },
        {
          kind: "checklist",
          items: [
            { text: "Visual QA completed", checked: true },
            { text: "Warnings disclosed", checked: false },
          ],
        },
      ],
      tables: [{
        headers: ["Item", "Owner", "Status"],
        rows: [["Scope", "Team", "Open"]],
        columnWidthRatios: [50, 25, 25],
        columnAlignments: ["left", "center", "center"],
      }],
    }]
    spec.references = []

    const bytes = await new WordDocBuilder().build(spec)
    const parts = await docxPartPaths(bytes)
    const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const documentRelsXml = await readDocxPart(bytes, "word/_rels/document.xml.rels")
    const numberingXml = await readDocxPart(bytes, "word/numbering.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(parts).toContain("word/numbering.xml")
    expect(contentTypesXml).toContain('PartName="/word/numbering.xml"')
    expect(documentRelsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"')
    expect(numberingXml).toContain('w:numFmt w:val="bullet"')
    expect(numberingXml).toContain('w:numFmt w:val="decimal"')
    expect(numberingXml).toContain('w:multiLevelType w:val="hybridMultilevel"')
    expect(numberingXml).toContain('<w:lvl w:ilvl="2">')
    expect(numberingXml).toContain('w:lvlText w:val="%1.%2.%3."')
    expect(numberingXml).toContain('w:lvlText w:val="☐"')
    expect(numberingXml).toContain('w:lvlText w:val="☑"')
    expect(documentXml).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(documentXml).toContain("<w:numPr>")
    expect(documentXml).toContain('<w:ilvl w:val="1"/>')
    expect(documentXml).toContain('<w:ilvl w:val="2"/>')
    expect(documentXml).toContain('<w:numId w:val="3"/>')
    expect(documentXml).toContain('<w:numId w:val="4"/>')
    expect(documentXml).not.toContain("<w:t xml:space=\"preserve\">• Review scope</w:t>")
    expect(documentXml).not.toContain("<w:t xml:space=\"preserve\">1. Draft</w:t>")
    expect(documentXml).toContain("<w:tblHeader/>")
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(documentXml).toContain('<w:vAlign w:val="center"/>')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
    const inspection = await new WordDocumentInspector().inspect({ path: "docs/preset.docx", bytes })
    const section = inspection.sections[0]!
    expect(inspection.summary.sectionCount).toBe(1)
    expect(section.page.widthTwips).toBe(12240)
    expect(section.page.heightTwips).toBe(15840)
    expect(section.page.orientation).toBe("portrait")
    expect(section.page.margins?.top).toBeGreaterThan(0)
    expect(section.headers).toEqual([{ type: "default", relId: "rIdHeader1" }])
    expect(section.footers).toEqual([{ type: "default", relId: "rIdFooter1" }])
    expect(section.isFinal).toBe(true)
    expect(section.locator.kind).toBe("section")
    expect(inspection.locators.some((locator) => locator.kind === "section" && locator.sectionIndex === 1)).toBe(true)
    expect(inspection.summary.listCount).toBe(5)
    expect(inspection.summary.listItemCount).toBe(14)
    expect(inspection.lists.some((list) => list.kind === "bullet" && list.levelCount === 3 && list.items.some((item) => item.text === "Attach render artifacts" && item.level === 2))).toBe(true)
    expect(inspection.lists.some((list) => list.kind === "numbered" && list.items.some((item) => item.text === "Publish final" && item.level === 2))).toBe(true)
    expect(inspection.lists.some((list) => list.kind === "checklist" && list.itemCount === 2)).toBe(true)
    expect(inspection.paragraphs.find((paragraph) => paragraph.text === "Map owners")?.list).toEqual(expect.objectContaining({ kind: "bullet", level: 1 }))
    expect(inspection.paragraphs.find((paragraph) => paragraph.text === "Visual QA completed")?.list).toEqual(expect.objectContaining({ kind: "checklist" }))
    expect(inspection.locators.some((locator) => locator.kind === "list" && locator.listIndex === 1)).toBe(true)
  })

  test("writes merged table cells with real gridSpan and vMerge OOXML", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "merged-table-sample"
    spec.sources = []
    spec.references = []
    spec.sections = [{
      id: "merged-table",
      level: 1,
      title: "Merged Table",
      tables: [{
        headers: ["Phase", "Owner", "Status"],
        rows: [
          [{ text: "Implementation overview", colSpan: 3, alignment: "center" }],
          [{ text: "Design", rowSpan: 2 }, "Alice", "Draft"],
          ["Bob", "Review"],
          ["Release", { text: "Program", colSpan: 2 }],
        ],
        columnWidthRatios: [30, 35, 35],
      }],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(documentXml).toContain('<w:gridSpan w:val="3"/>')
    expect(documentXml).toContain('<w:gridSpan w:val="2"/>')
    expect(documentXml).toContain('<w:vMerge w:val="restart"/>')
    expect(documentXml).toContain("<w:vMerge/>")
    expect(documentXml).toContain("<w:tblHeader/>")
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("writes long tables with repeated headers and auto-expanding rows for cross-page rendering", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "long-table-sample"
    spec.sources = []
    spec.references = []
    spec.sections = [{
      id: "long-table",
      level: 1,
      title: "Long Table",
      paragraphs: ["This table is intentionally long enough to exercise Word pagination behavior."],
      tables: [{
        headers: ["ID", "Requirement", "Owner", "Status"],
        rows: Array.from({ length: 72 }, (_, index) => [
          `REQ-${String(index + 1).padStart(3, "0")}`,
          `Requirement ${index + 1} stays concise so rows can wrap naturally without fixed heights.`,
          index % 2 === 0 ? "Platform" : "Verification",
          index % 3 === 0 ? "Done" : "Open",
        ]),
        columnWidthRatios: [14, 52, 18, 16],
        columnAlignments: ["center", "left", "center", "center"],
      }],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
    const tableXml = tables.find((table) => table.includes("REQ-001") && table.includes("REQ-072"))
    const issues = await new DocxRenderQualityGate().check(bytes)

    expect(tableXml).toBeDefined()
    const targetTableXml = tableXml ?? ""
    expect(targetTableXml).toContain("<w:tblHeader/>")
    expect(targetTableXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(targetTableXml).toContain("<w:tblGrid>")
    expect(targetTableXml).not.toContain("<w:trHeight")
    expect(targetTableXml.match(/<w:tr>/g)?.length ?? 0).toBeGreaterThan(70)
    expect((targetTableXml.match(/<w:tblHeader\/>/g) ?? []).length).toBe(1)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(issues.filter((issue) => issue.code === "a11y-missing-table-header")).toEqual([])
  })

  test("rejects table merge specs that overflow the declared column grid", () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [{
      id: "bad-merge",
      level: 1,
      title: "Bad Merge",
      tables: [{
        headers: ["A", "B"],
        rows: [
          [{ text: "Too wide", colSpan: 3 }],
          [{ text: "Too tall", rowSpan: 3 }, "Value"],
        ],
      }],
    }]

    const issues = new WordDocSpecValidator().validate(spec)
    expect(issues.filter((issue) => issue.code === "invalid-table-span").length).toBeGreaterThanOrEqual(2)
  })

  test("resolves Word preset aliases and renders first-page header patterns", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      presetAlias: "decision_memo",
      headerPattern: "memo_masthead",
      navigation: { mode: "none" },
      overrides: [{ role: "memo-title", reason: "Decision memo opening block", tokenChanges: { titleCase: "upper" } }],
    }
    spec.cover = {
      title: "Launch Decision",
      subtitle: "Delay launch vs ship with onboarding gap",
      preparedFor: "Executive Team",
      preparedBy: "ChipMate",
    }

    const tokens = resolveWordPresetTokenMap(spec.layout)
    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const stylesXml = await readDocxPart(bytes, "word/styles.xml")
    const issues = new WordDocSpecValidator().validate(spec)

    expect(resolveWordDesignPreset(spec.layout)).toBe("standard_business_brief")
    expect(resolveWordHeaderPattern(spec.layout)).toBe("memo_masthead")
    expect(tokens.alias).toBe("decision_memo")
    expect(tokens.typography.bodyFont).toBe("Arial")
    expect(documentXml).toContain('<w:t xml:space="preserve">Launch Decision</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Prepared For</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Executive Team</w:t>')
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(stylesXml).toContain('<w:rFonts w:ascii="Arial"')
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  test("keeps google_docs_default first page simple and audits ignored header patterns", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.layout = {
      preset: "google_docs_default",
      headerPattern: "proposal_centerpiece",
      navigation: { mode: "none" },
    }
    spec.cover = {
      title: "Simple Docs Draft",
      subtitle: "Native-looking Word draft",
    }

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const stylesXml = await readDocxPart(bytes, "word/styles.xml")
    const issues = new WordDocSpecValidator().validate(spec)

    expect(resolveWordHeaderPattern(spec.layout)).toBe("none")
    expect(documentXml).toContain('<w:t xml:space="preserve">Simple Docs Draft</w:t>')
    expect(documentXml).not.toContain('<w:t xml:space="preserve">项目</w:t>')
    expect(documentXml).not.toContain('<w:t xml:space="preserve">Prepared For</w:t>')
    expect(stylesXml).toContain('<w:rFonts w:ascii="Arial"')
    expect(issues.map((issue) => issue.code)).toContain("google-docs-header-pattern-ignored")
  })

  test("writes definition lists and source lists as structured fixed-layout Word tables", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.metadata.documentType = "technical-reference"
    spec.sources = []
    spec.references = []
    spec.sections = [{
      id: "structured-blocks",
      level: 1,
      title: "Structured Blocks",
      formFactor: "definition-list",
      definitionList: [
        { term: "Review Gate", definition: "A required checkpoint before release.", note: "Owner confirms evidence." },
        { term: "Render Artifact", definition: "A PNG page image produced from the DOCX." },
      ],
      sourceList: [
        { sourceId: "REQ-1", title: "Internal Requirements", role: "internal", origin: "internal_company", path: "docs/requirements.docx", note: "Primary source." },
      ],
    }]

    const bytes = await new WordDocBuilder().build(spec)
    const documentXml = await readDocxPart(bytes, "word/document.xml")
    const issues = await new DocxRenderQualityGate().check(bytes)
    const validatorIssues = new WordDocSpecValidator().validate(spec)

    expect(documentXml).toContain('<w:t xml:space="preserve">术语</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">定义 / 说明</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Review Gate</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">备注：Owner confirms evidence.</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">来源</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">Internal Requirements</w:t>')
    expect(documentXml).toContain('<w:t xml:space="preserve">docs/requirements.docx</w:t>')
    expect(documentXml.match(/<w:tblLayout w:type="fixed"\/>/g)?.length).toBeGreaterThanOrEqual(2)
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(validatorIssues.some((issue) => issue.code === "missing-sources")).toBe(true)
  })

  test("reports common accessibility audit warnings for images tables and headings", async () => {
    const spec = minimalRenderableWordDocSpec()
    spec.sections = [
      {
        id: "top",
        level: 1,
        title: "Top Section",
        paragraphs: ["A11y audit sample."],
        figures: [{
          id: "fig-a11y",
          title: "A11y Figure",
          caption: "This image intentionally loses alt text in the test fixture.",
          image: {
            contentType: "image/png",
            bytes: tinyPngBytes(),
            width: 120,
            height: 80,
          },
        }],
        tables: [{
          headers: ["Field", "Value"],
          rows: [["Owner", "Team"]],
        }],
      },
      {
        id: "skipped",
        level: 3,
        title: "Skipped Level",
        paragraphs: ["This heading skips level 2."],
      },
    ]
    let bytes = await new WordDocBuilder().build(spec)
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml
      .replace(/\sdescr="[^"]*"/, ' descr=""')
      .replace("<w:tblHeader/>", ""))

    const issueCodes = (await new DocxRenderQualityGate().check(bytes)).map((issue) => issue.code)
    expect(issueCodes).toContain("a11y-missing-image-alt")
    expect(issueCodes).toContain("a11y-missing-table-header")
    expect(issueCodes).toContain("a11y-heading-level-skip")
  })

  test("reports table overflow and prose-heavy cell risks before visual rendering", async () => {
    const spec = minimalRenderableWordDocSpec()
    const longCell = "This table cell is intentionally written as prose rather than comparable row and column data. ".repeat(6)
    spec.references = []
    spec.sections = [{
      id: "wide-table",
      level: 1,
      title: "Wide Table",
      tables: [{
        headers: ["A", "B", "C", "D", "E", "F", "G"],
        rows: [[longCell, "b", "c", "d", "e", "f", "g"]],
        columnWidthRatios: [1, 1, 1, 1, 1, 1, 1],
      }],
    }]

    let bytes = await new WordDocBuilder().build(spec)
    bytes = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml
      .replace(/<w:tblW w:w="\d+" w:type="dxa"\/>/, '<w:tblW w:w="20000" w:type="dxa"/>')
      .replace(/<w:gridCol w:w="\d+"\/>/, '<w:gridCol w:w="20000"/>'))

    const warnings = (await new DocxRenderQualityGate().check(bytes))
      .filter((issue) => issue.code === "table-overflow-risk")
      .map((issue) => issue.message)
    expect(warnings.some((message) => message.includes("exceeds usable page width"))).toBe(true)
    expect(warnings.some((message) => message.includes("has 7 columns"))).toBe(true)
    expect(warnings.some((message) => message.includes("long prose-heavy cells"))).toBe(true)
  })

  test("rejects Word 2016 repair-prone ordering and broken package relationships", async () => {
    const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
    const repairProneParagraph = await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace(
      '<w:pStyle w:val="Title"/><w:spacing w:before="0" w:after="220"/><w:jc w:val="center"/>',
      '<w:pStyle w:val="Title"/><w:jc w:val="center"/><w:spacing w:before="0" w:after="220"/>',
    ))
    const brokenRelationship = await replaceDocxPart(repairProneParagraph, "word/_rels/document.xml.rels", (xml) => xml.replace('Target="styles.xml"', 'Target="missing-styles.xml"'))

    const issueCodes = (await new DocxRenderQualityGate().check(brokenRelationship)).map((issue) => issue.code)

    expect(issueCodes).toContain("repair-prone-paragraph-property-order")
    expect(issueCodes).toContain("relationship-target-missing")
    expect(issueCodes).toContain("missing-styles-relationship")
  })

  test("create_word_document fails closed when the DOCX structural gate reports an error", async () => {
    const root = await tempDir("chipmate-doc-agent-blocked-docx-")
    workspaceFolders = [{ name: "repo", uri: UriShim.file(root) }]
    const originalCheck: typeof DocxRenderQualityGate.prototype.check = DocxRenderQualityGate.prototype.check
    DocxRenderQualityGate.prototype.check = async () => [{
      severity: "error",
      code: "forced-word2016-repair",
      message: "forced invalid docx",
    }]
    try {
      await expect(createWordDocument({
        spec: minimalRenderableWordDocSpec(),
        filename: "blocked.docx",
      })).rejects.toThrow("forced invalid docx")
      expect(existsSync(join(root, ".chipmate", "docs"))).toBe(false)
    } finally {
      DocxRenderQualityGate.prototype.check = originalCheck
    }
  })

  test("keeps internal examples as preserved examples on rule cards", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部参考规范。请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          mentionIndex: 0,
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{
              heading: "指针与内存安全",
              paragraphs: ["必须检查指针参数是否为空。", "示例：if (ptr == NULL) {\n    return -EINVAL;\n}\nreturn 0;"],
            }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          mentionIndex: 1,
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "错误处理", paragraphs: ["应该统一检查返回值并处理错误路径。"] }],
          }),
        },
      ],
      model: new FakeModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.preservedExamples?.length)
    expect(rule?.preservedExamples?.[0]?.preserveMode).toBe("verbatim-short")
    expect(rule?.preservedExamples?.[0]?.source.sourceOrigin).toBe("internal_company")
    expect(rule?.preservedExamples?.[0]?.source.sourceId).toBe("src-1")
    expect(rule?.preservedExamples?.[0]?.source.headingPath.join(" > ")).toContain("指针")
    expect(rule?.preservedExamples?.[0]?.source.sourceLocation.path).toBe("docs/company-c-guideline.docx")
    expect(rule?.preservedExamples?.[0]?.source.originalBlockHash.normalizedHash).toHaveLength(64)
  })

  test("repairs cross-wired storage consistency rule fields and keeps internal examples rule-local", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范。请综合这些资料，生成团队 C 语言编码规范 Word。",
      files: [{
        path: "docs/company-c-guideline.docx",
        mentionIndex: 0,
        bytes: cGuidelineDocxFixture({
          title: "IPD-R-10003355 C&C++编码规范V1.3",
          sections: [{ heading: "4.18 存储访问一致性", paragraphs: storageConsistencyParagraphs() }],
        }),
      }, {
        path: "docs/external-c-guideline.docx",
        mentionIndex: 1,
        bytes: cGuidelineDocxFixture({
          title: "外部 C 编码规范参考资料",
          sections: [{ heading: "错误处理", paragraphs: ["应该检查返回值并处理失败路径。"] }],
        }),
      }],
      model: new StorageConsistencyCrossWireModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rules = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []) ?? []
    const syncRule = rules.find((rule) => rule.name.includes("多主设备") || rule.sourceRuleAnchor === "规则18-1.2")
    const syncText = [
      syncRule?.description,
      syncRule?.recommended,
      syncRule?.discouraged,
      syncRule?.rationale,
      syncRule?.exceptions,
      syncRule?.generatedExamples?.map((example) => `${example.badExample ?? ""}\n${example.goodExample ?? ""}`).join("\n"),
    ].filter(Boolean).join("\n")
    const preservedText = (syncRule?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")
    const atomicText = rules.find((rule) => rule.sourceRuleAnchor === "规则18-1.3")?.description ?? ""
    const eccText = rules.find((rule) => rule.sourceRuleAnchor === "规则18-1.4")?.description ?? ""

    expect(syncText).toContain("写者传递信息给读者前，需要做存储同步")
    expect(syncText).not.toMatch(/可能失败|返回值|错误码|memcpy\(buffer|EINVAL/)
    expect(syncRule?.generatedExamples ?? []).toHaveLength(0)
    expect(preservedText).toContain("halCpu_InsertDataSynchronizationBarrier")
    expect(atomicText).toContain("锁")
    expect(eccText).toContain("ECC")
  })

  test("generates a non-verbatim supplemental example when external rules have no examples", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部参考规范。请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          mentionIndex: 0,
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "指针与内存安全", paragraphs: ["必须检查指针参数是否为空。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          mentionIndex: 1,
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "错误处理", paragraphs: ["应该统一检查返回值并处理错误路径。"] }],
          }),
        },
      ],
      model: new FakeModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.generatedExamples?.length)
    const example = rule?.generatedExamples?.[0]
    expect(example?.origin).toBe("generated")
    expect(example?.isVerbatim).toBe(false)
    expect(example?.generationMode).toBe("model-generated-from-rule")
    expect(example?.language).toBe("c")
    expect(example?.exampleType).toBe("bad-good-pair")
    expect(example?.badExample).toBeTruthy()
    expect(example?.goodExample).toBeTruthy()
  })

  test("adapts external examples without treating them as verbatim excerpts", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部参考规范。请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          mentionIndex: 0,
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "指针与内存安全", paragraphs: ["必须检查指针参数是否为空。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          mentionIndex: 1,
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "错误处理", paragraphs: ["示例：调用 device_init 后应该检查 status，并在失败时返回错误码。"] }],
          }),
        },
      ],
      model: new FakeModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.generatedExamples?.length)
    const example = rule?.generatedExamples?.[0]
    expect(example?.origin).toBe("adapted")
    expect(example?.isVerbatim).toBe(false)
    expect(example?.generationMode).toBe("adapted-from-source")
    expect(example?.sourceRefs?.[0]).toContain("src-2")
    expect(rule?.preservedExamples?.some((block) => block.source.sourceOrigin !== "internal_company")).toBeFalsy()
  })

  test("places non-standard internal comment examples into the semantic rule card instead of the final examples section", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部参考规范。请综合这些资料，生成团队 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          mentionIndex: 0,
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{
              heading: "4.4.1 注释风格",
              paragraphs: [
                "【建议4-1.1】单行后注释使用 ///< ...text…，即三个斜杠+一个尖括号+一个空格。",
                "对于较短的表达式使用单行后注释，实例如下：",
                "uint32_t speed; ///< 电机转速",
                "【建议4-1.2】单行前注释使用 /// ...text…。",
                "对于较长的表达式使用单行前注释，实例如下：",
                "/// 电机状态，包含初始化、运行和故障状态",
                "motor_state_t state;",
                "【规则4-1.2】简单说明可使用英文注释，复杂性描述建议使用中文注释。",
                "【规则4-1.3】注释与所描述内容进行同样的缩排对齐。",
              ],
            }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          mentionIndex: 1,
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "注释规范", paragraphs: ["应该保持注释与代码一致，并避免无意义注释。"] }],
          }),
        },
      ],
      model: new CommentStylePlacementModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const commentRule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((rule) => rule.name.includes("注释风格"))
    const preservedText = (commentRule?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")
    const finalExampleText = (capturedSpec?.sections.find((section) => section.id === "examples")?.sourceBackedBlocks ?? []).map(sourceBlockTextForTest).join("\n")

    expect(commentRule).toBeTruthy()
    expect(preservedText).toContain("///<")
    expect(preservedText).toContain("/// 电机状态")
    expect(finalExampleText).not.toContain("///<")
    expect(finalExampleText).not.toContain("/// 电机状态")
  })

  test("keeps low-confidence source examples out of rule cards and reports a warning", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部参考规范。请综合这些资料，生成团队 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          mentionIndex: 0,
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "4.4.1 注释风格", paragraphs: ["uint32_t speed; ///< 电机转速"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          mentionIndex: 1,
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "注释规范", paragraphs: ["应该保持注释与代码一致。"] }],
          }),
        },
      ],
      model: new CommentStylePlacementModelProvider(0.2, "docs/company-c-guideline.docx / 待模型判断章节"),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const commentRule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((rule) => rule.name.includes("注释风格"))
    const preservedText = (commentRule?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")

    expect(preservedText).not.toContain("///<")
    expect(result.warnings.some((warning) => warning.includes("未能高置信归位") || warning.includes("未归入具体规则"))).toBe(true)
  })

  test("preplaces clear internal source examples without calling the placement model", async () => {
    const model = new CountingSourcePlacementModelProvider()
    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [placementBlock({
        kind: "example",
        text: "示例：if (ptr == NULL) return -EINVAL;",
      })],
    })

    const rule = result.rules[0]
    const preservedText = (rule?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")
    expect(model.placementCalls).toBe(0)
    expect(result.assignedBlockIds).toContain("block-1")
    expect(preservedText).toContain("ptr == NULL")
  })

  test("preplaces internal source examples by rule-local anchor before same-section fallback", async () => {
    const result = await new SourceBlockPlacementPlanner(undefined).apply({
      question: "请综合生成团队规范。",
      rules: [
        placementRule({
          ruleId: "C-022",
          name: "多主设备共享变量写入后需存储同步",
          scope: "存储访问一致性",
          description: "多主设备访问的共享变量，写者传递信息给读者前，需要做存储同步。",
          sources: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.2"],
          sourceRuleAnchor: "规则18-1.2",
        }),
        placementRule({
          ruleId: "C-023",
          name: "共享变量访问需保证原子性",
          scope: "存储访问一致性",
          description: "对共享变量的访问，若存储设备不能保证原子性，则需要通过锁保证一致性。",
          sources: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.3"],
          sourceRuleAnchor: "规则18-1.3",
        }),
      ],
      blocks: [placementBlock({
        id: "sync-code",
        kind: "code",
        text: undefined,
        codeBlock: { code: "halCpu_InsertDataSynchronizationBarrier();\nnfc_hal_seq_add_desc_cnt(1);" },
        source: {
          sourcePath: "docs/company-c-guideline.docx",
          headingPath: ["4.18 存储访问一致性"],
          sourceLocation: { path: "docs/company-c-guideline.docx", headingPath: ["4.18 存储访问一致性"], sourceRuleAnchor: "规则18-1.2" },
          sourceRuleAnchor: "规则18-1.2",
        },
      })],
    })

    const syncText = (result.rules.find((rule) => rule.ruleId === "C-022")?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")

    expect(result.assignedBlockIds).toContain("sync-code")
    expect(syncText).toContain("halCpu_InsertDataSynchronizationBarrier")
    expect(result.rules.find((rule) => rule.ruleId === "C-023")?.preservedExamples?.length ?? 0).toBe(0)
  })

  test("keeps ambiguous same-section source examples for model placement", async () => {
    const model = new CountingSourcePlacementModelProvider("RULE-B")
    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [
        placementRule({ ruleId: "RULE-A", name: "指针参数检查" }),
        placementRule({ ruleId: "RULE-B", name: "错误返回处理" }),
      ],
      blocks: [placementBlock({
        kind: "example",
        text: "示例：if (ptr == NULL) return -EINVAL;",
      })],
    })

    expect(model.placementCalls).toBe(1)
    expect(result.rules.find((rule) => rule.ruleId === "RULE-A")?.preservedExamples?.length ?? 0).toBe(0)
    expect(result.rules.find((rule) => rule.ruleId === "RULE-B")?.preservedExamples?.[0]?.id).toBe("block-1")
  })

  test("does not preplace source blocks that only share a heading but come from another document", async () => {
    const result = await new SourceBlockPlacementPlanner(undefined).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule({ sources: ["docs/company-a.docx / 指针与内存安全"] })],
      blocks: [placementBlock({
        kind: "example",
        text: "示例：if (ptr == NULL) return -EINVAL;",
        source: {
          sourceId: "src-other",
          sourceName: "company-b.docx",
          sourcePath: "docs/company-b.docx",
          sourceLocation: { path: "docs/company-b.docx", headingPath: ["指针与内存安全"] },
        },
      })],
    })

    expect(result.assignedBlockIds).toEqual([])
    expect(result.rules[0]?.preservedExamples?.length ?? 0).toBe(0)
    expect(result.warnings.join("\n")).toContain("内部来源示例未归入具体规则")
  })

  test("caches model-backed source block placements and invalidates by model name", async () => {
    const cache = new MemoryPlacementCache()
    const block = placementBlock({
      kind: "example",
      text: "示例：外部资料建议检查返回值。",
      source: { sourceOrigin: "external_public", sourceRole: "external" },
      preserveMode: "adapted-example",
    })
    const firstModel = new CountingSourcePlacementModelProvider("RULE-1")
    const first = await new SourceBlockPlacementPlanner(firstModel, { cache, modelName: "placement-model-a" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [block],
    })
    const secondModel = new CountingSourcePlacementModelProvider("RULE-1")
    const second = await new SourceBlockPlacementPlanner(secondModel, { cache, modelName: "placement-model-a" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [block],
    })
    const thirdModel = new CountingSourcePlacementModelProvider("RULE-1")
    await new SourceBlockPlacementPlanner(thirdModel, { cache, modelName: "placement-model-b" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [block],
    })

    expect(firstModel.placementCalls).toBe(1)
    expect(first.rules[0]?.generatedExamples?.[0]?.sourceRefs?.[0]).toContain("src-1")
    expect(secondModel.placementCalls).toBe(0)
    expect(second.rules[0]?.generatedExamples?.[0]?.sourceRefs?.[0]).toContain("src-1")
    expect(thirdModel.placementCalls).toBe(1)
  })

  test("adapts external English source examples without copying raw English prose", async () => {
    const model = new CountingSourcePlacementModelProvider("RULE-1")
    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [placementBlock({
        kind: "example",
        title: "Supplemental Example",
        text: "Use header guards to prevent multiple inclusion.",
        source: { sourceOrigin: "external_public", sourceRole: "external" },
        preserveMode: "adapted-example",
      })],
    })
    const example = result.rules[0]?.generatedExamples?.[0]

    expect(example?.title).toBe("补充示例：根据外部参考原则改写")
    expect(example?.goodExample).not.toMatch(/Use header guards|multiple inclusion|Supplemental Example/i)
    expect(example?.goodExample).toContain("推荐")
    expect(example?.origin).toBe("adapted")
    expect(example?.isVerbatim).toBe(false)
    expect(example?.sourceRefs?.[0]).toContain("src-1")
    expect(result.rules[0]?.exampleWarnings?.some((warning) => warning.includes("外部来源示例包含英文原文"))).toBe(true)
  })

  test("splits failed placement batches and keeps successful sub-batch placements", async () => {
    const model = new SplitRetryPlacementModelProvider()
    const blocks = Array.from({ length: 6 }, (_, index) => placementBlock({
      id: `block-${index + 1}`,
      text: `示例：外部资料第 ${index + 1} 条建议检查返回值。`,
      source: {
        sourceOrigin: "external_public",
        sourceRole: "external",
        sourceBlockId: `source-block-${index + 1}`,
        blockIndex: index + 1,
        originalBlockHash: { rawHash: `raw-${index + 1}`, normalizedHash: `normalized-${index + 1}` },
      },
      preserveMode: "adapted-example",
    }))

    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks,
    })

    expect(model.placementCalls).toBeGreaterThan(1)
    expect(result.assignedBlockIds.length).toBe(6)
    expect(result.warnings.some((warning) => warning.includes("缩小批次重试"))).toBe(true)
  })

  test("skips only the failing source block when single-block placement still fails", async () => {
    const model = new SingleFailPlacementModelProvider()
    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [placementBlock({
        source: { sourceOrigin: "external_public", sourceRole: "external" },
        preserveMode: "adapted-example",
      })],
    })

    expect(model.placementCalls).toBe(1)
    expect(result.assignedBlockIds).toEqual([])
    expect(result.warnings.some((warning) => warning.includes("已跳过该来源块"))).toBe(true)
  })

  test("does not cache invalid placement outputs with empty targets or unassigned placement", async () => {
    const cache = new MemoryPlacementCache()
    const result = await new SourceBlockPlacementPlanner(new InvalidPlacementModelProvider(), { cache, modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules: [placementRule()],
      blocks: [placementBlock({
        source: { sourceOrigin: "external_public", sourceRole: "external" },
        preserveMode: "adapted-example",
      })],
    })

    expect(result.assignedBlockIds).toEqual([])
    expect(cache.size()).toBe(0)
  })

  test("merges source block placement batches and sends only relevant rule cards", async () => {
    const model = new CountingSourcePlacementModelProvider()
    const blocks = Array.from({ length: 80 }, (_, index) => placementBlock({
      id: `block-${index + 1}`,
      text: `示例：外部资料第 ${index + 1} 条建议检查返回值。`,
      source: {
        sourceOrigin: "external_public",
        sourceRole: "external",
        sourceBlockId: `source-block-${index + 1}`,
        blockIndex: index + 1,
        sectionBlockIndex: 1,
        headingPath: [`章节 ${index + 1}`],
        sourceLocation: { path: "docs/external.docx", headingPath: [`章节 ${index + 1}`] },
        originalBlockHash: { rawHash: `raw-${index + 1}`, normalizedHash: `normalized-${index + 1}` },
      },
      preserveMode: "adapted-example",
    }))
    const rules = Array.from({ length: 20 }, (_, index) => placementRule({
      ruleId: `RULE-${index + 1}`,
      name: `返回值检查 ${index + 1}`,
      sources: ["docs/external.docx / 返回值检查"],
    }))

    const result = await new SourceBlockPlacementPlanner(model, { modelName: "placement-model" }).apply({
      question: "请综合生成团队规范。",
      rules,
      blocks,
    })

    expect(model.placementCalls).toBeGreaterThan(0)
    expect(model.placementCalls).toBeLessThanOrEqual(10)
    expect(model.maxBlocksPerPrompt).toBeLessThanOrEqual(8)
    expect(model.maxRulesPerPrompt).toBeLessThanOrEqual(6)
    expect(result.assignedBlockIds.length).toBe(80)
  })

  test("generates file-layout examples for source/header pairing rules instead of generic buffer code", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例，并在不推荐示例中给出不推荐原因。")
    const [rule] = new CCodingGuidelineExamplePlanner(plan).attachExamples([sourceHeaderPairRule()])
    const example = rule?.generatedExamples?.[0]
    const text = `${example?.badExample ?? ""}\n${example?.goodExample ?? ""}`

    expect(example?.exampleFormat).toBe("file-layout")
    expect(example?.language).toBeUndefined()
    expect(example?.badExampleReason).toContain("头文件")
    expect(text).toMatch(/\.c|\.h|#include/)
    expect(text).not.toMatch(/do_work|buffer|EINVAL/)
    expect(example?.badExample).not.toContain("公开接口只能")
  })

  test("adds bad example reasons to relevant existing generated examples when requested", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例，并在不推荐示例中给出不推荐原因。")
    const [rule] = new CCodingGuidelineExamplePlanner(plan).attachExamples([{
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "file-layout-existing-example",
        title: "补充示例：根据规则生成",
        exampleType: "bad-good-pair",
        exampleFormat: "file-layout",
        badExample: "// motor.c\nint motor_init(const motor_config_t *config)\n{\n    return 0;\n}",
        goodExample: "// motor.h\nint motor_init(const motor_config_t *config);\n\n// motor.c\n#include \"motor.h\"",
        explanation: "源文件和头文件配对示例。",
        sourceRefs: ["docs/company-c-guideline.docx / 文件结构"],
        generationMode: "model-generated-from-rule",
        origin: "generated",
        isVerbatim: false,
      }],
    }])

    expect(rule?.generatedExamples?.[0]?.badExampleReason).toContain("头文件")
  })

  test("drops irrelevant generated examples returned by the model and replans from rule semantics", async () => {
    const plan = await minimalExamplePlan()
    const [rule] = new CCodingGuidelineExamplePlanner(plan).attachExamples([{
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "bad-generated-example",
        title: "补充示例：根据规则生成",
        language: "c",
        exampleType: "bad-good-pair",
        exampleFormat: "code",
        badExample: "int status = do_work(buffer, count);",
        goodExample: "if (buffer == NULL) {\n    return -EINVAL;\n}\nreturn do_work(buffer, count);",
        explanation: "无关的通用参数检查示例。",
        sourceRefs: ["docs/company-c-guideline.docx / 文件结构"],
        generationMode: "model-generated-from-rule",
        origin: "generated",
        isVerbatim: false,
      }],
    }])
    const example = rule?.generatedExamples?.[0]
    const text = `${example?.badExample ?? ""}\n${example?.goodExample ?? ""}`

    expect(rule?.exampleWarnings?.some((warning) => warning.includes("不匹配"))).not.toBe(true)
    expect(example?.exampleFormat).toBe("file-layout")
    expect(text).toMatch(/\.c|\.h|#include/)
    expect(text).not.toMatch(/do_work|buffer|EINVAL/)
  })

  test("reports missing bad example reasons when the plan requires them", async () => {
    const plan = await minimalExamplePlan("请给每条规则写一个最小示例，并在不推荐示例中给出不推荐原因。")
    const rule = {
      ...sourceHeaderPairRule(),
      generatedExamples: [{
        id: "missing-reason-example",
        title: "补充示例",
        exampleType: "bad-good-pair",
        exampleFormat: "file-layout",
        badExample: "// motor.c\nint motor_init(const motor_config_t *config)\n{\n    return 0;\n}",
        goodExample: "// motor.h\nint motor_init(const motor_config_t *config);",
        explanation: "源文件和头文件配对示例。",
        sourceRefs: ["docs/company-c-guideline.docx / 文件结构"],
        generationMode: "model-generated-from-rule",
        origin: "generated",
        isVerbatim: false,
      }],
    }
    const issues = new ReportQualityGate().check({
      documents: [{
        id: "src-1",
        role: "internal",
        mentionIndex: 0,
        sourceOrigin: "internal_company",
        read: {
          metadata: { path: "docs/company.docx", title: "公司规范", byteSize: 1, truncated: false, readWarnings: [] },
          blocks: [],
          textPreview: "",
        },
      }],
      pack: { documents: [], warnings: [], internalSummary: "", externalSummary: "", overlapRules: [], conflictRules: [], missingInternalRules: [], unsuitableExternalRules: [] },
      rules: [rule],
      spec: {
        metadata: { title: "团队 C 语言编码规范", documentType: "c-coding-guideline", language: "zh-CN", generatedAt: new Date().toISOString() },
        sources: [],
        sections: [{ id: "rules", level: 1, title: "团队版规则正文", ruleCards: [rule] }],
      },
      plan,
    })

    expect(issues.some((issue) => issue.code === "missing-bad-example-reasons")).toBe(true)
  })

  test("emits timeline events and applies user conflict decisions before rendering", async () => {
    const timeline: DocAgentTimelineEvent[] = []
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "命名规范", paragraphs: ["建议不强制使用模块前缀，以保持接口简洁。"] }],
          }),
        },
      ],
      model: new ConflictModelProvider(),
      onTimeline: (event) => timeline.push(event),
      resolveConflictDecisions: async (conflicts) => conflicts.map((conflict) => ({ conflictId: conflict.id, choice: "external" })),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return {
          path: ".chipmate/docs/conflict-sample.docx",
          absolutePath: "/workspace/.chipmate/docs/conflict-sample.docx",
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

    expect(result.path).toBe(".chipmate/docs/conflict-sample.docx")
    expect(timeline.some((event) => event.type === "read_docx")).toBe(true)
    expect(timeline.some((event) => event.type === "chunking")).toBe(true)
    expect(timeline.some((event) => event.type === "model.extract")).toBe(true)
    const visibleTimeline = groupedTimelineEvents(timeline)
    expect(visibleTimeline.get("model.extract")).toEqual(expect.objectContaining({
      type: "model.extract",
      status: "completed",
      stateLabel: "完成",
    }))
    expect([...visibleTimeline.keys()].some((key) => key.startsWith("extract:") || key.startsWith("extract-batch:"))).toBe(false)
    expect(timeline.some((event) => event.type === "conflict.review" && event.status === "waiting")).toBe(true)
    expect(timeline.some((event) => event.type === "merge")).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("采用第二份 1 条"))).toBe(true)
    const conflictSection = capturedSpec?.sections.find((section) => section.id === "conflicts")
    expect(conflictSection?.tables?.[0]?.headers).toContain("用户决策")
    expect(conflictSection?.tables?.[0]?.rows[0]).toContain("采用第二份/外部参考")
  })

  test("applies document plan title, automatic internal conflict policy, examples, and requested sections", async () => {
    const timeline: DocAgentTimelineEvent[] = []
    let capturedSpec: WordDocSpec | undefined
    let capturedFilename = ""
    let resolverCalled = false

    const result = await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料生成 Word。文档标题用 XXX团队C语言编码规范。如果遇到冲突直接采用团队内部文档。请给每条规则写一个最小示例，把规则名称和适用范围写得更易懂。加入落地路线图章节。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "命名规范", paragraphs: ["建议不强制使用模块前缀，以保持接口简洁。"] }],
          }),
        },
      ],
      model: new ConflictModelProvider(),
      onTimeline: (event) => timeline.push(event),
      resolveConflictDecisions: async () => {
        resolverCalled = true
        return []
      },
      createDocument: async ({ spec, filename }) => {
        capturedSpec = spec
        capturedFilename = filename ?? ""
        return {
          path: `.chipmate/docs/${filename}.docx`,
          absolutePath: `/workspace/.chipmate/docs/${filename}.docx`,
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

    expect(resolverCalled).toBe(false)
    expect(result.title).toBe("XXX团队C语言编码规范")
    expect(capturedFilename).toContain("XXX团队C语言编码规范")
    expect(capturedSpec?.metadata.title).toBe("XXX团队C语言编码规范")
    expect(capturedSpec?.cover?.title).toBe("XXX团队C语言编码规范")
    expect(timeline.some((event) => event.type === "conflict.review" && event.status === "waiting")).toBe(false)
    expect(timeline.some((event) => event.type === "conflict.review" && event.detail?.includes("采用第一份"))).toBe(true)
    const conflictSection = capturedSpec?.sections.find((section) => section.id === "conflicts")
    expect(conflictSection?.tables?.[0]?.rows[0]).toContain("采用第一份/内部规范")
    const rules = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []) ?? []
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every((rule) => (rule.generatedExamples?.length ?? 0) + (rule.preservedExamples?.length ?? 0) > 0)).toBe(true)
    expect(capturedSpec?.sections.some((section) => section.title.includes("落地路线图"))).toBe(true)
  })

  test("normalizes unreadable generated rule scopes out of the final WordDocSpec", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。把适用范围写得更易懂。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "命名规范", paragraphs: ["应该保持命名一致。"] }],
          }),
        },
      ],
      model: new ScopeSlugModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return {
          path: ".chipmate/docs/scope-sample.docx",
          absolutePath: "/workspace/.chipmate/docs/scope-sample.docx",
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

    const rules = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []) ?? []
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every((rule) => !/c-gen/i.test(rule.scope))).toBe(true)
    expect(rules.some((rule) => rule.scope === "通用编码原则")).toBe(true)
  })

  test("keeps model-led semantic diagnostics non-blocking when examples are suspicious", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new ModelLedDraftProvider({
        composeRules: [modelLedRule({
          ruleId: "C-018",
          name: "数组下标与成员运算符紧邻",
          scope: "数组和结构体访问表达式",
          description: "数组下标、结构体成员和函数调用等后缀运算符应紧邻被操作对象。",
          recommended: "保持 array[index]、object.member、func(arg) 这类表达式紧凑一致。",
          discouraged: "不要在对象和后缀运算符之间插入无意义空格。",
          generatedExamples: [modelLedExample({
            badExample: "memcpy(buffer, input, count);",
            goodExample: "if (input == NULL) {\n    return -EINVAL;\n}\nmemcpy(buffer, input, count);",
          })],
        })],
      }),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-018")
    expect(result.path).toBe(".chipmate/docs/example-sample.docx")
    expect(rule?.name).toBe("数组下标与成员运算符紧邻")
    expect(rule?.generatedExamples?.[0]?.goodExample).toContain("memcpy")
    expect(result.warnings.some((warning) => warning.includes("生成示例与规则语义不匹配"))).toBe(true)
  })

  test("resolves model preservedExampleRefs into real internal preserved examples", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFilesWithInternalExample(),
      model: new RefAwareModelLedDraftProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-REF")
    const preservedText = (rule?.preservedExamples ?? []).map(sourceBlockTextForTest).join("\n")

    expect(rule?.preservedExamples?.length).toBeGreaterThan(0)
    expect(rule?.preservedExamples?.[0]?.source.sourceOrigin).toBe("internal_company")
    expect(rule?.preservedExamples?.[0]?.source.sourceBlockId).toBeTruthy()
    expect(rule?.preservedExamples?.[0]?.source.originalBlockHash.normalizedHash).toBeTruthy()
    expect(preservedText).toContain("ptr == NULL")
  })

  test("rejects model-fabricated preservedExamples and removes verbatim generatedExamples without hard failing", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFilesWithInternalExample(),
      model: new ModelLedDraftProvider({
        composeRules: [{
          ...modelLedRule({ ruleId: "C-BAD", name: "指针比较必须显式判断 NULL" }),
          preservedExamples: [placementBlock()],
          generatedExamples: [modelLedExample({
            isVerbatim: true as never,
            badExample: "if (ptr) { use(ptr); }",
            goodExample: "if (ptr != NULL) { use(ptr); }",
          })],
        } as never],
      }),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-BAD")
    expect(rule?.preservedExamples?.some((block) => block.source.sourcePath === "docs/company-a.docx")).toBe(false)
    expect((rule?.generatedExamples ?? []).every((example) => example.isVerbatim === false)).toBe(true)
    expect((rule?.generatedExamples ?? []).map((example) => example.badExample).join("\n")).not.toContain("if (ptr) { use(ptr); }")
    expect(result.warnings.some((warning) => warning.includes("直接构造 preservedExamples"))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("原文示例必须通过 preservedExampleRefs"))).toBe(true)
  })

  test("places model-classified implementation, risk, and reference items into report sections", async () => {
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new ModelLedDraftProvider({
        composeRules: [modelLedRule()],
        implementationGuidanceItems: [{
          classification: "implementation-guidance",
          title: "静态扫描落地",
          text: "在 CI 中记录告警解释和偏差审批。",
          sourceRefs: ["docs/external-c-guideline.docx / 通用 C 规则"],
        }],
        riskLimitItems: [{
          classification: "risk-limit",
          title: "授权资料边界",
          text: "授权资料仅用于团队内部评审，不复制完整规则文本。",
          sourceRefs: ["docs/external-c-guideline.docx / 通用 C 规则"],
        }],
        referenceOnlyItems: [{
          classification: "reference-only",
          title: "附录索引",
          text: "附录索引只作为参考，不生成正式规则。",
          sourceRefs: ["docs/external-c-guideline.docx / 通用 C 规则"],
        }],
      }),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    expect(capturedSpec?.sections.find((section) => section.id === "static-analysis")?.bullets?.join("\n")).toContain("静态扫描落地")
    expect(capturedSpec?.sections.find((section) => section.id === "risks-limits")?.bullets?.join("\n")).toContain("授权资料边界")
    expect(capturedSpec?.sections.find((section) => section.id === "references")?.bullets?.join("\n")).toContain("附录索引")
  })

  test("normalizes generatedExamples returned by generate-word-spec before the quality gate", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new WordSpecVerbatimExampleModelProvider(),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-WORDSPEC")
    expect(result.path).toBe(".chipmate/docs/example-sample.docx")
    expect((rule?.generatedExamples ?? []).every((example) => example.isVerbatim === false)).toBe(true)
    expect(result.warnings.some((warning) => warning.includes("生成示例不能标记为原文摘录"))).toBe(false)
  })

  test("lets the model review patch a placeholder rule into a concrete RuleCard", async () => {
    const timeline: DocAgentTimelineEvent[] = []
    let capturedSpec: WordDocSpec | undefined

    await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new ModelLedDraftProvider({
        composeRules: [modelLedRule({
          ruleId: "C-019",
          name: "外部参考规则",
          scope: "通用编码原则",
          description: "该规则来自外部参考资料，需要模型具体化。",
        })],
        reviewFindings: [{
          severity: "critical",
          ruleId: "C-019",
          issue: "规则仍是占位名，需要具体化后才能进入正式 RuleCard。",
          suggestedPatch: modelLedRule({
            ruleId: "C-019",
            name: "使用有意义的常量名称替代魔法数",
            scope: "宏、常量和字面量",
            description: "非平凡数字应定义为带模块语义和单位信息的常量，避免裸数字散落在实现中。",
            recommended: "使用 SENSOR_TIMEOUT_MS 这类名称表达用途和单位。",
            discouraged: "不要在业务逻辑中直接写入 1000、3、16 等难以解释的裸数字。",
            rationale: "有意义的常量名称可以降低误改风险，并让评审者快速理解数值含义。",
            generatedExamples: [modelLedExample({
              badExample: "delay_ms(1000);",
              goodExample: "#define SENSOR_TIMEOUT_MS (1000U)\n\ndelay_ms(SENSOR_TIMEOUT_MS);",
              badExampleReason: "裸数字没有表达用途和单位，后续维护时容易被误改。",
            })],
          }),
        }],
      }),
      onTimeline: (event) => timeline.push(event),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rules = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []) ?? []
    expect(rules.some((rule) => rule.name === "外部参考规则")).toBe(false)
    expect(rules.some((rule) => rule.name === "使用有意义的常量名称替代魔法数")).toBe(true)
    expect(capturedSpec?.sections.some((section) => section.id === "pending-review-candidates")).toBe(false)
    expect(timeline.some((event) => event.type === "revise-draft" && event.stateLabel === "已修订")).toBe(true)
  })

  test("moves unfixable placeholder rules into pending review instead of failing generation", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new ModelLedDraftProvider({
        composeRules: [modelLedRule({
          ruleId: "C-019",
          name: "外部参考规则",
          scope: "通用编码原则",
          description: "该候选项无法从来源中确认具体编码动作。",
        })],
        reviewFindings: [{
          severity: "critical",
          ruleId: "C-019",
          issue: "无法根据来源资料具体化为可执行编码规则。",
        }],
      }),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const formalRules = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []) ?? []
    const pendingSection = capturedSpec?.sections.find((section) => section.id === "pending-review-candidates")
    expect(formalRules.some((rule) => rule.name === "外部参考规则")).toBe(false)
    expect(pendingSection?.title).toBe("待人工复核候选项")
    expect(pendingSection?.tables?.[0]?.rows[0]).toContain("外部参考规则")
    expect(result.warnings.some((warning) => warning.includes("已移入待人工复核候选项"))).toBe(true)
  })

  test("removes unrepaired example mismatch findings from formal rules without blocking Word generation", async () => {
    let capturedSpec: WordDocSpec | undefined

    const result = await new GuidelineReferencePackFlow().run({
      question: "第一份是公司内部规范，第二份是外部通用规范。请综合生成团队 C 语言编码规范 Word。",
      files: modelLedSourceFiles(),
      model: new ModelLedDraftProvider({
        composeRules: [modelLedRule({
          ruleId: "C-036",
          name: "声明指针时必须初始化",
          scope: "指针生命周期",
          description: "指针声明时必须初始化为 NULL 或有效对象地址，避免未初始化指针被误用。",
          recommended: "声明时初始化，并在使用前检查指针有效性。",
          discouraged: "不要声明未初始化指针后直接解引用。",
          generatedExamples: [modelLedExample({
            badExample: "int *ptr;\n*ptr = 1;",
            goodExample: "int *ptr = NULL;\nif (ptr != NULL) {\n    *ptr = 1;\n}",
          })],
        })],
        reviewFindings: [{
          severity: "critical",
          ruleId: "C-036",
          issue: "示例与规则语义不匹配，无法可靠修复。",
        }],
      }),
      createDocument: async ({ spec }) => {
        capturedSpec = spec
        return generatedResult(spec)
      },
    })

    const rule = capturedSpec?.sections.flatMap((section) => section.ruleCards ?? []).find((item) => item.ruleId === "C-036")
    expect(rule?.name).toBe("声明指针时必须初始化")
    expect(rule?.generatedExamples ?? []).toEqual([])
    expect(rule?.exampleWarnings?.join("\n")).toContain("示例未能可靠生成")
    expect(result.warnings.some((warning) => warning.includes("示例未能可靠生成，已移除"))).toBe(true)
  })

  test("logs extraction fallback details while keeping visible timeline grouped", async () => {
    const timeline: DocAgentTimelineEvent[] = []
    const logs: string[] = []

    const result = await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "指针规范", paragraphs: ["必须检查指针参数是否为空。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "错误处理", paragraphs: ["应该检查返回值并处理错误路径。"] }],
          }),
        },
      ],
      model: new BatchAndSingleFailModelProvider("sourcePath:"),
      onTimeline: (event) => timeline.push(event),
      log: (message) => logs.push(message),
      createDocument: async ({ spec }) => ({
        path: ".chipmate/docs/fallback-sample.docx",
        absolutePath: "/workspace/.chipmate/docs/fallback-sample.docx",
        sourceCount: spec.sources.length,
        warningCount: 0,
        warnings: [],
        errors: [],
      }),
    })

    const visibleTimeline = groupedTimelineEvents(timeline)
    expect(visibleTimeline.get("model.extract")).toEqual(expect.objectContaining({
      type: "model.extract",
      status: "completed",
      stateLabel: "完成",
    }))
    expect([...visibleTimeline.keys()].some((key) => key.startsWith("extract:") || key.startsWith("extract-batch:"))).toBe(false)
    expect(timeline.some((event) => event.type === "fallback")).toBe(false)
    expect(logs.some((line) => line.includes("[doc-agent] warning (rule_extraction):") && line.includes("批量失败后单 chunk 重试仍失败"))).toBe(true)
    expect(result.warningCount).toBeGreaterThan(0)
    expect(visibleTimeline.get("done")?.detail).toContain("详见 Output > ChipMate")
  })

  test("logs merge fallback details and still renders when guideline merge model fails", async () => {
    const timeline: DocAgentTimelineEvent[] = []
    const logs: string[] = []
    let rendered = false

    const result = await new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "指针规范", paragraphs: ["必须检查指针参数是否为空。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "错误处理", paragraphs: ["应该检查返回值并处理错误路径。"] }],
          }),
        },
      ],
      model: new MergeFailModelProvider(),
      onTimeline: (event) => timeline.push(event),
      log: (message) => logs.push(message),
      createDocument: async ({ spec }) => {
        rendered = true
        return {
          path: ".chipmate/docs/merge-fallback-sample.docx",
          absolutePath: "/workspace/.chipmate/docs/merge-fallback-sample.docx",
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })

    expect(rendered).toBe(true)
    const visibleTimeline = groupedTimelineEvents(timeline)
    expect(visibleTimeline.get("merge")).toEqual(expect.objectContaining({
      type: "merge",
      status: "completed",
      stateLabel: "完成",
    }))
    expect([...visibleTimeline.keys()].some((key) => key.startsWith("merge:"))).toBe(false)
    expect(logs.some((line) => line.includes("[doc-agent] warning (merge):") && line.includes("模型合并失败"))).toBe(true)
    expect(logs.some((line) => line.includes("[doc-agent] merge progress: 模型合并失败"))).toBe(true)
    expect(result.warningCount).toBeGreaterThan(0)
    expect(visibleTimeline.get("done")?.detail).toContain("详见 Output > ChipMate")
  })

  test("aborts while waiting for user conflict decisions and does not render", async () => {
    const controller = new AbortController()
    let rendered = false

    setTimeout(() => controller.abort(), 1)
    await expect(new GuidelineReferencePackFlow().run({
      question: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      files: [
        {
          path: "docs/company-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "公司内部 C 编码规范",
            sections: [{ heading: "命名规范", paragraphs: ["必须使用模块前缀命名全局函数。"] }],
          }),
        },
        {
          path: "docs/external-c-guideline.docx",
          bytes: cGuidelineDocxFixture({
            title: "外部 C 编码规范参考资料",
            sections: [{ heading: "命名规范", paragraphs: ["建议不强制使用模块前缀，以保持接口简洁。"] }],
          }),
        },
      ],
      model: new ConflictModelProvider(),
      signal: controller.signal,
      resolveConflictDecisions: async () => await new Promise(() => {}),
      createDocument: async ({ spec }) => {
        rendered = true
        return {
          path: ".chipmate/docs/should-not-exist.docx",
          absolutePath: "/workspace/.chipmate/docs/should-not-exist.docx",
          sourceCount: spec.sources.length,
          warningCount: 0,
          warnings: [],
          errors: [],
        }
      },
    })).rejects.toMatchObject({ name: "AbortError" })

    expect(rendered).toBe(false)
  })
})

class FakeModelProvider implements DocAgentModelProvider {
  async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      return {
        chunkResults: batchPromptChunks(request.prompt).map((chunk) => ({
          chunkId: chunk.chunkId,
          rules: [fakeRuleForText(String(chunk.text ?? ""), String(chunk.sourceRole ?? ""))],
        })),
      } as T
    }
    if (request.purpose === "extract-rules") {
      return {
        rules: [fakeRuleForText(request.prompt, "")],
      } as T
    }
    if (request.purpose === "merge-guidelines") {
      return {
        rules: [
          {
            ruleId: "C-001",
            name: "检查指针参数",
            priority: "必须",
            scope: "指针与内存安全",
            description: "对外部输入和可空指针参数必须先检查再使用。",
            recommended: "在函数入口检查指针并返回明确错误码。",
            discouraged: "直接解引用未验证的指针。",
            rationale: "避免空指针崩溃和未定义行为。",
            exceptions: "内部静态函数可通过调用约定证明非空，但需注释说明。",
            sources: ["docs/company-c-guideline.docx / 指针与内存安全", "docs/external-c-guideline.docx / 错误处理"],
            rolloutAdvice: "纳入 Code Review Checklist 和静态检查。",
          },
        ],
        warnings: [],
      } as T
    }
    if (request.purpose === "plan-source-block-placement") {
      const payload = placementPromptPayload(request.prompt)
      const targetRuleId = String(payload.rules?.[0]?.ruleId ?? "C-001")
      return {
        placements: (payload.blocks ?? [])
          .filter((block) => block.sourceOrigin === "internal_company" && (block.kind === "example" || block.kind === "code"))
          .map((block) => ({
            blockId: block.blockId,
            targetRuleId,
            placement: "preserved-example",
            confidence: 0.9,
            reason: "测试模型将内部示例归入首条规则。",
            label: "内部示例",
          })),
        warnings: [],
      } as T
    }
    return {} as T
  }
}

class ModelLedDraftProvider extends FakeModelProvider {
  constructor(private readonly draft: {
    composeRules: Array<Record<string, unknown> & Partial<RuleCardSpec>>
    pendingReviewRules?: Array<Record<string, unknown> & Partial<RuleCardSpec>>
    implementationGuidanceItems?: Array<Record<string, unknown>>
    riskLimitItems?: Array<Record<string, unknown>>
    referenceOnlyItems?: Array<Record<string, unknown>>
    reviewFindings?: Array<Record<string, unknown>>
    composeWarnings?: string[]
    reviewWarnings?: string[]
  }) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "compose-guideline-draft") {
      return {
        rules: this.draft.composeRules,
        pendingReviewRules: this.draft.pendingReviewRules ?? [],
        implementationGuidanceItems: this.draft.implementationGuidanceItems ?? [],
        riskLimitItems: this.draft.riskLimitItems ?? [],
        referenceOnlyItems: this.draft.referenceOnlyItems ?? [],
        warnings: this.draft.composeWarnings ?? [],
      } as T
    }
    if (request.purpose === "review-guideline-draft") {
      return {
        findings: this.draft.reviewFindings ?? [],
        warnings: this.draft.reviewWarnings ?? [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class RefAwareModelLedDraftProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "compose-guideline-draft") {
      const payload = JSON.parse(request.prompt) as {
        evidence?: {
          sourceBackedBlocks?: Array<{ id?: string; sourceBlockId?: string; sourceOrigin?: string; kind?: string }>
        }
      }
      const block = payload.evidence?.sourceBackedBlocks?.find((item) => item.sourceOrigin === "internal_company" && (item.kind === "example" || item.kind === "code"))
      return {
        rules: [{
          ...modelLedRule({ ruleId: "C-REF", name: "指针比较必须显式判断 NULL" }),
          classification: "formal-rule",
          preservedExampleRefs: [block?.id ?? block?.sourceBlockId].filter(Boolean),
          generatedExamples: [],
        }],
        pendingReviewRules: [],
        warnings: [],
      } as T
    }
    if (request.purpose === "review-guideline-draft") {
      return { findings: [], warnings: [] } as T
    }
    return await super.completeJson<T>(request)
  }
}

class WordSpecVerbatimExampleModelProvider extends ModelLedDraftProvider {
  constructor() {
    super({
      composeRules: [modelLedRule({
        ruleId: "C-WORDSPEC",
        name: "指针比较必须显式判断 NULL",
        generatedExamples: [],
      })],
    })
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "generate-word-spec") {
      return {
        sections: [{
          id: "team-rules",
          level: 1,
          title: "团队版规则正文",
          ruleCards: [{
            ...modelLedRule({
              ruleId: "C-WORDSPEC",
              name: "指针比较必须显式判断 NULL",
              generatedExamples: [modelLedExample({
                isVerbatim: true as never,
                badExample: "if (ptr) { use(ptr); }",
                goodExample: "if (ptr != NULL) { use(ptr); }",
              })],
            }),
          }],
        }],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class RuleExampleIntentModelProvider extends FakeModelProvider {
  exampleIntentCalls = 0

  constructor(private readonly mode: "valid" | "bad-first-draft" | "throw") {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-rule-examples") {
      this.exampleIntentCalls += 1
      if (this.mode === "throw") {
        throw new Error("synthetic example intent JSON failure")
      }
      const payload = exampleIntentPromptPayload(request.prompt)
      const repaired = Boolean(payload.repairInstruction)
      return {
        intents: (payload.rules ?? []).map((rule) => exampleIntentForTest(String(rule.ruleId ?? ""), String(rule.name ?? ""), this.mode === "bad-first-draft" && !repaired)),
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class SourceRoleModelProvider implements DocAgentModelProvider {
  constructor(private readonly sources: Array<Record<string, unknown>>) {}

  async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-source-roles") {
      return {
        sources: this.sources,
        warnings: [],
      } as T
    }
    return new FakeModelProvider().completeJson<T>(request)
  }
}

class DocumentPlanModelProvider extends FakeModelProvider {
  constructor(private readonly plan: Record<string, unknown>) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-document") {
      return this.plan as T
    }
    return await super.completeJson<T>(request)
  }
}

class MergeFailModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "merge-guidelines") {
      throw new Error("merge unavailable")
    }
    return await super.completeJson<T>(request)
  }
}

class EmptyRuleModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      return {
        chunkResults: batchPromptChunks(request.prompt).map((chunk) => ({
          chunkId: chunk.chunkId,
          rules: [],
        })),
      } as T
    }
    if (request.purpose === "extract-rules") {
      return { rules: [] } as T
    }
    return await super.completeJson<T>(request)
  }
}

class PartialFailingMergeModelProvider extends FakeModelProvider {
  mergeCalls = 0

  constructor(private readonly failCall: number) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "merge-guidelines") {
      this.mergeCalls += 1
      if (this.mergeCalls === this.failCall) throw new Error("batch merge unavailable")
      return {
        rules: [{
          ruleId: `C-${String(this.mergeCalls).padStart(3, "0")}`,
          name: `模型合并批次规则 ${this.mergeCalls}`,
          priority: "应该",
          scope: this.mergeCalls % 2 === 0 ? "错误处理" : "指针与内存安全",
          description: `第 ${this.mergeCalls} 批模型合并产出的规则说明。`,
          recommended: "按该批规则要求落实代码实现，并在评审中确认关键约束。",
          discouraged: "避免忽略该批规则中明确列出的风险。",
          rationale: "分批合并可以避免单批失败影响整篇文档。",
          exceptions: "确需例外时应记录评审结论。",
          sources: ["docs/company-c-guideline.docx / 指针与内存安全"],
          rolloutAdvice: "纳入团队 Code Review Checklist。",
        }],
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class EnglishRuleModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "merge-guidelines") {
      return {
        rules: [{
          ruleId: "C-001",
          name: "Use header guards",
          priority: "必须",
          scope: "Header guards",
          description: "Every header file should use include guards.",
          recommended: "Use header guards to prevent multiple inclusion.",
          discouraged: "Do not omit include guards.",
          rationale: "Header guards prevent duplicate definitions.",
          exceptions: "None.",
          sources: ["docs/external-c-guideline.docx / Header guards"],
          rolloutAdvice: "Add to Code Review Checklist.",
        }],
        warnings: [],
      } as T
    }
    if (request.purpose === "normalize-rule-language") {
      return {
        rules: [{
          ruleId: "C-001",
          name: "使用头文件保护宏",
          scope: "头文件规范",
          description: "每个头文件都应使用包含保护，避免重复包含导致重复定义。",
          recommended: "使用统一的头文件保护宏或等效机制防止重复包含。",
          discouraged: "不要省略头文件保护宏。",
          rationale: "头文件保护宏可以避免重复定义并保持依赖关系清晰。",
          exceptions: "确有编译器专用机制时，应在评审中说明原因。",
          rolloutAdvice: "纳入团队 Code Review Checklist。",
        }],
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class EnglishWordSpecModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "generate-word-spec") {
      return {
        sections: [{
          id: "team-rules",
          level: 1,
          title: "团队版规则正文",
          ruleCards: [{
            ruleId: "C-001",
            name: "Use header guards",
            priority: "必须",
            scope: "Header guards",
            description: "Every header file should use include guards.",
            recommended: "Use header guards.",
            discouraged: "Do not omit include guards.",
            rationale: "Header guards prevent duplicate definitions.",
            exceptions: "None.",
            sources: ["docs/external-c-guideline.docx / Header guards"],
          }],
        }],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class ShuffledRuleSpecModelProvider extends FakeModelProvider {
  constructor(private readonly rules: RuleCardSpec[]) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "generate-word-spec") {
      return {
        sections: [{
          id: "team-rules",
          level: 1,
          title: "团队版规则正文",
          ruleCards: this.rules,
        }],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class CommentStylePlacementModelProvider extends FakeModelProvider {
  constructor(
    private readonly confidence = 0.92,
    private readonly mergeSource = "docs/company-c-guideline.docx / 4.4.1 注释风格",
  ) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "merge-guidelines") {
      return {
        rules: [{
          ruleId: "C-COMMENT",
          name: "注释风格",
          priority: "应该",
          scope: "注释规范",
          description: "统一单行前注释、单行后注释以及注释缩进方式，保证注释能准确说明代码意图。",
          recommended: "短表达式可使用单行后注释，较长说明可使用单行前注释。",
          discouraged: "不要让注释风格混乱或与被描述代码缩进不一致。",
          rationale: "统一注释风格可以提升评审效率和维护一致性。",
          exceptions: "简单英文术语可保留英文，复杂说明建议使用中文。",
          sources: [this.mergeSource],
          rolloutAdvice: "纳入团队注释风格检查项。",
        }],
        warnings: [],
      } as T
    }
    if (request.purpose === "plan-source-block-placement") {
      const payload = placementPromptPayload(request.prompt)
      return {
        placements: (payload.blocks ?? [])
          .filter((block) => String(block.textPreview ?? "").includes("///<") || String(block.textPreview ?? "").includes("/// 电机"))
          .map((block) => ({
            blockId: block.blockId,
            targetRuleId: "C-COMMENT",
            placement: "preserved-example",
            confidence: this.confidence,
            reason: "注释片段用于说明该规则中的单行前注释和单行后注释风格。",
            label: "内部注释示例",
          })),
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class CountingSourcePlacementModelProvider extends FakeModelProvider {
  placementCalls = 0
  maxRulesPerPrompt = 0
  maxBlocksPerPrompt = 0

  constructor(private readonly targetRuleId?: string) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-source-block-placement") {
      this.placementCalls += 1
      const payload = placementPromptPayload(request.prompt)
      this.maxRulesPerPrompt = Math.max(this.maxRulesPerPrompt, payload.rules?.length ?? 0)
      this.maxBlocksPerPrompt = Math.max(this.maxBlocksPerPrompt, payload.blocks?.length ?? 0)
      const targetRuleId = this.targetRuleId ?? payload.rules?.[0]?.ruleId ?? "RULE-1"
      return {
        placements: (payload.blocks ?? []).map((block) => ({
          blockId: block.blockId,
          targetRuleId,
          placement: "preserved-example",
          confidence: 0.91,
          reason: "测试模型将来源块归位到相关规则。",
          label: "来源示例",
        })),
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class SplitRetryPlacementModelProvider extends FakeModelProvider {
  placementCalls = 0
  maxBlocksPerPrompt = 0

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-source-block-placement") {
      this.placementCalls += 1
      const payload = placementPromptPayload(request.prompt)
      const blockCount = payload.blocks?.length ?? 0
      this.maxBlocksPerPrompt = Math.max(this.maxBlocksPerPrompt, blockCount)
      if (blockCount > 2) throw new Error("Model did not return valid JSON. purpose=plan-source-block-placement; finish_reason=length; responseBytes=100; JSON.parse failed")
      return {
        placements: (payload.blocks ?? []).map((block) => ({
          blockId: block.blockId,
          targetRuleId: "RULE-1",
          placement: "preserved-example",
          confidence: 0.9,
          reason: "拆分后匹配",
          label: "来源示例",
        })),
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class StorageConsistencyCrossWireModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      return {
        chunkResults: batchPromptChunks(request.prompt).map((chunk) => ({
          chunkId: chunk.chunkId,
          rules: [storageRuleForAnchor(String(chunk.sourceRuleAnchor ?? ""), String(chunk.text ?? ""))],
        })),
      } as T
    }
    if (request.purpose === "merge-guidelines") {
      return {
        rules: [
          {
            ruleId: "C-022",
            name: "多主设备共享变量写入后需存储同步",
            priority: "必须",
            scope: "存储访问一致性",
            description: "可能失败的函数调用必须检查返回值，并沿调用链传递或处理错误，不能静默忽略失败。",
            recommended: "对共享缓冲区写入后调用内存屏障指令，再通知另一主设备读取。",
            discouraged: "禁止仅使用 volatile 而缺失硬件同步。",
            rationale: "多主设备环境下，CPU 写入可能滞留在缓存或写缓冲区，另一主设备读到旧数据将导致数据损坏或逻辑错误。",
            exceptions: "确需偏离指针与内存安全时，应记录原因、影响范围和替代风险控制措施。",
            sources: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.2"],
            sourceRole: "internal",
            sourceOrigin: "internal_company",
            sourceRuleAnchor: "规则18-1.2",
            rolloutAdvice: "在 BSP/驱动代码模板中封装统一的 sync_to_dma() / sync_from_dma() 接口。",
            generatedExamples: [{
              id: "C-022-example-1",
              title: "补充示例：根据规则生成",
              language: "c",
              exampleType: "bad-good-pair",
              exampleFormat: "code",
              badExample: "memcpy(buffer, input, count);",
              goodExample: "if (input == NULL || count > buffer_size) {\n    return -EINVAL;\n}\nmemcpy(buffer, input, count);",
              explanation: "该示例根据团队规则含义生成，用于帮助评审和落地，不是原文摘录。",
              sourceRefs: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.2"],
              generationMode: "model-generated-from-rule",
              origin: "generated",
              isVerbatim: false,
            }],
          },
          {
            ruleId: "C-023",
            name: "共享变量访问需保证原子性",
            priority: "必须",
            scope: "存储访问一致性",
            description: "对共享变量的访问，若存储设备不能保证原子性，则需要通过锁或其它机制保证存储访问一致性。",
            sources: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.3"],
            sourceRole: "internal",
            sourceOrigin: "internal_company",
            sourceRuleAnchor: "规则18-1.3",
          },
          {
            ruleId: "C-024",
            name: "多核访问 ECC 对齐",
            priority: "必须",
            scope: "存储访问一致性",
            description: "多核访问的共享区域如果使能ECC保护，共享变量的定义需要满足ECC的对齐要求。",
            sources: ["docs/company-c-guideline.docx / 4.18 存储访问一致性 > 规则18-1.4"],
            sourceRole: "internal",
            sourceOrigin: "internal_company",
            sourceRuleAnchor: "规则18-1.4",
          },
        ],
        warnings: [],
      } as T
    }
    if (request.purpose === "plan-source-block-placement") {
      return { placements: [], warnings: [] } as T
    }
    return await super.completeJson<T>(request)
  }
}

class SingleFailPlacementModelProvider extends FakeModelProvider {
  placementCalls = 0

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-source-block-placement") {
      this.placementCalls += 1
      throw new Error("Model did not return valid JSON. purpose=plan-source-block-placement; finish_reason=length; responseBytes=0; JSON.parse failed")
    }
    return await super.completeJson<T>(request)
  }
}

class InvalidPlacementModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "plan-source-block-placement") {
      const payload = placementPromptPayload(request.prompt)
      return {
        placements: [
          { blockId: payload.blocks?.[0]?.blockId, targetRuleId: "", placement: "preserved-example", confidence: 0.9, reason: "空 target" },
          { blockId: payload.blocks?.[0]?.blockId, targetRuleId: "RULE-1", placement: "unassigned", confidence: 0.9, reason: "不归位" },
        ],
        warnings: [],
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class MemoryPlacementCache implements SourceBlockPlacementCache {
  private readonly entries = new Map<string, SourceBlockPlacementCacheEntry>()

  async get(key: string) {
    return this.entries.get(key)
  }

  async set(key: string, entry: Omit<SourceBlockPlacementCacheEntry, "createdAt" | "plannerVersion">) {
    this.entries.set(key, {
      ...entry,
      createdAt: "2026-06-23T00:00:00.000Z",
      plannerVersion: SOURCE_BLOCK_PLACEMENT_VERSION,
    })
  }

  size() {
    return this.entries.size
  }
}

class ConflictModelProvider implements DocAgentModelProvider {
  async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      return {
        chunkResults: batchPromptChunks(request.prompt).map((chunk) => {
          const internal = chunk.sourceRole === "internal"
          return {
            chunkId: chunk.chunkId,
            rules: [conflictRule(internal)],
          }
        }),
      } as T
    }
    if (request.purpose === "extract-rules") {
      const internal = request.prompt.includes("sourceRole: internal")
      return {
        rules: [conflictRule(internal)],
      } as T
    }
    return {} as T
  }
}

class CountingBatchModelProvider extends FakeModelProvider {
  batchCalls = 0
  inFlight = 0
  maxInFlight = 0

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      this.batchCalls += 1
      this.inFlight += 1
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try {
        return await super.completeJson<T>(request)
      } finally {
        this.inFlight -= 1
      }
    }
    return await super.completeJson<T>(request)
  }
}

class PartialBatchModelProvider extends FakeModelProvider {
  constructor(private readonly missingChunkId: string) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      return {
        chunkResults: batchPromptChunks(request.prompt)
          .filter((chunk) => chunk.chunkId !== this.missingChunkId)
          .map((chunk) => ({
            chunkId: chunk.chunkId,
            rules: [fakeRuleForText(String(chunk.text ?? ""), String(chunk.sourceRole ?? ""))],
          })),
      } as T
    }
    return await super.completeJson<T>(request)
  }
}

class ScopeSlugModelProvider extends FakeModelProvider {
  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "merge-guidelines") {
      return {
        rules: [{
          ruleId: "C-GEN",
          name: "命名保持一致",
          priority: "应该",
          scope: "c-gen",
          description: "命名应保持一致并体现模块语义。",
          recommended: "使用清晰的模块和动作命名。",
          discouraged: "使用含糊缩写。",
          rationale: "提升代码可读性。",
          exceptions: "局部短生命周期变量可使用短名。",
          sources: ["docs/company-c-guideline.docx / 命名规范"],
          rolloutAdvice: "纳入 Code Review。",
        }],
        warnings: [],
      } as T
    }
    if (request.purpose === "generate-word-spec") {
      return {
        sections: [{
          id: "team-rules",
          level: 1,
          title: "团队版规则正文",
          ruleCards: [{
            ruleId: "C-GEN",
            name: "命名保持一致",
            priority: "应该",
            scope: "c-gen",
            description: "命名应保持一致并体现模块语义。",
            recommended: "使用清晰的模块和动作命名。",
            discouraged: "使用含糊缩写。",
            rationale: "提升代码可读性。",
            exceptions: "局部短生命周期变量可使用短名。",
            sources: ["docs/company-c-guideline.docx / 命名规范"],
          }],
        }],
      } as T
    }
    return await super.completeJson(request)
  }
}

class FailingChunkModelProvider extends FakeModelProvider {
  private calls = 0

  constructor(private readonly failAt: number) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules" || request.purpose === "extract-rules-batch") {
      this.calls += 1
      if (this.calls === this.failAt) throw new Error("synthetic model failure")
    }
    return await super.completeJson(request)
  }
}

class BatchAndSingleFailModelProvider extends FakeModelProvider {
  constructor(private readonly singleFailureMarker: string) {
    super()
  }

  override async completeJson<T>(request: DocAgentModelRequest): Promise<T> {
    if (request.purpose === "extract-rules-batch") {
      throw new Error("synthetic invalid batch json")
    }
    if (request.purpose === "extract-rules" && request.prompt.includes(this.singleFailureMarker)) {
      throw new Error("synthetic invalid single json")
    }
    return await super.completeJson(request)
  }
}

function fakeRuleForText(text: string, sourceRole: string) {
  const pointer = text.includes("指针")
  return {
    title: pointer ? "检查指针参数" : "保持命名一致",
    category: pointer ? "指针与内存安全" : "命名规范",
    priority: text.includes("必须") || sourceRole === "internal" ? "must" : "should",
    description: pointer ? "必须检查指针参数是否为空。" : "应该保持命名一致并避免含糊缩写。",
    recommended: "在接口入口处显式检查并返回错误码。",
    discouraged: "直接解引用未经验证的指针或使用含糊命名。",
    rationale: "降低缺陷率并提升可维护性。",
    exceptions: "性能关键路径例外需评审记录。",
  }
}

function conflictRule(internal: boolean) {
  return {
    title: "模块前缀命名",
    category: "命名规范",
    priority: internal ? "must" : "recommend",
    description: internal ? "必须使用模块前缀命名全局函数。" : "建议不强制使用模块前缀，以保持接口简洁。",
    recommended: internal ? "全局函数使用模块前缀。" : "根据接口语义选择简洁名称。",
    discouraged: internal ? "无模块边界的全局命名。" : "过长且重复的前缀。",
    rationale: "保持团队一致性。",
    exceptions: "例外需评审。",
  }
}

function storageRuleForAnchor(anchor: string, text: string) {
  if (anchor === "建议18-1.1") {
    return {
      title: "多核访问共享变量不建议使用 cache 方式访问",
      category: "存储访问一致性",
      priority: "recommend",
      sourceRuleAnchor: anchor,
      description: "多核访问的共享变量，不建议使用cache方式访问。",
    }
  }
  if (anchor === "规则18-1.2") {
    return {
      title: "多主设备共享变量写入后需存储同步",
      category: "存储访问一致性",
      priority: "must",
      sourceRuleAnchor: anchor,
      description: "多主设备访问的共享变量，写者传递信息给读者前，需要做存储同步，保证更新的信息实际写入到存储空间。",
      recommended: "写者传递信息给读者前调用存储同步机制，确保更新已写入存储空间。",
      discouraged: "不要在缺少存储同步的情况下通知其它主设备读取共享变量。",
      rationale: "多主设备访问同一共享变量时，缺少同步可能导致读者看到旧数据。",
    }
  }
  if (anchor === "规则18-1.3") {
    return {
      title: "共享变量访问需保证原子性",
      category: "存储访问一致性",
      priority: "must",
      sourceRuleAnchor: anchor,
      description: "对共享变量的访问，若存储设备不能保证原子性，则需要通过锁或其它机制保证存储访问一致性。",
      recommended: text.includes("g_nvme_smart_host_wlba_cnt") ? "对 u64 共享变量操作时使用锁机制保护。" : undefined,
    }
  }
  return {
    title: "多核访问 ECC 对齐",
    category: "存储访问一致性",
    priority: "must",
    sourceRuleAnchor: anchor,
    description: "多核访问的共享区域如果使能ECC保护，共享变量的定义需要满足ECC的对齐要求。",
  }
}

function candidateRule(id: string): CandidateRule {
  return {
    id,
    title: "检查指针参数",
    category: "指针与内存安全",
    priority: "must",
    description: "必须检查指针参数是否为空。",
    recommended: "在入口处检查指针并返回错误码。",
    discouraged: "直接解引用未验证的指针。",
    rationale: "避免空指针崩溃。",
    exceptions: "内部调用约定可证明非空时需注释说明。",
    sourceDocument: "docs/company-c-guideline.docx",
    sourceRole: "internal",
    sourceOrigin: "internal_company",
    sourceSection: "指针与内存安全",
    sourceLocation: { path: "docs/company-c-guideline.docx", headingPath: ["指针与内存安全"] },
  }
}

function evidencePackWithRules(rules: CandidateRule[]): EvidencePack {
  return {
    internalSummary: [],
    externalSummary: [],
    overlappingRules: [],
    conflictRules: [],
    externallyRecommendedRules: [],
    unsuitableExternalRules: [],
    candidateRules: rules,
    sourceBackedBlocks: [],
    warnings: [],
  }
}

function batchPromptChunks(prompt: string) {
  const marker = "Chunks:"
  const index = prompt.indexOf(marker)
  if (index < 0) return []
  return JSON.parse(prompt.slice(index + marker.length).trim()) as Array<{
    chunkId: string
    sourceRole?: string
    sourceRuleAnchor?: string
    text?: string
  }>
}

function placementPromptPayload(prompt: string) {
  return JSON.parse(prompt) as {
    rules?: Array<{ ruleId?: string }>
    blocks?: Array<{ blockId?: string; kind?: string; sourceOrigin?: string; textPreview?: string; title?: string }>
  }
}

function exampleIntentPromptPayload(prompt: string) {
  return JSON.parse(prompt) as {
    repairInstruction?: string
    rules?: Array<{ ruleId?: string; name?: string }>
  }
}

function sourceBlockTextForTest(block: SourceBackedBlock) {
  return [
    block.codeBlock?.code,
    block.items?.join("\n"),
    block.text,
    block.table ? [block.table.headers.join(" | "), ...plainTableRowsForTest(block.table).map((row) => row.join(" | "))].join("\n") : "",
  ].filter(Boolean).join("\n")
}

function plainTableRowsForTest(table: TableSpec) {
  return table.rows.map((row) => row.map((cell) => typeof cell === "string" ? cell : cell.text))
}

class TimeoutModelProvider implements DocAgentModelProvider {
  async completeJson<T>(): Promise<T> {
    throw new Error("Document model request timed out after 5ms (purpose=extract-rules, model=fake, stage=fetch).")
  }
}

class AbortModelProvider implements DocAgentModelProvider {
  constructor(private readonly controller: AbortController) {}

  async completeJson<T>(): Promise<T> {
    this.controller.abort()
    const error = new Error("aborted")
    error.name = "AbortError"
    throw error
  }
}

function referenceChunks(count: number): ReferenceChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `chunk-${index + 1}`,
    sourceId: "src-1",
    sourcePath: "docs/company-c-guideline.docx",
    role: "internal",
    sourceOrigin: "internal_company",
    headingPath: [`章节 ${index + 1}`],
    text: `必须检查第 ${index + 1} 个接口的指针参数并返回明确错误码。`,
    sourceLocations: [{ path: "docs/company-c-guideline.docx", headingPath: [`章节 ${index + 1}`] }],
  }))
}

function remoteSettings(): RemoteSettings {
  return {
    provider: {
      apiBaseUrl: "https://provider.example/v1",
      chatModel: "doc-model",
      maxTokens: 4096,
      temperature: 0.2,
      topP: 1,
    },
  } as RemoteSettings
}

function jsonChatResponse(content: string, finishReason = "stop") {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
  }), { status: 200, headers: { "content-type": "application/json" } })
}

function emptyEvidencePack(): EvidencePack {
  return {
    internalSummary: [],
    externalSummary: [],
    overlappingRules: [],
    conflictRules: [],
    externallyRecommendedRules: [],
    unsuitableExternalRules: [],
    candidateRules: [],
    sourceBackedBlocks: [],
    warnings: [],
  }
}

function minimalSpecWithRules(rules: RuleCardSpec[]): WordDocSpec {
  return {
    metadata: {
      title: "团队 C 语言编码规范",
      documentType: "C Coding Guideline",
      language: "zh-CN",
      generatedAt: new Date(0).toISOString(),
    },
    sources: [],
    sections: [{
      id: "rules",
      level: 1,
      title: "团队版规则正文",
      ruleCards: rules,
    }],
    references: [],
  }
}

async function minimalExamplePlan(question = "请给每条规则写一个最小示例。") {
  return await new DocumentPlanGenerator().generate({
    question,
    recipeId: "c-coding-guideline",
    documents: [],
  })
}

function sourceHeaderPairRule() {
  return {
    ruleId: "C-001",
    name: "源文件与头文件配对",
    priority: "必须" as const,
    scope: "文件结构",
    description: "通常情况下，一个 .c 文件必须有一个 .h 文件对应。只有 main.c 和测试代码等少数情况例外。",
    recommended: "为每个 .c 文件提供对应的 .h 头文件，声明公开的接口。",
    discouraged: "不要创建无对应头文件的实现文件，除非有充分理由。",
    rationale: "提高模块化，隔离接口与实现，便于依赖管理。",
    exceptions: "main.c、测试代码等可以没有头文件。",
    sources: ["IPD-R-10003355 C&C++编码规范V1.3.docx / 文件结构"],
  }
}

function nullComparisonRule(): RuleCardSpec {
  return {
    ...sourceHeaderPairRule(),
    ruleId: "C-NULL",
    name: "指针与零值比较使用显式NULL",
    scope: "指针比较表达式",
    description: "指针变量与零值比较时，应使用显式的 == NULL 或 != NULL 形式，避免依赖隐式转换使意图不清。",
    recommended: "if (ptr == NULL) { ... }\nif (ptr != NULL) { ... }",
    discouraged: "if (ptr) { ... }\nif (!ptr) { ... }",
    rationale: "显式NULL比较明确表达指针有效性检测。",
    exceptions: "无",
    sources: ["IPD-R-10003355 C&C++编码规范V1.3 / 规则9-0.12"],
  }
}

function constantLeftComparisonRule(): RuleCardSpec {
  return {
    ...sourceHeaderPairRule(),
    ruleId: "C-LEFT",
    name: "相等比较左置右值",
    scope: "比较表达式",
    description: "在相等运算符两端的比较中，若存在右值、常量或宏，应将其置于运算符左侧，防止误将比较写成赋值。",
    recommended: "if (NULL == ptr) { ... }\nif (0 == flag) { ... }",
    discouraged: "if (ptr == NULL) { ... }\nif (flag == 0) { ... }",
    rationale: "右值左置可以让误写赋值更容易在编译期暴露。",
    exceptions: "比较两端均为左值时不适用。",
    sources: ["IPD-R-10003355 C&C++编码规范V1.3 / 建议9-0.13"],
  }
}

function fileLayoutGeneratedExample(ruleId: string): GeneratedExampleSpec {
  return {
    id: `${ruleId}-bad-layout`,
    title: "补充示例：错误的文件布局示例",
    exampleFormat: "file-layout",
    exampleType: "bad-good-pair",
    badExample: "// motor.c\nint motor_init(void) { return 0; }",
    goodExample: "// motor.h\nint motor_init(void);",
    explanation: "该示例用于说明团队规则的落地方式，不是原文摘录。",
    sourceRefs: ["src-2:example:hash"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
  }
}

function memcpyGeneratedExample(ruleId: string): GeneratedExampleSpec {
  return {
    id: `${ruleId}-bad-memcpy`,
    title: "补充示例：错误的指针内存示例",
    language: "c",
    exampleFormat: "code",
    exampleType: "bad-good-pair",
    badExample: "memcpy(buffer, input, count);",
    goodExample: "if (input == NULL || count > buffer_size) {\n    return -EINVAL;\n}\nmemcpy(buffer, input, count);",
    explanation: "该示例讨论指针和缓冲区边界，不是原文摘录。",
    sourceRefs: ["src-2:pointer:hash"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
  }
}

function macroNamingGeneratedExample(ruleId: string): GeneratedExampleSpec {
  return {
    id: `${ruleId}-bad-macro`,
    title: "补充示例：错误的宏命名示例",
    language: "c",
    exampleFormat: "code",
    exampleType: "bad-good-pair",
    badExample: "#define TIMEOUT 1000\n#define FLAG 1",
    goodExample: "#define SENSOR_TIMEOUT_MS (1000U)\n\ntypedef enum {\n    SENSOR_STATE_IDLE = 0,\n    SENSOR_STATE_ACTIVE = 1,\n} sensor_state_t;",
    explanation: "该示例讨论宏、枚举和常量命名，不是原文摘录。",
    sourceRefs: ["src-2:macro:hash"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
  }
}

function volatileGeneratedExample(ruleId: string): GeneratedExampleSpec {
  return {
    id: `${ruleId}-bad-volatile`,
    title: "补充示例：错误的 volatile 示例",
    language: "c",
    exampleFormat: "code",
    exampleType: "bad-good-pair",
    badExample: "volatile uint32_t status;",
    goodExample: "volatile uint32_t status_reg;",
    explanation: "该示例讨论 volatile 和寄存器访问，不是原文摘录。",
    sourceRefs: ["src-2:volatile:hash"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
  }
}

function namingGeneratedExample(ruleId: string): GeneratedExampleSpec {
  return {
    id: `${ruleId}-bad-naming`,
    title: "补充示例：错误的命名示例",
    exampleFormat: "naming-pair",
    exampleType: "bad-good-pair",
    badExample: "int run(int a);",
    goodExample: "int sensor_start_sampling(uint32_t sample_count);",
    explanation: "该示例讨论命名对照，不是原文摘录。",
    sourceRefs: ["src-2:naming:hash"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
  }
}

function exampleIntentForTest(ruleId: string, name: string, badDraft: boolean) {
  if (name.includes("左置")) {
    return {
      ruleId,
      semanticSummary: "相等比较中的常量或右值应放在左侧。",
      exampleObjective: "示例必须体现常量左置比较，并对比右值右置或误写赋值。",
      exampleFormat: "code",
      exampleType: "bad-good-pair",
      mustInclude: ["常量左置比较"],
      mustAvoid: ["宏命名示例 SENSOR_TIMEOUT enum"],
      badExampleFocus: "右值右置或误写赋值。",
      goodExampleFocus: "NULL 或 0 放在 == 左侧。",
      confidence: 0.92,
      reason: "用户规则要求相等比较左置右值。",
      draftExample: badDraft ? macroNamingGeneratedExample(ruleId) : {
        title: "补充示例：相等比较左置右值",
        language: "c",
        exampleFormat: "code",
        exampleType: "bad-good-pair",
        badExample: "if (ptr == NULL) {\n    return -EINVAL;\n}\nif (flag = 0) {\n    reset_state();\n}",
        badExampleReason: "右值放在右侧时更容易把比较误写成赋值，导致条件表达式改变变量值。",
        goodExample: "if (NULL == ptr) {\n    return -EINVAL;\n}\nif (0 == flag) {\n    reset_state();\n}",
        explanation: "该示例体现常量或 NULL 左置的比较习惯，不是原文摘录。",
      },
    }
  }
  return {
    ruleId,
    semanticSummary: "指针与零值比较时应显式使用 NULL。",
    exampleObjective: "示例必须体现显式 NULL 比较，并对比隐式指针真假判断。",
    exampleFormat: "code",
    exampleType: "bad-good-pair",
    mustInclude: ["显式 NULL 指针比较", "隐式指针判断反例"],
    mustAvoid: ["memcpy buffer 模板"],
    badExampleFocus: "使用 if (ptr) 或 if (!ptr) 进行隐式判断。",
    goodExampleFocus: "使用 ptr == NULL 或 ptr != NULL。",
    confidence: 0.93,
    reason: "用户规则要求指针零值比较显式写出 NULL。",
    draftExample: badDraft ? memcpyGeneratedExample(ruleId) : {
      title: "补充示例：显式 NULL 指针比较",
      language: "c",
      exampleFormat: "code",
      exampleType: "bad-good-pair",
      badExample: "if (ptr) {\n    use_value(ptr);\n}\nif (!ptr) {\n    return -EINVAL;\n}",
      badExampleReason: "隐式真假判断没有直接表达这是指针有效性检查，容易让读者误解判断意图。",
      goodExample: "if (ptr != NULL) {\n    use_value(ptr);\n}\nif (ptr == NULL) {\n    return -EINVAL;\n}",
      explanation: "该示例体现显式 NULL 比较，不是原文摘录。",
    },
  }
}

function organizationRule(ruleId: string, name: string, sourceRole: RuleCardSpec["sourceRole"]): RuleCardSpec {
  return {
    ...sourceHeaderPairRule(),
    ruleId,
    name,
    sourceRole,
    sourceOrigin: sourceRole === "internal" ? "internal_company" : sourceRole === "external" ? "external_public" : "unknown",
    sourceRoleReason: "测试规则来源角色。",
    sources: [`docs/${sourceRole ?? "unknown"}-source.docx / 规则章节`],
  }
}

function placementRule(overrides: Partial<RuleCardSpec> = {}): RuleCardSpec {
  return {
    ruleId: "RULE-1",
    name: "指针参数检查",
    priority: "必须",
    scope: "指针与内存安全",
    description: "接口入口必须检查指针参数是否为空。",
    recommended: "在入口处检查指针并返回错误码。",
    discouraged: "直接解引用未经验证的指针。",
    rationale: "避免空指针崩溃。",
    exceptions: "内部调用约定可证明非空时需注释说明。",
    sources: ["docs/company-a.docx / 指针与内存安全"],
    ...overrides,
  }
}

function placementBlock(overrides: Partial<SourceBackedBlock> & { source?: Partial<SourceBackedBlock["source"]> } = {}): SourceBackedBlock {
  const source = overrides.source ?? {}
  const { source: _source, ...blockOverrides } = overrides
  const block: SourceBackedBlock = {
    id: "block-1",
    kind: "example",
    text: "示例：if (ptr == NULL) return -EINVAL;",
    source: {
      sourceId: "src-1",
      sourceName: "company-a.docx",
      sourceTitle: "公司内部规范",
      sourcePath: "docs/company-a.docx",
      sourceRole: "internal",
      sourceOrigin: "internal_company",
      headingPath: ["指针与内存安全"],
      sourceLocation: { path: "docs/company-a.docx", headingPath: ["指针与内存安全"] },
      sourceBlockId: "source-block-1",
      blockIndex: 1,
      sectionBlockIndex: 1,
      originalBlockHash: { rawHash: "raw-block-1", normalizedHash: "normalized-block-1" },
      ...source,
    },
    preserveMode: "verbatim-short",
    ...blockOverrides,
  }
  return block
}

function storageConsistencyParagraphs() {
  return [
    "4.18.1 Cache访问一致性\n【建议18-1.1】多核访问的共享变量，不建议使用cache方式访问。",
    "4.18.2 多主设备访问一致性\n【规则18-1.2】多主设备（CPU、DMAC、NFC等）访问的共享变量，写者传递信息给读者前，需要做存储同步，保证更新的信息实际写入到存储空间。\n#define GENERIC_DESC_SUBMIT(desc_ptr, sw_desc) do\\\n{\\\n    desc_cpy2spm((u32 *)((sw_desc)->seq_desc_addr), (u32 *)desc_ptr);\\\n    halCpu_InsertDataSynchronizationBarrier();\\\n    nfc_hal_seq_add_desc_cnt(1);\\\n}",
    "4.18.3 存储访问原子性\n【规则18-1.3】对共享变量的访问，若存储设备不能保证原子性，则需要通过锁或其它机制保证存储访问一致性\nSHARED_SECTION(SDTCM_RW) u64 g_nvme_smart_host_wlba_cnt = 0;\n上述示例中的变量为u64类型，CPU访问此变量需要两次存储访问，为保障此变量访问的一致性，对其进行操作时可考虑使用锁机制。",
    "4.18.4 多核访问ECC\n【规则18-1.4】多核访问的共享区域如果使能ECC保护，共享变量的定义需要满足ECC的对齐要求。\nSHARED_SECTION(SDTCM_RW) ALIGNED(4) u8 rw_perf_ftl_state = 0;",
  ]
}

async function tempDir(prefix: string) {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await rm(dir, { force: true, recursive: true })
  await mkdir(dir, { recursive: true })
  return dir
}

async function readDocxPart(bytes: Uint8Array, partPath: string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  const part = zip.file(partPath)
  if (!part) throw new Error(`Missing DOCX part: ${partPath}`)
  return await part.async("string")
}

function readNoteItemXml(xml: string, kind: "footnote" | "endnote", id: string) {
  const match = xml.match(new RegExp(`<w:${kind}\\b[^>]*\\bw:id="${id}"[\\s\\S]*?<\\/w:${kind}>`))
  if (!match) throw new Error(`Missing ${kind} ${id}`)
  return match[0]
}

async function readDocxBinaryPart(bytes: Uint8Array, partPath: string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  const part = zip.file(partPath)
  if (!part) throw new Error(`Missing DOCX part: ${partPath}`)
  return await part.async("uint8array")
}

async function docxPartPaths(bytes: Uint8Array) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  return Object.entries(zip.files)
    .filter(([, entry]) => !entry.dir)
    .map(([path]) => path)
    .sort()
}

async function replaceDocxPart(bytes: Uint8Array, partPath: string, replace: (xml: string) => string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  const part = zip.file(partPath)
  if (!part) throw new Error(`Missing DOCX part: ${partPath}`)
  zip.file(partPath, replace(await part.async("string")))
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

async function writeDocxPart(bytes: Uint8Array, partPath: string, content: string | Uint8Array) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  zip.file(partPath, content)
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

function headerContrastRatioForTest(left: string, right: string) {
  const leftLuminance = testRelativeLuminance(left)
  const rightLuminance = testRelativeLuminance(right)
  const lighter = Math.max(leftLuminance, rightLuminance)
  const darker = Math.min(leftLuminance, rightLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function testRelativeLuminance(hex: string) {
  const normalized = hex.trim().replace(/^#/, "")
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return 0.2126 * testLinearRgb(red) + 0.7152 * testLinearRgb(green) + 0.0722 * testLinearRgb(blue)
}

function testLinearRgb(component: number) {
  const channel = component / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function replaceFirstSdtByTag(xml: string, tag: string, replace: (sdtXml: string) => string) {
  let replaced = false
  return xml.replace(/<w:sdt\b[\s\S]*?<\/w:sdt>/g, (sdtXml) => {
    if (replaced || !sdtXml.includes(`<w:tag w:val="${tag}"`)) return sdtXml
    replaced = true
    return replace(sdtXml)
  })
}

function splitSdtTextRuns(sdtXml: string, originalText: string, parts: [string, string]) {
  return sdtXml.replace(
    new RegExp(`<w:t\\\\b([^>]*)>${escapeRegExp(originalText)}<\\/w:t>`),
    `<w:t$1>${parts[0]}</w:t></w:r><w:r><w:t$1>${parts[1]}</w:t>`,
  )
}

function richContentControlFixtureXml() {
  return [
    "<w:sdt>",
    "<w:sdtPr><w:alias w:val=\"Rich field\"/><w:tag w:val=\"RICH\"/><w:id w:val=\"9101\"/><w:richText/></w:sdtPr>",
    "<w:sdtContent>",
    "<w:p><w:r><w:t>Rich </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>body</w:t></w:r></w:p>",
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function nestedContentControlFixtureXml() {
  return [
    "<w:sdt>",
    "<w:sdtPr><w:alias w:val=\"Outer field\"/><w:tag w:val=\"OUTER\"/><w:id w:val=\"9201\"/></w:sdtPr>",
    "<w:sdtContent>",
    "<w:p><w:r><w:t>Outer before</w:t></w:r></w:p>",
    "<w:sdt>",
    "<w:sdtPr><w:alias w:val=\"Inner field\"/><w:tag w:val=\"INNER\"/><w:id w:val=\"9202\"/><w:text/></w:sdtPr>",
    "<w:sdtContent><w:p><w:r><w:t>Inner text</w:t></w:r></w:p></w:sdtContent>",
    "</w:sdt>",
    "<w:p><w:r><w:t>Outer after</w:t></w:r></w:p>",
    "</w:sdtContent>",
    "</w:sdt>",
  ].join("")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function addCommentMetadataParts(bytes: Uint8Array, comments: Array<{ commentId: string; paraId: string; parentParaId?: string; durableId?: string; done?: boolean }>) {
  let nextBytes = await replaceDocxPart(bytes, "word/comments.xml", (xml) => {
    let nextXml = xml
    if (!nextXml.includes("xmlns:w14=")) nextXml = nextXml.replace("<w:comments ", '<w:comments xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ')
    if (!nextXml.includes("xmlns:w15=")) nextXml = nextXml.replace("<w:comments ", '<w:comments xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ')
    return nextXml.replace(/<w:comment\b[\s\S]*?<\/w:comment>/g, (commentXml) => {
      const id = commentXml.match(/\bw:id="([^"]+)"/)?.[1]
      const item = comments.find((comment) => comment.commentId === id)
      if (!item) return commentXml
      return commentXml.replace(/<w:p\b(?![^>]*\b(?:[A-Za-z0-9_-]+:)?paraId=)/, `<w:p w14:paraId="${item.paraId}"`)
    })
  })
  nextBytes = await writeDocxPart(nextBytes, "word/commentsExtended.xml", commentsExtendedFixtureXml(comments))
  nextBytes = await writeDocxPart(nextBytes, "word/commentsIds.xml", commentsIdsFixtureXml(comments))
  nextBytes = await replaceDocxPart(nextBytes, "[Content_Types].xml", (xml) => addCommentMetadataContentTypes(xml))
  nextBytes = await replaceDocxPart(nextBytes, "word/_rels/document.xml.rels", (xml) => addCommentMetadataRelationships(xml))
  return nextBytes
}

function commentsExtendedFixtureXml(comments: Array<{ paraId: string; parentParaId?: string; done?: boolean }>) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">',
    ...comments.map((comment) => [
      `<w15:commentEx w15:paraId="${comment.paraId}"`,
      comment.parentParaId ? ` w15:paraIdParent="${comment.parentParaId}"` : "",
      comment.done ? ' w15:done="1"' : "",
      "/>",
    ].join("")),
    "</w15:commentsEx>",
  ].join("")
}

function commentsIdsFixtureXml(comments: Array<{ paraId: string; durableId?: string }>) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">',
    ...comments.map((comment) => `<w16cid:commentId w16cid:paraId="${comment.paraId}" w16cid:durableId="${comment.durableId ?? `durable-${comment.paraId}`}"/>`),
    "</w16cid:commentsIds>",
  ].join("")
}

function addCommentMetadataContentTypes(xml: string) {
  let next = xml
  if (!next.includes('PartName="/word/commentsExtended.xml"')) next = next.replace("</Types>", '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.ms-word.commentsExtended+xml"/></Types>')
  if (!next.includes('PartName="/word/commentsIds.xml"')) next = next.replace("</Types>", '<Override PartName="/word/commentsIds.xml" ContentType="application/vnd.ms-word.commentsIds+xml"/></Types>')
  return next
}

function addCommentMetadataRelationships(xml: string) {
  let next = xml
  if (!next.includes('Target="commentsExtended.xml"')) next = next.replace("</Relationships>", '<Relationship Id="rIdChipMateCommentsExtendedFixture" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>')
  if (!next.includes('Target="commentsIds.xml"')) next = next.replace("</Relationships>", '<Relationship Id="rIdChipMateCommentsIdsFixture" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/></Relationships>')
  return next
}

function watermarkHeaderFixtureXml(text?: string) {
  return watermarkStoryFixtureXml("hdr", text)
}

function watermarkFooterFixtureXml(text?: string) {
  return watermarkStoryFixtureXml("ftr", text)
}

async function ensurePngDefaultContentTypeFixture(bytes: Uint8Array) {
  const contentTypesXml = await readDocxPart(bytes, "[Content_Types].xml")
  if (contentTypesXml.includes('Extension="png"')) return bytes
  return writeDocxPart(bytes, "[Content_Types].xml", contentTypesXml.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'))
}

function backgroundImageRelsFixtureXml(relId: string, target: string) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`,
    "</Relationships>",
  ].join("")
}

function drawingBackgroundHeaderFixtureXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<w:p><w:r><w:drawing>',
    '<wp:anchor behindDoc="1" simplePos="0" relativeHeight="0">',
    '<wp:extent cx="914400" cy="914400"/>',
    '<wp:docPr id="81" name="Background image" descr="Header background image"/>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="82" name="background.png"/><pic:cNvPicPr/></pic:nvPicPr>',
    '<pic:blipFill><a:blip r:embed="rIdDrawingBg"/></pic:blipFill>',
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr>',
    '</pic:pic>',
    '</a:graphicData></a:graphic>',
    '</wp:anchor>',
    '</w:drawing></w:r></w:p>',
    '</w:hdr>',
  ].join("")
}

function vmlImageBackgroundFooterFixtureXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<w:p><w:r><w:pict>',
    '<v:shape id="vml-background" style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:468pt;z-index:-251654144">',
    '<v:imagedata r:id="rIdVmlBg" o:title="vml background"/>',
    '</v:shape>',
    '</w:pict></w:r></w:p>',
    '</w:ftr>',
  ].join("")
}

function watermarkStoryFixtureXml(root: "hdr" | "ftr", text?: string) {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    text
      ? `<w:p><w:r><w:pict><v:shape id="fixture-watermark" o:spid="_x0000_s1026" type="#_x0000_t136"><v:textpath string="${text}"/></v:shape></w:pict></w:r></w:p>`
      : "<w:p><w:r><w:t>Fixture story part</w:t></w:r></w:p>",
    `</w:${root}>`,
  ].join("")
}

function appearsBefore(text: string, earlier: string, later: string) {
  const earlierIndex = text.indexOf(earlier)
  const laterIndex = text.indexOf(later)
  return earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex
}

function tinyPngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x04, 0x00,
    0x09, 0xfb, 0x03, 0xfd, 0xa7, 0x98, 0x9d, 0xa6,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ])
}

function pngBytesWithHeaderDimensions(width: number, height: number) {
  const bytes = Buffer.from(tinyPngBytes())
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return Uint8Array.from(bytes)
}

function pngHeaderDimensions(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes)
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function alternateTinyPngBytes() {
  return Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"))
}

async function installFakeWordRenderTools(_root: string, options?: { remote?: "ok" | "fail" | "invalid-json" }) {
  const pngByDocHash = new Map<string, Buffer>()
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/render/word") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: false, issues: [{ severity: "error", code: "not-found", message: "not found" }] }))
      return
    }
    if (options?.remote === "fail") {
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: false, issues: [{ severity: "error", code: "remote-fixture-failed", message: "fixture failure" }] }))
      return
    }
    if (options?.remote === "invalid-json") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{not valid json")
      return
    }
    const body = await readRequestBody(request)
    const payload = JSON.parse(body) as { docxBase64?: string }
    const docxBytes = Buffer.from(payload.docxBase64 ?? "", "base64")
    const hash = createHash("sha256").update(docxBytes).digest()
    const hashKey = hash.toString("hex")
    if (!pngByDocHash.has(hashKey)) {
      pngByDocHash.set(hashKey, Buffer.from(pngByDocHash.size % 2 === 0 ? tinyPngBytes() : alternateTinyPngBytes()))
    }
    const png = pngByDocHash.get(hashKey)!
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      ok: true,
      pageCount: 1,
      pdf: { contentType: "application/pdf", base64: Buffer.from("%PDF-1.4\n% ChipMate fixture\n").toString("base64") },
      pages: [{
        page: 1,
        contentType: "image/png",
        base64: png.toString("base64"),
        width: 1,
        height: 1,
        visualSummary: fakeRemoteVisualSummary(),
      }],
      issues: [],
      renderer: { kind: "remote-opencode", docxToPdf: "libreoffice", pdfToPng: "pdftoppm", sofficePath: "fixture-soffice", pdftoppmPath: "fixture-pdftoppm" },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const previousEndpoint = process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
  process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = `http://127.0.0.1:${address.port}`
  return () => {
    server.close()
    if (previousEndpoint === undefined) delete process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT
    else process.env.CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT = previousEndpoint
  }
}

function fakeRemoteVisualSummary() {
  return {
    page: 1,
    width: 32,
    height: 32,
    totalPixels: 1024,
    inkPixels: 1024,
    inkRatio: 1,
    contentBounds: { left: 0, top: 0, right: 31, bottom: 31, width: 32, height: 32 },
    edgeInk: { top: true, right: true, bottom: true, left: true },
    visualRegions: ["top", "middle", "bottom"].flatMap((row, rowIndex) => ["left", "center", "right"].map((column, columnIndex) => ({
      id: `${row}-${column}`,
      row,
      column,
      bounds: {
        left: columnIndex * 10,
        top: rowIndex * 10,
        right: columnIndex === 2 ? 31 : columnIndex * 10 + 9,
        bottom: rowIndex === 2 ? 31 : rowIndex * 10 + 9,
        width: columnIndex === 2 ? 12 : 10,
        height: rowIndex === 2 ? 12 : 10,
      },
      inkPixels: 16,
      inkRatio: 0.16,
    }))),
    inkComponents: [{
      id: "ink-component-1",
      bounds: { left: 0, top: 0, right: 31, bottom: 31, width: 32, height: 32 },
      inkPixels: 1024,
      tileCount: 1,
      inkRatio: 1,
      pageArea: "middle-center",
      edgeTouching: { top: true, right: true, bottom: true, left: true },
      riskFlags: ["near-page-edge"],
    }],
  }
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function styleDriftDocxFixture() {
  const bytes = await new WordDocBuilder().build(minimalRenderableWordDocSpec())
  return await replaceDocxPart(bytes, "word/document.xml", (xml) => xml.replace("<w:body>", [
    "<w:body>",
    "<w:p>",
    '<w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="480"/><w:ind w:left="720"/></w:pPr>',
    '<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:b/><w:i/><w:color w:val="FF0000"/><w:sz w:val="32"/></w:rPr>',
    '<w:t xml:space="preserve">Manual Formatting Heading</w:t>',
    "</w:r>",
    "</w:p>",
  ].join("")))
}

function minimalRenderableWordDocSpec(): WordDocSpec {
  return {
    metadata: {
      title: "团队 C 语言编码规范",
      subtitle: "Word 2016 兼容性回归样本",
      documentType: "c-coding-guideline",
      language: "zh-CN",
      generatedAt: "2026-06-24T00:00:00.000Z",
      author: "ChipMate Document Agent",
    },
    sources: [{
      id: "src-1",
      title: "公司内部 C 编码规范",
      path: "docs/company-c-guideline.docx",
      role: "internal",
      origin: "internal_company",
    }],
    cover: {
      title: "团队 C 语言编码规范",
      subtitle: "Word 2016 兼容性回归样本",
      preparedFor: "Firmware Team",
      preparedBy: "ChipMate Document Agent",
    },
    revisionHistory: [{
      version: "0.1",
      date: "2026-06-24",
      author: "ChipMate",
      summary: "用于验证 DOCX 结构兼容性。",
    }],
    executiveSummary: {
      paragraphs: ["本样本文档用于验证编码规范生成链路输出的 DOCX 包结构、关系和 WordprocessingML 元素顺序。"],
      highlights: ["包结构完整", "关系目标可解析", "段落、表格和样式属性顺序稳定"],
    },
    sections: [{
      id: "team-rules",
      level: 1,
      title: "团队版规则正文",
      paragraphs: ["所有团队规则都应包含清晰的适用范围、来源依据和落地建议。"],
      tables: [{
        headers: ["规则编号", "规则名称", "强制级别", "适用范围"],
        rows: [["C-001", "指针参数检查", "must", "公共接口和驱动入口函数"]],
      }],
    }],
    references: [{
      sourceId: "src-1",
      title: "公司内部 C 编码规范",
      path: "docs/company-c-guideline.docx",
      note: "作为团队规则来源。",
    }],
    qualityChecklist: {
      assumptions: ["输入文档已经通过 read_docx 完成语义读取。"],
      limitations: ["该样本只验证结构兼容性，不替代 Word 2016 真机打开验收。"],
      missingInputs: [],
      risks: ["若 Word 2016 仍提示修复，需要使用实际生成文件继续定位具体 OOXML part。"],
    },
  }
}

function generatedResult(spec: WordDocSpec) {
  return {
    path: ".chipmate/docs/example-sample.docx",
    absolutePath: "/workspace/.chipmate/docs/example-sample.docx",
    sourceCount: spec.sources.length,
    warningCount: 0,
    warnings: [],
    errors: [],
  }
}

function modelLedSourceFiles() {
  return [
    {
      path: "docs/company-c-guideline.docx",
      mentionIndex: 0,
      bytes: cGuidelineDocxFixture({
        title: "公司内部 C 编码规范",
        sections: [{
          heading: "指针与表达式规范",
          paragraphs: [
            "必须让指针比较、数组访问、成员访问和指针生命周期保持清晰可审查。",
            "推荐将外部参考规范中的规则改写为团队可执行规则后再纳入。",
          ],
        }],
      }),
    },
    {
      path: "docs/external-c-guideline.docx",
      mentionIndex: 1,
      bytes: cGuidelineDocxFixture({
        title: "外部 C 编码规范参考资料",
        sections: [{
          heading: "通用 C 规则",
          paragraphs: [
            "规则应具体、可执行、可追溯。",
            "示例应贴合当前规则，不应使用无关模板。",
          ],
        }],
      }),
    },
  ]
}

function modelLedSourceFilesWithInternalExample() {
  return [
    {
      path: "docs/company-c-guideline.docx",
      mentionIndex: 0,
      bytes: cGuidelineDocxFixture({
        title: "公司内部 C 编码规范",
        sections: [{
          heading: "指针与表达式规范",
          paragraphs: [
            "必须使用显式 NULL 判断指针变量是否有效。",
            "示例：if (ptr == NULL) {\n    return -EINVAL;\n}\nuse(ptr);",
          ],
        }],
      }),
    },
    {
      path: "docs/external-c-guideline.docx",
      mentionIndex: 1,
      bytes: cGuidelineDocxFixture({
        title: "外部 C 编码规范参考资料",
        sections: [{
          heading: "通用 C 规则",
          paragraphs: ["外部规则示例应改写为团队化补充示例，不复制原文。"],
        }],
      }),
    },
  ]
}

function modelLedRule(overrides: Partial<RuleCardSpec> = {}): RuleCardSpec {
  return {
    ruleId: "C-001",
    name: "指针比较必须显式判断 NULL",
    priority: "必须",
    scope: "指针有效性检查",
    description: "指针变量与零值比较时，应使用显式 NULL 判断表达指针有效性。",
    recommended: "使用 ptr == NULL 或 ptr != NULL 进行判断。",
    discouraged: "不要使用 if (ptr) 或 if (!ptr) 隐式表达指针有效性。",
    rationale: "显式 NULL 判断可以减少误读和跨平台风险。",
    exceptions: "确有历史接口约束时，应在代码评审中说明原因。",
    sources: ["docs/company-c-guideline.docx / 指针与表达式规范"],
    sourceRole: "internal",
    sourceOrigin: "internal_company",
    rolloutAdvice: "纳入团队 Code Review Checklist。",
    ...overrides,
  }
}

function modelLedExample(overrides: Partial<GeneratedExampleSpec> = {}): GeneratedExampleSpec {
  return {
    id: "model-led-example",
    title: "补充示例：根据规则生成",
    language: "c",
    exampleFormat: "code",
    exampleType: "bad-good-pair",
    badExample: "if (ptr) {\n    use(ptr);\n}",
    badExampleReason: "隐式判断没有明确表达是否在检查空指针，评审时容易误读。",
    goodExample: "if (ptr != NULL) {\n    use(ptr);\n}",
    explanation: "该示例根据团队规则语义生成，用于帮助评审和落地，不是原文摘录。",
    sourceRefs: ["docs/company-c-guideline.docx / 指针与表达式规范"],
    generationMode: "model-generated-from-rule",
    origin: "generated",
    isVerbatim: false,
    ...overrides,
  }
}
