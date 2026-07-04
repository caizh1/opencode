import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

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
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+-build\.\d+$/)
    expect(manifest.scripts?.vsix).toBe("bun scripts/package-vsix.ts")
    expect(manifest.scripts?.["verify:qwen-vsix"]).toBe("bun scripts/verify-qwen-vsix.ts")
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")
    expect(vscodeIgnore).not.toMatch(/^node_modules\/\*\*$/m)
  })

  test("trims dependency package extras without excluding runtime packages", () => {
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    for (const pattern of [
      "node_modules/**/demo/**",
      "node_modules/**/example/**",
      "node_modules/**/fixtures/**",
      "node_modules/**/__tests__/**",
      "node_modules/@types/**",
    ]) {
      expect(vscodeIgnore).toContain(pattern)
    }
    for (const runtimePackage of [
      "node_modules/elkjs/**",
      "node_modules/mermaid/**",
      "node_modules/pdfjs-dist/**",
      "node_modules/web-tree-sitter/**",
      "node_modules/js-tiktoken/**",
    ]) {
      expect(vscodeIgnore).not.toMatch(new RegExp(`^${runtimePackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))
    }
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

  test("packages Mermaid as the offline PNG renderer runtime", () => {
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(typeof manifest.dependencies?.mermaid).toBe("string")
    expect(manifest.devDependencies?.mermaid).toBeUndefined()
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs"))).toBe(true)
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "mermaid", "dist", "chunks", "mermaid.esm.min"))).toBe(true)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/mermaid\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/mermaid\/dist\/mermaid\.esm\.min\.mjs$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/mermaid\/dist\/chunks\/mermaid\.esm\.min\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/mermaid\/dist\/chunks\/mermaid\.esm\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/mermaid\/dist\/mermaid\.esm\.mjs$/m)
  })

  test("render server supports high-DPI Mermaid PNG scale metadata", () => {
    const serverSource = readFileSync(join(import.meta.dir, "..", "server", "chipmate-word-render", "server.js"), "utf8")
    const serverManifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "server", "chipmate-word-render", "package.json"), "utf8")) as { version?: string }

    expect(serverManifest.version).toBe("0.1.2")
    expect(serverSource).toContain("const scale = clampNumber(payload.scale, 1, 4, 2)")
    expect(serverSource).toContain("deviceScaleFactor: scale")
    expect(serverSource).toContain("pixelWidth: rendered.pixelWidth")
    expect(serverSource).toContain("pixelHeight: rendered.pixelHeight")
    expect(serverSource).toContain("scale: { min: 1, max: 4, default: 2 }")
    expect(serverSource).toContain("crop: { mode: \"svg-content-bounds\"")
    expect(serverSource).toContain("mermaidScreenshotBounds(cdp, sessionId)")
    expect(serverSource).toContain("contentBounds: rendered.contentBounds")
    expect(serverSource).toContain("autoUpdateManifest")
    expect(serverSource).toContain("generatePackageManifest")
    expect(serverSource).toContain("UPDATE_EXTENSION_ID")
    expect(serverManifest.dependencies?.jszip).toBe("^3.10.1")
    expect(serverSource).not.toContain("Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 800)")
  })

  test("contributes render-service based automatic update settings", () => {
    expect(properties["chipmate.updates.enabled"]).toMatchObject({ type: "boolean", default: true })
    expect(properties["chipmate.updates.manifestUrl"]).toMatchObject({ type: "string", default: "" })
    expect(properties["chipmate.updates.manifestUrl"]?.description).toContain("chipmate.wordRender.remoteEndpoint")
    expect(properties["chipmate.updates.checkIntervalHours"]).toMatchObject({ type: "number", default: 24, minimum: 1 })
    expect(properties["chipmate.updates.maxDownloadBytes"]).toMatchObject({ type: "number", default: 536870912 })
  })

  test("keeps PDF.js parser runtime while excluding local canvas fallback", () => {
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(typeof manifest.dependencies?.["pdfjs-dist"]).toBe("string")
    expect(properties["chipmate.wordRender.remoteEndpoint"]?.default).toBe("")
    expect(properties["chipmate.wordRender.remoteEndpoint"]?.description).toContain("Remote ChipMate Word/Mermaid render server")
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs"))).toBe(true)
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "pdfjs-dist", "cmaps", "Adobe-GB1-UCS2.bcmap"))).toBe(true)
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "pdfjs-dist", "standard_fonts", "LiberationSans-Regular.ttf"))).toBe(true)
    expect(existsSync(join(import.meta.dir, "..", "node_modules", "pdfjs-dist", "image_decoders", "pdf.image_decoders.mjs"))).toBe(true)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/pdfjs-dist\/cmaps\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/pdfjs-dist\/standard_fonts\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/pdfjs-dist\/image_decoders\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/\*\*\/doc\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^node_modules\/pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/canvas\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/path2d\/\*\*$/m)
    expect(vscodeIgnore).toMatch(/^node_modules\/prebuild-install\/\*\*$/m)
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

  test("packages the documents helper script catalog as skill resources", () => {
    const skillRoot = join(import.meta.dir, "..", ".agents", "skills", "documents")
    const skillMarkdown = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
    const chipDesignSkillMarkdown = readFileSync(join(import.meta.dir, "..", ".agents", "skills", "chip-design-doc", "SKILL.md"), "utf8")
    const scriptsReadme = readFileSync(join(skillRoot, "scripts", "README.md"), "utf8")
    const helperManifest = JSON.parse(readFileSync(join(skillRoot, "scripts", "manifest.json"), "utf8")) as {
      schemaVersion?: number
      executionPolicy?: { directExecution?: boolean }
      helpers?: Array<{ name?: string; codexScript?: string; chipmateEquivalent?: string[]; status?: string; execution?: Record<string, unknown> }>
    }
    const helperNames = new Set((helperManifest.helpers ?? []).map((helper) => helper.codexScript))
    const helperManifestReport = helperManifest.helpers?.find((helper) => helper.name === "helper_manifest_report")
    const wordRuntimeReport = helperManifest.helpers?.find((helper) => helper.name === "word_runtime_field_refresh_report")
    const wordRuntimeReportJson = wordRuntimeReport ? JSON.parse(JSON.stringify(wordRuntimeReport)) as {
      execution?: {
        inputSchema?: {
          additionalProperties?: boolean
          properties?: { documentPath?: { pathKind?: string; allowedExtensions?: string[] } }
        }
      }
    } : undefined
    const wordRuntimeInputSchema = wordRuntimeReportJson?.execution?.inputSchema as {
      additionalProperties?: boolean
      properties?: { documentPath?: { pathKind?: string; allowedExtensions?: string[] } }
    } | undefined
    const vscodeIgnore = readFileSync(join(import.meta.dir, "..", ".vscodeignore"), "utf8")

    expect(skillMarkdown).toContain("scripts/manifest.json")
    expect(skillMarkdown).toContain("Do not pass `JSON.stringify(spec)`")
    expect(skillMarkdown).toContain("spec` to be a JSON object")
    expect(skillMarkdown).toContain("use `scale: 3` for Word figures")
    expect(chipDesignSkillMarkdown).toContain("Do not call it with `JSON.stringify(spec)`")
    expect(chipDesignSkillMarkdown).toContain("object-shaped detailed-design `WordDocSpec`")
    expect(chipDesignSkillMarkdown).toContain("call `chipmate_render_mermaid_diagram` with `scale: 3`")
    expect(scriptsReadme).toContain("Do not execute files from this directory")
    expect(scriptsReadme).toContain("directly. Script execution")
    expect(helperManifest.schemaVersion).toBe(2)
    expect(helperManifest.executionPolicy?.directExecution).toBe(false)
    expect(helperManifest.helpers?.length).toBeGreaterThanOrEqual(30)
    expect(helperManifestReport).toMatchObject({
      status: "executable",
      chipmateEquivalent: ["chipmate_run_skill_script"],
      execution: expect.objectContaining({
        directExecution: true,
        runtime: "node",
        entrypoint: "scripts/helper_manifest_report.mjs",
        networkPolicy: "none",
      }),
    })
    expect(wordRuntimeReport).toMatchObject({
      status: "executable",
      chipmateEquivalent: ["chipmate_run_skill_script"],
      execution: expect.objectContaining({
        directExecution: true,
        runtime: "node",
        entrypoint: "scripts/word_runtime_field_refresh_report.mjs",
        networkPolicy: "none",
      }),
    })
    expect(wordRuntimeInputSchema?.additionalProperties).toBe(false)
    expect(wordRuntimeInputSchema?.properties?.documentPath?.pathKind).toBe("workspace")
    expect(wordRuntimeInputSchema?.properties?.documentPath?.allowedExtensions).toEqual([".docx"])
    for (const script of [
      "apply_template_styles.py",
      "render_and_diff.py",
      "docx_ooxml_patch.py",
      "merge_docx_append.py",
      "xlsx_to_docx_table.py",
      "watermark_audit_remove.py",
    ]) {
      expect(helperNames.has(script)).toBe(true)
    }
    expect(helperManifest.helpers?.find((helper) => helper.codexScript === "docx_ooxml_patch.py")).toMatchObject({
      status: "native-tool",
      chipmateEquivalent: ["apply_word_document_edits.patchOoxmlPart"],
    })
    expect(helperManifest.helpers?.every((helper) => Array.isArray(helper.chipmateEquivalent) && helper.chipmateEquivalent.length > 0)).toBe(true)
    expect(vscodeIgnore).not.toMatch(/^\.agents\/\*\*$/m)
    expect(vscodeIgnore).not.toMatch(/^\.agents\/skills\/documents\/scripts/m)
  })

  test("packages the source-backed detail design skill and validates helper artifacts", () => {
    const skillRoot = join(import.meta.dir, "..", ".agents", "skills", "source-backed-detail-design")
    const skillMarkdown = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
    const mermaidRules = readFileSync(join(skillRoot, "references", "08-mermaid-png-rendering-rules.md"), "utf8")
    const wordRules = readFileSync(join(skillRoot, "references", "12-word-export-rules.md"), "utf8")
    const qualityRules = readFileSync(join(skillRoot, "references", "13-quality-gates-and-validator.md"), "utf8")
    const helperManifest = JSON.parse(readFileSync(join(skillRoot, "scripts", "manifest.json"), "utf8")) as {
      schemaVersion?: number
      executionPolicy?: { directExecution?: boolean }
      helpers?: Array<{
        name?: string
        status?: string
        chipmateEquivalent?: string[]
        execution?: { directExecution?: boolean; runtime?: string; entrypoint?: string; networkPolicy?: string }
      }>
    }
    const validator = join(skillRoot, "scripts", "validate_artifacts.mjs")
    const references = [
      "01-core-principles.md",
      "02-input-and-module-scope-rules.md",
      "03-source-exploration-rules.md",
      "04-control-flow-evidence-schema.md",
      "05-submodule-business-flow-rules.md",
      "06-state-machine-extraction-rules.md",
      "07-diagram-planning-and-splitting-rules.md",
      "08-mermaid-png-rendering-rules.md",
      "09-parent-module-assembly-rules.md",
      "10-detail-design-output-templates.md",
      "11-feature-diff-completeness-rules.md",
      "12-word-export-rules.md",
      "13-quality-gates-and-validator.md",
      "14-continuation-checkpoint-protocol.md",
      "15-business-flow-abstraction-rules.md",
    ]

    expect(skillMarkdown).toContain("name: source-backed-detail-design")
    expect(skillMarkdown).toContain("metadata:")
    expect(skillMarkdown).toContain("基于旧详设")
    expect(skillMarkdown).toContain("references/01-core-principles.md")
    expect(skillMarkdown).toContain("scripts/manifest.json")
    expect(skillMarkdown).toContain("chipmate_render_mermaid_diagram")
    expect(skillMarkdown).toContain("create_word_document")
    expect(skillMarkdown).toContain("render_word_document")
    expect(skillMarkdown).toContain("Pass `spec` as a JSON object")
    expect(skillMarkdown).toContain("never as `JSON.stringify(spec)`")
    expect(mermaidRules).toContain("chipmate_render_mermaid_diagram")
    expect(mermaidRules).toContain("scale: 3")
    expect(mermaidRules).toContain("Do not use local `mmdc`")
    expect(wordRules).toContain("create_word_document")
    expect(wordRules).toContain("render_word_document")
    expect(wordRules).toContain("Never pass `JSON.stringify(spec)`")
    expect(wordRules).toContain("local pandoc")
    expect(qualityRules).toContain("ChipMate validator helper")
    expect(qualityRules).toContain("create_word_document")
    for (const reference of references) {
      expect(existsSync(join(skillRoot, "references", reference))).toBe(true)
    }
    expect(helperManifest.schemaVersion).toBe(2)
    expect(helperManifest.executionPolicy?.directExecution).toBe(false)
    expect(helperManifest.helpers?.find((helper) => helper.name === "validate_artifacts")).toMatchObject({
      status: "executable",
      chipmateEquivalent: ["chipmate_run_skill_script"],
      execution: expect.objectContaining({
        directExecution: true,
        runtime: "node",
        entrypoint: "scripts/validate_artifacts.mjs",
        networkPolicy: "none",
      }),
    })
    expect(existsSync(validator)).toBe(true)

    const tempRoot = mkdtempSync(join(tmpdir(), "chipmate-source-backed-fixture-"))
    try {
      const outputRoot = join(tempRoot, "out")
      const artifactRoot = join(tempRoot, "artifacts")
      for (const dir of [
        "02-source-evidence",
        "03-control-flow-evidence",
        "04-diagrams/mmd/business",
        "04-diagrams/png/business",
        "05-enhanced-detail-design",
      ]) {
        mkdirSync(join(outputRoot, dir), { recursive: true })
      }
      for (const file of [
        "02-source-evidence/module-scope.md",
        "02-source-evidence/source-evidence-index.md",
        "04-diagrams/diagram-index.md",
        "04-diagrams/business-flow-index.md",
        "05-enhanced-detail-design/README.md",
        "07-diff-and-improvement-report.md",
        "08-word-export-input.md",
        "resume-state.md",
        "continue-prompt.md",
        "quality-gate-report.md",
      ]) {
        writeFileSync(join(outputRoot, file), `${file}\n`)
      }
      for (const csv of [
        "01-function-inventory.csv",
        "02-entry-points.csv",
        "03-call-edges.csv",
        "04-function-branches.csv",
        "05-state-transitions.csv",
        "09-business-capability-map.csv",
        "10-business-flow-steps.csv",
        "11-business-flow-edges.csv",
        "12-business-flow-edge-coverage.csv",
        "13-business-text-coverage.csv",
      ]) {
        writeFileSync(join(outputRoot, "03-control-flow-evidence", csv), "id,name\n1,item\n")
      }
      writeFileSync(join(outputRoot, "04-diagrams", "mmd", "business", "flow.mmd"), "flowchart TD\n  A --> B\n")
      writeFileSync(join(outputRoot, "04-diagrams", "png", "business", "flow.png"), "png-bytes\n")
      writeFileSync(join(outputRoot, "final.docx"), "docx-bytes\n")

      const pass = spawnSync(process.execPath, [validator], {
        cwd: tempRoot,
        encoding: "utf8",
        input: JSON.stringify({ outputRoot: "out", mode: "final", wordPath: "out/final.docx" }),
        env: {
          ...process.env,
          CHIPMATE_WORKSPACE_ROOT: tempRoot,
          CHIPMATE_SKILL_ROOT: skillRoot,
          CHIPMATE_SKILL_ARTIFACT_DIR: artifactRoot,
        },
      })
      expect(pass.status).toBe(0)
      expect(pass.stdout).toContain("\"status\": \"PASS\"")
      expect(JSON.parse(readFileSync(join(artifactRoot, "validate-artifacts-report.json"), "utf8"))).toMatchObject({
        ok: true,
        status: "PASS",
      })

      const fail = spawnSync(process.execPath, [validator], {
        cwd: tempRoot,
        encoding: "utf8",
        input: JSON.stringify({ outputRoot: "missing", mode: "final" }),
        env: {
          ...process.env,
          CHIPMATE_WORKSPACE_ROOT: tempRoot,
          CHIPMATE_SKILL_ROOT: skillRoot,
          CHIPMATE_SKILL_ARTIFACT_DIR: join(tempRoot, "failed-artifacts"),
        },
      })
      expect(fail.status).toBe(1)
      expect(fail.stdout).toContain("\"status\": \"INCOMPLETE\"")
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
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
    expect(properties["chipmate.provider.contextLength"]).toMatchObject({
      type: "number",
      default: 0,
      minimum: 0,
      maximum: 1000000,
    })
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
    expect(properties["chipmate.completion.providerMode"]).toMatchObject({
      type: "string",
      enum: ["inherit-chat", "custom"],
      default: "inherit-chat",
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
