import { access } from "node:fs/promises"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import * as vscode from "vscode"
import { canLoadBundledTreeSitter } from "./codegraph-ast"
import type { CodeGraphAnalysisMode, RemoteSettings } from "./types"

export type CodeGraphEffectiveAnalysisMode = "fast" | "ast"

export type CodeGraphAnalyzerStatus = {
  requestedMode: CodeGraphAnalysisMode
  effectiveMode: CodeGraphEffectiveAnalysisMode
  host: string
  platform: string
  bundledAstAvailable: boolean
  compileCommandsPath?: string
  compileFlagsPath?: string
  clangdPath?: string
  scipClangPath?: string
  degradedReason?: string
  detail: string
}

export async function detectCodeGraphAnalyzer(
  context: vscode.ExtensionContext,
  root: vscode.WorkspaceFolder,
  settings: RemoteSettings,
): Promise<CodeGraphAnalyzerStatus> {
  const requestedMode = settings.codeGraph.analysisMode
  const host = vscode.env.remoteName ? `remote:${vscode.env.remoteName}` : "local"
  const platform = `${process.platform}-${process.arch}`
  const [bundledAstAvailable, compileCommandsPath, compileFlagsPath, clangdPath, scipClangPath] = await Promise.all([
    canLoadBundledTreeSitter(context.extensionUri.fsPath),
    findCompileCommands(root, settings.codeGraph.compileCommandsPath),
    findCompileFlags(root),
    findExecutable(settings.codeGraph.clangdPath, ["clangd", "clangd.exe"]),
    findExecutable(settings.codeGraph.scipClangPath, ["scip-clang", "scip-clang.exe"]),
  ])

  let effectiveMode: CodeGraphEffectiveAnalysisMode = "fast"
  let degradedReason: string | undefined
  if (requestedMode === "fast") {
    effectiveMode = "fast"
  } else if (bundledAstAvailable) {
    effectiveMode = "ast"
    if (requestedMode === "semantic") {
      degradedReason = "Semantic mode needs a dedicated SCIP/clang integration; using bundled Tree-sitter AST analysis."
    }
  } else {
    degradedReason = "Bundled Tree-sitter WASM analyzer is unavailable; using fast parser."
  }

  const semanticHints = [
    compileCommandsPath ? "compile_commands.json detected" : undefined,
    compileFlagsPath ? "compile_flags.txt detected" : undefined,
    clangdPath ? "clangd detected" : undefined,
    scipClangPath ? "scip-clang detected" : undefined,
  ].filter(Boolean)
  const detail = [
    `${effectiveMode === "ast" ? "Bundled Tree-sitter AST" : "Fast parser"} on ${host} (${platform}).`,
    semanticHints.length ? semanticHints.join(", ") + "." : undefined,
    degradedReason,
  ].filter(Boolean).join(" ")

  return {
    requestedMode,
    effectiveMode,
    host,
    platform,
    bundledAstAvailable,
    compileCommandsPath,
    compileFlagsPath,
    clangdPath,
    scipClangPath,
    degradedReason,
    detail,
  }
}

async function findCompileCommands(root: vscode.WorkspaceFolder, configuredPath: string) {
  if (configuredPath) {
    const absolute = isAbsolute(configuredPath) ? configuredPath : resolve(root.uri.fsPath, configuredPath)
    return (await exists(absolute)) ? absolute : undefined
  }
  for (const candidate of [
    join(root.uri.fsPath, "compile_commands.json"),
    join(root.uri.fsPath, "build", "compile_commands.json"),
  ]) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

async function findCompileFlags(root: vscode.WorkspaceFolder) {
  const candidate = join(root.uri.fsPath, "compile_flags.txt")
  return (await exists(candidate)) ? candidate : undefined
}

async function findExecutable(configuredPath: string, names: string[]) {
  if (configuredPath) return (await exists(configuredPath)) ? configuredPath : undefined
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const dir of paths) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
