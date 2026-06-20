import * as vscode from "vscode"
import { CHIPMATE_COMMANDS } from "../chipmate-constants"
import type { CodeGraphContextProvider } from "../codegraph-types"
import type { RemoteSettings } from "../types"
import { applyCommentProposal, applyCommentProposals } from "./commentApplyService"
import { buildCommentGenerationContext, commentPrimaryAnchorPolicy, isSupportedCommentLanguage } from "./commentContext"
import { CommentCodeLensProvider } from "./commentCodeLensProvider"
import { CommentDecorations } from "./commentDecorations"
import {
  commentContextLogFields,
  createCommentTraceContext,
  enrichCommentTraceContext,
  logCommentOutcome,
  logCommentStage,
  previewHash,
  responsePreviewField,
  shortHash,
  textByteLength,
  type CommentGenerationTraceContext,
  type CommentGenerationTerminalReason,
} from "./commentDiagnostics"
import { CommentEvidenceService } from "./commentEvidenceService"
import { CommentLLMClient, CommentLLMGenerationError } from "./commentLLMClient"
import { parseCommentProposalResponse, summarizeCommentProposalResponse } from "./commentProposalParser"
import { CommentProposalStore } from "./commentProposalStore"
import { discardReasonHistogram, validateRawCommentProposals } from "./commentProposalValidator"
import { buildCommentPrompt } from "./commentPrompt"
import { commentPreviewDetail } from "./commentPreview"
import { resolveCurrentFunctionSelection } from "./commentFunctionRange"
import { CommentReviewPanel, type CommentReviewRegenerateTarget } from "./commentReviewPanel"
import type { CommentGenerationProgressState, CommentGenerationProgressStep, CommentGenerationStreamState, CommentGenerationTokenUsage, CommentGenerationToolState } from "./commentReviewHtml"
import type { CommentGenerationContext, CommentProposal, CommentReviewSource, RawCommentProposal } from "./commentTypes"
import { CommentToolAgentClient, type CommentToolRuntime, type CommentToolEvidenceResult } from "./commentToolAgentClient"

export const COMMENT_LOG_PREFIX = "[ChipMate Comment]"
const COMMENT_CONTEXT_SUPPORTED_EDITOR = "chipmate.comments.supportedEditor"
const COMMENT_CONTEXT_HAS_PENDING_FILE = "chipmate.comments.fileHasPendingSuggestions"
const COMMENT_CONTEXT_HAS_PENDING_CURSOR = "chipmate.comments.cursorHasPendingSuggestion"
type CommentProgressPanel = { updateGeneration?: (progress: CommentGenerationProgressState) => void }

export type RegisterCommentReviewInput = {
  context: vscode.ExtensionContext
  output: vscode.OutputChannel
  getSettings: () => RemoteSettings
  getApiKey: () => Promise<string | undefined>
  codeGraph?: Pick<CodeGraphContextProvider, "queryEvidence" | "status">
  tools?: CommentToolRuntime
  extensionVersion?: string
}

export function registerCommentReview(input: RegisterCommentReviewInput) {
  const store = new CommentProposalStore()
  const llmClient = new CommentLLMClient({
    getSettings: input.getSettings,
    getApiKey: input.getApiKey,
  })
  const evidenceService = new CommentEvidenceService({
    getSettings: input.getSettings,
    codeGraph: input.codeGraph,
  })
  const toolAgent = new CommentToolAgentClient({
    getSettings: input.getSettings,
    getApiKey: input.getApiKey,
    tools: input.tools,
  })
  const codeLensProvider = new CommentCodeLensProvider(store)
  const decorations = new CommentDecorations(store)
  let reviewPanel: CommentReviewPanel
  const generateSelectionComments = (
    forceRegenerate = false,
    editor?: vscode.TextEditor,
    trace?: CommentGenerationTraceContext,
    skipCommandStart = false,
    source: CommentReviewSource = "selection",
    selection?: vscode.Selection,
  ) =>
    generateForSelection({
      output: input.output,
      llmClient,
      evidenceService,
      toolAgent,
      store,
      reviewPanel,
      extensionVersion: input.extensionVersion,
      editor,
      source,
      selection,
      trace,
      skipCommandStart,
      ...(forceRegenerate ? { forceRegenerate: true } : {}),
    })
  const generateCurrentFunctionComments = () =>
    generateForCurrentFunction({
      output: input.output,
      llmClient,
      evidenceService,
      toolAgent,
      store,
      reviewPanel,
      extensionVersion: input.extensionVersion,
    })
  const regenerateSelectionComments = (target: CommentReviewRegenerateTarget) =>
    regenerateFromProposal({
      output: input.output,
      store,
      target,
      extensionVersion: input.extensionVersion,
      generate: async (editor, trace, selection, source) => {
        await generateSelectionComments(true, editor, trace, true, source, selection)
      },
    })
  reviewPanel = new CommentReviewPanel({
    extensionUri: input.context.extensionUri,
    output: input.output,
    store,
    onAccept: (proposalId) => acceptProposal({ output: input.output, store, proposalId }),
    onAcceptAll: (uri) => acceptAllPendingForCurrentReviewFile({ output: input.output, store, uri }),
    onReject: (proposalId) => rejectProposal({ output: input.output, store, proposalId }),
    onReveal: (proposalId) => revealProposal({ output: input.output, store, proposalId }),
    onRegenerate: regenerateSelectionComments,
  })
  const refreshCommentContexts = () => {
    void updateCommentContexts(store)
  }

  input.context.subscriptions.push(
    store,
    codeLensProvider,
    decorations,
    reviewPanel,
    store.onDidChange(refreshCommentContexts),
    vscode.window.onDidChangeActiveTextEditor(refreshCommentContexts),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) refreshCommentContexts()
    }),
    vscode.languages.registerCodeLensProvider(
      [{ language: "c" }, { language: "cpp" }, { language: "cuda-cpp" }, { language: "objective-c" }, { language: "objective-cpp" }],
      codeLensProvider,
    ),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsGenerateForSelection, () => generateSelectionComments()),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsGenerateForCurrentFunction, () => generateCurrentFunctionComments()),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsPreview, (proposalId: string) =>
      previewProposal({ output: input.output, store, reviewPanel, proposalId }),
    ),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsAccept, (proposalId: string) =>
      acceptProposal({ output: input.output, store, proposalId }),
    ),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsAcceptAll, () =>
      acceptAllPendingForCurrentReviewFile({ output: input.output, store }),
    ),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsReject, (proposalId: string) =>
      rejectProposal({ output: input.output, store, proposalId }),
    ),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.commentsClear, () =>
      clearCurrentFile({ output: input.output, store }),
    ),
  )

  refreshCommentContexts()
}

export async function generateForCurrentFunction(input: {
  output: vscode.OutputChannel
  llmClient: Pick<CommentLLMClient, "generate">
  evidenceService?: Pick<CommentEvidenceService, "collect">
  toolAgent?: Pick<CommentToolAgentClient, "collectEvidence">
  store: CommentProposalStore
  reviewPanel?: Partial<Pick<CommentReviewPanel, "openForDocument" | "openForGeneration" | "updateGeneration" | "clearGeneration">>
  extensionVersion?: string
  forceRegenerate?: boolean
  editor?: vscode.TextEditor
}) {
  const trace = createCommentTraceContext(input.extensionVersion)
  logCommentStage(input.output, trace, "command.start", { source: "currentFunction" })
  const editor = input.editor ?? vscode.window.activeTextEditor
  if (!editor) {
    logCommentOutcome(input.output, trace, "selection-invalid", "没有活动编辑器", { source: "currentFunction" })
    void vscode.window.showErrorMessage("请先打开一个 C/C++ 文件，再生成 AI 注释。")
    return
  }
  if (!isSupportedCommentLanguage(editor.document.languageId)) {
    logCommentOutcome(input.output, trace, "unsupported-language", "当前语言暂不支持", {
      languageId: editor.document.languageId,
      source: "currentFunction",
    })
    void vscode.window.showInformationMessage("当前 AI 注释仅支持 C/C++ 相关语言。")
    return
  }
  const selection = resolveCurrentFunctionSelection(editor)
  if (!selection) {
    logCommentOutcome(input.output, trace, "selection-invalid", "未找到当前函数", {
      languageId: editor.document.languageId,
      source: "currentFunction",
    })
    void vscode.window.showInformationMessage("未找到当前函数，请选中代码后生成 AI 注释。")
    return
  }
  logCommentStage(input.output, trace, "currentFunction.resolved", {
    source: "currentFunction",
    resolvedRangeStartLine: selection.start.line,
    resolvedRangeEndLine: selection.end.line,
    resolvedRangeStartCharacter: selection.start.character,
    resolvedRangeEndCharacter: selection.end.character,
  })
  await generateForSelection({
    ...input,
    editor,
    selection,
    source: "currentFunction",
    trace,
    skipCommandStart: true,
  })
}

export async function generateForSelection(input: {
  output: vscode.OutputChannel
  llmClient: Pick<CommentLLMClient, "generate">
  evidenceService?: Pick<CommentEvidenceService, "collect">
  toolAgent?: Pick<CommentToolAgentClient, "collectEvidence">
  store: CommentProposalStore
  reviewPanel?: Partial<Pick<CommentReviewPanel, "openForDocument" | "openForGeneration" | "updateGeneration" | "clearGeneration">>
  extensionVersion?: string
  forceRegenerate?: boolean
  editor?: vscode.TextEditor
  selection?: vscode.Selection
  source?: CommentReviewSource
  trace?: CommentGenerationTraceContext
  skipCommandStart?: boolean
}) {
  const trace = input.trace ?? createCommentTraceContext(input.extensionVersion)
  if (!input.skipCommandStart) logCommentStage(input.output, trace, "command.start")
  const editor = input.editor ?? vscode.window.activeTextEditor
  if (!editor) {
    logCommentOutcome(input.output, trace, "selection-invalid", "没有活动编辑器")
    void vscode.window.showErrorMessage("请先打开一个 C/C++ 文件，再生成 AI 注释。")
    return
  }
  const selection = input.selection ?? editor.selection
  const source = input.source ?? "selection"
  if (selection.isEmpty) {
    logCommentOutcome(input.output, trace, "selection-empty", "当前选区为空", {
      languageId: editor.document.languageId,
      source,
    })
    void vscode.window.showInformationMessage("请先选中一段 C/C++ 代码，再生成 AI 注释。")
    return
  }
  if (!isSupportedCommentLanguage(editor.document.languageId)) {
    logCommentOutcome(input.output, trace, "unsupported-language", "当前语言暂不支持", {
      languageId: editor.document.languageId,
      source,
    })
    void vscode.window.showInformationMessage("当前 AI 注释 MVP 仅支持 C/C++ 相关语言的选区。")
    return
  }

  const context = buildCommentGenerationContext(editor, { selection, source })
  const requestTrace = enrichCommentTraceContext(trace, context)
  logCommentStage(input.output, requestTrace, "selection.ready", commentContextLogFields(context))
  if (!context.selectedCode.trim()) {
    logCommentOutcome(input.output, requestTrace, "selection-empty", "去除空白后选区为空")
    void vscode.window.showInformationMessage("请选中非空代码后再生成 AI 注释。")
    return
  }
  const cachedProposals = input.forceRegenerate ? [] : input.store.pendingForSelection(context)
  if (cachedProposals.length > 0) {
    logCommentStage(input.output, requestTrace, "cache.hit", {
      source: context.source,
      proposalCount: cachedProposals.length,
      uriHash: shortHash(context.uri),
      contextHash: context.contextHash,
    })
    logCommentOutcome(input.output, requestTrace, "proposals-stored", "已打开上一次生成的 AI 注释候选", {
      source: context.source,
      proposalCount: cachedProposals.length,
      cacheHit: true,
    })
    input.reviewPanel?.openForDocument?.(context.uri, cachedProposals[0]?.id)
    vscode.window.setStatusBarMessage("已打开上一次生成的 AI 注释候选。", 2500)
    return
  }
  if (input.forceRegenerate) {
    logCommentStage(input.output, requestTrace, "cache.bypass", {
      source: context.source,
      reason: "force-regenerate",
      pendingSelectionCount: input.store.pendingForSelection(context).length,
      uriHash: shortHash(context.uri),
    })
  } else {
    logCommentStage(input.output, requestTrace, "cache.miss", {
      source: context.source,
      pendingForDocument: input.store.pendingForDocument(context.uri).length,
      uriHash: shortHash(context.uri),
      contextHash: context.contextHash,
    })
  }
  const progress = createGenerationProgress(requestTrace.traceId, context)
  updateProgress(input.reviewPanel, progress, "selection", "已确认选区", "done", {
    detail: `${reviewSourceLabel(context.source)} · 行 ${context.selectionStartLine + 1}-${context.selectionEndLine + 1} · ${context.languageId}`,
  })
  input.reviewPanel?.openForGeneration?.(progress)
  if (context.allowedInsertionAnchors.length === 0) {
    updateProgress(input.reviewPanel, progress, "anchors", "计算结构锚点", "failed", {
      detail: "没有可用于结构级注释的安全插入锚点。",
    })
    finishProgress(input.reviewPanel, progress, "failed", "selection-no-anchors", "当前选区没有适合插入结构级 AI 注释的位置。")
    logCommentStage(input.output, requestTrace, "anchors.done", {
      allowedAnchorCount: 0,
      selectionStartLine: context.selectionStartLine,
      selectionEndLine: context.selectionEndLine,
      source: context.source,
      selectionIntent: context.selectionIntent,
      proposalBudget: context.proposalBudget,
      primaryAnchorPolicy: context.primaryAnchorPolicy,
      primaryAnchorLine: context.primaryAnchorLine,
      primaryAnchorKind: context.primaryAnchorKind,
      internalAnchorCount: context.internalAnchorLines.length,
    })
    logCommentOutcome(input.output, requestTrace, "selection-no-anchors", "当前选区没有可用于结构级注释的安全插入锚点")
    void vscode.window.showInformationMessage("当前选区没有适合插入结构级 AI 注释的位置。请扩大或调整选区后重试。")
    return
  }
  updateProgress(input.reviewPanel, progress, "anchors", "计算结构锚点", "done", {
    detail: `${context.allowedInsertionAnchors.length} 个可用锚点`,
  })
  logCommentStage(input.output, requestTrace, "anchors.done", {
    allowedAnchorCount: context.allowedInsertionAnchors.length,
    allowedAnchorLines: context.allowedInsertionAnchors.map((anchor) => anchor.line),
    source: context.source,
    selectionIntent: context.selectionIntent,
    proposalBudget: context.proposalBudget,
    primaryAnchorPolicy: context.primaryAnchorPolicy,
    primaryAnchorLine: context.primaryAnchorLine,
    primaryAnchorKind: context.primaryAnchorKind,
    internalAnchorCount: context.internalAnchorLines.length,
    internalAnchorLines: context.internalAnchorLines,
  })

  let generationContext: CommentGenerationContext
  if (!input.toolAgent && input.evidenceService) {
    const legacyContext = await collectLegacyEvidenceForGeneration({
      output: input.output,
      evidenceService: input.evidenceService,
      reviewPanel: input.reviewPanel,
      context,
      requestTrace,
      progress,
    })
    if (!legacyContext) return
    generationContext = legacyContext
  } else {
    updateProgress(input.reviewPanel, progress, "tools", "模型检索本地证据", "running", {
      detail: "准备调用只读 ChipMate 工具",
    })
    let toolEvidence: CommentToolEvidenceResult
    try {
      if (!input.toolAgent) {
        toolEvidence = {
          ok: false,
          reason: "tools-disabled",
          message: "AI 注释需要启用 ChipMate 工具检索。请开启工具后重试。",
          elapsedMs: 0,
          roundCount: 0,
          toolCallCount: 0,
          blockedToolCount: 0,
          failedToolCount: 0,
        }
      } else {
        toolEvidence = await input.toolAgent.collectEvidence(context, requestTrace.traceId, (event) => {
          logCommentStage(input.output, requestTrace, event.stage, event.fields)
          updateToolProgress(input.reviewPanel, progress, event.stage, event.fields)
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateProgress(input.reviewPanel, progress, "tools", "模型检索本地证据", "failed", { detail: message })
      finishProgress(input.reviewPanel, progress, "failed", "tool-loop-failed", message)
      logCommentStage(input.output, requestTrace, "tool.loop.error", { message })
      logCommentOutcome(input.output, requestTrace, "tool-loop-failed", message)
      void vscode.window.showErrorMessage("AI 注释工具检索失败。请查看 ChipMate Comment 输出。")
      return
    }
    if (!toolEvidence.ok) {
      updateProgress(input.reviewPanel, progress, "tools", "模型检索本地证据", "failed", {
        detail: toolEvidence.message,
        elapsedMs: toolEvidence.elapsedMs,
      })
      finishProgress(input.reviewPanel, progress, "failed", toolEvidence.reason, toolEvidence.message)
      logCommentOutcome(input.output, requestTrace, toolEvidence.reason, toolEvidence.message, {
        roundCount: toolEvidence.roundCount,
        toolCallCount: toolEvidence.toolCallCount,
        blockedToolCount: toolEvidence.blockedToolCount,
        failedToolCount: toolEvidence.failedToolCount,
      })
      void vscode.window.showInformationMessage(toolEvidence.message)
      return
    }
    updateProgress(input.reviewPanel, progress, "tools", "模型检索本地证据", "done", {
      detail: `${toolEvidence.toolCallCount} 次工具调用 · ${toolEvidence.evidenceItemCount} 条证据`,
      elapsedMs: toolEvidence.elapsedMs,
    })
    updateProgress(input.reviewPanel, progress, "evidence", "汇总工具证据", "done", {
      detail: `${toolEvidence.evidenceItemCount} 条工具证据`,
      elapsedMs: toolEvidence.elapsedMs,
    })
    generationContext = {
      ...context,
      retrievalMode: "tool-driven",
      outputDirective: toolEvidence.outputDirective,
      groundingConfidence: toolEvidence.groundingConfidence,
      groundingSummary: toolEvidence.groundingSummary,
      evidenceCompacted: toolEvidence.evidenceCompacted,
      evidenceSections: {
        ...context.evidenceSections,
        selectionAnchors: [
          `当前文件: ${context.workspacePath}`,
          `选区行: ${context.selectionStartLine}-${context.selectionEndLine}`,
          `允许锚点: ${context.allowedInsertionAnchors.map((anchor) => anchor.line).join(", ")}`,
        ].join("\n"),
        toolEvidence: toolEvidence.evidenceSummary,
        groundingSummary: toolEvidence.groundingSummary,
      },
      evidenceSummary: toolEvidence.evidenceSummary,
      evidenceItemCount: toolEvidence.evidenceItemCount,
      primaryAnchorPolicy: commentPrimaryAnchorPolicy(context.selectionIntent, toolEvidence.groundingConfidence),
    }
    logCommentStage(input.output, requestTrace, "evidence.done", {
      success: true,
      retrievalMode: generationContext.retrievalMode,
      evidenceItems: generationContext.evidenceItemCount,
      evidenceSummaryBytes: toolEvidence.evidenceSummaryBytes,
      toolMs: toolEvidence.elapsedMs,
      toolRoundCount: toolEvidence.roundCount,
      toolCallCount: toolEvidence.toolCallCount,
      blockedToolCount: toolEvidence.blockedToolCount,
      failedToolCount: toolEvidence.failedToolCount,
      outputDirective: generationContext.outputDirective,
      groundingConfidence: generationContext.groundingConfidence,
      groundingSummary: generationContext.groundingSummary,
      evidenceCompacted: generationContext.evidenceCompacted,
      selectionIntent: generationContext.selectionIntent,
      source: generationContext.source,
      proposalBudget: generationContext.proposalBudget,
      primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
      primaryAnchorLine: generationContext.primaryAnchorLine,
      primaryAnchorKind: generationContext.primaryAnchorKind,
      internalAnchorCount: generationContext.internalAnchorLines.length,
    })
  }

  const prompt = buildCommentPrompt(generationContext)
  const pendingStatus = vscode.window.setStatusBarMessage("正在生成 AI 注释候选...")
  updateProgress(input.reviewPanel, progress, "model", "请求模型生成候选", "running", {
    detail: `${generationContext.retrievalMode} · 等待流式响应`,
  })
  logCommentStage(input.output, requestTrace, "model.request.start", {
    promptBytes: textByteLength(prompt),
    promptHash: shortHash(prompt),
    evidenceBytes: textByteLength(generationContext.evidenceSummary),
    evidenceHash: shortHash(generationContext.evidenceSummary),
    retrievalMode: generationContext.retrievalMode,
    outputDirective: generationContext.outputDirective,
    groundingConfidence: generationContext.groundingConfidence,
    evidenceCompacted: generationContext.evidenceCompacted,
    selectionIntent: generationContext.selectionIntent,
    source: generationContext.source,
    proposalBudget: generationContext.proposalBudget,
    primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
    primaryAnchorLine: generationContext.primaryAnchorLine,
    primaryAnchorKind: generationContext.primaryAnchorKind,
    internalAnchorCount: generationContext.internalAnchorLines.length,
  })

  let modelText = ""
  let elapsedMs = 0
  let tokenUsage: CommentGenerationTokenUsage | undefined
  try {
    const response = await input.llmClient.generate(prompt, undefined, undefined, (event) => {
      updateModelProgress(input.reviewPanel, progress, event.stage, event.fields)
      if (event.stage !== "model.stream.delta") {
        logCommentStage(input.output, requestTrace, event.stage, event.fields)
      }
    })
    modelText = response.text
    elapsedMs = response.elapsedMs
    tokenUsage = response.tokenUsage
  } catch (error) {
    pendingStatus.dispose()
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof CommentLLMGenerationError) {
      finishProgress(input.reviewPanel, progress, "failed", error.terminalReason, message, tokenUsageFromFields(error.fields))
      logCommentStage(input.output, requestTrace, "model.request.failed", {
        message,
        terminalReason: error.terminalReason,
        ...error.fields,
      })
      logCommentOutcome(input.output, requestTrace, error.terminalReason, message, error.fields)
      void vscode.window.showErrorMessage("AI 注释生成失败。请查看 ChipMate Comment 输出。")
      return
    }
    finishProgress(input.reviewPanel, progress, "failed", "model-request-failed", message)
    logCommentStage(input.output, requestTrace, "model.request.failed", { message })
    logCommentOutcome(input.output, requestTrace, "model-request-failed", message)
    void vscode.window.showErrorMessage("AI 注释生成失败。请查看 ChipMate Comment 输出。")
    return
  }
  pendingStatus.dispose()
  updateProgress(input.reviewPanel, progress, "model", "请求模型生成候选", "done", {
    detail: "已收到模型响应",
    elapsedMs,
  })
  if (tokenUsage) {
    progress.tokenUsage = tokenUsage
    input.reviewPanel?.updateGeneration?.(progress)
  }
  logCommentStage(input.output, requestTrace, "model.request.done", {
    elapsedMs,
    responseBytes: textByteLength(modelText),
    responseHash: previewHash(modelText),
    ...(tokenUsage ?? {}),
  })
  const responsePreview = summarizeCommentProposalResponse(modelText)
  logCommentStage(input.output, requestTrace, "model.response.preview", {
    kind: responsePreview.kind,
    summary: responsePreviewField(responsePreview),
  })

  const parsed = parseCommentProposalResponse(modelText)
  updateProgress(input.reviewPanel, progress, "parse", "解析 JSON 候选", "running")
  if (!parsed.ok) {
    updateProgress(input.reviewPanel, progress, "parse", "解析 JSON 候选", "failed", { detail: parsed.reason })
    finishProgress(input.reviewPanel, progress, "failed", "parse-failed", parsed.reason, tokenUsage)
    logCommentStage(input.output, requestTrace, "parse.done", {
      success: false,
      reason: parsed.reason,
    })
    logCommentOutcome(input.output, requestTrace, "parse-failed", parsed.reason)
    void vscode.window.showErrorMessage("AI 注释生成返回的 JSON 无效。")
    return
  }
  updateProgress(input.reviewPanel, progress, "parse", "解析 JSON 候选", "done", {
    detail: `${parsed.proposals.length} 条原始候选`,
  })
  logCommentStage(input.output, requestTrace, "parse.done", {
    success: true,
    proposalCount: parsed.proposals.length,
  })

  updateProgress(input.reviewPanel, progress, "validate", "校验候选安全性", "running")
  const validated = validateRawCommentProposals(parsed.proposals, {
    selectionStartLine: generationContext.selectionStartLine,
    selectionEndLine: generationContext.selectionEndLine,
    allowedInsertBeforeLines: generationContext.allowedInsertionAnchors.map((anchor) => anchor.line),
    allowedAnchors: generationContext.allowedInsertionAnchors,
    maxProposals: generationContext.proposalBudget,
  })
  const discardHistogram = discardReasonHistogram(validated.discarded)
  const evidenceCounts = proposalEvidenceCounts(validated.proposals)
  const returnedAnchorLines = proposalAnchorLines(parsed.proposals)
  const acceptedAnchorLines = proposalAnchorLines(validated.proposals)
  const primaryProposalReturned = hasProposalAtLine(parsed.proposals, generationContext.primaryAnchorLine)
  const primaryProposalAccepted = hasProposalAtLine(validated.proposals, generationContext.primaryAnchorLine)
  const primaryProposalMissing = generationContext.primaryAnchorPolicy === "required-when-supported" &&
    generationContext.primaryAnchorLine !== undefined &&
    !primaryProposalReturned
  const primaryDiscardReason = primaryProposalDiscardReason(parsed.proposals, validated.discarded, generationContext.primaryAnchorLine)
  updateProgress(input.reviewPanel, progress, "validate", "校验候选安全性", "done", {
    detail: `${validated.proposals.length} 条可展示 · 丢弃 ${validated.discarded.length} 条`,
  })
  logCommentStage(input.output, requestTrace, "validate.done", {
    proposalCount: parsed.proposals.length,
    acceptedCount: validated.proposals.length,
    discardedCount: validated.discarded.length,
    discardHistogram,
    acceptedEvidenceSpanCount: evidenceCounts.evidenceSpanCount,
    acceptedSelectionEvidenceCount: evidenceCounts.selectionEvidenceCount,
    acceptedRepositoryEvidenceCount: evidenceCounts.repositoryEvidenceCount,
    allowedAnchorCount: generationContext.allowedInsertionAnchors.length,
    source: generationContext.source,
    proposalBudget: generationContext.proposalBudget,
    primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
    returnedAnchorLines,
    acceptedAnchorLines,
    primaryProposalReturned,
    primaryProposalAccepted,
    primaryProposalMissing,
    primaryDiscardReason,
    anchorLineRepaired: validated.repairs.length > 0,
    anchorLineRepairCount: validated.repairs.length,
    originalInsertBeforeLine: validated.repairs[0]?.originalInsertBeforeLine,
    repairedInsertBeforeLine: validated.repairs[0]?.repairedInsertBeforeLine,
    repairReason: validated.repairs[0]?.repairReason,
    anchorLineRepairs: validated.repairs,
  })
  const proposals = buildStoredProposals(validated.proposals, generationContext)
  if (proposals.length === 0) {
    const outcomeReason: CommentGenerationTerminalReason = parsed.proposals.length === 0
      ? emptyArrayTerminalReason(generationContext.retrievalMode)
      : "validator-filtered-all"
    const detail = parsed.proposals.length === 0
      ? `模型在 ${generationContext.retrievalMode} 模式下返回了空 proposals 数组`
      : "validator 丢弃了所有生成的注释候选"
    finishProgress(input.reviewPanel, progress, "empty", outcomeReason, detail, tokenUsage)
    logCommentOutcome(input.output, requestTrace, outcomeReason, detail, {
      retrievalMode: generationContext.retrievalMode,
      outputDirective: generationContext.outputDirective,
      groundingConfidence: generationContext.groundingConfidence,
      evidenceCompacted: generationContext.evidenceCompacted,
      selectionIntent: generationContext.selectionIntent,
      source: generationContext.source,
      proposalBudget: generationContext.proposalBudget,
      primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
      primaryAnchorLine: generationContext.primaryAnchorLine,
      primaryAnchorKind: generationContext.primaryAnchorKind,
      internalAnchorCount: generationContext.internalAnchorLines.length,
      returnedAnchorLines,
      acceptedAnchorLines,
      primaryProposalReturned,
      primaryProposalAccepted,
      primaryProposalMissing,
      primaryDiscardReason,
      rawProposalCount: parsed.proposals.length,
      discardedCount: validated.discarded.length,
      discardHistogram,
    })
    logCommentStage(input.output, requestTrace, "store.done", {
      pendingCount: input.store.pendingForDocument(generationContext.uri).length,
      source: generationContext.source,
      uriHash: shortHash(generationContext.uri),
      preservedExisting: input.forceRegenerate === true,
    })
    logCommentStage(input.output, requestTrace, "ui.done", {
      visibleEditorsForDocument: vscode.window.visibleTextEditors.filter((item) => item.document.uri.toString() === generationContext.uri).length,
      source: generationContext.source,
      pendingVisibleCount: input.store.pendingForDocument(generationContext.uri).length,
    })
    void vscode.window.showInformationMessage("没有生成 AI 注释候选。详细诊断请查看 ChipMate Comment 输出。")
    return
  }
  input.store.replacePendingForDocument(generationContext.uri, proposals)
  logCommentStage(input.output, requestTrace, "store.done", {
    pendingCount: input.store.pendingForDocument(generationContext.uri).length,
    source: generationContext.source,
    uriHash: shortHash(generationContext.uri),
  })
  logCommentStage(input.output, requestTrace, "ui.done", {
    visibleEditorsForDocument: vscode.window.visibleTextEditors.filter((item) => item.document.uri.toString() === generationContext.uri).length,
    source: generationContext.source,
    pendingVisibleCount: input.store.pendingForDocument(generationContext.uri).length,
  })
  finishProgress(input.reviewPanel, progress, "succeeded", "proposals-stored", `已生成 ${proposals.length} 条注释候选`, tokenUsage)
  input.reviewPanel?.clearGeneration?.(generationContext.uri)
  logCommentOutcome(input.output, requestTrace, "proposals-stored", `已存储 ${proposals.length} 条注释候选`, {
    proposalCount: proposals.length,
    source: generationContext.source,
    selectionIntent: generationContext.selectionIntent,
    proposalBudget: generationContext.proposalBudget,
    primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
    primaryAnchorLine: generationContext.primaryAnchorLine,
    primaryAnchorKind: generationContext.primaryAnchorKind,
    internalAnchorCount: generationContext.internalAnchorLines.length,
    returnedAnchorLines,
    acceptedAnchorLines,
    primaryProposalReturned,
    primaryProposalAccepted,
    primaryProposalMissing,
    primaryDiscardReason,
  })
  input.reviewPanel?.openForDocument?.(generationContext.uri, proposals[0]?.id)
  vscode.window.setStatusBarMessage(`已生成 ${proposals.length} 条 AI 注释候选。`, 2500)
}

export async function regenerateFromProposal(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  proposalId?: string
  target?: CommentReviewRegenerateTarget
  extensionVersion?: string
  generate: (editor: vscode.TextEditor, trace: CommentGenerationTraceContext, selection: vscode.Selection, source: CommentReviewSource) => Promise<void>
}) {
  const trace = createCommentTraceContext(input.extensionVersion)
  logCommentStage(input.output, trace, "command.start")
  const proposalId = input.proposalId
  const proposal = proposalId ? input.store.get(proposalId) : undefined
  const target = input.target ?? (proposal && proposal.status === "pending" ? regenerateTargetFromProposal(proposal) : undefined)
  if (!target) {
    logCommentStage(input.output, trace, "regenerate.target.missing", {
      proposalIdHash: proposalId ? shortHash(proposalId) : "missing",
    })
    logCommentOutcome(input.output, trace, "selection-invalid", "未找到可重新生成的 AI 注释候选")
    vscode.window.setStatusBarMessage("未找到可重新生成的 AI 注释候选。", 2500)
    return
  }

  const editor = await editorForRegenerateTarget(target)
  if (!editor) {
    logCommentStage(input.output, trace, "regenerate.target.stale", {
      proposalIdHash: target.proposalId ? shortHash(target.proposalId) : "missing",
      uriHash: shortHash(target.uri),
      reason: "selection-range-unavailable",
      selectionStartLine: target.selectionStartLine,
      selectionTextEndLine: target.selectionTextEndLine,
    })
    logCommentOutcome(input.output, trace, "selection-invalid", "原始选区已不可用")
    void vscode.window.showInformationMessage("原始选区已不可用，请重新选择代码后生成 AI 注释。")
    return
  }

  logCommentStage(input.output, trace, "regenerate.target.ready", {
    proposalIdHash: target.proposalId ? shortHash(target.proposalId) : "missing",
    uriHash: shortHash(target.uri),
    documentVersion: editor.document.version,
    source: target.source,
    selectionStartLine: target.selectionStartLine,
    selectionEndLine: target.selectionEndLine,
    selectionTextEndLine: target.selectionTextEndLine,
    selectionTextEndCharacter: target.selectionTextEndCharacter,
  })
  const clearedPendingCount = input.store.pendingForDocument(target.uri).length
  input.store.clearPendingForDocument(target.uri)
  logCommentStage(input.output, trace, "regenerate.clearPrevious", {
    uriHash: shortHash(target.uri),
    clearedPendingCount,
  })
  await input.generate(editor, trace, editor.selection, target.source)
}

export async function previewProposal(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  reviewPanel?: Pick<CommentReviewPanel, "openForProposal">
  proposalId?: string
}) {
  const proposal = resolveTargetProposal(input.store, input.proposalId)
  if (!proposal) {
    vscode.window.setStatusBarMessage("未找到 AI 注释候选。", 2500)
    return
  }
  if (input.reviewPanel) {
    input.reviewPanel.openForProposal(proposal.id)
    log(input.output, `已打开注释候选面板 proposal id=${proposal.id}`)
    return
  }
  const detail = commentPreviewDetail(proposal)
  const selected = await vscode.window.showInformationMessage("AI 注释候选", {
    modal: true,
    detail,
  }, "接受", "拒绝", "关闭")

  if (!selected || selected === "关闭") {
    log(input.output, `预览已关闭 proposal id=${proposal.id}`)
    return
  }
  if (selected === "接受") {
    await acceptProposal(input)
    return
  }
  rejectProposal(input)
}

export async function acceptProposal(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  proposalId?: string
}) {
  const proposal = resolveTargetProposal(input.store, input.proposalId)
  if (!proposal) {
    vscode.window.setStatusBarMessage("未找到 AI 注释候选。", 2500)
    return
  }
  const document = await documentForProposal(proposal)
  if (!document) {
    void vscode.window.showErrorMessage("请先打开目标文件，再接受这条 AI 注释。")
    return
  }
  const result = await applyCommentProposal(proposal, document)
  if (result.status === "applied") {
    input.store.updateStatus(proposal.id, "accepted")
    log(input.output, `已接受 proposal id=${proposal.id} line=${proposal.insertBeforeLine}`)
    vscode.window.setStatusBarMessage("已接受 AI 注释候选。", 2500)
    return
  }
  if (result.status === "stale") {
    input.store.updateStatus(proposal.id, "stale")
    log(input.output, `注释候选已过期 proposal id=${proposal.id} reason=${result.reason}`)
    void vscode.window.showWarningMessage("AI 注释候选已过期，请重新生成。")
    return
  }
  log(input.output, `应用失败 proposal id=${proposal.id} reason=${result.reason}`)
  void vscode.window.showErrorMessage("应用 AI 注释候选失败。")
}

export async function acceptAllPendingForCurrentReviewFile(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  uri?: string
}) {
  const uri = input.uri ?? vscode.window.activeTextEditor?.document.uri.toString()
  if (!uri) {
    void vscode.window.showErrorMessage("请先打开文件，再接受全部 AI 注释。")
    return
  }
  const proposals = input.store.pendingForDocument(uri)
  log(input.output, `acceptAll.start pendingCount=${proposals.length} uriHash=${shortHash(uri)}`)
  if (!proposals.length) {
    vscode.window.setStatusBarMessage("当前文件没有待接受的 AI 注释候选。", 2500)
    log(input.output, `acceptAll.done acceptedCount=0 skippedCount=0 uriHash=${shortHash(uri)}`)
    return
  }
  const document = await documentForProposal(proposals[0])
  if (!document) {
    void vscode.window.showErrorMessage("无法打开 AI 注释候选所在文件。")
    log(input.output, `acceptAll.done acceptedCount=0 skippedCount=${proposals.length} uriHash=${shortHash(uri)} reason=document-open-failed`)
    return
  }
  const result = await applyCommentProposals(proposals, document)
  for (const proposal of result.accepted) {
    input.store.updateStatus(proposal.id, "accepted")
    log(input.output, `acceptAll.item.done proposalIdHash=${shortHash(proposal.id)} line=${proposal.insertBeforeLine}`)
  }
  for (const skipped of result.skipped) {
    if (skipped.status === "stale") input.store.updateStatus(skipped.proposal.id, "stale")
    log(input.output, [
      "acceptAll.item.skipped",
      `proposalIdHash=${shortHash(skipped.proposal.id)}`,
      `line=${skipped.proposal.insertBeforeLine}`,
      `reason=${skipped.reason}`,
    ].join(" "))
  }
  log(input.output, [
    "acceptAll.done",
    `acceptedCount=${result.accepted.length}`,
    `skippedCount=${result.skipped.length}`,
    `uriHash=${shortHash(uri)}`,
  ].join(" "))
  vscode.window.setStatusBarMessage(`已接受 ${result.accepted.length} 条，${result.skipped.length} 条已跳过。`, 3500)
}

export function rejectProposal(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  proposalId?: string
}) {
  const proposal = resolveTargetProposal(input.store, input.proposalId)
  if (!proposal) {
    vscode.window.setStatusBarMessage("未找到 AI 注释候选。", 2500)
    return
  }
  input.store.updateStatus(proposal.id, "rejected")
  log(input.output, `已拒绝 proposal id=${proposal.id} line=${proposal.insertBeforeLine}`)
  vscode.window.setStatusBarMessage("已拒绝 AI 注释候选。", 2500)
}

export async function revealProposal(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
  proposalId?: string
}) {
  const proposal = resolveTargetProposal(input.store, input.proposalId)
  if (!proposal) {
    vscode.window.setStatusBarMessage("未找到 AI 注释候选。", 2500)
    return
  }
  const document = await documentForProposal(proposal, true)
  if (!document) {
    void vscode.window.showErrorMessage("无法打开 AI 注释候选所在文件。")
    return
  }
  log(input.output, `已定位 proposal id=${proposal.id} line=${proposal.insertBeforeLine}`)
}

export function clearCurrentFile(input: {
  output: vscode.OutputChannel
  store: CommentProposalStore
}) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showErrorMessage("请先打开文件，再清除 AI 注释候选。")
    return
  }
  const changed = input.store.clearPendingForDocument(editor.document.uri.toString())
  log(input.output, `已清除注释候选 uri=${editor.document.uri.toString()} changed=${changed}`)
  vscode.window.setStatusBarMessage("已清除 AI 注释候选。", 2500)
}

function createGenerationProgress(traceId: string, context: CommentGenerationContext): CommentGenerationProgressState {
  return {
    traceId,
    uri: context.uri,
    source: context.source,
    fileLabel: context.workspacePath || context.filePath,
    uriHash: shortHash(context.uri),
    status: "running",
    currentStage: "准备生成 AI 注释",
    startedAt: Date.now(),
    steps: [
      { id: "selection", label: "确认选区", status: "pending" },
      { id: "anchors", label: "计算结构锚点", status: "pending" },
      { id: "tools", label: "模型检索本地证据", status: "pending" },
      { id: "evidence", label: "汇总工具证据", status: "pending" },
      { id: "model", label: "请求模型生成候选", status: "pending" },
      { id: "parse", label: "解析 JSON 候选", status: "pending" },
      { id: "validate", label: "校验候选安全性", status: "pending" },
    ],
  }
}

function reviewSourceLabel(source: CommentReviewSource) {
  return source === "currentFunction" ? "当前函数" : "选区"
}

async function collectLegacyEvidenceForGeneration(input: {
  output: vscode.OutputChannel
  evidenceService: Pick<CommentEvidenceService, "collect">
  reviewPanel?: Partial<Pick<CommentReviewPanel, "updateGeneration">>
  context: CommentGenerationContext
  requestTrace: CommentGenerationTraceContext
  progress: CommentGenerationProgressState
}): Promise<CommentGenerationContext | undefined> {
  let evidence: Awaited<ReturnType<CommentEvidenceService["collect"]>>
  try {
    evidence = await input.evidenceService.collect(input.context, (event) => {
      logCommentStage(input.output, input.requestTrace, event.stage, event.fields)
      updateEvidenceProgress(input.reviewPanel, input.progress, event.stage, event.fields)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateProgress(input.reviewPanel, input.progress, "evidence", "检索仓库证据", "failed", { detail: message })
    finishProgress(input.reviewPanel, input.progress, "failed", "evidence-unavailable", message)
    logCommentStage(input.output, input.requestTrace, "evidence.error", { message })
    logCommentOutcome(input.output, input.requestTrace, "evidence-unavailable", message)
    void vscode.window.showErrorMessage("AI 注释证据检索失败。请查看 ChipMate Comment 输出。")
    return undefined
  }
  if (!evidence.ok) {
    const terminalReason: CommentGenerationTerminalReason = evidence.reason === "no-graph-evidence"
      ? "evidence-no-graph-results"
      : "evidence-unavailable"
    finishProgress(input.reviewPanel, input.progress, "failed", terminalReason, evidence.message)
    logCommentStage(input.output, input.requestTrace, "evidence.done", {
      success: false,
      reason: evidence.reason,
      graphMs: evidence.graphElapsedMs ?? 0,
      hybridMs: evidence.hybridElapsedMs ?? 0,
      fallback: evidence.fallbackReason ?? "none",
      graphSummaryFunctionCount: evidence.graphSummaryFunctionCount,
      graphSummaryModuleCount: evidence.graphSummaryModuleCount,
      graphSummaryStateMachineCount: evidence.graphSummaryStateMachineCount,
      graphDirectRefCount: evidence.graphDirectRefCount,
      ragRefCount: evidence.ragRefCount,
      missingEvidenceCount: evidence.missingEvidenceCount,
      identifierCount: evidence.identifierCount,
      anchorCount: evidence.anchorCount,
      outputDirective: evidence.outputDirective,
      groundingConfidence: evidence.groundingConfidence,
      groundingSummary: evidence.groundingSummary,
      evidenceCompacted: evidence.evidenceCompacted,
      source: input.context.source,
      selectionIntent: input.context.selectionIntent,
      primaryAnchorLine: input.context.primaryAnchorLine,
      primaryAnchorKind: input.context.primaryAnchorKind,
      internalAnchorCount: input.context.internalAnchorLines.length,
    })
    logCommentOutcome(input.output, input.requestTrace, terminalReason, evidence.message, {
      fallback: evidence.fallbackReason ?? "none",
    })
    void vscode.window.showInformationMessage(evidence.message)
    return undefined
  }
  updateProgress(input.reviewPanel, input.progress, "evidence", "汇总仓库证据", "done", {
    detail: `${evidence.retrievalMode} · ${evidence.evidenceItemCount} 条证据`,
    elapsedMs: evidence.graphElapsedMs + (evidence.hybridElapsedMs ?? 0),
  })
  const generationContext: CommentGenerationContext = {
    ...input.context,
    retrievalMode: evidence.retrievalMode,
    outputDirective: evidence.outputDirective,
    groundingConfidence: evidence.groundingConfidence,
    groundingSummary: evidence.groundingSummary,
    evidenceCompacted: evidence.evidenceCompacted,
    evidenceSections: evidence.evidenceSections,
    evidenceSummary: evidence.evidenceSummary,
    evidenceItemCount: evidence.evidenceItemCount,
    primaryAnchorPolicy: commentPrimaryAnchorPolicy(input.context.selectionIntent, evidence.groundingConfidence),
  }
  logCommentStage(input.output, input.requestTrace, "evidence.done", {
    success: true,
    retrievalMode: generationContext.retrievalMode,
    evidenceItems: generationContext.evidenceItemCount,
    evidenceSummaryBytes: evidence.evidenceSummaryBytes,
    graphMs: evidence.graphElapsedMs,
    hybridMs: evidence.hybridElapsedMs ?? 0,
    fallback: evidence.fallbackReason ?? "none",
    graphSummaryFunctionCount: evidence.graphSummaryFunctionCount,
    graphSummaryModuleCount: evidence.graphSummaryModuleCount,
    graphSummaryStateMachineCount: evidence.graphSummaryStateMachineCount,
    graphDirectRefCount: evidence.graphDirectRefCount,
    ragRefCount: evidence.ragRefCount,
    missingEvidenceCount: evidence.missingEvidenceCount,
    identifierCount: evidence.identifierCount,
    anchorCount: evidence.anchorCount,
    outputDirective: generationContext.outputDirective,
    groundingConfidence: generationContext.groundingConfidence,
    groundingSummary: generationContext.groundingSummary,
    evidenceCompacted: generationContext.evidenceCompacted,
    source: generationContext.source,
    selectionIntent: generationContext.selectionIntent,
    proposalBudget: generationContext.proposalBudget,
    primaryAnchorPolicy: generationContext.primaryAnchorPolicy,
    primaryAnchorLine: generationContext.primaryAnchorLine,
    primaryAnchorKind: generationContext.primaryAnchorKind,
    internalAnchorCount: generationContext.internalAnchorLines.length,
  })
  return generationContext
}

function updateEvidenceProgress(
  panel: CommentProgressPanel | undefined,
  progress: CommentGenerationProgressState,
  stage: string,
  fields: Record<string, unknown> | undefined,
) {
  if (stage === "evidence.graph.start") {
    updateProgress(panel, progress, "graph", "检索 CodeGraph 证据", "running", {
      detail: countDetail(fields, "identifierCount", "标识符", "anchorCount", "锚点"),
    })
    return
  }
  if (stage === "evidence.graph.done") {
    updateProgress(panel, progress, "graph", "检索 CodeGraph 证据", "done", {
      detail: countDetail(fields, "graphDirectRefCount", "直接引用", "graphSummaryFunctionCount", "函数摘要"),
      elapsedMs: numberField(fields, "elapsedMs"),
    })
    return
  }
  if (stage === "evidence.graph.unavailable") {
    updateProgress(panel, progress, "graph", "检索 CodeGraph 证据", "failed", {
      detail: stringField(fields, "reason") || "CodeGraph 暂不可用",
    })
    return
  }
  if (stage === "evidence.hybrid.start") {
    updateProgress(panel, progress, "rag", "补充 RAG 证据", "running", {
      detail: "RAG ready，正在补充语义证据",
    })
    return
  }
  if (stage === "evidence.hybrid.done") {
    updateProgress(panel, progress, "rag", "补充 RAG 证据", "done", {
      detail: countDetail(fields, "ragRefCount", "RAG 引用", "missingEvidenceCount", "缺失证据"),
      elapsedMs: numberField(fields, "elapsedMs"),
    })
    return
  }
  if (stage === "evidence.hybrid.fallback") {
    updateProgress(panel, progress, "rag", "补充 RAG 证据", "skipped", {
      detail: `已回退到 graph-only：${stringField(fields, "reason") || "hybrid 检索失败"}`,
      elapsedMs: numberField(fields, "elapsedMs"),
    })
  }
}

function updateModelProgress(
  panel: CommentProgressPanel | undefined,
  progress: CommentGenerationProgressState,
  stage: string,
  fields: Record<string, unknown> | undefined,
) {
  const usage = tokenUsageFromFields(fields)
  if (usage) progress.tokenUsage = usage
  if (stage === "model.stream.delta") {
    const stream = streamStateFromFields(fields)
    if (stream) progress.stream = stream
    const status = stream?.phase === "done"
      ? "done"
      : stream?.phase === "failed"
        ? "failed"
        : "running"
    const label = stream?.phase === "normalizing" ? "归一化模型输出" : "接收模型输出"
    updateProgress(panel, progress, "model", label, status, {
      detail: streamDetail(stream),
      elapsedMs: stream?.elapsedMs,
    })
    return
  }
  if (stage === "model.http.prepare") {
    updateProgress(panel, progress, "model", "准备模型请求", "running", {
      detail: "已省略 max_tokens，等待真实 token usage",
    })
    return
  }
  if (stage === "model.http.fetch.start") {
    updateProgress(panel, progress, "model", "请求模型生成候选", "running", {
      detail: "请求已发出",
    })
    return
  }
  if (stage === "model.http.stream.firstChunk") {
    updateProgress(panel, progress, "model", "接收模型输出", "running", {
      detail: "已收到首个流式响应 chunk",
      elapsedMs: numberField(fields, "elapsedMs"),
    })
    return
  }
  if (stage === "model.response.normalize") {
    updateProgress(panel, progress, "model", "归一化模型输出", "running", {
      detail: `JSON 字节 ${numberField(fields, "normalizedTextBytes") ?? 0}`,
      elapsedMs: numberField(fields, "elapsedMs"),
    })
    return
  }
  if (stage === "model.http.stream.done") {
    updateProgress(panel, progress, "model", "接收模型输出", "done", {
      detail: usage?.usageAvailable ? "已收到 token usage" : "后端未返回 token usage",
      elapsedMs: numberField(fields, "elapsedMs"),
    })
  }
}

function updateToolProgress(
  panel: CommentProgressPanel | undefined,
  progress: CommentGenerationProgressState,
  stage: string,
  fields: Record<string, unknown> | undefined,
) {
  const tools = progress.tools ?? { entries: [] }
  progress.tools = tools
  if (stage === "tool.loop.start") {
    tools.roundCount = 0
    tools.toolCallCount = 0
    tools.blockedToolCount = 0
    tools.failedToolCount = 0
    tools.evidenceItemCount = 0
    updateProgress(panel, progress, "tools", "模型检索本地证据", "running", {
      detail: `${numberField(fields, "readableToolCount") ?? 0} 个只读工具可用`,
    })
    return
  }
  if (stage === "tool.loop.round.start") {
    tools.roundCount = (numberField(fields, "roundIndex") ?? 0) + 1
    updateProgress(panel, progress, "tools", "模型检索本地证据", "running", {
      detail: `第 ${tools.roundCount} 轮工具规划`,
    })
    return
  }
  if (stage === "tool.call.start") {
    const toolName = stringField(fields, "toolName") || "unknown"
    tools.latestToolName = toolName
    tools.latestStatus = "running"
    tools.entries.push({ toolName, status: "running" })
    tools.entries = tools.entries.slice(-8)
    updateProgress(panel, progress, "tools", "模型检索本地证据", "running", {
      detail: `正在执行 ${toolName}`,
    })
    return
  }
  if (stage === "tool.call.done" || stage === "tool.call.blocked" || stage === "tool.call.failed") {
    const toolName = stringField(fields, "toolName") || "unknown"
    const status: CommentGenerationToolState["entries"][number]["status"] = stage === "tool.call.done"
      ? "done"
      : stage === "tool.call.blocked"
        ? "blocked"
        : "failed"
    tools.latestToolName = toolName
    tools.latestStatus = status
    tools.latestDetail = stringField(fields, "reason")
    tools.toolCallCount = (tools.toolCallCount ?? 0) + (stage === "tool.call.done" || stage === "tool.call.failed" || stage === "tool.call.blocked" ? 1 : 0)
    if (status === "blocked") tools.blockedToolCount = (tools.blockedToolCount ?? 0) + 1
    if (status === "failed") tools.failedToolCount = (tools.failedToolCount ?? 0) + 1
    const evidenceItemCount = numberField(fields, "evidenceItemCount")
    if (typeof evidenceItemCount === "number") tools.evidenceItemCount = (tools.evidenceItemCount ?? 0) + evidenceItemCount
    const existing = [...tools.entries].reverse().find((entry) => entry.toolName === toolName && entry.status === "running")
    if (existing) {
      existing.status = status
      existing.elapsedMs = numberField(fields, "elapsedMs")
      existing.evidenceItemCount = evidenceItemCount
      existing.detail = status === "blocked" ? "权限或安全规则阻止" : status === "failed" ? "执行失败" : undefined
    } else {
      tools.entries.push({
        toolName,
        status,
        elapsedMs: numberField(fields, "elapsedMs"),
        evidenceItemCount,
        detail: status === "blocked" ? "权限或安全规则阻止" : status === "failed" ? "执行失败" : undefined,
      })
    }
    tools.entries = tools.entries.slice(-8)
    updateProgress(panel, progress, "tools", "模型检索本地证据", status === "failed" ? "failed" : "running", {
      detail: `${toolName} · ${toolStatusText(status)}`,
      elapsedMs: numberField(fields, "elapsedMs"),
    })
    return
  }
  if (stage === "tool.loop.done") {
    tools.roundCount = numberField(fields, "roundCount") ?? tools.roundCount
    tools.toolCallCount = numberField(fields, "toolCallCount") ?? tools.toolCallCount
    tools.blockedToolCount = numberField(fields, "blockedToolCount") ?? tools.blockedToolCount
    tools.failedToolCount = numberField(fields, "failedToolCount") ?? tools.failedToolCount
    tools.evidenceItemCount = numberField(fields, "evidenceItemCount") ?? tools.evidenceItemCount
    updateProgress(panel, progress, "tools", "模型检索本地证据", fields?.success === false ? "failed" : "done", {
      detail: `${tools.toolCallCount ?? 0} 次工具调用 · ${tools.evidenceItemCount ?? 0} 条证据`,
      elapsedMs: numberField(fields, "elapsedMs"),
    })
  }
}

function toolStatusText(status: CommentGenerationToolState["entries"][number]["status"]) {
  if (status === "done") return "完成"
  if (status === "blocked") return "已阻止"
  if (status === "failed") return "失败"
  return "执行中"
}

function emptyArrayTerminalReason(retrievalMode: CommentGenerationContext["retrievalMode"]): CommentGenerationTerminalReason {
  if (retrievalMode === "hybrid") return "hybrid-returned-empty-array"
  if (retrievalMode === "graph-only") return "graph-only-returned-empty-array"
  return "tool-driven-returned-empty-array"
}

function updateProgress(
  panel: CommentProgressPanel | undefined,
  progress: CommentGenerationProgressState,
  stepId: string,
  label: string,
  status: CommentGenerationProgressStep["status"],
  input: { detail?: string; elapsedMs?: number } = {},
) {
  const step = progress.steps.find((item) => item.id === stepId)
  if (step) {
    step.label = label
    step.status = status
    step.detail = input.detail
    step.elapsedMs = input.elapsedMs
  } else {
    progress.steps.push({ id: stepId, label, status, detail: input.detail, elapsedMs: input.elapsedMs })
  }
  progress.currentStage = label
  panel?.updateGeneration?.(progress)
}

function finishProgress(
  panel: CommentProgressPanel | undefined,
  progress: CommentGenerationProgressState,
  status: CommentGenerationProgressState["status"],
  terminalReason: string,
  detail: string,
  tokenUsage?: CommentGenerationTokenUsage,
) {
  progress.status = status
  progress.currentStage = status === "succeeded" ? "已生成 AI 注释候选" : status === "empty" ? "没有生成候选" : "生成结束"
  progress.finishedAt = Date.now()
  progress.terminalReason = terminalReason
  progress.detail = detail
  if (tokenUsage) progress.tokenUsage = tokenUsage
  if (progress.stream) {
    progress.stream = {
      ...progress.stream,
      phase: status === "failed" ? "failed" : "done",
      updatedAt: Date.now(),
    }
  }
  panel?.updateGeneration?.(progress)
}

function streamStateFromFields(fields: Record<string, unknown> | undefined): CommentGenerationStreamState | undefined {
  if (!fields) return undefined
  const phaseValue = stringField(fields, "streamPhase")
  const phase = isStreamPhase(phaseValue) ? phaseValue : "waiting"
  return {
    phase,
    elapsedMs: numberField(fields, "elapsedMs"),
    deltaCount: numberField(fields, "deltaCount"),
    rawBytes: numberField(fields, "rawBytes"),
    visibleBytes: numberField(fields, "visibleBytes"),
    reasoningBytes: numberField(fields, "reasoningBytes"),
    reasoningPreview: stringField(fields, "reasoningPreview"),
    visiblePreview: stringField(fields, "visiblePreview"),
    jsonPrefixGuard: stringField(fields, "jsonPrefixGuard"),
    finishReason: stringField(fields, "finishReason"),
    updatedAt: numberField(fields, "updatedAt") ?? Date.now(),
  }
}

function isStreamPhase(input: string | undefined): input is CommentGenerationStreamState["phase"] {
  return input === "waiting"
    || input === "thinking"
    || input === "receiving-json"
    || input === "normalizing"
    || input === "done"
    || input === "failed"
}

function streamDetail(stream: CommentGenerationStreamState | undefined) {
  if (!stream) return "等待模型流式输出"
  const phase = stream.phase === "thinking"
    ? "模型 thinking 中"
    : stream.phase === "receiving-json"
      ? "正在接收 JSON"
      : stream.phase === "normalizing"
        ? "正在归一化输出"
        : stream.phase === "done"
          ? "流式输出完成"
          : stream.phase === "failed"
            ? "流式输出失败"
            : "等待首个 chunk"
  const chunks = typeof stream.deltaCount === "number" ? ` · ${stream.deltaCount} chunks` : ""
  const bytes = typeof stream.visibleBytes === "number" ? ` · JSON ${stream.visibleBytes} bytes` : ""
  return `${phase}${chunks}${bytes}`
}

function tokenUsageFromFields(fields: Record<string, unknown> | undefined): CommentGenerationTokenUsage | undefined {
  if (!fields || typeof fields.usageAvailable !== "boolean") return undefined
  return {
    usageAvailable: fields.usageAvailable,
    usagePromptTokens: numberField(fields, "usagePromptTokens"),
    usageCompletionTokens: numberField(fields, "usageCompletionTokens"),
    usageTotalTokens: numberField(fields, "usageTotalTokens"),
    usageReasoningTokens: numberField(fields, "usageReasoningTokens"),
    usageTextTokens: numberField(fields, "usageTextTokens"),
  }
}

function countDetail(fields: Record<string, unknown> | undefined, firstKey: string, firstLabel: string, secondKey: string, secondLabel: string) {
  const first = numberField(fields, firstKey) ?? 0
  const second = numberField(fields, secondKey) ?? 0
  return `${first} ${firstLabel} · ${second} ${secondLabel}`
}

function numberField(fields: Record<string, unknown> | undefined, key: string) {
  const value = fields?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringField(fields: Record<string, unknown> | undefined, key: string) {
  const value = fields?.[key]
  return typeof value === "string" ? value : undefined
}

function log(output: vscode.OutputChannel, message: string) {
  output.appendLine(`${COMMENT_LOG_PREFIX} ${message}`)
}

async function documentForProposal(proposal: CommentProposal, revealOnly = false) {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor?.document.uri.toString() === proposal.uri) {
    if (revealOnly) revealEditorProposal(activeEditor, proposal)
    return activeEditor.document
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(proposal.uri))
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(proposal.insertBeforeLine, 0, proposal.insertBeforeLine, 0),
    })
    revealEditorProposal(editor, proposal)
    return document
  } catch {
    return undefined
  }
}

function regenerateTargetFromProposal(proposal: CommentProposal): CommentReviewRegenerateTarget {
  return {
    proposalId: proposal.id,
    uri: proposal.uri,
    source: proposal.source,
    selectionStartLine: proposal.selectionStartLine,
    selectionEndLine: proposal.selectionEndLine,
    selectionStartCharacter: proposal.selectionStartCharacter,
    selectionEndCharacter: proposal.selectionEndCharacter,
    selectionTextEndLine: proposal.selectionTextEndLine,
    selectionTextEndCharacter: proposal.selectionTextEndCharacter,
  }
}

async function editorForRegenerateTarget(target: CommentReviewRegenerateTarget) {
  const activeEditor = vscode.window.activeTextEditor
  const document = activeEditor?.document.uri.toString() === target.uri
    ? activeEditor.document
    : await openProposalDocument(target.uri)
  if (!document || !isRegenerateTargetSelectionInDocument(target, document)) return undefined

  const selection = new vscode.Selection(
    target.selectionStartLine,
    target.selectionStartCharacter,
    target.selectionTextEndLine,
    target.selectionTextEndCharacter,
  )
  const editor = activeEditor?.document.uri.toString() === target.uri
    ? activeEditor
    : await showProposalDocumentSelection(document, selection)
  if (!editor) return undefined
  editor.selection = selection
  revealEditorSelection(editor, selection)
  return editor
}

async function openProposalDocument(uri: string) {
  try {
    return await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
  } catch {
    return undefined
  }
}

async function showProposalDocumentSelection(document: vscode.TextDocument, selection: vscode.Selection) {
  try {
    return await vscode.window.showTextDocument(document, {
      preview: false,
      selection,
    })
  } catch {
    return undefined
  }
}

function isRegenerateTargetSelectionInDocument(target: CommentReviewRegenerateTarget, document: vscode.TextDocument) {
  if (target.selectionStartLine < 0 || target.selectionTextEndLine < target.selectionStartLine) return false
  if (target.selectionTextEndLine >= document.lineCount) return false
  const startLineLength = document.lineAt(target.selectionStartLine).text.length
  const endLineLength = document.lineAt(target.selectionTextEndLine).text.length
  return target.selectionStartCharacter >= 0
    && target.selectionStartCharacter <= startLineLength
    && target.selectionTextEndCharacter >= 0
    && target.selectionTextEndCharacter <= endLineLength
}

function revealEditorProposal(editor: vscode.TextEditor, proposal: CommentProposal) {
  const document = editor.document
  const line = Math.min(Math.max(proposal.insertBeforeLine, 0), Math.max(document.lineCount - 1, 0))
  const text = document.lineAt(line).text
  const range = new vscode.Range(line, 0, line, Math.max(text.length, 0))
  editor.revealRange?.(range, revealInCenterType())
}

function revealEditorSelection(editor: vscode.TextEditor, selection: vscode.Selection) {
  editor.revealRange?.(selection, revealInCenterType())
}

function revealInCenterType() {
  return (vscode.TextEditorRevealType as typeof vscode.TextEditorRevealType | undefined)?.InCenterIfOutsideViewport
}

function buildStoredProposals(raw: RawCommentProposal[], context: CommentGenerationContext): CommentProposal[] {
  return raw.map((proposal, index) => ({
    ...proposal,
    id: `comment-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    uri: context.uri,
    source: context.source,
    documentVersion: context.documentVersion,
    selectionStartLine: context.selectionStartLine,
    selectionEndLine: context.selectionEndLine,
    selectionStartCharacter: context.selectionStartCharacter,
    selectionEndCharacter: context.selectionEndCharacter,
    selectionTextEndLine: context.selectionTextEndLine,
    selectionTextEndCharacter: context.selectionTextEndCharacter,
    contextHash: context.contextHash,
    status: "pending",
  }))
}

function proposalEvidenceCounts(proposals: RawCommentProposal[]) {
  let evidenceSpanCount = 0
  let selectionEvidenceCount = 0
  let repositoryEvidenceCount = 0
  for (const proposal of proposals) {
    for (const evidence of proposal.codeEvidence ?? []) {
      evidenceSpanCount += 1
      if (evidence.source === "selection") selectionEvidenceCount += 1
      if (evidence.source === "repository") repositoryEvidenceCount += 1
    }
  }
  return { evidenceSpanCount, selectionEvidenceCount, repositoryEvidenceCount }
}

function proposalAnchorLines(proposals: RawCommentProposal[]) {
  return [...new Set(proposals
    .map((proposal) => proposal.insertBeforeLine)
    .filter((line): line is number => Number.isInteger(line)))]
    .sort((left, right) => left - right)
}

function hasProposalAtLine(proposals: RawCommentProposal[], line: number | undefined) {
  return line !== undefined && proposals.some((proposal) => proposal.insertBeforeLine === line)
}

function primaryProposalDiscardReason(
  proposals: RawCommentProposal[],
  discarded: Array<{ index: number; reason: string }>,
  line: number | undefined,
) {
  if (line === undefined) return undefined
  const index = proposals.findIndex((proposal) => proposal.insertBeforeLine === line)
  if (index < 0) return undefined
  return discarded.find((item) => item.index === index)?.reason
}

function resolveTargetProposal(store: CommentProposalStore, proposalId?: string) {
  if (proposalId) return store.get(proposalId)
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined
  return store.pendingAtLine(editor.document.uri.toString(), editor.selection.active.line)
}

async function updateCommentContexts(store: CommentProposalStore) {
  const editor = vscode.window.activeTextEditor
  const supportedEditor = Boolean(editor && isSupportedCommentLanguage(editor.document.languageId))
  const pending = editor ? store.pendingForDocument(editor.document.uri.toString()) : []
  const cursorLine = editor?.selection.active.line ?? -1
  const cursorHasPendingSuggestion = pending.some((proposal) => proposal.insertBeforeLine === cursorLine)
  await vscode.commands.executeCommand("setContext", COMMENT_CONTEXT_SUPPORTED_EDITOR, supportedEditor)
  await vscode.commands.executeCommand("setContext", COMMENT_CONTEXT_HAS_PENDING_FILE, pending.length > 0)
  await vscode.commands.executeCommand("setContext", COMMENT_CONTEXT_HAS_PENDING_CURSOR, cursorHasPendingSuggestion)
}
