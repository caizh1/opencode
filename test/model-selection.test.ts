import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("model selection flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
  const directClientSource = readFileSync(join(import.meta.dir, "..", "src", "direct-agent-client.ts"), "utf8")

  test("loads models through OpenAI-compatible /models with configured fallback names", () => {
    expect(directClientSource).toContain("async listModels")
    expect(directClientSource).toContain("modelsUrl(settings.provider.apiBaseUrl)")
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
    expect(chatHtmlSource).toContain("${liquidIcons.toolDisabled}")
    expect(chatHtmlSource).not.toContain("${liquidIcons.stop}</span></button>")
    expect(chatHtmlSource).toContain('id="composerMore"')
    expect(chatHtmlSource).toContain('id="composerMoreMenu" class="modelMenu composerMoreMenu"')
    expect(chatHtmlSource).not.toContain('class="composerCommandRail"')
    expect(chatHtmlSource).toContain('class="composerSupportRail" aria-label="Composer status details"')
    expect(chatHtmlSource).toContain('class="composerIconButton oc-icon-btn oc-liquid-btn" type="button" title="Refresh models"')
    expect(chatHtmlSource).toContain('id="diffToggle" class="oc-icon-toggle oc-liquid-toggle"')
    expect(chatHtmlSource).toContain('aria-label="Include git diff" aria-pressed="false"')
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

  test("renders completion model selection from provider-returned Qwen Coder models only", () => {
    expect(chatHtmlSource).toContain('<label class="field">Model<select id="completionModel"></select></label>')
    expect(chatHtmlSource).toContain('id="refreshCompletionModels"')
    expect(chatHtmlSource).toContain('type: "refreshModels"')
    expect(chatHtmlSource).toContain("function qwenCoderCompletionModels()")
    expect(chatHtmlSource).toContain('model.source !== "provider"')
    expect(chatHtmlSource).toContain('!text.includes("qwen") || !text.includes("coder")')
    expect(chatHtmlSource).toContain(".sort((left, right) => (left.providerIndex ?? 1e9) - (right.providerIndex ?? 1e9))")
    expect(chatHtmlSource).toContain("completionModelId(candidates[0])")
    expect(chatHtmlSource).toContain("No Qwen Coder completion model")
    expect(chatHtmlSource).toContain("无可用补全模型，补全暂不可用")
    expect(chatHtmlSource).toContain("el(\"saveCompletionSettings\").disabled = unavailable")
    expect(chatHtmlSource).toContain("el(\"testCompletionApi\").disabled = !direct || unavailable")
  })

  test("derives Complete status from inline completion config and Qwen Coder candidates only", () => {
    const statusStart = chatHtmlSource.indexOf("function completionStatusInfo()")
    const statusEnd = chatHtmlSource.indexOf("function completionStatusModel", statusStart)
    const statusBody = chatHtmlSource.slice(statusStart, statusEnd)

    expect(chatHtmlSource).toContain("function composerCompletionStatus()")
    expect(chatHtmlSource).toContain("function completionStatusInfo()")
    expect(chatHtmlSource).toContain("function renderSettingsHomeStatuses()")
    expect(chatHtmlSource).toContain("function renderCompletionStatusPopover")
    expect(statusBody).toContain("const completion = state.completion || {}")
    expect(statusBody).toContain('const provider = completion.provider || "qwen-direct"')
    expect(statusBody).toContain("const candidates = qwenCoderCompletionModels()")
    expect(statusBody).toContain('if (!enabled || provider === "none")')
    expect(statusBody).toContain('if (provider !== "qwen-direct")')
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
    expect(chatHtmlSource).toContain("Autocomplete unavailable · no Qwen Coder completion model was returned by the provider")
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
      chatHtmlSource.lastIndexOf("    .composerStatusToggle,", pickerModelRuleStart),
      chatHtmlSource.indexOf("    .composerStatusToggle {", chatHtmlSource.lastIndexOf("    .composerStatusToggle,", pickerModelRuleStart)),
    )
    const composerIconGlyphRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .composerStatusPill .oc-liquid-icon,", pickerModelRuleStart),
      chatHtmlSource.indexOf("    .composerStatusPill:hover", chatHtmlSource.lastIndexOf("    .composerStatusPill .oc-liquid-icon,", pickerModelRuleStart)),
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
    const menuRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .modelMenu {"),
      chatHtmlSource.indexOf("    .modelMenu.open"),
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
    expect(pickerRule).toContain("display: inline-flex;")
    expect(pickerRule).toContain("align-items: center;")
    expect(pickerRule).toContain("flex-wrap: wrap;")
    expect(pickerRule).toContain("min-width: 0;")
    expect(pickerRule).not.toContain("grid-area")
    expect(pickerModelRule).toContain("flex: 1 1 132px;")
    expect(pickerModelRule).toContain("min-width: 84px;")
    expect(pickerModelRule).toContain("max-width: 180px;")
    expect(pickerAgentRule).toContain("flex: 1 1 112px;")
    expect(pickerAgentRule).toContain("min-width: 76px;")
    expect(pickerAgentRule).toContain("max-width: 150px;")
    expect(warningChipRule).toContain("flex: 0 0 102px;")
    expect(warningChipRule).toContain("width: 102px;")
    expect(warningChipRule).toContain("min-width: 92px;")
    expect(warningChipRule).toContain("max-width: 110px;")
    expect(chatHtmlSource).toContain("--composer-icon-button-size: 24px;")
    expect(chatHtmlSource).toContain("--composer-send-button-size: 34px;")
    expect(composerIconSizeRule).toContain("width: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("min-width: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("height: var(--composer-icon-button-size);")
    expect(composerIconSizeRule).toContain("min-height: var(--composer-icon-button-size);")
    expect(composerIconGlyphRule).toContain("width: 16px;")
    expect(composerIconGlyphRule).toContain("height: 16px;")
    expect(toolbarSendRule).toContain("flex: 0 0 var(--composer-send-button-size);")
    expect(toolbarSendRule).toContain("margin-inline-start: auto;")
    expect(toolbarSendRule).not.toContain("margin-left: auto;")
    expect(actionRowRule).toContain("display: flex;")
    expect(actionRowRule).toContain("align-items: center;")
    expect(actionRowRule).toContain("flex-wrap: wrap;")
    expect(actionRowRule).not.toContain("grid-area")
    expect(actionRowRule).not.toContain("justify-content: space-between;")
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
    expect(chatHtmlSource).toContain(".modelTrigger::after")
    expect(chatHtmlSource).toContain('aria-haspopup="listbox"')
    expect(chatHtmlSource).toContain('aria-expanded="false"')
    expect(chatHtmlSource).toContain('role="listbox"')
    expect(chatHtmlSource).toContain('trigger.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false")')
    expect(chatHtmlSource).toContain('root.setAttribute("aria-hidden", modelMenuOpen ? "false" : "true")')
    expect(chatHtmlSource).toContain('button.setAttribute("role", "option")')
    expect(chatHtmlSource).toContain('button.setAttribute("aria-selected", isActive ? "true" : "false")')
    expect(menuRule).toContain("position: fixed;")
    expect(menuRule).toContain("z-index: 1000;")
    expect(menuRule).toContain("overflow-y: auto;")
    expect(menuRule).toContain("overscroll-behavior: contain;")
    expect(menuRule).toContain("scrollbar-gutter: stable;")
    expect(menuRule).not.toContain("right: 36px;")
    expect(menuRule).not.toContain("bottom: calc(100% + 6px);")
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
