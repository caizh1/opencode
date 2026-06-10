import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("ChipMate model configuration flow", () => {
  const chatViewSource = readFileSync(join(import.meta.dir, "..", "src", "chipmate-chat-view.ts"), "utf8")
  const htmlSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-html.ts"), "utf8")
  const scriptSource = readFileSync(join(import.meta.dir, "..", "src", "webview", "chipmate-script.ts"), "utf8")
  const settingsSource = readFileSync(join(import.meta.dir, "..", "src", "settings.ts"), "utf8")

  test("uses direct OpenAI-compatible chat settings instead of remote provider discovery", () => {
    expect(chatViewSource).toContain("new OpenAIChatClient")
    expect(chatViewSource).toContain("settings.chat.apiBaseUrl")
    expect(chatViewSource).toContain("settings.chat.model")
    expect(chatViewSource).not.toContain("listConfigProviders")
    expect(chatViewSource).not.toContain("selectModel")
  })

  test("renders editable model and catalog settings in the ChipMate webview", () => {
    expect(scriptSource).toContain('fieldInput("apiBaseUrl"')
    expect(scriptSource).toContain('fieldInput("model"')
    expect(scriptSource).toContain('fieldInput("catalogUrl"')
    expect(scriptSource).toContain('fieldSelect("globalPermissionProfile"')
    expect(scriptSource).toContain('type: "saveModelSettings"')
    expect(scriptSource).toContain('type: "saveGlobalSettings"')
    expect(htmlSource).toContain('id="modelPill"')
    expect(chatViewSource).toContain('config.update("chat.apiBaseUrl"')
    expect(chatViewSource).toContain('config.update("chat.model"')
    expect(chatViewSource).toContain('config.update("skills.catalogUrl"')
  })

  test("keeps completion model settings direct and allows fallback to chat model settings", () => {
    expect(settingsSource).toContain('config.get<string>("completion.apiBaseUrl"')
    expect(settingsSource).toContain('config.get<string>("chat.apiBaseUrl"')
    expect(settingsSource).toContain('config.get<string>("completion.model"')
    expect(settingsSource).toContain('config.get<string>("chat.model"')
    expect(settingsSource).toContain('readCompletionProvider(config.get<string>("completion.provider", "openai-compatible"))')
    expect(settingsSource).toContain('function readCompletionProvider')
  })
})
