import * as vscode from "vscode"
import { shortHash } from "./commentDiagnostics"
import { commentPreviewText } from "./commentPreview"
import type { CommentProposalStore } from "./commentProposalStore"
import { createCommentReviewHtml, type CommentGenerationProgressState, type CommentReviewWebviewState, type CommentWorkspaceChangesWebviewState } from "./commentReviewHtml"
import type { CommentProposal, CommentReviewSource } from "./commentTypes"
import type { CommentWorkspaceChangesScanResult } from "./commentWorkspaceChanges"

type CommentReviewPanelMessage =
  | { type: "acceptProposal"; proposalId: string }
  | { type: "acceptAllProposals" }
  | { type: "analyzeWorkspaceChanges" }
  | { type: "generateWorkspaceChanges"; unitIds?: string[] }
  | { type: "undoLastBulkAccept" }
  | { type: "saveAllFiles" }
  | { type: "regenerateProposals" }
  | { type: "rejectProposal"; proposalId: string }
  | { type: "revealProposal"; proposalId: string }
  | { type: "closePanel" }

export type CommentReviewRegenerateTarget = {
  proposalId?: string
  uri: string
  source: CommentReviewSource
  selectionStartLine: number
  selectionEndLine: number
  selectionStartCharacter: number
  selectionEndCharacter: number
  selectionTextEndLine: number
  selectionTextEndCharacter: number
}

export type CommentReviewPanelInput = {
  extensionUri: vscode.Uri
  output: vscode.OutputChannel
  store: CommentProposalStore
  onAccept: (proposalId: string) => Promise<void>
  onAcceptAll: (uri: string) => Promise<void>
  onAcceptAllWorkspace?: () => Promise<void>
  onReject: (proposalId: string) => void
  onReveal: (proposalId: string) => Promise<void>
  onRegenerate: (target: CommentReviewRegenerateTarget) => Promise<void>
  onAnalyzeWorkspaceChanges: () => Promise<void>
  onGenerateWorkspaceChanges: (unitIds?: string[]) => Promise<void>
  onUndoLastBulkAccept?: () => Promise<void>
  onSaveAll?: () => Promise<void>
  canUndoLastBulkAccept?: () => boolean
}

export class CommentReviewPanel implements vscode.Disposable {
  static readonly viewType = "chipmate.commentReview"
  private panel?: vscode.WebviewPanel
  private currentUri?: string
  private selectedProposalId?: string
  private lastRegenerateTarget?: CommentReviewRegenerateTarget
  private generationProgress?: CommentGenerationProgressState
  private workspaceChanges?: CommentWorkspaceChangesWebviewState
  private workspaceDiffHash?: string
  private readonly storeSubscription: { dispose(): void }

  constructor(private readonly input: CommentReviewPanelInput) {
    this.storeSubscription = this.input.store.onDidChange(() => this.refresh())
  }

  openForDocument(uri: string, selectedProposalId?: string) {
    this.currentUri = uri
    if (selectedProposalId) this.selectedProposalId = selectedProposalId
    if (selectedProposalId) this.generationProgress = undefined
    const selectedProposal = selectedProposalId ? this.input.store.get(selectedProposalId) : undefined
    if (selectedProposal?.source !== "workspaceChanges") {
      this.workspaceChanges = undefined
      this.workspaceDiffHash = undefined
    }
    this.ensurePanel()
    this.panel?.reveal(reviewPanelColumn(), true)
    this.refresh()
  }

  openForGeneration(progress: CommentGenerationProgressState) {
    this.currentUri = progress.uri
    this.selectedProposalId = undefined
    this.generationProgress = progress
    if (progress.source !== "workspaceChanges") this.workspaceChanges = undefined
    this.ensurePanel()
    this.panel?.reveal(reviewPanelColumn(), true)
    this.refresh()
  }

  openForWorkspaceChanges(scan: CommentWorkspaceChangesScanResult) {
    if (!scan.ok) return
    this.currentUri = scan.units[0]?.uri
    this.selectedProposalId = undefined
    this.generationProgress = undefined
    this.workspaceDiffHash = scan.diffHash
    this.workspaceChanges = {
      diffHash: scan.diffHash,
      rootLabel: scan.rootPath,
      changedFileCount: scan.changedFileCount,
      hunkCount: scan.hunkCount,
      units: scan.units.map((unit) => ({
        id: unit.id,
        fileLabel: unit.relativePath,
        title: unit.title,
        unitKind: unit.unitKind,
        startLine: unit.range.startLine,
        endLine: unit.range.endLine,
        changedLineSpans: unit.changedLineSpans,
        hunkCount: unit.hunkCount,
      })),
      skipped: scan.skipped,
    }
    this.ensurePanel()
    this.panel?.reveal(reviewPanelColumn(), true)
    this.refresh()
  }

  updateGeneration(progress: CommentGenerationProgressState) {
    this.currentUri = progress.uri
    this.generationProgress = progress
    this.refresh()
  }

  clearGeneration(uri?: string) {
    if (!uri || this.generationProgress?.uri === uri) this.generationProgress = undefined
    this.refresh()
  }

  openForProposal(proposalId: string) {
    const proposal = this.input.store.get(proposalId)
    if (!proposal || proposal.status !== "pending") {
      vscode.window.setStatusBarMessage("未找到 AI 注释候选。", 2500)
      return
    }
    this.openForDocument(proposal.uri, proposal.id)
  }

  refresh() {
    if (!this.panel) return
    this.panel.webview.postMessage({
      type: "state",
      state: this.buildState(),
    })
  }

  dispose() {
    this.storeSubscription.dispose()
    this.panel?.dispose()
  }

  private ensurePanel() {
    if (this.panel) return
    this.panel = vscode.window.createWebviewPanel(
      CommentReviewPanel.viewType,
      "AI 注释候选",
      reviewPanelColumn(),
      {
        enableScripts: true,
        localResourceRoots: [this.input.extensionUri],
      },
    )
    this.panel.webview.html = createCommentReviewHtml(this.panel.webview.cspSource)
    this.panel.onDidDispose(() => {
      this.panel = undefined
    })
    this.panel.webview.onDidReceiveMessage((message: CommentReviewPanelMessage) => {
      void this.handleMessage(message)
    })
  }

  private buildState(): CommentReviewWebviewState {
    const uri = this.currentReviewUri()
    const isWorkspaceReview = !!this.workspaceChanges || this.generationProgress?.source === "workspaceChanges"
    const proposals = isWorkspaceReview
      ? this.input.store.pendingWorkspaceChanges(this.workspaceDiffHash)
      : uri ? this.input.store.pendingForDocument(uri) : []
    if (this.selectedProposalId && !proposals.some((proposal) => proposal.id === this.selectedProposalId)) {
      this.selectedProposalId = proposals[0]?.id
    }
    const progress = this.generationProgress?.uri === uri ? this.generationProgress : undefined
    const mode = this.workspaceChanges && !progress && proposals.length === 0
      ? "reviewChanges"
      : progress?.status === "running"
      ? "generating"
      : proposals.length > 0
      ? "review"
      : progress?.status === "failed"
        ? "failed"
        : progress?.status === "empty"
          ? "empty"
          : progress
            ? "generating"
            : "empty"

    return {
      mode,
      fileLabel: uri ? fileLabel(uri) : "当前文件",
      source: progress?.source ?? proposals[0]?.source ?? this.lastRegenerateTarget?.source,
      uriHash: uri ? shortHash(uri) : "",
      selectedProposalId: this.selectedProposalId,
      progress,
      workspaceChanges: this.workspaceChanges,
      canUndoLastBulkAccept: this.input.canUndoLastBulkAccept?.() ?? false,
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        fileLabel: fileLabel(proposal.uri),
        source: proposal.source,
        line: proposal.insertBeforeLine,
        kind: proposal.kind,
        confidence: proposal.confidence,
        summary: commentPreviewText(proposal.commentText),
        commentText: proposal.commentText,
        reason: proposal.reason,
        codeEvidence: proposal.codeEvidence,
        status: proposal.status,
      })),
    }
  }

  private async handleMessage(message: CommentReviewPanelMessage) {
    if (!message || typeof message.type !== "string") return
    if (message.type === "closePanel") {
      this.panel?.dispose()
      return
    }
    if (message.type === "acceptAllProposals") {
      if (this.workspaceChanges) {
        await this.input.onAcceptAllWorkspace?.()
        return
      }
      const uri = this.currentReviewUri()
      if (!uri) {
        vscode.window.setStatusBarMessage("未找到当前文件的 AI 注释候选。", 2500)
        return
      }
      await this.input.onAcceptAll(uri)
      return
    }
    if (message.type === "analyzeWorkspaceChanges") {
      await this.input.onAnalyzeWorkspaceChanges()
      return
    }
    if (message.type === "generateWorkspaceChanges") {
      await this.input.onGenerateWorkspaceChanges(Array.isArray(message.unitIds) ? message.unitIds : undefined)
      return
    }
    if (message.type === "undoLastBulkAccept") {
      await this.input.onUndoLastBulkAccept?.()
      return
    }
    if (message.type === "saveAllFiles") {
      await this.input.onSaveAll?.()
      return
    }
    if (message.type === "regenerateProposals") {
      const target = this.currentRegenerateTarget()
      if (!target) {
        vscode.window.setStatusBarMessage("未找到可重新生成的 AI 注释候选。", 2500)
        return
      }
      this.lastRegenerateTarget = target
      await this.input.onRegenerate(target)
      return
    }
    if (!("proposalId" in message) || typeof message.proposalId !== "string") return
    this.selectedProposalId = message.proposalId
    if (message.type === "acceptProposal") {
      await this.input.onAccept(message.proposalId)
      return
    }
    if (message.type === "rejectProposal") {
      this.input.onReject(message.proposalId)
      return
    }
    if (message.type === "revealProposal") {
      await this.input.onReveal(message.proposalId)
    }
  }

  private currentReviewUri() {
    const selectedProposal = this.selectedProposalId ? this.input.store.get(this.selectedProposalId) : undefined
    return selectedProposal?.uri ?? this.currentUri ?? vscode.window.activeTextEditor?.document.uri.toString() ?? ""
  }

  private currentRegenerateTarget() {
    const uri = this.currentReviewUri()
    if (!uri) return undefined
    const proposals = this.input.store.pendingForDocument(uri)
    const selectedProposal = this.selectedProposalId
      ? proposals.find((proposal) => proposal.id === this.selectedProposalId)
      : undefined
    const proposal = selectedProposal ?? proposals[0]
    if (proposal) return regenerateTargetFromProposal(proposal)
    if (this.lastRegenerateTarget?.uri === uri) return this.lastRegenerateTarget
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

function fileLabel(uriString: string) {
  try {
    return vscode.workspace.asRelativePath(vscode.Uri.parse(uriString))
  } catch {
    return uriString
  }
}

function reviewPanelColumn() {
  return vscode.ViewColumn?.Beside ?? 2
}
