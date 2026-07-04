import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { liquidIcon, type LiquidIconName } from "./webview/liquid-icons"

const liquidIconNames: LiquidIconName[] = [
  "chip",
  "chat",
  "sparkle",
  "add",
  "compose",
  "history",
  "sync",
  "settings",
  "terminal",
  "server",
  "agent",
  "send",
  "stop",
  "pause",
  "play",
  "attach",
  "file",
  "selection",
  "checkbox",
  "checkboxChecked",
  "selectMany",
  "selectAll",
  "deselectAll",
  "diagnostics",
  "diff",
  "references",
  "refresh",
  "copy",
  "retry",
  "edit",
  "apply",
  "pin",
  "completion",
  "database",
  "searchIndex",
  "documentIndex",
  "beaker",
  "key",
  "tool",
  "toolDisabled",
  "shield",
  "save",
  "discard",
  "trash",
  "historyRefresh",
  "closePanel",
  "zoomIn",
  "zoomOut",
  "expand",
  "close",
  "panelBottomCollapseSimple",
  "panelBottomExpandSimple",
  "contextLens",
  "goalTarget",
  "skillBlocks",
  "panelBottomClose",
  "panelBottomOpen",
  "more",
]

const liquidIcons = Object.fromEntries(liquidIconNames.map((name) => [name, liquidIcon(name)])) as Record<LiquidIconName, string>
const liquidIconForScript = JSON.stringify(liquidIcons)
const autocompleteStatusIcons = {
  enabled: autocompleteStatusIcon("enabled"),
  disabled: autocompleteStatusIcon("disabled"),
}
const autocompleteStatusIconsForScript = JSON.stringify(autocompleteStatusIcons)
const codeGraphStatusGlyph = [
  '<svg class="codegraph-status-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">',
  '<path d="M5.2 4.2L10.8 8L5.2 11.8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />',
  '<rect x="1.8" y="2.4" width="4.6" height="3.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.25" />',
  '<rect x="9.6" y="6.2" width="4.6" height="3.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.25" />',
  '<rect x="1.8" y="10" width="4.6" height="3.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.25" />',
  "</svg>",
].join("")
const codeGraphStatusGlyphForScript = JSON.stringify(codeGraphStatusGlyph)
const documentRagStatusCodicon = "file-text"
export const historyToolbarIconNames = [
  "enterSelection",
  "selectAll",
  "deselectAll",
  "delete",
  "refresh",
  "close",
] as const
export type HistoryToolbarIconName = (typeof historyToolbarIconNames)[number]
export type HistoryToolbarIconUris = Partial<Record<HistoryToolbarIconName, string>>

function autocompleteStatusIcon(state: "enabled" | "disabled") {
  const disabled = state === "disabled"
  const badgeClass = disabled ? "autocompleteStatusIconBadge-disabled" : "autocompleteStatusIconBadge-enabled"
  const mark = disabled
    ? '<path class="autocompleteStatusIconBadgeMark" d="M15.55 15.45 L17.25 17.15"></path><path class="autocompleteStatusIconBadgeMark" d="M17.25 15.45 L15.55 17.15"></path>'
    : '<path class="autocompleteStatusIconBadgeMark" d="M15.4 16.15 L16.1 16.85 L17.45 15.35"></path>'
  const slash = disabled ? '<path class="autocompleteStatusIconSlash" d="M4.45 15.75 L15.55 4.65"></path>' : ""
  return [
    `<svg class="autocompleteStatusIcon autocompleteStatusIcon-${state}" viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none">`,
    slash,
    '<g class="autocompleteStatusIconBraces">',
    '<path class="autocompleteStatusIconBrace" d="M2.5 2.9 C5.2 2.9 6.4 4.2 6.4 6.6 V8.4 C6.4 9.4 7.1 10 8.5 10 C7.1 10 6.4 10.6 6.4 11.6 V13.4 C6.4 15.8 5.2 17.1 2.5 17.1"></path>',
    '<path class="autocompleteStatusIconBrace" d="M7.2 2.9 C9.9 2.9 11.1 4.2 11.1 6.6 V8.4 C11.1 9.4 11.8 10 13.2 10 C11.8 10 11.1 10.6 11.1 11.6 V13.4 C11.1 15.8 9.9 17.1 7.2 17.1"></path>',
    "</g>",
    `<circle class="autocompleteStatusIconBadge ${badgeClass}" cx="16.55" cy="16.45" r="2.05"></circle>`,
    mark,
    "</svg>",
  ].join("")
}

function toolbarIconSlotHtml(markup: string, extraClass = "") {
  const className = ["chat-toolbar-icon-slot", extraClass].filter(Boolean).join(" ")
  return `<span class="${className}" aria-hidden="true">${markup}</span>`
}

function indexStatusWarningBadgeMarkup() {
  return '<span class="index-status-warning-badge" aria-hidden="true"><span class="index-status-warning-mark">!</span></span>'
}

function indexStatusIconMarkup(status: string, codiconName: string, badgeKind = "") {
  const badgeMarkup = badgeKind === "warning" ? indexStatusWarningBadgeMarkup() : ""
  const stackClass = ["index-status-icon-stack", badgeKind === "warning" ? "index-status-icon-stack--warning" : ""].filter(Boolean).join(" ")
  return toolbarIconSlotHtml(
    `<span class="${stackClass}" aria-hidden="true"><span class="index-status-icon index-status-icon--${status}"><span class="codicon codicon-${codiconName}"></span></span>${badgeMarkup}</span>`,
    "chat-toolbar-icon-slot--status",
  )
}

function codeGraphStatusIconMarkup(status: string) {
  return toolbarIconSlotHtml(
    `<span class="index-status-icon index-status-icon--${status}" aria-hidden="true">${codeGraphStatusGlyph}</span>`,
    "chat-toolbar-icon-slot--status",
  )
}

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

function historyToolbarIconGlyph(iconName: HistoryToolbarIconName, icons: HistoryToolbarIconUris) {
  const iconUri = icons[iconName] || ""
  const style = iconUri ? ` style="${escapeHtmlAttribute(`--history-toolbar-icon: url(\"${iconUri}\");`)}"` : ""
  return `<span class="historyToolbarGlyph" data-history-icon="${iconName}" aria-hidden="true"${style}></span>`
}

export function createChatViewHtml(
  cspSource: string,
  nonce = createNonce(),
  brandIconUri = "",
  mermaidScriptUri = "",
  codiconFontUri = "",
  drawioRuntimeUri = "",
  drawioRuntimeHtml = "",
  historyToolbarIconUris: HistoryToolbarIconUris = {},
) {
  const escapedBrandIconUri = escapeHtmlAttribute(brandIconUri)
  const escapedMermaidScriptUri = escapeHtmlAttribute(mermaidScriptUri)
  const escapedCodiconFontUri = escapeHtmlAttribute(codiconFontUri)
  const drawioRuntimeHtmlBase64 = drawioRuntimeHtml ? Buffer.from(drawioRuntimeHtml, "utf8").toString("base64") : ""
  const historyToolbarIconsForScript = JSON.stringify(historyToolbarIconUris)
  const mermaidScriptTag = escapedMermaidScriptUri
    ? `<script nonce="${nonce}" src="${escapedMermaidScriptUri}"></script>`
    : ""
  const codiconFontFace = escapedCodiconFontUri
    ? `    @font-face {
      font-family: "codicon";
      src: url("${escapedCodiconFontUri}") format("truetype");
      font-display: block;
    }
`
    : ""
  const brandIconMarkup = escapedBrandIconUri
    ? `<img class="brandIconImage" src="${escapedBrandIconUri}" alt="" aria-hidden="true">`
    : liquidIcons.chip
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; script-src 'nonce-${nonce}' ${cspSource}; frame-src ${cspSource} blob: data:; connect-src 'none';">
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
${codiconFontFace}    .codicon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: inherit;
      font: normal normal normal 1em/1 codicon;
      text-decoration: none;
      text-transform: none;
      letter-spacing: 0;
      white-space: nowrap;
      direction: ltr;
      speak: none;
      text-rendering: auto;
      user-select: none;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .codicon::before {
      display: block;
    }
    .codicon-database::before { content: "\\eace"; }
    .codicon-file-text::before { content: "\\ec5e"; }
    .codicon-file::before { content: "\\ea7b"; }
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
    .skillImportDropZone {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      min-width: 0;
      min-height: 58px;
      padding: 10px;
      border: 1px dashed color-mix(in srgb, var(--vscode-focusBorder) 48%, var(--oc-border));
      border-radius: var(--oc-radius-lg);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent), transparent 62%),
        color-mix(in srgb, var(--oc-soft-bg) 84%, transparent);
      color: var(--vscode-descriptionForeground);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
      transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
    }
    .skillImportDropZone.is-drop-target {
      border-color: var(--vscode-focusBorder);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), transparent 68%),
        color-mix(in srgb, var(--vscode-focusBorder) 10%, var(--oc-soft-bg));
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 18%, transparent), 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 24%, transparent);
    }
    .skillImportIcon {
      display: inline-flex;
      width: 24px;
      height: 24px;
      align-items: center;
      justify-content: center;
    }
    .skillImportCopy { min-width: 0; display: grid; gap: 2px; }
    .skillImportTitle {
      min-width: 0;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .skillImportHint {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .skillItem {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      background: var(--oc-soft-bg);
    }
    .skillItem.is-expanded {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 34%, var(--oc-border));
      background:
        linear-gradient(180deg, color-mix(in srgb, white 6%, transparent), transparent 56%),
        color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--oc-soft-bg));
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 16%, transparent);
    }
    .skillSummaryRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      min-width: 0;
    }
    .skillToggle {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      min-width: 0;
    }
    .skillToggle input { margin-top: 2px; }
    .skillMain { min-width: 0; display: grid; gap: 3px; }
    .skillName { min-width: 0; font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skillDetailToggle {
      align-self: start;
      min-width: 56px;
      min-height: 28px;
      padding: 0 10px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .skillDetailPanel {
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--oc-border) 86%, transparent);
      border-radius: calc(var(--oc-radius-lg) - 2px);
      background:
        linear-gradient(180deg, color-mix(in srgb, white 5%, transparent), transparent 58%),
        color-mix(in srgb, var(--oc-muted-bg) 72%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
    }
    .skillDetailPanel[hidden] { display: none; }
    .skillDescription,
    .skillMeta,
    .comingSoonText {
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .skillMetaError { color: var(--vscode-errorForeground, #f48771); }
    .skillMetaWarning { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
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
      flex-wrap: wrap;
      padding: 7px 0 0;
      background: var(--vscode-sideBar-background);
      z-index: 2;
    }
    .ragRebuildButton {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      padding: 0 10px;
      line-height: 1.15;
      white-space: normal;
      text-align: left;
    }
    .ragRebuildButton .oc-liquid-icon {
      flex: 0 0 15px;
      width: 15px;
      height: 15px;
    }
    .ragRebuildButtonLabel {
      min-width: 0;
      overflow-wrap: anywhere;
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
    .historyActions {
      flex: 0 0 auto;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .historyToolbarButton {
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      flex: 0 0 28px;
      border-radius: 7px;
      color: var(--history-toolbar-icon-default, var(--vscode-icon-foreground, #b8c7d6));
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease, transform 120ms ease;
    }
    .historyToolbarButton .historyToolbarGlyph {
      width: var(--header-toolbar-glyph-size);
      height: var(--header-toolbar-glyph-size);
      flex: 0 0 var(--header-toolbar-glyph-size);
      display: inline-block;
      background: currentColor;
      -webkit-mask: var(--history-toolbar-icon) center / contain no-repeat;
      mask: var(--history-toolbar-icon) center / contain no-repeat;
      filter: drop-shadow(0 0 2px rgba(150, 210, 255, 0.16));
    }
    body.vscode-dark .historyToolbarButton,
    .vscode-dark .historyToolbarButton {
      --history-toolbar-icon-default: #b8c7d6;
    }
    .historyToolbarButton:hover,
    .historyToolbarButton:focus-visible {
      color: var(--vscode-foreground, #eaf6ff);
      background:
        linear-gradient(rgba(160, 210, 255, 0.10), rgba(160, 210, 255, 0.10)),
        var(--vscode-toolbar-hoverBackground, transparent);
      border-color: rgba(210, 235, 255, 0.28);
      box-shadow: 0 0 10px rgba(150, 210, 255, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.vscode-dark .historyToolbarButton:hover,
    body.vscode-dark .historyToolbarButton:focus-visible,
    .vscode-dark .historyToolbarButton:hover,
    .vscode-dark .historyToolbarButton:focus-visible {
      color: #eaf6ff;
    }
    .historyToolbarButton:active,
    .historyToolbarButton.is-active,
    .historyToolbarButton[aria-pressed="true"] {
      color: #eaf6ff;
      background:
        linear-gradient(rgba(160, 210, 255, 0.14), rgba(160, 210, 255, 0.14)),
        var(--vscode-toolbar-hoverBackground, transparent);
      border-color: rgba(210, 235, 255, 0.36);
      box-shadow: 0 0 8px rgba(150, 210, 255, 0.18), inset 0 1px 2px rgba(255, 255, 255, 0.12);
      transform: translateY(1px);
    }
    .historyToolbarButton.danger:hover,
    .historyToolbarButton.danger:focus-visible {
      color: #ff8a8a;
      border-color: rgba(255, 138, 138, 0.34);
      box-shadow: 0 0 10px rgba(255, 138, 138, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .historyToolbarButton[disabled],
    .historyToolbarButton[disabled]:hover {
      opacity: 0.45;
      color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      transform: none;
    }
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
    .sessionRow.selecting {
      grid-template-columns: 26px minmax(0, 1fr);
    }
    .sessionRow.selected:not(.active) {
      background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
    }
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
    .sessionCheck,
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
    .sessionCheck {
      opacity: 0.8;
      color: var(--vscode-descriptionForeground);
    }
    .sessionCheck[aria-pressed="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      opacity: 1;
    }
    .sessionCheck .oc-liquid-icon,
    .sessionDelete .oc-liquid-icon { width: 14px; height: 14px; }
    .sessionCheck:hover,
    .sessionCheck:focus-visible {
      opacity: 1;
    }
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
    [hidden] {
      display: none !important;
    }
    .chatMain.view-usage .messages,
    .chatMain.view-usage .jumpLatest,
    .chatMain.view-usage .composerWrap {
      display: none !important;
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
    .usagePage {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      display: grid;
      align-content: flex-start;
      gap: 12px;
      padding: 12px 10px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .usagePage[hidden] { display: none; }
    .usageHeader {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .usageTitleBlock {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .usageTitle {
      color: var(--vscode-foreground);
      font-size: 15px;
      font-weight: 700;
      line-height: 1.15;
    }
    .usageSubtitle {
      min-width: 0;
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.35;
    }
    .usageHeaderActions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex: 0 0 auto;
      min-width: 0;
    }
    .usageBackToChat,
    .usageRefresh {
      flex: 0 0 auto;
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      padding: 0;
    }
    .usageMetricStrip {
      display: grid;
      grid-template-columns: repeat(5, minmax(74px, 1fr));
      gap: 0;
      min-width: 0;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      overflow: hidden;
      background:
        linear-gradient(135deg, color-mix(in srgb, white 10%, transparent), transparent 62%),
        color-mix(in srgb, var(--vscode-sideBar-background) 82%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent), 0 10px 26px color-mix(in srgb, black 12%, transparent);
    }
    .usageMetric {
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 3px;
      min-width: 0;
      min-height: 68px;
      padding: 9px 8px;
      text-align: center;
      border-inline-start: 1px solid var(--oc-border);
    }
    .usageMetric:first-child { border-inline-start: 0; }
    .usageMetricValue {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 18px;
      font-weight: 750;
      line-height: 1.1;
    }
    .usageMetricLabel {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--oc-muted);
      font-size: 11px;
      line-height: 1.2;
    }
    .usageMetricDetail {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: color-mix(in srgb, var(--oc-muted) 76%, transparent);
      font-size: 9px;
      line-height: 1.1;
    }
    .usageActivityPanel {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .usageActivityHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .usageModeTabs {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      padding: 2px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: transparent;
    }
    .usageModeTab {
      min-width: 42px;
      min-height: 24px;
      padding: 0 8px;
      border-color: transparent;
      color: var(--oc-muted);
      background: transparent;
      font-size: 11px;
    }
    .usageModeTab.is-active {
      color: var(--vscode-foreground);
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent);
      background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
    }
    .usageHeatmapWrap {
      --usage-cell-size: clamp(9px, 2.2vw, 15px);
      --usage-cell-gap: 4px;
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .usageHeatmapGrid {
      display: grid;
      grid-auto-flow: column;
      grid-template-rows: repeat(7, var(--usage-cell-size));
      grid-auto-columns: var(--usage-cell-size);
      gap: var(--usage-cell-gap);
      min-width: 0;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 1px 1px 3px;
      scrollbar-gutter: stable;
    }
    .usageCalendarScroller {
      overflow-x: auto;
      overflow-y: hidden;
      padding: 1px 1px 3px;
      scrollbar-gutter: stable;
      min-width: 0;
      max-width: 100%;
    }
    .usageCalendarInner {
      display: grid;
      gap: 8px;
      width: max-content;
      min-width: 100%;
    }
    .usageMonthTrack {
      display: grid;
      align-items: center;
      gap: var(--usage-cell-gap, 4px);
      grid-auto-columns: var(--usage-cell-size);
      width: max-content;
      min-height: 14px;
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.2;
    }
    .usageMonthLabel {
      justify-self: start;
      white-space: nowrap;
    }
    .usageCalendarScroller .usageHeatmapGrid.daily {
      overflow: visible;
      padding: 0;
      max-width: none;
      scrollbar-gutter: auto;
    }
    .usageHeatmapGrid.weekly,
    .usageHeatmapGrid.cumulative {
      grid-auto-flow: row;
      grid-template-rows: none;
      grid-template-columns: repeat(auto-fit, minmax(var(--usage-cell-size), 1fr));
    }
    .usageHeatCell {
      width: var(--usage-cell-size);
      min-width: var(--usage-cell-size);
      height: var(--usage-cell-size);
      min-height: var(--usage-cell-size);
      border: 1px solid color-mix(in srgb, var(--oc-border) 72%, transparent);
      border-radius: 4px;
      padding: 0;
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 9%, transparent);
    }
    .usageHeatCell.level-1 { background: color-mix(in srgb, #86c5ff 24%, transparent); border-color: color-mix(in srgb, #86c5ff 32%, var(--oc-border)); }
    .usageHeatCell.level-2 { background: color-mix(in srgb, #74b7ff 42%, transparent); border-color: color-mix(in srgb, #74b7ff 46%, var(--oc-border)); }
    .usageHeatCell.level-3 { background: color-mix(in srgb, #4aa3ff 62%, transparent); border-color: color-mix(in srgb, #4aa3ff 62%, var(--oc-border)); }
    .usageHeatCell.level-4 { background: color-mix(in srgb, #238cf0 78%, transparent); border-color: color-mix(in srgb, #238cf0 76%, var(--oc-border)); }
    .usageHeatCell.level-5 { background: color-mix(in srgb, #0b7ee6 92%, transparent); border-color: color-mix(in srgb, #0b7ee6 86%, var(--oc-border)); }
    .usageHeatCell.estimated {
      border-style: dashed;
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent), 0 0 0 1px color-mix(in srgb, var(--vscode-editorWarning-foreground) 18%, transparent);
    }
    .usageHeatCell.is-active {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent), 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 42%, transparent);
    }
    .usageHeatCell.is-preview:not(.is-active) {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 48%, var(--oc-border));
    }
    .usageHeatCell:hover,
    .usageHeatCell:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .usageHeatLegend {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 5px;
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.2;
    }
    .usageLegendSwatches {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      min-width: 0;
    }
    .usageLegendSwatch {
      width: 11px;
      height: 11px;
      border: 1px solid var(--oc-border);
      border-radius: 3px;
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    }
    .usageLegendSwatch.level-1 { background: color-mix(in srgb, #86c5ff 24%, transparent); }
    .usageLegendSwatch.level-2 { background: color-mix(in srgb, #74b7ff 42%, transparent); }
    .usageLegendSwatch.level-3 { background: color-mix(in srgb, #4aa3ff 62%, transparent); }
    .usageLegendSwatch.level-4 { background: color-mix(in srgb, #238cf0 78%, transparent); }
    .usageLegendSwatch.level-5 { background: color-mix(in srgb, #0b7ee6 92%, transparent); }
    .usageBreakdown {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex-wrap: wrap;
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.3;
    }
    .usageBreakdownItem {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .usageDetailCard {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--oc-border) 78%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 9%, transparent);
    }
    .usageDetailCard.is-empty {
      color: var(--oc-muted);
    }
    .usageDetailHeader {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .usageDetailTitle {
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 650;
    }
    .usageDetailMeta {
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.2;
    }
    .usageDetailHint {
      color: var(--oc-muted);
      font-size: 11px;
      line-height: 1.4;
    }
    .usageDetailGrid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      min-width: 0;
    }
    .usageDetailMetric {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .usageDetailMetricLabel {
      color: var(--oc-muted);
      font-size: 10px;
      line-height: 1.2;
    }
    .usageDetailMetricValue {
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
      min-width: 0;
      word-break: break-word;
    }
    @media (max-width: 360px) {
      .usageDetailGrid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .usageDot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-focusBorder);
      flex: 0 0 auto;
    }
    .usageDot.estimated { background: var(--vscode-editorWarning-foreground); }
    .usageState {
      display: grid;
      place-items: center;
      min-height: 220px;
      padding: 18px 12px;
      color: var(--oc-muted);
      text-align: center;
    }
    .usageStateInner {
      display: grid;
      justify-items: center;
      gap: 8px;
      max-width: 300px;
      min-width: 0;
    }
    .usageStateIcon {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      color: var(--oc-muted);
    }
    .usageStateIcon .oc-liquid-icon {
      width: 30px;
      height: 30px;
    }
    .usageStateTitle {
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 650;
    }
    .usageStateCopy {
      font-size: 11px;
      line-height: 1.4;
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
    .diagramZoom,
    .openDiagramViewer,
    .exportMermaidImage,
    .exportDrawioImage,
    .toggleDiagramSource {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.58;
    }
    .diagramZoom {
      width: var(--diagram-zoom-button-size, 30px);
      min-width: var(--diagram-zoom-button-size, 30px);
      height: var(--diagram-zoom-button-size, 30px);
      min-height: var(--diagram-zoom-button-size, 30px);
      flex: 0 0 var(--diagram-zoom-button-size, 30px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .copyCode .oc-liquid-icon,
    .diagramZoom .oc-liquid-icon,
    .openDiagramViewer .oc-liquid-icon,
    .exportMermaidImage .oc-liquid-icon,
    .exportDrawioImage .oc-liquid-icon,
    .toggleDiagramSource .oc-liquid-icon { width: 14px; height: 14px; }
    .diagramZoom .oc-liquid-icon {
      width: var(--diagram-zoom-glyph-size, 20px);
      height: var(--diagram-zoom-glyph-size, 20px);
      stroke-width: 2.15;
    }
    .codeBlock:hover .copyCode,
    .diagramBlock:hover .copyCode,
    .diagramBlock:hover .diagramZoom,
    .diagramBlock:hover .openDiagramViewer,
    .diagramBlock:hover .exportMermaidImage,
    .diagramBlock:hover .exportDrawioImage,
    .diagramBlock:hover .toggleDiagramSource,
    .copyCode:focus-visible,
    .copyCode:hover,
    .diagramZoom:focus-visible,
    .diagramZoom:hover,
    .openDiagramViewer:focus-visible,
    .openDiagramViewer:hover,
    .exportMermaidImage:focus-visible,
    .exportMermaidImage:hover,
    .exportDrawioImage:focus-visible,
    .exportDrawioImage:hover,
    .toggleDiagramSource:focus-visible,
    .toggleDiagramSource:hover {
      opacity: 1;
    }
    .diagramZoom[disabled],
    .diagramZoom[disabled]:hover,
    .openDiagramViewer[disabled],
    .openDiagramViewer[disabled]:hover,
    .exportMermaidImage[disabled],
    .exportMermaidImage[disabled]:hover,
    .exportDrawioImage[disabled],
    .exportDrawioImage[disabled]:hover {
      opacity: 0.28;
      cursor: default;
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
      --diagram-zoom: 1;
      --diagram-zoom-width: 100%;
      min-height: 120px;
      display: grid;
      align-items: center;
      justify-items: center;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .diagramZoomSurface {
      display: grid;
      align-items: center;
      justify-items: center;
      justify-self: center;
      align-self: center;
      width: 100%;
      min-width: 0;
    }
    .diagramBlock[data-diagram-kind="mermaid"] .diagramCanvas {
      color: #111827;
      background: #ffffff;
    }
    .diagramCanvas.zoomed-in {
      align-items: start;
      justify-items: start;
      overflow-x: auto;
      overflow-y: auto;
      max-height: var(--diagram-canvas-max-height, min(72vh, 900px));
      overscroll-behavior: contain;
      cursor: grab;
      touch-action: none;
    }
    .diagramCanvas.zoomed-in.diagramDragging {
      cursor: grabbing;
      user-select: none;
    }
    .diagramCanvas.zoomed-in .diagramZoomSurface {
      align-items: start;
      justify-items: start;
      justify-self: start;
      align-self: start;
      width: var(--diagram-zoom-content-width, var(--diagram-zoom-width, 100%));
      min-width: var(--diagram-zoom-content-width, var(--diagram-zoom-width, 100%));
      height: var(--diagram-zoom-content-height, auto);
      min-height: var(--diagram-zoom-content-height, 0);
    }
    .diagramCanvas svg {
      width: var(--diagram-zoom-width, 100%);
      max-width: none;
      height: auto;
      justify-self: center;
    }
    .diagramBlock[data-diagram-kind="mermaid"] .diagramCanvas svg {
      color: #111827;
    }
    .diagramCanvas img.drawioImage {
      display: block;
      width: var(--diagram-zoom-width, 100%);
      max-width: none;
      height: auto;
      justify-self: center;
    }
    .diagramCanvas.zoomed-in svg,
    .diagramCanvas.zoomed-in img.drawioImage {
      width: 100% !important;
      max-width: none !important;
      max-height: none !important;
      height: 100% !important;
      justify-self: start;
      align-self: start;
    }
    .drawioDiagramBlock .diagramCanvas {
      color: #111827;
      background: #ffffff;
    }
    .drawioRuntimeFrame {
      position: fixed;
      left: -10000px;
      top: -10000px;
      width: 1px;
      height: 1px;
      border: 0;
      opacity: 0;
      pointer-events: none;
    }
    .diagramViewer {
      position: fixed;
      inset: 0;
      z-index: 12000;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
      padding: 10px;
      background:
        linear-gradient(135deg, color-mix(in srgb, white 10%, transparent), transparent 54%),
        color-mix(in srgb, var(--vscode-sideBar-background) 82%, black 18%);
      backdrop-filter: blur(18px) saturate(1.24);
      -webkit-backdrop-filter: blur(18px) saturate(1.24);
    }
    .diagramViewer[hidden] {
      display: none !important;
    }
    .diagramViewerToolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
      padding: 6px 8px;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      background:
        linear-gradient(135deg, color-mix(in srgb, white 12%, transparent), transparent 62%),
        color-mix(in srgb, var(--vscode-editorWidget-background) 76%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent), 0 14px 34px color-mix(in srgb, black 18%, transparent);
    }
    .diagramViewerTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 650;
    }
    .diagramViewerActions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex: 0 0 auto;
      min-width: 0;
    }
    .diagramViewerButton {
      width: 30px;
      min-width: 30px;
      height: 30px;
      min-height: 30px;
      padding: 0;
      border-radius: 9px;
    }
    .diagramViewerButton .oc-liquid-icon {
      width: 17px;
      height: 17px;
    }
    .diagramViewerCanvas {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      cursor: grab;
      border: 1px solid var(--oc-border);
      border-radius: var(--oc-radius-lg);
      background: #ffffff;
      color: #111827;
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 22%, transparent), 0 16px 42px color-mix(in srgb, black 20%, transparent);
    }
    .diagramViewerCanvas.diagramDragging {
      cursor: grabbing;
      user-select: none;
    }
    .diagramViewerSurface {
      display: grid;
      align-items: start;
      justify-items: start;
      width: var(--diagram-viewer-content-width, 100%);
      min-width: var(--diagram-viewer-content-width, 100%);
      height: var(--diagram-viewer-content-height, auto);
      min-height: var(--diagram-viewer-content-height, 0);
      background: #ffffff;
      color: #111827;
    }
    .diagramViewerSurface svg,
    .diagramViewerSurface img.drawioImage {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      justify-self: start;
      align-self: start;
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
    .diagramStatus details {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .diagramStatus summary {
      width: max-content;
      max-width: 100%;
      margin: 0 auto;
      cursor: pointer;
    }
    .diagramStatus code {
      display: block;
      margin-top: 6px;
      padding: 6px;
      overflow-x: auto;
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      text-align: left;
      white-space: pre-wrap;
      word-break: break-word;
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
    .toolGroupBody {
      display: grid;
      gap: 0;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .toolGroupBody > pre {
      border-top: 0;
    }
    .toolApprovalBanner {
      display: none;
      flex: 0 0 auto;
      margin: 0 10px 8px;
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 50%, var(--vscode-panel-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-button-background) 14%, var(--vscode-sideBar-background) 86%);
      box-shadow: 0 10px 26px color-mix(in srgb, black 16%, transparent), inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
    }
    .toolApprovalBanner.is-visible {
      display: grid;
      gap: 9px;
    }
    .toolApprovalBannerHead,
    .toolApprovalBannerMain {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .toolApprovalBannerHead {
      justify-content: space-between;
    }
    .toolApprovalBannerMain {
      flex: 1 1 auto;
    }
    .toolApprovalBannerIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 30px;
      width: 30px;
      height: 30px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 42%, var(--vscode-panel-border));
      border-radius: 8px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 14%, transparent);
    }
    .toolApprovalBannerIcon .oc-liquid-icon {
      width: 18px;
      height: 18px;
    }
    .toolApprovalBannerCopy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .toolApprovalBannerTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 750;
      line-height: 1.2;
    }
    .toolApprovalBannerSummary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
    }
    .toolApprovalBannerCount {
      flex: 0 0 auto;
      padding: 3px 7px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 34%, var(--vscode-panel-border));
      border-radius: 999px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
      font-size: 10px;
      font-weight: 650;
      line-height: 1.2;
    }
    .toolApprovalBannerActions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;
      min-width: 0;
    }
    .toolApprovalBannerActions .statusActionButton,
    .toolApprovalActions .statusActionButton {
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 650;
      line-height: 1.2;
      background: color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
    }
    .toolApprovalBannerActions .statusActionButton.primary,
    .toolApprovalActions .statusActionButton.primary {
      color: var(--vscode-button-foreground);
      border-color: color-mix(in srgb, var(--vscode-button-background) 70%, var(--vscode-focusBorder));
      background: var(--vscode-button-background);
    }
    .toolApprovalBannerActions .statusActionButton.primary:hover,
    .toolApprovalActions .statusActionButton.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .toolApprovalPane {
      display: grid;
      gap: 9px;
      padding: 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 32%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
    }
    .toolApprovalPane.is-focused {
      outline: 2px solid color-mix(in srgb, var(--vscode-focusBorder) 72%, transparent);
      outline-offset: -3px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-sideBar-background));
    }
    .toolApprovalHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .toolApprovalTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 750;
    }
    .toolApprovalRisk,
    .toolApprovalStat {
      flex: 0 0 auto;
      padding: 2px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, transparent);
    }
    .toolApprovalSummary,
    .toolApprovalReason {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .toolApprovalMeta,
    .toolApprovalActions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .clarificationCard {
      display: grid;
      gap: 12px;
      margin: 10px 0;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 38%, var(--vscode-panel-border));
      border-left: 4px solid var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-button-background) 14%, var(--vscode-editor-background) 86%);
      box-shadow: 0 14px 30px color-mix(in srgb, black 14%, transparent), inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
    }
    .clarificationHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .clarificationTitle {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.3;
    }
    .clarificationStatus {
      flex: 0 0 auto;
      color: var(--vscode-button-foreground);
      font-size: 12px;
      font-weight: 650;
      line-height: 1;
      padding: 5px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-button-background) 78%, transparent);
    }
    .clarificationReason,
    .clarificationAnswerSummary {
      color: var(--vscode-descriptionForeground);
      font-size: 12.5px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .clarificationQuestion {
      display: grid;
      gap: 6px;
    }
    .clarificationQuestionText {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.45;
    }
    .clarificationChoices,
    .clarificationActions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .clarificationChoice {
      padding: 6px 10px;
      border: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground, var(--vscode-button-background)) 16%, transparent);
      color: var(--vscode-foreground);
      font-size: 13px;
      line-height: 1.25;
    }
    .clarificationChoice.is-selected {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-button-background) 42%, transparent);
    }
    .clarificationFreeText {
      width: 100%;
      min-width: 0;
      min-height: 64px;
      resize: vertical;
      border-radius: 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 8px 10px;
      font-size: 13px;
      line-height: 1.4;
    }
    .clarificationActions .statusActionButton.primary {
      padding: 7px 12px;
      font-size: 13px;
      font-weight: 650;
    }
    .toolCard.reasoning pre { color: var(--vscode-descriptionForeground); }
    .turnProcessStrip {
      margin: 8px 0;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 28%, var(--vscode-panel-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-focusBorder) 7%);
      box-shadow: 0 10px 24px color-mix(in srgb, black 10%, transparent), inset 0 1px 0 color-mix(in srgb, white 10%, transparent);
      overflow: hidden;
    }
    .turnProcessStrip.has-warning {
      border-color: color-mix(in srgb, var(--vscode-inputValidation-warningBorder, #d7ba7d) 60%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, transparent) 28%, var(--vscode-sideBar-background));
    }
    .turnProcessStrip.has-error {
      border-color: color-mix(in srgb, var(--vscode-inputValidation-errorBorder, #f14c4c) 68%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, transparent) 24%, var(--vscode-sideBar-background));
    }
    .turnProcessSummary {
      min-height: 34px;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) minmax(0, auto) auto;
      grid-template-areas:
        "marker label meta actions"
        ". path path actions";
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px 8px;
      cursor: pointer;
      list-style: none;
    }
    .turnProcessSummary::-webkit-details-marker {
      display: none;
    }
    .turnProcessMarker {
      grid-area: marker;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 20px;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 36%, var(--vscode-panel-border));
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
      font-size: 11px;
      line-height: 1;
    }
    .turnProcessStrip.is-running .turnProcessMarker {
      animation: chipmatePulse 1.25s ease-in-out infinite;
    }
    @keyframes chipmatePulse {
      0%, 100% { opacity: .58; transform: scale(.96); }
      50% { opacity: 1; transform: scale(1); }
    }
    .turnProcessLabel {
      grid-area: label;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    .turnProcessPath {
      grid-area: path;
      min-width: 0;
      max-width: 100%;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .turnProcessMeta,
    .turnProcessActions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
      max-width: 100%;
    }
    .turnProcessMeta {
      grid-area: meta;
      justify-content: flex-end;
    }
    .turnProcessActions {
      grid-area: actions;
      justify-content: flex-end;
    }
    .turnProcessMetaItem,
    .turnProcessDetailHint {
      flex: 0 0 auto;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 6px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 84%, transparent);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      font-size: 10px;
      line-height: 1.25;
    }
    .turnProcessDetailHint {
      color: var(--vscode-foreground);
    }
    .turnProcessAction {
      min-height: 24px;
      padding: 3px 8px;
      font-size: 11px;
      line-height: 1.2;
    }
    @media (max-width: 560px) {
      .turnProcessSummary {
        grid-template-columns: 20px minmax(0, 1fr);
        grid-template-areas:
          "marker label"
          "path path"
          "meta meta"
          "actions actions";
        align-items: start;
        gap: 6px 8px;
      }
      .turnProcessMeta,
      .turnProcessActions {
        justify-content: flex-start;
      }
      .turnProcessAction {
        min-height: 22px;
        padding: 2px 7px;
      }
    }
    .turnProcessBody {
      display: grid;
      gap: 8px;
      padding: 8px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
    }
    .turnProcessSection {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .turnProcessSectionTitle {
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 750;
      line-height: 1.3;
    }
    .turnProcessSteps,
    .turnProcessArtifacts,
    .turnProcessWarnings,
    .turnProcessText {
      margin: 0;
      padding: 7px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
      border-radius: 7px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-input-background) 68%, transparent);
      font-size: 10px;
      line-height: 1.35;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .turnProcessWarnings {
      border-color: color-mix(in srgb, var(--vscode-inputValidation-warningBorder, #d7ba7d) 64%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, transparent) 42%, transparent);
    }
    .turnProcessDetailCards {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .docAgentTimelineCard,
    .runProgressCard,
    .mermaidArtifactCard,
    .docAgentConflictCard {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 30%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-focusBorder) 7%);
    }
    .docAgentTimelineBody,
    .runProgressBody,
    .mermaidArtifactBody,
    .docAgentConflictBody {
      display: grid;
      gap: 8px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .docAgentStats,
    .runProgressStats,
    .mermaidArtifactMeta,
    .mermaidArtifactActions,
    .docAgentBulkActions,
    .docAgentChoiceRow {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .docAgentStat,
    .runProgressStat,
    .runProgressItemStatus,
    .mermaidArtifactStat,
    .docAgentEventStatus,
    .docAgentChoiceState {
      padding: 2px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-input-background) 74%, transparent);
      font-size: 10px;
      line-height: 1.3;
    }
    .docAgentEventList,
    .runProgressList,
    .docAgentConflictList {
      display: grid;
      gap: 6px;
    }
    .docAgentEvent,
    .runProgressItem,
    .docAgentConflictItem {
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: color-mix(in srgb, var(--vscode-input-background) 65%, transparent);
    }
    .docAgentEventHead,
    .runProgressItemHead,
    .docAgentConflictHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 650;
      line-height: 1.35;
    }
    .docAgentEventDetail,
    .runProgressItemDetail,
    .mermaidArtifactPath,
    .docAgentConflictMeta {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .mermaidArtifactPreview {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .mermaidArtifactPreview .diagramBlock {
      margin: 0;
    }
    .docAgentChoiceButton.is-selected {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .docAgentConfirm[disabled] {
      opacity: .55;
      cursor: default;
    }
    .generatedDocumentCard {
      display: grid;
      gap: 8px;
      padding: 9px;
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 36%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-sideBar-background) 72%, var(--vscode-focusBorder) 9%);
    }
    .generatedDocumentTitle {
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    .generatedDocumentMeta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .generatedDocumentActions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .generatedDocumentWarnings {
      margin: 0;
      padding: 7px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, transparent) 55%, transparent);
      font-size: 10px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .wordRenderCard {
      display: grid;
      gap: 8px;
      padding: 9px;
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-focusBorder)) 28%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-sideBar-background) 74%, var(--vscode-testing-iconPassed, var(--vscode-focusBorder)) 8%);
    }
    .wordRenderTitle {
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    .wordRenderMeta,
    .wordRenderArtifacts,
    .wordRenderSummary {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .wordRenderPreviewStrip {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .wordRenderPreviewItem {
      display: grid;
      gap: 4px;
      min-width: 96px;
      max-width: min(180px, 100%);
      padding: 5px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
    }
    .wordRenderPreviewImage {
      width: 100%;
      max-height: 220px;
      object-fit: contain;
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    .wordRenderPreviewCaption {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .wordRenderWarnings {
      margin: 0;
      padding: 7px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, transparent) 55%, transparent);
      font-size: 10px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .wordRenderActions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .activityRow {
      min-height: 22px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
    }
    .activityLabel {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activityElapsed {
      flex: 0 0 auto;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, var(--vscode-focusBorder));
      font-variant-numeric: tabular-nums;
    }
    .activityElapsed.is-empty,
    .activitySeparator:empty {
      display: none;
    }
    .activitySeparator {
      flex: 0 0 auto;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 58%, transparent);
    }
    .toolLiveActivityRow {
      margin-top: 4px;
      padding: 2px 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, transparent);
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
      width: 28px;
      min-width: 28px;
      height: 28px;
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
      width: 28px;
      min-width: 28px;
      height: 28px;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
	    .statusBadge {
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
    .composerStatusPill.panel { color: var(--vscode-foreground); }
    .composerStatusPill.index.ready,
    .composerStatusPill.rag.ready,
    .composerStatusPill.documentRag.ready { color: var(--vscode-testing-iconPassed, #3fb950); }
    .composerStatusPill.index.indexing,
    .composerStatusPill.rag.indexing,
    .composerStatusPill.documentRag.indexing { color: var(--vscode-charts-blue, #3794ff); }
    .composerStatusPill.index.info,
    .composerStatusPill.index.warning,
    .composerStatusPill.rag.info,
    .composerStatusPill.rag.warning,
    .composerStatusPill.documentRag.info,
    .composerStatusPill.documentRag.warning { color: var(--vscode-disabledForeground); }
    .composerStatusPill.guard.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
    .composerStatusPill.usage.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
    .composerStatusPill.index.error,
    .composerStatusPill.rag.error { color: var(--vscode-testing-iconFailed, #f85149); }
    .composerStatusPill.documentRag.error { color: var(--vscode-testing-iconFailed, #f85149); }
    .composerStatusPill.usage.error { color: var(--vscode-errorForeground, #f48771); }
	    .composerStatusPill.queue.info { color: var(--vscode-descriptionForeground); }
	    .composerStatusPill.queue.active { color: var(--vscode-focusBorder); }
	    .composerStatusPill.queue.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
	    .composerStatusPill.goal.active { color: var(--vscode-focusBorder); }
	    .composerStatusPill.goal.paused,
	    .composerStatusPill.goal.usage-limited,
	    .composerStatusPill.goal.budget-limited { color: var(--vscode-editorWarning-foreground, #cca700); }
	    .composerStatusPill.goal.blocked { color: var(--vscode-errorForeground, #f48771); }
	    .composerStatusPill.goal.complete { color: var(--vscode-testing-iconPassed, #73c991); }
	    .composerStatusPill.completion.ready { color: var(--vscode-testing-iconPassed, #73c991); }
	    .composerStatusPill.completion.off { color: var(--vscode-descriptionForeground); }
	    .composerStatusPill.completion.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
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
	    .composerStatusPopover.goalPopover {
	      min-width: 0;
	      overflow-x: hidden;
	    }
	    .composerStatusPopover.goalPopover .statusPopoverHeader {
	      display: grid;
	      grid-template-columns: minmax(0, 1fr);
	      align-items: start;
	      justify-content: stretch;
	    }
	    .composerStatusPopover.goalPopover .statusPopoverHeader > *,
	    .composerStatusPopover.goalPopover .statusPopoverMeta {
	      min-width: 0;
	      white-space: normal;
	      overflow-wrap: anywhere;
	    }
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
		    .goalActions {
		      display: grid;
		      grid-template-columns: repeat(auto-fit, minmax(86px, 1fr));
		      align-items: stretch;
		      gap: 6px;
		      width: 100%;
		      min-width: 0;
		    }
		    .goalActionButton.oc-liquid-btn {
		      width: 100%;
		      min-width: 0;
		      max-width: 100%;
	      height: 28px;
	      min-height: 28px;
	      display: inline-flex;
	      align-items: center;
	      justify-content: center;
	      gap: 6px;
	      padding: 0 9px;
	      border-radius: 999px;
	      white-space: nowrap;
	    }
	    .goalActionButton.danger { color: var(--vscode-errorForeground, #f48771); }
	    .goalActionIcon {
	      display: inline-flex;
	      align-items: center;
	      justify-content: center;
	      flex: 0 0 auto;
	    }
		    .goalActionLabel {
		      min-width: 0;
		      overflow: hidden;
		      text-overflow: ellipsis;
		      white-space: nowrap;
		    }
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
    .contextChips {
      display: none;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-height: 64px;
      overflow: auto;
      padding: 6px 6px 0;
    }
    .contextChips.visible { display: flex; }
    .queuedSendList {
      display: none;
      gap: 5px;
      min-width: 0;
      max-height: 112px;
      overflow: auto;
      padding: 6px 6px 0;
    }
    .queuedSendList.visible {
      display: grid;
    }
    .queuedSendItem {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 32%, var(--vscode-panel-border));
      border-radius: 8px;
      padding: 5px 5px 5px 8px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 8%, var(--vscode-input-background));
      box-shadow: 0 1px 2px color-mix(in srgb, black 10%, transparent);
    }
    .queuedSendMain {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .queuedSendText {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      line-height: 1.25;
    }
    .queuedSendMeta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1.2;
    }
    .queuedSendActions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }
    .queuedSendAction.oc-icon-btn {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      padding: 0;
    }
    .queuedSendAction .oc-liquid-icon {
      width: 14px;
      height: 14px;
    }
    .contextChip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      max-width: min(100%, 280px);
      min-width: 0;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 34%, var(--vscode-panel-border));
      border-radius: 999px;
      padding: 2px 4px 2px 6px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 9%, var(--vscode-input-background));
      font-size: 10px;
      line-height: 1.2;
      box-shadow: 0 1px 2px color-mix(in srgb, black 10%, transparent);
    }
    .contextChip.mention {
      border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 34%, var(--vscode-panel-border));
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 7%, var(--vscode-input-background));
    }
    .contextChip.is-pinned {
      border-color: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 68%, var(--vscode-panel-border));
      background:
        linear-gradient(135deg, color-mix(in srgb, white 18%, transparent), transparent 42%),
        color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 18%, var(--vscode-input-background));
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, white 24%, transparent),
        0 2px 6px color-mix(in srgb, black 16%, transparent);
    }
    .contextChipMain,
    .contextChipPin,
    .contextChipRemove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      border: 0;
      background: transparent;
    }
    .contextChipMain {
      gap: 4px;
      padding: 0;
      border-radius: 999px;
      color: inherit;
      overflow: hidden;
    }
    .contextChipMain:hover,
    .contextChipMain:focus-visible,
    .contextChipPin:hover,
    .contextChipPin:focus-visible,
    .contextChipRemove:hover,
    .contextChipRemove:focus-visible {
      color: var(--vscode-foreground);
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    .contextChipIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
    }
    .contextChipIcon .oc-liquid-icon {
      width: 14px;
      height: 14px;
    }
    .contextChipLabel,
    .contextChipPreview {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .contextChipPreview {
      color: var(--vscode-descriptionForeground);
      max-width: 128px;
    }
    .contextChipRemove {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      padding: 0;
    }
    .contextChipPin {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, transparent);
      padding: 0;
    }
    .contextChipPin[aria-pressed="true"] {
      color: var(--vscode-focusBorder, #3794ff);
      background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 18%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 28%, transparent);
    }
    .contextChipPin .oc-liquid-icon {
      width: 12px;
      height: 12px;
    }
    .contextChipRemove .oc-liquid-icon {
      width: 12px;
      height: 12px;
    }
    .contextPreview {
      max-height: 148px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 6px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font: 10px/1.35 var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      white-space: pre-wrap;
    }
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
	      height: 28px;
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
    .composerPopupLayer {
      position: fixed;
      inset: 0;
      z-index: 10000;
      pointer-events: none;
      overflow: visible;
    }
    .modelMenu {
      display: none;
      position: fixed;
      left: 0;
      bottom: auto;
      z-index: 1000;
      pointer-events: auto;
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
    .suggestionIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      min-width: 18px;
      color: var(--vscode-descriptionForeground);
    }
    .suggestionIcon .oc-liquid-icon {
      width: 16px;
      height: 16px;
    }
    .suggestionMain {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .suggestionLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .suggestionDetail {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
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
    .oc-liquid-btn.is-spinning:not(.send) .oc-liquid-icon { animation: toolbarSpin 900ms linear infinite; }
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
	      .modelTrigger { height: 28px; }
    }
    @media (min-width: 760px) {
      .app.history-open.history-wide .body { grid-template-columns: 230px minmax(0, 1fr); }
      .app.history-open.history-wide .historyPane { position: relative; inset: auto; width: auto; z-index: auto; transform: none; box-shadow: none; }
      .app.history-open.history-wide .historyBackdrop { display: none; }
    }
	    @media (prefers-reduced-motion: no-preference) {
	      .timelineItem { animation: messageIn 150ms ease both; }
	      .timelineItem.streamStable { animation: none; }
	      .dots span { animation: pulse 900ms ease-in-out infinite; }
	      .dots span:nth-child(2) { animation-delay: 130ms; }
	      .dots span:nth-child(3) { animation-delay: 260ms; }
	      @keyframes messageIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
	      @keyframes pulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
	      @keyframes toolbarSpin { to { transform: rotate(360deg); } }
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
      --composer-icon-button-size: 28px;
      --composer-toolbar-icon-slot-size: 22px;
      --composer-toolbar-glyph-size: 18px;
      --composer-toolbar-status-glyph-size: 13px;
      --composer-send-button-size: 34px;
      --header-icon-button-size: 28px;
      --header-toolbar-glyph-size: 20px;
      --diagram-zoom-button-size: 30px;
      --diagram-zoom-glyph-size: 20px;
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
      width: var(--header-icon-button-size);
      min-width: var(--header-icon-button-size);
      height: var(--header-icon-button-size);
      min-height: var(--header-icon-button-size);
      flex: 0 0 var(--header-icon-button-size);
    }
    .topbar .oc-liquid-icon {
      width: var(--header-toolbar-glyph-size);
      height: var(--header-toolbar-glyph-size);
      flex: 0 0 var(--header-toolbar-glyph-size);
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
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .settingsEntryStatus {
      margin-inline-start: auto;
      flex: 0 0 auto;
      max-width: 96px;
      min-height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 7px;
      border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 28%, transparent);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 6%, transparent);
      font-size: 10px;
      font-weight: 650;
      line-height: 1;
      white-space: nowrap;
    }
    .settingsEntryStatus.ready {
      color: var(--vscode-testing-iconPassed, #73c991);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 44%, transparent);
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 8%, transparent);
    }
    .settingsEntryStatus.warning {
      color: var(--vscode-editorWarning-foreground, #cca700);
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 46%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 8%, transparent);
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
    .ragActionbar .ragRebuildButton.oc-liquid-btn {
      width: auto;
      min-width: min(100%, 168px);
      max-width: 100%;
      height: auto;
      min-height: 30px;
      color: var(--vscode-foreground);
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 34%, var(--oc-border));
      background:
        linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,.03)),
        var(--vscode-sideBar-background);
      box-shadow: 0 7px 18px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.12);
    }
    .ragActionbar .ragRebuildButton.oc-liquid-btn:hover {
      background:
        linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.05)),
        var(--oc-hover-bg);
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
    .usageMetricStrip {
      grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
    }
    .usageMetric {
      border-inline-start: 0;
      border-block-start: 1px solid var(--oc-border);
    }
    .usageMetric:nth-child(-n + 5) {
      border-block-start: 0;
    }
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
    .messageSendStatus {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 220px;
      padding: 2px 7px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 9%, transparent);
      white-space: nowrap;
      text-transform: none;
    }
    .messageSendStatus::before {
      content: "";
      flex: 0 0 6px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 14%, transparent);
    }
    .messageSendStatus.summarizing::before,
    .messageSendStatus.preparing::before {
      animation: ocSendStatusPulse 1.1s ease-in-out infinite;
    }
    .messageSendStatusText {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @keyframes ocSendStatusPulse {
      0%, 100% { transform: scale(0.84); opacity: 0.58; }
      50% { transform: scale(1); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .messageSendStatus.summarizing::before,
      .messageSendStatus.preparing::before {
        animation: none;
      }
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
    .diagramZoom,
    .openDiagramViewer,
    .copyTable,
    .exportMermaidImage,
    .exportDrawioImage,
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
    .diagramZoom {
      width: var(--diagram-zoom-button-size);
      min-width: var(--diagram-zoom-button-size);
      height: var(--diagram-zoom-button-size);
      min-height: var(--diagram-zoom-button-size);
      flex: 0 0 var(--diagram-zoom-button-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .diagramZoom .oc-liquid-icon {
      width: var(--diagram-zoom-glyph-size);
      height: var(--diagram-zoom-glyph-size);
      stroke-width: 2.15;
    }
    .messageAction:hover,
    .copyCode:hover,
    .diagramZoom:hover,
    .openDiagramViewer:hover,
    .copyTable:hover,
    .exportMermaidImage:hover,
    .exportDrawioImage:hover,
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
    .diagramZoom,
    .openDiagramViewer,
    .exportMermaidImage,
    .exportDrawioImage,
    .toggleDiagramSource { opacity: 0; }
    .codeBlock:hover .copyCode,
    .codeBlock:focus-within .copyCode,
    .diagramBlock:hover .copyCode,
    .diagramBlock:focus-within .copyCode,
    .diagramBlock:hover .diagramZoom,
    .diagramBlock:focus-within .diagramZoom,
    .diagramBlock:hover .openDiagramViewer,
    .diagramBlock:focus-within .openDiagramViewer,
    .diagramBlock:hover .exportMermaidImage,
    .diagramBlock:focus-within .exportMermaidImage,
    .diagramBlock:hover .exportDrawioImage,
    .diagramBlock:focus-within .exportDrawioImage,
    .diagramBlock:hover .toggleDiagramSource,
    .diagramBlock:focus-within .toggleDiagramSource,
    .copyCode:focus-visible,
    .diagramZoom:focus-visible,
    .openDiagramViewer:focus-visible,
    .exportMermaidImage:focus-visible,
    .exportDrawioImage:focus-visible,
    .toggleDiagramSource:focus-visible { opacity: 1; }
    .diagramZoom[disabled],
    .diagramZoom[disabled]:hover,
    .diagramBlock:hover .diagramZoom[disabled],
    .diagramBlock:focus-within .diagramZoom[disabled],
    .openDiagramViewer[disabled],
    .openDiagramViewer[disabled]:hover,
    .diagramBlock:hover .openDiagramViewer[disabled],
    .diagramBlock:focus-within .openDiagramViewer[disabled],
    .exportMermaidImage[disabled],
    .exportMermaidImage[disabled]:hover,
    .diagramBlock:hover .exportMermaidImage[disabled],
    .diagramBlock:focus-within .exportMermaidImage[disabled],
    .exportDrawioImage[disabled],
    .exportDrawioImage[disabled]:hover,
    .diagramBlock:hover .exportDrawioImage[disabled],
    .diagramBlock:focus-within .exportDrawioImage[disabled] {
      color: var(--oc-muted);
      background: transparent;
      opacity: 0.28;
    }
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
    .chat-toolbar-icon-button,
    .chat-toolbar-icon {
      width: var(--composer-icon-button-size);
      min-width: var(--composer-icon-button-size);
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .composerStatusToggle,
    .composerStatusPill:not(.oc-chip),
    .composerIconButton,
    .toggles .oc-liquid-toggle,
    .toggles .oc-icon-toggle {
      width: var(--composer-icon-button-size);
      min-width: var(--composer-icon-button-size);
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
      border-radius: var(--oc-radius);
    }
    .composerStatusPill.oc-chip {
      width: auto;
      min-width: 0;
      height: var(--composer-icon-button-size);
      min-height: var(--composer-icon-button-size);
    }
    .chat-toolbar-icon-slot {
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 var(--composer-toolbar-icon-slot-size);
      line-height: 1;
    }
    .chat-toolbar-icon-slot .oc-liquid-icon,
    .chat-toolbar-icon-slot .autocompleteStatusIcon {
      width: var(--composer-toolbar-glyph-size);
      height: var(--composer-toolbar-glyph-size);
    }
    .chat-toolbar-icon-slot > .codicon {
      width: var(--composer-toolbar-glyph-size);
      height: var(--composer-toolbar-glyph-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: var(--composer-toolbar-glyph-size);
      line-height: var(--composer-toolbar-glyph-size);
    }
    .index-status-icon-stack {
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
      display: grid;
      grid-template: 1fr / 1fr;
      align-items: center;
      justify-items: center;
      flex: 0 0 var(--composer-toolbar-icon-slot-size);
      color: currentColor;
    }
    .index-status-icon {
      grid-area: 1 / 1;
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
      box-sizing: border-box;
      border-radius: 999px;
      border: 2px solid currentColor;
      background: transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: currentColor;
    }
    .index-status-warning-badge {
      grid-area: 1 / 1;
      justify-self: end;
      align-self: start;
      width: 9px;
      min-width: 9px;
      height: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      border-radius: 999px;
      border: 1px solid var(--vscode-editor-background);
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: var(--vscode-editor-background);
      font-size: 7px;
      font-weight: 800;
      line-height: 1;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 35%, transparent), 0 1px 3px rgba(0, 0, 0, 0.22);
    }
    .index-status-warning-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transform: translateY(-0.2px);
    }
    .index-status-icon .codicon {
      width: var(--composer-toolbar-status-glyph-size);
      height: var(--composer-toolbar-status-glyph-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: var(--composer-toolbar-status-glyph-size);
      line-height: var(--composer-toolbar-status-glyph-size);
    }
    .codegraph-status-glyph {
      width: var(--composer-toolbar-status-glyph-size);
      height: var(--composer-toolbar-status-glyph-size);
      display: block;
      flex: 0 0 var(--composer-toolbar-status-glyph-size);
      color: currentColor;
    }
    .codegraph-status-glyph path,
    .codegraph-status-glyph rect {
      vector-effect: non-scaling-stroke;
    }
    .index-status-icon--ready,
    .index-status-icon--indexed,
    .index-status-icon--enabled {
      color: var(--vscode-testing-iconPassed, #3fb950);
    }
    .index-status-icon--indexing,
    .index-status-icon--syncing {
      color: var(--vscode-charts-blue, #3794ff);
    }
    .index-status-icon--disabled,
    .index-status-icon--idle,
    .index-status-icon--unknown {
      color: var(--vscode-disabledForeground);
    }
    .index-status-icon--error {
      color: var(--vscode-testing-iconFailed, #f85149);
    }
    .composerSupportRail {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
      min-width: 0;
    }
    .composerSupportRail .composerStatusPill:not(.oc-chip) {
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
    .composerStatusPill .pillText {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      width: 100%;
      height: 100%;
    }
    .composerStatusPill.hasText .pillText {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      min-width: 0;
      width: 100%;
    }
    .composerStatusPill.hasText .pillGlyph,
    .oc-chip .pillGlyph,
    .oc-liquid-chip .pillGlyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 var(--composer-toolbar-icon-slot-size);
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
    }
    .autocompleteStatusIcon {
      display: block;
      overflow: visible;
    }
    .autocompleteStatusIconBrace {
      stroke: var(--vscode-icon-foreground, currentColor);
      stroke-width: 1.85;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .autocompleteStatusIcon-disabled .autocompleteStatusIconBrace {
      opacity: 0.78;
    }
    .autocompleteStatusIconSlash {
      stroke: var(--vscode-testing-iconFailed, #f85149);
      stroke-width: 1.1;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.78;
      vector-effect: non-scaling-stroke;
    }
    .autocompleteStatusIconBadge {
      stroke: var(--vscode-editor-background, transparent);
      stroke-width: 0.8;
    }
    .autocompleteStatusIconBadge-enabled {
      fill: var(--vscode-testing-iconPassed, #3fb950);
    }
    .autocompleteStatusIconBadge-disabled {
      fill: var(--vscode-testing-iconFailed, #f85149);
    }
    .autocompleteStatusIconBadgeMark {
      stroke: #fff;
      stroke-width: 0.9;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
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
	    .composerStatusPill.goal.active { color: var(--vscode-focusBorder); }
	    .composerStatusPill.goal.paused,
	    .composerStatusPill.goal.usage-limited,
	    .composerStatusPill.goal.budget-limited { color: var(--vscode-editorWarning-foreground, #cca700); }
	    .composerStatusPill.goal.blocked { color: var(--vscode-errorForeground, #f48771); }
	    .composerStatusPill.goal.complete { color: var(--vscode-testing-iconPassed, #73c991); }
	    .composerStatusPill.completion.ready { color: var(--vscode-testing-iconPassed, #73c991); }
	    .composerStatusPill.completion.off { color: var(--vscode-descriptionForeground); }
	    .composerStatusPill.completion.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
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
	    .composer.is-drop-target {
	      border-color: var(--vscode-focusBorder);
	      background: color-mix(in srgb, var(--vscode-focusBorder) 10%, var(--vscode-input-background));
	      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent), 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
	    }
	    .composer.goalInputMode {
	      border-color: color-mix(in srgb, var(--vscode-focusBorder) 72%, var(--oc-border));
	      background:
	        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent), transparent 68%),
	        var(--vscode-input-background);
	      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent);
	    }
    .goalSummaryBanner {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 8px;
      row-gap: 2px;
      width: calc(100% - 12px);
      min-width: 0;
      min-height: 34px;
      margin: 6px 6px 0;
      padding: 5px 9px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 34%, var(--oc-border));
      border-radius: var(--oc-radius);
      color: var(--vscode-foreground);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent), transparent 70%),
        color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-input-background)) 82%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 14%, transparent), 0 7px 18px rgba(0, 0, 0, 0.08);
      text-align: start;
      cursor: pointer;
    }
    .goalSummaryBanner[hidden] {
      display: none;
    }
    .goalSummaryBanner:hover,
    .goalSummaryBanner.open {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 54%, var(--oc-border));
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent), transparent 70%),
        color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-input-background)) 88%, transparent);
    }
    .goalSummaryBanner:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .goalSummaryBanner.paused,
    .goalSummaryBanner.usage-limited,
    .goalSummaryBanner.budget-limited {
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 44%, var(--oc-border));
    }
    .goalSummaryBanner.blocked {
      border-color: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 48%, var(--oc-border));
    }
    .goalSummaryBanner.complete {
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 44%, var(--oc-border));
    }
    .goalSummaryIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      grid-column: 1;
      grid-row: 1 / span 2;
      align-self: start;
      flex: 0 0 var(--composer-toolbar-icon-slot-size);
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
      color: var(--vscode-focusBorder);
    }
    .goalSummaryCopy {
      display: grid;
      gap: 2px;
      min-width: 0;
      align-content: center;
    }
    .goalSummaryText {
      display: grid;
      gap: 2px;
      min-width: 0;
      line-height: 1.2;
    }
    .goalSummaryStatus {
      font-weight: 700;
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
	    .goalSummaryObjective {
	      min-width: 0;
	      overflow: hidden;
	      display: -webkit-box;
	      -webkit-box-orient: vertical;
	      -webkit-line-clamp: 2;
	      line-clamp: 2;
	      color: var(--vscode-descriptionForeground);
	      text-overflow: ellipsis;
	      white-space: normal;
	      overflow-wrap: anywhere;
	    }
	    .goalSummaryMeta {
	      min-width: 0;
	      overflow: hidden;
	      text-overflow: ellipsis;
	      color: var(--vscode-descriptionForeground);
	      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }
	    .goalSummaryBadge {
	      display: inline-flex;
	      align-items: center;
	      justify-content: center;
      grid-column: 3;
      grid-row: 1 / span 2;
      align-self: start;
      flex: 0 0 auto;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      color: var(--vscode-button-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder) 82%, var(--vscode-button-background));
      font-size: 11px;
	      font-weight: 800;
	      line-height: 1;
	    }
		    .goalResumePrompt {
		      display: grid;
		      grid-template-columns: auto minmax(0, 1fr) auto;
		      align-items: center;
		      gap: 8px;
	      width: calc(100% - 12px);
	      min-width: 0;
	      margin: 5px 6px 0;
	      padding: 7px 9px;
	      border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 38%, var(--oc-border));
	      border-radius: var(--oc-radius);
	      background:
	        linear-gradient(135deg, color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent), transparent 70%),
	        color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-input-background)) 86%, transparent);
	      box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent), 0 7px 16px rgba(0, 0, 0, 0.07);
	    }
	    .goalResumePrompt[hidden] {
	      display: none;
	    }
	    .goalResumePrompt.blocked {
	      border-color: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 46%, var(--oc-border));
	      background:
	        linear-gradient(135deg, color-mix(in srgb, var(--vscode-errorForeground, #f48771) 11%, transparent), transparent 72%),
	        color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-input-background)) 86%, transparent);
	    }
		    .goalResumeCopy {
		      display: flex;
		      flex-direction: column;
	      gap: 2px;
	      flex: 1 1 auto;
	      min-width: 0;
		      line-height: 1.22;
		    }
		    .goalResumePrompt .goalSummaryIcon {
		      grid-column: auto;
		      grid-row: auto;
		      align-self: center;
		    }
		    .goalResumeTitle {
	      font-size: 12px;
	      font-weight: 800;
	      color: var(--vscode-foreground);
	    }
	    .goalResumeObjective {
	      color: var(--vscode-descriptionForeground);
	      overflow: hidden;
	      text-overflow: ellipsis;
	      white-space: nowrap;
	    }
		    .goalResumeActions {
		      display: grid;
		      grid-template-columns: repeat(2, minmax(0, 1fr));
		      align-items: center;
		      gap: 6px;
		      justify-self: end;
		      width: min(164px, 100%);
		      min-width: 0;
		    }
		    .goalResumeAction {
		      display: inline-flex;
	      align-items: center;
	      justify-content: center;
		      gap: 5px;
		      min-width: 0;
		      max-width: 100%;
		      min-height: 28px;
		      padding: 0 9px;
		      border-radius: var(--oc-radius-sm);
		      font-weight: 700;
		      overflow: hidden;
		      text-overflow: ellipsis;
		      white-space: nowrap;
		    }
		    @container composer (max-width: 360px) {
		      .goalResumePrompt {
		        grid-template-columns: auto minmax(0, 1fr);
		        align-items: start;
		      }
		      .goalResumePrompt .goalSummaryIcon {
		        align-self: start;
		      }
		      .goalResumeActions {
		        grid-column: 1 / -1;
		        justify-self: stretch;
		        width: 100%;
		      }
		    }
	    .composer textarea {
      min-height: 62px;
      max-height: 172px;
      padding: 9px 10px 6px;
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
      display: grid;
      grid-template-columns: 28px minmax(104px, 118px) minmax(148px, 172px) minmax(118px, 144px) minmax(84px, 96px);
      justify-content: start;
      align-items: center;
      gap: 6px;
      flex: 1 1 0;
      min-width: 0;
    }
    .composerPickerRail > * {
      min-width: 0;
    }
    .composerAddButton {
      flex: 0 0 28px;
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      box-shadow: none;
      font-family: var(--vscode-font-family);
    }
    .composerAddButton.open,
    .composerAddButton.has-context {
      color: var(--vscode-focusBorder);
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    .composerAddButton:hover,
    .composerAddButton:focus-visible {
      color: var(--vscode-foreground);
      border: 0;
      background: color-mix(in srgb, var(--vscode-toolbar-hoverBackground, var(--vscode-foreground)) 55%, transparent);
      box-shadow: none;
    }
    .composerAddButton.open:hover,
    .composerAddButton.has-context:hover,
    .composerAddButton.open:focus-visible,
    .composerAddButton.has-context:focus-visible {
      color: var(--vscode-focusBorder);
    }
    .composerAddGlyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      color: currentColor;
      font-size: 28px;
      font-weight: 300;
      line-height: 20px;
      letter-spacing: -0.04em;
    }
    .composerPickerRail .permissionTrigger,
    .composerPickerRail .goalTrigger {
      width: 100%;
      height: 28px;
      min-height: 28px;
      padding: 0 8px;
      border-radius: 999px;
      border-color: var(--oc-border);
      background: transparent;
    }
    .composerPickerRail .permissionTrigger {
      min-width: 0;
      max-width: none;
    }
    .composerPickerRail .goalTrigger {
      min-width: 0;
      max-width: none;
    }
    .composerSupportRail .skillsTrigger.is-empty {
      display: none;
    }
    .composerPickerRail .modelTrigger {
      width: 100%;
      min-width: 0;
      max-width: none;
    }
    .composerPickerRail .agentTrigger {
      width: 100%;
      min-width: 0;
      max-width: none;
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
    .goalTrigger:hover,
    .goalTrigger.open,
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
      width: 100%;
      min-width: 0;
      max-width: none;
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
      display: none;
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
    .composerMoreMenu {
      padding: 6px;
    }
    .composerMoreSection {
      display: grid;
      gap: 2px;
      padding: 2px 0;
    }
    .composerMoreSection + .composerMoreSection {
      margin-top: 5px;
      padding-top: 7px;
      border-top: 1px solid color-mix(in srgb, var(--oc-border) 72%, transparent);
    }
    .composerMoreSectionTitle {
      padding: 2px 7px 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .composerMoreItem {
      grid-template-columns: 24px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 6px 7px;
      border-radius: 9px;
    }
    .composerMoreItem:hover,
    .composerMoreItem:focus-visible,
    .composerMoreItem.active {
      background: var(--oc-hover-bg);
    }
    .composerMoreItemIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--composer-toolbar-icon-slot-size);
      height: var(--composer-toolbar-icon-slot-size);
      color: currentColor;
    }
    .composerMoreItemIcon .oc-liquid-icon,
    .composerMoreItemIcon .autocompleteStatusIcon {
      width: var(--composer-toolbar-glyph-size);
      height: var(--composer-toolbar-glyph-size);
    }
    .composerMoreItemCopy {
      min-width: 0;
      overflow: hidden;
    }
    .composerMoreItemState {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      min-height: 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1;
    }
    .composerMoreItem[aria-checked="true"] .composerMoreItemState {
      color: var(--vscode-testing-iconPassed, #73c991);
    }
    .composerMoreBadge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      color: var(--vscode-button-foreground);
      background: color-mix(in srgb, var(--vscode-button-background) 86%, transparent);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
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
      width: var(--composer-toolbar-glyph-size);
      height: var(--composer-toolbar-glyph-size);
      flex: 0 0 var(--composer-toolbar-glyph-size);
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, currentColor 34%, transparent);
      border-top-color: currentColor;
      animation: toolbarSpin 800ms linear infinite;
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
      .composerPickerRail .goalTrigger {
        flex-grow: 1;
        min-width: 74px;
        max-width: 132px;
      }
      .composerActionRow {
        gap: 4px;
      }
      .composerSupportRail { gap: 2px; }
      .composerSupportRail .composerStatusPill:not(.oc-chip) {
        width: var(--composer-icon-button-size);
        min-width: var(--composer-icon-button-size);
      }
      .settingsActions { justify-content: flex-start; }
    }
    @media (max-width: 300px) {
      .topbar .oc-liquid-btn,
      .topbar .oc-icon-btn {
        width: var(--header-icon-button-size);
        min-width: var(--header-icon-button-size);
        height: var(--header-icon-button-size);
        min-height: var(--header-icon-button-size);
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
    @container composer (max-width: 620px) {
      .composerToolbar {
        gap: 5px;
      }
      .composerPickerRail {
        grid-template-columns: 28px minmax(92px, 104px) minmax(118px, 1.05fr) minmax(104px, 0.95fr) 28px;
        gap: 5px;
      }
      .composerPickerRail .goalTrigger {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
        justify-content: center;
        padding: 0;
      }
      .composerPickerRail .goalTrigger .pillLabelText {
        display: none;
      }
      .composerPickerRail .goalTrigger .pillText {
        justify-content: center;
        gap: 0;
      }
      .composerToolbar .send {
        margin-inline-start: 0;
      }
    }
    @container composer (max-width: 420px) {
      .composerToolbar {
        gap: 5px;
      }
      .composerPickerRail {
        grid-template-columns: 28px 28px minmax(74px, 1fr) minmax(74px, 1fr) 28px;
        gap: 5px;
      }
      .composerPickerRail .permissionTrigger,
      .composerPickerRail .goalTrigger {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
        justify-content: center;
        padding: 0;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .agentTrigger.warning,
      .composerPickerRail .modelTrigger.warning {
        width: auto;
        min-width: 0;
        max-width: none;
        justify-content: flex-start;
        padding: 0 8px;
      }
      .composerPickerRail .permissionTrigger .pillLabelText,
      .composerPickerRail .goalTrigger .pillLabelText {
        display: none;
      }
      .composerPickerRail .permissionTrigger .pillText,
      .composerPickerRail .goalTrigger .pillText {
        justify-content: center;
        gap: 0;
      }
      .composerToolbar .send {
        margin-inline-start: 0;
      }
    }
    @container composer (max-width: 300px) {
      .composerPickerRail {
        grid-template-columns: 28px 28px 28px 28px 28px;
        gap: 4px;
      }
      .composerPickerRail .permissionTrigger {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .goalTrigger,
      .composerPickerRail .agentTrigger.warning,
      .composerPickerRail .modelTrigger.warning {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
      }
      .composerPickerRail .modelTrigger,
      .composerPickerRail .agentTrigger,
      .composerPickerRail .goalTrigger,
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
      .historyToolbarButton,
      .historyToolbarButton:hover,
      .historyToolbarButton:focus-visible,
      .historyToolbarButton.danger:hover,
      .historyToolbarButton.danger:focus-visible {
        color: CanvasText;
        background: transparent;
        border-color: CanvasText;
        box-shadow: none;
        forced-color-adjust: auto;
      }
      .historyToolbarButton:hover,
      .historyToolbarButton:focus-visible {
        color: HighlightText;
        background: Highlight;
      }
      .historyToolbarButton .historyToolbarGlyph {
        background: currentColor;
        filter: none;
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
        <button id="openAgentTerminal" class="oc-icon-btn oc-liquid-btn" type="button" title="Open ChipMate Agent Terminal" aria-label="Open ChipMate Agent Terminal">${liquidIcons.terminal}<span class="srOnly">Open ChipMate Agent Terminal</span></button>
        <button id="historyToggle" class="oc-icon-btn oc-liquid-btn headerHistoryAction" type="button" title="History" aria-label="History">${liquidIcons.history}<span class="srOnly">History</span></button>
        <button id="newSession" class="oc-icon-btn oc-liquid-btn" type="button" title="New session" aria-label="New session">${liquidIcons.compose}<span class="srOnly">New session</span></button>
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
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="complete" role="tab" aria-selected="false">${liquidIcons.completion}<span class="settingsEntryLabel">Complete</span><span id="completionSettingsStatus" class="settingsEntryStatus off" title="Autocomplete disabled · inline code completion is off" aria-label="Autocomplete disabled">Off</span></button>
        <button type="button" class="settingsEntry oc-settings-tile oc-liquid-card" data-settings-section="skills" role="tab" aria-selected="false">${liquidIcons.skillBlocks}<span class="settingsEntryLabel">Skills</span></button>
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
          <label class="field">Provider mode<select id="completionProviderMode">
            <option value="inherit-chat">Inherit Chat Provider</option>
            <option value="custom">Custom Completion Provider</option>
          </select></label>
          <label class="field">Provider<select id="completionProvider">
            <option value="qwen-direct">Qwen Direct</option>
            <option value="fim-direct">FIM Direct</option>
            <option value="none">None</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select></label>
          <div id="completionDirectFields" class="completionDirectFields hidden">
            <label class="field">Profile<select id="completionProfile">
              <option value="generic-chat">Generic Chat</option>
              <option value="qwen-coder-fim">Qwen Coder FIM</option>
              <option value="deepseek-fim">DeepSeek FIM</option>
            </select></label>
            <label class="field">API Base URL<input id="completionApiBaseUrl" type="url" spellcheck="false" placeholder="Inherit chat provider"></label>
            <label class="field">API key<input id="completionApiKey" type="password" autocomplete="off" placeholder="Use chat key"></label>
            <label class="field">Model<select id="completionModel"></select></label>
            <label class="field">Max tokens<input id="completionMaxTokens" type="number" min="1" max="4096" step="1"></label>
            <label class="field">Context window tokens<input id="completionContextLength" type="number" min="0" max="1000000" step="1" title="0 = auto detect via /models"></label>
            <label class="field">Temperature<input id="completionTemperature" type="number" min="0" max="2" step="0.1"></label>
            <label class="field">Top P<input id="completionTopP" type="number" min="0" max="1" step="0.05"></label>
          </div>
        </div>
        <div class="row settingsActions">
          <div class="row">
            <button id="saveCompletionSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Save inline completion settings" aria-label="Save inline completion settings">${liquidIcons.save}<span class="srOnly">Save inline completion settings</span></button>
            <button id="testCompletionApi" class="oc-icon-btn oc-liquid-btn" type="button" title="Test completion API" aria-label="Test completion API">${liquidIcons.beaker}<span class="srOnly">Test completion API</span></button>
            <button id="refreshCompletionModels" class="oc-icon-btn oc-liquid-btn" type="button" title="Refresh completion models" aria-label="Refresh completion models">${liquidIcons.refresh}<span class="srOnly">Refresh completion models</span></button>
            <button id="resetCompletionProvider" class="oc-icon-btn oc-liquid-btn" type="button" title="Reset completion provider to chat provider" aria-label="Reset completion provider to chat provider">${liquidIcons.discard}<span class="srOnly">Reset completion provider to chat provider</span></button>
          </div>
        </div>
        <div id="completionDetail" class="detail" aria-live="polite"></div>
      </div>
      <div id="skillsSettingsGroup" class="settingsSection" data-settings-panel="skills" role="tabpanel">
        <div class="settingsHeader">
          <div class="settingsCompactLine">${liquidIcons.skillBlocks}<div class="sectionTitle">Skills</div></div>
          <div id="skillsSettingsStatus" class="sectionMeta">Workspace</div>
        </div>
        <div id="skillImportDropZone" class="skillImportDropZone" role="button" tabindex="0" aria-label="Import ChipMate skill by dropping a skill folder or SKILL.md">
          <span class="skillImportIcon" aria-hidden="true">${liquidIcons.add}</span>
          <span class="skillImportCopy">
            <span class="skillImportTitle">Import Skill...</span>
            <span class="skillImportHint">Drop a skill folder, a parent skills folder, or SKILL.md. Valid skills are copied to ~/.agents/skills.</span>
          </span>
        </div>
        <div id="skillsList" class="skillsList"></div>
        <div class="row settingsActions">
          <button id="importSkill" class="oc-primary-btn oc-liquid-chip" type="button" title="Import a skill into user-level .agents/skills">${liquidIcons.add}<span class="oc-liquid-chip-label">Import Skill...</span></button>
          <button id="saveSkillsSettings" class="oc-icon-btn oc-liquid-btn" type="button" title="Save enabled skills" aria-label="Save enabled skills">${liquidIcons.save}<span class="srOnly">Save enabled skills</span></button>
        </div>
        <div id="skillsDetail" class="detail visible" aria-live="polite">Skills are discovered from workspace and user .agents/skills/*/SKILL.md.</div>
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
          <button id="forceRebuildCodeRag" class="ragRebuildButton oc-liquid-btn" type="button" title="强制重建 Code RAG：删除旧索引并从 0 重建" aria-label="强制重建 Code RAG">${liquidIcons.retry}<span class="ragRebuildButtonLabel">强制重建 Code RAG</span></button>
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
	          <div id="historyTitle" class="historyTitle">History</div>
	          <div class="row historyActions">
	            <button id="selectHistorySessions" class="oc-icon-btn oc-liquid-btn historyToolbarButton" type="button" title="Select chat history sessions" aria-label="Select chat history sessions">${historyToolbarIconGlyph("enterSelection", historyToolbarIconUris)}<span class="srOnly">Select chat history sessions</span></button>
	            <button id="selectAllHistorySessions" class="oc-icon-btn oc-liquid-btn historyToolbarButton" type="button" title="Select all chat history sessions" aria-label="Select all chat history sessions" hidden>${historyToolbarIconGlyph("selectAll", historyToolbarIconUris)}<span class="srOnly">Select all chat history sessions</span></button>
	            <button id="deleteSelectedHistorySessions" class="oc-icon-btn oc-liquid-btn historyToolbarButton danger" type="button" title="Delete selected chat history sessions" aria-label="Delete selected chat history sessions" hidden>${historyToolbarIconGlyph("delete", historyToolbarIconUris)}<span class="srOnly">Delete selected chat history sessions</span></button>
	            <button id="refreshHistory" class="oc-icon-btn oc-liquid-btn historyToolbarButton" type="button" title="Refresh history list" aria-label="Refresh history list">${historyToolbarIconGlyph("refresh", historyToolbarIconUris)}<span class="srOnly">Refresh history list</span></button>
	            <button id="closeHistory" class="oc-icon-btn oc-liquid-btn historyToolbarButton" type="button" title="Close history" aria-label="Close history">${historyToolbarIconGlyph("close", historyToolbarIconUris)}<span class="srOnly">Close history</span></button>
	          </div>
	        </div>
        <div id="sessionList" class="sessionList"></div>
      </aside>
      <section class="chatMain view-chat">
        <main id="messages" class="messages" aria-label="Chat messages">
          <div class="empty">Ask with context</div>
        </main>
        <section id="usagePage" class="usagePage" role="region" aria-label="Chat token usage" hidden>
          <div id="usagePageContent" class="usageState">
            <div class="usageStateInner">
              <div class="usageStateIcon" aria-hidden="true">${liquidIcons.sparkle}</div>
              <div class="usageStateTitle">Loading usage</div>
              <div class="usageStateCopy">Chat token activity will appear here.</div>
            </div>
          </div>
        </section>
        <button id="jumpLatest" class="jumpLatest oc-chip oc-liquid-chip" type="button" title="Jump to latest message" aria-label="Jump to latest message" aria-hidden="true" tabindex="-1">${liquidIcons.more}<span class="jumpLatestText">Latest</span></button>
        <div id="toolApprovalBanner" class="toolApprovalBanner" aria-live="polite" aria-hidden="true"></div>
        <footer class="composerWrap">
          <div id="composerStatusBar" class="composerStatusBar" aria-live="polite">
            <button id="composerStatusToggle" class="composerStatusToggle chat-toolbar-icon-button oc-icon-toggle oc-liquid-toggle" type="button" aria-expanded="true" aria-controls="composerPanel" title="Hide input panel">
              <span class="composerToggleIcon chat-toolbar-icon-slot" aria-hidden="true">${liquidIcons.panelBottomCollapseSimple}</span>
              <span class="composerToggleLabel">
                <span id="composerToggleFull" class="composerToggleFull">Hide input</span>
                <span id="composerToggleShort" class="composerToggleShort">Hide</span>
              </span>
            </button>
            <div class="composerSupportRail" aria-label="Composer status details">
              <button id="contextStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn context" type="button" title="Show context details"><span class="pillText">${toolbarIconSlotHtml(liquidIcons.contextLens)}</span></button>
              <button id="indexStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn index info" type="button" title="Show index details"><span class="pillText" aria-hidden="true">${codeGraphStatusIconMarkup("unknown")}</span></button>
              <button id="ragStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn rag info" type="button" title="Show RAG index details"><span class="pillText" aria-hidden="true">${indexStatusIconMarkup("unknown", "database")}</span></button>
              <button id="documentRagStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn documentRag info" type="button" title="Document RAG index: Disabled" aria-label="Document RAG index: Disabled"><span class="pillText" aria-hidden="true">${indexStatusIconMarkup("unknown", documentRagStatusCodicon)}</span></button>
              <button id="guardStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn guard ok is-hidden" type="button" title="Show guard details" hidden><span class="pillText">${toolbarIconSlotHtml(liquidIcons.shield)}</span></button>
              <button id="usageStatusPill" class="composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn usage pending" type="button" title="Show usage details"><span class="pillText">${toolbarIconSlotHtml(liquidIcons.sparkle)}</span></button>
              <button id="skillsStatusPill" class="composerStatusPill skillsTrigger oc-chip oc-liquid-chip context is-empty" type="button" title="Show skills" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.skillBlocks)}</span></span></button>
              <button id="completionStatusPill" class="composerStatusPill oc-chip oc-liquid-chip completion off is-empty" type="button" title="Autocomplete disabled · inline code completion is off" aria-label="Autocomplete disabled" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText"><span class="pillGlyph">${toolbarIconSlotHtml(autocompleteStatusIcons.disabled)}</span><span class="pillLabelText">Complete off</span></span></button>
              <button id="queueStatusPill" class="composerStatusPill oc-chip oc-liquid-chip queue info is-hidden" type="button" title="Show queued sends" hidden><span class="pillText"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.send)}</span><span class="pillLabelText">Queue</span></span></button>
            </div>
          </div>
          <div id="composerStatusPopover" class="composerStatusPopover" aria-hidden="true"></div>
          <div id="composerPanel" class="composerPanel">
            <div id="codeIntelligence" class="codeIntel"></div>
            <select id="modelSelect" class="modelSelectHidden" title="Model"></select>
            <div class="composer">
              <div id="suggestions" class="suggestions"></div>
	              <div id="contextChips" class="contextChips" aria-label="Selected ChipMate context"></div>
	              <div id="queuedSendList" class="queuedSendList" aria-label="Queued ChipMate prompts"></div>
	              <button id="goalSummaryBanner" class="goalSummaryBanner oc-liquid-chip" type="button" title="Show current goal" aria-label="Show current goal" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover" hidden></button>
	              <div id="goalResumePrompt" class="goalResumePrompt oc-liquid-chip" role="status" aria-live="polite" hidden></div>
	              <textarea id="input" placeholder="Ask ChipMate…"></textarea>
              <div class="composerToolbar composerPrimaryRail composerControlRail">
                <div class="composerPickerRail">
                  <button id="composerMore" class="composerAddButton composerMoreButton chat-toolbar-icon-button" type="button" title="Add context and actions" aria-label="Add context and actions" aria-haspopup="menu" aria-expanded="false" aria-controls="composerMoreMenu"><span class="composerAddGlyph" aria-hidden="true">+</span><span class="srOnly">Add context and actions</span></button>
                  <button id="permissionStatusPill" class="composerStatusPill permissionTrigger oc-chip oc-liquid-chip permission tools-off is-empty" type="button" title="工具关闭：模型工具调用已关闭，权限模式暂不生效。" aria-label="模型工具调用：已关闭。权限模式暂不生效。" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.toolDisabled)}</span></span></button>
                  <button id="modelTrigger" class="modelTrigger oc-chip oc-liquid-chip" type="button" title="Model" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.server)}</span><span class="oc-liquid-chip-label">Model</span></button>
                  <button id="agentTrigger" class="modelTrigger agentTrigger oc-chip oc-liquid-chip" type="button" title="Agent" aria-haspopup="listbox" aria-expanded="false" aria-controls="agentMenu"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.agent)}</span><span class="oc-liquid-chip-label">Agent</span></button>
                  <button id="goalStatusPill" class="composerStatusPill goalTrigger oc-chip oc-liquid-chip goal is-empty" type="button" title="Goal inactive" aria-label="Goal inactive" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerStatusPopover"><span class="pillText"><span class="pillGlyph">${toolbarIconSlotHtml(liquidIcons.goalTarget)}</span><span class="pillLabelText">Goal</span></span></button>
                </div>
                <div id="composerHint" class="composerHint">@ files, Enter send, Ctrl+Enter newline</div>
                <button id="send" class="send oc-icon-btn oc-liquid-btn" type="button" title="Send" aria-label="Send message">${toolbarIconSlotHtml(liquidIcons.send)}<span class="srOnly">Send message</span></button>
              </div>
            </div>
            <div class="composerActionRow toggles composerContextRail" aria-label="Composer context actions" hidden>
              <input id="file" class="toggleInput" type="checkbox" checked>
              <input id="sel" class="toggleInput" type="checkbox" checked>
              <input id="diag" class="toggleInput" type="checkbox">
              <input id="diff" class="toggleInput" type="checkbox">
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
  <div id="composerPopupLayer" class="composerPopupLayer">
    <div id="modelMenu" class="modelMenu" role="listbox" aria-label="Model" aria-hidden="true"></div>
    <div id="agentMenu" class="modelMenu agentMenu" role="listbox" aria-label="Agent" aria-hidden="true"></div>
    <div id="composerMoreMenu" class="modelMenu composerMoreMenu" role="menu" aria-label="More composer actions" aria-hidden="true">
      <div class="composerMoreSection" role="group" aria-label="Use as context">
        <div class="composerMoreSectionTitle">Use as context</div>
        <button id="fileToggle" class="modelMenuItem composerMoreItem composerMoreToggle" type="button" role="menuitemcheckbox" title="Include current file" aria-label="Include current file" aria-checked="true"></button>
        <button id="selToggle" class="modelMenuItem composerMoreItem composerMoreToggle" type="button" role="menuitemcheckbox" title="Include editor selection" aria-label="Include editor selection" aria-checked="true"></button>
        <button id="diagToggle" class="modelMenuItem composerMoreItem composerMoreToggle" type="button" role="menuitemcheckbox" title="Include diagnostics" aria-label="Include diagnostics" aria-checked="false"></button>
        <button id="diffToggle" class="modelMenuItem composerMoreItem composerMoreToggle" type="button" role="menuitemcheckbox" title="Include git diff" aria-label="Include git diff" aria-checked="false"></button>
      </div>
      <div class="composerMoreSection" role="group" aria-label="Add">
        <div class="composerMoreSectionTitle">Add</div>
        <button id="attach" class="modelMenuItem composerMoreItem composerMoreAction" type="button" role="menuitem" title="Attach workspace file to this message" aria-label="Attach workspace file to this message"></button>
        <button id="addPersistentContext" class="modelMenuItem composerMoreItem composerMoreAction" type="button" role="menuitem" title="Add persistent context file" aria-label="Add persistent context file"></button>
      </div>
      <div class="composerMoreSection" role="group" aria-label="Session">
        <div class="composerMoreSectionTitle">Session</div>
        <button id="refreshModels" class="modelMenuItem composerMoreItem composerMoreAction" type="button" role="menuitem" title="Refresh models" aria-label="Refresh models"></button>
        <button id="exportMarkdown" class="modelMenuItem composerMoreItem composerMoreAction" type="button" role="menuitem" title="Export current chat to Markdown" aria-label="Export current chat to Markdown"></button>
      </div>
    </div>
  </div>
  <div id="diagramViewer" class="diagramViewer" role="dialog" aria-label="Diagram viewer" aria-hidden="true" hidden>
    <div class="diagramViewerToolbar">
      <div id="diagramViewerTitle" class="diagramViewerTitle">Diagram viewer</div>
      <div class="diagramViewerActions" aria-label="Diagram viewer controls">
        <button id="diagramViewerZoomOut" class="diagramViewerButton oc-icon-btn oc-liquid-btn" type="button" title="Zoom out diagram" aria-label="Zoom out diagram">${toolbarIconSlotHtml(liquidIcons.zoomOut)}</button>
        <button id="diagramViewerZoomIn" class="diagramViewerButton oc-icon-btn oc-liquid-btn" type="button" title="Zoom in diagram" aria-label="Zoom in diagram">${toolbarIconSlotHtml(liquidIcons.zoomIn)}</button>
        <button id="diagramViewerFit" class="diagramViewerButton oc-icon-btn oc-liquid-btn" type="button" title="Fit diagram" aria-label="Fit diagram">${toolbarIconSlotHtml(liquidIcons.refresh)}</button>
        <button id="diagramViewerClose" class="diagramViewerButton oc-icon-btn oc-liquid-btn" type="button" title="Close diagram viewer" aria-label="Close diagram viewer">${toolbarIconSlotHtml(liquidIcons.close)}</button>
      </div>
    </div>
    <div id="diagramViewerCanvas" class="diagramViewerCanvas" tabindex="0">
      <div id="diagramViewerSurface" class="diagramViewerSurface"></div>
    </div>
  </div>
  ${mermaidScriptTag}
  <script nonce="${nonce}">
	    const vscode = acquireVsCodeApi();
    function webviewErrorText(value) {
      if (value instanceof Error) return value.message || value.name || "Error";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    function webviewErrorStack(value) {
      return value instanceof Error && typeof value.stack === "string" ? value.stack : "";
    }
    function reportWebviewError(payload) {
      try {
        vscode.postMessage(Object.assign({ type: "webviewError" }, payload || {}));
      } catch {
        // Best effort only; renderer diagnostics must not break the UI.
      }
    }
    window.addEventListener("error", (event) => {
      reportWebviewError({
        message: webviewErrorText(event.error || event.message),
        source: event.filename || "",
        lineno: Number.isFinite(event.lineno) ? event.lineno : undefined,
        colno: Number.isFinite(event.colno) ? event.colno : undefined,
        stack: webviewErrorStack(event.error)
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      reportWebviewError({
        message: "Unhandled promise rejection",
        reason: webviewErrorText(event.reason),
        stack: webviewErrorStack(event.reason)
      });
    });
	    const el = (id) => document.getElementById(id);
	    const LIQUID_ICONS = ${liquidIconForScript};
	    const HISTORY_TOOLBAR_ICONS = ${historyToolbarIconsForScript};
	    const AUTOCOMPLETE_STATUS_ICONS = ${autocompleteStatusIconsForScript};
	    const BRAND_ICON_URI = ${JSON.stringify(brandIconUri)};
    const DRAWIO_RUNTIME_URI = ${JSON.stringify(drawioRuntimeUri)};
    const DRAWIO_RUNTIME_HTML_B64 = ${JSON.stringify(drawioRuntimeHtmlBase64)};
    const MERMAID_MAX_SOURCE_BYTES = 100000;
    const DRAWIO_MAX_SOURCE_BYTES = 250000;
    const DRAWIO_RENDER_TIMEOUT_MS = 20000;
    const DRAWIO_EXPORT_SCALE = 2;
    const DRAWIO_EXPORT_BORDER = 16;
    const DRAWIO_RENDER_BACKGROUND_MODE = "white-bg";
    const DIAGRAM_ZOOM_MIN = 0.25;
	    const DIAGRAM_ZOOM_MAX = 6;
	    const DIAGRAM_ZOOM_STEP = 0.25;
	    const DIAGRAM_ZOOM_DEFAULT = 1;
	    const DIAGRAM_VIEWER_ZOOM_MIN = 0.1;
	    const DIAGRAM_VIEWER_ZOOM_MAX = 8;
	    let mermaidInitialized = false;
    let mermaidRenderSerial = 0;
    let drawioRuntimeFrame;
    let drawioRuntimeReadyPromise;
    let drawioRuntimeHandshakePromise;
    let drawioRuntimeInitResolve;
    let drawioRuntimeInitReject;
    let drawioRuntimeInitTimer;
    let drawioDiagramSerial = 0;
    let drawioRuntimeRequestSerial = 0;
    let drawioRuntimeQueue = Promise.resolve();
    const drawioRuntimePending = new Map();
    const drawioRenderedPngCache = new Map();
	    const drawioRenderedPngInflight = new Map();
	    const registeredDiagramVisualEvidence = new Set();
	    const postedMermaidRenderFailures = new Set();
	    let diagramViewerZoom = 1;
	    let diagramViewerOpener = undefined;
	    const DIAGRAM_VISUAL_NORMAL_MAX_SIDE = 1280;
	    const DIAGRAM_VISUAL_DENSE_MAX_SIDE = 2048;
	    const DIAGRAM_VISUAL_READABLE_MIN_SIDE = 1024;
	    const DIAGRAM_VISUAL_SOFT_MAX_BYTES = 1024 * 1024;
	    const DIAGRAM_VISUAL_HARD_MAX_BYTES = 2 * 1024 * 1024;
	    const DIAGRAM_VISUAL_DENSE_SOURCE_BYTES = 8 * 1024;
	    const DIAGRAM_VISUAL_DENSE_LABEL_COUNT = 24;
	    const DIAGRAM_VISUAL_DENSE_EDGE_COUNT = 24;
	    const DIAGRAM_VISUAL_DENSE_DRAWIO_CELL_COUNT = 40;
    const DRAWIO_HANDSHAKE_XML = '<mxGraphModel dx="140" dy="90" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="160" pageHeight="100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Offline" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#eaf4ff;strokeColor=#5b8def;fontColor=#172033;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="44" as="geometry"/></mxCell></root></mxGraphModel>';
	    const STATUS_ICONS = {
		      context: LIQUID_ICONS.contextLens,
		      database: LIQUID_ICONS.database,
		      diagnostics: LIQUID_ICONS.diagnostics,
	      panelBottomClose: LIQUID_ICONS.panelBottomCollapseSimple,
	      panelBottomOpen: LIQUID_ICONS.panelBottomExpandSimple,
	      shieldAlert: LIQUID_ICONS.diagnostics,
	      shieldCheck: LIQUID_ICONS.shield,
		      shieldOff: LIQUID_ICONS.shield,
	      tool: LIQUID_ICONS.tool,
	      toolsOff: LIQUID_ICONS.toolDisabled,
		      skill: LIQUID_ICONS.skillBlocks,
			      usage: LIQUID_ICONS.sparkle,
			      goal: LIQUID_ICONS.goalTarget,
			      completion: LIQUID_ICONS.completion,
		      queue: LIQUID_ICONS.send,
		    };
    const RAG_EMBEDDING_BATCH_SIZE_DEFAULT = 64;
    const RAG_EMBEDDING_BATCH_SIZE_OPTIONS = [1, 5, 10, 32, 64, 128, 256, 512];
    const RAG_EMBEDDING_BATCH_SIZE_ERROR = "Embedding batch size must be one of 1, 5, 10, 32, 64, 128, 256, or 512.";
    const RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT = 65536;
    const RAG_EMBEDDING_CONCURRENT_REQUESTS_DEFAULT = 2;
    const RAG_EMBEDDING_MAX_IN_FLIGHT_TOKENS_DEFAULT = 360000;
    const RAG_EMBEDDING_ENCODING_FORMAT_DEFAULT = "auto";
    const RAG_EMBEDDING_ENCODING_FORMATS = ["float", "base64", "auto"];
    const RAG_EMBEDDING_REQUEST_DELAY_DEFAULT_MS = 0;
    const RAG_EMBEDDING_CHECKPOINT_MODE_DEFAULT = "interval";
    const RAG_EMBEDDING_CHECKPOINT_MODES = ["off", "interval", "safe"];
    const RAG_EMBEDDING_CHECKPOINT_CHUNK_INTERVAL_DEFAULT = 8192;
    const RAG_EMBEDDING_CHECKPOINT_INTERVAL_DEFAULT_MS = 120000;
	    let state = {};
      let activeMainView = webviewState().activeMainView === "usage" ? "usage" : "chat";
      let usageActivityMode = webviewState().usageActivityMode === "weekly" || webviewState().usageActivityMode === "cumulative"
        ? webviewState().usageActivityMode
        : "daily";
      const USAGE_DAY_MS = 24 * 60 * 60 * 1000;
      let hoveredUsageBucketId = "";
      let selectedUsageBucketId = "";
      let usageBucketLookup = new Map();
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
	    let historyBulkSelectMode = false;
	    let selectedHistorySessionIds = new Set();
      let newSessionPending = false;
      let newSessionPendingSourceSessionID = "";
      let newSessionPendingTimer = 0;
	    let userNearBottom = true;
	    let autoFollowMessages = true;
	    let forceNextMessageFollow = false;
	    let lastMessagesScrollTop = 0;
	    let mentionedFiles = [];
    let composerDragDepth = 0;
    let skillImportDragDepth = 0;
    let mentionResults = [];
    let suggestionMode = "";
    let activeSuggestion = 0;
    let searchTimer = 0;
    let mentionRequestId = 0;
    let activeMentionRequestId = 0;
    let mentionStatus = "";
    let mentionTruncated = false;
    let mentionError = "";
    let mentionSearched = false;
    let expandedSkillDetailId = "";
    let promptHistorySessionID = "";
    let promptHistoryEntries = [];
    let promptHistorySignature = "";
    let promptHistoryIndex = -1;
	    let promptHistoryDraft = "";
	    let restoringPromptHistory = false;
	    let optimisticQueuedSends = [];
	    let optimisticLocalSends = [];
	    let goalInputMode = webviewState().goalInputMode === true;
	    let pendingGoalObjective = "";
	    let activeActivityElapsedTimer = 0;
    const restoredComposerDraft = composerDraftFromWebviewState();
    let modelMenuOpen = false;
    let agentMenuOpen = false;
    let composerMoreMenuOpen = false;
	    let composerCollapsed = false;
	    let composerPinnedStatusPopover = "";
	    let composerHoverStatusPopover = "";
	    let composerHoverCloseTimer = 0;
	    let selectedContextItemId = "";
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
	    for (const id of ["completionEnabled", "completionProviderMode", "completionProvider", "completionProfile", "completionApiBaseUrl", "completionApiKey", "completionModel", "completionMaxTokens", "completionContextLength", "completionTemperature", "completionTopP"]) {
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
	        renderRagRebuildControl();
	      });
	      el(id).addEventListener("change", () => {
	        userEditedRagSettings = true;
	        renderRagRebuildControl();
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
    messagesRoot.addEventListener("click", onMessagesClick);
    el("toolApprovalBanner").addEventListener("click", onMessagesClick);
	    messagesRoot.addEventListener("touchstart", (event) => {
	      if (isNestedMessageScroller(event.target)) pauseAutoFollowForUser();
	    }, { capture: true, passive: true });
	    el("jumpLatest").addEventListener("click", jumpToLatestMessage);
		    window.addEventListener("resize", () => {
		      renderShell();
		      positionModelMenu();
		      positionAgentMenu();
		      positionComposerMoreMenu();
		      if (isDiagramViewerOpen()) fitDiagramViewer();
		    });
	    el("historyToggle").addEventListener("click", () => {
	      historyTouched = true;
	      historyOpen = !historyOpen;
	      renderShell();
	    });
	    el("selectHistorySessions").addEventListener("click", () => {
	      historyBulkSelectMode = !historyBulkSelectMode;
	      selectedHistorySessionIds.clear();
	      render();
	    });
	    el("selectAllHistorySessions").addEventListener("click", () => {
	      const sessionIDs = historySessionIds();
	      const selectedLiveCount = sessionIDs.filter((sessionID) => selectedHistorySessionIds.has(sessionID)).length;
	      const allSelected = sessionIDs.length > 0 && selectedLiveCount === sessionIDs.length;
	      if (allSelected) {
	        selectedHistorySessionIds.clear();
	        historyBulkSelectMode = false;
	      } else {
	        selectedHistorySessionIds = new Set(sessionIDs);
	        historyBulkSelectMode = sessionIDs.length > 0;
	      }
	      render();
	    });
	    el("deleteSelectedHistorySessions").addEventListener("click", () => {
	      const sessionIDs = Array.from(selectedHistorySessionIds);
	      if (sessionIDs.length === 0) return;
	      vscode.postMessage({ type: "deleteSessions", sessionIDs });
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
      el("usagePage").addEventListener("click", onUsagePageClick);
      el("usagePage").addEventListener("mouseover", onUsagePagePointerOver);
      el("usagePage").addEventListener("mouseleave", clearHoveredUsageBucket);
      el("usagePage").addEventListener("focusin", onUsagePageFocusIn);
      el("usagePage").addEventListener("focusout", onUsagePageFocusOut);
      el("usagePage").addEventListener("keydown", onUsagePageKeydown);
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
        el("refreshCompletionModels").addEventListener("click", refreshCompletionModels);
        el("resetCompletionProvider").addEventListener("click", resetCompletionProvider);
        el("importSkill").addEventListener("click", () => vscode.postMessage({ type: "pickSkillImport" }));
        el("saveSkillsSettings").addEventListener("click", saveSkillsSettings);
				    el("saveRagSettings").addEventListener("click", saveRagSettings);
				    el("testRagSettings").addEventListener("click", testRagSettings);
				    el("forceRebuildCodeRag").addEventListener("click", forceRebuildCodeRag);
				    el("toggleRagIndexing").addEventListener("click", toggleRagIndexing);
    el("discardRagSettings").addEventListener("click", discardRagSettings);
	    el("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    el("syncState").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
	    el("openAgentTerminal").addEventListener("click", () => vscode.postMessage({ type: "openAgentTerminal" }));
	    el("openOutput").addEventListener("click", () => vscode.postMessage({ type: "openOutput" }));
		    el("newSession").addEventListener("click", requestNewSession);
    el("composerStatusToggle").addEventListener("click", toggleComposerPanel);
	    bindComposerStatusPill("contextStatusPill", "context", true);
		    bindGoalStatusPill();
		    bindGoalSummaryBanner();
		    bindGoalResumePrompt();
	    bindComposerStatusPill("indexStatusPill", "index", true);
    bindComposerStatusPill("ragStatusPill", "rag", true);
    bindComposerStatusPill("documentRagStatusPill", "documentRag", true);
    bindComposerStatusPill("permissionStatusPill", "permission", false);
    bindComposerStatusPill("skillsStatusPill", "skills", true);
    bindComposerStatusPill("guardStatusPill", "guard", false);
    bindComposerStatusPill("usageStatusPill", "usage", true);
	    bindComposerStatusPill("completionStatusPill", "completion", true);
	    bindComposerStatusPill("queueStatusPill", "queue", true);
	    el("diagramViewerClose").addEventListener("click", closeDiagramViewer);
	    el("diagramViewerZoomOut").addEventListener("click", () => setDiagramViewerZoom(diagramViewerZoom - DIAGRAM_ZOOM_STEP));
	    el("diagramViewerZoomIn").addEventListener("click", () => setDiagramViewerZoom(diagramViewerZoom + DIAGRAM_ZOOM_STEP));
	    el("diagramViewerFit").addEventListener("click", fitDiagramViewer);
	    enableDiagramViewerPan(el("diagramViewerCanvas"));
	    el("composerStatusPopover").addEventListener("click", onComposerStatusPopoverClick);
    el("composerStatusPopover").addEventListener("mouseenter", cancelComposerHoverClose);
    el("composerStatusPopover").addEventListener("mouseleave", () => scheduleComposerHoverClose());
    el("refreshModels").addEventListener("click", () => {
      composerMoreMenuOpen = false;
      renderComposerMoreMenu();
      vscode.postMessage({ type: "refreshModels" });
    });
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
	      if (isDiagramViewerOpen()) {
	        event.preventDefault();
	        closeDiagramViewer();
	        return;
	      }
	      const hadPopup = modelMenuOpen || agentMenuOpen || composerMoreMenuOpen || Boolean(activeComposerStatusPopover()) || el("suggestions").classList.contains("open");
      if (!hadPopup) return;
      event.preventDefault();
      modelMenuOpen = false;
      agentMenuOpen = false;
      composerMoreMenuOpen = false;
      closeComposerStatusPopoverState();
      mentionResults = [];
      suggestionMode = "";
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
	    el("addPersistentContext").addEventListener("click", () => {
        composerMoreMenuOpen = false;
        renderComposerMoreMenu();
        vscode.postMessage({ type: "addFile" });
      });
	    el("attach").addEventListener("click", () => {
        composerMoreMenuOpen = false;
        renderComposerMoreMenu();
        vscode.postMessage({ type: "pickWorkspaceFilesForMessage" });
      });
	    el("send").addEventListener("click", onSendButtonClick);
	    el("input").addEventListener("input", onComposerInput);
	    el("input").addEventListener("keydown", onComposerKeydown);
	    el("sel").addEventListener("change", renderMentionChips);
	    el("file").addEventListener("change", renderMentionChips);
    bindSkillImportDropTarget();
    bindComposerDropTarget();
    for (const item of [
      ["file", "fileToggle"],
      ["sel", "selToggle"],
      ["diag", "diagToggle", "diagnostics"],
      ["diff", "diffToggle"],
    ]) {
      bindContextToggle(item[0], item[1], item[2]);
    }
    restoreComposerDraft();

	    window.addEventListener("message", (event) => {
	      if (event.data.type === "state") {
	        const nextState = event.data.state || {};
		        const nextConnectionState = nextState.connectionState || "disconnected";
			        const shouldCloseSettings = !pendingAction && nextConnectionState === "connected" && lastConnectionState !== "connected";
	            reconcileNewSessionPending(nextState);
			        state = nextState;
	        reconcileGoalInputModeAfterState();
			        reconcileHistorySelection();
	        reconcileOptimisticLocalSends(nextState.messages || []);
		        reconcileOptimisticQueuedSends(nextState.queuedSends);
	        syncPromptHistoryFromState();
	        if (shouldCloseSettings) settingsOpen = false;
	        lastConnectionState = nextConnectionState;
	        render();
	        syncActiveActivityElapsedTimer();
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
        suggestionMode = "file";
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
      if (event.data.type === "droppedFilesResolved") {
        addMentionFilesToDraft(event.data.files, event.data.notice || "", event.data.skippedCount || 0);
        return;
      }
      if (event.data.type === "workspaceFilesPicked") {
        addMentionFilesToDraft(event.data.files, event.data.notice || "", 0);
        return;
      }
	      if (event.data.type === "restoreQueuedSendDraft") {
	        restoreQueuedSendDraft(event.data);
	        return;
	      }
	      if (event.data.type === "queueUpdated") {
	        applyQueueSnapshot(event.data);
	        if (event.data.message) setNotice(event.data.message || "");
	        renderQueuedSendList();
	        renderComposerStatusBar();
	        renderSendButton();
	        return;
	      }
	      if (event.data.type === "sendAccepted") {
	        handleSendAccepted(event.data);
	        return;
	      }
	      if (event.data.type === "sendRejected") {
	        handleSendRejected(event.data);
	        return;
	      }
	      if (event.data.type === "queueRejected") {
	        handleQueueRejected(event.data);
	        return;
	      }
	      if (event.data.type === "exportStatus") {
	        setNotice(event.data.message || "");
	      }
	      if (event.data.type === "queueStatus") {
	        setNotice(event.data.message || "");
	      }
	      if (event.data.type === "completionStatus") {
	        renderCompletionStatus(event.data.message || "", event.data.status || "info");
	      }
        if (event.data.type === "skillsStatus") {
          renderSkillsStatus(event.data.message || "", event.data.status || "info");
        }
        if (event.data.type === "skillsImportStatus") {
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
	      if (completionModelUnavailable()) {
	        renderCompletionStatus("无可用补全模型，补全暂不可用", "error");
	        return;
	      }
	      userEditedCompletionSettings = false;
	      renderCompletionStatus("Saving inline completion settings...", "info");
	      vscode.postMessage({
	        type: "saveCompletionSettings",
	        settings: completionSettingsPayload()
	      });
	    }

	    function testCompletionApi() {
	      if (completionModelUnavailable()) {
	        renderCompletionStatus("无可用补全模型，补全暂不可用", "error");
	        return;
	      }
	      userEditedCompletionSettings = false;
	      renderCompletionStatus("Testing direct completion API...", "info");
	      vscode.postMessage({
	        type: "testCompletionApi",
	        settings: completionSettingsPayload()
	      });
	    }

	    function refreshCompletionModels() {
	      renderCompletionStatus("Refreshing completion models...", "info");
	      vscode.postMessage({
	        type: "refreshCompletionModels",
	        settings: completionSettingsPayload()
	      });
	    }

	    function resetCompletionProvider() {
	      userEditedCompletionSettings = false;
	      el("completionProviderMode").value = "inherit-chat";
	      el("completionApiBaseUrl").value = "";
	      el("completionApiKey").value = "";
	      renderCompletionStatus("Resetting completion provider...", "info");
	      vscode.postMessage({
	        type: "saveCompletionSettings",
	        settings: completionSettingsPayload({ resetToInherit: true })
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

      function forceRebuildCodeRag() {
        if (userEditedRagSettings) {
          renderRagStatus("请先保存或丢弃未保存的 RAG 修改。强制重建只使用已保存配置。", "error");
          return;
        }
        renderRagStatus("Preparing Code RAG force rebuild confirmation...", "info");
        vscode.postMessage({ type: "forceRebuildCodeRag" });
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

	    function completionSettingsPayload(options) {
	      const providerMode = el("completionProviderMode").value;
	      const payload = {
	        enabled: el("completionEnabled").checked,
	        providerMode,
	        provider: el("completionProvider").value,
	        profile: el("completionProfile").value,
	        apiBaseUrl: providerMode === "custom" ? el("completionApiBaseUrl").value : "",
	        model: el("completionModel").value,
	        maxTokens: numberInputValue("completionMaxTokens", 128),
	        contextLength: numberInputValue("completionContextLength", 200000),
	        temperature: numberInputValue("completionTemperature", 0.1),
	        topP: numberInputValue("completionTopP", 1)
	      };
	      const apiKey = el("completionApiKey").value;
	      if (apiKey) payload.apiKey = apiKey;
	      if (options && options.resetToInherit) payload.resetToInherit = true;
	      return payload;
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
      suggestionMode = "";
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
	        if (!isGoalInputModeActive() && state.sending && !hasComposerDraft()) {
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
          const isComposerMoreItem = Boolean(button.closest("#composerMoreMenu"));
          if (popoverName && !isComposerMoreItem) {
            event.stopPropagation();
            cancelComposerHoverClose();
            composerPinnedStatusPopover = popoverName;
            composerHoverStatusPopover = "";
            closeComposerPopups();
            renderComposerStatusBar();
          } else {
            renderComposerToggles();
            renderComposerMoreMenu();
          }
        });
        input.addEventListener("change", renderComposerToggles);
      }

    function bindSkillImportDropTarget() {
      const dropZone = el("skillImportDropZone");
      if (!dropZone) return;
      dropZone.addEventListener("click", () => vscode.postMessage({ type: "pickSkillImport" }));
      dropZone.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        vscode.postMessage({ type: "pickSkillImport" });
      });
      dropZone.addEventListener("dragenter", onSkillImportDragEnter);
      dropZone.addEventListener("dragover", onSkillImportDragOver);
      dropZone.addEventListener("dragleave", onSkillImportDragLeave);
      dropZone.addEventListener("drop", onSkillImportDrop);
    }

    function onSkillImportDragEnter(event) {
      if (!canDropSkillImportFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      skillImportDragDepth += 1;
      setSkillImportDropTarget(true);
    }

    function onSkillImportDragOver(event) {
      if (!canDropSkillImportFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setSkillImportDropTarget(true);
    }

    function onSkillImportDragLeave(event) {
      if (!canDropSkillImportFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      skillImportDragDepth = Math.max(0, skillImportDragDepth - 1);
      if (skillImportDragDepth === 0) setSkillImportDropTarget(false);
    }

    function onSkillImportDrop(event) {
      if (!canDropSkillImportFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      skillImportDragDepth = 0;
      setSkillImportDropTarget(false);
      const candidates = extractDroppedFileCandidates(event.dataTransfer);
      if (candidates.length > 0) {
        renderSkillsStatus("Importing dropped skill candidate...", "info");
        vscode.postMessage({ type: "importSkillCandidates", candidates });
        return;
      }
      renderSkillsStatus("No skill path was found in the drop. Use Import Skill... to choose a directory or SKILL.md.", "error");
    }

    function canDropSkillImportFiles(dataTransfer) {
      return canDropComposerFiles(dataTransfer);
    }

    function setSkillImportDropTarget(active) {
      const dropZone = el("skillImportDropZone");
      if (!dropZone) return;
      dropZone.classList.toggle("is-drop-target", Boolean(active));
    }

    function bindComposerDropTarget() {
      const composer = document.querySelector(".composer");
      if (!composer) return;
      composer.addEventListener("dragenter", onComposerDragEnter);
      composer.addEventListener("dragover", onComposerDragOver);
      composer.addEventListener("dragleave", onComposerDragLeave);
      composer.addEventListener("drop", onComposerDrop);
    }

    function onComposerDragEnter(event) {
      if (!canDropComposerFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      composerDragDepth += 1;
      setComposerDropTarget(true);
    }

    function onComposerDragOver(event) {
      if (!canDropComposerFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setComposerDropTarget(true);
    }

    function onComposerDragLeave(event) {
      if (!canDropComposerFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      composerDragDepth = Math.max(0, composerDragDepth - 1);
      if (composerDragDepth === 0) setComposerDropTarget(false);
    }

    function onComposerDrop(event) {
      if (!canDropComposerFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      composerDragDepth = 0;
      setComposerDropTarget(false);
      const candidates = extractDroppedFileCandidates(event.dataTransfer);
      if (candidates.length > 0) {
        vscode.postMessage({ type: "addDroppedFiles", candidates });
        return;
      }
      setNotice("Drop workspace files from VS Code, or use Attach/@mention for other files.");
    }

    function canDropComposerFiles(dataTransfer) {
      if (!dataTransfer) return false;
      const types = Array.from(dataTransfer.types || []);
      return types.includes("text/uri-list") || types.includes("text/plain") || types.includes("Files");
    }

    function setComposerDropTarget(active) {
      const composer = document.querySelector(".composer");
      if (!composer) return;
      composer.classList.toggle("is-drop-target", Boolean(active));
    }

    function extractDroppedFileCandidates(dataTransfer) {
      if (!dataTransfer) return [];
      const values = [
        dataTransfer.getData("text/uri-list"),
        dataTransfer.getData("text/plain"),
      ];
      const seen = new Set();
      const candidates = [];
      for (const value of values) {
        for (const line of String(value || "").split(/\\r?\\n/)) {
          const candidate = line.trim();
          if (!candidate || candidate.startsWith("#") || seen.has(candidate)) continue;
          seen.add(candidate);
          candidates.push(candidate);
        }
      }
      return candidates;
    }

    function addMentionFilesToDraft(files, notice, skippedCount) {
      const normalized = normalizeDraftMentionedFiles(files);
      const seen = new Set(mentionedFiles.map((file) => file.uri));
      const added = [];
      for (const file of normalized) {
        if (seen.has(file.uri)) continue;
        seen.add(file.uri);
        added.push(file);
      }
      if (added.length > 0) {
        mentionedFiles = mentionedFiles.concat(added);
        saveComposerDraft();
        renderMentionChips();
        renderSuggestions();
        renderSendButton();
      }
      if (added.length === 0 && normalized.length > 0) {
        setNotice("Selected files are already attached to this message.");
        return;
      }
      if (added.length > 0 && normalized.length > added.length) {
        const duplicateCount = normalized.length - added.length;
        setNotice("Added " + added.length + " file" + (added.length === 1 ? "" : "s") + ". " + duplicateCount + " already attached.");
        return;
      }
      setNotice(notice || (skippedCount ? "Some items were skipped." : ""));
    }

	    function send() {
	      const queueing = Boolean(state.sending);
	      let text = el("input").value.trim();
	      if (isGoalInputModeActive()) {
	        sendGoalObjective(text);
	        return;
	      }
		      if (!text && hasExplicitContext()) {
		        text = "Please review the referenced context.";
		      }
	      if (!text) {
	        setNotice("Type a message or attach context.");
	        el("input").focus();
	        return;
	      }
      if (localOnlyAgentBlocked() && !looksLikeExportRequest(text)) {
        setNotice(state.localOnlyWarning || "Required VS Code local agent is unavailable.");
        return;
      }
      if (queueing && queueIsFull()) {
        setNotice(queueFullNotice());
        el("input").focus();
        return;
      }
	      const sendMentionedFiles = mentionedFilesForHost(mentionedFiles);
	      const sendOptions = {
	        includeSelection: el("sel").checked,
	        includeCurrentFile: el("file").checked,
	        includeOpenFiles: false,
	        includeDiagnostics: el("diag").checked,
	        includeGitDiff: el("diff").checked
		      };
		      const clientQueueID = queueing ? nextClientQueueID() : "";
		      const clientSendID = queueing ? "" : nextClientSendID();
		      if (queueing) {
		        optimisticQueuedSends = [
		          ...optimisticQueuedSends,
		          {
		            id: clientQueueID,
		            kind: "message",
		            text,
		            options: sendOptions,
		            mentionedFiles: sendMentionedFiles,
		            optimistic: true
	          }
	        ];
	        renderQueuedSendList();
	        renderComposerStatusBar();
	        renderSendButton();
	      }
	      if (!queueing) {
	        addOptimisticLocalSend(clientSendID, text);
	      }
	      appendPromptHistoryEntry(text);
	      resetPromptHistoryNavigation();
	      enableAutoFollowMessages();
		      vscode.postMessage({
	        type: "sendMessage",
	        clientQueueID: clientQueueID || undefined,
	        clientSendID: clientSendID || undefined,
	        text,
	        mentionedFiles: sendMentionedFiles,
	        options: sendOptions
	      });
      el("input").value = "";
      mentionedFiles = [];
      mentionResults = [];
      suggestionMode = "";
      clearComposerDraft();
      renderMentionChips();
      renderSuggestions();
      renderSendButton();
	      setNotice(queueing ? queuedNoticeAfterSubmit() : "");
	    }

	    function sendGoalObjective(text) {
	      const objective = String(text || "").trim();
		      if (!objective) {
		        setNotice("Describe a goal before sending.");
		        el("input").focus();
		        return;
		      }
		      if (state.sending) {
		        sendQueuedGoalObjective(objective);
		        return;
		      }
		      pendingGoalObjective = objective;
		      vscode.postMessage({ type: "createGoal", objective });
		      setNotice("Starting goal...");
		      renderSendButton();
		    }

		    function sendQueuedGoalObjective(objective) {
		      if (queueIsFull()) {
		        setNotice(queueFullNotice());
		        el("input").focus();
		        return;
		      }
		      const clientQueueID = nextClientQueueID();
		      optimisticQueuedSends = [
		        ...optimisticQueuedSends,
		        {
		          id: clientQueueID,
		          kind: "goal",
		          text: objective,
		          optimistic: true
		        }
		      ];
		      vscode.postMessage({ type: "createGoal", objective, clientQueueID });
		      el("input").value = "";
		      mentionedFiles = [];
		      mentionResults = [];
		      suggestionMode = "";
		      goalInputMode = false;
		      persistGoalInputMode();
		      clearComposerDraft();
		      renderMentionChips();
		      renderSuggestions();
		      renderComposerInputMode();
		      renderQueuedSendList();
		      renderComposerStatusBar();
		      renderSendButton();
		      setNotice(goalQueuedNoticeAfterSubmit());
		    }

    function hasComposerDraft() {
      return Boolean(el("input").value.trim() || mentionedFiles.length > 0);
    }

    function queueIsFull() {
      return queuedSendCount() >= queuedSendLimit();
    }

    function queueFullNotice() {
      return "Queued " + queuedSendCount() + "/" + queuedSendLimit() + ". Wait for the current reply to finish.";
    }

	    function queuedNoticeAfterSubmit() {
	      return "Queued " + queuedSendCount() + "/" + queuedSendLimit() + ".";
	    }

	    function goalQueuedNoticeAfterSubmit() {
	      return "Goal queued. It will start after the current reply.";
	    }

	    function nextClientQueueID() {
	      return "client-queued-" + Date.now() + "-" + Math.random().toString(36).slice(2);
	    }

	    function nextClientSendID() {
	      return "client-send-" + Date.now() + "-" + Math.random().toString(36).slice(2);
	    }

	    function addOptimisticLocalSend(clientSendID, text) {
	      if (!clientSendID) return;
	      const id = localMessageIdForClientSend(clientSendID);
	      optimisticLocalSends = [
	        ...optimisticLocalSends.filter((item) => item.id !== id),
	        optimisticLocalMessage(id, clientSendID, text, {
	          stage: "pending",
	          label: "Pending send",
	          detail: "Waiting for the extension host."
	        })
	      ];
	      enableAutoFollowMessages();
	      renderMessages();
	    }

	    function optimisticLocalMessage(id, clientSendID, text, sendStatus) {
	      return {
	        id,
	        clientSendID,
	        role: "user",
	        text,
	        timeCreated: Date.now(),
	        sendStatus,
	        optimistic: true,
	        parts: [{ type: "sendStatus", status: sendStatus.stage, text: sendStatus.label, detail: sendStatus.detail || "" }]
	      };
	    }

	    function localMessageIdForClientSend(clientSendID) {
	      return "local-" + String(clientSendID || "").trim();
	    }

	    function handleSendAccepted(message) {
	      const id = String(message && (message.localID || localMessageIdForClientSend(message.clientSendID)) || "");
	      if (!id) return;
	      optimisticLocalSends = optimisticLocalSends.map((item) => {
	        if (item.id !== id) return item;
	        return {
	          ...item,
	          sendStatus: {
	            stage: "pending",
	            label: "Pending send",
	            detail: "Extension host accepted the message."
	          },
	          parts: [{ type: "sendStatus", status: "pending", text: "Pending send", detail: "Extension host accepted the message." }]
	        };
	      });
	      renderMessages();
	    }

	    function handleSendRejected(message) {
	      const id = String(message && (message.localID || localMessageIdForClientSend(message.clientSendID)) || "");
	      if (!id) return;
	      if (message && message.remove) {
	        optimisticLocalSends = optimisticLocalSends.filter((item) => item.id !== id);
	      } else {
	        const detail = String((message && message.message) || "Message was not sent.");
	        optimisticLocalSends = optimisticLocalSends.map((item) => {
	          if (item.id !== id) return item;
	          return {
	            ...item,
	            sendStatus: {
	              stage: "error",
	              label: "Send failed",
	              detail
	            },
	            parts: [{ type: "sendStatus", status: "error", text: "Send failed", detail }]
	          };
	        });
	      }
	      setNotice((message && message.message) || "Message was not sent.");
	      renderMessages();
	      renderSendButton();
	    }

	    function reconcileOptimisticLocalSends(messages) {
	      if (!optimisticLocalSends.length) return;
	      const canonical = Array.isArray(messages) ? messages : [];
	      const canonicalIds = new Set(canonical.map((item) => String(item && item.id || "")).filter(Boolean));
	      optimisticLocalSends = optimisticLocalSends.filter((local) => {
	        if (canonicalIds.has(local.id)) return false;
	        return !canonical.some((item) => remoteMatchesOptimisticLocalSend(item, local));
	      });
	    }

	    function remoteMatchesOptimisticLocalSend(remote, local) {
	      if (!remote || remote.role !== "user") return false;
	      if (String(remote.id || "") === local.id) return true;
	      if (String(remote.text || "").trim() !== String(local.text || "").trim()) return false;
	      const remoteTime = Number(remote.timeCreated || 0);
	      const localTime = Number(local.timeCreated || 0);
	      return remoteTime > 0 && localTime > 0 && Math.abs(remoteTime - localTime) < 60000;
	    }

	    function messagesWithOptimisticLocalSends() {
	      const messages = Array.isArray(state.messages) ? state.messages : [];
	      if (!optimisticLocalSends.length) return messages;
	      reconcileOptimisticLocalSends(messages);
	      const merged = [...messages, ...optimisticLocalSends];
	      return merged.sort((left, right) => (Number(left.timeCreated || 0) - Number(right.timeCreated || 0)));
	    }

	    function applyQueueSnapshot(message) {
      const queuedSends = normalizeQueuedSends(message && message.queuedSends, false);
      state = {
        ...state,
        queuedSends,
        queuedSendCount: Number.isFinite(Number(message && message.queuedSendCount)) ? Number(message.queuedSendCount) : queuedSends.length,
        queuedSendLimit: Number.isFinite(Number(message && message.queuedSendLimit)) ? Number(message.queuedSendLimit) : queuedSendLimit()
      };
      if (queuedSends.length === 0) optimisticQueuedSends = [];
      else reconcileOptimisticQueuedSends(queuedSends);
    }

    function handleQueueRejected(message) {
      const clientQueueID = message && typeof message.clientQueueID === "string" ? message.clientQueueID : "";
      const rejected = optimisticQueuedSends.find((item) => item.id === clientQueueID);
      optimisticQueuedSends = optimisticQueuedSends.filter((item) => item.id !== clientQueueID);
      if (rejected && (!message || message.reason !== "duplicate")) restoreQueuedSendDraft(rejected);
      setNotice((message && message.message) || "Queued message was not accepted.");
      renderQueuedSendList();
      renderComposerStatusBar();
      renderSendButton();
    }

    function reconcileOptimisticQueuedSends(canonicalItems) {
      const canonicalIDs = new Set(normalizeQueuedSends(canonicalItems, false).map((item) => item.id).filter(Boolean));
      if (!canonicalIDs.size) return;
      optimisticQueuedSends = optimisticQueuedSends.filter((item) => !canonicalIDs.has(item.id));
    }

    function normalizeQueuedSends(items, optimistic) {
      if (!Array.isArray(items)) return [];
      return items
        .map((item) => normalizeQueuedSend(item, optimistic))
        .filter(Boolean);
    }

	    function normalizeQueuedSend(item, optimistic) {
	      if (!item || typeof item !== "object") return undefined;
	      const id = typeof item.id === "string" && item.id ? item.id : nextClientQueueID();
	      const kind = item.kind === "goal" ? "goal" : "message";
	      const text = typeof item.text === "string" ? item.text : "";
	      return {
	        id,
	        kind,
	        text,
	        options: item.options && typeof item.options === "object" ? item.options : {},
	        mentionedFiles: normalizeDraftMentionedFiles(item.mentionedFiles),
	        tokenBudget: Number.isFinite(Number(item.tokenBudget)) ? Number(item.tokenBudget) : undefined,
	        optimistic: Boolean(optimistic || item.optimistic)
	      };
	    }

    function looksLikeExportRequest(text) {
      return /(^\\/export\\b|导出|保存|另存|存成|下载|markdown|\\.md\\b|\\bmd\\b|\\bexport\\b|\\bsave\\b|\\bdownload\\b)/i.test(text.trim());
    }

    function onComposerKeydown(event) {
      const suggestionsOpen = el("suggestions").classList.contains("open");
      if (!suggestionsOpen && handlePromptHistoryKeydown(event)) return;
      if (event.key === "Enter") {
        const modifiedEnter = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
        if (event.isComposing || event.keyCode === 229) return;
        if (!modifiedEnter && suggestionsOpen && mentionResults[activeSuggestion]) {
          event.preventDefault();
          selectSuggestion(mentionResults[activeSuggestion]);
          return;
        }
        if (modifiedEnter) return;
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
      } else if (event.key === "Tab") {
        if (mentionResults[activeSuggestion]) {
          event.preventDefault();
          selectSuggestion(mentionResults[activeSuggestion]);
        }
      } else if (event.key === "Escape") {
        mentionResults = [];
        suggestionMode = "";
        mentionStatus = "";
        mentionSearched = false;
        renderSuggestions();
      }
    }

    function syncPromptHistoryFromState() {
      const sessionID = String(state.currentSessionID || "");
      const stateEntries = promptHistoryEntriesFromMessages(state.messages || []);
      const entries = sessionID === promptHistorySessionID ? mergePromptHistoryEntries(stateEntries) : stateEntries;
      const signature = entries.join("\\n---prompt-history-entry---\\n");
      if (sessionID !== promptHistorySessionID) {
        promptHistorySessionID = sessionID;
        promptHistoryEntries = entries;
        promptHistorySignature = signature;
        resetPromptHistoryNavigation();
        return;
      }
      if (signature === promptHistorySignature) return;
      promptHistoryEntries = entries;
      promptHistorySignature = signature;
      if (promptHistoryIndex >= promptHistoryEntries.length) {
        promptHistoryIndex = promptHistoryEntries.length - 1;
      }
    }

    function promptHistoryEntriesFromMessages(messages) {
      return messages
        .filter((item) => item && item.role === "user" && typeof item.text === "string" && item.text.trim())
        .map((item) => item.text.trim());
    }

    function mergePromptHistoryEntries(entries) {
      if (promptHistoryEntries.length <= entries.length) return entries;
      for (let index = 0; index < entries.length; index += 1) {
        if (promptHistoryEntries[index] !== entries[index]) return entries;
      }
      return promptHistoryEntries;
    }

    function appendPromptHistoryEntry(text) {
      const prompt = String(text || "").trim();
      if (!prompt) return;
      promptHistorySessionID = String(state.currentSessionID || "");
      promptHistoryEntries = promptHistoryEntries.concat(prompt);
      promptHistorySignature = promptHistoryEntries.join("\\n---prompt-history-entry---\\n");
    }

    function resetPromptHistoryNavigation() {
      promptHistoryIndex = -1;
      promptHistoryDraft = "";
    }

    function handlePromptHistoryKeydown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      if (!promptHistoryEntries.length) return false;

      const input = el("input");
      if (event.key === "ArrowUp") {
        if (input.value.trim() && promptHistoryIndex < 0) return false;
        event.preventDefault();
        if (promptHistoryIndex < 0) promptHistoryDraft = input.value;
        const nextIndex = promptHistoryIndex < 0
          ? promptHistoryEntries.length - 1
          : Math.max(0, promptHistoryIndex - 1);
        promptHistoryIndex = nextIndex;
        setComposerInputFromPromptHistory(promptHistoryEntries[nextIndex]);
        return true;
      }

      if (promptHistoryIndex < 0) return false;
      event.preventDefault();
      const nextIndex = promptHistoryIndex + 1;
      if (nextIndex >= promptHistoryEntries.length) {
        promptHistoryIndex = -1;
        setComposerInputFromPromptHistory(promptHistoryDraft);
        promptHistoryDraft = "";
        return true;
      }
      promptHistoryIndex = nextIndex;
      setComposerInputFromPromptHistory(promptHistoryEntries[nextIndex]);
      return true;
    }

    function setComposerInputFromPromptHistory(value) {
      const input = el("input");
      restoringPromptHistory = true;
      try {
        input.value = value;
        input.setSelectionRange(input.value.length, input.value.length);
        onComposerInput();
      } finally {
        restoringPromptHistory = false;
      }
      input.focus();
    }

    function composerDraftFromWebviewState() {
      const draft = webviewState().composerDraft;
      if (!draft || typeof draft !== "object") return { text: "", mentionedFiles: [] };
      const text = typeof draft.text === "string" ? draft.text : "";
      return {
        text,
        mentionedFiles: hydrateLinkedMentionFiles(normalizeDraftMentionedFiles(draft.mentionedFiles), text)
      };
    }

    function restoreComposerDraft() {
      if (!restoredComposerDraft.text && !restoredComposerDraft.mentionedFiles.length) return;
      el("input").value = restoredComposerDraft.text;
      mentionedFiles = restoredComposerDraft.mentionedFiles;
      resetPromptHistoryNavigation();
      renderMentionChips();
      renderSuggestions();
      renderSendButton();
    }

	    function restoreQueuedSendDraft(message) {
	      const options = message && typeof message.options === "object" ? message.options : {};
	      const text = typeof message.text === "string" ? message.text : "";
	      if (message && message.kind === "goal") {
	        setGoalInputMode(true, { focus: false });
	        el("input").value = text;
	        mentionedFiles = [];
	        mentionResults = [];
	        suggestionMode = "";
	        resetPromptHistoryNavigation();
	        saveComposerDraft();
	        renderMentionChips();
	        renderSuggestions();
	        renderComposerToggles();
	        renderSendButton();
	        setNotice("Queued goal restored for editing.");
	        el("input").focus();
	        return;
	      }
	      el("input").value = text;
	      mentionedFiles = hydrateLinkedMentionFiles(normalizeDraftMentionedFiles(message.mentionedFiles), text);
      if (Object.prototype.hasOwnProperty.call(options, "includeSelection")) el("sel").checked = Boolean(options.includeSelection);
      if (Object.prototype.hasOwnProperty.call(options, "includeCurrentFile")) el("file").checked = Boolean(options.includeCurrentFile);
      if (Object.prototype.hasOwnProperty.call(options, "includeDiagnostics")) el("diag").checked = Boolean(options.includeDiagnostics);
      if (Object.prototype.hasOwnProperty.call(options, "includeGitDiff")) el("diff").checked = Boolean(options.includeGitDiff);
      resetPromptHistoryNavigation();
      saveComposerDraft();
      renderMentionChips();
      renderSuggestions();
      renderComposerToggles();
      renderSendButton();
      setNotice("Queued message restored for editing.");
      el("input").focus();
    }

    function saveComposerDraft() {
      const text = el("input").value;
      const files = normalizeDraftMentionedFiles(mentionedFiles);
      if (!text && !files.length) {
        clearComposerDraft();
        return;
      }
      vscode.setState({
        ...webviewState(),
        composerDraft: {
          text,
          mentionedFiles: files
        }
      });
    }

    function clearComposerDraft() {
      const nextState = { ...webviewState() };
      delete nextState.composerDraft;
      vscode.setState(nextState);
    }

    function webviewState() {
      const value = vscode.getState();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function normalizeDraftMentionedFiles(files) {
      if (!Array.isArray(files)) return [];
      return files
        .map((file) => {
          if (!file || typeof file !== "object") return undefined;
          const uri = typeof file.uri === "string" ? file.uri : "";
          const label = typeof file.label === "string" ? file.label : "";
          if (!uri || !label) return undefined;
          const item = { uri, label };
          if (file.type === "file" || file.type === "folder") item.type = file.type;
          if (typeof file.insertText === "string") item.insertText = file.insertText;
          if (typeof file.linkedMentionText === "string" && file.linkedMentionText) item.linkedMentionText = file.linkedMentionText;
          if (Number.isFinite(file.mentionIndex)) item.mentionIndex = Number(file.mentionIndex);
          return item;
        })
        .filter(Boolean);
    }

    function mentionedFilesForHost(files) {
      return normalizeDraftMentionedFiles(files).map((file, index) => {
        const item = { uri: file.uri, label: file.label, mentionIndex: index };
        if (file.type === "file" || file.type === "folder") item.type = file.type;
        if (typeof file.insertText === "string") item.insertText = file.insertText;
        return item;
      });
    }

    function hydrateLinkedMentionFiles(files, text) {
      return normalizeDraftMentionedFiles(files).map((file) => {
        if (file.linkedMentionText) return file;
        const mentionText = file.insertText || file.label;
        return mentionText && findLinkedMentionToken(text, mentionText)
          ? { ...file, linkedMentionText: mentionText }
          : file;
      });
    }

    function onComposerInput() {
      if (!restoringPromptHistory) resetPromptHistoryNavigation();
      const mentionsChanged = reconcileLinkedMentionFiles();
      saveComposerDraft();
      if (mentionsChanged) renderMentionChips();
      renderSendButton();
      const trigger = currentComposerTrigger();
      if (!trigger) {
        mentionResults = [];
        suggestionMode = "";
        mentionStatus = "";
        mentionTruncated = false;
        mentionError = "";
        mentionSearched = false;
        renderSuggestions();
        return;
      }
      clearTimeout(searchTimer);
      if (trigger.type === "skill") {
        activeMentionRequestId = 0;
        mentionResults = skillMentionResults(trigger.query);
        suggestionMode = "skill";
        mentionStatus = "";
        mentionError = "";
        mentionTruncated = false;
        mentionSearched = true;
        activeSuggestion = 0;
        renderSuggestions();
        return;
      }
      const requestId = ++mentionRequestId;
      activeMentionRequestId = requestId;
      suggestionMode = "file";
      mentionStatus = "searching";
      mentionError = "";
      mentionSearched = false;
      renderSuggestions();
      searchTimer = setTimeout(() => {
        vscode.postMessage({ type: "searchFilesForMention", query: trigger.query, requestId });
      }, 120);
    }

    function currentComposerTrigger() {
      const input = el("input");
      const before = input.value.slice(0, input.selectionStart);
      const match = /(^|\\s)([@$])([^\\s@$]*)$/.exec(before);
      if (!match) return undefined;
      const marker = match[2];
      return {
        type: marker === "$" ? "skill" : "file",
        marker,
        query: match[3],
        start: before.length - match[3].length - 1,
        end: input.selectionStart
      };
    }

    function currentMention() {
      const trigger = currentComposerTrigger();
      return trigger && trigger.type === "file" ? trigger : undefined;
    }

    function currentSkillMention() {
      const trigger = currentComposerTrigger();
      return trigger && trigger.type === "skill" ? trigger : undefined;
    }

    function skillMentionResults(query) {
      const normalized = normalizeSkillSuggestionText(query);
      return enabledSkillSuggestions()
        .map((skill) => ({ skill, score: skillSuggestionScore(skill, normalized) }))
        .filter((item) => item.score < 100000)
        .sort((left, right) => left.score - right.score || skillSuggestionLabel(left.skill).localeCompare(skillSuggestionLabel(right.skill)))
        .slice(0, 50)
        .map(({ skill }) => ({
          kind: "skill",
          label: skillSuggestionLabel(skill),
          insertText: skillSuggestionInsertText(skill),
          description: skill.description || "",
          meta: skillSuggestionMeta(skill)
        }));
    }

    function enabledSkillSuggestions() {
      const skills = Array.isArray(state.skills && state.skills.available) ? state.skills.available : [];
      return skills.filter((skill) => Boolean(skill && skill.enabled && !skill.invalid && skill.userInvocable !== false));
    }

    function skillSuggestionLabel(skill) {
      return String((skill && (skill.name || skill.commandName || skill.id)) || "skill").trim();
    }

    function skillSuggestionInsertText(skill) {
      return String((skill && (skill.commandName || skill.name || skill.id)) || "skill").trim();
    }

    function skillSuggestionMeta(skill) {
      return [skill.scope, skill.sourceKind, skill.visibility].filter(Boolean).join("/") || "skill";
    }

    function normalizeSkillSuggestionText(value) {
      return String(value || "").trim().toLowerCase().replace(/^[$/]+/, "");
    }

    function skillSuggestionScore(skill, query) {
      const values = [skill.name, skill.commandName, skill.id, skill.description]
        .map((value) => normalizeSkillSuggestionText(value))
        .filter(Boolean);
      if (!query) return 10 + skillSuggestionLabel(skill).length / 1000;
      for (const value of values.slice(0, 3)) {
        if (value === query) return 0;
        if (value.startsWith(query)) return 10 + value.length / 1000;
      }
      for (const value of values) {
        const index = value.indexOf(query);
        if (index !== -1) return 100 + index + value.length / 1000;
      }
      return 100000;
    }

    function selectSuggestion(item) {
      if (item && item.kind === "skill") {
        selectSkillMention(item);
        return;
      }
      selectMention(item);
    }

    function selectSkillMention(skill) {
      const input = el("input");
      const mention = currentSkillMention();
      const insertText = skill && (skill.insertText || skill.label);
      if (mention && insertText) {
        input.value = input.value.slice(0, mention.start) + "$" + insertText + " " + input.value.slice(mention.end);
        const cursor = mention.start + insertText.length + 2;
        input.setSelectionRange(cursor, cursor);
      }
      mentionResults = [];
      suggestionMode = "";
      mentionStatus = "";
      mentionError = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderSuggestions();
      saveComposerDraft();
      renderSendButton();
      input.focus();
    }

    function selectMention(file) {
      const input = el("input");
      const mention = currentMention();
      const insertText = file.insertText || file.label;
      const linkedFile = mention ? { ...file, linkedMentionText: insertText } : file;
      upsertMentionedFile(linkedFile);
      if (mention) {
        input.value = input.value.slice(0, mention.start) + "@" + insertText + " " + input.value.slice(mention.end);
        const cursor = mention.start + insertText.length + 2;
        input.setSelectionRange(cursor, cursor);
      }
      mentionResults = [];
      suggestionMode = "";
      mentionStatus = "";
      mentionError = "";
      mentionTruncated = false;
      mentionSearched = false;
      renderMentionChips();
      renderSuggestions();
      saveComposerDraft();
      renderSendButton();
      input.focus();
    }

    function upsertMentionedFile(file) {
      const index = mentionedFiles.findIndex((item) => item.uri === file.uri);
      if (index === -1) {
        mentionedFiles.push(file);
        return;
      }
      mentionedFiles = mentionedFiles.map((item, itemIndex) => itemIndex === index ? { ...item, ...file } : item);
    }

    function reconcileLinkedMentionFiles() {
      const text = el("input").value;
      const next = [];
      let changed = false;
      for (const file of mentionedFiles) {
        if (file.linkedMentionText && !findLinkedMentionToken(text, file.linkedMentionText)) {
          changed = true;
          continue;
        }
        next.push(file);
      }
      if (changed) mentionedFiles = next;
      return changed;
    }

	    function removeMention(uri, options = {}) {
      const removed = mentionedFiles.find((file) => file.uri === uri);
      if (removed && options.removeLinkedText !== false) removeLinkedMentionTextFromInput(removed);
	      mentionedFiles = mentionedFiles.filter((file) => file.uri !== uri);
	      saveComposerDraft();
	      renderMentionChips();
      renderSendButton();
	    }

    function removeLinkedMentionTextFromInput(file) {
      if (!file || !file.linkedMentionText) return false;
      const input = el("input");
      const match = findLinkedMentionToken(input.value, file.linkedMentionText);
      if (!match) return false;
      const before = input.value.slice(0, match.start);
      let after = input.value.slice(match.end);
      if (after.startsWith(" ")) after = after.slice(1);
      input.value = before + after;
      const cursor = Math.min(match.start, input.value.length);
      input.setSelectionRange(cursor, cursor);
      return true;
    }

    function findLinkedMentionToken(text, mentionText) {
      const needle = "@" + String(mentionText || "");
      if (needle.length <= 1) return undefined;
      let index = String(text || "").indexOf(needle);
      while (index !== -1) {
        const end = index + needle.length;
        if (isMentionTokenBoundary(text[index - 1]) && isMentionTokenBoundary(text[end])) return { start: index, end };
        index = String(text || "").indexOf(needle, index + 1);
      }
      return undefined;
    }

    function isMentionTokenBoundary(char) {
      return !char || /\\s/.test(char);
    }

	    function hasExplicitContext() {
	      return mentionedFiles.length > 0 || contextItems().length > 0;
	    }

      function setMainView(view) {
        const nextView = view === "usage" ? "usage" : "chat";
        if (activeMainView === nextView) return;
        activeMainView = nextView;
        vscode.setState({
          ...webviewState(),
          activeMainView,
          usageActivityMode
        });
        if (activeMainView === "usage") vscode.postMessage({ type: "loadUsageStats" });
        render();
      }

      function onUsagePageClick(event) {
        const backButton = event.target && event.target.closest ? event.target.closest("[data-usage-back-to-chat]") : undefined;
        if (backButton) {
          setMainView("chat");
          return;
        }
        const bucketButton = event.target && event.target.closest ? event.target.closest("[data-usage-bucket-id]") : undefined;
        if (bucketButton) {
          const bucketId = bucketButton.getAttribute("data-usage-bucket-id") || "";
          if (bucketId && selectedUsageBucketId === bucketId) {
            selectedUsageBucketId = "";
            hoveredUsageBucketId = "";
          } else {
            selectedUsageBucketId = bucketId;
            hoveredUsageBucketId = bucketId;
          }
          updateUsageHeatmapSelectionState();
          renderUsageBucketDetail();
          return;
        }
        const modeButton = event.target && event.target.closest ? event.target.closest("[data-usage-mode]") : undefined;
        if (modeButton) {
          usageActivityMode = modeButton.getAttribute("data-usage-mode") || "daily";
          clearUsageBucketInteraction();
          vscode.setState({
            ...webviewState(),
            activeMainView,
            usageActivityMode
          });
          renderUsagePage();
          return;
        }
        const refreshButton = event.target && event.target.closest ? event.target.closest("[data-usage-refresh]") : undefined;
        if (refreshButton) {
          vscode.postMessage({ type: "loadUsageStats" });
        }
      }

      function onUsagePagePointerOver(event) {
        const bucketButton = event.target && event.target.closest ? event.target.closest("[data-usage-bucket-id]") : undefined;
        if (!bucketButton) return;
        const bucketId = bucketButton.getAttribute("data-usage-bucket-id") || "";
        if (!bucketId || hoveredUsageBucketId === bucketId) return;
        hoveredUsageBucketId = bucketId;
        updateUsageHeatmapSelectionState();
        renderUsageBucketDetail();
      }

      function onUsagePageFocusIn(event) {
        const bucketButton = event.target && event.target.closest ? event.target.closest("[data-usage-bucket-id]") : undefined;
        if (!bucketButton) return;
        const bucketId = bucketButton.getAttribute("data-usage-bucket-id") || "";
        if (!bucketId || hoveredUsageBucketId === bucketId) return;
        hoveredUsageBucketId = bucketId;
        updateUsageHeatmapSelectionState();
        renderUsageBucketDetail();
      }

      function onUsagePageFocusOut(event) {
        const related = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest("[data-usage-bucket-id]") : undefined;
        if (related) return;
        if (!hoveredUsageBucketId) return;
        hoveredUsageBucketId = "";
        updateUsageHeatmapSelectionState();
        renderUsageBucketDetail();
      }

      function onUsagePageKeydown(event) {
        if (event.key !== "Escape") return;
        if (!selectedUsageBucketId && !hoveredUsageBucketId) return;
        event.preventDefault();
        event.stopPropagation();
        clearUsageBucketInteraction();
        updateUsageHeatmapSelectionState();
        renderUsageBucketDetail();
      }

      function clearHoveredUsageBucket() {
        if (!hoveredUsageBucketId) return;
        hoveredUsageBucketId = "";
        updateUsageHeatmapSelectionState();
        renderUsageBucketDetail();
      }

      function clearUsageBucketInteraction() {
        hoveredUsageBucketId = "";
        selectedUsageBucketId = "";
      }

	    function render() {
	      renderShell();
	      renderConnection();
	      renderSettings();
	      renderSessions();
        renderNewSessionButton();
	      renderMessages();
        renderUsagePage();
      renderToolApprovalBanner();
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
			        renderContextChips();
			        renderQueuedSendList();
			        renderComposerMoreMenu();
			        renderGoalSummaryBanner();
			        renderGoalResumePrompt();
			      renderComposerInputMode();
		      renderSendButton();
		      renderComposerStatusBar();
			    }

      function requestNewSession() {
        if (newSessionPending) return;
        newSessionPending = true;
        newSessionPendingSourceSessionID = String(state.currentSessionID || "");
        if (newSessionPendingTimer) window.clearTimeout(newSessionPendingTimer);
        newSessionPendingTimer = window.setTimeout(() => {
          clearNewSessionPending();
          renderNewSessionButton();
        }, 8000);
        renderNewSessionButton();
        vscode.postMessage({ type: "newSession" });
      }

      function reconcileNewSessionPending(nextState) {
        if (!newSessionPending) return;
        const nextSessionID = String((nextState && nextState.currentSessionID) || "");
        if (nextSessionID && nextSessionID !== newSessionPendingSourceSessionID) clearNewSessionPending();
      }

      function clearNewSessionPending() {
        newSessionPending = false;
        newSessionPendingSourceSessionID = "";
        if (newSessionPendingTimer) {
          window.clearTimeout(newSessionPendingTimer);
          newSessionPendingTimer = 0;
        }
      }

	      function renderNewSessionButton() {
	        const button = el("newSession");
	        if (!button) return;
        button.disabled = Boolean(newSessionPending);
        button.classList.toggle("is-loading", Boolean(newSessionPending));
        const label = newSessionPending ? "Creating new session" : "New session";
        button.title = label;
	        button.setAttribute("aria-label", label);
	      }

	      function renderComposerInputMode() {
	        const input = el("input");
	        if (!input) return;
	        const active = isGoalInputModeActive();
	        input.placeholder = active ? "Describe the goal..." : "Ask ChipMate…";
	        input.setAttribute("aria-label", active ? "Describe the goal to create" : "Ask ChipMate");
	        const composer = input.closest(".composer");
	        if (composer) composer.classList.toggle("goalInputMode", active);
	      }

		    function renderGoalSummaryBanner() {
		      const button = el("goalSummaryBanner");
		      if (!button) return;
		      const goal = state.goal || null;
	      if (!goal) {
	        button.hidden = true;
	        button.textContent = "";
	        button.setAttribute("aria-expanded", "false");
	        return;
	      }
	      const status = String(goal.status || "active");
	      const operation = state.goalOperation || null;
	      const running = Boolean(operation && operation.active);
	      const kind = goalStatusKind(status);
	      const objective = String(goal.objective || "").trim() || "No objective";
	      const usage = goalSummaryUsage(goal);
	      const label = goalSummaryStatusLabel(status, running);
	      const title = label + ": " + objective + (usage ? " · " + usage : "");
	      button.hidden = false;
	      button.className = "goalSummaryBanner oc-liquid-chip " + kind + (running ? " is-running" : "") + (activeComposerStatusPopover() === "goal" ? " open" : "");
	      button.title = title;
	      button.setAttribute("aria-label", "Current ChipMate goal. " + title);
	      button.setAttribute("aria-expanded", activeComposerStatusPopover() === "goal" ? "true" : "false");
	      button.textContent = "";

	      const icon = document.createElement("span");
	      icon.className = "goalSummaryIcon";
	      icon.setAttribute("aria-hidden", "true");
	      icon.innerHTML = toolbarIconMarkup(STATUS_ICONS.goal);

	      const copy = document.createElement("span");
	      copy.className = "goalSummaryCopy";
	      const text = document.createElement("span");
	      text.className = "goalSummaryText";
	      const statusText = document.createElement("span");
	      statusText.className = "goalSummaryStatus";
	      statusText.textContent = label;
	      const objectiveText = document.createElement("span");
	      objectiveText.className = "goalSummaryObjective";
	      objectiveText.textContent = objective;
	      text.append(statusText, objectiveText);
	      copy.appendChild(text);
	      if (usage) {
	        const meta = document.createElement("span");
	        meta.className = "goalSummaryMeta";
	        meta.textContent = usage;
	        copy.appendChild(meta);
	      }

	      button.append(icon, copy);
	      if (running) {
	        const badge = document.createElement("span");
	        badge.className = "goalSummaryBadge";
	        badge.textContent = String(Math.max(1, Number(operation.turnCount || 1)));
	        badge.title = "Goal operation turn " + formatCount(operation.turnCount || 1);
		        button.appendChild(badge);
		      }
		    }

		    function renderGoalResumePrompt() {
		      const root = el("goalResumePrompt");
		      if (!root) return;
		      const goal = state.goal || null;
		      const status = String((goal && goal.status) || "");
		      const resumable = Boolean(goal && (status === "paused" || status === "blocked" || status === "usage_limited"));
		      if (!resumable) {
		        root.hidden = true;
		        root.textContent = "";
		        return;
		      }
		      const objective = String(goal.objective || "").trim() || "No objective";
		      const label = goalResumePromptTitle(status);
		      root.hidden = false;
		      root.className = "goalResumePrompt oc-liquid-chip " + goalStatusKind(status);
		      root.setAttribute("aria-label", label + ": " + objective);
		      root.textContent = "";

		      const icon = document.createElement("span");
		      icon.className = "goalSummaryIcon";
		      icon.setAttribute("aria-hidden", "true");
		      icon.innerHTML = toolbarIconMarkup(STATUS_ICONS.goal);

		      const copy = document.createElement("span");
		      copy.className = "goalResumeCopy";
		      const title = document.createElement("span");
		      title.className = "goalResumeTitle";
		      title.textContent = label;
		      const objectiveText = document.createElement("span");
		      objectiveText.className = "goalResumeObjective";
		      objectiveText.textContent = objective;
		      copy.append(title, objectiveText);

		      const actions = document.createElement("span");
		      actions.className = "goalResumeActions";
		      actions.append(
		        goalResumeButton("resumeGoal", "Resume", true),
		        goalResumeButton("clearGoal", "Clear", false),
		      );

		      root.append(icon, copy, actions);
		    }

		    function goalResumePromptTitle(status) {
		      if (status === "blocked") return "Goal blocked. Resume when ready.";
		      if (status === "usage_limited") return "Goal paused by usage limit.";
		      return "Goal paused.";
		    }

		    function goalResumeButton(action, label, primary) {
		      const button = document.createElement("button");
		      button.type = "button";
		      button.className = "goalResumeAction oc-liquid-btn" + (primary ? " is-active" : "");
		      button.setAttribute("data-goal-action", action);
		      button.textContent = label;
		      button.title = label + " ChipMate goal";
		      return button;
		    }

		    function goalSummaryStatusLabel(status, running) {
	      if (status === "paused") return "已暂停的目标";
	      if (status === "blocked") return "受阻的目标";
	      if (status === "usage_limited") return "用量受限目标";
	      if (status === "budget_limited") return "预算受限目标";
	      if (status === "complete") return "已完成目标";
	      return running ? "进行中的目标" : "当前目标";
	    }

	    function goalSummaryUsage(goal) {
	      const pieces = [];
	      const tokensUsed = Number(goal && goal.tokensUsed || 0);
	      const tokenBudget = Number(goal && goal.tokenBudget || 0);
	      if (tokenBudget > 0) pieces.push(formatCompactCount(tokensUsed) + "/" + formatCompactCount(tokenBudget) + " tokens");
	      else if (tokensUsed > 0) pieces.push(formatCompactCount(tokensUsed) + " tokens");
	      const timeUsedMs = Number(goal && goal.timeUsedSeconds || 0) * 1000;
	      if (timeUsedMs > 0) pieces.push(formatDuration(timeUsedMs));
	      return pieces.join(" · ");
	    }

			    function renderSendButton() {
			      const goalMode = isGoalInputModeActive();
			      const blockedByGuard = localOnlyAgentBlocked() && !looksLikeExportRequest(el("input").value);
		        const button = el("send");
		        const queueing = Boolean(!goalMode && state.sending && hasComposerDraft());
		        const goalQueueing = Boolean(goalMode && state.sending);
		        const cancellable = Boolean(!goalMode && state.sending && !queueing && state.sendCancellable !== false);
		        const loading = Boolean(!goalMode && state.sending && !queueing && !cancellable);
			      button.disabled = Boolean((!goalMode && !state.sending && blockedByGuard) || (queueing && queueIsFull()) || (goalQueueing && queueIsFull()));
		        const label = goalMode
		          ? (goalQueueing ? "Queue goal" : "Create goal")
		          : blockedByGuard && !state.sending
		          ? "Select an agent before sending"
		          : queueing
	            ? "Queue message"
          : cancellable
            ? "Stop current request"
            : loading
              ? "Sending message"
              : "Send message";
	        button.classList.toggle("is-active", cancellable);
	        button.classList.toggle("is-loading", loading);
	        button.classList.toggle("is-queued", queueing || goalQueueing);
	        setSendButtonContent(button, cancellable ? "stop" : "send", label, loading);
		    }

    function renderToolApprovalBanner() {
      const banner = el("toolApprovalBanner");
      const approvals = pendingToolApprovalsFromMessages(state.messages || []);
      if (approvals.length === 0) {
        banner.className = "toolApprovalBanner";
        banner.setAttribute("aria-hidden", "true");
        banner.removeAttribute("data-tool-approval-banner");
        banner.replaceChildren();
        return;
      }
      const part = approvals[approvals.length - 1];
      banner.className = "toolApprovalBanner is-visible";
      banner.setAttribute("aria-hidden", "false");
      banner.setAttribute("data-tool-approval-banner", part.approvalRequestId);

      const head = document.createElement("div");
      head.className = "toolApprovalBannerHead";
      const main = document.createElement("div");
      main.className = "toolApprovalBannerMain";
      const icon = document.createElement("span");
      icon.className = "toolApprovalBannerIcon";
      icon.setAttribute("aria-hidden", "true");
      appendLiquidIcon(icon, "shield");
      const copy = document.createElement("div");
      copy.className = "toolApprovalBannerCopy";
      const title = document.createElement("div");
      title.className = "toolApprovalBannerTitle";
      title.textContent = "需要批准工具调用";
      const summary = document.createElement("div");
      summary.className = "toolApprovalBannerSummary";
      summary.textContent = toolApprovalBannerSummary(part);
      summary.title = summary.textContent;
      copy.append(title, summary);
      main.append(icon, copy);
      const count = document.createElement("span");
      count.className = "toolApprovalBannerCount";
      count.textContent = approvals.length > 1 ? String(approvals.length) + " 个待审批" : "Risk: " + (part.approvalRisk || "unknown");
      head.append(main, count);

      const actions = document.createElement("div");
      actions.className = "toolApprovalBannerActions";
      actions.append(
        toolApprovalButton(part.approvalRequestId, true, "批准一次", true),
        toolApprovalButton(part.approvalRequestId, false, "拒绝", false),
        toolApprovalFocusButton(part.approvalRequestId),
      );
      banner.replaceChildren(head, actions);
    }

    function pendingToolApprovalsFromMessages(messages) {
      const approvals = [];
      for (const message of messages || []) {
        for (const part of message.parts || []) {
          if (part && part.type === "tool" && isPendingToolApproval(part)) approvals.push(part);
        }
      }
      return approvals;
    }

    function toolApprovalBannerSummary(part) {
      const title = part.approvalTitle || part.title || "Tool approval";
      const summary = part.approvalSummary || "ChipMate is waiting for permission to continue.";
      return title + " · " + summary;
    }

    function renderShell() {
      const widthClass = window.innerWidth >= 760 ? "history-wide" : "history-narrow";
      const mode = currentViewMode();
      el("app").className = "app mode-" + mode + " " + (historyOpen ? "history-open" : "history-closed") + " " + widthClass;
      const chatActive = activeMainView !== "usage";
      const messages = el("messages");
      const usagePage = el("usagePage");
      const composer = document.querySelector(".composerWrap");
      const chatMain = document.querySelector(".chatMain");
      if (chatMain) {
        chatMain.classList.toggle("view-chat", chatActive);
        chatMain.classList.toggle("view-usage", !chatActive);
      }
      messages.hidden = !chatActive;
      usagePage.hidden = chatActive;
      if (composer) composer.hidden = !chatActive;
      el("jumpLatest").hidden = !chatActive;
      if (!chatActive) el("jumpLatest").classList.remove("visible");
      if (!chatActive && state.connectionState === "connected" && !state.loadingUsageStats && !state.usageStats) {
        vscode.postMessage({ type: "loadUsageStats" });
      }
    }

    function currentViewMode() {
      if (settingsOpen) return "settings-page";
      return (state.connectionState || "disconnected") === "connected" ? "chat" : "connection-only";
    }

    function renderUsagePage() {
      const root = el("usagePageContent");
      if (!root) return;
      root.textContent = "";
      root.className = "";
      const header = usageHeaderNode(state.usageStats || null);
      if (state.loadingUsageStats) {
        root.className = "usageActivityPanel";
        root.append(header, usageStatePanel("sparkle", "Loading usage", "Reading the local Chat usage ledger."));
        return;
      }
      if (state.usageStatsError) {
        root.className = "usageActivityPanel";
        root.append(header, usageStatePanel("diagnostics", "用量暂不可用", state.usageStatsError));
        return;
      }
      const stats = state.usageStats;
      if (!stats || !stats.hasData) {
        root.className = "usageActivityPanel";
        root.append(header, usageStatePanel("sparkle", "暂无对话令牌活动", "新的对话回复会记录到本地。Provider 返回的用量会标记为真实统计；本地回退估算会标记为估算统计。"));
        return;
      }
      root.className = "usageActivityPanel";
      root.append(header, usageSummaryNode(stats), usageActivityNode(stats));
    }

    function usageStatePanel(iconName, titleText, copyText) {
      const panel = document.createElement("div");
      panel.className = "usageState";
      panel.appendChild(usageStateNode(iconName, titleText, copyText));
      return panel;
    }

    function usageStateNode(iconName, titleText, copyText) {
      const inner = document.createElement("div");
      inner.className = "usageStateInner";
      const icon = document.createElement("div");
      icon.className = "usageStateIcon";
      icon.setAttribute("aria-hidden", "true");
      appendLiquidIcon(icon, iconName);
      const title = document.createElement("div");
      title.className = "usageStateTitle";
      title.textContent = titleText;
      const copy = document.createElement("div");
      copy.className = "usageStateCopy";
      copy.textContent = copyText;
      inner.append(icon, title, copy);
      return inner;
    }

    function usageHeaderNode(stats) {
      const header = document.createElement("div");
      header.className = "usageHeader";
      const titleBlock = document.createElement("div");
      titleBlock.className = "usageTitleBlock";
      const title = document.createElement("div");
      title.className = "usageTitle";
      title.textContent = "对话令牌活动";
      const subtitle = document.createElement("div");
      subtitle.className = "usageSubtitle";
      subtitle.textContent = stats ? usageHeaderSubtitle(stats) : "本地账本 · 仅统计对话 · 本地历史";
      titleBlock.append(title, subtitle);
      const actions = document.createElement("div");
      actions.className = "usageHeaderActions";
      const back = document.createElement("button");
      back.className = "usageBackToChat oc-icon-btn oc-liquid-btn";
      back.type = "button";
      back.setAttribute("data-usage-back-to-chat", "true");
      setIconOnlyButton(back, "closePanel", "返回 Chat");
      const refresh = document.createElement("button");
      refresh.className = "usageRefresh oc-icon-btn oc-liquid-btn";
      refresh.type = "button";
      refresh.setAttribute("data-usage-refresh", "true");
      setIconOnlyButton(refresh, "refresh", "刷新用量统计");
      actions.append(back, refresh);
      header.append(titleBlock, actions);
      return header;
    }

    function usageHeaderSubtitle(stats) {
      const generated = stats.generatedAt ? "更新于 " + formatDateTime(stats.generatedAt) : "本地账本";
      const range = stats.rangeDays ? "最近 " + stats.rangeDays + " 天" : "本地历史";
      return generated + " · 仅统计对话 · " + range;
    }

    function usageSummaryNode(stats) {
      const summary = stats.summary || {};
      const strip = document.createElement("div");
      strip.className = "usageMetricStrip";
      strip.append(
        usageMetricNode(formatTokenCount(summary.totalTokens), "累计令牌", usageReportedEstimatedLabel(summary)),
        usageMetricNode(formatTokenCount(summary.peakDayTokens), "峰值日期", summary.peakDay ? shortDateLabel(summary.peakDay) : "暂无峰值"),
        usageMetricNode(summary.longestTaskMs ? formatTaskDuration(summary.longestTaskMs) : "0秒", "最长任务", "单次对话回复"),
        usageMetricNode(String(summary.currentStreakDays || 0), "当前连续", "活跃天数"),
        usageMetricNode(String(summary.longestStreakDays || 0), "最长连续", formatCount(summary.recordedResponses || 0) + " 次回复"),
      );
      return strip;
    }

    function usageReportedEstimatedLabel(summary) {
      const reported = Number(summary.reportedTokens || 0);
      const estimated = Number(summary.estimatedTokens || 0);
      if (!reported && !estimated) return "暂无用量";
      if (!estimated) return "真实统计";
      if (!reported) return "估算统计";
      return formatTokenCount(reported) + " 真实统计 · " + formatTokenCount(estimated) + " 估算统计";
    }

    function usageMetricNode(value, label, detail) {
      const node = document.createElement("div");
      node.className = "usageMetric";
      const valueNode = document.createElement("div");
      valueNode.className = "usageMetricValue";
      valueNode.textContent = value;
      valueNode.title = value;
      const labelNode = document.createElement("div");
      labelNode.className = "usageMetricLabel";
      labelNode.textContent = label;
      const detailNode = document.createElement("div");
      detailNode.className = "usageMetricDetail";
      detailNode.textContent = detail || "";
      detailNode.title = detail || "";
      node.append(valueNode, labelNode, detailNode);
      return node;
    }

    function usageActivityNode(stats) {
      const panel = document.createElement("section");
      panel.className = "usageActivityPanel";
      const head = document.createElement("div");
      head.className = "usageActivityHead";
      const titleBlock = document.createElement("div");
      titleBlock.className = "usageTitleBlock";
      const title = document.createElement("div");
      title.className = "sectionTitle";
      title.textContent = "令牌活动";
      const subtitle = document.createElement("div");
      subtitle.className = "usageSubtitle";
      subtitle.textContent = usageActivitySubtitle(stats);
      titleBlock.append(title, subtitle);
      head.append(titleBlock, usageModeTabsNode());

      const wrap = document.createElement("div");
      wrap.className = "usageHeatmapWrap";
      const display = usageDisplayData(stats);
      if (usageActivityMode === "daily") wrap.appendChild(usageCalendarScrollerNode(display));
      else wrap.appendChild(usageHeatmapNode(display.entries, display));
      wrap.appendChild(usageBucketDetailNode());
      wrap.appendChild(usageHeatLegendNode());
      wrap.appendChild(usageBreakdownNode(stats));
      panel.append(head, wrap);
      return panel;
    }

    function usageActivitySubtitle(stats) {
      const buckets = usageBucketsForMode(stats);
      const active = buckets.filter((bucket) => Number(bucket && bucket.total) > 0).length;
      const label = usageActivityMode === "daily" ? "个活跃日" : usageActivityMode === "weekly" ? "个活跃周" : "个统计点";
      return formatCount(active) + label + " · 估算单元格使用虚线边框";
    }

    function usageModeTabsNode() {
      const tabs = document.createElement("div");
      tabs.className = "usageModeTabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "用量统计粒度");
      for (const item of [
        ["daily", "每日"],
        ["weekly", "每周"],
        ["cumulative", "累计"],
      ]) {
        const mode = item[0];
        const button = document.createElement("button");
        button.className = "usageModeTab oc-chip oc-liquid-chip" + (usageActivityMode === mode ? " is-active" : "");
        button.type = "button";
        button.setAttribute("data-usage-mode", mode);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", usageActivityMode === mode ? "true" : "false");
        button.textContent = item[1];
        tabs.appendChild(button);
      }
      return tabs;
    }

    function usageBucketsForMode(stats) {
      const mode = usageActivityMode === "weekly" ? "weekly" : usageActivityMode === "cumulative" ? "cumulative" : "daily";
      const buckets = stats && Array.isArray(stats[mode]) ? stats[mode] : [];
      return buckets.filter(Boolean);
    }

    function usageDisplayData(stats) {
      const buckets = usageBucketsForMode(stats);
      if (usageActivityMode === "daily") return usageDailyCalendarData(buckets);
      const entries = buckets.map((bucket) => usageBucketEntry(bucket));
      syncUsageBucketLookup(entries);
      return {
        entries,
        weekCount: Math.max(1, entries.length),
        monthAnchors: [],
      };
    }

    function usageDailyCalendarData(buckets) {
      const sorted = buckets.slice().sort((left, right) => Number(left && left.startAt) - Number(right && right.startAt));
      if (sorted.length === 0) {
        syncUsageBucketLookup([]);
        return {
          entries: [],
          weekCount: 1,
          monthAnchors: [],
        };
      }
      const firstBucket = sorted[0];
      const lastBucket = sorted[sorted.length - 1];
      const calendarStart = startOfUsageWeekMonday(firstBucket.startAt);
      const calendarEnd = endOfUsageWeekSunday(Math.max(lastBucket.endAt - 1, lastBucket.startAt));
      const bucketByKey = new Map(sorted.map((bucket) => [bucket.key, bucket]));
      const entries = [];
      for (let time = calendarStart; time <= calendarEnd; time += USAGE_DAY_MS) {
        const key = usageDayKey(time);
        const bucket = bucketByKey.get(key);
        entries.push(usageBucketEntry(bucket || emptyUsageCalendarBucket(time), !bucket));
      }
      const weekCount = Math.max(1, Math.ceil(entries.length / 7));
      const monthAnchors = usageMonthAnchors(firstBucket.startAt, lastBucket.startAt, calendarStart);
      syncUsageBucketLookup(entries);
      return {
        entries,
        weekCount,
        monthAnchors,
      };
    }

    function usageMonthAnchors(firstVisibleTime, lastVisibleTime, calendarStart) {
      const anchors = [];
      const firstVisibleDay = startOfUsageDay(firstVisibleTime);
      const lastVisibleDay = startOfUsageDay(lastVisibleTime);
      const firstDate = new Date(firstVisibleDay);
      let year = firstDate.getFullYear();
      let month = firstDate.getMonth();
      while (true) {
        const monthStart = new Date(year, month, 1).getTime();
        const anchorTime = anchors.length === 0 ? firstVisibleDay : monthStart;
        if (anchorTime > lastVisibleDay) break;
        const column = usageCalendarWeekColumn(anchorTime, calendarStart);
        anchors.push({
          key: String(year) + "-" + String(month + 1).padStart(2, "0"),
          label: usageMonthShortLabel(anchorTime),
          column,
        });
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
      }
      return anchors;
    }

    function usageCalendarWeekColumn(time, calendarStart) {
      return Math.max(0, Math.floor((startOfUsageWeekMonday(time) - calendarStart) / (USAGE_DAY_MS * 7)));
    }

    function usageCalendarScrollerNode(display) {
      const scroller = document.createElement("div");
      scroller.className = "usageCalendarScroller";
      const inner = document.createElement("div");
      inner.className = "usageCalendarInner";
      inner.append(usageMonthTrackNode(display), usageHeatmapNode(display.entries, display));
      scroller.appendChild(inner);
      return scroller;
    }

    function usageMonthTrackNode(display) {
      const track = document.createElement("div");
      track.className = "usageMonthTrack";
      track.setAttribute("aria-hidden", "true");
      track.style.gridTemplateColumns = "repeat(" + Math.max(1, Number(display && display.weekCount) || 1) + ", var(--usage-cell-size))";
      for (const anchor of display && Array.isArray(display.monthAnchors) ? display.monthAnchors : []) {
        const label = document.createElement("span");
        label.className = "usageMonthLabel";
        label.textContent = anchor.label;
        label.style.gridColumn = String(Math.max(1, Number(anchor.column) + 1));
        track.appendChild(label);
      }
      return track;
    }

    function usageHeatmapNode(entries, options = {}) {
      const grid = document.createElement("div");
      grid.className = "usageHeatmapGrid " + usageActivityMode;
      grid.setAttribute("aria-label", "令牌用量热力图");
      if (usageActivityMode === "daily") {
        grid.style.gridTemplateColumns = "repeat(" + Math.max(1, Number(options.weekCount) || 1) + ", var(--usage-cell-size))";
      }
      const buckets = Array.isArray(entries) ? entries.map((entry) => entry.bucket) : [];
      const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket && bucket.total) || 0));
      for (const entry of Array.isArray(entries) ? entries : []) {
        const bucket = entry.bucket;
        const level = usageBucketLevel(bucket, maxTotal);
        const cell = document.createElement("button");
        cell.className = "usageHeatCell level-" + level + (Number(bucket.estimatedTotal || 0) > 0 ? " estimated" : "");
        cell.type = "button";
        cell.setAttribute("aria-label", usageBucketTitle(bucket));
        cell.setAttribute("data-usage-bucket-id", entry.id);
        cell.setAttribute("aria-pressed", selectedUsageBucketId === entry.id ? "true" : "false");
        cell.classList.toggle("is-preview", hoveredUsageBucketId === entry.id && selectedUsageBucketId !== entry.id);
        cell.classList.toggle("is-active", selectedUsageBucketId === entry.id);
        grid.appendChild(cell);
      }
      return grid;
    }

    function usageBucketLevel(bucket, maxTotal) {
      const total = Number(bucket && bucket.total) || 0;
      if (total <= 0) return 0;
      return Math.max(1, Math.min(5, Math.ceil((total / Math.max(1, maxTotal)) * 5)));
    }

    function usageBucketTitle(bucket) {
      const total = Number(bucket && bucket.total) || 0;
      const parts = [
        usageBucketLabel(bucket),
        formatTokenCount(total) + " 令牌",
        formatCount(bucket && bucket.count) + " 次回复",
        formatTokenCount(bucket && bucket.reportedTotal) + " 真实统计",
        formatTokenCount(bucket && bucket.estimatedTotal) + " 估算统计",
      ];
      return parts.filter(Boolean).join(" · ");
    }

    function usageBucketLabel(bucket) {
      if (!bucket) return "用量分桶";
      if (usageActivityMode === "daily") return formatUsageDayLabel(bucket.startAt);
      if (usageActivityMode === "weekly") return formatUsageRangeLabel(bucket.startAt, Math.max((bucket.endAt || bucket.startAt) - 1, bucket.startAt));
      if (usageActivityMode === "cumulative") return "截至 " + formatUsageDayLabel(Math.max((bucket.endAt || bucket.startAt) - 1, bucket.startAt));
      return bucket.label || bucket.key || "用量分桶";
    }

    function usageBucketEntry(bucket, placeholder = false) {
      return {
        id: usageBucketSelectionId(bucket),
        bucket,
        placeholder: Boolean(placeholder),
      };
    }

    function usageBucketSelectionId(bucket) {
      const safeBucket = bucket || emptyUsageCalendarBucket(Date.now());
      return usageActivityMode + ":" + String(safeBucket.key || "") + ":" + String(safeBucket.startAt || 0) + ":" + String(safeBucket.endAt || 0);
    }

    function emptyUsageCalendarBucket(time) {
      const startAt = startOfUsageDay(time);
      return {
        key: usageDayKey(startAt),
        label: usageDayKey(startAt),
        startAt,
        endAt: startAt + USAGE_DAY_MS,
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reportedTotal: 0,
        estimatedTotal: 0,
        count: 0,
        reportedCount: 0,
        estimatedCount: 0,
      };
    }

    function usageDayKey(time) {
      const date = new Date(startOfUsageDay(time));
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return String(year) + "-" + month + "-" + day;
    }

    function startOfUsageDay(time) {
      const date = new Date(time);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    function startOfUsageWeekMonday(time) {
      const start = startOfUsageDay(time);
      const date = new Date(start);
      const day = date.getDay();
      const offset = day === 0 ? 6 : day - 1;
      return start - offset * USAGE_DAY_MS;
    }

    function endOfUsageWeekSunday(time) {
      return startOfUsageWeekMonday(time) + 6 * USAGE_DAY_MS;
    }

    function usageMonthShortLabel(time) {
      const date = new Date(time);
      return String(date.getMonth() + 1) + "月";
    }

    function syncUsageBucketLookup(entries) {
      usageBucketLookup = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
      if (selectedUsageBucketId && !usageBucketLookup.has(selectedUsageBucketId)) selectedUsageBucketId = "";
      if (hoveredUsageBucketId && !usageBucketLookup.has(hoveredUsageBucketId)) hoveredUsageBucketId = "";
    }

    function usageBucketDetailNode() {
      const card = document.createElement("section");
      card.id = "usageBucketDetail";
      card.className = "usageDetailCard is-empty";
      renderUsageBucketDetail(card);
      return card;
    }

    function renderUsageBucketDetail(node) {
      const card = node || el("usageBucketDetail");
      if (!card) return;
      card.textContent = "";
      const entry = currentUsageBucketEntry();
      if (!entry) {
        card.className = "usageDetailCard is-empty";
        const title = document.createElement("div");
        title.className = "usageDetailTitle";
        title.textContent = "选择一个统计点";
        const hint = document.createElement("div");
        hint.className = "usageDetailHint";
        hint.textContent = "悬停、聚焦或点击上方格子，查看该日、该周或该累计点的详细令牌数据。";
        card.append(title, hint);
        return;
      }
      const bucket = entry.bucket;
      card.className = "usageDetailCard";
      const header = document.createElement("div");
      header.className = "usageDetailHeader";
      const title = document.createElement("div");
      title.className = "usageDetailTitle";
      title.textContent = usageBucketLabel(bucket);
      const meta = document.createElement("div");
      meta.className = "usageDetailMeta";
      meta.textContent = selectedUsageBucketId === entry.id ? "已固定" : "悬停预览";
      header.append(title, meta);
      const hint = document.createElement("div");
      hint.className = "usageDetailHint";
      hint.textContent = formatTokenCount(bucket.reportedTotal || 0) + " 真实统计 · " + formatTokenCount(bucket.estimatedTotal || 0) + " 估算统计";
      const grid = document.createElement("div");
      grid.className = "usageDetailGrid";
      grid.append(
        usageDetailMetricNode("总令牌", formatTokenCount(bucket.total || 0)),
        usageDetailMetricNode("回复数", formatCount(bucket.count || 0)),
        usageDetailMetricNode("真实统计", formatTokenCount(bucket.reportedTotal || 0)),
        usageDetailMetricNode("估算统计", formatTokenCount(bucket.estimatedTotal || 0)),
        usageDetailMetricNode("输入", formatTokenCount(bucket.input || 0)),
        usageDetailMetricNode("输出", formatTokenCount(bucket.output || 0)),
        usageDetailMetricNode("推理", formatTokenCount(bucket.reasoning || 0)),
        usageDetailMetricNode("缓存读", formatTokenCount(bucket.cacheRead || 0)),
        usageDetailMetricNode("缓存写", formatTokenCount(bucket.cacheWrite || 0)),
      );
      card.append(header, hint, grid);
    }

    function usageDetailMetricNode(label, value) {
      const item = document.createElement("div");
      item.className = "usageDetailMetric";
      const labelNode = document.createElement("div");
      labelNode.className = "usageDetailMetricLabel";
      labelNode.textContent = label;
      const valueNode = document.createElement("div");
      valueNode.className = "usageDetailMetricValue";
      valueNode.textContent = value;
      item.append(labelNode, valueNode);
      return item;
    }

    function currentUsageBucketEntry() {
      if (hoveredUsageBucketId && usageBucketLookup.has(hoveredUsageBucketId)) return usageBucketLookup.get(hoveredUsageBucketId);
      if (selectedUsageBucketId && usageBucketLookup.has(selectedUsageBucketId)) return usageBucketLookup.get(selectedUsageBucketId);
      return undefined;
    }

    function updateUsageHeatmapSelectionState() {
      const root = el("usagePage");
      if (!root) return;
      for (const cell of Array.from(root.querySelectorAll("[data-usage-bucket-id]"))) {
        const bucketId = cell.getAttribute("data-usage-bucket-id") || "";
        const active = Boolean(selectedUsageBucketId) && selectedUsageBucketId === bucketId;
        const preview = Boolean(hoveredUsageBucketId) && hoveredUsageBucketId === bucketId && !active;
        cell.classList.toggle("is-active", active);
        cell.classList.toggle("is-preview", preview);
        cell.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }

    function formatUsageDayLabel(time) {
      const date = new Date(startOfUsageDay(time));
      return String(date.getFullYear()) + "年" + String(date.getMonth() + 1) + "月" + String(date.getDate()) + "日";
    }

    function formatUsageRangeLabel(startAt, endAt) {
      return formatUsageDayLabel(startAt) + " - " + formatUsageDayLabel(endAt);
    }

    function usageHeatLegendNode() {
      const legend = document.createElement("div");
      legend.className = "usageHeatLegend";
      const low = document.createElement("span");
      low.textContent = "少";
      const swatches = document.createElement("span");
      swatches.className = "usageLegendSwatches";
      for (let level = 0; level <= 5; level += 1) {
        const swatch = document.createElement("span");
        swatch.className = "usageLegendSwatch level-" + level;
        swatch.setAttribute("aria-hidden", "true");
        swatches.appendChild(swatch);
      }
      const high = document.createElement("span");
      high.textContent = "多";
      legend.append(low, swatches, high);
      return legend;
    }

    function usageBreakdownNode(stats) {
      const summary = stats.summary || {};
      const line = document.createElement("div");
      line.className = "usageBreakdown";
      line.append(
        usageBreakdownItem("reported", formatCount(summary.reportedResponses || 0) + " 次真实回复"),
        usageBreakdownItem("estimated", formatCount(summary.estimatedResponses || 0) + " 次估算回复"),
      );
      return line;
    }

    function usageBreakdownItem(kind, label) {
      const item = document.createElement("span");
      item.className = "usageBreakdownItem";
      const dot = document.createElement("span");
      dot.className = "usageDot " + kind;
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = label;
      item.append(dot, text);
      return item;
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
	      const provider = state.provider || {};
	      if (!userEditedCompletionSettings) {
	        el("completionEnabled").checked = Boolean(completion.enabled);
	        el("completionProviderMode").value = completion.providerMode || "inherit-chat";
		        el("completionProvider").value = completion.provider || "qwen-direct";
	        el("completionProfile").value = completion.profile || "qwen-coder-fim";
	        el("completionApiBaseUrl").value = completion.providerMode === "custom" ? (completion.apiBaseUrl || "") : (provider.apiBaseUrl || state.serverUrl || "");
	        el("completionApiKey").value = "";
	        el("completionMaxTokens").value = String(completion.maxTokens || 128);
	        el("completionContextLength").value = String(completion.contextLength ?? 200000);
	        el("completionTemperature").value = String(completion.temperature ?? 0.1);
	        el("completionTopP").value = String(completion.topP ?? 1);
	      }
	      const direct = el("completionProvider").value !== "none";
	      const customProvider = el("completionProviderMode").value === "custom";
	      const modelState = renderCompletionModelSelect(completion.model || "qwen-coder-30b0");
	      const unavailable = direct && !modelState.available;
	      el("completionDirectFields").className = "completionDirectFields" + (direct ? "" : " hidden");
	      el("completionApiBaseUrl").disabled = !direct || !customProvider;
	      el("completionApiKey").disabled = !direct || !customProvider;
	      el("completionApiBaseUrl").placeholder = customProvider ? "http://localhost:8000/v1" : "Inherited from chat provider";
	      el("completionApiKey").placeholder = customProvider ? "Leave empty to keep existing key or use chat key" : "Using chat provider key";
	      el("completionModel").disabled = !direct || unavailable;
	      el("saveCompletionSettings").disabled = unavailable;
	      el("testCompletionApi").disabled = !direct || unavailable;
	      el("refreshCompletionModels").disabled = Boolean(state.loadingCompletionModels);
	      el("resetCompletionProvider").disabled = !direct && (completion.providerMode || "inherit-chat") === "inherit-chat";
	      if (direct && state.loadingCompletionModels && !modelState.available) {
	        renderCompletionStatus("Refreshing completion models...", "info");
	      } else if (state.completionModelError) {
	        renderCompletionStatus(state.completionModelError, "error");
	      } else if (unavailable) {
	        renderCompletionStatus("无可用补全模型，补全暂不可用", "error");
	      } else {
	        renderCompletionStatus("", "info");
	      }
	    }

	    function renderCompletionModelSelect(savedModel) {
	      const select = el("completionModel");
	      const profile = el("completionProfile").value || "qwen-coder-fim";
	      const candidates = completionCandidateModels(profile, savedModel);
	      const current = (select.value || savedModel || "").trim();
	      const selected = candidates.some((model) => completionModelId(model) === current)
	        ? current
	        : candidates.length
	          ? completionModelId(candidates[0])
	          : "";
	      select.innerHTML = "";
	      if (candidates.length) {
	        for (const model of candidates) {
	          select.appendChild(modelOption(completionModelId(model), completionModelLabel(model)));
	        }
	      } else {
	        select.appendChild(modelOption("", state.loadingCompletionModels ? completionLoadingLabel(profile) : noCompletionModelLabel(profile)));
	      }
	      select.value = selected;
	      return { available: candidates.length > 0, selected };
	    }

	    function completionModelUnavailable() {
	      const profile = el("completionProfile").value || "qwen-coder-fim";
	      return el("completionProvider").value !== "none" && completionCandidateModels(profile, el("completionModel").value).length === 0;
	    }

	    function completionCandidateModels(profile, savedModel) {
	      const seen = new Set();
	      const models = state.completionModelsLoaded ? (state.completionModels || []) : (state.models || []);
	      const candidates = models
	        .filter((model) => {
	          if (!model || model.source !== "provider") return false;
	          const id = completionModelId(model);
	          if (!id || seen.has(id)) return false;
	          const text = [model.id, model.name, model.modelID].filter(Boolean).join(" ").toLowerCase();
	          if (!completionModelMatchesProfile(text, profile)) return false;
	          seen.add(id);
	          return true;
	        })
	        .sort((left, right) => (left.providerIndex ?? 1e9) - (right.providerIndex ?? 1e9));
	      const configured = String(savedModel || "").trim();
	      if (configured && !seen.has(configured) && completionModelMatchesProfile(configured.toLowerCase(), profile)) {
	        candidates.push({ id: configured, name: configured, modelID: configured, source: "configured", providerIndex: 1e9 });
	      }
	      return candidates;
	    }

	    function completionModelMatchesProfile(text, profile) {
	      if (profile === "deepseek-fim") return text.includes("deepseek");
	      return text.includes("qwen") && text.includes("coder");
	    }

	    function completionLoadingLabel(profile) {
	      return profile === "deepseek-fim" ? "Loading DeepSeek FIM models..." : "Loading Qwen Coder models...";
	    }

	    function noCompletionModelLabel(profile) {
	      return profile === "deepseek-fim" ? "No DeepSeek FIM completion model" : "No Qwen Coder completion model";
	    }

	    function completionModelId(model) {
	      return String((model && (model.id || model.modelID || model.name)) || "");
	    }

	    function completionModelLabel(model) {
	      const name = model && (model.name || model.modelID || model.id);
	      const id = completionModelId(model);
	      return name && name !== id ? name + " · " + id : id;
	    }

      function renderCompletionStatus(message, status) {
	      const detail = el("completionDetail");
	      detail.className = "detail " + detailStatusClass(status) + (message ? "visible" : "");
	      detail.textContent = message || "";
	    }

      function skillDetailKey(skill, index) {
        const raw = String((skill && (skill.id || skill.name || skill.commandName)) || "skill-" + index).trim().toLowerCase();
        const normalized = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        return normalized ? normalized + "-" + index : "skill-" + index;
      }

      function skillDetailDomId(detailKey) {
        return "skill-detail-" + detailKey;
      }

      function toggleSkillDetail(detailKey) {
        expandedSkillDetailId = expandedSkillDetailId === detailKey ? "" : detailKey;
        syncSkillDetailExpansion();
      }

      function syncSkillDetailExpansion(root) {
        const container = root && root.querySelectorAll ? root : el("skillsList");
        if (!container || !container.querySelectorAll) return;
        let matched = false;
        const items = Array.from(container.querySelectorAll("[data-skill-detail-key]"));
        for (const item of items) {
          const detailKey = item.getAttribute("data-skill-detail-key") || "";
          const open = Boolean(expandedSkillDetailId) && detailKey === expandedSkillDetailId;
          if (open) matched = true;
          item.classList.toggle("is-expanded", open);
          const button = item.querySelector("[data-skill-detail-toggle]");
          if (button) {
            button.classList.toggle("is-active", open);
            button.setAttribute("aria-expanded", open ? "true" : "false");
            button.textContent = open ? "收起" : "详情";
            button.title = open ? "收起 skill 详情" : "展开 skill 详情";
          }
          const panel = item.querySelector("[data-skill-detail-panel]");
          if (panel) panel.hidden = !open;
        }
        if (expandedSkillDetailId && !matched) expandedSkillDetailId = "";
      }

      function renderSkillsSettings() {
        const skills = Array.isArray(state.skills && state.skills.available) ? state.skills.available : [];
        const enabled = new Set(Array.isArray(state.skills && state.skills.enabled) ? state.skills.enabled : []);
        const list = el("skillsList");
        list.textContent = "";
        const enabledCount = skills.filter((skill) => skill && skill.enabled).length;
        const invalidCount = skills.filter((skill) => skill && skill.invalid).length;
        el("skillsSettingsStatus").textContent = skills.length ? enabledCount + "/" + skills.length + " enabled" + (invalidCount ? " · " + invalidCount + " invalid" : "") : "No skills";
        if (!skills.length) {
          expandedSkillDetailId = "";
          const empty = document.createElement("div");
          empty.className = "comingSoonText";
          empty.textContent = "No skills found. Import SKILL.md files or add them under ~/.agents/skills/<name>/, workspace .agents/skills/<name>/, or .claude/skills/<name>/.";
          list.appendChild(empty);
          return;
        }
        skills.forEach((skill, index) => {
          const detailKey = skillDetailKey(skill, index);
          const detailId = skillDetailDomId(detailKey);
          const open = detailKey === expandedSkillDetailId;
          const item = document.createElement("div");
          item.className = "skillItem" + (open ? " is-expanded" : "");
          item.setAttribute("data-skill-detail-key", detailKey);
          const summary = document.createElement("div");
          summary.className = "skillSummaryRow";
          const label = document.createElement("label");
          label.className = "skillToggle";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(skill.enabled || enabled.has(skill.id) || enabled.has(skill.name) || enabled.has(skill.commandName));
          checkbox.disabled = Boolean(skill.invalid);
          checkbox.setAttribute("data-skill-id", skill.id || skill.name);
          const main = document.createElement("span");
          main.className = "skillMain";
          const name = document.createElement("span");
          name.className = "skillName";
          name.textContent = skill.name || skill.id || "Skill";
          const source = [skill.scope, skill.sourceKind, skill.visibility].filter(Boolean).join("/");
          main.append(name);
          label.append(checkbox, main);
          const button = document.createElement("button");
          button.type = "button";
          button.className = "skillDetailToggle oc-liquid-btn" + (open ? " is-active" : "");
          button.textContent = open ? "收起" : "详情";
          button.title = open ? "收起 skill 详情" : "展开 skill 详情";
          button.setAttribute("data-skill-detail-toggle", detailKey);
          button.setAttribute("aria-controls", detailId);
          button.setAttribute("aria-expanded", open ? "true" : "false");
          button.addEventListener("click", () => toggleSkillDetail(detailKey));
          summary.append(label, button);
          item.appendChild(summary);
          const panel = document.createElement("div");
          panel.id = detailId;
          panel.className = "skillDetailPanel";
          panel.hidden = !open;
          panel.setAttribute("data-skill-detail-panel", "true");
          const description = document.createElement("span");
          description.className = "skillDescription";
          description.textContent = skill.description || "No description.";
          panel.appendChild(description);
          const meta = document.createElement("span");
          meta.className = "skillMeta";
          meta.textContent = (skill.path || ".agents/skills") + (source ? " · " + source : "");
          panel.appendChild(meta);
          if (Array.isArray(skill.allowedTools) && skill.allowedTools.length) {
            const tools = document.createElement("span");
            tools.className = "skillMeta";
            tools.textContent = "allowed-tools: " + skill.allowedTools.join(", ");
            panel.appendChild(tools);
          }
          if (Array.isArray(skill.validationErrors) && skill.validationErrors.length) {
            const errors = document.createElement("span");
            errors.className = "skillMeta skillMetaError";
            errors.textContent = "invalid: " + skill.validationErrors.join("; ");
            panel.appendChild(errors);
          }
          if (Array.isArray(skill.validationWarnings) && skill.validationWarnings.length) {
            const warnings = document.createElement("span");
            warnings.className = "skillMeta skillMetaWarning";
            warnings.textContent = "warnings: " + skill.validationWarnings.join("; ");
            panel.appendChild(warnings);
          }
          item.appendChild(panel);
          list.appendChild(item);
        });
        syncSkillDetailExpansion(list);
      }

      function renderSkillsStatus(message, status) {
        const detail = el("skillsDetail");
        detail.className = "detail " + detailStatusClass(status) + " visible";
        detail.textContent = message || "Skills are discovered from workspace and user .agents/skills/*/SKILL.md.";
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
          renderRagRebuildControl();
				    if (statusText && !statusText.startsWith("RAG not configured")) renderRagStatus(statusText, statusText.includes("unavailable") ? "error" : "info");
	          else renderRagStatus("", "info");
			    }

	    function renderRagStatus(message, status) {
	      const detail = el("ragDetail");
	      detail.className = "detail " + detailStatusClass(status) + (message ? "visible" : "");
	      detail.textContent = message || "";
	    }

      function renderRagRebuildControl() {
        const button = el("forceRebuildCodeRag");
        const dirty = Boolean(userEditedRagSettings);
        button.classList.toggle("is-dirty", dirty);
        button.title = dirty
          ? "请先保存或丢弃未保存的 RAG 修改；强制重建只使用已保存配置"
          : "强制重建 Code RAG：停止当前 indexing、删除旧索引并从 0 重建";
        button.setAttribute("aria-label", button.title);
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
        renderSettingsHomeStatuses();
	    }

	    function renderSettingsHomeStatuses() {
	      const status = el("completionSettingsStatus");
	      if (!status) return;
	      const completion = completionStatusInfo();
	      status.textContent = completion.tileLabel;
	      status.className = "settingsEntryStatus " + completion.kind;
	      status.title = completion.title;
	      status.setAttribute("aria-label", completion.ariaLabel);
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
          { input: "file", button: "fileToggle", label: "Include current file", menuLabel: "Current file", meta: "Send the active editor file", icon: "file" },
          { input: "sel", button: "selToggle", label: "Include editor selection", menuLabel: "Selection", meta: "Send the current editor selection", icon: "selection" },
          { input: "diag", button: "diagToggle", label: diagnosticsToggleLabel(), menuLabel: "Diagnostics", meta: "Send workspace diagnostics", icon: "diagnostics", badge: diagnosticsBadgeText(), popover: "diagnostics" },
          { input: "diff", button: "diffToggle", label: "Include git diff", menuLabel: "Git diff", meta: "Send the current workspace diff", icon: "diff" },
        ];
        for (const config of configs) {
          const input = el(config.input);
          const button = el(config.button);
          if (!input || !button) continue;
          const pressed = Boolean(input.checked);
          if (button.classList.contains("composerMoreItem")) {
            setComposerMoreToggleButton(button, config, pressed);
          } else {
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
        renderComposerMoreActionButtons();
        renderComposerMoreTrigger();
      }

      function setComposerMoreToggleButton(button, config, checked) {
        button.textContent = "";
        button.disabled = false;
        button.className = "modelMenuItem composerMoreItem composerMoreToggle" + (checked ? " active" : "");
        button.setAttribute("role", "menuitemcheckbox");
        button.setAttribute("aria-checked", checked ? "true" : "false");
        button.setAttribute("aria-label", config.label);
        button.title = config.label;
        appendComposerMoreIcon(button, config.icon);
        appendComposerMoreCopy(button, config.menuLabel || config.label, config.meta || "");
        appendComposerMoreState(button, checked, config.badge || "");
      }

      function renderComposerMoreActionButtons() {
        setComposerMoreActionButton(el("attach"), {
          icon: "attach",
          label: "Attach file",
          meta: "Attach to this prompt",
          title: "Attach workspace file to this message",
        });
        setComposerMoreActionButton(el("addPersistentContext"), {
          icon: "file",
          label: "Persistent context",
          meta: "Keep a file across prompts",
          title: "Add persistent context file",
        });
        setComposerMoreActionButton(el("refreshModels"), {
          icon: "refresh",
          label: state.loadingModels ? "Refreshing models" : "Refresh models",
          meta: "Reload provider model list",
          title: state.loadingModels ? "Refreshing models" : "Refresh models",
          disabled: Boolean(state.loadingModels),
          loading: Boolean(state.loadingModels),
        });
        setComposerMoreActionButton(el("exportMarkdown"), {
          icon: "file",
          label: "Export Markdown",
          meta: "Save current chat",
          title: "Export current chat to Markdown",
        });
      }

      function setComposerMoreActionButton(button, input) {
        if (!button) return;
        button.textContent = "";
        button.disabled = Boolean(input.disabled);
        button.className = "modelMenuItem composerMoreItem composerMoreAction" + (input.disabled ? " disabled" : "");
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-label", input.title || input.label);
        button.title = input.title || input.label;
        appendComposerMoreIcon(button, input.icon);
        appendComposerMoreCopy(button, input.label, input.meta || "");
        appendComposerMoreState(button, false, input.loading ? "…" : "");
      }

      function appendComposerMoreIcon(button, iconName) {
        const icon = document.createElement("span");
        icon.className = "composerMoreItemIcon";
        icon.setAttribute("aria-hidden", "true");
        appendMarkup(icon, LIQUID_ICONS[iconName] || LIQUID_ICONS.more);
        button.appendChild(icon);
      }

      function appendComposerMoreCopy(button, label, meta) {
        const copy = document.createElement("span");
        copy.className = "composerMoreItemCopy";
        const name = document.createElement("span");
        name.className = "modelMenuName";
        name.textContent = label;
        copy.appendChild(name);
        const detail = document.createElement("span");
        detail.className = "modelMenuMeta";
        detail.textContent = meta;
        copy.appendChild(detail);
        button.appendChild(copy);
      }

      function appendComposerMoreState(button, checked, badgeText) {
        const stateNode = document.createElement("span");
        stateNode.className = "composerMoreItemState";
        stateNode.setAttribute("aria-hidden", "true");
        if (badgeText) {
          const badge = document.createElement("span");
          badge.className = "composerMoreBadge";
          badge.textContent = badgeText;
          stateNode.appendChild(badge);
        } else if (checked) {
          appendMarkup(stateNode, LIQUID_ICONS.apply || "✓");
        }
        button.appendChild(stateNode);
      }

      function composerMoreHasCustomContext() {
        return !el("file").checked || !el("sel").checked || el("diag").checked || el("diff").checked;
      }

      function renderComposerMoreTrigger() {
        const trigger = el("composerMore");
        if (!trigger) return;
        const customized = composerMoreHasCustomContext();
        const label = customized ? "Add context and actions; context customized" : "Add context and actions";
        setComposerAddButton(trigger, label);
        trigger.className = "composerAddButton composerMoreButton chat-toolbar-icon-button"
          + (composerMoreMenuOpen ? " open" : "")
          + (customized ? " has-context" : "");
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-controls", "composerMoreMenu");
        trigger.setAttribute("aria-expanded", composerMoreMenuOpen ? "true" : "false");
      }

      function setComposerAddButton(button, label) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        const glyph = document.createElement("span");
        glyph.className = "composerAddGlyph";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = "+";
        const sr = document.createElement("span");
        sr.className = "srOnly";
        sr.textContent = label;
        button.append(glyph, sr);
        button.title = label;
        button.setAttribute("aria-label", label);
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

      function toolbarIconMarkup(markup, extraClass) {
        const className = ["chat-toolbar-icon-slot", extraClass].filter(Boolean).join(" ");
        return '<span class="' + className + '" aria-hidden="true">' + (markup || "") + "</span>";
      }

      function toolbarIndexStatusKind(kind) {
        if (kind === "ready" || kind === "indexed" || kind === "enabled") return "ready";
        if (kind === "indexing" || kind === "syncing") return "indexing";
        if (kind === "error") return "error";
        return "unknown";
      }

      function indexStatusWarningBadgeHtml() {
        return '<span class="index-status-warning-badge" aria-hidden="true"><span class="index-status-warning-mark">!</span></span>';
      }

      function indexStatusIconHtml(kind, codiconName, badgeKind) {
        const statusKind = toolbarIndexStatusKind(kind);
        const badgeMarkup = badgeKind === "warning" ? indexStatusWarningBadgeHtml() : "";
        const stackClass = ["index-status-icon-stack", badgeKind === "warning" ? "index-status-icon-stack--warning" : ""].filter(Boolean).join(" ");
        return toolbarIconMarkup(
          '<span class="' + stackClass + '" aria-hidden="true"><span class="index-status-icon index-status-icon--' + statusKind + '"><span class="codicon codicon-' + codiconName + '"></span></span>' + badgeMarkup + '</span>',
          "chat-toolbar-icon-slot--status",
        );
      }

      function codeGraphStatusIconHtml(kind) {
        const statusKind = toolbarIndexStatusKind(kind);
        const glyph = ${codeGraphStatusGlyphForScript};
        return toolbarIconMarkup(
          '<span class="index-status-icon index-status-icon--' + statusKind + '" aria-hidden="true">' + glyph + '</span>',
          "chat-toolbar-icon-slot--status",
        );
      }

      function appendMarkup(root, markup) {
        if (!root || !markup) return;
        const holder = document.createElement("span");
        holder.innerHTML = markup;
        while (holder.firstChild) root.appendChild(holder.firstChild);
      }

      function usesComposerToolbarIconLayout(node) {
        return Boolean(node && (node.classList.contains("chat-toolbar-icon-button")
          || node.classList.contains("composerStatusPill")
          || node.id === "send"
          || node.closest(".composerToolbar")
          || node.closest(".composerStatusBar")));
      }

      function setIconOnlyButton(button, iconName, label) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        appendLiquidIcon(button, iconName, usesComposerToolbarIconLayout(button));
        const sr = document.createElement("span");
        sr.className = "srOnly";
        sr.textContent = label;
        button.appendChild(sr);
        button.title = label;
        button.setAttribute("aria-label", label);
      }

      function setHistoryToolbarButton(button, iconName, label) {
        if (!button) return;
        button.textContent = "";
        if (button.tagName === "BUTTON" && !button.getAttribute("type")) button.type = "button";
        button.classList.add("historyToolbarButton");
        const glyph = document.createElement("span");
        glyph.className = "historyToolbarGlyph";
        glyph.setAttribute("data-history-icon", iconName);
        glyph.setAttribute("aria-hidden", "true");
        const iconUri = HISTORY_TOOLBAR_ICONS[iconName] || "";
        if (iconUri) glyph.style.setProperty("--history-toolbar-icon", 'url("' + iconUri + '")');
        button.appendChild(glyph);
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
          const slot = document.createElement("span");
          slot.className = "chat-toolbar-icon-slot";
          slot.setAttribute("aria-hidden", "true");
          const spinner = document.createElement("span");
          spinner.className = "sendSpinner";
          spinner.setAttribute("aria-hidden", "true");
          slot.appendChild(spinner);
          button.appendChild(slot);
        } else {
          appendLiquidIcon(button, iconName, true);
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
        if (usesComposerToolbarIconLayout(button)) {
          const glyph = document.createElement("span");
          glyph.className = "pillGlyph";
          glyph.setAttribute("aria-hidden", "true");
          appendMarkup(glyph, toolbarIconMarkup(LIQUID_ICONS[iconName] || LIQUID_ICONS.more));
          button.appendChild(glyph);
        } else {
          appendLiquidIcon(button, iconName);
        }
        const text = document.createElement("span");
        text.className = "oc-chip-label oc-liquid-chip-label";
        text.textContent = label;
        button.appendChild(text);
        button.title = label;
        if (button.tagName === "BUTTON") button.setAttribute("aria-label", label);
      }

      function appendLiquidIcon(root, iconName, wrapInToolbarSlot) {
        const markup = LIQUID_ICONS[iconName] || LIQUID_ICONS.more;
        appendMarkup(root, wrapInToolbarSlot ? toolbarIconMarkup(markup) : markup);
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
	      toggle.className = "composerStatusToggle chat-toolbar-icon-button oc-icon-toggle oc-liquid-toggle" + (composerCollapsed ? " collapsed" : " expanded");
      toggle.setAttribute("aria-expanded", composerCollapsed ? "false" : "true");
      toggle.setAttribute("aria-label", composerCollapsed ? "Show input and context panel" : "Hide input and context panel");
      toggle.title = composerCollapsed ? "Show input and context panel" : "Hide input and context panel";
      const toggleIcon = toggle.querySelector(".composerToggleIcon");
      if (toggleIcon) toggleIcon.innerHTML = composerCollapsed ? STATUS_ICONS.panelBottomOpen : STATUS_ICONS.panelBottomClose;
      toggleFull.textContent = toggleLabel;
      toggleShort.textContent = toggleShortLabel;

	      const context = composerContextStatus();
	      updateStatusPill(el("contextStatusPill"), context);
	      const goal = composerGoalStatus();
	      updateStatusPill(el("goalStatusPill"), goal);
	      const index = composerIndexStatus();
      updateStatusPill(el("indexStatusPill"), index);
      const rag = composerRagStatus();
      updateStatusPill(el("ragStatusPill"), rag);
      const documentRag = composerDocumentRagStatus();
      updateStatusPill(el("documentRagStatusPill"), documentRag);
      const permission = composerPermissionStatus();
      updateStatusPill(el("permissionStatusPill"), permission);
      const skills = composerSkillsStatus();
      updateStatusPill(el("skillsStatusPill"), skills);
      const guard = composerGuardStatus();
      updateStatusPill(el("guardStatusPill"), guard);
      const usage = composerUsageStatus();
      updateStatusPill(el("usageStatusPill"), usage);
      const completion = composerCompletionStatus();
      updateStatusPill(el("completionStatusPill"), completion);
      const queue = composerQueueStatus();
	      updateStatusPill(el("queueStatusPill"), queue);
	      renderGoalSummaryBanner();
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
      node.className = input.className + (activePopover === input.popover ? " open" : "");
      node.classList.toggle("hasText", Boolean(input.showText));
      node.title = input.title || input.text;
      node.setAttribute("aria-label", input.ariaLabel || input.title || input.text);
      if (node.hasAttribute("aria-expanded")) node.setAttribute("aria-expanded", activePopover === input.popover ? "true" : "false");
      const label = node.querySelector(".pillText") || node;
      if (input.iconHtml) {
        label.className = "pillText";
        label.setAttribute("aria-hidden", "true");
        label.innerHTML = input.iconHtml;
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
          appendMarkup(icon, usesComposerToolbarIconLayout(node) ? toolbarIconMarkup(input.icon) : input.icon);
          label.appendChild(icon);
        }
        const text = document.createElement("span");
        text.className = "pillLabelText";
        text.textContent = input.text || "";
        label.appendChild(text);
      } else {
        label.setAttribute("aria-hidden", "true");
        label.innerHTML = usesComposerToolbarIconLayout(node) && input.icon
          ? toolbarIconMarkup(input.icon)
          : input.icon || input.text || "";
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

	    function bindGoalStatusPill() {
	      const node = el("goalStatusPill");
	      node.addEventListener("click", onGoalStatusPillClick);
	    }

		    function bindGoalSummaryBanner() {
		      const node = el("goalSummaryBanner");
		      node.addEventListener("click", onGoalSummaryBannerClick);
		    }

		    function bindGoalResumePrompt() {
		      const node = el("goalResumePrompt");
		      node.addEventListener("click", (event) => {
		        const target = event.target;
		        const action = target && target.closest ? target.closest("[data-goal-action]") : null;
		        if (!action) return;
		        event.stopPropagation();
		        handleGoalAction(action.getAttribute("data-goal-action") || "");
		      });
		    }

		    function onGoalStatusPillClick(event) {
	      event.stopPropagation();
	      if (state.goal) {
	        toggleComposerStatusPopover(event, "goal");
	        return;
	      }
	      closeComposerPopups();
	      closeComposerStatusPopoverState();
	      setGoalInputMode(!goalInputMode, { focus: true });
	    }

	    function onGoalSummaryBannerClick(event) {
	      event.stopPropagation();
	      if (!state.goal) return;
	      composerPinnedStatusPopover = "goal";
	      composerHoverStatusPopover = "";
	      closeComposerPopups();
	      renderComposerStatusBar();
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
		      if (activePopover === "goal") renderGoalStatusPopover(root);
		      if (activePopover === "diagnostics") renderDiagnosticsStatusPopover(root);
	      if (activePopover === "index") renderIndexStatusPopover(root);
	      if (activePopover === "rag") renderRagStatusPopover(root);
	      if (activePopover === "documentRag") renderDocumentRagStatusPopover(root);
	      if (activePopover === "permission") renderPermissionStatusPopover(root);
      if (activePopover === "skills") renderSkillsStatusPopover(root);
      if (activePopover === "guard") renderGuardStatusPopover(root);
      if (activePopover === "usage") renderUsageStatusPopover(root);
      if (activePopover === "completion") renderCompletionStatusPopover(root);
      if (activePopover === "queue") renderQueueStatusPopover(root);
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
        const activeStatusPill = active && active.closest && active.closest("#contextStatusPill, #goalStatusPill, #goalSummaryBanner, #indexStatusPill, #ragStatusPill, #documentRagStatusPill, #permissionStatusPill, #skillsStatusPill, #guardStatusPill, #usageStatusPill, #completionStatusPill, #queueStatusPill");
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

	    function setGoalInputMode(enabled, options) {
	      goalInputMode = Boolean(enabled);
	      persistGoalInputMode();
	      if (goalInputMode) closeComposerStatusPopoverState();
	      renderComposerInputMode();
	      renderComposerStatusBar();
	      renderSendButton();
	      if (goalInputMode && (!options || options.focus !== false)) requestAnimationFrame(() => el("input").focus());
	    }

	    function persistGoalInputMode() {
	      const nextState = { ...webviewState() };
	      if (goalInputMode) nextState.goalInputMode = true;
	      else delete nextState.goalInputMode;
	      vscode.setState(nextState);
	    }

	    function isGoalInputModeActive() {
	      if (!goalInputMode) return false;
	      const goal = state.goal || null;
	      if (!goal) return true;
	      return String(goal.status || "active") === "complete";
	    }

	    function reconcileGoalInputModeAfterState() {
	      const goal = state.goal || null;
	      if (!goal) return;
	      const status = String(goal.status || "active");
	      if (pendingGoalObjective && status === "active" && String(goal.objective || "").trim() === pendingGoalObjective) {
	        pendingGoalObjective = "";
	        goalInputMode = false;
	        persistGoalInputMode();
	        composerPinnedStatusPopover = "goal";
	        composerHoverStatusPopover = "";
	        el("input").value = "";
	        mentionedFiles = [];
	        mentionResults = [];
	        suggestionMode = "";
	        clearComposerDraft();
	        setNotice("Goal started.");
	        return;
	      }
	      if (goalInputMode && status !== "complete") {
	        goalInputMode = false;
	        persistGoalInputMode();
	      }
	    }

		    function composerContextStatus() {
		      const detail = contextStatusDetail();
		      return {
		        text: "Context",
	        title: detail,
		        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn context",
	        popover: "context",
	        ariaLabel: "Context. " + detail,
		        icon: STATUS_ICONS.context,
	        badgeText: "",
	      };
	    }

	    function composerContextCount() {
	      let count = mentionedFiles.length + contextItems().length;
	      if (el("file").checked && state.autoContext && state.autoContext.currentFile && !contextPathSet().has(state.autoContext.currentFile)) count += 1;
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
	        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn index " + view.kind,
        popover: "index",
        ariaLabel: "Index status: " + view.shortLabel + ". " + title,
        iconHtml: codeGraphStatusIconHtml(view.kind),
	      };
	    }

	    function composerRagStatus() {
	      const rag = state.codeGraph && state.codeGraph.rag;
	      const view = ragStatusView(rag);
	      const title = codeGraphRagMeta(rag) || view.label;
	      return {
	        text: view.shortLabel,
	        title,
		        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn rag " + view.kind,
	        popover: "rag",
	        ariaLabel: "RAG index status: " + view.shortLabel + ". " + title,
	        iconHtml: indexStatusIconHtml(view.kind, "database"),
	      };
	    }

		    function composerDocumentRagStatus() {
		      const documentRag = state.documentRag;
		      const view = documentRagStatusView(documentRag);
		      const title = "Document RAG index: " + documentRagToolbarStateLabel(documentRag);
	      return {
	        text: view.shortLabel,
	        title,
		        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn documentRag " + view.kind,
		        popover: "documentRag",
		        ariaLabel: view.badgeLabel ? title + ". " + view.badgeLabel : title,
		        iconHtml: indexStatusIconHtml(view.kind, "${documentRagStatusCodicon}", view.badgeKind),
		      };
		    }

	    function composerGoalStatus() {
	      const goal = state.goal || null;
	      const operation = state.goalOperation || null;
	      if (isGoalInputModeActive()) {
	        return {
	          text: "Goal mode",
	          title: "Goal mode: the next send will create a ChipMate goal.",
	          className: "composerStatusPill goalTrigger oc-chip oc-liquid-chip goal active",
	          popover: "goal",
	          ariaLabel: "ChipMate goal mode. The next send will create a goal.",
	          icon: STATUS_ICONS.goal,
	          showText: true,
	        };
	      }
	      if (!goal) {
	        return {
	          text: "Goal",
	          title: "No active ChipMate goal",
	          className: "composerStatusPill goalTrigger oc-chip oc-liquid-chip goal is-empty",
	          popover: "goal",
	          ariaLabel: "ChipMate goal: inactive",
	          icon: STATUS_ICONS.goal,
	          showText: true,
	        };
	      }
	      const status = String(goal.status || "active");
	      const label = goalStatusLabel(status);
	      const running = Boolean(operation && operation.active);
	      const tokens = goal.tokenBudget ? " · " + formatCompactCount(goal.tokensUsed || 0) + "/" + formatCompactCount(goal.tokenBudget) : "";
	      const title = label + tokens + ": " + compactActivityText(goal.objective || "");
	      return {
	        text: running ? "Goal running" : "Goal " + label,
	        title,
	        className: "composerStatusPill goalTrigger oc-chip oc-liquid-chip goal " + goalStatusKind(status),
	        popover: "goal",
	        ariaLabel: "ChipMate goal: " + title,
	        icon: STATUS_ICONS.goal,
	        showText: true,
	        badgeText: running ? String(Math.max(1, Number(operation.turnCount || 1))) : "",
	      };
	    }

	    function goalStatusLabel(status) {
	      if (status === "paused") return "paused";
	      if (status === "blocked") return "blocked";
	      if (status === "usage_limited") return "usage limited";
	      if (status === "budget_limited") return "budget limited";
	      if (status === "complete") return "complete";
	      return "active";
	    }

	    function goalStatusKind(status) {
	      if (status === "usage_limited") return "usage-limited";
	      if (status === "budget_limited") return "budget-limited";
	      if (status === "paused" || status === "blocked" || status === "complete") return status;
	      return "active";
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

	    function ragProgressRatio(rag) {
	      if (!rag || !rag.chunks) return undefined;
	      return clamp01(Number(rag.embeddedChunks || rag.indexedChunkCount || 0) / Number(rag.chunks));
	    }

	    function ragChunkProgressLabel(rag) {
	      if (!rag || !rag.chunks) return "";
	      return ": " + formatCount(rag.embeddedChunks || rag.indexedChunkCount || 0) + "/" + formatCount(rag.chunks) + " chunks";
	    }

		    function documentRagStatusView(documentRag) {
		      if (!documentRag || documentRag.availability === "disabled") return { kind: "info", shortLabel: "Docs off", label: "Document RAG disabled" };
		      if (documentRag.availability === "not-configured") return { kind: "info", shortLabel: "Docs off", label: "Document RAG not configured" };
		      if (documentRag.availability === "no-documents") return { kind: "info", shortLabel: "No docs", label: "No Word, Excel, or PDF documents found" };
		      if (documentRag.availability === "scanning") return { kind: "indexing", shortLabel: "Docs scanning", label: "Document RAG scanning" };
		      if (documentRag.availability === "indexing") return { kind: "indexing", shortLabel: "Docs indexing", label: "Document RAG indexing" + documentRagChunkProgressLabel(documentRag) };
		      if (documentRag.availability === "ready") return { kind: "ready", shortLabel: "Docs ready", label: "Document RAG ready" + documentRagChunkProgressLabel(documentRag) };
		      if (documentRag.availability === "partial" && documentRagUsablePartial(documentRag)) return { kind: "ready", shortLabel: "Docs ready", label: "Document RAG ready with warnings" + documentRagChunkProgressLabel(documentRag), badgeKind: "warning", badgeLabel: "Some documents were skipped." };
		      if (documentRag.availability === "partial") return { kind: "warning", shortLabel: "Docs partial", label: "Document RAG partial" + documentRagChunkProgressLabel(documentRag) };
		      if (documentRag.availability === "paused") return { kind: "warning", shortLabel: "Docs paused", label: "Document RAG paused" };
		      if (documentRag.availability === "large-workspace-paused") return { kind: "warning", shortLabel: "Docs paused", label: "Document RAG paused for a large workspace" };
		      if (documentRag.availability === "error") return { kind: "error", shortLabel: "Docs error", label: "Document RAG error" };
		      return { kind: "info", shortLabel: "Docs", label: "Document RAG" };
		    }

		    function documentRagToolbarStateLabel(documentRag) {
		      if (!documentRag || documentRag.availability === "disabled") return "Disabled";
		      if (documentRag.availability === "not-configured") return "Not configured";
		      if (documentRag.availability === "no-documents") return "No documents";
		      if (documentRag.availability === "scanning" || documentRag.availability === "indexing") return "Indexing";
		      if (documentRag.availability === "ready") return "Ready";
		      if (documentRag.availability === "partial" && documentRagUsablePartial(documentRag)) return "Ready with warnings";
		      if (documentRag.availability === "partial") return "Partial";
		      if (documentRag.availability === "paused") return "Paused";
		      if (documentRag.availability === "large-workspace-paused") return "Paused for a large workspace";
		      if (documentRag.availability === "error") return "Error";
		      return "Document RAG";
		    }

		    function documentRagUsablePartial(documentRag) {
		      if (!documentRag || documentRag.availability !== "partial") return false;
		      const chunks = Number(documentRag.chunks || 0);
		      const embeddedChunks = Number(documentRag.embeddedChunks || 0);
		      return chunks > 0 && embeddedChunks > 0 && documentRagIndexedRatio(documentRag) >= 0.75;
		    }

		    function documentRagIndexedRatio(documentRag) {
		      const documentCount = Number(documentRag && documentRag.documentCount || 0);
		      if (!Number.isFinite(documentCount) || documentCount <= 0) return 0;
		      const indexedDocuments = Number(documentRag.indexedDocuments || 0);
		      if (!Number.isFinite(indexedDocuments) || indexedDocuments <= 0) return 0;
		      return clamp01(indexedDocuments / documentCount);
		    }

		    function documentRagChunkProgressLabel(documentRag) {
		      if (!documentRag || !documentRag.chunks) return "";
	      return ": " + formatCount(documentRag.embeddedChunks || 0) + "/" + formatCount(documentRag.chunks) + " chunks";
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
      if (mode === "auto") return "低风险读取和新建 workspace 文件可自动放行；高风险目标会被阻止或要求确认，并写入审计日志。";
      if (mode === "full-access") return "读取和新建 workspace 文件不拦截、不询问，只写入审计日志；编辑已有文件仍不开放。";
      return "读取 workspace 文件自动允许；新建文件按次审批，编辑已有文件、命令和网络操作不开放，并写入审计日志。";
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
	          className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn guard warning",
          popover: "guard",
          ariaLabel: "Guard warning: " + detail,
          icon: STATUS_ICONS.shieldAlert,
        };
      }
      if (state.localOnlyMode === false) {
        return {
          text: "Guard off",
          title: detail,
	          className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn guard off is-hidden",
          popover: "guard",
          ariaLabel: "Guard off: " + detail,
          icon: STATUS_ICONS.shieldOff,
          hidden: true,
        };
      }
      return {
        text: "Guard ok",
        title: detail,
	        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn guard ok is-hidden",
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
          className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn usage pending",
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
        className: "composerStatusPill chat-toolbar-icon-button oc-icon-btn oc-liquid-btn usage " + kind,
        popover: "usage",
        ariaLabel: "Context usage: " + title,
        icon: STATUS_ICONS.usage,
      };
    }

    function composerCompletionStatus() {
      const status = completionStatusInfo();
      return {
        text: status.label,
        title: status.title,
        className: "composerStatusPill oc-chip oc-liquid-chip completion " + status.kind + (status.kind === "off" ? " is-empty" : ""),
        popover: "completion",
        ariaLabel: status.ariaLabel,
        icon: AUTOCOMPLETE_STATUS_ICONS[status.iconState],
        showText: true,
      };
    }

    function completionStatusInfo() {
      const completion = state.completion || {};
      const enabled = Boolean(completion.enabled);
      const provider = completion.provider || "qwen-direct";
      const profile = completion.profile || "qwen-coder-fim";
      const candidates = completionCandidateModels(profile, completion.model);
      const savedModel = String(completion.model || "qwen-coder-30b0").trim();
      const model = completionStatusModel(savedModel, candidates);
      if (!enabled || provider === "none") {
        return {
          kind: "off",
          label: "Complete off",
          tileLabel: "Off",
          title: "Autocomplete disabled · inline code completion is off",
          ariaLabel: "Autocomplete disabled",
          iconState: "disabled",
          provider,
          enabled,
          model: savedModel || "qwen-coder-30b0",
          reason: !enabled ? "Completion enabled: false" : "Completion provider: none",
        };
      }
      if (provider !== "qwen-direct" && provider !== "fim-direct") {
        return {
          kind: "off",
          label: "Complete off",
          tileLabel: "Off",
          title: "Autocomplete disabled · inline code completion is off",
          ariaLabel: "Autocomplete disabled",
          iconState: "disabled",
          provider,
          enabled,
          model: savedModel || "qwen-coder-30b0",
          reason: "Completion provider is " + provider + ", not a direct FIM provider.",
        };
      }
      if (!candidates.length) {
        return {
          kind: "warning",
          label: "Complete unavailable",
          tileLabel: "Unavailable",
          title: "Autocomplete unavailable · no " + (profile === "deepseek-fim" ? "DeepSeek FIM" : "Qwen Coder") + " completion model was returned by the provider",
          ariaLabel: "Autocomplete unavailable",
          iconState: "disabled",
          provider,
          enabled,
          model: savedModel || "qwen-coder-30b0",
          reason: "No provider-returned " + (profile === "deepseek-fim" ? "DeepSeek FIM" : "Qwen Coder") + " model is available.",
        };
      }
      return {
        kind: "ready",
        label: "Complete on",
        tileLabel: "On",
        title: "Autocomplete enabled · inline code completion is available",
        ariaLabel: "Autocomplete enabled",
        iconState: "enabled",
        provider,
        enabled,
        model,
        reason: "",
      };
    }

    function completionStatusModel(savedModel, candidates) {
      if (savedModel && candidates.some((model) => completionModelId(model) === savedModel)) return savedModel;
      return candidates.length ? completionModelId(candidates[0]) : savedModel;
    }

    function composerQueueStatus() {
      const count = queuedSendCount();
      const limit = queuedSendLimit();
      const full = count >= limit && limit > 0;
      const label = "Queued " + count + "/" + limit;
      return {
        text: label,
        title: count > 0 ? label + " messages waiting for the next turn." : "No queued messages.",
        className: "composerStatusPill oc-chip oc-liquid-chip queue " + (full ? "warning" : count > 0 ? "active" : "info") + (count > 0 ? "" : " is-hidden"),
        popover: "queue",
        ariaLabel: count > 0 ? "Send queue: " + label : "Send queue: empty.",
        icon: STATUS_ICONS.queue,
        showText: true,
        hidden: count === 0,
      };
    }

    function queuedSendCount() {
      return queuedSendItems().length;
    }

    function queuedSendLimit() {
      return Math.max(1, Number(state.queuedSendLimit || 10));
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
	      const paths = contextPathSet();
	      for (const item of contextItems()) lines.push(contextItemTitle(item));
	      for (const file of mentionedFiles) lines.push("@ " + file.label);
	      if (auto.currentFile && !paths.has(auto.currentFile)) {
	        if (el("sel").checked && auto.hasSelection) lines.push("Auto: Selection: " + auto.currentFile);
	        else if (el("file").checked) lines.push("Auto: Current: " + auto.currentFile);
	      } else if ((el("sel").checked || el("file").checked) && !auto.currentFile) {
	        lines.push("Auto: no current file captured");
	      }
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
	      const selected = selectedContextItem();
	      appendStatusPopoverHeader(root, selected ? contextItemDetailTitle(selected) : "Context", selected ? selected.path : contextStatusDetail());
	      if (selected) appendContextItemDetail(root, selected);
	      const rows = statusRows();
	      const auto = state.autoContext || {};
	      const paths = contextPathSet();
	      for (const item of contextItems()) {
	        const row = appendStatusRow(rows, contextItemTitle(item));
	        const actions = document.createElement("span");
	        actions.className = "statusPopoverActions";
	        const details = statusAction("Details", "Show context details");
	        details.setAttribute("data-select-context-item", item.id);
	        const open = statusAction("Open", "Open " + item.path);
	        open.setAttribute("data-open-context-item", item.id);
	        const remove = statusAction("Remove", "Remove " + contextItemTitle(item));
	        remove.setAttribute("data-remove-context-item", item.id);
	        actions.append(details, open, remove);
	        row.appendChild(actions);
	      }
	      for (const file of mentionedFiles) {
	        const row = appendStatusRow(rows, "@" + file.label);
	        const remove = statusAction("Remove", "Remove " + file.label);
	        remove.title = "Remove " + file.label;
	        remove.setAttribute("data-remove-mention", file.uri);
	        row.appendChild(remove);
	      }
	      if (auto.currentFile && !paths.has(auto.currentFile)) {
	        appendStatusRow(rows, (el("sel").checked && auto.hasSelection ? "Auto selection: " : "Auto current file: ") + auto.currentFile);
	      }
	      if (!rows.childElementCount) appendStatusRow(rows, "No local context selected.");
	      root.appendChild(rows);
	      renderContextSummaryRows(root);
	    }

	    function renderContextSummaryRows(root) {
	      const summary = state.contextSummary || {};
	      const sections = Array.isArray(summary.sections) ? summary.sections : [];
	      if (!sections.length && !summary.fallbackNotice && !summary.compactWarning && !summary.rollbackWarning) return;
	      appendStatusPopoverHeader(root, "Context Summary", contextSummaryMeta(summary));
	      const rows = statusRows();
	      for (const section of sections) {
	        appendStatusRow(rows, contextSummarySectionText(section));
	      }
	      if (summary.fallbackNotice) appendStatusRow(rows, "Window fallback: " + summary.fallbackNotice);
	      if (summary.compactWarning) appendStatusRow(rows, "Compact: " + summary.compactWarning);
	      if (summary.rollbackWarning) appendStatusRow(rows, "Rollback: " + summary.rollbackWarning);
	      root.appendChild(rows);
	    }

	    function contextSummaryMeta(summary) {
	      const sections = Array.isArray(summary.sections) ? summary.sections : [];
	      const warnings = sections.filter((section) => section && (section.severity === "warning" || section.severity === "error")).length
	        + (summary.fallbackNotice ? 1 : 0)
	        + (summary.compactWarning ? 1 : 0)
	        + (summary.rollbackWarning ? 1 : 0);
	      return warnings ? warnings + " warnings or degraded states" : "Included, truncated, stale, compact and rollback state";
	    }

	    function contextSummarySectionText(section) {
	      const label = section && section.label ? String(section.label) : "Context";
	      const value = section && section.value ? String(section.value) : "";
	      const detail = section && section.detail ? " · " + String(section.detail) : "";
	      const omitted = Number(section && section.omitted || 0);
	      const truncated = Number(section && section.truncated || 0);
	      const counts = [
	        omitted > 0 ? "omitted " + omitted : "",
	        truncated > 0 ? "truncated " + truncated : "",
	      ].filter(Boolean).join(", ");
	      return label + ": " + value + detail + (counts ? " · " + counts : "");
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

		    function renderDocumentRagStatusPopover(root) {
		      const documentRag = state.documentRag;
		      const view = documentRagStatusView(documentRag);
	      const detail = documentRagMeta(documentRag);
	      appendStatusPopoverHeader(root, view.label, detail);
	      if (documentRag) {
	        appendStatusRow(root, "Documents " + formatCount(documentRag.indexedDocuments || 0) + "/" + formatCount(documentRag.documentCount || 0));
	        appendStatusRow(root, "Chunks " + formatCount(documentRag.embeddedChunks || 0) + "/" + formatCount(documentRag.chunks || 0));
	        if (documentRag.pendingDocuments) appendStatusRow(root, "Pending " + formatCount(documentRag.pendingDocuments) + " document(s)");
	        if (documentRag.skippedDocuments) appendStatusRow(root, "Skipped " + formatCount(documentRag.skippedDocuments) + " document(s)");
	        if (documentRag.lastError) appendStatusRow(root, "Last error: " + documentRag.lastError);
	        if (documentRag.lastScanAt) appendStatusRow(root, "Last scan " + formatDateTime(documentRag.lastScanAt));
	      }
	      const actionRoot = document.createElement("div");
	      actionRoot.className = "statusPopoverActions";
	      for (const action of documentRagControlActions(documentRag)) {
	        const button = document.createElement("button");
	        button.className = "statusActionButton" + (action.message === "rebuildDocumentRag" ? " primary" : "");
	        button.type = "button";
	        button.textContent = action.label;
	        button.title = action.title || action.label;
	        if (action.message) button.setAttribute("data-code-graph-action", action.message);
	        actionRoot.appendChild(button);
	      }
		      if (actionRoot.childElementCount) root.appendChild(actionRoot);
		    }

	    function renderGoalStatusPopover(root) {
	      const goal = state.goal || null;
	      const operation = state.goalOperation || null;
	      if (!goal) {
	        appendStatusPopoverHeader(root, goalInputMode ? "Goal mode" : "Goal inactive", goalInputMode ? "The next prompt you send will become this session's goal." : "Click Goal to write the next prompt as a persistent session goal.");
	        return;
	      }

	      const status = String(goal.status || "active");
	      appendStatusPopoverHeader(root, "Goal " + goalStatusLabel(status), compactActivityText(goal.objective || ""));
	      const rows = statusRows();
	      appendStatusRow(rows, "Tokens: " + formatCompactCount(goal.tokensUsed || 0) + (goal.tokenBudget ? " / " + formatCompactCount(goal.tokenBudget) : ""));
	      appendStatusRow(rows, "Time: " + formatDuration(Number(goal.timeUsedSeconds || 0) * 1000));
	      if (operation && operation.active) appendStatusRow(rows, "Operation: running turn " + formatCount(operation.turnCount || 1));
	      root.appendChild(rows);

	      const actions = document.createElement("div");
	      actions.className = "goalActions";
	      actions.appendChild(goalActionButton("editGoal", "edit", "Edit", true));
	      if (status === "active") {
	        actions.appendChild(goalActionButton("pauseGoal", "pause", "Pause", false));
	      } else if (status === "paused" || status === "blocked" || status === "usage_limited") {
	        actions.appendChild(goalActionButton("resumeGoal", "play", "Resume", true));
	      } else if (status === "complete") {
	        actions.appendChild(goalActionButton("createGoal", "add", "New", true));
	      }
	      actions.appendChild(goalActionButton("clearGoal", "trash", "Clear", false, "danger"));
	      root.appendChild(actions);
	    }

	    function goalActionButton(action, iconName, label, primary, extraClass) {
	      const button = document.createElement("button");
	      button.type = "button";
	      button.className = "goalActionButton oc-liquid-btn" + (primary ? " is-active" : "") + (extraClass ? " " + extraClass : "");
	      button.setAttribute("data-goal-action", action);
	      button.title = label + " ChipMate goal";
	      const icon = document.createElement("span");
	      icon.className = "goalActionIcon";
	      icon.setAttribute("aria-hidden", "true");
	      icon.innerHTML = LIQUID_ICONS[iconName] || STATUS_ICONS.goal;
	      const text = document.createElement("span");
	      text.className = "goalActionLabel";
	      text.textContent = label;
	      button.append(icon, text);
	      return button;
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
	      toggleDesc.textContent = enabled ? "已开启，可读取 workspace evidence，并按权限模式创建新的 workspace 文本文件。" : "已关闭，不向模型暴露工具 schema。";
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
        const state = skill.invalid ? "Invalid: " : skill.enabled ? "Enabled: " : "Available: ";
        const source = [skill.scope, skill.sourceKind, skill.visibility].filter(Boolean).join("/");
        appendStatusRow(rows, state + (skill.name || skill.id) + (source ? " · " + source : ""));
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
      const actions = document.createElement("div");
      actions.className = "statusPopoverActions";
      const open = document.createElement("button");
      open.className = "statusActionButton primary";
      open.type = "button";
      open.textContent = "Usage";
      open.title = "Open Chat token usage";
      open.setAttribute("data-open-usage-view", "true");
      actions.appendChild(open);
      root.appendChild(actions);
    }

    function renderCompletionStatusPopover(root) {
      const status = completionStatusInfo();
      appendStatusPopoverHeader(root, status.label, status.title);
      const rows = statusRows();
      appendStatusRow(rows, "Enabled: " + (status.enabled ? "true" : "false"));
      appendStatusRow(rows, "Provider: " + status.provider);
      appendStatusRow(rows, "Model: " + (status.model || "No Qwen Coder completion model"));
      if (status.reason) appendStatusRow(rows, status.reason);
      root.appendChild(rows);
      const actions = document.createElement("div");
      actions.className = "statusPopoverActions";
      const settings = document.createElement("button");
      settings.className = "statusActionButton primary";
      settings.type = "button";
      settings.textContent = "Settings";
      settings.title = "Open Complete settings";
      settings.setAttribute("data-open-complete-settings", "true");
      actions.appendChild(settings);
      root.appendChild(actions);
    }

    function renderQueueStatusPopover(root) {
      const count = queuedSendCount();
      const limit = queuedSendLimit();
      appendStatusPopoverHeader(root, "Queued " + count + "/" + limit, count > 0 ? "Prompts will send automatically after the active reply ends." : "No queued prompts.");
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

	    function statusAction(label, title) {
	      const button = document.createElement("button");
	      button.className = "contextRemoveButton";
	      button.type = "button";
	      button.textContent = label;
	      button.title = title || label;
	      return button;
	    }

		    function appendContextItemDetail(root, item) {
		      const pinned = isContextItemPinned(item);
		      appendStatusRow(root, pinned ? "Pinned context" : "One-time context");
		      const actions = document.createElement("div");
		      actions.className = "statusPopoverActions";
		      const open = statusAction("Open", "Open " + item.path);
		      open.setAttribute("data-open-context-item", item.id);
		      const pin = statusAction(pinned ? "Unpin" : "Pin", contextPinTitle(pinned));
		      pin.setAttribute("data-pin-context-item", item.id);
		      pin.setAttribute("data-pin-context-next", pinned ? "false" : "true");
		      pin.setAttribute("aria-pressed", pinned ? "true" : "false");
		      const remove = statusAction("Remove", "Remove " + contextItemTitle(item));
		      remove.setAttribute("data-remove-context-item", item.id);
		      actions.append(open, pin, remove);
		      root.appendChild(actions);
	      if (item.kind !== "selection") return;
	      const preview = document.createElement("pre");
	      preview.className = "contextPreview";
	      preview.textContent = item.preview || item.inlinePreview || "";
	      root.appendChild(preview);
	      if (item.truncated) appendStatusRow(root, "Selection preview truncated.");
	    }

		    function onComposerStatusPopoverClick(event) {
		      event.stopPropagation();
		      const target = event.target;
	      const goalAction = target.closest("[data-goal-action]");
	      if (goalAction) {
	        handleGoalAction(goalAction.getAttribute("data-goal-action") || "");
	        return;
	      }
			      const removeContext = target.closest("[data-remove-context-item]");
		      if (removeContext) {
		        const id = removeContext.getAttribute("data-remove-context-item") || "";
	        if (selectedContextItemId === id) selectedContextItemId = "";
	        vscode.postMessage({ type: "removeContextItem", id });
		        return;
		      }
		      const pinContext = target.closest("[data-pin-context-item]");
		      if (pinContext) {
		        const id = pinContext.getAttribute("data-pin-context-item") || "";
		        const pinned = pinContext.getAttribute("data-pin-context-next") !== "false";
		        vscode.postMessage({ type: "toggleContextPin", id, pinned });
		        return;
		      }
		      const openContext = target.closest("[data-open-context-item]");
	      if (openContext) {
	        vscode.postMessage({ type: "openContextItem", id: openContext.getAttribute("data-open-context-item") || "" });
	        return;
	      }
	      const selectContext = target.closest("[data-select-context-item]");
	      if (selectContext) {
	        selectedContextItemId = selectContext.getAttribute("data-select-context-item") || "";
	        composerPinnedStatusPopover = "context";
	        composerHoverStatusPopover = "";
	        renderComposerStatusBar();
	        return;
	      }
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
	      const completeSettings = target.closest("[data-open-complete-settings]");
	      if (completeSettings) {
	        openCompleteSettingsFromPopover();
	        return;
	      }
      const usageView = target.closest("[data-open-usage-view]");
      if (usageView) {
        closeComposerStatusPopoverState();
        setMainView("usage");
        return;
      }
		      onCodeGraphAction(event);
		    }

	    function handleGoalAction(action) {
	      if (action === "createGoal") {
	        closeComposerStatusPopoverState();
	        setGoalInputMode(true, { focus: true });
	        return;
	      }
	      if (action === "editGoal") {
	        vscode.postMessage({ type: "editGoal" });
	        closeComposerStatusPopoverState();
	        renderComposerStatusBar();
	        return;
	      }
	      if (action === "pauseGoal" || action === "resumeGoal" || action === "clearGoal") {
	        vscode.postMessage({ type: action });
	        closeComposerStatusPopoverState();
	        renderComposerStatusBar();
	      }
	    }

			    function openRagSettingsFromPopover() {
	      activeSettingsSection = "rag";
	      settingsOpen = true;
	      closeComposerStatusPopoverState();
	      render();
	    }

	    function openCompleteSettingsFromPopover() {
	      activeSettingsSection = "complete";
	      settingsOpen = true;
	      closeComposerStatusPopoverState();
	      render();
	    }

		    function historySessionIds() {
		      return (state.sessions || []).map((session) => session.id).filter(Boolean);
		    }

		    function reconcileHistorySelection() {
		      const liveIds = new Set(historySessionIds());
		      selectedHistorySessionIds = new Set(Array.from(selectedHistorySessionIds).filter((sessionId) => liveIds.has(sessionId)));
		      if (historyBulkSelectMode && liveIds.size === 0) historyBulkSelectMode = false;
		    }

			    function renderHistoryControls() {
			      const total = historySessionIds().length;
			      const selectedCount = selectedHistorySessionIds.size;
			      const allSelected = total > 0 && selectedCount === total;
			      el("historyTitle").textContent = historyBulkSelectMode ? selectedCount + " selected" : "History";
			      el("selectHistorySessions").hidden = total === 0;
			      el("selectAllHistorySessions").hidden = total === 0;
			      el("deleteSelectedHistorySessions").hidden = !historyBulkSelectMode;
			      el("refreshHistory").hidden = historyBulkSelectMode;
			      el("closeHistory").hidden = historyBulkSelectMode;
			      el("selectHistorySessions").setAttribute("aria-pressed", historyBulkSelectMode ? "true" : "false");
			      el("selectHistorySessions").classList.toggle("is-active", historyBulkSelectMode);
			      el("selectAllHistorySessions").disabled = total === 0;
			      el("deleteSelectedHistorySessions").disabled = selectedCount === 0;
			      setHistoryToolbarButton(
			        el("selectHistorySessions"),
			        "enterSelection",
			        historyBulkSelectMode ? "Exit selection mode" : "Select chat history sessions",
			      );
				      setHistoryToolbarButton(
				        el("selectAllHistorySessions"),
				        allSelected ? "deselectAll" : "selectAll",
				        allSelected ? "Deselect all chat history sessions" : "Select all chat history sessions",
				      );
			      setHistoryToolbarButton(
			        el("deleteSelectedHistorySessions"),
			        "delete",
			        selectedCount > 0 ? "Delete " + selectedCount + " selected chat history sessions" : "Delete selected chat history sessions",
			      );
			    }

		    function toggleHistorySessionSelection(sessionID) {
		      if (!sessionID) return;
		      if (selectedHistorySessionIds.has(sessionID)) selectedHistorySessionIds.delete(sessionID);
		      else selectedHistorySessionIds.add(sessionID);
		      render();
		    }

		    function renderSessions() {
	      const root = el("sessionList");
	      root.innerHTML = "";
	      const sessions = state.sessions || [];
	      reconcileHistorySelection();
	      renderHistoryControls();
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
	        const selected = selectedHistorySessionIds.has(session.id);
	        const row = document.createElement("div");
	        row.className = "sessionRow "
	          + (session.id === state.currentSessionID ? "active " : "")
	          + (historyBulkSelectMode ? "selecting " : "")
	          + (selected ? "selected" : "");
	        if (historyBulkSelectMode) {
	          const check = document.createElement("button");
	          check.className = "sessionCheck oc-icon-btn oc-liquid-btn";
		          check.type = "button";
		          check.title = selected ? "Deselect chat history session" : "Select chat history session";
		          check.setAttribute("aria-pressed", selected ? "true" : "false");
		          setIconOnlyButton(check, selected ? "checkboxChecked" : "checkbox", check.title);
		          check.addEventListener("click", () => toggleHistorySessionSelection(session.id));
		          row.appendChild(check);
	        }
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
	          if (historyBulkSelectMode) {
	            toggleHistorySessionSelection(session.id);
	            return;
	          }
	          vscode.postMessage({ type: "selectSession", sessionID: session.id });
	          if (window.innerWidth < 760) {
	            historyTouched = true;
	            historyOpen = false;
	            renderShell();
	          }
	        });
	        row.appendChild(select);
	        if (historyBulkSelectMode) {
	          root.appendChild(row);
	          continue;
	        }
	        const deleteButton = document.createElement("button");
	        deleteButton.className = "sessionDelete oc-icon-btn oc-liquid-btn";
	        deleteButton.type = "button";
        deleteButton.title = "Delete chat history";
	        deleteButton.setAttribute("aria-label", "Delete chat history");
	        deleteButton.innerHTML = LIQUID_ICONS.trash + '<span class="srOnly">Delete chat history</span>';
	        deleteButton.addEventListener("click", () => {
	          vscode.postMessage({ type: "deleteSession", sessionID: session.id });
	        });
	        row.appendChild(deleteButton);
	        root.appendChild(row);
	      }
	    }

	    function renderMessages() {
	      const root = el("messages");
	      const messages = messagesWithOptimisticLocalSends();
	      const stick = autoFollowMessages && (userNearBottom || forceNextMessageFollow);
	      const previousScrollTop = root.scrollTop;
	      const scrollAnchor = stick ? undefined : captureMessagesScrollAnchor(root);
	      const horizontalScrollState = collectMessageHorizontalScrollState(root);
	      if (state.loadingMessages && messages.length === 0) {
	        const loading = document.createElement("div");
	        loading.className = "loadingLine";
	        loading.textContent = "Loading messages...";
	        root.replaceChildren(loading);
	      } else if (messages.length === 0) {
	        root.replaceChildren(emptyState());
	      } else {
	        const activityStatus = assistantActivityStatus(messages);
	        const activityMessageKey = currentTurnActivityMessageKey(messages);
	        const entries = messages.map((item, index) => {
	          const key = stableMessageKey(item, index);
	          const liveToolActivity = activityStatus && key === activityMessageKey ? activityStatus : undefined;
	          return {
	            key,
	            item,
	            index,
	            fingerprint: messageRenderFingerprint(item, index, key, { liveToolActivity }),
	            build: () => messageNode(item, index, { liveToolActivity })
	          };
	        });
		        if (activityStatus && !activityMessageKey) {
		          entries.push({
		            key: "__thinking",
		            fingerprint: assistantActivityFingerprint(activityStatus),
		            build: () => thinkingNode(activityStatus)
		          });
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
	        if (!restoreMessagesScrollAnchor(root, scrollAnchor)) {
	          const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
	          root.scrollTop = Math.min(previousScrollTop, maxScrollTop);
	        }
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
	        if (node) return updateExistingMessageNode(node, entry);
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

	    function captureMessagesScrollAnchor(root) {
	      const rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { top: 0, bottom: root.clientHeight };
	      const topLimit = rootRect.top + 6;
	      const bottomLimit = rootRect.bottom || (rootRect.top + root.clientHeight);
	      for (const node of Array.from(root.querySelectorAll(".timelineItem[data-message-key]"))) {
	        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : undefined;
	        if (!rect) continue;
	        if (rect.bottom <= topLimit || rect.top >= bottomLimit) continue;
	        return {
	          key: node.getAttribute("data-message-key") || "",
	          topOffset: rect.top - rootRect.top
	        };
	      }
	      return undefined;
	    }

	    function restoreMessagesScrollAnchor(root, anchor) {
	      if (!anchor || !anchor.key) return false;
	      const node = findMessageNodeByKey(root, anchor.key);
	      if (!node || !node.getBoundingClientRect) return false;
	      const rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { top: 0 };
	      const rect = node.getBoundingClientRect();
	      const delta = rect.top - rootRect.top - anchor.topOffset;
	      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
	      root.scrollTop = Math.max(0, Math.min(maxScrollTop, root.scrollTop + delta));
	      return true;
	    }

	    function findMessageNodeByKey(root, key) {
	      for (const node of Array.from(root.querySelectorAll(".timelineItem[data-message-key]"))) {
	        if (node.getAttribute("data-message-key") === key) return node;
	      }
	      return undefined;
	    }

	    function updateExistingMessageNode(node, entry) {
	      const replacement = entry.build();
	      node.className = replacement.className + " streamStable";
	      node.setAttribute("data-message-key", entry.key);
	      node.setAttribute("data-message-fingerprint", entry.fingerprint);
	      node.setAttribute("data-stream-stable", "true");
	      const currentAvatar = directChildWithClass(node, "avatar");
	      const replacementAvatar = directChildWithClass(replacement, "avatar");
	      const currentCard = directChildWithClass(node, "messageCard");
	      const replacementCard = directChildWithClass(replacement, "messageCard");
	      if (!currentAvatar || !replacementAvatar || !currentCard || !replacementCard) {
	        node.replaceChildren(...Array.from(replacement.childNodes));
	        return node;
	      }
	      replaceElementContents(currentAvatar, replacementAvatar);
	      replaceElementContents(currentCard, replacementCard);
	      return node;
	    }

	    function directChildWithClass(root, className) {
	      return Array.from(root.children).find((child) => child.classList.contains(className));
	    }

	    function replaceElementContents(target, replacement) {
	      syncElementAttributes(target, replacement);
	      target.replaceChildren(...Array.from(replacement.childNodes));
	    }

	    function syncElementAttributes(target, replacement) {
	      for (const attr of Array.from(target.attributes)) {
	        if (!replacement.hasAttribute(attr.name)) target.removeAttribute(attr.name);
	      }
	      for (const attr of Array.from(replacement.attributes)) {
	        target.setAttribute(attr.name, attr.value);
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
		          diagramScrollTop: Array.from(card.querySelectorAll(".diagramCanvas")).map((node) => node.scrollTop),
		          diagramZoom: Array.from(card.querySelectorAll(".diagramBlock")).map((node) => Number(node.dataset.diagramZoom) || DIAGRAM_ZOOM_DEFAULT),
		          tableScrollLeft: Array.from(card.querySelectorAll(".tableScroll")).map((node) => node.scrollLeft),
		          tableRawScrollLeft: Array.from(card.querySelectorAll(".tableRaw")).map((node) => node.scrollLeft)
		        };
		        if (
		          stateForMessage.outlineScrollLeft.some(Boolean) ||
		          stateForMessage.codeScrollLeft.some(Boolean) ||
		          stateForMessage.diagramScrollLeft.some(Boolean) ||
		          stateForMessage.diagramScrollTop.some(Boolean) ||
		          stateForMessage.diagramZoom.some((value) => value !== DIAGRAM_ZOOM_DEFAULT) ||
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
		        restoreNestedScrollList(card.querySelectorAll(".diagramCanvas"), saved && saved.diagramScrollTop, "scrollTop");
		        restoreDiagramZoomList(card.querySelectorAll(".diagramBlock"), saved && saved.diagramZoom);
		        restoreNestedScrollList(card.querySelectorAll(".tableScroll"), saved && saved.tableScrollLeft, "scrollLeft");
		        restoreNestedScrollList(card.querySelectorAll(".tableRaw"), saved && saved.tableRawScrollLeft, "scrollLeft");
		      }
		    }

		    function restoreDiagramZoomList(nodes, values) {
		      if (!values) return;
		      Array.from(nodes).forEach((node, index) => {
		        setDiagramZoom(node, values[index] || DIAGRAM_ZOOM_DEFAULT);
		      });
		    }

			    function restoreNestedScrollList(nodes, values, property) {
		      if (!values) return;
		      Array.from(nodes).forEach((node, index) => {
		        const value = values[index] || 0;
		        if (value > 0) node[property] = value;
		      });
		    }

		    function preserveMessagesScrollDuringDiagramRender(block, mutate) {
		      const root = el("messages");
		      if (!root || !block || !block.isConnected) return mutate();
		      const before = diagramViewportMetrics(root, block);
		      const beforeScrollTop = root.scrollTop;
		      const shouldFollowLatest = autoFollowMessages && (userNearBottom || isNearBottom(root) || forceNextMessageFollow);
		      const result = mutate();
		      if (!root.isConnected || !block.isConnected) return result;
		      if (shouldFollowLatest) {
		        root.scrollTop = root.scrollHeight;
		        userNearBottom = true;
		        autoFollowMessages = true;
		      } else {
		        const after = diagramViewportMetrics(root, block);
		        const delta = diagramScrollAnchorDelta(before, after, root.clientHeight);
		        const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
		        root.scrollTop = Math.max(0, Math.min(maxScrollTop, beforeScrollTop + delta));
		        userNearBottom = isNearBottom(root);
		        autoFollowMessages = false;
		      }
		      forceNextMessageFollow = false;
		      lastMessagesScrollTop = root.scrollTop;
		      renderJumpLatest();
		      return result;
		    }

		    function diagramViewportMetrics(root, block) {
		      const rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { top: 0 };
		      const blockRect = block.getBoundingClientRect ? block.getBoundingClientRect() : { top: 0, bottom: 0, height: 0 };
		      const top = blockRect.top - rootRect.top;
		      const bottom = blockRect.bottom - rootRect.top;
		      return {
		        top,
		        bottom,
		        height: Math.max(0, blockRect.height || bottom - top),
		      };
		    }

		    function diagramScrollAnchorDelta(before, after, viewportHeight) {
		      if (before.bottom <= 0) return after.height - before.height;
		      if (before.top < viewportHeight && before.bottom > 0) return after.top - before.top;
		      return 0;
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
		      if (nested.classList && nested.classList.contains("diagramCanvas") && nested.classList.contains("zoomed-in")) {
		        return redirectZoomedDiagramWheel(event, root, nested);
		      }
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

		    function redirectZoomedDiagramWheel(event, root, canvas) {
		      if (!isPlainVerticalWheel(event)) {
		        pauseAutoFollowForUser();
		        return false;
		      }
		      const previousCanvasScrollTop = canvas.scrollTop;
		      const nextCanvasScrollTop = clampScrollTop(canvas, canvas.scrollTop + event.deltaY);
		      canvas.scrollTop = nextCanvasScrollTop;
		      const consumedDeltaY = nextCanvasScrollTop - previousCanvasScrollTop;
		      const remainingDeltaY = event.deltaY - consumedDeltaY;
		      pauseAutoFollowForUser();
		      event.preventDefault();
		      root.scrollTop += remainingDeltaY;
		      handleMessagesScroll(root);
		      return true;
		    }

		    function clampScrollTop(node, value) {
		      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
		      return Math.max(0, Math.min(maxScrollTop, value));
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
	      const visible = Boolean(activeMainView !== "usage" && !autoFollowMessages && !userNearBottom && messageHasAnyContent(messagesWithOptimisticLocalSends()));
	      button.classList.toggle("visible", visible);
        button.hidden = activeMainView === "usage";
	      button.setAttribute("aria-hidden", visible ? "false" : "true");
	      button.tabIndex = visible ? 0 : -1;
	    }

	    function messageHasAnyContent(messages) {
	      return messages.some((item) => messageHasContent(item));
	    }

	    function currentTurnActivityMessageKey(messages) {
	      for (let index = messages.length - 1; index >= 0; index -= 1) {
	        const item = messages[index];
	        if (item.role === "user") return undefined;
	        if ((item.role === "assistant" || item.role === "tool") && messageHasContent(item)) {
	          return stableMessageKey(item, index);
	        }
	      }
	      return undefined;
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

	    function assistantActivityStatus(messages) {
	      if (!state.sending) return undefined;
	      const active = activeSendActivityStatus();
	      if (active) return active;
	      for (let index = messages.length - 1; index >= 0; index -= 1) {
	        const item = messages[index];
	        if (item.role !== "user") continue;
	        const status = sendStatusFromMessage(item);
	        if (!status) return { stage: "thinking", label: "Thinking", detail: "" };
	        if (status.stage === "summarizing" || status.stage === "sending" || status.stage === "thinking" || status.stage === "done") return status;
	        return undefined;
	      }
	      return { stage: "thinking", label: "Thinking", detail: "" };
	    }

	    function activeSendActivityStatus() {
	      const activity = state.activeSendActivity;
	      if (!activity || typeof activity !== "object") return undefined;
	      const startedAt = Number(activity.startedAt) || 0;
	      const toolCallCount = Number(activity.toolCallCount) || 0;
	      return {
	        stage: String(activity.stage || "thinking"),
	        label: "",
	        detail: String(activity.detail || ""),
	        startedAt: startedAt > 0 ? startedAt : undefined,
	        currentToolName: compactActivityText(activity.currentToolName),
	        toolCallCount: toolCallCount > 0 ? toolCallCount : 0
	      };
	    }

	    function assistantActivityLabel(status) {
	      const toolName = compactActivityText(status && status.currentToolName);
	      const stepLabel = assistantActivityStepLabel(status);
	      if (toolName) return ["Using " + toolName, stepLabel].filter(Boolean).join(" · ");
	      if (stepLabel) return stepLabel;
	      if (status && status.stage === "summarizing") return "Summarizing conversation history";
	      if (status && status.stage === "sending") return "Sending to model";
	      if (status && status.stage === "preparing") return "Preparing context";
	      return "Thinking";
	    }

	    function assistantActivityStepLabel(status) {
	      const detail = String((status && status.detail) || "");
	      const match = detail.match(/tool step\\s+(\\d+)/i);
	      if (match) return "Tool step " + match[1];
	      const count = Number(status && status.toolCallCount) || 0;
	      if (count > 0) return count === 1 ? "1 tool call" : count + " tool calls";
	      return "";
	    }

	    function compactActivityText(value) {
	      return String(value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
	    }

	    function assistantActivityElapsedText(status) {
	      const startedAt = Number(status && status.startedAt) || 0;
	      if (startedAt <= 0) return "";
	      return formatActivityElapsed(Date.now() - startedAt);
	    }

	    function formatActivityElapsed(elapsedMs) {
	      const seconds = Math.max(0, Math.floor(Number(elapsedMs || 0) / 1000));
	      if (seconds < 60) return seconds + "s";
	      const minutes = Math.floor(seconds / 60);
	      const remaining = seconds % 60;
	      if (minutes < 60) return minutes + "m " + String(remaining).padStart(2, "0") + "s";
	      const hours = Math.floor(minutes / 60);
	      const minuteRemainder = minutes % 60;
	      return hours + "h " + String(minuteRemainder).padStart(2, "0") + "m";
	    }

	    function syncActiveActivityElapsedTimer() {
	      const hasElapsedActivity = Boolean(state.sending && state.activeSendActivity && Number(state.activeSendActivity.startedAt));
	      if (hasElapsedActivity && !activeActivityElapsedTimer) {
	        activeActivityElapsedTimer = window.setInterval(updateActiveActivityElapsedNodes, 1000);
	      } else if (!hasElapsedActivity && activeActivityElapsedTimer) {
	        window.clearInterval(activeActivityElapsedTimer);
	        activeActivityElapsedTimer = 0;
	      }
	      updateActiveActivityElapsedNodes();
	    }

	    function updateActiveActivityElapsedNodes() {
	      const status = assistantActivityStatus(state.messages || []);
	      const text = assistantActivityElapsedText(status);
	      for (const node of Array.from(document.querySelectorAll("[data-active-activity-elapsed]"))) {
	        node.textContent = text;
	        node.classList.toggle("is-empty", !text);
	      }
	    }

	    function assistantActivityFingerprint(status) {
	      return [
	        "thinking",
	        (status && status.stage) || "thinking",
	        assistantActivityLabel(status),
	        (status && status.detail) || "",
	        (status && status.startedAt) || "",
	        (status && status.currentToolName) || "",
	        (status && status.toolCallCount) || ""
	      ].map((part) => String(part || "").replace(/\s+/g, " ").trim()).join(":");
	    }

    function messageHasContent(item) {
      if (item.text) return true;
      return (item.parts || []).some((part) => part.text || part.detail || part.status || part.xml || part.type === "diagram" || part.type === "wordRender" || part.type === "runProgress");
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

	    function messageNode(item, index, options) {
	      const messageKey = stableMessageKey(item, index);
	      const bodyId = "message-body-" + domSafeId(messageKey);
	      const node = document.createElement("article");
	      node.className = "timelineItem " + (item.role || "message");
	      node.setAttribute("data-message-key", messageKey);
	      node.setAttribute("data-message-fingerprint", messageRenderFingerprint(item, index, messageKey, options));
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
      const sendStatus = sendStatusFromMessage(item);
      if (sendStatus) stats.appendChild(sendStatusNode(sendStatus));
	      const body = document.createElement("div");
	      body.className = "messageBody";
	      body.id = bodyId;
	      if (item.text) renderMarkdownInto(body, item.text);
	      renderPartCards(body, item, options);
	      tagMessageDiagramBlocks(body, item);
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

	    function messageRenderFingerprint(item, index, messageKey, options) {
	      const payload = {
	        role: item.role || "message",
	        text: item.text || "",
	        parts: item.parts || [],
	        sendStatus: item.sendStatus || null,
	        usage: item.usage || null,
	        timeCreated: item.timeCreated || "",
	        collapsed: collapsedMessages.has(messageKey || stableMessageKey(item, index)),
	        liveToolActivity: options && options.liveToolActivity ? assistantActivityFingerprint(options.liveToolActivity) : ""
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

    function tagMessageDiagramBlocks(body, item) {
      const messageId = String(item && item.id || "");
      if (!messageId) return;
      const blocks = Array.from(body.querySelectorAll(".diagramBlock"));
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        block.dataset.messageId = messageId;
        block.dataset.sessionId = String(state.currentSessionID || "");
        block.dataset.messageMode = String(item && item.mode || "");
        block.dataset.diagramIndex = String(index + 1);
        if (!block.dataset.diagramId) {
          block.dataset.diagramId = messageId + "-diagram-" + (index + 1);
        }
      }
    }

    function sendStatusFromMessage(item) {
      if (item && item.sendStatus && item.sendStatus.label) return item.sendStatus;
      const part = (item.parts || []).find((candidate) => candidate && candidate.type === "sendStatus");
      if (!part || !part.text) return undefined;
      return {
        stage: part.status || "pending",
        label: part.text,
        detail: part.detail || ""
      };
    }

    function sendStatusNode(status) {
      const node = document.createElement("span");
      node.className = "messageSendStatus " + String(status.stage || "pending");
      const text = document.createElement("span");
      text.className = "messageSendStatusText";
      text.textContent = status.label || "Sending";
      node.title = [status.label, status.detail].filter(Boolean).join(" · ");
      node.appendChild(text);
      return node;
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

		    function thinkingNode(status) {
		      const node = document.createElement("article");
		      node.className = "timelineItem assistant thinking";
		      node.setAttribute("data-message-key", "__thinking");
		      node.setAttribute("data-message-fingerprint", assistantActivityFingerprint(status));
	      const avatar = document.createElement("div");
      avatar.className = "avatar";
      setAvatarContent(avatar, "assistant");
      const card = document.createElement("div");
      card.className = "messageCard";
      const meta = document.createElement("div");
      meta.className = "messageMeta";
      meta.textContent = "ChipMate";
	      const body = document.createElement("div");
	      body.className = "messageBody activityRow";
	      const label = document.createElement("span");
	      label.className = "activityLabel";
	      label.textContent = assistantActivityLabel(status);
      const elapsed = document.createElement("span");
      elapsed.className = "activityElapsed";
      elapsed.setAttribute("data-active-activity-elapsed", "true");
      elapsed.textContent = assistantActivityElapsedText(status);
      elapsed.classList.toggle("is-empty", !elapsed.textContent);
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      body.append(label);
      if (elapsed.textContent) {
        const separator = document.createElement("span");
        separator.className = "activitySeparator";
        separator.textContent = "·";
        body.append(separator, elapsed);
      } else {
        body.appendChild(elapsed);
      }
      body.appendChild(dots);
      card.append(meta, body);
      node.append(avatar, card);
      return node;
    }

    function toolLiveActivityStatus(status, toolParts) {
      if (!status || !toolParts.length) return undefined;
      const toolName = compactActivityText(status.currentToolName);
      if (!toolName) return undefined;
      return {
        ...status,
        currentToolName: toolName,
      };
    }

    function toolLiveActivityRow(status) {
      const row = document.createElement("div");
      row.className = "toolLiveActivityRow activityRow";
      const label = document.createElement("span");
      label.className = "activityLabel";
      label.textContent = assistantActivityLabel(status);
      const elapsed = document.createElement("span");
      elapsed.className = "activityElapsed";
      elapsed.setAttribute("data-active-activity-elapsed", "true");
      elapsed.textContent = assistantActivityElapsedText(status);
      elapsed.classList.toggle("is-empty", !elapsed.textContent);
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.setAttribute("aria-hidden", "true");
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      row.append(label);
      if (elapsed.textContent) {
        const separator = document.createElement("span");
        separator.className = "activitySeparator";
        separator.textContent = "·";
        row.append(separator, elapsed);
      } else {
        row.appendChild(elapsed);
      }
      row.appendChild(dots);
      return row;
    }

    function renderPartCards(root, item, options) {
      const parts = item.parts || [];
      const reasoningParts = parts.filter((part) => part.type === "reasoning");
      const clarificationParts = parts.filter((part) => part.type === "clarification");
      const runProgressParts = parts.filter((part) => part.type === "runProgress");
      const diagramParts = parts.filter((part) => part.type === "diagram");
      const processDiagramParts = diagramParts.filter(isProcessDiagramPart);
      const inlineDiagramParts = diagramParts.filter((part) => !isProcessDiagramPart(part));
      const toolParts = parts.filter((part) => part.type === "tool");
      const liveToolActivity = toolLiveActivityStatus(options && options.liveToolActivity, toolParts);
      const warningParts = parts.filter((part) => part.type === "serverToolWarning");
      const docTimelineParts = parts.filter((part) => part.type === "docAgentTimeline");
      const docConflictParts = parts.filter((part) => part.type === "docAgentConflictReview");
      const generatedParts = parts.filter((part) => part.type === "generatedDocument");
      const wordRenderParts = parts.filter((part) => part.type === "wordRender");
      for (const part of reasoningParts) {
        root.appendChild(partCard(part, "Thinking", "reasoning"));
      }
      for (const part of clarificationParts) {
        root.appendChild(clarificationCard(part));
      }
      const processStrip = turnProcessStrip({
        runProgressParts,
        toolParts,
        liveToolActivity,
        diagramParts: processDiagramParts,
        docTimelineParts,
        generatedParts,
        wordRenderParts,
      });
      if (processStrip) root.appendChild(processStrip);
      for (const part of inlineDiagramParts) {
        root.appendChild(diagramPartCard(part));
      }
      for (const part of warningParts) {
        root.appendChild(partCard(part, "Warning: workspace filesystem tool used", "serverWarning"));
      }
      for (const part of docConflictParts) {
        root.appendChild(docAgentConflictCard(part));
      }
    }

    function clarificationCard(part) {
      const card = document.createElement("section");
      card.className = "clarificationCard";
      card.setAttribute("data-clarification-card", part.clarificationId || "");
      const answered = part.status === "answered";
      const cancelled = part.status === "cancelled";
      const head = document.createElement("div");
      head.className = "clarificationHead";
      const title = document.createElement("div");
      title.className = "clarificationTitle";
      title.textContent = answered ? "已收到澄清回答" : cancelled ? "澄清已取消" : "需要你的确认";
      title.title = part.title || title.textContent;
      const status = document.createElement("span");
      status.className = "clarificationStatus";
      status.textContent = answered ? "已回答" : cancelled ? "已取消" : "等待你的回答";
      head.append(title, status);
      card.appendChild(head);
      if (part.detail) {
        const reason = document.createElement("div");
        reason.className = "clarificationReason";
        reason.textContent = part.detail;
        card.appendChild(reason);
      }
      for (const question of part.questions || []) {
        card.appendChild(clarificationQuestionNode(part, question, answered || cancelled));
      }
      if (answered && Array.isArray(part.answers) && part.answers.length) {
        const summary = document.createElement("div");
        summary.className = "clarificationAnswerSummary";
        summary.textContent = "回答：" + part.answers.map((answer) => answer.text || answer.choiceId || "").filter(Boolean).join("；");
        card.appendChild(summary);
      } else if (!cancelled) {
        const actions = document.createElement("div");
        actions.className = "clarificationActions";
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "statusActionButton primary";
        submit.textContent = "确认并继续";
        submit.setAttribute("data-clarification-submit", part.clarificationId || "");
        actions.appendChild(submit);
        card.appendChild(actions);
      }
      return card;
    }

    function clarificationQuestionNode(part, question, disabled) {
      const node = document.createElement("div");
      node.className = "clarificationQuestion";
      node.setAttribute("data-clarification-question", question.id || "");
      const text = document.createElement("div");
      text.className = "clarificationQuestionText";
      text.textContent = question.question || "";
      node.appendChild(text);
      if (Array.isArray(question.choices) && question.choices.length) {
        const choices = document.createElement("div");
        choices.className = "clarificationChoices";
        for (const choice of question.choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "statusActionButton clarificationChoice";
          button.textContent = choice.label || choice.id || "Choice";
          button.title = choice.description || button.textContent;
          button.disabled = Boolean(disabled);
          button.setAttribute("data-clarification-choice", part.clarificationId || "");
          button.setAttribute("data-clarification-question-id", question.id || "");
          button.setAttribute("data-clarification-choice-id", choice.id || "");
          button.setAttribute("data-clarification-choice-label", choice.label || "");
          choices.appendChild(button);
        }
        node.appendChild(choices);
      }
      if (question.allowFreeText && !disabled) {
        const input = document.createElement("textarea");
        input.className = "clarificationFreeText";
        input.rows = 2;
        input.placeholder = "输入自定义回答";
        input.setAttribute("data-clarification-free-text", question.id || "");
        node.appendChild(input);
      }
      return node;
    }

    function isProcessDiagramPart(part) {
      if (!part || part.type !== "diagram") return false;
      const kind = String(part.kind || "").toLowerCase();
      if (part.source === "tool") return true;
      return kind === "mermaid" && part.displayMode === "artifact";
    }

    function turnProcessStrip(input) {
      const model = turnProcessModel(input);
      if (!model.shouldRender) return undefined;
      const details = document.createElement("details");
      details.className = "turnProcessStrip"
        + (model.running ? " is-running" : "")
        + (model.warningCount > 0 || model.fallbackCount > 0 || (model.failedCount > 0 && !model.blockingFailed) ? " has-warning" : "")
        + (model.blockingFailed ? " has-error" : "");
      if (model.hasPendingApproval) details.open = true;
      const summary = document.createElement("summary");
      summary.className = "turnProcessSummary";
      const marker = document.createElement("span");
      marker.className = "turnProcessMarker";
      marker.textContent = model.running ? "▸" : model.blockingFailed ? "!" : "✓";
      const label = document.createElement("span");
      label.className = "turnProcessLabel";
      label.textContent = model.summary;
      label.title = model.summary;
      summary.append(marker, label);
      if (model.primaryDocumentPath) {
        const path = document.createElement("span");
        path.className = "turnProcessPath";
        path.textContent = "生成位置: " + model.primaryDocumentPath;
        path.title = model.primaryDocumentPath;
        summary.appendChild(path);
      }
      const meta = document.createElement("span");
      meta.className = "turnProcessMeta";
      if (model.progressText) appendTurnProcessMeta(meta, model.progressText);
      if (model.mermaidPngCount) appendTurnProcessMeta(meta, "Mermaid PNG " + String(model.mermaidPngCount) + " 张");
      if (model.elapsedText) appendTurnProcessMeta(meta, model.elapsedText);
      if (model.warningCount) appendTurnProcessMeta(meta, "Warning " + String(model.warningCount));
      if (model.fallbackCount) appendTurnProcessMeta(meta, "Fallback " + String(model.fallbackCount));
      if (meta.childElementCount) summary.appendChild(meta);
      const actions = document.createElement("span");
      actions.className = "turnProcessActions";
      if (model.primaryDocumentPath) actions.appendChild(turnProcessArtifactButton(model.primaryDocumentPath, "打开", "external", true));
      if (model.primaryDocumentPath) actions.appendChild(turnProcessArtifactButton(model.primaryDocumentPath, "显示", "reveal", false));
      const detailHint = document.createElement("span");
      detailHint.className = "turnProcessDetailHint";
      detailHint.textContent = "详情";
      actions.appendChild(detailHint);
      summary.appendChild(actions);
      const body = document.createElement("div");
      body.className = "turnProcessBody";
      const warnings = turnProcessWarningList(input);
      if (warnings.length) body.appendChild(turnProcessTextBlock("提示", warnings.slice(0, 10).join("\\n"), "turnProcessWarnings"));
      const steps = turnProcessStepLines(input);
      if (steps.length) body.appendChild(turnProcessTextBlock("执行步骤", steps.slice(-48).join("\\n"), "turnProcessSteps"));
      const artifacts = turnProcessArtifactLines(input);
      if (artifacts.length) body.appendChild(turnProcessTextBlock("Artifacts", artifacts.slice(0, 80).join("\\n"), "turnProcessArtifacts"));
      body.appendChild(turnProcessDetailCards(input));
      details.append(summary, body);
      return details;
    }

    function turnProcessModel(input) {
      const runProgressParts = input.runProgressParts || [];
      const toolParts = input.toolParts || [];
      const diagramParts = input.diagramParts || [];
      const docTimelineParts = input.docTimelineParts || [];
      const generatedParts = input.generatedParts || [];
      const wordRenderParts = input.wordRenderParts || [];
      const running = Boolean(input.liveToolActivity)
        || runProgressParts.some((part) => isRunningStatus(part.status))
        || toolParts.some((part) => isRunningStatus(part.status))
        || docTimelineParts.some((part) => isRunningStatus(part.status));
      const hasPendingApproval = toolParts.some(isPendingToolApproval);
      const failedCount = toolParts.filter((part) => isFailedStatus(part.status)).length
        + runProgressParts.filter((part) => isFailedStatus(part.status)).length
        + docTimelineParts.filter((part) => isFailedStatus(part.status)).length
        + wordRenderParts.filter((part) => part.ok === false).length;
      const warningCount = turnProcessWarningList(input).length;
      const mermaidPngCount = diagramParts.filter((part) => String(part.kind || "").toLowerCase() === "mermaid" && part.pngPath).length;
      const primaryDocument = generatedParts.slice().reverse().find((part) => part.path) || wordRenderParts.slice().reverse().find((part) => part.path);
      const progressArtifacts = turnProcessProgressArtifactPaths(input);
      const primaryDocumentPath = primaryDocument ? primaryDocument.path : "";
      const recoveredArgumentFailureCount = primaryDocumentPath ? turnProcessRecoveredArgumentFailureCount(input) : 0;
      const fallbackCount = diagramParts.filter((part) => part.fallbackUsed).length
        + (primaryDocumentPath ? 0 : runProgressParts.reduce((sum, part) => sum + Number(part.fallbackCount || 0), 0))
        + (primaryDocumentPath ? 0 : docTimelineParts.reduce((sum, part) => sum + Number(part.fallbackCount || 0), 0));
      const requestedDocumentPath = primaryDocumentPath ? "" : turnProcessRequestedDocumentPath(input);
      const progressSource = latestProgressPart(runProgressParts) || latestProgressPart(docTimelineParts);
      const progressText = progressSource && progressSource.total ? String(progressSource.current || 0) + "/" + String(progressSource.total) + " 步" : "";
      const elapsedSource = progressSource && progressSource.startedAt ? progressSource : runProgressParts.find((part) => part.startedAt) || docTimelineParts.find((part) => part.startedAt);
      const elapsedText = elapsedSource && elapsedSource.startedAt && (running || elapsedSource.status !== "completed") ? elapsedLabel(elapsedSource.startedAt) : "";
      const hasProcessParts = runProgressParts.length || toolParts.length || diagramParts.length || docTimelineParts.length || generatedParts.length || wordRenderParts.length || input.liveToolActivity;
      const hasImportantArtifact = Boolean(primaryDocumentPath)
        || diagramParts.some((part) => part.pngPath || part.mmdPath)
        || wordRenderParts.some((part) => part.pdfArtifactPath || (Array.isArray(part.pagePngPaths) && part.pagePngPaths.length));
      const shouldRender = Boolean(hasProcessParts && (running || hasPendingApproval || failedCount > 0 || warningCount > 0 || fallbackCount > 0 || hasImportantArtifact));
      const blockingFailed = failedCount > 0 && !primaryDocumentPath;
      return {
        shouldRender,
        running,
        hasPendingApproval,
        failedCount,
        blockingFailed,
        warningCount,
        fallbackCount,
        mermaidPngCount,
        progressText,
        elapsedText,
        primaryDocumentPath,
        requestedDocumentPath,
        summary: turnProcessSummaryText({
          running,
          failedCount,
          warningCount,
          fallbackCount,
          primaryDocumentPath,
          requestedDocumentPath,
          generatedParts,
          diagramParts,
          wordRenderParts,
          currentStep: turnProcessCurrentStep(input),
          recoveredArgumentFailureCount,
        }),
      };
    }

    function turnProcessSummaryText(model) {
      const important = [];
      const skipped = model.wordRenderParts.find((part) => part.visualQaStatus === "skipped" || part.attempted === false);
      if (skipped) important.push("视觉 QA 已跳过：" + wordRenderSkipReasonText(skipped.skipReason));
      if (model.fallbackCount) important.push("Mermaid 使用 fallback");
      if (model.primaryDocumentPath && model.recoveredArgumentFailureCount) important.push("已自动修复 " + String(model.recoveredArgumentFailureCount) + " 次工具参数错误");
      if (model.failedCount && !(model.primaryDocumentPath && model.recoveredArgumentFailureCount && model.recoveredArgumentFailureCount >= model.failedCount)) important.push(model.primaryDocumentPath ? "有重试失败" : "存在失败步骤");
      if (model.primaryDocumentPath) {
        return ["Word 文档已生成", basenameForDisplay(model.primaryDocumentPath), ...important].filter(Boolean).join(" · ");
      }
      if (model.failedCount && model.requestedDocumentPath) {
        return ["Word 生成失败", basenameForDisplay(model.requestedDocumentPath), ...important.filter((item) => item !== "存在失败步骤")].filter(Boolean).join(" · ");
      }
      if (model.diagramParts.length) {
        const label = model.running ? "正在生成图表" : "图表已生成";
        return [label, ...important].filter(Boolean).join(" · ");
      }
      if (model.wordRenderParts.length) {
        const label = model.running ? "正在进行 Word 视觉 QA" : skipped ? "Word 视觉 QA 已跳过" : "Word 视觉 QA 已完成";
        return [label, ...important.filter((item) => !item.startsWith("视觉 QA"))].filter(Boolean).join(" · ");
      }
      if (model.running) return ["正在处理", model.currentStep].filter(Boolean).join(" · ");
      if (model.failedCount) return "执行过程存在失败";
      if (model.warningCount || model.fallbackCount) return "执行完成但有提示";
      return "执行过程";
    }

    function basenameForDisplay(path) {
      const text = String(path || "");
      const parts = text.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || text;
    }

    function latestProgressPart(parts) {
      return (parts || []).slice().sort((a, b) => Number(b.updatedAt || b.startedAt || 0) - Number(a.updatedAt || a.startedAt || 0))[0];
    }

    function isRunningStatus(status) {
      const value = String(status || "");
      return value === "running" || value === "waiting" || value === "user-input-required" || value === "approval-required";
    }

    function isFailedStatus(status) {
      const value = String(status || "");
      return value === "failed" || value === "error" || value === "blocked";
    }

    function turnProcessCurrentStep(input) {
      if (input.liveToolActivity) return assistantActivityLabel(input.liveToolActivity);
      const progress = latestProgressPart(input.runProgressParts || []);
      const items = progress && Array.isArray(progress.items) ? progress.items : [];
      const runningItem = items.slice().reverse().find((item) => item && isRunningStatus(item.status));
      if (runningItem) return runningItem.title || runningItem.tool || "";
      const latestItem = items[items.length - 1];
      if (latestItem) return latestItem.title || latestItem.tool || "";
      const tool = (input.toolParts || []).slice().reverse().find(Boolean);
      return tool ? tool.title || "" : "";
    }

    function appendTurnProcessMeta(root, text) {
      const item = document.createElement("span");
      item.className = "turnProcessMetaItem";
      item.textContent = text;
      root.appendChild(item);
    }

    function turnProcessArtifactButton(path, label, mode, primary) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "statusActionButton turnProcessAction" + (primary ? " primary" : "");
      button.textContent = label;
      button.title = label + ": " + path;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "openGeneratedDocument", path, mode: mode || "external" });
      });
      return button;
    }

    function turnProcessWarningList(input) {
      const warnings = [];
      const deliveredDocumentPath = turnProcessDeliveredDocumentPath(input);
      for (const part of input.generatedParts || []) {
        const filteredWarnings = filteredGeneratedDocumentWarnings(input, part);
        if (filteredWarnings.length) warnings.push("Word 文档 warning " + String(filteredWarnings.length) + " 条");
        for (const item of filteredWarnings) warnings.push(String(item));
      }
      for (const part of input.diagramParts || []) {
        if (part.fallbackUsed) warnings.push((part.title || "Mermaid 图表") + " 使用 fallback renderer");
        if (String(part.kind || "").toLowerCase() === "mermaid" && !part.pngPath) warnings.push((part.title || "Mermaid 图表") + " 未生成 PNG");
        for (const item of part.warnings || []) warnings.push(String(item));
      }
      for (const part of input.wordRenderParts || []) {
        if (isStaleWordRenderPart(input, part)) continue;
        if (part.visualQaStatus === "skipped" || part.attempted === false) warnings.push("页面级视觉 QA 已跳过：" + wordRenderSkipReasonText(part.skipReason));
        if (part.ok === false) warnings.push("Word render QA 返回风险状态");
        for (const item of part.warnings || []) warnings.push(String(item));
      }
      for (const part of input.runProgressParts || []) {
        if (deliveredDocumentPath) continue;
        if (part.warningCount) warnings.push("执行进度 warning " + String(part.warningCount) + " 条");
        if (part.fallbackCount) warnings.push("执行进度 fallback " + String(part.fallbackCount) + " 次");
      }
      for (const part of input.docTimelineParts || []) {
        if (deliveredDocumentPath) continue;
        if (part.warningCount) warnings.push("文档生成 warning " + String(part.warningCount) + " 条");
        if (part.fallbackCount) warnings.push("文档生成 fallback " + String(part.fallbackCount) + " 次");
      }
      for (const part of input.toolParts || []) {
        if (deliveredDocumentPath) continue;
        if (isFailedStatus(part.status)) warnings.push(toolSummaryLabel(part));
      }
      return uniqueStrings(warnings).filter(Boolean);
    }

    function turnProcessDeliveredDocumentPath(input) {
      const generated = (input.generatedParts || []).slice().reverse().find((part) => part.path);
      if (generated) return generated.path || "";
      const rendered = (input.wordRenderParts || []).slice().reverse().find((part) => part.path);
      return rendered ? rendered.path || "" : "";
    }

    function filteredGeneratedDocumentWarnings(input, part) {
      const items = Array.isArray(part.warnings) ? part.warnings : [];
      if (!items.length) return [];
      return items.map((item) => String(item || "").trim()).filter((item) => {
        if (!item) return false;
        return !isStaleGeneratedDocumentWarning(input, part, item);
      });
    }

    function isStaleGeneratedDocumentWarning(input, part, warning) {
      if (!hasCompletedWordRenderForPath(input, part.path)) return false;
      return /remote-word-render-unconfigured/i.test(warning)
        || /Remote Word render server is not configured/i.test(warning)
        || /page-level visual QA was skipped/i.test(warning);
    }

    function isStaleWordRenderPart(input, part) {
      if (!(part.visualQaStatus === "skipped" || part.attempted === false || part.ok === false)) return false;
      return hasCompletedWordRenderForPath(input, part.path);
    }

    function hasCompletedWordRenderForPath(input, path) {
      const target = comparableArtifactPath(path);
      if (!target) return false;
      return (input.wordRenderParts || []).some((part) => {
        if (part === undefined || comparableArtifactPath(part.path) !== target) return false;
        if (part.visualQaStatus === "skipped" || part.attempted === false || part.ok === false) return false;
        const pages = Array.isArray(part.pagePngPaths) ? part.pagePngPaths : [];
        return part.visualQaStatus === "completed" || Boolean(part.pdfArtifactPath) || pages.length > 0;
      });
    }

    function comparableArtifactPath(path) {
      const text = String(path || "").split(String.fromCharCode(92)).join("/");
      return text.startsWith("./") ? text.slice(2) : text;
    }

    function uniqueStrings(items) {
      const seen = new Set();
      const result = [];
      for (const item of items) {
        const text = String(item || "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
      }
      return result;
    }

    function turnProcessStepLines(input) {
      const lines = [];
      for (const part of input.runProgressParts || []) {
        const items = Array.isArray(part.items) ? part.items : [];
        if (items.length) {
          for (const item of items) lines.push(turnProcessStepLine(item.title || item.tool || "step", runProgressStatusLabel(item.status), item.detail || item.artifactPath || item.path || item.targetPath || item.requestedPath || item.provider || ""));
        } else {
          lines.push(turnProcessStepLine(part.title || "执行进度", runProgressStatusLabel(part.status), part.total ? String(part.current || 0) + "/" + String(part.total) : ""));
        }
      }
      for (const part of input.docTimelineParts || []) {
        const events = Array.isArray(part.events) ? part.events : [];
        if (events.length) {
          for (const event of events) lines.push(turnProcessStepLine(event.title || event.type || "step", event.stateLabel || docAgentStatusLabel(event.status), event.detail || event.warning || ""));
        } else {
          lines.push(turnProcessStepLine(part.title || "文档生成过程", docAgentStatusLabel(part.status), part.path || ""));
        }
      }
      if (!lines.length) {
        for (const part of input.toolParts || []) lines.push(turnProcessStepLine(part.title || "tool", part.status || "called", ""));
      }
      return lines;
    }

    function turnProcessStepLine(title, status, detail) {
      return [title, status, detail].filter(Boolean).join(" · ");
    }

    function turnProcessRecoveredArgumentFailureCount(input) {
      let count = 0;
      for (const part of input.runProgressParts || []) {
        const items = Array.isArray(part.items) ? part.items : [];
        for (const item of items) {
          if (!isFailedStatus(item && item.status)) continue;
          if (turnProcessLooksLikeInvalidToolArguments(item.detail || item.error || item.title || "")) count += 1;
        }
        if (!items.length && isFailedStatus(part.status) && turnProcessLooksLikeInvalidToolArguments(part.detail || part.error || part.title || "")) count += 1;
      }
      for (const part of input.toolParts || []) {
        if (!isFailedStatus(part.status)) continue;
        if (turnProcessLooksLikeInvalidToolArguments([part.title, part.error, part.output, part.summary].filter(Boolean).join(" "))) count += 1;
      }
      return count;
    }

    function turnProcessLooksLikeInvalidToolArguments(text) {
      return /tool-arguments-invalid-json|Tool arguments were not valid JSON|Tool arguments invalid/i.test(String(text || ""));
    }

    function turnProcessArtifactLines(input) {
      const lines = [];
      for (const part of input.generatedParts || []) {
        if (part.path) lines.push("DOCX: " + part.path);
        if (part.runSummaryPath) lines.push("Run summary: " + part.runSummaryPath);
      }
      for (const part of input.diagramParts || []) {
        if (part.pngPath) lines.push((String(part.kind || "").toUpperCase() || "Diagram") + " PNG: " + part.pngPath);
        if (part.mmdPath) lines.push("Mermaid source: " + part.mmdPath);
      }
      for (const part of input.wordRenderParts || []) {
        if (part.pdfArtifactPath) lines.push("PDF: " + part.pdfArtifactPath);
        const pages = Array.isArray(part.pagePngPaths) ? part.pagePngPaths : [];
        for (const [index, path] of pages.slice(0, 12).entries()) lines.push("Page PNG " + String(index + 1) + ": " + path);
        if (pages.length > 12) lines.push("Page PNG: ..." + String(pages.length - 12) + " more");
      }
      for (const path of turnProcessProgressArtifactPaths(input)) {
        if (/\.docx$/i.test(path)) lines.push("DOCX: " + path);
        else if (/\.png$/i.test(path)) lines.push("PNG: " + path);
        else lines.push("Artifact: " + path);
      }
      return uniqueStrings(lines);
    }

    function turnProcessProgressArtifactPaths(input) {
      const paths = [];
      for (const part of [...(input.runProgressParts || []), ...(input.docTimelineParts || [])]) {
        const items = Array.isArray(part.items) ? part.items : Array.isArray(part.events) ? part.events : [];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const artifactPath = typeof item.artifactPath === "string" ? item.artifactPath : "";
          if (isFailedStatus(item.status)) continue;
          const path = typeof item.path === "string" ? item.path : "";
          if (artifactPath) paths.push(artifactPath);
          if (path) paths.push(path);
        }
        if (!isFailedStatus(part.status) && typeof part.path === "string") paths.push(part.path);
      }
      return uniqueStrings(paths).filter((path) => /\.(?:docx|pdf|png|mmd)$/i.test(path));
    }

    function turnProcessRequestedDocumentPath(input) {
      const paths = [];
      for (const part of [...(input.runProgressParts || []), ...(input.docTimelineParts || [])]) {
        const items = Array.isArray(part.items) ? part.items : Array.isArray(part.events) ? part.events : [];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const targetPath = typeof item.targetPath === "string" ? item.targetPath : "";
          const requestedPath = typeof item.requestedPath === "string" ? item.requestedPath : "";
          if (/\.docx$/i.test(targetPath)) paths.push(targetPath);
          if (/\.docx$/i.test(requestedPath)) paths.push(requestedPath);
        }
      }
      return uniqueStrings(paths)[0] || "";
    }

    function turnProcessTextBlock(title, text, className) {
      const section = document.createElement("section");
      section.className = "turnProcessSection";
      const head = document.createElement("div");
      head.className = "turnProcessSectionTitle";
      head.textContent = title;
      const body = document.createElement("pre");
      body.className = className || "turnProcessText";
      body.textContent = text;
      section.append(head, body);
      return section;
    }

    function turnProcessDetailCards(input) {
      const group = document.createElement("div");
      group.className = "turnProcessDetailCards";
      if ((input.toolParts || []).length) group.appendChild(toolGroupCard(input.toolParts || []));
      for (const part of input.runProgressParts || []) group.appendChild(runProgressCard(part));
      for (const part of input.docTimelineParts || []) group.appendChild(docAgentTimelineCard(part));
      for (const part of input.generatedParts || []) group.appendChild(generatedDocumentCard(part, input));
      for (const part of input.diagramParts || []) group.appendChild(diagramPartCard(part));
      for (const part of input.wordRenderParts || []) group.appendChild(wordRenderCard(part));
      return group;
    }

	    function diagramPartCard(part) {
	      if (String(part.kind || "").toLowerCase() === "mermaid") {
	        if (part.displayMode === "artifact" || part.source === "tool") return mermaidArtifactCard(part);
	        const block = diagramBlock("mermaid", part.sourceText || part.xml || "");
	        block.dataset.diagramSource = part.source || "tool";
	        if (part.diagramId) block.dataset.diagramId = part.diagramId;
	        if (Array.isArray(part.warnings) && part.warnings.length) {
	          const warning = diagramStatus(part.warnings.slice(0, 4).join(" "), false);
	          warning.className += " diagramToolWarning";
	          const canvas = block.querySelector(".diagramCanvas");
	          block.insertBefore(warning, canvas || null);
	        }
	        return block;
	      }
	      if (String(part.kind || "").toLowerCase() === "drawio") {
	        const block = drawioDiagramBlock(part.title || "drawio", part.xml || "", {
	          diagramId: part.diagramId || "",
        });
        block.dataset.diagramSource = part.source || "tool";
        if (Array.isArray(part.warnings) && part.warnings.length) {
          const warning = diagramStatus(part.warnings.slice(0, 4).join(" "), false);
          warning.className += " diagramToolWarning";
          const canvas = block.querySelector(".diagramCanvas");
          block.insertBefore(warning, canvas || null);
        }
        return block;
      }
      return partCard(part, part.title || "Diagram", "diagramPart");
    }

    function mermaidArtifactCard(part) {
      const details = document.createElement("details");
      details.className = "toolCard mermaidArtifactCard";
      details.dataset.diagramId = part.diagramId || "";
      const summary = document.createElement("summary");
      summary.textContent = mermaidArtifactSummary(part);
      const body = document.createElement("div");
      body.className = "mermaidArtifactBody";
      const meta = document.createElement("div");
      meta.className = "mermaidArtifactMeta";
      appendMermaidArtifactStat(meta, "PNG", part.pngPath ? "已生成" : "未生成");
      if (part.renderProvider) appendMermaidArtifactStat(meta, "Renderer", part.renderProvider);
      if (part.fallbackUsed) appendMermaidArtifactStat(meta, "Fallback", "已使用");
      if (part.scale) appendMermaidArtifactStat(meta, "Scale", String(part.scale));
      if (part.width || part.height) appendMermaidArtifactStat(meta, "CSS size", String(part.width || "?") + "x" + String(part.height || "?"));
      if (part.pixelWidth || part.pixelHeight) appendMermaidArtifactStat(meta, "PNG pixels", String(part.pixelWidth || "?") + "x" + String(part.pixelHeight || "?"));
      if (part.cropBounds) appendMermaidArtifactStat(meta, "Crop", formatBoundsStat(part.cropBounds));
      if (part.contentBounds) appendMermaidArtifactStat(meta, "Content", formatBoundsStat(part.contentBounds));
      if (meta.childElementCount) body.appendChild(meta);
      const paths = [part.mmdPath ? "Source: " + part.mmdPath : "", part.pngPath ? "PNG: " + part.pngPath : ""].filter(Boolean).join("\\n");
      if (paths) {
        const pathNode = document.createElement("div");
        pathNode.className = "mermaidArtifactPath";
        pathNode.textContent = paths;
        body.appendChild(pathNode);
      }
      const actions = document.createElement("div");
      actions.className = "mermaidArtifactActions";
      if (part.pngPath) actions.appendChild(openGeneratedArtifactButton(part.pngPath, "打开 PNG", "external"));
      if (part.mmdPath) actions.appendChild(openGeneratedArtifactButton(part.mmdPath, "打开 .mmd", "external"));
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "statusActionButton";
      copy.textContent = "复制源码";
      copy.title = "复制 Mermaid 源码";
      copy.addEventListener("click", () => copyTextWithFeedback(part.sourceText || "", copy, "已复制 Mermaid 源码。"));
      actions.appendChild(copy);
      if (actions.childElementCount) body.appendChild(actions);
      if (Array.isArray(part.warnings) && part.warnings.length) {
        const warnings = document.createElement("pre");
        warnings.className = "wordRenderWarnings";
        warnings.textContent = part.warnings.slice(0, 8).join("\\n");
        body.appendChild(warnings);
      }
      const preview = document.createElement("div");
      preview.className = "mermaidArtifactPreview";
      preview.dataset.pendingMermaidPreview = "true";
      body.appendChild(preview);
      details.addEventListener("toggle", () => {
        if (!details.open || preview.dataset.pendingMermaidPreview !== "true") return;
        preview.dataset.pendingMermaidPreview = "false";
        const block = diagramBlock("mermaid", part.sourceText || part.xml || "");
        block.dataset.diagramSource = part.source || "tool";
        if (part.diagramId) block.dataset.diagramId = part.diagramId;
        preview.appendChild(block);
      });
      details.append(summary, body);
      return details;
    }

    function mermaidArtifactSummary(part) {
      const title = part.title || "Mermaid 图表";
      const provider = part.renderProvider ? " · " + part.renderProvider : "";
      const fallback = part.fallbackUsed ? " · fallback" : "";
      const png = part.pngPath ? " · PNG 已生成" : " · PNG 未生成";
      return title + png + provider + fallback;
    }

    function appendMermaidArtifactStat(root, label, value) {
      const item = document.createElement("span");
      item.className = "mermaidArtifactStat";
      item.textContent = label + ": " + value;
      root.appendChild(item);
    }

    function formatBoundsStat(bounds) {
      if (!bounds) return "";
      return String(bounds.width || "?") + "x" + String(bounds.height || "?") + " @ " + String(bounds.x || 0) + "," + String(bounds.y || 0);
    }

    function openGeneratedArtifactButton(path, label, mode) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = label.indexOf("PNG") >= 0 ? "statusActionButton primary" : "statusActionButton";
      button.textContent = label;
      button.title = label + ": " + path;
      button.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path, mode: mode || "external" }));
      return button;
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
      const approvalParts = parts.filter(isPendingToolApproval);
      if (approvalParts.length > 0) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = toolGroupSummary(parts);
      const body = document.createElement("div");
      body.className = "toolGroupBody";
      for (const part of approvalParts) body.appendChild(toolApprovalPane(part));
      const detail = document.createElement("pre");
      detail.textContent = toolGroupDetail(parts);
      body.appendChild(detail);
      details.append(summary, body);
      return details;
    }

    function isPendingToolApproval(part) {
      return part && part.status === "approval-required" && part.approvalRequestId;
    }

    function toolApprovalPane(part) {
      const pane = document.createElement("div");
      pane.className = "toolApprovalPane";
      pane.setAttribute("data-tool-approval-pane", part.approvalRequestId);
      const head = document.createElement("div");
      head.className = "toolApprovalHead";
      const title = document.createElement("div");
      title.className = "toolApprovalTitle";
      title.textContent = part.approvalTitle || part.title || "Tool approval";
      title.title = title.textContent;
      const risk = document.createElement("span");
      risk.className = "toolApprovalRisk";
      risk.textContent = "Risk: " + (part.approvalRisk || "unknown");
      head.append(title, risk);
      const summary = document.createElement("div");
      summary.className = "toolApprovalSummary";
      summary.textContent = part.approvalSummary || "ChipMate is waiting for permission to continue.";
      const meta = document.createElement("div");
      meta.className = "toolApprovalMeta";
      if (part.approvalPath) appendToolApprovalStat(meta, "Path", part.approvalPath);
      if (typeof part.approvalBytes === "number") appendToolApprovalStat(meta, "Bytes", String(part.approvalBytes));
      const reason = document.createElement("div");
      reason.className = "toolApprovalReason";
      reason.textContent = part.approvalReason ? "Reason: " + part.approvalReason : "";
      const actions = document.createElement("div");
      actions.className = "toolApprovalActions";
      actions.append(
        toolApprovalButton(part.approvalRequestId, true, "批准一次", true),
        toolApprovalButton(part.approvalRequestId, false, "拒绝", false),
      );
      pane.append(head, summary);
      if (meta.childElementCount > 0) pane.appendChild(meta);
      if (reason.textContent) pane.appendChild(reason);
      pane.appendChild(actions);
      return pane;
    }

    function appendToolApprovalStat(root, label, value) {
      const item = document.createElement("span");
      item.className = "toolApprovalStat";
      item.textContent = label + ": " + value;
      item.title = item.textContent;
      root.appendChild(item);
    }

    function toolApprovalButton(requestId, approved, label, primary) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "statusActionButton" + (primary ? " primary" : "");
      button.textContent = label;
      button.title = label;
      button.setAttribute("data-tool-approval-request", requestId);
      button.setAttribute("data-tool-approval-approved", approved ? "true" : "false");
      return button;
    }

    function toolApprovalFocusButton(requestId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "statusActionButton";
      button.textContent = "查看详情";
      button.title = "跳到消息里的完整审批详情";
      button.setAttribute("data-tool-approval-focus", requestId);
      return button;
    }

    function onMessagesClick(event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const clarificationChoice = target.closest("[data-clarification-choice]");
      if (clarificationChoice && !clarificationChoice.disabled) {
        event.preventDefault();
        selectClarificationChoice(clarificationChoice);
        return;
      }
      const clarificationSubmit = target.closest("[data-clarification-submit]");
      if (clarificationSubmit && !clarificationSubmit.disabled) {
        event.preventDefault();
        submitClarificationAnswer(clarificationSubmit);
        return;
      }
      const focusButton = target.closest("[data-tool-approval-focus]");
      if (focusButton) {
        const requestId = focusButton.getAttribute("data-tool-approval-focus") || "";
        if (!requestId) return;
        event.preventDefault();
        focusToolApprovalPane(requestId);
        return;
      }
      const button = target.closest("[data-tool-approval-request]");
      if (!button || button.disabled) return;
      const requestId = button.getAttribute("data-tool-approval-request") || "";
      if (!requestId) return;
      event.preventDefault();
      const approved = button.getAttribute("data-tool-approval-approved") === "true";
      disableToolApprovalActions(requestId);
      vscode.postMessage({ type: "resolveToolApproval", requestId, approved });
    }

    function selectClarificationChoice(button) {
      const card = button.closest("[data-clarification-card]");
      if (!card) return;
      const questionId = button.getAttribute("data-clarification-question-id") || "";
      for (const choice of Array.from(card.querySelectorAll('[data-clarification-question-id="' + cssEscape(questionId) + '"]'))) {
        choice.classList.toggle("is-selected", choice === button);
      }
    }

    function submitClarificationAnswer(button) {
      const card = button.closest("[data-clarification-card]");
      if (!card) return;
      const requestId = button.getAttribute("data-clarification-submit") || card.getAttribute("data-clarification-card") || "";
      const answers = collectClarificationAnswers(card);
      if (!requestId || answers.length === 0) {
        setNotice("请选择或输入澄清回答。");
        return;
      }
      for (const action of Array.from(card.querySelectorAll("button, textarea"))) action.disabled = true;
      vscode.postMessage({ type: "answerClarification", requestId, answers });
    }

    function collectClarificationAnswers(card) {
      const answers = [];
      for (const question of Array.from(card.querySelectorAll("[data-clarification-question]"))) {
        const questionId = question.getAttribute("data-clarification-question") || "";
        const selected = question.querySelector(".clarificationChoice.is-selected");
        const freeText = question.querySelector("[data-clarification-free-text]");
        const text = freeText ? String(freeText.value || "").trim() : "";
        if (selected) {
          answers.push({
            questionId,
            choiceId: selected.getAttribute("data-clarification-choice-id") || "",
            text: text || selected.getAttribute("data-clarification-choice-label") || selected.textContent || "",
          });
        } else if (text) {
          answers.push({ questionId, text });
        }
      }
      return answers;
    }

    function cssEscape(value) {
      if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
      return String(value || "").replace(/["\\\\]/g, "\\\\$&");
    }

    function disableToolApprovalActions(requestId) {
      for (const action of Array.from(document.querySelectorAll("[data-tool-approval-request]"))) {
        if (action.getAttribute("data-tool-approval-request") === requestId) action.disabled = true;
      }
      for (const action of Array.from(document.querySelectorAll("[data-tool-approval-focus]"))) {
        if (action.getAttribute("data-tool-approval-focus") === requestId) action.disabled = true;
      }
    }

    function focusToolApprovalPane(requestId) {
      const pane = findToolApprovalPane(requestId);
      if (!pane) return;
      pane.scrollIntoView({ block: "center", behavior: "smooth" });
      pane.classList.add("is-focused");
      const firstAction = pane.querySelector("[data-tool-approval-request]");
      if (firstAction && firstAction.focus) firstAction.focus({ preventScroll: true });
      window.setTimeout(() => pane.classList.remove("is-focused"), 1400);
    }

    function findToolApprovalPane(requestId) {
      return Array.from(document.querySelectorAll("[data-tool-approval-pane]"))
        .find((pane) => pane.getAttribute("data-tool-approval-pane") === requestId);
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

    function runProgressCard(part) {
      const details = document.createElement("details");
      details.className = "toolCard runProgressCard";
      details.open = part.status !== "completed" && part.status !== "warning";
      const summary = document.createElement("summary");
      summary.textContent = runProgressSummary(part);
      const body = document.createElement("div");
      body.className = "runProgressBody";
      const stats = document.createElement("div");
      stats.className = "runProgressStats";
      appendRunProgressStat(stats, "状态", runProgressStatusLabel(part.status));
      if (part.total) appendRunProgressStat(stats, "进度", String(part.current || 0) + "/" + String(part.total));
      appendRunProgressStat(stats, "Warning", String(part.warningCount || 0));
      appendRunProgressStat(stats, "Fallback", String(part.fallbackCount || 0));
      if (part.startedAt) appendRunProgressStat(stats, "耗时", elapsedLabel(part.startedAt));
      const list = document.createElement("div");
      list.className = "runProgressList";
      const items = Array.isArray(part.items) ? part.items.slice(-36) : [];
      for (const item of items) list.appendChild(runProgressItemRow(item));
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "runProgressItemDetail";
        empty.textContent = "等待工具进度。";
        list.appendChild(empty);
      }
      body.append(stats, list);
      details.append(summary, body);
      return details;
    }

    function runProgressSummary(part) {
      const base = part.title || "执行进度";
      const progress = part.total ? " · " + String(part.current || 0) + "/" + String(part.total) : "";
      const warning = part.warningCount ? " · Warning " + String(part.warningCount) : "";
      const fallback = part.fallbackCount ? " · Fallback " + String(part.fallbackCount) : "";
      return base + " · " + runProgressStatusLabel(part.status) + progress + warning + fallback;
    }

    function appendRunProgressStat(root, label, value) {
      const item = document.createElement("span");
      item.className = "runProgressStat";
      item.textContent = label + ": " + value;
      root.appendChild(item);
    }

    function runProgressItemRow(item) {
      const row = document.createElement("div");
      row.className = "runProgressItem";
      const head = document.createElement("div");
      head.className = "runProgressItemHead";
      const title = document.createElement("span");
      title.textContent = item.title || item.tool || "step";
      const status = document.createElement("span");
      status.className = "runProgressItemStatus";
      status.textContent = runProgressStatusLabel(item.status);
      head.append(title, status);
      row.appendChild(head);
      const detailText = [
        item.detail || "",
        item.artifactPath ? "artifact: " + item.artifactPath : "",
        item.path && item.path !== item.artifactPath ? "path: " + item.path : "",
        item.targetPath ? "target: " + item.targetPath : "",
        item.requestedPath ? "requested: " + item.requestedPath : "",
        item.provider ? "provider: " + item.provider : "",
        item.fallbackUsed ? "fallback: true" : "",
      ].filter(Boolean).join("\\n");
      if (detailText) {
        const detail = document.createElement("div");
        detail.className = "runProgressItemDetail";
        detail.textContent = detailText;
        row.appendChild(detail);
      }
      return row;
    }

    function runProgressStatusLabel(status) {
      if (status === "completed") return "完成";
      if (status === "warning") return "有提示";
      if (status === "failed") return "失败";
      if (status === "skipped") return "已跳过";
      return "运行中";
    }

    function docAgentTimelineCard(part) {
      const details = document.createElement("details");
      details.className = "toolCard docAgentTimelineCard";
      details.open = part.status !== "completed";
      const summary = document.createElement("summary");
      summary.textContent = docAgentTimelineSummary(part);
      const body = document.createElement("div");
      body.className = "docAgentTimelineBody";
      const stats = document.createElement("div");
      stats.className = "docAgentStats";
      appendDocAgentStat(stats, "状态", docAgentStatusLabel(part.status));
      if (part.total) appendDocAgentStat(stats, "进度", String(part.current || 0) + "/" + String(part.total));
      appendDocAgentStat(stats, "Warning", String(part.warningCount || 0));
      appendDocAgentStat(stats, "Fallback", String(part.fallbackCount || 0));
      if (part.startedAt) appendDocAgentStat(stats, "耗时", elapsedLabel(part.startedAt));
      const list = document.createElement("div");
      list.className = "docAgentEventList";
      const events = Array.isArray(part.events) ? part.events.slice(-36) : [];
      for (const event of events) list.appendChild(docAgentEventRow(event));
      if (!events.length) {
        const empty = document.createElement("div");
        empty.className = "docAgentEventDetail";
        empty.textContent = "等待生成流程开始。";
        list.appendChild(empty);
      }
      body.append(stats, list);
      details.append(summary, body);
      return details;
    }

    function docAgentTimelineSummary(part) {
      const base = part.title || "本地 Word 生成过程";
      const progress = part.total ? " · " + String(part.current || 0) + "/" + String(part.total) : "";
      const warning = part.warningCount ? " · Warning " + String(part.warningCount) : "";
      const fallback = part.fallbackCount ? " · Fallback " + String(part.fallbackCount) : "";
      return base + progress + warning + fallback;
    }

    function appendDocAgentStat(root, label, value) {
      const item = document.createElement("span");
      item.className = "docAgentStat";
      item.textContent = label + ": " + value;
      root.appendChild(item);
    }

    function docAgentEventRow(event) {
      const row = document.createElement("div");
      row.className = "docAgentEvent";
      const head = document.createElement("div");
      head.className = "docAgentEventHead";
      const title = document.createElement("span");
      title.textContent = event.title || event.type || "step";
      const status = document.createElement("span");
      status.className = "docAgentEventStatus";
      status.textContent = event.stateLabel || docAgentStatusLabel(event.status);
      head.append(title, status);
      row.appendChild(head);
      const detailText = [event.detail, event.warning].filter(Boolean).join("\\n");
      if (detailText) {
        const detail = document.createElement("div");
        detail.className = "docAgentEventDetail";
        detail.textContent = detailText;
        row.appendChild(detail);
      }
      return row;
    }

    function docAgentConflictCard(part) {
      const details = document.createElement("details");
      details.className = "toolCard docAgentConflictCard";
      details.open = part.status !== "completed";
      const summary = document.createElement("summary");
      summary.textContent = part.status === "completed"
        ? "规则冲突已处理 · " + (part.detail || "")
        : "规则冲突需要确认 · " + String((part.conflicts || []).length) + " 条";
      const body = document.createElement("div");
      body.className = "docAgentConflictBody";
      const bulk = document.createElement("div");
      bulk.className = "docAgentBulkActions";
      for (const action of [
        { label: "全部采用第一份", choice: "internal" },
        { label: "全部采用第二份", choice: "external" },
        { label: "全部保留待评审", choice: "review" },
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "statusActionButton";
        button.textContent = action.label;
        button.disabled = part.status === "completed";
        button.addEventListener("click", () => setAllDocAgentConflictChoices(body, action.choice));
        bulk.appendChild(button);
      }
      const list = document.createElement("div");
      list.className = "docAgentConflictList";
      for (const conflict of part.conflicts || []) list.appendChild(docAgentConflictItem(conflict, part.status === "completed"));
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "statusActionButton primary docAgentConfirm";
      confirm.textContent = part.status === "completed" ? "已确认" : "确认选择并继续生成";
      confirm.disabled = part.status === "completed";
      confirm.addEventListener("click", () => {
        vscode.postMessage({
          type: "resolveDocAgentConflict",
          requestId: part.requestId,
          choices: collectDocAgentConflictChoices(body),
        });
      });
      body.append(bulk, list, confirm);
      details.append(summary, body);
      return details;
    }

    function docAgentConflictItem(conflict, disabled) {
      const item = document.createElement("div");
      item.className = "docAgentConflictItem";
      item.dataset.conflictId = conflict.id || "";
      item.dataset.choice = conflict.choice || "review";
      const head = document.createElement("div");
      head.className = "docAgentConflictHead";
      const title = document.createElement("span");
      title.textContent = conflict.title || "未命名冲突";
      const state = document.createElement("span");
      state.className = "docAgentChoiceState";
      state.textContent = docAgentChoiceLabel(item.dataset.choice);
      head.append(title, state);
      const meta = document.createElement("div");
      meta.className = "docAgentConflictMeta";
      meta.textContent = [
        "第一份/内部：" + (conflict.internalSource || ""),
        conflict.internalSummary || "",
        "第二份/外部：" + (conflict.externalSource || ""),
        conflict.externalSummary || "",
        "建议：" + (conflict.recommendation || ""),
      ].filter(Boolean).join("\\n");
      const choices = document.createElement("div");
      choices.className = "docAgentChoiceRow";
      for (const action of [
        { label: "采用第一份", choice: "internal" },
        { label: "采用第二份", choice: "external" },
        { label: "保留待评审", choice: "review" },
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "statusActionButton docAgentChoiceButton" + (item.dataset.choice === action.choice ? " is-selected" : "");
        button.textContent = action.label;
        button.disabled = disabled;
        button.addEventListener("click", () => setDocAgentConflictChoice(item, action.choice));
        choices.appendChild(button);
      }
      item.append(head, meta, choices);
      return item;
    }

    function setAllDocAgentConflictChoices(root, choice) {
      for (const item of Array.from(root.querySelectorAll(".docAgentConflictItem"))) setDocAgentConflictChoice(item, choice);
    }

    function setDocAgentConflictChoice(item, choice) {
      item.dataset.choice = choice;
      const state = item.querySelector(".docAgentChoiceState");
      if (state) state.textContent = docAgentChoiceLabel(choice);
      for (const button of Array.from(item.querySelectorAll(".docAgentChoiceButton"))) {
        button.classList.toggle("is-selected", button.textContent === docAgentChoiceButtonText(choice));
      }
    }

    function collectDocAgentConflictChoices(root) {
      return Array.from(root.querySelectorAll(".docAgentConflictItem")).map((item) => ({
        conflictId: item.dataset.conflictId || "",
        choice: item.dataset.choice || "review",
      }));
    }

    function docAgentChoiceButtonText(choice) {
      if (choice === "internal") return "采用第一份";
      if (choice === "external") return "采用第二份";
      return "保留待评审";
    }

    function docAgentChoiceLabel(choice) {
      if (choice === "internal") return "采用第一份/内部规范";
      if (choice === "external") return "采用第二份/外部参考";
      return "保留为待评审冲突";
    }

    function docAgentStatusLabel(status) {
      if (status === "completed") return "完成";
      if (status === "warning") return "Warning";
      if (status === "waiting") return "等待";
      if (status === "error") return "失败";
      return "运行中";
    }

    function elapsedLabel(startedAt) {
      const elapsed = Math.max(0, Date.now() - Number(startedAt || Date.now()));
      if (elapsed < 1000) return "<1s";
      return String(Math.round(elapsed / 1000)) + "s";
    }

    function generatedDocumentCard(part, input) {
      const card = document.createElement("div");
      card.className = "toolCard generatedDocumentCard";
      const title = document.createElement("div");
      title.className = "generatedDocumentTitle";
      title.textContent = "Word 文档已生成";
      const meta = document.createElement("div");
      meta.className = "generatedDocumentMeta";
      const warningsForDisplay = filteredGeneratedDocumentWarnings(input || {}, part);
      meta.textContent = (part.path || "") + " · 来源 " + (part.sourceCount || 0) + " 份 · Warning " + warningsForDisplay.length + " 条";
      const actions = document.createElement("div");
      actions.className = "generatedDocumentActions";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "statusActionButton primary";
      open.textContent = "外部打开";
      open.title = "用系统默认应用打开生成的 Word 文档";
      open.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path: part.path, mode: "external" }));
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "statusActionButton";
      reveal.textContent = "在资源管理器中显示";
      reveal.title = "在 Finder 或系统资源管理器中显示文件";
      reveal.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path: part.path, mode: "reveal" }));
      actions.append(open, reveal);
      card.append(title, meta, actions);
      if (warningsForDisplay.length) {
        const warnings = document.createElement("pre");
        warnings.className = "generatedDocumentWarnings";
        warnings.textContent = warningsForDisplay.slice(0, 8).join("\\n");
        card.appendChild(warnings);
      }
      return card;
    }

    function wordRenderCard(part) {
      const card = document.createElement("div");
      card.className = "toolCard wordRenderCard";
      const title = document.createElement("div");
      title.className = "wordRenderTitle";
      title.textContent = "Word 渲染质检";
      const meta = document.createElement("div");
      meta.className = "wordRenderMeta";
      const skipped = part.visualQaStatus === "skipped" || part.attempted === false;
      const state = part.ok === false
        ? "有风险"
        : skipped
          ? "已跳过视觉 QA：" + wordRenderSkipReasonText(part.skipReason)
          : "已生成页面证据";
      meta.textContent = [
        part.path || "",
        "状态 " + state,
        "页数 " + String(part.pageCount || 0),
      ].filter(Boolean).join(" · ");
      card.append(title, meta);
      const visualQa = wordRenderVisualQaCoverageText(part);
      if (visualQa) {
        const visualQaNode = document.createElement("div");
        visualQaNode.className = "wordRenderMeta";
        visualQaNode.textContent = visualQa;
        card.appendChild(visualQaNode);
      }
      const artifacts = wordRenderArtifactText(part);
      if (artifacts) {
        const artifactNode = document.createElement("div");
        artifactNode.className = "wordRenderArtifacts";
        artifactNode.textContent = artifacts;
        card.appendChild(artifactNode);
      }
      const actions = wordRenderActions(part);
      if (actions.childElementCount) card.appendChild(actions);
      const previews = wordRenderPreviewStrip(part);
      if (previews) card.appendChild(previews);
      const summary = wordRenderSummaryText(part);
      if (summary) {
        const summaryNode = document.createElement("div");
        summaryNode.className = "wordRenderSummary";
        summaryNode.textContent = summary;
        card.appendChild(summaryNode);
      }
      if (Array.isArray(part.warnings) && part.warnings.length) {
        const warnings = document.createElement("pre");
        warnings.className = "wordRenderWarnings";
        warnings.textContent = part.warnings.slice(0, 8).join("\\n");
        card.appendChild(warnings);
      }
      return card;
    }

    function wordRenderActions(part) {
      const actions = document.createElement("div");
      actions.className = "wordRenderActions";
      if (part.pdfArtifactPath) {
        const openPdf = document.createElement("button");
        openPdf.type = "button";
        openPdf.className = "statusActionButton primary";
        openPdf.textContent = "打开 PDF";
        openPdf.title = "打开渲染后的 PDF artifact";
        openPdf.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path: part.pdfArtifactPath, mode: "external" }));
        actions.appendChild(openPdf);
      }
      const pages = Array.isArray(part.pagePngPaths) ? part.pagePngPaths : [];
      if (pages[0]) {
        const openPng = document.createElement("button");
        openPng.type = "button";
        openPng.className = "statusActionButton";
        openPng.textContent = "打开首个 PNG";
        openPng.title = "打开第一页 PNG artifact";
        openPng.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path: pages[0], mode: "external" }));
        actions.appendChild(openPng);
      }
      if (part.pdfArtifactPath || pages[0]) {
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "statusActionButton";
        reveal.textContent = "显示 artifact";
        reveal.title = "在 Finder 或系统资源管理器中显示渲染 artifact";
        reveal.addEventListener("click", () => vscode.postMessage({ type: "openGeneratedDocument", path: part.pdfArtifactPath || pages[0], mode: "reveal" }));
        actions.appendChild(reveal);
      }
      return actions;
    }

    function wordRenderSkipReasonText(reason) {
      switch (String(reason || "")) {
        case "remote-unconfigured":
          return "远端服务未配置";
        case "remote-unavailable":
          return "远端服务连接失败";
        case "remote-invalid-response":
          return "远端响应异常";
        case "artifact-persist-failed":
          return "artifact 保存失败";
        default:
          return "远端不可用";
      }
    }

    function wordRenderVisualQaCoverageText(part) {
      const coverage = part && typeof part.visualQaCoverage === "object" ? part.visualQaCoverage : undefined;
      if (!coverage) return "";
      if (String(coverage.mode || "") === "skipped") {
        return "视觉 QA：已跳过（" + wordRenderSkipReasonText(part.skipReason) + "）";
      }
      const total = Number(coverage.totalPages || part.pageCount || 0);
      const queued = Number(coverage.queuedPages || 0);
      const batchCount = Number(coverage.batchCount || 0);
      const batchSize = Number(coverage.batchSize || 0);
      const mode = String(coverage.mode || "");
      if (!total && !queued) return "";
      const status = mode === "summary-only" ? "视觉 QA：summary-only" : "图片 QA 队列";
      return [
        status + " " + String(queued || 0) + "/" + String(total || queued || 0) + " 页",
        batchCount ? String(batchCount) + " 批" : "",
        batchSize ? "每批 " + String(batchSize) + " 页" : "",
      ].filter(Boolean).join(" · ");
    }

    function wordRenderPreviewStrip(part) {
      const uris = Array.isArray(part.pagePngPreviewUris) ? part.pagePngPreviewUris.filter(Boolean).slice(0, 4) : [];
      if (!uris.length) return undefined;
      const pages = Array.isArray(part.pagePngPaths) ? part.pagePngPaths : [];
      const strip = document.createElement("div");
      strip.className = "wordRenderPreviewStrip";
      for (const [index, uri] of uris.entries()) {
        const item = document.createElement("div");
        item.className = "wordRenderPreviewItem";
        const image = document.createElement("img");
        image.className = "wordRenderPreviewImage";
        image.loading = "lazy";
        image.alt = "Word render page " + String(index + 1);
        image.src = uri;
        const caption = document.createElement("div");
        caption.className = "wordRenderPreviewCaption";
        caption.textContent = "page " + String(index + 1) + (pages[index] ? " · " + pages[index] : "");
        item.append(image, caption);
        strip.appendChild(item);
      }
      if (pages.length > uris.length) {
        const more = document.createElement("div");
        more.className = "wordRenderPreviewCaption";
        more.textContent = "另有 " + String(pages.length - uris.length) + " 页 PNG artifact";
        strip.appendChild(more);
      }
      return strip;
    }

    function wordRenderArtifactText(part) {
      const lines = [];
      if (part.renderArtifactDir) lines.push("artifact: " + part.renderArtifactDir);
      if (part.pdfArtifactPath) lines.push("pdf: " + part.pdfArtifactPath);
      const pages = Array.isArray(part.pagePngPaths) ? part.pagePngPaths : [];
      if (pages.length) {
        const shown = pages.slice(0, 6).map((path, index) => "page " + String(index + 1) + ": " + path);
        lines.push(shown.join("\\n"));
        if (pages.length > shown.length) lines.push("..." + String(pages.length - shown.length) + " more page PNG(s)");
      }
      return lines.join("\\n");
    }

    function wordRenderSummaryText(part) {
      const summaries = Array.isArray(part.pageVisualSummaries) ? part.pageVisualSummaries.slice(0, 4) : [];
      const lines = [];
      for (const summary of summaries) {
        if (!summary || typeof summary !== "object") continue;
        const page = summary.page || "?";
        const inkRatio = typeof summary.inkRatio === "number" ? "ink " + (summary.inkRatio * 100).toFixed(2) + "%" : "";
        const bounds = summary.contentBounds && typeof summary.contentBounds === "object"
          ? "bounds " + ["left", "top", "right", "bottom"].map((key) => summary.contentBounds[key]).join("/")
          : "";
        const edge = summary.edgeInk && typeof summary.edgeInk === "object"
          ? "edge " + Object.keys(summary.edgeInk).filter((key) => summary.edgeInk[key]).join(",")
          : "";
        lines.push(["page " + page, inkRatio, bounds, edge].filter(Boolean).join(" · "));
      }
      return lines.join("\\n");
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
        root.appendChild(pendingDiagramSourceBlock(language, codeLines.join("\\n")));
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

    function isDrawioLanguage(language) {
      const value = String(language || "").trim().toLowerCase().split(/\\s+/)[0];
      return value === "drawio" || value === "draw.io" || value === "mxfile" || value === "mxgraph" || value === "mxgraphmodel";
    }

    function codeBlock(language, codeText) {
      if (isMermaidLanguage(language)) return diagramBlock(language, codeText);
      if (isDrawioLanguage(language)) return drawioDiagramBlock(language, codeText);
      return sourceCodeBlock(language, codeText);
    }

    function pendingMermaidSourceBlock(language, codeText) {
      return sourceCodeBlock((language || "mermaid") + " source pending", codeText);
    }

    function pendingDiagramSourceBlock(language, codeText) {
      return isMermaidLanguage(language) || isDrawioLanguage(language)
        ? sourceCodeBlock((language || "diagram") + " source pending", codeText)
        : codeBlock(language, codeText);
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
	      const zoomOut = document.createElement("button");
	      zoomOut.className = "diagramZoom diagramZoomOut oc-icon-btn oc-liquid-btn";
	      zoomOut.type = "button";
	      setIconOnlyButton(zoomOut, "zoomOut", "Zoom out diagram");
	      zoomOut.addEventListener("click", () => setDiagramZoom(block, diagramZoomValue(block) - DIAGRAM_ZOOM_STEP));
		      const zoomIn = document.createElement("button");
		      zoomIn.className = "diagramZoom diagramZoomIn oc-icon-btn oc-liquid-btn";
		      zoomIn.type = "button";
		      setIconOnlyButton(zoomIn, "zoomIn", "Zoom in diagram");
		      zoomIn.addEventListener("click", () => setDiagramZoom(block, diagramZoomValue(block) + DIAGRAM_ZOOM_STEP));
			      const viewer = diagramViewerButton(block, "Mermaid diagram");
		      const exportPng = document.createElement("button");
		      exportPng.className = "exportMermaidImage oc-icon-btn oc-liquid-btn";
		      exportPng.type = "button";
		      setIconOnlyButton(exportPng, "save", "Export Mermaid diagram as PNG");
	      exportPng.addEventListener("click", () => exportMermaidDiagramImage(block, exportPng));
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
		      actions.append(zoomOut, zoomIn, viewer, exportPng, source, copy);
	      head.append(label, actions);
	      const canvas = document.createElement("div");
	      canvas.className = "diagramCanvas";
	      enableDiagramCanvasPan(canvas);
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
	      setDiagramZoom(block, DIAGRAM_ZOOM_DEFAULT);
	      disableDiagramZoom(block);
	      renderMermaidDiagram(block, canvas, codeText, language || "mermaid");
	      return block;
	    }

    function drawioDiagramBlock(language, codeText, options) {
      const block = document.createElement("section");
      block.className = "diagramBlock drawioDiagramBlock";
      block.setAttribute("role", "region");
      block.setAttribute("aria-label", "draw.io diagram");
      block.setAttribute("data-diagram-kind", "drawio");
      block.setAttribute("tabindex", "-1");
      const providedDiagramId = options && options.diagramId ? String(options.diagramId) : "";
      block.dataset.diagramId = providedDiagramId || ("chipmate-drawio-" + (++drawioDiagramSerial));
      block.dataset.diagramCacheKey = drawioDiagramCacheKey(providedDiagramId, codeText);
      const head = document.createElement("div");
      head.className = "codeHead";
      const label = document.createElement("span");
      label.className = "codeLanguage";
      label.textContent = language || "drawio";
      const actions = document.createElement("span");
      actions.className = "diagramActions";
      const zoomOut = document.createElement("button");
      zoomOut.className = "diagramZoom diagramZoomOut oc-icon-btn oc-liquid-btn";
      zoomOut.type = "button";
      setIconOnlyButton(zoomOut, "zoomOut", "Zoom out diagram");
      zoomOut.addEventListener("click", () => setDiagramZoom(block, diagramZoomValue(block) - DIAGRAM_ZOOM_STEP));
	      const zoomIn = document.createElement("button");
	      zoomIn.className = "diagramZoom diagramZoomIn oc-icon-btn oc-liquid-btn";
	      zoomIn.type = "button";
	      setIconOnlyButton(zoomIn, "zoomIn", "Zoom in diagram");
	      zoomIn.addEventListener("click", () => setDiagramZoom(block, diagramZoomValue(block) + DIAGRAM_ZOOM_STEP));
	      const viewer = diagramViewerButton(block, "draw.io diagram");
	      const exportPng = document.createElement("button");
	      exportPng.className = "exportDrawioImage oc-icon-btn oc-liquid-btn";
	      exportPng.type = "button";
      exportPng.disabled = true;
      setDrawioExportUnavailable(exportPng, "Draw.io PNG export is available after the preview renders.");
      let renderedPngDataUri = "";
      exportPng.addEventListener("click", () => {
        if (!renderedPngDataUri) {
          setNotice("Draw.io diagram is not ready to export.");
          return;
        }
        vscode.postMessage({
          type: "exportDrawioImage",
          diagramId: block.dataset.diagramId || "",
          filenameHint: label.textContent || "drawio-diagram",
          dataUri: renderedPngDataUri,
        });
      });
      const source = document.createElement("button");
      source.className = "toggleDiagramSource oc-icon-btn oc-liquid-btn";
      source.type = "button";
      source.setAttribute("aria-pressed", "false");
      setIconOnlyButton(source, "references", "Show draw.io source");
      const copy = document.createElement("button");
      copy.className = "copyCode oc-icon-btn oc-liquid-btn";
      copy.type = "button";
      setIconOnlyButton(copy, "copy", "Copy draw.io source");
      copy.addEventListener("click", () => copyCode(codeText, copy));
	      actions.append(zoomOut, zoomIn, viewer, exportPng, source, copy);
      head.append(label, actions);
      const canvas = document.createElement("div");
      canvas.className = "diagramCanvas";
      enableDiagramCanvasPan(canvas);
      const sourcePre = document.createElement("pre");
      sourcePre.className = "diagramSource";
      const sourceCode = document.createElement("code");
      sourceCode.textContent = codeText;
      sourcePre.appendChild(sourceCode);
      source.addEventListener("click", () => {
        const visible = !block.classList.contains("show-source");
        block.classList.toggle("show-source", visible);
        source.setAttribute("aria-pressed", visible ? "true" : "false");
        setIconOnlyButton(source, visible ? "discard" : "references", visible ? "Hide draw.io source" : "Show draw.io source");
      });
      block.append(head, canvas, sourcePre);
      setDiagramZoom(block, DIAGRAM_ZOOM_DEFAULT);
      disableDiagramZoom(block);
      renderDrawioDiagram(block, canvas, codeText, block.dataset.diagramCacheKey || "", (dataUri) => {
        renderedPngDataUri = dataUri;
        exportPng.disabled = false;
        setIconOnlyButton(exportPng, "save", "Export draw.io diagram as PNG");
        void registerDiagramVisualEvidence(block, {
          kind: "drawio",
          title: label.textContent || "draw.io diagram",
          source: codeText,
          dataUri,
        });
      });
      return block;
    }

	    function diagramStatus(text, isError, detail) {
      const status = document.createElement("div");
      status.className = "diagramStatus" + (isError ? " error" : "");
      const line = document.createElement("div");
      line.textContent = text;
      status.appendChild(line);
      const detailText = String(detail || "").trim();
      if (detailText) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Details";
        const code = document.createElement("code");
        code.textContent = detailText;
        details.append(summary, code);
        status.appendChild(details);
      }
      return status;
	    }

	    function diagramZoomSurface(...children) {
	      const surface = document.createElement("div");
	      surface.className = "diagramZoomSurface";
	      surface.append(...children);
	      return surface;
	    }

	    function diagramViewerButton(block, title) {
	      const viewer = document.createElement("button");
	      viewer.className = "openDiagramViewer oc-icon-btn oc-liquid-btn";
	      viewer.type = "button";
	      viewer.disabled = true;
	      viewer.dataset.diagramViewerTitle = title || "Diagram viewer";
	      setIconOnlyButton(viewer, "expand", "Open diagram viewer");
	      viewer.addEventListener("click", () => openDiagramViewer(block, viewer));
	      return viewer;
	    }

	    function openDiagramViewer(block, opener) {
	      const viewer = el("diagramViewer");
	      const canvas = el("diagramViewerCanvas");
	      const target = el("diagramViewerSurface");
	      const surface = block && block.querySelector ? block.querySelector(".diagramZoomSurface") : undefined;
	      const clone = cloneDiagramForViewer(surface);
	      if (!viewer || !canvas || !target || !clone) {
	        setNotice("Diagram viewer is not available for this diagram yet.");
	        return;
	      }
	      diagramViewerOpener = opener || undefined;
	      el("diagramViewerTitle").textContent = opener && opener.dataset ? (opener.dataset.diagramViewerTitle || "Diagram viewer") : "Diagram viewer";
	      target.replaceChildren(clone);
	      viewer.hidden = false;
	      viewer.removeAttribute("hidden");
	      viewer.setAttribute("aria-hidden", "false");
	      viewer.setAttribute("aria-modal", "true");
	      fitDiagramViewer();
	      if (clone.matches && clone.matches("img.drawioImage") && !clone.complete) {
	        clone.addEventListener("load", fitDiagramViewer, { once: true });
	      }
	      canvas.focus();
	    }

	    function closeDiagramViewer() {
	      const viewer = el("diagramViewer");
	      const surface = el("diagramViewerSurface");
	      if (!viewer || viewer.hidden) return;
	      viewer.hidden = true;
	      viewer.setAttribute("hidden", "");
	      viewer.setAttribute("aria-hidden", "true");
	      viewer.removeAttribute("aria-modal");
	      if (surface) surface.replaceChildren();
	      if (diagramViewerOpener && diagramViewerOpener.focus) diagramViewerOpener.focus();
	      diagramViewerOpener = undefined;
	    }

	    function isDiagramViewerOpen() {
	      const viewer = el("diagramViewer");
	      return Boolean(viewer && !viewer.hidden);
	    }

	    function cloneDiagramForViewer(surface) {
	      const source = surface && surface.querySelector ? surface.querySelector("svg, img.drawioImage") : undefined;
	      if (!source) return undefined;
	      const clone = source.cloneNode(true);
	      if (clone.removeAttribute) clone.removeAttribute("style");
	      if (clone.matches && clone.matches("img.drawioImage")) {
	        clone.draggable = false;
	        clone.alt = source.alt || "Rendered diagram";
	      }
	      return clone;
	    }

	    function fitDiagramViewer() {
	      const canvas = el("diagramViewerCanvas");
	      const surface = el("diagramViewerSurface");
	      if (!canvas || !surface) return;
	      const baseSize = diagramViewerBaseSize(surface);
	      const fitWidth = Math.max(1, canvas.clientWidth - 24);
	      const fitHeight = Math.max(1, canvas.clientHeight - 24);
	      const fitZoom = Math.min(1, fitWidth / baseSize.width, fitHeight / baseSize.height);
	      setDiagramViewerZoom(fitZoom);
	      canvas.scrollLeft = 0;
	      canvas.scrollTop = 0;
	    }

	    function setDiagramViewerZoom(value) {
	      const canvas = el("diagramViewerCanvas");
	      const surface = el("diagramViewerSurface");
	      if (!canvas || !surface) return;
	      diagramViewerZoom = normalizeDiagramViewerZoom(value);
	      const baseSize = diagramViewerBaseSize(surface);
	      surface.style.setProperty("--diagram-viewer-content-width", Math.max(1, Math.round(baseSize.width * diagramViewerZoom)) + "px");
	      surface.style.setProperty("--diagram-viewer-content-height", Math.max(1, Math.round(baseSize.height * diagramViewerZoom)) + "px");
	      const zoomOut = el("diagramViewerZoomOut");
	      const zoomIn = el("diagramViewerZoomIn");
	      if (zoomOut) zoomOut.disabled = diagramViewerZoom <= DIAGRAM_VIEWER_ZOOM_MIN;
	      if (zoomIn) zoomIn.disabled = diagramViewerZoom >= DIAGRAM_VIEWER_ZOOM_MAX;
	    }

	    function normalizeDiagramViewerZoom(value) {
	      const raw = Number.isFinite(value) ? value : DIAGRAM_ZOOM_DEFAULT;
	      const stepped = Math.round(raw / DIAGRAM_ZOOM_STEP) * DIAGRAM_ZOOM_STEP;
	      return Math.max(DIAGRAM_VIEWER_ZOOM_MIN, Math.min(DIAGRAM_VIEWER_ZOOM_MAX, Number(stepped.toFixed(2))));
	    }

	    function diagramViewerBaseSize(surface) {
	      const intrinsic = diagramZoomIntrinsicSize(surface);
	      if (intrinsic && intrinsic.width > 0 && intrinsic.height > 0) return intrinsic;
	      const rect = surface && surface.getBoundingClientRect ? surface.getBoundingClientRect() : { width: 0, height: 0 };
	      return {
	        width: Math.max(1, rect.width || 800),
	        height: Math.max(1, rect.height || 600),
	      };
	    }

	    function enableDiagramViewerPan(canvas) {
	      if (!canvas || canvas.dataset.diagramViewerPanReady === "true") return;
	      canvas.dataset.diagramViewerPanReady = "true";
	      let activePointerId = undefined;
	      let startClientX = 0;
	      let startClientY = 0;
	      let startScrollLeft = 0;
	      let startScrollTop = 0;

	      canvas.addEventListener("pointerdown", (event) => {
	        if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	        activePointerId = event.pointerId;
	        startClientX = event.clientX;
	        startClientY = event.clientY;
	        startScrollLeft = canvas.scrollLeft;
	        startScrollTop = canvas.scrollTop;
	        canvas.classList.add("diagramDragging");
	        canvas.setPointerCapture(event.pointerId);
	        event.preventDefault();
	      });

	      canvas.addEventListener("pointermove", (event) => {
	        if (activePointerId !== event.pointerId) return;
	        canvas.scrollLeft = startScrollLeft - (event.clientX - startClientX);
	        canvas.scrollTop = startScrollTop - (event.clientY - startClientY);
	        event.preventDefault();
	      });

	      const endPan = (event) => {
	        if (activePointerId !== event.pointerId) return;
	        if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
	          canvas.releasePointerCapture(event.pointerId);
	        }
	        activePointerId = undefined;
	        canvas.classList.remove("diagramDragging");
	      };

	      canvas.addEventListener("pointerup", endPan);
	      canvas.addEventListener("pointercancel", endPan);
	      canvas.addEventListener("lostpointercapture", () => {
	        activePointerId = undefined;
	        canvas.classList.remove("diagramDragging");
	      });
	    }

		    async function exportMermaidDiagramImage(block, button) {
	      const previousLabel = button ? (button.getAttribute("aria-label") || button.title || "Export Mermaid diagram as PNG") : "";
	      try {
	        const svg = block && block.dataset && block.dataset.diagramRendered === "true"
	          ? block.querySelector(".diagramCanvas svg")
	          : undefined;
	        if (!svg) throw new Error("Mermaid diagram is not ready to export.");
	        const dataUrl = await mermaidSvgToPngDataUrl(svg);
	        if (button) setButtonTemporaryLabel(button, "Exporting", previousLabel);
	        setNotice("Choose where to save the Mermaid PNG.");
	        vscode.postMessage({
	          type: "exportMermaidImage",
	          format: "png",
	          dataUrl,
	        });
	      } catch (error) {
	        if (button) setButtonTemporaryLabel(button, "Failed", previousLabel);
	        setNotice(diagramErrorMessage(error));
	      }
	    }

	    async function registerDiagramVisualEvidence(block, input) {
	      try {
	        if (!block || !block.dataset) return;
	        if (block.dataset.messageMode === "mermaid-repair") return;
	        if (!block.dataset.messageId) {
	          if (!input.retry) setTimeout(() => void registerDiagramVisualEvidence(block, Object.assign({}, input, { retry: true })), 0);
	          return;
	        }
	        const rawDataUri = input.dataUri || await mermaidSvgToPngDataUrl(input.svg);
	        const visualProfile = diagramVisualProfile(block, input);
	        const normalized = await normalizeDiagramVisualDataUri(rawDataUri, visualProfile);
	        const sourceHash = input.source ? hashString(String(input.source || "")) : "";
	        const key = [
	          block.dataset.sessionId || "",
	          block.dataset.messageId || "",
	          input.kind || "",
	          block.dataset.diagramId || "",
	          sourceHash,
	          hashString(normalized.dataUri || ""),
	        ].join(":");
	        if (registeredDiagramVisualEvidence.has(key)) return;
	        registeredDiagramVisualEvidence.add(key);
	        vscode.postMessage({
	          type: "registerDiagramVisualEvidence",
	          sessionID: block.dataset.sessionId || "",
	          messageId: block.dataset.messageId || "",
	          diagramId: block.dataset.diagramId || "",
	          kind: input.kind || "mermaid",
	          title: input.title || "",
	          sourceHash,
	          dataUri: normalized.dataUri,
	          width: normalized.width,
	          height: normalized.height,
	        });
	      } catch (error) {
	        postDrawioRenderTelemetry("visual-evidence-failed", { code: "visual.evidence_failed", message: diagramErrorMessage(error) });
	      }
	    }

	    function diagramVisualProfile(block, input) {
	      const dense = isDenseDiagramVisual(block, input);
	      return {
	        dense,
	        maxSide: dense ? DIAGRAM_VISUAL_DENSE_MAX_SIDE : DIAGRAM_VISUAL_NORMAL_MAX_SIDE,
	        minSide: DIAGRAM_VISUAL_READABLE_MIN_SIDE,
	        softMaxBytes: DIAGRAM_VISUAL_SOFT_MAX_BYTES,
	        hardMaxBytes: dense ? DIAGRAM_VISUAL_HARD_MAX_BYTES : DIAGRAM_VISUAL_SOFT_MAX_BYTES,
	      };
	    }

	    function isDenseDiagramVisual(block, input) {
	      const source = String((input && input.source) || "");
	      if (textByteLength(source) >= DIAGRAM_VISUAL_DENSE_SOURCE_BYTES) return true;
	      const kind = String((input && input.kind) || (block && block.dataset && block.dataset.diagramKind) || "").toLowerCase();
	      if (kind === "drawio") {
	        const cellCount = countPattern(source, /<mxCell\\b/gi);
	        const textCellCount = countPattern(source, /\\bvalue="[^"]{2,}"/gi);
	        return cellCount >= DIAGRAM_VISUAL_DENSE_DRAWIO_CELL_COUNT || textCellCount >= DIAGRAM_VISUAL_DENSE_LABEL_COUNT;
	      }
	      if (kind === "mermaid") {
	        const svgTextCount = svgTextElementCount(input && input.svg);
	        const sourceLabelCount = countPattern(source, /(\\[[^\\]]+\\]|\\([^)]{2,}\\)|\\{[^}]+\\})/g);
	        const edgeCount = countPattern(source, /(-->|---|==>|-.->|--x|--o|<--|<-->|~~~)/g);
	        return svgTextCount >= DIAGRAM_VISUAL_DENSE_LABEL_COUNT ||
	          sourceLabelCount >= DIAGRAM_VISUAL_DENSE_LABEL_COUNT ||
	          edgeCount >= DIAGRAM_VISUAL_DENSE_EDGE_COUNT;
	      }
	      return false;
	    }

	    function svgTextElementCount(svg) {
	      try {
	        return svg && typeof svg.querySelectorAll === "function"
	          ? svg.querySelectorAll("text,tspan").length
	          : 0;
	      } catch {
	        return 0;
	      }
	    }

	    function countPattern(value, pattern) {
	      const matches = String(value || "").match(pattern);
	      return matches ? matches.length : 0;
	    }

	    function diagramVisualResizeAttempts(originalLongest, profile) {
	      const target = Math.max(1, Math.min(profile.maxSide, originalLongest));
	      const floor = Math.max(1, Math.min(profile.minSide, target));
	      const attempts = [];
	      let limit = target;
	      while (true) {
	        const rounded = Math.max(1, Math.round(limit));
	        if (!attempts.includes(rounded)) attempts.push(rounded);
	        if (rounded <= floor) break;
	        const next = Math.floor(rounded * 0.75);
	        limit = next < floor ? floor : next;
	      }
	      return attempts;
	    }

	    function normalizeDiagramVisualDataUri(dataUri, profile) {
	      return new Promise((resolve, reject) => {
	        try {
	          const source = String(dataUri || "");
	          if (!/^data:image\\/png;base64,/i.test(source)) throw new Error("Rendered diagram is not a PNG image.");
	          const image = new Image();
	          image.onload = () => {
	            try {
		              const originalWidth = Math.max(1, image.naturalWidth || image.width || 1);
		              const originalHeight = Math.max(1, image.naturalHeight || image.height || 1);
		              const originalLongest = Math.max(originalWidth, originalHeight);
		              const originalBytes = dataUriByteLength(source);
		              const visualProfile = profile || diagramVisualProfile(undefined, {});
		              if (originalLongest <= visualProfile.maxSide && originalBytes <= visualProfile.hardMaxBytes) {
		                resolve({ dataUri: source, width: originalWidth, height: originalHeight });
		                return;
		              }
		              const attempts = diagramVisualResizeAttempts(originalLongest, visualProfile);
		              for (const limit of attempts) {
		                const scale = Math.min(1, limit / originalLongest);
		                const width = Math.max(1, Math.round(originalWidth * scale));
		                const height = Math.max(1, Math.round(originalHeight * scale));
		                const canvas = document.createElement("canvas");
	                canvas.width = width;
	                canvas.height = height;
	                const context = canvas.getContext("2d");
	                if (!context) throw new Error("Canvas export is not available.");
		                context.drawImage(image, 0, 0, width, height);
		                const output = canvas.toDataURL("image/png");
		                if (!/^data:image\\/png;base64,/i.test(output)) throw new Error("Diagram visual export failed.");
		                if (dataUriByteLength(output) <= visualProfile.hardMaxBytes) {
		                  resolve({ dataUri: output, width, height });
		                  return;
		                }
		              }
		              throw new Error("Diagram visual image is too large after readable compression.");
		            } catch (error) {
		              reject(error);
		            }
	          };
	          image.onerror = () => reject(new Error("Rendered diagram PNG could not be loaded."));
	          image.src = source;
	        } catch (error) {
	          reject(error);
	        }
	      });
	    }

	    function dataUriByteLength(dataUri) {
	      const base64 = String(dataUri || "").replace(/^data:image\\/png;base64,/i, "");
	      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	      return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
	    }

	    function mermaidSvgToPngDataUrl(svg) {
	      return new Promise((resolve, reject) => {
	        try {
	          const size = svgExportSize(svg);
	          const clone = svg.cloneNode(true);
	          clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	          clone.setAttribute("width", String(size.width));
	          clone.setAttribute("height", String(size.height));
	          if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", size.viewBox);
	          clone.setAttribute("style", "color: " + getComputedStyle(svg).color + ";");
	          const svgText = new XMLSerializer().serializeToString(clone);
	          const image = new Image();
	          const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
	          const url = URL.createObjectURL(blob);
	          image.onload = () => {
	            try {
	              const scale = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
	              const canvas = document.createElement("canvas");
	              canvas.width = Math.max(1, Math.ceil(size.width * scale));
	              canvas.height = Math.max(1, Math.ceil(size.height * scale));
	              const context = canvas.getContext("2d");
	              if (!context) throw new Error("Canvas export is not available.");
	              context.setTransform(scale, 0, 0, scale, 0, 0);
	              const background = exportCanvasBackground(svg);
	              if (background) {
	                context.fillStyle = background;
	                context.fillRect(0, 0, size.width, size.height);
	              }
	              context.drawImage(image, 0, 0, size.width, size.height);
	              const dataUrl = canvas.toDataURL("image/png");
	              if (!/^data:image\\/png;base64,/i.test(dataUrl)) throw new Error("Mermaid PNG export failed.");
	              resolve(dataUrl);
	            } catch (error) {
	              reject(error);
	            } finally {
	              URL.revokeObjectURL(url);
	            }
	          };
	          image.onerror = () => {
	            URL.revokeObjectURL(url);
	            reject(new Error("Mermaid SVG could not be converted to PNG."));
	          };
	          image.src = url;
	        } catch (error) {
	          reject(error);
	        }
	      });
	    }

	    function svgExportSize(svg) {
	      const viewBox = String(svg.getAttribute("viewBox") || "").trim().split(/[\\s,]+/).map(Number);
	      if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
	        return {
	          width: Math.ceil(viewBox[2]),
	          height: Math.ceil(viewBox[3]),
	          viewBox: viewBox.join(" "),
	        };
	      }
	      const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { width: 0, height: 0 };
	      const width = svgLength(svg.getAttribute("width")) || rect.width || 800;
	      const height = svgLength(svg.getAttribute("height")) || rect.height || 600;
	      return {
	        width: Math.ceil(width),
	        height: Math.ceil(height),
	        viewBox: "0 0 " + Math.ceil(width) + " " + Math.ceil(height),
	      };
	    }

	    function svgLength(value) {
	      const text = String(value || "").trim();
	      if (!text || text.endsWith("%")) return 0;
	      const match = text.match(/^([0-9]+(?:\\.[0-9]+)?)(?:px)?$/i);
	      return match ? Number(match[1]) : 0;
	    }

	    function exportCanvasBackground(svg) {
	      const canvas = svg.closest(".diagramCanvas");
	      const background = canvas ? getComputedStyle(canvas).backgroundColor : "";
	      if (!background || background === "transparent" || /^rgba\\([^,]+,[^,]+,[^,]+,\\s*0\\)$/i.test(background)) return "";
	      return background;
	    }

	    async function renderMermaidDiagram(block, canvas, codeText, language) {
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
		        const svg = preserveMessagesScrollDuringDiagramRender(block, () => {
		          const surface = diagramZoomSurface();
		          surface.innerHTML = result && result.svg ? result.svg : "";
		          canvas.replaceChildren(surface);
		          const renderedSvg = surface.querySelector("svg");
		          if (!renderedSvg) {
		            canvas.replaceChildren(diagramStatus("Mermaid produced an empty diagram.", true));
		            disableDiagramZoom(block);
		            return undefined;
		          }
		          block.dataset.diagramRendered = "true";
		          setDiagramZoom(block, diagramZoomValue(block));
		          return renderedSvg;
		        });
		        if (!svg) return;
		        void registerDiagramVisualEvidence(block, {
		          kind: "mermaid",
		          title: "Mermaid diagram",
	          source,
	          svg,
	        });
	      } catch (error) {
	        const message = diagramErrorMessage(error);
	        renderMermaidFallback(block, canvas, "Mermaid render failed: " + message);
	        postMermaidRenderFailed(block, {
	          source,
	          error: message,
	          language: language || "mermaid",
	        });
	      }
    }

	    function postMermaidRenderFailed(block, input) {
	      try {
	        if (!block || !block.dataset) return;
	        if (!block.dataset.messageId) {
	          if (!input.retry) setTimeout(() => postMermaidRenderFailed(block, Object.assign({}, input, { retry: true })), 0);
	          return;
	        }
	        const source = String(input.source || "");
	        const error = String(input.error || "");
	        if (!source.trim() || !error.trim()) return;
	        const sourceHash = hashString(source);
	        const key = [
	          block.dataset.sessionId || "",
	          block.dataset.messageId || "",
	          block.dataset.diagramId || "",
	          sourceHash,
	          hashString(error),
	        ].join(":");
	        if (postedMermaidRenderFailures.has(key)) return;
	        postedMermaidRenderFailures.add(key);
	        vscode.postMessage({
	          type: "mermaidRenderFailed",
	          sessionID: block.dataset.sessionId || "",
	          messageId: block.dataset.messageId || "",
	          diagramId: block.dataset.diagramId || "",
	          sourceHash,
	          source,
	          error,
	          language: input.language || "mermaid",
	        });
	      } catch {
	        // Rendering already fell back to source view; repair telemetry is best effort.
	      }
	    }

    function initializeMermaid() {
      const mermaid = globalThis.mermaid;
      if (!mermaid || typeof mermaid.initialize !== "function" || typeof mermaid.render !== "function") return undefined;
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: mermaidThemeVariables(),
          htmlLabels: false,
          flowchart: { htmlLabels: false }
        });
        mermaidInitialized = true;
      }
      return mermaid;
    }

    function mermaidThemeVariables() {
      // Keep diagram paper light for readability and PNG export parity in dark VS Code themes.
      return {
        background: "#ffffff",
        mainBkg: "#ffffff",
        primaryColor: "#f8fafc",
        primaryTextColor: "#111827",
        primaryBorderColor: "#94a3b8",
        secondaryColor: "#eef6ff",
        secondaryTextColor: "#111827",
        secondaryBorderColor: "#93c5fd",
        tertiaryColor: "#f7f7fb",
        tertiaryTextColor: "#111827",
        tertiaryBorderColor: "#c4b5fd",
        clusterBkg: "#f8fafc",
        clusterBorder: "#cbd5e1",
        textColor: "#111827",
        nodeTextColor: "#111827",
        lineColor: "#475569",
        edgeLabelBackground: "#ffffff",
        fontFamily: "var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)"
      };
    }

		    function renderMermaidFallback(block, canvas, message) {
		      if (!canvas.isConnected) return;
		      preserveMessagesScrollDuringDiagramRender(block, () => {
		        canvas.replaceChildren(diagramStatus(message, true));
		        disableDiagramZoom(block);
		        block.classList.add("show-source");
		      });
		    }

    async function renderDrawioDiagram(block, canvas, codeText, cacheKey, onReady) {
      const source = String(codeText || "");
      if (!source.trim()) {
        renderDrawioFallback(block, canvas, "Empty draw.io diagram.", { code: "drawio.empty_source", showSource: true });
        return;
      }
      if (!looksLikeDrawioXml(source)) {
        renderDrawioFallback(block, canvas, "Expected draw.io <mxfile> or <mxGraphModel> XML. Source view is available.", { code: "drawio.invalid_source", showSource: true });
        return;
      }
      if (textByteLength(source) > DRAWIO_MAX_SOURCE_BYTES) {
        renderDrawioFallback(block, canvas, "Draw.io source is too large to render. Source view is available.", { code: "drawio.source_too_large", showSource: true });
        return;
      }

      const cacheState = drawioRenderCacheState(cacheKey);
	      if (cacheState === "miss") {
	        const warnings = drawioOfflineWarnings(source);
	        preserveMessagesScrollDuringDiagramRender(block, () => {
	          if (warnings.length) {
	            canvas.replaceChildren(diagramStatus(warnings.join(" "), false));
	          } else {
	            canvas.replaceChildren(diagramStatus("Rendering draw.io diagram...", false));
	          }
	        });
	      }

      try {
        const result = await queueDrawioRuntimeExport(source, cacheKey);
        if (!canvas.isConnected) return;
        const dataUri = String(result && result.data || "");
        if (!/^data:image\\/png;base64,/i.test(dataUri)) {
          throw new Error("Offline draw.io runtime did not return a PNG image.");
        }
	        const image = document.createElement("img");
	        image.className = "drawioImage";
	        image.alt = "Rendered draw.io diagram";
	        image.addEventListener("load", () => {
	          preserveMessagesScrollDuringDiagramRender(block, () => setDiagramZoom(block, diagramZoomValue(block)));
	        }, { once: true });
	        image.src = dataUri;
	        preserveMessagesScrollDuringDiagramRender(block, () => {
	          canvas.replaceChildren(diagramZoomSurface(image));
	          block.dataset.diagramRendered = "true";
	          setDiagramZoom(block, diagramZoomValue(block));
	          onReady(dataUri);
	        });
	      } catch (error) {
	        renderDrawioFallback(block, canvas, drawioFallbackSummary(error), {
          code: drawioFailureCode(error),
          detail: diagramErrorMessage(error),
          showSource: shouldShowDrawioSourceOnFailure(error),
        });
      }
    }

	    function renderDrawioFallback(block, canvas, message, options) {
	      if (!canvas.isConnected) return;
	      const failureCode = options && options.code ? String(options.code) : "drawio.render_failed";
	      const detail = options && options.detail ? String(options.detail) : "";
	      preserveMessagesScrollDuringDiagramRender(block, () => {
	        canvas.replaceChildren(diagramStatus(message, true, failureCode + (detail ? ": " + detail : "")));
	        disableDiagramZoom(block);
	        setDrawioExportUnavailable(block.querySelector(".exportDrawioImage"), "Draw.io PNG export is unavailable until the preview renders.");
	        if (!options || options.showSource !== false) block.classList.add("show-source");
	      });
	    }

    function setDrawioExportUnavailable(button, label) {
      if (!button) return;
      button.disabled = true;
      setIconOnlyButton(button, "save", label);
    }

    function looksLikeDrawioXml(source) {
      return /^\\s*<(?:mxfile|mxGraphModel)(?:\\s|>)/i.test(String(source || ""));
    }

    function drawioOfflineWarnings(source) {
      const warnings = [];
      const text = String(source || "");
      if (/(?:https?:)?\\/\\//i.test(text)) {
        warnings.push("Draw.io source references external URLs; offline rendering will not fetch remote resources.");
      }
      if (/data:image\\/(?!png|svg\\+xml)/i.test(text)) {
        warnings.push("Draw.io source embeds a non-PNG image data URI; export may omit unsupported content.");
      }
      return warnings;
    }

    function drawioFallbackSummary(error) {
      const code = drawioFailureCode(error);
      if (code === "drawio.runtime_unavailable" || /^drawio\\.runtime|self_test|init/i.test(code)) return "离线 draw.io 预览暂不可用";
      if (code === "drawio.export_failed" || /export|png|svg|rasterize/i.test(code)) return "Draw.io PNG export failed.";
      if (code === "drawio.invalid_source" || /expected|empty|too_large|parse|xml|mxfile|mxgraphmodel/i.test(code)) return "Draw.io source could not be rendered.";
      return "Draw.io preview failed.";
    }

    function drawioFailureCode(error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
      if (code) return code;
      const message = diagramErrorMessage(error).toLowerCase();
      if (/initialize|initialise|runtime|iframe|bundled|handshake|stopped|timed out/.test(message)) return "drawio.runtime_unavailable";
      if (/png|svg|export|rasterize/.test(message)) return "drawio.export_failed";
      if (/expected|empty|too large|parse|xml|mxfile|mxgraphmodel/.test(message)) return "drawio.invalid_source";
      return "drawio.render_failed";
    }

    function shouldShowDrawioSourceOnFailure(error) {
      return drawioFailureCode(error) === "drawio.invalid_source";
    }

    function queueDrawioRuntimeExport(xml, cacheKey) {
      if (cacheKey && drawioRenderedPngCache.has(cacheKey)) {
        postDrawioRenderTelemetry("cache-hit", { cacheKey, runtime: "cache" });
        return Promise.resolve({ event: "export", data: drawioRenderedPngCache.get(cacheKey) });
      }
      if (cacheKey && drawioRenderedPngInflight.has(cacheKey)) {
        postDrawioRenderTelemetry("cache-inflight", { cacheKey });
        return drawioRenderedPngInflight.get(cacheKey);
      }
      postDrawioRenderTelemetry("cache-miss", { cacheKey: cacheKey || "none" });
      const task = drawioRuntimeQueue.then(async () => {
        await ensureDrawioRuntimeReady();
        await postDrawioRuntimeMessage({ action: "load", xml });
        return postDrawioRuntimeMessage({
          action: "export",
          format: "xmlpng",
          scale: DRAWIO_EXPORT_SCALE,
          border: DRAWIO_EXPORT_BORDER,
          transparent: false,
          size: "diagram",
        });
      }).then((result) => {
        const dataUri = String(result && result.data || "");
        if (cacheKey && /^data:image\\/png;base64,/i.test(dataUri)) {
          drawioRenderedPngCache.set(cacheKey, dataUri);
        }
        return result;
      }).finally(() => {
        if (cacheKey) drawioRenderedPngInflight.delete(cacheKey);
      });
      if (cacheKey) drawioRenderedPngInflight.set(cacheKey, task);
      drawioRuntimeQueue = task.catch(() => {});
      return task;
    }

    function drawioDiagramCacheKey(diagramId, source) {
      const stableId = String(diagramId || "").trim();
      if (stableId) return "drawio-id:" + DRAWIO_RENDER_BACKGROUND_MODE + ":" + stableId;
      return "drawio-xml:" + DRAWIO_RENDER_BACKGROUND_MODE + ":" + hashString(String(source || ""));
    }

    function drawioRenderCacheState(cacheKey) {
      if (!cacheKey) return "miss";
      if (drawioRenderedPngCache.has(cacheKey)) return "hit";
      if (drawioRenderedPngInflight.has(cacheKey)) return "inflight";
      return "miss";
    }

    async function ensureDrawioRuntimeReady() {
      await ensureDrawioRuntimeFrame();
      if (!drawioRuntimeHandshakePromise) {
        drawioRuntimeHandshakePromise = (async () => {
          await postDrawioRuntimeMessage({ action: "load", xml: DRAWIO_HANDSHAKE_XML });
          const result = await postDrawioRuntimeMessage({
            action: "export",
            format: "xmlpng",
            scale: 1,
            border: 4,
            transparent: false,
            size: "diagram",
          });
          if (!result || !/^data:image\\/png;base64,/i.test(String(result.data || ""))) {
            throw new Error("Offline draw.io runtime handshake did not return PNG.");
          }
        })();
      }
      await drawioRuntimeHandshakePromise;
    }

    function ensureDrawioRuntimeFrame() {
      if (!DRAWIO_RUNTIME_HTML_B64 && !DRAWIO_RUNTIME_URI) {
        postDrawioRenderTelemetry("runtime-missing", { code: "drawio.runtime_unavailable", runtime: "none" });
        return Promise.reject(new Error("Offline draw.io runtime is not bundled with this extension."));
      }
      if (drawioRuntimeReadyPromise) return drawioRuntimeReadyPromise;
      drawioRuntimeReadyPromise = new Promise((resolve, reject) => {
        drawioRuntimeInitResolve = resolve;
        drawioRuntimeInitReject = reject;
        drawioRuntimeInitTimer = setTimeout(() => {
          const error = new Error("Offline draw.io runtime did not initialize.");
          error.code = "drawio.runtime_unavailable";
          postDrawioRenderTelemetry("init-timeout", { code: error.code, message: error.message, runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
          reject(error);
        }, DRAWIO_RENDER_TIMEOUT_MS);
        window.addEventListener("message", handleDrawioRuntimeMessage);
        const frame = document.createElement("iframe");
        frame.className = "drawioRuntimeFrame";
        frame.title = "Offline draw.io renderer";
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
        frame.addEventListener("load", () => {
          postDrawioRenderTelemetry("iframe-load", { runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        });
        try {
          if (DRAWIO_RUNTIME_HTML_B64) {
            frame.srcdoc = decodeDrawioRuntimeHtml();
          } else {
            frame.src = DRAWIO_RUNTIME_URI + (DRAWIO_RUNTIME_URI.indexOf("?") === -1 ? "?" : "&") + "offline=1&local=1";
          }
        } catch (error) {
          window.removeEventListener("message", handleDrawioRuntimeMessage);
          if (drawioRuntimeInitTimer) clearTimeout(drawioRuntimeInitTimer);
          drawioRuntimeInitTimer = undefined;
          reject(error);
          return;
        }
        drawioRuntimeFrame = frame;
        postDrawioRenderTelemetry("iframe-create", { runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        document.body.appendChild(frame);
      }).catch((error) => {
        cleanupDrawioRuntimeFrame();
        throw error;
      });
      return drawioRuntimeReadyPromise;
    }

    function decodeDrawioRuntimeHtml() {
      try {
        const binary = atob(DRAWIO_RUNTIME_HTML_B64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
      } catch (error) {
        const failure = new Error("Offline draw.io runtime HTML could not be decoded.");
        failure.code = "drawio.runtime_decode_failed";
        postDrawioRenderTelemetry("runtime-decode-failed", { code: failure.code, message: diagramErrorMessage(error), runtime: drawioRuntimeMode() });
        throw failure;
      }
    }

    function drawioRuntimeMode() {
      return DRAWIO_RUNTIME_HTML_B64 ? "srcdoc" : "uri";
    }

    function drawioRuntimeFrameSource() {
      if (!drawioRuntimeFrame) return DRAWIO_RUNTIME_HTML_B64 ? "about:srcdoc" : DRAWIO_RUNTIME_URI;
      return drawioRuntimeFrame.getAttribute("src") || drawioRuntimeFrame.src || (DRAWIO_RUNTIME_HTML_B64 ? "about:srcdoc" : DRAWIO_RUNTIME_URI);
    }

    function postDrawioRenderTelemetry(phase, detail) {
      const frameSrc = detail && detail.frameSrc ? String(detail.frameSrc) : drawioRuntimeFrameSource();
      try {
        vscode.postMessage(Object.assign({
          type: "drawioRenderTelemetry",
          phase,
          runtime: drawioRuntimeMode(),
          frameSrc,
          usesCdn: /(?:vscode-cdn\\.net|file\\+\\.vscode-resource)/i.test(frameSrc || DRAWIO_RUNTIME_URI),
        }, detail || {}));
      } catch {
        // Telemetry must never affect rendering.
      }
    }

    function cleanupDrawioRuntimeFrame() {
      if (drawioRuntimeInitTimer) clearTimeout(drawioRuntimeInitTimer);
      drawioRuntimeInitTimer = undefined;
      drawioRuntimeInitResolve = undefined;
      drawioRuntimeInitReject = undefined;
      for (const pending of drawioRuntimePending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Offline draw.io runtime stopped."));
      }
      drawioRuntimePending.clear();
      window.removeEventListener("message", handleDrawioRuntimeMessage);
      if (drawioRuntimeFrame && drawioRuntimeFrame.parentNode) drawioRuntimeFrame.parentNode.removeChild(drawioRuntimeFrame);
      drawioRuntimeFrame = undefined;
      drawioRuntimeReadyPromise = undefined;
      drawioRuntimeHandshakePromise = undefined;
    }

    function handleDrawioRuntimeMessage(event) {
      if (!drawioRuntimeFrame || event.source !== drawioRuntimeFrame.contentWindow) return;
      const message = event.data || {};
      if (!message || message.source !== "chipmate-drawio-runtime") return;
      if (message.event === "init") {
        postDrawioRenderTelemetry("init", { mode: message.mode || "", runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        if (drawioRuntimeInitTimer) clearTimeout(drawioRuntimeInitTimer);
        drawioRuntimeInitTimer = undefined;
        if (drawioRuntimeInitResolve) drawioRuntimeInitResolve();
        drawioRuntimeInitResolve = undefined;
        drawioRuntimeInitReject = undefined;
        return;
      }
      if (message.event === "error" && !message.requestId && drawioRuntimeInitReject) {
        postDrawioRenderTelemetry("init-error", { code: message.code || "", message: message.message || "", mode: message.mode || "", runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        if (drawioRuntimeInitTimer) clearTimeout(drawioRuntimeInitTimer);
        drawioRuntimeInitTimer = undefined;
        drawioRuntimeInitReject(drawioRuntimeMessageError(message));
        drawioRuntimeInitResolve = undefined;
        drawioRuntimeInitReject = undefined;
        return;
      }
      const pending = drawioRuntimePending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      drawioRuntimePending.delete(message.requestId);
      if (message.event === "error") {
        postDrawioRenderTelemetry(pending.action + "-error", { code: message.code || "", message: message.message || "", mode: message.mode || "", requestId: message.requestId || "", runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        pending.reject(drawioRuntimeMessageError(message));
        return;
      }
      if (message.event === "load" || message.event === "export") {
        postDrawioRenderTelemetry(message.event, { mode: message.mode || "", requestId: message.requestId || "", runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
        pending.resolve(message);
      }
    }

    function drawioRuntimeMessageError(message) {
      const error = new Error(message.message || "Offline draw.io runtime error.");
      error.code = message.code || "";
      return error;
    }

    function postDrawioRuntimeMessage(message) {
      if (!drawioRuntimeFrame || !drawioRuntimeFrame.contentWindow) {
        return Promise.reject(new Error("Offline draw.io runtime iframe is unavailable."));
      }
      const requestId = "chipmate-drawio-request-" + (++drawioRuntimeRequestSerial);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          drawioRuntimePending.delete(requestId);
          const error = new Error("Offline draw.io runtime timed out.");
          error.code = "drawio.runtime_unavailable";
          postDrawioRenderTelemetry(String(message.action || "request") + "-timeout", { code: error.code, message: error.message, requestId, runtime: drawioRuntimeMode(), frameSrc: drawioRuntimeFrameSource() });
          reject(error);
        }, DRAWIO_RENDER_TIMEOUT_MS);
        drawioRuntimePending.set(requestId, { resolve, reject, timer, action: String(message.action || "request") });
        drawioRuntimeFrame.contentWindow.postMessage(Object.assign({
          source: "chipmate-chat",
          requestId,
        }, message), "*");
      });
    }

    function hashString(value) {
      let hash = 2166136261;
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function enableDiagramCanvasPan(canvas) {
      if (!canvas || canvas.dataset.diagramPanReady === "true") return;
      canvas.dataset.diagramPanReady = "true";
      let activePointerId = undefined;
      let startClientX = 0;
      let startClientY = 0;
      let startScrollLeft = 0;
      let startScrollTop = 0;

      canvas.addEventListener("pointerdown", (event) => {
        if (!canStartDiagramPan(canvas, event)) return;
        activePointerId = event.pointerId;
        startClientX = event.clientX;
        startClientY = event.clientY;
        startScrollLeft = canvas.scrollLeft;
        startScrollTop = canvas.scrollTop;
        canvas.classList.add("diagramDragging");
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      canvas.addEventListener("pointermove", (event) => {
        if (activePointerId !== event.pointerId) return;
        canvas.scrollLeft = startScrollLeft - (event.clientX - startClientX);
        canvas.scrollTop = startScrollTop - (event.clientY - startClientY);
        event.preventDefault();
      });

      const endPan = (event) => {
        if (activePointerId !== event.pointerId) return;
        if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
          canvas.releasePointerCapture(event.pointerId);
        }
        activePointerId = undefined;
        canvas.classList.remove("diagramDragging");
      };

      canvas.addEventListener("pointerup", endPan);
      canvas.addEventListener("pointercancel", endPan);
      canvas.addEventListener("lostpointercapture", () => {
        activePointerId = undefined;
        canvas.classList.remove("diagramDragging");
      });
    }

    function canStartDiagramPan(canvas, event) {
      if (!canvas.classList.contains("zoomed-in")) return false;
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (!diagramCanvasHasOverflow(canvas)) return false;
      const target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
      if (target && target.closest("button, a, input, textarea, select, summary, details, pre, code")) return false;
      return true;
    }

    function diagramCanvasHasOverflow(canvas) {
      return canvas.scrollWidth > canvas.clientWidth + 1 || canvas.scrollHeight > canvas.clientHeight + 1;
    }

    function updateDiagramZoomSurface(canvas, zoom) {
      const surface = canvas.querySelector(".diagramZoomSurface");
      if (!surface) return;
      if (zoom <= DIAGRAM_ZOOM_DEFAULT) {
        surface.style.removeProperty("--diagram-zoom-content-width");
        surface.style.removeProperty("--diagram-zoom-content-height");
        return;
      }
      const baseSize = diagramZoomBaseSize(canvas, surface);
      surface.style.setProperty("--diagram-zoom-content-width", Math.max(1, Math.round(baseSize.width * zoom)) + "px");
      surface.style.setProperty("--diagram-zoom-content-height", Math.max(1, Math.round(baseSize.height * zoom)) + "px");
    }

    function diagramZoomBaseSize(canvas, surface) {
      const width = diagramCanvasInnerWidth(canvas);
      const intrinsic = diagramZoomIntrinsicSize(surface);
      if (intrinsic && intrinsic.width > 0 && intrinsic.height > 0) {
        return { width, height: Math.max(1, width * (intrinsic.height / intrinsic.width)) };
      }
      const rect = surface.getBoundingClientRect ? surface.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        width: Math.max(1, width || rect.width || 800),
        height: Math.max(1, rect.height || canvas.clientHeight || 600),
      };
    }

    function diagramCanvasInnerWidth(canvas) {
      const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0 };
      const style = getComputedStyle(canvas);
      const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      return Math.max(1, (canvas.clientWidth || rect.width || 800) - paddingX);
    }

    function diagramCanvasMaxHeight() {
      const root = el("messages");
      const rootHeight = root && root.clientHeight ? root.clientHeight : window.innerHeight || 900;
      return Math.max(220, Math.min(900, rootHeight - 48));
    }

    function diagramZoomIntrinsicSize(surface) {
      const svg = surface.querySelector("svg");
      if (svg) return svgExportSize(svg);
      const image = surface.querySelector("img.drawioImage");
      if (image) {
        const rect = image.getBoundingClientRect ? image.getBoundingClientRect() : { width: 0, height: 0 };
        const width = image.naturalWidth || image.width || rect.width || 0;
        const height = image.naturalHeight || image.height || rect.height || 0;
        if (width > 0 && height > 0) return { width, height };
      }
      return undefined;
    }

	    function setDiagramZoom(block, value) {
	      const zoom = normalizeDiagramZoom(value);
	      block.dataset.diagramZoom = String(zoom);
		      const canvas = block.querySelector(".diagramCanvas");
		      if (canvas) {
		        canvas.style.setProperty("--diagram-zoom", String(zoom));
		        canvas.style.setProperty("--diagram-zoom-width", Math.round(zoom * 100) + "%");
		        canvas.style.setProperty("--diagram-canvas-max-height", diagramCanvasMaxHeight() + "px");
		        updateDiagramZoomSurface(canvas, zoom);
		        canvas.classList.toggle("zoomed-in", zoom > DIAGRAM_ZOOM_DEFAULT);
		        if (zoom <= DIAGRAM_ZOOM_DEFAULT) canvas.classList.remove("diagramDragging");
	      }
	      updateDiagramZoomControls(block);
	    }

	    function diagramZoomValue(block) {
	      return normalizeDiagramZoom(Number(block && block.dataset ? block.dataset.diagramZoom : undefined));
	    }

	    function normalizeDiagramZoom(value) {
	      const raw = Number.isFinite(value) ? value : DIAGRAM_ZOOM_DEFAULT;
	      const stepped = Math.round(raw / DIAGRAM_ZOOM_STEP) * DIAGRAM_ZOOM_STEP;
	      return Math.max(DIAGRAM_ZOOM_MIN, Math.min(DIAGRAM_ZOOM_MAX, Number(stepped.toFixed(2))));
	    }

		    function updateDiagramZoomControls(block) {
		      const zoom = diagramZoomValue(block);
		      const rendered = block.dataset.diagramRendered === "true";
		      const zoomOut = block.querySelector(".diagramZoomOut");
		      const zoomIn = block.querySelector(".diagramZoomIn");
		      const viewer = block.querySelector(".openDiagramViewer");
		      if (zoomOut) zoomOut.disabled = !rendered || zoom <= DIAGRAM_ZOOM_MIN;
		      if (zoomIn) zoomIn.disabled = !rendered || zoom >= DIAGRAM_ZOOM_MAX;
		      if (viewer) viewer.disabled = !rendered;
		    }

			    function disableDiagramZoom(block) {
	      block.dataset.diagramRendered = "false";
	      updateDiagramZoomControls(block);
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

    function documentRagControlActions(documentRag) {
      const actions = [
        { label: "Rebuild", message: "rebuildDocumentRag", title: "Rebuild Document RAG" },
        { label: "Status", message: "showDocumentRagStatus", title: "Show Document RAG status" },
      ];
      if (documentRag && (documentRag.availability === "indexing" || documentRag.availability === "scanning")) {
        return [
          { label: "Pause", message: "pauseDocumentRagIndexing", title: "Pause Document RAG indexing" },
          ...actions,
        ];
      }
      if (documentRag && (documentRag.availability === "paused" || documentRag.availability === "large-workspace-paused")) {
        return [
          { label: "Resume", message: "resumeDocumentRagIndexing", title: "Resume Document RAG indexing" },
          ...actions,
        ];
      }
      return actions;
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
	      if (rag.availability === "unavailable") return "RAG unavailable" + (rag.fallbackReason ? ": " + rag.fallbackReason : "") + ragResumeScheduleMeta(rag) + rerank;
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
	      const label = rag.resumeReason === "rate-limit" || rag.resumeReason === "probe" ? "retry scheduled" : "resume scheduled";
      return "; " + label + " in " + Math.ceil(remainingMs / 1000) + "s";
    }

    function documentRagMeta(documentRag) {
      if (!documentRag) return "Document RAG status is not loaded.";
      const parts = [];
      if (documentRag.availability === "no-documents") parts.push("No Word, Excel, or PDF documents found");
      else if (documentRag.availability === "not-configured") parts.push(documentRag.fallbackReason || "Embedding endpoint is not configured");
      else if (documentRag.availability === "disabled") parts.push("Document RAG disabled");
      else parts.push("Documents " + formatCount(documentRag.indexedDocuments || 0) + "/" + formatCount(documentRag.documentCount || 0));
      if (documentRag.chunks || documentRag.embeddedChunks) parts.push("chunks " + formatCount(documentRag.embeddedChunks || 0) + "/" + formatCount(documentRag.chunks || 0));
      if (documentRag.pendingDocuments) parts.push(formatCount(documentRag.pendingDocuments) + " pending");
      if (documentRag.skippedDocuments) parts.push(formatCount(documentRag.skippedDocuments) + " skipped");
      if (documentRag.provider) parts.push("provider " + documentRag.provider);
      if (documentRag.model) parts.push("model " + documentRag.model);
      if (documentRag.lastScanAt) parts.push("scanned " + formatDateTime(documentRag.lastScanAt));
      if (documentRag.updatedAt) parts.push("updated " + formatDateTime(documentRag.updatedAt));
      if (documentRag.fallbackReason && documentRag.availability !== "not-configured") parts.push(documentRag.fallbackReason);
      if (documentRag.lastError) parts.push("last error: " + documentRag.lastError);
      return parts.filter(Boolean).join(" · ");
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

    function formatTokenCount(value) {
      const number = Number(value || 0);
      const absolute = Math.abs(number);
      if (absolute >= 100000000) return (Math.round(number / 10000000) / 10).toFixed(1).replace(/\\.0$/, "") + "B";
      if (absolute >= 1000000) return (Math.round(number / 100000) / 10).toFixed(1).replace(/\\.0$/, "") + "M";
      if (absolute >= 1000) return (Math.round(number / 100) / 10).toFixed(1).replace(/\\.0$/, "") + "K";
      return String(Math.round(number));
    }

    function formatTaskDuration(value) {
      const label = formatDuration(value);
      return label
        .replace(/h/g, "h")
        .replace(/m/g, "m")
        .replace(/s/g, "s");
    }

    function shortDateLabel(value) {
      if (!value) return "";
      const date = new Date(String(value).length <= 10 ? String(value) + "T00:00:00" : value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
        if (button.classList.contains("composerMoreItem")) {
          setComposerMoreActionButton(button, {
            icon: "refresh",
            label: input.label,
            meta: "Reload provider model list",
            title: input.label,
            disabled: Boolean(input.disabled),
            loading: Boolean(input.loading),
          });
          renderComposerMoreTrigger();
          return;
        }
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
        renderComposerMoreActionButtons();
        renderComposerMoreTrigger();
	      trigger.setAttribute("aria-expanded", composerMoreMenuOpen ? "true" : "false");
	      root.className = "modelMenu composerMoreMenu" + (composerMoreMenuOpen ? " open" : "");
	      root.setAttribute("aria-hidden", composerMoreMenuOpen ? "false" : "true");
	      if (composerMoreMenuOpen) positionComposerMoreMenu();
	    }

    function positionComposerMoreMenu() {
      if (!composerMoreMenuOpen) return;

      const root = el("composerMoreMenu");
      const trigger = el("composerMore");
      if (!root || !trigger) return;

      const triggerRect = trigger.getBoundingClientRect();
      const wrapRect = document.querySelector(".composerWrap")?.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 320;
      const margin = 8;
      const gap = 6;
      const maxAvailableWidth = Math.max(120, viewportWidth - margin * 2);
      const anchorWidth = wrapRect ? wrapRect.width : viewportWidth;
      const preferredWidth = Math.max(180, Math.min(320, anchorWidth), triggerRect.width);
      const width = Math.min(maxAvailableWidth, preferredWidth);
      let left = Math.max(margin, Math.min(triggerRect.left, viewportWidth - margin - width));
      if (left + width > viewportWidth - margin) {
        left = Math.max(margin, viewportWidth - margin - width);
      }

      const menuBottomY = Math.max(margin + 48, triggerRect.top - gap);
      const bottom = Math.max(margin, viewportHeight - menuBottomY);
      const maxHeight = Math.max(48, menuBottomY - margin);

      root.style.left = Math.round(left) + "px";
      root.style.width = Math.floor(width) + "px";
      root.style.bottom = Math.round(bottom) + "px";
      root.style.maxHeight = Math.floor(maxHeight) + "px";
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
	      renderContextChips();
	      renderQueuedSendList();
	      renderComposerStatusBar();
	    }

	    function renderQueuedSendList() {
	      const root = el("queuedSendList");
	      if (!root) return;
	      const items = queuedSendItems();
	      root.textContent = "";
	      for (let index = 0; index < items.length; index += 1) root.appendChild(queuedSendNode(items[index], index, items.length));
	      root.className = "queuedSendList" + (items.length ? " visible" : "");
	      root.hidden = items.length === 0;
	    }

	    function queuedSendItems() {
	      const canonical = normalizeQueuedSends(state.queuedSends, false);
	      const canonicalIDs = new Set(canonical.map((item) => item.id).filter(Boolean));
	      const pending = optimisticQueuedSends.filter((item) => !canonicalIDs.has(item.id));
	      return canonical.concat(pending);
	    }

	    function queuedSendNode(item, index, total) {
	      const node = document.createElement("div");
	      node.className = "queuedSendItem";
	      const main = document.createElement("div");
	      main.className = "queuedSendMain";
	      const text = document.createElement("div");
	      text.className = "queuedSendText";
	      const displayText = queuedSendDisplayText(item);
	      text.textContent = displayText;
	      text.title = displayText;
	      const meta = document.createElement("div");
	      meta.className = "queuedSendMeta";
	      meta.textContent = queuedSendMeta(item, index, total);
	      main.append(text, meta);
	      const actions = document.createElement("div");
	      actions.className = "queuedSendActions";
	      const pending = Boolean(item.optimistic);
	      const edit = document.createElement("button");
	      edit.type = "button";
	      edit.className = "queuedSendAction oc-icon-btn oc-liquid-btn";
	      edit.disabled = pending;
	      setIconOnlyButton(edit, "edit", pending ? "Waiting for queue confirmation" : "Edit queued message");
	      edit.addEventListener("click", () => vscode.postMessage({ type: "editQueuedSend", id: item.id }));
	      const remove = document.createElement("button");
	      remove.type = "button";
	      remove.className = "queuedSendAction oc-icon-btn oc-liquid-btn";
	      remove.disabled = pending;
	      setIconOnlyButton(remove, "discard", pending ? "Waiting for queue confirmation" : "Delete queued message");
	      remove.addEventListener("click", () => vscode.postMessage({ type: "deleteQueuedSend", id: item.id }));
	      actions.append(edit, remove);
	      node.append(main, actions);
	      return node;
	    }

	    function queuedSendDisplayText(item) {
	      const text = item && typeof item.text === "string" ? item.text.trim() : "";
	      if (item && item.kind === "goal") return text ? "Goal: " + text : "Goal";
	      return text || "Please review the referenced context.";
	    }

	    function queuedSendMeta(item, index, total) {
	      const goal = item && item.kind === "goal";
	      const files = normalizeDraftMentionedFiles(item && item.mentionedFiles);
	      const parts = [goal ? "Goal queued " + String(index + 1) + "/" + String(total) : "Queued " + String(index + 1) + "/" + String(total)];
	      if (item && item.optimistic) parts.push("Pending");
	      if (files.length) parts.push(String(files.length) + " file" + (files.length === 1 ? "" : "s"));
	      return parts.join(" · ");
	    }

	    function renderContextChips() {
	      const root = el("contextChips");
	      if (!root) return;
	      root.textContent = "";
	      const items = contextItems();
	      if (selectedContextItemId && !items.some((item) => item.id === selectedContextItemId)) selectedContextItemId = "";
	      for (const item of items) root.appendChild(contextItemChip(item));
	      for (const file of mentionedFiles) root.appendChild(mentionChip(file));
	      root.className = "contextChips" + (root.childElementCount ? " visible" : "");
	    }

	    function contextItems() {
	      if (Array.isArray(state.contextItems)) return state.contextItems;
	      return (state.contextFiles || []).map((label, index) => ({
	        id: "legacy-file-" + index,
	        kind: "file",
	        label,
	        path: label,
	      }));
	    }

	    function contextPathSet() {
	      const paths = new Set(contextItems().map((item) => item.path).filter(Boolean));
	      for (const file of mentionedFiles) {
	        if (file.label) paths.add(file.label);
	        if (file.insertText) paths.add(file.insertText);
	      }
	      return paths;
	    }

	    function selectedContextItem() {
	      return selectedContextItemId ? contextItems().find((item) => item.id === selectedContextItemId) : undefined;
	    }

	    function isContextItemPinned(item) {
	      return Boolean(item && item.lifetime === "persistent");
	    }

	    function contextPinTitle(pinned) {
	      return pinned ? "Pinned: stays in context after sending" : "Pin to keep after sending";
	    }

	    function contextItemChip(item) {
	      const node = document.createElement("span");
	      const pinned = isContextItemPinned(item);
	      node.className = "contextChip " + item.kind + (pinned ? " is-pinned" : "");
	      const main = document.createElement("button");
	      main.className = "contextChipMain";
	      main.type = "button";
	      main.title = contextItemDetailTitle(item);
	      main.setAttribute("data-select-context-item", item.id);
	      const icon = document.createElement("span");
	      icon.className = "contextChipIcon";
	      icon.setAttribute("aria-hidden", "true");
	      appendLiquidIcon(icon, item.kind === "selection" ? "selection" : "file");
	      const label = document.createElement("span");
	      label.className = "contextChipLabel";
	      label.textContent = contextItemTitle(item);
	      main.append(icon, label);
	      if (item.kind === "selection" && item.startLine === item.endLine && item.inlinePreview) {
	        const preview = document.createElement("span");
	        preview.className = "contextChipPreview";
	        preview.textContent = item.inlinePreview;
	        main.appendChild(preview);
	      }
	      main.addEventListener("click", (event) => {
	        event.stopPropagation();
	        selectContextItem(item.id);
	      });
	      const pin = document.createElement("button");
	      pin.className = "contextChipPin";
	      pin.type = "button";
	      pin.title = contextPinTitle(pinned);
	      pin.setAttribute("aria-label", contextPinTitle(pinned));
	      pin.setAttribute("aria-pressed", pinned ? "true" : "false");
	      appendLiquidIcon(pin, "pin");
	      pin.addEventListener("click", (event) => {
	        event.stopPropagation();
	        vscode.postMessage({ type: "toggleContextPin", id: item.id, pinned: !pinned });
	      });
	      const remove = document.createElement("button");
	      remove.className = "contextChipRemove";
	      remove.type = "button";
	      remove.title = "Remove " + contextItemTitle(item);
	      remove.setAttribute("aria-label", "Remove " + contextItemTitle(item));
	      appendLiquidIcon(remove, "close");
	      remove.addEventListener("click", (event) => {
	        event.stopPropagation();
	        if (selectedContextItemId === item.id) selectedContextItemId = "";
	        vscode.postMessage({ type: "removeContextItem", id: item.id });
	      });
	      node.append(main, pin, remove);
	      return node;
	    }

	    function mentionChip(file) {
	      const node = document.createElement("span");
	      node.className = "contextChip mention";
	      const main = document.createElement("span");
	      main.className = "contextChipMain";
	      const icon = document.createElement("span");
	      icon.className = "contextChipIcon";
	      icon.setAttribute("aria-hidden", "true");
	      appendLiquidIcon(icon, file.type === "folder" ? "file" : "references");
	      const label = document.createElement("span");
	      label.className = "contextChipLabel";
	      label.textContent = "@" + (file.type === "folder" ? (file.insertText || (String(file.label || "").replace(new RegExp("/+$"), "") + "/")) : file.label);
	      main.append(icon, label);
	      const remove = document.createElement("button");
	      remove.className = "contextChipRemove";
	      remove.type = "button";
	      remove.title = "Remove " + file.label;
	      remove.setAttribute("aria-label", "Remove " + file.label);
	      appendLiquidIcon(remove, "close");
	      remove.addEventListener("click", (event) => {
	        event.stopPropagation();
	        removeMention(file.uri);
	      });
	      if (file.type !== "folder") {
	        const pin = document.createElement("button");
	        pin.className = "contextChipPin";
	        pin.type = "button";
	        pin.title = contextPinTitle(false);
	        pin.setAttribute("aria-label", contextPinTitle(false));
	        pin.setAttribute("aria-pressed", "false");
	        appendLiquidIcon(pin, "pin");
	        pin.addEventListener("click", (event) => {
	          event.stopPropagation();
	          vscode.postMessage({ type: "toggleContextPin", pinned: true, file });
	          removeMention(file.uri);
	          setNotice("Pinned " + file.label + " to context.");
	        });
	        node.append(main, pin, remove);
	        return node;
	      }
	      node.append(main, remove);
	      return node;
	    }

	    function selectContextItem(id) {
	      selectedContextItemId = id;
	      composerPinnedStatusPopover = "context";
	      composerHoverStatusPopover = "";
	      closeComposerPopups();
	      renderContextChips();
	      renderComposerStatusBar();
	    }

	    function contextItemTitle(item) {
	      if (item.kind === "selection") return "Selection · " + item.label + ":" + item.startLine + "-" + item.endLine;
	      return "File · " + item.label;
	    }

	    function contextItemDetailTitle(item) {
	      if (item.kind === "selection") return "Selection from " + item.path + ":" + item.startLine + "-" + item.endLine;
	      return "File " + item.path;
	    }

    function renderSuggestions() {
      const root = el("suggestions");
      root.innerHTML = "";
      const trigger = currentComposerTrigger();
      const mode = trigger ? trigger.type : suggestionMode;
      const shouldOpen = Boolean(trigger && (mentionStatus || mentionError || mentionTruncated || mentionSearched || mentionResults.length > 0));
      if (!shouldOpen) {
        root.className = "suggestions";
        return;
      }
      root.className = "suggestions open";
      if (mentionStatus === "searching") {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = mode === "skill" ? "Searching enabled skills..." : "Searching workspace files...";
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
        row.textContent = mode === "skill" ? skillSuggestionEmptyText() : "No files found.";
        root.appendChild(row);
      }
      if (mentionTruncated) {
        const row = document.createElement("div");
        row.className = "suggestionMeta";
        row.textContent = "Index truncated; keep typing to narrow results.";
        root.appendChild(row);
      }
      mentionResults.forEach((item, index) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "suggestion " + (index === activeSuggestion ? "active" : "");
        node.title = suggestionTitle(item);
        node.setAttribute("aria-label", suggestionTitle(item));
        const icon = document.createElement("span");
        icon.className = "suggestionIcon";
        icon.setAttribute("aria-hidden", "true");
        appendLiquidIcon(icon, suggestionIconName(item));
        const main = document.createElement("span");
        main.className = "suggestionMain";
        const label = document.createElement("span");
        label.className = "suggestionLabel";
        label.textContent = suggestionLabel(item);
        main.appendChild(label);
        const detailText = suggestionDetail(item);
        if (detailText) {
          const detail = document.createElement("span");
          detail.className = "suggestionDetail";
          detail.textContent = detailText;
          main.appendChild(detail);
        }
        node.append(icon, main);
        node.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectSuggestion(item);
        });
        root.appendChild(node);
      });
    }

    function skillSuggestionEmptyText() {
      return enabledSkillSuggestions().length ? "No matching skills." : "No enabled skills found.";
    }

    function suggestionTitle(item) {
      if (!item) return "";
      if (item.kind === "skill") return "$" + (item.label || item.insertText || "skill") + (item.description ? ": " + item.description : "");
      return item.label || "";
    }

    function suggestionLabel(item) {
      if (!item) return "";
      if (item.kind === "skill") return "$" + (item.label || item.insertText || "skill");
      return item.label || "";
    }

    function suggestionDetail(item) {
      if (!item) return "";
      if (item.kind === "skill") return item.description || item.meta || "";
      if (item.type === "folder") return "Folder";
      return "File";
    }

    function suggestionIconName(item) {
      if (item && item.kind === "skill") return "skillBlocks";
      if (item && item.type === "folder") return "file";
      return "references";
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
