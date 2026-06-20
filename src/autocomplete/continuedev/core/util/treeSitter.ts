import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import type WebTreeSitter from "web-tree-sitter"
type Language = WebTreeSitter.Language
type SyntaxNode = WebTreeSitter.SyntaxNode
type Query = WebTreeSitter.Query
type Tree = WebTreeSitter.Tree
import { SymbolWithRange } from ".."
import { getUriFileExtension } from "./uri"

type TreeSitterParser = {
  parse(text: string, oldTree?: unknown, options?: unknown): Tree | null
  setLanguage(language: Language): void
}

type TreeSitterModule = {
  Language: {
    load(path: string): Promise<Language>
  }
  Parser: {
    init(options?: { locateFile?: (path: string, scriptDirectory?: string) => string }): Promise<void>
    new (): TreeSitterParser
  }
  Query: new (language: Language, source: string) => Query
}

export type TreeSitterQueryLoadStatus = "ready" | "runtime-load-failed" | "missing-query-asset" | "query-load-failed"
export type TreeSitterDiagnosticStage =
  | "ready"
  | "asset-root-missing"
  | "runtime-js-missing"
  | "runtime-require-failed"
  | "runtime-export-missing"
  | "runtime-wasm-init-failed"
  | "language-unsupported"
  | "language-wasm-missing"
  | "language-load-failed"
  | "parser-create-failed"
  | "parser-set-language-failed"
  | "ast-parse-failed"
  | "query-asset-missing"
  | "query-read-failed"
  | "query-compile-failed"

export type TreeSitterLoadDiagnostic = {
  stage: TreeSitterDiagnosticStage
  languageName?: string
  queryPath?: string
  assetRootConfigured: boolean
  assetRootBasename?: string
  vendorRootExists?: boolean
  runtimeJsExists?: boolean
  runtimeWasmExists?: boolean
  languageWasmExists?: boolean
  queryAssetExists?: boolean
  errorKind?: string
  errorMessage?: string
}

export enum LanguageName {
  CPP = "cpp",
  C_SHARP = "c_sharp",
  C = "c",
  CSS = "css",
  PHP = "php",
  BASH = "bash",
  JSON = "json",
  TYPESCRIPT = "typescript",
  TSX = "tsx",
  ELM = "elm",
  JAVASCRIPT = "javascript",
  PYTHON = "python",
  ELISP = "elisp",
  ELIXIR = "elixir",
  GO = "go",
  EMBEDDED_TEMPLATE = "embedded_template",
  HTML = "html",
  JAVA = "java",
  LUA = "lua",
  OCAML = "ocaml",
  QL = "ql",
  RESCRIPT = "rescript",
  RUBY = "ruby",
  RUST = "rust",
  SYSTEMRDL = "systemrdl",
  TOML = "toml",
  SOLIDITY = "solidity",
}

const supportedLanguages: { [key: string]: LanguageName } = {
  cpp: LanguageName.CPP,
  hpp: LanguageName.CPP,
  cc: LanguageName.CPP,
  cxx: LanguageName.CPP,
  hxx: LanguageName.CPP,
  cp: LanguageName.CPP,
  hh: LanguageName.CPP,
  inc: LanguageName.CPP,
  // Depended on this PR: https://github.com/tree-sitter/tree-sitter-cpp/pull/173
  // ccm: LanguageName.CPP,
  // c++m: LanguageName.CPP,
  // cppm: LanguageName.CPP,
  // cxxm: LanguageName.CPP,
  cs: LanguageName.C_SHARP,
  c: LanguageName.C,
  h: LanguageName.C,
  css: LanguageName.CSS,
  php: LanguageName.PHP,
  phtml: LanguageName.PHP,
  php3: LanguageName.PHP,
  php4: LanguageName.PHP,
  php5: LanguageName.PHP,
  php7: LanguageName.PHP,
  phps: LanguageName.PHP,
  "php-s": LanguageName.PHP,
  bash: LanguageName.BASH,
  sh: LanguageName.BASH,
  json: LanguageName.JSON,
  ts: LanguageName.TYPESCRIPT,
  mts: LanguageName.TYPESCRIPT,
  cts: LanguageName.TYPESCRIPT,
  tsx: LanguageName.TSX,
  // vue: LanguageName.VUE,  // tree-sitter-vue parser is broken
  // The .wasm file being used is faulty, and yaml is split line-by-line anyway for the most part
  // yaml: LanguageName.YAML,
  // yml: LanguageName.YAML,
  elm: LanguageName.ELM,
  js: LanguageName.JAVASCRIPT,
  jsx: LanguageName.JAVASCRIPT,
  mjs: LanguageName.JAVASCRIPT,
  cjs: LanguageName.JAVASCRIPT,
  py: LanguageName.PYTHON,
  // ipynb: LanguageName.PYTHON, // It contains Python, but the file format is a ton of JSON.
  pyw: LanguageName.PYTHON,
  pyi: LanguageName.PYTHON,
  el: LanguageName.ELISP,
  emacs: LanguageName.ELISP,
  ex: LanguageName.ELIXIR,
  exs: LanguageName.ELIXIR,
  go: LanguageName.GO,
  eex: LanguageName.EMBEDDED_TEMPLATE,
  heex: LanguageName.EMBEDDED_TEMPLATE,
  leex: LanguageName.EMBEDDED_TEMPLATE,
  html: LanguageName.HTML,
  htm: LanguageName.HTML,
  java: LanguageName.JAVA,
  lua: LanguageName.LUA,
  luau: LanguageName.LUA,
  ocaml: LanguageName.OCAML,
  ml: LanguageName.OCAML,
  mli: LanguageName.OCAML,
  ql: LanguageName.QL,
  res: LanguageName.RESCRIPT,
  resi: LanguageName.RESCRIPT,
  rb: LanguageName.RUBY,
  erb: LanguageName.RUBY,
  rs: LanguageName.RUST,
  rdl: LanguageName.SYSTEMRDL,
  toml: LanguageName.TOML,
  sol: LanguageName.SOLIDITY,

  // jl: LanguageName.JULIA,
  // swift: LanguageName.SWIFT,
  // kt: LanguageName.KOTLIN,
  // scala: LanguageName.SCALA,
}

export const IGNORE_PATH_PATTERNS: Partial<Record<LanguageName, RegExp[]>> = {
  [LanguageName.TYPESCRIPT]: [/.*node_modules/],
  [LanguageName.JAVASCRIPT]: [/.*node_modules/],
}

let bundledAssetRoot: string | undefined
let runtimePromise: Promise<TreeSitterModule> | undefined

// Loading the wasm files to create a Language object is an expensive operation and with
// sufficient number of files can result in errors, instead keep a map of language name
// to Language object
const nameToLanguage = new Map<LanguageName, Language>()

export function initializeBundledTreeSitterAssets(extensionPath: string): void {
  const normalized = path.resolve(extensionPath)
  if (bundledAssetRoot === normalized) return
  bundledAssetRoot = normalized
  runtimePromise = undefined
  nameToLanguage.clear()
}

export function getBundledTreeSitterAssetRootForTests(): string | undefined {
  return bundledAssetRoot
}

export function resetBundledTreeSitterForTests(): void {
  bundledAssetRoot = undefined
  runtimePromise = undefined
  nameToLanguage.clear()
}

export async function getParserForFile(filepath: string) {
  return (await getParserForFileWithDiagnostics(filepath)).parser
}

export async function getParserForFileWithDiagnostics(
  filepath: string,
): Promise<{ parser: TreeSitterParser | undefined; diagnostic: TreeSitterLoadDiagnostic }> {
  const languageName = getLanguageNameForFile(filepath)
  if (!languageName) {
    return { parser: undefined, diagnostic: diagnosticFor("language-unsupported") }
  }

  let runtime: TreeSitterModule
  try {
    runtime = await loadRuntime()
  } catch (e) {
    const diagnostic = diagnosticFromError(e, "runtime-require-failed", languageName)
    return { parser: undefined, diagnostic }
  }

  let language = nameToLanguage.get(languageName)
  if (!language) {
    const wasmPath = languageWasmPath(languageName)
    if (!wasmPath) {
      return { parser: undefined, diagnostic: diagnosticFor("language-wasm-missing", { languageName }) }
    }
    try {
      language = await runtime.Language.load(wasmPath)
      nameToLanguage.set(languageName, language)
    } catch (e) {
      const diagnostic = diagnosticFor("language-load-failed", { languageName, err: e })
      console.debug("Unable to load tree-sitter language for file", filepath, diagnostic.errorKind, diagnostic.errorMessage)
      return { parser: undefined, diagnostic }
    }
  }

  try {
    const parser = new runtime.Parser()
    try {
      parser.setLanguage(language)
    } catch (e) {
      return { parser: undefined, diagnostic: diagnosticFor("parser-set-language-failed", { languageName, err: e }) }
    }
    return { parser, diagnostic: diagnosticFor("ready", { languageName }) }
  } catch (e) {
    return { parser: undefined, diagnostic: diagnosticFor("parser-create-failed", { languageName, err: e }) }
  }
}

function getExtensionFromPathOrUri(input: string): string {
  // Treat inputs with a scheme as URIs; otherwise as local filesystem paths
  if (input.includes("://") || input.startsWith("file:")) {
    return getUriFileExtension(input)
  }
  const base = path.basename(input)
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ""
}

async function getLanguageForFile(filepathOrUri: string, runtime?: TreeSitterModule): Promise<Language | undefined> {
  try {
    const languageName = getLanguageNameForFile(filepathOrUri)
    if (!languageName) {
      return undefined
    }
    let language = nameToLanguage.get(languageName)

    if (!language) {
      const activeRuntime = runtime ?? (await loadRuntime())
      language = await loadLanguage(activeRuntime, languageName)
      nameToLanguage.set(languageName, language)
    }
    return language
  } catch (e) {
    console.debug("Unable to load language for file", filepathOrUri, e)
    return undefined
  }
}

export const getFullLanguageName = (filepathOrUri: string) => getLanguageNameForFile(filepathOrUri)

export async function getQueryForFile(filepathOrUri: string, queryPath: string): Promise<Query | undefined> {
  return (await getQueryForFileWithStatus(filepathOrUri, queryPath)).query
}

export async function getQueryForFileWithStatus(
  filepathOrUri: string,
  queryPath: string,
): Promise<{ query: Query | undefined; status: TreeSitterQueryLoadStatus; diagnostic?: TreeSitterLoadDiagnostic }> {
  let runtime: TreeSitterModule
  const languageName = getLanguageNameForFile(filepathOrUri)
  try {
    runtime = await loadRuntime()
  } catch (err) {
    return {
      query: undefined,
      status: "runtime-load-failed",
      diagnostic: diagnosticFromError(err, "runtime-require-failed", languageName, queryPath),
    }
  }

  const language = await getLanguageForFile(filepathOrUri, runtime)
  if (!language) {
    return {
      query: undefined,
      status: "runtime-load-failed",
      diagnostic: diagnosticFor(languageName ? "language-load-failed" : "language-unsupported", { languageName, queryPath }),
    }
  }

  const sourcePath = querySourcePath(queryPath)
  if (!sourcePath) {
    return {
      query: undefined,
      status: "missing-query-asset",
      diagnostic: diagnosticFor("query-asset-missing", { languageName, queryPath }),
    }
  }

  let querySource: string
  try {
    querySource = fs.readFileSync(sourcePath, "utf8")
  } catch (err) {
    console.debug("Unable to read tree-sitter query", filepathOrUri, queryPath, err)
    return {
      query: undefined,
      status: "query-load-failed",
      diagnostic: diagnosticFor("query-read-failed", { languageName, queryPath, err }),
    }
  }

  try {
    return {
      query: new runtime.Query(language, querySource),
      status: "ready",
      diagnostic: diagnosticFor("ready", { languageName, queryPath }),
    }
  } catch (err) {
    console.debug("Unable to compile tree-sitter query", filepathOrUri, queryPath, err)
    return {
      query: undefined,
      status: "query-load-failed",
      diagnostic: diagnosticFor("query-compile-failed", { languageName, queryPath, err }),
    }
  }
}

async function loadRuntime(): Promise<TreeSitterModule> {
  runtimePromise ??= (async () => {
    if (!bundledAssetRoot) {
      throw diagnosticError("asset-root-missing")
    }
    const runtimePath = bundledRuntimePath()
    if (!runtimePath) {
      throw diagnosticError("runtime-js-missing")
    }
    let imported: unknown
    try {
      imported = createRequire(runtimePath)(runtimePath)
    } catch (err) {
      throw diagnosticError("runtime-require-failed", { err })
    }
    const runtime = treeSitterModuleFromImport(imported)
    if (!runtime) {
      throw diagnosticError("runtime-export-missing")
    }
    const vendorRoot = bundledVendorRoot()
    if (!vendorRoot) {
      throw diagnosticError("asset-root-missing")
    }
    try {
      await runtime.Parser.init({
        locateFile: (file) => path.join(vendorRoot, file),
      })
    } catch (err) {
      throw diagnosticError("runtime-wasm-init-failed", { err })
    }
    return runtime
  })()
  return runtimePromise
}

async function loadLanguage(runtime: TreeSitterModule, languageName: LanguageName): Promise<Language> {
  const wasmPath = languageWasmPath(languageName)
  if (!wasmPath) {
    throw diagnosticError("language-wasm-missing", { languageName })
  }
  try {
    return await runtime.Language.load(wasmPath)
  } catch (err) {
    throw diagnosticError("language-load-failed", { languageName, err })
  }
}

function getLanguageNameForFile(filepathOrUri: string): LanguageName | undefined {
  const extension = getExtensionFromPathOrUri(filepathOrUri)
  return supportedLanguages[extension]
}

function bundledVendorRoot(): string | undefined {
  if (!bundledAssetRoot) return undefined
  return path.join(bundledAssetRoot, "vendor", "tree-sitter")
}

function bundledRuntimePath(): string | undefined {
  const vendorRoot = bundledVendorRoot()
  if (!vendorRoot) return undefined
  const runtimePath = path.join(vendorRoot, "tree-sitter.js")
  return fs.existsSync(runtimePath) ? runtimePath : undefined
}

function languageWasmPath(languageName: LanguageName): string | undefined {
  const vendorRoot = bundledVendorRoot()
  if (!vendorRoot) return undefined
  const wasmPath = path.join(vendorRoot, "wasm", `tree-sitter-${languageName}.wasm`)
  return fs.existsSync(wasmPath) ? wasmPath : undefined
}

function querySourcePath(queryPath: string): string | undefined {
  if (!bundledAssetRoot) return undefined
  const fullPath = path.join(bundledAssetRoot, "vendor", "qwen-autocomplete", "tree-sitter", queryPath)
  return fs.existsSync(fullPath) ? fullPath : undefined
}

class TreeSitterDiagnosticError extends Error {
  constructor(readonly diagnostic: TreeSitterLoadDiagnostic) {
    super(diagnostic.errorMessage ?? diagnostic.stage)
    this.name = "TreeSitterDiagnosticError"
  }
}

function diagnosticError(
  stage: TreeSitterDiagnosticStage,
  opts: { languageName?: LanguageName; queryPath?: string; err?: unknown } = {},
): TreeSitterDiagnosticError {
  return new TreeSitterDiagnosticError(diagnosticFor(stage, opts))
}

function diagnosticFromError(
  err: unknown,
  fallbackStage: TreeSitterDiagnosticStage,
  languageName?: LanguageName,
  queryPath?: string,
): TreeSitterLoadDiagnostic {
  if (err instanceof TreeSitterDiagnosticError) {
    return {
      ...err.diagnostic,
      languageName: err.diagnostic.languageName ?? languageName,
      queryPath: err.diagnostic.queryPath ?? queryPath,
    }
  }
  return diagnosticFor(fallbackStage, { languageName, queryPath, err })
}

function diagnosticFor(
  stage: TreeSitterDiagnosticStage,
  opts: { languageName?: LanguageName; queryPath?: string; err?: unknown } = {},
): TreeSitterLoadDiagnostic {
  const vendorRoot = bundledVendorRoot()
  const runtimeJsPath = vendorRoot ? path.join(vendorRoot, "tree-sitter.js") : undefined
  const runtimeWasmPath = vendorRoot ? path.join(vendorRoot, "tree-sitter.wasm") : undefined
  const languageWasmPathForDiagnostic = opts.languageName
    ? path.join(vendorRoot ?? "", "wasm", `tree-sitter-${opts.languageName}.wasm`)
    : undefined
  const queryAssetPath = opts.queryPath
    ? path.join(bundledAssetRoot ?? "", "vendor", "qwen-autocomplete", "tree-sitter", opts.queryPath)
    : undefined
  const error = errorSummary(opts.err)
  return {
    stage,
    languageName: opts.languageName,
    queryPath: opts.queryPath,
    assetRootConfigured: Boolean(bundledAssetRoot),
    assetRootBasename: bundledAssetRoot ? path.basename(bundledAssetRoot) : undefined,
    vendorRootExists: vendorRoot ? fs.existsSync(vendorRoot) : false,
    runtimeJsExists: runtimeJsPath ? fs.existsSync(runtimeJsPath) : false,
    runtimeWasmExists: runtimeWasmPath ? fs.existsSync(runtimeWasmPath) : false,
    languageWasmExists: languageWasmPathForDiagnostic ? fs.existsSync(languageWasmPathForDiagnostic) : undefined,
    queryAssetExists: queryAssetPath ? fs.existsSync(queryAssetPath) : undefined,
    errorKind: error.kind,
    errorMessage: error.message,
  }
}

function errorSummary(err: unknown): { kind?: string; message?: string } {
  if (!err) return {}
  if (err instanceof Error) return { kind: err.name || "Error", message: err.message.slice(0, 300) }
  return { kind: typeof err, message: String(err).slice(0, 300) }
}

function treeSitterModuleFromImport(imported: unknown): TreeSitterModule | undefined {
  const candidates = [
    imported,
    (imported as { default?: unknown } | undefined)?.default,
    (imported as { "module.exports"?: unknown } | undefined)?.["module.exports"],
  ]

  for (const candidate of candidates) {
    if (isTreeSitterModule(candidate)) return candidate
  }

  return undefined
}

function isTreeSitterModule(value: unknown): value is TreeSitterModule {
  if (!value || typeof value !== "object") return false
  const current = value as Partial<TreeSitterModule>
  return (
    typeof current.Parser?.init === "function" &&
    typeof current.Parser === "function" &&
    typeof current.Language?.load === "function" &&
    typeof current.Query === "function"
  )
}

// See https://tree-sitter.github.io/tree-sitter/using-parsers
const GET_SYMBOLS_FOR_NODE_TYPES: SyntaxNode["type"][] = [
  "class_declaration",
  "class_definition",
  "function_item", // function name = first "identifier" child
  "function_definition",
  "method_declaration", // method name = first "identifier" child
  "method_definition",
  "generator_function_declaration",
  // property_identifier
  // field_declaration
  // "arrow_function",
]

export async function getSymbolsForFile(filepath: string, contents: string): Promise<SymbolWithRange[] | undefined> {
  //MINIMAL_REPO - continue doesn't use this in autocomplete
  const parser = await getParserForFile(filepath)
  if (!parser) {
    return
  }

  let tree: Tree | null
  try {
    tree = parser.parse(contents)
  } catch {
    console.log(`Error parsing file: ${filepath}`)
    return
  }

  if (!tree) {
    console.log(`Failed to parse file: ${filepath}`)
    return
  }
  // console.log(`file: ${filepath}`);

  // Function to recursively find all named nodes (classes and functions)
  const symbols: SymbolWithRange[] = []
  function findNamedNodesRecursive(node: SyntaxNode) {
    // console.log(`node: ${node.type}, ${node.text}`);
    if (GET_SYMBOLS_FOR_NODE_TYPES.includes(node.type)) {
      // console.log(`parent: ${node.type}, ${node.text.substring(0, 200)}`);
      // node.children.forEach((child) => {
      //   console.log(`child: ${child.type}, ${child.text}`);
      // });

      // Empirically, the actual name is the last identifier in the node
      // Especially with languages where return type is declared before the name
      // TODO use findLast in newer version of node target
      let identifier: SyntaxNode | undefined = undefined
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i]
        if (child && (child.type === "identifier" || child.type === "property_identifier")) {
          identifier = child
          break
        }
      }

      if (identifier?.text) {
        symbols.push({
          filepath,
          type: node.type,
          name: identifier.text,
          range: {
            start: {
              character: node.startPosition.column,
              line: node.startPosition.row,
            },
            end: {
              character: node.endPosition.column + 1,
              line: node.endPosition.row + 1,
            },
          },
          content: node.text,
        })
      }
    }
    node.children.forEach((child) => {
      if (child) findNamedNodesRecursive(child)
    })
  }
  findNamedNodesRecursive(tree.rootNode)
  return symbols
}
