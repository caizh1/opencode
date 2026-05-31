import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("extension manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
  const newViewID = "opencodeRemote.sidebar"
  const oldViewID = ["opencodeRemote", "chat"].join(".")

  test("does not contribute editor title buttons", () => {
    expect(manifest.contributes?.menus?.["editor/title"]).toBeUndefined()
  })

  test("keeps local terminal commands available", () => {
    const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))
    expect(commands.has("opencode.openTerminal")).toBe(true)
    expect(commands.has("opencode.openNewTerminal")).toBe(true)
  })

  test("runs as a workspace extension for local and remote workspace files", () => {
    expect(manifest.extensionKind).toEqual(["workspace"])
  })

  test("keeps remote chat commands available", () => {
    const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))
    expect(commands.has("opencode.remote.openChat")).toBe(true)
    expect(commands.has("opencode.remote.connect")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.index")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.rebuild")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.status")).toBe(true)
  })

  test("contributes local-only guard settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.context.localOnlyMode"]?.default).toBe(true)
    expect(properties["opencode.remote.context.strictLocalOnlyAgent"]?.default).toBe(true)
    expect(properties["opencode.remote.localOnlyAgent"]?.default).toBe("vscode-local")
  })

  test("contributes completion log level setting", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.completion.logLevel"]).toMatchObject({
      type: "string",
      enum: ["off", "info", "debug"],
      default: "info",
    })
  })

  test("contributes local code graph settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.codeGraph.enabled"]?.default).toBe(true)
    expect(properties["opencode.remote.codeGraph.promptOnWorkspaceOpen"]?.default).toBe(true)
    expect(properties["opencode.remote.codeGraph.analysisMode"]).toMatchObject({
      type: "string",
      enum: ["auto", "fast", "ast", "semantic"],
      default: "auto",
    })
    expect(properties["opencode.remote.codeGraph.maxFiles"]?.default).toBe(50000)
    expect(properties["opencode.remote.codeGraph.maxContextBytes"]?.default).toBe(24000)
    expect(properties["opencode.remote.codeGraph.maxEvidenceBytes"]?.default).toBe(60000)
    expect(properties["opencode.remote.codeGraph.maxGraphDepth"]?.default).toBe(2)
    expect(properties["opencode.remote.codeGraph.maxFanout"]?.default).toBe(40)
    expect(properties["opencode.remote.codeGraph.maxDeepFiles"]?.default).toBe(24)
    expect(properties["opencode.remote.codeGraph.maxStateTransitions"]?.default).toBe(120)
    expect(properties["opencode.remote.codeGraph.compileCommandsPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.clangdPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.scipClangPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.excludeGlobs"]?.type).toBe("array")
  })

  test("contributes a dedicated OpenCode activity bar container", () => {
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? []
    expect(containers).toContainEqual({
      id: "opencodeRemote",
      title: "OpenCode",
      icon: "media/opencode.svg",
    })
    expect(existsSync(join(import.meta.dir, "..", "media", "opencode.svg"))).toBe(true)
  })

  test("places the chat webview in the OpenCode container instead of Explorer", () => {
    const explorerViews = manifest.contributes?.views?.explorer ?? []
    const opencodeViews = manifest.contributes?.views?.opencodeRemote ?? []

    expect(manifest.activationEvents).toContain(`onView:${newViewID}`)
    expect(JSON.stringify(manifest)).not.toContain(oldViewID)
    expect(explorerViews.some((view: { id: string }) => view.id === newViewID)).toBe(false)
    expect(opencodeViews).toContainEqual({
      id: newViewID,
      name: "Chat",
      type: "webview",
    })
  })
})
