import { liquidIcon } from "../webview/liquid-icons"

const commentReviewIcons = {
  retry: liquidIcon("retry"),
} as const

export type CommentReviewWebviewProposal = {
  id: string
  fileLabel?: string
  source?: "selection" | "currentFunction" | "workspaceChanges"
  line: number
  kind: string
  confidence: string
  summary: string
  commentText: string
  reason: string
  codeEvidence: Array<{
    source: "selection" | "repository"
    filePath?: string
    startLine: number
    endLine: number
    anchorLabel: string
    codeSummary: string
    meaning: string
  }>
  status: string
}

export type CommentGenerationProgressStep = {
  id: string
  label: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  detail?: string
  elapsedMs?: number
}

export type CommentGenerationTokenUsage = {
  usageAvailable: boolean
  usagePromptTokens?: number
  usageCompletionTokens?: number
  usageTotalTokens?: number
  usageReasoningTokens?: number
  usageTextTokens?: number
}

export type CommentGenerationStreamState = {
  phase: "waiting" | "thinking" | "receiving-json" | "normalizing" | "done" | "failed"
  elapsedMs?: number
  deltaCount?: number
  rawBytes?: number
  visibleBytes?: number
  reasoningBytes?: number
  reasoningPreview?: string
  visiblePreview?: string
  jsonPrefixGuard?: string
  finishReason?: string
  updatedAt?: number
}

export type CommentGenerationToolState = {
  roundCount?: number
  toolCallCount?: number
  blockedToolCount?: number
  failedToolCount?: number
  evidenceItemCount?: number
  latestToolName?: string
  latestStatus?: "running" | "done" | "blocked" | "failed"
  latestDetail?: string
  entries: Array<{
    toolName: string
    status: "running" | "done" | "blocked" | "failed"
    elapsedMs?: number
    evidenceItemCount?: number
    detail?: string
  }>
}

export type CommentGenerationProgressState = {
  traceId: string
  uri: string
  source?: "selection" | "currentFunction" | "workspaceChanges"
  fileLabel: string
  uriHash: string
  status: "running" | "succeeded" | "empty" | "failed"
  currentStage: string
  startedAt: number
  finishedAt?: number
  steps: CommentGenerationProgressStep[]
  tokenUsage?: CommentGenerationTokenUsage
  stream?: CommentGenerationStreamState
  tools?: CommentGenerationToolState
  terminalReason?: string
  detail?: string
}

export type CommentWorkspaceChangesWebviewState = {
  diffHash: string
  rootLabel: string
  changedFileCount: number
  hunkCount: number
  units: Array<{
    id: string
    fileLabel: string
    title: string
    unitKind: string
    startLine: number
    endLine: number
    changedLineSpans: Array<{ startLine: number; endLine: number }>
    hunkCount: number
  }>
  skipped: Array<{
    relativePath: string
    reason: string
    detail: string
  }>
}

export type CommentReviewWebviewState = {
  mode: "generating" | "review" | "empty" | "failed" | "reviewChanges"
  fileLabel: string
  source?: "selection" | "currentFunction" | "workspaceChanges"
  uriHash: string
  selectedProposalId?: string
  progress?: CommentGenerationProgressState
  workspaceChanges?: CommentWorkspaceChangesWebviewState
  selectedWorkspaceUnitIds?: string[]
  canUndoLastBulkAccept?: boolean
  proposals: CommentReviewWebviewProposal[]
}

export function createCommentReviewHtml(cspSource: string, nonce = createNonce()) {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
  <title>AI 注释候选</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      --accent: var(--vscode-textLink-foreground);
      --card: color-mix(in srgb, var(--vscode-editorWidget-background) 84%, transparent);
      --card-strong: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 22%, var(--card));
      --code-bg: color-mix(in srgb, var(--vscode-editor-background) 76%, var(--vscode-editorWidget-background));
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 180px),
        var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .close {
      flex: 0 0 auto;
    }
    .list {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .review-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--card) 86%, transparent);
      box-shadow: 0 10px 26px color-mix(in srgb, #000 18%, transparent);
    }
    .review-toolbar-title {
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .workspaceChanges {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .workspaceSummary,
    .workspaceSkipped {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--card) 88%, transparent);
      box-shadow: 0 10px 26px color-mix(in srgb, #000 16%, transparent);
    }
    .workspaceSummaryTitle {
      color: var(--fg);
      font-weight: 650;
    }
    .workspaceUnitList,
    .workspaceSkippedList {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
      min-width: 0;
    }
    .workspaceUnit {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
      border-radius: 8px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 72%),
        color-mix(in srgb, var(--code-bg) 84%, transparent);
    }
    .workspaceUnit input {
      margin-top: 3px;
    }
    .workspaceUnitTitle {
      color: var(--fg);
      font-weight: 620;
      overflow-wrap: anywhere;
    }
    .workspaceUnitMeta,
    .workspaceSkippedItem {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .empty {
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--muted);
      background: var(--card);
    }
    .progress {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 11%, transparent), transparent 70%),
        var(--card);
      box-shadow: 0 16px 36px color-mix(in srgb, #000 22%, transparent);
    }
    .progress.failed {
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 56%, var(--border));
    }
    .progress.empty {
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 56%, var(--border));
    }
    .progress-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
    }
    .progress-title {
      font-size: 14px;
      font-weight: 650;
    }
    .progress-stage,
    .progress-detail,
    .token-usage {
      color: var(--muted);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .progress-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .commentThinkingLine {
      margin-top: 4px;
      border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
      border-radius: 6px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 72%),
        color-mix(in srgb, var(--code-bg) 88%, transparent);
      color: var(--muted);
      overflow: hidden;
      transition: border-color 120ms ease, background 120ms ease;
      min-width: 0;
    }
    .commentThinkingLine:hover,
    .commentThinkingLine:focus-within {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 42%, var(--border));
      background: color-mix(in srgb, var(--code-bg) 88%, var(--vscode-focusBorder) 8%);
    }
    .commentThinkingLine summary {
      cursor: pointer;
      min-height: 22px;
      padding: 2px 7px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      outline: none;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .commentThinkingLine summary:focus-visible {
      color: var(--fg);
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    }
    .thinkingSummaryLabel {
      flex: 0 0 auto;
      color: var(--fg);
      font-weight: 650;
    }
    .thinkingPreview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
    }
    .commentThinkingLine .dots {
      flex: 0 0 auto;
      display: inline-flex;
      gap: 2px;
      align-items: center;
    }
    .commentThinkingLine .dots span {
      width: 3px;
      height: 3px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.36;
      animation: comment-thinking-dot 1.1s infinite ease-in-out;
    }
    .commentThinkingLine .dots span:nth-child(2) { animation-delay: 140ms; }
    .commentThinkingLine .dots span:nth-child(3) { animation-delay: 280ms; }
    .commentThinkingLine:not(.is-running) .dots span {
      animation: none;
      opacity: 0.24;
    }
    .commentThinkingDetail {
      margin: 0;
      padding: 6px 7px;
      overflow-x: auto;
      overflow-y: visible;
      border-top: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      line-height: 1.35;
    }
    .toolTrace {
      display: grid;
      gap: 4px;
      margin-top: 5px;
      padding: 6px;
      border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, var(--code-bg) 84%, transparent);
      min-width: 0;
    }
    .toolTraceRow {
      display: grid;
      grid-template-columns: minmax(76px, 1fr) auto;
      gap: 6px;
      align-items: center;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.35;
      min-width: 0;
    }
    .toolTraceName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fg);
    }
    .toolTraceMeta {
      white-space: nowrap;
      color: var(--muted);
    }
    .toolTraceRow.blocked .toolTraceName,
    .toolTraceRow.failed .toolTraceName {
      color: var(--vscode-errorForeground);
    }
    @keyframes comment-thinking-dot {
      0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
      40% { opacity: 0.9; transform: translateY(-1px); }
    }
    .steps {
      display: grid;
      gap: 7px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .step {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      min-width: 0;
      color: var(--muted);
    }
    .step-icon {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 11px;
      line-height: 1;
    }
    .step.running .step-icon {
      border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent),
        0 0 12px color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .step-spinner {
      width: 12px;
      height: 12px;
      display: inline-flex;
      flex: 0 0 auto;
      box-sizing: border-box;
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
      border-top-color: var(--accent);
      border-right-color: color-mix(in srgb, var(--accent) 60%, transparent);
      animation: commentStepSpin 840ms linear infinite;
    }
    @keyframes commentStepSpin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes commentStepPulse {
      0%, 100% {
        opacity: 0.42;
        transform: scale(0.88);
      }
      50% {
        opacity: 1;
        transform: scale(1);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .step-spinner {
        animation: commentStepPulse 1.6s ease-in-out infinite;
      }
    }
    .step.done .step-icon {
      color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 84%, var(--fg));
      border-color: currentColor;
    }
    .step.failed .step-icon {
      color: var(--vscode-errorForeground);
      border-color: currentColor;
    }
    .step-main {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .step-label {
      color: var(--fg);
      overflow-wrap: anywhere;
    }
    .step-detail {
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .step-time {
      color: var(--muted);
      white-space: nowrap;
      font-size: 12px;
    }
    .proposal {
      display: grid;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      box-shadow: 0 10px 28px color-mix(in srgb, #000 24%, transparent);
    }
    .proposal.selected {
      border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
      background: var(--card-strong);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .summary {
      color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 82%, var(--fg));
      font-family: var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
      line-height: 1.45;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    button {
      min-height: 26px;
      padding: 3px 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
      border-radius: 7px;
      background: color-mix(in srgb, var(--button-secondary-background, var(--card)) 78%, transparent);
      color: var(--fg);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: color-mix(in srgb, var(--accent) 18%, var(--card));
    }
    button.primary {
      background: color-mix(in srgb, var(--accent) 24%, var(--card));
      border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    }
    button.danger {
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 54%, var(--border));
      background: color-mix(in srgb, var(--vscode-errorForeground) 10%, var(--card));
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .actionButtonIcon {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .actionButtonIcon .oc-liquid-icon {
      width: 14px;
      height: 14px;
    }
    .actionButtonLabel {
      min-width: 0;
    }
    .comment {
      margin: 0;
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: 8px;
      background: var(--code-bg);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .reason {
      color: var(--muted);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .evidence {
      display: grid;
      gap: 7px;
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
      border-radius: 8px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%),
        color-mix(in srgb, var(--card) 88%, transparent);
      color: var(--muted);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .evidence-title {
      color: var(--fg);
      font-weight: 650;
      font-size: 12px;
    }
    .evidence-list {
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
      min-width: 0;
    }
    .evidence-item {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .evidence-meta {
      color: var(--fg);
      font-weight: 600;
      font-size: 12px;
    }
    .evidence-text {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .reason strong {
      color: var(--fg);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>AI 注释候选</h1>
        <div id="subtitle" class="subtitle">等待候选注释...</div>
      </div>
      <button id="closePanel" class="close" type="button">关闭</button>
    </header>
    <section id="proposalList" class="list" aria-live="polite"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = vscode.getState() || {
      mode: "empty",
      fileLabel: "当前文件",
      uriHash: "",
      selectedProposalId: undefined,
      progress: undefined,
      workspaceChanges: undefined,
      selectedWorkspaceUnitIds: undefined,
      canUndoLastBulkAccept: false,
      proposals: []
    };

    const list = document.getElementById("proposalList");
    const subtitle = document.getElementById("subtitle");
    const REVIEW_ICONS = ${JSON.stringify(commentReviewIcons)};

    document.getElementById("closePanel").addEventListener("click", () => {
      vscode.postMessage({ type: "closePanel" });
    });

    window.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== "state") return;
      state = event.data.state;
      syncWorkspaceUnitSelection();
      vscode.setState(state);
      render();
    });

    function render() {
      const sourceText = reviewSourceText((state.progress && state.progress.source) || state.source);
      subtitle.textContent = state.mode === "generating" && state.progress
        ? state.fileLabel + " · " + sourceText + " · " + state.progress.currentStage
        : state.mode === "reviewChanges" && state.workspaceChanges
        ? "工作区改动 · " + state.workspaceChanges.changedFileCount + " 个文件 · " + state.workspaceChanges.units.length + " 个区域"
        : state.proposals.length
        ? state.fileLabel + " · " + sourceText + " · " + state.proposals.length + " 条候选"
        : state.fileLabel + " · 暂无候选";
      list.textContent = "";
      if (state.mode === "reviewChanges" && state.workspaceChanges) {
        list.appendChild(renderWorkspaceChanges(state.workspaceChanges));
        return;
      }
      if (state.progress) {
        list.appendChild(renderProgress(state.progress, state.mode));
        if (state.mode === "generating") return;
      }
      if (!state.proposals.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "当前文件没有待处理的 AI 注释候选。";
        list.appendChild(empty);
        return;
      }
      list.appendChild(renderReviewToolbar(state.proposals.length));
      for (const proposal of state.proposals) {
        list.appendChild(renderProposal(proposal));
      }
    }

    function reviewSourceText(source) {
      if (source === "currentFunction") return "当前函数";
      if (source === "workspaceChanges") return "工作区改动";
      return "选区";
    }

    function renderReviewToolbar(count) {
      const toolbar = document.createElement("section");
      toolbar.className = "review-toolbar";
      const workspaceReview = isWorkspaceReview();
      const title = document.createElement("div");
      title.className = "review-toolbar-title";
      title.textContent = (workspaceReview ? "工作区改动有 " : "当前文件有 ") + count + " 条待处理候选";
      toolbar.appendChild(title);
      if (!workspaceReview) {
        toolbar.appendChild(actionButton("重新生成", () => {
          vscode.postMessage({ type: "regenerateProposals" });
        }, "", REVIEW_ICONS.retry));
      }
      toolbar.appendChild(actionButton("接受全部", () => {
        vscode.postMessage({ type: "acceptAllProposals" });
      }, "primary"));
      if (workspaceReview) {
        toolbar.appendChild(actionButton("重新扫描改动", () => {
          vscode.postMessage({ type: "analyzeWorkspaceChanges" });
        }, "", REVIEW_ICONS.retry));
      } else {
        toolbar.appendChild(actionButton("分析工作区改动", () => {
          vscode.postMessage({ type: "analyzeWorkspaceChanges" });
        }));
      }
      toolbar.appendChild(actionButton("撤销上次接受全部", () => {
        vscode.postMessage({ type: "undoLastBulkAccept" });
      }, "", undefined, !state.canUndoLastBulkAccept));
      toolbar.appendChild(actionButton("保存全部", () => {
        vscode.postMessage({ type: "saveAllFiles" });
      }));
      return toolbar;
    }

    function isWorkspaceReview() {
      return state.source === "workspaceChanges" || !!state.workspaceChanges || (state.proposals || []).some((proposal) => proposal.source === "workspaceChanges");
    }

    function renderWorkspaceChanges(workspaceChanges) {
      const wrap = document.createElement("section");
      wrap.className = "workspaceChanges";

      const summary = document.createElement("div");
      summary.className = "workspaceSummary";
      const title = document.createElement("div");
      title.className = "workspaceSummaryTitle";
      title.textContent = "已发现 " + workspaceChanges.changedFileCount + " 个改动文件，" + workspaceChanges.units.length + " 个可分析区域";
      summary.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "workspaceUnitMeta";
      meta.textContent = "根目录：" + workspaceChanges.rootLabel + " · diff " + String(workspaceChanges.diffHash || "").slice(0, 12);
      summary.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(actionButton("重新扫描", () => {
        vscode.postMessage({ type: "analyzeWorkspaceChanges" });
      }, "", REVIEW_ICONS.retry));
      actions.appendChild(actionButton("为这些改动生成注释", () => {
        vscode.postMessage({
          type: "generateWorkspaceChanges",
          unitIds: selectedWorkspaceUnitIds(),
        });
      }, "primary", undefined, selectedWorkspaceUnitIds().length === 0));
      summary.appendChild(actions);
      wrap.appendChild(summary);

      const units = document.createElement("ul");
      units.className = "workspaceUnitList";
      for (const unit of workspaceChanges.units || []) {
        units.appendChild(renderWorkspaceUnit(unit));
      }
      wrap.appendChild(units);

      if (workspaceChanges.skipped && workspaceChanges.skipped.length) {
        const skipped = document.createElement("section");
        skipped.className = "workspaceSkipped";
        const skippedTitle = document.createElement("div");
        skippedTitle.className = "workspaceSummaryTitle";
        skippedTitle.textContent = "已跳过 " + workspaceChanges.skipped.length + " 项";
        skipped.appendChild(skippedTitle);
        const skippedList = document.createElement("ul");
        skippedList.className = "workspaceSkippedList";
        for (const item of workspaceChanges.skipped) {
          const row = document.createElement("li");
          row.className = "workspaceSkippedItem";
          row.textContent = item.relativePath + " · " + item.detail;
          skippedList.appendChild(row);
        }
        skipped.appendChild(skippedList);
        wrap.appendChild(skipped);
      }

      return wrap;
    }

    function renderWorkspaceUnit(unit) {
      const item = document.createElement("li");
      item.className = "workspaceUnit";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedWorkspaceUnitIds().includes(unit.id);
      checkbox.addEventListener("change", () => {
        const selected = new Set(selectedWorkspaceUnitIds());
        if (checkbox.checked) selected.add(unit.id);
        else selected.delete(unit.id);
        state.selectedWorkspaceUnitIds = Array.from(selected);
        vscode.setState(state);
        render();
      });
      item.appendChild(checkbox);

      const body = document.createElement("div");
      const title = document.createElement("div");
      title.className = "workspaceUnitTitle";
      title.textContent = unit.fileLabel + " · " + unit.title;
      body.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "workspaceUnitMeta";
      meta.textContent = "第 " + (unit.startLine + 1) + "-" + (unit.endLine + 1) + " 行 · " + unit.unitKind + " · " + changedSpanText(unit.changedLineSpans);
      body.appendChild(meta);
      item.appendChild(body);
      return item;
    }

    function syncWorkspaceUnitSelection() {
      if (!state.workspaceChanges || state.mode !== "reviewChanges") return;
      const ids = (state.workspaceChanges.units || []).map((unit) => unit.id);
      if (!Array.isArray(state.selectedWorkspaceUnitIds)) {
        state.selectedWorkspaceUnitIds = ids;
        return;
      }
      state.selectedWorkspaceUnitIds = state.selectedWorkspaceUnitIds.filter((id) => ids.includes(id));
    }

    function selectedWorkspaceUnitIds() {
      if (!state.workspaceChanges) return [];
      if (!Array.isArray(state.selectedWorkspaceUnitIds)) {
        return (state.workspaceChanges.units || []).map((unit) => unit.id);
      }
      return state.selectedWorkspaceUnitIds;
    }

    function changedSpanText(spans) {
      if (!Array.isArray(spans) || !spans.length) return "无改动行";
      return spans.map((span) => {
        const start = span.startLine + 1;
        const end = span.endLine + 1;
        return start === end ? "第 " + start + " 行" : "第 " + start + "-" + end + " 行";
      }).join("、");
    }

    function renderProgress(progress, mode) {
      const panel = document.createElement("section");
      panel.className = "progress " + mode;

      const head = document.createElement("div");
      head.className = "progress-head";
      const title = document.createElement("div");
      title.className = "progress-title";
      title.textContent = mode === "failed" ? "生成失败" : mode === "empty" ? "未生成候选" : "正在生成 AI 注释";
      const stage = document.createElement("div");
      stage.className = "progress-stage";
      stage.textContent = progress.currentStage || "准备中";
      head.appendChild(title);
      head.appendChild(stage);
      panel.appendChild(head);

      const steps = document.createElement("ul");
      steps.className = "steps";
      for (const step of progress.steps || []) {
        steps.appendChild(renderStep(step, progress.stream, progress.tools));
      }
      panel.appendChild(steps);

      if (progress.tokenUsage) {
        const usage = document.createElement("div");
        usage.className = "token-usage";
        usage.textContent = tokenUsageText(progress.tokenUsage);
        panel.appendChild(usage);
      }

      if (progress.detail || progress.terminalReason) {
        const detail = document.createElement("div");
        detail.className = "progress-detail";
        detail.textContent = progress.detail || ("终态：" + progress.terminalReason);
        panel.appendChild(detail);
      }

      if (mode === "failed" || mode === "empty") {
        const actions = document.createElement("div");
        actions.className = "progress-actions";
        if (progress.source === "workspaceChanges") {
          actions.appendChild(actionButton("重新扫描改动", () => {
            vscode.postMessage({ type: "analyzeWorkspaceChanges" });
          }, "", REVIEW_ICONS.retry));
        } else {
          actions.appendChild(actionButton("重新生成", () => {
            vscode.postMessage({ type: "regenerateProposals" });
          }, "", REVIEW_ICONS.retry));
        }
        panel.appendChild(actions);
      }

      return panel;
    }

    function streamPhaseText(phase) {
      if (phase === "thinking") return "思考中";
      if (phase === "receiving-json") return "接收 JSON";
      if (phase === "normalizing") return "归一化输出";
      if (phase === "done") return "流式输出完成";
      if (phase === "failed") return "流式输出失败";
      return "等待首包";
    }

    function renderStep(step, stream, tools) {
      const item = document.createElement("li");
      item.className = "step " + step.status;
      const icon = document.createElement("span");
      icon.className = "step-icon";
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", stepIconLabel(step.status));
      if (step.status === "running") {
        const spinner = document.createElement("span");
        spinner.className = "step-spinner";
        icon.appendChild(spinner);
      } else {
        icon.textContent = stepIcon(step.status);
      }
      item.appendChild(icon);

      const main = document.createElement("div");
      main.className = "step-main";
      const label = document.createElement("div");
      label.className = "step-label";
      label.textContent = step.label;
      main.appendChild(label);
      if (step.detail) {
        const detail = document.createElement("div");
        detail.className = "step-detail";
        detail.textContent = step.detail;
        main.appendChild(detail);
      }
      if (shouldRenderThinkingLine(step, stream)) {
        main.appendChild(renderInlineThinking(stream, step.status));
      }
      if (shouldRenderToolTrace(step, tools)) {
        main.appendChild(renderToolTrace(tools));
      }
      item.appendChild(main);

      const time = document.createElement("div");
      time.className = "step-time";
      time.textContent = typeof step.elapsedMs === "number" ? formatMs(step.elapsedMs) : "";
      item.appendChild(time);
      return item;
    }

    function shouldRenderThinkingLine(step, stream) {
      return step.id === "model" && !!stream;
    }

    function shouldRenderToolTrace(step, tools) {
      return step.id === "tools" && tools && Array.isArray(tools.entries) && tools.entries.length;
    }

    function renderToolTrace(tools) {
      const wrap = document.createElement("div");
      wrap.className = "toolTrace";
      for (const entry of tools.entries.slice(-6)) {
        const row = document.createElement("div");
        row.className = "toolTraceRow " + (entry.status || "running");
        const name = document.createElement("div");
        name.className = "toolTraceName";
        name.textContent = entry.toolName || "unknown tool";
        row.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "toolTraceMeta";
        meta.textContent = toolEntryText(entry);
        row.appendChild(meta);
        wrap.appendChild(row);
      }
      return wrap;
    }

    function toolEntryText(entry) {
      const parts = [];
      if (entry.status === "done") parts.push("完成");
      else if (entry.status === "blocked") parts.push("已阻止");
      else if (entry.status === "failed") parts.push("失败");
      else parts.push("执行中");
      if (typeof entry.evidenceItemCount === "number") parts.push(entry.evidenceItemCount + " 证据");
      if (typeof entry.elapsedMs === "number") parts.push(formatMs(entry.elapsedMs));
      if (entry.detail) parts.push(entry.detail);
      return parts.join(" · ");
    }

    function renderInlineThinking(stream, stepStatus) {
      const details = document.createElement("details");
      const running = stepStatus === "running" && stream.phase !== "done" && stream.phase !== "failed";
      details.className = "commentThinkingLine" + (running ? " is-running" : "");

      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.className = "thinkingSummaryLabel";
      label.textContent = running ? "模型思考..." : "模型思考";
      summary.appendChild(label);

      const preview = document.createElement("span");
      preview.className = "thinkingPreview";
      preview.textContent = thinkingSummaryText(stream);
      preview.title = preview.textContent;
      summary.appendChild(preview);

      const dots = document.createElement("span");
      dots.className = "dots";
      dots.setAttribute("aria-hidden", "true");
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      summary.appendChild(dots);
      details.appendChild(summary);

      const body = document.createElement("pre");
      body.className = "commentThinkingDetail";
      body.textContent = thinkingDetailText(stream);
      details.appendChild(body);
      return details;
    }

    function thinkingSummaryText(stream) {
      if (stream.reasoningPreview) return stream.reasoningPreview;
      if (stream.phase === "thinking") return "等待模型 thinking 内容...";
      if (stream.phase === "receiving-json") return "已开始接收 JSON 输出";
      if (stream.phase === "normalizing") return "正在归一化模型输出";
      if (stream.phase === "done") return "模型输出已完成";
      if (stream.phase === "failed") return "模型输出失败";
      return "等待模型流式输出";
    }

    function thinkingDetailText(stream) {
      const lines = [];
      lines.push(stream.reasoningPreview || "尚未收到可展示的 thinking 内容。");
      const meta = [];
      meta.push(streamPhaseText(stream.phase));
      if (typeof stream.deltaCount === "number") meta.push(stream.deltaCount + " chunks");
      if (typeof stream.reasoningBytes === "number") meta.push(stream.reasoningBytes + " thinking bytes");
      if (typeof stream.visibleBytes === "number") meta.push(stream.visibleBytes + " JSON bytes");
      if (stream.finishReason && stream.finishReason !== "none") meta.push("finish=" + stream.finishReason);
      if (meta.length) lines.push("", meta.join(" · "));
      return lines.join("\\n");
    }

    function stepIcon(status) {
      if (status === "done") return "✓";
      if (status === "failed") return "!";
      if (status === "skipped") return "-";
      return "○";
    }

    function stepIconLabel(status) {
      if (status === "done") return "已完成";
      if (status === "running") return "进行中";
      if (status === "failed") return "失败";
      if (status === "skipped") return "已跳过";
      return "等待中";
    }

    function formatMs(value) {
      if (value >= 1000) return (value / 1000).toFixed(1) + "s";
      return value + "ms";
    }

    function tokenUsageText(usage) {
      if (!usage.usageAvailable) return "Token 用量：后端未返回 usage。";
      const parts = [];
      if (typeof usage.usagePromptTokens === "number") parts.push("prompt " + usage.usagePromptTokens);
      if (typeof usage.usageCompletionTokens === "number") parts.push("completion " + usage.usageCompletionTokens);
      if (typeof usage.usageReasoningTokens === "number") parts.push("reasoning " + usage.usageReasoningTokens);
      if (typeof usage.usageTextTokens === "number") parts.push("text " + usage.usageTextTokens);
      if (typeof usage.usageTotalTokens === "number") parts.push("total " + usage.usageTotalTokens);
      return "Token 用量：" + (parts.length ? parts.join(" · ") : "已返回 usage，但没有可显示字段。");
    }

    function renderProposal(proposal) {
      const card = document.createElement("article");
      card.className = "proposal" + (proposal.id === state.selectedProposalId ? " selected" : "");
      card.dataset.proposalId = proposal.id;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "第 " + (proposal.line + 1) + " 行 · " + proposal.kind + " · " + proposal.confidence;
      card.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(actionButton("预览完整注释", () => {
        comment.focus();
        card.scrollIntoView({ block: "nearest" });
      }, "primary"));
      actions.appendChild(actionButton("接受", () => postProposalAction("acceptProposal", proposal.id)));
      actions.appendChild(actionButton("拒绝", () => postProposalAction("rejectProposal", proposal.id)));
      actions.appendChild(actionButton("定位", () => postProposalAction("revealProposal", proposal.id)));
      card.appendChild(actions);

      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = proposal.summary;
      card.appendChild(summary);

      const comment = document.createElement("pre");
      comment.className = "comment";
      comment.tabIndex = -1;
      comment.textContent = proposal.commentText;
      card.appendChild(comment);

      card.appendChild(renderCodeEvidence(proposal.codeEvidence || []));

      const reason = document.createElement("div");
      reason.className = "reason";
      const label = document.createElement("strong");
      label.textContent = "综合原因：";
      reason.appendChild(label);
      reason.appendChild(document.createTextNode(proposal.reason || "模型未提供原因。"));
      card.appendChild(reason);

      return card;
    }

    function renderCodeEvidence(codeEvidence) {
      const section = document.createElement("section");
      section.className = "evidence";

      const title = document.createElement("div");
      title.className = "evidence-title";
      title.textContent = "代码证据";
      section.appendChild(title);

      const list = document.createElement("ul");
      list.className = "evidence-list";
      const items = Array.isArray(codeEvidence) ? codeEvidence : [];
      if (!items.length) {
        const item = document.createElement("li");
        item.className = "evidence-item";
        const text = document.createElement("div");
        text.className = "evidence-text";
        text.textContent = "模型未提供可追溯代码证据。";
        item.appendChild(text);
        list.appendChild(item);
      }
      for (const evidence of items) {
        list.appendChild(renderCodeEvidenceItem(evidence));
      }
      section.appendChild(list);
      return section;
    }

    function renderCodeEvidenceItem(evidence) {
      const item = document.createElement("li");
      item.className = "evidence-item";
      const meta = document.createElement("div");
      meta.className = "evidence-meta";
      meta.textContent = evidenceRangeText(evidence) + " · " + (evidence.anchorLabel || "代码片段");
      item.appendChild(meta);
      const text = document.createElement("div");
      text.className = "evidence-text";
      const summary = evidence.codeSummary || "未提供代码说明";
      const meaning = evidence.meaning || "未提供语义解释";
      text.textContent = summary + " -> " + meaning;
      item.appendChild(text);
      return item;
    }

    function evidenceRangeText(evidence) {
      const start = typeof evidence.startLine === "number" ? evidence.startLine + 1 : "?";
      const end = typeof evidence.endLine === "number" ? evidence.endLine + 1 : start;
      const range = start === end ? "第 " + start + " 行" : "第 " + start + "-" + end + " 行";
      if (evidence.source === "repository" && evidence.filePath) return evidence.filePath + ":" + range;
      return range;
    }

    function actionButton(label, onClick, className, iconMarkup, disabled) {
      const button = document.createElement("button");
      button.type = "button";
      if (className) button.className = className;
      button.disabled = !!disabled;
      if (iconMarkup) {
        const icon = document.createElement("span");
        icon.className = "actionButtonIcon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = iconMarkup;
        button.appendChild(icon);
      }
      const text = document.createElement("span");
      text.className = "actionButtonLabel";
      text.textContent = label;
      button.appendChild(text);
      if (!disabled) button.addEventListener("click", onClick);
      return button;
    }

    function postProposalAction(type, proposalId) {
      vscode.postMessage({ type, proposalId });
    }

    render();
  </script>
</body>
</html>`
}

export function createNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let value = ""
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return value
}
