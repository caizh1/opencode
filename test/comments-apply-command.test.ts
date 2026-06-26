import { beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CommentProposal } from "../src/comments/commentTypes"
import type { CommentEvidenceSuccess } from "../src/comments/commentEvidenceService"
import { CommentLLMGenerationError } from "../src/comments/commentLLMClient"

let activeTextEditor: unknown
let applyEditCalls = 0
let lastWorkspaceEdit: WorkspaceEditShim | undefined
let statusMessages: string[] = []
let infoMessages: string[] = []
let errorMessages: string[] = []
let warningMessages: string[] = []
let outputLines: string[] = []
let informationMessageOptions: Array<{ modal?: boolean; detail?: string }> = []
let informationMessageItems: string[][] = []
let informationMessageSelection: string | undefined
let createdPanels: WebviewPanelShim[] = []
let panelMessages: unknown[] = []
let openDocuments: Map<string, ReturnType<typeof documentShim>> = new Map()
let shownDocuments: Array<{ document: ReturnType<typeof documentShim>; options: unknown }> = []

class UriShim {
  constructor(readonly value: string, readonly fsPath = value) {}

  toString() {
    return this.value
  }
}

class PositionShim {
  constructor(readonly line: number, readonly character: number) {}
}

class RangeShim {
  start: PositionShim
  end: PositionShim

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new PositionShim(startLine, startCharacter)
    this.end = new PositionShim(endLine, endCharacter)
  }
}

class SelectionShim extends RangeShim {
  anchor: PositionShim
  active: PositionShim
  isEmpty: boolean

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    super(startLine, startCharacter, endLine, endCharacter)
    this.anchor = this.start
    this.active = this.end
    this.isEmpty = startLine === endLine && startCharacter === endCharacter
  }
}

class WorkspaceEditShim {
  readonly inserts: Array<{ uri: UriShim; position: PositionShim; text: string }> = []
  readonly replaces: unknown[] = []
  readonly deletes: unknown[] = []

  insert(uri: UriShim, position: PositionShim, text: string) {
    this.inserts.push({ uri, position, text })
  }

  replace(...args: unknown[]) {
    this.replaces.push(args)
  }

  delete(...args: unknown[]) {
    this.deletes.push(args)
  }
}

class WebviewPanelShim {
  readonly revealCalls: Array<{ column: unknown; preserveFocus?: boolean }> = []
  private disposeListeners: Array<() => void> = []
  private messageListener?: (message: unknown) => unknown
  disposed = false
  webview = {
    cspSource: "vscode-resource:",
    html: "",
    postMessage: async (message: unknown) => {
      panelMessages.push(message)
      return true
    },
    onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
      this.messageListener = listener
      return { dispose: () => undefined }
    },
  }

  reveal(column: unknown, preserveFocus?: boolean) {
    this.revealCalls.push({ column, preserveFocus })
  }

  onDidDispose(listener: () => void) {
    this.disposeListeners.push(listener)
    return { dispose: () => undefined }
  }

  dispose() {
    this.disposed = true
    for (const listener of this.disposeListeners) listener()
  }

  async emitMessage(message: unknown) {
    await this.messageListener?.(message)
  }
}

mock.module("vscode", () => ({
  Position: PositionShim,
  Range: RangeShim,
  Selection: SelectionShim,
  WorkspaceEdit: WorkspaceEditShim,
  Uri: Object.assign(UriShim, {
    parse: (value: string) => new UriShim(value, value.replace(/^file:\/\//, "")),
    file: (value: string) => new UriShim(`file://${value}`, value),
  }),
  ViewColumn: {
    Beside: 2,
  },
  TextEditorRevealType: {
    InCenterIfOutsideViewport: 2,
  },
  EventEmitter: class EventEmitterShim {
    event = () => ({ dispose: () => undefined })
    fire() {}
    dispose() {}
  },
  ThemeColor: class ThemeColorShim {
    constructor(readonly id: string) {}
  },
  MarkdownString: class MarkdownStringShim {
    value = ""
    isTrusted = false
    constructor(_value?: string, _supportThemeIcons?: boolean) {}
    appendMarkdown(value: string) { this.value += value }
    appendCodeblock(value: string) { this.value += value }
  },
  CodeLens: class CodeLensShim {
    constructor(readonly range: unknown, readonly command: unknown) {}
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => undefined }),
  },
  commands: {
    executeCommand: async (command: string) => {
      statusMessages.push(`command:${command}`)
    },
  },
  workspace: {
    workspaceFolders: [{
      uri: new UriShim("file:///repo", "/repo"),
      name: "repo",
      index: 0,
    }],
    asRelativePath: (value: { fsPath?: string; toString(): string }) => {
      const fsPath = value.fsPath ?? value.toString()
      return fsPath.replace(/^\/repo\//, "")
    },
    applyEdit: async (edit: WorkspaceEditShim) => {
      applyEditCalls += 1
      lastWorkspaceEdit = edit
      return true
    },
    openTextDocument: async (uri: UriShim) => {
      const document = openDocuments.get(uri.toString())
      if (!document) throw new Error(`missing document ${uri.toString()}`)
      return document
    },
  },
  window: {
    get activeTextEditor() {
      return activeTextEditor
    },
    get visibleTextEditors() {
      return activeTextEditor ? [activeTextEditor] : []
    },
    createTextEditorDecorationType: () => ({ dispose: () => undefined }),
    createWebviewPanel: (..._args: unknown[]) => {
      const panel = new WebviewPanelShim()
      createdPanels.push(panel)
      return panel
    },
    onDidChangeVisibleTextEditors: () => ({ dispose: () => undefined }),
    setStatusBarMessage: (message: string) => {
      statusMessages.push(message)
      return { dispose: () => undefined }
    },
    showInformationMessage: async (message: string, options?: { modal?: boolean; detail?: string } | string, ...items: string[]) => {
      infoMessages.push(message)
      if (typeof options === "object" && options) {
        informationMessageOptions.push(options)
        informationMessageItems.push(items)
        return informationMessageSelection
      }
      if (typeof options === "string") {
        informationMessageItems.push([options, ...items])
        return informationMessageSelection
      }
      return undefined
    },
    showErrorMessage: async (message: string) => {
      errorMessages.push(message)
    },
    showWarningMessage: async (message: string) => {
      warningMessages.push(message)
    },
    showTextDocument: async (document: ReturnType<typeof documentShim>, options: { selection?: SelectionShim } = {}) => {
      shownDocuments.push({ document, options })
      const editor = {
        document,
        selection: options.selection ?? new SelectionShim(0, 0, 0, 0),
        revealRange: () => undefined,
      }
      activeTextEditor = editor
      return editor
    },
  },
}))

const { applyCommentProposal, commentInsertIndent, commentInsertText } = await import("../src/comments/commentApplyService")
const { acceptAllPendingForCurrentReviewFile, acceptAllPendingWorkspaceChanges, generateForCurrentFunction, generateForSelection, previewProposal, regenerateFromProposal, rejectProposal, saveAllCommentFiles, undoLastBulkAccept } = await import("../src/comments/commentCommands")
const { resolveCurrentFunctionSelection } = await import("../src/comments/commentFunctionRange")
const { CommentProposalStore } = await import("../src/comments/commentProposalStore")
const { commentContextHash } = await import("../src/comments/commentContext")
const { CommentReviewPanel } = await import("../src/comments/commentReviewPanel")
const { createCommentReviewHtml } = await import("../src/comments/commentReviewHtml")
const { CommentToolAgentClient } = await import("../src/comments/commentToolAgentClient")
const { parseCommentWorkspaceUnifiedDiff, parseCommentWorkspaceUntrackedFiles } = await import("../src/comments/commentWorkspaceChanges")

beforeEach(() => {
  activeTextEditor = undefined
  applyEditCalls = 0
  lastWorkspaceEdit = undefined
  statusMessages = []
  infoMessages = []
  errorMessages = []
  warningMessages = []
  outputLines = []
  informationMessageOptions = []
  informationMessageItems = []
  informationMessageSelection = undefined
  createdPanels = []
  panelMessages = []
  openDocuments = new Map()
  shownDocuments = []
})

describe("AI comment apply service", () => {
  test("marks proposals stale when document version changed", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"], { version: 3 })
    const proposal = proposalForDocument(document, { documentVersion: 2 })

    await expect(applyCommentProposal(proposal, document as never)).resolves.toEqual({
      status: "stale",
      reason: "文档版本已变化",
    })
    expect(applyEditCalls).toBe(0)
  })

  test("marks proposals stale when context hash changed", async () => {
    const document = documentShim(["int main(void) {", "    changed_work();", "}"])
    const proposal = proposalForDocument(document, { contextHash: "old" })

    await expect(applyCommentProposal(proposal, document as never)).resolves.toEqual({
      status: "stale",
      reason: "选区上下文已变化",
    })
    expect(applyEditCalls).toBe(0)
  })

  test("accept insert text uses the target line indentation when the proposal indent is empty", () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document, { indent: "" })

    const indent = commentInsertIndent(proposal, document as never)

    expect(indent).toBe("    ")
    expect(commentInsertText(proposal, indent).startsWith("    // 说明 work handoff 的原因。")).toBe(true)
  })

  test("rejects inserts around macro continuations and inside block comments", async () => {
    const macroDocument = documentShim(["#define X \\", "    do_work();"])
    const blockDocument = documentShim(["/* open", "    do_work();", "*/"])

    await expect(applyCommentProposal(proposalForDocument(macroDocument), macroDocument as never)).resolves.toEqual({
      status: "stale",
      reason: "插入位置位于宏续行中",
    })
    await expect(applyCommentProposal(proposalForDocument(blockDocument), blockDocument as never)).resolves.toEqual({
      status: "stale",
      reason: "插入位置位于块注释中",
    })
    expect(applyEditCalls).toBe(0)
  })

  test("marks proposals stale when the insert line is no longer a structural anchor", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "    notify_owner();", "}"])
    const proposal = proposalForDocument(document, {
      insertBeforeLine: 2,
      anchor: { targetLineText: document.lineAt(2).text },
      selectionEndLine: 2,
      selectionEndCharacter: document.lineAt(2).text.length,
      selectionTextEndLine: 2,
      selectionTextEndCharacter: document.lineAt(2).text.length,
      contextHash: commentContextHash({
        languageId: document.languageId,
        selectionStartLine: 1,
        selectionEndLine: 2,
        selectionStartCharacter: 0,
        selectionEndCharacter: document.lineAt(2).text.length,
        selectedCode: document.getText(new RangeShim(1, 0, 2, document.lineAt(2).text.length)),
        contextBefore: document.lineAt(0).text,
        contextAfter: document.lineAt(3).text,
      }),
    })

    await expect(applyCommentProposal(proposal, document as never)).resolves.toEqual({
      status: "stale",
      reason: "插入位置不再是允许的结构锚点",
    })
    expect(applyEditCalls).toBe(0)
  })

  test("accept all source validates every proposal and inserts from bottom to top in one edit", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "comments", "commentApplyService.ts"), "utf8")

    expect(source).toContain("export async function applyCommentProposals")
    expect(source).toContain("right.insertBeforeLine - left.insertBeforeLine")
    expect(source).toContain("const staleReason = validateApplyTarget(proposal, document)")
    expect(source).toContain("workspaceEdit.insert(")
    expect(source).toContain("vscode.workspace.applyEdit(workspaceEdit!)")
    expect(source).not.toContain("workspaceEdit.replace")
    expect(source).not.toContain("workspaceEdit.delete")
  })
})

describe("AI comment workspace changes scanner helpers", () => {
  test("maps unified diff hunks to current workspace changed line spans", () => {
    const changes = parseCommentWorkspaceUnifiedDiff([
      "diff --git a/src/main.c b/src/main.c",
      "index 111..222 100644",
      "--- a/src/main.c",
      "+++ b/src/main.c",
      "@@ -10,6 +10,8 @@ static void main_loop(void)",
      "     before();",
      "+    added_one();",
      "+    added_two();",
      "     after();",
      "@@ -30,4 +32,5 @@ static void other(void)",
      "     old();",
      "-    replaced_old();",
      "+    replaced_new();",
      " }",
      "",
    ].join("\n"))

    expect(changes).toEqual([expect.objectContaining({
      relativePath: "src/main.c",
      hunkCount: 2,
      changedLineSpans: [
        { startLine: 10, endLine: 11 },
        { startLine: 32, endLine: 32 },
      ],
    })])
  })

  test("reads untracked files from porcelain status output", () => {
    expect(parseCommentWorkspaceUntrackedFiles("?? src/new.c\0 M src/main.c\0?? include/new.h\0")).toEqual([
      "src/new.c",
      "include/new.h",
    ])
  })
})

describe("AI comment commands", () => {
  test("wires Chinese preview, accept, and reject CodeLens actions without a duplicate label", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "comments", "commentCodeLensProvider.ts"), "utf8")
    const decorationSource = readFileSync(join(import.meta.dir, "..", "src", "comments", "commentDecorations.ts"), "utf8")

    expect(source).not.toContain('title: "AI 注释候选"')
    expect(source).not.toContain("commentPreviewText(proposal.commentText)")
    expect(source).not.toContain("+ /**")
    expect(source).not.toContain("+ //")
    expect(source).toContain('title: "预览完整注释"')
    expect(source).toContain("CHIPMATE_COMMANDS.commentsPreview")
    expect(source).toContain('title: "接受"')
    expect(source).toContain("CHIPMATE_COMMANDS.commentsAccept")
    expect(source).toContain('title: "拒绝"')
    expect(source).toContain("CHIPMATE_COMMANDS.commentsReject")
    expect(decorationSource).not.toContain("contentText")
    expect(decorationSource).not.toContain("renderOptions")
    expect(decorationSource).toContain("代码证据")
    expect(decorationSource).toContain("综合原因")
  })

  test("comment review webview html renders actions and only posts proposal commands", () => {
    const html = createCommentReviewHtml("vscode-resource:", "Nonce123")

    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("script-src 'nonce-Nonce123'")
    expect(html).toContain("预览完整注释")
    expect(html).toContain("重新生成")
    expect(html).toContain("REVIEW_ICONS.retry")
    expect(html).toContain("actionButtonIcon")
    expect(html).toContain("oc-liquid-icon")
    expect(html).toContain("接受")
    expect(html).toContain("接受全部")
    expect(html).toContain("分析工作区改动")
    expect(html).toContain("为这些改动生成注释")
    expect(html).toContain("撤销上次接受全部")
    expect(html).toContain("保存全部")
    expect(html).toContain("拒绝")
    expect(html).toContain("定位")
    expect(html).toContain("正在生成 AI 注释")
    expect(html).toContain("模型思考...")
    expect(html).toContain("commentThinkingLine")
    expect(html).toContain("thinkingSummaryLabel")
    expect(html).toContain("thinkingPreview")
    expect(html).toContain("renderInlineThinking")
    expect(html).toContain("commentStepSpin")
    expect(html).toContain("step-spinner")
    expect(html).toContain('spinner.className = "step-spinner"')
    expect(html).toContain("prefers-reduced-motion")
    expect(html).not.toContain(".step.running .step-icon::before")
    expect(html).not.toContain('if (status === "running") return ""')
    expect(html).not.toContain('if (status === "running") return "…"')
    expect(html).not.toContain("position: absolute")
    expect(html).toContain('step.id === "model"')
    expect(html).toContain("Token 用量")
    expect(html).toContain("renderProgress")
    expect(html).toContain("isWorkspaceReview")
    expect(html).toContain("重新扫描改动")
    expect(html).toContain('progress.source === "workspaceChanges"')
    expect(html).not.toContain("renderStream")
    expect(html).not.toContain("renderOutputStream")
    expect(html).not.toContain("stream-grid")
    expect(html).not.toContain("stream-card")
    expect(html).toContain("summary.textContent = proposal.summary")
    expect(html).toContain("comment.textContent = proposal.commentText")
    expect(html).toContain("if (!workspaceReview)")
    expect(html).toContain('vscode.postMessage({ type: "regenerateProposals" })')
    expect(html).toContain('vscode.postMessage({ type: "acceptAllProposals" })')
    expect(html).toContain('type: "analyzeWorkspaceChanges"')
    expect(html).toContain('type: "generateWorkspaceChanges"')
    expect(html).toContain('type: "undoLastBulkAccept"')
    expect(html).toContain('type: "saveAllFiles"')
    expect(html).toContain("代码证据")
    expect(html).toContain("综合原因")
    expect(html).toContain("renderCodeEvidence")
    expect(html).toContain("evidenceRangeText")
    expect(html).toContain("vscode.postMessage({ type, proposalId })")
    expect(html).toContain('vscode.postMessage({ type: "closePanel" })')
    expect(html).not.toContain("http://")
    expect(html).not.toContain("https://")
  })

  test("comment review panel opens once and sends redrawn proposal state", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    const accepted: string[] = []
    const acceptedAll: string[] = []
    const rejected: string[] = []
    const revealed: string[] = []
    const regenerated: Array<{ proposalId: string }> = []
    const panel = new CommentReviewPanel({
      extensionUri: new UriShim("file:///ext", "/ext") as never,
      output: outputShim(outputLines),
      store,
      onAccept: async (proposalId) => {
        accepted.push(proposalId)
      },
      onAcceptAll: async (uri) => {
        acceptedAll.push(uri)
      },
      onReject: (proposalId) => {
        rejected.push(proposalId)
      },
      onReveal: async (proposalId) => {
        revealed.push(proposalId)
      },
      onRegenerate: async (target) => {
        regenerated.push(target)
      },
      onAnalyzeWorkspaceChanges: async () => undefined,
      onGenerateWorkspaceChanges: async () => undefined,
    })

    panel.openForProposal(proposal.id)

    expect(createdPanels).toHaveLength(1)
    expect(createdPanels[0].webview.html).toContain("AI 注释候选")
    expect(createdPanels[0].revealCalls).toEqual([{ column: 2, preserveFocus: true }])
    const stateMessage = panelMessages.at(-1) as { type: string; state: { selectedProposalId: string; proposals: Array<{ summary: string; commentText: string; reason: string; codeEvidence: CommentProposal["codeEvidence"] }> } }
    expect(stateMessage.type).toBe("state")
    expect(stateMessage.state.selectedProposalId).toBe(proposal.id)
    expect(stateMessage.state.proposals[0]?.summary).toBe("+ // 说明 work handoff 的原因。")
    expect(stateMessage.state.proposals[0]?.commentText).toBe(proposal.commentText)
    expect(stateMessage.state.proposals[0]?.reason).toBe(proposal.reason)
    expect(stateMessage.state.proposals[0]?.codeEvidence[0]?.codeSummary).toBe("这一行执行 work handoff。")

    await createdPanels[0].emitMessage({ type: "revealProposal", proposalId: proposal.id })
    await createdPanels[0].emitMessage({ type: "acceptProposal", proposalId: proposal.id })
    await createdPanels[0].emitMessage({ type: "acceptAllProposals" })
    await createdPanels[0].emitMessage({ type: "regenerateProposals" })
    await createdPanels[0].emitMessage({ type: "rejectProposal", proposalId: proposal.id })
    await createdPanels[0].emitMessage({ type: "closePanel" })

    expect(revealed).toEqual([proposal.id])
    expect(accepted).toEqual([proposal.id])
    expect(acceptedAll).toEqual([proposal.uri])
    expect(regenerated).toEqual([expect.objectContaining({
      proposalId: proposal.id,
      uri: proposal.uri,
      selectionStartLine: proposal.selectionStartLine,
      selectionTextEndLine: proposal.selectionTextEndLine,
    })])
    expect(rejected).toEqual([proposal.id])
    expect(createdPanels[0].disposed).toBe(true)
    panel.dispose()
  })

  test("comment review panel keeps generation progress visible over old proposals", () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    const panel = new CommentReviewPanel({
      extensionUri: new UriShim("file:///ext", "/ext") as never,
      output: outputShim(outputLines),
      store,
      onAccept: async () => undefined,
      onAcceptAll: async () => undefined,
      onReject: () => undefined,
      onReveal: async () => undefined,
      onRegenerate: async () => undefined,
      onAnalyzeWorkspaceChanges: async () => undefined,
      onGenerateWorkspaceChanges: async () => undefined,
    })
    panel.openForDocument(proposal.uri, proposal.id)
    const progress = {
      traceId: "comment-progress-test",
      uri: proposal.uri,
      fileLabel: "main.c",
      uriHash: "hash",
      status: "running" as const,
      currentStage: "正在重新生成",
      startedAt: 100,
      steps: [
        { id: "selection", label: "确认选区", status: "done" as const },
        { id: "tools", label: "模型检索本地证据", status: "running" as const },
      ],
    }

    panel.openForGeneration(progress)

    const stateMessage = panelMessages.at(-1) as { type: string; state: { mode: string; progress: typeof progress; proposals: unknown[] } }
    expect(stateMessage.type).toBe("state")
    expect(stateMessage.state.mode).toBe("generating")
    expect(stateMessage.state.progress.currentStage).toBe("正在重新生成")
    expect(stateMessage.state.proposals).toHaveLength(1)
    panel.dispose()
  })

  test("comment review panel can retry regenerate from the stored selection target after pending proposals are cleared", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    const regenerated: unknown[] = []
    const panel = new CommentReviewPanel({
      extensionUri: new UriShim("file:///ext", "/ext") as never,
      output: outputShim(outputLines),
      store,
      onAccept: async () => undefined,
      onAcceptAll: async () => undefined,
      onReject: () => undefined,
      onReveal: async () => undefined,
      onRegenerate: async (target) => {
        regenerated.push(target)
      },
      onAnalyzeWorkspaceChanges: async () => undefined,
      onGenerateWorkspaceChanges: async () => undefined,
    })

    panel.openForProposal(proposal.id)
    await createdPanels[0].emitMessage({ type: "regenerateProposals" })
    store.clearPendingForDocument(proposal.uri)
    await createdPanels[0].emitMessage({ type: "regenerateProposals" })

    expect(regenerated).toHaveLength(2)
    expect(regenerated[1]).toEqual(regenerated[0])
    panel.dispose()
  })

  test("comment review panel renders generation progress state without proposals", () => {
    const store = new CommentProposalStore()
    const panel = new CommentReviewPanel({
      extensionUri: new UriShim("file:///ext", "/ext") as never,
      output: outputShim(outputLines),
      store,
      onAccept: async () => undefined,
      onAcceptAll: async () => undefined,
      onReject: () => undefined,
      onReveal: async () => undefined,
      onRegenerate: async () => undefined,
      onAnalyzeWorkspaceChanges: async () => undefined,
      onGenerateWorkspaceChanges: async () => undefined,
    })
    const progress = {
      traceId: "comment-progress-test",
      uri: "file:///repo/main.c",
      fileLabel: "main.c",
      uriHash: "hash",
      status: "running" as const,
      currentStage: "正在请求模型",
      startedAt: 100,
      steps: [
        { id: "selection", label: "确认选区", status: "done" as const, detail: "行 1-2" },
        { id: "model", label: "请求模型生成候选", status: "running" as const },
      ],
      tokenUsage: { usageAvailable: false },
    }

    panel.openForGeneration(progress)

    const stateMessage = panelMessages.at(-1) as { type: string; state: { mode: string; progress: typeof progress; proposals: unknown[] } }
    expect(createdPanels).toHaveLength(1)
    expect(stateMessage.type).toBe("state")
    expect(stateMessage.state.mode).toBe("generating")
    expect(stateMessage.state.progress.currentStage).toBe("正在请求模型")
    expect(stateMessage.state.progress.tokenUsage).toEqual({ usageAvailable: false })
    expect(stateMessage.state.proposals).toEqual([])
    panel.dispose()
  })

  test("comment review panel shows workspace changes before generation and posts selected unit ids", async () => {
    const store = new CommentProposalStore()
    const analyzed: string[] = []
    const generated: unknown[] = []
    const panel = new CommentReviewPanel({
      extensionUri: new UriShim("file:///ext", "/ext") as never,
      output: outputShim(outputLines),
      store,
      onAccept: async () => undefined,
      onAcceptAll: async () => undefined,
      onReject: () => undefined,
      onReveal: async () => undefined,
      onRegenerate: async () => undefined,
      onAnalyzeWorkspaceChanges: async () => {
        analyzed.push("analyze")
      },
      onGenerateWorkspaceChanges: async (unitIds) => {
        generated.push(unitIds)
      },
    })

    panel.openForWorkspaceChanges({
      ok: true,
      rootPath: "/repo",
      diffHash: "workspace-diff",
      changedFileCount: 1,
      hunkCount: 1,
      skipped: [],
      units: [{
        id: "unit-1",
        uri: "file:///repo/main.c",
        fsPath: "/repo/main.c",
        relativePath: "main.c",
        languageId: "c",
        unitKind: "function",
        title: "函数 · 第 1-3 行 · main",
        range: { startLine: 0, endLine: 2, startCharacter: 0, endCharacter: 1 },
        changedLineSpans: [{ startLine: 1, endLine: 1 }],
        hunkCount: 1,
        diffHash: "unit-diff",
      }],
    })

    const stateMessage = panelMessages.at(-1) as { type: string; state: { mode: string; workspaceChanges?: { units: unknown[] } } }
    expect(stateMessage.state.mode).toBe("reviewChanges")
    expect(stateMessage.state.workspaceChanges?.units).toHaveLength(1)

    await createdPanels[0].emitMessage({ type: "analyzeWorkspaceChanges" })
    await createdPanels[0].emitMessage({ type: "generateWorkspaceChanges", unitIds: ["unit-1"] })

    expect(analyzed).toEqual(["analyze"])
    expect(generated).toEqual([["unit-1"]])
    panel.dispose()
  })

  test("reject does not modify files", () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    activeTextEditor = {
      document,
      selection: {
        active: { line: 1, character: 0 },
      },
    }

    rejectProposal({
      output: outputShim(),
      store,
    })

    expect(store.get(proposal.id)?.status).toBe("rejected")
    expect(applyEditCalls).toBe(0)
  })

  test("accept all command marks stale current-file proposals skipped without modifying files", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "    if (ready) {", "        notify_owner();", "    }", "}"])
    const staleA = proposalForRange(document, 1, 3, {
      id: "proposal-a",
      insertBeforeLine: 2,
      anchor: { targetLineText: "changed_if();" },
      commentText: "// ready 条件保证 owner 已经可以接收通知。",
    })
    const staleB = proposalForRange(document, 1, 3, {
      id: "proposal-stale",
      insertBeforeLine: 1,
      anchor: { targetLineText: "changed();" },
      commentText: "// 这条候选会被 stale 校验跳过。",
    })
    store.replacePendingForDocument(document.uri.toString(), [staleA, staleB])
    activeTextEditor = {
      document,
      selection: {
        active: { line: 1, character: 0 },
      },
    }

    await acceptAllPendingForCurrentReviewFile({
      output: outputShim(outputLines),
      store,
    })

    expect(applyEditCalls).toBe(0)
    expect(lastWorkspaceEdit).toBeUndefined()
    expect(store.get(staleA.id)?.status).toBe("stale")
    expect(store.get(staleB.id)?.status).toBe("stale")
    expect(statusMessages).toContain("已接受 0 条，2 条已跳过。")
    expect(outputLines.some((line) => line.includes("acceptAll.start") && line.includes("pendingCount=2"))).toBe(true)
    expect(outputLines.some((line) => line.includes("acceptAll.item.done"))).toBe(false)
    expect(outputLines.some((line) => line.includes("acceptAll.item.skipped"))).toBe(true)
    expect(outputLines.some((line) => line.includes("acceptAll.done") && line.includes("acceptedCount=0"))).toBe(true)
  })

  test("workspace accept all confirms, inserts pending workspace proposals, and records an undo batch", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = workspaceProposalForDocument(document, {
      id: "workspace-proposal-1",
      workspaceReviewUnitId: "unit-1",
      workspaceChangeDiffHash: "diff-1",
    })
    store.replacePendingForWorkspaceUnit(proposal.uri, "unit-1", [proposal])
    openDocuments.set(document.uri.toString(), document)
    informationMessageSelection = "接受全部"
    const bulkAcceptState = {}

    await acceptAllPendingWorkspaceChanges({
      output: outputShim(outputLines),
      store,
      bulkAcceptState: bulkAcceptState as never,
      diffHash: "diff-1",
    })

    expect(informationMessageItems[0]).toEqual(["接受全部", "取消"])
    expect(lastWorkspaceEdit?.inserts).toHaveLength(1)
    expect(lastWorkspaceEdit?.replaces).toHaveLength(0)
    expect(lastWorkspaceEdit?.deletes).toHaveLength(0)
    expect(store.get(proposal.id)?.status).toBe("accepted")
    expect((bulkAcceptState as { lastBatch?: { records: unknown[] } }).lastBatch?.records).toHaveLength(1)
    expect(statusMessages.some((message) => message.includes("文件尚未保存"))).toBe(true)
  })

  test("undo last workspace accept all only deletes the recorded matching comment text", async () => {
    const document = documentShim(["// 说明 work handoff 的原因。", "    do_work();", "}"])
    openDocuments.set(document.uri.toString(), document)
    const bulkAcceptState = {
      lastBatch: {
        id: "batch-1",
        createdAt: Date.now(),
        records: [{
          proposalId: "workspace-proposal-1",
          uri: document.uri.toString(),
          startLine: 0,
          lineCount: 1,
          text: "// 说明 work handoff 的原因。\n",
        }],
      },
    }

    await undoLastBulkAccept({
      output: outputShim(outputLines),
      bulkAcceptState,
    })

    expect(lastWorkspaceEdit?.deletes).toHaveLength(1)
    expect(lastWorkspaceEdit?.inserts).toHaveLength(0)
    expect(bulkAcceptState.lastBatch).toBeUndefined()
    expect(statusMessages.some((message) => message.includes("已撤销 1 条 AI 注释"))).toBe(true)
  })

  test("save all comment files delegates to VS Code save all", async () => {
    await saveAllCommentFiles()

    expect(statusMessages).toContain("command:workbench.action.files.saveAll")
    expect(statusMessages).toContain("已执行保存全部。")
  })

  test("preview shows the full comment and closes without modifying files", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document, {
      commentText: [
        "// 只有 frontend 存在活跃 handler 时才转发 read",
        "// 这样断开的 frontend 不会收到 callback。",
      ].join("\n"),
    })
    store.replacePendingForDocument(proposal.uri, [proposal])
    informationMessageSelection = "关闭"

    await previewProposal({
      output: outputShim(outputLines),
      store,
      proposalId: proposal.id,
    })

    expect(infoMessages).toContain("AI 注释候选")
    expect(informationMessageOptions[0]).toMatchObject({ modal: true })
    expect(informationMessageItems[0]).toEqual(["接受", "拒绝", "关闭"])
    expect(informationMessageOptions[0]?.detail).toContain(proposal.commentText)
    expect(informationMessageOptions[0]?.detail).toContain("置信度: high")
    expect(informationMessageOptions[0]?.detail).toContain("代码证据:")
    expect(informationMessageOptions[0]?.detail).toContain("第 2 行 · logicBlock: 这一行执行 work handoff。 -> 它体现 ownership 移交的关键路径。")
    expect(informationMessageOptions[0]?.detail).toContain("综合原因: ownership 移交流程不直观。")
    expect(store.get(proposal.id)?.status).toBe("pending")
    expect(applyEditCalls).toBe(0)
  })

  test("preview command opens the review panel when one is available", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    const opened: string[] = []
    store.replacePendingForDocument(proposal.uri, [proposal])

    await previewProposal({
      output: outputShim(outputLines),
      store,
      proposalId: proposal.id,
      reviewPanel: {
        openForProposal: (proposalId: string) => {
          opened.push(proposalId)
        },
      },
    })

    expect(opened).toEqual([proposal.id])
    expect(infoMessages).toEqual([])
    expect(outputLines.some((line) => line.includes("已打开注释候选面板"))).toBe(true)
  })

  test("preview can route to the existing accept flow", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    informationMessageSelection = "接受"

    await previewProposal({
      output: outputShim(outputLines),
      store,
      proposalId: proposal.id,
    })

    expect(errorMessages).toContain("请先打开目标文件，再接受这条 AI 注释。")
    expect(store.get(proposal.id)?.status).toBe("pending")
    expect(applyEditCalls).toBe(0)
  })

  test("accept source opens the proposal document when the webview has focus", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "comments", "commentCommands.ts"), "utf8")

    expect(source).toContain("vscode.workspace.openTextDocument(vscode.Uri.parse(proposal.uri))")
    expect(source).toContain("vscode.window.showTextDocument(document")
    expect(source).toContain("applyCommentProposal(proposal, document)")
  })

  test("preview can reject without modifying files", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const proposal = proposalForDocument(document)
    store.replacePendingForDocument(proposal.uri, [proposal])
    informationMessageSelection = "拒绝"

    await previewProposal({
      output: outputShim(outputLines),
      store,
      proposalId: proposal.id,
    })

    expect(store.get(proposal.id)?.status).toBe("rejected")
    expect(applyEditCalls).toBe(0)
  })

  test("preview missing proposal only shows a lightweight status message", async () => {
    await previewProposal({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      proposalId: "missing",
    })

    expect(statusMessages).toContain("未找到 AI 注释候选。")
    expect(informationMessageItems).toEqual([])
    expect(applyEditCalls).toBe(0)
  })

  test("does not call the LLM when selection is empty", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = {
      document,
      selection: {
        active: { line: 1, character: 4 },
        isEmpty: true,
        start: { line: 1, character: 4 },
        end: { line: 1, character: 4 },
      },
    }
    let modelCalls = 0

    await generateForSelection({
      output: outputShim(),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => {
          throw new Error("should not collect evidence")
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("请先选中一段 C/C++、Shell、Makefile 和 YAML 代码，再生成 AI 注释。")
  })

  test("resolves the current function range from signature, body, and closing brace cursors", () => {
    const document = documentShim([
      "static void hub_chr_read(",
      "    void *opaque, const uint8_t *buf, int size)",
      "{",
      "    if (buf) {",
      "        consume(buf, size);",
      "    }",
      "}",
      "",
      "static void other(void)",
      "{",
      "}",
    ])

    for (const [line, character] of [[0, 8], [4, 12], [6, 1]] as const) {
      const selection = resolveCurrentFunctionSelection(cursorEditor(document, line, character) as never)
      expect(selection?.start.line).toBe(0)
      expect(selection?.start.character).toBe(0)
      expect(selection?.end.line).toBe(6)
      expect(selection?.end.character).toBe(document.lineAt(6).text.length)
    }
  })

  test("resolves the current shell function range from header and body cursors", () => {
    const document = documentShim([
      "sync_logs() {",
      "    if [ -n \"$LOG_DIR\" ]; then",
      "        cp \"$src\" \"$LOG_DIR\"",
      "    fi",
      "}",
    ], { languageId: "shellscript", uri: "file:///repo/scripts/build.sh" })

    for (const [line, character] of [[0, 4], [2, 8], [4, 1]] as const) {
      const selection = resolveCurrentFunctionSelection(cursorEditor(document, line, character) as never)
      expect(selection?.start.line).toBe(0)
      expect(selection?.end.line).toBe(4)
    }
  })

  test("resolves the current makefile rule block from target and recipe cursors", () => {
    const document = documentShim([
      "build: deps",
      "\t@echo build",
      "\t@make all",
      "",
      "clean:",
      "\t@rm -rf out",
    ], { languageId: "makefile", uri: "file:///repo/Makefile" })

    for (const [line, character] of [[0, 3], [1, 2], [2, 2]] as const) {
      const selection = resolveCurrentFunctionSelection(cursorEditor(document, line, character) as never)
      expect(selection?.start.line).toBe(0)
      expect(selection?.end.line).toBe(3)
    }
  })

  test("current function generation does not call tools or the LLM outside a function", async () => {
    const document = documentShim(["int global_value;", "", "static void run(void);"])
    activeTextEditor = cursorEditor(document, 1, 0)
    let toolCalls = 0
    let modelCalls = 0

    await generateForCurrentFunction({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      toolAgent: {
        collectEvidence: async () => {
          toolCalls += 1
          return successEvidence() as never
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(toolCalls).toBe(0)
    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("未找到当前函数，请选中代码后生成 AI 注释。")
    expect(outputLines.some((line) => line.includes("source=\"currentFunction\"") && line.includes("未找到当前函数"))).toBe(true)
  })

  test("current function generation does not call tools or the LLM for yaml files", async () => {
    const document = documentShim([
      "build:",
      "  steps:",
      "    - run: make all",
    ], { languageId: "yaml", uri: "file:///repo/.gitea-ci.yml" })
    activeTextEditor = cursorEditor(document, 1, 2)
    let toolCalls = 0
    let modelCalls = 0

    await generateForCurrentFunction({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      toolAgent: {
        collectEvidence: async () => {
          toolCalls += 1
          return successEvidence() as never
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(toolCalls).toBe(0)
    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("当前“为当前函数生成 AI 注释”仅支持 C/C++、Shell 和 Makefile。")
  })

  test("current function generation reuses the selection pipeline and stores source metadata", async () => {
    const document = documentShim([
      "static void hub_chr_read(void *opaque, const uint8_t *buf, int size)",
      "{",
      "    if (buf && size > 0) {",
      "        consume(buf, size);",
      "    }",
      "}",
    ])
    const store = new CommentProposalStore()
    activeTextEditor = cursorEditor(document, 3, 12)
    let prompt = ""

    await generateForCurrentFunction({
      output: outputShim(outputLines),
      store,
      toolAgent: {
        collectEvidence: async () => ({
          ok: true as const,
          evidenceSummary: "工具证据: hub_chr_read 负责转发后端数据。",
          evidenceItemCount: 1,
          evidenceSummaryBytes: 48,
          elapsedMs: 4,
          roundCount: 1,
          toolCallCount: 1,
          blockedToolCount: 0,
          failedToolCount: 0,
          outputDirective: "encourage-1-3" as const,
          groundingConfidence: "medium" as const,
          groundingSummary: "工具检索证据置信度: medium。",
          evidenceCompacted: false,
          exhausted: false,
        }),
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return {
            text: JSON.stringify({
              proposals: [{
                kind: "functionHeader",
                insertBeforeLine: 0,
                indent: "",
                commentText: "/**\n * 作为后端读取回调，将有效输入缓冲区转交给消费路径。\n */",
                anchor: { targetLineText: document.lineAt(0).text },
                confidence: "medium",
                reason: "函数入口和内部 guard 共同说明它只处理有效输入。",
                codeEvidence: [codeEvidence({
                  startLine: 0,
                  endLine: 4,
                  anchorLabel: "function",
                  codeSummary: "函数入口接收 opaque、buf 和 size，并在 buf 有效时消费数据。",
                  meaning: "这说明函数职责是安全地转发后端读取到的数据。",
                })],
              }],
            }),
            elapsedMs: 3,
          }
        },
      },
    })

    const pending = store.pendingForDocument(document.uri.toString())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.source).toBe("currentFunction")
    expect(pending[0]?.selectionStartLine).toBe(0)
    expect(pending[0]?.selectionEndLine).toBe(5)
    expect(prompt).toContain("Review scope:\ncurrentFunction")
    expect(prompt).toContain("当前函数模式只是把光标所在函数解析成内部 selected range")
    expect(prompt).toContain("优先函数入口注释，同时覆盖内部高价值逻辑")
    expect(outputLines.some((line) => line.includes("stage=currentFunction.resolved") && line.includes("resolvedRangeStartLine=0"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=selection.ready") && line.includes("source=\"currentFunction\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"proposals-stored\"") && line.includes("source=\"currentFunction\""))).toBe(true)
  })

  test("reopens cached proposals for the same selection without calling tools or the model", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const cached = proposalForRange(document, 0, 1, { id: "cached-proposal" })
    store.replacePendingForDocument(document.uri.toString(), [cached])
    activeTextEditor = selectedEditor(document)
    const opened: Array<{ uri: string; selectedProposalId?: string }> = []
    let modelCalls = 0

    await generateForSelection({
      output: outputShim(outputLines),
      store,
      reviewPanel: {
        openForDocument: (uri: string, selectedProposalId?: string) => {
          opened.push({ uri, selectedProposalId })
        },
      },
      toolAgent: {
        collectEvidence: async () => {
          throw new Error("should not collect tools on cache hit")
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(modelCalls).toBe(0)
    expect(opened).toEqual([{ uri: cached.uri, selectedProposalId: cached.id }])
    expect(statusMessages).toContain("已打开上一次生成的 AI 注释候选。")
    expect(outputLines.some((line) => line.includes("stage=cache.hit") && line.includes("proposalCount=1"))).toBe(true)
  })

  test("does not reuse selection cache entries for current function generation", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["static void run(void)", "{", "    do_work();", "}"])
    const cachedSelection = proposalForRange(document, 0, 3, {
      id: "selection-cache",
      insertBeforeLine: 0,
      anchor: { targetLineText: document.lineAt(0).text },
      source: "selection",
    })
    store.replacePendingForDocument(document.uri.toString(), [cachedSelection])
    activeTextEditor = cursorEditor(document, 2, 8)
    let toolCalls = 0
    let modelCalls = 0

    await generateForCurrentFunction({
      output: outputShim(outputLines),
      store,
      toolAgent: {
        collectEvidence: async () => {
          toolCalls += 1
          return successEvidence({
            outputDirective: "allow-empty",
            groundingConfidence: "medium",
          }) as never
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(toolCalls).toBe(1)
    expect(modelCalls).toBe(1)
    expect(outputLines.some((line) => line.includes("stage=cache.hit"))).toBe(false)
    expect(outputLines.some((line) => line.includes("stage=cache.miss") && line.includes("source=\"currentFunction\""))).toBe(true)
  })

  test("force regenerate bypasses cached proposals and preserves them when no new proposals are generated", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const cached = proposalForRange(document, 0, 1, { id: "cached-proposal" })
    store.replacePendingForDocument(document.uri.toString(), [cached])
    activeTextEditor = selectedEditor(document)
    let toolCalls = 0
    let modelCalls = 0

    await generateForSelection({
      output: outputShim(outputLines),
      store,
      forceRegenerate: true,
      toolAgent: {
        collectEvidence: async () => {
          toolCalls += 1
          return successEvidence()
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(toolCalls).toBe(1)
    expect(modelCalls).toBe(1)
    expect(store.get(cached.id)?.status).toBe("pending")
    expect(store.pendingForDocument(document.uri.toString()).map((proposal) => proposal.id)).toEqual([cached.id])
    expect(outputLines.some((line) => line.includes("stage=cache.bypass") && line.includes("force-regenerate"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=store.done") && line.includes("preservedExisting=true"))).toBe(true)
  })

  test("webview regenerate restores the stored selection without an active editor", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const cached = proposalForRange(document, 0, 1, { id: "cached-proposal" })
    store.replacePendingForDocument(document.uri.toString(), [cached])
    openDocuments.set(document.uri.toString(), document)
    activeTextEditor = undefined
    let generatedEditor: { document: typeof document; selection: SelectionShim } | undefined

    await regenerateFromProposal({
      output: outputShim(outputLines),
      store,
      proposalId: cached.id,
      extensionVersion: "test-version",
      generate: async (editor) => {
        generatedEditor = editor as never
      },
    })

    expect(shownDocuments).toHaveLength(1)
    expect(shownDocuments[0]?.document).toBe(document)
    expect(generatedEditor?.document).toBe(document)
    expect(generatedEditor?.selection.start.line).toBe(0)
    expect(generatedEditor?.selection.start.character).toBe(0)
    expect(generatedEditor?.selection.end.line).toBe(1)
    expect(generatedEditor?.selection.end.character).toBe(document.lineAt(1).text.length)
    expect(store.pendingForDocument(document.uri.toString())).toEqual([])
    expect(outputLines.some((line) => line.includes("stage=regenerate.target.ready") && line.includes("proposalIdHash"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=regenerate.clearPrevious") && line.includes("clearedPendingCount=1"))).toBe(true)
    expect(outputLines.some((line) => line.includes("reason=\"selection-invalid\"") && line.includes("没有活动编辑器"))).toBe(false)
  })

  test("webview regenerate does not generate when the stored proposal is missing", async () => {
    const store = new CommentProposalStore()
    let generateCalls = 0

    await regenerateFromProposal({
      output: outputShim(outputLines),
      store,
      proposalId: "missing-proposal",
      generate: async () => {
        generateCalls += 1
      },
    })

    expect(generateCalls).toBe(0)
    expect(statusMessages).toContain("未找到可重新生成的 AI 注释候选。")
    expect(outputLines.some((line) => line.includes("stage=regenerate.target.missing"))).toBe(true)
  })

  test("webview regenerate does not generate when the stored selection is outside the current document", async () => {
    const store = new CommentProposalStore()
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const cached = proposalForRange(document, 0, 1, {
      id: "stale-proposal",
      selectionTextEndLine: 99,
    })
    store.replacePendingForDocument(document.uri.toString(), [cached])
    openDocuments.set(document.uri.toString(), document)
    let generateCalls = 0

    await regenerateFromProposal({
      output: outputShim(outputLines),
      store,
      proposalId: cached.id,
      generate: async () => {
        generateCalls += 1
      },
    })

    expect(generateCalls).toBe(0)
    expect(infoMessages).toContain("原始选区已不可用，请重新选择代码后生成 AI 注释。")
    expect(outputLines.some((line) => line.includes("stage=regenerate.target.stale"))).toBe(true)
  })

  test("does not call the final LLM when comment tools are disabled", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let modelCalls = 0

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      toolAgent: {
        collectEvidence: async () => ({
          ok: false as const,
          reason: "tools-disabled" as const,
          message: "AI 注释需要启用 ChipMate 工具检索。请开启工具后重试。",
          elapsedMs: 0,
          roundCount: 0,
          toolCallCount: 0,
          blockedToolCount: 0,
          failedToolCount: 0,
        }),
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("AI 注释需要启用 ChipMate 工具检索。请开启工具后重试。")
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"tools-disabled\""))).toBe(true)
  })

  test("passes tool evidence into the final comment prompt", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let prompt = ""

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      toolAgent: {
        collectEvidence: async (_context, _traceId, logger) => {
          logger?.({ stage: "tool.loop.start", fields: { toolsEnabled: true, permissionMode: "ask", readableToolCount: 2 } })
          logger?.({ stage: "tool.call.start", fields: { toolName: "chipmate_read" } })
          logger?.({ stage: "tool.call.done", fields: { toolName: "chipmate_read", elapsedMs: 4, evidenceItemCount: 1, approved: true, status: "completed" } })
          logger?.({ stage: "tool.loop.done", fields: { success: true, elapsedMs: 6, roundCount: 1, toolCallCount: 1, blockedToolCount: 0, failedToolCount: 0, evidenceItemCount: 1 } })
          return {
            ok: true as const,
            evidenceSummary: "工具: chipmate_read\n证据:\n  1. main.c:1-2 (read)\n     snippet:\n       do_work();",
            evidenceItemCount: 1,
            evidenceSummaryBytes: 82,
            elapsedMs: 6,
            roundCount: 1,
            toolCallCount: 1,
            blockedToolCount: 0,
            failedToolCount: 0,
            outputDirective: "encourage-1-3" as const,
            groundingConfidence: "high" as const,
            groundingSummary: "工具检索证据置信度: high。",
            evidenceCompacted: false,
            exhausted: false,
          }
        },
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(prompt).toContain("仓库证据检索模式：")
    expect(prompt).toContain("tool-driven")
    expect(prompt).toContain("模型工具检索证据：")
    expect(prompt).toContain("chipmate_read")
    expect(prompt).toContain("你已经拥有由模型主动调用本地只读 ChipMate 工具得到的仓库证据。")
    expect(outputLines.some((line) => line.includes("stage=tool.call.done") && line.includes("toolName=\"chipmate_read\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.request.start") && line.includes("retrievalMode=\"tool-driven\""))).toBe(true)
  })

  test("comment tool agent only exposes read-only ChipMate tools", () => {
    const agent = new CommentToolAgentClient({
      getSettings: () => ({ provider: { apiBaseUrl: "", chatModel: "", maxTokens: 0, temperature: 0, topP: 1 }, tools: { enabled: true }, permissions: { mode: "ask" } }) as never,
      getApiKey: async () => "",
      tools: {
        toolDefinitions: () => [
          { type: "function", function: { name: "chipmate_read" } },
          { type: "function", function: { name: "chipmate_search_text" } },
          { type: "function", function: { name: "chipmate_edit_file" } },
          { type: "function", function: { name: "chipmate_write_file" } },
          { type: "function", function: { name: "chipmate_run_command" } },
          { type: "function", function: { name: "chipmate_http_request" } },
        ],
        execute: async () => {
          throw new Error("should not execute")
        },
      },
    })

    expect(agent.readableToolDefinitions().map((item) => item.function.name)).toEqual([
      "chipmate_read",
      "chipmate_search_text",
    ])
  })

  test("does not call the LLM when code graph evidence is not ready", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let modelCalls = 0
    let evidenceCalls = 0

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => {
          evidenceCalls += 1
          return {
            ok: false,
            reason: "codegraph-not-ready" as const,
            message: "AI 注释需要本地 CodeGraph 证据。CodeGraph 当前状态为 indexing。",
            fallbackReason: "codegraph-indexing",
            graphSummaryFunctionCount: 0,
            graphSummaryModuleCount: 0,
            graphSummaryStateMachineCount: 0,
            graphDirectRefCount: 0,
            ragRefCount: 0,
            missingEvidenceCount: 0,
            identifierCount: 0,
            anchorCount: 0,
            outputDirective: "allow-empty" as const,
            groundingConfidence: "none" as const,
            groundingSummary: "仓库证据暂不可用于注释生成。",
            evidenceCompacted: false,
          }
        },
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(evidenceCalls).toBe(1)
    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("AI 注释需要本地 CodeGraph 证据。CodeGraph 当前状态为 indexing。")
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"evidence-unavailable\""))).toBe(true)
  })

  test("does not call the LLM when graph evidence is empty", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let modelCalls = 0

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => ({
          ok: false as const,
          reason: "no-graph-evidence" as const,
          message: "没有找到可支撑当前选区注释的仓库证据。",
          graphElapsedMs: 3,
          fallbackReason: "graph-empty",
          graphSummaryFunctionCount: 1,
          graphSummaryModuleCount: 1,
          graphSummaryStateMachineCount: 0,
          graphDirectRefCount: 0,
          ragRefCount: 0,
          missingEvidenceCount: 0,
          identifierCount: 2,
          anchorCount: 2,
          outputDirective: "allow-empty" as const,
          groundingConfidence: "low" as const,
          groundingSummary: "CodeGraph 证据置信度: low。",
          evidenceCompacted: false,
        }),
      },
      llmClient: {
        generate: async () => {
          modelCalls += 1
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(modelCalls).toBe(0)
    expect(infoMessages).toContain("没有找到可支撑当前选区注释的仓库证据。")
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"evidence-no-graph-results\""))).toBe(true)
  })

  test("passes repository evidence into the prompt", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let prompt = ""

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence(),
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(prompt).toContain("仓库证据检索模式：")
    expect(prompt).toContain("graph-only")
    expect(prompt).toContain("注释生成指令：")
    expect(prompt).toContain("encourage-1-3")
    expect(prompt).toContain("Allowed insertion anchors（允许插入锚点）：")
    expect(prompt).toContain("CodeGraph 仓库摘要：")
    expect(prompt).toContain("CodeGraph 直接引用：")
    expect(prompt).toContain("graph-only 模式仍然提供仓库级结构理解。")
    expect(prompt).toContain("当前选区已经有足够的 CodeGraph 证据支撑高价值注释候选，最多返回 1 条。")
    expect(prompt).toContain("selectionIntent=localBlock")
    expect(prompt).toContain("proposalBudget=1")
    expect(prompt).toContain("primaryAnchorPolicy=allow-when-useful")
    expect(prompt).toContain("primaryAnchorLine=none")
    expect(prompt).toContain("只在局部结构锚点存在非显然语义时生成注释，不强制生成整体/函数级注释。")
    expect(prompt).toContain("insertBeforeLine 必须从 Allowed insertion anchors")
    expect(prompt).toContain("必须逐字复制 Allowed insertion anchors 里的 insertBeforeLine 数值")
    expect(prompt).toContain("\"insertBeforeLine\": 0")
    expect(prompt).toContain("\"vscodeDisplayLine\": 1")
    expect(prompt).toContain("\"targetLineText\": \"int main(void) {\"")
    expect(prompt).toContain("禁止逐行解释代码")
    expect(prompt).toContain("第一个可见输出字符必须是 {")
    expect(prompt).toContain("不要输出思考过程、自我检查、验证步骤")
    expect(prompt).toContain("commentText 必须使用简体中文自然语言编写")
    expect(prompt).toContain("reason 必须使用简体中文")
    expect(prompt).toContain("\"codeEvidence\": [")
    expect(prompt).toContain("\"source\": \"selection\" | \"repository\"")
    expect(prompt).toContain("每条 proposal 必须至少包含 1 条 source=\"selection\" 的 codeEvidence")
    expect(prompt).toContain("codeEvidence.codeSummary 要说明对应行段的代码写了什么。")
    expect(prompt).toContain("codeEvidence.meaning 要说明这段代码代表什么、为什么重要、它如何支撑 commentText。")
    expect(prompt).toContain("如果无法把注释绑定到 selected range 内的具体行段，不要生成该 proposal。")
    expect(prompt).toContain("函数名、变量名、宏名、寄存器名、协议名、硬件缩写、路径和 API 名称必须保持原文")
  })

  test("prioritizes the primary anchor for long selections while allowing internal high-value anchors", async () => {
    const document = documentShim([
      "static void hub_chr_read(void *opaque, const uint8_t *buf, int size)",
      "{",
      "    HubCharBackend *backend = opaque;",
      "    CharFrontend *fe = backend->hub->parent.fe;",
      "",
      "    if (fe && fe->chr_read) {",
      "        fe->chr_read(fe->opaque, buf, size);",
      "    }",
      "    if (backend->reset_pending) {",
      "        rollback_backend(backend);",
      "    }",
      "}",
    ])
    activeTextEditor = selectedEditorForRange(document, 0, 11)
    let prompt = ""

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({
          retrievalMode: "hybrid",
          outputDirective: "encourage-1-3",
          groundingConfidence: "medium",
          groundingSummary: "Hybrid 证据置信度: medium。仓库证据支持主锚点和内部关键块注释。",
          fallbackReason: undefined,
          ragRefCount: 1,
          evidenceSections: {
            selectionAnchors: "选区标识符: hub_chr_read, fe, chr_read, reset_pending",
            graphRepoSummary: "函数摘要:\n- hub_chr_read (main.c): forwards data through the selected frontend callback.",
            graphDirectRefs: "- main.c:6-7 -> fe->chr_read(fe->opaque, buf, size);",
            ragSummary: "Hybrid 证据引用:\n- chardev/char-fe.c:10-14 -> frontend callbacks forward backend data.",
            groundingSummary: "Hybrid 证据置信度: medium。仓库证据支持主锚点和内部关键块注释。",
          },
        }),
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(prompt).toContain("selectionIntent=functionOrBlockSummary")
    expect(prompt).toContain("proposalBudget=3")
    expect(prompt).toContain("primaryAnchorPolicy=required-when-supported")
    expect(prompt).toContain("primaryAnchorLine=0")
    expect(prompt).toContain("primaryAnchorKind=function")
    expect(prompt).toContain("internalAnchorLines=[5,8]")
    expect(prompt).toContain("当前审阅范围是用户选区，看起来是较长的函数或结构块。")
    expect(prompt).toContain("默认返回 1 条整体/入口/函数级或块级中文注释")
    expect(prompt).toContain("凡是有独立非显然语义、控制流含义、状态迁移、错误恢复、并发/ownership、DMA/cache 或硬件顺序约束的内部锚点，都可以生成候选，直到达到 proposalBudget。")
    expect(prompt).toContain("不要把策略误解为只生成函数总注释")
    expect(prompt).toContain("内部关键错误处理、状态迁移、并发/ownership、DMA/cache 或硬件顺序约束仍应被注释")
    expect(prompt).toContain("当前 graph/RAG evidence 已经具备 direct refs 和至少 medium grounding")
    expect(prompt).toContain("最多 3 条")
    expect(prompt).toContain("鼓励对象是 primary anchor 与内部高价值 anchors，而不是泛化多生成。")
    expect(outputLines.some((line) => line.includes("stage=selection.ready") && line.includes("selectionIntent=\"functionOrBlockSummary\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=anchors.done") && line.includes("primaryAnchorLine=0") && line.includes("internalAnchorCount=2") && line.includes("proposalBudget=3"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.request.start") && line.includes("outputDirective=\"encourage-1-3\"") && line.includes("primaryAnchorPolicy=\"required-when-supported\""))).toBe(true)
  })

  test("stores a valid internal-only proposal for a long selection", async () => {
    const document = documentShim([
      "static void hub_chr_read(void *opaque, const uint8_t *buf, int size)",
      "{",
      "    HubCharBackend *backend = opaque;",
      "    CharFrontend *fe = backend->hub->parent.fe;",
      "",
      "    if (fe && fe->chr_read) {",
      "        fe->chr_read(fe->opaque, buf, size);",
      "    }",
      "    if (backend->reset_pending) {",
      "        rollback_backend(backend);",
      "    }",
      "}",
    ])
    const store = new CommentProposalStore()
    activeTextEditor = selectedEditorForRange(document, 0, 11)

    await generateForSelection({
      output: outputShim(outputLines),
      store,
      evidenceService: {
        collect: async () => successEvidence({
          retrievalMode: "hybrid",
          outputDirective: "encourage-1-3",
          groundingConfidence: "medium",
          fallbackReason: undefined,
          ragRefCount: 1,
        }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [{
              kind: "logicBlock",
              insertBeforeLine: 5,
              indent: "    ",
              commentText: "// 仅在 frontend 提供 read 回调时才转发，避免断开的 frontend 收到数据。",
              anchor: { targetLineText: "    if (fe && fe->chr_read) {" },
              confidence: "medium",
              reason: "内部回调转发条件比函数总述更具体，且由仓库证据支撑。",
              codeEvidence: [codeEvidence({
                startLine: 5,
                endLine: 6,
                anchorLabel: "if",
                codeSummary: "这里检查 fe 和 fe->chr_read 是否存在，然后调用 frontend read 回调。",
                meaning: "它表示数据只会转发给仍然连接且提供回调的 frontend。",
              })],
            }],
          }),
          elapsedMs: 3,
        }),
      },
    })

    const pending = store.pendingForDocument(document.uri.toString())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.insertBeforeLine).toBe(5)
    expect(pending[0]?.kind).toBe("logicBlock")
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("acceptedCount=1"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("primaryProposalMissing=true"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"proposals-stored\"") && line.includes("selectionIntent=\"functionOrBlockSummary\""))).toBe(true)
    expect(outputLines.join("\n")).toContain("acceptedEvidenceSpanCount=1")
    expect(outputLines.join("\n")).not.toContain("这里检查 fe 和 fe->chr_read 是否存在")
    expect(outputLines.join("\n")).not.toContain("数据只会转发给仍然连接且提供回调的 frontend")
  })

  test("accepts a dynamic function proposal budget beyond three internal anchors", async () => {
    const lines = [
      "static void complex_flow(Owner *owner)",
      "{",
      "    if (owner->ready) {",
      "        prepare_owner(owner);",
      "    }",
      "    if (owner->needs_flush) {",
      "        flush_cache(owner);",
      "    }",
      "    while (owner->pending) {",
      "        drain_queue(owner);",
      "    }",
      "    for (int i = 0; i < owner->slots; i++) {",
      "        submit_slot(owner, i);",
      "    }",
      "}",
    ]
    const document = documentShim(lines)
    const store = new CommentProposalStore()
    activeTextEditor = selectedEditorForRange(document, 0, 14)

    await generateForSelection({
      output: outputShim(outputLines),
      store,
      evidenceService: {
        collect: async () => successEvidence({
          retrievalMode: "hybrid",
          outputDirective: "encourage-1-3",
          groundingConfidence: "medium",
          fallbackReason: undefined,
          ragRefCount: 1,
        }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [0, 2, 5, 8, 11].map((line, index) => ({
              kind: line === 0 ? "functionHeader" : "logicBlock",
              insertBeforeLine: line,
              indent: line === 0 ? "" : "    ",
              commentText: line === 0
                ? "/**\n * 说明 complex_flow 如何按 owner 状态推进准备、刷新和队列提交。\n */"
                : `// 说明第 ${line + 1} 行结构块的非显然流程约束。`,
              anchor: { targetLineText: lines[line] },
              confidence: "medium",
              reason: `第 ${line + 1} 行锚点有独立流程含义。`,
              codeEvidence: [codeEvidence({
                startLine: line,
                endLine: Math.min(line + 1, lines.length - 1),
                anchorLabel: line === 0 ? "function" : "control block",
                codeSummary: `第 ${line + 1} 行开始一个关键结构块。`,
                meaning: "该结构块代表函数流程中的独立决策点。",
              })],
            })),
          }),
          elapsedMs: 3,
        }),
      },
    })

    const pending = store.pendingForDocument(document.uri.toString())
    expect(pending).toHaveLength(5)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("acceptedCount=5") && line.includes("proposalBudget=5"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("returnedAnchorLines=[0,2,5,8,11]"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("primaryProposalReturned=true") && line.includes("primaryProposalAccepted=true"))).toBe(true)
  })

  test("shows a visible message when the model returns no useful comment proposals", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence(),
      },
      llmClient: {
        generate: async () => ({
          text: "{\"proposals\":[]}",
          elapsedMs: 1,
        }),
      },
    })

    expect(infoMessages).toContain("没有生成 AI 注释候选。详细诊断请查看 ChipMate Comment 输出。")
  })

  test("opens the review panel immediately and updates generation progress", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    const progressUpdates: unknown[] = []

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      reviewPanel: {
        openForGeneration: (progress) => {
          progressUpdates.push(JSON.parse(JSON.stringify({ type: "open", progress })))
        },
        updateGeneration: (progress) => {
          progressUpdates.push(JSON.parse(JSON.stringify({ type: "update", progress })))
        },
        clearGeneration: (uri) => {
          progressUpdates.push({ type: "clear", uri })
        },
        openForDocument: (uri, selectedProposalId) => {
          progressUpdates.push({ type: "review", uri, selectedProposalId })
        },
      },
      evidenceService: {
        collect: async (_context, logger) => {
          logger?.({ stage: "evidence.graph.start", fields: { identifierCount: 2, anchorCount: 2 } })
          logger?.({ stage: "evidence.graph.done", fields: { elapsedMs: 12, graphDirectRefCount: 1, graphSummaryFunctionCount: 1 } })
          return successEvidence({ graphElapsedMs: 12 })
        },
      },
      llmClient: {
        generate: async (_prompt, _signal, _timeoutMs, diagnostics) => {
          diagnostics?.({ stage: "model.http.prepare", fields: { usageAvailable: false } })
          diagnostics?.({ stage: "model.stream.delta", fields: {
            streamPhase: "thinking",
            elapsedMs: 12,
            deltaCount: 1,
            rawBytes: 40,
            visibleBytes: 0,
            reasoningBytes: 10,
            reasoningPreview: "正在判断是否有高价值注释",
            visiblePreview: "",
            jsonPrefixGuard: "pending",
            finishReason: "none",
          } })
          diagnostics?.({ stage: "model.stream.delta", fields: {
            streamPhase: "receiving-json",
            elapsedMs: 24,
            deltaCount: 2,
            rawBytes: 80,
            visibleBytes: 18,
            reasoningBytes: 10,
            reasoningPreview: "正在判断是否有高价值注释",
            visiblePreview: "{\"anchor\":{\"targetLineText\":\"<redacted>\"}}",
            jsonPrefixGuard: "accepted",
            finishReason: "none",
          } })
          diagnostics?.({ stage: "model.http.stream.done", fields: {
            elapsedMs: 34,
            usageAvailable: true,
            usagePromptTokens: 10,
            usageCompletionTokens: 20,
            usageTotalTokens: 30,
            usageReasoningTokens: 5,
            usageTextTokens: 15,
          } })
          return {
            text: "{\"proposals\":[]}",
            elapsedMs: 34,
            tokenUsage: {
              usageAvailable: true,
              usagePromptTokens: 10,
              usageCompletionTokens: 20,
              usageTotalTokens: 30,
              usageReasoningTokens: 5,
              usageTextTokens: 15,
            },
          }
        },
      },
    })

    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("\"type\":\"open\""))).toBe(true)
    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("检索 CodeGraph 证据"))).toBe(true)
    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("正在判断是否有高价值注释"))).toBe(true)
    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("<redacted>"))).toBe(true)
    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("\"usageCompletionTokens\":20"))).toBe(true)
    expect(progressUpdates.some((entry) => JSON.stringify(entry).includes("\"status\":\"empty\""))).toBe(true)
    expect(outputLines.join("\n")).not.toContain("正在判断是否有高价值注释")
    expect(JSON.stringify(progressUpdates)).not.toContain("do_work();")
  })

  test("allows empty graph-only prompt when grounding is low", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let prompt = ""

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({
          outputDirective: "allow-empty",
          groundingConfidence: "low",
          groundingSummary: "CodeGraph 证据置信度: low。仓库证据较弱；只有当 provided refs 明确给出非显然解释时才生成注释。",
          evidenceCompacted: false,
          evidenceSections: {
            selectionAnchors: "选区标识符: do_work",
            graphRepoSummary: "函数摘要:\n- do_work (main.c): coordinates the owner flow.",
            graphDirectRefs: "- main.c:2-2 -> do_work();",
            ragSummary: "",
            groundingSummary: "CodeGraph 证据置信度: low。仓库证据较弱；只有当 provided refs 明确给出非显然解释时才生成注释。",
          },
        }),
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(prompt).toContain("注释生成指令：")
    expect(prompt).toContain("allow-empty")
    expect(prompt).toContain("当 CodeGraph 证据不能明确支撑非显然注释时，返回空 proposals 数组。")
    expect(prompt).not.toContain("当前选区已经有足够的 CodeGraph 证据支撑 1 到 3 条高价值注释候选。")
  })

  test("logs detailed empty-array diagnostics across the generation stages", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async (_context, logger) => {
          logger?.({ stage: "evidence.graph.start", fields: { retrievalMode: "graph-only" } })
          logger?.({ stage: "evidence.graph.done", fields: { elapsedMs: 2, graphDirectRefCount: 1 } })
          return successEvidence({ graphElapsedMs: 2 })
        },
      },
      llmClient: {
        generate: async (_prompt: string, _signal?: AbortSignal, _timeoutMs?: number, diagnostics?: (event: { stage: string; fields?: Record<string, unknown> }) => void) => {
          diagnostics?.({
            stage: "model.http.prepare",
            fields: {
              client: "comment-stream",
              stream: true,
              thinkingBudget: "disabled",
              timeoutMs: 45000,
              providerHostHash: "hosthash",
              modelHash: "modelhash",
              promptBytes: 100,
              requestBodyBytes: 220,
            },
          })
          diagnostics?.({
            stage: "model.http.fetch.start",
            fields: {
              client: "comment-stream",
              stream: true,
              thinkingBudget: "disabled",
              timeoutMs: 45000,
              providerHostHash: "hosthash",
              modelHash: "modelhash",
              promptBytes: 100,
              requestBodyBytes: 220,
            },
          })
          diagnostics?.({
            stage: "model.response.normalize",
            fields: {
              reasoningDeltaCount: 0,
              reasoningBytes: 0,
              strippedThinkBlockCount: 0,
              openThinking: false,
              jsonFenceStripped: false,
              jsonFenceLanguage: "none",
              thinkingBudget: "disabled",
              normalizedTextBytes: 16,
            },
          })
          return {
            text: "{\"proposals\":[]}",
            elapsedMs: 3,
          }
        },
      },
      extensionVersion: "0.0.236",
    })

    expect(outputLines.some((line) => line.includes("stage=model.request.start"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.http.prepare") && line.includes("client=\"comment-stream\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.http.prepare") && line.includes("thinkingBudget=\"disabled\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.http.fetch.start") && line.includes("stream=true"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.response.normalize") && line.includes("normalizedTextBytes=16") && line.includes("jsonFenceStripped=false"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.request.done"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=model.response.preview"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=parse.done") && line.includes("proposalCount=0"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("acceptedCount=0"))).toBe(true)
    expect(outputLines.some((line) => line.includes("outputDirective=\"encourage-1-3\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("groundingConfidence=\"high\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("evidenceCompacted=true"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"graph-only-returned-empty-array\""))).toBe(true)
    expect(outputLines.join("\n")).not.toContain("do_work();")
  })

  test("logs thinking-only model output as a specific terminal reason", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => {
          throw new CommentLLMGenerationError("模型只返回了 thinking 内容，没有返回 JSON。", "model-returned-only-thinking", {
            reasoningDeltaCount: 0,
            reasoningBytes: 120,
            strippedThinkBlockCount: 1,
            openThinking: false,
            normalizedTextBytes: 0,
          })
        },
      },
      extensionVersion: "0.0.240",
    })

    expect(outputLines.some((line) => line.includes("stage=model.request.failed") && line.includes("terminalReason=\"model-returned-only-thinking\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"model-returned-only-thinking\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=parse.done"))).toBe(false)
    expect(errorMessages).toContain("AI 注释生成失败。请查看 ChipMate Comment 输出。")
    expect(applyEditCalls).toBe(0)
  })

  test("logs non-json model prefix as a specific terminal reason", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => {
          throw new CommentLLMGenerationError("模型输出不是 JSON 起始内容。", "model-non-json-prefix", {
            jsonPrefixGuard: "failed",
            nonJsonPrefixBytes: 64,
            normalizedTextBytes: 0,
          })
        },
      },
      extensionVersion: "0.0.241",
    })

    expect(outputLines.some((line) => line.includes("stage=model.request.failed") && line.includes("terminalReason=\"model-non-json-prefix\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"model-non-json-prefix\""))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=parse.done"))).toBe(false)
    expect(errorMessages).toContain("AI 注释生成失败。请查看 ChipMate Comment 输出。")
    expect(applyEditCalls).toBe(0)
  })

  test("logs validator-filtered-all when every generated proposal is discarded", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [{
              kind: "logicBlock",
              insertBeforeLine: 0,
              indent: "    ",
              commentText: "return 0;",
              anchor: { targetLineText: "int main(void) {" },
              confidence: "high",
              reason: "not allowed",
              codeEvidence: [codeEvidence({
                startLine: 0,
                endLine: 0,
                anchorLabel: "function",
                codeSummary: "这里是 main 入口。",
                meaning: "该证据用于测试 validator 会优先拒绝非注释代码。",
              })],
            }],
          }),
          elapsedMs: 3,
        }),
      },
    })

    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("discardedCount=1"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"validator-filtered-all\""))).toBe(true)
  })

  test("logs primary discard reason when a returned function entry proposal is filtered", async () => {
    const lines = [
      "static int complex_flow(owner_t *owner)",
      "{",
      "    if (owner->ready) {",
      "        do_work(owner);",
      "    }",
      "    return 0;",
      "    cleanup_owner(owner);",
      "}",
    ]
    const document = documentShim(lines)
    activeTextEditor = selectedEditorForRange(document, 0, 7)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({
          groundingConfidence: "medium",
          outputDirective: "encourage-1-3",
        }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [{
              kind: "functionHeader",
              insertBeforeLine: 0,
              indent: "",
              commentText: "// if (owner->ready) {",
              anchor: { targetLineText: lines[0] },
              confidence: "high",
              reason: "用于测试 primary discard reason。",
              codeEvidence: [codeEvidence({
                startLine: 0,
                endLine: 7,
                anchorLabel: "function",
                codeSummary: "complex_flow 是完整函数入口。",
                meaning: "该入口应产生函数级注释，但 commentText 本身像代码。",
              })],
            }],
          }),
          elapsedMs: 3,
        }),
      },
    })

    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("primaryProposalReturned=true") && line.includes("primaryProposalAccepted=false"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("primaryDiscardReason=\"commentText 看起来像代码\""))).toBe(true)
  })

  test("repairs off-by-one anchor lines and logs the repair", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    const store = new CommentProposalStore()
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store,
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [{
              kind: "functionHeader",
              insertBeforeLine: 1,
              indent: "",
              commentText: "/**\n * 说明 main 初始化入口的上下文。\n */",
              anchor: { targetLineText: "int main(void) {" },
              confidence: "high",
              reason: "模型行号偏移一行，但 anchor 文本唯一匹配函数入口。",
              codeEvidence: [codeEvidence({
                startLine: 0,
                endLine: 0,
                anchorLabel: "function",
                codeSummary: "这里是 main 函数入口。",
                meaning: "它支撑函数头注释应插入到入口前。",
              })],
            }],
          }),
          elapsedMs: 3,
        }),
      },
    })

    const pending = store.pendingForDocument(document.uri.toString())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.insertBeforeLine).toBe(0)
    expect(outputLines.some((line) => line.includes("stage=validate.done") && line.includes("anchorLineRepaired=true"))).toBe(true)
    expect(outputLines.some((line) => line.includes("originalInsertBeforeLine=1") && line.includes("repairedInsertBeforeLine=0"))).toBe(true)
  })

  test("logs parse-failed when the model returns non-JSON content", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => ({
          text: "not json",
          elapsedMs: 3,
        }),
      },
    })

    expect(outputLines.some((line) => line.includes("stage=parse.done") && line.includes("success=false"))).toBe(true)
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"parse-failed\""))).toBe(true)
  })

  test("passes graph and rag evidence as parallel sections in hybrid mode", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    let prompt = ""

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      evidenceService: {
        collect: async () => successEvidence({
          retrievalMode: "hybrid",
          outputDirective: "allow-empty",
          groundingConfidence: "high",
          groundingSummary: "Hybrid 证据置信度: high。仓库证据强烈支持至少一条非显然注释。",
          evidenceCompacted: true,
          fallbackReason: undefined,
          ragRefCount: 1,
          evidenceItemCount: 2,
          evidenceSummary: "选区锚点证据:\n选区标识符: do_work\nRAG 语义摘要:\n- helpers.c:10-14 -> queue_owner_release(owner);",
          evidenceSummaryBytes: 118,
          evidenceSections: {
            selectionAnchors: "选区标识符: do_work, owner",
            graphRepoSummary: "函数摘要:\n- do_work (main.c): coordinates the owner flow.",
            graphDirectRefs: "- main.c:2-2 -> do_work();",
            ragSummary: "Hybrid 证据引用:\n- helpers.c:10-14 -> queue_owner_release(owner);",
            groundingSummary: "CodeGraph 证据置信度: high。grounded.\nHybrid 证据置信度: high。grounded.",
          },
        }),
      },
      llmClient: {
        generate: async (nextPrompt: string) => {
          prompt = nextPrompt
          return { text: "{\"proposals\":[]}", elapsedMs: 1 }
        },
      },
    })

    expect(prompt).toContain("请把 graph 与 RAG evidence sections 作为并列 grounding sources 综合判断。")
    expect(prompt).toContain("CodeGraph 仓库摘要：")
    expect(prompt).toContain("RAG 语义摘要：")
    expect(prompt).toContain("queue_owner_release")
    expect(prompt).not.toContain("当前选区已经有足够的 CodeGraph 证据支撑 1 到 3 条高价值注释候选。")
    expect(outputLines.some((line) => line.includes("stage=outcome") && line.includes("reason=\"hybrid-returned-empty-array\""))).toBe(true)
  })

  test("opens the review panel after storing generated proposals", async () => {
    const document = documentShim(["int main(void) {", "    do_work();", "}"])
    activeTextEditor = selectedEditor(document)
    const opened: Array<{ uri: string; selectedProposalId?: string }> = []

    await generateForSelection({
      output: outputShim(outputLines),
      store: new CommentProposalStore(),
      reviewPanel: {
        openForDocument: (uri: string, selectedProposalId?: string) => {
          opened.push({ uri, selectedProposalId })
        },
      },
      evidenceService: {
        collect: async () => successEvidence({ graphElapsedMs: 2 }),
      },
      llmClient: {
        generate: async () => ({
          text: JSON.stringify({
            proposals: [{
              kind: "functionHeader",
              insertBeforeLine: 0,
              indent: "",
              commentText: "// 说明 work handoff 的原因。",
              anchor: { targetLineText: "int main(void) {" },
              confidence: "high",
              reason: "ownership 移交流程不直观。",
              codeEvidence: [codeEvidence({
                startLine: 0,
                endLine: 1,
                anchorLabel: "function",
                codeSummary: "这里进入 main 后执行 work handoff。",
                meaning: "它说明注释对应的是入口中的 ownership 移交路径。",
              })],
            }],
          }),
          elapsedMs: 3,
        }),
      },
    })

    expect(opened).toHaveLength(1)
    expect(opened[0]?.uri).toBe(document.uri.toString())
    expect(opened[0]?.selectedProposalId?.startsWith("comment-")).toBe(true)
  })
})

function documentShim(lines: string[], options: { version?: number; uri?: string; languageId?: string } = {}) {
  return {
    uri: new UriShim(options.uri ?? "file:///repo/main.c", "/repo/main.c"),
    version: options.version ?? 1,
    languageId: options.languageId ?? "c",
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line],
    }),
    getText: (range?: RangeShim) => {
      if (!range) return lines.join("\n")
      if (range.start.line === range.end.line) {
        return lines[range.start.line].slice(range.start.character, range.end.character)
      }
      const selected = [lines[range.start.line].slice(range.start.character)]
      for (let line = range.start.line + 1; line < range.end.line; line += 1) selected.push(lines[line])
      selected.push(lines[range.end.line].slice(0, range.end.character))
      return selected.join("\n")
    },
  }
}

function proposalForDocument(document: ReturnType<typeof documentShim>, overrides: Partial<CommentProposal> = {}): CommentProposal {
  const source = overrides.source ?? "selection"
  const selectionStartLine = 1
  const selectionEndLine = 1
  const selectionStartCharacter = 0
  const selectionEndCharacter = document.lineAt(1).text.length
  const selectedCode = document.getText(new RangeShim(selectionStartLine, selectionStartCharacter, selectionEndLine, selectionEndCharacter))
  const contextBefore = document.lineAt(0).text
  const contextAfter = document.lineCount > 2 ? document.lineAt(2).text : ""
  return {
    id: "proposal-1",
    kind: "logicBlock",
    insertBeforeLine: 1,
    indent: "    ",
    commentText: "// 说明 work handoff 的原因。",
    anchor: {
      targetLineText: document.lineAt(1).text,
    },
    confidence: "high",
    reason: "ownership 移交流程不直观。",
    codeEvidence: [codeEvidence()],
    uri: document.uri.toString(),
    source,
    documentVersion: document.version,
    selectionStartLine,
    selectionEndLine,
    selectionStartCharacter,
    selectionEndCharacter,
    selectionTextEndLine: selectionEndLine,
    selectionTextEndCharacter: selectionEndCharacter,
    contextHash: commentContextHash({
      source,
      languageId: document.languageId,
      selectionStartLine,
      selectionEndLine,
      selectionStartCharacter,
      selectionEndCharacter,
      selectedCode,
      contextBefore,
      contextAfter,
    }),
    status: "pending",
    ...overrides,
  }
}

function workspaceProposalForDocument(document: ReturnType<typeof documentShim>, overrides: Partial<CommentProposal> = {}): CommentProposal {
  const changedLineSpans = overrides.changedLineSpans ?? [{ startLine: 1, endLine: 1 }]
  const workspaceChangeDiffHash = overrides.workspaceChangeDiffHash ?? "diff"
  const workspaceReviewUnitId = overrides.workspaceReviewUnitId ?? "unit"
  return proposalForDocument(document, {
    source: "workspaceChanges",
    workspaceChangeDiffHash,
    workspaceReviewUnitId,
    workspaceReviewUnitKind: "function",
    changedLineSpans,
    contextHash: commentContextHash({
      source: "workspaceChanges",
      workspaceChangeDiffHash,
      workspaceReviewUnitId,
      workspaceReviewUnitKind: "function",
      changedLineSpans,
      languageId: document.languageId,
      selectionStartLine: 1,
      selectionEndLine: 1,
      selectionStartCharacter: 0,
      selectionEndCharacter: document.lineAt(1).text.length,
      selectedCode: document.getText(new RangeShim(1, 0, 1, document.lineAt(1).text.length)),
      contextBefore: document.lineAt(0).text,
      contextAfter: document.lineCount > 2 ? document.lineAt(2).text : "",
    }),
    ...overrides,
  })
}

function proposalForRange(
  document: ReturnType<typeof documentShim>,
  selectionStartLine: number,
  selectionEndLine: number,
  overrides: Partial<CommentProposal> = {},
): CommentProposal {
  const source = overrides.source ?? "selection"
  const selectionStartCharacter = 0
  const selectionEndCharacter = document.lineAt(selectionEndLine).text.length
  const selectedCode = document.getText(new RangeShim(selectionStartLine, selectionStartCharacter, selectionEndLine, selectionEndCharacter))
  const contextBefore = rangeLines(document, 0, selectionStartLine)
  const contextAfter = rangeLines(document, selectionEndLine + 1, document.lineCount)
  const base = proposalForDocument(document, {
    selectionStartLine,
    selectionEndLine,
    selectionStartCharacter,
    selectionEndCharacter,
    selectionTextEndLine: selectionEndLine,
    selectionTextEndCharacter: selectionEndCharacter,
    contextHash: commentContextHash({
      source,
      languageId: document.languageId,
      selectionStartLine,
      selectionEndLine,
      selectionStartCharacter,
      selectionEndCharacter,
      selectedCode,
      contextBefore,
      contextAfter,
    }),
  })
  return { ...base, ...overrides }
}

function rangeLines(document: ReturnType<typeof documentShim>, startLine: number, endLineExclusive: number) {
  const lines: string[] = []
  for (let line = startLine; line < endLineExclusive; line += 1) lines.push(document.lineAt(line).text)
  return lines.join("\n")
}

function codeEvidence(overrides: Partial<CommentProposal["codeEvidence"][number]> = {}): CommentProposal["codeEvidence"][number] {
  return {
    source: "selection",
    startLine: 1,
    endLine: 1,
    anchorLabel: "logicBlock",
    codeSummary: "这一行执行 work handoff。",
    meaning: "它体现 ownership 移交的关键路径。",
    ...overrides,
  }
}

function outputShim(lines: string[] = []) {
  return {
    appendLine: (value: string) => {
      lines.push(value)
    },
  } as never
}

function selectedEditor(document: ReturnType<typeof documentShim>) {
  return {
    document,
    selection: {
      active: { line: 1, character: 4 },
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 1, character: document.lineAt(1).text.length },
    },
  }
}

function selectedEditorForRange(document: ReturnType<typeof documentShim>, startLine: number, endLine: number) {
  return {
    document,
    selection: {
      active: { line: endLine, character: document.lineAt(endLine).text.length },
      isEmpty: false,
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: document.lineAt(endLine).text.length },
    },
  }
}

function cursorEditor(document: ReturnType<typeof documentShim>, line: number, character: number) {
  return {
    document,
    selection: new SelectionShim(line, character, line, character),
  }
}

function successEvidence(overrides: Partial<CommentEvidenceSuccess> = {}) {
  const base = baseSuccessEvidence()
  return {
    ...base,
    ...overrides,
    evidenceSections: {
      ...base.evidenceSections,
      ...(overrides.evidenceSections ?? {}),
    },
  }
}

function baseSuccessEvidence(): CommentEvidenceSuccess {
  return {
    ok: true as const,
    retrievalMode: "graph-only" as const,
    outputDirective: "encourage-1-3",
    groundingConfidence: "high" as const,
    groundingSummary: "CodeGraph 证据置信度: high。仓库证据强烈支持至少一条非显然注释。",
    evidenceCompacted: true,
    evidenceSections: {
      selectionAnchors: "选区标识符: do_work\n锚点行:\n- do_work();",
      graphRepoSummary: "函数摘要:\n- do_work (main.c): coordinates the owner flow.",
      graphDirectRefs: "- main.c:2-2 -> do_work();",
      ragSummary: "",
      groundingSummary: "CodeGraph 证据置信度: high。仓库证据强烈支持至少一条非显然注释。",
    },
    evidenceSummary: "选区锚点证据:\n选区标识符: do_work",
    evidenceItemCount: 1,
    evidenceSummaryBytes: 47,
    graphElapsedMs: 5,
    fallbackReason: "rag-not-ready",
    graphSummaryFunctionCount: 1,
    graphSummaryModuleCount: 1,
    graphSummaryStateMachineCount: 0,
    graphDirectRefCount: 1,
    ragRefCount: 0,
    missingEvidenceCount: 0,
    identifierCount: 2,
    anchorCount: 2,
  }
}
