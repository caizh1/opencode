import path from "node:path"
import type * as vscode from "vscode"

export type CommentSyntax = "c-style" | "hash-line"

export const SUPPORTED_COMMENT_LANGUAGE_IDS = new Set([
  "c",
  "cpp",
  "cuda-cpp",
  "objective-c",
  "objective-cpp",
  "shellscript",
  "makefile",
  "yaml",
])

export const SUPPORTED_CURRENT_FUNCTION_COMMENT_LANGUAGE_IDS = new Set([
  "c",
  "cpp",
  "cuda-cpp",
  "objective-c",
  "objective-cpp",
  "shellscript",
  "makefile",
])

export const COMMENT_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: "c" },
  { language: "cpp" },
  { language: "cuda-cpp" },
  { language: "objective-c" },
  { language: "objective-cpp" },
  { language: "shellscript" },
  { language: "makefile" },
  { language: "yaml" },
]

export function isSupportedCommentLanguage(languageId: string) {
  return SUPPORTED_COMMENT_LANGUAGE_IDS.has(languageId)
}

export function isSupportedCurrentFunctionCommentLanguage(languageId: string) {
  return SUPPORTED_CURRENT_FUNCTION_COMMENT_LANGUAGE_IDS.has(languageId)
}

export function commentSyntaxForLanguage(languageId: string): CommentSyntax {
  return isHashCommentLanguage(languageId) ? "hash-line" : "c-style"
}

export function isHashCommentLanguage(languageId: string) {
  return languageId === "shellscript" || languageId === "makefile" || languageId === "yaml"
}

export function commentLanguageLabel(languageId: string) {
  switch (languageId) {
    case "shellscript":
      return "Shell"
    case "makefile":
      return "Makefile"
    case "yaml":
      return "YAML"
    case "cuda-cpp":
      return "CUDA C++"
    case "objective-c":
      return "Objective-C"
    case "objective-cpp":
      return "Objective-C++"
    case "c":
      return "C"
    case "cpp":
    default:
      return "C/C++"
  }
}

export function commentCodeblockLanguage(languageId: string) {
  switch (languageId) {
    case "shellscript":
      return "shellscript"
    case "makefile":
      return "makefile"
    case "yaml":
      return "yaml"
    default:
      return "c"
  }
}

export function supportedCommentSelectionLanguageText() {
  return "C/C++、Shell、Makefile 和 YAML"
}

export function supportedCommentCurrentFunctionLanguageText() {
  return "C/C++、Shell 和 Makefile"
}

export function commentWorkspaceLanguageIdForPath(relativePath: string) {
  const extension = path.extname(relativePath).toLowerCase()
  if (extension === ".c") return "c"
  if ([".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++"].includes(extension)) return "cpp"
  if (extension === ".h") return "cpp"
  if (extension === ".cu" || extension === ".cuh") return "cuda-cpp"
  if (extension === ".m") return "objective-c"
  if (extension === ".mm") return "objective-cpp"
  if ([".sh", ".bash", ".zsh", ".ksh"].includes(extension)) return "shellscript"
  if (extension === ".mk") return "makefile"
  if (extension === ".yml" || extension === ".yaml") return "yaml"
  const basename = path.basename(relativePath)
  if (basename === "Makefile" || basename === "makefile" || basename === "GNUmakefile") return "makefile"
  return undefined
}
