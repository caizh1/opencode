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
      when: "editorHasSelection && chipmate.comments.supportedEditor",
    }))
    expect(manifest.contributes?.menus?.["editor/context"]).toContainEqual(expect.objectContaining({
      command: "chipmate.comments.generateForCurrentFunction",
      when: "chipmate.comments.supportedEditor",
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
    expect(properties["chipmate.tools.enabled"]).toMatchObject({
      type: "boolean",
      default: false,
    })
    expect(properties["chipmate.skills.enabled"]).toMatchObject({
      type: "array",
      default: [],
    })
    expect(properties["chipmate.mcp.enabled"]?.default).toBe(false)
    expect(properties["chipmate.completion.enabled"]).toMatchObject({
      type: "boolean",
      default: true,
    })
    expect(properties["chipmate.completion.profile"]).toMatchObject({
      type: "string",
      enum: ["generic-chat", "qwen-coder-fim"],
      default: "qwen-coder-fim",
    })
    expect(properties["chipmate.completion.provider"]).toMatchObject({
      type: "string",
      enum: ["qwen-direct", "none", "openai-compatible"],
      default: "qwen-direct",
    })
    expect(properties["chipmate.completion.apiBaseUrl"]).toBeUndefined()
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
