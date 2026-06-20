import * as vscode from "vscode"
import { CHIPMATE_COMMANDS } from "../chipmate-constants"
import type { CommentProposalStore } from "./commentProposalStore"

export class CommentCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  private readonly storeSubscription: { dispose(): void }
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(private readonly store: CommentProposalStore) {
    this.storeSubscription = this.store.onDidChange(() => this.emitter.fire())
  }

  provideCodeLenses(document: vscode.TextDocument) {
    const lenses: vscode.CodeLens[] = []
    for (const proposal of this.store.pendingForDocument(document.uri.toString())) {
      const range = new vscode.Range(proposal.insertBeforeLine, 0, proposal.insertBeforeLine, 0)
      lenses.push(new vscode.CodeLens(range, {
        title: "预览完整注释",
        command: CHIPMATE_COMMANDS.commentsPreview,
        arguments: [proposal.id],
      }))
      lenses.push(new vscode.CodeLens(range, {
        title: "接受",
        command: CHIPMATE_COMMANDS.commentsAccept,
        arguments: [proposal.id],
      }))
      lenses.push(new vscode.CodeLens(range, {
        title: "拒绝",
        command: CHIPMATE_COMMANDS.commentsReject,
        arguments: [proposal.id],
      }))
    }
    return lenses
  }

  dispose() {
    this.storeSubscription.dispose()
    this.emitter.dispose()
  }
}
