#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { mock } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import { queryEvidenceAsync } from "../src/codegraph-analysis"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { searchCodeGraphSymbols } from "../src/codegraph-query"
import { type CEmbeddedCompletionEvidenceResult, buildCEmbeddedCompletionEvidence, shouldBuildCEmbeddedCompletionEvidence } from "../src/completion-c-embedded-evidence"
import { runCompletionCandidatePipeline } from "../src/completion-candidate-pipeline"
import { CompletionModelClient, type CompletionTransport } from "../src/completion-model-client"
import { planCompletion } from "../src/completion-plan"
import { completionRetrievalPlan, shouldRetrieveCompletionSnippetsForPlan, type CompletionRetrievalPreferredKind } from "../src/completion-retrieval"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel } from "../src/completion-router"
import { completionSnippetFromSymbol } from "../src/completion-snippets"
import { resolveSymbols, symbolCandidateFromCodeGraph } from "../src/completion-symbol"
import type { CompletionDebugEvent } from "../src/completion-telemetry"
import type { CodeGraphContextProvider, CodeGraphEvidenceQueryOptions, CodeGraphIndex } from "../src/codegraph-types"
import type { CompletionContextPack } from "../src/completion-context"
import type { CompletionEditInput } from "../src/completion-edit"
import type { CompletionPlan, CompletionRetrievalPolicy, RetrievedCompletionSnippet } from "../src/completion-types"
import type { OpenCodeMessage, RemoteSettings } from "../src/types"

export const COMPLETION_QUALITY_SCENARIOS = [
  "member-access",
  "symbol-prefix",
  "call-args",
  "initializer",
  "error-path",
  "switch-case",
  "top-level-decl",
  "mmio-register",
  "state-machine",
  "body-statement",
] as const

export type CompletionQualityScenario = (typeof COMPLETION_QUALITY_SCENARIOS)[number]

export type CompletionQualityFixture = {
  name: string
  languageId: string
  file: string
  prefix: string
  suffix: string
  cursorContext: {
    triggerKind?: "automatic" | "manual" | "invoke" | string
    scenario?: CompletionQualityScenario | string
    retrievedSnippets?: RetrievedCompletionSnippet[]
    mockOutput?: string
    codeGraphFiles?: Array<{
      file: string
      text: string
      languageId?: string
    }>
  }
  expectedIntent: string
  expectedPatterns: string[]
  expectedSimilarFunction?: string
  forbiddenPatterns: string[]
  mustUseExistingSymbols: string[]
  mustMatchLocalStyle: boolean | string[]
  retrievedSnippets?: RetrievedCompletionSnippet[]
  mockOutput?: string
}

export type CompletionQualityBenchmarkOptions = {
  fixtureRoot?: string
  fixture?: string
  limit?: number
  repeat?: number
  mock?: boolean
  directQwenAblation?: boolean
  ablationVariant?: "baseline" | "p2-evidence" | "both"
  dumpPrompts?: boolean
  dumpEvidence?: boolean
  outputDir?: string
  samplePrompts?: number
  sampleSeed?: number
  apiBaseUrl?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  transport?: CompletionTransport
  promptStyle?: "qwen-fim"
  temperature?: number
  maxTokens?: number
  seed?: number
  report?: string
  timeoutMs?: number
  debugFullRetrieval?: boolean
  expectedSymbol?: string
  commentGuidedRetrievalMode?: "qa-exact" | "completion"
}

export type CompletionQualityRecord = {
  name: string
  file: string
  scenario: string
  languageId: string
  expectedIntent: string
  actualIntent: string
  planKind: string
  cIntent?: string
  routeKind: string
  promptKind: string
  visible: boolean
  groundedSymbol: boolean
  forbidden: boolean
  intentMatch: boolean
  styleMatch: boolean
  retrievalHit: boolean
  promptTokenCount: number
  latencyMs: number
  rawModelOutputSample: string
  finalInsertTextSample: string
  rejectReason?: string
  evidenceKinds: string[]
  contextLevel: string
  contextWarnings?: string[]
  retrievalMode?: string
  actualCompletionBackend?: "direct-qwen" | "mock-provider"
  ablationVariant?: "baseline" | "p2-evidence"
  transport?: CompletionTransport
  model?: string
  promptEvidenceMatched?: boolean
  evidencePromptBlocks?: number
  evidencePromptTokens?: number
  evidencePromptKinds?: string[]
  protocolArtifact?: boolean
  rawOutputLength?: number
  finalInsertTextLength?: number
  retrievalPolicy?: CompletionRetrievalPolicy
  domainHints?: string[]
  finalPrompt?: string
  rawModelOutput?: string
  finalInsertText?: string
  postprocessReason?: string
  selectedEvidence?: DumpEvidenceBlock[]
  retrievalTrace?: CompletionQualityRetrievalTrace
  runMode?: "mock-dry-run" | "live"
  qualityMetricValid?: boolean
  failureReason?: string
  cEmbeddedEvidenceTrace?: CompletionDebugEvent["cEmbeddedEvidenceTrace"]
  normalizedCommentTokens?: string[]
  candidateTokenCoverage?: CompletionDebugEvent["candidateTokenCoverage"]
  semanticCandidateTopK?: CompletionDebugEvent["semanticCandidateTopK"]
  selectedSimilarFunctionNames?: string[]
  correctFunctionInCandidates?: boolean
  retrievalElapsedMs?: number
  retrievalBudgetMs?: number
  retrievalTimedOut?: boolean
  timeoutStage?: string
  qaAlignedEvidence?: boolean
  qaTopCandidate?: string
  completionTopCandidate?: string
  sharedTopCandidate?: string
  qaRetrievalTopK?: string[]
  completionRetrievalTopK?: string[]
  alignmentReason?: string
  rerankEnabled?: boolean
  ragAvailable?: boolean
  latencyBudgetMs?: number
  maxEvidence?: number
  evidenceRoles?: string[]
  generationModeHint?: string
  helperCallableConfidence?: string
  callableHelperCandidates?: string[]
  styleExampleCandidates?: string[]
  qaStyleTopK?: string[]
  completionProjectionTopK?: string[]
  droppedAlignedEvidence?: string[]
  cursorContextFeatures?: CompletionDebugEvent["cursorContextFeatures"]
  fullRetrievalCandidateCount?: number
  projectionCandidateCount?: number
  retrievalShape?: string
  qaExactTopK?: string[]
  qaExactSubmittedEvidence?: string[]
  qaExactContextTopK?: string[]
  semanticQueryText?: string
  graphQuestionTextHash?: string
  semanticTopK?: string[]
  graphTopK?: string[]
  mergedTopK?: string[]
  selectedPromptEvidenceNames?: string[]
  rawSemanticTopK?: string[]
  rawGraphTopK?: string[]
  mergedRetrievalTopK?: string[]
  projectionTopK?: string[]
  projectedEvidenceNames?: string[]
  actualPromptEvidenceNames?: string[]
  droppedProjectedEvidenceNames?: string[]
  rawTop1Aligned?: boolean
  retrievalRecallAligned?: boolean
  projectionSelectedStrongHelper?: boolean
  promptContainsProjectedHelper?: boolean
  probeAffectsPrompt?: boolean
  probeCompleted?: boolean
  projectionToPromptDropReason?: string
  submittedEvidenceNames?: string[]
  expectedSymbolInQaExactRetrieval?: boolean
  expectedSymbolInFullRetrieval?: boolean
  expectedSymbolInProjection?: boolean
  expectedSymbolInPrompt?: boolean
  fullRetrievalProbeDumpPath?: string
}

export type CompletionQualitySummary = {
  run_mode: "mock-dry-run" | "live"
  actualCompletionBackend?: "direct-qwen" | "mock-provider"
  quality_metric_valid: boolean
  metric_note: string
  visible_rate: number
  grounded_symbol_rate: number
  forbidden_rate: number
  intent_match_rate: number
  style_match_rate: number
  retrieval_hit_rate: number
  promptEvidenceMatched?: number
  protocol_artifact_rate?: number
  prompt_token_count: {
    avg: number
    p50: number
    p95: number
  }
  raw_output_length?: {
    avg: number
    p50: number
    p95: number
  }
  final_insert_text_length?: {
    avg: number
    p50: number
    p95: number
  }
  latency_ms: {
    avg: number
    p50: number
    p95: number
  }
  raw_model_output_sample: string
  final_insert_text_sample: string
  qwen_fim: CompletionQualityPathSummary
  deterministic_symbol: CompletionQualityPathSummary
}

export type CompletionQualityPathSummary = {
  count: number
  visible_rate: number
  grounded_symbol_rate: number
  forbidden_rate: number
  intent_match_rate: number
  style_match_rate: number
  retrieval_hit_rate: number
  selected_evidence_count: {
    avg: number
    p50: number
    p95: number
  }
}

export type CompletionQualityLatestReport = {
  generatedAt: string
  runMode: "mock-dry-run" | "live"
  actualCompletionBackend?: "direct-qwen" | "mock-provider"
  qualityMetricValid: boolean
  metricNote: string
  records: CompletionQualityLatestReportRecord[]
}

export type CompletionQualityLatestReportRecord = {
  fixtureName: string
  actualCompletionBackend?: "direct-qwen" | "mock-provider"
  ablationVariant?: "baseline" | "p2-evidence"
  actualPlanKind: string
  actualCIntent?: string
  retrievalMode: string
  evidenceKinds: string[]
  selectedEvidenceCount: number
  contextLevel: string
  contextWarnings?: string[]
  promptKind: string
  transport?: CompletionTransport
  model?: string
  promptTokenEstimate: number
  finalPromptPath?: string
  finalEvidencePath?: string
  retrievalPolicy?: CompletionRetrievalPolicy
  domainHints?: string[]
  mockVisibleCandidate: string
  rawOutputPath?: string
  finalInsertPath?: string
  rawOutputLength?: number
  finalInsertTextLength?: number
  promptEvidenceMatched?: boolean
  evidencePromptBlocks?: number
  evidencePromptTokens?: number
  evidencePromptKinds?: string[]
  protocolArtifact?: boolean
  failureReason?: string
  ragFallbackTriggered?: boolean
  ragFallbackReason?: string
  graphEvidenceCount?: number
  ragEvidenceCount?: number
  finalSelectedEvidenceCount?: number
  normalizedCommentTokens?: string[]
  candidateTokenCoverage?: CompletionDebugEvent["candidateTokenCoverage"]
  semanticCandidateTopK?: CompletionDebugEvent["semanticCandidateTopK"]
  selectedSimilarFunctionNames?: string[]
  correctFunctionInCandidates?: boolean
  retrievalElapsedMs?: number
  retrievalBudgetMs?: number
  retrievalTimedOut?: boolean
  timeoutStage?: string
  qaAlignedEvidence?: boolean
  qaTopCandidate?: string
  completionTopCandidate?: string
  sharedTopCandidate?: string
  qaRetrievalTopK?: string[]
  completionRetrievalTopK?: string[]
  alignmentReason?: string
  rerankEnabled?: boolean
  ragAvailable?: boolean
  latencyBudgetMs?: number
  maxEvidence?: number
  evidenceRoles?: string[]
  generationModeHint?: string
  helperCallableConfidence?: string
  callableHelperCandidates?: string[]
  styleExampleCandidates?: string[]
  qaStyleTopK?: string[]
  completionProjectionTopK?: string[]
  droppedAlignedEvidence?: string[]
  cursorContextFeatures?: CompletionDebugEvent["cursorContextFeatures"]
  fullRetrievalCandidateCount?: number
  projectionCandidateCount?: number
  retrievalShape?: string
  qaExactTopK?: string[]
  qaExactSubmittedEvidence?: string[]
  qaExactContextTopK?: string[]
  semanticQueryText?: string
  graphQuestionTextHash?: string
  semanticTopK?: string[]
  graphTopK?: string[]
  mergedTopK?: string[]
  selectedPromptEvidenceNames?: string[]
  rawSemanticTopK?: string[]
  rawGraphTopK?: string[]
  mergedRetrievalTopK?: string[]
  projectionTopK?: string[]
  projectedEvidenceNames?: string[]
  actualPromptEvidenceNames?: string[]
  droppedProjectedEvidenceNames?: string[]
  rawTop1Aligned?: boolean
  retrievalRecallAligned?: boolean
  projectionSelectedStrongHelper?: boolean
  promptContainsProjectedHelper?: boolean
  probeAffectsPrompt?: boolean
  probeCompleted?: boolean
  projectionToPromptDropReason?: string
  submittedEvidenceNames?: string[]
  expectedSymbolInQaExactRetrieval?: boolean
  expectedSymbolInFullRetrieval?: boolean
  expectedSymbolInProjection?: boolean
  expectedSymbolInPrompt?: boolean
  fullRetrievalProbeDumpPath?: string
}

type CompletionQualityRetrievalTrace = {
  symbolQueries: Array<{
    query: string
    relatedPath?: string
    limit?: number
    resultCount: number
  }>
  evidenceQueries: Array<{
    question: string
    retrievalMode: string
    relatedPaths?: string[]
    resultBytes: number
  }>
}

type DumpEvidenceBlock = {
  kind: string
  title: string
  filePath?: string
  tokenEstimate: number
  score: number
  text: string
}

type DirectQwenAblationVariant = "baseline" | "p2-evidence"

type DirectQwenConfig = {
  apiBaseUrl: string
  model: string
  apiKey?: string
  transport: CompletionTransport
  promptStyle: "qwen-fim"
  temperature: number
  maxTokens: number
  topP: number
  seed?: number
  configSource: string[]
  deprecatedEnvUsed: string[]
}

type DirectQwenAblationResult = {
  summary: CompletionQualitySummary
  records: CompletionQualityRecord[]
  output: DirectAblationOutput
}

type DirectAblationOutput = ReturnType<typeof prepareDirectAblationOutput>

const vscodeShimState: {
  activeTextEditor?: { document: unknown; selection?: unknown; options?: { insertSpaces?: boolean | string; tabSize?: number | string } }
  visibleTextEditors: Array<{ document: unknown; selection?: unknown; options?: { insertSpaces?: boolean | string; tabSize?: number | string } }>
  textDocuments: unknown[]
} = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  textDocuments: [],
}

installVscodeShim()

export async function runCompletionQualityBenchmark(options: CompletionQualityBenchmarkOptions = {}) {
  if (options.directQwenAblation) return runDirectQwenAblation(options)

  const root = resolve(options.fixtureRoot ?? "test/completion-fixtures")
  const runMode = options.mock ? "mock-dry-run" : "live"
  const fixtures = loadCompletionQualityFixtures(root)
    .filter((fixture) => !options.fixture || fixture.name.includes(options.fixture) || fixture.file.includes(options.fixture))
    .slice(0, options.limit && options.limit > 0 ? options.limit : undefined)
  const repeat = Math.max(1, options.repeat ?? 1)
  const settings = benchmarkSettings(options)
  const apiKey = options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined) ?? process.env.OPENCODE_COMPLETION_API_KEY ?? process.env.OPENAI_API_KEY
  const output = prepareBenchmarkOutput(options)

  if (!options.mock) {
    if (!settings.completion.apiBaseUrl) throw new Error("Missing completion API base URL. Set OPENCODE_COMPLETION_API_BASE_URL or pass --api-base-url.")
    if (!settings.completion.model) throw new Error("Missing completion model. Set OPENCODE_COMPLETION_MODEL or pass --model.")
  }

  const records: CompletionQualityRecord[] = []
  for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
    for (const fixture of fixtures) {
      const record = await runCompletionQualityFixture({
        fixture,
        settings,
        apiKey,
        mock: Boolean(options.mock),
        timeoutMs: options.timeoutMs ?? 60000,
      })
      record.runMode = runMode
      record.qualityMetricValid = !options.mock
      records.push(record)
    }
  }

  const summary = summarizeCompletionQuality(records, runMode)
  writeLatestDump({
    records,
    summary,
    output,
    dumpPrompts: Boolean(options.dumpPrompts),
    dumpEvidence: Boolean(options.dumpEvidence),
  })
  if (options.dumpPrompts) {
    printPromptSamples(records, {
      samplePrompts: options.samplePrompts ?? 10,
      sampleSeed: options.sampleSeed,
    })
  }
  if (options.report) {
    writeReport(resolve(options.report), { summary, records })
  }
  return { summary, records }
}

export async function runDirectQwenAblation(options: CompletionQualityBenchmarkOptions = {}) {
  const root = resolve(options.fixtureRoot ?? "test/completion-fixtures")
  const fixtures = loadCompletionQualityFixtures(root)
    .filter((fixture) => !options.fixture || fixture.name.includes(options.fixture) || fixture.file.includes(options.fixture))
    .slice(0, options.limit && options.limit > 0 ? options.limit : undefined)
  const config = directQwenConfig(options)
  validateDirectQwenConfig(config)
  const variants = directAblationVariants(options.ablationVariant)
  const variantResults: Partial<Record<DirectQwenAblationVariant, DirectQwenAblationResult>> = {}

  for (const variant of variants) {
    const output = prepareDirectAblationOutput(options.outputDir ?? ".completion-quality", variant)
    const settings = directQwenSettings(config)
    const records: CompletionQualityRecord[] = []
    for (const fixture of fixtures) {
      const record = await runDirectQwenAblationFixture({
        fixture,
        settings,
        apiKey: config.apiKey,
        variant,
        config,
        timeoutMs: options.timeoutMs ?? 60000,
      })
      records.push(record)
    }
    const summary = summarizeCompletionQuality(records, "live")
    summary.actualCompletionBackend = "direct-qwen"
    variantResults[variant] = { summary, records, output }
    writeDirectAblationDump({ records, summary, output, config })
  }

  const reportPath = resolve(options.report ?? "docs/completion-p2-direct-qwen-ablation-report.md")
  writeFileSync(reportPath, directAblationMarkdownReport({
    config,
    baseline: variantResults.baseline,
    p2Evidence: variantResults["p2-evidence"],
  }))

  const records = variants.flatMap((variant) => variantResults[variant]?.records ?? [])
  const summary = directAblationConsoleSummary({
    config,
    baseline: variantResults.baseline,
    p2Evidence: variantResults["p2-evidence"],
    reportPath,
  })
  return { summary, records, variants: variantResults, reportPath }
}

async function runDirectQwenAblationFixture(input: {
  fixture: CompletionQualityFixture
  settings: RemoteSettings
  apiKey?: string
  variant: DirectQwenAblationVariant
  config: DirectQwenConfig
  timeoutMs: number
}): Promise<CompletionQualityRecord> {
  const started = Date.now()
  const document = fakeTextDocument(input.fixture)
  const position = positionAt(document.text, input.fixture.prefix.length)
  const editInput = completionEditInput(document, position)
  const initialPlan = planCompletion({
    ...editInput,
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
    nextNonEmptyLine: nextNonEmptyLineAfter(document.lines, position.line),
    lines: document.lines,
    line: position.line,
    triggerKind: input.fixture.cursorContext.triggerKind,
  })
  const codeGraph = fixtureCodeGraphProvider(input.fixture, document.text)
  const retrievedSnippets = await retrieveDirectAblationSnippets({
    codeGraph,
    document: document.vscodeDocument,
    plan: initialPlan,
    editInput,
  })
  const resolvedPlan = resolveCompletionPlanAfterSymbolRetrieval(initialPlan, retrievedSnippets)
  const route = routeCompletionModel({
    plan: resolvedPlan,
    settings: input.settings,
    retrievedSnippets,
  })
  const actualIntent = completionIntentValue(resolvedPlan)
  let prompt = ""
  let selectedContextText = ""
  let contextPack: CompletionContextPack | undefined
  let evidenceResult: CEmbeddedCompletionEvidenceResult | undefined
  let baselineEvidence: QueryEvidenceResult | undefined
  let analysisEvidenceText = ""
  let retrievalMode = retrievedSnippets.length > 0 ? "graph-only" : "none"
  let evidenceKindValues: string[] = []

  if (route.kind === "model") {
    const context = await import("../src/context")
    const evidence = await directAblationAnalysisEvidence({
      variant: input.variant,
      codeGraph,
      document: document.vscodeDocument,
      position,
      settings: input.settings,
      plan: resolvedPlan,
      retrievedSnippets,
    })
    analysisEvidenceText = evidence.text
    evidenceResult = evidence.cEmbedded
    baselineEvidence = evidence.baseline
    retrievalMode = mergeRetrievalModeForBenchmark(retrievalMode, evidence.retrievalMode)
    evidenceKindValues = evidence.evidenceKinds
    const onContextPack = (pack: CompletionContextPack) => {
      contextPack = pack
      selectedContextText = pack.selected.map((block) => block.text).join("\n")
    }
    if (route.promptKind === "qwen-fim") {
      prompt = context.buildQwenCoderFimPrompt({
        document: document.vscodeDocument,
        position,
        settings: input.settings,
        plan: resolvedPlan,
        retrievedSnippets,
        analysisEvidenceText,
        onContextPack,
      })
    } else {
      prompt = await context.buildCompletionPrompt({
        document: document.vscodeDocument,
        position,
        settings: input.settings,
        transport: input.config.transport === "raw-completions" ? "openai-compatible" : undefined,
        plan: resolvedPlan,
        retrievedSnippets,
        analysisEvidenceText,
        onContextPack,
      })
    }
  }

  const rawText = await rawModelOutput({
    fixture: input.fixture,
    settings: input.settings,
    apiKey: input.apiKey,
    mock: false,
    route,
    prompt,
    timeoutMs: input.timeoutMs,
    transport: input.config.transport,
    seed: input.config.seed,
    maxTokens: input.config.maxTokens,
    temperature: input.config.temperature,
  })
  const pipeline = runCompletionCandidatePipeline({
    rawText,
    textProfile: route.kind === "model" ? route.textProfile : route.kind === "deterministic-symbol" ? route.textProfile : input.settings.completion.profile,
    editInput,
    plan: resolvedPlan,
    retrievedSnippets,
    documentSuffix: input.fixture.suffix,
  })
  const finalInsert = pipeline.edit?.insertText ?? pipeline.editText
  const selectedEvidence = selectedEvidenceBlocks(prompt, {
    selectedContextBlocks: contextPack?.selected.map((block) => ({
      kind: block.kind,
      title: block.title,
      path: block.filePath,
      score: block.score,
      tokenEstimate: block.tokenEstimate,
    })),
  } as CompletionDebugEvent)
  const promptEvidence = promptEvidenceStats(selectedEvidence)
  const evidenceText = [selectedContextText, ...retrievedSnippets.map((snippet) => snippet.text)].join("\n")
  const rawOutputLength = rawText.length
  const finalInsertTextLength = finalInsert.length
  const promptEvidenceMatched = promptEvidenceMatch(prompt, promptEvidence.kinds)
  const record: CompletionQualityRecord = {
    name: input.fixture.name,
    file: input.fixture.file,
    scenario: input.fixture.cursorContext.scenario ?? inferredScenario(input.fixture.name),
    languageId: input.fixture.languageId,
    expectedIntent: input.fixture.expectedIntent,
    actualIntent,
    planKind: resolvedPlan.kind,
    cIntent: resolvedPlan.cIntent,
    routeKind: route.kind,
    promptKind: route.kind === "model" ? route.promptKind : route.kind,
    visible: finalInsert.trim().length > 0 && pipeline.decision === "accepted",
    groundedSymbol: groundedSymbolMatch(finalInsert, input.fixture, document.text, evidenceText),
    forbidden: input.fixture.forbiddenPatterns.some((pattern) => matchesPattern(finalInsert, pattern) || matchesPattern(rawText, pattern)),
    intentMatch: normalizeIntent(input.fixture.expectedIntent) === normalizeIntent(actualIntent),
    styleMatch: styleMatch(finalInsert, input.fixture, editInput),
    retrievalHit: retrievalHit(input.fixture, evidenceText || prompt),
    promptTokenCount: approximateTokenCount(prompt),
    latencyMs: Date.now() - started,
    rawModelOutputSample: truncateSample(rawText),
    finalInsertTextSample: truncateSample(finalInsert),
    rejectReason: pipeline.rejectionReason,
    evidenceKinds: evidenceKindValues.length ? evidenceKindValues : evidenceKinds(contextPack),
    contextLevel: contextLevel(contextPack),
    contextWarnings: contextWarnings(contextPack),
    retrievalMode,
    actualCompletionBackend: "direct-qwen",
    ablationVariant: input.variant,
    transport: input.config.transport,
    model: input.config.model,
    promptEvidenceMatched,
    evidencePromptBlocks: promptEvidence.blocks,
    evidencePromptTokens: promptEvidence.tokens,
    evidencePromptKinds: promptEvidence.kinds,
    protocolArtifact: hasProtocolArtifact(rawText) || hasProtocolArtifact(finalInsert),
    rawOutputLength,
    finalInsertTextLength,
    retrievalPolicy: resolvedPlan.retrievalPolicy,
    domainHints: resolvedPlan.domainHints,
    finalPrompt: prompt,
    rawModelOutput: rawText,
    finalInsertText: finalInsert,
    postprocessReason: pipeline.rejectionReason ?? pipeline.postprocessDebug.stripReason ?? pipeline.reasons.at(-1),
    selectedEvidence,
    retrievalTrace: codeGraph.trace,
    cEmbeddedEvidenceTrace: evidenceResult?.trace,
    normalizedCommentTokens: evidenceResult?.trace.normalizedCommentTokens,
    candidateTokenCoverage: evidenceResult?.trace.candidateTokenCoverage,
    semanticCandidateTopK: evidenceResult?.trace.semanticCandidateTopK,
    selectedSimilarFunctionNames: evidenceResult?.trace.selectedSimilarFunctionNames,
    correctFunctionInCandidates: correctFunctionInCandidates(input.fixture, evidenceResult?.trace),
    retrievalElapsedMs: evidenceResult?.trace.retrievalElapsedMs,
    retrievalBudgetMs: evidenceResult?.trace.retrievalBudgetMs,
    retrievalTimedOut: evidenceResult?.trace.retrievalTimedOut,
    timeoutStage: evidenceResult?.trace.timeoutStage,
    qaAlignedEvidence: evidenceResult?.trace.qaAlignedEvidence,
    qaTopCandidate: evidenceResult?.trace.qaTopCandidate,
    completionTopCandidate: evidenceResult?.trace.completionTopCandidate,
    sharedTopCandidate: evidenceResult?.trace.sharedTopCandidate,
    qaRetrievalTopK: evidenceResult?.trace.qaRetrievalTopK,
    completionRetrievalTopK: evidenceResult?.trace.completionRetrievalTopK,
    alignmentReason: evidenceResult?.trace.alignmentReason,
    rerankEnabled: evidenceResult?.trace.rerankEnabled,
    ragAvailable: evidenceResult?.trace.ragAvailable,
    latencyBudgetMs: evidenceResult?.trace.latencyBudgetMs,
    maxEvidence: evidenceResult?.trace.maxEvidence,
    evidenceRoles: evidenceResult?.trace.evidenceRoles,
    generationModeHint: evidenceResult?.trace.generationModeHint,
    helperCallableConfidence: evidenceResult?.trace.helperCallableConfidence,
    callableHelperCandidates: evidenceResult?.trace.callableHelperCandidates,
    styleExampleCandidates: evidenceResult?.trace.styleExampleCandidates,
    qaStyleTopK: evidenceResult?.trace.qaStyleTopK,
    completionProjectionTopK: evidenceResult?.trace.completionProjectionTopK,
    droppedAlignedEvidence: evidenceResult?.trace.droppedAlignedEvidence,
    cursorContextFeatures: evidenceResult?.trace.cursorContextFeatures,
    fullRetrievalCandidateCount: evidenceResult?.trace.fullRetrievalCandidateCount,
    projectionCandidateCount: evidenceResult?.trace.projectionCandidateCount,
    retrievalShape: evidenceResult?.trace.retrievalShape,
    qaExactTopK: evidenceResult?.trace.qaExactTopK,
    qaExactSubmittedEvidence: evidenceResult?.trace.qaExactSubmittedEvidence,
    qaExactContextTopK: evidenceResult?.trace.qaExactContextTopK,
    semanticQueryText: evidenceResult?.trace.semanticQueryText,
    graphQuestionTextHash: evidenceResult?.trace.graphQuestionTextHash,
    semanticTopK: evidenceResult?.trace.semanticTopK,
    graphTopK: evidenceResult?.trace.graphTopK,
    mergedTopK: evidenceResult?.trace.mergedTopK,
    selectedPromptEvidenceNames: evidenceResult?.trace.selectedPromptEvidenceNames,
    rawSemanticTopK: evidenceResult?.trace.rawSemanticTopK,
    rawGraphTopK: evidenceResult?.trace.rawGraphTopK,
    mergedRetrievalTopK: evidenceResult?.trace.mergedRetrievalTopK,
    projectionTopK: evidenceResult?.trace.projectionTopK,
    projectedEvidenceNames: evidenceResult?.trace.projectedEvidenceNames,
    actualPromptEvidenceNames: evidenceResult?.trace.actualPromptEvidenceNames,
    droppedProjectedEvidenceNames: evidenceResult?.trace.droppedProjectedEvidenceNames,
    rawTop1Aligned: evidenceResult?.trace.rawTop1Aligned,
    retrievalRecallAligned: evidenceResult?.trace.retrievalRecallAligned,
    projectionSelectedStrongHelper: evidenceResult?.trace.projectionSelectedStrongHelper,
    promptContainsProjectedHelper: evidenceResult?.trace.promptContainsProjectedHelper,
    probeAffectsPrompt: evidenceResult?.trace.probeAffectsPrompt,
    probeCompleted: evidenceResult?.trace.probeCompleted,
    projectionToPromptDropReason: evidenceResult?.trace.projectionToPromptDropReason,
    submittedEvidenceNames: evidenceResult?.trace.submittedEvidenceNames,
    expectedSymbolInQaExactRetrieval: evidenceResult?.trace.expectedSymbolInQaExactRetrieval,
    expectedSymbolInFullRetrieval: evidenceResult?.trace.expectedSymbolInFullRetrieval,
    expectedSymbolInProjection: evidenceResult?.trace.expectedSymbolInProjection,
    expectedSymbolInPrompt: evidenceResult?.trace.expectedSymbolInPrompt,
    fullRetrievalProbeDumpPath: evidenceResult?.trace.fullRetrievalProbeDumpPath,
    failureReason: pipeline.rejectionReason,
  }
  if (input.variant === "baseline" && baselineEvidence?.evidencePack.text.trim()) {
    record.cEmbeddedEvidenceTrace = undefined
  }
  return record
}

async function retrieveDirectAblationSnippets(input: {
  codeGraph: CodeGraphContextProvider
  document: ReturnType<typeof fakeTextDocument>["vscodeDocument"]
  plan: CompletionPlan
  editInput: Omit<CompletionEditInput, "text">
}) {
  if (!shouldRetrieveCompletionSnippetsForPlan(input.plan, input.document.languageId)) return []
  const retrieval = completionRetrievalPlan({
    plan: input.plan,
    languageId: input.document.languageId,
    linePrefix: input.editInput.linePrefix,
    lineSuffix: input.editInput.lineSuffix,
    currentWord: input.editInput.currentWord,
  })
  const queries = uniqueNonEmpty([
    ...retrieval.queries,
    completionSymbolQueryForBenchmark(input.editInput),
  ]).slice(0, 4)
  if (queries.length === 0) return []
  const limit = completionSymbolRetrievalLimitForBenchmark(input.plan)
  const batches = await Promise.all(queries.map(async (query) => {
    const symbols = await input.codeGraph.findSymbols({
      query,
      relatedPath: relativePathForBenchmark(input.document.uri),
      limit,
    })
    const resolved = resolveSymbols({
      query,
      relatedPath: relativePathForBenchmark(input.document.uri),
      candidates: symbols.map(symbolCandidateFromCodeGraph),
      cursorLine: input.editInput.position.line + 1,
      preferNearbyAbove: input.plan.kind === "comment-symbol-reference",
      limit,
      unitTestTarget: input.plan.kind === "comment-to-test" || input.plan.kind === "natural-command",
    })
    return resolved.map(completionSnippetFromSymbol)
  }))
  return rankRetrievedSnippetsForBenchmark({
    snippets: batches.flat(),
    preferredKinds: retrieval.preferredKinds,
    limit,
  })
}

async function directAblationAnalysisEvidence(input: {
  variant: DirectQwenAblationVariant
  codeGraph: CodeGraphContextProvider
  document: ReturnType<typeof fakeTextDocument>["vscodeDocument"]
  position: { line: number; character: number }
  settings: RemoteSettings
  plan: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
}): Promise<{
  text: string
  retrievalMode: "none" | "graph-only" | "hybrid"
  evidenceKinds: string[]
  cEmbedded?: CEmbeddedCompletionEvidenceResult
  baseline?: QueryEvidenceResult
}> {
  if (!input.settings.codeGraph.enabled) return { text: "", retrievalMode: "none", evidenceKinds: [] }
  const lineText = input.document.lineAt(input.position.line).text
  const retrieval = completionRetrievalPlan({
    plan: input.plan,
    languageId: input.document.languageId,
    linePrefix: lineText.slice(0, input.position.character),
    lineSuffix: lineText.slice(input.position.character),
    currentWord: completionCurrentWordForBenchmark(lineText.slice(0, input.position.character)),
  })
  const question = completionEvidenceQuestionForBenchmark({
    document: input.document,
    position: input.position,
    plan: input.plan,
    retrievedSnippets: input.retrievedSnippets,
    retrievalEvidenceQuestion: retrieval.evidenceQuestion,
  })
  if (!question) return { text: "", retrievalMode: "none", evidenceKinds: [] }
  const relatedPaths = [relativePathForBenchmark(input.document.uri)]

  if (input.variant === "p2-evidence" && shouldBuildCEmbeddedCompletionEvidence(input.plan)) {
    const result = await buildCEmbeddedCompletionEvidence({
      codeGraph: input.codeGraph,
      plan: input.plan,
      question,
      relatedPaths,
      domainHints: input.plan.domainHints,
      prefix: documentPrefixForBenchmark(input.document, input.position),
      suffix: documentSuffixForBenchmark(input.document, input.position),
    })
    return {
      text: result.text.trim(),
      retrievalMode: result.retrievalMode,
      evidenceKinds: result.evidenceKinds,
      cEmbedded: result,
    }
  }

  const baseline = await input.codeGraph.queryEvidence(question, {
    retrievalMode: "graph-only",
    relatedPaths,
  })
  const text = baseline?.evidencePack.text.trim() ?? ""
  return {
    text,
    retrievalMode: text ? "graph-only" : "none",
    evidenceKinds: text ? ["analysis-evidence"] : [],
    baseline,
  }
}

function directQwenConfig(options: CompletionQualityBenchmarkOptions): DirectQwenConfig {
  const vscodeSettings = readVSCodeUserCompletionSettings()
  const deprecatedEnvUsed: string[] = []
  const apiBaseUrl = firstConfigValue([
    ["cli:apiBaseUrl", options.apiBaseUrl],
    ["env:COMPLETION_API_BASE_URL", process.env.COMPLETION_API_BASE_URL],
    ["vscode:opencode.remote.completion.apiBaseUrl", stringSetting(vscodeSettings, "opencode.remote.completion.apiBaseUrl")],
    ["deprecated-env:OPENCODE_COMPLETION_API_BASE_URL", deprecatedEnv("OPENCODE_COMPLETION_API_BASE_URL", deprecatedEnvUsed)],
  ])
  const model = firstConfigValue([
    ["cli:model", options.model],
    ["env:COMPLETION_MODEL", process.env.COMPLETION_MODEL],
    ["vscode:opencode.remote.completion.model", stringSetting(vscodeSettings, "opencode.remote.completion.model")],
    ["deprecated-env:OPENCODE_COMPLETION_MODEL", deprecatedEnv("OPENCODE_COMPLETION_MODEL", deprecatedEnvUsed)],
  ])
  const apiKey = firstConfigValue([
    ["cli:apiKey", options.apiKey],
    ["env:apiKeyEnv", options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined],
    ["env:COMPLETION_API_KEY", process.env.COMPLETION_API_KEY],
    ["deprecated-env:OPENCODE_COMPLETION_API_KEY", deprecatedEnv("OPENCODE_COMPLETION_API_KEY", deprecatedEnvUsed)],
    ["env:OPENAI_API_KEY", process.env.OPENAI_API_KEY],
  ])
  const transport = readCompletionTransport(options.transport ?? process.env.COMPLETION_TRANSPORT)
  const promptStyle = readPromptStyle(options.promptStyle ?? process.env.COMPLETION_PROMPT_STYLE)
  const maxTokens = readNumberConfig([
    options.maxTokens,
    process.env.COMPLETION_MAX_TOKENS,
    numberSetting(vscodeSettings, "opencode.remote.completion.maxTokens"),
  ], 128, 1, 4096)
  const topP = readNumberConfig([
    process.env.COMPLETION_TOP_P,
    numberSetting(vscodeSettings, "opencode.remote.completion.topP"),
  ], 1, 0, 1)
  return {
    apiBaseUrl,
    model,
    apiKey,
    transport,
    promptStyle,
    temperature: readNumberConfig([options.temperature, process.env.COMPLETION_TEMPERATURE], 0, 0, 2),
    maxTokens,
    topP,
    seed: optionalNumber(options.seed ?? process.env.COMPLETION_SEED),
    configSource: [
      apiBaseUrl ? "apiBaseUrl" : "",
      model ? "model" : "",
      apiKey ? "apiKey-present" : "apiKey-empty",
      `transport:${transport}`,
      `promptStyle:${promptStyle}`,
    ].filter(Boolean),
    deprecatedEnvUsed,
  }
}

function validateDirectQwenConfig(config: DirectQwenConfig) {
  const missing: string[] = []
  if (!config.apiBaseUrl) missing.push("COMPLETION_API_BASE_URL or VS Code opencode.remote.completion.apiBaseUrl")
  if (!config.model) missing.push("COMPLETION_MODEL or VS Code opencode.remote.completion.model")
  if (missing.length) {
    throw new Error(`Missing direct Qwen completion configuration: ${missing.join(", ")}. Configure VS Code direct completion settings or pass the COMPLETION_* environment variables.`)
  }
  if (config.promptStyle !== "qwen-fim") {
    throw new Error("P2.1 direct Qwen ablation requires COMPLETION_PROMPT_STYLE=qwen-fim.")
  }
}

function directQwenSettings(config: DirectQwenConfig): RemoteSettings {
  return {
    ...benchmarkSettings({
      apiBaseUrl: config.apiBaseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    }),
    defaultModel: config.model,
    completion: {
      ...benchmarkSettings({ apiBaseUrl: config.apiBaseUrl, model: config.model }).completion,
      enabled: true,
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: config.apiBaseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
      debounceMs: 0,
      logLevel: "off",
      debugFullRetrievalProbe: false,
      debugExpectedSymbol: "",
      commentGuidedRetrievalMode: "qa-exact",
    },
    codeGraph: {
      ...benchmarkSettings({}).codeGraph,
      enabled: true,
    },
  }
}

function directAblationVariants(input: CompletionQualityBenchmarkOptions["ablationVariant"]) {
  if (input === "baseline") return ["baseline"] as DirectQwenAblationVariant[]
  if (input === "p2-evidence") return ["p2-evidence"] as DirectQwenAblationVariant[]
  return ["baseline", "p2-evidence"] as DirectQwenAblationVariant[]
}

function prepareDirectAblationOutput(rootPath: string, variant: DirectQwenAblationVariant) {
  const root = resolve(rootPath, variant === "baseline" ? "direct-baseline" : "direct-p2-evidence")
  const promptsDir = join(root, "latest-prompts")
  const evidenceDir = join(root, "latest-evidence")
  const rawDir = join(root, "raw-model-output")
  const finalDir = join(root, "final-insert-text")
  resetDirectory(promptsDir)
  resetDirectory(evidenceDir)
  resetDirectory(rawDir)
  resetDirectory(finalDir)
  return {
    root,
    promptsDir,
    evidenceDir,
    rawDir,
    finalDir,
    reportPath: join(root, "latest-report.json"),
  }
}

function writeDirectAblationDump(input: {
  records: CompletionQualityRecord[]
  summary: CompletionQualitySummary
  output: DirectAblationOutput
  config: DirectQwenConfig
}) {
  const reportRecords: CompletionQualityLatestReportRecord[] = []
  for (const record of input.records) {
    const slug = fixtureSlug(record.name)
    const promptPath = join(input.output.promptsDir, `${slug}.txt`)
    const evidencePath = join(input.output.evidenceDir, `${slug}.json`)
    const rawPath = join(input.output.rawDir, `${slug}.txt`)
    const finalPath = join(input.output.finalDir, `${slug}.txt`)
    writeFileSync(promptPath, promptDumpText(record))
    writeFileSync(evidencePath, `${JSON.stringify(evidenceDump(record), null, 2)}\n`)
    writeFileSync(rawPath, record.rawModelOutput ?? "")
    writeFileSync(finalPath, record.finalInsertText ?? "")
    reportRecords.push({
      fixtureName: record.name,
      actualCompletionBackend: record.actualCompletionBackend,
      ablationVariant: record.ablationVariant,
      actualPlanKind: record.planKind,
      actualCIntent: record.cIntent,
      retrievalMode: record.retrievalMode ?? "none",
      evidenceKinds: record.evidenceKinds,
      selectedEvidenceCount: record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount ?? record.selectedEvidence?.length ?? 0,
      contextLevel: record.contextLevel,
      contextWarnings: record.contextWarnings,
      promptKind: record.promptKind,
      transport: record.transport,
      model: record.model,
      promptTokenEstimate: record.promptTokenCount,
      finalPromptPath: relative(process.cwd(), promptPath),
      finalEvidencePath: relative(process.cwd(), evidencePath),
      retrievalPolicy: record.retrievalPolicy,
      domainHints: record.domainHints,
      mockVisibleCandidate: record.finalInsertTextSample,
      rawOutputPath: relative(process.cwd(), rawPath),
      finalInsertPath: relative(process.cwd(), finalPath),
      rawOutputLength: record.rawOutputLength,
      finalInsertTextLength: record.finalInsertTextLength,
      promptEvidenceMatched: record.promptEvidenceMatched,
      evidencePromptBlocks: record.evidencePromptBlocks,
      evidencePromptTokens: record.evidencePromptTokens,
      evidencePromptKinds: record.evidencePromptKinds,
      protocolArtifact: record.protocolArtifact,
      failureReason: record.failureReason ?? record.rejectReason,
      ragFallbackTriggered: record.cEmbeddedEvidenceTrace?.ragFallbackTriggered,
      ragFallbackReason: record.cEmbeddedEvidenceTrace?.ragFallbackReason,
      graphEvidenceCount: record.cEmbeddedEvidenceTrace?.graphEvidenceCount,
      ragEvidenceCount: record.cEmbeddedEvidenceTrace?.ragEvidenceCount,
      finalSelectedEvidenceCount: record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount,
      normalizedCommentTokens: record.normalizedCommentTokens,
      candidateTokenCoverage: record.candidateTokenCoverage,
      semanticCandidateTopK: record.semanticCandidateTopK,
      selectedSimilarFunctionNames: record.selectedSimilarFunctionNames,
      correctFunctionInCandidates: record.correctFunctionInCandidates,
      retrievalElapsedMs: record.retrievalElapsedMs,
      retrievalBudgetMs: record.retrievalBudgetMs,
      retrievalTimedOut: record.retrievalTimedOut,
      timeoutStage: record.timeoutStage,
      qaAlignedEvidence: record.qaAlignedEvidence,
      qaTopCandidate: record.qaTopCandidate,
      completionTopCandidate: record.completionTopCandidate,
      sharedTopCandidate: record.sharedTopCandidate,
      qaRetrievalTopK: record.qaRetrievalTopK,
      completionRetrievalTopK: record.completionRetrievalTopK,
      alignmentReason: record.alignmentReason,
      rerankEnabled: record.rerankEnabled,
      ragAvailable: record.ragAvailable,
      latencyBudgetMs: record.latencyBudgetMs,
      maxEvidence: record.maxEvidence,
      evidenceRoles: record.evidenceRoles,
      generationModeHint: record.generationModeHint,
      helperCallableConfidence: record.helperCallableConfidence,
      callableHelperCandidates: record.callableHelperCandidates,
      styleExampleCandidates: record.styleExampleCandidates,
      qaStyleTopK: record.qaStyleTopK,
      completionProjectionTopK: record.completionProjectionTopK,
      droppedAlignedEvidence: record.droppedAlignedEvidence,
      cursorContextFeatures: record.cursorContextFeatures,
      fullRetrievalCandidateCount: record.fullRetrievalCandidateCount,
      projectionCandidateCount: record.projectionCandidateCount,
      retrievalShape: record.retrievalShape,
      qaExactTopK: record.qaExactTopK,
      qaExactSubmittedEvidence: record.qaExactSubmittedEvidence,
      qaExactContextTopK: record.qaExactContextTopK,
      semanticQueryText: record.semanticQueryText,
      graphQuestionTextHash: record.graphQuestionTextHash,
      semanticTopK: record.semanticTopK,
      graphTopK: record.graphTopK,
      mergedTopK: record.mergedTopK,
      selectedPromptEvidenceNames: record.selectedPromptEvidenceNames,
      rawSemanticTopK: record.rawSemanticTopK,
      rawGraphTopK: record.rawGraphTopK,
      mergedRetrievalTopK: record.mergedRetrievalTopK,
      projectionTopK: record.projectionTopK,
      projectedEvidenceNames: record.projectedEvidenceNames,
      actualPromptEvidenceNames: record.actualPromptEvidenceNames,
      droppedProjectedEvidenceNames: record.droppedProjectedEvidenceNames,
      rawTop1Aligned: record.rawTop1Aligned,
      retrievalRecallAligned: record.retrievalRecallAligned,
      projectionSelectedStrongHelper: record.projectionSelectedStrongHelper,
      promptContainsProjectedHelper: record.promptContainsProjectedHelper,
      probeAffectsPrompt: record.probeAffectsPrompt,
      probeCompleted: record.probeCompleted,
      projectionToPromptDropReason: record.projectionToPromptDropReason,
      submittedEvidenceNames: record.submittedEvidenceNames,
      expectedSymbolInQaExactRetrieval: record.expectedSymbolInQaExactRetrieval,
      expectedSymbolInFullRetrieval: record.expectedSymbolInFullRetrieval,
      expectedSymbolInProjection: record.expectedSymbolInProjection,
      expectedSymbolInPrompt: record.expectedSymbolInPrompt,
      fullRetrievalProbeDumpPath: record.fullRetrievalProbeDumpPath,
    })
  }
  const report = {
    generatedAt: new Date().toISOString(),
    runMode: input.summary.run_mode,
    actualCompletionBackend: "direct-qwen",
    qualityMetricValid: input.summary.quality_metric_valid,
    metricNote: input.summary.metric_note,
    config: sanitizedDirectConfig(input.config),
    summary: input.summary,
    records: reportRecords,
  }
  writeFileSync(input.output.reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

function directAblationConsoleSummary(input: {
  config: DirectQwenConfig
  baseline?: DirectQwenAblationResult
  p2Evidence?: DirectQwenAblationResult
  reportPath: string
}) {
  return {
    run_mode: "live",
    actualCompletionBackend: "direct-qwen",
    quality_metric_valid: true,
    transport: input.config.transport,
    model: input.config.model,
    apiBaseUrl: input.config.apiBaseUrl,
    apiKey: input.config.apiKey ? "present" : "empty",
    deprecatedEnvUsed: input.config.deprecatedEnvUsed,
    baseline: input.baseline?.summary,
    p2_evidence: input.p2Evidence?.summary,
    reportPath: relative(process.cwd(), input.reportPath),
  }
}

function directAblationMarkdownReport(input: {
  config: DirectQwenConfig
  baseline?: DirectQwenAblationResult
  p2Evidence?: DirectQwenAblationResult
}) {
  const baseline = input.baseline
  const p2 = input.p2Evidence
  const pairs = pairedRecords(baseline?.records ?? [], p2?.records ?? [])
  const improvements = pairs.filter(({ baseline, p2 }) => recordScore(p2) > recordScore(baseline))
  const regressions = pairs.filter(({ baseline, p2 }) => recordScore(p2) < recordScore(baseline))
  const pollution = (p2?.records ?? []).filter(evidencePollution).slice(0, 8)
  const longPromptRegressions = pairs
    .filter(({ baseline, p2 }) => p2.promptTokenCount > baseline.promptTokenCount + 600 && recordScore(p2) < recordScore(baseline))
    .slice(0, 8)
  return [
    "# P2 Direct Qwen Coder Ablation Report",
    "",
    "## 1. Direct Qwen API Configuration",
    "",
    `- actualCompletionBackend: direct-qwen`,
    `- apiBaseUrl: ${input.config.apiBaseUrl}`,
    `- model: ${input.config.model}`,
    `- apiKey: ${input.config.apiKey ? "present (redacted)" : "not configured"}`,
    `- transport: ${input.config.transport}`,
    `- promptStyle: ${input.config.promptStyle}`,
    `- temperature: ${input.config.temperature}`,
    `- maxTokens: ${input.config.maxTokens}`,
    `- topP: ${input.config.topP}`,
    input.config.seed !== undefined ? `- seed: ${input.config.seed}` : "",
    input.config.deprecatedEnvUsed.length ? `- deprecatedEnvUsed: ${input.config.deprecatedEnvUsed.join(", ")}` : "",
    "",
    "## 2. Baseline vs P2 Evidence Metrics",
    "",
    metricsComparisonTable(baseline?.summary, p2?.summary),
    "",
    "## 3. Intent Output Samples",
    "",
    intentSampleSections(pairs),
    "",
    "## 4. P2 Improvements",
    "",
    recordList(improvements.slice(0, 12), "No obvious P2 improvements were detected by the benchmark heuristics."),
    "",
    "## 5. P2 Regressions Or No Improvement",
    "",
    recordList(regressions.slice(0, 12), "No obvious P2 regressions were detected by the benchmark heuristics."),
    "",
    "## 6. Evidence Pollution Check",
    "",
    pollution.length
      ? pollution.map((record) => `- ${record.name}: ${oneLine(record.finalInsertText ?? record.finalInsertTextSample)}`).join("\n")
      : "No obvious evidence/context marker leakage was detected in final insert text.",
    "",
    "## 7. Prompt Length Risk",
    "",
    longPromptRegressions.length
      ? longPromptRegressions.map(({ baseline, p2 }) => `- ${p2.name}: baselinePrompt=${baseline.promptTokenCount}, p2Prompt=${p2.promptTokenCount}, baseline=${recordOutcome(baseline)}, p2=${recordOutcome(p2)}`).join("\n")
      : "No prompt-length regression was detected by the current heuristic.",
    "",
    "## 8. Next Recommendation",
    "",
    nextRecommendation({ improvements, regressions, pollution, longPromptRegressions }),
    "",
  ].filter((line) => line !== "").join("\n")
}

function metricsComparisonTable(baseline?: CompletionQualitySummary, p2?: CompletionQualitySummary) {
  const rows: Array<[string, string, string]> = [
    ["visible_rate", metricValue(baseline?.visible_rate), metricValue(p2?.visible_rate)],
    ["grounded_symbol_rate", metricValue(baseline?.grounded_symbol_rate), metricValue(p2?.grounded_symbol_rate)],
    ["forbidden_rate", metricValue(baseline?.forbidden_rate), metricValue(p2?.forbidden_rate)],
    ["intent_match_rate", metricValue(baseline?.intent_match_rate), metricValue(p2?.intent_match_rate)],
    ["promptEvidenceMatched", metricValue(baseline?.promptEvidenceMatched), metricValue(p2?.promptEvidenceMatched)],
    ["prompt_token_count.avg", metricValue(baseline?.prompt_token_count.avg), metricValue(p2?.prompt_token_count.avg)],
    ["raw_output_length.avg", metricValue(baseline?.raw_output_length?.avg), metricValue(p2?.raw_output_length?.avg)],
    ["final_insert_text_length.avg", metricValue(baseline?.final_insert_text_length?.avg), metricValue(p2?.final_insert_text_length?.avg)],
    ["latency_ms.avg", metricValue(baseline?.latency_ms.avg), metricValue(p2?.latency_ms.avg)],
    ["qwen_fim.count", metricValue(baseline?.qwen_fim.count), metricValue(p2?.qwen_fim.count)],
    ["deterministic_symbol.count", metricValue(baseline?.deterministic_symbol.count), metricValue(p2?.deterministic_symbol.count)],
    ["selected_evidence_count.avg", metricValue(baseline?.qwen_fim.selected_evidence_count.avg), metricValue(p2?.qwen_fim.selected_evidence_count.avg)],
  ]
  return [
    "| metric | baseline | p2-evidence |",
    "| --- | ---: | ---: |",
    ...rows.map(([name, left, right]) => `| ${name} | ${left} | ${right} |`),
  ].join("\n")
}

function intentSampleSections(pairs: Array<{ name: string; baseline: CompletionQualityRecord; p2: CompletionQualityRecord }>) {
  const targets: Array<[string, number]> = [
    ["member-access", 4],
    ["call-args", 4],
    ["initializer", 4],
    ["error-path", 4],
    ["state-machine", 2],
    ["mmio-register", 2],
  ]
  const sections: string[] = []
  for (const [intent, count] of targets) {
    const selected = pairs.filter(({ p2 }) => p2.cIntent === intent || p2.expectedIntent === intent || p2.scenario === intent).slice(0, count)
    sections.push(`### ${intent}`)
    if (selected.length === 0) {
      sections.push("No sample available.")
      continue
    }
    for (const pair of selected) {
      sections.push([
        `- ${pair.name}`,
        `  - baseline: ${oneLine(pair.baseline.finalInsertText ?? pair.baseline.finalInsertTextSample)}`,
        `  - p2-evidence: ${oneLine(pair.p2.finalInsertText ?? pair.p2.finalInsertTextSample)}`,
        `  - evidenceKinds: ${(pair.p2.evidenceKinds ?? []).join(", ") || "none"}`,
      ].join("\n"))
    }
  }
  return sections.join("\n\n")
}

function pairedRecords(baseline: CompletionQualityRecord[], p2: CompletionQualityRecord[]) {
  const byName = new Map(baseline.map((record) => [record.name, record]))
  return p2.flatMap((record) => {
    const left = byName.get(record.name)
    return left ? [{ name: record.name, baseline: left, p2: record }] : []
  })
}

function recordList(pairs: Array<{ name: string; baseline: CompletionQualityRecord; p2: CompletionQualityRecord }>, empty: string) {
  if (pairs.length === 0) return empty
  return pairs.map(({ name, baseline, p2 }) => `- ${name}: baseline=${recordOutcome(baseline)}, p2=${recordOutcome(p2)}, evidence=${p2.evidenceKinds.join(",") || "none"}`).join("\n")
}

function recordScore(record: CompletionQualityRecord) {
  return [
    record.visible ? 2 : 0,
    record.groundedSymbol ? 2 : 0,
    record.styleMatch ? 1 : 0,
    record.forbidden ? -3 : 0,
  ].reduce((sum, value) => sum + value, 0)
}

function recordOutcome(record: CompletionQualityRecord) {
  return [
    record.visible ? "visible" : "not-visible",
    record.groundedSymbol ? "grounded" : "ungrounded",
    record.forbidden ? "forbidden" : "allowed",
  ].join("/")
}

function evidencePollution(record: CompletionQualityRecord) {
  const text = record.finalInsertText ?? record.finalInsertTextSample
  return /<context_block|<\/repo_context>|evidence kind|source path|domainBoost|retrievalMode|c-(?:base-type|struct-definition|call-example)/i.test(text)
}

function nextRecommendation(input: {
  improvements: unknown[]
  regressions: unknown[]
  pollution: unknown[]
  longPromptRegressions: unknown[]
}) {
  if (input.pollution.length) return "Fix evidence formatting/packing before prompt v2; model output is leaking evidence metadata."
  if (input.longPromptRegressions.length) return "Tune evidence selection and parser precision before prompt v2; prompt length appears to hurt some outputs."
  if (input.regressions.length > input.improvements.length) return "Prioritize fixing parser/query evidence ranking before prompt v2."
  if (input.improvements.length) return "P2 evidence is helping; continue refining evidence ranking, then proceed to prompt v2 experiments."
  return "No clear quality delta yet; add more real fixtures and inspect parser/query recall before prompt v2."
}

function metricValue(value: number | undefined) {
  return value === undefined ? "n/a" : String(value)
}

function oneLine(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 220) || "<empty>"
}

function promptEvidenceMatch(prompt: string, evidenceKinds: string[]) {
  if (evidenceKinds.length === 0) return false
  return evidenceKinds.every((kind) => prompt.includes(kind))
}

function promptEvidenceStats(blocks: DumpEvidenceBlock[]) {
  const evidence = blocks.filter((block) => block.kind === "c-embedded-evidence" || block.kind === "analysis-evidence")
  return {
    blocks: evidence.length,
    tokens: evidence.reduce((sum, block) => sum + block.tokenEstimate, 0),
    kinds: uniqueNonEmpty(evidence.map((block) => block.kind === "c-embedded-evidence" ? block.title.split(":")[0]?.trim() || block.kind : block.kind)),
  }
}

function hasProtocolArtifact(text: string | undefined) {
  const value = text?.trimStart() ?? ""
  if (!value) return false
  if (/^<\/?(?:tool_call|tool_calls|function_call|tool_response|assistant_response)\b/i.test(value)) return true
  if (/^<tool\b/i.test(value) && /<\/tool\b/i.test(value)) return true
  if (/^\{[\s\S]{0,200}"(?:tool_call|tool_calls|function_call)"\s*:/i.test(value)) return true
  if (/^\{[\s\S]{0,200}"name"\s*:\s*"[^"]+"[\s\S]{0,200}"arguments"\s*:/i.test(value)) return true
  return false
}

function mergeRetrievalModeForBenchmark(left: string | undefined, right: string | undefined) {
  if (left === "hybrid" || right === "hybrid") return "hybrid"
  if (left === "graph-only" || right === "graph-only") return "graph-only"
  return "none"
}

function completionSymbolQueryForBenchmark(input: Omit<CompletionEditInput, "text">) {
  if (input.currentWord && input.currentWord.length >= 2) return input.currentWord
  const identifiers = input.linePrefix.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  return identifiers
    .filter((identifier) => !new Set(["unit", "test", "unittest", "for", "of", "to", "function"]).has(identifier.toLowerCase()))
    .at(-1)
}

function completionCurrentWordForBenchmark(linePrefix: string) {
  return /\b[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)?.[0]
}

function completionSymbolRetrievalLimitForBenchmark(plan: CompletionPlan) {
  if (plan.kind === "comment-symbol-reference") return 50
  return plan.needsTestRetrieval ? 30 : 8
}

function rankRetrievedSnippetsForBenchmark(input: {
  snippets: RetrievedCompletionSnippet[]
  preferredKinds?: CompletionRetrievalPreferredKind[]
  limit: number
}) {
  const byKey = new Map<string, RetrievedCompletionSnippet>()
  for (const snippet of input.snippets) {
    const key = [snippet.kind, snippet.path, snippet.name ?? "", snippet.line].join("\0")
    const existing = byKey.get(key)
    if (!existing || snippetScoreForBenchmark(snippet, input.preferredKinds) > snippetScoreForBenchmark(existing, input.preferredKinds)) {
      byKey.set(key, snippet)
    }
  }
  return [...byKey.values()]
    .sort((left, right) =>
      snippetScoreForBenchmark(right, input.preferredKinds) - snippetScoreForBenchmark(left, input.preferredKinds) ||
      (left.path || "").localeCompare(right.path || "") ||
      (left.name || "").localeCompare(right.name || ""))
    .slice(0, Math.max(1, input.limit))
}

function snippetScoreForBenchmark(snippet: RetrievedCompletionSnippet, preferredKinds: CompletionRetrievalPreferredKind[] | undefined) {
  return (snippet.score ?? 0) + (preferredKinds?.includes(snippetPreferredKindForBenchmark(snippet)) ? 160 : 0)
}

function snippetPreferredKindForBenchmark(snippet: RetrievedCompletionSnippet): CompletionRetrievalPreferredKind {
  if (snippet.kind === "type" || snippet.kind === "macro" || snippet.kind === "function" || snippet.kind === "global" || snippet.kind === "field") return snippet.kind
  if (/macro/i.test(snippet.kind)) return "macro"
  if (/type|struct|union|enum|typedef/i.test(snippet.kind)) return "type"
  if (/field|member/i.test(snippet.kind)) return "field"
  if (/global|variable/i.test(snippet.kind)) return "global"
  return "function"
}

function completionEvidenceQuestionForBenchmark(input: {
  document: ReturnType<typeof fakeTextDocument>["vscodeDocument"]
  position: { line: number; character: number }
  plan: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
  retrievalEvidenceQuestion?: string
}) {
  const lineText = input.document.lineAt(input.position.line).text.trim()
  const functionName = cLikeFunctionNameNearPositionForBenchmark(input.document, input.position)
  const symbols = uniqueNonEmpty([
    input.plan.targetSymbol,
    ...input.retrievedSnippets.map((snippet) => snippet.name),
  ]).slice(0, 8)
  return [
    `inline completion for ${input.document.languageId} file ${relativePathForBenchmark(input.document.uri)}`,
    `current-path: ${relativePathForBenchmark(input.document.uri)}`,
    `plan ${input.plan.kind}`,
    input.plan.cIntent ? `completion-intent: ${input.plan.cIntent}` : "",
    functionName ? `function: ${functionName}` : "",
    symbols.length ? `symbols ${symbols.join(" ")}` : "",
    symbols.length ? `symbols: ${symbols.join(" ")}` : "",
    input.plan.sourceComment ? `comment ${input.plan.sourceComment}` : "",
    input.retrievalEvidenceQuestion,
    lineText ? `cursor line ${lineText}` : "",
  ].filter(Boolean).join("\n")
}

function documentPrefixForBenchmark(document: ReturnType<typeof fakeTextDocument>["vscodeDocument"], position: { line: number; character: number }) {
  const startLine = Math.max(0, position.line - 80)
  return document.getText({
    start: { line: startLine, character: 0 },
    end: position,
  })
}

function documentSuffixForBenchmark(document: ReturnType<typeof fakeTextDocument>["vscodeDocument"], position: { line: number; character: number }) {
  const endLine = Math.min(document.lineCount - 1, position.line + 60)
  return document.getText({
    start: position,
    end: { line: endLine, character: document.lineAt(endLine).text.length },
  })
}

function cLikeFunctionNameNearPositionForBenchmark(document: ReturnType<typeof fakeTextDocument>["vscodeDocument"], position: { line: number }) {
  if (document.languageId !== "c" && document.languageId !== "cpp") return ""
  const keywords = new Set(["if", "for", "while", "switch", "return", "sizeof"])
  for (let line = position.line; line >= Math.max(0, position.line - 80); line -= 1) {
    const text = document.lineAt(line).text
    const match = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*$/.exec(text) ??
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:\{|$)/.exec(text)
    const name = match?.[1]
    if (name && !keywords.has(name)) return name
  }
  return ""
}

function sanitizedDirectConfig(config: DirectQwenConfig) {
  return {
    actualCompletionBackend: "direct-qwen",
    apiBaseUrl: config.apiBaseUrl,
    model: config.model,
    apiKey: config.apiKey ? "present (redacted)" : "not configured",
    transport: config.transport,
    promptStyle: config.promptStyle,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    seed: config.seed,
    configSource: config.configSource,
    deprecatedEnvUsed: config.deprecatedEnvUsed,
  }
}

function readCompletionTransport(input: string | undefined): CompletionTransport {
  if (!input) return "raw-completions"
  if (input === "raw-completions" || input === "chat-completions") return input
  throw new Error(`Invalid COMPLETION_TRANSPORT=${input}. Expected raw-completions or chat-completions.`)
}

function readPromptStyle(input: string | undefined): "qwen-fim" {
  if (!input || input === "qwen-fim") return "qwen-fim"
  throw new Error(`Invalid COMPLETION_PROMPT_STYLE=${input}. P2.1 supports qwen-fim only.`)
}

function firstConfigValue(items: Array<[string, string | undefined]>) {
  for (const [_source, value] of items) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ""
}

function deprecatedEnv(name: string, used: string[]) {
  const value = process.env[name]
  if (value?.trim()) used.push(name)
  return value
}

function readNumberConfig(values: Array<number | string | undefined>, fallback: number, min: number, max: number) {
  for (const value of values) {
    const number = optionalNumber(value)
    if (number === undefined) continue
    return Math.max(min, Math.min(max, number))
  }
  return fallback
}

function optionalNumber(value: number | string | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key]
  return typeof value === "string" ? value : undefined
}

function numberSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key]
  return typeof value === "number" ? value : undefined
}

function readVSCodeUserCompletionSettings() {
  const settings: Record<string, unknown> = {}
  for (const file of vscodeUserSettingsPaths()) {
    if (!existsSync(file)) continue
    Object.assign(settings, parseJsoncObject(readFileSync(file, "utf8")))
  }
  return settings
}

function vscodeUserSettingsPaths() {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (!home) return []
  if (process.platform === "darwin") {
    return [
      join(home, "Library/Application Support/Code/User/settings.json"),
      join(home, "Library/Application Support/Code - Insiders/User/settings.json"),
    ]
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData/Roaming")
    return [
      join(appData, "Code/User/settings.json"),
      join(appData, "Code - Insiders/User/settings.json"),
    ]
  }
  return [
    join(home, ".config/Code/User/settings.json"),
    join(home, ".config/Code - Insiders/User/settings.json"),
  ]
}

function parseJsoncObject(text: string) {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(text)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stripJsonCommentsAndTrailingCommas(text: string) {
  let output = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === "\"") inString = false
      continue
    }
    if (char === "\"") {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      output += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 1
      continue
    }
    output += char
  }
  return output.replace(/,\s*([}\]])/g, "$1")
}

export function loadCompletionQualityFixtures(root: string) {
  const files = listJsonlFiles(root)
  const fixtures = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), index }))
      .filter((entry) => entry.line && !entry.line.startsWith("#"))
      .map((entry) => parseFixtureLine(file, entry.index + 1, entry.line)),
  )
  return fixtures
}

export function validateCompletionQualityFixture(fixture: CompletionQualityFixture) {
  const errors: string[] = []
  for (const key of ["name", "languageId", "file", "prefix", "suffix", "cursorContext", "expectedIntent", "expectedPatterns", "forbiddenPatterns", "mustUseExistingSymbols", "mustMatchLocalStyle"] as const) {
    if ((fixture as Record<string, unknown>)[key] === undefined) errors.push(`missing ${key}`)
  }
  if (!Array.isArray(fixture.expectedPatterns)) errors.push("expectedPatterns must be an array")
  if (!Array.isArray(fixture.forbiddenPatterns)) errors.push("forbiddenPatterns must be an array")
  if (!Array.isArray(fixture.mustUseExistingSymbols)) errors.push("mustUseExistingSymbols must be an array")
  if (typeof fixture.mustMatchLocalStyle !== "boolean" && !Array.isArray(fixture.mustMatchLocalStyle)) {
    errors.push("mustMatchLocalStyle must be a boolean or pattern array")
  }
  return errors
}

async function runCompletionQualityFixture(input: {
  fixture: CompletionQualityFixture
  settings: RemoteSettings
  apiKey?: string
  mock: boolean
  timeoutMs: number
}): Promise<CompletionQualityRecord> {
  if (input.mock) return runProviderDryRunCompletionQualityFixture(input.fixture, input.settings)
  return runDirectCompletionQualityFixture(input)
}

async function runDirectCompletionQualityFixture(input: {
  fixture: CompletionQualityFixture
  settings: RemoteSettings
  apiKey?: string
  mock: boolean
  timeoutMs: number
}): Promise<CompletionQualityRecord> {
  const started = Date.now()
  const document = fakeTextDocument(input.fixture)
  const position = positionAt(document.text, input.fixture.prefix.length)
  const editInput = completionEditInput(document, position)
  const plan = planCompletion({
    ...editInput,
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
    nextNonEmptyLine: nextNonEmptyLineAfter(document.lines, position.line),
    lines: document.lines,
    line: position.line,
    triggerKind: input.fixture.cursorContext.triggerKind,
  })
  const retrievedSnippets = input.fixture.retrievedSnippets ?? input.fixture.cursorContext.retrievedSnippets ?? []
  const resolvedPlan = resolveCompletionPlanAfterSymbolRetrieval(plan, retrievedSnippets)
  const route = routeCompletionModel({
    plan: resolvedPlan,
    settings: input.settings,
    retrievedSnippets,
  })
  const actualIntent = completionIntentValue(resolvedPlan)
  let prompt = ""
  let selectedContextText = ""
  let contextPack: CompletionContextPack | undefined

  if (route.kind === "model") {
    const context = await import("../src/context")
    const onContextPack = (pack: CompletionContextPack) => {
      contextPack = pack
      selectedContextText = pack.selected.map((block) => block.text).join("\n")
    }
    if (route.promptKind === "qwen-fim") {
      prompt = context.buildQwenCoderFimPrompt({
        document: document.vscodeDocument,
        position,
        settings: input.settings,
        plan: resolvedPlan,
        retrievedSnippets,
        onContextPack,
      })
    } else {
      prompt = await context.buildCompletionPrompt({
        document: document.vscodeDocument,
        position,
        settings: input.settings,
        transport: "openai-compatible",
        plan: resolvedPlan,
        retrievedSnippets,
        onContextPack,
      })
    }
  }

  const rawText = await rawModelOutput({
    fixture: input.fixture,
    settings: input.settings,
    apiKey: input.apiKey,
    mock: input.mock,
    route,
    prompt,
    timeoutMs: input.timeoutMs,
  })
  const pipeline = runCompletionCandidatePipeline({
    rawText,
    textProfile: route.kind === "model" ? route.textProfile : route.kind === "deterministic-symbol" ? route.textProfile : input.settings.completion.profile,
    editInput,
    plan: resolvedPlan,
    retrievedSnippets,
    documentSuffix: input.fixture.suffix,
  })
  const finalInsert = pipeline.edit?.insertText ?? pipeline.editText
  const evidenceText = [selectedContextText, ...retrievedSnippets.map((snippet) => snippet.text)].join("\n")
  const record: CompletionQualityRecord = {
    name: input.fixture.name,
    file: input.fixture.file,
    scenario: input.fixture.cursorContext.scenario ?? inferredScenario(input.fixture.name),
    languageId: input.fixture.languageId,
    expectedIntent: input.fixture.expectedIntent,
    actualIntent,
    planKind: resolvedPlan.kind,
    cIntent: resolvedPlan.cIntent,
    routeKind: route.kind,
    promptKind: route.kind === "model" ? route.promptKind : route.kind,
    visible: finalInsert.trim().length > 0 && pipeline.decision === "accepted",
    groundedSymbol: groundedSymbolMatch(finalInsert, input.fixture, document.text, evidenceText),
    forbidden: input.fixture.forbiddenPatterns.some((pattern) => matchesPattern(finalInsert, pattern) || matchesPattern(rawText, pattern)),
    intentMatch: normalizeIntent(input.fixture.expectedIntent) === normalizeIntent(actualIntent),
    styleMatch: styleMatch(finalInsert, input.fixture, editInput),
    retrievalHit: retrievalHit(input.fixture, evidenceText || prompt),
    promptTokenCount: approximateTokenCount(prompt),
    latencyMs: Date.now() - started,
    rawModelOutputSample: truncateSample(rawText),
    finalInsertTextSample: truncateSample(finalInsert),
    rejectReason: pipeline.rejectionReason,
    evidenceKinds: evidenceKinds(contextPack),
    contextLevel: contextLevel(contextPack),
    contextWarnings: contextWarnings(contextPack),
    retrievalMode: retrievedSnippets.length > 0 ? "fixture-snippets" : "none",
    retrievalPolicy: resolvedPlan.retrievalPolicy,
    domainHints: resolvedPlan.domainHints,
    finalPrompt: prompt,
    selectedEvidence: contextPack ? dumpEvidenceBlocksFromPack(contextPack) : [],
    retrievalTrace: {
      symbolQueries: [],
      evidenceQueries: [],
    },
    failureReason: pipeline.rejectionReason,
  }
  return record
}

function fakeRemoteClient(promptCapture: { prompt: string; rawOutput: string }) {
  return {
    createSession: async () => ({ id: "completion-quality-dry-run-session" }),
    sendMessage: async (input: { text: string }): Promise<OpenCodeMessage> => {
      promptCapture.prompt = input.text
      return modelMessage(promptCapture.rawOutput)
    },
  }
}

function fixtureCodeGraphProvider(fixture: CompletionQualityFixture, documentText: string) {
  const trace: CompletionQualityRetrievalTrace = {
    symbolQueries: [],
    evidenceQueries: [],
  }
  const index = miniCodeGraphIndex(fixture, documentText)
  const provider: CodeGraphContextProvider & { trace: CompletionQualityRetrievalTrace } = {
    trace,
    status: () => ({ state: "ready" } as ReturnType<CodeGraphContextProvider["status"]>),
    indexWorkspace: async () => undefined,
    cancelIndexing: () => undefined,
    pauseIndexing: () => undefined,
    resumeIndexing: () => undefined,
    cancelRagIndexing: () => undefined,
    pauseRagIndexing: () => undefined,
    resumeRagIndexing: () => undefined,
    metrics: () => ({}) as ReturnType<CodeGraphContextProvider["metrics"]>,
    waitForReady: async () => undefined,
    showStatus: async () => undefined,
    applyRagConfiguration: async () => ({
      action: "status-refreshed",
      status: { enabled: true } as Awaited<ReturnType<CodeGraphContextProvider["applyRagConfiguration"]>>["status"],
      hasReusableIndex: false,
    }),
    refreshRagConfiguration: async () => undefined,
    testRagConfiguration: async () => undefined,
    buildContext: async () => undefined,
    intelligenceSnapshot: async () => undefined,
    runAnalysisTool: async () => ({}),
    queryEvidence: async (question: string, options?: CodeGraphEvidenceQueryOptions) => {
      const result = await queryEvidenceAsync(index, question, {
        maxEvidenceItems: options?.maxEvidenceItems ?? 24,
        maxEvidenceBytes: options?.maxEvidenceBytes ?? 18000,
        maxFileSliceBytes: 6000,
        maxGraphEdges: 80,
        maxPaths: 8,
      }, undefined, options?.relatedPaths ?? [fixture.file])
      const text = result.evidencePack.text.trim()
      trace.evidenceQueries.push({
        question,
        retrievalMode: options?.retrievalMode ?? "graph-only",
        relatedPaths: options?.relatedPaths,
        resultBytes: text.length,
      })
      return result
    },
    findSymbols: async (input) => {
      const matches = searchCodeGraphSymbols({
        index,
        query: input.query,
        relatedPath: input.relatedPath,
        limit: input.limit,
      })
      trace.symbolQueries.push({
        query: input.query,
        relatedPath: input.relatedPath,
        limit: input.limit,
        resultCount: matches.length,
      })
      return matches
    },
  }
  return provider
}

function miniCodeGraphIndex(fixture: CompletionQualityFixture, documentText: string): CodeGraphIndex {
  const sources = [
    { file: fixture.file, text: documentText },
    ...(fixture.cursorContext.codeGraphFiles ?? []),
  ]
  const files = sources.map((source, index) => parseCFile({
    path: source.file,
    text: source.text,
    hash: `${fixture.name}:${index}`,
    size: source.text.length,
    indexedAt: 1,
  }))
  return hydrateCodeGraphIndex({
    version: 4,
    rootPath: "/completion-quality",
    rootName: "completion-quality",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  })
}

function latestTelemetry(lines: string[]): CompletionDebugEvent | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ""
    const marker = "[completion-telemetry] "
    const markerIndex = line.indexOf(marker)
    if (markerIndex < 0) continue
    try {
      return JSON.parse(line.slice(markerIndex + marker.length)) as CompletionDebugEvent
    } catch {
      continue
    }
  }
  return undefined
}

function selectedEvidenceBlocks(prompt: string, telemetry: CompletionDebugEvent | undefined): DumpEvidenceBlock[] {
  const blocks = parseContextBlocks(prompt)
  const telemetryBlocks = telemetry?.selectedContextBlocks ?? []
  return blocks.map((block, index) => ({
    ...block,
    score: telemetryBlocks[index]?.score ?? 0,
    tokenEstimate: telemetryBlocks[index]?.tokenEstimate ?? block.tokenEstimate,
  }))
}

function parseContextBlocks(prompt: string): DumpEvidenceBlock[] {
  const blocks: DumpEvidenceBlock[] = []
  const pattern = /<context_block\b([^>]*)>\n([\s\S]*?)\n<\/context_block>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt))) {
    const attrs = parseXmlAttrs(match[1] ?? "")
    blocks.push({
      kind: attrs.kind ?? "unknown",
      title: attrs.title ?? "context block",
      filePath: attrs.file,
      tokenEstimate: Number(attrs.tokens ?? 0) || 0,
      score: 0,
      text: match[2] ?? "",
    })
  }
  return blocks
}

function parseXmlAttrs(input: string) {
  const attrs: Record<string, string> = {}
  for (const match of input.matchAll(/\b([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attrs[match[1] ?? ""] = xmlUnescape(match[2] ?? "")
  }
  return attrs
}

function xmlUnescape(input: string) {
  return input
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function inlineInsertText(items: unknown) {
  const first = Array.isArray(items) ? items[0] : undefined
  const insertText = first && typeof first === "object" ? (first as { insertText?: unknown }).insertText : undefined
  return typeof insertText === "string" ? insertText : ""
}

function benchmarkOutputChannel() {
  const lines: string[] = []
  return {
    lines,
    appendLine: (line: string) => lines.push(line),
    append: (text: string) => lines.push(text),
    clear: () => {
      lines.length = 0
    },
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }
}

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  }
}

function triggerKindValue(kind: string | undefined) {
  return kind === "automatic" ? 1 : 0
}

function modelMessage(text: string): OpenCodeMessage {
  return {
    info: { id: "completion-quality-dry-run", role: "assistant", providerID: "fixture", modelID: "mock" },
    parts: [{ type: "text", text }],
  }
}

function mockOutputForFixture(fixture: CompletionQualityFixture) {
  return fixture.mockOutput ??
    fixture.cursorContext.mockOutput ??
    sampleFromPattern(fixture.expectedPatterns[0] ?? fixture.mustUseExistingSymbols[0] ?? "")
}

function contextLevelFromEvidence(blocks: DumpEvidenceBlock[]) {
  const tokens = blocks.reduce((sum, block) => sum + block.tokenEstimate, 0)
  if (tokens <= 0) return "none"
  if (tokens < 500) return "light"
  if (tokens < 1600) return "standard"
  return "rich"
}

function retrievalModeFromTrace(trace: CompletionQualityRetrievalTrace) {
  if (trace.evidenceQueries.some((query) => query.retrievalMode === "hybrid")) return "hybrid"
  if (trace.evidenceQueries.length > 0 || trace.symbolQueries.length > 0) return "graph-only"
  return "none"
}

async function runProviderDryRunCompletionQualityFixture(fixture: CompletionQualityFixture, baseSettings: RemoteSettings): Promise<CompletionQualityRecord> {
  const started = Date.now()
  const document = fakeTextDocument(fixture)
  const position = positionAt(document.text, fixture.prefix.length)
  const editInput = completionEditInput(document, position)
  const initialPlan = planCompletion({
    ...editInput,
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
    nextNonEmptyLine: nextNonEmptyLineAfter(document.lines, position.line),
    lines: document.lines,
    line: position.line,
    triggerKind: fixture.cursorContext.triggerKind,
  })
  vscodeShimState.textDocuments = [document.vscodeDocument]
  vscodeShimState.activeTextEditor = {
    document: document.vscodeDocument,
    options: {
      insertSpaces: true,
      tabSize: 4,
    },
  }
  vscodeShimState.visibleTextEditors = [vscodeShimState.activeTextEditor]

  const output = benchmarkOutputChannel()
  const promptCapture = {
    prompt: "",
    rawOutput: mockOutputForFixture(fixture),
  }
  const codeGraph = fixtureCodeGraphProvider(fixture, document.text)
  const settings: RemoteSettings = {
    ...baseSettings,
    defaultModel: baseSettings.defaultModel || "openai/qwen-coder-fim",
    completion: {
      ...baseSettings.completion,
      provider: "opencode",
      apiBaseUrl: "",
      model: baseSettings.completion.model || "qwen-coder-fim",
      logLevel: "debug",
      debounceMs: 0,
    },
    codeGraph: {
      ...baseSettings.codeGraph,
      enabled: true,
    },
  }
  const { RemoteCompletionProvider } = await import("../src/completion")
  const provider = new RemoteCompletionProvider({
    getClient: () => fakeRemoteClient(promptCapture),
    getSettings: () => settings,
    codeGraph,
    output,
  })
  const triggerKind = triggerKindValue(fixture.cursorContext.triggerKind)
  const items = await provider.provideInlineCompletionItems(
    document.vscodeDocument as never,
    position as never,
    { triggerKind } as never,
    cancellationToken() as never,
  )
  const telemetry = latestTelemetry(output.lines)
  const selectedEvidence = selectedEvidenceBlocks(promptCapture.prompt, telemetry)
  const promptEvidence = telemetry?.evidencePromptBlocks !== undefined
    ? {
        blocks: telemetry.evidencePromptBlocks ?? 0,
        tokens: telemetry.evidencePromptTokens ?? 0,
        kinds: telemetry.evidencePromptKinds ?? [],
      }
    : promptEvidenceStats(selectedEvidence)
  const itemInsert = inlineInsertText(items)
  const rawText = promptCapture.rawOutput
  const finalInsert = itemInsert || (telemetry?.filterText ?? "") || rawText
  const evidenceText = selectedEvidence.map((block) => block.text).join("\n")
  const actualPlanKind = telemetry?.planKind ?? "disabled"
  const actualCIntent = telemetry?.cIntent
  const promptKind = telemetry?.promptKind ?? "none"
  const record: CompletionQualityRecord = {
    name: fixture.name,
    file: fixture.file,
    scenario: fixture.cursorContext.scenario ?? inferredScenario(fixture.name),
    languageId: fixture.languageId,
    expectedIntent: fixture.expectedIntent,
    actualIntent: actualCIntent ?? actualPlanKind,
    planKind: actualPlanKind,
    cIntent: actualCIntent,
    routeKind: telemetry?.modelRoute ?? "none",
    promptKind,
    visible: itemInsert.trim().length > 0,
    groundedSymbol: groundedSymbolMatch(finalInsert, fixture, document.text, evidenceText),
    forbidden: fixture.forbiddenPatterns.some((pattern) => matchesPattern(finalInsert, pattern) || matchesPattern(rawText, pattern)),
    intentMatch: normalizeIntent(fixture.expectedIntent) === normalizeIntent(actualCIntent ?? actualPlanKind),
    styleMatch: styleMatch(finalInsert, fixture, editInput),
    retrievalHit: retrievalHit(fixture, evidenceText || promptCapture.prompt),
    promptTokenCount: approximateTokenCount(promptCapture.prompt),
    latencyMs: Date.now() - started,
    rawModelOutputSample: truncateSample(rawText),
    finalInsertTextSample: truncateSample(finalInsert),
    rejectReason: telemetry?.rejectReason,
    evidenceKinds: telemetry?.evidenceKinds ?? selectedEvidence.map((block) => block.kind),
    contextLevel: telemetry?.contextLevel ?? contextLevelFromEvidence(selectedEvidence),
    contextWarnings: telemetry?.contextWarnings,
    retrievalMode: telemetry?.retrievalMode ?? retrievalModeFromTrace(codeGraph.trace),
    evidencePromptBlocks: promptEvidence.blocks,
    evidencePromptTokens: promptEvidence.tokens,
    evidencePromptKinds: promptEvidence.kinds,
    promptEvidenceMatched: promptEvidenceMatch(promptCapture.prompt, promptEvidence.kinds),
    protocolArtifact: hasProtocolArtifact(rawText) || hasProtocolArtifact(finalInsert),
    retrievalPolicy: initialPlan.retrievalPolicy,
    domainHints: initialPlan.domainHints,
    finalPrompt: promptCapture.prompt,
    selectedEvidence,
    retrievalTrace: codeGraph.trace,
    cEmbeddedEvidenceTrace: telemetry?.cEmbeddedEvidenceTrace,
    normalizedCommentTokens: telemetry?.normalizedCommentTokens,
    candidateTokenCoverage: telemetry?.candidateTokenCoverage,
    semanticCandidateTopK: telemetry?.semanticCandidateTopK,
    selectedSimilarFunctionNames: telemetry?.selectedSimilarFunctionNames,
    correctFunctionInCandidates: correctFunctionInCandidates(fixture, telemetry),
    retrievalElapsedMs: telemetry?.retrievalElapsedMs,
    retrievalBudgetMs: telemetry?.retrievalBudgetMs,
    retrievalTimedOut: telemetry?.retrievalTimedOut,
    timeoutStage: telemetry?.timeoutStage,
    qaAlignedEvidence: telemetry?.qaAlignedEvidence,
    qaTopCandidate: telemetry?.qaTopCandidate,
    completionTopCandidate: telemetry?.completionTopCandidate,
    sharedTopCandidate: telemetry?.sharedTopCandidate,
    qaRetrievalTopK: telemetry?.qaRetrievalTopK,
    completionRetrievalTopK: telemetry?.completionRetrievalTopK,
    alignmentReason: telemetry?.alignmentReason,
    rerankEnabled: telemetry?.rerankEnabled,
    ragAvailable: telemetry?.ragAvailable,
    latencyBudgetMs: telemetry?.latencyBudgetMs,
    maxEvidence: telemetry?.maxEvidence,
    evidenceRoles: telemetry?.evidenceRoles,
    generationModeHint: telemetry?.generationModeHint,
    helperCallableConfidence: telemetry?.helperCallableConfidence,
    callableHelperCandidates: telemetry?.callableHelperCandidates,
    styleExampleCandidates: telemetry?.styleExampleCandidates,
    qaStyleTopK: telemetry?.qaStyleTopK,
    completionProjectionTopK: telemetry?.completionProjectionTopK,
    droppedAlignedEvidence: telemetry?.droppedAlignedEvidence,
    cursorContextFeatures: telemetry?.cursorContextFeatures,
    fullRetrievalCandidateCount: telemetry?.fullRetrievalCandidateCount,
    projectionCandidateCount: telemetry?.projectionCandidateCount,
    retrievalShape: telemetry?.retrievalShape,
    qaExactTopK: telemetry?.qaExactTopK,
    qaExactSubmittedEvidence: telemetry?.qaExactSubmittedEvidence,
    qaExactContextTopK: telemetry?.qaExactContextTopK,
    semanticQueryText: telemetry?.semanticQueryText,
    graphQuestionTextHash: telemetry?.graphQuestionTextHash,
    semanticTopK: telemetry?.semanticTopK,
    graphTopK: telemetry?.graphTopK,
    mergedTopK: telemetry?.mergedTopK,
    selectedPromptEvidenceNames: telemetry?.selectedPromptEvidenceNames,
    rawSemanticTopK: telemetry?.rawSemanticTopK,
    rawGraphTopK: telemetry?.rawGraphTopK,
    mergedRetrievalTopK: telemetry?.mergedRetrievalTopK,
    projectionTopK: telemetry?.projectionTopK,
    projectedEvidenceNames: telemetry?.projectedEvidenceNames,
    actualPromptEvidenceNames: telemetry?.actualPromptEvidenceNames,
    droppedProjectedEvidenceNames: telemetry?.droppedProjectedEvidenceNames,
    rawTop1Aligned: telemetry?.rawTop1Aligned,
    retrievalRecallAligned: telemetry?.retrievalRecallAligned,
    projectionSelectedStrongHelper: telemetry?.projectionSelectedStrongHelper,
    promptContainsProjectedHelper: telemetry?.promptContainsProjectedHelper,
    probeAffectsPrompt: telemetry?.probeAffectsPrompt,
    probeCompleted: telemetry?.probeCompleted,
    projectionToPromptDropReason: telemetry?.projectionToPromptDropReason,
    submittedEvidenceNames: telemetry?.submittedEvidenceNames,
    expectedSymbolInQaExactRetrieval: telemetry?.expectedSymbolInQaExactRetrieval,
    expectedSymbolInFullRetrieval: telemetry?.expectedSymbolInFullRetrieval,
    expectedSymbolInProjection: telemetry?.expectedSymbolInProjection,
    expectedSymbolInPrompt: telemetry?.expectedSymbolInPrompt,
    fullRetrievalProbeDumpPath: telemetry?.fullRetrievalProbeDumpPath,
    failureReason: telemetry?.rejectReason ?? (finalInsert ? undefined : "no-visible-inline-item"),
  }
  return record
}

async function rawModelOutput(input: {
  fixture: CompletionQualityFixture
  settings: RemoteSettings
  apiKey?: string
  mock: boolean
  route: ReturnType<typeof routeCompletionModel>
  prompt: string
  timeoutMs: number
  transport?: CompletionTransport
  seed?: number
  maxTokens?: number
  temperature?: number
}) {
  if (input.route.kind === "deterministic-symbol") return input.route.text
  if (input.route.kind === "none") return ""
  if (input.mock) {
    return input.fixture.mockOutput ??
      input.fixture.cursorContext.mockOutput ??
      sampleFromPattern(input.fixture.expectedPatterns[0] ?? input.fixture.mustUseExistingSymbols[0] ?? "")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const message = await new CompletionModelClient(input.settings, input.apiKey).complete({
      prompt: input.prompt,
      signal: controller.signal,
      maxTokens: input.maxTokens ?? input.route.maxTokens,
      temperature: input.temperature ?? input.route.temperature,
      topP: input.route.topP,
      profile: input.route.modelProfile,
      transport: input.transport,
      seed: input.seed,
    })
    return messageText(message)
  } finally {
    clearTimeout(timeout)
  }
}

export function summarizeCompletionQuality(
  records: CompletionQualityRecord[],
  runMode: CompletionQualitySummary["run_mode"] = "live",
): CompletionQualitySummary {
  const qualityMetricValid = runMode === "live"
  return {
    run_mode: runMode,
    quality_metric_valid: qualityMetricValid,
    metric_note: qualityMetricValid
      ? "Live model metrics reflect the configured completion model and benchmark fixtures."
      : "Mock dry-run metrics validate benchmark wiring, prompt/evidence dump, and candidate pipeline only; they are not model quality metrics.",
    visible_rate: rate(records, (record) => record.visible),
    grounded_symbol_rate: rate(records, (record) => record.groundedSymbol),
    forbidden_rate: rate(records, (record) => record.forbidden),
    intent_match_rate: rate(records, (record) => record.intentMatch),
    style_match_rate: rate(records, (record) => record.styleMatch),
    retrieval_hit_rate: rate(records, (record) => record.retrievalHit),
    promptEvidenceMatched: rate(records, (record) => Boolean(record.promptEvidenceMatched)),
    protocol_artifact_rate: rate(records, (record) => Boolean(record.protocolArtifact)),
    prompt_token_count: distribution(records.map((record) => record.promptTokenCount)),
    raw_output_length: distribution(records.map((record) => record.rawOutputLength ?? record.rawModelOutputSample.length)),
    final_insert_text_length: distribution(records.map((record) => record.finalInsertTextLength ?? record.finalInsertTextSample.length)),
    latency_ms: distribution(records.map((record) => record.latencyMs)),
    raw_model_output_sample: records.find((record) => record.rawModelOutputSample)?.rawModelOutputSample ?? "",
    final_insert_text_sample: records.find((record) => record.finalInsertTextSample)?.finalInsertTextSample ?? "",
    qwen_fim: pathSummary(records.filter((record) => record.promptKind === "qwen-fim" || record.routeKind === "fim")),
    deterministic_symbol: pathSummary(records.filter((record) => record.promptKind === "deterministic-symbol" || record.routeKind === "deterministic-symbol")),
  }
}

function pathSummary(records: CompletionQualityRecord[]): CompletionQualityPathSummary {
  return {
    count: records.length,
    visible_rate: rate(records, (record) => record.visible),
    grounded_symbol_rate: rate(records, (record) => record.groundedSymbol),
    forbidden_rate: rate(records, (record) => record.forbidden),
    intent_match_rate: rate(records, (record) => record.intentMatch),
    style_match_rate: rate(records, (record) => record.styleMatch),
    retrieval_hit_rate: rate(records, (record) => record.retrievalHit),
    selected_evidence_count: distribution(records.map((record) => record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount ?? record.selectedEvidence?.length ?? 0)),
  }
}

function prepareBenchmarkOutput(options: CompletionQualityBenchmarkOptions) {
  const root = resolve(options.outputDir ?? ".completion-quality")
  const promptsDir = join(root, "latest-prompts")
  const evidenceDir = join(root, "latest-evidence")
  if (options.dumpPrompts) resetDirectory(promptsDir)
  if (options.dumpEvidence) resetDirectory(evidenceDir)
  mkdirSync(root, { recursive: true })
  return {
    root,
    promptsDir,
    evidenceDir,
    reportPath: join(root, "latest-report.json"),
  }
}

function writeLatestDump(input: {
  records: CompletionQualityRecord[]
  summary: CompletionQualitySummary
  output: ReturnType<typeof prepareBenchmarkOutput>
  dumpPrompts: boolean
  dumpEvidence: boolean
}) {
  const reportRecords: CompletionQualityLatestReportRecord[] = []
  for (const record of input.records) {
    const slug = fixtureSlug(record.name)
    const promptPath = input.dumpPrompts ? join(input.output.promptsDir, `${slug}.txt`) : undefined
    const evidencePath = input.dumpEvidence ? join(input.output.evidenceDir, `${slug}.json`) : undefined
    if (promptPath) {
      writeFileSync(promptPath, promptDumpText(record))
    }
    if (evidencePath) {
      writeFileSync(evidencePath, `${JSON.stringify(evidenceDump(record), null, 2)}\n`)
    }
    reportRecords.push({
      fixtureName: record.name,
      actualPlanKind: record.planKind,
      actualCIntent: record.cIntent,
      retrievalMode: record.retrievalMode ?? "none",
      evidenceKinds: record.evidenceKinds,
      selectedEvidenceCount: record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount ?? record.selectedEvidence?.length ?? 0,
      contextLevel: record.contextLevel,
      contextWarnings: record.contextWarnings,
      promptKind: record.promptKind,
      promptTokenEstimate: record.promptTokenCount,
      finalPromptPath: promptPath ? relative(process.cwd(), promptPath) : undefined,
      finalEvidencePath: evidencePath ? relative(process.cwd(), evidencePath) : undefined,
      retrievalPolicy: record.retrievalPolicy,
      domainHints: record.domainHints,
      mockVisibleCandidate: record.finalInsertTextSample,
      promptEvidenceMatched: record.promptEvidenceMatched,
      evidencePromptBlocks: record.evidencePromptBlocks,
      evidencePromptTokens: record.evidencePromptTokens,
      evidencePromptKinds: record.evidencePromptKinds,
      protocolArtifact: record.protocolArtifact,
      failureReason: record.failureReason ?? record.rejectReason,
      ragFallbackTriggered: record.cEmbeddedEvidenceTrace?.ragFallbackTriggered,
      ragFallbackReason: record.cEmbeddedEvidenceTrace?.ragFallbackReason,
      graphEvidenceCount: record.cEmbeddedEvidenceTrace?.graphEvidenceCount,
      ragEvidenceCount: record.cEmbeddedEvidenceTrace?.ragEvidenceCount,
      finalSelectedEvidenceCount: record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount,
      normalizedCommentTokens: record.normalizedCommentTokens,
      candidateTokenCoverage: record.candidateTokenCoverage,
      semanticCandidateTopK: record.semanticCandidateTopK,
      selectedSimilarFunctionNames: record.selectedSimilarFunctionNames,
      correctFunctionInCandidates: record.correctFunctionInCandidates,
      retrievalElapsedMs: record.retrievalElapsedMs,
      retrievalBudgetMs: record.retrievalBudgetMs,
      retrievalTimedOut: record.retrievalTimedOut,
      timeoutStage: record.timeoutStage,
      qaAlignedEvidence: record.qaAlignedEvidence,
      qaTopCandidate: record.qaTopCandidate,
      completionTopCandidate: record.completionTopCandidate,
      sharedTopCandidate: record.sharedTopCandidate,
      qaRetrievalTopK: record.qaRetrievalTopK,
      completionRetrievalTopK: record.completionRetrievalTopK,
      alignmentReason: record.alignmentReason,
      rerankEnabled: record.rerankEnabled,
      ragAvailable: record.ragAvailable,
      latencyBudgetMs: record.latencyBudgetMs,
      maxEvidence: record.maxEvidence,
      evidenceRoles: record.evidenceRoles,
      generationModeHint: record.generationModeHint,
      helperCallableConfidence: record.helperCallableConfidence,
      callableHelperCandidates: record.callableHelperCandidates,
      styleExampleCandidates: record.styleExampleCandidates,
      qaStyleTopK: record.qaStyleTopK,
      completionProjectionTopK: record.completionProjectionTopK,
      droppedAlignedEvidence: record.droppedAlignedEvidence,
      cursorContextFeatures: record.cursorContextFeatures,
      fullRetrievalCandidateCount: record.fullRetrievalCandidateCount,
      projectionCandidateCount: record.projectionCandidateCount,
      retrievalShape: record.retrievalShape,
      qaExactTopK: record.qaExactTopK,
      qaExactSubmittedEvidence: record.qaExactSubmittedEvidence,
      qaExactContextTopK: record.qaExactContextTopK,
      semanticQueryText: record.semanticQueryText,
      graphQuestionTextHash: record.graphQuestionTextHash,
      semanticTopK: record.semanticTopK,
      graphTopK: record.graphTopK,
      mergedTopK: record.mergedTopK,
      selectedPromptEvidenceNames: record.selectedPromptEvidenceNames,
      rawSemanticTopK: record.rawSemanticTopK,
      rawGraphTopK: record.rawGraphTopK,
      mergedRetrievalTopK: record.mergedRetrievalTopK,
      projectionTopK: record.projectionTopK,
      projectedEvidenceNames: record.projectedEvidenceNames,
      actualPromptEvidenceNames: record.actualPromptEvidenceNames,
      droppedProjectedEvidenceNames: record.droppedProjectedEvidenceNames,
      rawTop1Aligned: record.rawTop1Aligned,
      retrievalRecallAligned: record.retrievalRecallAligned,
      projectionSelectedStrongHelper: record.projectionSelectedStrongHelper,
      promptContainsProjectedHelper: record.promptContainsProjectedHelper,
      probeAffectsPrompt: record.probeAffectsPrompt,
      probeCompleted: record.probeCompleted,
      projectionToPromptDropReason: record.projectionToPromptDropReason,
      submittedEvidenceNames: record.submittedEvidenceNames,
      expectedSymbolInQaExactRetrieval: record.expectedSymbolInQaExactRetrieval,
      expectedSymbolInFullRetrieval: record.expectedSymbolInFullRetrieval,
      expectedSymbolInProjection: record.expectedSymbolInProjection,
      expectedSymbolInPrompt: record.expectedSymbolInPrompt,
      fullRetrievalProbeDumpPath: record.fullRetrievalProbeDumpPath,
    })
  }
  const report: CompletionQualityLatestReport = {
    generatedAt: new Date().toISOString(),
    runMode: input.summary.run_mode,
    qualityMetricValid: input.summary.quality_metric_valid,
    metricNote: input.summary.metric_note,
    records: reportRecords,
  }
  writeFileSync(input.output.reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

function promptDumpText(record: CompletionQualityRecord) {
  return [
    `# fixture: ${record.name}`,
    `# file: ${record.file}`,
    `# planKind: ${record.planKind}`,
    `# cIntent: ${record.cIntent ?? ""}`,
    `# promptKind: ${record.promptKind}`,
    `# retrievalMode: ${record.retrievalMode ?? "none"}`,
    `# actualCompletionBackend: ${record.actualCompletionBackend ?? ""}`,
    `# ablationVariant: ${record.ablationVariant ?? ""}`,
    `# transport: ${record.transport ?? ""}`,
    `# model: ${record.model ?? ""}`,
    "",
    record.finalPrompt ?? "",
  ].join("\n")
}

function evidenceDump(record: CompletionQualityRecord) {
  return {
    fixture: {
      name: record.name,
      file: record.file,
      scenario: record.scenario,
      languageId: record.languageId,
    },
    plan: {
      kind: record.planKind,
      cIntent: record.cIntent,
      retrievalPolicy: record.retrievalPolicy,
      domainHints: record.domainHints,
    },
    route: {
      kind: record.routeKind,
      promptKind: record.promptKind,
    },
    actualCompletionBackend: record.actualCompletionBackend,
    ablationVariant: record.ablationVariant,
    transport: record.transport,
    model: record.model,
    retrievalTrace: record.retrievalTrace ?? {
      symbolQueries: [],
      evidenceQueries: [],
    },
    retrievalMode: record.retrievalMode ?? "none",
    cEmbeddedEvidenceTrace: record.cEmbeddedEvidenceTrace,
    normalizedCommentTokens: record.normalizedCommentTokens,
    candidateTokenCoverage: record.candidateTokenCoverage,
    semanticCandidateTopK: record.semanticCandidateTopK,
    selectedSimilarFunctionNames: record.selectedSimilarFunctionNames,
    correctFunctionInCandidates: record.correctFunctionInCandidates,
    retrievalElapsedMs: record.retrievalElapsedMs,
    retrievalBudgetMs: record.retrievalBudgetMs,
    retrievalTimedOut: record.retrievalTimedOut,
    timeoutStage: record.timeoutStage,
    qaAlignedEvidence: record.qaAlignedEvidence,
    qaTopCandidate: record.qaTopCandidate,
    completionTopCandidate: record.completionTopCandidate,
    sharedTopCandidate: record.sharedTopCandidate,
    qaRetrievalTopK: record.qaRetrievalTopK,
    completionRetrievalTopK: record.completionRetrievalTopK,
    alignmentReason: record.alignmentReason,
    rerankEnabled: record.rerankEnabled,
    ragAvailable: record.ragAvailable,
    latencyBudgetMs: record.latencyBudgetMs,
    maxEvidence: record.maxEvidence,
    evidenceRoles: record.evidenceRoles,
    generationModeHint: record.generationModeHint,
    helperCallableConfidence: record.helperCallableConfidence,
    callableHelperCandidates: record.callableHelperCandidates,
    styleExampleCandidates: record.styleExampleCandidates,
    qaStyleTopK: record.qaStyleTopK,
    completionProjectionTopK: record.completionProjectionTopK,
    droppedAlignedEvidence: record.droppedAlignedEvidence,
    cursorContextFeatures: record.cursorContextFeatures,
    fullRetrievalCandidateCount: record.fullRetrievalCandidateCount,
    projectionCandidateCount: record.projectionCandidateCount,
    retrievalShape: record.retrievalShape,
    qaExactTopK: record.qaExactTopK,
    qaExactSubmittedEvidence: record.qaExactSubmittedEvidence,
    qaExactContextTopK: record.qaExactContextTopK,
    semanticQueryText: record.semanticQueryText,
    graphQuestionTextHash: record.graphQuestionTextHash,
    semanticTopK: record.semanticTopK,
    graphTopK: record.graphTopK,
    mergedTopK: record.mergedTopK,
    selectedPromptEvidenceNames: record.selectedPromptEvidenceNames,
    rawSemanticTopK: record.rawSemanticTopK,
    rawGraphTopK: record.rawGraphTopK,
    mergedRetrievalTopK: record.mergedRetrievalTopK,
    projectionTopK: record.projectionTopK,
    projectedEvidenceNames: record.projectedEvidenceNames,
    actualPromptEvidenceNames: record.actualPromptEvidenceNames,
    droppedProjectedEvidenceNames: record.droppedProjectedEvidenceNames,
    rawTop1Aligned: record.rawTop1Aligned,
    retrievalRecallAligned: record.retrievalRecallAligned,
    projectionSelectedStrongHelper: record.projectionSelectedStrongHelper,
    promptContainsProjectedHelper: record.promptContainsProjectedHelper,
    probeAffectsPrompt: record.probeAffectsPrompt,
    probeCompleted: record.probeCompleted,
    projectionToPromptDropReason: record.projectionToPromptDropReason,
    submittedEvidenceNames: record.submittedEvidenceNames,
    expectedSymbolInQaExactRetrieval: record.expectedSymbolInQaExactRetrieval,
    expectedSymbolInFullRetrieval: record.expectedSymbolInFullRetrieval,
    expectedSymbolInProjection: record.expectedSymbolInProjection,
    expectedSymbolInPrompt: record.expectedSymbolInPrompt,
    fullRetrievalProbeDumpPath: record.fullRetrievalProbeDumpPath,
    selectedEvidence: record.selectedEvidence ?? [],
    evidenceKinds: record.evidenceKinds,
    selectedEvidenceCount: record.cEmbeddedEvidenceTrace?.finalSelectedEvidenceCount ?? record.selectedEvidence?.length ?? 0,
    evidencePromptBlocks: record.evidencePromptBlocks,
    evidencePromptTokens: record.evidencePromptTokens,
    evidencePromptKinds: record.evidencePromptKinds,
    protocolArtifact: record.protocolArtifact,
    rawModelOutputSample: record.rawModelOutputSample,
    finalInsertTextSample: record.finalInsertTextSample,
    postprocessReason: record.postprocessReason,
    pipelineDecision: record.visible ? "accepted" : "rejected",
    failureReason: record.failureReason ?? record.rejectReason,
  }
}

function correctFunctionInCandidates(
  fixture: CompletionQualityFixture,
  trace: Pick<CompletionDebugEvent, "semanticCandidateTopK" | "selectedSimilarFunctionNames" | "qaRetrievalTopK" | "completionRetrievalTopK" | "sharedTopCandidate" | "qaTopCandidate" | "completionTopCandidate" | "qaStyleTopK" | "completionProjectionTopK" | "callableHelperCandidates" | "styleExampleCandidates"> | undefined,
) {
  const expected = fixture.expectedSimilarFunction?.trim().toLowerCase()
  if (!expected) return undefined
  return [
    ...(trace?.selectedSimilarFunctionNames ?? []),
    ...(trace?.semanticCandidateTopK ?? []).map((item) => item.name ?? ""),
    ...(trace?.qaRetrievalTopK ?? []),
    ...(trace?.completionRetrievalTopK ?? []),
    ...(trace?.qaStyleTopK ?? []),
    ...(trace?.completionProjectionTopK ?? []),
    ...(trace?.callableHelperCandidates ?? []),
    ...(trace?.styleExampleCandidates ?? []),
    trace?.sharedTopCandidate ?? "",
    trace?.qaTopCandidate ?? "",
    trace?.completionTopCandidate ?? "",
  ].some((name) => name.toLowerCase() === expected)
}

function printPromptSamples(records: CompletionQualityRecord[], options: { samplePrompts: number; sampleSeed?: number }) {
  const withPrompts = records.filter((record) => record.finalPrompt?.trim())
  if (withPrompts.length === 0) return
  const seed = options.sampleSeed ?? Math.floor(Math.random() * 1_000_000_000)
  const samples = promptSamplesByDomain(withPrompts, Math.max(0, options.samplePrompts), seed)
  console.log(`\n[completion-quality] prompt-sample-seed=${seed} sampleCount=${samples.length}`)
  for (const record of samples) {
    console.log([
      "",
      `===== prompt sample: ${record.name} (${fixtureDomain(record.name)}) =====`,
      record.finalPrompt ?? "",
      `===== end prompt sample: ${record.name} =====`,
    ].join("\n"))
  }
}

function promptSamplesByDomain(records: CompletionQualityRecord[], count: number, seed: number) {
  const domains = ["generic-c", "embedded-driver", "qemu-ufs", "ssd-domain"]
  const selected: CompletionQualityRecord[] = []
  for (const domain of domains) {
    const record = shuffle(records.filter((item) => fixtureDomain(item.name) === domain), seed + domain.length)[0]
    if (record) selected.push(record)
  }
  const remaining = shuffle(records.filter((record) => !selected.includes(record)), seed)
  return [...selected, ...remaining].slice(0, Math.min(records.length, Math.max(count, Math.min(10, records.length))))
}

function shuffle<T>(items: T[], seed: number) {
  const copy = [...items]
  let state = seed || 1
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swap = state % (index + 1)
    const value = copy[index]
    copy[index] = copy[swap] as T
    copy[swap] = value as T
  }
  return copy
}

function resetDirectory(path: string) {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
}

function fixtureSlug(name: string) {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "fixture"
}

function fixtureDomain(name: string) {
  const known = ["generic-c", "embedded-driver", "qemu-ufs", "ssd-domain"]
  return known.find((domain) => name.startsWith(`${domain}-`)) ?? name.split("-").slice(0, 2).join("-")
}

function benchmarkSettings(options: CompletionQualityBenchmarkOptions): RemoteSettings {
  return {
    serverUrl: "",
    username: "benchmark",
    defaultModel: options.model ?? process.env.OPENCODE_COMPLETION_MODEL ?? "",
    defaultAgent: "",
    localOnlyAgent: "vscode-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: false,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible",
      profile: "qwen-coder-fim",
      apiBaseUrl: options.apiBaseUrl ?? process.env.OPENCODE_COMPLETION_API_BASE_URL ?? "",
      model: options.model ?? process.env.OPENCODE_COMPLETION_MODEL ?? "",
      maxTokens: 160,
      temperature: 0,
      topP: 1,
      debounceMs: 0,
      logLevel: "off",
      debugFullRetrievalProbe: Boolean(options.debugFullRetrieval) || /^(?:1|true|yes|on)$/i.test(process.env.COMPLETION_DEBUG_FULL_RETRIEVAL ?? ""),
      debugExpectedSymbol: options.expectedSymbol ?? process.env.COMPLETION_DEBUG_EXPECTED_SYMBOL ?? "",
      commentGuidedRetrievalMode: options.commentGuidedRetrievalMode ?? readCommentGuidedRetrievalMode(process.env.COMPLETION_COMMENT_GUIDED_RETRIEVAL_MODE),
    },
    codeGraph: {
      enabled: false,
      promptOnWorkspaceOpen: false,
      analysisMode: "auto",
      maxFiles: 50000,
      maxContextBytes: 24000,
      maxEvidenceBytes: 60000,
      maxGraphDepth: 2,
      maxFanout: 40,
      maxDeepFiles: 24,
      maxStateTransitions: 120,
      watcherRescanThreshold: 750,
      workerConcurrency: 4,
      queryCacheSize: 80,
      memoryLimitMb: 4096,
      compileCommandsPath: "",
      clangdPath: "",
      scipClangPath: "",
      excludeGlobs: [],
    },
    analysis: {
      bridgeEnabled: false,
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      maxFileSliceBytes: 16000,
      maxGraphEdges: 120,
      maxPaths: 20,
    },
    rag: {
      embedding: {
        enabled: false,
        endpoint: "",
        model: "",
        batchSize: 32,
        maxTokensPerRequest: 8000,
        concurrentRequests: 2,
        maxInFlightTokens: 16000,
        encodingFormat: "float",
        checkpointMode: "safe",
        checkpointChunkInterval: 100,
        checkpointIntervalMs: 10000,
        timeoutMs: 30000,
        requestDelayMs: 0,
        maxRequestsPerRun: 0,
        maxRetries: 3,
        retryBackoffMs: 1000,
        resumeAutomatically: true,
        resumeDelayMs: 60000,
      },
      rerank: {
        enabled: false,
        endpoint: "",
        model: "",
      },
      allowedHosts: [],
      vectorTopK: 20,
      rerankTopK: 8,
    },
  }
}

function readCommentGuidedRetrievalMode(input: string | undefined): "qa-exact" | "completion" {
  return input === "completion" ? "completion" : "qa-exact"
}

function fakeTextDocument(fixture: CompletionQualityFixture) {
  const text = `${fixture.prefix}${fixture.suffix}`.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const uri = {
    scheme: "file",
    fsPath: resolve(fixture.file),
    toString: () => `file://${resolve(fixture.file)}`,
  }
  const vscodeDocument = {
    uri,
    languageId: fixture.languageId,
    version: 1,
    lineCount: lines.length,
    getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
      if (!range) return text
      const start = offsetAt(lines, range.start)
      const end = offsetAt(lines, range.end)
      return text.slice(start, end)
    },
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  }
  return { text, lines, vscodeDocument }
}

function relativePathForBenchmark(uri: { fsPath?: string; toString?: () => string }) {
  const path = uri.fsPath || uri.toString?.() || ""
  return path.replace(/^file:\/\//, "")
}

function completionEditInput(
  document: ReturnType<typeof fakeTextDocument>,
  position: { line: number; character: number },
): Omit<CompletionEditInput, "text"> {
  const lineText = document.lines[position.line] ?? ""
  const linePrefix = lineText.slice(0, position.character)
  const lineSuffix = lineText.slice(position.character)
  const currentWord = currentWordBeforeCursor(linePrefix, position.line)
  const currentIndent = lineIndent(linePrefix)
  return {
    languageId: document.vscodeDocument.languageId,
    linePrefix,
    lineSuffix,
    position,
    currentWord: currentWord?.text,
    currentWordRange: currentWord?.range,
    indent: {
      currentIndent,
      targetIndent: targetIndent(linePrefix, currentIndent),
      indentUnit: "    ",
    },
  }
}

function currentWordBeforeCursor(linePrefix: string, line: number) {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)
  if (!match) return undefined
  const text = match[0]
  const startCharacter = linePrefix.length - text.length
  return {
    text,
    range: {
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter: linePrefix.length,
    },
  }
}

function positionAt(text: string, offset: number) {
  const prefix = text.slice(0, offset).replace(/\r\n/g, "\n")
  const lines = prefix.split("\n")
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function offsetAt(lines: string[], position: { line: number; character: number }) {
  let offset = 0
  for (let index = 0; index < position.line; index += 1) {
    offset += (lines[index] ?? "").length + 1
  }
  return offset + position.character
}

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index -= 1) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function nextNonEmptyLineAfter(lines: string[], line: number) {
  for (let index = line + 1; index < lines.length; index += 1) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function lineIndent(text: string) {
  return /^[ \t]*/.exec(text)?.[0] ?? ""
}

function targetIndent(linePrefix: string, currentIndent: string) {
  if (/[{:]\s*$/.test(linePrefix)) return `${currentIndent}    `
  return currentIndent
}

function completionIntentValue(plan: CompletionPlan) {
  return plan.cIntent ?? plan.kind
}

function normalizeIntent(intent: string) {
  if (intent === "switch-case") return "case-body"
  if (intent === "top-level-decl") return "top-level-declaration"
  return intent
}

function groundedSymbolMatch(output: string, fixture: CompletionQualityFixture, documentText: string, evidenceText: string) {
  const symbols = fixture.mustUseExistingSymbols.filter(Boolean)
  if (symbols.length === 0) return true
  const corpus = `${documentText}\n${evidenceText}`
  const hasGrounding = symbols.every((symbol) => corpus.includes(symbol))
  const usesSymbol = symbols.some((symbol) => output.includes(symbol))
  return hasGrounding && usesSymbol
}

function styleMatch(output: string, fixture: CompletionQualityFixture, editInput: Omit<CompletionEditInput, "text">) {
  if (!output.trim()) return false
  if (Array.isArray(fixture.mustMatchLocalStyle)) {
    return fixture.mustMatchLocalStyle.every((pattern) => matchesPattern(output, pattern))
  }
  if (!fixture.mustMatchLocalStyle) return true
  const firstVisible = output.split(/\r?\n/).find((line) => line.trim())
  if (!firstVisible) return false
  if (!output.includes("\n")) return true
  return firstVisible.startsWith(editInput.indent.currentIndent) || firstVisible.startsWith(editInput.indent.targetIndent)
}

function retrievalHit(fixture: CompletionQualityFixture, contextText: string) {
  const symbols = fixture.mustUseExistingSymbols.filter(Boolean)
  if (symbols.length === 0) return false
  return symbols.some((symbol) => contextText.includes(symbol))
}

function evidenceKinds(pack: CompletionContextPack | undefined) {
  const kinds = new Set(pack?.selected.map((block) => block.kind) ?? [])
  return [...kinds]
}

function contextLevel(pack: CompletionContextPack | undefined) {
  const tokens = pack?.tokenEstimate ?? 0
  if (tokens <= 0) return "none"
  if (tokens < 500) return "light"
  if (tokens < 1600) return "standard"
  return "rich"
}

function contextWarnings(pack: CompletionContextPack | undefined) {
  if (!pack) return undefined
  const selectedKinds = new Set(pack.selected.map((block) => block.kind))
  const warnings = [
    !selectedKinds.has("current-prefix") && pack.dropped.some((block) => block.kind === "current-prefix") ? "dropped-current-prefix" : "",
    !selectedKinds.has("current-suffix") && pack.dropped.some((block) => block.kind === "current-suffix") ? "dropped-current-suffix" : "",
  ].filter(Boolean)
  return warnings.length ? warnings : undefined
}

function matchesPattern(text: string, pattern: string) {
  try {
    return new RegExp(pattern, "m").test(text)
  } catch {
    return text.includes(pattern)
  }
}

function uniqueNonEmpty(items: Array<string | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const value = item?.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function sampleFromPattern(pattern: string) {
  return pattern
    .replace(/\\\\/g, "\\")
    .replace(/\\\./g, ".")
    .replace(/\\s\*/g, " ")
    .replace(/\\s\+/g, " ")
    .replace(/[()^$[\]{}+?]/g, "")
}

function messageText(message: OpenCodeMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function approximateTokenCount(text: string) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function rate(records: CompletionQualityRecord[], predicate: (record: CompletionQualityRecord) => boolean) {
  if (records.length === 0) return 0
  return round(records.filter(predicate).length / records.length)
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return { avg: 0, p50: 0, p95: 0 }
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    avg: Math.round(avg),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  }
}

function percentile(sorted: number[], ratio: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return Math.round(sorted[index] ?? 0)
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

function truncateSample(text: string) {
  const normalized = text.replace(/\r\n/g, "\n")
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`
}

function inferredScenario(name: string) {
  return COMPLETION_QUALITY_SCENARIOS.find((scenario) => name.includes(scenario)) ?? "unknown"
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return listJsonlFiles(path)
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : []
  }).sort()
}

function parseFixtureLine(file: string, lineNumber: number, line: string): CompletionQualityFixture {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`${relative(process.cwd(), file)}:${lineNumber}: invalid JSONL: ${error instanceof Error ? error.message : String(error)}`)
  }
  const fixture = parsed as CompletionQualityFixture
  const errors = validateCompletionQualityFixture(fixture)
  if (errors.length) {
    throw new Error(`${relative(process.cwd(), file)}:${lineNumber}: invalid fixture ${fixture.name ?? "(unnamed)"}: ${errors.join(", ")}`)
  }
  return fixture
}

function writeReport(path: string, payload: { summary: CompletionQualitySummary; records: CompletionQualityRecord[] }) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)
}

function parseArgs(argv: string[]): CompletionQualityBenchmarkOptions {
  const options: CompletionQualityBenchmarkOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index] ?? ""
    switch (arg) {
      case "--fixture-root":
        options.fixtureRoot = next()
        break
      case "--fixture":
        options.fixture = next()
        break
      case "--limit":
        options.limit = Number(next())
        break
      case "--repeat":
        options.repeat = Number(next())
        break
      case "--direct-qwen-ablation":
        options.directQwenAblation = true
        break
      case "--ablation-variant": {
        const value = next()
        if (value !== "baseline" && value !== "p2-evidence" && value !== "both") throw new Error(`Invalid --ablation-variant: ${value}`)
        options.ablationVariant = value
        break
      }
      case "--dump-prompts":
        options.dumpPrompts = true
        break
      case "--dump-evidence":
        options.dumpEvidence = true
        break
      case "--output-dir":
        options.outputDir = next()
        break
      case "--sample-prompts":
        options.samplePrompts = Number(next())
        break
      case "--sample-seed":
        options.sampleSeed = Number(next())
        break
      case "--api-base-url":
        options.apiBaseUrl = next()
        break
      case "--model":
        options.model = next()
        break
      case "--api-key":
        options.apiKey = next()
        break
      case "--api-key-env":
        options.apiKeyEnv = next()
        break
      case "--transport":
        options.transport = readCompletionTransport(next())
        break
      case "--prompt-style": {
        options.promptStyle = readPromptStyle(next())
        break
      }
      case "--temperature":
        options.temperature = Number(next())
        break
      case "--max-tokens":
        options.maxTokens = Number(next())
        break
      case "--seed":
        options.seed = Number(next())
        break
      case "--report":
        options.report = next()
        break
      case "--timeout-ms":
        options.timeoutMs = Number(next())
        break
      case "--debug-full-retrieval":
        options.debugFullRetrieval = true
        break
      case "--expected-symbol":
        options.expectedSymbol = next()
        break
      case "--comment-guided-retrieval-mode":
        options.commentGuidedRetrievalMode = readCommentGuidedRetrievalMode(next())
        break
      case "--mock":
        options.mock = true
        break
      default:
        if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`)
        break
    }
  }
  return options
}

function installVscodeShim() {
  mock.module("vscode", () => ({
    InlineCompletionTriggerKind: {
      Invoke: 0,
      Automatic: 1,
    },
    InlineCompletionItem: class InlineCompletionItem {
      insertText: string
      range?: unknown
      command?: unknown
      filterText?: string

      constructor(insertText: string, range?: unknown, command?: unknown) {
        this.insertText = insertText
        this.range = range
        this.command = command
      }
    },
    Range: class Range {
      start: { line: number; character: number }
      end: { line: number; character: number }

      constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = { line: startLine, character: startCharacter }
        this.end = { line: endLine, character: endCharacter }
      }
    },
    DiagnosticSeverity: {},
    ConfigurationTarget: {
      Global: "global",
    },
    commands: {
      executeCommand: async () => undefined,
    },
    languages: {
      getDiagnostics: () => [],
    },
    workspace: {
      asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? "",
      getWorkspaceFolder: () => ({ name: "completion-quality-benchmark" }),
      workspaceFolders: [{ name: "completion-quality-benchmark" }],
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T) => fallback,
      }),
      get textDocuments() {
        return vscodeShimState.textDocuments
      },
      fs: {
        readFile: async () => new Uint8Array(),
      },
      openTextDocument: async () => undefined,
    },
    window: {
      get activeTextEditor() {
        return vscodeShimState.activeTextEditor
      },
      get visibleTextEditors() {
        return vscodeShimState.visibleTextEditors
      },
    },
    Selection: class Selection {},
    Position: class Position {},
  }))
}

if (import.meta.main) {
  runCompletionQualityBenchmark(parseArgs(process.argv.slice(2)))
    .then(({ summary }) => {
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
