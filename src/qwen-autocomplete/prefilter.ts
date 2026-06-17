import path from "node:path"
import os from "node:os"
import * as vscode from "vscode"

const EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"])
const HEADER_EXTENSIONS = new Set([".h", ".hpp"])
const NON_CODE_LANGUAGE_IDS = new Set(["markdown", "json", "jsonc", "log", "txt"])

export type QwenPrefilterReason =
  | "none"
  | "empty-document"
  | "empty-untitled"
  | "non-file-scheme"
  | "unsupported-extension"
  | "unsupported-language"
  | "plaintext-non-header"
  | "continue-config"

export type QwenPrefilterDecision = {
  extension: string
  languageId: string
  prefiltered: boolean
  reason: QwenPrefilterReason
}

export const QWEN_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", language: "c" },
  { scheme: "file", language: "cpp" },
  { scheme: "file", pattern: "**/*.c" },
  { scheme: "file", pattern: "**/*.cc" },
  { scheme: "file", pattern: "**/*.cpp" },
  { scheme: "file", pattern: "**/*.cxx" },
  { scheme: "file", pattern: "**/*.h" },
  { scheme: "file", pattern: "**/*.hpp" },
]

export function isQwenSupportedDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file") return false
  const ext = path.extname(document.uri.fsPath).toLowerCase()
  if (!EXTENSIONS.has(ext)) return false
  if (NON_CODE_LANGUAGE_IDS.has(document.languageId)) return false
  if (document.languageId === "plaintext" && !HEADER_EXTENSIONS.has(ext)) return false
  return true
}

export function shouldPrefilterQwenDocument(document: vscode.TextDocument): boolean {
  return decideQwenPrefilter(document).prefiltered
}

export function decideQwenPrefilter(document: vscode.TextDocument): QwenPrefilterDecision {
  const ext = path.extname(document.uri.fsPath || document.uri.path).toLowerCase()
  const reason = prefilterReason(document, ext)
  return {
    extension: ext,
    languageId: document.languageId,
    prefiltered: reason !== "none",
    reason,
  }
}

function prefilterReason(document: vscode.TextDocument, ext: string): QwenPrefilterReason {
  if (isContinueConfigJson(document)) return "continue-config"
  if (document.uri.scheme !== "file") {
    if (document.uri.scheme === "untitled" && empty(document)) return "empty-untitled"
    return "non-file-scheme"
  }
  if (empty(document)) return "empty-document"
  if (!EXTENSIONS.has(ext)) return "unsupported-extension"
  if (NON_CODE_LANGUAGE_IDS.has(document.languageId)) return "unsupported-language"
  if (document.languageId === "plaintext" && !HEADER_EXTENSIONS.has(ext)) return "plaintext-non-header"
  return "none"
}

function isContinueConfigJson(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file") return false
  return path.resolve(document.uri.fsPath) === continueConfigJsonPath()
}

function continueConfigJsonPath(): string {
  const dir = process.env.CONTINUE_GLOBAL_DIR
  const root = dir ? path.resolve(dir) : path.join(os.homedir(), ".continue")
  return path.resolve(root, "config.json")
}

function empty(document: vscode.TextDocument): boolean {
  const count = document.lineCount
  if (count <= 0) return true
  return count === 1 && document.lineAt(0).text.trim() === ""
}
