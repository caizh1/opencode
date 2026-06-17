import { beforeEach, describe, expect, mock, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { DebounceTimers } from "../src/qwen-autocomplete/AutocompleteDebouncer"
import type {
  QwenAutocompleteConfig,
  QwenAutocompleteOutcome,
  QwenFimCompleteInput,
} from "../src/qwen-autocomplete/types"

type ConfigMap = Map<string, unknown>
type Pos = { line: number; character: number }
type RangeLike = { start: Pos; end: Pos }

let configValues: ConfigMap = new Map()
let requestedSections: Array<string | undefined> = []
let inlineRegistrations: Array<{ selector: unknown; provider: unknown }> = []
let commandRegistrations: string[] = []

class PositionShim {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

class RangeShim {
  readonly start: Pos
  readonly end: Pos

  constructor(start: Pos, end: Pos)
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number)
  constructor(startOrLine: Pos | number, startCharacterOrEnd: Pos | number, endLine?: number, endCharacter?: number) {
    if (typeof startOrLine === "number") {
      this.start = { line: startOrLine, character: startCharacterOrEnd as number }
      this.end = { line: endLine ?? startOrLine, character: endCharacter ?? (startCharacterOrEnd as number) }
      return
    }
    this.start = startOrLine
    this.end = startCharacterOrEnd as Pos
  }
}

class InlineCompletionItemShim {
  filterText?: string
  command?: unknown

  constructor(
    readonly insertText: string,
    readonly range?: RangeLike,
    command?: unknown,
  ) {
    this.command = command
  }
}

class UriShim {
  readonly path: string

  constructor(
    readonly fsPath: string,
    readonly scheme = "file",
  ) {
    this.path = fsPath
  }

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: { fsPath: string }, ...segments: string[]) {
    return new UriShim([base.fsPath, ...segments].join("/").replace(/\/+/g, "/"))
  }

  toString() {
    return this.scheme === "file" ? `file://${this.fsPath}` : `${this.scheme}:${this.path}`
  }
}

const workspaceMock = {
  workspaceFolders: [{ uri: UriShim.file("/repo") }],
  textDocuments: [],
  getConfiguration: (section?: string) => {
    requestedSections.push(section)
    return {
      get: <T>(key: string, fallback?: T): T => {
        const scoped = section ? `${section}.${key}` : key
        if (configValues.has(scoped)) return configValues.get(scoped) as T
        if (configValues.has(key)) return configValues.get(key) as T
        return fallback as T
      },
      update: async () => undefined,
    }
  },
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  onDidChangeTextDocument: () => ({ dispose: () => undefined }),
  onDidOpenTextDocument: () => ({ dispose: () => undefined }),
  onDidCloseTextDocument: () => ({ dispose: () => undefined }),
  asRelativePath: (uri: { fsPath?: string; path?: string }) => (uri.fsPath ?? uri.path ?? "").replace(/^\/repo\/?/, ""),
  getWorkspaceFolder: () => workspaceMock.workspaceFolders[0],
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
  },
}

mock.module("vscode", () => ({
  Position: PositionShim,
  Range: RangeShim,
  InlineCompletionItem: InlineCompletionItemShim,
  InlineCompletionTriggerKind: {
    Invoke: 0,
    Automatic: 1,
  },
  ConfigurationTarget: {
    Global: "global",
  },
  Uri: UriShim,
  workspace: workspaceMock,
  window: {
    visibleTextEditors: [],
    textDocuments: [],
    onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    showSaveDialog: async () => undefined,
  },
  commands: {
    executeCommand: async () => [],
    registerCommand: (command: string) => {
      commandRegistrations.push(command)
      return { dispose: () => undefined }
    },
  },
  languages: {
    getDiagnostics: () => [],
    registerInlineCompletionItemProvider: (selector: unknown, provider: unknown) => {
      inlineRegistrations.push({ selector, provider })
      return { dispose: () => undefined }
    },
  },
}))

const vscode = await import("vscode")
const {
  readQwenAutocompleteConfig,
  qwenAutocompleteEnabled,
  QWEN_CONFIG_SECTION,
} = await import("../src/qwen-autocomplete/config")
const {
  registerQwenAutocompleteProvider,
} = await import("../src/qwen-autocomplete")
const {
  KiloQwenInlineCompletionProvider,
  QWEN_DOCUMENT_SELECTOR,
  isQwenSupportedDocument,
} = await import("../src/qwen-autocomplete/KiloQwenInlineCompletionProvider")
const { QwenFimClient, QwenFimRequestError } = await import("../src/qwen-autocomplete/QwenFimClient")
const {
  buildQwenFimPrompt,
  getContinueAutocompleteStopTokens,
  QWEN_FIM_STOP,
} = await import("../src/qwen-autocomplete/fimTemplates")
const { processSingleLineCompletion } = await import("../src/qwen-autocomplete/processSingleLineCompletion")
const { postprocessQwenCompletion } = await import("../src/qwen-autocomplete/postprocess")
const { renderQwenInlineCompletionItem } = await import("../src/qwen-autocomplete/range")
const { AutocompleteDebouncer } = await import("../src/qwen-autocomplete/AutocompleteDebouncer")
const { QwenAutocompleteLruCache } = await import("../src/qwen-autocomplete/autocompleteLruCache")
const { createQwenAutocompleteHelper, createQwenAutocompleteHelperAsync } = await import("../src/qwen-autocomplete/helperVars")
const {
  qwenAutocompleteInputFromVscode,
  qwenOutcomeToInlineCompletionItem,
  qwenTabAutocompleteOptionsFromConfig,
} = await import("../src/qwen-autocomplete/continueAdapter")
const { filterQwenCompletionDetailed } = await import("../src/qwen-autocomplete/streamFilters")
const {
  emptyQwenSnippetPayload,
  QwenAutocompleteSnippetType,
  recentlyEditedRangesToQwenSnippets,
  selectQwenSnippets,
} = await import("../src/qwen-autocomplete/snippets")
const { recentlyOpenedFilesToQwenSnippets } = await import("../src/qwen-autocomplete/recentlyOpened")
const { QwenImportDefinitionsTracker } = await import("../src/qwen-autocomplete/importDefinitions")
const { QwenRootPathTracker, keyFor } = await import("../src/qwen-autocomplete/rootPathContext")
const { buildQwenPromptPlan } = await import("../src/qwen-autocomplete/qwenMultifileFimRenderer")
const { shouldPrefilterQwenDocument } = await import("../src/qwen-autocomplete/prefilter")
const { countTokens, tokenizerSourceForModel } = await import("../src/qwen-autocomplete/tokenPruning")
const { llamaTokenizer } = await import("../src/autocomplete/continuedev/core/llm/llamaTokenizer.js")
const { languageForFilepath } = await import("../src/autocomplete/continuedev/core/autocomplete/constants/AutocompleteLanguageInfo")
const { isSecurityConcern } = await import("../src/autocomplete/continuedev/core/indexing/ignore")

const qwenTemplateLocalStops = [
  "<|endoftext|>",
  "<|fim_prefix|>",
  "<|fim_middle|>",
  "<|fim_suffix|>",
  "<|fim_pad|>",
  "<|repo_name|>",
  "<|file_sep|>",
  "<|im_start|>",
  "<|im_end|>",
]
const continueCommonStops = ["/src/", "#- coding: utf-8", "```"]

const baseCfg: QwenAutocompleteConfig = {
  enabled: true,
  provider: "qwen-direct",
  endpoint: "http://unit.test/v1/completions",
  model: "qwen-coder-30b0",
  apiKey: "",
  debounceMs: 0,
  maxTokens: 128,
  maxPromptTokens: 1024,
  modelTimeout: 150,
  maxSuffixPercentage: 0.2,
  prefixPercentage: 0.3,
  temperature: 0.1,
  cacheEnabled: true,
  cacheMaxEntries: 1000,
  prefixChars: 12_000,
  suffixChars: 6_000,
  multifileContextEnabled: false,
  contextLength: 0,
  recentlyEditedEnabled: false,
  recentlyEditedInjectIntoPrompt: false,
  recentlyEditedMaxRanges: 3,
  recentlyEditedMaxRangeLines: 20,
  recentlyOpenedEnabled: false,
  recentlyOpenedInjectIntoPrompt: false,
  recentlyOpenedMaxFiles: 20,
  recentlyOpenedFileReadTimeoutMs: 80,
  importDefinitionsEnabled: false,
  importDefinitionsInjectIntoPrompt: false,
  importDefinitionsTimeoutMs: 100,
  importDefinitionsCacheSize: 10,
  rootPathEnabled: false,
  rootPathInjectIntoPrompt: false,
  rootPathTimeoutMs: 100,
  rootPathCacheSize: 100,
  trace: false,
  logLevel: "off",
  logPromptPreview: false,
  logCompletionPreview: true,
}

beforeEach(() => {
  configValues = new Map()
  requestedSections = []
  inlineRegistrations = []
  commandRegistrations = []
})

describe("ChipMate qwen autocomplete configuration", () => {
  test("extension activation registers qwen autocomplete instead of the old remote completion provider", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "extension.ts"), "utf8")

    expect(source).toContain("registerQwenAutocompleteProvider")
    expect(source).not.toContain("new RemoteCompletionProvider")
    expect(source).not.toContain('from "./completion"')
    expect(source).not.toContain("completionRunDirectAblation")
    expect(source).not.toContain("completionCommitInlineSuggestion")
  })

  test("uses ChipMate provider/completion settings and ignores kilo.autocomplete", () => {
    setConfig({
      "chipmate.completion.enabled": true,
      "chipmate.completion.provider": "qwen-direct",
      "chipmate.provider.apiBaseUrl": "https://chip.example.test/v1/",
      "chipmate.completion.model": "custom-qwen-coder",
      "chipmate.completion.maxTokens": 96,
      "chipmate.completion.maxPromptTokens": 4096,
      "chipmate.completion.modelTimeout": 222,
      "chipmate.completion.prefixPercentage": 0.4,
      "chipmate.completion.maxSuffixPercentage": 0.1,
      "chipmate.completion.temperature": 0.2,
      "chipmate.completion.cache.enabled": false,
      "chipmate.completion.cache.maxEntries": 12,
      "chipmate.completion.context.recentlyEdited.enabled": true,
      "chipmate.completion.context.recentlyEdited.injectIntoPrompt": true,
      "chipmate.completion.context.recentlyOpened.enabled": true,
      "chipmate.completion.context.importDefinitions.enabled": true,
      "chipmate.completion.context.rootPath.enabled": true,
      "chipmate.completion.trace": true,
      "chipmate.completion.logLevel": "debug",
      "kilo.autocomplete.enabled": false,
      "kilo.autocomplete.qwen.endpoint": "https://legacy.invalid/v1/completions",
      "kilo.autocomplete.qwen.apiKey": "legacy-key",
    })

    const cfg = readQwenAutocompleteConfig()

    expect(QWEN_CONFIG_SECTION).toBe("chipmate")
    expect(requestedSections).toEqual(["chipmate"])
    expect(cfg).toMatchObject({
      enabled: true,
      provider: "qwen-direct",
      endpoint: "https://chip.example.test/v1/completions",
      model: "custom-qwen-coder",
      apiKey: "",
      maxTokens: 96,
      maxPromptTokens: 4096,
      modelTimeout: 222,
      prefixPercentage: 0.4,
      maxSuffixPercentage: 0.1,
      temperature: 0.2,
      cacheEnabled: false,
      cacheMaxEntries: 12,
      recentlyEditedEnabled: true,
      recentlyEditedInjectIntoPrompt: true,
      recentlyOpenedEnabled: true,
      importDefinitionsEnabled: true,
      rootPathEnabled: true,
      trace: true,
      logLevel: "debug",
    })
    expect(qwenAutocompleteEnabled(cfg)).toBe(true)
  })

  test("registers only the qwen inline provider when ChipMate completion is enabled", () => {
    setConfig({
      "chipmate.completion.enabled": true,
      "chipmate.completion.provider": "qwen-direct",
      "chipmate.provider.apiBaseUrl": "http://unit.test/v1",
    })
    const context = { subscriptions: [] as Array<{ dispose(): void }> }

    const registration = registerQwenAutocompleteProvider(context as unknown as vscode.ExtensionContext)

    expect(inlineRegistrations).toHaveLength(1)
    expect(inlineRegistrations[0]!.selector).toEqual(QWEN_DOCUMENT_SELECTOR)
    expect(inlineRegistrations[0]!.provider).toBeInstanceOf(KiloQwenInlineCompletionProvider)
    expect(commandRegistrations).toEqual([
      "chipmate.qwenAutocomplete.showLogs",
      "chipmate.qwenAutocomplete.exportDiagnostics",
    ])
    registration.dispose()
  })

  test("does not register an inline provider while ChipMate completion is disabled", () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> }

    const registration = registerQwenAutocompleteProvider(context as unknown as vscode.ExtensionContext)

    expect(inlineRegistrations).toHaveLength(0)
    registration.dispose()
  })

  test("does not register qwen when completion provider is none or openai-compatible", () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> }

    setConfig({
      "chipmate.completion.enabled": true,
      "chipmate.completion.provider": "none",
      "chipmate.provider.apiBaseUrl": "http://unit.test/v1",
    })
    const none = registerQwenAutocompleteProvider(context as unknown as vscode.ExtensionContext)
    expect(readQwenAutocompleteConfig().provider).toBe("none")
    expect(qwenAutocompleteEnabled(readQwenAutocompleteConfig())).toBe(false)
    expect(inlineRegistrations).toHaveLength(0)
    none.dispose()

    setConfig({
      "chipmate.completion.enabled": true,
      "chipmate.completion.provider": "openai-compatible",
      "chipmate.provider.apiBaseUrl": "http://unit.test/v1",
    })
    const legacy = registerQwenAutocompleteProvider(context as unknown as vscode.ExtensionContext)
    expect(readQwenAutocompleteConfig().provider).toBe("none")
    expect(inlineRegistrations).toHaveLength(0)
    legacy.dispose()
  })

  test("uses kilocode/Continue runtime primitives instead of local shim replacements", () => {
    const tokenPruning = readFileSync(join(import.meta.dir, "..", "src", "qwen-autocomplete", "tokenPruning.ts"), "utf8")
    const postprocess = readFileSync(join(import.meta.dir, "..", "src", "qwen-autocomplete", "postprocess.ts"), "utf8")
    const streamFilters = readFileSync(join(import.meta.dir, "..", "src", "qwen-autocomplete", "streamFilters.ts"), "utf8")
    const processSingleLine = readFileSync(join(import.meta.dir, "..", "src", "qwen-autocomplete", "processSingleLineCompletion.ts"), "utf8")
    const guard = readFileSync(join(import.meta.dir, "..", "src", "qwen-autocomplete", "guard.ts"), "utf8")

    expect(tokenPruning).toContain('nodeRequire("js-tiktoken")')
    expect(tokenPruning).toContain('from "../autocomplete/continuedev/core/llm/llamaTokenizer.js"')
    expect(tokenPruning).not.toContain("countText(")
    expect(postprocess).toContain('from "fastest-levenshtein"')
    expect(streamFilters).toContain('from "fastest-levenshtein"')
    expect(processSingleLine).toContain('from "diff"')
    expect(guard).toContain("../autocomplete/continuedev/core/indexing/ignore")
    expect(guard).toContain("../autocomplete/shims/FileIgnoreController")
    expect(fileExists("src/autocomplete/continuedev/core/autocomplete/constants/AutocompleteLanguageInfo.ts")).toBe(true)
    expect(fileExists("src/autocomplete/continuedev/core/util/treeSitter.ts")).toBe(true)
    expect(fileExists("vendor/qwen-autocomplete/tree-sitter/import-queries/typescript.scm")).toBe(true)
    expect(fileExists("vendor/tree-sitter/wasm/tree-sitter-typescript.wasm")).toBe(true)
  })

  test("matches Continue tokenizer, language info, and security primitives", () => {
    const text = "function add(left: number, right: number) { return left + right }"

    expect(tokenizerSourceForModel("qwen-coder-30b0")).toBe("llama")
    expect(countTokens(text, "qwen-coder-30b0")).toBe(llamaTokenizer.encode(text).length)
    expect(languageForFilepath("file:///repo/src/app.py").name).toBe("Python")
    expect(languageForFilepath("file:///repo/src/app.ts").name).toBe("TypeScript")
    expect(languageForFilepath("file:///repo/README.md").useMultiline?.({ prefix: "- item", suffix: "" })).toBe(false)
    expect(isSecurityConcern("file:///repo/.env")).toBe(true)
    expect(isSecurityConcern("src/main.ts")).toBe(false)
  })

  test("records the non-streaming parity ledger and ignores streaming-only components", () => {
    const ledger = readFileSync(
      join(import.meta.dir, "..", "docs", "qwen-autocomplete-non-streaming-parity.md"),
      "utf8",
    )

    expect(ledger).toContain("Transport: non-streaming `/v1/completions` only, with `stream: false`")
    expect(ledger).toContain("Streaming/generator reuse: ignored")
    expect(ledger).toContain("`CompletionStreamer`: ignored")
    expect(ledger).toContain("`GeneratorReuseManager`: ignored")
    expect(ledger).toContain("Only `qwen-direct` registers the qwen provider")
    expect(ledger).toContain("The qwen runtime must stay isolated from Chat, RAG, CodeGraph, and semantic search")
  })

  test("keeps qwen autocomplete isolated from Chat, RAG, and CodeGraph runtime imports", () => {
    const qwenSources = sourceFiles(join(import.meta.dir, "..", "src", "qwen-autocomplete"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    const runtimeSources = [
      "src/chat-view.ts",
      "src/direct-agent-client.ts",
      "src/codegraph-service.ts",
      "src/rag-index.ts",
      "src/context.ts",
      "src/tool-runtime.ts",
    ].map((file) => readFileSync(join(import.meta.dir, "..", file), "utf8")).join("\n")

    expect(qwenSources).not.toMatch(/from "\.\.\/(?:chat|chat-view|direct-agent-client|codegraph|codegraph-service|rag|rag-index|context|tool-runtime)/)
    expect(runtimeSources).not.toContain("qwen-autocomplete")
  })
})

describe("Qwen FIM transport and provider integration", () => {
  test("maps VS Code requests through a Continue-compatible non-streaming adapter", () => {
    const document = doc("const value = sta\n", { path: "/repo/src/main.ts", languageId: "typescript" })
    const position = new vscode.Position(0, 15)
    const selectedRange = new vscode.Range(new vscode.Position(0, 14), new vscode.Position(0, 17))
    const context = {
      selectedCompletionInfo: { text: "sta", range: selectedRange },
    } as vscode.InlineCompletionContext

    const options = qwenTabAutocompleteOptionsFromConfig({
      ...baseCfg,
      provider: "none",
      cacheEnabled: false,
      recentlyEditedEnabled: true,
      recentlyOpenedEnabled: true,
      importDefinitionsEnabled: true,
    })
    const input = qwenAutocompleteInputFromVscode({
      completionId: "qwen-unit-1",
      context,
      document,
      position,
      recentlyEditedRanges: [{ filepath: "/repo/src/main.ts", lines: ["const value = sta"], timestamp: 1 }],
      recentlyVisitedRanges: [
        { filepath: "/repo/src/visited.ts", content: "export const visited = true", type: "code" },
      ],
    })
    const outcome: QwenAutocompleteOutcome = {
      ...qwenTabAutocompleteOptionsFromConfig(baseCfg),
      cacheHit: false,
      completion: "status",
      completionId: "qwen-unit-1",
      completionOptions: {},
      filepath: "/repo/src/main.ts",
      modelName: baseCfg.model,
      modelProvider: "chipmate",
      numLines: 1,
      prefix: "const value = sta",
      prompt: "<|fim_prefix|>",
      suffix: "\n",
      time: 1,
      timestamp: "2026-06-17T00:00:00.000Z",
      uniqueId: "qwen-unit-1",
    }
    const item = qwenOutcomeToInlineCompletionItem({ context, document, outcome, position })

    expect(options.disable).toBe(true)
    expect(options.useCache).toBe(false)
    expect(options.experimental_includeRecentlyEditedRanges).toBe(true)
    expect(input.completionId).toBe("qwen-unit-1")
    expect(input.filepath).toBe("/repo/src/main.ts")
    expect(input.manuallyPassFileContents).toBe("const value = sta\n")
    expect(input.selectedCompletionInfo?.text).toBe("sta")
    expect(input.recentlyVisitedRanges).toHaveLength(1)
    expect(item?.insertText).toBe("status")
  })

  test("builds HelperVars with Continue-compatible file fields and treePath diagnostics", async () => {
    const document = doc("int main(void) {\n  return 0;\n}\n")
    const syncHelper = createQwenAutocompleteHelper(document, new vscode.Position(1, 2))
    const astHelper = await createQwenAutocompleteHelperAsync(document, new vscode.Position(1, 2), undefined, {
      maxPromptTokens: baseCfg.maxPromptTokens,
      maxSuffixPercentage: baseCfg.maxSuffixPercentage,
      modelName: baseCfg.model,
      prefixPercentage: baseCfg.prefixPercentage,
      resolveTreePath: true,
    })

    expect(syncHelper.fileContents).toBe("int main(void) {\n  return 0;\n}\n")
    expect(syncHelper.fileLines).toEqual(["int main(void) {", "  return 0;", "}", ""])
    expect(syncHelper.lang.name).toBe("C")
    expect(syncHelper.workspaceUris).toEqual(["file:///repo"])
    expect(syncHelper.treePathStatus).toBe("not-requested")
    expect(["ready", "missing-ast-infrastructure", "error"]).toContain(astHelper.treePathStatus)
    if (astHelper.treePathStatus === "ready") {
      expect(astHelper.treePath?.length).toBeGreaterThan(0)
    }
  })

  test("posts Continue-style raw /completions body with qwen stop tokens", async () => {
    const seen: { url?: string; body?: Record<string, unknown>; auth?: string; signal?: AbortSignal } = {}
    const client = new QwenFimClient(async (url, init) => {
      seen.url = String(url)
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      seen.auth = (init?.headers as Record<string, string>).Authorization
      seen.signal = init?.signal as AbortSignal
      return new Response(JSON.stringify({ choices: [{ text: "return ok;" }] }))
    })
    const abort = new AbortController()

    const text = await client.complete({
      endpoint: "http://unit.test/v1/completions",
      model: "qwen-coder-30b0",
      apiKey: "secret",
      prompt: buildQwenFimPrompt({ prefix: "a", suffix: "b" }),
      maxTokens: 64,
      temperature: 0.2,
      signal: abort.signal,
    })

    expect(text).toBe("return ok;")
    expect(seen.url).toBe("http://unit.test/v1/completions")
    expect(seen.auth).toBe("Bearer secret")
    expect(seen.signal).toBe(abort.signal)
    expect(seen.body).toEqual({
      model: "qwen-coder-30b0",
      prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
      max_tokens: 64,
      temperature: 0.2,
      stream: false,
      stop: [...qwenTemplateLocalStops, ...continueCommonStops],
    })
    expect(QWEN_FIM_STOP).toEqual([...qwenTemplateLocalStops, ...continueCommonStops])
    expect(getContinueAutocompleteStopTokens("qwen-coder-30b0")).toEqual(QWEN_FIM_STOP)
  })

  test("rejects chat-completions response shapes instead of falling back", async () => {
    const client = new QwenFimClient(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "return wrong;" } }] })),
    )

    await expect(
      client.complete({
        endpoint: "http://unit.test/v1/completions",
        model: "qwen-coder-30b0",
        apiKey: "",
        prompt: "fim",
        maxTokens: 1,
        temperature: 0.1,
      }),
    ).rejects.toThrow(QwenFimRequestError)
  })

  test("injects the shared ChipMate SecretStorage key into qwen requests", async () => {
    let captured: QwenFimCompleteInput | undefined
    const provider = new KiloQwenInlineCompletionProvider({
      apiKey: async () => "shared-secret",
      client: {
        complete: async (input: QwenFimCompleteInput) => {
          captured = input
          return "return ok;"
        },
      } as unknown as InstanceType<typeof QwenFimClient>,
      guard: async () => false,
      read: () => ({ ...baseCfg, apiKey: "legacy-config-key" }),
      log: () => undefined,
    })

    const items = await complete(provider, doc("int main(void) {\n  \n}\n"), new vscode.Position(1, 2))

    expect(captured?.apiKey).toBe("shared-secret")
    expect(captured?.endpoint).toBe(baseCfg.endpoint)
    expect(items).toHaveLength(1)
    expect(items[0]!.insertText).toBe("return ok;")
  })
})

describe("Qwen completion postprocess, filters, and range", () => {
  test("keeps Continue postprocess behavior for blank, repetition, qwen3 think, and fences", () => {
    expect(post("")).toBeUndefined()
    expect(post("   \n\t")).toBeUndefined()
    expect(post("int value = 1;", { prefix: "int value = 1;\n" })).toBeUndefined()
    expect(post("repeat-value\n".repeat(9).trimEnd())).toBeUndefined()
    expect(post("\n<think>secret</think>\nreturn ok;\n", { model: "qwen3-coder" })).toBe("return ok;")
    expect(post("```c\nreturn ok;\n```")).toBe("return ok;")
    expect(post("return `ok`;")).toBe("return `ok`;")
    expect(post(" value", { prefix: "return " })).toBe("value")
  })

  test("ports non-streaming filters for stop tokens, fences, path lines, and single-line mode", () => {
    const helper = createQwenAutocompleteHelper(doc("int main(void) {\n  \n}\n"), new vscode.Position(1, 2))
    const filtered = filterQwenCompletionDetailed({
      completion: "return ok;\n```ignored\n/path/that/should/not/be/code.c\n",
      helper,
      multiline: true,
      position: new vscode.Position(1, 2),
      stopTokens: ["<|fim_prefix|>"],
      suffix: "\n}",
    })
    const single = filterQwenCompletionDetailed({
      completion: "first\nsecond",
      helper,
      multiline: false,
      position: new vscode.Position(1, 2),
      stopTokens: [],
      suffix: "",
    })

    expect(filtered.text).toBe("return ok;")
    expect(filtered.reasons).toContain("markdown-fence")
    expect(single.text).toBe("first")
  })

  test("renders single-line completions with Continue suffix replacement ranges", () => {
    expect(processSingleLineCompletion("status", "", 4)).toEqual({ completionText: "status" })
    expect(processSingleLineCompletion("hello world", " world", 2)).toEqual({
      completionText: "hello world",
      range: { start: 2, end: 8 },
    })
    expect(processSingleLineCompletion("new bar", "bar old", 1)).toEqual({ completionText: "new " })

    const item = renderQwenInlineCompletionItem(
      doc("if (true) {\n   world\n}"),
      new vscode.Position(1, 2),
      {} as vscode.InlineCompletionContext,
      "hello world",
    )

    expect(item?.insertText).toBe("hello world")
    expect(item?.range?.start).toEqual({ line: 1, character: 2 })
    expect(item?.range?.end).toEqual({ line: 1, character: 8 })
  })

  test("prefilters unsupported documents without widening qwen file support", () => {
    expect(isQwenSupportedDocument(doc("int x;", { path: "/repo/include/device.h", languageId: "plaintext" }))).toBe(true)
    expect(isQwenSupportedDocument(doc("{}", { path: "/repo/src/data.json", languageId: "json" }))).toBe(false)
    expect(shouldPrefilterQwenDocument(doc("", { path: "/repo/src/main.c", languageId: "c" }))).toBe(true)
    expect(shouldPrefilterQwenDocument(doc("int x;", { path: "/repo/src/main.c", languageId: "c" }))).toBe(false)
  })
})

describe("Qwen debounce and cache", () => {
  test("resolves superseded debounce requests as stale", async () => {
    const clock = manualTimers()
    const debouncer = new AutocompleteDebouncer(clock.timers)
    const first = debouncer.delayAndShouldDebounce(350)
    const second = debouncer.delayAndShouldDebounce(350)

    expect(await first).toBe(true)
    expect(clock.size()).toBe(1)
    clock.run()
    expect(await second).toBe(false)
  })

  test("reuses exact and typed-prefix cache hits like Continue", () => {
    const cache = new QwenAutocompleteLruCache()

    cache.put("return ", "status;")

    expect(cache.get("return ")).toBe("status;")
    expect(cache.get("return s")).toBe("tatus;")
    expect(cache.get("return x")).toBeUndefined()
  })

  test("provider cache skips the second qwen request for exact repeats", async () => {
    const api = countedClient(() => "return ok;")
    const provider = new KiloQwenInlineCompletionProvider({
      client: api.client,
      guard: async () => false,
      read: () => baseCfg,
      log: () => undefined,
    })
    const document = doc("int main(void) {\n  \n}\n")

    await complete(provider, document, new vscode.Position(1, 2))
    const items = await complete(provider, document, new vscode.Position(1, 2))

    expect(api.calls()).toBe(1)
    expect(items[0]!.insertText).toBe("return ok;")
  })
})

describe("Qwen snippets and context sources", () => {
  test("selects snippets by Continue source switches and renders multifile FIM prompt", () => {
    const helper = createQwenAutocompleteHelper(doc("int main(void) {\n  helper();\n}\n"), new vscode.Position(1, 2))
    const payload = emptyQwenSnippetPayload()
    payload.recentlyOpenedFileSnippets = [
      { filepath: "/repo/src/opened.c", content: "int opened(void);", type: QwenAutocompleteSnippetType.Code },
    ]
    payload.recentlyEditedRangeSnippets = [
      { filepath: "/repo/src/edited.c", content: "int edited(void);", type: QwenAutocompleteSnippetType.Code },
    ]
    payload.importDefinitionSnippets = [
      { filepath: "/repo/include/helper.h", content: "int helper(void);", type: QwenAutocompleteSnippetType.Code },
    ]
    payload.rootPathSnippets = [
      { filepath: "/repo/include/types.h", content: "typedef int helper_t;", type: QwenAutocompleteSnippetType.Code },
    ]

    const selected = selectQwenSnippets(helper, payload, {
      includeRecentlyEditedRanges: true,
      maxPromptTokens: baseCfg.maxPromptTokens,
      modelName: baseCfg.model,
      useImports: true,
      useRecentlyOpened: true,
      useRootPath: true,
    })
    const prompt = buildQwenPromptPlan({
      cfg: {
        ...baseCfg,
        contextLength: 8192,
        recentlyEditedEnabled: true,
        recentlyEditedInjectIntoPrompt: true,
      },
      helper,
      injectIntoPrompt: true,
      snippets: selected.snippets.filter((snippet) => "filepath" in snippet),
    })

    expect(selected.selectedCount).toBe(4)
    expect(prompt.snippetsInjectedIntoPrompt).toBe(true)
    expect(prompt.promptRendererMode).toBe("qwen-multifile-fim")
    expect(prompt.prompt).toContain("<|repo_name|>repo")
    expect(prompt.prompt).toContain("<|file_sep|>opened.c")
    expect(prompt.prompt).toContain("<|fim_prefix|>")
  })

  test("injects only snippets that survive Continue token-budget selection", async () => {
    const hugeSnippet = {
      filepath: "/repo/src/huge.c",
      content: "int huge_value(void);\n".repeat(1200),
      type: QwenAutocompleteSnippetType.Code,
    }
    let prompt = ""
    const api = countedClient((input) => {
      prompt = input.prompt
      return "return ok;"
    })
    const provider = new KiloQwenInlineCompletionProvider({
      client: api.client,
      edited: {
        count: () => 1,
        dispose: () => undefined,
        snippets: () => [hugeSnippet],
      },
      guard: async () => false,
      log: () => undefined,
      read: () => ({
        ...baseCfg,
        cacheEnabled: false,
        contextLength: 8192,
        maxPromptTokens: 32,
        recentlyEditedEnabled: true,
        recentlyEditedInjectIntoPrompt: true,
      }),
    })

    const items = await complete(provider, doc("int main(void) {\n  \n}\n"), new vscode.Position(1, 2))

    expect(api.calls()).toBe(1)
    expect(items).toHaveLength(1)
    expect(prompt).toContain("<|fim_prefix|>")
    expect(prompt).not.toContain("<|repo_name|>")
    expect(prompt).not.toContain("huge.c")
    expect(prompt).not.toContain("huge_value")
  })

  test("maps recently edited and recently opened context to qwen snippets", () => {
    expect(
      recentlyEditedRangesToQwenSnippets([
        { filepath: "/repo/src/edit.c", lines: ["int edited(void);"], timestamp: Date.now() },
      ]),
    ).toEqual([
      { filepath: "/repo/src/edit.c", content: "int edited(void);", type: QwenAutocompleteSnippetType.Code },
    ])
    expect(
      recentlyOpenedFilesToQwenSnippets([{ filepath: "/repo/src/open.c", content: "int opened(void);" }]),
    ).toEqual([
      { filepath: "/repo/src/open.c", content: "int opened(void);", type: QwenAutocompleteSnippetType.Code },
    ])
  })

  test("resolves import definition snippets through the qwen import source", async () => {
    const tracker = new QwenImportDefinitionsTracker({
      definitions: async () => [{ filepath: "/repo/include/helper.h", range: range(0, 0, 0, 17) }],
      guard: async () => false,
      parse: async () => [{ symbol: "helper", position: { line: 0, character: 10 } }],
      read: () => ({ ...baseCfg, importDefinitionsEnabled: true }),
      readRange: async () => "int helper(void);",
    })
    const document = doc('#include "helper.h"\nint main(void) { helper(); }\n')
    const helper = createQwenAutocompleteHelper(document, new vscode.Position(1, 24))

    const result = await tracker.snippets({ ...baseCfg, importDefinitionsEnabled: true }, helper, document)

    expect(result.skippedCount).toBe(0)
    expect(result.snippets).toEqual([
      { filepath: "/repo/include/helper.h", content: "int helper(void);", type: QwenAutocompleteSnippetType.Code },
    ])
  })

  test("resolves root-path snippets through root captures and VS Code definitions", async () => {
    const node = treeNode("function_definition", 12)
    const tracker = new QwenRootPathTracker({
      definitions: async () => [{ filepath: "/repo/include/types.h", range: range(0, 0, 0, 21) }],
      guard: async () => false,
      path: async () => [treeNode("program", 0), node],
      query: async () => [{ line: 0, character: 4 }],
      readRange: async () => "typedef int helper_t;",
    })
    const helper = createQwenAutocompleteHelper(doc("int main(void) {\n  return 0;\n}\n"), new vscode.Position(1, 2))

    const result = await tracker.snippets({ ...baseCfg, rootPathEnabled: true }, helper)

    expect(keyFor("/repo/src/main.c", node)).toHaveLength(64)
    expect(result.blockedReason).toBe("none")
    expect(result.snippets).toEqual([
      { filepath: "/repo/include/types.h", content: "typedef int helper_t;", type: QwenAutocompleteSnippetType.Code },
    ])
  })
})

function setConfig(values: Record<string, unknown>) {
  configValues = new Map(Object.entries(values))
}

function doc(text: string, input: { path?: string; languageId?: string; version?: number; scheme?: string } = {}) {
  const lines = text.split("\n")
  const uri = new UriShim(input.path ?? "/repo/src/main.c", input.scheme ?? "file")
  return {
    uri,
    languageId: input.languageId ?? "c",
    version: input.version ?? 1,
    lineCount: lines.length,
    lineAt: (value: number | Pos) => {
      const line = typeof value === "number" ? value : value.line
      const current = lines[line] ?? ""
      return {
        text: current,
        range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, current.length)),
      }
    },
    getText: (selection?: RangeLike) => {
      if (!selection) return text
      return text.slice(offset(lines, selection.start), offset(lines, selection.end))
    },
  } as unknown as vscode.TextDocument
}

function token() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  }
}

function complete(
  provider: InstanceType<typeof KiloQwenInlineCompletionProvider>,
  document: vscode.TextDocument,
  position: vscode.Position,
  context: vscode.InlineCompletionContext = {} as vscode.InlineCompletionContext,
) {
  return provider.provideInlineCompletionItems(document, position, context, token() as vscode.CancellationToken)
}

function post(completion: string, input: { model?: string; prefix?: string; suffix?: string } = {}) {
  return postprocessQwenCompletion({
    completion,
    model: input.model ?? "qwen-coder-30b0",
    prefix: input.prefix ?? "",
    suffix: input.suffix ?? "",
  })
}

function manualTimers(): { timers: DebounceTimers; run(): void; size(): number } {
  let next = 0
  const tasks = new Map<number, () => void>()
  return {
    timers: {
      set: (callback) => {
        const id = ++next
        tasks.set(id, callback)
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clear: (timer) => {
        tasks.delete(timer as unknown as number)
      },
    },
    run: () => {
      const pending = [...tasks.values()]
      tasks.clear()
      pending.forEach((callback) => callback())
    },
    size: () => tasks.size,
  }
}

function countedClient(next: (input: QwenFimCompleteInput) => string | Promise<string>) {
  let calls = 0
  return {
    client: {
      complete: async (input: QwenFimCompleteInput) => {
        calls++
        return next(input)
      },
    } as unknown as InstanceType<typeof QwenFimClient>,
    calls: () => calls,
  }
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): RangeLike {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  }
}

function offset(lines: string[], pos: Pos): number {
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character
}

function treeNode(type: string, startIndex: number) {
  return {
    type,
    text: type,
    startIndex,
    endIndex: startIndex + 1,
    startPosition: { row: 0, column: startIndex },
    endPosition: { row: 0, column: startIndex + 1 },
    childCount: 0,
    children: [],
  }
}

function fileExists(relativePath: string): boolean {
  try {
    return statSync(join(import.meta.dir, "..", relativePath)).isFile()
  } catch {
    return false
  }
}

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  return entries.flatMap((entry) => {
    const file = join(root, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) return sourceFiles(file)
    return file.endsWith(".ts") ? [file] : []
  })
}
