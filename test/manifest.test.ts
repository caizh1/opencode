import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("extension manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
  const properties = manifest.contributes?.configuration?.properties ?? {}
  const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))

  test("uses the ChipMate extension identity", () => {
    expect(manifest.name).toBe("chipmate")
    expect(manifest.displayName).toBe("ChipMate")
    expect(manifest.publisher).toBe("local")
    expect(manifest.icon).toBe("media/chipmate-icon.png")
    expect(JSON.stringify(manifest)).not.toContain("opencode.remote")
    expect(JSON.stringify(manifest)).not.toContain("opencodeRemote")
    expect(JSON.stringify(manifest)).not.toContain("opencode.openTerminal")
  })

  test("runs as a workspace extension for local and Remote SSH workspace hosts", () => {
    expect(manifest.extensionKind).toEqual(["workspace"])
    expect(manifest.activationEvents).toContain("onStartupFinished")
    expect(manifest.activationEvents).toContain("onView:chipmate.sidebar")
  })

  test("contributes ChipMate commands without legacy terminal or ChipMate server commands", () => {
    for (const command of [
      "chipmate.openChat",
      "chipmate.newSession",
      "chipmate.askSelection",
      "chipmate.askCurrentFile",
      "chipmate.addFileToContext",
      "chipmate.clearContext",
      "chipmate.openOutput",
      "chipmate.provider.setApiKey",
      "chipmate.completion.runDirectAblation",
      "chipmate.completion.commitInlineSuggestion",
      "chipmate.codeGraph.index",
      "chipmate.codeGraph.rebuild",
      "chipmate.codeGraph.pause",
      "chipmate.codeGraph.resume",
      "chipmate.codeGraph.cancel",
      "chipmate.codeGraph.benchmark",
      "chipmate.codeGraph.status",
    ]) {
      expect(commands.has(command)).toBe(true)
      expect(manifest.activationEvents).toContain(`onCommand:${command}`)
    }
    expect(commands.has("opencode.openTerminal")).toBe(false)
    expect(commands.has("opencode.remote.connect")).toBe(false)
    expect(commands.has("opencode.remote.testConnection")).toBe(false)
  })

  test("contributes provider, skills, permissions, MCP, completion, RAG, and code graph settings", () => {
    expect(properties["chipmate.provider.apiBaseUrl"]?.type).toBe("string")
    expect(properties["chipmate.provider.chatModel"]?.type).toBe("string")
    expect(properties["chipmate.permissions.mode"]).toMatchObject({
      type: "string",
      enum: ["ask", "auto", "full-access"],
      default: "ask",
    })
    expect(properties["chipmate.skills.enabled"]).toMatchObject({
      type: "array",
      default: [],
    })
    expect(properties["chipmate.mcp.enabled"]?.default).toBe(false)
    expect(properties["chipmate.completion.profile"]).toMatchObject({
      type: "string",
      enum: ["generic-chat", "qwen-coder-fim"],
      default: "qwen-coder-fim",
    })
    expect(properties["chipmate.completion.provider"]).toBeUndefined()
    expect(properties["chipmate.completion.apiBaseUrl"]).toBeUndefined()
    expect(properties["chipmate.completion.model"]?.default).toBe("")
    expect(properties["chipmate.completion.logLevel"]?.enum).toEqual(["off", "info", "debug"])
    expect(properties["chipmate.codeGraph.enabled"]?.default).toBe(true)
    expect(properties["chipmate.codeGraph.analysisMode"]?.enum).toEqual(["auto", "fast", "ast", "semantic"])
    expect(properties["chipmate.analysis.bridge.enabled"]).toBeUndefined()
    expect(properties["chipmate.analysis.maxEvidenceItems"]?.default).toBe(40)
    expect(properties["chipmate.rag.embedding.endpoint"]?.type).toBe("string")
    expect(properties["chipmate.rag.embedding.batchSize"]?.enum).toEqual([1, 5, 10, 32, 64, 128, 256, 512])
    expect(properties["chipmate.rag.allowedHosts"]?.type).toBe("array")
  })

  test("contributes the ChipMate activity bar container and chip-related assets", () => {
    expect(manifest.contributes?.viewsContainers?.activitybar).toContainEqual({
      id: "chipmate",
      title: "ChipMate",
      icon: "media/chipmate.svg",
    })
    expect(manifest.contributes?.views?.chipmate).toContainEqual({
      id: "chipmate.sidebar",
      name: "Chat",
      type: "webview",
    })
    const iconPng = readFileSync(join(import.meta.dir, "..", "media", "chipmate-icon.png"))
    expect(iconPng.readUInt32BE(16)).toBe(256)
    expect(iconPng.readUInt32BE(20)).toBe(256)
    for (const icon of [
      "media/chipmate-icon.png",
      "media/chipmate.svg",
      "media/icons/light/new-session.svg",
      "media/icons/dark/new-session.svg",
      "media/icons/light/sync.svg",
      "media/icons/dark/sync.svg",
    ]) {
      expect(existsSync(join(import.meta.dir, "..", icon))).toBe(true)
    }
  })
})
