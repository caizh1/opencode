import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

function source(path: string) {
  return readFileSync(join(root, path), "utf8")
}

function functionBlock(sourceText: string, name: string) {
  const start = sourceText.indexOf(`function ${name}`)
  const next = sourceText.indexOf("\nfunction ", start + 1)
  return sourceText.slice(start, next === -1 ? undefined : next)
}

describe("ChipMate Liquid Glass webview shell", () => {
  const viewSource = source("src/chipmate-chat-view.ts")
  const htmlSource = source("src/webview/chipmate-html.ts")
  const styleSource = source("src/webview/chipmate-styles.ts")
  const scriptSource = source("src/webview/chipmate-script.ts")
  const typeSource = source("src/webview/chipmate-view-types.ts")

  test("renders all product modules with Chat as the default module", () => {
    for (const module of ["chat", "models", "knowledge", "skills", "mcp"]) {
      expect(htmlSource).toContain(`data-module="${module}"`)
    }
    expect(htmlSource).toContain('id="openSettings"')
    expect(scriptSource).toContain('id === "openSettings"')
    expect(scriptSource).toContain('activeModule = "settings"')
    expect(scriptSource).toContain('let activeModule = "chat"')
    expect(scriptSource).toContain("renderChatModule")
    expect(scriptSource).toContain("renderModelsModule")
    expect(scriptSource).toContain("renderKnowledgeModule")
    expect(scriptSource).toContain("renderSkillsModule")
    expect(scriptSource).toContain("renderMcpModule")
    expect(scriptSource).toContain("renderSettingsModule")
  })

  test("keeps the composer scoped to Chat and names Output as diagnostics logs", () => {
    expect(htmlSource).toContain('id="chatComposer"')
    expect(scriptSource).toContain("toggleComposer")
    expect(scriptSource).toContain('activeModule === "chat"')
    expect(htmlSource).toContain("Open diagnostics logs")
    expect(htmlSource).toContain('data-icon="diagnostics"')
    expect(htmlSource).not.toContain("Chat history")
  })

  test("separates Skills and MCP catalog surfaces", () => {
    expect(scriptSource).toContain('pkg.type === "skill"')
    expect(scriptSource).toContain('pkg.type === "mcp"')
    expect(scriptSource).toContain("renderSkillsModule")
    expect(scriptSource).toContain("renderMcpModule")
    expect(typeSource).toContain("skillSummaries")
    expect(typeSource).toContain("mcpProbeResults")
  })

  test("exposes context, CodeGraph, RAG, hybrid capabilities, Skills, and MCP status in webview state", () => {
    for (const marker of [
      "contextSummary: this.contextSummary",
      "codeGraphStatus: this.deps.codeGraph?.status()",
      "ragStatus: this.deps.codeGraph?.status().rag",
      "chatSettings: settings.chat",
      "completionSettings: settings.completion",
      "ragSettings: settings.rag",
      "skillSummaries: this.skillSummaries",
      "mcpProbeResults: this.mcpProbeResults",
    ]) {
      expect(viewSource).toContain(marker)
    }
    expect(scriptSource).toContain("Graph")
    expect(scriptSource).toContain("Vector")
    expect(scriptSource).toContain("Rerank")
  })

  test("wires Knowledge actions with confirmation for destructive operations", () => {
    for (const action of ["check", "apply", "rebuild", "pause", "resume", "cancel"]) {
      expect(scriptSource).toContain(`data-knowledge-action="${action}"`)
    }
    expect(scriptSource).toContain("confirmKnowledgeAction")
    expect(scriptSource).toContain("Rebuild local knowledge indexes?")
    expect(scriptSource).toContain("Cancel active knowledge indexing?")
    expect(viewSource).toContain("case \"knowledgeAction\"")
    expect(viewSource).toContain("applyRagConfiguration")
    expect(viewSource).toContain("testRagConfiguration")
    expect(viewSource).toContain("pauseRagIndexing")
    expect(viewSource).toContain("resumeRagIndexing")
    expect(viewSource).toContain("cancelRagIndexing")
  })

  test("keeps icon layout in normal flow without absolute positioning", () => {
    expect(styleSource).not.toMatch(/position\s*:\s*absolute/i)
    expect(styleSource).toContain("inline-flex")
    expect(styleSource).toContain("grid-template-columns")
    expect(styleSource).toContain("flex-wrap")
  })

  test("keeps the installed VS Code sidebar chrome compact at narrow widths", () => {
    const compactMedia = styleSource.slice(styleSource.indexOf("@media (max-width: 310px)"))

    expect(styleSource).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));")
    expect(styleSource).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));")
    expect(htmlSource).toContain('<span class="dockLabel">Model</span>')
    expect(htmlSource).toContain('<span class="dockLabel">Know</span>')
    expect(compactMedia).not.toMatch(/\.headerActions\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/)
    expect(compactMedia).not.toMatch(/\.statusStrip[\s\S]*?grid-template-columns:\s*1fr/)
  })

  test("shows save feedback inside the module where the action was pressed", () => {
    expect(functionBlock(scriptSource, "renderModelsModule")).toContain("noticeLine(state.settingsNotice)")
    expect(functionBlock(scriptSource, "renderSkillsModule")).toContain("noticeLine(state.settingsNotice)")
    expect(functionBlock(scriptSource, "renderMcpModule")).toContain("noticeLine(state.settingsNotice)")
  })
})

describe("ChipMate retrieval boundary during UI redesign", () => {
  const serviceSource = source("src/codegraph-service.ts")
  const repositoryEvidenceSource = source("src/repository-evidence.ts")
  const completionEvidenceSource = source("src/completion-c-embedded-evidence.ts")

  test("keeps hybrid retrieval in the existing service and evidence paths", () => {
    expect(serviceSource).toContain("hybridOptions()")
    expect(serviceSource).toContain('options.retrievalMode === "graph-only" ? undefined : this.hybridOptions()')
    expect(repositoryEvidenceSource).toContain('retrievalMode: "hybrid"')
    expect(repositoryEvidenceSource).toContain('retrievalMode: "graph-only"')
    expect(completionEvidenceSource).toContain('retrievalMode: "hybrid"')
    expect(completionEvidenceSource).toContain('retrievalMode: "graph-only"')
  })
})
