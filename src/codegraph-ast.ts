import { createRequire } from "node:module"
import { join } from "node:path"
import { parseCFile } from "./codegraph-c-parser"
import type { CodeGraphAstControl, CodeGraphAstSummary, CodeGraphFile } from "./codegraph-types"

type TreeSitterModule = {
  Parser: {
    init(options?: { locateFile?: (path: string) => string }): Promise<void>
    new (): TreeSitterParser
  }
  Language: {
    load(path: string): Promise<unknown>
  }
}

type TreeSitterParser = {
  setLanguage(language: unknown): void
  parse(text: string): TreeSitterTree
  delete?(): void
}

type TreeSitterTree = {
  rootNode: TreeSitterNode
  delete?(): void
}

type TreeSitterNode = {
  type: string
  text?: string
  namedChildCount: number
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  namedChild(index: number): TreeSitterNode | null
  childForFieldName(name: string): TreeSitterNode | null
}

type LanguageKey = "c" | "cpp"

const MAX_AST_CONTROLS = 80
let runtimePromise: Promise<TreeSitterModule> | undefined
const languages = new Map<LanguageKey, Promise<unknown>>()

export function treeSitterVendorRoot(extensionPath: string) {
  return join(extensionPath, "vendor", "tree-sitter")
}

export async function parseCFileWithAst(input: {
  path: string
  text: string
  hash: string
  size: number
  indexedAt?: number
  extensionPath: string
}): Promise<CodeGraphFile> {
  const file = parseCFile(input)
  try {
    file.astSummary = await buildAstSummary(input.extensionPath, input.path, input.text)
  } catch {
    // AST is an enhancement. Keep the existing parser result if WASM loading or parsing fails.
  }
  return file
}

export async function canLoadBundledTreeSitter(extensionPath: string) {
  try {
    const runtime = await loadRuntime(extensionPath)
    await loadLanguage(runtime, extensionPath, "c")
    await loadLanguage(runtime, extensionPath, "cpp")
    return true
  } catch {
    return false
  }
}

async function buildAstSummary(extensionPath: string, path: string, text: string): Promise<CodeGraphAstSummary> {
  const languageKey = languageKeyForPath(path)
  const runtime = await loadRuntime(extensionPath)
  const language = await loadLanguage(runtime, extensionPath, languageKey)
  const parser = new runtime.Parser()
  let tree: TreeSitterTree | undefined
  try {
    parser.setLanguage(language)
    tree = parser.parse(text)
    return summarizeTree(tree.rootNode, languageKey)
  } finally {
    tree?.delete?.()
    parser.delete?.()
  }
}

async function loadRuntime(extensionPath: string): Promise<TreeSitterModule> {
  runtimePromise ??= (async () => {
    const vendorRoot = treeSitterVendorRoot(extensionPath)
    const runtimePath = join(vendorRoot, "tree-sitter.js")
    const runtime = createRequire(runtimePath)(runtimePath) as TreeSitterModule
    await runtime.Parser.init({
      locateFile: (file) => join(vendorRoot, file),
    })
    return runtime
  })()
  return runtimePromise
}

function loadLanguage(runtime: TreeSitterModule, extensionPath: string, language: LanguageKey) {
  const cached = languages.get(language)
  if (cached) return cached
  const loaded = runtime.Language.load(join(treeSitterVendorRoot(extensionPath), "wasm", "tree-sitter-cpp.wasm"))
  languages.set(language, loaded)
  return loaded
}

function summarizeTree(root: TreeSitterNode, language: LanguageKey): CodeGraphAstSummary {
  const summary: CodeGraphAstSummary = {
    parser: "tree-sitter-wasm",
    language,
    functions: 0,
    calls: 0,
    ifStatements: 0,
    switchStatements: 0,
    caseStatements: 0,
    assignments: 0,
    errors: 0,
    controls: [],
  }

  visit(root, (node) => {
    switch (node.type) {
      case "function_definition":
        summary.functions++
        break
      case "call_expression":
        summary.calls++
        break
      case "if_statement":
        summary.ifStatements++
        pushControl(summary.controls, node, "if")
        break
      case "switch_statement":
        summary.switchStatements++
        pushControl(summary.controls, node, "switch")
        break
      case "case_statement":
        summary.caseStatements++
        pushControl(summary.controls, node, "case")
        break
      case "assignment_expression":
        summary.assignments++
        break
      case "ERROR":
        summary.errors++
        break
    }
  })

  return summary
}

function visit(node: TreeSitterNode, callback: (node: TreeSitterNode) => void) {
  callback(node)
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index)
    if (child) visit(child, callback)
  }
}

function pushControl(controls: CodeGraphAstControl[], node: TreeSitterNode, kind: CodeGraphAstControl["kind"]) {
  if (controls.length >= MAX_AST_CONTROLS) return
  const condition = node.childForFieldName("condition")?.text
  controls.push({
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    condition: condition ? limitInline(condition) : undefined,
  })
}

function limitInline(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact
}

function languageKeyForPath(path: string): LanguageKey {
  const ext = path.toLowerCase().split(".").pop()
  return ext === "c" || ext === "h" ? "c" : "cpp"
}
