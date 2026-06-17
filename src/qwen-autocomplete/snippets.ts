import { countTokens, pruneLinesFromBottom } from "./tokenPruning"
import type { QwenAutocompleteHelperVars } from "./helperVars"
import type { QwenRecentlyEditedRange } from "./types"
export type { QwenRecentlyEditedRange } from "./types"

export const QwenAutocompleteSnippetType = {
  Clipboard: "clipboard",
  Code: "code",
  Diff: "diff",
  Static: "static",
} as const

export type QwenAutocompleteSnippetType = (typeof QwenAutocompleteSnippetType)[keyof typeof QwenAutocompleteSnippetType]

type Base = {
  content: string
  type: QwenAutocompleteSnippetType
}

export type QwenAutocompleteCodeSnippet = Base & {
  filepath: string
  type: typeof QwenAutocompleteSnippetType.Code
}

export type QwenAutocompleteDiffSnippet = Base & {
  type: typeof QwenAutocompleteSnippetType.Diff
}

export type QwenAutocompleteClipboardSnippet = Base & {
  copiedAt: string
  type: typeof QwenAutocompleteSnippetType.Clipboard
}

export type QwenAutocompleteStaticSnippet = Base & {
  filepath: string
  type: typeof QwenAutocompleteSnippetType.Static
}

export type QwenAutocompleteSnippet =
  | QwenAutocompleteCodeSnippet
  | QwenAutocompleteDiffSnippet
  | QwenAutocompleteClipboardSnippet
  | QwenAutocompleteStaticSnippet

export type QwenSnippetPayload = {
  clipboardSnippets: QwenAutocompleteClipboardSnippet[]
  diffSnippets: QwenAutocompleteDiffSnippet[]
  ideSnippets: QwenAutocompleteCodeSnippet[]
  importDefinitionSnippets: QwenAutocompleteCodeSnippet[]
  recentlyEditedRangeSnippets: QwenAutocompleteCodeSnippet[]
  recentlyOpenedFileSnippets: QwenAutocompleteCodeSnippet[]
  recentlyVisitedRangesSnippets: QwenAutocompleteCodeSnippet[]
  rootPathSnippets: QwenAutocompleteCodeSnippet[]
  staticSnippet: QwenAutocompleteStaticSnippet[]
}

export type QwenSnippetOptions = {
  includeClipboard?: boolean | number
  includeDiff?: boolean | number
  includeRecentlyEditedRanges?: boolean | number
  includeRecentlyVisitedRanges?: boolean | number
  maxPromptTokens: number
  modelName: string
  useImports?: boolean | number
  useRecentlyOpened?: boolean | number
  useRootPath?: boolean | number
}

export type QwenSnippetSelection = {
  baseSnippetSelectedCount: number
  budgetRemaining: number
  droppedByBudgetCount: number
  droppedDuplicateFileCount: number
  droppedInvalidCount: number
  recentlyOpenedFormattedCount: number
  recentlyOpenedTrimmedCount: number
  selectedCount: number
  selectedSnippetTokens: number
  snippetTokenBudget: number
  snippets: QwenAutocompleteSnippet[]
  totalCount: number
}

const BUFFER = 10
const CLIPBOARD_MAX_AGE = 5 * 60 * 1000
const FILES = 10
const USED = 5
const RECENCY = 0.6
const SIZE = 0.4
const MIN = 10
const MIN_TOKENS = 125

// Continue parity source:
// continuedev/continue@eaa23c5a9de86049dff765f635c18f61d1d043bb
// - core/autocomplete/snippets/getAllSnippets.ts SnippetPayload shape
// - core/autocomplete/templating/filtering.ts getSnippets
// - core/autocomplete/templating/validation.ts isValidSnippet
// - core/autocomplete/templating/formatOpenedFilesContext.ts pure opened-file formatting
// The qwen provider fills the non-streaming payload from its isolated context
// sources and keeps clipboard/diff/static slots available for adapter parity.
export function emptyQwenSnippetPayload(): QwenSnippetPayload {
  return {
    clipboardSnippets: [],
    diffSnippets: [],
    ideSnippets: [],
    importDefinitionSnippets: [],
    recentlyEditedRangeSnippets: [],
    recentlyOpenedFileSnippets: [],
    recentlyVisitedRangesSnippets: [],
    rootPathSnippets: [],
    staticSnippet: [],
  }
}

export function recentlyEditedRangesToQwenSnippets(
  ranges: QwenRecentlyEditedRange[],
  opts: { useRecentlyEdited?: boolean } = {},
): QwenAutocompleteCodeSnippet[] {
  if (opts.useRecentlyEdited === false) return []
  return ranges.map((range) => ({
    filepath: range.filepath,
    content: range.lines.join("\n"),
    type: QwenAutocompleteSnippetType.Code,
  }))
}

export function selectQwenSnippets(
  helper: QwenAutocompleteHelperVars,
  payload: QwenSnippetPayload,
  opts: QwenSnippetOptions,
): QwenSnippetSelection {
  const all = allSnippets(payload)
  const tokenBudget = snippetTokenBudget(helper, opts)
  const snippets = {
    clipboard: payload.clipboardSnippets,
    recentlyOpenedFiles: payload.recentlyOpenedFileSnippets,
    recentlyVisitedRanges: payload.recentlyVisitedRangesSnippets,
    recentlyEditedRanges: payload.recentlyEditedRangeSnippets,
    diff: payload.diffSnippets,
    // qwen adapter: upstream shuffles base snippets, but qwen-direct keeps
    // import/root selection deterministic so injection-time same-file dedupe is
    // reproducible and testable.
    base: filterCaretWindow(
      [
        ...(opts.useImports ? payload.importDefinitionSnippets : []),
        ...(opts.useRootPath ? payload.rootPathSnippets : []),
        ...payload.staticSnippet,
      ],
      helper.prunedCaretWindow,
    ),
  }
  const order = [
    { key: "clipboard" as const, value: opts.includeClipboard, priority: 1 },
    { key: "recentlyOpenedFiles" as const, value: opts.useRecentlyOpened, priority: 2 },
    { key: "recentlyVisitedRanges" as const, value: opts.includeRecentlyVisitedRanges, priority: 3 },
    { key: "recentlyEditedRanges" as const, value: opts.includeRecentlyEditedRanges, priority: 4 },
    { key: "diff" as const, value: opts.includeDiff, priority: 5 },
    { key: "base" as const, value: true, priority: 99 },
  ]
    .filter((item) => item.value)
    .map((item) => ({
      key: item.key,
      priority: typeof item.value === "number" ? item.value : item.priority,
    }))
    .sort((a, b) => a.priority - b.priority)
  const selected: QwenAutocompleteSnippet[] = []
  const files = new Set<string>()
  let remaining = tokenBudget
  let droppedByBudgetCount = 0
  let droppedDuplicateFileCount = 0
  let droppedInvalidCount = 0
  let recentlyOpenedFormattedCount = 0
  let recentlyOpenedTrimmedCount = 0
  for (const item of order) {
    const formatted =
      item.key === "recentlyOpenedFiles" && opts.useRecentlyOpened
        ? formatOpenedFilesContext(payload.recentlyOpenedFileSnippets, remaining, helper, selected, opts.modelName)
        : null
    if (formatted) {
      recentlyOpenedFormattedCount = formatted.snippets.length
      recentlyOpenedTrimmedCount = formatted.trimmedCount
      droppedDuplicateFileCount += formatted.droppedDuplicateFileCount
    }
    const current = formatted?.snippets ?? snippets[item.key]
    for (const snippet of current) {
      if (snippet.type === QwenAutocompleteSnippetType.Code && files.has(snippet.filepath)) {
        droppedDuplicateFileCount++
        continue
      }
      if (!isValidQwenSnippet(snippet)) {
        droppedInvalidCount++
        continue
      }
      const size = countTokens(snippet.content, opts.modelName) + BUFFER
      if (remaining < size) {
        droppedByBudgetCount++
        continue
      }
      selected.push(snippet)
      if (hasFilepath(snippet)) files.add(snippet.filepath)
      remaining -= size
    }
    if (remaining <= 0) break
  }
  return {
    baseSnippetSelectedCount: selected.filter(
      (snippet) =>
        payload.rootPathSnippets.includes(snippet as QwenAutocompleteCodeSnippet) ||
        payload.importDefinitionSnippets.includes(snippet as QwenAutocompleteCodeSnippet) ||
        payload.staticSnippet.includes(snippet as QwenAutocompleteStaticSnippet),
    ).length,
    budgetRemaining: remaining,
    droppedByBudgetCount,
    droppedDuplicateFileCount,
    droppedInvalidCount,
    recentlyOpenedFormattedCount,
    recentlyOpenedTrimmedCount,
    selectedCount: selected.length,
    selectedSnippetTokens: selected.reduce((sum, snippet) => sum + countTokens(snippet.content, opts.modelName), 0),
    snippetTokenBudget: tokenBudget,
    snippets: selected,
    totalCount: all.length,
  }
}

export function snippetTokenBudget(helper: QwenAutocompleteHelperVars, opts: QwenSnippetOptions): number {
  return opts.maxPromptTokens - countTokens(helper.prunedCaretWindow, opts.modelName)
}

export function isValidQwenSnippet(snippet: QwenAutocompleteSnippet): boolean {
  if (snippet.content.trim() === "") return false
  if (snippet.type === QwenAutocompleteSnippetType.Clipboard) {
    return Date.now() - new Date(snippet.copiedAt).getTime() <= CLIPBOARD_MAX_AGE
  }
  if (hasFilepath(snippet) && snippet.filepath.startsWith("output:extension-output-Continue.continue")) return false
  return true
}

function allSnippets(payload: QwenSnippetPayload): QwenAutocompleteSnippet[] {
  return [
    ...payload.rootPathSnippets,
    ...payload.importDefinitionSnippets,
    ...payload.ideSnippets,
    ...payload.recentlyEditedRangeSnippets,
    ...payload.recentlyVisitedRangesSnippets,
    ...payload.diffSnippets,
    ...payload.clipboardSnippets,
    ...payload.recentlyOpenedFileSnippets,
    ...payload.staticSnippet,
  ]
}

function filterCaretWindow<T extends QwenAutocompleteCodeSnippet | QwenAutocompleteStaticSnippet>(
  snippets: T[],
  caret: string,
): T[] {
  return snippets.filter((snippet) => snippet.content.trim() !== "" && !caret.includes(snippet.content.trim()))
}

type OpenedFormat = {
  droppedDuplicateFileCount: number
  snippets: QwenAutocompleteCodeSnippet[]
  trimmedCount: number
}

function formatOpenedFilesContext(
  snippets: QwenAutocompleteCodeSnippet[],
  budget: number,
  helper: QwenAutocompleteHelperVars,
  selected: QwenAutocompleteSnippet[],
  model: string,
): OpenedFormat {
  let droppedDuplicateFileCount = 0
  let files = snippets.slice(0, FILES)
  for (const snippet of selected) {
    if (snippet.type !== QwenAutocompleteSnippetType.Code) continue
    const before = files.length
    files = files.filter((item) => item.filepath !== snippet.filepath)
    droppedDuplicateFileCount += before - files.length
  }
  if (files.length === 0) return { droppedDuplicateFileCount, snippets: [], trimmedCount: 0 }
  const used = Math.min(USED, files.length)
  const fit = fitCount(files, budget, model)
  if (fit >= used) {
    return {
      droppedDuplicateFileCount,
      snippets: files.slice(0, used),
      trimmedCount: 0,
    }
  }
  const ranked = rank(files)
  let count = ranked.length
  while (budget - BUFFER < count * MIN_TOKENS) {
    ranked.pop()
    count = ranked.length
    if (count === 0) break
  }
  const out: QwenAutocompleteCodeSnippet[] = []
  while (count > 0) {
    const weight = 2 / (count + 1)
    const limit = Math.floor(MIN_TOKENS + weight * (budget - BUFFER - count * MIN_TOKENS))
    const item = trim(ranked[0]!, limit, model)
    out.push(item.snippet)
    budget -= item.tokens
    ranked.shift()
    count = ranked.length
  }
  return {
    droppedDuplicateFileCount,
    snippets: out,
    trimmedCount: out.filter((snippet) =>
      files.some((file) => file.filepath === snippet.filepath && file.content !== snippet.content),
    ).length,
  }
}

function fitCount(snippets: QwenAutocompleteCodeSnippet[], budget: number, model: string): number {
  let total = 0
  let fit = 0
  for (const snippet of snippets) {
    const tokens = countTokens(snippet.content, model)
    if (total + tokens >= budget - BUFFER) break
    total += tokens
    fit++
  }
  return fit
}

function rank(snippets: QwenAutocompleteCodeSnippet[]): QwenAutocompleteCodeSnippet[] {
  const pool = snippets.slice(0, FILES)
  const sizes = pool.map((snippet) => snippet.content.length)
  const min = Math.log(Math.max(Math.min(...sizes), MIN))
  const max = Math.log(Math.max(Math.max(...sizes), MIN))
  return pool
    .map((snippet, index) => ({
      score: score(index, snippet, min, max),
      snippet,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(USED, pool.length))
    .map((item) => item.snippet)
}

function score(index: number, snippet: QwenAutocompleteSnippet, min: number, max: number): number {
  const recency = Math.pow(1.15, -1 * index)
  const current = Math.log(Math.max(snippet.content.length, MIN))
  const size = max === min ? 0.5 : 1 - (current - min) / (max - min)
  return RECENCY * recency + SIZE * size
}

function trim(
  snippet: QwenAutocompleteCodeSnippet,
  max: number,
  model: string,
): { snippet: QwenAutocompleteCodeSnippet; tokens: number } {
  const tokens = countTokens(snippet.content, model)
  if (tokens <= max) return { snippet, tokens }
  const content = pruneLinesFromBottom(snippet.content, max, model)
  return {
    snippet: { ...snippet, content },
    tokens: countTokens(content, model),
  }
}

function hasFilepath(
  snippet: QwenAutocompleteSnippet,
): snippet is QwenAutocompleteCodeSnippet | QwenAutocompleteStaticSnippet {
  return snippet.type === QwenAutocompleteSnippetType.Code || snippet.type === QwenAutocompleteSnippetType.Static
}
