import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"

export type PackedContextBlockKind =
  | "current-prefix"
  | "current-suffix"
  | "current-function"
  | "target-symbol"
  | "similar-test"
  | "include"
  | "open-tab"
  | "recent-file"

export interface PackedContextBlock {
  kind: PackedContextBlockKind
  title: string
  filePath?: string
  text: string
  score: number
  tokenEstimate: number
}

export type CompletionContextPack = {
  selected: PackedContextBlock[]
  dropped: PackedContextBlock[]
  tokenBudget: number
  tokenEstimate: number
}

export type PackCompletionContextInput = {
  plan: CompletionPlan
  languageId: string
  currentPath: string
  prefix: string
  suffix: string
  retrievedSnippets: RetrievedCompletionSnippet[]
  tokenBudget?: number
}

export function packCompletionContext(input: PackCompletionContextInput): CompletionContextPack {
  const tokenBudget = input.tokenBudget ?? tokenBudgetForPlan(input.plan)
  const blocks = contextBlocks(input).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
  const selected: PackedContextBlock[] = []
  const dropped: PackedContextBlock[] = []
  let tokenEstimate = 0

  for (const block of blocks) {
    if (block.tokenEstimate <= 0) continue
    if (tokenEstimate + block.tokenEstimate <= tokenBudget) {
      selected.push(block)
      tokenEstimate += block.tokenEstimate
    } else {
      dropped.push(block)
    }
  }

  return {
    selected,
    dropped,
    tokenBudget,
    tokenEstimate,
  }
}

export function formatRepoContext(pack: CompletionContextPack) {
  if (pack.selected.length === 0) return ""
  return [
    "<repo_context>",
    ...pack.selected.map(formatContextBlock),
    "</repo_context>",
    "",
  ].join("\n")
}

export function formatInstructionContext(pack: CompletionContextPack) {
  const target = pack.selected.filter((block) => block.kind === "target-symbol")
  const tests = pack.selected.filter((block) => block.kind === "similar-test")
  const current = pack.selected.filter((block) => block.kind === "current-prefix" || block.kind === "current-suffix")

  return [
    section("Target symbol", target),
    section("Similar tests", tests),
    section("Current file", current),
  ].filter(Boolean).join("\n\n")
}

export function completionContextDebugSummary(pack: CompletionContextPack) {
  return [
    `context selected=${pack.selected.length}`,
    `dropped=${pack.dropped.length}`,
    `tokens=${pack.tokenEstimate}/${pack.tokenBudget}`,
    `selectedKinds="${pack.selected.map((block) => block.kind).join(",")}"`,
    `droppedKinds="${pack.dropped.map((block) => block.kind).join(",")}"`,
  ].join(" ")
}

function contextBlocks(input: PackCompletionContextInput): PackedContextBlock[] {
  const snippets = input.retrievedSnippets
  const target = targetSymbolBlocks(input.plan, snippets)
  const similarTests = snippets.filter(isSimilarTest).map((snippet, index) => snippetBlock(snippet, "similar-test", 760 - index))
  const includes = includeBlock(input.prefix, input.currentPath)
  const current = currentFileBlocks(input)

  switch (input.plan.kind) {
    case "symbol-completion":
      return target.length > 0 ? target : snippets.slice(0, 8).map((snippet, index) => snippetBlock(snippet, "target-symbol", 700 - index))
    case "comment-to-test":
      return [...target, ...similarTests, ...includes, ...current]
    case "natural-command":
      return [...target, ...similarTests, ...current]
    case "ordinary-code":
      return [...target, ...includes, ...current]
    case "comment-to-code":
      return [...target, ...includes, ...current]
    case "disabled":
      return []
  }
}

function targetSymbolBlocks(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]) {
  const target = plan.targetSymbol?.toLowerCase()
  const preferred = snippets.filter((snippet) => {
    if (!snippet.name) return false
    if (!target) return !isSimilarTest(snippet)
    const name = snippet.name.toLowerCase()
    return name === target || name.startsWith(target) || target.startsWith(name)
  })
  const fallback = preferred.length > 0 ? preferred : snippets.filter((snippet) => !isSimilarTest(snippet)).slice(0, 1)
  return fallback.map((snippet, index) => snippetBlock(snippet, "target-symbol", 900 - index))
}

function snippetBlock(snippet: RetrievedCompletionSnippet, kind: PackedContextBlockKind, score: number): PackedContextBlock {
  const title = snippet.name ? `${snippet.kind}: ${snippet.name}` : snippet.kind
  const text = [
    snippet.name ? `symbol: ${snippet.name}` : "",
    snippet.text,
  ].filter(Boolean).join("\n")
  return block({
    kind,
    title,
    filePath: snippet.path,
    text,
    score: score + Math.min(Math.max(snippet.score ?? 0, 0), 100),
  })
}

function currentFileBlocks(input: PackCompletionContextInput): PackedContextBlock[] {
  const currentPrefix = tailLines(input.prefix, input.plan.kind === "ordinary-code" ? 60 : 120)
  const currentSuffix = headLines(input.suffix, input.plan.kind === "ordinary-code" ? 40 : 80)
  return [
    currentPrefix
      ? block({
          kind: "current-prefix",
          title: "current prefix",
          filePath: input.currentPath,
          text: currentPrefix,
          score: input.plan.kind === "ordinary-code" ? 650 : 500,
        })
      : undefined,
    currentSuffix
      ? block({
          kind: "current-suffix",
          title: "current suffix",
          filePath: input.currentPath,
          text: currentSuffix,
          score: input.plan.kind === "ordinary-code" ? 620 : 460,
        })
      : undefined,
  ].filter((item): item is PackedContextBlock => Boolean(item))
}

function includeBlock(prefix: string, currentPath: string): PackedContextBlock[] {
  const includes = prefix.split(/\r?\n/).filter((line) => /^\s*(?:#\s*include\b|import\b|from\b)/.test(line)).slice(-24)
  if (includes.length === 0) return []
  return [
    block({
      kind: "include",
      title: "imports and includes",
      filePath: currentPath,
      text: includes.join("\n"),
      score: 580,
    }),
  ]
}

function block(input: Omit<PackedContextBlock, "tokenEstimate">): PackedContextBlock {
  return {
    ...input,
    tokenEstimate: estimateTokens(input.text),
  }
}

function isSimilarTest(snippet: RetrievedCompletionSnippet) {
  return /(?:^|[\\/._-])(?:test|tests|spec|mock|fixture)(?:[\\/._-]|$)/i.test(snippet.path) ||
    /test|spec|mock|fixture/i.test(snippet.kind) ||
    /test|spec|mock|fixture/i.test(snippet.name ?? "")
}

function tokenBudgetForPlan(plan: CompletionPlan) {
  switch (plan.kind) {
    case "symbol-completion":
      return 240
    case "comment-to-test":
    case "natural-command":
      return 1400
    case "ordinary-code":
    case "comment-to-code":
      return 900
    case "disabled":
      return 0
  }
}

function estimateTokens(input: string) {
  return Math.max(1, Math.ceil(input.length / 4))
}

function formatContextBlock(block: PackedContextBlock) {
  return [
    `<context_block kind="${xmlAttr(block.kind)}" title="${xmlAttr(block.title)}"${block.filePath ? ` file="${xmlAttr(block.filePath)}"` : ""} tokens="${block.tokenEstimate}">`,
    block.text.trim(),
    "</context_block>",
  ].join("\n")
}

function section(title: string, blocks: PackedContextBlock[]) {
  if (blocks.length === 0) return ""
  return [
    `${title}:`,
    ...blocks.map((block) => {
      const path = block.filePath ? ` (${block.filePath})` : ""
      return [`${block.title}${path}:`, block.text.trim()].join("\n")
    }),
  ].join("\n\n")
}

function headLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(0, count).join("\n").trimEnd()
}

function tailLines(input: string, count: number) {
  return input.replace(/\r\n/g, "\n").split("\n").slice(-count).join("\n").trimStart()
}

function xmlAttr(input: string) {
  return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
