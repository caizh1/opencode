import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("extension manifest", () => {
  const manifestText = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
  const manifest = JSON.parse(manifestText)
  const viewID = "chipmate.sidebar"

  test("uses the ChipMate extension identity and workspace host runtime", () => {
    expect(manifest.name).toBe("chipmate")
    expect(manifest.displayName).toBe("ChipMate")
    expect(manifest.icon).toBe("media/chipmate-icon.png")
    expect(existsSync(join(import.meta.dir, "..", "media", "chipmate-icon.png"))).toBe(true)
    expect(readFileSync(join(import.meta.dir, "..", "media", "chipmate-icon.png")).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(manifest.extensionKind).toEqual(["workspace"])
    expect(manifest.activationEvents).toContain("onStartupFinished")
    expect(manifestText).not.toMatch(/opencode|OpenCode|opencodeRemote/)
  })

  test("does not contribute editor title buttons or legacy terminal commands", () => {
    expect(manifest.contributes?.menus?.["editor/title"]).toBeUndefined()
    const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))
    expect(commands.has("opencode.openTerminal")).toBe(false)
    expect(commands.has("opencode.openNewTerminal")).toBe(false)
    expect(commands.has("chipmate.openChat")).toBe(true)
    expect(commands.has("chipmate.newSession")).toBe(true)
    expect(commands.has("chipmate.openOutput")).toBe(true)
  })

  test("contributes ChipMate chat, completion, RAG, and code graph commands", () => {
    const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))
    for (const command of [
      "chipmate.askSelection",
      "chipmate.askCurrentFile",
      "chipmate.addFileToContext",
      "chipmate.clearContext",
      "chipmate.completion.setApiKey",
      "chipmate.completion.runDirectAblation",
      "chipmate.completion.commitInlineSuggestion",
      "chipmate.rag.setApiKey",
      "chipmate.codeGraph.index",
      "chipmate.codeGraph.rebuild",
      "chipmate.codeGraph.pause",
      "chipmate.codeGraph.resume",
      "chipmate.codeGraph.cancel",
      "chipmate.codeGraph.benchmark",
      "chipmate.codeGraph.status",
    ]) {
      expect(commands.has(command), command).toBe(true)
      expect(manifest.activationEvents).toContain(`onCommand:${command}`)
    }
  })

  test("contributes direct model, permission, and offline catalog settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["chipmate.chat.apiBaseUrl"]?.default).toBe("")
    expect(properties["chipmate.chat.model"]?.default).toBe("")
    expect(properties["chipmate.chat.streaming"]?.default).toBe(true)
    expect(properties["chipmate.skills.catalogUrl"]?.default).toBe("")
    expect(properties["chipmate.permissions.profile"]).toMatchObject({
      type: "string",
      enum: ["readOnly", "askApproval", "trustedWorkspace", "fullAccess"],
      default: "askApproval",
    })
  })

  test("keeps local QA context and direct inline completion settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["chipmate.context.localOnlyMode"]?.default).toBe(true)
    expect(properties["chipmate.context.strictLocalOnlyAgent"]?.default).toBe(true)
    expect(properties["chipmate.completion.provider"]).toMatchObject({
      type: "string",
      enum: ["openai-compatible"],
      default: "openai-compatible",
    })
    expect(properties["chipmate.completion.profile"]).toMatchObject({
      type: "string",
      enum: ["generic-chat", "qwen-coder-fim"],
      default: "generic-chat",
    })
    expect(properties["chipmate.completion.apiBaseUrl"]?.default).toBe("")
    expect(properties["chipmate.completion.model"]?.default).toBe("")
    expect(properties["chipmate.completion.maxTokens"]?.default).toBe(128)
    expect(properties["chipmate.completion.temperature"]?.default).toBe(0)
    expect(properties["chipmate.completion.topP"]?.default).toBe(1)
    expect(properties["chipmate.completion.logLevel"]).toMatchObject({
      type: "string",
      enum: ["off", "info", "debug"],
      default: "info",
    })
    expect(properties["chipmate.completion.commentGuidedRetrievalMode"]).toMatchObject({
      type: "string",
      enum: ["qa-exact", "completion"],
      default: "qa-exact",
    })
  })

  test("contributes local code graph and RAG settings under the ChipMate namespace", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["chipmate.codeGraph.enabled"]?.default).toBe(true)
    expect(properties["chipmate.codeGraph.analysisMode"]).toMatchObject({
      type: "string",
      enum: ["auto", "fast", "ast", "semantic"],
      default: "auto",
    })
    expect(properties["chipmate.codeGraph.maxFiles"]?.default).toBe(50000)
    expect(properties["chipmate.codeGraph.maxContextBytes"]?.default).toBe(24000)
    expect(properties["chipmate.codeGraph.maxEvidenceBytes"]?.default).toBe(60000)
    expect(properties["chipmate.codeGraph.excludeGlobs"]?.type).toBe("array")
    expect(properties["chipmate.rag.embedding.endpoint"]?.type).toBe("string")
    expect(properties["chipmate.rag.embedding.model"]?.type).toBe("string")
    expect(properties["chipmate.rag.embedding.batchSize"]?.enum).toEqual([1, 5, 10, 32, 64, 128, 256, 512])
    expect(properties["chipmate.rag.embedding.maxTokensPerRequest"]?.default).toBe(65536)
    expect(properties["chipmate.rag.rerank.endpoint"]?.type).toBe("string")
    expect(properties["chipmate.rag.allowedHosts"]?.type).toBe("array")
  })

  test("places the webview in a dedicated ChipMate activity bar container", () => {
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? []
    const chipmateViews = manifest.contributes?.views?.chipmate ?? []
    const explorerViews = manifest.contributes?.views?.explorer ?? []

    expect(containers).toContainEqual({
      id: "chipmate",
      title: "ChipMate",
      icon: "media/chipmate.svg",
    })
    expect(existsSync(join(import.meta.dir, "..", "media", "chipmate.svg"))).toBe(true)
    expect(manifest.activationEvents).toContain(`onView:${viewID}`)
    expect(explorerViews.some((view: { id: string }) => view.id === viewID)).toBe(false)
    expect(chipmateViews).toContainEqual({
      id: viewID,
      name: "ChipMate",
      type: "webview",
    })
  })
})
