import { beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cGuidelineDocxFixture } from "./document-fixtures"
import type { GuidelineMergeProgress } from "../src/docAgent/GuidelineMerger"
import type { SourceBlockPlacementCache, SourceBlockPlacementCacheEntry } from "../src/docAgent/SourceBlockPlacementCache"
import type { CandidateRule, DocAgentModelProvider, DocAgentModelRequest, DocAgentTimelineEvent, EvidencePack, GeneratedExampleSpec, ReferenceChunk, RuleCardSpec, SourceBackedBlock, WordDocSpec } from "../src/docAgent/types"
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

const { DocxIntentDetector } = await import("../src/docAgent/DocxIntentDetector")
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
const { ReportQualityGate } = await import("../src/docAgent/ReportQualityGate")
const { ChipMateDocModelProvider, DOCUMENT_MODEL_COMPAT_MAX_TOKENS } = await import("../src/docAgent/ChipMateDocModelProvider")
const { RuleChunkFilter } = await import("../src/docAgent/RuleChunkFilter")
const { WorkspaceRuleExtractionCache } = await import("../src/docAgent/RuleExtractionCache")
const { SourceBlockPlacementPlanner } = await import("../src/docAgent/SourceBlockPlacementPlanner")
const { SOURCE_BLOCK_PLACEMENT_VERSION } = await import("../src/docAgent/SourceBlockPlacementCache")
const { createWordDocument } = await import("../src/tools/createWordDocumentTool")

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
  test("matches local Word guideline generation and blocks insufficient docx inputs", () => {
    const detector = new DocxIntentDetector()

    const result = detector.detect({
      text: "请综合这些资料，生成一份适合我们团队的 C 语言编码规范 Word。",
      docxCount: 1,
    })

    expect(result.matched).toBe(true)
    expect(result.reason).toContain("至少 @ 两份 .docx")
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
    block.table ? [block.table.headers.join(" | "), ...block.table.rows.map((row) => row.join(" | "))].join("\n") : "",
  ].filter(Boolean).join("\n")
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

function appearsBefore(text: string, earlier: string, later: string) {
  const earlierIndex = text.indexOf(earlier)
  const laterIndex = text.indexOf(later)
  return earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex
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
