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

  test("activates after startup to surface update reload prompts", () => {
    expect(manifest.activationEvents).toContain("onStartupFinished")
  })

  test("keeps remote chat commands available", () => {
    const commands = new Set((manifest.contributes?.commands ?? []).map((command: { command: string }) => command.command))
    expect(commands.has("opencode.remote.openChat")).toBe(true)
    expect(commands.has("opencode.remote.connect")).toBe(true)
    expect(commands.has("opencode.remote.openOutput")).toBe(true)
    expect(commands.has("opencode.remote.completion.commitInlineSuggestion")).toBe(true)
    expect(manifest.activationEvents).toContain("onCommand:opencode.remote.completion.commitInlineSuggestion")
    expect(commands.has("opencode.remote.codeGraph.index")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.rebuild")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.pause")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.resume")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.cancel")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.benchmark")).toBe(true)
    expect(commands.has("opencode.remote.codeGraph.status")).toBe(true)
  })

  test("contributes mask-friendly view title command icons", () => {
    const commands = manifest.contributes?.commands ?? []
    const newSession = commands.find((command: { command: string }) => command.command === "opencode.remote.newSession")
    const testConnection = commands.find((command: { command: string }) => command.command === "opencode.remote.testConnection")

    expect(newSession?.icon).toEqual({
      light: "media/icons/light/new-session.svg",
      dark: "media/icons/dark/new-session.svg",
    })
    expect(testConnection?.icon).toEqual({
      light: "media/icons/light/sync.svg",
      dark: "media/icons/dark/sync.svg",
    })
    for (const icon of [
      "media/icons/light/new-session.svg",
      "media/icons/dark/new-session.svg",
      "media/icons/light/sync.svg",
      "media/icons/dark/sync.svg",
    ]) {
      expect(existsSync(join(import.meta.dir, "..", icon))).toBe(true)
    }
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

  test("contributes direct inline completion settings and API key command", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.completion.provider"]).toMatchObject({
      type: "string",
      enum: ["opencode", "openai-compatible"],
      default: "openai-compatible",
    })
    expect(properties["opencode.remote.completion.profile"]).toMatchObject({
      type: "string",
      enum: ["generic-chat", "qwen-coder-fim"],
      default: "generic-chat",
    })
    expect(properties["opencode.remote.completion.apiBaseUrl"]?.default).toBe("")
    expect(properties["opencode.remote.completion.model"]?.default).toBe("")
    expect(properties["opencode.remote.completion.maxTokens"]?.default).toBe(128)
    expect(properties["opencode.remote.completion.temperature"]?.default).toBe(0)
    expect(properties["opencode.remote.completion.topP"]?.default).toBe(1)
    expect(properties["opencode.remote.completion.debugFullRetrievalProbe"]?.default).toBe(false)
    expect(properties["opencode.remote.completion.debugExpectedSymbol"]?.default).toBe("")
    expect(properties["opencode.remote.completion.commentGuidedRetrievalMode"]).toMatchObject({
      type: "string",
      enum: ["qa-exact", "completion"],
      default: "qa-exact",
    })
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "opencode.remote.completion.setApiKey",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "opencode.remote.completion.runDirectAblation",
    }))
    expect(manifest.activationEvents).toContain("onCommand:opencode.remote.completion.runDirectAblation")
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
    expect(properties["opencode.remote.codeGraph.maxFiles"]?.maximum).toBe(1000000)
    expect(properties["opencode.remote.codeGraph.watcherRescanThreshold"]?.default).toBe(750)
    expect(properties["opencode.remote.codeGraph.workerConcurrency"]?.default).toBe(4)
    expect(properties["opencode.remote.codeGraph.queryCacheSize"]?.default).toBe(80)
    expect(properties["opencode.remote.codeGraph.memoryLimitMb"]?.default).toBe(4096)
    expect(properties["opencode.remote.codeGraph.compileCommandsPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.clangdPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.scipClangPath"]?.type).toBe("string")
    expect(properties["opencode.remote.codeGraph.excludeGlobs"]?.type).toBe("array")
  })

  test("contributes local analysis bridge and evidence budget settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.analysis.bridge.enabled"]?.default).toBe(true)
    expect(properties["opencode.remote.analysis.maxEvidenceItems"]?.default).toBe(40)
    expect(properties["opencode.remote.analysis.maxEvidenceBytes"]?.default).toBe(60000)
    expect(properties["opencode.remote.analysis.maxFileSliceBytes"]?.default).toBe(16000)
    expect(properties["opencode.remote.analysis.maxGraphEdges"]?.default).toBe(120)
    expect(properties["opencode.remote.analysis.maxPaths"]?.default).toBe(10)
  })

  test("contributes offline RAG embedding and rerank settings", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {}
    expect(properties["opencode.remote.rag.embedding.enabled"]).toBeUndefined()
    expect(properties["opencode.remote.rag.embedding.endpoint"]?.type).toBe("string")
    expect(properties["opencode.remote.rag.embedding.model"]?.type).toBe("string")
    expect(properties["opencode.remote.rag.embedding.batchSize"]?.default).toBe(128)
    expect(properties["opencode.remote.rag.embedding.batchSize"]?.enum).toEqual([1, 5, 10, 32, 64, 128, 256, 512])
    expect(properties["opencode.remote.rag.embedding.batchSize"]?.maximum).toBe(512)
    expect(properties["opencode.remote.rag.embedding.dimensions"]).toBeUndefined()
    expect(properties["opencode.remote.rag.embedding.maxTokensPerRequest"]?.default).toBe(65536)
    expect(properties["opencode.remote.rag.embedding.concurrentRequests"]?.default).toBe(3)
    expect(properties["opencode.remote.rag.embedding.concurrentRequests"]?.maximum).toBe(8)
    expect(properties["opencode.remote.rag.embedding.maxInFlightTokens"]?.default).toBe(360000)
    expect(properties["opencode.remote.rag.embedding.encodingFormat"]).toMatchObject({
      type: "string",
      enum: ["float", "base64", "auto"],
      default: "auto",
    })
    expect(properties["opencode.remote.rag.embedding.checkpointMode"]).toMatchObject({
      type: "string",
      enum: ["off", "interval", "safe"],
      default: "interval",
    })
    expect(properties["opencode.remote.rag.embedding.checkpointChunkInterval"]?.default).toBe(8192)
    expect(properties["opencode.remote.rag.embedding.checkpointIntervalMs"]?.default).toBe(120000)
    expect(properties["opencode.remote.rag.embedding.timeoutMs"]?.default).toBe(30000)
    expect(properties["opencode.remote.rag.embedding.timeoutMs"]?.deprecationMessage).toContain("managed automatically from batch size")
    expect(properties["opencode.remote.rag.embedding.requestDelayMs"]?.default).toBe(0)
    expect(properties["opencode.remote.rag.embedding.maxRequestsPerRun"]?.default).toBe(100)
    expect(properties["opencode.remote.rag.embedding.maxRetries"]?.default).toBe(3)
    expect(properties["opencode.remote.rag.embedding.retryBackoffMs"]?.default).toBe(2000)
    expect(properties["opencode.remote.rag.embedding.resumeAutomatically"]?.default).toBe(true)
    expect(properties["opencode.remote.rag.embedding.resumeDelayMs"]?.default).toBe(60000)
    expect(properties["opencode.remote.rag.rerank.enabled"]).toBeUndefined()
    expect(properties["opencode.remote.rag.rerank.endpoint"]?.type).toBe("string")
    expect(properties["opencode.remote.rag.rerank.model"]?.type).toBe("string")
    expect(properties["opencode.remote.rag.allowedHosts"]?.type).toBe("array")
    expect(properties["opencode.remote.rag.vectorTopK"]?.default).toBe(24)
    expect(properties["opencode.remote.rag.rerankTopK"]?.default).toBe(16)
  })

  test("contributes a dedicated OpenCode activity bar container", () => {
    const containers = manifest.contributes?.viewsContainers?.activitybar ?? []
    expect(manifest.icon).toBe("media/opencode-icon.png")
    expect(containers).toContainEqual({
      id: "opencodeRemote",
      title: "OpenCode",
      icon: "media/opencode.svg",
    })
    const iconPng = readFileSync(join(import.meta.dir, "..", "media", "opencode-icon.png"))
    expect(iconPng.readUInt32BE(16)).toBe(256)
    expect(iconPng.readUInt32BE(20)).toBe(256)
    expect(existsSync(join(import.meta.dir, "..", "media", "opencode-icon.png"))).toBe(true)
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
