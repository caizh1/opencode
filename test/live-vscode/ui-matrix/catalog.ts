import type { AutomationKind, RunMode, Severity } from "../cases/catalog"

export type UiSurface =
  | "vscode-shell"
  | "activity-bar"
  | "sidebar"
  | "chat"
  | "composer"
  | "session-history"
  | "context"
  | "mention"
  | "provider-settings"
  | "rag-settings"
  | "codegraph-status"
  | "document-rag"
  | "comments-review"
  | "agent-terminal"
  | "tools-skills"
  | "diagram"
  | "visual-accessibility"
  | "lifecycle"

export type UiOracleKind =
  | "visibility"
  | "interaction"
  | "state"
  | "error"
  | "layout"
  | "accessibility"
  | "visual"
  | "storage"
  | "log"

export type UiCase = {
  id: string
  surface: UiSurface
  feature: string
  title: string
  severity: Severity
  automation: AutomationKind
  modes: RunMode[]
  entrypoints: string[]
  userScenario: string
  userSteps: string[]
  expected: string[]
  boundaries: string[]
  oracles: UiOracleKind[]
  evidence: string[]
  allowedFailures: string[]
  tags: string[]
}

type Scenario = {
  feature: string
  actions: string[]
  boundaries: string[]
  expected?: string[]
  oracles?: UiOracleKind[]
  severity?: Severity
  automation?: AutomationKind
  entrypoints?: string[]
  tags?: string[]
}

const uiEvidence = ["screenshots/", "ui-matrix.json", "functional-checks.json", "logs/"]
const visualEvidence = ["screenshots/", "ui-visual-contract.json", "ui-matrix.json"]

export const uiCases: UiCase[] = [
  ...surface("vscode-shell", [
    s("first-run-empty-window", ["Launch VS Code with an empty window", "Open ChipMate from the Activity Bar", "Open command palette entries"], ["no workspace", "empty profile", "missing provider"], ["ChipMate entrypoints are visible", "No crash toast appears", "The panel explains missing workspace/provider without blocking navigation"], ["visibility", "error", "log"], "P0", "automated", ["command:chipmate.openChat", "command:workbench.view.extension.chipmate"], ["startup"]),
    s("single-file-window", ["Open a single source file outside a workspace", "Open ChipMate", "Ask for current-file context"], ["no workspace folder", "file outside workspace", "read-only file"], ["Unsupported or limited workspace state is explicit", "Context controls remain usable"], ["visibility", "state", "error"], "P1", "planned", ["command:chipmate.askCurrentFile"], ["workspace"]),
    s("multi-root-workspace", ["Open a multi-root fixture", "Switch roots in Explorer", "Open ChipMate status surfaces"], ["two roots", "same filename in both roots", "one root without git"], ["Root labels disambiguate context, CodeGraph, and RAG state"], ["state", "layout", "storage"], "P1", "planned", ["mode:multi-root"], ["workspace"]),
    s("window-reload", ["Open ChipMate", "Reload VS Code window", "Reopen Chat, Output, and status surfaces"], ["busy indexing", "paused indexing", "provider error before reload"], ["UI recovers without duplicate panels or stale loading indicators"], ["state", "log", "storage"], "P1", "planned", ["command:workbench.action.reloadWindow"], ["lifecycle"]),
    s("theme-switch", ["Open ChipMate", "Switch dark theme", "Switch light theme", "Switch high contrast theme"], ["dark", "light", "high contrast", "system accent colors"], ["Text, icons, focus rings, status colors, and disabled states remain legible"], ["visual", "accessibility", "layout"], "P2", "planned", ["setting:workbench.colorTheme"], ["visual"]),
    s("narrow-window-shell", ["Resize VS Code to narrow sidebar widths", "Open each ChipMate view", "Capture screenshots"], ["260px", "320px", "480px", "long path labels"], ["No toolbar, status pill, icon button, or label overlaps"], ["layout", "visual"], "P2", "planned", ["webview:layout"], ["visual"]),
  ]),
  ...surface("activity-bar", [
    s("container-visible", ["Inspect Activity Bar", "Open ChipMate container", "Collapse and expand Side Bar"], ["icon hidden by overflow", "small window", "Zen mode"], ["ChipMate container is discoverable and restores focus"], ["visibility", "interaction"], "P1", "automated", ["command:workbench.view.extension.chipmate"], ["shell"]),
    s("sidebar-view-empty", ["Open ChipMate sidebar before any session", "Inspect empty state", "Open settings and output from visible controls"], ["fresh profile", "no sessions", "provider missing"], ["Empty state is useful, not blank; visible actions are enabled or clearly disabled"], ["visibility", "state", "error"], "P1", "planned", ["view:chipmate.sidebar"], ["shell"]),
    s("sidebar-focus-keyboard", ["Use keyboard to focus ChipMate container", "Tab through controls", "Activate primary action"], ["keyboard only", "screen reader mode"], ["Focus order is predictable and never traps keyboard"], ["accessibility", "interaction"], "P2", "planned", ["view:chipmate.sidebar"], ["a11y"]),
  ]),
  ...surface("chat", [
    s("open-chat-command", ["Run Open ChipMate Chat", "Wait for webview", "Capture initial DOM/screenshot"], ["provider configured", "provider missing", "slow activation"], ["Chat surface opens, status pills render, and no blank webview remains"], ["visibility", "state", "log"], "P0", "automated", ["command:chipmate.openChat"], ["chat"]),
    s("empty-input-send", ["Focus composer", "Leave input empty", "Click Send and press Enter"], ["empty string", "whitespace", "IME composing"], ["Send is disabled or shows an inline empty-input state without posting"], ["interaction", "state", "accessibility"], "P2", "planned", ["webview:chat-input"], ["composer"]),
    s("short-message-send", ["Type a short question", "Click Send", "Observe streaming or failure state"], ["provider configured", "provider missing", "HTML provider response"], ["Message appears once; stream finishes or provider error is clear and redacted"], ["interaction", "state", "error", "log"], "P1", "planned", ["webview:chat-input"], ["chat"]),
    s("multi-line-message", ["Type multi-line prompt", "Use Shift+Enter", "Submit"], ["long lines", "code fence", "Chinese text"], ["Composer grows within bounds and message content is preserved"], ["interaction", "layout"], "P2", "planned", ["webview:chat-input"], ["composer"]),
    s("long-context-warning", ["Paste oversized prompt", "Attach large context", "Send"], ["very long prompt", "many files", "token budget near limit"], ["Budget/packing result is visible and does not crash the webview"], ["state", "error", "log"], "P1", "planned", ["webview:chat-input"], ["context"]),
    s("stream-cancel", ["Send slow request", "Click Stop", "Retry"], ["slow provider", "double click stop", "abort failure"], ["Stop returns composer to usable state and retry does not duplicate partial messages"], ["interaction", "state", "error"], "P1", "planned", ["webview:cancelSend"], ["chat"]),
    s("provider-error-card", ["Configure bad provider", "Send message", "Open Output"], ["401", "403", "429", "503", "timeout", "HTML body"], ["Error card classifies provider/transport status and logs are redacted"], ["error", "log", "visual"], "P1", "planned", ["webview:chat-input", "setting:chipmate.provider.apiBaseUrl"], ["provider"]),
    s("tool-progress-parts", ["Ask for a tool-backed answer", "Observe progress parts", "Collapse/expand tool details"], ["many tool events", "stderr", "blocked tool"], ["Progress is incremental, compact, and does not scroll-jump unexpectedly"], ["state", "layout", "interaction"], "P2", "planned", ["tool:exec_command"], ["tools"]),
    s("copy-actions", ["Hover a message", "Click copy code and copy message", "Observe feedback"], ["clipboard denied", "large code block", "icon-only button"], ["Copy feedback is temporary, accessible, and layout-stable"], ["interaction", "accessibility", "layout"], "P3", "planned", ["webview:copy"], ["a11y"]),
  ]),
  ...surface("composer", [
    s("send-button-states", ["Inspect composer with empty input", "Type text", "Send", "Observe loading and disabled states"], ["empty", "ready", "sending", "queued"], ["Send icon has stable size, correct label, and state-specific feedback"], ["state", "accessibility", "layout"], "P1", "planned", ["webview:send"], ["composer", "icon"]),
    s("model-selector", ["Open model selector", "Refresh models", "Pick default/manual model"], ["no runtime", "manual value", "refresh failure"], ["Model menu preserves selection and errors are localized"], ["interaction", "state", "error"], "P2", "planned", ["webview:model-selector"], ["settings"]),
    s("agent-selector", ["Open agent selector", "Switch direct/local agent modes", "Inspect disabled options"], ["local-only", "no agent", "agent unavailable"], ["Required agent is explained and disabled states are accessible"], ["interaction", "state", "accessibility"], "P2", "planned", ["webview:agent-selector"], ["agent"]),
    s("more-menu", ["Open composer more menu", "Toggle tools, permissions, settings entries"], ["small width", "long labels", "disabled tools"], ["Menu aligns in viewport and actions do not overlap composer"], ["interaction", "layout", "accessibility"], "P2", "planned", ["webview:composer-more"], ["settings"]),
    s("queued-send", ["Submit while blocked by approval/clarification", "Edit queued message", "Delete queued message"], ["pending confirmation", "two queued messages", "reload"], ["Queued list is explicit and edit/delete controls are labeled"], ["state", "interaction", "accessibility"], "P2", "planned", ["webview:queued-send"], ["chat"]),
    s("ime-composition", ["Use Chinese IME in composer", "Press Enter during composition", "Submit after composition"], ["IME active", "Shift+Enter", "selection replacement"], ["Composition is not prematurely submitted"], ["interaction"], "P1", "planned", ["webview:chat-input"], ["composer", "i18n"]),
  ]),
  ...surface("session-history", [
    s("new-session", ["Click new session", "Send message", "Switch back"], ["no provider", "runtime unavailable", "empty history"], ["New session creates visible, unique history entry or clear error"], ["interaction", "state"], "P1", "automated", ["command:chipmate.newSession"], ["session"]),
    s("history-list", ["Open history", "Select a prior session", "Search/filter if available"], ["many sessions", "deleted session", "long title"], ["Active row is clear and labels truncate without overlap"], ["visibility", "layout", "state"], "P2", "planned", ["webview:session-history"], ["session"]),
    s("session-delete", ["Select sessions", "Delete one", "Delete multiple", "Cancel confirmation"], ["active session", "remote delete failure", "undo not available"], ["Deletion is confirmed, failures are surfaced, and selection remains sane"], ["interaction", "error", "state"], "P1", "planned", ["webview:session-delete"], ["session"]),
    s("session-recovery", ["Reload after selected session", "Open stale session id", "Recover messages"], ["missing session", "corrupt JSONL", "network failure"], ["Fallback creates/chooses a valid session and logs recovery"], ["state", "error", "log"], "P1", "planned", ["webview:session-load"], ["lifecycle"]),
  ]),
  ...surface("context", [
    s("add-current-file", ["Open source file", "Run Add File to Context", "Inspect context chip"], ["path with spaces", "Chinese path", "outside workspace"], ["Chip shows file label, path tooltip, and removable state"], ["interaction", "state", "layout"], "P1", "automated", ["command:chipmate.addFileToContext"], ["context"]),
    s("add-selection", ["Select source text", "Run Add Selection to Context", "Inspect preview"], ["empty selection", "single line", "large selection"], ["Selection chip displays source range and bounded preview"], ["interaction", "state", "layout"], "P1", "automated", ["command:chipmate.addSelectionToContext"], ["context"]),
    s("clear-context", ["Attach multiple items", "Click clear", "Send message"], ["already empty", "pinned item", "queued send"], ["Clear state is visible and later prompt does not include stale context"], ["state", "interaction"], "P1", "automated", ["command:chipmate.clearContext"], ["context"]),
    s("context-chip-actions", ["Select context chip", "Pin/unpin", "Remove", "Open source"], ["deleted file", "moved file", "duplicate labels"], ["Actions are icon-labeled and stale items report cleanly"], ["interaction", "accessibility", "error"], "P2", "planned", ["webview:context-chip"], ["context", "icon"]),
    s("workspace-file-picker", ["Open file picker", "Pick files/directories", "Cancel picker"], ["hidden files", "binary files", "many files"], ["Picked files appear as chips; cancel leaves state unchanged"], ["interaction", "state"], "P2", "planned", ["webview:pick-workspace-files"], ["context"]),
  ]),
  ...surface("mention", [
    s("mention-open", ["Type @ in composer", "Search file names", "Select result"], ["no match", "many matches", "deep path"], ["Suggestion list opens near cursor and selected mention becomes context"], ["interaction", "layout", "state"], "P1", "planned", ["webview:mention"], ["mention"]),
    s("mention-symbol", ["Type symbol prefix", "Wait for results", "Pick symbol"], ["duplicate symbols", "unsupported language", "case differences"], ["Symbol results distinguish file/range and failures do not block typing"], ["interaction", "state", "error"], "P2", "planned", ["webview:mention-symbol"], ["mention", "codegraph"]),
    s("mention-boundaries", ["Mention hidden/binary/outside-workspace candidates", "Try deleted item", "Retry"], ["hidden file", "binary", "no permission", "deleted after search"], ["Unsupported items are skipped or error-labeled without broken chips"], ["error", "state"], "P2", "planned", ["webview:mention"], ["mention"]),
  ]),
  ...surface("provider-settings", [
    s("settings-open", ["Open provider settings panel", "Inspect fields", "Close and reopen"], ["configured", "clean profile", "SecretStorage only"], ["Fields reflect non-secret values and raw keys are never displayed"], ["visibility", "state", "accessibility"], "P0", "planned", ["webview:provider-settings"], ["provider", "security"]),
    s("save-provider", ["Edit base URL/model", "Save", "Send short chat"], ["bad URL", "trailing slash", "empty model"], ["Validation is immediate and saved state hot-refreshes"], ["interaction", "state", "error"], "P1", "planned", ["webview:connectWithSettings"], ["provider"]),
    s("test-provider", ["Click Test", "Observe success/failure", "Open logs"], ["401", "403", "429", "503", "timeout", "HTML response"], ["Test result classifies provider errors and redacts headers/body"], ["interaction", "error", "log"], "P1", "planned", ["webview:testWithSettings"], ["provider", "security"]),
    s("completion-boundary", ["Inspect completion settings", "Disable completion", "Run chat/RAG flows"], ["completion enabled in real profile", "inherit chat provider", "custom completion provider"], ["Completion configuration is observed but quality is outside oracle"], ["state", "log"], "P2", "planned", ["setting-prefix:chipmate.completion."], ["completion-boundary"]),
  ]),
  ...surface("rag-settings", [
    s("rag-panel-states", ["Open RAG settings/status", "Inspect ready/checking/indexing/partial/paused/stale/error states"], ["not indexed", "ready", "provider-error", "stale identity"], ["Status labels match actual stored state and do not show stale provider errors when ready"], ["state", "storage", "log"], "P1", "planned", ["webview:rag-settings"], ["rag"]),
    s("rag-test-connectivity", ["Click Test", "Observe status", "Compare CodeGraph/RAG state before and after"], ["provider OK", "provider error", "offline"], ["Test only probes API connectivity and never starts indexing or deletes vectors"], ["interaction", "state", "storage"], "P1", "planned", ["webview:testRagSettings"], ["rag"]),
    s("rag-resume", ["Pause or create partial RAG", "Click Resume", "Observe progress"], ["partial index", "provider-error", "manual pause", "ready index"], ["Resume actually recovers/refreshes indexing state"], ["interaction", "state", "storage", "log"], "P1", "planned", ["webview:resumeRagIndexing"], ["rag"]),
    s("rag-save-identity", ["Change embedding endpoint/model", "Save", "Inspect confirmation"], ["old ready index", "partial index", "cross-version partial"], ["UI distinguishes save-only from rebuild-from-zero and does not silently reuse mismatched vectors"], ["interaction", "state", "storage"], "P0", "planned", ["webview:saveRagSettings"], ["rag", "security"]),
    s("rag-save-scheduler", ["Change batch/concurrency", "Save", "Resume partial"], ["rate limit", "timeout", "checkpoint interval"], ["Partial progress is kept or explicitly marked unusable with reason"], ["interaction", "state", "storage"], "P1", "planned", ["webview:saveRagSettings"], ["rag"]),
    s("rag-save-query-only", ["Change rerank/topK settings", "Save", "Query code"], ["rerank disabled", "rerank bad URL", "vectorTopK boundaries"], ["Index is not force rebuilt for query-only changes"], ["state", "storage", "log"], "P1", "planned", ["webview:saveRagSettings"], ["rag"]),
    s("rag-force-rebuild", ["Click Force rebuild", "Cancel then confirm", "Observe storage"], ["busy indexing", "partial index", "provider unavailable"], ["Destructive rebuild has explicit confirmation and storage evidence"], ["interaction", "storage", "log"], "P0", "planned", ["webview:rebuildCodeGraph"], ["rag"]),
  ]),
  ...surface("codegraph-status", [
    s("status-open", ["Open CodeGraph status UI", "Run status command", "Capture storage summary"], ["no index", "ready", "error", "saving shard"], ["Status differentiates scan/index/save/ready/error and exposes Code RAG sub-state"], ["state", "storage", "log"], "P1", "automated", ["command:chipmate.codeGraph.status"], ["codegraph"]),
    s("index-controls", ["Click index/rebuild/pause/resume/cancel controls", "Observe disabled/loading states"], ["already ready", "already paused", "cancel while saving"], ["Controls prevent conflicting actions and recover cleanly"], ["interaction", "state", "log"], "P1", "planned", ["webview:codegraph-controls"], ["codegraph"]),
    s("build-churn-state", ["Start indexing", "Generate build churn", "Observe CodeGraph and RAG status"], ["ignored paths", "gitignored files", "checkpoint skipped"], ["UI does not mislabel repeated invalidation as endpoint failure"], ["state", "storage", "log"], "P1", "planned", ["fixture:build-churn"], ["codegraph", "rag"]),
    s("corrupt-storage-state", ["Seed corrupt manifest", "Launch ChipMate", "Open status"], ["bad JSON", "old version", "missing shard"], ["UI shows rebuild-required, not a crash or endless spinner"], ["error", "storage", "log"], "P0", "planned", ["fixture:corrupt-storage"], ["codegraph"]),
    s("evidence-jump", ["Open Code Intelligence evidence", "Click jump buttons", "Return to chat"], ["deleted source", "line out of range", "multi-root"], ["Jump buttons are labeled and failures are shown without losing status view"], ["interaction", "accessibility", "error"], "P2", "planned", ["webview:openEvidence"], ["codegraph"]),
  ]),
  ...surface("document-rag", [
    s("document-status", ["Open Document RAG status", "Run status command", "Inspect badges"], ["disabled", "ready", "scanning", "indexing", "partial", "failed"], ["Document RAG status is separate from Code RAG and uses visible glyphs"], ["state", "visual", "storage"], "P2", "automated", ["command:chipmate.documentRag.status"], ["document-rag"]),
    s("document-rebuild", ["Rebuild Document RAG", "Observe file parsing list", "Open logs"], ["MD", "TXT", "DOCX", "empty", "corrupt", "large"], ["Per-file skip/failure summary is bounded and field-level"], ["state", "error", "log"], "P1", "planned", ["command:chipmate.documentRag.rebuild"], ["document-rag", "documents"]),
    s("document-pause-resume", ["Pause Document RAG", "Resume", "Reload window"], ["already paused", "worker missing", "file locked"], ["Paused/resumed state survives normal lifecycle boundaries"], ["interaction", "state", "storage"], "P2", "planned", ["command:chipmate.documentRag.pause", "command:chipmate.documentRag.resume"], ["document-rag"]),
    s("word-render-flow", ["Ask for Word document", "Render preview/PDF/pages", "Inspect final answer"], ["render unavailable", "LibreOffice missing", "large table"], ["Warnings appear before final answer and successful render clears stale failure warnings"], ["visual", "error", "log"], "P1", "planned", ["tool:render_word_document"], ["documents"]),
  ]),
  ...surface("comments-review", [
    s("generate-selection-progress", ["Select code", "Generate comments", "Watch progress panel"], ["unsupported language", "empty selection", "provider error"], ["Progress phases and errors are visible without hiding existing code"], ["state", "error", "layout"], "P1", "planned", ["command:chipmate.comments.generateForSelection"], ["comments"]),
    s("generate-current-function", ["Place cursor in function", "Generate comments", "Review proposals"], ["nested function-like code", "no function", "large function"], ["Proposal anchors and summaries match visible source region"], ["state", "interaction"], "P1", "planned", ["command:chipmate.comments.generateForCurrentFunction"], ["comments"]),
    s("workspace-changes-picker", ["Open SCM fixture", "Analyze workspace changes", "Select/deselect units"], ["no changes", "many hunks", "binary diff"], ["Unit checkboxes are visible, selectable, and disabled generate state is correct"], ["interaction", "state", "layout"], "P1", "planned", ["command:chipmate.comments.generateForWorkspaceChanges"], ["comments"]),
    s("proposal-actions", ["Preview full comment", "Accept", "Reject", "Reveal", "Accept all", "Clear"], ["no proposals", "stale proposal", "file changed"], ["Each action updates proposal state and file/log evidence"], ["interaction", "state", "log"], "P1", "planned", ["command:chipmate.comments.accept", "command:chipmate.comments.reject"], ["comments"]),
    s("review-ui-a11y", ["Tab through review panel", "Inspect buttons/icons", "Resize narrow"], ["Chinese labels", "long file paths", "disabled buttons"], ["Buttons have labels and no icon/text overlap"], ["accessibility", "layout", "visual"], "P2", "planned", ["webview:comments-review"], ["comments", "icon"]),
  ]),
  ...surface("agent-terminal", [
    s("open-terminal", ["Open ChipMate Agent Terminal", "Focus existing terminal", "Reload window"], ["no workspace", "restricted shell", "existing terminal"], ["Terminal opens or focuses with diagnostic log line"], ["interaction", "log"], "P1", "automated", ["command:chipmate.agentTerminal.open"], ["terminal"]),
    s("readonly-command", ["Run safe command through agent/tool flow", "Observe stdout"], ["cwd with spaces", "large stdout", "non-zero exit"], ["Output is bounded and non-zero status is explicit"], ["state", "error", "log"], "P1", "planned", ["tool:exec_command"], ["tools"]),
    s("permission-denied", ["Set restrictive permission mode", "Attempt command/write tool", "Approve/deny"], ["denied command", "timeout", "disabled tools"], ["Permission prompt explains risk and denial recovery path"], ["interaction", "error", "accessibility"], "P0", "planned", ["setting:chipmate.permissions.mode"], ["security", "tools"]),
  ]),
  ...surface("tools-skills", [
    s("skills-list", ["Open skills settings", "Expand/collapse skill details", "Toggle skill"], ["invalid skill", "missing dependency", "many skills"], ["Details are diagnosable and collapsed state is stable"], ["interaction", "layout", "error"], "P2", "planned", ["webview:skills-settings"], ["skills"]),
    s("tools-toggle", ["Toggle tools enabled", "Send tool-backed prompt", "Observe blocked state"], ["tools disabled", "MCP disabled", "missing tool"], ["Disabled tools fail clearly without generic agent crash"], ["state", "error"], "P1", "planned", ["setting:chipmate.tools.enabled"], ["tools"]),
    s("mcp-settings", ["Enable MCP setting", "Use unavailable MCP server", "Disable MCP"], ["bad server", "disabled mcp", "timeout"], ["MCP errors stay isolated from core chat"], ["error", "log"], "P2", "planned", ["setting-prefix:chipmate.mcp."], ["mcp"]),
  ]),
  ...surface("diagram", [
    s("mermaid-preview", ["Ask for Mermaid diagram", "Wait for preview", "Zoom/copy/export"], ["invalid syntax", "large graph", "dense labels"], ["Preview or render-specific fallback appears; answer text remains"], ["visual", "interaction", "error"], "P2", "planned", ["feature:mermaid"], ["diagram"]),
    s("drawio-preview", ["Ask for draw.io diagram", "Wait for image", "Export PNG"], ["invalid style", "layout failure", "renderer missing"], ["draw.io failures are explicit and screenshots/artifacts are captured"], ["visual", "error", "log"], "P2", "planned", ["feature:drawio"], ["diagram"]),
    s("diagram-accessibility", ["Inspect diagram toolbar icon buttons", "Keyboard focus zoom/export/source controls"], ["icon-only", "disabled export", "narrow width"], ["Icon buttons have aria labels and stay in normal flow"], ["accessibility", "layout"], "P2", "planned", ["webview:diagram-toolbar"], ["diagram", "icon"]),
  ]),
  ...surface("visual-accessibility", [
    s("liquid-glass-contract", ["Scan webview CSS/classes", "Capture dark/light screenshots", "Inspect icon assets"], ["generic flat card", "cheap gradient", "missing high/low states"], ["Primary surfaces use Liquid Glass tokens/classes and not placeholder icon styling"], ["visual", "layout"], "P2", "automated", ["source:src/chat-html.ts", "source:src/webview/liquid-icons.ts"], ["visual", "liquid-glass"]),
    s("no-absolute-icon-layout", ["Scan icon/button selectors", "Inspect screenshots at narrow widths"], ["absolute-positioned icon", "toolbar overflow", "text overlap"], ["Icon controls use flex/grid/inline-flex normal flow layout"], ["layout", "visual"], "P1", "automated", ["source:src/chat-html.ts", "source:src/comments/commentReviewHtml.ts"], ["visual", "icon"]),
    s("icon-button-labels", ["Scan generated HTML patterns", "Tab through icon buttons", "Read tooltip/aria state"], ["copy/export/close/pin", "loading", "disabled"], ["Icon-only controls expose aria-label/title and state feedback"], ["accessibility", "interaction"], "P1", "automated", ["source:src/chat-html.ts"], ["a11y", "icon"]),
    s("text-overlap-gate", ["Capture screenshots at 260/320/480/900 widths", "Run visual overlap heuristics"], ["Chinese paths", "long model names", "large status text"], ["No visible controls overlap or clip important labels"], ["layout", "visual"], "P1", "planned", ["screenshots:responsive"], ["visual"]),
  ]),
  ...surface("lifecycle", [
    s("clean-profile-first-use", ["Launch clean profile", "Open Chat, Settings, CodeGraph, Document RAG"], ["no settings", "no SecretStorage", "no globalStorage"], ["First-use UI is usable and all missing config states are explicit"], ["visibility", "state", "error", "storage"], "P0", "planned", ["mode:fixture-clean-room"], ["lifecycle"]),
    s("upgrade-existing-profile", ["Clone real profile", "Launch extension", "Open all major panels"], ["old globalStorage", "old sessions", "old manifest"], ["Upgrade/reload state does not strand UI or delete storage silently"], ["state", "storage", "log"], "P0", "planned", ["mode:cloned-profile-full"], ["lifecycle"]),
    s("offline-weak-network", ["Block or mock network failures", "Run provider/RAG/document flows"], ["DNS failure", "proxy failure", "slow service", "request interrupted"], ["Each offline state maps to provider/runtime-specific error and UI remains navigable"], ["error", "state", "log"], "P1", "planned", ["network:offline"], ["offline"]),
  ]),
  ...generatedBoundaryCases(),
]

function surface(surfaceName: UiSurface, scenarios: Scenario[]): UiCase[] {
  return scenarios.map((scenario) => buildCase(surfaceName, scenario))
}

function s(
  feature: string,
  actions: string[],
  boundaries: string[],
  expected: string[] = ["The user-visible state matches the action and remains recoverable."],
  oracles: UiOracleKind[] = ["visibility", "interaction", "state"],
  severity: Severity = "P2",
  automation: AutomationKind = "planned",
  entrypoints: string[] = [],
  tags: string[] = [],
): Scenario {
  return { feature, actions, boundaries, expected, oracles, severity, automation, entrypoints, tags }
}

function buildCase(surfaceName: UiSurface, scenario: Scenario): UiCase {
  return {
    id: `ui.${surfaceName}.${scenario.feature}`,
    surface: surfaceName,
    feature: scenario.feature,
    title: titleFromFeature(scenario.feature),
    severity: scenario.severity ?? "P2",
    automation: scenario.automation ?? "planned",
    modes: ["cloned-profile-full"],
    entrypoints: scenario.entrypoints ?? [`webview:${surfaceName}`],
    userScenario: `${surfaceName}: ${titleFromFeature(scenario.feature)}`,
    userSteps: scenario.actions,
    expected: scenario.expected ?? ["The user-visible state matches the action and remains recoverable."],
    boundaries: scenario.boundaries,
    oracles: scenario.oracles ?? ["visibility", "interaction", "state"],
    evidence: scenario.oracles?.some((oracle) => oracle === "visual" || oracle === "layout") ? visualEvidence : uiEvidence,
    allowedFailures: allowedFailuresFor(scenario.oracles ?? ["visibility", "interaction", "state"]),
    tags: scenario.tags ?? [],
  }
}

function generatedBoundaryCases(): UiCase[] {
  const statusStates = ["not-indexed", "checking", "indexing", "saving", "ready", "partial", "paused", "stale", "provider-error", "storage-error", "cancelled"]
  const providerFailures = ["missing-key", "bad-url", "wrong-model", "401", "403", "429", "503", "timeout", "html-response", "stream-interrupted", "non-sse"]
  const documentInputs = ["empty-md", "large-md", "txt", "doc", "docx", "corrupt-docx", "locked-file", "chinese-name", "path-conflict", "binary-file"]
  const commentModes = ["selection", "current-function", "workspace-changes", "no-scm-changes", "unsupported-language", "proposal-parse-failure", "provider-failure"]
  const visualWidths = ["260px", "320px", "480px", "720px", "900px", "wide-desktop"]
  const fixturePaths = ["space-path", "chinese-path", "deep-directory", "hidden-file", "outside-workspace", "no-permission", "deleted-after-add"]

  return [
    ...statusStates.map((state) => buildCase("codegraph-status", s(
      `state-${state}`,
      ["Seed or mock CodeGraph/Code RAG state", `Open status UI for ${state}`, "Capture screenshot and storage summary"],
      [state, "reload", "status refresh"],
      [`The status view labels ${state} without stale or contradictory CodeGraph/RAG wording.`],
      ["state", "storage", "log"],
      ["provider-error", "storage-error"].includes(state) ? "P1" : "P2",
      "planned",
      ["webview:codegraph-status"],
      ["codegraph", "rag", "state"],
    ))),
    ...providerFailures.map((failure) => buildCase("provider-settings", s(
      `failure-${failure}`,
      ["Configure provider mock", `Trigger ${failure}`, "Inspect toast, inline error, Output, and final chat state"],
      [failure, "retry", "redaction"],
      [`${failure} is classified at the provider/transport layer and never leaks secrets.`],
      ["error", "log", "state"],
      ["missing-key", "401", "403"].includes(failure) ? "P0" : "P1",
      "planned",
      ["webview:testWithSettings", "webview:chat-input"],
      ["provider", "security"],
    ))),
    ...documentInputs.map((kind) => buildCase("document-rag", s(
      `input-${kind}`,
      ["Open document fixture", `Index or read ${kind}`, "Inspect per-file summary and chat evidence"],
      [kind, "parser limits", "render gate"],
      [`${kind} produces a bounded success, skip, or field-level failure summary.`],
      ["state", "error", "log"],
      ["corrupt-docx", "locked-file"].includes(kind) ? "P1" : "P2",
      "planned",
      ["command:chipmate.documentRag.rebuild", "tool:read_docx"],
      ["document-rag", "documents"],
    ))),
    ...commentModes.map((mode) => buildCase("comments-review", s(
      `mode-${mode}`,
      ["Open fixture source/SCM state", `Generate comments for ${mode}`, "Exercise review actions"],
      [mode, "provider unavailable", "stale source"],
      [`${mode} comment generation has visible progress, bounded error handling, and review controls.`],
      ["interaction", "state", "error"],
      ["proposal-parse-failure", "provider-failure"].includes(mode) ? "P1" : "P2",
      "planned",
      [`command:chipmate.comments.generateFor${mode === "current-function" ? "CurrentFunction" : mode === "workspace-changes" ? "WorkspaceChanges" : "Selection"}`],
      ["comments"],
    ))),
    ...visualWidths.map((width) => buildCase("visual-accessibility", s(
      `responsive-${width}`,
      ["Resize VS Code/webview", `Set width to ${width}`, "Open chat, settings, context chips, comments, diagrams"],
      [width, "long labels", "Chinese strings", "disabled/loading states"],
      [`At ${width}, icons remain in normal flow and text does not overlap important controls.`],
      ["layout", "visual", "accessibility"],
      width === "260px" || width === "320px" ? "P1" : "P2",
      "planned",
      ["screenshots:responsive"],
      ["visual", "icon", "liquid-glass"],
    ))),
    ...fixturePaths.map((pathKind) => buildCase("context", s(
      `path-${pathKind}`,
      ["Open path-boundary fixture", `Attach ${pathKind}`, "Mention it, remove it, reload window"],
      [pathKind, "context chip", "mention result", "send prompt"],
      [`${pathKind} is shown, skipped, or failed with a user-understandable reason.`],
      ["interaction", "state", "error", "layout"],
      ["no-permission", "outside-workspace"].includes(pathKind) ? "P1" : "P2",
      "planned",
      ["command:chipmate.addFileToContext", "webview:mention"],
      ["context", "mention"],
    ))),
    ...generatedDetailedInteractionCases(),
  ]
}

function generatedDetailedInteractionCases(): UiCase[] {
  const chatInputs = [
    "empty", "whitespace", "short-zh", "short-en", "multi-line", "markdown-table", "code-fence-c", "code-fence-ts",
    "very-long-line", "oversized-paste", "emoji-and-cjk", "shell-command-text", "json-payload", "prompt-with-at",
    "prompt-with-slash", "prompt-with-url", "prompt-with-secret-like-text", "ime-enter", "shift-enter", "paste-while-streaming",
  ]
  const sessionActions = [
    "create", "rename-by-first-message", "switch-active", "switch-while-streaming", "delete-active", "delete-inactive",
    "multi-select-delete", "recover-missing", "recover-corrupt-jsonl", "history-scroll", "history-filter", "title-overflow",
    "remote-session-load-failure", "reload-selected-session", "new-session-provider-missing",
  ]
  const providerFields = [
    "api-base-url", "chat-model", "api-key-secret", "context-length", "max-tokens", "temperature", "top-p", "timeout",
    "retry-count", "streaming", "custom-headers", "allowed-host", "save-only", "test-only", "connect-and-save",
  ]
  const ragFields = [
    "embedding-endpoint", "embedding-model", "embedding-batch-size", "embedding-concurrency", "embedding-timeout",
    "checkpoint-interval", "checkpoint-chunk-interval", "resume-automatically", "request-budget", "allowed-hosts",
    "vector-top-k", "graph-top-k", "rerank-enabled", "rerank-endpoint", "rerank-model", "rerank-top-k",
    "query-timeout", "index-tests", "exclude-globs", "min-chunk-bytes", "max-chunk-bytes",
  ]
  const codeGraphMutations = [
    "add-file", "edit-file", "delete-file", "rename-file", "move-directory", "gitignored-add", "hidden-file-add",
    "test-directory-toggle", "exclude-glob-change", "large-file-skip", "binary-file-skip", "no-git-workspace",
    "multi-root-one-root-changed", "save-phase-sharded", "manifest-old-version", "manifest-missing-shard",
    "cancel-during-scan", "cancel-during-save", "pause-during-scan", "resume-after-reload",
  ]
  const wordOps = [
    "read-docx", "inspect-docx", "create-docx", "insert-section", "replace-paragraph", "rich-paragraph",
    "replace-text", "tracked-change-insert", "tracked-change-delete", "tracked-change-replace", "table-insert",
    "table-update-cell", "table-merge-cell", "list-update", "heading-level", "page-setup", "protection",
    "image-insert", "caption-insert", "hyperlink-insert", "footnote-insert", "endnote-insert", "comment-insert",
    "content-control", "watermark", "metadata-update", "redact-text", "patch-ooxml-part", "render-docx",
    "compare-docx", "merge-docx", "extract-xlsx-table", "export-table-csv", "style-preservation", "field-error-summary",
  ]
  const commentActions = [
    "progress-waiting", "progress-thinking", "progress-receiving-json", "progress-normalizing", "progress-failed",
    "tool-trace-running", "tool-trace-blocked", "workspace-unit-select", "workspace-unit-deselect", "workspace-select-all",
    "workspace-deselect-all", "preview-full-comment", "accept-one", "reject-one", "reveal-one", "accept-all",
    "undo-last-bulk-accept", "save-all-files", "regenerate", "clear-empty-state",
  ]
  const toolScenarios = [
    "run-command-stdout", "run-command-stderr", "run-command-nonzero", "run-command-timeout", "run-command-large-output",
    "run-command-permission-denied", "read-file-existing", "read-file-missing", "search-many-results", "write-file-denied",
    "http-request-offline", "skill-resource-missing", "skill-script-failure", "tool-disabled", "approval-allow",
    "approval-deny", "approval-timeout", "mcp-server-missing", "mcp-tool-failure", "terminal-reuse",
  ]
  const diagramScenarios = [
    "mermaid-flowchart", "mermaid-sequence", "mermaid-state", "mermaid-invalid-syntax", "mermaid-large-dense",
    "mermaid-export-png", "mermaid-copy-source", "drawio-basic", "drawio-complex", "drawio-invalid-style",
    "drawio-layout-failed", "drawio-export-png", "drawio-open-viewer", "zoom-in", "zoom-out", "zoom-reset",
    "source-toggle", "render-fallback", "artifact-write-failed", "bounds-too-large",
  ]
  const visualComponents = [
    "header-toolbar", "history-toolbar", "composer-toolbar", "status-pills", "context-chips", "model-menu",
    "agent-menu", "settings-fields", "rag-buttons", "codegraph-buttons", "document-rag-badge", "comment-proposal-card",
    "comment-progress", "tool-approval-banner", "clarification-card", "diagram-toolbar", "copy-button", "pin-button",
    "close-button", "refresh-button", "danger-button", "disabled-button", "loading-spinner", "focus-ring",
    "tooltip", "aria-label", "long-path-truncation", "long-model-name", "chinese-text", "high-contrast",
  ]
  const settingsControls = [
    "context-max-file-bytes", "context-max-files", "context-include-diagnostics", "context-include-git-diff",
    "context-local-only", "context-history-turns", "context-memory-summary", "permissions-mode-auto",
    "permissions-mode-ask", "permissions-mode-full-access", "tools-enabled-toggle", "tools-command-timeout",
    "skills-auto-import", "skills-details-collapse", "skills-invalid-manifest", "mcp-enabled", "mcp-server-list",
    "word-render-endpoint", "word-render-timeout", "word-local-toolchain", "updates-enabled", "updates-manifest-url",
    "updates-check-interval", "updates-max-download", "document-rag-max-file-bytes", "document-rag-include-globs",
    "document-rag-exclude-globs", "document-rag-worker-concurrency", "document-rag-evidence-bytes",
    "document-rag-top-k", "analysis-evidence-budget", "analysis-max-files", "analysis-worker-concurrency",
    "completion-enabled-boundary", "completion-provider-inheritance",
  ]
  const codeIntelDetails = [
    "symbol-summary", "state-machine-list", "state-machine-details", "transition-table", "call-graph-summary",
    "file-evidence-list", "workspace-stats", "parser-errors", "unsupported-language", "large-repo-progress",
    "shard-save-progress", "manifest-summary", "rag-ready-row", "rag-partial-row", "rag-provider-error-row",
    "document-rag-row", "refresh-button-loading", "hide-panel", "evidence-open-line", "evidence-open-missing",
  ]
  const lifecycleScenarios = [
    "extension-host-restart", "window-reload-during-stream", "window-reload-during-codegraph", "window-reload-during-rag",
    "window-reload-during-document-rag", "upgrade-restart-required", "old-session-format", "old-codegraph-manifest",
    "old-rag-manifest", "uninstall-storage-leftover", "global-storage-empty", "global-storage-large",
    "profile-clone-no-secrets", "clean-profile-no-provider", "clean-profile-no-workspace", "offline-chat",
    "offline-rag-test", "offline-document-render", "dns-failure", "proxy-failure",
  ]
  const keyboardA11y = [
    "tab-chat-header", "tab-history-pane", "tab-composer-toolbar", "tab-context-chip", "tab-model-menu",
    "tab-agent-menu", "tab-provider-settings", "tab-rag-settings", "tab-codegraph-controls", "tab-comments-review",
    "tab-diagram-toolbar", "escape-closes-menu", "escape-keeps-draft", "enter-activates-button", "space-toggles-checkbox",
    "arrow-model-menu", "arrow-agent-menu", "focus-visible-dark", "focus-visible-light", "screen-reader-status-text",
  ]

  return [
    ...chatInputs.map((input) => buildCase("chat", s(
      `input-${input}`,
      ["Focus composer", `Enter ${input} input`, "Submit or attempt to submit", "Observe resulting UI state"],
      [input, "provider missing", "send disabled", "reload after action"],
      [`Chat composer handles ${input} as a user would expect without duplicate messages, layout jumps, or misleading errors.`],
      input.includes("secret") ? ["interaction", "error", "log"] : ["interaction", "state", "layout"],
      input === "prompt-with-secret-like-text" ? "P0" : ["oversized-paste", "paste-while-streaming"].includes(input) ? "P1" : "P2",
      "planned",
      ["webview:chat-input"],
      ["chat", "composer"],
    ))),
    ...sessionActions.map((action) => buildCase("session-history", s(
      `action-${action}`,
      ["Open session history", `Perform ${action}`, "Inspect active session, row state, and message pane"],
      [action, "many sessions", "provider unavailable"],
      [`Session history action ${action} keeps selection, loading, and failure states consistent.`],
      ["interaction", "state", "layout"],
      action.includes("corrupt") || action.includes("failure") ? "P1" : "P2",
      "planned",
      ["webview:session-history"],
      ["session"],
    ))),
    ...providerFields.map((field) => buildCase("provider-settings", s(
      `field-${field}`,
      ["Open provider settings", `Edit ${field}`, "Save/test/reopen settings", "Send a short prompt when applicable"],
      [field, "empty value", "invalid value", "hot refresh"],
      [`Provider setting ${field} validates, saves, redacts, and refreshes without leaking secrets.`],
      field.includes("key") || field.includes("headers") ? ["interaction", "error", "log"] : ["interaction", "state", "error"],
      field.includes("key") || field.includes("headers") ? "P0" : "P2",
      "planned",
      ["webview:provider-settings", "webview:testWithSettings"],
      ["provider", "settings"],
    ))),
    ...ragFields.map((field) => buildCase("rag-settings", s(
      `field-${field}`,
      ["Open RAG settings", `Edit ${field}`, "Save", "Compare Code RAG status and storage summary"],
      [field, "ready index", "partial index", "provider error"],
      [`RAG setting ${field} maps to the correct save/resume/rebuild/query-only behavior.`],
      ["interaction", "state", "storage", "log"],
      ["embedding-endpoint", "embedding-model", "allowed-hosts"].includes(field) ? "P0" : "P1",
      "planned",
      ["webview:saveRagSettings"],
      ["rag", "settings"],
    ))),
    ...codeGraphMutations.map((mutation) => buildCase("codegraph-status", s(
      `mutation-${mutation}`,
      ["Open fixture workspace", `Apply ${mutation}`, "Observe CodeGraph and Code RAG status before/after reload"],
      [mutation, "watcher", "globalStorage", "status command"],
      [`CodeGraph mutation ${mutation} results in an explainable status transition and storage/log evidence.`],
      ["state", "storage", "log"],
      mutation.includes("manifest") || mutation.includes("save") ? "P1" : "P2",
      "planned",
      ["command:chipmate.codeGraph.status", "webview:codegraph-status"],
      ["codegraph", "rag"],
    ))),
    ...wordOps.map((op) => buildCase("document-rag", s(
      `word-${op}`,
      ["Open document fixture", `Run Word/document operation ${op}`, "Render or inspect result", "Check final answer warnings"],
      [op, "corrupt file", "large document", "runtime missing"],
      [`Word/document operation ${op} succeeds or produces a bounded field-level error with render evidence when applicable.`],
      op.includes("render") || op.includes("style") ? ["visual", "error", "log"] : ["state", "error", "log"],
      ["tracked-change", "patch-ooxml-part", "redact-text", "render-docx"].some((marker) => op.includes(marker)) ? "P1" : "P2",
      "planned",
      ["tool:word-document"],
      ["documents", "word"],
    ))),
    ...commentActions.map((action) => buildCase("comments-review", s(
      `action-${action}`,
      ["Open comment review panel", `Perform ${action}`, "Inspect proposal/progress/file state"],
      [action, "provider slow", "stale source"],
      [`Comment review action ${action} has clear visible state, diagnostics, and recovery path.`],
      ["interaction", "state", "error"],
      action.includes("failed") || action.includes("accept") ? "P1" : "P2",
      "planned",
      ["webview:comments-review"],
      ["comments"],
    ))),
    ...toolScenarios.map((scenario) => buildCase("tools-skills", s(
      `scenario-${scenario}`,
      ["Open tools/skills/approval surface", `Exercise ${scenario}`, "Inspect output, approval, and logs"],
      [scenario, "permission mode", "disabled tools"],
      [`Tool/skill scenario ${scenario} is bounded, redacted, and recoverable from the UI.`],
      ["interaction", "error", "log"],
      scenario.includes("permission") || scenario.includes("approval") || scenario.includes("write") ? "P0" : "P2",
      "planned",
      ["tool:runtime"],
      ["tools", "skills", "security"],
    ))),
    ...diagramScenarios.map((scenario) => buildCase("diagram", s(
      `scenario-${scenario}`,
      ["Generate diagram answer", `Exercise ${scenario}`, "Inspect preview, toolbar, export, and fallback"],
      [scenario, "renderer unavailable", "large content"],
      [`Diagram scenario ${scenario} preserves answer text and exposes render/export errors precisely.`],
      ["visual", "interaction", "error"],
      scenario.includes("failed") || scenario.includes("invalid") ? "P1" : "P2",
      "planned",
      ["feature:diagram"],
      ["diagram"],
    ))),
    ...visualComponents.map((component) => buildCase("visual-accessibility", s(
      `component-${component}`,
      ["Open relevant ChipMate surface", `Inspect ${component}`, "Check dark/light/narrow/focus/disabled variants"],
      [component, "Liquid Glass", "normal-flow icons", "no text overlap"],
      [`Visual component ${component} follows Liquid Glass, label, focus, and responsive layout rules.`],
      ["visual", "layout", "accessibility"],
      ["aria-label", "focus-ring", "disabled-button", "danger-button"].includes(component) ? "P1" : "P2",
      "planned",
      ["screenshots:visual-component"],
      ["visual", "liquid-glass", "icon"],
    ))),
    ...settingsControls.map((control) => buildCase("provider-settings", s(
      `settings-control-${control}`,
      ["Open settings UI", `Exercise setting control ${control}`, "Save/reopen and verify dependent UI state"],
      [control, "invalid input", "hot refresh", "reload"],
      [`Settings control ${control} validates input, persists state, and keeps dependent UI/status surfaces consistent.`],
      ["interaction", "state", "error"],
      control.includes("permissions") || control.includes("completion") ? "P1" : "P2",
      "planned",
      ["webview:settings"],
      ["settings"],
    ))),
    ...codeIntelDetails.map((detail) => buildCase("codegraph-status", s(
      `detail-${detail}`,
      ["Open Code Intelligence panel", `Inspect detail section ${detail}`, "Refresh and jump to evidence where applicable"],
      [detail, "missing evidence", "reload", "large result"],
      [`Code Intelligence detail ${detail} is visible, bounded, and consistent with CodeGraph/RAG storage state.`],
      ["visibility", "state", "layout", "storage"],
      detail.includes("error") || detail.includes("missing") ? "P1" : "P2",
      "planned",
      ["webview:code-intelligence"],
      ["codegraph", "rag"],
    ))),
    ...lifecycleScenarios.map((scenario) => buildCase("lifecycle", s(
      `scenario-${scenario}`,
      ["Prepare lifecycle fixture/profile state", `Trigger ${scenario}`, "Reopen ChipMate and inspect logs/storage/UI"],
      [scenario, "reload", "globalStorage", "extension host"],
      [`Lifecycle scenario ${scenario} has a recoverable user-visible state and no silent data loss.`],
      ["state", "error", "storage", "log"],
      scenario.includes("upgrade") || scenario.includes("old-") || scenario.includes("uninstall") ? "P0" : "P1",
      "planned",
      ["mode:lifecycle"],
      ["lifecycle", "offline"],
    ))),
    ...keyboardA11y.map((scenario) => buildCase("visual-accessibility", s(
      `keyboard-${scenario}`,
      ["Use keyboard only", `Exercise ${scenario}`, "Capture focus and status feedback"],
      [scenario, "dark theme", "light theme", "narrow width"],
      [`Keyboard/accessibility scenario ${scenario} has visible focus, deterministic action, and readable status text.`],
      ["accessibility", "interaction", "layout"],
      scenario.includes("screen-reader") || scenario.includes("focus-visible") ? "P1" : "P2",
      "planned",
      ["keyboard:a11y"],
      ["a11y", "visual"],
    ))),
  ]
}

function titleFromFeature(feature: string) {
  return feature.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ")
}

function allowedFailuresFor(oracles: UiOracleKind[]) {
  const failures = new Set<string>()
  for (const oracle of oracles) {
    if (oracle === "error") failures.add("expected-error-state")
    if (oracle === "layout" || oracle === "visual") failures.add("ui-overlap")
    if (oracle === "accessibility") failures.add("accessibility-gap")
    if (oracle === "storage") failures.add("storage-state-mismatch")
    if (oracle === "log") failures.add("extension-host-error")
  }
  failures.add("ui-automation-failure")
  return [...failures].sort()
}
