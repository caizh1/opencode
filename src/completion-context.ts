import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"

export type PackedContextBlockKind =
  | "current-prefix"
  | "current-suffix"
  | "current-function"
  | "target-symbol"
  | "similar-test"
  | "test-framework"
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

export type CompletionOpenTabContext = {
  path: string
  languageId: string
  text: string
}

export type PackCompletionContextInput = {
  plan: CompletionPlan
  languageId: string
  currentPath: string
  prefix: string
  suffix: string
  retrievedSnippets: RetrievedCompletionSnippet[]
  openTabs?: CompletionOpenTabContext[]
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
  const framework = pack.selected.filter((block) => block.kind === "test-framework")
  const current = pack.selected.filter((block) => block.kind === "current-prefix" || block.kind === "current-suffix")

  return [
    section("Target symbol", target),
    section("Similar tests", tests),
    section("Test framework context", framework),
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
  const testFramework = testFrameworkBlocks(input.plan, snippets)
  const includes = includeBlock(input.prefix, input.currentPath)
  const current = currentFileBlocks(input)
  const openTabs = openTabBlocks(input)

  switch (input.plan.kind) {
    case "symbol-completion":
      return target.length > 0 ? target : snippets.slice(0, 8).map((snippet, index) => snippetBlock(snippet, "target-symbol", 700 - index))
    case "comment-symbol-reference":
      return target
    case "previous-comment-continuation":
      return input.plan.needsTestRetrieval
        ? [...target, ...similarTests, ...testFramework, ...includes, ...openTabs, ...current]
        : [...target, ...includes, ...openTabs, ...current]
    case "comment-to-test":
      return [...target, ...similarTests, ...testFramework, ...includes, ...openTabs, ...current]
    case "natural-command":
      return [...target, ...similarTests, ...testFramework, ...openTabs, ...current]
    case "ordinary-code":
    case "body-continuation":
      return [...target, ...includes, ...openTabs, ...current]
    case "comment-to-code":
      return [...target, ...includes, ...openTabs, ...current]
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
    limitSnippetText(snippet.text, kind),
  ].filter(Boolean).join("\n")
  return block({
    kind,
    title,
    filePath: snippet.path,
    text,
    score: score + Math.min(Math.max(snippet.score ?? 0, 0), 100),
  })
}

function testFrameworkBlocks(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]): PackedContextBlock[] {
  if (!isTestInstructionPlan(plan)) return []
  const similarTests = snippets.filter(isSimilarTest)
  const lines = uniqueLines(similarTests.flatMap((snippet) => testFrameworkLines(snippet.text)))
  if (lines.length === 0) return []
  const firstPath = similarTests.find((snippet) => snippet.path)?.path
  return [
    block({
      kind: "test-framework",
      title: "test framework cues",
      filePath: firstPath,
      text: limitSnippetText(lines.join("\n"), "test-framework"),
      score: 820,
    }),
  ]
}

function currentFileBlocks(input: PackCompletionContextInput): PackedContextBlock[] {
  const ordinary = input.plan.kind === "ordinary-code" || input.plan.kind === "body-continuation"
  const currentPrefix = tailLines(input.prefix, ordinary ? 60 : 120)
  const currentSuffix = headLines(input.suffix, ordinary ? 40 : 80)
  return [
    currentPrefix
      ? block({
          kind: "current-prefix",
          title: "current prefix",
          filePath: input.currentPath,
          text: currentPrefix,
          score: ordinary ? 650 : 500,
        })
      : undefined,
    currentSuffix
      ? block({
          kind: "current-suffix",
          title: "current suffix",
          filePath: input.currentPath,
          text: currentSuffix,
          score: ordinary ? 620 : 460,
        })
      : undefined,
  ].filter((item): item is PackedContextBlock => Boolean(item))
}

function openTabBlocks(input: PackCompletionContextInput): PackedContextBlock[] {
  return (input.openTabs ?? [])
    .filter((tab) => tab.path !== input.currentPath && tab.text.trim())
    .slice(0, 6)
    .map((tab, index) =>
      block({
        kind: "open-tab",
        title: `open tab: ${tab.path}`,
        filePath: tab.path,
        text: limitSnippetText(tab.text, "open-tab"),
        score: 560 - index + cEmbeddedContextBoost(input, tab.path, tab.text),
      }))
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

function isTestInstructionPlan(plan: CompletionPlan) {
  return plan.useInstruction && plan.needsTestRetrieval
}

function testFrameworkLines(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => isTestFrameworkCueLine(line.trim()))
}

function isTestFrameworkCueLine(line: string) {
  if (!line) return false
  if (/^(?:#\s*(?:include|define|if|ifdef|ifndef|endif|elif|else|pragma)\b|import\b|from\b)/.test(line)) return true
  if (/^(?:TEST(?:_[A-Z0-9]+)?|TESTCASE|TEST_CASE|SCENARIO|FEATURE|describe|it|test)\s*\(/i.test(line)) return true
  if (/\b(?:assert|expect|verify|check|fail|ok)[A-Za-z0-9_]*\s*\(/i.test(line)) return true
  if (/\b[A-Za-z_][A-Za-z0-9_]*(?:setup|teardown|fixture|helper|mock)[A-Za-z0-9_]*\s*\(/i.test(line)) return true
  return false
}

function limitSnippetText(input: string, kind: PackedContextBlockKind) {
  const max = snippetTextLimit(kind)
  const normalized = input.trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max).replace(/\s+$/, "")}\n/* completion context truncated */`
}

function snippetTextLimit(kind: PackedContextBlockKind) {
  switch (kind) {
    case "target-symbol":
      return 3600
    case "similar-test":
      return 2600
    case "test-framework":
      return 1800
    default:
      return 3000
  }
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const key = line.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(line)
  }
  return result
}

function tokenBudgetForPlan(plan: CompletionPlan) {
  switch (plan.kind) {
    case "symbol-completion":
      return 240
    case "comment-symbol-reference":
      return 120
    case "previous-comment-continuation":
      return plan.needsTestRetrieval ? 1800 : 900
    case "comment-to-test":
    case "natural-command":
      return 1800
    case "ordinary-code":
    case "body-continuation":
    case "comment-to-code":
      return 900
    case "disabled":
      return 0
  }
}

function cEmbeddedContextBoost(input: PackCompletionContextInput, path: string, text: string) {
  if (!isCEmbeddedContext(input, path, text)) return 0
  let boost = 0
  if (/\b[A-Z][A-Z0-9_]{2,}\b/.test(text)) boost += 70
  if (/\b(?:uart|gpio|i2c|spi)_[A-Za-z0-9_]+\s*\(/.test(text)) boost += 80
  if (/\b(?:fake|mock|expect)[A-Za-z0-9_]*\s*\(/i.test(text) || /(?:^|[\\/])(?:test|tests|mock|fake|helper)s?(?:[\\/._-]|$)/i.test(path)) boost += 80
  if (/\bextern\s+(?:volatile\s+)?[A-Za-z_][A-Za-z0-9_\s*]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(text)) boost += 60
  if (/\b(?:DRIVER_LOG_[A-Z0-9_]*|LOG_[A-Z0-9_]*)\b/.test(text)) boost += 70
  if (/(?:^|[\\/])include[\\/]|\.h$|\.hpp$/.test(path)) boost += 50
  return boost
}

function isCEmbeddedContext(input: PackCompletionContextInput, path: string, text: string) {
  if (input.languageId === "c" || input.languageId === "cpp") return true
  return /\.(?:c|h|cpp|hpp)$/.test(path) || /\b(?:HAL_|MMIO|volatile|uint(?:8|16|32)_t|UART|GPIO|I2C|SPI)\b/.test(text)
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
