import * as path from "node:path"
import * as vscode from "vscode"
import type { AnalysisToolResult, FunctionSummary, ModuleSummary, QueryEvidenceResult, StateMachine } from "../analysis-types"
import { moduleKey } from "../codegraph-index"
import type { CodeGraphContextProvider } from "../codegraph-types"
import { createWordDocument } from "../tools/createWordDocumentTool"
import type { DocAgentModelProvider, DocAgentTimelineEvent, DocumentSection, FigureSpec, GeneratedDocumentResult, SourceRef, WordDocSpec } from "../docAgent/types"
import { renderMermaidToPng, type MermaidPngRenderResult } from "../mermaid-png-renderer"

export type DesignDocTargetKind = "file" | "folder" | "selection"

export type DesignDocTarget = {
  path: string
  kind: DesignDocTargetKind
  startLine?: number
  endLine?: number
}

export type DesignDocTargetCandidate = {
  path: string
  kind: DesignDocTargetKind
  confidence: number
  score: number
  reasons: string[]
  evidenceFiles: string[]
}

export type DesignDocTargetResolution = {
  source: "explicit" | "model-inferred" | "deterministic-inferred"
  confidence: number
  targets: DesignDocTarget[]
  candidates: DesignDocTargetCandidate[]
  explanation?: string
  warnings: string[]
}

export type DesignDocMermaidArtifact = {
  kind: "mermaid"
  id: string
  title: string
  type: "architecture" | "business-flow" | "code-flow" | "state-machine"
  source: string
  path?: string
  png?: {
    bytes: Uint8Array
    width: number
    height: number
    path?: string
  }
  warnings?: string[]
}

export type DesignDocDiagramArtifact = DesignDocMermaidArtifact

export type DesignDocRunSummary = {
  runId: string
  title: string
  targetLabel: string
  targets: DesignDocTarget[]
  targetResolution?: DesignDocTargetResolution
  diagrams: Array<Pick<DesignDocDiagramArtifact, "id" | "kind" | "title" | "type" | "path"> & { pngPath?: string }>
  evidence: Array<{
    file: string
    lines: string
    parserKind: string
  }>
  gaps: string[]
  warnings: string[]
}

export type DesignDocGeneratedResult = GeneratedDocumentResult & {
  diagrams: DesignDocDiagramArtifact[]
  runSummary?: DesignDocRunSummary
}

type DesignDocTargetValidation =
  | { ok: true; targets: DesignDocTarget[] }
  | { ok: false; reason: string; targets: DesignDocTarget[] }

type DesignDocAgentInput = {
  question: string
  targets?: DesignDocTarget[]
  codeGraph?: Pick<CodeGraphContextProvider, "runAnalysisTool" | "queryEvidence" | "status">
  model?: DocAgentModelProvider
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; message: string; current: number; total: number }) => void
  onTimeline?: (event: DocAgentTimelineEvent) => void
  log?: (message: string) => void
  createDocument?: typeof createWordDocument
  renderMermaid?: (input: { id: string; title: string; type: DesignDocDiagramArtifact["type"]; source: string }) => Promise<MermaidPngRenderResult>
}

const DESIGN_DOC_STAGE_TOTAL = 8
const MAX_DESIGN_DOC_FUNCTIONS = 24
const MAX_DESIGN_DOC_FILES = 24
const MAX_DIAGRAM_NODES = 14
const MAX_STATE_TRANSITIONS = 32
const MAX_TARGET_CANDIDATES = 12
const MAX_INFERRED_TARGETS = 3
const MIN_INFERRED_TARGET_CONFIDENCE = 0.35

export function isDesignDocIntent(text: string) {
  const input = text.trim()
  if (!input) return false
  const asksForDetailedDesign = /详细设计文档|详细设计书|模块设计文档|设计说明书|设计文档/i.test(input)
    || /(芯片级|模块级).*(设计|文档)|生成.*(详细设计|设计文档)|输出.*(详细设计|设计文档)/i.test(input)
  if (!asksForDetailedDesign) return false
  return /@|当前(插件|模块|文件|选区)|仓库|代码|源码|子模块|模块|芯片级|模块级|状态机|函数|接口|调用|类|文件|目录|实现|机制|流水线|pipeline|flow|agent|tool/i.test(input)
}

export function validateDesignDocTargets(targets: DesignDocTarget[]): DesignDocTargetValidation {
  const normalized = normalizeTargets(targets)
  if (normalized.length === 0) {
    return {
      ok: false,
      reason: "未提供显式目标范围；调用方应先运行详细设计目标自动定位，或让用户用 @ 指定仓库内子模块目录、文件或入口符号。",
      targets: normalized,
    }
  }
  if (normalized.some((target) => target.path === "." || target.path === "")) {
    return {
      ok: false,
      reason: "请把范围收窄到仓库内的子模块目录、文件或入口符号；不建议直接对整个仓库生成详细设计文档。",
      targets: normalized,
    }
  }
  return { ok: true, targets: normalized }
}

export class DesignDocAgentFlow {
  async run(input: DesignDocAgentInput): Promise<DesignDocGeneratedResult> {
    if (!input.codeGraph) throw new Error("CodeGraph 未启用或尚不可用，无法生成基于整仓代码理解的模块详细设计文档。")

    const emit = timelineEmitter(input)
    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "target-resolution", message: "正在根据用户描述定位详细设计目标模块。", current: 1, total: DESIGN_DOC_STAGE_TOTAL })
    const targetResolution = await resolveDesignDocTargets({
      question: input.question,
      targets: input.targets ?? [],
      codeGraph: input.codeGraph,
      model: input.model,
      signal: input.signal,
      log: input.log,
    })
    const targets = targetResolution.targets
    const targetLabel = targetLabelText(targets)
    const title = `${targetLabel} 模块芯片级详细设计`
    const runId = designDocRunId(targetLabel)

    input.log?.(`[design-doc] start run=${runId} target=${targetLabel} source=${targetResolution.source} confidence=${targetResolution.confidence}`)
    emit("plan", "确定详细设计目标范围", `${targetLabel} · ${targetResolution.source} · ${Math.round(targetResolution.confidence * 100)}%`, "completed", 1)

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "module-map", message: "正在读取模块边界和符号摘要。", current: 2, total: DESIGN_DOC_STAGE_TOTAL })
    const moduleMap = await input.codeGraph.runAnalysisTool({ tool: "getModuleMap", args: { query: targetLabel } })
    const scopedModules = scopedModuleSummaries(moduleMap, targets)
    emit("evidence", "收集模块边界证据", `${scopedModules.length || "未命中"} 个模块摘要`, moduleMap.ok ? "completed" : "warning", 2)

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "evidence", message: "正在检索主流程、子流程、代码流程和接口证据。", current: 3, total: DESIGN_DOC_STAGE_TOTAL })
    const evidenceQuestion = [
      `为 ${targetLabel} 生成芯片级模块详细设计文档。`,
      "需要覆盖现有方案、模块职责、每个功能、主业务流程、子业务流程、代码流程、状态机切换流程、切换条件、错误路径、接口、数据结构和风险。",
      input.question,
    ].join("\n")
    const evidence = await input.codeGraph.queryEvidence(evidenceQuestion, {
      relatedPaths: targets.map((target) => target.path),
      maxEvidenceItems: 80,
      maxEvidenceBytes: 120000,
      retrievalMode: "hybrid",
    })
    emit("evidence", "整理代码证据包", `${evidence?.evidencePack.evidence.length ?? 0} 条证据`, evidence ? "completed" : "warning", 3)

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "state-machines", message: "正在提取状态机、迁移条件和动作。", current: 4, total: DESIGN_DOC_STAGE_TOTAL })
    let stateMachines = await input.codeGraph.runAnalysisTool({ tool: "getStateMachines", args: { query: targetLabel } })
    let machines = scopedStateMachines(stateMachinesFromTool(stateMachines), targets)
    if (!machines.length) {
      stateMachines = await input.codeGraph.runAnalysisTool({ tool: "getStateMachines", args: {} })
      machines = scopedStateMachines(stateMachinesFromTool(stateMachines), targets)
    }
    emit("evidence", "提取状态机证据", `${machines.length} 个状态机候选`, machines.length ? "completed" : "warning", 4)

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "diagrams", message: "正在生成架构、业务流程、代码流程和状态机图。", current: 5, total: DESIGN_DOC_STAGE_TOTAL })
    const diagrams = await this.buildDiagrams({
      title,
      targetLabel,
      modules: scopedModules,
      evidence,
      machines,
      log: input.log,
    })
    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "diagram-render", message: "正在将 Mermaid 图表渲染为 Word 可嵌入的 PNG。", current: 6, total: DESIGN_DOC_STAGE_TOTAL })
    const renderedDiagrams = await renderDesignDocDiagramPngs(diagrams, input.renderMermaid, input.log)
    emit("word_spec", "生成 Mermaid 图源与 PNG 图表", `${renderedDiagrams.length} 张图`, renderedDiagrams.length ? "completed" : "warning", 6)

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "word-spec", message: "正在落盘图表 artifact 并组装正式 Word 详细设计文档。", current: 7, total: DESIGN_DOC_STAGE_TOTAL })
    const artifacts = await writeDesignDocArtifacts({
      runId,
      title,
      targetLabel,
      targets,
      targetResolution,
      diagrams: renderedDiagrams,
      evidence,
      moduleMap,
      stateMachines,
    })
    const spec = designDocWordSpec({
      title,
      targetLabel,
      targets,
      targetResolution,
      modules: scopedModules,
      evidence,
      stateMachines: machines,
      diagrams: artifacts.diagrams.length ? artifacts.diagrams : renderedDiagrams,
    })

    input.signal?.throwIfAborted()
    input.onProgress?.({ stage: "rendering", message: "正在写入 Word 文档并运行渲染质量门禁。", current: 8, total: DESIGN_DOC_STAGE_TOTAL })
    const created = await (input.createDocument ?? createWordDocument)({
      filename: `${sanitizeFilenameBase(targetLabel)}-detailed-design`,
      spec,
    })
    emit("create_word_document", "写入 Word 详细设计文档", created.path, "completed", 8, created.path)
    emit("done", "模块详细设计文档生成完成", artifacts.summaryPath ?? created.path, "completed", 8, artifacts.summaryPath ?? created.path)

    return {
      ...created,
      title,
      runSummaryPath: artifacts.summaryPath ?? created.runSummaryPath,
      warnings: [...created.warnings, ...artifacts.warnings],
      warningCount: created.warningCount + artifacts.warnings.length,
      diagrams: artifacts.diagrams.length ? artifacts.diagrams : renderedDiagrams,
      runSummary: artifacts.summary,
    }
  }

  private async buildDiagrams(input: {
    title: string
    targetLabel: string
    modules: ModuleSummary[]
    evidence?: QueryEvidenceResult
    machines: StateMachine[]
    log?: (message: string) => void
  }) {
    const diagrams: DesignDocDiagramArtifact[] = []
    for (const artifact of designDocMermaidArtifacts(input)) {
      try {
        if (!artifact.source.trim()) throw new Error("empty Mermaid source")
        diagrams.push(artifact)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        input.log?.(`[design-doc] mermaid diagram failed id=${artifact.id}: ${message}`)
      }
    }
    return diagrams
  }
}

type MutableDesignDocTargetCandidate = {
  path: string
  kind: DesignDocTargetKind
  score: number
  reasons: Set<string>
  evidenceFiles: Set<string>
}

type DesignDocTargetModelOutput = {
  selectedTargets?: Array<{
    path?: string
    kind?: string
    reason?: string
  }>
  confidence?: number
  explanation?: string
  warnings?: string[]
}

async function resolveDesignDocTargets(input: {
  question: string
  targets: DesignDocTarget[]
  codeGraph: Pick<CodeGraphContextProvider, "runAnalysisTool" | "queryEvidence" | "status">
  model?: DocAgentModelProvider
  signal?: AbortSignal
  log?: (message: string) => void
}): Promise<DesignDocTargetResolution> {
  const normalized = normalizeTargets(input.targets)
  if (normalized.length > 0) {
    const validation = validateDesignDocTargets(normalized)
    if (!validation.ok) throw new Error(validation.reason)
    return {
      source: "explicit",
      confidence: 1,
      targets: validation.targets,
      candidates: validation.targets.map((target) => ({
        path: target.path,
        kind: target.kind,
        confidence: 1,
        score: 1,
        reasons: ["用户显式提供的范围"],
        evidenceFiles: [target.path],
      })),
      explanation: "用户通过 @、当前文件或选区明确限定了详细设计范围。",
      warnings: [],
    }
  }

  input.signal?.throwIfAborted()
  const discoveryQuestion = [
    "为模块级详细设计文档定位仓库内目标范围。",
    "请根据用户描述寻找相关子模块、入口文件、函数、工具链或流水线，不要把整个仓库作为默认范围。",
    input.question,
  ].join("\n")
  const [evidence, moduleMap] = await Promise.all([
    input.codeGraph.queryEvidence(discoveryQuestion, {
      maxEvidenceItems: 60,
      maxEvidenceBytes: 90000,
      retrievalMode: "hybrid",
    }),
    input.codeGraph.runAnalysisTool({ tool: "getModuleMap", args: { query: input.question } }),
  ])
  input.signal?.throwIfAborted()

  const candidates = collectDesignDocTargetCandidates({
    question: input.question,
    evidence,
    moduleMap,
  })
  if (!candidates.length) {
    throw new Error("未能根据当前描述在 CodeGraph/RAG 中定位到候选模块；请补充模块名、入口函数、文件名，或用 @ 指定范围。")
  }

  const modelSelection = await selectDesignDocTargetsWithModel({
    question: input.question,
    candidates,
    model: input.model,
    signal: input.signal,
    log: input.log,
  })
  const selected = modelSelection ?? deterministicDesignDocTargetSelection(candidates)
  if (selected.confidence < MIN_INFERRED_TARGET_CONFIDENCE) {
    throw new Error(
      [
        "已找到候选模块，但定位置信度不足，暂不生成详细设计文档。",
        `候选范围：${candidates.slice(0, 5).map((candidate) => candidate.path).join("、")}`,
        "请补充更具体的模块名、入口函数、文件名，或用 @ 指定范围。",
      ].join("\n"),
    )
  }
  return selected
}

function collectDesignDocTargetCandidates(input: {
  question: string
  evidence?: QueryEvidenceResult
  moduleMap: AnalysisToolResult
}) {
  const candidates = new Map<string, MutableDesignDocTargetCandidate>()
  const matchedFiles = new Set<string>()
  const addCandidate = (pathValue: string, kind: DesignDocTargetKind, score: number, reason: string, evidenceFile?: string) => {
    const cleanPath = normalizeWorkspacePath(pathValue)
    if (!cleanPath || cleanPath === ".") return
    const candidate = candidates.get(cleanPath) ?? {
      path: cleanPath,
      kind,
      score: 0,
      reasons: new Set<string>(),
      evidenceFiles: new Set<string>(),
    }
    candidate.score += score
    candidate.reasons.add(reason)
    if (evidenceFile) candidate.evidenceFiles.add(normalizeWorkspacePath(evidenceFile))
    candidates.set(cleanPath, candidate)
  }
  const addFileCandidate = (file: string, score: number, reason: string) => {
    const cleanFile = normalizeWorkspacePath(file)
    if (!cleanFile || cleanFile === ".") return
    matchedFiles.add(cleanFile)
    const module = moduleKey(cleanFile)
    if (module && module !== ".") addCandidate(module, "folder", score, reason, cleanFile)
    else addCandidate(cleanFile, "file", score, reason, cleanFile)
  }

  for (const item of input.evidence?.retrieval?.evidence ?? []) {
    addFileCandidate(item.path, Math.max(1, item.score), `检索命中文件：${item.reason || item.kind}`)
  }
  for (const ref of input.evidence?.evidencePack.evidence ?? []) {
    addFileCandidate(ref.file, 2, `证据包引用：${ref.parserKind}`)
  }
  for (const file of input.evidence?.summaries.files ?? []) {
    if (matchedFiles.has(normalizeWorkspacePath(file.path))) addCandidate(file.module, "folder", 1.5, "文件摘要属于命中证据", file.path)
  }
  for (const fn of input.evidence?.summaries.functions ?? []) {
    if (matchedFiles.has(normalizeWorkspacePath(fn.path))) addCandidate(fn.module, "folder", 1.2, `函数摘要属于命中证据：${fn.name}`, fn.path)
  }

  const questionTokens = matchTokens(input.question)
  const modules = Array.isArray(input.moduleMap.data) ? input.moduleMap.data.filter(isModuleSummary) : []
  for (const module of modules) {
    const moduleText = [
      module.module,
      module.summary,
      ...module.responsibilities,
      ...module.entrypoints,
      ...module.keyFlows,
      ...module.dependencies,
    ].join(" ")
    const tokenScore = textTokenScore(moduleText, questionTokens)
    const evidenceHit = module.evidence.some((ref) => matchedFiles.has(normalizeWorkspacePath(ref.file)))
    if (tokenScore > 0 || evidenceHit) {
      addCandidate(module.module, "folder", tokenScore + (evidenceHit ? 2 : 0.8), "模块摘要与用户描述或命中文件相关", module.evidence[0]?.file)
    }
  }

  const sorted = [...candidates.values()]
    .map((candidate) => ({
      path: candidate.path,
      kind: candidate.kind,
      score: roundScore(candidate.score),
      confidence: candidateConfidence(candidate.score),
      reasons: [...candidate.reasons].slice(0, 6),
      evidenceFiles: [...candidate.evidenceFiles].slice(0, 12),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_TARGET_CANDIDATES)
  return sorted
}

async function selectDesignDocTargetsWithModel(input: {
  question: string
  candidates: DesignDocTargetCandidate[]
  model?: DocAgentModelProvider
  signal?: AbortSignal
  log?: (message: string) => void
}): Promise<DesignDocTargetResolution | undefined> {
  if (!input.model) return undefined
  try {
    const output = await input.model.completeJson<DesignDocTargetModelOutput>({
      purpose: "resolve-design-doc-targets",
      system: [
        "You select the repository scope for a chip/module detailed design document.",
        "Choose only from the provided candidate paths.",
        "Prefer the smallest coherent module directories that cover the requested mechanism.",
        "Never choose the whole repository unless it is explicitly listed as a candidate.",
      ].join(" "),
      prompt: JSON.stringify({
        userRequest: input.question,
        candidates: input.candidates.map((candidate) => ({
          path: candidate.path,
          kind: candidate.kind,
          confidence: candidate.confidence,
          score: candidate.score,
          reasons: candidate.reasons,
          evidenceFiles: candidate.evidenceFiles,
        })),
        outputSchema: {
          selectedTargets: [{ path: "candidate path", kind: "folder|file", reason: "why this scope matches" }],
          confidence: "0..1",
          explanation: "brief scope decision",
          warnings: ["optional caveats"],
        },
      }),
    }, input.signal)
    const byPath = new Map(input.candidates.map((candidate) => [normalizeWorkspacePath(candidate.path), candidate]))
    const targets: DesignDocTarget[] = []
    const reasons: string[] = []
    for (const item of output.selectedTargets ?? []) {
      const candidate = byPath.get(normalizeWorkspacePath(item.path ?? ""))
      if (!candidate) continue
      targets.push({ path: candidate.path, kind: candidate.kind })
      if (item.reason) reasons.push(`${candidate.path}: ${item.reason}`)
      if (targets.length >= MAX_INFERRED_TARGETS) break
    }
    const normalizedTargets = normalizeTargets(targets)
    if (!normalizedTargets.length) return undefined
    const confidence = clamp01(typeof output.confidence === "number" ? output.confidence : Math.max(...normalizedTargets.map((target) => byPath.get(target.path)?.confidence ?? 0.5)))
    return {
      source: "model-inferred",
      confidence,
      targets: normalizedTargets,
      candidates: input.candidates,
      explanation: output.explanation || reasons.join("\n") || "模型基于候选证据选择了详细设计范围。",
      warnings: Array.isArray(output.warnings) ? output.warnings.filter((item) => typeof item === "string").slice(0, 8) : [],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.log?.(`[design-doc] target resolver model skipped: ${message}`)
    return undefined
  }
}

function deterministicDesignDocTargetSelection(candidates: DesignDocTargetCandidate[]): DesignDocTargetResolution {
  const top = candidates[0]
  if (!top) {
    return { source: "deterministic-inferred", confidence: 0, targets: [], candidates, warnings: ["无候选范围"], explanation: "未找到候选模块。" }
  }
  const selected = candidates
    .filter((candidate) => candidate.score >= Math.max(2, top.score * 0.58))
    .slice(0, MAX_INFERRED_TARGETS)
  const targets = normalizeTargets(selected.map((candidate) => ({ path: candidate.path, kind: candidate.kind })))
  return {
    source: "deterministic-inferred",
    confidence: Math.max(...selected.map((candidate) => candidate.confidence), top.confidence),
    targets,
    candidates,
    explanation: `根据 CodeGraph/RAG 证据分数选择 ${targets.map((target) => target.path).join("、")}。`,
    warnings: ["未使用模型目标选择，已采用确定性候选评分。"],
  }
}

function matchTokens(value: string) {
  const lowered = value.toLowerCase()
  const ascii = lowered.match(/[a-z0-9_][a-z0-9_-]{1,}/g) ?? []
  const cjk = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const cjkBigrams = cjk.flatMap((item) => {
    const tokens: string[] = []
    for (let index = 0; index < item.length - 1; index += 1) tokens.push(item.slice(index, index + 2))
    return tokens
  })
  return [...new Set([...ascii, ...cjk, ...cjkBigrams])].slice(0, 24)
}

function textTokenScore(text: string, tokens: string[]) {
  const normalized = text.toLowerCase()
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0)
}

function candidateConfidence(score: number) {
  return clamp01(0.28 + score / (score + 8))
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100
}

async function renderDesignDocDiagramPngs(
  diagrams: DesignDocDiagramArtifact[],
  renderer: DesignDocAgentInput["renderMermaid"],
  log?: (message: string) => void,
) {
  const render: NonNullable<DesignDocAgentInput["renderMermaid"]> = renderer ?? ((diagram) => renderMermaidToPng({ source: diagram.source }))
  const rendered: DesignDocDiagramArtifact[] = []
  for (const diagram of diagrams) {
    log?.(`[design-doc] render mermaid png id=${diagram.id}`)
    const png = await render({
      id: diagram.id,
      title: diagram.title,
      type: diagram.type,
      source: diagram.source,
    })
    if (!png.bytes.length) throw new Error(`Mermaid PNG renderer returned empty image for ${diagram.title}.`)
    rendered.push({
      ...diagram,
      png: {
        bytes: png.bytes,
        width: png.width,
        height: png.height,
        path: png.artifactPath,
      },
    })
  }
  return rendered
}

function designDocWordSpec(input: {
  title: string
  targetLabel: string
  targets: DesignDocTarget[]
  targetResolution: DesignDocTargetResolution
  modules: ModuleSummary[]
  evidence?: QueryEvidenceResult
  stateMachines: StateMachine[]
  diagrams: DesignDocDiagramArtifact[]
}): WordDocSpec {
  const now = new Date().toISOString()
  const sources = sourceRefs(input)
  const functions = scopedFunctions(input.evidence, input.targets).slice(0, MAX_DESIGN_DOC_FUNCTIONS)
  const files = scopedFiles(input.evidence, input.targets).slice(0, MAX_DESIGN_DOC_FILES)
  const gaps = designDocGaps(input.evidence, input.stateMachines, input.diagrams)
  const diagram = (type: DesignDocDiagramArtifact["type"]) => input.diagrams.find((item) => item.type === type)
  return {
    metadata: {
      title: input.title,
      subtitle: "基于本地 CodeGraph/RAG/状态机证据生成的模块级详细设计草案",
      documentType: "Chip-Level Module Detailed Design",
      language: "zh-CN",
      generatedAt: now,
      author: "ChipMate Design Doc Agent",
      sourceSummary: `目标范围 ${input.targetLabel}，引用 ${sources.length} 组代码证据。`,
    },
    sources,
    cover: {
      title: input.title,
      subtitle: "主业务流程、子业务流程、代码流程、状态机与现有方案说明",
      preparedBy: "ChipMate Design Doc Agent",
    },
    revisionHistory: [{
      version: "0.1",
      date: now.slice(0, 10),
      author: "ChipMate Design Doc Agent",
      summary: "自动生成首版详细设计草案，需模块 owner 复核。",
    }],
    executiveSummary: {
      paragraphs: [
        `本文档面向 ${input.targetLabel} 子模块，目标是把仓库中的现有实现整理为可评审的芯片级详细设计说明。`,
        "文档内容来自本地 CodeGraph、RAG 证据、函数/文件摘要和状态机候选；低置信度状态迁移、动态调用、宏展开路径和未索引文件会在缺口章节中显式列出。",
      ],
      highlights: [
        `${functions.length} 个核心函数/功能候选`,
        `${files.length} 个相关源文件`,
        `${input.stateMachines.length} 个状态机候选`,
        `${input.diagrams.length} 张流程/架构图`,
      ],
    },
    sections: [
      scopeSection(input),
      currentDesignSection(input.modules, files, diagram("architecture")),
      functionSection(functions),
      businessFlowSection(input.modules, functions, diagram("business-flow")),
      codeFlowSection(functions, diagram("code-flow")),
      stateMachineSection(input.stateMachines, diagram("state-machine")),
      diagramSection(input.diagrams),
      gapSection(gaps),
      referencesSection(sources),
    ],
    appendices: [
      evidenceAppendix(input.evidence),
      functionAppendix(functions),
    ],
    references: sources.map((source) => ({
      sourceId: source.id,
      title: source.title,
      path: source.path,
      note: "代码证据来源",
    })),
    qualityChecklist: {
      assumptions: [
        input.targetResolution.source === "explicit"
          ? "用户提供的目标范围是仓库内子模块，而不是整仓。"
          : "目标范围由 ChipMate 根据用户描述、CodeGraph/RAG 证据和候选模块评分自动识别。",
        "CodeGraph/RAG 索引反映当前 workspace 的本地代码状态。",
      ],
      limitations: [
        "Mermaid PNG 已嵌入 Word 对应章节；.mmd 源文件和 .png artifact 作为旁路证据保留。",
        "动态函数指针、宏展开后的隐式控制流、编译条件裁剪路径可能需要人工补证。",
      ],
      missingInputs: gaps,
      risks: [
        "自动抽取的状态机是候选结果，正式评审前需 owner 确认状态含义和切换条件。",
      ],
    },
  }
}

function scopeSection(input: {
  targetLabel: string
  targets: DesignDocTarget[]
  targetResolution: DesignDocTargetResolution
  evidence?: QueryEvidenceResult
}) {
  const resolution = input.targetResolution
  return {
    id: "scope-and-coverage",
    level: 1,
    title: "1. 范围与证据覆盖",
    paragraphs: [
      `目标模块范围：${input.targetLabel}。`,
      resolution.source === "explicit"
        ? "范围来自用户显式提供的 @ 文件、目录、当前文件或选区。"
        : `范围由 ChipMate 自动识别，识别方式：${resolution.source}，置信度：${Math.round(resolution.confidence * 100)}%。${resolution.explanation ? ` ${resolution.explanation}` : ""}`,
      "本文档只描述该子模块当前实现，不把整个仓库视为一个模块，也不推断未出现在证据中的外部业务语义。",
    ],
    tables: [{
      headers: ["范围", "类型", "行区间"],
      rows: input.targets.map((target) => [target.path, target.kind, target.startLine ? `${target.startLine}-${target.endLine ?? target.startLine}` : "全部"]),
    }, {
      headers: ["候选范围", "类型", "置信度", "主要证据", "原因"],
      rows: resolution.candidates.length ? resolution.candidates.slice(0, 8).map((candidate) => [
        candidate.path,
        candidate.kind,
        `${Math.round(candidate.confidence * 100)}%`,
        candidate.evidenceFiles.slice(0, 4).join("\n") || "未记录",
        candidate.reasons.slice(0, 3).join("\n") || "候选评分",
      ]) : [["未记录", "", "", "", ""]],
    }, {
      headers: ["证据项", "数量"],
      rows: [
        ["检索证据", String(input.evidence?.evidencePack.evidence.length ?? 0)],
        ["省略证据", String(input.evidence?.evidencePack.omittedEvidence ?? 0)],
        ["检索是否截断", input.evidence?.evidencePack.truncated ? "是" : "否"],
      ],
    }],
  } satisfies DocumentSection
}

function currentDesignSection(modules: ModuleSummary[], files: ReturnType<typeof scopedFiles>, diagram?: DesignDocDiagramArtifact) {
  return {
    id: "current-design",
    level: 1,
    title: "2. 现有方案总览",
    paragraphs: [
      modules.length
        ? "当前实现由以下模块摘要构成，职责和依赖来自 CodeGraph 的模块级分析。"
        : "未命中明确模块摘要，当前方案主要根据文件、函数和检索证据整理。",
    ],
    tables: modules.length ? [{
      headers: ["模块", "职责", "入口", "依赖", "状态机"],
      rows: modules.slice(0, 12).map((module) => [
        module.module,
        module.responsibilities.join("\n") || module.summary,
        module.entrypoints.join("\n") || "未识别",
        module.dependencies.join("\n") || "未识别",
        module.stateMachines.join("\n") || "未识别",
      ]),
    }] : [{
      headers: ["文件", "职责摘要", "核心符号", "依赖"],
      rows: files.map((file) => [
        file.path,
        file.summary,
        file.coreSymbols.join("\n") || "未识别",
        file.dependencies.join("\n") || "未识别",
      ]),
    }],
    figures: figureList(diagram),
  } satisfies DocumentSection
}

function functionSection(functions: FunctionSummary[]) {
  return {
    id: "function-detail",
    level: 1,
    title: "3. 功能详细设计",
    paragraphs: [
      "本节按函数/功能候选描述现有实现。每一行都应被视为待 owner 复核的设计条目，而不是新方案建议。",
    ],
    tables: [{
      headers: ["功能/函数", "文件", "职责", "输入", "输出", "调用/依赖", "风险"],
      rows: functions.length ? functions.map((fn) => [
        fn.name,
        `${fn.path}\n${fn.signature}`,
        fn.summary,
        fn.inputs.join("\n") || "未识别",
        fn.outputs.join("\n") || "未识别",
        fn.calls.join("\n") || "无直接调用",
        fn.risks.join("\n") || "无显式风险",
      ]) : [["未识别", "", "目标范围内未检索到函数级摘要。", "", "", "", "需要人工补充入口符号或缩小范围"]],
    }],
  } satisfies DocumentSection
}

function businessFlowSection(modules: ModuleSummary[], functions: FunctionSummary[], diagram?: DesignDocDiagramArtifact) {
  const flows = modules.flatMap((module) => module.keyFlows).filter(Boolean)
  const fallbackFlows = functions.slice(0, 8).map((fn) => `${fn.name}: ${fn.summary}`)
  return {
    id: "business-flow",
    level: 1,
    title: "4. 主业务流程与子业务流程",
    paragraphs: [
      "主业务流程按模块入口和关键流程证据整理；子流程按核心函数职责拆分。若仓库代码只提供结构证据而没有产品语义，本文档会保留代码视角描述。",
    ],
    numberedItems: (flows.length ? flows : fallbackFlows).slice(0, 16),
    figures: figureList(diagram),
  } satisfies DocumentSection
}

function codeFlowSection(functions: FunctionSummary[], diagram?: DesignDocDiagramArtifact) {
  return {
    id: "code-flow",
    level: 1,
    title: "5. 代码流程",
    paragraphs: [
      "代码流程从入口函数、直接调用、返回值和错误风险整理。复杂路径建议结合图表章节中的 code-flow 图复核。",
    ],
    tables: [{
      headers: ["入口/函数", "直接调用", "状态机关联", "证据置信度"],
      rows: functions.slice(0, 16).map((fn) => [
        fn.name,
        fn.calls.join("\n") || "无直接调用",
        fn.stateMachines.join("\n") || "未关联",
        `${Math.round(fn.confidence * 100)}%`,
      ]),
    }],
    figures: figureList(diagram),
  } satisfies DocumentSection
}

function stateMachineSection(machines: StateMachine[], diagram?: DesignDocDiagramArtifact) {
  return {
    id: "state-machines",
    level: 1,
    title: "6. 状态机切换流程与切换条件",
    paragraphs: [
      machines.length
        ? "以下状态机由枚举、状态变量、switch/case、条件判断和状态赋值等结构信号抽取。"
        : "目标范围内未识别到高置信度状态机。若模块使用隐式状态、位域或外部调度表，需要人工补充。",
    ],
    tables: machines.length ? machines.slice(0, 4).flatMap((machine) => [{
      caption: `${machine.name}（${machine.module}）`,
      headers: ["From", "To", "事件", "Guard/条件", "Action", "证据"],
      rows: machine.transitions.slice(0, MAX_STATE_TRANSITIONS).map((transition) => [
        transition.fromState,
        transition.toState,
        transition.event ?? "",
        transition.guard ?? "",
        transition.action ?? "",
        `${transition.evidence.file}:${transition.evidence.startLine}-${transition.evidence.endLine}`,
      ]),
    }]) : [{
      headers: ["状态机", "说明"],
      rows: [["未识别", "未找到状态变量、枚举状态或状态迁移赋值证据。"]],
    }],
    figures: figureList(diagram),
  } satisfies DocumentSection
}

function diagramSection(diagrams: DesignDocDiagramArtifact[]) {
  return {
    id: "diagrams",
    level: 1,
    title: "7. 图表索引",
    paragraphs: [
      "Word 正文中的图表均为 Mermaid 渲染后的 PNG，并已放入对应章节；本节只列出 .mmd 源文件、.png 图像 artifact 和渲染 warning，便于复核与再渲染。",
    ],
    tables: [{
      headers: ["图", "类型", "Mermaid source", "PNG artifact", "Warning"],
      rows: diagrams.length ? diagrams.map((diagram) => [
        diagram.title,
        diagram.type,
        diagram.path ?? `${diagram.id}.mmd`,
        diagram.png?.path ?? `${diagram.id}.png`,
        diagram.warnings?.join("\n") || "无",
      ]) : [["未生成", "", "", "", "图表生成失败或证据不足"]],
    }],
  } satisfies DocumentSection
}

function figureList(diagram?: DesignDocDiagramArtifact): FigureSpec[] | undefined {
  return diagram ? [figureForDiagram(diagram)] : undefined
}

function figureForDiagram(diagram: DesignDocDiagramArtifact): FigureSpec {
  if (!diagram.png) throw new Error(`Missing Mermaid PNG for design doc diagram: ${diagram.id}`)
  const mmdPath = diagram.path ?? `${diagram.id}.mmd`
  const pngPath = diagram.png.path ?? `${diagram.id}.png`
  return {
    id: `figure-${diagram.id}`,
    title: diagram.title,
    caption: `图表 artifact：PNG=${pngPath}；Mermaid source=${mmdPath}`,
    altText: `${diagram.title} Mermaid rendered PNG`,
    image: {
      contentType: "image/png",
      bytes: diagram.png.bytes,
      width: diagram.png.width,
      height: diagram.png.height,
    },
  }
}

function gapSection(gaps: string[]) {
  return {
    id: "gaps-risks",
    level: 1,
    title: "8. 缺口、限制与评审风险",
    bullets: gaps.length ? gaps : ["未发现显式缺口；仍建议 owner 复核动态调用、宏展开和编译条件相关路径。"],
  } satisfies DocumentSection
}

function referencesSection(sources: SourceRef[]) {
  return {
    id: "references",
    level: 1,
    title: "References",
    tables: [{
      headers: ["ID", "来源", "路径"],
      rows: sources.map((source) => [source.id, source.title, source.path ?? ""]),
    }],
  } satisfies DocumentSection
}

function evidenceAppendix(evidence?: QueryEvidenceResult) {
  const refs = evidence?.evidencePack.evidence ?? []
  return {
    id: "appendix-evidence-ledger",
    level: 1,
    title: "附录 A：证据 Ledger",
    tables: [{
      headers: ["文件", "行号", "类型", "Hash"],
      rows: refs.slice(0, 80).map((ref) => [ref.file, `${ref.startLine}-${ref.endLine}`, ref.parserKind, ref.snippetHash]),
    }],
  } satisfies DocumentSection
}

function functionAppendix(functions: FunctionSummary[]) {
  return {
    id: "appendix-function-index",
    level: 1,
    title: "附录 B：函数/功能索引",
    tables: [{
      headers: ["函数", "文件", "签名"],
      rows: functions.map((fn) => [fn.name, fn.path, fn.signature]),
    }],
  } satisfies DocumentSection
}

function designDocMermaidArtifacts(input: {
  title: string
  targetLabel: string
  modules: ModuleSummary[]
  evidence?: QueryEvidenceResult
  machines: StateMachine[]
}) {
  const functions = scopedFunctions(input.evidence, []).slice(0, MAX_DIAGRAM_NODES)
  const files = scopedFiles(input.evidence, []).slice(0, MAX_DIAGRAM_NODES)
  const architectureItems = input.modules.length
    ? input.modules.slice(0, 8).map((module) => ({
      id: mermaidNodeId(`module-${module.module}`),
      label: module.module,
      detail: module.responsibilities[0] || module.summary,
    }))
    : files.slice(0, 8).map((file) => ({
      id: mermaidNodeId(`file-${file.path}`),
      label: file.path,
      detail: file.summary,
    }))
  const flowItems = functions.length
    ? functions.slice(0, 10).map((fn, index) => ({
      id: mermaidNodeId(`fn-${index}-${fn.name}`),
      label: fn.name,
      detail: fn.summary,
    }))
    : architectureItems.slice(0, 6)
  const businessItems = input.modules.flatMap((module, moduleIndex) =>
    module.keyFlows.slice(0, 4).map((flow, flowIndex) => ({
      id: mermaidNodeId(`biz-${moduleIndex}-${flowIndex}-${flow}`),
      label: flow,
      detail: module.module,
    })),
  )
  const machine = input.machines[0]
  const artifacts: DesignDocDiagramArtifact[] = [
    {
      id: "architecture",
      title: `${input.targetLabel} 架构边界图`,
      kind: "mermaid",
      type: "architecture" as const,
      source: mermaidFlowchart({
        title: `${input.targetLabel} 架构边界图`,
        items: architectureItems,
        emptyLabel: "未识别明确模块边界",
        edgeLabel: "依赖/协作",
      }),
    },
    {
      id: "business-flow",
      title: `${input.targetLabel} 主业务流程图`,
      kind: "mermaid",
      type: "business-flow" as const,
      source: mermaidFlowchart({
        title: `${input.targetLabel} 主业务流程图`,
        items: businessItems.length ? businessItems.slice(0, 10) : flowItems,
        emptyLabel: "未识别明确主流程",
        edgeLabel: "next",
      }),
    },
    {
      id: "code-flow",
      title: `${input.targetLabel} 代码调用流程图`,
      kind: "mermaid",
      type: "code-flow" as const,
      source: mermaidFlowchart({
        title: `${input.targetLabel} 代码调用流程图`,
        items: flowItems,
        emptyLabel: "未识别入口函数",
        edgeLabel: "call/return",
      }),
    },
  ]
  if (machine) {
    artifacts.push({
      id: "state-machine",
      title: `${machine?.name ?? input.targetLabel} 状态机切换图`,
      kind: "mermaid",
      type: "state-machine" as const,
      source: mermaidStateDiagram(machine),
    })
  }
  return artifacts
}

function mermaidFlowchart(input: {
  title: string
  items: Array<{ id: string; label: string; detail?: string }>
  emptyLabel: string
  edgeLabel: string
}) {
  const items = input.items.slice(0, MAX_DIAGRAM_NODES)
  const rows = [
    "flowchart TD",
    `  %% ${mermaidComment(input.title)}`,
  ]
  if (!items.length) {
    rows.push(`  ${mermaidNodeId("empty")}[${mermaidQuotedLabel(input.emptyLabel)}]`)
    return rows.join("\n")
  }
  for (const item of items) {
    const label = item.detail ? `${item.label}\\n${item.detail}` : item.label
    rows.push(`  ${item.id}[${mermaidQuotedLabel(label)}]`)
  }
  for (let index = 1; index < items.length; index += 1) {
    const source = items[index - 1]!
    const target = items[index]!
    rows.push(`  ${source.id} -->|${mermaidEdgeLabel(index === 1 ? input.edgeLabel : "next")}| ${target.id}`)
  }
  return rows.join("\n")
}

function mermaidStateDiagram(machine: StateMachine) {
  const existing = machine.mermaid?.trim()
  if (existing && /^stateDiagram-v2\b/.test(existing)) return existing
  const rows = [
    "stateDiagram-v2",
    `  %% ${mermaidComment(machine.name)}`,
  ]
  const stateIds = new Map<string, string>()
  for (const state of machine.states.slice(0, 24)) {
    const id = mermaidNodeId(`state-${state.name}`)
    stateIds.set(state.name, id)
    rows.push(`  state ${mermaidQuotedLabel(state.name)} as ${id}`)
  }
  for (const transition of machine.transitions.slice(0, MAX_STATE_TRANSITIONS)) {
    const from = stateIds.get(transition.fromState) ?? mermaidNodeId(`state-${transition.fromState}`)
    const to = stateIds.get(transition.toState) ?? mermaidNodeId(`state-${transition.toState}`)
    const label = [transition.event, transition.guard, transition.action].filter(Boolean).join(" / ")
    rows.push(`  ${from} --> ${to}${label ? `: ${mermaidStateLabel(label)}` : ""}`)
  }
  if (rows.length <= 2) rows.push("  [*] --> unknown")
  return rows.join("\n")
}

function mermaidNodeId(value: string) {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
  return `m_${clean || "node"}`
}

function mermaidQuotedLabel(value: string) {
  return `"${mermaidLabel(value)}"`
}

function mermaidEdgeLabel(value: string) {
  return mermaidLabel(value).replace(/\|/g, "/")
}

function mermaidStateLabel(value: string) {
  return mermaidLabel(value).replace(/:/g, "-")
}

function mermaidLabel(value: string) {
  return value
    .replace(/\r?\n/g, "\\n")
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/[{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "未命名"
}

function mermaidComment(value: string) {
  return value.replace(/\r?\n/g, " ").replace(/%/g, "").trim().slice(0, 160)
}

async function writeDesignDocArtifacts(input: {
  runId: string
  title: string
  targetLabel: string
  targets: DesignDocTarget[]
  targetResolution: DesignDocTargetResolution
  diagrams: DesignDocDiagramArtifact[]
  evidence?: QueryEvidenceResult
  moduleMap: AnalysisToolResult
  stateMachines: AnalysisToolResult
}) {
  const warnings: string[] = []
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const outputDir = path.join(workspaceRoot, ".chipmate", "docs", input.runId)
  const diagramDir = path.join(outputDir, "diagrams")
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(diagramDir))

  const diagrams: DesignDocDiagramArtifact[] = []
  for (const diagram of input.diagrams) {
    if (!diagram.png) throw new Error(`Missing rendered Mermaid PNG for design doc diagram: ${diagram.id}`)
    const mmdFileName = `${diagram.id}.mmd`
    const pngFileName = `${diagram.id}.png`
    const mmdAbsolutePath = path.join(diagramDir, mmdFileName)
    const pngAbsolutePath = path.join(diagramDir, pngFileName)
    await vscode.workspace.fs.writeFile(vscode.Uri.file(mmdAbsolutePath), new TextEncoder().encode(diagram.source))
    await vscode.workspace.fs.writeFile(vscode.Uri.file(pngAbsolutePath), diagram.png.bytes)
    diagrams.push({
      ...diagram,
      path: posixRelative(workspaceRoot, mmdAbsolutePath),
      png: {
        ...diagram.png,
        path: posixRelative(workspaceRoot, pngAbsolutePath),
      },
    })
  }

  const summary: DesignDocRunSummary = {
    runId: input.runId,
    title: input.title,
    targetLabel: input.targetLabel,
    targets: input.targets,
    targetResolution: input.targetResolution,
    diagrams: diagrams.map((diagram) => ({
      id: diagram.id,
      kind: diagram.kind,
      title: diagram.title,
      type: diagram.type,
      path: diagram.path,
      pngPath: diagram.png?.path,
    })),
    evidence: (input.evidence?.evidencePack.evidence ?? []).map((ref) => ({
      file: ref.file,
      lines: `${ref.startLine}-${ref.endLine}`,
      parserKind: ref.parserKind,
    })),
    gaps: designDocGaps(input.evidence, statesFromAny(input.stateMachines.data), diagrams),
    warnings,
  }
  const summaryPath = path.join(outputDir, "run-summary.json")
  const evidencePath = path.join(outputDir, "evidence-ledger.json")
  await vscode.workspace.fs.writeFile(vscode.Uri.file(summaryPath), new TextEncoder().encode(JSON.stringify(summary, null, 2)))
  await vscode.workspace.fs.writeFile(vscode.Uri.file(evidencePath), new TextEncoder().encode(JSON.stringify({
    targetResolution: input.targetResolution,
    queryTrace: input.evidence?.trace,
    evidencePack: input.evidence?.evidencePack,
    moduleMap: input.moduleMap.data,
    stateMachines: input.stateMachines.data,
  }, null, 2)))

  return {
    warnings,
    diagrams,
    summary,
    summaryPath: posixRelative(workspaceRoot, summaryPath),
  }
}

function normalizeTargets(targets: DesignDocTarget[]) {
  const seen = new Set<string>()
  const result: DesignDocTarget[] = []
  for (const target of targets) {
    const cleanPath = normalizeWorkspacePath(target.path)
    const key = `${cleanPath}:${target.kind}:${target.startLine ?? ""}:${target.endLine ?? ""}`
    if (!cleanPath || seen.has(key)) continue
    seen.add(key)
    result.push({
      ...target,
      path: cleanPath,
    })
  }
  return result
}

function normalizeWorkspacePath(input: string) {
  return input.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || "."
}

function targetLabelText(targets: DesignDocTarget[]) {
  if (targets.length === 1) {
    const target = targets[0]!
    if (target.kind === "selection" && target.startLine) return `${target.path}:${target.startLine}-${target.endLine ?? target.startLine}`
    return target.path
  }
  return `${targets[0]?.path ?? "module"} 等 ${targets.length} 个范围`
}

function scopedModuleSummaries(result: AnalysisToolResult, targets: DesignDocTarget[]) {
  const modules = Array.isArray(result.data) ? result.data.filter(isModuleSummary) : []
  const scoped = modules.filter((module) => targets.some((target) => pathMatchesTarget(module.module, target.path)))
  return scoped.length ? scoped : modules.slice(0, 8)
}

function scopedFunctions(evidence: QueryEvidenceResult | undefined, targets: DesignDocTarget[]) {
  const functions = evidence?.summaries.functions ?? []
  if (targets.length === 0) return functions
  const scoped = functions.filter((fn) => targets.some((target) => pathMatchesTarget(fn.path, target.path)))
  return scoped.length ? scoped : functions
}

function scopedFiles(evidence: QueryEvidenceResult | undefined, targets: DesignDocTarget[]) {
  const files = evidence?.summaries.files ?? []
  if (targets.length === 0) return files
  const scoped = files.filter((file) => targets.some((target) => pathMatchesTarget(file.path, target.path)))
  return scoped.length ? scoped : files
}

function stateMachinesFromTool(result: AnalysisToolResult) {
  return statesFromAny(result.data)
}

function scopedStateMachines(machines: StateMachine[], targets: DesignDocTarget[]) {
  if (!targets.length) return machines
  const scoped = machines.filter((machine) =>
    targets.some((target) =>
      pathMatchesTarget(machine.module, target.path)
      || machine.evidence.some((ref) => pathMatchesTarget(ref.file, target.path))
      || machine.transitions.some((transition) => pathMatchesTarget(transition.evidence.file, target.path)),
    ),
  )
  return scoped.length ? scoped : machines
}

function statesFromAny(data: unknown): StateMachine[] {
  if (!Array.isArray(data)) return []
  return data.filter(isStateMachine)
}

function pathMatchesTarget(candidate: string, target: string) {
  const left = normalizeWorkspacePath(candidate)
  const right = normalizeWorkspacePath(target)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function designDocGaps(evidence: QueryEvidenceResult | undefined, machines: StateMachine[], diagrams: DesignDocDiagramArtifact[]) {
  const gaps = new Set<string>()
  if (!evidence) gaps.add("未获得 CodeGraph/RAG 证据包，文档只能作为空壳草案。")
  for (const gap of evidence?.evidencePack.missingEvidence ?? []) gaps.add(gap)
  if (evidence?.evidencePack.truncated) gaps.add("证据包被预算截断，需要缩小模块范围或提高 analysis evidence budget。")
  if (!machines.length) gaps.add("未识别到状态机候选；若模块存在隐式状态或位域状态，需要人工补充状态表。")
  if (!diagrams.length) gaps.add("未生成 Mermaid 流程图；可能是证据不足或 Mermaid source 生成失败。")
  return [...gaps]
}

function sourceRefs(input: {
  targets: DesignDocTarget[]
  evidence?: QueryEvidenceResult
}) {
  const refs = new Map<string, SourceRef>()
  for (const target of input.targets) {
    refs.set(`target:${target.path}`, {
      id: `target-${refs.size + 1}`,
      title: `目标范围：${target.path}`,
      path: target.path,
      role: "internal",
      origin: "internal_company",
    })
  }
  for (const ref of input.evidence?.evidencePack.evidence ?? []) {
    if (refs.has(ref.file)) continue
    refs.set(ref.file, {
      id: `src-${refs.size + 1}`,
      title: `${ref.file}:${ref.startLine}-${ref.endLine}`,
      path: ref.file,
      role: "internal",
      origin: "internal_company",
    })
  }
  return [...refs.values()]
}

function isModuleSummary(input: unknown): input is ModuleSummary {
  return Boolean(input && typeof input === "object" && typeof (input as ModuleSummary).module === "string")
}

function isStateMachine(input: unknown): input is StateMachine {
  return Boolean(input && typeof input === "object" && Array.isArray((input as StateMachine).states) && Array.isArray((input as StateMachine).transitions))
}

function timelineEmitter(input: DesignDocAgentInput) {
  let sequence = 0
  return (
    type: DocAgentTimelineEvent["type"],
    title: string,
    detail: string,
    status: DocAgentTimelineEvent["status"],
    current: number,
    eventPath?: string,
  ) => {
    input.onTimeline?.({
      id: `design-doc-${++sequence}`,
      type,
      title,
      detail,
      status,
      timelineKey: type,
      stateLabel: status === "completed" ? "完成" : status === "warning" ? "需复核" : "运行中",
      timestamp: Date.now(),
      current,
      total: DESIGN_DOC_STAGE_TOTAL,
      path: eventPath,
    })
  }
}

function designDocRunId(targetLabel: string) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
  return `design-doc-${sanitizeFilenameBase(targetLabel)}-${stamp}`
}

function sanitizeFilenameBase(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|\0]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "module"
}

function posixRelative(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/")
}
