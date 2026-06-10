export const chipmateStyles = `
:root {
  color-scheme: light dark;
  --cm-bg: var(--vscode-sideBar-background);
  --cm-ink: var(--vscode-foreground);
  --cm-muted: var(--vscode-descriptionForeground);
  --cm-accent: #0a84ff;
  --cm-accent-2: #5ac8fa;
  --cm-ready: #32d74b;
  --cm-warn: #ff9f0a;
  --cm-danger: #ff453a;
  --cm-panel: color-mix(in srgb, var(--vscode-editor-background) 74%, transparent);
  --cm-panel-raised: color-mix(in srgb, var(--vscode-sideBar-background) 80%, #fff 5%);
  --cm-panel-deep: color-mix(in srgb, var(--vscode-sideBar-background) 88%, #000 8%);
  --cm-input: color-mix(in srgb, var(--vscode-input-background) 84%, var(--vscode-editor-background) 16%);
  --cm-line: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  --cm-line-strong: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  --cm-highlight: color-mix(in srgb, #fff 22%, transparent);
  --cm-shadow: 0 16px 34px color-mix(in srgb, #000 26%, transparent);
  --cm-shadow-soft: 0 8px 20px color-mix(in srgb, #000 18%, transparent);
  --cm-radius-xl: 24px;
  --cm-radius-lg: 18px;
  --cm-radius-md: 12px;
  --cm-radius-sm: 8px;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-width: 0;
  height: 100%;
}

body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--cm-ink);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--cm-bg) 88%, #07111f 12%), var(--cm-bg) 48%, color-mix(in srgb, var(--cm-bg) 84%, #000 16%));
  overflow: hidden;
}

button,
textarea,
input,
select {
  font: inherit;
}

button {
  border: 0;
  color: inherit;
  cursor: pointer;
}

button:disabled,
input:disabled,
select:disabled,
textarea:disabled {
  cursor: default;
  opacity: .56;
}

button,
input,
textarea,
select {
  transition: background-color .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease, opacity .16s ease, transform .16s ease;
}

.oc-liquid-icon {
  display: block;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
}

.appShell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
  padding: 7px;
  gap: 7px;
}

.glassFrame,
.mainSurface,
.composer {
  border: 1px solid var(--cm-line);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--cm-panel-raised) 88%, #fff 4%), color-mix(in srgb, var(--cm-panel) 88%, #000 4%));
  box-shadow:
    inset 0 1px 0 var(--cm-highlight),
    inset 0 -1px 0 color-mix(in srgb, #000 14%, transparent),
    var(--cm-shadow-soft);
  backdrop-filter: blur(24px) saturate(1.25);
}

.glassFrame {
  display: grid;
  gap: 7px;
  padding: 8px;
  border-radius: 20px;
}

.brandBar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.brandMark,
.avatar {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 13px;
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--cm-accent-2) 36%, var(--cm-line));
  background:
    linear-gradient(145deg, color-mix(in srgb, #fff 25%, transparent), transparent 32%),
    radial-gradient(circle at 30% 24%, #9fd4ff, transparent 38%),
    linear-gradient(145deg, #12345f, #0a84ff 58%, #203dff);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 38%, transparent),
    inset 0 -8px 16px color-mix(in srgb, #000 25%, transparent),
    0 8px 22px color-mix(in srgb, var(--cm-accent) 30%, transparent);
}

.brandMarkText,
.avatarText {
  font-size: 20px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0;
}

.brandCopy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.brandName {
  font-size: 16px;
  font-weight: 780;
  letter-spacing: 0;
  line-height: 1.06;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modelPill,
.glassButton,
.iconButton,
.dockButton,
.contextChip,
.permissionChip,
.toolButton,
.miniPill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  border: 1px solid var(--cm-line);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--cm-panel-raised) 84%, #fff 5%), color-mix(in srgb, var(--cm-panel-deep) 86%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent), var(--cm-shadow-soft);
  backdrop-filter: blur(18px) saturate(1.18);
}

.modelPill {
  justify-content: flex-start;
  max-width: 100%;
  min-height: 28px;
  gap: 6px;
  padding: 0 8px;
  border-radius: 10px;
  color: var(--cm-ink);
  font-size: 11px;
}

.modelPill:hover,
.iconButton:hover,
.dockButton:hover,
.glassButton:hover,
.toolButton:hover,
.contextChip:hover,
.permissionChip:hover {
  border-color: color-mix(in srgb, var(--cm-accent) 44%, var(--cm-line-strong));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--cm-panel-raised) 86%, var(--cm-accent) 8%), color-mix(in srgb, var(--cm-panel-deep) 84%, var(--cm-accent) 6%));
}

.modelText,
.pillText,
.rowTitle,
.rowMeta,
.messageText,
.fieldValue {
  min-width: 0;
  overflow-wrap: anywhere;
}

.statusDot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--cm-ready);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cm-ready) 14%, transparent), 0 0 12px color-mix(in srgb, var(--cm-ready) 45%, transparent);
}

.statusDot.warn {
  background: var(--cm-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cm-warn) 14%, transparent), 0 0 12px color-mix(in srgb, var(--cm-warn) 42%, transparent);
}

.statusDot.danger {
  background: var(--cm-danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cm-danger) 14%, transparent), 0 0 12px color-mix(in srgb, var(--cm-danger) 42%, transparent);
}

.headerActions,
.inlineActions,
.rowActions,
.footerStatus,
.fieldGrid,
.contextChipList,
.messageMeta,
.moduleDock,
.statusStrip,
.composerActions {
  display: flex;
  align-items: center;
  min-width: 0;
  flex-wrap: wrap;
}

.headerActions {
  justify-content: flex-end;
  gap: 5px;
  flex-wrap: nowrap;
}

.iconButton {
  width: 32px;
  height: 32px;
  border-radius: 11px;
  font-size: 17px;
}

.iconButton .oc-liquid-icon,
.dockIcon .oc-liquid-icon,
.ringIcon .oc-liquid-icon,
.toolButton .oc-liquid-icon,
.contextChip .oc-liquid-icon,
.permissionChip .oc-liquid-icon,
.miniPill .oc-liquid-icon {
  width: 1em;
  height: 1em;
}

.moduleDock {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  border: 1px solid var(--cm-line-strong);
  border-radius: 14px;
  overflow: hidden;
  background: color-mix(in srgb, var(--cm-panel-deep) 76%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent);
}

.dockButton {
  display: grid;
  grid-template-rows: 20px auto;
  align-items: center;
  justify-items: center;
  min-height: 50px;
  gap: 4px;
  border-width: 0 1px 0 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: color-mix(in srgb, var(--cm-muted) 88%, var(--cm-ink));
}

.dockButton:last-child {
  border-right: 0;
}

.dockButton.active {
  color: color-mix(in srgb, var(--cm-accent-2) 38%, var(--cm-ink));
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--cm-accent) 22%, transparent), color-mix(in srgb, var(--cm-panel-raised) 72%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--cm-accent) 28%, transparent);
}

.dockIcon {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  font-size: 20px;
}

.dockLabel {
  max-width: 100%;
  font-size: 9.5px;
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusStrip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.statusRing {
  display: grid;
  justify-items: center;
  gap: 3px;
  min-width: 0;
  min-height: 64px;
  padding: 5px 3px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--cm-line) 84%, transparent);
  background: color-mix(in srgb, var(--cm-panel) 76%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
}

.ringGraphic {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background:
    conic-gradient(var(--ring-color, var(--cm-accent)) var(--progress, 0%), color-mix(in srgb, var(--cm-ink) 18%, transparent) 0),
    color-mix(in srgb, var(--cm-panel-deep) 82%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 15%, transparent), inset 0 -1px 0 color-mix(in srgb, #000 22%, transparent);
}

.ringCore {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--cm-panel-deep) 88%, #000 8%);
  color: var(--cm-ink);
  font-size: 13px;
}

.ringLabel,
.ringValue {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.ringLabel {
  font-size: 9.5px;
  color: color-mix(in srgb, var(--cm-muted) 85%, var(--cm-ink));
}

.ringValue {
  font-size: 9px;
  color: var(--cm-muted);
  font-variant-numeric: tabular-nums;
}

.mainSurface {
  min-height: 0;
  overflow: auto;
  border-radius: 18px;
  padding: 8px;
  scrollbar-gutter: stable;
}

.modulePanel {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.moduleHeader,
.sessionBar,
.glassRow,
.messageBubble,
.fieldPanel,
.settingsBand {
  border: 1px solid var(--cm-line);
  background: color-mix(in srgb, var(--cm-panel) 76%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
}

.moduleHeader {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 14px;
}

.moduleTitle {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.moduleTitle strong {
  font-size: 15px;
  line-height: 1.2;
}

.moduleTitle span {
  color: var(--cm-muted);
  font-size: 11px;
  line-height: 1.35;
}

.sessionBar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 8px;
  border-radius: 14px;
}

.selectShell,
.field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.selectShell {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  border: 1px solid var(--cm-line);
  border-radius: 999px;
  min-height: 34px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--cm-input) 78%, transparent);
}

select,
input,
textarea {
  width: 100%;
  min-width: 0;
  color: var(--vscode-input-foreground);
  background: var(--cm-input);
  border: 1px solid var(--cm-line);
  outline: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent);
}

select {
  min-height: 30px;
  border-radius: 10px;
  padding: 5px 8px;
}

.selectShell select {
  min-height: 28px;
  border: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

input {
  min-height: 32px;
  border-radius: 10px;
  padding: 6px 9px;
}

textarea {
  min-height: 72px;
  max-height: 180px;
  resize: vertical;
  border-radius: 14px;
  padding: 10px;
  line-height: 1.45;
}

select:focus,
input:focus,
textarea:focus {
  border-color: color-mix(in srgb, var(--cm-accent) 55%, var(--cm-line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--cm-accent) 16%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent);
}

.glassButton,
.toolButton {
  min-height: 30px;
  gap: 6px;
  padding: 0 9px;
  border-radius: 11px;
  color: color-mix(in srgb, var(--cm-ink) 92%, var(--cm-muted));
}

.glassButton.primary,
.toolButton.primary {
  color: #fff;
  border-color: color-mix(in srgb, var(--cm-accent) 70%, transparent);
  background:
    linear-gradient(160deg, color-mix(in srgb, #fff 16%, transparent), transparent 34%),
    linear-gradient(160deg, #0a84ff, #0066ff);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent), 0 10px 24px color-mix(in srgb, var(--cm-accent) 33%, transparent);
}

.glassButton.danger,
.toolButton.danger {
  border-color: color-mix(in srgb, var(--cm-danger) 48%, var(--cm-line));
  color: color-mix(in srgb, var(--cm-danger) 68%, var(--cm-ink));
}

.inlineActions,
.rowActions,
.composerActions {
  gap: 6px;
  justify-content: flex-end;
}

.contextChipList {
  gap: 6px;
}

.contextChip,
.permissionChip,
.miniPill {
  gap: 6px;
  max-width: 100%;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  color: color-mix(in srgb, var(--cm-muted) 82%, var(--cm-ink));
}

.permissionChip {
  color: color-mix(in srgb, var(--cm-accent-2) 36%, var(--cm-ink));
  border-color: color-mix(in srgb, var(--cm-accent) 38%, var(--cm-line));
  background: color-mix(in srgb, var(--cm-accent) 18%, var(--cm-panel));
}

.messages {
  display: grid;
  gap: 12px;
  min-width: 0;
  align-content: start;
}

.messageWrap {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.messageWrap.user {
  justify-items: end;
}

.messageBubble {
  display: grid;
  gap: 8px;
  width: min(100%, 560px);
  padding: 10px;
  border-radius: 16px;
}

.messageWrap.user .messageBubble {
  border-color: color-mix(in srgb, var(--cm-accent) 34%, var(--cm-line));
  background: color-mix(in srgb, var(--cm-accent) 13%, var(--cm-panel));
}

.messageMeta {
  gap: 8px;
  color: var(--cm-muted);
  font-size: 11px;
}

.messageAuthor {
  color: var(--cm-ink);
  font-weight: 650;
}

.messageText {
  white-space: pre-wrap;
  line-height: 1.5;
}

.artifactRow,
.glassRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  padding: 9px;
  border-radius: 14px;
}

.rowIcon {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: color-mix(in srgb, var(--cm-accent-2) 42%, var(--cm-ink));
  border: 1px solid var(--cm-line);
  background: color-mix(in srgb, var(--cm-panel-raised) 76%, transparent);
}

.rowBody {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.rowTitle {
  font-weight: 650;
  line-height: 1.25;
}

.rowMeta {
  color: var(--cm-muted);
  font-size: 11px;
  line-height: 1.35;
}

.fieldPanel,
.settingsBand {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border-radius: 14px;
}

.fieldGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.field.wide {
  grid-column: 1 / -1;
}

.field label,
.fieldLabel {
  color: var(--cm-muted);
  font-size: 11px;
}

.toggleRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.toggleRow input[type="checkbox"] {
  width: 18px;
  height: 18px;
}

details {
  display: grid;
  gap: 8px;
  min-width: 0;
}

summary {
  cursor: pointer;
  color: color-mix(in srgb, var(--cm-muted) 76%, var(--cm-ink));
  font-size: 12px;
}

.progressBar {
  display: grid;
  min-width: 0;
  height: 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--cm-line) 74%, transparent);
  background: color-mix(in srgb, var(--cm-ink) 12%, transparent);
  overflow: hidden;
}

.progressFill {
  width: var(--progress, 0%);
  min-width: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--cm-accent), var(--cm-accent-2));
  box-shadow: 0 0 18px color-mix(in srgb, var(--cm-accent) 42%, transparent);
}

.capabilityGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.capability {
  display: grid;
  gap: 5px;
  justify-items: center;
  min-width: 0;
  padding: 7px 4px;
  border-radius: 12px;
  border: 1px solid var(--cm-line);
  background: color-mix(in srgb, var(--cm-panel) 70%, transparent);
}

.packageList,
.toolList {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.empty,
.notice {
  border: 1px solid var(--cm-line);
  border-radius: 14px;
  padding: 10px;
  color: color-mix(in srgb, var(--cm-muted) 88%, var(--cm-ink));
  background: color-mix(in srgb, var(--cm-panel) 66%, transparent);
  line-height: 1.42;
}

.notice.error {
  color: var(--vscode-errorForeground);
  border-color: color-mix(in srgb, var(--vscode-errorForeground) 46%, var(--cm-line));
}

.mentionBox {
  display: none;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--cm-line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--cm-panel-deep) 94%, transparent);
  box-shadow: var(--cm-shadow);
}

.mentionBox.active {
  display: grid;
}

.mentionItem {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--cm-line) 72%, transparent);
  background: transparent;
  text-align: left;
}

.mentionItem:last-child {
  border-bottom: 0;
}

.mentionItem:hover {
  background: color-mix(in srgb, var(--cm-accent) 12%, transparent);
}

.composer {
  display: grid;
  gap: 8px;
  border-radius: 18px;
  padding: 8px;
}

.composerInputRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 46px;
  gap: 8px;
  min-width: 0;
  align-items: stretch;
}

.composer textarea {
  min-height: 54px;
  max-height: 140px;
}

.sendButton {
  display: inline-grid;
  place-items: center;
  width: 46px;
  min-height: 46px;
  border-radius: 14px;
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--cm-accent) 60%, transparent);
  background:
    linear-gradient(160deg, color-mix(in srgb, #fff 18%, transparent), transparent 34%),
    linear-gradient(160deg, #0a84ff, #0066ff);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 32%, transparent), 0 10px 25px color-mix(in srgb, var(--cm-accent) 34%, transparent);
}

.sendButton.stop {
  border-color: color-mix(in srgb, var(--cm-danger) 52%, transparent);
  background: linear-gradient(160deg, color-mix(in srgb, var(--cm-danger) 88%, #fff 8%), color-mix(in srgb, var(--cm-danger) 78%, #000 12%));
}

.footerStatus {
  justify-content: space-between;
  gap: 8px;
  color: var(--cm-muted);
  font-size: 11px;
}

@media (max-width: 310px) {
  .appShell {
    padding: 6px;
    gap: 6px;
  }

  .glassFrame,
  .mainSurface,
  .composer {
    border-radius: 16px;
  }

  .moduleDock {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .dockButton {
    min-height: 48px;
  }

  .dockLabel {
    font-size: 9px;
  }

  .fieldGrid {
    grid-template-columns: 1fr;
  }

  .composerInputRow {
    grid-template-columns: minmax(0, 1fr);
  }

  .sendButton {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .glassFrame,
  .mainSurface,
  .composer,
  .modelPill,
  .glassButton,
  .iconButton,
  .dockButton,
  .contextChip,
  .permissionChip,
  .toolButton,
  .miniPill {
    backdrop-filter: none;
  }
}
`
