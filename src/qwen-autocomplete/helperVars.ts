import * as vscode from "vscode"
import type { AstPath } from "../autocomplete/continuedev/core/autocomplete/util/ast"
import { getAstWithStatus, getTreePathAtCursor } from "../autocomplete/continuedev/core/autocomplete/util/ast"
import type { TreeSitterLoadDiagnostic } from "../autocomplete/continuedev/core/util/treeSitter"
import {
  languageForFilepath,
  type AutocompleteLanguageInfo,
} from "../autocomplete/continuedev/core/autocomplete/constants/AutocompleteLanguageInfo"
import { constructInitialPrefixSuffix } from "./constructPrefixSuffix"
import {
  prunePrefixSuffixWithTokenBudget,
  QWEN_CONTINUE_TOKEN_PRUNING_DEFAULTS,
  tokenizerSourceForModel,
  type QwenTokenPruningOptions,
  type QwenTokenizerSource,
} from "./tokenPruning"

export type QwenHelperOptions = QwenTokenPruningOptions & {
  modelName?: string
  resolveTreePath?: boolean
}

export type QwenTreePathStatus = "not-requested" | "ready" | "runtime-load-failed" | "ast-parse-failed" | "error"

export type QwenAutocompleteHelperVars = {
  estimatedPrefixTokens: number
  estimatedPromptTokens: number
  estimatedSuffixTokens: number
  filepath: string
  fileContents: string
  fileLines: string[]
  fullPrefix: string
  fullSuffix: string
  helperParityMode: "continue-helpervars-token-budget"
  lang: AutocompleteLanguageInfo
  languageId: string
  pos: { line: number; character: number }
  prunedPrefix: string
  prunedCaretWindow: string
  prunedSuffix: string
  tokenizerSource: QwenTokenizerSource
  treePath: AstPath | undefined
  treeSitterDiagnostic?: TreeSitterLoadDiagnostic
  treePathStatus: QwenTreePathStatus
  workspaceUris: string[]
}

export const QWEN_HELPER_DEFAULTS = QWEN_CONTINUE_TOKEN_PRUNING_DEFAULTS

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/util/HelperVars.ts
// - core/autocomplete/templating/constructPrefixSuffix.ts
// - core/llm/countTokens.ts
// qwen-direct resolves treePath through bundled tree-sitter assets only when
// the caller opts into AST-backed helper parity.
export function createQwenAutocompleteHelper(
  document: vscode.TextDocument,
  position: vscode.Position,
  selected?: vscode.SelectedCompletionInfo,
  opts: QwenHelperOptions = QWEN_HELPER_DEFAULTS,
): QwenAutocompleteHelperVars {
  return createBaseHelper(document, position, selected, opts, undefined, "not-requested")
}

export async function createQwenAutocompleteHelperAsync(
  document: vscode.TextDocument,
  position: vscode.Position,
  selected?: vscode.SelectedCompletionInfo,
  opts: QwenHelperOptions = QWEN_HELPER_DEFAULTS,
): Promise<QwenAutocompleteHelperVars> {
  const base = createBaseHelper(document, position, selected, opts, undefined, "error")
  if (opts.resolveTreePath === false) return { ...base, treePathStatus: "not-requested" }
  try {
    const ast = await getAstWithStatus(base.filepath, base.fileContents)
    if (!ast.ast) return { ...base, treePathStatus: ast.status, treeSitterDiagnostic: ast.treeSitterDiagnostic }
    const treePath = await getTreePathAtCursor(ast.ast, base.fullPrefix.length)
    return { ...base, treePath, treePathStatus: "ready", treeSitterDiagnostic: ast.treeSitterDiagnostic }
  } catch (err) {
    void err
    return { ...base, treePath: undefined, treePathStatus: "error" }
  }
}

function createBaseHelper(
  document: vscode.TextDocument,
  position: vscode.Position,
  selected: vscode.SelectedCompletionInfo | undefined,
  opts: QwenHelperOptions,
  treePath: AstPath | undefined,
  treePathStatus: QwenTreePathStatus,
): QwenAutocompleteHelperVars {
  const model = opts.modelName ?? "qwen-coder-30b0"
  const fileContents = document.getText()
  const fileLines = fileContents.split("\n")
  const filepath = document.uri.fsPath || document.uri.path
  const parts = constructInitialPrefixSuffix({ document, position, selected })
  const pruned = prunePrefixSuffixWithTokenBudget(parts.prefix, parts.suffix, model, opts)
  return {
    estimatedPrefixTokens: pruned.estimatedPrefixTokens,
    estimatedPromptTokens: pruned.estimatedPromptTokens,
    estimatedSuffixTokens: pruned.estimatedSuffixTokens,
    filepath,
    fileContents,
    fileLines,
    fullPrefix: parts.prefix,
    fullSuffix: parts.suffix,
    helperParityMode: "continue-helpervars-token-budget",
    lang: languageForFilepath(filepath),
    languageId: document.languageId,
    pos: { line: position.line, character: position.character },
    prunedPrefix: pruned.prunedPrefix,
    prunedCaretWindow: pruned.prunedPrefix + pruned.prunedSuffix,
    prunedSuffix: pruned.prunedSuffix,
    tokenizerSource: tokenizerSourceForModel(model),
    treePath,
    treePathStatus,
    workspaceUris: workspaceUris(),
  }
}

function workspaceUris(): string[] {
  return (
    vscode.workspace.workspaceFolders?.map((folder) => {
      const uri = folder.uri as vscode.Uri & { fsPath?: string; path?: string; toString?: () => string }
      if (uri.fsPath) return vscode.Uri.file(uri.fsPath).toString()
      if (uri.path) return vscode.Uri.file(uri.path).toString()
      if (typeof uri.toString === "function") return uri.toString()
      return ""
    }) ?? []
  ).filter((uri) => uri.length > 0)
}
