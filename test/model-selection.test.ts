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
      chatHtmlSource.indexOf("    .modelTrigger {"),
      chatHtmlSource.indexOf("    .modelTrigger::after"),
    )
    const sendRule = chatHtmlSource.slice(
      chatHtmlSource.indexOf("    .send {"),
      chatHtmlSource.indexOf("    .send:hover"),
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
    expect(triggerRule).toContain("z-index: 2;")
    expect(triggerRule).toContain("position: relative;")
    expect(triggerRule).toContain("width: 100%;")
    expect(triggerRule).toContain("min-width: 0;")
    expect(triggerRule).not.toContain("position: absolute;")
    expect(triggerRule).toContain("border: 1px solid")
    expect(triggerRule).toContain("background: var(--vscode-dropdown-background")
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
    expect(chatHtmlSource).toContain("function positionModelMenu()")
    expect(chatHtmlSource).toContain("positionModelMenu();")
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
