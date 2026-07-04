import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("model selection flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
  const directClientSource = readFileSync(join(import.meta.dir, "..", "src", "direct-agent-client.ts"), "utf8")

  test("loads models through OpenAI-compatible /models with configured fallback names", () => {
    expect(directClientSource).toContain("async listModels")
    expect(directClientSource).toContain("async listCompletionModels")
    expect(directClientSource).toContain("baseUrl: settings.provider.apiBaseUrl")
    expect(directClientSource).toContain("baseUrl: completionApiBaseUrl(input.settings)")
    expect(directClientSource).toContain("/models unavailable, using configured models")
    expect(directClientSource).toContain("configuredModels(settings)")
    expect(directClientSource).toContain("normalizeModelInfos")
    expect(directClientSource).toContain('source: "provider"')
    expect(directClientSource).toContain('source: "configured"')
    expect(directClientSource).toContain("providerIndex")
  })

  test("posts model state to the webview and persists selection", () => {
    expect(chatViewSource).toContain('{ type: "selectModel"; model: string }')
    expect(chatViewSource).toContain("private async selectModel")
    expect(chatViewSource).toContain('config.update("provider.chatModel"')
    expect(chatViewSource).toContain("selectedModel: settings.defaultModel")
    expect(chatViewSource).toContain("models: this.models")
    expect(chatViewSource).toContain("completionModels: this.completionModels")
    expect(chatViewSource).toContain("completionModelsLoaded: this.completionModelsLoaded")
  })

  test("renders model selector and manual fallback", () => {
    expect(chatHtmlSource).toContain('id="modelSelect"')
    expect(chatHtmlSource).toContain('id="modelTrigger"')
    expect(chatHtmlSource).toContain('id="modelMenu"')
    expect(chatHtmlSource).toContain('id="refreshModels"')
    expect(chatHtmlSource).toContain('class="composerActionRow toggles composerContextRail"')
    expect(chatHtmlSource).toContain('class="composerToolbar composerPrimaryRail composerControlRail"')
    expect(chatHtmlSource).toContain('class="composerPickerRail"')
    expect(chatHtmlSource).toContain('id="permissionStatusPill" class="composerStatusPill permissionTrigger oc-chip oc-liquid-chip permission tools-off is-empty"')
    expect(chatHtmlSource).toContain("liquidIcons.toolDisabled")
    expect(chatHtmlSource).not.toContain("${liquidIcons.stop}</span></button>")
    expect(chatHtmlSource).toContain('id="composerMore"')
    expect(chatHtmlSource).toContain('id="composerMoreMenu" class="modelMenu composerMoreMenu"')
    expect(chatHtmlSource).toContain('composerAddButton')
    expect(chatHtmlSource).toContain('composerAddGlyph')
    expect(chatHtmlSource).not.toContain('composerAddButton composerMoreButton chat-toolbar-icon-button oc-icon-btn')
    expect(chatHtmlSource).toContain('role="menuitemcheckbox"')
    expect(chatHtmlSource).toContain("Use as context")
    expect(chatHtmlSource).not.toContain('class="composerCommandRail"')
    expect(chatHtmlSource).toContain('class="composerSupportRail" aria-label="Composer status details"')
    expect(chatHtmlSource).toContain('id="refreshModels" class="modelMenuItem composerMoreItem composerMoreAction"')
    expect(chatHtmlSource).toContain('id="diffToggle" class="modelMenuItem composerMoreItem composerMoreToggle"')
    expect(chatHtmlSource).toContain('aria-label="Include git diff" aria-checked="false"')
    expect(chatHtmlSource).not.toContain("composerIconActions")
    expect(chatHtmlSource).toContain("setIconButtonState")
    expect(chatHtmlSource).toContain("Refreshing models")
    expect(chatHtmlSource).toContain('id="manualModel"')
    expect(chatHtmlSource).toContain('type: "refreshModels"')
    expect(chatHtmlSource).toContain('type: "selectModel"')
    expect(chatHtmlSource).toContain("renderModelMenu")
    expect(chatHtmlSource).toContain("toggleModelMenu")
    expect(chatHtmlSource).toContain("Use provider default")
    expect(chatHtmlSource).toContain("Manual...")
  })

  test("renders completion model selection from profile-aware provider models", () => {
    expect(chatHtmlSource).toContain('<label class="field">Provider mode<select id="completionProviderMode">')
    expect(chatHtmlSource).toContain('<label class="field">API Base URL<input id="completionApiBaseUrl" type="url"')
    expect(chatHtmlSource).toContain('<label class="field">API key<input id="completionApiKey" type="password"')
    expect(chatHtmlSource).toContain('<label class="field">Model<select id="completionModel"></select></label>')
    expect(chatHtmlSource).toContain('id="resetCompletionProvider"')
    expect(chatHtmlSource).toContain('id="completionContextLength"')
    expect(chatHtmlSource).toContain('title="0 = auto detect via /models"')
    expect(chatHtmlSource).toContain('id="refreshCompletionModels"')
    expect(chatHtmlSource).toContain('type: "refreshCompletionModels"')
    expect(chatHtmlSource).toContain("const models = state.completionModelsLoaded ? (state.completionModels || []) : (state.models || []);")
    expect(chatHtmlSource).toContain("function completionCandidateModels(profile, savedModel)")
    expect(chatHtmlSource).toContain('model.source !== "provider"')
    expect(chatHtmlSource).toContain('if (profile === "deepseek-fim") return text.includes("deepseek")')
    expect(chatHtmlSource).toContain('return text.includes("qwen") && text.includes("coder")')
    expect(chatHtmlSource).toContain("completionModelMatchesProfile(configured.toLowerCase(), profile)")
    expect(chatHtmlSource).toContain(".sort((left, right) => (left.providerIndex ?? 1e9) - (right.providerIndex ?? 1e9))")
    expect(chatHtmlSource).toContain("completionModelId(candidates[0])")
    expect(chatHtmlSource).toContain("No Qwen Coder completion model")
    expect(chatHtmlSource).toContain("No DeepSeek FIM completion model")
    expect(chatHtmlSource).toContain("无可用补全模型，补全暂不可用")
    expect(chatHtmlSource).toContain('numberInputValue("completionContextLength", 200000)')
    expect(chatHtmlSource).toContain('el("completionContextLength").value = String(completion.contextLength ?? 200000);')
    expect(chatHtmlSource).toContain('const providerMode = el("completionProviderMode").value;')
    expect(chatHtmlSource).toContain("providerMode,")
    expect(chatHtmlSource).toContain('apiBaseUrl: providerMode === "custom" ? el("completionApiBaseUrl").value : ""')
    expect(chatHtmlSource).toContain("el(\"saveCompletionSettings\").disabled = unavailable")
    expect(chatHtmlSource).toContain("el(\"testCompletionApi\").disabled = !direct || unavailable")
  })

  test("derives Complete status from inline completion config and profile-aware candidates", () => {
    const statusStart = chatHtmlSource.indexOf("function completionStatusInfo()")
    const statusEnd = chatHtmlSource.indexOf("function completionStatusModel", statusStart)
    const statusBody = chatHtmlSource.slice(statusStart, statusEnd)

    expect(chatHtmlSource).toContain("function composerCompletionStatus()")
    expect(chatHtmlSource).toContain("function completionStatusInfo()")
    expect(chatHtmlSource).toContain("function renderSettingsHomeStatuses()")
    expect(chatHtmlSource).toContain("function renderCompletionStatusPopover")
    expect(statusBody).toContain("const completion = state.completion || {}")
    expect(statusBody).toContain('const provider = completion.provider || "qwen-direct"')
    expect(statusBody).toContain('const profile = completion.profile || "qwen-coder-fim"')
    expect(statusBody).toContain("const candidates = completionCandidateModels(profile, completion.model)")
    expect(statusBody).toContain('if (!enabled || provider === "none")')
    expect(statusBody).toContain('if (provider !== "qwen-direct" && provider !== "fim-direct")')
    expect(statusBody).toContain("if (!candidates.length)")
    expect(statusBody).toContain('label: "Complete on"')
    expect(statusBody).toContain('label: "Complete off"')
    expect(statusBody).toContain('label: "Complete unavailable"')
    expect(statusBody).toContain('tileLabel: "On"')
    expect(statusBody).toContain('tileLabel: "Off"')
    expect(statusBody).toContain('tileLabel: "Unavailable"')
    expect(statusBody).toContain("completionStatusModel(savedModel, candidates)")
    expect(statusBody).toContain('iconState: "enabled"')
    expect(statusBody).toContain('iconState: "disabled"')
    expect(statusBody).toContain('ariaLabel: "Autocomplete enabled"')
    expect(statusBody).toContain('ariaLabel: "Autocomplete disabled"')
    expect(statusBody).toContain('ariaLabel: "Autocomplete unavailable"')
    expect(statusBody).not.toContain("state.rag")
    expect(statusBody).not.toContain("state.codeGraph")
    expect(statusBody).not.toContain("state.skills")
    expect(statusBody).not.toContain("state.selectedModel")
    expect(chatHtmlSource).toContain("Autocomplete enabled · inline code completion is available")
    expect(chatHtmlSource).toContain("Autocomplete disabled · inline code completion is off")
    expect(chatHtmlSource).toContain('"Autocomplete unavailable · no " + (profile === "deepseek-fim" ? "DeepSeek FIM" : "Qwen Coder") + " completion model was returned by the provider"')
  })

  test("keeps the custom model menu visible and discoverable", () => {
    const composerRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .composer {"),
      chatHtmlSource.indexOf("    .composer:focus-within"),
    )
    const triggerRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .modelTrigger {"),
      chatHtmlSource.indexOf("    .modelTrigger:hover", chatHtmlSource.lastIndexOf("    .modelTrigger {")),
    )
    const pickerRuleStart = chatHtmlSource.indexOf("    .composerPickerRail {")
    const pickerModelRuleStart = chatHtmlSource.indexOf("    .composerPickerRail .modelTrigger {")
    const pickerAgentRuleStart = chatHtmlSource.indexOf("    .composerPickerRail .agentTrigger {")
    const toolbarSendRuleStart = chatHtmlSource.indexOf("    .composerToolbar .send {")
    const warningChipRuleStart = chatHtmlSource.indexOf("    .composerPickerRail .agentTrigger.warning,")
    const toolbarRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .composerToolbar {", pickerRuleStart),
      pickerRuleStart,
    )
    const pickerRule = chatHtmlSource.slice(
      pickerRuleStart,
      pickerModelRuleStart,
    )
    const pickerModelRule = chatHtmlSource.slice(
      pickerModelRuleStart,
      pickerAgentRuleStart,
    )
    const pickerAgentRule = chatHtmlSource.slice(
      pickerAgentRuleStart,
      toolbarSendRuleStart,
    )
    const toolbarSendRule = chatHtmlSource.slice(
      toolbarSendRuleStart,
      chatHtmlSource.indexOf("    .composerToolbar .oc-liquid-chip-label"),
    )
    const warningChipRule = chatHtmlSource.slice(
      warningChipRuleStart,
      chatHtmlSource.indexOf("    .agentTrigger.warning .oc-liquid-chip-label"),
    )
    const composerIconSizeRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .chat-toolbar-icon-button,"),
      chatHtmlSource.indexOf("    .composerSupportRail {", chatHtmlSource.indexOf("    .chat-toolbar-icon-button,")),
    )
    const composerIconGlyphRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .chat-toolbar-icon-slot .oc-liquid-icon,"),
      chatHtmlSource.indexOf("    .index-status-icon {", chatHtmlSource.indexOf("    .chat-toolbar-icon-slot .oc-liquid-icon,")),
    )
    const finalSendRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .send {", chatHtmlSource.indexOf("    .send:hover")),
      chatHtmlSource.indexOf("    .send:hover"),
    )
    const statusBarRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .composerStatusBar {"),
      chatHtmlSource.indexOf("    .composerWrap.collapsed", chatHtmlSource.lastIndexOf("    .composerStatusBar {")),
    )
    const actionRowRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .composerActionRow {", pickerModelRuleStart),
      chatHtmlSource.indexOf("    .toggles {", chatHtmlSource.indexOf("    .composerActionRow {", pickerModelRuleStart)),
    )
    const compactRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    @media (max-width: 479px)", toolbarSendRuleStart),
      chatHtmlSource.indexOf("    @media (max-width: 300px)", toolbarSendRuleStart),
    )
    const badgeRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .oc-badge,"),
      chatHtmlSource.indexOf("    .statusBadgeText", chatHtmlSource.indexOf("    .oc-badge,")),
    )
    const sendRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .send {"),
      chatHtmlSource.indexOf("    .composerHint"),
    )
    const popupLayerRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .composerPopupLayer {"),
      chatHtmlSource.indexOf("    .modelMenu {"),
    )
    const menuRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .modelMenu {"),
      chatHtmlSource.indexOf("    .modelMenu.open"),
    )
    const composerMarkupStart = chatHtmlSource.indexOf('<div class="composer">')
    const composerMarkup = chatHtmlSource.slice(
      composerMarkupStart,
      chatHtmlSource.indexOf('<div class="composerActionRow toggles composerContextRail"', composerMarkupStart),
    )
    const actionRowMarkupStart = chatHtmlSource.indexOf('<div class="composerActionRow toggles composerContextRail"')
    const actionRowMarkup = chatHtmlSource.slice(
      actionRowMarkupStart,
      chatHtmlSource.indexOf('<div id="composerProgress"', actionRowMarkupStart),
    )
    const popupLayerMarkupStart = chatHtmlSource.indexOf('<div id="composerPopupLayer" class="composerPopupLayer">')
    const popupLayerMarkup = chatHtmlSource.slice(
      popupLayerMarkupStart,
      chatHtmlSource.indexOf('${mermaidScriptTag}', popupLayerMarkupStart),
    )

    expect(composerRule).toContain("overflow: visible;")
    expect(composerRule).toContain("display: grid;")
    expect(composerRule).toContain("grid-template-rows: auto auto;")
    expect(composerRule).not.toContain("overflow: hidden;")
    expect(chatHtmlSource).toContain("composerToolbar")
    expect(chatHtmlSource).toContain("composerHint")
    expect(chatHtmlSource.indexOf('class="composerSupportRail" aria-label="Composer status details"')).toBeGreaterThan(
      chatHtmlSource.indexOf('id="composerStatusBar"'),
    )
    expect(chatHtmlSource.indexOf('class="composerSupportRail" aria-label="Composer status details"')).toBeLessThan(
      chatHtmlSource.indexOf('id="composerStatusPopover"'),
    )
    expect(statusBarRule).toContain("position: static;")
    expect(statusBarRule).toContain("display: flex;")
    expect(statusBarRule).toContain("justify-content: flex-start;")
    expect(statusBarRule).not.toContain("position: absolute;")
    expect(statusBarRule).not.toContain("justify-content: space-between;")
    expect(toolbarRule).toContain("display: flex;")
    expect(toolbarRule).toContain("flex-wrap: nowrap;")
    expect(toolbarRule).toContain("align-items: center;")
    expect(toolbarRule).toContain("overflow: visible;")
    expect(toolbarRule).not.toContain("display: grid;")
    expect(toolbarRule).not.toContain("grid-template-columns")
    expect(toolbarRule).not.toContain("grid-template-areas")
    expect(toolbarRule).not.toContain("overflow-x: auto;")
    expect(toolbarRule).not.toContain("scrollbar-width: none;")
    expect(pickerRule).toContain("display: grid;")
    expect(pickerRule).toContain("grid-template-columns: 28px minmax(104px, 118px) minmax(148px, 172px) minmax(118px, 144px) minmax(84px, 96px);")
    expect(pickerRule).toContain("justify-content: start;")
    expect(pickerRule).toContain("align-items: center;")
    expect(pickerRule).toContain("min-width: 0;")
    expect(pickerRule).not.toContain("grid-area")
    expect(pickerModelRule).toContain("width: 100%;")
    expect(pickerModelRule).toContain("min-width: 0;")
    expect(pickerModelRule).toContain("max-width: none;")
    expect(pickerAgentRule).toContain("width: 100%;")
    expect(pickerAgentRule).toContain("min-width: 0;")
    expect(pickerAgentRule).toContain("max-width: none;")
    expect(warningChipRule).toContain("width: 100%;")
    expect(warningChipRule).toContain("min-width: 0;")
    expect(warningChipRule).toContain("max-width: none;")
    expect(chatHtmlSource).toContain("--composer-icon-button-size: 28px;")
    expect(chatHtmlSource).toContain("--composer-toolbar-icon-slot-size: 22px;")
    expect(chatHtmlSource).toContain("--composer-toolbar-glyph-size: 18px;")
    expect(chatHtmlSource).toContain("--composer-toolbar-status-glyph-size: 13px;")
    expect(chatHtmlSource).toContain("--composer-send-button-size: 34px;")
    expect(composerIconSizeRule).toContain("width: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("min-width: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("height: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("min-height: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain(".composerStatusPill.oc-chip {")
    expect(composerIconGlyphRule).toContain("width: var(--composer-toolbar-glyph-size);")
    expect(composerIconGlyphRule).toContain("height: var(--composer-toolbar-glyph-size);")
    expect(chatHtmlSource).toContain(".index-status-icon {")
    expect(chatHtmlSource).toContain(".index-status-icon .codicon")
    expect(toolbarSendRule).toContain("flex: 0 0 var(--composer-send-button-size);")
    expect(toolbarSendRule).toContain("margin-inline-start: auto;")
    expect(toolbarSendRule).not.toContain("margin-left: auto;")
    expect(actionRowRule).toContain("display: none;")
    expect(actionRowRule).toContain("align-items: center;")
    expect(actionRowRule).toContain("flex-wrap: wrap;")
    expect(actionRowRule).not.toContain("grid-area")
    expect(actionRowRule).not.toContain("justify-content: space-between;")
    expect(chatHtmlSource).toContain(".composerMoreItem {")
    expect(chatHtmlSource).toContain(".composerMoreBadge")
    expect(chatHtmlSource).toContain("function setComposerMoreToggleButton")
    expect(chatHtmlSource).toContain("function renderComposerMoreTrigger")
    expect(compactRule).not.toContain("display: grid;")
    expect(compactRule).not.toContain("grid-template-areas")
    expect(compactRule).not.toContain('"pickers"')
    expect(compactRule).not.toContain('"context"')
    expect(compactRule).not.toContain('"commands"')
    expect(compactRule).not.toContain("overflow-x: auto;")
    expect(compactRule).not.toContain("30px")
    expect(badgeRule).toContain("display: inline-flex;")
    expect(badgeRule).toContain("flex: 0 0 auto;")
    expect(badgeRule).not.toContain("position: absolute;")
    expect(badgeRule).not.toContain("top:")
    expect(badgeRule).not.toContain("right:")
    expect(chatHtmlSource).not.toContain(".oc-icon-btn.hasBadge")
    expect(chatHtmlSource).not.toContain('node.classList.toggle("hasBadge"')
    expect(chatHtmlSource).toContain('removeInlineBadge(node, "oc-liquid-badge")')
    expect(chatHtmlSource).toContain('removeInlineBadge(node, "statusBadge")')
    expect(chatHtmlSource).toContain('badge.dataset.badgeFor = node.id || "";')
    expect(chatHtmlSource).toContain("insertInlineBadge(node, badge);")
    expect(finalSendRule).toContain("color: var(--vscode-button-foreground);")
    expect(finalSendRule).toContain("background: var(--vscode-button-background);")
    expect(finalSendRule).toContain("width: var(--composer-send-button-size);")
    expect(finalSendRule).toContain("height: var(--composer-send-button-size);")
    expect(finalSendRule).toContain("border-radius: 8px;")
    expect(chatHtmlSource.indexOf('class="composerPickerRail"')).toBeLessThan(
      chatHtmlSource.indexOf('id="send"'),
    )
    expect(chatHtmlSource.indexOf('id="send"')).toBeLessThan(
      chatHtmlSource.indexOf('class="composerActionRow toggles composerContextRail"'),
    )
    expect(chatHtmlSource.indexOf('id="composerMoreMenu"')).toBeLessThan(chatHtmlSource.indexOf('id="exportMarkdown"'))
    expect(chatHtmlSource).not.toContain('class="composerCommandRail"')
    expect(triggerRule).toContain("height: 28px;")
    expect(triggerRule).toContain("min-height: 28px;")
    expect(triggerRule).toContain("padding: 0 8px;")
    expect(triggerRule).toContain("border-color: var(--oc-border);")
    expect(triggerRule).not.toContain("position: absolute;")
    expect(triggerRule).toContain("background: transparent;")
    expect(sendRule).not.toContain("position: absolute;")
    expect(sendRule).not.toContain(".send .oc-liquid-icon")
    expect(chatHtmlSource).toContain(".modelTrigger::after")
    expect(chatHtmlSource).toContain('aria-haspopup="listbox"')
    expect(chatHtmlSource).toContain('aria-expanded="false"')
    expect(chatHtmlSource).toContain('role="listbox"')
    expect(chatHtmlSource).toContain('trigger.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false")')
    expect(chatHtmlSource).toContain('root.setAttribute("aria-hidden", modelMenuOpen ? "false" : "true")')
    expect(chatHtmlSource).toContain('button.setAttribute("role", "option")')
    expect(chatHtmlSource).toContain('button.setAttribute("aria-selected", isActive ? "true" : "false")')
    expect(popupLayerRule).toContain("position: fixed;")
    expect(popupLayerRule).toContain("inset: 0;")
    expect(popupLayerRule).toContain("z-index: 10000;")
    expect(popupLayerRule).toContain("pointer-events: none;")
    expect(popupLayerRule).toContain("overflow: visible;")
    expect(menuRule).toContain("position: fixed;")
    expect(menuRule).toContain("z-index: 1000;")
    expect(menuRule).toContain("pointer-events: auto;")
    expect(menuRule).toContain("overflow-y: auto;")
    expect(menuRule).toContain("overscroll-behavior: contain;")
    expect(menuRule).toContain("scrollbar-gutter: stable;")
    expect(menuRule).not.toContain("right: 36px;")
    expect(menuRule).not.toContain("bottom: calc(100% + 6px);")
    expect(composerMarkup).not.toContain('id="modelMenu"')
    expect(composerMarkup).not.toContain('id="agentMenu"')
    expect(actionRowMarkup).not.toContain('id="composerMoreMenu"')
    expect(actionRowMarkup).toContain("hidden")
    expect(popupLayerMarkup).toContain('id="modelMenu" class="modelMenu" role="listbox" aria-label="Model" aria-hidden="true"')
    expect(popupLayerMarkup).toContain('id="agentMenu" class="modelMenu agentMenu" role="listbox" aria-label="Agent" aria-hidden="true"')
    expect(popupLayerMarkup).toContain('id="composerMoreMenu" class="modelMenu composerMoreMenu" role="menu" aria-label="More composer actions" aria-hidden="true"')
    expect(popupLayerMarkupStart).toBeGreaterThan(actionRowMarkupStart)
    expect(chatHtmlSource).toContain("function positionPopupMenu")
    expect(chatHtmlSource).toContain('positionPopupMenu("modelMenu", "modelTrigger", modelMenuOpen)')
    expect(chatHtmlSource).toContain('root.style.maxHeight = Math.floor(maxHeight) + "px";')
    expect(chatHtmlSource).toContain('root.style.bottom = Math.round(bottom) + "px";')
  })

  test("logs and sends selected model separately from agent", () => {
    expect(chatViewSource).toContain("private modelForSettings")
    expect(chatViewSource).toContain("[model] ${modelSelection.label}")
    expect(chatViewSource).toContain("model: modelSelection.model")
    expect(chatViewSource).toContain("agent: agentSelection.agent")
  })
})
