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
      --chat-content-font-size: max(9px, calc(var(--vscode-font-size, 13px) - 3px));
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
      padding: 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 9px;
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
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 6px;
      align-items: start;
    }
    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-size: 9px;
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
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
      padding: 6px 9px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0;
      background: var(--vscode-sideBar-background);
    }
    .messageMeta > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .messageTime { text-transform: none; white-space: nowrap; }
    .messageBody {
      padding: 7px 8px;
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .messageBody p { margin: 0 0 8px; }
    .messageBody p:last-child { margin-bottom: 0; }
    .messageBody ul { margin: 0 0 8px 18px; padding: 0; }
    .messageBody li { margin: 2px 0; }
    .mdHeading { font-weight: 700; margin: 8px 0 5px; }
    .inlineCode {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      padding: 1px 3px;
    }
    .codeBlock {
      margin: 8px 0;
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
      padding: 5px 7px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      background: var(--vscode-sideBar-background);
    }
    .copyCode { color: var(--vscode-textLink-foreground); background: transparent; padding: 2px 4px; border-radius: 3px; }
    .copyCode:hover { background: var(--vscode-toolbar-hoverBackground); }
    .codeBlock pre { margin: 0; padding: 7px; overflow: auto; white-space: pre; line-height: 1.3; }
    .codeBlock code { font-family: var(--vscode-editor-font-family); font-size: var(--chat-content-font-size); }
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
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      padding: 5px 6px 6px;
      background: var(--vscode-sideBar-background);
    }
    .composerPanel { display: grid; gap: 4px; min-width: 0; }
    .composerPanel .secondary {
      min-height: 24px;
      padding: 2px 6px;
      font-size: 10px;
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
    .codeGraph.indexing { color: var(--vscode-progressBar-background); border-color: var(--vscode-progressBar-background); }
    .codeGraph.stale { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); }
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
    .codeGraph.indexing .codeGraphLabel { color: var(--vscode-progressBar-background); }
    .codeGraph.stale .codeGraphLabel { color: var(--vscode-editorWarning-foreground); }
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
    .chips { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px; min-width: 0; min-height: 0; max-height: 42px; overflow: auto; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 6px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 10px;
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
      gap: 4px;
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
      min-height: 48px;
      max-height: 120px;
      resize: vertical;
      padding: 7px;
      border: 0;
      outline: none;
      color: var(--vscode-input-foreground);
      background: transparent;
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
    }
    .composerToolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, max-content) auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 0 5px 5px;
    }
    .send {
      min-width: 30px;
      height: 24px;
      border-radius: 5px;
      padding: 0 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 700;
      font-size: 10px;
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
      height: 24px;
      border-radius: 5px;
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      padding: 0 18px 0 7px;
      color: var(--vscode-foreground);
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      font-size: 9px;
      line-height: 22px;
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
    .composerActions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toggles { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .toggles label {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 1px 5px;
      background: var(--vscode-editor-background);
    }
    .toggles input { margin: 0; }
    .notice { min-height: 12px; color: var(--vscode-descriptionForeground); font-size: 10px; overflow-wrap: anywhere; }
    @media (max-width: 479px) {
      .topbar { gap: 6px; padding: 7px; }
      .icon { max-width: 52px; padding: 0 6px; }
      .primary, .secondary { padding-inline: 7px; }
      .composerToolbar {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 4px;
      }
      .composerHint {
        grid-column: 1 / -1;
        grid-row: 2;
      }
      .settingsActions { justify-content: flex-start; }
    }
    @media (max-width: 300px) {
      .topbar { gap: 5px; padding: 6px; }
      .mark { width: 22px; height: 22px; }
      .icon { min-width: 24px; max-width: 34px; height: 24px; padding: 0 5px; }
      .primary, .secondary { min-height: 24px; padding-inline: 6px; }
      .composerWrap { padding: 4px; }
      .composerHint { display: none; }
      .send { min-width: 26px; padding: 0 6px; }
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
      @keyframes messageIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes pulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
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
          <div class="composerPanel">
            <div id="guard" class="guard"></div>
            <div id="codeGraph" class="codeGraph"></div>
            <div id="chips" class="chips"></div>
            <select id="modelSelect" class="modelSelectHidden" title="Model"></select>
            <div class="composer">
              <div id="suggestions" class="suggestions"></div>
              <div id="modelMenu" class="modelMenu" role="listbox" aria-label="Model" aria-hidden="true"></div>
              <textarea id="input" placeholder="Ask OpenCode... Use @ to reference files."></textarea>
              <div class="composerToolbar">
                <button id="modelTrigger" class="modelTrigger" type="button" title="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu">Model</button>
                <div id="composerHint" class="composerHint">@ files, Ctrl+Enter send</div>
                <button id="send" class="send" title="Send">></button>
              </div>
            </div>
            <div class="composerActions">
              <div class="toggles">
                <label><input id="sel" type="checkbox" checked> Selection</label>
                <label><input id="file" type="checkbox" checked> Current file</label>
                <label><input id="diag" type="checkbox"> Diagnostics</label>
                <label><input id="diff" type="checkbox"> Git diff</label>
              </div>
              <div class="row">
                <button id="attach" class="secondary" title="Attach file as persistent context">Attach</button>
                <button id="refreshModels" class="secondary" title="Refresh models">Refresh</button>
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
    el("refreshModels").addEventListener("click", () => vscode.postMessage({ type: "refreshModels" }));
    el("modelSelect").addEventListener("change", onModelSelect);
    el("modelTrigger").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleModelMenu();
    });
    el("modelMenu").addEventListener("click", (event) => event.stopPropagation());
    window.addEventListener("click", () => {
      if (!modelMenuOpen) return;
      modelMenuOpen = false;
      renderModelMenu();
      renderModelTrigger();
    });
    el("saveManualModel").addEventListener("click", saveManualModel);
    el("manualModel").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveManualModel();
      }
    });
    el("codeGraph").addEventListener("click", onCodeGraphAction);
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
      setNotice("");
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
      renderGuard();
      renderCodeGraph();
      renderModelSelector();
      renderMentionChips();
      renderConnectionButtons();
      el("diag").checked = Boolean(state.defaults && state.defaults.includeDiagnostics);
      el("diff").checked = Boolean(state.defaults && state.defaults.includeGitDiff);
      el("send").disabled = Boolean(state.sending);
      el("send").textContent = state.sending ? "..." : ">";
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

    function renderSessions() {
      const root = el("sessionList");
      root.innerHTML = "";
      const sessions = state.sessions || [];
      if (sessions.length === 0) {
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
        for (const item of messages) root.appendChild(messageNode(item));
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

    function messageNode(item) {
      const node = document.createElement("article");
      node.className = "timelineItem " + (item.role || "message");
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = avatarText(item.role);
      const card = document.createElement("div");
      card.className = "messageCard";
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      const role = document.createElement("span");
      role.textContent = roleLabel(item.role);
      const time = document.createElement("span");
      time.className = "messageTime";
      time.textContent = formatTime(item.timeCreated);
      meta.append(role, time);
      const body = document.createElement("div");
      body.className = "messageBody";
      if (item.text) renderMarkdownInto(body, item.text);
      renderPartCards(body, item);
      card.append(meta, body);
      node.append(avatar, card);
      return node;
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
      };
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          flushParagraph();
          flushList();
          continue;
        }
        if (/^#{1,3}\\s+/.test(line)) {
          flushParagraph();
          flushList();
          const heading = document.createElement("div");
          heading.className = "mdHeading";
          appendInlineMarkdown(heading, line.replace(/^#{1,3}\\s+/, ""));
          root.appendChild(heading);
          continue;
        }
        if (/^[-*]\\s+/.test(line)) {
          flushParagraph();
          if (!list) list = document.createElement("ul");
          const item = document.createElement("li");
          appendInlineMarkdown(item, line.replace(/^[-*]\\s+/, ""));
          list.appendChild(item);
          continue;
        }
        flushList();
        paragraph.push(line);
      }
      flushParagraph();
      flushList();
    }

    function appendInlineMarkdown(root, text) {
      const chunks = String(text || "").split("\`");
      chunks.forEach((chunk, index) => {
        if (index % 2 === 1) {
          const code = document.createElement("code");
          code.className = "inlineCode";
          code.textContent = chunk;
          root.appendChild(code);
        } else if (chunk) {
          root.appendChild(document.createTextNode(chunk));
        }
      });
    }

    function codeBlock(language, codeText) {
      const block = document.createElement("div");
      block.className = "codeBlock";
      const head = document.createElement("div");
      head.className = "codeHead";
      const label = document.createElement("span");
      label.textContent = language || "text";
      const copy = document.createElement("button");
      copy.className = "copyCode";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => copyCode(codeText));
      head.append(label, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeText;
      pre.appendChild(code);
      block.append(head, pre);
      return block;
    }

    async function copyCode(text) {
      try {
        await navigator.clipboard.writeText(text);
        setNotice("Copied code.");
      } catch {
        setNotice("Copy failed.");
      }
    }

    function renderGuard() {
      const guard = el("guard");
      if (!state.localOnlyMode) {
        guard.className = "guard";
        guard.innerHTML = "";
        return;
      }
      const agent = state.strictLocalOnlyAgent && state.localOnlyAgent
        ? " Strict agent: " + state.localOnlyAgent + "."
        : " Server agent not forced.";
      const model = state.selectedModel ? " Model: " + state.selectedModel + "." : " Model: server default.";
      const sent = (state.lastContextSummary || []).filter((item) => !item.skipped).map((item) => item.path).slice(0, 4);
      const sentText = sent.length > 0 ? " Last sent: " + sent.join(", ") + "." : " Shown chips are sent as local context.";
      const detailText = state.localOnlyWarning || "Local-only guard active." + agent + model + sentText;
      const summaryText = state.localOnlyWarning
        ? "Guard warning"
        : "Local guard - " + shortModelName(state.selectedModel || "") + " - " + (sent.length > 0 ? sent.length + " file" + (sent.length === 1 ? "" : "s") : "context");
      guard.className = "guard visible" + (state.localOnlyWarning ? " warning" : "");
      guard.tabIndex = 0;
      guard.title = detailText;
      guard.innerHTML = "";
      const summary = document.createElement("span");
      summary.className = "guardSummary";
      summary.textContent = summaryText;
      const detail = document.createElement("span");
      detail.className = "guardDetail";
      detail.textContent = detailText;
      guard.append(summary, detail);
    }

    function renderCodeGraph() {
      const node = el("codeGraph");
      const graph = state.codeGraph || { state: "disabled", detail: "Local code graph is disabled.", indexedFiles: 0, indexedFunctions: 0, indexedMacros: 0, truncated: false };
      const stateName = graph.state || "disabled";
      const view = codeGraphView(graph, stateName);
      node.className = "codeGraph " + stateName;
      node.title = codeGraphTitle(graph, view.label);
      node.innerHTML = "";

      const main = document.createElement("div");
      main.className = "codeGraphMain";
      const label = document.createElement("div");
      label.className = "codeGraphLabel";
      label.textContent = view.label;
      const meta = document.createElement("div");
      meta.className = "codeGraphMeta";
      meta.textContent = view.meta;
      main.append(label, meta);

      const actions = document.createElement("div");
      actions.className = "codeGraphActions";
      for (const action of view.actions) {
        const button = document.createElement("button");
        button.className = "codeGraphButton";
        button.type = "button";
        button.textContent = action.label;
        button.title = action.title || action.label;
        button.disabled = Boolean(action.disabled);
        if (action.message) button.setAttribute("data-code-graph-action", action.message);
        actions.appendChild(button);
      }

      node.append(main, actions);
    }

    function codeGraphView(graph, stateName) {
      const files = formatCount(graph.indexedFiles || 0);
      const functions = formatCount(graph.indexedFunctions || 0);
      if (stateName === "ready") {
        return {
          label: "Indexed: " + files + " files, " + functions + " functions",
          meta: codeGraphMeta(graph),
          actions: [
            { label: "Rebuild", message: "rebuildCodeGraph", title: "Rebuild local code graph" },
            { label: "Status", message: "showCodeGraphStatus", title: "Show local code graph status" },
          ],
        };
      }
      if (stateName === "indexing") {
        const progress = graph.progress && graph.progress.total
          ? " " + formatCount(graph.progress.completed || 0) + "/" + formatCount(graph.progress.total) + " files"
          : "";
        return {
          label: "Indexing..." + progress,
          meta: graph.detail || "Indexing local C/C++ code graph.",
          actions: [{ label: "Indexing", disabled: true, title: "Indexing is already running" }],
        };
      }
      if (stateName === "stale") {
        return {
          label: "Code graph stale",
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
      vscode.postMessage({ type: button.dataset.codeGraphAction });
    }

    function codeGraphMeta(graph) {
      const parts = [];
      if (graph.largeRepoMode) parts.push("Large repo mode");
      if (graph.updatedAt) parts.push("Updated " + formatDateTime(graph.updatedAt));
      if (graph.shards) parts.push(formatCount(graph.shards) + " shards");
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
      el("refreshModels").textContent = state.loadingModels ? "..." : "Refresh";
      el("refreshModels").disabled = Boolean(state.loadingModels);
      renderModelTrigger();
      renderModelMenu();
      if (state.modelError) setNotice(state.modelError);
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
      if (!modelMenuOpen) return;

      const root = el("modelMenu");
      const composer = document.querySelector(".composer");
      if (!composer) return;

      const composerRect = composer.getBoundingClientRect();
      const triggerRect = el("modelTrigger").getBoundingClientRect();
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

    function currentModelLabel() {
      const current = state.selectedModel || "";
      if (!current) return "Use server default";
      const match = (state.models || []).find((model) => model.id === current);
      return match ? (match.name || match.modelID || match.id) : current;
    }

    function shortModelName(value) {
      if (!value) return "Server default";
      const clean = String(value).replace(/\\s+\\(manual\\)$/i, "");
      const pieces = clean.split("/");
      return pieces[pieces.length - 1] || clean;
    }

    function renderMentionChips() {
      const chips = el("chips");
      chips.innerHTML = "";
      if (el("file").checked) {
        const auto = state.autoContext || {};
        const label = auto.currentFile
          ? (el("sel").checked && auto.hasSelection ? "Selection: " : "Current: ") + auto.currentFile
          : "No current file captured";
        chips.appendChild(autoChip(label, Boolean(auto.currentFile)));
      }
      for (const file of mentionedFiles) chips.appendChild(chip(file, true));
      for (const label of state.contextFiles || []) chips.appendChild(chip({ label, uri: label }, false));
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
