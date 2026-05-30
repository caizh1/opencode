import * as cp from "node:child_process"
import * as vscode from "vscode"
import type { CodeGraphContextProvider } from "./codegraph-types"
import type { TrackedEditorContext } from "./editor-context"
import type { ChatContextOptions, RemoteSettings } from "./types"

type FileContext = {
  uri: vscode.Uri
  text: string
  path: string
  language: string
  startLine: number
  endLine: number
  truncated: boolean
  reason?: string
}

export type ContextSummaryItem = {
  path: string
  source: string
  truncated: boolean
  skipped: boolean
}

type ResolvedEditorContext = {
  document: vscode.TextDocument
  selection: vscode.Selection
  position: vscode.Position
}

export class MissingLocalContextError extends Error {
  constructor() {
    super("No local VS Code file context was captured. Open the file in VS Code or reference it with @file before asking this question.")
    this.name = "MissingLocalContextError"
  }
}

export class LocalContextStore {
  private readonly files = new Map<string, vscode.Uri>()

  add(uri: vscode.Uri) {
    this.files.set(uri.toString(), uri)
  }

  clear() {
    this.files.clear()
  }

  list() {
    return [...this.files.values()]
  }

  labels() {
    return this.list().map((uri) => relativePath(uri))
  }
}

export async function buildChatPrompt(input: {
  question: string
  options: ChatContextOptions
  settings: RemoteSettings
  contextStore: LocalContextStore
  mentionedFiles?: vscode.Uri[]
  editorContext?: TrackedEditorContext
  codeGraph?: CodeGraphContextProvider
  onContextSummary?: (items: ContextSummaryItem[]) => void
}) {
  const chunks: string[] = [
    `User question:\n${input.question.trim()}`,
  ]
  const context = await buildLocalContext(
    input.options,
    input.settings,
    input.contextStore,
    input.mentionedFiles ?? [],
    input.editorContext,
  )
  input.onContextSummary?.(context.summary)
  const relatedPaths = context.summary.filter((item) => !item.skipped).map((item) => item.path)
  const codeGraph = input.settings.codeGraph.enabled
    ? await input.codeGraph?.buildContext({
        question: input.question,
        relatedPaths,
        maxBytes: input.settings.codeGraph.maxContextBytes,
      })
    : undefined

  if (input.settings.context.localOnlyMode) chunks.push(localContextContract())

  const hasLocalContext = hasUsableFileContext(context.summary) || Boolean(codeGraph?.text)

  if (input.settings.context.localOnlyMode && looksLikeLocalFileQuestion(input.question) && !hasLocalContext) {
    throw new MissingLocalContextError()
  }

  if (looksLikeLocalFilesystemPath(input.question) && !hasLocalContext) {
    chunks.push("Local file context warning:\nNo local file content was captured for the path in the question. Ask the user to open or @mention the file instead of reading the remote server filesystem.")
  }
  if (context.text) chunks.push(`Local workspace context:\n${context.text}`)
  if (codeGraph?.text) chunks.push(`Local code graph context:\n${codeGraph.text}`)
  return chunks.join("\n\n")
}

export async function addActiveFileToContext(store: LocalContextStore) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return false
  if (editor.document.uri.scheme !== "file") return false
  store.add(editor.document.uri)
  return true
}

export async function addPickedFilesToContext(store: LocalContextStore) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Add to OpenCode context",
  })
  if (!picked) return 0
  for (const uri of picked) store.add(uri)
  return picked.length
}

export async function buildCompletionPrompt(input: {
  document: vscode.TextDocument
  position: vscode.Position
  settings: RemoteSettings
}) {
  const before = Math.max(0, input.position.line - 80)
  const after = Math.min(input.document.lineCount - 1, input.position.line + 60)
  const prefix = input.document.getText(new vscode.Range(before, 0, input.position.line, input.position.character))
  const suffix = input.document.getText(
    new vscode.Range(input.position.line, input.position.character, after, input.document.lineAt(after).text.length),
  )
  const diagnostics = diagnosticsForUri(input.document.uri, 8)
  return [
    "You are an inline code completion engine.",
    "Return only the exact text to insert at the cursor. Do not use Markdown. Do not explain.",
    "Preserve required leading newlines and indentation. If the cursor is after a block-opening line, begin with a newline and the correct next-line indentation.",
    completionLanguageRules(input.document.languageId),
    "",
    `<file path="${relativePath(input.document.uri)}" language="${input.document.languageId}">`,
    "<prefix>",
    limitText(prefix, input.settings.context.maxFileBytes).text,
    "</prefix>",
    "<suffix>",
    limitText(suffix, Math.floor(input.settings.context.maxFileBytes / 2)).text,
    "</suffix>",
    "</file>",
    diagnostics ? `<diagnostics>\n${diagnostics}\n</diagnostics>` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function completionLanguageRules(languageId: string) {
  switch (languageId) {
    case "c":
    case "cpp":
      return "Language rule: this is C/C++; do not use Python-style colon blocks. Use braces for functions and control blocks. Return real code, not placeholders like condition."
    case "javascript":
    case "javascriptreact":
    case "typescript":
    case "typescriptreact":
    case "java":
    case "go":
    case "rust":
    case "csharp":
      return "Language rule: use brace-delimited blocks for functions and control flow. Return real code, not placeholders like condition."
    case "python":
      return "Language rule: preserve Python colon blocks and indentation. Return real code, not placeholders like condition."
    default:
      return "Language rule: follow the file language syntax exactly. Return real code, not placeholders."
  }
}

async function buildLocalContext(
  options: ChatContextOptions,
  settings: RemoteSettings,
  contextStore: LocalContextStore,
  mentionedFiles: vscode.Uri[],
  trackedEditorContext?: TrackedEditorContext,
) {
  const chunks: string[] = [workspaceInfo()]
  const seen = new Set<string>()
  const files: FileContext[] = []
  const active = await resolveEditorContext(trackedEditorContext)

  if (options.includeSelection && active && !active.selection.isEmpty) {
    const ctx = selectionContext(active.document, active.selection, settings)
    if (ctx) {
      files.push(ctx)
      seen.add(active.document.uri.toString())
    }
  }

  if (options.includeCurrentFile && active && !seen.has(active.document.uri.toString())) {
    const ctx = currentFileContext(active.document, active.position, settings)
    if (ctx) {
      files.push(ctx)
      seen.add(active.document.uri.toString())
    }
  }

  for (const uri of mentionedFiles) {
    if (files.length >= settings.context.maxFiles) break
    if (seen.has(uri.toString())) continue
    files.push(await fileContext(uri, settings, "mentioned file"))
    seen.add(uri.toString())
  }

  for (const uri of contextStore.list()) {
    if (files.length >= settings.context.maxFiles) break
    if (seen.has(uri.toString())) continue
    files.push(await fileContext(uri, settings, "attached file"))
    seen.add(uri.toString())
  }

  if (options.includeOpenFiles) {
    for (const document of vscode.workspace.textDocuments) {
      if (files.length >= settings.context.maxFiles) break
      if (document.uri.scheme !== "file" || seen.has(document.uri.toString())) continue
      const ctx = documentContext(document, settings, "open file")
      if (ctx) {
        files.push(ctx)
        seen.add(document.uri.toString())
      }
    }
  }

  for (const file of files.slice(0, settings.context.maxFiles)) {
    chunks.push(formatFileContext(file))
  }

  if (options.includeDiagnostics) {
    const diagnostics = diagnosticsForWorkspace(60)
    if (diagnostics) chunks.push(`<diagnostics>\n${diagnostics}\n</diagnostics>`)
  }

  if (options.includeGitDiff) {
    const diff = await gitDiff(settings.context.maxFileBytes * 2)
    if (diff) chunks.push(`<git-diff>\n${diff}\n</git-diff>`)
  }

  const included = files.slice(0, settings.context.maxFiles)
  return {
    text: chunks.filter(Boolean).join("\n\n"),
    summary: included.map((file) => ({
      path: file.path,
      source: file.reason ?? "file",
      truncated: file.truncated,
      skipped: file.reason === "skipped",
    })),
  }
}

function workspaceInfo() {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) return "<workspace>No workspace folder is open.</workspace>"
  const rows = folders.map((folder) => `- ${folder.name}`).join("\n")
  return `<workspace>\n${rows}\n</workspace>`
}

function localContextContract() {
  return [
    "Local Context Contract:",
    "The following files are local VS Code context supplied by the extension.",
    "Use only the supplied <file>, <diagnostics>, <git-diff>, and <local-code-graph> blocks when answering questions about local code.",
    "Do not read, glob, grep, list, edit, or run shell commands against the remote OpenCode server filesystem to answer local VS Code questions.",
    "If the needed local file content is missing, ask the user to open the file in VS Code or reference it with @file.",
  ].join("\n")
}

function selectionContext(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  settings: RemoteSettings,
): FileContext | undefined {
  if (document.uri.scheme !== "file") return
  const safeSelection = normalizeSelection(clampSelection(selection, document))
  const selected = document.getText(safeSelection)
  const limited = limitText(selected, settings.context.maxFileBytes)
  return {
    uri: document.uri,
    text: limited.text,
    path: relativePath(document.uri),
    language: document.languageId,
    startLine: safeSelection.start.line + 1,
    endLine: safeSelection.end.line + 1,
    truncated: limited.truncated,
    reason: "selection",
  }
}

function currentFileContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  settings: RemoteSettings,
): FileContext | undefined {
  return documentContext(document, settings, "current file", clampPosition(position, document))
}

function documentContext(
  document: vscode.TextDocument,
  settings: RemoteSettings,
  reason: string,
  position?: vscode.Position,
): FileContext | undefined {
  if (document.uri.scheme !== "file") return
  const full = document.getText()
  const max = settings.context.maxFileBytes
  if (byteLength(full) <= max) {
    return {
      uri: document.uri,
      text: full,
      path: relativePath(document.uri),
      language: document.languageId,
      startLine: 1,
      endLine: document.lineCount,
      truncated: false,
      reason,
    }
  }

  const activeLine = position?.line ?? 0
  const start = Math.max(0, activeLine - 80)
  const end = Math.min(document.lineCount - 1, activeLine + 80)
  const windowText = document.getText(new vscode.Range(start, 0, end, document.lineAt(end).text.length))
  const header = collectHeader(document)
  const combined = [header ? `<file-header>\n${header}\n</file-header>` : "", windowText].filter(Boolean).join("\n\n")
  const limited = limitText(combined, max)
  return {
    uri: document.uri,
    text: limited.text,
    path: relativePath(document.uri),
    language: document.languageId,
    startLine: start + 1,
    endLine: end + 1,
    truncated: true,
    reason,
  }
}

async function fileContext(uri: vscode.Uri, settings: RemoteSettings, reason = "added file"): Promise<FileContext> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open) return documentContext(open, settings, reason) ?? skippedFile(uri, "unsupported document")

  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (looksBinary(bytes)) return skippedFile(uri, "binary file skipped")
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const limited = limitText(text, settings.context.maxFileBytes)
    return {
      uri,
      text: limited.text,
      path: relativePath(uri),
      language: languageFromPath(uri.fsPath),
      startLine: 1,
      endLine: limited.text.split(/\r?\n/).length,
      truncated: limited.truncated,
      reason,
    }
  } catch (error) {
    return skippedFile(uri, error instanceof Error ? error.message : String(error))
  }
}

function skippedFile(uri: vscode.Uri, reason: string): FileContext {
  return {
    uri,
    text: `[${reason}]`,
    path: relativePath(uri),
    language: languageFromPath(uri.fsPath),
    startLine: 1,
    endLine: 1,
    truncated: false,
    reason: "skipped",
  }
}

function formatFileContext(file: FileContext) {
  const attrs = [
    `path="${xmlAttr(file.path)}"`,
    `language="${xmlAttr(file.language)}"`,
    `lines="${file.startLine}-${file.endLine}"`,
    file.reason ? `source="${xmlAttr(file.reason)}"` : "",
    file.truncated ? `truncated="true"` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return `<file ${attrs}>\n${file.text}${file.truncated ? "\n[truncated]" : ""}\n</file>`
}

function diagnosticsForWorkspace(limit: number) {
  const rows: string[] = []
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (rows.length >= limit) break
    if (!isInWorkspace(uri)) continue
    for (const diagnostic of diagnostics) {
      if (rows.length >= limit) break
      rows.push(formatDiagnostic(uri, diagnostic))
    }
  }
  return rows.join("\n")
}

function diagnosticsForUri(uri: vscode.Uri, limit: number) {
  return vscode.languages
    .getDiagnostics(uri)
    .slice(0, limit)
    .map((diagnostic) => formatDiagnostic(uri, diagnostic))
    .join("\n")
}

function formatDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic) {
  const line = diagnostic.range.start.line + 1
  const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? "Unknown"
  return `${relativePath(uri)}:${line} ${severity}: ${diagnostic.message}`
}

function gitDiff(maxBytes: number) {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return Promise.resolve("")
  return new Promise<string>((resolve) => {
    cp.execFile(
      "git",
      ["diff", "--"],
      {
        cwd: folder.uri.fsPath,
        timeout: 5000,
        maxBuffer: maxBytes * 2,
      },
      (error, stdout) => {
        if (error && !stdout) {
          resolve("")
          return
        }
        resolve(limitText(stdout, maxBytes).text)
      },
    )
  })
}

export function relativePath(uri: vscode.Uri) {
  if (uri.scheme !== "file") return uri.toString()
  return vscode.workspace.asRelativePath(uri, false)
}

async function resolveEditorContext(tracked: TrackedEditorContext | undefined): Promise<ResolvedEditorContext | undefined> {
  if (tracked?.uri.scheme === "file") {
    const document = await documentForUri(tracked.uri)
    if (document) {
      return {
        document,
        selection: tracked.selection,
        position: tracked.position,
      }
    }
  }

  const active = vscode.window.activeTextEditor
  if (active?.document.uri.scheme === "file") {
    return {
      document: active.document,
      selection: active.selection,
      position: active.selection.active,
    }
  }

  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "file")
  if (visible) {
    return {
      document: visible.document,
      selection: visible.selection,
      position: visible.selection.active,
    }
  }

  return undefined
}

async function documentForUri(uri: vscode.Uri) {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open) return open
  try {
    return await vscode.workspace.openTextDocument(uri)
  } catch {
    return undefined
  }
}

function normalizeSelection(selection: vscode.Selection) {
  if (!selection.isReversed) return selection
  return new vscode.Selection(selection.end, selection.start)
}

function clampSelection(selection: vscode.Selection, document: vscode.TextDocument) {
  return new vscode.Selection(clampPosition(selection.anchor, document), clampPosition(selection.active, document))
}

function clampPosition(position: vscode.Position, document: vscode.TextDocument) {
  const line = Math.max(0, Math.min(position.line, document.lineCount - 1))
  const character = Math.max(0, Math.min(position.character, document.lineAt(line).text.length))
  return new vscode.Position(line, character)
}

function collectHeader(document: vscode.TextDocument) {
  const rows: string[] = []
  const max = Math.min(100, document.lineCount)
  const pattern = /^\s*(import|export|from|require|using|package|namespace|#include)\b/
  for (let i = 0; i < max; i++) {
    const text = document.lineAt(i).text
    if (pattern.test(text)) rows.push(text)
    if (rows.length >= 40) break
  }
  return rows.join("\n")
}

function limitText(text: string, maxBytes: number) {
  if (byteLength(text) <= maxBytes) return { text, truncated: false }
  let result = ""
  let used = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return { text: result, truncated: true }
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function looksBinary(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  const sample = bytes.slice(0, Math.min(bytes.length, 4096))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length > 0.3
}

function languageFromPath(path: string) {
  const ext = path.toLowerCase().split(".").pop()
  switch (ext) {
    case "ts":
      return "typescript"
    case "tsx":
      return "typescriptreact"
    case "js":
      return "javascript"
    case "jsx":
      return "javascriptreact"
    case "py":
      return "python"
    case "go":
      return "go"
    case "rs":
      return "rust"
    case "java":
      return "java"
    case "cs":
      return "csharp"
    case "cpp":
    case "cc":
    case "cxx":
      return "cpp"
    case "c":
      return "c"
    default:
      return ext || "text"
  }
}

function isInWorkspace(uri: vscode.Uri) {
  return Boolean(vscode.workspace.getWorkspaceFolder(uri))
}

function xmlAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function looksLikeLocalFilesystemPath(input: string) {
  return /[A-Za-z]:[\\/][^\s]+/.test(input) || /(^|\s)\/(?:Users|home|workspace|mnt)\/[^\s]+/.test(input)
}

function hasUsableFileContext(summary: ContextSummaryItem[]) {
  return summary.some((item) => !item.skipped)
}

function looksLikeLocalFileQuestion(input: string) {
  const text = input.toLowerCase()
  if (looksLikeLocalFilesystemPath(input)) return true
  if (/\b[\w.-]+\.(c|cc|cpp|cxx|h|hpp|ts|tsx|js|jsx|py|go|rs|java|cs|json|yaml|yml|md|sql)\b/i.test(input)) {
    return true
  }
  return (
    /当前文件|这个文件|该文件|解释.*文件|分析.*文件|看.*文件|这段代码|这份代码/.test(input) ||
    /\b(current file|this file|selected code|this code|explain this|explain the file|analy[sz]e this file)\b/.test(text)
  )
}
