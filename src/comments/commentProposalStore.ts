import type { CommentGenerationContext, CommentProposal, CommentProposalStatus } from "./commentTypes"

type Listener = () => void

export class CommentProposalStore {
  private readonly proposals = new Map<string, CommentProposal>()
  private readonly listeners = new Set<Listener>()

  onDidChange(listener: Listener) {
    this.listeners.add(listener)
    return {
      dispose: () => this.listeners.delete(listener),
    }
  }

  dispose() {
    this.listeners.clear()
    this.proposals.clear()
  }

  replacePendingForDocument(uri: string, proposals: CommentProposal[]) {
    for (const [id, proposal] of this.proposals) {
      if (proposal.uri === uri && proposal.status === "pending") this.proposals.delete(id)
    }
    for (const proposal of proposals) this.proposals.set(proposal.id, proposal)
    this.emit()
  }

  replacePendingForWorkspaceUnit(uri: string, workspaceReviewUnitId: string, proposals: CommentProposal[]) {
    for (const [id, proposal] of this.proposals) {
      if (
        proposal.uri === uri &&
        proposal.status === "pending" &&
        proposal.source === "workspaceChanges" &&
        proposal.workspaceReviewUnitId === workspaceReviewUnitId
      ) {
        this.proposals.delete(id)
      }
    }
    for (const proposal of proposals) this.proposals.set(proposal.id, proposal)
    this.emit()
  }

  get(id: string) {
    return this.proposals.get(id)
  }

  updateStatus(id: string, status: CommentProposalStatus) {
    const proposal = this.proposals.get(id)
    if (!proposal) return false
    this.proposals.set(id, { ...proposal, status })
    this.emit()
    return true
  }

  clearPendingForDocument(uri: string) {
    let changed = false
    for (const [id, proposal] of this.proposals) {
      if (proposal.uri === uri && proposal.status === "pending") {
        this.proposals.delete(id)
        changed = true
      }
    }
    if (changed) this.emit()
    return changed
  }

  pendingForDocument(uri: string) {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.uri === uri && proposal.status === "pending")
      .sort((left, right) => left.insertBeforeLine - right.insertBeforeLine || left.id.localeCompare(right.id))
  }

  pendingWorkspaceChanges(diffHash?: string) {
    return [...this.proposals.values()]
      .filter((proposal) =>
        proposal.status === "pending" &&
        proposal.source === "workspaceChanges" &&
        (!diffHash || proposal.workspaceChangeDiffHash === diffHash)
      )
      .sort((left, right) =>
        left.uri.localeCompare(right.uri) ||
        left.insertBeforeLine - right.insertBeforeLine ||
        left.id.localeCompare(right.id)
      )
  }

  clearPendingWorkspaceChanges(diffHash?: string) {
    let count = 0
    for (const [id, proposal] of this.proposals) {
      if (
        proposal.status === "pending" &&
        proposal.source === "workspaceChanges" &&
        (!diffHash || proposal.workspaceChangeDiffHash === diffHash)
      ) {
        this.proposals.delete(id)
        count += 1
      }
    }
    if (count > 0) this.emit()
    return count
  }

  pendingForSelection(context: CommentGenerationContext) {
    return this.pendingForDocument(context.uri).filter((proposal) =>
      proposal.documentVersion === context.documentVersion
      && proposal.source === context.source
      && proposal.selectionStartLine === context.selectionStartLine
      && proposal.selectionEndLine === context.selectionEndLine
      && proposal.selectionStartCharacter === context.selectionStartCharacter
      && proposal.selectionEndCharacter === context.selectionEndCharacter
      && proposal.selectionTextEndLine === context.selectionTextEndLine
      && proposal.selectionTextEndCharacter === context.selectionTextEndCharacter
      && proposal.contextHash === context.contextHash
    )
  }

  hasPendingForDocument(uri: string) {
    return this.pendingForDocument(uri).length > 0
  }

  pendingAtLine(uri: string, line: number) {
    return this.pendingForDocument(uri).find((proposal) => proposal.insertBeforeLine === line)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}
