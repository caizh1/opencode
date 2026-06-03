import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("model selection flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chat-view.ts"), "utf8")
  const chatHtmlSource = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
  const remoteClientSource = readFileSync(join(import.meta.dir, "..", "src", "remote-client.ts"), "utf8")

  test("loads models through config providers with provider fallback", () => {
    expect(remoteClientSource).toContain("listConfigProviders")
    expect(remoteClientSource).toContain('"/config/providers"')
    expect(remoteClientSource).toContain("listProviders")
    expect(remoteClientSource).toContain('"/provider"')
    expect(remoteClientSource).toContain("normalizeModels")
  })

  test("posts model state to the webview and persists selection", () => {
    expect(chatViewSource).toContain('{ type: "selectModel"; model: string }')
    expect(chatViewSource).toContain("private async selectModel")
    expect(chatViewSource).toContain('config.update("defaultModel"')
    expect(chatViewSource).toContain("selectedModel: settings.defaultModel")
    expect(chatViewSource).toContain("models: this.models")
  })

  test("renders model selector and manual fallback", () => {
    expect(chatHtmlSource).toContain('id="modelSelect"')
    expect(chatHtmlSource).toContain('id="modelTrigger"')
    expect(chatHtmlSource).toContain('id="modelMenu"')
    expect(chatHtmlSource).toContain('id="refreshModels"')
    expect(chatHtmlSource).toContain('class="composerActionRow"')
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
    expect(chatHtmlSource).toContain("Use server default")
    expect(chatHtmlSource).toContain("Manual...")
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
    const toolbarModelRuleStart = chatHtmlSource.indexOf("    .composerToolbar .modelTrigger {")
    const toolbarRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .composerToolbar {", toolbarModelRuleStart),
      toolbarModelRuleStart,
    )
    const toolbarModelRule = chatHtmlSource.slice(
      toolbarModelRuleStart,
      chatHtmlSource.indexOf("    .composerToolbar .agentTrigger"),
    )
    const toolbarSendRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .composerToolbar .send {"),
      chatHtmlSource.indexOf("    .composerToolbar .oc-liquid-chip-label"),
    )
    const actionRowRule = chatHtmlSource.slice(
      chatHtmlSource.lastIndexOf("    .composerActionRow {"),
      chatHtmlSource.indexOf("    .toggles {", chatHtmlSource.lastIndexOf("    .composerActionRow {")),
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
    expect(toolbarRule).toContain("display: flex;")
    expect(toolbarRule).toContain("align-items: center;")
    expect(toolbarRule).not.toContain("grid-template-columns")
    expect(toolbarModelRule).toContain("flex: 0 1 160px;")
    expect(toolbarModelRule).toContain("max-width: min(180px, 42%);")
    expect(toolbarSendRule).toContain("flex: 0 0 26px;")
    expect(toolbarSendRule).toContain("margin-left: auto;")
    expect(actionRowRule).toContain("justify-content: flex-start;")
    expect(actionRowRule).not.toContain("justify-content: space-between;")
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
