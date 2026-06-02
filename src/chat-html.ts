import { randomBytes } from "node:crypto"

export function createNonce(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(length)
  let nonce = ""
  for (const byte of bytes) nonce += alphabet[byte % alphabet.length]
  return nonce
}

export function createChatViewHtml(cspSource: string, nonce = createNonce()) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Remote</title>
  <style>
    :root {
      color-scheme: light dark;
      --chat-content-font-size: max(12px, var(--vscode-font-size, 13px));
      --chat-user-font-size: max(11px, calc(var(--vscode-font-size, 13px) - 1px));
      --chat-code-font-size: max(11px, calc(var(--vscode-font-size, 13px) - 1px));
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    button, textarea, input, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
    }
    .topbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 8px 9px;
      min-width: 0;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }
    .mark {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 700;
      font-size: 10px;
    }
    .title { min-width: 0; display: grid; gap: 2px; }
    .name { font-weight: 650; line-height: 1.1; }
    .meta { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .statusPill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--vscode-editor-background);
      vertical-align: top;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
      flex: 0 0 auto;
    }
    .dot.connected { background: var(--vscode-testing-iconPassed); }
    .dot.connecting { background: var(--vscode-progressBar-background); }
    .dot.authFailed, .dot.error { background: var(--vscode-errorForeground); }
    .server { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iconbar, .row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
    .iconbar { justify-content: flex-end; }
    .icon {
      min-width: 26px;
      max-width: 72px;
      height: 26px;
      border-radius: 5px;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent;
      padding: 0 7px;
      font-size: 11px;
      line-height: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .primary, .secondary {
      min-height: 26px;
      border-radius: 5px;
      padding: 4px 9px;
      font-size: 11px;
      line-height: 1.2;
    }
    .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .settings {
      display: none;
      gap: 8px;
      padding: 8px 9px 9px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }
    .settings.open { display: grid; }
    .settingsHeader { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
    .sectionTitle { min-width: 0; font-size: 11px; font-weight: 650; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .sectionMeta { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .settingsGrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; }
    .field { display: grid; gap: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .field input {
      width: 100%;
      min-width: 0;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 5px 7px;
    }
    .settingsActions { justify-content: space-between; align-items: flex-start; min-width: 0; }
    .settingsActions .row { min-width: 0; }
    .detail {
      display: none;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-left: 2px solid var(--vscode-panel-border);
      padding-left: 7px;
    }
    .detail.visible { display: block; }
    .detail.authFailed, .detail.error { color: var(--vscode-errorForeground); border-left-color: var(--vscode-errorForeground); }
    .body {
      position: relative;
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      overflow: hidden;
    }
    .historyBackdrop { display: none; }
    .historyPane {
      position: absolute;
      inset: 0 auto 0 0;
      width: min(286px, 88%);
      z-index: 20;
      min-width: 0;
      border-right: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-height: 100%;
      overflow: hidden;
      transform: translateX(-104%);
      transition: transform 140ms ease;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    }
    .app.history-open .historyPane { transform: translateX(0); }
    .app.history-open .historyBackdrop {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 10;
      background: rgba(0, 0, 0, 0.25);
    }
    .historyHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      padding: 8px 9px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .historyTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; font-size: 12px; }
    .sessionList { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
    .sessionRow {
      width: 100%;
      display: grid;
      gap: 3px;
      text-align: left;
      color: var(--vscode-foreground);
      background: transparent;
      border-radius: 6px;
      padding: 8px;
    }
    .sessionRow:hover { background: var(--vscode-list-hoverBackground); }
    .sessionRow.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .sessionName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .sessionBadge {
      margin-left: 5px;
      color: var(--vscode-editorWarning-foreground);
      font-size: 10px;
    }
    .sessionTime { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .sessionEmpty { padding: 12px 8px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .chatMain { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
    .messages {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 11px;
      scroll-behavior: smooth;
    }
    .empty {
      margin: auto;
      width: min(100%, 340px);
      color: var(--vscode-descriptionForeground);
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 11px;
      background: var(--vscode-editor-background);
    }
    .emptyTitle { color: var(--vscode-foreground); font-weight: 650; margin-bottom: 6px; }
    .emptyPrompts { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
    .emptyPrompt {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 3px 7px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      font-size: 10px;
    }
    .recentSessions { display: grid; gap: 5px; margin-top: 12px; }
    .recentSessions button {
      text-align: left;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      padding: 3px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .loadingLine {
      color: var(--vscode-descriptionForeground);
      font-size: var(--chat-content-font-size);
      padding: 6px 0;
    }
    .timelineItem {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      gap: 5px;
      align-items: start;
    }
    .avatar {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      display: grid;
      place-items: center;
      font-size: 8px;
      font-weight: 700;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .timelineItem.user .avatar { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    .timelineItem.error .avatar { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
    .messageCard {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .timelineItem.user .messageCard { background: var(--vscode-input-background); }
    .timelineItem.error .messageCard { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
    .messageMeta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 5px;
      min-width: 0;
      flex-wrap: wrap;
      padding: 3px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1.1;
      text-transform: none;
      letter-spacing: 0;
      background: var(--vscode-sideBar-background);
    }
    .messageMeta > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .messageStats { display: inline-flex; align-items: center; gap: 3px; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
    .messageUsage {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: none;
    }
    .messageTime { text-transform: none; white-space: nowrap; }
    .messageActions {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      min-width: 0;
      text-transform: none;
    }
    .messageAction {
      min-height: 17px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 0 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 9px;
      line-height: 1;
    }
    .messageAction:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .messageAction.copyMarkdown { color: var(--vscode-charts-purple, #b180d7); border-color: rgba(177, 128, 215, 0.5); }
    .messageAction.collapseMessage { color: var(--vscode-charts-blue, #4da3ff); border-color: rgba(77, 163, 255, 0.5); }
    .messageAction.jumpStructure { color: var(--vscode-testing-iconPassed, #73c991); border-color: rgba(115, 201, 145, 0.5); }
    .messageBody {
      padding: 10px 11px;
      font-size: var(--chat-content-font-size);
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .timelineItem.user .messageBody {
      padding: 7px 8px;
      font-size: var(--chat-user-font-size);
      line-height: 1.42;
    }
    .timelineItem.assistant .messageBody,
    .timelineItem.tool .messageBody {
      font-size: var(--chat-content-font-size);
      line-height: 1.55;
    }
    .messageCard.messageCollapsed .messageBody,
    .messageCard.messageCollapsed .messageOutline,
    .messageCard.messageCollapsed .messageLongHint { display: none; }
    .messageCard.longAnswer:not(.longExpanded) .messageBody {
      max-height: min(620px, 72vh);
      overflow: auto;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .messageLongHint {
      display: none;
      padding: 5px 11px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      background: var(--vscode-sideBar-background);
    }
    .messageCard.longAnswer:not(.longExpanded) .messageLongHint { display: block; }
    .messageOutline {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding: 3px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .messageOutlineSummary { flex: 0 0 auto; font-weight: 650; color: var(--vscode-foreground); }
    .messageOutlineButton {
      flex: 0 0 auto;
      max-width: 160px;
      min-height: 18px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 0 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 9px;
    }
    .messageOutlineButton:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .structureFlash {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .messageBody > :first-child { margin-top: 0; }
    .messageBody > :last-child { margin-bottom: 0; }
    .messageBody p { margin: 0 0 10px; }
    .timelineItem.user .messageBody p { margin-bottom: 7px; }
    .timelineItem.user .messageBody > :last-child { margin-bottom: 0; }
    .messageBody ul,
    .messageBody ol {
      margin: 0 0 10px 20px;
      padding: 0;
    }
    .messageBody li { margin: 3px 0; padding-left: 1px; }
    .mdHeading {
      color: var(--vscode-foreground);
      font-weight: 700;
      line-height: 1.35;
      margin: 13px 0 7px;
    }
    .mdHeading1 { font-size: 1.12em; }
    .mdHeading2 { font-size: 1.06em; }
    .mdHeading3 { font-size: 1em; color: var(--vscode-descriptionForeground); }
    .mdQuote {
      margin: 0 0 10px;
      padding: 1px 0 1px 10px;
      border-left: 3px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    .mdQuote p { margin-bottom: 0; }
    .mdDivider {
      height: 1px;
      margin: 12px 0;
      border: 0;
      background: var(--vscode-panel-border);
    }
    .mdStrong { color: var(--vscode-foreground); font-weight: 700; }
    .mdEm { font-style: italic; }
    .inlineCode {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 1px 3px;
    }
    .tableBlock {
      margin: 11px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .tableToolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      font-size: 10px;
    }
    .tableKind {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
      color: var(--vscode-foreground);
    }
    .tableActions { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .copyTable,
    .toggleTableRaw {
      min-height: 20px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 1px 5px;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      font-size: 10px;
      line-height: 1.2;
    }
    .copyTable:hover,
    .toggleTableRaw:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tableScroll {
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .tableBlock table {
      min-width: 100%;
      width: max-content;
      border-collapse: collapse;
      font-size: var(--chat-content-font-size);
      line-height: 1.4;
    }
    .tableBlock th,
    .tableBlock td {
      max-width: 420px;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 5px 7px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    .tableBlock th {
      position: sticky;
      top: 0;
      z-index: 1;
      color: var(--vscode-foreground);
      background: var(--vscode-editorStickyScroll-background, var(--vscode-sideBar-background));
      font-weight: 700;
    }
    .tableBlock td { color: var(--vscode-foreground); }
    .tableBlock tr:last-child td { border-bottom: 0; }
    .tableBlock th:last-child,
    .tableBlock td:last-child { border-right: 0; }
    .tableRaw {
      display: none;
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: 9px;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--chat-code-font-size);
      line-height: 1.45;
      white-space: pre;
    }
    .tableBlock.raw .tableScroll { display: none; }
    .tableBlock.raw .tableRaw { display: block; }
    .codeBlock {
      margin: 11px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-textCodeBlock-background);
      overflow: hidden;
    }
    .codeHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      background: var(--vscode-sideBar-background);
    }
    .codeLanguage {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .copyCode { color: var(--vscode-textLink-foreground); background: transparent; padding: 2px 5px; border-radius: 3px; }
    .copyCode:hover { background: var(--vscode-toolbar-hoverBackground); }
    .codeBlock pre { margin: 0; padding: 10px; overflow: auto; white-space: pre; line-height: 1.45; }
    .codeBlock code { font-family: var(--vscode-editor-font-family); font-size: var(--chat-code-font-size); }
    .syntaxKeyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .syntaxString { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .syntaxComment { color: var(--vscode-descriptionForeground); font-style: italic; }
    .syntaxNumber { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .syntaxFunction { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .syntaxType { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .syntaxProperty { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .syntaxInserted { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .syntaxDeleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
    .syntaxHunk { color: var(--vscode-charts-blue, #4da3ff); }
    .toolCard {
      margin-top: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-sideBar-background);
    }
    .toolCard.serverWarning {
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-sideBar-background));
    }
    .toolCard.reasoning {
      border-color: var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
    }
    .toolCard summary {
      cursor: pointer;
      padding: 6px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .toolCard pre {
      margin: 0;
      padding: 7px;
      overflow: auto;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
      white-space: pre-wrap;
    }
    .toolCard.reasoning pre { max-height: 120px; color: var(--vscode-descriptionForeground); }
    .thinking .messageBody { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); }
    .dots { display: inline-flex; gap: 4px; }
    .dots span { width: 5px; height: 5px; border-radius: 999px; background: var(--vscode-descriptionForeground); opacity: 0.45; }
    .composerWrap {
      flex: 0 0 auto;
      display: grid;
      gap: 3px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      padding: 3px 5px 3px;
      background: var(--vscode-sideBar-background);
    }
    .composerStatusBar {
      position: relative;
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      min-height: 22px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }
    .composerStatusBar::-webkit-scrollbar { display: none; }
    .composerStatusToggle {
      flex: 0 0 auto;
      min-width: 64px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid var(--vscode-focusBorder, rgba(77, 163, 255, 0.65));
      border-radius: 5px;
      padding: 0 7px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 0 0 1px rgba(77, 163, 255, 0.16) inset;
    }
    .composerStatusToggle:hover {
      background: var(--vscode-button-hoverBackground);
      box-shadow: 0 0 0 1px rgba(77, 163, 255, 0.32) inset;
    }
    .composerToggleIcon {
      position: relative;
      width: 10px;
      height: 10px;
      flex: 0 0 auto;
    }
    .composerToggleIcon::before {
      content: "";
      position: absolute;
      left: 1px;
      right: 1px;
      top: 2px;
      border-top: 1.5px solid currentColor;
      opacity: 0.9;
    }
    .composerToggleIcon::after {
      content: "";
      position: absolute;
      left: 2px;
      top: 3px;
      width: 6px;
      height: 6px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      transition: transform 120ms ease, top 120ms ease;
    }
    .composerWrap.collapsed .composerToggleIcon::after {
      top: 2px;
      transform: rotate(225deg);
    }
    .composerToggleLabel {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composerToggleShort { display: none; }
    .composerStatusPill {
      flex: 0 0 auto;
      min-width: 0;
      height: 20px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 0 6px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-weight: 650;
      font-size: 9px;
      line-height: 18px;
      white-space: nowrap;
    }
    .composerStatusPill:hover,
    .composerStatusPill.open {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .composerStatusPill .pillText {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composerStatusPill.compactRing {
      width: 22px;
      min-width: 22px;
      justify-content: center;
      padding: 0;
    }
    .statusRing {
      position: relative;
      width: 12px;
      height: 12px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: conic-gradient(var(--ring-fill, currentColor) var(--ring-progress, 0%), var(--ring-empty, rgba(127, 127, 127, 0.24)) 0);
      box-shadow: 0 0 0 1px var(--ring-border, rgba(127, 127, 127, 0.28)) inset;
    }
    .statusRing::after {
      content: "";
      position: absolute;
      inset: 3px;
      border-radius: inherit;
      background: var(--vscode-editor-background);
      box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.08);
    }
    .statusRing.indeterminate {
      --ring-progress: 32%;
    }
    .composerStatusPill.panel { color: var(--vscode-foreground); }
    .composerStatusPill.context { color: var(--vscode-charts-blue, #4da3ff); border-color: rgba(77, 163, 255, 0.52); background: rgba(77, 163, 255, 0.08); }
    .composerStatusPill.index.ready { color: var(--vscode-testing-iconPassed, #73c991); border-color: rgba(115, 201, 145, 0.56); background: rgba(115, 201, 145, 0.08); --ring-fill: var(--vscode-testing-iconPassed, #73c991); --ring-empty: rgba(115, 201, 145, 0.22); --ring-border: rgba(115, 201, 145, 0.34); }
    .composerStatusPill.index.indexing,
    .composerStatusPill.index.info { color: var(--vscode-charts-blue, #4da3ff); border-color: rgba(77, 163, 255, 0.52); background: rgba(77, 163, 255, 0.08); --ring-fill: var(--vscode-charts-blue, #4da3ff); --ring-empty: rgba(77, 163, 255, 0.22); --ring-border: rgba(77, 163, 255, 0.34); }
    .composerStatusPill.index.warning,
    .composerStatusPill.guard.warning,
    .composerStatusPill.usage.warning { color: var(--vscode-editorWarning-foreground, #cca700); border-color: rgba(204, 167, 0, 0.62); background: rgba(204, 167, 0, 0.08); --ring-fill: var(--vscode-editorWarning-foreground, #cca700); --ring-empty: rgba(204, 167, 0, 0.22); --ring-border: rgba(204, 167, 0, 0.36); }
    .composerStatusPill.index.error,
    .composerStatusPill.usage.error { color: var(--vscode-errorForeground, #f48771); border-color: rgba(244, 135, 113, 0.62); background: rgba(244, 135, 113, 0.08); --ring-fill: var(--vscode-errorForeground, #f48771); --ring-empty: rgba(244, 135, 113, 0.22); --ring-border: rgba(244, 135, 113, 0.36); }
    .composerStatusPill.guard.ok { color: var(--vscode-testing-iconPassed, #73c991); border-color: rgba(115, 201, 145, 0.56); background: rgba(115, 201, 145, 0.08); }
    .composerStatusPill.guard.off { color: var(--vscode-descriptionForeground); }
    .composerStatusPill.usage.normal,
    .composerStatusPill.usage.pending { color: var(--vscode-charts-purple, #b180d7); border-color: rgba(177, 128, 215, 0.56); background: rgba(177, 128, 215, 0.08); --ring-fill: var(--vscode-charts-purple, #b180d7); --ring-empty: rgba(177, 128, 215, 0.22); --ring-border: rgba(177, 128, 215, 0.34); }
    .composerStatusPopover {
      display: none;
      position: absolute;
      left: 6px;
      right: 6px;
      bottom: calc(100% + 6px);
      z-index: 70;
      max-height: min(240px, calc(100vh - 92px));
      overflow: auto;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 7px;
      padding: 8px;
      color: var(--vscode-foreground);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
      font-size: 11px;
      line-height: 1.35;
    }
    .composerStatusPopover.open { display: grid; gap: 7px; }
    .statusPopoverHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; }
    .statusPopoverMeta { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .statusPopoverRows { display: grid; gap: 5px; }
    .statusPopoverRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      padding: 4px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .statusPopoverLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .statusPopoverActions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .statusActionButton,
    .contextRemoveButton {
      min-height: 22px;
      border-radius: 5px;
      padding: 2px 7px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 10px;
      line-height: 1.2;
    }
    .statusActionButton:hover,
    .contextRemoveButton:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .statusActionButton.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .statusActionButton.primary:hover { background: var(--vscode-button-hoverBackground); }
    .composerWrap.collapsed .composerPanel { display: none; }
    .composerPanel { display: grid; gap: 3px; min-width: 0; }
    .composerPanel .secondary {
      min-height: 22px;
      padding: 1px 6px;
      font-size: 9px;
    }
    .guard {
      display: none;
      position: relative;
      align-items: center;
      gap: 5px;
      width: fit-content;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 7px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 10px;
      line-height: 1.25;
    }
    .guard.visible { display: inline-flex; }
    .guard.warning {
      color: var(--vscode-editorWarning-foreground);
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    }
    .guardSummary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .guardDetail {
      display: none;
      position: absolute;
      left: 0;
      bottom: calc(100% + 5px);
      z-index: 45;
      width: min(360px, calc(100vw - 18px));
      max-width: calc(100vw - 18px);
      max-height: 120px;
      overflow: auto;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 7px;
      padding: 7px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.26);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .guard:hover .guardDetail, .guard:focus .guardDetail, .guard:focus-within .guardDetail { display: block; }
    .usageMeter {
      display: none;
      width: fit-content;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 7px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 10px;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .usageMeter.visible { display: inline-flex; }
    .usageMeter.warning {
      color: var(--vscode-editorWarning-foreground);
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    }
    .usageMeter.error {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-editor-background));
    }
    .codeGraph {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 7px;
      width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 5px 6px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 11px;
      line-height: 1.25;
    }
    .codeGraph.ready { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
    .codeGraph.indexing,
    .codeGraph.indexingFull,
    .codeGraph.indexingIncremental,
    .codeGraph.recovering { color: var(--vscode-progressBar-background); border-color: var(--vscode-progressBar-background); }
    .codeGraph.stale,
    .codeGraph.degraded,
    .codeGraph.paused,
    .codeGraph.rescanScheduled { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); }
    .codeGraph.error { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    .codeGraphMain {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .codeGraphLabel {
      min-width: 0;
      color: var(--vscode-foreground);
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codeGraph.ready .codeGraphLabel { color: var(--vscode-testing-iconPassed); }
    .codeGraph.indexing .codeGraphLabel,
    .codeGraph.indexingFull .codeGraphLabel,
    .codeGraph.indexingIncremental .codeGraphLabel,
    .codeGraph.recovering .codeGraphLabel { color: var(--vscode-progressBar-background); }
    .codeGraph.stale .codeGraphLabel,
    .codeGraph.degraded .codeGraphLabel,
    .codeGraph.paused .codeGraphLabel,
    .codeGraph.rescanScheduled .codeGraphLabel { color: var(--vscode-editorWarning-foreground); }
    .codeGraph.error .codeGraphLabel { color: var(--vscode-errorForeground); }
    .codeGraphMeta {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codeGraphActions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .codeGraphButton {
      min-height: 22px;
      border-radius: 5px;
      padding: 2px 7px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 10px;
      line-height: 1.2;
    }
    .codeGraphButton:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .codeIntel {
      display: none;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 6px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 10px;
      line-height: 1.3;
      max-height: 190px;
      overflow: auto;
    }
    .codeIntel.visible { display: grid; gap: 6px; }
    .codeIntelHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .codeIntelHeaderActions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .codeIntelAction {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      line-height: 1.2;
    }
    .codeIntelAction:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .codeIntelStatus {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 5px 6px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      overflow-wrap: anywhere;
    }
    .codeIntelStatus.error {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-editor-background));
    }
    .codeIntelSection { display: grid; gap: 3px; min-width: 0; }
    .codeIntelTitle { color: var(--vscode-foreground); font-weight: 650; }
    .codeIntelRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 5px;
      align-items: start;
      min-width: 0;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 4px;
    }
    .codeIntelMain { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .codeIntelMeta { min-width: 0; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .codeIntelRowActions { display: flex; align-items: start; gap: 4px; }
    .codeIntelJump {
      color: var(--vscode-textLink-foreground);
      background: transparent;
      padding: 1px 3px;
      border-radius: 3px;
      font-size: 10px;
    }
    .codeIntelJump:hover { background: var(--vscode-toolbar-hoverBackground); }
    .codeIntelMachineMeta { display: flex; flex-wrap: wrap; gap: 4px; }
    .codeIntelBadge {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      font-size: 9px;
      line-height: 1.2;
    }
    .codeIntelBadge.warning {
      color: var(--vscode-editorWarning-foreground);
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    }
    .codeIntelTransitionTable { display: grid; gap: 4px; min-width: 0; }
    .codeIntelTransitionRow {
      display: grid;
      grid-template-columns: minmax(84px, 1.2fr) minmax(0, 1fr) auto;
      gap: 5px;
      align-items: start;
      min-width: 0;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 4px;
    }
    .codeIntelTransitionEdge,
    .codeIntelTransitionDetail,
    .codeIntelEvidence {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .codeIntelSnippet {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 9px;
      white-space: pre-wrap;
    }
    .modelSelectHidden { display: none; }
    .manualModel input {
      min-width: 0;
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 2px 5px;
      font-size: 10px;
      height: 24px;
    }
    .manualModel { display: none; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; min-width: 0; }
    .manualModel.open { display: grid; }
    .srOnly {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .chips { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 3px; min-width: 0; min-height: 0; max-height: 38px; overflow: auto; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 0 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 9px;
    }
    .chip.autoContext.captured { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
    .chip.autoContext.missing { color: var(--vscode-errorForeground); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); }
    .chip span { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip button { color: var(--vscode-descriptionForeground); background: transparent; padding: 0; width: 14px; height: 14px; border-radius: 999px; }
    .chip button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .composer {
      position: relative;
      display: grid;
      grid-template-rows: auto auto;
      gap: 3px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      border-radius: 8px;
      overflow: visible;
    }
    .composer:focus-within { border-color: var(--vscode-focusBorder); }
    .composer textarea {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 44px;
      max-height: 120px;
      resize: vertical;
      padding: 6px;
      border: 0;
      outline: none;
      color: var(--vscode-input-foreground);
      background: transparent;
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
    }
    .composerToolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, max-content) auto;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding: 0 4px 4px;
    }
    .send {
      min-width: 44px;
      height: 22px;
      border-radius: 5px;
      padding: 0 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-focusBorder, transparent);
      font-weight: 700;
      font-size: 10px;
      box-shadow: 0 0 0 1px rgba(77, 163, 255, 0.18) inset;
    }
    .send:hover { background: var(--vscode-button-hoverBackground); }
    .composerHint {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }
    .modelTrigger {
      position: relative;
      z-index: 2;
      width: 100%;
      min-width: 0;
      height: 22px;
      border-radius: 5px;
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      padding: 0 18px 0 7px;
      color: var(--vscode-foreground);
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      font-size: 9px;
      line-height: 20px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset;
    }
    .modelTrigger::after {
      content: "";
      position: absolute;
      right: 7px;
      top: 50%;
      margin-top: -1px;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-top: 4px solid currentColor;
      opacity: 0.85;
      pointer-events: none;
    }
    .modelTrigger:hover,
    .modelTrigger.open {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .modelTrigger:active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-toolbar-hoverBackground)); }
    .agentTrigger.ready { border-color: var(--vscode-testing-iconPassed); }
    .agentTrigger.warning {
      color: var(--vscode-editorWarning-foreground);
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
    }
    .modelMenu {
      display: none;
      position: fixed;
      left: 0;
      bottom: auto;
      z-index: 1000;
      width: auto;
      max-height: calc(100vh - 16px);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 7px;
      background: var(--vscode-dropdown-background);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.26);
    }
    .modelMenu.open { display: block; }
    .modelMenuItem {
      width: 100%;
      display: grid;
      gap: 2px;
      padding: 6px 8px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      font-size: 10px;
    }
    .modelMenuItem:hover, .modelMenuItem.active { background: var(--vscode-list-hoverBackground); }
    .modelMenuItem.disabled {
      cursor: default;
      opacity: 0.58;
    }
    .modelMenuItem.disabled:hover { background: transparent; }
    .modelMenuItem.localAgent .modelMenuName { color: var(--vscode-testing-iconPassed); }
    .modelMenuName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .modelMenuMeta { color: var(--vscode-descriptionForeground); font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .suggestions {
      display: none;
      position: absolute;
      left: 7px;
      right: 7px;
      bottom: calc(100% + 6px);
      max-height: max(48px, min(210px, calc(100vh - 132px)));
      overflow: auto;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 7px;
      background: var(--vscode-dropdown-background);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.26);
      z-index: 30;
    }
    .suggestions.open { display: block; }
    .suggestion {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px;
      align-items: center;
      padding: 7px 8px;
      cursor: pointer;
      overflow: hidden;
    }
    .suggestion:hover, .suggestion.active { background: var(--vscode-list-hoverBackground); }
    .suggestionIcon { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
    .suggestionLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .suggestionMeta { padding: 7px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .composerActions { min-width: 0; }
    .composerActionRow {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toggles { display: contents; color: var(--vscode-descriptionForeground); font-size: 9px; }
    .toggles label {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1;
      white-space: nowrap;
    }
    .toggles input {
      width: 11px;
      height: 11px;
      flex: 0 0 auto;
      margin: 0;
      accent-color: var(--vscode-focusBorder, var(--vscode-button-background));
    }
    .toggleShort { display: none; }
    .composerActions .secondary {
      transition: border-color 120ms ease, background 120ms ease;
    }
    .composerActions .secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .composerIconButton {
      width: 18px;
      min-width: 18px;
      height: 18px;
      min-height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 4px;
      padding: 0;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent;
      line-height: 1;
    }
    .composerIconButton .buttonIcon {
      width: 13px;
      height: 13px;
      flex: 0 0 auto;
      pointer-events: none;
    }
    .composerIconButton.loading .buttonIcon { animation: statusRingSpin 900ms linear infinite; }
    .exportButton {
      color: var(--vscode-charts-purple, #b180d7);
    }
    .attachButton {
      color: var(--vscode-charts-blue, #4da3ff);
    }
    .refreshButton {
      color: var(--vscode-descriptionForeground);
    }
    .notice { min-height: 0; color: var(--vscode-descriptionForeground); font-size: 10px; overflow-wrap: anywhere; }
    .notice:empty { display: none; }
    @media (max-width: 479px) {
      .topbar { gap: 6px; padding: 7px; }
      .icon { max-width: 52px; padding: 0 6px; }
      .primary, .secondary { padding-inline: 7px; }
      .composerActionRow { gap: 7px; }
      .toggles label { font-size: 9px; }
      .toggles input { width: 10px; height: 10px; }
      .composerIconButton { width: 18px; min-width: 18px; height: 18px; padding: 0; }
      .composerToolbar {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        gap: 4px;
      }
      .composerHint {
        grid-column: 1 / -1;
        grid-row: 2;
      }
      .settingsActions { justify-content: flex-start; }
    }
    @media (max-width: 360px) {
      .composerStatusToggle { min-width: 62px; padding-inline: 7px; }
      .composerToggleFull { display: none; }
      .composerToggleShort { display: inline; }
      .composerActionRow { gap: 6px; }
      .toggleFull { display: none; }
      .toggleShort { display: inline; }
    }
    @media (max-width: 300px) {
      .topbar { gap: 5px; padding: 6px; }
      .mark { width: 22px; height: 22px; }
      .icon { min-width: 24px; max-width: 34px; height: 24px; padding: 0 5px; }
      .primary, .secondary { min-height: 24px; padding-inline: 6px; }
      .composerWrap { padding: 3px 4px; }
      .composerActionRow { gap: 5px 7px; }
      .composerIconButton { width: 18px; min-width: 18px; height: 18px; min-height: 18px; padding: 0; }
      .composerHint { display: none; }
      .send { min-width: 40px; padding: 0 6px; }
      .modelTrigger { height: 24px; }
    }
    @media (min-width: 760px) {
      .app.history-open.history-wide .body { grid-template-columns: 230px minmax(0, 1fr); }
      .app.history-open.history-wide .historyPane { position: relative; inset: auto; width: auto; z-index: auto; transform: none; box-shadow: none; }
      .app.history-open.history-wide .historyBackdrop { display: none; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .timelineItem { animation: messageIn 150ms ease both; }
      .dots span { animation: pulse 900ms ease-in-out infinite; }
      .dots span:nth-child(2) { animation-delay: 130ms; }
      .dots span:nth-child(3) { animation-delay: 260ms; }
      .statusRing.indeterminate { animation: statusRingSpin 900ms linear infinite; }
      @keyframes messageIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes pulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
      @keyframes statusRingSpin { to { transform: rotate(360deg); } }
    }
    @media (forced-colors: active) {
      .messageAction,
      .messageOutlineButton,
      .tableBlock,
      .tableBlock th,
      .tableBlock td,
      .copyTable,
      .toggleTableRaw,
      .composerStatusPill,
      .statusRing,
      .statusActionButton,
      .contextRemoveButton,
      .composerIconButton {
        border-color: CanvasText;
        forced-color-adjust: auto;
      }
      .messageAction:hover,
      .messageOutlineButton:hover,
      .copyTable:hover,
      .toggleTableRaw:hover {
        outline: 1px solid Highlight;
      }
    }
  </style>
</head>
<body>
  <div id="app" class="app history-closed history-narrow">
    <header class="topbar">
      <div class="mark">OC</div>
      <div class="title">
        <div class="name">OpenCode</div>
        <div class="meta">
          <span class="statusPill"><span id="statusDot" class="dot"></span><span id="server" class="server">OpenCode Remote UI loading...</span></span>
        </div>
      </div>
      <div class="iconbar">
        <button id="historyToggle" class="icon" title="History" aria-label="History">History</button>
        <button id="newSession" class="icon" title="New session">+</button>
        <button id="settingsToggle" class="icon" title="Connection settings" aria-label="Connection settings">...</button>
      </div>
    </header>
    <section id="settings" class="settings open">
      <div class="settingsHeader">
        <div class="sectionTitle">Connection</div>
        <div class="sectionMeta">Remote endpoint</div>
      </div>
      <div class="settingsGrid">
        <label class="field">Server URL<input id="serverUrl" type="url" spellcheck="false" placeholder="http://localhost:4096"></label>
        <label class="field">Username<input id="username" type="text" spellcheck="false" autocomplete="username" placeholder="opencode"></label>
        <label class="field">Password<input id="password" type="password" autocomplete="current-password" placeholder="Leave empty for no password"></label>
      </div>
      <div class="row settingsActions">
        <div class="row">
          <button id="connect" class="primary">Connect</button>
          <button id="test" class="secondary">Test</button>
        </div>
        <div class="row">
          <button id="refresh" class="secondary" title="Refresh chat state">Refresh</button>
          <button id="openOutput" class="secondary" title="Open output log">Output</button>
        </div>
      </div>
      <div id="connectionDetail" class="detail visible">If this message does not change, the Webview script did not start.</div>
    </section>
    <div class="body">
      <button id="historyBackdrop" class="historyBackdrop" title="Close history"></button>
      <aside id="historyPane" class="historyPane">
        <div class="historyHeader">
          <div class="historyTitle">History</div>
          <div class="row">
            <button id="refreshHistory" class="icon" title="Refresh sessions">Refresh</button>
            <button id="closeHistory" class="icon" title="Close history">x</button>
          </div>
        </div>
        <div id="sessionList" class="sessionList"></div>
      </aside>
      <section class="chatMain">
        <main id="messages" class="messages">
          <div class="empty">Ask about your code. Type @ to attach workspace files as context.</div>
        </main>
        <footer class="composerWrap">
          <div id="composerStatusBar" class="composerStatusBar">
            <button id="composerStatusToggle" class="composerStatusToggle" type="button" aria-expanded="true" aria-controls="composerPanel" title="Hide input panel">
              <span class="composerToggleIcon" aria-hidden="true"></span>
              <span class="composerToggleLabel">
                <span id="composerToggleFull" class="composerToggleFull">Hide input</span>
                <span id="composerToggleShort" class="composerToggleShort">Hide</span>
              </span>
            </button>
            <button id="panelStatusPill" class="composerStatusPill panel" type="button" title="Collapse input panel"><span class="pillText">Panel</span></button>
            <button id="contextStatusPill" class="composerStatusPill context" type="button" title="Show context details"><span class="pillText">Ctx 0</span></button>
            <button id="indexStatusPill" class="composerStatusPill index info compactRing" type="button" title="Show index details"><span class="pillText statusRing" aria-hidden="true"></span></button>
            <button id="guardStatusPill" class="composerStatusPill guard ok" type="button" title="Show guard details"><span class="pillText">Guard ok</span></button>
            <button id="usageStatusPill" class="composerStatusPill usage pending compactRing" type="button" title="Show usage details"><span class="pillText statusRing" aria-hidden="true"></span></button>
          </div>
          <div id="composerStatusPopover" class="composerStatusPopover" aria-hidden="true"></div>
          <div id="composerPanel" class="composerPanel">
            <div id="codeIntelligence" class="codeIntel"></div>
            <select id="modelSelect" class="modelSelectHidden" title="Model"></select>
            <div class="composer">
              <div id="suggestions" class="suggestions"></div>
              <div id="modelMenu" class="modelMenu" role="listbox" aria-label="Model" aria-hidden="true"></div>
              <div id="agentMenu" class="modelMenu agentMenu" role="listbox" aria-label="Agent" aria-hidden="true"></div>
              <textarea id="input" placeholder="Ask OpenCode... Use @ to reference files."></textarea>
              <div class="composerToolbar">
                <button id="modelTrigger" class="modelTrigger" type="button" title="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu">Model</button>
                <button id="agentTrigger" class="modelTrigger agentTrigger" type="button" title="Agent" aria-haspopup="listbox" aria-expanded="false" aria-controls="agentMenu">Agent</button>
                <div id="composerHint" class="composerHint">@ files, Ctrl+Enter send</div>
                <button id="send" class="send" title="Send">Send</button>
              </div>
            </div>
            <div class="composerActions">
              <div class="composerActionRow">
                <div class="toggles">
                  <label><input id="sel" type="checkbox" checked><span class="toggleFull">Selection</span><span class="toggleShort">Selection</span></label>
                  <label><input id="file" type="checkbox" checked><span class="toggleFull">Current file</span><span class="toggleShort">Current</span></label>
                  <label><input id="diag" type="checkbox"><span class="toggleFull">Diagnostics</span><span class="toggleShort">Diag</span></label>
                  <label><input id="diff" type="checkbox"><span class="toggleFull">Git diff</span><span class="toggleShort">Diff</span></label>
                </div>
                <button id="exportMarkdown" class="secondary exportButton composerIconButton" title="Export current chat to Markdown" aria-label="Export current chat to Markdown">
                  <svg class="buttonIcon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 2.5v7"></path>
                    <path d="M5.2 7.1 8 9.9l2.8-2.8"></path>
                    <path d="M3.2 12.5h9.6"></path>
                  </svg>
                  <span class="srOnly">Export current chat to Markdown</span>
                </button>
                <button id="attach" class="secondary attachButton composerIconButton" title="Attach file as persistent context" aria-label="Attach file as persistent context">
                  <svg class="buttonIcon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 8.2 9.8 4.4a2.1 2.1 0 0 1 3 3L7.6 12.6a3.2 3.2 0 0 1-4.5-4.5l5-5"></path>
                    <path d="M8 10 11.6 6.4"></path>
                  </svg>
                  <span class="srOnly">Attach file as persistent context</span>
                </button>
                <button id="refreshModels" class="secondary refreshButton composerIconButton" title="Refresh models" aria-label="Refresh models">
                  <svg class="buttonIcon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12.8 5.4A5 5 0 1 0 13 10"></path>
                    <path d="M12.8 2.8v2.6h-2.6"></path>
                  </svg>
                  <span class="srOnly">Refresh models</span>
                </button>
              </div>
            </div>
            <div id="manualModelRow" class="manualModel">
              <input id="manualModel" spellcheck="false" placeholder="provider/model">
              <button id="saveManualModel" class="secondary">Use</button>
            </div>
            <div id="notice" class="notice"></div>
          </div>
        </footer>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = (id) => document.getElementById(id);
    let state = {};
    let pendingAction = "";
    let settingsOpen = true;
    let userEditedConnection = false;
    let historyTouched = false;
    let historyOpen = false;
    let userNearBottom = true;
    let mentionedFiles = [];
    let mentionResults = [];
    let activeSuggestion = 0;
    let searchTimer = 0;
    let mentionRequestId = 0;
    let activeMentionRequestId = 0;
    let mentionStatus = "";
    let mentionTruncated = false;
    let mentionError = "";
    let mentionSearched = false;
    let modelMenuOpen = false;
    let agentMenuOpen = false;
    let composerCollapsed = false;
    let composerPinnedStatusPopover = "";
    let composerHoverStatusPopover = "";
    let composerHoverCloseTimer = 0;
    let codeIntelligenceVisible = false;
    let selectedStateMachineId = "";
    const collapsedMessages = new Set();
    const expandedLongMessages = new Set();
    const messageJumpIndex = new Map();

    el("server").textContent = "UI ready";
    el("connectionDetail").className = "detail";
    el("connectionDetail").textContent = "";

    for (const id of ["serverUrl", "username", "password"]) {
      el(id).addEventListener("input", () => {
        userEditedConnection = true;
      });
    }

    el("messages").addEventListener("scroll", () => {
      userNearBottom = isNearBottom(el("messages"));
    });
    window.addEventListener("resize", () => {
      renderShell();
      positionModelMenu();
      positionAgentMenu();
    });
    el("historyToggle").addEventListener("click", () => {
      historyTouched = true;
      historyOpen = !historyOpen;
      renderShell();
    });
    el("closeHistory").addEventListener("click", () => {
      historyTouched = true;
      historyOpen = false;
      renderShell();
    });
    el("historyBackdrop").addEventListener("click", () => {
      historyTouched = true;
      historyOpen = false;
      renderShell();
    });
    el("refreshHistory").addEventListener("click", () => vscode.postMessage({ type: "refreshSessions" }));
    el("settingsToggle").addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      renderSettings();
    });
    el("connect").addEventListener("click", () => connectOrTest("connectWithSettings"));
    el("test").addEventListener("click", () => connectOrTest("testWithSettings"));
    el("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    el("openOutput").addEventListener("click", () => vscode.postMessage({ type: "openOutput" }));
    el("newSession").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    el("composerStatusToggle").addEventListener("click", toggleComposerPanel);
    el("panelStatusPill").addEventListener("click", toggleComposerPanel);
    bindComposerStatusPill("contextStatusPill", "context", false);
    bindComposerStatusPill("indexStatusPill", "index", true);
    bindComposerStatusPill("guardStatusPill", "guard", false);
    bindComposerStatusPill("usageStatusPill", "usage", true);
    el("composerStatusPopover").addEventListener("click", onComposerStatusPopoverClick);
    el("composerStatusPopover").addEventListener("mouseenter", cancelComposerHoverClose);
    el("composerStatusPopover").addEventListener("mouseleave", () => scheduleComposerHoverClose());
    el("refreshModels").addEventListener("click", () => vscode.postMessage({ type: "refreshModels" }));
    el("modelSelect").addEventListener("change", onModelSelect);
    el("modelTrigger").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleModelMenu();
    });
    el("modelTrigger").addEventListener("keydown", (event) => onPopupMenuKeydown(event, "model"));
    el("agentTrigger").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAgentMenu();
    });
    el("agentTrigger").addEventListener("keydown", (event) => onPopupMenuKeydown(event, "agent"));
    el("modelMenu").addEventListener("click", (event) => event.stopPropagation());
    el("agentMenu").addEventListener("click", (event) => event.stopPropagation());
    el("modelMenu").addEventListener("keydown", (event) => onPopupMenuKeydown(event, "model"));
    el("agentMenu").addEventListener("keydown", (event) => onPopupMenuKeydown(event, "agent"));
    window.addEventListener("click", () => {
      const hadModelMenu = modelMenuOpen;
      const hadAgentMenu = agentMenuOpen;
      const hadStatusPopover = Boolean(activeComposerStatusPopover());
      modelMenuOpen = false;
      agentMenuOpen = false;
      closeComposerStatusPopoverState();
      if (hadModelMenu) {
        renderModelMenu();
        renderModelTrigger();
      }
      if (hadAgentMenu) {
        renderAgentMenu();
        renderAgentTrigger();
      }
      if (hadStatusPopover) renderComposerStatusBar();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const hadPopup = modelMenuOpen || agentMenuOpen || Boolean(activeComposerStatusPopover()) || el("suggestions").classList.contains("open");
      if (!hadPopup) return;
      event.preventDefault();
      modelMenuOpen = false;
      agentMenuOpen = false;
      closeComposerStatusPopoverState();
      mentionResults = [];
      mentionStatus = "";
      mentionError = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderModelMenu();
      renderModelTrigger();
      renderAgentMenu();
      renderAgentTrigger();
      renderSuggestions();
      renderComposerStatusBar();
    });
    el("saveManualModel").addEventListener("click", saveManualModel);
    el("manualModel").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveManualModel();
      }
    });
    el("codeIntelligence").addEventListener("click", onCodeIntelligenceAction);
    el("exportMarkdown").addEventListener("click", () => vscode.postMessage({ type: "exportMarkdown", scope: "session" }));
    el("attach").addEventListener("click", () => vscode.postMessage({ type: "addFile" }));
    el("send").addEventListener("click", send);
    el("input").addEventListener("input", onComposerInput);
    el("input").addEventListener("keydown", onComposerKeydown);
    el("sel").addEventListener("change", renderMentionChips);
    el("file").addEventListener("change", renderMentionChips);

    window.addEventListener("message", (event) => {
      if (event.data.type === "state") {
        state = event.data.state;
        pendingAction = "";
        if (state.connectionState === "connected") settingsOpen = false;
        render();
        return;
      }
      if (event.data.type === "mentionResults") {
        if (event.data.requestId && event.data.requestId !== activeMentionRequestId) return;
        mentionResults = event.data.files || [];
        mentionStatus = "";
        mentionTruncated = Boolean(event.data.truncated);
        mentionError = event.data.error || "";
        mentionSearched = true;
        activeSuggestion = 0;
        renderSuggestions();
        return;
      }
      if (event.data.type === "mentionStatus") {
        if (event.data.requestId && event.data.requestId !== activeMentionRequestId) return;
        mentionStatus = event.data.status || "";
        mentionError = "";
        renderSuggestions();
        return;
      }
      if (event.data.type === "exportStatus") {
        setNotice(event.data.message || "");
      }
    });

    function connectOrTest(type) {
      pendingAction = type === "testWithSettings" ? "test" : "connect";
      renderConnectionButtons();
      vscode.postMessage({
        type,
        serverUrl: el("serverUrl").value,
        username: el("username").value,
        password: el("password").value
      });
    }

    function toggleComposerPanel() {
      composerCollapsed = !composerCollapsed;
      if (composerCollapsed) {
        closeComposerPopups();
      } else {
        requestAnimationFrame(() => el("input").focus());
      }
      renderComposerStatusBar();
    }

    function closeComposerPopups() {
      modelMenuOpen = false;
      agentMenuOpen = false;
      mentionResults = [];
      mentionStatus = "";
      mentionError = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderModelMenu();
      renderModelTrigger();
      renderAgentMenu();
      renderAgentTrigger();
      renderSuggestions();
    }

    function onModelSelect() {
      selectModelValue(el("modelSelect").value);
    }

    function selectModelValue(value) {
      if (value === "__manual") {
        modelMenuOpen = false;
        renderModelMenu();
        renderModelTrigger();
        el("manualModelRow").className = "manualModel open";
        el("manualModel").value = state.selectedModel || "";
        el("manualModel").focus();
        return;
      }
      el("manualModelRow").className = "manualModel";
      modelMenuOpen = false;
      renderModelMenu();
      renderModelTrigger();
      vscode.postMessage({ type: "selectModel", model: value });
    }

    function saveManualModel() {
      const value = el("manualModel").value.trim();
      vscode.postMessage({ type: "selectModel", model: value });
      el("manualModelRow").className = "manualModel";
      modelMenuOpen = false;
      renderModelMenu();
      renderModelTrigger();
    }

    function send() {
      let text = el("input").value.trim();
      if (!text && mentionedFiles.length > 0) {
        text = "Please review the referenced files.";
      }
      if (!text) {
        setNotice("Type a message or attach a file with @.");
        el("input").focus();
        return;
      }
      if (localOnlyAgentBlocked() && !looksLikeExportRequest(text)) {
        setNotice(state.localOnlyWarning || "Required VS Code local agent is unavailable.");
        return;
      }
      vscode.postMessage({
        type: "sendMessage",
        text,
        mentionedFiles,
        options: {
          includeSelection: el("sel").checked,
          includeCurrentFile: el("file").checked,
          includeOpenFiles: false,
          includeDiagnostics: el("diag").checked,
          includeGitDiff: el("diff").checked
        }
      });
      el("input").value = "";
      mentionedFiles = [];
      mentionResults = [];
      renderMentionChips();
      renderSuggestions();
      renderSendButton();
      setNotice("");
    }

    function looksLikeExportRequest(text) {
      return /(^\\/export\\b|导出|保存|另存|存成|下载|markdown|\\.md\\b|\\bmd\\b|\\bexport\\b|\\bsave\\b|\\bdownload\\b)/i.test(text.trim());
    }

    function onComposerKeydown(event) {
      const suggestionsOpen = el("suggestions").classList.contains("open");
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        send();
        return;
      }
      if (!suggestionsOpen) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeSuggestion = Math.min(activeSuggestion + 1, Math.max(mentionResults.length - 1, 0));
        renderSuggestions();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeSuggestion = Math.max(activeSuggestion - 1, 0);
        renderSuggestions();
      } else if (event.key === "Enter" || event.key === "Tab") {
        if (mentionResults[activeSuggestion]) {
          event.preventDefault();
          selectMention(mentionResults[activeSuggestion]);
        }
      } else if (event.key === "Escape") {
        mentionResults = [];
        mentionStatus = "";
        mentionSearched = false;
        renderSuggestions();
      }
    }

    function onComposerInput() {
      renderSendButton();
      const mention = currentMention();
      if (!mention) {
        mentionResults = [];
        mentionStatus = "";
        mentionTruncated = false;
        mentionError = "";
        mentionSearched = false;
        renderSuggestions();
        return;
      }
      clearTimeout(searchTimer);
      const requestId = ++mentionRequestId;
      activeMentionRequestId = requestId;
      mentionStatus = "searching";
      mentionError = "";
      mentionSearched = false;
      renderSuggestions();
      searchTimer = setTimeout(() => {
        vscode.postMessage({ type: "searchFilesForMention", query: mention.query, requestId });
      }, 120);
    }

    function currentMention() {
      const input = el("input");
      const before = input.value.slice(0, input.selectionStart);
      const match = /(^|\\s)@([^\\s@]*)$/.exec(before);
      if (!match) return undefined;
      return {
        query: match[2],
        start: before.length - match[2].length - 1,
        end: input.selectionStart
      };
    }

    function selectMention(file) {
      const input = el("input");
      const mention = currentMention();
      if (file.type === "folder") {
        if (mention) {
          input.value = input.value.slice(0, mention.start) + "@" + file.insertText + input.value.slice(mention.end);
          const cursor = mention.start + file.insertText.length + 1;
          input.setSelectionRange(cursor, cursor);
        }
        mentionResults = [];
        renderSuggestions();
        input.focus();
        onComposerInput();
        return;
      }
      if (!mentionedFiles.some((item) => item.uri === file.uri)) mentionedFiles.push(file);
      if (mention) {
        const insertText = file.insertText || file.label;
        input.value = input.value.slice(0, mention.start) + "@" + insertText + " " + input.value.slice(mention.end);
        const cursor = mention.start + insertText.length + 2;
        input.setSelectionRange(cursor, cursor);
      }
      mentionResults = [];
      mentionStatus = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderMentionChips();
      renderSuggestions();
      input.focus();
    }

    function removeMention(uri) {
      mentionedFiles = mentionedFiles.filter((file) => file.uri !== uri);
      renderMentionChips();
    }

    function render() {
      renderShell();
      renderConnection();
      renderSettings();
      renderSessions();
      renderMessages();
      renderCodeIntelligence();
      renderModelSelector();
      renderAgentSelector();
      renderConnectionButtons();
      el("diag").checked = Boolean(state.defaults && state.defaults.includeDiagnostics);
      el("diff").checked = Boolean(state.defaults && state.defaults.includeGitDiff);
      renderSendButton();
      renderComposerStatusBar();
    }

    function renderSendButton() {
      const blockedByGuard = localOnlyAgentBlocked() && !looksLikeExportRequest(el("input").value);
      el("send").disabled = Boolean(state.sending || blockedByGuard);
      el("send").textContent = state.sending ? "..." : "Send";
    }

    function renderShell() {
      const widthClass = window.innerWidth >= 760 ? "history-wide" : "history-narrow";
      el("app").className = "app " + (historyOpen ? "history-open" : "history-closed") + " " + widthClass;
    }

    function renderConnection() {
      const stateName = state.connectionState || "disconnected";
      const dot = el("statusDot");
      dot.className = "dot " + stateName;
      const statusText = state.serverUrl ? stateName + " - " + state.serverUrl : stateName;
      el("server").textContent = statusText;
      el("server").title = statusText;
      if (!userEditedConnection) {
        el("serverUrl").value = state.serverUrl || "";
        el("username").value = state.username || "";
      }
      if (stateName === "connected") {
        userEditedConnection = false;
        el("password").value = "";
      }
      const detail = el("connectionDetail");
      detail.className = "detail " + stateName + (state.connectionDetail ? " visible" : "");
      detail.textContent = state.connectionDetail || "";
    }

    function renderSettings() {
      el("settings").className = "settings " + (settingsOpen || state.connectionState !== "connected" ? "open" : "");
    }

    function renderConnectionButtons() {
      const pending = Boolean(pendingAction) || state.connectionState === "connecting";
      const connectPending = pendingAction === "connect" || (!pendingAction && state.connectionState === "connecting");
      const testPending = pendingAction === "test";
      el("connect").disabled = pending;
      el("test").disabled = pending;
      el("connect").textContent = connectPending ? "Connecting..." : "Connect";
      el("test").textContent = testPending ? "Testing..." : "Test";
    }

    function renderComposerStatusBar() {
      const wrap = document.querySelector(".composerWrap");
      const panel = el("composerPanel");
      const toggle = el("composerStatusToggle");
      const toggleFull = el("composerToggleFull");
      const toggleShort = el("composerToggleShort");
      const toggleLabel = composerCollapsed ? "Show input" : "Hide input";
      const toggleShortLabel = composerCollapsed ? "Show" : "Hide";
      wrap.className = "composerWrap" + (composerCollapsed ? " collapsed" : "");
      panel.hidden = composerCollapsed;
      toggle.className = "composerStatusToggle" + (composerCollapsed ? " collapsed" : " expanded");
      toggle.setAttribute("aria-expanded", composerCollapsed ? "false" : "true");
      toggle.setAttribute("aria-label", composerCollapsed ? "Show input and context panel" : "Hide input and context panel");
      toggle.title = composerCollapsed ? "Show input and context panel" : "Hide input and context panel";
      toggleFull.textContent = toggleLabel;
      toggleShort.textContent = toggleShortLabel;

      updateStatusPill(el("panelStatusPill"), {
        text: "Panel",
        title: composerCollapsed ? "Input panel hidden. Click Show input to expand." : "Input panel visible. Click Hide input to collapse.",
        className: "composerStatusPill panel" + (composerCollapsed ? " collapsed" : " open"),
      });
      const context = composerContextStatus();
      updateStatusPill(el("contextStatusPill"), context);
      const index = composerIndexStatus();
      updateStatusPill(el("indexStatusPill"), index);
      const guard = composerGuardStatus();
      updateStatusPill(el("guardStatusPill"), guard);
      const usage = composerUsageStatus();
      updateStatusPill(el("usageStatusPill"), usage);
      renderComposerStatusPopover();
    }

    function updateStatusPill(node, input) {
      const activePopover = activeComposerStatusPopover();
      node.className = input.className + (input.ring ? " compactRing" : "") + (activePopover === input.popover ? " open" : "");
      node.title = input.title || input.text;
      node.setAttribute("aria-label", input.ariaLabel || input.title || input.text);
      node.style.removeProperty("--ring-progress");
      const label = node.querySelector(".pillText") || node;
      if (input.ring) {
        label.className = "pillText statusRing" + (input.ring.indeterminate ? " indeterminate" : "");
        label.setAttribute("aria-hidden", "true");
        label.textContent = "";
        if (typeof input.ring.progress === "number") node.style.setProperty("--ring-progress", formatRingProgress(input.ring.progress));
        return;
      }
      label.className = "pillText";
      label.removeAttribute("aria-hidden");
      label.textContent = input.text;
    }

    function bindComposerStatusPill(id, name, hover) {
      const node = el(id);
      node.addEventListener("click", (event) => toggleComposerStatusPopover(event, name));
      if (!hover) return;
      node.addEventListener("mouseenter", () => showComposerHoverPopover(name));
      node.addEventListener("mouseleave", () => scheduleComposerHoverClose(name));
      node.addEventListener("focus", () => showComposerHoverPopover(name));
      node.addEventListener("blur", () => scheduleComposerHoverClose(name));
    }

    function toggleComposerStatusPopover(event, name) {
      event.stopPropagation();
      cancelComposerHoverClose();
      composerPinnedStatusPopover = composerPinnedStatusPopover === name ? "" : name;
      composerHoverStatusPopover = "";
      closeComposerPopups();
      renderComposerStatusBar();
    }

    function renderComposerStatusPopover() {
      const root = el("composerStatusPopover");
      const activePopover = activeComposerStatusPopover();
      root.textContent = "";
      root.className = "composerStatusPopover" + (activePopover ? " open" : "");
      root.setAttribute("aria-hidden", activePopover ? "false" : "true");
      if (!activePopover) return;
      if (activePopover === "context") renderContextStatusPopover(root);
      if (activePopover === "index") renderIndexStatusPopover(root);
      if (activePopover === "guard") renderGuardStatusPopover(root);
      if (activePopover === "usage") renderUsageStatusPopover(root);
    }

    function activeComposerStatusPopover() {
      return composerPinnedStatusPopover || composerHoverStatusPopover;
    }

    function showComposerHoverPopover(name) {
      if (composerPinnedStatusPopover) return;
      cancelComposerHoverClose();
      if (composerHoverStatusPopover === name) return;
      composerHoverStatusPopover = name;
      renderComposerStatusBar();
    }

    function scheduleComposerHoverClose(name) {
      if (composerPinnedStatusPopover) return;
      cancelComposerHoverClose();
      composerHoverCloseTimer = window.setTimeout(() => {
        if (composerPinnedStatusPopover) return;
        if (name && composerHoverStatusPopover !== name) return;
        const popover = el("composerStatusPopover");
        const active = document.activeElement;
        const activeStatusPill = active && active.closest && active.closest("#indexStatusPill, #usageStatusPill");
        if (popover.matches(":hover") || popover.matches(":focus-within") || activeStatusPill) return;
        composerHoverStatusPopover = "";
        renderComposerStatusBar();
      }, 160);
    }

    function cancelComposerHoverClose() {
      if (!composerHoverCloseTimer) return;
      window.clearTimeout(composerHoverCloseTimer);
      composerHoverCloseTimer = 0;
    }

    function closeComposerStatusPopoverState() {
      cancelComposerHoverClose();
      composerPinnedStatusPopover = "";
      composerHoverStatusPopover = "";
    }

    function composerContextStatus() {
      const count = composerContextCount();
      return {
        text: "Ctx " + count,
        title: contextStatusDetail(),
        className: "composerStatusPill context",
        popover: "context",
      };
    }

    function composerContextCount() {
      let count = mentionedFiles.length + (state.contextFiles || []).length;
      if (el("file").checked && state.autoContext && state.autoContext.currentFile) count += 1;
      return count;
    }

    function composerIndexStatus() {
      const graph = state.codeGraph || {};
      const stateName = graph.state || "disabled";
      const view = codeGraphStatusView(graph, stateName);
      const title = codeGraphTitle(graph, view.label);
      return {
        text: view.shortLabel,
        title,
        className: "composerStatusPill index " + view.kind,
        popover: "index",
        ariaLabel: "Index status: " + view.shortLabel + ". " + title,
        ring: indexStatusRing(graph, stateName, view.kind),
      };
    }

    function codeGraphStatusView(graph, stateName) {
      let kind = "info";
      let shortLabel = "Off";
      if (state.codeGraphWaitDetail) {
        return { kind: "indexing", shortLabel: "Indexing", label: "Waiting for code graph indexing" };
      }
      if (stateName === "ready") {
        kind = "ready";
        shortLabel = "Indexed";
      } else if (stateName === "indexing" || stateName === "indexingFull" || stateName === "indexingIncremental" || stateName === "recovering" || stateName === "rescanScheduled") {
        kind = "indexing";
        shortLabel = "Indexing";
      } else if (stateName === "paused") {
        kind = "warning";
        shortLabel = "Paused";
      } else if (stateName === "stale" || stateName === "degraded") {
        kind = "warning";
        shortLabel = "Index stale";
      } else if (stateName === "error") {
        kind = "error";
        shortLabel = "Index error";
      }
      return { kind, shortLabel, label: codeGraphView(graph, stateName).label };
    }

    function composerGuardStatus() {
      const detail = guardStatusDetail();
      if (state.localOnlyWarning || localOnlyAgentBlocked()) {
        return {
          text: "Guard warn",
          title: detail,
          className: "composerStatusPill guard warning",
          popover: "guard",
        };
      }
      if (state.localOnlyMode === false) {
        return {
          text: "Guard off",
          title: detail,
          className: "composerStatusPill guard off",
          popover: "guard",
        };
      }
      return {
        text: "Guard ok",
        title: detail,
        className: "composerStatusPill guard ok",
        popover: "guard",
      };
    }

    function composerUsageStatus() {
      if (state.connectionState !== "connected") {
        return {
          text: "Usage",
          title: "Connect to load usage.",
          className: "composerStatusPill usage pending",
          popover: "usage",
          ariaLabel: "Context usage: connect to load usage.",
          ring: { progress: 0 },
        };
      }
      const usage = state.usage || {};
      const level = usage.level || "normal";
      const status = usage.status || "pending";
      const kind = level === "warning" || level === "error" ? level : status === "pending" ? "pending" : "normal";
      const title = usage.detail || usage.summary || "Usage pending";
      return {
        text: usage.summary || "Usage pending",
        title,
        className: "composerStatusPill usage " + kind,
        popover: "usage",
        ariaLabel: "Context usage: " + title,
        ring: { progress: contextUsageRatio(usage) ?? 0 },
      };
    }

    function indexStatusRing(graph, stateName, kind) {
      if (kind === "indexing") {
        const progress = progressRatio(graph.progress);
        return progress === undefined ? { indeterminate: true } : { progress };
      }
      if (stateName === "ready") return { progress: 1 };
      if (kind === "warning" || kind === "error") return { progress: progressRatio(graph.progress) ?? 1 };
      return { progress: 0 };
    }

    function contextUsageRatio(usage) {
      const ratio = usage && usage.context && usage.context.ratio;
      return typeof ratio === "number" && Number.isFinite(ratio) ? clamp01(ratio) : undefined;
    }

    function progressRatio(progress) {
      if (!progress || !progress.total) return undefined;
      return clamp01(Number(progress.completed || 0) / Number(progress.total));
    }

    function clamp01(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1, value));
    }

    function formatRingProgress(value) {
      return (Math.round(clamp01(value) * 1000) / 10) + "%";
    }

    function composerIndexSummary() {
      const graph = state.codeGraph || {};
      const stateName = graph.state || "disabled";
      if (state.codeGraphWaitDetail) return "Indexing";
      if (stateName === "ready") return "Indexed";
      if (stateName === "indexing" || stateName === "indexingFull" || stateName === "indexingIncremental" || stateName === "recovering" || stateName === "rescanScheduled") {
        return "Indexing";
      }
      if (stateName === "paused") return "Paused";
      if (stateName === "stale" || stateName === "degraded") return "Index stale";
      if (stateName === "error") return "Index error";
      return "Off";
    }

    function composerGuardSummary() {
      if (state.localOnlyWarning || localOnlyAgentBlocked()) return "Guard warning";
      return state.localOnlyMode === false ? "Guard off" : "Guard ok";
    }

    function contextStatusDetail() {
      const lines = [];
      const auto = state.autoContext || {};
      if (el("file").checked) {
        lines.push(auto.currentFile ? "Auto: " + ((el("sel").checked && auto.hasSelection ? "Selection: " : "Current: ") + auto.currentFile) : "Auto: no current file captured");
      }
      for (const file of mentionedFiles) lines.push("@ " + file.label);
      for (const label of state.contextFiles || []) lines.push("Attached: " + label);
      return lines.length > 0 ? lines.join(" | ") : "No local context selected.";
    }

    function guardStatusDetail() {
      if (!state.localOnlyMode) return "Local-only guard is off.";
      const agent = state.selectedAgent ? " VS Code agent: " + state.selectedAgent + "." : " VS Code agent unavailable.";
      const model = state.selectedModel ? " Model: " + state.selectedModel + "." : " Model: server default.";
      const sent = (state.lastContextSummary || []).filter((item) => !item.skipped).map((item) => item.path).slice(0, 4);
      const sentText = sent.length > 0 ? " Last sent: " + sent.join(", ") + "." : " Selected context will be sent with the next prompt.";
      return state.localOnlyWarning || "Local-only guard active." + agent + model + sentText;
    }

    function renderContextStatusPopover(root) {
      appendStatusPopoverHeader(root, "Context", contextStatusDetail());
      const rows = statusRows();
      const auto = state.autoContext || {};
      if (el("file").checked) {
        appendStatusRow(rows, auto.currentFile ? ((el("sel").checked && auto.hasSelection ? "Selection: " : "Current: ") + auto.currentFile) : "No current file captured");
      }
      for (const file of mentionedFiles) {
        const row = appendStatusRow(rows, "@" + file.label);
        const remove = document.createElement("button");
        remove.className = "contextRemoveButton";
        remove.type = "button";
        remove.textContent = "Remove";
        remove.title = "Remove " + file.label;
        remove.setAttribute("data-remove-mention", file.uri);
        row.appendChild(remove);
      }
      for (const label of state.contextFiles || []) appendStatusRow(rows, "Attached: " + label);
      if (!rows.childElementCount) appendStatusRow(rows, "No local context selected.");
      root.appendChild(rows);
    }

    function renderIndexStatusPopover(root) {
      const graph = state.codeGraph || { state: "disabled", detail: "Local code graph is disabled.", indexedFiles: 0, indexedFunctions: 0, indexedMacros: 0, truncated: false };
      const stateName = graph.state || "disabled";
      let view = codeGraphView(graph, stateName);
      if (state.codeGraphWaitDetail) {
        view = {
          ...view,
          label: "Waiting for code graph indexing",
          meta: state.codeGraphWaitDetail
        };
      }
      appendStatusPopoverHeader(root, view.label, view.meta || codeGraphTitle(graph, view.label));
      const actions = document.createElement("div");
      actions.className = "statusPopoverActions";
      for (const action of view.actions) {
        const button = document.createElement("button");
        button.className = "statusActionButton" + (action.message === "refreshCodeIntelligence" ? " primary" : "");
        button.type = "button";
        button.textContent = action.label;
        button.title = action.title || action.label;
        button.disabled = Boolean(action.disabled);
        if (action.message) button.setAttribute("data-code-graph-action", action.message);
        actions.appendChild(button);
      }
      if (actions.childElementCount) root.appendChild(actions);
    }

    function renderGuardStatusPopover(root) {
      appendStatusPopoverHeader(root, composerGuardSummary(), guardStatusDetail());
    }

    function renderUsageStatusPopover(root) {
      const usage = state.usage || {};
      appendStatusPopoverHeader(root, usage.summary || "Usage pending", usage.detail || "Connect to load token usage.");
    }

    function appendStatusPopoverHeader(root, title, meta) {
      const header = document.createElement("div");
      header.className = "statusPopoverHeader";
      const label = document.createElement("div");
      label.textContent = title;
      header.appendChild(label);
      root.appendChild(header);
      const detail = document.createElement("div");
      detail.className = "statusPopoverMeta";
      detail.textContent = meta || title;
      root.appendChild(detail);
    }

    function statusRows() {
      const rows = document.createElement("div");
      rows.className = "statusPopoverRows";
      return rows;
    }

    function appendStatusRow(root, text) {
      const row = document.createElement("div");
      row.className = "statusPopoverRow";
      const label = document.createElement("span");
      label.className = "statusPopoverLabel";
      label.textContent = text;
      row.appendChild(label);
      root.appendChild(row);
      return row;
    }

    function onComposerStatusPopoverClick(event) {
      event.stopPropagation();
      const target = event.target;
      const remove = target.closest("[data-remove-mention]");
      if (remove) {
        removeMention(remove.getAttribute("data-remove-mention") || "");
        return;
      }
      onCodeGraphAction(event);
    }

    function renderSessions() {
      const root = el("sessionList");
      root.innerHTML = "";
      const sessions = state.sessions || [];
      if (state.historyError) {
        const error = document.createElement("div");
        error.className = "sessionEmpty";
        error.textContent = state.historyError;
        root.appendChild(error);
      }
      if (sessions.length === 0) {
        if (state.historyError) return;
        const empty = document.createElement("div");
        empty.className = "sessionEmpty";
        empty.textContent = state.connectionState === "connected" ? "No remote sessions yet." : "Connect to load chat history.";
        root.appendChild(empty);
        return;
      }
      for (const session of sessions) {
        const row = document.createElement("button");
        row.className = "sessionRow " + (session.id === state.currentSessionID ? "active" : "");
        row.title = session.title || "Untitled chat";
        const name = document.createElement("div");
        name.className = "sessionName";
        name.textContent = session.title || "Untitled chat";
        if (session.serverToolsUsed) {
          const badge = document.createElement("span");
          badge.className = "sessionBadge";
          badge.textContent = " Server tools used";
          name.appendChild(badge);
        }
        const time = document.createElement("div");
        time.className = "sessionTime";
        time.textContent = formatTime(session.updated || session.created);
        row.append(name, time);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "selectSession", sessionID: session.id });
          if (window.innerWidth < 760) {
            historyTouched = true;
            historyOpen = false;
            renderShell();
          }
        });
        root.appendChild(row);
      }
    }

    function renderMessages() {
      const root = el("messages");
      const stick = userNearBottom || Boolean(state.sending);
      root.innerHTML = "";
      const messages = state.messages || [];
      if (state.loadingMessages && messages.length === 0) {
        const loading = document.createElement("div");
        loading.className = "loadingLine";
        loading.textContent = "Loading messages...";
        root.appendChild(loading);
      } else if (messages.length === 0) {
        root.appendChild(emptyState());
      } else {
        for (let index = 0; index < messages.length; index += 1) root.appendChild(messageNode(messages[index], index));
      }
      if (state.sending && !hasAssistantContentAfterLastUser(messages)) root.appendChild(thinkingNode());
      if (stick) requestAnimationFrame(() => {
        root.scrollTop = root.scrollHeight;
        userNearBottom = true;
      });
    }

    function hasAssistantContentAfterLastUser(messages) {
      let hasAssistantContent = false;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (item.role === "user") return hasAssistantContent;
        if ((item.role === "assistant" || item.role === "tool") && messageHasContent(item)) {
          hasAssistantContent = true;
        }
      }
      return hasAssistantContent;
    }

    function messageHasContent(item) {
      if (item.text) return true;
      return (item.parts || []).some((part) => part.text || part.detail || part.status);
    }

    function emptyState() {
      const node = document.createElement("div");
      node.className = "empty";
      const title = document.createElement("div");
      title.className = "emptyTitle";
      title.textContent = state.connectionState === "connected" ? "Start a focused code conversation" : "Connect OpenCode to start";
      const copy = document.createElement("div");
      copy.textContent = "Use @ to reference files, attach context, then ask OpenCode to explain, refactor, or complete code.";
      node.append(title, copy);
      const prompts = document.createElement("div");
      prompts.className = "emptyPrompts";
      for (const label of ["Explain current file", "Refactor safely", "Review changes"]) {
        const prompt = document.createElement("span");
        prompt.className = "emptyPrompt";
        prompt.textContent = label;
        prompts.appendChild(prompt);
      }
      node.appendChild(prompts);
      const sessions = (state.sessions || []).slice(0, 3);
      if (sessions.length > 0) {
        const recent = document.createElement("div");
        recent.className = "recentSessions";
        for (const session of sessions) {
          const button = document.createElement("button");
          button.textContent = session.title || "Untitled chat";
          button.addEventListener("click", () => vscode.postMessage({ type: "selectSession", sessionID: session.id }));
          recent.appendChild(button);
        }
        node.appendChild(recent);
      }
      return node;
    }

    function messageNode(item, index) {
      const messageKey = stableMessageKey(item, index);
      const bodyId = "message-body-" + domSafeId(messageKey);
      const node = document.createElement("article");
      node.className = "timelineItem " + (item.role || "message");
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = avatarText(item.role);
      const card = document.createElement("div");
      card.setAttribute("data-message-key", messageKey);
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      const role = document.createElement("span");
      role.textContent = roleLabel(item.role);
      const time = document.createElement("span");
      time.className = "messageTime";
      time.textContent = formatTime(item.timeCreated);
      const stats = document.createElement("span");
      stats.className = "messageStats";
      if (item.usage && item.usage.summary) {
        const usage = document.createElement("span");
        usage.className = "messageUsage";
        usage.textContent = item.usage.summary;
        usage.title = item.usage.detail || item.usage.summary;
        stats.appendChild(usage);
      }
      const body = document.createElement("div");
      body.className = "messageBody";
      body.id = bodyId;
      if (item.text) renderMarkdownInto(body, item.text);
      renderPartCards(body, item);
      const structureTargets = messageStructureTargets(body);
      const isLarge = isLargeMessage(item, body, structureTargets);
      const isCollapsed = collapsedMessages.has(messageKey);
      const isExpandedLong = expandedLongMessages.has(messageKey);
      card.className = "messageCard"
        + (isCollapsed ? " messageCollapsed" : "")
        + (isLarge ? " longAnswer" : "")
        + (isLarge && isExpandedLong ? " longExpanded" : "");
      const actions = messageActions(item, messageKey, bodyId, {
        hasStructureTargets: structureTargets.length > 0,
        isCollapsed,
        isLarge,
        isExpandedLong
      });
      if (actions.childElementCount) stats.appendChild(actions);
      stats.appendChild(time);
      meta.append(role, stats);
      card.appendChild(meta);
      const outline = messageOutline(body, messageKey);
      if (outline) card.appendChild(outline);
      card.appendChild(body);
      if (isLarge) {
        const hint = document.createElement("div");
        hint.className = "messageLongHint";
        hint.textContent = "Long answer limited for performance. Use Full to expand.";
        card.appendChild(hint);
      }
      node.append(avatar, card);
      return node;
    }

    function stableMessageKey(item, index) {
      return String(item.id || ((item.role || "message") + "-" + (item.timeCreated || index) + "-" + index));
    }

    function domSafeId(value) {
      return String(value || "message").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "message";
    }

    function messageActions(item, messageKey, bodyId, options) {
      const actions = document.createElement("span");
      actions.className = "messageActions";
      if (item.text) {
        actions.appendChild(messageActionButton("Copy", "Copy answer text", "copyAnswer", (button) => copyTextWithFeedback(markdownToPlainText(item.text), button, "Copied answer.")));
        actions.appendChild(messageActionButton("MD", "Copy answer as Markdown", "copyMarkdown", (button) => copyTextWithFeedback(item.text, button, "Copied Markdown.")));
      }
      if (options.hasStructureTargets) {
        actions.appendChild(messageActionButton("Jump", "Jump to next code or table block", "jumpStructure", () => scrollToNextMessageStructure(messageKey)));
      }
      if (options.isLarge) {
        const label = options.isExpandedLong ? "Limit" : "Full";
        const title = options.isExpandedLong ? "Restore large answer limit" : "Expand full long answer";
        const expandLong = messageActionButton(label, title, "expandLong", () => toggleLongMessage(messageKey));
        expandLong.setAttribute("aria-pressed", options.isExpandedLong ? "true" : "false");
        actions.appendChild(expandLong);
      }
      const collapse = messageActionButton(options.isCollapsed ? "Expand" : "Collapse", options.isCollapsed ? "Expand answer" : "Collapse answer", "collapseMessage", () => toggleMessageCollapse(messageKey));
      collapse.setAttribute("aria-expanded", options.isCollapsed ? "false" : "true");
      collapse.setAttribute("aria-controls", bodyId);
      actions.appendChild(collapse);
      return actions;
    }

    function messageActionButton(label, title, className, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "messageAction " + className;
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick(button);
      });
      return button;
    }

    function toggleMessageCollapse(messageKey) {
      if (collapsedMessages.has(messageKey)) collapsedMessages.delete(messageKey);
      else collapsedMessages.add(messageKey);
      renderMessages();
    }

    function toggleLongMessage(messageKey) {
      if (expandedLongMessages.has(messageKey)) expandedLongMessages.delete(messageKey);
      else expandedLongMessages.add(messageKey);
      renderMessages();
    }

    function messageStructureTargets(root) {
      return Array.from(root.querySelectorAll(".codeBlock, .tableBlock"));
    }

    function isLargeMessage(item, body, structureTargets) {
      if (item.role !== "assistant" && item.role !== "tool") return false;
      const textLength = String(item.text || "").length;
      const blockCount = body.children.length;
      return textLength > 5200 || blockCount > 18 || structureTargets.length > 5;
    }

    function messageOutline(body, messageKey) {
      const headings = Array.from(body.querySelectorAll(".mdHeading"));
      const codeBlocks = Array.from(body.querySelectorAll(".codeBlock"));
      const tables = Array.from(body.querySelectorAll(".tableBlock"));
      const totalStructures = headings.length + codeBlocks.length + tables.length;
      if (totalStructures < 3 && headings.length < 2 && (codeBlocks.length + tables.length) < 2) return undefined;
      const outline = document.createElement("nav");
      outline.className = "messageOutline";
      outline.setAttribute("aria-label", "Answer outline");
      const summary = document.createElement("span");
      summary.className = "messageOutlineSummary";
      summary.textContent = headings.length + " sections / " + codeBlocks.length + " code / " + tables.length + " table";
      outline.appendChild(summary);
      const targets = [];
      for (const heading of headings) targets.push({ label: compactLabel(heading.textContent || "Section"), target: heading });
      for (let index = 0; index < codeBlocks.length; index += 1) targets.push({ label: "Code " + (index + 1), target: codeBlocks[index] });
      for (let index = 0; index < tables.length; index += 1) targets.push({ label: "Table " + (index + 1), target: tables[index] });
      for (const item of targets.slice(0, 8)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "messageOutlineButton";
        button.textContent = item.label;
        button.title = "Jump to " + item.label;
        button.addEventListener("click", () => {
          messageJumpIndex.set(messageKey, 0);
          scrollToMessageTarget(item.target);
        });
        outline.appendChild(button);
      }
      return outline;
    }

    function compactLabel(value) {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      return text.length > 28 ? text.slice(0, 27) + "..." : text || "Section";
    }

    function scrollToNextMessageStructure(messageKey) {
      const body = el("message-body-" + domSafeId(messageKey));
      if (!body) return;
      const targets = messageStructureTargets(body);
      if (!targets.length) {
        setNotice("No code or table block in this message.");
        return;
      }
      const next = (messageJumpIndex.get(messageKey) || 0) % targets.length;
      messageJumpIndex.set(messageKey, next + 1);
      scrollToMessageTarget(targets[next]);
    }

    function scrollToMessageTarget(target) {
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      target.classList.add("structureFlash");
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      window.setTimeout(() => target.classList.remove("structureFlash"), 900);
    }

    function markdownToPlainText(text) {
      return String(text || "")
        .replace(/^\\s*\`\`\`[^\\n]*\\n/gm, "")
        .replace(/^\\s*\`\`\`\\s*$/gm, "")
        .replace(new RegExp(String.fromCharCode(96) + "([^" + String.fromCharCode(96) + "]+)" + String.fromCharCode(96), "g"), "$1")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")
        .replace(/\\*([^*]+)\\*/g, "$1")
        .replace(/^#{1,6}\\s+/gm, "")
        .replace(/^>\\s?/gm, "")
        .trim();
    }

    function thinkingNode() {
      const node = document.createElement("article");
      node.className = "timelineItem assistant thinking";
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "OC";
      const card = document.createElement("div");
      card.className = "messageCard";
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      meta.textContent = "OpenCode";
      const body = document.createElement("div");
      body.className = "messageBody";
      const label = document.createElement("span");
      label.textContent = "Thinking";
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      body.append(label, dots);
      card.append(meta, body);
      node.append(avatar, card);
      return node;
    }

    function renderPartCards(root, item) {
      const parts = item.parts || [];
      for (const part of parts) {
        if (part.type !== "tool" && part.type !== "serverToolWarning" && part.type !== "reasoning") continue;
        const details = document.createElement("details");
        details.className = "toolCard"
          + (part.type === "serverToolWarning" ? " serverWarning" : "")
          + (part.type === "reasoning" ? " reasoning" : "");
        const summary = document.createElement("summary");
        summary.textContent = part.type === "reasoning"
          ? "Thinking"
          : part.type === "serverToolWarning"
            ? "Warning: server filesystem tool used"
            : "Tool: " + (part.title || "tool") + (part.status ? " - " + part.status : "");
        const body = document.createElement("pre");
        body.textContent = part.detail || part.text || "";
        details.append(summary, body);
        root.appendChild(details);
      }
    }

    function renderMarkdownInto(root, text) {
      root.innerHTML = "";
      const lines = String(text || "").split(/\\r?\\n/);
      let textLines = [];
      let codeLines = [];
      let inCode = false;
      let language = "";
      const flushText = () => {
        if (textLines.length === 0) return;
        renderTextMarkdown(root, textLines.join("\\n"));
        textLines = [];
      };
      const flushCode = () => {
        root.appendChild(codeBlock(language, codeLines.join("\\n")));
        codeLines = [];
        language = "";
      };
      for (const line of lines) {
        if (line.startsWith("\`\`\`")) {
          if (inCode) {
            flushCode();
            inCode = false;
          } else {
            flushText();
            inCode = true;
            language = line.slice(3).trim();
          }
          continue;
        }
        if (inCode) codeLines.push(line);
        else textLines.push(line);
      }
      if (inCode) flushCode();
      flushText();
    }

    function renderTextMarkdown(root, text) {
      const lines = String(text || "").split(/\\r?\\n/);
      let paragraph = [];
      let list;
      let listTag = "";
      let quoteLines = [];
      const flushParagraph = () => {
        if (paragraph.length === 0) return;
        const p = document.createElement("p");
        appendInlineMarkdown(p, paragraph.join(" "));
        root.appendChild(p);
        paragraph = [];
      };
      const flushList = () => {
        if (!list) return;
        root.appendChild(list);
        list = undefined;
        listTag = "";
      };
      const flushQuote = () => {
        if (quoteLines.length === 0) return;
        const quote = document.createElement("blockquote");
        quote.className = "mdQuote";
        const p = document.createElement("p");
        appendInlineMarkdown(p, quoteLines.join(" "));
        quote.appendChild(p);
        root.appendChild(quote);
        quoteLines = [];
      };
      const flushBlocks = () => {
        flushParagraph();
        flushList();
        flushQuote();
      };
      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.trim();
        if (!line) {
          flushBlocks();
          continue;
        }
        if (/^(?:-{3,}|\\*{3,}|_{3,})$/.test(line)) {
          flushBlocks();
          const divider = document.createElement("hr");
          divider.className = "mdDivider";
          root.appendChild(divider);
          continue;
        }
        const quote = line.match(/^>\\s?(.*)$/);
        if (quote) {
          flushParagraph();
          flushList();
          quoteLines.push(quote[1]);
          continue;
        }
        const headingMatch = line.match(/^(#{1,3})\\s+(.+)$/);
        if (headingMatch) {
          flushBlocks();
          const heading = document.createElement("div");
          heading.className = "mdHeading mdHeading" + headingMatch[1].length;
          appendInlineMarkdown(heading, headingMatch[2]);
          root.appendChild(heading);
          continue;
        }
        const unordered = line.match(/^[-*+]\\s+(.+)$/);
        const ordered = line.match(/^\\d+[.)]\\s+(.+)$/);
        if (unordered || ordered) {
          flushParagraph();
          flushQuote();
          const tag = ordered ? "ol" : "ul";
          if (!list || listTag !== tag) {
            flushList();
            list = document.createElement(tag);
            list.className = "mdList";
            listTag = tag;
          }
          const item = document.createElement("li");
          appendInlineMarkdown(item, (unordered || ordered)[1]);
          list.appendChild(item);
          continue;
        }
        const table = detectTableBlock(lines, index);
        if (table) {
          flushBlocks();
          root.appendChild(tableBlock(table));
          index = table.end - 1;
          continue;
        }
        flushList();
        flushQuote();
        paragraph.push(line);
      }
      flushBlocks();
    }

    function detectTableBlock(lines, start) {
      return detectMarkdownTable(lines, start)
        || detectDelimitedTable(lines, start, "\t", "tsv")
        || detectDelimitedTable(lines, start, ",", "csv")
        || detectKeyValueBlock(lines, start)
        || detectPlainAlignedTable(lines, start);
    }

    function detectMarkdownTable(lines, start) {
      if (start + 1 >= lines.length) return undefined;
      const header = parseMarkdownTableRow(lines[start]);
      const divider = parseMarkdownTableRow(lines[start + 1]);
      if (header.length < 2 || divider.length !== header.length || !isMarkdownDividerRow(divider)) return undefined;
      const rows = [header];
      let end = start + 2;
      while (end < lines.length && lines[end].trim()) {
        const row = parseMarkdownTableRow(lines[end]);
        if (row.length !== header.length) break;
        rows.push(row);
        end += 1;
      }
      if (rows.length < 2) return undefined;
      return {
        kind: "markdown",
        rows,
        hasHeader: true,
        raw: lines.slice(start, end).join("\\n"),
        end
      };
    }

    function parseMarkdownTableRow(line) {
      let value = String(line || "").trim();
      if (value.indexOf("|") === -1) return [];
      if (value.startsWith("|")) value = value.slice(1);
      if (value.endsWith("|")) value = value.slice(0, -1);
      return splitMarkdownCells(value).map(cleanTableCell);
    }

    function splitMarkdownCells(value) {
      const cells = [];
      let current = "";
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char.charCodeAt(0) === 92 && value[index + 1] === "|") {
          current += "|";
          index += 1;
          continue;
        }
        if (char === "|") {
          cells.push(current);
          current = "";
          continue;
        }
        current += char;
      }
      cells.push(current);
      return cells;
    }

    function isMarkdownDividerRow(cells) {
      return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\\s/g, "")));
    }

    function detectDelimitedTable(lines, start, delimiter, kind) {
      const rows = [];
      let end = start;
      while (end < lines.length && lines[end].trim() && lines[end].indexOf(delimiter) !== -1) {
        const row = parseDelimitedLine(lines[end], delimiter).map(cleanTableCell);
        if (row.length < 2) break;
        rows.push(row);
        end += 1;
      }
      if (!validTableRows(rows)) return undefined;
      if (looksLikeMarkdownListRows(rows) || looksLikeMarkdownLabelRows(rows)) return undefined;
      if (kind === "csv" && !likelyHeaderRow(rows) && rows.length < 3) return undefined;
      return {
        kind,
        rows,
        hasHeader: likelyHeaderRow(rows),
        raw: lines.slice(start, end).join("\\n"),
        end
      };
    }

    function parseDelimitedLine(line, delimiter) {
      const cells = [];
      let current = "";
      let quoted = false;
      const text = String(line || "");
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
          if (char === '"' && text[index + 1] === '"') {
            current += '"';
            index += 1;
          } else if (char === '"') {
            quoted = false;
          } else {
            current += char;
          }
          continue;
        }
        if (char === '"') {
          quoted = true;
          continue;
        }
        if (char === delimiter) {
          cells.push(current);
          current = "";
          continue;
        }
        current += char;
      }
      cells.push(current);
      return cells;
    }

    function detectKeyValueBlock(lines, start) {
      const pairs = [];
      let end = start;
      while (end < lines.length && lines[end].trim()) {
        const pair = parseKeyValueLine(lines[end]);
        if (!pair) break;
        pairs.push(pair);
        end += 1;
      }
      if (pairs.length < 2) return undefined;
      return {
        kind: "keyValue",
        rows: [["Key", "Value"]].concat(pairs),
        hasHeader: true,
        raw: lines.slice(start, end).join("\\n"),
        end
      };
    }

    function parseKeyValueLine(line) {
      const match = String(line || "").trim().match(/^([^:=|]{1,56})\\s*[:=]\\s+(.+)$/);
      if (!match) return undefined;
      const key = cleanTableCell(match[1]);
      const value = cleanTableCell(match[2]);
      if (!key || !value || /^[-*#>]/.test(key) || key.split(/\\s+/).length > 8) return undefined;
      return [key, value];
    }

    function detectPlainAlignedTable(lines, start) {
      const rows = [];
      let end = start;
      while (end < lines.length && lines[end].trim() && /\\S\\s{2,}\\S/.test(lines[end])) {
        const row = lines[end].trim().split(/\\s{2,}/).map(cleanTableCell);
        if (row.length < 2) break;
        rows.push(row);
        end += 1;
      }
      if (!validTableRows(rows)) return undefined;
      if (looksLikeMarkdownListRows(rows) || looksLikeMarkdownLabelRows(rows)) return undefined;
      if (!likelyHeaderRow(rows) && rows.length < 3) return undefined;
      return {
        kind: "aligned",
        rows,
        hasHeader: likelyHeaderRow(rows),
        raw: lines.slice(start, end).join("\\n"),
        end
      };
    }

    function validTableRows(rows) {
      if (rows.length < 2) return false;
      const width = rows[0].length;
      if (width < 2 || width > 12) return false;
      return rows.every((row) => row.length === width && row.some((cell) => cell.trim()));
    }

    function looksLikeMarkdownListRows(rows) {
      return rows.some((row) => isMarkdownListMarkerCell(row[0]));
    }

    function isMarkdownListMarkerCell(value) {
      return /^[-*+]$/.test(value) || /^\\d+[.)]$/.test(value);
    }

    function looksLikeMarkdownLabelRows(rows) {
      return rows.length > 0 && rows.every((row) => isMarkdownLabelCellSafe(row[0]));
    }

    function isMarkdownLabelCellSafe(value) {
      const text = String(value || "").trim();
      const plain = text.replace(/^\\*\\*/, "").replace(/\\*\\*$/, "").trim();
      const colon = String.fromCharCode(0xff1a);
      return plain.length > 1 && plain.length <= 56 && (plain.endsWith(":") || plain.endsWith(colon));
    }

    function isMarkdownLabelCell(value) {
      const text = String(value || "").trim();
      const plain = text.replace(/^\\*\\*/, "").replace(/\\*\\*$/, "").trim();
      return /^.{1,56}[:锛歖]$/.test(plain) || /^\\*\\*.{1,56}[:锛歖]\\*\\*$/.test(text);
    }

    function likelyHeaderRow(rows) {
      if (rows.length < 2) return false;
      const first = rows[0].join(" ");
      const second = rows[1].join(" ");
      return /[A-Za-z_\\u4e00-\\u9fff]/.test(first) && first !== second;
    }

    function cleanTableCell(value) {
      return String(value || "").replace(/^"|"$/g, "").replace(/\\s+/g, " ").trim();
    }

    function tableBlock(tableData) {
      const block = document.createElement("section");
      block.className = "tableBlock " + tableData.kind;
      block.setAttribute("role", "region");
      block.setAttribute("aria-label", tableKindLabel(tableData));
      block.setAttribute("data-table-kind", tableData.kind);
      block.setAttribute("tabindex", "-1");

      const toolbar = document.createElement("div");
      toolbar.className = "tableToolbar";
      const label = document.createElement("span");
      label.className = "tableKind";
      label.textContent = tableKindLabel(tableData) + " - " + tableData.rows.length + " rows";
      const actions = document.createElement("span");
      actions.className = "tableActions";
      const copyMarkdown = tableButton("Copy Markdown", "Copy table as Markdown", "copyTable copyTableMarkdown", () => copyTextWithFeedback(tableToMarkdown(tableData), copyMarkdown, "Copied table Markdown."));
      const copyCsv = tableButton("Copy CSV", "Copy table as CSV", "copyTable copyTableCsv", () => copyTextWithFeedback(tableToCsv(tableData), copyCsv, "Copied table CSV."));
      const raw = tableButton("Raw", "Show raw table text", "toggleTableRaw", () => {
        const isRaw = block.classList.toggle("raw");
        raw.textContent = isRaw ? "Table" : "Raw";
        raw.title = isRaw ? "Show rendered table" : "Show raw table text";
        raw.setAttribute("aria-label", raw.title);
        raw.setAttribute("aria-pressed", isRaw ? "true" : "false");
      });
      raw.setAttribute("aria-pressed", "false");
      actions.append(copyMarkdown, copyCsv, raw);
      toolbar.append(label, actions);

      const scroll = document.createElement("div");
      scroll.className = "tableScroll";
      const table = document.createElement("table");
      table.setAttribute("aria-label", tableKindLabel(tableData));
      renderTableRows(table, tableData);
      scroll.appendChild(table);

      const rawBlock = document.createElement("pre");
      rawBlock.className = "tableRaw";
      rawBlock.setAttribute("aria-label", "Raw table text");
      rawBlock.textContent = tableData.raw || "";

      block.append(toolbar, scroll, rawBlock);
      return block;
    }

    function tableButton(label, title, className, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    }

    function renderTableRows(table, tableData) {
      const rows = normalizedRows(tableData.rows);
      if (!rows.length) return;
      let start = 0;
      if (tableData.hasHeader) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const cell of rows[0]) {
          const th = document.createElement("th");
          appendInlineMarkdown(th, cell);
          tr.appendChild(th);
        }
        thead.appendChild(tr);
        table.appendChild(thead);
        start = 1;
      }
      const tbody = document.createElement("tbody");
      for (let rowIndex = start; rowIndex < rows.length; rowIndex += 1) {
        const tr = document.createElement("tr");
        for (const cell of rows[rowIndex]) {
          const td = document.createElement("td");
          appendInlineMarkdown(td, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    function normalizedRows(rows) {
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
      return rows.map((row) => {
        const next = row.slice();
        while (next.length < width) next.push("");
        return next;
      });
    }

    function tableKindLabel(tableData) {
      if (tableData.kind === "markdown") return "Markdown table";
      if (tableData.kind === "csv") return "CSV table";
      if (tableData.kind === "tsv") return "TSV table";
      if (tableData.kind === "keyValue") return "Key-value table";
      return "Aligned table";
    }

    function tableToMarkdown(tableData) {
      const rows = normalizedRows(tableData.rows);
      if (!rows.length) return "";
      const width = rows[0].length;
      const header = tableData.hasHeader ? rows[0] : generatedHeaders(width);
      const bodyRows = tableData.hasHeader ? rows.slice(1) : rows;
      const lines = [];
      lines.push("| " + header.map(escapeMarkdownTableCell).join(" | ") + " |");
      lines.push("| " + header.map(() => "---").join(" | ") + " |");
      for (const row of bodyRows) lines.push("| " + row.map(escapeMarkdownTableCell).join(" | ") + " |");
      return lines.join("\\n");
    }

    function generatedHeaders(width) {
      const headers = [];
      for (let index = 0; index < width; index += 1) headers.push("Column " + (index + 1));
      return headers;
    }

    function escapeMarkdownTableCell(value) {
      return String(value || "").split("|").join(String.fromCharCode(92) + "|").replace(/\\r?\\n/g, " ").trim();
    }

    function tableToCsv(tableData) {
      return normalizedRows(tableData.rows).map((row) => row.map(escapeCsvCell).join(",")).join("\\n");
    }

    function escapeCsvCell(value) {
      const text = String(value || "");
      if (/[",\\r\\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
      return text;
    }

    function appendInlineMarkdown(root, text) {
      const value = String(text || "");
      let index = 0;
      while (index < value.length) {
        const marker = nextInlineMarker(value, index);
        if (!marker) {
          appendText(root, value.slice(index));
          break;
        }
        if (marker.index > index) appendText(root, value.slice(index, marker.index));
        if (marker.type === "code") {
          const end = value.indexOf("\`", marker.index + 1);
          if (end === -1) {
            appendText(root, value.slice(marker.index));
            break;
          }
          const code = document.createElement("code");
          code.className = "inlineCode";
          code.textContent = value.slice(marker.index + 1, end);
          root.appendChild(code);
          index = end + 1;
          continue;
        }
        if (marker.type === "strong") {
          const end = value.indexOf("**", marker.index + 2);
          if (end === -1) {
            appendText(root, value.slice(marker.index));
            break;
          }
          const strong = document.createElement("strong");
          strong.className = "mdStrong";
          appendInlineMarkdown(strong, value.slice(marker.index + 2, end));
          root.appendChild(strong);
          index = end + 2;
          continue;
        }
        const end = findSingleStar(value, marker.index + 1);
        if (end === -1) {
          appendText(root, value.slice(marker.index));
          break;
        }
        const em = document.createElement("em");
        em.className = "mdEm";
        appendInlineMarkdown(em, value.slice(marker.index + 1, end));
        root.appendChild(em);
        index = end + 1;
      }
    }

    function appendText(root, text) {
      if (text) root.appendChild(document.createTextNode(text));
    }

    function nextInlineMarker(value, start) {
      for (let index = start; index < value.length; index += 1) {
        if (value[index] === "\`") return { type: "code", index };
        if (value.slice(index, index + 2) === "**" && value.indexOf("**", index + 2) !== -1) {
          return { type: "strong", index };
        }
        if (value[index] === "*" && value[index - 1] !== "*" && value[index + 1] !== "*" && findSingleStar(value, index + 1) !== -1) {
          return { type: "em", index };
        }
      }
      return undefined;
    }

    function findSingleStar(value, start) {
      for (let index = start; index < value.length; index += 1) {
        if (value[index] === "*" && value[index - 1] !== "*" && value[index + 1] !== "*") return index;
      }
      return -1;
    }

    function codeBlock(language, codeText) {
      const block = document.createElement("div");
      block.className = "codeBlock";
      const head = document.createElement("div");
      head.className = "codeHead";
      const label = document.createElement("span");
      label.className = "codeLanguage";
      label.textContent = language || "plain text";
      const copy = document.createElement("button");
      copy.className = "copyCode";
      copy.type = "button";
      copy.title = "Copy code block";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => copyCode(codeText, copy));
      head.append(label, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      appendHighlightedCode(code, codeText, language);
      pre.appendChild(code);
      block.append(head, pre);
      return block;
    }

    function appendHighlightedCode(root, codeText, language) {
      const normalized = normalizeCodeLanguage(language);
      if (!normalized) {
        root.textContent = codeText;
        return;
      }
      if (normalized === "diff") {
        appendDiffHighlightedCode(root, codeText);
        return;
      }
      const tokens = tokenizeCode(codeText, normalized);
      for (const token of tokens) {
        if (!token.type) {
          root.appendChild(document.createTextNode(token.text));
          continue;
        }
        const span = document.createElement("span");
        span.className = "syntaxToken syntax" + token.type;
        span.textContent = token.text;
        root.appendChild(span);
      }
    }

    function appendDiffHighlightedCode(root, codeText) {
      const lines = String(codeText || "").split(/(\\n)/);
      for (const line of lines) {
        if (line === "\\n") {
          root.appendChild(document.createTextNode(line));
          continue;
        }
        const span = document.createElement("span");
        if (/^@@/.test(line)) span.className = "syntaxToken syntaxHunk";
        else if (/^\\+/.test(line)) span.className = "syntaxToken syntaxInserted";
        else if (/^-/.test(line)) span.className = "syntaxToken syntaxDeleted";
        span.textContent = line;
        root.appendChild(span.className ? span : document.createTextNode(line));
      }
    }

    function tokenizeCode(codeText, language) {
      const text = String(codeText || "");
      const tokens = [];
      let index = 0;
      while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];
        if (char === "/" && next === "/") {
          const end = lineEnd(text, index);
          pushToken(tokens, "Comment", text.slice(index, end));
          index = end;
          continue;
        }
        if (char === "/" && next === "*") {
          const end = text.indexOf("*/", index + 2);
          const stop = end === -1 ? text.length : end + 2;
          pushToken(tokens, "Comment", text.slice(index, stop));
          index = stop;
          continue;
        }
        if ((language === "python" || language === "shell") && char === "#") {
          const end = lineEnd(text, index);
          pushToken(tokens, "Comment", text.slice(index, end));
          index = end;
          continue;
        }
        if (char === '"' || char === "'" || char === "\`") {
          const end = stringEnd(text, index, char);
          const type = language === "json" && nextJsonNonSpace(text, end) === ":" ? "Property" : "String";
          pushToken(tokens, type, text.slice(index, end));
          index = end;
          continue;
        }
        if (/\\d/.test(char)) {
          const match = text.slice(index).match(/^\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/);
          if (match) {
            pushToken(tokens, "Number", match[0]);
            index += match[0].length;
            continue;
          }
        }
        if (/[A-Za-z_$]/.test(char)) {
          const match = text.slice(index).match(/^[A-Za-z_$][\\w$]*/);
          if (match) {
            const word = match[0];
            const type = codeTokenType(word, text, index + word.length, language);
            pushToken(tokens, type, word);
            index += word.length;
            continue;
          }
        }
        pushToken(tokens, "", char);
        index += 1;
      }
      return tokens;
    }

    function codeTokenType(word, text, end, language) {
      const keywords = codeKeywords(language);
      if (keywords.has(word)) return "Keyword";
      if (codeTypes(language).has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) return "Type";
      const next = nextJsonNonSpace(text, end);
      if (next === "(") return "Function";
      return "";
    }

    function normalizeCodeLanguage(language) {
      const value = String(language || "").trim().toLowerCase().split(/\\s+/)[0];
      if (!value) return "";
      if (["ts", "tsx", "typescript"].includes(value)) return "typescript";
      if (["js", "jsx", "javascript"].includes(value)) return "javascript";
      if (["c", "h"].includes(value)) return "c";
      if (["cpp", "c++", "cc", "cxx", "hpp", "hxx"].includes(value)) return "cpp";
      if (["py", "python"].includes(value)) return "python";
      if (["json"].includes(value)) return "json";
      if (["diff", "patch"].includes(value)) return "diff";
      if (["sh", "shell", "bash", "zsh", "powershell", "ps1"].includes(value)) return "shell";
      return "";
    }

    function codeKeywords(language) {
      const common = ["return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "new", "class", "struct", "enum", "const", "let", "var", "function", "async", "await", "import", "export", "from", "default", "extends", "implements", "public", "private", "protected", "static", "true", "false", "null", "undefined"];
      const cLike = ["typedef", "sizeof", "volatile", "extern", "inline", "register", "union", "goto", "case", "default"];
      const python = ["def", "class", "import", "from", "as", "with", "lambda", "yield", "None", "True", "False", "and", "or", "not", "in", "is", "elif", "except", "finally", "global", "nonlocal", "pass", "raise"];
      const shell = ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "export", "local", "return", "echo"];
      const json = ["true", "false", "null"];
      if (language === "python") return new Set(python);
      if (language === "shell") return new Set(shell);
      if (language === "json") return new Set(json);
      if (language === "c" || language === "cpp") return new Set(common.concat(cLike));
      return new Set(common);
    }

    function codeTypes(language) {
      const cTypes = ["void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool", "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t"];
      const tsTypes = ["string", "number", "boolean", "unknown", "never", "any", "void", "Promise", "Record", "Array", "ReadonlyArray"];
      if (language === "c" || language === "cpp") return new Set(cTypes);
      if (language === "typescript" || language === "javascript") return new Set(tsTypes);
      return new Set([]);
    }

    function pushToken(tokens, type, text) {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (last && last.type === type) {
        last.text += text;
        return;
      }
      tokens.push({ type, text });
    }

    function lineEnd(text, start) {
      const end = text.indexOf("\\n", start);
      return end === -1 ? text.length : end;
    }

    function stringEnd(text, start, quote) {
      let escaped = false;
      for (let index = start + 1; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\\\") {
          escaped = true;
          continue;
        }
        if (char === quote) return index + 1;
        if (char === "\\n" && quote !== "\`") return index;
      }
      return text.length;
    }

    function nextJsonNonSpace(text, start) {
      for (let index = start; index < text.length; index += 1) {
        if (!/\\s/.test(text[index])) return text[index];
      }
      return "";
    }

    async function copyTextWithFeedback(text, button, successMessage) {
      const previousLabel = button ? button.textContent : "";
      try {
        await navigator.clipboard.writeText(String(text || ""));
        if (button) {
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = previousLabel || "Copy";
          }, 1200);
        }
        setNotice(successMessage || "Copied.");
      } catch {
        if (button) {
          button.textContent = "Failed";
          window.setTimeout(() => {
            button.textContent = previousLabel || "Copy";
          }, 1200);
        }
        setNotice("Copy failed.");
      }
    }

    async function copyCode(text, button) {
      await copyTextWithFeedback(text, button, "Copied code.");
    }

    function codeGraphView(graph, stateName) {
      const files = formatCount(graph.indexedFiles || 0);
      const functions = formatCount(graph.indexedFunctions || 0);
      if (stateName === "ready") {
        const intelLoading = Boolean(state.loadingCodeIntelligence);
        const intelLabel = intelLoading ? "Loading..." : codeIntelligenceVisible ? "Refresh" : "Intel";
        return {
          label: "Indexed: " + files + " files, " + functions + " functions",
          meta: codeGraphMeta(graph),
          actions: [
            { label: intelLabel, message: "refreshCodeIntelligence", title: codeIntelligenceVisible ? "Refresh local code intelligence panel" : "Show local code intelligence panel", disabled: intelLoading },
            { label: "Rebuild", message: "rebuildCodeGraph", title: "Rebuild local code graph" },
            { label: "Status", message: "showCodeGraphStatus", title: "Show local code graph status" },
          ],
        };
      }
      if (stateName === "indexing" || stateName === "indexingFull" || stateName === "indexingIncremental" || stateName === "recovering") {
        const progress = graph.progress && graph.progress.total
          ? " " + formatCount(graph.progress.completed || 0) + "/" + formatCount(graph.progress.total) + " files"
          : "";
        const label = stateName === "recovering"
          ? "Recovering index..."
          : stateName === "indexingIncremental"
            ? "Updating index..."
            : "Indexing...";
        return {
          label: label + progress,
          meta: graph.detail || "Indexing local C/C++ code graph.",
          actions: [
            { label: "Pause", message: "pauseCodeGraph", title: "Pause local code graph indexing" },
            { label: "Cancel", message: "cancelCodeGraph", title: "Cancel local code graph indexing" },
          ],
        };
      }
      if (stateName === "paused") {
        return {
          label: "Code graph paused",
          meta: graph.detail || "Indexing is paused.",
          actions: [
            { label: "Resume", message: "resumeCodeGraph", title: "Resume local code graph indexing" },
            { label: "Cancel", message: "cancelCodeGraph", title: "Cancel local code graph indexing" },
          ],
        };
      }
      if (stateName === "stale" || stateName === "degraded" || stateName === "rescanScheduled") {
        return {
          label: stateName === "rescanScheduled" ? "Code graph rescan scheduled" : "Code graph degraded",
          meta: graph.detail || "Workspace changed; refresh before relying on whole-repo context.",
          actions: [{ label: "Refresh", message: "indexCodeGraph", title: "Refresh local code graph" }],
        };
      }
      if (stateName === "error") {
        return {
          label: "Code graph error",
          meta: graph.detail || "Indexing failed.",
          actions: [
            { label: "Retry", message: "indexCodeGraph", title: "Retry local code graph indexing" },
            { label: "Status", message: "showCodeGraphStatus", title: "Show local code graph status" },
          ],
        };
      }
      return {
        label: "Code graph disabled",
        meta: graph.detail || "Index the workspace to enable whole-repo code understanding.",
        actions: [{ label: "Index", message: "indexCodeGraph", title: "Index local code graph" }],
      };
    }

    function onCodeGraphAction(event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const button = target.closest("[data-code-graph-action]");
      if (!button || button.disabled) return;
      if (button.dataset.codeGraphAction === "refreshCodeIntelligence") {
        openOrRefreshCodeIntelligence();
        return;
      }
      vscode.postMessage({ type: button.dataset.codeGraphAction });
    }

    function openOrRefreshCodeIntelligence() {
      if (state.loadingCodeIntelligence) return;
      const hadSnapshot = Boolean(state.codeIntelligence);
      const wasVisible = codeIntelligenceVisible;
      codeIntelligenceVisible = true;
      if (!hadSnapshot) selectedStateMachineId = "";
      if (wasVisible || !hadSnapshot) {
        requestCodeIntelligenceRefresh();
        return;
      }
      renderComposerStatusBar();
      renderCodeIntelligence();
    }

    function requestCodeIntelligenceRefresh() {
      if (state.loadingCodeIntelligence) return;
      state.loadingCodeIntelligence = true;
      state.codeIntelligenceError = "";
      renderComposerStatusBar();
      renderCodeIntelligence();
      vscode.postMessage({ type: "refreshCodeIntelligence" });
    }

    function renderCodeIntelligence() {
      const node = el("codeIntelligence");
      if (!codeIntelligenceVisible) {
        node.className = "codeIntel";
        node.innerHTML = "";
        return;
      }
      const intel = state.codeIntelligence;
      node.className = "codeIntel visible";
      node.innerHTML = "";
      node.appendChild(codeIntelHeader());

      if (state.loadingCodeIntelligence) {
        node.appendChild(codeIntelStatus("Loading local code intelligence...", false));
      }
      if (state.codeIntelligenceError) {
        node.appendChild(codeIntelStatus(state.codeIntelligenceError, true));
      }
      if (!intel) {
        if (!state.loadingCodeIntelligence && !state.codeIntelligenceError) {
          node.appendChild(codeIntelStatus("No code intelligence snapshot is loaded yet. Click Refresh to load local analysis.", false));
        }
        return;
      }

      const machines = intel.stateMachines || [];
      if (selectedStateMachineId && !machines.some((machine) => machine.id === selectedStateMachineId)) {
        selectedStateMachineId = "";
      }
      node.appendChild(codeIntelSection("Modules", (intel.modules || []).slice(0, 5).map((item) => ({
        title: item.module,
        meta: item.summary + " " + (item.keyFlows || []).slice(0, 2).join(" | "),
        evidence: (item.evidence || [])[0],
      }))));
      node.appendChild(codeIntelSection("State Machines", machines.slice(0, 5).map((item) => ({
        title: item.name,
        meta: (item.states || []).length + " state(s), " + (item.transitions || []).length + " transition(s), " + (item.candidateTransitions || []).length + " candidate(s), confidence " + Number(item.confidence || 0).toFixed(2),
        evidence: (item.evidence || [])[0],
        inspectId: item.id,
      }))));
      const selectedMachine = selectedStateMachineId ? machines.find((machine) => machine.id === selectedStateMachineId) : undefined;
      if (selectedMachine) node.appendChild(codeIntelMachineDetails(selectedMachine));
      node.appendChild(codeIntelSection("Transitions", machines.flatMap((machine) =>
        (machine.transitions || []).slice(0, 4).map((transition) => ({
          title: transition.fromState + " -> " + transition.toState,
          meta: [transition.event, transition.guard, transition.action].filter(Boolean).join(" / ") || "transition",
          evidence: transition.evidence,
        }))
      ).slice(0, 8)));
      if (intel.lastTrace) {
        const trace = document.createElement("div");
        trace.className = "codeIntelSection";
        const title = document.createElement("div");
        title.className = "codeIntelTitle";
        title.textContent = "Query Trace";
        const meta = document.createElement("div");
        meta.className = "codeIntelMeta";
        meta.textContent = (intel.lastTrace.steps || []).map((step) => step.label).join(" > ");
        trace.append(title, meta);
        node.appendChild(trace);
      }
      const transitions = ((state.codeGraph && state.codeGraph.transitions) || []).slice(-6).reverse();
      if (transitions.length) {
        node.appendChild(codeIntelSection("Index States", transitions.map((item) => ({
          title: item.state,
          meta: formatDateTime(item.at) + " " + (item.detail || ""),
        }))));
      }
    }

    function codeIntelHeader() {
      const header = document.createElement("div");
      header.className = "codeIntelHeader";
      const title = document.createElement("div");
      title.className = "codeIntelTitle";
      title.textContent = "Code Intelligence";
      const actions = document.createElement("div");
      actions.className = "codeIntelHeaderActions";
      const refresh = document.createElement("button");
      refresh.className = "codeIntelAction";
      refresh.type = "button";
      refresh.textContent = state.loadingCodeIntelligence ? "Loading..." : "Refresh";
      refresh.title = "Refresh local code intelligence";
      refresh.disabled = Boolean(state.loadingCodeIntelligence);
      refresh.setAttribute("data-code-intel-refresh", "true");
      const hide = document.createElement("button");
      hide.className = "codeIntelAction";
      hide.type = "button";
      hide.textContent = "Hide";
      hide.title = "Hide code intelligence panel";
      hide.setAttribute("data-code-intel-hide", "true");
      actions.append(refresh, hide);
      header.append(title, actions);
      return header;
    }

    function codeIntelStatus(text, isError) {
      const status = document.createElement("div");
      status.className = "codeIntelStatus" + (isError ? " error" : "");
      status.textContent = text;
      return status;
    }

    function codeIntelSection(titleText, rows) {
      const section = document.createElement("div");
      section.className = "codeIntelSection";
      const title = document.createElement("div");
      title.className = "codeIntelTitle";
      title.textContent = titleText;
      section.appendChild(title);
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "codeIntelMeta";
        empty.textContent = "No indexed data.";
        section.appendChild(empty);
        return section;
      }
      for (const row of rows) {
        const item = document.createElement("div");
        item.className = "codeIntelRow";
        const main = document.createElement("div");
        main.className = "codeIntelMain";
        main.textContent = row.title;
        main.title = row.meta || row.title;
        const meta = document.createElement("div");
        meta.className = "codeIntelMeta";
        meta.textContent = row.meta || "";
        const left = document.createElement("div");
        left.append(main, meta);
        item.appendChild(left);
        const actions = document.createElement("div");
        actions.className = "codeIntelRowActions";
        if (row.inspectId) {
          const inspect = document.createElement("button");
          inspect.className = "codeIntelJump";
          inspect.type = "button";
          inspect.textContent = "Inspect";
          inspect.title = "Inspect state machine evidence";
          inspect.dataset.codeIntelMachineId = row.inspectId;
          actions.appendChild(inspect);
        }
        const source = codeIntelEvidenceButton(row.evidence);
        if (source) actions.appendChild(source);
        if (actions.childElementCount) item.appendChild(actions);
        section.appendChild(item);
      }
      return section;
    }

    function codeIntelMachineDetails(machine) {
      const section = document.createElement("div");
      section.className = "codeIntelSection";
      const title = document.createElement("div");
      title.className = "codeIntelTitle";
      title.textContent = "State Machine Audit";
      const meta = document.createElement("div");
      meta.className = "codeIntelMachineMeta";
      meta.append(
        codeIntelBadge("stateVar " + (machine.stateVar || "state"), false),
        codeIntelBadge("confidence " + Number(machine.confidence || 0).toFixed(2), false),
        codeIntelBadge((machine.states || []).length + " states", false),
        codeIntelBadge((machine.transitions || []).length + " transitions", false),
        codeIntelBadge((machine.candidateTransitions || []).length + " candidates", Boolean((machine.candidateTransitions || []).length)),
      );
      const tableTitle = document.createElement("div");
      tableTitle.className = "codeIntelMeta";
      tableTitle.textContent = "Transition Table";
      const table = document.createElement("div");
      table.className = "codeIntelTransitionTable";
      const transitions = [
        ...(machine.transitions || []).map((transition) => ({ transition, candidate: false })),
        ...(machine.candidateTransitions || []).map((transition) => ({ transition, candidate: true })),
      ];
      if (!transitions.length) {
        table.appendChild(codeIntelStatus("No transitions were inferred for this state machine.", false));
      }
      for (const entry of transitions) {
        const transition = entry.transition;
        const row = document.createElement("div");
        row.className = "codeIntelTransitionRow";
        const edge = document.createElement("div");
        edge.className = "codeIntelTransitionEdge";
        const edgeMain = document.createElement("div");
        edgeMain.className = "codeIntelMain";
        edgeMain.textContent = (transition.fromState || "unknown") + " -> " + (transition.toState || "unknown");
        const badges = document.createElement("div");
        badges.className = "codeIntelMachineMeta";
        if ((transition.fromState || "").toLowerCase() === "unknown") badges.appendChild(codeIntelBadge("unknown from-state", true));
        if (entry.candidate) badges.appendChild(codeIntelBadge("candidate", true));
        if (transition.lowConfidence) badges.appendChild(codeIntelBadge("low confidence", true));
        badges.appendChild(codeIntelBadge("confidence " + Number(transition.confidence || 0).toFixed(2), false));
        edge.append(edgeMain, badges);

        const detail = document.createElement("div");
        detail.className = "codeIntelTransitionDetail";
        const lines = [
          transition.event ? "event: " + transition.event : "",
          transition.guard ? "guard: " + transition.guard : "",
          transition.action ? "action: " + transition.action : "",
          transition.evidence && transition.evidence.parserKind ? "evidence kind: " + transition.evidence.parserKind : "",
        ].filter(Boolean);
        detail.textContent = lines.join(" | ") || "No event, guard, or action inferred.";
        if (transition.evidence && transition.evidence.snippet) {
          const snippet = document.createElement("div");
          snippet.className = "codeIntelSnippet";
          snippet.textContent = shortSnippet(transition.evidence.snippet);
          detail.appendChild(snippet);
        }

        const evidence = document.createElement("div");
        evidence.className = "codeIntelEvidence";
        if (transition.evidence && transition.evidence.file) {
          const ref = document.createElement("div");
          ref.className = "codeIntelMeta";
          ref.textContent = transition.evidence.file + ":" + (transition.evidence.startLine || 1);
          evidence.appendChild(ref);
        }
        const source = codeIntelEvidenceButton(transition.evidence);
        if (source) evidence.appendChild(source);
        row.append(edge, detail, evidence);
        table.appendChild(row);
      }
      section.append(title, meta, tableTitle, table);
      return section;
    }

    function codeIntelBadge(text, warning) {
      const badge = document.createElement("span");
      badge.className = "codeIntelBadge" + (warning ? " warning" : "");
      badge.textContent = text;
      return badge;
    }

    function codeIntelEvidenceButton(evidence) {
      if (!evidence || !evidence.file) return undefined;
      const jump = document.createElement("button");
      jump.className = "codeIntelJump";
      jump.type = "button";
      jump.textContent = "Source";
      jump.title = "Open source evidence: " + evidence.file + ":" + (evidence.startLine || 1);
      jump.dataset.path = evidence.file;
      jump.dataset.line = String(evidence.startLine || 1);
      return jump;
    }

    function shortSnippet(text) {
      const cleaned = String(text || "").replace(/\\s+/g, " ").trim();
      return cleaned.length > 180 ? cleaned.slice(0, 177) + "..." : cleaned;
    }

    function onCodeIntelligenceAction(event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const hide = target.closest("[data-code-intel-hide]");
      if (hide) {
        codeIntelligenceVisible = false;
        renderComposerStatusBar();
        renderCodeIntelligence();
        return;
      }
      const refresh = target.closest("[data-code-intel-refresh]");
      if (refresh && !refresh.disabled) {
        requestCodeIntelligenceRefresh();
        return;
      }
      const inspect = target.closest("[data-code-intel-machine-id]");
      if (inspect) {
        selectedStateMachineId = inspect.dataset.codeIntelMachineId || "";
        renderCodeIntelligence();
        return;
      }
      const button = target.closest(".codeIntelJump");
      if (!button) return;
      vscode.postMessage({ type: "openEvidence", path: button.dataset.path, line: Number(button.dataset.line || 1) });
    }

    function codeGraphMeta(graph) {
      const parts = [];
      if (graph.largeRepoMode) parts.push("Large repo mode");
      if (graph.updatedAt) parts.push("Updated " + formatDateTime(graph.updatedAt));
      if (graph.shards) parts.push(formatCount(graph.shards) + " shards");
      if (graph.currentShard) parts.push("Shard " + graph.currentShard);
      if (graph.queue && graph.queue.pendingJobs) parts.push(formatCount(graph.queue.pendingJobs) + " queued");
      if (graph.errorCount) parts.push(formatCount(graph.errorCount) + " errors");
      if (graph.schemaVersion) parts.push("Schema v" + graph.schemaVersion);
      if (graph.truncated) parts.push("Index truncated by file limit");
      if (graph.analysisMode) parts.push("Analyzer: " + graph.analysisMode + (graph.analyzerHost ? " on " + graph.analyzerHost : ""));
      if (graph.analyzerDegradedReason) parts.push(graph.analyzerDegradedReason);
      if (parts.length > 0) return parts.join(" · ");
      return graph.detail || "Ready for whole-repo code questions.";
    }

    function codeGraphTitle(graph, fallback) {
      const parts = [graph.detail || fallback];
      parts.push(formatCount(graph.indexedFiles || 0) + " file(s)");
      parts.push(formatCount(graph.indexedFunctions || 0) + " function(s)");
      if (graph.indexedMacros) parts.push(formatCount(graph.indexedMacros) + " macro(s)");
      if (graph.shards) parts.push(formatCount(graph.shards) + " shard(s)");
      if (graph.indexBytes) parts.push(formatBytes(graph.indexBytes) + " indexed source");
      if (graph.skippedFiles) parts.push(formatCount(graph.skippedFiles) + " skipped file(s)");
      if (graph.queue && graph.queue.pendingJobs) parts.push(formatCount(graph.queue.pendingJobs) + " queued job(s)");
      if (graph.errorCount) parts.push(formatCount(graph.errorCount) + " error(s)");
      if (graph.schemaVersion) parts.push("Schema v" + graph.schemaVersion);
      if (graph.updatedAt) parts.push("Updated " + formatDateTime(graph.updatedAt));
      if (graph.truncated) parts.push("Index truncated by file limit.");
      if (graph.analyzerDetail) parts.push(graph.analyzerDetail);
      return parts.filter(Boolean).join(" ");
    }

    function formatCount(value) {
      return Number(value || 0).toLocaleString();
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
    }

    function formatDateTime(value) {
      const millis = value > 9999999999 ? value : value * 1000;
      const date = new Date(millis);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function renderModelSelector() {
      const select = el("modelSelect");
      const current = state.selectedModel || "";
      const existing = Array.from(select.options).map((option) => option.value).join("\\n");
      const models = state.models || [];
      const wanted = ["", ...models.map((model) => model.id), current && !models.some((model) => model.id === current) ? current : "", "__manual"].filter(Boolean).join("\\n");
      if (existing !== wanted) {
        select.innerHTML = "";
        select.appendChild(modelOption("", state.loadingModels ? "Loading models..." : "Use server default"));
        for (const model of models) {
          const label = (model.isDefault ? "* " : "") + model.providerName + " / " + (model.name || model.modelID);
          select.appendChild(modelOption(model.id, label));
        }
        if (current && !models.some((model) => model.id === current)) {
          select.appendChild(modelOption(current, current + " (manual)"));
        }
        select.appendChild(modelOption("__manual", "Manual..."));
      }
      select.value = current && Array.from(select.options).some((option) => option.value === current) ? current : "";
      setIconButtonState(el("refreshModels"), {
        label: state.loadingModels ? "Refreshing models" : "Refresh models",
        loading: Boolean(state.loadingModels),
        disabled: Boolean(state.loadingModels)
      });
      renderModelTrigger();
      renderModelMenu();
      if (state.modelError) setNotice(state.modelError);
    }

    function setIconButtonState(button, input) {
      button.disabled = Boolean(input.disabled);
      button.classList.toggle("loading", Boolean(input.loading));
      button.title = input.label;
      button.setAttribute("aria-label", input.label);
      const label = button.querySelector(".srOnly");
      if (label) label.textContent = input.label;
    }

    function modelOption(value, label) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }

    function renderModelTrigger() {
      const trigger = el("modelTrigger");
      const label = state.loadingModels ? "Loading models" : currentModelLabel();
      trigger.textContent = shortModelName(label);
      trigger.title = label;
      trigger.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false");
      trigger.className = "modelTrigger" + (modelMenuOpen ? " open" : "");
    }

    function toggleModelMenu() {
      modelMenuOpen = !modelMenuOpen;
      if (modelMenuOpen) agentMenuOpen = false;
      renderAgentMenu();
      renderAgentTrigger();
      renderModelMenu();
      renderModelTrigger();
    }

    function renderModelMenu() {
      const root = el("modelMenu");
      root.innerHTML = "";
      root.className = "modelMenu" + (modelMenuOpen ? " open" : "");
      root.setAttribute("aria-hidden", modelMenuOpen ? "false" : "true");
      if (!modelMenuOpen) return;

      root.appendChild(modelMenuItem("", "Use server default", "Remote server chooses the model"));
      const models = state.models || [];
      for (const model of models) {
        const name = model.name || model.modelID || model.id;
        const meta = model.providerName ? model.providerName + " / " + model.modelID : model.id;
        root.appendChild(modelMenuItem(model.id, name, meta));
      }

      const current = state.selectedModel || "";
      if (current && !models.some((model) => model.id === current)) {
        root.appendChild(modelMenuItem(current, shortModelName(current), current + " (manual)"));
      }
      root.appendChild(modelMenuItem("__manual", "Manual...", "Enter provider/model"));
      positionModelMenu();
    }

    function positionModelMenu() {
      positionPopupMenu("modelMenu", "modelTrigger", modelMenuOpen);
    }

    function renderAgentSelector() {
      renderAgentTrigger();
      renderAgentMenu();
    }

    function renderAgentTrigger() {
      const trigger = el("agentTrigger");
      const label = state.loadingAgents ? "Loading agents" : currentAgentLabel();
      trigger.textContent = label;
      trigger.title = agentTitle();
      trigger.setAttribute("aria-expanded", agentMenuOpen ? "true" : "false");
      trigger.className = "modelTrigger agentTrigger"
        + (agentMenuOpen ? " open" : "")
        + (localOnlyAgentBlocked() ? " warning" : " ready");
    }

    function toggleAgentMenu() {
      agentMenuOpen = !agentMenuOpen;
      if (agentMenuOpen) modelMenuOpen = false;
      renderModelMenu();
      renderModelTrigger();
      renderAgentMenu();
      renderAgentTrigger();
    }

    function onPopupMenuKeydown(event, kind) {
      const isModel = kind === "model";
      const isOpen = isModel ? modelMenuOpen : agentMenuOpen;
      const menuId = isModel ? "modelMenu" : "agentMenu";
      const triggerId = isModel ? "modelTrigger" : "agentTrigger";
      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        if (isModel) {
          modelMenuOpen = false;
          renderModelMenu();
          renderModelTrigger();
        } else {
          agentMenuOpen = false;
          renderAgentMenu();
          renderAgentTrigger();
        }
        el(triggerId).focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      if (!isOpen) {
        if (isModel) toggleModelMenu();
        else toggleAgentMenu();
      }
      requestAnimationFrame(() => focusPopupMenuItem(menuId, event.key));
    }

    function focusPopupMenuItem(menuId, key) {
      const items = Array.from(el(menuId).querySelectorAll(".modelMenuItem")).filter((item) => !item.disabled);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement);
      let next = current;
      if (key === "Home") next = 0;
      else if (key === "End") next = items.length - 1;
      else if (key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
      else next = current < 0 || current >= items.length - 1 ? 0 : current + 1;
      items[next].focus();
    }

    function renderAgentMenu() {
      const root = el("agentMenu");
      root.innerHTML = "";
      root.className = "modelMenu agentMenu" + (agentMenuOpen ? " open" : "");
      root.setAttribute("aria-hidden", agentMenuOpen ? "false" : "true");
      if (!agentMenuOpen) return;

      const agents = state.agents || [];
      const required = state.localOnlyAgent || state.selectedAgent || "vscode-local";
      const hasRequired = agents.some((agent) => agentMatchesRequired(agent, required));
      if (!hasRequired) {
        root.appendChild(agentMenuItem({ id: required, name: required, description: "Required VS Code local agent is missing" }, true, false, true));
      }
      for (const agent of agents) {
        const isRequired = agentMatchesRequired(agent, required);
        root.appendChild(agentMenuItem(agent, !isRequired, isRequired, isRequired));
      }
      if (state.agentError) {
        root.appendChild(agentMenuItem({ id: "agent-error", name: "Agent discovery failed", description: state.agentError }, true, false, false));
      }
      positionAgentMenu();
    }

    function positionAgentMenu() {
      positionPopupMenu("agentMenu", "agentTrigger", agentMenuOpen);
    }

    function positionPopupMenu(menuId, triggerId, isOpen) {
      if (!isOpen) return;

      const root = el(menuId);
      const composer = document.querySelector(".composer");
      if (!composer) return;

      const composerRect = composer.getBoundingClientRect();
      const triggerRect = el(triggerId).getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 320;
      const margin = 8;
      const gap = 6;
      const maxAvailableWidth = Math.max(120, viewportWidth - margin * 2);
      const preferredWidth = Math.max(180, Math.min(320, composerRect.width), triggerRect.width);
      let width = Math.min(maxAvailableWidth, preferredWidth);
      let left = Math.max(margin, Math.min(triggerRect.left, viewportWidth - margin - width));
      if (left + width > viewportWidth - margin) {
        left = Math.max(margin, viewportWidth - margin - width);
      }

      const menuBottomY = Math.max(margin + 48, Math.min(triggerRect.top, composerRect.top) - gap);
      const bottom = Math.max(margin, viewportHeight - menuBottomY);
      const maxHeight = Math.max(48, menuBottomY - margin);

      root.style.left = Math.round(left) + "px";
      root.style.width = Math.floor(width) + "px";
      root.style.bottom = Math.round(bottom) + "px";
      root.style.maxHeight = Math.floor(maxHeight) + "px";
    }

    function modelMenuItem(value, name, meta) {
      const button = document.createElement("button");
      const isActive = value === (state.selectedModel || "");
      button.className = "modelMenuItem" + (isActive ? " active" : "");
      button.type = "button";
      button.title = meta || name;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      const label = document.createElement("span");
      label.className = "modelMenuName";
      label.textContent = name;
      const detail = document.createElement("span");
      detail.className = "modelMenuMeta";
      detail.textContent = meta || "";
      button.append(label, detail);
      button.addEventListener("click", () => selectModelValue(value));
      return button;
    }

    function agentMenuItem(agent, disabled, active, localAgent) {
      const button = document.createElement("button");
      button.className = "modelMenuItem"
        + (active ? " active" : "")
        + (disabled ? " disabled" : "")
        + (localAgent ? " localAgent" : "");
      button.type = "button";
      button.disabled = Boolean(disabled);
      button.title = agent.description || agent.id || agent.name;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", active ? "true" : "false");
      const label = document.createElement("span");
      label.className = "modelMenuName";
      label.textContent = (localAgent ? "* " : "") + (agent.name || agent.id);
      const detail = document.createElement("span");
      detail.className = "modelMenuMeta";
      detail.textContent = localAgent
        ? (agent.description || "Required for VS Code local context")
        : "Unavailable for VS Code local mode";
      button.append(label, detail);
      return button;
    }

    function currentModelLabel() {
      const current = state.selectedModel || "";
      if (!current) return "Use server default";
      const match = (state.models || []).find((model) => model.id === current);
      return match ? (match.name || match.modelID || match.id) : current;
    }

    function currentAgentLabel() {
      if (!state.localOnlyMode && !state.selectedAgent) return "No agent";
      const current = state.selectedAgent || state.localOnlyAgent || "vscode-local";
      if (state.loadingAgents) return "Loading agent";
      if (localOnlyAgentBlocked()) return "Missing " + current;
      return current;
    }

    function agentTitle() {
      if (state.localOnlyWarning) return state.localOnlyWarning;
      if (!state.localOnlyMode && !state.selectedAgent) return "Remote server chooses the agent";
      return "Using required VS Code local agent: " + (state.selectedAgent || state.localOnlyAgent || "vscode-local");
    }

    function localOnlyAgentBlocked() {
      return Boolean(state.localOnlyMode && !state.agentReady);
    }

    function agentMatchesRequired(agent, required) {
      if (agent.id === required) return true;
      const target = canonicalAgentName(required);
      return canonicalAgentName(agent.id) === target || canonicalAgentName(agent.name) === target;
    }

    function canonicalAgentName(value) {
      return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function shortModelName(value) {
      if (!value) return "Server default";
      const clean = String(value).replace(/\\s+\\(manual\\)$/i, "");
      const pieces = clean.split("/");
      return pieces[pieces.length - 1] || clean;
    }

    function renderMentionChips() {
      renderComposerStatusBar();
    }

    function autoChip(text, captured) {
      const node = document.createElement("span");
      node.className = "chip autoContext " + (captured ? "captured" : "missing");
      const label = document.createElement("span");
      label.textContent = text;
      node.appendChild(label);
      return node;
    }

    function chip(file, removable) {
      const node = document.createElement("span");
      node.className = "chip";
      const label = document.createElement("span");
      label.textContent = "@" + file.label;
      node.appendChild(label);
      if (removable) {
        const button = document.createElement("button");
        button.textContent = "x";
        button.title = "Remove";
        button.addEventListener("click", () => removeMention(file.uri));
        node.appendChild(button);
      }
      return node;
    }

    function renderSuggestions() {
      const root = el("suggestions");
      root.innerHTML = "";
      const mention = currentMention();
      const shouldOpen = Boolean(mention && (mentionStatus || mentionError || mentionTruncated || mentionSearched || mentionResults.length > 0));
      if (!shouldOpen) {
        root.className = "suggestions";
        return;
      }
      root.className = "suggestions open";
      if (mentionStatus === "searching") {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = "Searching workspace files...";
        root.appendChild(row);
      }
      if (mentionError) {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = mentionError;
        root.appendChild(row);
      }
      if (!mentionStatus && !mentionError && mentionResults.length === 0) {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = "No files found.";
        root.appendChild(row);
      }
      if (mentionTruncated) {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = "Index truncated; keep typing to narrow results.";
        root.appendChild(row);
      }
      mentionResults.forEach((file, index) => {
        const node = document.createElement("div");
        node.className = "suggestion " + (index === activeSuggestion ? "active" : "");
        const icon = document.createElement("span");
        icon.className = "suggestionIcon";
        icon.textContent = file.type === "folder" ? "dir" : "file";
        const label = document.createElement("span");
        label.className = "suggestionLabel";
        label.textContent = file.label;
        node.append(icon, label);
        node.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectMention(file);
        });
        root.appendChild(node);
      });
    }

    function roleLabel(role) {
      if (role === "user") return "You";
      if (role === "assistant") return "OpenCode";
      if (role === "tool") return "Tool";
      if (role === "error") return "Error";
      return "Message";
    }

    function avatarText(role) {
      if (role === "user") return "You";
      if (role === "error") return "!";
      if (role === "tool") return "T";
      return "OC";
    }

    function formatTime(value) {
      if (!value) return "";
      const millis = value > 9999999999 ? value : value * 1000;
      const date = new Date(millis);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function isNearBottom(root) {
      return root.scrollHeight - root.scrollTop - root.clientHeight < 56;
    }

    function setNotice(text) {
      el("notice").textContent = text;
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`
}
