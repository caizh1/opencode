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
    expect(JSON.stringify(manifest)).not.toContain("kilo.autocomplete")
  })

  test("supports VS Code 1.93 and later 1.x releases", () => {
    expect(manifest.engines?.vscode).toBe("^1.93.0")
    expect(manifest.devDependencies?.["@types/vscode"]).toBe("1.93.0")
  })

  test("packages qwen autocomplete runtime dependencies in the VSIX", () => {
    for (const dependency of ["diff", "fastest-levenshtein", "ignore", "js-tiktoken", "web-tree-sitter"]) {
      expect(typeof manifest.dependencies?.[dependency]).toBe("string")
      expect(manifest.devDependencies?.[dependency]).toBeUndefined()
    }
    expect(manifest.version).toMatch(/^0\.1\.0-build\.\d+$/)
    expect(manifest.scripts?.vsix).toBe("bun scripts/package-vsix.ts")
    expect(manifest.scripts?.["verify:qwen-vsix"]).toBe("bun scripts/verify-qwen-vsix.ts")
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")
    expect(vscodeIgnore).not.toMatch(/^node_modules\/\*\*$/m)
  })

  test("packages ELKJS as the offline draw.io layout engine", () => {
    const elkPackage = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules", "elkjs", "package.json"), "utf8"))
    const elkLicense = readFileSync(join(import.meta.dir, "..", "node_modules", "elkjs", "LICENSE.md"), "utf8")
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(typeof manifest.dependencies?.elkjs).toBe("string")
    expect(manifest.devDependencies?.elkjs).toBeUndefined()
    expect(elkPackage.license).toBe("EPL-2.0")
    expect(elkLicense).toContain("Eclipse Public License")
    expect(vscodeIgnore).not.toMatch(/^node_modules\/elkjs\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/elkjs\/lib\/elk-worker\.js$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/elkjs\/lib\/elk-worker\.min\.js$/m)
  })

  test("keeps PDF canvas rendering runtime while trimming non-runtime package files", () => {
    const canvasPackage = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules", "canvas", "package.json"), "utf8"))
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(typeof manifest.dependencies?.["pdfjs-dist"]).toBe("string")
    expect(canvasPackage.name).toBe("canvas")
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "canvas", "build", "Release", "canvas.node"))).toBe(true)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/canvas\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/canvas\/package\.json$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/canvas\/index\.js$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/canvas\/lib\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/canvas\/build\/Release\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/canvas\/src\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/canvas\/node_modules\/node-addon-api\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/canvas\/binding\.gyp$/m)
  })

  test("vendors the offline draw.io runtime for chat rendering", () => {
    const vendorRoot = join(import.meta.dir, "..", "media", "vendor", "drawio")
    const drawioManifest = JSON.parse(readFileSync(join(vendorRoot, "manifest.json"), "utf8"))
    const license = readFileSync(join(vendorRoot, "LICENSE"), "utf8")
    const adapter = readFileSync(join(vendorRoot, "adapter.html"), "utf8")
    const chatHtml = readFileSync(join(import.meta.dir, "..", "src", "chat-html.ts"), "utf8")
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(existsSync(join(vendorRoot, "viewer-static.min.js"))).toBe(true)
    expect(existsSync(join(vendorRoot, "adapter.html"))).toBe(true)
    expect(drawioManifest).toMatchObject({
      source: "https://github.com/jgraph/drawio",
      commit: "7976c02e1b10b1687c028d82782f9f5d90a885d6",
      license: "Apache-2.0",
    })
    expect(drawioManifest.files).toContain("viewer-static.min.js")
    expect(drawioManifest.files).toContain("adapter.html")
    expect(license).toContain("Apache License")
    expect(adapter).toContain("connect-src 'none'")
    expect(adapter).toContain("viewer-static.min.js")
    expect(adapter).toContain("chipmate-drawio-runtime")
    expect(adapter).toContain("canvas.foEnabled = false")
    expect(adapter).toContain("format === \"png\" || format === \"xmlpng\"")
    expect(chatHtml).toContain("frame-src ${cspSource}")
    expect(chatHtml).toContain("connect-src 'none'")
    expect(chatHtml).not.toContain("embed.diagrams.net")
    expect(chatHtml).not.toContain("viewer.diagrams.net")
    expect(vscodeIgnore).not.toMatch(/^media\/vendor\/drawio/m)
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
      "chipmate.addSelectionToContext",
      "chipmate.addFileToContext",
      "chipmate.clearContext",
      "chipmate.openOutput",
      "chipmate.agentTerminal.open",
      "chipmate.provider.setApiKey",
      "chipmate.qwenAutocomplete.regenerate",
      "chipmate.qwenAutocomplete.showLogs",
      "chipmate.qwenAutocomplete.exportDiagnostics",
      "chipmate.codeGraph.index",
      "chipmate.codeGraph.rebuild",
      "chipmate.codeGraph.pause",
      "chipmate.codeGraph.resume",
      "chipmate.codeGraph.cancel",
      "chipmate.codeGraph.benchmark",
      "chipmate.codeGraph.status",
      "chipmate.comments.generateForSelection",
      "chipmate.comments.generateForCurrentFunction",
      "chipmate.comments.accept",
      "chipmate.comments.acceptAll",
      "chipmate.comments.reject",
      "chipmate.comments.clear",
    ]) {
      expect(commands.has(command)).toBe(true)
      expect(manifest.activationEvents).toContain(`onCommand:${command}`)
    }
    expect(commands.has("opencode.openTerminal")).toBe(false)
    expect(commands.has("opencode.remote.connect")).toBe(false)
    expect(commands.has("opencode.remote.testConnection")).toBe(false)
    expect(commands.has("chipmate.completion.runDirectAblation")).toBe(false)
    expect(commands.has("chipmate.completion.commitInlineSuggestion")).toBe(false)
    expect(commands.has("chipmate.comments.regenerateForSelection")).toBe(false)
    expect(manifest.activationEvents).not.toContain("onCommand:chipmate.comments.regenerateForSelection")
  })

  test("contributes the ChipMate Agent Terminal profile", () => {
    expect(manifest.activationEvents).toContain("onTerminalProfile:chipmate.agentTerminal")
    expect(manifest.contributes?.terminal?.profiles).toContainEqual(expect.objectContaining({
      id: "chipmate.agentTerminal",
      title: "ChipMate Agent Terminal",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.agentTerminal.open",
      title: "Open ChipMate Agent Terminal",
    }))
    const wrapperSource = readFileSync(join(import.meta.dir, "..", "src", "agent-terminal-vscode.ts"), "utf8")
    expect(wrapperSource).not.toContain("showWarningMessage")
    expect(wrapperSource).toContain("vscode.window.terminals.find")
    expect(wrapperSource).toContain("terminal.name === TERMINAL_NAME")
    expect(wrapperSource).toContain("focused existing ChipMate Agent Terminal")
    expect(wrapperSource).toContain("created ChipMate Agent Terminal")
  })

  test("contributes cross-platform regenerate keybindings for qwen inline completion", () => {
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.qwenAutocomplete.regenerate",
      title: "Regenerate ChipMate Inline Completion",
    }))
    expect(manifest.contributes?.keybindings).toContainEqual(expect.objectContaining({
      command: "chipmate.qwenAutocomplete.regenerate",
      key: "cmd+alt+]",
      when: "editorTextFocus && !editorReadonly && isMac",
    }))
    expect(manifest.contributes?.keybindings).toContainEqual(expect.objectContaining({
      command: "chipmate.qwenAutocomplete.regenerate",
      key: "ctrl+shift+]",
      when: "editorTextFocus && !editorReadonly && !isMac",
    }))
  })

  test("separates selection and current-file context menu commands", () => {
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.addSelectionToContext",
      title: "Add Selection to ChipMate Context",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.addFileToContext",
      title: "Add Current File to ChipMate Context",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.addSelectionToContext",
      when: "editorHasSelection",
    }))
  })

  test("contributes AI comment review commands and right-click editor entries", () => {
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForSelection",
      title: "ChipMate: 为选中代码生成 AI 注释",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForCurrentFunction",
      title: "ChipMate: 为当前函数生成 AI 注释",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForWorkspaceChanges",
      title: "ChipMate: 为工作区改动生成 AI 注释",
    }))
    expect(manifest.contributes?.commands).not.toContainEqual(expect.objectContaining({
      command: "chipmate.comments.regenerateForSelection",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.accept",
      title: "ChipMate: 接受 AI 注释",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.acceptAll",
      title: "ChipMate: 接受全部 AI 注释",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.reject",
      title: "ChipMate: 拒绝 AI 注释",
    }))
    expect(manifest.contributes?.commands).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.clear",
      title: "ChipMate: 清除 AI 注释候选",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForSelection",
      when: "editorHasSelection && chipmate.comments.selectionSupportedEditor",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForCurrentFunction",
      when: "chipmate.comments.currentFunctionSupportedEditor",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForWorkspaceChanges",
    }))
    expect(manifest.contributes?.menus?.["view/title"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForWorkspaceChanges",
      when: "view == workbench.scm",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).not.toContainEqual(expect.objectContaining({
      command: "chipmate.comments.regenerateForSelection",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.accept",
      when: "chipmate.comments.cursorHasPendingSuggestion",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).not.toContainEqual(expect.objectContaining({
      command: "chipmate.comments.acceptAll",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.reject",
      when: "chipmate.comments.cursorHasPendingSuggestion",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.clear",
      when: "chipmate.comments.fileHasPendingSuggestions",
    }))
  })

  test("contributes provider, skills, permissions, MCP, completion, RAG, and code graph settings", () => {
    expect(properties["chipmate.provider.apiBaseUrl"]?.type).toBe("string")
    expect(properties["chipmate.provider.chatModel"]?.type).toBe("string")
    expect(properties["chipmate.permissions.mode"]).toMatchObject({
      type: "string",
      enum: ["ask", "auto", "full-access"],
      default: "ask",
    })
    expect(properties["chipmate.context.maxHistoryTurns"]).toMatchObject({
      type: "number",
      default: 10,
      minimum: 0,
      maximum: 20,
    })
    expect(properties["chipmate.context.maxHistoryBytes"]).toMatchObject({
      type: "number",
      default: 40000,
      minimum: 0,
      maximum: 200000,
    })
    expect(properties["chipmate.context.memorySummary.enabled"]).toMatchObject({
      type: "boolean",
      default: true,
    })
    expect(properties["chipmate.context.memorySummary.maxBytes"]).toMatchObject({
      type: "number",
      default: 12000,
      minimum: 0,
      maximum: 80000,
    })
    expect(properties["chipmate.context.memorySummary.triggerOverflowTurns"]).toMatchObject({
      type: "number",
      default: 2,
      minimum: 0,
      maximum: 20,
    })
    expect(properties["chipmate.tools.enabled"]).toMatchObject({
      type: "boolean",
      default: false,
    })
    expect(properties["chipmate.skills.enabled"]).toMatchObject({
      type: "array",
      default: [],
    })
    expect(properties["chipmate.skills.overrides"]).toMatchObject({
      type: "object",
      default: {},
    })
    expect(properties["chipmate.skills.scanUserSkills"]).toMatchObject({
      type: "boolean",
      default: true,
    })
    expect(properties["chipmate.skills.scanClaudeSkills"]).toMatchObject({
      type: "boolean",
      default: true,
    })
    expect(properties["chipmate.skills.maxCatalogBytes"]).toMatchObject({
      type: "number",
      default: 8000,
      minimum: 1000,
      maximum: 64000,
    })
    expect(properties["chipmate.mcp.enabled"]?.default).toBe(false)
    expect(properties["chipmate.completion.enabled"]).toMatchObject({
      type: "boolean",
      default: true,
    })
    expect(properties["chipmate.completion.profile"]).toMatchObject({
      type: "string",
      enum: ["generic-chat", "qwen-coder-fim", "deepseek-fim"],
      default: "qwen-coder-fim",
    })
    expect(properties["chipmate.completion.provider"]).toMatchObject({
      type: "string",
      enum: ["qwen-direct", "fim-direct", "none", "openai-compatible"],
      default: "qwen-direct",
    })
    expect(properties["chipmate.completion.apiBaseUrl"]).toMatchObject({
      type: "string",
      default: "",
    })
    expect(properties["chipmate.completion.model"]?.default).toBe("qwen-coder-30b0")
    expect(properties["chipmate.completion.temperature"]?.default).toBe(0.1)
    expect(properties["chipmate.completion.maxPromptTokens"]?.default).toBe(1024)
    expect(properties["chipmate.completion.modelTimeout"]?.default).toBe(150)
    expect(properties["chipmate.completion.cache.enabled"]?.default).toBe(true)
    expect(properties["chipmate.completion.context.recentlyEdited.enabled"]?.default).toBe(true)
    expect(properties["chipmate.completion.context.recentlyOpened.enabled"]?.default).toBe(true)
    expect(properties["chipmate.completion.context.importDefinitions.enabled"]?.default).toBe(true)
    expect(properties["chipmate.completion.context.rootPath.enabled"]?.default).toBe(true)
    expect(properties["chipmate.completion.trace"]?.default).toBe(false)
    expect(properties["chipmate.completion.logLevel"]?.enum).toEqual(["off", "info", "debug"])
    expect(properties["chipmate.completion.logPromptPreview"]?.default).toBe(false)
    expect(properties["chipmate.completion.logCompletionPreview"]?.default).toBe(true)
    expect(properties["chipmate.codeGraph.enabled"]?.default).toBe(true)
    expect(properties["chipmate.codeGraph.analysisMode"]?.enum).toEqual(["auto", "fast", "ast", "semantic"])
    expect(properties["chipmate.analysis.bridge.enabled"]).toBeUndefined()
    expect(properties["chipmate.analysis.maxEvidenceItems"]?.default).toBe(40)
    expect(properties["chipmate.rag.embedding.endpoint"]?.type).toBe("string")
    expect(properties["chipmate.rag.embedding.model"]?.default).toBe("qwen3-embedding-8b")
    expect(properties["chipmate.rag.embedding.batchSize"]?.default).toBe(64)
    expect(properties["chipmate.rag.embedding.batchSize"]?.enum).toEqual([1, 5, 10, 32, 64, 128, 256, 512])
    expect(properties["chipmate.rag.embedding.concurrentRequests"]?.default).toBe(2)
    expect(properties["chipmate.rag.embedding.timeoutMs"]?.default).toBe(60000)
    expect(properties["chipmate.rag.embedding.timeoutMs"]?.deprecationMessage).toContain("1-256 use 60000ms")
    expect(properties["chipmate.rag.allowedHosts"]?.type).toBe("array")
    expect(properties["chipmate.rag.rerank.model"]?.default).toBe("qwen3-reranker-8b")
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
    const activityIcon = readFileSync(join(import.meta.dir, "..", "media", "chipmate.svg"), "utf8")
    expect(activityIcon).toContain('stroke="currentColor"')
    expect(activityIcon).not.toContain("<linearGradient")
    expect(activityIcon).not.toContain('width="256"')
  })
})
