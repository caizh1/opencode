import * as cp from "node:child_process"
import * as vscode from "vscode"
import type { QueryEvidenceResult } from "./analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidenceRetrievalMode } from "./codegraph-types"
import type { TrackedEditorContext } from "./editor-context"
import {
  formatInstructionContext,
  formatRepoContext,
  packCompletionContext,
  type CompletionOpenTabContext,
  type CompletionContextPack,
} from "./completion-context"
import { parseSupportedDocument } from "./document-parser"
import type { DocumentRagContextProvider, DocumentRagQueryResult } from "./document-rag"
import { isMentionIndexExcludedPath } from "./mention-index"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"
import type { ChatContextOptions, EvidenceLedgerEntry, RagStatus, RemoteSettings } from "./types"

const CHAT_RAG_LATENCY_BUDGET_MS = 2000
const CHAT_DOCUMENT_RAG_LATENCY_BUDGET_MS = 1000
const FOLDER_CONTEXT_SCAN_LIMIT = 20000

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

export type LocalContextFileItem = {
  id: string
  kind: "file"
  uri: vscode.Uri
  lifetime: LocalContextLifetime
}

export type LocalContextSelectionItem = {
  id: string
  kind: "selection"
  uri: vscode.Uri
  languageId: string
  startLine: number
  endLine: number
  text: string
  truncated: boolean
  lifetime: LocalContextLifetime
}

export type LocalContextLifetime = "one-shot" | "persistent"
export type LocalContextItem = LocalContextFileItem | LocalContextSelectionItem

export type LocalContextViewItem = {
  id: string
  kind: LocalContextItem["kind"]
  lifetime: LocalContextLifetime
  path: string
  label: string
  startLine?: number
  endLine?: number
  inlinePreview?: string
  preview?: string
  truncated?: boolean
}

export type ContextSummaryItem = {
  path: string
  source: string
  truncated: boolean
  skipped: boolean
}

export type MentionedContextRef = {
  uri: vscode.Uri
  type?: "file" | "folder"
  label?: string
  insertText?: string
}

type ResolvedEditorContext = {
  document: vscode.TextDocument
  selection: vscode.Selection
  position: vscode.Position
}

type ChatRetrievalOptions = {
  retrievalMode: CodeGraphEvidenceRetrievalMode
  latencyBudgetMs?: number
}

export type BuildChatPromptInput = {
  question: string
  options: ChatContextOptions
  settings: RemoteSettings
  contextStore: LocalContextStore
  contextItems?: LocalContextItem[]
  mentionedFiles?: vscode.Uri[]
  mentionedContext?: MentionedContextRef[]
  editorContext?: TrackedEditorContext
  codeGraph?: CodeGraphContextProvider
  documentRag?: DocumentRagContextProvider
  onContextSummary?: (items: ContextSummaryItem[]) => void
}

export type BuildChatPromptResult = {
  prompt: string
  evidenceLedgerInput: EvidenceLedgerEntry[]
  contextSummary: ContextSummaryItem[]
}

export class MissingLocalContextError extends Error {
  constructor() {
    super("No local VS Code file context was captured. Open the file in VS Code or reference it with @file before asking this question.")
    this.name = "MissingLocalContextError"
  }
}

function fileContextItemId(uri: vscode.Uri) {
  return `file:${uri.toString()}`
}

function selectionContextItemId(uri: vscode.Uri, startLine: number, endLine: number, text: string) {
  return `selection:${uri.toString()}:${startLine}:${endLine}:${stableTextHash(text)}`
}

function localContextItemLabel(item: LocalContextItem) {
  const path = relativePath(item.uri)
  if (item.kind === "selection") return `Selection: ${path}:${item.startLine}-${item.endLine}`
  return `File: ${path}`
}

function localContextViewItem(item: LocalContextItem): LocalContextViewItem {
  const path = relativePath(item.uri)
  const label = basename(path)
  if (item.kind === "selection") {
    return {
      id: item.id,
      kind: item.kind,
      lifetime: item.lifetime,
      path,
      label,
      startLine: item.startLine,
      endLine: item.endLine,
      inlinePreview: selectionInlinePreview(item.text),
      preview: selectionDetailPreview(item.text),
      truncated: item.truncated,
    }
  }
  return {
    id: item.id,
    kind: item.kind,
    lifetime: item.lifetime,
    path,
    label,
  }
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function selectionInlinePreview(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 120) ?? ""
}

function selectionDetailPreview(text: string) {
  const preview = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, 20)
    .join("\n")
  return limitPreviewBytes(preview, 2048)
}

function limitPreviewBytes(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let result = ""
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return result
}

function stableTextHash(text: string) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export class LocalContextStore {
  private readonly contextItems = new Map<string, LocalContextItem>()

  add(uri: vscode.Uri, lifetime: LocalContextLifetime = "one-shot") {
    return this.addFile(uri, lifetime)
  }

  addFile(uri: vscode.Uri, lifetime: LocalContextLifetime = "one-shot") {
    const item: LocalContextFileItem = {
      id: fileContextItemId(uri),
      kind: "file",
      uri,
      lifetime,
    }
    this.contextItems.set(item.id, item)
    return item
  }

  addSelection(input: {
    uri: vscode.Uri
    languageId: string
    startLine: number
    endLine: number
    text: string
    truncated: boolean
    lifetime?: LocalContextLifetime
  }) {
    const item: LocalContextSelectionItem = {
      id: selectionContextItemId(input.uri, input.startLine, input.endLine, input.text),
      kind: "selection",
      uri: input.uri,
      languageId: input.languageId,
      startLine: input.startLine,
      endLine: input.endLine,
      text: input.text,
      truncated: input.truncated,
      lifetime: input.lifetime ?? "one-shot",
    }
    this.contextItems.set(item.id, item)
    return item
  }

  clear() {
    this.contextItems.clear()
  }

  remove(id: string) {
    return this.contextItems.delete(id)
  }

  item(id: string) {
    return this.contextItems.get(id)
  }

  list() {
    return [...this.contextItems.values()]
  }

  snapshot() {
    return this.list().map(copyLocalContextItem)
  }

  setLifetime(id: string, lifetime: LocalContextLifetime) {
    const item = this.contextItems.get(id)
    if (!item) return undefined
    const next = { ...item, lifetime } as LocalContextItem
    this.contextItems.set(id, next)
    return next
  }

  restore(items: LocalContextItem[]) {
    for (const item of items) this.contextItems.set(item.id, copyLocalContextItem(item))
  }

  consumeOneShot(items: LocalContextItem[]) {
    let removed = 0
    for (const item of items) {
      if (item.lifetime !== "one-shot") continue
      const current = this.contextItems.get(item.id)
      if (!current || current.lifetime !== "one-shot") continue
      if (this.contextItems.delete(item.id)) removed += 1
    }
    return removed
  }

  labels() {
    return this.list().map((item) => localContextItemLabel(item))
  }

  viewItems() {
    return this.list().map((item) => localContextViewItem(item))
  }
}

function copyLocalContextItem(item: LocalContextItem): LocalContextItem {
  return { ...item }
}

export async function buildChatPrompt(input: BuildChatPromptInput) {
  return (await buildChatPromptWithEvidence(input)).prompt
}

export async function buildChatPromptWithEvidence(input: BuildChatPromptInput): Promise<BuildChatPromptResult> {
  const chunks: string[] = [
    `User question:\n${input.question.trim()}`,
  ]
  const context = await buildLocalContext(
    input.options,
    input.settings,
    input.contextItems ?? input.contextStore.list(),
    input.mentionedContext ?? (input.mentionedFiles ?? []).map((uri) => ({ uri, type: "file" as const })),
    input.editorContext,
  )
  input.onContextSummary?.(context.summary)
  const relatedPaths = context.summary.filter((item) => !item.skipped).map((item) => item.path)
  const retrievalOptions = input.settings.codeGraph.enabled
    ? chatRetrievalOptions(input.codeGraph)
    : { retrievalMode: "graph-only" as const }
  const codeGraph = input.settings.codeGraph.enabled
    ? await input.codeGraph?.buildContext({
        question: input.question,
        relatedPaths,
        maxBytes: input.settings.codeGraph.maxEvidenceBytes,
        maxDepth: input.settings.codeGraph.maxGraphDepth,
        maxFanout: input.settings.codeGraph.maxFanout,
        ...retrievalOptions,
      })
    : undefined
  const analysisEvidence = input.settings.codeGraph.enabled ? await retrieveChatAnalysisEvidence({
    question: input.question,
    settings: input.settings,
    codeGraph: input.codeGraph,
    relatedPaths,
    editorContext: input.editorContext,
    retrievalOptions,
  }) : undefined
  const documentEvidence = await retrieveDocumentRagEvidence({
    question: input.question,
    settings: input.settings,
    documentRag: input.documentRag,
  })

  if (input.settings.context.localOnlyMode) chunks.push(localContextContract(input.settings.tools.enabled))
  chunks.push(drawioDiagramOutputGuidance(input.settings.tools.enabled))

  const hasLocalContext = hasUsableFileContext(context.summary) || Boolean(codeGraph?.text) || Boolean(analysisEvidence?.evidencePack.evidence.length) || Boolean(documentEvidence?.text)

  if (input.settings.context.localOnlyMode && looksLikeLocalFileQuestion(input.question) && !hasLocalContext) {
    throw new MissingLocalContextError()
  }

  if (looksLikeLocalFilesystemPath(input.question) && !hasLocalContext) {
    chunks.push("Local file context warning:\nNo local file content was captured for the path in the question. Ask the user to open or @mention the file instead of reading the remote server filesystem.")
  }
  if (context.text) chunks.push(`Local workspace context:\n${context.text}`)
  if (codeGraph?.text) chunks.push(`Local code graph evidence:\n${codeGraph.text}`)
  if (analysisEvidence) chunks.push(`Local analysis evidence pack:\n${formatAnalysisEvidence(analysisEvidence)}`)
  if (documentEvidence?.text) chunks.push(`Local document RAG evidence:\n${documentEvidence.text}`)
  return {
    prompt: chunks.join("\n\n"),
    evidenceLedgerInput: buildEvidenceLedgerInput({
      question: input.question,
      contextSummary: context.summary,
      codeGraph,
      analysisEvidence,
      documentEvidence,
    }),
    contextSummary: context.summary,
  }
}

async function retrieveDocumentRagEvidence(input: {
  question: string
  settings: RemoteSettings
  documentRag?: DocumentRagContextProvider
}): Promise<DocumentRagQueryResult | undefined> {
  if (!input.documentRag || !input.settings.documentRag.enabled) return undefined
  const status = input.documentRag.status()
  if (status.availability !== "ready" && status.availability !== "partial") return undefined
  try {
    return await input.documentRag.query(input.question, {
      topK: input.settings.documentRag.queryTopK,
      maxEvidenceBytes: input.settings.documentRag.maxEvidenceBytes,
      latencyBudgetMs: CHAT_DOCUMENT_RAG_LATENCY_BUDGET_MS,
    })
  } catch {
    return undefined
  }
}

function buildEvidenceLedgerInput(input: {
  question: string
  contextSummary: ContextSummaryItem[]
  codeGraph?: Awaited<ReturnType<CodeGraphContextProvider["buildContext"]>>
  analysisEvidence?: QueryEvidenceResult
  documentEvidence?: DocumentRagQueryResult
}): EvidenceLedgerEntry[] {
  const entries: EvidenceLedgerEntry[] = []
  for (const item of input.contextSummary) {
    if (item.skipped) continue
    const kind = /\bselection\b/i.test(item.source) ? "selection" : "file"
    entries.push({
      source: "local-context",
      kind,
      path: item.path,
      summary: compactEvidenceSummary(`${item.source} ${item.path} was included as current local workspace context.`),
      truncated: item.truncated,
      staleness: "current",
    })
  }
  if (input.codeGraph?.text) {
    entries.push({
      source: "codegraph",
      kind: "codegraph",
      symbol: input.codeGraph.symbols[0],
      query: input.question,
      summary: compactEvidenceSummary([
        `Local code graph evidence retrieved in ${input.codeGraph.mode} mode.`,
        `evidence=${input.codeGraph.metrics.evidenceCount}`,
        `candidates=${input.codeGraph.metrics.candidateCount}`,
        input.codeGraph.metrics.omittedCandidates ? `omitted=${input.codeGraph.metrics.omittedCandidates}` : "",
      ].filter(Boolean).join(" ")),
      truncated: input.codeGraph.truncated || input.codeGraph.metrics.truncated,
      staleness: "current",
    })
  }
  if (input.analysisEvidence) {
    entries.push({
      source: "analysis",
      kind: "analysis",
      query: input.question,
      summary: compactEvidenceSummary([
        "Local analysis evidence pack was retrieved for the current question.",
        `intent=${input.analysisEvidence.trace.intent}`,
        `packedBytes=${input.analysisEvidence.evidencePack.packedBytes}`,
        input.analysisEvidence.evidencePack.omittedEvidence ? `omitted=${input.analysisEvidence.evidencePack.omittedEvidence}` : "",
        input.analysisEvidence.answerPolicy?.confidence ? `confidence=${input.analysisEvidence.answerPolicy.confidence}` : "",
      ].filter(Boolean).join(" ")),
      truncated: input.analysisEvidence.evidencePack.truncated,
      staleness: "current",
    })
  }
  if (input.documentEvidence) {
    if (input.documentEvidence.hits.length === 0) {
      entries.push({
        source: "document-rag",
        kind: "document",
        query: input.question,
        summary: compactEvidenceSummary("Local document RAG returned evidence text for the current question."),
        truncated: false,
        staleness: "current",
      })
    }
    for (const hit of input.documentEvidence.hits.slice(0, 12)) {
      entries.push({
        source: "document-rag",
        kind: "document",
        path: hit.path,
        range: `${hit.startLine}-${hit.endLine}`,
        query: input.question,
        summary: compactEvidenceSummary(`Document RAG hit ${hit.path}:${hit.startLine}-${hit.endLine} score=${formatEvidenceScore(hit.score)}.`),
        truncated: false,
        staleness: "current",
      })
    }
  }
  return entries
}

function compactEvidenceSummary(input: string) {
  return limitPreviewBytes(input.replace(/\s+/g, " ").trim(), 300)
}

function formatEvidenceScore(score: number) {
  return Number.isFinite(score) ? score.toFixed(3) : "unknown"
}

async function retrieveChatAnalysisEvidence(input: {
  question: string
  settings: RemoteSettings
  codeGraph?: CodeGraphContextProvider
  relatedPaths: string[]
  editorContext?: TrackedEditorContext
  retrievalOptions: ChatRetrievalOptions
}): Promise<QueryEvidenceResult | undefined> {
  if (!input.codeGraph) return undefined
  const currentFile = input.editorContext?.uri ? relativePath(input.editorContext.uri) : input.relatedPaths[0] ?? ""
  const relatedPaths = [...new Set([currentFile, ...input.relatedPaths].filter(Boolean))]
  return input.codeGraph.queryEvidence(input.question, {
    relatedPaths,
    maxEvidenceItems: input.settings.analysis.maxEvidenceItems,
    maxEvidenceBytes: input.settings.analysis.maxEvidenceBytes,
    ...input.retrievalOptions,
  })
}

function chatRetrievalOptions(codeGraph?: CodeGraphContextProvider): ChatRetrievalOptions {
  const retrievalMode = isChatRagReady(codeGraph?.status().rag) ? "hybrid" : "graph-only"
  return retrievalMode === "hybrid"
    ? { retrievalMode, latencyBudgetMs: CHAT_RAG_LATENCY_BUDGET_MS }
    : { retrievalMode }
}

function isChatRagReady(rag: RagStatus | undefined) {
  if (!rag) return false
  const pending = rag.pendingChunkCount ?? Math.max(0, rag.chunks - rag.embeddedChunks)
  return Boolean(
    rag.enabled &&
      rag.embeddingEnabled &&
      rag.availability === "ready" &&
      rag.indexAvailability === "ready" &&
      rag.chunks > 0 &&
      rag.embeddedChunks >= rag.chunks &&
      pending === 0,
  )
}

export async function addActiveFileToContext(store: LocalContextStore) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return false
  if (editor.document.uri.scheme !== "file") return false
  store.addFile(editor.document.uri, "persistent")
  return true
}

export async function addTrackedFileToContext(store: LocalContextStore, tracked?: TrackedEditorContext) {
  const active = await resolveEditorContext(tracked)
  if (!active) return undefined
  return store.addFile(active.document.uri, "persistent")
}

export async function addTrackedSelectionToContext(
  store: LocalContextStore,
  settings: RemoteSettings,
  tracked?: TrackedEditorContext,
) {
  const active = await resolveEditorContext(tracked)
  if (!active || active.selection.isEmpty) return undefined
  const ctx = selectionContext(active.document, active.selection, settings, "attached selection")
  if (!ctx) return undefined
  return store.addSelection({
    uri: ctx.uri,
    languageId: ctx.language,
    startLine: ctx.startLine,
    endLine: ctx.endLine,
    text: ctx.text,
    truncated: ctx.truncated,
    lifetime: "one-shot",
  })
}

export async function addPickedFilesToContext(store: LocalContextStore) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Add to ChipMate context",
  })
  if (!picked) return 0
  for (const uri of picked) store.addFile(uri, "persistent")
  return picked.length
}

export async function buildCompletionPrompt(input: {
  document: vscode.TextDocument
  position: vscode.Position
  settings: RemoteSettings
  transport?: "openai-compatible"
  plan?: CompletionPlan
  retrievedSnippets?: RetrievedCompletionSnippet[]
  analysisEvidenceText?: string
  onContextPack?: (pack: CompletionContextPack) => void
}) {
  const before = Math.max(0, input.position.line - 80)
  const after = Math.min(input.document.lineCount - 1, input.position.line + 60)
  const prefix = input.document.getText(new vscode.Range(before, 0, input.position.line, input.position.character))
  const suffix = input.document.getText(
    new vscode.Range(input.position.line, input.position.character, after, input.document.lineAt(after).text.length),
  )
  const path = relativePath(input.document.uri)
  const contextPack = input.plan
    ? packCompletionContext({
        plan: input.plan,
        languageId: input.document.languageId,
        currentPath: path,
        prefix,
        suffix,
        retrievedSnippets: input.retrievedSnippets ?? [],
        openTabs: completionOpenTabs(input.document.uri),
        analysisEvidenceText: input.analysisEvidenceText,
      })
    : undefined
  if (contextPack) input.onContextPack?.(contextPack)
  if (input.plan?.useInstruction) {
    return buildInstructionCompletionPrompt({
      plan: input.plan,
      path,
      languageId: input.document.languageId,
      prefix,
      suffix,
      contextPack: contextPack ?? emptyContextPack(),
      transport: input.transport,
    })
  }

  const diagnostics = diagnosticsForUri(input.document.uri, 8)
  const packedContext = contextPack ? formatRepoContext(contextPack) : ""
  return [
    "You are an inline code completion engine.",
    "Return only the exact text to insert at the cursor. Do not use Markdown. Do not explain.",
    "Preserve required leading newlines and indentation. If the cursor is after a block-opening line, begin with a newline and the correct next-line indentation.",
    "When completing a non-empty current line, do not begin with blank lines. If you cannot continue or replace the cursor context, return empty.",
    input.transport === "openai-compatible"
      ? "Direct model API contract: if you produce <think> reasoning, put all reasoning inside <think>...</think>; after </think>, output only the exact insertion text."
      : "",
    completionLanguageRules(input.document.languageId),
    packedContext,
    "",
    `<file path="${path}" language="${input.document.languageId}">`,
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

export function buildQwenCoderFimPrompt(input: {
  document: vscode.TextDocument
  position: vscode.Position
  settings: RemoteSettings
  plan?: CompletionPlan
  retrievedSnippets?: RetrievedCompletionSnippet[]
  analysisEvidenceText?: string
  onContextPack?: (pack: CompletionContextPack) => void
}) {
  const before = Math.max(0, input.position.line - 80)
  const after = Math.min(input.document.lineCount - 1, input.position.line + 60)
  const prefix = input.document.getText(new vscode.Range(before, 0, input.position.line, input.position.character))
  const suffix = input.document.getText(
    new vscode.Range(input.position.line, input.position.character, after, input.document.lineAt(after).text.length),
  )
  const path = relativePath(input.document.uri)
  const repoName = vscode.workspace.getWorkspaceFolder(input.document.uri)?.name || vscode.workspace.workspaceFolders?.[0]?.name || "workspace"
  const contextPack = input.plan
    ? packCompletionContext({
        plan: input.plan,
        languageId: input.document.languageId,
        currentPath: path,
        prefix,
        suffix,
        retrievedSnippets: input.retrievedSnippets ?? [],
        openTabs: completionOpenTabs(input.document.uri),
        analysisEvidenceText: input.analysisEvidenceText,
      })
    : undefined
  if (contextPack) input.onContextPack?.(contextPack)
  const contextBlock = contextPack ? formatRepoContext(contextPack) : completionContextBlock(input.retrievedSnippets ?? [], input.document.languageId)
  const intentBlock = completionFimIntentBlock({
    plan: input.plan,
    retrievedSnippets: input.retrievedSnippets ?? [],
    contextPack,
  })
  return [
    `<|repo_name|>${repoName}`,
    `<|file_sep|>${path}\n`,
    intentBlock,
    contextBlock,
    completionFimRulesBlock(input.document.languageId),
    `<|fim_prefix|>${limitText(prefix, input.settings.context.maxFileBytes).text}`,
    `<|fim_suffix|>${limitText(suffix, Math.floor(input.settings.context.maxFileBytes / 2)).text}`,
    "<|fim_middle|>",
  ].join("")
}

function completionFimIntentBlock(input: {
  plan?: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
  contextPack?: CompletionContextPack
}) {
  if (!input.plan?.cIntent) return ""
  const selected = input.contextPack?.selected.length ?? input.retrievedSnippets.length
  return [
    `// intent: ${input.plan.cIntent}`,
    input.plan.kind === "comment-guided-c-code" && input.plan.sourceComment
      ? `// source-comment: ${oneLine(input.plan.sourceComment).slice(0, 180)}`
      : "",
    `// retrieval: ${selected} context block(s) selected for this inline hole`,
    "// constraints: return only insertion text; preserve local style",
    "",
  ].filter((line) => line !== "").join("\n")
}

function buildInstructionCompletionPrompt(input: {
  plan: CompletionPlan
  path: string
  languageId: string
  prefix: string
  suffix: string
  contextPack: CompletionContextPack
  transport?: "openai-compatible"
}) {
  const task = input.plan.kind === "comment-to-test" || input.plan.kind === "natural-command"
    ? "Generate a unit test for the target symbol."
    : "Generate code for the user's current comment instruction."
  return [
    "You are generating code for a VS Code inline completion.",
    "",
    "Task:",
    task,
    "",
    ...instructionIntentPromptLines(input),
    "",
    "Rules:",
    "- Do not repeat the user's current line.",
    "- Do not output markdown.",
    "- Do not explain.",
    "- Output only code.",
    "- Use the target symbol and similar tests from context when they are relevant to the current task.",
    "- For test-code requests, use target symbol, similar tests, and test framework context to return real executable, declaration, or call code; do not return placeholder comments, empty blocks, or scaffold-only text.",
    input.transport === "openai-compatible"
      ? "- If you produce <think> reasoning, put all reasoning inside <think>...</think>; after </think>, output only the exact insertion text."
      : "",
    completionLanguageRules(input.languageId),
    "",
    formatInstructionContext(input.contextPack),
    "",
    `<file path="${input.path}" language="${input.languageId}">`,
    "<prefix>",
    input.prefix,
    "</prefix>",
    "<suffix>",
    input.suffix,
    "</suffix>",
    "</file>",
  ].filter(Boolean).join("\n")
}

function instructionIntentPromptLines(input: {
  plan: CompletionPlan
  languageId: string
  prefix: string
  suffix: string
}) {
  if (isCommentCodeInstructionPlan(input.plan)) {
    const sourceComment = input.plan.sourceComment ?? currentLinePrefix(input.prefix).trim()
    return [
      "Source comment:",
      sourceComment,
      "Current line prefix:",
      currentLinePrefix(input.prefix),
      "Insertion point:",
      "Insert the smallest useful code immediately after the source comment and before the suffix. Satisfy the comment using visible local variables, existing error variables, cleanup labels, and surrounding style.",
      "First suffix line:",
      firstNonEmptyLine(input.suffix) ?? "<none>",
      "Current function context:",
      currentFunctionContext(input.prefix, input.suffix),
      "Comment-to-code guidance:",
      "- Do not copy code from the suffix; generate only the missing code before it.",
      "- Do not return generic success code such as `return 0;` unless the source comment explicitly asks for that exact return.",
      "- For C/C++ cleanup or error-handling comments, prefer existing `ret`/error variables, nearby cleanup labels, visible helper calls, and the function's established return style.",
    ]
  }

  if (input.plan.kind !== "previous-comment-continuation") return []
  return [
    "Source comment:",
    input.plan.sourceComment ?? "",
    "Current line prefix:",
    currentLinePrefix(input.prefix),
  ]
}

function currentLinePrefix(prefix: string) {
  return prefix.replace(/\r\n/g, "\n").split("\n").at(-1) ?? ""
}

function isCommentCodeInstructionPlan(plan: CompletionPlan) {
  return plan.kind === "comment-to-code" ||
    (plan.kind === "previous-comment-continuation" && Boolean(plan.sourceComment) && !plan.needsTestRetrieval)
}

function firstNonEmptyLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n").find((line) => line.trim())?.trim()
}

function currentFunctionContext(prefix: string, suffix: string) {
  return [
    tailLines(prefix, 45).trimEnd(),
    "<cursor>",
    headLines(suffix, 35).trimStart(),
  ].filter(Boolean).join("\n")
}

function headLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(0, count).join("\n")
}

function tailLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(-count).join("\n")
}

function emptyContextPack(): CompletionContextPack {
  return {
    selected: [],
    dropped: [],
    tokenBudget: 0,
    tokenEstimate: 0,
  }
}

function completionContextBlock(snippets: RetrievedCompletionSnippet[], languageId: string) {
  if (snippets.length === 0) return ""
  const rows = snippets
    .slice(0, 12)
    .map((snippet) => `${snippet.kind}: ${snippet.path}:${snippet.line} ${snippet.name ? `${snippet.name} ` : ""}${oneLine(snippet.text)}`)
    .filter(Boolean)
  if (rows.length === 0) return ""

  if (supportsHashComments(languageId)) {
    return [
      "# Relevant project context for completion only.",
      ...rows.map((row) => `# ${row}`),
      "# End relevant project context.",
      "",
    ].join("\n")
  }

  return [
    "/* Relevant project context for completion only.",
    ...rows,
    "End relevant project context. */",
    "",
  ].join("\n")
}

function completionOpenTabs(currentUri: vscode.Uri): CompletionOpenTabContext[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === "file")
    .filter((document) => document.uri.toString() !== currentUri.toString())
    .slice(0, 6)
    .map((document) => ({
      path: relativePath(document.uri),
      languageId: document.languageId,
      text: document.getText(),
    }))
}

function oneLine(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 600)
}

function completionLanguageRules(languageId: string) {
  switch (languageId) {
    case "c":
    case "cpp":
      return [
        "Language rule: this is C/C++; do not use Python-style colon blocks. Use braces for functions and control blocks. Return real code, not placeholders like condition.",
        "If the cursor is inside an existing control-flow header such as `if (` before a suffix `)` or `) {`, return only the condition expression, not `if`, parentheses, or braces.",
        "If the cursor is inside an existing `for (` header before a suffix `)` or `) {`, return only the full loop header fields, not `for`, parentheses, or braces.",
        "For embedded/RTOS/protocol code, prefer symbols, macros, functions, and buffer bounds visible in current file, open tabs, or retrieved context; do not invent APIs.",
      ].join(" ")
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

function completionFimRulesBlock(languageId: string) {
  switch (languageId) {
    case "c":
    case "cpp":
      return [
        "/* Inline completion contract for C/C++.",
        "Return only the exact text for the cursor hole; no Markdown, prose, fences, or backticks.",
        "If the prefix ends inside `if (` and the suffix starts with `)` or `) {`, output only a valid condition expression.",
        "If the prefix ends inside `for (` and the suffix starts with `)` or `) {`, output only the loop header fields.",
        "Preserve existing suffix parentheses, braces, brackets, semicolons, and indentation.",
        "Use visible local variables, macros, functions, open-tab/header symbols, and retrieved context. Do not invent unknown embedded APIs or placeholder identifiers.",
        "For RTOS waits, queue/semaphore calls, protocol length/CRC guards, and buffer checks, prefer finite timeouts and explicit bounds using visible symbols.",
        "End inline completion contract. */\n",
      ].join("\n")
    default:
      return ""
  }
}

function supportsHashComments(languageId: string) {
  return new Set([
    "bash",
    "python",
    "shell",
    "shellscript",
    "sh",
    "zsh",
  ]).has(languageId)
}

async function buildLocalContext(
  options: ChatContextOptions,
  settings: RemoteSettings,
  contextItems: LocalContextItem[],
  mentionedContext: MentionedContextRef[],
  trackedEditorContext?: TrackedEditorContext,
) {
  const chunks: string[] = [workspaceInfo()]
  const seen = new Set<string>()
  const files: FileContext[] = []
  const active = await resolveEditorContext(trackedEditorContext)

  for (const item of contextItems) {
    if (files.length >= settings.context.maxFiles) break
    if (seen.has(item.uri.toString())) continue
    files.push(await contextForStoredItem(item, settings))
    seen.add(item.uri.toString())
  }

  for (const item of mentionedContext) {
    if (files.length >= settings.context.maxFiles) break
    if (item.type === "folder") {
      const expanded = await expandMentionedFolderContext(item, settings, seen, settings.context.maxFiles - files.length)
      files.push(...expanded)
      continue
    }
    const uri = item.uri
    if (seen.has(uri.toString())) continue
    files.push(await fileContext(uri, settings, "mentioned file"))
    seen.add(uri.toString())
  }

  if (options.includeSelection && active && !active.selection.isEmpty && !seen.has(active.document.uri.toString())) {
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

function localContextContract(toolsEnabled: boolean) {
  return [
    "Local Context Contract:",
    "The following files are local VS Code context supplied by the extension.",
    "Use only the supplied <file>, <diagnostics>, <git-diff>, and <local-code-graph> evidence blocks when answering questions about local code.",
    "Use supplied <local-document-rag> evidence for local Word, Excel, and PDF questions; if document evidence is missing or insufficient, say what is missing instead of guessing.",
    "Use the <local-analysis-pack> answer policy, query trace, summaries, state machines, and evidence refs when present.",
    "When local code graph evidence is present, cite paths and line ranges from the evidence; if evidence is insufficient, say what is missing instead of guessing.",
    toolsEnabled
      ? "ChipMate workspace evidence tools may be available for targeted gap searches and drill-down reads; chipmate_validate_diagram_ir validates evidence-backed DiagramIR and chipmate_create_drawio_diagram may generate deterministic draw.io XML for direct chat rendering without writing files; chipmate_create_directory may create new workspace folders, chipmate_create_file may create new workspace text/code files, and chipmate_edit_file may modify existing workspace text/code files only by exact oldString/newString replacement when the user explicitly asks for local file changes. Do not request overwrites, fuzzy patches, deletes, renames, moves, commands, network calls, or remote server filesystem access."
      : "ChipMate workspace-host tools are disabled for this chat turn; do not request, simulate, or emit tool calls.",
    toolsEnabled
      ? "Use chipmate_read_evidence for returned refIds, chipmate_read_skill_resource for active skill references/assets/scripts resources, and chipmate_read only when the user or evidence gives an explicit workspace path. If an existing file must change, read enough exact surrounding text first, then use chipmate_edit_file with a unique oldString or replaceAll when every exact occurrence should change."
      : "If evidence points to a workspace-relative path but the needed content is missing, say what is missing and ask the user to open, attach, or @mention the file.",
  ].join("\n")
}

function drawioDiagramOutputGuidance(toolsEnabled: boolean) {
  if (toolsEnabled) {
    return [
      "Draw.io Diagram Output Contract:",
      "When the user asks for a complex draw.io or diagrams.net diagram, first collect code/document/reference evidence, organize it as DiagramIR, call chipmate_validate_diagram_ir, then call chipmate_create_drawio_diagram as the final renderer.",
      "The model or active skill decides the user-visible diagramType from intent and evidence: business-flow for business/process perspective, code-flow for entry/function/branch/return execution paths, state-machine for pure state transitions, architecture for module boundaries, and soc-block for chip/module/bus/port diagrams. Code evidence does not automatically mean code-flow.",
      "For simple illustrative diagrams, chipmate_create_drawio_diagram may be called directly with a structured spec instead of hand-authoring mxCell/mxGeometry XML.",
      "chipmate_create_drawio_diagram always runs the Diagram Design Compiler before ELKJS layout. Provide semantic structure, visualRole, importance, edgeKind, pathRole, labelPriority, textParts, and layout/style/semantic hints; do not write raw draw.io coordinates unless the user explicitly asks for source.",
      "For embedded process diagrams with modules plus FSM states/events, keep the requested diagramType such as business-flow or code-flow, and encode module/state/event semantics with semanticHints; the compiler may choose an internal embedded-fsm-flow visual profile.",
      "Treat containers, regions, lanes, swimlanes, and groups as ownership/background areas, not execution steps. Assign owned nodes with parent/container/lane/region/group. For business-flow/code-flow embedded FSM diagrams these ownership areas render as weak background bands so flow edges remain readable; for architecture/soc-block or explicit containerMode='strong' they render as strong compound containers. Empty ownership containers are not rendered unless explicitly marked allowEmpty or placeholder.",
      "DiagramIR may include composition, nodes, edges, regions, containers, lanes, buses, ports, arrays, subdiagrams, evidenceRefs, layoutHints, styleHints, semanticHints, sourceArtifacts, and referenceDiagrams.",
      "Set DiagramIR composition.mode to single by default. Only set composition.mode to multi when the current user request or an active skill explicitly asks for or allows multiple diagrams; if one dense diagram would benefit from splitting, mention that as a warning instead of splitting automatically.",
      "Active skills may refine evidence collection, DiagramIR organization, VisualPlan hints, layout/style hints, and reference constraints; current user instructions override skill defaults, but skills must not bypass the Design Compiler, ELKJS layout, offline rendering, or XML/PNG safety checks.",
      "Use Mermaid only when the user explicitly asks for Mermaid, mmd, or Mermaid source.",
      "Do not reference external image URLs, font URLs, CSS URLs, or remote diagrams.net/embed services.",
      "After the tool renders the diagram directly in chat, put only a short caption or explanation outside the diagram.",
    ].join("\n")
  }
  return [
    "Draw.io Diagram Output Contract:",
    "ChipMate tool calling is disabled. When the user asks for a draw.io or diagrams.net diagram, fall back to one fenced `drawio` code block containing valid <mxfile> or <mxGraphModel> XML, and note that hand-authored XML is less reliable with small local models.",
    "Do not reference external image URLs, font URLs, CSS URLs, or remote diagrams.net/embed services inside the XML.",
    "Keep text labels concise, use built-in draw.io shapes/styles, and put only a short caption outside the fenced block.",
  ].join("\n")
}

function formatAnalysisEvidence(input: Awaited<ReturnType<NonNullable<CodeGraphContextProvider["queryEvidence"]>>>) {
  if (!input) return ""
  const modules = input.summaries.modules
    .slice(0, 8)
    .map((module) => `- ${module.module}: ${module.summary}; flows: ${module.keyFlows.slice(0, 3).join(" | ") || "none"}`)
    .join("\n")
  const stateMachines = input.stateMachines
    .slice(0, 5)
    .map((machine) => `- ${machine.id}: ${machine.transitions.length} transition(s), confidence ${machine.confidence.toFixed(2)}`)
    .join("\n")
  return [
    `<local-analysis-pack traceId="${xmlAttr(input.trace.traceId)}" confidence="${input.answerPolicy.confidence}" allowed="${input.answerPolicy.allowed ? "true" : "false"}">`,
    `<answer-policy>${xmlText(input.answerPolicy.reason)} ${xmlText(input.answerPolicy.requiredCitation)}</answer-policy>`,
    "<query-trace>",
    ...input.trace.steps.map((step) => `- ${step.label}: ${step.detail} (${step.elapsedMs}ms)`),
    "</query-trace>",
    modules ? `<module-summaries>\n${xmlText(modules)}\n</module-summaries>` : "",
    stateMachines ? `<state-machines>\n${xmlText(stateMachines)}\n</state-machines>` : "",
    input.evidencePack.text,
    input.evidencePack.missingEvidence.length ? `<missing-evidence>${xmlText(input.evidencePack.missingEvidence.join("; "))}</missing-evidence>` : "",
    `<suggested-grounded-answer-plan>\n${xmlText(input.suggestedAnswer)}\n</suggested-grounded-answer-plan>`,
    "</local-analysis-pack>",
  ].filter(Boolean).join("\n")
}

function selectionContext(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  settings: RemoteSettings,
  reason = "selection",
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
    reason,
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
    const document = await parseSupportedDocument({
      path: uri.fsPath,
      bytes,
      maxBytes: settings.context.maxFileBytes,
    })
    if (document) {
      return {
        uri,
        text: document.text,
        path: relativePath(uri),
        language: document.language,
        startLine: 1,
        endLine: document.lineCount,
        truncated: document.truncated,
        reason,
      }
    }
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

async function expandMentionedFolderContext(
  item: MentionedContextRef,
  settings: RemoteSettings,
  seen: Set<string>,
  remainingSlots: number,
): Promise<FileContext[]> {
  const folder = item.uri
  if (remainingSlots <= 0 || folder.scheme !== "file" || !isInWorkspace(folder)) return []

  try {
    const stat = await vscode.workspace.fs.stat(folder)
    if (!Boolean(stat.type & vscode.FileType.Directory)) return []
  } catch {
    return []
  }

  if (typeof vscode.workspace.findFiles !== "function") return []

  const RelativePattern = (vscode as typeof vscode & { RelativePattern?: typeof vscode.RelativePattern }).RelativePattern
  const include = typeof RelativePattern === "function" ? new RelativePattern(folder, "**/*") : "**/*"
  const uris = await vscode.workspace.findFiles(include, null, FOLDER_CONTEXT_SCAN_LIMIT + 1)
  const files: FileContext[] = []
  const sorted = uris
    .filter((uri) => uri.scheme === "file" && isInWorkspace(uri) && isUriInsideFolder(uri, folder))
    .sort((left, right) => relativePath(left).localeCompare(relativePath(right)))

  for (const uri of sorted) {
    if (files.length >= remainingSlots) break
    if (isMentionIndexExcludedPath(relativePath(uri))) continue
    const key = uri.toString()
    if (seen.has(key)) continue

    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (!Boolean(stat.type & vscode.FileType.File) || Boolean(stat.type & vscode.FileType.Directory)) continue
    } catch {
      continue
    }

    const ctx = await fileContext(uri, settings, "mentioned folder")
    if (ctx.reason === "skipped") continue
    files.push(ctx)
    seen.add(key)
  }

  return files
}

function isUriInsideFolder(uri: vscode.Uri, folder: vscode.Uri) {
  const folderPath = normalizeFsPath(folder.fsPath)
  const filePath = normalizeFsPath(uri.fsPath)
  return filePath.startsWith(`${folderPath}/`)
}

function normalizeFsPath(input: string) {
  return input.replace(/\\/g, "/").replace(/\/+$/, "")
}

async function contextForStoredItem(item: LocalContextItem, settings: RemoteSettings): Promise<FileContext> {
  if (item.kind === "file") return fileContext(item.uri, settings, "attached file")
  return {
    uri: item.uri,
    text: item.text,
    path: relativePath(item.uri),
    language: item.languageId,
    startLine: item.startLine,
    endLine: item.endLine,
    truncated: item.truncated,
    reason: "attached selection",
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
  const normalized = path.replace(/\\/g, "/")
  const basename = normalized.split("/").pop()?.toLowerCase() ?? ""
  if (basename === "makefile") return "makefile"
  if (basename === "cmakelists.txt") return "cmake"
  const ext = basename.split(".").pop()
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
    case "sh":
    case "bash":
    case "zsh":
      return "shellscript"
    case "yml":
    case "yaml":
      return "yaml"
    case "mk":
      return "makefile"
    case "cmake":
      return "cmake"
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
    case "h":
    case "hh":
    case "hpp":
    case "hxx":
    case "c":
      return "c"
    case "s":
      return "asm"
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

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
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
