import { randomBytes } from "node:crypto"
import { liquidIcon, type LiquidIconName } from "./webview/liquid-icons"

const liquidIconNames: LiquidIconName[] = [
  "chip",
  "chat",
  "sparkle",
  "add",
  "history",
  "sync",
  "settings",
  "server",
  "agent",
  "send",
  "stop",
  "pause",
  "play",
  "attach",
  "file",
  "selection",
  "diagnostics",
  "diff",
  "references",
  "refresh",
  "copy",
  "retry",
  "apply",
  "database",
  "searchIndex",
  "beaker",
  "key",
  "tool",
  "toolDisabled",
  "shield",
  "save",
  "discard",
  "close",
  "more",
]

const liquidIcons = Object.fromEntries(liquidIconNames.map((name) => [name, liquidIcon(name)])) as Record<LiquidIconName, string>
const liquidIconForScript = JSON.stringify(liquidIcons)

export function createNonce(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(length)
  let nonce = ""
  for (const byte of bytes) nonce += alphabet[byte % alphabet.length]
  return nonce
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

export function createChatViewHtml(cspSource: string, nonce = createNonce(), brandIconUri = "", mermaidScriptUri = "") {
  const escapedBrandIconUri = escapeHtmlAttribute(brandIconUri)
  const escapedMermaidScriptUri = escapeHtmlAttribute(mermaidScriptUri)
  const mermaidScriptTag = escapedMermaidScriptUri
    ? `<script nonce="${nonce}" src="${escapedMermaidScriptUri}"></script>`
    : ""
  const brandIconMarkup = escapedBrandIconUri
    ? `<img class="brandIconImage" src="${escapedBrandIconUri}" alt="" aria-hidden="true">`
    : liquidIcons.chip
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChipMate</title>
  <style>
    :root {
      color-scheme: light dark;
      --chat-content-font-size: max(12px, var(--vscode-font-size, 13px));
      --chat-user-font-size: var(--chat-content-font-size);
      --chat-code-font-size: max(11px, calc(var(--vscode-font-size, 13px) - 1px));
      --oc-accent: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
      overflow-anchor: none;
    }
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
      overscroll-behavior: none;
      overflow-anchor: none;
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
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      font-weight: 700;
      font-size: 10px;
      box-shadow: none;
    }
    .brandMark,
    .brandAvatar {
      overflow: hidden;
      padding: 0;
    }
    .brandMark .brandIconImage,
    .brandAvatar .brandIconImage {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: inherit;
    }
    .brandMark .oc-liquid-icon,
    .brandAvatar .oc-liquid-icon {
      width: 70%;
      height: 70%;
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
    .headerStatus {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
    }
    .headerStatusText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
      flex: 1;
      min-height: 0;
      gap: 8px;
      padding: 8px 9px 9px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
      align-content: flex-start;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .app.mode-connection-only .settings,
    .app.mode-settings-page .settings { display: grid; }
    .app.mode-connection-only .completionSettingsGroup,
    .app.mode-connection-only .ragSettingsGroup { display: none; }
    .app.mode-connection-only .settings,
    .app.mode-settings-page .settings { border-bottom: 0; }
    .settingsHeader { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
    .sectionTitle { min-width: 0; font-size: 11px; font-weight: 650; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .sectionMeta { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .settingsHome {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      min-width: 0;
    }
    .app.mode-connection-only .settingsHome { display: none; }
    .settingsEntry {
      min-width: 0;
      min-height: 70px;
      display: grid;
      justify-items: center;
      align-content: center;
      gap: 6px;
      padding: 9px 6px;
      color: var(--vscode-foreground);
      text-align: center;
      font-size: 11px;
    }
    .settingsEntry .oc-liquid-icon { width: 20px; height: 20px; }
    .settingsEntryLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .settingsSection {
      display: none;
      gap: 8px;
      min-width: 0;
    }
    .settingsSection.active { display: grid; }
    .app.mode-connection-only .settingsSection[data-settings-panel="connect"] { display: grid; }
    .app.mode-connection-only .settingsSection:not([data-settings-panel="connect"]) { display: none; }
    .settingsCompactLine {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .settingsStatusChip {
      width: fit-content;
      max-width: 100%;
      min-width: 0;
    }
    .settingsGrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; }
    .field { display: grid; gap: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .field input, .field select {
      width: 100%;
      min-width: 0;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 5px 7px;
    }
    .field.checkbox { display: flex; align-items: center; gap: 6px; }
    .field.checkbox input { width: auto; }
    .completionSettingsGroup,
    .ragSettingsGroup { gap: 8px; min-width: 0; }
    .completionDirectFields.hidden { display: none; }
    .skillsList {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .skillItem {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      background: var(--oc-soft-bg);
    }
    .skillItem input { margin-top: 2px; }
    .skillMain { min-width: 0; display: grid; gap: 3px; }
    .skillName { min-width: 0; font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skillDescription,
    .skillMeta,
    .comingSoonText {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .permissionModeList {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .toolsToggleButton {
      width: 100%;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 42px;
      align-items: center;
      gap: 10px;
      min-height: 54px;
      padding: 8px 9px;
      margin-bottom: 7px;
      text-align: left;
      white-space: normal;
    }
    .toolsToggleCopy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .toolsToggleTitle {
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolsToggleDesc,
    .permissionModeDisabledNote {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .toolsToggleTrack {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: 38px;
      height: 22px;
      padding: 3px;
      border-radius: 999px;
      border: 1px solid var(--oc-border);
      background: var(--vscode-input-background);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 18%, transparent);
    }
    .toolsToggleButton.is-on .toolsToggleTrack {
      justify-content: flex-end;
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-focusBorder) 36%, var(--vscode-input-background));
    }
    .toolsToggleKnob {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--vscode-foreground);
      box-shadow: 0 2px 8px color-mix(in srgb, black 28%, transparent);
    }
    .permissionModeList.is-disabled {
      opacity: 0.58;
    }
    .permissionModeButton {
      width: 100%;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 18px;
      align-items: center;
      gap: 10px;
      justify-content: flex-start;
      min-height: 58px;
      padding: 7px 9px;
      text-align: left;
      white-space: normal;
    }
    .permissionModeButton.is-active {
      box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
      background: var(--oc-soft-bg);
    }
    .permissionModeButton:disabled {
      cursor: default;
    }
    .permissionModeIcon,
    .permissionModeCheck {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      color: var(--vscode-icon-foreground);
    }
    .permissionModeButton.auto .permissionModeIcon { color: var(--vscode-testing-iconPassed, #73c991); }
    .permissionModeButton.full-access .permissionModeIcon { color: var(--vscode-editorWarning-foreground, #f97316); }
    .permissionModeCopy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .permissionModeTitle {
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .permissionModeDesc {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .ragAdvanced {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: transparent;
      overflow: hidden;
    }
    .ragAdvanced summary {
      cursor: pointer;
      padding: 8px 9px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      user-select: none;
    }
    .ragAdvanced .settingsGrid { padding: 0 9px 9px; }
    .ragActionbar {
      position: sticky;
      bottom: 0;
      justify-content: flex-start;
      padding: 7px 0 0;
      background: var(--vscode-sideBar-background);
      z-index: 2;
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
    .detail.success { color: var(--vscode-testing-iconPassed); border-left-color: var(--vscode-testing-iconPassed); }
    .body {
      position: relative;
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      overflow: hidden;
      overscroll-behavior: none;
      overflow-anchor: none;
    }
    .app.mode-connection-only .body,
    .app.mode-settings-page .body { display: none; }
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
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
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
      grid-template-columns: minmax(0, 1fr) 26px;
      align-items: center;
      gap: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      border-radius: 6px;
      padding: 4px;
    }
    .sessionRow:hover { background: var(--vscode-list-hoverBackground); }
    .sessionRow.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .sessionSelect {
      min-width: 0;
      display: grid;
      gap: 3px;
      padding: 4px;
      border-radius: 5px;
      color: inherit;
      background: transparent;
      text-align: left;
    }
    .sessionSelect:hover { background: transparent; }
    .sessionName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .sessionBadge {
      margin-left: 5px;
      color: var(--vscode-editorWarning-foreground);
      font-size: 10px;
    }
    .sessionTime { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .sessionRow.active .sessionTime { color: inherit; opacity: 0.75; }
    .sessionDelete {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      border-radius: 7px;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      opacity: 0.54;
    }
    .sessionDelete .oc-liquid-icon { width: 14px; height: 14px; }
    .sessionDelete:hover,
    .sessionDelete:focus-visible {
      color: var(--vscode-errorForeground, var(--vscode-foreground));
      opacity: 1;
    }
    .sessionEmpty { padding: 12px 8px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .chatMain {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      overscroll-behavior: none;
      overflow-anchor: none;
    }
    .messages {
      flex: 1;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      overflow-anchor: none;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 11px;
      scroll-behavior: smooth;
    }
    .jumpLatest {
      display: none;
      align-self: center;
      flex: 0 0 auto;
      margin: 0 0 6px;
      min-height: 26px;
      padding: 2px 9px;
      gap: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-focusBorder);
      box-shadow: 0 4px 14px color-mix(in srgb, black 18%, transparent);
    }
    .jumpLatest.visible { display: inline-flex; }
    .jumpLatest .oc-liquid-icon { width: 14px; height: 14px; }
    .jumpLatestText { font-size: 11px; font-weight: 650; line-height: 1; }
    .empty {
      margin: auto;
      width: min(100%, 340px);
      color: var(--vscode-descriptionForeground);
      font-size: var(--chat-content-font-size);
      line-height: 1.3;
      padding: 18px 14px;
      text-align: center;
    }
    .emptyHeroIcon {
      width: 44px;
      height: 44px;
      margin: 0 auto 10px;
      display: grid;
      place-items: center;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    .emptyHeroIcon .oc-liquid-icon { width: 34px; height: 34px; }
    .emptyTitle { color: var(--vscode-foreground); font-weight: 650; margin-bottom: 0; }
    .emptyCopy { display: none; }
    .emptyPrompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 14px; }
    .emptyPrompt {
      width: auto;
      max-width: 118px;
      min-height: 30px;
      border-radius: 10px;
      padding: 0 9px;
      font-size: 11px;
    }
    .emptyPrompt .oc-liquid-icon {
      width: 16px;
      height: 16px;
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
    .avatar.brandAvatar {
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
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
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      border-radius: 8px;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1;
      opacity: 0.62;
    }
    .messageAction .oc-liquid-icon { width: 14px; height: 14px; }
    .messageAction:hover {
      color: var(--vscode-foreground);
      opacity: 1;
    }
    .messageAction:focus-visible { opacity: 1; }
    .messageAction.copyMarkdown,
    .messageAction.collapseMessage,
    .messageAction.jumpStructure { color: var(--vscode-descriptionForeground); }
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
    .messageCard.messageCollapsed .messageOutline { display: none; }
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
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
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
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
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
      overflow-x: auto;
      overflow-y: visible;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
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
    .codeBlock,
    .diagramBlock {
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
    .diagramActions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .copyCode,
    .toggleDiagramSource {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.58;
    }
    .copyCode .oc-liquid-icon,
    .toggleDiagramSource .oc-liquid-icon { width: 14px; height: 14px; }
    .codeBlock:hover .copyCode,
    .diagramBlock:hover .copyCode,
    .diagramBlock:hover .toggleDiagramSource,
    .copyCode:focus-visible,
    .copyCode:hover,
    .toggleDiagramSource:focus-visible,
    .toggleDiagramSource:hover {
      opacity: 1;
    }
    .codeBlock pre {
      margin: 0;
      padding: 10px;
      overflow-x: auto;
      overflow-y: visible;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
      white-space: pre;
      line-height: 1.45;
    }
    .codeBlock code { font-family: var(--vscode-editor-font-family); font-size: var(--chat-code-font-size); }
    .diagramCanvas,
    .diagramSource {
      overflow-x: auto;
      overflow-y: visible;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
    }
    .diagramCanvas {
      min-height: 120px;
      display: grid;
      align-items: center;
      justify-items: center;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .diagramCanvas svg {
      max-width: 100%;
      height: auto;
    }
    .diagramStatus {
      width: 100%;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: center;
    }
    .diagramStatus.error {
      color: var(--vscode-errorForeground);
      text-align: left;
    }
    .diagramSource {
      display: none;
      margin: 0;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--chat-code-font-size);
      line-height: 1.45;
      white-space: pre;
    }
    .diagramBlock.show-source .diagramSource { display: block; }
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
      margin-top: 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, transparent);
      overflow: hidden;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .toolCard:hover,
    .toolCard:focus-within {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 42%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-focusBorder) 8%);
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
    .toolCard.reasoning.is-running summary {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .reasoningSummaryLabel {
      flex: 0 0 auto;
      color: var(--vscode-foreground);
      font-weight: 650;
    }
    .reasoningPreview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
    }
    .toolCard.reasoning.is-running .dots {
      flex: 0 0 auto;
    }
    .toolCard summary {
      cursor: pointer;
      min-height: 22px;
      padding: 2px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      outline: none;
    }
    .toolCard summary:focus-visible {
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    }
    .toolCard pre {
      margin: 0;
      padding: 6px 7px;
      overflow-x: auto;
      overflow-y: visible;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      overflow-anchor: none;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 10px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .toolCard.reasoning pre { color: var(--vscode-descriptionForeground); }
    .timelineItem.thinking .messageBody {
      min-height: 22px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
    }
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
      gap: 6px;
      min-width: 0;
      min-height: 30px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }
    .composerStatusBar::-webkit-scrollbar { display: none; }
    .composerStatusToggle {
      flex: 0 0 auto;
      width: 30px;
      min-width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      padding: 0;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
    }
    .composerToggleIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }
    .composerToggleLabel {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    .composerToggleShort { display: none; }
    .composerStatusPill {
      position: relative;
      flex: 0 0 auto;
      width: 30px;
      min-width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      padding: 0;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      font-weight: 650;
      font-size: 9px;
      line-height: 1;
      white-space: nowrap;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .composerStatusPill:hover,
    .composerStatusPill.open {
      background: color-mix(in srgb, currentColor 16%, var(--vscode-editor-background));
      border-color: var(--vscode-focusBorder, currentColor);
      box-shadow: none;
    }
    .composerStatusPill .pillText {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composerStatusPill.compactRing {
      width: 30px;
      min-width: 30px;
    }
    .statusRing {
      position: relative;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      border-radius: 999px;
      background: conic-gradient(var(--ring-fill, currentColor) var(--ring-progress, 0%), var(--ring-empty, rgba(127, 127, 127, 0.24)) 0);
      box-shadow: 0 0 0 1px var(--ring-border, rgba(127, 127, 127, 0.28)) inset;
      transition: box-shadow 120ms ease, transform 120ms ease;
    }
    .composerStatusPill:hover .statusRing,
    .composerStatusPill.open .statusRing {
      box-shadow: 0 0 0 1px var(--ring-border, rgba(127, 127, 127, 0.42)) inset, 0 0 0 2px color-mix(in srgb, currentColor 22%, transparent);
      transform: scale(1.08);
    }
    .statusRing::after {
      content: "";
      position: absolute;
      inset: 3px;
      border-radius: inherit;
      background: var(--vscode-editor-background);
      box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.08);
    }
    .statusBadge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 11px;
      height: 11px;
      padding: 0 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid var(--vscode-editor-background);
      background: currentColor;
      font-size: 8px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.18);
    }
    .statusBadgeText {
      color: var(--vscode-button-foreground);
    }
    .statusRing.indeterminate {
      --ring-progress: 32%;
    }
    .composerStatusPill.panel { color: var(--vscode-foreground); }
    .composerStatusPill.context { --ring-fill: var(--vscode-focusBorder); }
    .composerStatusPill.index.ready { color: var(--vscode-testing-iconPassed, #73c991); --ring-fill: var(--vscode-testing-iconPassed, #73c991); --ring-empty: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 42%, transparent); }
    .composerStatusPill.rag.ready { color: var(--vscode-testing-iconPassed, #73c991); --ring-fill: var(--vscode-testing-iconPassed, #73c991); --ring-empty: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 42%, transparent); }
    .composerStatusPill.index.indexing,
    .composerStatusPill.index.info { --ring-fill: var(--vscode-focusBorder); --ring-empty: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-focusBorder) 34%, transparent); }
    .composerStatusPill.rag.indexing { --ring-fill: var(--vscode-focusBorder); --ring-empty: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-focusBorder) 34%, transparent); }
    .composerStatusPill.index.warning,
    .composerStatusPill.guard.warning { color: var(--vscode-editorWarning-foreground, #cca700); --ring-fill: var(--vscode-editorWarning-foreground, #cca700); --ring-empty: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 34%, transparent); }
    .composerStatusPill.rag.warning { color: var(--vscode-editorWarning-foreground, #cca700); --ring-fill: var(--vscode-editorWarning-foreground, #cca700); --ring-empty: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 34%, transparent); }
    .composerStatusPill.usage.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
    .composerStatusPill.index.error { color: var(--vscode-errorForeground, #f48771); --ring-fill: var(--vscode-errorForeground, #f48771); --ring-empty: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 34%, transparent); }
    .composerStatusPill.rag.error { color: var(--vscode-errorForeground, #f48771); --ring-fill: var(--vscode-errorForeground, #f48771); --ring-empty: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 20%, transparent); --ring-border: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 34%, transparent); }
    .composerStatusPill.usage.error { color: var(--vscode-errorForeground, #f48771); }
    .composerStatusPill.guard.ok { color: var(--vscode-testing-iconPassed, #73c991); }
    .composerStatusPill.guard.off { color: var(--vscode-descriptionForeground); }
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
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
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
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
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
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 0 5px 5px;
    }
	    .send {
	      width: var(--composer-send-button-size);
	      min-width: var(--composer-send-button-size);
	      height: var(--composer-send-button-size);
	      min-height: var(--composer-send-button-size);
	      display: inline-flex;
	      align-items: center;
	      justify-content: center;
	      flex: 0 0 var(--composer-send-button-size);
	      border-radius: 8px;
	      padding: 0;
	    }
	    .composerHint {
      display: none;
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
	      height: 30px;
	      border: 1px solid var(--vscode-panel-border);
	      border-radius: 6px;
	      color: var(--vscode-foreground);
	      background: transparent;
	      padding: 0 8px;
	      text-align: left;
	      font-size: 11px;
	      line-height: 1;
	      overflow: hidden;
	      text-overflow: ellipsis;
	      white-space: nowrap;
	    }
	    .modelTrigger::after { content: ""; display: none; }
	    .modelTrigger:hover,
    .modelTrigger.open {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder);
    }
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
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
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
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
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
    .toggles { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 9px; }
    .toggleInput {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
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
      width: var(--composer-icon-button-size);
      min-width: var(--composer-icon-button-size);
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      padding: 0;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      line-height: 1;
    }
    .composerIconButton .oc-liquid-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      pointer-events: none;
    }
    .composerIconButton.loading .oc-liquid-icon,
    .oc-liquid-btn.is-spinning:not(.send) .oc-liquid-icon { animation: statusRingSpin 900ms linear infinite; }
    .notice { min-height: 0; color: var(--vscode-descriptionForeground); font-size: 10px; overflow-wrap: anywhere; }
    .notice:empty { display: none; }
    @media (max-width: 479px) {
      .topbar { gap: 6px; padding: 7px; }
      .icon { max-width: 52px; padding: 0 6px; }
      .primary, .secondary { padding-inline: 7px; }
      .composerActionRow { gap: 7px; }
      .toggles label { font-size: 9px; }
      .toggles input { width: 10px; height: 10px; }
      .composerIconButton { width: var(--composer-icon-button-size); min-width: var(--composer-icon-button-size); height: var(--composer-icon-button-size); padding: 0; }
      .composerToolbar {
        gap: 4px;
      }
      .settingsActions { justify-content: flex-start; }
    }
	    @media (max-width: 360px) {
	      .composerStatusToggle { width: var(--composer-icon-button-size); min-width: var(--composer-icon-button-size); padding-inline: 0; }
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
	      .composerIconButton { width: var(--composer-icon-button-size); min-width: var(--composer-icon-button-size); height: var(--composer-icon-button-size); min-height: var(--composer-icon-button-size); padding: 0; }
	      .composerHint { display: none; }
	      .send { min-width: var(--composer-icon-button-size); padding: 0; }
	      .modelTrigger { height: 30px; }
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
      @media (prefers-reduced-motion: reduce) {
        .oc-liquid-btn,
        .oc-liquid-toggle,
        .oc-liquid-chip,
        .composerStatusPill,
        .timelineItem {
          transition: none;
          animation: none;
        }
      }
    @media (forced-colors: active) {
      .messageAction,
      .messageOutlineButton,
      .diagramBlock,
      .tableBlock,
      .tableBlock th,
      .tableBlock td,
      .copyTable,
      .toggleTableRaw,
      .toggleDiagramSource,
      .composerStatusPill,
      .statusRing,
	      .statusActionButton,
	      .contextRemoveButton,
	      .composerIconButton,
	      .oc-liquid-btn,
	      .oc-liquid-toggle,
	      .oc-liquid-chip,
	      .oc-liquid-card {
	        border-color: CanvasText;
	        forced-color-adjust: auto;
	      }
      .oc-liquid-btn,
      .oc-liquid-toggle,
      .oc-liquid-chip,
      .oc-liquid-card {
        background: Canvas;
        box-shadow: none;
      }
      .messageAction:hover,
      .messageOutlineButton:hover,
      .copyTable:hover,
      .toggleTableRaw:hover {
        outline: 1px solid Highlight;
      }
    }

    /* Quiet Premium / VS Code Native Plus */
    :root {
      --oc-radius: 6px;
      --oc-radius-lg: 8px;
      --oc-border: var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border));
      --oc-muted: var(--vscode-descriptionForeground);
      --oc-icon: var(--vscode-icon-foreground, var(--vscode-foreground));
      --oc-hover-bg: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 9%, transparent));
      --oc-active-bg: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
      --oc-soft-bg: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
      --oc-warning-soft: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
      --oc-error-soft: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      --oc-user-message-accent: var(--vscode-focusBorder, var(--vscode-button-background));
      --oc-user-message-bg: color-mix(in srgb, var(--oc-user-message-accent) 12%, var(--vscode-editor-background));
      --oc-user-message-border: color-mix(in srgb, var(--oc-user-message-accent) 58%, var(--oc-border));
      --composer-icon-button-size: 24px;
      --composer-send-button-size: 34px;
    }
    .topbar {
      min-height: 48px;
      padding: 7px 8px 6px;
      gap: 8px;
      border-bottom-color: var(--oc-border);
      background: var(--vscode-sideBar-background);
    }
    .mark {
      width: 24px;
      height: 24px;
      border-radius: var(--oc-radius);
      color: var(--vscode-foreground);
      border: 1px solid var(--oc-border);
      background: transparent;
      box-shadow: none;
      font-size: 9px;
      letter-spacing: 0;
    }
    .name {
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .meta {
      font-size: 10px;
      color: var(--oc-muted);
    }
    .headerStatus { gap: 6px; font-size: 10px; }
    .iconbar { gap: 6px; }
    .headerHistoryAction {
      opacity: 0.58;
    }
    .headerHistoryAction:hover,
    .headerHistoryAction:focus-visible {
      opacity: 1;
    }
    .oc-tool-btn,
    .oc-icon-btn,
    .oc-icon-toggle,
    .oc-liquid-btn,
    .oc-liquid-toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      min-width: 26px;
      height: 26px;
      min-height: 26px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--oc-radius);
      color: var(--oc-icon);
      background: transparent;
      box-shadow: none;
      transform: none;
      overflow: visible;
      user-select: none;
      transition: background 100ms ease, border-color 100ms ease, color 100ms ease;
    }
    .topbar .oc-tool-btn,
    .topbar .oc-icon-btn,
    .topbar .oc-liquid-btn {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
    }
    .oc-tool-btn::before,
    .oc-icon-btn::before,
    .oc-icon-toggle::before,
    .oc-liquid-btn::before,
    .oc-liquid-toggle::before {
      display: none;
    }
    .oc-tool-btn:hover,
    .oc-icon-btn:hover,
    .oc-icon-toggle:hover,
    .oc-liquid-btn:hover,
    .oc-liquid-toggle:hover {
      color: var(--vscode-foreground);
      background: var(--oc-hover-bg);
      border-color: transparent;
      box-shadow: none;
      transform: none;
    }
    .oc-tool-btn:active,
    .oc-icon-btn:active,
    .oc-icon-toggle:active,
    .oc-liquid-btn:active,
    .oc-liquid-toggle:active,
    .oc-tool-btn.is-active,
    .oc-icon-btn.is-active,
    .oc-icon-toggle.is-active,
    .oc-icon-toggle[aria-pressed="true"],
    .oc-liquid-btn.is-active,
    .oc-liquid-toggle.is-active,
    .oc-liquid-toggle[aria-pressed="true"] {
      background: var(--oc-active-bg);
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 52%, transparent);
      box-shadow: none;
      transform: none;
    }
    .oc-tool-btn[disabled],
    .oc-icon-btn[disabled],
    .oc-icon-toggle[disabled],
    .oc-liquid-btn[disabled],
    .oc-liquid-toggle[disabled] {
      opacity: 0.45;
      background: transparent;
      border-color: transparent;
      transform: none;
    }
    .oc-liquid-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      pointer-events: none;
    }
    .oc-liquid-icon-disabled-slash {
      stroke: currentColor;
    }
    .oc-chip,
    .oc-liquid-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 160px;
      min-height: 26px;
      padding: 0 8px;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius);
      color: var(--vscode-foreground);
      background: transparent;
      box-shadow: none;
      overflow: hidden;
    }
    .oc-chip:hover,
    .oc-liquid-chip:hover,
    .oc-chip.open,
    .oc-liquid-chip.open {
      background: var(--oc-hover-bg);
      border-color: var(--vscode-widget-border, var(--oc-border));
    }
    .oc-chip.is-active,
    .oc-liquid-chip.is-active {
      background: var(--oc-active-bg);
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 62%, var(--oc-border));
      box-shadow: none;
    }
    .oc-chip .oc-liquid-icon,
    .oc-liquid-chip .oc-liquid-icon {
      width: 16px;
      height: 16px;
    }
    .oc-chip-label,
    .oc-liquid-chip-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1;
    }
    .oc-badge,
    .oc-liquid-badge,
    .statusBadge {
      flex: 0 0 auto;
      min-width: 14px;
      height: 14px;
      padding: 0 4px;
      border-radius: 999px;
      border: 1px solid var(--vscode-sideBar-background);
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 9px;
      font-weight: 650;
      line-height: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: none;
    }
    .statusBadgeText { color: inherit; }
    .oc-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--oc-muted);
      box-shadow: 0 0 0 1px var(--vscode-sideBar-background);
    }
    .oc-status-dot.connected { background: var(--vscode-testing-iconPassed); }
    .oc-status-dot.connecting { background: var(--vscode-progressBar-background); }
    .oc-status-dot.authFailed,
    .oc-status-dot.error { background: var(--vscode-errorForeground); }
    .oc-primary-btn,
    .primary {
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: var(--oc-radius);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 500;
    }
    .oc-primary-btn:hover,
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .oc-settings-tile,
    .settingsEntry {
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      padding: 0 10px;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      box-shadow: none;
    }
    .oc-settings-tile:hover,
    .settingsEntry:hover { background: var(--oc-hover-bg); }
    .oc-settings-tile.is-active,
    .settingsEntry.is-active {
      border-color: var(--oc-border);
      box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
      background: var(--oc-soft-bg);
    }
    .settings.settings-page .settingsEntry[data-settings-section="connect"].is-active {
      background: transparent;
      color: var(--oc-muted);
    }
    .settingsEntry .oc-liquid-icon {
      width: 16px;
      height: 16px;
    }
    .settingsEntryLabel {
      font-size: 12px;
      font-weight: 600;
    }
    .oc-liquid-card {
      border-radius: var(--oc-radius-lg);
      border: 1px solid var(--oc-border);
      background: transparent;
      box-shadow: none;
    }
    .oc-liquid-actionbar,
    .ragActionbar {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      background: var(--vscode-sideBar-background);
      box-shadow: none;
    }
    .settings {
      padding: 10px;
      gap: 10px;
      border-bottom-color: var(--oc-border);
      background: var(--vscode-sideBar-background);
    }
    .settingsHeader {
      min-height: 24px;
      align-items: center;
    }
    .sectionTitle {
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 650;
      text-transform: none;
    }
    .sectionMeta {
      color: var(--oc-muted);
      font-size: 11px;
    }
    .settingsHome {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .settingsSection {
      gap: 10px;
      border-left: 2px solid transparent;
      padding-left: 0;
    }
    .settingsSection.active {
      border-left-color: color-mix(in srgb, var(--vscode-focusBorder) 68%, transparent);
      padding-left: 8px;
    }
    .app.mode-connection-only .settingsSection.active {
      border-left-color: transparent;
      padding-left: 0;
    }
    .settingsGrid { gap: 8px; }
    .field {
      gap: 4px;
      color: var(--oc-muted);
      font-size: 11px;
    }
    .field input,
    .field select,
    .manualModel input {
      height: 32px;
      padding: 0 8px;
      border: 1px solid var(--vscode-input-border, var(--oc-border));
      border-radius: var(--oc-radius);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    .field.checkbox {
      min-height: 24px;
      color: var(--vscode-foreground);
    }
    .settingsActions {
      gap: 8px;
      justify-content: flex-start;
      align-items: center;
      flex-wrap: wrap;
    }
    .settingsActions > .row { flex: 0 0 auto; }
    .connectionActions,
    .settingsActions .row {
      gap: 6px;
    }
    .settingsActions .oc-icon-btn,
    .settingsActions .oc-liquid-btn,
    .ragActionbar .oc-icon-btn,
    .ragActionbar .oc-liquid-btn {
      width: 30px;
      min-width: 30px;
      height: 30px;
      min-height: 30px;
    }
    #connect {
      min-height: 32px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: transparent;
    }
    #connect:hover { background: var(--vscode-button-hoverBackground); }
    .detail {
      padding-left: 9px;
      border-left: 2px solid var(--oc-border);
      color: var(--oc-muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .detail.authFailed,
    .detail.error { color: var(--vscode-errorForeground); border-left-color: var(--vscode-errorForeground); background: transparent; }
    .detail.success { color: var(--vscode-testing-iconPassed); border-left-color: var(--vscode-testing-iconPassed); }
    .settingsStatusChip {
      min-height: 22px;
      max-width: 148px;
      color: var(--oc-muted);
    }
    .settingsStatusChip.warning,
    .settingsStatusChip.error {
      color: var(--vscode-editorWarning-foreground);
      border-color: var(--vscode-inputValidation-warningBorder, var(--oc-border));
      background: var(--oc-warning-soft);
    }
    .ragAdvanced {
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius);
      background: transparent;
    }
    .ragAdvanced summary {
      min-height: 28px;
      padding: 6px 8px;
      color: var(--vscode-foreground);
      font-size: 12px;
    }
    .ragActionbar {
      position: sticky;
      bottom: 0;
      padding: 8px 0 0;
    }
    .messages {
      padding: 14px 10px;
      gap: 12px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .empty {
      width: min(100%, 330px);
      padding: 10px 8px;
      color: var(--oc-muted);
      text-align: center;
    }
    .emptyHeroIcon {
      width: 36px;
      height: 36px;
      margin: 0 auto 8px;
      border: 0;
      background: transparent;
      color: var(--oc-muted);
    }
    .emptyHeroIcon .oc-liquid-icon {
      width: 30px;
      height: 30px;
    }
    .emptyTitle {
      margin: 0;
      color: var(--vscode-foreground);
      font-size: 15px;
      font-weight: 650;
    }
    .emptyPrompts {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 5px;
      margin-top: 14px;
    }
    .emptyCommand,
    .emptyPrompt {
      width: 100%;
      max-width: none;
      min-height: 38px;
      justify-content: flex-start;
      border-color: transparent;
      color: var(--vscode-foreground);
      background: transparent;
    }
    .emptyCommand {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border: 1px solid transparent;
      border-radius: var(--oc-radius);
      text-align: left;
      transition: background 100ms ease, border-color 100ms ease;
    }
    .emptyCommand:hover,
    .emptyCommand:focus-visible,
    .emptyPrompt:hover {
      background: var(--oc-hover-bg);
    }
    .emptyCommandIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--oc-muted);
    }
    .emptyCommandIcon .oc-liquid-icon {
      width: 16px;
      height: 16px;
    }
    .emptyCommandMain {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .emptyCommandTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.15;
    }
    .emptyCommandCaption {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.15;
    }
    .emptyCommandArrow {
      color: var(--oc-muted);
      font-size: 14px;
      line-height: 1;
      justify-self: end;
      transition: transform 100ms ease, color 100ms ease;
    }
    .emptyCommand:hover .emptyCommandArrow,
    .emptyCommand:focus-visible .emptyCommandArrow {
      color: var(--vscode-foreground);
      transform: translateX(2px);
    }
    .recentSessions { display: none; }
    .timelineItem {
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 6px;
      padding: 1px 0;
    }
    .timelineItem.user {
      grid-template-columns: minmax(0, 1fr) 22px;
      gap: 8px;
      margin: 4px 0 8px;
    }
    .timelineItem.assistant + .timelineItem.user,
    .timelineItem.tool + .timelineItem.user {
      margin-top: 14px;
    }
    .avatar {
      width: 18px;
      height: 18px;
      border-radius: var(--oc-radius);
      color: var(--oc-muted);
      background: transparent;
      border: 1px solid var(--oc-border);
      font-size: 8px;
      box-shadow: none;
    }
    .timelineItem.user .avatar {
      grid-column: 2;
      width: 22px;
      height: 22px;
      justify-self: end;
      color: var(--vscode-badge-foreground);
      background: var(--oc-user-message-border);
      border-color: var(--oc-user-message-border);
      font-size: 7px;
      font-weight: 700;
    }
    .timelineItem.error .avatar {
      color: var(--oc-muted);
      background: transparent;
      border-color: var(--oc-border);
    }
    .messageCard {
      min-width: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      overflow: visible;
    }
    .timelineItem.user .messageCard {
      grid-column: 1;
      grid-row: 1;
      justify-self: end;
      width: min(100%, 560px);
      border: 1px solid var(--oc-user-message-border);
      border-radius: var(--oc-radius-lg);
      background: var(--oc-user-message-bg);
      box-shadow: inset -2px 0 0 var(--oc-user-message-border);
      overflow: hidden;
    }
    .timelineItem.error .messageCard {
      border-left: 2px solid var(--vscode-errorForeground);
      padding-left: 8px;
    }
    .messageMeta {
      padding: 0 0 4px;
      border-bottom: 0;
      color: var(--oc-muted);
      background: transparent;
      font-size: 10px;
    }
    .messageRole {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .timelineItem.user .messageMeta {
      padding: 6px 9px 3px;
      color: var(--vscode-foreground);
    }
    .timelineItem.user .messageRole {
      display: inline-flex;
      align-items: center;
      min-height: 18px;
      padding: 0 6px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--oc-user-message-border);
      font-size: 10px;
      font-weight: 650;
      line-height: 1;
    }
    .messageBody {
      padding: 0;
      line-height: 1.55;
    }
    .timelineItem.user .messageBody {
      padding: 4px 10px 9px;
      color: var(--vscode-foreground);
      font-size: var(--chat-user-font-size);
      line-height: 1.48;
    }
    .messageActions,
    .tableActions,
    .diagramActions {
      opacity: 0;
      transition: opacity 100ms ease;
    }
    .timelineItem:hover .messageActions,
    .timelineItem:focus-within .messageActions,
    .tableBlock:hover .tableActions,
    .tableBlock:focus-within .tableActions,
    .diagramBlock:hover .diagramActions,
    .diagramBlock:focus-within .diagramActions {
      opacity: 1;
    }
    .messageAction,
    .copyCode,
    .copyTable,
    .toggleTableRaw,
    .toggleDiagramSource {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--oc-radius);
      color: var(--oc-muted);
      background: transparent;
      opacity: 1;
    }
    .messageAction:hover,
    .copyCode:hover,
    .copyTable:hover,
    .toggleTableRaw:hover,
    .toggleDiagramSource:hover {
      color: var(--vscode-foreground);
      background: var(--oc-hover-bg);
    }
    .codeBlock,
    .diagramBlock,
    .tableBlock,
    .toolCard {
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius);
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      box-shadow: none;
    }
    .codeHead,
    .tableToolbar {
      min-height: 28px;
      padding: 3px 6px;
      border-bottom: 1px solid var(--oc-border);
      background: var(--vscode-sideBar-background);
    }
    .copyCode,
    .toggleDiagramSource { opacity: 0; }
    .codeBlock:hover .copyCode,
    .codeBlock:focus-within .copyCode,
    .diagramBlock:hover .copyCode,
    .diagramBlock:focus-within .copyCode,
    .diagramBlock:hover .toggleDiagramSource,
    .diagramBlock:focus-within .toggleDiagramSource,
    .copyCode:focus-visible,
    .toggleDiagramSource:focus-visible { opacity: 1; }
    .composerWrap {
      position: relative;
      container-name: composer-shell;
      container-type: inline-size;
      gap: 4px;
      padding: 5px 6px 6px;
      border-top-color: var(--oc-border);
      background: var(--vscode-sideBar-background);
    }
    .composerStatusBar {
      position: static;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: wrap;
      min-width: 0;
      min-height: 30px;
      gap: 4px;
      overflow: visible;
      opacity: 1;
    }
    .composerWrap.collapsed {
      min-height: 36px;
    }
    .composerWrap.collapsed .composerStatusBar {
      justify-content: flex-start;
    }
    .composerStatusToggle,
    .composerStatusPill,
    .composerIconButton,
    .toggles .oc-liquid-toggle,
    .toggles .oc-icon-toggle {
      width: var(--composer-icon-button-size);
      min-width: var(--composer-icon-button-size);
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
      border-radius: var(--oc-radius);
    }
    .composerStatusToggle {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
    }
    .composerSupportRail {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
      min-width: 0;
    }
    .composerSupportRail .composerStatusPill {
      width: var(--composer-icon-button-size);
      min-width: var(--composer-icon-button-size);
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
      color: var(--oc-muted);
    }
    .composerStatusPill.is-hidden,
    .composerStatusPill[hidden] {
      display: none;
    }
    .composerStatusPill .oc-liquid-icon,
    .composerIconButton .oc-liquid-icon,
    .toggles .oc-liquid-toggle .oc-liquid-icon,
    .toggles .oc-icon-toggle .oc-liquid-icon {
      width: 16px;
      height: 16px;
    }
    .composerStatusPill.hasText .pillText {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 0;
      width: 100%;
    }
    .composerStatusPill.hasText .pillGlyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 15px;
      height: 15px;
    }
    .composerStatusPill.hasText .pillGlyph .oc-liquid-icon {
      width: 15px;
      height: 15px;
    }
    .composerStatusPill.hasText .pillLabelText {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composerStatusPill:hover,
    .composerStatusPill.open {
      background: var(--oc-hover-bg);
      border-color: transparent;
      box-shadow: none;
      transform: none;
    }
    .statusRing {
      width: 16px;
      height: 16px;
      background: conic-gradient(var(--ring-fill, currentColor) var(--ring-progress, 0%), var(--ring-empty, color-mix(in srgb, currentColor 18%, transparent)) 0);
      box-shadow: 0 0 0 1px var(--ring-border, color-mix(in srgb, currentColor 30%, transparent)) inset;
    }
    .statusRing::after {
      display: block;
      inset: 2px;
      z-index: 0;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 10%, transparent);
    }
    .statusRing .oc-liquid-icon {
      position: relative;
      z-index: 1;
      width: 12px;
      height: 12px;
    }
    .composerPanel { gap: 5px; }
    .composer {
      gap: 0;
      container-name: composer;
      container-type: inline-size;
      border: 1px solid var(--vscode-input-border, var(--oc-border));
      border-radius: var(--oc-radius-lg);
      background: var(--vscode-input-background);
    }
    .composer:focus-within {
      border-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent);
    }
    .composer textarea {
      min-height: 38px;
      max-height: 108px;
      padding: 8px 9px 5px;
      font-size: var(--chat-content-font-size);
      line-height: 1.35;
    }
    .composerToolbar {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: 40px;
      padding: 0 6px 6px;
      overflow: visible;
    }
    .composerPrimaryRail {
      border-top: 1px solid color-mix(in srgb, var(--oc-border) 70%, transparent);
      padding-top: 6px;
    }
    .composerPickerRail {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 0;
      flex-wrap: wrap;
      min-width: 0;
    }
    .composerPickerRail .permissionTrigger,
    .composerPickerRail .skillsTrigger {
      width: auto;
      height: 28px;
      min-height: 28px;
      padding: 0 8px;
      border-radius: 999px;
      border-color: var(--oc-border);
      background: transparent;
    }
    .composerPickerRail .permissionTrigger {
      flex: 0 0 118px;
      min-width: 102px;
      max-width: 132px;
    }
    .composerPickerRail .skillsTrigger {
      flex: 0 1 96px;
      min-width: 76px;
      max-width: 112px;
    }
    .composerPickerRail .skillsTrigger.is-empty {
      display: none;
    }
    .composerPickerRail .modelTrigger {
      flex: 1 1 132px;
      width: auto;
      min-width: 84px;
      max-width: 180px;
    }
    .composerPickerRail .agentTrigger {
      flex: 1 1 112px;
      width: auto;
      min-width: 76px;
      max-width: 150px;
    }
    .composerToolbar .send {
      flex: 0 0 var(--composer-send-button-size);
      margin-inline-start: auto;
    }
    .composerToolbar .oc-liquid-chip-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .modelTrigger {
      height: 28px;
      min-height: 28px;
      padding: 0 8px;
      border-color: var(--oc-border);
      background: transparent;
    }
    .modelTrigger:hover,
    .modelTrigger.open,
    .permissionTrigger:hover,
    .permissionTrigger.open,
    .skillsTrigger:hover,
    .skillsTrigger.open { background: var(--oc-hover-bg); }
    .agentTrigger.ready { border-color: var(--oc-border); }
    .agentTrigger.warning,
    .modelTrigger.warning {
      color: var(--vscode-editorWarning-foreground);
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 48%, var(--oc-border));
      background: transparent;
    }
    .composerPickerRail .agentTrigger.warning,
    .composerPickerRail .modelTrigger.warning {
      flex: 0 0 102px;
      width: 102px;
      min-width: 92px;
      max-width: 110px;
    }
    .agentTrigger.warning .oc-liquid-chip-label,
    .modelTrigger.warning .oc-liquid-chip-label {
      color: var(--vscode-editorWarning-foreground);
    }
    .permissionTrigger.ask {
      color: var(--vscode-focusBorder, var(--vscode-icon-foreground));
      border-color: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 38%, var(--oc-border));
    }
    .permissionTrigger.auto {
      color: var(--vscode-testing-iconPassed, #73c991);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 44%, var(--oc-border));
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 8%, transparent);
    }
    .permissionTrigger.full-access {
      color: var(--vscode-editorWarning-foreground, #f97316);
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #f97316) 56%, var(--oc-border));
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #f97316) 10%, transparent);
    }
    .permissionTrigger.tools-off {
      color: var(--vscode-descriptionForeground);
      border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 34%, var(--oc-border));
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 6%, transparent);
    }
    .skillsTrigger {
      color: var(--oc-muted);
    }
    .composerActionRow {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 0;
      padding: 3px 1px 0;
    }
    .toggles {
      padding: 0;
    }
    .toggles .oc-liquid-toggle,
    .toggles .oc-icon-toggle,
    .composerIconButton {
      flex: 0 0 var(--composer-icon-button-size);
    }
    .send {
      width: var(--composer-send-button-size);
      min-width: var(--composer-send-button-size);
      height: var(--composer-send-button-size);
      min-height: var(--composer-send-button-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 var(--composer-send-button-size);
      padding: 0;
      border-radius: 8px;
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--vscode-button-background) 62%, var(--oc-border));
      background: var(--vscode-button-background);
    }
    .send .oc-liquid-icon {
      width: 18px;
      height: 18px;
    }
    .send:hover,
    .send:focus-visible {
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 68%, var(--vscode-button-background));
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    }
    .send[disabled] {
      color: var(--oc-muted);
      border-color: transparent;
      background: transparent;
      opacity: 0.48;
    }
    .send[disabled]:hover,
    .send[disabled]:focus-visible {
      color: var(--oc-muted);
      border-color: transparent;
      background: transparent;
    }
    .composerActions {
      flex: 0 0 auto;
      min-width: 0;
      padding-top: 1px;
    }
    .composerSecondaryAction {
      opacity: 0.68;
    }
    .composerSecondaryAction:hover,
    .composerSecondaryAction:focus-visible {
      opacity: 1;
    }
    .composerProgress {
      display: none;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      padding: 0 7px 6px;
      color: var(--oc-muted);
      font-size: 9px;
    }
    .composerProgress.visible {
      display: grid;
    }
    .composerProgressTrack {
      height: 2px;
      min-width: 0;
      overflow: hidden;
      border-radius: 999px;
      background: color-mix(in srgb, var(--oc-muted) 24%, transparent);
    }
    .composerProgressFill {
      width: var(--composer-context-progress, 0%);
      height: 100%;
      border-radius: inherit;
      background: var(--vscode-focusBorder);
    }
    .composerProgress.warning .composerProgressFill {
      background: var(--vscode-editorWarning-foreground);
    }
    .composerProgress.error .composerProgressFill {
      background: var(--vscode-errorForeground);
    }
    .composerProgressLabel {
      white-space: nowrap;
      color: var(--oc-muted);
    }
    .notice {
      min-height: 14px;
      color: var(--oc-muted);
      font-size: 11px;
    }
    .sendSpinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, currentColor 34%, transparent);
      border-top-color: currentColor;
      animation: statusRingSpin 800ms linear infinite;
    }
    .modelMenu,
    .suggestions,
    .composerStatusPopover {
      border: 1px solid var(--vscode-widget-border, var(--oc-border));
      border-radius: var(--oc-radius);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 2px 8px color-mix(in srgb, black 16%, transparent);
    }
    .composerStatusPopover.permissionPopover {
      left: 8px;
      right: auto;
      width: min(320px, calc(100vw - 24px));
      max-width: none;
      overflow-x: hidden;
      padding: 10px;
      border-radius: 14px;
      box-shadow: 0 12px 34px color-mix(in srgb, black 26%, transparent);
    }
    .composerStatusPopover.permissionPopover .toolsToggleButton.oc-liquid-btn {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 42px;
      align-items: center;
      justify-content: stretch;
      gap: 10px;
      width: 100%;
      max-width: none;
      min-width: 0;
      height: auto;
      min-height: 54px;
      padding: 8px 9px;
      text-align: left;
      white-space: normal;
      overflow: visible;
    }
    .composerStatusPopover.permissionPopover .toolsToggleCopy {
      min-width: 0;
      overflow: hidden;
    }
    .composerStatusPopover.permissionPopover .toolsToggleTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composerStatusPopover.permissionPopover .toolsToggleDesc,
    .composerStatusPopover.permissionPopover .permissionModeDesc,
    .composerStatusPopover.permissionPopover .permissionModeDisabledNote {
      word-break: normal;
      overflow-wrap: anywhere;
    }
    .composerStatusPopover.permissionPopover .permissionModeButton.oc-liquid-btn {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 18px;
      align-items: center;
      justify-content: stretch;
      gap: 10px;
      width: 100%;
      max-width: none;
      min-width: 0;
      height: auto;
      min-height: 58px;
      padding: 7px 9px;
      text-align: left;
      white-space: normal;
      overflow: visible;
    }
    .composerStatusPopover.permissionPopover .permissionModeCopy {
      min-width: 0;
      overflow: hidden;
    }
    .composerStatusPopover.permissionPopover .permissionModeIcon,
    .composerStatusPopover.permissionPopover .permissionModeCheck {
      flex: 0 0 auto;
    }
    @media (max-width: 360px) {
      .composerStatusPopover.permissionPopover {
        left: 6px;
        width: min(308px, calc(100vw - 18px));
        padding: 8px;
      }
      .composerStatusPopover.permissionPopover .toolsToggleButton.oc-liquid-btn {
        grid-template-columns: 20px minmax(0, 1fr) 38px;
        gap: 7px;
        min-height: 52px;
        padding: 7px;
      }
      .composerStatusPopover.permissionPopover .permissionModeButton.oc-liquid-btn {
        grid-template-columns: 20px minmax(0, 1fr) 16px;
        gap: 7px;
        min-height: 54px;
        padding: 7px;
      }
    }
    .suggestion {
      width: 100%;
      border: 0;
      border-radius: 0;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }
    .suggestion:hover,
    .suggestion.active,
    .suggestion:focus-visible {
      background: var(--vscode-list-hoverBackground);
    }
    .codeIntel,
    .codeGraph {
      border-color: var(--oc-border);
      border-radius: var(--oc-radius);
      background: transparent;
      box-shadow: none;
    }
    .codeIntelAction,
    .codeIntelJump,
    .statusActionButton,
    .statusActionButton.primary,
    .contextRemoveButton {
      min-height: 24px;
      border: 1px solid transparent;
      border-radius: var(--oc-radius);
      color: var(--oc-icon);
      background: transparent;
    }
    .codeIntelAction:hover,
    .codeIntelJump:hover,
    .statusActionButton:hover,
    .statusActionButton.primary:hover,
    .contextRemoveButton:hover {
      color: var(--vscode-foreground);
      background: var(--oc-hover-bg);
    }
    @media (max-width: 479px) {
      .composerToolbar {
        gap: 4px;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .permissionTrigger,
      .composerPickerRail .skillsTrigger {
        flex-grow: 1;
        min-width: 74px;
        max-width: 132px;
      }
      .composerActionRow {
        gap: 4px;
      }
      .composerSupportRail { gap: 2px; }
      .composerSupportRail .composerStatusPill {
        width: var(--composer-icon-button-size);
        min-width: var(--composer-icon-button-size);
      }
      .settingsActions { justify-content: flex-start; }
    }
    @media (max-width: 300px) {
      .topbar .oc-liquid-btn,
      .topbar .oc-icon-btn {
        width: 24px;
        min-width: 24px;
        height: 24px;
      }
      .composerStatusToggle,
      .composerStatusPill,
      .composerIconButton,
      .toggles .oc-liquid-toggle {
        width: var(--composer-icon-button-size);
        min-width: var(--composer-icon-button-size);
        height: var(--composer-icon-button-size);
      }
    }
    @container composer (max-width: 420px) {
      .composerToolbar {
        gap: 5px;
      }
      .composerPickerRail {
        flex-wrap: nowrap;
        gap: 5px;
      }
      .composerPickerRail .permissionTrigger,
      .composerPickerRail .skillsTrigger {
        flex: 0 0 30px;
        width: 30px;
        min-width: 30px;
        max-width: 30px;
        justify-content: center;
        padding: 0;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .agentTrigger.warning,
      .composerPickerRail .modelTrigger.warning {
        flex: 1 1 96px;
        width: auto;
        min-width: 74px;
        max-width: none;
        justify-content: flex-start;
        padding: 0 8px;
      }
      .composerPickerRail .permissionTrigger .pillLabelText,
      .composerPickerRail .skillsTrigger .pillLabelText {
        display: none;
      }
      .composerToolbar .send {
        margin-inline-start: 0;
      }
    }
    @container composer (max-width: 300px) {
      .composerPickerRail {
        gap: 4px;
      }
      .composerPickerRail .permissionTrigger {
        flex-basis: 28px;
        width: 28px;
        min-width: 28px;
        max-width: 28px;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .skillsTrigger,
      .composerPickerRail .agentTrigger.warning,
      .composerPickerRail .modelTrigger.warning {
        flex-basis: 28px;
        width: 28px;
        min-width: 28px;
        max-width: 28px;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .skillsTrigger,
      .composerPickerRail .agentTrigger.warning,
      .composerPickerRail .modelTrigger.warning {
        justify-content: center;
        padding: 0;
      }
      .composerPickerRail .modelTrigger .oc-liquid-chip-label,
      .composerPickerRail .agentTrigger .oc-liquid-chip-label {
        display: none;
      }
    }
    @media (forced-colors: active) {
      .oc-tool-btn,
      .oc-icon-btn,
      .oc-icon-toggle,
      .oc-chip,
      .oc-badge,
      .oc-primary-btn,
      .oc-settings-tile,
      .oc-liquid-btn,
      .oc-liquid-toggle,
      .oc-liquid-chip,
      .settingsEntry,
      .emptyCommand,
      .composerProgressTrack,
      .messageCard,
      .codeBlock,
      .diagramBlock,
      .tableBlock,
      .composer {
        forced-color-adjust: auto;
        border-color: CanvasText;
        box-shadow: none;
      }
      .oc-tool-btn:hover,
      .oc-icon-btn:hover,
      .oc-icon-toggle:hover,
      .oc-liquid-btn:hover,
      .oc-liquid-toggle:hover,
      .emptyCommand:hover,
      .emptyPrompt:hover {
        background: Highlight;
        color: HighlightText;
      }
      .oc-status-dot {
        border: 1px solid CanvasText;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <div id="app" class="app mode-connection-only history-closed history-narrow">
    <header class="topbar">
      <div class="mark brandMark" aria-hidden="true">${brandIconMarkup}</div>
      <div class="title">
        <div class="name">ChipMate</div>
        <div class="meta">
          <span class="headerStatus"><span id="statusDot" class="oc-status-dot"></span><span id="server" class="server headerStatusText">ChipMate UI loading...</span></span>
        </div>
      </div>
      <div class="iconbar">
        <button id="historyToggle" class="oc-icon-btn oc-liquid-btn headerHistoryAction" type="button" title="History" aria-label="History">${liquidIcons.history}<span class="srOnly">History</span></button>
        <button id="newSession" class="oc-icon-btn oc-liquid-btn" type="button" title="New session" aria-label="New session">${liquidIcons.add}<span class="srOnly">New session</span></button>
        <button id="syncState" class="oc-icon-btn oc-liquid-btn" type="button" title="Refresh chat state" aria-label="Refresh chat state">${liquidIcons.refresh}<span class="srOnly">Refresh chat state</span></button>
        <button id="settingsToggle" class="oc-icon-btn oc-liquid-btn" type="button" title="ChipMate settings" aria-label="ChipMate settings">${liquidIcons.settings}<span class="srOnly">ChipMate settings</span></button>
      </div>
    </header>
    <section id="settings" class="settings" aria-label="ChipMate settings">
      <div class="settingsHeader">
        <div class="sectionTitle">Settings</div>
        <div class="sectionMeta">ChipMate</div>
      </div>
      <div class="settingsHome" role="tablist" aria-label="Settings sections">
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="connect" role="tab" aria-selected="true">${liquidIcons.chip}<span class="settingsEntryLabel">Provider</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="complete" role="tab" aria-selected="false">${liquidIcons.sparkle}<span class="settingsEntryLabel">Complete</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="skills" role="tab" aria-selected="false">${liquidIcons.references}<span class="settingsEntryLabel">Skills</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="rag" role="tab" aria-selected="false">${liquidIcons.database}<span class="settingsEntryLabel">RAG</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="guard" role="tab" aria-selected="false">${liquidIcons.shield}<span class="settingsEntryLabel">Guard</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="mcp" role="tab" aria-selected="false">${liquidIcons.agent}<span class="settingsEntryLabel">MCP</span></button>
      </div>
      <div id="connectionSettingsGroup" class="settingsSection active" data-settings-panel="connect" role="tabpanel">
        <div class="settingsHeader">
          <div class="sectionTitle">Provider</div>
          <div class="sectionMeta">OpenAI-compatible</div>
        </div>
        <div class="settingsGrid">
          <label class="field">API Base URL<input id="serverUrl" type="url" spellcheck="false" placeholder="http://localhost:8000/v1"></label>
          <label class="field">Chat model<input id="username" type="text" spellcheck="false" autocomplete="off" placeholder="gpt-4.1"></label>
          <label class="field">API key<input id="password" type="password" autocomplete="off" placeholder="Leave empty to keep existing key"></label>
        </div>
        <div class="row settingsActions connectionActions">
          <button id="connect" class="oc-primary-btn oc-liquid-chip" type="button" title="Save provider settings">${liquidIcons.chip}<span class="oc-liquid-chip-label">Save</span></button>
          <button id="test" class="oc-icon-btn oc-liquid-btn" type="button" title="Test provider connection" aria-label="Test provider connection">${liquidIcons.beaker}<span class="srOnly">Test provider connection</span></button>
          <button id="refresh" class="oc-icon-btn oc-liquid-btn" type="button" title="Refresh chat state" aria-label="Refresh chat state">${liquidIcons.refresh}<span class="srOnly">Refresh chat state</span></button>
          <button id="openOutput" class="oc-icon-btn oc-liquid-btn" type="button" title="Open output log" aria-label="Open output log">${liquidIcons.file}<span class="srOnly">Open output log</span></button>
        </div>
        <div id="connectionDetail" class="detail visible" aria-live="polite">If this message does not change, the Webview script did not start.</div>
      </div>
      <div id="completionSettingsGroup" class="settingsSection completionSettingsGroup" data-settings-panel="complete" role="tabpanel">
        <div class="settingsHeader">
          <div class="sectionTitle">Complete</div>
          <div class="sectionMeta">Completion model</div>
        </div>
        <div class="settingsGrid">
          <label class="field checkbox"><input id="completionEnabled" type="checkbox"><span>Enable inline completion</span></label>
          <label class="field">Provider<select id="completionProvider">
            <option value="openai-compatible">OpenAI-compatible</option>
          </select></label>
          <div id="completionDirectFields" class="completionDirectFields hidden">
            <label class="field">Profile<select id="completionProfile">
              <option value="generic-chat">Generic Chat</option>
              <option value="qwen-coder-fim">Qwen Coder FIM</option>
            </select></label>
            <input id="completionApiBaseUrl" type="hidden">
            <label class="field">Model<input id="completionModel" type="text" spellcheck="false" placeholder="qwen-coder-30b0"></label>
            <label class="field">Max tokens<input id="completionMaxTokens" type="number" min="1" max="4096" step="1"></label>
            <label class="field">Temperature<input id="completionTemperature" type="number" min="0" max="2" step="0.1"></label>
            <label class="field">Top P<input id="completionTopP" type="number" min="0" max="1" step="0.05"></label>
          </div>
        </div>
        <div class="row settingsActions">
          <div class="row">
            <button id="saveCompletionSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Save inline completion settings" aria-label="Save inline completion settings">${liquidIcons.save}<span class="srOnly">Save inline completion settings</span></button>
            <button id="testCompletionApi" class="oc-icon-btn oc-liquid-btn" type="button" title="Test completion API" aria-label="Test completion API">${liquidIcons.beaker}<span class="srOnly">Test completion API</span></button>
          </div>
        </div>
        <div id="completionDetail" class="detail" aria-live="polite"></div>
      </div>
      <div id="skillsSettingsGroup" class="settingsSection" data-settings-panel="skills" role="tabpanel">
        <div class="settingsHeader">
          <div class="settingsCompactLine">${liquidIcons.references}<div class="sectionTitle">Skills</div></div>
          <div id="skillsSettingsStatus" class="sectionMeta">Workspace</div>
        </div>
        <div id="skillsList" class="skillsList"></div>
        <div class="row settingsActions">
          <button id="saveSkillsSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Save enabled skills" aria-label="Save enabled skills">${liquidIcons.save}<span class="srOnly">Save enabled skills</span></button>
        </div>
        <div id="skillsDetail" class="detail visible" aria-live="polite">Skills are discovered from .agents/skills/*/SKILL.md.</div>
      </div>
      <div id="ragSettingsGroup" class="settingsSection ragSettingsGroup" data-settings-panel="rag" role="tabpanel">
        <div class="settingsHeader">
          <div class="settingsCompactLine">${liquidIcons.database}<div class="sectionTitle">RAG</div></div>
          <span id="ragCompactStatus" class="settingsStatusChip oc-chip oc-liquid-chip" title="RAG status">${liquidIcons.diagnostics}<span class="oc-liquid-chip-label">off</span></span>
        </div>
        <div class="settingsGrid">
          <label class="field">Embedding endpoint<input id="ragEmbeddingEndpoint" type="url" spellcheck="false" placeholder="http://127.0.0.1:8000/v1/embeddings"></label>
          <label class="field">Embedding model<input id="ragEmbeddingModel" type="text" spellcheck="false" placeholder="qwen3-embedding-8b"></label>
          <label class="field">Rerank endpoint<input id="ragRerankEndpoint" type="url" spellcheck="false" placeholder="http://127.0.0.1:8000/rerank"></label>
          <label class="field">Rerank model<input id="ragRerankModel" type="text" spellcheck="false" placeholder="qwen3-reranker-8b"></label>
        </div>
        <details class="ragAdvanced">
          <summary>Advanced</summary>
          <div class="settingsGrid">
            <label class="field">Batch size<select id="ragEmbeddingBatchSize" title="Embedding request timeout is automatic: 1-256 use 60s, 512 uses 90s"><option value="1">1</option><option value="5">5</option><option value="10">10</option><option value="32">32</option><option value="64">64</option><option value="128">128</option><option value="256">256</option><option value="512">512</option></select></label>
            <label class="field">Max tokens/request<input id="ragEmbeddingMaxTokensPerRequest" type="number" min="1" max="1000000" step="1024"></label>
            <label class="field">Concurrent requests<input id="ragEmbeddingConcurrentRequests" type="number" min="1" max="8" step="1"></label>
            <label class="field">Max in-flight tokens<input id="ragEmbeddingMaxInFlightTokens" type="number" min="32768" max="1000000" step="1024"></label>
            <label class="field">Encoding<select id="ragEmbeddingEncodingFormat"><option value="float">Float</option><option value="base64">Base64</option><option value="auto">Auto</option></select></label>
            <label class="field">Checkpoint mode<select id="ragEmbeddingCheckpointMode"><option value="interval">Interval</option><option value="off">Off</option><option value="safe">Safe</option></select></label>
            <label class="field">Checkpoint chunks<input id="ragEmbeddingCheckpointChunkInterval" type="number" min="0" max="1000000" step="512"></label>
            <label class="field">Checkpoint interval ms<input id="ragEmbeddingCheckpointIntervalMs" type="number" min="0" max="3600000" step="1000"></label>
            <label class="field">Request delay ms<input id="ragEmbeddingRequestDelayMs" type="number" min="0" max="60000" step="100"></label>
            <label class="field">Max requests per run<input id="ragEmbeddingMaxRequestsPerRun" type="number" min="0" max="100000" step="1"></label>
            <label class="field">Max retries<input id="ragEmbeddingMaxRetries" type="number" min="0" max="10" step="1"></label>
            <label class="field">Retry backoff ms<input id="ragEmbeddingRetryBackoffMs" type="number" min="0" max="120000" step="500"></label>
            <label class="field checkbox"><input id="ragEmbeddingResumeAutomatically" type="checkbox"><span>Resume automatically</span></label>
            <label class="field checkbox"><input id="ragIndexTests" type="checkbox"><span>Index test directories</span></label>
            <label class="field">Resume delay ms<input id="ragEmbeddingResumeDelayMs" type="number" min="0" max="3600000" step="1000"></label>
            <label class="field">Allowed hosts<input id="ragAllowedHosts" type="text" spellcheck="false" placeholder="rag.internal, 10.0.0.20"></label>
            <label class="field">Vector top K<input id="ragVectorTopK" type="number" min="0" max="200" step="1"></label>
            <label class="field">Rerank top K<input id="ragRerankTopK" type="number" min="0" max="200" step="1"></label>
          </div>
        </details>
        <div id="ragDetail" class="detail" aria-live="polite"></div>
        <div class="ragActionbar oc-liquid-actionbar">
          <button id="saveRagSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Save RAG settings" aria-label="Save RAG settings">${liquidIcons.save}<span class="srOnly">Save RAG settings</span></button>
          <button id="testRagSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Test RAG configuration" aria-label="Test RAG configuration">${liquidIcons.beaker}<span class="srOnly">Test RAG configuration</span></button>
          <button id="toggleRagIndexing" class="oc-icon-btn oc-liquid-btn" type="button" title="RAG indexing is not running" aria-label="RAG indexing is not running" disabled>${liquidIcons.pause}<span class="srOnly">RAG indexing is not running</span></button>
          <button id="discardRagSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Reset RAG edits" aria-label="Reset RAG edits">${liquidIcons.discard}<span class="srOnly">Reset RAG edits</span></button>
        </div>
      </div>
      <div id="guardSettingsGroup" class="settingsSection" data-settings-panel="guard" role="tabpanel">
        <div class="settingsHeader">
          <div class="settingsCompactLine">${liquidIcons.shield}<div class="sectionTitle">Guard</div></div>
          <div id="guardSettingsStatus" class="sectionMeta">Local-only</div>
        </div>
        <div id="guardSettingsDetail" class="detail visible" aria-live="polite">Local-only guard status will appear here.</div>
      </div>
      <div id="mcpSettingsGroup" class="settingsSection" data-settings-panel="mcp" role="tabpanel">
        <div class="settingsHeader">
          <div class="settingsCompactLine">${liquidIcons.agent}<div class="sectionTitle">MCP</div></div>
          <div class="sectionMeta">Coming Soon</div>
        </div>
        <div class="comingSoonText">ChipMate has reserved the MCP runtime boundary, but this build does not start servers, install artifacts, or expose MCP tools.</div>
      </div>
    </section>
    <div class="body">
      <button id="historyBackdrop" class="historyBackdrop" type="button" title="Close history" aria-label="Close history"></button>
      <aside id="historyPane" class="historyPane">
        <div class="historyHeader">
          <div class="historyTitle">History</div>
          <div class="row">
            <button id="refreshHistory" class="oc-icon-btn oc-liquid-btn" type="button" title="Refresh sessions" aria-label="Refresh sessions">${liquidIcons.refresh}<span class="srOnly">Refresh sessions</span></button>
            <button id="closeHistory" class="oc-icon-btn oc-liquid-btn" type="button" title="Close history" aria-label="Close history">${liquidIcons.close}<span class="srOnly">Close history</span></button>
          </div>
        </div>
        <div id="sessionList" class="sessionList"></div>
      </aside>
      <section class="chatMain">
        <main id="messages" class="messages">
          <div class="empty">Ask with context</div>
        </main>
        <button id="jumpLatest" class="jumpLatest oc-chip oc-liquid-chip" type="button" title="Jump to latest message" aria-label="Jump to latest message" aria-hidden="true" tabindex="-1">${liquidIcons.more}<span class="jumpLatestText">Latest</span></button>
        <footer class="composerWrap">
          <div id="composerStatusBar" class="composerStatusBar" aria-live="polite">
            <button id="composerStatusToggle" class="composerStatusToggle oc-icon-toggle oc-liquid-toggle" type="button" aria-expanded="true" aria-controls="composerPanel" title="Hide input panel">
              <span class="composerToggleIcon" aria-hidden="true">${liquidIcons.more}</span>
              <span class="composerToggleLabel">
                <span id="composerToggleFull" class="composerToggleFull">Hide input</span>
                <span id="composerToggleShort" class="composerToggleShort">Hide</span>
              </span>
            </button>
            <div class="composerSupportRail" aria-label="Composer status details">
              <button id="contextStatusPill" class="composerStatusPill oc-icon-btn oc-liquid-btn context" type="button" title="Show context details"><span class="pillText">${liquidIcons.references}</span></button>
              <button id="indexStatusPill" class="composerStatusPill oc-icon-btn oc-liquid-btn index info compactRing" type="button" title="Show index details"><span class="pillText statusRing" aria-hidden="true">${liquidIcons.database}</span></button>
              <button id="ragStatusPill" class="composerStatusPill oc-icon-btn oc-liquid-btn rag info compactRing" type="button" title="Show RAG index details"><span class="pillText statusRing" aria-hidden="true">${liquidIcons.searchIndex}</span></button>
              <button id="guardStatusPill" class="composerStatusPill oc-icon-btn oc-liquid-btn guard ok is-hidden" type="button" title="Show guard details" hidden><span class="pillText">${liquidIcons.shield}</span></button>
              <button id="usageStatusPill" class="composerStatusPill oc-icon-btn oc-liquid-btn usage pending" type="button" title="Show usage details"><span class="pillText">${liquidIcons.sparkle}</span></button>
            </div>
          </div>
          <div id="composerStatusPopover" class="composerStatusPopover" aria-hidden="true"></div>
          <div id="composerPanel" class="composerPanel">
            <div id="codeIntelligence" class="codeIntel"></div>
            <select id="modelSelect" class="modelSelectHidden" title="Model"></select>
            <div class="composer">
              <div id="suggestions" class="suggestions"></div>
              <div id="modelMenu" class="modelMenu" role="listbox" aria-label="Model" aria-hidden="true"></div>
              <div id="agentMenu" class="modelMenu agentMenu" role="listbox" aria-label="Agent" aria-hidden="true"></div>
              <textarea id="input" placeholder="Ask ChipMate…"></textarea>
              <div class="composerToolbar composerPrimaryRail composerControlRail">
                <div class="composerPickerRail">
                  <button id="permissionStatusPill" class="composerStatusPill permissionTrigger oc-chip oc-liquid-chip permission tools-off is-empty" type="button" title="工具关闭：模型工具调用已关闭，权限模式暂不生效。" aria-label="模型工具调用：已关闭。权限模式暂不生效。" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText">${liquidIcons.toolDisabled}</span></button>
                  <button id="modelTrigger" class="modelTrigger oc-chip oc-liquid-chip" type="button" title="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu">${liquidIcons.server}<span class="oc-liquid-chip-label">Model</span></button>
                  <button id="agentTrigger" class="modelTrigger agentTrigger oc-chip oc-liquid-chip" type="button" title="Agent" aria-haspopup="listbox" aria-expanded="false" aria-controls="agentMenu">${liquidIcons.agent}<span class="oc-liquid-chip-label">Agent</span></button>
                  <button id="skillsStatusPill" class="composerStatusPill skillsTrigger oc-chip oc-liquid-chip context is-empty" type="button" title="Show skills" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText">${liquidIcons.references}</span></button>
                </div>
                <div id="composerHint" class="composerHint">@ files, Ctrl+Enter send</div>
                <button id="send" class="send oc-icon-btn oc-liquid-btn" type="button" title="Send" aria-label="Send message">${liquidIcons.send}<span class="srOnly">Send message</span></button>
              </div>
            </div>
            <div class="composerActionRow toggles composerContextRail" aria-label="Composer context actions">
              <input id="file" class="toggleInput" type="checkbox" checked>
              <button id="fileToggle" class="oc-icon-toggle oc-liquid-toggle" type="button" title="Include current file" aria-label="Include current file" aria-pressed="true">${liquidIcons.file}<span class="srOnly">Include current file</span></button>
              <input id="sel" class="toggleInput" type="checkbox" checked>
              <button id="selToggle" class="oc-icon-toggle oc-liquid-toggle" type="button" title="Include editor selection" aria-label="Include editor selection" aria-pressed="true">${liquidIcons.selection}<span class="srOnly">Include editor selection</span></button>
              <input id="diag" class="toggleInput" type="checkbox">
              <button id="diagToggle" class="oc-icon-toggle oc-liquid-toggle" type="button" title="Include diagnostics" aria-label="Include diagnostics" aria-pressed="false">${liquidIcons.diagnostics}<span class="srOnly">Include diagnostics</span></button>
              <input id="diff" class="toggleInput" type="checkbox">
              <button id="diffToggle" class="oc-icon-toggle oc-liquid-toggle" type="button" title="Include git diff" aria-label="Include git diff" aria-pressed="false">${liquidIcons.diff}<span class="srOnly">Include git diff</span></button>
              <button id="attach" class="composerIconButton oc-icon-btn oc-liquid-btn" type="button" title="Attach file as persistent context" aria-label="Attach file as persistent context">${liquidIcons.attach}<span class="srOnly">Attach file as persistent context</span></button>
              <button id="refreshModels" class="composerIconButton oc-icon-btn oc-liquid-btn" type="button" title="Refresh models" aria-label="Refresh models">${liquidIcons.refresh}<span class="srOnly">Refresh models</span></button>
              <button id="composerMore" class="composerIconButton composerMoreButton oc-icon-btn oc-liquid-btn" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" aria-controls="composerMoreMenu">${liquidIcons.more}<span class="srOnly">More actions</span></button>
              <div id="composerMoreMenu" class="modelMenu composerMoreMenu" role="menu" aria-label="More composer actions" aria-hidden="true">
                <button id="exportMarkdown" class="modelMenuItem composerMoreItem" type="button" role="menuitem" title="Export current chat to Markdown" aria-label="Export current chat to Markdown">
                  <span class="modelMenuName">Export Markdown</span>
                  <span class="modelMenuMeta">Save current chat</span>
                </button>
              </div>
            </div>
            <div id="composerProgress" class="composerProgress" aria-hidden="true">
              <div class="composerProgressTrack"><div id="composerProgressFill" class="composerProgressFill"></div></div>
              <span id="composerProgressLabel" class="composerProgressLabel"></span>
            </div>
            <div id="manualModelRow" class="manualModel">
              <input id="manualModel" spellcheck="false" placeholder="provider/model">
              <button id="saveManualModel" class="oc-chip oc-liquid-chip" type="button" title="Use manual model">${liquidIcons.apply}<span class="oc-liquid-chip-label">Use</span></button>
            </div>
            <div id="notice" class="notice" aria-live="polite"></div>
          </div>
        </footer>
      </section>
    </div>
  </div>
  ${mermaidScriptTag}
  <script nonce="${nonce}">
	    const vscode = acquireVsCodeApi();
	    const el = (id) => document.getElementById(id);
	    const LIQUID_ICONS = ${liquidIconForScript};
	    const BRAND_ICON_URI = ${JSON.stringify(brandIconUri)};
    const MERMAID_MAX_SOURCE_BYTES = 100000;
    let mermaidInitialized = false;
    let mermaidRenderSerial = 0;
	    const STATUS_ICONS = {
		      context: LIQUID_ICONS.references,
		      database: LIQUID_ICONS.database,
		      diagnostics: LIQUID_ICONS.diagnostics,
	      panelBottomClose: LIQUID_ICONS.more,
	      panelBottomOpen: LIQUID_ICONS.chat,
	      shieldAlert: LIQUID_ICONS.diagnostics,
	      shieldCheck: LIQUID_ICONS.shield,
		      shieldOff: LIQUID_ICONS.shield,
	      tool: LIQUID_ICONS.tool,
	      toolsOff: LIQUID_ICONS.toolDisabled,
		      skill: LIQUID_ICONS.references,
		      rag: LIQUID_ICONS.searchIndex,
		      usage: LIQUID_ICONS.sparkle,
		    };
    const RAG_EMBEDDING_BATCH_SIZE_DEFAULT = 128;
    const RAG_EMBEDDING_BATCH_SIZE_OPTIONS = [1, 5, 10, 32, 64, 128, 256, 512];
    const RAG_EMBEDDING_BATCH_SIZE_ERROR = "Embedding batch size must be one of 1, 5, 10, 32, 64, 128, 256, or 512.";
    const RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT = 65536;
    const RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT = 3;
    const RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT = 360000;
    const RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT = "auto";
    const RAG_EMBEDDING_ENCODING_FORMATS = ["float", "base64", "auto"];
    const RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS = 0;
    const RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT = "interval";
    const RAG_EMBEDDING_CHECKPOINT_MODES = ["off", "interval", "safe"];
    const RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT = 8192;
    const RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS = 120000;
	    let state = {};
			    let pendingAction = "";
	        let connectionRequestId = 0;
	        let pendingConnectionRequestId = 0;
			    let settingsOpen = false;
        let activeSettingsSection = "connect";
	    let lastConnectionState = "";
	    let userEditedConnection = false;
	    let userEditedCompletionSettings = false;
	    let userEditedRagSettings = false;
	    let historyTouched = false;
	    let historyOpen = false;
	    let userNearBottom = true;
	    let autoFollowMessages = true;
	    let forceNextMessageFollow = false;
	    let lastMessagesScrollTop = 0;
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
    let composerMoreMenuOpen = false;
    let composerCollapsed = false;
    let composerPinnedStatusPopover = "";
    let composerHoverStatusPopover = "";
    let composerHoverCloseTimer = 0;
	    let codeIntelligenceVisible = false;
	    let selectedStateMachineId = "";
	    const collapsedMessages = new Set();
	    const messageJumpIndex = new Map();

    el("server").textContent = "UI ready";
    el("connectionDetail").className = "detail";
    el("connectionDetail").textContent = "";

	    for (const id of ["serverUrl", "username", "password"]) {
	      el(id).addEventListener("input", () => {
	        userEditedConnection = true;
	      });
	    }
	    for (const id of ["completionEnabled", "completionProvider", "completionProfile", "completionApiBaseUrl", "completionModel", "completionMaxTokens", "completionTemperature", "completionTopP"]) {
	      el(id).addEventListener("input", () => {
	        userEditedCompletionSettings = true;
	        renderCompletionSettings();
	      });
	      el(id).addEventListener("change", () => {
	        userEditedCompletionSettings = true;
	        renderCompletionSettings();
	      });
	    }
	    for (const id of ["ragEmbeddingEndpoint", "ragEmbeddingModel", "ragEmbeddingBatchSize", "ragEmbeddingMaxTokensPerRequest", "ragEmbeddingConcurrentRequests", "ragEmbeddingMaxInFlightTokens", "ragEmbeddingEncodingFormat", "ragEmbeddingCheckpointMode", "ragEmbeddingCheckpointChunkInterval", "ragEmbeddingCheckpointIntervalMs", "ragEmbeddingRequestDelayMs", "ragEmbeddingMaxRequestsPerRun", "ragEmbeddingMaxRetries", "ragEmbeddingRetryBackoffMs", "ragEmbeddingResumeAutomatically", "ragIndexTests", "ragEmbeddingResumeDelayMs", "ragRerankEndpoint", "ragRerankModel", "ragAllowedHosts", "ragVectorTopK", "ragRerankTopK"]) {
	      el(id).addEventListener("input", () => {
	        userEditedRagSettings = true;
	      });
	      el(id).addEventListener("change", () => {
	        userEditedRagSettings = true;
	      });
	    }

    const messagesRoot = el("messages");
    messagesRoot.addEventListener("scroll", (event) => {
      if (event.target === messagesRoot) {
        handleMessagesScroll(messagesRoot);
        return;
      }
      if (isNestedMessageScroller(event.target)) pauseAutoFollowForUser();
    }, true);
    messagesRoot.addEventListener("wheel", (event) => {
      if (redirectNestedVerticalWheel(event, messagesRoot)) return;
      if (isNestedMessageScroller(event.target) || event.deltaY < 0) pauseAutoFollowForUser();
    }, { capture: true, passive: false });
    messagesRoot.addEventListener("touchstart", (event) => {
      if (isNestedMessageScroller(event.target)) pauseAutoFollowForUser();
    }, { capture: true, passive: true });
    el("jumpLatest").addEventListener("click", jumpToLatestMessage);
    window.addEventListener("resize", () => {
      renderShell();
      positionModelMenu();
      positionAgentMenu();
      positionComposerMoreMenu();
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
	      render();
	    });
      for (const button of Array.from(document.querySelectorAll("[data-settings-section]"))) {
        button.addEventListener("click", () => {
          activeSettingsSection = button.dataset.settingsSection || "connect";
          settingsOpen = true;
          renderSettings();
        });
      }
		    el("connect").addEventListener("click", () => connectOrTest("connectWithSettings"));
		    el("test").addEventListener("click", () => connectOrTest("testWithSettings"));
		    el("saveCompletionSettings").addEventListener("click", saveCompletionSettings);
		    el("testCompletionApi").addEventListener("click", testCompletionApi);
        el("saveSkillsSettings").addEventListener("click", saveSkillsSettings);
			    el("saveRagSettings").addEventListener("click", saveRagSettings);
			    el("testRagSettings").addEventListener("click", testRagSettings);
			    el("toggleRagIndexing").addEventListener("click", toggleRagIndexing);
    el("discardRagSettings").addEventListener("click", discardRagSettings);
	    el("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    el("syncState").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
	    el("openOutput").addEventListener("click", () => vscode.postMessage({ type: "openOutput" }));
	    el("newSession").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    el("composerStatusToggle").addEventListener("click", toggleComposerPanel);
    bindComposerStatusPill("contextStatusPill", "context", true);
    bindComposerStatusPill("indexStatusPill", "index", true);
    bindComposerStatusPill("ragStatusPill", "rag", true);
    bindComposerStatusPill("permissionStatusPill", "permission", false);
    bindComposerStatusPill("skillsStatusPill", "skills", true);
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
    el("composerMore").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleComposerMoreMenu();
    });
    el("composerMore").addEventListener("keydown", onComposerMoreKeydown);
    el("composerMoreMenu").addEventListener("click", (event) => event.stopPropagation());
    el("composerMoreMenu").addEventListener("keydown", onComposerMoreKeydown);
    window.addEventListener("click", () => {
      const hadModelMenu = modelMenuOpen;
      const hadAgentMenu = agentMenuOpen;
      const hadComposerMoreMenu = composerMoreMenuOpen;
      const hadStatusPopover = Boolean(activeComposerStatusPopover());
      modelMenuOpen = false;
      agentMenuOpen = false;
      composerMoreMenuOpen = false;
      closeComposerStatusPopoverState();
      if (hadModelMenu) {
        renderModelMenu();
        renderModelTrigger();
      }
      if (hadAgentMenu) {
        renderAgentMenu();
        renderAgentTrigger();
      }
      if (hadComposerMoreMenu) renderComposerMoreMenu();
      if (hadStatusPopover) renderComposerStatusBar();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const hadPopup = modelMenuOpen || agentMenuOpen || composerMoreMenuOpen || Boolean(activeComposerStatusPopover()) || el("suggestions").classList.contains("open");
      if (!hadPopup) return;
      event.preventDefault();
      modelMenuOpen = false;
      agentMenuOpen = false;
      composerMoreMenuOpen = false;
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
      renderComposerMoreMenu();
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
	    el("exportMarkdown").addEventListener("click", () => {
        composerMoreMenuOpen = false;
        renderComposerMoreMenu();
        vscode.postMessage({ type: "exportMarkdown", scope: "session" });
      });
	    el("attach").addEventListener("click", () => vscode.postMessage({ type: "addFile" }));
	    el("send").addEventListener("click", onSendButtonClick);
	    el("input").addEventListener("input", onComposerInput);
	    el("input").addEventListener("keydown", onComposerKeydown);
	    el("sel").addEventListener("change", renderMentionChips);
	    el("file").addEventListener("change", renderMentionChips);
    for (const item of [
      ["file", "fileToggle"],
      ["sel", "selToggle"],
      ["diag", "diagToggle", "diagnostics"],
      ["diff", "diffToggle"],
    ]) {
      bindContextToggle(item[0], item[1], item[2]);
    }

	    window.addEventListener("message", (event) => {
	      if (event.data.type === "state") {
	        const nextState = event.data.state || {};
	        const nextConnectionState = nextState.connectionState || "disconnected";
	        const shouldCloseSettings = !pendingAction && nextConnectionState === "connected" && lastConnectionState !== "connected";
	        state = nextState;
	        if (shouldCloseSettings) settingsOpen = false;
	        lastConnectionState = nextConnectionState;
	        render();
	        return;
	      }
	      if (event.data.type === "connectionStatus") {
	        if (!event.data.requestId || event.data.requestId !== pendingConnectionRequestId) return;
	        const wasPendingConnect = pendingAction === "connect";
	        pendingAction = "";
	        pendingConnectionRequestId = 0;
	        const connectionState = event.data.connectionState || (state.connectionState || "disconnected");
	        if (connectionState === "connected" && wasPendingConnect) settingsOpen = false;
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
	      if (event.data.type === "completionStatus") {
	        renderCompletionStatus(event.data.message || "", event.data.status || "info");
	      }
        if (event.data.type === "skillsStatus") {
          renderSkillsStatus(event.data.message || "", event.data.status || "info");
        }
	      if (event.data.type === "ragStatus") {
	        renderRagStatus(event.data.message || "", event.data.status || "info");
	      }
	    });

		    function connectOrTest(type) {
		      if (pendingAction) return;
	        const requestId = ++connectionRequestId;
	        pendingConnectionRequestId = requestId;
		      pendingAction = type === "testWithSettings" ? "test" : "connect";
		      renderConnectionButtons();
		      const payload = {
		        type,
	        requestId,
	        serverUrl: el("serverUrl").value,
	        username: el("username").value
		      };
	      const password = el("password").value;
	      if (password) payload.password = password;
	      vscode.postMessage(payload);
	    }

	    function saveCompletionSettings() {
	      userEditedCompletionSettings = false;
	      renderCompletionStatus("Saving inline completion settings...", "info");
	      vscode.postMessage({
	        type: "saveCompletionSettings",
	        settings: completionSettingsPayload()
	      });
	    }

	    function testCompletionApi() {
	      userEditedCompletionSettings = false;
	      renderCompletionStatus("Testing direct completion API...", "info");
	      vscode.postMessage({
	        type: "testCompletionApi",
	        settings: completionSettingsPayload()
	      });
	    }

      function saveSkillsSettings() {
        const enabled = Array.from(document.querySelectorAll("[data-skill-id]"))
          .filter((input) => input.checked)
          .map((input) => input.getAttribute("data-skill-id"))
          .filter(Boolean);
        renderSkillsStatus("Saving skills...", "info");
        vscode.postMessage({ type: "saveSkillsSettings", enabled });
      }

	    function saveRagSettings() {
	      if (!validateRagEmbeddingBatchSizeInput()) return;
	      userEditedRagSettings = false;
	      renderRagStatus("Saving RAG settings...", "info");
	      vscode.postMessage({
	        type: "saveRagSettings",
	        settings: ragSettingsPayload()
	      });
	    }

			    function testRagSettings() {
			      if (!validateRagEmbeddingBatchSizeInput()) return;
			      userEditedRagSettings = false;
			      renderRagStatus("Testing RAG configuration...", "info");
		      vscode.postMessage({
		        type: "testRagSettings",
		        settings: ragSettingsPayload()
			      });
			    }

      function toggleRagIndexing() {
        const rag = state.codeGraph && state.codeGraph.rag;
        if (!rag) return;
        if (rag.availability === "indexing") {
          renderRagStatus("Pausing RAG indexing...", "info");
          vscode.postMessage({ type: "pauseRagIndexing" });
          return;
        }
        if (rag.availability === "paused") {
          renderRagStatus("Resuming RAG indexing...", "info");
          vscode.postMessage({ type: "resumeRagIndexing" });
        }
      }

        function discardRagSettings() {
          userEditedRagSettings = false;
          renderRagSettings();
          renderRagStatus("RAG edits discarded.", "info");
        }

	    function completionSettingsPayload() {
	      return {
	        enabled: el("completionEnabled").checked,
	        provider: "openai-compatible",
	        profile: el("completionProfile").value,
	        apiBaseUrl: el("serverUrl").value,
	        model: el("completionModel").value,
	        maxTokens: numberInputValue("completionMaxTokens", 128),
	        temperature: numberInputValue("completionTemperature", 0),
	        topP: numberInputValue("completionTopP", 1)
	      };
	    }

	    function ragSettingsPayload() {
        const embeddingBatchSize = numberInputValue("ragEmbeddingBatchSize", RAG_EMBEDDING_BATCH_SIZE_DEFAULT);
	      return {
	        embeddingEndpoint: el("ragEmbeddingEndpoint").value,
	        embeddingModel: el("ragEmbeddingModel").value,
	        embeddingBatchSize,
	        embeddingMaxTokensPerRequest: numberInputValue("ragEmbeddingMaxTokensPerRequest", RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT),
	        embeddingConcurrentRequests: numberInputValue("ragEmbeddingConcurrentRequests", RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT),
	        embeddingMaxInFlightTokens: numberInputValue("ragEmbeddingMaxInFlightTokens", RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT),
	        embeddingEncodingFormat: ragEmbeddingEncodingFormatSelectValue(el("ragEmbeddingEncodingFormat").value),
	        embeddingCheckpointMode: ragEmbeddingCheckpointModeSelectValue(el("ragEmbeddingCheckpointMode").value),
	        embeddingCheckpointChunkInterval: numberInputValue("ragEmbeddingCheckpointChunkInterval", RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT),
	        embeddingCheckpointIntervalMs: numberInputValue("ragEmbeddingCheckpointIntervalMs", RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS),
	        embeddingTimeoutMs: ragEmbeddingTimeoutMsForBatchSize(embeddingBatchSize),
	        embeddingRequestDelayMs: numberInputValue("ragEmbeddingRequestDelayMs", RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS),
	        embeddingMaxRequestsPerRun: numberInputValue("ragEmbeddingMaxRequestsPerRun", 100),
	        embeddingMaxRetries: numberInputValue("ragEmbeddingMaxRetries", 3),
	        embeddingRetryBackoffMs: numberInputValue("ragEmbeddingRetryBackoffMs", 2000),
	        embeddingResumeAutomatically: el("ragEmbeddingResumeAutomatically").checked,
	        embeddingResumeDelayMs: numberInputValue("ragEmbeddingResumeDelayMs", 60000),
	        rerankEndpoint: el("ragRerankEndpoint").value,
	        rerankModel: el("ragRerankModel").value,
	        allowedHosts: stringListInputValue("ragAllowedHosts"),
	        indexTests: el("ragIndexTests").checked,
	        vectorTopK: numberInputValue("ragVectorTopK", 24),
	        rerankTopK: numberInputValue("ragRerankTopK", 16)
	      };
	    }

	    function stringListInputValue(id) {
	      return el(id).value
	        .split(/[,\\n]/)
	        .map((item) => item.trim())
	        .filter(Boolean);
	    }

	    function numberInputValue(id, fallback) {
	      const value = Number(el(id).value);
	      return Number.isFinite(value) ? value : fallback;
	    }

      function ragEmbeddingTimeoutMsForBatchSize(batchSize) {
        return Number(batchSize) === 512 ? 90000 : 60000;
      }

      function ragEmbeddingBatchSizeSelectValue(batchSize) {
        const value = Number(batchSize);
        return RAG_EMBEDDING_BATCH_SIZE_OPTIONS.includes(value) ? value : RAG_EMBEDDING_BATCH_SIZE_DEFAULT;
      }

	    function ragEmbeddingCheckpointModeSelectValue(mode) {
	      return RAG_EMBEDDING_CHECKPOINT_MODES.includes(mode) ? mode : RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT;
	    }

	    function ragEmbeddingEncodingFormatSelectValue(format) {
	      return RAG_EMBEDDING_ENCODING_FORMATS.includes(format) ? format : RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT;
	    }

	    function validateRagEmbeddingBatchSizeInput() {
	      const value = Number(el("ragEmbeddingBatchSize").value);
	      if (!Number.isFinite(value) || !RAG_EMBEDDING_BATCH_SIZE_OPTIONS.includes(value)) {
	        renderRagStatus(RAG_EMBEDDING_BATCH_SIZE_ERROR, "error");
	        el("ragEmbeddingBatchSize").focus();
	        return false;
	      }
	      return true;
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
      composerMoreMenuOpen = false;
      mentionResults = [];
      mentionStatus = "";
      mentionError = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderModelMenu();
      renderModelTrigger();
      renderAgentMenu();
      renderAgentTrigger();
      renderComposerMoreMenu();
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

      function onSendButtonClick() {
        if (state.sending) {
          vscode.postMessage({ type: "cancelSend" });
          setNotice("Stopping current request...");
          return;
        }
        send();
      }

      function bindContextToggle(inputId, buttonId, popoverName) {
        const input = el(inputId);
        const button = el(buttonId);
        if (!input || !button) return;
        button.addEventListener("click", (event) => {
          input.checked = !input.checked;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          if (popoverName) {
            event.stopPropagation();
            cancelComposerHoverClose();
            composerPinnedStatusPopover = popoverName;
            composerHoverStatusPopover = "";
            closeComposerPopups();
            renderComposerStatusBar();
          } else {
            renderComposerToggles();
          }
        });
        input.addEventListener("change", renderComposerToggles);
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
	      enableAutoFollowMessages();
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
		      renderCompletionSettings();
          renderSkillsSettings();
		      renderRagSettings();
          renderGuardSettings();
		      renderConnectionButtons();
	      el("diag").checked = Boolean(state.defaults && state.defaults.includeDiagnostics);
	      el("diff").checked = Boolean(state.defaults && state.defaults.includeGitDiff);
        renderComposerToggles();
        renderComposerMoreMenu();
	      renderSendButton();
	      renderComposerStatusBar();
	    }

	    function renderSendButton() {
	      const blockedByGuard = localOnlyAgentBlocked() && !looksLikeExportRequest(el("input").value);
        const button = el("send");
        const cancellable = Boolean(state.sending && state.sendCancellable !== false);
        const loading = Boolean(state.sending && !cancellable);
	      button.disabled = Boolean(!state.sending && blockedByGuard);
        const label = blockedByGuard && !state.sending
          ? "Select an agent before sending"
          : cancellable
            ? "Stop current request"
            : loading
              ? "Sending message"
              : "Send message";
        button.classList.toggle("is-active", cancellable);
        button.classList.toggle("is-loading", loading);
        setSendButtonContent(button, cancellable ? "stop" : "send", label, loading);
	    }

    function renderShell() {
      const widthClass = window.innerWidth >= 760 ? "history-wide" : "history-narrow";
      const mode = currentViewMode();
      el("app").className = "app mode-" + mode + " " + (historyOpen ? "history-open" : "history-closed") + " " + widthClass;
    }

    function currentViewMode() {
      if (settingsOpen) return "settings-page";
      return (state.connectionState || "disconnected") === "connected" ? "chat" : "connection-only";
    }

		    function renderConnection() {
		      const stateName = state.connectionState || "disconnected";
		      const dot = el("statusDot");
		      dot.className = "oc-status-dot " + stateName;
        const metaParts = [shortConnectionStateLabel(stateName)];
        if (state.selectedModel) metaParts.push(shortModelName(state.selectedModel));
        if (state.selectedAgent || state.localOnlyAgent) metaParts.push(state.selectedAgent || state.localOnlyAgent);
        const statusText = metaParts.join(" · ");
	      el("server").textContent = statusText;
	      el("server").title = state.serverUrl ? statusText + " · " + state.serverUrl : statusText;
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

      function shortConnectionStateLabel(stateName) {
        if (stateName === "authFailed") return "auth failed";
        return stateName;
      }

	    function renderCompletionSettings() {
	      const completion = state.completion || {};
	      if (!userEditedCompletionSettings) {
	        el("completionEnabled").checked = Boolean(completion.enabled);
	        el("completionProvider").value = completion.provider || "openai-compatible";
	        el("completionProfile").value = completion.profile || "qwen-coder-fim";
	        el("completionApiBaseUrl").value = (state.provider && state.provider.apiBaseUrl) || completion.apiBaseUrl || "";
	        el("completionModel").value = completion.model || "qwen-coder-30b0";
	        el("completionMaxTokens").value = String(completion.maxTokens || 128);
	        el("completionTemperature").value = String(completion.temperature ?? 0);
	        el("completionTopP").value = String(completion.topP ?? 1);
	      }
	      const direct = el("completionProvider").value === "openai-compatible";
	      el("completionDirectFields").className = "completionDirectFields" + (direct ? "" : " hidden");
	      el("testCompletionApi").disabled = !direct;
	    }

      function renderCompletionStatus(message, status) {
	      const detail = el("completionDetail");
	      detail.className = "detail " + detailStatusClass(status) + (message ? "visible" : "");
	      detail.textContent = message || "";
	    }

      function renderSkillsSettings() {
        const skills = Array.isArray(state.skills && state.skills.available) ? state.skills.available : [];
        const enabled = new Set(Array.isArray(state.skills && state.skills.enabled) ? state.skills.enabled : []);
        const list = el("skillsList");
        list.textContent = "";
        el("skillsSettingsStatus").textContent = skills.length ? enabled.size + "/" + skills.length + " enabled" : "No skills";
        if (!skills.length) {
          const empty = document.createElement("div");
          empty.className = "comingSoonText";
          empty.textContent = "No workspace skills found. Add SKILL.md files under .agents/skills/<name>/ to make them appear here.";
          list.appendChild(empty);
          return;
        }
        for (const skill of skills) {
          const label = document.createElement("label");
          label.className = "skillItem";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(skill.enabled || enabled.has(skill.id) || enabled.has(skill.name));
          checkbox.setAttribute("data-skill-id", skill.id || skill.name);
          const main = document.createElement("span");
          main.className = "skillMain";
          const name = document.createElement("span");
          name.className = "skillName";
          name.textContent = skill.name || skill.id || "Skill";
          const description = document.createElement("span");
          description.className = "skillDescription";
          description.textContent = skill.description || "No description.";
          const meta = document.createElement("span");
          meta.className = "skillMeta";
          const tools = Array.isArray(skill.allowedTools) && skill.allowedTools.length ? " · allowed-tools: " + skill.allowedTools.join(", ") : "";
          meta.textContent = (skill.path || ".agents/skills") + tools;
          main.append(name, description, meta);
          label.append(checkbox, main);
          list.appendChild(label);
        }
      }

      function renderSkillsStatus(message, status) {
        const detail = el("skillsDetail");
        detail.className = "detail " + detailStatusClass(status) + " visible";
        detail.textContent = message || "Skills are discovered from .agents/skills/*/SKILL.md.";
      }

		    function renderRagSettings() {
	      const rag = state.rag || {};
	      const embedding = rag.embedding || {};
	      const rerank = rag.rerank || {};
	      if (!userEditedRagSettings) {
	        el("ragEmbeddingEndpoint").value = embedding.endpoint || "";
	        el("ragEmbeddingModel").value = embedding.model || "qwen3-embedding-8b";
	        el("ragEmbeddingBatchSize").value = String(ragEmbeddingBatchSizeSelectValue(embedding.batchSize));
	        el("ragEmbeddingMaxTokensPerRequest").value = String(embedding.maxTokensPerRequest ?? RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT);
	        el("ragEmbeddingConcurrentRequests").value = String(embedding.concurrentRequests ?? RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT);
	        el("ragEmbeddingMaxInFlightTokens").value = String(embedding.maxInFlightTokens ?? RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT);
	        el("ragEmbeddingEncodingFormat").value = ragEmbeddingEncodingFormatSelectValue(embedding.encodingFormat);
	        el("ragEmbeddingCheckpointMode").value = ragEmbeddingCheckpointModeSelectValue(embedding.checkpointMode);
	        el("ragEmbeddingCheckpointChunkInterval").value = String(embedding.checkpointChunkInterval ?? RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT);
	        el("ragEmbeddingCheckpointIntervalMs").value = String(embedding.checkpointIntervalMs ?? RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS);
	        el("ragEmbeddingRequestDelayMs").value = String(embedding.requestDelayMs ?? RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS);
	        el("ragEmbeddingMaxRequestsPerRun").value = String(embedding.maxRequestsPerRun ?? 100);
	        el("ragEmbeddingMaxRetries").value = String(embedding.maxRetries ?? 3);
	        el("ragEmbeddingRetryBackoffMs").value = String(embedding.retryBackoffMs ?? 2000);
	        el("ragEmbeddingResumeAutomatically").checked = embedding.resumeAutomatically !== false;
	        el("ragIndexTests").checked = rag.indexTests === true;
	        el("ragEmbeddingResumeDelayMs").value = String(embedding.resumeDelayMs ?? 60000);
	        el("ragRerankEndpoint").value = rerank.endpoint || "";
	        el("ragRerankModel").value = rerank.model || "qwen3-reranker-8b";
	        el("ragAllowedHosts").value = (rag.allowedHosts || []).join(", ");
	        el("ragVectorTopK").value = String(rag.vectorTopK ?? 24);
	        el("ragRerankTopK").value = String(rag.rerankTopK ?? 16);
	      }
			      const currentRagStatus = state.codeGraph && state.codeGraph.rag;
			      const statusText = codeGraphRagMeta(currentRagStatus);
          renderRagCompactStatus(currentRagStatus, statusText);
          renderRagIndexingControl(currentRagStatus);
			      if (statusText && !statusText.startsWith("RAG not configured")) renderRagStatus(statusText, statusText.includes("unavailable") ? "error" : "info");
	          else renderRagStatus("", "info");
			    }

	    function renderRagStatus(message, status) {
	      const detail = el("ragDetail");
	      detail.className = "detail " + detailStatusClass(status) + (message ? "visible" : "");
	      detail.textContent = message || "";
	    }

	    function detailStatusClass(status) {
	      if (status === "error") return "error ";
	      if (status === "success") return "success ";
	      return "";
	    }

		    function renderSettings() {
	      const mode = currentViewMode();
	      const title = mode === "settings-page" ? "Close full settings" : "Open full settings";
        if (mode === "connection-only") activeSettingsSection = "connect";
	      el("settings").className = "settings " + mode;
	      el("settingsToggle").title = title;
	      el("settingsToggle").setAttribute("aria-label", title);
        for (const button of Array.from(document.querySelectorAll("[data-settings-section]"))) {
          const active = (button.dataset.settingsSection || "") === activeSettingsSection;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-selected", active ? "true" : "false");
        }
        for (const panel of Array.from(document.querySelectorAll("[data-settings-panel]"))) {
          const active = (panel.dataset.settingsPanel || "") === activeSettingsSection;
          panel.classList.toggle("active", active);
        }
	    }

		    function renderConnectionButtons() {
		      const pending = Boolean(pendingAction) || state.connectionState === "connecting";
		      const connectPending = pendingAction === "connect" || (!pendingAction && state.connectionState === "connecting");
		      const testPending = pendingAction === "test";
          const pendingLabel = testPending
            ? "Testing provider connection. Wait for the current test to finish."
            : "Saving and verifying provider settings. Wait for the current save to finish.";
		      el("connect").disabled = pending;
		      el("test").disabled = pending;
	        el("connect").classList.toggle("is-active", connectPending);
	        el("test").classList.toggle("is-spinning", testPending);
	        setChipLabel(el("connect"), "chip", connectPending ? "Saving" : "Save");
	        setIconOnlyButton(el("test"), "beaker", testPending ? "Testing provider" : "Test provider connection");
          if (pending) {
            el("connect").title = pendingLabel;
            el("connect").setAttribute("aria-label", pendingLabel);
            el("test").title = pendingLabel;
            el("test").setAttribute("aria-label", pendingLabel);
          }
		    }

      function renderComposerToggles() {
        const configs = [
          { input: "file", button: "fileToggle", label: "Include current file", icon: "file" },
          { input: "sel", button: "selToggle", label: "Include editor selection", icon: "selection" },
          { input: "diag", button: "diagToggle", label: diagnosticsToggleLabel(), icon: "diagnostics", badge: diagnosticsBadgeText(), popover: "diagnostics" },
          { input: "diff", button: "diffToggle", label: "Include git diff", icon: "diff" },
        ];
        for (const config of configs) {
          const input = el(config.input);
          const button = el(config.button);
          if (!input || !button) continue;
          const pressed = Boolean(input.checked);
          button.setAttribute("aria-pressed", pressed ? "true" : "false");
          button.classList.toggle("is-active", pressed);
          setIconOnlyButton(button, config.icon, config.label);
          if (config.popover) {
            button.setAttribute("aria-haspopup", "dialog");
            button.setAttribute("aria-expanded", activeComposerStatusPopover() === config.popover ? "true" : "false");
            button.setAttribute("aria-controls", "composerStatusPopover");
          }
          renderLiquidBadge(button, config.badge);
        }
      }

      function diagnosticsBadgeText() {
        const count = diagnosticsTotal();
        if (!count) return "";
        return String(Math.min(count, 99));
      }

      function diagnosticsToggleLabel() {
        const count = diagnosticsTotal();
        const included = Boolean(el("diag").checked);
        if (!count) return included ? "Diagnostics included; none available in workspace" : "Include diagnostics; none available in workspace";
        return count + " diagnostics available; " + (included ? "included" : "excluded") + " in next prompt";
      }

	      function renderRagCompactStatus(rag, statusText) {
	        const chip = el("ragCompactStatus");
	        if (!chip) return;
        let label = "off";
        let title = statusText || "RAG not configured";
        let statusClass = "warning";
        if (rag && rag.availability === "indexing") label = "indexing";
        else if (rag && rag.embeddingEnabled) label = rag.availability === "partial" ? "partial" : rag.availability === "paused" ? "paused" : "ready";
        else if (rag && rag.availability === "checking") label = "checking";
        else if (rag && rag.availability === "unavailable") label = "error";
        if (label === "ready") statusClass = "ready";
        else if (label === "error") statusClass = "error";
        setChipLabel(chip, label === "ready" ? "database" : "diagnostics", label === "off" ? "Not configured" : label);
        chip.title = title;
        chip.classList.toggle("is-active", label === "ready");
        chip.classList.toggle("warning", statusClass === "warning");
	        chip.classList.toggle("error", statusClass === "error");
	      }

      function renderRagIndexingControl(rag) {
        const button = el("toggleRagIndexing");
        if (!button) return;
        const indexing = Boolean(rag && rag.availability === "indexing");
        const paused = Boolean(rag && rag.availability === "paused");
        const label = indexing
          ? "Pause RAG indexing"
          : paused
            ? "Resume RAG indexing"
            : "RAG indexing is not running";
        setIconOnlyButton(button, paused ? "play" : "pause", label);
        button.disabled = !indexing && !paused;
        button.classList.toggle("is-active", indexing || paused);
      }

	      function renderGuardSettings() {
        const status = el("guardSettingsStatus");
        const detail = el("guardSettingsDetail");
        if (!status || !detail) return;
        status.textContent = composerGuardSummary();
        detail.textContent = guardStatusDetail();
      }

      function setIconOnlyButton(button, iconName, label) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        appendLiquidIcon(button, iconName);
        const sr = document.createElement("span");
        sr.className = "srOnly";
        sr.textContent = label;
        button.appendChild(sr);
        button.title = label;
        button.setAttribute("aria-label", label);
      }

      function setSendButtonContent(button, iconName, label, loading) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        if (loading) {
          const spinner = document.createElement("span");
          spinner.className = "sendSpinner";
          spinner.setAttribute("aria-hidden", "true");
          button.appendChild(spinner);
        } else {
          appendLiquidIcon(button, iconName);
        }
        const sr = document.createElement("span");
        sr.className = "srOnly";
        sr.textContent = label;
        button.appendChild(sr);
        button.title = label;
        button.setAttribute("aria-label", label);
      }

      function setChipLabel(button, iconName, label) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        appendLiquidIcon(button, iconName);
        const text = document.createElement("span");
        text.className = "oc-chip-label oc-liquid-chip-label";
        text.textContent = label;
        button.appendChild(text);
        button.title = label;
        if (button.tagName === "BUTTON") button.setAttribute("aria-label", label);
      }

      function appendLiquidIcon(root, iconName) {
        const holder = document.createElement("span");
        holder.innerHTML = LIQUID_ICONS[iconName] || LIQUID_ICONS.more;
        while (holder.firstChild) root.appendChild(holder.firstChild);
      }

      function renderLiquidBadge(node, text) {
        removeInlineBadge(node, "oc-liquid-badge");
        if (!text) return;
        const badge = document.createElement("span");
        badge.className = "oc-badge oc-liquid-badge";
        badge.dataset.badgeFor = node.id || "";
        badge.setAttribute("aria-hidden", "true");
        badge.textContent = text;
        insertInlineBadge(node, badge);
      }

      function removeInlineBadge(node, className) {
        if (!node || !node.parentElement) return;
        for (const badge of Array.from(node.parentElement.children)) {
          if (badge.classList.contains(className) && badge.getAttribute("data-badge-for") === (node.id || "")) {
            badge.remove();
          }
        }
      }

      function insertInlineBadge(node, badge) {
        if (node && node.parentElement) node.insertAdjacentElement("afterend", badge);
      }

    function renderComposerStatusBar() {
      renderComposerToggles();
      const wrap = document.querySelector(".composerWrap");
      const panel = el("composerPanel");
      const toggle = el("composerStatusToggle");
      const toggleFull = el("composerToggleFull");
      const toggleShort = el("composerToggleShort");
      const toggleLabel = composerCollapsed ? "Show input" : "Hide input";
      const toggleShortLabel = composerCollapsed ? "Show" : "Hide";
      wrap.className = "composerWrap" + (composerCollapsed ? " collapsed" : "");
      panel.hidden = composerCollapsed;
	      toggle.className = "composerStatusToggle oc-icon-toggle oc-liquid-toggle" + (composerCollapsed ? " collapsed" : " expanded");
      toggle.setAttribute("aria-expanded", composerCollapsed ? "false" : "true");
      toggle.setAttribute("aria-label", composerCollapsed ? "Show input and context panel" : "Hide input and context panel");
      toggle.title = composerCollapsed ? "Show input and context panel" : "Hide input and context panel";
      const toggleIcon = toggle.querySelector(".composerToggleIcon");
      if (toggleIcon) toggleIcon.innerHTML = composerCollapsed ? STATUS_ICONS.panelBottomOpen : STATUS_ICONS.panelBottomClose;
      toggleFull.textContent = toggleLabel;
      toggleShort.textContent = toggleShortLabel;

      const context = composerContextStatus();
      updateStatusPill(el("contextStatusPill"), context);
      const index = composerIndexStatus();
      updateStatusPill(el("indexStatusPill"), index);
      const rag = composerRagStatus();
      updateStatusPill(el("ragStatusPill"), rag);
      const permission = composerPermissionStatus();
      updateStatusPill(el("permissionStatusPill"), permission);
      const skills = composerSkillsStatus();
      updateStatusPill(el("skillsStatusPill"), skills);
      const guard = composerGuardStatus();
      updateStatusPill(el("guardStatusPill"), guard);
      const usage = composerUsageStatus();
      updateStatusPill(el("usageStatusPill"), usage);
      renderComposerProgress();
      renderComposerStatusPopover();
    }

    function renderComposerProgress() {
      const root = el("composerProgress");
      const fill = el("composerProgressFill");
      const label = el("composerProgressLabel");
      if (!root || !fill || !label) return;
      const progress = contextUsageProgress();
      root.className = "composerProgress" + (progress ? " visible " + progress.kind : "");
      root.setAttribute("aria-hidden", progress ? "false" : "true");
      root.title = progress ? progress.title : "";
      fill.style.width = progress ? progress.percent : "0%";
      label.textContent = progress ? progress.label : "";
    }

    function contextUsageProgress() {
      const context = state.usage && state.usage.context;
      if (!context || !context.used || !context.limit) return undefined;
      const ratio = clamp01(Number(context.ratio ?? (context.used / context.limit)));
      const kind = state.usage && (state.usage.level === "warning" || state.usage.level === "error") ? state.usage.level : "normal";
      return {
        kind,
        percent: formatRingProgress(ratio),
        label: formatCompactCount(context.used) + " / " + formatCompactCount(context.limit),
        title: context.detail || context.summary || "Context usage",
      };
    }

    function updateStatusPill(node, input) {
      const activePopover = activeComposerStatusPopover();
      node.hidden = Boolean(input.hidden);
      node.className = input.className + (input.ring ? " compactRing" : "") + (activePopover === input.popover ? " open" : "");
      node.classList.toggle("hasText", Boolean(input.showText));
      node.title = input.title || input.text;
      node.setAttribute("aria-label", input.ariaLabel || input.title || input.text);
      if (node.hasAttribute("aria-expanded")) node.setAttribute("aria-expanded", activePopover === input.popover ? "true" : "false");
      node.style.removeProperty("--ring-progress");
      const label = node.querySelector(".pillText") || node;
      if (input.ring) {
        label.className = "pillText statusRing" + (input.ring.indeterminate ? " indeterminate" : "");
        label.setAttribute("aria-hidden", "true");
        label.innerHTML = input.ringIcon || "";
        if (typeof input.ring.progress === "number") node.style.setProperty("--ring-progress", formatRingProgress(input.ring.progress));
        renderStatusBadge(node, input.badgeText);
        return;
      }
      label.className = "pillText";
      label.textContent = "";
      if (input.showText) {
        label.removeAttribute("aria-hidden");
        if (input.icon) {
          const icon = document.createElement("span");
          icon.className = "pillGlyph";
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = input.icon;
          label.appendChild(icon);
        }
        const text = document.createElement("span");
        text.className = "pillLabelText";
        text.textContent = input.text || "";
        label.appendChild(text);
      } else {
        label.setAttribute("aria-hidden", "true");
        label.innerHTML = input.icon || input.text || "";
      }
      renderStatusBadge(node, input.badgeText);
    }

    function renderStatusBadge(node, text) {
      removeInlineBadge(node, "statusBadge");
      if (!text) return;
      const badge = document.createElement("span");
      badge.className = "statusBadge";
      badge.dataset.badgeFor = node.id || "";
      badge.setAttribute("aria-hidden", "true");
      const badgeText = document.createElement("span");
      badgeText.className = "statusBadgeText";
      badgeText.textContent = text;
      badge.append(badgeText);
      insertInlineBadge(node, badge);
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
      root.className = "composerStatusPopover" + (activePopover ? " open " + activePopover + "Popover" : "");
      root.setAttribute("aria-hidden", activePopover ? "false" : "true");
      if (!activePopover) return;
	      if (activePopover === "context") renderContextStatusPopover(root);
	      if (activePopover === "diagnostics") renderDiagnosticsStatusPopover(root);
	      if (activePopover === "index") renderIndexStatusPopover(root);
	      if (activePopover === "rag") renderRagStatusPopover(root);
	      if (activePopover === "permission") renderPermissionStatusPopover(root);
      if (activePopover === "skills") renderSkillsStatusPopover(root);
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
        const activeStatusPill = active && active.closest && active.closest("#contextStatusPill, #indexStatusPill, #ragStatusPill, #permissionStatusPill, #skillsStatusPill, #guardStatusPill, #usageStatusPill");
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
      const detail = contextStatusDetail();
      return {
        text: "Ctx " + count,
        title: detail,
	        className: "composerStatusPill oc-icon-btn oc-liquid-btn context",
        popover: "context",
        ariaLabel: "Context: " + count + ". " + detail,
	        icon: STATUS_ICONS.context,
        badgeText: count > 0 ? String(Math.min(count, 99)) : "",
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
	        className: "composerStatusPill oc-icon-btn oc-liquid-btn index " + view.kind,
        popover: "index",
        ariaLabel: "Index status: " + view.shortLabel + ". " + title,
        ring: indexStatusRing(graph, stateName, view.kind),
		        ringIcon: STATUS_ICONS.database,
	      };
	    }

	    function composerRagStatus() {
	      const rag = state.codeGraph && state.codeGraph.rag;
	      const view = ragStatusView(rag);
	      const title = codeGraphRagMeta(rag) || view.label;
	      return {
	        text: view.shortLabel,
	        title,
		        className: "composerStatusPill oc-icon-btn oc-liquid-btn rag " + view.kind,
	        popover: "rag",
	        ariaLabel: "RAG index status: " + view.shortLabel + ". " + title,
	        ring: ragStatusRing(rag, view.kind),
		        ringIcon: STATUS_ICONS.rag,
	      };
	    }

	    function ragStatusView(rag) {
	      if (!rag || rag.availability === "not-configured") {
	        return { kind: "info", shortLabel: "RAG off", label: "RAG not configured" };
	      }
	      if (rag.availability === "ready") {
	        return { kind: "ready", shortLabel: "RAG ready", label: "RAG ready" + ragChunkProgressLabel(rag) };
	      }
	      if (rag.availability === "indexing") {
	        return { kind: "indexing", shortLabel: "RAG indexing", label: "RAG indexing" + ragChunkProgressLabel(rag) };
	      }
	      if (rag.availability === "checking") {
	        return { kind: "indexing", shortLabel: "RAG checking", label: "RAG checking embedding endpoint" };
	      }
	      if (rag.availability === "partial") {
	        return { kind: "warning", shortLabel: "RAG partial", label: "RAG partial" + ragChunkProgressLabel(rag) };
	      }
	      if (rag.availability === "paused") {
	        return { kind: "warning", shortLabel: "RAG paused", label: "RAG paused" + ragChunkProgressLabel(rag) };
	      }
	      if (rag.availability === "unavailable") {
	        return { kind: "error", shortLabel: "RAG error", label: "RAG unavailable" };
	      }
	      if (rag.availability === "not-indexed") {
	        return { kind: "warning", shortLabel: "RAG not indexed", label: "RAG not indexed" };
	      }
	      return { kind: "info", shortLabel: "RAG off", label: "RAG not configured" };
	    }

	    function ragStatusRing(rag, kind) {
	      if (kind === "indexing") {
	        const progress = ragProgressRatio(rag);
	        return progress === undefined ? { indeterminate: true } : { progress };
	      }
	      if (kind === "ready") return { progress: 1 };
	      if (kind === "warning") return { progress: ragProgressRatio(rag) ?? 0 };
	      if (kind === "error") return { progress: ragProgressRatio(rag) ?? 1 };
	      return { progress: 0 };
	    }

	    function ragProgressRatio(rag) {
	      if (!rag || !rag.chunks) return undefined;
	      return clamp01(Number(rag.embeddedChunks || rag.indexedChunkCount || 0) / Number(rag.chunks));
	    }

	    function ragChunkProgressLabel(rag) {
	      if (!rag || !rag.chunks) return "";
	      return ": " + formatCount(rag.embeddedChunks || rag.indexedChunkCount || 0) + "/" + formatCount(rag.chunks) + " chunks";
	    }

	    function permissionMode() {
      return (state.permissions && state.permissions.mode) || "ask";
    }

    function toolsEnabled() {
      return Boolean(state.tools && state.tools.enabled);
    }

    function permissionModeLabel(mode) {
      if (mode === "auto") return "替我审批";
      if (mode === "full-access") return "完全访问";
      return "请求批准";
    }

    function permissionModeDetail(mode) {
      if (mode === "auto") return "低风险工具操作自动放行，高风险操作会被阻止或要求确认，并写入审计日志。";
      if (mode === "full-access") return "工具操作不拦截、不询问，只写入审计日志。";
      return "读取 workspace 文件自动允许；写文件、命令和网络操作按次审批或阻止，并写入审计日志。";
    }

    function composerPermissionStatus() {
      const mode = permissionMode();
      const enabled = toolsEnabled();
      const label = enabled ? permissionModeLabel(mode) : "工具关闭";
      const kind = enabled ? (mode === "full-access" ? "full-access" : mode === "auto" ? "auto" : "ask") : "tools-off";
      const detail = enabled ? permissionModeDetail(mode) : "模型工具调用已关闭；权限模式暂不生效。";
      return {
        text: label,
        title: label + ": " + detail,
        className: "composerStatusPill permissionTrigger oc-chip oc-liquid-chip permission " + kind + (enabled ? "" : " is-empty"),
        popover: "permission",
        ariaLabel: enabled ? "模型工具调用：已开启。权限模式：" + label : "模型工具调用：已关闭。权限模式暂不生效。",
        icon: enabled ? (mode === "full-access" ? STATUS_ICONS.shieldAlert : STATUS_ICONS.shieldCheck) : STATUS_ICONS.toolsOff,
        showText: true,
      };
    }

    function composerSkillsStatus() {
      const skills = state.skills || {};
      const enabled = Array.isArray(skills.available) ? skills.available.filter((skill) => skill.enabled).length : (Array.isArray(skills.enabled) ? skills.enabled.length : 0);
      const total = Array.isArray(skills.available) ? skills.available.length : 0;
      const title = total ? enabled + " of " + total + " workspace skills enabled." : "No workspace skills discovered.";
      return {
        text: enabled > 0 ? "Skills " + enabled : "Skills",
        title,
        className: "composerStatusPill skillsTrigger oc-chip oc-liquid-chip context" + (total ? "" : " is-empty"),
        popover: "skills",
        ariaLabel: "Skills: " + title,
        icon: STATUS_ICONS.skill,
        showText: true,
        hidden: total === 0,
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
	          className: "composerStatusPill oc-icon-btn oc-liquid-btn guard warning",
          popover: "guard",
          ariaLabel: "Guard warning: " + detail,
          icon: STATUS_ICONS.shieldAlert,
        };
      }
      if (state.localOnlyMode === false) {
        return {
          text: "Guard off",
          title: detail,
	          className: "composerStatusPill oc-icon-btn oc-liquid-btn guard off is-hidden",
          popover: "guard",
          ariaLabel: "Guard off: " + detail,
          icon: STATUS_ICONS.shieldOff,
          hidden: true,
        };
      }
      return {
        text: "Guard ok",
        title: detail,
	        className: "composerStatusPill oc-icon-btn oc-liquid-btn guard ok is-hidden",
        popover: "guard",
        ariaLabel: "Guard ok: " + detail,
        icon: STATUS_ICONS.shieldCheck,
        hidden: true,
      };
    }

    function composerUsageStatus() {
      if (state.connectionState !== "connected") {
        return {
          text: "Usage",
          title: "Connect to load usage.",
          className: "composerStatusPill oc-icon-btn oc-liquid-btn usage pending",
          popover: "usage",
          ariaLabel: "Context usage: connect to load usage.",
          icon: STATUS_ICONS.usage,
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
        className: "composerStatusPill oc-icon-btn oc-liquid-btn usage " + kind,
        popover: "usage",
        ariaLabel: "Context usage: " + title,
        icon: STATUS_ICONS.usage,
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
      const model = state.selectedModel ? " Model: " + state.selectedModel + "." : " Model: provider default.";
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

    function renderDiagnosticsStatusPopover(root) {
      const summary = diagnosticsSummary();
      const included = Boolean(el("diag").checked);
      const total = Number(summary.total || 0);
      const limit = Number(summary.limit || 60);
      const stateText = total
        ? total + " workspace diagnostics; " + (included ? "included" : "excluded") + " in next prompt. Up to " + limit + " will be sent."
        : (included ? "Diagnostics are included, but none are currently available in this workspace." : "Diagnostics are excluded, and none are currently available in this workspace.");
      appendStatusPopoverHeader(root, "Diagnostics", stateText);
      const rows = statusRows();
      appendStatusRow(rows, included ? "Will be sent with the next prompt" : "Will not be sent with the next prompt");
      appendStatusRow(rows, diagnosticsSeverityText(summary));
      const files = Array.isArray(summary.files) ? summary.files : [];
      for (const file of files) {
        appendStatusRow(rows, diagnosticsFileText(file));
        for (const example of (file.examples || []).slice(0, 2)) {
          appendStatusRow(rows, file.path + ":" + example.line + " " + example.severity + ": " + example.message);
        }
      }
      if (!files.length && total > 0) appendStatusRow(rows, "Diagnostics exist, but no preview rows were provided.");
      root.appendChild(rows);
    }

    function diagnosticsSummary() {
      const auto = state.autoContext || {};
      const summary = auto.diagnostics || {};
      return {
        total: Number(summary.total ?? auto.diagnosticCount ?? 0),
        limit: Number(summary.limit || 60),
        counts: summary.counts || {},
        files: Array.isArray(summary.files) ? summary.files : [],
      };
    }

    function diagnosticsTotal() {
      return Number(diagnosticsSummary().total || 0);
    }

    function diagnosticsSeverityText(summary) {
      const counts = summary.counts || {};
      const parts = [
        countLabel(counts.error, "error"),
        countLabel(counts.warning, "warning"),
        countLabel(counts.information, "info"),
        countLabel(counts.hint, "hint"),
        countLabel(counts.unknown, "unknown"),
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : "No workspace diagnostics";
    }

    function diagnosticsFileText(file) {
      const parts = [
        countLabel(file.errors, "error"),
        countLabel(file.warnings, "warning"),
        countLabel(file.information, "info"),
        countLabel(file.hints, "hint"),
        countLabel(file.unknown, "unknown"),
      ].filter(Boolean);
      return file.path + ": " + Number(file.total || 0) + " diagnostics" + (parts.length ? " (" + parts.join(", ") + ")" : "");
    }

    function countLabel(value, label) {
      const count = Number(value || 0);
      if (!count) return "";
      return count + " " + label + (count === 1 ? "" : "s");
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

	    function renderRagStatusPopover(root) {
	      const rag = state.codeGraph && state.codeGraph.rag;
	      const view = ragStatusView(rag);
	      const detail = codeGraphRagMeta(rag) || "RAG not configured. Configure embedding settings to build vector evidence.";
	      appendStatusPopoverHeader(root, view.label, detail);
	      const progress = ragProgressRatio(rag);
	      if (progress !== undefined) {
	        appendStatusRow(root, "Progress " + formatRingProgress(progress) + " · " + formatCount(rag.embeddedChunks || rag.indexedChunkCount || 0) + "/" + formatCount(rag.chunks || 0) + " chunks");
	      } else if (view.kind === "indexing") {
	        appendStatusRow(root, "Progress waiting for chunk totals.");
	      }
	      const actions = [
	        ...ragControlActions(rag),
	        { label: "Settings", title: "Open RAG settings", settings: true },
	      ];
	      const actionRoot = document.createElement("div");
	      actionRoot.className = "statusPopoverActions";
	      for (const action of actions) {
	        const button = document.createElement("button");
	        button.className = "statusActionButton" + (action.settings ? " primary" : "");
	        button.type = "button";
	        button.textContent = action.label;
	        button.title = action.title || action.label;
	        button.disabled = Boolean(action.disabled);
	        if (action.message) button.setAttribute("data-code-graph-action", action.message);
	        if (action.settings) button.setAttribute("data-open-rag-settings", "true");
	        actionRoot.appendChild(button);
	      }
	      if (actionRoot.childElementCount) root.appendChild(actionRoot);
	    }

	    function renderPermissionStatusPopover(root) {
      const current = permissionMode();
      const enabled = toolsEnabled();
      appendStatusPopoverHeader(root, enabled ? permissionModeLabel(current) : "工具关闭", enabled ? permissionModeDetail(current) : "模型工具调用已关闭，权限模式暂不生效。");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toolsToggleButton oc-liquid-btn" + (enabled ? " is-on" : "");
      toggle.setAttribute("data-tools-enabled", enabled ? "false" : "true");
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", enabled ? "true" : "false");
      const toggleIcon = document.createElement("span");
      toggleIcon.className = "permissionModeIcon";
      toggleIcon.setAttribute("aria-hidden", "true");
      toggleIcon.innerHTML = STATUS_ICONS.tool;
      const toggleCopy = document.createElement("span");
      toggleCopy.className = "toolsToggleCopy";
      const toggleTitle = document.createElement("span");
      toggleTitle.className = "toolsToggleTitle";
      toggleTitle.textContent = "模型工具调用";
      const toggleDesc = document.createElement("span");
      toggleDesc.className = "toolsToggleDesc";
      toggleDesc.textContent = enabled ? "已开启，工具执行继续受下方权限模式控制。" : "已关闭，不向模型暴露工具 schema。";
      toggleCopy.append(toggleTitle, toggleDesc);
      const toggleTrack = document.createElement("span");
      toggleTrack.className = "toolsToggleTrack";
      toggleTrack.setAttribute("aria-hidden", "true");
      const toggleKnob = document.createElement("span");
      toggleKnob.className = "toolsToggleKnob";
      toggleTrack.appendChild(toggleKnob);
      toggle.append(toggleIcon, toggleCopy, toggleTrack);
      root.appendChild(toggle);
      if (!enabled) {
        const note = document.createElement("div");
        note.className = "permissionModeDisabledNote";
        note.textContent = "权限模式仅在工具开启时生效。";
        root.appendChild(note);
      }
      const list = document.createElement("div");
      list.className = "permissionModeList" + (enabled ? "" : " is-disabled");
      for (const mode of ["ask", "auto", "full-access"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "permissionModeButton oc-liquid-btn " + mode + (mode === current ? " is-active" : "");
        button.setAttribute("data-permission-mode", mode);
        button.disabled = !enabled;
        const icon = document.createElement("span");
        icon.className = "permissionModeIcon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = permissionModeIcon(mode);
        const copy = document.createElement("span");
        copy.className = "permissionModeCopy";
        const title = document.createElement("span");
        title.className = "permissionModeTitle";
        title.textContent = permissionModeLabel(mode);
        const description = document.createElement("span");
        description.className = "permissionModeDesc";
        description.textContent = permissionModeDetail(mode);
        copy.append(title, description);
        const check = document.createElement("span");
        check.className = "permissionModeCheck";
        check.setAttribute("aria-hidden", "true");
        check.innerHTML = mode === current ? LIQUID_ICONS.apply : "";
        button.append(icon, copy, check);
        button.title = enabled ? permissionModeDetail(mode) : "权限模式仅在工具开启时生效。";
        list.appendChild(button);
      }
      root.appendChild(list);
    }

    function permissionModeIcon(mode) {
      if (mode === "full-access") return STATUS_ICONS.shieldAlert;
      return STATUS_ICONS.shieldCheck;
    }

    function renderSkillsStatusPopover(root) {
      const skills = state.skills || {};
      const available = Array.isArray(skills.available) ? skills.available : [];
      const enabled = available.filter((skill) => skill.enabled);
      appendStatusPopoverHeader(root, "Skills", available.length ? enabled.length + "/" + available.length + " enabled from .agents/skills." : "No workspace skills discovered.");
      const rows = statusRows();
      if (!available.length) appendStatusRow(rows, "Add .agents/skills/<name>/SKILL.md in this workspace.");
      for (const skill of available.slice(0, 8)) {
        appendStatusRow(rows, (skill.enabled ? "Enabled: " : "Available: ") + (skill.name || skill.id));
      }
      if (available.length > 8) appendStatusRow(rows, "+" + (available.length - 8) + " more skills in settings.");
      root.appendChild(rows);
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
      const permission = target.closest("[data-permission-mode]");
      if (permission) {
        vscode.postMessage({ type: "savePermissionMode", mode: permission.getAttribute("data-permission-mode") || "ask" });
        composerPinnedStatusPopover = "";
        composerHoverStatusPopover = "";
        return;
      }
	      const toolsToggle = target.closest("[data-tools-enabled]");
	      if (toolsToggle) {
	        vscode.postMessage({ type: "saveToolsEnabled", enabled: toolsToggle.getAttribute("data-tools-enabled") === "true" });
	        return;
	      }
	      const ragSettings = target.closest("[data-open-rag-settings]");
	      if (ragSettings) {
	        openRagSettingsFromPopover();
	        return;
	      }
	      onCodeGraphAction(event);
	    }

	    function openRagSettingsFromPopover() {
	      activeSettingsSection = "rag";
	      settingsOpen = true;
	      closeComposerStatusPopoverState();
	      render();
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
        empty.textContent = state.connectionState === "connected" ? "No ChipMate sessions yet." : "Configure a provider to load chat history.";
        root.appendChild(empty);
        return;
      }
      for (const session of sessions) {
        const row = document.createElement("div");
        row.className = "sessionRow " + (session.id === state.currentSessionID ? "active" : "");
        const select = document.createElement("button");
        select.className = "sessionSelect";
        select.type = "button";
        select.title = session.title || "Untitled chat";
        const name = document.createElement("div");
        name.className = "sessionName";
        name.textContent = session.title || "Untitled chat";
        if (session.serverToolsUsed) {
          const badge = document.createElement("span");
          badge.className = "sessionBadge";
          badge.textContent = " Workspace tools used";
          name.appendChild(badge);
        }
        const time = document.createElement("div");
        time.className = "sessionTime";
        time.textContent = formatTime(session.updated || session.created);
        select.append(name, time);
        select.addEventListener("click", () => {
          vscode.postMessage({ type: "selectSession", sessionID: session.id });
          if (window.innerWidth < 760) {
            historyTouched = true;
            historyOpen = false;
            renderShell();
          }
        });
        const deleteButton = document.createElement("button");
        deleteButton.className = "sessionDelete oc-icon-btn oc-liquid-btn";
        deleteButton.type = "button";
        deleteButton.title = "Delete chat history";
        deleteButton.setAttribute("aria-label", "Delete chat history");
        deleteButton.innerHTML = LIQUID_ICONS.discard + '<span class="srOnly">Delete chat history</span>';
        deleteButton.addEventListener("click", () => {
          vscode.postMessage({ type: "deleteSession", sessionID: session.id });
        });
        row.append(select, deleteButton);
        root.appendChild(row);
      }
    }

	    function renderMessages() {
	      const root = el("messages");
	      const messages = state.messages || [];
	      const stick = autoFollowMessages && (userNearBottom || forceNextMessageFollow);
	      const previousScrollTop = root.scrollTop;
	      const horizontalScrollState = collectMessageHorizontalScrollState(root);
	      if (state.loadingMessages && messages.length === 0) {
	        const loading = document.createElement("div");
	        loading.className = "loadingLine";
	        loading.textContent = "Loading messages...";
	        root.replaceChildren(loading);
	      } else if (messages.length === 0) {
	        root.replaceChildren(emptyState());
	      } else {
	        const entries = messages.map((item, index) => {
	          const key = stableMessageKey(item, index);
	          return {
	            key,
	            fingerprint: messageRenderFingerprint(item, index, key),
	            build: () => messageNode(item, index)
	          };
	        });
	        if (state.sending && !hasAssistantContentAfterLastUser(messages)) {
	          entries.push({ key: "__thinking", fingerprint: "thinking", build: thinkingNode });
	        }
	        reconcileMessageNodes(root, entries);
	      }
	      restoreMessageHorizontalScrollState(root, horizontalScrollState);
	      requestAnimationFrame(() => {
	        if (stick) {
	          root.scrollTop = root.scrollHeight;
	          userNearBottom = true;
	          autoFollowMessages = true;
	          forceNextMessageFollow = false;
	          lastMessagesScrollTop = root.scrollTop;
	          renderJumpLatest();
	          return;
	        }
	        const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
	        root.scrollTop = Math.min(previousScrollTop, maxScrollTop);
	        userNearBottom = isNearBottom(root);
	        if (userNearBottom) autoFollowMessages = true;
	        forceNextMessageFollow = false;
	        lastMessagesScrollTop = root.scrollTop;
	        renderJumpLatest();
	      });
	    }

	    function reconcileMessageNodes(root, entries) {
	      const reusable = new Map();
	      for (const child of Array.from(root.children)) {
	        const key = child.getAttribute("data-message-key");
	        if (key) reusable.set(key, child);
	      }
	      const nextNodes = entries.map((entry) => {
	        const node = reusable.get(entry.key);
	        if (node && node.getAttribute("data-message-fingerprint") === entry.fingerprint) return node;
	        return entry.build();
	      });
	      let cursor = root.firstChild;
	      for (const node of nextNodes) {
	        if (node === cursor) {
	          cursor = cursor.nextSibling;
	          continue;
	        }
	        root.insertBefore(node, cursor);
	      }
	      while (cursor) {
	        const next = cursor.nextSibling;
	        root.removeChild(cursor);
	        cursor = next;
	      }
	    }

	    function collectMessageHorizontalScrollState(root) {
	      const scrollState = new Map();
	      for (const card of Array.from(root.querySelectorAll(".messageCard[data-message-key]"))) {
	        const key = card.getAttribute("data-message-key");
	        if (!key) continue;
	        const stateForMessage = {
	          outlineScrollLeft: Array.from(card.querySelectorAll(".messageOutline")).map((node) => node.scrollLeft),
	          codeScrollLeft: Array.from(card.querySelectorAll(".codeBlock pre")).map((node) => node.scrollLeft),
	          diagramScrollLeft: Array.from(card.querySelectorAll(".diagramCanvas, .diagramSource")).map((node) => node.scrollLeft),
	          tableScrollLeft: Array.from(card.querySelectorAll(".tableScroll")).map((node) => node.scrollLeft),
	          tableRawScrollLeft: Array.from(card.querySelectorAll(".tableRaw")).map((node) => node.scrollLeft)
	        };
	        if (
	          stateForMessage.outlineScrollLeft.some(Boolean) ||
	          stateForMessage.codeScrollLeft.some(Boolean) ||
	          stateForMessage.diagramScrollLeft.some(Boolean) ||
	          stateForMessage.tableScrollLeft.some(Boolean) ||
	          stateForMessage.tableRawScrollLeft.some(Boolean)
	        ) {
	          scrollState.set(key, stateForMessage);
	        }
	      }
	      return scrollState;
	    }

	    function restoreMessageHorizontalScrollState(root, scrollState) {
	      for (const card of Array.from(root.querySelectorAll(".messageCard[data-message-key]"))) {
	        const key = card.getAttribute("data-message-key");
	        if (!key) continue;
	        const saved = scrollState.get(key);
	        restoreNestedScrollList(card.querySelectorAll(".messageOutline"), saved && saved.outlineScrollLeft, "scrollLeft");
	        restoreNestedScrollList(card.querySelectorAll(".codeBlock pre"), saved && saved.codeScrollLeft, "scrollLeft");
	        restoreNestedScrollList(card.querySelectorAll(".diagramCanvas, .diagramSource"), saved && saved.diagramScrollLeft, "scrollLeft");
	        restoreNestedScrollList(card.querySelectorAll(".tableScroll"), saved && saved.tableScrollLeft, "scrollLeft");
	        restoreNestedScrollList(card.querySelectorAll(".tableRaw"), saved && saved.tableRawScrollLeft, "scrollLeft");
	      }
	    }

	    function restoreNestedScrollList(nodes, values, property) {
	      if (!values) return;
	      Array.from(nodes).forEach((node, index) => {
	        const value = values[index] || 0;
	        if (value > 0) node[property] = value;
	      });
	    }

	    function handleMessagesScroll(root) {
	      const nextNearBottom = isNearBottom(root);
	      const movedUp = root.scrollTop < lastMessagesScrollTop - 1;
	      userNearBottom = nextNearBottom;
	      if (nextNearBottom) {
	        autoFollowMessages = true;
	      } else if (movedUp) {
	        autoFollowMessages = false;
	      }
	      lastMessagesScrollTop = root.scrollTop;
	      renderJumpLatest();
	    }

	    function redirectNestedVerticalWheel(event, root) {
	      const nested = nestedMessageScroller(event.target);
	      if (!nested) return false;
	      if (!isPlainVerticalWheel(event)) {
	        pauseAutoFollowForUser();
	        return false;
	      }
	      if (event.deltaY < 0) pauseAutoFollowForUser();
	      event.preventDefault();
	      root.scrollTop += event.deltaY;
	      handleMessagesScroll(root);
	      return true;
	    }

	    function isPlainVerticalWheel(event) {
	      if (event.shiftKey) return false;
	      return Math.abs(event.deltaY) > Math.abs(event.deltaX);
	    }

	    function pauseAutoFollowForUser() {
	      if (!autoFollowMessages) return;
	      autoFollowMessages = false;
	      renderJumpLatest();
	    }

	    function enableAutoFollowMessages() {
	      autoFollowMessages = true;
	      userNearBottom = true;
	      forceNextMessageFollow = true;
	      renderJumpLatest();
	    }

	    function jumpToLatestMessage() {
	      const root = el("messages");
	      enableAutoFollowMessages();
	      root.scrollTop = root.scrollHeight;
	      lastMessagesScrollTop = root.scrollTop;
	      renderJumpLatest();
	    }

	    function renderJumpLatest() {
	      const button = el("jumpLatest");
	      const visible = Boolean(!autoFollowMessages && !userNearBottom && messageHasAnyContent(state.messages || []));
	      button.classList.toggle("visible", visible);
	      button.setAttribute("aria-hidden", visible ? "false" : "true");
	      button.tabIndex = visible ? 0 : -1;
	    }

	    function messageHasAnyContent(messages) {
	      return messages.some((item) => messageHasContent(item));
	    }

	    function isNestedMessageScroller(target) {
	      return Boolean(nestedMessageScroller(target));
	    }

	    function nestedMessageScroller(target) {
	      const node = target && target.nodeType === 1 ? target : target && target.parentElement;
	      return node ? node.closest(".codeBlock pre, .diagramCanvas, .diagramSource, .tableScroll, .tableRaw, .messageOutline, .toolCard pre") : null;
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
        const hero = document.createElement("div");
        hero.className = "emptyHeroIcon";
        appendLiquidIcon(hero, "chat");
	      const title = document.createElement("div");
	      title.className = "emptyTitle";
	      title.textContent = state.connectionState === "connected" ? "Ask with context" : "Configure ChipMate";
	      node.append(hero, title);
	      const prompts = document.createElement("div");
	      prompts.className = "emptyPrompts";
	      for (const item of [
          { label: "Explain file", caption: "Summarize the current file.", prompt: "Explain the current file.", icon: "file" },
          { label: "Refactor", caption: "Improve the selected code.", prompt: "Refactor this safely.", icon: "sparkle" },
          { label: "Review diff", caption: "Check the current diff.", prompt: "Review the current diff.", icon: "diff" },
        ]) {
	        const prompt = document.createElement("button");
          prompt.type = "button";
	        prompt.className = "emptyCommand";
          prompt.title = item.label;
          prompt.setAttribute("aria-label", item.label);
          const icon = document.createElement("span");
          icon.className = "emptyCommandIcon";
          appendLiquidIcon(icon, item.icon);
          const main = document.createElement("span");
          main.className = "emptyCommandMain";
          const label = document.createElement("span");
          label.className = "emptyCommandTitle";
	        label.textContent = item.label;
          const caption = document.createElement("span");
          caption.className = "emptyCommandCaption";
          caption.textContent = item.caption;
          main.append(label, caption);
          const arrow = document.createElement("span");
          arrow.className = "emptyCommandArrow";
          arrow.setAttribute("aria-hidden", "true");
          arrow.textContent = "›";
          prompt.append(icon, main, arrow);
          prompt.addEventListener("click", () => {
            el("input").value = item.prompt;
            onComposerInput();
            el("input").focus();
          });
	        prompts.appendChild(prompt);
	      }
      node.appendChild(prompts);
      return node;
    }

	    function messageNode(item, index) {
	      const messageKey = stableMessageKey(item, index);
	      const bodyId = "message-body-" + domSafeId(messageKey);
	      const node = document.createElement("article");
	      node.className = "timelineItem " + (item.role || "message");
	      node.setAttribute("data-message-key", messageKey);
	      node.setAttribute("data-message-fingerprint", messageRenderFingerprint(item, index, messageKey));
	      const avatar = document.createElement("div");
      avatar.className = "avatar";
      setAvatarContent(avatar, item.role);
      const card = document.createElement("div");
      card.setAttribute("data-message-key", messageKey);
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      const role = document.createElement("span");
      role.className = "messageRole";
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
	      const isCollapsed = collapsedMessages.has(messageKey);
	      card.className = "messageCard"
	        + (isCollapsed ? " messageCollapsed" : "");
	      const actions = messageActions(item, messageKey, bodyId, {
	        hasStructureTargets: structureTargets.length > 0,
	        isCollapsed
	      });
      if (actions.childElementCount) stats.appendChild(actions);
      stats.appendChild(time);
      meta.append(role, stats);
      card.appendChild(meta);
	      const outline = messageOutline(body, messageKey);
	      if (outline) card.appendChild(outline);
	      card.appendChild(body);
	      node.append(avatar, card);
	      return node;
	    }

	    function messageRenderFingerprint(item, index, messageKey) {
	      const payload = {
	        role: item.role || "message",
	        text: item.text || "",
	        parts: item.parts || [],
	        usage: item.usage || null,
	        timeCreated: item.timeCreated || "",
	        collapsed: collapsedMessages.has(messageKey || stableMessageKey(item, index))
	      };
	      try {
	        return JSON.stringify(payload);
	      } catch {
	        return String(payload.role) + ":" + String(payload.text).length + ":" + String(payload.timeCreated);
	      }
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
        const copyTitle = item.role === "user" ? "Copy question text" : "Copy answer text";
        const copyFeedback = item.role === "user" ? "Copied question." : "Copied answer.";
        const markdownTitle = item.role === "user" ? "Copy question as Markdown" : "Copy answer as Markdown";
        actions.appendChild(messageActionButton("Copy", copyTitle, "copyAnswer", (button) => copyTextWithFeedback(markdownToPlainText(item.text), button, copyFeedback)));
        actions.appendChild(messageActionButton("MD", markdownTitle, "copyMarkdown", (button) => copyTextWithFeedback(item.text, button, "Copied Markdown.")));
      }
      if (options.hasStructureTargets) {
        actions.appendChild(messageActionButton("Jump", "Jump to next code, diagram, or table block", "jumpStructure", () => scrollToNextMessageStructure(messageKey)));
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
	      button.className = "messageAction oc-icon-btn oc-liquid-btn " + className;
        const icon = messageActionIcon(className, label);
        setIconOnlyButton(button, icon, title);
	      button.addEventListener("click", (event) => {
	        event.stopPropagation();
	        onClick(button);
	      });
	      return button;
	    }

	    function messageActionIcon(className, label) {
	      if (className === "copyAnswer" || className === "copyMarkdown") return "copy";
	      if (className === "jumpStructure") return "references";
	      if (className === "collapseMessage") return label === "Expand" ? "add" : "discard";
	      return "more";
	    }

    function toggleMessageCollapse(messageKey) {
      if (collapsedMessages.has(messageKey)) collapsedMessages.delete(messageKey);
      else collapsedMessages.add(messageKey);
      renderMessages();
    }

	    function messageStructureTargets(root) {
	      return Array.from(root.querySelectorAll(".codeBlock, .diagramBlock, .tableBlock"));
	    }

    function messageOutline(body, messageKey) {
      const headings = Array.from(body.querySelectorAll(".mdHeading"));
      const codeBlocks = Array.from(body.querySelectorAll(".codeBlock"));
      const diagrams = Array.from(body.querySelectorAll(".diagramBlock"));
      const tables = Array.from(body.querySelectorAll(".tableBlock"));
      const totalStructures = headings.length + codeBlocks.length + diagrams.length + tables.length;
      if (totalStructures < 3 && headings.length < 2 && (codeBlocks.length + diagrams.length + tables.length) < 2) return undefined;
      const outline = document.createElement("nav");
      outline.className = "messageOutline";
      outline.setAttribute("aria-label", "Answer outline");
      const summary = document.createElement("span");
      summary.className = "messageOutlineSummary";
      summary.textContent = headings.length + " sections / " + codeBlocks.length + " code / " + diagrams.length + " diagram / " + tables.length + " table";
      outline.appendChild(summary);
      const targets = [];
      for (const heading of headings) targets.push({ label: compactLabel(heading.textContent || "Section"), target: heading });
      for (let index = 0; index < codeBlocks.length; index += 1) targets.push({ label: "Code " + (index + 1), target: codeBlocks[index] });
      for (let index = 0; index < diagrams.length; index += 1) targets.push({ label: "Diagram " + (index + 1), target: diagrams[index] });
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
	      pauseAutoFollowForUser();
	      scrollTargetWithinContainer(target, el("messages"));
	      target.classList.add("structureFlash");
	      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
	      target.focus({ preventScroll: true });
	      window.setTimeout(() => target.classList.remove("structureFlash"), 900);
	    }

	    function scrollTargetWithinContainer(target, container) {
	      const targetRect = target.getBoundingClientRect();
	      const containerRect = container.getBoundingClientRect();
	      let nextTop = container.scrollTop;
	      if (targetRect.top < containerRect.top) {
	        nextTop += targetRect.top - containerRect.top - 8;
	      } else if (targetRect.bottom > containerRect.bottom) {
	        nextTop += targetRect.bottom - containerRect.bottom + 8;
	      }
	      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
	      const top = Math.max(0, Math.min(nextTop, maxTop));
	      if (typeof container.scrollTo === "function") container.scrollTo({ top, behavior: "smooth" });
	      else container.scrollTop = top;
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
	      node.setAttribute("data-message-key", "__thinking");
	      node.setAttribute("data-message-fingerprint", "thinking");
	      const avatar = document.createElement("div");
      avatar.className = "avatar";
      setAvatarContent(avatar, "assistant");
      const card = document.createElement("div");
      card.className = "messageCard";
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      meta.textContent = "ChipMate";
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
      const reasoningParts = parts.filter((part) => part.type === "reasoning");
      const toolParts = parts.filter((part) => part.type === "tool");
      const warningParts = parts.filter((part) => part.type === "serverToolWarning");
      for (const part of reasoningParts) {
        root.appendChild(partCard(part, "Thinking", "reasoning"));
      }
      if (toolParts.length > 0) {
        root.appendChild(toolGroupCard(toolParts));
      }
      for (const part of warningParts) {
        root.appendChild(partCard(part, "Warning: workspace filesystem tool used", "serverWarning"));
      }
    }

    function partCard(part, summaryText, className) {
      const details = document.createElement("details");
      details.className = "toolCard"
        + (className ? " " + className : "")
        + (part.status === "running" ? " is-running" : "");
      const summary = document.createElement("summary");
      appendPartSummary(summary, part, summaryText, className);
      const body = document.createElement("pre");
      body.textContent = part.detail || part.text || "";
      details.append(summary, body);
      return details;
    }

    function appendPartSummary(summary, part, summaryText, className) {
      if (className !== "reasoning" || part.status !== "running") {
        summary.textContent = summaryText;
        return;
      }
      const label = document.createElement("span");
      label.className = "reasoningSummaryLabel";
      label.textContent = "Thinking...";
      summary.appendChild(label);
      if (part.preview) {
        const preview = document.createElement("span");
        preview.className = "reasoningPreview";
        preview.textContent = part.preview;
        preview.title = part.preview;
        summary.appendChild(preview);
      }
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.setAttribute("aria-hidden", "true");
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      summary.appendChild(dots);
    }

    function toolGroupCard(parts) {
      const details = document.createElement("details");
      details.className = "toolCard toolGroup";
      const summary = document.createElement("summary");
      summary.textContent = toolGroupSummary(parts);
      const body = document.createElement("pre");
      body.textContent = toolGroupDetail(parts);
      details.append(summary, body);
      return details;
    }

    function toolGroupSummary(parts) {
      if (parts.length === 1) return toolSummaryLabel(parts[0]);
      const names = toolNameCounts(parts).map((item) => item.name + " x" + item.count).join(", ");
      const status = toolStatusSummary(parts);
      return "Tools: " + parts.length + " calls" + (names ? " · " + names : "") + (status ? " · " + status : "");
    }

    function toolNameCounts(parts) {
      const counts = new Map();
      for (const part of parts) {
        const name = part.title || "tool";
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
    }

    function toolStatusSummary(parts) {
      const counts = new Map();
      for (const part of parts) {
        const status = part.status || "called";
        counts.set(status, (counts.get(status) || 0) + 1);
      }
      const items = Array.from(counts.entries());
      if (items.length === 0) return "";
      if (items.length === 1) return items[0][0];
      return items.map(([status, count]) => status + " x" + count).join(", ");
    }

    function toolGroupDetail(parts) {
      return parts.map((part, index) => {
        const detail = part.detail || part.text || "";
        return String(index + 1) + ". " + toolSummaryLabel(part) + (detail ? "\\n" + detail : "");
      }).join("\\n\\n");
    }

    function toolSummaryLabel(part) {
      return "Tool: " + (part.title || "tool") + (part.status ? " - " + part.status : "");
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
      const flushPendingCode = () => {
        root.appendChild(isMermaidLanguage(language)
          ? pendingMermaidSourceBlock(language, codeLines.join("\\n"))
          : codeBlock(language, codeLines.join("\\n")));
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
      if (inCode) flushPendingCode();
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
      const copyMarkdown = tableButton("copy", "Copy table as Markdown", "copyTable copyTableMarkdown", () => copyTextWithFeedback(tableToMarkdown(tableData), copyMarkdown, "Copied table Markdown."));
      const copyCsv = tableButton("copy", "Copy table as CSV", "copyTable copyTableCsv", () => copyTextWithFeedback(tableToCsv(tableData), copyCsv, "Copied table CSV."));
      const raw = tableButton("more", "Show raw table text", "toggleTableRaw", () => {
        const isRaw = block.classList.toggle("raw");
        const nextTitle = isRaw ? "Show rendered table" : "Show raw table text";
        setIconOnlyButton(raw, "more", nextTitle);
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

    function tableButton(iconName, title, className, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className + " oc-icon-btn oc-liquid-btn";
      setIconOnlyButton(button, iconName, title);
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

    function isMermaidLanguage(language) {
      const value = String(language || "").trim().toLowerCase().split(/\\s+/)[0];
      return value === "mermaid" || value === "mmd";
    }

    function codeBlock(language, codeText) {
      if (isMermaidLanguage(language)) return diagramBlock(language, codeText);
      return sourceCodeBlock(language, codeText);
    }

    function pendingMermaidSourceBlock(language, codeText) {
      return sourceCodeBlock((language || "mermaid") + " source pending", codeText);
    }

    function sourceCodeBlock(language, codeText) {
      const block = document.createElement("div");
      block.className = "codeBlock";
      const head = document.createElement("div");
      head.className = "codeHead";
      const label = document.createElement("span");
      label.className = "codeLanguage";
      label.textContent = language || "plain text";
	      const copy = document.createElement("button");
	      copy.className = "copyCode oc-icon-btn oc-liquid-btn";
	      copy.type = "button";
	      setIconOnlyButton(copy, "copy", "Copy code block");
	      copy.addEventListener("click", () => copyCode(codeText, copy));
      head.append(label, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      appendHighlightedCode(code, codeText, language);
      pre.appendChild(code);
      block.append(head, pre);
      return block;
    }

    function diagramBlock(language, codeText) {
      const block = document.createElement("section");
      block.className = "diagramBlock";
      block.setAttribute("role", "region");
      block.setAttribute("aria-label", "Mermaid diagram");
      block.setAttribute("data-diagram-kind", "mermaid");
      block.setAttribute("tabindex", "-1");
      const head = document.createElement("div");
      head.className = "codeHead";
      const label = document.createElement("span");
      label.className = "codeLanguage";
      label.textContent = language || "mermaid";
      const actions = document.createElement("span");
      actions.className = "diagramActions";
      const source = document.createElement("button");
      source.className = "toggleDiagramSource oc-icon-btn oc-liquid-btn";
      source.type = "button";
      source.setAttribute("aria-pressed", "false");
      setIconOnlyButton(source, "references", "Show Mermaid source");
      const copy = document.createElement("button");
      copy.className = "copyCode oc-icon-btn oc-liquid-btn";
      copy.type = "button";
      setIconOnlyButton(copy, "copy", "Copy Mermaid source");
      copy.addEventListener("click", () => copyCode(codeText, copy));
      actions.append(source, copy);
      head.append(label, actions);
      const canvas = document.createElement("div");
      canvas.className = "diagramCanvas";
      canvas.appendChild(diagramStatus("Rendering Mermaid diagram...", false));
      const sourcePre = document.createElement("pre");
      sourcePre.className = "diagramSource";
      const sourceCode = document.createElement("code");
      sourceCode.textContent = codeText;
      sourcePre.appendChild(sourceCode);
      source.addEventListener("click", () => {
        const visible = !block.classList.contains("show-source");
        block.classList.toggle("show-source", visible);
        source.setAttribute("aria-pressed", visible ? "true" : "false");
        setIconOnlyButton(source, visible ? "discard" : "references", visible ? "Hide Mermaid source" : "Show Mermaid source");
      });
      block.append(head, canvas, sourcePre);
      renderMermaidDiagram(block, canvas, codeText);
      return block;
    }

    function diagramStatus(text, isError) {
      const status = document.createElement("div");
      status.className = "diagramStatus" + (isError ? " error" : "");
      status.textContent = text;
      return status;
    }

    async function renderMermaidDiagram(block, canvas, codeText) {
      const source = String(codeText || "");
      if (!source.trim()) {
        renderMermaidFallback(block, canvas, "Empty Mermaid diagram.");
        return;
      }
      if (textByteLength(source) > MERMAID_MAX_SOURCE_BYTES) {
        renderMermaidFallback(block, canvas, "Mermaid source is too large to render. Source view is available.");
        return;
      }
      const mermaid = initializeMermaid();
      if (!mermaid) {
        renderMermaidFallback(block, canvas, "Mermaid renderer is not available. Source view is available.");
        return;
      }
      const renderId = "chipmate-mermaid-" + (++mermaidRenderSerial);
      try {
        const result = await mermaid.render(renderId, source);
        if (!canvas.isConnected) return;
        canvas.innerHTML = result && result.svg ? result.svg : "";
        if (!canvas.firstChild) canvas.appendChild(diagramStatus("Mermaid produced an empty diagram.", true));
      } catch (error) {
        renderMermaidFallback(block, canvas, "Mermaid render failed: " + diagramErrorMessage(error));
      }
    }

    function initializeMermaid() {
      const mermaid = globalThis.mermaid;
      if (!mermaid || typeof mermaid.initialize !== "function" || typeof mermaid.render !== "function") return undefined;
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: mermaidTheme(),
          htmlLabels: false,
          flowchart: { htmlLabels: false }
        });
        mermaidInitialized = true;
      }
      return mermaid;
    }

    function mermaidTheme() {
      const root = document.documentElement;
      const body = document.body;
      return root.classList.contains("vscode-dark") || body.classList.contains("vscode-dark") ? "dark" : "default";
    }

    function renderMermaidFallback(block, canvas, message) {
      if (!canvas.isConnected) return;
      canvas.replaceChildren(diagramStatus(message, true));
      block.classList.add("show-source");
    }

    function diagramErrorMessage(error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      return message.replace(/\\s+/g, " ").trim().slice(0, 220) || "Unknown error";
    }

    function textByteLength(value) {
      try {
        return new TextEncoder().encode(String(value || "")).length;
      } catch {
        return String(value || "").length;
      }
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
	      const previousLabel = button ? (button.getAttribute("aria-label") || button.title || button.textContent || "Copy") : "";
	      try {
	        await navigator.clipboard.writeText(String(text || ""));
	        if (button) setButtonTemporaryLabel(button, "Copied", previousLabel);
	        setNotice(successMessage || "Copied.");
	      } catch {
	        if (button) setButtonTemporaryLabel(button, "Failed", previousLabel);
	        setNotice("Copy failed.");
	      }
	    }

      function setButtonTemporaryLabel(button, label, fallback) {
        const sr = button.querySelector(".srOnly");
        if (sr) {
          sr.textContent = label;
          button.title = label;
          button.setAttribute("aria-label", label);
          window.setTimeout(() => {
            sr.textContent = fallback || "Copy";
            button.title = fallback || "Copy";
            button.setAttribute("aria-label", fallback || "Copy");
          }, 1200);
          return;
        }
        const previousText = button.textContent || fallback || "Copy";
        button.textContent = label;
        window.setTimeout(() => {
          button.textContent = previousText;
        }, 1200);
      }

    async function copyCode(text, button) {
      await copyTextWithFeedback(text, button, "Copied code.");
    }

    function ragControlActions(rag) {
      if (!rag) return [];
      if (rag.availability === "indexing") {
        return [
          { label: "Pause", message: "pauseRagIndexing", title: "Pause RAG indexing" },
          { label: "Cancel", message: "cancelRagIndexing", title: "Cancel RAG indexing" },
        ];
      }
      if (rag.availability === "paused") {
        return [
          { label: "Resume", message: "resumeRagIndexing", title: "Resume RAG indexing" },
          { label: "Cancel", message: "cancelRagIndexing", title: "Cancel RAG indexing" },
        ];
      }
      return [];
    }

    function codeGraphView(graph, stateName) {
      const files = formatCount(graph.indexedFiles || 0);
      const functions = formatCount(graph.indexedFunctions || 0);
      if (stateName === "ready") {
        const intelLoading = Boolean(state.loadingCodeIntelligence);
        const intelLabel = intelLoading ? "Loading..." : codeIntelligenceVisible ? "Refresh" : "Intel";
        const actions = [
          { label: intelLabel, message: "refreshCodeIntelligence", title: codeIntelligenceVisible ? "Refresh local code intelligence panel" : "Show local code intelligence panel", disabled: intelLoading },
          { label: "Rebuild", message: "rebuildCodeGraph", title: "Rebuild local code graph" },
          { label: "Status", message: "showCodeGraphStatus", title: "Show local code graph status" },
          ...ragControlActions(graph.rag),
        ];
        return {
          label: "Indexed: " + files + " files, " + functions + " functions",
          meta: codeGraphMeta(graph),
          actions,
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
      const rag = codeGraphRagMeta(graph.rag);
      if (rag) parts.push(rag);
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
      const rag = codeGraphRagMeta(graph.rag);
      if (rag) parts.push(rag + ".");
      return parts.filter(Boolean).join(" ");
    }

    function codeGraphRagMeta(rag) {
      if (!rag) return "";
      const rerank = rag.rerankEnabled
        ? ", rerank ready"
        : (rag.rerankProvider || rag.rerankLastError)
          ? ", rerank unavailable" + (rag.rerankLastError ? ": " + rag.rerankLastError : "")
          : "";
	      if (rag.embeddingEnabled) {
	        if (rag.availability === "indexing") return ragIndexingMeta(rag) + rerank;
	        if (rag.availability === "partial") {
	          return "RAG partial: " + formatCount(rag.embeddedChunks || 0) + "/" + formatCount(rag.chunks || 0) + " chunks, " + formatCount(rag.pendingChunkCount || Math.max(0, (rag.chunks || 0) - (rag.embeddedChunks || 0))) + " pending" + ragElapsedMeta(rag) + ragWorkerMeta(rag) + ragResumeScheduleMeta(rag) + rerank;
	        }
	        if (rag.availability === "paused") {
	          return "RAG indexing paused: " + ragPausedReasonMeta(rag) + ragElapsedMeta(rag) + ragWorkerMeta(rag) + ragResumeScheduleMeta(rag) + ", " + formatCount(rag.embeddedChunks || 0) + "/" + formatCount(rag.chunks || 0) + " chunks" + rerank;
	        }
	        return "RAG ready: " + formatCount(rag.embeddedChunks || 0) + "/" + formatCount(rag.chunks || 0) + " chunks" + ragElapsedMeta(rag, "total") + ragWorkerMeta(rag) + rerank;
	      }
	      if (rag.availability === "checking") return "RAG checking" + rerank;
	      if (rag.availability === "indexing") return ragIndexingMeta(rag) + rerank;
	      if (rag.availability === "partial") return "RAG partial: " + formatCount(rag.embeddedChunks || 0) + "/" + formatCount(rag.chunks || 0) + " chunks" + ragElapsedMeta(rag) + ragWorkerMeta(rag) + ragResumeScheduleMeta(rag) + rerank;
	      if (rag.availability === "paused") return "RAG indexing paused: " + ragPausedReasonMeta(rag) + ragElapsedMeta(rag) + ragWorkerMeta(rag) + ragResumeScheduleMeta(rag) + rerank;
      if (rag.availability === "not-indexed") return "RAG not indexed" + (rag.fallbackReason ? ": " + rag.fallbackReason : "") + rerank;
      if (rag.availability === "unavailable") return "RAG unavailable" + (rag.fallbackReason ? ": " + rag.fallbackReason : "") + rerank;
      return "RAG not configured" + rerank;
    }

    function ragIndexingMeta(rag) {
	      const progress = rag.indexProgress || {};
	      const chunks = formatCount(rag.embeddedChunks || 0) + "/" + formatCount(rag.chunks || 0) + " chunks";
	      const pending = formatCount(rag.pendingChunkCount || Math.max(0, (rag.chunks || 0) - (rag.embeddedChunks || 0))) + " pending";
	      const telemetry = ragElapsedMeta(rag) + ragWorkerMeta(rag);
	      if (progress.phase === "batch") {
	        const requestLimit = progress.requestLimit && progress.requestLimit > 0 ? String(progress.requestLimit) : "unlimited";
	        return "RAG indexing: " + chunks + ", batch " + progress.batchIndex + "/" + progress.batchCount + ", request " + progress.requestNumber + "/" + requestLimit + ", " + pending + telemetry;
	      }
	      if (progress.phase === "delay") return "RAG indexing: " + chunks + ", waiting " + progress.delayMs + "ms, " + pending + telemetry;
	      if (progress.phase === "rate-limit") return "RAG indexing: " + chunks + ", rate limited retry " + progress.retry + "/" + progress.maxRetries + ", " + pending + telemetry;
	      if (progress.phase === "paused") return "RAG indexing paused: " + chunks + ", " + pending + telemetry;
	      return "RAG indexing: " + chunks + ", " + pending + telemetry;
	    }

	    function ragElapsedMeta(rag, label) {
	      const elapsedMs = rag.indexElapsedMs ?? (rag.indexProgress && rag.indexProgress.elapsedMs);
	      if (elapsedMs === undefined) return "";
	      return ", " + (label || "elapsed") + " " + formatDuration(elapsedMs);
	    }

	    function ragWorkerMeta(rag) {
	      const worker = rag.workerStatus || (rag.indexProgress && rag.indexProgress.workerStatus);
	      if (!worker) return "";
	      const change = worker.lastChange
	        ? "; " + (worker.lastChange.direction === "upgrade" ? "upgraded" : "degraded") + " " + worker.lastChange.fromWorkers + "->" + worker.lastChange.toWorkers + ": " + worker.lastChange.reason
	        : "";
	      return ", workers " + worker.activeWorkers + "/" + worker.maxWorkers + ", " + worker.inFlightRequests + " in flight, " + worker.queuePending + " queued" + change;
	    }

    function ragPausedReasonMeta(rag) {
      if (rag.fallbackReason) return rag.fallbackReason;
      const detail = rag.lastError || "";
      if (rag.indexPausedReason === "request-budget") return "request budget reached" + (detail ? ": " + detail : "");
      if (rag.indexPausedReason === "rate-limit") return "rate limited" + (detail ? ": " + detail : "");
      if (rag.indexPausedReason === "provider-error") return "provider error" + (detail ? ": " + detail : "");
      if (rag.indexPausedReason === "manual") return "paused by user" + (detail ? ": " + detail : "");
      return "indexing paused" + (detail ? ": " + detail : "");
    }

    function ragResumeScheduleMeta(rag) {
      if (!rag.resumeScheduledAt || !rag.resumeReason) return "";
      const remainingMs = Math.max(0, rag.resumeScheduledAt - Date.now());
      const label = rag.resumeReason === "rate-limit" ? "retry scheduled" : "resume scheduled";
      return "; " + label + " in " + Math.ceil(remainingMs / 1000) + "s";
    }

	    function formatCount(value) {
	      return Number(value || 0).toLocaleString();
	    }

	    function formatDuration(value) {
	      const safeMs = Math.max(0, Math.floor(Number(value || 0)));
	      if (safeMs < 1000) return safeMs + "ms";
	      const totalSeconds = Math.floor(safeMs / 1000);
	      const seconds = totalSeconds % 60;
	      const totalMinutes = Math.floor(totalSeconds / 60);
	      const minutes = totalMinutes % 60;
	      const hours = Math.floor(totalMinutes / 60);
	      if (hours > 0) return hours + "h " + minutes + "m " + seconds + "s";
	      if (minutes > 0) return minutes + "m " + seconds + "s";
	      return (safeMs / 1000).toFixed(safeMs < 10000 ? 1 : 0) + "s";
	    }

    function formatCompactCount(value) {
      const number = Number(value || 0);
      const absolute = Math.abs(number);
      if (absolute < 1000) return String(Math.round(number));
      if (absolute < 1000000) return (Math.round(number / 100) / 10).toFixed(1).replace(/\\.0$/, "") + "k";
      return (Math.round(number / 100000) / 10).toFixed(1).replace(/\\.0$/, "") + "m";
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
        select.appendChild(modelOption("", state.loadingModels ? "Loading models..." : "Use provider default"));
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
        setIconOnlyButton(button, "refresh", input.label);
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
        const warning = Boolean(state.modelError);
        setChipLabel(trigger, warning ? "diagnostics" : "server", warning ? "model" : shortModelName(label));
	      trigger.title = warning ? state.modelError : label;
	      trigger.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false");
	      trigger.className = "modelTrigger oc-chip oc-liquid-chip"
          + (modelMenuOpen ? " open is-active" : "")
          + (warning ? " warning" : "");
	    }

    function toggleModelMenu() {
      modelMenuOpen = !modelMenuOpen;
      if (modelMenuOpen) {
        agentMenuOpen = false;
        composerMoreMenuOpen = false;
      }
      renderComposerMoreMenu();
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

      root.appendChild(modelMenuItem("", "Use provider default", "Provider chooses the model"));
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
        setChipLabel(trigger, localOnlyAgentBlocked() ? "diagnostics" : "agent", label);
	      trigger.title = agentTitle();
	      trigger.setAttribute("aria-expanded", agentMenuOpen ? "true" : "false");
	      trigger.className = "modelTrigger agentTrigger oc-chip oc-liquid-chip"
	        + (agentMenuOpen ? " open" : "")
	        + (localOnlyAgentBlocked() ? " warning" : " ready");
	    }

    function toggleAgentMenu() {
      agentMenuOpen = !agentMenuOpen;
      if (agentMenuOpen) {
        modelMenuOpen = false;
        composerMoreMenuOpen = false;
      }
      renderComposerMoreMenu();
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

    function toggleComposerMoreMenu() {
      composerMoreMenuOpen = !composerMoreMenuOpen;
      if (composerMoreMenuOpen) {
        modelMenuOpen = false;
        agentMenuOpen = false;
        closeComposerStatusPopoverState();
      }
      renderModelMenu();
      renderModelTrigger();
      renderAgentMenu();
      renderAgentTrigger();
      renderComposerStatusBar();
      renderComposerMoreMenu();
    }

    function renderComposerMoreMenu() {
      const trigger = el("composerMore");
      const root = el("composerMoreMenu");
      if (!trigger || !root) return;
      trigger.setAttribute("aria-expanded", composerMoreMenuOpen ? "true" : "false");
      root.className = "modelMenu composerMoreMenu" + (composerMoreMenuOpen ? " open" : "");
      root.setAttribute("aria-hidden", composerMoreMenuOpen ? "false" : "true");
      if (composerMoreMenuOpen) positionComposerMoreMenu();
    }

    function positionComposerMoreMenu() {
      positionPopupMenu("composerMoreMenu", "composerMore", composerMoreMenuOpen);
    }

    function onComposerMoreKeydown(event) {
      if (event.key === "Escape" && composerMoreMenuOpen) {
        event.preventDefault();
        composerMoreMenuOpen = false;
        renderComposerMoreMenu();
        el("composerMore").focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      if (!composerMoreMenuOpen) toggleComposerMoreMenu();
      requestAnimationFrame(() => focusPopupMenuItem("composerMoreMenu", event.key));
    }

    function renderAgentMenu() {
      const root = el("agentMenu");
      root.innerHTML = "";
      root.className = "modelMenu agentMenu" + (agentMenuOpen ? " open" : "");
      root.setAttribute("aria-hidden", agentMenuOpen ? "false" : "true");
      if (!agentMenuOpen) return;

      const agents = state.agents || [];
      const required = state.localOnlyAgent || state.selectedAgent || "chipmate-local";
      const hasRequired = agents.some((agent) => agentMatchesRequired(agent, required));
      if (!hasRequired) {
        root.appendChild(agentMenuItem({ id: required, name: required, description: "Required ChipMate workspace agent is missing" }, true, false, true));
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
        ? (agent.description || "Required for ChipMate workspace context")
        : "Unavailable for ChipMate workspace mode";
      button.append(label, detail);
      return button;
    }

    function currentModelLabel() {
      const current = state.selectedModel || "";
      if (!current) return "Use provider default";
      const match = (state.models || []).find((model) => model.id === current);
      return match ? (match.name || match.modelID || match.id) : current;
    }

    function currentAgentLabel() {
      if (!state.localOnlyMode && !state.selectedAgent) return "No agent";
      const current = state.selectedAgent || state.localOnlyAgent || "chipmate-local";
      if (state.loadingAgents) return "Loading agent";
      if (localOnlyAgentBlocked()) return "agent";
      return current;
    }

    function agentTitle() {
      if (state.localOnlyWarning) return state.localOnlyWarning;
      if (!state.localOnlyMode && !state.selectedAgent) return "ChipMate direct runtime chooses the agent";
      return "Using required ChipMate workspace agent: " + (state.selectedAgent || state.localOnlyAgent || "chipmate-local");
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
      if (!value) return "Provider default";
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
        const node = document.createElement("button");
        node.type = "button";
        node.className = "suggestion " + (index === activeSuggestion ? "active" : "");
        node.title = file.label;
        node.setAttribute("aria-label", file.label);
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
      if (role === "assistant") return "ChipMate";
      if (role === "tool") return "Tool";
      if (role === "error") return "Error";
      return "Message";
    }

    function avatarText(role) {
      if (role === "user") return "You";
      if (role === "error") return "!";
      if (role === "tool") return "T";
      return "Message";
    }

    function setAvatarContent(avatar, role) {
      if (role === "assistant") {
        appendBrandAvatar(avatar);
        return;
      }
      avatar.textContent = avatarText(role);
    }

    function appendBrandAvatar(root) {
      root.classList.add("brandAvatar");
      root.setAttribute("aria-hidden", "true");
      if (BRAND_ICON_URI) {
        const img = document.createElement("img");
        img.className = "brandIconImage";
        img.src = BRAND_ICON_URI;
        img.alt = "";
        img.draggable = false;
        root.appendChild(img);
        return;
      }
      appendLiquidIcon(root, "chip");
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
